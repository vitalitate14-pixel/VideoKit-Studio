const VideoKitLocalTime = require('../src/local-time');
const { app, BrowserWindow, ipcMain, MessageChannelMain, dialog, powerSaveBlocker, protocol, shell, net, screen, desktopCapturer, clipboard, nativeImage, session } = require('electron');
const path = require('path');
const fs = require('fs');
// Keep existing user data when the packaged application display name changes.
if (app.isPackaged) app.setPath('userData', path.join(app.getPath('appData'), 'VideoKit'));
const { spawnSync } = require('child_process');
const { Readable } = require('stream');
const ffmpegService = require('./services/ffmpeg');

const DEV_SERVER_PORT = Number(process.env.VITE_PORT) || 5173;
const DEV_SERVER_URL = `http://localhost:${DEV_SERVER_PORT}`;

// Node.js API 路由器 —— 替代 Python Flask 后端
const { registerAPIHandlers } = require('./apiRouter');
const persistentPresetStore = require('./services/persistentPresetStore');
const overlayPresetPackage = require('./services/overlayPresetPackage');
const cacheManager = require('./services/cacheManager');

let mainWindow;
let appIsReady = false;
let powerSaveId = null;
let isQuitting = false;
const templateWindows = new Map(); // templateId → BrowserWindow
const isolatedReelsRenderers = new Map(); // requestId → BrowserWindow
let latestRendererCrashReport = null;
const reelsResourceDiagnostics = require('./services/reelsResourceDiagnostics').createReelsResourceDiagnostics({
    app, log,
    getProcessRoles: () => {
        if (!mainWindow || mainWindow.isDestroyed()) return {};
        const contents = mainWindow.webContents;
        return { mainRendererPid: contents.getOSProcessId(), devToolsPid: contents.devToolsWebContents?.getOSProcessId() || null };
    },
});

// 保留不含任务内容的崩溃诊断，用户可将该文件反馈给开发者定位问题。
function writeRendererCrashReport(details = {}) {
    const reason = String(details?.reason || '');
    // 正常退出、开发者热重载、进程主动终止 (killed/clean-exit/code 15) 不属于异常崩溃，不写入日志
    if (reason === 'clean-exit' || reason === 'killed' || details?.exitCode === 0 || details?.exitCode === 15) {
        return null;
    }
    try {
        const dir = path.join(app.getPath('userData'), 'diagnostics');
        fs.mkdirSync(dir, { recursive: true });
        const diagnosticFile = path.join(dir, 'renderer-crashes.jsonl');
        const report = {
            timestamp: new Date().toISOString(),
            appVersion: app.getVersion(),
            electron: process.versions.electron,
            chrome: process.versions.chrome,
            platform: process.platform,
            arch: process.arch,
            diagnosticFile,
            ...reelsResourceDiagnostics.crashContext(),
            ...details,
        };
        fs.appendFileSync(diagnosticFile, `${JSON.stringify(report)}\n`, 'utf8');
        latestRendererCrashReport = report;
        log(`[CrashReport] ${JSON.stringify(report)}`);
        return report;
    } catch (error) {
        log(`[CrashReport] 写入失败: ${error.message}`);
        return null;
    }
}

function getLatestRendererCrashReport() {
    if (latestRendererCrashReport) {
        const reason = String(latestRendererCrashReport.reason || '');
        if (reason === 'clean-exit' || reason === 'killed') return null;
        return latestRendererCrashReport;
    }
    try {
        const diagnosticFile = path.join(app.getPath('userData'), 'diagnostics', 'renderer-crashes.jsonl');
        if (!fs.existsSync(diagnosticFile)) return null;
        const lines = fs.readFileSync(diagnosticFile, 'utf8').trim().split('\n').filter(Boolean);
        if (!lines.length) return null;
        const last = JSON.parse(lines[lines.length - 1]);
        const reason = String(last?.reason || '');
        if (reason === 'clean-exit' || reason === 'killed') return null;
        // 只有 60 秒内发生的真实崩溃（比如异常闪退后刚拉起恢复）才返回给前端展示，避免冷启动翻出历史旧账
        const reportTime = new Date(last?.timestamp).getTime();
        if (isNaN(reportTime) || Date.now() - reportTime > 60000) return null;
        latestRendererCrashReport = { ...last, diagnosticFile };
        return latestRendererCrashReport;
    } catch (error) {
        log(`[CrashReport] 读取失败: ${error.message}`);
        return null;
    }
}

function _savedBatchTaskCount(raw) {
    if (!raw) return 0;
    try {
        const data = JSON.parse(raw);
        if (Array.isArray(data.tabs)) {
            return data.tabs.reduce((sum, tab) => sum + (Array.isArray(tab?.tasks) ? tab.tasks.length : 0), 0);
        }
        return Array.isArray(data.tasks) ? data.tasks.length : 0;
    } catch {
        return 0;
    }
}

/**
 * 开发版由旧 file:// 页面切到本地 Vite 服务后，Chromium 会使用另一套
 * localStorage origin。仅在 localhost 没有有效任务时，把旧 file:// 数据复制过来；
 * 当前开发数据始终优先，避免覆盖用户刚做的新工程。
 */
async function migrateLegacyFileStorageToDevOrigin(targetWindow) {
    if (app.isPackaged || !targetWindow || targetWindow.isDestroyed()) return false;

    let legacyWindow = null;
    try {
        const currentStore = await targetWindow.webContents.executeJavaScript(
            'Object.fromEntries(Array.from({length:localStorage.length},(_,i)=>{const k=localStorage.key(i);return [k,localStorage.getItem(k)]}))',
            true
        );
        if (currentStore?.videokit_disable_file_origin_migration) {
            log('[StorageMigration] 已有可靠恢复标记，跳过旧 file:// 自动迁移');
            return false;
        }
        const currentBatchCount = _savedBatchTaskCount(currentStore?.reels_batch_config_autosave);

        legacyWindow = new BrowserWindow({
            show: false,
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                sandbox: true,
            },
        });
        await legacyWindow.loadFile(path.join(__dirname, '../src/storage-bridge.html'));
        const legacyStore = await legacyWindow.webContents.executeJavaScript(
            'Object.fromEntries(Array.from({length:localStorage.length},(_,i)=>{const k=localStorage.key(i);return [k,localStorage.getItem(k)]}))',
            true
        );
        const legacyBatchCount = _savedBatchTaskCount(legacyStore?.reels_batch_config_autosave);
        const merged = { ...(currentStore || {}) };
        let copied = 0;
        let restoredLegacyBatch = false;
        let copiedBulkCreateLibrary = false;

        for (const [key, value] of Object.entries(legacyStore || {})) {
            if (merged[key] == null) {
                merged[key] = value;
                copied++;
                if (key === 'reels_bulk_create_presets'
                    || key === 'reels_bulk_create_viral_group_presets'
                    || key === 'reels_bulk_create_viral_projects') {
                    copiedBulkCreateLibrary = true;
                }
            }
        }
        // 旧 file:// 工程明显更完整时，先备份 localhost 当前工程，再恢复旧工程。
        // 这样既能找回历史内容，也不会丢掉切换来源后新建的少量任务。
        if (legacyBatchCount > currentBatchCount) {
            if (currentStore?.reels_batch_config_autosave) {
                merged.reels_batch_config_autosave_before_file_migration = currentStore.reels_batch_config_autosave;
            }
            merged.reels_batch_config_autosave = legacyStore.reels_batch_config_autosave;
            merged.reels_batch_file_origin_migrated_at = new Date().toISOString();
            copied++;
            restoredLegacyBatch = true;
        }
        if (!copied) return false;

        const serialized = JSON.stringify(merged);
        await targetWindow.webContents.executeJavaScript(
            `(()=>{const data=${serialized};for(const [k,v] of Object.entries(data)){localStorage.setItem(k,v)};return true})()`,
            true
        );
        const finalBatchCount = restoredLegacyBatch ? legacyBatchCount : currentBatchCount;
        log(`[StorageMigration] 已从 file:// 迁移 ${copied} 个本地存储项；批量任务 ${currentBatchCount} -> ${finalBatchCount}`);

        // 批量表格恢复函数在首次 DOMContentLoaded 时已经运行过，迁移后刷新一次，
        // 让所有模块按正常初始化顺序读取迁移后的数据。
        // 大量制作模块会在页面初始化时读取预设列表。即使只补回预设、
        // 没有替换任务队列，也必须重新加载一次，不能让“加载”窗口继续
        // 显示迁移前的旧列表。
        if ((restoredLegacyBatch || copiedBulkCreateLibrary) && !targetWindow.isDestroyed()) {
            targetWindow.webContents.reloadIgnoringCache();
        }
        return true;
    } catch (error) {
        log(`[StorageMigration] 旧版数据迁移失败: ${error.message}`);
        return false;
    } finally {
        if (legacyWindow && !legacyWindow.isDestroyed()) legacyWindow.destroy();
    }
}

/** 只读导出旧 file:// 批量配置，用于核对跨 origin 丢失的任务样式。 */
async function snapshotLegacyBatchForStyleAudit(targetWindow) {
    if (app.isPackaged || !targetWindow || targetWindow.isDestroyed()) return false;
    const requestPath = path.join(__dirname, '..', '.videokit-style-audit-request.json');
    if (!fs.existsSync(requestPath)) return false;
    let legacyWindow = null;
    try {
        legacyWindow = new BrowserWindow({
            show: false,
            webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
        });
        await legacyWindow.loadFile(path.join(__dirname, '../src/storage-bridge.html'));
        const legacyRaw = await legacyWindow.webContents.executeJavaScript(
            'localStorage.getItem("reels_batch_config_autosave") || ""', true
        );
        if (!legacyRaw) throw new Error('旧 file:// 批量配置不存在');
        const auditDir = path.join(app.getPath('userData'), 'batch-recovery');
        fs.mkdirSync(auditDir, { recursive: true });
        const stamp = VideoKitLocalTime.format().replace(/[:.]/g, '-');
        const outputPath = path.join(auditDir, `legacy-style-audit-${stamp}.json`);
        fs.writeFileSync(outputPath, legacyRaw, 'utf-8');
        fs.renameSync(requestPath, path.join(__dirname, '..', '.videokit-style-audit-completed.json'));
        log(`[StyleAudit] 已只读导出旧批量配置 ${_savedBatchTaskCount(legacyRaw)} 条: ${outputPath}`);
        return true;
    } catch (error) {
        log(`[StyleAudit] 导出失败: ${error.message}`);
        return false;
    } finally {
        if (legacyWindow && !legacyWindow.isDestroyed()) legacyWindow.destroy();
    }
}

function _naturalTemplateNameSort(a, b) {
    return String(a?.name || '').localeCompare(String(b?.name || ''), undefined, {
        numeric: true,
        sensitivity: 'base',
    });
}

/**
 * 从用户明确保存过的分队列模板重建批量任务。模板带创建时间和完整 projectData，
 * 比跨 origin 的“最后一份 localStorage”更适合作为指定日期的恢复来源。
 */
async function recoverPendingBatchFromTemplates(targetWindow) {
    if (app.isPackaged || !targetWindow || targetWindow.isDestroyed()) return false;
    const requestPath = path.join(__dirname, '..', '.videokit-recovery-request.json');
    if (!fs.existsSync(requestPath)) return false;

    try {
        const request = JSON.parse(fs.readFileSync(requestPath, 'utf-8'));
        const matcher = new RegExp(request.templateNamePattern || '.*');
        const templatesDir = path.join(app.getPath('userData'), 'videokit-templates');
        const indexPath = path.join(templatesDir, 'index.json');
        const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
        const selected = index
            .filter(item => matcher.test(String(item.name || '')))
            .filter(item => !request.createdDate || String(item.createdAt || '').startsWith(request.createdDate))
            .sort(_naturalTemplateNameSort);
        if (!selected.length) throw new Error('没有找到符合恢复条件的队列模板');

        const tasks = [];
        const seenTaskIds = new Set();
        for (const item of selected) {
            const full = JSON.parse(fs.readFileSync(path.join(templatesDir, `${item.id}.json`), 'utf-8'));
            const templateTasks = Array.isArray(full?.projectData?.tasks) ? full.projectData.tasks : [];
            for (const sourceTask of templateTasks) {
                const task = JSON.parse(JSON.stringify(sourceTask));
                const mediaPath = task.audioPath || task.videoPath || task.bgPath || task.srtPath || '';
                const sourceFolder = mediaPath ? path.dirname(mediaPath) : '';
                const queueNameMatch = String(item.name || '').match(/_([0-9]+)$/);
                const queueName = queueNameMatch ? queueNameMatch[1] : (sourceFolder ? path.basename(sourceFolder) : item.name);
                task._sourceFolder = task._sourceFolder || sourceFolder;
                // 恢复时以“已保存的模板”作为队列边界。不能沿用模板内旧的
                // folderQueueId：多个后续任务队列可能循环使用同一批素材，路径一样
                // 但仍是独立队列。沿用旧 ID 会让启动去重把 18×6 误压成 6 条。
                task._folderQueueId = `template:${item.id}`;
                task._folderQueueName = queueName;
                if (task.id && seenTaskIds.has(task.id)) continue;
                if (task.id) seenTaskIds.add(task.id);
                tasks.push(task);
            }
        }
        if (!tasks.length) throw new Error('匹配模板中没有任务数据');

        const now = new Date().toISOString();
        const recoveryConfig = {
            timestamp: now,
            version: '2.0',
            activeTabId: 'tab_recovered_0806',
            nextTabId: 2,
            projectDir: '',
            projectName: 'Recovered_0806_Project.json',
            recoverySource: {
                label: request.label || '队列模板恢复',
                templateIds: selected.map(item => item.id),
                templateCreatedAt: selected.map(item => item.createdAt),
            },
            tabs: [{
                id: 'tab_recovered_0806',
                name: '批量导入任务',
                materialDir: '',
                folderQueueId: '',
                externalFolderQueuesCombined: true,
                lastRefreshTime: now,
                tasks,
            }],
        };

        const currentRaw = await targetWindow.webContents.executeJavaScript(
            'localStorage.getItem("reels_batch_config_autosave") || ""',
            true
        );
        const recoveryDir = path.join(app.getPath('userData'), 'batch-recovery');
        fs.mkdirSync(recoveryDir, { recursive: true });
        const stamp = now.replace(/[:.]/g, '-');
        if (currentRaw) fs.writeFileSync(path.join(recoveryDir, `before-${stamp}.json`), currentRaw, 'utf-8');
        fs.writeFileSync(path.join(recoveryDir, `recovered-${stamp}.json`), JSON.stringify(recoveryConfig, null, 2), 'utf-8');

        const configJson = JSON.stringify(recoveryConfig);
        const backupKey = `reels_batch_config_backup_${Date.now()}`;
        await targetWindow.webContents.executeJavaScript(
            `(()=>{const old=localStorage.getItem('reels_batch_config_autosave');` +
            `if(old)localStorage.setItem(${JSON.stringify(backupKey)},old);` +
            // 紧接着的 reload 会触发旧页面 beforeunload。必须先禁止旧页面
            // 把内存中的旧 6 条任务又覆盖到刚写好的 108 条恢复配置上。
            `window._skipBatchSaveBeforeUnload=true;` +
            `localStorage.setItem('reels_batch_config_autosave',${JSON.stringify(configJson)});return true})()`,
            true
        );

        const completedPath = path.join(__dirname, '..', '.videokit-recovery-completed.json');
        fs.renameSync(requestPath, completedPath);
        log(`[TemplateRecovery] 已从 ${selected.length} 个模板恢复 ${tasks.length} 条任务：${request.label || ''}`);
        if (!targetWindow.isDestroyed()) targetWindow.webContents.reloadIgnoringCache();
        return true;
    } catch (error) {
        log(`[TemplateRecovery] 恢复失败: ${error.message}`);
        return false;
    }
}

