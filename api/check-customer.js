const fetch = require('node-fetch');

const CONFIG = {
  ST_CLIENT_ID: process.env.ST_CLIENT_ID,
  ST_CLIENT_SECRET: process.env.ST_CLIENT_SECRET,
  ST_TENANT_ID: process.env.ST_TENANT_ID,
  ST_APP_KEY: process.env.ST_APP_KEY
};

// Simple in-memory cache for caller lookups (keyed by phone)
const lookupCache = new Map();

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
  // Check cache first
  if (lookupCache.has(cleanPhone)) {
    console.log(`[CHECK-CUSTOMER] Cache hit for ${cleanPhone}`);
    return lookupCache.get(cleanPhone);
  }
  
  const token = await getAccessToken();
  const response = await fetch(
    `https://api.servicetitan.io/crm/v2/tenant/${CONFIG.ST_TENANT_ID}/customers?phoneNumber=${cleanPhone}&pageSize=5`,
    {
      headers: {
        'Authorization': `Bearer ${token}`,
        'ST-App-Key': CONFIG.ST_APP_KEY
      }
    }
  );
  
  const data = await response.json();
  
  let result;
  if (data.data && data.data.length > 0) {
    const customer = data.data[0];
    const address = customer.address || {};
    result = {
      found: true,
      customer_id: customer.id,
      customer_name: customer.name,
      street: address.street || '',
      city: address.city || '',
      state: address.state || '',
      zip: address.zip || ''
    };
  } else {
    result = { found: false, customer_id: null };
  }
  
  // Cache for 5 minutes
  lookupCache.set(cleanPhone, result);
  setTimeout(() => lookupCache.delete(cleanPhone), 5 * 60 * 1000);
  
  return result;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  try {
    // Log full request to see what Retell sends
    console.log('[CHECK-CUSTOMER] Headers:', JSON.stringify(req.headers));
    console.log('[CHECK-CUSTOMER] Body:', JSON.stringify(req.body));
    
    // Try to get phone from multiple sources
    let phone = req.body?.phone;
    
    // If phone looks like a template variable that wasn't substituted, ignore it
    if (phone && phone.includes('{{')) {
      console.log('[CHECK-CUSTOMER] Template variable not substituted:', phone);
      phone = null;
    }
    
    // Try to get from Retell call context if available
    if (!phone && req.body?.call?.from_number) {
      phone = req.body.call.from_number;
    }
    if (!phone && req.body?.from_number) {
      phone = req.body.from_number;
    }
    if (!phone && req.body?.retell_llm_dynamic_variables?.['from-number']) {
      phone = req.body.retell_llm_dynamic_variables['from-number'];
    }
    
    if (!phone) {
      return res.json({ 
        result: "What's a good callback number for you?",
        need_phone: true
      });
    }
    
    const cleanPhone = String(phone).replace(/\D/g, '');
    
    // Handle 11-digit numbers starting with 1
    const normalizedPhone = cleanPhone.length === 11 && cleanPhone.startsWith('1') 
      ? cleanPhone.slice(1) 
      : cleanPhone;
    
    if (normalizedPhone.length !== 10) {
      return res.json({ 
        result: "Can you give me the full number with area code?",
        need_phone: true
      });
    }
    
    const lookup = await lookupCustomer(normalizedPhone);
    
    if (lookup.found) {
      // Don't reveal we found them yet - let Sarah ask "have you used us before?" first
      // Just return the data so she has it ready
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
