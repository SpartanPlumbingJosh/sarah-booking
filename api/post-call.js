const fetch = require('node-fetch');

const CONFIG = {
  ST_CLIENT_ID: process.env.ST_CLIENT_ID,
  ST_CLIENT_SECRET: process.env.ST_CLIENT_SECRET,
  ST_TENANT_ID: process.env.ST_TENANT_ID,
  ST_APP_KEY: process.env.ST_APP_KEY,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN,
  SLACK_TRANSCRIPT_CHANNEL: process.env.SLACK_TRANSCRIPT_CHANNEL,
  
  BUSINESS_UNIT_PLUMBING: 44663237,
  BUSINESS_UNIT_DRAIN: 44665438,
  JOB_TYPE_SERVICE: 79273907,
  JOB_TYPE_DRAIN: 79265910,
  // No hardcoded fallback - campaign comes from tracking number lookup only
  
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

// Look up campaign by tracking phone number for marketing attribution
async function getCampaignByPhone(trackingNumber) {
  if (!trackingNumber) return null;
  
  try {
    let phone = trackingNumber.replace(/\D/g, '');
    if (phone.length === 11 && phone.startsWith('1')) {
      phone = phone.slice(1);
    }
    
    console.log('[POST-CALL] Looking up campaign for tracking number:', phone);
    
    const result = await stApi('GET', `/marketing/v2/tenant/${CONFIG.ST_TENANT_ID}/campaigns?campaignPhoneNumber=${phone}&pageSize=5`);
    
    if (result.data && result.data.length > 0) {
      const campaign = result.data[0];
      console.log('[POST-CALL] Found campaign:', campaign.id, campaign.name);
      return { id: campaign.id, name: campaign.name };
    }
    
    console.log('[POST-CALL] No campaign found for tracking number:', phone);
  } catch (error) {
    console.error('[POST-CALL] Campaign lookup failed:', error.message);
  }
  return null;
}

// Eastern timezone helpers
function getEasternNow() {
  const now = new Date();
  return new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
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

function getNextBusinessDay(dayName, includeToday = true) {
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const easternNow = getEasternNow();
  const currentDayOfWeek = easternNow.getDay();
  const currentHour = easternNow.getHours();
  
  // Handle "today"
  if (dayName && dayName.toLowerCase() === 'today') {
    if (currentHour < 17) { // Before 5 PM
      return {
        year: easternNow.getFullYear(),
        month: easternNow.getMonth() + 1,
        day: easternNow.getDate(),
        dayOfWeek: currentDayOfWeek
      };
    } else {
      // After 5 PM, treat as tomorrow
      dayName = 'tomorrow';
    }
  }
  
  // Handle "tomorrow"
  if (dayName && dayName.toLowerCase() === 'tomorrow') {
    const tomorrow = new Date(easternNow);
    tomorrow.setDate(tomorrow.getDate() + 1);
    return {
      year: tomorrow.getFullYear(),
      month: tomorrow.getMonth() + 1,
      day: tomorrow.getDate(),
      dayOfWeek: tomorrow.getDay()
    };
  }
  
  // Handle day of week
  const targetDay = days.indexOf(dayName?.toLowerCase());
  if (targetDay === -1) {
    // Default to tomorrow
    const tomorrow = new Date(easternNow);
    tomorrow.setDate(tomorrow.getDate() + 1);
    return {
      year: tomorrow.getFullYear(),
      month: tomorrow.getMonth() + 1,
      day: tomorrow.getDate(),
      dayOfWeek: tomorrow.getDay()
    };
  }
  
  let daysUntil = targetDay - currentDayOfWeek;
  if (daysUntil < 0) daysUntil += 7;
  if (daysUntil === 0 && (!includeToday || currentHour >= 17)) daysUntil = 7;
  
  const targetDate = new Date(easternNow);
  targetDate.setDate(targetDate.getDate() + daysUntil);
  
  return {
    year: targetDate.getFullYear(),
    month: targetDate.getMonth() + 1,
    day: targetDate.getDate(),
    dayOfWeek: targetDay
  };
}

async function alreadyBooked(customerId) {
  try {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const jobs = await stApi('GET', `/jpm/v2/tenant/${CONFIG.ST_TENANT_ID}/jobs?customerId=${customerId}&createdOnOrAfter=${fiveMinAgo}&pageSize=5`);
    
    if (jobs.data && jobs.data.length > 0) {
      console.log('[POST-CALL] Found', jobs.data.length, 'recent jobs for customer', customerId);
      return true;
    }
    return false;
  } catch (error) {
    console.error('[POST-CALL] Dedupe check failed:', error.message);
    return false;
  }
}

async function createBooking(extracted, callerPhone, trackingNumber) {
  // Use extracted data from Retell's post-call analysis
  const callerDigits = callerPhone ? callerPhone.replace(/\D/g, '') : '';
  const lookupPhone = callerDigits.length === 11 && callerDigits.startsWith('1') 
    ? callerDigits.slice(1) : callerDigits;
  
  const spokenPhone = extracted.customer_phone ? extracted.customer_phone.replace(/\D/g, '') : '';
  const contactPhone = spokenPhone || lookupPhone;
  
  let street = extracted.customer_street;
  let city = extracted.customer_city;
  let state = 'OH';
  let zip = extracted.customer_zip;
  
  let customerName = extracted.customer_last_name 
    ? `${extracted.customer_first_name || 'Customer'} ${extracted.customer_last_name}` 
    : (extracted.customer_first_name || 'Customer');
  
  let customerId = null;
  let locationId = null;
  
  // Check for existing customer
  const existingCustomer = await findCustomerByPhone(lookupPhone);
  if (existingCustomer) {
    customerId = existingCustomer.id;
    console.log('[POST-CALL] Found existing customer:', customerId, existingCustomer.name);
    
    if (!extracted.customer_first_name) {
      customerName = existingCustomer.name || customerName;
    }
    
    // Get existing location
    try {
      const locations = await stApi('GET', `/crm/v2/tenant/${CONFIG.ST_TENANT_ID}/locations?customerId=${customerId}&pageSize=1`);
      if (locations.data && locations.data.length > 0) {
        const existingLoc = locations.data[0];
        locationId = existingLoc.id;
        
        if (!street) street = existingLoc.address?.street;
        if (!city) city = existingLoc.address?.city;
        if (!zip) zip = existingLoc.address?.zip;
      }
    } catch (e) {
      console.log('[POST-CALL] Could not fetch existing location');
    }
  }
  
  // Create new customer if needed
  if (!customerId) {
    const nameParts = customerName.split(' ');
    const newCustomer = await stApi('POST', `/crm/v2/tenant/${CONFIG.ST_TENANT_ID}/customers`, {
      name: customerName,
      type: 'Residential',
      address: { street: street || 'TBD', city: city || 'Dayton', state, zip: zip || '45402', country: 'USA' },
      contacts: [{
        type: 'Phone',
        value: contactPhone,
        memo: 'Primary'
      }]
    });
    customerId = newCustomer.id;
    console.log('[POST-CALL] Created customer:', customerId);
  }
  
  // Create location if needed
  if (!locationId) {
    const newLocation = await stApi('POST', `/crm/v2/tenant/${CONFIG.ST_TENANT_ID}/locations`, {
      customerId,
      name: customerName,
      address: { street: street || 'TBD', city: city || 'Dayton', state, zip: zip || '45402', country: 'USA' },
      contacts: [{
        type: 'Phone',
        value: contactPhone,
        memo: 'Primary'
      }]
    });
    locationId = newLocation.id;
    console.log('[POST-CALL] Created location:', locationId);
  }
  
  // Determine service type
  const isDrain = extracted.is_drain_issue === true;
  const issue = extracted.issue_description || 'Service call';
  
  // Get appointment date
  const timeWindow = (extracted.booked_time_window || 'morning').toLowerCase();
  const apptDate = getNextBusinessDay(extracted.booked_day, true);
  
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const arrivalDay = dayNames[apptDate.dayOfWeek];
  
  // Calculate UTC times
  const window = CONFIG.ARRIVAL_WINDOWS[timeWindow] || CONFIG.ARRIVAL_WINDOWS.morning;
  const isDST = isDSTinEffect(apptDate.year, apptDate.month, apptDate.day);
  const offsetHours = isDST ? 4 : 5;
  
  const startUTC = new Date(Date.UTC(apptDate.year, apptDate.month - 1, apptDate.day, window.startHour + offsetHours, 0, 0)).toISOString();
  const endUTC = new Date(Date.UTC(apptDate.year, apptDate.month - 1, apptDate.day, window.endHour + offsetHours, 0, 0)).toISOString();
  
  const windowTimes = { morning: '8-11 AM', midday: '11 AM-2 PM', afternoon: '2-5 PM' };
  const arrivalTime = windowTimes[timeWindow] || timeWindow;
  
  // Look up campaign from tracking number
  const campaign = await getCampaignByPhone(trackingNumber);
  const campaignId = campaign ? campaign.id : null;
  const campaignName = campaign ? campaign.name : 'Unknown';
  
  // Build job summary in ServiceTitan's exact field format
  const dispatchFee = extracted.dispatch_fee ? `$${extracted.dispatch_fee}` : '$79';
  const promisesMade = extracted.promises_made || '';
  const updatesVia = extracted.notification_preference || 'text';
  
  const jobSummary = `Job Description: ${issue}
Expected Arrival Time: ${arrivalTime}
Dispatch Fee Quoted: ${dispatchFee}
Promises Made: ${promisesMade}
Updates Via Text or Call: ${updatesVia}
Tried To Contact: 
Other: `;
  
  console.log('[POST-CALL] Using campaign:', campaignId, campaignName);
  
  // Build job payload
  const jobPayload = {
    customerId,
    locationId,
    businessUnitId: isDrain ? CONFIG.BUSINESS_UNIT_DRAIN : CONFIG.BUSINESS_UNIT_PLUMBING,
    jobTypeId: isDrain ? CONFIG.JOB_TYPE_DRAIN : CONFIG.JOB_TYPE_SERVICE,
    priority: 'Normal',
    summary: jobSummary,
    appointments: [{
      start: startUTC,
      end: endUTC,
      arrivalWindowStart: startUTC,
      arrivalWindowEnd: endUTC
    }]
  };
  
  // Only add campaignId if we have one from tracking number lookup
  if (campaignId) {
    jobPayload.campaignId = campaignId;
  }
  
  const job = await stApi('POST', `/jpm/v2/tenant/${CONFIG.ST_TENANT_ID}/jobs`, jobPayload);
  
  console.log('[POST-CALL] Job created:', job.id);
  
  const missingData = [];
  if (!street) missingData.push('address');
  if (!city) missingData.push('city');
  if (!zip) missingData.push('zip');
  if (!extracted.customer_first_name) missingData.push('name');
  
  return {
    success: true,
    job_id: job.id,
    customer_id: customerId,
    location_id: locationId,
    customer_name: customerName,
    address: `${street || 'TBD'}, ${city || 'Dayton'}, ${state} ${zip || ''}`,
    day: arrivalDay,
    time_window: timeWindow,
    campaign: campaignName,
    missing_data: missingData.length > 0 ? missingData : null
  };
}

async function postToSlack(call, extracted, bookingResult) {
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
      statusText = `Job #${bookingResult.job_id} | ${bookingResult.day} ${bookingResult.time_window} | ${bookingResult.campaign}`;
      if (bookingResult.missing_data) {
        headerEmoji = '⚠️';
        statusText += ` | MISSING: ${bookingResult.missing_data.join(', ')}`;
      }
    } else if (extracted?.should_book === false) {
      headerEmoji = '🟡';
      headerText = 'Not Booked';
      statusText = 'Customer did not book';
    } else {
      headerEmoji = '🔴';
      headerText = 'Error';
      statusText = 'Booking failed';
    }
    
    const callerID = call?.from_number || 'Unknown';
    const trackingNum = call?.to_number || 'Unknown';
    
    const blocks = [
      {
        type: 'header',
        text: { type: 'plain_text', text: `${headerEmoji} ${headerText}`, emoji: true }
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Caller:* ${callerID}` },
          { type: 'mrkdwn', text: `*Tracking #:* ${trackingNum}` },
          { type: 'mrkdwn', text: `*Duration:* ${durationStr}` },
          { type: 'mrkdwn', text: `*Status:* ${statusText}` }
        ]
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*Issue:* ${extracted?.issue_description || 'N/A'}` }
      },
      { type: 'divider' },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `\`\`\`${transcript.substring(0, 2500)}\`\`\`` }
      }
    ];
    
    await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CONFIG.SLACK_BOT_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        channel: CONFIG.SLACK_TRANSCRIPT_CHANNEL,
        blocks
      })
    });
  } catch (error) {
    console.error('[POST-CALL] Slack post failed:', error.message);
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  
  try {
    const { event, call } = req.body;
    const callId = call?.call_id;
    
    console.log('[POST-CALL] Event:', event, 'Call ID:', callId);
    
    // Process call_analyzed event (has the extracted data we need)
    if (event !== 'call_analyzed') {
      return res.status(200).json({ status: 'ignored', reason: 'waiting for call_analyzed' });
    }
    
    const transcript = call?.transcript;
    const callerPhone = call?.from_number;
    const trackingNumber = call?.to_number;
    
    // Get extracted data from Retell's post-call analysis
    const customAnalysis = call?.call_analysis?.custom_analysis_data || {};
    
    console.log('[POST-CALL] Processing call from:', callerPhone, 'to:', trackingNumber);
    console.log('[POST-CALL] Extracted data:', JSON.stringify(customAnalysis, null, 2));
    
    let bookingResult = null;
    
    if (customAnalysis.should_book === true) {
      console.log('[POST-CALL] should_book=true, checking for duplicates...');
      
      const callerDigits = callerPhone ? callerPhone.replace(/\D/g, '') : '';
      const lookupPhone = callerDigits.length === 11 && callerDigits.startsWith('1') ? callerDigits.slice(1) : callerDigits;
      const existingCustomer = await findCustomerByPhone(lookupPhone);
      
      if (existingCustomer && await alreadyBooked(existingCustomer.id)) {
        console.log('[POST-CALL] DUPLICATE DETECTED - skipping booking');
        return res.status(200).json({ status: 'duplicate', reason: 'already booked in last 5 min' });
      }
      
      bookingResult = await createBooking(customAnalysis, callerPhone, trackingNumber);
    } else {
      console.log('[POST-CALL] should_book=false or missing, no booking');
    }
    
    await postToSlack(call, customAnalysis, bookingResult);
    
    return res.status(200).json({
      status: bookingResult?.success ? 'booked' : 'not_booked',
      extracted: customAnalysis,
      booking: bookingResult
    });
    
  } catch (error) {
    console.error('[POST-CALL] Error:', error.message);
    return res.status(200).json({ status: 'error', error: error.message });
  }
};

