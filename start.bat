@echo off
setlocal enabledelayedexpansion

if exist .dev.vars goto install

echo.
echo  OC Level Maintainer
echo  --------------------
echo.
set /p PASS=  Browser password (blank is fine when only you can reach this PC):
set /p KEY=  API key (copy this into the maintainer OC config.lua):
set /p PORT=  Port [3000]:
if "!PORT!"=="" set PORT=3000

(
  echo BROWSER_PASSWORD=!PASS!
  echo API_KEY=!KEY!
  echo LOCAL=1
  echo PORT=!PORT!
) > .dev.vars

echo.
echo  Saved to .dev.vars
echo.

:install
for /f "tokens=2 delims==" %%a in ('findstr /b "PORT=" .dev.vars') do set PORT=%%a
if "!PORT!"=="" set PORT=3000

if not exist node_modules (
  echo  Installing dependencies...
  call npm install
  echo.
)

echo  Starting on http://localhost:!PORT!
echo.
call npx wrangler dev --port !PORT!

pause
