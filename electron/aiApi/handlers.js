/**
 * VideoKit AI 操作接口全量处理函数（23 个领域接口，覆盖全部 11 个主界面与深层子模块）
 *
 * 安全原则：
 * - 只读查询与紧急停止可直接执行
 * - 真正执行任务、消耗外部 API、渲染导出、改名/移动/写入文件：默认走两步确认（返回 confirmToken，用户同意后调用 confirm）
 * - 删除/清空/改全局配置：强制走两步确认或显式 confirm: true（未确认仅返回预览，不执行）
 * - 严禁读取/返回任何明文 API Key / Web Token，严禁触发退出登录清除凭证
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { shell, session } = require('electron');

const { routeAPI } = require('../apiRouter');
const settingsService = require('../services/settings');
const templateService = require('../services/templates');
const persistentPresetStore = require('../services/persistentPresetStore');
const ffmpegService = require('../services/ffmpeg');
const { safeMoveFileSync } = require('../services/fsUtils');
const cacheManager = require('../services/cacheManager');
const {
    isBlockedSensitivePath,
    assertSafeFileMutation,
    assertSafeSingleFileName,
} = require('../services/pathSecurity');

const BLOCKED_API_ENDPOINTS = new Set([
    'settings/reveal-keys',
    'elevenlabs/web-logout',
    'elevenlabs/web-login',
    'elevenlabs/web-token-manual',
    'settings/elevenlabs',
    'settings/elevenlabs/keys',
    'settings/elevenlabs-keys-status',
    'settings/gladia-keys',
    'settings/gemini-keys',
    'settings/transcription-providers',
    'google-tts/keys',
]);

function listFilesRecursiveSafe(rootDir, { maxDepth = 10, limit = 500, exts = null } = {}) {
    if (!rootDir || !fs.existsSync(rootDir)) throw new Error(`目录不存在：${rootDir}`);
    if (isBlockedSensitivePath(rootDir)) throw new Error('安全策略拦截：受保护目录不允许扫描');
    const results = [];
    const extSet = Array.isArray(exts) && exts.length
        ? new Set(exts.map((e) => String(e).toLowerCase().replace(/^\.?/, '.')))
        : null;
    function walk(dir, depth) {
        if (depth > maxDepth || results.length >= limit) return;
        let entries = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
        for (const entry of entries) {
            if (results.length >= limit) return;
            if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
            const full = path.join(dir, entry.name);
            if (isBlockedSensitivePath(full)) continue;
            if (entry.isDirectory()) {
                walk(full, depth + 1);
            } else if (entry.isFile()) {
                const ext = path.extname(entry.name).toLowerCase();
                if (extSet && !extSet.has(ext)) continue;
                try {
                    const st = fs.statSync(full);
                    results.push({
                        name: entry.name,
                        path: full,
                        relativePath: path.relative(rootDir, full),
                        size: st.size,
                        mtime: new Date(st.mtimeMs).toISOString(),
                    });
                } catch (_) { }
            }
        }
    }
    walk(rootDir, 0);
    return results;
}

function findDuplicateFilesByHash(filePaths) {
    const valid = (Array.isArray(filePaths) ? filePaths : [])
        .filter((p) => typeof p === 'string' && fs.existsSync(p) && !isBlockedSensitivePath(p))
        .filter((p) => {
            try { return fs.statSync(p).isFile(); } catch (_) { return false; }
        });
    const bySize = new Map();
    for (const p of valid) {
        const size = fs.statSync(p).size;
        if (!bySize.has(size)) bySize.set(size, []);
        bySize.get(size).push(p);
    }
    const groups = [];
    for (const [size, group] of bySize) {
        if (group.length < 2) continue;
        const byHash = new Map();
        for (const p of group) {
            const hash = crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex');
            if (!byHash.has(hash)) byHash.set(hash, []);
            byHash.get(hash).push(p);
        }
        for (const [hash, dupes] of byHash) {
            if (dupes.length > 1) {
                groups.push({ hash, size, keep: dupes[0], duplicates: dupes.slice(1), all: dupes });
            }
        }
    }
    return {
        scanned: valid.length,
        duplicateGroupCount: groups.length,
        duplicateFileCount: groups.reduce((acc, g) => acc + g.duplicates.length, 0),
        groups,
    };
}

function getCacheSummary(userDataPath) {
    return cacheManager.getCacheInfo(userDataPath);
}

async function clearCacheDirs(userDataPath, options = {}) {
    return cacheManager.clearCache(userDataPath, {
        includeAutoEditCache: Boolean(options?.includeAutoEditCache),
        beforeRemoveRuntimeCaches: async () => {
            if (session?.defaultSession) {
                if (typeof session.defaultSession.clearCache === 'function') {
                    await session.defaultSession.clearCache();
                }
                if (typeof session.defaultSession.clearCodeCaches === 'function') {
                    await session.defaultSession.clearCodeCaches({});
                }
            }
        },
    });
}

function safeCheckFileArray(files, label = '文件') {
    const list = Array.isArray(files) ? files.map((f) => String(f || '').trim()).filter(Boolean) : [];
    if (!list.length) throw new Error(`请至少提供 1 个${label}路径`);
    const missing = list.filter((p) => !fs.existsSync(p));
    const blocked = list.filter((p) => isBlockedSensitivePath(p));
    if (blocked.length) throw new Error(`安全策略拦截受保护路径：${blocked[0]}`);
    return { list, missing };
}

function ensureSafeOutputDir(dirPath) {
    if (!dirPath) return '';
    const resolved = path.resolve(String(dirPath));
    if (isBlockedSensitivePath(resolved)) {
        throw new Error('安全策略拦截：不允许输出到受保护目录');
    }
    return resolved;
}

function computeRenamePreview(items = []) {
    const plan = [];
    const conflicts = [];
    const seenTargets = new Set();
    for (const item of items) {
        const source = String(item?.source || item?.path || '').trim();
        const rawNewName = String(item?.newName || item?.targetName || '').trim();
        if (!source) continue;
        if (isBlockedSensitivePath(source)) throw new Error(`安全策略拦截受保护源文件：${source}`);
        const exists = fs.existsSync(source);
        const dir = item?.targetDir ? ensureSafeOutputDir(item.targetDir) : path.dirname(source);
        const safeName = assertSafeSingleFileName(rawNewName || path.basename(source));
        const target = path.join(dir, safeName);
        assertSafeFileMutation(target);
        const key = target.toLowerCase();
        const targetExists = target !== source && fs.existsSync(target);
        const duplicateTarget = seenTargets.has(key);
        seenTargets.add(key);
        if (!exists) conflicts.push(`源文件不存在: ${source}`);
        if (targetExists) conflicts.push(`目标已存在: ${target}`);
        if (duplicateTarget) conflicts.push(`目标文件名重复: ${target}`);
        plan.push({
            source,
            oldName: path.basename(source),
            newName: safeName,
            target,
            exists,
            targetExists,
        });
    }
    return { plan, conflicts };
}

function createHandlers(ctx) {
    const {
        getUserDataDir,
        getMainWindow,
        getTemplateWindows,
        getLatestRendererCrashReport,
        getAppMeta,
        logDir,
        callRenderer,
        createPendingAction,
        confirmPendingAction,
        startBgJob,
        getJob,
        listJobs,
        stopBgJob,
        getStatus,
    } = ctx;

    async function tryRenderer(action, params = {}, timeoutMs = 25000) {
        try {
            return await callRenderer(action, params, timeoutMs);
        } catch (err) {
            return { _rendererUnavailable: true, error: String(err?.message || err) };
        }
    }

    return {
        // ==================== 1. 全局总览 ====================
        async overview() {
            const meta = getAppMeta();
            const apiStatus = getStatus();
            const ui = await tryRenderer('overview', {}, 10000);
            const cache = getCacheSummary(getUserDataDir());
            const crash = getLatestRendererCrashReport ? getLatestRendererCrashReport() : null;
            const templates = (() => {
                try {
                    const list = templateService.listTemplates() || [];
                    return { count: list.length };
                } catch (_) {
                    return { count: 0 };
                }
            })();
            const templateWins = getTemplateWindows ? Array.from(getTemplateWindows().keys()) : [];
            const jobs = listJobs(10);
            const runningBgJobs = jobs.filter((j) => j.status === 'running');
            return {
                app: {
                    name: 'VideoKit Studio',
                    version: meta.version,
                    mode: meta.mode,
                    port: apiStatus.port,
                    openTemplateWindows: templateWins,
                },
                ui: ui?._rendererUnavailable ? { unavailable: true, reason: ui.error } : ui,
                templates,
                runningBgJobs,
                recentBgJobsCount: jobs.length,
                cache: { totalHuman: cache.totalHuman, path: cache.path },
                latestCrashDiagnostic: crash,
            };
        },

        // ==================== 2. 界面导航与文件定位 ====================
        async ui_navigate(body = {}) {
            const action = String(body.action || 'switch_tab');
            if (action === 'reveal_path' || action === 'open_path') {
                const targetPath = String(body.path || '').trim();
                if (!targetPath) throw new Error('请提供 path');
                if (isBlockedSensitivePath(targetPath)) throw new Error('安全策略拦截：不允许打开受保护路径');
                if (!fs.existsSync(targetPath)) throw new Error(`路径不存在：${targetPath}`);
                const st = fs.statSync(targetPath);
                if (action === 'open_path' && st.isDirectory()) {
                    await shell.openPath(targetPath);
                } else {
                    shell.showItemInFolder(targetPath);
                }
                return { ok: true, action, path: targetPath };
            }
            if (action === 'focus_window') {
                const win = getMainWindow();
                if (!win || win.isDestroyed()) throw new Error('主窗口不可用');
                if (win.isMinimized()) win.restore();
                win.show();
                win.focus();
                return { ok: true, focused: true };
            }
            return callRenderer('ui_navigate', body);
        },

        // ==================== 3. 后台任务进度 ====================
        async job(body = {}) {
            if (body?.jobId) {
                const item = getJob(body.jobId);
                if (!item) throw new Error(`找不到后台任务 ${body.jobId}（可能软件重启过）`);
                return item;
            }
            return { jobs: listJobs(Number(body?.limit) || 20) };
        },

        // ==================== 4. 统一两步确认执行 ====================
        async confirm(body = {}) {
            return confirmPendingAction(body?.confirmToken);
        },

        // ==================== 5. 紧急停止任务 ====================
        async stop_task(body = {}) {
            const target = String(body?.target || 'all');
            const bgResult = (target === 'all' || body?.jobId)
                ? stopBgJob(body?.jobId || '')
                : { stopped: false };
            const uiResult = body?.jobId
                ? null
                : await tryRenderer('stop_task', { target });
            let gdriveResult = null;
            if (target === 'all' || target === 'gdrive_download') {
                try { gdriveResult = await routeAPI('gdrive/cancel-all', {}); } catch (_) { }
            }
            return {
                target,
                bgJobs: bgResult,
                ui: uiResult,
                gdrive: gdriveResult,
            };
        },

        // ==================== 6. 批量 Reels 查询（只读） ====================
        async reels_query(body = {}) {
            const action = String(body?.action || 'summary');
            if (action === 'preset_library_info') {
                return {
                    libraryInfo: persistentPresetStore.libraryInfo(),
                    folderInfo: persistentPresetStore.presetFolderLibrary.info(),
                    subtitlePresetsCount: Object.keys(persistentPresetStore.readSubtitlePresets() || {}).length,
                    overlayGroupPresetsCount: Object.keys(persistentPresetStore.readOverlayGroupPresets() || {}).length,
                    titleColorPresetsCount: Object.keys(persistentPresetStore.readTitleColorPresets() || {}).length,
                    brushPresetsCount: Array.isArray(persistentPresetStore.readBrushPresets())
                        ? persistentPresetStore.readBrushPresets().length
                        : Object.keys(persistentPresetStore.readBrushPresets() || {}).length,
                };
            }
            if (action === 'background_library' || action === 'media_library' || action === 'used_batches') {
                const ep = action === 'background_library'
                    ? 'background-library'
                    : action === 'media_library'
                        ? 'media-library'
                        : 'batch-used-media';
                const subAction = String(body?.subAction || 'list');
                const readOnlySub = new Set(['list', 'get', 'status', 'info', 'scan', 'inspect', 'stats', 'history', 'batches']);
                if (!readOnlySub.has(subAction)) {
                    throw new Error(`reels_query 仅允许只读操作，修改素材库请使用 videokit_reels_edit`);
                }
                return routeAPI(ep, { action: subAction, ...(body?.params || {}) });
            }
            return callRenderer('reels_query', body);
        },

        // ==================== 7. 批量 Reels 编排与修改 ====================
        async reels_edit(body = {}) {
            const action = String(body?.action || '');
            if (!action) throw new Error('请指定 action');

            // 轻量无损界面操作（仅勾选/反选/撤销/重做/切标签查看）可直接执行
            const directSafeActions = new Set([
                'select_task',
                'select_all',
                'invert_selection',
                'select_first_n',
                'switch_tab',
                'open_overview',
                'close_overview',
                'toggle_batch_table',
                'undo',
                'redo',
            ]);
            if (directSafeActions.has(action)) {
                return callRenderer('reels_edit', body);
            }

            // Gemini AI 批量处理文案（消耗 Gemini 额度 → 两步确认）
            if (action === 'ai_process_scripts') {
                const scripts = Array.isArray(body?.scripts) ? body.scripts : [];
                if (!scripts.length) throw new Error('请提供 scripts 文案数组');
                return createPendingAction({
                    kind: 'reels_ai_process_scripts',
                    summary: `调用 Gemini 批量处理 ${scripts.length} 条文案`,
                    preview: { count: scripts.length, sample: scripts.slice(0, 3) },
                    execute: () => startBgJob('reels_ai_process_scripts', { count: scripts.length }, () => routeAPI('ai/process-scripts', { scripts })),
                });
            }

            // 破坏性删除/清空操作：支持 confirm: true 或两步 confirmToken
            const destructiveActions = new Set([
                'delete_selected_tasks',
                'clear_tasks',
                'delete_preset',
                'delete_watermark_preset',
                'close_tab',
                'clear_all_tabs',
            ]);
            if (destructiveActions.has(action)) {
                const summaryInfo = await tryRenderer('reels_query', { action: 'summary' });
                return createPendingAction({
                    kind: `reels_edit:${action}`,
                    summary: `执行批量 Reels 破坏性操作：${action}`,
                    preview: {
                        action,
                        currentReelsSummary: summaryInfo,
                        warning: '该操作会删除或清空任务/预设，请确认已保存工程或备份。',
                    },
                    execute: () => callRenderer('reels_edit', { ...body, confirm: true }),
                });
            }

            // 其余批量改动（导入配对、大量制作、布局批量、套用预设、改文字/覆层/背景/配乐、素材库更新、导出 Skill、保存/加载工程等）均走两步确认
            const preview = await tryRenderer('reels_edit_preview', body);
            return createPendingAction({
                kind: `reels_edit:${action}`,
                summary: preview?.summary || `执行批量 Reels 操作：${action}`,
                preview: {
                    action,
                    details: preview,
                },
                execute: () => callRenderer('reels_edit', body, 60000),
            });
        },

        // ==================== 8. 批量 Reels 导出（强制两步确认） ====================
        async reels_export(body = {}) {
            const mode = String(body?.mode || 'wysiwyg');
            const outputDir = body?.outputDir ? ensureSafeOutputDir(body.outputDir) : '';
            if (mode === 'install_resolve_script') {
                return createPendingAction({
                    kind: 'reels_export:install_resolve_script',
                    summary: '安装 DaVinci Resolve Fusion 导入脚本',
                    preview: { mode },
                    execute: () => routeAPI('media/install-resolve-fusion-script', body?.params || {}),
                });
            }
            const preview = await callRenderer('reels_export_preview', { ...body, mode, outputDir });
            if (!preview?.selectedCount && mode !== 'install_resolve_script') {
                throw new Error(preview?.error || '当前没有勾选任何可导出的 Reels 任务');
            }
            return createPendingAction({
                kind: `reels_export:${mode}`,
                summary: `批量导出 ${preview.selectedCount} 条 Reels 视频（引擎：${preview.engineLabel || mode}）`,
                preview,
                execute: () => callRenderer('reels_export_start', { ...body, mode, outputDir }, 60000),
            });
        },

        // ==================== 9. 视频模板库与个人预设库 ====================
        async templates(body = {}) {
            const action = String(body?.action || 'list');
            if (action === 'list') {
                const list = templateService.listTemplates() || [];
                const q = String(body?.query || '').trim().toLowerCase();
                const category = String(body?.category || '').trim();
                const filtered = list.filter((t) => {
                    if (category && String(t.category || '') !== category) return false;
                    if (q) {
                        const hay = `${t.name || ''} ${t.description || ''} ${(t.tags || []).join(' ')} ${t.category || ''}`.toLowerCase();
                        if (!hay.includes(q)) return false;
                    }
                    return true;
                });
                const limit = Math.min(200, Math.max(1, Number(body?.limit) || 50));
                return {
                    total: list.length,
                    matched: filtered.length,
                    templates: filtered.slice(0, limit).map((t) => ({
                        id: t.id,
                        name: t.name,
                        category: t.category || '',
                        kind: t.kind || '',
                        taskCount: t.taskCount || 0,
                        tags: t.tags || [],
                        createdAt: t.createdAt,
                        updatedAt: t.updatedAt,
                    })),
                };
            }
            if (action === 'get') {
                if (!body?.id) throw new Error('请提供模板 id');
                const tpl = templateService.getTemplate(String(body.id));
                return {
                    id: tpl.id,
                    name: tpl.name,
                    category: tpl.category || '',
                    kind: tpl.kind || '',
                    description: tpl.description || '',
                    taskCount: tpl.projectData?.tasks?.length || tpl.taskCount || 0,
                    createdAt: tpl.createdAt,
                    updatedAt: tpl.updatedAt,
                };
            }
            if (action === 'versions') {
                if (!body?.id) throw new Error('请提供模板 id');
                return templateService.listVersions(String(body.id));
            }
            if (action === 'library_config') {
                return templateService.libraryConfig();
            }
            if (action === 'preset_library_info') {
                return {
                    libraryInfo: persistentPresetStore.libraryInfo(),
                    folderInfo: persistentPresetStore.presetFolderLibrary.info(),
                };
            }
            if (action === 'estimate_collection') {
                return templateService.estimateCollection(body?.params || {});
            }
            if (action === 'open_window') {
                if (!body?.id) throw new Error('请提供模板 id');
                return callRenderer('templates_action', { action: 'open_window', id: body.id, name: body.name });
            }
            if (action === 'delete') {
                if (!body?.id) throw new Error('请提供要删除的模板 id');
                const tpl = templateService.getTemplate(String(body.id));
                return createPendingAction({
                    kind: 'templates:delete',
                    summary: `永久删除模板「${tpl?.name || body.id}」`,
                    preview: { id: body.id, name: tpl?.name, warning: '删除后无法恢复，请确认。' },
                    execute: () => templateService.deleteTemplate(String(body.id)),
                });
            }
            if (action === 'rename') {
                if (!body?.id || !body?.newName) throw new Error('请提供 id 和 newName');
                return createPendingAction({
                    kind: 'templates:rename',
                    summary: `将模板 ${body.id} 重命名为「${body.newName}」`,
                    preview: { id: body.id, newName: body.newName },
                    execute: () => templateService.renameTemplate(String(body.id), String(body.newName)),
                });
            }
            if (action === 'classify') {
                return createPendingAction({
                    kind: 'templates:classify',
                    summary: `批量修改模板分类为「${body?.category || '未分类'}」`,
                    preview: { ids: body?.ids, category: body?.category || '' },
                    execute: () => templateService.classifyTemplates(body?.ids || [], String(body?.category || '')),
                });
            }
            if (action === 'restore_version') {
                if (!body?.id || !body?.revision) throw new Error('请提供 id 和 revision');
                return createPendingAction({
                    kind: 'templates:restore_version',
                    summary: `将模板 ${body.id} 恢复到历史版本 ${body.revision}`,
                    preview: { id: body.id, revision: body.revision },
                    execute: () => templateService.restoreVersion(String(body.id), body.revision),
                });
            }
            if (action === 'save_library_config') {
                return createPendingAction({
                    kind: 'templates:save_library_config',
                    summary: '更新模板库分类配置',
                    preview: { categories: body?.categories },
                    execute: () => templateService.saveLibraryConfig({ categories: body?.categories || [] }),
                });
            }
            if (action === 'unhide_preset_library') {
                return createPendingAction({
                    kind: 'templates:unhide_preset_library',
                    summary: '恢复所有已隐藏的内置预设',
                    preview: {},
                    execute: () => persistentPresetStore.unhideLibraryPresets(),
                });
            }
            // load / save / package_project / export_collection / import_collection / export_skill 等均通过渲染进程或后台执行
            return createPendingAction({
                kind: `templates:${action}`,
                summary: `执行模板库操作：${action}`,
                preview: { action, id: body?.id, ids: body?.ids, name: body?.name, outputPath: body?.outputPath },
                execute: () => {
                    if (action === 'export_collection') {
                        return startBgJob('templates_export_collection', { outputPath: body?.outputPath }, () => routeAPI('templates/export-collection', body?.params || body));
                    }
                    if (action === 'import_collection') {
                        return startBgJob('templates_import_collection', { filePath: body?.filePath }, () => routeAPI('templates/import-collection', body?.params || body));
                    }
                    return callRenderer('templates_action', body, 60000);
                },
            });
        },

        // ==================== 10. 文案自动剪辑（单套 + 批量 + Hedra 联动） ====================
        async autoedit(body = {}) {
            const action = String(body?.action || 'status');
            const readOnly = new Set(['status', 'task_detail', 'hedra_status', 'batch_report']);
            if (readOnly.has(action)) {
                return callRenderer('autoedit_query', body);
            }
            if (action === 'clear_clip_cache') {
                return createPendingAction({
                    kind: 'autoedit:clear_clip_cache',
                    summary: '清理文案自动剪辑切片语音识别缓存',
                    preview: { filePath: body?.filePath || '全部/指定片段缓存' },
                    execute: () => routeAPI('media/clear-clip-cache', body?.params || body),
                });
            }
            if (action === 'headless_run') {
                const { list, missing } = safeCheckFileArray(body?.clips, '视频片段');
                if (missing.length) throw new Error(`找不到视频片段：${missing[0]}`);
                if (!body?.scriptText) throw new Error('缺少断行文案 scriptText');
                const outputDir = body?.outputDir ? ensureSafeOutputDir(body.outputDir) : '';
                return createPendingAction({
                    kind: 'autoedit:headless_run',
                    summary: `${body?.analysisOnly ? '分析匹配' : '自动剪辑导出'} ${list.length} 个视频片段`,
                    preview: {
                        clipCount: list.length,
                        clips: list.slice(0, 10),
                        analysisOnly: Boolean(body?.analysisOnly),
                        outputDir: outputDir || '(默认目录)',
                        scriptPreview: String(body.scriptText).slice(0, 200),
                    },
                    execute: () => startBgJob('autoedit_headless', { clipCount: list.length, analysisOnly: Boolean(body?.analysisOnly) }, ({ reportProgress }) =>
                        routeAPI('media/auto-edit-by-script', {
                            clips: list,
                            script_text: body.scriptText,
                            output_dir: outputDir || undefined,
                            language: body?.language || 'auto',
                            analysis_only: Boolean(body?.analysisOnly),
                            ...(body?.options || {}),
                        }, (p) => reportProgress(p))
                    ),
                });
            }
            if (['move_clip_excluded', 'restore_clip_excluded', 'replace_clip', 'partial_replace_clip', 'rename_original_clips', 'retranscribe_clip'].includes(action)) {
                const mapEp = {
                    move_clip_excluded: 'media/move-clip-to-excluded',
                    restore_clip_excluded: 'media/restore-clip-from-excluded',
                    replace_clip: 'media/auto-edit-replace-clip',
                    partial_replace_clip: 'media/auto-edit-partial-replace-clip',
                    rename_original_clips: 'media/rename-original-clips',
                    retranscribe_clip: 'media/retranscribe-autoedit-clip',
                };
                return createPendingAction({
                    kind: `autoedit:${action}`,
                    summary: `执行自动剪辑片段操作：${action}`,
                    preview: { action, params: body?.params || body },
                    execute: () => routeAPI(mapEp[action], body?.params || body),
                });
            }
            // 其余 UI 批量工作台操作（导入文件夹、自动断行、智能配对、从 Hedra 拉取、批量分析、集中审核处理、批量导出、送入 Reels、归档、发回 Hedra 等）
            const currentStatus = await tryRenderer('autoedit_query', { action: 'status' });
            return createPendingAction({
                kind: `autoedit:${action}`,
                summary: `执行文案自动剪辑工作台操作：${action}`,
                preview: { action, currentStatus, params: body },
                execute: () => callRenderer('autoedit_action', body, 60000),
            });
        },

        // ==================== 11. 素材快速审核 ====================
        async visual_review(body = {}) {
            const action = String(body?.action || 'status');
            if (action === 'status' || action === 'report') {
                return callRenderer('visual_review_query', body);
            }
            const status = await tryRenderer('visual_review_query', { action: 'status' });
            return createPendingAction({
                kind: `visual_review:${action}`,
                summary: `执行素材快速审核操作：${action}`,
                preview: { action, currentStatus: status, params: body },
                execute: () => callRenderer('visual_review_action', body, 60000),
            });
        },

        // ==================== 12. 一键配音字幕（Tab 1） ====================
        async voiceover_workflow(body = {}) {
            const action = String(body?.action || 'status');
            if (action === 'status') {
                return callRenderer('voiceover_query', { action: 'status' });
            }
            if (action === 'voices') {
                return routeAPI('elevenlabs/voices', { key_index: Number(body?.keyIndex) || 0 });
            }
            if (action === 'pause') {
                return callRenderer('voiceover_action', { action: 'pause' });
            }
            const cur = await tryRenderer('voiceover_query', { action: 'status' });
            return createPendingAction({
                kind: `voiceover_workflow:${action}`,
                summary: `执行一键配音字幕操作：${action}`,
                preview: {
                    action,
                    currentQueue: cur,
                    incomingCount: Array.isArray(body?.tasks) ? body.tasks.length : undefined,
                    outputDir: body?.outputDir || cur?.outputDir,
                },
                execute: () => callRenderer('voiceover_action', body, 60000),
            });
        },

        // ==================== 13. 配音工坊（ElevenLabs / Voice Studio / 微软 / 谷歌） ====================
        async tts_studio(body = {}) {
            const action = String(body?.action || 'queue_status');
            const provider = String(body?.provider || 'elevenlabs');

            if (action === 'voices') {
                if (provider === 'microsoft') return routeAPI('edge-tts/voices', body?.params || {});
                if (provider === 'google') return routeAPI('google-tts/voices', body?.params || {});
                return routeAPI('elevenlabs/voices', { key_index: Number(body?.keyIndex) || 0 });
            }
            if (action === 'search_voices') {
                return routeAPI('elevenlabs/search', { query: String(body?.query || ''), page_size: Number(body?.limit) || 20 });
            }
            if (action === 'quotas') {
                if (provider === 'google') return routeAPI('google-tts/test-keys', {});
                if (body?.all !== false) return routeAPI('elevenlabs/all-quotas', {});
                return routeAPI('elevenlabs/quota', { key_index: Number(body?.keyIndex) || 0 });
            }
            if (action === 'voice_studio_snapshot') {
                const snap = await routeAPI('elevenlabs/voice-studio', { action: 'snapshot' });
                const accounts = body?.includeBalances ? await routeAPI('elevenlabs/voice-studio', { action: 'accounts' }).catch(() => null) : null;
                return { snapshot: snap, accounts };
            }
            if (action === 'queue_status') {
                return callRenderer('tts_query', { provider });
            }
            if (action === 'vs_stop') {
                return routeAPI('elevenlabs/voice-studio', { action: 'stop', job_id: body?.jobId });
            }

            // 以下操作消耗额度或写出文件 → 统一走两步确认
            if (action === 'tts_single') {
                const text = String(body?.text || '').trim();
                if (!text) throw new Error('请提供要合成的文本 text');
                const outputPath = body?.outputPath ? ensureSafeOutputDir(body.outputPath) : '';
                return createPendingAction({
                    kind: `tts_single:${provider}`,
                    summary: `使用 ${provider} 生成 1 条语音（${text.length} 字）`,
                    preview: { provider, voiceId: body?.voiceId, charCount: text.length, textPreview: text.slice(0, 160), outputPath: outputPath || '(默认路径)' },
                    execute: () => {
                        if (provider === 'microsoft') {
                            return routeAPI('edge-tts/save-item', { text, voice: body?.voiceId, rate: body?.rate, pitch: body?.pitch, output_dir: body?.outputDir, file_name: body?.fileName, ...(body?.params || {}) });
                        }
                        if (provider === 'google') {
                            return routeAPI('google-tts/save-item', { text, voice: body?.voiceId, rate: body?.rate, style: body?.style, output_dir: body?.outputDir, file_name: body?.fileName, ...(body?.params || {}) });
                        }
                        return routeAPI('elevenlabs/tts', {
                            text,
                            voice_id: body?.voiceId,
                            model_id: body?.modelId || 'eleven_multilingual_v2',
                            output_path: outputPath || undefined,
                            key_index: body?.keyIndex,
                            ...(body?.params || {}),
                        });
                    },
                });
            }
            if (action === 'sfx') {
                const text = String(body?.text || '').trim();
                if (!text) throw new Error('请提供音效描述 text');
                return createPendingAction({
                    kind: 'elevenlabs:sfx',
                    summary: `生成 ElevenLabs 音效（${body?.durationSeconds || '自动'}s）`,
                    preview: { text, durationSeconds: body?.durationSeconds, outputPath: body?.outputPath || '(默认路径)' },
                    execute: () => routeAPI('elevenlabs/sfx', {
                        text,
                        duration_seconds: body?.durationSeconds,
                        prompt_influence: body?.promptInfluence,
                        output_path: body?.outputPath,
                        key_index: body?.keyIndex,
                    }),
                });
            }
            if (action === 'toggle_key') {
                return createPendingAction({
                    kind: 'elevenlabs:toggle_key',
                    summary: `${body?.enabled ? '启用' : '停用'}第 ${(Number(body?.keyIndex) || 0) + 1} 个 ElevenLabs Key`,
                    preview: { keyIndex: Number(body?.keyIndex) || 0, enabled: Boolean(body?.enabled) },
                    execute: () => routeAPI('elevenlabs/toggle-key', { key_index: Number(body?.keyIndex) || 0, enabled: Boolean(body?.enabled) }),
                });
            }
            if (action.startsWith('vs_')) {
                const vsActionMap = {
                    vs_sync_voices: 'sync-voices',
                    vs_put_designs: 'put-designs',
                    vs_generate: 'generate',
                    vs_save_candidate: 'save',
                    vs_forget_design: 'forget-design',
                    vs_plan: 'plan',
                    vs_start: 'start',
                };
                const mapped = vsActionMap[action];
                if (!mapped) throw new Error(`未知 Voice Studio 操作：${action}`);
                return createPendingAction({
                    kind: `voice_studio:${mapped}`,
                    summary: `执行 Voice Studio 操作：${mapped}`,
                    preview: { action: mapped, params: body?.params || body },
                    execute: () => routeAPI('elevenlabs/voice-studio', { action: mapped, ...(body?.params || body) }),
                });
            }
            // 其余操作（向微软/谷歌/ElevenLabs 队列添加文案、启动批量生成、打包 ZIP、清空队列）交由渲染进程队列执行
            const q = await tryRenderer('tts_query', { provider });
            return createPendingAction({
                kind: `tts_studio:${provider}:${action}`,
                summary: `执行 ${provider} 配音面板操作：${action}`,
                preview: { provider, action, currentQueue: q, incomingRows: Array.isArray(body?.rows) ? body.rows.length : undefined },
                execute: () => callRenderer('tts_action', { ...body, provider, action }, 60000),
            });
        },

        // ==================== 14. 字幕对齐（Tab 5） ====================
        async subtitle_align(body = {}) {
            const action = String(body?.action || 'status');
            if (action === 'languages') return routeAPI('languages', {});
            if (action === 'records') return routeAPI('settings/transcription-records', {});
            if (action === 'status') return callRenderer('subtitle_query', {});
            if (action === 'clear_cache') {
                return createPendingAction({
                    kind: 'subtitle_align:clear_cache',
                    summary: '清理字幕云端识别缓存',
                    preview: { warning: '清理后再次对齐相同音频需重新调用云端转录 API' },
                    execute: () => routeAPI('subtitle/clear-cache', {}),
                });
            }
            if (action === 'clear_records') {
                return createPendingAction({
                    kind: 'subtitle_align:clear_records',
                    summary: '清空云端转录切片历史记录',
                    preview: {},
                    execute: () => routeAPI('settings/transcription-records/clear', {}),
                });
            }
            if (action === 'generate') {
                const audioPath = String(body?.audioPath || '').trim();
                if (!audioPath || !fs.existsSync(audioPath)) throw new Error(`找不到音频/视频文件：${audioPath}`);
                const outputDir = body?.outputDir ? ensureSafeOutputDir(body.outputDir) : path.dirname(audioPath);
                return createPendingAction({
                    kind: 'subtitle_align:generate',
                    summary: `对「${path.basename(audioPath)}」执行云端语音识别与字幕对齐`,
                    preview: {
                        audioPath,
                        outputDir,
                        language: body?.language || '英语',
                        hasSourceText: Boolean(body?.sourceText),
                        hasTranslateText: Boolean(body?.translateText),
                        exportFcpxml: Boolean(body?.exportFcpxml),
                    },
                    execute: () => startBgJob('subtitle_generate', { audioPath }, ({ reportProgress }) =>
                        routeAPI('subtitle/generate', {
                            audio_path: audioPath,
                            source_text: body?.sourceText || '',
                            translate_text: body?.translateText || '',
                            language: body?.language || '英语',
                            output_dir: outputDir,
                            export_fcpxml: Boolean(body?.exportFcpxml),
                            seamless_fcpxml: Boolean(body?.seamlessFcpxml),
                            gen_merge_srt: body?.genMergeSrt !== false,
                            source_up_order: body?.sourceUpOrder !== false,
                            ...(body?.options || {}),
                        }, (p) => reportProgress(p))
                    ),
                });
            }
            return createPendingAction({
                kind: `subtitle_align:${action}`,
                summary: `执行字幕对齐界面操作：${action}`,
                preview: { action, params: body },
                execute: () => callRenderer('subtitle_action', body, 60000),
            });
        },

        // ==================== 15. SRT 工具与 TXT 工具 ====================
        async srt_tools(body = {}) {
            const action = String(body?.action || 'compute_char_time');
            if (action === 'compute_char_time') {
                if (!body?.srtPath || !fs.existsSync(body.srtPath)) throw new Error('请提供有效的 srtPath');
                return routeAPI('srt/compute-char-time', {
                    srt_path: body.srtPath,
                    exclude_chars: body?.excludeChars,
                });
            }
            if (action === 'txt_wrap_preview') {
                const texts = Array.isArray(body?.texts) ? body.texts : [String(body?.text || '')];
                const maxLen = Math.max(5, Number(body?.maxChars) || 40);
                const wrapped = texts.map((t) => {
                    const words = String(t || '').trim().split(/\s+/);
                    const lines = [];
                    let cur = '';
                    for (const w of words) {
                        if (!cur) cur = w;
                        else if ((cur + ' ' + w).length <= maxLen) cur += ' ' + w;
                        else { lines.push(cur); cur = w; }
                    }
                    if (cur) lines.push(cur);
                    return lines.join('\n');
                });
                return { maxChars: maxLen, count: wrapped.length, results: wrapped };
            }
            if (action === 'adjust') {
                if (!body?.srcSrt || !fs.existsSync(body.srcSrt)) throw new Error('请提供有效的源 SRT 路径 srcSrt');
                const outputPath = body?.outputPath ? ensureSafeOutputDir(body.outputPath) : '';
                if (outputPath) assertSafeFileMutation(outputPath);
                return createPendingAction({
                    kind: 'srt_tools:adjust',
                    summary: `调整 SRT 字幕时间轴：${path.basename(body.srcSrt)}`,
                    preview: { srcSrt: body.srcSrt, outputPath: outputPath || '(同目录自动命名)', params: body?.params || {} },
                    execute: () => routeAPI('srt/adjust', {
                        src_srt: body.srcSrt,
                        orgi_srt: body?.orgiSrt,
                        ref_srt: body?.refSrt,
                        output_path: outputPath || undefined,
                        ...(body?.params || {}),
                    }),
                });
            }
            if (action === 'seamless') {
                if (!body?.srtPath || !fs.existsSync(body.srtPath)) throw new Error('请提供有效的 SRT 路径 srtPath');
                const outputPath = body?.outputPath ? ensureSafeOutputDir(body.outputPath) : '';
                if (outputPath) assertSafeFileMutation(outputPath);
                return createPendingAction({
                    kind: 'srt_tools:seamless',
                    summary: `生成无缝衔接字幕：${path.basename(body.srtPath)}`,
                    preview: { srtPath: body.srtPath, outputPath: outputPath || '(同目录自动命名)' },
                    execute: () => routeAPI('srt/seamless', { srt_path: body.srtPath, output_path: outputPath || undefined }),
                });
            }
            if (action === 'batch_txt_export') {
                const items = Array.isArray(body?.texts) ? body.texts : [];
                if (!items.length) throw new Error('请提供 texts 数组');
                const outputDir = ensureSafeOutputDir(body?.outputDir);
                if (!outputDir) throw new Error('请提供 outputDir 输出目录');
                const startNum = Number(body?.startNumber) || 1;
                const padDigits = Math.max(1, Number(body?.padDigits) || 3);
                const prefix = String(body?.prefix || '');
                const filesPreview = items.slice(0, 10).map((_, idx) => `${prefix}${String(startNum + idx).padStart(padDigits, '0')}.txt`);
                return createPendingAction({
                    kind: 'srt_tools:batch_txt_export',
                    summary: `批量导出 ${items.length} 个 TXT 文件到 ${outputDir}`,
                    preview: { count: items.length, outputDir, sampleFiles: filesPreview },
                    execute: async () => {
                        fs.mkdirSync(outputDir, { recursive: true });
                        const created = [];
                        for (let i = 0; i < items.length; i++) {
                            const name = assertSafeSingleFileName(`${prefix}${String(startNum + i).padStart(padDigits, '0')}.txt`);
                            const dest = path.join(outputDir, name);
                            assertSafeFileMutation(dest);
                            fs.writeFileSync(dest, String(items[i] ?? ''), 'utf8');
                            created.push(dest);
                        }
                        return { count: created.length, outputDir, files: created };
                    },
                });
            }
            throw new Error(`未知 srt_tools action：${action}`);
        },

        // ==================== 16. 下载工具（yt-dlp & Google Drive） ====================
        async download(body = {}) {
            const action = String(body?.action || 'gdrive_status');
            if (action === 'analyze_url') {
                if (!body?.url) throw new Error('请提供视频链接 url');
                return routeAPI('video/analyze', { url: String(body.url) });
            }
            if (action === 'gdrive_parse') {
                const rawText = String(body?.links || body?.rawText || '').trim();
                if (!rawText) throw new Error('请提供 Google Drive 链接文本 links');
                return routeAPI('gdrive/parse', { rawText });
            }
            if (action === 'gdrive_status') {
                return callRenderer('download_query', {});
            }
            if (action === 'download_single') {
                if (!body?.url) throw new Error('请提供视频链接 url');
                const outputDir = ensureSafeOutputDir(body?.outputDir || os.homedir());
                return createPendingAction({
                    kind: 'download:single',
                    summary: `下载视频链接到 ${outputDir}`,
                    preview: { url: body.url, outputDir, format: body?.format || 'mp4', quality: body?.quality || 'best' },
                    execute: () => startBgJob('video_download', { url: body.url, outputDir }, () =>
                        routeAPI('video/download', {
                            url: String(body.url),
                            output_dir: outputDir,
                            format: body?.format,
                            quality: body?.quality,
                            ...(body?.options || {}),
                        })
                    ),
                });
            }
            if (action === 'download_batch') {
                const urls = Array.isArray(body?.urls) ? body.urls.filter(Boolean) : [];
                if (!urls.length) throw new Error('请提供 urls 链接列表');
                const outputDir = ensureSafeOutputDir(body?.outputDir || os.homedir());
                return createPendingAction({
                    kind: 'download:batch',
                    summary: `批量下载 ${urls.length} 条视频链接到 ${outputDir}`,
                    preview: { count: urls.length, sampleUrls: urls.slice(0, 5), outputDir, format: body?.format || 'mp4' },
                    execute: () => startBgJob('video_download_batch', { count: urls.length, outputDir }, () =>
                        routeAPI('video/download-batch-links', {
                            urls,
                            output_dir: outputDir,
                            format: body?.format,
                            quality: body?.quality,
                            ...(body?.options || {}),
                        })
                    ),
                });
            }
            // Google Drive 批量下载 / 清空 / 导入到 Reels / 审核 / 批量重命名
            const st = await tryRenderer('download_query', {});
            return createPendingAction({
                kind: `download:${action}`,
                summary: `执行下载工具操作：${action}`,
                preview: { action, currentQueue: st, params: body },
                execute: () => callRenderer('download_action', body, 60000),
            });
        },

        // ==================== 17. 媒体转换、音频处理与水印 ====================
        async media_convert(body = {}) {
            const action = String(body?.action || 'media_info');
            if (action === 'media_info') {
                if (!body?.filePath || !fs.existsSync(body.filePath)) throw new Error('请提供有效文件路径 filePath');
                if (isBlockedSensitivePath(body.filePath)) throw new Error('安全策略拦截受保护路径');
                const info = await routeAPI('media/info', { file_path: body.filePath });
                const durationDetail = await ffmpegService.getDurationDetailed(body.filePath).catch(() => null);
                return { info, durationDetail };
            }
            if (action === 'detect_silence') {
                if (!body?.filePath || !fs.existsSync(body.filePath)) throw new Error('请提供有效文件路径 filePath');
                return ffmpegService.detectSilence(body.filePath, Number(body?.noiseDb ?? -35), Number(body?.minDuration ?? 0.35));
            }
            if (action === 'smart_split_analyze') {
                if (!body?.filePath || !fs.existsSync(body.filePath)) throw new Error('请提供有效音频路径 filePath');
                return ffmpegService.smartSplitAnalyze(body.filePath, Number(body?.maxDuration ?? 29));
            }
            if (action === 'waveform') {
                if (!body?.filePath || !fs.existsSync(body.filePath)) throw new Error('请提供有效音频路径 filePath');
                return routeAPI('media/waveform', { file_path: body.filePath });
            }
            if (action === 'audio_match_analyze') {
                return callRenderer('media_query', { action: 'audio_match_status' });
            }

            // 转换/裁切/拼接/音频替换/Logo/水印 → 均走两步确认并在后台运行
            const files = body?.files || (body?.filePath ? [body.filePath] : []);
            const { list, missing } = safeCheckFileArray(files, '媒体文件');
            if (missing.length) throw new Error(`找不到媒体文件：${missing[0]}`);
            const outputDir = body?.outputDir ? ensureSafeOutputDir(body.outputDir) : path.dirname(list[0]);
            const mode = String(body?.mode || action);

            return createPendingAction({
                kind: `media_convert:${mode}`,
                summary: `对 ${list.length} 个媒体文件执行「${mode}」处理`,
                preview: {
                    mode,
                    count: list.length,
                    files: list.slice(0, 10),
                    outputDir,
                    options: body?.options || {},
                },
                execute: () => startBgJob(`media_${mode}`, { count: list.length, mode, outputDir }, async ({ reportProgress }) => {
                    if (action === 'trim') {
                        return routeAPI('media/trim', { file_path: list[0], output_dir: outputDir, ...(body?.options || {}) });
                    }
                    if (action === 'concat_clips') {
                        return routeAPI('media/concat-clips', { clips: list, output_dir: outputDir, ...(body?.options || {}) });
                    }
                    if (action === 'replace_audio') {
                        return routeAPI('media/replace-audio', { video_path: list[0], audio_path: body?.audioPath, output_dir: outputDir, ...(body?.options || {}) });
                    }
                    if (action === 'smart_split') {
                        return routeAPI('media/smart-split', { file_path: list[0], output_dir: outputDir, ...(body?.options || {}) });
                    }
                    if (action === 'prepare_playback_delay') {
                        return routeAPI('media/prepare-playback-delay', { filePath: list[0], ...(body?.options || {}) });
                    }
                    const results = [];
                    for (let i = 0; i < list.length; i++) {
                        reportProgress({ current: i + 1, total: list.length, file: path.basename(list[i]) });
                        const r = await routeAPI('media/convert', {
                            file_path: list[i],
                            files: [list[i]],
                            mode,
                            output_dir: outputDir,
                            ...(body?.options || {}),
                        });
                        results.push({ file: list[i], result: r });
                    }
                    return { total: list.length, outputDir, results };
                }),
            });
        },

        // ==================== 18. 视觉分析、场景检测、截图、聚类与批量剪辑 ====================
        async media_analyze_cut(body = {}) {
            const action = String(body?.action || 'scene_detect');
            if (action === 'scene_detect') {
                if (!body?.filePath || !fs.existsSync(body.filePath)) throw new Error('请提供有效视频 filePath');
                return routeAPI('media/scene-detect', {
                    file_path: body.filePath,
                    threshold: body?.threshold,
                    min_scene_len: body?.minSceneLen,
                    ...(body?.options || {}),
                });
            }
            if (action === 'status') {
                return callRenderer('media_query', { action: 'analyze_cut_status' });
            }
            const outputDir = body?.outputDir ? ensureSafeOutputDir(body.outputDir) : '';
            const epMap = {
                scene_split: 'media/scene-split',
                scene_frames: 'media/scene-detect-frames',
                smart_keyframes: 'media/scene-export-frames',
                download_and_detect_frames: 'media/download-and-detect-frames',
                batch_thumbnail: 'media/batch-thumbnail',
                url_thumbnail: 'media/url-thumbnail',
                image_classify: 'media/image-classify',
                batch_cut: 'media/batch-cut',
                batch_cut_fcpxml: 'media/export-fcpxml-timeline',
            };
            const ep = epMap[action];
            if (!ep) throw new Error(`未知 media_analyze_cut action：${action}`);

            return createPendingAction({
                kind: `media_analyze_cut:${action}`,
                summary: `执行视觉分析/批量剪辑操作：${action}`,
                preview: {
                    action,
                    filePath: body?.filePath,
                    folderPath: body?.folderPath,
                    outputDir: outputDir || '(默认目录)',
                    moveFiles: body?.options?.move === true || body?.options?.mode === 'move',
                    warning: (body?.options?.move === true || body?.options?.mode === 'move') ? '当前为移动模式，会改变原素材位置！' : undefined,
                },
                execute: () => startBgJob(`media_${action}`, { action, outputDir }, () =>
                    routeAPI(ep, {
                        file_path: body?.filePath,
                        folder_path: body?.folderPath,
                        output_dir: outputDir || undefined,
                        ...(body?.options || {}),
                    })
                ),
            });
        },

        // ==================== 19. 命名与匹配工具（统一命名/批量重命名/语音命名/名字匹配） ====================
        async rename_match(body = {}) {
            const action = String(body?.action || 'rename_preview');
            if (action === 'speech_status') {
                return callRenderer('rename_match_query', { action: 'speech_status' });
            }
            if (action === 'speech_match') {
                return routeAPI('speech-rename/match', body?.params || body);
            }
            if (action === 'speech_compare') {
                return routeAPI('speech-rename/compare', body?.params || body);
            }
            if (action === 'name_match') {
                return callRenderer('rename_match_query', { action: 'name_match', original: body?.original, canonical: body?.canonical });
            }
            if (action === 'rename_preview') {
                return computeRenamePreview(body?.items || []);
            }
            if (action === 'speech_analyze' || action === 'speech_translate') {
                const ep = action === 'speech_analyze' ? 'speech-rename/analyze' : 'speech-rename/translate';
                return createPendingAction({
                    kind: `rename_match:${action}`,
                    summary: action === 'speech_analyze' ? '调用云端语音识别分析视频命名区间' : '调用 Gemini 将识别文案翻译为中文参考',
                    preview: { action, params: body?.params || body },
                    execute: () => routeAPI(ep, body?.params || body),
                });
            }
            if (action === 'speech_apply') {
                return createPendingAction({
                    kind: 'rename_match:speech_apply',
                    summary: `按语音匹配结果正式重命名 ${(body?.items || []).length} 个原视频文件`,
                    preview: { count: (body?.items || []).length, sample: (body?.items || []).slice(0, 10), warning: '会直接重命名原视频文件！' },
                    execute: () => routeAPI('speech-rename/apply', body?.params || body),
                });
            }
            if (action === 'uni_rename' || action === 'batch_rename') {
                const { plan, conflicts } = computeRenamePreview(body?.items || []);
                if (!plan.length) throw new Error('请提供 items 重命名映射数组（每项含 source 与 newName）');
                const copyMode = body?.copyMode !== false; // 默认更安全的复制模式
                return createPendingAction({
                    kind: `rename_match:${action}`,
                    summary: `${copyMode ? '复制并重命名' : '直接重命名原文件'} ${plan.length} 个文件`,
                    preview: {
                        copyMode,
                        count: plan.length,
                        conflicts,
                        sample: plan.slice(0, 15),
                        warning: copyMode ? '复制模式：保留原文件' : '覆盖改名模式：会直接修改原文件名！',
                    },
                    execute: async () => {
                        if (conflicts.length && !body?.ignoreConflicts) {
                            throw new Error(`存在命名冲突，已中止：${conflicts.slice(0, 3).join('；')}`);
                        }
                        const done = [];
                        for (const row of plan) {
                            if (!row.exists) continue;
                            fs.mkdirSync(path.dirname(row.target), { recursive: true });
                            if (copyMode) fs.copyFileSync(row.source, row.target);
                            else safeMoveFileSync(row.source, row.target);
                            done.push({ from: row.source, to: row.target });
                        }
                        return { copyMode, count: done.length, files: done };
                    },
                });
            }
            if (action === 'name_match_export') {
                const outputPath = ensureSafeOutputDir(body?.outputPath);
                if (!outputPath) throw new Error('请提供 outputPath 导出路径');
                assertSafeFileMutation(outputPath);
                return createPendingAction({
                    kind: 'rename_match:name_match_export',
                    summary: `导出名字匹配结果到 ${outputPath}`,
                    preview: { outputPath },
                    execute: async () => {
                        const res = await callRenderer('rename_match_query', { action: 'name_match_csv', includeHeader: body?.includeHeader !== false });
                        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
                        fs.writeFileSync(outputPath, String(res?.csv || ''), 'utf8');
                        return { ok: true, outputPath };
                    },
                });
            }
            throw new Error(`未知 rename_match action：${action}`);
        },

        // ==================== 20. 素材整理与多窗口整理 ====================
        async file_organizer(body = {}) {
            const action = String(body?.action || 'scan_dir');
            if (action === 'scan_dir') {
                const dirPath = String(body?.dirPath || '').trim();
                const files = listFilesRecursiveSafe(dirPath, {
                    maxDepth: body?.recursive === false ? 0 : (Number(body?.maxDepth) || 10),
                    limit: Math.min(2000, Math.max(1, Number(body?.limit) || 300)),
                    exts: body?.exts,
                });
                return { dirPath, count: files.length, files };
            }
            if (action === 'extract_filenames') {
                const dirPath = String(body?.dirPath || '').trim();
                const files = listFilesRecursiveSafe(dirPath, {
                    maxDepth: body?.recursive ? 10 : 0,
                    limit: 2000,
                });
                const stripExt = Boolean(body?.stripExt);
                const names = files.map((f) => (stripExt ? path.basename(f.name, path.extname(f.name)) : f.name));
                return { dirPath, count: names.length, names };
            }
            if (action === 'find_duplicates') {
                const filePaths = Array.isArray(body?.filePaths)
                    ? body.filePaths
                    : listFilesRecursiveSafe(String(body?.dirPath || ''), { maxDepth: 10, limit: 2000 }).map((f) => f.path);
                return findDuplicateFilesByHash(filePaths);
            }
            if (action === 'organize_preview') {
                return routeAPI('media/organize/preview', body?.params || body);
            }
            if (action === 'multiwindow_status') {
                return callRenderer('multiwindow_query', {});
            }

            // 所有写入/移动/合并/归集/去重/废纸篓 → 两步确认
            if (action === 'organize_apply') {
                const preview = await routeAPI('media/organize/preview', body?.params || body).catch(() => ({ note: '请核对整理规则参数' }));
                return createPendingAction({
                    kind: 'file_organizer:organize_apply',
                    summary: '执行素材规则智能整理并移动文件',
                    preview,
                    execute: () => routeAPI('media/organize/apply', body?.params || body),
                });
            }
            if (action === 'organize_undo') {
                return createPendingAction({
                    kind: 'file_organizer:organize_undo',
                    summary: '撤销上一次素材规则整理',
                    preview: {},
                    execute: () => routeAPI('media/organize/undo', body?.params || body),
                });
            }
            if (action === 'trash_files' || action === 'remove_duplicates') {
                const { list, missing } = safeCheckFileArray(body?.filePaths, '待处理文件');
                const existing = list.filter((p) => !missing.includes(p));
                if (!existing.length) throw new Error('没有找到可操作的文件');
                return createPendingAction({
                    kind: `file_organizer:${action}`,
                    summary: action === 'remove_duplicates'
                        ? `将 ${existing.length} 个重复文件移入系统废纸篓`
                        : `将 ${existing.length} 个文件移入系统废纸篓`,
                    preview: {
                        count: existing.length,
                        files: existing.slice(0, 20),
                        warning: '文件将被移入系统废纸篓，请仔细核对路径列表！',
                    },
                    execute: async () => {
                        const trashed = [];
                        for (const p of existing) {
                            assertSafeFileMutation(p);
                            await shell.trashItem(p);
                            trashed.push(p);
                        }
                        return { trashedCount: trashed.length, trashed };
                    },
                });
            }
            if (action === 'copy_files' || action === 'move_files') {
                const { list, missing } = safeCheckFileArray(body?.filePaths, '源文件');
                if (missing.length) throw new Error(`源文件不存在：${missing[0]}`);
                const targetDir = ensureSafeOutputDir(body?.targetDir);
                if (!targetDir) throw new Error('请提供 targetDir 目标目录');
                return createPendingAction({
                    kind: `file_organizer:${action}`,
                    summary: `${action === 'copy_files' ? '复制' : '移动'} ${list.length} 个文件到 ${targetDir}`,
                    preview: {
                        mode: action,
                        count: list.length,
                        files: list.slice(0, 15),
                        targetDir,
                    },
                    execute: async () => {
                        fs.mkdirSync(targetDir, { recursive: true });
                        const done = [];
                        for (const src of list) {
                            const dest = path.join(targetDir, assertSafeSingleFileName(path.basename(src)));
                            assertSafeFileMutation(dest);
                            if (action === 'copy_files') fs.copyFileSync(src, dest);
                            else safeMoveFileSync(src, dest);
                            done.push({ from: src, to: dest });
                        }
                        return { count: done.length, targetDir, files: done };
                    },
                });
            }
            if (action === 'create_folder') {
                const parentDir = ensureSafeOutputDir(body?.parentDir);
                const folderName = assertSafeSingleFileName(body?.folderName);
                const full = path.join(parentDir, folderName);
                assertSafeFileMutation(full);
                return createPendingAction({
                    kind: 'file_organizer:create_folder',
                    summary: `新建文件夹：${full}`,
                    preview: { path: full },
                    execute: () => {
                        fs.mkdirSync(full, { recursive: true });
                        return { ok: true, path: full };
                    },
                });
            }
            // 多窗口整理 / 合并 / 平铺归集 / 上传模式
            const st = await tryRenderer('multiwindow_query', {});
            return createPendingAction({
                kind: `file_organizer:${action}`,
                summary: `执行整理工作台操作：${action}`,
                preview: { action, currentState: st, params: body },
                execute: () => callRenderer('multiwindow_action', body, 60000),
            });
        },

        // ==================== 21. 电话卡片工坊（Tab 10） ====================
        async phone_cards(body = {}) {
            const action = String(body?.action || 'status');
            if (action === 'status') {
                return callRenderer('phone_cards_query', {});
            }
            const cur = await tryRenderer('phone_cards_query', {});
            return createPendingAction({
                kind: `phone_cards:${action}`,
                summary: `执行电话卡片工坊操作：${action}`,
                preview: { action, currentStatus: cur, params: body },
                execute: () => callRenderer('phone_cards_action', body, 60000),
            });
        },

        // ==================== 22. 设置、缓存与诊断（Tab 11，绝不泄露明文密钥） ====================
        async settings(body = {}) {
            const action = String(body?.action || 'overview');
            if (action === 'overview') {
                const userDataPath = getUserDataDir();
                const uiSettings = await tryRenderer('settings_query', {});
                return {
                    elevenlabs: settingsService.getPublicElevenLabsSettings(),
                    elevenlabsKeys: settingsService.getPublicElevenLabsKeysWithStatus(),
                    gladia: settingsService.getPublicGladiaKeys(),
                    transcriptionProviders: settingsService.getPublicTranscriptionProviders(),
                    gemini: settingsService.getPublicGeminiKeys(),
                    replaceRules: settingsService.loadReplaceRules(),
                    presetLibrary: persistentPresetStore.presetFolderLibrary.info(),
                    cache: getCacheSummary(userDataPath),
                    ui: uiSettings,
                    note: '所有 API Key 与 Token 均已脱敏处理，AI 无法读取明文密钥。',
                };
            }
            if (action === 'cache_info') {
                return getCacheSummary(getUserDataDir());
            }
            if (action === 'crash_diagnostic') {
                return { latest: getLatestRendererCrashReport ? getLatestRendererCrashReport() : null };
            }
            if (action === 'app_log') {
                const linesCount = Math.min(200, Math.max(1, Number(body?.lines) || 60));
                const logFile = logDir ? path.join(logDir, 'app.log') : path.join(getUserDataDir(), 'logs', 'app.log');
                if (!fs.existsSync(logFile)) return { exists: false, lines: [] };
                const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').slice(-linesCount);
                return { exists: true, logFile, count: lines.length, lines };
            }
            if (action === 'test_keys') {
                const target = String(body?.target || 'all');
                const out = {};
                if (target === 'all' || target === 'gemini') {
                    const g = settingsService.loadGeminiKeys();
                    out.gemini = (g?.keys?.length)
                        ? await routeAPI('ai/test-keys', { keys: g.keys.map((k) => settingsService.maskApiKey(k)), model: g.model }).catch((e) => ({ error: e.message }))
                        : { configured: false };
                }
                if (target === 'all' || target === 'google_tts') {
                    out.googleTts = await routeAPI('google-tts/test-keys', {}).catch((e) => ({ error: e.message }));
                }
                if (target === 'all' || target === 'elevenlabs') {
                    out.elevenlabsWeb = await routeAPI('elevenlabs/web-status', {}).catch((e) => ({ error: e.message }));
                }
                return out;
            }
            if (action === 'clear_cache') {
                const includeAutoEditCache = Boolean(body?.includeAutoEditCache);
                const before = getCacheSummary(getUserDataDir());
                const expectedSize = includeAutoEditCache ? before.grandTotalHuman : before.totalHuman;
                return createPendingAction({
                    kind: 'settings:clear_cache',
                    summary: `清理 VideoKit 运行缓存（约 ${expectedSize}${includeAutoEditCache ? '，含自动剪辑缓存' : ''}）`,
                    preview: { cache: before, includeAutoEditCache, note: '绝不会删除预设、模板、API Key、设置或已导出的成片' },
                    execute: () => clearCacheDirs(getUserDataDir(), { includeAutoEditCache }),
                });
            }
            if (action === 'update_transcription_providers') {
                return createPendingAction({
                    kind: 'settings:update_transcription_providers',
                    summary: '修改云端转录主用平台或并发数',
                    preview: { primary: body?.primary, concurrency: body?.concurrency },
                    execute: () => {
                        const cur = settingsService.loadTranscriptionProviders();
                        const next = {
                            ...cur,
                            ...(body?.primary ? { primary: String(body.primary) } : {}),
                            ...(Number(body?.concurrency) > 0 ? { concurrency: Math.min(50, Math.max(1, Math.round(Number(body.concurrency)))) } : {}),
                        };
                        settingsService.saveTranscriptionProviders(next);
                        return settingsService.getPublicTranscriptionProviders();
                    },
                });
            }
            if (action === 'update_replace_rules') {
                if (!body?.rules || typeof body.rules !== 'object') throw new Error('请提供 rules 对象');
                return createPendingAction({
                    kind: 'settings:update_replace_rules',
                    summary: '更新翻译文本替换规则',
                    preview: { languages: Object.keys(body.rules) },
                    execute: () => {
                        settingsService.saveReplaceRules(body.rules);
                        return { ok: true };
                    },
                });
            }
            if (action === 'update_output_dir' || action === 'update_theme_scale') {
                if (body?.outputDir) ensureSafeOutputDir(body.outputDir);
                return createPendingAction({
                    kind: `settings:${action}`,
                    summary: `更新界面/目录设置：${action}`,
                    preview: body,
                    execute: () => callRenderer('settings_action', body),
                });
            }
            throw new Error(`未知 settings action：${action}`);
        },

        // ==================== 23. 受控通用检视与路由接口 ====================
        async renderer_action(body = {}) {
            const mode = String(body?.mode || 'inspect');
            if (mode === 'inspect') {
                return callRenderer('renderer_inspect', {
                    selector: body?.selector,
                });
            }
            if (mode === 'api_call') {
                const endpoint = String(body?.endpoint || '').replace(/^\/?(api\/)?/, '').trim();
                if (!endpoint) throw new Error('请提供后端路由 endpoint');
                if (BLOCKED_API_ENDPOINTS.has(endpoint) || /reveal-keys|web-logout|web-token/i.test(endpoint)) {
                    throw new Error(`安全策略拦截：不允许通过通用接口调用受保护的密钥/凭据路由「${endpoint}」`);
                }
                return createPendingAction({
                    kind: `renderer_action:api_call:${endpoint}`,
                    summary: `调用后端路由 ${endpoint}`,
                    preview: { endpoint, data: body?.data || {} },
                    execute: () => routeAPI(endpoint, body?.data || {}),
                });
            }
            throw new Error('未知 mode，支持：inspect（安全 DOM 检视）/ api_call（需两步确认）');
        },
    };
}

module.exports = {
    createHandlers,
    BLOCKED_API_ENDPOINTS,
};
