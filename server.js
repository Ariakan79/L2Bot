'use strict';

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');
const { LoginClient } = require('./src/proto/loginClient');
const { GameClient } = require('./src/proto/gameClient');
const { Bot } = require('./src/bot/bot');
const { getGeoGrid } = require('./src/geo/geodata');

// ─── Character profiles (persistent config per char name) ─────────────────────

const PROFILES_DIR  = process.env.L2_PROFILES_DIR || path.join(__dirname, 'profiles');
const PROFILES_FILE = path.join(PROFILES_DIR, 'characters.json');
fs.mkdirSync(PROFILES_DIR, { recursive: true });
let profiles = {};
try { profiles = JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf8')); } catch { /* first run */ }

let _saveTimer = null;
function _scheduleSave() {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    fs.writeFile(PROFILES_FILE, JSON.stringify(profiles, null, 2), () => {});
  }, 2000);
}

function saveProfile(charName, config) {
  profiles[charName] = { ...(profiles[charName] || {}), ...config };
  _scheduleSave();
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = 3001;
const DEFAULT_HOST = 'server.ariakan.eu';
const MAX_SESSIONS = 16;
const GEO_UPDATE_DIST = 256;

// ─── Session management ───────────────────────────────────────────────────────

const sessions = new Map(); // id → SessionObject
let nextSessionId = 1;

function createSession() {
  const id = nextSessionId++;
  const sess = {
    id,
    phase: 'disconnected',
    accountName: null,
    gameHost: DEFAULT_HOST,
    gamePort: 7777,
    characters: [],
    sessionKey: null,
    skills: [],
    activeEffects: [],
    nearbyPlayers: {},
    gameClient: null,
    bot: null,
    lastGeoOrigin: null,
    loadedProfile: null,
    logs: [],
    statEvents: [],
  };
  sessions.set(id, sess);
  return sess;
}

function destroySession(sess) {
  if (sess.bot) { sess.bot.destroy(); sess.bot = null; }
  if (sess.gameClient) { sess.gameClient.destroy(); sess.gameClient = null; }
  sessions.delete(sess.id);
  broadcast({ type: 'sessionRemoved', sessionId: sess.id });
}

// ─── Broadcast helpers ────────────────────────────────────────────────────────

function broadcast(msg) {
  const json = JSON.stringify(msg);
  for (const ws of wss.clients) {
    if (ws.readyState === 1) ws.send(json);
  }
}

function broadcastSession(sess, msg) {
  broadcast({ ...msg, sessionId: sess.id });
}

function addLog(sess, msg) {
  const entry = { ts: new Date().toISOString().substr(11, 8), msg };
  sess.logs.push(entry);
  if (sess.logs.length > 200) sess.logs.shift();
  broadcastSession(sess, { type: 'log', ...entry });
}

function broadcastState(sess) {
  broadcastSession(sess, {
    type: 'state',
    phase: sess.phase,
    characters: sess.characters,
    accountName: sess.accountName,
  });
}

// ─── Geodata ──────────────────────────────────────────────────────────────────

function broadcastGeoGrid(sess, x, y, z) {
  sess.lastGeoOrigin = { x, y, z };
  try {
    const grid = getGeoGrid(x, y, z, 110);
    broadcastSession(sess, {
      type: 'geoGrid',
      gx0: grid.gx0, gy0: grid.gy0, W: grid.W, H: grid.H,
      worldMinX: grid.worldMinX, worldMinY: grid.worldMinY,
      cellSize: grid.cellSize,
      data: grid.data.toString('base64'),
    });
  } catch (e) {
    addLog(sess, '[Geo] Fehler: ' + e.message);
  }
}

function maybeUpdateGeo(sess, p) {
  if (!p) return;
  if (!sess.lastGeoOrigin ||
      Math.hypot(p.x - sess.lastGeoOrigin.x, p.y - sess.lastGeoOrigin.y) > GEO_UPDATE_DIST) {
    broadcastGeoGrid(sess, p.x, p.y, p.z || 0);
  }
}

// ─── WebSocket connection handler ─────────────────────────────────────────────

wss.on('connection', ws => {
  ws.on('error', () => {}); // prevent uncaught exception if browser disconnects abruptly

  // Send full snapshot of all sessions to the new client
  const snapshot = [];
  for (const sess of sessions.values()) {
    snapshot.push({
      id: sess.id,
      phase: sess.phase,
      characters: sess.characters,
      accountName: sess.accountName,
    });
  }
  ws.send(JSON.stringify({ type: 'sessionsSnapshot', sessions: snapshot }));

  // Per-session: logs, botStatus, skills, statEvents, nearbyPlayers
  for (const sess of sessions.values()) {
    if (sess.logs.length)
      ws.send(JSON.stringify({ type: 'logs', sessionId: sess.id, logs: sess.logs.slice(-30) }));
    if (sess.bot)
      ws.send(JSON.stringify({ type: 'botStatus', sessionId: sess.id, ...sess.bot._status() }));
    if (sess.skills.length)
      ws.send(JSON.stringify({ type: 'skillList', sessionId: sess.id, skills: sess.skills }));
    if (sess.activeEffects && sess.activeEffects.length)
      ws.send(JSON.stringify({ type: 'activeEffects', sessionId: sess.id, effects: sess.activeEffects }));
    if (sess.gameClient && sess.gameClient.party && sess.gameClient.party.size > 0)
      ws.send(JSON.stringify({ type: 'partyUpdate', sessionId: sess.id, members: [...sess.gameClient.party.values()] }));
    if (sess.statEvents.length)
      ws.send(JSON.stringify({ type: 'statEvents', sessionId: sess.id, events: sess.statEvents }));
    const players = Object.values(sess.nearbyPlayers);
    if (players.length)
      ws.send(JSON.stringify({ type: 'nearbyPlayers', sessionId: sess.id, players }));
    if (sess.loadedProfile)
      ws.send(JSON.stringify({ type: 'botConfigLoaded', sessionId: sess.id, config: sess.loadedProfile }));
    if (sess.gameClient && sess.gameClient.player)
      ws.send(JSON.stringify({ type: 'playerInfo', sessionId: sess.id, player: sess.gameClient.player }));
    if (sess.gameClient && sess.gameClient.inventory.length)
      ws.send(JSON.stringify({ type: 'itemList', sessionId: sess.id, items: sess.gameClient.inventory }));
  }

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // Session-agnostic commands
    if (msg.cmd === 'newSession') {
      if (sessions.size >= MAX_SESSIONS) {
        ws.send(JSON.stringify({ type: 'error', msg: 'Max. ' + MAX_SESSIONS + ' Sessions erreicht' }));
        return;
      }
      const sess = createSession();
      broadcast({ type: 'sessionCreated', sessionId: sess.id });
      return;
    }
    if (msg.cmd === 'removeSession') {
      const sess = sessions.get(msg.sessionId);
      if (sess) destroySession(sess);
      return;
    }
    if (msg.cmd === 'shutdown') {
      for (const sess of sessions.values()) destroySession(sess);
      setTimeout(() => process.exit(0), 500);
      return;
    }

    // All other commands require a valid sessionId
    const sess = sessions.get(msg.sessionId);
    if (!sess) return;
    const { gameClient, bot } = sess;

    switch (msg.cmd) {
      case 'login':
        doLogin(sess, msg.host || DEFAULT_HOST, msg.loginPort || 2106, msg.username, msg.password);
        break;
      case 'selectChar':
        doSelectChar(sess, msg.slot);
        break;
      case 'botStart':
        if (bot) bot.start();
        break;
      case 'botStop':
        if (bot) bot.stop();
        break;
      case 'botConfig': {
        if (bot) {
          // Derive attackSkills (just IDs) and attackSkillModes from attackSkillsRich if provided
          const cfg = { ...msg.config };
          if (cfg.attackSkillsRich) {
            cfg.attackSkills = cfg.attackSkillsRich.map(s => s.skillId);
            cfg.attackSkillModes = {};
            cfg.attackSkillsRich.forEach(s => { if (s.mode === 'once') cfg.attackSkillModes[s.skillId] = 'once'; });
          }
          bot.setConfig(cfg);
          // Auto-save profile keyed by character name
          const charName = gameClient && gameClient.player && gameClient.player.name;
          if (charName) {
            saveProfile(charName, msg.config);
            // Mirror into loadedProfile so reconnecting browsers receive the current config,
            // not the stale snapshot that was taken at character-login time.
            sess.loadedProfile = { ...(sess.loadedProfile || {}), ...msg.config };
          }
        }
        break;
      }
      case 'createChar':
        if (gameClient && sess.phase === 'char_select')
          gameClient.createCharacter(msg.name || 'TestBot', msg.classId || 0, msg.sex || 0);
        break;
      case 'logout':
        doLogout(sess);
        break;
      case 'moveTo':
        if (gameClient && sess.phase === 'in_game') gameClient.moveTo(msg.x, msg.y, msg.z);
        break;
      case 'attack':
        if (gameClient) gameClient.attack(msg.targetId);
        break;
      case 'useSkill':
        if (gameClient && sess.phase === 'in_game') gameClient.useSkill(msg.skillId);
        break;
      case 'action':
        if (gameClient && sess.phase === 'in_game') gameClient.useAction(msg.actionId || 0);
        break;
      case 'pickupNearest':
        if (bot) bot.pickupNearby();
        break;
      case 'pickup':
        if (gameClient) gameClient.requestPickup(msg.objectId);
        break;
      case 'useItem':
        if (gameClient) gameClient.useItem(msg.objectId);
        break;
      case 'dropItem':
        if (gameClient) gameClient.dropItem(msg.objectId, msg.count || 1);
        break;
      case 'requestItemList':
        if (gameClient) gameClient.requestItemList();
        break;
      case 'pickTarget':
        if (bot) bot.pickTarget();
        break;
      case 'setTarget':
        if (bot) bot.setManualTarget(msg.objectId, msg.startAttack !== false);
        else if (gameClient) gameClient.selectTarget(msg.objectId);
        break;
      case 'chat':
        if (gameClient) gameClient.sendChatMessage(msg.text, msg.chatType ?? 0);
        break;
      case 'respawn':
        if (gameClient) gameClient.requestRestartPoint(msg.respawnType ?? 0);
        break;
      case 'partyInvite':
        if (gameClient) gameClient.requestJoinParty(msg.targetName, msg.partyType ?? 1);
        break;
      case 'partyAnswer':
        if (gameClient) gameClient.answerJoinParty(!!msg.accept);
        break;
      case 'partyLeave':
        if (gameClient) {
          gameClient.requestLeaveParty();
          const cn = gameClient.player && gameClient.player.name;
          if (cn) saveProfile(cn, { savedPartyMembers: [], wasPartyLeader: false });
        }
        break;
      case 'partyRestore':
        startPartyRestore(sess);
        break;
      case 'follow': {
        if (bot) {
          const followCfg = { followTargetId: msg.objectId };
          if (msg.followDist) followCfg.followDist = msg.followDist;
          bot.setConfig(followCfg);
          broadcastSession(sess, { type: 'botStatus', ...bot._status() });
        }
        break;
      }
      case 'followStop':
        if (bot) { bot.setConfig({ followTargetId: null }); broadcastSession(sess, { type: 'botStatus', ...bot._status() }); }
        break;
      case 'assist':
        if (bot) { bot.setConfig({ assistTargetId: msg.objectId }); broadcastSession(sess, { type: 'botStatus', ...bot._status() }); }
        break;
      case 'assistStop':
        if (bot) { bot.setConfig({ assistTargetId: null }); broadcastSession(sess, { type: 'botStatus', ...bot._status() }); }
        break;
      case 'talkToNpc':
        if (gameClient) gameClient.talkToNpc(msg.objectId);
        break;
      case 'bypass':
        console.log('[WS] bypass cmd:', msg.bypass);
        if (gameClient) gameClient.sendBypass(msg.bypass);
        break;
      case 'learnSkill':
        if (gameClient) gameClient.learnSkill(msg.skillId, msg.level, msg.skillType || 0);
        break;
      case 'multiSellChoose':
        if (gameClient) gameClient.multiSellChoose(msg.listId, msg.entryId, msg.amount || 1);
        break;
      case 'buyItem':
        if (gameClient) gameClient.buyItems(msg.listId, msg.items);
        break;
      case 'sellItem':
        if (gameClient) gameClient.sellItems(msg.listId, msg.items);
        break;
      case 'toggleShot':
        if (gameClient) gameClient.autoSoulShot(msg.itemId, !!msg.enable);
        if (bot) bot.setConfig({ shotsEnabled: !!msg.enable, shotItemId: msg.itemId });
        break;
    }
  });
});

