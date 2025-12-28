const fetch = require('node-fetch');

const CONFIG = {
  ST_CLIENT_ID: process.env.ST_CLIENT_ID,
  ST_CLIENT_SECRET: process.env.ST_CLIENT_SECRET,
  ST_TENANT_ID: process.env.ST_TENANT_ID,
  ST_APP_KEY: process.env.ST_APP_KEY,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  
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
  const responseText = await response.text();
  
  if (!response.ok) {
    console.error('[ST API] Error:', response.status, responseText);
    throw new Error(`ST API error: ${response.status}`);
  }
  
  return JSON.parse(responseText);
}

async function findCustomerByPhone(phone) {
  try {
    const result = await stApi('GET', `/crm/v2/tenant/${CONFIG.ST_TENANT_ID}/customers?phone=${phone}&pageSize=5`);
    if (result.data && result.data.length > 0) {
      return result.data[0];
    }
  } catch (error) {
    console.error('[POST-CALL] Customer lookup failed:', error.message);
  }
  return null;
}

// Parse transcript using Claude
async function parseTranscript(transcript, callerPhone) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: `Extract booking info from this plumbing company call transcript. Return ONLY valid JSON, no other text.

Caller phone: ${callerPhone}

Transcript:
${transcript}

Extract these fields (use null if not found):
{
  "should_book": true/false (false if customer declined, hung up early, was just asking questions, or no appointment was confirmed),
  "first_name": "string",
  "last_name": "string or null",
  "phone": "digits only",
  "street": "street address",
  "city": "string",
  "state": "string, default OH",
  "zip": "5 digits",
  "issue": "brief description of plumbing problem",
  "day": "day of week they chose",
  "time_window": "morning, midday, or afternoon",
  "service_tier": "shield, standard, or economy",
  "notification_pref": "text or call",
  "is_homeowner": true/false/null
}

Return ONLY the JSON object.`
      }]
    })
  });
  
  const data = await response.json();
  const text = data.content[0].text.trim();
  
  // Parse JSON from response
  try {
    return JSON.parse(text);
  } catch (e) {
    // Try to extract JSON if there's extra text
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      return JSON.parse(match[0]);
    }
    throw new Error('Failed to parse transcript extraction');
  }
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
  
  let finalDay = day, finalMonth = month, finalYear = year, finalHour = utcHour;
  
  if (utcHour >= 24) {
    finalHour = utcHour - 24;
    const tempDate = new Date(Date.UTC(year, month - 1, day + 1));
    finalYear = tempDate.getUTCFullYear();
    finalMonth = tempDate.getUTCMonth() + 1;
    finalDay = tempDate.getUTCDate();
  }
  
  return `${finalYear}-${String(finalMonth).padStart(2, '0')}-${String(finalDay).padStart(2, '0')}T${String(finalHour).padStart(2, '0')}:00:00Z`;
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

