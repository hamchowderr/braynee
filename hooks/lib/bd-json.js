'use strict';

// bd-json.js — read `bd ... --json` output in both of bd's shapes (cp-uif3.6).
//
// Legacy (today's default): the payload is the top level — an array for
// list/ready/show, an object for stats.
// Envelope (BD_JSON_ENVELOPE=1 today, the default from beads v2.0):
//   { "data": <payload>, "schema_version": 1 }
// Verified on bd 1.3.4 for list, show, ready and stats.
//
// A parser that only knows the legacy shape does not fail loudly on the
// envelope: `Array.isArray(envelope)` is false, so a list silently reads as
// empty and a hook goes quiet. Every bd JSON read in braynee goes through
// `unwrap` so the switch to v2.0 is a no-op here.
//
// The envelope is recognised only when BOTH `schema_version` and `data` are
// present, so a legacy object that merely has a `data` field is not unwrapped.

function isEnvelope(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v)
    && Object.prototype.hasOwnProperty.call(v, 'schema_version')
    && Object.prototype.hasOwnProperty.call(v, 'data');
}

/** The payload of an already-parsed bd JSON value, in either shape. */
function unwrap(v) {
  return isEnvelope(v) ? v.data : v;
}

/** Parse bd JSON text and unwrap it. Throws on invalid JSON, like JSON.parse. */
function parse(text) {
  return unwrap(JSON.parse(text));
}

/** Parse and unwrap, returning `fallback` on invalid JSON instead of throwing. */
function parseOr(text, fallback) {
  try { return parse(text); } catch { return fallback; }
}

/** Parse and unwrap a list command's output; anything that is not a list is []. */
function parseList(text) {
  const v = parseOr(text, null);
  return Array.isArray(v) ? v : [];
}

module.exports = { isEnvelope, unwrap, parse, parseOr, parseList };
