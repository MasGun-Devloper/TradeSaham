@echo off
echo.
echo   StockDSS v7.0 — IDX Professional Signal Engine
echo   6-Layer Signal System
echo.
cd /d "%~dp0backend"
if not exist "node_modules" (
  echo   Installing dependencies...
  npm install
)
echo   Starting server at http://localhost:3000
echo.
node server.js
pause
