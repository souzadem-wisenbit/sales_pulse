@echo off
rem Abre o SalesPulse Mission Control (app desktop).
rem ELECTRON_RUN_AS_NODE vem "sujo" quando aberto de dentro do VS Code — limpar.
set ELECTRON_RUN_AS_NODE=
cd /d "%~dp0"
start "" "node_modules\electron\dist\electron.exe" .
