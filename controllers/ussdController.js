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
// Those modules remain on disk (still used by loans B2C in loanController),
// but this controller no longer touches them.

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
        // 2026-10-09: Option 8 used to be Withdraw. Renumbered Exit here.
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
  // 2026-10-09: "Settle Loan" reverted to "Loan Repayment"; Withdraw
  // removed; Exit renumbered from 9 to 8.
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

    let member;
    try {
      member = await Member.create({
        full_name,
        id_number,
        phone_number: phoneNumber,
        scheme: 'holiday_savings',
      });
    } catch (err) {
      // members can collide on id_number (common) or phone_number (rare
      // race). Surface the specific reason rather than letting the outer
      // catch return a generic "Something went wrong".
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
// The "Balance" here is the member's SAVINGS balance, not a loan balance.
// The word "balance" is correct in this context — it's a savings account,
// not a loan. Leave the wording as-is.
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

  // Check eligibility BEFORE asking for an amount. If the member has an
  // active loan, a pending/approved application, or is otherwise
  // ineligible, we tell them immediately and end the session rather than
  // costing them an extra USSD screen.
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

    // FOUR possible outcomes, each with its own opening and closing line.
    // They must reflect what actually happened, because the member sees
    // this screen for a few seconds and then receives an SMS — any
    // mismatch between the two reads as a bug.
    //
    //   disbursing           board/staff, auto-approved, B2C accepted —
    //                        money is on the way
    //   disbursementFailed   board/staff, auto-approved, but B2C rejected
    //                        or errored — staff will disburse manually
    //   autoApproved         board/staff, auto-approved, B2C not attempted
    //                        (rare; e.g. B2C credentials not yet configured)
    //   (none of the above)  regular member, awaiting staff review
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

    // Summary uses standard SACCO accounting terminology:
    //   Principal            — amount borrowed
    //   Interest             — charge for the 1-month term
    //   Total amount payable — principal + interest (what the member owes)
    //
    // Field name note: loan.total_interest is the stored interest figure;
    // loan.total_repayment is the stored principal + interest figure.
    // Names retained in the DB for backward compatibility, but displayed
    // here with the vocabulary an accountant would use.
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
// 2026-10-09: Menu label reverted from "Settle Loan" to "Loan Repayment"
// per board instruction. The endpoint, service methods, and DB fields have
// always used "repayment" naming, so nothing below this line changed —
// only the visible menu string in mainMenu().
async function handleRepayLoan(phoneNumber, steps, sessionId) {
  const member = await Member.findByPhone(phoneNumber);
  if (!member) {
    return 'END You are not registered. Dial and select option 1 to register first.';
  }

  const pinCheck = await requirePin(member, steps, sessionId);
  if (!pinCheck.authenticated) return pinCheck.response;
  const remaining = pinCheck.remainingSteps;

  // Only a DISBURSED loan is repayable. A pending, approved, or
  // disbursing loan exists but no money has reached the member's M-Pesa
  // yet, so there is nothing to repay.
  const repayableLoan = await Loan.getRepayableLoan(member.id);

  if (!repayableLoan) {
    // Distinguish the non-repayable states so the member gets a clear,
    // actionable message rather than a misleading "no outstanding loan"
    // when they actually have an application in flight.
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