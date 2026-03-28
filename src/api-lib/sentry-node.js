/**
 * Server-side Sentry for selected Vercel API routes. No-op when `SENTRY_DSN` is unset.
 * @module src/api-lib/sentry-node
 */

"use strict";

const Sentry = require("@sentry/node");

const dsn = (process.env.SENTRY_DSN || "").trim();

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.VERCEL_ENV || process.env.NODE_ENV || "development",
  });
}

/**
 * @param {unknown} error
 */
function captureException(error) {
  if (!dsn) return;
  Sentry.captureException(error);
}

module.exports = { captureException };
