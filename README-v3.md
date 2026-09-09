# DSH 启动器 V3

## 更新日志

### 3.2.0
- **启动器重启续会话**：`POST /api/launcher/restart` → 退出并在 quit 事件里 relaunch；shutdown 时把 dsh/llm 运行态写入 `data/launcher-services.json`，新实例启动后自动拉起对应服务，浏览器 cookie 保证会话续接。
- **关闭窗口再打开也能自动恢复（修复）**：此前状态文件只在「主动重启」路径写入，普通关窗/重开（`window-closed`）不会恢复 dsh。现改为：任何退出原因下只要有服务在运行就写状态文件；恢复前 `waitPortFree` 等端口释放，避免「端口已被占用」冲突。Electron 后端的 console 输出同步转发到 `logs\electron.log`（GUI 模式下不再静默失败）。
- **自测扩充**：selftest 新增第 ⑨ 阶段「第二实例自动恢复」，共 32 项检查全部通过；另附 `test\copy-restart-test.mjs` 真实环境副本测试（`D:\dsh-launcher-copy`，独立端口 7611/3081：起 dsh → 重启 → 新实例自动恢复 dsh → 状态文件消费，8 项通过）。
- **模型广场介绍 + 硬件建议**：搜索结果带派生简介（参数规模 / MoE 激活 / 能力标签，HF 搜索接口本不带正文）；选中仓库后展示 README 简介 + license，并按本机内存 / NVIDIA 显存对每个 GGUF 量化文件评级（可上显存 / GPU+CPU / 内存宽裕 / 紧张 / 超出），给出推荐下载文件与一句话建议。
- **关于页目录按钮**：改用 PowerShell helper（`open-dir-helper.ps1`）枚举 `CabinetWClass` 窗口，命中已存在目录则前置显示、并关闭同目录的重复/隐藏窗口；Win11 per-window-process Explorer 下不再「按钮失效」。
- **启动器 exe**：新增 `启动器-v3.exe`（C# 无控制台入口，`launcher-v3.cs` 用 `csc` 编译），双击即用；无 Electron 时回退纯 Node 浏览器模式。
- **V2 备份**：V2 全部组件（`server/ gui/ electron/ launcher/ scripts/` + 入口 bat + `dsh-launcher.exe`）备份到 `launcher-backup-v2\`（约 380MB）。
- **树清理**：V3 开发树只保留源码与自测，移除临时探测脚本与旧 README 副本。

### 3.1.0
- **启动器自更新**：维护页「启动器版本」卡片支持检查更新 / 更新 / 回滚 / 重启生效；清单来自设置里的「更新源」（http(s) 地址或本地文件路径，默认 `launcher-manifest.json`），更新前自动备份到 `launcher-backup-{版本}`（保留 3 份），回滚一键恢复。
- **主题**：深色 / 浅色 / 跟随系统（设置页即时生效，持久化到 `config`），控制台与日志框配色随主题切换。
- **模型广场增强**：进页面自动搜索、搜索结果分页「加载更多」、搜索历史 chips（≤8 条）、文件列表可按文件名筛选 + 按大小/名称排序、量化标签与「已安装」标记、仓库页/文件直链外链、下载条实时显示速度与剩余时间。
- **隐藏 cmd 窗口**：新增 `启动器-v3.vbs`（双击即隐藏窗口启动）；`launcher-v3.bat` 为 ASCII 引擎（Electron 分支不再留黑窗），`启动器-v3.bat` 变为窗口版排障入口。
- **关于页修复**：四个目录按钮改用 `cmd /c start` 打开（解决 explorer 复用已有实例导致窗口不激活的「失效」问题）；新增「打开配置目录」、版本号与 Changelog 展示。

### 3.0.0
- 首个 V3 版本：启动器编排重启（202 + SSE 阶段推送）、陈旧状态自愈、孤儿端口查杀、GUI 实时重启进度条、版本管理（harness/llama/node 检查/更新/回滚）、模型广场、下载续传。

---

V2 的下一代版本。**不修改 V2 任何文件**（`server/`、`gui/`、`electron/`、`launcher/` 原样保留作回滚），V3 全部在新目录里。

## V3 解决了什么

**核心问题：agent（harness 里的会话）重启 dsh 时，自己的命令进程会随 dsh 一起死，重启永远完不成。**

根因链（V2）：

1. dsh 是启动器的子进程。agent 在 dsh 进程树里执行 `taskkill /T` → 杀掉了自己的命令宿主，`start` 还没执行。
2. agent 自己 spawn 新 dsh → 启动器不知道 → pid 文件陈旧 → 状态错乱。
3. 启动器内存里的 `state.dsh.running` 陈旧 → 明明 pid 已死还报「Harness 已在运行」。
4. 孤儿进程占着 3080 → 新 dsh 落到 3081 → 浏览器 URL 混乱。

**V3 方案：重启由启动器编排，agent 只发一个 API 请求。**

| 能力 | 说明 |
|---|---|
| `POST /api/services/dsh/restart` | 立即返回 **202**，后台完成：杀 dsh → 查杀 3080 上的孤儿占用者 → 等端口释放（20s）→ 由启动器 spawn 新 dsh → 解析新 token URL |
| `POST /api/services/llm/restart` | 同上（llm 用 30s 就绪等待） |
| `GET /api/services/events` | SSE 实时推送重启阶段：`stopping → killing-port-holder → waiting-port → starting → loading → ready`（或 `error` + 原因） |
| 陈旧状态自愈 | start 前先检查内存状态与 pid 文件/进程存活，不一致自动清除（`stale-state-cleared`） |
| 端口查杀 | 重启前用 `netstat -ano` 找出占用目标端口的孤儿进程并整树杀掉（排除 dsh 自身 pid） |
| 严格端口 | 重启不走端口回退（不再悄悄落到 3081），端口占着就报错 |
| 并发保护 | 同一服务重启中重复提交 → **409** |
| GUI 重启按钮 | dsh / llm 卡片各一个「重启」按钮，SSE 驱动的实时阶段进度条（蓝底脉冲 → ✓/✗），重启中禁用启动/停止/重启 |
| 版本展示 | status 增加 `versions: { launcher: '3.1.0', dsh, gui, ... }` |

### 浏览器会话为什么不会断

- 浏览器访问 dsh 时拿的是**签名 cookie**（30 天有效），密钥在 `data/.credentials.yaml`，dsh 重启后密钥还在 → cookie 继续有效。
- 所以 agent 重启 dsh 时：浏览器页面短暂断连（1~3 秒），dsh 起来后自动重连，**用户无感**（GUI 上会看到重启进度）。
- 只有全新浏览器/无痕窗口才需要新的 token URL（在 `logs/dsh.url`、GUI 状态页、启动器日志里）。

## agent 重启协议（给 harness 里的会话看）

agent 的 shell 环境变量里有 `DSH_HOME`（指向 `D:\dsh-launcher\data`），启动器根目录 = `DSH_HOME` 的父目录：

```powershell
$root = (Split-Path $env:DSH_HOME -Parent)          # D:\dsh-launcher
# 1) 取启动器 token（V3 优先，回退 V2 文件）
$tf = Join-Path $root 'logs\launcher-v3.token'
if (-not (Test-Path $tf)) { $tf = Join-Path $root 'logs\launcher.token' }
$token = (Get-Content $tf).Trim()
# 2) 端口（config/launcher.env 的 LAUNCHER_PORT，默认 7610）
$port = 7610
# 3) 发起重启（立即 202 返回；agent 自己的进程树不在 dsh 下面时不受影响，
#    但 agent 的 dsh 会话会短暂断开——cookie 保证重连）
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$port/api/services/dsh/restart" -Headers @{Authorization="Bearer $token"}
# 4) 可选：轮询 GET /api/status 直到 restarting.dsh 为 ready 或消失
```

要点：**不要自己 taskkill dsh，不要自己 spawn dsh** —— 一切交给启动器。

## 目录结构

```
D:\dsh-launcher\
  server-v3\     后端（Node 原生 http，零依赖；含 open-dir-helper.ps1）
  gui-v3\        前端 SPA
  electron-v3\   Electron 壳（复用 electron\node_modules 的 electron 运行时）
  启动器-v3.exe  双击启动入口（C# 无控制台，推荐）
  启动器-v3.bat  窗口版排障入口（调用 launcher-v3.bat）
  launcher-v3.bat  ASCII 启动引擎：有 Electron 用 Electron（隐藏窗口），否则纯 Node + 浏览器
  launcher-v3.cs   启动器 exe 源码（csc 编译，见下）
  启动器-v3.vbs    双击启动：隐藏 cmd 窗口（exe 的替代品）
  test-v3\       selftest.mjs + mock-dsh.js（fixture 自测时自动创建）
  launcher-backup-v2\  V2 全部组件备份（server/gui/electron/launcher/scripts + 入口）
  server\ gui\ electron\  ← V2 原样保留
