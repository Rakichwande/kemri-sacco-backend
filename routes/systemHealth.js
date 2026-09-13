const express = require('express');
const router = express.Router();
const db = require('../config/database');
const UssdSession = require('../models/UssdSession');
const { authenticate, requireAdmin } = require('../middleware/auth');

// Only reports on integrations this system actually has. Base44's mock
// included generic SaaS-template cards (File Storage, Email Service, AI/LLM
// Service) that don't correspond to anything this backend actually runs -
// left out entirely rather than showing fake "Operational" badges for
// services that don't exist here.
router.get('/', authenticate, requireAdmin, async (req, res) => {
  const checks = {};

  // Database - a real query, timed for real
  const dbStart = Date.now();
  try {
    await db.query('SELECT 1');
    checks.database = { status: 'operational', detail: `${Date.now() - dbStart} ms` };
  } catch (err) {
    checks.database = { status: 'down', detail: err.message };
  }

  // Auth - if the server booted at all, JWT_SECRET passed validation
  // (config/env.js exits the process otherwise) - this reports that fact
  // rather than pretending to ping an external auth provider that doesn't exist.
  checks.authentication = { status: 'operational', detail: 'JWT secret configured' };

  // Daraja (M-Pesa) - configuration presence, not a live API ping (a real
  // ping would need a sandbox transaction and isn't worth doing on every
  // page load)
  const darajaConfigured = !!(process.env.DARAJA_CONSUMER_KEY && process.env.DARAJA_CONSUMER_SECRET && process.env.DARAJA_SHORTCODE);
  checks.daraja = {
    status: darajaConfigured ? 'operational' : 'not configured',
    detail: darajaConfigured ? `${process.env.DARAJA_ENV || 'sandbox'} mode` : 'Missing DARAJA_* env vars',
  };

  // Africa's Talking (SMS/USSD) - configuration presence, same reasoning
  const atConfigured = !!process.env.AT_API_KEY;
  checks.africastalking = {
    status: atConfigured ? 'operational' : 'not configured',
    detail: atConfigured ? `username: ${process.env.AT_USERNAME || 'sandbox'}` : 'Missing AT_API_KEY',
  };

  // USSD gateway - degraded if more than 20% of the last hour's sessions
  // failed (heuristic, but based on real logged sessions, not invented)
  let ussdStatus = { status: 'operational', detail: 'No recent sessions' };
  try {
    const stats = await UssdSession.recentFailureStats(60);
    if (stats.total > 0) {
      const failureRate = stats.failed / stats.total;
      ussdStatus = {
        status: failureRate > 0.2 ? 'degraded' : 'operational',
        detail: `${stats.failed}/${stats.total} failed in last hour`,
      };
    }
  } catch (err) {
    ussdStatus = { status: 'unknown', detail: 'Could not read session log' };
  }
  checks.ussd_gateway = ussdStatus;

  const anyDegraded = Object.values(checks).some((c) => c.status === 'degraded' || c.status === 'down');

  let recentSessions = [];
  try {
    recentSessions = await UssdSession.recent(20);
  } catch (err) {
    console.error('Failed to fetch recent USSD sessions:', err.message);
  }

  res.json({
    overallStatus: anyDegraded ? 'degraded' : 'operational',
    checkedAt: new Date().toISOString(),
    checks,
    recentSessions,
  });
});

module.exports = router;
