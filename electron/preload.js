const { contextBridge, ipcRenderer, webUtils, webFrame } = require('electron');

// 预设过去只在 Chromium localStorage 中保存；重打包后只要页面 origin 改变，
// 那套数据库就可能不可见。启动时同步从 userData/videokit-presets 恢复，随后
// 定期镜像回文件。只收集预设/模板相关键，绝不触碰 API Key 等设置。
// Keep every user-created batch library durable as well.  The viral project
// library intentionally does not contain "preset" in its storage key, which
// previously meant it was lost whenever Chromium's origin storage changed.
// `reels_bulk_create_last_state` is the complete large-creation working
// draft (including rows and assigned background folders).  It must travel
// with the durable library too: a named preset intentionally omits rows.
const _persistentPresetKey = (key) => !['reels_custom_brushes', 'reels_overlay_group_presets', 'reels_title_color_presets', 'reels_subtitle_presets', 'reels_bulk_create_presets', 'reels_bulk_create_last_state', 'reels_bulk_create_viral_projects', 'reels_bulk_create_viral_group_presets'].includes(String(key || ''))
    && /(?:preset|template|watermark|brush|vector_dividers|reels_bulk_create_(?:last_state|viral_(?:projects|group_presets)))/i.test(String(key || ''));
const _readPersistentPresetValues = () => {
    const values = {};
    try {
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && _persistentPresetKey(key)) values[key] = localStorage.getItem(key);
        }
    } catch (_) { }
    return values;
};
try {
    const response = ipcRenderer.sendSync('persistent-presets:hydrate', _readPersistentPresetValues());
    if (response?.ok) {
        // 旧版本会在每次草稿自动保存时复制完整的大量建立草稿。这些只是在
        // Chromium 中的冗余缓存；保留最新草稿即可，先清理以释放额度。
        try {
            const legacyDraftBackups = [];
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key?.startsWith('reels_bulk_create_draft_backup_')) legacyDraftBackups.push(key);
            }
            legacyDraftBackups.forEach((key) => localStorage.removeItem(key));
            if (legacyDraftBackups.length) {
                console.info(`[preload] 已清理 ${legacyDraftBackups.length} 份旧的大量建立草稿缓存`);
            }
        } catch (error) {
            console.warn('[preload] 清理旧草稿缓存失败，已跳过：', error?.message);
        }
        for (const [key, value] of Object.entries(response.values || {})) {
            // 兼容清理旧版产生的大量草稿副本。它们不属于可见预设，且每份都
            // 很大，回写 Chromium 缓存会导致 QuotaExceededError。
            if (key.startsWith('reels_bulk_create_draft_backup_') || ['reels_overlay_group_presets', 'reels_title_color_presets', 'reels_subtitle_presets', 'reels_bulk_create_presets', 'reels_bulk_create_last_state', 'reels_bulk_create_viral_projects', 'reels_bulk_create_viral_group_presets'].includes(key)) continue;
            try { localStorage.setItem(key, value); } catch (error) {
                console.warn('[preload] durable preset skipped from localStorage cache:', key, error?.message);
            }
        }
    }
} catch (_) { /* The main process may not have registered during an abnormal early startup. */ }
let _persistentPresetLast = '';
const _savePersistentPresets = () => {
    const values = _readPersistentPresetValues();
    const serialised = JSON.stringify(values);
    if (serialised === _persistentPresetLast) return;
    _persistentPresetLast = serialised;
    ipcRenderer.invoke('persistent-presets:save', values).catch(() => {});
};
setInterval(_savePersistentPresets, 2000);
window.addEventListener('beforeunload', _savePersistentPresets);

// File objects passed through contextBridge can lose the identity required by
// webUtils.getPathForFile().  Capture paths in the preload world while handling
// the original drop event, then let the renderer consume that one drop's paths.
// This is especially important for the batch Reels table, which must persist
// absolute paths instead of only file names.
let _lastDroppedFilePaths = [];
window.addEventListener('drop', (event) => {
    try {
        _lastDroppedFilePaths = Array.from(event.dataTransfer?.files || [])
            .map((file) => webUtils.getPathForFile(file))
            .filter(Boolean);
    } catch (error) {
        _lastDroppedFilePaths = [];
        console.warn('[preload] unable to capture dropped file paths:', error?.message);
    }
}, true);
const fs = require('fs');
const { createCoalescedTextWriter } = require('./services/coalescedTextWriter');
const _deferredTextWriter = createCoalescedTextWriter({ fs });
window.addEventListener('beforeunload', () => _deferredTextWriter.flush());
window.addEventListener('unload', () => _deferredTextWriter.flush());
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL, fileURLToPath } = require('url');

