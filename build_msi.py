#!/usr/bin/env python3
"""
Build the Windows MSI installer for BookVoice using the vendored WiX Toolset
(tools/wix).

Design:
  * Installs the read-only app into Program Files (perMachine, requires admin).
  * The launcher stores its writable state (.venv, data/sessions, data/voices)
    in %%LocalAppData%%\\BookVoice, so no admin rights are needed at runtime.
  * Ships the built dist/ excluding machine-specific .venv and runtime data
    (sessions/voices). Default voice seeds are included.
  * Uses the WixUI_InstallDir wizard (Welcome -> License -> Install Folder ->
    Confirm -> Progress -> Finish).

Run from the repo root:  python build_msi.py
"""
from __future__ import annotations

import os
import subprocess
from pathlib import Path
from xml.etree import ElementTree as ET

ROOT = Path(__file__).resolve().parent
DIST = ROOT / "dist"
OUT = ROOT / "installer"
WIX_BIN = ROOT / "tools" / "wix"
UPGRADE_CODE = "{E3B3C1A2-1C2D-4F0E-9A1B-1234567890AB}"
PRODUCT_VERSION = "1.4.0"

NS = "http://schemas.microsoft.com/wix/2006/wi"
ET.register_namespace("", NS)


def excluded(rel_posix: str) -> bool:
    parts = rel_posix.split("/")
    if any(p in (".venv", "__pycache__") for p in parts):
        return True
    lowered = rel_posix.lower()
    if lowered.startswith("data/sessions") or lowered.startswith("data/voices"):
        return True
    name = parts[-1].lower()
    if name.endswith(".log") or name == ".env":
        return True
    return False


def collect_files():
    files = []
    for f in sorted(DIST.rglob("*")):
        if not f.is_file():
            continue
        rel = f.relative_to(DIST).as_posix()
        if excluded(rel):
            continue
        files.append((rel, f))
    return files


def sanitize(s: str) -> str:
    return "".join(c if c.isalnum() else "_" for c in s)


