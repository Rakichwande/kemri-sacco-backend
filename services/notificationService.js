const smsService = require('./smsService');
const emailService = require('./emailService');
const Admin = require('../models/Admin');

// Central dispatch for staff-facing notifications. Each staff account
// chooses independently whether they want SMS, email, both, or neither
// (notify_sms / notify_email). Never throws - a notification failure must
// never affect the underlying transaction (registration, loan application,
// repayment, deposit) that triggered it.
//
// Both channels use allSettled so that:
//   - one staff member's unreachable phone (DND, wrong number, phone off)
//     does not prevent the other staff members from being notified
//   - one channel failing (SMS blocked, Brevo unreachable) does not skip
//     the other channel for the same staff member
//   - any rejection that does slip through (from a future change) is
//     captured here and logged rather than becoming an unhandled rejection
//     that would take the whole server down
//
// CHANNEL-OPTIONAL CONTRACT: either smsText or emailContent may be
// null/undefined when the caller only wants one channel. Passing
// emailContent: null (used by the withdrawal success notification, which
// is SMS-only) skips the email task entirely for every staff member —
// previously this crashed on `emailContent.subject` and was caught by
// the caller's try/catch, so the SMS still delivered but the email branch
// logged a spurious error every time. Same for smsText: null.
async function notifyStaff({ smsText, emailContent }) {
  let staff;
  try {
    staff = await Admin.findAll();
  } catch (err) {
    console.error('notifyStaff: failed to load staff accounts:', err.message);
    return;
  }

  const tasks = [];

  for (const s of staff) {
    if (s.notify_sms && s.phone && smsText) {
      // sendSMS itself never throws now (returns { sent, reason }), but
      // wrapping it as a task in allSettled means even a future regression
      // that reintroduces a throw is handled - not turned into an
      // unhandled rejection at the top of the process.
      tasks.push(
        smsService.sendSMS(s.phone, smsText).then(
          (result) => ({ channel: 'sms', staff: s.username, ...result }),
          (err) => ({ channel: 'sms', staff: s.username, sent: false, reason: err.message })
        )
      );
    }
    // The `emailContent &&` guard is the fix: a caller that only wants
    // SMS passes emailContent: null, and no email task is queued for
    // anyone. Before this guard, the code reached into emailContent.subject
    // and threw.
    if (s.notify_email && s.email && emailContent) {
      tasks.push(
        emailService.sendEmail({
          to: s.email,
          subject: emailContent.subject,
          html: emailContent.html,
          text: emailContent.text,
        }).then(
          (result) => ({ channel: 'email', staff: s.username, ...result }),
          (err) => ({ channel: 'email', staff: s.username, sent: false, reason: err.message })
        )
      );
    }
  }

  // allSettled resolves to an array of { status: 'fulfilled' | 'rejected' }
  // entries. We've already converted any rejection above into a fulfilled
  // result with sent: false, so both arrays are just results now.
  const results = await Promise.allSettled(tasks);
  const outcomes = results.map((r) =>
    r.status === 'fulfilled' ? r.value : { sent: false, reason: String(r.reason) }
  );

  const failed = outcomes.filter((o) => !o.sent);
  if (failed.length > 0) {
    // One line per failed delivery, prefixed so log greps for
    // "notifyStaff:" show the full picture. The individual sendSMS /
    // sendEmail functions already log the low-level error; this is the
    // higher-level "here's the aggregate result of this dispatch" line.
    for (const f of failed) {
      console.warn(
        `notifyStaff: ${f.channel || 'unknown'} to ${f.staff || 'unknown'} not delivered:`,
        f.reason || 'unknown reason'
      );
    }
  }
}

module.exports = { notifyStaff };