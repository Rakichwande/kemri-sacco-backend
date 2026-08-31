const Member = require('../models/Member');
const Payment = require('../models/Payment');
const Loan = require('../models/Loan');               // <-- NEW
const LoanService = require('../services/loanService'); // <-- NEW
const paymentService = require('../services/paymentService');
const smsService = require('../services/smsService');

async function handleUssd(req, res) {
  const { sessionId, phoneNumber, text } = req.body;
  const input = (text || '').split('*').filter(Boolean);

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
          response = await handleApplyLoan(phoneNumber, steps); // <-- REPLACED
          break;
        case '5':
          response = await handleRepayLoan(phoneNumber, steps); // <-- REPLACED
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

  res.set('Content-Type', 'text/plain');
  res.send(response);
}

function mainMenu() {
  return (
    'CON Welcome to KEMRI SACCO\n' +
    '1. Register\n' +
    '2. Balance\n' +
    '3. Deposit\n' +
    '4. Apply Loan\n' +       // <-- UPDATED text
    '5. Repay Loan\n' +       // <-- UPDATED text
    '6. Transactions\n' +
    '7. Exit'
  );
}

// --------------------------------------------------------------
// 1. REGISTER (UNCHANGED - uses your exact logic)
// --------------------------------------------------------------
async function handleRegister(phoneNumber, steps) {
  const existing = await Member.findByPhone(phoneNumber);
  if (existing) {
    return 'END This phone number is already registered with KEMRI SACCO.';
  }

  if (steps.length === 0) {
    return 'CON Enter your full name';
  }

  if (steps.length === 1) {
    return 'CON Enter your ID number';
  }

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

    try {
      await smsService.sendSMS(phoneNumber, smsService.templates.applicationReceived(full_name));
    } catch (smsErr) {
      console.error('USSD registration SMS failed (member still registered):', smsErr.message);
    }

    return `END Thank you, ${full_name}. Your registration is received. Ref: KSC-${String(member.id).padStart(5, '0')}. Visit our portal to complete your application.`;
  }

  return 'END Invalid input. Please dial again.';
}

// --------------------------------------------------------------
// 2. BALANCE (UNCHANGED)
// --------------------------------------------------------------
async function handleBalance(phoneNumber) {
  const member = await Member.findByPhone(phoneNumber);
  if (!member) {
    return 'END You are not registered. Dial and select option 1 to register first.';
  }

  const balance = await Payment.getMemberBalance(member.id);
  const balanceText = `Your KEMRI SACCO balance is KES ${balance.toLocaleString()}.`;

  try {
    await smsService.sendSMS(phoneNumber, balanceText);
  } catch (smsErr) {
    console.error('USSD balance SMS failed (still shown on screen):', smsErr.message);
  }

  return `END ${balanceText}`;
}

// --------------------------------------------------------------
// 3. DEPOSIT (UNCHANGED)
// --------------------------------------------------------------
async function handleDeposit(phoneNumber, steps) {
  const member = await Member.findByPhone(phoneNumber);
  if (!member) {
    return 'END You are not registered. Dial and select option 1 to register first.';
  }

  if (steps.length === 0) {
    return 'CON Enter amount to deposit (KES)';
  }

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

// --------------------------------------------------------------
// 4. APPLY LOAN (NEW)
// --------------------------------------------------------------
async function handleApplyLoan(phoneNumber, steps) {
  // Step 0: Check if member exists
  const member = await Member.findByPhone(phoneNumber);
  if (!member) {
    return 'END You are not registered. Dial and select option 1 to register first.';
  }

  // Step 1: Check eligibility (active loans, credit limit)
  const eligibility = await LoanService.canApply(member.id);
  if (!eligibility.allowed) {
    return `END ${eligibility.reason}`;
  }

  // Step 2: If no input yet, ask for the amount
  if (steps.length === 0) {
    return `CON Enter amount to borrow (Min: 1000, Max: ${eligibility.creditLimit}):`;
  }

  // Step 3: Validate the amount entered
  if (steps.length === 1) {
    const amount = Number(steps[0]);

    if (isNaN(amount) || amount < 1000 || amount > eligibility.creditLimit) {
      return `END Invalid amount. Must be between KES 1000 and ${eligibility.creditLimit}.`;
    }

    // Calculate the repayment schedule to show the user
    const schedule = LoanService.calculateRepaymentSchedule(amount);
    return `CON You will pay KES ${schedule.monthlyInstallment} monthly for 3 months.\nTotal repayment: KES ${schedule.totalRepayment}.\nReply 1 to confirm.`;
  }

  // Step 4: User confirmed (replied '1')
  if (steps.length === 2 && steps[1] === '1') {
    const amount = Number(steps[0]);
    const result = await LoanService.apply(member.id, amount);

    if (!result.success) {
      return `END ${result.message}`;
    }

    // Send SMS confirmation to member
    try {
      await smsService.sendSMS(
        phoneNumber,
        `KEMRI SACCO: Your loan of KES ${amount} has been submitted. Monthly installment: KES ${result.loan.monthly_installment}. Awaiting admin approval.`
      );
    } catch (smsErr) {
      console.error('Loan application SMS failed:', smsErr.message);
    }

    return `END Loan submitted! Amount: KES ${result.loan.principal}, Monthly: KES ${result.loan.monthly_installment}. Awaiting admin approval.`;
  }

  return 'END Invalid input. Please dial again.';
}

// --------------------------------------------------------------
// 5. REPAY LOAN (NEW)
// --------------------------------------------------------------
async function handleRepayLoan(phoneNumber, steps) {
  // Step 0: Check if member exists
  const member = await Member.findByPhone(phoneNumber);
  if (!member) {
    return 'END You are not registered. Dial and select option 1 to register first.';
  }

  // Step 1: Check for an active loan
  const activeLoan = await Loan.getActiveLoan(member.id);
  if (!activeLoan) {
    return 'END You have no active loan.';
  }

  // Calculate the amount due this month (min of installment or remaining balance)
  const dueAmount = Math.min(activeLoan.monthly_installment, activeLoan.outstanding_balance);

  // Step 2: Show outstanding details and ask for confirmation
  if (steps.length === 0) {
    return `CON Outstanding: KES ${activeLoan.outstanding_balance}\nDue this month: KES ${dueAmount}\nReply 1 to pay KES ${dueAmount} via M-Pesa.`;
  }

  // Step 3: User confirmed (replied '1')
  if (steps.length === 1 && steps[0] === '1') {
    try {
      // Trigger STK Push for the due amount
      await paymentService.initiatePayment({
        memberId: member.id,
        phoneNumber,
        amount: dueAmount,
      });
      return `END STK Push sent for KES ${dueAmount}. Please complete payment on your phone.`;
    } catch (err) {
      console.error('USSD loan repayment STK push failed:', err.message);
      return 'END We could not process your repayment. Please try again shortly.';
    }
  }

  return 'END Invalid input. Please dial again.';
}

// --------------------------------------------------------------
// 6. TRANSACTIONS (UNCHANGED)
// --------------------------------------------------------------
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