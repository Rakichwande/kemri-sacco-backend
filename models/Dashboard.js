const db = require('../config/database');
const Repayment = require('./Repayment');

// All figures here are derived from real, already-existing data:
// - members: headcount
// - payments (status='completed' AND loan_id IS NULL): total savings held,
//   contributions-by-month. The loan_id filter matters: the payments table
//   holds BOTH deposits and loan repayments, distinguished only by whether
//   loan_id is set. A repayment is money the member is returning to the
//   SACCO on a loan, NOT a savings contribution — counting it as savings
//   inflates the headline figure and misrepresents the member's position.
//   Same convention Member.findAllForDirectory() uses for its
//   savings_balance column.
// - loans: outstanding balance, repaid-to-date, pending count, total disbursed
// - repayments: per-transaction repayment history, for the monthly comparison
//   AND for the interest split (Phase 2 — principal_paid / interest_paid).
//
// Deliberately NOT included: any "dividend accrual" or "available liquidity"
// figure - no dividend formula or liquidity policy is defined anywhere in the
// system, so either would have to be invented rather than computed.
async function getSummary() {
  const [
    membersResult,
    savingsResult,
    loansOutstandingResult,
    repaidToDateResult,
    pendingResult,
    disbursedResult,
    monthlySeriesResult,
    recentPendingResult,
    repaymentsByMonthRows,
    loansByMonthRows,
    interestByMonthRows,
    interestEarnedResult,
    interestCollectedResult,
  ] = await Promise.all([
    db.query('SELECT COUNT(*)::int AS count FROM members'),
    // Total savings = completed deposits only. Excludes repayments, which
    // are money coming back on a loan, not savings contributions.
    db.query(`SELECT COALESCE(SUM(amount), 0)::bigint AS total FROM payments WHERE status = 'completed' AND loan_id IS NULL`),
    db.query(`SELECT COALESCE(SUM(outstanding_balance), 0)::bigint AS total FROM loans WHERE status = 'disbursed'`),
    db.query(`SELECT COALESCE(SUM(amount_paid), 0)::bigint AS total FROM loans`),
    db.query(`SELECT COUNT(*)::int AS count FROM loans WHERE status = 'pending'`),
    // Principal disbursed — includes both currently-outstanding and
    // fully-repaid loans, but excludes pending/approved/disbursing
    // (no money has left the SACCO for those).
    db.query(`SELECT COALESCE(SUM(principal), 0)::bigint AS total FROM loans WHERE status IN ('disbursed', 'repaid')`),
    // Contributions by month — same deposit-only filter as the headline
    // savings figure above, so the chart's tallies reconcile with the total.
    db.query(`
      SELECT date_trunc('month', created_at) AS month, SUM(amount)::bigint AS total
      FROM payments
      WHERE status = 'completed' AND loan_id IS NULL AND created_at >= NOW() - INTERVAL '6 months'
      GROUP BY month
      ORDER BY month
    `),
    db.query(`
      SELECT l.id, l.principal, l.purpose, l.applied_at, m.full_name
      FROM loans l
      LEFT JOIN members m ON l.member_id = m.id
      WHERE l.status = 'pending'
      ORDER BY l.applied_at DESC
      LIMIT 3
    `),
    Repayment.getMonthlyTotals(6),
    db.query(`
      SELECT date_trunc('month', disbursed_at) AS month, SUM(principal)::bigint AS total
      FROM loans
      WHERE disbursed_at IS NOT NULL
        AND disbursed_at >= NOW() - INTERVAL '6 months'
      GROUP BY month
      ORDER BY month
    `).then((r) => r.rows),
    // NEW (Phase 3): interest collected per month, from the Phase 2 split.
    // Cash-basis — this is what the combined chart's interest bar shows.
    Repayment.getMonthlyInterestTotals(6),
    // NEW (Phase 3): interest earned (accrued). For 1-month loans this is
    // the sum of total_interest on every disbursed loan — money the SACCO
    // has earned by issuing the loan, whether or not it's been repaid yet.
    db.query(`SELECT COALESCE(SUM(total_interest), 0)::bigint AS total FROM loans WHERE disbursed_at IS NOT NULL`),
    // NEW (Phase 3): interest collected (all-time). Cash actually received.
    db.query(`SELECT COALESCE(SUM(interest_paid), 0)::bigint AS total FROM repayments`),
  ]);

  // Fill in every one of the last 6 months for all four series, even
  // months with zero activity, so the chart doesn't silently skip a quiet
  // month.
  const contributionsMap = new Map(
    monthlySeriesResult.rows.map((r) => [r.month.toISOString().slice(0, 7), Number(r.total)])
  );
  const repaymentsMap = new Map(
    repaymentsByMonthRows.map((r) => [r.month.toISOString().slice(0, 7), Number(r.total)])
  );
  const loansMap = new Map(
    loansByMonthRows.map((r) => [r.month.toISOString().slice(0, 7), Number(r.total)])
  );
  const interestMap = new Map(
    interestByMonthRows.map((r) => [r.month.toISOString().slice(0, 7), Number(r.total)])
  );
  const monthlySeries = [];
  const now = new Date();
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = d.toISOString().slice(0, 7);
    monthlySeries.push({
      label: d.toLocaleDateString('en-GB', { month: 'short' }),
      contributions: contributionsMap.get(key) || 0,
      loans: loansMap.get(key) || 0,
      repayments: repaymentsMap.get(key) || 0,
      // NEW (Phase 3) — interest collected that month, from the Phase 2
      // split. Feeds the third bar in the combined Financial Trends chart.
      interest: interestMap.get(key) || 0,
    });
  }

  return {
    // Existing fields — unchanged shape so nothing else breaks.
    totalMembers: membersResult.rows[0].count,
    totalSavings: Number(savingsResult.rows[0].total),
    loansOutstanding: Number(loansOutstandingResult.rows[0].total),
    repaidToDate: Number(repaidToDateResult.rows[0].total),
    pendingApplications: pendingResult.rows[0].count,
    totalDisbursed: Number(disbursedResult.rows[0].total),
    monthlySeries,
    recentPendingApplications: recentPendingResult.rows.map((r) => ({
      id: r.id,
      memberName: r.full_name || `Member #${r.id}`,
      principal: Number(r.principal),
      purpose: r.purpose,
      appliedAt: r.applied_at,
    })),

    // NEW (Phase 3) — dashboard card inputs.
    // principalDisbursed aliases totalDisbursed (same number, clearer name
    // for the new card). Kept separate for forward-compatibility if the two
    // ever need to diverge (e.g. netting off a clawback).
    principalDisbursed: Number(disbursedResult.rows[0].total),
    interestEarned: Number(interestEarnedResult.rows[0].total),
    interestCollected: Number(interestCollectedResult.rows[0].total),
  };
}

module.exports = { getSummary };