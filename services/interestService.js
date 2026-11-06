const db = require('../config/database');
const Member = require('../models/Member');
const Payment = require('../models/Payment');
const smsService = require('./smsService');
const AuditLog = require('../models/AuditLog');

class InterestService {
  static async runAnnualPayout(dryRun = false) {
    const members = await Member.getMembersDueForInterest();
    let totalPaid = 0;
    let smsSent = 0;

    // 10% p.a. = 0.008333 per month. Compounded for 6 months.
    const MONTHLY_RATE = 0.10 / 12; // 0.0083333...
    const MONTHS = 6;
    const COMPOUND_MULTIPLIER = Math.pow(1 + MONTHLY_RATE, MONTHS);

    for (const member of members) {
      // --- 1. Process Jipange Interest ---
      if (member.jipange_interest_date && Number(member.jipange_balance) > 0) {
        const currentBalance = Number(member.jipange_balance);
        const interestAmount = Math.round(currentBalance * (COMPOUND_MULTIPLIER - 1));
        const newBalance = currentBalance + interestAmount;

        if (!dryRun) {
          const client = await db.pool.connect();
          try {
            await client.query('BEGIN');
            
            await Payment.create({
              member_id: member.id,
              amount: interestAmount,
              phone: member.phone_number,
              account_reference: 'INTEREST-JIPANGE',
              description: '6-Month Compounded Interest Payout',
              checkout_request_id: `INT-${Date.now()}-${member.id}-J`,
              loan_id: null,
              channel: 'system',
              savings_type: 'jipange',
              status: 'completed'
            }, client);
            
            await Member.resetInterestDate(member.id, 'jipange', client);
            
            await client.query('COMMIT');
          } catch (err) {
            await client.query('ROLLBACK');
            console.error(`DB Interest payout failed for Jipange - ${member.full_name}:`, err.message);
            client.release();
            continue; // Skip SMS and AuditLog if the DB failed
          } finally {
            client.release();
          }

          // External APIs & Logs happen AFTER commit, in their own safe wrappers
          try {
            await smsService.sendSMS(member.phone_number, 
              smsService.templates.interestPaid(member.full_name, 'jipange', interestAmount, newBalance)
            );
            await AuditLog.log({
              actorId: 'system', actorUsername: 'system', action: 'Paid 6-Month Interest',
              category: 'savings', targetType: 'member', targetId: member.id,
              targetLabel: member.full_name, details: `Paid KES ${interestAmount} Jipange interest.`
            });
          } catch (notifyErr) {
            console.error(`SMS/Audit failed for Jipange - ${member.full_name}:`, notifyErr.message);
          }
        } else {
          console.log(`[DRY RUN] Jipange Interest for ${member.full_name}: ${interestAmount}`);
        }
        totalPaid += interestAmount;
        smsSent++;
      }

      // --- 2. Process Holiday Interest ---
      if (member.holiday_interest_date && Number(member.holiday_balance) > 0) {
        const currentBalance = Number(member.holiday_balance);
        const interestAmount = Math.round(currentBalance * (COMPOUND_MULTIPLIER - 1));
        const newBalance = currentBalance + interestAmount;

        if (!dryRun) {
          const client = await db.pool.connect();
          try {
            await client.query('BEGIN');
            
            await Payment.create({
              member_id: member.id,
              amount: interestAmount,
              phone: member.phone_number,
              account_reference: 'INTEREST-HOLIDAY',
              description: '6-Month Compounded Interest Payout',
              checkout_request_id: `INT-${Date.now()}-${member.id}-H`,
              loan_id: null,
              channel: 'system',
              savings_type: 'holiday',
              status: 'completed'
            }, client);
            
            await Member.resetInterestDate(member.id, 'holiday', client);
            
            await client.query('COMMIT');
          } catch (err) {
            await client.query('ROLLBACK');
            console.error(`DB Interest payout failed for Holiday - ${member.full_name}:`, err.message);
            client.release();
            continue; // Skip SMS and AuditLog if the DB failed
          } finally {
            client.release();
          }

          try {
            await smsService.sendSMS(member.phone_number, 
              smsService.templates.interestPaid(member.full_name, 'holiday', interestAmount, newBalance)
            );
            await AuditLog.log({
              actorId: 'system', actorUsername: 'system', action: 'Paid 6-Month Interest',
              category: 'savings', targetType: 'member', targetId: member.id,
              targetLabel: member.full_name, details: `Paid KES ${interestAmount} Holiday interest.`
            });
          } catch (notifyErr) {
            console.error(`SMS/Audit failed for Holiday - ${member.full_name}:`, notifyErr.message);
          }
        } else {
          console.log(`[DRY RUN] Holiday Interest for ${member.full_name}: ${interestAmount}`);
        }
        totalPaid += interestAmount;
        smsSent++;
      }
    }

    return { totalMembers: members.length, totalPaid, smsSent };
  }
}

module.exports = InterestService;