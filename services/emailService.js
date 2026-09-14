const axios = require('axios');

function isConfigured() {
  return !!(process.env.BREVO_API_KEY && process.env.BREVO_SENDER_EMAIL);
}

// Sends one email via Brevo's REST API. Never throws - returns a result
// object instead, since a failed/unconfigured email must not block invite
// creation: the caller always has the invite link to share manually as a
// fallback, configured or not.
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
  const html = `
    <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
      <h3 style="color: #1F3D2E;">${title}</h3>
      <p>${bodyLine}</p>
      <p style="color: #666; font-size: 0.85em;">Log in to the admin console for details.</p>
    </div>
  `;
  const text = `${title}\n\n${bodyLine}\n\nLog in to the admin console for details.`;
  return { subject, html, text };
}

const staffTemplates = {
  newMember: (name) =>
    staffEventEmail('New member registered', `${name} has just registered as a SACCO member.`),
  loanApplication: (name, amount, ref) =>
    staffEventEmail('Loan application received', `${name} applied for a loan of KES ${Number(amount).toLocaleString()}. Reference: ${ref}. Awaiting review.`),
  repayment: (name, amount) =>
    staffEventEmail('Loan repayment received', `A repayment of KES ${Number(amount).toLocaleString()} was received from ${name}.`),
  deposit: (name, amount) =>
    staffEventEmail('Deposit received', `A deposit of KES ${Number(amount).toLocaleString()} was received from ${name}.`),
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
