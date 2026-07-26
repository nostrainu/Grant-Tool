# ⚡ Grant

> A lightweight, multi-device Roblox account manager and automated rejoiner built for **RedFinger Cloud Phones** & **Android VMs**.

---

## 📋 Prerequisites

### PC (Windows)
- [Node.js (v16 or higher)](https://nodejs.org/)

### Mobile (RedFinger / Android VM)
- **Termux** app installed on the phone.
- **Root access** (`su`) enabled (standard on RedFinger).
- Your Roblox application / cloned Roblox instances installed.

---

## 🚀 Quick Start Guide

### 1️⃣ PC Dashboard Setup

1. Download the latest **`Grant-v1.0.zip`** from [Releases](https://github.com/nostrainu/Grant-Tool/releases).
2. Extract the zip folder anywhere on your PC.
3. Double-click **`GrantRejoiner.bat`**.
   - *First run will automatically install Node dependencies (`npm install`) and create default configs.*
4. The dashboard will show your **Room Code** (e.g., `rf_rejoin_abc12345`).

---

### 2️⃣ Mobile Client Setup (Termux)

Open **Termux** on your RedFinger / Android VM and run the following commands:

#### **Step A: Install Dependencies & Download Script**
```bash
pkg install python -y && pip install paho-mqtt
curl -O https://raw.githubusercontent.com/nostrainu/Grant-Tool/main/rejoin.py
```

#### **Step B: Connect to PC Dashboard**
*Replace `YOUR_ROOM_CODE` with the Room Code displayed on your PC Dashboard:*
```bash
echo '{"connectionCode":"YOUR_ROOM_CODE"}' > config.json
python rejoin.py
```

> 💡 **Tip:** If you skip the `echo` command, `rejoin.py` will prompt you to type in the Room Code when it launches and save it automatically!

---

## ⚡ Alternative: Fully Automatic Mobile Update

When you run the PC Controller, it automatically updates a file named **`mobile update`** in the Grant folder on your PC.

If you edit your Place ID or Private Server link on the PC:
1. Open the **`mobile update`** file on your PC.
2. Copy all text inside it.
3. Paste it directly into **Termux** on your phone.
4. It will automatically update your config and launch `rejoin.py` instantly!

---

## 🔗 How It Works

```
┌───────────────────────────┐      MQTT Broker       ┌───────────────────────────┐
│     PC Controller         │ ─────────────────────> │     RedFinger Phone       │
│  (GrantRejoiner.bat)      │ <───────────────────── │       (rejoin.py)         │
└───────────────────────────┘                        └───────────────────────────┘
```

1. **Room Code**: Acts as a private channel so your PC only communicates with your own phones.
2. **MQTT Protocol**: Cloud-based messaging allows PC and mobile to talk without port forwarding or local Wi-Fi requirements.
3. **State Persistence**: Saved settings (`config.json`) persist across PC restarts and phone reboots.

---

## 🎮 Dashboard Controls

| Key | Action | Description |
|:---:|:---|:---|
| **`1`** | **Start Rejoin** | Starts monitoring and launches target Roblox clients on all connected phones. |
| **`2`** | **Kill Clients** | Force-stops targeted Roblox apps on all connected phones. |
| **`3`** | **Select Clients** | Select which Roblox clone packages to target or configure per-account Private Servers. |
| **`4`** | **Rejoin Interval** | Toggles scheduled auto-rejoin timer (`Off` → `1m` → `5m` → `10m` → `15m` → `30m` → `60m`). |
| **`5`** | **Set Private Server** | Paste a global Private Server link directly from your PC clipboard. |
| **`6`** | **Set Place ID** | Paste a Roblox Place ID directly from your PC clipboard. |
| **`7`** | **Stop Rejoiner** | Pauses monitoring without closing the app. |
| **`0`** | **Quit Dashboard** | Safely exits the PC Controller. |

---

## ❓ Troubleshooting & FAQ

<details>
<summary><b>Devices are not showing up on the PC Dashboard?</b></summary>

- Make sure both PC and Mobile are using the **same Room Code** in `config.json`.
- Verify `rejoin.py` is currently running on the phone.
</details>

<details>
<summary><b>Roblox isn't launching or closing properly?</b></summary>

- Ensure Termux has **Root permissions** granted on RedFinger (`su` prompt accepted).
- Check that your Roblox package/clone names are recognized by selecting them in option **`3`** (Select Clients).
</details>

---

## 📄 License

MIT License © 2026
