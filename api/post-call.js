const fetch = require('node-fetch');

const CONFIG = {
  ST_CLIENT_ID: process.env.ST_CLIENT_ID,
  ST_CLIENT_SECRET: process.env.ST_CLIENT_SECRET,
  ST_TENANT_ID: process.env.ST_TENANT_ID,
  ST_APP_KEY: process.env.ST_APP_KEY,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN,
  SLACK_TRANSCRIPT_CHANNEL: process.env.SLACK_TRANSCRIPT_CHANNEL,
  
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
      'x-api-key': CONFIG.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: `Extract booking info from this plumbing company call transcript. Return ONLY valid JSON.

Caller phone: ${callerPhone}

Transcript:
${transcript}

Extract:
{
  "should_book": true/false (false if: customer declined service, hung up early, was just asking questions, said they'd call back, or no appointment day/time was confirmed),
  "first_name": "string or null",
  "last_name": "string or null", 
  "phone": "digits only from caller phone above",
  "street": "street address or null",
  "city": "string or null",
  "state": "2 letter abbrev, default OH",
  "zip": "5 digits or null",
  "issue": "brief description of plumbing problem",
  "day": "day of week they chose or null",
  "time_window": "morning, midday, or afternoon or null",
  "service_tier": "shield, standard, or economy",
  "notification_pref": "text or call"
}

IMPORTANT: should_book is ONLY true if customer confirmed an appointment with a specific day AND time window. Return ONLY JSON.`
      }]
    })
  });
  
  const data = await response.json();
  const text = data.content[0].text.trim();
  
  try {
    return JSON.parse(text);
  } catch (e) {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
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
  
  const customerName = parsed.last_name 
    ? `${parsed.first_name} ${parsed.last_name}` 
    : parsed.first_name;
  
  let customerId = null;
  let locationId = null;
  
  const existingCustomer = await findCustomerByPhone(normalizedPhone);
  if (existingCustomer) {
    customerId = existingCustomer.id;
    console.log('[POST-CALL] Found existing customer:', customerId, existingCustomer.name);
    const locations = await stApi('GET', `/crm/v2/tenant/${CONFIG.ST_TENANT_ID}/locations?customerId=${customerId}&pageSize=1`);
    if (locations.data?.length > 0) {
      locationId = locations.data[0].id;
    }
  }
  
  if (!customerId) {
    console.log('[POST-CALL] Creating new customer:', customerName);
    const customerResult = await stApi('POST', `/crm/v2/tenant/${CONFIG.ST_TENANT_ID}/customers`, {
      name: customerName,
      type: 'Residential',
      address: { street: parsed.street, city: parsed.city, state: parsed.state || 'OH', zip: parsed.zip, country: 'USA' },
      contacts: [{ type: 'MobilePhone', value: normalizedPhone }],
      locations: [{
        name: customerName,
        address: { street: parsed.street, city: parsed.city, state: parsed.state || 'OH', zip: parsed.zip, country: 'USA' },
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
      address: { street: parsed.street, city: parsed.city, state: parsed.state || 'OH', zip: parsed.zip, country: 'USA' },
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
  
  console.log('[POST-CALL] Job created:', job.id);
  
  return {
    success: true,
    job_id: job.id,
    customer_id: customerId,
    customer_name: customerName,
    day: parsed.day,
    time_window: parsed.time_window
  };
}

async function postToSlack(call, parsed, bookingResult) {
  if (!CONFIG.SLACK_BOT_TOKEN || !CONFIG.SLACK_TRANSCRIPT_CHANNEL) {
    console.log('[POST-CALL] Slack not configured');
    return;
  }
  
  try {
    const transcript = call?.transcript || 'No transcript';
    const duration = call?.duration_ms ? Math.round(call.duration_ms / 1000) : 0;
    const mins = Math.floor(duration / 60);
    const secs = duration % 60;
    const durationStr = `${mins}:${secs.toString().padStart(2, '0')}`;
    
    let headerEmoji, headerText, statusText;
    
    if (bookingResult?.success) {
      headerEmoji = '✅';
      headerText = 'Booked';
      statusText = `Job #${bookingResult.job_id} | ${bookingResult.day} ${bookingResult.time_window}`;
    } else if (parsed?.should_book === false) {
      headerEmoji = '🟡';
      headerText = 'No Booking';
      statusText = 'Customer did not schedule';
    } else {
      headerEmoji = '❌';
      headerText = 'Failed';
      statusText = 'Missing required info';
    }
    
    const customerName = [parsed?.first_name, parsed?.last_name].filter(Boolean).join(' ') || 'Unknown';
    const address = [parsed?.street, parsed?.city, parsed?.state, parsed?.zip].filter(Boolean).join(', ') || 'Not provided';
    const fromNumber = call?.from_number || 'Unknown';
    
    const messageText = `${headerEmoji} *${headerText}*\n\n*Name:* ${customerName}\n*Address:* ${address}\n*Phone:* ${fromNumber}\n*Issue:* ${parsed?.issue || 'N/A'}\n\n⏱️ ${durationStr} | ${statusText}\n\n*Transcript:*\n\`\`\`${transcript.slice(0, 2800)}${transcript.length > 2800 ? '...' : ''}\`\`\``;

    await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CONFIG.SLACK_BOT_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        channel: CONFIG.SLACK_TRANSCRIPT_CHANNEL,
        text: messageText,
        mrkdwn: true
      })
    });
    
    console.log('[POST-CALL] Posted to Slack');
  } catch (err) {
    console.error('[POST-CALL] Slack error:', err.message);
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  
  try {
    const { event, call } = req.body;
    
    console.log('[POST-CALL] Event:', event);
    
    if (event !== 'call_ended' && event !== 'call_analyzed') {
      return res.status(200).json({ status: 'ignored', reason: `event: ${event}` });
    }
    
    const transcript = call?.transcript;
    const callerPhone = call?.from_number;
    
    if (!transcript) {
      console.log('[POST-CALL] No transcript');
      return res.status(200).json({ status: 'skipped', reason: 'no transcript' });
    }
    
    console.log('[POST-CALL] Processing call from:', callerPhone);
    console.log('[POST-CALL] Transcript:', transcript.slice(0, 500));
    
    // Parse transcript with Claude
    const parsed = await parseTranscript(transcript, callerPhone);
    console.log('[POST-CALL] Parsed:', JSON.stringify(parsed, null, 2));
    
    let bookingResult = null;
    
    if (parsed.should_book) {
      const required = ['first_name', 'phone', 'street', 'city', 'zip', 'issue', 'day', 'time_window'];
      const missing = required.filter(f => !parsed[f]);
      
      if (missing.length > 0) {
        console.log('[POST-CALL] Missing required:', missing);
      } else {
        bookingResult = await createBooking(parsed);
      }
    } else {
      console.log('[POST-CALL] should_book is false - no booking');
    }
    
    // Post to Slack
    await postToSlack(call, parsed, bookingResult);
    
    return res.status(200).json({
      status: bookingResult?.success ? 'booked' : 'not_booked',
      parsed,
      booking: bookingResult
    });
    
  } catch (error) {
    console.error('[POST-CALL] Error:', error.message);
    return res.status(200).json({ status: 'error', error: error.message });
  }
};
