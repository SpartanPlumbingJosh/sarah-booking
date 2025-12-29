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
    
    // Get ALL services (paginate if needed)
    let allServices = [];
    let page = 1;
    let hasMore = true;
    
    while (hasMore && page <= 10) {
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
    
    // Filter if search provided
    let services = allServices;
    if (search) {
      services = allServices.filter(s => 
        (s.name || '').toLowerCase().includes(search) || 
        (s.code || '').toLowerCase().includes(search)
      );
    }
    
    // Map to simple format
    const result = services.map(s => ({
      id: s.id,
      code: s.code,
      name: s.name,
      price: s.price,
      active: s.active
    }));
    
    return res.json({
      search: search || '(all)',
      totalInPricebook: allServices.length,
      matchingServices: result.length,
      services: result.slice(0, 50)
    });
  } catch (error) {
    return res.status(500).json({ error: error.message, stack: error.stack });
  }
};
