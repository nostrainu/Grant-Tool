# -*- coding: utf-8 -*-
import os
import sys
import subprocess
import json

def get_installed_roblox_packages():
    try:
        output = subprocess.check_output("pm list packages", shell=True).decode()
        packages = []
        for line in output.splitlines():
            if "roblox" in line.lower() or "clien" in line.lower():
                pkg = line.replace("package:", "").strip()
                packages.append(pkg)
        return sorted(packages)
    except Exception:
        return []

def inspect_package(pkg):
    print(f"\n==========================================")
    print(f" Inspecting Package: {pkg}")
    print(f"==========================================")
    
    # 1. Check gloop / executor user_id file
    user_id_file = f"/data/data/{pkg}/files/gloop/external/Internals/Secured/user_id"
    try:
        cmd = f"su -c 'cat \"{user_id_file}\" 2>/dev/null' < /dev/null"
        out = subprocess.check_output(cmd, shell=True).decode().strip()
        if out:
            print(f"  [+] Gloop Secured User ID: {out}")
        else:
            print(f"  [-] Gloop Secured User ID: (Not found / Empty)")
    except Exception as e:
        print(f"  [-] Gloop Secured User ID: Error ({e})")

    # 2. Check Shared Preferences XML files
    try:
        cmd = f"su -c 'ls /data/data/{pkg}/shared_prefs/ 2>/dev/null' < /dev/null"
        xmls = subprocess.check_output(cmd, shell=True).decode().splitlines()
        print(f"  [+] Found {len(xmls)} shared_prefs XML files:")
        for x in xmls:
            if x.strip():
                print(f"      - {x.strip()}")
    except Exception:
        print(f"  [-] shared_prefs directory not accessible.")

    # 3. Check AppStorage / Roblox files directory
    try:
        cmd = f"su -c 'ls /data/data/{pkg}/files/ 2>/dev/null' < /dev/null"
        files = subprocess.check_output(cmd, shell=True).decode().splitlines()
        print(f"  [+] Found {len(files)} files in /files/:")
        for f in files:
            if f.strip():
                print(f"      - {f.strip()}")
    except Exception:
        print(f"  [-] /files/ directory not accessible.")

    # 4. Check WebView Cookies Database
    try:
        cmd = f"su -c 'ls -la /data/data/{pkg}/app_webview/ 2>/dev/null' < /dev/null"
        wv = subprocess.check_output(cmd, shell=True).decode().strip()
        if wv:
            print(f"  [+] Found app_webview directory.")
        else:
            print(f"  [-] app_webview directory empty or not found.")
    except Exception:
        print(f"  [-] app_webview directory not accessible.")

if __name__ == "__main__":
    pkgs = get_installed_roblox_packages()
    if not pkgs:
        print("[-] No Roblox clone packages found.")
        sys.exit(1)
        
    print(f"Found {len(pkgs)} Roblox clone package(s): {', '.join(pkgs)}")
    for pkg in pkgs:
        inspect_package(pkg)
    print("\nInspection complete!")
