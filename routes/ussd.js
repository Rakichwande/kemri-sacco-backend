const express = require('express');
const router = express.Router();
const ussdController = require('../controllers/ussdController');
const { verifyUssdSource } = require('../middleware/verifyUssdSource');

// This is the one real endpoint Africa's Talking calls for every USSD
// session step. verifyUssdSource confirms the request actually came from
// AT (shared secret via the callback URL's query string, plus an IP
// allowlist once AT_USSD_ALLOWED_IPS is set from a confirmed list) before
// handleUssd ever runs - see middleware/verifyUssdSource.js for details on
// both checks and why a header-based secret wasn't usable here.
router.post('/', verifyUssdSource, ussdController.handleUssd);

module.exports = router;