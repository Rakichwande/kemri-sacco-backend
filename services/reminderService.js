const Loan = require('../models/Loan');
const smsService = require('./smsService');

// Daily reminder orchestrator. Called by GitHub Actions once a day at
// 09:00 EAT via POST /internal/run-reminders. Decides what (if anything)
// to send today based on the calendar date and each loan's state.
//
// CADENCE
//   15th of each month      → mid-month balance reminder to every member
//   last day of each month  → end-of-month status reminder to every member
//   day 3 of the month      → overdue nudge to members who are behind
//   day 6 of the month      → staff alert for members still behind
//   every Monday            → weekly digest to staff (only if there's content)
//
// TOLERANCE
//   A member is "behind" when amount_paid is more than 1 instalment below
//   the cumulative schedule. At month 1 (0 instalments due) nobody is
//   behind. At month 2 (1 due) the threshold is 0. At month 3 (2 due) it's
//   1 × monthly_installment. This gives every member one month of slack
//   without drifting into a genuinely overdue position.
//
// IDEMPOTENCY
//   Before sending any member reminder, we check whether one was already
//   sent today. If yes, skip. This makes the endpoint safe to call twice —
//   e.g. on a GitHub Actions retry — without double-sending.

class ReminderService {
  // Entry point. Returns a summary of what was sent, which the endpoint
  // returns to GitHub Actions for logging.
  static async runDaily(today = new Date()) {
    const summary = {
      date: today.toISOString().slice(0, 10),
      midMonthSent: 0,
      endMonthSent: 0,
      day3Sent: 0,
      day6StaffAlertSent: 0,
      weeklyDigestSent: false,
      skipped: 0,
      errors: [],
    };

    const day = today.getDate();
    const isMidMonth = day === 15;
    const isLastDay = isLastDayOfMonth(today);
    const isDay3 = day === 3;
    const isDay6 = day === 6;
    const isMonday = today.getDay() === 1;

    const loans = await Loan.findAllDisbursedForReminders();

    // Precompute the weekly digest content in a single pass so we only
    // send it if there's something to report. Doing this before the loop
    // avoids a second iteration.
    let weeklyDueCount = 0;
    let weeklyDueTotal = 0;
    let weeklyOverdueCount = 0;

    for (const loan of loans) {
      try {
        const status = this.computeStatus(loan, today);

        if (isMonday) {
          const dueThisWeek = this.isDueThisWeek(loan, today);
          if (dueThisWeek) {
            weeklyDueCount++;
            weeklyDueTotal += Number(loan.monthly_installment);
          }
          if (status.behind) weeklyOverdueCount++;
        }

        if (isMidMonth) {
          if (this.alreadySentToday(loan.last_member_reminder_at, today)) {
            summary.skipped++;
          } else {
            await this.sendMidMonth(loan, status);
            await Loan.markReminderSent(loan.id, 'member');
            summary.midMonthSent++;
          }
        }

        if (isLastDay) {
          if (this.alreadySentToday(loan.last_member_reminder_at, today)) {
            summary.skipped++;
          } else {
            await this.sendEndOfMonth(loan, status);
            await Loan.markReminderSent(loan.id, 'member');
            summary.endMonthSent++;
          }
        }

        if (isDay3 && status.behind) {
          if (this.alreadySentToday(loan.last_member_reminder_at, today)) {
            summary.skipped++;
          } else {
            await this.sendDay3Overdue(loan, status);
            await Loan.markReminderSent(loan.id, 'member');
            summary.day3Sent++;
          }
        }

        if (isDay6 && status.behind) {
          if (this.alreadySentToday(loan.last_staff_alert_at, today)) {
            summary.skipped++;
          } else {
            await this.sendDay6StaffAlert(loan, status);
            await Loan.markReminderSent(loan.id, 'staff');
            summary.day6StaffAlertSent++;
          }
        }
      } catch (err) {
        // Per-loan isolation: one member's SMS failing must not abort the
        // rest of the batch. Logged, counted, and the loop continues.
        console.error(`Reminder failed for loan ${loan.id} (${loan.reference}):`, err.message);
        summary.errors.push({ loanId: loan.id, reference: loan.reference, error: err.message });
      }
    }

    if (isMonday && (weeklyDueCount > 0 || weeklyOverdueCount > 0)) {
      try {
        await this.sendWeeklyDigest(weeklyDueCount, weeklyDueTotal, weeklyOverdueCount);
        summary.weeklyDigestSent = true;
      } catch (err) {
        console.error('Weekly digest send failed:', err.message);
        summary.errors.push({ weeklyDigest: true, error: err.message });
      }
    }

    return summary;
  }

