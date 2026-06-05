'use strict';

const net = require('net');
const EventEmitter = require('events');

// XOR cipher for game server (only used when PACKET_ENCRYPTION=1)
class GameEncryption {
  constructor(key16) {
    this._inKey = Buffer.from(key16);
    this._outKey = Buffer.from(key16);
    this._enabled = false;
  }

  encrypt(buf) {
    if (!this._enabled) { this._enabled = true; return buf; } // first call just enables
    const out = Buffer.from(buf);
    let prev = 0;
    for (let i = 0; i < out.length; i++) {
      const raw = out[i] & 0xFF;
      prev = (raw ^ (this._outKey[i & 0x0F] & 0xFF) ^ prev) & 0xFF;
      out[i] = prev;
    }
    this._advanceOffset(this._outKey, out.length);
    return out;
  }

  decrypt(buf) {
    if (!this._enabled) return buf;
    const out = Buffer.from(buf);
    let last = 0;
    for (let i = 0; i < out.length; i++) {
      const enc = out[i] & 0xFF;
      out[i] = (enc ^ (this._inKey[i & 0x0F] & 0xFF) ^ last) & 0xFF;
      last = enc;
    }
    this._advanceOffset(this._inKey, out.length);
    return out;
  }

  _advanceOffset(key, size) {
    let old = (key[8] & 0xFF) | ((key[9] & 0xFF) << 8) | ((key[10] & 0xFF) << 16) | ((key[11] & 0xFF) << 24);
    old = (old + size) >>> 0;
    key[8] = old & 0xFF;
    key[9] = (old >> 8) & 0xFF;
    key[10] = (old >> 16) & 0xFF;
    key[11] = (old >> 24) & 0xFF;
  }
}

const XOR_KEY_TAIL = Buffer.from([0xC8, 0x27, 0x93, 0x01, 0xA1, 0x6C, 0x31, 0x97]);

// L2 strings are UTF-16LE terminated by 2 null bytes (writeChar('\000'))
function readString(buf, off) {
  const chars = [];
  while (off + 1 < buf.length) {
    const code = buf[off] | (buf[off + 1] << 8);
    off += 2;
    if (code === 0) break;
    chars.push(String.fromCharCode(code));
  }
  return { str: chars.join(''), nextOff: off };
}

// Write UTF-16LE string with 2-byte null terminator
function writeString16(str) {
  const le = Buffer.from(str, 'utf16le');
  const out = Buffer.alloc(le.length + 2);
  le.copy(out);
  return out; // last 2 bytes are already 0x00 0x00
}

// Parse one item entry from AbstractItemPacket.writeItem() — always exactly 68 bytes
function parseItemEntry(data, off) {
  if (off + 68 > data.length) return null;
  const objectId = data.readInt32LE(off);  off += 4;
  const itemId   = data.readInt32LE(off);  off += 4;
  const location = data.readInt32LE(off);  off += 4;
  const countLo  = data.readUInt32LE(off); off += 4;
  const countHi  = data.readUInt32LE(off); off += 4;
  const count = countHi > 0 ? countHi * 0x100000000 + countLo : countLo;
  off += 2; // type2
  off += 2; // customType1
  const equipped = data.readInt16LE(off) !== 0; off += 2;
  const bodyPart = data.readInt32LE(off); off += 4;
  const enchant  = data.readInt16LE(off); off += 2;
  off += 2;  // customType2
  off += 4;  // augment
  off += 4;  // mana
  off += 4;  // remainingTime
  off += 2;  // attackElementType
  off += 2;  // attackElementPower
  off += 12; // 6× elementDefAttr (2 each)
  off += 6;  // 3× enchantOptions (2 each)
  return { item: { objectId, itemId, location, count, equipped, bodyPart, enchant }, nextOff: off };
}

class GameClient extends EventEmitter {
  constructor(opts) {
    super();
    this.host = opts.host;
    this.port = opts.port || 7777;
    this.sessionKey = opts.sessionKey; // { loginOk1, loginOk2, playOk1, playOk2 }
    this.accountName = opts.accountName;

    this._socket = null;
    this._buf = Buffer.alloc(0);
    this._crypt = null;
    this._useEncryption = false;

    this.characters = [];
    this.player = null;
    this.inventory = [];
    this.party = new Map(); // objectId → { objectId, name, level, classId, hp, maxHp, mp, maxMp }
    this.partyLeaderObjectId = null;

    this._moveTimer  = null;  // dead-reckoning interval
    this._moveDest   = null;  // { x, y, z } destination
    this._justTeleported = false;
    this._worldEntryLogged = false;

    this.onLog = opts.onLog || (() => {});
  }

  connect() {
    this._log('Verbinde mit Game-Server ' + this.host + ':' + this.port);
    this._socket = net.createConnection({ host: this.host, port: this.port });
    this._socket.on('connect', () => this._sendProtocolVersion());
    this._socket.on('data', d => this._onData(d));
    this._socket.on('error', e => { this._log('Fehler: ' + e.message); this.emit('error', e); });
    this._socket.on('close', () => { this._worldEntryLogged = false; this._log('Game-Server Verbindung getrennt'); this.emit('close'); });
  }

  _log(msg) { this.onLog('[Game] ' + msg); }

  _onData(data) {
    this._buf = Buffer.concat([this._buf, data]);
    while (this._buf.length >= 2) {
      const size = this._buf.readUInt16LE(0);
      if (size < 2 || this._buf.length < size) break;
      const payload = this._buf.slice(2, size);
      this._buf = this._buf.slice(size);
      this._handlePacket(payload);
    }
  }

  _handlePacket(payload) {
    let data = payload;
    if (this._crypt) data = this._crypt.decrypt(Buffer.from(payload));

    const opcode = data[0];
    switch (opcode) {
      case 0x2E: this._handleKeyPacket(data); break;          // VERSION_CHECK
      case 0x09: this._handleCharSelectInfo(data); break;     // CHARACTER_SELECTION_INFO
      case 0x0B: this._handleCharSelected(data); break;       // CHARACTER_SELECTED
      case 0x0F: this._handleCharCreateOk(data); break;       // CHARACTER_CREATE_SUCCESS
      case 0x10: this._handleCharCreateFail(data); break;     // CHARACTER_CREATE_FAIL
      case 0x32: this._handleUserInfo(data); break;           // USER_INFO
      case 0x18: this._handleStatusUpdate(data); break;       // STATUS_UPDATE
      case 0x2F: this._handleMoveToLocation(data); break;     // MOVE_TO_LOCATION
      case 0x47: this._handleStopMove(data); break;           // STOP_MOVE
      case 0x61: break;                                        // FINISH_ROTATING (ignore)
      case 0x00: this._handleDie(data); break;                // DIE
      case 0x0C: this._handleNpcInfo(data); break;            // NPC_INFO
      case 0x08: this._handleDeleteObject(data); break;       // DELETE_OBJECT
      case 0x05: this._handleSpawnItem(data); break;           // SPAWN_ITEM (item already on ground)
      case 0x16: this._handleDropItem(data); break;            // DROP_ITEM (NPC drops during death)
      case 0x5F: this._handleSkillList(data); break;          // SKILL_LIST
      case 0x11: this._handleItemList(data); break;           // ITEM_LIST
      case 0x21: this._handleInventoryUpdate(data); break;    // INVENTORY_UPDATE
      case 0x31: this._handleCharInfo(data); break;           // CHAR_INFO (other player)
      case 0xCE: this._handleRelationChanged(data); break;    // RELATION_CHANGED
      case 0x4A: this._handleSay2(data); break;              // SAY2 (server→client chat)
      case 0x39: this._handleAskJoinParty(data); break;          // ASK_JOIN_PARTY
      case 0x3A: this._handleJoinParty(data); break;             // JOIN_PARTY (invite response to leader)
      case 0x4E: this._handlePartySmallWindowAll(data); break;   // PARTY_SMALL_WINDOW_ALL
      case 0x4F: this._handlePartySmallWindowAdd(data); break;   // PARTY_SMALL_WINDOW_ADD
      case 0x50: this._handlePartySmallWindowDeleteAll(data); break; // PARTY_SMALL_WINDOW_DELETE_ALL
      case 0x51: this._handlePartySmallWindowDelete(data); break;    // PARTY_SMALL_WINDOW_DELETE
      case 0x52: this._handlePartyMemberUpdate(data); break;         // PARTY_SMALL_WINDOW_UPDATE
      case 0x22: this._handleTeleportToLocation(data); break;        // TELEPORT_TO_LOCATION
      case 0x33: this._handleAttack(data); break;                    // ATTACK
      case 0x19: this._handleNpcHtml(data); break;                  // NPC_HTML_MESSAGE
      case 0xD0: this._handleMultiSellList(data); break;            // MULTI_SELL_LIST
      case 0x90: this._handleAcquireSkillList(data); break;         // ACQUIRE_SKILL_LIST
      case 0x91: this._handleAcquireSkillInfo(data); break;         // ACQUIRE_SKILL_INFO
      case 0x24: this._handleValidateLocation(data); break;         // VALIDATE_LOCATION
      case 0x1F: this.emit('actionFailed'); break;                  // ACTION_FAIL
      case 0x25: break;  // AUTO_ATTACK_START
      case 0x26: break;  // AUTO_ATTACK_STOP
      case 0x27: break;  // SOCIAL_ACTION
      case 0x28: break;  // CHANGE_MOVE_TYPE (run/walk)
      case 0x30: break;  // NPC_SAY
      case 0x45: break;  // SHORT_CUT_INIT
      case 0x48: this._handleMagicSkillUse(data); break;      // MAGIC_SKILL_USE
      case 0x49: this._handleMagicSkillCanceled(data); break; // MAGIC_SKILL_CANCELED
      case 0x54: break;  // MAGIC_SKILL_LAUNCHED (silence)
      case 0x60: this._handleSweepInfo(data); break;  // SWEEP_INFO
      case 0x62: break;  // SYSTEM_MESSAGE
      case 0x72: break;  // MOVE_TO_PAWN
      case 0x73: break;  // SSQ_INFO
      case 0x75: break;  // L2_FRIEND_LIST
      case 0x85: this._handleAbnormalStatusUpdate(data); break; // ABNORMAL_STATUS_UPDATE
      case 0x86: break;  // QUEST_LIST
      case 0x9F: break;  // STATIC_OBJECT
      case 0xA9: break;  // TUTORIAL_CLOSE_HTML
      case 0xB9: break;  // MY_TARGET_SELECTED
      case 0xC7: break;  // SKILL_COOL_TIME
      case 0xE5: break;  // HENNA_INFO
      case 0xE8: break;  // MACRO_LIST
      case 0xF4: this._handlePartySpelled(data); break;             // PARTY_SPELLED
      case 0xF9: break;  // ETC_STATUS_UPDATE
      case 0xFE: this._handleExPacket(data); break;                 // Extended packets
      case 0x23: this._handleTargetSelected(data); break;        // TARGET_SELECTED
      case 0xBA: this._handlePartyMemberPosition(data); break;   // PARTY_MEMBER_POSITION
      case 0x6B: break;  // SETUP_GAUGE objectId(4) color(4) currentTime(4) maxTime(4) — cast progress bar
      case 0x17: this._handleGetItem(data); break;  // GET_ITEM (auto-loot / pickup)
      case 0x4D: break;  // compact entity info — silence
      case 0x79: break;  // formerly wrong ValidateLocation opcode — silence
      default:
        this._log('Unhandled packet 0x' + opcode.toString(16).padStart(2,'0') + ' len=' + data.length);
        break;
    }
  }

