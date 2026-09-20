/**
 * DSH 本地启动器 — Electron 主进程（即启动器后端宿主）。
 * 窗口关闭 → 停止全部子进程 → 退出（不常驻后台）。
 * 使用自带 electron 运行时：
 *   runtime\electron\dist\electron.exe electron
 */
import { app, BrowserWindow, shell, dialog, Tray, Menu, nativeImage } from 'electron'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { readConfig, ensureDirs, DIRS } from '../server/core.mjs'

const here = dirname(fileURLToPath(import.meta.url))

function elog(...args) {
  const line = `[${new Date().toISOString()}] ${args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`
  try {
    mkdirSync(DIRS.logs, { recursive: true })
    appendFileSync(join(DIRS.logs, 'electron.log'), line + '\n', 'utf8')
  } catch { /* 忽略 */ }
  try { process.stdout.write(line + '\n') } catch { /* stdout 断管（GUI 应用常态） */ }
}
process.stdout.on('error', () => {})
process.stderr.on('error', () => {})
process.on('uncaughtException', error => elog('uncaughtException:', error?.stack ?? error))
process.on('unhandledRejection', error => elog('unhandledRejection:', error?.stack ?? error))

// 后端（server）的 console 输出在 GUI 模式会丢失：转发到 electron.log，
// 便于排查「自动恢复 dsh 失败」这类静默错误。
for (const level of ['log', 'warn', 'error']) {
  const original = console[level].bind(console)
  console[level] = (...args) => {
    original(...args)
    try {
      const text = args.map(a => (typeof a === 'string' ? a : a instanceof Error ? (a.stack ?? a.message) : JSON.stringify(a))).join(' ')
      elog(level === 'log' ? text : `[${level.toUpperCase()}] ${text}`)
    } catch { /* 忽略 */ }
  }
}

