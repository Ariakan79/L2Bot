'use strict';

const EventEmitter = require('events');
const { findPath } = require('../geo/geodata');
const { getWeaponRange } = require('../data/weaponRange');
const { getSkillRange }  = require('../data/skillRange');

const STATE = {
  IDLE: 'IDLE',
  FARMING: 'FARMING',
  COMBAT: 'COMBAT',
  LOOTING: 'LOOTING',
  HEALING: 'HEALING',
  SUPPORT: 'SUPPORT',
};

class Bot extends EventEmitter {
  constructor(gameClient) {
    super();
    this.gc = gameClient;
    this.state = STATE.IDLE;
    this.config = {
      autoFarm: false,
      autoHeal: true,
      healHpPct: 40,
      healSkillId: 0,
      attackSkills: [],         // [skillId, ...] rotated each attack tick; empty = auto-attack
      fightBack: true,          // re-pick target on unexpected HP drop
      farmRadius: 600,           // detection radius: how far to look for mobs
      attackRange: 150,         // engage range: how close before actually attacking (melee ≈ 150)
      farmZone: null,            // { x1, y1, x2, y2 } world coords rectangle, null = use farmRadius
      autoPickup: true,
      pickupRange: 300,
      shotsEnabled: false,      // enable auto soulshot/spiritshot
      shotItemId: null,         // itemId of soulshot or spiritshot
      mode: 'FARM',             // 'FARM' | 'SUPPORT'
      supportTargetId: null,
      followDist: 80,
      healTargetHpPct: 60,
      healSelfHpPct: 30,
      selfBuffs: [],            // [ { skillId, label, intervalMs } ] — cast on self
      partyBuffs: [],           // [ { skillId, label, intervalMs } ] — default buffs for all party members
      partyMemberBuffs: {},     // { charName: [{skillId,label,intervalMs}] } — per-member override; '__self__' = own char
      autoRespawn: true,        // respawn automatically after death
      autoRespawnDelay: 3000,   // ms to wait before respawning
      respawnType: 0,           // 0=village(default) 1=clanHall 2=castle 3=fortress 4=siegeHQ 5=fixed
      autoAcceptParty: false,   // auto-accept party invitations
      followTargetId: null,     // objectId of party member to follow (independent of support mode)
      assistTargetId: null,     // objectId of party member to assist (attack their target when idle)
      farmMinMpPct: 0,          // FARM: don't pick new targets when MP% < this (0 = disabled)
      farmMinHpPct: 0,          // FARM: don't pick new targets when HP% < this (0 = disabled)
      skillMinMpPct: 0,         // all modes: skip skill cast when MP% < this, fall back to auto-attack (0 = disabled)
      skillMinHpPct: 0,         // all modes: skip skill cast when HP% < this, fall back to auto-attack (0 = disabled)
      autoSpoil: false,         // Dwarf: auto-cast Spoil before attack, then Sweeper on kill
      spoilSkillId: 0,          // skillId of Spoil
      sweeperSkillId: 0,        // skillId of Sweeper/Plunder
      healRules: [],            // [{maxHpPct,skillId}] tiered heal; replaces healSkillId/healHpPct when non-empty
      groupHealSkillId: 0,      // cast on self when ≥2 party members below groupHealHpPct
      groupHealHpPct: 80,
      groupBattleHealSkillId: 0,// cast on self when ≥2 party members below groupBattleHealHpPct
      groupBattleHealHpPct: 40,
      autoAcceptRes: true,      // auto-accept incoming resurrection dialog
      resSkillId: 0,            // skill ID used to resurrect dead party members (e.g. 1016)
      resItemId: 0,             // item template ID of resurrection scroll (fallback when no skill)
      debug: false,             // print verbose combat timing to console
    };

    this._nearbyNpcs = new Map();
    this._nearbyPlayers = new Map();
    this._floorItems = new Map();     // objectId → { objectId, itemId, x, y, z, count }
    this._attackPollInterval = null;  // setInterval — auto-attack 5s heartbeat
    this._attackTimeout     = null;   // setTimeout  — skill-based next-cast scheduling
    this._selfBuffTimer = null;
    this._buffPending = null;   // { skillId, timer } — blocks next buff until cast completes
    this._supportTimer = null;
    this._attackSkillIdx = 0;
    this._onceSkillsUsed = new Set(); // skillIds used once on current target (cleared on new target)
    this._spoiledNpcs = new Set();    // objectIds of NPCs that have been Spoiled
    this._castingSkillId = null;  // skillId sent to server, cleared on skillCastStart/Canceled/_stopAttack
    this._castConfirmed  = false; // true between skillCastStart and next _doAttack/cancel/_stop
    this._actionFailedCount = 0;  // consecutive failures on current target; resets on confirmed cast
    this._selfBuffLastCast = {};    // skillId → timestamp
    this._partyBuffLastCast = {};   // skillId → timestamp
    this._target = null;
    this._stats = { kills: 0, dmgDealt: 0, dmgTaken: 0, itemsLooted: 0, expGained: 0, spGained: 0 };
    this._lastPlayerHp = null;
    this._lastPlayerCp = null;
    this._lastExp = null;
    this._lastSp  = null;
    // Stuck detection
    this._stuckTimer = null;
    this._stuckSnapshot = null;
    this._waypointTimer = null;
    this._lastMoveToAt = 0;   // debounce timestamp for _moveToTarget
    this._spoilFailCount = 0; // consecutive ActionFailed on Spoil for current target
    this._lastWeaponItemId = null; // track weapon changes to auto-update attackRange
    this._deadNpcIds   = new Set(); // objectIds of mobs that died but haven't despawned yet
    // Loot tracking — sequential queue (one pickup at a time)
    this._lootQueue   = [];          // items waiting to be picked up, in order
    this._lootPending = new Set();   // objectId of the currently active pickup (max 1 at a time)
    this._lootFallback = null;       // safety timeout if server never sends DeleteObject
    this._lootRetries = new Map();   // objectId → attempt count, to give up on stuck items
    this._assistCurrentNpcId = null;    // NPC currently being attacked by the assist target
    this._assistAttacking = false;      // true while skill-loop is running for assist target in SUPPORT mode
    this._partyMemberEffects = new Map();  // objectId → effects[] (from PartySpelled 0xF4)
    this._partyBuffMemberCursor = 0;       // round-robin index into party.values()
    this._lastCombatActivityAt = 0;        // last time dmg was dealt or received in COMBAT
    this._deadNpcTimers = new Map();       // objectId → timerId for _deadNpcIds auto-expire
    this._lastResurrect = {};              // objectId → timestamp of last resurrection attempt
    this._respawnTimer = null;
    this._sweeperTimer = null;
    this._sweepPending = false;
    this._jitterTimer  = null;
    this._healResumeTimer = null;
    this._zoneCenterTimer = null;
    // Self-buff timer — always-on, independent of bot state or mode.
    // Also re-fires _pickTarget every second when FARMING with no target: covers the case
    // where the player is stationary and at full HP/MP (no StatusUpdate events arrive),
    // so npcAppear/playerStats alone might never re-trigger target selection.
    this._selfBuffTimer = setInterval(() => {
      this._doSelfBuffs();
      if (this.state === STATE.FARMING && !this._target) {
        this._pickTarget();
        // Still no target: if a farm zone is defined, walk back to its center
        if (!this._target && this.config.farmZone && !this.gc.isMoving) {
          this._returnToZoneCenter();
        }
      }
    }, 1000);
    // Follow timer (independent of autoFarm)
    this._followTimer = setInterval(() => this._followTick(), 1000);
    // Combat stall watchdog — aborts frozen COMBAT after 2min with no damage dealt/received
    this._combatStallTimer = setInterval(() => this._checkCombatStall(), 10000);

    this._bindEvents();
  }

  // ═══════════════════════════════════════════════════════════
  // SETUP & EVENTS
  // ═══════════════════════════════════════════════════════════

  _bindEvents() {
    this.gc.on('playerStats',        p          => this._onPlayerStats(p));
    this.gc.on('playerInfo',         info       => this._onPlayerInfo(info));
    this.gc.on('playerMove',         ()         => this.emit('status', this._status()));

    this.gc.on('teleport', () => {
      // Player is leaving the current zone. Clear all local entity caches immediately so
      // incoming NpcInfo/CharInfo for the new zone don't collide with stale old-zone data.
      this._nearbyNpcs.clear();
      this._nearbyPlayers.clear();
      this._floorItems.clear();
      this._deadNpcIds.clear();
      this._lootRetries.clear();
      this._emitNpcs();
      this.emit('floorItems', []);
    });

    this.gc.on('validateLocation',   args       => this._onValidateLocation(args));
    this.gc.on('playerDied',         opts       => this._onPlayerDied(opts));

    this.gc.on('partyInvite', info => {
      this.emit('partyInvite', info);
      if (this.config.autoAcceptParty) {
        this._log('Party-Einladung von ' + info.requesterName + ' automatisch angenommen');
        this.gc.answerJoinParty(true);
      } else {
        this._log('Party-Einladung von ' + info.requesterName + ' (autoAccept aus)');
      }
    });

    this.gc.on('confirmDlg', ({ messageId, requesterId }) => {
      if (this.config.autoAcceptRes && messageId === 1510) {
        this.gc.sendDlgAnswer(messageId, 1, requesterId);
        this._log('Resurrection angenommen');
      }
    });

    this.gc.on('partyUpdate', members => {
      // Remove buff snapshots for members who left the party
      const activeIds = new Set(members.map(m => m.objectId));
      for (const id of this._partyMemberEffects.keys()) {
        if (!activeIds.has(id)) this._partyMemberEffects.delete(id);
      }
      // Remove per-member timestamps for departed members to prevent unbounded growth
      for (const perMember of Object.values(this._partyBuffLastCast)) {
        for (const id of Object.keys(perMember)) {
          if (!activeIds.has(Number(id))) delete perMember[id];
        }
      }
      this.emit('partyUpdate', members);
    });

    this.gc.on('npcAppear', npc => {
      // Ignore server re-broadcasts of a corpse's NpcInfo (triggered by nearby social NPCs moving).
      if (this._deadNpcIds.has(npc.objectId)) return;
      this._nearbyNpcs.set(npc.objectId, npc);
      this._emitNpcs();
      if (this.state === STATE.FARMING && npc.attackable) this._pickTarget();
    });

    this.gc.on('objectDisappear',    id         => this._onObjectDisappear(id));
    this.gc.on('actionFailed',       ()         => this._onActionFailed());
    this.gc.on('playerAppear',       p          => { this._nearbyPlayers.set(p.objectId, p); this.emit('playerAppear', p); });
    this.gc.on('objectMove',         upd        => this._onObjectMove(upd));
    this.gc.on('combatAttack',       args       => this._onCombatAttack(args));
    this.gc.on('targetSelected',     args       => this._onTargetSelected(args));
    this.gc.on('partyPositionUpdate',members    => this.emit('partyPositionUpdate', members));
    this.gc.on('partyMemberUpdate',  upd        => this.emit('partyMemberUpdate', upd));
    this.gc.on('partyMemberEffects', ({ objectId, effects }) => this._partyMemberEffects.set(objectId, effects));

    this.gc.on('playerRelation', upd => {
      const pl = this._nearbyPlayers.get(upd.objectId);
      if (pl) {
        pl.pvpFlag = upd.pvpFlag;
        pl.karma = upd.karma;
        this.emit('playerAppear', pl);
      }
    });

    this.gc.on('nearbyHpUpdate',     upd        => this._onNearbyHpUpdate(upd));
    this.gc.on('skillCastStart',     args       => this._onSkillCastStart(args));
    this.gc.on('skillCastCanceled',  args       => this._onSkillCastCanceled(args));
    this.gc.on('itemSpawn',          item       => this._onItemSpawn(item));
    this.gc.on('die',                (id, sw)   => this._onDie(id, sw));
    this.gc.on('sweepInfo',          args       => this._onSweepInfo(args));

    this.gc.on('getItem', ({ itemId, count }) => {
      this._stats.itemsLooted++;
      this.emit('statEvent', { event: 'item', itemId, count: count || 1 });
      this._log('Auto-Loot: Item #' + itemId + (count > 1 ? ' ×' + count : ''));
    });
  }

