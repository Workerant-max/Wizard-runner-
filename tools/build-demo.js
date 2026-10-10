// Builds demo.html: the real webview (media/main.css + media/main.js) inlined into one file, run inside an
// iframe exactly as VS Code runs it, with acquireVsCodeApi stubbed and buttons that post the same messages
// the extension posts. Run: node build-demo.js
const fs = require('fs');
const path = require('path');
const dir = __dirname;
const css = fs.readFileSync(path.join(dir, '..', 'media', 'main.css'), 'utf8');
const js = fs.readFileSync(path.join(dir, '..', 'media', 'main.js'), 'utf8');

// the same body the extension's html() writes, minus the nonce and the Google Fonts link
const panel = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>${css}</style>
<style>body{--vscode-panel-background:#15121f}</style>
</head><body>
<div class="stage" id="stage">
  <canvas id="cv" width="320" height="164" aria-label="Pixel-art reading room where the wizard works"></canvas>
  <div class="say" id="say"></div>
  <div class="card" id="ans" hidden>
    <div class="card-h"><small id="anshead">BACK FROM THE READING ROOM</small><button class="x" id="ansx" title="Dismiss" aria-label="Dismiss">×</button></div>
    <div class="card-b" id="anstext"></div>
    <div class="row" id="ansrow"></div>
  </div>
  <div class="card warn" id="ask" hidden>
    <div class="card-h"><small>NEEDS YOU</small></div>
    <div class="card-b" id="asktext"></div>
    <div class="row" id="askrow"><button class="vb" id="allow">Allow</button><button class="vb sec" id="deny">Deny</button></div>
  </div>
</div>
<div class="bar">
  <div class="steps"><span id="pills" class="pills"></span><span id="trip"></span></div>
  <form class="in" id="form">
    <input id="q" type="text" placeholder="Ask the wizard… (demo: starts the replay)" aria-label="Prompt" autocomplete="off">
    <button class="vb" id="go" type="submit">Send him ↗</button>
  </form>
</div>
<script>
window.acquireVsCodeApi = () => ({
  postMessage(m) { if (m && m.type === 'prompt') window.postMessage({ type: 'start', prompt: m.text, source: 'panel' }, '*'); },
  getState() { return null; }, setState() {}
});
</script>
<script>${js.replace(/<\/script/gi, '<\\/script')}</script>
</body></html>`;

const esc = s => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

const page = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Library Runner Wizard</title>
<style>
:root{--bg:#0c0a14;--ink:#0c0a14;--card:#241f38;--acc:#6d63e0;--text:#e8e2ff;--mut:#9d94c8}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--text);font:13px/1.4 ui-monospace,"Cascadia Mono",Consolas,monospace}
body{min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:14px 16px 24px;gap:12px}
header{width:100%;max-width:1280px;display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}
h1{margin:0;font-size:15px;letter-spacing:.14em;text-transform:uppercase;color:#ffe38a;text-shadow:2px 2px 0 #3a2a10}
header p{margin:0;color:var(--mut);font-size:12px}
#frame{display:block;border:3px solid var(--ink);box-shadow:0 0 0 2px #4d4480,6px 6px 0 rgba(0,0,0,.6);background:#1a1408;max-width:100%}
.ctl{width:100%;max-width:1280px;display:flex;flex-wrap:wrap;gap:8px}
.ctl b{flex-basis:100%;font-weight:400;color:var(--mut);font-size:11px;letter-spacing:.1em;text-transform:uppercase}
.vb{font:11px/1 ui-monospace,Consolas,monospace;letter-spacing:.04em;padding:7px 11px 8px;border:0;border-radius:0;cursor:pointer;background:var(--acc);color:#fff;box-shadow:inset -2px -3px 0 #4a41b8,inset 2px 2px 0 #968ef5,0 0 0 2px var(--ink);white-space:nowrap;margin:2px}
.vb:hover{background:#7c73ea}.vb:active{transform:translate(1px,1px)}
.vb.sec{background:#3a3550;box-shadow:inset -2px -3px 0 #28243a,inset 2px 2px 0 #55507a,0 0 0 2px var(--ink)}
.vb.gold{background:#b8892b;box-shadow:inset -2px -3px 0 #7a5a18,inset 2px 2px 0 #e6c460,0 0 0 2px var(--ink)}
.vb[aria-pressed="true"]{background:#3b7d5a;box-shadow:inset -2px -3px 0 #245a3e,inset 2px 2px 0 #6fb58e,0 0 0 2px var(--ink)}
.vb:focus-visible{outline:2px dashed #ffe38a;outline-offset:3px}
</style>
</head><body>
<header><h1>Library Runner · Wizard v2</h1><p>A scripted replay of a Claude Code turn, on loop. The buttons send the same messages the extension sends.</p></header>
<iframe id="frame" title="Library Runner panel" srcdoc="${esc(panel)}"></iframe>
<div class="ctl" role="group" aria-label="Replay">
  <b>Replay</b>
  <button class="vb gold" id="loop" aria-pressed="true">Loop demo</button>
  <button class="vb sec" id="calm" aria-pressed="false">Reduce motion</button>
</div>
<div class="ctl" role="group" aria-label="Trigger a state">
  <b>Trigger a state (stops the loop)</b>
  <button class="vb" data-m='{"type":"start","prompt":"Rebuild the three restaurant sites","source":"claude"}'>Hears the prompt</button>
  <button class="vb" data-m='{"type":"research","text":"reading BRIEF.md","depth":1}'>Fetches books</button>
  <button class="vb" data-m='{"type":"think"}'>Reads &amp; ponders</button>
  <button class="vb" data-m='{"type":"write","text":"editing index.html"}'>Writes</button>
  <button class="vb" id="summon">Summons 3 familiars</button>
  <button class="vb" id="work">Familiars work</button>
  <button class="vb" id="helpers">Familiar summons helpers</button>
  <button class="vb" data-m='{"type":"famReturn","id":"*"}'>One returns</button>
  <button class="vb" data-m='{"type":"waiting","n":1}'>Waits for them</button>
  <button class="vb" id="answer">Presents answer</button>
  <button class="vb sec" data-m='{"type":"wave","text":"your turn!"}'>Waves</button>
  <button class="vb sec" data-m='{"type":"error","text":"oof! Bash failed"}'>Trips</button>
  <button class="vb sec" data-m='{"type":"doze"}'>Dozes</button>
  <button class="vb sec" data-m='{"type":"home"}'>Reset</button>
</div>
<script>
(function () {
  const fr = document.getElementById('frame');
  const send = m => fr.contentWindow && fr.contentWindow.postMessage(m, '*');
  const loopB = document.getElementById('loop'), calmB = document.getElementById('calm');
  let looping = true, calm = false, n = 0;
  const stopLoop = () => { if (looping) { looping = false; loopB.setAttribute('aria-pressed', 'false'); send({ type: 'demoStop' }); } };
  loopB.onclick = () => { looping = !looping; loopB.setAttribute('aria-pressed', String(looping)); send({ type: 'demoStop' }); if (looping) { send({ type: 'home' }); send({ type: 'demo', loop: true }); } };
  calmB.onclick = () => { calm = !calm; calmB.setAttribute('aria-pressed', String(calm)); send({ type: 'config', skin: 'wiz', calm }); };
  document.querySelectorAll('[data-m]').forEach(b => b.onclick = () => { stopLoop(); send(JSON.parse(b.dataset.m)); });
  const names = ['Rebuild Cafe site', 'Rebuild Bakery site', 'Redo Bookshop site'];
  document.getElementById('summon').onclick = () => { stopLoop(); names.forEach((l, i) => setTimeout(() => send({ type: 'summon', id: 'b' + (++n), label: l }), i * 600)); };
  document.getElementById('work').onclick = () => { stopLoop(); for (let i = 0; i <= n; i++) send({ type: 'famWork', id: 'b' + i }); };
  // a familiar summons two wisps; one of them calls up a mote; they work, then come home smallest first
  document.getElementById('helpers').onclick = () => {
    stopLoop(); const k = ++n, at = (ms, m) => setTimeout(() => send(m), ms);
    at(0, { type: 'summon', id: 'h' + k + 'a', label: 'Menu page', parent: '*' });
    at(700, { type: 'summon', id: 'h' + k + 'b', label: 'Booking form', parent: '*' });
    at(3200, { type: 'summon', id: 'h' + k + 'c', label: 'check prices', parent: 'h' + k + 'a' });
    [3800, 4700, 5600, 6500].forEach((ms, i) => at(ms, { type: 'famWork', id: 'h' + k + (i % 2 ? 'b' : 'a') }));
    at(8200, { type: 'famReturn', id: 'h' + k + 'c' }); at(9200, { type: 'famReturn', id: 'h' + k + 'a' }); at(10400, { type: 'famReturn', id: 'h' + k + 'b' });
  };
  document.getElementById('answer').onclick = () => { stopLoop(); send({ type: 'answer', title: 'CLAUDE CODE IS DONE', text: '**All three sites are rebuilt.** Previews are in \`sites/\`.', actions: [{ label: 'Copy', cmd: 'copy' }] }); };

  // integer pixel scale where the screen allows it; on a phone the panel keeps its own 2x-with-camera mode
  function size() {
    const doc = fr.contentDocument, bar = doc && doc.querySelector('.bar');
    const barH = bar ? bar.offsetHeight : 64;
    const avail = Math.min(1280, document.documentElement.clientWidth - 32 - 6);
    let k = Math.floor(avail / 320);
    k = Math.max(1, Math.min(k, Math.floor((window.innerHeight - 180) / 164) || 1));
    if (avail >= 640 && k >= 2) { fr.style.width = (320 * k + 6) + 'px'; fr.style.height = (164 * k + barH + 6) + 'px'; }
    else { fr.style.width = (avail + 6) + 'px'; fr.style.height = (328 + barH + 6) + 'px'; }
  }
  fr.addEventListener('load', () => {
    size(); setTimeout(size, 60);
    send({ type: 'config', skin: 'wiz', calm: false });
    send({ type: 'demo', loop: true });
  });
  addEventListener('resize', size);
})();
</script>
</body></html>`;

fs.writeFileSync(path.join(dir, '..', 'docs', 'demo.html'), page);
console.log('wrote', path.join(dir, '..', 'docs', 'demo.html'), (page.length / 1024).toFixed(1) + ' KB');
