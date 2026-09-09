# DSH 启动器

本地图形化启动器：一键管理 DeepSeek Harness（dsh）+ 本地大模型（llama.cpp）+ 下载任务，Electron 桌面窗口（可回退纯 Node 浏览器模式）。

## 更新日志

### 3.3.1
- **exe 提示文案修正**：缺失必要组件时不再提示「请先运行 setup.bat」（该脚本已随 V2 退役），改为「请检查 DSH 启动器是否完整解压」。

### 3.3.0
- **目录结构去 -v3**：`server/ gui/ electron/` + 入口 `launcher.bat`、`启动器.bat/vbs`、`dsh-launcher.exe`、`launcher.cs`、`test/`；electron 运行时移至 `runtime\electron`（与 `runtime\node` 并列）；V2 组件退役（源码备份至 GitHub 仓库 `stoneyf/dsh-launcher-v2`）。
- **GitHub 更新源**：自更新默认走 GitHub Releases —— 维护页「检查更新」读取 `https://raw.githubusercontent.com/stoneyf/dsh-launcher/main/launcher-manifest.json`（稳定地址，永远指向最新 release 的 zip）。发版用 `scripts\publish.ps1`（打包 + manifest + commit + tag + release 一键完成）。网络不佳时可在设置里把更新源临时改为 ghproxy 前缀或本地文件。
- **令牌文件**：`logs\launcher.token`（每次启动重新生成）。

### 3.2.0
- **启动器重启续会话**：`POST /api/launcher/restart` → 退出并在 quit 事件里 relaunch；shutdown 时把 dsh/llm 运行态写入 `data/launcher-services.json`，新实例启动后自动拉起对应服务，浏览器 cookie 保证会话续接。
- **关闭窗口再打开也能自动恢复（修复）**：此前状态文件只在「主动重启」路径写入，普通关窗/重开（`window-closed`）不会恢复 dsh。现改为：任何退出原因下只要有服务在运行就写状态文件；恢复前 `waitPortFree` 等端口释放，避免「端口已被占用」冲突。Electron 后端的 console 输出同步转发到 `logs\electron.log`（GUI 模式下不再静默失败）。
- **自测扩充**：selftest 新增第 ⑨ 阶段「第二实例自动恢复」，共 32 项检查全部通过；另附 `test\copy-restart-test.mjs` 真实环境副本测试（独立端口 7611/3081：起 dsh → 重启 → 新实例自动恢复 dsh → 状态文件消费，8 项通过）。
- **模型广场介绍 + 硬件建议**：搜索结果带派生简介（参数规模 / MoE 激活 / 能力标签，HF 搜索接口本不带正文）；选中仓库后展示 README 简介 + license，并按本机内存 / NVIDIA 显存对每个 GGUF 量化文件评级（可上显存 / GPU+CPU / 内存宽裕 / 紧张 / 超出），给出推荐下载文件与一句话建议。
- **关于页目录按钮**：改用 PowerShell helper（`open-dir-helper.ps1`）枚举 `CabinetWClass` 窗口，命中已存在目录则前置显示、并关闭同目录的重复/隐藏窗口；Win11 per-window-process Explorer 下不再「按钮失效」。
- **启动器 exe**：新增 `dsh-launcher.exe`（C# 无控制台入口，`launcher.cs` 用 `csc` 编译），双击即用；无 Electron 时回退纯 Node 浏览器模式。

### 3.1.0
- **启动器自更新**：维护页「启动器版本」卡片支持检查更新 / 更新 / 回滚 / 重启生效；清单来自设置里的「更新源」（http(s) 地址或本地文件路径），更新前自动备份到 `launcher-backup-{版本}`（保留 3 份），回滚一键恢复。
- **主题**：深色 / 浅色 / 跟随系统（设置页即时生效，持久化到 `config`），控制台与日志框配色随主题切换。
- **模型广场增强**：进页面自动搜索、搜索结果分页「加载更多」、搜索历史 chips（≤8 条）、文件列表可按文件名筛选 + 按大小/名称排序、量化标签与「已安装」标记、仓库页/文件直链外链、下载条实时显示速度与剩余时间。
- **隐藏 cmd 窗口**：双击入口走 `启动器.vbs` / `dsh-launcher.exe`（无 cmd 窗口）；`launcher.bat` 为 ASCII 引擎，`启动器.bat` 为窗口版排障入口。
- **关于页修复**：四个目录按钮改用 `cmd /c start` 打开（解决 explorer 复用已有实例导致窗口不激活的「失效」问题）；新增「打开配置目录」、版本号与 Changelog 展示。

### 3.0.0
- 首个独立版本：启动器编排重启（202 + SSE 阶段推送）、陈旧状态自愈、孤儿端口查杀、GUI 实时重启进度条、版本管理（harness/llama/node 检查/更新/回滚）、模型广场、下载续传。

## 核心设计：agent 重启 dsh 不断会话

**核心问题：agent（harness 里的会话）重启 dsh 时，自己的命令进程会随 dsh 一起死，重启永远完不成。** 方案：重启由启动器编排，agent 只发一个 API 请求。

