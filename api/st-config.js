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

async function stApi(endpoint) {
  const token = await getAccessToken();
  const response = await fetch(`https://api.servicetitan.io${endpoint}`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'ST-App-Key': CONFIG.ST_APP_KEY
    }
  });
  return response.json();
}

module.exports = async (req, res) => {
  try {
    const [businessUnits, jobTypes] = await Promise.all([
      stApi(`/settings/v2/tenant/${CONFIG.ST_TENANT_ID}/business-units`),
      stApi(`/jpm/v2/tenant/${CONFIG.ST_TENANT_ID}/job-types`)
    ]);
    
    const activeBusinessUnits = (businessUnits.data || [])
      .filter(bu => bu.active)
      .map(bu => ({ id: bu.id, name: bu.name }));
    
    const activeJobTypes = (jobTypes.data || [])
      .filter(jt => jt.active)
      .map(jt => ({ id: jt.id, name: jt.name, businessUnitId: jt.businessUnitId }));
    
    return res.status(200).json({
      businessUnits: activeBusinessUnits,
      jobTypes: activeJobTypes
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};
