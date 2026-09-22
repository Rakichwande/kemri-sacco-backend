const Member = require('../models/Member');
const Payment = require('../models/Payment');
const Loan = require('../models/Loan');
const Withdrawal = require('../models/Withdrawal');
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

// Per-USSD-session memory of "how many leading steps were spent on PIN
// entry/setup", keyed by Africa's Talking's sessionId (constant for the
// whole call, one HTTP request per screen). This exists because deciding
// that purely from Member.hasPinSet() re-read fresh from the database on
// every request breaks: the moment a first-time PIN is actually saved,
// hasPinSet flips true, and the NEXT request then wrongly treats the
// already-consumed PIN digits as a login attempt instead of recognizing
// they were already spent - corrupting how much of the accumulated input
// belongs to the action itself (loan amount, repayment amount).
//
// In-memory and safe ONLY because this app currently runs as a single
// process (Render's WEB_CONCURRENCY=1). If this is ever scaled to more
// than one instance, USSD screens for the same session could land on
// different instances and this cache would miss - move it to a shared
// store (Redis, or a DB table keyed by sessionId) before scaling up.
const pinSessionState = new Map(); // sessionId -> { pinStepsConsumed, touchedAt }
const PIN_SESSION_TTL_MS = 5 * 60 * 1000; // USSD sessions time out well before this

function cleanupStalePinSessions() {
  const cutoff = Date.now() - PIN_SESSION_TTL_MS;
  for (const [sid, state] of pinSessionState) {
    if (state.touchedAt < cutoff) pinSessionState.delete(sid);
  }
}

async function handleUssd(req, res) {
  const { sessionId, phoneNumber, serviceCode, text } = req.body;
  const input = (text || '').split('*').filter(Boolean);
  const startedAt = Date.now();

  cleanupStalePinSessions();

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
          response = await handleBalance(phoneNumber, steps, sessionId);
          break;
        case '3':
          response = await handleDeposit(phoneNumber, steps);
          break;
        case '4':
          response = await handleLoanApplication(phoneNumber, steps, sessionId);
          break;
        case '5':
          response = await handleRepayLoan(phoneNumber, steps, sessionId);
          break;
        case '6':
          response = await handleTransactions(phoneNumber, steps, sessionId);
          break;
        case '7':
          response = await handleChangePin(phoneNumber, steps);
          break;
        case '8':
          response = await handleWithdraw(phoneNumber, steps, sessionId);
          break;
        case '9':
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
    '8. Withdraw\n' +
    '9. Exit'
  );
}

