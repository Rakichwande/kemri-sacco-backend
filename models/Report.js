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

async function getFinancialSummary(params) {
  const { start, end } = getPeriodRange(params);

  const [contributionsResult, disbursedResult, repaymentsResult, breakdownRows] = await Promise.all([
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
    db.query(
      `SELECT COALESCE(SUM(amount), 0)::bigint AS total FROM repayments
       WHERE created_at >= $1 AND created_at < $2`,
      [start, end]
    ),
    getMonthlyBreakdown(start, end),
  ]);

  return {
    period: { start: start.toISOString(), end: end.toISOString() },
    contributionsCollected: Number(contributionsResult.rows[0].total),
    loansDisbursed: Number(disbursedResult.rows[0].total),
    repaymentsReceived: Number(repaymentsResult.rows[0].total),
    breakdown: breakdownRows,
  };
}

// Month-by-month rows within [start, end) - same shape regardless of whether
// the selected period is one month, a quarter, or a full year.
async function getMonthlyBreakdown(start, end) {
  const [contribRows, disbursedRows, repayRows] = await Promise.all([
    db.query(
      `SELECT date_trunc('month', created_at) AS month, SUM(amount)::bigint AS total
       FROM payments WHERE status = 'completed' AND loan_id IS NULL AND created_at >= $1 AND created_at < $2
       GROUP BY month`,
      [start, end]
    ),
    db.query(
      `SELECT date_trunc('month', disbursed_at) AS month, SUM(principal)::bigint AS total
       FROM loans WHERE status IN ('disbursed', 'repaid') AND disbursed_at >= $1 AND disbursed_at < $2
       GROUP BY month`,
      [start, end]
    ),
    db.query(
      `SELECT date_trunc('month', created_at) AS month, SUM(amount)::bigint AS total
       FROM repayments WHERE created_at >= $1 AND created_at < $2
       GROUP BY month`,
      [start, end]
    ),
  ]);

  const toMap = (rows) => new Map(rows.map((r) => [r.month.toISOString().slice(0, 7), Number(r.total)]));
  const contribMap = toMap(contribRows.rows);
  const disbursedMap = toMap(disbursedRows.rows);
  const repayMap = toMap(repayRows.rows);

  const months = [];
  const cursor = new Date(start);
  while (cursor < end) {
    const key = cursor.toISOString().slice(0, 7);
    months.push({
      month: cursor.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }),
      contributions: contribMap.get(key) || 0,
      disbursed: disbursedMap.get(key) || 0,
      repayments: repayMap.get(key) || 0,
    });
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months;
}

module.exports = { getFinancialSummary };
