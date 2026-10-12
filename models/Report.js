const db = require('../config/database');

// Computes the [start, end) date range for a given period selection.
function getPeriodRange({ periodType, year, month, quarter }) {
  const y = Number(year);
  if (periodType === 'month') {
    const m = Number(month); // 1-12
    const start = new Date(Date.UTC(y, m - 1, 1));
    const end = new Date(Date.UTC(y, m, 1));
    return { start, end };
  }
  if (periodType === 'quarter') {
    const q = Number(quarter); // 1-4
    const startMonth = (q - 1) * 3;
    const start = new Date(Date.UTC(y, startMonth, 1));
    const end = new Date(Date.UTC(y, startMonth + 3, 1));
    return { start, end };
  }
  // 'year'
  const start = new Date(Date.UTC(y, 0, 1));
  const end = new Date(Date.UTC(y + 1, 0, 1));
  return { start, end };
}

// 2026-10-12 (Phase 5): Interest visibility.
//
// The board asked for profit visibility across the platform. Phase 2 added
// the principal_paid / interest_paid split to the repayments ledger; Phase 3
// wired it into the Dashboard; Phase 4 into the Statement and Member
// Performance. This page was the last one still reading pre-Phase-2 numbers.
//
// Two distinct interest figures are returned, and they answer two different
// questions:
//
//   interestAccrued    — interest EARNED on loans disbursed in the period.
//                        Accrual basis. Reads loans.total_interest for
//                        loans whose disbursed_at falls in the period.
//                        Answers: "how much profit did we generate by
//                        lending this month?"
//
//   interestCollected  — interest actually RECEIVED in the period, from
//                        the Phase 2 split on repayments. Cash basis.
//                        Answers: "how much profit landed in the bank
//                        this month?"
//
// For a 1-month loan fully repaid on time, the two coincide. For a late
// payment, they diverge: earned in October, collected in November.
// Showing both side by side is what the board asked for.
async function getFinancialSummary(params) {
  const { start, end } = getPeriodRange(params);

  const [
    contributionsResult,
    disbursedResult,
    interestAccruedResult,
    repaymentsResult,
    repaymentsSplitResult,
    breakdownRows,
  ] = await Promise.all([
    db.query(
      `SELECT COALESCE(SUM(amount), 0)::bigint AS total FROM payments
       WHERE status = 'completed' AND loan_id IS NULL AND created_at >= $1 AND created_at < $2`,
      [start, end]
    ),
    db.query(
      `SELECT COALESCE(SUM(principal), 0)::bigint AS total FROM loans
       WHERE status IN ('disbursed', 'repaid') AND disbursed_at >= $1 AND disbursed_at < $2`,
      [start, end]
    ),
    // NEW — accrued interest on loans disbursed in the period.
    db.query(
      `SELECT COALESCE(SUM(total_interest), 0)::bigint AS total FROM loans
       WHERE status IN ('disbursed', 'repaid') AND disbursed_at >= $1 AND disbursed_at < $2`,
      [start, end]
    ),
    // Total repayments received in the period (unchanged — kept for the
    // existing "Repayments Received" card).
    db.query(
      `SELECT COALESCE(SUM(amount), 0)::bigint AS total FROM repayments
       WHERE created_at >= $1 AND created_at < $2`,
      [start, end]
    ),
    // NEW — split of the above into principal vs interest.
    db.query(
      `SELECT
         COALESCE(SUM(principal_paid), 0)::bigint AS principal,
         COALESCE(SUM(interest_paid), 0)::bigint AS interest
       FROM repayments
       WHERE created_at >= $1 AND created_at < $2`,
      [start, end]
    ),
    getMonthlyBreakdown(start, end),
  ]);

  const splitRow = repaymentsSplitResult.rows[0];

  return {
    period: { start: start.toISOString(), end: end.toISOString() },
    contributionsCollected: Number(contributionsResult.rows[0].total),
    loansDisbursed: Number(disbursedResult.rows[0].total),
    // NEW — the profit figures
    interestAccrued: Number(interestAccruedResult.rows[0].total),
    // Repayments split into principal vs interest (cash basis)
    repaymentsReceived: Number(repaymentsResult.rows[0].total),
    principalRepaid: Number(splitRow.principal),
    interestCollected: Number(splitRow.interest),
    breakdown: breakdownRows,
  };
}

// Month-by-month rows within [start, end) — same shape regardless of whether
// the selected period is one month, a quarter, or a full year.
//
// 2026-10-12: extended with interestAccrued, principalRepaid, and
// interestCollected so the board's Period Breakdown table can show profit
// per month. The repayment query now returns the split in one pass rather
// than two, so a month's principal and interest always come from the same
// consistent snapshot.
async function getMonthlyBreakdown(start, end) {
  const [contribRows, disbursedRows, repaySplitRows] = await Promise.all([
    db.query(
      `SELECT date_trunc('month', created_at) AS month, SUM(amount)::bigint AS total
       FROM payments WHERE status = 'completed' AND loan_id IS NULL AND created_at >= $1 AND created_at < $2
       GROUP BY month`,
      [start, end]
    ),
    db.query(
      `SELECT date_trunc('month', disbursed_at) AS month,
              SUM(principal)::bigint AS disbursed,
              SUM(total_interest)::bigint AS interest_accrued
       FROM loans WHERE status IN ('disbursed', 'repaid') AND disbursed_at >= $1 AND disbursed_at < $2
       GROUP BY month`,
      [start, end]
    ),
    db.query(
      `SELECT date_trunc('month', created_at) AS month,
              SUM(amount)::bigint AS total,
              SUM(principal_paid)::bigint AS principal,
              SUM(interest_paid)::bigint AS interest
       FROM repayments WHERE created_at >= $1 AND created_at < $2
       GROUP BY month`,
      [start, end]
    ),
  ]);

  const toMap = (rows, keyFn) => new Map(rows.map((r) => [r.month.toISOString().slice(0, 7), keyFn(r)]));

  const contribMap = toMap(contribRows.rows, (r) => Number(r.total));
  const disbursedMap = toMap(disbursedRows.rows, (r) => ({
    disbursed: Number(r.disbursed),
    interestAccrued: Number(r.interest_accrued),
  }));
  const repayMap = toMap(repaySplitRows.rows, (r) => ({
    total: Number(r.total),
    principal: Number(r.principal),
    interest: Number(r.interest),
  }));

  const months = [];
  const cursor = new Date(start);
  while (cursor < end) {
    const key = cursor.toISOString().slice(0, 7);
    const disb = disbursedMap.get(key) || { disbursed: 0, interestAccrued: 0 };
    const repay = repayMap.get(key) || { total: 0, principal: 0, interest: 0 };

    months.push({
      month: cursor.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }),
      contributions: contribMap.get(key) || 0,
      disbursed: disb.disbursed,
      interestAccrued: disb.interestAccrued,
      repayments: repay.total,
      principalRepaid: repay.principal,
      interestCollected: repay.interest,
    });
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months;
}

module.exports = { getFinancialSummary };