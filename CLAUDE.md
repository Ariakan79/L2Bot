# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

An out-of-game (OOG) bot for **Lineage 2 High Five (CT2.6)** servers. It implements the L2 network protocol from scratch in Node.js and exposes a browser-based control panel. The target server is `server.ariakan.eu`.

## Running the Bot

```bash
./start.sh          # installs npm deps and rebuilds data tables if missing, then starts
npm start           # start directly (assumes deps and data already exist)
```

The UI is served at `http://localhost:3001`. Up to 16 simultaneous sessions (accounts) are supported.

### Rebuilding static data tables

`build-data.js` extracts NPC/skill/item names and skill ranges from the L2J server source XML. It reads from two hardcoded paths:
- `/mnt/Games/Lineage2/server_src/L2J_Mobius_CT_2.6_HighFive/dist/game/data` (server source XML)
- `/mnt/Games/Lineage2/server/game/data` (live server data)

Outputs go to `public/data/` as JSON. Re-run with `node build-data.js` after updating server data.

### Geodata

The pathfinder reads `.l2j` binary region files from `/mnt/Games/Lineage2/geodata/geodata`. These are loaded on demand and cached in memory. Without geodata files the bot falls back to direct movement (no wall avoidance).

## Architecture

### Layer overview

```
Browser (index.html)
    ↕ WebSocket (JSON messages)
server.js  ──  Session manager, message router, profile persistence
    ↕
LoginClient (src/proto/loginClient.js)  — L2 login server protocol
    ↓ emits PlayOk session key
GameClient (src/proto/gameClient.js)    — L2 game server protocol, EventEmitter
    ↓ emits game events
Bot (src/bot/bot.js)                    — autonomous farming/support AI, EventEmitter
```

### server.js — session hub

Manages up to 16 `Session` objects (one per logged-in account). Each session holds references to a `GameClient` and a `Bot`. All WebSocket clients receive every session's events (sessions are identified by `sessionId` in every message). Character config is auto-saved to `profiles/characters.json` keyed by character name and reloaded on login.

### LoginClient (src/proto/loginClient.js)

Implements the L2 login handshake: RSA key unscrambling → Blowfish session encryption → credential encryption → server list → PlayOk session key. After `PlayOk` the socket is destroyed and the session key is passed to `GameClient`.

### GameClient (src/proto/gameClient.js)

Maintains a raw TCP connection to the game server. Packet framing: `uint16LE` length prefix. Encryption: XOR cipher with a sliding 16-byte key (enabled after the first `KeyPacket`). Strings are UTF-16LE with 2-byte null terminator.

Key internal state:
- `player` — current character stats and position
- `inventory` — array of item objects
- `party` — `Map<objectId, member>` of current party members
- Dead-reckoning: a `setInterval` advances `player.x/y` at `runSpeed` WU/s between `MoveToLocation` and `StopMove` packets

Emits semantic game events (`npcAppear`, `playerStats`, `die`, `skillCastStart`, etc.) that `Bot` and `server.js` listen to.

### Bot (src/bot/bot.js)

Pure state machine with no direct WebSocket knowledge. Receives a `GameClient` instance; emits `log`, `status`, `npcs`, etc. upward to `server.js`.

**Bot states:** `IDLE → FARMING → COMBAT → LOOTING → HEALING → SUPPORT`

Key behaviors:
- **Target selection** (`_pickTarget`): picks nearest attackable NPC within `farmRadius` or `farmZone` rectangle. Respects MP/HP minimum thresholds.
- **Attack loop**: for skills, driven by `skillCastStart` feedback (hitTime + reuseDelay); for auto-attack, a 5s `setInterval`. Safety 12s timeout covers missed packets.
- **FightBack**: reacts to `combatAttack` packets (proactive) and HP drops (fallback) when idle.
- **Loot queue**: sequential one-at-a-time pickup with fallback timeout. Herbs (itemId 8600–8615) always picked up regardless of `autoPickup`.
- **Pathfinding**: BFS over geodata NSWE bits via `findPath()`. Falls back to direct `moveTo` when no obstacles or path exceeds `maxRadius=60` cells.
- **Support mode**: priority order — heal self → heal party (worst member) → self-buffs → party buffs (round-robin) → assist-attack.
- **Stuck detection**: if the character hasn't moved >40 WU in 2.5s after a `moveTo`, jitters in a random direction then retries.
- **Self-buffs / party buffs**: always-on `setInterval` independent of farming state; uses `PartySpelled` (0xF4) packet data when available for accurate buff duration tracking.

### Geodata (src/geo/geodata.js)

Reads L2J `.l2j` binary format: 256×256 blocks per region file, each block is FLAT / COMPLEX / MULTILAYER. NSWE bits encode wall passability. `getGeoGrid()` returns a compact byte buffer for the map overlay rendered in the browser. `findPath()` is BFS limited to 60 cells radius.

### Static data (src/data/)

- `skillRange.js` — wraps `public/data/skill_ranges.json`; returns 40 WU (melee default) for unknown skills
- `weaponRange.js` — wraps `public/data/weapon_ranges.json`

## Protocol notes (L2 High Five CT2.6)

- Login port: 2106. Game port: 7777.
- Login encryption: static Blowfish key for `Init`, then per-session Blowfish.
- Game encryption: XOR cipher; first encrypted packet from client enables it.
- Packet size includes the 2-byte length prefix itself.
- All L2 strings: UTF-16LE, 2-byte null terminator.
- `UserInfo` (0x32) is the authoritative player state on world-entry, teleport, and respawn.
- `StatusUpdate` (0x18) carries incremental HP/MP/CP changes. Type codes: 9=HP, 10=maxHP, 11=MP, 12=maxMP, 33=CP, 34=maxCP.
- `NpcInfo` (0x0C): `objectId`, `npcTypeId = displayId + 1000000`, `attackable`.
- `Die` (0x00): sent when any object dies; check `objectId === player.objectId` for self.
- Extended packets (0xFE): sub-opcode is `uint16LE` at bytes 1–2.
- `ValidateLocation` (0x24): snap Z always; snap X/Y only when drift > 200 WU to avoid visible jumps during dead-reckoning.

## World coordinate system

- `WORLD_MIN_X = -655360`, `WORLD_MIN_Y = -589824`
- Geodata cell size: 16 WU. Region file covers 2048×2048 geo cells.
- Radar map (`public/data/radar_bg.png`) world bounds: X_MIN=-327680, X_RANGE=524288 (each tile=131072 WU).
- Player run speed reported in WU/s directly from `UserInfo`. Dead-reckoning uses this value (default 280 WU/s if unknown).

## WebSocket message protocol

Browser ↔ server messages are plain JSON. Commands from browser include `cmd` + `sessionId`. Server pushes typed events: `state`, `playerInfo`, `playerStats`, `botStatus`, `npcs`, `npcHpUpdate`, `floorItems`, `log`, `skillList`, `activeEffects`, `itemList`, `inventoryUpdate`, `partyUpdate`, `statEvent`, `geoGrid`, `nearbyPlayers`, `chatMessage`, `npcDialog`, `shopList`, `multiSellList`, `acquireSkillList`, `playerDied`, `partyInvite`.

On new WebSocket connection, `server.js` sends a full snapshot of all sessions + their buffered logs, bot status, skills, etc.