// ─── Login ────────────────────────────────────────────────────────────────────

function doLogin(sess, host, loginPort, username, password) {
  if (sess.phase !== 'disconnected') {
    addLog(sess, 'Bereits verbunden oder Login läuft');
    return;
  }

  sess.gameHost = host;
  sess.accountName = username;
  sess.phase = 'logging_in';
  broadcastState(sess);
  addLog(sess, 'Starte Login: ' + username + '@' + host);

  const lc = new LoginClient({
    host,
    port: loginPort,
    username,
    password,
    onLog: msg => addLog(sess, msg),
    onServerList: servers => broadcastSession(sess, { type: 'serverList', servers }),
    onPlayOk: (sessionKey, accountName) => {
      sess.sessionKey = sessionKey;
      sess.accountName = accountName;
      sess.phase = 'connecting_game';
      addLog(sess, 'PlayOk – verbinde Game-Server...');
      connectGameServer(sess);
    },
    onError: e => {
      addLog(sess, 'Login Fehler: ' + e.message);
      sess.phase = 'disconnected';
      broadcastState(sess);
    },
    onClose: () => {
      if (sess.phase === 'logging_in') {
        sess.phase = 'disconnected';
        broadcastState(sess);
      }
    },
  });

  lc.connect();
}

// ─── Game server connection ───────────────────────────────────────────────────

