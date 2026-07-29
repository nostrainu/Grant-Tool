const fs = require('fs');
const path = require('path');
const mqtt = require('mqtt');
const readline = require('readline');
const { execSync } = require('child_process');
const https = require('https');
const os = require('os');
const http = require('http');

function getClipboardText() {
    try {
        const text = execSync('powershell -NoProfile -Command "Get-Clipboard"', { encoding: 'utf8', timeout: 2000 });
        if (text && text.trim()) {
            return text.trim();
        }
    } catch (e) { }
    try {
        const text = execSync('powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::GetText()"', { encoding: 'utf8', timeout: 2000 });
        return text.trim();
    } catch (e) {
        return "";
    }
}

function disableQuickEdit() {
    if (process.platform === 'win32') {
        try {
            const psCmd = `$c=@'
using System;
using System.Runtime.InteropServices;
public class WinCon {
    [DllImport("kernel32.dll")] public static extern IntPtr GetStdHandle(int n);
    [DllImport("kernel32.dll")] public static extern bool GetConsoleMode(IntPtr h, out uint m);
    [DllImport("kernel32.dll")] public static extern bool SetConsoleMode(IntPtr h, uint m);
    public static void Go() { IntPtr h=GetStdHandle(-10); uint m; if(GetConsoleMode(h,out m)){ m&=~0x0040u; m|=0x0080u; SetConsoleMode(h,m); } }
}
'@; Add-Type -TypeDefinition $c -ErrorAction SilentlyContinue; [WinCon]::Go()`;
            execSync(`powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "${psCmd.replace(/\r?\n/g, ' ')}"`, { stdio: 'ignore', timeout: 4000 });
        } catch (e) { }
    }
}

const configPath = path.join(__dirname, 'config.json');
let config = {};
let lastRejoinTime = null;
let isRejoinerPaused = true;
let lastActionNotice = "Dashboard ready.";

function updateMobileUpdateFile() {
    try {
        const rejoinPath = path.join(__dirname, 'rejoin.py');
        const mobileUpdatePath = path.join(__dirname, 'mobile update');
        if (fs.existsSync(rejoinPath)) {
            const rejoinContent = fs.readFileSync(rejoinPath, 'utf8');
            let cleanBrokerUrl = config.brokerUrl || "broker.hivemq.com";
            if (cleanBrokerUrl.startsWith("mqtt://")) {
                cleanBrokerUrl = cleanBrokerUrl.slice(7);
            } else if (cleanBrokerUrl.startsWith("mqtts://")) {
                cleanBrokerUrl = cleanBrokerUrl.slice(8);
            }
            const mobileConfig = {
                connectionCode: config.connectionCode,
                placeId: config.placeId,
                privateServerLink: config.privateServerLink || "",
                brokerUrl: cleanBrokerUrl
            };
            const content = `pkill -f python
su -c 'pkill -f python' </dev/null >/dev/null 2>&1

cat << 'EOF' > config.json
${JSON.stringify(mobileConfig, null, 2)}
EOF

cat << 'EOF' > rejoin.py
${rejoinContent}
EOF
python rejoin.py
`;
            fs.writeFileSync(mobileUpdatePath, content, 'utf8');
        }
    } catch (e) {
    }
}

const colors = {
    reset: "\x1b[0m",
    bold: "\x1b[1m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    red: "\x1b[31m",
    cyan: "\x1b[36m",
    blue: "\x1b[94m",
    magenta: "\x1b[35m",
    gray: "\x1b[90m"
};

function stripAnsi(str) {
    return str.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqty=?>]/g, '');
}

function getRainbowColor(index, total, phase = 0) {
    const frequency = (2 * Math.PI) / total;
    const r = Math.round(Math.sin(frequency * index + phase + 0) * 127 + 128);
    const g = Math.round(Math.sin(frequency * index + phase + (2 * Math.PI / 3)) * 127 + 128);
    const b = Math.round(Math.sin(frequency * index + phase + (4 * Math.PI / 3)) * 127 + 128);
    return `\x1b[38;2;${r};${g};${b}m`;
}

function colorizeGradientWave(text, lineIndex) {
    let result = "";
    const phase = lineIndex * 0.5;
    const len = text.length;
    for (let i = 0; i < len; i++) {
        const char = text[i];
        if (char === " " || char === "\n" || char === "\r") {
            result += char;
        } else {
            const colorCode = getRainbowColor(i, len, phase);
            result += `${colorCode}${char}\x1b[0m`;
        }
    }
    return result;
}

function loadConfig() {
    let loadedSuccess = false;
    if (fs.existsSync(configPath)) {
        try {
            const raw = fs.readFileSync(configPath, 'utf8').trim();
            if (raw) {
                config = JSON.parse(raw);
                loadedSuccess = true;
            }
        } catch (e) {
            console.log(" [*] Warning: config.json was corrupted or invalid. Resetting to default configuration...");
        }
    }

    if (!loadedSuccess) {
        config = {
            connectionCode: "YOUR_UNIQUE_CONNECTION_CODE",
            placeId: 0,
            privateServerLink: "",
            brokerUrl: "mqtt://broker.hivemq.com",
            autoRejoinIntervalMinutes: 0,
            clientOverrides: {},
            deviceTargets: {},
            rejoinerActive: false
        };
        try {
            fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        } catch (e) { }
    }

    if (config.autoRejoinIntervalMinutes === undefined) config.autoRejoinIntervalMinutes = 0;
    if (config.clientOverrides === undefined) config.clientOverrides = {};
    if (config.deviceTargets === undefined) config.deviceTargets = {};

    if (config.rejoinerActive === true) {
        isRejoinerPaused = false;
        if (config.lastRejoinTime) {
            const savedDate = new Date(config.lastRejoinTime);
            if (!isNaN(savedDate.getTime())) {
                lastRejoinTime = savedDate;
            } else {
                lastRejoinTime = new Date();
                config.lastRejoinTime = lastRejoinTime.toISOString();
            }
        } else {
            lastRejoinTime = new Date();
            config.lastRejoinTime = lastRejoinTime.toISOString();
        }
    } else {
        isRejoinerPaused = true;
    }
    updateMobileUpdateFile();
}

function getOverridesForDevice(deviceId) {
    if (!config.clientOverrides) return {};
    let rawOverrides = config.clientOverrides[deviceId];
    if (!rawOverrides) {
        rawOverrides = {};
        Object.keys(config.clientOverrides).forEach(k => {
            if (!k.startsWith('device_')) {
                rawOverrides[k] = config.clientOverrides[k];
            }
        });
    }
    const resolved = {};
    Object.keys(rawOverrides).forEach(pkg => {
        const item = rawOverrides[pkg];
        if (item) {
            resolved[pkg] = { ...item };
            if (Array.isArray(item.privateServerList) && item.privateServerList.length > 0) {
                const idx = (item.currentPSIndex !== undefined && item.currentPSIndex >= 0 && item.currentPSIndex < item.privateServerList.length) ? item.currentPSIndex : 0;
                resolved[pkg].privateServerLink = item.privateServerList[idx];
            }
        }
    });
    return resolved;
}

function askQuestion(query) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    return new Promise((resolve) => rl.question(query, (ans) => {
        rl.close();
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(true);
            process.stdin.resume();
        }
        resolve(ans.trim());
    }));
}

async function runInteractiveSetup() {
    console.clear();
    console.log(` ${colors.yellow}[*] Initial configuration setup needed...${colors.reset}\n`);

    let code = config.connectionCode;
    if (!code || code === "YOUR_UNIQUE_CONNECTION_CODE" || code.trim() === "") {
        const generatedCode = "rf_rejoin_" + Math.random().toString(36).substring(2, 10);
        const ans = await askQuestion(` Enter unique Connection Code (or press Enter for: ${generatedCode}): `);
        code = ans || generatedCode;
    }

    let pid = config.placeId;
    if (!pid || pid === 0) {
        while (true) {
            const ans = await askQuestion(" Enter Roblox Place ID: ");
            const parsed = parseInt(ans, 10);
            if (parsed && parsed > 0) {
                pid = parsed;
                break;
            }
            console.log(` ${colors.red}[!] Invalid Place ID. Please enter a valid number.${colors.reset}`);
        }
    }

    let link = config.privateServerLink;
    if (link === "" || link === undefined) {
        const ans = await askQuestion(" Enter Private Server Link (optional, press Enter to skip): ");
        link = ans || "";
    }

    config.connectionCode = code;
    config.placeId = pid;
    config.privateServerLink = link;

    try {
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        updateMobileUpdateFile();
        console.log(`\n ${colors.green}[+] Configuration saved successfully to config.json!${colors.reset}\n`);
        console.log(" Starting dashboard...");
        await new Promise(resolve => setTimeout(resolve, 1500));
    } catch (e) {
        console.error("[-] Failed to save config.json:", e.message);
        process.exit(1);
    }
}