  // ═══════════════════════════════════════════════════════════
  // EVENT HANDLERS
  // ═══════════════════════════════════════════════════════════

  _onPlayerStats(p) {
    // Compute drops BEFORE storing new values. CP absorbs damage first; HP drops only after CP=0.
    // Combining both gives the true damage received per StatusUpdate.
    const hpDrop = (this._lastPlayerHp !== null && p.hp !== undefined)
      ? this._lastPlayerHp - p.hp : 0;
    const cpDrop = (this._lastPlayerCp !== null && p.cp !== undefined)
      ? this._lastPlayerCp - p.cp : 0;
    const totalDrop = (hpDrop > 0 ? hpDrop : 0) + (cpDrop > 0 ? cpDrop : 0);

    if (totalDrop > 0) {
      this._stats.dmgTaken += Math.round(totalDrop);
      const attacker = this._target
        ? (this._target.name || String(this._target.npcTypeId - 1000000))
        : null;
      this.emit('statEvent', { event: 'dmgTaken', value: Math.round(totalDrop), attacker });
      this._lastCombatActivityAt = Date.now();
    }
    if (p.hp !== undefined) this._lastPlayerHp = p.hp;
    if (p.cp !== undefined) this._lastPlayerCp = p.cp;

    this.emit('status', this._status());
    if (this.config.mode === 'FARM') {
      if (this.config.autoHeal && this.state !== STATE.HEALING) {
        const hpPct = p.maxHp > 0 ? (p.hp / p.maxHp) * 100 : 100;
        if (hpPct < this._healTriggerPct()) this._doHeal();
      }
      // Resume farming when MP/HP recovers above farmMin thresholds (regen while waiting).
      if (this.state === STATE.FARMING && !this._target) this._pickTarget();
      // FightBack: react to any damage (HP or CP) while idle/looting.
      // Uses totalDrop so CP-absorbed hits also trigger engagement.
      // This is a fallback for when the attacker wasn't in the NPC map yet
      // when the combatAttack packet arrived.
      if (this.config.fightBack && totalDrop > 5 && !this._target &&
          (this.state === STATE.IDLE || this.state === STATE.LOOTING || this.state === STATE.FARMING)) {
        this._log('FightBack: Schaden erhalten während ' + this.state);
        this._pickTarget(true); // ignoreZone: attacker may be outside farmZone
      }
    }
  }

  _onPlayerInfo(info) {
    const p = this.gc.player;
    if (p) {
      // Seed damage baseline from UserInfo so the very first combat hit is tracked correctly.
      // Also re-sync after teleport/respawn so the post-heal HP is used as the new baseline.
      if (p.hp !== undefined && (this._lastPlayerHp === null || (info && info.teleported))) {
        this._lastPlayerHp = p.hp;
      }
      if (p.cp !== undefined && (this._lastPlayerCp === null || (info && info.teleported))) {
        this._lastPlayerCp = p.cp;
      }
      // L2 server resets auto-shot registration on UserInfo (teleport/respawn/world-entry).
      if (this.config.autoFarm && this.config.shotsEnabled && this.config.shotItemId)
        this.gc.autoSoulShot(this.config.shotItemId, true);
      if (p.exp !== undefined && this._lastExp !== null && p.exp > this._lastExp) {
        const gain = Math.round(p.exp - this._lastExp);
        this._stats.expGained += gain;
        this.emit('statEvent', { event: 'exp', value: gain });
      }
      if (p.exp !== undefined) this._lastExp = p.exp;
      if (p.sp !== undefined && this._lastSp !== null && p.sp > this._lastSp) {
        const gain = p.sp - this._lastSp;
        this._stats.spGained += gain;
        this.emit('statEvent', { event: 'sp', value: gain });
      }
      if (p.sp !== undefined) this._lastSp = p.sp;
      if (p.weaponItemId !== undefined && p.weaponItemId !== this._lastWeaponItemId) {
        this._lastWeaponItemId = p.weaponItemId;
        if (this.config.attackSkills.length === 0) {
          // Auto-attack: derive engage range from weapon's physical reach.
          // For skills the user configures attackRange directly (skill range >> melee range).
          const pRange = getWeaponRange(p.weaponItemId);
          this.config.attackRange = pRange + 40;
          this._log('Waffe #' + p.weaponItemId + ' → pAtkRange=' + pRange + ' attackRange=' + this.config.attackRange);
        }
      }
    }
    this.emit('status', this._status());
    if (info && info.teleported) {
      // NpcInfo for the new zone can arrive before UserInfo. The UI clears its entity maps on
      // teleported=true, so re-broadcast whatever the bot currently has so the map isn't left empty.
      this._deadNpcIds.clear();
      this._emitNpcs();
      this.emit('floorItems', [...this._floorItems.values()]);
    }
  }

  _onValidateLocation({ x, y, z }) {
    if (this.state === STATE.COMBAT && this._target) {
      const dist = Math.hypot(this._target.x - x, this._target.y - y);
      if (dist > this.config.farmRadius) {
        this._log('Positions-Korrektur – Ziel unerreichbar, zurück zu FARMING');
        this._target = null;
        this._stopAttack();
        this._cancelWaypoints();
        this.state = STATE.FARMING;
        this.emit('status', this._status());
        this._pickTarget();
      }
    }
  }

  _onPlayerDied(opts) {
    this._stopAttack();
    this._cancelWaypoints();
    this._target = null;
    this.state = STATE.IDLE;
    this.emit('status', this._status());
    this.emit('playerDied', opts);
    if (this.config.autoRespawn) {
      this._log('Gestorben – Respawn in ' + this.config.autoRespawnDelay + 'ms');
      if (this._respawnTimer) clearTimeout(this._respawnTimer);
      this._respawnTimer = setTimeout(() => {
        this._respawnTimer = null;
        this.gc.requestRestartPoint(this.config.respawnType);
      }, this.config.autoRespawnDelay);
    }
  }

  _onObjectDisappear(id) {
    this._deadNpcIds.delete(id);
    this._spoiledNpcs.delete(id);
    if (id === this._assistCurrentNpcId) {
      this._assistCurrentNpcId = null;
      if (this._assistAttacking) { this._target = null; this._stopAttack(); this._attackSkillIdx = 0; }
    }
    if (this._nearbyNpcs.has(id)) {
      this._nearbyNpcs.delete(id);
      this._emitNpcs();
      // Safety: if this object was our target (e.g. die packet missed, or rare re-target race),
      // clean up so the bot doesn't stay stuck in COMBAT with a ghost target.
      if (this._target && this._target.objectId === id) {
        this._target = null;
        this._stopAttack();
        this._cancelWaypoints();
        if (this.state === STATE.COMBAT) {
          // die packet was missed — do the LOOTING transition now as fallback
          this.state = STATE.LOOTING;
          this._lootPending.clear();
          this.emit('status', this._status());
          if (!this.config.autoPickup) {
            this._resumeFromLoot();
          } else {
            this._lootQueue = [...this._floorItems.values()];
            if (this._lootQueue.length === 0) {
              this._resetLootFallback(200);
            } else {
              this._pickNextFromQueue();
            }
          }
        }
      }
    }

    if (this._nearbyPlayers.has(id)) {
      this._nearbyPlayers.delete(id);
      this.emit('playerDisappear', id);
    }

    if (this._floorItems.has(id)) {
      const it = this._floorItems.get(id);
      this._stats.itemsLooted++;
      this.emit('statEvent', { event: 'item', itemId: it.itemId, count: it.count || 1 });
      this._floorItems.delete(id);
      this._lootPending.delete(id);
      this._lootRetries.delete(id);
      this.emit('floorItems', [...this._floorItems.values()]);
      if (this.state === STATE.LOOTING && this._lootPending.size === 0) {
        this._pickNextFromQueue();
      }
    }
  }

