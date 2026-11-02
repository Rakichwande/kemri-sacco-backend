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

    for (const member of members) {
      try {
        // 1. Process Jipange Interest
        if (member.jipange_interest_date && Number(member.jipange_balance) > 0) {
          const interestAmount = Math.round(Number(member.jipange_balance) * 0.10);
          const newBalance = Number(member.jipange_balance) + interestAmount;

          if (!dryRun) {
            const client = await db.pool.connect();
            try {
              await client.query('BEGIN');
              // Insert interest as a new completed deposit
              await Payment.create({
                member_id: member.id,
                amount: interestAmount,
                phone: member.phone_number,
                account_reference: 'INTEREST-JIPANGE',
                description: '10% Annual Interest Payout',
                checkout_request_id: `INT-${Date.now()}-${member.id}-J`,
                loan_id: null,
                channel: 'system',
                savings_type: 'jipange',
                status: 'completed' // <--- CRITICAL FIX
              }, client);
              // Update the date in the same transaction
              await Member.resetInterestDate(member.id, 'jipange', client);
              await client.query('COMMIT');

              // Send SMS
              await smsService.sendSMS(member.phone_number, 
                smsService.templates.interestPaid(member.full_name, 'jipange', interestAmount, newBalance)
              );
              
              await AuditLog.log({
                actorId: 'system', actorUsername: 'system', action: 'Paid Annual Interest',
                category: 'savings', targetType: 'member', targetId: member.id,
                targetLabel: member.full_name, details: `Paid KES ${interestAmount} Jipange interest.`
              });
            } catch (err) {
              await client.query('ROLLBACK');
              throw err;
            } finally {
              client.release();
            }
          } else {
            console.log(`[DRY RUN] Jipange Interest for ${member.full_name}: ${interestAmount}`);
          }
          totalPaid += interestAmount;
          smsSent++;
        }

        // 2. Process Holiday Interest
        if (member.holiday_interest_date && Number(member.holiday_balance) > 0) {
          const interestAmount = Math.round(Number(member.holiday_balance) * 0.10);
          const newBalance = Number(member.holiday_balance) + interestAmount;

          if (!dryRun) {
            const client = await db.pool.connect();
            try {
              await client.query('BEGIN');
              await Payment.create({
                member_id: member.id,
                amount: interestAmount,
                phone: member.phone_number,
                account_reference: 'INTEREST-HOLIDAY',
                description: '10% Annual Interest Payout',
                checkout_request_id: `INT-${Date.now()}-${member.id}-H`,
                loan_id: null,
                channel: 'system',
                savings_type: 'holiday',
                status: 'completed' // <--- CRITICAL FIX
              }, client);
              await Member.resetInterestDate(member.id, 'holiday', client);
              await client.query('COMMIT');

              await smsService.sendSMS(member.phone_number, 
                smsService.templates.interestPaid(member.full_name, 'holiday', interestAmount, newBalance)
              );

              await AuditLog.log({
                actorId: 'system', actorUsername: 'system', action: 'Paid Annual Interest',
                category: 'savings', targetType: 'member', targetId: member.id,
                targetLabel: member.full_name, details: `Paid KES ${interestAmount} Holiday interest.`
              });
            } catch (err) {
              await client.query('ROLLBACK');
              throw err;
            } finally {
              client.release();
            }
          } else {
            console.log(`[DRY RUN] Holiday Interest for ${member.full_name}: ${interestAmount}`);
          }
          totalPaid += interestAmount;
          smsSent++;
        }
      } catch (err) {
        console.error(`Interest payout failed for ${member.full_name}:`, err.message);
      }
    }

    return { totalMembers: members.length, totalPaid, smsSent };
  }
}

module.exports = InterestService;