  _handleKeyPacket(data) {
    const result = data[1];
    const bfKey8 = data.slice(2, 10);
    const encFlag = data.readInt32LE(10);
    this._log('KeyPacket: result=' + result + ' PACKET_ENCRYPTION=' + encFlag);

    if (result === 0) {
      this._log('KeyPacket result=0: Protokoll abgelehnt, trenne Verbindung');
      this._socket.destroy();
      return;
    }

    if (encFlag !== 0) {
      const key16 = Buffer.concat([bfKey8, XOR_KEY_TAIL]);
      this._crypt = new GameEncryption(key16);
      this._useEncryption = true;
      this._log('Verschlüsselung aktiviert');
    }

    this._sendAuthLogin();
  }

  _sendProtocolVersion() {
    const buf = Buffer.alloc(5);
    buf[0] = 0x0E;
    buf.writeInt32LE(273, 1); // High Five protocol version
    this._send(buf);
    this._log('ProtocolVersion gesendet (273)');
  }

  _sendAuthLogin() {
    const nameLE = writeString16(this.accountName);
    const buf = Buffer.alloc(1 + nameLE.length + 16);
    let off = 0;
    buf[off++] = 0x2B; // AUTH_LOGIN opcode
    nameLE.copy(buf, off); off += nameLE.length;
    buf.writeInt32LE(this.sessionKey.playOk2, off); off += 4;
    buf.writeInt32LE(this.sessionKey.playOk1, off); off += 4;
    buf.writeInt32LE(this.sessionKey.loginOk1, off); off += 4;
    buf.writeInt32LE(this.sessionKey.loginOk2, off); off += 4;
    this._send(buf);
    this._log('AuthLogin gesendet. Account=' + this.accountName);
  }

  _handleCharSelectInfo(data) {
    this.characters = [];
    let off = 1;
    const charCount = data.readInt32LE(off); off += 4;
    off += 4; // maxCharsPerAccount
    off += 1; // padding byte
    this._log('CharSelectInfo: ' + charCount + ' Charakter(e)');

    // Fixed block layout after name(str16) objectId(4) loginName(str16):
    // sessionId(4) clanId(4) builderLevel(4) sex(4) race(4) baseClassId(4)
    // gameServerName(4) x(4) y(4) z(4) = 40
    // currentHp(8d) currentMp(8d) = 16   → base off+40, off+48
    // sp(4) exp(8l) expPercent(8d) = 20
    // level(4) karma(4) pkKills(4) pvpKills(4) 7×int(28) = 44   → level @ off+76
    // paperdoll[26]×4 = 104
    // hairStyle(4) hairColor(4) face(4) = 12
    // maxHp(8d) maxMp(8d) = 16   → off+236, off+244
    // deleteTimer(4) classId(4) isActive(4) enchantEffect(1) = 13  → classId @ off+256(int)
    // augmentId..vitality = 44
    // Total = 309
    const FIXED_REMAINDER = 309;

    for (let i = 0; i < charCount && off < data.length; i++) {
      const { str: name, nextOff: o1 } = readString(data, off); off = o1;
      if (off + 4 > data.length) break;
      const objectId = data.readInt32LE(off); off += 4;
      const { str: login, nextOff: o2 } = readString(data, off); off = o2;
      const base = off;

      const sex     = base + 12 + 4 <= data.length ? data.readInt32LE(base + 12) : 0;
      const race    = base + 16 + 4 <= data.length ? data.readInt32LE(base + 16) : 0;
      const x       = base + 28 + 4 <= data.length ? data.readInt32LE(base + 28) : 0;
      const y       = base + 32 + 4 <= data.length ? data.readInt32LE(base + 32) : 0;
      const z       = base + 36 + 4 <= data.length ? data.readInt32LE(base + 36) : 0;
      const hp      = base + 40 + 8 <= data.length ? data.readDoubleLE(base + 40) : 0;
      const mp      = base + 48 + 8 <= data.length ? data.readDoubleLE(base + 48) : 0;
      const level   = base + 76 + 4 <= data.length ? data.readInt32LE(base + 76) : 0;
      const maxHp   = base + 236 + 8 <= data.length ? data.readDoubleLE(base + 236) : 0;
      const maxMp   = base + 244 + 8 <= data.length ? data.readDoubleLE(base + 244) : 0;
      const classId = base + 256 + 4 <= data.length ? data.readInt32LE(base + 256) : 0;

      this.characters.push({ name, objectId, slot: i, level, classId, race, sex, x, y, z, hp, maxHp, mp, maxMp });
      off += FIXED_REMAINDER;
    }

    this.emit('charList', this.characters);
  }

  selectChar(slot) {
    // CHARACTER_SELECT: charSlot(4) unk1(2=short) unk2(4) unk3(4) unk4(4)
    const buf = Buffer.alloc(19, 0);
    buf[0] = 0x12;
    buf.writeInt32LE(slot, 1);
    // unk1 at offset 5 is a short (2 bytes), already 0
    // unk2/3/4 as ints at offsets 7, 11, 15
    this._send(buf);
    this._log('CharacterSelect gesendet. Slot=' + slot);
  }

  _handleCharSelected(data) {
    this._log('CharSelected – sende EnterWorld');
    this._sendEnterWorld();
  }

  _sendEnterWorld() {
    // EnterWorld payload: large block of zeros (game client sends ~220 bytes of flags/data)
    const buf = Buffer.alloc(1 + 128, 0);
    buf[0] = 0x11; // ENTER_WORLD
    this._send(buf);
  }