/** 从指定队列模板只恢复字幕样式，不改动当前任务的素材、字幕和对齐结果。 */
async function recoverPendingStylesFromTemplates(targetWindow) {
    if (app.isPackaged || !targetWindow || targetWindow.isDestroyed()) return false;
    const requestPath = path.join(__dirname, '..', '.videokit-style-recovery-request.json');
    if (!fs.existsSync(requestPath)) return false;
    try {
        const request = JSON.parse(fs.readFileSync(requestPath, 'utf-8'));
        const matcher = new RegExp(request.templateNamePattern || '.*');
        const templatesDir = path.join(app.getPath('userData'), 'videokit-templates');
        const index = JSON.parse(fs.readFileSync(path.join(templatesDir, 'index.json'), 'utf-8'));
        const selected = index
            .filter(item => matcher.test(String(item.name || '')))
            .filter(item => !request.createdDate || String(item.createdAt || '').startsWith(request.createdDate))
            .sort(_naturalTemplateNameSort);
        if (!selected.length) throw new Error('没有找到指定的队列模板');

        const queueSources = new Map();
        for (const item of selected) {
            const full = JSON.parse(fs.readFileSync(path.join(templatesDir, `${item.id}.json`), 'utf-8'));
            const queueMatch = String(item.name || '').match(/^0806_([0-9]+)/);
            if (!queueMatch) continue;
            const sourceTasks = Array.isArray(full?.projectData?.tasks) ? full.projectData.tasks : [];
            const byId = new Map(sourceTasks.filter(t => t.id).map(t => [String(t.id), t]));
            const byAudio = new Map(sourceTasks.filter(t => t.audioPath).map(t => [String(t.audioPath), t]));
            const byName = new Map(sourceTasks.filter(t => t.baseName).map(t => [String(t.baseName).toLowerCase(), t]));
            queueSources.set(queueMatch[1], { sourceTasks, byId, byAudio, byName });
        }

        const currentRaw = await targetWindow.webContents.executeJavaScript(
            'localStorage.getItem("reels_batch_config_autosave") || ""', true
        );
        if (!currentRaw) throw new Error('当前批量配置不存在');
        const config = JSON.parse(currentRaw);
        let restored = 0;
        for (const tab of (config.tabs || [])) {
            for (const task of (tab.tasks || [])) {
                const queueName = String(task._folderQueueName || '').trim();
                const source = queueSources.get(queueName);
                if (!source) continue;
                const matched = (task.id && source.byId.get(String(task.id)))
                    || (task.audioPath && source.byAudio.get(String(task.audioPath)))
                    || (task.baseName && source.byName.get(String(task.baseName).toLowerCase()));
                if (!matched) continue;
                // 旧模板的 task.style 是当时真正渲染的队列样式；
                // subtitleStyle 在部分队列只有单条旧副本，不能用它覆盖整队。
                const style = matched.style || matched.subtitleStyle;
                if (!style || typeof style !== 'object' || !Object.keys(style).length) continue;
                task.style = JSON.parse(JSON.stringify(style));
                task.subtitleStyle = JSON.parse(JSON.stringify(style));
                if (matched._subtitlePreset) task._subtitlePreset = matched._subtitlePreset;
                else delete task._subtitlePreset;
                restored++;
            }
        }
        if (!restored) throw new Error('当前任务与队列模板没有匹配上');

        const recoveryDir = path.join(app.getPath('userData'), 'batch-recovery');
        fs.mkdirSync(recoveryDir, { recursive: true });
        const stamp = VideoKitLocalTime.format().replace(/[:.]/g, '-');
        fs.writeFileSync(path.join(recoveryDir, `before-style-recovery-${stamp}.json`), currentRaw, 'utf-8');
        config.timestamp = new Date().toISOString();
        config.styleRecovery = { restored, label: request.label || '', at: config.timestamp };
        const nextRaw = JSON.stringify(config);
        fs.writeFileSync(path.join(recoveryDir, `after-style-recovery-${stamp}.json`), JSON.stringify(config, null, 2), 'utf-8');
        await targetWindow.webContents.executeJavaScript(
            `(()=>{window._skipBatchSaveBeforeUnload=true;localStorage.setItem('reels_batch_config_autosave',${JSON.stringify(nextRaw)});return true})()`,
            true
        );
        fs.renameSync(requestPath, path.join(__dirname, '..', '.videokit-style-recovery-completed.json'));
        log(`[StyleRecovery] 已从 ${selected.length} 个队列模板恢复 ${restored} 条任务的字幕样式`);
        if (!targetWindow.isDestroyed()) targetWindow.webContents.reloadIgnoringCache();
        return true;
    } catch (error) {
        log(`[StyleRecovery] 恢复失败: ${error.message}`);
        return false;
    }
}

async function repairPendingTemplateThumbnails(targetWindow) {
    if (app.isPackaged || !targetWindow || targetWindow.isDestroyed()) return false;
    const requestPath = path.join(__dirname, '..', '.videokit-thumbnail-repair-request.json');
    if (!fs.existsSync(requestPath)) return false;
    try {
        const request = JSON.parse(fs.readFileSync(requestPath, 'utf-8'));
        const matcher = new RegExp(request.templateNamePattern || '.*');
        const templatesDir = path.join(app.getPath('userData'), 'videokit-templates');
        const index = JSON.parse(fs.readFileSync(path.join(templatesDir, 'index.json'), 'utf-8'));
        const ids = index
            .filter(item => matcher.test(String(item.name || '')))
            .filter(item => !request.createdDate || String(item.createdAt || '').startsWith(request.createdDate))
            .sort(_naturalTemplateNameSort)
            .map(item => item.id);
        if (!ids.length) throw new Error('没有找到需要修复封面的模板');

        const expression = `(async()=>{` +
            `localStorage.setItem('videokit_disable_file_origin_migration',${JSON.stringify(request.label || 'template-recovery')});` +
            `if(typeof window._repairTemplateThumbnailsByIds!=='function')throw new Error('封面修复函数未加载');` +
            `return await window._repairTemplateThumbnailsByIds(${JSON.stringify(ids)},{silent:true})` +
            `})()`;
        const result = await targetWindow.webContents.executeJavaScript(expression, true);
        const completedPath = path.join(__dirname, '..', '.videokit-thumbnail-repair-completed.json');
        fs.renameSync(requestPath, completedPath);
        log(`[ThumbnailRepair] ${request.label || ''}：成功 ${result?.repaired || 0}，失败 ${result?.failed || 0}`);
        return true;
    } catch (error) {
        log(`[ThumbnailRepair] 修复失败: ${error.message}`);
        return false;
    }
}

async function logBatchStartupState(targetWindow, label = 'startup') {
    if (!targetWindow || targetWindow.isDestroyed()) return;
    try {
        const state = await targetWindow.webContents.executeJavaScript(
            `(()=>{let saved=null;try{saved=JSON.parse(localStorage.getItem('reels_batch_config_autosave')||'null')}catch(_){}` +
            `return {memoryTasks:window._reelsState?.tasks?.length||0,` +
            `tabs:(window._batchTableState?.tabs||[]).map(t=>({name:t.name,count:t.tasks?.length||0})),` +
            `savedTabs:(saved?.tabs||[]).map(t=>({name:t.name,count:t.tasks?.length||0})),` +
            `savedTotal:(saved?.tabs||[]).reduce((n,t)=>n+(t.tasks?.length||0),0)}})()`,
            true
        );
        log(`[BatchStartup:${label}] ${JSON.stringify(state)}`);
    } catch (error) {
        log(`[BatchStartup:${label}] 读取失败: ${error.message}`);
    }
}

// local-media 用于渲染本地生成的预览图/媒体。必须在 app.ready 前声明权限，
// 否则 video/img 的 range/fetch 行为在部分 Electron 版本里会不稳定。
try {
    protocol.registerSchemesAsPrivileged([{
        scheme: 'local-media',
        privileges: {
            secure: true,
            supportFetchAPI: true,
            stream: true,
            corsEnabled: true,
        },
    }]);
} catch (e) {
    console.warn('[Protocol] local-media privilege registration skipped:', e.message);
}

// ── 自定义缓存路径（必须在 app.ready 之前设置）──
const _cacheConfigPath = path.join(app.isPackaged ? path.dirname(process.execPath) : __dirname, '.videokit-cache-config.json');
function _loadCacheConfig() {
    try {
        if (fs.existsSync(_cacheConfigPath)) {
            const cfg = JSON.parse(fs.readFileSync(_cacheConfigPath, 'utf-8'));
            if (cfg.userDataPath && fs.existsSync(cfg.userDataPath)) {
                return cfg.userDataPath;
            }
        }
    } catch (e) { /* ignore */ }
    return null;
}
const _customUserData = _loadCacheConfig();
if (_customUserData) {
    app.setPath('userData', _customUserData);
}

// 日志文件路径
const logDir = (app && app.isPackaged)
    ? path.join(app.getPath('userData'), 'logs')
    : path.join(__dirname, '..', 'logs');

// 确保日志目录存在
function ensureLogDir() {
    try {
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
        }
    } catch (e) {
        console.error('Failed to create log directory:', e);
    }
}

