#!/usr/bin/env node
'use strict';

const fs   = require('fs');
const path = require('path');
const ROOT = __dirname;

const FILES = [
  { file: 'server.js',                 desc: 'Session hub, WebSocket router, HTTP server' },
  { file: 'src/bot/bot.js',            desc: 'Autonomous farming/support state machine' },
  { file: 'src/proto/gameClient.js',   desc: 'L2 game server protocol, TCP + XOR cipher' },
  { file: 'src/proto/loginClient.js',  desc: 'L2 login server protocol, RSA + Blowfish' },
  { file: 'src/proto/loginCrypt.js',   desc: 'Login packet encrypt/decrypt helpers' },
  { file: 'src/proto/blowfish.js',     desc: 'Blowfish ECB cipher (L2J Mobius port)' },
  { file: 'src/geo/geodata.js',        desc: 'Geodata reader + BFS pathfinder' },
  { file: 'src/data/skillRange.js',    desc: 'Skill cast-range lookup' },
  { file: 'src/data/weaponRange.js',   desc: 'Weapon physical-range lookup' },
  { file: 'build-data.js',             desc: 'Static data builder from server XML' },
  { file: 'start.sh',                  desc: 'Startup script' },
  { file: 'package.json',              desc: 'NPM package manifest' },
];

const SKIP_IDS = new Set([
  'if','for','while','switch','catch','return','throw','new','super',
  'require','module','Object','Array','Buffer','Math','Date','Error',
  'JSON','Promise','console','setTimeout','setInterval',
  'clearTimeout','clearInterval','emit','on','once',
]);

function getFunctions(content) {
  const fns = [];
  content.split('\n').forEach((line, i) => {
    const lnum = i + 1;
    let m = line.match(/^(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/);
    if (m) { fns.push({ name: m[1], line: lnum }); return; }
    m = line.match(/^(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s+)?(?:function|\()/);
    if (m) { fns.push({ name: m[1], line: lnum }); return; }
    m = line.match(/^  (?:async\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/) ||
        line.match(/^    (?:async\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/);
    if (m && !SKIP_IDS.has(m[1]) && !line.trim().startsWith('//') && !line.trim().startsWith('*')) {
      fns.push({ name: m[1], line: lnum });
    }
  });
  return fns;
}

function extractWsCommands(content) {
  const cmds = [];
  const re = /case\s+'([^']+)'\s*:/g;
  let m;
  while ((m = re.exec(content)) !== null) cmds.push(m[1]);
  return cmds;
}

function extractBroadcastTypes(content) {
  const types = new Set();
  const re = /type:\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(content)) !== null) types.add(m[1]);
  return [...types].sort();
}

function extractGcEvents(content) {
  const events = new Set();
  const re = /this\.emit\s*\(\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(content)) !== null) events.add(m[1]);
  return [...events].sort();
}

// Read all files
const fileData = {};
for (const { file, desc } of FILES) {
  let content = '';
  try { content = fs.readFileSync(path.join(ROOT, file), 'utf8'); }
  catch { content = '// File not found: ' + file; }
  fileData[file] = { desc, content, functions: getFunctions(content) };
}

const serverContent  = fileData['server.js'].content;
const gcContent      = fileData['src/proto/gameClient.js'].content;
const wsCommands     = extractWsCommands(serverContent);
const broadcastTypes = extractBroadcastTypes(serverContent);
const gcEvents       = extractGcEvents(gcContent);

const payload = JSON.stringify({ files: fileData, wsCommands, broadcastTypes, gcEvents });
const safeJson = payload.replace(/<\/script>/gi, '<\\/script>');

// ─── Browser JS: extracted via .toString() so no escaping needed ──────────────

