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

async function lookupCustomer(phone) {
  const cleanPhone = String(phone).replace(/\D/g, '');
  const normalizedPhone = cleanPhone.length === 11 && cleanPhone.startsWith('1') 
    ? cleanPhone.slice(1) : cleanPhone;
  
  if (normalizedPhone.length !== 10) {
    return { is_existing_customer: 'false' };
  }
  
  try {
    const token = await getAccessToken();
    // Use 'phone' parameter per ST API spec
    const response = await fetch(
      `https://api.servicetitan.io/crm/v2/tenant/${CONFIG.ST_TENANT_ID}/customers?phone=${normalizedPhone}&pageSize=5`,
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

function getNextBusinessDays(count) {
  const days = [];
  const today = new Date();
  let checkDate = new Date(today);
  checkDate.setDate(checkDate.getDate() + 1);
  
  while (days.length < count) {
    const dayOfWeek = checkDate.getDay();
    if (dayOfWeek !== 0 && dayOfWeek !== 6) {
      days.push({
        dayName: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][dayOfWeek],
        dateStr: checkDate.toISOString().split('T')[0]
      });
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
        available.push({
          day: day.dayName,
          date: day.dateStr,
          windows: Array.from(windows)
        });
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
    
    const dynamicVars = {
      ...(customerData || { is_existing_customer: 'false' }),
      ...availabilityData
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