function connectGameServer(sess) {
  let intentionalDisconnect = false;

  const gc = new GameClient({
    host: sess.gameHost,
    port: sess.gamePort,
    sessionKey: sess.sessionKey,
    accountName: sess.accountName,
    onLog: msg => addLog(sess, msg),
  });
  sess.gameClient = gc;

  gc.on('charList', chars => {
    sess.characters = chars;
    sess.phase = 'char_select';
    broadcastState(sess);
    addLog(sess, 'Charakterliste: ' + (chars.map(c => c.name).join(', ') || '(leer)'));
  });

  gc.on('playerInfo', p => {
    if (sess.phase !== 'in_game') {
      sess.phase = 'in_game';
      broadcastState(sess);
    }
    broadcastSession(sess, { type: 'playerInfo', player: p });
    if (p.teleported) {
      // Zone change: discard stale players from the previous location.
      // The UI already clears its copy on teleported=true; keep server-side in sync.
      sess.nearbyPlayers = {};
    }
    maybeUpdateGeo(sess, p);
  });

  gc.on('teleport', () => {
    sess.nearbyPlayers = {};
    broadcastSession(sess, { type: 'clearEntities' });
  });

  gc.on('playerMove', p => {
    maybeUpdateGeo(sess, p);
    broadcastSession(sess, { type: 'playerMove', x: p.x, y: p.y, z: p.z });
  });

  gc.on('objectMove', upd => {
    const msg = { type: 'objectMove', objectId: upd.objectId, x: upd.x, y: upd.y, z: upd.z };
    if (upd.toX !== undefined) { msg.toX = upd.toX; msg.toY = upd.toY; msg.toZ = upd.toZ; }
    broadcastSession(sess, msg);
  });

  gc.on('playerStats', p => {
    broadcastSession(sess, { type: 'playerStats', player: p });
    if (sess.bot) broadcastSession(sess, { type: 'botStatus', ...sess.bot._status() });
  });

  gc.on('charCreated', name => {
    addLog(sess, 'Charakter erstellt: ' + name);
    sess.characters = [{ name, objectId: 0, slot: 0 }];
    sess.phase = 'char_select';
    broadcastState(sess);
  });

  gc.on('charCreateFail', reason => {
    addLog(sess, 'Charakter-Erstellung fehlgeschlagen (reason=' + reason + ')');
    broadcastSession(sess, { type: 'charCreateFail', reason });
  });

  gc.on('npcs', npcs => broadcastSession(sess, { type: 'npcs', npcs }));
  gc.on('itemSpawn', item => broadcastSession(sess, { type: 'itemSpawn', item }));

  gc.on('skillList', skills => {
    sess.skills = skills;
    broadcastSession(sess, { type: 'skillList', skills });
  });

  gc.on('activeEffects', effects => {
    sess.activeEffects = effects;
    broadcastSession(sess, { type: 'activeEffects', effects });
  });

  gc.on('itemList', items => broadcastSession(sess, { type: 'itemList', items }));
  gc.on('inventoryUpdate', updates => broadcastSession(sess, { type: 'inventoryUpdate', updates }));

  gc.on('playerAppear', p => {
    sess.nearbyPlayers[p.objectId] = p;
    broadcastSession(sess, { type: 'playerAppear', player: p });
  });

  gc.on('playerRelation', upd => {
    const pl = sess.nearbyPlayers[upd.objectId];
    if (pl) {
      pl.pvpFlag = upd.pvpFlag; pl.karma = upd.karma;
      broadcastSession(sess, { type: 'playerAppear', player: pl });
    }
  });

  gc.on('npcDialog', ({ npcObjId, html }) => {
    sess.npcDialog = { npcObjId, html };
    broadcastSession(sess, { type: 'npcDialog', npcObjId, html });
  });

  gc.on('shopList', data => {
    sess.shopList = data;
    broadcastSession(sess, { type: 'shopList', ...data });
  });

  gc.on('multiSellList', data => {
    sess.multiSellList = data;
    broadcastSession(sess, { type: 'multiSellList', ...data });
  });

  gc.on('acquireSkillList', data => {
    broadcastSession(sess, { type: 'acquireSkillList', ...data });
  });

  gc.on('acquireSkillInfo', data => {
    broadcastSession(sess, { type: 'acquireSkillInfo', ...data });
  });

  gc.on('autoSoulShot', data => {
    broadcastSession(sess, { type: 'autoSoulShot', ...data });
  });

  gc.on('nearbyHpUpdate', upd => {
    const pl = sess.nearbyPlayers[upd.objectId];
    if (pl) {
      if (upd.hp !== undefined) pl.hp = upd.hp;
      if (upd.maxHp !== undefined) pl.maxHp = upd.maxHp;
      broadcastSession(sess, { type: 'playerAppear', player: pl });
    }
  });

  gc.on('skillCastStart', ({ casterObjectId, targetObjectId, skillId, hitTime }) => {
    if (!gc.player || casterObjectId !== gc.player.objectId) return;
    broadcastSession(sess, { type: 'skillCast', skillId, targetObjectId, hitTime });
  });

  gc.on('skillCastCanceled', ({ casterObjectId }) => {
    if (!gc.player || casterObjectId !== gc.player.objectId) return;
    broadcastSession(sess, { type: 'skillCastCanceled' });
  });

  gc.on('chat', msg => broadcastSession(sess, { type: 'chatMessage', ...msg }));

  gc.on('objectDisappear', id => {
    if (sess.nearbyPlayers[id]) {
      delete sess.nearbyPlayers[id];
      broadcastSession(sess, { type: 'playerDisappear', objectId: id });
    }
    broadcastSession(sess, { type: 'objectDisappear', objectId: id });
  });

  gc.on('error', e => {
    if (intentionalDisconnect) return;
    addLog(sess, 'Game-Server Fehler: ' + e.message);
    _resetSession(sess);
  });

  gc.on('close', () => {
    if (intentionalDisconnect) return;
    addLog(sess, 'Game-Server getrennt');
    _resetSession(sess);
  });

  gc.connect();

  // Return cleanup function for intentional disconnect
  gc._intentionalDisconnect = () => { intentionalDisconnect = true; };
}

