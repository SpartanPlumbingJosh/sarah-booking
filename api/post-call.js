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
  CAMPAIGN_ID_FALLBACK: 313, // Sarah Voice AI - used when tracking number lookup fails
  
  // Dispatch fee services
  SERVICE_DISPATCH_79: 43942323,    // $79 Standard Service Call
  SERVICE_DISPATCH_WAIVED: 79558845, // $0 Waived Dispatch Fee
  
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

// Look up campaign from ServiceTitan call record using caller's phone number
async function getCampaignFromCallRecord(callerPhone) {
  if (!callerPhone) return null;
  
  try {
    let phone = callerPhone.replace(/\D/g, '');
    if (phone.length === 11 && phone.startsWith('1')) {
      phone = phone.slice(1);
    }
    
    console.log('[POST-CALL] Looking up call record for caller:', phone);
    
    // Use the export API - it returns campaign data unlike the regular calls endpoint
    // Get calls from today with recent changes included
    const today = new Date().toISOString().split('T')[0];
    const result = await stApi('GET', `/telecom/v2/tenant/${CONFIG.ST_TENANT_ID}/export/calls?from=${today}&includeRecentChanges=true`);
    
    // Filter to find calls from this phone number
    const callsFromCaller = (result.data || []).filter(c => {
      const callFrom = (c.from || '').replace(/\D/g, '');
      return callFrom === phone || callFrom.endsWith(phone) || phone.endsWith(callFrom);
    });
    
    console.log('[POST-CALL] Found', callsFromCaller.length, 'calls from', phone, 'today');
    
    if (callsFromCaller.length > 0) {
      // Sort by createdOn descending to get most recent
      callsFromCaller.sort((a, b) => new Date(b.createdOn) - new Date(a.createdOn));
      
      // Log calls for debugging
      for (const c of callsFromCaller.slice(0, 3)) {
        console.log('[POST-CALL] Call ID:', c.id, '| Created:', c.createdOn, '| To:', c.to, '| Campaign:', c.campaign?.id, c.campaign?.name || 'NONE');
      }
      
      // Find the most recent call with a campaign
      const callWithCampaign = callsFromCaller.find(c => c.campaign && c.campaign.id);
      
      if (callWithCampaign) {
        console.log('[POST-CALL] Using campaign:', callWithCampaign.campaign.id, callWithCampaign.campaign.name);
        return { id: callWithCampaign.campaign.id, name: callWithCampaign.campaign.name };
      }
      
      console.log('[POST-CALL] No calls found with campaign attached');
    } else {
      console.log('[POST-CALL] No call records found for:', phone, 'today');
    }
  } catch (error) {
    console.error('[POST-CALL] Call record lookup failed:', error.message);
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
  
  // Check for existing customer by phone
  const existingCustomer = await findCustomerByPhone(lookupPhone);
  
  // Determine if Sarah extracted new customer info
  const hasExtractedName = extracted.customer_first_name && extracted.customer_first_name.length > 0;
  const hasExtractedAddress = extracted.customer_street && extracted.customer_street.length > 0;
  
  if (existingCustomer && hasExtractedName) {
    // Compare names - if different, this is a NEW customer (caller booking for someone else)
    const existingNameLower = (existingCustomer.name || '').toLowerCase();
    const extractedNameLower = customerName.toLowerCase();
    const firstNameMatch = existingNameLower.includes(extracted.customer_first_name.toLowerCase());
    
    if (firstNameMatch && !hasExtractedAddress) {
      // Same person, no new address - use existing customer and location
      customerId = existingCustomer.id;
      customerName = existingCustomer.name;
      console.log('[POST-CALL] Using existing customer (name matches):', customerId, customerName);
      
      try {
        const locations = await stApi('GET', `/crm/v2/tenant/${CONFIG.ST_TENANT_ID}/locations?customerId=${customerId}&pageSize=1`);
        if (locations.data && locations.data.length > 0) {
          locationId = locations.data[0].id;
          street = locations.data[0].address?.street || street;
          city = locations.data[0].address?.city || city;
          zip = locations.data[0].address?.zip || zip;
          console.log('[POST-CALL] Using existing location:', locationId);
        }
      } catch (e) {
        console.log('[POST-CALL] Could not fetch existing location');
      }
    } else {
      // Different name OR new address - create NEW customer with Sarah's data
      console.log('[POST-CALL] Creating new customer - extracted name:', customerName, '| existing:', existingCustomer.name);
      // customerId stays null - will create below
    }
  } else if (existingCustomer && !hasExtractedName) {
    // No extracted name - use existing customer
    customerId = existingCustomer.id;
    customerName = existingCustomer.name || customerName;
    console.log('[POST-CALL] Using existing customer (no extracted name):', customerId, customerName);
    
    if (!hasExtractedAddress) {
      try {
        const locations = await stApi('GET', `/crm/v2/tenant/${CONFIG.ST_TENANT_ID}/locations?customerId=${customerId}&pageSize=1`);
        if (locations.data && locations.data.length > 0) {
          locationId = locations.data[0].id;
          street = locations.data[0].address?.street || street;
          city = locations.data[0].address?.city || city;
          zip = locations.data[0].address?.zip || zip;
          console.log('[POST-CALL] Using existing location:', locationId);
        }
      } catch (e) {
        console.log('[POST-CALL] Could not fetch existing location');
      }
    }
  }
  
  // Create new customer if needed
  if (!customerId) {
    const addressObj = { 
      street: street || 'TBD', 
      city: city || 'Dayton', 
      state, 
      zip: zip || '45402', 
      country: 'USA' 
    };
    
    // ServiceTitan requires locations array when creating customer
    const newCustomer = await stApi('POST', `/crm/v2/tenant/${CONFIG.ST_TENANT_ID}/customers`, {
      name: customerName,
      type: 'Residential',
      address: addressObj,
      locations: [{
        name: customerName,
        address: addressObj,
        contacts: [{
          type: 'Phone',
          value: contactPhone,
          memo: 'Primary'
        }]
      }],
      contacts: [{
        type: 'Phone',
        value: contactPhone,
        memo: 'Primary'
      }]
    });
    customerId = newCustomer.id;
    console.log('[POST-CALL] Created customer:', customerId);
    
    // Get the location that was created with the customer
    try {
      const locations = await stApi('GET', `/crm/v2/tenant/${CONFIG.ST_TENANT_ID}/locations?customerId=${customerId}&pageSize=1`);
      if (locations.data && locations.data.length > 0) {
        locationId = locations.data[0].id;
        console.log('[POST-CALL] Got location from new customer:', locationId);
      }
    } catch (e) {
      console.log('[POST-CALL] Could not fetch location for new customer');
    }
  }
  
  // Create location if still needed (existing customer, new address)
  if (!locationId && customerId) {
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
    console.log('[POST-CALL] Created new location for existing customer:', locationId);
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
  const campaign = await getCampaignFromCallRecord(callerPhone);
  const campaignId = campaign ? campaign.id : CONFIG.CAMPAIGN_ID_FALLBACK;
  const campaignName = campaign ? campaign.name : 'Sarah Voice AI';
  
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
  console.log('[POST-CALL] Customer ID:', customerId, '| Location ID:', locationId);
  console.log('[POST-CALL] Address:', street, city, state, zip);
  
  if (!customerId || !locationId) {
    throw new Error(`Missing required IDs - customerId: ${customerId}, locationId: ${locationId}`);
  }
  
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
  
  
  // Always include campaignId (uses fallback if tracking lookup fails)
    jobPayload.campaignId = campaignId;
  
  const job = await stApi('POST', `/jpm/v2/tenant/${CONFIG.ST_TENANT_ID}/jobs`, jobPayload);
  
  console.log('[POST-CALL] Job created:', job.id);
  
  // Add dispatch fee service to invoice based on what customer agreed to
  try {
    const dispatchFeeValue = extracted.dispatch_fee ? String(extracted.dispatch_fee).replace(/[^0-9]/g, '') : '79';
    const isWaived = dispatchFeeValue === '0' || 
                     (extracted.promises_made || '').toLowerCase().includes('waive') ||
                     (extracted.dispatch_fee || '').toLowerCase().includes('waive');
    
    const serviceId = isWaived ? CONFIG.SERVICE_DISPATCH_WAIVED : CONFIG.SERVICE_DISPATCH_79;
    const serviceName = isWaived ? '$0 Waived Dispatch Fee' : '$79 Standard Service Call';
    const servicePrice = isWaived ? 0 : 79;
    
    console.log('[POST-CALL] Adding dispatch service:', serviceName, '(ID:', serviceId, ')');
    
    // Get the invoice for this job
    const invoices = await stApi('GET', `/accounting/v2/tenant/${CONFIG.ST_TENANT_ID}/invoices?jobId=${job.id}`);
    
    if (invoices.data && invoices.data.length > 0) {
      const invoiceId = invoices.data[0].id;
      console.log('[POST-CALL] Found invoice:', invoiceId);
      
      // Add the dispatch service to the invoice
      await stApi('PATCH', `/accounting/v2/tenant/${CONFIG.ST_TENANT_ID}/invoices/${invoiceId}/items`, {
        skuId: serviceId,
        quantity: 1,
        unitPrice: servicePrice
      });
      
      console.log('[POST-CALL] Added dispatch service to invoice');
    } else {
      console.log('[POST-CALL] No invoice found for job yet - dispatch service not added');
    }
  } catch (invoiceErr) {
    console.log('[POST-CALL] Could not add dispatch service to invoice:', invoiceErr.message);
  }
  
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