const {
    isBlockedSensitivePath: _isBlockedSensitivePath,
    isBlockedWritePath: _isBlockedWritePath,
    isAllowedBridgeChannel: _isAllowedBridgeChannel,
} = require('./services/pathSecurity');

function resolveAssetUrl(fileName) {
    if (!fileName) return '';

    const candidates = [];
    if (typeof process.resourcesPath === 'string' && process.resourcesPath) {
        candidates.push(path.join(process.resourcesPath, 'assets', fileName));
    }
    candidates.push(path.join(__dirname, '..', 'assets', fileName));
    candidates.push(path.join(__dirname, '..', 'dist', 'assets', fileName));

    for (const p of candidates) {
        try {
            if (fs.existsSync(p)) {
                return toFileUrl(p);
            }
        } catch { }
    }
    return '';
}

function toFileUrl(filePath) {
    if (!filePath || typeof filePath !== 'string') return '';
    if (/^(https?|data|blob):/i.test(filePath)) return filePath;
    if (filePath.startsWith('local-media://drive-review/')) return filePath;
    try {
        let nativePath = filePath;
        let suffix = '';
        // 原生路径里的 # 是文件名的一部分；只有 URL 的 # 才是片段标记。
        const hashIdx = /^(?:local-media|file):\/\//i.test(nativePath) ? nativePath.indexOf('#') : -1;
        if (hashIdx !== -1) {
            suffix = nativePath.slice(hashIdx);
            nativePath = nativePath.slice(0, hashIdx);
        }
        if (/^local-media:\/\//i.test(nativePath)) {
            nativePath = fileURLToPath(nativePath.replace(/^local-media:/i, 'file:'));
        } else if (/^file:\/\//i.test(nativePath)) {
            nativePath = fileURLToPath(nativePath);
        }
        // Node 自带的 URL 转换会正确处理 Windows 盘符、UNC、中文、空格和 #/%。
        return pathToFileURL(nativePath).href.replace(/^file:/i, 'local-media:') + suffix;
    } catch (_) {
        return filePath;
    }
}

function localMediaUrlToPath(value) {
    if (!value || typeof value !== 'string') return value;
    try {
        if (/^local-media:\/\//i.test(value)) return fileURLToPath(value.replace(/^local-media:/i, 'file:'));
        if (/^file:\/\//i.test(value)) return fileURLToPath(value);
    } catch (_) { }
    return value;
}

function fileExists(filePath) {
    if (!filePath || typeof filePath !== 'string') return false;
    let p = filePath.trim();
    if (!p || /^blob:|^data:|^https?:/i.test(p)) return true;
    p = localMediaUrlToPath(p);
    try {
        const resolved = path.resolve(p);
        return fs.existsSync(resolved);
    } catch {
        return false;
    }
}

// 暴露 API 给渲染进程
const _autoSaveDir = path.join(require('os').homedir(), '.videokit');
// 多个 VideoKit 副本过去共用 autosave.json；后启动/后关闭的副本会直接
// 覆盖前一个副本。用安装位置建立稳定作用域，同一副本的每次并行启动再
// 使用独立会话文件。这样升级/重启仍能找回同一副本的最近任务，也不会让
// 另一个软件副本篡改它。
const _batchInstallIdentity = path.resolve(process.resourcesPath || path.join(__dirname, '..'));
const _batchSaveScope = crypto.createHash('sha256').update(_batchInstallIdentity).digest('hex').slice(0, 12);
const _batchSessionId = `${process.pid}-${Date.now().toString(36)}`;
const _batchAutoSaveDir = path.join(_autoSaveDir, 'batch-recovery', _batchSaveScope);
const _autoSavePath = path.join(_batchAutoSaveDir, `autosave-${_batchSessionId}.json`);
const _legacyAutoSavePath = path.join(_autoSaveDir, 'autosave.json');
try { if (!fs.existsSync(_autoSaveDir)) fs.mkdirSync(_autoSaveDir, { recursive: true }); } catch (_) {}
try { if (!fs.existsSync(_batchAutoSaveDir)) fs.mkdirSync(_batchAutoSaveDir, { recursive: true }); } catch (_) {}

function listBatchAutoSaves() {
    try {
        return fs.readdirSync(_batchAutoSaveDir)
            .filter(name => /^autosave-[\w-]+\.json$/.test(name))
            .map(name => {
                const filePath = path.join(_batchAutoSaveDir, name);
                const stat = fs.statSync(filePath);
                // closedAt 由关闭会话时追加在 JSON 尾部；只读尾部元数据，
                // 不在启动时将每份大工程都 JSON.parse 到内存中。
                let closedAt = null, savedAt = null, fd;
                try {
                    fd = fs.openSync(filePath, 'r');
                    const header = Buffer.alloc(Math.min(512, stat.size));
                    fs.readSync(fd, header, 0, header.length, 0);
                    savedAt = header.toString('utf8').match(/"(?:timestamp|createdAt)"\s*:\s*"([^"\n]+)"/)?.[1] || null;
                    const length = Math.min(1024, stat.size), buffer = Buffer.alloc(length);
                    fs.readSync(fd, buffer, 0, length, Math.max(0, stat.size - length));
                    closedAt = buffer.toString('utf8').match(/,\s*"closedAt"\s*:\s*"([^"\n]+)"\s*}\s*$/)?.[1] || null;
                } finally { if (fd !== undefined) fs.closeSync(fd); }
                // A live renderer's snapshots belong to its own window. A reload
                // keeps the PID, so its previous session remains recoverable.
                const ownerPid = Number(name.match(/^autosave-(\d+)-/)?.[1]);
                let isActive = false;
                if (!closedAt && ownerPid && ownerPid !== process.pid) {
                    try { process.kill(ownerPid, 0); isActive = true; }
                    catch (error) { isActive = error.code === 'EPERM'; }
                }
                return { path: filePath, modifiedAt: stat.mtime.toISOString(), savedAt, closedAt, isActive };
            });
    } catch (_) { return []; }
}

