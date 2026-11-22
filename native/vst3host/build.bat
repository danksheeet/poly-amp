@echo off
rem Builds the VST3 host library: bin\vst3host.dll, a thin C wrapper around the official VST3 SDK
rem (hosting helpers from public.sdk). Requires Visual Studio with the C++ tools.
rem Sources: ..\third_party\vst3 (pluginterfaces, base, public.sdk - git submodules, MIT license)
setlocal
cd /d "%~dp0"

set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" (echo vswhere.exe not found - is Visual Studio installed? & exit /b 1)
for /f "usebackq tokens=*" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VSDIR=%%i"
if not defined VSDIR (echo Visual Studio C++ tools not found & exit /b 1)
call "%VSDIR%\VC\Auxiliary\Build\vcvars64.bat" >nul
if errorlevel 1 (echo vcvars64.bat failed & exit /b 1)

set "SDK=..\third_party\vst3"
if not exist "%SDK%\pluginterfaces\base\funknown.h" (echo VST3 SDK sources not found in %SDK% - run: git submodule update --init --recursive & exit /b 1)
if not exist bin mkdir bin
if not exist obj mkdir obj

set "H=%SDK%\public.sdk\source\vst\hosting"
cl /nologo /std:c++17 /O2 /EHsc /MT /LD /MP /W0 /utf-8 ^
  /DNDEBUG /DRELEASE=1 /DUNICODE /D_UNICODE /DNOMINMAX /DWIN32_LEAN_AND_MEAN ^
  /I "%SDK%" ^
  /Fo"obj\\" /Fe"bin\vst3host.dll" ^
  vst3host.cpp ^
  "%H%\module.cpp" "%H%\module_win32.cpp" "%H%\hostclasses.cpp" "%H%\pluginterfacesupport.cpp" ^
  "%H%\plugprovider.cpp" "%H%\connectionproxy.cpp" "%H%\parameterchanges.cpp" "%H%\processdata.cpp" ^
  "%H%\eventlist.cpp" ^
  "%SDK%\public.sdk\source\common\memorystream.cpp" "%SDK%\public.sdk\source\common\commoniids.cpp" ^
  "%SDK%\public.sdk\source\common\commonstringconvert.cpp" "%SDK%\public.sdk\source\common\threadchecker_win32.cpp" ^
  "%SDK%\public.sdk\source\vst\utility\stringconvert.cpp" "%SDK%\public.sdk\source\vst\vstinitiids.cpp" ^
  "%SDK%\pluginterfaces\base\coreiids.cpp" "%SDK%\pluginterfaces\base\funknown.cpp" ^
  "%SDK%\pluginterfaces\base\ustring.cpp" "%SDK%\pluginterfaces\base\conststringtable.cpp" ^
  ole32.lib shell32.lib user32.lib
if errorlevel 1 exit /b 1
echo VST3 host built: bin\vst3host.dll
exit /b 0