// ============================================================
// PIN AUTHENTICATION
// ============================================================
async function requirePin(member, steps, sessionId) {
  // Already authenticated earlier in this exact USSD session - trust that,
  // rather than re-deriving from hasPinSet() (which may have flipped since
  // the PIN was set/verified a screen or two ago in this same dialog).
  const cached = pinSessionState.get(sessionId);
  if (cached) {
    return { authenticated: true, remainingSteps: steps.slice(cached.pinStepsConsumed) };
  }

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
    if (steps.length >= 2) {
      const [newPin, confirmPin] = steps;
      if (newPin !== confirmPin) {
        return { authenticated: false, response: 'END PINs did not match. Please dial again to try once more.' };
      }
      await Member.setPin(member.id, newPin);
      pinSessionState.set(sessionId, { pinStepsConsumed: 2, touchedAt: Date.now() });

      // First-time PIN confirmation SMS - separate from the "PIN changed"
      // SMS sent by Change PIN, so a member has a clear record either way.
      try {
        await smsService.sendSMS(
          member.phone_number,
          'KEMRI SACCO: Your SACCO PIN has been set. Keep it secret - we will never ask for it by SMS or call.'
        );
      } catch (smsErr) {
        console.error('PIN-setup confirmation SMS failed (PIN still set):', smsErr.message);
      }

      return { authenticated: true, remainingSteps: steps.slice(2) };
    }
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
  pinSessionState.set(sessionId, { pinStepsConsumed: 1, touchedAt: Date.now() });
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
async function handleBalance(phoneNumber, steps, sessionId) {
  const member = await Member.findByPhone(phoneNumber);
  if (!member) {
    return 'END You are not registered. Dial and select option 1 to register first.';
  }

  const pinCheck = await requirePin(member, steps, sessionId);
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
async function handleLoanApplication(phoneNumber, steps, sessionId) {
  const member = await Member.findByPhone(phoneNumber);
  if (!member) {
    return 'END You are not registered. Dial and select option 1 to register first.';
  }

  const pinCheck = await requirePin(member, steps, sessionId);
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
async function handleRepayLoan(phoneNumber, steps, sessionId) {
  const member = await Member.findByPhone(phoneNumber);
  if (!member) {
    return 'END You are not registered. Dial and select option 1 to register first.';
  }

  const pinCheck = await requirePin(member, steps, sessionId);
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
async function handleTransactions(phoneNumber, steps, sessionId) {
  const member = await Member.findByPhone(phoneNumber);
  if (!member) {
    return 'END You are not registered. Dial and select option 1 to register first.';
  }

  const pinCheck = await requirePin(member, steps, sessionId);
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

// ============================================================
// 8. WITHDRAW (PIN required)
// ============================================================
// IMPORTANT: this creates a withdrawal REQUEST, not an instant payout.
// This system has no Safaricom B2C (Business-to-Customer) integration -
// the same reason loan disbursement is a manual staff action today (see
// services/loanService.js's approveLoan message: "Disbursement is manual
// until M-Pesa B2C is approved by Safaricom"). A member's money does not
// move the moment they complete this menu; a staff member sees the
// request in the admin portal, sends the M-Pesa payment themselves, and
// marks it processed. Once B2C is approved, this is the natural place to
// wire in an automatic payout - the request/approval shape here doesn't
// need to change, only what happens after the request is created.
async function handleWithdraw(phoneNumber, steps, sessionId) {
  const member = await Member.findByPhone(phoneNumber);
  if (!member) {
    return 'END You are not registered. Dial and select option 1 to register first.';
  }

  const pinCheck = await requirePin(member, steps, sessionId);
  if (!pinCheck.authenticated) return pinCheck.response;
  const remaining = pinCheck.remainingSteps;

  const existingPending = await Withdrawal.getPendingForMember(member.id);
  if (existingPending) {
    return `END You already have a pending withdrawal request of KES ${Number(existingPending.amount).toLocaleString()}. Please wait for it to be processed.`;
  }

  const savingsBalance = await Payment.getMemberBalance(member.id);

  if (remaining.length === 0) {
    return `CON Available balance: KES ${savingsBalance.toLocaleString()}\nEnter amount to withdraw`;
  }

  if (remaining.length === 1) {
    const amount = Number(remaining[0]);
    if (!amount || amount <= 0) {
      return 'END Invalid amount. Please dial again.';
    }
    if (amount > savingsBalance) {
      return `END Insufficient balance. Your available balance is KES ${savingsBalance.toLocaleString()}.`;
    }

    // Guards against the rare case of two near-simultaneous requests both
    // passing the getPendingForMember() check above before either has
    // written its row - the database is the real source of truth here,
    // this check is just a fast, friendly rejection for the common case.
    const withdrawal = await Withdrawal.create({ member_id: member.id, amount });
    if (!withdrawal) {
      return 'END You already have a pending withdrawal request. Please wait for it to be processed.';
    }

    try {
      await smsService.sendSMS(phoneNumber, smsService.templates.withdrawalRequested(member.full_name, amount));
    } catch (smsErr) {
      console.error('USSD withdrawal request SMS failed (request still recorded):', smsErr.message);
    }

    // SMS-only staff alert for now - notificationService.notifyStaff's
    // emailContent parameter expects a template from emailService, which
    // hasn't been reviewed yet in this pass. Add an email template there
    // once that file's shape is confirmed, following the same pattern as
    // the other staff notifications in this file.
    try {
      await smsService.notifyStaff(smsService.templates.staffWithdrawalRequest(member.full_name, amount));
    } catch (staffSmsErr) {
      console.error('Staff withdrawal-request SMS failed (request still recorded):', staffSmsErr.message);
    }

    return `END Withdrawal request of KES ${amount.toLocaleString()} received. We will process it and contact you once complete. This is not instant.`;
  }

  return 'END Invalid input. Please dial again.';
}

module.exports = { handleUssd };