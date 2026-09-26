const Member = require('../models/Member');
const smsService = require('../services/smsService');
const AuditLog = require('../models/AuditLog');
const notificationService = require('../services/notificationService');
const emailService = require('../services/emailService');

async function registerMember(req, res) {
  try {
    const { full_name, id_number, phone_number, nationality, age, employer, scheme } = req.body;

    if (!full_name || !id_number || !phone_number) {
      const err = new Error('full_name, id_number, and phone_number are required');
      err.statusCode = 400;
      throw err;
    }

    const existing = await Member.findByPhone(phone_number);
    if (existing) {
      const err = new Error('A member with this phone number already exists');
      err.statusCode = 409;
      throw err;
    }

    const member = await Member.create({ full_name, id_number, phone_number, nationality, age, employer, scheme });

    // SMS is a notification, not a precondition - registration should succeed
    // even if Africa's Talking is unreachable or unconfigured
    try {
      await smsService.sendSMS(phone_number, smsService.templates.applicationReceived(full_name));
    } catch (smsErr) {
      console.error('SMS notification failed (member still registered):', smsErr.message);
    }
    notificationService.notifyStaff({
      smsText: smsService.templates.staffNewMember(full_name),
      emailContent: emailService.staffTemplates.newMember(full_name),
    });

    return member;
  } catch (err) {
    if (err.statusCode) throw err;
    if (err.code === '23505') {
      const dupError = new Error('This ID number is already registered with KEMRI SACCO.');
      dupError.statusCode = 409;
      throw dupError;
    }
    throw err;
  }
}

// Public self-registration endpoint (USSD/registration form) - no auth
async function registerMemberHandler(req, res) {
  try {
    const member = await registerMember(req, res);
    res.status(201).json(member);
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Failed to register member' });
  }
}

// Admin-initiated member creation - same underlying logic, but requires
// admin auth and writes to the audit trail, since this is staff acting on a
// member's behalf rather than the member registering themselves.
async function adminCreateMember(req, res) {
  try {
    const member = await registerMember(req, res);

    await AuditLog.log({
      actorId: req.user.id,
      actorUsername: req.user.username,
      action: 'Created member',
      category: 'member_registration',
      targetType: 'member',
      targetId: member.id,
      targetLabel: member.full_name,
      details: `Registered member · ${member.employer || 'no employer listed'}`,
    });

    res.status(201).json(member);
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Failed to register member' });
  }
}

async function getMember(req, res) {
  try {
    const member = await Member.findById(req.params.id);
    if (!member) return res.status(404).json({ error: 'Member not found' });
    res.json(member);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch member' });
  }
}

async function listMembers(req, res) {
  try {
    const members = await Member.findAllForDirectory();
    res.json(members);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch members' });
  }
}

// Admin-only edit. Deliberately excludes id_number, phone_number, credit_limit,
// total_outstanding_balance and successful_repayments - those are either
// registration-fixed identity fields or values the loan/payment flows own
// and must stay in sync with actual transactions, not a manual edit.
//
// is_board_staff is ALSO deliberately excluded here, for a stricter reason:
// it grants auto-approved loans. That write path is the separate
// setBoardStaff() endpoint below, gated by its own permission. Member.update()
// enforces this at the model layer too, so even a future controller that
// forgets to keep the whitelist clean cannot grant the privilege through the
// general edit route.
const EDITABLE_FIELDS = ['full_name', 'nationality', 'age', 'employer', 'scheme', 'status'];

async function updateMember(req, res) {
  try {
    const existing = await Member.findById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Member not found' });

    const updates = {};
    for (const field of EDITABLE_FIELDS) {
      if (req.body[field] === undefined) continue;
      // A blank field from the edit form means "clear this," not the literal
      // string "" - especially critical for `age`, an integer column that
      // rejects an empty string outright (this was the actual cause behind
      // "Failed to update member" whenever age or nationality was left blank).
      updates[field] = req.body[field] === '' ? null : req.body[field];
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: `No editable fields provided. Editable: ${EDITABLE_FIELDS.join(', ')}` });
    }

    const updated = await Member.update(req.params.id, updates);

    await AuditLog.log({
      actorId: req.user.id,
      actorUsername: req.user.username,
      action: 'Updated member',
      category: 'member_edit',
      targetType: 'member',
      targetId: req.params.id,
      targetLabel: updated.full_name,
      details: `Changed: ${Object.keys(updates).join(', ')}`,
    });

    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update member' });
  }
}

