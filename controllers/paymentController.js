const paymentService = require('../services/paymentService');
const Payment = require('../models/Payment');
const Member = require('../models/Member');

async function initiatePayment(req, res) {
  try {
    const { memberId, amount } = req.body;
    // NOTE: phoneNumber is intentionally NOT taken from req.body anymore.
    // This endpoint has no login (a brand-new member registering has no
    // account yet, so staff-style JWT auth doesn't apply here) - which
    // previously meant nothing stopped a caller from sending an arbitrary
    // memberId alongside an arbitrary phoneNumber, triggering a real STK
    // push to any phone number they chose. Looking the member up and using
    // THEIR stored phone number closes that: the payment prompt can only
    // ever go to the phone number on file for whichever member the
    // memberId actually belongs to, never to a number the caller picks.

    if (!memberId || !amount) {
      return res.status(400).json({ error: 'memberId and amount are required' });
    }

    const numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      return res.status(400).json({ error: 'amount must be a positive number' });
    }

    const member = await Member.findById(memberId);
    if (!member) {
      return res.status(404).json({ error: 'Member not found' });
    }

    const result = await paymentService.initiatePayment({
      memberId: member.id,
      phoneNumber: member.phone_number,
      amount: numericAmount,
    });
    res.status(200).json({ message: 'STK push sent', checkoutRequestId: result.CheckoutRequestID });
  } catch (err) {
    console.error('Daraja error status:', err.response?.status);
    console.error('Daraja error data:', JSON.stringify(err.response?.data, null, 2));
    console.error('Error message:', err.message);
    res.status(500).json({ error: 'Failed to initiate payment' });
  }
}

async function getPaymentStatus(req, res) {
  try {
    const payment = await Payment.findByCheckoutId(req.params.checkoutRequestId);
    if (!payment) {
      return res.status(404).json({ error: 'Payment not found' });
    }
    res.json({ status: payment.status, mpesaReceipt: payment.mpesa_receipt });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch payment status' });
  }
}

module.exports = { initiatePayment, getPaymentStatus };