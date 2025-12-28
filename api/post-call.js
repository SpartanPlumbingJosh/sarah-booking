const bookAppointment = require('./book-appointment');
const fetch = require('node-fetch');

async function postToSlack(call, bookingResult, wasLead) {
  const token = process.env.SLACK_BOT_TOKEN;
  const channel = process.env.SLACK_TRANSCRIPT_CHANNEL;
  
  if (!token || !channel) {
    console.log('Slack not configured, skipping transcript post');
    return;
  }
  
  try {
    // Retell can send analysis in multiple places - check all of them
    const analysis = call?.call_analysis || call?.custom_analysis_data || call?.post_call_analysis_data || {};
    const transcript = call?.transcript || call?.transcript_object?.map(t => `${t.role}: ${t.content}`).join('\n') || 'No transcript available';
    
    // Duration comes in different formats
    let duration = 0;
    if (call?.call_duration_ms) {
      duration = Math.round(call.call_duration_ms / 1000);
    } else if (call?.end_timestamp && call?.start_timestamp) {
      duration = Math.round((call.end_timestamp - call.start_timestamp) / 1000);
    }
    
    const fromNumber = call?.from_number || call?.caller_number || 'Unknown';
    const disconnectReason = call?.disconnection_reason || call?.end_reason || 'unknown';
    
    const mins = Math.floor(duration / 60);
    const secs = duration % 60;
    const durationStr = `${mins}:${secs.toString().padStart(2, '0')}`;
    
    let headerEmoji, headerText, statusText;
    
    if (bookingResult?.success) {
      headerEmoji = '✅';
      headerText = 'Booked';
      statusText = `Booked | Job #${bookingResult.job_id}`;
    } else if (!wasLead) {
      headerEmoji = '🟡';
      headerText = 'Not a Lead';
      statusText = `Not a Lead | ${disconnectReason}`;
    } else {
      headerEmoji = '❌';
      headerText = 'Unbooked';
      statusText = `Unbooked | ${disconnectReason}`;
    }
    
    const customerName = [analysis.first_name, analysis.last_name].filter(Boolean).join(' ') || 'Unknown';
    const address = [analysis.street, analysis.city, analysis.state, analysis.zip].filter(Boolean).join(', ') || 'Not provided';
    const issue = analysis.issue || analysis.call_summary || 'No summary provided';
    
    const messageText = `${headerEmoji} *${headerText}*

*Name:* ${customerName}
*Address:* ${address}
*Phone Number:* ${fromNumber}
*Summary of Call:* ${issue}

⏱️ ${durationStr} | ${statusText}

*Transcript:*
\`\`\`${transcript.slice(0, 2800)}${transcript.length > 2800 ? '...' : ''}\`\`\``;

    await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        channel,
        text: messageText,
        mrkdwn: true
      })
    });
    
    console.log('Transcript posted to Slack');
  } catch (err) {
    console.error('Slack post error:', err.message);
  }
}

function isLead(analysis, call) {
  const summary = (analysis?.call_summary || analysis?.issue || '').toLowerCase();
  const transcript = call?.transcript?.toLowerCase() || '';
  
  // Explicit non-lead indicators
  const nonLeadPhrases = ['wrong number', 'misdial', 'pizza', 'not the right number', 'sorry wrong'];
  if (nonLeadPhrases.some(phrase => summary.includes(phrase) || transcript.includes(phrase))) {
    return false;
  }
  
  // If booking was confirmed, definitely a lead
  if (analysis?.booking_confirmed === true || analysis?.booking_confirmed === 'true') {
    return true;
  }
  
  // If they provided address info, definitely a lead
  if (analysis?.street || analysis?.city || analysis?.zip) return true;
  
  // If they discussed scheduling, definitely a lead  
  if (analysis?.appointment_day || analysis?.time_window) return true;
  
  // If there's a substantive issue, it's a lead
  if (analysis?.issue && analysis.issue.length > 15) return true;
  
  // Very short calls are likely not leads
  const duration = call?.call_duration_ms || 0;
  if (duration < 30000) return false;
  
  // Default: calls over 1 min are probably leads
  return duration > 60000;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  
  try {
    const payload = req.body;
    
    // Log full payload for debugging
    console.log('Webhook payload:', JSON.stringify(payload, null, 2));
    
    // Retell sends { event: 'call_ended', call: {...} } OR just the call object directly
    const event = payload?.event || 'call_ended';
    const call = payload?.call || payload;
    
    if (event !== 'call_ended' && event !== 'call_analyzed') {
      return res.json({ status: 'ignored', reason: `event is ${event}` });
    }
    
    // Get analysis from wherever Retell put it
    const analysis = call?.call_analysis || call?.custom_analysis_data || call?.post_call_analysis_data || {};
    
    console.log('Analysis data:', JSON.stringify(analysis, null, 2));
    
    let bookingResult = null;
    
    // Check if booking confirmed (handle both boolean and string)
    const bookingConfirmed = analysis?.booking_confirmed === true || analysis?.booking_confirmed === 'true';
    
    if (bookingConfirmed && analysis?.first_name && analysis?.street) {
      console.log('Booking confirmed, creating job...');
      
      const mockReq = {
        method: 'POST',
        body: {
          first_name: analysis.first_name,
          last_name: analysis.last_name,
          phone: analysis.phone || call?.from_number?.replace(/\D/g, ''),
          street: analysis.street,
          city: analysis.city,
          state: analysis.state || 'OH',
          zip: analysis.zip,
          issue: analysis.issue || analysis.call_summary || 'Service call',
          day: analysis.appointment_day,
          time_window: analysis.time_window
        }
      };
      
      console.log('Booking request:', JSON.stringify(mockReq.body, null, 2));
      
      const mockRes = { 
        json: (data) => { bookingResult = data; return mockRes; }, 
        status: () => mockRes 
      };
      
      await bookAppointment(mockReq, mockRes);
      console.log('Booking result:', JSON.stringify(bookingResult, null, 2));
    }
    
    const wasLead = isLead(analysis, call);
    await postToSlack(call, bookingResult, wasLead);
    
    return res.json({ 
      status: bookingResult?.success ? 'booked' : (wasLead ? 'unbooked' : 'not_lead'),
      booking_confirmed: bookingConfirmed,
      ...bookingResult 
    });
    
  } catch (error) {
    console.error('Post-call error:', error);
    return res.status(200).json({ status: 'error', error: error.message });
  }
};
