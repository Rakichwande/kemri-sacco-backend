const Member = require('../models/Member');
const Payment = require('../models/Payment');
const Loan = require('../models/Loan');
const paymentService = require('../services/paymentService');
const LoanService = require('../services/loanService');
const smsService = require('../services/smsService');
const UssdSession = require('../models/UssdSession');
const notificationService = require('../services/notificationService');
const emailService = require('../services/emailService');

// 2026-10-09: Withdrawal feature retired per board instruction.
// Removed imports: models/Withdrawal, services/disbursementService.

const FAILURE_PHRASES = [
  'invalid', 'wrong', 'failed', 'error', 'something went wrong', 'not found',
  'insufficient', 'incorrect', 'locked', 'did not match',
];
function looksLikeFailure(responseText) {
  const lower = responseText.toLowerCase();
  return FAILURE_PHRASES.some((phrase) => lower.includes(phrase));
}

const pinSessionState = new Map();
const PIN_SESSION_TTL_MS = 5 * 60 * 1000;

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
    '5. Loan Repayment\n' +
    '6. Transactions\n' +
    '7. Change PIN\n' +
    '8. Exit'
  );
}

// ============================================================
// PIN AUTHENTICATION
// ============================================================
async function requirePin(member, steps, sessionId) {
  const cached = pinSessionState.get(sessionId);
  if (cached) {
    return { authenticated: true, remainingSteps: steps.slice(cached.pinStepsConsumed) };
  }

  if (!Member.hasPinSet(member)) {
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

    let member;
    try {
      member = await Member.create({
        full_name,
        id_number,
        phone_number: phoneNumber,
        scheme: 'holiday_savings',
      });
    } catch (err) {
      if (err.code === '23505' && err.constraint === 'members_id_number_key') {
        return 'END This ID number is already registered with KEMRI SACCO. If this is your ID, contact the office to link your new phone number.';
      }
      if (err.code === '23505' && err.constraint === 'members_phone_number_key') {
        return 'END This phone number is already registered with KEMRI SACCO.';
      }
      throw err;
    }

    try {
      await smsService.sendSMS(phoneNumber, smsService.templates.applicationReceived(full_name));
    } catch (smsErr) {
      console.error('USSD registration SMS failed (member still registered):', smsErr.message);
    }
    notificationService.notifyStaff({
      smsText: smsService.templates.staffNewMember(full_name),
      emailContent: emailService.staffTemplates.newMember(full_name),
    });

    const memberRef = member.imported_reference;

    return `END Thank you, ${full_name}. Your registration is complete. Ref: ${memberRef}. You can now save, check balance, or apply for a loan by dialling *483*4444#.\nYou'll set a SACCO PIN the first time you check your balance or apply for a loan.`;
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
  const balanceText = `Your KEMRI SACCO savings balance is KES ${balance.toLocaleString()}.`;

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

  const eligibility = await LoanService.canApply(member.id);
  if (!eligibility.allowed) {
    return `END ${eligibility.reason}`;
  }

  if (remaining.length === 0) {
    return `CON Enter loan amount (KES)\nCredit limit: KES ${eligibility.creditLimit.toLocaleString()}`;
  }

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
    const ref = `LN-${String(loan.id).padStart(5, '0')}`;

    let opening;
    let closing;
    if (result.disbursing) {
      opening = 'Loan approved';
      closing = 'Funds on the way to your M-Pesa.';
    } else if (result.disbursementFailed) {
      opening = 'Loan approved';
      closing = 'Our team will complete this shortly.';
    } else if (result.autoApproved) {
      opening = 'Loan approved';
      closing = 'Disbursement shortly.';
    } else {
      opening = 'Loan application received';
      closing = 'Awaiting SACCO review.';
    }

    const summary =
      `${opening}: Principal KES ${Number(loan.principal).toLocaleString()}\n` +
      `Interest: KES ${Number(loan.total_interest).toLocaleString()}\n` +
      `Total amount payable: KES ${Number(loan.total_repayment).toLocaleString()}\n` +
      `Ref: ${ref}. ${closing}`;

    return `END ${summary}`;
  }

  return 'END Invalid input. Please dial again.';
}

