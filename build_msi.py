#!/usr/bin/env python3
"""
Build Windows MSI installers for BookVoice using the vendored WiX Toolset.

Products:
  * BookVoice.msi       — perMachine, Program Files (admin at install)
  * BookVoice-User.msi  — perUser, LocalAppData (no admin; portable replacement)

Both ship the same dist/ payload. Writable runtime (.venv, sessions) is created
on first launch under %LocalAppData%\\BookVoice\\installs\\<id>\\.

Run from repo root:  python build_msi.py [--per-user]
"""
from __future__ import annotations

import argparse
import hashlib
import os
import subprocess
from dataclasses import dataclass
from pathlib import Path
from xml.etree import ElementTree as ET

ROOT = Path(__file__).resolve().parent
DIST = ROOT / "dist"
OUT = ROOT / "installer"
WIX_BIN = ROOT / "tools" / "wix"
MACHINE_UPGRADE_CODE = "{E3B3C1A2-1C2D-4F0E-9A1B-1234567890AB}"
USER_UPGRADE_CODE = "{F4C4D2B3-2D3E-5F1F-0B2C-234567890ABC}"
PRODUCT_VERSION = (ROOT / "VERSION").read_text(encoding="utf-8").strip()

NS = "http://schemas.microsoft.com/wix/2006/wi"
ET.register_namespace("", NS)


@dataclass(frozen=True)
class MsiProduct:
    wxs_name: str
    msi_name: str
    install_scope: str  # perMachine | perUser
    upgrade_code: str
    parent_dir_id: str
    parent_dir_name: str | None
    install_dir_name: str
    desktop_shortcut: bool = False


PRODUCTS = {
    "machine": MsiProduct(
        wxs_name="BookVoice.wxs",
        msi_name="BookVoice.msi",
        install_scope="perMachine",
        upgrade_code=MACHINE_UPGRADE_CODE,
        parent_dir_id="ProgramFiles64Folder",
        parent_dir_name=None,
        install_dir_name="BookVoice",
        desktop_shortcut=False,
    ),
    "user": MsiProduct(
        wxs_name="BookVoice-User.wxs",
        msi_name="BookVoice-User.msi",
        install_scope="perUser",
        upgrade_code=USER_UPGRADE_CODE,
        parent_dir_id="LocalAppDataFolder",
        parent_dir_name="BookVoice",
        install_dir_name="App",
        desktop_shortcut=True,
    ),
}


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


def component_id(rel: str, idx: int) -> str:
    digest = hashlib.sha1(f"{rel}:{idx}".encode("utf-8")).hexdigest()[:16]
    return f"cmp_{digest}"


def file_id(rel: str) -> str:
    return f"file_{hashlib.sha1(rel.encode('utf-8')).hexdigest()[:16]}"


def dir_id(rel_dir: str) -> str:
    return f"dir_{hashlib.sha1(rel_dir.encode('utf-8')).hexdigest()[:12]}"


