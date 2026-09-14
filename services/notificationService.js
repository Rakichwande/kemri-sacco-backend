const smsService = require('./smsService');
const emailService = require('./emailService');
const Admin = require('../models/Admin');

// Central dispatch for staff-facing notifications. Each staff account
// chooses independently whether they want SMS, email, both, or neither
// (notify_sms / notify_email). Never throws - a notification failure must
// never affect the underlying transaction (registration, loan application,
// repayment, deposit) that triggered it.
async function notifyStaff({ smsText, emailContent }) {
  try {
    const staff = await Admin.findAll();

    await Promise.all(staff.map(async (s) => {
      if (s.notify_sms && s.phone) {
        smsService.sendSMS(s.phone, smsText);
      }
      if (s.notify_email && s.email) {
        await emailService.sendEmail({
          to: s.email,
          subject: emailContent.subject,
          html: emailContent.html,
          text: emailContent.text,
        });
      }
    }));
  } catch (err) {
    console.error('notifyStaff dispatch failed:', err.message);
  }
}

module.exports = { notifyStaff };
