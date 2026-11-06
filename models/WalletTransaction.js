const db = require('../config/database');
const Member = require('./Member');

async function getWithdrawals() {
  const result = await db.query(
    `SELECT 
       wt.id,
       wt.member_id,
       wt.amount,
       wt.transaction_type,
       wt.reference,
       wt.wallet_type,
       wt.created_at,
       m.full_name,
       m.phone_number,
       ${Member.REFERENCE_SQL} AS member_reference
     FROM wallet_transactions wt
     JOIN members m ON wt.member_id = m.id
     WHERE wt.transaction_type IN ('withdrawal', 'withdrawal_failed')
     ORDER BY wt.created_at DESC
     LIMIT 200`
  );
  return result.rows;
}

module.exports = { getWithdrawals };