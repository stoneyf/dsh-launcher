# ============================================================
#  DSH 启动器 GitHub 一键发版
#  用法:  pwsh scripts\publish.ps1 -Notes "本版本说明"
#  可选:  -Repo stoneyf/dsh-launcher  -Token <PAT>  -Force（同名 release 已存在时覆盖）
#  流程:  读 server\core.mjs 的版本号
#        → 打包受管文件（server\ gui\ electron\ + 入口文件）为 dist\launcher-v{版本}.zip
#        → 生成 launcher-manifest.json（url 指向 release 资产）
#        → git 提交清单 + 打 tag
#        → 创建 GitHub Release 并上传 zip + manifest 两个资产
#  与 server\launcher-update.mjs 的 MANAGED_DIRS / MANAGED_FILES 保持一致。
# ============================================================
param(
  [string]$Notes = '',
  [string]$Repo = 'stoneyf/dsh-launcher',
  [string]$Token = '',
  [switch]$Force
)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# ---------- 1) 版本号 ----------
$core = Get-Content (Join-Path $root 'server\core.mjs') -Raw -Encoding UTF8
if ($core -notmatch "LAUNCHER_VERSION\s*=\s*'([^']+)'") { throw '无法从 server\core.mjs 解析 LAUNCHER_VERSION' }
$ver = $Matches[1]
$tag = "v$ver"
$zipName = "launcher-$tag.zip"
$zipPath = Join-Path $root "dist\$zipName"
New-Item -ItemType Directory -Force -Path (Join-Path $root 'dist') | Out-Null
Write-Host "[publish] 版本 $ver（tag $tag）"

# ---------- 2) 受管文件清单（与 launcher-update.mjs 同步） ----------
$managedDirs = @('server', 'gui', 'electron')
$managedFiles = @('launcher.bat', '启动器.bat', '启动器.vbs', 'dsh-launcher.exe', 'launcher.cs', 'README.md')
$items = @()
foreach ($d in $managedDirs) {
  $p = Join-Path $root $d
  if (-not (Test-Path $p)) { throw "缺少目录 $d" }
  $items += $p
}
foreach ($f in $managedFiles) {
  $p = Join-Path $root $f
  if (-not (Test-Path $p)) { throw "缺少文件 $f" }
  $items += $p
}

# ---------- 3) 打 zip ----------
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
Compress-Archive -Path $items -DestinationPath $zipPath
$zipSize = (Get-Item $zipPath).Length
Write-Host "[publish] 已打包 $zipName（$([math]::Round($zipSize / 1kb, 1)) KB）"

# ---------- 4) manifest（UTF8 无 BOM） ----------
$zipUrl = "https://github.com/$Repo/releases/download/$tag/$zipName"
$manifestBody = [ordered]@{ version = $ver; notes = $Notes; url = $zipUrl }
$manifestJson = ($manifestBody | ConvertTo-Json -Depth 4)
$manifestPath = Join-Path $root 'launcher-manifest.json'
[IO.File]::WriteAllText($manifestPath, $manifestJson, (New-Object Text.UTF8Encoding($false)))
Write-Host "[publish] manifest -> $zipUrl"

# ---------- 5) git 提交 + tag ----------
& git add launcher-manifest.json
& git diff --cached --quiet
if ($LASTEXITCODE -ne 0) {
  & git commit -m "Release $tag"
  if ($LASTEXITCODE -ne 0) { throw 'git commit 失败' }
}
& git tag -f $tag
if ($LASTEXITCODE -ne 0) { throw "git tag $tag 失败" }
& git push origin main
if ($LASTEXITCODE -ne 0) { Write-Host '[publish] 警告: git push main 失败（可稍后手动重推）' }

# ---------- 6) GitHub token ----------
if (-not $Token) {
  $credIn = "protocol=https`nhost=github.com`npath=$Repo`n"
  $credOut = $credIn | git credential fill
  $Token = $null
  foreach ($line in $credOut) { if ($line -like 'token=*') { $Token = ($line -replace '^token=', '').Trim() } }
  if (-not $Token) { foreach ($line in $credOut) { if ($line -like 'password=*') { $Token = ($line -replace '^password=', '').Trim() } } }
  if (-not $Token) { throw 'git credential fill 未返回 token（先手动 git push 一次以缓存凭据）' }
}
$api = "https://api.github.com/repos/$Repo"
$headers = @{ Authorization = "Bearer $Token"; 'User-Agent' = 'dsh-publish'; Accept = 'application/json' }

# ---------- 7) 创建 Release（-Force 时先删同名） ----------
if ($Force) {
  try {
    $exist = Invoke-RestMethod -Uri "$api/releases/tags/$tag" -Headers $headers
    Invoke-RestMethod -Method Delete -Uri "$api/releases/$($exist.id)" -Headers $headers | Out-Null
    Write-Host "[publish] 已删除旧 release $tag"
  } catch { /* 不存在则忽略 */ }
}
$relBody = [ordered]@{
  tag_name = $tag
  target_commitish = 'main'
  name = $tag
  body = $Notes
  draft = $false
  prerelease = $false
}
$rel = Invoke-RestMethod -Method Post -Uri "$api/releases" -Headers $headers -Body ($relBody | ConvertTo-Json -Depth 4) -ContentType 'application/json'
$relId = $rel.id
Write-Host "[publish] Release 已创建: $relId"

# ---------- 8) 上传资产（必须走 uploads.github.com；
#    api.github.com 的 assets POST 在国内网络下会 404，2026-09-09 实测） ----------
$assetHeaders = @{ Authorization = "Bearer $Token"; 'User-Agent' = 'dsh-publish'; 'Content-Type' = 'application/octet-stream' }
$upApi = "https://uploads.github.com/repos/$Repo"
Invoke-RestMethod -Method Post -Uri "$upApi/releases/$relId/assets?name=$zipName" -Headers $assetHeaders -InFile $zipPath | Out-Null
Write-Host "[publish] 已上传 $zipName"
Invoke-RestMethod -Method Post -Uri "$upApi/releases/$relId/assets?name=launcher-manifest.json" -Headers $assetHeaders -InFile $manifestPath | Out-Null
Write-Host "[publish] 已上传 launcher-manifest.json"

# ---------- 9) 推 tag ----------
& git push origin $tag
if ($LASTEXITCODE -ne 0) { throw 'git push tag 失败（网络抖动时可手动重推）' }

Write-Host ''
Write-Host "[publish] 完成：$tag" -ForegroundColor Green
Write-Host "  zip:      $zipUrl"
Write-Host "  manifest: https://raw.githubusercontent.com/$Repo/main/launcher-manifest.json"
