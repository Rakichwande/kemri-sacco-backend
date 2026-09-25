/**
 * One-off backfill: mark the 17 board and staff members as is_board_staff.
 *
 * These are the members who, under SACCO policy agreed 25 Sept 2026, are
 * auto-approved for loan applications — no staff review step. Everyone else
 * (including any member who self-registers in future) follows the normal
 * apply → review path.
 *
 * Safe to re-run. Member.setBoardStaffByReferences() is a plain UPDATE with
 * SET is_board_staff = true, so a second run is a no-op for rows already
 * flagged. The script deliberately does NOT demote anyone — if a reference
 * is removed from the list in future, that member keeps their flag until
 * explicitly demoted via setBoardStaffStatus(id, false) through the admin
 * API (which audits the change).
 *
 * Run locally against production:
 *   DATABASE_URL=<production-url> node scripts/backfill-board-staff.js
 *
 * Or against whatever DATABASE_URL your .env points at, if you have a .env
 * loaded. Verify the connection target in the output before trusting it.
 */

const Member = require('../models/Member');
const pool = require('../config/database');

// The 17 from the CEO's "Board and Staff Members" sheet, 25 Sept 2026.
// Reference numbers are the SACCO's own P/NO column — the identifier the
// register uses, not our internal members.id.
const REFS = [
  '21010', // DIVINA CHEBICHII
  '21296', // BENEAR A. OBANDA
  '21427', // SAMUEL M. MUTURI
  '21438', // ANTHONY G. KAMIGWI
  '21785', // ERIC M. MUGAMBI
  '21795', // RICHARD W. KARANJA
  '21861', // MURIITHI MURUNGI
  '21880', // BENARD K. KETER
  '21945', // BRIDGET W. KIMANI
  '21598', // JAMES MIONJIA WODERA
  '93014', // JAMES KARIITHI
  '20648', // LUCAS S. AGURA
  '93007', // JUDITH WANZA
  '93010', // NOEL INDATA
  '93013', // JOSEPH K. MUTUNGA
  '93015', // NATALIE ADAH
  '93016', // DEREK M. MUSIYA
];

(async () => {
  try {
    // Print the connection target so there's no ambiguity about which
    // database this is about to modify. Host only — the URL may carry
    // credentials, so parse just the hostname and database name.
    const url = process.env.DATABASE_URL || '';
    let target = 'unknown';
    try {
      const parsed = new URL(url);
      target = `${parsed.hostname}${parsed.pathname}`;
    } catch {
      target = '(could not parse DATABASE_URL)';
    }
    console.log(`Connecting to: ${target}\n`);

    // Show current state before touching anything.
    const before = await pool.query(
      `SELECT COUNT(*)::int AS n FROM members WHERE is_board_staff`
    );
    console.log(`Currently flagged as board/staff: ${before.rows[0].n}`);
    console.log(`Backfill list size:               ${REFS.length}\n`);

    // Do the update.
    const updated = await Member.setBoardStaffByReferences(REFS, true);

    console.log(`Matched ${updated.length} of ${REFS.length} references.\n`);
    for (const m of updated) {
      console.log(`  ✓ ${m.imported_reference.padEnd(6)}  ${m.full_name}`);
    }

    // Any reference in the list with no live member row is a real problem —
    // either a typo in the list, or a member who was never imported. Surface
    // it loudly rather than silently dropping it.
    const matchedRefs = new Set(updated.map((m) => m.imported_reference));
    const missing = REFS.filter((r) => !matchedRefs.has(r));
    if (missing.length > 0) {
      console.warn(`\n⚠ ${missing.length} reference(s) did NOT match any member:`);
      for (const r of missing) console.warn(`    ${r}`);
      console.warn('  → Check the register for typos, or confirm the member was imported.');
    }

    // Show final state.
    const after = await pool.query(
      `SELECT COUNT(*)::int AS n FROM members WHERE is_board_staff`
    );
    console.log(`\nNow flagged as board/staff: ${after.rows[0].n}`);
    console.log('Done.');

    process.exit(missing.length > 0 ? 1 : 0);
  } catch (err) {
    console.error('Backfill failed:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();