const express = require('express');
const router = express.Router();
const Report = require('../models/Report');
const AgingService = require('../services/agingService');
const { authenticate, requirePermission } = require('../middleware/auth');

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

router.get('/financial', authenticate, requirePermission('reports:read'), async (req, res) => {
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
router.get('/financial/export', authenticate, requirePermission('reports:read'), async (req, res) => {
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

// Loan aging report — groups all currently-disbursed loans into buckets
// by how long the member has been behind on their repayment schedule.
// No query params: the report always reflects "now." A point-in-time
// historical aging report would need a snapshot table; not built yet.
//
// Returns a bucketed breakdown plus the individual loans in each bucket.
// The bucket definitions reuse the tolerance logic from reminderService
// (see services/agingService.js) so staff never see a loan marked
// "current" here while receiving overdue reminders about it.
router.get('/aging', authenticate, requirePermission('reports:read'), async (req, res) => {
  try {
    const report = await AgingService.getAgingReport();
    res.json(report);
  } catch (err) {
    console.error('Aging report error:', err);
    res.status(500).json({ error: 'Failed to generate aging report' });
  }
});

module.exports = router;