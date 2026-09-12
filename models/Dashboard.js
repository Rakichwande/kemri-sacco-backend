const db = require('../config/database');
const Repayment = require('./Repayment');

// All figures here are derived from real, already-existing data:
// - members: headcount
// - payments (status='completed'): total savings held, contributions-by-month
// - loans: outstanding balance, repaid-to-date, pending count, total disbursed
// - repayments: per-transaction repayment history, for the monthly comparison
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
  ] = await Promise.all([
    db.query('SELECT COUNT(*)::int AS count FROM members'),
    db.query(`SELECT COALESCE(SUM(amount), 0)::bigint AS total FROM payments WHERE status = 'completed'`),
    db.query(`SELECT COALESCE(SUM(outstanding_balance), 0)::bigint AS total FROM loans WHERE status = 'disbursed'`),
    db.query(`SELECT COALESCE(SUM(amount_paid), 0)::bigint AS total FROM loans`),
    db.query(`SELECT COUNT(*)::int AS count FROM loans WHERE status = 'pending'`),
    db.query(`SELECT COALESCE(SUM(principal), 0)::bigint AS total FROM loans WHERE status IN ('disbursed', 'repaid')`),
    db.query(`
      SELECT date_trunc('month', created_at) AS month, SUM(amount)::bigint AS total
      FROM payments
      WHERE status = 'completed' AND created_at >= NOW() - INTERVAL '6 months'
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
  ]);

  // Fill in every one of the last 6 months for both series, even months with
  // zero activity, so the chart doesn't silently skip a quiet month.
  const contributionsMap = new Map(
    monthlySeriesResult.rows.map((r) => [r.month.toISOString().slice(0, 7), Number(r.total)])
  );
  const repaymentsMap = new Map(
    repaymentsByMonthRows.map((r) => [r.month.toISOString().slice(0, 7), Number(r.total)])
  );
  const monthlySeries = [];
  const now = new Date();
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = d.toISOString().slice(0, 7);
    monthlySeries.push({
      label: d.toLocaleDateString('en-GB', { month: 'short' }),
      contributions: contributionsMap.get(key) || 0,
      repayments: repaymentsMap.get(key) || 0,
    });
  }

  return {
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
  };
}

module.exports = { getSummary };
