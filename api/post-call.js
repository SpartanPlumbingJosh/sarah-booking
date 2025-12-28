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
    throw new Error(`ST API error: ${response.status} - ${responseText.substring(0, 500)}`);
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

async function parseTranscript(transcript, callerPhone) {
  const cleanPhone = callerPhone ? callerPhone.replace(/\D/g, '') : '';
  
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
        content: `Extract booking info from this plumbing call. Return ONLY valid JSON.

Caller phone: ${cleanPhone}

Transcript:
${transcript}

{
  "should_book": true if agent said "you're all set" or confirmed an appointment. false if customer declined or hung up early,
  "first_name": "string or null",
  "last_name": "string or null", 
  "phone": "the phone number they SAID on the call (digits only), or ${cleanPhone} if they didn't give one",
  "street": "street address THEY SAID on the call or null",
  "city": "city THEY SAID on the call or null",
  "state": "state or OH",
  "zip": "zip code THEY SAID on the call or null",
  "issue": "plumbing problem description",
  "day": "day of week or null",
  "time_window": "morning/midday/afternoon or null",
  "is_new_customer": true if they said they've never used the service before
}

IMPORTANT: Extract the address the customer SAID on the call, not any address the agent might have mentioned from their records.
Return ONLY JSON.`
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
    throw new Error('Failed to parse transcript');
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


// Check if we already booked this call (same customer, same day, in last 5 min)
async function alreadyBooked(customerId, appointmentDate) {
  try {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const jobs = await stApi('GET', `/jpm/v2/tenant/${CONFIG.ST_TENANT_ID}/jobs?customerId=${customerId}&createdOnOrAfter=${fiveMinAgo}&pageSize=5`);
    
    if (jobs.data && jobs.data.length > 0) {
      console.log('[POST-CALL] Found', jobs.data.length, 'recent jobs for customer', customerId);
      return true; // Already booked in last 5 min
    }
    return false;
  } catch (error) {
    console.error('[POST-CALL] Dedupe check failed:', error.message);
    return false; // On error, proceed with booking
  }
}

// ALWAYS use the address from the call - NEVER override with ST data
async function createBooking(parsed, callerPhone) {
  const cleanPhone = String(parsed.phone || callerPhone || '').replace(/\D/g, '');
  const normalizedPhone = cleanPhone.length === 11 && cleanPhone.startsWith('1') 
    ? cleanPhone.slice(1) : cleanPhone;
  
  // ALWAYS use what they said on the call
  let street = parsed.street;
  let city = parsed.city;
  let state = parsed.state || 'OH';
  // Normalize state to 2-letter code
  const stateMap = {'ohio': 'OH', 'indiana': 'IN', 'kentucky': 'KY', 'michigan': 'MI', 'west virginia': 'WV', 'pennsylvania': 'PA'};
  if (state && state.length > 2) {
    state = stateMap[state.toLowerCase()] || 'OH';
  }
  let zip = parsed.zip;
  
  // Build customer name from what they said
  let customerName = parsed.last_name 
    ? `${parsed.first_name || 'Customer'} ${parsed.last_name}` 
    : (parsed.first_name || 'Customer');
  
  let customerId = null;
  let locationId = null;
  
  // Check for existing customer by phone
  const existingCustomer = await findCustomerByPhone(normalizedPhone);
  if (existingCustomer) {
    customerId = existingCustomer.id;
    console.log('[POST-CALL] Found existing customer:', customerId, existingCustomer.name);
    
    // Use existing customer name if we didn't get one
    if (!parsed.first_name) {
      customerName = existingCustomer.name;
    }
    
    // ONLY use ST address as fallback if we got NOTHING from the call
    const stAddr = existingCustomer.address || {};
    if (!street && !city && !zip) {
      console.log('[POST-CALL] No address from call, using ST address');
      street = stAddr.street;
      city = stAddr.city;
      zip = stAddr.zip;
      if (stAddr.state) state = stAddr.state;
      
      // Use existing location
      const locations = await stApi('GET', `/crm/v2/tenant/${CONFIG.ST_TENANT_ID}/locations?customerId=${customerId}&pageSize=1`);
      if (locations.data?.length > 0) {
        locationId = locations.data[0].id;
      }
    } else {
      // They gave us an address - create NEW location for this address
      console.log('[POST-CALL] Using address from call, creating new location');
    }
  }
  
  // DEFAULTS if still missing
  if (!street) street = 'NEEDS ADDRESS';
  if (!city) city = 'NEEDS CITY';
  if (!zip) zip = '45402';
  
  // Create new customer if needed
  if (!customerId) {
    console.log('[POST-CALL] Creating new customer:', customerName);
    const customerResult = await stApi('POST', `/crm/v2/tenant/${CONFIG.ST_TENANT_ID}/customers`, {
      name: customerName,
      type: 'Residential',
      address: { street, city, state, zip, country: 'USA' },
      contacts: [{ type: 'MobilePhone', value: normalizedPhone }],
      locations: [{
        name: customerName,
        address: { street, city, state, zip, country: 'USA' },
        contacts: [{ type: 'MobilePhone', value: normalizedPhone }]
      }]
    });
    customerId = customerResult.id;
    locationId = customerResult.locations[0].id;
  }
  
  // Create new location if we have customer but no location (new address for existing customer)
  if (!locationId) {
    console.log('[POST-CALL] Creating new location for existing customer');
    const newLoc = await stApi('POST', `/crm/v2/tenant/${CONFIG.ST_TENANT_ID}/locations`, {
      customerId,
      name: customerName,
      address: { street, city, state, zip, country: 'USA' },
      contacts: [{ type: 'MobilePhone', value: normalizedPhone }]
    });
    locationId = newLoc.id;
  }
  
  const apptDate = getNextBusinessDay(parsed.day);
  const timeWindow = parsed.time_window || 'morning';
  const window = CONFIG.ARRIVAL_WINDOWS[timeWindow] || CONFIG.ARRIVAL_WINDOWS.morning;
  const startUTC = easternToUTC(apptDate.year, apptDate.month, apptDate.day, window.startHour);
  const endUTC = easternToUTC(apptDate.year, apptDate.month, apptDate.day, window.endHour);
  
  const issue = parsed.issue || 'Service call - see transcript';
  const isDrain = /drain|sewer|clog|backup|snake/i.test(issue);
  
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  
  const job = await stApi('POST', `/jpm/v2/tenant/${CONFIG.ST_TENANT_ID}/jobs`, {
    customerId,
    locationId,
    businessUnitId: isDrain ? CONFIG.BUSINESS_UNIT_DRAIN : CONFIG.BUSINESS_UNIT_PLUMBING,
    jobTypeId: isDrain ? CONFIG.JOB_TYPE_DRAIN : CONFIG.JOB_TYPE_SERVICE,
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
  
  console.log('[POST-CALL] Job created:', job.id);
  
  const missingData = [];
  if (!parsed.street) missingData.push('address');
  if (!parsed.city) missingData.push('city');
  if (!parsed.zip) missingData.push('zip');
  if (!parsed.first_name) missingData.push('name');
  
  return {
    success: true,
    job_id: job.id,
    customer_id: customerId,
    location_id: locationId,
    customer_name: customerName,
    address: `${street}, ${city}, ${state} ${zip}`,
    day: dayNames[apptDate.dayOfWeek],
    time_window: timeWindow,
    missing_data: missingData.length > 0 ? missingData : null
  };
}

async function postToSlack(call, parsed, bookingResult) {
  if (!CONFIG.SLACK_BOT_TOKEN || !CONFIG.SLACK_TRANSCRIPT_CHANNEL) return;
  
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
      if (bookingResult.missing_data) {
        headerEmoji = '⚠️';
        statusText += ` | MISSING: ${bookingResult.missing_data.join(', ')}`;
      }
    } else if (parsed?.should_book === false) {
      headerEmoji = '🟡';
      headerText = 'No Booking';
      statusText = 'Customer did not confirm appointment';
    } else {
      headerEmoji = '❌';
      headerText = 'Failed';
      statusText = 'Booking failed - check logs';
    }
    
    const customerName = bookingResult?.customer_name || [parsed?.first_name, parsed?.last_name].filter(Boolean).join(' ') || 'Unknown';
    const address = bookingResult?.address || [parsed?.street, parsed?.city, parsed?.state, parsed?.zip].filter(Boolean).join(', ') || 'Not provided';
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
    const callId = call?.call_id;
    
    console.log('[POST-CALL] Event:', event, 'Call ID:', callId);
    
    // ONLY process call_ended - ignore call_analyzed to prevent double booking
    if (event !== 'call_ended') {
      return res.status(200).json({ status: 'ignored', reason: 'only processing call_ended' });
    }
    
    const transcript = call?.transcript;
    const callerPhone = call?.from_number;
    
    if (!transcript) {
      console.log('[POST-CALL] No transcript');
      return res.status(200).json({ status: 'skipped', reason: 'no transcript' });
    }
    
    console.log('[POST-CALL] Processing call from:', callerPhone);
    
    const parsed = await parseTranscript(transcript, callerPhone);
    console.log('[POST-CALL] Parsed:', JSON.stringify(parsed, null, 2));
    
    let bookingResult = null;
    
    if (parsed.should_book) {
      console.log('[POST-CALL] should_book=true, checking for duplicates...');
      
      // Check if already booked (prevents double booking from webhook retries)
      const cleanPhone = String(parsed.phone || callerPhone || '').replace(/\D/g, '');
      const normalizedPhone = cleanPhone.length === 11 && cleanPhone.startsWith('1') ? cleanPhone.slice(1) : cleanPhone;
      const existingCustomer = await findCustomerByPhone(normalizedPhone);
      
      if (existingCustomer && await alreadyBooked(existingCustomer.id)) {
        console.log('[POST-CALL] DUPLICATE DETECTED - skipping booking');
        return res.status(200).json({ status: 'duplicate', reason: 'already booked in last 5 min' });
      }
      
      bookingResult = await createBooking(parsed, callerPhone);
    } else {
      console.log('[POST-CALL] should_book=false, no booking');
    }
    
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



