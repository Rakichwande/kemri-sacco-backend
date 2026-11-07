const axios = require('axios');

function isConfigured() {
  return !!(process.env.BREVO_API_KEY && process.env.BREVO_SENDER_EMAIL);
}

async function sendEmail({ to, subject, html, text }) {
  if (!isConfigured()) {
    return { sent: false, reason: 'Email is not configured yet (BREVO_API_KEY / BREVO_SENDER_EMAIL not set).' };
  }

  try {
    await axios.post(
      'https://api.brevo.com/v3/smtp/email',
      {
        sender: { email: process.env.BREVO_SENDER_EMAIL, name: 'KEMRI SACCO' },
        to: [{ email: to }],
        subject,
        htmlContent: html,
        textContent: text,
      },
      {
        headers: {
          'api-key': process.env.BREVO_API_KEY,
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      }
    );
    return { sent: true };
  } catch (err) {
    const detail = err.response?.data?.message || err.message;
    console.error('Brevo send failed:', detail);
    return { sent: false, reason: detail };
  }
}

function inviteEmailContent({ inviteLink, role, inviterName }) {
  const subject = 'You\u2019ve been invited to the KEMRI SACCO Admin Console';
  const html = `
    <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
      <h2 style="color: #1F3D2E;">KEMRI SACCO Admin Console</h2>
      <p>${inviterName} has invited you to join the admin console as <strong>${role}</strong>.</p>
      <p>
        <a href="${inviteLink}" style="background: #1F3D2E; color: #fff; padding: 10px 20px; text-decoration: none; border-radius: 4px; display: inline-block;">
          Accept Invitation
        </a>
      </p>
      <p style="color: #666; font-size: 0.85em;">This link expires in 7 days. If you weren't expecting this, you can ignore this email.</p>
    </div>
  `;
  const text = `${inviterName} has invited you to join the KEMRI SACCO Admin Console as ${role}.\n\nAccept your invitation: ${inviteLink}\n\nThis link expires in 7 days.`;
  return { subject, html, text };
}

function staffEventEmail(title, bodyLine) {
  const subject = `KEMRI SACCO Admin: ${title}`;
  const paragraphs = String(bodyLine)
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter(Boolean);

  const htmlBody = paragraphs.map((p) => `<p>${p}</p>`).join('\n      ');
  const html = `
    <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
      <h3 style="color: #1F3D2E;">${title}</h3>
      ${htmlBody}
      <p style="color: #666; font-size: 0.85em;">Log in to the admin console for the full record.</p>
    </div>
  `;
  const text = `${title}\n\n${paragraphs.join('\n\n')}\n\nLog in to the admin console for the full record.`;
  return { subject, html, text };
}

function formatLoanType(purpose) {
  if (!purpose) return 'SACCO';
  const lower = purpose.toLowerCase();
  if (lower === 'bizboost') return 'BizBoost';
  if (lower === 'sme') return 'SME';
  if (lower === 'mobile') return 'Mobile';
  return purpose.charAt(0).toUpperCase() + purpose.slice(1).toLowerCase();
}

const staffTemplates = {
  newMember: (name) =>
    staffEventEmail(
      'New member registered', 
      `${name} has just registered as a SACCO member.\n\nNote: Their credit limit defaults to 0 until manually approved by the CEO.`
    ),

  loanApplication: (name, amount, ref, purpose = 'Mobile') =>
    staffEventEmail(
      `${formatLoanType(purpose)} Loan application received`,
      `${name} applied for a ${formatLoanType(purpose)} loan of KES ${Number(amount).toLocaleString()}.\n\nReference: ${ref}\n\nAwaiting review. Approve or reject from the Approval Queue.`
    ),

  mobileLoanAutoApproved: (name, amount, totalRepayment, ref, opts = {}) => {
    const { status, memberPhone } = opts;
    
    const paragraphs = [
      `${name} applied for a Mobile loan of KES ${Number(amount).toLocaleString()}.`,
    ];
    if (memberPhone) paragraphs.push(`Member phone: ${memberPhone}`);
    paragraphs.push(`Reference: ${ref}\nTotal amount payable: KES ${Number(totalRepayment).toLocaleString()} (1 month term)`);

    if (status === 'disbursing') {
      paragraphs.push(
        'The loan was auto-approved and M-Pesa B2C disbursement has been initiated. Safaricom will confirm shortly — no action is required.'
      );
    } else if (status === 'failed') {
      paragraphs.push(
        `AUTO-APPROVED, BUT B2C DISBURSEMENT FAILED.\n\nThe loan is currently in the Approved state and requires manual disbursement. Open the Disbursement Log to record the M-Pesa receipt manually.`
      );
    } else {
      paragraphs.push('Auto-approved - ready for disbursement. Open the Disbursement Log to trigger the payout.');
    }

    return staffEventEmail('Mobile Loan auto-approved', paragraphs.join('\n\n'));
  },

  emergencySchoolApproved: (name, amount, totalRepayment, ref, purpose) =>
    staffEventEmail(
      `${formatLoanType(purpose)} Loan approved`,
      `You approved a ${formatLoanType(purpose)} loan of KES ${Number(amount).toLocaleString()} for ${name}.\n\nReference: ${ref}\nTotal amount payable: KES ${Number(totalRepayment).toLocaleString()} (12 month term)\n\nThe funds have been credited to their SACCO Wallet. The member can now withdraw to M-Pesa.`
    ),

  // 2026-11-07: NEW B2C LOAN APPROVED TEMPLATE
  b2cLoanApproved: (name, amount, totalRepayment, ref, purpose) =>
    staffEventEmail(
      `${formatLoanType(purpose)} Loan approved`,
      `You approved a ${formatLoanType(purpose)} loan of KES ${Number(amount).toLocaleString()} for ${name}.\n\nReference: ${ref}\nTotal amount payable: KES ${Number(totalRepayment).toLocaleString()} (1 month term)\n\nThe funds are being sent to their M-Pesa via B2C. Check the Disbursement Log if the Safaricom request fails and requires a retry.`
    ),

  repayment: (name, amount, ref, amountOutstanding) =>
    staffEventEmail(
      'Loan repayment received', 
      `A repayment of KES ${Number(amount).toLocaleString()} was received from ${name}.\n\nLoan Ref: ${ref}\nRemaining balance: KES ${Number(amountOutstanding).toLocaleString()}`
    ),

  deposit: (name, amount, savingsType = 'Ordinary') =>
    staffEventEmail(
      'Deposit received', 
      `A ${savingsType.toUpperCase()} deposit of KES ${Number(amount).toLocaleString()} was received from ${name}.`
    ),
};

function otpEmailContent(code) {
  const subject = `Your KEMRI SACCO verification code: ${code}`;
  const html = `
    <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
      <h2 style="color: #1F3D2E;">KEMRI SACCO Admin Console</h2>
      <p>Your verification code is:</p>
      <p style="font-size: 2em; font-weight: bold; letter-spacing: 0.1em; color: #1F3D2E;">${code}</p>
      <p style="color: #666; font-size: 0.85em;">This code expires in 10 minutes. If you didn't try to log in, you can ignore this email.</p>
    </div>
  `;
  const text = `Your KEMRI SACCO verification code is: ${code}\n\nThis code expires in 10 minutes. If you didn't try to log in, you can ignore this email.`;
  return { subject, html, text };
}

function passwordResetEmailContent(resetLink) {
  const subject = 'Reset your KEMRI SACCO Admin Console password';
  const html = `
    <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
      <h2 style="color: #1F3D2E;">KEMRI SACCO Admin Console</h2>
      <p>Someone requested a password reset for this account. If that was you, click below:</p>
      <p>
        <a href="${resetLink}" style="background: #1F3D2E; color: #fff; padding: 10px 20px; text-decoration: none; border-radius: 4px; display: inline-block;">
          Reset Password
        </a>
      </p>
      <p style="color: #666; font-size: 0.85em;">This link expires in 1 hour. If you didn't request this, you can ignore this email - your password won't change.</p>
    </div>
  `;
  const text = `Someone requested a password reset for this account.\n\nReset your password: ${resetLink}\n\nThis link expires in 1 hour. If you didn't request this, ignore this email.`;
  return { subject, html, text };
}

module.exports = { isConfigured, sendEmail, inviteEmailContent, staffTemplates, otpEmailContent, passwordResetEmailContent };