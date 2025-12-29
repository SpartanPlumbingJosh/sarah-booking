const express = require('express');
const app = express();

app.use(express.json());

// Import handlers
const checkCustomer = require('./api/check-customer');
const checkAvailability = require('./api/check-availability');
const bookAppointment = require('./api/book-appointment');
const postCall = require('./api/post-call');
const inboundWebhook = require('./api/inbound-webhook');
const health = require('./api/health');
const stConfig = require('./api/st-config');
const capacityDebug = require('./api/capacity-debug');
const capacityMonday = require('./api/capacity-monday');
const campaignDebug = require('./api/campaign-debug');
const telecomDebug = require('./api/telecom-debug');
const pricebookDebug = require('./api/pricebook-debug');

// Wrap Vercel handlers for Express
const wrap = (handler) => async (req, res) => {
  try {
    await handler(req, res);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

// Routes
app.all('/api/check-customer', wrap(checkCustomer));
app.all('/api/check-availability', wrap(checkAvailability));
app.all('/api/book-appointment', wrap(bookAppointment));
app.all('/api/post-call', wrap(postCall));
app.all('/api/inbound-webhook', wrap(inboundWebhook));
app.all('/api/health', wrap(health));
app.get('/health', wrap(health));
app.all('/api/st-config', wrap(stConfig));
app.all('/api/capacity-debug', wrap(capacityDebug));
app.all('/api/capacity-monday', wrap(capacityMonday));
app.all('/api/campaign-debug', wrap(campaignDebug));
app.all('/api/telecom-debug', wrap(telecomDebug));
app.all('/api/pricebook-debug', wrap(pricebookDebug));
app.get('/', (req, res) => res.json({ status: 'ok', service: 'sarah-booking' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on port ${PORT}`));



