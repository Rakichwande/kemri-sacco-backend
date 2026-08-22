const darajaService = require('./darajaService');
const smsService = require('./smsService');
const Payment = require('../models/Payment');
const Member = require('../models/Member');

async function initiatePayment({ memberId, phoneNumber, amount }) {
  const stkResponse = await darajaService.stkPush({
    phoneNumber,
    amount,
    accountReference: `SACCO-${memberId}`,
    description: 'Holiday Savings Scheme contribution',
  });

  await Payment.create({
    member_id: memberId,
    amount,
    phone_number: phoneNumber,
    checkout_request_id: stkResponse.CheckoutRequestID,
  });

  return stkResponse;
}

// Called by the Daraja webhook once Safaricom confirms the transaction outcome
async function handleCallback(callbackBody) {
  const stkCallback = callbackBody.Body.stkCallback;
  const checkoutRequestId = stkCallback.CheckoutRequestID;
  const resultCode = stkCallback.ResultCode; // 0 = success

  const payment = await Payment.findByCheckoutId(checkoutRequestId);
  if (!payment) {
    console.error('Webhook received for unknown checkout ID:', checkoutRequestId);
    return;
  }

  const member = await Member.findById(payment.member_id);

  if (resultCode === 0) {
    const items = stkCallback.CallbackMetadata.Item;
    const mpesaReceipt = items.find((i) => i.Name === 'MpesaReceiptNumber')?.Value;

    await Payment.updateStatus(checkoutRequestId, 'completed', mpesaReceipt);

    if (member) {
      await smsService.sendSMS(
        member.phone_number,
        smsService.templates.paymentConfirmed(member.full_name, payment.amount, `SACCO-${payment.member_id}`, mpesaReceipt)
      );
    }
  } else {
    await Payment.updateStatus(checkoutRequestId, 'failed');

    if (member) {
      await smsService.sendSMS(
        member.phone_number,
        smsService.templates.paymentFailed(member.full_name)
      );
    }
  }
}

module.exports = { initiatePayment, handleCallback };
