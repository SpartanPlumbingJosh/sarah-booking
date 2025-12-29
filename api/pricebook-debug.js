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
    
    // Paginate through ALL services
    let allServices = [];
    let page = 1;
    let hasMore = true;
    
    while (hasMore && page <= 20) {
      const response = await fetch(
        `https://api.servicetitan.io/pricebook/v2/tenant/${CONFIG.ST_TENANT_ID}/services?active=Any&pageSize=200&page=${page}`,
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'ST-App-Key': CONFIG.ST_APP_KEY
          }
        }
      );
      
      const data = await response.json();
      if (data.data && data.data.length > 0) {
        allServices = allServices.concat(data.data);
        hasMore = data.hasMore;
        page++;
      } else {
        hasMore = false;
      }
    }
    
    // Find dispatch services (code starting with $ or displayName containing dispatch)
    const dispatchServices = allServices.filter(s => {
      const code = (s.code || '').toLowerCase();
      const name = (s.displayName || '').toLowerCase();
      return code.startsWith('$') || 
             name.includes('dispatch') || 
             name.includes('service call') ||
             code.includes('dispatch');
    });
    
    return res.json({
      totalServices: allServices.length,
      dispatchServices: dispatchServices.map(s => ({
        id: s.id,
        code: s.code,
        displayName: s.displayName,
        price: s.price,
        active: s.active
      }))
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};