function _resetSession(sess) {
  if (sess.phase === 'disconnected') return; // already reset — ignore duplicate close/error events
  if (sess._partyRestoreTimer) { clearInterval(sess._partyRestoreTimer); sess._partyRestoreTimer = null; }
  if (sess._partyRestoreCleanup) { sess._partyRestoreCleanup(); sess._partyRestoreCleanup = null; }
  if (sess.bot) { sess.bot.destroy(); sess.bot = null; }
  const gc = sess.gameClient;
  sess.gameClient = null;
  if (gc) gc.destroy();
  sess.lastGeoOrigin = null;
  sess.loadedProfile = null;
  sess.phase = 'disconnected';
  sess.characters = [];
  sess.skills = [];
  sess.activeEffects = [];
  sess.nearbyPlayers = {};
  sess.statEvents.length = 0;
  broadcastState(sess);
}

// ─── Logout ───────────────────────────────────────────────────────────────────

function doLogout(sess) {
  if (sess.gameClient && sess.gameClient._intentionalDisconnect)
    sess.gameClient._intentionalDisconnect();
  if (sess._partyRestoreTimer) { clearInterval(sess._partyRestoreTimer); sess._partyRestoreTimer = null; }
  if (sess._partyRestoreCleanup) { sess._partyRestoreCleanup(); sess._partyRestoreCleanup = null; }
  if (sess.bot) { sess.bot.destroy(); sess.bot = null; }
  if (sess.gameClient) { sess.gameClient.destroy(); sess.gameClient = null; }
  sess.phase = 'disconnected';
  sess.characters = [];
  sess.skills = [];
  sess.activeEffects = [];
  sess.nearbyPlayers = {};
  sess.lastGeoOrigin = null;
  sess.loadedProfile = null;
  sess.statEvents.length = 0;
  addLog(sess, 'Ausgeloggt');
  broadcastState(sess);
}