const { startServer, shutdown } = await import(pathToFileURL(join(here, '..', 'server', 'main.mjs')).href)

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  // 同用户下已有实例：把本次启动请求转交给它（会弹出已有窗口），本进程静默退出。
  // 用户侧表现为「双击图标后窗口出现」；若已有实例在托盘里，它会 showWindow。
  elog('已有实例在运行，退出（请求已转交给已有实例）')
  app.quit()
} else {
  let mainWindow = null
  let tray = null
  let quitting = false
  // 附着模式（免登录开机）：本实例未启动自己的后端，界面指向已在运行的开机实例
  let attached = false
  // --silent（开机自启）：后台静默，不弹窗口，只进托盘
  const silent = process.argv.includes('--silent')
  const appIcon = join(here, '..', 'gui', 'icon.png')

  function showWindow() {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  }

  function createTray() {
    try {
      const icon = nativeImage.createFromPath(appIcon)
      tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)
      tray.setToolTip('DSH 启动器')
      tray.setContextMenu(Menu.buildFromTemplate([
        { label: '打开启动器', click: showWindow },
        { type: 'separator' },
        { label: '退出', click: () => { void quitAndShutdown('tray-quit') } },
      ]))
      tray.on('click', showWindow)
      elog('托盘已创建')
    } catch (error) {
      elog('托盘创建失败：', error?.message ?? error)
    }
  }

  /**
   * 免登录开机：探测「配置端口上是否已有一个启动器后端在运行」（开机 SYSTEM 实例先占）。
   * 命中且令牌匹配 → 返回可附着的 GUI 地址（本实例不启动自己的后端，避免端口冲突与重复拉起服务）；
   * 否则返回 null（本实例照常启动自己的后端）。
   *
   * 4.1.8：探测加重试。开机时 SYSTEM 实例刚起后端，令牌文件可能还没落地，
   * 一次探测容易误判为「没有已运行后端」，进而落到 v3.3.2 的「换随机端口」老路径，
   * 最终留下占着 7610 却不响应的僵尸实例（见 2026-09-20 事故）。
   */
  async function probeExistingBackend(port, attempts = 3, gapMs = 1000) {
    if (!port) return null
    const base = `http://127.0.0.1:${port}`
    for (let i = 1; i <= attempts; i++) {
      try {
        const ping = await fetch(`${base}/api/ping`, { signal: AbortSignal.timeout(1500) })
        if (ping.status !== 200) throw new Error(`ping ${ping.status}`)
        const token = readFileSync(join(DIRS.logs, 'launcher.token'), 'ascii').trim()
        if (!token) throw new Error('令牌文件为空')
        const st = await fetch(`${base}/api/status?token=${token}`, { signal: AbortSignal.timeout(1500) })
        if (st.status !== 200) throw new Error(`status ${st.status}`)
        return `${base}/?token=${token}`
      } catch (error) {
        if (i < attempts) {
          elog(`附着探测第 ${i} 次未命中（${error?.message ?? error}），${gapMs}ms 后重试`)
          await new Promise(r => setTimeout(r, gapMs))
        } else {
          elog(`附着探测 ${attempts} 次均未命中，按「无已运行后端」处理`)
        }
      }
    }
    return null
  }

  /**
   * 4.1.8：判断「配置端口上的监听者是不是自己人」。
   * v3.3.2 的「端口被占 → 换随机端口 + 已有实例退出」是为「一台机器跑两套独立 harness」
   * （如 D:\dsh-launcher 与 D:\deepseek-harness）设计的，必须保留；
   * 但同目录的自家兄弟实例（SYSTEM 开机实例 vs 登录实例）撞端口时不该走这条路——
   * 那正是僵尸实例的成因。这里用「可执行文件路径」区分自家/别家：
   *   同一份安装（路径相同）→ 自家；不同安装（路径不同）→ 别家，仍按老逻辑换端口。
   */
  function isOwnInstallListener(port) {
    try {
      const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true })
      const pids = new Set()
      for (const line of out.split(/\r?\n/)) {
        const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/)
        if (m && Number(m[1]) === Number(port)) pids.add(m[2])
      }
      if (!pids.size) return false
      const selfExe = process.execPath.toLowerCase()
      const root = join(here, '..').toLowerCase()
      for (const pid of pids) {
        try {
          const q = execFileSync('wmic', ['process', 'where', `ProcessId=${pid}`, 'get', 'ExecutablePath', '/value'], { encoding: 'utf8', windowsHide: true })
          const path = (q.match(/ExecutablePath=(.+)/)?.[1] ?? '').trim().toLowerCase()
          if (path && (path === selfExe || path.startsWith(root))) return true
        } catch { /* 单个 pid 查不到就跳过 */ }
      }
      return false
    } catch (error) {
      elog('判断端口占用者归属失败（按别家处理）：', error?.message ?? error)
      return false
    }
  }

  async function quitAndShutdown(reason) {
    if (quitting) return
    quitting = true
    if (attached) {
      // 附着模式：后端属于开机实例，只关闭本窗口进程，不停共享服务
      elog(`退出（附着模式，仅关闭本窗口）：${reason}`)
      // 明确告知：附着模式退出只关这一个托盘图标，开机实例的服务仍在跑。
      // 否则用户会以为「退了但服务还在」是没退干净（2026-09-20 用户反馈托盘退出异常）。
      try {
        await dialog.showMessageBox({
          type: 'info',
          title: 'DSH 启动器',
          message: '已退出本窗口。',
          detail: '本实例是登录后附着的窗口，后台服务由开机实例托管，仍在运行。\n如需彻底停止服务，请在开机实例（后台静默运行的那个）里退出。',
          buttons: ['知道了'],
        })
      } catch { /* 弹窗失败不阻塞退出 */ }
      app.quit()
      return
    }
    elog(`退出流程：${reason}`)
    // 兜底：shutdown 内部若卡住（子进程不响应 taskkill、端口等待超时等），
    // 8 秒后强制退出，避免托盘「退出」看起来没反应（2026-09-20 用户反馈）。
    const forceTimer = setTimeout(() => {
      elog('退出超时（8s），强制退出进程')
      app.exit(0)
    }, 8000)
    forceTimer.unref?.()
    try {
      await shutdown(reason)
    } catch (error) {
      elog('shutdown 异常：', error?.stack ?? error)
    }
    clearTimeout(forceTimer)
    app.quit()
  }

  app.on('second-instance', showWindow)

  app.whenReady().then(async () => {
    try {
      app.setAppUserModelId('com.dsh.launcher')
      ensureDirs()
      const cfg = readConfig()
      const port = Number(cfg.LAUNCHER_PORT) || 0
      let guiUrl = null
      // 免登录开机：若开机（SYSTEM）实例已持有后端，直接附着其界面，不启动自己的后端
      const attachUrl = await probeExistingBackend(port)
      if (attachUrl) {
        attached = true
        guiUrl = attachUrl
        elog(`检测到已运行的后端，附着模式（不启动本机后端）：${attachUrl}`)
      } else {
        const { port: actualPort, token } = await startServer({
          port,
          // 「重启生效」（启动器自更新/回滚后）：退出本进程并重开。
          // 在 quit 事件（进程退出前一刻）里 relaunch，确保单实例锁与端口已释放，
          // 新进程启动时（~1.5s 后请求锁）旧进程必已退出，避免新进程因锁未释放而自杀。
          onRelaunch: () => {
            elog('收到重启请求：退出并在 quit 事件里 relaunch')
            app.once('quit', () => {
              try { app.relaunch() } catch (e) { elog('relaunch 失败:', e?.message) }
            })
            app.quit()
          },
        })
        elog(`后端已启动: http://127.0.0.1:${actualPort}/?token=${token}`)
        guiUrl = `http://127.0.0.1:${actualPort}/?token=${token}`
        if (port && actualPort !== port) {
          // 4.1.8：撞端口的若是自家兄弟实例（同目录安装），不能换随机端口自立门户——
          // 那会留下「占着 7610 却不响应」的僵尸实例。此时提示并退出，让用户处理占用者。
          if (isOwnInstallListener(port)) {
            elog(`端口 ${port} 被同目录的自家实例占用，本实例退出（避免僵尸实例）`)
            await dialog.showMessageBox(null, {
              type: 'warning',
              title: 'DSH 启动器',
              message: `端口 ${port} 已被本机的另一个 DSH 启动器实例占用。`,
              detail: '这通常是开机（免登录）实例与登录实例之间的冲突。\n请在托盘中退出已有实例后重试，或重启启动器。',
            })
            await shutdown('port-conflict-own-install')
            app.quit()
            return
          }
          // 别家安装（如另一套独立 harness）：保留 v3.3.2 的换端口行为
          await dialog.showMessageBox(null, {
            type: 'warning',
            title: 'DSH 启动器',
            message: `端口 ${port} 被占用，已改用随机端口 ${actualPort}。`,
            detail: '可能有另一个启动器实例正在运行。',
          })
        }
      }

      const lightTheme = cfg.THEME === 'light'
      mainWindow = new BrowserWindow({
        width: 1280,
        height: 860,
        minWidth: 1024,
        minHeight: 640,
        backgroundColor: lightTheme ? '#f5f6f8' : '#14161a',
        autoHideMenuBar: true,
        title: 'DSH 启动器',
        icon: appIcon,
        show: false,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      })

      // 外部链接（如打开 Harness）一律交给系统默认浏览器
      mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:/i.test(url)) shell.openExternal(url)
        return { action: 'deny' }
      })

      // 关窗 → 收进托盘（服务继续后台运行）；只有明确「退出」才真正关
      mainWindow.on('close', event => {
        if (quitting) return
        event.preventDefault()
        mainWindow.hide()
        elog('窗口收进托盘（服务继续后台运行）')
      })
      mainWindow.on('closed', () => {
        elog('窗口已关闭')
        mainWindow = null
      })

      createTray()
      await mainWindow.loadURL(guiUrl)
      if (!silent) {
        mainWindow.once('ready-to-show', () => mainWindow.show())
      }
      elog(silent ? '窗口已加载（静默模式，仅托盘）' : '窗口已加载')
    } catch (error) {
      elog('启动失败：', error?.stack ?? error)
      app.quit()
    }
  })

  app.on('window-all-closed', () => {
    void quitAndShutdown('window-all-closed')
  })
  app.on('before-quit', event => {
    if (!quitting) {
      event.preventDefault()
      void quitAndShutdown('app-quit')
    }
  })
}
