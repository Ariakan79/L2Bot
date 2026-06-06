# L2Bot

[🇩🇪 Deutsch](README.de.md) | 🇬🇧 English

---

Out-of-game (OOG) bot for **Lineage 2 High Five (CT2.6)**. Implements the L2 network protocol from scratch in Node.js and provides a browser-based control panel. Up to 16 accounts can be operated simultaneously.

---

## Requirements

- **Node.js 18 or newer** — [nodejs.org](https://nodejs.org)
- **Linux or Windows** (untested on macOS)
- Access to an L2 game server (login and game server address)

---

## Installation

```bash
git clone https://github.com/Ariakan79/L2Bot.git
cd L2Bot
```

That's it. Dependencies are installed automatically on first start.

---

## Starting the Bot

```bash
./start.sh
```

The script:
1. Installs npm packages if not already present
2. Checks whether data tables (NPC/skill/item names) exist — if not, builds them from server source data (only needed if `public/data/` is missing, which is not the case after cloning)
3. Starts the bot server at `http://localhost:3001`

Then open your browser and go to `http://localhost:3001`.

---

## Usage

### Login

Click **"+"** in the browser to create a new session:

| Field | Description |
|---|---|
| Server Host | Login server address (default: pre-configured) |
| Login Port | Default: 2106 |
| Username | L2 account name |
| Password | L2 account password |

After logging in, click **Select Character**.

### Bot Tabs

Each logged-in session has its own tabs:

- **Bot** — Farming and support configuration, start/stop
- **Party** — Party invitations, auto-accept, auto-res
- **Inventory** — Item list of the current session

---

## Configuration

All settings are saved per character and automatically restored on the next login.

### Mode

| Mode | Description |
|---|---|
| **Farm** | Bot autonomously searches for mobs within the configured radius and attacks |
| **Support** | Bot heals/buffs party members; optionally assists the assist target in combat |

### Farm Settings (Bot tab)

- **Farm Radius** — Search radius in World Units
- **Farm Zone** — Alternative: fixed rectangular zone (X1/Y1/X2/Y2)
- **Attack Skills** — Skill rotation for combat; a slot set to `0` triggers auto-attack
- **Auto-Pickup** — Automatically pick up items
- **FightBack** — Reacts to incoming damage even while idle
- **Shots (Soul/Spirit)** — Automatic Soulshot/Spiritshot usage

### Support Settings

- **Assist Target** — Party member whose target the bot also attacks
- **Heal Skill** — Skill used to heal self and party
- **Heal Threshold** — HP% below which healing is triggered
- **Self-Buffs / Party-Buffs** — Skill ID + interval in seconds
- **Auto-Res** — Automatically accept incoming resurrection offers; optionally configure own res skill/scroll

### Dwarf: Spoil & Sweep

- Enable **Auto-Spoil (Dwarf)**
- Select **Spoil Skill** and **Sweeper Skill** from the dropdowns

The bot automatically casts Spoil before the first attack on each mob and performs Sweep after the mob dies — in both Farm and Support mode.

### Resource Thresholds

The bot pauses automatically when:
- MP drops below **Farm Stop MP%**
- HP drops below **Farm Stop HP%**

---

## Geodata (optional)

The bot uses L2J geodata (`.l2j` files) for pathfinding — to navigate around walls and obstacles. **Without geodata the bot works normally**, but always moves in a straight line toward targets (no wall avoidance).

### Setting up Geodata

1. Place the `.l2j` region files in a local directory, e.g. `/home/user/geodata/`
2. Start the bot with the `L2_GEO_DIR` environment variable:

```bash
L2_GEO_DIR=/home/user/geodata ./start.sh
```

Geodata for High Five CT2.6 can be taken from an L2J server installation (the `geodata/` folder in the server directory).

---

## Character Profiles

Character configurations are stored locally in `profiles/characters.json`. This file is not included in the repository (`.gitignore`) and contains no credentials — only bot settings such as skills, radius and mode.

---

## License & Disclaimer

This code is provided as **free software with no intention of commercial use**.

Anyone is free to use it. Commercial use is not intended and not supported.

**Dependencies and their licenses:**

| Package | License |
|---|---|
| [express](https://github.com/expressjs/express) | MIT |
| [ws](https://github.com/websockets/ws) | MIT |
| [node-forge](https://github.com/digitalbazaar/forge) | BSD-3-Clause / MIT |
| [blowfish](https://www.npmjs.com/package/blowfish) | MIT |

**Legal Notice:**

Operating bots may violate the Terms of Service of the respective game server. Use of this project is at your own risk. The authors accept no liability for any consequences arising from its use — including account bans or other actions taken by the server operator.

Lineage 2 is a registered trademark of NCSoft Corporation. This project is not affiliated with NCSoft in any way.
