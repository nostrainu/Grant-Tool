import os
import sys
import time
import json
import glob
import subprocess
import paho.mqtt.client as mqtt
import threading
import re

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

colors = {
    "reset": "\033[0m",
    "bold": "\033[1m",
    "green": "\033[32m",
    "yellow": "\033[33m",
    "red": "\033[31m",
    "cyan": "\033[36m",
    "gray": "\033[90m"
}

from collections import deque

recent_logs = deque(maxlen=6)

def draw_termux_ui():
    try:
        sys.stdout.write("\033[H\033[2J\033[3J")
        sys.stdout.flush()
        
        status_text = "PAUSED / STOPPED" if is_paused else "ACTIVE & MONITORING"
        status_color = colors['yellow'] if is_paused else colors['green']

        print(f" {colors['cyan']}╔══════ Grant Mobile ════════════════════════╗{colors['reset']}")
        print(f" {colors['cyan']}║{colors['reset']} {colors['bold']}Device ID:{colors['reset']}   {device_id:<29} {colors['cyan']}║{colors['reset']}")
        print(f" {colors['cyan']}║{colors['reset']} {colors['bold']}Status:{colors['reset']}      {status_color}{status_text:<29}{colors['reset']} {colors['cyan']}║{colors['reset']}")
        print(f" {colors['cyan']}╚════════════════════════════════════════════╝{colors['reset']}\n")

        print(f" {colors['bold']}{colors['cyan']}ACCOUNTS & PROCESS STATUS:{colors['reset']}")
        installed = get_installed_roblox_packages()
        if installed:
            for pkg in installed:
                is_run = check_roblox_running(pkg)
                is_target = pkg in targeted_packages
                uid = user_ids_cache.get(pkg, "Unknown")
                status_str = f"{colors['green']}[RUNNING]{colors['reset']}" if is_run else f"{colors['red']}[STOPPED]{colors['reset']}"
                target_str = f"[{colors['green']}X{colors['reset']}]" if is_target else "[ ]"
                disp_name = uid if uid and uid != "Unknown" else pkg
                pkg_short = pkg.split('.')[-1]
                print(f"   {target_str} {colors['bold']}{disp_name:<16}{colors['reset']} {colors['gray']}({pkg_short}){colors['reset']} - {status_str}")
        else:
            print(f"   {colors['gray']}No Roblox clone packages found.{colors['reset']}")

        print(f"\n {colors['bold']}{colors['cyan']}RECENT ACTIVITY LOGS:{colors['reset']}")
        if recent_logs:
            for item in recent_logs:
                clean_item = item if len(item) <= 42 else item[:39] + "..."
                print(f"   {colors['green']}•{colors['reset']} {colors['gray']}{clean_item}{colors['reset']}")
        else:
            print(f"   {colors['gray']}No logs yet.{colors['reset']}\n")
    except Exception:
        pass

def log_event(msg):
    global last_logged_event, last_log_time
    last_logged_event = msg
    last_log_time = time.time()
    t_str = time.strftime("%H:%M:%S", time.localtime(last_log_time))
    recent_logs.append(f"[{t_str}] {msg}")
    draw_termux_ui()

targeted_packages = []
is_paused = True
client_overrides = {}

log_states = {}
last_launch_time = {}
running_states_cache = {}
user_ids_cache = {}

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

