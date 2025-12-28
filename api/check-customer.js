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
  const url = `https://api.servicetitan.io/crm/v2/tenant/${CONFIG.ST_TENANT_ID}/customers?phone=${cleanPhone}&pageSize=10`;
  
  console.log('[CHECK-CUSTOMER] URL:', url);
  
  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'ST-App-Key': CONFIG.ST_APP_KEY
    }
  });
  
  const data = await response.json();
  
  // Return raw for debugging
  return { raw: data, count: (data.data || []).length };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  try {
    let phone = req.body?.phone;
    const debug = req.body?.debug === true;
    
    if (!phone) {
      return res.json({ result: "What's a good callback number for you?", need_phone: true });
    }
    
    const cleanPhone = String(phone).replace(/\D/g, '');
    const normalizedPhone = cleanPhone.length === 11 && cleanPhone.startsWith('1') 
      ? cleanPhone.slice(1) : cleanPhone;
    
    if (normalizedPhone.length !== 10) {
      return res.json({ result: "Can you give me the full number with area code?", need_phone: true });
    }
    
    const lookup = await lookupCustomer(normalizedPhone);
    
    if (debug) {
      return res.json({ 
        searched_phone: normalizedPhone,
        results_count: lookup.count,
        raw_response: lookup.raw
      });
    }
    
    // Normal flow
    if (lookup.raw.data && lookup.raw.data.length > 0) {
      const customer = lookup.raw.data[0];
      const address = customer.address || {};
      return res.json({
        result: "Got it.",
        found: true,
        customer_id: customer.id,
        customer_name: customer.name,
        street: address.street || '',
        city: address.city || '',
        state: address.state || '',
        zip: address.zip || ''
      });
    }
    
    return res.json({ result: "Got it.", found: false, customer_id: null });
    
  } catch (error) {
    console.error('[CHECK-CUSTOMER] Error:', error.message);
    return res.json({ result: "Got it.", error: error.message });
  }
};
