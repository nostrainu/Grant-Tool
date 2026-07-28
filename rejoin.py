# -*- coding: utf-8 -*-
import os
import sys
import time
import json
import glob
import subprocess
import paho.mqtt.client as mqtt
import threading
import re
import urllib.request
import ssl
import warnings

warnings.filterwarnings('ignore')

colors = {
    "reset": "\033[0m",
    "bold": "\033[1m",
    "green": "\033[32m",
    "yellow": "\033[33m",
    "red": "\033[31m",
    "cyan": "\033[36m",
    "gray": "\033[90m"
}

pid_file = "rejoin.pid"
if os.path.exists(pid_file):
    try:
        with open(pid_file, "r") as f:
            old_pid = int(f.read().strip())
        if old_pid != os.getpid():
            print(f"[*] Found existing rejoin.py instance (PID {old_pid}). Terminating it...")
            try:
                os.kill(old_pid, 9)
            except Exception:
                pass
            os.system(f"su -c 'kill -9 {old_pid}' </dev/null >/dev/null 2>&1")
            time.sleep(1)
    except Exception:
        pass

try:
    with open(pid_file, "w") as f:
        f.write(str(os.getpid()))
except Exception:
    pass

config = {
    "connectionCode": "YOUR_UNIQUE_CONNECTION_CODE",
    "placeId": 0,
    "privateServerLink": "",
    "brokerUrl": "broker.hivemq.com"
}

config_path = "config.json"
if os.path.exists(config_path):
    try:
        with open(config_path, "r") as f:
            config.update(json.load(f))
        print("[+] Config loaded successfully.")
    except Exception as e:
        print(f"[-] Error loading config.json: {e}")
else:
    print("[*] config.json not found. Creating default configuration...")
    try:
        with open(config_path, "w") as f:
            json.dump(config, f, indent=2)
    except Exception as e:
        print(f"[-] Could not write default config.json: {e}")

if not config.get("connectionCode") or config["connectionCode"] == "YOUR_UNIQUE_CONNECTION_CODE" or config["connectionCode"].strip() == "":
    print(f"{colors['cyan']}[*] No connection code found.{colors['reset']}")
    print(f"{colors['yellow']}    Enter the Room Code shown on your PC Controller dashboard.{colors['reset']}")
    try:
        code = input(f"\n  Room Code: ").strip()
        if not code:
            print(f"{colors['red']}[-] No code entered. Exiting.{colors['reset']}")
            sys.exit(1)
        config["connectionCode"] = code
        try:
            with open(config_path, "w") as f:
                json.dump(config, f, indent=2)
            print(f"{colors['green']}[+] Connection code saved to config.json!{colors['reset']}")
        except Exception as e:
            print(f"{colors['yellow']}[*] Could not save to config.json: {e} (will use code for this session){colors['reset']}")
    except (EOFError, KeyboardInterrupt):
        print(f"\n{colors['red']}[-] Cancelled. Exiting.{colors['reset']}")
        sys.exit(1)
if not config.get("placeId") or config["placeId"] == 0:
    print("[*] Warning: No 'placeId' configured yet. Waiting for PC dashboard to send it...")

connection_code = config["connectionCode"]
place_id = config["placeId"]
private_server_link = config["privateServerLink"]
broker_url = config["brokerUrl"]
if broker_url.startswith("mqtt://"):
    broker_url = broker_url[7:]
elif broker_url.startswith("mqtts://"):
    broker_url = broker_url[8:]

def get_device_id():
    id_file = "device_id.txt"
    if os.path.exists(id_file):
        try:
            with open(id_file, "r") as f:
                val = f.read().strip()
                if val:
                    return val
        except Exception:
            pass
    import uuid
    new_id = "device_" + uuid.uuid4().hex[:8]
    try:
        with open(id_file, "w") as f:
            f.write(new_id)
    except Exception:
        pass
    return new_id

device_id = get_device_id()
print(f"[+] Device ID generated: {device_id}")

discovery_topic = f"roblox/discovery/{connection_code}"
status_topic = f"roblox/status/{connection_code}/{device_id}"
control_device_topic = f"roblox/control/{connection_code}/{device_id}"
control_all_topic = f"roblox/control/{connection_code}/all"

from collections import deque

recent_logs = deque(maxlen=6)