  _handleUserInfo(data) {
    // UserInfo is sent on world-entry, teleport, and respawn — always authoritative position.
    this._stopDeadReckoning();
    // UserInfo layout (CT2.6 HF) after opcode — from UserInfo.java source:
    // x(4) y(4) z(4) vehicleId(4) objectId(4) name(str16)
    // base+0:  race(4) sex(4) baseClass(4) level(4)
    // base+16: exp(8L)
    // base+24: expPercent(8d)  ← writeDouble, 8 bytes
    // base+32: STR(4) DEX(4) CON(4) INT(4) WIT(4) MEN(4)
    // base+56: maxHp(4) curHp(4) maxMp(4) curMp(4) sp(4)
    // base+76: load(4) maxLoad(4) pvpWeaponFlag(4)
    // base+88: paperdollObjectIds  (26 slots × 4 = 104 bytes)
    // base+192: paperdollDisplayIds (26 slots × 4 = 104 bytes)
    //           RHAND = index 7 → base+192 + 7×4 = base+220
    // base+296: paperdollAugmentIds (26 slots × 4 = 104 bytes)
    let off = 1;
    const x = data.readInt32LE(off); off += 4;
    const y = data.readInt32LE(off); off += 4;
    const z = data.readInt32LE(off); off += 4;
    off += 4; // vehicleId
    const objectId = data.readInt32LE(off); off += 4;
    const { str: name, nextOff } = readString(data, off); off = nextOff;

    const base = off;
    let level = 0, exp = 0, sp = 0;
    let maxHp = 0, curHp = 0, maxMp = 0, curMp = 0;
    let weaponItemId = 0;

    if (base + 76 <= data.length) {
      level = data.readInt32LE(base + 12);
      const expLo = data.readUInt32LE(base + 16);
      const expHi = data.readUInt32LE(base + 20);
      exp   = expHi * 0x100000000 + expLo;
      // base+24: expPercent(8d) — skipped
      maxHp = data.readInt32LE(base + 56);
      curHp = data.readInt32LE(base + 60);
      maxMp = data.readInt32LE(base + 64);
      curMp = data.readInt32LE(base + 68);
      sp    = data.readUInt32LE(base + 72);
    }

    if (base + 224 <= data.length) {
      weaponItemId = data.readInt32LE(base + 220);
    }

    // UserInfo layout (cont.): base+456 = runSpd (int32), per UserInfo.java
    // runSpd = Math.round(getRunSpeed() / moveMultiplier); used directly as WU/s
    let runSpeed = 0;
    if (base + 460 <= data.length) {
      runSpeed = data.readInt32LE(base + 456);
    }

    if (!this.player) this.player = {};
    Object.assign(this.player, { objectId, x, y, z, name });
    if (base + 76 <= data.length) {
      this.player.level        = level;
      this.player.exp          = exp;
      this.player.sp           = sp;
      this.player.maxHp        = maxHp;
      this.player.hp           = curHp;
      this.player.maxMp        = maxMp;
      this.player.mp           = curMp;
    }
    if (base + 224 <= data.length) {
      this.player.weaponItemId = weaponItemId;
    }
    if (runSpeed > 0) {
      this.player.runSpeed = runSpeed;
    }

    const teleported = this._justTeleported;
    this._justTeleported = false;
    this.emit('playerInfo', { ...this.player, teleported });
    if (!this._worldEntryLogged || teleported) {
      this._worldEntryLogged = true;
      this._log('In der Welt. ' + name + ' Lv' + (level||'?') + ' Pos=(' + x + ',' + y + ',' + z + ')');
    }
  }

  _handleStatusUpdate(data) {
    // StatusUpdate: objectId(4) + count(4) + [type(4) value(4)] ...
    let off = 1;
    const objectId = data.readInt32LE(off); off += 4;
    const count = data.readInt32LE(off); off += 4;
    const updates = {};
    for (let i = 0; i < count; i++) {
      const type = data.readInt32LE(off); off += 4;
      const val = data.readInt32LE(off); off += 4;
      updates[type] = val;
    }
    // Types: 1=LEVEL, 9=CUR_HP, 10=MAX_HP, 11=CUR_MP, 12=MAX_MP, 33=CUR_CP, 34=MAX_CP
    if (this.player && objectId === this.player.objectId) {
      if (updates[1]  !== undefined) this.player.level = updates[1];
      if (updates[9]  !== undefined) this.player.hp    = updates[9];
      if (updates[10] !== undefined) this.player.maxHp = updates[10];
      if (updates[11] !== undefined) this.player.mp    = updates[11];
      if (updates[12] !== undefined) this.player.maxMp = updates[12];
      if (updates[33] !== undefined) this.player.cp    = updates[33];
      if (updates[34] !== undefined) this.player.maxCp = updates[34];
      this.emit('playerStats', this.player);
    } else {
      // Track HP/maxHP for nearby players (used by support bot)
      const hp = updates[9]; const maxHp = updates[10];
      if (hp !== undefined || maxHp !== undefined) {
        this.emit('nearbyHpUpdate', { objectId, hp, maxHp });
      }
    }
  }

  _handleNpcInfo(data) {
    // NpcInfo (CT2.6 High Five) — see AbstractNpcInfo.java
    // objectId(4) displayId+1000000(4) isAttackable(4) x(4) y(4) z(4)
    // then heading(4)+unk(4)+mAtkSpd(4)+pAtkSpd(4)+runSpd(4)+walkSpd(4)+swimRun(4)+swimWalk(4)
    //      +flyRun(4)+flyWalk(4)+flyRun(4)+flyWalk(4) = 12×4=48 bytes
    // +moveMultiplier(8d)+atkSpdMulti(8d)+colRadius(8d)+colHeight(8d) = 4×8=32 bytes
    // +rhand(4)+chest(4)+lhand(4) = 12 bytes
    // +nameAbove(1)+running(1)+inCombat(1)+dead(1)+summoned(1) = 5 bytes
    // +NPCStringId(4) = 4 bytes → total skip after z: 48+32+12+5+4=101 bytes → name at off 126
    if (data.length < 13) return;
    let off = 1;
    const objectId   = data.readInt32LE(off); off += 4;
    const npcTypeId  = data.readInt32LE(off); off += 4; // displayId + 1000000
    const attackable = data.readInt32LE(off); off += 4;
    const x = data.readInt32LE(off); off += 4;
    const y = data.readInt32LE(off); off += 4;
    const z = data.readInt32LE(off); off += 4;

    let name = '', title = '', level = 0;
    if (data.length > 130) {
      off += 101; // skip to name string (offset 126 from data[0])
      const r1 = readString(data, off); name  = r1.str; off = r1.nextOff;
      off += 4;   // skip second NPCStringId
      const r2 = readString(data, off); title = r2.str;
      const lv = title.match(/Lv\s+(\d+)/);
      if (lv) level = parseInt(lv[1]);
    }
    this.emit('npcAppear', { objectId, npcTypeId, attackable, x, y, z, name, title, level });
  }

  _handleSpawnItem(data) {
    // SpawnItem: objectId(4) itemId(4) x(4) y(4) z(4) stackable(4) count(8L) unk(4) unk(4)
    let off = 1;
    const objectId = data.readInt32LE(off); off += 4;
    const itemId   = data.readInt32LE(off); off += 4;
    const x = data.readInt32LE(off); off += 4;
    const y = data.readInt32LE(off); off += 4;
    const z = data.readInt32LE(off); off += 4;
    off += 4; // stackable
    const count = off + 4 <= data.length ? data.readUInt32LE(off) : 1;
    this.emit('itemSpawn', { objectId, itemId, x, y, z, count });
  }

  _handleDropItem(data) {
    // DropItem: dropperObjectId(4) objectId(4) itemId(4) x(4) y(4) z(4) stackable(4) count(8L) unk(4)
    if (data.length < 29) return;
    let off = 1;
    off += 4; // dropper objectId
    const objectId = data.readInt32LE(off); off += 4;
    const itemId   = data.readInt32LE(off); off += 4;
    const x = data.readInt32LE(off); off += 4;
    const y = data.readInt32LE(off); off += 4;
    const z = data.readInt32LE(off); off += 4;
    off += 4; // stackable
    const count = off + 4 <= data.length ? data.readUInt32LE(off) : 1;
    this.emit('itemSpawn', { objectId, itemId, x, y, z, count });
  }

  _handleDeleteObject(data) {
    const objectId = data.readInt32LE(1);
    this.emit('objectDisappear', objectId);
  }

  _handleSkillList(data) {
    const count = data.readInt32LE(1);
    const skills = [];
    let off = 5;
    for (let i = 0; i < count && off + 10 <= data.length; i++) {
      const passive  = data.readInt32LE(off); off += 4;
      const level    = data.readInt32LE(off); off += 4;
      const skillId  = data.readInt32LE(off); off += 4;
      const disabled  = data[off++];
      const enchanted = data[off++];
      skills.push({ skillId, level, passive: passive !== 0, disabled: disabled !== 0, enchanted: enchanted !== 0 });
    }
    this.skills = skills;
    this.emit('skillList', skills);
    this._log('SkillList: ' + skills.length + ' Skills');
  }

