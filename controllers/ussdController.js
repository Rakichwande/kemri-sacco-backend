const Member = require('../models/Member');
const Payment = require('../models/Payment');
const Loan = require('../models/Loan');
const paymentService = require('../services/paymentService');
const LoanService = require('../services/loanService');
const smsService = require('../services/smsService');
const UssdSession = require('../models/UssdSession');

// Heuristic for whether a USSD response represents a failed step, based on
// the response text itself - there's no separate error flag in the Africa's
// Talking response format (just CON/END + a message), so this is the most
// honest signal available without changing the underlying menu logic.
const FAILURE_PHRASES = ['invalid', 'wrong', 'failed', 'error', 'something went wrong', 'not found', 'insufficient'];
function looksLikeFailure(responseText) {
  const lower = responseText.toLowerCase();
  return FAILURE_PHRASES.some((phrase) => lower.includes(phrase));
}

async function handleUssd(req, res) {
  const { sessionId, phoneNumber, serviceCode, text } = req.body;
  const input = (text || '').split('*').filter(Boolean);
  const startedAt = Date.now();

  let response;

  try {
    if (input.length === 0) {
      response = mainMenu();
    } else {
      const choice = input[0];
      const steps = input.slice(1);

      switch (choice) {
        case '1':
          response = await handleRegister(phoneNumber, steps);
          break;
        case '2':
          response = await handleBalance(phoneNumber);
          break;
        case '3':
          response = await handleDeposit(phoneNumber, steps);
          break;
        case '4':
          response = await handleLoanApplication(phoneNumber, steps);
          break;
        case '5':
          response = await handleRepayLoan(phoneNumber, steps);
          break;
        case '6':
          response = await handleTransactions(phoneNumber);
          break;
        case '7':
          response = 'END Thank you for using KEMRI SACCO. Goodbye.';
          break;
        default:
          response = 'END Invalid choice. Please dial again.';
      }
    }
  } catch (err) {
    console.error('USSD error:', err);
    response = 'END Something went wrong. Please try again shortly.';
  }

  UssdSession.log({
    sessionId,
    phoneNumber,
    serviceCode,
    inputText: text || '',
    status: looksLikeFailure(response) ? 'failed' : 'success',
    durationMs: Date.now() - startedAt,
    message: response.replace(/^(CON|END)\s*/, '').split('\n')[0].slice(0, 300),
  });

  res.set('Content-Type', 'text/plain');
  res.send(response);
}

function mainMenu() {
  return (
    'CON Welcome to KEMRI SACCO\n' +
    '1. Register\n' +
    '2. Balance\n' +
    '3. Deposit\n' +
    '4. Loan\n' +
    '5. Repay Loan\n' +
    '6. Transactions\n' +
    '7. Exit'
  );
}

// ============================================================
// 1. REGISTER
// ============================================================
async function handleRegister(phoneNumber, steps) {
  const existing = await Member.findByPhone(phoneNumber);
  if (existing) {
    return 'END This phone number is already registered with KEMRI SACCO.';
  }

  if (steps.length === 0) return 'CON Enter your full name';
  if (steps.length === 1) return 'CON Enter your ID number';

  if (steps.length === 2) {
    const [full_name, id_number] = steps;

    if (!/^\d{6,10}$/.test(id_number)) {
      return 'END Invalid ID number. Please dial again and enter 6-10 digits.';
    }

    const member = await Member.create({
      full_name,
      id_number,
      phone_number: phoneNumber,
      scheme: 'holiday_savings',
    });

    // Send registration SMS using the template
    try {
      await smsService.sendSMS(phoneNumber, smsService.templates.applicationReceived(full_name));
    } catch (smsErr) {
      console.error('USSD registration SMS failed (member still registered):', smsErr.message);
    }

    return `END Thank you, ${full_name}. Your registration is received. Ref: KSC-${String(member.id).padStart(5, '0')}. Visit our portal to complete your application.`;
  }

  return 'END Invalid input. Please dial again.';
}

// ============================================================
// 2. BALANCE
// ============================================================
async function handleBalance(phoneNumber) {
  const member = await Member.findByPhone(phoneNumber);
  if (!member) {
    return 'END You are not registered. Dial and select option 1 to register first.';
  }

  const balance = await Payment.getMemberBalance(member.id);
  const balanceText = `Your KEMRI SACCO balance is KES ${balance.toLocaleString()}.`;

  // Send the balance via SMS (simple, no template needed)
  try {
    await smsService.sendSMS(phoneNumber, balanceText);
  } catch (smsErr) {
    console.error('USSD balance SMS failed (still shown on screen):', smsErr.message);
  }

  return `END ${balanceText}`;
}