  _onActionFailed() {
    // Spoil ActionFailed: retry up to 4 times (covers movement race + brief cooldown overlap)
    // before giving up and proceeding to attack without Spoil on this mob.
    if (this.config.autoSpoil && this.config.spoilSkillId &&
        this._castingSkillId === this.config.spoilSkillId && this._target && !this._castConfirmed) {
      this._spoilFailCount++;
      this._castingSkillId = null;
      if (this._spoilFailCount >= 4) {
        this._log('Spoil nach ' + this._spoilFailCount + ' Fehlern übersprungen für Mob #' + this._target.objectId);
        this._spoiledNpcs.add(this._target.objectId);
        this._spoilFailCount = 0;
        this._scheduleNextAttack(500);
      } else {
        this._dbg('Spoil ActionFailed #' + this._spoilFailCount + ' → retry 800ms');
        this._scheduleNextAttack(800);
      }
      return;
    }
    if (this.config.attackSkills.length > 0) {
      if (this._isAttacking() && this._target) {
        // Ignore queued ActionFailed that arrived after a cast was already confirmed by skillCastStart.
        // These are stale responses from earlier useSkill spam that the server is draining.
        if (this._castConfirmed) {
          this._dbg('ActionFailed ignoriert (Cast bereits bestätigt)');
          return;
        }
        this._actionFailedCount++;
        this._dbg('ActionFailed (Skill) #' + this._actionFailedCount + ' → retry 1.5s');

        // Too many consecutive failures → target is unreachable (dead, despawned, permanent desync).
        if (this._actionFailedCount >= 15) {
          this._log('Ziel ' + this._target.objectId + ' nach 15 Fehlern aufgegeben');
          this._nearbyNpcs.delete(this._target.objectId);
          this._target = null;
          this._assistCurrentNpcId = null;
          this._stopAttack();
          this._cancelWaypoints();
          if (this.state === STATE.COMBAT) {
            this.state = STATE.FARMING;
            this.emit('status', this._status());
            this._pickTarget();
          }
          return;
        }
        // If mob moved out of attack range, move immediately on every failure.
        // Otherwise (in-range failure = desync), nudge every 3rd failure.
        const fp = this.gc.player;
        const failDist = fp && this._target ? Math.hypot(this._target.x - fp.x, this._target.y - fp.y) : 0;
        if (failDist > this.config.attackRange) {
          this._dbg('ActionFailed: außer Reichweite (' + Math.round(failDist) + ') → bewegen');
          this.gc.selectTarget(this._target.objectId);
          this._moveToTarget();
        } else if (this._actionFailedCount % 3 === 0) {
          this._dbg('ActionFailed #' + this._actionFailedCount + ' → Positions-Desync? bewegen');
          this.gc.selectTarget(this._target.objectId);
          this._moveToTarget();
        }
        this._scheduleNextAttack(1500);
      }
      return;
    }
    // Auto-attack: ActionFailed usually means out of range.
    if (this.state === STATE.COMBAT && this._target) {
      const p = this.gc.player;
      const dist = p ? Math.hypot(this._target.x - p.x, this._target.y - p.y) : Infinity;
      this._dbg('ActionFailed (Auto-Attack) dist=' + Math.round(dist) + ' range=' + this.config.attackRange);
      if (dist > this.config.attackRange) this._moveToTarget();
    }
  }

  _onObjectMove(upd) {
    const pl = this._nearbyPlayers.get(upd.objectId);
    if (pl) {
      // Use destination when available — gives follow a head-start towards where the char is going.
      const tx = upd.toX !== undefined ? upd.toX : upd.x;
      const ty = upd.toY !== undefined ? upd.toY : upd.y;
      const tz = upd.toZ !== undefined ? upd.toZ : (upd.z !== undefined ? upd.z : pl.z);
      pl.x = tx; pl.y = ty; pl.z = tz;
      // React immediately when our follow target moves rather than waiting up to 1s for the tick.
      if (upd.objectId === this.config.followTargetId) this._followTick();
    }
    const npc = this._nearbyNpcs.get(upd.objectId);
    if (npc) {
      npc.x = upd.toX !== undefined ? upd.toX : upd.x;
      npc.y = upd.toY !== undefined ? upd.toY : upd.y;
      npc.z = upd.toZ !== undefined ? upd.toZ : (upd.z !== undefined ? upd.z : npc.z);
    }
  }

  _onCombatAttack({ attackerObjectId, targetObjectId }) {
    const player = this.gc.player;

    // Proactive FightBack: react on the attack packet, before the damage StatusUpdate arrives.
    // This targets the specific attacker and fires one RTT earlier than the hpDrop fallback.
    if (this.config.fightBack && this.config.autoFarm && this.config.mode === 'FARM' &&
        player && targetObjectId === player.objectId && !this._target &&
        (this.state === STATE.IDLE || this.state === STATE.LOOTING || this.state === STATE.FARMING)) {
      const attacker = this._nearbyNpcs.get(attackerObjectId);
      if (attacker && attacker.attackable) {
        this._log('FightBack: Angriff von ' + (attacker.name || attackerObjectId));
        if (this._lootFallback) { clearTimeout(this._lootFallback); this._lootFallback = null; }
        this._lootQueue = [];
        this._lootPending.clear();
        this._target = attacker;
        this.state = STATE.COMBAT;
        this.emit('status', this._status());
        this.gc.selectTarget(attacker.objectId);
        const dist = Math.hypot(attacker.x - player.x, attacker.y - player.y);
        if (dist > this.config.attackRange) this._moveToTarget();
        this._startAttack();
        return; // prevent assist check below from also firing
      }
      // Attacker not yet in NPC map — hpDrop-based fallback in playerStats will handle it
    }

    // Party-FightBack: if a party member is attacked, defend them.
    if (this.config.fightBack && this.config.autoFarm && this.config.mode === 'FARM' &&
        player && !this._target &&
        (this.state === STATE.IDLE || this.state === STATE.FARMING || this.state === STATE.LOOTING)) {
      const party = this.gc.party;
      if (party && party.has(targetObjectId)) {
        const attacker = this._nearbyNpcs.get(attackerObjectId);
        if (attacker && attacker.attackable) {
          const memberName = (party.get(targetObjectId) || {}).name || targetObjectId;
          this._log('Party-FightBack: ' + (attacker.name || attackerObjectId) + ' greift ' + memberName + ' an');
          if (this._lootFallback) { clearTimeout(this._lootFallback); this._lootFallback = null; }
          this._lootQueue = [];
          this._lootPending.clear();
          this._target = attacker;
          this.state = STATE.COMBAT;
          this.emit('status', this._status());
          this.gc.selectTarget(attacker.objectId);
          const dist = Math.hypot(attacker.x - player.x, attacker.y - player.y);
          if (dist > this.config.attackRange) this._moveToTarget();
          this._startAttack();
          return;
        }
      }
    }

    // Assist: track what the assist target is currently attacking.
    // In FARM mode → enter combat immediately.
    // In SUPPORT mode → stored in _assistCurrentNpcId; _supportTick() attacks as lowest priority.
    if (!this.config.assistTargetId) return;
    if (attackerObjectId !== this.config.assistTargetId) return;
    const assistNpc = this._nearbyNpcs.get(targetObjectId);
    if (!assistNpc || !assistNpc.attackable) return;
    if (this.config.mode === 'SUPPORT') {
      this._assistCurrentNpcId = targetObjectId;
    } else if (this.state === STATE.IDLE || this.state === STATE.FARMING) {
      this._target = assistNpc;
      this.state = STATE.COMBAT;
      this.gc.selectTarget(assistNpc.objectId);
      this._startAttack();
    }
  }

  // Assist pre-select: when the assist target selects an NPC, react immediately
  // (fires ~1 RTT earlier than combatAttack).
  _onTargetSelected({ objectId, targetObjId }) {
    if (!this.config.assistTargetId || objectId !== this.config.assistTargetId) return;
    if (!targetObjId) return;
    const npc = this._nearbyNpcs.get(targetObjId);
    if (!npc || !npc.attackable) return;
    if (this.config.mode === 'SUPPORT') {
      // Set the assist target and run the tick immediately (respects heal/buff priority).
      if (this._assistCurrentNpcId !== targetObjId) {
        this._assistCurrentNpcId = targetObjId;
        this._supportTick();
      }
    } else if (this.state === STATE.IDLE || this.state === STATE.FARMING) {
      if (this._target && this._target.objectId === targetObjId) return;
      this._target = npc;
      this.state = STATE.COMBAT;
      this.gc.selectTarget(npc.objectId);
      this._startAttack();
    }
  }

  _onNearbyHpUpdate(upd) {
    const npc = this._nearbyNpcs.get(upd.objectId);
    if (npc) {
      // Track damage dealt to current target.
      if (this._target && upd.objectId === this._target.objectId && upd.hp !== undefined) {
        let dmg = 0;
        if (npc.hp !== undefined) {
          // Normal case: we already have an HP baseline from a previous update.
          dmg = Math.round(npc.hp - upd.hp);
        } else if (upd.maxHp !== undefined) {
          // First StatusUpdate for this NPC — maxHp arrived together with current HP.
          // Use maxHp as the pre-combat baseline so the first hit is not lost.
          dmg = Math.round(upd.maxHp - upd.hp);
        }
        if (dmg > 0) {
          this._stats.dmgDealt += dmg;
          this.emit('statEvent', { event: 'dmgDealt', value: dmg, target: npc.name || String(npc.npcTypeId - 1000000) });
          this._lastCombatActivityAt = Date.now();
        }
      }
      if (upd.hp !== undefined) npc.hp = upd.hp;
      if (upd.maxHp !== undefined) npc.maxHp = upd.maxHp;
      this.emit('npcHpUpdate', { objectId: upd.objectId, hp: npc.hp, maxHp: npc.maxHp });
    }
    const pl = this._nearbyPlayers.get(upd.objectId);
    if (pl) {
      if (upd.hp !== undefined) pl.hp = upd.hp;
      if (upd.maxHp !== undefined) pl.maxHp = upd.maxHp;
      this.emit('playerAppear', pl);
    }
  }