  _handleCharInfo(data) {
    // CharInfo: x(4) y(4) z(4) vehicleId(4) objectId(4) name(str16)
    // then race(4) sex(4) baseClass(4) paperdoll items 26×4 paperdoll augment 26×4
    // talismanSlots(4) canEquipCloak(4) → pvpFlag(4) karma(4)
    // skip = 3×4 + 26×4 + 26×4 + 2×4 = 12 + 104 + 104 + 8 = 228 bytes
    if (data.length < 22) return;
    let off = 1;
    const x = data.readInt32LE(off); off += 4;
    const y = data.readInt32LE(off); off += 4;
    const z = data.readInt32LE(off); off += 4;
    off += 4; // vehicleId
    const objectId = data.readInt32LE(off); off += 4;
    const { str: name, nextOff } = readString(data, off); off = nextOff;
    const skip = 228;
    off += skip;
    const pvpFlag = off + 4 <= data.length ? data.readInt32LE(off) : 0; off += 4;
    const karma   = off + 4 <= data.length ? data.readInt32LE(off) : 0;
    this.emit('playerAppear', { objectId, x, y, z, name, pvpFlag, karma });
  }

  _handleRelationChanged(data) {
    // Format: count(4) then per entry: objId(4) relation(4) autoAttackable(4) karma(4) pvpFlag(4)
    if (data.length < 5) return;
    const count = data.readInt32LE(1);
    let off = 5;
    for (let i = 0; i < count && off + 20 <= data.length; i++) {
      const objectId = data.readInt32LE(off); off += 4;
      off += 4; // relation
      off += 4; // autoAttackable
      const karma   = data.readInt32LE(off); off += 4;
      const pvpFlag = data.readInt32LE(off); off += 4;
      this.emit('playerRelation', { objectId, karma, pvpFlag });
    }
  }

  _handleMoveToLocation(data) {
    // MoveToLocation: objectId(4) toX(4) toY(4) toZ(4) fromX(4) fromY(4) fromZ(4)
    if (data.length < 29) return;
    let off = 1;
    const objectId = data.readInt32LE(off); off += 4;
    const toX = data.readInt32LE(off); off += 4;
    const toY = data.readInt32LE(off); off += 4;
    const toZ = data.readInt32LE(off); off += 4;
    const fromX = data.readInt32LE(off); off += 4;
    const fromY = data.readInt32LE(off); off += 4;
    const fromZ = data.readInt32LE(off); off += 4;
    if (this.player && objectId === this.player.objectId) {
      // Always accept the server's Z (geodata height the client doesn't know).
      // For X/Y: the server's fromX/fromY is its position at packet-receive time, which lags
      // behind the client's DR-advanced position by RTT × speed (~14–80 WU). Snapping
      // unconditionally causes a visible backward jump on every new movement command.
      // Only correct X/Y when the discrepancy exceeds normal DR drift (> 100 WU).
      this.player.z = fromZ;
      const drift = Math.hypot(fromX - this.player.x, fromY - this.player.y);
      if (drift > 100) {
        this.player.x = fromX;
        this.player.y = fromY;
      }
      this._startDeadReckoning(toX, toY, toZ);
      this.emit('playerMove', this.player);
    } else {
      // Include destination so callers can dead-reckon or navigate to where the char is heading.
      // Do NOT update gc.party here — partyPositionUpdate is reserved for authoritative stops/corrections.
      this.emit('objectMove', { objectId, x: fromX, y: fromY, z: fromZ, toX, toY, toZ });
    }
  }

  _startDeadReckoning(toX, toY, toZ) {
    this._stopDeadReckoning();
    this._moveDest = { x: toX, y: toY, z: toZ };
    const STEP_MS = 100;
    const SPEED   = (this.player && this.player.runSpeed > 0) ? this.player.runSpeed : 280;
    const STEP_WU = SPEED * STEP_MS / 1000;
    this._moveTimer = setInterval(() => {
      if (!this.player || !this._moveDest) { this._stopDeadReckoning(); return; }
      const dx = this._moveDest.x - this.player.x;
      const dy = this._moveDest.y - this.player.y;
      const dist = Math.hypot(dx, dy);
      if (dist <= STEP_WU) {
        Object.assign(this.player, this._moveDest);
        this._stopDeadReckoning();
      } else {
        this.player.x = Math.round(this.player.x + (dx / dist) * STEP_WU);
        this.player.y = Math.round(this.player.y + (dy / dist) * STEP_WU);
      }
      this.emit('playerMove', this.player);
    }, STEP_MS);
  }

  _stopDeadReckoning() {
    if (this._moveTimer) { clearInterval(this._moveTimer); this._moveTimer = null; }
    this._moveDest = null;
  }

  get isMoving() { return this._moveTimer !== null; }

  _handleStopMove(data) {
    // StopMove: objectId(4) x(4) y(4) z(4) heading(4) — authoritative final position
    if (data.length < 17) return;
    const objectId = data.readInt32LE(1);
    const x = data.readInt32LE(5);
    const y = data.readInt32LE(9);
    const z = data.readInt32LE(13);
    if (this.player && objectId === this.player.objectId) {
      this._stopDeadReckoning();
      Object.assign(this.player, { x, y, z });
      this.emit('playerMove', this.player);
    } else {
      // StopMove is authoritative — snap party member and notify UI to clear dead-reckoning.
      const member = this.party.get(objectId);
      if (member) {
        member.x = x; member.y = y; member.z = z;
        this.emit('partyPositionUpdate', [...this.party.values()]);
      }
      this.emit('objectMove', { objectId, x, y, z });
    }
  }

  _handleValidateLocation(data) {
    // ValidateLocation: objectId(4) x(4) y(4) z(4) heading(4) — periodic server correction
    if (data.length < 17) return;
    const objectId = data.readInt32LE(1);
    const x = data.readInt32LE(5);
    const y = data.readInt32LE(9);
    const z = data.readInt32LE(13);
    if (this.player && objectId === this.player.objectId) {
      // Always accept Z (authoritative geodata height).
      // Only snap X/Y and stop dead reckoning if the server's correction is large —
      // during active movement the server position lags DR by RTT×speed (~14-200 WU),
      // so snapping unconditionally causes the visible "teleport back" on every tick.
      this.player.z = z;
      const drift = Math.hypot(x - this.player.x, y - this.player.y);
      if (drift > 200) {
        this._stopDeadReckoning();
        Object.assign(this.player, { x, y, z });
      }
      this.emit('validateLocation', { x, y, z });
      this.emit('playerMove', this.player);
    } else {
      const member = this.party.get(objectId);
      if (member) {
        member.x = x; member.y = y; member.z = z;
        this.emit('partyPositionUpdate', [...this.party.values()]);
      }
      this.emit('objectMove', { objectId, x, y, z });
    }
  }

  createCharacter(name, classId = 0, sex = 0) {
    // Send NewCharacter first to set up server-side char templates, then CharacterCreate
    const newCharBuf = Buffer.alloc(1);
    newCharBuf[0] = 0x13; // NEW_CHARACTER
    this._send(newCharBuf);
    // Small delay then send CharacterCreate
    setTimeout(() => this._sendCharacterCreate(name, classId, sex), 200);
  }

  _sendCharacterCreate(name, classId, sex) {
    this._lastCreatedCharName = name;
    // CharacterCreate: name(str16) race(4) sex(4) classId(4) int/str/con/men/dex/wit(6×4) hairStyle(4) hairColor(4) face(4)
    const nameLE = writeString16(name);
    const buf = Buffer.alloc(1 + nameLE.length + 12 * 4);
    let off = 0;
    buf[off++] = 0x0C; // CHARACTER_CREATE
    nameLE.copy(buf, off); off += nameLE.length;
    buf.writeInt32LE(0, off); off += 4; // race: 0 = Human
    buf.writeInt32LE(sex, off); off += 4;
    buf.writeInt32LE(classId, off); off += 4;
    buf.writeInt32LE(0, off); off += 4; // INT
    buf.writeInt32LE(0, off); off += 4; // STR
    buf.writeInt32LE(0, off); off += 4; // CON
    buf.writeInt32LE(0, off); off += 4; // MEN
    buf.writeInt32LE(0, off); off += 4; // DEX
    buf.writeInt32LE(0, off); off += 4; // WIT
    buf.writeInt32LE(0, off); off += 4; // hairStyle
    buf.writeInt32LE(0, off); off += 4; // hairColor
    buf.writeInt32LE(0, off); off += 4; // face
    this._send(buf);
    this._log('CharacterCreate gesendet: ' + name + ' class=' + classId);
  }

  _handleCharCreateOk(data) {
    this._log('Charakter erfolgreich erstellt!');
    this.emit('charCreated', this._lastCreatedCharName || 'Neuer Charakter');
  }

  _handleCharCreateFail(data) {
    const reason = data.readInt32LE(1);
    const reasons = { 0: 'Name existiert bereits', 1: 'Ungültiger Name', 2: 'Zu viele Charaktere', 3: 'Erstellung fehlgeschlagen' };
    this._log('Charakter-Erstellung fehlgeschlagen: ' + (reasons[reason] || 'Grund ' + reason));
    this.emit('charCreateFail', reason);
  }

