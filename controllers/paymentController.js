const paymentService = require('../services/paymentService');
const Payment = require('../models/Payment');

async function initiatePayment(req, res) {
  try {
    const { memberId, phoneNumber, amount } = req.body;

    if (!memberId || !phoneNumber || !amount) {
      return res.status(400).json({ error: 'memberId, phoneNumber, and amount are required' });
    }

    const result = await paymentService.initiatePayment({ memberId, phoneNumber, amount });
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