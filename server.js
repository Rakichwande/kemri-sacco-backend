require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');

const pool = require('./config/database');
const Member = require('./models/Member');
const Payment = require('./models/Payment');
const Loan = require('./models/Loan');

const memberRoutes = require('./routes/members');
const paymentRoutes = require('./routes/payments');
const darajaWebhook = require('./webhooks/darajaWebhook');
const errorHandler = require('./middleware/errorHandler');
const ussdRoutes = require('./routes/ussd');

// ============================================================
// IMPORTANT: Define `app` BEFORE using it!
// ============================================================
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Routes
app.use('/api/members', memberRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/webhooks', darajaWebhook);
app.use('/ussd', ussdRoutes);

// ----- LOAN ROUTES (NEW) -----
const loanRoutes = require('./routes/loans');
app.use('/api/loans', loanRoutes);   // <-- Now placed after app is defined

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Error handler (should be last)
app.use(errorHandler);

async function start() {
  try {
    // Creates tables if they don't exist yet
    await Member.init();
    await Payment.init();
    await Loan.init();

    app.listen(PORT, () => {
      console.log(`KEMRI SACCO backend running on port ${PORT}`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();