  _handleDie(data) {
    if (data.length < 5) return;
    const objectId    = data.readInt32LE(1);
    const toVillage   = data.length > 5  ? data.readInt32LE(5)  !== 0 : true;
    const toClanHall  = data.length > 9  ? data.readInt32LE(9)  !== 0 : false;
    const toSiegeHQ   = data.length > 13 ? data.readInt32LE(13) !== 0 : false;
    const isSweepable = data.length > 17 ? data.readInt32LE(17) !== 0 : false;
    const toFixedLoc  = data.length > 21 ? data.readInt32LE(21) !== 0 : false;
    this.emit('die', objectId, isSweepable);
    if (this.player && objectId === this.player.objectId) {
      this._stopDeadReckoning();
      this._log('Charakter gestorben!');
      this.emit('playerDied', { toVillage, toClanHall, toSiegeHQ, toFixedLoc });
    }
  }

  _handleSweepInfo(data) {
    // SWEEP_INFO (0x60): objectId(4) count(4) [objectId(4) itemId(4) count(8) ...]
    if (data.length < 9) return;
    const npcObjectId = data.readInt32LE(1);
    const count = data.readInt32LE(5);
    const items = [];
    let off = 9;
    for (let i = 0; i < count && off + 16 <= data.length; i++) {
      const itemObjId = data.readInt32LE(off); off += 4;
      const itemId    = data.readInt32LE(off); off += 4;
      const itemCount = data.readInt32LE(off); off += 8; // int64; high 4 bytes ignored
      items.push({ objectId: itemObjId, itemId, count: itemCount });
    }
    this._log('Sweep: ' + count + ' Item(s) von Mob #' + npcObjectId);
    this.emit('sweepInfo', { npcObjectId, items });
  }

  _handleGetItem(data) {
    // GET_ITEM (0x17): itemObjectId(4) playerObjectId(4) itemId(4) x(4) y(4) z(4) count(8)
    if (data.length < 29) return;
    const itemObjectId = data.readInt32LE(1);
    const playerObjectId = data.readInt32LE(5);
    if (!this.player || playerObjectId !== this.player.objectId) return; // not our pickup
    const itemId = data.readInt32LE(9);
    // x(4) y(4) z(4) at bytes 13-24 — not needed
    const count = data.readInt32LE(25); // int64; high 4 bytes at 29 ignored for normal quantities
    this.emit('getItem', { itemObjectId, itemId, count });
  }

  _handleJoinParty(data) {
    // JoinParty: response(4) — sent to the inviter; 1=accepted, 0=declined, -1=invites disabled
    if (data.length < 5) return;
    const response = data.readInt32LE(1);
    this.emit('partyJoinResponse', response);
  }

  _handleAskJoinParty(data) {
    // AskJoinParty: requesterName(str16) partyDistributionType(4)
    if (data.length < 4) return;
    let off = 1;
    const { str: requesterName, nextOff } = readString(data, off); off = nextOff;
    const partyType = off + 4 <= data.length ? data.readInt32LE(off) : 1;
    this._log('Party-Einladung von: ' + requesterName);
    this.emit('partyInvite', { requesterName, partyType });
  }

  _handlePartySmallWindowAll(data) {
    // PARTY_SMALL_WINDOW_ALL — sent to each member, EXCLUDING the receiving player.
    // Per member: objectId(4) name(str) cp(4) maxCp(4) hp(4) maxHp(4) mp(4) maxMp(4)
    //             level(4) classId(4) unknown(4) race(4) t23a(4) t23b(4)
    //             summonObjectId(4) [if non-zero: npcId(4) type(4) name(str) hp(4) maxHp(4) mp(4) maxMp(4) level(4)]
    if (data.length < 13) return;
    if (!this.party) this.party = new Map();
    this.party.clear();
    let off = 1;
    this.partyLeaderObjectId = data.readInt32LE(off); off += 4;
    off += 4; // distType
    const count = data.readInt32LE(off); off += 4;
    for (let i = 0; i < count && off < data.length; i++) {
      const objectId = off + 4 <= data.length ? data.readInt32LE(off) : 0; off += 4;
      const { str: name, nextOff } = readString(data, off); off = nextOff;
      off += 8; // cp + maxCp
      const hp    = off + 4 <= data.length ? data.readInt32LE(off) : 0; off += 4;
      const maxHp = off + 4 <= data.length ? data.readInt32LE(off) : 0; off += 4;
      const mp    = off + 4 <= data.length ? data.readInt32LE(off) : 0; off += 4;
      const maxMp = off + 4 <= data.length ? data.readInt32LE(off) : 0; off += 4;
      const level   = off + 4 <= data.length ? data.readInt32LE(off) : 0; off += 4;
      const classId = off + 4 <= data.length ? data.readInt32LE(off) : 0; off += 4;
      off += 16; // unknown(4) + race(4) + T2.3(4) + T2.3(4)
      // Summon block: 0 if no summon, otherwise full summon record follows
      if (off + 4 <= data.length) {
        const summonObjId = data.readInt32LE(off); off += 4;
        if (summonObjId !== 0) {
          off += 8; // summonNpcId(4) + summonType(4)
          const { nextOff: sno } = readString(data, off); off = sno; // summonName
          off += 20; // hp(4) maxHp(4) mp(4) maxMp(4) level(4)
        }
      }
      this.party.set(objectId, { objectId, name, hp, maxHp, mp, maxMp, level, classId });
    }
    this._log('Party (' + count + ' Mitglieder)');
    this.emit('partyUpdate', [...this.party.values()]);
  }

  _handlePartySmallWindowAdd(data) {
    // leaderObjId(4) distType(4) objectId(4) name(str16) cp(4) maxCp(4) hp(4) maxHp(4) mp(4) maxMp(4) level(4) classId(4) 0(4) 0(4)
    if (data.length < 13) return;
    let off = 1;
    this.partyLeaderObjectId = data.readInt32LE(off); off += 4;
    off += 4; // distType
    const objectId = data.readInt32LE(off); off += 4;
    const { str: name, nextOff } = readString(data, off); off = nextOff;
    off += 8; // cp + maxCp
    const hp    = off + 4 <= data.length ? data.readInt32LE(off) : 0; off += 4;
    const maxHp = off + 4 <= data.length ? data.readInt32LE(off) : 0; off += 4;
    const mp    = off + 4 <= data.length ? data.readInt32LE(off) : 0; off += 4;
    const maxMp = off + 4 <= data.length ? data.readInt32LE(off) : 0; off += 4;
    const level   = off + 4 <= data.length ? data.readInt32LE(off) : 0; off += 4;
    const classId = off + 4 <= data.length ? data.readInt32LE(off) : 0;
    if (!this.party) this.party = new Map();
    this.party.set(objectId, { objectId, name, hp, maxHp, mp, maxMp, level, classId });
    this.emit('partyUpdate', [...this.party.values()]);
  }

  _handlePartySmallWindowDeleteAll(data) {
    this.party = new Map();
    this.partyLeaderObjectId = null;
    this.emit('partyUpdate', []);
    this._log('Party aufgelöst');
  }

  _handlePartySmallWindowDelete(data) {
    if (data.length < 5) return;
    const objectId = data.readInt32LE(1);
    if (this.party) this.party.delete(objectId);
    this.emit('partyUpdate', this.party ? [...this.party.values()] : []);
  }

  _handleTargetSelected(data) {
    // objectId(4) targetObjId(4) x(4) y(4) z(4) pad(4)
    if (data.length < 9) return;
    const objectId    = data.readInt32LE(1);
    const targetObjId = data.readInt32LE(5);
    this.emit('targetSelected', { objectId, targetObjId });
  }

  _handlePartyMemberPosition(data) {
    // count(4) [objectId(4) x(4) y(4) z(4)] × count
    if (data.length < 5) return;
    const count = data.readInt32LE(1);
    let off = 5;
    for (let i = 0; i < count && off + 16 <= data.length; i++) {
      const objectId = data.readInt32LE(off); off += 4;
      const x = data.readInt32LE(off); off += 4;
      const y = data.readInt32LE(off); off += 4;
      const z = data.readInt32LE(off); off += 4;
      const member = this.party.get(objectId);
      if (member) { member.x = x; member.y = y; member.z = z; }
    }
    this.emit('partyPositionUpdate', [...this.party.values()]);
  }

  _handlePartyMemberUpdate(data) {
    // PartySmallWindowUpdate: objectId(4) name(str16) cp(4) maxCp(4) hp(4) maxHp(4) mp(4) maxMp(4) level(4) classId(4)
    if (data.length < 9) return;
    let off = 1;
    const objectId = data.readInt32LE(off); off += 4;
    const { str: name, nextOff } = readString(data, off); off = nextOff;
    off += 8; // cp + maxCp
    const hp    = off + 4 <= data.length ? data.readInt32LE(off) : 0; off += 4;
    const maxHp = off + 4 <= data.length ? data.readInt32LE(off) : 0; off += 4;
    const mp    = off + 4 <= data.length ? data.readInt32LE(off) : 0; off += 4;
    const maxMp = off + 4 <= data.length ? data.readInt32LE(off) : 0;
    if (this.party && this.party.has(objectId)) {
      const m = this.party.get(objectId);
      Object.assign(m, { hp, maxHp, mp, maxMp });
      // Emit a targeted event — not partyUpdate — so the UI can merge hp/mp
      // without replacing the partyMembers array and wiping dead-reckoning state.
      this.emit('partyMemberUpdate', { objectId, hp, maxHp, mp, maxMp });
    }
  }

