# HomeKTV 本地开发一键启动脚本 (Windows PowerShell)
# 用法: powershell -ExecutionPolicy Bypass -File scripts/dev-start.ps1
# 行为: kill 占用端口的进程 -> 确保 PostgreSQL(Docker) -> migrate -> 启动 api/admin/controller/tv-web
# 默认开启在线补歌 (ONLINE_SUPPLEMENT_ENABLED=true)。传 -NoSupplement 关闭。

param([switch]$NoSupplement)

$ErrorActionPreference = "SilentlyContinue"
$ROOT = (Resolve-Path "$PSScriptRoot/..").Path
$PORTS = 4000, 5173, 5174, 5176

function Stop-PortOwners {
  foreach ($port in $PORTS) {
    $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    foreach ($c in $conns) {
      $procId = $c.OwningProcess
      if ($procId -and $procId -ne $PID) {
        $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
        if ($proc) {
          Write-Host "  port $port <- PID $procId ($($proc.ProcessName)) -> kill"
          Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
        }
      }
    }
  }
}

Write-Host "==> [1/5] Killing processes on dev ports ($($PORTS -join ','))..."
Stop-PortOwners
Push-Location $ROOT
node scripts/dev-local.mjs stop | Out-Null
Pop-Location
Start-Sleep -Seconds 2

Write-Host "==> [2/5] Ensuring PostgreSQL container (home-ktv-pg)..."
$exists = (docker ps -a --filter "name=home-ktv-pg" --format "{{.Names}}").Trim()
if (-not $exists) {
  docker run -d --name home-ktv-pg `
    -e POSTGRES_USER=ktv -e POSTGRES_PASSWORD=ktv -e POSTGRES_DB=home_ktv `
    -p 5432:5432 postgres:18 | Out-Null
} else {
  docker start home-ktv-pg | Out-Null
}
$pgReady = $false
for ($i = 0; $i -lt 30; $i++) {
  docker exec home-ktv-pg pg_isready -U ktv 2>&1 | Out-Null
  if ($LASTEXITCODE -eq 0) { $pgReady = $true; break }
  Start-Sleep -Seconds 1
}
if (-not $pgReady) { Write-Host "  WARNING: PostgreSQL not ready after 30s" } else { Write-Host "  PG ready" }

Write-Host "==> [3/5] Setting env..."
$env:DATABASE_URL = "postgresql://ktv:ktv@127.0.0.1:5432/home_ktv"
$env:ONLINE_SUPPLEMENT_ENABLED = if ($NoSupplement) { "false" } else { "true" }
# API 进程内 YtDlpProvider 用 execFile(shell:false)跑 yt-dlp,Windows 的 .bat shim
# 无法被直接 spawn(ENOENT/EINVAL),必须指向真实二进制:python.exe -m yt_dlp。
$env:PATH = [Environment]::GetEnvironmentVariable("PATH","Machine") + ";" + [Environment]::GetEnvironmentVariable("PATH","User")
$py = (Get-ChildItem "$env:USERPROFILE\.pyenv\pyenv-win\versions\*\python.exe" -ErrorAction SilentlyContinue | Select-Object -First 1).FullName
if ($py) {
  if (-not $env:YT_DLP_BIN) { $env:YT_DLP_BIN = $py; $env:YT_DLP_ARGS = "-m yt_dlp" }
  if (-not $env:DEMUCS_BIN) { $env:DEMUCS_BIN = $py; $env:DEMUCS_ARGS = "-m demucs" }
}
# mix 阶段 ffmpeg:worker 可能拿到裁剪过的 PATH,显式解析绝对路径最稳
$ffCmd = Get-Command ffmpeg -ErrorAction SilentlyContinue | Select-Object -First 1
if ($ffCmd -and -not $env:FFMPEG_BIN) { $env:FFMPEG_BIN = $ffCmd.Source }
if (-not $env:ONLINE_SUPPLEMENT_WORKFLOW) { $env:ONLINE_SUPPLEMENT_WORKFLOW = "youtube-enhanced" }
Write-Host "  DATABASE_URL=$($env:DATABASE_URL)"
Write-Host "  ONLINE_SUPPLEMENT_ENABLED=$($env:ONLINE_SUPPLEMENT_ENABLED) WORKFLOW=$($env:ONLINE_SUPPLEMENT_WORKFLOW)"
Write-Host "  YT_DLP_BIN=$($env:YT_DLP_BIN) ARGS=$($env:YT_DLP_ARGS)"
Write-Host "  FFMPEG_BIN=$($env:FFMPEG_BIN)"

Write-Host "==> [4/5] Running migrations (idempotent)..."
Push-Location $ROOT
$mOut = corepack pnpm db:migrate 2>&1
$lastApplied = ($mOut | Select-String "Applying").Count
$already = ($mOut | Select-String "already applied|Already").Count
if ($mOut -match "Error|error:") { Write-Host "  migration output:"; $mOut | Select-Object -Last 5 }
else { Write-Host "  migrations OK (applied this run: $lastApplied)" }
Pop-Location

Write-Host "==> [5/5] Starting services..."
Push-Location $ROOT
node scripts/dev-local.mjs start
Pop-Location
Start-Sleep -Seconds 8

if (-not $NoSupplement) {
  Write-Host "==> Starting supplement worker (fresh code, non-destructive)..."
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match "supplement-worker" } |
    ForEach-Object { Write-Host "  kill old worker pid $($_.ProcessId)"; Stop-Process -Id $_.ProcessId -Force }
  Start-Sleep -Seconds 1
  $env:SUPPLEMENT_IMPORT_ROOT = "$ROOT\home-ktv-media"
  # 有 NVIDIA GPU 时默认用 cuda 跑 demucs(RTX 3070 实测约 12x 实时;CPU 需数分钟/首)
  if (-not $env:DEMUCS_DEVICE) { $env:DEMUCS_DEVICE = if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) { "cuda" } else { "cpu" } }
  Push-Location $ROOT
  Start-Process -FilePath "corepack.cmd" -ArgumentList "pnpm","-F","@home-ktv/api","supplement:worker" `
    -RedirectStandardOutput "$ROOT\logs\dev\supplement-worker.log" `
    -RedirectStandardError "$ROOT\logs\dev\supplement-worker.err.log" `
    -NoNewWindow -PassThru | ForEach-Object { Write-Host "  worker pid $($_.Id)" }
  Pop-Location
  Start-Sleep -Seconds 3
  Get-Content "$ROOT\logs\dev\supplement-worker.log" -Tail 2 -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "==> Status:"
Push-Location $ROOT
node scripts/dev-local.mjs status
Pop-Location
