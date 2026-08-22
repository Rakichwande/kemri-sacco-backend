const Member = require('../models/Member');
const smsService = require('../services/smsService');

async function registerMember(req, res) {
  try {
    const { full_name, id_number, phone_number, nationality, age, employer, scheme } = req.body;

    if (!full_name || !id_number || !phone_number) {
      return res.status(400).json({ error: 'full_name, id_number, and phone_number are required' });
    }

    const existing = await Member.findByPhone(phone_number);
    if (existing) {
      return res.status(409).json({ error: 'A member with this phone number already exists' });
    }

    const member = await Member.create({ full_name, id_number, phone_number, nationality, age, employer, scheme });

    // SMS is a notification, not a precondition - registration should succeed
    // even if Africa's Talking is unreachable or unconfigured
    try {
      await smsService.sendSMS(phone_number, smsService.templates.applicationReceived(full_name));
    } catch (smsErr) {
      console.error('SMS notification failed (member still registered):', smsErr.message);
    }

    res.status(201).json(member);
    } catch (err) {
    if (err.code === '23505') {
      // Postgres unique constraint violation - most likely a duplicate ID
      // number, since duplicate phone is already checked before this point
      return res.status(409).json({ error: 'This ID number is already registered with KEMRI SACCO.' });
    }
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
    const members = await Member.findAll();
    res.json(members);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch members' });
  }
}

module.exports = { registerMember, getMember, listMembers };
