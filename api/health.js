module.exports = async (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'sarah-tools-v2',
    tenant: process.env.ST_TENANT_ID ? 'configured' : 'missing'
  });
};