  // === Actions ===

  attack(targetObjectId) {
    // Attack: objectId(4) originX(4) originY(4) originZ(4) attackId(1) = 18 total
    const buf = Buffer.alloc(18, 0);
    buf[0] = 0x01;
    buf.writeInt32LE(targetObjectId, 1);
    const p = this.player || {};
    buf.writeInt32LE((p.x || 0) | 0, 5);
    buf.writeInt32LE((p.y || 0) | 0, 9);
    buf.writeInt32LE((p.z || 0) | 0, 13);
    buf[17] = 0; // attackId: 0=normal
    this._send(buf);
  }

  useSkill(skillId) {
    // REQUEST_MAGIC_SKILL_USE: magicId(4) ctrlPressed(4) shiftPressed(1)
    const buf = Buffer.alloc(10, 0);
    buf[0] = 0x39;
    buf.writeInt32LE(skillId, 1);
    buf.writeInt32LE(0, 5); // ctrlPressed
    buf[9] = 0; // shiftPressed
    this._send(buf);
  }

  useItem(objectId) {
    const buf = Buffer.alloc(9);
    buf[0] = 0x19; // USE_ITEM
    buf.writeInt32LE(objectId, 1);
    buf[8] = 0; // ctrl
    this._send(buf);
  }

  selectTarget(objectId) {
    // Action: objectId(4) originX(4) originY(4) originZ(4) actionId(1) = 18 total
    const buf = Buffer.alloc(18, 0);
    buf[0] = 0x1F;
    buf.writeInt32LE(objectId, 1);
    const p = this.player || {};
    buf.writeInt32LE((p.x || 0) | 0, 5);
    buf.writeInt32LE((p.y || 0) | 0, 9);
    buf.writeInt32LE((p.z || 0) | 0, 13);
    buf[17] = 0; // actionId: 0 = click
    this._send(buf);
  }

  deselectTarget() {
    // Action with objectId=0 cancels current target selection on the server
    const buf = Buffer.alloc(18, 0);
    buf[0] = 0x1F;
    // objectId stays 0 — all other fields zeroed
    this._send(buf);
  }

  requestPickup(objectId) {
    // Same Action packet with actionId=0 — server dispatches by object type
    const buf = Buffer.alloc(18, 0);
    buf[0] = 0x1F;
    buf.writeInt32LE(objectId, 1);
    const p = this.player || {};
    buf.writeInt32LE((p.x || 0) | 0, 5);
    buf.writeInt32LE((p.y || 0) | 0, 9);
    buf.writeInt32LE((p.z || 0) | 0, 13);
    buf[17] = 0;
    this._send(buf);
  }

  moveTo(x, y, z) {
    // MoveBackwardToLocation: targetX(4) targetY(4) targetZ(4) originX(4) originY(4) originZ(4) mode(4)
    const buf = Buffer.alloc(29, 0);
    buf[0] = 0x0F;
    buf.writeInt32LE(x | 0, 1);
    buf.writeInt32LE(y | 0, 5);
    buf.writeInt32LE(z | 0, 9);
    const p = this.player || {};
    buf.writeInt32LE((p.x || 0) | 0, 13);
    buf.writeInt32LE((p.y || 0) | 0, 17);
    buf.writeInt32LE((p.z || 0) | 0, 21);
    buf.writeInt32LE(1, 25); // 1 = mouse click
    this._send(buf);
  }

  useAction(actionId) {
    // RequestActionUse: actionId(4) ctrlPressed(4) shiftPressed(1)
    const buf = Buffer.alloc(10, 0);
    buf[0] = 0x56;
    buf.writeInt32LE(actionId, 1);
    // ctrlPressed and shiftPressed = 0
    this._send(buf);
  }

  _handleItemList(data) {
    // ItemList: opcode(1) showWindow(2s) count(2s) [68bytes×count] inventoryBlock...
    let off = 1;
    off += 2; // showWindow
    if (off + 2 > data.length) return;
    const count = data.readInt16LE(off); off += 2;
    const items = [];
    for (let i = 0; i < count; i++) {
      const r = parseItemEntry(data, off);
      if (!r) break;
      items.push(r.item);
      off = r.nextOff;
    }
    this.inventory = items;
    this.emit('itemList', items);
    this._log('Inventar: ' + items.length + ' Items');
  }

  _handleInventoryUpdate(data) {
    // InventoryUpdate: opcode(1) count(2s) [change(2s) + 68bytes] × count
    let off = 1;
    if (off + 2 > data.length) return;
    const count = data.readInt16LE(off); off += 2;
    const updates = [];
    for (let i = 0; i < count; i++) {
      if (off + 2 > data.length) break;
      const change = data.readInt16LE(off); off += 2;
      const r = parseItemEntry(data, off);
      if (!r) break;
      updates.push({ change, item: r.item });
      off = r.nextOff;
    }
    for (const { change, item } of updates) {
      if (change === 3 || item.count === 0) {
        this.inventory = this.inventory.filter(it => it.objectId !== item.objectId);
      } else {
        const idx = this.inventory.findIndex(it => it.objectId === item.objectId);
        if (idx >= 0) this.inventory[idx] = item;
        else this.inventory.push(item);
      }
    }
    this.emit('inventoryUpdate', updates);
  }

  requestItemList() {
    const buf = Buffer.alloc(1);
    buf[0] = 0x14; // REQUEST_ITEM_LIST
    this._send(buf);
  }

  destroyItem(objectId, count = 1) {
    // RequestDestroyItem (CT2.6 HF opcode 0x1B): objectId(4) count(8L)
    const buf = Buffer.alloc(13, 0);
    buf[0] = 0x1B;
    buf.writeInt32LE(objectId, 1);
    buf.writeUInt32LE(count >>> 0, 5); // count lo
    buf.writeUInt32LE(0, 9);           // count hi
    this._send(buf);
  }

  dropItem(objectId, count = 1) {
    // RequestDropItem: objectId(4) count(8l) x(4) y(4) z(4)
    const buf = Buffer.alloc(25, 0);
    buf[0] = 0x17;
    buf.writeInt32LE(objectId, 1);
    buf.writeUInt32LE(count >>> 0, 5);  // count lo
    buf.writeUInt32LE(0, 9);            // count hi
    const p = this.player || {};
    buf.writeInt32LE((p.x || 0) | 0, 13);
    buf.writeInt32LE((p.y || 0) | 0, 17);
    buf.writeInt32LE((p.z || 0) | 0, 21);
    this._send(buf);
  }

  _handleSay2(data) {
    // Say2 server→client: objectId(4) chatType(4) name(str16) text(str16)
    if (data.length < 9) return;
    let off = 1;
    const objectId = data.readInt32LE(off); off += 4;
    const chatType  = data.readInt32LE(off); off += 4;
    const { str: senderName, nextOff: o1 } = readString(data, off); off = o1;
    const { str: text } = readString(data, off);
    this.emit('chat', { objectId, chatType, senderName, text });
  }

  sendChatMessage(text, chatType = 0) {
    // SAY2: text(str16) type(4)
    const textLE = writeString16(text);
    const buf = Buffer.alloc(1 + textLE.length + 4);
    let off = 0;
    buf[off++] = 0x49;
    textLE.copy(buf, off); off += textLE.length;
    buf.writeInt32LE(chatType, off);
    this._send(buf);
  }

  _handleTeleportToLocation(data) {
    // TeleportToLocation: objectId(4) x(4) y(4) z(4) fade(4) heading(4)
    if (data.length < 21) return;
    const objectId = data.readInt32LE(1);
    const x = data.readInt32LE(5);
    const y = data.readInt32LE(9);
    const z = data.readInt32LE(13);
    if (this.player && objectId === this.player.objectId) {
      this._stopDeadReckoning();
      Object.assign(this.player, { x, y, z });
      this._justTeleported = true;
      this._log('Teleport → (' + x + ',' + y + ',' + z + ')');
      this.emit('teleport', { x, y, z });
      // Must send Appearing so the server calls onTeleported()+updateUserInfo()
      this._sendAppearing();
      this.emit('playerMove', this.player);
    }
  }

  _handleAttack(data) {
    // Attack: attackerObjId(4) firstHit:targetId(4) damage(4) flags(1) ...
    if (data.length < 10) return;
    const attackerObjectId = data.readInt32LE(1);
    const targetObjectId   = data.readInt32LE(5);
    this.emit('combatAttack', { attackerObjectId, targetObjectId });
  }

