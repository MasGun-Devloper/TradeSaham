#!/bin/bash
echo ""
echo "  ╔══════════════════════════════════════════╗"
echo "  ║   StockDSS v7.0 — IDX Professional       ║"
echo "  ║   6-Layer Signal Engine                   ║"
echo "  ╚══════════════════════════════════════════╝"
echo ""
cd "$(dirname "$0")/backend"
if [ ! -d "node_modules" ]; then
  echo "  📦 Installing dependencies..."
  npm install
fi
echo "  🚀 Starting server at http://localhost:3000"
echo ""
node server.js
