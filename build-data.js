'use strict';

const fs = require('fs');
const path = require('path');

const SERVER_SRC = '/mnt/Games/Lineage2/server_src/L2J_Mobius_CT_2.6_HighFive/dist/game/data';
const SERVER     = '/mnt/Games/Lineage2/server/game/data';
const OUT_DIR    = path.join(__dirname, 'public/data');

// ===== Helpers =====
function extractAttrs(xml, tag) {
  const results = [];
  const re = new RegExp(`<${tag}\\s([^>]+?)\\s*/?>`, 'g');
  let m;
  while ((m = re.exec(xml)) !== null) {
    const attrs = {};
    const attrRe = /(\w+)="([^"]*)"/g;
    let a;
    while ((a = attrRe.exec(m[1])) !== null) attrs[a[1]] = a[2];
    results.push(attrs);
  }
  return results;
}

function buildNameMap(dir, tag, idAttr, nameAttr) {
  const map = {};
  if (!fs.existsSync(dir)) { console.warn('  Missing:', dir); return map; }
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.xml')) continue;
    const xml = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const a of extractAttrs(xml, tag)) {
      if (a[idAttr] && a[nameAttr]) map[a[idAttr]] = a[nameAttr];
    }
  }
  return map;
}

function buildNameMapRecursive(dir, tag, idAttr, nameAttr) {
  const map = {};
  if (!fs.existsSync(dir)) return map;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fp = path.join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(map, buildNameMapRecursive(fp, tag, idAttr, nameAttr));
    else if (entry.name.endsWith('.xml')) {
      const xml = fs.readFileSync(fp, 'utf8');
      for (const a of extractAttrs(xml, tag)) {
        if (a[idAttr] && a[nameAttr]) map[a[idAttr]] = a[nameAttr];
      }
    }
  }
  return map;
}

// ===== NPCs =====
console.log('Building NPC names...');
const npcMap = buildNameMap(path.join(SERVER, 'stats/npcs'), 'npc', 'id', 'name');
Object.assign(npcMap, buildNameMap(path.join(SERVER_SRC, 'stats/npcs'), 'npc', 'id', 'name'));
console.log('  NPCs:', Object.keys(npcMap).length);
fs.writeFileSync(path.join(OUT_DIR, 'npc_names.json'), JSON.stringify(npcMap));

// ===== Skills =====
console.log('Building Skill names...');
const skillMap = buildNameMapRecursive(path.join(SERVER, 'stats/skills'), 'skill', 'id', 'name');
Object.assign(skillMap, buildNameMapRecursive(path.join(SERVER_SRC, 'stats/skills'), 'skill', 'id', 'name'));
console.log('  Skills:', Object.keys(skillMap).length);
fs.writeFileSync(path.join(OUT_DIR, 'skill_names.json'), JSON.stringify(skillMap));

// ===== Items =====
console.log('Building Item names...');
const itemMap = buildNameMapRecursive(path.join(SERVER, 'stats/items'), 'item', 'id', 'name');
Object.assign(itemMap, buildNameMapRecursive(path.join(SERVER_SRC, 'stats/items'), 'item', 'id', 'name'));
console.log('  Items:', Object.keys(itemMap).length);
fs.writeFileSync(path.join(OUT_DIR, 'item_names.json'), JSON.stringify(itemMap));

// ===== Weapon Ranges =====
console.log('Building Weapon ranges...');
const weaponRangeMap = {};
const DEFAULT_WEAPON_RANGE = 40;
function buildWeaponRanges(dir) {
  if (!fs.existsSync(dir)) return;
  const blockRe = /<item\b([^>]*)>([\s\S]*?)<\/item>/g;
  const idRe    = /\bid="(\d+)"/;
  const typeRe  = /\btype="Weapon"/;
  const rangeRe = /<stat\s+type="pAtkRange">(\d+)<\/stat>/;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fp = path.join(dir, entry.name);
    if (entry.isDirectory()) { buildWeaponRanges(fp); continue; }
    if (!entry.name.endsWith('.xml')) continue;
    const text = fs.readFileSync(fp, 'utf8');
    let m;
    while ((m = blockRe.exec(text)) !== null) {
      const attrs = m[1], body = m[2];
      if (!typeRe.test(attrs)) continue;
      const idM = idRe.exec(attrs); if (!idM) continue;
      const rangeM = rangeRe.exec(body); if (!rangeM) continue;
      const range = parseInt(rangeM[1]);
      if (range !== DEFAULT_WEAPON_RANGE) weaponRangeMap[parseInt(idM[1])] = range;
    }
  }
}
buildWeaponRanges(path.join(SERVER, 'stats/items'));
console.log('  Weapon ranges (non-default):', Object.keys(weaponRangeMap).length);
fs.writeFileSync(path.join(OUT_DIR, 'weapon_ranges.json'), JSON.stringify(weaponRangeMap));