def build_wxs(files, product: MsiProduct):
    Wix = ET.Element("Wix", {"xmlns": NS, "xmlns:util": "http://schemas.microsoft.com/wix/UtilExtension"})
    product_name = "BookVoice" if product.install_scope == "perMachine" else "BookVoice (User)"
    wxs_product = ET.SubElement(Wix, "Product", {
        "Id": "*",
        "UpgradeCode": product.upgrade_code,
        "Name": product_name,
        "Language": "1033",
        "Version": PRODUCT_VERSION,
        "Manufacturer": "Hussamsoft",
        "Codepage": "1252",
    })
    ET.SubElement(wxs_product, "Package", {
        "InstallerVersion": "500",
        "Platform": "x64",
        "Compressed": "yes",
        "InstallScope": product.install_scope,
        "Description": "BookVoice installer",
        "Comments": "BookVoice - narrate your books",
    })
    ET.SubElement(wxs_product, "MajorUpgrade", {
        "DowngradeErrorMessage": "A newer version of BookVoice is already installed.",
    })
    ET.SubElement(wxs_product, "MediaTemplate", {"EmbedCab": "no", "CompressionLevel": "high"})

    ET.SubElement(wxs_product, "Property", {"Id": "ARPPRODUCTICON", "Value": "bookvoice.ico"})
    ET.SubElement(wxs_product, "Icon", {"Id": "bookvoice.ico", "SourceFile": str(DIST / "bookvoice.ico")})

    license_rtf = ROOT / "license.rtf"
    ET.SubElement(wxs_product, "WixVariable", {"Id": "WixUILicenseRtf", "Value": str(license_rtf)})
    ET.SubElement(wxs_product, "Property", {"Id": "WIXUI_INSTALLDIR", "Value": "INSTALLDIR"})
    ET.SubElement(wxs_product, "UIRef", {"Id": "WixUI_InstallDir"})
    ET.SubElement(wxs_product, "UIRef", {"Id": "WixUI_ErrorProgressText"})

    target = ET.SubElement(wxs_product, "Directory", {"Id": "TARGETDIR", "Name": "SourceDir"})
    parent = ET.SubElement(target, "Directory", {"Id": product.parent_dir_id})
    if product.parent_dir_name:
        parent = ET.SubElement(parent, "Directory", {
            "Id": "AppParentDir",
            "Name": product.parent_dir_name,
        })
    instdir = ET.SubElement(parent, "Directory", {
        "Id": "INSTALLDIR",
        "Name": product.install_dir_name,
    })

    pm = ET.SubElement(target, "Directory", {"Id": "ProgramMenuFolder"})
    appmenu = ET.SubElement(pm, "Directory", {"Id": "AppMenuDir", "Name": "BookVoice"})
    menu_comp = ET.SubElement(appmenu, "Component", {"Id": "StartMenuShortcut", "Guid": "*", "Win64": "yes"})
    ET.SubElement(menu_comp, "Shortcut", {
        "Id": "StartMenuShortcut",
        "Name": "BookVoice",
        "Description": "Narrate your books",
        "Target": "[INSTALLDIR]Launcher.exe",
        "WorkingDirectory": "INSTALLDIR",
        "Icon": "bookvoice.ico",
        "IconIndex": "0",
    })
    ET.SubElement(menu_comp, "RemoveFolder", {"Id": "RemoveAppMenuDir", "On": "uninstall"})
    ET.SubElement(menu_comp, "RegistryValue", {
        "Root": "HKCU",
        "Key": f"Software\\BookVoice\\{product.install_scope}",
        "Name": "installed",
        "Type": "integer",
        "Value": "1",
        "KeyPath": "yes",
    })

    feature = ET.SubElement(wxs_product, "Feature", {
        "Id": "MainFeature",
        "Title": "BookVoice",
        "Level": "1",
        "Display": "expand",
        "ConfigurableDirectory": "INSTALLDIR",
    })
    ET.SubElement(feature, "ComponentRef", {"Id": "StartMenuShortcut"})

    association_root = "HKCU" if product.install_scope == "perUser" else "HKLM"
    association = ET.SubElement(instdir, "Component", {"Id": "PreparedBookAssociation", "Guid": "*", "Win64": "yes"})
    ET.SubElement(association, "RegistryValue", {
        "Root": association_root,
        "Key": "Software\\Classes\\.bookvoice",
        "Type": "string",
        "Value": "BookVoice.PreparedBook",
        "KeyPath": "yes",
    })
    ET.SubElement(association, "RegistryValue", {
        "Root": association_root,
        "Key": "Software\\Classes\\BookVoice.PreparedBook",
        "Type": "string",
        "Value": "BookVoice Prepared Book",
    })
    ET.SubElement(association, "RegistryValue", {
        "Root": association_root,
        "Key": "Software\\Classes\\BookVoice.PreparedBook\\DefaultIcon",
        "Type": "string",
        "Value": "[INSTALLDIR]bookvoice.ico,0",
    })
    ET.SubElement(association, "RegistryValue", {
        "Root": association_root,
        "Key": "Software\\Classes\\BookVoice.PreparedBook\\shell\\open\\command",
        "Type": "string",
        "Value": '\"[INSTALLDIR]Launcher.exe\" \"%1\"',
    })
    ET.SubElement(feature, "ComponentRef", {"Id": "PreparedBookAssociation"})

    if product.install_scope == "perUser":
        install_cleanup = ET.SubElement(instdir, "Component", {"Id": "InstallDirCleanup", "Guid": "*", "Win64": "yes"})
        ET.SubElement(install_cleanup, "RemoveFolder", {"Id": "RemoveInstallDir", "On": "uninstall"})
        ET.SubElement(install_cleanup, "RegistryValue", {
            "Root": "HKCU",
            "Key": "Software\\BookVoice\\UserInstall",
            "Name": "InstallDir",
            "Type": "integer",
            "Value": "1",
            "KeyPath": "yes",
        })
        ET.SubElement(feature, "ComponentRef", {"Id": "InstallDirCleanup"})
        if product.parent_dir_name:
            parent_cleanup = ET.SubElement(parent, "Component", {"Id": "AppParentCleanup", "Guid": "*", "Win64": "yes"})
            ET.SubElement(parent_cleanup, "RemoveFolder", {"Id": "RemoveAppParentDir", "On": "uninstall"})
            ET.SubElement(parent_cleanup, "RegistryValue", {
                "Root": "HKCU",
                "Key": "Software\\BookVoice\\UserInstall",
                "Name": "AppParent",
                "Type": "integer",
                "Value": "1",
                "KeyPath": "yes",
            })
            ET.SubElement(feature, "ComponentRef", {"Id": "AppParentCleanup"})

    if product.desktop_shortcut:
        desktop = ET.SubElement(target, "Directory", {"Id": "DesktopFolder"})
        desktop_comp = ET.SubElement(desktop, "Component", {"Id": "DesktopShortcut", "Guid": "*", "Win64": "yes"})
        ET.SubElement(desktop_comp, "Shortcut", {
            "Id": "DesktopShortcut",
            "Name": "BookVoice",
            "Description": "Narrate your books",
            "Target": "[INSTALLDIR]Launcher.exe",
            "WorkingDirectory": "INSTALLDIR",
            "Icon": "bookvoice.ico",
            "IconIndex": "0",
        })
        ET.SubElement(desktop_comp, "RegistryValue", {
            "Root": "HKCU",
            "Key": "Software\\BookVoice\\DesktopShortcut",
            "Name": product.install_scope,
            "Type": "integer",
            "Value": "1",
            "KeyPath": "yes",
        })
        ET.SubElement(feature, "ComponentRef", {"Id": "DesktopShortcut"})

    dir_elems = {"": instdir}

    def get_dir(rel_dir: str):
        if rel_dir in dir_elems:
            return dir_elems[rel_dir]
        parent_rel = os.path.dirname(rel_dir)
        parent_elem = get_dir(parent_rel)
        leaf = os.path.basename(rel_dir)
        d = ET.SubElement(parent_elem, "Directory", {"Id": dir_id(rel_dir), "Name": leaf})
        dir_elems[rel_dir] = d
        return d

    for idx, (rel, f) in enumerate(files):
        rel_dir = os.path.dirname(rel)
        d = get_dir(rel_dir) if rel_dir else instdir
        comp = ET.SubElement(d, "Component", {"Id": component_id(rel, idx), "Guid": "*", "Win64": "yes"})
        ET.SubElement(comp, "File", {"Id": file_id(rel), "Source": str(f), "KeyPath": "yes"})
        ET.SubElement(feature, "ComponentRef", {"Id": component_id(rel, idx)})

    return Wix


def compile_msi(wxs_path: Path, msi_path: Path, *, per_user: bool = False) -> None:
    candle = WIX_BIN / "candle.exe"
    light = WIX_BIN / "light.exe"
    obj = wxs_path.with_suffix(".wixobj")
    subprocess.run(
        [
            str(candle),
            "-ext",
            "WixUIExtension",
            "-ext",
            "WixUtilExtension",
            "-arch",
            "x64",
            str(wxs_path),
            "-out",
            str(obj),
        ],
        check=True,
    )
    light_cmd = [
        str(light),
        "-ext",
        "WixUIExtension",
        "-ext",
        "WixUtilExtension",
        "-sice:ICE38",
        "-sice:ICE43",
        "-sice:ICE57",
        # The immutable worker expands to more than 44k components. Full ICE
        # validation becomes effectively quadratic at that size and can spend
        # hours after all cabinets are already complete. The release suite
        # validates the generated WiX and payload separately; reuse identical
        # cabinet content across the machine/user products.
        "-sval",
        "-reusecab",
        "-cc",
        str(OUT),
    ]
    if per_user:
        light_cmd.append("-sice:ICE64")
    light_cmd.extend(["-cultures:en-us", str(obj), "-out", str(msi_path)])
    wxl = WIX_BIN / "WixUI_en-us.wxl"
    if wxl.exists():
        light_cmd.insert(-2, "-loc")
        light_cmd.insert(-2, str(wxl))
    subprocess.run(light_cmd, check=True)


def build_product(files, product: MsiProduct) -> Path:
    OUT.mkdir(parents=True, exist_ok=True)
    wxs_path = OUT / product.wxs_name
    msi_path = OUT / product.msi_name
    wxs = build_wxs(files, product)
    ET.indent(wxs, space="  ")
    ET.ElementTree(wxs).write(wxs_path, encoding="utf-8", xml_declaration=True)
    compile_msi(wxs_path, msi_path, per_user=product.install_scope == "perUser")
    print(f"[msi] Built {msi_path} ({msi_path.stat().st_size // 1024} KB) from {len(files)} files.")
    return msi_path


def main():
    parser = argparse.ArgumentParser(description="Build BookVoice MSI installer(s)")
    parser.add_argument(
        "--per-user",
        action="store_true",
        help="Build BookVoice-User.msi (perUser, LocalAppData) in addition to BookVoice.msi",
    )
    parser.add_argument(
        "--user-only",
        action="store_true",
        help="Build only BookVoice-User.msi",
    )
    args = parser.parse_args()

    files = collect_files()
    if not files:
        raise SystemExit("No files found in dist/. Run build.py first.")

    if args.user_only:
        build_product(files, PRODUCTS["user"])
        return

    build_product(files, PRODUCTS["machine"])
    if args.per_user:
        build_product(files, PRODUCTS["user"])


if __name__ == "__main__":
    main()
