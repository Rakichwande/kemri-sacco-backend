require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');

const pool = require('./config/database');
const Member = require('./models/Member');
const Payment = require('./models/Payment');

const memberRoutes = require('./routes/members');
const paymentRoutes = require('./routes/payments');
const darajaWebhook = require('./webhooks/darajaWebhook');
const errorHandler = require('./middleware/errorHandler');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());

// Routes
app.use('/api/members', memberRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/webhooks', darajaWebhook);

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.use(errorHandler);

async function start() {
  try {
    // Creates tables if they don't exist yet - fine for now, move to a proper
    // migration tool (e.g. node-pg-migrate) once the schema starts changing often
    await Member.init();
    await Payment.init();

    app.listen(PORT, () => {
      console.log(`KEMRI SACCO backend running on port ${PORT}`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();
