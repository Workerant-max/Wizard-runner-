// Library Runner hook for Claude Code (Node). Claude Code pipes one JSON event on stdin; we append it as one
// line for the extension to read. Same job as lr-hook.ps1, about 4x faster on Windows (~120 ms against
// ~550 ms per event, measured 30 Sep 2026), which matters because it runs twice for every tool call.
const fs = require('fs');
const path = require('path');
const os = require('os');
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  try {
    const line = raw.replace(/\r?\n/g, ' ').trim();
    if (!line) return;
    const dir = path.join(process.env.USERPROFILE || os.homedir(), '.library-runner');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'events.jsonl'), line + '\n');
  } catch (e) { /* never block Claude Code */ }
});