// ============================================================
// 5. LOAN REPAYMENT (PIN required)
// ============================================================
async function handleRepayLoan(phoneNumber, steps, sessionId) {
  const member = await Member.findByPhone(phoneNumber);
  if (!member) {
    return 'END You are not registered. Dial and select option 1 to register first.';
  }

  const pinCheck = await requirePin(member, steps, sessionId);
  if (!pinCheck.authenticated) return pinCheck.response;
  const remaining = pinCheck.remainingSteps;

  const repayableLoan = await Loan.getRepayableLoan(member.id);

  if (!repayableLoan) {
    const inFlightLoan = await Loan.getActiveLoan(member.id);
    if (inFlightLoan && inFlightLoan.status === 'pending') {
      return 'END Your loan application is still awaiting approval. You will receive an SMS once it is reviewed.';
    }
    if (inFlightLoan && inFlightLoan.status === 'approved') {
      return 'END Your loan has been approved and is awaiting disbursement. You will receive an SMS once funds are sent.';
    }
    if (inFlightLoan && inFlightLoan.status === 'disbursing') {
      return 'END Your loan is being disbursed to your M-Pesa right now. You will receive an SMS once the funds arrive.';
    }
    return 'END You have no active loan to repay.';
  }

  if (remaining.length === 0) {
    return `CON Amount outstanding: KES ${Number(repayableLoan.outstanding_balance).toLocaleString()}\nEnter amount to pay`;
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
        loanId: repayableLoan.id,
      });
      return 'END An M-Pesa prompt has been sent to your phone. Enter your PIN to complete the payment.';
    } catch (err) {
      console.error('USSD loan repayment STK push failed:', err.message);
      return 'END We could not process your payment right now. Please try again shortly.';
    }
  }

  return 'END Invalid input. Please dial again.';
}

// ============================================================
// 6. TRANSACTIONS (PIN required)
// ============================================================
// Shows the member their 5 most recent money movements — deposits,
// loan repayments, AND loan disbursements — each labelled with its type.
//
// 2026-10-10: Loan disbursements were previously invisible here. A
// member who received a loan but never deposited or repaid anything
// (like Kennedy Odongo) would dial Option 6 and be told "no
// transactions yet" — denying a money movement the SACCO just
// performed. Disbursements live in the `loans` table, not `payments`,
// so the two sources are now merged for this view.
//
// Data sources merged:
//   payments  — deposits (loan_id NULL) and loan repayments (loan_id set)
//   loans     — loan disbursements (disbursed_at IS NOT NULL)
//
// Sorted by date DESC, top 5 across both sources. Non-completed rows
// (pending/failed/processing) get a status marker; completed rows stay
// clean since that's the expected state.
async function handleTransactions(phoneNumber, steps, sessionId) {
  const member = await Member.findByPhone(phoneNumber);
  if (!member) {
    return 'END You are not registered. Dial and select option 1 to register first.';
  }

  const pinCheck = await requirePin(member, steps, sessionId);
  if (!pinCheck.authenticated) return pinCheck.response;

  // Fetch both sources in parallel. 10 rows each so the merge has enough
  // to pick a true top-5 from; the visible list stays 5 to keep the USSD
  // screen within length limits.
  const [payments, loans] = await Promise.all([
    Payment.findRecentByMember(member.id, 10),
    Loan.getHistory(member.id, 10),
  ]);

  // Normalise both into a common shape. Dates differ by source:
  // payments use created_at, loans use disbursed_at.
  const fromPayments = payments.map((p) => ({
    date: p.created_at,
    type: p.loan_id === null ? 'Deposit' : 'Repay',
    amount: p.amount,
    status: p.status,
  }));

  // Only loans where money actually moved. Pending/approved/disbursing/
  // rejected loans have disbursed_at NULL and are correctly excluded —
  // the member hasn't received funds for them yet.
  const fromLoans = loans
    .filter((l) => l.disbursed_at)
    .map((l) => ({
      date: l.disbursed_at,
      type: 'Loan',
      amount: l.principal,
      status: 'completed',
    }));

  const merged = [...fromPayments, ...fromLoans]
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, 5);

  if (merged.length === 0) {
    return 'END You have no transactions yet.';
  }

  const lines = merged.map((t) => {
    const date = new Date(t.date).toLocaleDateString('en-GB', {
      day: '2-digit', month: 'short',
    });
    const suffix = t.status === 'completed' ? '' : ` (${t.status})`;
    return `${date}: ${t.type} KES ${Number(t.amount).toLocaleString()}${suffix}`;
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
// 8. (RETIRED) WITHDRAW
// ============================================================
// 2026-10-09: Withdrawal feature retired per board instruction. The
// handleWithdraw function was removed here in full, along with the
// `Withdrawal` and `DisbursementService` imports at the top of this file.
//
// Historical withdrawal records are preserved in the `withdrawals` table
// (archive CSV exported 2026-10-09). The model file models/Withdrawal.js
// and route file routes/withdrawals.js remain on disk but are no longer
// mounted. See AdminLayout.jsx / App.jsx for the parallel frontend changes.
//
// If the board ever reinstates withdrawals, the deleted handler is
// recoverable from git history immediately before this commit.

module.exports = { handleUssd };