// ─── Select character ─────────────────────────────────────────────────────────

function doSelectChar(sess, slot) {
  if (!sess.gameClient || sess.phase !== 'char_select') {
    addLog(sess, 'Nicht im Charakter-Auswahl-Bildschirm');
    return;
  }

  sess.gameClient.selectChar(slot);
  addLog(sess, 'Charakter Slot ' + slot + ' gewählt');

  const charData = sess.characters.find(c => c.slot === slot);
  sess.gameClient.once('playerInfo', () => {
    if (charData && charData.level && sess.gameClient.player && !sess.gameClient.player.level) {
      sess.gameClient.player.level = charData.level;
      broadcastSession(sess, { type: 'playerInfo', player: sess.gameClient.player });
    }
    if (!sess.bot) {
      const bot = new Bot(sess.gameClient);
      sess.bot = bot;
      bot.on('log', msg => addLog(sess, msg));
      bot.on('status', s => broadcastSession(sess, { type: 'botStatus', ...s }));
      bot.on('npcs', npcs => broadcastSession(sess, { type: 'npcs', npcs }));
      bot.on('npcHpUpdate', upd => broadcastSession(sess, { type: 'npcHpUpdate', ...upd }));
      bot.on('floorItems', items => broadcastSession(sess, { type: 'floorItems', items }));
      bot.on('playerDied', opts => broadcastSession(sess, { type: 'playerDied', ...opts }));
      bot.on('partyInvite', info => broadcastSession(sess, { type: 'partyInvite', ...info }));
      bot.on('partyPositionUpdate', members => broadcastSession(sess, { type: 'partyPositionUpdate', members }));
      bot.on('partyMemberUpdate', upd => broadcastSession(sess, { type: 'partyMemberUpdate', ...upd }));
      bot.on('partyUpdate', members => {
        broadcastSession(sess, { type: 'partyUpdate', members });
        const gc = sess.gameClient;
        const cn = gc && gc.player && gc.player.name;
        if (cn && gc.isPartyLeader && members.length > 0) {
          // Only save when party grows — never overwrite with a shrunk list.
          // Clearing happens only via explicit partyLeave command.
          const prevLen = ((profiles[cn] && profiles[cn].savedPartyMembers) || []).length;
          if (members.length >= prevLen) {
            saveProfile(cn, {
              savedPartyMembers: members.map(m => m.name),
              wasPartyLeader: true,
            });
          }
        }
      });
      bot.on('statEvent', e => {
        const ts = new Date().toISOString().substr(11, 8);
        const ev = { ts, ...e };
        sess.statEvents.push(ev);
        if (sess.statEvents.length > 200) sess.statEvents.shift();
        broadcastSession(sess, { type: 'statEvent', event: ev });
      });
      addLog(sess, 'Bot initialisiert');

      // Load saved profile for this character
      const charName = sess.gameClient && sess.gameClient.player && sess.gameClient.player.name;
      if (charName && profiles[charName]) {
        const prof = profiles[charName];
        const botCfg = { ...prof };
        if (prof.attackSkillsRich) {
          botCfg.attackSkills = prof.attackSkillsRich.map(s => s.skillId);
          botCfg.attackSkillModes = {};
          prof.attackSkillsRich.forEach(s => { if (s.mode === 'once') botCfg.attackSkillModes[s.skillId] = 'once'; });
        }
        bot.setConfig(botCfg);
        sess.loadedProfile = prof;
        broadcastSession(sess, { type: 'botConfigLoaded', config: prof });
        addLog(sess, 'Profil geladen: ' + charName);

        // Party auto-restore: if this char was party leader, re-invite saved members
        if (prof.wasPartyLeader && Array.isArray(prof.savedPartyMembers) && prof.savedPartyMembers.length > 0) {
          setTimeout(() => startPartyRestore(sess), 4000);
        }
      }
    }
  });
}

