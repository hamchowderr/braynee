'use strict';

// dolthub-sync-core.js — pure helpers behind scripts/beads-dolthub.mjs (cp-3tk).
//
// braynee is local-first: nothing here runs unless the user asks, no feature
// depends on it, and no DoltHub account is baked in. Each beads project is its
// own Dolt database, so off-machine sync is per project: one DoltHub database
// per repo, under an owner the user names.
//
// What bd already ships, and so what this does NOT reimplement (bd 1.3.4,
// beads docs/reference/configuration.md, verified live):
//   - `bd dolt remote add origin <url>` wires the remote AND sets sync.remote
//   - `bd dolt push` / `bd dolt pull`
//   - `dolt.auto-push` (opt-in, default false): push after writes, throttled by
//     dolt.auto-push-interval. bd made it opt-in because concurrent pushes from
//     several writers can corrupt a remote's manifest, so it is only safe for a
//     single-writer setup. We set it only on request and say why.
//   - `dolt.local-only`: the user's explicit "never touch the network". We
//     refuse to wire a repo that has it.
// What bd does not ship, and this does: creating the DoltHub database (DoltHub
// API, POST /api/v1alpha1/database) and doing the wiring for a chosen set of
// repos in one go.

const DOLTHUB_REMOTE_HOST = 'https://doltremoteapi.dolthub.com';

/** DoltHub database names: letters, digits, `-` and `_`. */
function dolthubName(base) {
  const n = String(base || '').trim().replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return n || null;
}

function validOwner(owner) {
  return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(String(owner || ''));
}

function remoteUrl(owner, name) {
  return `${DOLTHUB_REMOTE_HOST}/${owner}/${name}`;
}

/** Parse `bd dolt remote list`: `<name>   <url>` rows; "No remotes configured." is []. */
function parseRemotes(out) {
  const rows = [];
  for (const line of String(out || '').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9_.-]+)\s+(\S+:\/\/\S+|\S+@\S+:\S+)\s*$/.exec(line);
    if (m) rows.push({ name: m[1], url: m[2] });
  }
  return rows;
}

/** owner/name when a URL points at DoltHub, else null. */
function dolthubTarget(url) {
  const m = /^https:\/\/doltremoteapi\.dolthub\.com\/([^/\s]+)\/([^/\s]+?)\/?$/.exec(String(url || ''));
  return m ? { owner: m[1], name: m[2] } : null;
}

/**
 * Decide what `--enable` should do for one repo.
 * state: { origin: url|null, localOnly: bool }
 * Returns { action: 'skip'|'wire'|'already', reason, url }.
 */
function planEnable(state, owner, name) {
  const url = remoteUrl(owner, name);
  if (state.localOnly) return { action: 'skip', reason: 'dolt.local-only is set: the user asked for no network', url };
  if (state.origin) {
    if (state.origin === url) return { action: 'already', reason: 'origin already points here', url };
    return { action: 'skip', reason: `origin already points elsewhere (${state.origin}); not overwriting`, url };
  }
  return { action: 'wire', reason: 'no origin yet', url };
}

/** Request body for DoltHub's create-database API (v1alpha1, documented). */
function createDatabaseBody(owner, name, visibility = 'private') {
  return {
    ownerName: owner,
    repoName: name,
    visibility: visibility === 'public' ? 'public' : 'private',
    description: 'beads issue tracker (bd), wired by braynee',
  };
}

module.exports = {
  DOLTHUB_REMOTE_HOST, dolthubName, validOwner, remoteUrl, parseRemotes,
  dolthubTarget, planEnable, createDatabaseBody,
};