```

编译启动器 exe（V2 同款方式，无需 VS）：

```powershell
C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /target:winexe /optimize /codepage:65001 /out:dsh-launcher-v3.exe launcher-v3.cs
```

运行时共享：`config/`、`data/`、`logs/`、`runtime/`、`harness/`、`models/`。
V3 自己的 token 文件：`logs/launcher-v3.token`（与 V2 的 `launcher.token` 分离）。

## 与 V2 共存

- 各自的 Electron 单实例锁（`dsh-launcher-v3` vs `dsh-launcher-electron`），可同时开着，**但建议同一时间只用一个**：两者共享 config/pid 文件/dsh.url，同时操作会互相干扰。
- 回滚：关掉 V3，双击原来的 `启动器.bat` / `launcher\Launcher.exe` 即可。

## 自测

```powershell
D:\dsh-launcher\runtime\node\node.exe test-v3\selftest.mjs
```

用 fixture 隔离（mock dsh 监听 3999，后端 7999），覆盖 9 个阶段：fixture → 后端启动 → 状态/token → dsh 启动 → **dsh 重启全流程（202/409/SSE 阶段/新 pid/新 URL）** → 陈旧状态自愈 → 孤儿端口查杀 → llm 错误路径 → 收尾。`test-v3/selftest.steps.log` 有无缓冲步骤日志。

## 已知限制

- `portHolderPids` 用 `netstat` 解析（无额外依赖，够用；极端并发下可能漏判，20s 等待兜底）。
- llm 重启的错误详情保留 120s 供 GUI 展示；dsh 的 ready 状态保留 15s。
- V3 后端和 V2 后端不能同时监听同一 LAUNCHER_PORT（默认都是 7610，EADDRINUSE 会随机端口回退并写日志）。
