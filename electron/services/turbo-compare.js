/**
 * turbo-compare.js — 开发用：新极速导出（turbo）与现有导出的自动对比测试。
 *
 * 仅在设置环境变量 VIDEOKIT_TURBO_COMPARE=<spec.json> 时由 main.js 调用，
 * 正常启动 VideoKit 时不会加载，也不会创建任何窗口。
 *
 * 流程：隐藏的 harness 窗口像主界面一样调用 'isolated-wysiwyg-export'，
 * 对同一批测试任务分别用旧引擎和 turbo 导出，然后用 FFmpeg 逐帧比较。
 */
const path = require('path');

function run({ app, BrowserWindow, ipcMain, log = console.log }) {
    const specPath = process.env.VIDEOKIT_TURBO_COMPARE;
    const harness = path.join(__dirname, '..', '..', 'scripts', 'turbo-compare', 'harness.html');
    const win = new BrowserWindow({
        show: false,
        width: 320,
        height: 240,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            backgroundThrottling: false,
            webSecurity: false,
        },
    });
    win.webContents.on('console-message', (_event, _level, message) => {
        process.stdout.write(`[turbo-compare] ${message}\n`);
    });
    win.webContents.on('render-process-gone', (_event, details) => {
        process.stdout.write(`[turbo-compare] harness 渲染进程退出: ${JSON.stringify(details)}\n`);
        app.exit(3);
    });
    ipcMain.once('turbo-compare-done', (_event, code) => {
        log(`[turbo-compare] 完成，退出码 ${code}`);
        setTimeout(() => app.exit(Number(code) || 0), 200);
    });
    win.loadFile(harness, { query: { spec: specPath } });
}

module.exports = { run };