// 写日志到文件
function log(message) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}`;
    console.log(logMessage);

    try {
        ensureLogDir();
        const logFile = path.join(logDir, 'app.log');
        fs.appendFileSync(logFile, logMessage + '\n');
    } catch (e) {
        // 忽略日志写入错误
    }
}

// 获取资源路径
function getResourcePath(relativePath) {
    if (app.isPackaged) {
        return path.join(process.resourcesPath, relativePath);
    }
    return path.join(__dirname, '..', relativePath);
}

// Apple Silicon 版不能把 Intel-only 的 ffmpeg 当成可靠依赖。部分机器安装了
// Rosetta 时它会碰巧工作，未安装时则所有媒体探测都失败，前端只能看到 0 秒
// 和 0% 匹配，极难定位。这里同时校验 Mach-O 架构和实际可启动性。
function isUsableMacMediaBinary(binaryPath) {
    if (!binaryPath || !fs.existsSync(binaryPath)) return false;
    try {
        const archProbe = spawnSync('/usr/bin/lipo', ['-archs', binaryPath], {
            timeout: 3000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
        });
        const arches = String(archProbe.stdout || '').trim().split(/\s+/).filter(Boolean);
        const requiredArch = process.arch === 'arm64' ? 'arm64' : 'x86_64';
        if (arches.length && !arches.includes(requiredArch)) {
            log(`[FFmpeg] Skipping incompatible ${binaryPath}; needs ${requiredArch}, has ${arches.join(', ')}`);
            return false;
        }
        const runProbe = spawnSync(binaryPath, ['-version'], {
            timeout: 5000, stdio: 'ignore'
        });
        if (runProbe.error || runProbe.status !== 0) {
            log(`[FFmpeg] Cannot start ${binaryPath}: ${runProbe.error?.message || `exit ${runProbe.status}`}`);
            return false;
        }
        return true;
    } catch (error) {
        log(`[FFmpeg] Cannot validate ${binaryPath}: ${error.message}`);
        return false;
    }
}

function findUsableMacMediaPair(name) {
    const systemDirs = ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin', '/usr/bin'];
    for (const dir of systemDirs) {
        const candidate = path.join(dir, name);
        if (isUsableMacMediaBinary(candidate)) return candidate;
    }
    return '';
}

// 获取 FFmpeg 路径并注入到 PATH
function setupFFmpegPath() {
    // macOS: 检查打包的 FFmpeg
    if (process.platform === 'darwin') {
        const candidates = [
            path.join(getResourcePath('vendor'), 'ffmpeg'),
            path.join(getResourcePath('vendor'), 'darwin', 'ffmpeg'),
        ];
        log(`[FFmpeg] macOS resource path: ${getResourcePath('vendor')}`);
        let found = false;
        for (const vendorFfmpeg of candidates) {
            log(`[FFmpeg] Checking candidate: ${vendorFfmpeg} exists=${fs.existsSync(vendorFfmpeg)}`);
            if (fs.existsSync(vendorFfmpeg)) {
                const ffmpegExe = path.join(vendorFfmpeg, 'ffmpeg');
                const ffprobeExe = path.join(vendorFfmpeg, 'ffprobe');
                log(`[FFmpeg]   ffmpeg: ${ffmpegExe} exists=${fs.existsSync(ffmpegExe)}`);
                log(`[FFmpeg]   ffprobe: ${ffprobeExe} exists=${fs.existsSync(ffprobeExe)}`);
                if (isUsableMacMediaBinary(ffmpegExe) && isUsableMacMediaBinary(ffprobeExe)) {
                    log(`Using vendor FFmpeg on macOS: ${vendorFfmpeg}`);
                    process.env.PATH = `${vendorFfmpeg}${path.delimiter}${process.env.PATH || ''}`;
                    if (fs.existsSync(ffmpegExe)) process.env.FFMPEG_PATH = ffmpegExe;
                    if (fs.existsSync(ffprobeExe)) process.env.FFPROBE_PATH = ffprobeExe;
                    found = true;
                    break;
                }
            }
        }
        if (!found) {
            // 内置二进制不存在、损坏或架构不匹配时，明确使用用户已安装的
            // 系统版本。不能只修改 PATH，否则 ffmpeg.js 会再次扫描并选回
            // 那个不可执行的内置 Intel 版本。
            const systemFfmpeg = findUsableMacMediaPair('ffmpeg');
            const systemFfprobe = findUsableMacMediaPair('ffprobe');
            if (systemFfmpeg && systemFfprobe) {
                process.env.FFMPEG_PATH = systemFfmpeg;
                process.env.FFPROBE_PATH = systemFfprobe;
                const systemDir = path.dirname(systemFfmpeg);
                process.env.PATH = `${systemDir}${path.delimiter}${process.env.PATH || ''}`;
                log(`Using compatible system FFmpeg on macOS: ${systemDir}`);
                found = true;
            }
        }
        if (!found) {
            // 回退到系统安装的 FFmpeg
            const macPaths = [
                '/opt/homebrew/bin',
                '/usr/local/bin',
                '/opt/local/bin',
            ];
            const existingPath = process.env.PATH || '';
            const additionalPaths = macPaths.filter(p => !existingPath.includes(p)).join(path.delimiter);
            if (additionalPaths) {
                process.env.PATH = `${additionalPaths}${path.delimiter}${existingPath}`;
            }
            log(`[FFmpeg] WARNING: ffmpeg/ffprobe not found in any candidate path! Fallback to system PATH: ${process.env.PATH}`);
        }
    } else if (process.platform === 'win32') {
        // Packaged: extraResources maps vendor/windows/ffmpeg → vendor/ffmpeg
        // Dev: files sit at vendor/windows/ffmpeg/bin
        const candidates = [
            path.join(getResourcePath('vendor'), 'ffmpeg', 'bin'),
            path.join(getResourcePath('vendor'), 'windows', 'ffmpeg', 'bin'),
            // 额外的 fallback：直接在 vendor/ffmpeg 下（无 bin 子目录的情况）
            path.join(getResourcePath('vendor'), 'ffmpeg'),
        ];
        log(`[FFmpeg] Windows resource path: ${getResourcePath('vendor')}`);
        let found = false;
        for (const vendorFfmpeg of candidates) {
            log(`[FFmpeg] Checking candidate: ${vendorFfmpeg} exists=${fs.existsSync(vendorFfmpeg)}`);
            if (fs.existsSync(vendorFfmpeg)) {
                const ffmpegExe = path.join(vendorFfmpeg, 'ffmpeg.exe');
                const ffprobeExe = path.join(vendorFfmpeg, 'ffprobe.exe');
                log(`[FFmpeg]   ffmpeg.exe: ${ffmpegExe} exists=${fs.existsSync(ffmpegExe)}`);
                log(`[FFmpeg]   ffprobe.exe: ${ffprobeExe} exists=${fs.existsSync(ffprobeExe)}`);
                if (fs.existsSync(ffmpegExe) || fs.existsSync(ffprobeExe)) {
                    log(`Using vendor FFmpeg on Windows: ${vendorFfmpeg}`);
                    process.env.PATH = `${vendorFfmpeg}${path.delimiter}${process.env.PATH || ''}`;
                    if (fs.existsSync(ffmpegExe)) process.env.FFMPEG_PATH = ffmpegExe;
                    if (fs.existsSync(ffprobeExe)) process.env.FFPROBE_PATH = ffprobeExe;
                    found = true;
                    break;
                }
            }
        }
        if (!found) {
            log(`[FFmpeg] WARNING: ffmpeg/ffprobe not found in any candidate path!`);
        }
    } else {
        // Linux: Packaged maps vendor/linux/ffmpeg → vendor/ffmpeg (contains bin/ffmpeg & bin/ffprobe)
        const candidates = [
            path.join(getResourcePath('vendor'), 'ffmpeg', 'bin'),
            path.join(getResourcePath('vendor'), 'linux', 'ffmpeg', 'bin'),
            path.join(getResourcePath('vendor'), 'ffmpeg'),
        ];
        log(`[FFmpeg] Linux resource path: ${getResourcePath('vendor')}`);
        let found = false;
        for (const vendorFfmpeg of candidates) {
            if (fs.existsSync(vendorFfmpeg)) {
                const ffmpegExe = path.join(vendorFfmpeg, 'ffmpeg');
                const ffprobeExe = path.join(vendorFfmpeg, 'ffprobe');
                if (fs.existsSync(ffmpegExe) || fs.existsSync(ffprobeExe)) {
                    log(`Using vendor FFmpeg on Linux: ${vendorFfmpeg}`);
                    process.env.PATH = `${vendorFfmpeg}${path.delimiter}${process.env.PATH || ''}`;
                    if (fs.existsSync(ffmpegExe)) process.env.FFMPEG_PATH = ffmpegExe;
                    if (fs.existsSync(ffprobeExe)) process.env.FFPROBE_PATH = ffprobeExe;
                    found = true;
                    break;
                }
            }
        }
        if (!found) {
            log(`[FFmpeg] Linux vendor ffmpeg not found, falling back to system PATH`);
        }
    }
}

const {
    isBlockedSensitivePath: isBlockedSensitiveFilePath,
    assertSafeFileMutation,
} = require('./services/pathSecurity');

function isAllowedInAppUrl(targetUrl) {
    if (!targetUrl || typeof targetUrl !== 'string') return false;
    if (targetUrl === 'about:blank' || targetUrl.startsWith('devtools://')) return true;
    try {
        const parsed = new URL(targetUrl);
        if (parsed.protocol === 'file:') return true;
        if (!app.isPackaged && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')) {
            return parsed.protocol === 'http:' || parsed.protocol === 'https:';
        }
        return false;
    } catch {
        return false;
    }
}

function hardenPrivilegedWindowNavigation(win) {
    if (!win || !win.webContents) return;
    win.webContents.setWindowOpenHandler((details) => {
        const url = String(details?.url || '');
        if (!url || url === 'about:blank') {
            return {
                action: 'allow',
                overrideBrowserWindowOptions: {
                    webPreferences: {
                        nodeIntegration: false,
                        contextIsolation: true,
                        sandbox: true,
                    },
                },
            };
        }
        try {
            const parsed = new URL(url);
            if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
                shell.openExternal(url).catch(() => {});
            }
        } catch (_) { }
        return { action: 'deny' };
    });

    win.webContents.on('will-navigate', (event, navigationUrl) => {
        if (!isAllowedInAppUrl(navigationUrl)) {
            event.preventDefault();
            log(`[Security] 拦截主窗口向外部 URL 导航: ${navigationUrl}`);
            try {
                const parsed = new URL(navigationUrl);
                if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
                    shell.openExternal(navigationUrl).catch(() => {});
                }
            } catch (_) { }
        }
    });
}

// 创建主窗口
function createWindow() {
    if (mainWindow) {
        mainWindow.focus();
        return;
    }

    if (!appIsReady) return;

    const windowOptions = {
        width: 1200,
        height: 800,
        minWidth: 900,
        minHeight: 700,
        title: 'VideoKit',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: false,
            // Reels preview is canvas-driven. Keep its media decoders and
            // animation clock alive when the user briefly switches apps.
            backgroundThrottling: false,
            webSecurity: true,  // Re-enabled for security; local media loads via local-media:// protocol
            additionalArguments: [`--videokit-mode=${app.isPackaged ? 'packaged' : 'dev'}`],
            preload: path.join(__dirname, 'preload.js')
        },
    };

    // macOS keeps native traffic lights over the colored renderer title bar.
    windowOptions.frame = true;
    windowOptions.titleBarStyle = process.platform === 'darwin' ? 'hidden' : 'default';
    if (process.platform === 'darwin') {
        windowOptions.trafficLightPosition = { x: 12, y: 8 };
        windowOptions.backgroundColor = '#18202C';
    }

    mainWindow = new BrowserWindow(windowOptions);
    hardenPrivilegedWindowNavigation(mainWindow);
    // renderer 异常退出时，beforeunload 不一定会运行；由主进程记录原因。
    mainWindow.webContents.on('render-process-gone', (_event, details) => {
        log(`[RendererLifecycle] render-process-gone ${JSON.stringify({...details, isQuitting})}`);
        reelsResourceDiagnostics.recordEvent('renderer-exit', {
            reason: details?.reason, exitCode: details?.exitCode, isQuitting,
        });
        // 忽略正常退出以及开发者热重启/系统 SIGTERM(15) 终止，不作为异常崩溃记录
        if (isQuitting || details?.reason === 'clean-exit' || details?.exitCode === 15) return;
        writeRendererCrashReport({
            process: details?.process || 'renderer',
            reason: details?.reason || 'unknown',
            exitCode: Number.isFinite(details?.exitCode) ? details.exitCode : null,
        });
        reelsResourceDiagnostics.stop();
    });
    mainWindow.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
        if (isMainFrame && !isInPlace) {
            log('[RendererLifecycle] main-frame navigation/reload started');
            reelsResourceDiagnostics.recordEvent('navigation', { isInPlace, isMainFrame });
            reelsResourceDiagnostics.update({ open: false, reason: 'close' });
        }
    });
    mainWindow.on('unresponsive', () => {
        log('[RendererLifecycle] window unresponsive');
        reelsResourceDiagnostics.recordEvent('unresponsive');
    });
    mainWindow.on('responsive', () => {
        log('[RendererLifecycle] window responsive');
        reelsResourceDiagnostics.recordEvent('responsive');
    });

    if (!app.isPackaged) {
        const loadPolicy = require('./services/devServerLoadPolicy').createDevServerLoadPolicy(DEV_SERVER_URL);
        const devWindow = mainWindow;
        let retryTimer;
        const loadDevServer = () => {
            if (!devWindow.isDestroyed() && loadPolicy.canRetry) {
                devWindow.loadURL(DEV_SERVER_URL).catch(() => {});
            }
        };
        devWindow.webContents.on('did-fail-load', (_event, errorCode, _errorDescription, validatedURL, isMainFrame) => {
            const action = loadPolicy.failed({ errorCode, validatedURL, isMainFrame });
            const details = { errorCode, isMainFrame, action };
            log(`[RendererLifecycle] did-fail-load ${JSON.stringify(details)}`);
            reelsResourceDiagnostics.recordEvent('load-failed', details);
            if (action === 'retry') {
                clearTimeout(retryTimer);
                retryTimer = setTimeout(loadDevServer, 600);
            } else if (action === 'fallback') {
                clearTimeout(retryTimer);
                const localHtml = path.join(__dirname, '../dist/index.html');
                if (fs.existsSync(localHtml) && !devWindow.isDestroyed()) {
                    log('[RendererLifecycle] dev server unavailable, loading local build once');
                    devWindow.loadFile(localHtml).catch(error => log(`[RendererLifecycle] local build failed: ${error.code || 'unknown'}`));
                }
            }
        });
        devWindow.once('closed', () => clearTimeout(retryTimer));
        loadDevServer();
        mainWindow.webContents.openDevTools();
        mainWindow.webContents.once('did-finish-load', async () => {
            const recovered = await recoverPendingBatchFromTemplates(mainWindow);
            const stylesRecovered = recovered ? false : await recoverPendingStylesFromTemplates(mainWindow);
            const repaired = (recovered || stylesRecovered) ? false : await repairPendingTemplateThumbnails(mainWindow);
            const audited = (!recovered && !stylesRecovered && !repaired) ? await snapshotLegacyBatchForStyleAudit(mainWindow) : false;
            if (!recovered && !stylesRecovered && !repaired && !audited) await migrateLegacyFileStorageToDevOrigin(mainWindow);
            setTimeout(() => logBatchStartupState(mainWindow), 2500);
            setTimeout(() => logBatchStartupState(mainWindow, 'settled'), 12000);
        });

        // ── 开发者热启动与热重载机制 (Hot Reload / Relaunch) ──
        if (!global._isWatching) {
            global._isWatching = true;
            const fs = require('fs');

            // 监听主进程目录 (electron/) 变化 ➔ 自动重启 Electron 应用
            let relaunchTimeout;
            const electronDir = path.join(__dirname);
            fs.watch(electronDir, { recursive: true }, (eventType, filename) => {
                if (filename && (filename.endsWith('.js') || filename.endsWith('.json') || filename.endsWith('.html'))) {
                    clearTimeout(relaunchTimeout);
                    relaunchTimeout = setTimeout(() => {
                        log(`[HotReload] 主进程文件改变: ${filename}，正在重启 Electron...`);
                        app.relaunch();
                        app.exit(0);
                    }, 300);
                }
            });

            // Vite already watches src/ and reloads the renderer. A second
            // watcher here caused duplicate reloads and repeated initialization.
        }
    } else {
        mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
    }

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

// 应用启动
app.whenReady().then(async () => {
    appIsReady = true;
    log('=== App Ready (Node.js Backend) ===');

    protocol.handle('local-media', async (request) => {
        const reqOrigin = request.headers.get('origin');
        if (reqOrigin && reqOrigin !== 'null') {
            const lowerOrigin = reqOrigin.toLowerCase();
            const isLocalOrigin =
                lowerOrigin.startsWith('file:') ||
                lowerOrigin.startsWith('local-media:') ||
                /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(lowerOrigin);
            if (!isLocalOrigin) {
                log(`[local-media] 403 拦截外部网页跨源读取: origin=${reqOrigin}`);
                return new Response('Access Denied', { status: 403 });
            }
        }
        if(request.url.startsWith('local-media://drive-review/'))return require('./services/google-drive-review').media(request);
        // 不用 standard:true → URL 不会被解析为 host/path 格式
        // local-media:///Users/example/file.mp4 → 直接截取 scheme 后的路径
        const afterScheme = request.url.replace(/^local-media:\/\//, '');
        const cleanPath = afterScheme.split('?')[0].split('#')[0];
        let filePath;
        try {
            filePath = decodeURIComponent(cleanPath);
        } catch (_) {
            return new Response('Bad Request', { status: 400 });
        }
        // On Windows, if filePath starts with "/" followed by a drive letter (e.g. "/C:"), remove the leading "/"
        if (process.platform === 'win32' && filePath.startsWith('/') && filePath.includes(':')) {
            filePath = filePath.substring(1);
        }
        const resolved = path.resolve(filePath);

        try {
            // SBP-004: Validate file extension for security
            const allowedExtensions = [
                // Video
                '.mp4', '.webm', '.mkv', '.avi', '.mov', '.flv', '.3gp', '.m4v', '.wmv', '.ts',
                // Audio
                '.wav', '.mp3', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.wma', '.aiff', '.aif', '.amr',
                // Image
                '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.svg', '.ico', '.tiff', '.tif', '.avif',
                // Subtitles/Data
                '.json', '.txt', '.srt', '.vtt', '.fcpxml', '.xml', '.drt', '.zip',
                // Fonts
                '.ttf', '.otf', '.woff', '.woff2'
            ];
            if (!fs.existsSync(resolved)) {
                log(`[local-media] 404 文件不存在: ${resolved} (url=${request.url})`);
                return new Response('Not Found', { status: 404 });
            }

            const realTarget = fs.realpathSync(resolved);
            const ext = path.extname(realTarget).toLowerCase();
            if (!allowedExtensions.includes(ext)) {
                log(`[local-media] 403 扩展名不允许: ${ext} ${realTarget}`);
                return new Response('Access Denied', { status: 403 });
            }

            if (isBlockedSensitiveFilePath(realTarget)) {
                log(`[local-media] 403 敏感文件拦截: ${realTarget}`);
                return new Response('Access Denied', { status: 403 });
            }

            const stat = fs.statSync(realTarget);
            const size = stat.size;
            const mimeTypes = {
                '.mp4': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
                '.avi': 'video/x-msvideo', '.mov': 'video/quicktime', '.flv': 'video/x-flv', '.3gp': 'video/3gpp',
                '.m4v': 'video/mp4', '.wmv': 'video/x-ms-wmv', '.ts': 'video/mp2t',
                '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4',
                '.aac': 'audio/aac', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.opus': 'audio/ogg',
                '.wma': 'audio/x-ms-wma', '.aiff': 'audio/aiff', '.aif': 'audio/aiff', '.amr': 'audio/amr',
                '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
                '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
                '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.tiff': 'image/tiff', '.tif': 'image/tiff', '.avif': 'image/avif',
                '.json': 'application/json', '.txt': 'text/plain; charset=utf-8',
                '.srt': 'application/x-subrip', '.vtt': 'text/vtt', '.xml': 'application/xml',
                '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2',
            };
            const baseHeaders = {
                'Content-Type': mimeTypes[ext] || 'application/octet-stream',
                'Accept-Ranges': 'bytes',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, OPTIONS, HEAD',
                'Access-Control-Allow-Headers': '*',
                'Cache-Control': 'no-cache',
            };
            if (ext === '.svg') {
                baseHeaders['Content-Security-Policy'] = "default-src 'none'; style-src 'unsafe-inline'; img-src data:;";
            }

            if (request.method === 'OPTIONS') {
                return new Response(null, { status: 204, headers: baseHeaders });
            }

            const rangeHeader = request.headers.get('range');
            let start = 0;
            let end = Math.max(0, size - 1);
            let status = 200;
            if (rangeHeader) {
                const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());
                if (!match) {
                    return new Response(null, {
                        status: 416,
                        headers: { ...baseHeaders, 'Content-Range': `bytes */${size}` },
                    });
                }
                if (match[1] === '' && match[2] !== '') {
                    const suffixLength = Math.min(size, parseInt(match[2], 10));
                    start = Math.max(0, size - suffixLength);
                } else {
                    start = parseInt(match[1] || '0', 10);
                    if (match[2] !== '') end = Math.min(end, parseInt(match[2], 10));
                }
                if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start > end || start >= size) {
                    return new Response(null, {
                        status: 416,
                        headers: { ...baseHeaders, 'Content-Range': `bytes */${size}` },
                    });
                }
                status = 206;
            }

            const contentLength = Math.max(0, end - start + 1);
            const headers = {
                ...baseHeaders,
                'Content-Length': String(contentLength),
            };
            if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
            if (request.method === 'HEAD') return new Response(null, { status, headers });

            const nodeStream = fs.createReadStream(realTarget, { start, end });
            return new Response(Readable.toWeb(nodeStream), { status, headers });
        } catch (e) {
            log(`[local-media] 500 ${e.message} ${resolved}`);
            return new Response('Internal Error', { status: 500 });
        }
    });

    // 设置 FFmpeg 环境
    setupFFmpegPath();
    log(`FFmpeg PATH configured`);

    // ==================== IPC 处理 - 基本功能 ====================
    // Clipboard access belongs in the main process; preload may not expose it.
    // Keep the text bridge synchronous for existing boolean-return callers.
    ipcMain.on('clipboard:write-text', (event, text) => {
        try {
            clipboard.writeText(String(text ?? ''));
            event.returnValue = true;
        } catch (error) {
            log(`[clipboard] write text failed: ${error.message}`);
            event.returnValue = false;
        }
    });
    ipcMain.handle('clipboard:write-image', (_event, filePath) => {
        try {
            if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) return false;
            const image = nativeImage.createFromPath(filePath);
            if (image.isEmpty()) return false;
            clipboard.writeImage(image);
            return true;
        } catch (error) {
            log(`[clipboard] write image failed: ${error.message}`);
            return false;
        }
    });
    // 预设先在 preload 同步恢复，确保页面脚本读取 localStorage 前已经拿到
    // 免安装包之间共用的用户目录副本。
    ipcMain.on('persistent-presets:hydrate', (event, values) => {
        try { event.returnValue = { ok: true, values: persistentPresetStore.hydrate(values) }; }
        catch (error) { event.returnValue = { ok: false, error: error.message, values: {} }; }
    });
    ipcMain.handle('persistent-presets:save', async (_event, values) => {
        try { return { ok: true, ...persistentPresetStore.writeSnapshot(values) }; }
        catch (error) { return { ok: false, error: error.message }; }
    });
    ipcMain.on('bulk-create-storage:backup-legacy', (event, key, value) => {
        try { event.returnValue = { ok: true, ...persistentPresetStore.backupBulkCreateLegacy(key, value) }; }
        catch (error) { event.returnValue = { ok: false, error: error.message }; }
    });
    ipcMain.on('bulk-create-storage:read', (event) => {
        try { event.returnValue = { ok: true, values: persistentPresetStore.readBulkCreateStorage() }; }
        catch (error) { event.returnValue = { ok: false, error: error.message }; }
    });
    ipcMain.on('bulk-create-storage:write', (event, key, value) => {
        try { event.returnValue = { ok: true, ...persistentPresetStore.writeBulkCreateStorage(key, value) }; }
        catch (error) { event.returnValue = { ok: false, error: error.message }; }
    });
    ipcMain.handle('preset-folder:info', async () => {
        try { return { ok: true, ...persistentPresetStore.presetFolderLibrary.info() }; }
        catch (error) { return { ok: false, error: error.message }; }
    });
    ipcMain.handle('preset-folder:select', async () => {
        const result = await dialog.showOpenDialog(mainWindow, { title: '选择固定读取与保存的个人预设文件夹', properties: ['openDirectory', 'createDirectory'] });
        if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
        try { return { ok: true, ...persistentPresetStore.presetFolderLibrary.select(result.filePaths[0]) }; }
        catch (error) { return { ok: false, error: error.message }; }
    });
    ipcMain.on('brush-presets:read', (event) => {
        try { event.returnValue = { ok: true, presets: persistentPresetStore.readBrushPresets() }; }
        catch (error) { event.returnValue = { ok: false, error: error.message }; }
    });
    ipcMain.on('brush-presets:write', (event, presets) => {
        try { event.returnValue = { ok: true, ...persistentPresetStore.writeBrushPresets(presets) }; }
        catch (error) { event.returnValue = { ok: false, error: error.message }; }
    });
    ipcMain.on('overlay-group-presets:read', (event) => {
        try { event.returnValue = { ok: true, presets: persistentPresetStore.readOverlayGroupPresets() }; }
        catch (error) { event.returnValue = { ok: false, error: error.message, presets: {} }; }
    });
    ipcMain.on('overlay-group-presets:write', (event, presets) => {
        try { event.returnValue = { ok: true, ...persistentPresetStore.writeOverlayGroupPresets(presets) }; }
        catch (error) { event.returnValue = { ok: false, error: error.message }; }
    });
    ipcMain.on('title-color-presets:read', (event) => {
        try { event.returnValue = { ok: true, presets: persistentPresetStore.readTitleColorPresets() }; }
        catch (error) { event.returnValue = { ok: false, error: error.message, presets: {} }; }
    });
    ipcMain.on('title-color-presets:write', (event, presets) => {
        try { event.returnValue = { ok: true, ...persistentPresetStore.writeTitleColorPresets(presets) }; }
        catch (error) { event.returnValue = { ok: false, error: error.message }; }
    });
    ipcMain.on('preset-library:info', (event) => {
        try { event.returnValue = { ok: true, ...persistentPresetStore.libraryInfo() }; }
        catch (error) { event.returnValue = { ok: false, error: error.message }; }
    });
    ipcMain.handle('preset-library:export', async () => {
        try {
            const bundle = persistentPresetStore.presetFolderLibrary.exportLibraryBundle();
            const ver = bundle.libraryVersion || 'export';
            const result = await dialog.showSaveDialog(mainWindow, { title: '导出预设库', defaultPath: `VideoKit预设库_${ver}.json`, filters: [{ name: 'JSON', extensions: ['json'] }] });
            if (result.canceled || !result.filePath) return { ok: false, canceled: true };
            fs.writeFileSync(result.filePath, JSON.stringify(bundle, null, 2), 'utf8');
            return { ok: true, path: result.filePath };
        } catch (error) { return { ok: false, error: error.message }; }
    });
    ipcMain.handle('preset-library:import', async () => {
        try {
            const result = await dialog.showOpenDialog(mainWindow, { title: '导入预设库（将替换当前预设库，旧版自动存档）', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
            if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
            const bundle = JSON.parse(fs.readFileSync(result.filePaths[0], 'utf8'));
            return { ok: true, ...persistentPresetStore.presetFolderLibrary.importLibraryBundle(bundle) };
        } catch (error) { return { ok: false, error: error.message }; }
    });
    ipcMain.handle('preset-library:unhide', async () => {
        try { return { ok: true, ...persistentPresetStore.unhideLibraryPresets() }; }
        catch (error) { return { ok: false, error: error.message }; }
    });
    ipcMain.on('subtitle-presets:read', (event) => {
        try { event.returnValue = { ok: true, presets: persistentPresetStore.readSubtitlePresets() }; }
        catch (error) { event.returnValue = { ok: false, error: error.message, presets: {} }; }
    });
    ipcMain.on('subtitle-presets:write', (event, presets) => {
        try { event.returnValue = { ok: true, ...persistentPresetStore.writeSubtitlePresets(presets) }; }
        catch (error) { event.returnValue = { ok: false, error: error.message }; }
    });
    ipcMain.handle('export-overlay-preset-package', async (_event, presets) => {
        const result = await dialog.showSaveDialog(mainWindow, { title: '导出含媒体的覆层预设包', defaultPath: `overlay_presets_${Date.now()}.zip`, filters: [{ name: 'VideoKit 预设包', extensions: ['zip'] }] });
        if (result.canceled || !result.filePath) return { ok: false, canceled: true };
        try { return { ok: true, ...(await overlayPresetPackage.exportPackage({ presets, outputPath: result.filePath })), path: result.filePath }; }
        catch (error) { return { ok: false, error: error.message }; }
    });
    ipcMain.handle('import-overlay-preset-package', async (_event, packagePath) => {
        try { return { ok: true, ...(await overlayPresetPackage.importPackage({ packagePath, destinationDir: path.join(persistentPresetStore.presetFolderLibrary.root(), '媒体素材', 'imported-overlay-assets') })) }; }
        catch (error) { return { ok: false, error: error.message }; }
    });
    ipcMain.handle('save-overlay-preset-assets', async (_event, preset) => {
        try { return { ok: true, ...(await overlayPresetPackage.savePresetAssets({ preset, destinationDir: path.join(persistentPresetStore.presetFolderLibrary.root(), '媒体素材', 'saved-overlay-assets') })) }; }
        catch (error) { return { ok: false, error: error.message }; }
    });

    ipcMain.handle('get-app-version', () => {
        return app.getVersion();
    });

    ipcMain.handle('select-directory', async () => {
        const result = await dialog.showOpenDialog(mainWindow, {
            properties: ['openDirectory', 'createDirectory'],
            title: '选择输出目录'
        });
        if (!result.canceled && result.filePaths.length > 0) {
            return result.filePaths[0];
        }
        return null;
    });

    ipcMain.handle('select-directories', async () => {
        const result = await dialog.showOpenDialog(mainWindow, {
            properties: ['openDirectory', 'multiSelections'],
            title: '选择多个视频文件夹（每个文件夹创建一个任务）'
        });
        return !result.canceled ? result.filePaths : [];
    });

    // 批量创建等页面需要根据场景选择文件或文件夹，并保留取消状态。
    // 仅转发受支持的对话框配置，避免渲染进程直接接触 Electron dialog。
    ipcMain.handle('show-open-dialog', async (_event, options = {}) => {
        const dialogOpts = {
            title: typeof options.title === 'string' ? options.title : '选择文件',
            properties: Array.isArray(options.properties) && options.properties.length
                ? options.properties
                : ['openFile'],
        };
        if (typeof options.defaultPath === 'string') dialogOpts.defaultPath = options.defaultPath;
        if (Array.isArray(options.filters)) dialogOpts.filters = options.filters;
        return dialog.showOpenDialog(mainWindow, dialogOpts);
    });

    ipcMain.handle('select-files', async (event, options = {}) => {
        const props = options.properties || ['openFile'];
        if (options.multiple !== false && !props.includes('multiSelections')) props.push('multiSelections');
        const dialogOpts = {
            properties: props,
            title: options.title || '选择文件',
        };
        if (options.defaultPath) dialogOpts.defaultPath = options.defaultPath;
        if (options.filters) dialogOpts.filters = options.filters;
        const result = await dialog.showOpenDialog(mainWindow, dialogOpts);
        if (!result.canceled && result.filePaths.length > 0) {
            return result.filePaths;
        }
        return null;
    });

    ipcMain.handle('save-file', async (_event, options = {}) => {
        const dialogOpts = {
            title: options.title || '保存文件',
        };
        if (options.defaultPath) dialogOpts.defaultPath = options.defaultPath;
        if (options.filters) dialogOpts.filters = options.filters;
        const result = await dialog.showSaveDialog(mainWindow, dialogOpts);
        if (result.canceled || !result.filePath) {
            return { success: false, canceled: true };
        }
        if (typeof options.content === 'string' || Buffer.isBuffer(options.content)) {
            const fs = require('fs');
            await fs.promises.writeFile(result.filePath, options.content);
        }
        return { success: true, filePath: result.filePath };
    });

    ipcMain.handle('scan-directory', async (event, dirPath) => {
        const fs = require('fs');
        const pathModule = require('path');
        try {
            if (!dirPath || !fs.existsSync(dirPath)) return [];
            const entries = fs.readdirSync(dirPath, { withFileTypes: true });
            const files = [];
            for (const entry of entries) {
                if (!entry.name.startsWith('.')) {
                    const fullPath = pathModule.join(dirPath, entry.name);
                    try {
                        const stat = fs.statSync(fullPath);
                        files.push({
                            name: entry.name,
                            path: fullPath,
                            size: stat.size,
                            mtime: stat.mtimeMs,
                            isDirectory: stat.isDirectory()
                        });
                    } catch { /* skip unreadable files */ }
                }
            }
            return files;
        } catch (e) {
            console.error('scan-directory error:', e);
            return [];
        }
    });

    // ==================== 本地多窗口整理与文件分拣 ====================
    try {
        const { registerLocalOrganizer } = require('./localOrganizerService');
        registerLocalOrganizer(ipcMain, () => mainWindow);
        log('LocalOrganizerService registered successfully');
    } catch (err) {
        console.error('[Main] Failed to register localOrganizerService:', err);
    }

    // Recursively scan source media while keeping every descendant attached to
    // the selected top-level task folder. Generated output/backup directories
    // are excluded so a later rescan cannot import finished videos as sources.
    ipcMain.handle('scan-directory-recursive', async (event, dirPath, options = {}) => {
        const fs = require('fs');
        const pathModule = require('path');
        const maxDepth = Math.max(0, Math.min(50, Number(options.maxDepth) || 20));
        const excludedNames = new Set((options.excludedNames || ['_auto_edit', 'backup_clips', '已排除素材', '已排除'])
            .map(name => String(name || '').toLocaleLowerCase()).filter(Boolean));
        // 审核记录保存在“审核批次_时间”目录，且其中通常有移动后的不合格素材；
        // 它只供 visual-review-load 读取 review.json，绝不能再次混入素材扫描。
        const isReviewBatchDir = name => String(name || '').toLocaleLowerCase().startsWith('审核批次');
        const files = [];
        if (!dirPath || !fs.existsSync(dirPath)) return files;

        function walk(currentDir, depth) {
            if (depth > maxDepth) return;
            let entries = [];
            try { entries = fs.readdirSync(currentDir, { withFileTypes: true }); } catch (error) {
                if(options.throwOnError && error.code!=='ENOENT')throw error;
                return;
            }
            for (const entry of entries) {
                if (entry.name.startsWith('.')) continue;
                const fullPath = pathModule.join(currentDir, entry.name);
                if (entry.isSymbolicLink()) continue;
                if (entry.isDirectory()) {
                    if (!excludedNames.has(entry.name.toLocaleLowerCase()) && !isReviewBatchDir(entry.name)) walk(fullPath, depth + 1);
                    continue;
                }
                if (!entry.isFile()) continue;
                try {
                    const stat = fs.statSync(fullPath);
                    files.push({
                        name: entry.name,
                        path: fullPath,
                        relativePath: pathModule.relative(dirPath, fullPath),
                        size: stat.size,
                        mtime: stat.mtimeMs,
                        isDirectory: false,
                    });
                } catch (error) { if(options.throwOnError && error.code!=='ENOENT')throw error; }
            }
        }
        walk(dirPath, 0);
        return files;
    });

    // IPC: 递归搜索指定文件名（查找素材功能）
    ipcMain.handle('search-files-recursive', async (event, searchDir, fileNames, maxDepth = 5, allCandidates = false) => {
        const result = new Map();
        const targetSet = new Set(fileNames.map(n => n.toLowerCase()));

        function walk(dir, depth) {
            if (depth > maxDepth) return;
            let entries;
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
            for (const entry of entries) {
                if (entry.name.startsWith('.')) continue;
                const fullPath = path.join(dir, entry.name);
                if (entry.isFile()) {
                    const lower = entry.name.toLowerCase();
                    if (targetSet.has(lower) && (allCandidates || !result.has(lower))) {
                        if (allCandidates) {
                            if (!result.has(lower)) result.set(lower, []);
                            result.get(lower).push(fullPath);
                        } else result.set(lower, fullPath);
                        if (!allCandidates && result.size >= targetSet.size) return;
                    }
                } else if (entry.isDirectory()) {
                    walk(fullPath, depth + 1);
                    if (!allCandidates && result.size >= targetSet.size) return;
                }
            }
        }

        walk(searchDir, 0);
        const obj = {};
        for (const [k, v] of result) obj[k] = v;
        return obj;
    });

    // IPC: 批量检查文件是否存在
    ipcMain.handle('check-files-exist', async (event, filePaths) => {
        const results = {};
        for (const p of filePaths) {
            try { results[p] = fs.existsSync(p); } catch (_) { results[p] = false; }
        }
        return results;
    });

    ipcMain.handle('get-downloads-path', async () => {
        try {
            return app.getPath('downloads');
        } catch (e) {
            return null;
        }
    });

    // IPC: 批量Reels - 烧录字幕到视频
    ipcMain.handle('burn-subtitles', async (event, { videoPath, assContent, outputPath, crf, useGPU }) => {
        const { execFile, spawnSync } = require('child_process');
        const settingsService = require('./services/settings');
        const assPath = settingsService.secureTmpFile('reels_sub', '.ass');

        if (!outputPath) throw new Error('缺少输出路径');
        assertSafeFileMutation(outputPath);
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });

        // Write ASS content to temp file
        fs.writeFileSync(assPath, assContent, 'utf-8');
        log(`[Reels] Burning subtitles: ${videoPath} → ${outputPath}`);

        return new Promise((resolve, reject) => {
            const ffmpegBin = ffmpegService.resolveCommand ? ffmpegService.resolveCommand('ffmpeg') : 'ffmpeg';
            const platform = process.platform;
            let vcodec = 'libx264';
            let encoderArgs = ['-crf', String(crf || 23), '-preset', 'medium'];

            if (useGPU) {
                if (platform === 'darwin') {
                    vcodec = 'h264_videotoolbox';
                    encoderArgs = ['-b:v', '8M'];
                } else if (platform === 'win32') {
                    const candidates = [
                        { codec: 'h264_nvenc', args: ['-preset', 'p4', '-cq', String(crf || 23), '-b:v', '0'] },
                        { codec: 'h264_amf', args: ['-quality', 'balanced', '-rc', 'cqp', '-qp_i', String(crf || 23), '-qp_p', String(crf || 23)] },
                        { codec: 'h264_qsv', args: ['-global_quality', String(crf || 23)] },
                    ];
                    for (const enc of candidates) {
                        const probe = spawnSync(ffmpegBin, [
                            '-y', '-f', 'lavfi', '-i', 'color=c=black:s=256x256:d=0.1',
                            '-c:v', enc.codec, '-frames:v', '1', '-f', 'null', '-'
                        ], { timeout: 10000, stdio: ['ignore', 'ignore', 'pipe'] });
                        if (probe.status === 0) {
                            vcodec = enc.codec;
                            encoderArgs = enc.args;
                            log(`[Reels] burn-subtitles GPU encoder: ${enc.codec}`);
                            break;
                        }
                    }
                }
            }

            const args = [
                '-i', videoPath,
                '-vf', `ass='${ffmpegService.escapeAssPathForFilter(assPath)}'`,
                '-c:a', 'copy',
                '-c:v', vcodec,
                ...encoderArgs,
                '-y',
                outputPath
            ];
            execFile(ffmpegBin, args, { maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
                // Clean up temp ASS file
                try { fs.unlinkSync(assPath); } catch (e) { /* ignore */ }
                if (err) {
                    log(`[Reels] FFmpeg error: ${stderr}`);
                    reject(new Error(ffmpegService.formatMediaError(stderr || err.message, {
                        action: '字幕烧录',
                        code: err.code,
                    })));
                } else {
                    log(`[Reels] Export done: ${outputPath}`);
                    resolve({ success: true, outputPath });
                }
            });
        });
    });

    // IPC: 批量Reels - 合成背景+配音+字幕（直连通道，避免依赖 apiRouter 路由版本）
    ipcMain.handle('reels-compose', async (event, payload) => {
        const data = payload || {};
        if (!data.background_path) throw new Error('缺少背景素材路径');
        if (!data.voice_path) throw new Error('缺少配音音频路径');
        if (!data.ass_content) throw new Error('缺少 ASS 字幕内容');
        if (!data.output_path) throw new Error('缺少输出路径');
        const res = await ffmpegService.composeReel({
            backgroundPath: data.background_path,
            voicePath: data.voice_path,
            assContent: data.ass_content,
            outputPath: data.output_path,
            crf: parseInt(data.crf || 23, 10),
            useGPU: data.use_gpu === true,
            loopFade: data.loop_fade !== false,
            loopFadeDur: parseFloat(data.loop_fade_dur ?? 1.0),
            voiceVolume: parseFloat(data.voice_volume ?? 1.0),
            bgVolume: parseFloat(data.bg_volume ?? 0.0),
            bgmPath: data.bgm_path || '',
            bgmVolume: parseFloat(data.bgm_volume ?? 0),
            bgmStart: Math.max(0, parseFloat(data.bgm_start ?? 0) || 0),
        });
        return { success: true, data: res };
    });

    // IPC: WYSIWYG 逐帧渲染导出（与 Canvas 预览 100% 一致）
    const { handleWysiwygIPC, attachFramePipeline, parallelExport } = require('./services/ffmpeg-rawvideo');
    ipcMain.handle('reels-compose-wysiwyg', async (event, action, data) => {
        const result = await handleWysiwygIPC(action, data);
        // 隐藏 renderer 若被系统终止，确保它启动的 FFmpeg 会话也被回收。
        if (action === 'start' && typeof result === 'string') {
            const sessionId = result;
            event.sender.once('destroyed', () => {
                handleWysiwygIPC('abort', { sessionId }).catch(() => {});
            });
        }
        return result;
    });
    // IPC: ⚡ 新极速（实验）导出 —— 独立引擎，渲染端 WebCodecs 硬件编码，主进程只负责封装+混音
    ipcMain.handle('reels-turbo-export', async (event, action, data) => {
        const { handleTurboIPC } = require('./services/turbo-export');
        const result = await handleTurboIPC(action, data);
        if (action === 'begin' && result && result.sessionId) {
            event.sender.once('destroyed', () => {
                handleTurboIPC('abort', { sessionId: result.sessionId }).catch(() => {});
            });
        }
        return result;
    });
    // Reels 插入素材：只分析本地音轨停顿，不调用外部 AI 服务。
    ipcMain.handle('reels-detect-silence', async (event, data = {}) => {
        if (!data.filePath) throw new Error('缺少待检测的音视频文件');
        return ffmpegService.detectSilence(data.filePath, Number(data.noiseDb ?? -35), Number(data.minDuration ?? .35));
    });
    ipcMain.on('reels-frame-pipeline-open', (event, data = {}) => {
        const { port1, port2 } = new MessageChannelMain();
        const result = attachFramePipeline(data.sessionId, port1);
        try {
            event.sender.postMessage('reels-frame-pipeline-ready', {
                requestId: data.requestId,
                ...result,
            }, [port2]);
        } catch (err) {
            try { port1.close(); port2.close(); } catch (_) { }
            console.warn('[WYSIWYG] 无法建立帧流水线:', err.message);
        }
    });

    // IPC: 并行影子窗口导出（V3 多切片渲染）
    ipcMain.handle('parallel-wysiwyg-export', async (event, opts) => {
        return parallelExport(opts, mainWindow);
    });
    ipcMain.handle('get-latest-crash-diagnostic', () => getLatestRendererCrashReport());
    ipcMain.on('reels-overview-resources', (event, payload) => {
        if (mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents) {
            reelsResourceDiagnostics.update(payload || {});
        }
    });

    // 每个队列任务使用一次性隐藏 renderer。任务完成后销毁窗口，Chromium 会把
    // 该任务的 Canvas、图片与媒体解码缓存整体归还，不再累积到主界面进程。
    ipcMain.handle('isolated-wysiwyg-export', async (event, opts = {}) => {
        const requestId = String(opts.requestId || `isolated-${Date.now()}`);
        if (isolatedReelsRenderers.has(requestId)) throw new Error('后台渲染任务 ID 重复');
        const owner = event.sender;
        const htmlPath = path.join(__dirname, 'isolated-wysiwyg-renderer.html');
        const scriptBase = app.isPackaged
            ? path.join(__dirname, '..', 'dist')
            : path.join(__dirname, '..', 'src');
        const scriptPaths = [
            'reels-text-direction.js',
            'reels-anim-engine.js',
            'reels-rich-text.js',
            'reels-canvas-renderer.js',
            'reels-subtitle-upgrade-renderer.js',
            'reels-media-window.js',
            'reels-overlay.js',
            'reels-divider-presets.js',
            'fonts-metadata.js',
            'reels-font-manager.js',
            'reels-wysiwyg-export.js',
            'reels-turbo-planner.js',
            'reels-turbo-decoder.js',
            'reels-turbo-export.js',
        ].map(name => path.join(scriptBase, name));

        return new Promise((resolve, reject) => {
            const win = new BrowserWindow({
                show: false,
                width: 160,
                height: 160,
                webPreferences: {
                    nodeIntegration: true,
                    contextIsolation: false,
                    backgroundThrottling: false,
                    webSecurity: false,
                },
            });
            hardenPrivilegedWindowNavigation(win);
            isolatedReelsRenderers.set(requestId, win);
            let settled = false;
            const timeout = setTimeout(() => finish(new Error('后台渲染任务超时（60 分钟）')), 60 * 60 * 1000);

            const removeListeners = () => {
                ipcMain.removeListener('isolated-wysiwyg-ready', onReady);
                ipcMain.removeListener('isolated-wysiwyg-progress', onProgress);
                ipcMain.removeListener('isolated-wysiwyg-log', onLog);
                ipcMain.removeListener('isolated-wysiwyg-result', onResult);
            };
            const finish = (error, result) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                removeListeners();
                isolatedReelsRenderers.delete(requestId);
                if (!win.isDestroyed()) win.destroy();
                if (error) reject(error);
                else resolve(result);
            };
            const fromThisWindow = ipcEvent => ipcEvent.sender === win.webContents;
            const onReady = ipcEvent => {
                if (!fromThisWindow(ipcEvent)) return;
                win.webContents.send('isolated-wysiwyg-run', {
                    requestId,
                    params: opts.params || {},
                    scriptPaths,
                });
            };
            const onProgress = (ipcEvent, data = {}) => {
                if (!fromThisWindow(ipcEvent)) return;
                if (!owner.isDestroyed()) owner.send('isolated-wysiwyg-progress', { requestId, ...data });
            };
            const onLog = (ipcEvent, data = {}) => {
                if (!fromThisWindow(ipcEvent)) return;
                log(`[IsolatedReels:${requestId}] ${String(data.message || '')}`);
            };
            const onResult = (ipcEvent, data = {}) => {
                if (!fromThisWindow(ipcEvent)) return;
                if (data.success) finish(null, data.result || {});
                else finish(new Error(data.error || '后台渲染失败'));
            };
            ipcMain.on('isolated-wysiwyg-ready', onReady);
            ipcMain.on('isolated-wysiwyg-progress', onProgress);
            ipcMain.on('isolated-wysiwyg-log', onLog);
            ipcMain.on('isolated-wysiwyg-result', onResult);
            win.webContents.once('render-process-gone', (_goneEvent, details = {}) => {
                if (settled) return;
                const report = writeRendererCrashReport({
                    process: 'isolated-reels-renderer',
                    reason: details.reason || 'unknown',
                    exitCode: Number.isFinite(details.exitCode) ? details.exitCode : null,
                });
                if (report && !owner.isDestroyed()) owner.send('reels-crash-diagnostic', report);
                finish(new Error(`后台渲染进程异常退出：${details.reason || 'unknown'}`));
            });
            win.loadFile(htmlPath).catch(error => finish(error));
        });
    });
    ipcMain.on('cancel-isolated-wysiwyg-export', (_event, requestId) => {
        const win = isolatedReelsRenderers.get(String(requestId || ''));
        if (win && !win.isDestroyed()) win.webContents.send('isolated-wysiwyg-cancel');
    });

    // IPC: 视频首尾拼接 (Hook -> Main)
    ipcMain.handle('concat-video', async (event, payload) => {
        return ffmpegService.concatVideo(payload);
    });

    // IPC: 保存 Web Audio 离线渲染的音频（WYSIWYG 混音）
    ipcMain.handle('save-rendered-audio', async (event, wavData) => {
        const settingsService = require('./services/settings');
        const tmpPath = settingsService.secureTmpFile('reels_rendered_audio', '.wav');
        const buffer = Buffer.from(wavData);
        fs.writeFileSync(tmpPath, buffer);
        log(`[WYSIWYG] 保存预渲染音频: ${tmpPath} (${(buffer.length / 1024 / 1024).toFixed(1)}MB)`);
        return tmpPath;
    });

    // IPC: 保存 PNG 帧（分层 PNG 序列导出用）
    ipcMain.handle('save-png-frame', async (event, { outputPath: pngPath, rawRGBA, width, height, isPng }) => {
        try {
            if (!pngPath || typeof pngPath !== 'string' || path.extname(pngPath).toLowerCase() !== '.png' || isBlockedSensitiveFilePath(pngPath)) {
                return { ok: false, error: '安全策略拦截：非法的 PNG 输出路径' };
            }
            // 已经是 PNG 数据，直接写入
            if (isPng) {
                fs.writeFileSync(pngPath, Buffer.from(rawRGBA));
                return { ok: true };
            }

            // Raw RGBA → PNG 转换
            try {
                const { PNG } = require('pngjs');
                const png = new PNG({ width, height });
                const buf = Buffer.from(rawRGBA);
                buf.copy(png.data);
                const pngBuffer = PNG.sync.write(png);
                fs.writeFileSync(pngPath, pngBuffer);
                return { ok: true };
            } catch (e) {
                // Fallback: use FFmpeg to convert raw RGBA to PNG
                const settingsService = require('./services/settings');
                const tmpRaw = settingsService.secureTmpFile('frame_raw', '.rgba');
                fs.writeFileSync(tmpRaw, Buffer.from(rawRGBA));
                const ffmpeg = ffmpegService.resolveCommand('ffmpeg');
                const { spawnSync } = require('child_process');
                const result = spawnSync(ffmpeg, [
                    '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba',
                    '-s', `${width}x${height}`,
                    '-i', tmpRaw,
                    '-frames:v', '1',
                    pngPath
                ], { timeout: 10000 });
                try { fs.unlinkSync(tmpRaw); } catch (_) { }
                if (result.status === 0) return { ok: true };
                const stderr = result.stderr?.toString() || '';
                log(`[Layers] PNG 帧转换失败 (code=${result.status}): ${stderr}`);
                return {
                    ok: false,
                    error: ffmpegService.formatMediaError(stderr, {
                        action: 'PNG 帧转换',
                        code: result.status,
                    }),
                };
            }
        } catch (e) {
            return { ok: false, error: e.message };
        }
    });

    // IPC: 导出音频为 MP3（分层 PNG 序列导出用）
    ipcMain.handle('export-audio-mp3', async (event, { inputPath, outputPath: mp3Path, volume, startTime = 0 }) => {
        if (!inputPath || !fs.existsSync(inputPath)) {
            return { ok: false, error: `音频文件不存在或已被移动，请重新选择：${inputPath || '未选择文件'}` };
        }
        try {
            assertSafeFileMutation(mp3Path);
        } catch (err) {
            return { ok: false, error: err.message };
        }
        const ffmpeg = ffmpegService.resolveCommand('ffmpeg');
        const { spawnSync } = require('child_process');
        const args = ['-y'];
        if (Number(startTime) > 0) args.push('-ss', Number(startTime).toFixed(3));
        args.push('-i', inputPath);
        const numVol = Number(volume);
        if (volume != null && Number.isFinite(numVol) && numVol !== 1.0) {
            const clampedVol = Math.max(0, Math.min(20, numVol));
            args.push('-af', `volume=${clampedVol}`);
        }
        args.push('-c:a', 'libmp3lame', '-b:a', '192k', mp3Path);
        const result = spawnSync(ffmpeg, args, { timeout: 120000 });
        if (result.status !== 0) {
            const stderr = result.stderr?.toString() || result.error?.message || '';
            log(`[Layers] MP3 导出失败 (code=${result.status}): ${stderr}`);
            return {
                ok: false,
                error: ffmpegService.formatMediaError(stderr, {
                    action: 'MP3 音频导出',
                    code: result.status,
                    missingLabel: '音频文件',
                }),
            };
        }
        log(`[Layers] 音频导出: ${mp3Path}`);
        return { ok: true, path: mp3Path };
    });

    // IPC: 确保目录存在
    ipcMain.handle('ensure-directory', async (event, dirPath) => {
        try {
            if (!dirPath || typeof dirPath !== 'string' || isBlockedSensitiveFilePath(dirPath)) {
                return { ok: false, error: '安全策略拦截：受保护目录不允许创建或修改' };
            }
            if (!fs.existsSync(dirPath)) {
                fs.mkdirSync(dirPath, { recursive: true });
            }
            return { ok: true };
        } catch (e) {
            return { ok: false, error: e.message };
        }
    });

    // 将文案自动剪辑的“可二剪工程”整理到成片旁。只复制，不移动或删除原文件；
    // 重复执行会更新同名工程文件夹，避免用户在多个目录里找素材。
    ipcMain.handle('collect-reels-project-assets', async (event, payload = {}) => {
        const outputPath = String(payload.outputPath || '');
        if (!outputPath || !path.isAbsolute(outputPath)) return { ok: false, error: '缺少有效的成片路径' };
        if (isBlockedSensitiveFilePath(outputPath)) return { ok: false, error: '安全策略拦截：受保护路径不允许作为工程目录' };
        const outputDir = path.dirname(outputPath);
        const baseName = path.basename(outputPath, path.extname(outputPath)) || '成片';
        const projectDir = path.join(outputDir, `${baseName}-工程`);
        if (isBlockedSensitiveFilePath(projectDir)) return { ok: false, error: '安全策略拦截：受保护路径不允许写入' };
        // 主成片放在工程包根目录，双击就能看到；其余辅助材料再按类型收纳。
        const roleDirs = { output: '', derived: '关联成片和音频', subtitle: '字幕', reels: 'Reels工程', analysis: '自动剪辑分析', source: '原始片段' };
        const assets = Array.isArray(payload.assets) ? payload.assets : [];
        const copied = [];
        const missing = [];
        const usedTargets = new Set();
        const safeName = value => String(value || '').replace(/[\\/:*?"<>|]/g, '_');
        try {
            await fs.promises.mkdir(projectDir, { recursive: true });
            for (let index = 0; index < assets.length; index++) {
                const asset = assets[index] || {};
                const sourcePath = String(asset.path || '');
                if (!sourcePath || !path.isAbsolute(sourcePath)) continue;
                if (isBlockedSensitiveFilePath(sourcePath)) continue;
                const role = Object.prototype.hasOwnProperty.call(roleDirs, asset.role) ? asset.role : 'source';
                if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
                    missing.push({ role, path: sourcePath });
                    continue;
                }
                const targetDir = roleDirs[role] ? path.join(projectDir, roleDirs[role]) : projectDir;
                await fs.promises.mkdir(targetDir, { recursive: true });
                const originalName = safeName(path.basename(sourcePath)) || `素材_${index + 1}`;
                let targetName = originalName;
                let suffix = 2;
                while (usedTargets.has(path.join(targetDir, targetName))) {
                    const ext = path.extname(originalName);
                    targetName = `${path.basename(originalName, ext)}_${suffix++}${ext}`;
                }
                const targetPath = path.join(targetDir, targetName);
                usedTargets.add(targetPath);
                await fs.promises.copyFile(sourcePath, targetPath);
                copied.push({ role, sourcePath, path: targetPath });
            }
            const manifest = {
                version: 1,
                createdAt: new Date().toISOString(),
                sourceOutputPath: outputPath,
                copied,
                missing,
                note: '这是可二剪工程包。原始文件未被移动或删除。',
            };
            const scriptText = String(payload.scriptText || '');
            await fs.promises.writeFile(path.join(projectDir, '文案.txt'), scriptText, 'utf8');
            await fs.promises.writeFile(path.join(projectDir, '工程清单.json'), JSON.stringify(manifest, null, 2), 'utf8');
            return { ok: true, complete: missing.length === 0, projectDir, copied, missing };
        } catch (error) {
            return { ok: false, error: error.message || String(error), projectDir, copied, missing };
        }
    });

    // Reels 最终导出可选择在最终成片旁再复制一份工程包。只复制，不移动源工程；
    // 这样既保留自动剪辑输出处的原工程，也方便把成片和二剪资料一起交付或归档。
    ipcMain.handle('copy-reels-project-package', async (event, payload = {}) => {
        const sourceProjectDir = String(payload.sourceProjectDir || '');
        const outputPath = String(payload.outputPath || '');
        if (!sourceProjectDir || !path.isAbsolute(sourceProjectDir) || isBlockedSensitiveFilePath(sourceProjectDir) || !fs.existsSync(sourceProjectDir) || !fs.statSync(sourceProjectDir).isDirectory()) {
            return { ok: false, error: '原工程文件夹不存在' };
        }
        if (!outputPath || !path.isAbsolute(outputPath) || isBlockedSensitiveFilePath(outputPath)) return { ok: false, error: '缺少有效的最终成片路径' };
        const baseName = path.basename(outputPath, path.extname(outputPath)) || '成片';
        const targetProjectDir = path.join(path.dirname(outputPath), `${baseName}-工程`);
        if (isBlockedSensitiveFilePath(targetProjectDir)) return { ok: false, error: '安全策略拦截：受保护路径不允许写入' };
        try {
            const sourceResolved = await fs.promises.realpath(sourceProjectDir);
            const targetResolved = path.resolve(targetProjectDir);
            if (sourceResolved !== targetResolved) {
                await fs.promises.mkdir(targetProjectDir, { recursive: true });
                await fs.promises.cp(sourceProjectDir, targetProjectDir, { recursive: true, force: true });
            }
            const overlayAssets = Array.isArray(payload.overlayAssets) ? payload.overlayAssets : [];
            const overlayDir = path.join(targetProjectDir, '覆层素材');
            const overlayPathMap = new Map();
            const usedOverlayNames = new Set();
            for (const sourcePath of overlayAssets) {
                if (!sourcePath || !path.isAbsolute(sourcePath) || isBlockedSensitiveFilePath(sourcePath) || !fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) continue;
                await fs.promises.mkdir(overlayDir, { recursive: true });
                const sourceName = path.basename(sourcePath).replace(/[\\/:*?"<>|]/g, '_') || '覆层素材';
                const ext = path.extname(sourceName);
                const stem = path.basename(sourceName, ext);
                let targetName = sourceName;
                let sequence = 2;
                while (usedOverlayNames.has(targetName)) targetName = `${stem}_${sequence++}${ext}`;
                usedOverlayNames.add(targetName);
                const targetPath = path.join(overlayDir, targetName);
                await fs.promises.copyFile(sourcePath, targetPath);
                overlayPathMap.set(sourcePath, targetPath);
            }
            // 旧工程包可能在“分析文件自动收集”上线前创建。仅打包时仍要从
            // 当前任务记录的原始路径补齐分析工程/报告，不能只相信源工程夹。
            const analysisAssets = Array.isArray(payload.analysisAssets) ? payload.analysisAssets : [];
            const analysisDir = path.join(targetProjectDir, '自动剪辑分析');
            const portablePathMap = new Map();
            const originalDir = path.join(targetProjectDir, '原始片段');
            const usedOriginalNames = new Set();
            for (const sourcePath of (Array.isArray(payload.originalClips) ? payload.originalClips : [])) {
                if (!sourcePath || !path.isAbsolute(sourcePath) || isBlockedSensitiveFilePath(sourcePath) || !fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) continue;
                await fs.promises.mkdir(originalDir, { recursive: true });
                const sourceName = path.basename(sourcePath);
                const ext = path.extname(sourceName);
                const stem = path.basename(sourceName, ext);
                let targetName = sourceName;
                let sequence = 2;
                while (usedOriginalNames.has(targetName)) targetName = `${stem}_${sequence++}${ext}`;
                usedOriginalNames.add(targetName);
                const targetPath = path.join(originalDir, targetName);
                await fs.promises.copyFile(sourcePath, targetPath);
                portablePathMap.set(sourcePath, targetPath);
            }
            for (const sourcePath of analysisAssets) {
                if (!sourcePath || !path.isAbsolute(sourcePath) || isBlockedSensitiveFilePath(sourcePath) || !fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) continue;
                await fs.promises.mkdir(analysisDir, { recursive: true });
                await fs.promises.copyFile(sourcePath, path.join(analysisDir, path.basename(sourcePath)));
            }
            // 一次自动剪辑的每片段转录 txt/json 都在 auto_edit_… 输出目录中。
            // 打包必须带上整个分析目录，不能只抽取总工程 JSON，否则无法回看
            // 单片段的识别证据。已独立收集的“成片名-工程”子目录不再嵌套复制。
            const analysisOutputDir = String(payload.analysisOutputDir || '');
            let analysisTargetDir = '';
            if (analysisOutputDir && path.isAbsolute(analysisOutputDir) && !isBlockedSensitiveFilePath(analysisOutputDir) && fs.existsSync(analysisOutputDir) && fs.statSync(analysisOutputDir).isDirectory()) {
                analysisTargetDir = path.join(analysisDir, path.basename(path.resolve(analysisOutputDir)) || '本次分析');
                const sourceResolved = await fs.promises.realpath(analysisOutputDir);
                const targetResolved = path.resolve(analysisTargetDir);
                if (!targetResolved.startsWith(`${sourceResolved}${path.sep}`) && targetResolved !== sourceResolved) {
                    await fs.promises.cp(analysisOutputDir, analysisTargetDir, {
                        recursive: true,
                        force: true,
                        filter: source => !String(source).endsWith('-工程'),
                    });
                    portablePathMap.set(analysisOutputDir, analysisTargetDir);
                }
            }
            const rebasePath = value => {
                if (typeof value !== 'string') return value;
                for (const [from, to] of portablePathMap) {
                    if (value === from) return to;
                    if (value.startsWith(`${from}${path.sep}`)) return `${to}${value.slice(from.length)}`;
                }
                return value;
            };
            const rebaseJson = value => {
                if (Array.isArray(value)) return value.map(rebaseJson);
                if (!value || typeof value !== 'object') return rebasePath(value);
                Object.keys(value).forEach(key => { value[key] = rebaseJson(value[key]); });
                return value;
            };
            if (analysisTargetDir && fs.existsSync(analysisTargetDir)) {
                const files = await fs.promises.readdir(analysisTargetDir, { recursive: true });
                for (const relativePath of files) {
                    if (!String(relativePath).toLowerCase().endsWith('.json')) continue;
                    const jsonPath = path.join(analysisTargetDir, relativePath);
                    try {
                        const data = JSON.parse(await fs.promises.readFile(jsonPath, 'utf8'));
                        await fs.promises.writeFile(jsonPath, JSON.stringify(rebaseJson(data), null, 2), 'utf8');
                    } catch (_) { /* 非工程 JSON 或格式异常时保留原文件 */ }
                }
            }
            await fs.promises.writeFile(path.join(targetProjectDir, '文案.txt'), String(payload.scriptText || ''), 'utf8');
            if (payload.reelsProjectData && typeof payload.reelsProjectData === 'object') {
                const projectData = JSON.parse(JSON.stringify(payload.reelsProjectData));
                const remapPaths = value => {
                    if (Array.isArray(value)) return value.map(remapPaths);
                    if (!value || typeof value !== 'object') return overlayPathMap.get(value) || rebasePath(value);
                    Object.keys(value).forEach(key => { value[key] = remapPaths(value[key]); });
                    return value;
                };
                remapPaths(projectData);
                const reelsDir = path.join(targetProjectDir, 'Reels工程');
                await fs.promises.mkdir(reelsDir, { recursive: true });
                await fs.promises.writeFile(
                    path.join(reelsDir, `${baseName}.reels-project.json`),
                    JSON.stringify(projectData, null, 2),
                    'utf8'
                );
            }
            return { ok: true, projectDir: targetProjectDir };
        } catch (error) {
            return { ok: false, error: error.message || String(error), projectDir: targetProjectDir };
        }
    });

    // IPC: 获取媒体时长
    ipcMain.handle('get-media-duration', async (event, filePath) => {
        return ffmpegService.getDuration(filePath);
    });
    ipcMain.handle('get-media-duration-detail', async (event, filePath) => {
        return ffmpegService.getDurationDetailed(filePath);
    });

    // IPC: 读取音频文件为 WAV Buffer（供渲染进程的 Web Audio decodeAudioData 使用）
    // 先用 FFmpeg 转成 WAV（支持 mp4/mp3 等任何格式）
    ipcMain.handle('read-file-buffer', async (event, filePath) => {
        if (!filePath || !fs.existsSync(filePath)) {
            throw new Error(`文件不存在: ${filePath}`);
        }
        if (isBlockedSensitiveFilePath(filePath)) {
            throw new Error('安全策略拦截：不允许读取受保护的系统或密钥文件');
        }
        const settingsService = require('./services/settings');
        const { spawnSync } = require('child_process');
        const ffmpeg = ffmpegService.resolveCommand('ffmpeg');

        // 转为 WAV 供 Web Audio 使用
        const wavPath = settingsService.secureTmpFile('voice_decode', '.wav');
        const result = spawnSync(ffmpeg, [
            '-y', '-i', filePath,
            '-vn', '-acodec', 'pcm_s16le', '-ar', '44100', '-ac', '2',
            wavPath,
        ], { timeout: 30000 });

        if (result.status !== 0 || !fs.existsSync(wavPath)) {
            // 回退：仅允许音视频媒体扩展名直接读取原文件
            const allowedAudioVideoExts = new Set([
                '.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac', '.opus', '.wma', '.aiff', '.aif', '.amr',
                '.mp4', '.webm', '.mkv', '.mov', '.avi', '.flv', '.wmv', '.3gp', '.m4v',
            ]);
            if (!allowedAudioVideoExts.has(path.extname(filePath).toLowerCase())) {
                throw new Error('不支持的音频/视频文件格式');
            }
            log(`[read-file-buffer] FFmpeg 转 WAV 失败，直接读原媒体文件`);
            return fs.readFileSync(filePath);
        }

        const buf = fs.readFileSync(wavPath);
        try { fs.unlinkSync(wavPath); } catch (_) { }
        log(`[read-file-buffer] ${filePath} → WAV ${(buf.length / 1024 / 1024).toFixed(1)}MB`);
        return buf;
    });

    // IPC: 在 Finder/Explorer 中高亮文件
    ipcMain.handle('show-item-in-folder', (event, fullPath) => {
        if (!fullPath || typeof fullPath !== 'string') return;
        if (isBlockedSensitiveFilePath(fullPath)) {
            log(`[Security] 拦截 show-item-in-folder 访问受保护路径: ${fullPath}`);
            return;
        }
        shell.showItemInFolder(fullPath);
    });

    // IPC: 用系统默认浏览器打开链接
    ipcMain.handle('open-external-url', (event, url) => {
        if (url && typeof url === 'string' && (url.startsWith('https://') || url.startsWith('http://'))) {
            shell.openExternal(url);
        }
    });

    // IPC: 获取 Google Fonts 目录，绕过 CORS
    ipcMain.handle('fetch-google-fonts', async () => {
        try {
            const { net } = require('electron');
            const response = await net.fetch('https://fonts.google.com/metadata/fonts', {
                signal: AbortSignal.timeout(8000),
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const text = await response.text();
            return text;
        } catch (err) {
            console.error('[Fonts] fetch-google-fonts failed:', err.message);
            throw err;
        }
    });

    // IPC: 字体本地缓存（选用即下载完整 TTF 到 userData/fonts-cache，预览/导出共用）
    const fontCache = require('./services/font-cache').createFontCache({
        app, net: require('electron').net, log,
    });
    ipcMain.handle('font-cache-ensure', async (_event, family) => {
        try {
            return { ok: true, manifest: await fontCache.ensure(family) };
        } catch (err) {
            log(`[FontCache] ensure "${family}" failed: ${err.message}`);
            return { ok: false, error: err.message };
        }
    });
    ipcMain.handle('font-cache-list', () => fontCache.list());
    ipcMain.handle('font-cache-save-upload', (_event, family, data, fileName) => {
        try {
            return { ok: true, manifest: fontCache.saveUpload(family, data, fileName) };
        } catch (err) {
            log(`[FontCache] save upload "${family}" failed: ${err.message}`);
            return { ok: false, error: err.message };
        }
    });

    // IPC: 扫描本地字体目录 + 系统字体
    ipcMain.handle('scan-fonts', async () => {
        try {
            const os = require('os');
            const fontExts = new Set(['.ttf', '.otf', '.woff', '.woff2', '.ttc', '.dfont']);

            function inferWeightAndStyle(fileName) {
                const base = path.parse(fileName).name.toLowerCase();
                const style = /(italic|oblique)/.test(base) ? 'italic' : 'normal';
                let weight = '400';
                let hasExplicit = false;

                const rules = [
                    [/extra[\s_-]*black|ultra[\s_-]*black/, '900'],
                    [/\bblack\b/, '900'],
                    [/extra[\s_-]*bold|ultra[\s_-]*bold|heavy/, '800'],
                    [/\bsemi[\s_-]*bold\b|\bdemi[\s_-]*bold\b/, '600'],
                    [/\bbold\b/, '700'],
                    [/\bmedium\b/, '500'],
                    [/\bbook\b|\bregular\b|\bnormal\b/, '400'],
                    [/extra[\s_-]*light|ultra[\s_-]*light/, '200'],
                    [/\blight\b/, '300'],
                    [/\bthin\b|\bhairline\b/, '100'],
                ];
                for (const [re, w] of rules) {
                    if (re.test(base)) {
                        weight = w;
                        hasExplicit = true;
                        break;
                    }
                }

                if (!hasExplicit && /variablefont/.test(base)) {
                    weight = '100 900';
                }
                return { weight, style };
            }

            function cleanFamilyNameFromFile(fileName) {
                let raw = path.parse(fileName).name;
                // Split CamelCase: "AppleSDGothicNeo" → "Apple SD Gothic Neo"
                raw = raw.replace(/([a-z])([A-Z])/g, '$1 $2')
                         .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
                raw = raw.replace(/[_-]+/g, ' ');
                // Remove weight/style tokens
                const cleaned = raw
                    .replace(/\b(italic|oblique|regular|normal|book|medium|semibold|semi bold|demibold|demi bold|bold|extrabold|extra bold|ultrabold|ultra bold|black|extrablack|extra black|ultrablack|ultra black|heavy|light|extralight|extra light|ultralight|ultra light|thin|hairline|variablefont|wght|wdth|opsz)\b/gi, '')
                    // Remove macOS suffixes like "HB" (Harfbuzz variants)
                    .replace(/\bHB\b$/i, '')
                    .replace(/\s{2,}/g, ' ')
                    .trim();
                return cleaned || raw.trim();
            }

            // ── 扫描单个目录 ──
            function scanDir(dirPath, isSystemFont = false) {
                const results = [];
                if (!dirPath || !fs.existsSync(dirPath)) return results;
                try {
                    const items = fs.readdirSync(dirPath, { withFileTypes: true });
                    for (const item of items) {
                        if (item.name.startsWith('.')) continue;
                        const fullPath = path.join(dirPath, item.name);
                        if (item.isDirectory()) {
                            const familyName = item.name.replace(/_/g, ' ');
                            try {
                                const files = fs.readdirSync(fullPath);
                                for (const fontFile of files) {
                                    const ext = path.extname(fontFile).toLowerCase();
                                    if (!fontExts.has(ext)) continue;
                                    const meta = inferWeightAndStyle(fontFile);
                                    results.push({
                                        family: familyName,
                                        path: path.join(fullPath, fontFile),
                                        weight: meta.weight,
                                        style: meta.style,
                                        system: isSystemFont,
                                    });
                                }
                            } catch { /* skip unreadable dirs */ }
                        } else if (item.isFile() && fontExts.has(path.extname(item.name).toLowerCase())) {
                            const familyName = cleanFamilyNameFromFile(item.name).replace(/_/g, ' ');
                            const meta = inferWeightAndStyle(item.name);
                            results.push({
                                family: familyName,
                                path: fullPath,
                                weight: meta.weight,
                                style: meta.style,
                                system: isSystemFont,
                            });
                        }
                    }
                } catch (err) {
                    log(`[Fonts] Error scanning ${dirPath}: ${err.message}`);
                }
                return results;
            }

            const fontList = [];

            // ── 1. 项目内置字体 (assets/fonts) ──
            const fontsDir = app.isPackaged
                ? path.join(process.resourcesPath, 'assets', 'fonts')
                : path.join(__dirname, '..', 'assets', 'fonts');
            fontList.push(...scanDir(fontsDir, false));

            // ── 2. 系统字体目录 ──
            const systemDirs = [];
            if (process.platform === 'darwin') {
                // macOS
                systemDirs.push('/Library/Fonts');
                systemDirs.push(path.join(os.homedir(), 'Library', 'Fonts'));
                // /System/Library/Fonts 包含Apple系统字体（可能受SIP保护但可读）
                systemDirs.push('/System/Library/Fonts');
                systemDirs.push('/System/Library/Fonts/Supplemental');
            } else if (process.platform === 'win32') {
                // Windows
                const winFonts = path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts');
                systemDirs.push(winFonts);
                // 用户字体目录 (Windows 10+)
                const userFonts = path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'Windows', 'Fonts');
                systemDirs.push(userFonts);
            } else {
                // Linux
                systemDirs.push('/usr/share/fonts');
                systemDirs.push('/usr/local/share/fonts');
                systemDirs.push(path.join(os.homedir(), '.fonts'));
                systemDirs.push(path.join(os.homedir(), '.local', 'share', 'fonts'));
            }

            for (const dir of systemDirs) {
                fontList.push(...scanDir(dir, true));
            }

            // ── 去重（同 family 只保留一个条目用于注册，但保留所有 weight/style 变体）──
            log(`[Fonts] scanned ${fontList.length} font files (${systemDirs.length} system dirs + assets)`);
            return fontList;
        } catch (err) {
            log(`[Fonts] scanning error: ${err.message}`);
            return [];
        }
    });

    // ==================== IPC 处理 - 缓存管理 ====================
    ipcMain.handle('get-cache-info', async () => {
        return cacheManager.getCacheInfo(app.getPath('userData'));
    });

    ipcMain.handle('clear-cache', async (event, options = {}) => {
        const userDataPath = app.getPath('userData');
        return cacheManager.clearCache(userDataPath, {
            includeAutoEditCache: Boolean(options?.includeAutoEditCache),
            includeOverlayCache: options?.includeOverlayCache !== false,
            beforeRemoveRuntimeCaches: async () => {
                // 仅清空 Chromium HTTP 与 V8 编译缓存，绝不调用 clearStorageData，确保 LocalStorage/IndexedDB/Cookies 零影响
                if (session?.defaultSession) {
                    if (typeof session.defaultSession.clearCache === 'function') {
                        await session.defaultSession.clearCache();
                    }
                    if (typeof session.defaultSession.clearCodeCaches === 'function') {
                        await session.defaultSession.clearCodeCaches({});
                    }
                }
            },
            log,
        });
    });

    ipcMain.handle('open-cache-folder', () => {
        const tmpDir = cacheManager.getEffectiveTmpDir(app.getPath('userData'));
        try { fs.mkdirSync(tmpDir, { recursive: true }); } catch (_) { }
        shell.openPath(tmpDir);
    });

    ipcMain.handle('set-cache-path', async (event, newPath) => {
        const userDataPath = app.getPath('userData');
        const res = cacheManager.setCustomCachePath(userDataPath, newPath, {
            legacyConfigPath: _cacheConfigPath,
        });
        if (res.ok) {
            log(`[Cache] 临时缓存路径已${res.isCustom ? '更改为' : '恢复为默认'}: ${res.tmpPath}`);
        }
        return res;
    });

    // 注册 API 路由（替代 Python Flask 后端）
    registerAPIHandlers();
    log('API handlers registered - no Python backend needed');

    // ==================== 屏幕取色器（解决 Windows 吸管无法吸取窗口外颜色） ====================
    ipcMain.handle('screen-pick-color', async () => {
        try {
            // 获取主显示器信息
            const primaryDisplay = screen.getPrimaryDisplay();
            const { width: sw, height: sh } = primaryDisplay.size;
            const scaleFactor = primaryDisplay.scaleFactor || 1;

            // 截取整个屏幕
            const sources = await desktopCapturer.getSources({
                types: ['screen'],
                thumbnailSize: { width: sw * scaleFactor, height: sh * scaleFactor },
            });
            if (!sources || sources.length === 0) {
                log('[ColorPicker] No screen source found');
                return null;
            }
            const screenshot = sources[0].thumbnail;
            const dataUrl = screenshot.toDataURL();

            return new Promise((resolve) => {
                // 创建全屏透明窗口，覆盖整个屏幕
                const pickerWin = new BrowserWindow({
                    x: 0, y: 0,
                    width: sw, height: sh,
                    frame: false,
                    transparent: false,
                    alwaysOnTop: true,
                    skipTaskbar: true,
                    fullscreen: false,
                    resizable: false,
                    movable: false,
                    focusable: true,
                    webPreferences: {
                        nodeIntegration: false,
                        contextIsolation: true,
                        sandbox: true,
                    },
                });
                hardenPrivilegedWindowNavigation(pickerWin);

                pickerWin.setMenuBarVisibility(false);

                // 注入 HTML：显示截图 + 点击取色
                const html = `<!DOCTYPE html>
