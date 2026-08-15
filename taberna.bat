@echo off
rem Panel de control de La Taberna del Mago (Windows)
rem Doble clic y elige opcion. Cierra el bot con Ctrl+C dentro de la opcion 1.

chcp 65001 >nul
cd /d "%~dp0"
title La Taberna del Mago - Panel

rem -- Comprobacion rapida de entorno --
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [ERROR] No se encuentra Node.js en el PATH.
  echo   Instalalo desde https://nodejs.org o con NodeSource y vuelve a intentarlo.
  echo.
  pause
  exit /b 1
)

if not exist .env (
  echo.
  echo   [ERROR] Falta el archivo .env en esta carpeta.
  echo.
  pause
  exit /b 1
)

:menu
cls
echo.
echo   ==========================================
echo     LA TABERNA DEL MAGO - Panel (tu PC)
echo   ==========================================
echo.
echo     1. Iniciar el bot            (npm start)
echo     2. Registrar comandos        (npm run deploy)
echo     3. Sincronizar Twitch (CLI)  (npm run twitch-auth)
echo     4. Salir
echo.
set /p opcion=  Elige una opcion [1-4]:

if "%opcion%"=="1" goto iniciar
if "%opcion%"=="2" goto registrar
if "%opcion%"=="3" goto twitch
if "%opcion%"=="4" exit /b 0
goto menu

:iniciar
cls
echo.
echo   Iniciando La Taberna del Mago... (Ctrl+C para detenerla)
echo.
call npm start
echo.
echo   El bot se ha detenido.
pause
goto menu

:registrar
cls
echo.
echo   Registrando comandos de barra en Discord...
echo.
call npm run deploy
echo.
pause
goto menu

:twitch
cls
echo.
echo   Sincronizando Twitch por terminal...
echo   (Cuando salga el enlace, abrelo e inicia sesion con la cuenta DEL CANAL)
echo.
call npm run twitch-auth
echo.
pause
goto menu