  _onSkillCastStart({ casterObjectId, skillId, hitTime, reuseDelay }) {
    const player = this.gc.player;
    if (!player || casterObjectId !== player.objectId) return;

    // Buff timing: server confirmed a buff cast — replace safety timeout with accurate hitTime
    if (this._buffPending && this._buffPending.skillId === skillId) {
      clearTimeout(this._buffPending.timer);
      this._buffPending.timer = setTimeout(() => { this._buffPending = null; }, hitTime + 300);
      return;
    }

    // Spoil confirmation: mark target as spoiled and proceed to attack rotation
    if (this.config.autoSpoil && this.config.spoilSkillId && skillId === this.config.spoilSkillId) {
      if (this._target) {
        this._spoiledNpcs.add(this._target.objectId);
        this._log('Spoil erfolgreich auf ' + (this._target.name || 'Mob #' + this._target.objectId) + ' – warte auf Angriff');
      }
      this._castingSkillId = null;
      this._castConfirmed = true;
      this._actionFailedCount = 0;
      this._spoilFailCount = 0;
      // No reuse wait needed — we won't cast Spoil again on this mob; attack right after cast ends
      this._dbg('skillCastStart Spoil#' + skillId + ' bestätigt → Angriff in ' + (hitTime + 100) + 'ms');
      this._scheduleNextAttack(hitTime + 100);
      return;
    }

    if (!this._isAttacking() || this.config.attackSkills.length === 0) return;

    // Ignore skills that are NOT in our attack rotation (buffs, racials, auto-casts, etc.).
    // If we let those update attackRange or reschedule the combat timer, a racial ability with
    // castRange=40 will overwrite our ranged spell's 600+ WU range and break approach logic.
    if (!this.config.attackSkills.includes(skillId)) {
      this._dbg('skillCastStart ignoriert (kein Attack-Skill): ' + skillId);
      return;
    }

    const castRange = getSkillRange(skillId);
    if (this.config.attackRange !== castRange) {
      this.config.attackRange = castRange;
      this._log('Skill #' + skillId + ' → castRange=' + castRange);
    }
    // Cast confirmed — advance rotation, mark active, reset failure counter.
    this._castingSkillId = null;
    this._castConfirmed  = true;
    this._actionFailedCount = 0;
    this._attackSkillIdx = (this._attackSkillIdx + 1) % this.config.attackSkills.length;
    if ((this.config.attackSkillModes || {})[skillId] === 'once') this._onceSkillsUsed.add(skillId);
    const nextIn = hitTime + Math.max(reuseDelay, 500) + 100;
    this._dbg('skillCastStart skill=' + skillId + ' hitTime=' + hitTime + ' reuse=' + reuseDelay + ' → next in ' + nextIn + 'ms');
    this._scheduleNextAttack(nextIn);
  }

  _onSkillCastCanceled({ casterObjectId }) {
    const player = this.gc.player;
    if (!player || casterObjectId !== player.objectId) return;
    if (!this._isAttacking() || this.config.attackSkills.length === 0) return;
    if (this._castConfirmed) {
      // Cast was interrupted mid-flight (stun, movement, etc.) after skillCastStart confirmed it.
      this._dbg('skillCastCanceled (mid-cast) → retry in 500ms');
      this._castConfirmed = false;
      this._castingSkillId = null;
      this._scheduleNextAttack(500);
      return;
    }
    // Cast was rejected before it started — only react if it was one of our attack skills.
    if (!this._castingSkillId) return;
    this._dbg('skillCastCanceled skill=' + this._castingSkillId + ' → retry in 500ms');
    this._castingSkillId = null;
    this._scheduleNextAttack(500);
  }

  _onItemSpawn(item) {
    this._floorItems.set(item.objectId, item);
    this.emit('floorItems', [...this._floorItems.values()]);

    // Herbs of life (8600-8615): always pick up, regardless of autoPickup flag or state
    const isHerb = item.itemId >= 8600 && item.itemId <= 8615;
    if (isHerb) {
      if (this.state === STATE.LOOTING) {
        // Slot into queue: if nothing active, start immediately; otherwise enqueue
        if (this._lootPending.size === 0 && this._lootQueue.length === 0) {
          this._lootPending.add(item.objectId);
          this._sendPickup(item);
          this._resetLootFallback(5000);
        } else {
          this._lootQueue.push(item);
        }
      } else {
        this._sendPickup(item);
      }
      return;
    }

    if (!this.config.autoPickup) return;
    if (this.state === STATE.LOOTING) {
      // Slot into queue: if nothing active, start immediately; otherwise enqueue
      if (this._lootPending.size === 0 && this._lootQueue.length === 0) {
        this._lootPending.add(item.objectId);
        this._sendPickup(item);
        this._resetLootFallback(5000);
      } else {
        this._lootQueue.push(item);
      }
    } else if (this.state !== STATE.COMBAT && this.state !== STATE.HEALING) {
      this._tryPickupItem(item);
    }
  }

  _onDie(id, isSweepable) {
    if (this.gc.player && id === this.gc.player.objectId) {
      this._log('Charakter gestorben – Bot gestoppt');
      this.stop();
      return;
    }
    // Remove from NPC map immediately so _pickTarget() can't select the corpse.
    // _deadNpcIds suppresses server re-broadcasts of the corpse's NpcInfo until DeleteObject.
    // Auto-expire after 10s: covers missed DeleteObject packets and ObjectId reuse by the server.
    // 10s > typical corpse decay (7-15s), so normal mobs despawn before the timer fires.
    this._deadNpcIds.add(id);
    const deadTimer = setTimeout(() => {
      this._deadNpcIds.delete(id);
      this._deadNpcTimers.delete(id);
    }, 10000);
    this._deadNpcTimers.set(id, deadTimer);
    if (id === this._assistCurrentNpcId) {
      if (this._assistAttacking) {
        const killName = this._target ? (this._target.name || String(this._target.npcTypeId - 1000000)) : String(id);
        const wasSpoiled = isSweepable || this._spoiledNpcs.has(id);
        if (this.config.autoSpoil && this.config.sweeperSkillId && wasSpoiled) {
          this._log('Sweep auf Mob #' + id + ' (SUPPORT – ' + (isSweepable ? 'Server' : 'eigenes Tracking') + ')');
          const sweepId = id;
          // Cancel the attack timer but keep _assistAttacking=true so _supportTick() doesn't
          // start attacking a new mob before Sweep is cast (targetSelected may fire immediately).
          if (this._attackTimeout) { clearTimeout(this._attackTimeout); this._attackTimeout = null; }
          if (this._attackPollInterval) { clearInterval(this._attackPollInterval); this._attackPollInterval = null; }
          if (this._sweeperTimer) clearTimeout(this._sweeperTimer);
          this._sweeperTimer = setTimeout(() => {
            this._sweeperTimer = null;
            this._log('Sweep gesendet → Mob #' + sweepId);
            this.gc.selectTarget(sweepId);
            this.gc.useSkill(this.config.sweeperSkillId);
            // Now release the attack loop so the next assist target can be engaged
            this._target = null;
            this._stopAttack();
            this._attackSkillIdx = 0;
          }, 300);
        } else {
          this._target = null;
          this._stopAttack();
          this._attackSkillIdx = 0;
        }
        this._spoiledNpcs.delete(id);
        this._stats.kills++;
        this.emit('statEvent', { event: 'kill', target: killName });
      }
      this._assistCurrentNpcId = null;
    }
    if (this._nearbyNpcs.has(id)) {
      this._nearbyNpcs.delete(id);
      this._emitNpcs();
    }

    // Target mob died — enter LOOTING immediately (drops arrive in same TCP burst as Die)
    if (this.state === STATE.COMBAT && this._target && this._target.objectId === id) {
      this._stats.kills++;
      this.emit('statEvent', { event: 'kill', target: this._target.name || String(this._target.npcTypeId - 1000000) });
      // Auto-Spoil: sweep corpse if Spoil confirmed (isSweepable from packet OR own tracking).
      // Some server builds don't set isSweepable in the Die packet for NPCs — use _spoiledNpcs as fallback.
      const wasSpoiled = isSweepable || this._spoiledNpcs.has(id);
      const sweepScheduled = this.config.autoSpoil && this.config.sweeperSkillId && wasSpoiled;
      if (sweepScheduled) {
        this._log('Sweep auf Mob #' + id + (isSweepable ? ' (Server)' : ' (eigenes Tracking)'));
        this._sweepPending = true;
        const sweepId = id;
        if (this._sweeperTimer) clearTimeout(this._sweeperTimer);
        this._sweeperTimer = setTimeout(() => {
          this._sweeperTimer = null;
          this._log('Sweep gesendet → Mob #' + sweepId);
          this.gc.selectTarget(sweepId);
          this.gc.useSkill(this.config.sweeperSkillId);
          // Fallback if sweepInfo never arrives (e.g. out of range, ActionFailed)
          this._resetLootFallback(4000);
        }, 300);
      }
      this._spoiledNpcs.delete(id);
      this._target = null;
      this.gc.deselectTarget();
      this._stopAttack();
      this._cancelWaypoints();
      this.state = STATE.LOOTING;
      this._lootPending.clear();
      this.emit('status', this._status());
      if (sweepScheduled) {
        // Hold loot queue until sweepInfo arrives (or 4s fallback) — bot stays near corpse for Sweep
      } else if (!this.config.autoPickup) {
        this._resumeFromLoot();
      } else {
        // Drops may arrive in the same burst (after Die) or in the next read
        // itemSpawn handler takes over if _lootPending/queue is empty; 200ms fallback catches no-drops
        this._lootQueue = [...this._floorItems.values()];
        if (this._lootQueue.length === 0) {
          this._resetLootFallback(200);
        } else {
          this._pickNextFromQueue();
        }
      }
    }
  }

