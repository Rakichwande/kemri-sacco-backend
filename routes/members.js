const express = require('express');
const router = express.Router();
const memberController = require('../controllers/memberController');
const { validateMemberRegistration } = require('../middleware/validate');
const requireApiKey = require('../middleware/requireApiKey');

router.post('/', validateMemberRegistration, memberController.registerMember);
router.get('/:id', requireApiKey, memberController.getMember);
router.get('/', requireApiKey, memberController.listMembers);

module.exports = router;