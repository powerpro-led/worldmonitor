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

# Fetch a small text resource as an actual string.
#
# NEVER use `(Invoke-WebRequest ...).Content` for this. On Windows PowerShell
# 5.1 that property is a [string] for a `text/*` response but a [byte[]] for
# anything else — and GitHub serves release assets as
# `application/octet-stream`. Splitting a byte[] on whitespace yields "53",
# the ASCII code of the first character '5', so the bundle checksum compared
# "53" against the real digest and **every Windows install failed with
# "bundle checksum mismatch"**. The Node step got away with the same code only
# because nodejs.org serves SHASUMS256.txt as text/plain.
#
# Going through -OutFile removes the content-type dependency entirely, so both
# callers below are correct regardless of what the server declares.
# Found on the first real Windows install, 2026-09-19.
function Get-RemoteText ($url) {
  $f = Join-Path $tmp ([guid]::NewGuid().ToString('N') + '.txt')
  Invoke-WebRequest -UseBasicParsing $url -OutFile $f
  return (Get-Content -Raw $f)
}

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

  # Create the PARENT only. Both install steps below end with
  # `Move-Item <extracted dir> <RuntimeDir|AppDir>`, and PowerShell's Move-Item
  # renames source -> destination only when the destination does NOT exist; if
  # it does exist, the source is moved INSIDE it, which would produce
  # runtime\node-v22.23.2-win-x64\ rather than runtime\. So the parent must
  # exist and the two leaf dirs must not — which is why each step removes its
  # own leaf first and nothing pre-creates them here.
  #
  # This line was missing entirely until 2026-09-19. On a machine with no
  # ~\.worldmonitor yet, the first Move-Item failed with
  # DirectoryNotFoundException ("Move-Item : 未能找到路径中的某个部分"). The
  # macOS installer had it right all along (`mkdir -p "$RUNTIME_DIR"` /
  # `"$APP_DIR"`); this PowerShell mirror never got the equivalent, and it had
  # never been run on real Windows.
  New-Item -ItemType Directory -Force -Path $WmDir | Out-Null

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
      $sums = Get-RemoteText "https://nodejs.org/dist/$NodeVersion/SHASUMS256.txt"
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
    $wantLine = Get-RemoteText "$base/$appZip.sha256"
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
  #
  # NOT `.\setup.ps1` directly. This installer reaches the machine through
  # `irm ... | iex`, so it is never a file and ExecutionPolicy never applies to
  # it. setup.ps1 IS a file, extracted from a downloaded zip, so it is subject
  # to both ExecutionPolicy (default `Restricted` on Windows client SKUs — it
  # would fail with "running scripts is disabled on this system") and
  # Mark-of-the-Web. Hence: unblock the extracted .ps1 files, then run setup in
  # a child process with -ExecutionPolicy Bypass.
  #
  # NOT NEEDED on the one machine actually tested, and kept anyway. The
  # 2026-09-19 Windows 11 install reported ExecutionPolicy
  # LocalMachine=RemoteSigned and `.\setup.ps1` ran fine unaided — PS 5.1's
  # Invoke-WebRequest does not attach Mark-of-the-Web to what it downloads, so
  # Unblock-File is a no-op there and RemoteSigned lets an unmarked local
  # script run. This stays for the machines that are NOT that one: `Restricted`
  # is the client-SKU default, and a bundle fetched by any other means (a
  # browser, curl, a file share) does carry MOTW. Harmless where it is
  # unnecessary; the difference between working and not where it is.
  Say "Running setup..."
  Get-ChildItem -Path $AppDir -Filter *.ps1 -Recurse | Unblock-File -ErrorAction SilentlyContinue
  Push-Location $AppDir
  try {
    $setupArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', '.\setup.ps1')
    if ($Config) { $setupArgs += @('-Config', $Config) }
    & powershell.exe @setupArgs
    if ($LASTEXITCODE -ne 0) { Die "setup.ps1 exited with code $LASTEXITCODE" }
  } finally { Pop-Location }

  Say "Installed."
  Info "Dashboard:  http://127.0.0.1:46123/"
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