  _onSweepInfo({ npcObjectId, items }) {
    this._sweepPending = false;
    for (const it of items) {
      this._stats.itemsLooted++;
      this.emit('statEvent', { event: 'item', itemId: it.itemId, count: it.count || 1 });
      this._log('Sweep: Item #' + it.itemId + (it.count > 1 ? ' ×' + it.count : '') + ' (Mob #' + npcObjectId + ')');
    }
    if (items.length === 0) this._log('Sweep: kein Rohstoff (Spoil fehlgeschlagen oder Mob nicht spoilbar)');
    if (this.state === STATE.LOOTING) {
      if (this.config.autoPickup) {
        this._lootQueue = [...this._floorItems.values()];
        if (this._lootQueue.length === 0) {
          this._resumeFromLoot();
        } else {
          this._pickNextFromQueue();
        }
      } else {
        this._resumeFromLoot();
      }
    }
  }

  // ═══════════════════════════════════════════════════════════
  // STATE MACHINE
  // ═══════════════════════════════════════════════════════════

  start() {
    if (this.state !== STATE.IDLE) return;
    // Re-sync damage baselines so any healing that happened while stopped doesn't
    // create a negative delta on the first hit after restart.
    const gcp = this.gc.player;
    if (gcp) {
      if (gcp.hp !== undefined) this._lastPlayerHp = gcp.hp;
      if (gcp.cp !== undefined) this._lastPlayerCp = gcp.cp;
    }
    this.config.autoFarm = true;
    if (this.config.shotsEnabled && this.config.shotItemId) {
      this.gc.autoSoulShot(this.config.shotItemId, true);
      this._log('Shots aktiviert: itemId=' + this.config.shotItemId);
    }
    if (this.config.mode === 'SUPPORT') {
      this.state = STATE.SUPPORT;
      this._log('Support-Modus gestartet');
      this._startSupportTimer();
    } else {
      this.state = STATE.FARMING;
      this._log('Farming gestartet');
      this._startBuffTimer();
      this._pickTarget();
    }
    this.emit('status', this._status());
  }

  stop() {
    this.config.autoFarm = false;
    if (this.config.shotsEnabled && this.config.shotItemId) {
      this.gc.autoSoulShot(this.config.shotItemId, false);
    }
    this.state = STATE.IDLE;
    this._target = null;
    this._stopAttack();
    this._cancelWaypoints();
    if (this._supportTimer) { clearInterval(this._supportTimer); this._supportTimer = null; }
    if (this._lootFallback) { clearTimeout(this._lootFallback);  this._lootFallback = null; }
    if (this._respawnTimer)    { clearTimeout(this._respawnTimer);    this._respawnTimer    = null; }
    if (this._sweeperTimer)    { clearTimeout(this._sweeperTimer);    this._sweeperTimer    = null; }
    if (this._healResumeTimer) { clearTimeout(this._healResumeTimer); this._healResumeTimer = null; }
    if (this._zoneCenterTimer) { clearTimeout(this._zoneCenterTimer); this._zoneCenterTimer = null; }
    for (const t of this._deadNpcTimers.values()) clearTimeout(t);
    this._deadNpcTimers.clear();
    this._lootQueue   = [];
    this._lootPending.clear();
    this._lootRetries.clear();
    this._deadNpcIds.clear();
    this._spoiledNpcs.clear();
    this._sweepPending = false;
    this._lastMoveToAt = 0;
    this._spoilFailCount = 0;
    this._log('Bot gestoppt');
    this.emit('status', this._status());
  }

  // ═══════════════════════════════════════════════════════════
  // HEALING
  // ═══════════════════════════════════════════════════════════

  // Returns the appropriate heal skill ID for the given HP%, or 0 if no heal needed.
  // Uses tiered healRules when configured; falls back to single healSkillId/healHpPct.
  _selectHealSkill(hpPct) {
    const rules = this.config.healRules;
    if (rules && rules.length > 0) {
      const sorted = [...rules].sort((a, b) => a.maxHpPct - b.maxHpPct);
      for (const r of sorted) { if (hpPct <= r.maxHpPct) return r.skillId || 0; }
      return 0;
    }
    return hpPct < this.config.healHpPct ? (this.config.healSkillId || 0) : 0;
  }

  // HP% threshold at which self-heal is triggered (highest rule threshold, or single healHpPct).
  _healTriggerPct() {
    const rules = this.config.healRules;
    if (rules && rules.length > 0) return Math.max(...rules.map(r => r.maxHpPct));
    return this.config.healHpPct;
  }

  _doHeal() {
    const p = this.gc.player;
    if (!p) return;
    const hpPct = p.maxHp > 0 ? (p.hp / p.maxHp) * 100 : 100;
    const skillId = this._selectHealSkill(hpPct);
    if (!skillId) return;

    this.state = STATE.HEALING;
    this._stopAttack();
    this._cancelWaypoints();
    if (this._lootFallback) { clearTimeout(this._lootFallback); this._lootFallback = null; }
    this._lootQueue   = [];
    this._lootPending.clear();
    this._log('Heile! HP: ' + Math.round(hpPct) + '% → Skill #' + skillId);

    if (p.objectId) this.gc.selectTarget(p.objectId);
    this.gc.useSkill(skillId);
    if (this._healResumeTimer) clearTimeout(this._healResumeTimer);
    this._healResumeTimer = setTimeout(() => {
      this._healResumeTimer = null;
      if (this.state === STATE.HEALING && this.config.autoFarm) {
        this.state = STATE.FARMING;
        this._pickTarget();
      }
    }, 3000);
  }

  // ═══════════════════════════════════════════════════════════
  // TARGET SELECTION
  // ═══════════════════════════════════════════════════════════

  // Returns { npc, dist } for the nearest attackable NPC matching the given criteria, or null.
  _findNearestAttackableNpc({ useZone = true, filterDead = true, maxRadius = null } = {}) {
    const p = this.gc.player;
    if (!p) return null;
    const zone = useZone ? this.config.farmZone : null;
    const r = maxRadius !== null ? maxRadius : this.config.farmRadius;
    let nearest = null, nearestDist = Infinity;
    for (const npc of this._nearbyNpcs.values()) {
      if (!npc.attackable) continue;
      if (filterDead && this._deadNpcIds.has(npc.objectId)) continue;
      if (zone) {
        if (npc.x < zone.x1 || npc.x > zone.x2 || npc.y < zone.y1 || npc.y > zone.y2) continue;
      } else {
        if (Math.hypot(npc.x - p.x, npc.y - p.y) > r) continue;
      }
      const d = Math.hypot(npc.x - p.x, npc.y - p.y);
      if (d < nearestDist) { nearest = npc; nearestDist = d; }
    }
    return nearest ? { npc: nearest, dist: nearestDist } : null;
  }

  _pickTarget(ignoreZone = false) {
    if (!this.config.autoFarm) return;
    if (this._target) return;

    const p = this.gc.player;
    if (!p) return;

    if (this.config.farmMinMpPct > 0 && p.maxMp > 0 &&
        (p.mp / p.maxMp * 100) < this.config.farmMinMpPct) {
      this._dbg('_pickTarget: MP zu niedrig (' + Math.round(p.mp / p.maxMp * 100) + '% < ' + this.config.farmMinMpPct + '%) → warte');
      return;
    }
    if (this.config.farmMinHpPct > 0 && p.maxHp > 0 &&
        (p.hp / p.maxHp * 100) < this.config.farmMinHpPct) {
      this._dbg('_pickTarget: HP zu niedrig (' + Math.round(p.hp / p.maxHp * 100) + '% < ' + this.config.farmMinHpPct + '%) → warte');
      return;
    }

    const maxRadius = ignoreZone ? this.config.farmRadius * 2 : this.config.farmRadius;
    const found = this._findNearestAttackableNpc({ useZone: !ignoreZone, filterDead: true, maxRadius });
    if (!found) return;

    const { npc: nearest, dist: nearestDist } = found;
    // Cancel any pending loot activity before entering combat (no-op when not looting)
    if (this._lootFallback) { clearTimeout(this._lootFallback); this._lootFallback = null; }
    this._lootQueue = [];
    this._lootPending.clear();
    this._target = nearest;
    this._actionFailedCount = 0;
    this._spoilFailCount = 0;
    this._onceSkillsUsed.clear();
    this.state = STATE.COMBAT;
    this._lastCombatActivityAt = Date.now();
    this.emit('status', this._status());
    this._log('Angreife: ' + (nearest.name || nearest.objectId) + ' dist=' + Math.round(nearestDist));
    this.gc.selectTarget(nearest.objectId);
    if (nearestDist > this.config.attackRange) this._moveToTarget(); // start walking immediately, don't wait for attack reply
    this._startAttack();
  }

  // ═══════════════════════════════════════════════════════════
  // MOVEMENT
  // ═══════════════════════════════════════════════════════════

  // Move toward current target using geodata BFS pathfinding with stuck detection
  _moveToTarget() {
    const p = this.gc.player;
    if (!p || !this._target) return;
    const t = this._target;
    const dist = Math.hypot(t.x - p.x, t.y - p.y);
    if (dist < 30) return; // avoid jitter when literally on top of target

    // Debounce: if _pickTarget() already sent a moveTo and actionFailed fires within
    // 500ms, suppress the redundant second moveTo that causes a visible movement jerk.
    const now = Date.now();
    if (now - this._lastMoveToAt < 500) return;
    this._lastMoveToAt = now;

    this._cancelWaypoints();

    const path = findPath(p.x, p.y, p.z || 0, t.x, t.y, t.z || 0);
    if (path && path.length > 0) {
      this._followWaypoints(path);
    } else {
      this._moveToWithStuckDetect(t.x, t.y, t.z || 0);
    }
  }

  _followWaypoints(waypoints) {
    if (!waypoints.length || !this._target || !this.config.autoFarm) return;
    const [wp, ...rest] = waypoints;
    const p = this.gc.player;
    // Dynamic delay: estimate travel time at 260 WU/s (slightly conservative vs 280 WU/s actual)
    // so the next moveTo fires after we've actually arrived at this waypoint.
    const dist = p ? Math.hypot(wp.x - p.x, wp.y - p.y) : 350;
    const delay = Math.max(400, Math.round(dist / 260 * 1000) + 150);
    this._moveToWithStuckDetect(wp.x, wp.y, wp.z);
    if (rest.length) {
      this._waypointTimer = setTimeout(() => {
        if (this._target && this.config.autoFarm) this._followWaypoints(rest);
      }, delay);
    }
  }

