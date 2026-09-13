const express = require('express');
const router = express.Router();
const memberController = require('../controllers/memberController');
const { validateMemberRegistration } = require('../middleware/validate');
const { authenticate, requireAdmin } = require('../middleware/auth');

router.post('/', validateMemberRegistration, memberController.registerMember);
router.post('/admin', authenticate, requireAdmin, validateMemberRegistration, memberController.adminCreateMember);
router.post('/import', authenticate, requireAdmin, memberController.importMembers);
router.get('/:id', authenticate, requireAdmin, memberController.getMember);
router.get('/', authenticate, requireAdmin, memberController.listMembers);
router.patch('/:id', authenticate, requireAdmin, memberController.updateMember);

module.exports = router;
