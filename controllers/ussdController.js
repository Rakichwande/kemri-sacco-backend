const Member = require('../models/Member');
const Payment = require('../models/Payment');
const Loan = require('../models/Loan');
const paymentService = require('../services/paymentService');
const LoanService = require('../services/loanService');
const smsService = require('../services/smsService');
const UssdSession = require('../models/UssdSession');
const notificationService = require('../services/notificationService');
const emailService = require('../services/emailService');

// Heuristic for whether a USSD response represents a failed step, based on
// the response text itself - there's no separate error flag in the Africa's
// Talking response format (just CON/END + a message), so this is the most
// honest signal available without changing the underlying menu logic.
const FAILURE_PHRASES = [
  'invalid', 'wrong', 'failed', 'error', 'something went wrong', 'not found',
  'insufficient', 'incorrect', 'locked', 'did not match',
];
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
          response = await handleBalance(phoneNumber, steps);
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
          response = await handleTransactions(phoneNumber, steps);
          break;
        case '7':
          response = await handleChangePin(phoneNumber, steps);
          break;
        case '8':
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
    '7. Change PIN\n' +
    '8. Exit'
  );
}

// ============================================================
// PIN AUTHENTICATION - shared by every menu option that exposes financial
// information or commits to a financial action. The USSD session itself
// (phoneNumber matching a member record) is NOT treated as sufficient
// authentication - a phone can be lost, stolen, borrowed, or subject to
// SIM-swap fraud. This is the actual "who is this" check.
//
// USSD has no server-side session state between requests - Africa's
// Talking resends the full accumulated `text` every time, and this
// controller re-parses it into `steps` on each call. That means a
// multi-step PIN flow (enter PIN, or for first-time setup: enter new PIN,
// then confirm it) has to be driven by how many steps have accumulated so
// far, the same way every other multi-step menu here already works.
//
// Returns:
//   { authenticated: true, remainingSteps }  - PIN check passed (or a PIN
//     was just set for the first time); remainingSteps is what's left of
//     `steps` for the calling handler's OWN step logic to consume, as if
//     the PIN step(s) had never been there.
//   { authenticated: false, response }  - not done yet (need more input)
//     or failed; `response` is the CON/END text to return immediately.
async function requirePin(member, steps) {
  if (!Member.hasPinSet(member)) {
    // First-time setup: steps[0] = new PIN, steps[1] = confirmation.
    if (steps.length === 0) {
      return { authenticated: false, response: 'CON No SACCO PIN set yet.\nEnter a new 4-digit PIN:' };
    }
    if (steps.length === 1) {
      if (!/^\d{4}$/.test(steps[0])) {
        return { authenticated: false, response: 'END PIN must be exactly 4 digits. Please dial again.' };
      }
      return { authenticated: false, response: 'CON Confirm your new PIN:' };
    }
    if (steps.length === 2) {
      if (steps[0] !== steps[1]) {
        return { authenticated: false, response: 'END PINs did not match. Please dial again to try once more.' };
      }
      await Member.setPin(member.id, steps[0]);
      return { authenticated: true, remainingSteps: steps.slice(2) };
    }
    return { authenticated: false, response: 'END Invalid input. Please dial again.' };
  }

  // Existing PIN on file.
  if (Member.isPinLocked(member)) {
    return {
      authenticated: false,
      response: 'END Too many incorrect PIN attempts. Locked for 30 minutes - please try again later or visit our office.',
    };
  }
  if (steps.length === 0) {
    return { authenticated: false, response: 'CON Enter your SACCO PIN:' };
  }

  const submittedPin = steps[0];
  const valid = await Member.verifyPin(member, submittedPin);
  if (!valid) {
    const updated = await Member.recordFailedPinAttempt(member.id);
    if (Member.isPinLocked(updated)) {
      return {
        authenticated: false,
        response: 'END Incorrect PIN. Too many attempts - your account is now locked for 30 minutes.',
      };
    }
    return { authenticated: false, response: 'END Incorrect PIN. Please dial again to retry.' };
  }

  await Member.resetPinAttempts(member.id);
  return { authenticated: true, remainingSteps: steps.slice(1) };
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
    notificationService.notifyStaff({
      smsText: smsService.templates.staffNewMember(full_name),
      emailContent: emailService.staffTemplates.newMember(full_name),
    });

    const memberRef = `KEMRI-${new Date(member.created_at).getFullYear()}-${String(member.id).padStart(4, '0')}`;
    return `END Thank you, ${full_name}. Your registration is received. Ref: ${memberRef}. Visit our portal to complete your application.\nYou'll set a SACCO PIN the first time you check your balance or apply for a loan.`;
  }

  return 'END Invalid input. Please dial again.';
}

