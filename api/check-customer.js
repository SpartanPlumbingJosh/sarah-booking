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

async function lookupCustomer(cleanPhone) {
  const token = await getAccessToken();
  const url = `https://api.servicetitan.io/crm/v2/tenant/${CONFIG.ST_TENANT_ID}/customers?phoneNumber=${cleanPhone}&pageSize=5`;
  
  console.log('[CHECK-CUSTOMER] Calling ST API:', url);
  
  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'ST-App-Key': CONFIG.ST_APP_KEY
    }
  });
  
  const data = await response.json();
  console.log('[CHECK-CUSTOMER] ST API response:', JSON.stringify(data));
  
  if (data.data && data.data.length > 0) {
    const customer = data.data[0];
    const address = customer.address || {};
    return {
      found: true,
      customer_id: customer.id,
      customer_name: customer.name,
      street: address.street || '',
      city: address.city || '',
      state: address.state || '',
      zip: address.zip || ''
    };
  }
  
  return { found: false, customer_id: null };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  try {
    console.log('[CHECK-CUSTOMER] Request body:', JSON.stringify(req.body));
    
    let phone = req.body?.phone;
    
    if (phone && phone.includes('{{')) {
      console.log('[CHECK-CUSTOMER] Template variable not substituted:', phone);
      phone = null;
    }
    
    if (!phone && req.body?.call?.from_number) {
      phone = req.body.call.from_number;
    }
    if (!phone && req.body?.from_number) {
      phone = req.body.from_number;
    }
    
    if (!phone) {
      return res.json({ 
        result: "What's a good callback number for you?",
        need_phone: true
      });
    }
    
    const cleanPhone = String(phone).replace(/\D/g, '');
    const normalizedPhone = cleanPhone.length === 11 && cleanPhone.startsWith('1') 
      ? cleanPhone.slice(1) 
      : cleanPhone;
    
    console.log('[CHECK-CUSTOMER] Normalized phone:', normalizedPhone);
    
    if (normalizedPhone.length !== 10) {
      return res.json({ 
        result: "Can you give me the full number with area code?",
        need_phone: true
      });
    }
    
    const lookup = await lookupCustomer(normalizedPhone);
    
    if (lookup.found) {
      return res.json({
        result: "Got it.",
        found: true,
        customer_id: lookup.customer_id,
        customer_name: lookup.customer_name,
        street: lookup.street,
        city: lookup.city,
        state: lookup.state,
        zip: lookup.zip
      });
    }
    
    return res.json({ 
      result: "Got it.",
      found: false,
      customer_id: null 
    });
    
  } catch (error) {
    console.error('[CHECK-CUSTOMER] Error:', error.message);
    return res.json({ 
      result: "Got it.",
      error: error.message
    });
  }
};
