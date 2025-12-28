const fetch = require('node-fetch');

const CONFIG = {
  ST_CLIENT_ID: process.env.ST_CLIENT_ID,
  ST_CLIENT_SECRET: process.env.ST_CLIENT_SECRET,
  ST_TENANT_ID: process.env.ST_TENANT_ID,
  ST_APP_KEY: process.env.ST_APP_KEY,
  
  BUSINESS_UNIT_PLUMBING: 40464378,
  BUSINESS_UNIT_DRAIN: 40472669,
  JOB_TYPE_SERVICE: 40464992,
  JOB_TYPE_DRAIN: 79265910,
  CAMPAIGN_ID: 313,
  
  ARRIVAL_WINDOWS: {
    morning: { start: '08:00', end: '11:00' },
    midday: { start: '11:00', end: '14:00' },
    afternoon: { start: '14:00', end: '17:00' }
  },
  
  // Eastern Time offset (EST = -05:00, EDT = -04:00)
  // Using EST for now - could make this dynamic for DST
  TIMEZONE_OFFSET: '-05:00'
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

async function stApi(method, endpoint, body = null) {
  const token = await getAccessToken();
  const options = {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'ST-App-Key': CONFIG.ST_APP_KEY,
      'Content-Type': 'application/json'
    }
  };
  if (body) options.body = JSON.stringify(body);
  
  const response = await fetch(`https://api.servicetitan.io${endpoint}`, options);
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`ST API error: ${response.status} - ${errText}`);
  }
  return response.json();
}

function getNextBusinessDay(preferredDay) {
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const now = new Date();
  
  if (preferredDay) {
    const targetDay = days.indexOf(preferredDay.toLowerCase());
    if (targetDay !== -1) {
      let daysUntil = targetDay - now.getDay();
      if (daysUntil <= 0) daysUntil += 7;
      now.setDate(now.getDate() + daysUntil);
      while (now.getDay() === 0 || now.getDay() === 6) now.setDate(now.getDate() + 1);
      return now;
    }
  }
  
  now.setDate(now.getDate() + 1);
  while (now.getDay() === 0 || now.getDay() === 6) now.setDate(now.getDate() + 1);
  return now;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  
  try {
    const { first_name, last_name, phone, street, city, state, zip, issue, day, time_window, customer_id } = req.body;
    
    const missing = [];
    if (!first_name) missing.push('first name');
    if (!phone) missing.push('phone');
    if (!street) missing.push('street address');
    if (!city) missing.push('city');
    if (!zip) missing.push('zip code');
    if (!issue) missing.push('what the issue is');
    if (!time_window) missing.push('time window');
    
    if (missing.length > 0) {
      return res.json({ result: `I still need the ${missing[0]}.`, missing });
    }
    
    const cleanPhone = String(phone).replace(/\D/g, '');
    const customerName = last_name ? `${first_name} ${last_name}` : first_name;
    
    let customerId = customer_id;
    let locationId = null;
    
    if (!customerId) {
      const customerResult = await stApi('POST', `/crm/v2/tenant/${CONFIG.ST_TENANT_ID}/customers`, {
        name: customerName,
        type: 'Residential',
        address: { street, city, state: state || 'OH', zip, country: 'USA' },
        contacts: [{ type: 'MobilePhone', value: cleanPhone }],
        locations: [{
          name: customerName,
          address: { street, city, state: state || 'OH', zip, country: 'USA' },
          contacts: [{ type: 'MobilePhone', value: cleanPhone }]
        }]
      });
      
      customerId = customerResult.id;
      locationId = customerResult.locations[0].id;
    } else {
      const locations = await stApi('GET', `/crm/v2/tenant/${CONFIG.ST_TENANT_ID}/locations?customerId=${customerId}&pageSize=1`);
      if (locations.data?.length > 0) {
        locationId = locations.data[0].id;
      } else {
        const newLoc = await stApi('POST', `/crm/v2/tenant/${CONFIG.ST_TENANT_ID}/locations`, {
          customerId, name: customerName,
          address: { street, city, state: state || 'OH', zip, country: 'USA' },
          contacts: [{ type: 'MobilePhone', value: cleanPhone }]
        });
        locationId = newLoc.id;
      }
    }
    
    const appointmentDate = getNextBusinessDay(day);
    const dateStr = appointmentDate.toISOString().split('T')[0];
    const window = CONFIG.ARRIVAL_WINDOWS[time_window] || CONFIG.ARRIVAL_WINDOWS.morning;
    
    const isDrain = /drain|sewer|clog|backup|snake/i.test(issue);
    const businessUnitId = isDrain ? CONFIG.BUSINESS_UNIT_DRAIN : CONFIG.BUSINESS_UNIT_PLUMBING;
    const jobTypeId = isDrain ? CONFIG.JOB_TYPE_DRAIN : CONFIG.JOB_TYPE_SERVICE;
    
    // IMPORTANT: Include timezone offset so ServiceTitan interprets times correctly
    const tzOffset = CONFIG.TIMEZONE_OFFSET;
    
    const job = await stApi('POST', `/jpm/v2/tenant/${CONFIG.ST_TENANT_ID}/jobs`, {
      customerId, locationId, businessUnitId, jobTypeId,
      priority: 'Normal', summary: issue, campaignId: CONFIG.CAMPAIGN_ID,
      appointments: [{
        start: `${dateStr}T${window.start}:00${tzOffset}`,
        end: `${dateStr}T${window.end}:00${tzOffset}`,
        arrivalWindowStart: `${dateStr}T${window.start}:00${tzOffset}`,
        arrivalWindowEnd: `${dateStr}T${window.end}:00${tzOffset}`
      }]
    });
    
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const dayName = dayNames[appointmentDate.getDay()];
    
    // Format times for speech (08:00 -> 8, 11:00 -> 11)
    const startHour = parseInt(window.start.split(':')[0]);
    const endHour = parseInt(window.end.split(':')[0]);
    
    return res.json({
      result: `Got you all set for ${dayName} ${time_window}. Tech will be there between ${startHour} and ${endHour}.`,
      success: true, job_id: job.id, job_number: job.jobNumber,
      appointment_id: job.firstAppointmentId, customer_id: customerId, location_id: locationId
    });
    
  } catch (error) {
    console.error('[BOOK] Error:', error.message);
    return res.json({ 
      result: "Something went wrong with the booking. Let me try again - can you give me that info one more time?",
      success: false, error: error.message
    });
  }
};
