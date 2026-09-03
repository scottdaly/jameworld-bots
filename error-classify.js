'use strict';
/**
 * Classifying "the model didn't answer" so a capacity blip, a revoked
 * credential, and an ordinary bug get three different responses instead of
 * one silent "nothing changed".
 *
 * Shared between data-boy.js (the plain chat/code path) and
 * toaster-feature.js (the feature/worker path) rather than duplicated --
 * they need to agree on what counts as retryable and what the fun-toned
 * messages say, and data-boy.js already requires toaster-feature.js, so a
 * third small module here is what keeps that from becoming circular.
 */

// How long to back off between capacity retries. Matches what a Google/
// Anthropic capacity blip empirically takes to clear -- seconds to a minute,
// not longer.
const CAPACITY_RETRY_DELAYS_MS = [5_000, 15_000, 30_000];

// Who to blame, in the bit the original message already had going for it --
// it used to say "Google" unconditionally, written back when everything ran
// through Gemini, and nobody updated it once the feature route started
// forcing Anthropic. An Opus outage was getting reported as Google's fault.
const PROVIDER_FLAVOR = { anthropic: 'Anthropic', gemini: 'Google', 'gemini-api': 'Google' };
function providerName(provider) {
  return PROVIDER_FLAVOR[provider] || 'the model';
}
function capacityRetryMessage(provider) {
  return `${providerName(provider)} is cucking data boy right now (ꐦ¬_¬)... give him a minute`;
}
function capacityFinalMessage(provider) {
  return `${providerName(provider)} is still cucking data boy (｡•̀ ⤙ •́ ｡ꐦ)... try again in a few minutes.`;
}

// Recognize the family of "the upstream is overloaded, your retries won't
// help, fail fast" errors. Matches messages emitted by both the Vercel AI
// SDK wrapper and the underlying Gemini / Anthropic transports.
function isCapacityError(err) {
  const msg = String(err && err.message || err || '').toLowerCase();
  return (
    msg.includes('no capacity available') ||
    msg.includes('overloaded') ||
    msg.includes('resource exhausted') ||
    msg.includes('unavailable') ||
    msg.includes('503') ||
    msg.includes('529') ||
    msg.includes('429') ||
    msg.includes('rate limit') ||
    msg.includes('quota')
  );
}

// The other way a job can go quiet: credentials that no longer work. Unlike
// capacity, backing off and trying again does nothing -- a revoked or
// expired token is still revoked or expired five minutes from now. Every job
// after the first would fail the exact same way, indistinguishable from
// ordinary bad luck, with nothing anywhere saying "this is systemic, go look
// at the token" instead of "eh, one job didn't work out".
function isAuthError(err) {
  const msg = String(err && err.message || err || '').toLowerCase();
  return (
    msg.includes('401') ||
    msg.includes('unauthorized') ||
    msg.includes('invalid api key') ||
    msg.includes('invalid_api_key') ||
    msg.includes('authentication_error') ||
    msg.includes('could not authenticate') ||
    msg.includes('invalid_grant') ||
    msg.includes('token has expired') ||
    msg.includes('token expired') ||
    (msg.includes('please run') && msg.includes('login')) ||
    msg.includes('not authenticated')
  );
}

const AUTH_HINT = {
  anthropic: 'CLAUDE_CODE_OAUTH_TOKEN needs a human to look at it',
  gemini: 'the Gemini OAuth creds need a human to look at them',
  'gemini-api': 'GOOGLE_API_KEY needs a human to look at it',
};
function authFailureMessage(provider) {
  return `Data Boy's ${providerName(provider)} login just got yeeted mid-shift (¬_¬) -- ` +
    `retrying won't fix this, ${AUTH_HINT[provider] || 'the credentials need a human to look at them'}.`;
}

module.exports = {
  CAPACITY_RETRY_DELAYS_MS,
  providerName,
  capacityRetryMessage,
  capacityFinalMessage,
  isCapacityError,
  isAuthError,
  authFailureMessage,
};
