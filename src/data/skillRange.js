'use strict';

const path = require('path');

// Pre-built from server skill XML via build-data.js.
// Only non-default values are stored (default = 40 WU for melee/buff skills).
const RANGES = require(path.join(__dirname, '../../public/data/skill_ranges.json'));

const DEFAULT_RANGE = 40;

function getSkillRange(skillId) {
  if (!skillId) return DEFAULT_RANGE;
  return RANGES[skillId] || DEFAULT_RANGE;
}

module.exports = { getSkillRange };
