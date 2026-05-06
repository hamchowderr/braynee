// Hook: SessionEnd — Final session cleanup
// No decision control; fires when session terminates
const { execSync } = require('child_process');
const path = require('path');
const os = require('os');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { input += c; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const cwd = data.cwd || process.cwd();
    const codeDir = path.join(os.homedir(), 'code');
    if (cwd.toLowerCase().startsWith(codeDir.toLowerCase())) {
      try { execSync('bd prime', { cwd, encoding: 'utf8', timeout: 5000, stdio: 'ignore' }); } catch {}
    }
  } catch {}
  process.exit(0);
});