def logcat_listener():
    print(f"{colors['green']}[*]{colors['reset']} Starting real-time Logcat listener...")
    os.system("su -c 'logcat -c' </dev/null >/dev/null 2>&1")
    
    proc = subprocess.Popen(
        ["su", "-c", "logcat -v brief Roblox:I *:S"],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        stdin=subprocess.DEVNULL,
        text=True,
        bufsize=1
    )
    
    pid_to_package = {}
    
    def refresh_pids():
        for pkg in get_installed_roblox_packages():
            try:
                output = subprocess.check_output(f"su -c 'pidof {pkg}' < /dev/null", shell=True).decode().strip()
                if output:
                    for pid in output.split():
                        pid_to_package[int(pid)] = pkg
            except Exception:
                pass
                
    refresh_pids()
    last_pid_refresh = time.time()
    
    for line in proc.stdout:
        now = time.time()
        if now - last_pid_refresh > 10:
            refresh_pids()
            last_pid_refresh = now
            
        line_strip = line.strip()
        if not line_strip:
            continue
            
        m = re.match(r'^[A-Z]/Roblox\s*\(\s*(\d+)\s*\):\s*(.*)$', line_strip)
        if m:
            pid = int(m.group(1))
            msg = m.group(2)
            
            pkg = pid_to_package.get(pid)
            if not pkg:
                refresh_pids()
                pkg = pid_to_package.get(pid)
                
            if pkg and pkg in targeted_packages:
                found_keyword = None
                for kw in disconnect_keywords:
                    if kw.lower() in msg.lower():
                        found_keyword = kw
                        break
                if found_keyword:
                    handle_disconnect_event(pkg, msg)
                elif "kicked" in msg.lower() or "error code: 267" in msg.lower():
                    handle_disconnect_event(pkg, msg)

def start_logcat_thread():
    t = threading.Thread(target=logcat_listener, daemon=True)
    t.start()
    print(f"{colors['green']}[+]{colors['reset']} Logcat listener thread started.")

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
    log_event(f"Killing {package_name}...")
    print(f"{colors['cyan']}[*]{colors['reset']} Killing process: {package_name}")
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
        pkg_link = override.get("privateServerLink", pkg_link)

    link = pkg_link.strip() if pkg_link else ""
    if link:
        url = link
        log_event(f"Launching {package_name} via Private Server Link...")
    else:
        url = f"roblox://placeId={pkg_place_id}"
        log_event(f"Launching {package_name} to Place ID: {pkg_place_id}...")

    print(f"{colors['yellow']}[*]{colors['reset']} {last_logged_event}")
    cmd = f'am start -p {package_name} -a android.intent.action.VIEW -d "{url}"'
    os.system(f"{cmd} >/dev/null 2>&1")
    os.system(f"su -c '{cmd}' </dev/null >/dev/null 2>&1")
    os.system("stty sane")
    for _ in range(3):
        time.sleep(1)
        send_status()
    protect_process(package_name)

def handle_disconnect_event(package_name, reason):
    if is_paused:
        return
    log_event(f"Disconnect detected for {package_name}: {reason}")
    print(f"{colors['red']}[!]{colors['reset']} {last_logged_event}")
    send_status()
    force_stop_roblox(package_name)
    for _ in range(5):
        time.sleep(1)
        send_status()
    launch_roblox(package_name)
    send_status()

def update_targeted_packages(packages):
    global targeted_packages
    if sorted(targeted_packages) == sorted(packages):
        return
    print(f"{colors['green']}[+]{colors['reset']} Setting targeted packages to: {packages}")
    targeted_packages = packages
    for pkg in list(log_states.keys()):
        if pkg not in targeted_packages:
            log_states.pop(pkg, None)

mqtt_client = mqtt.Client()

def on_connect(client, userdata, flags, rc):
    if rc == 0:
        print(f"{colors['green']}[+]{colors['reset']} Connected to MQTT broker: {broker_url}")
        client.subscribe(control_device_topic)
        client.subscribe(control_all_topic)
        send_discovery()
    else:
        print(f"{colors['red']}[-]{colors['reset']} Connection failed with code {rc}")

stop_requested = False

