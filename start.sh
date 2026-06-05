#!/bin/bash
cd "$(dirname "$0")"

if [ ! -d node_modules ]; then
  echo "Installiere npm-Pakete..."
  npm install
fi

if [ ! -f public/data/npc_names.json ] || [ ! -f public/data/skill_names.json ] || \
   [ ! -f public/data/item_names.json ] || [ ! -f public/data/skill_ranges.json ] || \
   [ ! -f public/data/weapon_ranges.json ] || [ ! -f public/data/zones.json ]; then
  echo "Erstelle Daten-Lookup-Tabellen..."
  node build-data.js
fi

echo "L2Bot startet auf http://localhost:3001"
node server.js