  _cancelWaypoints() {
    if (this._waypointTimer) { clearTimeout(this._waypointTimer); this._waypointTimer = null; }
    if (this._stuckTimer)    { clearTimeout(this._stuckTimer);    this._stuckTimer = null; }
    if (this._jitterTimer)   { clearTimeout(this._jitterTimer);   this._jitterTimer = null; }
  }

  _moveToWithStuckDetect(x, y, z) {
    const p = this.gc.player || {};
    this.gc.moveTo(x, y, z);
    this._stuckSnapshot = { x: p.x || 0, y: p.y || 0 };
    if (this._stuckTimer) clearTimeout(this._stuckTimer);
    this._stuckTimer = setTimeout(() => {
      const cp = this.gc.player;
      if (!cp || !this.config.autoFarm) return;
      if (this.gc.isMoving) return; // DR still running — server is actively moving us
      if (Math.hypot(cp.x - this._stuckSnapshot.x, cp.y - this._stuckSnapshot.y) < 40) {
        this._log('Hängt! Ausweich-Schritt...');
        const ang = Math.random() * Math.PI * 2;
        this.gc.moveTo(
          Math.round(cp.x + Math.cos(ang) * 160),
          Math.round(cp.y + Math.sin(ang) * 160),
          cp.z || 0
        );
        // After jitter, try heading back toward target
        if (this._jitterTimer) clearTimeout(this._jitterTimer);
        this._jitterTimer = setTimeout(() => {
          this._jitterTimer = null;
          if (this._target && this.config.autoFarm) this._moveToTarget();
        }, 1800);
      }
    }, 2500);
  }

  _checkCombatStall() {
    if (this.state !== STATE.COMBAT || !this.config.autoFarm) return;
    if (Date.now() - this._lastCombatActivityAt < 50000) return;
    this._log('Combat-Stall: 50s ohne Schaden → Ziel aufgegeben, zurück zur Mitte');
    this._target = null;
    this._stopAttack();
    this._cancelWaypoints();
    this._lastCombatActivityAt = Date.now(); // prevent immediate re-trigger
    this.state = STATE.FARMING;
    this.emit('status', this._status());
    this._returnToZoneCenter();
  }

  _returnToZoneCenter() {
    const p = this.gc.player;
    const zone = this.config.farmZone;
    if (!zone) {
      this._pickTarget();
      return;
    }
    const cx = Math.round((zone.x1 + zone.x2) / 2);
    const cy = Math.round((zone.y1 + zone.y2) / 2);
    const dist = p ? Math.hypot(cx - p.x, cy - p.y) : 0;
    if (dist < 100) {
      this._pickTarget();
      return;
    }
    this._log('Laufe zur Zonenmitte (' + cx + ',' + cy + ')');
    this.gc.moveTo(cx, cy, p ? (p.z || 0) : 0);
    const travelMs = Math.max(2000, Math.round(dist / 260 * 1000) + 1000);
    if (this._zoneCenterTimer) clearTimeout(this._zoneCenterTimer);
    this._zoneCenterTimer = setTimeout(() => {
      this._zoneCenterTimer = null;
      if (this.state === STATE.FARMING && this.config.autoFarm && !this._target) {
        this._pickTarget();
      }
    }, travelMs);
  }

  // ═══════════════════════════════════════════════════════════
  // COMBAT
  // ═══════════════════════════════════════════════════════════

  _startAttack() {
    if (this._attackPollInterval || this._attackTimeout) { this._dbg('_startAttack: bereits aktiv, skip'); return; }
    this._dbg('_startAttack: skills=' + JSON.stringify(this.config.attackSkills));
    this._doAttack();
    if (this.config.attackSkills.length === 0 && !this._attackPollInterval) {
      // Auto-attack: server maintains the attack loop; re-assert every 5s for edge cases.
      // Guard avoids overwriting a Spoil timeout set inside _doAttack via _scheduleNextAttack.
      this._attackPollInterval = setInterval(() => {
        if (!this._target || !this._isAttacking()) { this._stopAttack(); return; }
        this._doAttack();
      }, 5000);
    }
    // Skills: next cast scheduled by skillCastStart (hitTime + reuseDelay).
    // Safety timeout set inside _doAttack() in case the packet is missed.
  }

  _doAttack() {
    if (!this._target) return;
    const p = this.gc.player;
    const dist = p ? Math.hypot(this._target.x - p.x, this._target.y - p.y) : 0;
    this._castConfirmed = false; // Reset for this new cast attempt

    if (this._doAttackSpoil(dist)) return;
    if (this.config.attackSkills.length > 0) {
      this._doAttackSkill(p, dist);
    } else {
      this._doAttackAuto(dist);
    }
  }

  // Handles the Spoil pre-attack branch. Returns true if Spoil is still pending (caller should return).
  _doAttackSpoil(dist) {
    if (!this.config.autoSpoil || !this.config.spoilSkillId) return false;
    if (this._spoiledNpcs.has(this._target.objectId)) return false;

    if (dist > this.config.attackRange) {
      this._dbg('_doAttack: Spoil – zu weit, bewegen');
      this._moveToTarget();
      this._scheduleNextAttack(1000);
      return true;
    }
    // Also wait if we just sent a moveTo — the MoveToLocation confirmation may not have arrived
    // yet so isMoving is still false, but the server would reject useSkill(spoil) with ActionFailed.
    const movedRecently = (Date.now() - this._lastMoveToAt) < 700;
    if (this.gc.isMoving || movedRecently) {
      this._dbg('_doAttack: Spoil – Bewegung' + (movedRecently ? ' (gerade gestartet)' : '') + ', warte 700ms');
      this._scheduleNextAttack(700);
      return true;
    }
    this._castingSkillId = this.config.spoilSkillId;
    this._dbg('_doAttack: Spoil#' + this.config.spoilSkillId + ' auf ' + this._target.objectId);
    this.gc.selectTarget(this._target.objectId);
    this.gc.useSkill(this.config.spoilSkillId);
    this._scheduleNextAttack(12000);
    return true;
  }

  // Handles skill-based attack rotation.
  _doAttackSkill(p, dist) {
    const skills = this.config.attackSkills;
    if (dist > this.config.attackRange) {
      this._dbg('_doAttack: zu weit (' + Math.round(dist) + ' > ' + this.config.attackRange + ') → bewegen, retry 1s');
      this._moveToTarget();
      this._scheduleNextAttack(1000);
      return;
    }
    // Don't cast while moving — L2 server rejects useSkill during movement.
    // Wait for the character to stop rather than spamming the server with rejected requests.
    if (this.gc.isMoving) {
      this._dbg('_doAttack: Charakter in Bewegung → warte 400ms');
      this._scheduleNextAttack(400);
      return;
    }
    let skillId = skills[this._attackSkillIdx % skills.length];
    // Skip 'once' skills already used on this target; stop if all are exhausted.
    const onceModes = this.config.attackSkillModes || {};
    let onceChecked = 0;
    while (skillId !== 0 && onceModes[skillId] === 'once' && this._onceSkillsUsed.has(skillId)) {
      this._attackSkillIdx = (this._attackSkillIdx + 1) % skills.length;
      skillId = skills[this._attackSkillIdx % skills.length];
      if (++onceChecked >= skills.length) { skillId = 0; break; } // all once-skills used → auto-attack
    }
    if (skillId === 0) {
      // Normal-attack sentinel at end of list — hand off to server auto-attack, no further scheduling.
      this._dbg('_doAttack: attack (sentinel) dist=' + Math.round(dist));
      this.gc.attack(this._target.objectId);
      this._castingSkillId = null;
      return;
    }
    // Check global skill MP/HP thresholds — fall back to auto-attack if not met.
    if (p) {
      const mpPct = p.maxMp > 0 ? (p.mp / p.maxMp * 100) : 100;
      const hpPct = p.maxHp > 0 ? (p.hp / p.maxHp * 100) : 100;
      if ((this.config.skillMinMpPct > 0 && mpPct < this.config.skillMinMpPct) ||
          (this.config.skillMinHpPct > 0 && hpPct < this.config.skillMinHpPct)) {
        this._dbg('_doAttack: Skill #' + skillId + ' übersprungen (MP=' + Math.round(mpPct) + '% HP=' + Math.round(hpPct) + '%) → Auto-Angriff');
        this.gc.attack(this._target.objectId);
        this._castingSkillId = null;
        this._scheduleNextAttack(2000); // retry skill after 2s
        return;
      }
    }
    this._castingSkillId = skillId;
    this._dbg('_doAttack: useSkill(' + skillId + ') dist=' + Math.round(dist) + ' safety=12s');
    // Re-select target before every skill cast: in SUPPORT mode, heals/buffs between ticks
    // may have changed the server-side selection to a party member or self.
    this.gc.selectTarget(this._target.objectId);
    this.gc.useSkill(skillId);
    // Do NOT advance _attackSkillIdx here — only advance in skillCastStart once the
    // server confirms the cast actually started. Advancing prematurely causes retries
    // to try the wrong (possibly also on-reuse) skill, leading to a stall.
    this._scheduleNextAttack(12000);
  }

  // Handles auto-attack (no skills configured).
  _doAttackAuto(dist) {
    if (dist > this.config.attackRange) {
      this._moveToTarget();
      return;
    }
    this._dbg('_doAttack: attack(' + this._target.objectId + ') dist=' + Math.round(dist));
    this.gc.attack(this._target.objectId);
    // When Spoil preceded the first auto-attack, the 5s heartbeat interval was not set up
    // (to avoid overwriting the Spoil timeout). Set it up now on the first real attack.
    if (!this._attackPollInterval) {
      this._attackPollInterval = setInterval(() => {
        if (!this._target || !this._isAttacking()) { this._stopAttack(); return; }
        this._doAttack();
      }, 5000);
    }
  }

  // Replace any pending skill cast timeout with a new one-shot _doAttack call.
  // Only called for skill-based combat (auto-attack uses _attackPollInterval, never calls this).
  _scheduleNextAttack(ms) {
    if (this._attackPollInterval) { clearInterval(this._attackPollInterval); this._attackPollInterval = null; }
    clearTimeout(this._attackTimeout);
    this._dbg('_scheduleNextAttack: ' + ms + 'ms');
    this._attackTimeout = setTimeout(() => {
      this._attackTimeout = null;
      if (this._target && this._isAttacking()) this._doAttack();
      else this._stopAttack();
    }, ms);
  }