def run_rejoin_sequence(payload):
    global place_id, private_server_link, client_overrides, is_paused, stop_requested
    is_paused = True
    stop_requested = False
    print(f"{colors['green']}[+]{colors['reset']} Starting sequential rejoin background thread...")
    
    if "placeId" in payload:
        place_id = payload["placeId"]
    if "privateServerLink" in payload:
        private_server_link = payload["privateServerLink"]
    
    client_overrides = payload.get("clientOverrides", {})
    
    for pkg in targeted_packages:
        if stop_requested:
            print(f"{colors['yellow']}[*]{colors['reset']} Rejoin sequence canceled.")
            log_event("Rejoin sequence canceled.")
            return

        force_stop_roblox(pkg)
        update_running_states_cache()
        send_status()
        
        for _ in range(2):
            if stop_requested:
                print(f"{colors['yellow']}[*]{colors['reset']} Rejoin sequence canceled.")
                log_event("Rejoin sequence canceled.")
                return
            time.sleep(1)
            update_running_states_cache()
            send_status()
            
        if stop_requested:
            print(f"{colors['yellow']}[*]{colors['reset']} Rejoin sequence canceled.")
            log_event("Rejoin sequence canceled.")
            return

        launch_roblox(pkg)
        update_running_states_cache()
        send_status()
        
        for _ in range(10):
            if stop_requested:
                print(f"{colors['yellow']}[*]{colors['reset']} Rejoin sequence canceled.")
                log_event("Rejoin sequence canceled.")
                return
            time.sleep(1)
            update_running_states_cache()
            send_status()
        
    if not stop_requested:
        is_paused = False
        log_event("All targeted packages launched successfully. Monitoring active.")
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
            print(f"{colors['green']}[+]{colors['reset']} Received remote command: REJOIN for {targeted_packages}")
            
            threading.Thread(target=run_rejoin_sequence, args=(payload,), daemon=True).start()
                
        elif command == "kill":
            stop_requested = True
            is_paused = True
            print(f"{colors['green']}[+]{colors['reset']} Received remote command: KILL")
            for pkg in targeted_packages:
                force_stop_roblox(pkg)
            log_event("All targeted packages terminated via PC dashboard command.")
            update_running_states_cache()
            send_status()

        elif command == "stop" or command == "pause":
            stop_requested = True
            is_paused = True
            print(f"{colors['yellow']}[*]{colors['reset']} Received remote command: STOP MONITORING")
            log_event("Auto-rejoin monitoring stopped via PC dashboard command.")
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
        "isPaused": is_paused
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
print(f"{colors['gray']}[*] Cleaning up any leftover Roblox processes on startup...{colors['reset']}")
for pkg in get_installed_roblox_packages():
    force_stop_roblox(pkg)
log_event("Startup cleanup completed. Monitoring paused.")

print(f"{colors['yellow']}[*] Monitoring loop started. Press Ctrl+C to exit.{colors['reset']}")

disconnect_keywords = [
    "Connection lost", 
    "clean disconnect", 
    "Disconnect reason:", 
    "ConnectionTerminated", 
    "Lost connection", 
    "Error Code: 277", 
    "Error Code: 279", 
    "Error Code: 268",
    "uh oh!",
    "save data",
    "moderator",
    "moderation"
]

last_status_send = 0
last_ui_draw = 0
RESTART_COOLDOWN = 60

start_logcat_thread()

try:
    while True:
        now = time.time()
        update_running_states_cache()
        
        for pkg in targeted_packages:
            if check_roblox_running(pkg):
                protect_process(pkg)
                
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
                        print(f"{colors['red']}[!]{colors['reset']} {last_logged_event}")
                        force_stop_roblox(pkg)
                        time.sleep(3)
                        launch_roblox(pkg)
                        update_running_states_cache()
                        send_status()
            if len(targeted_packages) > 0 and all(check_roblox_running(p) for p in targeted_packages):
                if "Killing" in last_logged_event or "Launching" in last_logged_event or "Auto-restart" in last_logged_event:
                    log_event("All targeted packages are running. Monitoring active.")

        if now - last_ui_draw >= 10:
            draw_termux_ui()
            last_ui_draw = now

        time.sleep(0.5)

except KeyboardInterrupt:
    print("[*] Exiting script...")
    mqtt_client.loop_stop()
    sys.exit(0)