<html><head><style>
  * { margin:0; padding:0; }
  html, body { width:100%; height:100%; overflow:hidden; cursor:crosshair; }
  canvas { display:block; width:100%; height:100%; }
  #loupe {
    position:fixed; pointer-events:none; display:none;
    width:120px; height:120px; border-radius:50%;
    border:3px solid #fff; box-shadow:0 0 12px rgba(0,0,0,.6);
    overflow:hidden; z-index:999;
    image-rendering: pixelated;
  }
  #loupe canvas { width:120px; height:120px; image-rendering:pixelated; }
  #crosshair {
    position:fixed; pointer-events:none; display:none;
    width:1px; height:1px; z-index:1000;
  }
  #crosshair::before, #crosshair::after {
    content:''; position:absolute; background:rgba(255,255,255,.6);
  }
  #crosshair::before { width:1px; height:20px; left:0; top:-10px; }
  #crosshair::after { width:20px; height:1px; left:-10px; top:0; }
  #colorLabel {
    position:fixed; pointer-events:none; display:none;
    padding:4px 10px; border-radius:4px;
    font:bold 13px/1.2 monospace; color:#fff;
    background:rgba(0,0,0,.75); z-index:1001;
    white-space:nowrap;
  }
</style></head><body>
<canvas id="c"></canvas>
<div id="loupe"><canvas id="lc" width="120" height="120"></canvas></div>
<div id="crosshair"></div>
<div id="colorLabel"></div>
<script>
  const img = new Image();
  const scaleFactor = ${scaleFactor};
  img.onload = () => {
    const c = document.getElementById('c');
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);

    const loupe = document.getElementById('loupe');
    const lc = document.getElementById('lc');
    const lctx = lc.getContext('2d', { willReadFrequently: true });
    const crosshair = document.getElementById('crosshair');
    const colorLabel = document.getElementById('colorLabel');

    function getColor(x, y) {
      const px = Math.round(x * scaleFactor);
      const py = Math.round(y * scaleFactor);
      const d = ctx.getImageData(px, py, 1, 1).data;
      return '#' + [d[0],d[1],d[2]].map(v => v.toString(16).padStart(2,'0')).join('');
    }

    document.addEventListener('mousemove', e => {
      const x = e.clientX, y = e.clientY;
      // 放大镜
      loupe.style.display = 'block';
      crosshair.style.display = 'block';
      colorLabel.style.display = 'block';

      // 放大镜位置：跟随鼠标但偏移
      let lx = x + 20, ly = y - 140;
      if (lx + 130 > window.innerWidth) lx = x - 140;
      if (ly < 10) ly = y + 20;
      loupe.style.left = lx + 'px';
      loupe.style.top = ly + 'px';

      // 绘制放大区域 (8x 放大)
      const zoom = 8;
      const srcSize = 15; // 15x15 像素区域
      const px = Math.round(x * scaleFactor);
      const py = Math.round(y * scaleFactor);
      lctx.clearRect(0, 0, 120, 120);
      lctx.imageSmoothingEnabled = false;
      lctx.drawImage(c,
        px - srcSize/2, py - srcSize/2, srcSize, srcSize,
        0, 0, 120, 120
      );
      // 中心十字线
      lctx.strokeStyle = 'rgba(255,255,255,0.8)';
      lctx.lineWidth = 1;
      lctx.strokeRect(56, 56, 8, 8);

      crosshair.style.left = x + 'px';
      crosshair.style.top = y + 'px';

      const hex = getColor(x, y);
      colorLabel.textContent = hex.toUpperCase();
      colorLabel.style.left = (lx) + 'px';
      colorLabel.style.top = (ly + 128) + 'px';
      colorLabel.style.borderLeft = '4px solid ' + hex;
    });

    document.addEventListener('mousedown', e => {
      e.preventDefault();
      const hex = getColor(e.clientX, e.clientY);
      // 使用 document.title 通信回主进程
      document.title = 'PICKED:' + hex;
    });

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        document.title = 'PICKED:';
      }
    });
  };
  img.src = "${dataUrl}";
