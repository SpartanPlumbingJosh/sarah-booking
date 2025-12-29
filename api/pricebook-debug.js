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

module.exports = async (req, res) => {
  try {
    const token = await getAccessToken();
    const search = req.query.search || 'dispatch';
    
    // Search pricebook services
    const response = await fetch(
      `https://api.servicetitan.io/pricebook/v2/tenant/${CONFIG.ST_TENANT_ID}/services?active=True&pageSize=50`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'ST-App-Key': CONFIG.ST_APP_KEY
        }
      }
    );
    
    const data = await response.json();
    
    // Filter services matching search term
    const services = (data.data || [])
      .filter(s => s.name.toLowerCase().includes(search.toLowerCase()) || s.code.toLowerCase().includes(search.toLowerCase()))
      .map(s => ({
        id: s.id,
        code: s.code,
        name: s.name,
        price: s.price
      }));
    
    return res.json({
      search: search,
      total: services.length,
      services: services
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};