function markBatchAutoSaveClosed(filePath) {
    try {
        if (!_deferredTextWriter.flush()) return false;
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        data.closedAt = new Date().toISOString();
        return _deferredTextWriter.writeNow(filePath, JSON.stringify(data));
    } catch (_) { return false; }
}

const _reelsFramePipelineRequests = new Map();
const _reelsFramePipelines = new Map();
ipcRenderer.on('reels-frame-pipeline-ready', (event, data = {}) => {
    const pending = _reelsFramePipelineRequests.get(data.requestId);
    if (!pending) return;
    _reelsFramePipelineRequests.delete(data.requestId);
    clearTimeout(pending.timer);
    const port = event.ports && event.ports[0];
    if (data.ok && port) {
        const pipelineId = data.requestId;
        const pipeline = { port, pending: new Map() };
        port.onmessage = (portEvent) => {
            const ack = portEvent.data || {};
            if (ack.type !== 'ack') return;
            const waiter = pipeline.pending.get(ack.seq);
            if (!waiter) return;
            pipeline.pending.delete(ack.seq);
            if (ack.ok) waiter.resolve(ack);
            else waiter.reject(new Error(ack.error || '帧流水线写入失败'));
        };
        port.start && port.start();
        _reelsFramePipelines.set(pipelineId, pipeline);
        pending.resolve(pipelineId);
    } else pending.reject(new Error(data.error || '无法建立帧流水线'));
});

const safeOpenPath = async (targetPath) => {
    try {
        return await ipcRenderer.invoke('open-path', targetPath);
    } catch (err) {
        if (err?.message?.includes('No handler registered')) {
            return await ipcRenderer.invoke('show-item-in-folder', targetPath);
        }
        throw err;
    }
};

const safeOpenExternal = async (url) => {
    try {
        return await ipcRenderer.invoke('open-external', url);
    } catch (err) {
        if (err?.message?.includes('No handler registered')) {
            return await ipcRenderer.invoke('open-external-url', url);
        }
        throw err;
    }
};