/* eslint-disable */
function browserApp() {
  var DATA = JSON.parse(document.getElementById('src-data').textContent);
  var FILES = Object.keys(DATA.files);
  var currentFile = null;
  var currentContent = '';
  var currentFnLine = -1;
  var searchTerm = '';

  var KW1 = new Set(['const','let','var','function','class','extends','return',
    'if','else','for','while','do','switch','case','break','continue','new',
    'this','super','typeof','instanceof','import','export','default','null',
    'undefined','true','false','async','await','try','catch','finally',
    'throw','delete','void','in','of','static','get','set']);
  var KW2 = new Set(['require','module','exports','EventEmitter','Promise',
    'setTimeout','setInterval','clearTimeout','clearInterval','process']);
  var BUILTINS = new Set(['Buffer','Map','Set','Array','Object','JSON','Math',
    'Date','Error','Number','String','Boolean','parseInt','parseFloat',
    'console','Symbol','Uint8Array','Int16Array','Int32Array','Uint32Array']);

  function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function highlight(code) {
    var out = '';
    var i = 0;
    var n = code.length;
    while (i < n) {
      var ch = code[i];
      // Single-line comment
      if (ch === '/' && i + 1 < n && code[i + 1] === '/') {
        var e = code.indexOf('\n', i);
        if (e < 0) e = n;
        out += '<span class="cmt">' + esc(code.slice(i, e)) + '</span>';
        i = e; continue;
      }
      // Block comment
      if (ch === '/' && i + 1 < n && code[i + 1] === '*') {
        var e2 = code.indexOf('*/', i + 2);
        if (e2 < 0) e2 = n - 2; else e2 += 2;
        out += '<span class="cmt">' + esc(code.slice(i, e2)) + '</span>';
        i = e2; continue;
      }
      // String literal
      if (ch === '"' || ch === "'") {
        var q = ch;
        var j = i + 1;
        while (j < n && code[j] !== q) { if (code[j] === '\\') j++; j++; }
        out += '<span class="str">' + esc(code.slice(i, j + 1)) + '</span>';
        i = j + 1; continue;
      }
      // Template literal (backtick = char 96)
      if (ch.charCodeAt(0) === 96) {
        var j2 = i + 1;
        while (j2 < n && code.charCodeAt(j2) !== 96) { if (code[j2] === '\\') j2++; j2++; }
        out += '<span class="str">' + esc(code.slice(i, j2 + 1)) + '</span>';
        i = j2 + 1; continue;
      }
      // Number
      if (/[0-9]/.test(ch) && (i === 0 || /\W/.test(code[i - 1]))) {
        var j3 = i;
        while (j3 < n && /[0-9a-fA-FxXbB._]/.test(code[j3])) j3++;
        out += '<span class="num">' + esc(code.slice(i, j3)) + '</span>';
        i = j3; continue;
      }
      // Identifier / keyword
      if (/[a-zA-Z_$]/.test(ch)) {
        var j4 = i;
        while (j4 < n && /[a-zA-Z0-9_$]/.test(code[j4])) j4++;
        var word = code.slice(i, j4);
        var after = code[j4];
        if (KW1.has(word)) out += '<span class="kw">' + esc(word) + '</span>';
        else if (KW2.has(word)) out += '<span class="kw2">' + esc(word) + '</span>';
        else if (BUILTINS.has(word)) out += '<span class="bi">' + esc(word) + '</span>';
        else if (after === '(') out += '<span class="fn">' + esc(word) + '</span>';
        else out += esc(word);
        i = j4; continue;
      }
      out += esc(ch);
      i++;
    }
    return out;
  }

  function applySearch(hlLines) {
    if (!searchTerm) return hlLines;
    var pat = new RegExp('(' + escapeRegex(searchTerm) + ')', 'gi');
    return hlLines.map(function(l) {
      return l.replace(pat, '<span class="search-match">$1</span>');
    });
  }

  function renderCode(file) {
    currentFile = file;
    currentContent = DATA.files[file].content;
    currentFnLine = -1;

    document.querySelectorAll('.file-header').forEach(function(el) {
      el.classList.toggle('active', el.dataset.file === file);
    });
    document.querySelectorAll('.fn-item').forEach(function(el) { el.classList.remove('active'); });

    document.getElementById('code-filename').textContent =
      file + '  (' + DATA.files[file].desc + ')';

    openFolder(file);
    renderCodeView();
  }

  function renderCodeView() {
    if (!currentFile) return;
    var lines = currentContent.split('\n');
    var hlLines = applySearch(highlight(currentContent).split('\n'));

    var fnLineSet = new Set();
    (DATA.files[currentFile].functions || []).forEach(function(f) { fnLineSet.add(f.line); });

    var numHtml = '', codeHtml = '';
    for (var i = 0; i < hlLines.length; i++) {
      var ln = i + 1;
      var isCur = (ln === currentFnLine);
      var isFn  = fnLineSet.has(ln);
      var cls = isCur ? ' class="hl-fn"' : (isFn ? ' class="hl-line"' : '');
      numHtml  += '<span' + cls + '>' + ln + '</span>\n';
      codeHtml += '<span' + cls + '>' + (hlLines[i] || ' ') + '</span>\n';
    }
    document.getElementById('line-nums').innerHTML  = numHtml;
    document.getElementById('code-view').innerHTML  = codeHtml;
  }

  function scrollToLine(line) {
    var spans = document.getElementById('code-view').querySelectorAll('span');
    if (spans[line - 1]) spans[line - 1].scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  function openFolder(file) {
    document.querySelectorAll('.fn-list').forEach(function(el) {
      el.classList.toggle('open', el.dataset.file === file);
    });
  }

  function buildSidebar() {
    var html = '';
    FILES.forEach(function(file) {
      var info = DATA.files[file];
      var fns  = info.functions;
      var ext  = file.split('.').pop();
      var icon = ext === 'json' ? '{}' : (ext === 'sh' ? '$>' : 'JS');
      var fnItems = '';
      fns.forEach(function(fn) {
        fnItems += '<div class="fn-item" data-file="' + esc(file) + '" data-line="' + fn.line + '">' +
          '<span class="fn-name">' + esc(fn.name) + '</span>' +
          '<span class="fn-line">:' + fn.line + '</span></div>';
      });
      html += '<div class="file-entry">' +
        '<div class="file-header" data-file="' + esc(file) + '">' +
          '<span class="file-icon">[' + icon + ']</span>' +
          '<span class="file-name">' + esc(file) + '</span></div>' +
        '<div class="file-desc">' + esc(info.desc) + '</div>' +
        (fnItems ? '<div class="fn-list" data-file="' + esc(file) + '">' + fnItems + '</div>' : '') +
        '</div>';
    });
    document.getElementById('file-list').innerHTML = html;

    document.querySelectorAll('.file-header').forEach(function(el) {
      el.addEventListener('click', function() { renderCode(el.dataset.file); });
    });
    document.querySelectorAll('.fn-item').forEach(function(el) {
      el.addEventListener('click', function(e) {
        e.stopPropagation();
        var file = el.dataset.file;
        var line = parseInt(el.dataset.line, 10);
        function jump() {
          currentFnLine = line;
          document.querySelectorAll('.fn-item').forEach(function(x) { x.classList.remove('active'); });
          el.classList.add('active');
          renderCodeView();
          setTimeout(function() { scrollToLine(line); }, 30);
        }
        if (currentFile !== file) { renderCode(file); setTimeout(jump, 60); }
        else jump();
      });
    });
  }

  function buildProto() {
    var html = '<h2>WebSocket Commands (Browser → Server)</h2><div class="proto-grid">';
    DATA.wsCommands.forEach(function(cmd) {
      html += '<div class="proto-item cmd"><div class="ptype">cmd</div><div class="pname">' + esc(cmd) + '</div></div>';
    });
    html += '</div><h2>Broadcast Types (Server → Browser)</h2><div class="proto-grid">';
    DATA.broadcastTypes.forEach(function(t) {
      html += '<div class="proto-item bc"><div class="ptype">type</div><div class="pname">' + esc(t) + '</div></div>';
    });
    html += '</div><h2>GameClient Events (internal emit)</h2><div class="proto-grid">';
    DATA.gcEvents.forEach(function(ev) {
      html += '<div class="proto-item evt"><div class="ptype">event</div><div class="pname">' + esc(ev) + '</div></div>';
    });
    html += '</div>';
    document.getElementById('proto-content').innerHTML = html;
  }

  function initTabs() {
    document.querySelectorAll('.tab').forEach(function(btn) {
      btn.addEventListener('click', function() {
        document.querySelectorAll('.tab').forEach(function(b) { b.classList.remove('active'); });
        document.querySelectorAll('.page').forEach(function(p) { p.classList.remove('active'); });
        btn.classList.add('active');
        document.getElementById('page-' + btn.dataset.tab).classList.add('active');
      });
    });
  }

  function initSearch() {
    var box = document.getElementById('search');
    box.addEventListener('input', function() {
      searchTerm = box.value.trim();
      if (currentFile) renderCodeView();
    });
    document.addEventListener('keydown', function(e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault(); box.focus(); box.select();
      }
    });
  }

  buildSidebar();
  buildProto();
  initTabs();
  initSearch();
  if (FILES.length) renderCode(FILES[0]);
}
/* eslint-enable */

