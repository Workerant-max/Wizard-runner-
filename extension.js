// Library Runner: a pixel-art wizard that runs to the library for every AI prompt.
// Plain CommonJS, no build step.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');

const SYSTEM = 'You are a helpful, concise coding assistant inside VS Code. Answer clearly. Use fenced code blocks for code.';
const HOME_DIR = path.join(os.homedir(), '.library-runner');
const EVENTS_FILE = path.join(HOME_DIR, 'events.jsonl');

let panel;          // RunnerView
let statusItem;
let busy = false;
let currentCts = null;
let lastEditor = null;
let last = { text: '', code: '', uri: null, range: null };
let statusTimer = null;

/* ------------------------------------------------------------------ */
/* Webview view                                                        */
/* ------------------------------------------------------------------ */
class RunnerView {
  constructor(ctx) {
    this.ctx = ctx;
    this.view = null;
    this.ready = false;
    this.pending = [];
    this.waiters = new Map();
  }

  resolveWebviewView(view) {
    this.view = view;
    this.ready = false;
    const media = vscode.Uri.joinPath(this.ctx.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = this.html(view.webview, media);
    view.webview.onDidReceiveMessage(m => this.receive(m));
    view.onDidDispose(() => { this.view = null; this.ready = false; });
  }

  post(msg) {
    if (!this.view) return;
    if (this.ready) this.view.webview.postMessage(msg);
    else this.pending.push(msg);
  }

  sendConfig() {
    const c = vscode.workspace.getConfiguration('libraryRunner');
    this.post({ type: 'config', skin: c.get('skin'), calm: c.get('reduceMotion') });
  }

  ask(text) {
    const id = Math.random().toString(36).slice(2);
    setStatus('ask');
    this.post({ type: 'ask', text, id });
    return new Promise(res => this.waiters.set(id, res));
  }

  receive(m) {
    switch (m.type) {
      case 'ready':
        this.ready = true;
        this.sendConfig();
        this.pending.splice(0).forEach(x => this.view.webview.postMessage(x));
        break;
      case 'prompt':
        runPanelPrompt(String(m.text || ''));
        break;
      case 'askResult': {
        const w = this.waiters.get(m.id);
        if (w) { this.waiters.delete(m.id); setStatus('working'); w(!!m.ok); }
        break;
      }
      case 'action':
        handleAction(m.cmd);
        break;
    }
  }

  html(webview, media) {
    const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'main.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(media, 'main.js'));
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline' https://fonts.googleapis.com`,
      'font-src https://fonts.gstatic.com',
      `script-src 'nonce-${nonce}'`
    ].join('; ');
    return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Pixelify+Sans:wght@400;600&family=Silkscreen&display=swap">
<link rel="stylesheet" href="${css}">
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
    <input id="q" type="text" placeholder="Ask the wizard… (uses your selection as context)" aria-label="Prompt" autocomplete="off">
    <button class="vb" id="go" type="submit">Send him ↗</button>
  </form>
</div>
<script nonce="${nonce}" src="${js}"></script>
</body></html>`;
  }
}

/* ------------------------------------------------------------------ */
/* Director: what the wizard does                                      */
/* ------------------------------------------------------------------ */
const D = {
  start(prompt, source) { setStatus('working'); reveal(); panel.post({ type: 'start', prompt, source }); },
  step(text, depth) { panel.post({ type: 'step', text, depth }); },
  error(text) { panel.post({ type: 'error', text }); },
  deliver() { panel.post({ type: 'deliver' }); },
  answer(text, actions, title) { setStatus('done'); panel.post({ type: 'answer', text, actions: actions || [], title }); },
  home() { setStatus('idle'); panel.post({ type: 'home' }); }
};

function reveal() {
  if (!vscode.workspace.getConfiguration('libraryRunner').get('revealOnPrompt')) return;
  if (panel.view && !panel.view.visible) panel.view.show(true);
}

function setStatus(s) {
  if (!statusItem) return;
  clearTimeout(statusTimer);
  const map = {
    idle: '$(book) Wizard: idle',
    working: '$(sync~spin) Wizard: in the library',
    ask: '$(bell) Wizard: needs you',
    done: '$(check) Wizard: back with an answer'
  };
  statusItem.text = map[s] || map.idle;
  statusItem.backgroundColor = s === 'ask' ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
  if (s === 'done') statusTimer = setTimeout(() => setStatus('idle'), 10000);
}

/* ------------------------------------------------------------------ */
/* Language model streaming with narration                             */
/* ------------------------------------------------------------------ */
async function pickModel(preferred) {
  if (preferred) return preferred;
  if (!vscode.lm || !vscode.lm.selectChatModels) return null;
  const fam = vscode.workspace.getConfiguration('libraryRunner').get('modelFamily');
  let models = await vscode.lm.selectChatModels(fam ? { family: fam } : { vendor: 'copilot' });
  if (!models.length) models = await vscode.lm.selectChatModels();
  return models[0] || null;
}

async function streamLM(messages, token, { model, file, onText } = {}) {
  const m = await pickModel(model);
  if (!m) throw new Error('No language model is available. Install GitHub Copilot Chat (or another extension that provides models) and sign in.');
  const captions = [
    file ? `reading ${file}…` : 'reading your question…',
    'checking the card index…', 'pulling old volumes…', 'cross-referencing…',
    'tinkering…', 'consulting the archive…', 'polishing the wording…'
  ];
  const t0 = Date.now();
  let i = 0, got = false;
  const narrate = () => {
    const s = (Date.now() - t0) / 1000;
    D.step(captions[i++ % captions.length], s < 5 ? 0 : s < 11 ? 1 : 2);
  };
  narrate();
  const timer = setInterval(narrate, 1400);
  let out = '';
  try {
    const res = await m.sendRequest(messages, {}, token);
    for await (const chunk of res.text) {
      if (!got) { got = true; D.step('found it! writing…'); }
      out += chunk;
      if (onText) onText(chunk);
    }
  } finally {
    clearInterval(timer);
  }
  return out;
}

function firstCode(s) {
  const m = /```[^\n`]*\n([\s\S]*?)```/.exec(s);
  return m ? m[1].replace(/\n$/, '') : '';
}

function errMsg(e) {
  if (e instanceof vscode.CancellationError) return 'Called back before finishing.';
  if (vscode.LanguageModelError && e instanceof vscode.LanguageModelError) {
    if (e.code === 'NoPermissions') return 'VS Code needs your permission for this extension to use the language model. Try again and allow it.';
    if (e.code === 'Blocked') return 'The language model request was blocked (rate limit or quota). Try again in a moment.';
  }
  return (e && e.message) || String(e);
}

/* ------------------------------------------------------------------ */
/* Panel prompt box                                                    */
/* ------------------------------------------------------------------ */
async function runPanelPrompt(text) {
  text = text.trim();
  if (!text) return;
  if (busy) { vscode.window.showInformationMessage('The wizard is already out. Wait for him, or use "Call the Wizard Back".'); return; }
  busy = true;
  const ed = lastEditor;
  const doc = ed && ed.document;
  const sel = ed && !ed.selection.isEmpty ? doc.getText(ed.selection) : '';
  const file = doc ? path.basename(doc.fileName) : null;
  const lang = doc ? doc.languageId : '';
  const editIntent = !!sel && /^(fix|refactor|rewrite|edit|change|update|improve|clean|rename|simplify)/i.test(text);

  let prompt = SYSTEM;
  if (sel) prompt += `\n\nThe user selected this ${lang} code from ${file}:\n\`\`\`${lang}\n${sel}\n\`\`\``;
  else if (file) prompt += `\n\nThe user has ${file} open.`;
  if (editIntent) prompt += '\n\nReply with a one-line explanation, then ONE code block containing the complete replacement for the selected code.';
  prompt += `\n\nQuestion: ${text}`;

  D.start(text, 'panel');
  currentCts = new vscode.CancellationTokenSource();
  try {
    const out = await streamLM([vscode.LanguageModelChatMessage.User(prompt)], currentCts.token, { file });
    const code = firstCode(out);
    last = { text: out, code, uri: doc ? doc.uri : null, range: sel ? ed.selection : null };
    if (editIntent && code) {
      const ok = await panel.ask(`Replace your selection in ${file}?`);
      if (ok) {
        await applyReplace();
        D.answer(out, [{ label: 'Copy answer', cmd: 'copy' }], 'EDIT APPLIED');
        return;
      }
    }
    const actions = [];
    if (code && last.range) actions.push({ label: 'Replace selection', cmd: 'replace' });
    if (code) actions.push({ label: 'Insert at cursor', cmd: 'insert' });
    actions.push({ label: 'Copy', cmd: 'copy' });
    D.answer(out, actions, 'BACK FROM THE READING ROOM');
  } catch (e) {
    D.error('oof! ' + (e instanceof vscode.CancellationError ? 'called back' : 'the shelf gave way'));
    D.answer(errMsg(e), [], 'THE WIZARD CAME BACK EMPTY-HANDED');
  } finally {
    busy = false;
    currentCts = null;
  }
}

async function applyReplace() {
  if (!last.uri || !last.range || !last.code) return;
  const we = new vscode.WorkspaceEdit();
  we.replace(last.uri, last.range, last.code);
  await vscode.workspace.applyEdit(we);
}

async function handleAction(cmd) {
  if (cmd === 'copy') {
    await vscode.env.clipboard.writeText(last.text);
    vscode.window.setStatusBarMessage('Library Runner: answer copied', 2500);
  } else if (cmd === 'insert') {
    const ed = lastEditor;
    if (!ed) { vscode.window.showWarningMessage('Open a file to insert the code into.'); return; }
    await ed.edit(b => b.insert(ed.selection.active, last.code));
  } else if (cmd === 'replace') {
    await applyReplace();
  } else if (cmd === 'openChat') {
    vscode.commands.executeCommand('workbench.action.chat.open');
  }
}

/* ------------------------------------------------------------------ */
/* @wizard chat participant                                            */
/* ------------------------------------------------------------------ */
function registerParticipant(ctx) {
  if (!vscode.chat || !vscode.chat.createChatParticipant) return;
  const p = vscode.chat.createChatParticipant('library-runner.wizard', async (request, chatCtx, stream, token) => {
    const msgs = [vscode.LanguageModelChatMessage.User(SYSTEM)];
    for (const turn of chatCtx.history.slice(-6)) {
      if (turn instanceof vscode.ChatRequestTurn) msgs.push(vscode.LanguageModelChatMessage.User(turn.prompt));
      else if (turn instanceof vscode.ChatResponseTurn) {
        const txt = turn.response.map(r => (r.value && r.value.value) || '').join('');
        if (txt) msgs.push(vscode.LanguageModelChatMessage.Assistant(txt));
      }
    }
    msgs.push(vscode.LanguageModelChatMessage.User(request.prompt));
    D.start(request.prompt, 'chat');
    try {
      const out = await streamLM(msgs, token, { model: request.model, onText: t => stream.markdown(t) });
      last = { text: out, code: firstCode(out), uri: null, range: null };
      D.answer(out, [{ label: 'Open chat', cmd: 'openChat' }, { label: 'Copy', cmd: 'copy' }], 'ANSWER DELIVERED IN CHAT');
    } catch (e) {
      D.error('oof! the shelf gave way');
      D.answer(errMsg(e), [], 'THE WIZARD CAME BACK EMPTY-HANDED');
      stream.markdown('**The wizard came back empty-handed:** ' + errMsg(e));
    }
    return {};
  });
  p.iconPath = vscode.Uri.joinPath(ctx.extensionUri, 'media', 'icon.png');
  ctx.subscriptions.push(p);
}

/* ------------------------------------------------------------------ */
/* Claude Code bridge (hooks append JSON lines to ~/.library-runner)   */
/* ------------------------------------------------------------------ */
// One entry per Claude Code session, so two sessions never share familiars or finish each other's turns.
// fam: tool_use_id -> { id, label, type, agentId, t, parent, depth }. byAgent: agent_id -> tool_use_id.
// parent is the tool_use_id of the familiar whose own Agent call summoned this one (null for the wizard's own).
const sessions = new Map();
function sess(id) {
  let s = sessions.get(id);
  if (!s) { s = { tools: 0, started: false, fam: new Map(), byAgent: new Map(), stop: null, seen: 0 }; sessions.set(id, s); }
  s.seen = Date.now();
  return s;
}

function short(s, n = 22) { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; }
function base(p) { return p ? path.basename(String(p)) : 'a file'; }

function caption(tool, inp) {
  inp = inp || {};
  switch (tool) {
    case 'Read': return `reading ${base(inp.file_path)}`;
    case 'Grep': return `searching "${short(inp.pattern, 18)}"`;
    case 'Glob': return `finding ${short(inp.pattern, 18)}`;
    case 'Edit': case 'MultiEdit': return `editing ${base(inp.file_path)}`;
    case 'Write': return `writing ${base(inp.file_path)}`;
    case 'NotebookEdit': return 'scribbling in a notebook';
    case 'Bash': case 'PowerShell': return `running ${short(inp.command, 20)}`;
    case 'WebFetch': case 'WebSearch': return 'sending a raven…';
    case 'Task': case 'Agent': return 'summoning a helper…';
    case 'TodoWrite': return 'updating the to-do scroll';
    default: return /^mcp__/.test(tool) ? `consulting ${short(String(tool).split('__')[1], 16)}` : `using ${short(tool, 20)}`;
  }
}
// what the wizard acts out for each tool: fetching books, writing with the quill, or a summoning
function kindOf(tool) {
  if (tool === 'Agent' || tool === 'Task') return 'summon';
  if (/^(Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell|TodoWrite)$/.test(tool)) return 'write';
  return 'research'; // Read, Grep, Glob, WebFetch, WebSearch, mcp__*, and anything unknown
}

function isErr(r) {
  if (!r || typeof r !== 'object') return false;
  return r.is_error === true || r.isError === true || r.interrupted === true || (typeof r.error === 'string' && r.error.length > 0);
}

function lastAssistant(tp) {
  try {
    if (!tp || !fs.existsSync(tp)) return '';
    const st = fs.statSync(tp);
    const len = Math.min(st.size, 400000);
    const fd = fs.openSync(tp, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n').reverse();
    for (const l of lines) {
      try {
        const o = JSON.parse(l);
        if (o.type === 'assistant' && o.message && Array.isArray(o.message.content)) {
          const t = o.message.content.filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
          if (t) return t.length > 3000 ? t.slice(0, 3000) + '…' : t;
        }
      } catch { /* partial line */ }
    }
  } catch { /* ignore */ }
  return '';
}

// Events from inside a subagent carry agent_id. A background agent's id arrives in the launching
// PostToolUse (tool_response.agentId); a foreground one's arrives only when it finishes, so until then
// the newest unlinked summon of the same subagent_type claims it. Newest, because a nested helper's first
// tool call comes straight after its parent's Agent call. The hook data has no parent field on a nested
// agent's own events (checked against real events on 30 Sep 2026), so this guess is the only link until
// its PostToolUse or SubagentStop names it.
function famFor(s, agentId, agentType) {
  if (!agentId) return null;
  const known = s.byAgent.get(agentId);
  if (known && s.fam.has(known)) return s.fam.get(known);
  const free = [...s.fam.values()].filter(f => !f.agentId).reverse();
  const f = free.find(x => x.type && x.type === agentType) || free[0];
  if (!f) return null;
  f.agentId = agentId; s.byAgent.set(agentId, f.id);
  return f;
}
function famDone(s, f) {
  if (!f || !s.fam.has(f.id)) return;
  s.fam.delete(f.id); if (f.agentId) s.byAgent.delete(f.agentId);
  panel.post({ type: 'famReturn', id: f.id });
  // the turn ended while familiars were still out: present the answer once the last one is home
  if (!s.fam.size && s.stop) { const t = s.stop; s.stop = null; claudeAnswer(t); }
}
function claudeAnswer(text) {
  last = { text, code: firstCode(text), uri: null, range: null };
  D.answer(text, [{ label: 'Copy', cmd: 'copy' }], 'CLAUDE CODE IS DONE');
}

function onClaude(e) {
  if (!vscode.workspace.getConfiguration('libraryRunner').get('claudeCode.enabled')) return;
  const ev = e.hook_event_name, sid = e.session_id || 'default', s = sess(sid);
  if (ev === 'SubagentStop') { famDone(s, famFor(s, e.agent_id, e.agent_type)); return; }
  if (e.agent_id) { // a familiar at work: it never moves the wizard
    const f = famFor(s, e.agent_id, e.agent_type);
    if (f) f.t = Date.now();
    if (kindOf(e.tool_name) === 'summon') { // the familiar summoning a helper of its own
      const r = e.tool_response || {};
      if (ev === 'PreToolUse') {
        const inp = e.tool_input || {}, id = e.tool_use_id || Math.random().toString(36).slice(2);
        const label = inp.description || inp.subagent_type || 'a helper', depth = f ? f.depth + 1 : 1;
        s.fam.set(id, { id, label, type: inp.subagent_type || '', agentId: null, t: Date.now(), parent: f ? f.id : null, depth });
        panel.post({ type: 'summon', id, label, kind: inp.subagent_type || '', parent: f ? f.id : undefined, depth, sid });
      } else if (ev === 'PostToolUse') {
        const h = s.fam.get(e.tool_use_id);
        if (h && r.agentId) { if (h.agentId) s.byAgent.delete(h.agentId); h.agentId = r.agentId; s.byAgent.set(r.agentId, h.id); }
        if (h && !r.isAsync && r.status !== 'async_launched') famDone(s, h);
      } else if (ev === 'PostToolUseFailure') famDone(s, s.fam.get(e.tool_use_id));
      return;
    }
    if (f && ev === 'PreToolUse') panel.post({ type: 'famWork', id: f.id, tool: e.tool_name });
    return;
  }
  if (ev === 'UserPromptSubmit') {
    s.tools = 0; s.stop = null; s.started = true;
    D.start(e.prompt || 'a Claude Code task', 'claude');
  } else if (ev === 'PreToolUse') {
    if (!s.started) D.start('a Claude Code task', 'claude');
    s.started = true; s.tools++; s.stop = null; setStatus('working');
    const inp = e.tool_input || {}, k = kindOf(e.tool_name);
    if (k === 'summon') {
      const id = e.tool_use_id || Math.random().toString(36).slice(2);
      const label = inp.description || inp.subagent_type || 'a helper';
      s.fam.set(id, { id, label, type: inp.subagent_type || '', agentId: null, t: Date.now(), parent: null, depth: 1 });
      panel.post({ type: 'summon', id, label, kind: inp.subagent_type || '', sid });
    } else if (k === 'write') panel.post({ type: 'write', text: caption(e.tool_name, inp), sid });
    else panel.post({ type: 'research', text: caption(e.tool_name, inp), depth: s.tools >= 10 ? 2 : s.tools >= 4 ? 1 : 0, sid });
  } else if (ev === 'PostToolUse') {
    if (kindOf(e.tool_name) === 'summon') {
      const f = s.fam.get(e.tool_use_id), r = e.tool_response || {};
      if (f && r.agentId) { if (f.agentId) s.byAgent.delete(f.agentId); f.agentId = r.agentId; s.byAgent.set(r.agentId, f.id); }
      // a foreground agent's PostToolUse means it has finished; a background one's only that it launched
      if (f && !r.isAsync && r.status !== 'async_launched') famDone(s, f);
    } else if (isErr(e.tool_response)) D.error(`oof! ${short(e.tool_name, 14)} failed`);
    else panel.post({ type: 'post', sid });
  } else if (ev === 'PostToolUseFailure') {
    if (kindOf(e.tool_name) === 'summon') famDone(s, s.fam.get(e.tool_use_id));
    else D.error(`oof! ${short(e.tool_name, 14)} failed`);
  } else if (ev === 'Notification') {
    const perm = /permission|approve|allow/i.test(e.message || '');
    panel.post({ type: 'wave', text: perm ? 'needs your OK!' : 'your turn!' });
    if (perm) {
      setStatus('ask');
      panel.post({ type: 'ask', text: 'Claude Code needs your OK. Answer it in the Claude Code window.', id: null });
    }
  } else if (ev === 'Stop') {
    const text = e.last_assistant_message || lastAssistant(e.transcript_path) || 'Claude Code finished. The full reply is in the Claude Code window.';
    s.tools = 0; s.started = false;
    if (s.fam.size) { s.stop = text; panel.post({ type: 'waiting', n: [...s.fam.values()].filter(f => !f.parent).length || s.fam.size, sid }); }
    else claudeAnswer(text);
  }
}

// A familiar whose SubagentStop never came (hook not installed, session killed) is sent home after
// 30 quiet minutes, so the gallery does not fill up with ghosts.
function sweepFamiliars() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    for (const f of [...s.fam.values()]) if (now - f.t > 30 * 60 * 1000) famDone(s, f);
    if (!s.fam.size && now - s.seen > 6 * 3600 * 1000) sessions.delete(id);
  }
}

function startBridge(ctx) {
  try {
    fs.mkdirSync(HOME_DIR, { recursive: true });
    for (const f of ['lr-hook.ps1', 'lr-hook.sh', 'lr-hook.js']) {
      fs.copyFileSync(path.join(ctx.extensionPath, 'hooks', f), path.join(HOME_DIR, f));
    }
    if (!fs.existsSync(EVENTS_FILE)) fs.writeFileSync(EVENTS_FILE, '');
    if (fs.statSync(EVENTS_FILE).size > 5 * 1024 * 1024) fs.writeFileSync(EVENTS_FILE, '');
  } catch (e) {
    console.error('Library Runner: bridge setup failed', e);
    return;
  }
  let offset = fs.statSync(EVENTS_FILE).size; // only react to new events
  const read = () => {
    let st;
    try { st = fs.statSync(EVENTS_FILE); } catch { return; }
    if (st.size < offset) offset = 0;
    if (st.size === offset) return;
    const fd = fs.openSync(EVENTS_FILE, 'r');
    const buf = Buffer.alloc(st.size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    fs.closeSync(fd);
    const text = buf.toString('utf8');
    const cut = text.lastIndexOf('\n');
    if (cut < 0) return; // wait for a full line
    offset += Buffer.byteLength(text.slice(0, cut + 1), 'utf8');
    for (let l of text.slice(0, cut).split('\n')) {
      l = l.replace(/^﻿/, '').trim();
      if (!l) continue;
      try { onClaude(JSON.parse(l)); } catch { /* not JSON */ }
    }
  };
  let watcher;
  try { watcher = fs.watch(HOME_DIR, () => read()); } catch { /* polling covers it */ }
  const poll = setInterval(read, 1500);
  const sweep = setInterval(sweepFamiliars, 60 * 1000);
  ctx.subscriptions.push({ dispose() { clearInterval(poll); clearInterval(sweep); if (watcher) watcher.close(); } });
}

function hookCommand() {
  // Node, not PowerShell, on Windows: ~120 ms per event against ~550 ms (measured 30 Sep 2026). The hook runs
  // twice per tool call, so PowerShell added about a second to every action Claude takes.
  return process.platform === 'win32'
    ? `node "${path.join(HOME_DIR, 'lr-hook.js')}"`
    : `sh "${path.join(HOME_DIR, 'lr-hook.sh')}"`;
}
// SubagentStop is what sends a background familiar home; without it they wait for the 30-minute sweep.
const HOOK_EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SubagentStop'];

async function connectClaudeCode() {
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  const pick = await vscode.window.showQuickPick([
    { label: 'Add the hooks for me', description: settingsPath, id: 'auto' },
    { label: 'Show me the snippet', description: 'Paste it into your Claude Code settings yourself', id: 'show' }
  ], { title: 'Connect Claude Code to Library Runner' });
  if (!pick) return;
  const cmd = hookCommand();
  const entry = { hooks: [{ type: 'command', command: cmd }] };
  if (pick.id === 'show') {
    const hooks = {};
    for (const ev of HOOK_EVENTS) hooks[ev] = [ev.includes('ToolUse') ? { matcher: '*', ...entry } : entry];
    const doc = await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify({ hooks }, null, 2) });
    vscode.window.showTextDocument(doc);
    return;
  }
  const ok = await vscode.window.showWarningMessage(
    `Add Library Runner hooks to ${settingsPath}? A backup is saved next to it first.`, { modal: true }, 'Add hooks');
  if (ok !== 'Add hooks') return;
  let settings = {};
  try {
    if (fs.existsSync(settingsPath)) {
      const raw = fs.readFileSync(settingsPath, 'utf8');
      fs.writeFileSync(settingsPath + '.library-runner.bak', raw);
      settings = raw.trim() ? JSON.parse(raw) : {};
    } else fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  } catch (e) {
    vscode.window.showErrorMessage('Could not read your Claude Code settings.json (is it valid JSON?): ' + e.message);
    return;
  }
  settings.hooks = settings.hooks || {};
  for (const ev of HOOK_EVENTS) {
    const list = settings.hooks[ev] = settings.hooks[ev] || [];
    const has = list.some(g => (g.hooks || []).some(h => String(h.command || '').includes('lr-hook')));
    if (!has) list.push(ev.includes('ToolUse') ? { matcher: '*', ...entry } : entry);
  }
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  vscode.window.showInformationMessage('Claude Code is connected. Start a new Claude Code session and the wizard will follow along.');
}

