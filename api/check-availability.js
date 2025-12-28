const fetch = require('node-fetch');

const CONFIG = {
  ST_CLIENT_ID: process.env.ST_CLIENT_ID,
  ST_CLIENT_SECRET: process.env.ST_CLIENT_SECRET,
  ST_TENANT_ID: process.env.ST_TENANT_ID,
  ST_APP_KEY: process.env.ST_APP_KEY,
  // Max appointments per time window (adjust based on tech count)
  MAX_APPOINTMENTS_PER_WINDOW: parseInt(process.env.MAX_APPOINTMENTS_PER_WINDOW || '4'),
  // Business hours in Eastern time
  BUSINESS_START_HOUR: 8,  // 8 AM Eastern
  BUSINESS_END_HOUR: 17    // 5 PM Eastern
};

// Time windows in Eastern hours
const TIME_WINDOWS = [
  { name: 'morning', label: 'morning (8-11 AM)', startHour: 8, endHour: 11 },
  { name: 'midday', label: 'midday (11 AM-2 PM)', startHour: 11, endHour: 14 },
  { name: 'afternoon', label: 'afternoon (2-5 PM)', startHour: 14, endHour: 17 }
];

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

// Check if date is in DST (March 2nd Sunday to November 1st Sunday)
function isDSTinEffect(year, month, day) {
  const date = new Date(year, month - 1, day);
  const jan = new Date(year, 0, 1);
  const jul = new Date(year, 6, 1);
  const stdOffset = Math.max(jan.getTimezoneOffset(), jul.getTimezoneOffset());
  return date.getTimezoneOffset() < stdOffset;
}

// Convert Eastern hour to UTC hour for a given date
function easternHourToUTC(year, month, day, easternHour) {
  const isDST = isDSTinEffect(year, month, day);
  const offset = isDST ? 4 : 5; // EDT = UTC-4, EST = UTC-5
  let utcHour = easternHour + offset;
  let utcDay = day;
  let utcMonth = month;
  let utcYear = year;
  
  if (utcHour >= 24) {
    utcHour -= 24;
    utcDay += 1;
    // Handle month rollover
    const daysInMonth = new Date(year, month, 0).getDate();
    if (utcDay > daysInMonth) {
      utcDay = 1;
      utcMonth += 1;
      if (utcMonth > 12) {
        utcMonth = 1;
        utcYear += 1;
      }
    }
  }
  
  return { year: utcYear, month: utcMonth, day: utcDay, hour: utcHour };
}

// Get next N business days starting from tomorrow
function getNextBusinessDays(count) {
  const days = [];
  const today = new Date();
  let checkDate = new Date(today);
  checkDate.setDate(checkDate.getDate() + 1); // Start tomorrow
  
  while (days.length < count) {
    const dayOfWeek = checkDate.getDay();
    if (dayOfWeek !== 0 && dayOfWeek !== 6) { // Skip weekends
      days.push({
        year: checkDate.getFullYear(),
        month: checkDate.getMonth() + 1,
        day: checkDate.getDate(),
        dayName: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][dayOfWeek],
        dateStr: checkDate.toISOString().split('T')[0]
      });
    }
    checkDate.setDate(checkDate.getDate() + 1);
  }
  
  return days;
}

// Get appointments for a date range from ServiceTitan
async function getAppointments(startDate, endDate) {
  const token = await getAccessToken();
  
  const url = `https://api.servicetitan.io/jpm/v2/tenant/${CONFIG.ST_TENANT_ID}/appointments?startsOnOrAfter=${startDate}T00:00:00Z&startsBefore=${endDate}T23:59:59Z&pageSize=200`;
  
  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'ST-App-Key': CONFIG.ST_APP_KEY
    }
  });
  
  const data = await response.json();
  return data.data || [];
}

// Count appointments in each time window for each day
function countAppointmentsByWindow(appointments, businessDays) {
  const counts = {};
  
  // Initialize counts
  for (const day of businessDays) {
    counts[day.dateStr] = {};
    for (const window of TIME_WINDOWS) {
      counts[day.dateStr][window.name] = 0;
    }
  }
  
  // Count appointments
  for (const apt of appointments) {
    if (apt.status === 'Canceled' || !apt.active) continue;
    
    const startTime = new Date(apt.start);
    const dateStr = startTime.toISOString().split('T')[0];
    
    if (!counts[dateStr]) continue;
    
    // Get the Eastern hour from UTC
    const utcHour = startTime.getUTCHours();
    const year = startTime.getUTCFullYear();
    const month = startTime.getUTCMonth() + 1;
    const day = startTime.getUTCDate();
    const isDST = isDSTinEffect(year, month, day);
    const offset = isDST ? 4 : 5;
    const easternHour = utcHour - offset + (utcHour < offset ? 24 : 0);
    
    // Find which window this appointment is in
    for (const window of TIME_WINDOWS) {
      if (easternHour >= window.startHour && easternHour < window.endHour) {
        counts[dateStr][window.name]++;
        break;
      }
    }
  }
  
  return counts;
}

// Build availability response
function buildAvailability(businessDays, appointmentCounts) {
  const maxPerWindow = CONFIG.MAX_APPOINTMENTS_PER_WINDOW;
  const available = [];
  
  for (const day of businessDays) {
    const dayAvailability = {
      day: day.dayName,
      date: day.dateStr,
      windows: []
    };
    
    for (const window of TIME_WINDOWS) {
      const booked = appointmentCounts[day.dateStr]?.[window.name] || 0;
      const remaining = maxPerWindow - booked;
      
      if (remaining > 0) {
        dayAvailability.windows.push({
          name: window.name,
          label: window.label,
          spotsRemaining: remaining,
          // Include UTC times for booking
          utcStart: easternHourToUTC(day.year, day.month, day.day, window.startHour),
          utcEnd: easternHourToUTC(day.year, day.month, day.day, window.endHour)
        });
      }
    }
    
    if (dayAvailability.windows.length > 0) {
      available.push(dayAvailability);
    }
  }
  
  return available;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  try {
    // Get next 5 business days
    const businessDays = getNextBusinessDays(5);
    
    if (businessDays.length === 0) {
      return res.json({
        result: "We're closed this week. Can I get your number and call you back on Monday?",
        slots: []
      });
    }
    
    // Get date range for API query
    const startDate = businessDays[0].dateStr;
    const endDate = businessDays[businessDays.length - 1].dateStr;
    
    // Fetch appointments from ServiceTitan
    const appointments = await getAppointments(startDate, endDate);
    console.log(`[AVAILABILITY] Found ${appointments.length} appointments between ${startDate} and ${endDate}`);
    
    // Count appointments by window
    const appointmentCounts = countAppointmentsByWindow(appointments, businessDays);
    
    // Build availability
    const available = buildAvailability(businessDays, appointmentCounts);
    
    if (available.length === 0) {
      return res.json({
        result: "We're all booked up this week. Can I take your number and have someone call you when we have an opening?",
        slots: []
      });
    }
    
    // Format response for Sarah to read
    const firstThreeDays = available.slice(0, 3);
    const slotText = firstThreeDays.map(day => {
      const windowNames = day.windows.map(w => w.name).join(', ');
      return `${day.day} - ${windowNames}`;
    }).join('. ');
    
    return res.json({
      result: `I've got ${slotText}. What works best for you?`,
      slots: available
    });
    
  } catch (error) {
    console.error('[AVAILABILITY] Error:', error.message);
    // Fallback to generic availability
    return res.json({ 
      result: "We've got morning, midday, and afternoon slots available this week. What works best for you?",
      error: error.message
    });
  }
};
