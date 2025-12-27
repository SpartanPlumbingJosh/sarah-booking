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

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  try {
    const { phone } = req.body;
    
    if (!phone) {
      return res.json({ result: "I need the phone number to look you up." });
    }
    
    const cleanPhone = String(phone).replace(/\D/g, '');
    if (cleanPhone.length !== 10) {
      return res.json({ result: "I need the full 10-digit phone number with area code." });
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
    
    if (data.data && data.data.length > 0) {
      const customer = data.data[0];
      return res.json({
        result: `Found you! ${customer.name}. Is that right?`,
        customer_id: customer.id,
        customer_name: customer.name,
        address: customer.address
      });
    }
    
    return res.json({ 
      result: "I don't see that number in our system. No problem, I'll get you set up.",
      customer_id: null 
    });
    
  } catch (error) {
    console.error('[CHECK-CUSTOMER] Error:', error.message);
    return res.json({ result: "Let me get your info to set you up in our system." });
  }
};
