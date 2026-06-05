'use strict';

const path = require('path');

// Pre-built from server item XML via build-data.js.
// Only non-default values are stored (default = 40 WU for melee weapons).
const RANGES = require(path.join(__dirname, '../../public/data/weapon_ranges.json'));

const DEFAULT_RANGE = 40;

function getWeaponRange(itemId) {
  if (!itemId) return DEFAULT_RANGE;
  return RANGES[itemId] || DEFAULT_RANGE;
}

// Map form for callers that need iteration
const WEAPON_RANGE = new Map(
  Object.entries(RANGES).map(([k, v]) => [parseInt(k, 10), v])
);

module.exports = { getWeaponRange, WEAPON_RANGE };
