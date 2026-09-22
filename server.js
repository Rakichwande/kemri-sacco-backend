require('dotenv').config();
require('./config/env'); // fails fast if JWT_SECRET/DATABASE_URL/AT_USSD_SHARED_SECRET are missing or unsafe
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');

const pool = require('./config/database');
const Member = require('./models/Member');
const Payment = require('./models/Payment');
const Loan = require('./models/Loan');
const Repayment = require('./models/Repayment');
// Add these lines
const authRoutes = require('./routes/auth');
const Admin = require('./models/Admin');

const memberRoutes = require('./routes/members');
const paymentRoutes = require('./routes/payments');
const darajaWebhook = require('./webhooks/darajaWebhook');
const errorHandler = require('./middleware/errorHandler');
const ussdRoutes = require('./routes/ussd');
const AuditLog = require('./models/AuditLog');
const auditLogRoutes = require('./routes/auditLog');
const dashboardRoutes = require('./routes/dashboard');
const UssdSession = require('./models/UssdSession');
const StaffInvite = require('./models/StaffInvite');

// ============================================================
// IMPORTANT: Define `app` BEFORE using it!
// ============================================================
const app = express();
app.set('trust proxy', 1); // Render sits behind a proxy; required for express-rate-limit
                            // and for req.ip to resolve the real client IP correctly
const PORT = process.env.PORT || 3000;

// Middleware
// CORS is restricted to an explicit allowlist rather than the previous bare
// cors() (which reflected Access-Control-Allow-Origin: * for every origin).
// ALLOWED_ORIGINS is a comma-separated list set in Render's environment,
// e.g. "https://kemri-sacco-portal.onrender.com,http://localhost:5173" -
// add a new origin there (no code change needed) rather than here.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    // Requests with no Origin header (server-to-server calls, curl, the
    // Daraja/AT webhooks) are allowed through unconditionally - this check
    // only governs browser cross-origin requests.
    if (!origin) return callback(null, true);

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    console.warn(`CORS: blocked request from unrecognized origin: ${origin}`);
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Routes
app.use('/api/members', memberRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/webhooks', darajaWebhook);
app.use('/ussd', ussdRoutes);
app.use('/api/auth', authRoutes);

// ----- LOAN ROUTES (NEW) -----
const loanRoutes = require('./routes/loans');
app.use('/api/loans', loanRoutes);   // <-- Now placed after app is defined
app.use('/api/audit-log', auditLogRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/repayments', require('./routes/repayments'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/system-health', require('./routes/systemHealth'));

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Error handler (should be last)
app.use(errorHandler);

async function start() {
  try {
    // Creates tables if they don't exist yet
    await Member.init();
    await Loan.init();
    await Payment.init();
    await Repayment.init();
    await Withdrawal.init();
    await UssdSession.init();
    await StaffInvite.init();
    await Admin.init();
    await AuditLog.init();

    app.listen(PORT, () => {
      console.log(`KEMRI SACCO backend running on port ${PORT}`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();