def build_wxs(files):
    Wix = ET.Element("Wix", {"xmlns": NS, "xmlns:util": "http://schemas.microsoft.com/wix/UtilExtension"})
    product = ET.SubElement(Wix, "Product", {
        "Id": "*",
        "UpgradeCode": UPGRADE_CODE,
        "Name": "BookVoice",
        "Language": "1033",
        "Version": PRODUCT_VERSION,
        "Manufacturer": "Hussamsoft",
        "Codepage": "1252",
    })
    ET.SubElement(product, "Package", {
        "InstallerVersion": "500",
        "Compressed": "yes",
        "InstallScope": "perMachine",
        "Description": "BookVoice installer",
        "Comments": "BookVoice - narrate your books",
    })
    ET.SubElement(product, "MajorUpgrade", {
        "DowngradeErrorMessage": "A newer version of BookVoice is already installed.",
    })
    # Set EmbedCab to "no" since the model weights size exceeds the 2GB MSI limit
    ET.SubElement(product, "MediaTemplate", {"EmbedCab": "no", "CompressionLevel": "high"})

    ET.SubElement(product, "Property", {"Id": "ARPPRODUCTICON", "Value": "bookvoice.ico"})
    ET.SubElement(product, "Icon", {"Id": "bookvoice.ico", "SourceFile": str(DIST / "bookvoice.ico")})

    license_rtf = ROOT / "license.rtf"
    ET.SubElement(product, "WixVariable", {"Id": "WixUILicenseRtf", "Value": str(license_rtf)})
    ET.SubElement(product, "Property", {"Id": "WIXUI_INSTALLDIR", "Value": "INSTALLDIR"})
    ET.SubElement(product, "UIRef", {"Id": "WixUI_InstallDir"})
    ET.SubElement(product, "UIRef", {"Id": "WixUI_ErrorProgressText"})

    target = ET.SubElement(product, "Directory", {"Id": "TARGETDIR", "Name": "SourceDir"})
    pf = ET.SubElement(target, "Directory", {"Id": "ProgramFilesFolder"})
    instdir = ET.SubElement(pf, "Directory", {"Id": "INSTALLDIR", "Name": "BookVoice"})

    pm = ET.SubElement(target, "Directory", {"Id": "ProgramMenuFolder"})
    appmenu = ET.SubElement(pm, "Directory", {"Id": "AppMenuDir", "Name": "BookVoice"})
    comp = ET.SubElement(appmenu, "Component", {"Id": "StartMenuShortcut", "Guid": "*"})
    ET.SubElement(comp, "Shortcut", {
        "Id": "StartMenuShortcut", "Name": "BookVoice", "Description": "Narrate your books",
        "Target": "[INSTALLDIR]Launcher.exe", "WorkingDirectory": "INSTALLDIR",
        "Icon": "bookvoice.ico", "IconIndex": "0",
    })
    ET.SubElement(comp, "RemoveFolder", {"Id": "RemoveAppMenuDir", "On": "uninstall"})
    ET.SubElement(comp, "RegistryValue", {
        "Root": "HKCU", "Key": "Software\\BookVoice", "Name": "installed",
        "Type": "integer", "Value": "1", "KeyPath": "yes",
    })

    feature = ET.SubElement(product, "Feature", {
        "Id": "MainFeature", "Title": "BookVoice", "Level": "1",
        "Display": "expand", "ConfigurableDirectory": "INSTALLDIR",
    })
    ET.SubElement(feature, "ComponentRef", {"Id": "StartMenuShortcut"})

    dir_elems = {"": instdir}

    def get_dir(rel_dir: str):
        if rel_dir in dir_elems:
            return dir_elems[rel_dir]
        parent_rel = os.path.dirname(rel_dir)
        parent = get_dir(parent_rel)
        leaf = os.path.basename(rel_dir)
        d = ET.SubElement(parent, "Directory", {"Id": "dir_" + sanitize(rel_dir), "Name": leaf})
        dir_elems[rel_dir] = d
        return d

    for idx, (rel, f) in enumerate(files):
        rel_dir = os.path.dirname(rel)
        d = get_dir(rel_dir) if rel_dir else instdir
        comp_id = "cmp_" + sanitize(rel) + ("_%d" % idx if len(sanitize(rel)) > 40 else "")
        comp = ET.SubElement(d, "Component", {"Id": comp_id, "Guid": "*"})
        file_id = "file_" + sanitize(rel)
        ET.SubElement(comp, "File", {"Id": file_id, "Source": str(f), "KeyPath": "yes"})
        ET.SubElement(feature, "ComponentRef", {"Id": comp_id})

    return Wix


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    files = collect_files()
    if not files:
        raise SystemExit("No files found in dist/. Run build.py first.")
    wxs = build_wxs(files)
    wxs_path = OUT / "BookVoice.wxs"
    ET.indent(wxs, space="  ")
    ET.ElementTree(wxs).write(wxs_path, encoding="utf-8", xml_declaration=True)

    candle = WIX_BIN / "candle.exe"
    light = WIX_BIN / "light.exe"
    obj = OUT / "BookVoice.wixobj"
    msi = OUT / "BookVoice.msi"
    subprocess.run([str(candle), "-ext", "WixUIExtension", "-ext", "WixUtilExtension",
                    str(wxs_path), "-out", str(obj)], check=True)
    light_cmd = [str(light), "-ext", "WixUIExtension", "-ext", "WixUtilExtension",
                 "-sice:ICE38", "-sice:ICE43", "-sice:ICE57",
                 "-cultures:en-us", str(obj), "-out", str(msi)]
    wxl = WIX_BIN / "WixUI_en-us.wxl"
    if wxl.exists():
        light_cmd.insert(-2, "-loc")
        light_cmd.insert(-2, str(wxl))
    subprocess.run(light_cmd, check=True)
    print(f"[msi] Built {msi} ({msi.stat().st_size // 1024} KB) from {len(files)} files.")


if __name__ == "__main__":
    main()
