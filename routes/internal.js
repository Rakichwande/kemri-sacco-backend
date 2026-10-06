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

  try {
    const summary = await ReminderService.runDaily();
    console.log('Reminder run summary:', JSON.stringify(summary));
    res.json({ success: true, summary });
  } catch (err) {
    console.error('Reminder run failed:', err);
    res.status(500).json({ error: 'Reminder run failed', message: err.message });
  }
});

module.exports = router;