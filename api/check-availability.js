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

// Get next N business days starting from tomorrow (Eastern time)
function getNextBusinessDays(count) {
  const days = [];
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  
  // FIX: Use Eastern time, not UTC
  const easternNow = getEasternNow();
  
  let checkDate = new Date(easternNow);
  checkDate.setDate(checkDate.getDate() + 1); // Start from tomorrow
  
  while (days.length < count) {
    const dayOfWeek = checkDate.getDay();
    if (dayOfWeek !== 0 && dayOfWeek !== 6) { // Skip weekends
      days.push({
        date: new Date(checkDate),
        dayName: dayNames[dayOfWeek],
        dateStr: formatDateStr(checkDate)
      });
    }
    checkDate.setDate(checkDate.getDate() + 1);
  }
  
  return days;
}

// Call ServiceTitan's capacity API
async function getCapacity(startDate, endDate) {
  const token = await getAccessToken();
  
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
        startsOnOrAfter: `${startDate}T00:00:00Z`,
        endsOnOrBefore: `${endDate}T23:59:59Z`,
        skillBasedAvailability: false
      })
    }
  );
  
  const data = await response.json();
  return data.availabilities || [];
}

// Map time windows to friendly names
function getWindowName(hour) {
  if (hour >= 8 && hour < 11) return 'morning';
  if (hour >= 11 && hour < 14) return 'midday';
  if (hour >= 14 && hour < 17) return 'afternoon';
  return null;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  try {
    const businessDays = getNextBusinessDays(5);
    
    if (businessDays.length === 0) {
      return res.json({
        result: "We're closed this week. Can I get your number and call you back on Monday?",
        slots: []
      });
    }
    
    const startDate = businessDays[0].dateStr;
    const endDate = businessDays[businessDays.length - 1].dateStr;
    
    // Get real capacity from ServiceTitan
    const availabilities = await getCapacity(startDate, endDate);
    console.log(`[AVAILABILITY] Got ${availabilities.length} time slots from ServiceTitan`);
    
    // Group by date and filter to available slots
    const slotsByDate = {};
    
    for (const slot of availabilities) {
      if (!slot.isAvailable) continue;
      
      // Parse the local start time (not UTC)
      const startTime = new Date(slot.start);
      const dateStr = slot.start.split('T')[0];
      const hour = startTime.getUTCHours();
      
      const windowName = getWindowName(hour);
      if (!windowName) continue;
      
      if (!slotsByDate[dateStr]) {
        slotsByDate[dateStr] = new Set();
      }
      slotsByDate[dateStr].add(windowName);
    }
    
    // Build response matching business days
    const available = [];
    for (const day of businessDays) {
      const windows = slotsByDate[day.dateStr];
      if (windows && windows.size > 0) {
        available.push({
          day: day.dayName,
          date: day.dateStr,
          windows: Array.from(windows)
        });
      }
    }
    
    if (available.length === 0) {
      return res.json({
        result: "We're all booked up this week. Can I take your number and have someone call you when we have an opening?",
        slots: []
      });
    }
    
    // Format for Sarah
    const firstThree = available.slice(0, 3);
    const slotText = firstThree.map(day => {
      const windowList = day.windows.join(', ');
      return `${day.day} - ${windowList}`;
    }).join('. ');
    
    return res.json({
      result: `I've got ${slotText}. What works best for you?`,
      slots: available
    });
    
  } catch (error) {
    console.error('[AVAILABILITY] Error:', error.message);
    return res.json({ 
      result: "We've got morning, midday, and afternoon slots available this week. What works best?",
      error: error.message
    });
  }
};
