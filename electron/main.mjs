/**
 * DSH 本地启动器 — Electron 主进程（即启动器后端宿主）。
 * 窗口关闭 → 停止全部子进程 → 退出（不常驻后台）。
 * 使用自带 electron 运行时：
 *   runtime\electron\dist\electron.exe electron
 */
import { app, BrowserWindow, shell, dialog } from 'electron'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { appendFileSync, mkdirSync } from 'node:fs'
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
  let quitting = false

  async function quitAndShutdown(reason) {
    if (quitting) return
    quitting = true
    elog(`退出流程：${reason}`)
    try {
      await shutdown(reason)
    } catch (error) {
      elog('shutdown 异常：', error?.stack ?? error)
    }
    app.quit()
  }

  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(async () => {
    try {
      ensureDirs()
      const cfg = readConfig()
      const port = Number(cfg.LAUNCHER_PORT) || 0
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
      if (port && actualPort !== port) {
        await dialog.showMessageBox(null, {
          type: 'warning',
          title: 'DSH 启动器',
          message: `端口 ${port} 被占用，已改用随机端口 ${actualPort}。`,
          detail: '可能有另一个启动器实例正在运行。',
        })
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

      mainWindow.once('ready-to-show', () => mainWindow.show())
      mainWindow.on('closed', () => {
        elog('窗口已关闭')
        mainWindow = null
        void quitAndShutdown('window-closed')
      })
      await mainWindow.loadURL(`http://127.0.0.1:${actualPort}/?token=${token}`)
      elog('窗口已加载')
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