def draw_termux_ui():
    try:
        sys.stdout.write("\033[H\033[2J\033[3J")
        sys.stdout.flush()
        
        status_text = "PAUSED / STOPPED" if is_paused else "ACTIVE & MONITORING"
        status_color = colors['yellow'] if is_paused else colors['green']
        
        auto_text = ""
        auto_color = colors['gray']
        if is_paused:
            auto_text = "PAUSED"
            auto_color = colors['yellow']
        else:
            now_ts = time.time()
            min_rem = None
            active_interval = None
            
            for pkg in targeted_packages:
                ov = client_overrides.get(pkg, {}) if isinstance(client_overrides, dict) else {}
                interval_sec = None
                if isinstance(ov, dict):
                    interval_sec = ov.get("cycleIntervalSeconds")
                    if not interval_sec and ov.get("cycleIntervalMinutes"):
                        interval_sec = int(ov.get("cycleIntervalMinutes") * 60)
                if not interval_sec:
                    auto_min = config.get("autoRejoinIntervalMinutes", 0)
                    if auto_min and auto_min > 0:
                        interval_sec = int(auto_min * 60)
                
                if interval_sec and interval_sec > 0:
                    last_c = ov.get("lastCycleTime", 0) if isinstance(ov, dict) else 0
                    last_c_ts = 0
                    if isinstance(last_c, (int, float)):
                        last_c_ts = last_c
                    elif isinstance(last_c, str):
                        try:
                            if last_c.replace('.', '', 1).isdigit():
                                last_c_ts = float(last_c)
                            else:
                                import datetime
                                dt = datetime.datetime.fromisoformat(last_c.replace('Z', '+00:00'))
                                last_c_ts = dt.timestamp()
                        except Exception:
                            last_c_ts = 0

                    if last_c_ts > 0:
                        rem = max(0, interval_sec - int(now_ts - last_c_ts))
                        if min_rem is None or rem < min_rem:
                            min_rem = rem
                            active_interval = interval_sec
                    else:
                        min_rem = 0
                        active_interval = interval_sec

            if min_rem is not None and active_interval:
                m_label = f"{int(active_interval / 60)}m" if active_interval % 60 == 0 else f"{active_interval / 60:.1f}m"
                if min_rem < 60:
                    rem_str = f"{min_rem}s"
                else:
                    r_m = min_rem // 60
                    r_s = min_rem % 60
                    rem_str = f"{r_m}:{r_s:02d}"
                auto_text = f"Every {m_label} (Next in: {rem_str})"
                auto_color = colors['green']
            else:
                auto_text = "Disabled"
                auto_color = colors['gray']

        lines = []
        lines.append(f" {colors['cyan']}\u2554\u2550\u2550\u2550\u2550\u2550\u2550 Grant Mobile \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557{colors['reset']}")
        lines.append(f" {colors['cyan']}\u2551{colors['reset']} {colors['bold']}Device ID:{colors['reset']}   {device_id:<30} {colors['cyan']}\u2551{colors['reset']}")
        lines.append(f" {colors['cyan']}\u2551{colors['reset']} {colors['bold']}Status:{colors['reset']}      {status_color}{status_text:<30}{colors['reset']} {colors['cyan']}\u2551{colors['reset']}")
        lines.append(f" {colors['cyan']}\u2551{colors['reset']} {colors['bold']}Auto-Rejoin:{colors['reset']} {auto_color}{auto_text:<30}{colors['reset']} {colors['cyan']}\u2551{colors['reset']}")
        lines.append(f" {colors['cyan']}\u255a\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255d{colors['reset']}\n")

        installed = get_installed_roblox_packages()
        if installed:
            max_name_len = 10
            for p in installed:
                u = user_ids_cache.get(p, "Unknown")
                d = u if u and u != "Unknown" else p
                if len(d) > max_name_len:
                    max_name_len = len(d)
            name_w = max_name_len + 1

            for pkg in installed:
                is_run = check_roblox_running(pkg)
                is_target = pkg in targeted_packages
                uid = user_ids_cache.get(pkg, "Unknown")
                status_str = f"{colors['green']}[RUNNING]{colors['reset']}" if is_run else f"{colors['red']}[STOPPED]{colors['reset']}"
                target_str = f"[{colors['green']}X{colors['reset']}]" if is_target else "[ ]"
                disp_name = uid if uid and uid != "Unknown" else pkg
                pkg_short = pkg.split('.')[-1]
                
                cycle_tag_fmt = ""
                override = client_overrides.get(pkg, {}) if 'client_overrides' in globals() and isinstance(client_overrides, dict) else {}
                if isinstance(override, dict) and override.get("privateServerList"):
                    ps_list = override.get("privateServerList", [])
                    if len(ps_list) > 0:
                        idx = (override.get("currentPSIndex", 0) or 0) + 1
                        total = len(ps_list)
                        interval_sec = override.get("cycleIntervalSeconds")
                        if not interval_sec and override.get("cycleIntervalMinutes"):
                            interval_sec = int(override.get("cycleIntervalMinutes") * 60)
                        
                        if interval_sec:
                            if interval_sec < 60:
                                t_str = f"{interval_sec}s"
                            else:
                                m = interval_sec / 60
                                t_str = f"{int(m)}m" if m.is_integer() else f"{m:.1f}m"
                            cycle_tag_fmt = f" {colors['magenta']}[PS #{idx}/{total} | {t_str}]{colors['reset']}"
                        else:
                            cycle_tag_fmt = f" {colors['magenta']}[PS #{idx}/{total}]{colors['reset']}"
                            
                disp_padded = f"{colors['bold']}{disp_name:<{name_w}}{colors['reset']}"
                pkg_formatted = f"{colors['gray']}({pkg_short}){colors['reset']}"
                
                lines.append(f"   {target_str} {disp_padded}{cycle_tag_fmt}{pkg_formatted} - {status_str}")
        else:
            lines.append(f"   {colors['gray']}No Roblox clone packages found.{colors['reset']}")

        lines.append(f"\n {colors['bold']}{colors['cyan']}RECENT ACTIVITY LOGS:{colors['reset']}")
        if recent_logs:
            for item in recent_logs:
                clean_item = item if len(item) <= 42 else item[:39] + "..."
                lines.append(f"   {colors['green']}\u2022{colors['reset']} {colors['gray']}{clean_item}{colors['reset']}")
        else:
            lines.append(f"   {colors['gray']}No logs yet.{colors['reset']}\n")

        sys.stdout.write("\033[H" + "\n".join(lines) + "\n")
        sys.stdout.flush()
    except Exception:
        pass
    except Exception:
        pass

