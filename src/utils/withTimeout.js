'use strict';

/** Reject with a labelled error if `promise` doesn't settle within `ms`. */
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${(ms / 1000).toFixed(ms % 1000 ? 1 : 0)}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Like withTimeout, but resolves to `fallback` (instead of rejecting) on
 * timeout or error, and reports what happened via `onSkip(reason)`.
 */
async function withTimeoutOr(promise, ms, label, fallback, onSkip) {
  try {
    return await withTimeout(promise, ms, label);
  } catch (err) {
    onSkip?.(`${label}: ${err.message}`);
    return fallback;
  }
}

module.exports = { withTimeout, withTimeoutOr };
