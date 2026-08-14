# 重启 supplement worker(带 YouTube cookie 支持,绕过版权 MV 的 403)
# 用法:
#   $env:YOUTUBE_COOKIES_FROM_BROWSER = "chrome"   # 或 edge / firefox / brave(用你登录了 YouTube 的浏览器)
#   .\scripts\dev-restart-worker.ps1
# 说明:
#   - 先 kill 旧 worker,重置所有 failed 任务为 discovered(让 worker 重新认领)
#   - 继承当前 shell 的 YOUTUBE_COOKIES_FROM_BROWSER / YOUTUBE_COOKIE / KTV_LLM_* 环境变量
#   - worker 在后台跑;用最后一行的 psql 命令观察任务进度

$ErrorActionPreference = "SilentlyContinue"
$ROOT = (Resolve-Path "$PSScriptRoot/..").Path

Write-Host "==> [1/4] kill old worker..."
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match "supplement-worker" } |
  ForEach-Object { Write-Host "  kill pid $($_.ProcessId)"; Stop-Process -Id $_.ProcessId -Force }
Start-Sleep -Seconds 2

Write-Host "==> [2/4] reset failed tasks -> discovered..."
docker exec home-ktv-pg psql -U ktv -d home_ktv -c "UPDATE online_supplement_tasks SET status='discovered', stage='download', stage_status='pending', stage_progress_percent=0, stage_message='', failure_reason=NULL, failure_stage=NULL, worker_id=NULL, worker_lease_until=NULL, llm_renamed_title=NULL, final_file_path=NULL, lyric_file=NULL, ready_song_id=NULL, download_at=NULL, ready_at=NULL, failed_at=NULL, updated_at=now() WHERE status='failed';" 2>$null | Out-Null
# 只清 _downloads(可重新下载的中间产物)。_online 是曲库正式文件,绝不能清。
# DB 对账用 Node 脚本(UTF-8 安全):文件丢失的行标 missing_at,文件恢复的行自愈。
Remove-Item "$ROOT\home-ktv-media\_downloads\*" -Force -ErrorAction SilentlyContinue
$env:DATABASE_URL = "postgresql://ktv:ktv@127.0.0.1:5432/home_ktv"
node "$ROOT\apps\api\scripts\reconcile-online-library.mjs"

Write-Host "==> [3/4] env..."
$env:DATABASE_URL = "postgresql://ktv:ktv@127.0.0.1:5432/home_ktv"
$env:ONLINE_SUPPLEMENT_ENABLED = "true"
$env:SUPPLEMENT_IMPORT_ROOT = "$ROOT\home-ktv-media"
$env:PATH = [Environment]::GetEnvironmentVariable("PATH","Machine") + ";" + [Environment]::GetEnvironmentVariable("PATH","User")
# 自动用 pyenv-win 的 python.exe 作为 yt-dlp/demucs 真二进制(execFile shell:false 需要),
# 避免 .bat shim 和 cmd 对参数的破坏。
$py = (Get-ChildItem "$env:USERPROFILE\.pyenv\pyenv-win\versions\*\python.exe" -ErrorAction SilentlyContinue | Select-Object -First 1).FullName
if ($py) {
  if (-not $env:YT_DLP_BIN) { $env:YT_DLP_BIN = $py; $env:YT_DLP_ARGS = "-m yt_dlp" }
  if (-not $env:DEMUCS_BIN) { $env:DEMUCS_BIN = $py; $env:DEMUCS_ARGS = "-m demucs" }
}
if (-not $env:DEMUCS_DEVICE) { $env:DEMUCS_DEVICE = if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) { "cuda" } else { "cpu" } }
Write-Host "  YT_DLP_BIN=$($env:YT_DLP_BIN)"
Write-Host "  DEMUCS_BIN=$($env:DEMUCS_BIN)  DEVICE=$($env:DEMUCS_DEVICE)"
Write-Host "  YOUTUBE_COOKIES_FROM_BROWSER=$($env:YOUTUBE_COOKIES_FROM_BROWSER)"
Write-Host "  KTV_LLM_API_KEY set?=$([bool]$env:KTV_LLM_API_KEY)"
Write-Host "  ffmpeg: $((Get-Command ffmpeg -ErrorAction SilentlyContinue).Source)"

Write-Host "==> [4/4] start worker..."
Push-Location $ROOT
Start-Process -FilePath "corepack.cmd" -ArgumentList "pnpm","-F","@home-ktv/api","supplement:worker" `
  -RedirectStandardOutput "$ROOT\logs\dev\supplement-worker.log" `
  -RedirectStandardError "$ROOT\logs\dev\supplement-worker.err.log" `
  -NoNewWindow -PassThru | ForEach-Object { Write-Host "  worker pid $($_.Id)" }
Pop-Location
Start-Sleep -Seconds 3
Write-Host "--- worker log ---"
Get-Content "$ROOT\logs\dev\supplement-worker.log" -Tail 3 -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "观察任务进度(另开一个终端):"
Write-Host "  docker exec home-ktv-pg psql -U ktv -d home_ktv -c ""SELECT left(title,22) title,status,stage,stage_progress_percent pct FROM online_supplement_tasks ORDER BY updated_at DESC LIMIT 5;"""
