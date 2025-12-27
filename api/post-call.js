const bookAppointment = require('./book-appointment');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  
  try {
    const { event, call } = req.body;
    
    if (event !== 'call_ended') {
      return res.json({ status: 'ignored', reason: 'not call_ended' });
    }
    
    const analysis = call?.call_analysis || call?.post_call_analysis_data;
    
    if (!analysis?.booking_confirmed) {
      return res.json({ status: 'skipped', reason: 'not confirmed' });
    }
    
    // Forward to book-appointment with mock req/res
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
    
    let result;
    const mockRes = { json: (data) => { result = data; return mockRes; }, status: () => mockRes };
    
    await bookAppointment(mockReq, mockRes);
    
    return res.json({ status: result?.success ? 'booked' : 'failed', ...result });
    
  } catch (error) {
    return res.status(200).json({ status: 'error', error: error.message });
  }
};
