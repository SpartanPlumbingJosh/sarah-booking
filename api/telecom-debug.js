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
    const phone = (req.query.phone || '9378067545').replace(/\D/g, '');
    
    // Query telecom API for calls from this number
    const response = await fetch(
      `https://api.servicetitan.io/telecom/v2/tenant/${CONFIG.ST_TENANT_ID}/calls?from=${phone}&sort=-CreatedOn&pageSize=10`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'ST-App-Key': CONFIG.ST_APP_KEY
        }
      }
    );
    
    const data = await response.json();
    
    const calls = (data.data || []).map(c => ({
      id: c.id,
      createdOn: c.createdOn,
      from: c.from,
      to: c.to,
      duration: c.duration,
      direction: c.direction,
      campaignId: c.campaign?.id || null,
      campaignName: c.campaign?.name || null,
      status: c.status
    }));
    
    return res.json({
      searchPhone: phone,
      totalCalls: data.data?.length || 0,
      calls: calls,
      rawFirst: data.data?.[0] || null
    });
  } catch (error) {
    return res.status(500).json({ error: error.message, stack: error.stack });
  }
};