// Extract body of browserApp and wrap in IIFE
function getAppJs() {
  var src = browserApp.toString();
  // Remove "function browserApp() {" header and closing "}"
  var start = src.indexOf('{') + 1;
  var end   = src.lastIndexOf('}');
  return '(function() {' + src.slice(start, end) + '})();';
}

// ─── CSS ─────────────────────────────────────────────────────────────────────

function getCss() {
  return [
    '*{box-sizing:border-box;margin:0;padding:0}',
    ':root{',
    '  --bg:#1a1b26;--bg2:#16161e;--bg3:#24283b;--bg4:#2a2d3e;',
    '  --text:#c0caf5;--text2:#9aa5ce;--text3:#565f89;',
    '  --accent:#7aa2f7;--accent2:#bb9af7;--green:#9ece6a;',
    '  --yellow:#e0af68;--red:#f7768e;--cyan:#7dcfff;--orange:#ff9e64;',
    '  --border:#292e42;',
    '}',
    'html,body{height:100%;overflow:hidden;background:var(--bg);color:var(--text);',
    '  font-family:"Consolas","Fira Code","Courier New",monospace;font-size:13px}',
    'header{display:flex;align-items:center;gap:12px;padding:6px 12px;',
    '  background:var(--bg2);border-bottom:1px solid var(--border);height:40px;',
    '  flex-shrink:0;z-index:10}',
    '.logo{font-size:14px;font-weight:bold;color:var(--accent);white-space:nowrap}',
    '#tabs{display:flex;gap:4px}',
    '.tab{background:transparent;border:1px solid var(--border);border-radius:4px;',
    '  color:var(--text2);cursor:pointer;padding:3px 10px;font-size:12px;transition:.15s}',
    '.tab:hover{background:var(--bg3);color:var(--text)}',
    '.tab.active{background:var(--accent);border-color:var(--accent);color:#1a1b26;font-weight:bold}',
    '#search{margin-left:auto;background:var(--bg3);border:1px solid var(--border);',
    '  border-radius:4px;color:var(--text);padding:3px 8px;width:220px;font-size:12px}',
    '#search:focus{outline:none;border-color:var(--accent)}',
    '#app{display:flex;height:calc(100vh - 40px)}',
    '.page{display:none;width:100%;height:100%;overflow:auto}',
    '.page.active{display:flex}',
    /* sidebar */
    '#sidebar{width:265px;flex-shrink:0;background:var(--bg2);border-right:1px solid var(--border);',
    '  overflow-y:auto;overflow-x:hidden;height:100%}',
    '#code-panel{flex:1;display:flex;flex-direction:column;overflow:hidden}',
    '#code-header{padding:6px 12px;background:var(--bg3);border-bottom:1px solid var(--border);',
    '  font-size:11.5px;color:var(--text2);flex-shrink:0}',
    '#code-filename{color:var(--cyan);font-weight:bold}',
    '#code-body{display:flex;flex:1;overflow:auto;font-size:12.5px;line-height:1.6}',
    '#line-nums{padding:8px 8px 8px 12px;color:var(--text3);text-align:right;user-select:none;',
    '  background:var(--bg2);border-right:1px solid var(--border);min-width:46px;flex-shrink:0}',
    '#line-nums span{display:block}',
    '#code-view{padding:8px 16px 8px 12px;flex:1;white-space:pre;overflow:visible;outline:none}',
    '#code-view span{display:block;min-height:1em}',
    /* file entries */
    '.file-entry{border-bottom:1px solid var(--border)}',
    '.file-header{display:flex;align-items:center;gap:6px;padding:6px 10px;cursor:pointer;transition:.1s}',
    '.file-header:hover{background:var(--bg3)}',
    '.file-header.active{background:var(--bg4);color:var(--accent)}',
    '.file-icon{font-size:10px;opacity:.5;flex-shrink:0;width:22px}',
    '.file-name{font-size:12px;font-weight:bold;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.file-desc{font-size:10px;color:var(--text3);overflow:hidden;text-overflow:ellipsis;',
    '  white-space:nowrap;padding:0 10px 5px 38px}',
    '.fn-list{overflow:hidden;max-height:0;transition:max-height .25s ease}',
    '.fn-list.open{max-height:4000px}',
    '.fn-item{display:flex;justify-content:space-between;padding:2px 12px 2px 38px;',
    '  cursor:pointer;font-size:11px;color:var(--text2)}',
    '.fn-item:hover{background:var(--bg4);color:var(--cyan)}',
    '.fn-item.active{background:rgba(187,154,247,.1);color:var(--accent2)}',
    '.fn-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}',
    '.fn-line{color:var(--text3);font-size:10px;flex-shrink:0;margin-left:4px}',
    /* syntax highlighting */
    '.kw{color:var(--accent2)}',
    '.kw2{color:var(--accent)}',
    '.str{color:var(--green)}',
    '.cmt{color:var(--text3);font-style:italic}',
    '.num{color:var(--orange)}',
    '.fn{color:var(--yellow)}',
    '.bi{color:var(--cyan)}',
    '.hl-line{background:rgba(122,162,247,.07)}',
    '.hl-fn{background:rgba(187,154,247,.14)}',
    '.search-match{background:#e0af6840;border-radius:2px;outline:1px solid #e0af6860}',
    /* architecture tab */
    '#page-arch{display:none;overflow:auto}',
    '#page-arch.active{display:block}',
    '#arch-content{padding:24px 32px;max-width:960px}',
    '#arch-content h2{color:var(--accent);margin:22px 0 8px;font-size:15px;letter-spacing:.5px}',
    '#arch-content h3{color:var(--accent2);margin:14px 0 6px;font-size:13px}',
    '#arch-content pre{background:var(--bg2);border:1px solid var(--border);border-radius:6px;',
    '  padding:12px 16px;overflow-x:auto;color:var(--cyan);font-size:12px;line-height:1.7}',
    '#arch-content p{color:var(--text2);line-height:1.7;margin-bottom:8px;',
    '  font-family:sans-serif;font-size:13px}',
    /* protocol tab */
    '#page-proto{display:none;overflow:auto}',
    '#page-proto.active{display:block}',
    '#proto-content{padding:24px 32px}',
    '#proto-content h2{color:var(--accent);margin:20px 0 10px;font-size:15px}',
    '.proto-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));',
    '  gap:5px;margin-bottom:18px}',
    '.proto-item{background:var(--bg2);border:1px solid var(--border);',
    '  border-radius:4px;padding:5px 10px;font-size:12px}',
    '.proto-item .ptype{color:var(--text3);font-size:10px;margin-bottom:2px;text-transform:uppercase}',
    '.proto-item.cmd .pname{color:var(--cyan)}',
    '.proto-item.evt .pname{color:var(--green)}',
    '.proto-item.bc  .pname{color:var(--orange)}',
  ].join('\n');
}

