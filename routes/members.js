const express = require('express');
const router = express.Router();
const memberController = require('../controllers/memberController');

router.post('/', memberController.registerMember);
router.get('/:id', memberController.getMember);
router.get('/', memberController.listMembers);

module.exports = router;
