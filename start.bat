@echo off
rem Starts the local server and opens the app in the default browser.
cd /d "%~dp0"
start "" http://localhost:5173
node server.js