  // Compute the loan's status as of today. The single source of truth for
  // "is this member behind?" — used by every reminder path.
  static computeStatus(loan, today) {
    const disbursed = new Date(loan.disbursed_at);
    const monthsElapsed = monthsBetween(disbursed, today);
    const instalmentsDue = monthsElapsed;
    // 1-instalment tolerance. At 0 or 1 instalments due, threshold is 0 —
    // nobody is behind. From 2 onwards, the member must have paid
    // (instalmentsDue - 1) × monthly_installment.
    const threshold = Math.max(0, (instalmentsDue - 1) * Number(loan.monthly_installment));
    const amountPaid = Number(loan.amount_paid);
    const outstanding = Number(loan.outstanding_balance);
    const behind = amountPaid < threshold;
    const amountBehind = behind ? threshold - amountPaid : 0;

    return { monthsElapsed, instalmentsDue, threshold, amountPaid, outstanding, behind, amountBehind };
  }

  static async sendMidMonth(loan, status) {
    await smsService.sendSMS(
      loan.phone_number,
      smsService.templates.loanReminderMidMonth(loan.full_name, status.outstanding, status.amountPaid)
    );
  }

  static async sendEndOfMonth(loan, status) {
    const message = status.behind
      ? smsService.templates.loanReminderEndMonthBehind(loan.full_name, status.outstanding, status.amountBehind)
      : smsService.templates.loanReminderEndMonthOnTrack(loan.full_name, status.outstanding);
    await smsService.sendSMS(loan.phone_number, message);
  }

  static async sendDay3Overdue(loan, status) {
    await smsService.sendSMS(
      loan.phone_number,
      smsService.templates.loanOverdueDay3(loan.full_name, status.amountBehind)
    );
  }

  static async sendDay6StaffAlert(loan, status) {
    await smsService.notifyStaff(
      smsService.templates.staffLoanOverdueAlert(loan.full_name, loan.reference, status.amountBehind)
    );
  }

  static async sendWeeklyDigest(dueCount, dueTotal, overdueCount) {
    await smsService.notifyStaff(
      smsService.templates.staffWeeklyDigest(dueCount, dueTotal, overdueCount)
    );
  }

  // Has a reminder of the given kind already been sent today? Null-safe:
  // a loan that has never had a reminder sent returns false, and the
  // reminder fires normally.
  static alreadySentToday(timestamp, today) {
    if (!timestamp) return false;
    const sent = new Date(timestamp);
    return (
      sent.getFullYear() === today.getFullYear() &&
      sent.getMonth() === today.getMonth() &&
      sent.getDate() === today.getDate()
    );
  }

  // Is this loan's next payment due within the current calendar week?
  // Used only for the Monday digest. A loan is "due this week" if its
  // next_payment_due falls within 7 days of today. Bounded below by today
  // so an already-overdue loan doesn't appear as "due" in the digest —
  // it appears in the overdue count instead.
  static isDueThisWeek(loan, today) {
    if (!loan.next_payment_due) return false;
    const due = new Date(loan.next_payment_due);
    const days = (due - today) / (1000 * 60 * 60 * 24);
    return days >= 0 && days <= 7;
  }
}

// Full calendar months between two dates. Not the same as
// (now - then) / 30 — the length varies by month. A loan disbursed on the
// 6th advances to "1 month" exactly on the 6th of the next month, not 30
// days later. This is what makes "monthsElapsed" line up with the
// instalment schedule the member agreed to.
function monthsBetween(from, to) {
  let months = (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
  if (to.getDate() < from.getDate()) months -= 1;
  return Math.max(0, months);
}

// True if today is the last calendar day of its month. Handles 28/29/30/31
// without a lookup table — tomorrow is always the 1st of the next month.
function isLastDayOfMonth(date) {
  const tomorrow = new Date(date);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return tomorrow.getDate() === 1;
}

module.exports = ReminderService;