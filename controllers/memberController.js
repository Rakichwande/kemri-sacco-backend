const Member = require('../models/Member');
const smsService = require('../services/smsService');
const AuditLog = require('../models/AuditLog');

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

module.exports = { registerMember: registerMemberHandler, adminCreateMember, getMember, listMembers, updateMember, importMembers };
