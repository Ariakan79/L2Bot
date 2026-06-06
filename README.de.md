# L2Bot

🇩🇪 Deutsch | [🇬🇧 English](README.md)

---

Out-of-game (OOG) Bot für **Lineage 2 High Five (CT2.6)**. Implementiert das L2-Netzwerkprotokoll in Node.js und stellt eine browserbasierte Steueroberfläche bereit. Bis zu 16 Accounts können gleichzeitig betrieben werden.

---

## Voraussetzungen

- **Node.js 18 oder neuer** — [nodejs.org](https://nodejs.org)
- **Linux oder Windows** (auf macOS nicht getestet)
- Zugang zum L2-Spielserver (Login- und Game-Server-Adresse)

---

## Installation

```bash
git clone https://github.com/Ariakan79/L2Bot.git
cd L2Bot
```

Das war es. Abhängigkeiten werden beim ersten Start automatisch installiert.

---

## Start

```bash
./start.sh
```

Das Skript:
1. Installiert npm-Pakete falls noch nicht vorhanden
2. Prüft ob Daten-Tabellen (NPC/Skill/Item-Namen) vorhanden sind — falls nicht, werden sie aus den Server-Quelldaten gebaut (nur notwendig wenn `public/data/` fehlt, was beim Klonen nicht der Fall ist)
3. Startet den Bot-Server auf `http://localhost:3001`

Danach einfach den Browser öffnen und `http://localhost:3001` aufrufen.

---

## Bedienung

### Login

Im Browser auf **„+"** klicken, um eine neue Session zu erstellen:

| Feld | Beschreibung |
|---|---|
| Server-Host | Adresse des Login-Servers (Standard: vorkonfiguriert) |
| Login-Port | Standard: 2106 |
| Benutzername | L2-Account-Name |
| Passwort | L2-Account-Passwort |

Nach dem Login auf **Charakter auswählen** klicken.

### Bot-Tabs

Jede eingeloggte Session hat eigene Tabs:

- **Bot** — Farming- und Support-Konfiguration, Start/Stop
- **Party** — Party-Einladungen, Auto-Accept, Auto-Res
- **Inventar** — Itemliste der aktuellen Session

---

## Konfiguration

Alle Einstellungen werden pro Charakter gespeichert und beim nächsten Login automatisch wiederhergestellt.

### Modus

| Modus | Beschreibung |
|---|---|
| **Farm** | Bot sucht selbstständig Mobs im konfigurierten Radius und greift an |
| **Support** | Bot heilt/bufft Party-Mitglieder; greift optional das Ziel des Assist-Targets an |

### Farm-Einstellungen (Tab „Bot")

- **Farm-Radius** — Umkreis in World Units, in dem Mobs gesucht werden
- **Farm-Zone** — Alternativ: feste Rechteck-Zone (X1/Y1/X2/Y2)
- **Attack-Skills** — Skill-Rotation für den Angriff; Slot mit `0` = Auto-Angriff
- **Auto-Pickup** — Automatisch Items aufheben
- **FightBack** — Reagiert auf eingehenden Schaden auch im Idle-Zustand
- **Shots (Soul/Spirit)** — Automatische Soulshot/Spiritshot-Nutzung

### Support-Einstellungen

- **Assist-Target** — Party-Mitglied, dessen Ziel der Bot ebenfalls angreift
- **Heal-Skill** — Skill zum Heilen von sich selbst und Party
- **Heal-Schwellwert** — Ab welchem HP% geheilt wird
- **Self-Buffs / Party-Buffs** — Skill-ID + Intervall in Sekunden
- **Auto-Res** — Eingehende Res-Angebote automatisch annehmen; optional eigenen Res-Skill/Scroll konfigurieren

### Zwerg: Spoil & Sweep

- **Auto-Spoil (Zwerg)** aktivieren
- **Spoil-Skill** und **Sweeper-Skill** aus den Dropdowns wählen

Der Bot castet Spoil automatisch vor dem ersten Angriff auf jeden Mob und führt Sweep nach dem Tod aus — sowohl im Farm- als auch im Support-Modus.

### Ressourcen-Schwellen

Der Bot pausiert automatisch wenn:
- MP unter **Farm Stop MP%** fällt
- HP unter **Farm Stop HP%** fällt

---

## Geodaten (optional)

Der Bot verwendet L2J-Geodaten (`.l2j`-Dateien) für Pathfinding — also um Wände und Hindernisse zu umgehen. **Ohne Geodaten läuft der Bot normal**, bewegt sich aber immer direkt auf Ziele zu (ohne Wandvermeidung).

### Geodaten einrichten

1. `.l2j`-Regiondateien in ein lokales Verzeichnis legen, z.B. `/home/user/geodata/`
2. Bot mit der Umgebungsvariable `L2_GEO_DIR` starten:

```bash
L2_GEO_DIR=/home/user/geodata ./start.sh
```

Geodaten für High Five CT2.6 können aus einer L2J-Server-Installation übernommen werden (Ordner `geodata/` im Server-Verzeichnis).

---

## Charakter-Profile

Charakter-Konfigurationen werden lokal in `profiles/characters.json` gespeichert. Diese Datei ist nicht im Repository enthalten (`.gitignore`) und enthält keine Zugangsdaten — nur Bot-Einstellungen wie Skills, Radius und Modus.

---

## Lizenz & Disclaimer

Dieser Code wird als **freie Software ohne Gewinnerzielungsabsicht** bereitgestellt.

Die Nutzung steht jedem offen. Eine kommerzielle Nutzung ist nicht beabsichtigt und wird nicht unterstützt.

**Abhängigkeiten und deren Lizenzen:**

| Paket | Lizenz |
|---|---|
| [express](https://github.com/expressjs/express) | MIT |
| [ws](https://github.com/websockets/ws) | MIT |
| [node-forge](https://github.com/digitalbazaar/forge) | BSD-3-Clause / MIT |
| [blowfish](https://www.npmjs.com/package/blowfish) | MIT |

**Rechtlicher Hinweis:**

Das Betreiben von Bots kann gegen die Nutzungsbedingungen (Terms of Service) des jeweiligen Spielservers verstoßen. Die Nutzung dieses Projekts geschieht auf eigene Verantwortung. Die Autoren übernehmen keine Haftung für Konsequenzen, die sich aus der Verwendung ergeben — einschließlich Account-Sperren oder sonstiger Maßnahmen seitens des Server-Betreibers.

Lineage 2 ist ein eingetragenes Warenzeichen von NCSoft Corporation. Dieses Projekt steht in keiner Verbindung zu NCSoft.
