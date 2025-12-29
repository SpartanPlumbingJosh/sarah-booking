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
  if (cachedToken && Date.now() < tokenExpiry - 60000) {
    return cachedToken;
  }
  
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

async function lookupCustomer(phone) {
  const cleanPhone = String(phone).replace(/\D/g, '');
  const normalizedPhone = cleanPhone.length === 11 && cleanPhone.startsWith('1') 
    ? cleanPhone.slice(1) : cleanPhone;
  
  if (normalizedPhone.length !== 10) {
    return { is_existing_customer: 'false' };
  }
  
  try {
    const token = await getAccessToken();
    const response = await fetch(
      `https://api-integration.servicetitan.io/crm/v2/tenant/${CONFIG.ST_TENANT_ID}/customers?phone=${normalizedPhone}&pageSize=5`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'ST-App-Key': CONFIG.ST_APP_KEY
        }
      }
    );
    
    const data = await response.json();
    console.log('[INBOUND] ST returned', (data.data || []).length, 'customers for', normalizedPhone);
    
    if (data.data && data.data.length > 0) {
      const customer = data.data[0];
      console.log('[INBOUND] Found customer:', customer.id, customer.name);
      const address = customer.address || {};
      return {
        customer_id: String(customer.id),
        customer_name: customer.name || '',
        customer_first_name: (customer.name || '').split(' ')[0] || '',
        customer_street: address.street || '',
        customer_city: address.city || '',
        customer_state: address.state || '',
        customer_zip: address.zip || '',
        is_existing_customer: 'true'
      };
    }
    
    return { is_existing_customer: 'false' };
  } catch (error) {
    console.error('[INBOUND] Customer lookup error:', error.message);
    return { is_existing_customer: 'false' };
  }
}

// Get current time in Eastern timezone
function getEasternNow() {
  const now = new Date();
  return new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
}

// Format date as YYYY-MM-DD in Eastern time (avoids toISOString UTC conversion)
function formatDateStr(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Get next N business days INCLUDING TODAY if there's still time
function getNextBusinessDays(count) {
  const days = [];
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  
  // Use Eastern time
  const easternNow = getEasternNow();
  const currentHour = easternNow.getHours();
  
  // Start from TODAY, not tomorrow
  let checkDate = new Date(easternNow);
  
  while (days.length < count) {
    const dayOfWeek = checkDate.getDay();
    
    // Skip weekends
    if (dayOfWeek !== 0 && dayOfWeek !== 6) {
      const isToday = formatDateStr(checkDate) === formatDateStr(easternNow);
      
      // For today, only include if it's before 5 PM (last window ends at 5)
      // For future days, always include
      if (!isToday || currentHour < 17) {
        days.push({
          dayName: isToday ? 'today' : dayNames[dayOfWeek],
          dateStr: formatDateStr(checkDate),
          isToday: isToday,
          currentHour: isToday ? currentHour : null
        });
      }
    }
    checkDate.setDate(checkDate.getDate() + 1);
  }
  
  return days;
}

function getWindowName(hour) {
  if (hour >= 8 && hour < 11) return 'morning';
  if (hour >= 11 && hour < 14) return 'midday';
  if (hour >= 14 && hour < 17) return 'afternoon';
  return null;
}

// Check if a window is still available today based on current hour
function isWindowStillAvailable(windowName, currentHour) {
  if (currentHour === null) return true; // Future day, all windows valid
  
  // Window start times
  const windowStarts = {
    'morning': 8,
    'midday': 11,
    'afternoon': 14
  };
  
  // Only offer windows that haven't started yet (give 1 hour buffer)
  return currentHour < windowStarts[windowName];
}

async function getAvailability() {
  try {
    const token = await getAccessToken();
    const businessDays = getNextBusinessDays(5);
    
    if (businessDays.length === 0) {
      return { available_slots: "We're closed this week" };
    }
    
    const startDate = businessDays[0].dateStr;
    const endDate = businessDays[businessDays.length - 1].dateStr;
    
    const response = await fetch(
      `https://api-integration.servicetitan.io/dispatch/v2/tenant/${CONFIG.ST_TENANT_ID}/capacity`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'ST-App-Key': CONFIG.ST_APP_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          startsOnOrAfter: `${startDate}T00:00:00Z`,
          endsOnOrBefore: `${endDate}T23:59:59Z`,
          skillBasedAvailability: false
        })
      }
    );
    
    const data = await response.json();
    const availabilities = data.availabilities || [];
    
    const slotsByDate = {};
    for (const slot of availabilities) {
      if (!slot.isAvailable) continue;
      
      const dateStr = slot.start.split('T')[0];
      const hour = new Date(slot.start).getUTCHours();
      const windowName = getWindowName(hour);
      
      if (!windowName) continue;
      
      if (!slotsByDate[dateStr]) {
        slotsByDate[dateStr] = new Set();
      }
      slotsByDate[dateStr].add(windowName);
    }
    
    const available = [];
    for (const day of businessDays) {
      const windows = slotsByDate[day.dateStr];
      if (windows && windows.size > 0) {
        // Filter out windows that have passed (for today only)
        const validWindows = Array.from(windows).filter(w => 
          isWindowStillAvailable(w, day.currentHour)
        );
        
        if (validWindows.length > 0) {
          available.push({
            day: day.dayName,
            date: day.dateStr,
            windows: validWindows
          });
        }
      }
    }
    
    if (available.length === 0) {
      return { 
        available_slots: "We're all booked up this week",
        has_availability: 'false'
      };
    }
    
    const slotText = available.slice(0, 3).map(day => {
      return `${day.day}: ${day.windows.join(', ')}`;
    }).join('. ');
    
    return {
      available_slots: slotText,
      has_availability: 'true',
      next_available_day: available[0].day,
      next_available_date: available[0].date
    };
    
  } catch (error) {
    console.error('[INBOUND] Availability error:', error.message);
    return { 
      available_slots: "morning, midday, and afternoon this week",
      has_availability: 'true'
    };
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  try {
    console.log('[INBOUND] Webhook received');
    
    const { event, call_inbound } = req.body;
    
    if (event !== 'call_inbound' || !call_inbound) {
      return res.status(200).json({});
    }
    
    const fromNumber = call_inbound.from_number;
    console.log('[INBOUND] Looking up:', fromNumber);
    
    const [customerData, availabilityData] = await Promise.all([
      lookupCustomer(fromNumber),
      getAvailability()
    ]);
    
    // Add today_date so Sarah knows what day it is
    const easternNow = getEasternNow();
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 
                        'July', 'August', 'September', 'October', 'November', 'December'];
    
    const todayDayName = dayNames[easternNow.getDay()];
    const todayMonth = monthNames[easternNow.getMonth()];
    const todayDate = easternNow.getDate();
    
    const dynamicVars = {
      ...(customerData || { is_existing_customer: 'false' }),
      ...availabilityData,
      // Sarah's script expects {{today_date}}
      today_date: `${todayDayName}, ${todayMonth} ${todayDate}`
    };
    
    console.log('[INBOUND] Dynamic vars:', JSON.stringify(dynamicVars));
    
    return res.status(200).json({
      call_inbound: {
        dynamic_variables: dynamicVars
      }
    });
    
  } catch (error) {
    console.error('[INBOUND] Error:', error.message);
    return res.status(200).json({});
  }
};
