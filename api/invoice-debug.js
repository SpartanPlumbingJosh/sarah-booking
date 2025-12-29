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

async function stApi(method, endpoint, body = null) {
  const token = await getAccessToken();
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'ST-App-Key': CONFIG.ST_APP_KEY,
      'Content-Type': 'application/json'
    }
  };
  if (body) opts.body = JSON.stringify(body);
  
  const response = await fetch(`https://api.servicetitan.io${endpoint}`, opts);
  const text = await response.text();
  
  return {
    status: response.status,
    data: text ? JSON.parse(text) : null
  };
}

module.exports = async (req, res) => {
  try {
    const jobId = req.query.jobId;
    if (!jobId) {
      return res.status(400).json({ error: 'jobId required' });
    }
    
    // Get invoices for this job
    const invoices = await stApi('GET', `/accounting/v2/tenant/${CONFIG.ST_TENANT_ID}/invoices?jobId=${jobId}`);
    
    // Try to add a service item if invoice exists
    let addResult = null;
    if (invoices.data && invoices.data.data && invoices.data.data.length > 0) {
      const invoiceId = invoices.data.data[0].id;
      
      // Try PATCH with all required fields
      addResult = await stApi('PATCH', `/accounting/v2/tenant/${CONFIG.ST_TENANT_ID}/invoices/${invoiceId}/items`, {
        skuId: 43942323,
        skuName: '$79 Standard Service Call',
        description: 'Includes travel and on-site labor for diagnosing and addressing minor plumbing issues.',
        quantity: 1,
        unitPrice: 79,
        cost: 0,
        isAddOn: false
      });
    }
    
    return res.json({
      jobId,
      invoiceId: invoices.data?.data?.[0]?.id,
      addItemResult: addResult
    });
  } catch (error) {
    return res.status(500).json({ error: error.message, stack: error.stack });
  }
};
