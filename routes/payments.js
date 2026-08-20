const express = require('express');
const router = express.Router();
const paymentController = require('../controllers/paymentController');
const { validatePaymentInitiation } = require('../middleware/validate');

router.post('/initiate', validatePaymentInitiation, paymentController.initiatePayment);
router.get('/status/:checkoutRequestId', paymentController.getPaymentStatus);

module.exports = router;