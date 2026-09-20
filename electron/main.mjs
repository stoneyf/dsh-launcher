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
  elog('已有实例在运行，退出')
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
        { label: '退出', click: () => { quitting = true; void quitAndShutdown('tray-quit') } },
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
   */
  async function probeExistingBackend(port) {
    if (!port) return null
    const base = `http://127.0.0.1:${port}`
    try {
      const ping = await fetch(`${base}/api/ping`, { signal: AbortSignal.timeout(1500) })
      if (ping.status !== 200) return null
      let token = ''
      try { token = readFileSync(join(DIRS.logs, 'launcher.token'), 'ascii').trim() } catch { return null }
      if (!token) return null
      const st = await fetch(`${base}/api/status?token=${token}`, { signal: AbortSignal.timeout(1500) })
      if (st.status !== 200) return null
      return `${base}/?token=${token}`
    } catch { return null }
  }

  async function quitAndShutdown(reason) {
    if (quitting) return
    quitting = true
    if (attached) {
      // 附着模式：后端属于开机实例，只关闭本窗口进程，不停共享服务
      elog(`退出（附着模式，仅关闭本窗口）：${reason}`)
      app.quit()
      return
    }
    elog(`退出流程：${reason}`)
    try {
      await shutdown(reason)
    } catch (error) {
      elog('shutdown 异常：', error?.stack ?? error)
    }
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