// ===== Skill Ranges =====
console.log('Building Skill ranges...');
const skillRangeMap = {};
const DEFAULT_SKILL_RANGE = 40;
function buildSkillRanges(dir) {
  if (!fs.existsSync(dir)) return;
  const blockRe = /<skill\b([^>]*)>([\s\S]*?)<\/skill>/g;
  const idRe    = /\bid="(\d+)"/;
  const rangeRe = /<castRange>(\d+)<\/castRange>/;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fp = path.join(dir, entry.name);
    if (entry.isDirectory()) { buildSkillRanges(fp); continue; }
    if (!entry.name.endsWith('.xml')) continue;
    const text = fs.readFileSync(fp, 'utf8');
    let m;
    while ((m = blockRe.exec(text)) !== null) {
      const attrs = m[1], body = m[2];
      const idM = idRe.exec(attrs); if (!idM) continue;
      const rangeM = rangeRe.exec(body); if (!rangeM) continue;
      const range = parseInt(rangeM[1]);
      const id = parseInt(idM[1]);
      if (range !== DEFAULT_SKILL_RANGE) skillRangeMap[id] = range;
    }
  }
}
buildSkillRanges(path.join(SERVER, 'stats/skills'));
buildSkillRanges(path.join(SERVER_SRC, 'stats/skills'));
console.log('  Skill ranges (non-default):', Object.keys(skillRangeMap).length);
fs.writeFileSync(path.join(OUT_DIR, 'skill_ranges.json'), JSON.stringify(skillRangeMap));

// ===== Zones =====
// Only zone types that have visual meaning for map navigation
const ZONE_TYPES_INCLUDE = new Set([
  'PeaceZone', 'WaterZone', 'DamageZone', 'ArenaZone', 'NoPvPZone',
  'BossZone', 'SiegeZone', 'CastleZone', 'JailZone', 'SwampZone',
  'FishingZone', 'TaxZone',
]);

console.log('Building Zones...');
const zones = {}; // type → [ { name, nodes: [[x,y],...] } ]

function parseZoneFile(filepath) {
  const xml = fs.readFileSync(filepath, 'utf8');
  // Match zone blocks
  const zoneRe = /<zone\s([^>]+)>([\s\S]*?)<\/zone>/g;
  let m;
  while ((m = zoneRe.exec(xml)) !== null) {
    const attrStr = m[1];
    const inner   = m[2];
    const attrs = {};
    const attrRe = /(\w+)="([^"]*)"/g;
    let a;
    while ((a = attrRe.exec(attrStr)) !== null) attrs[a[1]] = a[2];

    const type  = attrs.type  || attrs.id || 'other';
    const shape = attrs.shape || 'NPoly';
    const name  = attrs.name  || '';

    if (!ZONE_TYPES_INCLUDE.has(type)) continue;

    // Extract nodes
    const nodes = [];
    const nodeRe = /<node\s+X="(-?\d+)"\s+Y="(-?\d+)"/g;
    let n;
    while ((n = nodeRe.exec(inner)) !== null) {
      nodes.push([parseInt(n[1]), parseInt(n[2])]);
    }

    let poly = null;
    if (shape === 'NPoly' && nodes.length >= 3) {
      poly = nodes;
    } else if (shape === 'Cuboid' && nodes.length >= 2) {
      const [x1, y1] = nodes[0];
      const [x2, y2] = nodes[1];
      const minX = Math.min(x1, x2), maxX = Math.max(x1, x2);
      const minY = Math.min(y1, y2), maxY = Math.max(y1, y2);
      poly = [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]];
    } else if (shape === 'Cylinder' && nodes.length >= 1 && attrs.rad) {
      const [cx, cy] = nodes[0];
      const r = parseInt(attrs.rad);
      const pts = 12;
      poly = [];
      for (let i = 0; i < pts; i++) {
        const angle = (i / pts) * Math.PI * 2;
        poly.push([Math.round(cx + Math.cos(angle) * r), Math.round(cy + Math.sin(angle) * r)]);
      }
    }

    if (!poly) continue;
    if (!zones[type]) zones[type] = [];
    zones[type].push({ name, nodes: poly });
  }
}

const zoneDir = path.join(SERVER_SRC, 'zones');
if (fs.existsSync(zoneDir)) {
  for (const file of fs.readdirSync(zoneDir)) {
    if (file.endsWith('.xml') && file !== 'documentation.txt') {
      try { parseZoneFile(path.join(zoneDir, file)); } catch(e) { /* skip */ }
    }
  }
}

const zoneCount = Object.values(zones).reduce((s, a) => s + a.length, 0);
console.log('  Zones:', zoneCount, '(types:', Object.keys(zones).join(', ') + ')');
fs.writeFileSync(path.join(OUT_DIR, 'zones.json'), JSON.stringify(zones));

console.log('Done.');
