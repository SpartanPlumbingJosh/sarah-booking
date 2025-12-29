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
    const phone = req.query.phone || '9378843414';
    
    // Get all campaigns
    const allResponse = await fetch(
      `https://api.servicetitan.io/marketing/v2/tenant/${CONFIG.ST_TENANT_ID}/campaigns?pageSize=100`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'ST-App-Key': CONFIG.ST_APP_KEY
        }
      }
    );
    const allData = await allResponse.json();
    
    // Find campaigns with phone numbers
    const withPhones = (allData.data || []).filter(c => 
      c.phoneNumber || c.trackingPhoneNumber || c.number
    ).map(c => ({
      id: c.id,
      name: c.name,
      phoneNumber: c.phoneNumber,
      trackingPhoneNumber: c.trackingPhoneNumber,
      number: c.number,
      allKeys: Object.keys(c)
    }));
    
    // Try the specific search
    const searchResponse = await fetch(
      `https://api.servicetitan.io/marketing/v2/tenant/${CONFIG.ST_TENANT_ID}/campaigns?campaignPhoneNumber=${phone}&pageSize=5`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'ST-App-Key': CONFIG.ST_APP_KEY
        }
      }
    );
    const searchData = await searchResponse.json();
    
    return res.json({
      totalCampaigns: allData.data?.length || 0,
      campaignsWithPhones: withPhones,
      searchFor: phone,
      searchResults: searchData.data || [],
      sampleCampaign: allData.data?.[0] || null
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};
