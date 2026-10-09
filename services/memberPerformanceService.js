const db = require('../config/database');
const Member = require('../models/Member');

// Per-member credit performance report. Answers "how healthy is this
// member's relationship with the SACCO?" — the individual counterpart to
// the portfolio-wide aging report (services/agingService.js).
//
// Two aggregate areas:
//   1. Loan history — every loan this member has ever taken, with
//      per-loan repayment duration and an on-time/late classification
//      for completed loans.
//   2. Member position — savings vs outstanding, and a running
//      lifetime tally.
//
// 2026-10-09 (Phase 4): also returns principal/interest splits from the
// repayments ledger, so the Performance page can show how much of the
// member's repayments went to each. Same source as the statement route.
//
// LIMITATION: the payments table records the TOTAL amount paid against a
// loan, not which specific instalment each payment covered. So a
// per-instalment "on-time rate" cannot be computed — only a per-loan
// duration comparison. A loan is classified on-time when it was fully
// repaid within its tenure (months × 30 days) plus a 7-day grace for
// settlement delays common in M-Pesa posting. Do not invent a stricter
// metric than the data supports; a fabricated number is worse than none.

async function getMemberPerformance(memberId) {
  const member = await Member.findById(memberId);
  if (!member) return null;

  const [loansResult, savingsResult, splitsResult] = await Promise.all([
    db.query(
      `SELECT l.*, 'LN-' || LPAD(l.id::text, 5, '0') AS reference
       FROM loans l
       WHERE l.member_id = $1
       ORDER BY l.applied_at DESC`,
      [memberId]
    ),
    // Savings = completed deposits only. The payments table holds both
    // deposits and repayments, distinguished by loan_id — the same filter
    // used elsewhere in the platform (Member.findAllForDirectory,
    // models/Dashboard.js).
    db.query(
      `SELECT COALESCE(SUM(amount), 0)::bigint AS total
       FROM payments
       WHERE member_id = $1 AND status = 'completed' AND loan_id IS NULL`,
      [memberId]
    ),
    // 2026-10-09 (Phase 4): per-loan principal/interest totals. One row
    // per loan this member has ever repaid against, keyed by loan_id so
    // the JS mapping below can enrich each loan without an N+1 pattern.
    db.query(
      `SELECT
         loan_id,
         COALESCE(SUM(principal_paid), 0)::bigint AS principal_paid,
         COALESCE(SUM(interest_paid), 0)::bigint AS interest_paid
       FROM repayments
       WHERE member_id = $1
       GROUP BY loan_id`,
      [memberId]
    ),
  ]);

  const savingsBalance = Number(savingsResult.rows[0].total);

  // Map split rows by loan_id for O(1) lookup in the loan mapping below.
  // Loans with no repayments yet (pending, rejected, disbursed-not-yet-paid)
  // simply aren't in the map, so the split defaults to zeros.
  const splitsByLoan = new Map(
    splitsResult.rows.map((r) => [
      r.loan_id,
      {
        principal_paid: Number(r.principal_paid),
        interest_paid: Number(r.interest_paid),
      },
    ])
  );

  const enrichedLoans = loansResult.rows.map((loan) => {
    const disbursed = loan.disbursed_at ? new Date(loan.disbursed_at) : null;
    const repaid = loan.repaid_at ? new Date(loan.repaid_at) : null;

    let daysToRepay = null;
    let onTime = null;

    // Only a fully-repaid loan has a duration. A disbursed-but-not-repaid
    // loan has no end date yet, so on_time stays null.
    if (disbursed && repaid) {
      daysToRepay = Math.round((repaid - disbursed) / (1000 * 60 * 60 * 24));
      const tenureDays = loan.tenure_months * 30 + 7; // +7-day grace
      onTime = daysToRepay <= tenureDays;
    }

    const split = splitsByLoan.get(loan.id) || { principal_paid: 0, interest_paid: 0 };

    return {
      id: loan.id,
      reference: loan.reference,
      principal: Number(loan.principal),
      total_repayment: Number(loan.total_repayment),
      total_interest: Number(loan.total_interest),
      outstanding_balance: Number(loan.outstanding_balance),
      amount_paid: Number(loan.amount_paid),
      // 2026-10-09 (Phase 4): split of amount_paid.
      principal_paid: split.principal_paid,
      interest_paid: split.interest_paid,
      monthly_installment: Number(loan.monthly_installment),
      tenure_months: loan.tenure_months,
      interest_rate: Number(loan.interest_rate),
      status: loan.status,
      applied_at: loan.applied_at,
      disbursed_at: loan.disbursed_at,
      repaid_at: loan.repaid_at,
      days_to_repay: daysToRepay,
      on_time: onTime,
    };
  });

  const totalLoans = enrichedLoans.length;
  const loansRepaid = enrichedLoans.filter((l) => l.status === 'repaid').length;
  const loansActive = enrichedLoans.filter((l) =>
    ['pending', 'approved', 'disbursing', 'disbursed'].includes(l.status)
  ).length;
  const loansRejected = enrichedLoans.filter((l) => l.status === 'rejected').length;

  const totalBorrowed = enrichedLoans.reduce((s, l) => s + l.principal, 0);
  const totalRepaid = enrichedLoans.reduce((s, l) => s + l.amount_paid, 0);
  // 2026-10-09 (Phase 4): lifetime split totals. principal + interest
  // should equal totalRepaid for every member with clean data; if they
  // ever diverge, it means a repayment row is missing its split — worth
  // an alarm but never a crash, so we just sum what's there.
  const totalPrincipalPaid = enrichedLoans.reduce((s, l) => s + l.principal_paid, 0);
  const totalInterestPaid = enrichedLoans.reduce((s, l) => s + l.interest_paid, 0);
  const currentOutstanding = Number(member.total_outstanding_balance || 0);

  const repaidWithDuration = enrichedLoans.filter(
    (l) => l.status === 'repaid' && l.on_time !== null
  );
  const onTimeCount = repaidWithDuration.filter((l) => l.on_time).length;
  const lateCount = repaidWithDuration.length - onTimeCount;

  return {
    member: {
      id: member.id,
      full_name: member.full_name,
      reference: member.reference,
      phone_number: member.phone_number,
      id_number: member.id_number,
      employer: member.employer,
      status: member.status,
      is_board_staff: member.is_board_staff,
      credit_limit: Number(member.credit_limit || 0),
      member_since: member.created_at,
    },
    summary: {
      total_loans: totalLoans,
      loans_repaid: loansRepaid,
      loans_active: loansActive,
      loans_rejected: loansRejected,
      total_borrowed: totalBorrowed,
      total_repaid: totalRepaid,
      // 2026-10-09 (Phase 4): split of total_repaid.
      total_principal_paid: totalPrincipalPaid,
      total_interest_paid: totalInterestPaid,
      current_outstanding: currentOutstanding,
      savings_balance: savingsBalance,
      net_position: savingsBalance - currentOutstanding,
      on_time_repayments: onTimeCount,
      late_repayments: lateCount,
    },
    loans: enrichedLoans,
  };
}

module.exports = { getMemberPerformance };