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
//
// DRY RUN
//   Every send path checks opts.dryRun first. When true, no SMS goes out
//   and no money is spent — the intended message is logged to the console
//   instead. Used by the /internal/run-reminders endpoint's ?dryRun=1
//   parameter to verify cadence logic without triggering real sends.

class ReminderService {
  // Entry point. Returns a summary of what was sent, which the endpoint
  // returns to GitHub Actions for logging.
  static async runDaily(today = new Date(), opts = {}) {
    const { dryRun = false } = opts;

    const summary = {
      date: today.toISOString().slice(0, 10),
      dryRun,
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
            await this.sendMidMonth(loan, status, dryRun);
            if (!dryRun) await Loan.markReminderSent(loan.id, 'member');
            summary.midMonthSent++;
          }
        }

        if (isLastDay) {
          if (this.alreadySentToday(loan.last_member_reminder_at, today)) {
            summary.skipped++;
          } else {
            await this.sendEndOfMonth(loan, status, dryRun);
            if (!dryRun) await Loan.markReminderSent(loan.id, 'member');
            summary.endMonthSent++;
          }
        }

        if (isDay3 && status.behind) {
          if (this.alreadySentToday(loan.last_member_reminder_at, today)) {
            summary.skipped++;
          } else {
            await this.sendDay3Overdue(loan, status, dryRun);
            if (!dryRun) await Loan.markReminderSent(loan.id, 'member');
            summary.day3Sent++;
          }
        }

        if (isDay6 && status.behind) {
          if (this.alreadySentToday(loan.last_staff_alert_at, today)) {
            summary.skipped++;
          } else {
            await this.sendDay6StaffAlert(loan, status, dryRun);
            if (!dryRun) await Loan.markReminderSent(loan.id, 'staff');
            summary.day6StaffAlertSent++;
          }
        }
      } catch (err) {
        console.error(`Reminder failed for loan ${loan.id} (${loan.reference}):`, err.message);
        summary.errors.push({ loanId: loan.id, reference: loan.reference, error: err.message });
      }
    }

    if (isMonday && (weeklyDueCount > 0 || weeklyOverdueCount > 0)) {
      try {
        await this.sendWeeklyDigest(weeklyDueCount, weeklyDueTotal, weeklyOverdueCount, dryRun);
        summary.weeklyDigestSent = true;
      } catch (err) {
        console.error('Weekly digest send failed:', err.message);
        summary.errors.push({ weeklyDigest: true, error: err.message });
      }
    }

    return summary;
  }

  static computeStatus(loan, today) {
    const disbursed = new Date(loan.disbursed_at);
    const monthsElapsed = monthsBetween(disbursed, today);
    const instalmentsDue = monthsElapsed;
    const threshold = Math.max(0, (instalmentsDue - 1) * Number(loan.monthly_installment));
    const amountPaid = Number(loan.amount_paid);
    const outstanding = Number(loan.outstanding_balance);
    const behind = amountPaid < threshold;
    const amountBehind = behind ? threshold - amountPaid : 0;

    return { monthsElapsed, instalmentsDue, threshold, amountPaid, outstanding, behind, amountBehind };
  }

  // 2026-10-21: All member reminders now use the board-approved unified
  // template. They all pass full name, outstanding balance, and amount paid.

  static async sendMidMonth(loan, status, dryRun) {
    const message = smsService.templates.loanReminderBoardApproved(
      loan.full_name, status.outstanding, status.amountPaid
    );
    await this.deliver({ dryRun, to: loan.phone_number, message, logLabel: `mid-month → ${loan.reference}` });
  }

  static async sendEndOfMonth(loan, status, dryRun) {
    const message = smsService.templates.loanReminderBoardApproved(
      loan.full_name, status.outstanding, status.amountPaid
    );
    await this.deliver({
      dryRun,
      to: loan.phone_number,
      message,
      logLabel: `end-of-month → ${loan.reference}`,
    });
  }

  static async sendDay3Overdue(loan, status, dryRun) {
    const message = smsService.templates.loanReminderBoardApproved(
      loan.full_name, status.outstanding, status.amountPaid
    );
    await this.deliver({ dryRun, to: loan.phone_number, message, logLabel: `day-3 overdue → ${loan.reference}` });
  }

  static async sendDay6StaffAlert(loan, status, dryRun) {
    const message = smsService.templates.staffLoanOverdueAlert(
      loan.full_name, loan.reference, status.amountBehind
    );
    await this.deliver({ dryRun, to: 'STAFF', message, logLabel: `day-6 staff alert → ${loan.reference}`, isStaff: true });
  }

  static async sendWeeklyDigest(dueCount, dueTotal, overdueCount, dryRun) {
    const message = smsService.templates.staffWeeklyDigest(dueCount, dueTotal, overdueCount);
    await this.deliver({ dryRun, to: 'STAFF', message, logLabel: 'weekly digest', isStaff: true });
  }

  static async deliver({ dryRun, to, message, logLabel, isStaff = false }) {
    if (dryRun) {
      console.log(`[DRY RUN] would send (${logLabel}) to ${to}: ${message}`);
      return;
    }
    if (isStaff) {
      return smsService.notifyStaff(message);
    }
    return smsService.sendSMS(to, message);
  }

  static alreadySentToday(timestamp, today) {
    if (!timestamp) return false;
    const sent = new Date(timestamp);
    return (
      sent.getFullYear() === today.getFullYear() &&
      sent.getMonth() === today.getMonth() &&
      sent.getDate() === today.getDate()
    );
  }

  static isDueThisWeek(loan, today) {
    if (!loan.next_payment_due) return false;
    const due = new Date(loan.next_payment_due);
    const days = (due - today) / (1000 * 60 * 60 * 24);
    return days >= 0 && days <= 7;
  }
}

function monthsBetween(from, to) {
  let months = (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
  if (to.getDate() < from.getDate()) months -= 1;
  return Math.max(0, months);
}

function isLastDayOfMonth(date) {
  const tomorrow = new Date(date);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return tomorrow.getDate() === 1;
}

module.exports = ReminderService;