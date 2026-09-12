const express = require('express');
const router = express.Router();
const Report = require('../models/Report');
const { authenticate, requireAdmin } = require('../middleware/auth');

function validatePeriodParams(req, res) {
  const { periodType = 'month', year, month, quarter } = req.query;
  if (!year) {
    res.status(400).json({ error: 'year is required' });
    return null;
  }
  if (periodType === 'month' && !month) {
    res.status(400).json({ error: 'month is required when periodType=month' });
    return null;
  }
  if (periodType === 'quarter' && !quarter) {
    res.status(400).json({ error: 'quarter is required when periodType=quarter' });
    return null;
  }
  return { periodType, year, month, quarter };
}

router.get('/financial', authenticate, requireAdmin, async (req, res) => {
  try {
    const params = validatePeriodParams(req, res);
    if (!params) return;
    const summary = await Report.getFinancialSummary(params);
    res.json(summary);
  } catch (err) {
    console.error('Financial report error:', err);
    res.status(500).json({ error: 'Failed to generate report' });
  }
});

// Hand-built CSV - no library needed for something this simple, and it
// avoids adding a new dependency just for one export button.
router.get('/financial/export', authenticate, requireAdmin, async (req, res) => {
  try {
    const params = validatePeriodParams(req, res);
    if (!params) return;
    const summary = await Report.getFinancialSummary(params);

    const escapeCsv = (val) => `"${String(val).replace(/"/g, '""')}"`;
    const lines = [
      ['Month', 'Contributions (KES)', 'Loans Disbursed (KES)', 'Repayments (KES)'].map(escapeCsv).join(','),
      ...summary.breakdown.map((row) =>
        [row.month, row.contributions, row.disbursed, row.repayments].map(escapeCsv).join(',')
      ),
      '',
      ['Total', summary.contributionsCollected, summary.loansDisbursed, summary.repaymentsReceived].map(escapeCsv).join(','),
    ];

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="kemri-sacco-financial-report.csv"`);
    res.send(lines.join('\n'));
  } catch (err) {
    console.error('Financial report export error:', err);
    res.status(500).json({ error: 'Failed to export report' });
  }
});

module.exports = router;
