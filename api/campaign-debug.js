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
    
    // Get ALL campaigns with their phone numbers
    const allResponse = await fetch(
      `https://api.servicetitan.io/marketing/v2/tenant/${CONFIG.ST_TENANT_ID}/campaigns?pageSize=200&active=Any`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'ST-App-Key': CONFIG.ST_APP_KEY
        }
      }
    );
    const allData = await allResponse.json();
    
    // Extract campaigns with phone numbers
    const campaignsWithPhones = (allData.data || [])
      .filter(c => c.campaignPhoneNumbers && c.campaignPhoneNumbers.length > 0)
      .map(c => ({
        id: c.id,
        name: c.name,
        active: c.active,
        phoneNumbers: c.campaignPhoneNumbers
      }));
    
    // Try to find campaign matching our phone
    const phoneDigits = phone.replace(/\D/g, '');
    const matchingCampaign = campaignsWithPhones.find(c => 
      c.phoneNumbers.some(p => p.replace(/\D/g, '').includes(phoneDigits) || phoneDigits.includes(p.replace(/\D/g, '')))
    );
    
    // Try API search with different formats
    const formats = [
      phone,
      phoneDigits,
      `+1${phoneDigits}`,
      phoneDigits.slice(-10)
    ];
    
    const searchResults = {};
    for (const fmt of formats) {
      const searchResponse = await fetch(
        `https://api.servicetitan.io/marketing/v2/tenant/${CONFIG.ST_TENANT_ID}/campaigns?campaignPhoneNumber=${encodeURIComponent(fmt)}&pageSize=5`,
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'ST-App-Key': CONFIG.ST_APP_KEY
          }
        }
      );
      const searchData = await searchResponse.json();
      searchResults[fmt] = searchData.data?.length || 0;
    }
    
    return res.json({
      searchPhone: phone,
      phoneDigits: phoneDigits,
      totalCampaigns: allData.data?.length || 0,
      campaignsWithPhones: campaignsWithPhones,
      matchingCampaign: matchingCampaign || null,
      apiSearchResults: searchResults
    });
  } catch (error) {
    return res.status(500).json({ error: error.message, stack: error.stack });
  }
};