// ─── Architecture HTML ────────────────────────────────────────────────────────

function getArchHtml() {
  return [
    '<div id="arch-content">',
    '<h2>&#x1F5FA; System Architecture</h2>',
    '<h3>Layer Overview</h3>',
    '<pre>',
    'Browser (public/index.html  +  public/admin.html)',
    '    ⇕ WebSocket (JSON messages on ws://localhost:3001)',
    'server.js  ──  Session manager, message router, profile persistence',
    '    ↓',
    'LoginClient (src/proto/loginClient.js)  — L2 login server protocol (TCP:2106)',
    '    ↓ emits PlayOk session key',
    'GameClient  (src/proto/gameClient.js)   — L2 game server protocol  (TCP:7777)',
    '    ↓ emits semantic game events',
    'Bot         (src/bot/bot.js)            — autonomous farming/support AI',
    '</pre>',
    '<h3>Connection / Login Flow</h3>',
    '<pre>',
    'Browser  →  cmd:login  →  server.js doLogin()',
    '             LoginClient.connect()  ►  TCP:2106',
    '             ← Init (RSA modulus, Blowfish session key)',
    '             → AuthGameGuard',
    '             ← GGAuth',
    '             → RequestAuthLogin (credentials, RSA-encrypted)',
    '             ← LoginOk',
    '             → RequestServerList',
    '             ← ServerList → auto-select first up server',
    '             → RequestServerLogin',
    '             ← PlayOk (loginOk1/2 + playOk1/2 session keys)',
    '             LoginClient.destroy()',
    '             GameClient.connect()  ►  TCP:7777',
    '             ← KeyPacket 0x2E (XOR key 8B + encryption flag)',
    '             → ProtocolVersion 0x0E (273 = High Five CT2.6)',
    '             → AuthLogin 0x2B (account name + 4 session key ints)',
    '             ← CharSelectInfo 0x09',
    'Browser  →  cmd:selectChar  →  doSelectChar()',
    '             → CharacterSelect 0x12',
    '             ← CharSelected 0x0B',
    '             → EnterWorld 0x11',
    '             ← UserInfo 0x32  →  Bot instantiated',
    '</pre>',
    '<h3>Bot State Machine</h3>',
    '<pre>',
    'IDLE ► FARMING ► COMBAT ► LOOTING ► FARMING  (farm loop)',
    '         ↑                              ↑',
    '         └──── HEALING ──────────────┘',
    '         └──── SUPPORT  (heal → buff → assist)',
    '',
    'IDLE → FARMING       bot.start()  (mode=FARM)',
    'IDLE → SUPPORT       bot.start()  (mode=SUPPORT)',
    'FARMING → COMBAT     _pickTarget() found attackable NPC',
    'COMBAT → LOOTING     die packet received for current target',
    'LOOTING → FARMING    _resumeFromLoot() → loot queue empty',
    '* → HEALING          HP% < healHpPct while in FARM mode',
    'HEALING → FARMING    3 s post-heal timeout',
    '*/FARMING → COMBAT   FightBack: incoming attack or CP/HP drop',
    '</pre>',
    '<h3>Encryption Layers</h3>',
    '<pre>',
    'Login Server (TCP:2106):',
    '  Init packet:    static Blowfish ECB key (16 B, hardcoded in loginCrypt.js)',
    '  All subsequent: per-session Blowfish ECB key exchanged in Init',
    '  Credentials:    RSA raw (no padding), mod from ScrambledKeyPair.java unscramble',
    '',
    'Game Server  (TCP:7777):',
    '  Before KeyPacket: plaintext',
    '  After  KeyPacket: XOR cipher, sliding 16-byte key (8B from server + XOR_KEY_TAIL)',
    '  First client packet after KeyPacket just enables encryption (no actual encrypt)',
    '  Key offset advances by payload length after each encrypt/decrypt call',
    '</pre>',
    '<h3>World Coordinates</h3>',
    '<pre>',
    'Origin:    WORLD_MIN_X=-655360  WORLD_MIN_Y=-589824',
    'Geodata:   cell=16 WU  |  region=2048\xD72048 cells (256 blocks \xD7 8 cells each)',
    'Radar map: X_MIN=-327680  X_RANGE=524288  (4 tiles \xD7 131072 WU each)',
    'Run speed: from UserInfo.runSpeed (WU/s), default 280 if unknown',
    'Pathfinder: BFS on NSWE bits, max 60 cells (≈960 WU) radius',
    '</pre>',
    '<h3>Key Packet Opcodes (Server → Client)</h3>',
    '<pre>',
    '0x00 Die            0x05 SpawnItem       0x08 DeleteObject    0x09 CharSelectInfo',
    '0x0B CharSelected   0x0C NpcInfo         0x11 ItemList        0x18 StatusUpdate',
    '0x19 NpcHtml        0x1F ActionFailed    0x21 InventoryUpdate 0x22 TeleportToLoc',
    '0x24 ValidateLoc    0x31 CharInfo        0x32 UserInfo        0x33 Attack',
    '0x39 AskJoinParty   0x47 StopMove        0x48 MagicSkillUse   0x49 MagicSkillCanceled',
    '0x4A Say2           0x4E-52 PartyWindow* 0x5F SkillList       0x85 AbnormalStatus',
    '0xCE RelationChg    0xD0 MultiSellList   0xF4 PartySpelled    0xFE ExPacket',
    '</pre>',
    '<h3>Key Packet Opcodes (Client → Server)</h3>',
    '<pre>',
    '0x01 Attack         0x0C CharCreate      0x0F MoveBackward    0x11 EnterWorld',
    '0x12 CharSelect     0x14 ItemList        0x17 DropItem        0x19 UseItem',
    '0x1F Action(target) 0x23 Bypass          0x37 SellItem        0x39 UseSkill',
    '0x3A Appearing      0x40 BuyItem         0x42 JoinParty       0x43 AnswerParty',
    '0x44 LeaveParty     0x49 Say2            0x56 ActionUse       0x7C AcquireSkill',
    '0x7D RestartPoint   0xB0 MultiSellChoose 0xD0 ExPacket(Shots)',
    '</pre>',
    '</div>',
  ].join('\n');
}

