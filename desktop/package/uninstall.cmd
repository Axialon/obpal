@echo off
setlocal
rem Removes ob.Pal Desktop: its browser registration, its settings and its files in this folder. A helper the
rem browser is running stops by itself once it is unregistered, so the browser can stay open.
rem   uninstall.cmd       asks first
rem   uninstall.cmd /y    doesn't ask
set "DIR=%~dp0"
set "DIR=%DIR:~0,-1%"
set "EXE=%DIR%\obpal-desktop.exe"
if not exist "%EXE%" goto missing
echo ob.Pal Desktop
echo.
echo This removes ob.Pal Desktop from this PC: its browser registration, its settings
echo (allowed programs, Whole PC, pause) and its files in this folder.
echo.
if /i "%~1"=="/y" goto remove
choice /c YN /n /m "Remove it? [Y/N] "
if errorlevel 2 exit /b 0
:remove
echo.
"%EXE%" uninstall --purge
if errorlevel 1 goto failed
rem Wait for a helper the browser started to notice and stop (about a second), then remove the files.
set /a tries=0
:wait
del /q "%EXE%" >nul 2>&1
if not exist "%EXE%" goto gone
set /a tries+=1
if %tries% geq 15 goto busy
ping -n 2 127.0.0.1 >nul
goto wait
:gone
for %%f in (install.cmd README.txt LICENSE.txt net.blackboxes.obpal.json) do del /q "%DIR%\%%f" >nul 2>&1
cd /d "%TEMP%"
echo.
echo ob.Pal Desktop is removed.
ping -n 3 127.0.0.1 >nul
rem Last, this script and the folder (only if nothing else is in it). The line runs after the script has ended.
(goto) 2>nul & del /q "%~f0" & rd "%DIR%" 2>nul
:busy
echo.
echo ob.Pal Desktop is still in use. Close the browser, then run this again.
pause
exit /b 1
:missing
echo obpal-desktop.exe isn't in this folder: nothing to remove here.
pause
exit /b 1
:failed
echo.
echo Something went wrong (see above). Nothing else was removed.
pause
exit /b 1
