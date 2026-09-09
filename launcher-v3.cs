// DSH Launcher V3 —— 无控制台启动入口（替代 .vbs 隐藏启动，双击即用）
// 编译: csc /nologo /target:winexe /optimize /codepage:65001 /out:dsh-launcher-v3.exe launcher-v3.cs
// 行为: 双击 → 优先拉起 Electron 桌面窗口（electron-v3）；
//       --browser 参数或 electron 缺失时走纯 Node 浏览器模式；
//       组件缺失弹出提示框。
using System;
using System.Diagnostics;
using System.IO;

static class DshLauncherV3
{
    [STAThread]
    static int Main(string[] args)
    {
        string root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\', '/');
        string electron = Path.Combine(root, "electron", "node_modules", "electron", "dist", "electron.exe");
        string electronApp = Path.Combine(root, "electron-v3");
        string node = Path.Combine(root, "runtime", "node", "node.exe");
        string server = Path.Combine(root, "server-v3", "main.mjs");

        bool isBrowser = Array.IndexOf(args, "--browser") >= 0;

        ProcessStartInfo psi = null;
        if (!isBrowser && File.Exists(electron) && Directory.Exists(electronApp))
        {
            // 与 launcher-v3.bat 相同：工作目录为根目录，应用目录为 electron-v3
            psi = new ProcessStartInfo();
            psi.FileName = electron;
            psi.Arguments = "electron-v3";
            psi.WorkingDirectory = root;
        }
        else if (File.Exists(node) && File.Exists(server))
        {
            psi = new ProcessStartInfo();
            psi.FileName = node;
            psi.Arguments = "\"" + server + "\" --browser";
            psi.WorkingDirectory = root;
        }
        else
        {
            System.Windows.Forms.MessageBox.Show(
                "缺少必要组件，请先运行 setup.bat。\n(未找到 electron 或 runtime\\node)",
                "DSH 启动器 V3");
            return 1;
        }

        try
        {
            Process p = new Process();
            p.StartInfo = psi;
            p.Start();
            p.WaitForExit();
            return p.ExitCode;
        }
        catch (Exception ex)
        {
            System.Windows.Forms.MessageBox.Show("启动失败：" + ex.Message, "DSH 启动器 V3");
            return 1;
        }
    }
}