</script></body></html>`;

                pickerWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));

                // 监听 title 变化获取拾取结果
                pickerWin.webContents.on('page-title-updated', (e, title) => {
                    if (title.startsWith('PICKED:')) {
                        const hex = title.replace('PICKED:', '').trim();
                        pickerWin.destroy();
                        resolve(hex || null);
                    }
                });

                pickerWin.on('closed', () => {
                    resolve(null);
                });

                // 安全超时：30 秒后自动关闭
                setTimeout(() => {
                    if (!pickerWin.isDestroyed()) pickerWin.destroy();
                }, 30000);
            });
        } catch (err) {
            log('[ColorPicker] Error: ' + err.message);
            return null;
        }
    });

    // ==================== 模板多窗口支持 ====================
    ipcMain.handle('open-template-window', (event, templateId, templateName) => {
        // 如果已有该模板的窗口，聚焦它
        if (templateWindows.has(templateId)) {
            const existingWin = templateWindows.get(templateId);
            if (!existingWin.isDestroyed()) {
                existingWin.focus();
                return { success: true, reused: true };
            }
            templateWindows.delete(templateId);
        }

        const winOpts = {
            width: 1200,
            height: 800,
            minWidth: 900,
            minHeight: 700,
            title: `模板: ${templateName || templateId}`,
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                sandbox: false,
                backgroundThrottling: false,
                webSecurity: true, // Re-enabled for security; local media loads via local-media:// protocol
                preload: path.join(__dirname, 'preload.js'),
            },
        };

        winOpts.frame = true;
        winOpts.titleBarStyle = 'default';

        const win = new BrowserWindow(winOpts);
        hardenPrivilegedWindowNavigation(win);

        // 通过 URL hash 传递模板 ID，前端启动时读取
        const safeTemplateId = encodeURIComponent(String(templateId || ''));
        if (!app.isPackaged) {
            win.loadURL(`${DEV_SERVER_URL}/#template=${safeTemplateId}`);
            win.webContents.openDevTools();
        } else {
            win.loadFile(path.join(__dirname, '../dist/index.html'), {
                hash: `template=${safeTemplateId}`,
            });
        }

        templateWindows.set(templateId, win);
        win.on('closed', () => {
            templateWindows.delete(templateId);
        });

        log(`[Template] 打开模板窗口: ${templateName} (${templateId})`);
        return { success: true, reused: false };
    });

    // 防止 macOS App Nap
    if (process.platform === 'darwin') {
        powerSaveId = powerSaveBlocker.start('prevent-app-suspension');
        log(`PowerSaveBlocker started: ${powerSaveId}`);
    }

    // 开发用：新极速导出对比测试（仅设置环境变量时生效，正常启动不受影响）
    if (process.env.VIDEOKIT_TURBO_COMPARE) {
        require('./services/turbo-compare').run({ app, BrowserWindow, ipcMain, log });
        return;
    }

    // 直接创建窗口（不需要等待后端启动了！）
    createWindow();

    // 启动本机 AI 操作接口（127.0.0.1:18220，供 Antigravity MCP 工具桥操控，开发版与打包版通用）
    try {
        const { startAiApiServer } = require('./aiApi/server');
        startAiApiServer({
            getMainWindow: () => mainWindow,
            getTemplateWindows: () => templateWindows,
            getLatestRendererCrashReport,
            logDir,
            logger: log,
        });
    } catch (aiApiErr) {
        log(`[AiApi] 初始化失败: ${aiApiErr.message}`);
    }

    // 启动 Hedra Flow 批量 <-> VideoKit 文案自动剪辑 本地联动桥接服务（开发版与打包版通用）
    try {
        const http = require('http');
        const os = require('os');
        const bridgeDir = path.join(os.homedir(), '.videokit', 'hedra-bridge');
        try { fs.mkdirSync(bridgeDir, { recursive: true }); } catch (_) {}
        const candidatePorts = [18190, 18194, 18195, 18196];
        let activeBridgePort = candidatePorts[0];
        const MAX_HEDRA_BODY_BYTES = 10 * 1024 * 1024;
        const isAllowedHedraHost = (hostHeader) => {
            if (!hostHeader) return true;
            return /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(String(hostHeader).trim());
        };
        const isAllowedHedraOrigin = (originHeader) => {
            if (!originHeader) return true;
            if (originHeader === 'null') return false;
            const lower = String(originHeader).toLowerCase();
            if (
                lower.startsWith('chrome-extension://') ||
                lower.startsWith('moz-extension://') ||
                lower.startsWith('safari-web-extension://') ||
                lower.startsWith('file://')
            ) {
                return true;
            }
            try {
                const parsed = new URL(originHeader);
                const host = parsed.hostname.toLowerCase();
                if (parsed.protocol === 'https:' && (host === 'hedra.com' || host.endsWith('.hedra.com'))) return true;
                if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && (host === 'localhost' || host === '127.0.0.1')) return true;
            } catch (_) { }
            return false;
        };
        const hedraBridgeServer = http.createServer((req, res) => {
            if (!isAllowedHedraHost(req.headers.host)) {
                res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ ok: false, error: 'forbidden_host' }));
                return;
            }
            const origin = req.headers.origin;
            if (!isAllowedHedraOrigin(origin)) {
                res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ ok: false, error: 'forbidden_origin' }));
                return;
            }
            if (origin) {
                res.setHeader('Access-Control-Allow-Origin', origin);
                res.setHeader('Vary', 'Origin');
            }
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
            if (req.method === 'OPTIONS') {
                res.writeHead(204);
                res.end();
                return;
            }
            const reqUrl = String(req.url || '');
            if (req.method === 'GET' && reqUrl.startsWith('/status')) {
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({
                    ok: true,
                    app: 'videokit',
                    port: activeBridgePort,
                    pid: process.pid,
                    isPackaged: app.isPackaged,
                }));
                return;
            }
            if (req.method === 'POST' && (reqUrl.startsWith('/import-from-hedra') || reqUrl.startsWith('/hedra-clip-updated'))) {
                const chunks = [];
                let receivedBytes = 0;
                let aborted = false;
                req.on('data', (c) => {
                    if (aborted) return;
                    receivedBytes += c.length;
                    if (receivedBytes > MAX_HEDRA_BODY_BYTES) {
                        aborted = true;
                        res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' });
                        res.end(JSON.stringify({ ok: false, error: 'payload_too_large' }));
                        req.destroy();
                        return;
                    }
                    chunks.push(c);
                });
                req.on('end', () => {
                    if (aborted) return;
                    let body = {};
                    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (_) {}
                    const isImport = reqUrl.startsWith('/import-from-hedra');
                    const myMode = app.isPackaged ? 'packaged' : 'dev';
                    if (isImport && body.targetMode && body.targetMode !== 'all' && body.targetMode !== myMode) {
                        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                        res.end(JSON.stringify({ ok: false, skipped: true, mode: myMode }));
                        return;
                    }
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        if (isImport) {
                            try {
                                if (mainWindow.isMinimized()) mainWindow.restore();
                                mainWindow.show();
                                mainWindow.focus();
                            } catch (_) {}
                            mainWindow.webContents.send('hedra:import-autoedit', body);
                        } else {
                            mainWindow.webContents.send('hedra:clip-updated', body);
                        }
                    }
                    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ ok: Boolean(mainWindow && !mainWindow.isDestroyed()), forwarded: Boolean(mainWindow && !mainWindow.isDestroyed()), imported: false }));
                });
                return;
            }
            res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: 'not_found' }));
        });
        const tryListenBridge = (idx) => {
            if (idx >= candidatePorts.length) return;
            const p = candidatePorts[idx];
            hedraBridgeServer.once('error', () => tryListenBridge(idx + 1));
            hedraBridgeServer.listen(p, '127.0.0.1', () => {
                activeBridgePort = p;
                try {
                    const serverFile = path.join(bridgeDir, 'vk-server.json');
                    fs.writeFileSync(
                        serverFile,
                        JSON.stringify({ port: p, pid: process.pid, isPackaged: app.isPackaged, updatedAt: Date.now() }, null, 2),
                        { encoding: 'utf8', mode: 0o600 }
                    );
                    if (process.platform !== 'win32') {
                        try { fs.chmodSync(serverFile, 0o600); } catch (_) {}
                    }
                } catch (_) {}
                log(`[HedraBridge] Local bridge listening on 127.0.0.1:${p}`);
            });
        };
        tryListenBridge(0);
    } catch (bridgeErr) {
        log(`[HedraBridge] Init skipped: ${bridgeErr.message}`);
    }

    try {
        require('./updater').initAutoUpdater(mainWindow, log);
    } catch (updaterErr) {
        log(`[Updater] 初始化失败: ${updaterErr.message}`);
    }

});

app.on('child-process-gone', (_event, details) => {
    if (isQuitting || details.type !== 'GPU') return;
    writeRendererCrashReport({ process: 'GPU', reason: details.reason, exitCode: details.exitCode });
});

app.on('window-all-closed', () => {
    isQuitting = true;
    if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
    if (appIsReady && BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});

app.on('before-quit', () => {
    reelsResourceDiagnostics.stop();
    isQuitting = true;
});
