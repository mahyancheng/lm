@echo off
REM Manus-Local Installer for Windows
REM This script will install Manus-Local on your system

echo [92m=====================================================
echo        Manus-Local Installer for Windows Systems       
echo =====================================================
echo.[0m
echo [92mThis installer will set up Manus-Local, a locally hosted
echo AI assistant powered by Ollama with Qwen2.5:32b-instruct model.[0m
echo.
echo [93mThe installation will:
echo 1. Check and install required dependencies
echo 2. Guide you to install Ollama if not already installed
echo 3. Set up Manus-Local in your user directory
echo 4. Create desktop and Start Menu shortcuts[0m
echo.
pause

REM Check system requirements
echo [92mChecking system requirements...[0m

REM Check Python version
python --version > nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [91mPython is not installed or not in PATH.[0m
    echo [93mPlease download and install Python 3.8 or higher from:
    echo https://www.python.org/downloads/
    echo.
    echo Be sure to check "Add Python to PATH" during installation.[0m
    echo.
    echo [93mWould you like to open the Python download page now?[0m
    choice /C YN /M "Open Python download page"
    if %ERRORLEVEL% EQU 1 (
        start https://www.python.org/downloads/
        echo [93mAfter installing Python, please restart this installer.[0m
        pause
        exit /b 1
    ) else (
        echo [93mPlease install Python manually and restart this installer.[0m
        pause
        exit /b 1
    )
)

for /f "tokens=2" %%I in ('python --version 2^>^&1') do set PYTHON_VERSION=%%I
echo [92mFound Python %PYTHON_VERSION%[0m

REM Check if Python version is at least 3.8
python -c "import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)" > nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [91mPython version must be at least 3.8. Please upgrade Python and try again.[0m
    pause
    exit /b 1
)
echo [92mPython version is sufficient (3.8+)[0m

REM Check Node.js version
node --version > nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [91mNode.js is not installed or not in PATH.[0m
    echo [93mPlease download and install Node.js 14 or higher from:
    echo https://nodejs.org/
    echo.[0m
    echo [93mWould you like to open the Node.js download page now?[0m
    choice /C YN /M "Open Node.js download page"
    if %ERRORLEVEL% EQU 1 (
        start https://nodejs.org/
        echo [93mAfter installing Node.js, please restart this installer.[0m
        pause
        exit /b 1
    ) else (
        echo [93mPlease install Node.js manually and restart this installer.[0m
        pause
        exit /b 1
    )
)

for /f "tokens=1" %%I in ('node --version') do set NODE_VERSION=%%I
echo [92mFound Node.js %NODE_VERSION%[0m

REM Check if Node.js version is at least 14
node -e "process.exit(process.version.slice(1).split('.')[0] >= 14 ? 0 : 1)" > nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [91mNode.js version must be at least 14. Please upgrade Node.js and try again.[0m
    pause
    exit /b 1
)
echo [92mNode.js version is sufficient (14+)[0m

REM Check if Ollama is installed
ollama --version > nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [91mOllama is not installed or not in PATH.[0m
    echo [93mPlease download and install Ollama from:
    echo https://ollama.ai/download
    echo.[0m
    echo [93mWould you like to open the Ollama download page now?[0m
    choice /C YN /M "Open Ollama download page"
    if %ERRORLEVEL% EQU 1 (
        start https://ollama.ai/download
        echo [93mAfter installing Ollama, please restart this installer.[0m
        pause
        exit /b 1
    ) else (
        echo [93mPlease install Ollama manually and restart this installer.[0m
        pause
        exit /b 1
    )
)
echo [92mOllama is installed.[0m

REM Create installation directory
set INSTALL_DIR=%USERPROFILE%\.manus-local
echo [92mCreating installation directory: %INSTALL_DIR%[0m
if not exist "%INSTALL_DIR%" mkdir "%INSTALL_DIR%"

REM Extract application files
echo [92mExtracting application files...[0m
set SCRIPT_DIR=%~dp0
powershell -Command "Expand-Archive -Path '%SCRIPT_DIR%manus-local-app.zip' -DestinationPath '%INSTALL_DIR%' -Force"

REM Install Python dependencies
echo [92mInstalling Python dependencies...[0m
cd /d "%INSTALL_DIR%\backend"
python -m pip install -r requirements.txt

REM Create startup script
echo [92mCreating startup script...[0m
cd /d "%INSTALL_DIR%"
echo @echo off > start.bat
echo REM Startup script for Manus-Local >> start.bat
echo. >> start.bat
echo echo Starting Manus-Local... >> start.bat
echo. >> start.bat
echo REM Check if Ollama is running >> start.bat
echo tasklist /FI "IMAGENAME eq ollama.exe" 2^>NUL | find /I /N "ollama.exe" ^>NUL >> start.bat
echo if "%%ERRORLEVEL%%"=="1" ( >> start.bat
echo     echo Starting Ollama... >> start.bat
echo     start "" ollama serve >> start.bat
echo     REM Wait for Ollama to start >> start.bat
echo     timeout /t 5 /nobreak ^> nul >> start.bat
echo ) >> start.bat
echo. >> start.bat
echo REM Check if the model is available, download if not >> start.bat
echo ollama list | findstr "qwen2.5:32b-instruct" ^> nul >> start.bat
echo if "%%ERRORLEVEL%%"=="1" ( >> start.bat
echo     echo Downloading Qwen2.5:32b-instruct model ^(this may take a while^)... >> start.bat
echo     ollama pull qwen2.5:32b-instruct >> start.bat
echo ) >> start.bat
echo. >> start.bat
echo REM Start the backend >> start.bat
echo echo Starting Manus-Local backend... >> start.bat
echo cd /d "%%~dp0backend" >> start.bat
echo start /B python main.py >> start.bat
echo. >> start.bat
echo REM Wait for backend to start >> start.bat
echo timeout /t 2 /nobreak ^> nul >> start.bat
echo. >> start.bat
echo REM Open the application in the default browser >> start.bat
echo echo Opening Manus-Local in your browser... >> start.bat
echo start http://localhost:8000 >> start.bat
echo. >> start.bat
echo echo Manus-Local is running. Close this window to stop the application. >> start.bat
echo pause >> start.bat

REM Create shortcut on desktop
echo [92mCreating desktop shortcut...[0m
powershell -Command "$WshShell = New-Object -comObject WScript.Shell; $Shortcut = $WshShell.CreateShortcut([System.IO.Path]::Combine($env:USERPROFILE, 'Desktop', 'Manus-Local.lnk')); $Shortcut.TargetPath = [System.IO.Path]::Combine('%INSTALL_DIR%', 'start.bat'); $Shortcut.WorkingDirectory = '%INSTALL_DIR%'; $Shortcut.Description = 'Local AI assistant powered by Ollama'; $Shortcut.IconLocation = [System.IO.Path]::Combine('%INSTALL_DIR%', 'frontend', 'dist', 'favicon.ico'); $Shortcut.Save()"

REM Create Start Menu shortcut
echo [92mCreating Start Menu shortcut...[0m
powershell -Command "$WshShell = New-Object -comObject WScript.Shell; $Shortcut = $WshShell.CreateShortcut([System.IO.Path]::Combine($env:APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Manus-Local.lnk')); $Shortcut.TargetPath = [System.IO.Path]::Combine('%INSTALL_DIR%', 'start.bat'); $Shortcut.WorkingDirectory = '%INSTALL_DIR%'; $Shortcut.Description = 'Local AI assistant powered by Ollama'; $Shortcut.IconLocation = [System.IO.Path]::Combine('%INSTALL_DIR%', 'frontend', 'dist', 'favicon.ico'); $Shortcut.Save()"

echo.
echo [92m=====================================================
echo        Manus-Local Installation Complete!            
echo =====================================================
echo You can start Manus-Local by:
echo 1. Clicking the desktop shortcut
echo 2. Searching for 'Manus-Local' in the Start Menu
echo 3. The application will be available at http://localhost:8000
echo.
echo Note: The first time you run the application, it will download
echo the Qwen2.5:32b-instruct model, which may take some time
echo depending on your internet connection.
echo.
echo Thank you for installing Manus-Local![0m
echo.
pause
