const Loan = require('../models/Loan');
const Member = require('../models/Member');
const smsService = require('./smsService');

class ReminderService {
  static async runDaily(today = new Date(), opts = {}) {
    const { dryRun = false } = opts;

    const summary = {
      date: today.toISOString().slice(0, 10),
      dryRun,
      dueDate7DaysSent: 0,
      dueDate3DaysSent: 0,
      dueDate1DaySent: 0,
      dueDateTodaySent: 0,
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
        const daysUntilDue = this.daysUntilDue(loan, today);

        // Track weekly stats for the Monday staff digest
        if (isMonday) {
          if (this.isDueThisWeek(loan, today)) {
            weeklyDueCount++;
            weeklyDueTotal += Number(loan.monthly_installment);
          }
          if (status.behind) weeklyOverdueCount++;
        }

        // ============================================================
        // 2026-11-07: NEW RELATIVE DUE DATE REMINDERS
        // These take priority over the calendar-based reminders.
        // ============================================================
        let sentRelativeReminder = false;

        if (daysUntilDue === 7) {
          if (!this.alreadySentToday(loan.last_member_reminder_at, today)) {
            await this.sendRelativeReminder(loan, status, '7days', dryRun);
            if (!dryRun) await Loan.markReminderSent(loan.id, 'member');
            summary.dueDate7DaysSent++;
            sentRelativeReminder = true;
          }
        } else if (daysUntilDue === 3) {
          if (!this.alreadySentToday(loan.last_member_reminder_at, today)) {
            await this.sendRelativeReminder(loan, status, '3days', dryRun);
            if (!dryRun) await Loan.markReminderSent(loan.id, 'member');
            summary.dueDate3DaysSent++;
            sentRelativeReminder = true;
          }
        } else if (daysUntilDue === 1) {
          if (!this.alreadySentToday(loan.last_member_reminder_at, today)) {
            await this.sendRelativeReminder(loan, status, '1day', dryRun);
            if (!dryRun) await Loan.markReminderSent(loan.id, 'member');
            summary.dueDate1DaySent++;
            sentRelativeReminder = true;
          }
        } else if (daysUntilDue === 0) {
          if (!this.alreadySentToday(loan.last_member_reminder_at, today)) {
            await this.sendRelativeReminder(loan, status, 'today', dryRun);
            if (!dryRun) await Loan.markReminderSent(loan.id, 'member');
            summary.dueDateTodaySent++;
            sentRelativeReminder = true;
          }
        }

        // If we just sent a specific due-date reminder today, skip the generic calendar reminders
        if (sentRelativeReminder) continue;

        // ============================================================
        // CALENDAR-BASED REMINDERS (Existing Logic)
        // ============================================================
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

  static async runSavingsUnlockReminders(dryRun = false) {
    const upcoming = await Member.getUpcomingUnlocks();
    let sentCount = 0;

    for (const member of upcoming) {
      try {
        if (Number(member.jipange_balance) > 0) {
          const date = new Date(member.jipange_unlock_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
          const msg = smsService.templates.savingsUnlockReminder(member.full_name, 'jipange', member.jipange_balance, date);
          
          if (dryRun) {
            console.log(`[DRY RUN] SMS to ${member.phone_number}: ${msg}`);
          } else {
            await smsService.sendSMS(member.phone_number, msg);
          }
          sentCount++;
        }

        if (Number(member.holiday_balance) > 0) {
          const date = new Date(member.holiday_unlock_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
          const msg = smsService.templates.savingsUnlockReminder(member.full_name, 'holiday', member.holiday_balance, date);
          
          if (dryRun) {
            console.log(`[DRY RUN] SMS to ${member.phone_number}: ${msg}`);
          } else {
            await smsService.sendSMS(member.phone_number, msg);
          }
          sentCount++;
        }
      } catch (err) {
        console.error(`Failed to send unlock reminder to ${member.full_name}:`, err.message);
      }
    }
    
    return { totalUnlocks: upcoming.length, smsSent: sentCount };
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

  // 2026-11-07: Helper to calculate exactly how many days until the next payment
  static daysUntilDue(loan, today) {
    if (!loan.next_payment_due) return null;
    
    // Normalize both dates to midnight to get exact day differences
    const due = new Date(loan.next_payment_due);
    due.setHours(0, 0, 0, 0);
    
    const current = new Date(today);
    current.setHours(0, 0, 0, 0);
    
    const diffTime = due - current;
    return Math.round(diffTime / (1000 * 60 * 60 * 24));
  }

  static formatDueDate(dateString) {
    if (!dateString) return '';
    return new Date(dateString).toLocaleDateString('en-GB', { 
      day: '2-digit', month: 'short', year: 'numeric' 
    });
  }

  // 2026-11-07: New method to handle relative due date SMS
  static async sendRelativeReminder(loan, status, timeframe, dryRun) {
    const dueDate = this.formatDueDate(loan.next_payment_due);
    let message = '';

    if (timeframe === '7days') {
      message = smsService.templates.loanDueIn7Days(loan.full_name, loan.reference, loan.monthly_installment, dueDate, loan.purpose);
    } else if (timeframe === '3days') {
      message = smsService.templates.loanDueIn3Days(loan.full_name, loan.reference, loan.monthly_installment, dueDate, loan.purpose);
    } else if (timeframe === '1day') {
      message = smsService.templates.loanDueTomorrow(loan.full_name, loan.reference, loan.monthly_installment, loan.purpose);
    } else if (timeframe === 'today') {
      message = smsService.templates.loanDueToday(loan.full_name, loan.reference, loan.monthly_installment, loan.purpose);
    }

    await this.deliver({ dryRun, to: loan.phone_number, message, logLabel: `${timeframe} due reminder → ${loan.reference}` });
  }

  static async sendMidMonth(loan, status, dryRun) {
    const dueDate = this.formatDueDate(loan.next_payment_due);
    const message = smsService.templates.loanReminderBoardApproved(
      loan.full_name, status.outstanding, status.amountPaid, loan.reference, loan.purpose, dueDate
    );
    await this.deliver({ dryRun, to: loan.phone_number, message, logLabel: `mid-month → ${loan.reference}` });
  }

  static async sendEndOfMonth(loan, status, dryRun) {
    const dueDate = this.formatDueDate(loan.next_payment_due);
    const message = smsService.templates.loanReminderBoardApproved(
      loan.full_name, status.outstanding, status.amountPaid, loan.reference, loan.purpose, dueDate
    );
    await this.deliver({ dryRun, to: loan.phone_number, message, logLabel: `end-of-month → ${loan.reference}` });
  }

  static async sendDay3Overdue(loan, status, dryRun) {
    const dueDate = this.formatDueDate(loan.next_payment_due);
    const message = smsService.templates.loanReminderBoardApproved(
      loan.full_name, status.outstanding, status.amountPaid, loan.reference, loan.purpose, dueDate
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