  _handleMagicSkillUse(data) {
    // MagicSkillUse: casterObjId(4) targetObjId(4) skillId(4) skillLevel(4) hitTime(4) reuseDelay(4) ...
    if (data.length < 25) return;
    let off = 1;
    const casterObjectId  = data.readInt32LE(off); off += 4;
    const targetObjectId  = data.readInt32LE(off); off += 4;
    const skillId         = data.readInt32LE(off); off += 4;
    off += 4; // skillLevel
    const hitTime         = data.readInt32LE(off); off += 4;
    const reuseDelay      = data.readInt32LE(off);
    this.emit('skillCastStart', { casterObjectId, targetObjectId, skillId, hitTime, reuseDelay });
  }

  _handleMagicSkillCanceled(data) {
    // MagicSkillCanceled: casterObjId(4)
    if (data.length < 5) return;
    const casterObjectId = data.readInt32LE(1);
    this.emit('skillCastCanceled', { casterObjectId });
  }

  _handlePartySpelled(data) {
    // PARTY_SPELLED: type(4) objectId(4) count(4) + n×[skillId(4) level(2) duration(4)]
    // Sent to all party members whenever any member's buff list changes (full snapshot, not delta).
    // duration in seconds; -1 = permanent.
    if (data.length < 13) return;
    const type     = data.readInt32LE(1);
    if (type !== 0) return; // 0=player; skip pet(1)/servitor(2)
    const objectId = data.readInt32LE(5);
    const count    = data.readInt32LE(9);
    if (count < 0 || count > 500) return;
    const effects = [];
    let off = 13;
    for (let i = 0; i < count && off + 10 <= data.length; i++) {
      const skillId  = data.readInt32LE(off);
      const level    = data.readInt16LE(off + 4);
      const duration = data.readInt32LE(off + 6);
      effects.push({ skillId, level, duration });
      off += 10;
    }
    this.emit('partyMemberEffects', { objectId, effects });
  }

  _handleAbnormalStatusUpdate(data) {
    // AbnormalStatusUpdate (High Five): count(2) then per effect: skillId(4) level(2) duration(4)
    // duration in seconds; -1 = permanent.
    if (data.length < 3) return;
    const count = data.readInt16LE(1);
    if (count < 0 || count > 200) return; // sanity check
    const effects = [];
    let off = 3;
    for (let i = 0; i < count; i++) {
      if (off + 10 > data.length) break;
      const skillId  = data.readInt32LE(off); off += 4;
      const level    = data.readInt16LE(off); off += 2;
      const duration = data.readInt32LE(off); off += 4;
      effects.push({ skillId, level, duration });
    }
    this.activeEffects = effects;
    this.emit('activeEffects', effects);
  }

  _sendAppearing() {
    const buf = Buffer.alloc(1);
    buf[0] = 0x3A; // Appearing (ClientPackets.java: APPEARING=0x3A)
    this._send(buf);
  }

  // === Respawn ===
  // type: 0=village(default) 1=clanHall 2=castle 3=fortress 4=siegeHQ 5=fixed
  requestRestartPoint(type = 0) {
    const buf = Buffer.alloc(5);
    buf[0] = 0x7D; // REQUEST_RESTART_POINT in CT2.6 ClientPackets.java
    buf.writeInt32LE(type, 1);
    this._send(buf);
    this._log('Respawn angefordert (type=' + type + ')');
  }

  // === Party ===
  requestJoinParty(targetName, type = 1) {
    const nameBytes = writeString16(targetName);
    const buf = Buffer.alloc(1 + nameBytes.length + 4);
    let off = 0;
    buf[off++] = 0x42; // RequestJoinParty
    nameBytes.copy(buf, off); off += nameBytes.length;
    buf.writeInt32LE(type, off);
    this._send(buf);
    this._log('Party-Einladung gesendet an: ' + targetName);
  }

  answerJoinParty(accept) {
    const buf = Buffer.alloc(5);
    buf[0] = 0x43; // RequestAnswerJoinParty
    buf.writeInt32LE(accept ? 1 : 0, 1);
    this._send(buf);
    this._log('Party-Antwort: ' + (accept ? 'Angenommen' : 'Abgelehnt'));
  }

  requestLeaveParty() {
    const buf = Buffer.alloc(1);
    buf[0] = 0x44; // RequestWithdrawParty
    this._send(buf);
    this._log('Party verlassen');
  }

  get isPartyLeader() {
    return !!(this.player && this.partyLeaderObjectId &&
              this.partyLeaderObjectId === this.player.objectId);
  }

  _send(payload) {
    if (!this._socket || this._socket.destroyed) return;
    let data = payload;
    if (this._crypt) data = this._crypt.encrypt(Buffer.from(payload));
    const packet = Buffer.alloc(2 + data.length);
    packet.writeUInt16LE(packet.length, 0);
    data.copy(packet, 2);
    this._socket.write(packet);
  }

  destroy() {
    this._stopDeadReckoning();
    if (this._socket) this._socket.destroy();
    this.removeAllListeners();
  }

  // === NPC Interaction ===

  _handleNpcHtml(data) {
    // NpcHtmlMessage: npcObjId(4) html(str16) itemId(4)
    if (data.length < 6) return;
    let off = 1;
    const npcObjId = data.readInt32LE(off); off += 4;
    const { str: html, nextOff } = readString(data, off);
    this.emit('npcDialog', { npcObjId, html });
  }

  _handleMultiSellList(data) {
    // MultiSellList (0xD0): listId(4) page(4) finished(4) pageSize(4) count(4)
    // Per entry: entryId(4) stackable(1) [C6:short+int] [T1:int+8×short] prodCount(2) ingCount(2)
    //   Per product:  displayId(4) bodyPart(4) type2(2) count(8L) +24 bytes item info
    //   Per ingredient: itemId(4) type2(2) count(8L) +22 bytes item info
    if (data.length < 21) return;
    let off = 1;
    const listId   = data.readInt32LE(off); off += 4;
    const page     = data.readInt32LE(off); off += 4;
    const finished = data.readInt32LE(off); off += 4;
    const pageSize = data.readInt32LE(off); off += 4;
    const count    = data.readInt32LE(off); off += 4;

    if (page === 1 || !this._multiSellPages || this._multiSellPages.listId !== listId) {
      this._multiSellPages = { listId, entries: [] };
    }

    for (let i = 0; i < count && off < data.length; i++) {
      if (off + 35 > data.length) break;
      const entryId   = data.readInt32LE(off); off += 4;
      const stackable = data[off++];
      off += 6;  // C6: short + int
      off += 20; // T1: int + 8×short
      const prodCount = data.readUInt16LE(off); off += 2;
      const ingCount  = data.readUInt16LE(off); off += 2;

      // product: displayId(4) bodyPart(4) type2(2) count(8L) enchant(2) augment(4) mana(4) elemType(2) elemPow(2) 6×elem(2)
      const PROD_SIZE = 4+4+2+8+2+4+4+2+2+12; // 44
      const ING_SIZE  = 4+2+8+2+4+4+2+2+12;   // 40
      if (off + prodCount * PROD_SIZE + ingCount * ING_SIZE > data.length) break;

      const products = [];
      for (let p = 0; p < prodCount; p++) {
        const itemId = data.readInt32LE(off); off += 4;
        off += 6; // bodyPart(4) + type2(2)
        const cntLo  = data.readUInt32LE(off); off += 4;
        const cntHi  = data.readUInt32LE(off); off += 4;
        const cnt    = cntHi ? cntHi * 0x100000000 + cntLo : cntLo;
        off += 26; // enchant(2)+augment(4)+mana(4)+elemType(2)+elemPow(2)+6×elem(2)
        products.push({ itemId, count: cnt });
      }

      const ingredients = [];
      for (let g = 0; g < ingCount; g++) {
        const itemId = data.readInt32LE(off); off += 4;
        off += 2; // type2
        const cntLo  = data.readUInt32LE(off); off += 4;
        const cntHi  = data.readUInt32LE(off); off += 4;
        const cnt    = cntHi ? cntHi * 0x100000000 + cntLo : cntLo;
        off += 26; // enchant(2)+augment(4)+mana(4)+elemType(2)+elemPow(2)+6×elem(2)
        ingredients.push({ itemId, count: cnt });
      }

      this._multiSellPages.entries.push({ entryId, stackable, products, ingredients });
    }

    if (finished) {
      this._log('MultiSellList listId=' + listId + ' entries=' + this._multiSellPages.entries.length);
      this.emit('multiSellList', { listId, entries: this._multiSellPages.entries });
      this._multiSellPages = null;
    }
  }