const localFilesBridge = {
    pickFolder: async (options) => {
        try {
            return await ipcRenderer.invoke('local:pick-folder', options);
        } catch (err) {
            if (err?.message?.includes('No handler registered')) {
                console.warn('[Preload] Fallback: local:pick-folder not registered, calling select-directory');
                return options?.multi
                    ? await ipcRenderer.invoke('select-directories')
                    : await ipcRenderer.invoke('select-directory');
            }
            throw err;
        }
    },
    pickImage: async () => {
        try {
            return await ipcRenderer.invoke('local:pick-image');
        } catch (err) {
            if (err?.message?.includes('No handler registered')) {
                const files = await ipcRenderer.invoke('select-files', {
                    title: '选择分类预览图',
                    multiple: false,
                    filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'] }]
                });
                return files?.[0] || null;
            }
            throw err;
        }
    },
    getSubfolders: (folderPath) => ipcRenderer.invoke('local:get-subfolders', folderPath),
    listDirectory: async (folderPath, options) => {
        try {
            return await ipcRenderer.invoke('local:list-directory', folderPath, options);
        } catch (err) {
            if (err?.message?.includes('No handler registered')) {
                console.warn('[Preload] Fallback: local:list-directory not registered, calling scan-directory');
                const files = await ipcRenderer.invoke('scan-directory', folderPath);
                return {
                    success: Boolean(files),
                    exists: Boolean(files),
                    items: (files || []).map(f => ({
                        name: f.name,
                        path: f.path,
                        isDirectory: Boolean(f.isDirectory),
                        size: f.size || 0,
                        modifiedTime: new Date(f.mtime || Date.now()).toISOString()
                    }))
                };
            }
            throw err;
        }
    },
    scanFolder: (folderPath, options) => ipcRenderer.invoke('local:scan-folder', folderPath, options),
    getFolderAvatarMedia: (folderPath) => ipcRenderer.invoke('local:get-folder-avatar-media', folderPath),
    getVideoThumbnail: (filePath, size) => ipcRenderer.invoke('local:video-thumbnail', filePath, size),
    getLocalThumbnail: (filePath) => ipcRenderer.invoke('local:thumbnail', filePath),
    flattenFolder: (folderPath) => ipcRenderer.invoke('local:flatten-folder', folderPath),
    collectFlatMedia: (options) => ipcRenderer.invoke('local:collect-flat-media', options),
    copyToFolder: (filePath, targetDir, options) => ipcRenderer.invoke('local:copy-to-folder', filePath, targetDir, options),
    moveToFolder: (filePath, targetDir, options) => ipcRenderer.invoke('local:move-to-folder', filePath, targetDir, options),
    removeDuplicates: (filePaths) => ipcRenderer.invoke('local:remove-duplicates', filePaths),
    findDuplicates: (filePaths) => ipcRenderer.invoke('local:find-duplicates', filePaths),
    trashFiles: (filePaths) => ipcRenderer.invoke('local:trash-files', filePaths),
    copyToClipboard: (filePaths) => ipcRenderer.invoke('local:copy-to-clipboard', filePaths),
    createFolder: (parentDir, folderName) => ipcRenderer.invoke('local:create-folder', parentDir, folderName),
    moveFolderToFolder: (srcDir, targetDir, options) => ipcRenderer.invoke('local:move-folder-to-folder', srcDir, targetDir, options),
    copyFolderToFolder: (srcDir, targetDir, options) => ipcRenderer.invoke('local:copy-folder-to-folder', srcDir, targetDir, options),
    mergeMaterialFolders: (targetRoot, sources, options) => ipcRenderer.invoke('local:merge-material-folders', targetRoot, sources, options),
    exportPreset: (jsonStr) => ipcRenderer.invoke('local:export-preset', jsonStr),
    importPreset: () => ipcRenderer.invoke('local:import-preset'),
    importPresetsMulti: () => ipcRenderer.invoke('local:import-presets-multi'),
    exportWorkspaceConfig: (jsonStr) => ipcRenderer.invoke('local:export-workspace-config', jsonStr),
    importWorkspaceConfig: () => ipcRenderer.invoke('local:import-workspace-config'),
    watchFolders: (folders) => ipcRenderer.invoke('local:watch-folders', folders),
    validateFolders: (folders) => ipcRenderer.invoke('local:validate-folders', folders),
    onScanProgress: (callback) => {
        ipcRenderer.removeAllListeners('local:scan-progress');
        ipcRenderer.on('local:scan-progress', (_event, data) => callback?.(data));
    },
    onFolderRenamed: (callback) => {
        ipcRenderer.removeAllListeners('local:folder-renamed');
        ipcRenderer.on('local:folder-renamed', (_event, data) => callback?.(data));
    },
    onFolderMissing: (callback) => {
        ipcRenderer.removeAllListeners('local:folder-missing');
        ipcRenderer.on('local:folder-missing', (_event, data) => callback?.(data));
    }
};

