@echo off
rem Builds the NAM library: the official NeuralAmpModelerCore plus a thin C wrapper, in two variants:
rem   bin\namcore.dll       - with AVX2/FMA (fast; almost every CPU since 2013-2015)
rem   bin\namcore-sse2.dll  - baseline x64 (fallback for older CPUs; the app picks the right one at startup)
rem Requires Visual Studio with the C++ tools. Sources: ..\third_party\NeuralAmpModelerCore
setlocal
cd /d "%~dp0"

set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" (echo vswhere.exe not found - is Visual Studio installed? & exit /b 1)
for /f "usebackq tokens=*" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VSDIR=%%i"
if not defined VSDIR (echo Visual Studio C++ tools not found & exit /b 1)
call "%VSDIR%\VC\Auxiliary\Build\vcvars64.bat" >nul
if errorlevel 1 (echo vcvars64.bat failed & exit /b 1)

set "CORE=..\third_party\NeuralAmpModelerCore"
if not exist "%CORE%\NAM\dsp.h" (echo NeuralAmpModelerCore sources not found in %CORE% - run: git submodule update --init --recursive & exit /b 1)
if not exist bin mkdir bin

call :build avx2 "/arch:AVX2" namcore.dll || exit /b 1
call :build sse2 "" namcore-sse2.dll || exit /b 1
echo NAM library built: bin\namcore.dll, bin\namcore-sse2.dll
exit /b 0

:build
if not exist obj\%1 mkdir obj\%1
cl /nologo /std:c++20 /O2 /Ob3 /Oi /Ot /GL /Gy /Gw /EHsc /MT /LD /MP /bigobj %~2 /W0 ^
  /DNDEBUG /DNAM_SAMPLE_FLOAT /DNAM_ENABLE_A2_FAST /DNOMINMAX /DWIN32_LEAN_AND_MEAN ^
  /I "%CORE%" /I "%CORE%\Dependencies\eigen" /I "%CORE%\Dependencies\nlohmann" ^
  /Fo"obj\%1\\" /Fe"bin\%3" ^
  namcore.cpp "%CORE%\NAM\*.cpp" "%CORE%\NAM\wavenet\*.cpp"
exit /b %errorlevel%
