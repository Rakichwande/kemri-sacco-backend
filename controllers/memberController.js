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

// Admin-only edit. Fields are restricted to a whitelist — values the
// loan/payment flows own (credit_limit, total_outstanding_balance,
// successful_repayments) and identity fields that must not change
// silently (id_number) are excluded.
//
// phone_number IS editable (added Oct 2026) because members change SIMs
// and staff must be able to update records without direct SQL access.
// Three safeguards apply:
//
//   1. Normalization. The admin might type 0722757590, 722757590,
//      +254722757590, or with spaces/dashes. All normalize to the
//      canonical +254 form via Member.normalizePhone(). Rejecting
//      unparseable input rather than storing a non-standard form.
//
//   2. Unique-constraint handling. The members table has a UNIQUE
//      constraint on phone_number. If the new value matches another
//      member's, Postgres throws code 23505; the catch block below
//      converts that to a specific 409 message rather than a generic 500.
//
//   3. Dual notification. Changing a phone changes the member's USSD
//      identity — an attacker who gains access to this form could
//      reassign a phone number and, if no PIN is set, set one via USSD.
//      To mitigate: after a successful change, an SMS is sent to BOTH
//      the old and new numbers so the real member is informed and can
//      report fraud.
//
// is_board_staff remains excluded — it grants auto-approved loans and has
// its own dedicated endpoint, gated by its own permission.
const EDITABLE_FIELDS = ['full_name', 'phone_number', 'nationality', 'age', 'employer', 'scheme', 'status'];

async function updateMember(req, res) {
  try {
    const existing = await Member.findById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Member not found' });

    const updates = {};
    for (const field of EDITABLE_FIELDS) {
      if (req.body[field] === undefined) continue;
      updates[field] = req.body[field] === '' ? null : req.body[field];
    }

    // Normalize phone_number BEFORE the update.
    if (updates.phone_number !== undefined && updates.phone_number !== null) {
      const normalized = Member.normalizePhone(updates.phone_number);
      if (!normalized) {
        return res.status(400).json({
          error: `"${updates.phone_number}" is not a valid Kenyan mobile number. Accepted formats: 0722757590, 722757590, +254722757590.`,
        });
      }
      updates.phone_number = normalized;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: `No editable fields provided. Editable: ${EDITABLE_FIELDS.join(', ')}` });
    }

    const updated = await Member.update(req.params.id, updates);

    const phoneChanged =
      updates.phone_number !== undefined && updates.phone_number !== existing.phone_number;

    await AuditLog.log({
      actorId: req.user.id,
      actorUsername: req.user.username,
      action: phoneChanged ? 'Updated member (phone changed)' : 'Updated member',
      category: 'member_edit',
      targetType: 'member',
      targetId: req.params.id,
      targetLabel: updated.full_name,
      details: phoneChanged
        ? `Changed: ${Object.keys(updates).join(', ')}. Phone: ${existing.phone_number || '(none)'} → ${updated.phone_number}`
        : `Changed: ${Object.keys(updates).join(', ')}`,
    });

    if (phoneChanged) {
      const changeMsg =
        `KEMRI SACCO: Your registered phone number was changed to ${updated.phone_number}. ` +
        `If this wasn't you, contact our office immediately.`;

      try {
        await smsService.sendSMS(updated.phone_number, changeMsg);
      } catch (smsErr) {
        console.error('Phone-change SMS to new number failed:', smsErr.message);
      }

      if (existing.phone_number) {
        try {
          await smsService.sendSMS(existing.phone_number, changeMsg);
        } catch (smsErr) {
          console.error('Phone-change SMS to old number failed:', smsErr.message);
        }
      }
    }

    res.json(updated);
  } catch (err) {
    if (err.code === '23505') {
      const constraint = err.constraint || '';
      if (constraint.includes('phone_number')) {
        return res.status(409).json({
          error: 'That phone number is already registered to another member. Each phone can only be linked to one account.',
        });
      }
      return res.status(409).json({
        error: 'A member with that value already exists.',
      });
    }
    console.error(err);
    res.status(500).json({ error: 'Failed to update member' });
  }
}

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

async function deleteMember(req, res) {
  try {
    const result = await Member.remove(req.params.id);

    if (!result) {
      return res.status(404).json({ error: 'Member not found' });
    }

    if (!result.deleted) {
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

    const cleanupDetails = [];
    if (result.removedLoans?.length) {
      cleanupDetails.push(
        `${result.removedLoans.length} loan application(s) removed: ${result.removedLoans
          .map((l) => `LN-${String(l.id).padStart(5, '0')} (${l.status})`)
          .join(', ')}`
      );
    }
    if (result.removedPayments?.length) {
      cleanupDetails.push(
        `${result.removedPayments.length} pending/failed payment attempt(s) removed: ids ${result.removedPayments
          .map((p) => p.id)
          .join(', ')}`
      );
    }
    if (result.removedWithdrawals?.length) {
      cleanupDetails.push(
        `${result.removedWithdrawals.length} withdrawal request(s) removed: ids ${result.removedWithdrawals
          .map((w) => w.id)
          .join(', ')}`
      );
    }

    await AuditLog.log({
      actorId: req.user.id,
      actorUsername: req.user.username,
      action: 'Deleted member',
      category: 'member_edit',
      targetType: 'member',
      targetId: req.params.id,
      targetLabel: `${result.member.full_name} (ref ${result.member.imported_reference || '—'})`,
      details:
        'Permanent deletion — no financial history on record.' +
        (cleanupDetails.length ? ' Also removed: ' + cleanupDetails.join('; ') + '.' : ''),
    });

    res.json({
      message: 'Member deleted.',
      member: {
        id: result.member.id,
        full_name: result.member.full_name,
        reference: result.member.imported_reference,
      },
      removedLoans: result.removedLoans?.length || 0,
      removedPayments: result.removedPayments?.length || 0,
      removedWithdrawals: result.removedWithdrawals?.length || 0,
    });
  } catch (err) {
    console.error('Member deletion error:', err);
    res.status(500).json({ error: 'Failed to delete member' });
  }
}

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