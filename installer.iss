[Setup]
AppName=BookVoice
AppVersion=1.0.0
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
; The executable
Source: "dist\Launcher.exe"; DestDir: "{app}"; Flags: ignoreversion

; Backend (including .venv and static frontend files)
Source: "backend\*"; DestDir: "{app}\backend"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\BookVoice"; Filename: "{app}\Launcher.exe"
Name: "{group}\{cm:UninstallProgram,BookVoice}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\BookVoice"; Filename: "{app}\Launcher.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\Launcher.exe"; Description: "{cm:LaunchProgram,BookVoice}"; Flags: nowait postinstall skipifsilent
