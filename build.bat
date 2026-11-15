@echo off
rem Builds Poly Amp into the dist folder: a single self-contained PolyAmp.exe (the .NET runtime is inside)
rem plus the lib, licenses and ui folders, so dist can be zipped and run on any Windows 10/11 x64 machine.
rem Requires the .NET 10 SDK, and Visual Studio with the C++ tools for the NAM library.
cd /d "%~dp0"
rem The NAM library is built once; delete native\namcore\bin to rebuild it.
if not exist native\namcore\bin\namcore-sse2.dll call native\namcore\build.bat
if errorlevel 1 (echo Building the NAM library failed. & pause & exit /b 1)
rem dist holds only build output (settings live in %LOCALAPPDATA%\Lad), so it is rebuilt from scratch
if exist dist rmdir /s /q dist
dotnet publish native\Lad.csproj -c Release -p:Platform=x64 -o dist --nologo
if errorlevel 1 pause