def log_event(msg):
    global last_logged_event, last_log_time
    last_logged_event = msg
    last_log_time = time.time()
    t_str = time.strftime("%H:%M:%S", time.localtime(last_log_time))
    recent_logs.append(f"[{t_str}] {msg}")
    draw_termux_ui()

SCRIPT_VERSION = 2017
RAW_GITHUB_URL = "https://raw.githubusercontent.com/nostrainu/Grant-Tool/main/rejoin.py"

def check_self_update():
    try:
        cache_buster_url = f"{RAW_GITHUB_URL}?t={int(time.time())}"
        cmd = ["curl", "-sL", "--connect-timeout", "5", cache_buster_url]
        remote_code = subprocess.check_output(cmd, stderr=subprocess.DEVNULL).decode('utf-8', errors='ignore')
        
        version_match = re.search(r'SCRIPT_VERSION\s*=\s*(\d+)', remote_code)
        if version_match:
            remote_ver = int(version_match.group(1))
            if remote_ver > SCRIPT_VERSION:
                log_event(f"New update v{remote_ver} detected! Restarting...")
                script_path = os.path.realpath(__file__)
                with open(script_path, 'w', encoding='utf-8') as f:
                    f.write(remote_code)
                time.sleep(1)
                os.execv(sys.executable, [sys.executable, script_path])
                return

        log_event("rejoin.py is up to date.")
    except Exception as e:
        log_event(f"Auto-update skipped: {e}")

targeted_packages = config.get("targetedPackages", [])
is_paused = config.get("isPaused", True)
client_overrides = config.get("clientOverrides", {})

log_states = {}
last_launch_time = {}
running_states_cache = {}
user_ids_cache = {}