// ============================================================
// 2. BALANCE (PIN required)
// ============================================================
async function handleBalance(phoneNumber, steps) {
  const member = await Member.findByPhone(phoneNumber);
  if (!member) {
    return 'END You are not registered. Dial and select option 1 to register first.';
  }

  const pinCheck = await requirePin(member, steps);
  if (!pinCheck.authenticated) return pinCheck.response;

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
// No SACCO PIN gate here by design: completing a deposit already requires
// the member's real M-Pesa PIN on their own phone via the Daraja STK
// prompt itself - a genuine, independent second factor. Adding the SACCO
// PIN on top is reasonable future hardening but was left out of this pass
// to keep the change reviewable; the un-gated menu options above (balance,
// transactions) and the ones that commit to new debt (loan
// application/repayment) had zero protection at all and were the priority.
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
// 4. LOAN APPLICATION (PIN required)
// ============================================================
async function handleLoanApplication(phoneNumber, steps) {
  const member = await Member.findByPhone(phoneNumber);
  if (!member) {
    return 'END You are not registered. Dial and select option 1 to register first.';
  }

  const pinCheck = await requirePin(member, steps);
  if (!pinCheck.authenticated) return pinCheck.response;
  const remaining = pinCheck.remainingSteps;

  if (remaining.length === 0) return 'CON Enter loan amount (KES)';

  if (remaining.length === 1) {
    const amount = Number(remaining[0]);
    if (!amount || amount <= 0) {
      return 'END Invalid amount. Please dial again.';
    }

    const result = await LoanService.apply(member.id, amount);

    if (!result.success) {
      return `END ${result.message}`;
    }

    const { loan } = result;
    const ref = `KEMRI-${new Date(loan.applied_at).getFullYear()}-${String(loan.member_id).padStart(4, '0')}`;

    const summary =
      `Loan application received: KES ${Number(loan.principal).toLocaleString()}\n` +
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
    notificationService.notifyStaff({
      smsText: smsService.templates.staffLoanApplication(member.full_name, loan.principal, ref),
      emailContent: emailService.staffTemplates.loanApplication(member.full_name, loan.principal, ref),
    });

    return `END ${summary}`;
  }

  return 'END Invalid input. Please dial again.';
}

// ============================================================
// 5. REPAY LOAN (PIN required)
// ============================================================
async function handleRepayLoan(phoneNumber, steps) {
  const member = await Member.findByPhone(phoneNumber);
  if (!member) {
    return 'END You are not registered. Dial and select option 1 to register first.';
  }

  const pinCheck = await requirePin(member, steps);
  if (!pinCheck.authenticated) return pinCheck.response;
  const remaining = pinCheck.remainingSteps;

  const activeLoan = await Loan.getActiveLoan(member.id);
  if (!activeLoan) {
    return 'END You have no outstanding loan to repay.';
  }

  if (remaining.length === 0) {
    return `CON Outstanding balance: KES ${Number(activeLoan.outstanding_balance).toLocaleString()}\nEnter amount to repay`;
  }

  if (remaining.length === 1) {
    const amount = Number(remaining[0]);
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
// 6. TRANSACTIONS (PIN required)
// ============================================================
async function handleTransactions(phoneNumber, steps) {
  const member = await Member.findByPhone(phoneNumber);
  if (!member) {
    return 'END You are not registered. Dial and select option 1 to register first.';
  }

  const pinCheck = await requirePin(member, steps);
  if (!pinCheck.authenticated) return pinCheck.response;

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

// ============================================================
// 7. CHANGE PIN
// ============================================================
// Requires the CURRENT PIN before accepting a new one - never a silent
// overwrite, same principle as the staff change-password endpoint.
async function handleChangePin(phoneNumber, steps) {
  const member = await Member.findByPhone(phoneNumber);
  if (!member) {
    return 'END You are not registered. Dial and select option 1 to register first.';
  }

  if (!Member.hasPinSet(member)) {
    return 'END No SACCO PIN set yet. Check your balance or apply for a loan first to set one.';
  }

  if (Member.isPinLocked(member)) {
    return 'END Too many incorrect PIN attempts. Locked for 30 minutes - please try again later.';
  }

  if (steps.length === 0) return 'CON Enter your CURRENT SACCO PIN:';

  if (steps.length === 1) {
    const valid = await Member.verifyPin(member, steps[0]);
    if (!valid) {
      const updated = await Member.recordFailedPinAttempt(member.id);
      if (Member.isPinLocked(updated)) {
        return 'END Incorrect PIN. Too many attempts - your account is now locked for 30 minutes.';
      }
      return 'END Incorrect PIN. Please dial again to retry.';
    }
    return 'CON Enter your NEW 4-digit PIN:';
  }

  if (steps.length === 2) {
    // steps[0] already verified above on the previous request - re-verify
    // here too since USSD resends the full accumulated text each time and
    // this is a fresh server-side evaluation of it, not a continuation of
    // in-memory state.
    const valid = await Member.verifyPin(member, steps[0]);
    if (!valid) {
      return 'END Incorrect current PIN. Please dial again to retry.';
    }
    if (!/^\d{4}$/.test(steps[1])) {
      return 'END New PIN must be exactly 4 digits. Please dial again.';
    }
    return 'CON Confirm your new PIN:';
  }

  if (steps.length === 3) {
    const valid = await Member.verifyPin(member, steps[0]);
    if (!valid) {
      return 'END Incorrect current PIN. Please dial again to retry.';
    }
    if (steps[1] !== steps[2]) {
      return 'END New PINs did not match. Please dial again to try once more.';
    }
    await Member.resetPinAttempts(member.id);
    await Member.setPin(member.id, steps[1]);
    try {
      await smsService.sendSMS(phoneNumber, 'KEMRI SACCO: Your PIN was changed successfully. If this wasn\'t you, contact us immediately.');
    } catch (smsErr) {
      console.error('PIN-change confirmation SMS failed (PIN still changed):', smsErr.message);
    }
    return 'END Your PIN has been changed successfully.';
  }

  return 'END Invalid input. Please dial again.';
}

module.exports = { handleUssd };