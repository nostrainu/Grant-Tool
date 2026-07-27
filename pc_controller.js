const fs = require('fs');
const path = require('path');
const mqtt = require('mqtt');
const readline = require('readline');
const { execSync } = require('child_process');
const https = require('https');

function getClipboardText() {
    try {
        const text = execSync('powershell -NoProfile -Command "Get-Clipboard"', { encoding: 'utf8', timeout: 2000 });
        if (text && text.trim()) {
            return text.trim();
        }
    } catch (e) {}
    try {
        const text = execSync('powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::GetText()"', { encoding: 'utf8', timeout: 2000 });
        return text.trim();
    } catch (e) {
        return "";
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
    try {
        if (fs.existsSync(configPath)) {
            config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            if (config.autoRejoinIntervalMinutes === undefined) {
                config.autoRejoinIntervalMinutes = 0;
            }
            if (config.clientOverrides === undefined) {
                config.clientOverrides = {};
            }
            if (config.deviceTargets === undefined) {
                config.deviceTargets = {};
            }
        } else {
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
            fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        }
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
    } catch (e) {
        console.error("[-] Failed to load config.json:", e.message);
        process.exit(1);
    }
}

function getOverridesForDevice(deviceId) {
    if (!config.clientOverrides) return {};
    if (config.clientOverrides[deviceId]) {
        return config.clientOverrides[deviceId];
    }
    const legacy = {};
    Object.keys(config.clientOverrides).forEach(k => {
        if (!k.startsWith('device_')) {
            legacy[k] = config.clientOverrides[k];
        }
    });
    return legacy;
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
    loadConfig();

    const usernamesPath = path.join(__dirname, 'usernames.json');
    let usernameCache = {};
    try {
        if (fs.existsSync(usernamesPath)) {
            usernameCache = JSON.parse(fs.readFileSync(usernamesPath, 'utf8'));
        }
    } catch (e) {}

    function saveUsernameCache() {
        try {
            const toSave = {};
            for (const key in usernameCache) {
                if (!key.endsWith("_fetching")) {
                    toSave[key] = usernameCache[key];
                }
            }
            fs.writeFileSync(usernamesPath, JSON.stringify(toSave, null, 2));
        } catch (e) {}
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

    async function savePrivateServerLinkFromClipboard() {
        updatingConfig = true;
        console.clear();
        console.log(`\n ${colors.cyan}--- SET PRIVATE SERVER LINK FROM CLIPBOARD ---${colors.reset}`);
        console.log(` ${colors.gray}Reading from clipboard...${colors.reset}`);
        
        const clipboardText = getClipboardText().replace(/[\r\n]+/g, "");
        if (clipboardText) {
            config.privateServerLink = clipboardText;
            try {
                fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
                updateMobileUpdateFile();
                console.log(`\n ${colors.green}[+] Private Server Link updated successfully!${colors.reset}`);
                console.log(`     Link: ${config.privateServerLink.length > 45 ? "..." + config.privateServerLink.slice(-40) : config.privateServerLink}`);
            } catch (e) {
                console.error("[-] Failed to save config:", e.message);
            }
        } else {
            console.log(`\n ${colors.red}[!] Clipboard is empty or contains invalid text.${colors.reset}`);
        }
        
        await new Promise(resolve => setTimeout(resolve, 2000));
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

    function drawUI() {
        console.clear();

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
            try { fs.writeFileSync(configPath, JSON.stringify(config, null, 2)); } catch (e) {}
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

        const statusLabel = `${colors.bold}${"Rejoiner Status:".padEnd(20)}${colors.reset}`;
        if (isRejoinerPaused) {
            printInnerLine(`${statusLabel}${colors.yellow}${colors.bold}STOPPED / PAUSED${colors.reset} ${colors.gray}(Press 1 to start)${colors.reset}`);
        } else {
            printInnerLine(`${statusLabel}${colors.green}${colors.bold}ACTIVE & MONITORING${colors.reset}`);
        }

        const intervalColor = `${colors.bold}${"Auto-Rejoin:".padEnd(20)}${colors.reset}`;
        if (config.autoRejoinIntervalMinutes > 0) {
            if (lastRejoinTime && !isRejoinerPaused) {
                const nextRejoin = new Date(lastRejoinTime.getTime() + config.autoRejoinIntervalMinutes * 60 * 1000);
                const remainingMs = nextRejoin.getTime() - new Date().getTime();
                const remainingSecs = Math.max(0, Math.ceil(remainingMs / 1000));
                const mins = Math.floor(remainingSecs / 60);
                const secs = remainingSecs % 60;
                const timeStr = `${mins}:${String(secs).padStart(2, '0')}`;
                printInnerLine(`${intervalColor}${colors.green}Every ${config.autoRejoinIntervalMinutes} mins (Next in: ${timeStr})${colors.reset}`);
            } else {
                printInnerLine(`${intervalColor}${colors.yellow}Every ${config.autoRejoinIntervalMinutes} mins (PAUSED - Press 1 to start)${colors.reset}`);
            }
        } else {
            printInnerLine(`${intervalColor}${colors.gray}Disabled (Press 4 to set)${colors.reset}`);
        }

        printInnerLine(`${colors.gray}${"─".repeat(innerWidth - 4)}${colors.reset}`);
        printInnerLine(`${colors.bold}${colors.cyan}CONNECTED DEVICES:${colors.reset}`);

        if (deviceIds.length > 0) {
            deviceIds.forEach((id, index) => {
                const dev = devices[id];
                
                const devHeaderColor = `  [${colors.bold}${colors.cyan}${index + 1}${colors.reset}] Dev: ${colors.cyan}${dev.displayName}${colors.reset} (${dev.state === "ONLINE" ? colors.green : colors.red}${dev.state}${colors.reset})`;
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
                    const colorLine = `       ${checkMark} ${displayName.padEnd(24)} - ${statusColor}[${statusText}]${colors.reset}`;
                    printInnerLine(colorLine);
                });
                if (index < deviceIds.length - 1) {
                    printInnerLine("");
                }
            });
        } else {
            printInnerLine(`${colors.gray}Waiting for devices to connect (run rejoin.py in Termux)...${colors.reset}`);
        }

        printOuterLine(` ${innerBottomBorder} `);
        console.log(` ${outerBottomBorder}`);
        
        console.log(`\n ${colors.bold}${colors.cyan}LATEST DEVICE LOGS:${colors.reset}`);
        if (deviceIds.length > 0) {
            deviceIds.forEach((id) => {
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

        console.log(`\n ${colors.bold}${colors.cyan}CONTROLS:${colors.reset}`);
        console.log(`  [${colors.bold}${colors.green}1${colors.reset}] Start Rejoin        [${colors.bold}${colors.green}4${colors.reset}] Rejoin Interval      [${colors.bold}${colors.green}7${colors.reset}] Stop Rejoiner`);
        console.log(`  [${colors.bold}${colors.green}2${colors.reset}] Kill Clients        [${colors.bold}${colors.green}5${colors.reset}] Set Private Server   [${colors.bold}${colors.green}0${colors.reset}] Quit Dashboard`);
        console.log(`  [${colors.bold}${colors.green}3${colors.reset}] Select Clients      [${colors.bold}${colors.green}6${colors.reset}] Set Roblox Place ID`);
        console.log(`\n ${colors.bold}Last Action:${colors.reset} ${lastActionNotice}`);
        console.log(` ${colors.bold}${colors.green}Press a control key [0-7]:${colors.reset} `);
        process.stdout.write('\u001b[J');
    }

    function drawDeviceSelectionMenu() {
        process.stdout.write('\u001b[2J\u001b[H');
        
        console.log(`\n ${colors.cyan}╔══════ SELECT DEVICE TO CONFIGURE ═════════════════════════════════════════╗${colors.reset}\n`);
        const deviceIds = (config.deviceOrder || []).filter(id => devices[id]);
        deviceIds.forEach((id, index) => {
            console.log(`  [${colors.bold}${index + 1}${colors.reset}] Device ID: ${colors.cyan}${devices[id].displayName}${colors.reset}`);
        });
        console.log(`  [${colors.bold}C${colors.reset}] Cancel and return\n`);
        console.log(" Press a number key to select a device, or 'C' to cancel...");
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
            if (devOverrides[pkg] && devOverrides[pkg].privateServerLink) {
                const link = devOverrides[pkg].privateServerLink;
                const shortLink = link.length > 25 ? "..." + link.slice(-20) : link;
                customTag = ` ${colors.yellow}(Custom PS: ${shortLink})${colors.reset}`;
            }

            console.log(`  [${colors.bold}${index + 1}${colors.reset}] ${check} ${displayName.padEnd(25)}${customTag}`);
        });
        console.log(`\n  [${colors.bold}P${colors.reset}] Configure Custom Private Server Link for a Client`);
        console.log(`  [${colors.bold}C${colors.reset}] Save targets and return\n`);
        console.log(" Press number keys (1-4) to toggle targets, 'P' to set Custom PS, or 'C' to save & return...");
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
            } catch (e) {}
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

    process.stdout.write('\u001b[?1049h\u001b[?25l'); 
    
    drawUI(); 
    
    const client = mqtt.connect(brokerUrl);

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
                } else {
                    devices[deviceId].installedClients = payload.installedClients || [];
                    if (savedTargets) {
                        devices[deviceId].activeClients = [...savedTargets];
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
                    if (savedTargets) {
                        devices[deviceId].activeClients = [...savedTargets];
                    }
                    devices[deviceId].runningStates = payload.runningStates || {};
                    devices[deviceId].userIds = payload.userIds || {};
                    devices[deviceId].lastLog = payload.log || devices[deviceId].lastLog;
                    devices[deviceId].lastLogTime = payload.logTime || devices[deviceId].lastLogTime;
                    devices[deviceId].lastSeen = new Date();
                    devices[deviceId].state = "ONLINE";

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

            if (!selectingDevice && !configuringDevice && !updatingConfig) {
                drawUI();
            }
        } catch (e) {
        }
    });

    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
    }

    function keypressHandler(str, key) {
        if (updatingConfig) return;
        
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
                } catch (e) {}

                client.publish(`${controlDevicePrefix}${configuringDevice.deviceId}`, JSON.stringify({
                    command: "update_packages",
                    packageNames: pcList
                }));

                configuringDevice = null;
                drawUI();
                return;
            }
            if (key.name === 'p' || key.name === 'P') {
                configureCustomPrivateServerLink();
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
        
        if (key.name === '1') {
            isRejoinerPaused = false;
            lastRejoinTime = new Date();
            config.rejoinerActive = true;
            config.lastRejoinTime = lastRejoinTime.toISOString();
            try { fs.writeFileSync(configPath, JSON.stringify(config, null, 2)); } catch (e) {}
            const onlineDevs = Object.values(devices).filter(d => d.state === "ONLINE");
            onlineDevs.forEach(dev => {
                const devOverrides = getOverridesForDevice(dev.deviceId);
                client.publish(`${controlDevicePrefix}${dev.deviceId}`, JSON.stringify({
                    command: "rejoin",
                    placeId: config.placeId,
                    privateServerLink: config.privateServerLink || "",
                    clientOverrides: devOverrides
                }));
            });
            lastActionNotice = `${colors.green}[1] REJOIN command sent to ${onlineDevs.length} online device(s).${colors.reset}`;
            drawUI();
        } else if (key.name === '2') {
            isRejoinerPaused = true;
            config.rejoinerActive = false;
            try { fs.writeFileSync(configPath, JSON.stringify(config, null, 2)); } catch (e) {}
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
            } catch (e) {}
            lastActionNotice = `${colors.yellow}[4] Auto-Rejoin interval set to ${config.autoRejoinIntervalMinutes > 0 ? config.autoRejoinIntervalMinutes + ' mins' : 'Disabled'}.${colors.reset}`;
            drawUI();
        } else if (key.name === '5') {
            lastActionNotice = `${colors.green}[5] Set Private Server Link triggered.${colors.reset}`;
            savePrivateServerLinkFromClipboard();
        } else if (key.name === '6') {
            lastActionNotice = `${colors.green}[6] Set Roblox Place ID triggered.${colors.reset}`;
            savePlaceIdFromClipboard();
        } else if (key.name === '7') {
            isRejoinerPaused = true;
            lastRejoinTime = null;
            config.rejoinerActive = false;
            config.lastRejoinTime = null;
            try { fs.writeFileSync(configPath, JSON.stringify(config, null, 2)); } catch (e) {}
            Object.values(devices).forEach(dev => {
                if (dev.state === "ONLINE") {
                    client.publish(`${controlDevicePrefix}${dev.deviceId}`, JSON.stringify({
                        command: "stop"
                    }));
                }
            });
            lastActionNotice = `${colors.yellow}[7] Auto-Rejoin monitoring PAUSED.${colors.reset}`;
            drawUI();
        }
    }

    process.stdin.on('keypress', keypressHandler);

    setInterval(() => {
        const now = new Date();
        let changed = false;
        
        const deviceIds = Object.keys(devices);

        deviceIds.forEach((id) => {
            const dev = devices[id];
            if (dev.state === "ONLINE" && (now.getTime() - dev.lastSeen.getTime() > 15000)) {
                dev.state = "OFFLINE";
                changed = true;
            }
        });

        if (!isRejoinerPaused && config.autoRejoinIntervalMinutes > 0 && lastRejoinTime) {
            const diffMs = now.getTime() - lastRejoinTime.getTime();
            const diffMins = diffMs / 1000 / 60;
            if (diffMins >= config.autoRejoinIntervalMinutes) {
                const onlineDevs = Object.values(devices).filter(d => d.state === "ONLINE");
                if (onlineDevs.length > 0) {
                    lastRejoinTime = now;
                    config.lastRejoinTime = lastRejoinTime.toISOString();
                    try { fs.writeFileSync(configPath, JSON.stringify(config, null, 2)); } catch (e) {}
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
                }
            }
        }

        const showCountdown = (config.autoRejoinIntervalMinutes > 0 && lastRejoinTime !== null && !isRejoinerPaused);
        if (changed || showCountdown) {
            if (!selectingDevice && !configuringDevice && !updatingConfig) {
                drawUI();
            }
        }
    }, 1000);
}

main().catch(err => {
    console.error("[-] Execution error:", err);
});

