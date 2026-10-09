const db = require('../config/database');
const Member = require('./Member');

// Aggregated per-loan income view for the Loan Income page.
//
// Returns one row per loan with: the member, the loan's principal, term,
// rate, expected interest (loans.total_interest), and the actual amount
// repaid against it (SUM of the Phase 2 repayments ledger).
//
// Totals are computed by the controller from the same rows, so the footer
// always agrees with the table — no risk of drift between two queries.
//
// Filters (all optional):
//   status — exact match on loans.status. 'all' or omitted = no filter.
//   from   — inclusive lower bound on disbursed_at (ISO date or timestamp)
//   to     — inclusive upper bound on disbursed_at
//
// Loans with no repayments yet (pending, approved, disbursing, disbursed-
// not-yet-paid, rejected) return zeroes from the COALESCE on the repayments
// subquery — the LEFT JOIN preserves them in the output so the board sees
// the whole book, not just repaid loans.
async function findAll({ status, from, to } = {}) {
  const conditions = [];
  const values = [];
  let i = 1;

  if (status && status !== 'all') {
    conditions.push(`l.status = $${i++}`);
    values.push(status);
  }
  if (from) {
    conditions.push(`l.disbursed_at >= $${i++}`);
    values.push(from);
  }
  if (to) {
    conditions.push(`l.disbursed_at <= $${i++}`);
    values.push(to);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  // Repayments aggregated in a subquery rather than a GROUP BY on the
  // outer query — avoids GROUP BY complications with Member.REFERENCE_SQL,
  // which may reference a column that isn't functionally dependent on the
  // PK in a way Postgres recognises.
  const result = await db.query(
    `SELECT
       l.id,
       'LN-' || LPAD(l.id::text, 5, '0') AS reference,
       l.principal,
       l.interest_rate,
       l.tenure_months,
       l.total_interest,
       l.total_repayment,
       l.outstanding_balance,
       l.amount_paid,
       l.status,
       l.applied_at,
       l.disbursed_at,
       l.repaid_at,
       m.id AS member_id,
       m.full_name,
       ${Member.REFERENCE_SQL} AS member_reference,
       COALESCE(r.total_repaid, 0)::bigint AS total_repaid,
       COALESCE(r.principal_repaid, 0)::bigint AS principal_repaid,
       COALESCE(r.interest_paid, 0)::bigint AS interest_paid
     FROM loans l
     LEFT JOIN members m ON m.id = l.member_id
     LEFT JOIN (
       SELECT
         loan_id,
         SUM(amount) AS total_repaid,
         SUM(principal_paid) AS principal_repaid,
         SUM(interest_paid) AS interest_paid
       FROM repayments
       GROUP BY loan_id
     ) r ON r.loan_id = l.id
     ${where}
     ORDER BY l.disbursed_at DESC NULLS LAST, l.id DESC`,
    values
  );

  return result.rows.map((row) => ({
    id: row.id,
    reference: row.reference,
    member_id: row.member_id,
    member_name: row.full_name || `Member #${row.member_id}`,
    member_reference: row.member_reference,
    principal: Number(row.principal),
    interest_rate: Number(row.interest_rate),
    tenure_months: row.tenure_months,
    interest_expected: Number(row.total_interest),
    total_repayment: Number(row.total_repayment),
    outstanding_balance: Number(row.outstanding_balance),
    amount_paid: Number(row.amount_paid),
    total_repaid: Number(row.total_repaid),
    principal_repaid: Number(row.principal_repaid),
    interest_paid: Number(row.interest_paid),
    status: row.status,
    applied_at: row.applied_at,
    disbursed_at: row.disbursed_at,
    repaid_at: row.repaid_at,
  }));
}

module.exports = { findAll };