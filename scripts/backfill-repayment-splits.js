// One-time backfill: populate principal_paid / interest_paid on historical
// repayment rows using the same interest-first rule as
// Loan.applyRepayment(). Safe to re-run - it recomputes from scratch per
// loan in chronological order and only writes rows that differ.
//
// Usage:
//   node scripts/backfill-repayment-splits.js            # dry-run
//   node scripts/backfill-repayment-splits.js --apply    # actually write
//
// Requires DATABASE_URL in the environment. To target production, source
// the Neon connection string from Render before running:
//   export DATABASE_URL='postgresql://...neon.tech/...'
//   node scripts/backfill-repayment-splits.js --apply

require('dotenv').config();
const db = require('../config/database');

async function run({ apply = false } = {}) {
  const loansRes = await db.query(
    `SELECT DISTINCT l.id, l.total_interest
       FROM loans l
       JOIN repayments r ON r.loan_id = l.id
       ORDER BY l.id`
  );

  console.log(`Found ${loansRes.rows.length} loans with repayment history.\n`);

  let totalUpdated = 0;
  let totalScanned = 0;

  for (const loan of loansRes.rows) {
    const repaymentsRes = await db.query(
      `SELECT id, amount, principal_paid, interest_paid, created_at
         FROM repayments
         WHERE loan_id = $1
         ORDER BY created_at ASC, id ASC`,
      [loan.id]
    );

    const totalInterest = Number(loan.total_interest) || 0;
    let remaining = totalInterest;

    for (const r of repaymentsRes.rows) {
      totalScanned++;
      const amount = Number(r.amount);
      const interest = Math.round(Math.min(amount, remaining));
      const principal = Math.round(amount) - interest;
      remaining = Math.max(0, remaining - interest);

      const changed =
        Number(r.principal_paid) !== principal ||
        Number(r.interest_paid) !== interest;

      if (changed) {
        console.log(
          `  Loan ${loan.id} repayment ${r.id}: amount=${amount} ` +
          `-> principal=${principal} interest=${interest}` +
          (apply ? '  [APPLIED]' : '  [dry-run]')
        );
        if (apply) {
          await db.query(
            `UPDATE repayments SET principal_paid = $1, interest_paid = $2 WHERE id = $3`,
            [principal, interest, r.id]
          );
        }
        totalUpdated++;
      }
    }
  }

  console.log(`\nScanned ${totalScanned} repayment row(s).`);
  console.log(`${apply ? 'Updated' : 'Would update'} ${totalUpdated} row(s).`);
  if (!apply) {
    console.log('\nRe-run with --apply to write the changes.');
  }
}

const apply = process.argv.includes('--apply');
run({ apply })
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });