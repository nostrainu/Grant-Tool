$ErrorActionPreference = "Stop"
$root = "c:\Users\mj\Desktop\vs\Grant Tool"
$staging = Join-Path $root "zip_staging"

if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
New-Item -ItemType Directory -Path $staging | Out-Null

Copy-Item (Join-Path $root "pc_controller.js") $staging
Copy-Item (Join-Path $root "default_config.json") (Join-Path $staging "config.json")
Copy-Item (Join-Path $root "GrantRejoiner.bat") $staging
Copy-Item (Join-Path $root "package.json") $staging
Copy-Item (Join-Path $root "rejoin.py") $staging
Copy-Item (Join-Path $root "mobile update") $staging

$zipPath = Join-Path $root "Grant-v2.0.zip"
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
Compress-Archive -Path (Join-Path $staging "*") -DestinationPath $zipPath

Remove-Item $staging -Recurse -Force
Write-Host "Zip created successfully"