def phone_cycle_worker():
    while True:
        time.sleep(1)
        if is_paused:
            continue
            
        now_ts = time.time()
        for pkg in list(targeted_packages):
            override = client_overrides.get(pkg, {}) if isinstance(client_overrides, dict) else {}
            ps_list = override.get("privateServerList", []) if isinstance(override, dict) else []
            
            interval_sec = None
            if isinstance(override, dict):
                interval_sec = override.get("cycleIntervalSeconds")
                if not interval_sec and override.get("cycleIntervalMinutes"):
                    interval_sec = int(override.get("cycleIntervalMinutes") * 60)
            
            if not interval_sec:
                auto_min = config.get("autoRejoinIntervalMinutes", 0)
                if auto_min and auto_min > 0:
                    interval_sec = int(auto_min * 60)
            
            if interval_sec and interval_sec > 0:
                last_cycle = override.get("lastCycleTime", 0) if isinstance(override, dict) else 0
                last_cycle_ts = 0
                if isinstance(last_cycle, (int, float)):
                    last_cycle_ts = last_cycle
                elif isinstance(last_cycle, str):
                    try:
                        if last_cycle.replace('.', '', 1).isdigit():
                            last_cycle_ts = float(last_cycle)
                        else:
                            import datetime
                            dt = datetime.datetime.fromisoformat(last_cycle.replace('Z', '+00:00'))
                            last_cycle_ts = dt.timestamp()
                    except Exception:
                        last_cycle_ts = 0

                if last_cycle_ts == 0:
                    if not isinstance(override, dict):
                        override = {}
                    override["lastCycleTime"] = now_ts
                    client_overrides[pkg] = override
                elif (now_ts - last_cycle_ts) >= interval_sec:
                    cur_idx = override.get("currentPSIndex", 0) if isinstance(override, dict) else 0
                    if ps_list and len(ps_list) > 0:
                        next_idx = (cur_idx + 1) % len(ps_list)
                    else:
                        next_idx = cur_idx
                    
                    if not isinstance(override, dict):
                        override = {}
                    override["currentPSIndex"] = next_idx
                    override["lastCycleTime"] = now_ts
                    client_overrides[pkg] = override
                    config["clientOverrides"] = client_overrides
                    
                    try:
                        with open(config_path, "w") as f:
                            json.dump(config, f, indent=2)
                    except Exception:
                        pass
                        
                    pkg_name = user_ids_cache.get(pkg) or pkg.split('.')[-1]
                    if ps_list and len(ps_list) > 1:
                        log_event(f"Standalone Cycle: Rotating {pkg_name} to PS #{next_idx + 1}/{len(ps_list)}")
                        force_stop_roblox(pkg)
                        time.sleep(2)
                        launch_roblox(pkg)
                        send_status()
                    else:
                        mins_label = int(interval_sec / 60) if interval_sec % 60 == 0 else f"{interval_sec / 60:.1f}"
                        log_event(f"Standalone Auto-Rejoin ({mins_label}m)...")
                        threading.Thread(target=run_rejoin_sequence, args=({},), daemon=True).start()
                        break

def protect_process(package_name):
    try:
        output = subprocess.check_output(f"su -c 'pidof {package_name}' < /dev/null", shell=True).decode().strip()
        if output:
            pids = output.split()
            for pid in pids:
                os.system(f"su -c 'echo -900 > /proc/{pid}/oom_score_adj' </dev/null >/dev/null 2>&1")
                os.system(f"su -c 'echo -16 > /proc/{pid}/oom_adj' </dev/null >/dev/null 2>&1")
    except Exception:
        pass

installed_pkgs_cache = []

def get_installed_roblox_packages():
    global installed_pkgs_cache
    if installed_pkgs_cache:
        return installed_pkgs_cache
    try:
        output = subprocess.check_output("pm list packages", shell=True).decode()
        packages = []
        for line in output.splitlines():
            if "roblox" in line.lower() or "clien" in line.lower():
                pkg = line.replace("package:", "").strip()
                packages.append(pkg)
        installed_pkgs_cache = sorted(packages)
        return installed_pkgs_cache
    except Exception:
        return []

