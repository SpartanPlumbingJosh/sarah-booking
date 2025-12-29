const fetch = require('node-fetch');

const CONFIG = {
  ST_CLIENT_ID: process.env.ST_CLIENT_ID,
  ST_CLIENT_SECRET: process.env.ST_CLIENT_SECRET,
  ST_TENANT_ID: process.env.ST_TENANT_ID,
  ST_APP_KEY: process.env.ST_APP_KEY
};

let cachedToken = null;
let tokenExpiry = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry - 60000) return cachedToken;
  
  const response = await fetch('https://auth.servicetitan.io/connect/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: CONFIG.ST_CLIENT_ID,
      client_secret: CONFIG.ST_CLIENT_SECRET
    })
  });
  
  const data = await response.json();
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in * 1000);
  return cachedToken;
}

module.exports = async (req, res) => {
  try {
    const token = await getAccessToken();
    
    // Check Monday Dec 29 specifically
    const mondayStr = '2025-12-29';
    
    // Call capacity API for Monday only
    const response = await fetch(
      `https://api.servicetitan.io/dispatch/v2/tenant/${CONFIG.ST_TENANT_ID}/capacity`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'ST-App-Key': CONFIG.ST_APP_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          startsOnOrAfter: `${mondayStr}T00:00:00Z`,
          endsOnOrBefore: `${mondayStr}T23:59:59Z`,
          skillBasedAvailability: false
        })
      }
    );
    
    const data = await response.json();
    
    // Show ALL data, not just available
    const slots = (data.availabilities || []).map(slot => ({
      start: slot.start,
      end: slot.end,
      isAvailable: slot.isAvailable,
      openSlots: slot.openSlots,
      totalSlots: slot.totalSlots,
      bookedSlots: slot.totalSlots - slot.openSlots,
      businessUnitId: slot.businessUnitId,
      jobTypeId: slot.jobTypeId,
      technicianIds: slot.technicianIds
    }));
    
    return res.status(200).json({
      date: mondayStr,
      dayOfWeek: 'Monday',
      totalTimeSlots: slots.length,
      availableTimeSlots: slots.filter(s => s.isAvailable).length,
      unavailableTimeSlots: slots.filter(s => !s.isAvailable).length,
      slots: slots,
      rawResponse: data
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};