// ─── Party restore ───────────────────────────────────────────────────────────

function startPartyRestore(sess) {
  const gc = sess.gameClient;
  const cn = gc && gc.player && gc.player.name;
  const prof = cn && profiles[cn];
  if (!prof || !prof.wasPartyLeader || !Array.isArray(prof.savedPartyMembers) || prof.savedPartyMembers.length === 0) {
    addLog(sess, 'Keine gespeicherte Party vorhanden');
    return;
  }

  // Cancel any running restore loop (including its response listener)
  if (sess._partyRestoreTimer) { clearInterval(sess._partyRestoreTimer); sess._partyRestoreTimer = null; }
  if (sess._partyRestoreCleanup) { sess._partyRestoreCleanup(); sess._partyRestoreCleanup = null; }

  const pending = new Set(prof.savedPartyMembers);
  const MAX_ATTEMPTS = 36;
  let attempt = 0;
  let lastInvited = null; // first member of pending on each invite round

  addLog(sess, 'Party-Wiederherstellung gestartet (' + [...pending].join(', ') + ')');

  const stop = (msg) => {
    clearInterval(sess._partyRestoreTimer); sess._partyRestoreTimer = null;
    if (sess._partyRestoreCleanup) { sess._partyRestoreCleanup(); sess._partyRestoreCleanup = null; }
    if (msg) addLog(sess, msg);
  };

  const tryInvite = () => {
    const client = sess.gameClient;
    if (!client || !client.player) { stop(); return; }
    for (const m of client.party.values()) pending.delete(m.name);
    if (pending.size === 0) { stop('Party wiederhergestellt'); return; }
    if (++attempt > MAX_ATTEMPTS) {
      stop('Party-Wiederherstellung aufgegeben (' + [...pending].join(', ') + ' nicht erreichbar)');
      return;
    }
    // Server only processes one invite at a time — first member of pending is the active one
    lastInvited = [...pending][0];
    for (const name of pending) client.requestJoinParty(name, 1);
  };

  // React immediately to invite responses without waiting for the next 5s tick
  const onJoinResponse = (response) => {
    if (response === 1) {
      // accepted — partyUpdate will remove them from pending; nothing else needed
      addLog(sess, 'Party-Restore: ' + (lastInvited || '?') + ' hat angenommen');
      lastInvited = null;
    } else if (response === 0) {
      addLog(sess, 'Party-Restore: ' + (lastInvited || '?') + ' hat abgelehnt → erneuter Versuch in 5s');
      lastInvited = null;
    } else if (response === -1) {
      // invites disabled — remove immediately, no point retrying
      if (lastInvited) {
        addLog(sess, 'Party-Restore: ' + lastInvited + ' hat Einladungen deaktiviert → übersprungen');
        pending.delete(lastInvited);
        lastInvited = null;
        if (pending.size === 0) { stop('Party wiederhergestellt'); return; }
        // Invite next member right away
        tryInvite();
      }
    }
  };

  gc.on('partyJoinResponse', onJoinResponse);
  sess._partyRestoreCleanup = () => gc.removeListener('partyJoinResponse', onJoinResponse);

  sess._partyRestoreTimer = setInterval(tryInvite, 5000);
  tryInvite(); // immediate first attempt
}

// ─── Start ────────────────────────────────────────────────────────────────────

// Create the first session automatically so the UI has something to show
createSession();

server.listen(PORT, '127.0.0.1', () => {
  console.log('L2Bot läuft auf http://localhost:' + PORT);
  console.log('Im Browser öffnen: http://localhost:' + PORT);
});