def get_roblox_username_or_id(package_name):
    
    app_storage_path = f"/data/data/{package_name}/files/appData/LocalStorage/appStorage.json"
    try:
        cmd = f"su -c 'cat \"{app_storage_path}\" 2>/dev/null' < /dev/null"
        content = subprocess.check_output(cmd, shell=True).decode('utf-8', errors='ignore')
        if content:
            
            m = re.search(r'\\?"Username\\?":\s*\\?"([A-Za-z0-9_]{3,20})\\?"', content)
            if not m:
                m = re.search(r'\\?"Name\\?":\s*\\?"([A-Za-z0-9_]{3,20})\\?"', content)
            if m:
                return m.group(1)
    except Exception:
        pass

    paths = [
        f"/sdcard/Android/data/{package_name}/files/gloop/external/Internals/Secured/user_id",
        f"/data/data/{package_name}/files/gloop/external/Internals/Secured/user_id"
    ]
    for path in paths:
        try:
            cmd = f"su -c 'cat \"{path}\" 2>/dev/null' < /dev/null"
            output = subprocess.check_output(cmd, shell=True).decode().strip()
            if output and output.isdigit():
                return output
        except Exception:
            pass
    return None



def check_roblox_running(package_name):
    return running_states_cache.get(package_name, False)

def update_running_states_cache():
    global running_states_cache
    installed = get_installed_roblox_packages()
    running = {}
    for pkg in installed:
        is_running = False
        try:
            out = subprocess.check_output(f"su -c 'pidof {pkg}' < /dev/null", shell=True).decode().strip()
            if out and any(p.isdigit() for p in out.split()):
                is_running = True
        except Exception:
            pass
        if not is_running:
            try:
                out = subprocess.check_output(f"pidof {pkg} 2>/dev/null", shell=True).decode().strip()
                if out and any(p.isdigit() for p in out.split()):
                    is_running = True
            except Exception:
                pass
        running[pkg] = is_running
    running_states_cache = running

def force_stop_roblox(package_name):
    log_event(f"Killing process: {package_name}")
    os.system(f"am force-stop {package_name} >/dev/null 2>&1")
    os.system(f"su -c 'am force-stop {package_name}' </dev/null >/dev/null 2>&1")
    os.system(f"su -c 'pkill -9 -f {package_name}' </dev/null >/dev/null 2>&1")
    running_states_cache[package_name] = False
    os.system("stty sane")

def launch_roblox(package_name):
    global client_overrides
    last_launch_time[package_name] = time.time()
    
    pkg_place_id = place_id
    pkg_link = private_server_link
    if 'client_overrides' in globals() and client_overrides and package_name in client_overrides:
        override = client_overrides[package_name]
        pkg_place_id = override.get("placeId", pkg_place_id)
        ps_list = override.get("privateServerList", [])
        if ps_list and len(ps_list) > 0:
            cur_idx = override.get("currentPSIndex", 0) or 0
            cur_idx = cur_idx % len(ps_list)
            pkg_link = ps_list[cur_idx]
        else:
            pkg_link = override.get("privateServerLink", pkg_link)

    link = pkg_link.strip() if pkg_link else ""
    if link:
        url = link
        log_event(f"Launching {package_name} via PS link...")
    else:
        url = f"roblox://placeId={pkg_place_id}"
        log_event(f"Launching {package_name} to Place ID: {pkg_place_id}...")

    cmd = f'am start -p {package_name} -a android.intent.action.VIEW -d "{url}"'
    os.system(f"{cmd} >/dev/null 2>&1")
    os.system(f"su -c '{cmd}' </dev/null >/dev/null 2>&1")
    os.system("stty sane")
    for _ in range(3):
        time.sleep(1)
        send_status()
    protect_process(package_name)

def update_targeted_packages(packages):
    global targeted_packages
    if sorted(targeted_packages) == sorted(packages):
        return
    targeted_packages = packages
    for pkg in list(log_states.keys()):
        if pkg not in targeted_packages:
            log_states.pop(pkg, None)
    log_event(f"Targeted packages set ({len(packages)})")

mqtt_client = mqtt.Client()

def on_connect(client, userdata, flags, rc):
    if rc == 0:
        log_event(f"Connected to MQTT: {broker_url}")
        client.subscribe(control_device_topic)
        client.subscribe(control_all_topic)
        send_discovery()
    else:
        log_event(f"MQTT connection failed ({rc})")

is_rejoining = False
stop_requested = False

