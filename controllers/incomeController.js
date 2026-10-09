const Income = require('../models/Income');

// GET /api/income/loans
// Query params: status, from, to (all optional)
//
// Returns { loans: [...], totals: {...} }. Totals are computed from the
// same rows the table renders, so the footer can never disagree with the
// visible content — the same principle behind the dashboard's "one query,
// one truth" approach.
async function listLoans(req, res) {
  try {
    const { status, from, to } = req.query;
    const loans = await Income.findAll({ status, from, to });

    const totals = loans.reduce(
      (acc, l) => ({
        count: acc.count + 1,
        principal: acc.principal + l.principal,
        interest_expected: acc.interest_expected + l.interest_expected,
        total_repaid: acc.total_repaid + l.total_repaid,
        principal_repaid: acc.principal_repaid + l.principal_repaid,
        interest_paid: acc.interest_paid + l.interest_paid,
        outstanding_balance: acc.outstanding_balance + l.outstanding_balance,
      }),
      {
        count: 0,
        principal: 0,
        interest_expected: 0,
        total_repaid: 0,
        principal_repaid: 0,
        interest_paid: 0,
        outstanding_balance: 0,
      }
    );

    res.json({ loans, totals });
  } catch (err) {
    console.error('Loan income list error:', err);
    res.status(500).json({ error: 'Failed to fetch loan income' });
  }
}

module.exports = { listLoans };