async function main() {
    disableQuickEdit();
    loadConfig();

    const usernamesPath = path.join(__dirname, 'usernames.json');
    let usernameCache = {};
    try {
        if (fs.existsSync(usernamesPath)) {
            usernameCache = JSON.parse(fs.readFileSync(usernamesPath, 'utf8'));
        }
    } catch (e) { }

    function saveUsernameCache() {
        try {
            const toSave = {};
            for (const key in usernameCache) {
                if (!key.endsWith("_fetching")) {
                    toSave[key] = usernameCache[key];
                }
            }
            fs.writeFileSync(usernamesPath, JSON.stringify(toSave, null, 2));
        } catch (e) { }
    }

    function getUsername(userId) {
        if (!userId || userId === "Unknown") return null;
        if (usernameCache[userId]) {
            return usernameCache[userId];
        }

        if (!usernameCache[userId + "_fetching"]) {
            usernameCache[userId + "_fetching"] = true;
            https.get(`https://users.roblox.com/v1/users/${userId}`, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(data);
                        if (parsed && parsed.name) {
                            usernameCache[userId] = parsed.name;
                            delete usernameCache[userId + "_fetching"];
                            saveUsernameCache();
                            if (!selectingDevice && !configuringDevice && !updatingConfig) {
                                drawUI();
                            }
                        } else {
                            delete usernameCache[userId + "_fetching"];
                        }
                    } catch (e) {
                        delete usernameCache[userId + "_fetching"];
                    }
                });
            }).on('error', (e) => {
                delete usernameCache[userId + "_fetching"];
            });
        }

        return null;
    }

    function getDisplayName(pkg, userId) {
        const username = getUsername(userId);
        if (username) return username;
        if (userId && userId !== "Unknown") return userId;

        const match = pkg.match(/clien([a-z0-9]+)$/i);
        if (match) {
            return `Client ${match[1].toUpperCase()}`;
        }
        return pkg;
    }

    const needsCode = !config.connectionCode || config.connectionCode === "YOUR_UNIQUE_CONNECTION_CODE" || config.connectionCode.trim() === "";
    const needsPlace = !config.placeId || config.placeId === 0;

    if (needsCode || needsPlace) {
        await runInteractiveSetup();
    }

    const connectionCode = config.connectionCode;
    const discoveryTopic = `roblox/discovery/${connectionCode}`;
    const controlDevicePrefix = `roblox/control/${connectionCode}/`;
    const statusTopicWildcard = `roblox/status/${connectionCode}/+`;
    const brokerUrl = config.brokerUrl || "mqtt://broker.hivemq.com";

    let devices = {};

    let selectingDevice = false;
    let configuringDevice = null;
    let updatingConfig = false;

    async function configureGlobalPrivateServerLink() {
        updatingConfig = true;
        process.stdout.write('\u001b[?1049l\u001b[?25h');
        console.clear();

        const currentLink = config.privateServerLink || "";
        const dispLink = currentLink ? (currentLink.length > 50 ? "..." + currentLink.slice(-45) : currentLink) : "None";
        const clipboardRaw = getClipboardText().replace(/[\r\n]+/g, "").replace(/^["']|["']$/g, '').trim();
        const dispClip = clipboardRaw ? (clipboardRaw.length > 45 ? "..." + clipboardRaw.slice(-40) : clipboardRaw) : "Empty";

        console.log(`\n ${colors.cyan}╔══════ CONFIGURE GLOBAL PRIVATE SERVER LINK ══════════════════════════════╗${colors.reset}\n`);
        console.log(`  ${colors.bold}Current Server:${colors.reset}   ${currentLink ? colors.green + dispLink + colors.reset : colors.gray + "None" + colors.reset}`);
        console.log(`  ${colors.bold}Clipboard Content:${colors.reset} ${colors.gray}${dispClip}${colors.reset}\n`);
        console.log(`  [${colors.bold}1${colors.reset}] Paste Link from Clipboard`);
        console.log(`  [${colors.bold}2${colors.reset}] Enter Link Manually`);
        console.log(`  [${colors.bold}3${colors.reset}] Clear / Remove Private Server Link`);
        console.log(`  [${colors.bold}C${colors.reset}] Cancel and Return\n`);

        const ans = await askQuestion(` Select option (1-3 or C): `);
        const choice = ans.trim().toLowerCase();

        if (choice === '1') {
            if (clipboardRaw) {
                config.privateServerLink = clipboardRaw;
                try {
                    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
                    updateMobileUpdateFile();
                    console.log(`\n ${colors.green}[+] Private Server Link updated from clipboard!${colors.reset}`);
                    console.log(`     Link: ${config.privateServerLink.length > 50 ? "..." + config.privateServerLink.slice(-45) : config.privateServerLink}`);
                    lastActionNotice = `${colors.green}[5] Private Server Link updated from clipboard.${colors.reset}`;
                } catch (e) {
                    console.error("[-] Failed to save config:", e.message);
                }
            } else {
                console.log(`\n ${colors.red}[!] Clipboard is empty or contains invalid text.${colors.reset}`);
            }
            await new Promise(resolve => setTimeout(resolve, 1500));
        } else if (choice === '2') {
            const manualInput = await askQuestion(`\n Enter Private Server Link (or type 'clear' to remove): `);
            const trimmed = manualInput.trim().replace(/^["']|["']$/g, '').trim();
            if (trimmed.toLowerCase() === 'clear' || trimmed.toLowerCase() === 'reset' || trimmed.toLowerCase() === 'none') {
                config.privateServerLink = "";
                try {
                    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
                    updateMobileUpdateFile();
                    console.log(`\n ${colors.yellow}[+] Private Server Link cleared!${colors.reset}`);
                    lastActionNotice = `${colors.yellow}[5] Private Server Link cleared.${colors.reset}`;
                } catch (e) {
                    console.error("[-] Failed to save config:", e.message);
                }
            } else if (trimmed) {
                config.privateServerLink = trimmed;
                try {
                    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
                    updateMobileUpdateFile();
                    console.log(`\n ${colors.green}[+] Private Server Link set manually!${colors.reset}`);
                    console.log(`     Link: ${config.privateServerLink.length > 50 ? "..." + config.privateServerLink.slice(-45) : config.privateServerLink}`);
                    lastActionNotice = `${colors.green}[5] Private Server Link updated manually.${colors.reset}`;
                } catch (e) {
                    console.error("[-] Failed to save config:", e.message);
                }
            } else {
                console.log(`\n ${colors.yellow}[*] No input entered. Link unchanged.${colors.reset}`);
            }
            await new Promise(resolve => setTimeout(resolve, 1500));
        } else if (choice === '3' || choice === 'clear' || choice === 'reset' || choice === 'none') {
            config.privateServerLink = "";
            try {
                fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
                updateMobileUpdateFile();
                console.log(`\n ${colors.yellow}[+] Private Server Link cleared successfully!${colors.reset}`);
                lastActionNotice = `${colors.yellow}[5] Private Server Link cleared.${colors.reset}`;
            } catch (e) {
                console.error("[-] Failed to save config:", e.message);
            }
            await new Promise(resolve => setTimeout(resolve, 1500));
        } else {
            console.log(`\n ${colors.gray}[*] Cancelled.${colors.reset}`);
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        if (process.stdin.isTTY) {
            process.stdin.setRawMode(true);
            process.stdin.resume();
        }
        process.stdout.write('\u001b[?1049h\u001b[?25l');
        updatingConfig = false;
        drawUI();
    }

    async function savePlaceIdFromClipboard() {
        updatingConfig = true;
        console.clear();
        console.log(`\n ${colors.cyan}--- SET ROBLOX PLACE ID FROM CLIPBOARD ---${colors.reset}`);
        console.log(` ${colors.gray}Reading from clipboard...${colors.reset}`);

        const clipboardText = getClipboardText().replace(/[\r\n]+/g, "").replace(/\D/g, "");
        const parsed = parseInt(clipboardText, 10);

        if (parsed && parsed > 0) {
            config.placeId = parsed;
            try {
                fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
                updateMobileUpdateFile();
                console.log(`\n ${colors.green}[+] Place ID updated successfully!${colors.reset}`);
                console.log(`     Place ID: ${config.placeId}`);
            } catch (e) {
                console.error("[-] Failed to save config:", e.message);
            }
        } else {
            console.log(`\n ${colors.red}[!] Clipboard does not contain a valid number Place ID.${colors.reset}`);
        }

        await new Promise(resolve => setTimeout(resolve, 2000));
        updatingConfig = false;
        drawUI();
    }

    const outerWidth = 68;
    const innerWidth = 66;

    function printOuterLine(colorizedText) {
        const plainText = stripAnsi(colorizedText);
        const remaining = outerWidth - plainText.length;
        console.log(` ${colors.yellow}│${colors.reset}${colorizedText}${" ".repeat(remaining > 0 ? remaining : 0)}${colors.yellow}│${colors.reset}`);
    }

    function printInnerLine(colorizedText) {
        const plainText = stripAnsi(colorizedText);
        const remaining = innerWidth - 4 - plainText.length;
        const innerContent = ` ${colors.cyan}║${colors.reset} ${colorizedText}${" ".repeat(remaining > 0 ? remaining : 0)} ${colors.cyan}║${colors.reset} `;
        printOuterLine(innerContent);
    }

    let currentDevicePage = 0;

    function drawUI() {
        console.clear();
        const now = new Date();

        const grantTitle = " Grant ";
        const outerTopBorder = `${colors.yellow}┌${"─".repeat(6)}${colors.reset}${colors.bold}${colors.green}${grantTitle}${colors.reset}${colors.yellow}${"─".repeat(outerWidth - 6 - grantTitle.length)}┐${colors.reset}`;
        const outerBottomBorder = `${colors.yellow}└${"─".repeat(outerWidth)}┘${colors.reset}`;

        console.log(` ${outerTopBorder}`);

        const dashTitle = " Dashboard ";
        const innerTopBorder = `${colors.cyan}╔${"═".repeat(6)}${colors.reset}${colors.bold}${colors.cyan}${dashTitle}${colors.reset}${colors.cyan}${"═".repeat(innerWidth - 2 - 6 - dashTitle.length)}╗${colors.reset}`;
        const innerBottomBorder = `${colors.cyan}╚${"═".repeat(innerWidth - 2)}╝${colors.reset}`;

        printOuterLine(` ${innerTopBorder} `);

        if (!config.deviceOrder) config.deviceOrder = [];
        const knownIds = Object.keys(devices);
        let orderChanged = false;
        knownIds.forEach(id => {
            if (!config.deviceOrder.includes(id)) {
                config.deviceOrder.push(id);
                orderChanged = true;
            }
        });
        if (orderChanged) {
            try { fs.writeFileSync(configPath, JSON.stringify(config, null, 2)); } catch (e) { }
        }
        const deviceIds = config.deviceOrder.filter(id => devices[id]);
        deviceIds.forEach((id, index) => {
            devices[id].displayName = `RedFinger ${index + 1}`;
        });
        const onlineCount = deviceIds.filter(id => devices[id].state === "ONLINE").length;

        const devColor = `${colors.bold}${"Devices Connected:".padEnd(20)}${colors.reset}${colors.green}${onlineCount} online / ${deviceIds.length} total${colors.reset}`;
        printInnerLine(devColor);

        const placeColor = `${colors.bold}${"Target Place ID:".padEnd(20)}${colors.reset}${colors.green}${config.placeId}${colors.reset}`;
        printInnerLine(placeColor);

        const psLink = config.privateServerLink || "";
        let psDisplay = "None";
        if (psLink) {
            psDisplay = psLink.length > 24 ? "..." + psLink.slice(-24) : psLink;
        }
        const psColor = `${colors.bold}${"Private Server:".padEnd(20)}${colors.reset}${psLink ? colors.green : colors.gray}${psDisplay}${colors.reset}`;
        printInnerLine(psColor);

        const roomColor = `${colors.bold}${"Room Code:".padEnd(20)}${colors.reset}${colors.green}${connectionCode}${colors.reset}`;
        printInnerLine(roomColor);

        const hasActiveDevice = Object.values(devices).some(d => d.state === "ONLINE" && d.isPaused === false);
        const isSystemActive = !isRejoinerPaused || hasActiveDevice;

        const statusLabel = `${colors.bold}${"Rejoiner Status:".padEnd(20)}${colors.reset}`;
        if (!isSystemActive) {
            printInnerLine(`${statusLabel}${colors.yellow}${colors.bold}STOPPED / PAUSED${colors.reset} ${colors.gray}(Press 1 to start)${colors.reset}`);
        } else {
            printInnerLine(`${statusLabel}${colors.green}${colors.bold}ACTIVE & MONITORING${colors.reset}`);
        }

        const intervalColor = `${colors.bold}${"Auto-Rejoin:".padEnd(20)}${colors.reset}`;
        if (config.autoRejoinIntervalMinutes > 0) {
            if (!isSystemActive) {
                printInnerLine(`${intervalColor}${colors.yellow}Every ${config.autoRejoinIntervalMinutes} mins (PAUSED - Press 1 to start)${colors.reset}`);
            } else {
                printInnerLine(`${intervalColor}${colors.green}Every ${config.autoRejoinIntervalMinutes} mins${colors.reset}`);
            }
        } else {
            printInnerLine(`${intervalColor}${colors.gray}Disabled (Press 4 to set)${colors.reset}`);
        }

        printInnerLine(`${colors.gray}${"─".repeat(innerWidth - 4)}${colors.reset}`);

        const totalPages = Math.ceil(deviceIds.length / 4) || 1;
        if (currentDevicePage >= totalPages) currentDevicePage = 0;

        const pageDeviceIds = deviceIds.slice(currentDevicePage * 4, (currentDevicePage + 1) * 4);
        const pageTag = totalPages > 1 ? ` ${colors.gray}(Page ${currentDevicePage + 1}/${totalPages})${colors.reset}` : "";

        printInnerLine(`${colors.bold}${colors.cyan}CONNECTED DEVICES:${colors.reset}${pageTag}`);

        if (pageDeviceIds.length > 0) {
            pageDeviceIds.forEach((id, pIndex) => {
                const globalIndex = currentDevicePage * 4 + pIndex;
                const dev = devices[id];

                let devTimerStr = "";
                if (dev.state === "ONLINE") {
                    if (dev.isRejoining === true) {
                        devTimerStr = ` ${colors.yellow}(Rejoining...)${colors.reset}`;
                    } else if (dev.isPaused === false) {
                        const devIntervalMins = config.autoRejoinIntervalMinutes || 0;
                        let latestLaunchTs = dev.lastLaunchTime || 0;

                        const devObj = (config.clientOverrides && config.clientOverrides[id]) || {};
                        Object.keys(devObj).forEach(pKey => {
                            const cObj = devObj[pKey];
                            if (cObj && cObj.lastCycleTime) {
                                let cTs = 0;
                                if (typeof cObj.lastCycleTime === 'number') {
                                    cTs = cObj.lastCycleTime;
                                } else {
                                    cTs = new Date(cObj.lastCycleTime).getTime() / 1000;
                                }
                                if (cTs > latestLaunchTs) latestLaunchTs = cTs;
                            }
                        });

                        if (devIntervalMins > 0 && latestLaunchTs > 0) {
                            const elapsedSecs = Math.max(0, Math.floor(now.getTime() / 1000 - latestLaunchTs));
                            const remainingSecs = Math.max(0, (devIntervalMins * 60) - elapsedSecs);
                            const m = Math.floor(remainingSecs / 60);
                            const s = remainingSecs % 60;
                            devTimerStr = ` ${colors.gray}(Next in: ${colors.yellow}${m}:${s.toString().padStart(2, '0')}${colors.gray})${colors.reset}`;
                        }
                    }
                }

                const devHeaderColor = `  [${colors.bold}${colors.cyan}${globalIndex + 1}${colors.reset}] Dev: ${colors.cyan}${dev.displayName}${colors.reset} (${dev.state === "ONLINE" ? colors.green : colors.red}${dev.state}${colors.reset})${devTimerStr}`;
                printInnerLine(devHeaderColor);

                const clients = dev.installedClients || [];
                clients.forEach(pkg => {
                    const isTargeted = dev.activeClients && dev.activeClients.includes(pkg);
                    const runningState = dev.runningStates && dev.runningStates[pkg];
                    const userId = dev.userIds && dev.userIds[pkg] ? dev.userIds[pkg] : "Unknown";

                    const checkMark = isTargeted ? `[${colors.green}X${colors.reset}]` : "[ ]";
                    let statusColor = colors.red;
                    let statusText = "STOPPED";
                    if (runningState === true) {
                        statusColor = colors.green;
                        statusText = "RUNNING";
                    }

                    const displayName = getDisplayName(pkg, userId);
                    let psTagFormatted = "";
                    const rawClientObj = (config.clientOverrides && config.clientOverrides[id] && config.clientOverrides[id][pkg]) || {};
                    if (Array.isArray(rawClientObj.privateServerList) && rawClientObj.privateServerList.length > 0) {
                        const idx = (rawClientObj.currentPSIndex || 0) + 1;
                        const total = rawClientObj.privateServerList.length;
                        psTagFormatted = ` ${colors.magenta}(PS #${idx}/${total})${colors.reset}`;
                    }

                    const lineFormatted = `       ${checkMark} ${displayName.padEnd(24)}${psTagFormatted} - ${statusColor}[${statusText}]${colors.reset}`;
                    printInnerLine(lineFormatted);
                });
                if (pIndex < pageDeviceIds.length - 1) {
                    printInnerLine("");
                }
            });
        } else {
            printInnerLine(`${colors.gray}Waiting for devices to connect (run rejoin.py in Termux)...${colors.reset}`);
        }

        printOuterLine(` ${innerBottomBorder} `);
        console.log(` ${outerBottomBorder}`);

        console.log(`\n ${colors.bold}${colors.cyan}LATEST DEVICE LOGS:${colors.reset}`);
        if (pageDeviceIds.length > 0) {
            pageDeviceIds.forEach((id) => {
                const dev = devices[id];
                let timeStr = "";
                if (dev.lastLogTime) {
                    const d = new Date(dev.lastLogTime * 1000);
                    const hrs = String(d.getHours()).padStart(2, '0');
                    const mins = String(d.getMinutes()).padStart(2, '0');
                    const secs = String(d.getSeconds()).padStart(2, '0');
                    timeStr = `${colors.gray}[${hrs}:${mins}:${secs}]${colors.reset} `;
                }
                let cleanLog = dev.lastLog || "Online";
                if (cleanLog.length > 48) {
                    cleanLog = cleanLog.slice(0, 45) + "...";
                }
                console.log(`  ${colors.green}•${colors.reset} ${colors.bold}${dev.displayName.padEnd(13)}${colors.reset} ${timeStr}${colors.gray}${cleanLog}${colors.reset}`);
            });
        } else {
            console.log(`  ${colors.gray}No device connected.${colors.reset}`);
        }

        function formatCtrl(keyStr, labelStr, colWidth, keyColor = colors.green) {
            const plainText = `[${keyStr}] ${labelStr}`;
            const padLen = Math.max(0, colWidth - plainText.length);
            return `[${colors.bold}${keyColor}${keyStr}${colors.reset}] ${labelStr}${" ".repeat(padLen)}`;
        }

        console.log(`\n ${colors.bold}${colors.cyan}CONTROLS:${colors.reset}`);
        console.log(`  ${formatCtrl("1", "Start Rejoin", 26)}${formatCtrl("4", "Rejoin Interval", 27)}${formatCtrl("7", "Stop Rejoiner", 25)}`);
        console.log(`  ${formatCtrl("2", "Kill Clients", 26)}${formatCtrl("5", "Set Private Server", 27)}${formatCtrl("8", "Update Devices", 25)}`);
        console.log(`  ${formatCtrl("3", "Select Clients", 26)}${formatCtrl("6", "Set Roblox Place ID", 27)}`);
        if (totalPages > 1) {
            console.log(`  ${formatCtrl("N", `Next Page (${currentDevicePage + 1}/${totalPages})`, 26, colors.cyan)}${formatCtrl("P", "Prev Page", 27, colors.cyan)}${formatCtrl("0", "Quit Dashboard", 25)}`);
        } else {
            console.log(`  ${formatCtrl("0", "Quit Dashboard", 26)}`);
        }

        console.log(`\n ${colors.bold}Last Action:${colors.reset} ${lastActionNotice}`);
        console.log(` ${colors.bold}${colors.green}Press a control key:${colors.reset} `);
        process.stdout.write('\u001b[J');
    }

    function drawDeviceSelectionMenu() {
        process.stdout.write('\u001b[2J\u001b[H');

        console.log(`\n ${colors.cyan}╔══════ SELECT DEVICE TO CONFIGURE ═════════════════════════════════════════╗${colors.reset}\n`);
        const deviceIds = (config.deviceOrder || []).filter(id => devices[id]);
        deviceIds.forEach((id, index) => {
            console.log(`  [${colors.bold}${colors.green}${index + 1}${colors.reset}] Device ID: ${colors.cyan}${devices[id].displayName}${colors.reset}`);
        });
        console.log(`  [${colors.bold}${colors.green}C${colors.reset}] Cancel\n`);
        console.log(` Press a number key to select a device, or [C] to cancel...`);
    }

    function drawClientSelectionMenu() {
        process.stdout.write('\u001b[2J\u001b[H');

        console.log(`\n ${colors.cyan}╔══════ SELECT CLIENT TARGETS & PRIVATE SERVERS ════════════════════════════╗${colors.reset}\n`);
        const devOverrides = getOverridesForDevice(configuringDevice.deviceId);
        configuringDevice.installedClients.forEach((pkg, index) => {
            const isTargeted = configuringDevice.activeClients && configuringDevice.activeClients.includes(pkg);
            const check = isTargeted ? `[${colors.green}X${colors.reset}]` : "[ ]";
            const userId = configuringDevice.userIds && configuringDevice.userIds[pkg] ? configuringDevice.userIds[pkg] : "Unknown";
            const displayName = getDisplayName(pkg, userId);

            let customTag = "";
            const rawOverride = (config.clientOverrides && config.clientOverrides[configuringDevice.deviceId] && config.clientOverrides[configuringDevice.deviceId][pkg]) || {};
            if (Array.isArray(rawOverride.privateServerList) && rawOverride.privateServerList.length > 0) {
                const count = rawOverride.privateServerList.length;
                const idx = (rawOverride.currentPSIndex || 0) + 1;
                customTag = ` ${colors.magenta}(PS Cycle: #${idx}/${count})${colors.reset}`;
            } else if (devOverrides[pkg] && devOverrides[pkg].privateServerLink) {
                const link = devOverrides[pkg].privateServerLink;
                const shortLink = link.length > 25 ? "..." + link.slice(-20) : link;
                customTag = ` ${colors.yellow}(Custom PS: ${shortLink})${colors.reset}`;
            }

            console.log(`  [${colors.bold}${colors.green}${index + 1}${colors.reset}] ${check} ${displayName.padEnd(25)}${customTag}`);
        });
        console.log(`\n  [${colors.bold}${colors.green}P${colors.reset}] Configure PS Link Per Client`);
        console.log(`  [${colors.bold}${colors.cyan}L${colors.reset}] Configure PS Cycle List`);
        console.log(`  [${colors.bold}${colors.yellow}R${colors.reset}] Rejoin (This Device)`);
        console.log(`  [${colors.bold}${colors.red}K${colors.reset}] Kill (This Device)`);
        console.log(`  [${colors.bold}${colors.green}C${colors.reset}] Save\n`);
        console.log(` Press number keys to toggle targets, [P] PS per client, [L] PS cycle, [R] rejoin, [K] kill, or [C] to save...`);
    }

    async function configureCustomPrivateServerLink() {
        if (!configuringDevice) return;
        updatingConfig = true;
        process.stdout.write('\u001b[?1049l\u001b[?25h');
        console.clear();
        console.log(`\n ${colors.cyan}╔══════ CONFIGURE CUSTOM PRIVATE SERVER LINK ══════════════════════════════╗${colors.reset}\n`);
        const devOverrides = getOverridesForDevice(configuringDevice.deviceId);
        configuringDevice.installedClients.forEach((pkg, index) => {
            const userId = configuringDevice.userIds && configuringDevice.userIds[pkg] ? configuringDevice.userIds[pkg] : "Unknown";
            const displayName = getDisplayName(pkg, userId);
            const currentOverride = devOverrides[pkg] && devOverrides[pkg].privateServerLink;
            const currentTag = currentOverride ? ` (Custom: ...${currentOverride.slice(-20)})` : " (Global Server)";
            console.log(`  [${colors.bold}${index + 1}${colors.reset}] ${displayName.padEnd(25)} ${colors.gray}${currentTag}${colors.reset}`);
        });

        const ans = await askQuestion(`\n Enter client number to configure (1-${configuringDevice.installedClients.length}), or 'C' to cancel: `);
        const num = parseInt(ans, 10);
        if (num && num >= 1 && num <= configuringDevice.installedClients.length) {
            const targetPkg = configuringDevice.installedClients[num - 1];
            const userId = configuringDevice.userIds && configuringDevice.userIds[targetPkg] ? configuringDevice.userIds[targetPkg] : "Unknown";
            const targetName = getDisplayName(targetPkg, userId);

            console.log(`\n ${colors.yellow}Configuring Private Server for: ${colors.bold}${targetName}${colors.reset} (${configuringDevice.displayName})`);
            console.log(` ${colors.gray}- Press Enter without typing to paste link from clipboard${colors.reset}`);
            console.log(` ${colors.gray}- Type 'reset' to remove custom link and use global server${colors.reset}`);

            const inputLink = await askQuestion(`\n Enter Private Server Link: `);
            let finalLink = inputLink.trim().replace(/^["']|["']$/g, '').trim();
            if (finalLink === "") {
                finalLink = getClipboardText().replace(/[\r\n]+/g, "").replace(/^["']|["']$/g, '').trim();
            }

            if (!config.clientOverrides) config.clientOverrides = {};
            if (!config.clientOverrides[configuringDevice.deviceId]) config.clientOverrides[configuringDevice.deviceId] = {};

            if (finalLink.toLowerCase() === 'reset' || finalLink.toLowerCase() === 'none') {
                delete config.clientOverrides[configuringDevice.deviceId][targetPkg];
                console.log(`\n ${colors.green}[+] Reset ${targetName} to default global Private Server!${colors.reset}`);
            } else if (finalLink.includes("roblox.com") || finalLink.startsWith("http") || finalLink.startsWith("roblox://")) {
                config.clientOverrides[configuringDevice.deviceId][targetPkg] = { privateServerLink: finalLink };
                console.log(`\n ${colors.green}[+] Saved custom Private Server Link for ${targetName} on ${configuringDevice.displayName}!${colors.reset}`);
                console.log(`     Link: ${finalLink.length > 55 ? "..." + finalLink.slice(-50) : finalLink}`);
            } else {
                console.log(`\n ${colors.red}[!] Invalid link format. (Must start with http:// or https://).${colors.reset}`);
                console.log(`     Received: "${finalLink}"`);
            }

            try {
                fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
                updateMobileUpdateFile();
            } catch (e) { }
            await new Promise(resolve => setTimeout(resolve, 2000));
        }

        if (process.stdin.isTTY) {
            process.stdin.setRawMode(true);
            process.stdin.resume();
        }
        process.stdout.write('\u001b[?1049h\u001b[?25l');
        updatingConfig = false;
        drawClientSelectionMenu();
    }

    async function configureClientPSCycleList() {
        if (!configuringDevice) return;
        updatingConfig = true;
        process.stdout.write('\u001b[?1049l\u001b[?25h');
        console.clear();
        console.log(`\n ${colors.cyan}╔══════ CONFIGURE PS CYCLE LIST FOR CLIENT ══════════════════════════════╗${colors.reset}\n`);

        configuringDevice.installedClients.forEach((pkg, index) => {
            const userId = configuringDevice.userIds && configuringDevice.userIds[pkg] ? configuringDevice.userIds[pkg] : "Unknown";
            const displayName = getDisplayName(pkg, userId);
            const rawOverride = (config.clientOverrides && config.clientOverrides[configuringDevice.deviceId] && config.clientOverrides[configuringDevice.deviceId][pkg]) || {};
            const listCount = (Array.isArray(rawOverride.privateServerList)) ? rawOverride.privateServerList.length : 0;
            const currentTag = listCount > 0 ? ` (${listCount} PS links in cycle)` : " (No cycle list)";
            console.log(`  [${colors.bold}${index + 1}${colors.reset}] ${displayName.padEnd(25)} ${colors.magenta}${currentTag}${colors.reset}`);
        });

        const ans = await askQuestion(`\n Enter client number to manage PS Cycle List (1-${configuringDevice.installedClients.length}), or 'C' to cancel: `);
        const num = parseInt(ans, 10);
        if (num && num >= 1 && num <= configuringDevice.installedClients.length) {
            const targetPkg = configuringDevice.installedClients[num - 1];
            const userId = configuringDevice.userIds && configuringDevice.userIds[targetPkg] ? configuringDevice.userIds[targetPkg] : "Unknown";
            const targetName = getDisplayName(targetPkg, userId);

            if (!config.clientOverrides) config.clientOverrides = {};
            if (!config.clientOverrides[configuringDevice.deviceId]) config.clientOverrides[configuringDevice.deviceId] = {};
            if (!config.clientOverrides[configuringDevice.deviceId][targetPkg]) config.clientOverrides[configuringDevice.deviceId][targetPkg] = {};

            const targetOverride = config.clientOverrides[configuringDevice.deviceId][targetPkg];
            if (!Array.isArray(targetOverride.privateServerList)) {
                targetOverride.privateServerList = [];
            }
            if (targetOverride.currentPSIndex === undefined) {
                targetOverride.currentPSIndex = 0;
            }

            while (true) {
                console.clear();
                console.log(`\n ${colors.magenta}--- PS CYCLE LIST: ${targetName} (${configuringDevice.displayName}) ---${colors.reset}`);
                const list = targetOverride.privateServerList;
                if (list.length === 0) {
                    console.log(` ${colors.gray}No PS links in cycle list yet.${colors.reset}\n`);
                } else {
                    console.log(` ${colors.cyan}Configured Servers (${list.length} total):${colors.reset}`);
                    list.forEach((link, i) => {
                        const activeMarker = i === targetOverride.currentPSIndex ? ` ${colors.green}[ACTIVE]${colors.reset}` : "";
                        const short = link.length > 50 ? "..." + link.slice(-45) : link;
                        console.log(`  [${colors.bold}${i + 1}${colors.reset}] ${short}${activeMarker}`);
                    });
                    console.log("");
                }

                let clientIntervalStr = "2 min(s)";
                if (targetOverride.cycleIntervalSeconds) {
                    if (targetOverride.cycleIntervalSeconds < 60) {
                        clientIntervalStr = `${targetOverride.cycleIntervalSeconds} sec(s)`;
                    } else {
                        const m = targetOverride.cycleIntervalSeconds / 60;
                        clientIntervalStr = `${Number.isInteger(m) ? m : m.toFixed(1)} min(s)`;
                    }
                } else if (targetOverride.cycleIntervalMinutes) {
                    clientIntervalStr = `${targetOverride.cycleIntervalMinutes} min(s)`;
                } else if (config.autoRejoinIntervalMinutes > 0) {
                    clientIntervalStr = `${config.autoRejoinIntervalMinutes} min(s)`;
                }

                console.log(`  [${colors.bold}1${colors.reset}] Add PS Link`);
                console.log(`  [${colors.bold}2${colors.reset}] Remove PS Link`);
                console.log(`  [${colors.bold}3${colors.reset}] Clear All Links for ${targetName}`);
                console.log(`  [${colors.bold}4${colors.reset}] Set Cycle Interval (Currently: ${clientIntervalStr})`);
                console.log(`  [${colors.bold}C${colors.reset}] Save and Back\n`);

                const opt = await askQuestion(` Select option (1-4 or C): `);
                if (opt.trim() === '1') {
                    console.log(`\n ${colors.gray}- Enter PS Link (or press Enter to paste from clipboard):${colors.reset}`);
                    const inputLink = await askQuestion(` PS Link: `);
                    let finalLink = inputLink.trim().replace(/^["']|["']$/g, '').trim();
                    if (finalLink === "") {
                        finalLink = getClipboardText().replace(/[\r\n]+/g, "").replace(/^["']|["']$/g, '').trim();
                    }
                    if (finalLink.includes("roblox.com") || finalLink.startsWith("http") || finalLink.startsWith("roblox://")) {
                        targetOverride.privateServerList.push(finalLink);
                        try {
                            fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
                            updateMobileUpdateFile();
                        } catch (e) { }
                        console.log(`\n ${colors.green}[+] Added PS Link #${targetOverride.privateServerList.length}!${colors.reset}`);
                        await new Promise(resolve => setTimeout(resolve, 1000));
                    } else {
                        console.log(`\n ${colors.red}[!] Invalid PS link format.${colors.reset}`);
                        await new Promise(resolve => setTimeout(resolve, 1500));
                    }
                } else if (opt.trim() === '2') {
                    if (targetOverride.privateServerList.length === 0) continue;
                    const rAns = await askQuestion(` Enter number to remove (1-${targetOverride.privateServerList.length}): `);
                    const rNum = parseInt(rAns, 10);
                    if (rNum && rNum >= 1 && rNum <= targetOverride.privateServerList.length) {
                        targetOverride.privateServerList.splice(rNum - 1, 1);
                        if (targetOverride.currentPSIndex >= targetOverride.privateServerList.length) {
                            targetOverride.currentPSIndex = 0;
                        }
                        try {
                            fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
                            updateMobileUpdateFile();
                        } catch (e) { }
                        console.log(`\n ${colors.yellow}[-] Removed link #${rNum}.${colors.reset}`);
                        await new Promise(resolve => setTimeout(resolve, 1000));
                    }
                } else if (opt.trim() === '3') {
                    targetOverride.privateServerList = [];
                    targetOverride.currentPSIndex = 0;
                    delete targetOverride.cycleIntervalSeconds;
                    delete targetOverride.cycleIntervalMinutes;
                    try {
                        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
                        updateMobileUpdateFile();
                    } catch (e) { }
                    console.log(`\n ${colors.yellow}[-] Cleared cycle list for ${targetName}.${colors.reset}`);
                    await new Promise(resolve => setTimeout(resolve, 1000));
                } else if (opt.trim() === '4') {
                    console.log(`\n ${colors.cyan}--- SET CYCLE INTERVAL ---${colors.reset}`);
                    console.log(` ${colors.gray}Format examples:${colors.reset}`);
                    console.log(`  - Type ${colors.yellow}1m 30s${colors.reset} or ${colors.yellow}1m30s${colors.reset} for 1 minute & 30 seconds`);
                    console.log(`  - Type ${colors.yellow}90s${colors.reset} for 90 seconds`);
                    console.log(`  - Type ${colors.yellow}2m${colors.reset} or ${colors.yellow}2${colors.reset} for 2 minutes`);

                    const iAns = await askQuestion(`\n Enter rotation interval for ${targetName}: `);
                    const trimmed = iAns.trim().toLowerCase();

                    let totalSecs = 0;
                    const mMatch = trimmed.match(/(\d+(?:\.\d+)?)\s*m(?:in(?:ute)?s?)?/);
                    const sMatch = trimmed.match(/(\d+(?:\.\d+)?)\s*s(?:ec(?:ond)?s?)?/);

                    if (mMatch || sMatch) {
                        if (mMatch) totalSecs += parseFloat(mMatch[1]) * 60;
                        if (sMatch) totalSecs += parseFloat(sMatch[1]);
                    } else {
                        const num = parseFloat(trimmed);
                        if (!isNaN(num) && num > 0) totalSecs = Math.round(num * 60);
                    }

                    if (totalSecs > 0) {
                        targetOverride.cycleIntervalSeconds = Math.round(totalSecs);
                        targetOverride.cycleIntervalMinutes = Math.round((totalSecs / 60) * 100) / 100;
                        try {
                            fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
                            updateMobileUpdateFile();
                        } catch (e) { }

                        let dispStr = "";
                        if (targetOverride.cycleIntervalSeconds < 60) {
                            dispStr = `${targetOverride.cycleIntervalSeconds} second(s)`;
                        } else {
                            const m = Math.floor(targetOverride.cycleIntervalSeconds / 60);
                            const s = targetOverride.cycleIntervalSeconds % 60;
                            dispStr = s > 0 ? `${m}m ${s}s` : `${m} minute(s)`;
                        }

                        console.log(`\n ${colors.green}[+] Set cycle interval to ${dispStr} for ${targetName}!${colors.reset}`);
                        await new Promise(resolve => setTimeout(resolve, 1000));
                    }
                } else if (opt.trim().toLowerCase() === 'c') {
                    try {
                        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
                        updateMobileUpdateFile();
                    } catch (e) { }
                    console.log(`\n ${colors.green}[+] Saved cycle configurations for ${targetName}!${colors.reset}`);
                    await new Promise(resolve => setTimeout(resolve, 800));
                    break;
                }
            }
        }

        if (process.stdin.isTTY) {
            process.stdin.setRawMode(true);
            process.stdin.resume();
        }
        process.stdout.write('\u001b[?1049h\u001b[?25l');
        updatingConfig = false;
        drawClientSelectionMenu();
    }

    process.stdout.write('\u001b[?1049h\u001b[?25l');

    drawUI();

    const client = mqtt.connect(brokerUrl, {
        keepalive: 30,
        reconnectPeriod: 3000,
        connectTimeout: 10000,
        resubscribe: true
    });

    client.on('reconnect', () => {
        lastActionNotice = `${colors.yellow}[!] Reconnecting to MQTT broker...${colors.reset}`;
        if (!selectingDevice && !configuringDevice && !updatingConfig) drawUI();
    });

    client.on('offline', () => {
        lastActionNotice = `${colors.red}[!] MQTT Broker offline. Reconnecting...${colors.reset}`;
        if (!selectingDevice && !configuringDevice && !updatingConfig) drawUI();
    });

    client.on('error', (err) => {
        lastActionNotice = `${colors.red}[!] MQTT Error: ${err.message}${colors.reset}`;
        if (!selectingDevice && !configuringDevice && !updatingConfig) drawUI();
    });

    client.on('connect', () => {
        client.subscribe(discoveryTopic);
        client.subscribe(statusTopicWildcard, (err) => {
            if (!err) {
                drawUI();
            }
        });
    });

    client.on('message', (topic, message) => {
        try {
            const payload = JSON.parse(message.toString());
            const deviceId = payload.deviceId;
            if (!deviceId) return;

            if (topic === discoveryTopic) {
                const savedTargets = config.deviceTargets && config.deviceTargets[deviceId];
                const activeList = savedTargets ? [...savedTargets] : [...(payload.installedClients || [])];

                if (!devices[deviceId]) {
                    const idx = Object.keys(devices).length + 1;
                    devices[deviceId] = {
                        deviceId: deviceId,
                        displayName: `RedFinger ${idx}`,
                        installedClients: payload.installedClients || [],
                        activeClients: activeList,
                        runningStates: {},
                        lastSeen: new Date(),
                        state: "ONLINE",
                        lastLog: "Discovered"
                    };

                    client.publish(`${controlDevicePrefix}${deviceId}`, JSON.stringify({
                        command: "update_packages",
                        packageNames: devices[deviceId].activeClients
                    }));
                    devices[deviceId].installedClients = payload.installedClients || [];
                    if (savedTargets) {
                        const validTargets = savedTargets.filter(p => devices[deviceId].installedClients.includes(p));
                        if (validTargets.length > 0) {
                            devices[deviceId].activeClients = validTargets;
                        } else {
                            devices[deviceId].activeClients = [...devices[deviceId].installedClients];
                        }
                    } else {
                        devices[deviceId].activeClients = [...devices[deviceId].installedClients];
                    }
                    devices[deviceId].lastSeen = new Date();
                    devices[deviceId].state = "ONLINE";
                }
            }

            else if (topic.startsWith(`roblox/status/${connectionCode}/`)) {
                const savedTargets = config.deviceTargets && config.deviceTargets[deviceId];
                if (!devices[deviceId]) {
                    const idx = Object.keys(devices).length + 1;
                    const activeList = savedTargets ? [...savedTargets] : (payload.activeClients || []);
                    devices[deviceId] = {
                        deviceId: deviceId,
                        displayName: `RedFinger ${idx}`,
                        installedClients: payload.installedClients || [],
                        activeClients: activeList,
                        runningStates: payload.runningStates || {},
                        userIds: payload.userIds || {},
                        lastSeen: new Date(),
                        state: "ONLINE",
                        lastLog: payload.log || "Online",
                        lastLogTime: payload.logTime || null
                    };
                } else {
                    if (savedTargets && (!configuringDevice || configuringDevice.deviceId !== deviceId)) {
                        devices[deviceId].activeClients = [...savedTargets];
                    }
                    devices[deviceId].runningStates = payload.runningStates || {};
                    devices[deviceId].userIds = payload.userIds || {};
                    devices[deviceId].lastLog = payload.log || devices[deviceId].lastLog;
                    devices[deviceId].lastLogTime = payload.logTime || devices[deviceId].lastLogTime;
                    devices[deviceId].lastSeen = new Date();
                    devices[deviceId].state = "ONLINE";
                    devices[deviceId].isPaused = payload.isPaused;
                    devices[deviceId].isRejoining = payload.isRejoining;

                    if (payload.lastLaunchTime && payload.lastLaunchTime > 0) {
                        devices[deviceId].lastLaunchTime = payload.lastLaunchTime;
                        const mobileLaunchDate = new Date(payload.lastLaunchTime * 1000);
                        if (!lastRejoinTime || mobileLaunchDate > lastRejoinTime) {
                            lastRejoinTime = mobileLaunchDate;
                            config.lastRejoinTime = lastRejoinTime.toISOString();
                            try { fs.writeFileSync(configPath, JSON.stringify(config, null, 2)); } catch (e) { }
                        }
                    }

                    if (payload.clientOverrides && typeof payload.clientOverrides === 'object') {
                        if (!config.clientOverrides) config.clientOverrides = {};
                        if (!config.clientOverrides[deviceId]) config.clientOverrides[deviceId] = {};
                        let overrideChanged = false;
                        Object.keys(payload.clientOverrides).forEach(pkg => {
                            const pObj = payload.clientOverrides[pkg];
                            if (pObj && pObj.lastCycleTime) {
                                if (!config.clientOverrides[deviceId][pkg]) {
                                    config.clientOverrides[deviceId][pkg] = {};
                                }
                                const targetObj = config.clientOverrides[deviceId][pkg];
                                const phoneTime = typeof pObj.lastCycleTime === 'number' ? new Date(pObj.lastCycleTime * 1000).toISOString() : pObj.lastCycleTime;
                                if (targetObj.lastCycleTime !== phoneTime) {
                                    targetObj.lastCycleTime = phoneTime;
                                    overrideChanged = true;
                                }
                                if (pObj.currentPSIndex !== undefined) {
                                    targetObj.currentPSIndex = pObj.currentPSIndex;
                                }
                            }
                        });
                        if (overrideChanged) {
                            try { fs.writeFileSync(configPath, JSON.stringify(config, null, 2)); } catch (e) { }
                        }
                    }

                    if (payload.activeClients) {
                        const pcList = devices[deviceId].activeClients || [];
                        const phoneList = payload.activeClients;
                        const match = pcList.length === phoneList.length && pcList.every(val => phoneList.includes(val));



                        if (!match) {
                            const nowMs = new Date().getTime();
                            if (!devices[deviceId].lastSyncTime || nowMs - devices[deviceId].lastSyncTime > 10000) {
                                devices[deviceId].lastSyncTime = nowMs;
                                client.publish(`${controlDevicePrefix}${deviceId}`, JSON.stringify({
                                    command: "update_packages",
                                    packageNames: pcList
                                }));
                            }
                        }
                    }
                }
            }

            if (!selectingDevice && !configuringDevice && !updatingConfig && !managingRAM) {
                drawUI();
            }
        } catch (e) {
        }
    });

    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
    }

    let managingRAM = false;

    function getRAMAccounts() {
        if (Array.isArray(config.cachedRamAccounts) && config.cachedRamAccounts.length > 0) {
            return { accounts: config.cachedRamAccounts, path: config.ramPath || "RAM WebServer", isEncrypted: false };
        }

        let ramPath = config.ramPath || "";
        const userHome = os.homedir ? os.homedir() : "";
        const possibleDirs = [
            ramPath,
            process.cwd(),
            userHome ? path.join(userHome, "Desktop", "ram") : "",
            userHome ? path.join(userHome, "Desktop", "RAM") : "",
            userHome ? path.join(userHome, "Downloads", "RAM") : "",
            "C:\\ram",
            "C:\\RAM"
        ];

        let foundFile = "";
        let isEncrypted = false;

        for (let d of possibleDirs) {
            if (!d) continue;
            let checkFile = d;
            if (fs.existsSync(d)) {
                try {
                    let stat = fs.statSync(d);
                    if (stat.isDirectory()) {
                        const files = fs.readdirSync(d);
                        const match = files.find(f => f.toLowerCase().includes("accountdata") || f.toLowerCase() === "accounts.json");
                        if (match) {
                            checkFile = path.join(d, match);
                        } else {
                            checkFile = path.join(d, "AccountData.json");
                        }
                    }
                } catch (e) { }
            }

            if (fs.existsSync(checkFile) && !fs.statSync(checkFile).isDirectory()) {
                foundFile = checkFile;
                try {
                    let content = fs.readFileSync(checkFile, 'utf8').replace(/^\uFEFF/, '');
                    let data = JSON.parse(content);
                    let accs = [];
                    if (Array.isArray(data)) {
                        accs = data;
                    } else if (data && typeof data === 'object') {
                        Object.keys(data).forEach(k => {
                            if (data[k] && typeof data[k] === 'object') {
                                accs.push(data[k]);
                            }
                        });
                    }
                    if (accs.length > 0) return { accounts: accs, path: checkFile, isEncrypted: false };
                } catch (e) {
                    isEncrypted = true;
                }
            }
        }
        return { accounts: [], path: foundFile, isEncrypted: isEncrypted };
    }

    function openRAMAccountManager() {
        managingRAM = true;
        drawRAMMenu();
    }

    function drawRAMMenu() {
        process.stdout.write('\u001b[2J\u001b[H');
        const ramInfo = getRAMAccounts();
        const accs = ramInfo.accounts;
        const p = ramInfo.path;

        console.log(`\n ${colors.cyan}╔══════ ROBLOX ACCOUNT MANAGER (RAM) ═══════════════════════════════════════╗${colors.reset}\n`);
        if (p) {
            if (ramInfo.isEncrypted && accs.length === 0) {
                console.log(`  ${colors.yellow}[!] AccountData.json is Encrypted by RAM.${colors.reset}`);
                console.log(`  ${colors.cyan}➜ Please launch "Roblox Account Manager.exe" on your PC.${colors.reset}`);
                console.log(`  ${colors.gray}   (When RAM is open, press [R] to sync cookies live from RAM Web Server).${colors.reset}\n`);
            } else {
                console.log(`  ${colors.bold}Total RAM Accounts Detected:${colors.reset} ${accs.length}\n`);
                accs.forEach((acc, i) => {
                    const name = acc.Username || acc.Name || acc.username || `Account #${i + 1}`;
                    const hasCookie = !!(acc.Cookie || acc.cookie || acc.SecurityCookie || acc.ROBLOSECURITY);
                    const cookieState = hasCookie ? `${colors.green}[Cookie Ready]${colors.reset}` : `${colors.red}[No Cookie]${colors.reset}`;
                    console.log(`   [${i + 1}] ${colors.bold}${name.padEnd(25)}${colors.reset} ${cookieState}`);
                });
            }
        } else {
            console.log(`  ${colors.red}[-] RAM AccountData file not found.${colors.reset}`);
            console.log(`  ${colors.gray}Press [P] to paste your RAM folder path from clipboard.${colors.reset}`);
        }

        console.log(`\n  ${colors.bold}OPTIONS:${colors.reset}`);
        if (accs.length > 0) {
            console.log(`   [${colors.bold}${colors.green}S${colors.reset}] Select Account to Login (Pick 1 Account -> 1 Client)`);
            console.log(`   [${colors.bold}${colors.cyan}A${colors.reset}] Auto-Assign All RAM Accounts Across Devices`);
        }
        if (p && ramInfo.isEncrypted) {
            console.log(`   [${colors.bold}${colors.cyan}R${colors.reset}] Sync Live Cookies from RAM`);
        }
        console.log(`   [${colors.bold}${colors.yellow}P${colors.reset}] Set / Paste RAM Path`);
        console.log(`   [${colors.bold}${colors.green}C${colors.reset}] Cancel\n`);
        console.log(` Press a key [S, A, R, P, or C]...`);
    }

    function getSingleKeyChoice() {
        return new Promise(resolve => {
            if (process.stdin.isTTY) process.stdin.setRawMode(true);
            process.stdin.resume();
            const onData = (buffer) => {
                const str = buffer.toString().toLowerCase();
                process.stdin.removeListener('data', onData);
                resolve(str);
            };
            process.stdin.on('data', onData);
        });
    }

    async function setRAMPathPrompt() {
        updatingConfig = true;
        process.stdout.write('\u001b[?1049l\u001b[?25h');
        console.clear();

        const currentPath = config.ramPath || "None";
        const clipboardRaw = getClipboardText().replace(/[\r\n]+/g, "").replace(/^["']|["']$/g, '').trim();
        const dispClip = clipboardRaw ? (clipboardRaw.length > 45 ? "..." + clipboardRaw.slice(-40) : clipboardRaw) : "Empty";

        console.log(`\n ${colors.cyan}╔══════ CONFIGURE RAM FOLDER PATH ═══════════════════════════════════════╗${colors.reset}\n`);
        console.log(`  ${colors.bold}Current RAM Path:${colors.reset}   ${colors.green}${currentPath}${colors.reset}`);
        console.log(`  ${colors.bold}Clipboard Content:${colors.reset} ${colors.gray}${dispClip}${colors.reset}\n`);
        console.log(`  [${colors.bold}${colors.green}1${colors.reset}] Paste Path from Clipboard (or press Enter)`);
        console.log(`  [${colors.bold}${colors.cyan}2${colors.reset}] Enter Path Manually`);
        console.log(`  [${colors.bold}${colors.green}C${colors.reset}] Cancel\n`);
        console.log(` Press a key [1, 2, or C]...`);

        const key = await getSingleKeyChoice();

        if (key === 'c' || key === '\x1b' || key === '\x03') {
            updatingConfig = false;
            openRAMAccountManager();
            return;
        }

        if (key === '1' || key === '\r' || key === '\n' || key === 'p') {
            if (clipboardRaw) {
                config.ramPath = clipboardRaw;
                delete config.cachedRamAccounts;
                try {
                    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
                    lastActionNotice = `${colors.green}RAM Path updated from clipboard.${colors.reset}`;
                } catch (e) { }
            }
            updatingConfig = false;
            openRAMAccountManager();
            return;
        }

        if (key === '2' || key === 'm') {
            const pathInput = await askQuestion(` Enter RAM Folder Path: `);
            if (pathInput.trim()) {
                config.ramPath = pathInput.trim().replace(/^["']|["']$/g, '');
                delete config.cachedRamAccounts;
                try {
                    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
                    lastActionNotice = `${colors.green}RAM Path saved: ${config.ramPath}${colors.reset}`;
                } catch (e) { }
            }
            updatingConfig = false;
            openRAMAccountManager();
            return;
        }

        updatingConfig = false;
        openRAMAccountManager();
    }

    function autoAssignRAMAccountsToAll() {
        const ramInfo = getRAMAccounts();
        const accs = ramInfo.accounts;
        if (accs.length === 0) {
            lastActionNotice = `${colors.red}No RAM accounts available to assign.${colors.reset}`;
            drawUI();
            return;
        }

        let assignedCount = 0;
        const onlineDevs = Object.values(devices).filter(d => d.state === "ONLINE");
        if (!config.clientOverrides) config.clientOverrides = {};

        onlineDevs.forEach(dev => {
            if (!config.clientOverrides[dev.deviceId]) config.clientOverrides[dev.deviceId] = {};
            const clients = dev.installedClients || [];
            clients.forEach(pkg => {
                if (assignedCount < accs.length) {
                    const acc = accs[assignedCount];
                    const cookie = acc.Cookie || acc.cookie || acc.SecurityCookie || acc.ROBLOSECURITY || "";
                    const username = acc.Username || acc.Name || acc.username || "";

                    if (!config.clientOverrides[dev.deviceId][pkg]) config.clientOverrides[dev.deviceId][pkg] = {};
                    if (cookie) config.clientOverrides[dev.deviceId][pkg].cookie = cookie;
                    if (username) config.clientOverrides[dev.deviceId][pkg].username = username;

                    assignedCount++;
                }
            });
        });

        try { fs.writeFileSync(configPath, JSON.stringify(config, null, 2)); } catch (e) { }

        onlineDevs.forEach(dev => {
            const devOverrides = getOverridesForDevice(dev.deviceId);
            client.publish(`${controlDevicePrefix}${dev.deviceId}`, JSON.stringify({
                command: "update_overrides",
                clientOverrides: devOverrides
            }));
        });

        lastActionNotice = `${colors.green}[RAM] Auto-assigned ${assignedCount} accounts.${colors.reset}`;
        drawUI();
    }

    async function promptAccountSelection(accs) {
        updatingConfig = true;
        process.stdout.write('\u001b[?1049l\u001b[?25h');
        console.clear();

        console.log(`\n ${colors.cyan}╔══════ SELECT RAM ACCOUNT TO LOGIN ═══════════════════════════════════════╗${colors.reset}\n`);
        accs.forEach((acc, i) => {
            const name = acc.Username || acc.Name || acc.username || `Account #${i + 1}`;
            const hasCookie = !!(acc.Cookie || acc.cookie || acc.SecurityCookie || acc.ROBLOSECURITY);
            const cookieState = hasCookie ? `${colors.green}[Cookie Ready]${colors.reset}` : `${colors.red}[No Cookie]${colors.reset}`;
            const idxStr = `[${colors.bold}${colors.green}${String(i + 1).padStart(2, ' ')}${colors.reset}]`;
            console.log(`  ${idxStr} ${colors.bold}${name.padEnd(25)}${colors.reset} ${cookieState}`);
        });
        console.log(`  [${colors.bold}${colors.green} C${colors.reset}] Cancel\n`);

        const ans = await askQuestion(` Select RAM Account number (1-${accs.length}): `);
        const choice = ans.trim().toLowerCase();
        const num = parseInt(choice, 10);

        if (num && num >= 1 && num <= accs.length) {
            const selectedAcc = accs[num - 1];
            await assignSingleRAMAccountPrompt(selectedAcc);
            return;
        }

        updatingConfig = false;
        openRAMAccountManager();
    }

    async function assignSingleRAMAccountPrompt(acc) {
        updatingConfig = true;
        process.stdout.write('\u001b[?1049l\u001b[?25h');
        console.clear();

        const username = acc.Username || acc.Name || acc.username || "Account";
        const cookie = acc.Cookie || acc.cookie || acc.SecurityCookie || acc.ROBLOSECURITY || "";

        console.log(`\n ${colors.cyan}╔══════ ASSIGN ACCOUNT: ${colors.bold}${username}${colors.cyan} ══════════════════════════════╗${colors.reset}\n`);

        const onlineDevs = Object.values(devices).filter(d => d.state === "ONLINE");
        if (onlineDevs.length === 0) {
            console.log(`  ${colors.red}[!] No online devices connected.${colors.reset}`);
            await new Promise(resolve => setTimeout(resolve, 1500));
            updatingConfig = false;
            openRAMAccountManager();
            return;
        }

        let targetList = [];
        onlineDevs.forEach(dev => {
            const clients = dev.installedClients || [];
            clients.forEach(pkg => {
                const pkgClean = pkg.replace('com.roblox.', '').replace('client', 'Client ');
                const pkgSlot = pkgClean.charAt(0).toUpperCase() + pkgClean.slice(1);

                let activeUser = (dev.userIds && dev.userIds[pkg]) ? dev.userIds[pkg] : "";
                if (!activeUser || activeUser === "Unknown") {
                    activeUser = "Empty";
                }

                const currentOverride = (config.clientOverrides && config.clientOverrides[dev.deviceId] && config.clientOverrides[dev.deviceId][pkg]) || {};
                const ramUser = currentOverride.username || "";

                let tagStr = "";
                if (ramUser && ramUser !== activeUser) {
                    tagStr = ` ${colors.gray}[RAM Assigned: ${ramUser}]${colors.reset}`;
                }

                targetList.push({
                    deviceId: dev.deviceId,
                    devName: dev.displayName,
                    pkg: pkg,
                    slotLabel: pkgSlot,
                    activeUser: activeUser,
                    tagStr: tagStr
                });
            });
        });

        targetList.forEach((item, index) => {
            console.log(`  [${colors.bold}${colors.green}${index + 1}${colors.reset}] ${item.devName} -> ${colors.bold}${colors.cyan}${item.activeUser.padEnd(22)}${colors.reset}${item.tagStr}`);
        });

        console.log(`  [${colors.bold}${colors.green}C${colors.reset}] Cancel\n`);

        const ans = await askQuestion(` Select target client to log in "${username}": `);
        const choice = ans.trim().toLowerCase();
        const num = parseInt(choice, 10);

        if (num && num >= 1 && num <= targetList.length) {
            const target = targetList[num - 1];
            if (!config.clientOverrides) config.clientOverrides = {};
            if (!config.clientOverrides[target.deviceId]) config.clientOverrides[target.deviceId] = {};
            if (!config.clientOverrides[target.deviceId][target.pkg]) config.clientOverrides[target.deviceId][target.pkg] = {};

            config.clientOverrides[target.deviceId][target.pkg].cookie = cookie;
            config.clientOverrides[target.deviceId][target.pkg].username = username;

            try { fs.writeFileSync(configPath, JSON.stringify(config, null, 2)); } catch (e) { }

            const devOverrides = getOverridesForDevice(target.deviceId);
            client.publish(`${controlDevicePrefix}${target.deviceId}`, JSON.stringify({
                command: "rejoin",
                targetPackages: [target.pkg],
                placeId: config.placeId,
                privateServerLink: config.privateServerLink || "",
                clientOverrides: devOverrides,
                autoRejoinIntervalMinutes: config.autoRejoinIntervalMinutes || 0
            }));

            lastActionNotice = `${colors.green}[RAM] Logged in "${username}" to ${target.devName} (${target.slotLabel})!${colors.reset}`;
            updatingConfig = false;
            drawUI();
            return;
        }

        updatingConfig = false;
        openRAMAccountManager();
    }

    function fetchRAMEndpoint(pathStr, port, hostHeader) {
        return new Promise((resolve, reject) => {
            const req = http.request({
                host: '127.0.0.1',
                port: port || 7963,
                path: pathStr,
                headers: { 'Host': hostHeader || `localhost:${port || 7963}` }
            }, res => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
            });
            req.on('error', err => reject(err));
            req.end();
        });
    }

    async function syncRAMAccountsLive() {
        let ramDir = path.dirname(getRAMAccounts().path || "");
        let password = config.ramPassword || "";
        let port = "7963";

        if (ramDir) {
            let iniPath = path.join(ramDir, "RAMSettings.ini");
            if (fs.existsSync(iniPath)) {
                try {
                    let ini = fs.readFileSync(iniPath, 'utf8');
                    let pMatch = ini.match(/Password\s*=\s*(.+)/i);
                    let portMatch = ini.match(/WebServerPort\s*=\s*(.+)/i);
                    if (!password && pMatch && pMatch[1]) password = pMatch[1].trim();
                    if (portMatch && portMatch[1]) port = portMatch[1].trim();
                } catch (e) { }
            }
        }

        if (!password) password = "123456";

        console.log(`\n  ${colors.cyan}Connecting to RAM Web Server (http://localhost:${port})...${colors.reset}`);
        let success = false;
        try {
            let accRes = await fetchRAMEndpoint(`/GetAccounts?Password=${encodeURIComponent(password)}`, port);
            if (accRes.statusCode === 200 && accRes.body && !accRes.body.includes("Invalid") && !accRes.body.includes("Empty")) {
                let userList = accRes.body.split(',').map(u => u.trim()).filter(Boolean);
                if (userList.length > 0) {
                    let ramAccounts = [];
                    for (let username of userList) {
                        try {
                            let cookieRes = await fetchRAMEndpoint(`/GetCookie?Account=${encodeURIComponent(username)}&Password=${encodeURIComponent(password)}`, port);
                            if (cookieRes.statusCode === 200 && cookieRes.body && cookieRes.body.includes("_|WARNING")) {
                                ramAccounts.push({ username: username, cookie: cookieRes.body.trim() });
                            } else {
                                ramAccounts.push({ username: username, cookie: "" });
                            }
                        } catch (e) {
                            ramAccounts.push({ username: username, cookie: "" });
                        }
                    }

                    if (ramAccounts.length > 0) {
                        success = true;
                        config.cachedRamAccounts = ramAccounts;
                        let assignedCount = 0;
                        const onlineDevs = Object.values(devices).filter(d => d.state === "ONLINE");
                        if (!config.clientOverrides) config.clientOverrides = {};

                        onlineDevs.forEach(dev => {
                            if (!config.clientOverrides[dev.deviceId]) config.clientOverrides[dev.deviceId] = {};
                            const clients = dev.installedClients || [];
                            clients.forEach(pkg => {
                                if (assignedCount < ramAccounts.length) {
                                    const acc = ramAccounts[assignedCount];
                                    if (!config.clientOverrides[dev.deviceId][pkg]) config.clientOverrides[dev.deviceId][pkg] = {};
                                    if (acc.cookie) config.clientOverrides[dev.deviceId][pkg].cookie = acc.cookie;
                                    if (acc.username) config.clientOverrides[dev.deviceId][pkg].username = acc.username;

                                    assignedCount++;
                                }
                            });
                        });

                        try { fs.writeFileSync(configPath, JSON.stringify(config, null, 2)); } catch (e) { }

                        onlineDevs.forEach(dev => {
                            const devOverrides = getOverridesForDevice(dev.deviceId);
                            client.publish(`${controlDevicePrefix}${dev.deviceId}`, JSON.stringify({
                                command: "update_overrides",
                                clientOverrides: devOverrides
                            }));
                        });

                        lastActionNotice = `${colors.green}[RAM] Synced ${ramAccounts.length} cookies.${colors.reset}`;
                        managingRAM = false;
                        drawUI();
                        return;
                    }
                }
            }
        } catch (e) { }

        if (!success) {
            updatingConfig = true;
            process.stdout.write('\u001b[?1049l\u001b[?25h');
            console.clear();
            const clipboardRaw = getClipboardText().replace(/[\r\n]+/g, "").replace(/^["']|["']$/g, '').trim();

            console.log(`\n ${colors.cyan}╔══════ RAM WEBSERVER PASSWORD ═══════════════════════════════════════╗${colors.reset}\n`);
            console.log(`  ${colors.red}[!] Unable to sync live cookies using password: "${password}"${colors.reset}`);
            console.log(`  ${colors.gray}Ensure "Roblox Account Manager.exe" is running on your PC.${colors.reset}\n`);
            console.log(`  Clipboard Content: ${colors.gray}${clipboardRaw || "Empty"}${colors.reset}\n`);
            console.log(`  [${colors.bold}${colors.green}1${colors.reset}] Enter Custom RAM Password`);
            console.log(`  [${colors.bold}${colors.cyan}2${colors.reset}] Use Password from Clipboard`);
            console.log(`  [${colors.bold}${colors.green}C${colors.reset}] Cancel\n`);

            console.log(` Press a key [1, 2, or C]...`);

            const passKey = await getSingleKeyChoice();

            if (passKey === 'c' || passKey === '\x1b' || passKey === '\x03') {
                updatingConfig = false;
                openRAMAccountManager();
                return;
            }

            if (passKey === '1') {
                const passInput = await askQuestion(` Enter RAM WebServer Password: `);
                if (passInput.trim()) {
                    config.ramPassword = passInput.trim();
                    try { fs.writeFileSync(configPath, JSON.stringify(config, null, 2)); } catch (e) { }
                    lastActionNotice = `${colors.green}RAM Password saved.${colors.reset}`;
                }
            } else if ((passKey === '2' || passKey === '\r' || passKey === '\n') && clipboardRaw) {
                config.ramPassword = clipboardRaw;
                try { fs.writeFileSync(configPath, JSON.stringify(config, null, 2)); } catch (e) { }
                lastActionNotice = `${colors.green}RAM Password set from clipboard.${colors.reset}`;
            }

            updatingConfig = false;
            openRAMAccountManager();
        }
    }

    function keypressHandler(str, key) {
        if (updatingConfig) return;

        if (managingRAM) {
            if (key.ctrl && key.name === 'c' || key.name === 'c' || key.name === 'escape') {
                managingRAM = false;
                drawUI();
                return;
            }
            if (key.name === 's') {
                const ramInfo = getRAMAccounts();
                if (ramInfo.accounts.length > 0) {
                    managingRAM = false;
                    promptAccountSelection(ramInfo.accounts);
                    return;
                }
            }
            if (key.name === 'p') {
                managingRAM = false;
                setRAMPathPrompt();
                return;
            }
            if (key.name === 'r') {
                syncRAMAccountsLive();
                return;
            }
            if (key.name === 'a') {
                managingRAM = false;
                autoAssignRAMAccountsToAll();
                return;
            }
            return;
        }

        if (selectingDevice) {
            if (key.ctrl && key.name === 'c' || key.name === 'q') {
                client.end();
                process.exit();
            }
            if (key.name === 'c' || key.name === 'escape') {
                selectingDevice = false;
                drawUI();
                return;
            }
            const num = parseInt(str, 10);
            const ids = (config.deviceOrder || []).filter(id => devices[id]);
            if (num && num >= 1 && num <= ids.length) {
                configuringDevice = devices[ids[num - 1]];
                selectingDevice = false;
                drawClientSelectionMenu();
            }
            return;
        }

        if (configuringDevice) {
            if (key.ctrl && key.name === 'c' || key.name === 'q') {
                client.end();
                process.exit();
            }
            if (key.name === 'c' || key.name === 'escape') {
                const pcList = configuringDevice.activeClients || [];
                if (!config.deviceTargets) config.deviceTargets = {};
                config.deviceTargets[configuringDevice.deviceId] = [...pcList];
                try {
                    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
                    updateMobileUpdateFile();
                } catch (e) { }

                client.publish(`${controlDevicePrefix}${configuringDevice.deviceId}`, JSON.stringify({
                    command: "update_packages",
                    packageNames: pcList
                }));

                configuringDevice = null;
                drawUI();
                return;
            }
            if (key.name === 'p') {
                configureCustomPrivateServerLink();
                return;
            }
            if (key.name === 'l') {
                configureClientPSCycleList();
                return;
            }
            if (key.name === 'r') {
                isRejoinerPaused = false;
                config.rejoinerActive = true;
                configuringDevice.isPaused = true;
                try { fs.writeFileSync(configPath, JSON.stringify(config, null, 2)); } catch (e) { }

                const devOverrides = getOverridesForDevice(configuringDevice.deviceId);
                client.publish(`${controlDevicePrefix}${configuringDevice.deviceId}`, JSON.stringify({
                    command: "rejoin",
                    placeId: config.placeId,
                    privateServerLink: config.privateServerLink || "",
                    clientOverrides: devOverrides,
                    autoRejoinIntervalMinutes: config.autoRejoinIntervalMinutes || 0
                }));
                lastActionNotice = `${colors.green}[R] REJOIN command sent to ${configuringDevice.displayName}.${colors.reset}`;
                configuringDevice = null;
                drawUI();
                return;
            }
            if (key.name === 'k') {
                configuringDevice.isPaused = true;
                client.publish(`${controlDevicePrefix}${configuringDevice.deviceId}`, JSON.stringify({
                    command: "kill"
                }));
                lastActionNotice = `${colors.red}[K] KILL sent to ${configuringDevice.displayName}.${colors.reset}`;
                configuringDevice = null;
                drawUI();
                return;
            }
            const num = parseInt(str, 10);
            if (num && num >= 1 && num <= configuringDevice.installedClients.length) {
                const pkg = configuringDevice.installedClients[num - 1];
                if (!configuringDevice.activeClients) {
                    configuringDevice.activeClients = [];
                }
                const idx = configuringDevice.activeClients.indexOf(pkg);
                if (idx > -1) {
                    configuringDevice.activeClients.splice(idx, 1);
                } else {
                    configuringDevice.activeClients.push(pkg);
                }
                drawClientSelectionMenu();
            }
            return;
        }

        if (key.ctrl && key.name === 'c' || key.name === '0') {
            process.stdout.write('\u001b[?1049l\u001b[?25h');
            client.end();
            process.exit();
        }

        if (key.name === 'n' || key.name === 'right') {
            const devIds = (config.deviceOrder || []).filter(id => devices[id]);
            const totalP = Math.ceil(devIds.length / 4) || 1;
            currentDevicePage = (currentDevicePage + 1) % totalP;
            drawUI();
            return;
        }

        if (key.name === 'p' || key.name === 'left') {
            const devIds = (config.deviceOrder || []).filter(id => devices[id]);
            const totalP = Math.ceil(devIds.length / 4) || 1;
            currentDevicePage = (currentDevicePage - 1 + totalP) % totalP;
            drawUI();
            return;
        }

        if (key.name === '1') {
            isRejoinerPaused = false;
            config.rejoinerActive = true;
            try { fs.writeFileSync(configPath, JSON.stringify(config, null, 2)); } catch (e) { }
            const onlineDevs = Object.values(devices).filter(d => d.state === "ONLINE");
            onlineDevs.forEach(dev => {
                dev.isPaused = true;
                const devOverrides = getOverridesForDevice(dev.deviceId);
                client.publish(`${controlDevicePrefix}${dev.deviceId}`, JSON.stringify({
                    command: "rejoin",
                    placeId: config.placeId,
                    privateServerLink: config.privateServerLink || "",
                    clientOverrides: devOverrides,
                    autoRejoinIntervalMinutes: config.autoRejoinIntervalMinutes || 0
                }));
            });
            lastActionNotice = `${colors.green}[1] REJOIN command sent to ${onlineDevs.length} online device(s).${colors.reset}`;
            drawUI();
        } else if (key.name === '2') {
            isRejoinerPaused = true;
            config.rejoinerActive = false;
            try { fs.writeFileSync(configPath, JSON.stringify(config, null, 2)); } catch (e) { }
            const onlineDevs = Object.values(devices).filter(d => d.state === "ONLINE");
            onlineDevs.forEach(dev => {
                client.publish(`${controlDevicePrefix}${dev.deviceId}`, JSON.stringify({
                    command: "kill"
                }));
            });
            lastActionNotice = `${colors.red}[2] KILL command sent to ${onlineDevs.length} online device(s).${colors.reset}`;
            drawUI();
        } else if (key.name === '3') {
            const ids = (config.deviceOrder || []).filter(id => devices[id]);
            if (ids.length === 1) {

                configuringDevice = devices[ids[0]];
                drawClientSelectionMenu();
            } else if (ids.length > 1) {
                selectingDevice = true;
                drawDeviceSelectionMenu();
            } else {
                drawUI();
            }
        } else if (key.name === '4') {

            const intervals = [0, 1, 5, 10, 15, 30, 60];
            const currentIdx = intervals.indexOf(config.autoRejoinIntervalMinutes || 0);
            const nextIdx = (currentIdx + 1) % intervals.length;
            config.autoRejoinIntervalMinutes = intervals[nextIdx];
            lastRejoinTime = new Date();
            config.lastRejoinTime = lastRejoinTime.toISOString();
            try {
                fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
                updateMobileUpdateFile();
            } catch (e) { }
            lastActionNotice = `${colors.yellow}[4] Auto-Rejoin interval set to ${config.autoRejoinIntervalMinutes > 0 ? config.autoRejoinIntervalMinutes + ' mins' : 'Disabled'}.${colors.reset}`;
            drawUI();
        } else if (key.name === '5') {
            configureGlobalPrivateServerLink();
        } else if (key.name === '6') {
            lastActionNotice = `${colors.green}[6] Set Roblox Place ID triggered.${colors.reset}`;
            savePlaceIdFromClipboard();
        } else if (key.name === '7') {
            isRejoinerPaused = true;
            lastRejoinTime = null;
            config.rejoinerActive = false;
            config.lastRejoinTime = null;
            try { fs.writeFileSync(configPath, JSON.stringify(config, null, 2)); } catch (e) { }
            Object.values(devices).forEach(dev => {
                if (dev.state === "ONLINE") {
                    client.publish(`${controlDevicePrefix}${dev.deviceId}`, JSON.stringify({
                        command: "stop"
                    }));
                }
            });
            lastActionNotice = `${colors.yellow}[7] Auto-Rejoin monitoring PAUSED.${colors.reset}`;
            drawUI();
        } else if (key.name === '8') {
            const onlineDevs = Object.values(devices).filter(d => d.state === "ONLINE");
            onlineDevs.forEach(dev => {
                client.publish(`${controlDevicePrefix}${dev.deviceId}`, JSON.stringify({
                    command: "update"
                }));
            });
            client.publish(`roblox/control/${connectionCode}/all`, JSON.stringify({
                command: "update"
            }));
            lastActionNotice = `${colors.green}[8] UPDATE command broadcast to mobile device(s).${colors.reset}`;
            drawUI();
        } else if (key.name === '9') {
            openRAMAccountManager();
        }
    }

    process.stdin.on('keypress', keypressHandler);

    setInterval(() => {
        const now = new Date();
        let changed = false;

        const deviceIds = Object.keys(devices);

        deviceIds.forEach((id) => {
            const dev = devices[id];
            if (dev.state === "ONLINE" && (now.getTime() - dev.lastSeen.getTime() > 45000)) {
                dev.state = "OFFLINE";
                changed = true;
            }
        });

        if (!isRejoinerPaused && config.clientOverrides) {
            let cycleChanged = false;
            Object.keys(config.clientOverrides).forEach(devKey => {
                const devObj = config.clientOverrides[devKey];
                const devInstance = devices[devKey];
                if (devObj && typeof devObj === 'object' && devInstance && devInstance.state === "ONLINE") {
                    let deviceNeedsRejoin = false;
                    Object.keys(devObj).forEach(pkgKey => {
                        const clientObj = devObj[pkgKey];
                        if (clientObj && Array.isArray(clientObj.privateServerList) && clientObj.privateServerList.length > 1) {
                            const clientIntervalSecs = clientObj.cycleIntervalSeconds || ((clientObj.cycleIntervalMinutes || config.autoRejoinIntervalMinutes || 2) * 60);
                            const lastTime = clientObj.lastCycleTime ? new Date(clientObj.lastCycleTime) : (lastRejoinTime || now);
                            const diffSecs = (now.getTime() - lastTime.getTime()) / 1000;
                            if (diffSecs >= clientIntervalSecs) {
                                const curIdx = clientObj.currentPSIndex || 0;
                                clientObj.currentPSIndex = (curIdx + 1) % clientObj.privateServerList.length;
                                clientObj.lastCycleTime = now.toISOString();
                                deviceNeedsRejoin = true;
                                cycleChanged = true;
                            }
                        }
                    });
                    if (deviceNeedsRejoin) {
                        const devOverrides = getOverridesForDevice(devKey);
                        client.publish(`${controlDevicePrefix}${devKey}`, JSON.stringify({
                            command: "rejoin",
                            placeId: config.placeId,
                            privateServerLink: config.privateServerLink || "",
                            clientOverrides: devOverrides
                        }));
                        lastActionNotice = `${colors.green}[PS Cycle] Rotated server for ${devInstance.displayName}.${colors.reset}`;
                    }
                }
            });
            if (cycleChanged) {
                try { fs.writeFileSync(configPath, JSON.stringify(config, null, 2)); } catch (e) { }
            }
        }

        if (!isRejoinerPaused && config.autoRejoinIntervalMinutes > 0 && lastRejoinTime) {
            const diffMs = now.getTime() - lastRejoinTime.getTime();
            const diffMins = diffMs / 1000 / 60;
            if (diffMins >= config.autoRejoinIntervalMinutes) {
                const onlineDevs = Object.values(devices).filter(d => d.state === "ONLINE");
                if (onlineDevs.length > 0) {
                    lastRejoinTime = now;
                    config.lastRejoinTime = lastRejoinTime.toISOString();
                    try { fs.writeFileSync(configPath, JSON.stringify(config, null, 2)); } catch (e) { }
                    changed = true;
                    onlineDevs.forEach(dev => {
                        const devOverrides = getOverridesForDevice(dev.deviceId);
                        client.publish(`${controlDevicePrefix}${dev.deviceId}`, JSON.stringify({
                            command: "rejoin",
                            placeId: config.placeId,
                            privateServerLink: config.privateServerLink || "",
                            clientOverrides: devOverrides
                        }));
                    });
                    lastActionNotice = `${colors.green}[Auto-Rejoin] Triggered for ${onlineDevs.length} device(s).${colors.reset}`;
                } else {
                    lastActionNotice = `${colors.yellow}[Auto-Rejoin] Timer due (${config.autoRejoinIntervalMinutes}m), waiting for device to reconnect...${colors.reset}`;
                }
            }
        }

        const showCountdown = (config.autoRejoinIntervalMinutes > 0 && lastRejoinTime !== null && !isRejoinerPaused);
        if (changed || showCountdown) {
            if (!selectingDevice && !configuringDevice && !updatingConfig && !managingRAM) {
                drawUI();
            }
        }
    }, 1000);
}

main().catch(err => {
    console.error("[-] Execution error:", err);
});