def run_rejoin_sequence(payload):
    global place_id, private_server_link, client_overrides, is_paused, is_rejoining, stop_requested
    is_paused = True
    is_rejoining = True
    stop_requested = False
    log_event("Starting sequential rejoin...")
    
    if isinstance(payload, dict):
        if "placeId" in payload:
            place_id = payload["placeId"]
        if "privateServerLink" in payload:
            private_server_link = payload["privateServerLink"]
        client_overrides = payload.get("clientOverrides", client_overrides)
    
    log_event("Closing all active Roblox clients...")
    for pkg in targeted_packages:
        if stop_requested:
            is_rejoining = False
            log_event("Rejoin sequence canceled.")
            return
        force_stop_roblox(pkg)
    
    update_running_states_cache()
    send_status()
    time.sleep(3)

    for pkg in targeted_packages:
        if stop_requested:
            is_rejoining = False
            log_event("Rejoin sequence canceled.")
            return

        launch_roblox(pkg)
        update_running_states_cache()
        send_status()
        
        for _ in range(8):
            if stop_requested:
                is_rejoining = False
                log_event("Rejoin sequence canceled.")
                return
            time.sleep(1)
            update_running_states_cache()
            send_status()
        
    is_rejoining = False
    if not stop_requested:
        is_paused = False
        now_finish = time.time()
        for pkg in targeted_packages:
            last_launch_time[pkg] = now_finish
            if pkg not in client_overrides or not isinstance(client_overrides[pkg], dict):
                client_overrides[pkg] = {}
            client_overrides[pkg]["lastCycleTime"] = now_finish

        try:
            config["isPaused"] = False
            config["clientOverrides"] = client_overrides
            with open(config_path, "w") as f:
                json.dump(config, f, indent=2)
        except Exception:
            pass
        log_event("All targeted packages launched successfully.")
        update_running_states_cache()
        send_status()

def on_message(client, userdata, msg):
    global place_id, private_server_link, is_paused, client_overrides, stop_requested
    if msg.retain:
        return
    try:
        payload = json.loads(msg.payload.decode())
        command = payload.get("command")
        
        target_pkgs = payload.get("packageNames")
        if target_pkgs is not None:
            update_targeted_packages(target_pkgs)
            
        if command == "rejoin":
            stop_requested = False
            client_overrides = payload.get("clientOverrides", client_overrides)
            rejoin_ts = payload.get("rejoinTimestamp", time.time())
            
            if targeted_packages:
                for pkg in targeted_packages:
                    if pkg not in client_overrides or not isinstance(client_overrides[pkg], dict):
                        client_overrides[pkg] = {}
                    client_overrides[pkg]["lastCycleTime"] = rejoin_ts
                    last_launch_time[pkg] = rejoin_ts

            try:
                config["clientOverrides"] = client_overrides
                config["targetedPackages"] = targeted_packages
                config["isPaused"] = False
                if "placeId" in payload: config["placeId"] = payload["placeId"]
                if "privateServerLink" in payload: config["privateServerLink"] = payload["privateServerLink"]
                if "autoRejoinIntervalMinutes" in payload: config["autoRejoinIntervalMinutes"] = payload["autoRejoinIntervalMinutes"]
                with open(config_path, "w") as f:
                    json.dump(config, f, indent=2)
            except Exception:
                pass
            log_event("Received remote command: REJOIN")
            
            threading.Thread(target=run_rejoin_sequence, args=(payload,), daemon=True).start()
                
        elif command == "kill":
            stop_requested = True
            is_paused = True
            try:
                config["isPaused"] = True
                with open(config_path, "w") as f:
                    json.dump(config, f, indent=2)
            except Exception:
                pass
            log_event("Received remote command: KILL")
            for pkg in targeted_packages:
                force_stop_roblox(pkg)
            log_event("All targeted packages terminated.")
            update_running_states_cache()
            send_status()

        elif command == "update" or command == "self_update":
            log_event("Received remote UPDATE command. Fetching update...")
            try:
                cache_buster_url = f"{RAW_GITHUB_URL}?cb={int(time.time())}"
                cmd = ["curl", "-H", "Cache-Control: no-cache, no-store", "-H", "Pragma: no-cache", "-sL", "--connect-timeout", "5", cache_buster_url]
                remote_code = subprocess.check_output(cmd, stderr=subprocess.DEVNULL).decode('utf-8', errors='ignore')
                if len(remote_code) > 100 and "SCRIPT_VERSION" in remote_code:
                    script_path = os.path.realpath(__file__)
                    with open(script_path, 'w', encoding='utf-8') as f:
                        f.write(remote_code)
                    log_event("Update applied! Restarting script...")
                    time.sleep(1)
                    os.execv(sys.executable, [sys.executable, script_path])
                else:
                    log_event("Remote update check: No valid code received.")
            except Exception as e:
                log_event(f"Remote update failed: {e}")

        elif command == "stop" or command == "pause":
            stop_requested = True
            is_paused = True
            try:
                config["isPaused"] = True
                with open(config_path, "w") as f:
                    json.dump(config, f, indent=2)
            except Exception:
                pass
            log_event("Received remote command: STOP")
            send_status()
    except Exception as e:
        print(f"{colors['red']}[-]{colors['reset']} Error processing message: {e}")

