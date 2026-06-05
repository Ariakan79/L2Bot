#!/usr/bin/env node
// Parses mapregion XMLs and outputs public/data/mapregions.json
// Run once: node tools/gen_mapregions.js

const fs = require('fs');
const path = require('path');

const SRC_DIR = '/home/ariakan/Lineage2/High5Server/L2J_Mobius_CT_2.6_HighFive/dist/game/data/mapregion';
const OUT_FILE = path.join(__dirname, '../public/data/mapregions.json');

// Skip GM areas and instance-zone entries whose respawn points teleport to a town
// (Kamaloka/Nia/Rim all respawn at Dion → misleading coordinates)
const SKIP_TOWNS = new Set([
  'GM Consultation Service',
  'Kamaloka', 'Nia Kamaloka', 'Rim Kamaroka',
  'Neutral Zone', // same coords as Gludio Castle Town
]);

const byTown = new Map(); // town -> { xs:[], ys:[], outdoor:bool, name:string }

for (const file of fs.readdirSync(SRC_DIR).filter(f => f.endsWith('.xml'))) {
  const xml = fs.readFileSync(path.join(SRC_DIR, file), 'utf8');

  // Split into per-region blocks
  const regionBlocks = xml.split(/<region\b/).slice(1);

  for (const block of regionBlocks) {
    const townMatch = block.match(/town="([^"]+)"/);
    const nameMatch = block.match(/name="([^"]+)"/);
    if (!townMatch) continue;

    const town = townMatch[1];
    const name = nameMatch ? nameMatch[1] : '';
    if (SKIP_TOWNS.has(town)) continue;

    const hasMap = /<map\b/.test(block);

    // Collect non-chaotic respawn points
    const rePt = /<respawnPoint[^/]*X="(-?\d+)"[^/]*Y="(-?\d+)"[^/]*(isChaotic="true")?/g;
    let m;
    const pts = [];
    while ((m = rePt.exec(block)) !== null) {
      if (!m[3]) pts.push({ x: parseInt(m[1]), y: parseInt(m[2]) });
    }

    if (pts.length === 0) continue;

    if (!byTown.has(town)) {
      byTown.set(town, { name, xs: [], ys: [], outdoor: false });
    }
    const entry = byTown.get(town);
    for (const p of pts) { entry.xs.push(p.x); entry.ys.push(p.y); }
    if (hasMap) entry.outdoor = true;
  }
}

const result = [];
for (const [town, { xs, ys, outdoor }] of byTown) {
  const cx = Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
  const cy = Math.round(ys.reduce((a, b) => a + b, 0) / ys.length);
  result.push({ town, x: cx, y: cy, outdoor });
}

// Sort by town name for readability
result.sort((a, b) => a.town.localeCompare(b.town));

fs.writeFileSync(OUT_FILE, JSON.stringify(result, null, 2));
console.log(`Wrote ${result.length} map regions to ${OUT_FILE}`);
for (const r of result) {
  console.log(`  ${r.outdoor ? '[outdoor]' : '[indoor] '} ${r.town} @ (${r.x}, ${r.y})`);
}
