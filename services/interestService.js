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
    let cyclesReset = 0;

    // 10% p.a. = 0.008333 per month. Compounded for 6 months.
    const MONTHLY_RATE = 0.10 / 12; // 0.0083333...
    const MONTHS = 6;
    const COMPOUND_MULTIPLIER = Math.pow(1 + MONTHLY_RATE, MONTHS);
    const GRACE_PERIOD_DAYS = 14; // 2026-11-07: 2-week grace period

    for (const member of members) {
      
      const processSavings = async (savingsType, balance, interestDateStr) => {
        if (!interestDateStr) return { paid: 0, sms: 0, reset: 0 };

        const interestDate = new Date(interestDateStr);
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const diffTime = today - interestDate;
        const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));

        if (diffDays < 0) {
          return { paid: 0, sms: 0, reset: 0 }; // Not due yet
        }

        if (Number(balance) > 0) {
          const currentBalance = Number(balance);
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
                account_reference: `INTEREST-${savingsType.toUpperCase()}`,
                description: '6-Month Compounded Interest Payout',
                checkout_request_id: `INT-${Date.now()}-${member.id}-${savingsType[0].toUpperCase()}`,
                loan_id: null,
                channel: 'system',
                savings_type: savingsType,
                status: 'completed'
              }, client);
              
              await Member.resetInterestDate(member.id, savingsType, client);
              
              await client.query('COMMIT');
            } catch (err) {
              await client.query('ROLLBACK');
              console.error(`DB Interest payout failed for ${savingsType} - ${member.full_name}:`, err.message);
              client.release();
              return { paid: 0, sms: 0, reset: 0 }; // Skip SMS and AuditLog if the DB failed
            } finally {
              client.release();
            }

            // External APIs & Logs happen AFTER commit, in their own safe wrappers
            try {
              await smsService.sendSMS(member.phone_number, 
                smsService.templates.interestPaid(member.full_name, savingsType, interestAmount, newBalance)
              );
              await AuditLog.log({
                actorId: 'system', actorUsername: 'system', action: 'Paid 6-Month Interest',
                category: 'savings', targetType: 'member', targetId: member.id,
                targetLabel: member.full_name, details: `Paid KES ${interestAmount} ${savingsType} interest.`
              });
            } catch (notifyErr) {
              console.error(`SMS/Audit failed for ${savingsType} - ${member.full_name}:`, notifyErr.message);
            }
          } else {
            console.log(`[DRY RUN] ${savingsType} Interest for ${member.full_name}: ${interestAmount}`);
          }
          return { paid: interestAmount, sms: 1, reset: 1 };

        } else {
          // 2026-11-07: Balance is 0. Check grace period.
          if (diffDays > GRACE_PERIOD_DAYS) {
            // Grace period expired, reset cycle without paying
            if (!dryRun) {
              const client = await db.pool.connect();
              try {
                await client.query('BEGIN');
                await Member.resetInterestDate(member.id, savingsType, client);
                await client.query('COMMIT');
                console.log(`Reset ${savingsType} cycle for ${member.full_name} (Grace period expired).`);
              } catch (err) {
                await client.query('ROLLBACK');
                console.error(`Failed to reset ${savingsType} cycle for ${member.full_name}:`, err.message);
              } finally {
                client.release();
              }
            } else {
              console.log(`[DRY RUN] Would reset ${savingsType} cycle for ${member.full_name} (Grace period expired).`);
            }
            return { paid: 0, sms: 0, reset: 1 };
          } else {
            // Still in grace period, do nothing
            if (dryRun) console.log(`[DRY RUN] ${member.full_name} is in ${savingsType} grace period (Day ${diffDays}/${GRACE_PERIOD_DAYS}).`);
            return { paid: 0, sms: 0, reset: 0 };
          }
        }
      };

      // --- 1. Process Jipange Interest ---
      if (member.jipange_interest_date) {
        const res = await processSavings('jipange', member.jipange_balance, member.jipange_interest_date);
        totalPaid += res.paid;
        smsSent += res.sms;
        cyclesReset += res.reset;
      }

      // --- 2. Process Holiday Interest ---
      if (member.holiday_interest_date) {
        const res = await processSavings('holiday', member.holiday_balance, member.holiday_interest_date);
        totalPaid += res.paid;
        smsSent += res.sms;
        cyclesReset += res.reset;
      }
    }

    return { totalMembers: members.length, totalPaid, smsSent, cyclesReset };
  }
}

module.exports = InterestService;