| 能力 | 说明 |
|---|---|
| `POST /api/services/dsh/restart` | 立即返回 **202**，后台完成：杀 dsh → 查杀 3080 上的孤儿占用者 → 等端口释放（20s）→ 由启动器 spawn 新 dsh → 解析新 token URL |
| `POST /api/services/llm/restart` | 同上（llm 用 30s 就绪等待） |
| `GET /api/services/events` | SSE 实时推送重启阶段：`stopping → killing-port-holder → waiting-port → starting → loading → ready`（或 `error` + 原因） |
| `POST /api/launcher/restart` | 启动器自身重启（自更新/回滚后生效）：写服务状态 → 退出 → relaunch → 新实例自动恢复 dsh/llm |
| 陈旧状态自愈 | start 前先检查内存状态与 pid 文件/进程存活，不一致自动清除（`stale-state-cleared`） |
| 端口查杀 | 重启前用 `netstat -ano` 找出占用目标端口的孤儿进程并整树杀掉（排除 dsh 自身 pid） |
| 严格端口 | 重启不走端口回退（不再悄悄落到 3081），端口占着就报错 |
| 并发保护 | 同一服务重启中重复提交 → **409** |

浏览器会话不断的原因：dsh 用**签名 cookie**（30 天有效，密钥在 `data/.credentials.yaml`），dsh 重启后密钥还在 → 页面短暂断连后自动重连，用户无感。

### agent 重启协议（给 harness 里的会话看）

agent 的 shell 环境变量里有 `DSH_HOME`（指向启动器的 `data\`），启动器根目录 = `DSH_HOME` 的父目录：

```powershell
$root = (Split-Path $env:DSH_HOME -Parent)
$token = (Get-Content (Join-Path $root 'logs\launcher.token')).Trim()
$port = 7610   # config\launcher.env 的 LAUNCHER_PORT
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$port/api/services/dsh/restart" -Headers @{Authorization="Bearer $token"}
# 可选：轮询 GET /api/status 直到 restarting.dsh 为 ready 或消失
```

要点：**不要自己 taskkill dsh，不要自己 spawn dsh** —— 一切交给启动器。

## 目录结构

```
D:\dsh-launcher\
  server\        后端（Node 原生 http，零依赖；含 open-dir-helper.ps1）
  gui\           前端 SPA
  electron\      Electron 壳（主进程即后端宿主）
  runtime\       运行时：node\ 与 electron\（gitignore，setup 安装）
  test\          selftest.mjs + mock-dsh.js + copy-restart-test.mjs
  scripts\       publish.ps1（GitHub 发版）
  dsh-launcher.exe  双击启动入口（C# 无控制台，推荐）
  启动器.vbs      双击启动（隐藏窗口，exe 的替代品）
  启动器.bat      窗口版排障入口（调用 launcher.bat）
  launcher.bat    ASCII 启动引擎：有 Electron 用 Electron，否则纯 Node + 浏览器
  launcher.cs     启动器 exe 源码（csc 编译，见下）
  launcher-manifest.json  GitHub 更新清单（publish.ps1 生成并提交）
  config\ data\ logs\ models\ harness\ llm\ plugins\  运行时数据（gitignore）
  launcher-backup-{版本}\  自更新/回滚备份（保留 3 份）
```

编译启动器 exe（无需 VS）：

```powershell
C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /target:winexe /optimize /codepage:65001 /out:dsh-launcher.exe launcher.cs
```

## GitHub 更新

- 仓库：`stoneyf/dsh-launcher`（私有）；V2 源码备份：`stoneyf/dsh-launcher-v2`（私有）。
- 发版：`scripts\publish.ps1` → 打包受管目录（`server/ gui/ electron/` + 入口文件）为 `launcher-v{版本}.zip` → 生成 `launcher-manifest.json`（version/notes/url 指向 release 资产）→ 提交清单到 main → 打 tag `v{版本}` → 创建 GitHub Release（附件 zip + manifest）。
- 本机更新源（`config\launcher.env`）：
  ```
  LAUNCHER_UPDATE_URL=https://raw.githubusercontent.com/stoneyf/dsh-launcher/main/launcher-manifest.json
  ```
  main 分支的 manifest 永远描述最新 release，维护页「检查更新」即可发现新版本；安装后点「重启」生效（更新前自动备份，可回滚）。
- 网络不佳：把 `LAUNCHER_UPDATE_URL` 临时改为 `https://ghproxy.com/https://github.com/...` 前缀或本地 zip/manifest 文件路径。

## 自测

```powershell
D:\dsh-launcher\runtime\node\node.exe test\selftest.mjs
```

用 fixture 隔离（mock dsh 监听 3999，后端 7999），覆盖 9 个阶段 32 项检查：fixture → 后端启动 → 状态/token → dsh 启动 → dsh 重启全流程（202/409/SSE 阶段/新 pid/新 URL）→ 陈旧状态自愈 → 孤儿端口查杀 → llm 错误路径 → 第二实例自动恢复。`test\selftest.steps.log` 有无缓冲步骤日志。

## 已知限制

- `portHolderPids` 用 `netstat` 解析（无额外依赖，够用；极端并发下可能漏判，20s 等待兜底）。
- llm 重启的错误详情保留 120s 供 GUI 展示；dsh 的 ready 状态保留 15s。
- 同一台机器不能同时跑两个启动器实例监听同一 LAUNCHER_PORT（EADDRINUSE 会随机端口回退并写日志）。
