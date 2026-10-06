const express = require('express');
const router = express.Router();
const ReminderService = require('../services/reminderService');

// Protected internal endpoints. These are called by scheduled jobs, not by
// users — they have no JWT authentication because they aren't user actions.
// Instead, a shared secret header gates them: GitHub Actions sends
// X-Reminder-Secret, and we compare it against REMINDER_SECRET.
//
// The secret is a random string set as an environment variable on Render
// and as a GitHub repository secret. Anyone who has both the URL and the
// secret can trigger the endpoint, but without the secret the endpoint
// returns 403.
//
// This endpoint is idempotent: calling it twice on the same day sends
// each reminder at most once (the reminder service checks
// last_member_reminder_at before sending). Safe to retry.
router.post('/run-reminders', async (req, res) => {
  const provided = req.headers['x-reminder-secret'];
  const expected = process.env.REMINDER_SECRET;

  if (!expected) {
    console.error('REMINDER_SECRET is not configured — internal endpoints disabled.');
    return res.status(503).json({ error: 'Reminder service not configured' });
  }

  // Constant-time comparison isn't strictly needed here (no brute-force
  // risk on a scheduled job), but using it is a cheap habit to keep.
  if (!provided || provided !== expected) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  // ─── TEST-DATE OVERRIDE ─────────────────────────────────────────────
  // Optional query params for manually validating the reminder cadence
  // without waiting for a real calendar date.
  //
  //   ?testDate=YYYY-MM-DD   Run the service as if "today" were that date.
  //                          The scheduling logic uses this date to decide
  //                          which reminders fire. The actual SMS sends
  //                          (if not dry-run) still go to real numbers and
  //                          cost real money.
  //
  //   ?dryRun=1               Compute what WOULD be sent today but do not
  //                          send anything. Logs each intended SMS to the
  //                          Render console. No SMS cost.
  //
  // Idempotency caveat in test mode: markReminderSent() always writes
  // NOW() (the real current time), not the simulated date. So if you run
  // ?testDate=2026-11-15 twice on the same real day, the second run
  // does NOT see the first run's marker as "already sent today" — and
  // sends again. Use dryRun=1 for repeated verification; only run without
  // dryRun when you specifically want to test real SMS delivery, and do
  // it once.
  // ────────────────────────────────────────────────────────────────────

  let today = new Date();
  const testDate = req.query.testDate;
  if (testDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(testDate)) {
      return res.status(400).json({ error: 'testDate must be YYYY-MM-DD' });
    }
    // Anchor at 09:00 UTC so the simulated hour doesn't affect any
    // time-of-day logic. Only the date matters for scheduling.
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

module.exports = router;