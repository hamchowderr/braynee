'use strict';
// bd-task-map.js — a stable bd-issue <-> CC-task id map (cp-ydy).
//
// The three-way mirror (beads <-> CC tasks <-> TaskNotes) back-props by fuzzy
// title matching today, which risks closing/creating the wrong issue. This
// persists a durable map under `.beads/cc-task-map.json` so the back-prop hooks
// can resolve a stable `bd_id` for a CC task by id (exact) — falling back to a
// title join only at RECORD time, when bd create and TaskCreate fire back-to-back
// with identical titles (far safer than a title match at close time).
//
// Populated cooperatively across hooks:
//   - beads-todo-reminder (PostToolUse `bd create`): records { bd_id, title }.
//   - task-created-check  (TaskCreated):              records { cc_task_id, title }.
//   - task-completed-check (TaskCompleted):           READS to name the exact bd_id.
//
// Pure fs (no bd, no network), so it is unit-testable by bin/braynee-self-test §7.

const fs = require('fs');
const path = require('path');

const FILE = 'cc-task-map.json';
const VERSION = 1;
const MAX_ENTRIES = 500; // soft cap — prune oldest beyond this so the file can't grow unbounded

function mapPath(beadsDir) { return path.join(beadsDir, FILE); }

// Join key: unescape `\"`, trim, lowercase, collapse whitespace. (bd-create's
// reminder escapes quotes + slices to 140 chars; TaskCreate's subject is raw —
// normalize both to the same shape so the title join lines up.)
function normalizeTitle(t) {
  return String(t || '').replace(/\\"/g, '"').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 140);
}

function load(beadsDir) {
  try {
    const raw = fs.readFileSync(mapPath(beadsDir), 'utf8');
    const data = JSON.parse(raw);
    if (data && Array.isArray(data.entries)) return { version: data.version || VERSION, entries: data.entries };
  } catch { /* missing or corrupt map — callers get a fresh empty one */ }
  return { version: VERSION, entries: [] };
}

function save(beadsDir, data) {
  try {
    if (data.entries.length > MAX_ENTRIES) {
      data.entries.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
      data.entries = data.entries.slice(-MAX_ENTRIES);
    }
    const p = mapPath(beadsDir);
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, p); // atomic replace
    return true;
  } catch { return false; }
}

// Insert or merge a record. Joins to an existing entry by the id being provided
// (stable), else by a title that is still MISSING that id (so a complete pair is
// never clobbered, even when two issues share a title). Fills only empty fields.
// Returns the resolved entry.
function upsert(beadsDir, { bdId, ccTaskId, title } = {}, now) {
  const ts = now || new Date().toISOString();
  const data = load(beadsDir);
  const nt = normalizeTitle(title);
  const cc = ccTaskId != null ? String(ccTaskId) : null;

  let entry = null;
  if (cc) entry = data.entries.find(e => e.cc_task_id != null && String(e.cc_task_id) === cc);
  if (!entry && bdId) entry = data.entries.find(e => e.bd_id === bdId);
  if (!entry && nt) {
    entry = data.entries.find(e => normalizeTitle(e.title) === nt
      && ((bdId && !e.bd_id) || (cc && !e.cc_task_id) || (!bdId && !cc)));
  }
  if (!entry) {
    entry = { bd_id: null, cc_task_id: null, title: title || '', created_at: ts, updated_at: ts };
    data.entries.push(entry);
  }

  if (bdId && !entry.bd_id) entry.bd_id = bdId;
  if (cc && !entry.cc_task_id) entry.cc_task_id = cc;
  if (title && !entry.title) entry.title = title;
  entry.updated_at = ts;

  save(beadsDir, data);
  return entry;
}

function lookupByTaskId(beadsDir, ccTaskId) {
  if (ccTaskId == null) return null;
  const cc = String(ccTaskId);
  return load(beadsDir).entries.find(e => e.cc_task_id != null && String(e.cc_task_id) === cc) || null;
}

function lookupByBdId(beadsDir, bdId) {
  if (!bdId) return null;
  return load(beadsDir).entries.find(e => e.bd_id === bdId) || null;
}

function lookupByTitle(beadsDir, title) {
  const nt = normalizeTitle(title);
  if (!nt) return null;
  return load(beadsDir).entries.find(e => normalizeTitle(e.title) === nt) || null;
}

// Best-effort resolve for a CC-task event: prefer the stable id, fall back to title.
function resolve(beadsDir, { ccTaskId, title } = {}) {
  return (ccTaskId != null && lookupByTaskId(beadsDir, ccTaskId)) || lookupByTitle(beadsDir, title) || null;
}

module.exports = {
  FILE, VERSION, MAX_ENTRIES,
  mapPath, normalizeTitle, load, save,
  upsert, lookupByTaskId, lookupByBdId, lookupByTitle, resolve,
};