// ─── Main HTML builder ────────────────────────────────────────────────────────

function buildHtml() {
  var appJs  = getAppJs();
  var css    = getCss();
  var arch   = getArchHtml();

  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="UTF-8">',
    '<title>L2Bot – Code Admin</title>',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<style>', css, '</style>',
    '</head>',
    '<body>',
    '<header>',
    '  <span class="logo">&#x1F916; L2Bot Code Admin</span>',
    '  <nav id="tabs">',
    '    <button class="tab active" data-tab="code">&#x1F4C2; Code Browser</button>',
    '    <button class="tab" data-tab="arch">&#x1F5FA; Architecture</button>',
    '    <button class="tab" data-tab="proto">&#x1F4E1; WS Protocol</button>',
    '  </nav>',
    '  <input id="search" type="text" placeholder="&#x1F50D; Search (Ctrl+F)…">',
    '</header>',
    '<div id="app">',
    '  <div id="page-code" class="page active">',
    '    <aside id="sidebar"><div id="file-list"></div></aside>',
    '    <main id="code-panel">',
    '      <div id="code-header"><span id="code-filename">Select a file →</span></div>',
    '      <div id="code-body">',
    '        <div id="line-nums"></div>',
    '        <pre id="code-view"></pre>',
    '      </div>',
    '    </main>',
    '  </div>',
    '  <div id="page-arch" class="page">' + arch + '</div>',
    '  <div id="page-proto" class="page"><div id="proto-content"></div></div>',
    '</div>',
    '<script id="src-data" type="application/json">',
    safeJson,
    '</script>',
    '<script>', appJs, '</script>',
    '</body>',
    '</html>',
  ].join('\n');
}

const outPath = path.join(ROOT, 'public', 'admin.html');
fs.mkdirSync(path.join(ROOT, 'public'), { recursive: true });
fs.writeFileSync(outPath, buildHtml(), 'utf8');
const size = Math.round(fs.statSync(outPath).size / 1024);
console.log('Generated: ' + outPath + '  (' + size + ' KB)');