  _handleAcquireSkillList(data) {
    // AcquireSkillList (0x90): type(4) count(4) + per skill: id(4) nextLevel(4) maxLevel(4) spCost(4) requirements(4)
    if (data.length < 9) return;
    let off = 1;
    const type  = data.readInt32LE(off); off += 4;
    const count = data.readInt32LE(off); off += 4;
    const skills = [];
    for (let i = 0; i < count && off + 20 <= data.length; i++) {
      const skillId    = data.readInt32LE(off); off += 4;
      const nextLevel  = data.readInt32LE(off); off += 4;
      const maxLevel   = data.readInt32LE(off); off += 4;
      const spCost     = data.readInt32LE(off); off += 4;
      const reqs       = data.readInt32LE(off); off += 4;
      skills.push({ skillId, nextLevel, maxLevel, spCost, reqs });
    }
    this._log('AcquireSkillList type=' + type + ' count=' + skills.length);
    this.emit('acquireSkillList', { type, skills });
  }

  _handleAcquireSkillInfo(data) {
    // AcquireSkillInfo (0x91): id(4) level(4) spCost(4) type(4) reqCount(4) + per req: type(4) itemId(4) count(8L) unk(4)
    if (data.length < 21) return;
    let off = 1;
    const skillId  = data.readInt32LE(off); off += 4;
    const level    = data.readInt32LE(off); off += 4;
    const spCost   = data.readInt32LE(off); off += 4;
    const type     = data.readInt32LE(off); off += 4;
    const reqCount = data.readInt32LE(off); off += 4;
    const reqs = [];
    for (let i = 0; i < reqCount && off + 20 <= data.length; i++) {
      const rType  = data.readInt32LE(off); off += 4;
      const itemId = data.readInt32LE(off); off += 4;
      const countLo = data.readUInt32LE(off); off += 4;
      const countHi = data.readUInt32LE(off); off += 4;
      const count = countHi * 0x100000000 + countLo;
      const unk   = data.readInt32LE(off); off += 4;
      reqs.push({ itemId, count });
    }
    this._log('AcquireSkillInfo skillId=' + skillId + ' level=' + level + ' sp=' + spCost);
    this.emit('acquireSkillInfo', { skillId, level, spCost, type, reqs });
  }

  _handleExPacket(data) {
    // Extended packets: opcode 0xFE + sub-opcode uint16LE
    if (data.length < 3) return;
    const subOp = data.readUInt16LE(1);
    switch (subOp) {
      case 0x00B7: this._handleExBuySellList(data); break; // EX_BUY_SELL_LIST
      case 0x000C: { // EX_AUTO_SOULSHOT — server confirms enable/disable
        if (data.length >= 11) {
          const itemId  = data.readInt32LE(3);
          const type    = data.readInt32LE(7);
          this.emit('autoSoulShot', { itemId, enabled: type !== 0 });
        }
        break;
      }
      default: break;
    }
  }

  _handleExBuySellList(data) {
    // EX_BUY_SELL_LIST: subOp(2) type(4) money(8L) listId(4) count(2) + items
    if (data.length < 21) return;
    let off = 3; // skip opcode(1) + subOp(2)
    const type    = data.readInt32LE(off); off += 4;  // 0=buy 1=sell
    const moneyLo = data.readUInt32LE(off); off += 4;
    const moneyHi = data.readUInt32LE(off); off += 4;
    const money   = moneyHi * 0x100000000 + moneyLo;
    const listId  = data.readInt32LE(off); off += 4;
    const count   = data.readUInt16LE(off); off += 2;

    const items = [];
    // Per item: itemId(4) itemId2(4) unk(4) stock(8L) type2(2) type1(2) isEquip(2)
    //           bodyPart(4) enchant(2) custom(2) augment(4) mana(4) time(4)
    //           elemType(2) elemPow(2) elemRes[6]×2 enchantEff[3]×2 price(8L)
    const ITEM_SIZE = 76;
    for (let i = 0; i < count && off + ITEM_SIZE <= data.length; i++) {
      const itemId = data.readInt32LE(off); off += 4;
      off += 4; // itemId2
      off += 4; // unk
      const stockLo = data.readUInt32LE(off); off += 4;
      const stockHi = data.readUInt32LE(off); off += 4;
      const stock = stockHi ? -1 : stockLo; // -1 = unlimited
      off += 2 + 2 + 2; // type2 type1 isEquip
      off += 4 + 2 + 2 + 4 + 4 + 4; // bodyPart enchant custom augment mana time
      off += 2 + 2;     // elemType elemPow
      off += 6 * 2;     // elemRes[6]
      off += 3 * 2;     // enchantEff[3]
      const priceLo = data.readUInt32LE(off); off += 4;
      const priceHi = data.readUInt32LE(off); off += 4;
      const price = priceHi * 0x100000000 + priceLo;
      items.push({ itemId, price, stock });
    }
    this.emit('shopList', { type, money, listId, items });
  }

  talkToNpc(objectId) {
    // First Action = select target, second Action on same target = interact/talk
    this.selectTarget(objectId);
    this.selectTarget(objectId);
  }

  sendBypass(cmd) {
    this._log('Bypass → ' + cmd);
    const str = writeString16(cmd);
    const buf = Buffer.alloc(1 + str.length);
    buf[0] = 0x23; // REQUEST_BYPASS_TO_SERVER
    str.copy(buf, 1);
    this._send(buf);
  }

  autoSoulShot(itemId, enable) {
    // RequestAutoSoulShot — extended client packet: 0xD0 + sub(2LE) + itemId(4) + type(4)
    // type: 0=disable, 1=enable. The server determines shot category (soulshot vs spiritshot)
    // from the item's database type — NOT from this field. Sending type=2 for spiritshots was
    // interpreted as disable (type != 1) by L2J, which is why spiritshots never activated.
    const shotType = enable ? 1 : 0;
    const buf = Buffer.alloc(11, 0);
    buf[0] = 0xD0;
    buf.writeUInt16LE(0x000D, 1); // sub-opcode
    buf.writeInt32LE(itemId, 3);
    buf.writeInt32LE(shotType, 7);
    this._send(buf);
    this._log('AutoSoulShot itemId=' + itemId + ' type=' + shotType + ' ' + (enable ? 'EIN' : 'AUS'));
  }

  multiSellChoose(listId, entryId, amount) {
    // MultiSellChoose (0xB0): listId(4) entryId(4) amount(8L)
    //   unk1(2s) unk2(4) unk3(4) + 8×short(2) elem attrs = 42 bytes data total
    const buf = Buffer.alloc(43, 0); // 1 opcode + 42 data
    buf[0] = 0xB0;
    buf.writeInt32LE(listId, 1);
    buf.writeInt32LE(entryId, 5);
    buf.writeUInt32LE(amount >>> 0, 9);  // amount lo
    buf.writeUInt32LE(0, 13);            // amount hi
    // unk1(2) + unk2(4) + unk3(4) + unk4-11(8×2) all zero — already zeroed by Buffer.alloc
    this._send(buf);
    this._log('MultiSellChoose listId=' + listId + ' entryId=' + entryId + ' amount=' + amount);
  }

  learnSkill(skillId, level, type = 0) {
    // RequestAcquireSkill (0x7C): skillId(4) level(4) type(4)
    const buf = Buffer.alloc(13);
    buf[0] = 0x7C;
    buf.writeInt32LE(skillId, 1);
    buf.writeInt32LE(level, 5);
    buf.writeInt32LE(type, 9);
    this._send(buf);
    this._log('LearnSkill skillId=' + skillId + ' level=' + level + ' type=' + type);
  }

  buyItems(listId, items) {
    // RequestBuyItem: listId(4) count(4) [itemId(4) count(8L)]×n
    const buf = Buffer.alloc(1 + 4 + 4 + items.length * 12);
    let off = 0;
    buf[off++] = 0x40;
    buf.writeInt32LE(listId, off); off += 4;
    buf.writeInt32LE(items.length, off); off += 4;
    for (const it of items) {
      buf.writeInt32LE(it.itemId, off); off += 4;
      buf.writeInt32LE(it.count & 0xFFFFFFFF, off); off += 4;
      buf.writeInt32LE(0, off); off += 4; // high 32 bits of count
    }
    this._send(buf);
  }

  sellItems(listId, items) {
    // RequestSellItem: listId(4) count(4) [objectId(4) itemId(4) count(8L)]×n
    const buf = Buffer.alloc(1 + 4 + 4 + items.length * 16);
    let off = 0;
    buf[off++] = 0x37;
    buf.writeInt32LE(listId, off); off += 4;
    buf.writeInt32LE(items.length, off); off += 4;
    for (const it of items) {
      buf.writeInt32LE(it.objectId, off); off += 4;
      buf.writeInt32LE(it.itemId,   off); off += 4;
      buf.writeInt32LE(it.count & 0xFFFFFFFF, off); off += 4;
      buf.writeInt32LE(0, off); off += 4;
    }
    this._send(buf);
  }
}

module.exports = { GameClient };
