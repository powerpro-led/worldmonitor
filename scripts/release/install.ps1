<#
  worldmonitor-local — one-command installer (Windows)

      irm https://github.com/powerpro-led/worldmonitor/releases/latest/download/install.ps1 | iex

  With nothing pre-installed:
    1. fetches a pinned Node build from nodejs.org into %USERPROFILE%\.worldmonitor\runtime\
       (SHA-256-verified against the official SHASUMS256.txt)
    2. downloads + verifies the release bundle into %USERPROFILE%\.worldmonitor\app\
       (keeps an existing .env across upgrades)
    3. runs the bundle's setup.ps1 with that Node — npm ci, .env, config seed,
       per-user Scheduled Task, VS Code .vsix
    4. drops a Desktop launcher that opens the backend control panel

  Params (optional):
    -Config <org.env>      org config file (forwarded to setup.ps1)
    -AppVersion <x.y.z>    install a specific release instead of the pinned one
  Offline: set $env:WM_NODE_TARBALL / $env:WM_APP_ZIP to local files.
#>

param(
  [string]$Config,
  [string]$AppVersion = '2.13.0'
)

$ErrorActionPreference = 'Stop'

# ── pinned versions (D15 — bump per release) ─────────────────────────────
$NodeVersion = 'v22.23.2'
$GhRepo = 'powerpro-led/worldmonitor'

$WmDir = Join-Path $env:USERPROFILE '.worldmonitor'
$RuntimeDir = Join-Path $WmDir 'runtime'
$AppDir = Join-Path $WmDir 'app'

function Say  ($m) { Write-Host "`n$m" -ForegroundColor Cyan }
function Info ($m) { Write-Host "  $m" }
function Die  ($m) { Write-Host "`nerror: $m" -ForegroundColor Red; exit 1 }

if ([Environment]::Is64BitOperatingSystem) {
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
} else { Die '32-bit Windows is not supported.' }
$nodePlat = "win-$arch"

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("wm-install-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  Say "worldmonitor-local installer (Windows)"
  Info "platform:  $nodePlat"
  Info "node:      $NodeVersion   ->  $RuntimeDir"
  Info "app:       v$AppVersion   ->  $AppDir"

  # ── 1. Node runtime ──────────────────────────────────────────────────
  $runtimeNode = Join-Path $RuntimeDir 'node.exe'
  $have = if (Test-Path $runtimeNode) { (& $runtimeNode -v) } else { '' }
  if ($have -eq $NodeVersion) {
    Say "Node $NodeVersion already present - skipping download."
  } else {
    Say "Fetching Node $NodeVersion..."
    $nodeZip = "node-$NodeVersion-$nodePlat.zip"
    $zipPath = Join-Path $tmp $nodeZip
    if ($env:WM_NODE_TARBALL) {
      Copy-Item $env:WM_NODE_TARBALL $zipPath
      Info "using local $($env:WM_NODE_TARBALL) (checksum skipped)"
    } else {
      Invoke-WebRequest -UseBasicParsing "https://nodejs.org/dist/$NodeVersion/$nodeZip" -OutFile $zipPath
      $sums = (Invoke-WebRequest -UseBasicParsing "https://nodejs.org/dist/$NodeVersion/SHASUMS256.txt").Content
      $want = ($sums -split "`n" | Where-Object { $_ -match [regex]::Escape($nodeZip) + '$' })
      if (-not $want) { Die "no SHASUMS entry for $nodeZip" }
      $want = ($want -split '\s+')[0].ToLower()
      $got = (Get-FileHash $zipPath -Algorithm SHA256).Hash.ToLower()
      if ($got -ne $want) { Die "Node checksum mismatch`n  want $want`n  got  $got" }
      Info "checksum OK"
    }
    if (Test-Path $RuntimeDir) { Remove-Item -Recurse -Force $RuntimeDir }
    $extract = Join-Path $tmp 'node-extract'
    Expand-Archive -Path $zipPath -DestinationPath $extract -Force
    # the zip has one top-level node-vX-win-arch\ dir — flatten it into RuntimeDir
    $inner = Get-ChildItem -Directory $extract | Select-Object -First 1
    Move-Item $inner.FullName $RuntimeDir
    Info "installed $(& $runtimeNode -v)"
  }
  $env:PATH = "$RuntimeDir;$env:PATH"

  # ── 2. app bundle ───────────────────────────────────────────────────
  Say "Fetching worldmonitor-local v$AppVersion..."
  $appZip = "worldmonitor-local-$AppVersion.zip"
  $appZipPath = Join-Path $tmp $appZip
  if ($env:WM_APP_ZIP) {
    Copy-Item $env:WM_APP_ZIP $appZipPath
    Info "using local $($env:WM_APP_ZIP) (checksum skipped)"
  } else {
    $base = "https://github.com/$GhRepo/releases/download/v$AppVersion"
    Invoke-WebRequest -UseBasicParsing "$base/$appZip" -OutFile $appZipPath
    $wantLine = (Invoke-WebRequest -UseBasicParsing "$base/$appZip.sha256").Content
    $want = ($wantLine -split '\s+')[0].ToLower()
    $got = (Get-FileHash $appZipPath -Algorithm SHA256).Hash.ToLower()
    if ($got -ne $want) { Die "bundle checksum mismatch" }
    Info "checksum OK"
  }

  $savedEnv = $null
  if (Test-Path (Join-Path $AppDir '.env')) {
    $savedEnv = Join-Path $tmp 'saved.env'
    Copy-Item (Join-Path $AppDir '.env') $savedEnv
    Info "kept your existing .env"
  }
  if (Test-Path $AppDir) { Remove-Item -Recurse -Force $AppDir }
  $appExtract = Join-Path $tmp 'app-extract'
  Expand-Archive -Path $appZipPath -DestinationPath $appExtract -Force
  $innerApp = Get-ChildItem -Directory $appExtract | Select-Object -First 1
  Move-Item $innerApp.FullName $AppDir
  if ($savedEnv) { Copy-Item $savedEnv (Join-Path $AppDir '.env') -Force }

  # ── 3. hand off to the in-bundle setup ────────────────────────────
  Say "Running setup..."
  Push-Location $AppDir
  try {
    if ($Config) { .\setup.ps1 -Config $Config } else { .\setup.ps1 }
  } finally { Pop-Location }

  Say "Installed."
  Info "Control panel:  http://127.0.0.1:46123/settings.html"
  Info "A Desktop launcher (WorldMonitor.url) was added."
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
