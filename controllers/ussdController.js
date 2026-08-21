const Member = require('../models/Member');
const Payment = require('../models/Payment');
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
        case '5':
          response = 'END This feature is coming soon. Please contact the SACCO office for loan services.';
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
    '4. Loan\n' +
    '5. Repay Loan\n' +
    '6. Transactions\n' +
    '7. Exit'
  );
}

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

async function handleBalance(phoneNumber) {
  const member = await Member.findByPhone(phoneNumber);
  if (!member) {
    return 'END You are not registered. Dial and select option 1 to register first.';
  }

  const balance = await Payment.getMemberBalance(member.id);
  return `END Your KEMRI SACCO balance is KES ${balance.toLocaleString()}.`;
}

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
      console.error('USSD deposit STK push failed:', err.message);
      return 'END We could not process your deposit right now. Please try again shortly.';
    }
  }

  return 'END Invalid input. Please dial again.';
}

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