mqtt_client.on_connect = on_connect
mqtt_client.on_message = on_message

def send_discovery():
    discovery_payload = {
        "deviceId": device_id,
        "installedClients": get_installed_roblox_packages()
    }
    try:
        mqtt_client.publish(discovery_topic, json.dumps(discovery_payload))
    except Exception as e:
        pass

def send_status():
    latest_launch = max(last_launch_time.values()) if last_launch_time else 0
    status_payload = {
        "deviceId": device_id,
        "runningStates": {pkg: check_roblox_running(pkg) for pkg in get_installed_roblox_packages()},
        "userIds": {pkg: user_ids_cache.get(pkg, "Unknown") for pkg in get_installed_roblox_packages()},
        "log": last_logged_event,
        "logTime": last_log_time,
        "lastLaunchTime": latest_launch,
        "placeId": place_id,
        "installedClients": get_installed_roblox_packages(),
        "activeClients": targeted_packages,
        "isPaused": is_paused,
        "isRejoining": is_rejoining,
        "clientOverrides": client_overrides
    }
    try:
        mqtt_client.publish(status_topic, json.dumps(status_payload))
    except Exception as e:
        pass

try:
    mqtt_client.connect(broker_url, 1883, 60)
except Exception as e:
    print(f"{colors['red']}[-]{colors['reset']} Failed to connect to broker: {e}")
    sys.exit(1)

mqtt_client.loop_start()

os.system("stty sane")
if is_paused:
    log_event("Cleaning up any leftover Roblox processes on startup...")
    for pkg in get_installed_roblox_packages():
        force_stop_roblox(pkg)
    log_event("Startup cleanup completed.")
else:
    log_event("Standalone cycle active. Skipping cleanup.")
check_self_update()

threading.Thread(target=phone_cycle_worker, daemon=True).start()
log_event("Monitoring & Standalone PS Cycle loop started.")

last_status_send = 0
last_ui_draw = 0
last_protect_time = 0
RESTART_COOLDOWN = 60

try:
    while True:
        now = time.time()
        update_running_states_cache()
        
        if now - last_protect_time >= 30:
            for pkg in targeted_packages:
                if check_roblox_running(pkg):
                    protect_process(pkg)
            last_protect_time = now
                
        for pkg in get_installed_roblox_packages():
            if pkg not in user_ids_cache:
                uid = get_roblox_username_or_id(pkg)
                if uid:
                    user_ids_cache[pkg] = uid
        
        if now - last_status_send >= 5:
            send_discovery()
            send_status()
            last_status_send = now

        if not is_paused:
            for pkg in targeted_packages:
                if not check_roblox_running(pkg):
                    last_launch = last_launch_time.get(pkg, 0)
                    if now - last_launch >= RESTART_COOLDOWN:
                        log_event(f"Auto-restart: {pkg} found stopped, relaunching...")
                        force_stop_roblox(pkg)
                        time.sleep(3)
                        launch_roblox(pkg)
                        update_running_states_cache()
                        send_status()
            if len(targeted_packages) > 0 and all(check_roblox_running(p) for p in targeted_packages):
                if "Killing" in last_logged_event or "Launching" in last_logged_event or "Auto-restart" in last_logged_event:
                    log_event("All targeted packages are running. Monitoring active.")

        if now - last_ui_draw >= 1:
            draw_termux_ui()
            last_ui_draw = now

        time.sleep(1)

except KeyboardInterrupt:
    print("[*] Exiting script...")
    mqtt_client.loop_stop()
    sys.exit(0)