// Grant or revoke board/staff status. Board/staff members are auto-approved
// for loans under the SACCO policy agreed 25 Sept 2026; everyone else follows
// the normal staff-review path. This is the ONLY endpoint that may write
// is_board_staff — the general edit route excludes it, and Member.update()
// throws if it's ever passed there anyway.
//
// Requires the members:set_board_status permission (Super Administrator and
// SACCO Administrator only), enforced by middleware on the route, not here.
//
// Body: { is_board_staff: true | false }. The typeof check is strict on
// purpose: Member.setBoardStaffStatus() coerces with !! internally, so a
// stray "false" string coming through as truthy would silently grant the
// privilege. Rejecting anything that isn't a real boolean closes that.
//
// A no-op request (flag already in the target state) is short-circuited:
// the write is skipped and no audit entry is written, so repeated clicks
// or a duplicated request don't fill the trail with non-changes.
async function setBoardStaff(req, res) {
  try {
    const { is_board_staff } = req.body;
    if (typeof is_board_staff !== 'boolean') {
      return res.status(400).json({ error: 'is_board_staff must be true or false' });
    }

    const existing = await Member.findById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Member not found' });

    if (existing.is_board_staff === is_board_staff) {
      return res.json({
        ...existing,
        unchanged: true,
        message: `Already ${is_board_staff ? 'board/staff' : 'not board/staff'} — no change made.`,
      });
    }

    const updated = await Member.setBoardStaffStatus(req.params.id, is_board_staff);
    if (!updated) {
      // The row vanished between the read above and the write. Rare, but a
      // concurrent delete would land here, and a 404 is the honest answer.
      return res.status(404).json({ error: 'Member not found' });
    }

    await AuditLog.log({
      actorId: req.user.id,
      actorUsername: req.user.username,
      action: is_board_staff ? 'Granted board/staff status' : 'Revoked board/staff status',
      category: 'member_edit',
      targetType: 'member',
      targetId: req.params.id,
      targetLabel: updated.full_name,
      details: `is_board_staff: ${existing.is_board_staff} → ${updated.is_board_staff} (ref ${updated.imported_reference || '—'})`,
    });

    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update board/staff status' });
  }
}

// Permanently delete a member. Only reachable through a route gated by
// members:delete (Super Administrator and SACCO Administrator only) — the
// general edit route cannot reach this, and Member.remove() enforces the
// history check regardless of caller.
//
// Response codes, all deliberate:
//   200 — deleted
//   404 — member not found (or already deleted)
//   409 — blocked: member has transaction history; body carries a
//         breakdown of what blocked it so the UI can show a specific message
//   500 — unexpected error
//
// EVERY outcome is audit-logged, including blocked attempts. A refused
// deletion is as worth recording as a successful one — it is evidence the
// safety check ran, and it lets an auditor later answer "who tried to
// delete this member and when?" without needing the original request logs.
async function deleteMember(req, res) {
  try {
    const result = await Member.remove(req.params.id);

    if (!result) {
      return res.status(404).json({ error: 'Member not found' });
    }

    if (!result.deleted) {
      // Blocked: the member has financial history. Log the attempt with
      // the counts so the trail shows exactly why it was refused.
      await AuditLog.log({
        actorId: req.user.id,
        actorUsername: req.user.username,
        action: 'Blocked member deletion (has history)',
        category: 'member_edit',
        targetType: 'member',
        targetId: req.params.id,
        targetLabel: result.member?.full_name || '(unknown)',
        details: result.counts
          ? `Refused: ${JSON.stringify(result.counts)}`
          : `Refused: ${result.message}`,
      });

      return res.status(409).json({
        error: result.message,
        code: result.code,
        counts: result.counts || null,
      });
    }

    await AuditLog.log({
      actorId: req.user.id,
      actorUsername: req.user.username,
      action: 'Deleted member',
      category: 'member_edit',
      targetType: 'member',
      targetId: req.params.id,
      targetLabel: `${result.member.full_name} (ref ${result.member.imported_reference || '—'})`,
      details: 'Permanent deletion — no transaction history on record',
    });

    res.json({
      message: 'Member deleted.',
      member: {
        id: result.member.id,
        full_name: result.member.full_name,
        reference: result.member.imported_reference,
      },
    });
  } catch (err) {
    console.error('Member deletion error:', err);
    res.status(500).json({ error: 'Failed to delete member' });
  }
}

// Bulk import of pre-existing members. One summary audit entry, not one per
// row - a 2,000-row import writing 2,000 audit rows would drown the trail.
async function importMembers(req, res) {
  try {
    const { rows } = req.body;
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: 'rows must be a non-empty array' });
    }
    if (rows.length > 5000) {
      return res.status(400).json({ error: 'Import is capped at 5000 rows per file - split larger files.' });
    }

    const results = await Member.bulkImport(rows);

    await AuditLog.log({
      actorId: req.user.id,
      actorUsername: req.user.username,
      action: 'Bulk imported members',
      category: 'member_registration',
      targetType: 'import',
      targetId: null,
      targetLabel: `${results.created} member(s)`,
      details: `Imported ${results.created} of ${rows.length} rows. ${results.skipped.length} skipped.`,
    });

    res.json(results);
  } catch (err) {
    console.error('Member import error:', err);
    res.status(500).json({ error: 'Import failed' });
  }
}

module.exports = {
  registerMember: registerMemberHandler,
  adminCreateMember,
  getMember,
  listMembers,
  updateMember,
  setBoardStaff,
  deleteMember,
  importMembers,
};