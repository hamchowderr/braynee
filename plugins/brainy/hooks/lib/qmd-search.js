// qmd-search.js — Shared QMD utility for hooks
// QMD is an optimization, not a replacement. Every QMD call has a filesystem fallback.
const { execSync } = require('child_process');
const path = require('path');

const QMD_SCRIPT = path.join(process.env.APPDATA, 'npm', 'node_modules', '@tobilu/qmd', 'dist', 'qmd.js');
const NODE = process.execPath;
const TIMEOUT = 5000; // 5 second timeout

/**
 * Search QMD for matching documents
 * @param {string} query - Search query
 * @param {string} collection - QMD collection ('vault' or 'code')
 * @param {number} limit - Max results
 * @returns {Array|null} - Array of results or null if QMD unavailable/failed
 */
function qmdSearch(query, collection = 'vault', limit = 5) {
  try {
    const result = execSync(
      `"${NODE}" "${QMD_SCRIPT}" search "${query}" -c ${collection} --json -n ${limit}`,
      { encoding: 'utf8', timeout: TIMEOUT, stdio: ['pipe', 'pipe', 'ignore'] }
    ).trim();
    if (!result) return null;
    return JSON.parse(result);
  } catch {
    return null;
  }
}

/**
 * Search for active session by project name via QMD
 * @param {string} projectName
 * @returns {string|null} - File path if found, null otherwise
 */
function findSessionViaQmd(projectName) {
  const results = qmdSearch(`session active ${projectName}`, 'vault', 5);
  if (!results || !Array.isArray(results)) return null;

  for (const r of results) {
    const filePath = r.path || r.file || '';
    if (filePath.includes('Sessions') && filePath.endsWith('.md')) {
      return filePath;
    }
  }
  return null;
}

module.exports = { qmdSearch, findSessionViaQmd };
