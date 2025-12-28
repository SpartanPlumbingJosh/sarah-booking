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
    ? cleanPhone.slice(1) 
    : cleanPhone;
  
  if (normalizedPhone.length !== 10) {
    return null;
  }
  
  try {
    const token = await getAccessToken();
    const response = await fetch(
      `https://api.servicetitan.io/crm/v2/tenant/${CONFIG.ST_TENANT_ID}/customers?phoneNumber=${normalizedPhone}&pageSize=5`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'ST-App-Key': CONFIG.ST_APP_KEY
        }
      }
    );
    
    const data = await response.json();
    
    if (data.data && data.data.length > 0) {
      const customer = data.data[0];
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
    console.error('[INBOUND] Lookup error:', error.message);
    return { is_existing_customer: 'false' };
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  try {
    console.log('[INBOUND] Webhook received:', JSON.stringify(req.body));
    
    const { event, call_inbound } = req.body;
    
    if (event !== 'call_inbound' || !call_inbound) {
      return res.status(200).json({});
    }
    
    const fromNumber = call_inbound.from_number;
    console.log('[INBOUND] Looking up:', fromNumber);
    
    // Lookup customer in ServiceTitan
    const customerData = await lookupCustomer(fromNumber);
    console.log('[INBOUND] Customer data:', JSON.stringify(customerData));
    
    // Return dynamic variables for Sarah to use
    // These become available as {{customer_name}}, {{customer_street}}, etc.
    return res.status(200).json({
      call_inbound: {
        dynamic_variables: customerData || { is_existing_customer: 'false' }
      }
    });
    
  } catch (error) {
    console.error('[INBOUND] Error:', error.message);
    // Return empty response so call still connects
    return res.status(200).json({});
  }
};
