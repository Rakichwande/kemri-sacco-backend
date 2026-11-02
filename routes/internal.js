const express = require('express');
const router = express.Router();
const ReminderService = require('../services/reminderService');

// Protected internal endpoints. These are called by scheduled jobs, not by
// users — they have no JWT authentication because they aren't user actions.
// Instead, a shared secret header gates them: GitHub Actions sends
// X-Reminder-Secret, and we compare it against REMINDER_SECRET.

// ============================================================
// ROUTE 1: Daily Loan Reminders
// ============================================================
router.post('/run-reminders', async (req, res) => {
  const provided = req.headers['x-reminder-secret'];
  const expected = process.env.REMINDER_SECRET;

  if (!expected) {
    console.error('REMINDER_SECRET is not configured — internal endpoints disabled.');
    return res.status(503).json({ error: 'Reminder service not configured' });
  }

  if (!provided || provided !== expected) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  // ─── TEST-DATE OVERRIDE ─────────────────────────────────────────────
  //   ?testDate=YYYY-MM-DD   Run the service as if "today" were that date.
  //   ?dryRun=1               Compute what WOULD be sent today but do not
  //                          send anything. Logs each intended SMS.
  // ────────────────────────────────────────────────────────────────────

  let today = new Date();
  const testDate = req.query.testDate;
  if (testDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(testDate)) {
      return res.status(400).json({ error: 'testDate must be YYYY-MM-DD' });
    }
    const parsed = new Date(`${testDate}T09:00:00Z`);
    if (isNaN(parsed.getTime())) {
      return res.status(400).json({ error: 'testDate is not a valid date' });
    }
    today = parsed;
  }

  const dryRun = req.query.dryRun === '1' || req.query.dryRun === 'true';

  try {
    const summary = await ReminderService.runDaily(today, { dryRun });
    console.log(
      `Reminder run [${testDate || 'live'}${dryRun ? ' DRY-RUN' : ''}]:`,
      JSON.stringify(summary)
    );
    res.json({
      success: true,
      testDate: testDate || null,
      dryRun,
      summary,
    });
  } catch (err) {
    console.error('Reminder run failed:', err);
    res.status(500).json({ error: 'Reminder run failed', message: err.message });
  }
});

// ============================================================
// ROUTE 2: 7-Day Savings Unlock Reminders (2026-11-02)
// ============================================================
// Sends an SMS to members whose Jipange or Holiday savings will unlock
// in exactly 7 days. Ensures members have time to plan withdrawals.
//
// Called by GitHub Actions once per day alongside /run-reminders.
// Use ?dryRun=1 to verify without sending real SMS.
router.post('/run-unlock-reminders', async (req, res) => {
  const provided = req.headers['x-reminder-secret'];
  const expected = process.env.REMINDER_SECRET;

  if (!expected) {
    console.error('REMINDER_SECRET is not configured — unlock reminders disabled.');
    return res.status(503).json({ error: 'Reminder service not configured' });
  }

  if (!provided || provided !== expected) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const dryRun = req.query.dryRun === '1' || req.query.dryRun === 'true';

  try {
    const summary = await ReminderService.runSavingsUnlockReminders(dryRun);
    console.log(
      `Unlock reminder run [${dryRun ? 'DRY-RUN' : 'live'}]:`,
      JSON.stringify(summary)
    );
    res.json({
      success: true,
      dryRun,
      summary,
    });
  } catch (err) {
    console.error('Unlock reminder run failed:', err);
    res.status(500).json({ error: 'Unlock reminder run failed', message: err.message });
  }
});

// ============================================================
// ROUTE 3: Annual Interest Payout (2026-11-02)
// ============================================================
// Pays out 10% annual interest to members whose Jipange or Holiday
// savings have completed a full year.
//
// Called by GitHub Actions once per day. It only pays members whose
// jipange_interest_date or holiday_interest_date is today or earlier.
// After paying, it resets their interest date to +1 year, so they
// earn interest again next year.
//
// Use ?dryRun=1 to verify without sending real money or SMS.
router.post('/run-interest-payout', async (req, res) => {
  const provided = req.headers['x-reminder-secret'];
  const expected = process.env.REMINDER_SECRET;

  if (!expected) {
    console.error('REMINDER_SECRET is not configured — interest payout disabled.');
    return res.status(503).json({ error: 'Reminder service not configured' });
  }

  if (!provided || provided !== expected) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const dryRun = req.query.dryRun === '1' || req.query.dryRun === 'true';

  try {
    const InterestService = require('../services/interestService');
    const summary = await InterestService.runAnnualPayout(dryRun);
    console.log(
      `Interest payout run [${dryRun ? 'DRY-RUN' : 'live'}]:`,
      JSON.stringify(summary)
    );
    res.json({
      success: true,
      dryRun,
      summary,
    });
  } catch (err) {
    console.error('Interest payout run failed:', err);
    res.status(500).json({ error: 'Interest payout run failed', message: err.message });
  }
});

module.exports = router;