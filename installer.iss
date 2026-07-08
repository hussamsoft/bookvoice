[Setup]
AppName=BookVoice
AppVersion=1.1.0
AppPublisher=Hussamsoft
DefaultDirName={autopf}\BookVoice
DefaultGroupName=BookVoice
UninstallDisplayIcon={app}\Launcher.exe
Compression=lzma2/fast
SolidCompression=yes
OutputDir=.\installer
OutputBaseFilename=BookVoice_Setup
PrivilegesRequired=lowest
ArchitecturesInstallIn64BitMode=x64compatible

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
; Backend entry point
Source: "dist\main.py"; DestDir: "{app}"; Flags: ignoreversion
; Backend routes & services
Source: "dist\routes\*"; DestDir: "{app}\routes"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "dist\services\*"; DestDir: "{app}\services"; Flags: ignoreversion recursesubdirs createallsubdirs
; Compiled frontend
Source: "dist\static\*"; DestDir: "{app}\static"; Flags: ignoreversion recursesubdirs createallsubdirs
; Supporting files
Source: "dist\requirements.txt"; DestDir: "{app}"; Flags: ignoreversion
Source: "dist\setup_venv.bat"; DestDir: "{app}"; Flags: ignoreversion
Source: "dist\RUN.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "dist\bookvoice.ico"; DestDir: "{app}"; Flags: ignoreversion
Source: "dist\favicon.svg"; DestDir: "{app}"; Flags: ignoreversion
Source: "dist\icons.svg"; DestDir: "{app}"; Flags: ignoreversion
; Launcher executable
Source: "dist\Launcher.exe"; DestDir: "{app}"; Flags: ignoreversion
; Default config (only if not already present)
Source: "dist\.env.example"; DestDir: "{app}"; DestName: ".env"; Flags: ignoreversion onlyifdoesntexist

[Icons]
Name: "{group}\BookVoice"; Filename: "{app}\Launcher.exe"
Name: "{group}\{cm:UninstallProgram,BookVoice}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\BookVoice"; Filename: "{app}\Launcher.exe"; Tasks: desktopicon

[Run]
; Create the Python virtual environment and install backend dependencies.
; Skips if the user has no Python/uv; they can run setup_venv.bat manually later.
Filename: "{app}\setup_venv.bat"; Description: "Set up Python environment (installs dependencies)"; Flags: nowait postinstall skipifsilent runascurrentuser
Filename: "{app}\Launcher.exe"; Description: "{cm:LaunchProgram,BookVoice}"; Flags: nowait postinstall skipifsilent