async function disconnectClaudeCode() {
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    if (!settings.hooks) return;
    for (const ev of Object.keys(settings.hooks)) {
      settings.hooks[ev] = settings.hooks[ev]
        .map(g => ({ ...g, hooks: (g.hooks || []).filter(h => !String(h.command || '').includes('lr-hook')) }))
        .filter(g => g.hooks.length);
      if (!settings.hooks[ev].length) delete settings.hooks[ev];
    }
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    vscode.window.showInformationMessage('Library Runner hooks removed from Claude Code.');
  } catch (e) {
    vscode.window.showErrorMessage('Could not update ' + settingsPath + ': ' + e.message);
  }
}

/* ------------------------------------------------------------------ */
/* Demo (works without any AI connected)                               */
/* ------------------------------------------------------------------ */
async function demo() {
  if (busy) return;
  // the scripted replay lives in the webview (media/main.js, DEMO), so this command and demo.html play the same thing
  if (panel.view) panel.view.show(true);
  else await vscode.commands.executeCommand('libraryRunner.view.focus');
  setTimeout(() => panel.post({ type: 'demo', loop: false }), 400);
}

/* ------------------------------------------------------------------ */
function activate(ctx) {
  panel = new RunnerView(ctx);
  ctx.subscriptions.push(vscode.window.registerWebviewViewProvider('libraryRunner.view', panel, {
    webviewOptions: { retainContextWhenHidden: true }
  }));

  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.command = 'libraryRunner.view.focus';
  statusItem.tooltip = 'Library Runner: show the wizard';
  setStatus('idle');
  statusItem.show();
  ctx.subscriptions.push(statusItem);

  lastEditor = vscode.window.activeTextEditor || null;
  ctx.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(e => { if (e) lastEditor = e; }));
  ctx.subscriptions.push(vscode.window.onDidChangeTextEditorSelection(e => { lastEditor = e.textEditor; }));

  ctx.subscriptions.push(
    vscode.commands.registerCommand('libraryRunner.ask', async () => {
      const q = await vscode.window.showInputBox({ prompt: 'What should the wizard look up?', placeHolder: 'e.g. explain this function' });
      if (q) runPanelPrompt(q);
    }),
    vscode.commands.registerCommand('libraryRunner.demo', demo),
    vscode.commands.registerCommand('libraryRunner.cancel', () => {
      if (currentCts) currentCts.cancel(); else D.home();
    }),
    vscode.commands.registerCommand('libraryRunner.changeSkin', async () => {
      const items = [
        { label: 'Wizard', description: 'Old wizard with a big beard', id: 'wiz' },
        { label: 'Librarian', id: 'lib' }, { label: 'Robot', id: 'bot' }, { label: 'Cat', id: 'cat' }
      ];
      const p = await vscode.window.showQuickPick(items, { title: 'Who runs to the library?' });
      if (p) vscode.workspace.getConfiguration('libraryRunner').update('skin', p.id, vscode.ConfigurationTarget.Global);
    }),
    vscode.commands.registerCommand('libraryRunner.connectClaudeCode', connectClaudeCode),
    vscode.commands.registerCommand('libraryRunner.disconnectClaudeCode', disconnectClaudeCode),
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('libraryRunner')) panel.sendConfig(); })
  );

  registerParticipant(ctx);
  startBridge(ctx);

  // First run: show the panel and play the demo once, as a welcome.
  if (!ctx.globalState.get('libraryRunner.welcomed')) {
    ctx.globalState.update('libraryRunner.welcomed', true);
    setTimeout(demo, 2500);
  }
}

function deactivate() {}

module.exports = { activate, deactivate };
