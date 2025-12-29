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
    morning: { startHour: 8, endHour: 11 },
    midday: { startHour: 11, endHour: 14 },
    afternoon: { startHour: 14, endHour: 17 }
  }
};

let cachedToken = null;
let tokenExpiry = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry - 60000) return cachedToken;
  
  const response = await fetch('https://auth-integration.servicetitan.io/connect/token', {
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
  
  console.log('[ST API]', method, endpoint);
  
  const response = await fetch(`https://api-integration.servicetitan.io${endpoint}`, options);
  const responseText = await response.text();
  
  if (!response.ok) {
    console.error('[ST API] Error:', response.status, responseText);
    throw new Error(`ST API error: ${response.status} - ${responseText}`);
  }
  
  return JSON.parse(responseText);
}

// ALWAYS look up customer by phone first - don't rely on Sarah passing customer_id
async function findCustomerByPhone(phone) {
  try {
    const result = await stApi('GET', `/crm/v2/tenant/${CONFIG.ST_TENANT_ID}/customers?phone=${phone}&pageSize=5`);
    if (result.data && result.data.length > 0) {
      const customer = result.data[0];
      console.log('[BOOK] Found existing customer:', customer.id, customer.name);
      return customer;
    }
  } catch (error) {
    console.error('[BOOK] Customer lookup failed:', error.message);
  }
  return null;
}

function isDSTinEffect(year, month, day) {
  if (month < 3 || month > 11) return false;
  if (month > 3 && month < 11) return true;
  
  if (month === 3) {
    const firstDayOfMarch = new Date(Date.UTC(year, 2, 1)).getUTCDay();
    const secondSunday = firstDayOfMarch === 0 ? 8 : 15 - firstDayOfMarch;
    return day >= secondSunday;
  }
  
  if (month === 11) {
    const firstDayOfNov = new Date(Date.UTC(year, 10, 1)).getUTCDay();
    const firstSunday = firstDayOfNov === 0 ? 1 : 8 - firstDayOfNov;
    return day < firstSunday;
  }
  
  return false;
}

function easternToUTC(year, month, day, hour) {
  const offset = isDSTinEffect(year, month, day) ? 4 : 5;
  const utcHour = hour + offset;
  
  let finalDay = day;
  let finalMonth = month;
  let finalYear = year;
  let finalHour = utcHour;
  
  if (utcHour >= 24) {
    finalHour = utcHour - 24;
    const tempDate = new Date(Date.UTC(year, month - 1, day + 1));
    finalYear = tempDate.getUTCFullYear();
    finalMonth = tempDate.getUTCMonth() + 1;
    finalDay = tempDate.getUTCDate();
  }
  
  const monthStr = String(finalMonth).padStart(2, '0');
  const dayStr = String(finalDay).padStart(2, '0');
  const hourStr = String(finalHour).padStart(2, '0');
  
  return `${finalYear}-${monthStr}-${dayStr}T${hourStr}:00:00Z`;
}

function getNextBusinessDay(preferredDay) {
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  
  const now = new Date();
  const easternNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  
  let targetDate = new Date(easternNow);
  
  if (preferredDay) {
    const targetDayIndex = days.indexOf(preferredDay.toLowerCase());
    if (targetDayIndex !== -1) {
      let daysUntil = targetDayIndex - easternNow.getDay();
      if (daysUntil <= 0) daysUntil += 7;
      targetDate.setDate(easternNow.getDate() + daysUntil);
    } else {
      targetDate.setDate(easternNow.getDate() + 1);
    }
  } else {
    targetDate.setDate(easternNow.getDate() + 1);
  }
  
  while (targetDate.getDay() === 0 || targetDate.getDay() === 6) {
    targetDate.setDate(targetDate.getDate() + 1);
  }
  
  return {
    year: targetDate.getFullYear(),
    month: targetDate.getMonth() + 1,
    day: targetDate.getDate(),
    dayOfWeek: targetDate.getDay()
  };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  
  try {
    const first_name = req.body.first_name || (req.body.customer_name?.split(' ')[0]) || null;
    const last_name = req.body.last_name || (req.body.customer_name?.split(' ').slice(1).join(' ')) || '';
    const issue = req.body.issue || req.body.issue_description;
    const day = req.body.day || req.body.preferred_date;
    
    const { phone, street, city, state, zip, time_window, customer_id } = req.body;
    
    console.log('[BOOK] Request:', JSON.stringify(req.body, null, 2));
    
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
    const normalizedPhone = cleanPhone.length === 11 && cleanPhone.startsWith('1') 
      ? cleanPhone.slice(1) : cleanPhone;
    const customerName = last_name ? `${first_name} ${last_name}` : first_name;
    
    let customerId = customer_id;
    let locationId = null;
    
    // ALWAYS try to find existing customer by phone first
    if (!customerId) {
      const existingCustomer = await findCustomerByPhone(normalizedPhone);
      if (existingCustomer) {
        customerId = existingCustomer.id;
      }
    }
    
    if (!customerId) {
      // No existing customer found - create new
      console.log('[BOOK] Creating new customer:', customerName);
      const customerResult = await stApi('POST', `/crm/v2/tenant/${CONFIG.ST_TENANT_ID}/customers`, {
        name: customerName,
        type: 'Residential',
        address: { street, city, state: state || 'OH', zip, country: 'USA' },
        contacts: [{ type: 'MobilePhone', value: normalizedPhone }],
        locations: [{
          name: customerName,
          address: { street, city, state: state || 'OH', zip, country: 'USA' },
          contacts: [{ type: 'MobilePhone', value: normalizedPhone }]
        }]
      });
      
      customerId = customerResult.id;
      locationId = customerResult.locations[0].id;
    } else {
      // Existing customer - get their location
      const locations = await stApi('GET', `/crm/v2/tenant/${CONFIG.ST_TENANT_ID}/locations?customerId=${customerId}&pageSize=1`);
      if (locations.data?.length > 0) {
        locationId = locations.data[0].id;
      } else {
        const newLoc = await stApi('POST', `/crm/v2/tenant/${CONFIG.ST_TENANT_ID}/locations`, {
          customerId,
          name: customerName,
          address: { street, city, state: state || 'OH', zip, country: 'USA' },
          contacts: [{ type: 'MobilePhone', value: normalizedPhone }]
        });
        locationId = newLoc.id;
      }
    }
    
    const apptDate = getNextBusinessDay(day);
    const window = CONFIG.ARRIVAL_WINDOWS[time_window] || CONFIG.ARRIVAL_WINDOWS.morning;
    
    const startUTC = easternToUTC(apptDate.year, apptDate.month, apptDate.day, window.startHour);
    const endUTC = easternToUTC(apptDate.year, apptDate.month, apptDate.day, window.endHour);
    
    const isDrain = /drain|sewer|clog|backup|snake/i.test(issue);
    const businessUnitId = isDrain ? CONFIG.BUSINESS_UNIT_DRAIN : CONFIG.BUSINESS_UNIT_PLUMBING;
    const jobTypeId = isDrain ? CONFIG.JOB_TYPE_DRAIN : CONFIG.JOB_TYPE_SERVICE;
    
    const job = await stApi('POST', `/jpm/v2/tenant/${CONFIG.ST_TENANT_ID}/jobs`, {
      customerId,
      locationId,
      businessUnitId,
      jobTypeId,
      priority: 'Normal',
      summary: issue,
      campaignId: CONFIG.CAMPAIGN_ID,
      appointments: [{
        start: startUTC,
        end: endUTC,
        arrivalWindowStart: startUTC,
        arrivalWindowEnd: endUTC
      }]
    });
    
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const dayName = dayNames[apptDate.dayOfWeek];
    
    console.log('[BOOK] Job created:', job.id, 'for customer:', customerId);
    
    return res.json({
      result: `Got you all set for ${dayName} ${time_window}. Tech will be there between ${window.startHour} and ${window.endHour}.`,
      success: true,
      job_id: job.id,
      job_number: job.jobNumber,
      appointment_id: job.firstAppointmentId,
      customer_id: customerId,
      location_id: locationId
    });
    
  } catch (error) {
    console.error('[BOOK] Error:', error.message);
    return res.json({ 
      result: "Something went wrong with the booking. Let me try again - can you give me that info one more time?",
      success: false,
      error: error.message
    });
  }
};
