const express = require('express');
const router = express.Router();
const Withdrawal = require('../models/Withdrawal');
const Member = require('../models/Member');
const smsService = require('../services/smsService');
const { authenticate, requirePermission } = require('../middleware/auth');

// ------------------------------------------------------------
// GET /api/withdrawals/summary
// Small stat block for the Withdrawal Queue page header.
// ------------------------------------------------------------
router.get(
  '/summary',
  authenticate,
  requirePermission('withdrawals:read'),
  async (req, res) => {
    try {
      const summary = await Withdrawal.getSummary();
      res.json(summary);
    } catch (err) {
      console.error('Withdrawal summary error:', err);
      res.status(500).json({ error: 'Failed to load summary' });
    }
  }
);

// ------------------------------------------------------------
// GET /api/withdrawals/pending
// The actionable queue. Oldest first so staff work in FIFO order.
// ------------------------------------------------------------
router.get(
  '/pending',
  authenticate,
  requirePermission('withdrawals:read'),
  async (req, res) => {
    try {
      const pending = await Withdrawal.findPending();
      res.json(pending);
    } catch (err) {
      console.error('Withdrawal pending list error:', err);
      res.status(500).json({ error: 'Failed to load pending withdrawals' });
    }
  }
);

// ------------------------------------------------------------
// GET /api/withdrawals?status=processed|rejected|pending
// Full history with optional status filter.
// ------------------------------------------------------------
router.get(
  '/',
  authenticate,
  requirePermission('withdrawals:read'),
  async (req, res) => {
    try {
      const { status, limit, offset } = req.query;
      const rows = await Withdrawal.findAll({
        status: status || undefined,
        limit: limit ? Math.min(Number(limit), 500) : 100,
        offset: offset ? Number(offset) : 0,
      });
      res.json(rows);
    } catch (err) {
      console.error('Withdrawal list error:', err);
      res.status(500).json({ error: 'Failed to load withdrawals' });
    }
  }
);

// ------------------------------------------------------------
// POST /api/withdrawals/:id/process
// Staff records the real M-Pesa receipt after sending the payout.
// ------------------------------------------------------------
router.post(
  '/:id/process',
  authenticate,
  requirePermission('withdrawals:write'),
  async (req, res) => {
    try {
      const { mpesa_receipt, notes } = req.body || {};

      if (!mpesa_receipt || !mpesa_receipt.trim()) {
        return res.status(400).json({ error: 'M-Pesa receipt is required to mark a withdrawal as processed.' });
      }

      // Confirm the withdrawal exists and is still pending before transitioning
      const existing = await Withdrawal.findById(req.params.id);
      if (!existing) {
        return res.status(404).json({ error: 'Withdrawal not found' });
      }
      if (existing.status !== 'pending') {
        return res.status(409).json({
          error: `This withdrawal is already ${existing.status}.`,
        });
      }

      const updated = await Withdrawal.markProcessed(req.params.id, {
        mpesa_receipt: mpesa_receipt.trim(),
        processed_by: req.user.id,
        notes: notes || null,
      });

      if (!updated) {
        // Lost a race against another admin clicking Process simultaneously.
        return res.status(409).json({ error: 'This withdrawal was already actioned by someone else.' });
      }

      // Notify the member - isolated so an SMS outage doesn't look like a failed payout
      try {
        await smsService.sendSMS(
          updated.phone_number || (await Member.findById(updated.member_id))?.phone_number,
          smsService.templates.withdrawalProcessed
            ? smsService.templates.withdrawalProcessed(updated.amount, mpesa_receipt.trim())
            : `KEMRI SACCO: Your withdrawal of KES ${Number(updated.amount).toLocaleString()} has been sent. M-Pesa receipt: ${mpesa_receipt.trim()}.`
        );
      } catch (smsErr) {
        console.error('Withdrawal-processed SMS failed (withdrawal still processed):', smsErr.message);
      }

      res.json({ success: true, withdrawal: updated });
    } catch (err) {
      console.error('Withdrawal process error:', err);
      res.status(500).json({ error: 'Failed to process withdrawal' });
    }
  }
);

// ------------------------------------------------------------
// POST /api/withdrawals/:id/reject
// Staff rejects a withdrawal (e.g. member requested by mistake).
// ------------------------------------------------------------
router.post(
  '/:id/reject',
  authenticate,
  requirePermission('withdrawals:write'),
  async (req, res) => {
    try {
      const { notes } = req.body || {};

      const existing = await Withdrawal.findById(req.params.id);
      if (!existing) {
        return res.status(404).json({ error: 'Withdrawal not found' });
      }
      if (existing.status !== 'pending') {
        return res.status(409).json({ error: `This withdrawal is already ${existing.status}.` });
      }

      const updated = await Withdrawal.reject(req.params.id, {
        processed_by: req.user.id,
        notes: notes || null,
      });

      if (!updated) {
        return res.status(409).json({ error: 'This withdrawal was already actioned by someone else.' });
      }

      // Notify member their request was rejected
      try {
        const member = await Member.findById(updated.member_id);
        if (member) {
          await smsService.sendSMS(
            member.phone_number,
            `KEMRI SACCO: Your withdrawal request of KES ${Number(updated.amount).toLocaleString()} was declined. ${notes ? 'Reason: ' + notes : 'Please contact the office for details.'}`
          );
        }
      } catch (smsErr) {
        console.error('Withdrawal-rejected SMS failed (rejection still recorded):', smsErr.message);
      }

      res.json({ success: true, withdrawal: updated });
    } catch (err) {
      console.error('Withdrawal reject error:', err);
      res.status(500).json({ error: 'Failed to reject withdrawal' });
    }
  }
);

module.exports = router;