// ============================================================
// 3. DEPOSIT
// ============================================================
async function handleDeposit(phoneNumber, steps) {
  const member = await Member.findByPhone(phoneNumber);
  if (!member) {
    return 'END You are not registered. Dial and select option 1 to register first.';
  }

  if (steps.length === 0) return 'CON Enter amount to deposit (KES)';

  if (steps.length === 1) {
    const amount = Number(steps[0]);
    if (!amount || amount <= 0) {
      return 'END Invalid amount. Please dial again.';
    }

    try {
      await paymentService.initiatePayment({ memberId: member.id, phoneNumber, amount });
      return 'END An M-Pesa prompt has been sent to your phone. Enter your PIN to complete the deposit.';
    } catch (err) {
      console.error('USSD deposit STK push failed - status:', err.response?.status);
      console.error('USSD deposit STK push failed - data:', JSON.stringify(err.response?.data));
      console.error('USSD deposit STK push failed - message:', err.message);
      return 'END We could not process your deposit right now. Please try again shortly.';
    }
  }

  return 'END Invalid input. Please dial again.';
}

// ============================================================
// 4. LOAN APPLICATION (UPDATED WITH NEW SMS TEMPLATE)
// ============================================================
async function handleLoanApplication(phoneNumber, steps) {
  const member = await Member.findByPhone(phoneNumber);
  if (!member) {
    return 'END You are not registered. Dial and select option 1 to register first.';
  }

  if (steps.length === 0) return 'CON Enter loan amount (KES)';

  if (steps.length === 1) {
    const amount = Number(steps[0]);
    if (!amount || amount <= 0) {
      return 'END Invalid amount. Please dial again.';
    }

    const result = await LoanService.apply(member.id, amount);

    if (!result.success) {
      return `END ${result.message}`;
    }

    const { loan } = result;
    const ref = `LN-${String(loan.id).padStart(5, '0')}`;

    const summary =
      `Loan approved for application: KES ${Number(loan.principal).toLocaleString()}\n` +
      `Total repayable (incl. interest): KES ${Number(loan.total_repayment).toLocaleString()}\n` +
      `Over ${loan.tenure_months} months, ~KES ${Number(loan.monthly_installment).toLocaleString()}/month\n` +
      `Ref: ${ref}. Awaiting SACCO review.`;

    // Send SMS using the new loan application template
    try {
      await smsService.sendSMS(
        phoneNumber,
        smsService.templates.loanApplicationReceived(member.full_name, loan.principal, ref)
      );
    } catch (smsErr) {
      console.error('USSD loan application SMS failed (application still recorded):', smsErr.message);
    }

    return `END ${summary}`;
  }

  return 'END Invalid input. Please dial again.';
}

// ============================================================
// 5. REPAY LOAN
// ============================================================
async function handleRepayLoan(phoneNumber, steps) {
  const member = await Member.findByPhone(phoneNumber);
  if (!member) {
    return 'END You are not registered. Dial and select option 1 to register first.';
  }

  const activeLoan = await Loan.getActiveLoan(member.id);
  if (!activeLoan) {
    return 'END You have no outstanding loan to repay.';
  }

  if (steps.length === 0) {
    return `CON Outstanding balance: KES ${Number(activeLoan.outstanding_balance).toLocaleString()}\nEnter amount to repay`;
  }

  if (steps.length === 1) {
    const amount = Number(steps[0]);
    if (!amount || amount <= 0) {
      return 'END Invalid amount. Please dial again.';
    }

    try {
      await paymentService.initiatePayment({
        memberId: member.id,
        phoneNumber,
        amount,
        loanId: activeLoan.id,
      });
      return 'END An M-Pesa prompt has been sent to your phone. Enter your PIN to complete the repayment.';
    } catch (err) {
      console.error('USSD loan repayment STK push failed:', err.message);
      return 'END We could not process your repayment right now. Please try again shortly.';
    }
  }

  return 'END Invalid input. Please dial again.';
}

// ============================================================
// 6. TRANSACTIONS
// ============================================================
async function handleTransactions(phoneNumber) {
  const member = await Member.findByPhone(phoneNumber);
  if (!member) {
    return 'END You are not registered. Dial and select option 1 to register first.';
  }

  const transactions = await Payment.findRecentByMember(member.id, 5);
  if (transactions.length === 0) {
    return 'END You have no transactions yet.';
  }

  const lines = transactions.map((t) => {
    const date = new Date(t.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
    return `${date}: KES ${Number(t.amount).toLocaleString()} (${t.status})`;
  });

  return `END Recent transactions:\n${lines.join('\n')}`;
}

module.exports = { handleUssd };