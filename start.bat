@echo off
setlocal enabledelayedexpansion

if exist server\.env goto install

echo.
echo  OC Level Maintainer
echo  --------------------
echo.
set /p PASS=  Browser password:
set /p KEY=  API key (copy this into connector\config.lua):
set /p PORT=  Port [3000]:
if "!PORT!"=="" set PORT=3000

(
  echo BROWSER_PASSWORD=!PASS!
  echo API_KEY=!KEY!
  echo PORT=!PORT!
) > server\.env

echo.
echo  Saved to server\.env
echo.

:install
if not exist server\node_modules (
  echo  Installing server dependencies...
  pushd server
  npm install
  popd
  echo.
)
if not exist client\node_modules (
  echo  Installing client dependencies...
  pushd client
  npm install
  popd
  echo.
)

echo  Building client...
pushd client
call npm run build
popd

echo.
echo  Starting server...
echo.
pushd server
node index.js
popd

pause
