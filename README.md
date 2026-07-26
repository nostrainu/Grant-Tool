# ⚡ Grant

> A lightweight, multi-device Roblox account manager and automated rejoiner built for **RedFinger Cloud Phones** & **Android VMs**.

---

## 🌟 Features

- 📱 **Multi-Device Control**: Connect and manage multiple RedFinger Cloud Phone VMs simultaneously.
- 🎯 **Per-Client Overrides**: Assign custom Roblox Private Server links to specific accounts.
- ⏱️ **Auto-Rejoin Timer**: Set periodic rejoin intervals (1m, 5m, 10m, 15m, 30m, 60m) to keep accounts logged in.
- 🛑 **Process Manager**: Instantly start, stop, or kill targeted Roblox clones (`[RUNNING]` / `[STOPPED]`).
- 💾 **Auto-Save State**: Restores your active monitoring state and settings across PC reboots.
- 📱 **Termux Mobile UI**: Clean, compact terminal dashboard on your RedFinger phones.

---

## 🚀 Quick Start

### 1️⃣ PC Dashboard (Windows)
1. Install [Node.js](https://nodejs.org/).
2. Double-click **`GrantRejoiner.bat`**!
   *(It automatically installs dependencies and sets up configuration on first launch)*

---

### 2️⃣ Mobile Client (RedFinger / Termux)
On your RedFinger phone:
1. Open **Termux** and install requirements:
   ```bash
   pkg install python -y && pip install paho-mqtt
   ```
2. Run **`rejoin.py`**:
   ```bash
   python rejoin.py
   ```

---

## 🎮 Dashboard Controls

| Key | Action | Description |
|:---:|:---|:---|
| **`1`** | **Start Rejoin** | Starts monitoring and sends rejoin command to all online devices. |
| **`2`** | **Kill Clients** | Instantly terminates targeted Roblox clone apps on all devices. |
| **`3`** | **Select Clients** | Choose which clone packages to target or set per-account private servers. |
| **`4`** | **Rejoin Interval** | Toggles auto-rejoin timer (Off → 1m → 5m → 10m → 15m → 30m → 60m). |
| **`5`** | **Set Private Server** | Paste a default Private Server link from your clipboard. |
| **`6`** | **Set Roblox Place ID** | Paste a Roblox Place ID from your clipboard. |
| **`7`** | **Stop Rejoiner** | Pauses auto-rejoin monitoring. |
| **`0`** | **Quit Dashboard** | Safely exits the PC controller. |

---

## 📄 License
MIT License
