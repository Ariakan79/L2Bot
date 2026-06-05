'use strict';

const fs   = require('fs');
const path = require('path');

const GEO_DIR     = process.env.L2_GEO_DIR || '/mnt/Games/Lineage2/geodata/geodata';
const WORLD_MIN_X = -655360;
const WORLD_MIN_Y = -589824;
const CELL_SIZE   = 16;          // world units per geo cell
const REGION_CELLS = 2048;       // geo cells per region (256 blocks × 8 cells)

// NSWE bit constants (same as L2J Cell.java)
const NSWE_EAST  = 0x1;
const NSWE_WEST  = 0x2;
const NSWE_SOUTH = 0x4;
const NSWE_NORTH = 0x8;
const NSWE_ALL   = 0xF;

const regionCache = new Map(); // 'rx_ry' → IBlock[] or null (no file)

function worldToGeo(wx, wy) {
  return {
    gx: Math.floor((wx - WORLD_MIN_X) / CELL_SIZE),
    gy: Math.floor((wy - WORLD_MIN_Y) / CELL_SIZE),
  };
}

function geoToRegion(gx, gy) {
  return { rx: Math.floor(gx / REGION_CELLS), ry: Math.floor(gy / REGION_CELLS) };
}

function loadRegion(rx, ry) {
  const key = `${rx}_${ry}`;
  if (regionCache.has(key)) return regionCache.get(key);

  const fpath = path.join(GEO_DIR, `${rx}_${ry}.l2j`);
  if (!fs.existsSync(fpath)) {
    regionCache.set(key, null);
    return null;
  }

  const buf = fs.readFileSync(fpath);
  let off = 0;
  const blocks = new Array(65536); // 256×256

  for (let bx = 0; bx < 256; bx++) {
    for (let by = 0; by < 256; by++) {
      const type = buf[off++];
      const idx  = bx * 256 + by;
      if (type === 0) {
        // FLAT — 2 bytes height, all cells fully passable
        const height = buf.readInt16LE(off); off += 2;
        blocks[idx] = { type: 0, height };
      } else if (type === 1) {
        // COMPLEX — 64 × int16LE, bits[3:0]=NSWE bits[15:4]=height*2
        const cells = new Int16Array(64);
        for (let c = 0; c < 64; c++) { cells[c] = buf.readInt16LE(off); off += 2; }
        blocks[idx] = { type: 1, cells };
      } else if (type === 2) {
        // MULTILAYER — per cell: 1 byte nLayers + nLayers×int16LE
        const cellLayers = new Array(64);
        for (let c = 0; c < 64; c++) {
          const nLayers = buf[off++];
          const layers  = new Int16Array(nLayers);
          for (let l = 0; l < nLayers; l++) { layers[l] = buf.readInt16LE(off); off += 2; }
          cellLayers[c] = layers;
        }
        blocks[idx] = { type: 2, cells: cellLayers };
      } else {
        throw new Error(`Unknown block type ${type} at block [${bx},${by}]`);
      }
    }
  }

  regionCache.set(key, blocks);
  return blocks;
}

function getNsweAt(gx, gy, worldZ) {
  const { rx, ry } = geoToRegion(gx, gy);
  const blocks = loadRegion(rx, ry);
  if (!blocks) return NSWE_ALL;

  const lgx = gx % REGION_CELLS;
  const lgy = gy % REGION_CELLS;
  const block = blocks[Math.floor(lgx / 8) * 256 + Math.floor(lgy / 8)];
  if (!block) return NSWE_ALL;
  if (block.type === 0) return NSWE_ALL;

  const cellIdx = (lgx % 8) * 8 + (lgy % 8);

  if (block.type === 1) {
    return block.cells[cellIdx] & 0x0F;
  }

  // MULTILAYER: pick layer nearest worldZ
  const layers = block.cells[cellIdx];
  if (!layers || layers.length === 0) return NSWE_ALL;
  let best = layers[0], bestDz = Infinity;
  for (const v of layers) {
    const dz = Math.abs(((v & 0xFFF0) >> 1) - worldZ);
    if (dz < bestDz) { bestDz = dz; best = v; }
  }
  return best & 0x0F;
}

/**
 * Build an NSWE grid for a viewport around (worldX, worldY).
 * Returns a compact Buffer (flat byte array, x-major) and metadata.
 * halfCells: how many geo cells to include in each direction from center.
 */
