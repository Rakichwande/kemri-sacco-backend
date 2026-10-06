const db = require('../config/database');

// Loan aging report — groups all currently-disbursed loans into buckets
// by how long the member has been behind their repayment schedule.
//
// The bucket definitions deliberately reuse the same tolerance logic as
// the reminder service (services/reminderService.js). A member is "behind"
// when their cumulative amount_paid falls more than one full instalment
// below their cumulative schedule. Staff should never see a loan marked
// "current" on the aging report while receiving overdue reminders about
// it — the two systems must agree on what "behind" means.
//
// Days-late is measured from when the member first crossed the threshold,
// not from the day the missed instalment was originally due. This matches
// the accounting convention: an invoice isn't "60 days overdue" on the
// day it's due — it becomes overdue when payment was expected and didn't
// arrive.
//
// Called by GET /api/reports/aging. Returns a bucketed breakdown plus the
// individual loans in each bucket.

function monthsBetween(from, to) {
  let months = (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
  if (to.getDate() < from.getDate()) months -= 1;
  return Math.max(0, months);
}

function addMonths(date, n) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + n);
  return d;
}

async function getAgingReport(today = new Date()) {
  const result = await db.query(`
    SELECT
      l.id, l.member_id, l.principal, l.monthly_installment,
      l.outstanding_balance, l.amount_paid, l.tenure_months,
      l.disbursed_at, l.next_payment_due,
      'LN-' || LPAD(l.id::text, 5, '0') AS reference,
      m.full_name, m.phone_number,
      m.imported_reference AS member_reference
    FROM loans l
    JOIN members m ON l.member_id = m.id
    WHERE l.status = 'disbursed'
    ORDER BY l.disbursed_at ASC
  `);

  const loans = result.rows.map((loan) => {
    const disbursed = new Date(loan.disbursed_at);
    const monthlyInstallment = Number(loan.monthly_installment);
    const amountPaid = Number(loan.amount_paid);
    const outstanding = Number(loan.outstanding_balance);

    const monthsElapsed = monthsBetween(disbursed, today);
    const instalmentsDue = monthsElapsed;
    const threshold = Math.max(0, (instalmentsDue - 1) * monthlyInstallment);
    const behind = amountPaid < threshold;
    const amountBehind = behind ? threshold - amountPaid : 0;

    // How many complete instalments has the member effectively paid?
    // floor(paid / monthly) — the "1-instalment tolerance" means the
    // member falls behind on instalment (paid + 2).
    const instalmentsPaid = Math.floor(amountPaid / monthlyInstallment);
    const instalmentsBehind = behind
      ? Math.max(1, monthsElapsed - instalmentsPaid - 1)
      : 0;

    // Days late: measured from the month the member crossed the threshold.
    // Math.max(1, ...) so a member who just crossed into "behind" on the
    // exact month boundary still lands in a real bucket rather than a
    // zero-day limbo.
    let daysLate = 0;
    if (behind) {
      const behindSince = addMonths(disbursed, instalmentsPaid + 2);
      const rawDays = Math.floor((today - behindSince) / (1000 * 60 * 60 * 24));
      daysLate = Math.max(1, rawDays);
    }

    let bucket;
    if (!behind) bucket = 'current';
    else if (daysLate <= 30) bucket = 'days_1_30';
    else if (daysLate <= 60) bucket = 'days_31_60';
    else if (daysLate <= 90) bucket = 'days_61_90';
    else bucket = 'days_90_plus';

    return {
      id: loan.id,
      reference: loan.reference,
      member_id: loan.member_id,
      member_name: loan.full_name,
      member_reference: loan.member_reference,
      phone_number: loan.phone_number,
      principal: Number(loan.principal),
      outstanding_balance: outstanding,
      amount_paid: amountPaid,
      monthly_installment: monthlyInstallment,
      instalments_paid: instalmentsPaid,
      instalments_due: monthsElapsed,
      instalments_behind: instalmentsBehind,
      amount_behind: amountBehind,
      days_late: daysLate,
      bucket,
      disbursed_at: loan.disbursed_at,
      next_payment_due: loan.next_payment_due,
    };
  });

  // Buckets are always returned in a fixed order, even when empty — the
  // frontend renders every row so an empty bucket reads as "all clear"
  // rather than "the report is broken."
  const buckets = {
    current: { key: 'current', label: 'Current', description: 'Not behind schedule', loans: [], count: 0, total_outstanding: 0, total_behind: 0 },
    days_1_30: { key: 'days_1_30', label: '1–30 days late', description: 'Recently behind — reminders active', loans: [], count: 0, total_outstanding: 0, total_behind: 0 },
    days_31_60: { key: 'days_31_60', label: '31–60 days late', description: 'A full month behind', loans: [], count: 0, total_outstanding: 0, total_behind: 0 },
    days_61_90: { key: 'days_61_90', label: '61–90 days late', description: 'Two months behind — escalate', loans: [], count: 0, total_outstanding: 0, total_behind: 0 },
    days_90_plus: { key: 'days_90_plus', label: '90+ days late', description: 'Critical — formal recovery', loans: [], count: 0, total_outstanding: 0, total_behind: 0 },
  };

  for (const loan of loans) {
    const b = buckets[loan.bucket];
    b.loans.push(loan);
    b.count += 1;
    b.total_outstanding += loan.outstanding_balance;
    b.total_behind += loan.amount_behind;
  }

  const overdueLoans = loans.filter((l) => l.bucket !== 'current');

  const totals = {
    total_loans: loans.length,
    total_outstanding: loans.reduce((s, l) => s + l.outstanding_balance, 0),
    total_behind: loans.reduce((s, l) => s + l.amount_behind, 0),
    overdue_count: overdueLoans.length,
    overdue_outstanding: overdueLoans.reduce((s, l) => s + l.outstanding_balance, 0),
    overdue_behind: overdueLoans.reduce((s, l) => s + l.amount_behind, 0),
  };

  return {
    as_of: today.toISOString().slice(0, 10),
    buckets: Object.values(buckets),
    totals,
  };
}

module.exports = { getAgingReport };