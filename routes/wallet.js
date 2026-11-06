const express = require('express');
const router = express.Router();
const walletController = require('../controllers/walletController');
const { authenticate, requirePermission } = require('../middleware/auth');

router.get('/', authenticate, requirePermission('loans:read'), walletController.getWithdrawals);

module.exports = router;