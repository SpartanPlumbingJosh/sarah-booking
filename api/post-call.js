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
    
    // Determine status and color
    let headerEmoji, headerText, statusLine;
    
    if (bookingResult?.success) {
      // GREEN - Booked
      headerEmoji = '✅';
      headerText = 'Booked';
      statusLine = `${durationStr} | Booked | Job #${bookingResult.job_id}`;
    } else if (!wasLead) {
      // YELLOW - Not a lead (non-booking call like existing customer question, wrong number, etc)
      headerEmoji = '🟡';
      headerText = 'Not a Lead';
      statusLine = `${durationStr} | Not a Lead | ${disconnectReason}`;
    } else {
      // RED - Unbooked (was a lead but didn't book)
      headerEmoji = '❌';
      headerText = 'Unbooked';
      statusLine = `${durationStr} | Unbooked | ${disconnectReason}`;
    }
    
    const customerName = [analysis.first_name, analysis.last_name].filter(Boolean).join(' ') || 'Unknown';
    const address = [analysis.street, analysis.city, analysis.state, analysis.zip].filter(Boolean).join(', ') || 'Not provided';
    const issue = analysis.issue || analysis.call_summary || 'No issue recorded';
    
    const blocks = [
      {
        type: 'section',
        text: { 
          type: 'mrkdwn', 
          text: `${headerEmoji} *${headerText}*\n\n*Name:* ${customerName}\n*Address:* ${address}\n*Phone Number:* ${fromNumber}\n*Summary of Call:* ${issue}` 
        }
      },
      {
        type: 'context',
        elements: [
          { type: 'mrkdwn', text: `⏱️ ${statusLine}` }
        ]
      },
      { type: 'divider' },
      {
        type: 'section',
        text: { 
          type: 'mrkdwn', 
          text: `*Transcript:*\n\`\`\`${transcript.slice(0, 2800)}${transcript.length > 2800 ? '...' : ''}\`\`\`` 
        }
      }
    ];
    
    await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        channel,
        blocks,
        text: `${headerEmoji} ${headerText} - ${customerName}`
      })
    });
    
    console.log('Transcript posted to Slack');
  } catch (err) {
    console.error('Slack post error:', err.message);
  }
}

// Determine if call was a lead based on analysis
function isLead(analysis, call) {
  // If they provided address info or discussed scheduling, it's a lead
  if (analysis?.street || analysis?.city || analysis?.zip) return true;
  if (analysis?.appointment_day || analysis?.time_window) return true;
  if (analysis?.issue && analysis.issue.length > 20) return true;
  
  // Check transcript for lead indicators
  const transcript = call?.transcript?.toLowerCase() || '';
  const leadPhrases = ['schedule', 'appointment', 'come out', 'available', 'book', 'service', 'fix', 'repair', 'leak', 'clog', 'drain', 'water heater', 'plumb'];
  if (leadPhrases.some(phrase => transcript.includes(phrase))) return true;
  
  // Short calls with no issue are likely not leads
  const duration = call?.call_duration_ms || 0;
  if (duration < 30000 && !analysis?.issue) return false;
  
  // Default to assuming it's a lead
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
    
    // Try to book if confirmed
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
    
    // Determine if this was a lead
    const wasLead = isLead(analysis, call);
    
    // Post transcript to Slack
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
