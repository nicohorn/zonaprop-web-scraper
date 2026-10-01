@echo off
rem Doble clic para usar el scraper: prepara lo que falte (la primera vez), levanta la
rem interfaz y la abre en el navegador. Cerrar esta ventana detiene todo.
setlocal EnableExtensions
cd /d "%~dp0"
title ZonaProp Scraper

set "NODE_VER=v24.21.0"
set "NODE_DIR=%~dp0.runtime\node-%NODE_VER%-win-x64"
set "SYS=%SystemRoot%\System32"

rem --- 1) Node.js: el instalado si sirve (22.12 o mas nuevo); si no, uno portable en .runtime
set "NODE_OK="
where node >nul 2>nul && node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=12)?0:1)" >nul 2>nul && set "NODE_OK=1"
if defined NODE_OK goto deps
if exist "%NODE_DIR%\node.exe" goto portable

echo.
echo  Preparando por primera vez: descargo Node.js portable (unos 35 MB)...
echo.
if not exist ".runtime" mkdir ".runtime"
"%SYS%\curl.exe" -L --fail -o ".runtime\node.zip" "https://nodejs.org/dist/%NODE_VER%/node-%NODE_VER%-win-x64.zip"
if errorlevel 1 goto fail_download
"%SYS%\tar.exe" -xf ".runtime\node.zip" -C ".runtime"
if errorlevel 1 goto fail_download
del ".runtime\node.zip"

:portable
set "PATH=%NODE_DIR%;%PATH%"

rem --- 2) Dependencias (solo si faltan)
:deps
if exist "node_modules\puppeteer\package.json" if exist "node_modules\cheerio\package.json" if exist "node_modules\csv-stringify\package.json" goto run

echo.
echo  Preparando por primera vez: instalo los componentes (puede tardar unos minutos)...
echo.
rem Con Chrome instalado no hace falta bajar el Chromium de Puppeteer (150 MB)
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "PUPPETEER_SKIP_DOWNLOAD=1"
if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "PUPPETEER_SKIP_DOWNLOAD=1"
if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" set "PUPPETEER_SKIP_DOWNLOAD=1"
call npm install --omit=dev --no-audit --no-fund
if errorlevel 1 goto fail_install

rem --- 3) Interfaz
:run
node src\server.js --open
if errorlevel 1 goto fail_run
exit /b 0

:fail_download
echo.
echo  No pude descargar Node.js. Revisa la conexion a internet y volve a intentar,
echo  o instalalo a mano desde https://nodejs.org (version LTS).
goto end
:fail_install
echo.
echo  Fallo la instalacion de componentes. Revisa la conexion a internet y volve a intentar.
goto end
:fail_run
echo.
echo  El programa termino con un error (ver arriba).
:end
echo.
pause
exit /b 1