  // True whenever the attack loop is legitimately running (COMBAT or SUPPORT assist).
  _isAttacking() {
    return this.state === STATE.COMBAT ||
           (this.state === STATE.SUPPORT && this._assistAttacking);
  }

  _stopAttack() {
    if (this._attackPollInterval) { clearInterval(this._attackPollInterval); this._attackPollInterval = null; }
    if (this._attackTimeout)      { clearTimeout(this._attackTimeout);       this._attackTimeout      = null; }
    this._castingSkillId    = null;
    this._castConfirmed     = false;
    this._actionFailedCount = 0;
    this._assistAttacking   = false;
  }

  // ═══════════════════════════════════════════════════════════
  // BUFFS
  // ═══════════════════════════════════════════════════════════

  _startBuffTimer() {
    this._doSelfBuffs(); // immediate cast on mode start; recurring timer is always-on
  }

  _doSelfBuffs() {
    if (this.state === STATE.COMBAT || this.state === STATE.HEALING || this._assistAttacking) return;
    if (this._buffPending) return;
    const p = this.gc.player;
    if (!p || !p.objectId) return;
    const now = Date.now();
    for (const buff of this.config.selfBuffs) {
      if (now - (this._selfBuffLastCast[buff.skillId] || 0) >= buff.intervalMs) {
        this.gc.selectTarget(p.objectId);
        this.gc.useSkill(buff.skillId);
        this._selfBuffLastCast[buff.skillId] = now;
        this._log('Selbst-Buff: ' + (buff.label || buff.skillId));
        this._setBuffPending(buff.skillId);
        return; // one buff per call; next fires after skillCastStart clears _buffPending
      }
    }
  }

  _setBuffPending(skillId, safetyMs = 8000) {
    if (this._buffPending) clearTimeout(this._buffPending.timer);
    this._buffPending = {
      skillId,
      timer: setTimeout(() => { this._buffPending = null; }, safetyMs),
    };
  }

  // ═══════════════════════════════════════════════════════════
  // SUPPORT MODE
  // ═══════════════════════════════════════════════════════════

  _startSupportTimer() {
    this._supportTimer = setInterval(() => this._supportTick(), 1000);
  }

  _followTick() {
    if (!this.config.followTargetId) return;
    // Don't interrupt active combat, healing, or assist-attack
    if (this.state === STATE.COMBAT || this.state === STATE.HEALING || this._assistAttacking) return;
    const p = this.gc.player;
    if (!p) return;
    const tgt = this._nearbyPlayers.get(this.config.followTargetId);
    if (!tgt) return;
    const dist = Math.hypot(tgt.x - p.x, tgt.y - p.y);
    if (dist > this.config.followDist) {
      // Stop followDist WU away from the leader, not at their exact position.
      // Without this, the bot always moves all the way to (tgt.x, tgt.y) regardless of followDist.
      const stopDist = dist - this.config.followDist;
      const tx = Math.round(p.x + (tgt.x - p.x) * stopDist / dist);
      const ty = Math.round(p.y + (tgt.y - p.y) * stopDist / dist);
      this._moveToWithStuckDetect(tx, ty, tgt.z || p.z);
    }
  }

  _supportTick() {
    if (!this.config.autoFarm) return;
    if (this.state === STATE.COMBAT) return;
    const p = this.gc.player;
    if (!p) return;
    const party = this.gc.party;
    const now = Date.now();

    if (this._supportHealSelf(p))               return;
    if (this._supportResurrect(p, party, now))  return;
    if (this._supportGroupBattleHeal(p, party)) return;
    if (this._supportGroupHeal(p, party))       return;
    if (this._supportHealParty(party))          return;
    if (this._buffPending)                      return;
    for (const buff of this.config.selfBuffs) {
      if (now - (this._selfBuffLastCast[buff.skillId] || 0) >= buff.intervalMs) return;
    }
    if (this._supportPartyBuff(p, party, now))  return;
    this._supportAssistAttack();
  }

  // Priority 1: heal self when below healSelfHpPct.
  _supportHealSelf(p) {
    const selfHpPct = p.maxHp > 0 ? (p.hp / p.maxHp) * 100 : 100;
    const selfHealId = this._selectHealSkill(selfHpPct);
    if (selfHealId && selfHpPct < this.config.healSelfHpPct) {
      if (p.objectId) this.gc.selectTarget(p.objectId);
      this.gc.useSkill(selfHealId);
      this._log('Heile selbst: ' + Math.round(selfHpPct) + '% → #' + selfHealId);
      return true;
    }
    return false;
  }

  // Priority 1b: resurrect dead party members (skill first, scroll as fallback).
  _supportResurrect(p, party, now) {
    if (!(this.config.resSkillId || this.config.resItemId)) return false;
    if (!party || party.size === 0) return false;
    const mpPct = p.maxMp > 0 ? (p.mp / p.maxMp) * 100 : 100;
    if (mpPct < (this.config.farmMinMpPct || 0)) return false;
    for (const member of party.values()) {
      if (member.maxHp > 0 && member.hp === 0) {
        if (now - (this._lastResurrect[member.objectId] || 0) > 12000) {
          this._lastResurrect[member.objectId] = now;
          this.gc.selectTarget(member.objectId);
          if (this.config.resSkillId) {
            this.gc.useSkill(this.config.resSkillId);
            this._log('Resurrect (Skill ' + this.config.resSkillId + ') → ' + member.name);
          } else {
            const scroll = this.gc.inventory.find(it => it.itemId === this.config.resItemId);
            if (scroll) {
              this.gc.useItem(scroll.objectId);
              this._log('Resurrect (Scroll ' + this.config.resItemId + ') → ' + member.name);
            } else {
              this._log('Resurrect: kein Scroll ' + this.config.resItemId + ' im Inventar');
            }
          }
          return true;
        }
      }
    }
    return false;
  }

  // Priority 2: AoE group heal (battle) when ≥2 members below threshold.
  _supportGroupBattleHeal(p, party) {
    if (!this.config.groupBattleHealSkillId) return false;
    if (!party || party.size < 1) return false;
    const allMembers = [{ objectId: p.objectId, hp: p.hp, maxHp: p.maxHp }, ...party.values()];
    const cnt = allMembers.filter(m => m.maxHp > 0 && (m.hp / m.maxHp * 100) < this.config.groupBattleHealHpPct).length;
    if (cnt >= 2) {
      this.gc.useSkill(this.config.groupBattleHealSkillId);
      this._log('Gruppen-Kampfheilung: ' + cnt + ' Mitglieder < ' + this.config.groupBattleHealHpPct + '%');
      return true;
    }
    return false;
  }

  // Priority 3: AoE group heal when ≥2 members below threshold.
  _supportGroupHeal(p, party) {
    if (!this.config.groupHealSkillId) return false;
    if (!party || party.size < 1) return false;
    const allMembers = [{ objectId: p.objectId, hp: p.hp, maxHp: p.maxHp }, ...party.values()];
    const cnt = allMembers.filter(m => m.maxHp > 0 && (m.hp / m.maxHp * 100) < this.config.groupHealHpPct).length;
    if (cnt >= 2) {
      this.gc.useSkill(this.config.groupHealSkillId);
      this._log('Gruppen-Heilung: ' + cnt + ' Mitglieder < ' + this.config.groupHealHpPct + '%');
      return true;
    }
    return false;
  }

  // Priority 4: heal the most critically low party member.
  _supportHealParty(party) {
    if (!party || party.size === 0) return false;
    let worstMember = null, worstHealId = 0, worstPct = Infinity;
    for (const member of party.values()) {
      if (member.maxHp > 0) {
        const pct = (member.hp / member.maxHp) * 100;
        const hid = this._selectHealSkill(pct);
        if (hid && pct < this.config.healTargetHpPct && pct < worstPct) {
          worstPct = pct; worstMember = member; worstHealId = hid;
        }
      }
    }
    if (worstMember) {
      this.gc.selectTarget(worstMember.objectId);
      this.gc.useSkill(worstHealId);
      this._log('Heile ' + worstMember.name + ': ' + Math.round(worstPct) + '% → #' + worstHealId);
      return true;
    }
    return false;
  }

  // Priority 6: apply party buffs round-robin, using PartySpelled data when available.
  _supportPartyBuff(p, party, now) {
    const memberBuffsCfg = this.config.partyMemberBuffs || {};
    const selfTarget = p ? { objectId: p.objectId, name: '__self__', displayName: p.name || 'Selbst' } : null;
    const allTargets = [...(selfTarget ? [selfTarget] : []), ...(party ? [...party.values()] : [])];
    if (allTargets.length === 0) return false;
    for (let i = 0; i < allTargets.length; i++) {
      const member = allTargets[(this._partyBuffMemberCursor + i) % allTargets.length];
      const key = member.name === '__self__' ? '__self__' : member.name;
      const buffs = (memberBuffsCfg[key] && memberBuffsCfg[key].length > 0)
        ? memberBuffsCfg[key] : this.config.partyBuffs;
      if (!buffs.length) continue;
      const effects = this._partyMemberEffects.get(member.objectId);
      let bestBuff = null, bestUrgency = -Infinity;
      for (const buff of buffs) {
        if (!this._partyBuffLastCast[buff.skillId]) this._partyBuffLastCast[buff.skillId] = {};
        let urgency;
        if (effects) {
          const active = effects.find(e => e.skillId === buff.skillId);
          if (active && (active.duration === -1 || active.duration > 30)) continue;
          if (!active) {
            // Buff missing despite PartySpelled data — higher-level buff may occupy the slot.
            // Apply 30s retry cooldown to avoid MP drain.
            const last = this._partyBuffLastCast[buff.skillId][member.objectId] || 0;
            if (now - last < 30000) continue;
          }
          urgency = active ? (30 - active.duration) : 1000;
        } else {
          const last = this._partyBuffLastCast[buff.skillId][member.objectId] || 0;
          urgency = (now - last) - buff.intervalMs;
          if (urgency <= 0) continue;
        }
        if (urgency > bestUrgency) { bestUrgency = urgency; bestBuff = buff; }
      }
      if (bestBuff) {
        this._partyBuffMemberCursor = (this._partyBuffMemberCursor + i + 1) % allTargets.length;
        this.gc.selectTarget(member.objectId);
        this.gc.useSkill(bestBuff.skillId);
        this._partyBuffLastCast[bestBuff.skillId][member.objectId] = now;
        const displayName = member.displayName || member.name;
        this._log('Buff ' + (bestBuff.label || bestBuff.skillId) + ' → ' + displayName);
        this._setBuffPending(bestBuff.skillId);
        return true;
      }
    }
    this._partyBuffMemberCursor = 0;
    return false;
  }

