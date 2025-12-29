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
    const search = (req.query.search || '').toLowerCase();
    
    // Get services with dispatch fee checkbox checked
    const response = await fetch(
      `https://api.servicetitan.io/pricebook/v2/tenant/${CONFIG.ST_TENANT_ID}/services?active=Any&pageSize=200`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'ST-App-Key': CONFIG.ST_APP_KEY
        }
      }
    );
    
    const data = await response.json();
    
    // Return first few raw services to see structure
    const rawSample = (data.data || []).slice(0, 3);
    
    // Filter for dispatch-related
    const dispatchServices = (data.data || []).filter(s => 
      s.isDispatchFee === true ||
      (s.code && s.code.toLowerCase().includes('dispatch')) ||
      (s.name && s.name.toLowerCase().includes('dispatch')) ||
      (s.code && s.code.includes('$0')) ||
      (s.code && s.code.includes('$79'))
    );
    
    return res.json({
      totalReturned: (data.data || []).length,
      hasMore: data.hasMore,
      rawSampleKeys: rawSample.length > 0 ? Object.keys(rawSample[0]) : [],
      rawSample: rawSample,
      dispatchServices: dispatchServices.map(s => ({
        id: s.id,
        code: s.code,
        name: s.name,
        price: s.price,
        active: s.active,
        isDispatchFee: s.isDispatchFee
      }))
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};
