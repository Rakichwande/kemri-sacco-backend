require('dotenv').config();
require('./config/env'); // fails fast if JWT_SECRET/DATABASE_URL/AT_USSD_SHARED_SECRET are missing or unsafe
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');

// ------------------------------------------------------------
// Last-resort safety net for unhandled promise rejections.
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

app.set('trust proxy', true);

const PORT = process.env.PORT || 3000;

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, callback) {
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
app.use('/api/loans', loanRoutes);
app.use('/api/audit-log', auditLogRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/repayments', require('./routes/repayments'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/system-health', require('./routes/systemHealth'));
app.use('/api/income', require('./routes/income'));

// ----- WALLET ROUTES (NEW) -----
app.use('/api/wallet', require('./routes/wallet'));

app.use('/internal', require('./routes/internal'));

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Error handler (should be last)
app.use(errorHandler);

// ============================================================
// 2026-11-07: BACKGROUND SWEEPER FOR STUCK WALLET WITHDRAWALS
// ============================================================
async function sweepStuckWithdrawals() {
  try {
    // Find withdrawals older than 10 minutes that still have the 'WD-' reference.
    // If Safaricom was reached, the reference would have been replaced by the ConversationID.
    const res = await pool.query(`
      SELECT id, member_id, amount, wallet_type, reference 
      FROM wallet_transactions 
      WHERE transaction_type = 'withdrawal' 
        AND reference LIKE 'WD-%' 
        AND created_at < NOW() - INTERVAL '10 minutes'
    `);

    if (res.rows.length === 0) return;

    console.log(`⚠️ Found ${res.rows.length} stuck wallet withdrawals. Refunding...`);

    for (const tx of res.rows) {
      try {
        // 1. Refund the money to the specific wallet
        await Member.creditWallet(
          tx.member_id, 
          Math.abs(tx.amount), 
          'withdrawal_refund', 
          'System Sweep: Stuck B2C', 
          tx.wallet_type
        );
        
        // 2. Mark the original transaction as failed
        await pool.query(
          `UPDATE wallet_transactions SET transaction_type = 'withdrawal_failed' WHERE id = $1`,
          [tx.id]
        );

        console.log(`✅ Refunded stuck withdrawal for member ${tx.member_id} (KES ${Math.abs(tx.amount)})`);
      } catch (err) {
        console.error(`Failed to sweep transaction ${tx.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('Sweeper job error:', err.message);
  }
}

async function start() {
  try {
    // Creates tables if they don't exist yet
    // 2026-11-01: Re-ordered initialization so core tables (Admins, Members) 
    // are created BEFORE dependent tables (Withdrawal, AuditLog).
    await Admin.init();
    await Member.init();
    await AuditLog.init();
    
    await Loan.init();
    await Payment.init();
    await Repayment.init();
    await Withdrawal.init();
    
    await UssdSession.init();
    await StaffInvite.init();

    // 2026-11-07: Start the sweeper immediately, then run every 10 minutes
    sweepStuckWithdrawals();
    setInterval(sweepStuckWithdrawals, 10 * 60 * 1000);

    const server = app.listen(PORT, () => {
      console.log(`KEMRI SACCO backend running on port ${PORT}`);
    });

    server.on('error', (err) => {
      console.error(`Server failed to listen on port ${PORT}:`, err.message);
      process.exit(1);
    });

    // 2026-11-02: GRACEFUL SHUTDOWN
    // When Render deploys a new version, it sends a SIGTERM signal. 
    // We stop accepting new connections, finish active requests, and then close the DB pool.
    const shutdown = () => {
      console.log('🛑 SIGTERM/SIGINT received. Shutting down gracefully...');
      
      server.close(() => {
        console.log('✅ HTTP server closed.');
        
        // Close the PostgreSQL connection pool
        pool.pool.end(() => {
          console.log('✅ Database pool closed. Exiting process.');
          process.exit(0);
        });
      });

      // Force shutdown if it takes longer than 10 seconds (e.g., stuck callback)
      setTimeout(() => {
        console.error('❌ Could not close connections in time, forcefully shutting down.');
        process.exit(1);
      }, 10000);
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();