  // Priority 7: assist-attack — lowest priority, only when nothing else needs doing.
  _supportAssistAttack() {
    if (!this.config.assistTargetId || !this._assistCurrentNpcId) return;
    const target = this._nearbyNpcs.get(this._assistCurrentNpcId);
    if (!target || !target.attackable) {
      this._assistCurrentNpcId = null;
      if (this._assistAttacking) { this._target = null; this._stopAttack(); this._attackSkillIdx = 0; }
      return;
    }
    if (!this._assistAttacking) {
      // New target — start the skill loop from the beginning.
      this._target = target;
      this._assistAttacking = true;
      this._attackSkillIdx = 0;
      this.gc.selectTarget(target.objectId);
      this._dbg('Assist-Attack start → ' + (target.name || target.objectId));
      this._startAttack();
    }
  }

  // ═══════════════════════════════════════════════════════════
  // LOOTING
  // ═══════════════════════════════════════════════════════════

  _pickNextFromQueue() {
    if (this._lootQueue.length === 0) {
      if (this._lootPending.size === 0) this._resumeFromLoot();
      return;
    }
    const item = this._lootQueue.shift();
    const p = this.gc.player;
    const dist = p ? Math.hypot(item.x - p.x, item.y - p.y) : 0;
    // Skip items that are already gone or out of range
    if (!this._floorItems.has(item.objectId) || (p && dist > this.config.pickupRange)) {
      this._pickNextFromQueue();
      return;
    }
    this._lootPending.add(item.objectId);
    this._sendPickup(item);
    // Fallback: dist/220 WU/s + 1.5s pickup animation buffer, capped at 6s
    const fallbackMs = Math.min(Math.ceil(dist / 220 * 1000) + 1500, 6000);
    this._resetLootFallback(fallbackMs);
  }

  _sendPickup(item) {
    const p = this.gc.player;
    if (!p) return;
    const dist = Math.hypot(item.x - p.x, item.y - p.y);
    if (dist > this.config.pickupRange) return;
    this.gc.requestPickup(item.objectId);
  }

  _tryPickupItem(item) {
    const p = this.gc.player;
    if (!p) return;
    const dist = Math.hypot(item.x - p.x, item.y - p.y);
    if (dist <= this.config.pickupRange) {
      this.gc.requestPickup(item.objectId);
    }
  }

  _resetLootFallback(ms = 8000) {
    if (this._lootFallback) clearTimeout(this._lootFallback);
    this._lootFallback = setTimeout(() => {
      this._lootFallback = null;
      if (this.state === STATE.LOOTING) {
        if (ms > 1000) this._log('Loot-Timeout – weiter');
        this._sweepPending = false;
        this._resumeFromLoot();
      }
    }, ms);
  }

  _resumeFromLoot() {
    if (this._sweepPending) return;
    if (this._lootFallback) { clearTimeout(this._lootFallback); this._lootFallback = null; }
    this._lootQueue   = [];
    this._lootPending.clear();
    if (!this.config.autoFarm) return;

    // Before moving to next target, pick up any remaining floor items in range.
    // Always pick herbs; pick everything else only when autoPickup is on.
    const p = this.gc.player;
    const nearby = p ? [...this._floorItems.values()].filter(fi => {
      const inRange  = Math.hypot(fi.x - p.x, fi.y - p.y) <= this.config.pickupRange;
      const isHerb   = fi.itemId >= 8600 && fi.itemId <= 8615;
      const attempts = this._lootRetries.get(fi.objectId) || 0;
      if (attempts >= 3) {
        this._floorItems.delete(fi.objectId); // give up — item unreachable
        this._log('Item ' + fi.itemId + ' nach 3 Versuchen aufgegeben');
        return false;
      }
      return inRange && (isHerb || this.config.autoPickup);
    }) : [];
    if (nearby.length > 0) {
      this.state = STATE.LOOTING;
      this.emit('status', this._status());
      for (const fi of nearby) {
        this._lootRetries.set(fi.objectId, (this._lootRetries.get(fi.objectId) || 0) + 1);
      }
      this._lootQueue = [...nearby];
      this._pickNextFromQueue();
      return;
    }

    this.state = STATE.FARMING;
    this.emit('status', this._status());
    this._dbg('_resumeFromLoot → _pickTarget');
    this._pickTarget();
  }

  // ═══════════════════════════════════════════════════════════
  // UTILITIES
  // ═══════════════════════════════════════════════════════════

  _emitNpcs() {
    const npcs = [...this._nearbyNpcs.values()];
    this.emit('npcs', npcs);
  }

  _status() {
    const p = this.gc.player || {};
    return {
      state: this.state,
      mode: this.config.mode,
      hp: p.hp || 0,
      maxHp: p.maxHp || 0,
      mp: p.mp || 0,
      maxMp: p.maxMp || 0,
      cp: p.cp || 0,
      maxCp: p.maxCp || 0,
      x: p.x || 0,
      y: p.y || 0,
      z: p.z || 0,
      target: this._target ? this._target.objectId : null,
      nearbyNpcs: this._nearbyNpcs.size,
      nearbyPlayers: [...this._nearbyPlayers.values()],
      floorItems: [...this._floorItems.values()],
      selfBuffs: this.config.selfBuffs.map(b => ({
        ...b,
        lastCast: this._selfBuffLastCast[b.skillId] || 0,
      })),
      partyBuffs: this.config.partyBuffs.map(b => {
        const perMember = this._partyBuffLastCast[b.skillId] || {};
        const vals = Object.values(perMember);
        // Report the earliest (most overdue) cast so the UI countdown reflects the member who needs it most
        const lastCast = vals.length ? Math.min(...vals) : 0;
        return { ...b, lastCast };
      }),
      stats: { ...this._stats },
      level: p.level || 0,
      exp: p.exp || 0,
      followTargetId: this.config.followTargetId,
      assistTargetId: this.config.assistTargetId,
    };
  }

  _log(msg) { this.emit('log', '[Bot] ' + msg); }
  _dbg(msg) { if (this.config.debug) console.log('[Bot:DBG] ' + msg); }

  // ═══════════════════════════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════════════════════════

  setConfig(cfg) {
    Object.assign(this.config, cfg);
    if (cfg.debug !== undefined && this.gc) this.gc.debugMode = !!cfg.debug;
    if (cfg.mode === 'SUPPORT' && this.state === STATE.FARMING) {
      this._stopAttack();
      this.state = STATE.SUPPORT;
      this._startSupportTimer();
    } else if (cfg.mode === 'FARM' && this.state === STATE.SUPPORT) {
      if (this._supportTimer) { clearInterval(this._supportTimer); this._supportTimer = null; }
      this.state = STATE.FARMING;
      this._startBuffTimer();
      this._pickTarget();
    }
    if (cfg.attackSkills !== undefined) { this._attackSkillIdx = 0; this._castingSkillId = null; this._castConfirmed = false; this._actionFailedCount = 0; }
    if (cfg.partyBuffs   !== undefined) { this._partyBuffLastCast = {}; this._partyMemberEffects.clear(); this._partyBuffMemberCursor = 0; }
    if (this.config.autoFarm && (cfg.shotsEnabled !== undefined || cfg.shotItemId !== undefined)) {
      if (this.config.shotsEnabled && this.config.shotItemId)
        this.gc.autoSoulShot(this.config.shotItemId, true);
    }
    this.emit('status', this._status());
  }

  pickTarget() {
    const found = this._findNearestAttackableNpc({ useZone: false, filterDead: false, maxRadius: this.config.farmRadius });
    if (found) {
      const { npc: nearest } = found;
      this._target = nearest;
      this.gc.selectTarget(nearest.objectId);
      this._moveToTarget();
      this._log('Manuell markiert: ' + nearest.objectId + ' (' + (nearest.name || nearest.npcTypeId) + ')');
      this.emit('status', this._status());
    }
  }

  setManualTarget(objectId, startAttack = true) {
    const npc = this._nearbyNpcs.get(objectId);
    if (!npc) return;
    this._cancelWaypoints();
    this._target = npc;
    this.gc.selectTarget(objectId);
    this._moveToTarget();
    if (startAttack) {
      this.state = STATE.COMBAT;
      this._startAttack();
    }
    this._log('Manuelles Ziel: ' + (npc.name || objectId));
    this.emit('status', this._status());
  }

  pickupNearby() {
    const p = this.gc.player;
    if (!p) return;
    for (const fi of this._floorItems.values()) {
      if (Math.hypot(fi.x - p.x, fi.y - p.y) <= this.config.pickupRange) {
        this.gc.requestPickup(fi.objectId);
      }
    }
  }

  getNearbyPlayers() {
    return [...this._nearbyPlayers.values()];
  }

  destroy() {
    this.stop();
    if (this._selfBuffTimer)    { clearInterval(this._selfBuffTimer);    this._selfBuffTimer    = null; }
    if (this._buffPending)      { clearTimeout(this._buffPending.timer); this._buffPending      = null; }
    if (this._followTimer)      { clearInterval(this._followTimer);      this._followTimer      = null; }
    if (this._combatStallTimer) { clearInterval(this._combatStallTimer); this._combatStallTimer = null; }
    this.removeAllListeners();
  }
}

module.exports = { Bot, STATE };
