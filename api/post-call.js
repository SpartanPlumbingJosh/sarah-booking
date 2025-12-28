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
    const analysis = call?.call_analysis || call?.post_call_analysis_data || {};
    const transcript = call?.transcript || 'No transcript available';
    const duration = call?.call_duration_ms ? Math.round(call.call_duration_ms / 1000) : 0;
    const fromNumber = call?.from_number || 'Unknown';
    const disconnectReason = call?.disconnection_reason || 'unknown';
    
    // Format duration as M:SS
    const mins = Math.floor(duration / 60);
    const secs = duration % 60;
    const durationStr = `${mins}:${secs.toString().padStart(2, '0')}`;
    
    // Determine status and emoji
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
    
    // Match the exact format from the existing posts
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
  if (analysis?.street || analysis?.city || analysis?.zip) return true;
  if (analysis?.appointment_day || analysis?.time_window) return true;
  if (analysis?.issue && analysis.issue.length > 20) return true;
  
  const transcript = call?.transcript?.toLowerCase() || '';
  const leadPhrases = ['schedule', 'appointment', 'come out', 'available', 'book', 'service', 'fix', 'repair', 'leak', 'clog', 'drain', 'water heater', 'plumb'];
  if (leadPhrases.some(phrase => transcript.includes(phrase))) return true;
  
  const duration = call?.call_duration_ms || 0;
  if (duration < 30000 && !analysis?.issue) return false;
  
  return true;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  
  try {
    const { event, call } = req.body;
    
    if (event !== 'call_ended') {
      return res.json({ status: 'ignored', reason: 'not call_ended' });
    }
    
    const analysis = call?.call_analysis || call?.post_call_analysis_data;
    let bookingResult = null;
    
    if (analysis?.booking_confirmed) {
      const mockReq = {
        method: 'POST',
        body: {
          first_name: analysis.first_name,
          last_name: analysis.last_name,
          phone: analysis.phone,
          street: analysis.street,
          city: analysis.city,
          state: analysis.state,
          zip: analysis.zip,
          issue: analysis.issue,
          day: analysis.appointment_day,
          time_window: analysis.time_window
        }
      };
      
      const mockRes = { 
        json: (data) => { bookingResult = data; return mockRes; }, 
        status: () => mockRes 
      };
      
      await bookAppointment(mockReq, mockRes);
    }
    
    const wasLead = isLead(analysis, call);
    await postToSlack(call, bookingResult, wasLead);
    
    return res.json({ 
      status: bookingResult?.success ? 'booked' : (wasLead ? 'unbooked' : 'not_lead'),
      ...bookingResult 
    });
    
  } catch (error) {
    console.error('Post-call error:', error);
    return res.status(200).json({ status: 'error', error: error.message });
  }
};