function getGeoGrid(worldX, worldY, worldZ, halfCells = 100) {
  const { gx: cgx, gy: cgy } = worldToGeo(worldX, worldY);
  const gx0 = cgx - halfCells;
  const gy0 = cgy - halfCells;
  const W   = halfCells * 2 + 1;
  const H   = halfCells * 2 + 1;

  // Pre-load all touched regions synchronously
  const rx0 = Math.floor(gx0 / REGION_CELLS);
  const rx1 = Math.floor((gx0 + W - 1) / REGION_CELLS);
  const ry0 = Math.floor(gy0 / REGION_CELLS);
  const ry1 = Math.floor((gy0 + H - 1) / REGION_CELLS);
  for (let rx = rx0; rx <= rx1; rx++)
    for (let ry = ry0; ry <= ry1; ry++)
      loadRegion(rx, ry);

  const data = Buffer.alloc(W * H);

  for (let dx = 0; dx < W; dx++) {
    for (let dy = 0; dy < H; dy++) {
      const gx  = gx0 + dx;
      const gy  = gy0 + dy;
      const { rx, ry } = geoToRegion(gx, gy);
      const blocks = regionCache.get(`${rx}_${ry}`) || null;
      let nswe = NSWE_ALL;

      if (blocks) {
        const lgx   = gx % REGION_CELLS;
        const lgy   = gy % REGION_CELLS;
        const block = blocks[Math.floor(lgx / 8) * 256 + Math.floor(lgy / 8)];
        if (block && block.type !== 0) {
          const cellIdx = (lgx % 8) * 8 + (lgy % 8);
          if (block.type === 1) {
            nswe = block.cells[cellIdx] & 0x0F;
          } else {
            const layers = block.cells[cellIdx];
            if (layers && layers.length > 0) {
              let best = layers[0], bestDz = Infinity;
              for (const v of layers) {
                const dz = Math.abs(((v & 0xFFF0) >> 1) - worldZ);
                if (dz < bestDz) { bestDz = dz; best = v; }
              }
              nswe = best & 0x0F;
            }
          }
        }
      }

      data[dx * H + dy] = nswe;
    }
  }

  return {
    gx0, gy0, W, H,
    worldMinX: WORLD_MIN_X,
    worldMinY: WORLD_MIN_Y,
    cellSize: CELL_SIZE,
    data,       // raw Buffer
  };
}

/**
 * BFS pathfinding over geodata. Returns an array of world-coordinate waypoints
 * from (fromX,fromY) to (toX,toY), thinned to one point every ~3 cells.
 * Returns null if no path found within maxRadius geo cells.
 */
function findPath(fromX, fromY, fromZ, toX, toY, toZ, maxRadius = 60) {
  const { gx: sx, gy: sy } = worldToGeo(fromX, fromY);
  const { gx: ex, gy: ey } = worldToGeo(toX, toY);
  const dx0 = ex - sx, dy0 = ey - sy;
  if (Math.hypot(dx0, dy0) > maxRadius) return null;

  // Pre-load all touched regions
  const rx0 = Math.floor(Math.min(sx, ex) / REGION_CELLS);
  const rx1 = Math.floor(Math.max(sx, ex) / REGION_CELLS);
  const ry0 = Math.floor(Math.min(sy, ey) / REGION_CELLS);
  const ry1 = Math.floor(Math.max(sy, ey) / REGION_CELLS);
  for (let rx = rx0; rx <= rx1; rx++)
    for (let ry = ry0; ry <= ry1; ry++)
      loadRegion(rx, ry);

  // BFS with parent tracking
  const parent = new Map();
  const startKey = sx + ',' + sy;
  parent.set(startKey, null);
  const queue = [[sx, sy]];
  const DIRS = [[0, 1, 0x8], [0, -1, 0x4], [1, 0, 0x1], [-1, 0, 0x2]]; // [dx,dy,requiredNSWE]
  const cap = maxRadius * maxRadius * 4;
  let hasObstacle = false; // true if any cell blocked at least one direction

  while (queue.length) {
    const [gx, gy] = queue.shift();
    if (Math.abs(gx - ex) <= 1 && Math.abs(gy - ey) <= 1) {
      // Open terrain — no walls encountered, direct moveTo is smoother
      if (!hasObstacle) return null;
      // Reconstruct path
      const cells = [];
      let key = gx + ',' + gy;
      while (key !== null) {
        cells.unshift(key);
        key = parent.get(key);
      }
      // Convert to world coords, thin to every 3rd cell
      return cells
        .filter((_, i) => i % 3 === 0 || i === cells.length - 1)
        .map(k => {
          const [cgx, cgy] = k.split(',').map(Number);
          return {
            x: Math.round(cgx * CELL_SIZE + WORLD_MIN_X + CELL_SIZE / 2),
            y: Math.round(cgy * CELL_SIZE + WORLD_MIN_Y + CELL_SIZE / 2),
            z: fromZ,
          };
        });
    }
    const nswe = getNsweAt(gx, gy, fromZ);
    if (nswe !== NSWE_ALL) hasObstacle = true;
    for (const [ddx, ddy, bit] of DIRS) {
      if (!(nswe & bit)) continue;
      const key = (gx + ddx) + ',' + (gy + ddy);
      if (!parent.has(key)) {
        parent.set(key, gx + ',' + gy);
        queue.push([gx + ddx, gy + ddy]);
      }
    }
    if (parent.size > cap) break;
  }
  return null;
}

module.exports = { getGeoGrid, getNsweAt, worldToGeo, findPath, WORLD_MIN_X, WORLD_MIN_Y, CELL_SIZE };