async function createBooking(parsed) {
  const cleanPhone = String(parsed.phone).replace(/\D/g, '');
  const normalizedPhone = cleanPhone.length === 11 && cleanPhone.startsWith('1') 
    ? cleanPhone.slice(1) : cleanPhone;
  
  // Build customer name - last name optional
  const customerName = parsed.last_name 
    ? `${parsed.first_name} ${parsed.last_name}` 
    : parsed.first_name;
  
  // Check for existing customer
  let customerId = null;
  let locationId = null;
  
  const existingCustomer = await findCustomerByPhone(normalizedPhone);
  if (existingCustomer) {
    customerId = existingCustomer.id;
    const locations = await stApi('GET', `/crm/v2/tenant/${CONFIG.ST_TENANT_ID}/locations?customerId=${customerId}&pageSize=1`);
    if (locations.data?.length > 0) {
      locationId = locations.data[0].id;
    }
  }
  
  if (!customerId) {
    const customerResult = await stApi('POST', `/crm/v2/tenant/${CONFIG.ST_TENANT_ID}/customers`, {
      name: customerName,
      type: 'Residential',
      address: { 
        street: parsed.street, 
        city: parsed.city, 
        state: parsed.state || 'OH', 
        zip: parsed.zip, 
        country: 'USA' 
      },
      contacts: [{ type: 'MobilePhone', value: normalizedPhone }],
      locations: [{
        name: customerName,
        address: { 
          street: parsed.street, 
          city: parsed.city, 
          state: parsed.state || 'OH', 
          zip: parsed.zip, 
          country: 'USA' 
        },
        contacts: [{ type: 'MobilePhone', value: normalizedPhone }]
      }]
    });
    
    customerId = customerResult.id;
    locationId = customerResult.locations[0].id;
  }
  
  if (!locationId) {
    const newLoc = await stApi('POST', `/crm/v2/tenant/${CONFIG.ST_TENANT_ID}/locations`, {
      customerId,
      name: customerName,
      address: { 
        street: parsed.street, 
        city: parsed.city, 
        state: parsed.state || 'OH', 
        zip: parsed.zip, 
        country: 'USA' 
      },
      contacts: [{ type: 'MobilePhone', value: normalizedPhone }]
    });
    locationId = newLoc.id;
  }
  
  const apptDate = getNextBusinessDay(parsed.day);
  const window = CONFIG.ARRIVAL_WINDOWS[parsed.time_window] || CONFIG.ARRIVAL_WINDOWS.morning;
  const startUTC = easternToUTC(apptDate.year, apptDate.month, apptDate.day, window.startHour);
  const endUTC = easternToUTC(apptDate.year, apptDate.month, apptDate.day, window.endHour);
  
  const isDrain = /drain|sewer|clog|backup|snake/i.test(parsed.issue);
  
  const job = await stApi('POST', `/jpm/v2/tenant/${CONFIG.ST_TENANT_ID}/jobs`, {
    customerId,
    locationId,
    businessUnitId: isDrain ? CONFIG.BUSINESS_UNIT_DRAIN : CONFIG.BUSINESS_UNIT_PLUMBING,
    jobTypeId: isDrain ? CONFIG.JOB_TYPE_DRAIN : CONFIG.JOB_TYPE_SERVICE,
    priority: 'Normal',
    summary: parsed.issue,
    campaignId: CONFIG.CAMPAIGN_ID,
    appointments: [{
      start: startUTC,
      end: endUTC,
      arrivalWindowStart: startUTC,
      arrivalWindowEnd: endUTC
    }]
  });
  
  return {
    success: true,
    job_id: job.id,
    customer_id: customerId,
    customer_name: customerName,
    appointment_day: parsed.day,
    appointment_window: parsed.time_window
  };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  try {
    const { event, call } = req.body;
    
    // Only process call_ended events
    if (event !== 'call_ended' && event !== 'call_analyzed') {
      return res.status(200).json({ status: 'ignored', reason: 'not call_ended' });
    }
    
    const transcript = call?.transcript;
    const callerPhone = call?.from_number;
    
    if (!transcript || !callerPhone) {
      console.log('[POST-CALL] Missing transcript or phone');
      return res.status(200).json({ status: 'skipped', reason: 'missing data' });
    }
    
    console.log('[POST-CALL] Processing call from:', callerPhone);
    console.log('[POST-CALL] Transcript length:', transcript.length);
    
    // Parse the transcript
    const parsed = await parseTranscript(transcript, callerPhone);
    console.log('[POST-CALL] Parsed:', JSON.stringify(parsed, null, 2));
    
    // Check if we should book
    if (!parsed.should_book) {
      console.log('[POST-CALL] No booking needed - customer declined or no appointment confirmed');
      return res.status(200).json({ status: 'no_booking', reason: 'should_book is false' });
    }
    
    // Check required fields
    const required = ['first_name', 'phone', 'street', 'city', 'zip', 'issue', 'day', 'time_window'];
    const missing = required.filter(f => !parsed[f]);
    
    if (missing.length > 0) {
      console.log('[POST-CALL] Missing required fields:', missing);
      return res.status(200).json({ 
        status: 'incomplete', 
        reason: 'missing required fields',
        missing 
      });
    }
    
    // Create the booking
    const result = await createBooking(parsed);
    console.log('[POST-CALL] Booking created:', result);
    
    return res.status(200).json({
      status: 'booked',
      ...result
    });
    
  } catch (error) {
    console.error('[POST-CALL] Error:', error.message);
    return res.status(200).json({ 
      status: 'error', 
      error: error.message 
    });
  }
};
