const express = require('express');
const router = express.Router();
const memberController = require('../controllers/memberController');
const { validateMemberRegistration } = require('../middleware/validate');
const { authenticate, requirePermission } = require('../middleware/auth');

// Public - member self-registration, unchanged
router.post('/', validateMemberRegistration, memberController.registerMember);

// Staff/admin routes, gated by permission rather than a single binary
// admin/not-admin check. Super Administrator, SACCO Administrator, and
// Member Support can create/edit member records; Finance Officer, Loans
// Officer, Auditor, and legacy Staff can view but not modify.
router.post('/admin', authenticate, requirePermission('members:write'), validateMemberRegistration, memberController.adminCreateMember);
router.post('/import', authenticate, requirePermission('members:write'), memberController.importMembers);
router.get('/:id', authenticate, requirePermission('members:read'), memberController.getMember);
router.get('/', authenticate, requirePermission('members:read'), memberController.listMembers);
router.patch('/:id', authenticate, requirePermission('members:write'), memberController.updateMember);

module.exports = router;