contextBridge.exposeInMainWorld('electronAPI', {
    // 平台信息
    platform: process.platform,
    runtimeMode: process.argv.includes('--videokit-mode=dev') ? 'dev'
        : process.argv.includes('--videokit-mode=packaged') ? 'packaged'
        : /(?:^|[\\/])node_modules[\\/]electron[\\/]/i.test(process.execPath || '') ? 'dev' : 'packaged',
    autoSavePath: _autoSavePath,
    legacyAutoSavePath: _legacyAutoSavePath,
    batchAutoSaveStorageKey: `reels_batch_config_autosave:${_batchSaveScope}:${_batchSessionId}`,
    legacyBatchAutoSaveStorageKey: 'reels_batch_config_autosave',
    listBatchAutoSaves,
    markBatchAutoSaveClosed,
    resolveAssetUrl,
    toFileUrl,
    fileExists,
    // 获取 File 对象的本地完整路径（contextIsolation 下 File.path 不可用）
    getFilePath: (file) => {
        try {
            const p = webUtils.getPathForFile(file);
            console.log('[preload.getFilePath] success:', p);
            return p;
        } catch (e) {
            console.error('[preload.getFilePath] FAILED:', e.message, 'file:', typeof file, file?.name);
            return '';
        }
    },
    consumeDroppedFilePaths: () => {
        const paths = _lastDroppedFilePaths;
        _lastDroppedFilePaths = [];
        return paths;
    },
    isDirectory: (filePath) => {
        try {
            return fs.existsSync(filePath) && fs.statSync(filePath).isDirectory();
        } catch {
            return false;
        }
    },
    fsExists: (p) => {
        try { return fs.existsSync(p); } catch { return false; }
    },
    fsStat: (p) => {
        try {
            const s = fs.statSync(p);
            return {
                size: s.size,
                mtimeMs: s.mtimeMs,
                isDirectory: s.isDirectory(),
                isFile: s.isFile()
            };
        } catch {
            return null;
        }
    },
    fsReaddir: (p) => {
        try {
            return fs.readdirSync(p, { withFileTypes: true }).map(e => ({
                name: e.name,
                isDirectory: e.isDirectory(),
                isFile: e.isFile()
            }));
        } catch {
            return [];
        }
    },
    pathJoin: (...args) => path.join(...args),
    pathBasename: (p) => path.basename(p),
    pathDirname: (p) => path.dirname(p),
    getAppVersion: () => ipcRenderer.invoke('get-app-version'),
    exportOverlayPresetPackage: (presets) => ipcRenderer.invoke('export-overlay-preset-package', presets),
    importOverlayPresetPackage: (packagePath) => ipcRenderer.invoke('import-overlay-preset-package', packagePath),
    saveOverlayPresetAssets: (preset) => ipcRenderer.invoke('save-overlay-preset-assets', preset),
    backupBulkCreateLegacy: (key, value) => ipcRenderer.sendSync('bulk-create-storage:backup-legacy', key, value),
    getBulkCreateStorage: () => ipcRenderer.sendSync('bulk-create-storage:read'),
    saveBulkCreateStorage: (key, value) => ipcRenderer.sendSync('bulk-create-storage:write', key, value),
    getPresetFolderInfo: () => ipcRenderer.invoke('preset-folder:info'),
    selectPresetFolder: async () => {
        const saved = await ipcRenderer.invoke('persistent-presets:save', _readPersistentPresetValues());
        if (!saved?.ok) console.warn('[PresetFolder] 原目录不可写，保留原文件并允许重新选择：', saved?.error);
        return ipcRenderer.invoke('preset-folder:select');
    },
    getBrushPresets: () => ipcRenderer.sendSync('brush-presets:read'),
    saveBrushPresets: (presets) => ipcRenderer.sendSync('brush-presets:write', presets),
    getOverlayGroupPresets: () => ipcRenderer.sendSync('overlay-group-presets:read'),
    saveOverlayGroupPresets: (presets) => ipcRenderer.sendSync('overlay-group-presets:write', presets),
    getTitleColorPresets: () => ipcRenderer.sendSync('title-color-presets:read'),
    saveTitleColorPresets: (presets) => ipcRenderer.sendSync('title-color-presets:write', presets),
    getSubtitlePresets: () => ipcRenderer.sendSync('subtitle-presets:read'),
    saveSubtitlePresets: (presets) => ipcRenderer.sendSync('subtitle-presets:write', presets),
    getPresetLibraryInfo: () => ipcRenderer.sendSync('preset-library:info'),
    exportPresetLibrary: () => ipcRenderer.invoke('preset-library:export'),
    importPresetLibrary: () => ipcRenderer.invoke('preset-library:import'),
    unhidePresetLibrary: () => ipcRenderer.invoke('preset-library:unhide'),
    writeClipboardText: (text) => {
        if (ipcRenderer.sendSync('clipboard:write-text', String(text ?? '')) !== true) {
            throw new Error('无法写入系统剪贴板');
        }
        return true;
    },
    writeClipboardImage: (filePath) => {
        return ipcRenderer.invoke('clipboard:write-image', localMediaUrlToPath(filePath));
    },

    // 选择目录
    selectDirectory: () => ipcRenderer.invoke('select-directory'),
    selectDirectories: () => ipcRenderer.invoke('select-directories'),
    // 通用文件/文件夹选择框。调用方需要保留 Electron 的完整结果
    // （尤其是 canceled 和 filePaths），供批量导入流程判断取消和多选。
    showOpenDialog: (options) => ipcRenderer.invoke('show-open-dialog', options),
    selectFiles: (options) => ipcRenderer.invoke('select-files', options),
    saveFile: (options) => ipcRenderer.invoke('save-file', options),

    scanDirectory: (dirPath) => ipcRenderer.invoke('scan-directory', dirPath),
    // 本地多窗口整理与文件分拣能力
    localFiles: localFilesBridge,
    scanDirectoryRecursive: (dirPath, options) => ipcRenderer.invoke('scan-directory-recursive', dirPath, options),
    searchFilesRecursive: (searchDir, fileNames, maxDepth, allCandidates) => ipcRenderer.invoke('search-files-recursive', searchDir, fileNames, maxDepth, allCandidates),
    checkFilesExist: (filePaths) => ipcRenderer.invoke('check-files-exist', filePaths),
    getDownloadsPath: () => ipcRenderer.invoke('get-downloads-path'),

    // 批量Reels - 烧录字幕
    burnSubtitles: (opts) => ipcRenderer.invoke('burn-subtitles', opts),
    reelsCompose: (opts) => ipcRenderer.invoke('reels-compose', opts),
    concatVideo: (opts) => ipcRenderer.invoke('concat-video', opts),
    reelsComposeWysiwyg: (action, data) => ipcRenderer.invoke('reels-compose-wysiwyg', action, data),
    reelsDetectSilence: (data) => ipcRenderer.invoke('reels-detect-silence', data),
    collectReelsProjectAssets: (data) => ipcRenderer.invoke('collect-reels-project-assets', data),
    copyReelsProjectPackage: (data) => ipcRenderer.invoke('copy-reels-project-package', data),
    createReelsFramePipeline: (sessionId) => new Promise((resolve, reject) => {
        const requestId = `reels-pipe-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const timer = setTimeout(() => {
            _reelsFramePipelineRequests.delete(requestId);
            reject(new Error('建立帧流水线超时'));
        }, 8000);
        _reelsFramePipelineRequests.set(requestId, { resolve, reject, timer });
        ipcRenderer.send('reels-frame-pipeline-open', { sessionId, requestId });
    }),
    sendReelsFramePipeline: (pipelineId, seq, raw) => new Promise((resolve, reject) => {
        const pipeline = _reelsFramePipelines.get(pipelineId);
        if (!pipeline) { reject(new Error('帧流水线不存在或已关闭')); return; }
        pipeline.pending.set(seq, { resolve, reject });
        try { pipeline.port.postMessage({ type: 'frame', seq, raw }, [raw]); }
        catch (err) { pipeline.pending.delete(seq); reject(err); }
    }),
    closeReelsFramePipeline: (pipelineId) => {
        const pipeline = _reelsFramePipelines.get(pipelineId);
        if (!pipeline) return;
        _reelsFramePipelines.delete(pipelineId);
        try { pipeline.port.close(); } catch (_) { }
    },
    getMediaDuration: (filePath) => {
        if (!filePath || typeof filePath !== 'string') return 0;
        const cleanPath = localMediaUrlToPath(filePath);
        return ipcRenderer.invoke('get-media-duration', cleanPath);
    },
    getMediaDurationDetail: (filePath) => {
        if (!filePath || typeof filePath !== 'string') {
            return Promise.resolve({ ok: false, duration: null, code: 'EMPTY_PATH', reason: '文件路径为空' });
        }
        return ipcRenderer.invoke('get-media-duration-detail', localMediaUrlToPath(filePath));
    },
    saveRenderedAudio: (wavData) => ipcRenderer.invoke('save-rendered-audio', wavData),
    readFileBuffer: (filePath) => ipcRenderer.invoke('read-file-buffer', filePath),
    // 分层 PNG 序列导出
    savePngFrame: (opts) => ipcRenderer.invoke('save-png-frame', opts),
    exportAudioMp3: (opts) => ipcRenderer.invoke('export-audio-mp3', opts),
    ensureDirectory: (dirPath) => ipcRenderer.invoke('ensure-directory', dirPath),

    // V3 并行影子窗口导出
    parallelWysiwygExport: (opts) => ipcRenderer.invoke('parallel-wysiwyg-export', opts),
    onParallelProgress: (callback) => {
        const handler = (_, data) => callback(data);
        ipcRenderer.on('parallel-export-progress', handler);
        return () => ipcRenderer.removeListener('parallel-export-progress', handler);
    },
    isolatedWysiwygExport: (opts) => ipcRenderer.invoke('isolated-wysiwyg-export', opts),
    reelsTurboExport: (action, data) => ipcRenderer.invoke('reels-turbo-export', action, data),
    cancelIsolatedWysiwygExport: (requestId) => ipcRenderer.send('cancel-isolated-wysiwyg-export', requestId),
    getLatestCrashDiagnostic: () => ipcRenderer.invoke('get-latest-crash-diagnostic'),
    reportReelsOverviewResources: (data) => ipcRenderer.send('reels-overview-resources', data),
    onReelsCrashDiagnostic: (callback) => {
        const handler = (_, data) => callback(data);
        ipcRenderer.on('reels-crash-diagnostic', handler);
        return () => ipcRenderer.removeListener('reels-crash-diagnostic', handler);
    },
    onIsolatedWysiwygProgress: (requestId, callback) => {
        const handler = (_, data) => {
            if (data && data.requestId === requestId) callback(data);
        };
        ipcRenderer.on('isolated-wysiwyg-progress', handler);
        return () => ipcRenderer.removeListener('isolated-wysiwyg-progress', handler);
    },

    // 自动更新
    checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
    downloadUpdate: () => ipcRenderer.invoke('download-update'),
    installUpdate: () => ipcRenderer.invoke('install-update'),
    getUpdateChannel: () => ipcRenderer.invoke('get-update-channel'),
    setUpdateChannel: (channel) => ipcRenderer.invoke('set-update-channel', channel),
    onUpdateStatus: (callback) => {
        const handler = (_, data) => callback(data);
        ipcRenderer.on('update-status', handler);
        return () => ipcRenderer.removeListener('update-status', handler);
    },

    // 扫描本地字体
    scanFonts: () => ipcRenderer.invoke('scan-fonts'),
    fetchGoogleFonts: () => ipcRenderer.invoke('fetch-google-fonts'),
    fontCacheEnsure: (family) => ipcRenderer.invoke('font-cache-ensure', family),
    fontCacheList: () => ipcRenderer.invoke('font-cache-list'),
    fontCacheSaveUpload: (family, data, fileName) => ipcRenderer.invoke('font-cache-save-upload', family, data, fileName),

    // 读取文件内容（拦截敏感凭据与密钥文件读取）
    readFileText: (filePath) => {
        try {
            if (_isBlockedSensitivePath(filePath)) return '';
            return fs.readFileSync(filePath, 'utf-8');
        } catch { return ''; }
    },

    // 写入文件内容 (用于保存工程，拦截敏感路径与可执行脚本覆盖)
    writeFileText: (filePath, content) => {
        if (_isBlockedWritePath(filePath)) {
            throw new Error('安全策略拦截：不允许写入受保护的系统或可执行文件路径');
        }
        return _deferredTextWriter.writeNow(filePath, content);
    },
    writeFileTextDeferred: (filePath, content) => {
        if (_isBlockedWritePath(filePath)) {
            throw new Error('安全策略拦截：不允许写入受保护的系统或可执行文件路径');
        }
        return _deferredTextWriter.write(filePath, content);
    },
    flushPendingTextWrites: () => _deferredTextWriter.flush(),

    // ==================== 统一 API 调用接口 ====================
    // 替代 fetch(`${API_BASE}/endpoint`, ...) 的调用方式
    // 用法: const result = await window.electronAPI.apiCall('elevenlabs/voices', { key_index: 0 })
    apiCall: (endpoint, data) => ipcRenderer.invoke('api-call', endpoint, data),
    onTemplatePackageProgress: callback => {
        const handler=(_event,data)=>callback(data);ipcRenderer.on('template-package-progress',handler);
        return ()=>ipcRenderer.removeListener('template-package-progress',handler);
    },
    onBatchUsedMediaProgress: callback => {
        const handler = (_event, data) => callback(data);
        ipcRenderer.on('batch-used-media-progress', handler);
        return () => ipcRenderer.removeListener('batch-used-media-progress', handler);
    },
    onElevenLabsWebAuthStatus: (callback) => {
        const handler = (_event, data) => callback(data);
        ipcRenderer.on('elevenlabs-web-auth-status', handler);
        return () => ipcRenderer.removeListener('elevenlabs-web-auth-status', handler);
    },

    // 文件上传专用接口
    // 用法: const result = await window.electronAPI.apiUpload('upload', fileArrayBuffer, fileName, { extra: 'data' })
    apiUpload: (endpoint, fileBuffer, fileName, formData) =>
        ipcRenderer.invoke('api-upload', endpoint, fileBuffer, fileName, formData),

    // Google Drive 下载进度事件监听
    // Google Drive 识别分析进度事件监听
    onGDriveReviewProgress: callback => {
        const handler=(_event,data)=>callback(data);ipcRenderer.on('gdrive-review-progress',handler);
        return ()=>ipcRenderer.removeListener('gdrive-review-progress',handler);
    },
    onGDriveParseProgress: (callback) => {
        const handler = (_event, data) => callback(data);
        ipcRenderer.on('gdrive-parse-progress', handler);
        return () => ipcRenderer.removeListener('gdrive-parse-progress', handler);
    },

    onGDriveSizeProgress: (callback) => {
        const handler = (_event, data) => callback(data);
        ipcRenderer.on('gdrive-size-progress', handler);
        return () => ipcRenderer.removeListener('gdrive-size-progress', handler);
    },

    onGDriveDownloadProgress: (callback) => {
        const handler = (_event, data) => callback(data);
        ipcRenderer.on('gdrive-download-progress', handler);
        return () => ipcRenderer.removeListener('gdrive-download-progress', handler);
    },

    // 批量下载进度事件监听
    onBatchDownloadProgress: (callback) => {
        ipcRenderer.on('batch-download-progress', (event, data) => callback(data));
    },

    // 链接截图进度事件监听
    onUrlThumbnailProgress: (callback) => {
        ipcRenderer.on('url-thumbnail-progress', (event, data) => callback(event, data));
    },

    onAutoEditProgress: (callback) => {
        const handler = (event, data) => callback(data);
        ipcRenderer.on('auto-edit-progress', handler);
        return () => ipcRenderer.removeListener('auto-edit-progress', handler);
    },

    onAutoEditArchiveProgress: (callback) => {
        const handler = (event, data) => callback(data);
        ipcRenderer.on('autoedit-archive-progress', handler);
        return () => ipcRenderer.removeListener('autoedit-archive-progress', handler);
    },

    onSubtitleProgress: (callback) => {
        const handler = (_event, data) => callback(data);
        ipcRenderer.on('subtitle-progress', handler);
        return () => ipcRenderer.removeListener('subtitle-progress', handler);
    },

    // 在 Finder/Explorer 中高亮显示文件
    showItemInFolder: (filePath) => {
        ipcRenderer.invoke('show-item-in-folder', filePath).catch(() => {});
    },

    // 在访达/资源管理器中直接打开指定文件夹
    openPath: (dirPath) => {
        return ipcRenderer.invoke('open-path', dirPath).catch(() => {});
    },

    // 用系统默认浏览器打开链接
    openExternal: (url) => {
        ipcRenderer.invoke('open-external-url', url).catch(() => {});
    },

    // 缓存管理
    getCacheInfo: () => ipcRenderer.invoke('get-cache-info'),
    clearCache: (options) => ipcRenderer.invoke('clear-cache', options || {}),
    openCacheFolder: () => ipcRenderer.invoke('open-cache-folder'),
    setCachePath: (newPath) => ipcRenderer.invoke('set-cache-path', newPath),

    // 界面缩放（使用 Electron 原生 webFrame，正确处理布局视口）
    setZoomFactor: (factor) => webFrame.setZoomFactor(factor),
    getZoomFactor: () => webFrame.getZoomFactor(),


    // 屏幕取色器（解决 Windows 吸管无法吸取窗口外颜色）
    screenPickColor: () => ipcRenderer.invoke('screen-pick-color'),

    // 模板多窗口
    openTemplateWindow: (templateId, templateName) => ipcRenderer.invoke('open-template-window', templateId, templateName),

    // 本机 AI 操作接口（开关、重置口令、日志、主进程 <-> 渲染进程桥）
    aiApiGetStatus: () => ipcRenderer.invoke('ai-api:get-status'),
    aiApiSetEnabled: (enabled) => ipcRenderer.invoke('ai-api:set-enabled', Boolean(enabled)),
    aiApiResetToken: () => ipcRenderer.invoke('ai-api:reset-token'),
    aiApiGetLog: (limit = 200) => ipcRenderer.invoke('ai-api:get-log', Number(limit) || 200),
    onAiApiRequest: (handler) => {
        if (typeof handler !== 'function') return () => {};
        const listener = async (_event, payload = {}) => {
            const reqId = payload.reqId;
            try {
                const result = await handler(payload);
                ipcRenderer.send('ai-api:renderer-response', { reqId, ok: true, result });
            } catch (err) {
                ipcRenderer.send('ai-api:renderer-response', {
                    reqId,
                    ok: false,
                    error: String(err?.message || err),
                });
            }
        };
        ipcRenderer.on('ai-api:renderer-request', listener);
        return () => ipcRenderer.removeListener('ai-api:renderer-request', listener);
    },
});

// 兼容 ITEN 原生桥接层 bridge 对象
contextBridge.exposeInMainWorld('bridge', {
    toFileUrl,
    getPathForFile: (file) => {
        try {
            return webUtils.getPathForFile(file) || '';
        } catch (_) {
            return file?.path || '';
        }
    },
    openPath: safeOpenPath,
    openExternal: safeOpenExternal,
    renameLocalFiles: (payload) => ipcRenderer.invoke('files:rename-local', payload),
    on: (channel, listener) => {
        if (!_isAllowedBridgeChannel(channel) || typeof listener !== 'function') {
            return () => {};
        }
        const handler = (_event, ...args) => listener(...args);
        ipcRenderer.on(channel, handler);
        return () => ipcRenderer.removeListener(channel, handler);
    },
    removeListener: (channel, listener) => {
        if (!_isAllowedBridgeChannel(channel) || typeof listener !== 'function') return;
        ipcRenderer.removeListener(channel, listener);
    },
    localFiles: localFilesBridge
});
