const bookAppointment = require('./book-appointment');
const fetch = require('node-fetch');

async function postToSlack(call, bookingResult) {
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
    const callId = call?.call_id || 'Unknown';
    
    // Format duration
    const mins = Math.floor(duration / 60);
    const secs = duration % 60;
    const durationStr = `${mins}:${secs.toString().padStart(2, '0')}`;
    
    // Build message
    let statusEmoji = '📞';
    let statusText = 'Call Ended';
    
    if (bookingResult?.success) {
      statusEmoji = '✅';
      statusText = `Booked - Job #${bookingResult.job_id}`;
    } else if (analysis.booking_confirmed === false) {
      statusEmoji = '❌';
      statusText = 'Not Booked';
    }
    
    const customerName = [analysis.first_name, analysis.last_name].filter(Boolean).join(' ') || 'Unknown';
    const issue = analysis.issue || analysis.call_summary || 'No issue recorded';
    
    const blocks = [
      {
        type: 'header',
        text: { type: 'plain_text', text: `${statusEmoji} ${statusText}`, emoji: true }
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Customer:*\n${customerName}` },
          { type: 'mrkdwn', text: `*Phone:*\n${fromNumber}` },
          { type: 'mrkdwn', text: `*Duration:*\n${durationStr}` },
          { type: 'mrkdwn', text: `*Call ID:*\n${callId.slice(-8)}` }
        ]
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*Issue:*\n${issue}` }
      },
      { type: 'divider' },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*Transcript:*\n\`\`\`${transcript.slice(0, 2500)}${transcript.length > 2500 ? '...' : ''}\`\`\`` }
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
        text: `${statusEmoji} ${statusText} - ${customerName}`
      })
    });
    
    console.log('Transcript posted to Slack');
  } catch (err) {
    console.error('Slack post error:', err.message);
  }
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
    
    // Post transcript to Slack
    await postToSlack(call, bookingResult);
    
    return res.json({ 
      status: bookingResult?.success ? 'booked' : (analysis?.booking_confirmed ? 'failed' : 'not_confirmed'),
      ...bookingResult 
    });
    
  } catch (error) {
    console.error('Post-call error:', error);
    return res.status(200).json({ status: 'error', error: error.message });
  }
};
