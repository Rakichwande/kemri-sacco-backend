require('dotenv').config();
require('./config/env'); // fails fast if JWT_SECRET/DATABASE_URL/AT_USSD_SHARED_SECRET are missing or unsafe
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');

// ------------------------------------------------------------
// Last-resort safety net for unhandled promise rejections.
//
// The 2026-09-24 crash was a concrete case of this class of bug:
// smsService.sendSMS threw on a per-recipient delivery failure
// (UserInBlacklist), a fire-and-forget caller never caught it, and Node
// killed the entire process - taking USSD and the admin portal offline
// for every other member because one phone was on Safaricom's DND list.
//
// That specific bug is fixed at the source (smsService now returns
// { sent, reason } instead of throwing). This handler is defence in
// depth: any future bug of the same shape - an un-awaited promise, a
// missed .catch(), a third-party library that rejects unexpectedly -
// logs loudly but keeps the server alive, so a peripheral failure never
// becomes a systemic outage.
//
// Systemic failures (missing config, DB unreachable at boot) still exit
// cleanly at their point of origin - see config/env.js and the start()
// try/catch below. This handler is deliberately scoped to the "one
// thing failed" class, not the "everything is broken" class.
// ------------------------------------------------------------
process.on('unhandledRejection', (reason) => {
  console.error('⚠️  Unhandled promise rejection (server staying alive):', reason);
});

const pool = require('./config/database');
const Member = require('./models/Member');
const Payment = require('./models/Payment');
const Loan = require('./models/Loan');
const Repayment = require('./models/Repayment');
const Withdrawal = require('./models/Withdrawal');
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

// Render's edge sits behind Cloudflare plus an internal LB plus a local
// proxy - four hops total (confirmed via /debug/ip: socket ::1, XFF =
// "client, cloudflare, render-lb"). The original `1` walked back only one
// hop and resolved req.ip to 10.192.163.192 for every client, which made
// every rate limiter a global (not per-client) counter. `true` takes the
// leftmost XFF value as the real client, and is safe here because the
// container is not directly reachable - all inbound traffic goes through
// Render's edge.
app.set('trust proxy', true);

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

// ----- WITHDRAWAL ROUTES (NEW) -----
app.use('/api/withdrawals', require('./routes/withdrawals'));

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

    // Capture the server instance so listen-time errors (EADDRINUSE during
    // a rolling deploy, EACCES if the port is privileged, etc.) can be
    // logged with a clear message instead of crashing as an unhandled
    // 'error' event. EADDRINUSE during a Render deploy is expected and
    // benign - the old instance may still be shutting down - so this logs
    // and exits cleanly for Render to reconcile, rather than throwing a
    // stack trace that reads like an application bug.
    const server = app.listen(PORT, () => {
      console.log(`KEMRI SACCO backend running on port ${PORT}`);
    });

    server.on('error', (err) => {
      console.error(`Server failed to listen on port ${PORT}:`, err.message);
      process.exit(1);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();