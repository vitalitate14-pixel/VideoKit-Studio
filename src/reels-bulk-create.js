/**
 * reels-bulk-create.js — 大量制作模块 v2
 * 工程模版 × 数据表格 = 批量任务
 * - 模板来源: 当前工程 tasks（含背景/覆层/音频）
 * - 每个模板独立绑定列
 * - 素材自动循环，填写则覆盖
 */

const _bulkState = {
    columns: [
        { name: '原始完整文案', type: 'text' },
        { name: '标题', type: 'text' },
        { name: '正文', type: 'text' },
    ],
    rows: [],
    rowPresetMode: false,
    rowTemplateIds: [],
    cellPresetMode: false,
    cellTemplateIds: [],
    // templates: [{ task: {...}, label: '', bindings: { title_text: colIdx, ... } }]
    templates: [],
    backgroundFolders: [],
    // 独立于背景库：只用于替换覆层里的 image/video，不会改 bgPath 或时间线插入片段。
    overlayMediaFolders: [],
    // Logo 媒体库与“替换模板中的覆层媒体”分离。每一项要么是一个单独
    // 文件，要么是一个递归读取的文件夹；任务组只追加一个标准媒体覆层。
    logoMediaLibrary: [],
    musicFiles: [],
    groupAssignments: null,
    // 仅在用户明确选择“清空表头但保留绑定”时保存。这样右侧会提示缺少
    // 表头；普通粘贴替换则不会把上一张表的旧组残留在右侧。
    missingHeaderGroupKeys: [],
    retainedHeaderColumns: [],
    allowTemplateReuse: false,
    allowBackgroundReuse: false,
    allowMusicReuse: false,
    filterUnassignedTemplates: false,
    filterUnassignedBackgrounds: false,
    filterUnassignedMusic: false,
    filterUnassignedGroups: false,
    taskNamingMode: '',
    taskNamingCustomPattern: '',
    taskGroupNamingMode: '',
    taskGroupCustomPattern: '',
    collapsedSections: {
        templates: false,
        backgrounds: false,
        music: false,
        groups: false,
    },
};

if (typeof window !== 'undefined') {
    window._reelsBulkState = _bulkState;
}

const BC_DRAFT_KEY = 'reels_bulk_create_last_state';
let _bcDraftLoaded = false;
let _bcDraftSaveTimer = null;

let _bcSelection = null;
let _bcIsSelecting = false;
let _bcModalAbort = null;

function _bcNormalizeStateShape() {
    if (!Array.isArray(_bulkState.columns) || _bulkState.columns.length === 0) {
        _bulkState.columns = [
            { name: '原始完整文案', type: 'text' },
            { name: '标题', type: 'text' },
            { name: '正文', type: 'text' },
        ];
    }
    if (!Array.isArray(_bulkState.rows)) _bulkState.rows = [];
    if (!Array.isArray(_bulkState.templates)) _bulkState.templates = [];
    if (!Array.isArray(_bulkState.rowTemplateIds)) _bulkState.rowTemplateIds = [];
    if (!Array.isArray(_bulkState.cellTemplateIds)) _bulkState.cellTemplateIds = [];
    _bulkState.templates.forEach(tpl => {
        if (!tpl.bulkTemplateId) tpl.bulkTemplateId = 'bc_' + (globalThis.crypto?.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2));
    });
    if (!Array.isArray(_bulkState.backgroundFolders)) _bulkState.backgroundFolders = [];
    if (!Array.isArray(_bulkState.overlayMediaFolders)) _bulkState.overlayMediaFolders = [];
    if (!Array.isArray(_bulkState.logoMediaLibrary)) _bulkState.logoMediaLibrary = [];
    if (!Array.isArray(_bulkState.musicFiles)) _bulkState.musicFiles = [];
    if (!Array.isArray(_bulkState.missingHeaderGroupKeys)) _bulkState.missingHeaderGroupKeys = [];
    if (typeof _bulkState.allowTemplateReuse !== 'boolean') _bulkState.allowTemplateReuse = false;
    if (typeof _bulkState.allowBackgroundReuse !== 'boolean') _bulkState.allowBackgroundReuse = false;
    if (typeof _bulkState.allowMusicReuse !== 'boolean') _bulkState.allowMusicReuse = false;
    if (typeof _bulkState.filterUnassignedTemplates !== 'boolean') _bulkState.filterUnassignedTemplates = false;
    if (typeof _bulkState.filterUnassignedBackgrounds !== 'boolean') _bulkState.filterUnassignedBackgrounds = false;
    if (typeof _bulkState.filterUnassignedMusic !== 'boolean') _bulkState.filterUnassignedMusic = false;
    if (typeof _bulkState.filterUnassignedGroups !== 'boolean') _bulkState.filterUnassignedGroups = false;
    if (!_bulkState.collapsedSections || typeof _bulkState.collapsedSections !== 'object') {
        _bulkState.collapsedSections = {
            templates: false,
            backgrounds: false,
            music: false,
            groups: false,
        };
    }

    _bulkState.rows = _bulkState.rows.map(row => Array.isArray(row) ? row : []);
    _bulkState.rows.forEach(row => {
        while (row.length < _bulkState.columns.length) row.push('');
        if (row.length > _bulkState.columns.length) row.length = _bulkState.columns.length;
    });
    _bulkState.cellTemplateIds = _bulkState.rows.map((_, index) => _bulkState.cellTemplateIds[index] || {});
    _bulkState.rowTemplateIds = _bulkState.rows.map((_, index) => Array.isArray(_bulkState.rowTemplateIds[index]) ? _bulkState.rowTemplateIds[index] : []);
}

function _bcLoadDraftOnce() {
    if (_bcDraftLoaded) return;
    _bcDraftLoaded = true;

    try {
        const raw = localStorage.getItem(BC_DRAFT_KEY);
        if (!raw) return;
        const draft = JSON.parse(raw);
        if (!draft || draft.type !== 'bulk_create_draft') return;
        if (!Array.isArray(draft.columns)) return;

        _bulkState.backgroundFolders = draft.backgroundFolders || [];
        _bulkState.overlayMediaFolders = draft.overlayMediaFolders || [];
        _bulkState.logoMediaLibrary = draft.logoMediaLibrary || [];
        _bulkState.musicFiles = draft.musicFiles || [];
        _bulkState.groupAssignments = draft.groupAssignments || null;
        _bulkState.rowPresetMode = !!draft.rowPresetMode;
        _bulkState.rowTemplateIds = draft.rowTemplateIds || [];
        _bulkState.cellPresetMode = !!draft.cellPresetMode;
        _bulkState.cellTemplateIds = draft.cellTemplateIds || [];
        _bulkState.missingHeaderGroupKeys = Array.isArray(draft.missingHeaderGroupKeys)
            ? draft.missingHeaderGroupKeys : [];
        _bulkState.retainedHeaderColumns = draft.retainedHeaderColumns || [];
        _bulkState.allowTemplateReuse = !!draft.allowTemplateReuse;
        _bulkState.allowBackgroundReuse = !!draft.allowBackgroundReuse;
        _bulkState.allowMusicReuse = !!draft.allowMusicReuse;
        _bulkState.filterUnassignedTemplates = !!draft.filterUnassignedTemplates;
        _bulkState.filterUnassignedBackgrounds = !!draft.filterUnassignedBackgrounds;
        _bulkState.filterUnassignedMusic = !!draft.filterUnassignedMusic;
        _bulkState.filterUnassignedGroups = !!draft.filterUnassignedGroups;
        if (draft.taskNamingMode) _bulkState.taskNamingMode = draft.taskNamingMode;
        if (draft.taskNamingCustomPattern) _bulkState.taskNamingCustomPattern = draft.taskNamingCustomPattern;
        if (draft.taskGroupNamingMode) _bulkState.taskGroupNamingMode = draft.taskGroupNamingMode;
        if (draft.taskGroupCustomPattern) _bulkState.taskGroupCustomPattern = draft.taskGroupCustomPattern;
        if (draft.collapsedSections && typeof draft.collapsedSections === 'object') {
            _bulkState.collapsedSections = {
                templates: !!draft.collapsedSections.templates,
                backgrounds: !!draft.collapsedSections.backgrounds,
                music: !!draft.collapsedSections.music,
                groups: !!draft.collapsedSections.groups,
            };
        }
        _bulkState.columns = JSON.parse(JSON.stringify(draft.columns));
        _bulkState.rows = Array.isArray(draft.rows) ? JSON.parse(JSON.stringify(draft.rows)) : [];
        _bulkState.templates = Array.isArray(draft.templates)
            ? draft.templates.map(t => ({
                bulkTemplateId: t.bulkTemplateId,
                task: t.task || {},
                label: t.label || '模板',
                bindings: { ...(t.bindings || {}) },
                bgCycle: t.bgCycle || null,
                source: t.source || null,
                materialFolder: t.materialFolder || null,
            }))
            : [];

        // ★ 修复旧草稿：检测并清除错误的跨模板共享 bgCycle
        // 如果多个模板有完全相同的 bgCycle，说明是旧 bug 造成的，需要清除
        if (_bulkState.templates.length > 1) {
            const bgCycleStrs = _bulkState.templates
                .filter(t => t.bgCycle && t.bgCycle.length > 0)
                .map(t => JSON.stringify(t.bgCycle));
            const uniqueCycles = new Set(bgCycleStrs);
            if (bgCycleStrs.length > 1 && uniqueCycles.size === 1) {
                // 所有模板共享同一个 bgCycle → 是旧 bug，清除
                console.warn('[BulkCreate] 检测到旧草稿的错误 bgCycle（跨模板共享），已自动清除');
                _bulkState.templates.forEach(t => t.bgCycle = null);
            }
        }

        _bcNormalizeStateShape();
    } catch (e) {
        console.warn('[BulkCreate] 恢复上次草稿失败:', e);
    }
}

function _bcRestoreDraft() {
    _bcDraftLoaded = false;
    _bcLoadDraftOnce();
}

function _bcSanitizeTaskForDraft(task) {
    if (!task || typeof task !== 'object') return {};
    const clone = JSON.parse(JSON.stringify(task));
    delete clone._video;
    delete clone._bgThumb;
    Object.keys(clone).forEach(k => {
        if (k.startsWith('_dom') || k.startsWith('_el') || k.startsWith('_canvas')) {
            delete clone[k];
        }
    });
    if (clone.bgSrcUrl && String(clone.bgSrcUrl).startsWith('blob:')) clone.bgSrcUrl = null;
    if (clone.srcUrl && String(clone.srcUrl).startsWith('blob:')) clone.srcUrl = null;
    if (clone.cover?.previewUrl && String(clone.cover.previewUrl).startsWith('data:')) {
        clone.cover = { ...clone.cover };
        delete clone.cover.previewUrl;
    }
    if (clone._thumbUrl && String(clone._thumbUrl).startsWith('data:')) {
        delete clone._thumbUrl;
    }
    if (Array.isArray(clone.overlays)) {
        clone.overlays.forEach(ov => {
            if (ov && typeof ov === 'object') {
                delete ov._thumb;
                delete ov._thumbUrl;
                Object.keys(ov).forEach(k => {
                    if (k.startsWith('_dom') || k.startsWith('_el') || k.startsWith('_canvas')) {
                        delete ov[k];
                    }
                });
            }
        });
    }
    return clone;
}

function _bcSaveDraftNow() {
    try {
        _bcNormalizeStateShape();
        const draft = {
            type: 'bulk_create_draft',
            rowPresetMode: _bulkState.rowPresetMode,
            rowTemplateIds: _bulkState.rowTemplateIds,
            cellPresetMode: _bulkState.cellPresetMode, cellTemplateIds: _bulkState.cellTemplateIds,
            backgroundFolders: _bulkState.backgroundFolders,
            overlayMediaFolders: _bulkState.overlayMediaFolders,
            logoMediaLibrary: _bulkState.logoMediaLibrary,
            musicFiles: _bulkState.musicFiles,
            groupAssignments: _bulkState.groupAssignments,
            missingHeaderGroupKeys: _bulkState.missingHeaderGroupKeys,
            retainedHeaderColumns: _bulkState.retainedHeaderColumns,
            allowTemplateReuse: _bulkState.allowTemplateReuse,
            allowBackgroundReuse: _bulkState.allowBackgroundReuse,
            allowMusicReuse: _bulkState.allowMusicReuse,
            filterUnassignedTemplates: _bulkState.filterUnassignedTemplates,
            filterUnassignedBackgrounds: _bulkState.filterUnassignedBackgrounds,
            filterUnassignedMusic: _bulkState.filterUnassignedMusic,
            filterUnassignedGroups: _bulkState.filterUnassignedGroups,
            taskNamingMode: document.getElementById('bc-task-naming-mode')?.value
                || _bulkState.taskNamingMode
                || (typeof localStorage !== 'undefined' ? localStorage.getItem('reels_bulk_task_naming_mode') : '')
                || 'custom',
            taskNamingCustomPattern: document.getElementById('bc-task-naming-custom')?.value || _bulkState.taskNamingCustomPattern || '{任务组}_{标题}_{Logo}_{序号}',
            taskGroupNamingMode: document.getElementById('bc-task-group-naming-mode')?.value || _bulkState.taskGroupNamingMode || 'group_bg',
            taskGroupCustomPattern: document.getElementById('bc-task-group-custom')?.value || _bulkState.taskGroupCustomPattern || '',
            collapsedSections: _bulkState.collapsedSections || {},
            version: 6,
            columns: JSON.parse(JSON.stringify(_bulkState.columns)),
            rows: JSON.parse(JSON.stringify(_bulkState.rows)),
            templates: _bulkState.templates.map(t => ({
                bulkTemplateId: t.bulkTemplateId,
                task: _bcSanitizeTaskForDraft(t.task || {}),
                label: t.label || '',
                bindings: { ...(t.bindings || {}) },
                bgCycle: t.bgCycle || null,
                source: t.source || null,
                materialFolder: t.materialFolder || null,
            })),
            savedAt: new Date().toISOString(),
        };
        try {
            localStorage.setItem(BC_DRAFT_KEY, JSON.stringify(draft));
        } catch (storageErr) {
            if (window.reelsBulkStorageMode === 'disk' || storageErr?.name !== 'QuotaExceededError') throw storageErr;
            console.warn('[BulkCreate] 完整草稿保存超出配额，尝试降级精简保存:', storageErr);
            draft.templates.forEach(t => {
                if (t.task) {
                    delete t.task.segments;
                    delete t.task.words;
                    delete t.task.history;
                }
            });
            localStorage.setItem(BC_DRAFT_KEY, JSON.stringify(draft));
        }
        const backupButton = document.getElementById('bc-backup-current');
        if (backupButton) { backupButton.textContent = '⬇ 备份当前工程'; backupButton.style.color = ''; backupButton.title = '直接下载当前工程备份'; }
    } catch (e) {
        console.warn('[BulkCreate] 保存上次草稿失败:', e);
        const button = document.getElementById('bc-backup-current');
        if (button) { button.textContent = '⚠ 自动保存失败，请备份当前工程'; button.style.color = '#fca5a5'; button.title = String(e.message || e); }
    }
}

function _bcScheduleDraftSave() {
    if (_bcDraftSaveTimer) clearTimeout(_bcDraftSaveTimer);
    _bcDraftSaveTimer = setTimeout(() => {
        _bcDraftSaveTimer = null;
        _bcSaveDraftNow();
    }, 250);
}

// ★ bgCycle 只在「统一模式」或手动设置时生效，不跨模板自动合并
function _bcAutoPopulateBgCycle() {
    // 不再自动跨模板合并背景 — 每个模板保留自己的 bgPath
    // bgCycle 仅通过「统一模式导入」或「手动设置背景循环」按钮设置
}

function _bcNormalizeMediaPathForCycle(path) {
    let p = String(path || '').trim();
    if (!p) return '';
    if (/^local-media:\/\//i.test(p)) p = p.replace(/^local-media:\/\//i, '');
    if (/^file:\/\//i.test(p)) {
        try { p = decodeURIComponent(new URL(p).pathname); } catch (_) { p = p.replace(/^file:\/\//i, ''); }
    }
    return p;
}

function _bcAddUniqueCyclePath(list, path) {
    const p = _bcNormalizeMediaPathForCycle(path);
    if (p && !list.includes(p)) list.push(p);
}

function _bcCollectTaskBackgroundCycle(task) {
    const out = [];
    if (!task) return out;
    if (Array.isArray(task.bgClipPool)) {
        task.bgClipPool.forEach(p => _bcAddUniqueCyclePath(out, p));
    }
    _bcAddUniqueCyclePath(out, task.bgPath);
    _bcAddUniqueCyclePath(out, task.videoPath);
    _bcAddUniqueCyclePath(out, task.backgroundPath);
    _bcAddUniqueCyclePath(out, task.cover?.bgPath);
    return out;
}

function _bcTemplateBgCycle(task) {
    const cycle = _bcCollectTaskBackgroundCycle(task);
    return cycle.length > 1 ? cycle : null;
}

function _bcCollectProjectBackgroundCycle(projectData) {
    const out = [];
    const library = Array.isArray(projectData?.backgroundLibrary) ? projectData.backgroundLibrary : [];
    library.forEach(item => {
        if (typeof item === 'string') _bcAddUniqueCyclePath(out, item);
        else _bcAddUniqueCyclePath(out, item?.path || item?.filePath || item?.videoPath || item?.bgPath);
    });
    return out;
}

function _bcResolveTemplateBgCycle(task, projectCycle = null) {
    const scoped = _bcTemplateBgCycle(task);
    if (scoped && scoped.length > 1) return scoped;
    return projectCycle && projectCycle.length > 1 ? projectCycle : null;
}

function _bcDeserializeProjectTasks(projectData) {
    let safeTasks = projectData?.tasks || [];
    if (typeof ReelsProject !== 'undefined' && ReelsProject.applyProjectData) {
        try {
            const restored = ReelsProject.applyProjectData(projectData || { version: '2.0.0', tasks: safeTasks });
            if (restored && Array.isArray(restored.tasks)) safeTasks = restored.tasks;
        } catch(e) {
            console.error('[BulkCreate] Error safely deserializing tasks:', e);
        }
    }
    return safeTasks;
}

function _bcCloneTemplateTask(task) {
    const clone = JSON.parse(JSON.stringify(task || {}));
    delete clone._video; delete clone._bgThumb;
    if (clone.bgSrcUrl && String(clone.bgSrcUrl).startsWith('blob:')) clone.bgSrcUrl = null;
    if (clone.srcUrl && String(clone.srcUrl).startsWith('blob:')) clone.srcUrl = null;
    return clone;
}

function _bcApplySingleBackground(task, path) {
    const p = _bcNormalizeMediaPathForCycle(path);
    if (!task || !p) return;
    task.bgPath = p;
    task.videoPath = p;
    task.bgSrcUrl = null;
    task.srcUrl = null;
    task.bgMode = 'single';
    task.bgClipPool = [];
}

// 选择背景循环文件
function _bcPickBgCycleFiles(tpl, ti) {
    if (window.electronAPI && window.electronAPI.showOpenDialog) {
        window.electronAPI.showOpenDialog({
            title: '选择背景素材文件（可多选）',
            properties: ['openFile', 'multiSelections'],
            filters: [
                { name: '视频/图片', extensions: ['mp4','mov','avi','mkv','webm','jpg','jpeg','png','webp','gif'] }
            ]
        }).then(result => {
            if (result && result.filePaths && result.filePaths.length > 0) {
                if (!tpl.bgCycle) tpl.bgCycle = [];
                result.filePaths.forEach(p => { if (!tpl.bgCycle.includes(p)) tpl.bgCycle.push(p); });
                console.log(`[BulkCreate] 模板「${tpl.label}」设置背景循环: ${tpl.bgCycle.length} 个素材`);
                _bcRenderBindings();
                _bcScheduleDraftSave();
            }
        });
    } else {
        alert('请在桌面版中使用此功能');
    }
}

const BC_FOLDER_BG_EXTS = new Set(['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v', 'jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp']);
const BC_FOLDER_OVERLAY_EXTS = new Set(['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v', 'jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp']);

async function _bcImportOverlayMediaFolders(paths) {
    if (!window.electronAPI?.scanDirectoryRecursive) { alert('请在桌面版中导入覆层媒体文件夹'); return; }
    const errors = [];
    for (const path of [...new Set(paths)]) {
        try {
            const entries = await window.electronAPI.scanDirectoryRecursive(path, { maxDepth: 20 });
            const files = (entries || []).filter(item => !item.isDirectory && item.path && BC_FOLDER_OVERLAY_EXTS.has(_bcFileExt(item.name || item.path)))
                .sort((a, b) => String(a.name || a.path).localeCompare(String(b.name || b.path), undefined, { numeric: true })).map(item => item.path);
            const folder = { path, name: _bcFileName(path), files, recursive: true };
            const i = _bulkState.overlayMediaFolders.findIndex(item => item.path === path);
            if (i < 0) _bulkState.overlayMediaFolders.push(folder); else _bulkState.overlayMediaFolders[i] = folder;
        } catch (error) { errors.push(`${_bcFileName(path)}：${error.message || error}`); }
    }
    _bcRenderBindings(); _bcScheduleDraftSave();
    if (errors.length) alert(`部分覆层媒体文件夹读取失败：\n${errors.join('\n')}`);
}

function _bcLogoSourceId(kind, path) { return `${kind}:${path}`; }

async function _bcImportLogoMediaFolders(paths) {
    if (!window.electronAPI?.scanDirectoryRecursive) { alert('请在桌面版中导入 Logo 媒体文件夹'); return; }
    const errors = [];
    for (const path of [...new Set(paths)]) {
        try {
            const entries = await window.electronAPI.scanDirectoryRecursive(path, { maxDepth: 20 });
            const files = (entries || []).filter(item => !item.isDirectory && item.path && BC_FOLDER_OVERLAY_EXTS.has(_bcFileExt(item.name || item.path)))
                .sort((a, b) => String(a.name || a.path).localeCompare(String(b.name || b.path), undefined, { numeric: true })).map(item => item.path);
            const source = { id: _bcLogoSourceId('folder', path), kind: 'folder', path, name: _bcFileName(path), files, recursive: true };
            const i = _bulkState.logoMediaLibrary.findIndex(item => item.id === source.id);
            if (i < 0) _bulkState.logoMediaLibrary.push(source); else _bulkState.logoMediaLibrary[i] = source;
        } catch (error) { errors.push(`${_bcFileName(path)}：${error.message || error}`); }
    }
    _bcRenderBindings(); _bcScheduleDraftSave();
    if (errors.length) alert(`部分 Logo 媒体文件夹读取失败：\n${errors.join('\n')}`);
}

function _bcImportLogoMediaFiles(paths) {
    [...new Set(paths)].forEach(path => {
        if (!path || !BC_FOLDER_OVERLAY_EXTS.has(_bcFileExt(path))) return;
        const source = { id: _bcLogoSourceId('file', path), kind: 'file', path, name: _bcFileName(path), files: [path] };
        if (!_bulkState.logoMediaLibrary.some(item => item.id === source.id)) _bulkState.logoMediaLibrary.push(source);
    });
    _bcRenderBindings(); _bcScheduleDraftSave();
}

function _bcDefaultLogoOverlay() {
    // 与外部“新增图片覆层”使用完全相同的工厂；只把时长设为整条任务。
    const maker = window.ReelsOverlay?.createImageOverlay || window.createImageOverlay;
    const overlay = maker ? maker({ content: '', end: 9999 }) : {
        id: `bulk-logo-${Date.now()}`, type: 'image', content: '', x: 0, y: 0, w: 1080, h: 1920,
        rotation: 0, opacity: 255, scale: 1, scale_x: 1, scale_y: 1, start: 0, end: 9999,
        flip_x: false, flip_y: false, keep_aspect: true, blend_mode: 'source-over', transition_preset: 'none', transition_duration: .35,
        anim_in_type: 'none', anim_out_type: 'none', anim_in_duration: .3, anim_out_duration: .3,
    };
    overlay._bulkLogoOverlay = true;
    return overlay;
}

function _bcApplyGroupLogoOverlay(task, tpl, index) {
    const config = tpl.logoOverlay;
    if (!config?.enabled || !config.sourceId) return;
    const source = _bulkState.logoMediaLibrary.find(item => item.id === config.sourceId);
    if (!source?.files?.length) throw new Error('任务组选择的 Logo 媒体不存在或已被移除，请重新分配');
    const files = source.files;
    const file = config.taskMode === 'random' ? files[Math.floor(Math.random() * files.length)] : files[index % files.length];
    const overlay = JSON.parse(JSON.stringify(config.overlay || _bcDefaultLogoOverlay()));
    overlay.id = (window.ReelsOverlay?._overlayId?.() || `bulk-logo-${Date.now()}-${index}`);
    overlay.content = file;
    overlay.type = ['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v'].includes(_bcFileExt(file)) ? 'video' : 'image';
    overlay._bulkLogoOverlay = true;
    overlay.logoMediaSourceId = source.id;
    if (!Array.isArray(task.overlays)) task.overlays = [];
    // 只追加，绝不替换模板既有的文字卡、字幕或其它覆层。默认放在文字
    // 覆层之前，防止全屏 Logo 盖住文案；用户也可明确选择置顶。
    const top = config.stackPosition === 'above';
    if (top) task.overlays.push(overlay);
    else {
        const firstText = task.overlays.findIndex(item => ['text', 'textcard', 'scroll'].includes(item?.type));
        task.overlays.splice(firstText < 0 ? task.overlays.length : firstText, 0, overlay);
    }
}

function _bcEditGroupLogoOverlay(groupKey) {
    const entry = (_bulkState.groupAssignments || []).find(item => item.key === groupKey);
    if (!entry || typeof ReelsOverlayPanel === 'undefined' || !window.ReelsOverlay?.OverlayManager) {
        alert('覆层编辑器尚未加载'); return;
    }
    entry.logoOverlay = entry.logoOverlay || { enabled: true, sourceId: '', taskMode: 'cycle', stackPosition: 'below', overlay: _bcDefaultLogoOverlay() };
    const mgr = new window.ReelsOverlay.OverlayManager();
    mgr.addOverlay(JSON.parse(JSON.stringify(entry.logoOverlay.overlay || _bcDefaultLogoOverlay())));
    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;inset:0;z-index:450000;background:#000d;display:flex;align-items:center;justify-content:center;';
    modal.innerHTML = `<div style="width:min(96vw,980px);height:min(92vh,760px);background:#181822;border:1px solid #45405e;border-radius:10px;display:flex;flex-direction:column;overflow:hidden;color:#ddd;"><div style="padding:10px 14px;border-bottom:1px solid #343447;display:flex;justify-content:space-between;align-items:center;"><div><strong>🖼 编辑任务组 Logo 媒体覆层</strong><span style="font-size:11px;color:#aaa;margin-left:8px;">与外部图片/视频覆层完全相同的参数</span></div><button data-close style="background:#292938;color:#ddd;border:1px solid #555;border-radius:4px;padding:4px 10px;cursor:pointer;">完成</button></div><div data-panel style="flex:1;min-height:0;overflow:auto;"></div></div>`;
    document.body.appendChild(modal);
    const save = () => {
        const current = mgr.overlays[0];
        if (current) { current._bulkLogoOverlay = true; entry.logoOverlay.overlay = JSON.parse(JSON.stringify(current)); }
        _bcScheduleDraftSave();
    };
    const proxy = {
        overlayMgr: mgr, scopedTask: { overlays: mgr.overlays },
        getOverlayAboveSubtitle: () => true,
        setOverlayAboveSubtitle() {},
        getCanvasSize: () => ({ w: 1080, h: 1920, cx: 540, cy: 960 }),
        getDuration: () => 9999,
        previewEnd() {},
        addOverlay(ov) { mgr.addOverlay(ov); save(); },
        removeOverlay(id) { mgr.removeOverlay(id); save(); panel?._refreshList(); },
        render: save,
    };
    let panel = new ReelsOverlayPanel(modal.querySelector('[data-panel]'), proxy);
    modal.querySelectorAll('#rop-group-preset-update,#rop-group-preset-del,#rop-group-preset-rename,#rop-batch-import').forEach(el => { el.style.display = 'none'; });
    panel._refreshList();
    if (mgr.overlays[0]) panel.selectOverlay(mgr.overlays[0]);
    modal.querySelector('[data-close]').onclick = () => { save(); modal.remove(); _bcRenderBindings(); };
}

function _bcApplyAssignedOverlayMedia(task, tpl, index) {
    if (!tpl.assignedOverlayMediaFolder) return;
    const folder = _bulkState.overlayMediaFolders.find(item => item.path === tpl.assignedOverlayMediaFolder);
    if (!folder?.files?.length) throw new Error('所选覆层媒体文件夹为空或已移除，请重新分配');
    const overlays = task.overlays || [];
    const mediaIndices = overlays.map((ov, i) => ['image', 'video'].includes(ov?.type) ? i : -1).filter(i => i >= 0);
    // New assignments carry a semantic slot key (for example
    // `phone_primary`), never an array position.  Keep numeric positions only
    // for projects saved before slots existed.
    const target = typeof tpl.assignedOverlayMediaSlot === 'string'
        ? overlays.findIndex(ov => ov?.slotKey === tpl.assignedOverlayMediaSlot)
        : (Number.isInteger(tpl.assignedOverlayMediaSlot) ? tpl.assignedOverlayMediaSlot : mediaIndices[0]);
    if (!Number.isInteger(target) || !overlays[target]) throw new Error('所选模板没有可替换的覆层媒体；请先在模板中添加图片或视频覆层');
    const files = folder.files;
    const file = files[index % files.length];
    const ext = _bcFileExt(file);
    overlays[target].content = file;
    overlays[target].type = ['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v'].includes(ext) ? 'video' : 'image';
    // 明确记录文件夹循环来源，后续编辑时仍能辨认；单条任务只绑定自己的文件，导出和预览一致。
    overlays[target].mediaFolderPath = folder.path;
    overlays[target].mediaFolderFiles = files.slice();
    overlays[target].mediaLoop = true;
}

async function _bcImportBackgroundFolders(paths) {
    if (!window.electronAPI?.scanDirectoryRecursive) { alert('请在桌面版中导入背景文件夹'); return; }
    const errors = [];
    for (const path of [...new Set(paths)]) {
        try {
            // 背景库按文件夹递归读取；子目录只是组织方式，不会漏掉其中素材。
            const entries = await window.electronAPI.scanDirectoryRecursive(path, { maxDepth: 20 });
            const files = (entries || []).filter(item => !item.isDirectory && item.path && BC_FOLDER_BG_EXTS.has(_bcFileExt(item.name || item.path)))
                .sort((a, b) => String(a.name || a.path).localeCompare(String(b.name || b.path), undefined, { numeric: true })).map(item => item.path);
            const folder = { path, name: _bcFileName(path), files, recursive: true };
            const index = _bulkState.backgroundFolders.findIndex(item => item.path === path);
            if (index < 0) _bulkState.backgroundFolders.push(folder);
            else _bulkState.backgroundFolders[index] = folder;
        } catch (error) { errors.push(`${_bcFileName(path)}：${error.message || error}`); }
    }
    _bcRenderBindings();
    _bcScheduleDraftSave();
    if (errors.length) alert(`部分文件夹读取失败：\n${errors.join('\n')}`);
}

function _bcClearBackgroundFolders() {
    _bulkState.backgroundFolders = [];
    (_bulkState.groupAssignments || []).forEach(entry => {
        entry.backgroundFolder = '';
    });
    _bcRenderBindings();
    _bcScheduleDraftSave();
}

function _bcApplyAssignedBackground(task, tpl, index) {
    if (!tpl.assignedBackgroundFolder) return;
    const folder = _bulkState.backgroundFolders.find(item => item.path === tpl.assignedBackgroundFolder);
    if (!folder?.files?.length) throw new Error('所选背景分类为空或已移除，请重新分配');
    // 指定素材循环只使用用户在该编号组勾选的素材；未勾选时仍安全回退到整个文件夹。
    const selected = Array.isArray(tpl.assignedBackgroundFiles) ? tpl.assignedBackgroundFiles : [];
    const files = tpl.assignedBackgroundMode === 'selected-cycle'
        ? selected.filter(path => folder.files.includes(path))
        : folder.files;
    if (!files.length) throw new Error('“指定素材循环”尚未选择素材，请点击“选择素材”至少勾选一个');
    const mode = tpl.assignedBackgroundMode || 'cycle';
    let hash = ((tpl.assignedBackgroundSeed || 0) + Math.imul(index + 1, 0x9e3779b9)) | 0;
    hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
    hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
    const random = tpl.assignedBackgroundSeed == null ? Math.random() : ((hash ^ (hash >>> 16)) >>> 0) / 4294967296;
    const path = files[mode === 'random' ? Math.floor(random * files.length) : index % files.length];
    _bcApplySingleBackground(task, path);
    task.bgClipActivePool = [];
    if (mode === 'concat') {
        task.bgMode = 'multi';
        task.bgPath = task.videoPath = files[0];
        task.bgClipPool = files.slice();
        task.bgClipActivePool = files.slice();
        task.bgClipOrder = 'sequence';
    }
}

function _bcOpenSelectedBackgroundPicker(groupKey) {
    const entry = (_bulkState.groupAssignments || []).find(item => item.key === groupKey);
    const folder = _bulkState.backgroundFolders.find(item => item.path === entry?.backgroundFolder);
    if (!entry?.backgroundFolder || !folder?.files?.length) { alert('请先选择一个背景文件夹'); return; }
    const selected = new Set((entry.selectedBackgroundFiles || []).filter(path => folder.files.includes(path)));
    const ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;z-index:1000002;background:rgba(0,0,0,.76);display:flex;align-items:center;justify-content:center;padding:24px;';
    let sortMode = 'name';
    const getSortedFiles = () => folder.files.slice().sort((left, right) => {
        if (sortMode === 'time') {
            const leftTime = Number(window.electronAPI?.fsStat?.(left)?.mtimeMs) || 0;
            const rightTime = Number(window.electronAPI?.fsStat?.(right)?.mtimeMs) || 0;
            // 同一时间时仍按文件名稳定排序；最新文件排在前面。
            if (rightTime !== leftTime) return rightTime - leftTime;
        }
        return _bcFileName(left).localeCompare(_bcFileName(right), undefined, { numeric: true, sensitivity: 'base' });
    });
    const render = () => {
        const files = getSortedFiles();
        const cards = files.map((path, index) => {
            const kind = _bcMediaKind(path);
            const checked = selected.has(path);
            const url = _bcFileUrl(path);
            const fileName = _bcFileName(path);
            const preview = kind === 'video'
                ? `<div style="width:100%;height:259.5556px;min-height:259.5556px;max-height:259.5556px;position:relative;display:flex;align-items:center;justify-content:center;overflow:hidden;background:#070710;"><video crossorigin="anonymous" src="${_bcEsc(url)}#t=1" muted preload="metadata" playsinline style="position:absolute!important;inset:0!important;display:block!important;width:100%!important;height:100%!important;object-fit:contain!important;pointer-events:none;"></video><button type="button" data-action="preview" data-preview-path="${_bcEsc(path)}" title="预览 ${_bcEsc(fileName)}" style="position:absolute;left:6px;bottom:6px;padding:3px 7px;border:0;border-radius:4px;background:rgba(0,0,0,.76);color:#fff;font-size:11px;cursor:pointer;">▶ 预览</button></div>`
                : `<div style="width:100%;height:259.5556px;min-height:259.5556px;max-height:259.5556px;position:relative;display:flex;align-items:center;justify-content:center;overflow:hidden;background:#070710;"><img crossorigin="anonymous" src="${_bcEsc(url)}" loading="lazy" style="position:absolute!important;inset:0!important;display:block!important;width:100%!important;height:100%!important;object-fit:contain!important;"></div>`;
            return `<div data-path="${_bcEsc(path)}" data-material-card style="position:relative;display:block;align-self:start;min-width:0;cursor:pointer;border:2px solid ${checked ? '#8b5cf6' : '#303145'};border-radius:6px;overflow:hidden;background:#141525;box-shadow:${checked ? '0 0 0 1px rgba(139,92,246,.35)' : 'none'};">
                ${preview}<input type="checkbox" ${checked ? 'checked' : ''} title="选择 ${_bcEsc(fileName)}" style="position:absolute;top:5px;right:5px;z-index:2;accent-color:#8b5cf6;width:16px;height:16px;"><div data-file-name style="display:block!important;min-height:39px;padding:5px 6px;font-size:10px;line-height:1.4;color:#d5d7e8;word-break:break-all;background:#141525;" title="${_bcEsc(path)}"><span style="color:#8b8fb1;">${index + 1}.</span> ${_bcEsc(fileName)}</div>
            </div>`;
        }).join('');
        ov.innerHTML = `<div style="width:min(920px,96vw);max-height:88vh;display:flex;flex-direction:column;background:#151622;border:1px solid #464765;border-radius:10px;overflow:hidden;box-shadow:0 18px 70px #000;">
            <div style="padding:12px 15px;border-bottom:1px solid #303145;display:flex;align-items:center;gap:10px;flex-wrap:wrap;"><div style="flex:1;min-width:220px;"><b style="color:#f3f4ff;">指定素材循环 · ${_bcEsc(groupKey)}</b><div style="font-size:10px;color:#9b9db8;margin-top:3px;">${_bcEsc(folder.name)}（含子文件夹）· 缩略图完整显示原始比例；点击“预览”播放视频</div></div><label style="font-size:11px;color:#c4b5fd;display:flex;align-items:center;gap:5px;">排序 <select data-sort style="background:#10111c;color:#e5e7eb;border:1px solid #4b4d68;border-radius:4px;padding:3px 5px;"><option value="name" ${sortMode === 'name' ? 'selected' : ''}>文件名 A→Z</option><option value="time" ${sortMode === 'time' ? 'selected' : ''}>时间（最新优先）</option></select></label><button data-action="all" class="bc-btn bc-btn-default bc-btn-xs">全选</button><button data-action="none" class="bc-btn bc-btn-default bc-btn-xs">全不选</button></div>
            <div data-grid style="padding:12px;min-height:0;flex:1 1 auto;overflow:auto;display:grid;grid-auto-rows:max-content;align-content:start;align-items:start;grid-template-columns:repeat(auto-fill,150px);justify-content:start;gap:11px;">${cards}</div>
            <div style="padding:10px 15px;border-top:1px solid #303145;display:flex;align-items:center;justify-content:space-between;"><span data-count style="font-size:11px;color:#c4b5fd;">已选 ${selected.size} 个</span><div style="display:flex;gap:7px;"><button data-action="cancel" class="bc-btn bc-btn-default bc-btn-sm">取消</button><button data-action="save" class="bc-btn bc-btn-purple bc-btn-sm">保存选择</button></div></div>
        </div>`;
    };
    const updateCount = () => { const el = ov.querySelector('[data-count]'); if (el) el.textContent = `已选 ${selected.size} 个`; };
    ov.addEventListener('change', e => {
        if (e.target.matches('[data-sort]')) { sortMode = e.target.value === 'time' ? 'time' : 'name'; render(); return; }
        const card = e.target.closest('[data-path]'); if (!card) return;
        const path = card.dataset.path; e.target.checked ? selected.add(path) : selected.delete(path);
        card.style.borderColor = e.target.checked ? '#8b5cf6' : '#303145'; updateCount();
    });
    ov.addEventListener('click', e => {
        const actionEl = e.target.closest('[data-action]');
        const action = actionEl?.dataset.action;
        if (action === 'preview') {
            e.preventDefault(); e.stopPropagation();
            const path = actionEl.dataset.previewPath || '';
            if (path && typeof window.playVideoClip === 'function') window.playVideoClip(path, 0, 0);
            return;
        }
        if (!action) {
            // 保留原来“点卡片即可勾选”的习惯；复选框自身交给 change 处理。
            const card = e.target.closest('[data-material-card]');
            if (card && !e.target.matches('input[type="checkbox"]')) {
                const path = card.dataset.path;
                const checkbox = card.querySelector('input[type="checkbox"]');
                if (path && checkbox) {
                    checkbox.checked = !checkbox.checked;
                    checkbox.dispatchEvent(new Event('change', { bubbles: true }));
                }
            }
            return;
        }
        if (action === 'cancel') ov.remove(); else if (action === 'all') { folder.files.forEach(path => selected.add(path)); render(); } else if (action === 'none') { selected.clear(); render(); } else if (action === 'save') { if (!selected.size) { alert('至少选择 1 个素材'); return; } entry.selectedBackgroundFiles = folder.files.filter(path => selected.has(path)); entry.backgroundMode = 'selected-cycle'; ov.remove(); _bcRenderBindings(); _bcScheduleDraftSave(); }
    });
    render(); document.body.appendChild(ov);
}

function _bcImportMusicFiles(paths) {
    const allowed = new Set(['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'wma']);
    const existing = new Set(_bulkState.musicFiles.map(item => item.path));
    (paths || []).forEach(path => {
        if (!path || !allowed.has(_bcFileExt(path)) || existing.has(path)) return;
        _bulkState.musicFiles.push({ path, name: _bcFileName(path) });
        existing.add(path);
    });
    _bcRenderBindings();
    _bcScheduleDraftSave();
}

function _bcClearMusicFiles() {
    _bulkState.musicFiles = [];
    (_bulkState.groupAssignments || []).forEach(entry => {
        entry.musicPath = '';
    });
    _bcRenderBindings();
    _bcScheduleDraftSave();
}

function _bcCreateEmptyProject() {
    const hasCurrentWork = _bulkState.columns.length > 0 || _bulkState.rows.length > 0 || _bulkState.templates.length > 0
        || _bulkState.backgroundFolders.length > 0 || _bulkState.overlayMediaFolders.length > 0 || _bulkState.logoMediaLibrary.length > 0 || _bulkState.musicFiles.length > 0 || (_bulkState.groupAssignments || []).length > 0;
    if (hasCurrentWork && !confirm('新建空工程会清空当前大量制作页面的表格、模板、背景、配乐和编号任务组。\n\n不会删除已保存的爆帖工程组合库、工程模板或覆层预设。是否继续？')) return;
    _bulkState.columns = [
        { name: '原始完整文案', type: 'text' },
        { name: '标题', type: 'text' },
        { name: '正文', type: 'text' },
    ];
    _bulkState.rows = [];
    _bulkState.rowTemplateIds = []; _bulkState.cellTemplateIds = [];
    _bulkState.rowPresetMode = false;
    _bulkState.cellPresetMode = false;
    _bulkState.templates = [];
    _bulkState.backgroundFolders = [];
    _bulkState.overlayMediaFolders = [];
    _bulkState.logoMediaLibrary = [];
    _bulkState.musicFiles = [];
    _bulkState.groupAssignments = null;
    _bulkState.missingHeaderGroupKeys = [];
    _bulkState.retainedHeaderColumns = [];
    _bulkState.allowTemplateReuse = false;
    _bulkState.allowBackgroundReuse = false;
    _bulkState.allowMusicReuse = false;
    _bulkState.filterUnassignedTemplates = false;
    _bulkState.filterUnassignedBackgrounds = false;
    _bulkState.filterUnassignedMusic = false;
    _bulkState.filterUnassignedGroups = false;
    _bulkState.collapsedSections = { templates: false, backgrounds: false, music: false, groups: false };
    _bcSelection = null;
    _bcNormalizeStateShape();
    _bcRenderTable();
    _bcRenderBindings();
    _bcScheduleDraftSave();
    if (typeof showToast === 'function') showToast('已新建空工程；可在“爆帖工程组合库 / 添加”中加入组合', 'success', 5000);
}

// One allocator is shared by this generation run, so “不重复” applies to
// every generated task — not just the rows inside one numbered group.
function _bcCreateRandomMusicAllocator() {
    const paths = _bulkState.musicFiles.map(item => item?.path).filter(Boolean);
    let remaining = [];
    const reshuffle = () => {
        remaining = paths.slice();
        for (let i = remaining.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [remaining[i], remaining[j]] = [remaining[j], remaining[i]];
        }
    };
    return {
        next() {
            if (!paths.length) return '';
            if (_bulkState.allowMusicReuse) return paths[Math.floor(Math.random() * paths.length)];
            if (!remaining.length) reshuffle();
            return remaining.pop() || '';
        },
    };
}

function _bcApplyAssignedMusic(task, tpl, taskIndex = 0, randomMusicAllocator = null) {
    const mode = tpl.assignedMusicMode || 'suite';
    // 生成时会传入整批共享的 allocator；预览也要抽一首，不能继续显示
    // 模板原来的配乐，否则用户会误以为“每条任务随机”没有生效。
    const previewRandomPath = () => {
        const files = _bulkState.musicFiles || [];
        return files.length ? files[Math.floor(Math.random() * files.length)]?.path || '' : '';
    };
    // 点击“每条任务随机”后会把抽签结果预先记录在任务组内。预览、配乐库
    // 列表和实际生成必须用同一个结果，用户才能知道每首歌给了哪条任务。
    const assignedRandomPath = tpl.assignedMusicTaskAssignments?.[taskIndex] || '';
    const path = mode === 'random'
        ? (assignedRandomPath || randomMusicAllocator?.next() || previewRandomPath())
        : (mode === 'cycle'
            ? _bulkState.musicFiles[taskIndex % Math.max(1, _bulkState.musicFiles.length)]?.path
            : tpl.assignedMusicPath);

    // 随机模式必须覆盖模板携带的 bgmPath；即使配乐库后来被清空，也不能
    // 静默退回并使用模板旧配乐。
    if (mode === 'random' && !path) task.bgmPath = '';
    if (path) {
        task.bgmPath = path;
        task.bgmMode = 'single';
        task.bgmClipPool = [];
        task.bgmClipActivePool = [];
    }
    // 保留最终抽签结果，批量表格/工程恢复后都能核对每条任务实际拿到哪一首。
    task._bulkMusicAssignment = { mode, path: path || '', taskIndex };
}

function _bcEnsureFolderBackgroundColumn(tpl, ti) {
    let ci = Number(tpl?.bindings?.__bg__);
    const name = `组${ti + 1}-背景视频`;
    const usedByOtherTemplate = Number.isInteger(ci) && _bulkState.templates.some((other, otherTi) =>
        otherTi !== ti && Number(other?.bindings?.__bg__) === ci
    );
    if (Number.isInteger(ci) && ci >= 0 && ci < _bulkState.columns.length && !usedByOtherTemplate) return ci;
    ci = _bulkState.columns.findIndex(col => col?.name === name);
    if (ci < 0) {
        _bulkState.columns.push({ name, type: 'media', kind: 'video' });
        ci = _bulkState.columns.length - 1;
        _bulkState.rows.forEach(row => {
            while (row.length < _bulkState.columns.length) row.push('');
        });
    }
    if (!tpl.bindings) tpl.bindings = {};
    tpl.bindings.__bg__ = ci;
    return ci;
}

async function _bcRefreshTemplateMaterialFolder(tpl, ti, options = {}) {
    const folder = tpl?.materialFolder;
    if (!folder?.path) {
        if (!options.silent) alert('请先为该模板选择素材文件夹');
        return 0;
    }
    if (!window.electronAPI?.scanDirectoryRecursive) {
        alert('请在桌面版中使用文件夹刷新');
        return 0;
    }
    const entries = await window.electronAPI.scanDirectoryRecursive(folder.path, { maxDepth: 20 });
    const files = (entries || [])
        .filter(item => !item?.isDirectory && item.path && BC_FOLDER_BG_EXTS.has(_bcFileExt(item.name || item.path)))
        .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), undefined, { numeric: true }))
        .map(item => item.path);
    tpl.materialFolder = {
        path: folder.path,
        mode: folder.mode === 'concat' ? 'concat' : 'rows',
        files,
        refreshedAt: Date.now(),
        columnIndex: Number.isInteger(folder.columnIndex) ? folder.columnIndex : null,
    };
    tpl.bgCycle = files.slice();

    if (tpl.materialFolder.mode === 'rows') {
        const ci = _bcEnsureFolderBackgroundColumn(tpl, ti);
        tpl.materialFolder.columnIndex = ci;
        const neededRows = Math.max(20, files.length);
        _bcEnsureRows(neededRows);
        _bulkState.rows.forEach(row => { row[ci] = ''; });
        files.forEach((path, ri) => { _bulkState.rows[ri][ci] = path; });
    }
    _bcRenderTable();
    _bcRenderBindings();
    _bcScheduleDraftSave();
    if (!options.silent && typeof showToast === 'function') {
        showToast(`✅ 「${tpl.label}」已读取 ${files.length} 个背景素材`, 'success');
    }
    return files.length;
}

async function _bcPickTemplateMaterialFolder(tpl, ti) {
    if (!window.electronAPI?.selectDirectory) {
        alert('请在桌面版中选择素材文件夹');
        return;
    }
    const path = await window.electronAPI.selectDirectory();
    if (!path) return;
    tpl.materialFolder = {
        path,
        mode: tpl.materialFolder?.mode === 'concat' ? 'concat' : 'rows',
        files: [],
        refreshedAt: 0,
    };
    await _bcRefreshTemplateMaterialFolder(tpl, ti);
}

// 显示背景循环详情弹窗
function _bcShowBgCycleDetail(tpl, ti) {
    const ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:1000001;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;';

    const renderList = () => {
        const list = tpl.bgCycle || [];
        return list.map((p, i) => {
            const name = p.split(/[/\\]/).pop();
            const ext = (name.split('.').pop() || '').toLowerCase();
            const isVideo = ['mp4','mov','avi','mkv','webm','m4v'].includes(ext);
            const isImage = ['jpg','jpeg','png','webp','gif','bmp'].includes(ext);
            const mediaUrl = _bcFileUrl(p);
            let thumbHtml;
            if (isVideo) {
                thumbHtml = `<video crossorigin="anonymous" class="bgc-vid-thumb" src="${_bcEsc(mediaUrl)}#t=1" style="width:48px;height:48px;object-fit:cover;border-radius:4px;background:#111;" muted preload="metadata" playsinline></video>`;
            } else if (isImage) {
                thumbHtml = `<img crossorigin="anonymous" src="${_bcEsc(mediaUrl)}" style="width:48px;height:48px;object-fit:cover;border-radius:4px;background:#000;" loading="lazy" />`;
            } else {
                thumbHtml = `<div style="width:48px;height:48px;border-radius:4px;background:#111;display:flex;align-items:center;justify-content:center;font-size:18px;">📄</div>`;
            }
            return `<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:5px;" data-idx="${i}">
                <span style="color:#666;font-size:10px;font-weight:bold;min-width:20px;">#${i + 1}</span>
                <div style="flex-shrink:0;">${thumbHtml}</div>
                <span style="flex:1;font-size:11px;color:#ccc;word-break:break-all;min-width:0;" title="${_bcEsc(p)}">${_bcEsc(name)}</span>
                <span class="bgc-del-item" data-idx="${i}" style="cursor:pointer;color:#f66;font-size:10px;padding:2px 6px;border-radius:3px;background:rgba(255,68,68,0.08);border:1px solid rgba(255,68,68,0.15);flex-shrink:0;" title="移除此素材">✕</span>
            </div>`;
        }).join('');
    };

    const rebuild = () => {
        const listEl = ov.querySelector('#bgc-list');
        const countEl = ov.querySelector('#bgc-count');
        if (listEl) listEl.innerHTML = renderList();
        if (countEl) countEl.textContent = `${(tpl.bgCycle || []).length} 个素材`;
        _bgcSeekAllThumbs();
    };

    // 主动对所有视频缩略图 seek 到视频 25% 位置抓帧（避免黑场开头）
    const _bgcSeekAllThumbs = () => {
        setTimeout(() => {
            ov.querySelectorAll('.bgc-vid-thumb').forEach(v => {
                if (v._seeked) return;
                const doSeek = () => {
                    const t = v.duration && isFinite(v.duration) ? v.duration * 0.25 : 3;
                    v.currentTime = Math.max(0.5, t);
                    v._seeked = true;
                };
                v.addEventListener('error', () => {
                    const box = v.parentElement;
                    if (box) box.innerHTML = '<div style="width:48px;height:48px;border-radius:4px;background:#111;color:#f66;display:flex;align-items:center;justify-content:center;font-size:10px;">加载失败</div>';
                }, { once: true });
                if (v.readyState >= 1 && v.duration) doSeek();
                else v.addEventListener('loadedmetadata', doSeek, { once: true });
            });
        }, 100);
    };

    ov.innerHTML = `
        <div style="background:#1a1a2e;border:1px solid #333;border-radius:8px;padding:20px;width:560px;max-height:75vh;display:flex;flex-direction:column;box-shadow:0 12px 40px rgba(0,0,0,0.6);">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
                <h3 style="margin:0;font-size:14px;color:#10b981;">🔄 背景循环素材 — ${_bcEsc(tpl.label)}</h3>
                <button id="bgc-close" style="background:none;border:none;color:#888;font-size:18px;cursor:pointer;">✕</button>
            </div>
            <div style="display:flex;gap:6px;margin-bottom:10px;align-items:center;">
                <span id="bgc-count" style="font-size:11px;color:#888;">${(tpl.bgCycle || []).length} 个素材</span>
                <span style="flex:1;"></span>
                <button id="bgc-add" style="padding:4px 10px;font-size:10px;background:rgba(16,185,129,0.15);border:1px solid rgba(16,185,129,0.3);color:#10b981;border-radius:4px;cursor:pointer;">📂 添加素材</button>
                <button id="bgc-clear" style="padding:4px 10px;font-size:10px;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.2);color:#f87171;border-radius:4px;cursor:pointer;">🗑 清空全部</button>
            </div>
            <div id="bgc-list" style="flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:4px;min-height:60px;max-height:50vh;">
                ${renderList()}
            </div>
            <div style="margin-top:12px;text-align:right;">
                <button id="bgc-done" style="padding:6px 20px;font-size:12px;background:rgba(16,185,129,0.25);border:1px solid rgba(16,185,129,0.4);color:#fff;border-radius:4px;cursor:pointer;font-weight:bold;">确定</button>
            </div>
        </div>
    `;

    document.body.appendChild(ov);
    _bgcSeekAllThumbs();

    const close = () => { ov.remove(); _bcRenderBindings(); _bcScheduleDraftSave(); };
    ov.querySelector('#bgc-close').onclick = close;
    ov.querySelector('#bgc-done').onclick = close;
    ov.addEventListener('click', e => { if (e.target === ov) close(); });

    // 删除单个
    ov.querySelector('#bgc-list').addEventListener('click', e => {
        const del = e.target.closest('.bgc-del-item');
        if (!del) return;
        const idx = parseInt(del.dataset.idx);
        if (tpl.bgCycle && idx >= 0 && idx < tpl.bgCycle.length) {
            tpl.bgCycle.splice(idx, 1);
            if (tpl.bgCycle.length === 0) tpl.bgCycle = null;
            rebuild();
            _bcScheduleDraftSave();
        }
    });

    // 添加
    ov.querySelector('#bgc-add').onclick = () => {
        _bcPickBgCycleFiles(tpl, ti);
        // 文件选择是异步的，选完后刷新列表
        setTimeout(rebuild, 500);
    };

    // 清空
    ov.querySelector('#bgc-clear').onclick = () => {
        if (confirm('清空全部背景循环素材？')) {
            tpl.bgCycle = null;
            close();
        }
    };
}

function _bcSelectionBounds() {
    if (!_bcSelection) return null;
    return {
        minR: Math.min(_bcSelection.r1, _bcSelection.r2),
        maxR: Math.max(_bcSelection.r1, _bcSelection.r2),
        minC: Math.min(_bcSelection.c1, _bcSelection.c2),
        maxC: Math.max(_bcSelection.c1, _bcSelection.c2),
    };
}

function _bcUpdateSelectionUI() {
    document.querySelectorAll('.bc-grid-td, .bc-cell').forEach(el => el.classList.remove('bc-selected-cell', 'bc-anchor-cell'));
    if (!_bcSelection) return;
    const { minR, maxR, minC, maxC } = _bcSelectionBounds();

    for (let r = minR; r <= maxR; r++) {
        for (let c = minC; c <= maxC; c++) {
            const cell = document.querySelector(`.bc-cell[data-ri="${r}"][data-ci="${c}"]`);
            const td = document.querySelector(`.bc-grid-td[data-ri="${r}"][data-ci="${c}"]`);
            if (cell) cell.classList.add('bc-selected-cell');
            if (td) td.classList.add('bc-selected-cell');
        }
    }
    const anchor = document.querySelector(`.bc-grid-td[data-ri="${_bcSelection.r1}"][data-ci="${_bcSelection.c1}"]`);
    if (anchor) anchor.classList.add('bc-anchor-cell');
}

function _bcCellPreview(value) {
    const text = String(value || '').replace(/\r?\n/g, ' ↵ ');
    return _bcEsc(text);
}

function _bcFileName(filePath) {
    return String(filePath || '').split(/[\\/]/).pop() || String(filePath || '');
}

function _bcFileExt(filePath) {
    const name = _bcFileName(filePath);
    const idx = name.lastIndexOf('.');
    return idx >= 0 ? name.slice(idx + 1).toLowerCase() : '';
}

function _bcFileUrl(filePath) {
    if (!filePath) return '';
    if (/^(local-media:|blob:|data:|https?:)/i.test(filePath)) return filePath;
    if (window.electronAPI?.toFileUrl) {
        const url = window.electronAPI.toFileUrl(filePath);
        if (url) return url;
    }
    return filePath;
}

function _bcMediaKind(filePath) {
    const ext = _bcFileExt(filePath);
    if (['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'].includes(ext)) return 'image';
    if (['mp4', 'mov', 'mkv', 'avi', 'wmv', 'flv', 'webm'].includes(ext)) return 'video';
    if (['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'wma'].includes(ext)) return 'audio';
    if (['srt', 'vtt', 'ass'].includes(ext)) return 'subtitle';
    return 'file';
}

function _bcMediaIconForKind(kind) {
    return { image: '🖼', video: '🎬', audio: '🎵', subtitle: '💬', file: '📄' }[kind] || '📄';
}

function _bcGuessColumnKind(col) {
    if (!col || col.type !== 'media') return 'text';
    const name = String(col.name || '').toLowerCase();
    if (/srt|vtt|ass|字幕|subtitle|caption/.test(name)) return 'subtitle';
    if (/音频|audio|voice|tts|配音|人声|旁白|bgm|music/.test(name)) return 'audio';
    if (/图片|图像|image|photo|pic|封面|cover|png|jpg|jpeg|webp/.test(name)) return 'image';
    if (/视频|video|movie|clip|背景|bg|素材|media/.test(name)) return 'video';
    return 'video';
}

function _bcColumnKind(col) {
    if (!col || col.type !== 'media') return 'text';
    return col.kind || _bcGuessColumnKind(col);
}

function _bcSetColumnKind(col, kind) {
    if (!col) return;
    if (kind === 'text') {
        col.type = 'text';
        delete col.kind;
    } else {
        col.type = 'media';
        col.kind = kind || 'video';
    }
}

function _bcMediaCellHtml(value) {
    if (!value) return '<span class="bc-cell-placeholder"> </span>';
    const kind = _bcMediaKind(value);
    const url = _bcFileUrl(value);
    const name = _bcFileName(value);
    let thumb = `<span class="bc-media-icon">${_bcMediaIconForKind(kind)}</span>`;
    if (kind === 'image') {
        thumb = `<img crossorigin="anonymous" class="bc-media-thumb" src="${_bcEsc(url)}" loading="lazy" alt="">`;
    } else if (kind === 'video') {
        thumb = `<video crossorigin="anonymous" class="bc-media-thumb" src="${_bcEsc(url)}#t=0.1" muted preload="metadata" playsinline></video>`;
    }
    return `${thumb}<span class="bc-media-name">${_bcEsc(name)}</span>`;
}

function _bcIsMediaColumn(ci) {
    return _bulkState.columns[ci]?.type === 'media';
}

function _bcPathMatchesColumnKind(path, ci) {
    const kind = _bcColumnKind(_bulkState.columns[ci]);
    if (!kind || kind === 'video') return ['video', 'file'].includes(_bcMediaKind(path));
    return _bcMediaKind(path) === kind || _bcMediaKind(path) === 'file';
}

function _bcColumnKindOptions(col) {
    const selected = _bcColumnKind(col);
    const opts = [
        ['text', '📝 文字'],
        ['image', '🖼 图片'],
        ['video', '🎬 视频'],
        ['audio', '🎵 音频'],
        ['subtitle', '💬 SRT'],
    ];
    return opts.map(([value, label]) => `<option value="${value}" ${selected === value ? 'selected' : ''}>${label}</option>`).join('');
}

function _bcColumnKindOptionsLabel(col) {
    return {
        text: '📝',
        image: '🖼',
        video: '🎬',
        audio: '🎵',
        subtitle: '💬',
    }[_bcColumnKind(col)] || '📎';
}

function _bcRenderTemplateThumb(overlays, timeoutMs = 2500, previewBackgroundPath = '', previewText = null, bgMedia = null) {
    if (!Array.isArray(overlays) || overlays.length === 0) return Promise.resolve('');
    if (typeof PresetThumbRenderer === 'undefined') return Promise.resolve('');

    const renderer = new PresetThumbRenderer();
    if (bgMedia && (bgMedia.naturalWidth || bgMedia.videoWidth)) {
        renderer._previewBgMedia = bgMedia;
        try {
            const url = renderer.renderThumb(overlays, '#1a1a2e', previewText || '');
            if (url) return Promise.resolve(url);
        } catch (_) {}
    }
    const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('timeout')), timeoutMs);
    });
    return Promise.race([renderer.renderThumbAsync(overlays, '#1a1a2e', previewBackgroundPath, previewText || '', bgMedia), timeoutPromise]);
}

function _bcColumnFromName(name) {
    const col = { name, type: 'text' };
    const lowerName = String(name || '').toLowerCase();
    if (/文案|文本|正文|内容|标题|结尾|尾标|断行|ai源|ai原|tts/.test(lowerName)) return col;
    const media = /背景|素材|bg|media|图片|图像|视频|video|image|path|音频|audio|srt|vtt|ass|字幕|subtitle|caption/i.test(name);
    if (media) _bcSetColumnKind(col, _bcGuessColumnKind({ ...col, type: 'media' }));
    return col;
}

const BC_QUICK_COLUMN_PRESETS = {
    default: {
        label: '默认配置',
        columns: ['原始完整文案', '标题', '正文'],
    },
    overlay: {
        label: '覆层模板表',
        columns: ['覆层标题', '覆层正文', '覆层结尾', '背景视频', '导出命名'],
    },
    voice_workflow: {
        label: '人声工作流表',
        columns: ['人声-原文案', '人声-断行文案', '人声-配音文案', '人声ID', '背景视频', '导出命名'],
    },
};

function _bcCurrentQuickColumnPresetId() {
    const currentNames = (_bulkState.columns || []).map(col => String(col?.name || '').trim());
    for (const [presetId, preset] of Object.entries(BC_QUICK_COLUMN_PRESETS)) {
        if (preset.columns.length === currentNames.length
            && preset.columns.every((name, index) => name === currentNames[index])) {
            return presetId;
        }
    }
    return '';
}

function _bcApplyQuickColumnPreset(presetId, groupCount = 1) {
    const preset = BC_QUICK_COLUMN_PRESETS[presetId];
    if (!preset) return false;
    const safeGroupCount = Math.max(1, Math.min(500, parseInt(groupCount) || 1));
    if (safeGroupCount > 100 && !confirm(`将建立 ${safeGroupCount} 组、共 ${safeGroupCount * preset.columns.length} 列。\n表格首次渲染可能需要一些时间，是否继续？`)) {
        return false;
    }
    const hasData = _bulkState.rows.some(row => row.some(cell => String(cell || '').trim()));
    if (hasData && !confirm(`应用「${preset.label}」${safeGroupCount > 1 ? ` × ${safeGroupCount} 组` : ''}会更换表格列。\n同名列的数据会保留，其他列数据将清空。是否继续？`)) {
        return false;
    }

    const oldColumns = _bulkState.columns || [];
    const oldRows = _bulkState.rows || [];
    const oldIndexByName = new Map(oldColumns.map((col, index) => [String(col?.name || '').trim(), index]));
    const columnNames = [];
    for (let groupIndex = 0; groupIndex < safeGroupCount; groupIndex++) {
        const prefix = safeGroupCount > 1 ? `组${groupIndex + 1}-` : '';
        preset.columns.forEach(name => columnNames.push(`${prefix}${name}`));
    }
    const newColumns = columnNames.map(_bcColumnFromName);
    const newRows = oldRows.map(oldRow => newColumns.map(col => {
        const oldIndex = oldIndexByName.get(col.name);
        return oldIndex == null ? '' : (oldRow[oldIndex] || '');
    }));

    _bulkState.columns = newColumns;
    _bulkState.rowTemplateIds = []; _bulkState.cellTemplateIds = [];
    _bulkState.rows = newRows.length ? newRows : Array.from({ length: 20 }, () => new Array(newColumns.length).fill(''));
    _bcSelection = null;
    _bcAutoRebindAllTemplates();
    _bcRenderTable();
    _bcRenderBindings();
    _bcScheduleDraftSave();
    if (typeof showToast === 'function') {
        showToast(`✅ 已应用「${preset.label}」${safeGroupCount > 1 ? `，共 ${safeGroupCount} 组` : ''}`, 'success');
    }
    return true;
}

const BC_STANDARD_COLUMN_NAMES = [...new Set([
    ...Object.values(BC_QUICK_COLUMN_PRESETS).flatMap(preset => preset.columns),
    '人声-音频文件', '人声-SRT字幕', '内容视频', '背景图片',
    '滚动字幕标题', '滚动字幕正文', '普通文本',
])];

function _bcTsvCell(value) {
    const text = String(value ?? '');
    return /[\t\r\n"]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function _bcCopyWholeTable() {
    const lines = [
        (_bulkState.columns || []).map(col => _bcTsvCell(col?.name || '')).join('\t'),
        ...(_bulkState.rows || []).map(row =>
            (_bulkState.columns || []).map((_, ci) => _bcTsvCell(row?.[ci] || '')).join('\t')
        ),
    ];
    const text = lines.join('\n');
    const button = document.getElementById('bc-copy-table');
    const originalLabel = button?.textContent || '📄 复制整表';
    try {
        if (window.electronAPI?.writeClipboardText) {
            window.electronAPI.writeClipboardText(text);
        } else if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
        } else {
            const textarea = document.createElement('textarea');
            textarea.value = text;
            textarea.style.cssText = 'position:fixed;left:-99999px;top:-99999px;';
            document.body.appendChild(textarea);
            textarea.select();
            const copied = document.execCommand('copy');
            textarea.remove();
            if (!copied) throw new Error('copy command rejected');
        }
        if (button) {
            button.textContent = '✅ 已复制';
            setTimeout(() => {
                if (button.isConnected) button.textContent = originalLabel;
            }, 1500);
        }
        if (typeof showToast === 'function') showToast('✅ 已复制整张表格（包含表头）', 'success');
        return true;
    } catch (e) {
        console.warn('[BulkCreate] Copy whole table failed:', e);
        if (button) {
            button.textContent = '❌ 复制失败';
            setTimeout(() => {
                if (button.isConnected) button.textContent = originalLabel;
            }, 1800);
        }
        if (typeof showToast === 'function') showToast('复制失败，请检查剪贴板权限', 'error');
        return false;
    }
}

async function _bcCopyGroupAssignmentsToClipboard(button) {
    const originalLabel = button?.textContent || '📋 复制分配情况';
    const numberedGroups = _bcNumberedColumnGroups();
    const assignments = _bulkState.groupAssignments || [];

    // 收集所有组键名，保持顺序
    const allGroupKeys = [];
    numberedGroups.forEach(g => {
        if (g && g.key && !allGroupKeys.includes(g.key)) allGroupKeys.push(g.key);
    });
    assignments.forEach(a => {
        if (a && a.key && !allGroupKeys.includes(a.key)) allGroupKeys.push(a.key);
    });

    if (!allGroupKeys.length) {
        if (typeof showToast === 'function') showToast('当前暂无可复制的任务组数据', 'warning');
        else alert('当前暂无可复制的任务组数据');
        return;
    }

    const cleanField = text => String(text || '').replace(/[\t\r\n]+/g, ' ').trim();

    const lines = [
        ['任务组名字', '分配的背景', '配乐', '模版'].join('\t')
    ];

    allGroupKeys.forEach(key => {
        const entry = assignments.find(item => item.key === key);

        // 1. 任务组名字
        const groupName = cleanField(key);

        // 2. 分配的背景
        let bgDesc = '沿用模板';
        if (entry?.backgroundFolder) {
            const folder = (_bulkState.backgroundFolders || []).find(f => f.path === entry.backgroundFolder);
            const folderName = folder?.name || String(entry.backgroundFolder).split(/[/\\]/).filter(Boolean).pop() || '';
            bgDesc = folderName || '已选背景文件夹';
        } else {
            bgDesc = '沿用模板 / 未分配';
        }

        // 3. 配乐
        let musicDesc = '沿用模板';
        const musicMode = entry?.musicMode || 'suite';
        if (musicMode === 'random') {
            musicDesc = '每条任务随机配乐（配乐库）';
        } else if (musicMode === 'cycle') {
            musicDesc = '每条任务轮流配乐（配乐库循环）';
        } else if (entry?.musicPath) {
            const music = (_bulkState.musicFiles || []).find(m => m.path === entry.musicPath);
            const musicName = music?.name || String(entry.musicPath).split(/[/\\]/).filter(Boolean).pop() || '';
            musicDesc = musicName ? `整套: ${musicName}` : '指定整套配乐';
        } else {
            musicDesc = '沿用模板 / 不指定配乐';
        }

        // 4. 模版
        let templateDesc = '未分配模版';
        if (entry && entry.templateIndex != null && entry.templateIndex >= 0 && _bulkState.templates?.[entry.templateIndex]) {
            const rawLabel = (_bulkState.templates[entry.templateIndex].label || `模板${entry.templateIndex + 1}`).trim();
            templateDesc = /^\d+\./.test(rawLabel) ? rawLabel : `${entry.templateIndex + 1}. ${rawLabel}`;
        }

        lines.push([
            groupName,
            cleanField(bgDesc),
            cleanField(musicDesc),
            cleanField(templateDesc)
        ].join('\t'));
    });

    const text = lines.join('\n');

    try {
        if (window.electronAPI?.writeClipboardText) {
            window.electronAPI.writeClipboardText(text);
        } else if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
        } else {
            const textarea = document.createElement('textarea');
            textarea.value = text;
            textarea.style.cssText = 'position:fixed;left:-99999px;top:-99999px;opacity:0;';
            document.body.appendChild(textarea);
            textarea.select();
            const copied = document.execCommand('copy');
            textarea.remove();
            if (!copied) throw new Error('copy command rejected');
        }

        if (button) {
            button.textContent = '✅ 已复制';
            setTimeout(() => {
                if (button.isConnected) button.textContent = originalLabel;
            }, 1600);
        }
        if (typeof showToast === 'function') {
            showToast(`✅ 已复制 ${allGroupKeys.length} 个任务组分配情况（制表符格式，可直接粘贴到 Excel / 表格）`, 'success');
        }
    } catch (e) {
        console.warn('[BulkCreate] Copy group assignments failed:', e);
        if (button) {
            button.textContent = '❌ 复制失败';
            setTimeout(() => {
                if (button.isConnected) button.textContent = originalLabel;
            }, 1800);
        }
        if (typeof showToast === 'function') showToast('复制失败，请检查剪贴板权限', 'error');
    }
}

function _bcNativeFilePath(file) {
    if (!file) return '';
    if (typeof getFileNativePath === 'function') return getFileNativePath(file);
    if (window.electronAPI?.getFilePath) {
        try {
            const p = window.electronAPI.getFilePath(file);
            if (p) return p;
        } catch (_) {}
    }
    return file.path || file.name || '';
}

function _bcEnsureRows(count) {
    while (_bulkState.rows.length < count) {
        _bulkState.rows.push(new Array(_bulkState.columns.length).fill(''));
    }
}

function _bcFillMediaColumn(paths, startRi, ci) {
    const cleanPaths = (paths || []).filter(Boolean).filter(p => _bcPathMatchesColumnKind(p, ci));
    if (!cleanPaths.length || !_bcIsMediaColumn(ci)) return 0;
    const safeStart = Math.max(0, startRi || 0);
    _bcEnsureRows(safeStart + cleanPaths.length);
    cleanPaths.forEach((p, offset) => {
        const row = _bulkState.rows[safeStart + offset];
        while (row.length < _bulkState.columns.length) row.push('');
        row[ci] = p;
    });
    _bcSelection = {
        r1: safeStart,
        c1: ci,
        r2: safeStart + cleanPaths.length - 1,
        c2: ci,
    };
    _bcRenderTable();
    _bcScheduleDraftSave();
    return cleanPaths.length;
}

function _bcEsc(s) {
    return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Electron-safe prompt replacement
function _bcPrompt(title, placeholder) {
    return new Promise(resolve => {
        const m = document.createElement('div');
        m.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:400000;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;';
        m.innerHTML = `<div style="background:#1a1a2e;border:1px solid #333;border-radius:10px;width:400px;padding:20px;">
            <div style="color:#fff;font-size:13px;font-weight:600;margin-bottom:10px;">${_bcEsc(title)}</div>
            <textarea id="bc-prompt-input" rows="3" placeholder="${_bcEsc(placeholder||'')}" style="width:100%;background:#0a0a14;border:1px solid #333;border-radius:6px;color:#ccc;font-size:12px;padding:8px;resize:vertical;box-sizing:border-box;"></textarea>
            <div style="display:flex;justify-content:flex-end;gap:6px;margin-top:10px;">
                <button id="bc-prompt-cancel" style="padding:4px 14px;background:rgba(255,255,255,0.05);border:1px solid #333;border-radius:5px;color:#888;cursor:pointer;font-size:11px;">取消</button>
                <button id="bc-prompt-ok" style="padding:4px 14px;background:linear-gradient(135deg,#7c5cff,#a855f7);border:none;border-radius:5px;color:#fff;cursor:pointer;font-size:11px;font-weight:600;">确定</button>
            </div>
        </div>`;
        document.body.appendChild(m);
        const inp = m.querySelector('#bc-prompt-input');
        setTimeout(() => inp.focus(), 50);
        m.querySelector('#bc-prompt-cancel').onclick = () => { m.remove(); resolve(null); };
        m.querySelector('#bc-prompt-ok').onclick = () => { const v = inp.value; m.remove(); resolve(v); };
        inp.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); const v = inp.value; m.remove(); resolve(v); } });
    });
}
window._bcPrompt = _bcPrompt;
window.reelsPrompt = _bcPrompt;

async function _bcPromptRowDuplication(indices) {
    if (!indices || !indices.length) return;
    const res = await _bcPrompt('请输入副本版本说明（例如 Hook-B、短版、变体A）', '副本');
    if (res === null) return;
    const tag = res.trim() || '副本';
    _bcDuplicateRows(indices, tag);
}
window._bcPromptRowDuplication = _bcPromptRowDuplication;

function _bcDuplicateRows(indices, versionTag = '副本') {
    if (!indices || !indices.length || !_bulkState?.rows) return [];
    const uniqueSorted = Array.from(new Set(indices.map(Number))).filter(i => !isNaN(i) && i >= 0 && i < _bulkState.rows.length).sort((a, b) => a - b);
    if (!uniqueSorted.length) return [];
    const tag = String(versionTag || '副本').trim() || '副本';

    const cols = _bulkState.columns || [];
    let nameColIdx = cols.findIndex(c => {
        const n = String(c?.name || '').toLowerCase();
        return /导出|命名|文件名|export|filename/.test(n);
    });
    if (nameColIdx < 0) {
        nameColIdx = cols.findIndex(c => {
            const n = String(c?.name || '').toLowerCase();
            return /标题|title|hook|文案/.test(n);
        });
    }

    const newRows = [];
    uniqueSorted.forEach(ri => {
        const srcRow = _bulkState.rows[ri];
        if (!srcRow) return;
        const clonedRow = srcRow.slice();
        clonedRow._versionTag = tag;
        if (nameColIdx >= 0 && nameColIdx < clonedRow.length) {
            const val = clonedRow[nameColIdx] || '';
            clonedRow[nameColIdx] = val ? `${val}_${tag}` : tag;
        } else {
            let modified = false;
            for (let ci = 0; ci < clonedRow.length; ci++) {
                if (cols[ci]?.type !== 'media' && clonedRow[ci]) {
                    clonedRow[ci] = `${clonedRow[ci]}_${tag}`;
                    modified = true;
                    break;
                }
            }
            if (!modified && clonedRow.length > 0) {
                clonedRow[0] = clonedRow[0] ? `${clonedRow[0]}_${tag}` : tag;
            }
        }
        newRows.push(clonedRow);
    });

    if (!newRows.length) return [];
    const insertAfter = uniqueSorted[uniqueSorted.length - 1];
    _bulkState.cellTemplateIds.splice(insertAfter + 1, 0, ...uniqueSorted.map(ri => JSON.parse(JSON.stringify(_bulkState.cellTemplateIds[ri] || {}))));
    _bulkState.rowTemplateIds.splice(insertAfter + 1, 0, ...uniqueSorted.map(ri => [...(_bulkState.rowTemplateIds[ri] || [])]));
    _bulkState.rows.splice(insertAfter + 1, 0, ...newRows);

    const startRi = insertAfter + 1;
    const endRi = startRi + newRows.length - 1;
    _bcSelection = {
        r1: startRi,
        c1: 0,
        r2: endRi,
        c2: Math.max(0, cols.length - 1)
    };

    if (typeof _bcRenderTable === 'function') _bcRenderTable();
    if (typeof _bcRenderBindings === 'function') _bcRenderBindings();
    if (typeof _bcScheduleDraftSave === 'function') _bcScheduleDraftSave();
    if (typeof showToast === 'function') {
        showToast(`已复制 ${newRows.length} 行副本（版本: ${tag}）`, 'success');
    }
    return newRows;
}
window._bcDuplicateRows = _bcDuplicateRows;

// ── Bindable fields from a task's overlays ──
function _bcFieldsFromTask(task) {
    const fields = [];
    const hasBackgroundColumn = (_bulkState.columns || []).some(col =>
        col?.type === 'media'
        && ['image', 'video'].includes(_bcColumnKind(col))
        && /背景|素材|bg|background/i.test(String(col.name || ''))
    );
    if (task.bgPath || task.videoPath || hasBackgroundColumn) {
        fields.push({ key: '__bg__', label: '🎨 背景素材', type: 'media', kinds: ['image', 'video'] });
    }
    if (task.audioPath) {
        fields.push({ key: '__audio__', label: '🎵 人声-音频文件', type: 'media', kinds: ['audio'] });
    }
    if (task.srtPath) {
        fields.push({ key: '__srt__', label: '💬 人声-SRT字幕', type: 'media', kinds: ['subtitle'] });
    }
    if (task.contentVideoPath) {
        fields.push({ key: '__cv__', label: '📹 内容视频', type: 'media', kinds: ['video'] });
    }
    if (_bcTextColumnCandidatesForCategory('ai_source').length > 0 || task.aiScript) {
        fields.push({ key: '__ai__', label: '🧠 人声-原文案', type: 'text', category: 'ai_source' });
    }
    if (_bcTextColumnCandidatesForCategory('dynamic_subtitle').length > 0 || task.txtContent) {
        fields.push({ key: '__txt__', label: '💬 人声-断行文案', type: 'text', category: 'dynamic_subtitle' });
    }
    if (_bcTextColumnCandidatesForCategory('tts_text').length > 0 || task.ttsText) {
        fields.push({ key: '__tts__', label: '🎙️ 人声-配音文案', type: 'text', category: 'tts_text' });
    }
    if (_bcTextColumnCandidatesForCategory('voice_id').length > 0 || task.ttsVoiceId) {
        fields.push({ key: '__voice_id__', label: '🗣️ 人声ID', type: 'text', category: 'voice_id' });
    }
    const overlays = task.overlays || [];
    overlays.forEach((ov, li) => {
        if (ov.fixed_text) return;
        if (ov.type === 'textcard' || !ov.type) {
            fields.push({ key: `L${li}_title_text`, label: `📝 层${li+1} 覆层标题`, type: 'text', category: 'card_title' });
            fields.push({ key: `L${li}_body_text`, label: `📝 层${li+1} 覆层内容`, type: 'text', category: 'card_body' });
            fields.push({ key: `L${li}_footer_text`, label: `📝 层${li+1} 覆层结尾`, type: 'text', category: 'card_footer' });
        } else if (ov.type === 'scroll') {
            fields.push({ key: `L${li}_scroll_title`, label: `📜 层${li+1} 滚动字幕标题`, type: 'text', category: 'scroll_title' });
            fields.push({ key: `L${li}_content`, label: `📜 层${li+1} 滚动字幕正文`, type: 'text', category: 'scroll_body' });
        } else if (ov.type === 'text') {
            fields.push({ key: `L${li}_content`, label: `📝 层${li+1} 普通文本`, type: 'text', category: 'plain_text' });
        }
    });
    fields.push({ key: '__export_name__', label: '📝 导出命名', type: 'text', category: 'export_name' });
    return fields;
}

function _bcFieldAcceptsColumn(field, col) {
    if (!field || !col || col.type !== field.type) return false;
    if (field.type !== 'media' || !field.kinds) return true;
    return field.kinds.includes(_bcColumnKind(col));
}

function _bcClearInvalidBindingsForColumn(ci) {
    const col = _bulkState.columns[ci];
    _bulkState.templates.forEach(tpl => {
        const fields = _bcFieldsFromTask(tpl.task);
        fields.forEach(f => {
            if (tpl.bindings[f.key] === ci && !_bcFieldAcceptsColumn(f, col)) {
                delete tpl.bindings[f.key];
            }
        });
    });
}

function _bcClearBindingsForColumn(ci) {
    (_bulkState.templates || []).forEach(tpl => {
        Object.entries(tpl.bindings || {}).forEach(([field, boundCi]) => {
            if (Number(boundCi) === ci) delete tpl.bindings[field];
        });
    });
}

function _bcDuplicateHeaderGroups() {
    const groups = new Map();
    (_bulkState.columns || []).forEach((column, ci) => {
        const name = String(column?.name || '').trim();
        if (!name) return;
        const key = name.toLocaleLowerCase();
        if (!groups.has(key)) groups.set(key, { name, indices: [] });
        groups.get(key).indices.push(ci);
    });
    return [...groups.values()].filter(group => group.indices.length > 1);
}

function _bcWarnDuplicateHeaderGroups() {
    const duplicates = _bcDuplicateHeaderGroups();
    if (!duplicates.length) return;
    const summary = duplicates.slice(0, 3).map(group => `「${group.name}」×${group.indices.length}`).join('、');
    const suffix = duplicates.length > 3 ? ` 等 ${duplicates.length} 组` : '';
    if (typeof showToast === 'function') {
        showToast(`⚠ 检测到同名组列：${summary}${suffix}。绑定会按第几个同名列表头匹配，请确认顺序。`, 'warning', 7000);
    }
}

function _bcUniqueIndices(indices) {
    const out = [];
    const seen = new Set();
    indices.forEach(i => {
        if (i >= 0 && !seen.has(i)) {
            seen.add(i);
            out.push(i);
        }
    });
    return out;
}

function _bcTextColumnCandidates(names) {
    const hits = [];
    for (const name of names) {
        _bulkState.columns.forEach((c, ci) => {
            if (!c || c.type !== 'text') return;
            if (String(c.name || '').toLowerCase().includes(name)) hits.push(ci);
        });
    }
    return _bcUniqueIndices(hits);
}

function _bcPickCandidateForTemplate(candidates, templateIndex = 0) {
    if (!candidates || candidates.length === 0) return -1;
    return candidates[Math.min(Math.max(templateIndex, 0), candidates.length - 1)];
}

const BC_FIELD_CATEGORY_COLUMN_NAMES = {
    ai_source: ['原始文案', '原始完整文案', '人声-原文案', 'ai源文案', 'ai源', 'ai原文', '原文案', '源文案', 'ai_script', 'aiscript'],
    dynamic_subtitle: ['人声-断行文案', '断行文案', '动态字幕断行后', '断行后', '字幕断行', '字幕文本', '字幕文案', 'txtcontent', 'txt_content'],
    tts_text: ['人声-配音文案', '配音文案', 'tts文案', 'tts_text', 'ttstext', 'voice text'],
    voice_id: ['人声id', '音色id', 'voice id', 'voice_id', 'voiceid', 'ttsvoiceid'],
    card_title: ['文字卡片标题', '卡片标题', '覆层标题', '标题', 'title', 'headline'],
    card_body: ['文字卡片正文', '卡片正文', '覆层内容', '覆层正文', '正文', 'body'],
    card_footer: ['文字卡片结尾', '卡片结尾', '覆层结尾', '结尾', '尾标', 'footer', 'ending'],
    scroll_title: ['滚动字幕标题', '滚动标题', 'scroll_title', 'scroll title'],
    scroll_body: ['滚动字幕正文', '滚动字幕内容', '滚动正文', '滚动内容', 'scroll_body', 'scroll body'],
    plain_text: ['普通文本', '文本', 'text'],
    export_name: ['导出命名', '视频命名', '命名', '文件名', 'exportname', 'export_name', 'filename'],
};

function _bcTextColumnCandidatesForCategory(category) {
    return _bcTextColumnCandidates(BC_FIELD_CATEGORY_COLUMN_NAMES[category] || []);
}

function _bcCandidatesForField(field) {
    return _bcTextColumnCandidatesForCategory(field.category);
}

// ── Auto-bind columns by name matching ──
function _bcAutoBind(task, templateIndex = 0) {
    const bindings = {};
    const fields = _bcFieldsFromTask(task);
    const cols = _bulkState.columns;
    let plainTextOrder = 0;

    fields.forEach(f => {
        if (f.type === 'text') {
            if (['ai_source', 'dynamic_subtitle', 'tts_text'].includes(f.category)) return;
            let fallback = _bcPickCandidateForTemplate(_bcCandidatesForField(f), templateIndex);
            if (fallback < 0 && f.category === 'plain_text') {
                fallback = _bcPickCandidateForTemplate(
                    plainTextOrder++ === 0
                        ? _bcTextColumnCandidates(['标题', 'title', 'headline'])
                        : _bcTextColumnCandidates(['正文', 'body']),
                    templateIndex
                );
            }
            if (fallback >= 0 && _bcFieldAcceptsColumn(f, cols[fallback])) bindings[f.key] = fallback;
        } else {
            const ci = cols.findIndex(c => {
                if (!_bcFieldAcceptsColumn(f, c)) return false;
                const n = c.name.toLowerCase();
                const fk = f.key.replace(/^L\d+_/, '');
                return n.includes(fk) || f.label.toLowerCase().includes(n);
            });
            if (ci >= 0) bindings[f.key] = ci;
        }
    });
    return bindings;
}

function _bcEnsureTemplateBindings(tpl) {
    if (!tpl) return;
    if (!tpl.bindings || typeof tpl.bindings !== 'object') tpl.bindings = {};
    const auto = _bcAutoBind(tpl.task || {}, Math.max(0, _bulkState.templates.indexOf(tpl)));
    for (const [key, value] of Object.entries(auto)) {
        if (tpl.bindings[key] == null) tpl.bindings[key] = value;
    }
}

function _bcFindTextColumnByNames(names) {
    for (const name of names) {
        const ci = _bulkState.columns.findIndex(c => {
            if (!c || c.type !== 'text') return false;
            return String(c.name || '').toLowerCase().includes(name);
        });
        if (ci >= 0) return ci;
    }
    return -1;
}

function _bcAutoRebindTemplate(tpl) {
    if (!tpl) return;
    tpl.bindings = _bcAutoBind(tpl.task || {}, Math.max(0, _bulkState.templates.indexOf(tpl)));
}

function _bcAutoRebindAllTemplates() {
    _bulkState.templates.forEach(_bcAutoRebindTemplate);
    _bcRenderBindings();
    _bcScheduleDraftSave();
}

// 粘贴新 TSV 会替换 columns 数组。绑定若只保存列下标，表头顺序一变就会
// 指到错误字段；因此在替换前记住“字段 → 表头名”，替换后按同名表头恢复。
// 重名列按原来同名列的出现顺序匹配，避免多个“标题”都落到第一个标题列。
function _bcSnapshotBindingsByHeader() {
    const oldColumns = (_bulkState.columns || []).map((column, ci) =>
        !String(column?.name || '').trim() && _bulkState.retainedHeaderColumns?.[ci]?.name
            ? { ...column, name: _bulkState.retainedHeaderColumns[ci].name } : column);
    return (_bulkState.templates || []).map(tpl => {
        return Object.entries(tpl.bindings || {}).map(([field, ci]) => {
            const col = oldColumns[Number(ci)];
            if (!col) return null;
            const name = String(col.name || '').trim();
            // 空表头没有可识别身份。故意不把它当作“列”去猜测恢复，
            // 否则清空某列表头后会产生看不见的错误绑定。
            if (!name) return { field, name: '', type: col.type, occurrence: -1 };
            const key = `${String(col.type || '')}\u0000${name.toLocaleLowerCase()}`;
            const occurrence = oldColumns.slice(0, Number(ci)).filter(previous =>
                previous && `${String(previous.type || '')}\u0000${String(previous.name || '').trim().toLocaleLowerCase()}` === key).length;
            return { field, name, type: col.type, occurrence };
        }).filter(Boolean);
    });
}

function _bcRestoreBindingsByHeader(snapshot) {
    const columns = _bulkState.columns || [];
    const preserveMissing = (_bulkState.missingHeaderGroupKeys || []).length > 0;
    const unresolved = new Map();
    const retainedColumns = [];
    (_bulkState.templates || []).forEach((tpl, templateIndex) => {
        const restored = {};
        const priorFields = new Set((snapshot?.[templateIndex] || []).map(item => item.field));
        for (const item of snapshot?.[templateIndex] || []) {
            if (!item.name) continue;
            const matches = columns.map((col, ci) => ({ col, ci })).filter(({ col }) =>
                col && col.type === item.type && String(col.name || '').trim().toLocaleLowerCase() === item.name.toLocaleLowerCase());
            // 同名列数量减少时不能退回第一个同名列；那会把“第二个标题”
            // 错绑成“第一个标题”。找不到就保持未绑定，等用户明确选择。
            const hit = matches[item.occurrence];
            if (hit) restored[item.field] = hit.ci;
            else if (preserveMissing) {
                const identity = JSON.stringify([item.type, item.name.toLocaleLowerCase(), item.occurrence]);
                if (!unresolved.has(identity)) {
                    const ci = columns.length;
                    columns.push({ name: '', type: item.type || 'text' });
                    retainedColumns[ci] = { name: item.name, type: item.type };
                    unresolved.set(identity, ci);
                    (_bulkState.rows || []).forEach(row => { while (row.length < columns.length) row.push(''); });
                }
                restored[item.field] = unresolved.get(identity);
            }
        }
        tpl.bindings = restored;
        // 只为此前从未绑定过的新字段补自动绑定；旧字段一旦表头被清空、
        // 改名或同名列数不足，就明确留空而不猜测。
        const auto = _bcAutoBind(tpl.task || {}, templateIndex);
        for (const [field, ci] of Object.entries(auto)) {
            if (!priorFields.has(field) && tpl.bindings[field] == null) tpl.bindings[field] = ci;
        }
    });
    _bulkState.retainedHeaderColumns = retainedColumns;
}

// Match the complete numbered group, never fall back to another group's text.
function _bcNumberedColumnGroups(state = _bulkState) {
    const value = (id, fallback) => document.getElementById(id)?.value ?? fallback;
    const prefix = value('bc-header-prefix', 'reels').trim() + value('bc-header-before', '-');
    const after = value('bc-header-after', '-');
    const groups = new Map();
    const addColumn = (key, number, ci, fieldName) => {
        if (!key || !fieldName) return;
        if (!groups.has(key)) groups.set(key, { key, number, columns: [] });
        groups.get(key).columns.push({ ci, name: fieldName.toLowerCase() });
    };
    const namedGroups = (state.groupAssignments || []).filter(entry => entry.comboName)
        .map(entry => entry.key).sort((a, b) => b.length - a.length);
    (state.columns || []).forEach((col, ci) => {
        const name = String(col.name || '');
        const namedKey = namedGroups.find(key => name.startsWith(key + after));
        if (namedKey) {
            const fieldName = name.slice(namedKey.length + after.length).trim();
            if (!fieldName) return;
            addColumn(namedKey, groups.get(namedKey)?.number ?? groups.size + 1, ci, fieldName);
            return;
        }
        if (name.startsWith(prefix)) {
            const rest = name.slice(prefix.length);
            const match = rest.match(/^-?\d+/);
            if (match && rest.slice(match[0].length).startsWith(after)) {
                const fieldName = rest.slice(match[0].length + after.length).trim();
                addColumn(prefix + match[0], Number(match[0]), ci, fieldName);
                return;
            }
        }

        // 手写列名也可作为编号组：例如「专页-王060-标题」。以前只能识别
        // 按界面规则自动生成的「reels-1-标题」，导致用户自己的前缀或把编号
        // 紧贴前缀时，背景/模板下拉框都显示“未检测到编号组”。取最后一个
        // 字段分隔符。无编号的「领会-标题」也按组名与标准字段识别。
        if (!after) return;
        const separatorAt = name.lastIndexOf(after);
        if (separatorAt <= 0) return;
        const key = name.slice(0, separatorAt).trim();
        const fieldName = name.slice(separatorAt + after.length).trim();
        const numberMatch = key.match(/(\d+)\s*$/);
        if (!numberMatch) {
            const standardFields = new Set([
                ...Object.values(BC_FIELD_CATEGORY_COLUMN_NAMES).flat(),
                '内容', '背景', '背景视频', '背景图片', '素材', '配乐', '音频', '字幕', 'logo',
            ].map(field => String(field).toLowerCase()));
            // 只拆标准字段后缀，避免将普通文本列或「标题-内容」当作组。
            if (!standardFields.has(fieldName.toLowerCase()) || standardFields.has(key.toLowerCase())) return;
        }
        addColumn(key, numberMatch ? Number(numberMatch[1]) : 100000 + ci, ci, fieldName);
    });
    // 只在用户明确选择“清空表头但保留绑定”时，才保留没有表头的组卡片。
    // 直接粘贴替换表格不能沿用旧组，否则右侧会看起来没有跟着新表头变化。
    const retainedMissingKeys = new Set(state.missingHeaderGroupKeys || []);
    (state.groupAssignments || []).forEach((entry, index) => {
        const key = String(entry?.key || '').trim();
        if (!key || groups.has(key) || !retainedMissingKeys.has(key)) return;
        const number = Number((key.match(/(\d+)\s*$/) || [])[1]) || (100000 + index);
        groups.set(key, { key, number, columns: [] });
    });
    return [...groups.values()].sort((a, b) => a.number - b.number);
}

function _bcBindNumberedGroup(tpl, group) {
    const aliases = {
        ai_source: ['原始文案', '原始完整文案'],
        card_body: ['正文', '内容'],
        scroll_title: ['标题'],
        scroll_body: ['正文', '内容'],
        plain_text: ['内容', '正文'],
    };
    const bindings = { ...(tpl.bindings || {}) };
    // 表头全部暂时清空时，保留源模板绑定供任务组卡片提示“缺少表头”。
    // 不能直接清空，否则用户选择“保留绑定”后无从得知缺了什么。
    if (!group?.columns?.length) { tpl.bindings = bindings; return; }
    _bcFieldsFromTask(tpl.task).forEach(field => {
        const candidates = [...(BC_FIELD_CATEGORY_COLUMN_NAMES[field.category] || []), ...(aliases[field.category] || [])];
        const hit = candidates.map(name => group.columns.find(col => col.name === name.toLowerCase()
            && _bcFieldAcceptsColumn(field, _bulkState.columns[col.ci]))).find(Boolean);
        if (hit) bindings[field.key] = hit.ci;
        else if (field.type === 'text') {
            const oldCi = Number(bindings[field.key]);
            // 已绑定的源列若只是被清空了名字，保留索引用于黄色缺失提示；
            // 其他不匹配字段仍按原逻辑解除该组的错误映射。
            if (!Number.isInteger(oldCi) || String(_bulkState.columns[oldCi]?.name || '').trim()) delete bindings[field.key];
        }
    });
    tpl.bindings = bindings;
}

function _bcAssignNumberedGroups(random = false) {
    const groups = _bcNumberedColumnGroups();
    if (!groups.length) { alert('未找到编号组，请检查表头与上方前缀、连接符设置是否一致。'); return; }
    if (!_bulkState.templates.length) { alert("请先添加模板"); return; }
    // Copy groups drive the assignment count; unused templates remain in the library.
    if (groups.length > _bulkState.templates.length) _bulkState.allowTemplateReuse = true;
    const templateIndices = _bulkState.templates.map((_, index) => index);
    let pool = [];
    if (random) {
        if (_bulkState.allowTemplateReuse) {
            pool = groups.map(() => Math.floor(Math.random() * _bulkState.templates.length));
        } else {
            let shuffled = [];
            while (pool.length < groups.length) {
                if (!shuffled.length) {
                    shuffled = [...templateIndices];
                    for (let i = shuffled.length - 1; i > 0; i--) {
                        const j = Math.floor(Math.random() * (i + 1));
                        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
                    }
                }
                pool.push(shuffled.shift());
            }
        }
    } else {
        if (_bulkState.allowTemplateReuse) {
            pool = groups.map((_, i) => i % _bulkState.templates.length);
        } else {
            pool = groups.map((_, i) => i < templateIndices.length ? templateIndices[i] : -1);
        }
    }
    const previousAssignments = _bulkState.groupAssignments || [];
    _bulkState.groupAssignments = groups.map((group, index) => {
        const rawIdx = pool[index];
        const templateIndex = rawIdx != null ? rawIdx : -1;
        if (templateIndex >= 0 && _bulkState.templates[templateIndex]) {
            _bcBindNumberedGroup(_bulkState.templates[templateIndex], group);
        }
        const previous = previousAssignments.find(entry => entry.key === group.key);
        return {
            key: group.key,
            templateIndex,
            bindings: {},
            backgroundFolder: previous?.backgroundFolder || '',
            backgroundMode: previous?.backgroundMode || 'cycle',
            backgroundSeed: previous?.backgroundSeed,
            musicPath: previous?.musicPath || '',
            musicMode: previous?.musicMode || 'suite'
        };
    });
    _bcRenderBindings();
    _bcScheduleDraftSave();
    if (typeof showToast === 'function') {
        const desc = _bulkState.allowTemplateReuse ? '（可重复）' : '（一一配对）';
        showToast(`🎲 已${random ? '随机分配' : '按顺序分配'} ${groups.length} 个编号组的模板${desc}`, 'success');
    }
}

function _bcClearAllTemplateBindings() {
    _bulkState.groupAssignments = null;
    _bulkState.templates.forEach(tpl => { tpl.bindings = {}; });
    _bcRenderBindings();
    _bcScheduleDraftSave();
}

function _bcClearTemplateAssignments() {
    if (!Array.isArray(_bulkState.groupAssignments) || !_bulkState.groupAssignments.length) {
        if (typeof showToast === 'function') showToast('当前没有模板分配', 'info');
        return;
    }
    _bulkState.groupAssignments.forEach(entry => {
        entry.templateIndex = -1;
        delete entry.presetTemplateIds;
        entry.bindings = {};
        delete entry.overlayOverrides;
        delete entry.overlayAboveSubtitle;
    });
    _bcRenderBindings();
    _bcScheduleDraftSave();
    if (typeof showToast === 'function') showToast('已清空全部编号组的模板分配', 'info');
}

function _bcClearTemplateLibrary() {
    if (!_bulkState.templates?.length) {
        if (typeof showToast === 'function') showToast('模版库已经是空的', 'info');
        else alert('模版库已经是空的');
        return;
    }
    if (confirm('确定清空模版库中的所有模板？')) {
        _bulkState.templates = [];
        (_bulkState.groupAssignments || []).forEach(entry => {
            entry.templateIndex = -1;
            delete entry.presetTemplateIds;
            entry.bindings = {};
            delete entry.overlayOverrides;
            delete entry.overlayAboveSubtitle;
        });
        _bcRenderBindings();
        _bcScheduleDraftSave();
        if (typeof showToast === 'function') showToast('已清空模版库', 'info');
    }
}

function _bcChangeTemplateGroupAssignment(ti, oldGroupKey, newGroupKey) {
    ti = Number(ti);
    if (!Array.isArray(_bulkState.groupAssignments)) _bulkState.groupAssignments = [];
    if (oldGroupKey && oldGroupKey !== newGroupKey) {
        const oldEntry = _bulkState.groupAssignments.find(item => item.key === oldGroupKey);
        if (oldEntry && oldEntry.templateIndex === ti) {
            oldEntry.templateIndex = -1;
            oldEntry.bindings = {};
            delete oldEntry.overlayOverrides;
            delete oldEntry.overlayAboveSubtitle;
        }
    }
    if (newGroupKey) {
        const groups = _bcNumberedColumnGroups();
        const group = groups.find(g => g.key === newGroupKey);
        let newEntry = _bulkState.groupAssignments.find(item => item.key === newGroupKey);
        if (!newEntry) {
            newEntry = { key: newGroupKey, templateIndex: ti, bindings: {}, backgroundMode: 'cycle', musicMode: 'suite' };
            _bulkState.groupAssignments.push(newEntry);
        } else {
            newEntry.templateIndex = ti;
            newEntry.bindings = {};
            delete newEntry.overlayOverrides;
            delete newEntry.overlayAboveSubtitle;
        }
        if (_bulkState.templates[ti] && group) {
            _bcBindNumberedGroup(_bulkState.templates[ti], group);
        }
    }
    _bcRenderBindings();
    _bcScheduleDraftSave();
    if (typeof showToast === 'function') {
        const tplLabel = _bulkState.templates[ti]?.label || `模板${ti + 1}`;
        if (newGroupKey) showToast(`✅ 已将「${tplLabel}」分配给 ${newGroupKey}`, 'success');
        else if (oldGroupKey) showToast(`已取消 ${oldGroupKey} 的模板分配，该组已空出`, 'info');
    }
}

function _bcUnassignTemplateFromGroup(groupKey) {
    if (!Array.isArray(_bulkState.groupAssignments)) return;
    const entry = _bulkState.groupAssignments.find(item => item.key === groupKey);
    if (entry && entry.templateIndex >= 0) {
        entry.templateIndex = -1;
        entry.bindings = {};
        delete entry.overlayOverrides;
        delete entry.overlayAboveSubtitle;
        _bcRenderBindings();
        _bcScheduleDraftSave();
        if (typeof showToast === 'function') {
            showToast(`已取消 ${groupKey} 的模板分配，该组已空出`, 'info');
        }
    }
}

function _bcUnassignAllGroupsForTemplate(ti) {
    ti = Number(ti);
    if (!Array.isArray(_bulkState.groupAssignments)) return;
    let changed = false;
    _bulkState.groupAssignments.forEach(entry => {
        if (entry.templateIndex === ti) {
            entry.templateIndex = -1;
            entry.bindings = {};
            delete entry.overlayOverrides;
            delete entry.overlayAboveSubtitle;
            changed = true;
        }
    });
    if (changed) {
        _bcRenderBindings();
        _bcScheduleDraftSave();
        if (typeof showToast === 'function') {
            showToast(`已取消该模板的全部组分配`, 'info');
        }
    }
}

function _bcAssignedTemplate(assignment, group) {
    const source = _bulkState.templates[assignment.templateIndex];
    if (!source || !group) return null;
    if (assignment.backgroundSeed == null) assignment.backgroundSeed = Math.floor(Math.random() * 4294967296);
    const tpl = { ...source, bindings: { ...source.bindings }, assignedBackgroundFolder: assignment.backgroundFolder, assignedBackgroundMode: assignment.backgroundMode, assignedBackgroundFiles: assignment.selectedBackgroundFiles || [], assignedBackgroundSeed: assignment.backgroundSeed };
    tpl.assignedMusicPath = assignment.musicPath || '';
    tpl.assignedMusicMode = assignment.musicMode || 'suite';
    tpl.assignedMusicTaskAssignments = { ...(assignment.musicTaskAssignments || {}) };
    if (Array.isArray(assignment.overlayOverrides)) tpl.task = { ...source.task, overlays: JSON.parse(JSON.stringify(assignment.overlayOverrides)) };
    // 覆层媒体预设与媒体文件夹完全分开：预设替换覆层样式，文件夹只替换指定媒体槽。
    if (Array.isArray(assignment.overlayMediaPresetLayers)) tpl.task = { ...tpl.task, overlays: JSON.parse(JSON.stringify(assignment.overlayMediaPresetLayers)) };
    tpl.assignedOverlayMediaFolder = assignment.overlayMediaFolder || '';
    tpl.assignedOverlayMediaSlot = typeof assignment.overlayMediaSlot === 'string'
        ? assignment.overlayMediaSlot
        : (Number.isInteger(assignment.overlayMediaSlot) ? assignment.overlayMediaSlot : null);
    tpl.logoOverlay = assignment.logoOverlay ? JSON.parse(JSON.stringify(assignment.logoOverlay)) : null;
    if (assignment.overlayAboveSubtitle != null) tpl.task = { ...tpl.task, overlayAboveSubtitle: assignment.overlayAboveSubtitle };
    _bcBindNumberedGroup(tpl, group);
    Object.entries(assignment.bindings || {}).forEach(([field, name]) => {
        const ci = _bulkState.columns.findIndex(col => col.name === name);
        if (name != null && ci >= 0) tpl.bindings[field] = ci;
        else delete tpl.bindings[field];
    });
    return tpl;
}

function _bcAssignedPresetTemplate(entry, group, templateId) {
    const ti = _bulkState.templates.findIndex(tpl => tpl.bulkTemplateId === templateId);
    if (ti < 0) return null;
    // 预设各自保留覆层与字段结构，共用任务组的背景、配乐和媒体分配。
    const assignment = { ...entry, templateIndex: ti, bindings: {} };
    delete assignment.overlayOverrides;
    delete assignment.overlayMediaPresetLayers;
    return _bcAssignedTemplate(assignment, group);
}

// 更新已渲染的当前编号组卡片，不重建模板库、背景库和其它编号组。
function _bcGroupHasConfiguration(entry) {
    return !!entry && (Number.isInteger(entry.templateIndex) && entry.templateIndex >= 0
        || !!entry.backgroundFolder || !!entry.overlayMediaFolder || !!entry.musicPath || !!entry.logoOverlay
        || Object.keys(entry.bindings || {}).length > 0 || !!entry.overlayOverrides || !!entry.overlayMediaPresetLayers
        || Object.keys(entry.musicTaskAssignments || {}).length > 0);
}

function _bcRebindGroupToHeaders(oldKey, newKey) {
    if (oldKey === newKey) return [];
    const groups = _bcNumberedColumnGroups();
    const target = groups.find(group => group.key === newKey && group.columns.length);
    const old = (_bulkState.groupAssignments || []).find(entry => entry.key === oldKey);
    if (!old) throw new Error('原任务组没有保存的分配');
    if (!target) throw new Error('请选择一个有文案表头的新任务组');
    const existing = _bulkState.groupAssignments.find(entry => entry.key === newKey);
    if (_bcGroupHasConfiguration(existing)) throw new Error('新任务组已有配置，请选择未分配的组，以免覆盖现有修改');
    const copied = JSON.parse(JSON.stringify(old));
    copied.key = newKey;
    const missing = [];
    const after = document.getElementById('bc-header-after')?.value ?? '-';
    const remapName = (field, name) => {
        if (typeof name !== 'string') return name;
        // Only the old group's fields move; explicit bindings to shared columns stay shared.
        if (!name.startsWith(oldKey + after)) return name;
        const suffix = name.slice(oldKey.length + after.length).trim().toLocaleLowerCase();
        const column = target.columns.find(item => item.name.toLocaleLowerCase() === suffix);
        if (!column) { missing.push(field); return null; }
        return _bulkState.columns[column.ci].name;
    };
    copied.bindings = Object.fromEntries(Object.entries(old.bindings || {}).map(([field, name]) => [field, remapName(field, name)]));
    const source = _bulkState.templates[old.templateIndex];
    Object.entries(source?.bindings || {}).forEach(([field, ci]) => {
        if (Object.prototype.hasOwnProperty.call(copied.bindings, field)) return;
        const name = _bulkState.columns[Number(ci)]?.name || _bulkState.retainedHeaderColumns?.[Number(ci)]?.name;
        if (name?.startsWith(oldKey + after)) copied.bindings[field] = remapName(field, name);
    });
    _bulkState.groupAssignments = _bulkState.groupAssignments.filter(entry => entry.key !== oldKey && entry.key !== newKey);
    _bulkState.groupAssignments.push(copied);
    _bulkState.missingHeaderGroupKeys = (_bulkState.missingHeaderGroupKeys || []).filter(key => key !== oldKey && key !== newKey);
    return [...new Set(missing)];
}

function _bcChooseNewHeaderGroup(oldKey) {
    const entry = (_bulkState.groupAssignments || []).find(item => item.key === oldKey);
    if (!entry) { alert('请先为此任务组分配模板或素材'); return; }
    const targets = _bcNumberedColumnGroups().filter(group => group.key !== oldKey && group.columns.length);
    if (!targets.length) { alert('还没有可绑定的新文案组，请先粘贴包含新组名的表头。'); return; }
    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;inset:0;z-index:300001;background:rgba(0,0,0,.85);display:flex;align-items:center;justify-content:center;';
    modal.innerHTML = `<div style="background:#1a1a2e;color:#eee;border:1px solid #444;border-radius:10px;width:min(560px,95vw);padding:16px;"><b>绑定到新文案组 · ${_bcEsc(oldKey)}</b><div style="font-size:12px;color:#aaa;line-height:1.6;margin:10px 0;">将此组的模板、背景、配乐、Logo 和覆层修改移到所选文案组。按字段名重新绑定；新组没有的字段会提示，不会绑定到其他组。</div><select data-new-header-group class="bc-select" style="width:100%;height:32px;"><option value="">请选择新文案组</option>${targets.map(group => {
        const occupied = _bcGroupHasConfiguration((_bulkState.groupAssignments || []).find(item => item.key === group.key));
        return `<option value="${_bcEsc(group.key)}" ${occupied ? 'disabled' : ''}>${_bcEsc(group.key)} · ${group.columns.length} 列${occupied ? '（已有配置）' : ''}</option>`;
    }).join('')}</select><div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px;"><button data-rebind-cancel class="bc-btn bc-btn-default">取消</button><button data-rebind-apply class="bc-btn bc-btn-primary">绑定新文案组</button></div></div>`;
    document.body.appendChild(modal);
    modal.querySelector('[data-rebind-cancel]').onclick = () => modal.remove();
    modal.querySelector('[data-rebind-apply]').onclick = () => {
        const newKey = modal.querySelector('[data-new-header-group]').value;
        if (!newKey) { alert('请选择新文案组'); return; }
        try {
            const missing = _bcRebindGroupToHeaders(oldKey, newKey);
            _bcRenderBindings(); _bcScheduleDraftSave(); modal.remove();
            if (missing.length) alert(`已绑定到「${newKey}」，以下字段在新组中没有匹配表头，请手动选择：${missing.join('、')}`);
            else if (typeof showToast === 'function') showToast(`已将「${oldKey}」绑定到「${newKey}」，素材与覆层修改已保留`, 'success');
        } catch (error) { alert(error.message || error); }
    };
}

function _bcPatchGroupCard(key) {
    const card = Array.from(document.querySelectorAll('.bc-group-card'))
        .find(node => node.dataset.bcGroupCard === String(key));
    const entry = (_bulkState.groupAssignments || []).find(item => item.key === key);
    if (!card || !entry) return false;
    const setValue = (selector, value) => {
        const input = card.querySelector(selector);
        if (input) input.value = value == null ? '' : String(value);
    };
    setValue('.bc-group-template', entry.templateIndex);
    setValue('.bc-group-background', entry.backgroundFolder || '');
    setValue('.bc-group-background-mode', entry.backgroundMode || 'cycle');
    setValue('.bc-group-music-mode', entry.musicMode || 'suite');
    setValue('.bc-group-music', entry.musicPath || '');
    setValue('.bc-group-overlay-media', entry.overlayMediaFolder || '');
    const music = card.querySelector('.bc-group-music');
    if (music) music.disabled = entry.musicMode === 'cycle' || entry.musicMode === 'random';
    const mediaStatus = card.querySelector('[data-bc-group-media]');
    if (mediaStatus) {
        const group = _bcNumberedColumnGroups().find(item => item.key === key);
        mediaStatus.innerHTML = _bcGroupMediaStatusSlot(entry, _bcAssignedTemplate(entry, group));
        _bcScheduleMediaPathCheck();
    }
    return true;
}

function _bcSetGroupTemplate(key, templateIndex, options = {}) {
    if (!_bulkState.groupAssignments) _bulkState.groupAssignments = [];
    const entries = _bulkState.groupAssignments;
    let entry = entries.find(item => item.key === key);
    if (!_bulkState.allowTemplateReuse && templateIndex >= 0) {
        const other = entries.find(item => item.key !== key && item.templateIndex === templateIndex);
        if (other) { other.templateIndex = entry?.templateIndex ?? -1; other.bindings = {}; delete other.overlayOverrides; delete other.overlayAboveSubtitle; }
    }
    if (!entry) { entry = { key }; entries.push(entry); }
    entry.templateIndex = templateIndex;
    delete entry.presetTemplateIds;
    entry.bindings = {};
    delete entry.overlayOverrides;
    delete entry.overlayAboveSubtitle;
    if (options.refresh !== false) _bcRenderBindings();
    else _bcPatchGroupCard(key);
    _bcScheduleDraftSave();
}

function _bcSaveSuiteOverlays(entry, overlays) {
    const old = entry.overlayOverrides || _bulkState.templates[entry.templateIndex]?.task?.overlays || [];
    const bindings = {};
    Object.entries(entry.bindings || {}).forEach(([field, value]) => {
        const match = field.match(/^L(\d+)_(.+)$/);
        if (!match) { bindings[field] = value; return; }
        const id = old[Number(match[1])]?.id;
        const index = overlays.findIndex(overlay => id != null && overlay.id === id);
        if (index >= 0) bindings[`L${index}_${match[2]}`] = value;
    });
    entry.bindings = bindings;
    entry.overlayOverrides = JSON.parse(JSON.stringify(overlays));
}

function _bcAssignBackgroundGroups(random = false) {
    const folders = _bulkState.backgroundFolders.filter(folder => folder.files?.length);
    if (!folders.length) { alert('请先添加含有视频或图片的背景文件夹'); return; }
    // 背景可先于模板独立分配；也兼容旧草稿中残留的空编号组项。
    if (!Array.isArray(_bulkState.groupAssignments)) _bulkState.groupAssignments = [];
    _bulkState.groupAssignments = _bulkState.groupAssignments.filter(entry => entry && typeof entry.key === 'string');
    const groups = _bcNumberedColumnGroups();
    if (!groups.length) { alert('未找到编号组，请检查表头与上方前缀、连接符设置是否一致。'); return; }
    let pool = [];
    if (random) {
        if (_bulkState.allowBackgroundReuse) {
            pool = groups.map(() => folders[Math.floor(Math.random() * folders.length)].path);
        } else {
            let shuffled = [];
            while (pool.length < groups.length) {
                if (!shuffled.length) {
                    shuffled = [...folders.map(f => f.path)];
                    for (let i = shuffled.length - 1; i > 0; i--) {
                        const j = Math.floor(Math.random() * (i + 1));
                        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
                    }
                }
                pool.push(shuffled.shift());
            }
        }
    } else {
        if (_bulkState.allowBackgroundReuse) {
            pool = groups.map((_, i) => folders[i % folders.length].path);
        } else {
            pool = groups.map((_, i) => i < folders.length ? folders[i].path : '');
        }
    }
    groups.forEach((group, index) => {
        let entry = _bulkState.groupAssignments.find(item => item.key === group.key);
        if (!entry) {
            const templateIndex = _bulkState.templates.length ? (index % _bulkState.templates.length) : -1;
            entry = { key: group.key, templateIndex, bindings: {}, backgroundMode: 'cycle', musicMode: 'suite' };
            _bulkState.groupAssignments.push(entry);
        }
        if (entry.templateIndex < 0 && _bulkState.templates.length) {
            entry.templateIndex = index % _bulkState.templates.length;
        }
        entry.backgroundFolder = pool[index] || '';
        entry.backgroundSeed = Math.floor(Math.random() * 4294967296);
    });
    _bcRenderBindings();
    _bcScheduleDraftSave();
    if (typeof showToast === 'function') {
        const desc = _bulkState.allowBackgroundReuse ? '（可重复）' : (folders.length >= groups.length ? '（不重复）' : '（循环轮次不重复）');
        showToast(`已为 ${groups.length} 个编号组${random ? '🎲 随机分配' : '按顺序分配'}背景素材${desc}`, 'success');
    }
}

function _bcRandomizeBackgroundGroups() {
    _bcAssignBackgroundGroups(true);
}

function _bcClearBackgroundAssignments() {
    if (!Array.isArray(_bulkState.groupAssignments) || !_bulkState.groupAssignments.length) {
        if (typeof showToast === 'function') showToast('当前没有背景素材分配', 'info');
        return;
    }
    _bulkState.groupAssignments.forEach(entry => {
        entry.backgroundFolder = '';
    });
    _bcRenderBindings();
    _bcScheduleDraftSave();
    if (typeof showToast === 'function') showToast('已清空全部编号组的背景素材分配', 'info');
}

function _bcAssignOverlayMediaGroups() {
    const folders = _bulkState.overlayMediaFolders.filter(folder => folder.files?.length);
    const groups = _bcNumberedColumnGroups();
    if (!folders.length) { alert('请先添加含图片或视频的覆层媒体文件夹'); return; }
    if (!groups.length) { alert('未找到编号组，请先建立编号列组'); return; }
    if (!_bulkState.groupAssignments?.length) _bcAssignNumberedGroups();
    groups.forEach((group, i) => {
        let entry = _bulkState.groupAssignments.find(item => item.key === group.key);
        if (!entry) { entry = { key: group.key, templateIndex: -1, bindings: {} }; _bulkState.groupAssignments.push(entry); }
        entry.overlayMediaFolder = folders[i % folders.length].path;
    });
    _bcRenderBindings(); _bcScheduleDraftSave();
    if (typeof showToast === 'function') showToast(`已把 ${folders.length} 个覆层媒体文件夹顺序分配给 ${groups.length} 个任务组`, 'success');
}

function _bcAssignLogoMediaGroups(random = false) {
    const sources = _bulkState.logoMediaLibrary.filter(item => item.files?.length);
    const groups = _bcNumberedColumnGroups();
    if (!sources.length) { alert('请先添加 Logo 媒体或媒体文件夹'); return; }
    if (!groups.length) { alert('未找到编号组，请先建立编号列组'); return; }
    if (!_bulkState.groupAssignments?.length) _bcAssignNumberedGroups();
    groups.forEach((group, index) => {
        let entry = _bulkState.groupAssignments.find(item => item.key === group.key);
        if (!entry) { entry = { key: group.key, templateIndex: -1, bindings: {} }; _bulkState.groupAssignments.push(entry); }
        const source = random ? sources[Math.floor(Math.random() * sources.length)] : sources[index % sources.length];
        entry.logoOverlay = entry.logoOverlay || { overlay: _bcDefaultLogoOverlay() };
        entry.logoOverlay.enabled = true;
        entry.logoOverlay.sourceId = source.id;
        entry.logoOverlay.taskMode = entry.logoOverlay.taskMode || 'cycle';
        entry.logoOverlay.overlay = entry.logoOverlay.overlay || _bcDefaultLogoOverlay();
    });
    _bcRenderBindings(); _bcScheduleDraftSave();
    if (typeof showToast === 'function') showToast(`已${random ? '随机' : '顺序'}分配 Logo 媒体给 ${groups.length} 个任务组（允许重复）`, 'success');
}

function _bcAssignMusicGroups(random = false) {
    if (!_bulkState.musicFiles.length) { alert('请先添加配乐文件'); return; }
    const groups = _bcNumberedColumnGroups();
    if (!groups.length) { alert('未找到编号组，请检查表头与上方前缀、连接符设置是否一致。'); return; }
    if (!_bulkState.groupAssignments || !_bulkState.groupAssignments.length) {
        _bcAssignNumberedGroups();
    }
    let pool = [];
    if (random) {
        if (_bulkState.allowMusicReuse) {
            pool = groups.map(() => _bulkState.musicFiles[Math.floor(Math.random() * _bulkState.musicFiles.length)].path);
        } else {
            let shuffled = [];
            while (pool.length < groups.length) {
                if (!shuffled.length) {
                    shuffled = [..._bulkState.musicFiles.map(f => f.path)];
                    for (let i = shuffled.length - 1; i > 0; i--) {
                        const j = Math.floor(Math.random() * (i + 1));
                        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
                    }
                }
                pool.push(shuffled.shift());
            }
        }
    } else {
        if (_bulkState.allowMusicReuse) {
            pool = groups.map((_, i) => _bulkState.musicFiles[i % _bulkState.musicFiles.length].path);
        } else {
            pool = groups.map((_, i) => i < _bulkState.musicFiles.length ? _bulkState.musicFiles[i].path : '');
        }
    }
    groups.forEach((group, index) => {
        let entry = _bulkState.groupAssignments.find(item => item.key === group.key);
        if (!entry) {
            const templateIndex = _bulkState.templates.length ? (index % _bulkState.templates.length) : -1;
            entry = { key: group.key, templateIndex, bindings: {}, backgroundMode: 'cycle', musicMode: 'suite' };
            _bulkState.groupAssignments.push(entry);
        }
        if (entry.templateIndex < 0 && _bulkState.templates.length) {
            entry.templateIndex = index % _bulkState.templates.length;
        }
        // “顺序分配” means one soundtrack per numbered group, so it must
        // explicitly leave task-level random/cycle mode.
        entry.musicMode = 'suite';
        entry.musicPath = pool[index] || '';
        delete entry.musicTaskAssignments;
    });
    _bcRenderBindings();
    _bcScheduleDraftSave();
    if (typeof showToast === 'function') {
        const desc = _bulkState.allowMusicReuse ? '（可重复）' : '（不重复）';
        showToast(`已为 ${groups.length} 个编号组${random ? '🎲 随机分配' : '按顺序分配'}配乐${desc}`, 'success');
    }
}

function _bcRandomizeMusicGroups() {
    if (!_bulkState.musicFiles.length) { alert('请先添加配乐文件'); return; }
    const groups = _bcNumberedColumnGroups();
    if (!groups.length) { alert('未找到编号组，请检查表头与上方前缀、连接符设置是否一致。'); return; }
    if (!_bulkState.groupAssignments || !_bulkState.groupAssignments.length) {
        _bcAssignNumberedGroups();
    }
    const allocator = _bcCreateRandomMusicAllocator();
    groups.forEach((group, index) => {
        let entry = _bulkState.groupAssignments.find(item => item.key === group.key);
        if (!entry) {
            const templateIndex = _bulkState.templates.length ? (index % _bulkState.templates.length) : -1;
            entry = { key: group.key, templateIndex, bindings: {}, backgroundMode: 'cycle', musicMode: 'suite' };
            _bulkState.groupAssignments.push(entry);
        }
        // This is intentionally a task-level mode.  Do not pick one song here:
        // a numbered group may generate many task rows.  We do draw them now
        // and persist the result, so the library can clearly show the exact
        // group/task usage and later generation remains reproducible.
        entry.musicMode = 'random';
        entry.musicPath = '';
        const tpl = _bcAssignedTemplate(entry, group);
        const assignments = {};
        let taskIndex = 0;
        (_bulkState.rows || []).forEach(row => {
            if (!tpl || !_bcRowHasBoundData(tpl, row)) return;
            assignments[taskIndex++] = allocator.next();
        });
        entry.musicTaskAssignments = assignments;
    });
    _bcRenderBindings();
    _bcScheduleDraftSave();
    if (typeof showToast === 'function') {
        const count = Object.values(_bulkState.groupAssignments || {}).reduce((sum, entry) => sum + Object.keys(entry?.musicTaskAssignments || {}).length, 0);
        showToast(`🎲 已为 ${count} 条任务随机分配配乐；下方每首配乐会列出对应任务`, 'success');
    }
}

function _bcClearMusicAssignments() {
    if (!Array.isArray(_bulkState.groupAssignments) || !_bulkState.groupAssignments.length) {
        if (typeof showToast === 'function') showToast('当前没有配乐分配', 'info');
        return;
    }
    _bulkState.groupAssignments.forEach(entry => {
        entry.musicPath = '';
        delete entry.musicTaskAssignments;
    });
    _bcRenderBindings();
    _bcScheduleDraftSave();
    if (typeof showToast === 'function') showToast('已清空全部编号组的配乐分配', 'info');
}

function _bcChangeFolderGroupAssignment(folderPath, oldGroupKey, newGroupKey) {
    if (!Array.isArray(_bulkState.groupAssignments)) _bulkState.groupAssignments = [];
    if (oldGroupKey && oldGroupKey !== newGroupKey) {
        const oldEntry = _bulkState.groupAssignments.find(item => item.key === oldGroupKey);
        if (oldEntry && oldEntry.backgroundFolder === folderPath) {
            oldEntry.backgroundFolder = '';
        }
    }
    if (newGroupKey) {
        const groups = _bcNumberedColumnGroups();
        const groupIndex = groups.findIndex(g => g.key === newGroupKey);
        let newEntry = _bulkState.groupAssignments.find(item => item.key === newGroupKey);
        if (!newEntry) {
            const templateIndex = _bulkState.templates.length ? (Math.max(0, groupIndex) % _bulkState.templates.length) : -1;
            newEntry = { key: newGroupKey, templateIndex, bindings: {}, backgroundMode: 'cycle', musicMode: 'suite' };
            _bulkState.groupAssignments.push(newEntry);
        }
        if (newEntry.templateIndex < 0 && _bulkState.templates.length) {
            newEntry.templateIndex = Math.max(0, groupIndex) % _bulkState.templates.length;
        }
        newEntry.backgroundFolder = folderPath;
        newEntry.backgroundSeed = Math.floor(Math.random() * 4294967296);
    }
    _bcRenderBindings();
    _bcScheduleDraftSave();
    if (typeof showToast === 'function') {
        const folderName = _bcFileName(folderPath);
        if (newGroupKey) {
            showToast(`✅ 已将「${folderName}」分配给 ${newGroupKey}`, 'success');
        } else if (oldGroupKey) {
            showToast(`已取消 ${oldGroupKey} 的背景素材分配，该组已空出`, 'info');
        }
    }
}

function _bcUnassignFolderFromGroup(groupKey) {
    if (!Array.isArray(_bulkState.groupAssignments)) return;
    const entry = _bulkState.groupAssignments.find(item => item.key === groupKey);
    if (entry && entry.backgroundFolder) {
        entry.backgroundFolder = '';
        _bcRenderBindings();
        _bcScheduleDraftSave();
        if (typeof showToast === 'function') {
            showToast(`已取消 ${groupKey} 的背景素材分配，该组已空出`, 'info');
        }
    }
}

function _bcUnassignAllFoldersForPath(folderPath) {
    if (!Array.isArray(_bulkState.groupAssignments)) return;
    let changed = false;
    _bulkState.groupAssignments.forEach(entry => {
        if (entry.backgroundFolder === folderPath) {
            entry.backgroundFolder = '';
            changed = true;
        }
    });
    if (changed) {
        _bcRenderBindings();
        _bcScheduleDraftSave();
        if (typeof showToast === 'function') {
            showToast(`已取消该素材分类的全部组分配`, 'info');
        }
    }
}

function _bcChangeMusicGroupAssignment(musicPath, oldGroupKey, newGroupKey) {
    if (!Array.isArray(_bulkState.groupAssignments)) _bulkState.groupAssignments = [];
    if (oldGroupKey && oldGroupKey !== newGroupKey) {
        const oldEntry = _bulkState.groupAssignments.find(item => item.key === oldGroupKey);
        if (oldEntry && oldEntry.musicPath === musicPath) {
            oldEntry.musicPath = '';
        }
    }
    if (newGroupKey) {
        const groups = _bcNumberedColumnGroups();
        const groupIndex = groups.findIndex(g => g.key === newGroupKey);
        let newEntry = _bulkState.groupAssignments.find(item => item.key === newGroupKey);
        if (!newEntry) {
            const templateIndex = _bulkState.templates.length ? (Math.max(0, groupIndex) % _bulkState.templates.length) : -1;
            newEntry = { key: newGroupKey, templateIndex, bindings: {}, backgroundMode: 'cycle', musicMode: 'suite' };
            _bulkState.groupAssignments.push(newEntry);
        }
        newEntry.musicPath = musicPath;
    }
    _bcRenderBindings();
    _bcScheduleDraftSave();
    if (typeof showToast === 'function') {
        const musicName = _bcFileName(musicPath);
        if (newGroupKey) showToast(`✅ 已将配乐「${musicName}」分配给 ${newGroupKey}`, 'success');
        else if (oldGroupKey) showToast(`已取消 ${oldGroupKey} 的配乐分配，该组已空出`, 'info');
    }
}

function _bcUnassignMusicFromGroup(groupKey) {
    if (!Array.isArray(_bulkState.groupAssignments)) return;
    const entry = _bulkState.groupAssignments.find(item => item.key === groupKey);
    if (entry && entry.musicPath) {
        entry.musicPath = '';
        _bcRenderBindings();
        _bcScheduleDraftSave();
        if (typeof showToast === 'function') {
            showToast(`已取消 ${groupKey} 的配乐分配，该组已空出`, 'info');
        }
    }
}

function _bcUnassignAllMusicForPath(musicPath) {
    if (!Array.isArray(_bulkState.groupAssignments)) return;
    let changed = false;
    _bulkState.groupAssignments.forEach(entry => {
        if (entry.musicPath === musicPath) {
            entry.musicPath = '';
            changed = true;
        }
    });
    if (changed) {
        _bcRenderBindings();
        _bcScheduleDraftSave();
        if (typeof showToast === 'function') {
            showToast(`已取消该配乐的全部组分配`, 'info');
        }
    }
}

let _bcAudioPreview = null;
let _bcCurrentPlayingMusic = null;

function _bcToggleMusicPreview(audioPath) {
    if (_bcAudioPreview && _bcCurrentPlayingMusic === audioPath) {
        _bcAudioPreview.pause();
        _bcAudioPreview = null;
        _bcCurrentPlayingMusic = null;
        _bcRenderBindings();
        return;
    }
    if (_bcAudioPreview) {
        _bcAudioPreview.pause();
        _bcAudioPreview = null;
        _bcCurrentPlayingMusic = null;
    }
    try {
        const url = _bcFileUrl(audioPath);
        _bcAudioPreview = new Audio();
        _bcAudioPreview.crossOrigin = 'anonymous';
        _bcAudioPreview.src = url;
        _bcCurrentPlayingMusic = audioPath;
        _bcAudioPreview.onended = () => {
            _bcAudioPreview = null;
            _bcCurrentPlayingMusic = null;
            _bcRenderBindings();
        };
        _bcAudioPreview.onerror = () => {
            _bcAudioPreview = null;
            _bcCurrentPlayingMusic = null;
            _bcRenderBindings();
        };
        _bcAudioPreview.play().catch(err => {
            console.warn('[BulkCreate] Audio play error:', err);
        });
        _bcRenderBindings();
    } catch (e) {
        console.warn('[BulkCreate] Audio error:', e);
    }
}

function _bcRenderItemAssignControls(options) {
    const { kind, itemVal, assignedKeys, freeGroups, allGroups } = options;
    const count = assignedKeys.length;
    if (!allGroups.length) {
        return `<select disabled style="flex:1;min-width:0;padding:2px 6px;background:#12121c;color:#666;border:1px solid #333;border-radius:4px;font-size:10px;"><option>未检测到编号组</option></select>`;
    }
    if (count === 1) {
        const currentKey = assignedKeys[0];
        return `<select class="bc-${kind}-assign-group" data-${kind}="${_bcEsc(itemVal)}" data-current-group="${_bcEsc(currentKey)}" style="flex:1;min-width:0;padding:2px 6px;background:#16162a;color:#d8cfff;border:1px solid #7c5cff;border-radius:4px;font-size:10px;cursor:pointer;" title="当前分配给 ${currentKey}；可切换到其他空闲组或取消分配">
            <option value="">⚪ 取消分配（空出该组）</option>
            <option value="${_bcEsc(currentKey)}" selected>🎯 ${_bcEsc(currentKey)}（当前组）</option>
            ${freeGroups.map(g => `<option value="${_bcEsc(g.key)}">${_bcEsc(g.key)}（可分配）</option>`).join('')}
        </select>
        <button class="bc-${kind}-unassign" data-group="${_bcEsc(currentKey)}" style="padding:2px 6px;font-size:10px;cursor:pointer;background:rgba(255,80,80,0.1);border:1px solid rgba(255,80,80,0.3);border-radius:4px;color:#ff8888;flex-shrink:0;" title="取消分配给 ${currentKey}，释放该组">取消分配</button>`;
    }
    if (count === 0) {
        return `<select class="bc-${kind}-assign-group" data-${kind}="${_bcEsc(itemVal)}" data-current-group="" style="flex:1;min-width:0;padding:2px 6px;background:#12121c;color:#8e8ea8;border:1px dashed #44445c;border-radius:4px;font-size:10px;cursor:pointer;" title="选择要分配的编号组（仅显示尚未分配的空闲组）">
            <option value="" selected>⚪ 未分配（点击选择分配组）</option>
            ${freeGroups.length
                ? freeGroups.map(g => `<option value="${_bcEsc(g.key)}">${_bcEsc(g.key)}</option>`).join('')
                : '<option value="" disabled>全部编号组均已有分配</option>'}
        </select>`;
    }
    return `<div style="display:flex;gap:4px;flex-wrap:wrap;align-items:center;flex:1;min-width:0;">
        ${assignedKeys.map(k => `<span style="display:inline-flex;align-items:center;gap:3px;background:rgba(124,92,255,0.22);border:1px solid rgba(124,92,255,0.5);border-radius:3px;padding:1px 5px;color:#d8cfff;font-size:10px;">${_bcEsc(k)} <span class="bc-${kind}-unassign" data-group="${_bcEsc(k)}" style="cursor:pointer;color:#ff8888;font-weight:bold;margin-left:2px;" title="取消分配给 ${k}">✕</span></span>`).join('')}
        <select class="bc-${kind}-assign-group" data-${kind}="${_bcEsc(itemVal)}" data-current-group="" style="padding:2px 6px;background:#181828;color:#b9aaff;border:1px solid #554488;border-radius:4px;font-size:10px;cursor:pointer;" title="追加分配给其他空闲组">
            <option value="" selected>+ 追加组...</option>
            ${freeGroups.map(g => `<option value="${_bcEsc(g.key)}">${_bcEsc(g.key)}</option>`).join('')}
        </select>
    </div>
    <button class="bc-${kind}-unassign-all" data-${kind}="${_bcEsc(itemVal)}" style="padding:2px 6px;font-size:10px;cursor:pointer;background:rgba(255,80,80,0.1);border:1px solid rgba(255,80,80,0.3);border-radius:4px;color:#ff8888;flex-shrink:0;" title="全部取消分配">全部取消</button>`;
}

function _bcVisualPicker(kind, selected, choose, options = {}) {
    const isPicker = typeof choose === 'function';
    const templates = kind === 'template';
    const music = kind === 'music';
    const items = templates ? _bulkState.templates : (music ? _bulkState.musicFiles : _bulkState.backgroundFolders);
    const panel = document.createElement('div');
    panel.style.cssText = 'position:fixed;inset:0;z-index:410000;background:#101018;color:#ddd;padding:20px;display:flex;flex-direction:column;gap:12px;';
    const label = templates ? (isPicker ? '看图选模板' : '模版库') : (music ? (isPicker ? '试听选配乐' : '配乐库') : (isPicker ? '看图选背景' : '背景库浏览'));
    const suffix = templates ? '个模板' : (music ? '首配乐' : '组背景');
    const action = templates ? '模板' : (music ? '配乐' : '背景');
    // 模板可被多个编号组复用。选择器不能只显示“当前这一个组”的选择，
    // 否则用户无法判断哪些模板已经使用、以及复用了多少次。
    const templateUsers = new Map();
    if (templates) {
        (_bulkState.groupAssignments || []).forEach(assignment => {
            const index = Number(assignment?.templateIndex);
            if (!Number.isInteger(index) || index < 0) return;
            const users = templateUsers.get(index) || [];
            users.push(String(assignment.key || `编号组 ${users.length + 1}`));
            templateUsers.set(index, users);
        });
    }
    const usedTemplateCount = templateUsers.size;
    const useCount = templates ? Array.from(templateUsers.values()).reduce((sum, users) => sum + users.length, 0) : 0;
    const templateSummary = templates
        ? ` · <span style="color:${usedTemplateCount ? '#86efac' : '#94a3b8'};">已选 ${usedTemplateCount}/${items.length} 个 · 已用于 ${useCount} 个编号组</span>`
        : '';
    const bgBadge = (templates && options.bgPath)
        ? `<span style="background:rgba(16,185,129,0.18);color:#6ee7b7;border:1px solid rgba(52,211,153,0.35);padding:3px 10px;border-radius:4px;font-size:11px;font-weight:600;display:inline-flex;align-items:center;gap:4px;">🎬 已加载当前素材背景：${_bcEsc(_bcFileName(options.bgPath))}</span>`
        : '';
    panel.innerHTML = `<div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;"><strong>${label}</strong><span>共 ${items.length} ${suffix}${templateSummary}${isPicker ? `，向下滚动浏览；点击卡片替换整套${action}` : '；可向下滚动并左右滑动查看各背景素材'}</span>${bgBadge}${!isPicker || templates ? '' : `<button data-default>${music ? '不使用指定配乐' : '沿用模板背景'}</button>`}<button data-close>返回</button></div><div data-cards style="overflow:auto;flex:1;display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:14px;align-content:start;"></div>`;
    document.body.appendChild(panel);
    ['click', 'mousedown', 'keydown'].forEach(type => panel.addEventListener(type, event => event.stopPropagation()));
    const get = selector => panel.querySelector(selector);
    let revision = 0;
    const cleanup = () => {
        revision++;
        panel.querySelectorAll('video').forEach(video => { video.pause(); video.removeAttribute('src'); video.load(); });
    };
    const close = () => { cleanup(); panel.remove(); };
    const select = value => { close(); if (isPicker) choose(value); };
    const render = () => {
        cleanup();
        const token = revision;
        const grid = get('[data-cards]'); grid.innerHTML = '';
        items.forEach((item, index) => {
            const value = templates ? index : item.path;
            const active = value === selected;
            const usedByGroups = templates ? (templateUsers.get(index) || []) : [];
            const card = document.createElement('button');
            card.style.cssText = `background:#20202c;color:#ddd;border:2px solid ${active ? '#a78bfa' : (usedByGroups.length ? '#34d399' : '#444')};border-radius:8px;padding:10px;text-align:left;cursor:${isPicker ? 'pointer' : 'default'};min-width:0;`;
            const usageHtml = templates && usedByGroups.length
                ? `<div title="已选编号组：${_bcEsc(usedByGroups.join('、'))}" style="margin-top:5px;color:#86efac;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">✓ 已选 · 已用于 ${usedByGroups.length} 个编号组：${_bcEsc(usedByGroups.join('、'))}</div>`
                : '';
            card.innerHTML = `<div data-images style="display:flex;gap:6px;overflow-x:auto;"></div><div style="margin-top:8px;font-weight:bold;">${active ? '✓ 当前正在选择 · ' : ''}${_bcEsc(templates ? item.label : item.name)}</div>${usageHtml}<div data-status style="font-size:12px;color:#aaa;"></div>`;
            grid.appendChild(card);
            if (isPicker) card.onclick = () => select(value);
            const images = card.querySelector('[data-images]');
            const status = card.querySelector('[data-status]');
            if (templates) {
                const img = document.createElement('img');
                img.style.cssText = 'width:100%;height:300px;object-fit:contain;background:#14141e;border-radius:4px;';
                images.appendChild(img); status.textContent = '正在加载模板样式…';
                _bcRenderTemplateThumb(
                    item.task?.overlays || [],
                    2500,
                    options.bgPath || '',
                    options.previewText || null,
                    options.bgMedia || null
                ).then(url => {
                    if (!panel.isConnected || revision !== token) return;
                    if (url) {
                        img.src = url;
                        status.textContent = options.bgPath ? '✓ 已应用当前素材背景实时预览' : '样式示意；选中后左侧显示本组实际文案';
                    } else {
                        status.textContent = '此模板暂无覆层缩略图，点击查看实际效果';
                    }
                }).catch(() => { if (panel.isConnected && revision === token) status.textContent = '缩略图加载失败，可点击查看实际效果'; });
            } else if (music) {
                const audio = document.createElement('audio');
                audio.crossOrigin = 'anonymous';
                audio.controls = true;
                audio.preload = 'metadata';
                audio.src = _bcFileUrl(item.path);
                audio.addEventListener('click', event => event.stopPropagation());
                images.appendChild(audio);
                status.textContent = '点击播放试听；点击卡片即选用。';
            } else {
                status.textContent = `${item.files.length} 个素材 · 左右滚动查看素材缩略图`;
                // Browser lazy images and metadata-only videos avoid starting playback for the library.
                item.files.forEach(path => {
                    const media = document.createElement(_bcMediaKind(path) === 'image' ? 'img' : 'video');
                    media.style.cssText = 'flex:0 0 130px;width:130px;height:220px;object-fit:cover;background:#111;border-radius:4px;';
                    media.title = `${_bcFileName(path)}${media.tagName === 'VIDEO' ? '（点击播放/暂停）' : ''}`;
                    if (media.tagName === 'VIDEO') {
                        media.muted = true;
                        media.preload = 'none';
                        media.playsInline = true;
                        media.style.cursor = 'pointer';
                        media.onclick = e => {
                            e.stopPropagation();
                            if (media.paused) media.play().catch(() => {});
                            else media.pause();
                        };
                    } else {
                        media.loading = 'lazy';
                    }
                    media.dataset.path = path;
                    images.appendChild(media);
                });
                const loadVisible = () => {
                    const bounds = images.getBoundingClientRect();
                    images.querySelectorAll('[data-path]').forEach(media => {
                        const rect = media.getBoundingClientRect();
                        if (rect.right >= bounds.left && rect.left <= bounds.right && !media.getAttribute('src')) {
                            if (media.tagName === 'VIDEO') media.preload = 'auto';
                            media.src = _bcFileUrl(media.dataset.path);
                        } else if ((rect.right < bounds.left || rect.left > bounds.right) && media.tagName === 'VIDEO' && media.getAttribute('src')) {
                            media.pause(); media.removeAttribute('src'); media.load();
                        }
                    });
                };
                images.addEventListener('scroll', loadVisible); loadVisible();
            }
            if (active) {
                setTimeout(() => card.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 60);
            }
        });
    };
    get('[data-close]').onclick = close;
    if (!templates && isPicker && get('[data-default]')) get('[data-default]').onclick = () => select('');
    render();
}

function _bcEditTemplateOverlays(ti) {
    const tpl = _bulkState.templates[ti];
    if (!tpl) return;
    if (typeof ReelsOverlayPanel === 'undefined' || !window.ReelsOverlay?.OverlayManager) {
        alert('覆层编辑器尚未加载');
        return;
    }
    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;inset:0;z-index:450000;background:#000d;display:flex;align-items:center;justify-content:center;';
    modal.innerHTML = `<div style="background:#181822;padding:16px;border-radius:10px;display:flex;gap:16px;max-height:94vh;max-width:96vw;overflow:auto;color:#ddd;">
        <div style="position:relative;width:min(40vw,360px);aspect-ratio:9/16;background:#000;align-self:flex-start;">
            <video crossorigin="anonymous" data-bg-video muted loop playsinline style="position:absolute;width:100%;height:100%;object-fit:cover;"></video>
            <img crossorigin="anonymous" data-bg-image style="position:absolute;width:100%;height:100%;object-fit:cover;display:none;">
            <canvas width="1080" height="1920" style="position:absolute;width:100%;height:100%;pointer-events:none;"></canvas>
        </div>
        <div style="width:280px;display:flex;flex-direction:column;gap:10px;font-size:13px;">
            <strong>✏️ 编辑模板「<span data-tpl-label>${_bcEsc(tpl.label)}</span>」</strong>
            <label>模板名称 <input data-tpl-name value="${_bcEsc(tpl.label)}" style="width:100%;background:#10101b;color:#ddd;border:1px solid #444;border-radius:4px;padding:3px 6px;"></label>
            <label>预览秒数 <input data-time type="number" min="0" value="0" step="0.5" style="width:80px;"></label>
            <button data-play>播放 / 暂停背景</button>
            <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:4px;">
                <button data-save-preset style="padding:4px 10px;background:rgba(245,158,11,0.2);border:1px solid #f59e0b;border-radius:4px;color:#fcd34d;cursor:pointer;font-size:11px;">💾 存为预设</button>
            </div>
            <div data-status style="color:#b9aaff;">修改立即同步并保存草稿</div>
            <div style="color:#999;font-size:11px;">右侧修改覆层参数后，将自动作为该模板的基础样式，使用该模板的编号组将自动应用。</div>
            <button data-close style="margin-top:auto;padding:6px;background:linear-gradient(135deg,#7c5cff,#a855f7);color:#fff;border:none;border-radius:5px;cursor:pointer;font-weight:600;">完成并保存</button>
        </div>
        <div data-host style="width:460px;min-width:380px;max-height:85vh;overflow:auto;border-left:1px solid #444;padding-left:12px;">
            <div style="color:#b9aaff;padding:8px;font-size:11px;">可以直接添加、删除、调整覆层。修改将直接更新此模板。</div>
            <div data-panel></div>
        </div>
    </div>`;
    document.body.appendChild(modal);
    ['click', 'mousedown', 'keydown'].forEach(type => modal.addEventListener(type, event => event.stopPropagation()));

    const get = selector => modal.querySelector(selector);
    const video = get('[data-bg-video]'), img = get('[data-bg-image]'), canvas = get('canvas');
    const localTask = JSON.parse(JSON.stringify(tpl.task || {}));
    if (!Array.isArray(localTask.overlays)) localTask.overlays = [];
    const mgr = new window.ReelsOverlay.OverlayManager();
    mgr.overlays = localTask.overlays;

    const path = localTask.bgPath || localTask.videoPath || '';
    const isImage = _bcMediaKind(path) === 'image';
    img.style.display = isImage ? 'block' : 'none'; video.style.display = isImage ? 'none' : 'block';
    if (path) (isImage ? img : video).src = _bcFileUrl(path);

    const draw = () => {
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, 1080, 1920);
        const time = Math.max(0, Number(get('[data-time]').value) || 0);
        (mgr.overlays || []).forEach(overlay => ReelsOverlay.drawOverlay(ctx, { ...overlay, _exporting: true }, time, 1080, 1920));
    };

    const saveChanges = () => {
        localTask.overlays = mgr.overlays;
        tpl.task.overlays = JSON.parse(JSON.stringify(mgr.overlays));
        if (localTask.overlayAboveSubtitle != null) {
            tpl.task.overlayAboveSubtitle = localTask.overlayAboveSubtitle;
        }
        tpl.bindings = typeof _bcAutoBind === 'function' ? _bcAutoBind(tpl.task, ti) : (tpl.bindings || {});
        _bcScheduleDraftSave();
        draw();
    };

    let suitePanel = null;
    const proxy = {
        overlayMgr: mgr, scopedTask: localTask,
        getOverlayAboveSubtitle: () => localTask.overlayAboveSubtitle !== false,
        setOverlayAboveSubtitle(value) { localTask.overlayAboveSubtitle = value; tpl.task.overlayAboveSubtitle = value; saveChanges(); },
        getCanvasSize: () => ({ w: 1080, h: 1920, cx: 540, cy: 960 }),
        getDuration: () => Number.isFinite(video.duration) ? video.duration : 9999,
        previewEnd(active) { get('[data-time]').value = active ? String(Number.isFinite(video.duration) ? video.duration : 10) : '0'; draw(); },
        addOverlay(overlay) { mgr.addOverlay(overlay); saveChanges(); suitePanel?._refreshList(); },
        removeOverlay(id) { mgr.removeOverlay(id); saveChanges(); suitePanel?._refreshList(); },
        render: saveChanges,
    };
    suitePanel = new ReelsOverlayPanel(get('[data-panel]'), proxy);
    modal.querySelectorAll('#rop-group-preset-update,#rop-group-preset-del,#rop-group-preset-rename,#rop-batch-import').forEach(el => { el.style.display = 'none'; });
    suitePanel._refreshList();
    if (mgr.overlays[0]) suitePanel.selectOverlay(mgr.overlays[0]);
    draw();

    get('[data-time]').oninput = () => { video.currentTime = Math.max(0, Number(get('[data-time]').value) || 0); draw(); };
    get('[data-play]').onclick = () => video.paused ? video.play().catch(() => {}) : video.pause();
    get('[data-tpl-name]').onchange = e => {
        const val = (e.target.value || '').trim();
        if (val) {
            tpl.label = val;
            get('[data-tpl-label]').textContent = val;
            _bcScheduleDraftSave();
        }
    };
    get('[data-save-preset]').onclick = () => {
        const name = prompt('输入预设名称：', tpl.label);
        if (!name || !name.trim()) return;
        let presets = {};
        try { presets = JSON.parse(localStorage.getItem('reels_overlay_group_presets') || '{}'); } catch(e) {}
        presets[name.trim()] = {
            name: name.trim(),
            createdAt: new Date().toISOString(),
            layers: JSON.parse(JSON.stringify(mgr.overlays)),
            overlayAboveSubtitle: localTask.overlayAboveSubtitle !== false,
        };
        localStorage.setItem('reels_overlay_group_presets', JSON.stringify(presets));
        alert(`✅ 已保存到覆层预设「${name.trim()}」`);
    };

    get('[data-close]').onclick = () => {
        const nameInput = get('[data-tpl-name]');
        if (nameInput && nameInput.value.trim()) tpl.label = nameInput.value.trim();
        saveChanges();
        _bcSaveDraftNow();
        if (suitePanel?._renderRaf) cancelAnimationFrame(suitePanel._renderRaf);
        suitePanel = null;
        video.pause(); video.removeAttribute('src'); video.load();
        modal.remove();
        _bcRenderBindings();
    };
}

// Explicit cleanup only: pasted spreadsheet cells keep their original line breaks.
function _bcCleanCopyLineBreaks(value) {
    return String(value ?? '').replace(/[\t \u00a0]*[\r\n\u2028\u2029]+(?:[\t \u00a0]*[\r\n\u2028\u2029]+)*[\t \u00a0]*/g, (breaks, offset, text) => {
        const left = text[offset - 1] || '';
        const right = text[offset + breaks.length] || '';
        if (!left || !right) return '';
        if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(left) && /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(right)) return '';
        if (/[([{“‘]/u.test(left) || /[.,!?;:，。！？；：、)\]}”’]/u.test(right)) return '';
        if (/[-‐‑]/u.test(left) && /[\p{L}]/u.test(right)) return '';
        return ' ';
    });
}

function _bcPreviewGroup(key, initialRow = null, onClose = null) {
    const group = _bcNumberedColumnGroups().find(item => item.key === key);
    const entry = _bulkState.groupAssignments?.find(item => item.key === key);
    if (!group || !entry || entry.templateIndex < 0) { alert('请先为本组分配模板'); return; }
    const assignedTemplate = _bcAssignedTemplate(entry, group);
    if (!_bcGroupHasUsableHeaders(group, assignedTemplate)) {
        alert(`任务组「${key}」缺少可用表头，不能预览。请恢复该组表头后再试。`);
        return;
    }
    if (typeof ReelsOverlay === 'undefined') { alert('预览渲染器尚未加载'); return; }
    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;inset:0;z-index:400000;background:#000d;display:flex;align-items:center;justify-content:center;';
    modal.innerHTML = `<div style="background:#181822;padding:16px;border-radius:10px;display:flex;gap:16px;max-height:94vh;max-width:96vw;overflow:auto;color:#ddd;">
        <div style="position:relative;width:min(40vw,360px);aspect-ratio:9/16;background:#000;align-self:flex-start;flex-shrink:0;">
            <video crossorigin="anonymous" data-bg-video muted loop playsinline style="position:absolute;width:100%;height:100%;object-fit:cover;"></video>
            <img crossorigin="anonymous" data-bg-image style="position:absolute;width:100%;height:100%;object-fit:cover;display:none;">
            <canvas width="1080" height="1920" style="position:absolute;width:100%;height:100%;pointer-events:none;"></canvas>
        </div>
        <div style="width:330px;min-width:300px;display:flex;flex-direction:column;gap:10px;font-size:12.5px;max-height:90vh;overflow-y:auto;padding-right:4px;">
            <strong style="font-size:14px;color:#fff;">${_bcEsc(key)} · 文案与背景预览</strong>
            <div style="display:flex;align-items:center;gap:6px;">
                <label style="font-weight:600;color:#c4b5fd;font-size:11.5px;flex-shrink:0;">数据行</label>
                <select data-row style="flex:1;min-width:0;background:#141525;color:#e2e8f0;border:1px solid #363852;border-radius:4px;height:26px;font-size:11px;padding:0 6px;"></select>
            </div>

            <!-- ✏️ 实时编辑文案区块 -->
            <div data-edit-copy-section style="background:rgba(124,92,255,0.06);border:1px solid rgba(124,92,255,0.22);border-radius:8px;padding:9px;display:flex;flex-direction:column;gap:7px;">
                <div style="display:flex;align-items:center;justify-content:space-between;gap:4px;">
                    <span style="font-weight:700;color:#c4b5fd;font-size:11.5px;display:inline-flex;align-items:center;gap:4px;">✏️ 实时修改文案（同步表格）</span>
                    <span data-copy-sync-tip style="font-size:10px;color:#34d399;font-weight:600;display:none;background:rgba(52,211,153,0.12);padding:1px 5px;border-radius:3px;border:1px solid rgba(52,211,153,0.3);">✓ 已同步</span>
                </div>
                <div data-copy-fields-container style="display:flex;flex-direction:column;gap:7px;"></div>
            </div>

            <label style="display:flex;flex-direction:column;gap:3px;font-size:11px;color:#94a3b8;">模板
                <div style="display:flex;gap:4px;">
                    <select data-template style="flex:1;min-width:0;background:#141525;color:#e2e8f0;border:1px solid #363852;border-radius:4px;height:24px;font-size:11px;padding:0 6px;"></select>
                    <button data-pick-template class="bc-btn bc-btn-purple bc-btn-xs" style="flex-shrink:0;">🖼 看图换模板</button>
                </div>
            </label>
            <label style="display:flex;flex-direction:column;gap:3px;font-size:11px;color:#94a3b8;">背景分类
                <div style="display:flex;gap:4px;">
                    <select data-folder style="flex:1;min-width:0;background:#141525;color:#e2e8f0;border:1px solid #363852;border-radius:4px;height:24px;font-size:11px;padding:0 6px;"></select>
                    <button data-pick-folder class="bc-btn bc-btn-purple bc-btn-xs" style="flex-shrink:0;">🖼 看图换分类</button>
                </div>
            </label>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
                <label style="display:flex;flex-direction:column;gap:3px;font-size:11px;color:#94a3b8;">配乐模式
                    <select data-music-mode style="background:#141525;color:#e2e8f0;border:1px solid #363852;border-radius:4px;height:24px;font-size:11px;padding:0 4px;"><option value="suite">整套共用一首</option><option value="cycle">每条轮流配乐</option></select>
                </label>
                <label style="display:flex;flex-direction:column;gap:3px;font-size:11px;color:#94a3b8;">预览秒数
                    <input data-time type="number" min="0" value="0" step="0.5" style="width:100%;box-sizing:border-box;background:#141525;color:#e2e8f0;border:1px solid #363852;border-radius:4px;height:24px;font-size:11px;padding:0 6px;">
                </label>
            </div>
            <label style="display:flex;flex-direction:column;gap:3px;font-size:11px;color:#94a3b8;">整套配乐
                <div style="display:flex;gap:4px;">
                    <select data-music style="flex:1;min-width:0;background:#141525;color:#e2e8f0;border:1px solid #363852;border-radius:4px;height:24px;font-size:11px;padding:0 6px;"></select>
                    <button data-pick-music class="bc-btn bc-btn-emerald bc-btn-xs" style="flex-shrink:0;">🎵 试听</button>
                </div>
            </label>
            <audio crossorigin="anonymous" data-music-player controls style="width:100%;display:none;margin-top:2px;"></audio>
            <div style="display:flex;gap:6px;margin-top:2px;">
                <button data-play class="bc-btn bc-btn-default bc-btn-sm" style="flex:1;">播放 / 暂停背景</button>
                <button data-edit-overlays class="bc-btn bc-btn-purple bc-btn-sm" style="flex:1;">⚙ 覆层排版参数</button>
            </div>
            <div data-status style="color:#b9aaff;font-size:10.5px;margin-top:2px;"></div>
            <div style="color:#717496;font-size:10px;line-height:1.35;">修改文案会立即同步到外层表格；拼接模式展示首个素材，完整效果生成任务后检查。</div>
            <button data-close class="bc-btn bc-btn-primary" style="margin-top:4px;height:30px;font-size:12px;">完成预览</button>
        </div></div>`;
    document.body.appendChild(modal);
    const get = selector => modal.querySelector(selector);
    const video = get('[data-bg-video]'), img = get('[data-bg-image]'), canvas = get('canvas');
    const rows = _bulkState.rows.map((row, index) => ({ row, index })).filter(({ row }) => row.some(cell => String(cell || '').trim()));
    get('[data-row]').innerHTML = rows.map(({ index }, i) => `<option value="${i}">第 ${index + 1} 行</option>`).join('');
    if (initialRow != null) get('[data-row]').value = String(Math.max(0, rows.findIndex(item => item.index === initialRow)));
    const syncOptions = () => {
        get('[data-template]').innerHTML = _bulkState.templates.map((tpl, i) => `<option value="${i}" ${entry.templateIndex === i ? 'selected' : ''}>${_bcEsc(tpl.label)}</option>`).join('');
        get('[data-folder]').innerHTML = '<option value="">沿用模板背景</option>' + _bulkState.backgroundFolders.map(folder => `<option value="${_bcEsc(folder.path)}" ${entry.backgroundFolder === folder.path ? 'selected' : ''}>${_bcEsc(folder.name)}</option>`).join('');
        get('[data-music]').innerHTML = '<option value="">沿用模板 / 不指定配乐</option>' + _bulkState.musicFiles.map(music => `<option value="${_bcEsc(music.path)}" ${entry.musicPath === music.path ? 'selected' : ''}>${_bcEsc(music.name)}</option>`).join('');
        get('[data-music-mode]').value = entry.musicMode || 'suite';
        get('[data-music]').disabled = entry.musicMode === 'cycle';
        get('[data-pick-music]').disabled = entry.musicMode === 'cycle';
    };
    let task = null, timer = null, suitePanel = null, suiteHost = null;
    const closeSuitePanel = () => {
        if (suitePanel?._renderRaf) cancelAnimationFrame(suitePanel._renderRaf);
        if (suitePanel) suitePanel.videoCanvas = null;
        suitePanel = null; suiteHost?.remove(); suiteHost = null;
    };
    const draw = () => {
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, 1080, 1920);
        if (!task) return;
        const time = Math.max(0, Number(get('[data-time]').value) || 0);
        (task.overlays || []).forEach(overlay => ReelsOverlay.drawOverlay(ctx, { ...overlay, _exporting: true }, time, 1080, 1920));
    };
    const renderBoundTextEditors = () => {
        const container = get('[data-copy-fields-container]');
        if (!container) return;
        const tpl = _bcAssignedTemplate(entry, group);
        const ri = Number(get('[data-row]').value) || 0;
        if (!tpl || !rows[ri]) {
            container.innerHTML = '<div style="color:#717496;font-size:11px;">本组暂无可编辑的文案</div>';
            return;
        }
        const actualRowIndex = rows[ri].index;
        const currentRow = _bulkState.rows[actualRowIndex] || [];
        const fields = _bcFieldsFromTask(tpl.task || {});
        const boundTextFields = fields.filter(f => {
            if (f.type !== 'text') return false;
            const ci = tpl.bindings?.[f.key];
            return ci != null && ci >= 0 && ci < _bulkState.columns.length;
        });

        if (boundTextFields.length === 0) {
            container.innerHTML = '<div style="color:#717496;font-size:10.5px;line-height:1.4;">当前模板暂未绑定文本列<br><span style="color:#94a3b8;font-size:10px;">可在编号组卡片中指定绑定的表格列。</span></div>';
            return;
        }

        container.innerHTML = boundTextFields.map(f => {
            const ci = tpl.bindings[f.key];
            const colName = _bulkState.columns[ci]?.name || `列 ${ci + 1}`;
            const val = currentRow[ci] || '';
            const isMultiline = f.key.includes('body') || f.key.includes('content') || f.key === '__ai__' || f.key === '__txt__' || f.key === '__tts__';
            return `<div style="display:flex;flex-direction:column;gap:3px;" data-field-row="${_bcEsc(f.key)}">
                <div style="display:flex;align-items:center;justify-content:space-between;gap:4px;font-size:10.5px;">
                    <span style="color:#e2e8f0;font-weight:600;">${_bcEsc(f.label)}</span>
                    <button type="button" data-clean-copy-breaks title="清理当前文案的换行和空行，保留必要空格，并同步表格" style="margin-left:auto;background:#29233e;color:#c4b5fd;border:1px solid #59468c;border-radius:4px;padding:3px 7px;cursor:pointer;">清理换行</button>
                    <span style="color:#a78bfa;font-size:10px;background:rgba(124,92,255,0.15);border:1px solid rgba(124,92,255,0.3);padding:1px 5px;border-radius:3px;font-family:monospace;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="已绑定表格列: ${_bcEsc(colName)}">${_bcEsc(colName)}</span>
                </div>
                ${isMultiline ? `
                    <textarea data-bound-input data-ci="${ci}" data-fk="${_bcEsc(f.key)}" rows="3" placeholder="输入${_bcEsc(f.label)}..." style="width:100%;box-sizing:border-box;background:#10111d;border:1px solid #363852;border-radius:4px;color:#f1f5f9;padding:6px 8px;font-size:11.5px;line-height:1.45;resize:vertical;font-family:inherit;outline:none;">${_bcEsc(val)}</textarea>
                ` : `
                    <input data-bound-input data-ci="${ci}" data-fk="${_bcEsc(f.key)}" type="text" value="${_bcEsc(val)}" placeholder="输入${_bcEsc(f.label)}..." style="width:100%;box-sizing:border-box;background:#10111d;border:1px solid #363852;border-radius:4px;color:#f1f5f9;padding:4px 8px;font-size:11.5px;height:26px;outline:none;">
                `}
            </div>`;
        }).join('');
    };
    const copyContainer = get('[data-copy-fields-container]');
    if (copyContainer) {
        copyContainer.addEventListener('click', e => {
            const button = e.target.closest('[data-clean-copy-breaks]');
            if (!button) return;
            const input = button.closest('[data-field-row]')?.querySelector('[data-bound-input]');
            if (!input) return;
            const cleaned = _bcCleanCopyLineBreaks(input.value);
            if (cleaned === input.value) return;
            input.value = cleaned;
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        copyContainer.addEventListener('input', e => {
            const target = e.target;
            if (!target || !target.hasAttribute('data-bound-input')) return;
            const ci = Number(target.dataset.ci);
            const ri = Number(get('[data-row]').value) || 0;
            if (!rows[ri]) return;
            const actualRowIndex = rows[ri].index;
            const newVal = target.value;

            // 1. Synchronize to _bulkState.rows and active row
            if (!_bulkState.rows[actualRowIndex]) _bulkState.rows[actualRowIndex] = [];
            while (_bulkState.rows[actualRowIndex].length <= ci) _bulkState.rows[actualRowIndex].push('');
            _bulkState.rows[actualRowIndex][ci] = newVal;
            rows[ri].row[ci] = newVal;

            // 2. Synchronize any other inputs bound to the same column
            copyContainer.querySelectorAll(`[data-bound-input][data-ci="${ci}"]`).forEach(inp => {
                if (inp !== target && inp.value !== newVal) inp.value = newVal;
            });

            // 3. Immediately re-render canvas
            const tpl = _bcAssignedTemplate(entry, group);
            const localIndex = rows.slice(0, ri).filter(({row}) => _bcRowHasBoundData(tpl, row)).length;
            task = _bcBuildTask(tpl, rows[ri].row, localIndex, ri + 1, _bulkState.columns, group?.key || '');
            _bcApplyAssignedBackground(task, tpl, localIndex);
            _bcApplyAssignedMusic(task, tpl, localIndex);
            draw();

            // 4. 只回写当前单元格；不要因改一个字就重建整个大表及所有任务组。
            _bcPatchTableCell(actualRowIndex, ci);
            _bcScheduleDraftSave();

            // 5. Visual sync tip
            const tip = get('[data-copy-sync-tip]');
            if (tip) {
                tip.textContent = `✓ 第 ${actualRowIndex + 1} 行已同步`;
                tip.style.display = 'inline-block';
                clearTimeout(tip._timer);
                tip._timer = setTimeout(() => { tip.style.display = 'none'; }, 2200);
            }
        });
    }
    const refresh = (skipEditorRebuild = false) => {
        try {
            video.pause(); video.removeAttribute('src'); img.removeAttribute('src');
            const tpl = _bcAssignedTemplate(entry, group);
            const ri = Number(get('[data-row]').value) || 0;
            if (!tpl || !rows[ri]) throw new Error('本组暂无可预览文案');
            const localIndex = rows.slice(0, ri).filter(({row}) => _bcRowHasBoundData(tpl, row)).length;
            task = _bcBuildTask(tpl, rows[ri].row, localIndex, ri + 1, _bulkState.columns, group?.key || '');
            _bcApplyAssignedBackground(task, tpl, localIndex);
            _bcApplyAssignedMusic(task, tpl, localIndex);
            const path = task.bgPath || task.videoPath || '';
            const isImage = _bcMediaKind(path) === 'image';
            img.style.display = isImage ? 'block' : 'none'; video.style.display = isImage ? 'none' : 'block';
            if (path) (isImage ? img : video).src = _bcFileUrl(path);
            get('[data-status]').textContent = path ? `背景：${_bcFileName(path)}` : '当前无背景素材';
            const music = get('[data-music-player]');
            music.pause(); music.removeAttribute('src');
            if (task.bgmPath) { music.src = _bcFileUrl(task.bgmPath); music.style.display = 'block'; }
            else music.style.display = 'none';
            draw(); clearTimeout(timer); timer = setTimeout(draw, 600);
            if (!skipEditorRebuild) renderBoundTextEditors();
            _bcScheduleDraftSave();
        } catch (error) { task = null; draw(); get('[data-status]').textContent = error.message; }
    };
    ['click', 'mousedown', 'keydown'].forEach(type => modal.addEventListener(type, event => event.stopPropagation()));
    syncOptions(); refresh();
    get('[data-edit-overlays]').onclick = () => {
        if (suiteHost) { closeSuitePanel(); return; }
        if (typeof ReelsOverlayPanel === 'undefined' || !window.ReelsOverlay?.OverlayManager) { alert('覆层编辑器尚未加载'); return; }
        const tpl = _bcAssignedTemplate(entry, group);
        const localTask = { ...tpl.task, overlays: JSON.parse(JSON.stringify(tpl.task.overlays || [])) };
        const mgr = new window.ReelsOverlay.OverlayManager();
        mgr.overlays = localTask.overlays;
        suiteHost = document.createElement('div');
        suiteHost.style.cssText = 'width:460px;min-width:380px;max-height:85vh;overflow:auto;border-left:1px solid #444;padding-left:12px;';
        suiteHost.innerHTML = `<div style="display:flex;flex-direction:column;gap:6px;padding:8px;background:rgba(255,255,255,0.03);border-radius:6px;margin-bottom:8px;font-size:11px;">
            <div style="color:#b9aaff;line-height:1.4;">
                💡 正在编辑本组覆层。已绑定文案仍从表格实时读取。
            </div>
            <div style="display:flex;gap:5px;flex-wrap:wrap;">
                <button id="bc-suite-sync-source" style="padding:3px 8px;background:rgba(124,92,255,0.25);border:1px solid #7c5cff;border-radius:4px;color:#c4b5fd;cursor:pointer;font-size:10px;" title="把当前修改后的覆层样式直接保存回该模板本身，后续使用该模板的组也会继承">💾 同步保存到源模板</button>
                <button id="bc-suite-save-as-new" style="padding:3px 8px;background:rgba(16,185,129,0.2);border:1px solid #10b981;border-radius:4px;color:#6ee7b7;cursor:pointer;font-size:10px;" title="将当前修改另存为一个全新的独立模板，并自动分配给当前组">✨ 另存为新模板</button>
                <button id="bc-suite-save-as-preset" style="padding:3px 8px;background:rgba(245,158,11,0.2);border:1px solid #f59e0b;border-radius:4px;color:#fcd34d;cursor:pointer;font-size:10px;" title="存入全局覆层预设库，可在任意工程直接选用">🎨 存为覆层预设</button>
            </div>
        </div>
        <div data-panel></div>`;
        modal.firstElementChild.appendChild(suiteHost);
        const save = () => {
            if (!suiteHost) return;
            localTask.overlays = mgr.overlays;
            _bcSaveSuiteOverlays(entry, mgr.overlays);
            _bcScheduleDraftSave(); refresh();
        };
        const proxy = {
            overlayMgr: mgr, scopedTask: localTask,
            getOverlayAboveSubtitle: () => localTask.overlayAboveSubtitle !== false,
            setOverlayAboveSubtitle(value) { localTask.overlayAboveSubtitle = value; entry.overlayAboveSubtitle = value; save(); },
            getCanvasSize: () => ({ w: 1080, h: 1920, cx: 540, cy: 960 }),
            getDuration: () => Number.isFinite(video.duration) ? video.duration : 9999,
            previewEnd(active) { get('[data-time]').value = active ? String(Number.isFinite(video.duration) ? video.duration : 10) : '0'; draw(); },
            addOverlay(overlay) { mgr.addOverlay(overlay); save(); suitePanel?._refreshList(); },
            removeOverlay(id) { mgr.removeOverlay(id); save(); suitePanel?._refreshList(); },
            render: save,
        };
        suitePanel = new ReelsOverlayPanel(suiteHost.querySelector('[data-panel]'), proxy);
        // Library management and batch task import are separate from editing this suite's parameters.
        suiteHost.querySelectorAll('#rop-group-preset-update,#rop-group-preset-del,#rop-group-preset-rename,#rop-batch-import').forEach(el => { el.style.display = 'none'; });
        suitePanel._refreshList();
        if (mgr.overlays[0]) suitePanel.selectOverlay(mgr.overlays[0]);

        suiteHost.querySelector('#bc-suite-sync-source').onclick = () => {
            const sourceTpl = _bulkState.templates[entry.templateIndex];
            if (sourceTpl) {
                sourceTpl.task.overlays = JSON.parse(JSON.stringify(mgr.overlays));
                if (localTask.overlayAboveSubtitle != null) {
                    sourceTpl.task.overlayAboveSubtitle = localTask.overlayAboveSubtitle;
                }
                delete entry.overlayOverrides;
                delete entry.overlayAboveSubtitle;
                _bcScheduleDraftSave();
                _bcPatchGroupCard(key);
                refresh();
                alert(`✅ 已同步更新到源模板「${sourceTpl.label}」`);
            }
        };
        suiteHost.querySelector('#bc-suite-save-as-new').onclick = () => {
            const sourceTpl = _bulkState.templates[entry.templateIndex];
            const defaultName = (sourceTpl?.label || '新模板') + '_已修改';
            const newName = prompt('输入新模板名称：', defaultName);
            if (newName && newName.trim()) {
                const newTplTask = JSON.parse(JSON.stringify(sourceTpl ? sourceTpl.task : localTask));
                newTplTask.overlays = JSON.parse(JSON.stringify(mgr.overlays));
                if (localTask.overlayAboveSubtitle != null) {
                    newTplTask.overlayAboveSubtitle = localTask.overlayAboveSubtitle;
                }
                const newIndex = _bulkState.templates.length;
                const newTpl = {
                    task: newTplTask,
                    label: newName.trim(),
                    bindings: typeof _bcAutoBind === 'function' ? _bcAutoBind(newTplTask, newIndex) : {},
                    bgCycle: sourceTpl?.bgCycle ? [...sourceTpl.bgCycle] : null,
                    source: null,
                };
                _bulkState.templates.push(newTpl);
                entry.templateIndex = newIndex;
                delete entry.overlayOverrides;
                delete entry.overlayAboveSubtitle;
                _bcScheduleDraftSave();
                // 新模板需要出现在模板库中，只有这类“新增结构”才完整刷新。
                _bcRenderBindings();
                syncOptions();
                refresh();
                alert(`✅ 已另存为新模板「${newName.trim()}」并分配给本组`);
            }
        };
        suiteHost.querySelector('#bc-suite-save-as-preset').onclick = () => {
            const sourceTpl = _bulkState.templates[entry.templateIndex];
            const defaultName = (sourceTpl?.label || '自定义覆层') + '_预设';
            const presetName = prompt('输入要保存的覆层预设名称：', defaultName);
            if (presetName && presetName.trim()) {
                let presets = {};
                try { presets = JSON.parse(localStorage.getItem('reels_overlay_group_presets') || '{}'); } catch(e) {}
                presets[presetName.trim()] = {
                    name: presetName.trim(),
                    createdAt: new Date().toISOString(),
                    layers: JSON.parse(JSON.stringify(mgr.overlays)),
                    overlayAboveSubtitle: localTask.overlayAboveSubtitle !== false,
                };
                localStorage.setItem('reels_overlay_group_presets', JSON.stringify(presets));
                alert(`✅ 已成功保存到全局覆层预设「${presetName.trim()}」`);
            }
        };
    };
    get('[data-pick-template]').onclick = () => {
        const curPath = task?.bgPath || task?.videoPath || '';
        const isImg = _bcMediaKind(curPath) === 'image';
        const curMedia = isImg ? img : video;
        let previewTitle = '', previewBody = '';
        if (task?.overlays) {
            for (const ov of task.overlays) {
                if (!previewTitle && (ov.title_text || ov.scroll_title)) previewTitle = ov.title_text || ov.scroll_title;
                if (!previewBody && (ov.body_text || ov.content)) previewBody = ov.body_text || ov.content;
            }
        }
        _bcVisualPicker('template', entry.templateIndex, value => {
            closeSuitePanel();
            _bcSetGroupTemplate(key, value, { refresh: false });
            syncOptions();
            refresh();
        }, {
            bgPath: curPath,
            bgMedia: (curMedia && ((isImg && curMedia.naturalWidth) || (!isImg && curMedia.videoWidth))) ? curMedia : null,
            previewText: (previewTitle || previewBody) ? { title: previewTitle, body: previewBody } : null
        });
    };
    get('[data-pick-folder]').onclick = () => _bcVisualPicker('folder', entry.backgroundFolder || '', value => { entry.backgroundFolder = value; _bcPatchGroupCard(key); _bcScheduleDraftSave(); syncOptions(); refresh(); });
    get('[data-pick-music]').onclick = () => _bcVisualPicker('music', entry.musicPath || '', value => { entry.musicPath = value; _bcPatchGroupCard(key); _bcScheduleDraftSave(); syncOptions(); refresh(); });
    get('[data-template]').onchange = event => { closeSuitePanel(); _bcSetGroupTemplate(key, Number(event.target.value), { refresh: false }); syncOptions(); refresh(); };
    get('[data-folder]').onchange = event => { entry.backgroundFolder = event.target.value; _bcPatchGroupCard(key); _bcScheduleDraftSave(); refresh(); };
    get('[data-music]').onchange = event => { entry.musicPath = event.target.value; _bcPatchGroupCard(key); _bcScheduleDraftSave(); refresh(); };
    get('[data-music-mode]').onchange = event => { entry.musicMode = event.target.value; if (entry.musicMode !== 'random') delete entry.musicTaskAssignments; _bcPatchGroupCard(key); _bcScheduleDraftSave(); syncOptions(); refresh(); };
    get('[data-row]').onchange = refresh;
    get('[data-time]').oninput = () => { video.currentTime = Math.max(0, Number(get('[data-time]').value) || 0); draw(); };
    get('[data-play]').onclick = () => video.paused ? video.play().catch(() => {}) : video.pause();
    video.onerror = img.onerror = () => { get('[data-status]').textContent = '背景加载失败，请检查文件路径或刷新素材分类。'; };
    get('[data-close]').onclick = () => {
        closeSuitePanel();
        clearTimeout(timer);
        video.pause(); video.removeAttribute('src'); video.load();
        get('[data-music-player]').pause(); get('[data-music-player]').removeAttribute('src');
        _bcSaveDraftNow();
        modal.remove();
        // 文案字段已在输入时精准更新表格；关闭预览不再整体重绘模板库、
        // 背景库、配乐库和所有任务组。涉及模板/背景的操作会在其变化时
        // 自己触发一次必要的刷新。
        if (onClose) onClose();
    };
}

function _bcAllPreviewItems() {
    const groups = _bcNumberedColumnGroups();
    const items = [];
    (_bulkState.groupAssignments || []).forEach(entry => {
        const group = groups.find(group => group.key === entry.key);
        const tpl = _bcAssignedTemplate(entry, group);
        if (!tpl || !_bcGroupHasUsableHeaders(group, tpl)) return;
        let localIndex = 0;
        _bulkState.rows.forEach((row, rowIndex) => {
            if (!row.some(cell => String(cell || '').trim()) || !_bcRowHasBoundData(tpl, row)) return;
            items.push({ key: entry.key, tpl, row, rowIndex, localIndex: localIndex++ });
        });
    });
    return items;
}

function _bcPreviewAll() {
    if (typeof ReelsOverlay === 'undefined') { alert('预览渲染器尚未加载'); return; }
    if (!_bcAllPreviewItems().length) { alert('请先分配模板并填入文案，再批量预览'); return; }
    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;inset:0;z-index:400000;background:#101018;color:#ddd;padding:18px;display:flex;flex-direction:column;gap:12px;';
    modal.innerHTML = `<div style="display:flex;align-items:center;gap:12px;min-height:44px;flex-shrink:0;">
        <div style="display:flex;align-items:center;gap:10px;min-width:0;"><strong style="font-size:17px;white-space:nowrap;">全部文案 · 批量预览</strong><span data-count style="font-size:14px;white-space:nowrap;"></span></div>
        <div style="margin-left:auto;display:flex;align-items:center;gap:10px;flex-shrink:0;">
            <button type="button" data-refresh style="height:38px;padding:0 14px;border-radius:7px;border:1px solid #596176;background:#252b3a;color:#eef2ff;font-size:14px;font-weight:600;cursor:pointer;">刷新预览</button>
            <button type="button" data-close aria-label="关闭批量预览" title="关闭批量预览（Esc）" style="min-width:82px;height:38px;padding:0 16px;border-radius:7px;border:1px solid #f87171;background:#7f1d1d;color:#fff;font-size:14px;font-weight:700;cursor:pointer;box-shadow:0 0 0 2px rgba(248,113,113,.16);">✕ 关闭</button>
        </div>
        </div><div style="font-size:12px;color:#999;line-height:1.45;flex-shrink:0;">每套一行，左右滚动对比；上下滚动切换套组。点击卡片放大、换模板或背景。更换模板会应用到该编号组的所有文案。此处检查排版与背景组合。</div><div data-grid style="overflow:auto;flex:1;min-height:0;display:flex;flex-direction:column;gap:20px;"></div>`;
    document.body.appendChild(modal);
    ['click', 'mousedown', 'keydown'].forEach(type => modal.addEventListener(type, event => event.stopPropagation()));
    const get = selector => modal.querySelector(selector);
    let timers = [], observer = null;
    const cleanup = () => {
        observer?.disconnect();
        timers.forEach(clearTimeout); timers = [];
        modal.querySelectorAll('video').forEach(video => { video.pause(); video.removeAttribute('src'); video.load(); });
    };
    const render = () => {
        cleanup();
        const items = _bcAllPreviewItems();
        const grid = get('[data-grid]');
        const scrollTop = grid.scrollTop;
        const positions = new Map(Array.from(grid.querySelectorAll('[data-suite]')).map(row => [row.dataset.suite, row.scrollLeft]));
        const suites = new Map();
        items.forEach(item => { if (!suites.has(item.key)) suites.set(item.key, []); suites.get(item.key).push(item); });
        get('[data-count]').textContent = `共 ${suites.size} 套 · ${items.length} 项`;
        grid.innerHTML = '';
        observer = new IntersectionObserver(entries => entries.forEach(entry => {
            if (entry.isIntersecting) entry.target._loadPreview?.();
            else entry.target._unloadPreview?.();
        }), { root: grid, rootMargin: '100px' });
        suites.forEach((suiteItems, key) => {
            const section = document.createElement('section');
            section.style.cssText = 'flex:none;min-width:0;border-bottom:1px solid #444;padding-bottom:16px;';
            section.innerHTML = `<div style="margin-bottom:8px;color:#b9aaff;font-weight:600;">${_bcEsc(key)} · ${_bcEsc(suiteItems[0].tpl.label)} · ${suiteItems.length} 条</div>`;
            const row = document.createElement('div');
            row.dataset.suite = key;
            row.style.cssText = 'display:flex;gap:12px;overflow-x:auto;padding-bottom:10px;scrollbar-width:auto;';
            section.appendChild(row); grid.appendChild(section);
            suiteItems.forEach(item => {
            const card = document.createElement('button');
            card.style.cssText = 'flex:0 0 220px;width:220px;padding:8px;background:#20202c;color:#ddd;border:1px solid #444;border-radius:8px;text-align:left;cursor:pointer;';
            card.innerHTML = `<div style="position:relative;aspect-ratio:9/16;background:#000;">
                <video crossorigin="anonymous" muted playsinline preload="auto" style="position:absolute;width:100%;height:100%;object-fit:cover;"></video>
                <img crossorigin="anonymous" style="position:absolute;width:100%;height:100%;object-fit:cover;display:none;">
                <canvas width="270" height="480" style="position:absolute;width:100%;height:100%;"></canvas>
                </div><div style="margin-top:6px;">${_bcEsc(item.key)} · 第 ${item.rowIndex + 1} 行</div>
                <div style="font-size:11px;color:#b9aaff;">${_bcEsc(item.tpl.label)}</div><div data-status style="font-size:11px;"></div>`;
            row.appendChild(card);
            card.onclick = () => _bcPreviewGroup(item.key, item.rowIndex, render);
            let loaded = false;
            card._unloadPreview = () => {
                loaded = false;
                const video = card.querySelector('video');
                video.pause(); video.removeAttribute('src'); video.load();
                card.querySelector('img').removeAttribute('src');
                card.querySelector('canvas').width = 270;
            };
            card._loadPreview = () => {
            if (loaded) return;
            loaded = true;
            try {
                const task = _bcBuildTask(item.tpl, item.row, item.localIndex, item.rowIndex + 1, _bulkState.columns, item.key || '');
                _bcApplyAssignedBackground(task, item.tpl, item.localIndex);
                _bcApplyAssignedMusic(task, item.tpl, item.localIndex);
                const path = task.bgPath || task.videoPath || '';
                const video = card.querySelector('video'), img = card.querySelector('img');
                const isImage = _bcMediaKind(path) === 'image';
                video.style.display = isImage ? 'none' : 'block'; img.style.display = isImage ? 'block' : 'none';
                const status = card.querySelector('[data-status]');
                status.textContent = path ? _bcFileName(path) : '无背景素材';
                video.onerror = img.onerror = () => { status.textContent = '背景加载失败，请检查素材路径'; };
                if (path) (isImage ? img : video).src = _bcFileUrl(path);
                const draw = () => {
                    if (!card.isConnected || !loaded) return;
                    const ctx = card.querySelector('canvas').getContext('2d');
                    ctx.clearRect(0, 0, 270, 480); ctx.save(); ctx.scale(0.25, 0.25);
                    try {
                        (task.overlays || []).forEach(overlay => ReelsOverlay.drawOverlay(ctx, { ...overlay, _exporting: true }, Math.max(0, Number(overlay.start) || 0), 1080, 1920));
                    } finally { ctx.restore(); }
                };
                draw(); timers.push(setTimeout(() => { try { draw(); } catch (error) { status.textContent = error.message; } }, 600));
            } catch (error) { card.querySelector('[data-status]').textContent = error.message; }
            };
            observer.observe(card);
            });
            row.scrollLeft = positions.get(key) || 0;
        });
        grid.scrollTop = scrollTop;
        _bcScheduleDraftSave();
    };
    const close = () => { cleanup(); modal.remove(); };
    get('[data-refresh]').onclick = render;
    get('[data-close]').onclick = close;
    modal.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.preventDefault(); close(); }
    });
    modal.tabIndex = -1;
    modal.focus();
    render();
}

function _bcTemplateProjectIdsInUse() {
    return new Set(_bulkState.templates
        .map(tpl => tpl?.source?.templateId)
        .filter(Boolean));
}

function _bcIsTemplateProjectInUse(templateId) {
    return !!templateId && _bcTemplateProjectIdsInUse().has(templateId);
}

async function _bcFetchTemplateProject(templateId) {
    if (!templateId) throw new Error('缺少模板来源 ID');
    const resp = await apiFetch(`${API_BASE}/templates/get`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: templateId }),
    });
    const result = await resp.json();
    const tplData = result.data || result;
    if (!tplData?.projectData?.tasks?.length) throw new Error('最新模板工程没有任务');
    return tplData;
}

function _bcRefreshTemplateFromProject(tpl, tplData) {
    const source = tpl.source || {};
    const projectData = tplData.projectData || {};
    const safeTasks = _bcDeserializeProjectTasks(projectData);
    if (!safeTasks.length) throw new Error('最新模板工程没有可用任务');

    const projectCycle = _bcCollectProjectBackgroundCycle(projectData);
    let nextTask = null;
    let nextCycle = null;
    if (source.mode === 'unified') {
        nextTask = safeTasks[0];
        const cycle = [];
        (projectCycle || []).forEach(p => _bcAddUniqueCyclePath(cycle, p));
        if (cycle.length === 0) {
            safeTasks.forEach(t => _bcCollectTaskBackgroundCycle(t).forEach(p => _bcAddUniqueCyclePath(cycle, p)));
        }
        nextCycle = cycle.length > 1 ? cycle : null;
    } else {
        const idx = Number.isInteger(source.taskIndex) ? source.taskIndex : 0;
        nextTask = safeTasks[idx];
        if (!nextTask) throw new Error(`最新模板工程没有第 ${idx + 1} 个任务`);
        nextCycle = _bcResolveTemplateBgCycle(nextTask, projectCycle);
    }

    tpl.task = _bcCloneTemplateTask(nextTask);
    tpl.bgCycle = nextCycle;
    tpl.label = source.mode === 'unified'
        ? `${tplData.name || source.templateName || tpl.label}_统一模式`
        : (tpl.task.baseName || tpl.task.fileName || tpl.label);
    tpl.source = {
        ...source,
        templateName: tplData.name || source.templateName || '',
        refreshedAt: new Date().toISOString(),
    };
}

async function _bcReloadLoadedTemplates() {
    const sourced = _bulkState.templates
        .map((tpl, index) => ({ tpl, index }))
        .filter(x => x.tpl?.source?.type === 'template_project' && x.tpl.source.templateId);
    if (sourced.length === 0) {
        alert('当前没有可刷新的模板工程来源。请从「模版工程库」添加模板后再刷新。');
        return;
    }
    if (!confirm(`从模板库重新加载 ${sourced.length} 个已添加模板？\n\n会更新模板工程内容和自动循环素材，保留当前列绑定。`)) return;

    const cache = new Map();
    let ok = 0;
    const errors = [];
    for (const { tpl, index } of sourced) {
        const id = tpl.source.templateId;
        try {
            if (!cache.has(id)) cache.set(id, await _bcFetchTemplateProject(id));
            _bcRefreshTemplateFromProject(tpl, cache.get(id));
            ok++;
        } catch (e) {
            errors.push(`模板${index + 1}「${tpl.label || id}」: ${e.message}`);
        }
    }
    _bcRenderBindings();
    _bcScheduleDraftSave();
    const msg = `已刷新 ${ok} 个模板${errors.length ? `\n\n失败：\n${errors.join('\n')}` : ''}`;
    alert(msg);
}

function _bcBindingDebugLabel(tpl, field) {
    const ci = tpl?.bindings?.[field.key];
    if (ci == null || ci < 0) return '未绑定';
    const col = _bulkState.columns[ci];
    const sampleRow = _bulkState.rows.find(r => r && String(r[ci] || '').trim());
    const sample = sampleRow ? String(sampleRow[ci] || '').trim().slice(0, 24) : '';
    return `列${ci + 1}: ${col?.name || ''}${sample ? ` | ${sample}` : ''}`;
}

function _bcWarnDuplicateTextBindings(tpl) {
    const fields = _bcFieldsFromTask(tpl.task || {}).filter(f => f.type === 'text');
    const seen = new Map();
    const duplicates = [];
    fields.forEach(f => {
        const ci = tpl.bindings?.[f.key];
        if (ci == null || ci < 0) return;
        if (seen.has(ci)) duplicates.push([seen.get(ci), f, ci]);
        else seen.set(ci, f);
    });
    if (duplicates.length > 0) {
        console.warn('[BulkCreate] 文本字段绑定到同一列，请确认是否有意:', tpl.label, duplicates.map(([a, b, ci]) => ({
            column: `${ci + 1}:${_bulkState.columns[ci]?.name || ''}`,
            fields: [a.label, b.label],
        })));
    }
}

function _bcEnsureAllTemplateBindings() {
    _bulkState.templates.forEach(tpl => {
        _bcEnsureTemplateBindings(tpl);
        _bcWarnDuplicateTextBindings(tpl);
    });
}

function _bcWarnAllDuplicateTextBindings() {
    _bulkState.templates.forEach(_bcWarnDuplicateTextBindings);
}

function _bcRowUsesTemplate(rowIndex, tpl) {
    return !_bulkState.rowPresetMode || (_bulkState.rowTemplateIds[rowIndex] || []).includes(tpl.bulkTemplateId);
}

function _bcCellUsesTemplate(rowIndex, columnIndex, tpl) {
    const id = _bulkState.columns[columnIndex]?.bulkCopyColumnId;
    return !!id && (_bulkState.cellTemplateIds[rowIndex]?.[id] || []).includes(tpl.bulkTemplateId);
}

function _bcShowTemplateAssignments(){try{return localStorage.getItem('reels_bulk_show_template_assignments')==='true';}catch(_){return false;}}
function _bcCellPresetButton(rowIndex, columnIndex) {
    if(!_bcShowTemplateAssignments())return '';
    const column = _bulkState.columns[columnIndex];
    if (column?.type !== 'text') return '';
    const count = (_bulkState.cellTemplateIds[rowIndex]?.[column.bulkCopyColumnId] || []).length;
    return `<button class="bc-cell-presets bc-btn bc-btn-default bc-btn-xs" data-ri="${rowIndex}" data-ci="${columnIndex}" title="只为此单元格的文案选择覆层预设">🎨 ${count ? '已选 ' + count + ' 个预设' : '绑定此文案预设'}</button>`;
}

function _bcRenderRowPresetCount() {
    const el = document.getElementById('bc-row-preset-count');
    if (!el) return;
    el.style.display = _bulkState.rowPresetMode || _bulkState.cellPresetMode ? '' : 'none';
    let copies = 0, tasks = 0;
    _bulkState.rows.forEach((row, index) => {
        if (_bulkState.cellPresetMode) {
            _bulkState.columns.forEach((column, ci) => {
                if (column.type !== 'text' || !String(row[ci] || '').trim()) return;
                const count = _bulkState.templates.filter(tpl => _bcCellUsesTemplate(index, ci, tpl)).length;
                if (count) copies++;
                tasks += count;
            });
            return;
        }
        if (!row.some(cell => String(cell || '').trim())) return;
        const count = _bulkState.templates.filter(tpl => _bcRowUsesTemplate(index, tpl)).length;
        if (count) copies++;
        tasks += count;
    });
    el.textContent = `已绑定 ${copies} ${_bulkState.cellPresetMode ? '个文案单元格' : '条文案'}，将生成 ${tasks} 条任务；未选择预设的文案跳过。`;
}

function _bcRowPresetPreviewTask(item, rowIndex, copyColumn = null) {
    const layers = Array.isArray(item.data) ? item.data : item.data?.layers || [];
    const task = item.tpl?.task || { overlays: layers, baseName: item.label, segments: [] };
    const tpl = item.tpl || {
        task,
        label: item.label,
        bindings: _bcAutoBind(task, _bulkState.templates.length),
    };
    return _bcBuildTask(tpl, _bulkState.rows[rowIndex] || [], rowIndex, rowIndex + 1,
        _bulkState.columns, '', { rowPresetMode: true, copyColumn });
}

function _bcGroupPresetPreviewTemplate(item, entry, group) {
    if (item.tpl) return _bcAssignedPresetTemplate(entry, group, item.tpl.bulkTemplateId);
    const layers = Array.isArray(item.data) ? item.data : item.data?.layers || [];
    const tpl = { label: item.label, task: { overlays: layers, segments: [] }, bindings: {} };
    _bcBindNumberedGroup(tpl, group);
    return tpl;
}

function _bcChooseGroupPresets(key) {
    _bcNormalizeStateShape();
    const group = _bcNumberedColumnGroups().find(item => item.key === key);
    if (!group) return;
    if (!Array.isArray(_bulkState.groupAssignments)) _bulkState.groupAssignments = [];
    if (!_bulkState.groupAssignments.some(entry => entry.key === key)) _bulkState.groupAssignments.push({ key, templateIndex: -1, bindings: {} });
    const rowIndex = _bulkState.rows.findIndex(row => group.columns.some(c => String(row[c.ci] || '').trim()));
    if (rowIndex < 0) { alert('请先填入本任务组的文案，再选择覆层预设。'); return; }
    _bcChooseRowPresets(rowIndex, null, key);
}

function _bcChooseRowPresets(rowIndex, copyColumn = null, groupKey = '') {
    _bcNormalizeStateShape();
    if (!_bulkState.rows[rowIndex]) return;
    const group = groupKey ? _bcNumberedColumnGroups().find(item => item.key === groupKey) : null;
    const entry = group ? (_bulkState.groupAssignments || []).find(item => item.key === groupKey) : null;
    if (groupKey && !entry) return;
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('reels_overlay_group_presets') || '{}'); } catch (_) {}
    saved = { ...(window.REELS_BUILTIN_OVERLAY_GROUP_PRESETS || {}), ...saved };
    const candidates = _bulkState.templates.map(tpl => ({ id: tpl.bulkTemplateId, label: tpl.label, tpl }));
    Object.entries(saved).forEach(([name, data]) => {
        if (!candidates.some(item => item.label === name)) candidates.push({ id: 'preset:' + name, label: name, data });
    });
    const column = copyColumn != null ? _bulkState.columns[copyColumn] : null;
    if (column && !column.bulkCopyColumnId) column.bulkCopyColumnId = 'copy_' + (globalThis.crypto?.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2));
    const selected = new Set(entry ? entry.presetTemplateIds || [] : column ? _bulkState.cellTemplateIds[rowIndex]?.[column.bulkCopyColumnId] || [] : _bulkState.rowTemplateIds[rowIndex] || []);
    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;inset:0;z-index:300001;background:rgba(0,0,0,.8);display:flex;align-items:center;justify-content:center;';
    modal.innerHTML = `<div style="background:#171727;color:#eee;padding:18px;border:1px solid #555;border-radius:10px;width:min(1100px,94vw);height:85vh;display:flex;flex-direction:column;gap:12px;">
        <b>${group ? _bcEsc(group.key) + ' · 整组' : '第 ' + (rowIndex + 1) + ' 行' + (column ? ' · ' + _bcEsc(column.name) : '文案')} · 绑定覆层预设</b>
        <div style="font-size:12px;color:#aaa;">画面已套入当前这条文案。勾选几个预设，就生成几条任务；固定文字保留。未选择的文案跳过。</div>
        <div style="font-size:12px;white-space:pre-wrap;max-height:80px;overflow:auto;">${_bcEsc(group ? group.columns.map(c => _bulkState.rows[rowIndex][c.ci]).filter(Boolean).join(' · ') : column ? _bulkState.rows[rowIndex][copyColumn] || '' : _bulkState.rows[rowIndex].filter(Boolean).join(' · '))}</div>
        <input data-search placeholder="搜索预设名称" class="bc-select" style="padding:6px;">
        <div data-options style="overflow:auto;min-height:80px;flex:1;display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;align-content:start;">${candidates.map((item, index) => `<label data-option data-index="${index}" style="display:block;padding:8px;background:#202034;border:2px solid ${selected.has(item.id) ? '#9b7bff' : '#36364d'};border-radius:8px;cursor:pointer;">
            <div style="height:210px;background:#101019;border-radius:5px;overflow:hidden;display:flex;align-items:center;justify-content:center;position:relative;"><img crossorigin="anonymous" data-thumb alt="${_bcEsc(item.label)}" style="display:none;width:100%;height:100%;object-fit:contain;"><span data-thumb-status style="font-size:11px;color:#999;">加载画面…</span></div>
            <div style="display:flex;gap:6px;align-items:flex-start;margin-top:8px;font-size:12px;line-height:1.4;"><input type="checkbox" style="flex-shrink:0;" ${selected.has(item.id) ? 'checked' : ''}><span>${_bcEsc(item.label)}</span></div>
        </label>`).join('') || '<span>暂无预设，请先保存覆层预设。</span>'}</div>
        <div style="display:flex;gap:8px;align-items:center;"><button data-all class="bc-btn bc-btn-default">全选</button><button data-clear class="bc-btn bc-btn-default">清空</button><span data-count style="flex:1;font-size:12px;"></span><button data-cancel class="bc-btn bc-btn-default">取消</button><button data-apply class="bc-btn bc-btn-primary">保存绑定</button></div>
    </div>`;
    document.body.appendChild(modal);
    const inputs = [...modal.querySelectorAll('[data-option] input')];
    const updateCount = () => {
        const count = inputs.filter(input => input.checked).length;
        const copies = group ? _bulkState.rows.filter(row => group.columns.some(c => String(row[c.ci] || '').trim())).length : 1;
        modal.querySelector('[data-count]').textContent = group ? `${copies} 条文案 × ${count} 个预设 = ${copies * count} 条任务` : `将生成 ${count} 条任务`;
        inputs.forEach(input => { input.closest('[data-option]').style.borderColor = input.checked ? '#9b7bff' : '#36364d'; });
    };
    const cards = [...modal.querySelectorAll('[data-option]')];
    const queue = [];
    let rendering = false;
    let observer = null;
    const renderQueued = async () => {
        if (rendering) return;
        rendering = true;
        while (queue.length && modal.isConnected) {
            const card = queue.shift();
            const item = candidates[Number(card.dataset.index)];
            try {
                const previewTpl = group ? _bcGroupPresetPreviewTemplate(item, entry, group) : null;
                const previewTask = group ? _bcBuildTask(previewTpl, _bulkState.rows[rowIndex], 0, 1, _bulkState.columns, group.key)
                    : _bcRowPresetPreviewTask(item, rowIndex, copyColumn);
                const url = await _bcRenderTemplateThumb(previewTask.overlays, 5000, previewTask.bgPath || previewTask.videoPath || '');
                if (!modal.isConnected) break;
                if (!url) throw new Error('no thumbnail');
                const img = card.querySelector('[data-thumb]');
                img.src = url;
                img.style.display = 'block';
                card.querySelector('[data-thumb-status]').style.display = 'none';
            } catch (_) {
                card.querySelector('[data-thumb-status]').textContent = '暂无可用画面';
            }
        }
        rendering = false;
    };
    if (typeof IntersectionObserver !== 'undefined') {
        observer = new IntersectionObserver(entries => {
            entries.forEach(entry => {
                if (!entry.isIntersecting) return;
                observer.unobserve(entry.target);
                queue.push(entry.target);
            });
            renderQueued();
        }, { root: modal.querySelector('[data-options]'), rootMargin: '200px' });
        cards.forEach(card => observer.observe(card));
    } else {
        queue.push(...cards);
        renderQueued();
    }
    const close = () => { observer?.disconnect(); queue.length = 0; modal.remove(); };
    modal.querySelector('[data-options]').onchange = updateCount;
    modal.querySelector('[data-search]').oninput = event => {
        modal.querySelectorAll('[data-option]').forEach(label => {
            label.style.display = candidates[Number(label.dataset.index)].label.toLowerCase().includes(event.target.value.toLowerCase()) ? 'block' : 'none';
        });
    };
    modal.querySelector('[data-all]').onclick = () => { inputs.forEach(input => { if (input.parentElement.style.display !== 'none') input.checked = true; }); updateCount(); };
    modal.querySelector('[data-clear]').onclick = () => { inputs.forEach(input => { input.checked = false; }); updateCount(); };
    modal.querySelector('[data-cancel]').onclick = close;
    modal.querySelector('[data-apply]').onclick = () => {
        const chosen = candidates.filter((item, index) => inputs[index].checked);
        const missing = chosen.filter(item => !item.tpl);
        if (missing.length) _bcAddPresetsAsTemplates(missing.map(item => ({ name: item.label, data: item.data })));
        _bcNormalizeStateShape();
        const ids = chosen.map(item => item.tpl?.bulkTemplateId || _bulkState.templates.find(tpl => tpl.label === item.label)?.bulkTemplateId).filter(Boolean);
        if (entry) {
            entry.presetTemplateIds = ids;
            _bulkState.cellPresetMode = false;
            _bulkState.rowPresetMode = false;
        } else if (column) {
            _bulkState.cellTemplateIds[rowIndex][column.bulkCopyColumnId] = ids;
            _bulkState.cellPresetMode = true;
            _bulkState.rowPresetMode = false;
        } else {
            _bulkState.rowTemplateIds[rowIndex] = ids;
            _bulkState.rowPresetMode = true;
            _bulkState.cellPresetMode = false;
        }
        const toggle = document.getElementById('bc-row-preset-mode');
        if (toggle) toggle.checked = _bulkState.rowPresetMode;
        const cellToggle = document.getElementById('bc-cell-preset-mode');
        if (cellToggle) cellToggle.checked = _bulkState.cellPresetMode;
        close();
        _bcRenderTable();
        if (entry) _bcRenderBindings();
    };
    updateCount();
}

// ── Render data table ──
function _bcRenderTable() {
    const el = document.getElementById('bc-table-body');
    if (!el) return;
    _bcNormalizeStateShape();
    const cols = _bulkState.columns;
    let hdr = '<tr><th style="width:28px;text-align:center;color:#555;">#</th>';
    cols.forEach((c, ci) => {
        hdr += `<th class="bc-col-header ${c.type === 'media' ? 'bc-media-col-header' : ''}" data-ci="${ci}" style="min-width:110px;padding:3px 5px;position:relative;">
            <div style="display:flex;align-items:center;gap:4px;">
                <select class="bc-col-kind" data-ci="${ci}" title="选择列类型" style="width:74px;background:#0a0a14;border:1px solid #333;border-radius:3px;color:#ddd;font-size:10px;padding:1px;">${_bcColumnKindOptions(c)}</select>
                <input class="bc-col-name" data-ci="${ci}" list="bc-standard-column-names" value="${_bcEsc(c.name)}" style="flex:1;background:transparent;border:none;border-bottom:1px solid #333;color:#ddd;font-size:11px;padding:1px;min-width:0;" title="可手写，也可从下拉列表选择标准表头">
                <button class="bc-col-clear-name" data-ci="${ci}" title="清空表头（若已有绑定会询问是否保留）" style="${c.name ? '' : 'visibility:hidden;'};border:0;background:transparent;color:#fda4af;cursor:pointer;font-size:14px;line-height:16px;padding:0 1px;">×</button>
            </div>
        </th>`;
    });
    hdr += `<th style="min-width:150px;${_bcShowTemplateAssignments()?'':'display:none;'}">覆层预设（可多选）</th>`;
    hdr += '<th style="width:46px;text-align:center;"><button id="bc-add-col" style="background:none;border:none;color:#7c5cff;cursor:pointer;font-size:13px;" title="末尾添加列">+</button></th></tr>';
    let body = '';
    _bulkState.rows.forEach((row, ri) => {
        body += `<tr><td style="text-align:center;color:#555;font-size:10px;">${ri+1}</td>`;
        cols.forEach((c, ci) => {
            const v = row[ci] || '';
            const cls = c.type === 'media' ? 'bc-cell bc-cell-media' : 'bc-cell bc-cell-text';
            body += `<td class="bc-grid-td" data-ri="${ri}" data-ci="${ci}">
                <div class="${cls}" data-ri="${ri}" data-ci="${ci}" title="${_bcEsc(v)}">${c.type === 'media' ? _bcMediaCellHtml(v) : (v ? _bcCellPreview(v) : '<span class="bc-cell-placeholder"> </span>')}</div>
                ${_bcCellPresetButton(ri, ci)}
            </td>`;
        });
        const selectedIds = _bulkState.rowTemplateIds[ri] || [];
        const labels = _bulkState.templates.filter(tpl => selectedIds.includes(tpl.bulkTemplateId)).map(tpl => tpl.label);
        body += `<td style="${_bcShowTemplateAssignments()?'':'display:none;'}"><button class="bc-row-presets bc-btn bc-btn-default bc-btn-xs" data-ri="${ri}" title="${_bcEsc(labels.join('、'))}">${labels.length ? '已选 ' + labels.length + ' 个：' + _bcEsc(labels.join('、')) : '选择覆层预设…'}</button></td>`;
        body += `<td style="text-align:center;white-space:nowrap;"><span class="bc-row-copy" data-ri="${ri}" title="复制此行副本（做新版本）" style="cursor:pointer;color:#a78bfa;font-size:11px;margin-right:5px;">📋</span><span class="bc-row-del" data-ri="${ri}" title="删除此行" style="cursor:pointer;color:#f44;font-size:9px;">✕</span></td></tr>`;
    });
    const columnNameOptions = BC_STANDARD_COLUMN_NAMES.map(name => `<option value="${_bcEsc(name)}"></option>`).join('');
    el.innerHTML = `<datalist id="bc-standard-column-names">${columnNameOptions}</datalist><div id="bc-row-preset-count" style="padding:8px;color:#c4b5fd;font-size:12px;"></div><table class="bc-data-table"><thead>${hdr}</thead><tbody>${body}</tbody></table>`;
    _bcRenderRowPresetCount();
    _bcUpdateSelectionUI();
    _bcScheduleDraftSave();
}

// 预览弹窗编辑一个文案字段时，只更新表格中的那个单元格。过去这里调用
// _bcRenderTable()，随后关闭弹窗又重建整个“模板/背景/配乐/编号组”页面；
// 大工程有几十个模板和缩略图时会造成明显卡顿。
function _bcPatchTableCell(rowIndex, columnIndex) {
    const cell = document.querySelector(`#bc-table-body .bc-grid-td[data-ri="${rowIndex}"][data-ci="${columnIndex}"]`);
    if (!cell) return;
    const column = _bulkState.columns?.[columnIndex] || {};
    const value = _bulkState.rows?.[rowIndex]?.[columnIndex] || '';
    const className = column.type === 'media' ? 'bc-cell bc-cell-media' : 'bc-cell bc-cell-text';
    cell.innerHTML = `<div class="${className}" data-ri="${rowIndex}" data-ci="${columnIndex}" title="${_bcEsc(value)}">${column.type === 'media' ? _bcMediaCellHtml(value) : (value ? _bcCellPreview(value) : '<span class="bc-cell-placeholder"> </span>')}</div>${_bcCellPresetButton(rowIndex, columnIndex)}`;
    _bcRenderRowPresetCount();
}

// ── Render template binding panel ──
function _bcRenderBindings() {
    const el = document.getElementById('bc-bind-panel');
    if (!el) return;
    const prevScroll = el.scrollTop;
    _bcNormalizeStateShape();
    const cols = _bulkState.columns;
    const assignments = _bulkState.groupAssignments;
    const numberedGroups = _bcNumberedColumnGroups();
    let overlayMediaPresets = [];
    try { overlayMediaPresets = JSON.parse(localStorage.getItem('reels_custom_presets') || '[]'); } catch (_) { }
    overlayMediaPresets = overlayMediaPresets.filter(p => Array.isArray(p?.overlays) && p.overlays.some(ov => ['image', 'video'].includes(ov?.type)));
    const templateGroupKeys = _bulkState.templates.map(tpl => {
        const textIndices = Object.values(tpl.bindings || {}).filter(ci => ci >= 0 && cols[ci]?.type === 'text');
        return numberedGroups.find(group => textIndices.length && textIndices.every(ci => group.columns.some(col => col.ci === ci)))?.key;
    });
    const usage = _bulkState.templates.map((_, ti) => (assignments || []).filter(item => item.templateIndex === ti && numberedGroups.some(group => group.key === item.key)).length);
    const globalUsedFieldByCol = new Map();
    _bulkState.templates.forEach((tpl, ti) => {
        const fields = _bcFieldsFromTask(tpl.task || {});
        fields.forEach(f => {
            const ci = tpl.bindings?.[f.key];
            if (ci == null || ci < 0) return;
            if (!globalUsedFieldByCol.has(ci)) {
                globalUsedFieldByCol.set(ci, {
                    ti,
                    fk: f.key,
                    fieldLabel: f.label,
                    templateLabel: tpl.label || `模板${ti + 1}`,
                });
            }
        });
    });
    const unassignedGroupCount = numberedGroups.filter(g => {
        const entry = (assignments || []).find(e => e.key === g.key);
        return !entry || !entry.backgroundFolder;
    }).length;

    const isTplCollapsed = !!_bulkState.collapsedSections?.templates;
    const isBgCollapsed = !!_bulkState.collapsedSections?.backgrounds;
    const isMusicCollapsed = !!_bulkState.collapsedSections?.music;
    const isGroupsCollapsed = !!_bulkState.collapsedSections?.groups;
    const allCollapsed = isTplCollapsed && isBgCollapsed && isMusicCollapsed && isGroupsCollapsed;

    // 🔝 1. 最顶层：总览与全局操作栏（总预览放最醒目位置）
    let html = `<div class="bc-global-toolbar" style="background:linear-gradient(180deg, #18192c 0%, #121322 100%);border:1px solid #2e3150;border-radius:8px;padding:8px 10px;margin-bottom:10px;box-shadow:0 2px 8px rgba(0,0,0,0.25);">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;">
            <div style="display:flex;align-items:center;gap:6px;">
                <span style="font-weight:700;color:#c4b5fd;font-size:13px;display:inline-flex;align-items:center;gap:5px;">🧩 模板与素材分配</span>
                <span style="font-size:10px;color:#94a3b8;background:rgba(255,255,255,0.04);padding:1px 6px;border-radius:4px;border:1px solid rgba(255,255,255,0.06);">
                    ${numberedGroups.length} 组 · ${_bulkState.templates.length} 模板 · ${_bulkState.backgroundFolders.length} 背景 · ${_bulkState.musicFiles.length} 配乐
                </span>
            </div>
            <div style="display:flex;align-items:center;gap:5px;flex-wrap:wrap;">
                <button id="bc-preview-all" class="bc-btn bc-btn-blue" style="height:25px;padding:0 12px;font-size:11.5px;font-weight:600;box-shadow:0 2px 6px rgba(59,130,246,0.35);" title="横向批量对比并全屏预览所有编号组的排版与素材">👁 批量预览全部</button>
                <label style="display:inline-flex;align-items:center;gap:3px;cursor:pointer;color:${_bulkState.filterUnassignedGroups ? '#c4b5fd' : '#cbd5e1'};font-size:10px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);padding:2px 6px;border-radius:4px;" title="仅显示尚未分配背景素材的编号组">
                    <input id="bc-filter-unassigned-groups" type="checkbox" ${_bulkState.filterUnassignedGroups ? 'checked' : ''} style="accent-color:#7c5cff;">仅未分配组${numberedGroups.length ? ` (${unassignedGroupCount})` : ''}
                </label>
                <button id="bc-toggle-all-sections" class="bc-btn bc-btn-default bc-btn-xs" title="一键折叠或展开下方全部四个模块">${allCollapsed ? '展开全部模块' : '折叠全部模块'}</button>
                <button id="bc-manual-bindings" class="bc-btn bc-btn-default bc-btn-xs" title="切换视图模式">${assignments ? '原逐列绑定' : '启用编号组模式'}</button>
                <button id="bc-clear-bindings" class="bc-btn bc-btn-danger bc-btn-xs" title="清空全部编号组与模板的列绑定">清空绑定</button>
            </div>
        </div>
        <div style="font-size:10px;color:#717496;margin-top:4px;line-height:1.35;">
            ${assignments ? '下方分别管理模版库、背景库和配乐库（支持独立折叠收起）；配置完成后在编号组卡片中检查或微调。' : '当前为原逐列绑定模式；可点击上方按钮启用编号组模式，或在下方直接对模板进行字段绑定。'}
        </div>
    </div>`;

    // 🎨 2. 模块一：模版库（可折叠）
    const unassignedTemplates = _bulkState.templates.filter((tpl, ti) => {
        const assignedEntries = (assignments || []).filter(entry => entry.templateIndex === ti && numberedGroups.some(group => group.key === entry.key));
        return assignedEntries.length === 0;
    });
    const unassignedTplCount = unassignedTemplates.length;
    const visibleTemplates = _bulkState.templates
        .map((tpl, ti) => ({ tpl, ti }))
        .filter(({ ti }) => {
            if (!_bulkState.filterUnassignedTemplates) return true;
            const assignedEntries = (assignments || []).filter(entry => entry.templateIndex === ti && numberedGroups.some(group => group.key === entry.key));
            return assignedEntries.length === 0;
        });

    html += `<div id="bc-template-library" class="bc-library-box bc-tpl-library-box" style="background:rgba(124,92,255,0.03);border:1px solid rgba(124,92,255,0.22);border-radius:8px;padding:9px 10px;margin-bottom:10px;">
        <div data-toggle-section="templates" style="display:flex;align-items:center;justify-content:space-between;gap:6px;cursor:pointer;user-select:none;flex-wrap:wrap;" title="点击折叠 / 展开模版库">
            <div style="display:flex;align-items:center;gap:6px;">
                <span class="bc-toggle-arrow" style="color:#a78bfa;font-size:10px;width:12px;text-align:center;display:inline-block;">${isTplCollapsed ? '▶' : '▼'}</span>
                <span style="font-weight:700;font-size:11.5px;color:#d8cfff;display:inline-flex;align-items:center;gap:4px;">🎨 模版库</span>
                <span style="font-size:10px;color:#8a8ab0;">(${_bulkState.templates.length} 个模板)</span>
                ${isTplCollapsed ? '<span style="font-size:9.5px;color:#717496;background:rgba(255,255,255,0.04);padding:1px 5px;border-radius:3px;border:1px solid rgba(255,255,255,0.06);">已收起</span>' : ''}
            </div>
            <div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;">
                <button id="bc-add-tpl" class="bc-btn bc-btn-purple bc-btn-xs" style="font-weight:600;">+ 添加模板</button>
                <button id="bc-match-groups" class="bc-btn bc-btn-default bc-btn-xs" title="按顺序为每个编号组分配一个模板">顺序分配</button>
                <button id="bc-random-groups" class="bc-btn bc-btn-purple bc-btn-xs" title="为每个编号组随机分配一个模板">🎲 随机分配${_bulkState.allowTemplateReuse ? '（可重复）' : '（不重复）'}</button>
                <label style="display:inline-flex;align-items:center;gap:3px;cursor:pointer;color:#9b9db8;font-size:10px;" title="允许将同一个模板重复分配给多个编号组"><input id="bc-allow-reuse" type="checkbox" ${_bulkState.allowTemplateReuse ? 'checked' : ''} style="accent-color:#7c5cff;">允许重复</label>
                <label style="display:inline-flex;align-items:center;gap:3px;cursor:pointer;color:${_bulkState.filterUnassignedTemplates ? '#c4b5fd' : '#9b9db8'};font-size:10px;" title="仅查看尚未分配给任何编号组的模板"><input id="bc-filter-unassigned-tpls" type="checkbox" ${_bulkState.filterUnassignedTemplates ? 'checked' : ''} style="accent-color:#7c5cff;">仅未分配${_bulkState.templates.length ? ` (${unassignedTplCount})` : ''}</label>
                <button id="bc-clear-tpl-assignments" class="bc-btn bc-btn-default bc-btn-xs" title="清空全部编号组的模板分配">清空分配</button>
                <button id="bc-clear-templates" class="bc-btn bc-btn-danger bc-btn-xs" title="清空模版库中的所有模板">清空库</button>
                <button id="bc-rebind-tpl" class="bc-btn bc-btn-amber bc-btn-xs" title="按当前列名重新自动绑定全部模板字段">重绑</button>
            </div>
        </div>
        ${!isTplCollapsed ? `
            <div style="color:#8e92b2;font-size:10px;margin:6px 0;">为各编号组配对套用模板；可直接指定分配给哪个组或点击取消分配。</div>
            ${_bulkState.templates.length === 0 ? `
                <div style="padding:10px;text-align:center;color:#717496;font-size:10.5px;background:rgba(255,255,255,0.02);border:1px dashed #33334a;border-radius:6px;">
                    暂无模板，点击右上方「+ 添加模板」导入模板工程
                </div>
            ` : (_bulkState.templates.length > 0 && visibleTemplates.length === 0 ? `
                <div style="padding:14px 8px;text-align:center;color:#8a8ab0;font-size:11px;background:rgba(255,255,255,0.02);border:1px dashed #33334a;border-radius:6px;margin-top:6px;">🎉 全部模板均已分配到编号组</div>
            ` : `
                ${visibleTemplates.map(({ tpl, ti }) => {
                    const assignedEntries = (assignments || []).filter(entry => entry.templateIndex === ti && numberedGroups.some(group => group.key === entry.key));
                    const assignedKeys = assignedEntries.map(entry => entry.key);
                    const count = assignedKeys.length;
                    const task = tpl.task || {};
                    const bgName = (task.bgPath || task.videoPath || '').split(/[/\\]/).pop() || '无背景';
                    const overlaysCount = task.overlays?.length || 0;
                    const cycleBadge = tpl.bgCycle && tpl.bgCycle.length > 0
                        ? `<span class="bc-tpl-bgcycle" data-ti="${ti}" style="cursor:pointer;font-size:9px;background:rgba(16,185,129,0.2);color:#10b981;border:1px solid rgba(16,185,129,0.3);padding:1px 4px;border-radius:4px;" title="已自动读取当前预设的 ${tpl.bgCycle.length} 个循环素材，点击查看">🔄 自动循环(${tpl.bgCycle.length})</span>`
                        : `<span class="bc-tpl-bgcycle" data-ti="${ti}" style="cursor:pointer;font-size:9px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);color:#777;padding:1px 4px;border-radius:4px;" title="没有从该模板工程读取到多个背景素材，点击可手动补充">单背景</span>`;
                    const materialFolderName = tpl.materialFolder?.path
                        ? _bcFileName(tpl.materialFolder.path)
                        : '未绑定文件夹';
                    const materialFolderCount = tpl.materialFolder?.files?.length || 0;
                    const freeGroups = numberedGroups.filter(g => {
                        const entry = (assignments || []).find(e => e.key === g.key);
                        return !entry || entry.templateIndex == null || entry.templateIndex < 0;
                    });
                    const assignControlHtml = _bcRenderItemAssignControls({
                        kind: 'template',
                        itemVal: ti,
                        assignedKeys,
                        freeGroups,
                        allGroups: numberedGroups,
                    });
                    const fields = _bcFieldsFromTask(task);
                    return `<div class="bc-tpl-card-row ${count > 0 ? 'is-assigned' : ''}" style="display:flex;flex-direction:row;align-items:stretch;gap:10px;padding:8px;margin-top:6px;background:${count > 0 ? 'rgba(124,92,255,0.07)' : 'rgba(255,255,255,0.02)'};border:1px solid ${count > 0 ? 'rgba(124,92,255,0.35)' : 'rgba(124,92,255,0.14)'};border-radius:6px;transition:border-color 0.15s, background 0.15s;" title="${_bcEsc(tpl.label)}">
                        <div class="bc-tpl-thumb" style="width:48px;height:66px;flex:0 0 48px;border-radius:5px;overflow:hidden;background:#0c0c16;border:1px solid #36364e;display:flex;align-items:center;justify-content:center;position:relative;flex-shrink:0;">
                            <div id="bc-bind-thumb-loader-${ti}" style="font-size:10px;color:#666;text-align:center;">...</div>
                            <img crossorigin="anonymous" id="bc-bind-thumb-${ti}" src="" style="width:100%;height:100%;object-fit:cover;display:none;position:absolute;top:0;left:0;" />
                        </div>
                        <div style="flex:1;min-width:0;display:flex;flex-direction:column;justify-content:space-between;gap:4px;">
                            <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;">
                                <div style="font-weight:600;color:#eee;font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${_bcEsc(tpl.label)}">
                                    <span style="color:#a78bfa;margin-right:4px;">${ti + 1}.</span>${_bcEsc(tpl.label)}
                                </div>
                                <div style="display:flex;gap:4px;align-items:center;flex-shrink:0;">
                                    <button class="bc-tpl-edit-overlays bc-btn bc-btn-purple bc-btn-xs" data-ti="${ti}" title="可视化编辑该模板的覆层样式与排版">✏️ 覆层</button>
                                    <button class="bc-tpl-save-preset bc-btn bc-btn-amber bc-btn-xs" data-ti="${ti}" title="将此模板覆层样式存入全局预设库">💾 存为预设</button>
                                    <button class="bc-tpl-rename bc-btn bc-btn-default bc-btn-xs" data-ti="${ti}" title="修改模板显示名称">重命名</button>
                                    <button class="bc-tpl-del" data-ti="${ti}" style="padding:2px 6px;font-size:10px;cursor:pointer;background:rgba(255,80,80,0.08);border:1px solid rgba(255,80,80,0.25);border-radius:4px;color:#f88;" title="移出模版库">移出库</button>
                                </div>
                            </div>
                            <div style="color:#8a8ab0;font-size:10px;display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                                <span>${overlaysCount} 个覆层</span> ${_bcMediaStatusSlot(tpl)}
                                <span>·</span>
                                <span title="${_bcEsc(task.bgPath || task.videoPath || '')}">bg: ${_bcEsc(bgName)}</span>
                                ${cycleBadge}
                                <span>·</span>
                                <span>已选 <span style="${count > 0 ? 'color:#a78bfa;font-weight:600;' : ''}">${count}</span> 次</span>
                            </div>
                            <div style="display:flex;align-items:center;gap:3px;margin-top:2px;">
                                <button class="bc-tpl-folder-pick bc-btn bc-btn-blue bc-btn-xs" data-ti="${ti}" title="${_bcEsc(tpl.materialFolder?.path || '选择固定素材文件夹')}">📁 ${_bcEsc(materialFolderName)}</button>
                                <select class="bc-tpl-folder-mode bc-select" data-ti="${ti}" title="文件夹素材使用方式" style="height:20px;font-size:9.5px;padding:0 3px;">
                                    <option value="rows" ${tpl.materialFolder?.mode !== 'concat' ? 'selected' : ''}>一个素材一行</option>
                                    <option value="concat" ${tpl.materialFolder?.mode === 'concat' ? 'selected' : ''}>顺序拼接</option>
                                </select>
                                <button class="bc-tpl-folder-refresh bc-btn bc-btn-emerald bc-btn-xs" data-ti="${ti}">刷新${materialFolderCount ? `(${materialFolderCount})` : ''}</button>
                            </div>
                            ${assignments ? `
                            <div style="display:flex;align-items:center;gap:6px;font-size:10px;margin-top:2px;">
                                <span style="color:#a78bfa;font-weight:600;flex-shrink:0;">分配组:</span>
                                ${assignControlHtml}
                            </div>
                            ` : ''}
                            ${!assignments ? `
                            <div style="display:flex;align-items:center;gap:6px;margin-top:4px;">
                                <label style="display:flex;gap:6px;align-items:center;color:#c4b5fd;font-size:10px;margin:0;">编号组快速绑定
                                    <select class="bc-tpl-group bc-select" data-ti="${ti}" style="height:22px;font-size:10px;">
                                        <option value="">选择编号组（自动绑定整组字段）</option>
                                        ${numberedGroups.map(group => `<option value="${_bcEsc(group.key)}" ${templateGroupKeys[ti] === group.key ? 'selected' : ''}>${_bcEsc(group.key)}</option>`).join('')}
                                    </select>
                                </label>
                            </div>
                            <div style="display:grid;grid-template-columns:1fr;gap:3px;margin-top:4px;">
                                ${fields.map(f => {
                                    const bound = tpl.bindings[f.key];
                                    let unboundLabel = '(不绑定)';
                                    if (f.key === '__bg__') {
                                        const bg = (task.bgPath || task.videoPath || '').split(/[/\\]/).pop();
                                        unboundLabel = bg ? `✅ 模板原始: ${bg.slice(0, 20)}` : '(不绑定 · 无背景)';
                                    } else if (f.key === '__audio__') {
                                        const au = (task.audioPath || '').split(/[/\\]/).pop();
                                        unboundLabel = au ? `✅ 模板原始: ${au.slice(0, 20)}` : '(不绑定)';
                                    } else if (f.key.startsWith('L') || ['title_text','body_text','footer_text'].includes(f.key)) {
                                        unboundLabel = '(不绑定 · 用模板默认)';
                                    }
                                    return `<div style="display:flex;align-items:center;gap:6px;font-size:10px;color:#94a3b8;padding:2px 4px;border-radius:4px;background:rgba(255,255,255,0.02);margin-bottom:2px;">
                                        <span style="white-space:nowrap;width:115px;min-width:115px;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;color:#cbd5e1;font-weight:500;" title="${_bcEsc(f.label)}">${_bcEsc(f.label)}</span>
                                        <select class="bc-bind-sel bc-select" data-ti="${ti}" data-fk="${f.key}" title="${_bcEsc(_bcBindingDebugLabel(tpl, f))}" style="flex:1;min-width:0;height:24px;font-size:10.5px;padding:0 4px;">
                                            <option value="-1">${_bcEsc(unboundLabel)}</option>
                                            ${cols.map((c, ci) => {
                                                if (!_bcFieldAcceptsColumn(f, c)) return '';
                                                const usedBy = globalUsedFieldByCol.get(ci);
                                                const usedByOther = usedBy && !(usedBy.ti === ti && usedBy.fk === f.key) && bound !== ci;
                                                const usedLabel = usedByOther ? ` · 已绑定：${usedBy.templateLabel} / ${usedBy.fieldLabel}` : '';
                                                return `<option value="${ci}" ${bound === ci ? 'selected' : ''} ${usedByOther ? 'disabled' : ''}>${_bcEsc(_bcColumnKindOptionsLabel(c))} ${_bcEsc(c.name)}${_bcEsc(usedLabel)}</option>`;
                                            }).join('')}
                                        </select>
                                    </div>`;
                                }).join('')}
                            </div>
                            ` : ''}
                        </div>
                    </div>`;
                }).join('')}
            `)}
        ` : ''}
    </div>`;
    const unassignedBgFolders = _bulkState.backgroundFolders.filter(folder => {
        const assignedEntries = (assignments || []).filter(entry => entry.backgroundFolder === folder.path && numberedGroups.some(group => group.key === entry.key));
        return assignedEntries.length === 0;
    });
    const unassignedBgCount = unassignedBgFolders.length;
    const visibleFolders = _bulkState.backgroundFolders
        .map((folder, fi) => ({ folder, fi }))
        .filter(({ folder }) => {
            if (!_bulkState.filterUnassignedBackgrounds) return true;
            const assignedEntries = (assignments || []).filter(entry => entry.backgroundFolder === folder.path && numberedGroups.some(group => group.key === entry.key));
            return assignedEntries.length === 0;
        });

    // 📁 3. 模块二：背景库（可折叠）
    html += `<div id="bc-background-library" class="bc-library-box bc-bg-library-box" style="background:rgba(124,92,255,0.02);border:1px solid rgba(124,92,255,0.2);border-radius:8px;padding:9px 10px;margin-bottom:10px;">
        <div data-toggle-section="backgrounds" style="display:flex;align-items:center;justify-content:space-between;gap:6px;cursor:pointer;user-select:none;flex-wrap:wrap;" title="点击折叠 / 展开背景库">
            <div style="display:flex;align-items:center;gap:6px;">
                <span class="bc-toggle-arrow" style="color:#a78bfa;font-size:10px;width:12px;text-align:center;display:inline-block;">${isBgCollapsed ? '▶' : '▼'}</span>
                <span style="font-weight:700;font-size:11.5px;color:#d8cfff;display:inline-flex;align-items:center;gap:4px;">📁 背景库</span>
                <span style="font-size:10px;color:#8a8ab0;">(${_bulkState.backgroundFolders.length} 个背景)</span>
                ${isBgCollapsed ? '<span style="font-size:9.5px;color:#717496;background:rgba(255,255,255,0.04);padding:1px 5px;border-radius:3px;border:1px solid rgba(255,255,255,0.06);">已收起</span>' : ''}
            </div>
            <div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;">
                <button id="bc-add-background-folders" class="bc-btn bc-btn-purple bc-btn-xs">+ 添加文件夹</button>
                <button id="bc-seq-backgrounds" class="bc-btn bc-btn-default bc-btn-xs" title="按顺序为每个编号组分配背景素材">顺序分配</button>
                <button id="bc-random-backgrounds" class="bc-btn bc-btn-purple bc-btn-xs">🎲 ${_bulkState.allowBackgroundReuse ? '随机分配（可重复）' : '随机分配（不重复）'}</button>
                <label style="display:inline-flex;align-items:center;gap:3px;cursor:pointer;color:#9b9db8;font-size:10px;"><input id="bc-allow-bg-reuse" type="checkbox" ${_bulkState.allowBackgroundReuse ? 'checked' : ''} style="accent-color:#7c5cff;">允许重复</label>
                <label style="display:inline-flex;align-items:center;gap:3px;cursor:pointer;color:${_bulkState.filterUnassignedBackgrounds ? '#c4b5fd' : '#9b9db8'};font-size:10px;" title="仅查看尚未分配给任何编号组的背景素材"><input id="bc-filter-unassigned-bgs" type="checkbox" ${_bulkState.filterUnassignedBackgrounds ? 'checked' : ''} style="accent-color:#7c5cff;">仅未分配背景${_bulkState.backgroundFolders.length ? ` (${unassignedBgCount})` : ''}</label>
                <button id="bc-clear-bg-assignments" class="bc-btn bc-btn-default bc-btn-xs" title="清空全部编号组的背景素材分配">清空分配</button>
                <button id="bc-clear-backgrounds" class="bc-btn bc-btn-danger bc-btn-xs" title="清空全部背景素材">清空库</button>
            </div>
        </div>
        ${!isBgCollapsed ? `
            <div style="color:#8e92b2;font-size:10px;margin:6px 0;">拖入多个文件夹到此处，每夹为一组背景。可重复分配给编号组；只读取文件夹内的视频和图片。</div>
            ${_bulkState.backgroundFolders.length > 0 && visibleFolders.length === 0 ? '<div style="padding:14px 8px;text-align:center;color:#8a8ab0;font-size:11px;background:rgba(255,255,255,0.02);border:1px dashed #33334a;border-radius:6px;margin-top:6px;">🎉 全部背景均已分配到编号组</div>' : ''}
            ${visibleFolders.map(({ folder, fi }) => {
                const assignedEntries = (assignments || []).filter(entry => entry.backgroundFolder === folder.path && numberedGroups.some(group => group.key === entry.key));
                const assignedKeys = assignedEntries.map(entry => entry.key);
                const count = assignedKeys.length;
                const files = folder.files || [];
                const folderName = folder.name || _bcFileName(folder.path);
                const firstFile = files[0];
                const kind = firstFile ? _bcMediaKind(firstFile) : '';
                const url = firstFile ? _bcFileUrl(firstFile) : '';
                let thumbInner = '';
                if (firstFile) {
                    if (kind === 'image') {
                        thumbInner = `<img crossorigin="anonymous" src="${_bcEsc(url)}" loading="lazy" style="width:100%;height:100%;object-fit:cover;display:block;pointer-events:none;" alt="">`;
                    } else if (kind === 'video') {
                        thumbInner = `<video crossorigin="anonymous" src="${_bcEsc(url)}#t=0.1" muted preload="metadata" playsinline style="width:100%;height:100%;object-fit:cover;display:block;pointer-events:none;"></video>`;
                    } else {
                        thumbInner = `<span style="font-size:16px;pointer-events:none;">${_bcMediaIconForKind(kind)}</span>`;
                    }
                } else {
                    thumbInner = `<span style="font-size:14px;opacity:0.35;pointer-events:none;">📁</span>`;
                }

                const freeGroups = numberedGroups.filter(g => {
                    const entry = (assignments || []).find(e => e.key === g.key);
                    return !entry || !entry.backgroundFolder;
                });
                const assignControlHtml = _bcRenderItemAssignControls({
                    kind: 'folder',
                    itemVal: folder.path,
                    assignedKeys,
                    freeGroups,
                    allGroups: numberedGroups,
                });

                return `<div class="bc-bg-folder-row ${count > 0 ? 'is-assigned' : ''}" style="display:flex;flex-direction:row;align-items:stretch;gap:10px;padding:8px;margin-top:6px;background:${count > 0 ? 'rgba(124,92,255,0.07)' : 'rgba(255,255,255,0.02)'};border:1px solid ${count > 0 ? 'rgba(124,92,255,0.35)' : 'rgba(124,92,255,0.14)'};border-radius:6px;transition:border-color 0.15s, background 0.15s;" title="${_bcEsc(folder.path)}">
                    <div class="bc-bg-folder-thumb" data-fi="${fi}" title="点击浏览此背景全部素材${firstFile ? `（首个: ${_bcEsc(_bcFileName(firstFile))}）` : ''}">
                        ${thumbInner}
                        ${firstFile && (kind === 'video' || kind === 'image') ? `<span style="position:absolute;bottom:2px;right:2px;font-size:9px;background:rgba(0,0,0,0.78);padding:1px 3px;border-radius:3px;line-height:1.1;color:#ddd;pointer-events:none;">${kind === 'video' ? '🎬' : '🖼'}</span>` : ''}
                    </div>
                    <div style="flex:1;min-width:0;display:flex;flex-direction:column;justify-content:space-between;gap:4px;">
                        <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;">
                            <div style="font-weight:600;color:#eee;font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${_bcEsc(folderName)}">${_bcEsc(folderName)}</div>
                            <div style="display:flex;gap:4px;align-items:center;flex-shrink:0;">
                                <button class="bc-background-open-folder" data-fi="${fi}" style="padding:2px 6px;font-size:10px;cursor:pointer;background:#20202e;border:1px solid #3c3c52;border-radius:4px;color:#c4b5fd;" title="在 Finder 中打开此背景文件夹">打开文件夹</button>
                                <button class="bc-background-refresh" data-fi="${fi}" style="padding:2px 6px;font-size:10px;cursor:pointer;background:#20202e;border:1px solid #3c3c52;border-radius:4px;color:#aaa;" title="重新扫描此文件夹">刷新</button>
                                <button class="bc-background-remove" data-fi="${fi}" style="padding:2px 6px;font-size:10px;cursor:pointer;background:rgba(255,80,80,0.08);border:1px solid rgba(255,80,80,0.25);border-radius:4px;color:#f88;" title="移出背景库">移出库</button>
                            </div>
                        </div>
                        <div style="color:#8a8ab0;font-size:10px;display:flex;align-items:center;gap:6px;">
                            <span>${files.length} 个素材</span> ${_bcMediaStatusSlot(folder)}
                            <span>·</span>
                            <span>已选 <span style="${count > 0 ? 'color:#a78bfa;font-weight:600;' : ''}">${count}</span> 次</span>
                        </div>
                        <div style="display:flex;align-items:center;gap:6px;font-size:10px;">
                            <span style="color:#a78bfa;font-weight:600;flex-shrink:0;">分配组:</span>
                            ${assignControlHtml}
                        </div>
                    </div>
                </div>`;
            }).join('')}
        ` : ''}
    </div>`;

    // 🖼 Logo 媒体库：独立于模板覆层替换。一个源可为单文件或整个文件夹。
    html += `<div id="bc-logo-media-library" class="bc-library-box" style="background:rgba(236,72,153,.035);border:1px solid rgba(244,114,182,.28);border-radius:8px;padding:9px 10px;margin-bottom:10px;">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;flex-wrap:wrap;">
            <div><span style="font-weight:700;font-size:11.5px;color:#fbcfe8;">🖼 Logo 媒体库</span><span style="font-size:10px;color:#f9a8d4;margin-left:6px;">${_bulkState.logoMediaLibrary.length} 个素材源</span></div>
            <div style="display:flex;gap:4px;"><button id="bc-add-logo-files" class="bc-btn bc-btn-purple bc-btn-xs">+ 添加媒体</button><button id="bc-add-logo-folders" class="bc-btn bc-btn-purple bc-btn-xs">+ 添加文件夹</button><button id="bc-seq-logo-media" class="bc-btn bc-btn-default bc-btn-xs">顺序分配任务组</button><button id="bc-random-logo-media" class="bc-btn bc-btn-default bc-btn-xs">🎲 随机分配</button></div>
        </div>
        <div style="margin-top:6px;color:#8e92b2;font-size:10px;line-height:1.45;">单独添加的图片或视频可直接绑定任务组；文件夹内媒体会在该组每条任务中循环（不足自动重复）。生成时只追加一个 Logo 媒体覆层，不会替换文字卡。</div>
        ${_bulkState.logoMediaLibrary.length ? `<div style="display:flex;flex-wrap:wrap;gap:5px;margin-top:7px;">${_bulkState.logoMediaLibrary.map((item, i) => `<span style="display:inline-flex;gap:5px;align-items:center;padding:3px 6px;border-radius:4px;background:rgba(236,72,153,.10);border:1px solid rgba(244,114,182,.25);font-size:10px;color:#fce7f3;" title="${_bcEsc(item.path)}">${item.kind === 'folder' ? '📁' : '🖼'} ${_bcEsc(item.name)} · ${item.files?.length || 0} ${_bcMediaStatusSlot(item)}<button class="bc-logo-media-remove" data-li="${i}" title="移出 Logo 媒体库" style="border:0;background:transparent;color:#fda4af;cursor:pointer;padding:0 0 0 2px;">×</button></span>`).join('')}</div>` : ''}
    </div>`;

    const musicHasAnyAssignment = musicPath => (assignments || []).some(entry =>
        (entry.musicPath === musicPath && numberedGroups.some(group => group.key === entry.key))
        || Object.values(entry.musicTaskAssignments || {}).includes(musicPath)
    );
    const unassignedMusic = _bulkState.musicFiles.filter(music => !musicHasAnyAssignment(music.path));
    const unassignedMusicCount = unassignedMusic.length;
    const visibleMusic = _bulkState.musicFiles
        .map((music, mi) => ({ music, mi }))
        .filter(({ music }) => {
            if (!_bulkState.filterUnassignedMusic) return true;
            return !musicHasAnyAssignment(music.path);
        });

    // 🖼 4. 覆层媒体库：与背景库分离，按编号组（该组内每一任务行）轮换替换媒体。
    html += `<div id="bc-overlay-media-library" class="bc-library-box" style="background:rgba(14,165,233,.035);border:1px solid rgba(56,189,248,.25);border-radius:8px;padding:9px 10px;margin-bottom:10px;">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;flex-wrap:wrap;">
            <div><span style="font-weight:700;font-size:11.5px;color:#bae6fd;">🖼 覆层媒体批量替换</span><span style="font-size:10px;color:#7dd3fc;margin-left:6px;">${_bulkState.overlayMediaFolders.length} 个文件夹</span></div>
            <div style="display:flex;gap:4px;"><button id="bc-add-overlay-media-folders" class="bc-btn bc-btn-blue bc-btn-xs">+ 添加文件夹</button><button id="bc-seq-overlay-media" class="bc-btn bc-btn-default bc-btn-xs">顺序分配给任务组</button><button id="bc-clear-overlay-media" class="bc-btn bc-btn-danger bc-btn-xs">清空库</button></div>
        </div>
        <div style="margin-top:6px;color:#8e92b2;font-size:10px;line-height:1.45;">拖入多个文件夹到此处；每个编号组选择一个文件夹，组内每一任务行按顺序取一个素材。它只替换“覆层媒体槽”，不会改背景、正文视频或时间线插入素材。</div>
        ${_bulkState.overlayMediaFolders.length ? `<div style="display:flex;flex-wrap:wrap;gap:5px;margin-top:7px;">${_bulkState.overlayMediaFolders.map((folder, fi) => `<span style="display:inline-flex;gap:5px;align-items:center;padding:3px 6px;border-radius:4px;background:rgba(14,165,233,.10);border:1px solid rgba(56,189,248,.25);font-size:10px;color:#dbeafe;" title="${_bcEsc(folder.path)}">📁 ${_bcEsc(folder.name)} · ${folder.files?.length || 0} ${_bcMediaStatusSlot(folder)}<button class="bc-overlay-folder-remove" data-fi="${fi}" title="从覆层媒体库移除" style="border:0;background:transparent;color:#fda4af;cursor:pointer;padding:0 0 0 2px;">×</button></span>`).join('')}</div>` : ''}
    </div>`;

    // 🎵 5. 模块三：配乐库（可折叠）
    html += `<div id="bc-music-library" class="bc-library-box bc-music-library-box" style="background:rgba(16,185,129,0.02);border:1px solid rgba(16,185,129,0.2);border-radius:8px;padding:9px 10px;margin-bottom:10px;">
        <div data-toggle-section="music" style="display:flex;align-items:center;justify-content:space-between;gap:6px;cursor:pointer;user-select:none;flex-wrap:wrap;" title="点击折叠 / 展开配乐库">
            <div style="display:flex;align-items:center;gap:6px;">
                <span class="bc-toggle-arrow" style="color:#34d399;font-size:10px;width:12px;text-align:center;display:inline-block;">${isMusicCollapsed ? '▶' : '▼'}</span>
                <span style="font-weight:700;font-size:11.5px;color:#a7f3d0;display:inline-flex;align-items:center;gap:4px;">🎵 配乐库</span>
                <span style="font-size:10px;color:#7ab89b;">(${_bulkState.musicFiles.length} 首配乐)</span>
                ${isMusicCollapsed ? '<span style="font-size:9.5px;color:#717496;background:rgba(255,255,255,0.04);padding:1px 5px;border-radius:3px;border:1px solid rgba(255,255,255,0.06);">已收起</span>' : ''}
            </div>
            <div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;">
                <button id="bc-add-music" class="bc-btn bc-btn-emerald bc-btn-xs">+ 添加配乐</button>
                <button id="bc-seq-music" class="bc-btn bc-btn-default bc-btn-xs" title="按顺序为每个编号组分配一首整套配乐">顺序分配</button>
                <button id="bc-random-music" class="bc-btn bc-btn-emerald bc-btn-xs" title="生成时每条任务独立随机抽取一首配乐">🎲 每条任务随机（${_bulkState.allowMusicReuse ? '可重复' : '不重复'}）</button>
                <label style="display:inline-flex;align-items:center;gap:3px;cursor:pointer;color:#7ab89b;font-size:10px;"><input id="bc-allow-music-reuse" type="checkbox" ${_bulkState.allowMusicReuse ? 'checked' : ''} style="accent-color:#10b981;">允许重复</label>
                <label style="display:inline-flex;align-items:center;gap:3px;cursor:pointer;color:${_bulkState.filterUnassignedMusic ? '#a7f3d0' : '#7ab89b'};font-size:10px;" title="仅查看尚未分配给任何编号组的配乐"><input id="bc-filter-unassigned-music" type="checkbox" ${_bulkState.filterUnassignedMusic ? 'checked' : ''} style="accent-color:#10b981;">仅未分配${_bulkState.musicFiles.length ? ` (${unassignedMusicCount})` : ''}</label>
                <button id="bc-clear-music-assignments" class="bc-btn bc-btn-default bc-btn-xs" title="清空全部编号组的配乐分配">清空分配</button>
                <button id="bc-clear-music" class="bc-btn bc-btn-danger bc-btn-xs" title="清空全部配乐文件">清空库</button>
            </div>
        </div>
        ${!isMusicCollapsed ? `
            <div style="color:#7ab89b;font-size:10px;margin:6px 0;">可直接拖入多首音频，或点击添加配乐；点击试听按钮可实时播放或停止。</div>
            ${_bulkState.musicFiles.length > 0 && visibleMusic.length === 0 ? '<div style="padding:14px 8px;text-align:center;color:#8a8ab0;font-size:11px;background:rgba(255,255,255,0.02);border:1px dashed #33334a;border-radius:6px;margin-top:6px;">🎉 全部配乐均已分配到编号组</div>' : ''}
            ${visibleMusic.map(({ music, mi }) => {
                const assignedEntries = (assignments || []).filter(entry => entry.musicPath === music.path && numberedGroups.some(group => group.key === entry.key));
                const assignedKeys = assignedEntries.map(entry => entry.key);
                // 随机模式是“任务级”而不是“整组级”。将预先固定的抽签记录
                // 展开为「编号组 · 第几条任务」，不再让配乐库看起来全是未分配。
                const randomTaskRefs = (assignments || []).flatMap(entry => Object.entries(entry.musicTaskAssignments || {})
                    .filter(([, path]) => path === music.path)
                    .map(([taskIndex]) => ({ group: entry.key, taskIndex: Number(taskIndex) + 1 })));
                const count = assignedKeys.length + randomTaskRefs.length;
                const isPlaying = _bcCurrentPlayingMusic === music.path;
                const freeGroups = numberedGroups.filter(g => {
                    const entry = (assignments || []).find(e => e.key === g.key);
                    return !entry || !entry.musicPath;
                });
                const assignControlHtml = _bcRenderItemAssignControls({
                    kind: 'music',
                    itemVal: music.path,
                    assignedKeys,
                    freeGroups,
                    allGroups: numberedGroups,
                });
                const randomTaskHtml = randomTaskRefs.length
                    ? `<div style="display:flex;align-items:flex-start;gap:6px;font-size:10px;"><span style="color:#34d399;font-weight:600;flex-shrink:0;">🎲 随机任务:</span><div style="display:flex;flex-wrap:wrap;gap:4px;">${randomTaskRefs.map(ref => `<span style="padding:1px 5px;border-radius:3px;background:rgba(16,185,129,.12);border:1px solid rgba(16,185,129,.28);color:#a7f3d0;" title="${_bcEsc(ref.group)} 的第 ${ref.taskIndex} 条任务">${_bcEsc(ref.group)} · 第${ref.taskIndex}条</span>`).join('')}</div></div>`
                    : '';
                return `<div class="bc-music-row${count > 0 ? ' is-assigned' : ''}" style="display:flex;flex-direction:row;align-items:stretch;gap:10px;padding:8px;margin-top:6px;background:${count > 0 ? 'rgba(16,185,129,0.07)' : 'rgba(255,255,255,0.02)'};border:1px solid ${count > 0 ? 'rgba(16,185,129,0.35)' : 'rgba(16,185,129,0.14)'};border-radius:6px;transition:border-color 0.15s, background 0.15s;" title="${_bcEsc(music.path || music.name)}">
                    <div style="width:48px;height:48px;flex:0 0 48px;border-radius:5px;background:#0c1612;border:1px solid #224e3c;display:flex;flex-direction:column;align-items:center;justify-content:center;position:relative;flex-shrink:0;gap:2px;">
                        <span style="font-size:13px;pointer-events:none;">🎵</span>
                        <button class="bc-music-play" data-path="${_bcEsc(music.path)}" style="width:22px;height:20px;line-height:18px;font-size:10px;padding:0;background:${isPlaying ? '#10b981' : 'rgba(255,255,255,0.06)'};color:${isPlaying ? '#000' : '#a7f3d0'};border:1px solid #10b981;border-radius:3px;cursor:pointer;display:flex;align-items:center;justify-content:center;" title="${isPlaying ? '暂停试听' : '试听播放'}">${isPlaying ? '⏹' : '▶'}</button>
                    </div>
                    <div style="flex:1;min-width:0;display:flex;flex-direction:column;justify-content:space-between;gap:4px;">
                        <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;">
                            <div style="font-weight:600;color:#e2e8f0;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${_bcEsc(music.name)}">${_bcEsc(music.name)}</div>
                            <button class="bc-music-remove" data-mi="${mi}" style="padding:2px 6px;font-size:10px;cursor:pointer;background:rgba(255,80,80,0.08);border:1px solid rgba(255,80,80,0.25);border-radius:4px;color:#f88;" title="从配乐库移除">移出库</button>
                        </div>
                        ${_bcMediaStatusSlot(music)}
                        <div style="color:#7ab89b;font-size:10px;">已选 <span style="${count > 0 ? 'color:#34d399;font-weight:600;' : ''}">${count}</span> 次</div>
                        <div style="display:flex;align-items:center;gap:6px;font-size:10px;">
                            <span style="color:#34d399;font-weight:600;flex-shrink:0;">分配组:</span>
                            ${assignControlHtml}
                        </div>
                        ${randomTaskHtml}
                    </div>
                </div>`;
            }).join('')}
        ` : ''}
    </div>`;
    const visibleGroups = numberedGroups.filter(group => {
        if (!_bulkState.filterUnassignedGroups) return true;
        const entry = assignments?.find(item => item.key === group.key);
        return !entry || !entry.backgroundFolder;
    });

    // 📋 5. 模块四：编号组详细配置与微调（可折叠）
    html += `<div id="bc-groups-section" class="bc-library-box" style="background:rgba(255,255,255,0.015);border:1px solid #272942;border-radius:8px;padding:9px 10px;margin-bottom:10px;">
        <div data-toggle-section="groups" style="display:flex;align-items:center;justify-content:space-between;gap:6px;cursor:pointer;user-select:none;flex-wrap:wrap;" title="点击折叠 / 展开编号组详细配置">
            <div style="display:flex;align-items:center;gap:6px;">
                <span class="bc-toggle-arrow" style="color:#a78bfa;font-size:10px;width:12px;text-align:center;display:inline-block;">${isGroupsCollapsed ? '▶' : '▼'}</span>
                <span style="font-weight:700;font-size:12px;color:#c4b5fd;display:inline-flex;align-items:center;gap:5px;">📋 编号组详细配置与微调</span>
                <span style="font-size:10px;color:#8a8ab0;">(${visibleGroups.length} / ${numberedGroups.length} 组)</span>
                ${isGroupsCollapsed ? '<span style="font-size:9.5px;color:#717496;background:rgba(255,255,255,0.04);padding:1px 5px;border-radius:3px;border:1px solid rgba(255,255,255,0.06);">已收起</span>' : ''}
            </div>
            <div style="font-size:10px;color:#717496;">
                ${isGroupsCollapsed ? '展开明细 ▶' : '收起明细 ▼'}
            </div>
            <button id="bc-copy-group-assignments" class="bc-btn bc-btn-purple bc-btn-xs" title="一键复制所有任务组的分配情况（制表符分隔，可直接粘贴到 Excel / 表格）">📋 一键复制各组分配</button>
            <button id="bc-add-viral-groups" class="bc-btn bc-btn-amber bc-btn-xs" title="查看全部爆帖工程组合，可多选加入当前批量任务">🔥 爆帖工程组合库 / 添加</button>
            <button id="bc-export-viral-groups" class="bc-btn bc-btn-default bc-btn-xs" title="导出爆帖工程组合库，可带到另一台电脑或备份">⬆ 导出组合</button>
            <button id="bc-import-viral-groups" class="bc-btn bc-btn-default bc-btn-xs" title="导入之前导出的爆帖工程组合文件">⬇ 导入组合</button>
        </div>
        ${!isGroupsCollapsed ? `
            <div style="font-size:10px;color:#8e92b2;margin:6px 0 8px 0;">${assignments ? '每个编号组独立生成一条任务；点击组内「👁 预览」可查看排版并实时修改覆层标题与正文。' : '当前使用原逐列绑定；点击上方模板卡片或启用编号组分配。'}</div>
            ${numberedGroups.length > 0 && visibleGroups.length === 0 ? '<div style="padding:14px 8px;text-align:center;color:#8a8ab0;font-size:11px;background:rgba(255,255,255,0.02);border:1px dashed #33334a;border-radius:6px;margin-bottom:8px;">🎉 全部编号组均已分配背景素材</div>' : ''}
            ${(() => {
                let gHtml = '';
                visibleGroups.forEach(group => {
                    const entry = assignments?.find(item => item.key === group.key);
                    const assigned = entry ? _bcAssignedTemplate(entry, group) : null;
                    // 表头被手动清空时保留原绑定；在对应编号组醒目提示缺失，
                    // 让用户修复表头后立刻继续使用，而不是悄悄丢失配置。
                    const fieldLabels = new Map(_bcFieldsFromTask(assigned?.task || {}).map(field => [field.key, field.label]));
                    const missingBoundHeaders = assigned ? Object.entries(assigned.bindings || {})
                        .filter(([, ci]) => !String(_bulkState.columns[Number(ci)]?.name || '').trim())
                        .map(([field]) => fieldLabels.get(field) || field)
                        : [];
                    // 组的所有列被清空时，bindings 可能本来就为空或被历史数据
                    // 过滤过；仍必须给用户一个确定、可见的组级告警，不能依赖
                    // “能否反推出字段”才显示。
                    const groupHasNoHeaders = !group.columns?.length;
                    const missingHeadersHtml = groupHasNoHeaders
                        ? `<div style="margin:6px 0 0;padding:6px 8px;border-radius:5px;background:rgba(245,158,11,.16);border:1px solid rgba(245,158,11,.55);color:#fde68a;font-size:10.5px;font-weight:600;line-height:1.45;">⚠ 缺少表头组文案：当前任务组「${_bcEsc(group.key)}」没有可用表头。请重新粘贴或填写该组的表头；已保留的绑定会在表头恢复后继续使用。</div>`
                        : (missingBoundHeaders.length ? `<div style="margin:6px 0 0;padding:5px 7px;border-radius:5px;background:rgba(245,158,11,.12);border:1px solid rgba(245,158,11,.4);color:#fcd34d;font-size:10px;line-height:1.4;">⚠ 缺少表头：${_bcEsc(missingBoundHeaders.join('、'))}。绑定已保留；重新填写该列表头即可恢复。</div>` : '');
                    const mediaLayers = (assigned?.task?.overlays || []).map((ov, i) => ({ ov, i })).filter(({ ov }) => ['image', 'video'].includes(ov?.type));
                    gHtml += `<div class="bc-group-card" data-bc-group-card="${_bcEsc(group.key)}">
            <div style="display:flex;align-items:center;gap:6px;">
                <span class="bc-group-badge" title="内部编号：${_bcEsc(group.key)}">${_bcEsc(group.key)}</span>
                ${entry ? `<button class="bc-group-rebind bc-btn bc-btn-default bc-btn-xs" data-group="${_bcEsc(group.key)}" title="将本组配置迁移到表格中新的文案组名">绑定新文案组</button>` : ''}
                ${entry?.comboName && entry.comboName !== group.key ? `<span style="font-size:11px;color:#fbbf24;" title="来自组合库：${_bcEsc(entry.comboName)}">🔥 ${_bcEsc(entry.comboName)}</span>` : ''}
                <span style="color:#6b7280;font-size:11px;">→</span>
                <select class="bc-group-template" data-group="${_bcEsc(group.key)}" style="flex:1;min-width:0;">
                    <option value="-1">未分配（不生成）</option>
                    ${_bulkState.templates.map((tpl, ti) => `<option value="${ti}" ${entry?.templateIndex === ti ? 'selected' : ''}>${ti + 1}. ${_bcEsc(tpl.label)} · 已选 ${usage[ti]} 次</option>`).join('')}
                </select>
                <button class="bc-group-presets bc-btn bc-btn-default bc-btn-xs" data-group="${_bcEsc(group.key)}" title="让本组每条文案分别套用多个覆层预设">🎨 ${Array.isArray(entry?.presetTemplateIds) ? '整组选 ' + entry.presetTemplateIds.length + ' 个预设' : '整组多选预设'}</button>
            </div>
            ${missingHeadersHtml}
            <span data-bc-group-media>${_bcGroupMediaStatusSlot(entry, assigned)}</span>
            <div class="bc-group-grid">
                <div class="bc-group-field-item">
                    <label style="display:flex;align-items:center;justify-content:space-between;gap:6px;">📁 背景 <button type="button" class="bc-group-open-background-folder bc-btn bc-btn-default bc-btn-xs" data-group="${_bcEsc(group.key)}" ${entry?.backgroundFolder ? '' : 'disabled'} title="在 Finder 中打开当前任务组选择的背景文件夹" style="padding:1px 6px;font-size:10px;">打开文件夹</button></label>
                    <select class="bc-group-background" data-group="${_bcEsc(group.key)}" style="width:100%;">
                        <option value="">沿用模板 / 字段绑定背景</option>
                        ${_bulkState.backgroundFolders.map(folder => `<option value="${_bcEsc(folder.path)}" ${entry?.backgroundFolder === folder.path ? 'selected' : ''}>${_bcEsc(folder.name)}（${folder.files.length} 个素材）</option>`).join('')}
                    </select>
                </div>
                <div class="bc-group-field-item">
                    <label>🔁 背景抽取方式</label>
                    <select class="bc-group-background-mode" data-group="${_bcEsc(group.key)}" style="width:100%;">
                        <option value="cycle" ${!entry?.backgroundMode || entry.backgroundMode === 'cycle' ? 'selected' : ''}>按任务顺序循环</option>
                        <option value="random" ${entry?.backgroundMode === 'random' ? 'selected' : ''}>每条任务随机取一个</option>
                        <option value="concat" ${entry?.backgroundMode === 'concat' ? 'selected' : ''}>全部顺序拼接</option>
                        <option value="selected-cycle" ${entry?.backgroundMode === 'selected-cycle' ? 'selected' : ''}>选择指定素材循环</option>
                    </select>
                </div>
                <div class="bc-group-field-item">
                    <label>🎶 配乐模式</label>
                    <select class="bc-group-music-mode" data-group="${_bcEsc(group.key)}" style="width:100%;">
                        <option value="suite" ${!entry?.musicMode || entry.musicMode === 'suite' ? 'selected' : ''}>整套共用一首</option>
                        <option value="cycle" ${entry?.musicMode === 'cycle' ? 'selected' : ''}>每条任务轮流配乐（配乐库循环）</option>
                        <option value="random" ${entry?.musicMode === 'random' ? 'selected' : ''}>每条任务随机配乐（配乐库）</option>
                    </select>
                </div>
                <div class="bc-group-field-item">
                    <label>🎵 整套配乐</label>
                    <select class="bc-group-music" data-group="${_bcEsc(group.key)}" style="width:100%;" ${entry?.musicMode === 'cycle' || entry?.musicMode === 'random' ? 'disabled' : ''}>
                        <option value="">沿用模板 / 不指定配乐</option>
                        ${_bulkState.musicFiles.map(music => `<option value="${_bcEsc(music.path)}" ${entry?.musicPath === music.path ? 'selected' : ''}>${_bcEsc(music.name)}</option>`).join('')}
                    </select>
                </div>
                <div class="bc-group-field-item">
                    <label>🖼 Logo 媒体覆层</label>
                    <select class="bc-group-logo-source" data-group="${_bcEsc(group.key)}" style="width:100%;">
                        <option value="">不追加 Logo 媒体</option>
                        ${_bulkState.logoMediaLibrary.map(item => `<option value="${_bcEsc(item.id)}" ${entry?.logoOverlay?.sourceId === item.id ? 'selected' : ''}>${item.kind === 'folder' ? '📁' : '🖼'} ${_bcEsc(item.name)}（${item.files?.length || 0} 个）</option>`).join('')}
                    </select>
                </div>
                <div class="bc-group-field-item">
                    <label>🔁 Logo 组内分配</label>
                    <div style="display:flex;gap:4px;">
                        <select class="bc-group-logo-mode" data-group="${_bcEsc(group.key)}" style="flex:1;min-width:0;" ${entry?.logoOverlay?.sourceId ? '' : 'disabled'}>
                            <option value="cycle" ${!entry?.logoOverlay?.taskMode || entry?.logoOverlay?.taskMode === 'cycle' ? 'selected' : ''}>按任务顺序循环</option>
                            <option value="random" ${entry?.logoOverlay?.taskMode === 'random' ? 'selected' : ''}>每条任务随机</option>
                        </select>
                        <button type="button" class="bc-group-logo-edit bc-btn bc-btn-purple bc-btn-xs" data-group="${_bcEsc(group.key)}" title="打开与外部图片/视频覆层相同的完整参数面板" ${entry?.logoOverlay?.sourceId ? '' : 'disabled'}>参数</button>
                    </div>
                </div>
                <div class="bc-group-field-item">
                    <label>↕ Logo 图层</label>
                    <select class="bc-group-logo-stack" data-group="${_bcEsc(group.key)}" style="width:100%;" ${entry?.logoOverlay?.sourceId ? '' : 'disabled'}>
                        <option value="below" ${!entry?.logoOverlay?.stackPosition || entry?.logoOverlay?.stackPosition === 'below' ? 'selected' : ''}>文字卡下方（默认）</option>
                        <option value="above" ${entry?.logoOverlay?.stackPosition === 'above' ? 'selected' : ''}>全部覆层上方</option>
                    </select>
                </div>
                <div class="bc-group-field-item">
                    <label>🖼 覆层媒体文件夹</label>
                    <select class="bc-group-overlay-media" data-group="${_bcEsc(group.key)}" style="width:100%;">
                        <option value="">沿用模板覆层媒体</option>
                        ${_bulkState.overlayMediaFolders.map(folder => `<option value="${_bcEsc(folder.path)}" ${entry?.overlayMediaFolder === folder.path ? 'selected' : ''}>${_bcEsc(folder.name)}（${folder.files.length} 个，组内任务轮换）</option>`).join('')}
                    </select>
                </div>
                <div class="bc-group-field-item">
                    <label>🎨 覆层媒体样式模板</label>
                    <select class="bc-group-overlay-preset" data-group="${_bcEsc(group.key)}" style="width:100%;">
                        <option value="">沿用已选任务模板的覆层</option>
                        ${overlayMediaPresets.map((p, pi) => `<option value="${_bcEsc(p.name || `覆层预设${pi + 1}`)}" ${entry?.overlayMediaPresetName === p.name ? 'selected' : ''}>${_bcEsc(p.name || `覆层预设${pi + 1}`)}</option>`).join('')}
                    </select>
                </div>
                <div class="bc-group-field-item">
                    <label>🎯 替换哪个覆层媒体</label>
                    <select class="bc-group-overlay-slot" data-group="${_bcEsc(group.key)}" style="width:100%;" ${mediaLayers.length ? '' : 'disabled'}>
                        ${mediaLayers.length ? mediaLayers.map(({ ov, i }, n) => {
                            const value = ov.slotKey || i;
                            const label = ov.slotLabel || window.ReelsLayerSlots?.describe?.(ov.slotKey)?.label || `第 ${i + 1} 层`;
                            return `<option value="${_bcEsc(value)}" ${String(entry?.overlayMediaSlot) === String(value) || (entry?.overlayMediaSlot == null && n === 0) ? 'selected' : ''}>${_bcEsc(label)} · ${_bcEsc(ov.name || (ov.type === 'video' ? '视频媒体' : '图片媒体'))}</option>`;
                        }).join('') : '<option>模板尚无图片/视频覆层</option>'}
                    </select>
                </div>
            </div>
            ${entry?.backgroundMode === 'selected-cycle' ? `<div style="margin-top:6px;display:flex;align-items:center;gap:7px;padding:6px 8px;border-radius:5px;background:rgba(124,92,255,.07);border:1px solid rgba(124,92,255,.22);"><button class="bc-select-background-files bc-btn bc-btn-purple bc-btn-xs" data-group="${_bcEsc(group.key)}">🖼 选择素材 / 预览</button><span style="font-size:10px;color:#c4b5fd;">已选 ${(entry.selectedBackgroundFiles || []).length} 个；仅使用这些素材循环</span></div>` : ''}
            ${assigned ? `
            <div style="margin-top:7px;">
                <button class="bc-preview-group" data-group="${_bcEsc(group.key)}">👁 预览 / 换模板、背景与配乐</button>
                <button class="bc-viral-group-save bc-btn bc-btn-amber bc-btn-xs" data-group="${_bcEsc(group.key)}" title="把当前这个任务组完整保存为独立的爆帖工程组合，不影响原有预设">🔥 保存为爆帖工程组合</button>
                <details class="bc-group-details">
                    <summary class="bc-group-summary">⚙️ 自定义字段匹配</summary>
                    <div style="display:flex;flex-direction:column;gap:4px;margin-top:5px;">
                    ${_bcFieldsFromTask(assigned.task).map(field => {
                        const boundColIndex = assigned.bindings[field.key];
                        const boundColName = boundColIndex != null && boundColIndex >= 0 ? cols[boundColIndex]?.name : '';
                        return `<div style="display:flex;align-items:center;gap:8px;padding:3px 6px;border-radius:5px;background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.05);">
                            <span style="color:#cbd5e1;width:115px;min-width:115px;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10.5px;font-weight:500;" title="${_bcEsc(field.label)}">${_bcEsc(field.label)}</span>
                            <select class="bc-group-field" data-group="${_bcEsc(group.key)}" data-field="${_bcEsc(field.key)}" style="min-width:0;flex:1;height:24px;font-size:10.5px;" title="${_bcEsc(boundColName ? `${field.label} → ${boundColName}` : `${field.label}：不绑定`)}">
                                <option value="-1">不绑定 · 用模板默认</option>
                                ${cols.map((col, ci) => _bcFieldAcceptsColumn(field, col) ? `<option value="${ci}" ${boundColIndex === ci ? 'selected' : ''}>${_bcEsc(col.name)}</option>` : '').join('')}
                            </select>
                        </div>`;
                    }).join('')}
                    </div>
                </details>
            </div>` : ''}
        </div>`;
                });
                return gHtml;
            })()}
        ` : ''}
    </div>`;

    // Stats
    const rc = _bulkState.rows.filter(r=>r.some(c=>(c||'').trim())).length;
    const tc = assignments ? usage.reduce((sum, count) => sum + count, 0) : _bulkState.templates.length;
    html += `<div style="margin-top:8px;padding:8px;background:rgba(124,92,255,0.08);border:1px solid rgba(124,92,255,0.2);border-radius:6px;font-size:11px;color:#c4b5fd;text-align:center;">
        ${rc} 行 × ${tc} ${assignments ? '个已分配编号组' : '模板'} = <strong style="color:#fff;font-size:12px;">最多 ${rc*tc} 个任务</strong></div>`;
    el.innerHTML = `<div id="bc-media-missing-summary" role="status" style="display:none;margin-bottom:10px;padding:8px;border:1px solid rgba(248,113,113,.5);border-radius:6px;background:rgba(239,68,68,.10);color:#fca5a5;font-size:11px;line-height:1.5;"></div>` + html;
    _bcScheduleMediaPathCheck();
    if (prevScroll != null) el.scrollTop = prevScroll;

    // Asynchronously render thumbnails
    _bulkState.templates.forEach((tpl, ti) => {
        const task = tpl.task;
        if (typeof PresetThumbRenderer !== 'undefined' && task.overlays && task.overlays.length > 0) {
            _bcRenderTemplateThumb(task.overlays).then(dataUrl => {
                const img = document.getElementById(`bc-bind-thumb-${ti}`);
                const loader = document.getElementById(`bc-bind-thumb-loader-${ti}`);
                if (img && loader && dataUrl) {
                    img.src = dataUrl;
                    img.style.display = 'block';
                    loader.style.display = 'none';
                } else if (loader) {
                    loader.innerText = '暂无';
                }
            }).catch(e => {
                const loader = document.getElementById(`bc-bind-thumb-loader-${ti}`);
                if (loader) loader.innerText = '错误';
            });
        } else {
            const loader = document.getElementById(`bc-bind-thumb-loader-${ti}`);
            if (loader) loader.innerText = '无覆层';
        }
    });
    _bcScheduleDraftSave();
}

// ── Pick templates: show source chooser ──
function _bcPickTemplates() {
    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:300000;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;';
    modal.innerHTML = `<div style="background:#1a1a2e;border:1px solid #333;border-radius:12px;width:380px;padding:24px;text-align:center;">
        <div style="font-size:14px;font-weight:600;color:#fff;margin-bottom:16px;">选择模板来源</div>
        <div style="display:flex;flex-direction:column;gap:10px;">
            <button id="bc-src-project" style="padding:12px;background:linear-gradient(135deg,#7c5cff,#a855f7);border:none;border-radius:8px;color:#fff;cursor:pointer;font-size:13px;font-weight:600;">📦 模版工程库<br><span style="font-size:10px;font-weight:normal;opacity:0.8;">从已保存的 .json 工程文件读取完整任务</span></button>
            <button id="bc-src-preset" style="padding:12px;background:rgba(255,255,255,0.08);border:1px solid #444;border-radius:8px;color:#ccc;cursor:pointer;font-size:13px;">🎨 覆层预设库<br><span style="font-size:10px;opacity:0.6;">从覆层样式预设中选取（仅覆层）</span></button>
            <button id="bc-src-tasks" style="padding:12px;background:rgba(255,255,255,0.08);border:1px solid #333;border-radius:8px;color:#ccc;cursor:pointer;font-size:13px;">📋 当前任务<br><span style="font-size:10px;opacity:0.6;">使用当前标签页的任务作为模板</span></button>
            <button id="bc-src-cancel" style="padding:8px;background:transparent;border:1px solid #333;border-radius:8px;color:#888;cursor:pointer;font-size:11px;">取消</button>
        </div>
    </div>`;
    document.body.appendChild(modal);
    modal.querySelector('#bc-src-cancel').onclick = () => modal.remove();
    modal.querySelector('#bc-src-project').onclick = () => { modal.remove(); _bcPickFromProjectLib(); };
    modal.querySelector('#bc-src-preset').onclick = () => { modal.remove(); _bcPickFromOverlayPresets(); };
    modal.querySelector('#bc-src-tasks').onclick = () => { modal.remove(); _bcPickFromCurrentTasks(); };
}

// ══════════ 1. 模版工程库 — 从磁盘 .json 工程文件读取 ══════════
// ══════════ 1. 模版工程库 — 直接调用完整的视频模板库 ══════════
async function _bcPickFromProjectLib() {
    if (typeof openTemplateLibrary === 'function') {
        const disabledIds = Array.from(_bcTemplateProjectIdsInUse());
        openTemplateLibrary((tplData) => {
            const tplId = tplData.id || tplData.templateId || '';
            if (_bcIsTemplateProjectInUse(tplId)) {
                alert(`模板工程「${tplData.name || tplId}」已经添加过，不能重复添加。`);
                return;
            }
            const projectData = tplData.projectData;
            if (!projectData || !projectData.tasks || projectData.tasks.length === 0) {
                alert('该模板不包含任何任务，无法导入为批量模板。');
                return;
            }
            
            // 不关闭模态框，允许用户继续选择其他模板
            // const modal = document.getElementById('template-library-modal');
            // if (modal) modal.style.display = 'none';

            // 把这个模板里的任务交给 _bcShowProjectTaskPicker 去选择
            // 或者，如果只有一个任务，直接添加？
            // 默认让用户选择哪个任务作为模版，保持和之前一样的灵活度
            const projName = tplData.name || '已选模板';
            const projectCycle = _bcCollectProjectBackgroundCycle(projectData);
            const projectSource = {
                type: 'template_project',
                templateId: tplId,
                templateName: projName,
            };
            
            if (projectData.tasks.length === 1) {
                // 如果只有一个任务，直接添加，跳过选择界面
                _bcAppendTemplates(projectData.tasks, projName, projectCycle, projectSource);
            } else {
                _bcShowProjectTaskPicker(projName, projectData.tasks, projectCycle, projectSource);
            }
        }, { disabledIds });
    } else {
        alert('未加载模板库模块 (openTemplateLibrary 未定义)');
    }
}

// Helper to append templates
function _bcAppendTemplates(tasksList, projName, projectCycle = null, projectSource = null) {
    if (!tasksList || tasksList.length === 0) return;
    
    // Safely deserialize tasks first if applyProjectData is available
    let safeTasks = _bcDeserializeProjectTasks({ version: '2.0.0', tasks: tasksList });

    safeTasks.forEach((t, idx) => {
        const clone = _bcCloneTemplateTask(t);
        const templateIndex = _bulkState.templates.length;
        const bgCycle = _bcResolveTemplateBgCycle(clone, projectCycle);
        _bulkState.templates.push({
            task: clone,
            label: clone.baseName || clone.fileName || `${projName}_模板${_bulkState.templates.length + 1}`,
            bindings: typeof _bcAutoBind === 'function' ? _bcAutoBind(clone, templateIndex) : {},
            bgCycle,
            source: projectSource?.templateId ? { ...projectSource, mode: 'task', taskIndex: idx } : null,
        });
    });
    
    if (typeof _bcRenderBindings === 'function') _bcRenderBindings();
    if (typeof _bcUpdateStats === 'function') _bcUpdateStats();
    if (typeof _bcScheduleDraftSave === 'function') _bcScheduleDraftSave();
}

function _bcShowProjectTaskPicker(projName, tasks, projectCycle = null, projectSource = null) {
    // Safely deserialize tasks first if applyProjectData is available (so thumbnails work and we save real objects)
    let safeTasks = _bcDeserializeProjectTasks({ version: '2.0.0', tasks });

    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:1000000;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;';

    modal.innerHTML = `<div style="background:#1a1a2e;border:1px solid #333;border-radius:12px;width:85%;max-width:900px;height:80vh;display:flex;flex-direction:column;box-shadow:0 10px 40px rgba(0,0,0,0.8);overflow:hidden;">
        <div style="padding:12px 16px;border-bottom:1px solid #333;display:flex;justify-content:space-between;align-items:center;flex-shrink:0;">
            <span style="color:#fff;font-weight:600;font-size:14px;">📦 ${_bcEsc(projName)} — 选择任务作为模板</span>
            <div style="display:flex;gap:6px;">
                <button id="bc-proj-unified" style="padding:4px 12px;background:rgba(16,185,129,0.2);border:1px solid rgba(16,185,129,0.3);border-radius:5px;color:#10b981;cursor:pointer;font-size:11px;" title="仅使用该工程的第一个任务作为统一模版导入，忽略多任务拆分">✨ 作为统一模板导入</button>
                <div style="width:1px;background:#333;margin:0 4px;"></div>
                <button id="bc-proj-all" style="padding:4px 12px;background:rgba(124,92,255,0.2);border:1px solid rgba(124,92,255,0.3);border-radius:5px;color:#b8a0ff;cursor:pointer;font-size:11px;">全选</button>
                <button id="bc-proj-none" style="padding:4px 12px;background:rgba(255,255,255,0.05);border:1px solid #333;border-radius:5px;color:#888;cursor:pointer;font-size:11px;">全不选</button>
                <button id="bc-proj-ok" style="padding:4px 16px;background:linear-gradient(135deg,#7c5cff,#a855f7);border:none;border-radius:5px;color:#fff;cursor:pointer;font-size:11px;font-weight:600;">✓ 确定所选</button>
                <button id="bc-proj-cancel" style="padding:4px 12px;background:rgba(255,255,255,0.05);border:1px solid #333;border-radius:5px;color:#888;cursor:pointer;font-size:11px;">取消</button>
            </div>
        </div>
        <div id="bc-proj-grid" style="overflow:auto;flex:1;padding:16px;display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;align-content:start;"></div>
    </div>`;
    document.body.appendChild(modal);

    const grid = modal.querySelector('#bc-proj-grid');

    // Unified mode
    modal.querySelector('#bc-proj-unified').onclick = () => {
        modal.remove();
        
        // 统一模板代表整个工程，因此使用该工程素材库；没有素材库时再从工程任务中收集。
        const bgCycle = [];
        (projectCycle || []).forEach(p => _bcAddUniqueCyclePath(bgCycle, p));
        if (bgCycle.length === 0) {
            safeTasks.forEach(t => {
                _bcCollectTaskBackgroundCycle(t).forEach(p => _bcAddUniqueCyclePath(bgCycle, p));
            });
        }

        const t0 = safeTasks[0];
        if (!t0) return;
        const clone = _bcCloneTemplateTask(t0);
        const templateIndex = _bulkState.templates.length;
        
        _bulkState.templates.push({
            task: clone,
            label: `${projName}_统一模式`,
            bindings: typeof _bcAutoBind === 'function' ? _bcAutoBind(clone, templateIndex) : {},
            bgCycle: bgCycle.length > 1 ? bgCycle : null,
            source: projectSource?.templateId ? { ...projectSource, mode: 'unified' } : null,
        });
        
        if (typeof _bcRenderBindings === 'function') _bcRenderBindings();
        if (typeof _bcUpdateStats === 'function') _bcUpdateStats();
        if (typeof _bcScheduleDraftSave === 'function') _bcScheduleDraftSave();
    };

    // Build cards
    safeTasks.forEach((t, i) => {
        const bg = (t.bgPath || t.videoPath || '').split(/[/\\]/).pop() || '';
        const ovCount = (t.overlays || []).length;
        const name = t.baseName || t.fileName || `task_${i + 1}`;

        const card = document.createElement('div');
        card.style.cssText = 'background:#0d0d1a;border:2px solid #333;border-radius:8px;overflow:hidden;cursor:pointer;transition:border-color 0.2s,box-shadow 0.2s;';
        card.dataset.idx = i;
        card.dataset.selected = 'true';
        card.classList.add('bc-proj-card');

        card.innerHTML = `
            <div class="bc-proj-thumb" style="width:100%;aspect-ratio:9/16;background:#141424;display:flex;align-items:center;justify-content:center;overflow:hidden;position:relative;">
                <div style="color:#555;font-size:10px;">加载中...</div>
                <div style="position:absolute;top:6px;right:6px;width:18px;height:18px;border-radius:4px;background:rgba(124,92,255,0.9);display:flex;align-items:center;justify-content:center;font-size:12px;color:#fff;">✓</div>
            </div>
            <div style="padding:8px;">
                <div style="color:#eee;font-size:11px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${_bcEsc(name)}">${_bcEsc(name)}</div>
                <div style="display:flex;gap:4px;margin-top:4px;flex-wrap:wrap;">
                    <span style="font-size:9px;padding:1px 5px;background:rgba(124,92,255,0.15);border-radius:3px;color:#b8a0ff;">${ovCount} 层</span>
                    ${bg ? `<span style="font-size:9px;padding:1px 5px;background:rgba(0,212,255,0.1);border-radius:3px;color:#7dd;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100px;" title="${_bcEsc(bg)}">${_bcEsc(bg)}</span>` : ''}
                </div>
            </div>`;

        // Toggle selection
        card.onclick = () => {
            const sel = card.dataset.selected === 'true';
            card.dataset.selected = sel ? 'false' : 'true';
            card.style.borderColor = sel ? '#333' : '#7c5cff';
            card.style.boxShadow = sel ? 'none' : '0 0 0 1px rgba(124,92,255,0.4)';
            const check = card.querySelector('div[style*="position:absolute"]');
            if (check) check.style.display = sel ? 'none' : 'flex';
        };
        // Init as selected
        card.style.borderColor = '#7c5cff';
        card.style.boxShadow = '0 0 0 1px rgba(124,92,255,0.4)';

        grid.appendChild(card);

        // Render thumbnail async
        if (ovCount > 0 && typeof PresetThumbRenderer !== 'undefined') {
            try {
                _bcRenderTemplateThumb(t.overlays).then(url => {
                    const thumbEl = card.querySelector('.bc-proj-thumb');
                    if (url && thumbEl) {
                        thumbEl.innerHTML = `<img crossorigin="anonymous" src="${url}" style="width:100%;height:100%;object-fit:cover;">
                            <div style="position:absolute;top:6px;right:6px;width:18px;height:18px;border-radius:4px;background:rgba(124,92,255,0.9);display:flex;align-items:center;justify-content:center;font-size:12px;color:#fff;">✓</div>`;
                    } else if (thumbEl) {
                        thumbEl.querySelector('div').textContent = '预览生成失败';
                    }
                }).catch(e => {
                    console.error('[BulkCreate] Thumbnail render error:', e);
                    const thumbEl = card.querySelector('.bc-proj-thumb');
                    if (thumbEl) thumbEl.querySelector('div').textContent = '渲染错误';
                });
            } catch(e) {
                console.error('[BulkCreate] Thumbnail init error:', e);
                const thumbEl = card.querySelector('.bc-proj-thumb');
                if (thumbEl) thumbEl.querySelector('div').textContent = '组件错误';
            }
        } else {
            const thumbEl = card.querySelector('.bc-proj-thumb');
            if (thumbEl) thumbEl.querySelector('div').textContent = bg ? `🎬 ${bg}` : '无覆层';
        }
    });

    // Buttons
    modal.querySelector('#bc-proj-cancel').onclick = () => modal.remove();
    modal.querySelector('#bc-proj-all').onclick = () => {
        modal.querySelectorAll('.bc-proj-card').forEach(c => {
            c.dataset.selected = 'true';
            c.style.borderColor = '#7c5cff';
            c.style.boxShadow = '0 0 0 1px rgba(124,92,255,0.4)';
            const check = c.querySelector('div[style*="position:absolute"]');
            if (check) check.style.display = 'flex';
        });
    };
    modal.querySelector('#bc-proj-none').onclick = () => {
        modal.querySelectorAll('.bc-proj-card').forEach(c => {
            c.dataset.selected = 'false';
            c.style.borderColor = '#333';
            c.style.boxShadow = 'none';
            const check = c.querySelector('div[style*="position:absolute"]');
            if (check) check.style.display = 'none';
        });
    };
    modal.querySelector('#bc-proj-ok').onclick = () => {
        const selected = Array.from(modal.querySelectorAll('.bc-proj-card[data-selected="true"]'));
        if (selected.length === 0) { alert('请至少选择一个任务'); return; }

        selected.forEach(card => {
            const t = safeTasks[parseInt(card.dataset.idx)];
            if (!t) return;
            const taskIndex = parseInt(card.dataset.idx);
            const clone = _bcCloneTemplateTask(t);
            const templateIndex = _bulkState.templates.length;
            const bgCycle = _bcResolveTemplateBgCycle(clone, projectCycle);
            _bulkState.templates.push({
                task: clone,
                label: clone.baseName || clone.fileName || `${projName}_模板${_bulkState.templates.length + 1}`,
                bindings: _bcAutoBind(clone, templateIndex),
                bgCycle,
                source: projectSource?.templateId ? { ...projectSource, mode: 'task', taskIndex } : null,
            });
        });
        modal.remove();
        _bcRenderBindings();
        if (typeof _bcScheduleDraftSave === 'function') _bcScheduleDraftSave();
    };
}


// ══════════ 2. 覆层预设库 ══════════
function _bcPickFromOverlayPresets() {
    const state = window._reelsState;
    const panel = state?.overlayPanel;
    if (panel && typeof panel._showPresetGallery === 'function') {
        const existingNames = (_bulkState.templates || []).map(t => t.label || t.task?.baseName).filter(Boolean);
        panel._showPresetGallery((name, data, mode) => {
            // 多选确认时图库会一次传回预设数组；集中写入后只重绘一次。
            if (Array.isArray(name)) {
                _bcAddPresetsAsTemplates(name);
                return;
            }
            _bcAddPresetAsTemplate(name, data);
        }, true, 'all', { existingNames });
    } else {
        _bcPickFromPresetsDirectly();
    }
}

function _bcPickFromPresetsDirectly() {
    let presets = {};
    try { presets = JSON.parse(localStorage.getItem('reels_overlay_group_presets') || '{}'); } catch(e) {}
    if (window.REELS_BUILTIN_OVERLAY_GROUP_PRESETS) {
        for (const [k, v] of Object.entries(window.REELS_BUILTIN_OVERLAY_GROUP_PRESETS)) {
            if (!presets[k]) presets[k] = v;
        }
    }
    const names = Object.keys(presets);
    if (names.length === 0) { alert('覆层预设库为空'); return; }

    const existingNames = new Set((_bulkState.templates || []).map(t => t.label || t.task?.baseName).filter(Boolean));
    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:300000;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;';
    let list = names.map(n => {
        const d = presets[n];
        const layers = Array.isArray(d) ? d : (d.layers || []);
        const isAdded = existingNames.has(n);
        return `<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;border-bottom:1px solid #222;">
            <div style="flex:1;">
                <div style="color:#eee;font-size:12px;font-weight:600;display:flex;align-items:center;gap:6px;">
                    ${_bcEsc(n)}
                    ${isAdded ? '<span style="font-size:9.5px;padding:1px 5px;border-radius:3px;background:rgba(16,185,129,0.2);color:#34d399;border:1px solid rgba(16,185,129,0.4);">已添加</span>' : ''}
                </div>
                <div style="color:#666;font-size:10px;">${layers.length} 层</div>
            </div>
            <button class="bc-gallery-pick" data-name="${_bcEsc(n)}" style="padding:3px 10px;background:${isAdded ? 'rgba(16,185,129,0.2)' : 'rgba(124,92,255,0.2)'};border:1px solid ${isAdded ? 'rgba(16,185,129,0.4)' : 'rgba(124,92,255,0.3)'};border-radius:4px;color:${isAdded ? '#6ee7b7' : '#b8a0ff'};cursor:pointer;font-size:10px;">${isAdded ? '已在库中' : '选用'}</button>
        </div>`;
    }).join('');
    modal.innerHTML = `<div style="background:#1a1a2e;border:1px solid #333;border-radius:10px;width:420px;max-height:60vh;display:flex;flex-direction:column;">
        <div style="padding:12px 16px;border-bottom:1px solid #333;display:flex;justify-content:space-between;align-items:center;">
            <span style="color:#fff;font-weight:600;">🎨 覆层预设库</span>
            <button class="bc-gallery-close" style="padding:3px 10px;background:rgba(255,255,255,0.05);border:1px solid #333;border-radius:5px;color:#888;cursor:pointer;font-size:11px;">关闭</button>
        </div>
        <div style="overflow:auto;flex:1;">${list}</div>
    </div>`;
    document.body.appendChild(modal);
    modal.querySelector('.bc-gallery-close').onclick = () => modal.remove();
    modal.addEventListener('click', e => {
        if (e.target.classList.contains('bc-gallery-pick')) {
            const name = e.target.dataset.name;
            _bcAddPresetAsTemplate(name, presets[name]);
            modal.remove();
        }
    });
}

function _bcAddPresetAsTemplate(name, data) {
    _bcAddPresetsAsTemplates([{ name, data }]);
}

// 多个覆层预设一起加入大量建立的模板库。此前每点一个都重绘完整面板，
// 预设较多时会明显卡顿。
function _bcAddPresetsAsTemplates(items) {
    const validItems = (items || []).filter(item => item?.name && item?.data);
    if (!validItems.length) return;
    validItems.forEach(({ name, data }) => {
        const layers = Array.isArray(data) ? data : (data.layers || []);
        const task = {
            baseName: name,
            fileName: `${name}.mp4`,
            bgPath: null, bgSrcUrl: null,
            audioPath: null, srtPath: null,
            segments: [],
            videoPath: null, srcUrl: null,
            overlays: JSON.parse(JSON.stringify(layers)),
            ttsText: '', ttsVoiceId: '', pipPath: '', status: '',
        };
        _bulkState.templates.push({
            task,
            label: name,
            bindings: _bcAutoBind(task, _bulkState.templates.length),
        });
    });
    _bcRenderBindings();
    if (typeof _bcScheduleDraftSave === 'function') _bcScheduleDraftSave();
    if (validItems.length > 1 && typeof showToast === 'function') {
        showToast(`已一次添加 ${validItems.length} 个覆层预设到模板库`, 'success');
    } else if (validItems.length === 1 && typeof showToast === 'function') {
        showToast(`已添加「${validItems[0].name}」到模板库`, 'success');
    }
}

// ── Pick from current tasks ──
function _bcPickFromCurrentTasks() {
    const state = window._reelsState;
    if (!state || !state.tasks || state.tasks.length === 0) { alert('当前没有任务可作为模板'); return; }
    const tasks = state.tasks;
    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:300000;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;';
    let list = '';
    tasks.forEach((t,i) => {
        const bg = (t.bgPath||t.videoPath||'').split(/[/\\]/).pop()||'无';
        const ovCount = (t.overlays||[]).length;
        list += `<label style="display:flex;align-items:center;gap:6px;padding:6px 8px;border-bottom:1px solid #222;cursor:pointer;">
            <input type="checkbox" class="bc-pick-cb" data-idx="${i}">
            <span style="color:#ccc;font-size:12px;">${i+1}. ${_bcEsc(t.baseName||t.fileName||'task')}</span>
            <span style="color:#666;font-size:10px;">bg:${_bcEsc(bg)} | ${ovCount}层</span>
        </label>`;
    });
    modal.innerHTML = `<div style="background:#1a1a2e;border:1px solid #333;border-radius:10px;width:500px;max-height:70vh;display:flex;flex-direction:column;">
        <div style="padding:12px 16px;border-bottom:1px solid #333;display:flex;justify-content:space-between;align-items:center;">
            <span style="color:#fff;font-weight:600;">选择工程任务作为模板</span>
            <div style="display:flex;gap:6px;">
                <button id="bc-pick-all" style="padding:3px 10px;background:rgba(124,92,255,0.2);border:1px solid rgba(124,92,255,0.3);border-radius:5px;color:#b8a0ff;cursor:pointer;font-size:11px;">全选</button>
                <button id="bc-pick-ok" style="padding:3px 14px;background:linear-gradient(135deg,#7c5cff,#a855f7);border:none;border-radius:5px;color:#fff;cursor:pointer;font-size:11px;font-weight:600;">确定</button>
                <button id="bc-pick-cancel" style="padding:3px 10px;background:rgba(255,255,255,0.05);border:1px solid #333;border-radius:5px;color:#888;cursor:pointer;font-size:11px;">取消</button>
            </div>
        </div>
        <div style="overflow:auto;flex:1;">${list}</div>
    </div>`;
    document.body.appendChild(modal);
    modal.querySelector('#bc-pick-cancel').onclick = () => modal.remove();
    modal.querySelector('#bc-pick-all').onclick = () => modal.querySelectorAll('.bc-pick-cb').forEach(cb => cb.checked = true);
    modal.querySelector('#bc-pick-ok').onclick = () => {
        const checked = Array.from(modal.querySelectorAll('.bc-pick-cb:checked'));
        checked.forEach(cb => {
            const idx = parseInt(cb.dataset.idx);
            const t = tasks[idx];
            if (!t) return;
            const clone = JSON.parse(JSON.stringify(t));
            delete clone._video; delete clone._bgThumb;
            if (clone.bgSrcUrl && String(clone.bgSrcUrl).startsWith('blob:')) clone.bgSrcUrl = null;
            if (clone.srcUrl && String(clone.srcUrl).startsWith('blob:')) clone.srcUrl = null;
            const templateIndex = _bulkState.templates.length;
            _bulkState.templates.push({
                task: clone,
                label: clone.baseName || clone.fileName || `模板${_bulkState.templates.length+1}`,
                bindings: _bcAutoBind(clone, templateIndex),
            });
        });
        modal.remove();
        _bcRenderBindings();
        if (typeof _bcScheduleDraftSave === 'function') _bcScheduleDraftSave();
    };
}

function _bcRowHasBoundData(tpl, row) {
    let hasData = false;
    let hasBindings = false;
    for (const key of Object.keys(tpl.bindings || {})) {
        const ci = tpl.bindings[key];
        if (ci != null && ci >= 0) {
            hasBindings = true;
            if ((row[ci] || '').trim() !== '') {
                hasData = true;
                break;
            }
        }
    }
    return !hasBindings || hasData;
}

// 保留绑定只为之后恢复表头服务。预览、生成和随机分配都必须确认这些
// 绑定仍属于当前组且相应列标题仍存在，不能仅凭行中旧位置有文字就使用。
function _bcGroupHasUsableHeaders(group, tpl) {
    if (!group?.columns?.length) return false;
    const groupColumnIndexes = new Set(group.columns.map(column => Number(column.ci)));
    const boundIndexes = Object.values(tpl?.bindings || {})
        .map(value => Number(value))
        .filter(Number.isInteger);
    if (!boundIndexes.length) return false;
    return boundIndexes.every(ci => groupColumnIndexes.has(ci)
        && String(_bulkState.columns?.[ci]?.name || '').trim());
}

function _bcBuildTasksForTemplate(tpl, rows, cols, startTaskNum) {
    const tasks = [];
    rows.forEach((row, ri) => {
        if (!_bcRowHasBoundData(tpl, row)) return;
        const task = _bcBuildTask(tpl, row, ri, startTaskNum + tasks.length, cols);
        tasks.push(task);
    });
    return tasks;
}

// ── Generate tasks ──
function _bcGenerateTasks() {
    _bcNormalizeStateShape();
    const state = window._reelsState;
    if (!state) { alert('系统未初始化'); return 0; }
    const cols = _bulkState.columns;
    const rowEntries = _bulkState.rows.map((row, index) => ({ row, index })).filter(({ row }) => row.some(c => String(c || '').trim()));
    const rows = rowEntries.map(entry => entry.row);
    if (rows.length === 0) { alert('数据表格为空'); return 0; }
    if (_bulkState.templates.length === 0) { alert('请先添加模板'); return 0; }

    const total = rows.length * _bulkState.templates.length;

    // 明确的生成方式：group_apply (生成任务组并合并应用到外面分组显示)、separate (仅分标签页保存)、current (全部平铺放入当前标签)
    const outputMode = document.getElementById('bc-output-mode')?.value || 'group_apply';

    _bcWarnAllDuplicateTextBindings();

    // ═══ 生成前绑定摘要 ═══
    console.log('═══ [BulkCreate] 生成前绑定摘要 ═══');
    const bindingSummaries = _bulkState.templates.map((tpl, ti) => {
        const fields = _bcFieldsFromTask(tpl.task);
        const summary = {};
        fields.forEach(f => {
            const ci = tpl.bindings[f.key];
            if (ci != null && ci >= 0 && ci < cols.length) {
                summary[f.label] = `col[${ci}]「${cols[ci]?.name}」`;
            }
        });
        console.log(`  模板[${ti}]「${tpl.label}」:`, JSON.stringify(summary, null, 2));
        return JSON.stringify(tpl.bindings);
    });
    // 检测是否有模板共享相同绑定
    const uniqueBindings = new Set(bindingSummaries);
    if (uniqueBindings.size < _bulkState.templates.length) {
        console.warn('[BulkCreate] ⚠️ 有多个模板使用了完全相同的列绑定！这将导致各标签页文案一致。');
    }

    // ═══ 统一生成循环：row × unit (编号组或模板) ═══
    const groups = _bcNumberedColumnGroups();
    const isGroupMode = !_bulkState.cellPresetMode && !_bulkState.rowPresetMode && !!(_bulkState.groupAssignments && _bulkState.groupAssignments.length > 0);
    let generationUnits = [];
    const skippedMissingHeaderGroups = [];
    if (isGroupMode) {
        generationUnits = _bulkState.groupAssignments.flatMap(entry => {
            const group = groups.find(g => g.key === entry.key);
            if (!group) return [];
            const multiple = Array.isArray(entry.presetTemplateIds);
            const ids = multiple ? entry.presetTemplateIds : [_bulkState.templates[entry.templateIndex]?.bulkTemplateId];
            return [...new Set(ids)].map(id => {
                const ti = _bulkState.templates.findIndex(tpl => tpl.bulkTemplateId === id);
                if (ti < 0) return null;
                const tpl = multiple ? _bcAssignedPresetTemplate(entry, group, id) : _bcAssignedTemplate(entry, group);
                if (!tpl || !_bcGroupHasUsableHeaders(group, tpl)) {
                    skippedMissingHeaderGroups.push(String(entry.key || '未命名任务组'));
                    return null;
                }
                return { key: entry.key, name: multiple && ids.length > 1 ? `${entry.key} · ${tpl.label}` : entry.key, tpl, ti, tasks: [] };
            }).filter(Boolean);
        });
    } else {
        generationUnits = _bulkState.templates.map((tpl, ti) => ({
            key: `tpl_${ti + 1}`,
            name: tpl.label || `模板${ti + 1}`,
            tpl,
            ti,
            tasks: [],
        }));
    }

    if (skippedMissingHeaderGroups.length && typeof showToast === 'function') {
        const preview = skippedMissingHeaderGroups.slice(0, 5).join('、');
        const extra = skippedMissingHeaderGroups.length > 5 ? ` 等 ${skippedMissingHeaderGroups.length} 组` : '';
        showToast(`⚠ 已跳过缺少表头的任务组：${preview}${extra}。请恢复表头后再生成。`, 'warning', 7000);
    }

    if (_bulkState.cellPresetMode) {
        generationUnits = cols.flatMap((column, ci) => column.type !== 'text' ? [] : _bulkState.templates.map((tpl, ti) => ({
            key: `copy_${ci}_tpl_${ti}`, name: column.name || '文案列' + (ci + 1), tpl, ti, copyColumn: ci, tasks: [],
        })).filter(unit => rowEntries.some(entry => String(entry.row[ci] || '').trim() && _bcCellUsesTemplate(entry.index, ci, unit.tpl))));
        if (!generationUnits.length) { alert('请先在文案单元格旁绑定预设；未选择的单元格不会生成。'); return 0; }
    } else if (_bulkState.rowPresetMode) {
        generationUnits = generationUnits.filter(unit => rowEntries.some(entry => _bcRowUsesTemplate(entry.index, unit.tpl)));
        if (!generationUnits.length) { alert('请先在文案行旁选择覆层预设；未选择的文案不会生成。'); return 0; }
    }
    const missingFolder = generationUnits.find(({ tpl }) => tpl.assignedBackgroundFolder
        && !_bulkState.backgroundFolders.find(folder => folder.path === tpl.assignedBackgroundFolder)?.files?.length);
    if (missingFolder) { alert('所选背景分类为空或已移除，请刷新文件夹或重新分配背景分类。'); return 0; }
    const missingOverlayFolder = generationUnits.find(({ tpl }) => tpl.assignedOverlayMediaFolder
        && !_bulkState.overlayMediaFolders.find(folder => folder.path === tpl.assignedOverlayMediaFolder)?.files?.length);
    if (missingOverlayFolder) { alert('所选覆层媒体文件夹为空或已移除，请重新分配覆层媒体。'); return 0; }
    const missingLogoSource = generationUnits.find(({ tpl }) => tpl.logoOverlay?.enabled && tpl.logoOverlay?.sourceId
        && !_bulkState.logoMediaLibrary.find(item => item.id === tpl.logoOverlay.sourceId)?.files?.length);
    if (missingLogoSource) { alert('所选 Logo 媒体不存在或为空，请重新分配 Logo 媒体。'); return 0; }

    const backgroundIndices = new Map();
    const tasksByTemplate = _bulkState.templates.map(() => []);
    // Shared across numbered groups so the “不重复” checkbox has the same
    // meaning for a whole bulk generation, rather than restarting per group.
    const randomMusicAllocator = _bcCreateRandomMusicAllocator();
    rows.forEach((row, ri) => {
        generationUnits.forEach(unit => {
            const { tpl, ti } = unit;
            if (_bulkState.cellPresetMode) {
                if (!String(row[unit.copyColumn] || '').trim() || !_bcCellUsesTemplate(rowEntries[ri].index, unit.copyColumn, tpl)) return;
            } else {
                if (!_bcRowUsesTemplate(rowEntries[ri].index, tpl)) return;
                if (!_bulkState.rowPresetMode && !_bcRowHasBoundData(tpl, row)) return;
            }
            const presetRowIdx = unit.tasks.length;
            // 编号组内独立计数，避免第 9 组显示 009、025、041 这类全局跳号。
            const taskGroupKey = _bulkState.cellPresetMode ? unit.name : isGroupMode ? unit.key : '';
            const task = _bcBuildTask(tpl, row, presetRowIdx, presetRowIdx + 1, cols, taskGroupKey, { copyColumn: unit.copyColumn });
            const backgroundIndex = backgroundIndices.get(tpl) || 0;
            _bcApplyAssignedBackground(task, tpl, backgroundIndex);
            _bcApplyAssignedMusic(task, tpl, presetRowIdx, randomMusicAllocator);
            _bcApplyAssignedOverlayMedia(task, tpl, presetRowIdx);
            _bcApplyGroupLogoOverlay(task, tpl, presetRowIdx);
            _bcRefreshCustomTaskName(task, tpl, presetRowIdx + 1, taskGroupKey);
            task._bulkCreatePresetName = tpl.label || '';
            task._bulkCreateGroupKey = taskGroupKey;
            backgroundIndices.set(tpl, backgroundIndex + 1);
            unit.tasks.push(task);
            if (tasksByTemplate[ti]) tasksByTemplate[ti].push(task);
        });
    });

    const activeUnits = generationUnits.filter(u => u.tasks.length > 0);
    const created = activeUnits.reduce((s, u) => s + u.tasks.length, 0);
    if (created === 0) return 0;

    const usedTaskNames = new Set();
    for (const task of activeUnits.flatMap(unit => unit.tasks)) {
        const original = task.baseName;
        let name = original;
        let number = 1;
        while (usedTaskNames.has(name)) name = `${original}_${String(number++).padStart(2, '0')}`;
        usedTaskNames.add(name);
        if (name !== original) {
            task.baseName = name;
            task.fileName = `${name}.mp4`;
            if (task.exportName === original) task.exportName = name;
        }
    }

    // 任务组名独立于任务行名：这里使用分配的背景文件夹，而不是某条任务
    // 循环到的具体视频名，避免组名随每一行变化。
    const taskGroupName = (unit) => {
        const group = String((isGroupMode ? unit?.key : unit?.name) || '未命名分组').trim() || '未命名分组';
        const folderPath = unit?.tpl?.assignedBackgroundFolder || '';
        const folder = (_bulkState.backgroundFolders || []).find(item => item.path === folderPath);
        const background = String(folder?.name || folderPath.split(/[/\\]/).filter(Boolean).pop() || '').trim();
        const mode = document.getElementById('bc-task-group-naming-mode')?.value || _bulkState.taskGroupNamingMode || 'group_bg';
        const custom = document.getElementById('bc-task-group-custom')?.value || _bulkState.taskGroupCustomPattern || '{任务组}_{背景}';
        const values = { '任务组': group, '背景': background, '模板': unit?.tpl?.label || '', '覆层预设': unit?.tpl?.label || '' };
        if (mode === 'group') return group;
        if (mode === 'bg_group') return background ? `${background}_${group}` : group;
        if (mode === 'custom') return _bcComposeName(custom, values, background ? `${group}_${background}` : group);
        return background ? `${group}_${background}` : group;
    };

    // 同一原始组的多个覆层预设输出到同一任务组。
    if (isGroupMode) {
        const grouped = new Map();
        for (const unit of activeUnits) {
            const key = JSON.stringify([unit.key, taskGroupName(unit)]);
            const existing = grouped.get(key);
            if (existing) existing.tasks.push(...unit.tasks);
            else grouped.set(key, { ...unit, tasks: [...unit.tasks] });
        }
        activeUnits.splice(0, activeUnits.length, ...grouped.values());
    }

    const srtErrors = activeUnits.flatMap(u => u.tasks).filter(task => task?._bulkCreateSrtError);
    if (srtErrors.length > 0) {
        const preview = srtErrors.slice(0, 5).map(task => `${task.fileName}: ${task._bulkCreateSrtError}`).join('\n');
        const remaining = srtErrors.length > 5 ? `\n另有 ${srtErrors.length - 5} 条` : '';
        alert(`有 ${srtErrors.length} 条任务的 SRT 无法读取或解析，已自动取消这些任务的导出勾选：\n\n${preview}${remaining}`);
    }

    const usedGroupNames = new Set(typeof _batchTableState !== 'undefined'
        ? (_batchTableState.tabs || []).map(tab => tab.name) : []);
    const uniqueGroupName = unit => {
        const base = taskGroupName(unit);
        let name = base;
        let number = 1;
        while (usedGroupNames.has(name)) name = `${base}_${String(number++).padStart(2, '0')}`;
        usedGroupNames.add(name);
        return name;
    };

    // ═══ 输出：根据模式放到不同容器 ═══
    if (outputMode === 'group_apply' && typeof _batchTableState !== 'undefined') {
        // ★ 生成任务组并合并应用到外部分组显示（推荐模式）
        if (typeof _syncTasksToActiveTab === 'function' && typeof _isBatchGroupedProjection === 'function' && !_isBatchGroupedProjection(state.tasks)) {
            _syncTasksToActiveTab();
        }

        const newTabs = [];
        activeUnits.forEach(unit => {
            const tabId = 'tab_' + _batchTableState.nextTabId++;
            const tabName = uniqueGroupName(unit);
            const clonedTasks = typeof _cloneBatchTasks === 'function'
                ? _cloneBatchTasks(unit.tasks)
                : JSON.parse(JSON.stringify(unit.tasks));
            const newTab = {
                id: tabId,
                name: tabName,
                materialDir: '',
                lastRefreshTime: null,
                tasks: clonedTasks,
            };
            _batchTableState.tabs.push(newTab);
            newTabs.push(newTab);
        });

        // 建立按任务组投影到外部队列：使外部列表直接按任务组分组折叠显示
        // 若生成前主队列中已有非投影任务，自动保留在最顶部作为「已有任务」，避免旧任务被清空覆盖
        const existingNonBatchTasks = (Array.isArray(state.tasks) ? state.tasks : []).filter(t => !t._batchProjection);
        const mergedTasks = existingNonBatchTasks.length > 0 ? [...existingNonBatchTasks] : [];
        const appliedTabIds = [];
        newTabs.forEach((tab, tabOrder) => {
            appliedTabIds.push(tab.id);
            (tab.tasks || []).forEach((t, taskOrder) => {
                const cloned = typeof _cloneBatchTasks === 'function'
                    ? _cloneBatchTasks([t])[0]
                    : JSON.parse(JSON.stringify(t));
                if (cloned) {
                    if (typeof _ensureTaskId === 'function') _ensureTaskId(cloned);
                    cloned._batchProjection = true;
                    cloned._batchTabId = tab.id;
                    cloned._batchTabName = tab.name;
                    cloned._batchTabOrder = tabOrder;
                    cloned._batchTaskOrder = taskOrder;
                    mergedTasks.push(cloned);
                }
            });
        });

        _batchTableState.appliedTabIds = appliedTabIds;
        state.tasks = mergedTasks;
        state.selectedIdx = -1;
        if (newTabs[0]) {
            _batchTableState.activeTabId = newTabs[0].id;
        }

        console.log(`[BulkCreate] ✅ 已生成 ${newTabs.length} 个任务组，共 ${mergedTasks.length} 条任务，已合并应用到外部队列`);
    } else if (outputMode === 'separate' && typeof _batchTableState !== 'undefined') {
        // 分标签页模式：仅存入独立标签，外部默认切换至第1个标签
        if (typeof _syncTasksToActiveTab === 'function' && typeof _isBatchGroupedProjection === 'function' && !_isBatchGroupedProjection(state.tasks)) {
            _syncTasksToActiveTab();
        }

        const newTabs = [];
        activeUnits.forEach(unit => {
            const tabId = 'tab_' + _batchTableState.nextTabId++;
            const tabName = uniqueGroupName(unit);
            const clonedTasks = typeof _cloneBatchTasks === 'function'
                ? _cloneBatchTasks(unit.tasks)
                : JSON.parse(JSON.stringify(unit.tasks));
            const newTab = {
                id: tabId,
                name: tabName,
                materialDir: '',
                lastRefreshTime: null,
                tasks: clonedTasks,
            };
            _batchTableState.tabs.push(newTab);
            newTabs.push(newTab);
        });

        const firstNewTab = newTabs[0];
        if (firstNewTab) {
            if (typeof _switchToTab === 'function') {
                _switchToTab(firstNewTab.id, { skipSave: true, skipNextApply: true, skipNextAutoSave: true });
            } else {
                _batchTableState.activeTabId = firstNewTab.id;
                state.tasks = typeof _cloneBatchTasks === 'function'
                    ? _cloneBatchTasks(firstNewTab.tasks || [])
                    : JSON.parse(JSON.stringify(firstNewTab.tasks || []));
                state.selectedIdx = -1;
            }
        }
    } else {
        // 单标签模式或无 _batchTableState 环境
        state.tasks.length = 0;
        const allTasks = typeof _batchTableState === 'undefined'
            ? tasksByTemplate.flat()
            : activeUnits.flatMap(u => u.tasks);
        allTasks.forEach(task => state.tasks.push(task));
    }

    // 任务已整体替换；下一次表格重绘不能把旧行输入框回写到新任务。
    if (typeof _skipNextApply !== 'undefined') _skipNextApply = true;
    return created;
}

// 自定义命名使用固定占位符，避免将用户输入当作脚本或正则执行。
function _bcComposeName(pattern, values, fallback) {
    const safe = value => String(value || '').replace(/[\\/:*?"<>|]/g, '_').trim();
    let result = String(pattern || '').replace(/\{(任务组|背景|模板|序号|日期|标题|正文|内容|Logo|配乐)\}/g, (_all, key) => safe(values[key]));
    result = result.replace(/[_\-\s]{2,}/g, match => match.includes('_') ? '_' : match.trim() ? match : '_')
        .replace(/^[_\-\s]+|[_\-\s]+$/g, '');
    return result || safe(fallback) || 'bulk';
}

function _bcMediaStem(path) {
    return _bcFileName(path || '').replace(/\.[^.]+$/, '').trim();
}

function _bcLocalDateStamp() {
    const now = new Date();
    const two = value => String(value).padStart(2, '0');
    return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
}

// 在每条任务的素材、文字绑定均完成后重算自定义名称，确保素材字段取到
// 最终分配结果，而不是模板中的旧素材。
function _bcRefreshCustomTaskName(task, tpl, taskNum, groupKey) {
    const mode = (typeof document !== 'undefined' && document.getElementById('bc-task-naming-mode')?.value)
        || _bulkState.taskNamingMode || 'custom';
    const previousBase = task.baseName || '';
    const padNum = String(taskNum).padStart(3, '0');
    const safe = value => String(value || '').replace(/[\\/:*?"<>|]/g, '_').trim();
    const safeGroup = safe(groupKey);
    const backgroundFolder = (_bulkState.backgroundFolders || []).find(folder =>
        Array.isArray(folder.files) && folder.files.includes(task.bgPath || task.videoPath));
    const safeBg = safe(backgroundFolder?.name || '');
    const safeTpl = safe(tpl?.label || 'bulk');
    const overlays = Array.isArray(task.overlays) ? task.overlays : [];
    const titleLayer = overlays.find(ov => ov?.title_text || ov?.type === 'textcard') || overlays.find(ov => ov?.type === 'text');
    const bodyLayer = overlays.find(ov => ov?.body_text || ov?.type === 'scroll') || titleLayer;
    const logoLayer = overlays.find(ov => ov?._bulkLogoOverlay);
    const content = titleLayer?.content || '';
    const title = titleLayer?.title_text || (titleLayer?.type === 'text' ? content : '') || '';
    const body = bodyLayer?.body_text || bodyLayer?.content || '';
    const pattern = document.getElementById('bc-task-naming-custom')?.value
        || _bulkState.taskNamingCustomPattern || '{任务组}_{标题}_{Logo}_{序号}';
    let base = '';
    if (mode === 'custom') {
        base = _bcComposeName(pattern, {
        '任务组': safeGroup, '背景': _bcMediaStem(task.bgPath || task.videoPath), '模板': safeTpl, '覆层预设': safeTpl,
        '序号': padNum, '日期': _bcLocalDateStamp(), '标题': title, '正文': body,
        '内容': body || content, 'Logo': _bcMediaStem(logoLayer?.content),
        '配乐': _bcMediaStem(task.bgmPath || task._bulkMusicAssignment?.path),
        }, safeGroup ? `${safeGroup}_${padNum}` : `${safeTpl}_${padNum}`);
    } else if (safeGroup) {
        if (mode === 'group_bg_index') base = safeBg ? `${safeGroup}_${safeBg}_${padNum}` : `${safeGroup}_${padNum}`;
        else if (mode === 'group_bg') base = safeBg ? (taskNum > 1 ? `${safeGroup}_${safeBg}_${padNum}` : `${safeGroup}_${safeBg}`) : `${safeGroup}_${padNum}`;
        else if (mode === 'bg_group_index') base = safeBg ? `${safeBg}_${safeGroup}_${padNum}` : `${safeGroup}_${padNum}`;
        else base = `${safeGroup}_${padNum}`;
    } else {
        base = `${safeTpl}_${padNum}`;
    }
    task.baseName = base;
    task.fileName = `${base}.mp4`;
    if (!task.exportName || task.exportName === previousBase) task.exportName = base;
}

// 用当前规则回写已生成的任务。只更新任务行名/默认输出名；用户手填过的
// exportName 会被保留，素材、文案及覆层参数也完全不触碰。
function _bcUpdateExistingTaskNames(scope = 'all') {
    const state = window._reelsState;
    if (!state || typeof _batchTableState === 'undefined') {
        alert('当前没有可更新的批量任务组');
        return 0;
    }
    if (typeof _syncTasksToActiveTab === 'function') _syncTasksToActiveTab();
    const assignments = _bulkState.groupAssignments || [];
    const groups = _bcNumberedColumnGroups();
    let updated = 0;
    const activeTabId = _batchTableState.activeTabId;
    (_batchTableState.tabs || []).forEach(tab => {
        if (scope === 'current' && tab.id !== activeTabId) return;
        const tabName = String(tab?.name || '').trim();
        const persistedGroupKey = (tab.tasks || []).find(task => task?._bulkCreateGroupKey)?._bulkCreateGroupKey;
        const matchedAssignment = assignments
            .slice()
            .sort((a, b) => String(b.key || '').length - String(a.key || '').length)
            .find(entry => {
                const key = String(entry?.key || '').trim();
                return key && (key === persistedGroupKey || tabName === key || tabName.startsWith(`${key}_`) || tabName.endsWith(`_${key}`));
            });
        const groupKey = persistedGroupKey || matchedAssignment?.key || tabName;
        const group = groups.find(item => item.key === groupKey);
        const tpl = matchedAssignment ? _bcAssignedTemplate(matchedAssignment, group) : null;
        (tab.tasks || []).forEach((task, index) => {
            if (!task) return;
            // “当前任务”是当前标签页中正在编辑的这一条，而不是整页。
            if (scope === 'current' && index !== state.selectedIdx) return;
            _bcRefreshCustomTaskName(task, tpl || { label: '' }, index + 1, groupKey);
            updated++;
        });
    });
    if (_isBatchGroupedProjection?.(state.tasks) && typeof _restoreGroupedProjectionFromTabs === 'function') {
        _restoreGroupedProjectionFromTabs(_batchTableState.appliedTabIds || _batchTableState.tabs.map(tab => tab.id));
    } else {
        const activeTab = _batchTableState.tabs.find(tab => tab.id === _batchTableState.activeTabId);
        if (activeTab) state.tasks = typeof _cloneBatchTasks === 'function'
            ? _cloneBatchTasks(activeTab.tasks || [])
            : JSON.parse(JSON.stringify(activeTab.tasks || []));
    }
    if (updated) {
        window.reelsSaveHistory?.();
        if (typeof _renderBatchTable === 'function') _renderBatchTable();
        if (typeof _renderTaskList === 'function') _renderTaskList();
    }
    return updated;
}

function _bcBuildTask(tpl, row, rowIdx, taskNum, cols, groupKey = '', options = {}) {
    const task = JSON.parse(JSON.stringify(tpl.task));
    const derivation = window.ReelsTaskDerivation;
    if (!derivation) throw new Error('任务派生模块未加载，请完全重启 VideoKit 后重试');
    // 新任务只继承模板的样式、素材设置与覆层结构。字幕片段、来源文案、
    // 对齐状态和所有实例 ID 都必须重新建立，不能携带模板任务的运行数据。
    derivation.prepareDerivedTask(task);
    // 解析分配的背景文件夹名称
    let bgFolderName = '';
    if (tpl?.assignedBackgroundFolder) {
        const bgFolder = (_bulkState.backgroundFolders || []).find(item => item.path === tpl.assignedBackgroundFolder);
        bgFolderName = bgFolder?.name ? bgFolder.name.trim() : (String(tpl.assignedBackgroundFolder).split(/[/\\]/).filter(Boolean).pop() || '').trim();
    }
    if (!bgFolderName && task.bgPath) {
        const matchedFolder = (_bulkState.backgroundFolders || []).find(f => Array.isArray(f.files) && f.files.includes(task.bgPath));
        if (matchedFolder?.name) bgFolderName = matchedFolder.name.trim();
    }

    const namingMode = (typeof document !== 'undefined' && document.getElementById('bc-task-naming-mode')?.value)
        || _bulkState.taskNamingMode
        || (typeof localStorage !== 'undefined' ? localStorage.getItem('reels_bulk_task_naming_mode') : '')
        || 'custom';

    const padNum = String(taskNum).padStart(3, '0');
    const _safeName = s => String(s || '').replace(/[\/\\:*?"<>|]/g, '_').trim();
    const safeGroup = _safeName(groupKey);
    const safeBg = _safeName(bgFolderName);
    const safeTpl = _safeName(tpl.label || 'bulk');
    const customPattern = document.getElementById('bc-task-naming-custom')?.value || _bulkState.taskNamingCustomPattern || '{任务组}_{标题}_{Logo}_{序号}';

    let base = '';
    if (namingMode === 'custom') {
        base = _bcComposeName(customPattern, { '任务组': safeGroup, '背景': safeBg, '模板': safeTpl, '序号': padNum }, safeGroup ? `${safeGroup}_${padNum}` : `${safeTpl}_${padNum}`);
    } else if (safeGroup) {
        if (namingMode === 'group_bg_index') {
            base = safeBg ? `${safeGroup}_${safeBg}_${padNum}` : `${safeGroup}_${padNum}`;
        } else if (namingMode === 'group_bg') {
            base = safeBg ? (taskNum > 1 ? `${safeGroup}_${safeBg}_${padNum}` : `${safeGroup}_${safeBg}`) : `${safeGroup}_${padNum}`;
        } else if (namingMode === 'bg_group_index') {
            base = safeBg ? `${safeBg}_${safeGroup}_${padNum}` : `${safeGroup}_${padNum}`;
        } else {
            // 'group_index'
            base = `${safeGroup}_${padNum}`;
        }
    } else {
        const tplPrefix = _bulkState.templates.length > 1 ? safeTpl : 'bulk';
        if (namingMode === 'group_bg_index' || namingMode === 'group_bg') {
            base = safeBg ? `${tplPrefix}_${safeBg}_${padNum}` : `${tplPrefix}_${padNum}`;
        } else if (namingMode === 'bg_group_index') {
            base = safeBg ? `${safeBg}_${tplPrefix}_${padNum}` : `${tplPrefix}_${padNum}`;
        } else {
            base = `${tplPrefix}_${padNum}`;
        }
    }

    task.baseName = base;
    task.fileName = task.baseName + '.mp4';
    if (!task.exportName) task.exportName = task.baseName;
    task.status = ''; task.bgSrcUrl = null; task.srcUrl = null;

    // Automatic Background Cycling (Unified Mode)
    // If we have a bgCycle array and the user hasn't explicitly mapped a background column
    let hasBgColumnBound = false;
    if (tpl.bindings['__bg__'] != null && tpl.bindings['__bg__'] >= 0 && row[tpl.bindings['__bg__']]) {
        hasBgColumnBound = true;
    }
    
    if (!hasBgColumnBound && tpl.bgCycle && tpl.bgCycle.length > 0) {
        const cycleBg = tpl.bgCycle[rowIdx % tpl.bgCycle.length];
        _bcApplySingleBackground(task, cycleBg);
    }

    // 诊断：确认背景路径
    if (rowIdx === 0) {
        console.log(`[BulkCreate] 模板「${tpl.label}」背景诊断: bgPath="${(task.bgPath||'').split(/[/\\]/).pop()}", videoPath="${(task.videoPath||'').split(/[/\\]/).pop()}", bgCycle=${tpl.bgCycle ? tpl.bgCycle.length + '个' : '无'}, bgBound=${hasBgColumnBound}`);
    }

    const fields = _bcFieldsFromTask(tpl.task);
    console.log(`[BulkCreate] 模板「${tpl.label}」row#${rowIdx} bindings:`, JSON.stringify(tpl.bindings));
    const setOverlayText = (ov, key, value) => {
        if (!ov) return;
        ov[key] = value;
        if (key === 'title_text') ov.title_styled_ranges = null;
        else if (key === 'body_text') ov.body_styled_ranges = null;
        else if (key === 'footer_text') ov.footer_styled_ranges = null;
        else if (key === 'scroll_title') ov.scroll_title_styled_ranges = null;
        else if (key === 'content') {
            ov.scroll_styled_ranges = null;
            ov.styled_ranges = null;
        }
    };

    // 编号组的列名是任务数据的最终权威来源。旧草稿、覆层替换或曾经
    // 编辑过的组合有可能留下不完整的 bindings；若正文绑定缺失，不能
    // 因此静默生成一条只有标题的任务。
    const numberedGroup = groupKey
        ? _bcNumberedColumnGroups().find(group => group.key === groupKey)
        : null;
    const groupFallbackNames = {
        ai_source: ['原始文案', '原始完整文案'],
        card_title: ['标题'],
        card_body: ['正文', '内容'],
        card_footer: ['结尾', '尾标'],
        scroll_title: ['标题'],
        scroll_body: ['正文', '内容'],
        plain_text: ['内容', '正文'],
    };
    const resolveBoundColumn = f => {
        const bound = tpl.bindings?.[f.key];
        const rowPresetMode = options.rowPresetMode ?? _bulkState.rowPresetMode;
        const layerIndex = /^L(\d+)_/.exec(f.key)?.[1];
        const sourceOverlay = layerIndex != null ? tpl.task.overlays?.[Number(layerIndex)] : null;
        // 单列文案遇到仅标题的卡片，应替换已定位的标题，不能额外创建正文。
        const titleOnly = sourceOverlay?.type === 'textcard'
            && !String(sourceOverlay.body_text || '').trim()
            && (String(sourceOverlay.title_text || '').trim()
                || Number(sourceOverlay.title_offset_x) || Number(sourceOverlay.title_offset_y));
        if (options.copyColumn != null && f.type === 'text') {
            const ci = options.copyColumn;
            if (['ai_source', 'dynamic_subtitle', 'tts_text'].includes(f.category)) return ci;
            if (f.category === 'card_title') return titleOnly ? ci : undefined;
            if (f.category === 'card_body') return titleOnly ? undefined : ci;
            if (['scroll_body', 'plain_text'].includes(f.category)) return ci;
            if (['card_footer', 'scroll_title'].includes(f.category)) return undefined;
        }
        const sourceColumn = () => cols.findIndex((col, index) => col.type === 'text'
            && /^(原始完整文案|原始文案|文案|内容|正文)$/.test(String(col.name || '').trim())
            && String(row[index] || '').trim());
        if (rowPresetMode && titleOnly && f.category === 'card_title'
            && !(bound >= 0 && String(row[bound] || '').trim())) {
            const source = sourceColumn();
            if (source >= 0) return source;
        }
        if (rowPresetMode && titleOnly && f.category === 'card_body'
            && !(bound != null && bound >= 0 && String(row[bound] || '').trim())) return undefined;
        if ((options.rowPresetMode ?? _bulkState.rowPresetMode) && ['card_body', 'scroll_body', 'plain_text'].includes(f.category)
            && !(bound >= 0 && String(row[bound] || '').trim())) {
            const source = cols.findIndex((col, index) => col.type === 'text'
                && /^(原始完整文案|原始文案|文案|内容|正文)$/.test(String(col.name || '').trim())
                && String(row[index] || '').trim());
            if (source >= 0) return source;
        }
        if (bound != null && bound >= 0 && bound < cols.length) return bound;
        if (!numberedGroup || f.type !== 'text') return bound;
        const names = [
            ...(BC_FIELD_CATEGORY_COLUMN_NAMES[f.category] || []),
            ...(groupFallbackNames[f.category] || []),
        ].map(name => String(name).toLowerCase());
        const match = numberedGroup.columns.find(column => names.includes(column.name)
            && _bcFieldAcceptsColumn(f, cols[column.ci]));
        return match ? match.ci : bound;
    };

    for (const f of fields) {
        const ci = resolveBoundColumn(f);
        if (ci == null || ci < 0 || ci >= cols.length) continue;
        if (!_bcFieldAcceptsColumn(f, cols[ci])) continue;
        const val = (row[ci] || '').trim();
        console.log(`  [${f.key}] → col[${ci}]「${cols[ci]?.name}」= "${val.slice(0, 30)}"`);
        if (!val) continue;

        if (f.key === '__bg__') { _bcApplySingleBackground(task, val); }
        else if (f.key === '__audio__') { task.audioPath = val; }
        else if (f.key === '__srt__') {
            derivation.bindSrt(task, val, {
                readFileText: path => window.electronAPI?.readFileText?.(path) || '',
                parseSrt: content => {
                    const parser = typeof parseSRT === 'function' ? parseSRT : window.parseSRT;
                    return parser ? parser(content) : [];
                },
                toWordSegments: rawSegments => window.ReelsSubtitleProcessor
                    ? window.ReelsSubtitleProcessor.srtToSegmentsWithWords(rawSegments)
                    : rawSegments,
            });
        }
        else if (f.key === '__cv__') { task.contentVideoPath = val; }
        else if (f.key === '__ai__') { task.aiScript = val; }
        else if (f.key === '__txt__') { task.txtContent = val; }
        else if (f.key === '__tts__') { task.ttsText = val; }
        else if (f.key === '__voice_id__') { task.ttsVoiceId = val; }
        else if (f.key === '__export_name__') { task.exportName = val; }
        else if (f.key.startsWith('L')) {
            const m = f.key.match(/^L(\d+)_(.+)$/);
            if (m && task.overlays && task.overlays[parseInt(m[1])]) {
                setOverlayText(task.overlays[parseInt(m[1])], m[2], val);
            }
        } else if (['title_text', 'body_text', 'footer_text'].includes(f.key)) {
            if (task.overlays && task.overlays[0]) setOverlayText(task.overlays[0], f.key, val);
        }
    }
    if (tpl.materialFolder?.mode === 'concat' && Array.isArray(tpl.materialFolder.files) && tpl.materialFolder.files.length > 0) {
        const pool = tpl.materialFolder.files.filter(Boolean);
        task.bgMode = 'multi';
        task.bgClipPool = pool.slice();
        task.bgClipActivePool = pool.slice();
        task.bgClipOrder = 'sequence';
        task.bgPath = pool[0];
        task.videoPath = pool[0];
        task.bgSrcUrl = null;
        task.srcUrl = null;
    }
    if (row._versionTag) {
        task.versionTag = row._versionTag;
    }
    // 旧的逐模板生成、预览等路径也应支持文字与日期类命名字段；任务组
    // 生成完成背景/Logo/配乐分配后会再调用一次以写入最终素材名。
    _bcRefreshCustomTaskName(task, tpl, taskNum, groupKey);
    return task;
}
window._bcBuildTask = _bcBuildTask;

// ── Preset save/load ──
const BC_PRESETS_KEY = 'reels_bulk_create_presets';
const BC_VIRAL_GROUP_PRESETS_KEY = 'reels_bulk_create_viral_group_presets';
const BC_VIRAL_PROJECTS_KEY = 'reels_bulk_create_viral_projects';

function _bcGetSavedPresets() {
    try { return JSON.parse(localStorage.getItem(BC_PRESETS_KEY) || '{}'); } catch(e) { return {}; }
}

function _bcGetViralGroupPresets() {
    try { return JSON.parse(localStorage.getItem(BC_VIRAL_GROUP_PRESETS_KEY) || '{}'); } catch (_) { return {}; }
}

function _bcGetViralProjects() {
    let projects = {};
    try { projects = JSON.parse(localStorage.getItem(BC_VIRAL_PROJECTS_KEY) || '{}') || {}; } catch (_) {}
    // 把刚才旧入口保存的“整体爆帖组合”自动迁入工程库，避免用户找不到或丢失。
    const legacy = _bcGetSavedPresets();
    let migrated = false;
    Object.entries(legacy).forEach(([name, item]) => {
        if (item?.category === 'viral' && !projects[name]) {
            projects[name] = { ...item, type: 'viral_project_combo', migratedFromLegacy: true };
            migrated = true;
        }
    });
    if (migrated) localStorage.setItem(BC_VIRAL_PROJECTS_KEY, JSON.stringify(projects));
    return projects;
}

function _bcProjectSnapshot() {
    return {
        type: 'viral_project_combo',
        // 保存的是可复开的“工程工作台”，不是套用到别组的预设。
        columns: JSON.parse(JSON.stringify(_bulkState.columns)),
        templates: _bulkState.templates.map(t => ({
            task: _bcSanitizeTaskForDraft(t.task || {}), label: t.label || '', bindings: { ...(t.bindings || {}) },
            bgCycle: t.bgCycle || null, source: t.source || null, materialFolder: t.materialFolder || null,
        })),
        backgroundFolders: JSON.parse(JSON.stringify(_bulkState.backgroundFolders)),
        overlayMediaFolders: JSON.parse(JSON.stringify(_bulkState.overlayMediaFolders)),
        logoMediaLibrary: JSON.parse(JSON.stringify(_bulkState.logoMediaLibrary)),
        musicFiles: JSON.parse(JSON.stringify(_bulkState.musicFiles)),
        groupAssignments: JSON.parse(JSON.stringify(_bulkState.groupAssignments || [])),
        allowTemplateReuse: !!_bulkState.allowTemplateReuse,
        allowBackgroundReuse: !!_bulkState.allowBackgroundReuse,
        allowMusicReuse: !!_bulkState.allowMusicReuse,
        savedAt: new Date().toISOString(),
    };
}

async function _bcSaveViralProject() {
    const name = await _bcPrompt('保存爆帖工程组合', '例如：人声-19-爆帖工程');
    if (!name?.trim()) return;
    const projects = _bcGetViralProjects();
    projects[name.trim()] = _bcProjectSnapshot();
    localStorage.setItem(BC_VIRAL_PROJECTS_KEY, JSON.stringify(projects));
    alert(`✅ 爆帖工程「${name.trim()}」已保存。下次打开即可填新文案、选新视频后生成任务。`);
}

function _bcOpenViralProjectLibrary() {
    const projects = _bcGetViralProjects();
    const names = Object.keys(projects);
    if (!names.length) { alert('暂无爆帖工程。请先点击“保存爆帖工程”。'); return; }
    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;inset:0;z-index:1000004;background:rgba(0,0,0,.8);display:flex;align-items:center;justify-content:center;padding:20px;';
    modal.innerHTML = `<div style="width:min(560px,95vw);max-height:74vh;display:flex;flex-direction:column;background:#171825;border:1px solid #5b3c81;border-radius:10px;overflow:hidden;"><div style="padding:14px 16px;border-bottom:1px solid #35364d;"><b style="color:#f4ecff;">🔥 爆帖工程库</b><div style="font-size:10px;color:#aaa5be;margin-top:4px;">打开后保留工程结构、编号组和全部设置；文案与素材输入从空白开始，直接制作下一批。</div></div><div style="overflow:auto;flex:1;">${names.map(name => { const p = projects[name]; return `<div style="padding:11px 14px;border-bottom:1px solid #2e2f44;display:flex;gap:10px;align-items:center;"><div style="flex:1;min-width:0;"><div style="font-size:12px;color:#fff;font-weight:600;">🔥 ${_bcEsc(name)}</div><div style="font-size:10px;color:#9e9ab4;margin-top:3px;">${(p.columns || []).length} 列 · ${(p.templates || []).length} 个模板 · ${(p.groupAssignments || []).length} 个编号组 · ${p.savedAt ? new Date(p.savedAt).toLocaleDateString() : ''}</div></div><button class="bc-viral-project-open bc-btn bc-btn-purple bc-btn-xs" data-name="${_bcEsc(name)}">打开工程</button><button class="bc-viral-project-delete bc-btn bc-btn-danger bc-btn-xs" data-name="${_bcEsc(name)}">删除</button></div>`; }).join('')}</div><div style="padding:10px 14px;text-align:right;border-top:1px solid #35364d;"><button class="bc-viral-project-close bc-btn bc-btn-default bc-btn-xs">关闭</button></div></div>`;
    modal.addEventListener('click', e => {
        const t = e.target;
        if (t.classList.contains('bc-viral-project-close')) { modal.remove(); return; }
        const name = t.dataset.name;
        if (t.classList.contains('bc-viral-project-delete')) { if (confirm(`删除爆帖工程「${name}」？`)) { delete projects[name]; localStorage.setItem(BC_VIRAL_PROJECTS_KEY, JSON.stringify(projects)); modal.remove(); _bcOpenViralProjectLibrary(); } return; }
        if (!t.classList.contains('bc-viral-project-open')) return;
        const p = projects[name]; if (!p) return;
        _bulkState.columns = JSON.parse(JSON.stringify(p.columns || []));
        _bulkState.templates = (p.templates || []).map(item => ({ task: item.task || {}, label: item.label || '', bindings: { ...(item.bindings || {}) }, bgCycle: item.bgCycle || null, source: item.source || null, materialFolder: item.materialFolder || null }));
        _bulkState.backgroundFolders = JSON.parse(JSON.stringify(p.backgroundFolders || []));
        _bulkState.overlayMediaFolders = JSON.parse(JSON.stringify(p.overlayMediaFolders || []));
        _bulkState.logoMediaLibrary = JSON.parse(JSON.stringify(p.logoMediaLibrary || []));
        _bulkState.musicFiles = JSON.parse(JSON.stringify(p.musicFiles || []));
        _bulkState.groupAssignments = JSON.parse(JSON.stringify(p.groupAssignments || []));
        _bulkState.allowTemplateReuse = !!p.allowTemplateReuse; _bulkState.allowBackgroundReuse = !!p.allowBackgroundReuse; _bulkState.allowMusicReuse = !!p.allowMusicReuse;
        // 新开一批：不带入旧文案、旧选材或已经生成过的任务行。
        _bulkState.rows = Array.from({ length: 20 }, () => new Array(_bulkState.columns.length).fill(''));
        _bcNormalizeStateShape(); modal.remove(); _bcRenderTable(); _bcRenderBindings(); _bcScheduleDraftSave();
        if (typeof showToast === 'function') showToast(`已打开爆帖工程「${name}」，可开始添加新文案和素材`, 'success');
    });
    document.body.appendChild(modal);
}

async function _bcSaveViralGroupPreset(groupKey) {
    const entry = (_bulkState.groupAssignments || []).find(item => item.key === groupKey);
    const template = _bulkState.templates[entry?.templateIndex];
    if (!entry || !template) { alert('请先为该任务组分配模板，再保存为爆帖工程组合'); return null; }
    // 一键保存：默认直接使用当前任务组名，不再打断用户填写名称。
    // 如需自定义名称，可在组合库中进行重命名。
    const presets = _bcGetViralGroupPresets();
    const baseName = groupKey;
    let name = baseName;
    let copyNumber = 2;
    while (presets[name]) name = `${baseName} (${copyNumber++})`;
    const backgroundFolder = _bulkState.backgroundFolders.find(item => item.path === entry.backgroundFolder);
    const music = _bulkState.musicFiles.find(item => item.path === entry.musicPath);
    const sourceGroup = _bcNumberedColumnGroups().find(group => group.key === groupKey);
    presets[name] = {
        type: 'viral_group_combo',
        sourceGroupKey: groupKey, // 仅用于追溯来源；加载到其他组时绝不改写其编号。
        template: {
            task: _bcSanitizeTaskForDraft(template.task || {}), label: template.label || '爆帖模板',
            bindings: { ...(template.bindings || {}) }, bgCycle: template.bgCycle || null,
            source: template.source || null, materialFolder: template.materialFolder || null,
        },
        assignment: JSON.parse(JSON.stringify({ ...entry, key: undefined })),
        // 只存本组的列结构，加载多个爆帖组时会自动生成新的编号列，不会覆盖原组。
        columnSchema: (sourceGroup?.columns || []).map(col => ({
            fieldName: col.name,
            column: JSON.parse(JSON.stringify(_bulkState.columns[col.ci] || {})),
        })),
        backgroundFolder: backgroundFolder ? JSON.parse(JSON.stringify(backgroundFolder)) : null,
        music: music ? JSON.parse(JSON.stringify(music)) : null,
        savedAt: new Date().toISOString(),
    };
    localStorage.setItem(BC_VIRAL_GROUP_PRESETS_KEY, JSON.stringify(presets));
    if (typeof showToast === 'function') showToast(`已保存爆帖工程组合「${name}」`, 'success');
    else alert(`✅ 已保存爆帖工程组合「${name}」`);
    return name;
}

function _bcAddViralGroupsFromLibrary() {
    const presets = _bcGetViralGroupPresets();
    const names = Object.keys(presets);
    if (!names.length) { alert('爆帖工程组合库还是空的。先在一个任务组点“保存为爆帖工程组合”。'); return; }
    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;inset:0;z-index:1000003;background:rgba(0,0,0,.78);display:flex;align-items:center;justify-content:center;padding:20px;';
    modal.innerHTML = `<div style="width:min(580px,95vw);max-height:74vh;display:flex;flex-direction:column;background:#171825;border:1px solid #4a3b69;border-radius:10px;overflow:hidden;"><div style="padding:13px 15px;border-bottom:1px solid #33344b;color:#f4efff;"><b>🔥 爆帖工程组合库</b><div style="margin-top:4px;font-size:10px;color:#aaa5be;">可多选。每个组合都会新增一个编号任务组，原有任务组与预设均不改动。</div></div><div style="overflow:auto;flex:1;">${names.map(name => { const p = presets[name]; return `<label style="padding:10px 13px;border-bottom:1px solid #2d2e42;display:flex;align-items:center;gap:9px;cursor:pointer;"><input class="bc-viral-add-check" type="checkbox" data-name="${_bcEsc(name)}" style="accent-color:#a855f7;"><div style="flex:1;min-width:0;"><div style="font-size:12px;color:#f2e8ff;font-weight:600;">🔥 ${_bcEsc(name)}</div><div style="font-size:10px;color:#9994b2;margin-top:3px;">来源任务组：${_bcEsc(p.sourceGroupKey || '未记录')} · ${p.template?.label ? _bcEsc(p.template.label) : '模板'} · ${p.savedAt ? new Date(p.savedAt).toLocaleDateString() : ''}</div></div><button type="button" class="bc-viral-group-delete bc-btn bc-btn-danger bc-btn-xs" data-name="${_bcEsc(name)}" title="删除这个保存的组合；不会删除来源任务组" style="flex-shrink:0;">删除</button></label>`; }).join('')}</div><div style="padding:10px 13px;border-top:1px solid #33344b;display:flex;justify-content:space-between;align-items:center;"><span style="font-size:10px;color:#9994b2;">加载后在新编号组中填文案/选择视频，随后统一批量生成。</span><div style="display:flex;gap:6px;"><button class="bc-viral-add-cancel bc-btn bc-btn-default bc-btn-xs">取消</button><button class="bc-viral-add-confirm bc-btn bc-btn-purple bc-btn-xs">加入已选组合</button></div></div></div>`;
    modal.addEventListener('click', e => {
        const deleteButton = e.target.closest?.('.bc-viral-group-delete');
        if (deleteButton) {
            e.preventDefault();
            e.stopPropagation();
            const name = deleteButton.dataset.name;
            if (!name || !presets[name]) return;
            if (!confirm(`删除爆帖工程组合「${name}」？\n\n只会删除组合库中的这一项，不会删除来源任务组、模板或预设。`)) return;
            delete presets[name];
            localStorage.setItem(BC_VIRAL_GROUP_PRESETS_KEY, JSON.stringify(presets));
            modal.remove();
            _bcAddViralGroupsFromLibrary();
            return;
        }
        if (e.target.classList.contains('bc-viral-add-cancel')) { modal.remove(); return; }
        if (!e.target.classList.contains('bc-viral-add-confirm')) return;
        const selected = [...modal.querySelectorAll('.bc-viral-add-check:checked')]
            .map(item => ({ name: item.dataset.name, preset: presets[item.dataset.name] }))
            .filter(item => Boolean(item.preset));
        if (!selected.length) { alert('请至少选择一个爆帖工程组'); return; }
        const value = id => document.getElementById(id)?.value ?? (id === 'bc-header-prefix' ? 'reels' : id === 'bc-header-before' || id === 'bc-header-after' ? '-' : '');
        const after = value('bc-header-after');
        const usedKeys = new Set(_bcNumberedColumnGroups().map(group => group.key));
        if (!_bulkState.groupAssignments) _bulkState.groupAssignments = [];
        const addedGroupKeys = [];
        selected.forEach(({ name: presetName, preset }, index) => {
            if (!preset.template || !preset.assignment) return;
            if (preset.backgroundFolder && !_bulkState.backgroundFolders.some(item => item.path === preset.backgroundFolder.path)) _bulkState.backgroundFolders.push(JSON.parse(JSON.stringify(preset.backgroundFolder)));
            if (preset.music && !_bulkState.musicFiles.some(item => item.path === preset.music.path)) _bulkState.musicFiles.push(JSON.parse(JSON.stringify(preset.music)));
            let key = presetName;
            let copyNumber = 2;
            while (usedKeys.has(key)) key = `${presetName} (${copyNumber++})`;
            usedKeys.add(key);
            addedGroupKeys.push(key);
            const schema = preset.columnSchema || [];
            schema.forEach((item, schemaIndex) => {
                const column = JSON.parse(JSON.stringify(item.column || { type: 'text' }));
                column.name = `${key}${after}${item.fieldName || `字段${schemaIndex + 1}`}`;
                _bulkState.columns.push(column);
                _bulkState.rows.forEach(row => row.push(''));
            });
            const copiedTemplate = { task: JSON.parse(JSON.stringify(preset.template.task || {})), label: preset.template.label || `爆帖工程${index + 1}`, bindings: { ...(preset.template.bindings || {}) }, bgCycle: preset.template.bgCycle || null, source: preset.template.source || null, materialFolder: preset.template.materialFolder || null };
            _bulkState.templates.push(copiedTemplate);
            // 新编号组的列名已改号，旧组的绝对列名不能直接复用；由字段类别重新绑定到新建列。
            _bulkState.groupAssignments.push({ ...JSON.parse(JSON.stringify(preset.assignment)), key, comboName: presetName, bindings: {}, templateIndex: _bulkState.templates.length - 1 });
        });
        _bulkState.collapsedSections.groups = false;
        _bulkState.filterUnassignedGroups = false;
        _bcNormalizeStateShape(); modal.remove(); _bcRenderTable(); _bcRenderBindings(); _bcScheduleDraftSave();
        const addedCount = addedGroupKeys.length;
        if (typeof showToast === 'function') showToast(`已加入 ${addedCount} 个组合：${addedGroupKeys.join('、')}，表头和任务组已沿用组合名称。`, 'success', 7000);
        // 组合已经写入状态和列，但此前没有把用户带到右侧的新任务组，容易误以为没有生效。
        setTimeout(() => {
            const newest = addedGroupKeys.at(-1);
            const card = newest ? document.querySelector(`[data-bc-group-card="${CSS.escape(newest)}"]`) : null;
            const section = document.getElementById('bc-groups-section');
            (card || section)?.scrollIntoView({ behavior: 'smooth', block: 'start', inline: 'nearest' });
            (card || section)?.classList?.add('bc-quick-locate-target');
            setTimeout(() => (card || section)?.classList?.remove('bc-quick-locate-target'), 2500);
        }, 80);
    });
    document.body.appendChild(modal);
}

function _bcExportViralGroups() {
    const groups = _bcGetViralGroupPresets();
    const names = Object.keys(groups);
    if (!names.length) { alert('爆帖工程库还是空的，没有可导出的工程组。'); return; }
    const payload = { type: 'videokit_viral_engineering_groups', version: 1, exportedAt: new Date().toISOString(), groups };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `爆帖工程组_${VideoKitLocalTime.format().slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 0);
}

function _bcImportViralGroups() {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.json,application/json';
    input.onchange = () => {
        const file = input.files?.[0]; if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            try {
                const data = JSON.parse(reader.result);
                if (data?.type !== 'videokit_viral_engineering_groups' || !data.groups || typeof data.groups !== 'object') {
                    alert('不是有效的爆帖工程组导入文件'); return;
                }
                const current = _bcGetViralGroupPresets();
                const duplicate = Object.keys(data.groups).filter(name => current[name]);
                const apply = () => {
                    let added = 0, overwritten = 0;
                    Object.entries(data.groups).forEach(([name, group]) => {
                        if (!group?.template || !group?.assignment) return;
                        if (current[name]) overwritten++; else added++;
                        current[name] = group;
                    });
                    localStorage.setItem(BC_VIRAL_GROUP_PRESETS_KEY, JSON.stringify(current));
                    alert(`✅ 已导入爆帖工程组：新增 ${added} 个${overwritten ? `，覆盖 ${overwritten} 个同名工程组` : ''}`);
                };
                if (duplicate.length && !confirm(`发现 ${duplicate.length} 个同名爆帖工程组，导入将覆盖它们。是否继续？`)) return;
                apply();
            } catch (_) { alert('读取失败：文件不是有效 JSON'); }
        };
        reader.readAsText(file);
    };
    input.click();
}

function _bcLoadViralGroupPreset(targetGroupKey) {
    const presets = _bcGetViralGroupPresets();
    const names = Object.keys(presets);
    if (!names.length) { alert('爆帖组合库还是空的。先在任意编号组点击“存为爆帖组合”。'); return; }
    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;inset:0;z-index:1000003;background:rgba(0,0,0,.78);display:flex;align-items:center;justify-content:center;padding:20px;';
    modal.innerHTML = `<div style="width:min(520px,95vw);max-height:72vh;display:flex;flex-direction:column;background:#171825;border:1px solid #4a3b69;border-radius:10px;overflow:hidden;"><div style="padding:13px 15px;border-bottom:1px solid #33344b;color:#f4efff;"><b>🔥 套用爆帖组合到「${_bcEsc(targetGroupKey)}」</b><div style="margin-top:4px;font-size:10px;color:#aaa5be;">只替换当前编号组的模板、字段绑定、背景和配乐；其他编号组完全不变。</div></div><div style="overflow:auto;flex:1;">${names.map(name => { const p = presets[name]; return `<div style="padding:10px 13px;border-bottom:1px solid #2d2e42;display:flex;align-items:center;gap:8px;"><div style="flex:1;min-width:0;"><div style="font-size:12px;color:#f2e8ff;font-weight:600;">🔥 ${_bcEsc(name)}</div><div style="font-size:10px;color:#9994b2;margin-top:3px;">来源：${_bcEsc(p.sourceGroupKey || '未记录')} · ${p.savedAt ? new Date(p.savedAt).toLocaleDateString() : ''}</div></div><button class="bc-viral-group-load bc-btn bc-btn-purple bc-btn-xs" data-name="${_bcEsc(name)}">套用到此组</button><button class="bc-viral-group-del bc-btn bc-btn-danger bc-btn-xs" data-name="${_bcEsc(name)}">删除</button></div>`; }).join('')}</div><div style="padding:9px 13px;text-align:right;border-top:1px solid #33344b;"><button class="bc-viral-close bc-btn bc-btn-default bc-btn-xs">关闭</button></div></div>`;
    modal.addEventListener('click', e => {
        const button = e.target;
        if (button.classList.contains('bc-viral-close')) { modal.remove(); return; }
        const name = button.dataset.name;
        if (button.classList.contains('bc-viral-group-del')) { if (confirm(`删除爆帖组合「${name}」？`)) { delete presets[name]; localStorage.setItem(BC_VIRAL_GROUP_PRESETS_KEY, JSON.stringify(presets)); modal.remove(); _bcLoadViralGroupPreset(targetGroupKey); } return; }
        if (!button.classList.contains('bc-viral-group-load')) return;
        const preset = presets[name]; if (!preset?.template || !preset.assignment) return;
        if (preset.backgroundFolder && !_bulkState.backgroundFolders.some(item => item.path === preset.backgroundFolder.path)) _bulkState.backgroundFolders.push(preset.backgroundFolder);
        if (preset.music && !_bulkState.musicFiles.some(item => item.path === preset.music.path)) _bulkState.musicFiles.push(preset.music);
        const copiedTemplate = { task: preset.template.task || {}, label: preset.template.label || name, bindings: { ...(preset.template.bindings || {}) }, bgCycle: preset.template.bgCycle || null, source: preset.template.source || null, materialFolder: preset.template.materialFolder || null };
        _bulkState.templates.push(copiedTemplate);
        if (!_bulkState.groupAssignments) _bulkState.groupAssignments = [];
        const assignment = { ...JSON.parse(JSON.stringify(preset.assignment)), key: targetGroupKey, templateIndex: _bulkState.templates.length - 1 };
        const oldIndex = _bulkState.groupAssignments.findIndex(item => item.key === targetGroupKey);
        if (oldIndex >= 0) _bulkState.groupAssignments[oldIndex] = assignment;
        else _bulkState.groupAssignments.push(assignment);
        modal.remove(); _bcRenderBindings(); _bcScheduleDraftSave();
        if (typeof showToast === 'function') showToast(`已将爆帖组合「${name}」套用到 ${targetGroupKey}`, 'success');
    });
    document.body.appendChild(modal);
}

function _bcCreatePresetSnapshot(category = 'regular') {
    return JSON.parse(JSON.stringify({
        category, columns: _bulkState.columns, rows: _bulkState.rows,
        rowPresetMode: _bulkState.rowPresetMode, rowTemplateIds: _bulkState.rowTemplateIds,
        cellPresetMode: _bulkState.cellPresetMode, cellTemplateIds: _bulkState.cellTemplateIds,
        backgroundFolders: _bulkState.backgroundFolders, overlayMediaFolders: _bulkState.overlayMediaFolders,
        logoMediaLibrary: _bulkState.logoMediaLibrary, musicFiles: _bulkState.musicFiles,
        groupAssignments: _bulkState.groupAssignments, missingHeaderGroupKeys: _bulkState.missingHeaderGroupKeys, retainedHeaderColumns: _bulkState.retainedHeaderColumns,
        allowTemplateReuse: _bulkState.allowTemplateReuse, allowBackgroundReuse: _bulkState.allowBackgroundReuse,
        allowMusicReuse: _bulkState.allowMusicReuse,
        templates: _bulkState.templates.map(t => ({
            bulkTemplateId: t.bulkTemplateId, task: _bcSanitizeTaskForDraft(t.task || {}), label: t.label, bindings: { ...t.bindings },
            bgCycle: t.bgCycle || null, source: t.source || null, materialFolder: t.materialFolder || null,
        })), savedAt: new Date().toISOString(),
    }));
}

function _bcDownloadCurrentPresetBackup(name = '当前工程备份', snapshot = _bcCreatePresetSnapshot()) {
    const data = { type: 'bulk_create_preset', version: 1, presets: { [name]: snapshot }, exportedAt: new Date().toISOString() };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `bulk_recovery_${Date.now()}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function _bcShowPresetSaveFailure(error, name, snapshot) {
    window._bcUnsavedPresetBackup = { name, snapshot };
    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;inset:0;z-index:400001;background:rgba(0,0,0,.85);display:flex;align-items:center;justify-content:center;';
    modal.innerHTML = `<div role="alert" style="width:min(520px,95vw);background:#1a1a2e;color:#eee;border:1px solid #f87171;border-radius:10px;padding:18px;"><b style="color:#fca5a5;">保存失败：尚未保存到组合库</b><div style="font-size:12px;line-height:1.7;margin-top:10px;">${_bcEsc(error?.message || String(error))}<br>当前配置仍保留在窗口内。请先下载独立备份，再关闭、刷新或加载其他组合。备份包含文案、任务组绑定、模板和修改过的覆层，可用“导入”恢复。</div><div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px;"><button data-save-failure-backup class="bc-btn bc-btn-primary">下载这次配置的备份</button><button data-save-failure-close class="bc-btn bc-btn-default">返回</button></div></div>`;
    document.body.appendChild(modal);
    modal.querySelector('[data-save-failure-backup]').onclick = () => _bcDownloadCurrentPresetBackup(name, snapshot);
    modal.querySelector('[data-save-failure-close]').onclick = () => modal.remove();
}

async function _bcSavePreset(category = 'regular') {
    const isViral = category === 'viral';
    const name = await _bcPrompt(isViral ? '给爆帖组合命名' : '输入大量制作模版名称', isViral ? '例如：爆帖-人声19-21.4' : '例如：FB批量配置');
    if (!name || !name.trim()) return;
    const snapshot = _bcCreatePresetSnapshot(isViral ? 'viral' : 'regular');
    try {
        const presets = _bcGetSavedPresets();
        presets[name.trim()] = snapshot;
        localStorage.setItem(BC_PRESETS_KEY, JSON.stringify(presets));
        window._bcUnsavedPresetBackup = null;
        alert(`✅ ${isViral ? '爆帖组合' : '大量制作模版'}「${name.trim()}」已保存${window.reelsBulkStorageMode === 'disk' ? '到磁盘' : ''}`);
    } catch (error) {
        _bcShowPresetSaveFailure(error, name.trim(), snapshot);
    }
}

let _bcMediaCheckTimer = null;
let _bcMediaCheckRevision = 0;
let _bcMediaPathStatus = new Map();

function _bcMediaStatusSlot(value) {
    const paths = [..._bcRelinkCollectPaths(value).keys()];
    return paths.length ? `<span data-bc-media-paths="${_bcEsc(JSON.stringify(paths))}" style="display:none;color:#fca5a5;font-size:10px;font-weight:600;white-space:normal;overflow-wrap:anywhere;"></span>` : '';
}

function _bcGroupMediaStatusSlot(entry, assigned) {
    const sources = [entry, assigned];
    for (const folder of [..._bulkState.backgroundFolders, ..._bulkState.overlayMediaFolders]) {
        if (folder.path === entry?.backgroundFolder || folder.path === entry?.overlayMediaFolder) sources.push(folder);
    }
    const logo = _bulkState.logoMediaLibrary.find(item => item.id === entry?.logoOverlay?.sourceId);
    if (logo) sources.push(logo);
    if (entry?.musicMode === 'cycle' || entry?.musicMode === 'random') sources.push(_bulkState.musicFiles);
    return _bcMediaStatusSlot(sources);
}

function _bcPaintMediaStatus(checking = false) {
    const panel = document.getElementById('bc-bind-panel');
    if (!panel?.querySelectorAll) return;
    for (const slot of panel.querySelectorAll('[data-bc-media-paths]')) {
        let paths = [];
        try { paths = JSON.parse(slot.dataset.bcMediaPaths); } catch (_) { }
        const missing = paths.filter(path => _bcMediaPathStatus.get(path) === false);
        slot.style.display = missing.length ? 'inline-block' : 'none';
        slot.textContent = missing.length ? ` ⚠ 路径丢失（${missing.length}）` : '';
        slot.title = missing.length ? `以下素材路径不存在或磁盘未连接：\n${missing.join('\n')}` : '';
    }
    const summary = panel.querySelector('#bc-media-missing-summary');
    if (!summary) return;
    const paths = _bcRelinkCollectPaths(_bulkState);
    const missing = [...paths.keys()].filter(path => _bcMediaPathStatus.get(path) === false);
    const folders = missing.filter(path => paths.get(path) === 'folder').length;
    const unknown = [...paths.keys()].filter(path => !_bcMediaPathStatus.has(path)).length;
    summary.style.display = missing.length || checking || unknown ? 'block' : 'none';
    summary.innerHTML = missing.length
        ? `⚠ 素材路径丢失：${folders} 个文件夹、${missing.length - folders} 个文件。请连接原磁盘，或点击 <button data-bc-relink-media class="bc-btn bc-btn-danger bc-btn-xs">🔎 找回丢失素材</button>${checking ? ' · 检查中…' : ''}${unknown && !checking ? ` · ${unknown} 个路径未能检查` : ''}`
        : (checking ? '正在检查素材和配乐路径…' : `有 ${unknown} 个素材路径未能检查，请重试。`);
    summary.title = missing.join('\n');
}

function _bcScheduleMediaPathCheck() {
    if (!window.electronAPI?.fileExists) return;
    clearTimeout(_bcMediaCheckTimer);
    const revision = ++_bcMediaCheckRevision;
    _bcPaintMediaStatus(true);
    _bcMediaCheckTimer = setTimeout(async () => {
        const paths = [..._bcRelinkCollectPaths(_bulkState).keys()];
        const status = new Map();
        for (let i = 0; i < paths.length; i += 50) {
            await Promise.all(paths.slice(i, i + 50).map(async path => {
                try {
                    const exists = await window.electronAPI.fileExists(path);
                    if (typeof exists === 'boolean') status.set(path, exists);
                } catch (_) { /* An unavailable check is not evidence that a file is missing. */ }
            }));
            if (revision !== _bcMediaCheckRevision) return;
        }
        if (revision !== _bcMediaCheckRevision) return;
        _bcMediaPathStatus = status;
        _bcPaintMediaStatus(false);
    }, 200);
}

// Relinking uses exact path replacements, preserving group keys, order and bindings.
function _bcRelinkCollectPaths(state) {
    const paths = new Map();
    const folderKeys = new Set(['backgroundFolder', 'overlayMediaFolder', 'assignedBackgroundFolder', 'assignedOverlayMediaFolder']);
    const mediaExts = new Set([...BC_FOLDER_BG_EXTS, 'mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'opus', 'aiff', 'aif']);
    const absolute = value => typeof value === 'string' && (/^\//.test(value) || /^[a-z]:[\\/]/i.test(value));
    function visit(value, key = '', parent = null) {
        if (typeof value === 'string') {
            if (!absolute(value)) return;
            const folder = folderKeys.has(key) || (key === 'path' && parent && Array.isArray(parent.files) && parent.kind !== 'file');
            if (folder || mediaExts.has(_bcFileExt(value))) paths.set(value, folder ? 'folder' : 'file');
        } else if (Array.isArray(value)) value.forEach(item => visit(item, key, value));
        else if (value && typeof value === 'object') Object.entries(value).forEach(([k, v]) => visit(v, k, value));
    }
    visit(state);
    return paths;
}

function _bcRelinkCandidates(oldPath, kind, entries, roots) {
    const normalize = path => String(path).replace(/\\/g, '/').replace(/\/+$/, '');
    const oldParts = normalize(oldPath).split('/');
    const candidates = new Set();
    for (const item of entries) {
        if (!item.path || item.isDirectory) continue;
        const path = normalize(item.path);
        if (kind === 'file') candidates.add(path);
        else {
            let dir = path.slice(0, path.lastIndexOf('/'));
            while (dir && roots.some(root => dir === normalize(root) || dir.startsWith(normalize(root) + '/'))) {
                candidates.add(dir);
                dir = dir.slice(0, dir.lastIndexOf('/'));
            }
        }
    }
    const matches = [...candidates].filter(path => path.split('/').pop() === oldParts[oldParts.length - 1]);
    // A preserved directory suffix is stronger evidence than the filename alone.
    const scored = matches.map(path => {
        const parts = path.split('/');
        let score = 0;
        while (score < Math.min(parts.length, oldParts.length) && parts[parts.length - 1 - score] === oldParts[oldParts.length - 1 - score]) score++;
        return { path, score };
    }).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    return scored;
}

function _bcRelinkReplace(value, replacements) {
    if (typeof value === 'string') {
        if (replacements.has(value)) return replacements.get(value);
        for (const prefix of ['file:', 'folder:']) {
            if (value.startsWith(prefix) && replacements.has(value.slice(prefix.length))) return prefix + replacements.get(value.slice(prefix.length));
        }
        return value;
    }
    if (Array.isArray(value)) return value.map(item => _bcRelinkReplace(item, replacements));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, _bcRelinkReplace(item, replacements)]));
    return value;
}

async function _bcRelinkMissingMedia(button) {
    const api = window.electronAPI;
    if (!api?.showOpenDialog || !api?.scanDirectoryRecursive || !api?.fileExists) { alert('请在桌面版中使用找回丢失素材'); return; }
    if (button.disabled) return;
    button.disabled = true;
    const label = button.textContent;
    try {
        button.textContent = '检查素材…';
        const paths = _bcRelinkCollectPaths(_bulkState);
        const missing = [];
        for (const [path, kind] of paths) if (!await api.fileExists(path)) missing.push({ path, kind });
        if (!missing.length) { alert('当前工程的素材和配乐路径都存在，无需找回。'); return; }
        const result = await api.showOpenDialog({ title: `找回 ${missing.length} 个丢失路径：选择移动后的素材目录（可多选）`, properties: ['openDirectory', 'multiSelections'] });
        if (result?.canceled || !result?.filePaths?.length) return;
        button.textContent = '搜索素材…';
        const roots = result.filePaths;
        const entries = [];
        for (const root of roots) entries.push(...await api.scanDirectoryRecursive(root, { maxDepth: 50, excludedNames: [] }));
        const rows = missing.map(item => ({ ...item, candidates: _bcRelinkCandidates(item.path, item.kind, entries, roots) }));
        const modal = document.createElement('div');
        modal.style.cssText = 'position:fixed;inset:0;z-index:300001;background:rgba(0,0,0,.85);display:flex;align-items:center;justify-content:center;';
        modal.innerHTML = `<div style="background:#1a1a2e;color:#eee;border:1px solid #444;border-radius:10px;width:min(900px,95vw);max-height:80vh;display:flex;flex-direction:column;"><div style="padding:16px;"><b>找回丢失素材</b><div style="font-size:12px;color:#aaa;margin-top:8px;">共 ${rows.length} 个丢失路径。核对新位置后应用；未找到或跳过的路径保留原绑定。组合库中引用相同旧路径的记录也会更新。</div></div><div style="overflow:auto;padding:0 16px;">${rows.map((row, index) => {
            const auto = row.candidates.length === 1 || (row.candidates.length > 1 && row.candidates[0].score >= 2 && row.candidates[0].score > row.candidates[1].score);
            return `<div style="padding:10px 0;border-top:1px solid #333;"><div style="font-size:12px;overflow-wrap:anywhere;">${row.kind === 'folder' ? '📁' : '🎵/🖼'} ${_bcEsc(row.path)}</div><select data-relink-index="${index}" style="margin-top:6px;width:100%;background:#25263b;color:#eee;padding:6px;"><option value="">${row.candidates.length ? '跳过 / 请选择新位置' : '未找到（保留旧路径）'}</option>${row.candidates.map((candidate, ci) => `<option value="${_bcEsc(candidate.path)}" ${auto && ci === 0 ? 'selected' : ''}>${_bcEsc(candidate.path)}</option>`).join('')}</select>${row.candidates.length > 1 && !auto ? '<div style="color:#fbbf24;font-size:11px;margin-top:4px;">找到多个同名路径，请选择正确位置。</div>' : ''}</div>`;
        }).join('')}</div><div style="padding:14px;display:flex;gap:10px;justify-content:flex-end;"><button data-relink-cancel class="bc-btn bc-btn-default">取消</button><button data-relink-apply class="bc-btn bc-btn-primary">应用选中的新路径</button></div></div>`;
        document.body.appendChild(modal);
        modal.querySelector('[data-relink-cancel]').onclick = () => modal.remove();
        modal.querySelector('[data-relink-apply]').onclick = async event => {
            const apply = event.currentTarget;
            apply.disabled = true;
            try {
                const replacements = new Map();
                for (const select of modal.querySelectorAll('[data-relink-index]')) {
                    if (!select.value) continue;
                    if (!await api.fileExists(select.value)) throw new Error(`新路径已不可用：${select.value}，请重新搜索。`);
                    replacements.set(rows[Number(select.dataset.relinkIndex)].path, select.value);
                }
                if (!replacements.size) { alert('请选择至少一个新路径，或取消后换目录重新搜索。'); return; }
                const next = _bcRelinkReplace(_bulkState, replacements);
                const presets = _bcRelinkReplace(_bcGetSavedPresets(), replacements);
                // Persist the library first so a storage error cannot partially mutate the active state.
                localStorage.setItem(BC_PRESETS_KEY, JSON.stringify(presets));
                Object.assign(_bulkState, next);
                _bcRenderTable(); _bcRenderBindings(); _bcScheduleDraftSave();
                modal.remove();
                alert(`已找回 ${replacements.size} 个路径；${rows.length - replacements.size} 个未更新。任务组分配已保留。`);
            } catch (error) { alert(`应用失败：${error.message || error}`); }
            finally { apply.disabled = false; }
        };
    } catch (error) { alert(`找回素材失败：${error.message || error}`); }
    finally { button.disabled = false; button.textContent = label; }
}

function _bcPresetGroups(preset) {
    const groups = _bcNumberedColumnGroups(preset);
    for (const entry of preset.groupAssignments || []) {
        if (entry?.key && !groups.some(group => group.key === entry.key)) groups.push({ key: entry.key, columns: [] });
    }
    return groups;
}

function _bcRemapPresetTemplate(template, columnMap) {
    const copied = JSON.parse(JSON.stringify(template));
    copied.bindings = {};
    Object.entries(template.bindings || {}).forEach(([field, sourceCi]) => {
        const targetCi = columnMap.get(Number(sourceCi));
        if (Number.isInteger(targetCi)) copied.bindings[field] = targetCi;
    });
    if (copied.materialFolder && Number.isInteger(copied.materialFolder.columnIndex)) {
        copied.materialFolder.columnIndex = columnMap.get(copied.materialFolder.columnIndex) ?? null;
    }
    return copied;
}

function _bcSelectPresetGroups(preset, selectedKeys) {
    const keys = new Set(selectedKeys);
    const groups = _bcPresetGroups(preset);
    const selectedGroups = groups.filter(group => keys.has(group.key));
    if (!selectedGroups.length) throw new Error('请至少选择一个任务组');
    const source = JSON.parse(JSON.stringify(preset));
    const entries = (source.groupAssignments || []).filter(entry => keys.has(entry.key));
    const columnIndices = new Set(selectedGroups.flatMap(group => group.columns.map(column => column.ci)));
    const groupedIndices = new Set(groups.flatMap(group => group.columns.map(column => column.ci)));
    const templateIndices = new Set();
    entries.forEach(entry => {
        if (Number.isInteger(entry.templateIndex) && source.templates?.[entry.templateIndex]) templateIndices.add(entry.templateIndex);
    });
    // Older presets can contain numbered headers without saved assignments.
    selectedGroups.forEach(group => {
        if (entries.some(entry => entry.key === group.key)) return;
        (source.templates || []).forEach((template, index) => {
            if (Object.values(template.bindings || {}).some(ci => group.columns.some(column => column.ci === Number(ci)))) templateIndices.add(index);
        });
    });
    const includeColumn = ci => {
        if (Number.isInteger(ci) && source.columns?.[ci]) columnIndices.add(ci);
    };
    [...templateIndices].forEach(index => {
        const template = source.templates[index];
        Object.values(template.bindings || {}).forEach(ci => {
            // Group-local default fields are rebound from the selected group's headers.
            if (!groupedIndices.has(Number(ci))) includeColumn(Number(ci));
        });
        if (Number.isInteger(template.materialFolder?.columnIndex)) includeColumn(template.materialFolder.columnIndex);
    });
    // Per-group custom bindings store header names, not column indices.
    entries.forEach(entry => Object.values(entry.bindings || {}).forEach(name => {
        if (typeof name === 'string') includeColumn((source.columns || []).findIndex(column => column.name === name));
    }));
    const columnMap = new Map([...columnIndices].sort((a, b) => a - b).map((oldCi, newCi) => [oldCi, newCi]));
    const templateMap = new Map([...templateIndices].sort((a, b) => a - b).map((oldTi, newTi) => [oldTi, newTi]));
    if (Array.isArray(source.rows)) source.rows = source.rows.map(row => [...columnMap.keys()].map(ci => row[ci] ?? ''));
    source.retainedHeaderColumns = [...columnMap.keys()].map(ci => source.retainedHeaderColumns?.[ci] || null);
    source.columns = [...columnMap.keys()].map(ci => source.columns[ci]);
    source.templates = [...templateMap.keys()].map(ti => _bcRemapPresetTemplate(source.templates[ti], columnMap));
    source.groupAssignments = Array.isArray(preset.groupAssignments) ? entries.map(entry => ({
        ...entry, templateIndex: templateMap.get(entry.templateIndex) ?? -1,
    })) : null;
    source.missingHeaderGroupKeys = [...new Set([...(source.missingHeaderGroupKeys || []).filter(key => keys.has(key)), ...selectedGroups.filter(group => !group.columns.length).map(group => group.key)])];
    const refs = _bcRelinkCollectPaths({ templates: source.templates, groupAssignments: entries });
    const referencedFolder = folder => refs.has(folder.path) || (folder.files || []).some(file => refs.has(file));
    source.backgroundFolders = (source.backgroundFolders || []).filter(referencedFolder);
    source.overlayMediaFolders = (source.overlayMediaFolders || []).filter(referencedFolder);
    const logoIds = new Set(entries.map(entry => entry.logoOverlay?.sourceId).filter(Boolean));
    source.logoMediaLibrary = (source.logoMediaLibrary || []).filter(item => logoIds.has(item.id) || refs.has(item.path));
    const usesMusicPool = entries.some(entry => ['cycle', 'random'].includes(entry.musicMode));
    source.musicFiles = (source.musicFiles || []).filter(item => usesMusicPool || refs.has(item.path));
    return source;
}

function _bcPresetSearchMatches(text, query) {
    const haystack = String(text || '').normalize('NFKC').toLocaleLowerCase();
    const words = String(query || '').normalize('NFKC').toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
    return words.every(word => haystack.includes(word));
}

function _bcPresetGroupSearchMatches(text, groupName, query) {
    const words = String(query || '').normalize('NFKC').trim().split(/\s+/).filter(Boolean);
    return words.every(word => _bcPresetSearchMatches(/^\d+$/.test(word) ? groupName : text, word));
}

function _bcPresetGroupSearchText(preset, group) {
    const entry = (preset.groupAssignments || []).find(item => item.key === group.key);
    const templates = entry ? [preset.templates?.[entry.templateIndex]].filter(Boolean)
        : (preset.templates || []).filter(template => Object.values(template.bindings || {}).some(ci => group.columns.some(column => column.ci === Number(ci))));
    const logo = (preset.logoMediaLibrary || []).find(item => item.id === entry?.logoOverlay?.sourceId);
    const folders = [...(preset.backgroundFolders || []), ...(preset.overlayMediaFolders || [])]
        .filter(folder => folder.path === entry?.backgroundFolder || folder.path === entry?.overlayMediaFolder);
    const music = (preset.musicFiles || []).filter(item => ['cycle', 'random'].includes(entry?.musicMode)
        || item.path === entry?.musicPath || Object.values(entry?.musicTaskAssignments || {}).includes(item.path));
    return [group.key, entry?.comboName, ...templates.map(template => template.label),
        entry?.backgroundFolder, entry?.overlayMediaFolder, entry?.musicPath, logo?.name, logo?.path,
        ...folders.flatMap(folder => [folder.name, folder.path]), ...music.flatMap(item => [item.name, item.path])].filter(Boolean).join(' ');
}

function _bcChoosePresetGroups(preset, name, mode, apply) {
    const groups = _bcPresetGroups(preset);
    if (!groups.length) { apply(JSON.parse(JSON.stringify(preset))); return; }
    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;inset:0;z-index:300001;background:rgba(0,0,0,.85);display:flex;align-items:center;justify-content:center;';
    const action = mode === 'append' ? '追加' : '替换加载';
    modal.innerHTML = `<div style="background:#1a1a2e;color:#eee;border:1px solid #444;border-radius:10px;width:min(650px,95vw);max-height:80vh;display:flex;flex-direction:column;">
        <div style="padding:14px 16px;border-bottom:1px solid #333;"><b>选择任务组 · ${_bcEsc(name)}</b><div style="margin-top:7px;color:#aaa;font-size:12px;line-height:1.5;">仅${action}勾选的任务组及其绑定的模板、字段、素材和配乐。循环或随机配乐会带入所需的配乐库。${mode === 'append' ? '同名任务组保留当前已有分配。' : '将替换当前配置。'}</div>
        <input data-preset-groups-search class="bc-input" type="search" aria-label="搜索任务组" placeholder="搜索任务组、模板、素材或配乐名称…" style="width:100%;box-sizing:border-box;margin-top:10px;height:30px;">
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:10px;"><button data-preset-groups-matches class="bc-btn bc-btn-purple bc-btn-xs">仅勾选搜索结果</button><button data-preset-groups-all class="bc-btn bc-btn-default bc-btn-xs">全选</button><button data-preset-groups-none class="bc-btn bc-btn-default bc-btn-xs">全不选</button><span data-preset-groups-count style="color:#c4b5fd;font-size:11px;"></span></div></div>
        <div style="overflow:auto;padding:0 16px;">${groups.map((group, index) => {
            const entry = (preset.groupAssignments || []).find(item => item.key === group.key);
            const template = preset.templates?.[entry?.templateIndex];
            const background = (preset.backgroundFolders || []).find(item => item.path === entry?.backgroundFolder);
            const music = (preset.musicFiles || []).find(item => item.path === entry?.musicPath);
            const musicLabel = ['cycle', 'random'].includes(entry?.musicMode) ? '配乐库轮换/随机' : music?.name || _bcFileName(entry?.musicPath || '') || '沿用模板';
            const exists = mode === 'append' && (_bulkState.groupAssignments || []).some(item => item.key === group.key);
            return `<label data-preset-group-row data-search-group-name="${_bcEsc([group.key, entry?.comboName].filter(Boolean).join(' '))}" data-search-text="${_bcEsc(_bcPresetGroupSearchText(preset, group))}" style="display:flex;gap:9px;align-items:flex-start;padding:10px 0;border-bottom:1px solid #333;cursor:pointer;"><input type="checkbox" data-preset-group-index="${index}" checked style="margin-top:3px;accent-color:#7c5cff;"><div style="min-width:0;"><div style="font-size:12px;font-weight:600;overflow-wrap:anywhere;">${_bcEsc(group.key)}${entry?.comboName ? ` · ${_bcEsc(entry.comboName)}` : ''}${exists ? ' <span style="color:#fbbf24;">（已有同名组，保留当前分配）</span>' : ''}</div><div style="color:#aaa;font-size:11px;margin-top:4px;overflow-wrap:anywhere;">${group.columns.length} 列 · 模板：${_bcEsc(template?.label || '未分配 / 原逐列绑定')} · 背景：${_bcEsc(background?.name || _bcFileName(entry?.backgroundFolder || '') || '沿用模板')} · 配乐：${_bcEsc(musicLabel)}</div></div></label>`;
        }).join('')}<div data-preset-groups-empty style="display:none;padding:20px 0;text-align:center;color:#aaa;font-size:12px;">没有匹配的任务组</div></div>
        <div style="padding:12px 16px;display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;"><button data-preset-groups-full class="bc-btn bc-btn-default bc-btn-sm" title="包含未分配给任务组的模板和素材">${action}完整组合</button><button data-preset-groups-cancel class="bc-btn bc-btn-default bc-btn-sm">取消</button><button data-preset-groups-apply class="bc-btn bc-btn-primary bc-btn-sm">${action}所选任务组</button></div></div>`;
    document.body.appendChild(modal);
    const selected = () => Array.from(modal.querySelectorAll('[data-preset-group-index]:checked')).map(input => groups[Number(input.dataset.presetGroupIndex)].key);
    const updateCount = () => {
        const count = selected().length;
        const visible = Array.from(modal.querySelectorAll('[data-preset-group-row]')).filter(row => row.style.display !== 'none').length;
        modal.querySelector('[data-preset-groups-count]').textContent = `已选 ${count}/${groups.length} 个任务组 · 显示 ${visible} 个（隐藏项仍保留勾选）`;
        modal.querySelector('[data-preset-groups-apply]').disabled = !count;
    };
    const filterGroups = () => {
        let visible = 0;
        const query = modal.querySelector('[data-preset-groups-search]').value;
        modal.querySelectorAll('[data-preset-group-row]').forEach(row => {
            const matches = _bcPresetGroupSearchMatches(row.dataset.searchText, row.dataset.searchGroupName, query);
            row.style.display = matches ? 'flex' : 'none';
            if (matches) visible++;
        });
        modal.querySelector('[data-preset-groups-empty]').style.display = visible ? 'none' : 'block';
        modal.querySelector('[data-preset-groups-matches]').disabled = !visible;
        updateCount();
    };
    modal.querySelector('[data-preset-groups-search]').oninput = filterGroups;
    modal.querySelector('[data-preset-groups-search]').onchange = filterGroups;
    modal.querySelector('[data-preset-groups-search]').oncompositionend = filterGroups;
    modal.querySelector('[data-preset-groups-matches]').onclick = () => {
        modal.querySelectorAll('[data-preset-group-row]').forEach(row => {
            row.querySelector('[data-preset-group-index]').checked = row.style.display !== 'none';
        });
        updateCount();
    };
    modal.addEventListener('change', updateCount);
    modal.querySelector('[data-preset-groups-all]').onclick = () => { modal.querySelectorAll('[data-preset-group-index]').forEach(input => input.checked = true); updateCount(); };
    modal.querySelector('[data-preset-groups-none]').onclick = () => { modal.querySelectorAll('[data-preset-group-index]').forEach(input => input.checked = false); updateCount(); };
    modal.querySelector('[data-preset-groups-cancel]').onclick = () => modal.remove();
    modal.querySelector('[data-preset-groups-full]').onclick = () => { apply(JSON.parse(JSON.stringify(preset))); modal.remove(); };
    modal.querySelector('[data-preset-groups-apply]').onclick = () => {
        try { apply(_bcSelectPresetGroups(preset, selected()), true); modal.remove(); }
        catch (error) { alert(error.message || error); }
    };
    filterGroups();
}

function _bcApplySavedPreset(p, name, mode, selectedOnly = false) {
    if (mode === 'append') {
            const existingColumns = _bulkState.columns || [];
            const sourceColumns = p.columns || [];
            const columnMap = new Map();
            const newColumnIndices = new Set();
            const existingByIdentity = new Map();
            existingColumns.forEach((column, ci) => {
                const identity = `${String(column?.type || 'text')}\\u0000${String(column?.name || '').trim()}`;
                if (!existingByIdentity.has(identity)) existingByIdentity.set(identity, []);
                existingByIdentity.get(identity).push(ci);
            });
            const consumedByIdentity = new Map();
            sourceColumns.forEach((column, sourceCi) => {
                const identity = `${String(column?.type || 'text')}\\u0000${String(column?.name || '').trim()}`;
                const matches = existingByIdentity.get(identity) || [];
                const used = consumedByIdentity.get(identity) || 0;
                if (String(column?.name || '').trim() && matches[used] != null) {
                    columnMap.set(sourceCi, matches[used]);
                    consumedByIdentity.set(identity, used + 1);
                } else {
                    const nextCi = existingColumns.length;
                    existingColumns.push(JSON.parse(JSON.stringify(column || { name: '', type: 'text' })));
                    columnMap.set(sourceCi, nextCi);
                    newColumnIndices.add(nextCi);
                }
            });
            const startTemplateIndex = (_bulkState.templates || []).length;
            const copiedTemplates = (p.templates || []).map(template => _bcRemapPresetTemplate(template, columnMap));
            _bulkState.templates.push(...copiedTemplates);
            if (!Array.isArray(_bulkState.retainedHeaderColumns)) _bulkState.retainedHeaderColumns = [];
            columnMap.forEach((targetCi, sourceCi) => {
                if (p.retainedHeaderColumns?.[sourceCi] && !_bulkState.retainedHeaderColumns[targetCi]) {
                    _bulkState.retainedHeaderColumns[targetCi] = JSON.parse(JSON.stringify(p.retainedHeaderColumns[sourceCi]));
                }
            });
            const mergeByPath = (target, incoming) => (incoming || []).forEach(item => {
                if (item?.path && !target.some(current => current?.path === item.path)) target.push(JSON.parse(JSON.stringify(item)));
            });
            mergeByPath(_bulkState.backgroundFolders, p.backgroundFolders);
            mergeByPath(_bulkState.overlayMediaFolders, p.overlayMediaFolders);
            (p.logoMediaLibrary || []).forEach(item => {
                if (item?.id && !_bulkState.logoMediaLibrary.some(current => current.id === item.id)) _bulkState.logoMediaLibrary.push(JSON.parse(JSON.stringify(item)));
            });
            mergeByPath(_bulkState.musicFiles, p.musicFiles);
            if (!Array.isArray(_bulkState.groupAssignments)) _bulkState.groupAssignments = [];
            _bulkState.missingHeaderGroupKeys = [...new Set([...(_bulkState.missingHeaderGroupKeys || []), ...(p.missingHeaderGroupKeys || [])])];
            let addedAssignments = 0;
            (p.groupAssignments || []).forEach(sourceEntry => {
                const sourceTi = Number(sourceEntry?.templateIndex);
                const templateIndex = Number.isInteger(sourceTi) && sourceTi >= 0 && copiedTemplates[sourceTi] ? startTemplateIndex + sourceTi : -1;
                // 同名任务组是同一组：追加不覆盖用户当前已有的分配。
                if (_bulkState.groupAssignments.some(entry => entry?.key === sourceEntry?.key)) return;
                const copiedEntry = JSON.parse(JSON.stringify(sourceEntry));
                copiedEntry.templateIndex = templateIndex;
                _bulkState.groupAssignments.push(copiedEntry);
                addedAssignments++;
            });
            if (Array.isArray(p.rows)) {
                while (_bulkState.rows.length < p.rows.length) _bulkState.rows.push([]);
            }
            _bulkState.rows.forEach((row, ri) => {
                while (row.length < existingColumns.length) row.push('');
                if (Array.isArray(p.rows)) columnMap.forEach((targetCi, sourceCi) => {
                    if (newColumnIndices.has(targetCi)) row[targetCi] = p.rows[ri]?.[sourceCi] ?? '';
                });
            });
            if (_bulkState.rows.length === 0) for (let i = 0; i < 20; i++) _bulkState.rows.push(new Array(existingColumns.length).fill(''));
            if (typeof showToast === 'function') showToast(`已追加「${name}」：${copiedTemplates.length} 个模板、${sourceColumns.length} 个表头来源、${addedAssignments} 个新任务组分配`, 'success', 6000);
    } else {
            const oldColumns = _bulkState.columns || [];
            const oldRows = _bulkState.rows || [];
            _bulkState.columns = JSON.parse(JSON.stringify(p.columns || []));
            _bulkState.backgroundFolders = p.backgroundFolders || [];
            _bulkState.overlayMediaFolders = p.overlayMediaFolders || [];
            _bulkState.logoMediaLibrary = p.logoMediaLibrary || [];
            _bulkState.musicFiles = p.musicFiles || [];
            _bulkState.groupAssignments = p.groupAssignments || null;
            _bulkState.missingHeaderGroupKeys = Array.isArray(p.missingHeaderGroupKeys)
                ? p.missingHeaderGroupKeys : [];
            _bulkState.retainedHeaderColumns = p.retainedHeaderColumns || [];
            _bulkState.allowTemplateReuse = !!p.allowTemplateReuse;
            _bulkState.allowBackgroundReuse = !!p.allowBackgroundReuse;
            _bulkState.allowMusicReuse = !!p.allowMusicReuse;
            _bulkState.templates = (p.templates || []).map(t => ({ bulkTemplateId: t.bulkTemplateId, task: t.task, label: t.label, bindings: { ...t.bindings }, bgCycle: t.bgCycle || null, source: t.source || null, materialFolder: t.materialFolder || null }));
            // A subset may reorder columns; keep copywriting attached to its header.
            if (Array.isArray(p.rows)) {
                _bulkState.rows = JSON.parse(JSON.stringify(p.rows));
                _bulkState.rowPresetMode = !!p.rowPresetMode;
                _bulkState.rowTemplateIds = JSON.parse(JSON.stringify(p.rowTemplateIds || []));
                _bulkState.cellPresetMode = !!p.cellPresetMode;
                _bulkState.cellTemplateIds = JSON.parse(JSON.stringify(p.cellTemplateIds || []));
            } else if (selectedOnly) {
                const matches = new Map();
                oldColumns.forEach((column, ci) => {
                    const identity = JSON.stringify([column?.type || 'text', column?.name || '']);
                    if (!matches.has(identity)) matches.set(identity, []);
                    matches.get(identity).push(ci);
                });
                const used = new Map();
                const sourceIndices = _bulkState.columns.map(column => {
                    const identity = JSON.stringify([column?.type || 'text', column?.name || '']);
                    const occurrence = used.get(identity) || 0;
                    used.set(identity, occurrence + 1);
                    return matches.get(identity)?.[occurrence];
                });
                _bulkState.rows = oldRows.map(row => sourceIndices.map(ci => ci == null ? '' : row[ci] ?? ''));
            }
            _bulkState.rows.forEach(r => {
                while (r.length < _bulkState.columns.length) r.push('');
                if (r.length > _bulkState.columns.length) r.length = _bulkState.columns.length;
            });
            if (_bulkState.rows.length === 0) {
                for (let i = 0; i < 20; i++) _bulkState.rows.push(new Array(_bulkState.columns.length).fill(''));
            }
    }
    _bcRenderTable(); _bcRenderBindings(); _bcScheduleDraftSave();
}

function _bcRenameSavedPreset(oldName, newName) {
    const current = _bcGetSavedPresets();
    if (Object.prototype.hasOwnProperty.call(current, newName)) throw new Error('这个名称已存在，请换一个名称。');
    if (!Object.prototype.hasOwnProperty.call(current, oldName)) throw new Error('此组合已不存在，请重新打开组合库。');
    const renamed = Object.fromEntries(Object.entries(current).map(([key, value]) => [key === oldName ? newName : key, value]));
    localStorage.setItem(BC_PRESETS_KEY, JSON.stringify(renamed));
}

function _bcLoadPreset() {
    const presets = _bcGetSavedPresets();
    const names = Object.keys(presets);
    if (names.length === 0) { alert('暂无保存的大量制作模版'); return; }
    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:300000;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;';
    let list = '';
    names.forEach(n => {
        const p = presets[n];
        const colCount = (p.columns||[]).length;
        const tplCount = (p.templates||[]).length;
        const groupCount = _bcPresetGroups(p).length;
        const date = p.savedAt ? new Date(p.savedAt).toLocaleDateString() : '';
        const isViral = p.category === 'viral';
        list += `<div class="bc-preset-row" data-category="${isViral ? 'viral' : 'regular'}" data-search-text="${_bcEsc(n)}" style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;border-bottom:1px solid #222;">
            <div style="flex:1;">
                <div style="color:#eee;font-size:12px;font-weight:600;">${isViral ? '🔥 ' : ''}${_bcEsc(n)}</div>
                <div style="color:#666;font-size:10px;">${isViral ? '爆帖组合 · ' : ''}${colCount}列 · ${tplCount}模板 · ${groupCount}个任务组 · ${date}</div>
            </div>
            <div style="display:flex;gap:4px;">
                <button class="bc-preset-append" data-name="${_bcEsc(n)}" title="保留当前表格、模板和任务组，将此组合的模板与素材追加进来" style="padding:3px 8px;background:rgba(16,185,129,.14);border:1px solid rgba(16,185,129,.32);border-radius:4px;color:#6ee7b7;cursor:pointer;font-size:10px;">＋追加</button>
                <button class="bc-preset-load" data-name="${_bcEsc(n)}" title="用这个组合替换当前大量制作配置" style="padding:3px 10px;background:rgba(124,92,255,0.2);border:1px solid rgba(124,92,255,0.3);border-radius:4px;color:#b8a0ff;cursor:pointer;font-size:10px;">替换加载</button>
                <button class="bc-preset-rename bc-btn bc-btn-default bc-btn-xs" data-name="${_bcEsc(n)}">改名</button>
                <button class="bc-preset-del" data-name="${_bcEsc(n)}" style="padding:3px 8px;background:rgba(255,80,80,0.1);border:1px solid rgba(255,80,80,0.2);border-radius:4px;color:#f88;cursor:pointer;font-size:10px;">删除</button>
            </div>
        </div>`;
    });
    modal.innerHTML = `<div style="background:#1a1a2e;border:1px solid #333;border-radius:10px;width:420px;max-height:60vh;display:flex;flex-direction:column;">
        <div style="padding:12px 16px;border-bottom:1px solid #333;display:flex;justify-content:space-between;align-items:center;">
            <span style="color:#fff;font-weight:600;">📂 组合库</span>
            <button class="bc-preset-close" style="padding:3px 10px;background:rgba(255,255,255,0.05);border:1px solid #333;border-radius:5px;color:#888;cursor:pointer;font-size:11px;">关闭</button>
        </div>
        <div style="padding:7px 16px;color:#8e92b2;font-size:10px;line-height:1.4;border-bottom:1px solid #2b2c40;">点击“替换加载”或“＋追加”后，可勾选需要的任务组。“替换加载”会替换当前配置；“＋追加”会保留当前内容。同名表头复用现有列，已有任务组分配不会被覆盖。</div>
        <div style="padding:8px 12px;border-bottom:1px solid #2b2c40;"><input class="bc-preset-search bc-input" type="search" aria-label="搜索组合预设" placeholder="搜索保存的组合名称…" style="width:100%;box-sizing:border-box;height:30px;"></div>
        <div style="padding:8px 12px;border-bottom:1px solid #2b2c40;display:flex;gap:6px;"><button class="bc-preset-filter" data-filter="all">全部 (${names.length})</button><button class="bc-preset-filter" data-filter="viral">🔥 爆帖组合 (${names.filter(n => presets[n].category === 'viral').length})</button><button class="bc-preset-filter" data-filter="regular">常规组合</button></div>
        <div style="overflow:auto;flex:1;">${list}<div class="bc-preset-empty" style="display:none;padding:20px;text-align:center;color:#aaa;font-size:12px;">没有匹配的组合</div></div>
    </div>`;
    document.body.appendChild(modal);
    modal.querySelector('.bc-preset-close').onclick = () => modal.remove();
    let activeFilter = 'all';
    const filterPresets = () => {
        const query = modal.querySelector('.bc-preset-search').value;
        let visible = 0;
        modal.querySelectorAll('.bc-preset-row').forEach(row => {
            const matches = (activeFilter === 'all' || row.dataset.category === activeFilter)
                && _bcPresetSearchMatches(row.dataset.searchText, query);
            row.style.display = matches ? 'flex' : 'none';
            if (matches) visible++;
        });
        modal.querySelector('.bc-preset-empty').style.display = visible ? 'none' : 'block';
    };
    modal.querySelector('.bc-preset-search').oninput = filterPresets;
    modal.addEventListener('click', async e => {
        const t = e.target;
        if (t.classList.contains('bc-preset-filter')) {
            activeFilter = t.dataset.filter;
            filterPresets();
            return;
        }
        if (t.classList.contains('bc-preset-append') || t.classList.contains('bc-preset-load')) {
            const name = t.dataset.name;
            const p = presets[name];
            if (!p) return;
            const mode = t.classList.contains('bc-preset-append') ? 'append' : 'replace';
            _bcChoosePresetGroups(p, name, mode, (selectedPreset, selectedOnly) => {
                _bcApplySavedPreset(selectedPreset, name, mode, selectedOnly);
                modal.remove();
            });
            return;
        }
        if (t.classList.contains('bc-preset-rename')) {
            const oldName = t.dataset.name;
            const answer = await _bcPrompt('修改组合名称', oldName);
            const newName = answer?.trim();
            if (!newName || newName === oldName) return;
            try {
                _bcRenameSavedPreset(oldName, newName);
                modal.remove(); _bcLoadPreset();
            } catch (error) { alert(`改名失败，原组合已保留：${error.message || error}`); }
            return;
        }
        if (t.classList.contains('bc-preset-del')) {
            const name = t.dataset.name;
            if (!confirm(`删除模版「${name}」？`)) return;
            delete presets[name];
            localStorage.setItem(BC_PRESETS_KEY, JSON.stringify(presets));
            t.closest('div[style*="border-bottom"]').remove();
            return;
        }
    });
}

function _bcExportPreset() {
    const presets = _bcGetSavedPresets();
    const names = Object.keys(presets);
    if (names.length === 0) { alert('暂无保存的大量制作模版可导出'); return; }

    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:300000;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;';
    let list = '';
    names.forEach(n => {
        const p = presets[n];
        const tplCount = (p.templates || []).length;
        const colCount = (p.columns || []).length;
        const groupCount = _bcPresetGroups(p).length;
        const date = p.savedAt ? new Date(p.savedAt).toLocaleDateString() : '';
        list += `<label style="display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid #222;cursor:pointer;">
            <input type="checkbox" class="bc-export-cb" data-name="${_bcEsc(n)}" checked>
            <div style="flex:1;">
                <div style="color:#eee;font-size:12px;font-weight:600;">${_bcEsc(n)}</div>
                <div style="color:#666;font-size:10px;">${colCount}列 · ${tplCount}模板 · ${groupCount}个任务组 · ${date}</div>
            </div>
        </label>`;
    });
    modal.innerHTML = `<div style="background:#1a1a2e;border:1px solid #333;border-radius:10px;width:440px;max-height:65vh;display:flex;flex-direction:column;">
        <div style="padding:12px 16px;border-bottom:1px solid #333;display:flex;justify-content:space-between;align-items:center;">
            <span style="color:#fff;font-weight:600;">⬆ 选择要导出的模版</span>
            <div style="display:flex;gap:6px;">
                <button class="bc-export-all" style="padding:3px 10px;background:rgba(124,92,255,0.2);border:1px solid rgba(124,92,255,0.3);border-radius:5px;color:#b8a0ff;cursor:pointer;font-size:11px;">全选</button>
                <button class="bc-export-none" style="padding:3px 10px;background:rgba(255,255,255,0.05);border:1px solid #333;border-radius:5px;color:#888;cursor:pointer;font-size:11px;">全不选</button>
            </div>
        </div>
        <div style="overflow:auto;flex:1;">${list}</div>
        <div style="padding:10px 16px;border-top:1px solid #333;display:flex;justify-content:space-between;align-items:center;">
            <span class="bc-export-count" style="color:#888;font-size:11px;">已选 ${names.length}/${names.length}</span>
            <div style="display:flex;gap:6px;">
                <button class="bc-export-ok" style="padding:5px 18px;background:linear-gradient(135deg,#7c5cff,#a855f7);border:none;border-radius:5px;color:#fff;cursor:pointer;font-size:12px;font-weight:600;">导出</button>
                <button class="bc-export-cancel" style="padding:3px 10px;background:rgba(255,255,255,0.05);border:1px solid #333;border-radius:5px;color:#888;cursor:pointer;font-size:11px;">取消</button>
            </div>
        </div>
    </div>`;
    document.body.appendChild(modal);

    const updateCount = () => {
        const checked = modal.querySelectorAll('.bc-export-cb:checked').length;
        const total = modal.querySelectorAll('.bc-export-cb').length;
        const countEl = modal.querySelector('.bc-export-count');
        if (countEl) countEl.textContent = `已选 ${checked}/${total}`;
    };
    modal.addEventListener('change', updateCount);
    modal.querySelector('.bc-export-all').onclick = () => { modal.querySelectorAll('.bc-export-cb').forEach(cb => cb.checked = true); updateCount(); };
    modal.querySelector('.bc-export-none').onclick = () => { modal.querySelectorAll('.bc-export-cb').forEach(cb => cb.checked = false); updateCount(); };
    modal.querySelector('.bc-export-cancel').onclick = () => modal.remove();
    modal.querySelector('.bc-export-ok').onclick = () => {
        const selected = Array.from(modal.querySelectorAll('.bc-export-cb:checked')).map(cb => cb.dataset.name);
        if (selected.length === 0) { alert('请至少选择一个模版'); return; }
        const exportData = {};
        selected.forEach(name => { if (presets[name]) exportData[name] = presets[name]; });
        const data = {
            type: 'bulk_create_preset',
            version: 1,
            presets: exportData,
            exportedAt: new Date().toISOString(),
        };
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `bulk_presets_${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(a.href);
        modal.remove();
    };
}

function _bcMergeImportedPresets(existing, incoming) {
    const presets = Object.fromEntries(Object.entries(existing));
    const reserved = new Set([...Object.keys(existing), ...Object.keys(incoming)]);
    const renamed = [];
    for (const [name, preset] of Object.entries(incoming)) {
        let targetName = name;
        if (Object.prototype.hasOwnProperty.call(presets, name)) {
            let index = 1;
            do { targetName = `${name}（导入${index++}）`; } while (reserved.has(targetName));
            renamed.push({ from: name, to: targetName });
        }
        reserved.add(targetName);
        Object.defineProperty(presets, targetName, { value: preset, enumerable: true, writable: true, configurable: true });
    }
    return { presets, renamed };
}

function _bcImportPreset() {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.json';
    input.onchange = e => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = ev => {
            try {
                const data = JSON.parse(ev.target.result);
                if (data.type !== 'bulk_create_preset') { alert('不是有效的大量制作模版文件'); return; }

                // New multi-preset format: merge into preset library
                if (data.presets && typeof data.presets === 'object') {
                    const existing = _bcGetSavedPresets();
                    const importNames = Object.keys(data.presets);
                    const { presets, renamed } = _bcMergeImportedPresets(existing, data.presets);
                    localStorage.setItem(BC_PRESETS_KEY, JSON.stringify(presets));
                    const renameText = renamed.length ? `\n同名预设已另存为：\n${renamed.map(item => `${item.from} → ${item.to}`).join('\n')}` : '';
                    alert(`✅ 已新增导入 ${importNames.length} 个预设，原有预设全部保留。${renameText}`);
                    return;
                }

                // Legacy single-preset format: load directly into current state
                if (!data.columns) { alert('不是有效的大量制作模版文件'); return; }
                _bulkState.columns = data.columns;
                _bulkState.backgroundFolders = data.backgroundFolders || [];
                _bulkState.musicFiles = data.musicFiles || [];
                _bulkState.groupAssignments = data.groupAssignments || null;
                _bulkState.missingHeaderGroupKeys = Array.isArray(data.missingHeaderGroupKeys)
                    ? data.missingHeaderGroupKeys : [];
                _bulkState.allowTemplateReuse = !!data.allowTemplateReuse;
                _bulkState.templates = (data.templates || []).map(t => ({ task: t.task, label: t.label, bindings: { ...t.bindings }, bgCycle: t.bgCycle || null, source: t.source || null, materialFolder: t.materialFolder || null }));
                _bulkState.rows.forEach(r => {
                    while (r.length < _bulkState.columns.length) r.push('');
                    if (r.length > _bulkState.columns.length) r.length = _bulkState.columns.length;
                });
                if (_bulkState.rows.length === 0) {
                    for (let i = 0; i < 20; i++) _bulkState.rows.push(new Array(_bulkState.columns.length).fill(''));
                }
                _bcRenderTable(); _bcRenderBindings();
                alert(`✅ 已导入：${_bulkState.columns.length}列 · ${_bulkState.templates.length}模板`);
            } catch(err) { alert('导入失败：' + err.message); }
        };
        reader.readAsText(file);
    };
    input.click();
}

// ── Main Modal ──
// Spreadsheet clipboard cells can contain quoted tabs, newlines and blank lines.
function _bcParseTSV(text) {
    const src = String(text || '').replace(/\r\n?/g, '\n');
    const rows = [];
    let row = [], cell = '', quoted = false;
    for (let i = 0; i < src.length; i++) {
        const ch = src[i];
        if (quoted) {
            if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; }
            else if (ch === '"' && (i + 1 === src.length || src[i + 1] === '\t' || src[i + 1] === '\n')) quoted = false;
            else cell += ch;
        } else if (ch === '"' && cell === '') quoted = true;
        else if (ch === '\t') { row.push(cell); cell = ''; }
        else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
        else cell += ch;
    }
    // A final record separator is not an additional row; interior empty rows are real.
    if (cell !== '' || row.length || (src.length && !src.endsWith('\n'))) { row.push(cell); rows.push(row); }
    return rows;
}

function _bcParseClipboardTable(html) {
    if (!html || typeof DOMParser === 'undefined') return null;
    try {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const table = doc.querySelector('table');
        if (!table) return null;
        const rows = [];
        const extract = cell => {
            const sheetsValue = cell.getAttribute('data-sheets-value');
            if (sheetsValue) {
                try { const value = JSON.parse(sheetsValue); if (typeof value['2'] === 'string') return value['2'].replace(/\r\n?/g, '\n'); } catch (_) { }
            }
            const walk = node => {
                if (node.nodeType === 3) return node.nodeValue || '';
                if (node.nodeType !== 1) return '';
                if (node.tagName === 'BR') return '\n';
                if (['SCRIPT', 'STYLE'].includes(node.tagName)) return '';
                return Array.from(node.childNodes).map((child, index) => {
                    const text = walk(child);
                    return index && ['DIV', 'P'].includes(child.tagName) ? '\n' + text : text;
                }).join('');
            };
            return walk(cell).replace(/\r\n?/g, '\n');
        };
        for (const tr of table.querySelectorAll('tr')) {
            if (tr.closest('table') !== table) continue;
            const ri = rows.length;
            const row = rows[ri] || [];
            let ci = 0;
            for (const cell of tr.children) {
                if (!['TD', 'TH'].includes(cell.tagName)) continue;
                while (row[ci] !== undefined) ci++;
                row[ci] = extract(cell);
                const width = Math.max(1, Number(cell.getAttribute('colspan')) || 1);
                for (let offset = 1; offset < width; offset++) row[ci + offset] = '';
                ci += width;
            }
            rows.push(row);
        }
        return rows.length ? rows : null;
    } catch (_) { return null; }
}

async function _bcReadClipboardGrid() {
    if (navigator.clipboard?.read) {
        try {
            const items = await navigator.clipboard.read();
            for (const item of items) {
                if (!item.types.includes('text/html')) continue;
                const rows = _bcParseClipboardTable(await (await item.getType('text/html')).text());
                if (rows) return rows;
            }
            for (const item of items) if (item.types.includes('text/plain')) return await (await item.getType('text/plain')).text();
        } catch (_) { /* readText remains available on some Electron versions. */ }
    }
    return await navigator.clipboard.readText();
}

function _showBulkCreateModal() {
    const existing = document.getElementById('bc-modal');
    if (_bcModalAbort) {
        _bcModalAbort.abort();
        _bcModalAbort = null;
    }
    if (existing) existing.remove();
    _bcMediaPathStatus = new Map();
    _bcLoadDraftOnce();
    if (_bulkState.rows.length === 0) {
        for (let i = 0; i < 20; i++) _bulkState.rows.push(new Array(_bulkState.columns.length).fill(''));
    }
    _bcNormalizeStateShape();
    _bcModalAbort = new AbortController();
    const bcModalSignal = _bcModalAbort.signal;
    const ov = document.createElement('div');
    ov.id = 'bc-modal';
    ov.style.cssText = 'position:fixed;top:32px;left:0;right:0;bottom:0;z-index:200000;background:rgba(0,0,0,0.95);display:flex;flex-direction:column;font-family:system-ui,-apple-system,sans-serif;isolation:isolate;border-top:1px solid #333;';
    
    let style = document.getElementById('bc-styles');
    if (!style) {
        style = document.createElement('style');
        style.id = 'bc-styles';
        document.head.appendChild(style);
    }
    style.innerHTML = `
            .bc-data-table {
                width: max-content;
                min-width: 100%;
                border-collapse: separate;
                border-spacing: 0;
                table-layout: fixed;
                background: #0a0a14;
            }
            .bc-data-table th {
                position: sticky;
                top: 0;
                z-index: 2;
                background: #121222;
                border: 1px solid #252535;
                border-left: 0;
                height: 26px;
            }
            .bc-data-table td {
                border: 1px solid #222235;
                border-left: 0;
                border-top: 0;
                height: 34px;
                padding: 0;
                background: #0a0a14;
            }
            .bc-grid-td {
                min-width: 140px;
                max-width: 240px;
                position: relative;
                cursor: cell;
                user-select: none;
            }
            .bc-cell {
                height: 34px;
                line-height: 34px;
                padding: 0 6px;
                overflow: hidden;
                white-space: nowrap;
                text-overflow: ellipsis;
                color: #cfd0dc;
                font-size: 11px;
                box-sizing: border-box;
            }
            .bc-cell-media {
                color: #aab2c4;
                font-size: 10px;
                display: flex;
                align-items: center;
                gap: 6px;
                line-height: 1.2;
            }
            .bc-media-thumb {
                width: 26px;
                height: 26px;
                flex: 0 0 26px;
                object-fit: cover;
                border-radius: 3px;
                background: #05050a;
                border: 1px solid #333348;
                display: block;
            }
            .bc-media-icon {
                width: 26px;
                height: 26px;
                flex: 0 0 26px;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                border-radius: 3px;
                background: #151526;
                border: 1px solid #333348;
                font-size: 13px;
            }
            .bc-media-name {
                min-width: 0;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            .bc-cell-placeholder {
                display: inline-block;
                width: 1px;
            }
            .bc-grid-td.bc-selected-cell {
                background-color: rgba(124,92,255,0.2) !important;
                box-shadow: inset 0 0 0 1px rgba(124,92,255,0.95) !important;
                outline: none !important;
            }
            .bc-grid-td.bc-selected-cell .bc-cell {
                background-color: rgba(124,92,255,0.18) !important;
                color: #fff !important;
            }
            .bc-grid-td.bc-anchor-cell {
                box-shadow: inset 0 0 0 2px #7c5cff !important;
                background-color: rgba(124,92,255,0.28) !important;
                z-index: 1;
            }
            .bc-grid-td.bc-anchor-cell .bc-cell {
                background-color: rgba(124,92,255,0.24) !important;
            }
            .bc-grid-td.bc-media-drop-target,
            .bc-media-col-header.bc-media-drop-target {
                background: rgba(46,213,115,0.18) !important;
                box-shadow: inset 0 0 0 2px #2ed573 !important;
            }
            .bc-grid-td.bc-media-drop-target .bc-cell {
                background: rgba(46,213,115,0.16) !important;
                color: #eafff2 !important;
            }
            .bc-media-col-header {
                cursor: copy;
            }
            .bc-bg-folder-row {
                display: flex;
                align-items: center;
                gap: 8px;
                padding: 6px 8px;
                margin-top: 5px;
                background: rgba(255,255,255,0.02);
                border: 1px solid rgba(124,92,255,0.18);
                border-radius: 6px;
                transition: border-color 0.15s, background 0.15s;
            }
            .bc-bg-folder-row:hover {
                border-color: rgba(124,92,255,0.45);
                background: rgba(255,255,255,0.05);
            }
            .bc-bg-folder-thumb {
                width: 48px;
                height: 66px;
                flex: 0 0 48px;
                border-radius: 5px;
                overflow: hidden;
                background: #0c0c16;
                border: 1px solid #36364e;
                display: flex;
                align-items: center;
                justify-content: center;
                position: relative;
                cursor: pointer;
                transition: transform 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease;
            }
            .bc-bg-folder-thumb:hover {
                border-color: #a78bfa;
                box-shadow: 0 0 8px rgba(124,92,255,0.45);
                transform: scale(1.04);
            }
            .bc-music-row {
                display: flex;
                align-items: center;
                gap: 8px;
                padding: 5px 8px;
                margin-top: 5px;
                background: rgba(255,255,255,0.02);
                border: 1px solid rgba(52,211,153,0.18);
                border-radius: 6px;
                transition: border-color 0.15s, background 0.15s;
            }
            .bc-music-row:hover {
                border-color: rgba(52,211,153,0.45);
                background: rgba(255,255,255,0.05);
            }

            /* Custom sleek scrollbars */
            #bc-table-body::-webkit-scrollbar,
            #bc-bind-panel::-webkit-scrollbar {
                width: 6px;
                height: 6px;
            }
            #bc-table-body::-webkit-scrollbar-track,
            #bc-bind-panel::-webkit-scrollbar-track {
                background: #0b0c16;
            }
            #bc-table-body::-webkit-scrollbar-thumb,
            #bc-bind-panel::-webkit-scrollbar-thumb {
                background: #25273c;
                border-radius: 3px;
            }
            #bc-table-body::-webkit-scrollbar-thumb:hover,
            #bc-bind-panel::-webkit-scrollbar-thumb:hover {
                background: #3e4268;
            }

            /* Buttons */
            .bc-btn {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                gap: 4px;
                height: 24px;
                padding: 0 8px;
                font-size: 11px;
                font-weight: 500;
                border-radius: 5px;
                border: 1px solid transparent;
                cursor: pointer;
                transition: all 0.15s ease;
                user-select: none;
                white-space: nowrap;
                box-sizing: border-box;
            }
            .bc-btn:hover {
                filter: brightness(1.12);
            }
            .bc-btn:active {
                transform: translateY(1px);
            }
            .bc-btn-default {
                background: rgba(255,255,255,0.06);
                border-color: rgba(255,255,255,0.12);
                color: #cbd5e1;
            }
            .bc-btn-default:hover {
                background: rgba(255,255,255,0.12);
                border-color: rgba(255,255,255,0.24);
                color: #fff;
            }
            .bc-btn-purple {
                background: rgba(124,92,255,0.15);
                border-color: rgba(124,92,255,0.38);
                color: #c4b5fd;
            }
            .bc-btn-purple:hover {
                background: rgba(124,92,255,0.28);
                border-color: rgba(124,92,255,0.65);
                color: #fff;
            }
            .bc-btn-emerald {
                background: rgba(16,185,129,0.14);
                border-color: rgba(16,185,129,0.35);
                color: #6ee7b7;
            }
            .bc-btn-emerald:hover {
                background: rgba(16,185,129,0.26);
                border-color: rgba(16,185,129,0.65);
                color: #fff;
            }
            .bc-btn-blue {
                background: rgba(59,130,246,0.14);
                border-color: rgba(59,130,246,0.35);
                color: #93c5fd;
            }
            .bc-btn-blue:hover {
                background: rgba(59,130,246,0.26);
                border-color: rgba(59,130,246,0.65);
                color: #fff;
            }
            .bc-btn-amber {
                background: rgba(245,158,11,0.14);
                border-color: rgba(245,158,11,0.35);
                color: #fcd34d;
            }
            .bc-btn-amber:hover {
                background: rgba(245,158,11,0.26);
                border-color: rgba(245,158,11,0.65);
                color: #fff;
            }
            .bc-btn-danger {
                background: rgba(244,63,94,0.12);
                border-color: rgba(244,63,94,0.32);
                color: #fda4af;
            }
            .bc-btn-danger:hover {
                background: rgba(244,63,94,0.25);
                border-color: rgba(244,63,94,0.65);
                color: #ffe4e6;
            }
            .bc-btn-primary {
                background: linear-gradient(135deg, #7c5cff 0%, #9333ea 100%);
                border: none;
                color: #fff;
                font-weight: 600;
                box-shadow: 0 2px 8px rgba(124,92,255,0.35);
            }
            .bc-btn-primary:hover {
                box-shadow: 0 4px 14px rgba(124,92,255,0.55);
            }
            .bc-btn-sm {
                height: 22px;
                padding: 0 6px;
                font-size: 10px;
                border-radius: 4px;
            }
            .bc-btn-xs {
                height: 20px;
                padding: 0 5px;
                font-size: 10px;
                border-radius: 3px;
            }

            /* Unified Form Controls */
            .bc-input,
            #bc-header-prefix,
            #bc-header-before,
            #bc-header-start,
            #bc-header-after,
            #bc-header-names {
                background: #141525;
                border: 1px solid #2e3048;
                color: #e2e8f0;
                border-radius: 4px;
                height: 24px;
                padding: 0 6px;
                font-size: 11px;
                box-sizing: border-box;
                transition: all 0.15s ease;
            }
            .bc-input:focus,
            #bc-header-prefix:focus,
            #bc-header-before:focus,
            #bc-header-start:focus,
            #bc-header-after:focus,
            #bc-header-names:focus {
                border-color: #7c5cff;
                outline: none;
                box-shadow: 0 0 0 2px rgba(124,92,255,0.22);
                background: #181a30;
            }

            .bc-select,
            .bc-group-template,
            .bc-group-background,
            .bc-group-background-mode,
            .bc-group-overlay-media,
            .bc-group-overlay-preset,
            .bc-group-overlay-slot,
            .bc-group-music-mode,
            .bc-group-music,
            .bc-group-field,
            .bc-folder-assign-group,
            .bc-tpl-group,
            .bc-bind-sel {
                background: #141525;
                border: 1px solid #2e3048;
                color: #e2e8f0;
                border-radius: 4px;
                height: 24px;
                padding: 0 6px;
                font-size: 11px;
                box-sizing: border-box;
                transition: all 0.15s ease;
                cursor: pointer;
            }
            .bc-select:focus,
            .bc-group-template:focus,
            .bc-group-background:focus,
            .bc-group-background-mode:focus,
            .bc-group-overlay-media:focus,
            .bc-group-overlay-preset:focus,
            .bc-group-overlay-slot:focus,
            .bc-group-music-mode:focus,
            .bc-group-music:focus,
            .bc-group-field:focus,
            .bc-folder-assign-group:focus,
            .bc-tpl-group:focus,
            .bc-bind-sel:focus {
                border-color: #7c5cff;
                outline: none;
                box-shadow: 0 0 0 2px rgba(124,92,255,0.22);
                background: #181a30;
            }
            .bc-select option,
            .bc-group-template option,
            .bc-group-background option,
            .bc-group-background-mode option,
            .bc-group-overlay-media option,
            .bc-group-overlay-preset option,
            .bc-group-overlay-slot option,
            .bc-group-music-mode option,
            .bc-group-music option,
            .bc-group-field option,
            .bc-folder-assign-group option,
            .bc-tpl-group option,
            .bc-bind-sel option {
                background: #161726;
                color: #e2e8f0;
            }

            /* Folder row unassign buttons & action buttons */
            .bc-folder-unassign,
            .bc-folder-unassign-all,
            .bc-background-remove,
            .bc-music-remove {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                padding: 0 6px;
                height: 22px;
                font-size: 10px;
                cursor: pointer;
                background: rgba(244,63,94,0.12);
                border: 1px solid rgba(244,63,94,0.3);
                border-radius: 4px;
                color: #fda4af;
                flex-shrink: 0;
                transition: all 0.15s ease;
            }
            .bc-folder-unassign:hover,
            .bc-folder-unassign-all:hover,
            .bc-background-remove:hover,
            .bc-music-remove:hover {
                background: rgba(244,63,94,0.25);
                border-color: rgba(244,63,94,0.6);
                color: #fff;
            }

            .bc-background-refresh {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                padding: 0 6px;
                height: 22px;
                font-size: 10px;
                cursor: pointer;
                background: rgba(255,255,255,0.06);
                border: 1px solid rgba(255,255,255,0.15);
                border-radius: 4px;
                color: #cbd5e1;
                flex-shrink: 0;
                transition: all 0.15s ease;
            }
            .bc-background-refresh:hover {
                background: rgba(255,255,255,0.12);
                border-color: rgba(255,255,255,0.25);
                color: #fff;
            }

            .bc-preview-group {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                gap: 4px;
                width: 100%;
                height: 24px;
                padding: 0 8px;
                font-size: 10.5px;
                font-weight: 500;
                border-radius: 4px;
                cursor: pointer;
                background: rgba(124,92,255,0.14);
                border: 1px solid rgba(124,92,255,0.35);
                color: #c4b5fd;
                transition: all 0.15s ease;
            }
            .bc-library-box {
                background: rgba(255,255,255,0.02);
                border: 1px solid #272942;
                border-radius: 8px;
                padding: 9px 10px;
                margin-bottom: 10px;
                transition: border-color 0.15s ease;
            }
            .bc-library-box:hover {
                border-color: #3e4268;
            }
            .bc-toggle-arrow {
                display: inline-block;
                transition: transform 0.18s ease, color 0.15s ease;
                user-select: none;
            }
            [data-toggle-section]:hover .bc-toggle-arrow {
                transform: scale(1.22);
            }

            /* Group card layout */
            .bc-group-card {
                background: #141524;
                border: 1px solid #272942;
                border-radius: 7px;
                padding: 8px 10px;
                margin-bottom: 7px;
                transition: border-color 0.15s ease, box-shadow 0.15s ease;
            }
            .bc-group-card:hover {
                border-color: #3f4268;
                box-shadow: 0 3px 10px rgba(0,0,0,0.25);
            }
            .bc-group-badge {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                padding: 2px 7px;
                background: rgba(124,92,255,0.18);
                border: 1px solid rgba(124,92,255,0.4);
                border-radius: 4px;
                color: #d8cfff;
                font-family: monospace;
                font-weight: 700;
                font-size: 11px;
                letter-spacing: 0.3px;
                flex-shrink: 0;
            }
            .bc-group-grid {
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: 6px 8px;
                margin-top: 6px;
            }
            .bc-group-field-item {
                display: flex;
                flex-direction: column;
                gap: 2px;
                min-width: 0;
            }
            .bc-group-field-item label {
                font-size: 10px;
                color: #8b8ea8;
                font-weight: 500;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            .bc-group-details {
                margin-top: 6px;
                padding-top: 4px;
                border-top: 1px dashed rgba(255,255,255,0.06);
            }
            .bc-group-summary {
                cursor: pointer;
                font-size: 10px;
                color: #8b8ea8;
                user-select: none;
                transition: color 0.15s;
            }
            .bc-group-summary:hover {
                color: #c4b5fd;
            }
        `;
    const savedNamingMode = _bulkState.taskNamingMode || (typeof localStorage !== 'undefined' ? localStorage.getItem('reels_bulk_task_naming_mode') : '') || 'custom';
    const savedGroupNamingMode = _bulkState.taskGroupNamingMode || 'group_bg';
    ov.innerHTML = `
        <div style="padding:10px 18px;border-bottom:1px solid #23243a;background:#11121e;flex-shrink:0;">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;gap:10px;">
                <div style="display:flex;align-items:center;gap:8px;">
                    <span style="font-size:18px;">🧩</span>
                    <span style="font-size:15px;font-weight:700;color:#fff;letter-spacing:0.5px;">大量制作</span>
                    <span style="font-size:11px;color:#717496;background:rgba(255,255,255,0.04);padding:2px 8px;border-radius:4px;">工程模板 × 数据表格 = 批量任务</span>
                </div>
                <div style="display:flex;align-items:center;gap:6px;">
                    <div style="display:flex;flex-direction:column;gap:3px;min-width:240px;">
                        <label style="font-size:9.5px;color:#a5b4fc;line-height:1;">📁 生成的任务组名（外部任务列表中的分组）</label>
                        <div style="display:flex;gap:4px;">
                            <select id="bc-task-group-naming-mode" class="bc-select" title="生成后的任务组名称规则" style="height:26px;font-size:10.5px;flex:1;">
                                <option value="group_bg" ${savedGroupNamingMode === 'group_bg' ? 'selected' : ''}>任务组 + 背景文件夹</option>
                                <option value="group" ${savedGroupNamingMode === 'group' ? 'selected' : ''}>仅任务组</option>
                                <option value="bg_group" ${savedGroupNamingMode === 'bg_group' ? 'selected' : ''}>背景文件夹 + 任务组</option>
                                <option value="custom" ${savedGroupNamingMode === 'custom' ? 'selected' : ''}>自定义组合</option>
                            </select>
                            <input id="bc-task-group-custom" class="bc-input" value="${_bcEsc(_bulkState.taskGroupCustomPattern || '{任务组}_{背景}')}" title="支持：{任务组} {背景} {模板} {覆层预设}" placeholder="{任务组}_{背景}" style="display:${savedGroupNamingMode === 'custom' ? '' : 'none'};width:154px;height:26px;font-size:10px;">
                        </div>
                    </div>
                    <div style="display:flex;flex-direction:column;gap:3px;min-width:250px;">
                        <label style="font-size:9.5px;color:#fcd34d;line-height:1;">🏷️ 组内任务行名（每条任务 / 输出文件名）</label>
                        <div style="display:flex;gap:4px;">
                            <select id="bc-task-naming-mode" class="bc-select" title="生成后的每条任务行名称规则" style="height:26px;font-size:10.5px;flex:1;">
                                <option value="group_bg_index" ${savedNamingMode === 'group_bg_index' ? 'selected' : ''}>任务组 + 背景 + 序号</option>
                                <option value="group_bg" ${savedNamingMode === 'group_bg' ? 'selected' : ''}>任务组 + 背景</option>
                                <option value="group_index" ${savedNamingMode === 'group_index' ? 'selected' : ''}>任务组 + 序号</option>
                                <option value="bg_group_index" ${savedNamingMode === 'bg_group_index' ? 'selected' : ''}>背景 + 任务组 + 序号</option>
                                <option value="custom" ${savedNamingMode === 'custom' ? 'selected' : ''}>自定义组合</option>
                            </select>
                            <input id="bc-task-naming-custom" class="bc-input" value="${_bcEsc(_bulkState.taskNamingCustomPattern || '{任务组}_{标题}_{Logo}_{序号}')}" title="支持：{日期} {任务组} {标题} {正文}/{内容} {背景} {Logo} {配乐} {模板} {覆层预设} {序号}" placeholder="{任务组}_{标题}_{Logo}_{序号}" style="display:${savedNamingMode === 'custom' ? '' : 'none'};width:238px;height:26px;font-size:10px;">
                        </div>
                        <div style="font-size:9px;color:#8689a8;line-height:1.2;display:${savedNamingMode === 'custom' ? '' : 'none'};" id="bc-task-naming-help">可用：{日期} {任务组} {标题} {正文}/{内容} {背景} {Logo} {配乐} {模板} {序号}</div>
                    </div>
                    <select id="bc-output-mode" class="bc-select" title="大量制作生成方式" style="height:28px;font-size:11px;">
                        <option value="group_apply" selected>📦 生成任务组并应用到外部分组显示（推荐）</option>
                        <option value="separate">📑 仅多标签页保存（保留在批量表格中）</option>
                        <option value="current">📄 全部平铺放入当前标签页</option>
                    </select>
                    <button id="bc-update-current-name" class="bc-btn bc-btn-default" style="height:28px;padding:0 10px;font-size:11px;" title="仅按当前任务行名规则更新当前正在编辑的任务">↻ 更新当前名称</button>
                    <button id="bc-update-existing-names" class="bc-btn bc-btn-default" style="height:28px;padding:0 10px;font-size:11px;" title="按当前任务行名规则更新全部已生成任务；不会修改文案、背景、Logo、配乐或覆层参数">↻ 更新所有名称</button>
                    <label style="font-size:11px;color:#c4b5fd;"><input id="bc-row-preset-mode" type="checkbox" ${_bulkState.rowPresetMode ? 'checked' : ''}>按每行所选预设生成</label>
                    <label style="font-size:11px;color:#c4b5fd;"><input id="bc-cell-preset-mode" type="checkbox" ${_bulkState.cellPresetMode ? 'checked' : ''}>按每个文案单元格生成</label>
                    <button id="bc-generate" class="bc-btn bc-btn-primary" style="height:28px;padding:0 18px;font-size:12px;">🚀 生成任务</button>
                    <button id="bc-close" class="bc-btn bc-btn-default" style="height:28px;padding:0 12px;font-size:11px;">关闭</button>
                </div>
            </div>
            <div style="display:flex;align-items:center;gap:5px;flex-wrap:wrap;">
                <span style="color:#717496;font-size:10px;font-weight:600;margin-right:2px;">数据:</span>
                <select id="bc-quick-columns" class="bc-select" title="一键建立常用表格列" style="height:24px;font-size:10.5px;color:#c4b5fd;border-color:rgba(124,92,255,0.45);">
                    <option value="" ${_bcCurrentQuickColumnPresetId() ? '' : 'selected'}>⚡ 快捷列模板</option>
                    <option value="default" ${_bcCurrentQuickColumnPresetId() === 'default' ? 'selected' : ''}>⚙️ 默认配置</option>
                    <option value="overlay" ${_bcCurrentQuickColumnPresetId() === 'overlay' ? 'selected' : ''}>🧱 覆层模板表</option>
                    <option value="voice_workflow" ${_bcCurrentQuickColumnPresetId() === 'voice_workflow' ? 'selected' : ''}>🎙️ 人声工作流表</option>
                </select>
                <input id="bc-quick-group-count" class="bc-input" type="number" min="1" max="500" value="1" title="一次建立多少组相同结构的列，最多500组" style="width:50px;height:24px;text-align:center;">
                <button id="bc-build-column-groups" class="bc-btn bc-btn-purple bc-btn-sm" title="按左侧选择的快捷列模板批量建立多组列">批量建组</button>
                <button id="bc-paste-tsv" class="bc-btn bc-btn-default bc-btn-sm">📋 粘贴TSV</button>
                <button id="bc-copy-table" class="bc-btn bc-btn-blue bc-btn-sm">📄 复制整表</button>
                <button id="bc-clear-all-headers" class="bc-btn bc-btn-danger bc-btn-sm" title="清空所有列标题；可选择同时清空绑定，或保留绑定并在任务组提示缺少表头">🏷️ 清空全部表头</button>
                <button id="bc-duplicate-rows" class="bc-btn bc-btn-purple bc-btn-sm" title="复制选中的行生成新版本副本">📋 复制副本行</button>
                <button id="bc-add-row" class="bc-btn bc-btn-default bc-btn-sm">+ 添加行</button>
                <button id="bc-clear" class="bc-btn bc-btn-danger bc-btn-sm">清空</button>
                <span style="color:rgba(255,255,255,0.15);margin:0 4px;">|</span>
                <span style="color:#717496;font-size:10px;font-weight:600;margin-right:2px;">模版:</span>
                <button id="bc-save-preset" class="bc-btn bc-btn-emerald bc-btn-sm">💾 保存</button>
                <button id="bc-backup-current" class="bc-btn bc-btn-default bc-btn-sm" title="直接下载当前工程备份，包含文案与覆层修改，不依赖预设库保存">⬇ 备份当前工程</button>
                <button id="bc-load-preset" class="bc-btn bc-btn-amber bc-btn-sm">📂 加载</button>
                <button id="bc-relink-media" class="bc-btn bc-btn-default bc-btn-sm" title="选择移动后的素材目录，找回当前工程丢失的素材与配乐并保留任务组绑定">🔎 找回丢失素材</button>
                <button id="bc-new-empty-project" class="bc-btn bc-btn-default bc-btn-sm" title="清空当前大量制作工程；不会删除爆帖工程组合库或预设">＋ 新建空工程</button>
                <button id="bc-reload-source" class="bc-btn bc-btn-blue bc-btn-sm" title="重新读取已添加模板对应的最新模板工程，保留当前列绑定">🔄 刷新工程</button>
                <button id="bc-export-preset" class="bc-btn bc-btn-default bc-btn-sm">⬆ 导出</button>
                <button id="bc-import-preset" class="bc-btn bc-btn-default bc-btn-sm">⬇ 导入</button>
                <span id="bc-folder-drop" style="margin-left:auto;display:inline-flex;align-items:center;height:24px;padding:0 10px;border:1px dashed rgba(124,92,255,.55);border-radius:5px;background:rgba(124,92,255,0.06);color:#c4b5fd;font-size:10.5px;">📁 可拖入多个文件夹：每夹一标签、每文件一任务</span>
            </div>
        </div>
        <div style="padding:7px 18px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;border-bottom:1px solid #23243a;background:#0d0e19;font-size:11.5px;color:#cbd5e1;">
            <label style="display:inline-flex;align-items:center;gap:5px;cursor:pointer;color:#c4b5fd;"><input id="bc-show-template-assignments" type="checkbox" ${_bcShowTemplateAssignments()?'checked':''}>显示模板分配</label>
            <label style="display:inline-flex;align-items:center;gap:5px;cursor:pointer;font-weight:500;"><input id="bc-auto-headers" type="checkbox" checked style="accent-color:#7c5cff;cursor:pointer;"> 粘贴TSV时自动生成表头</label>
            <label style="display:inline-flex;align-items:center;gap:4px;color:#94a3b8;">前缀 <input id="bc-header-prefix" class="bc-input" value="reels" placeholder="例如 FB" style="width:68px;text-align:center;"></label>
            <label style="display:inline-flex;align-items:center;gap:4px;color:#94a3b8;">编号前连接符 <input id="bc-header-before" class="bc-input" value="-" placeholder="如 -" style="width:48px;text-align:center;"></label>
            <label style="display:inline-flex;align-items:center;gap:4px;color:#94a3b8;">起始编号 <input id="bc-header-start" class="bc-input" type="number" step="1" value="1" style="width:54px;text-align:center;"></label>
            <label style="display:inline-flex;align-items:center;gap:4px;color:#94a3b8;">编号后连接符 <input id="bc-header-after" class="bc-input" value="-" placeholder="如 -" style="width:48px;text-align:center;"></label>
            <label style="display:inline-flex;align-items:center;gap:4px;color:#94a3b8;">循环列名 <input id="bc-header-names" class="bc-input" value="原始文案、标题、内容" placeholder="用逗号或顿号分隔" style="width:200px;"></label>
            <span id="bc-header-preview" style="display:inline-flex;align-items:center;background:rgba(124,92,255,0.1);border:1px solid rgba(124,92,255,0.28);border-radius:4px;padding:2px 8px;font-size:10.5px;color:#c4b5fd;font-family:monospace;max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"></span>
            <span style="color:#64748b;font-size:10.5px;margin-left:auto;">整表导入保留第一行文案；每组编号加1</span>
        </div>
        <div style="display:flex;flex:1;overflow:hidden;background:#0b0c15;">
            <div style="flex:1.8;min-width:0;overflow:auto;padding:10px;border-right:1px solid #23243a;outline:none;" id="bc-table-body" tabindex="0"></div>
            <div style="flex:1.2;min-width:360px;overflow:auto;padding:10px;" id="bc-bind-panel"></div>
        </div>`;
    document.body.appendChild(ov);
    function readHeaderRule() {
        const prefix = ov.querySelector('#bc-header-prefix').value.trim();
        const before = ov.querySelector('#bc-header-before').value;
        const after = ov.querySelector('#bc-header-after').value;
        const startText = ov.querySelector('#bc-header-start').value.trim();
        const start = Number(startText);
        const names = ov.querySelector('#bc-header-names').value.split(/[,，、\n]+/).map(name => name.trim()).filter(Boolean);
        if (!startText || !Number.isSafeInteger(start) || !names.length) return null;
        return { prefix, before, after, start, names };
    }
    function headerName(rule, index) {
        return `${rule.prefix}${rule.before || ''}${rule.start + Math.floor(index / rule.names.length)}${rule.after || ''}${rule.names[index % rule.names.length]}`;
    }
    function previewHeaders() {
        const rule = readHeaderRule();
        ov.querySelector('#bc-header-preview').textContent = rule
            ? Array.from({ length: Math.min(rule.names.length * 2, 8) }, (_, index) => headerName(rule, index)).join(' ｜ ') + ' …'
            : '请填写整数起始编号和循环列名';
    }
    ['#bc-header-prefix', '#bc-header-before', '#bc-header-start', '#bc-header-after', '#bc-header-names'].forEach(selector => {
        ov.querySelector(selector).addEventListener('input', () => {
            previewHeaders();
            _bcRenderBindings();
        });
    });
    previewHeaders();
    _bcRenderTable();
    _bcRenderBindings();
    ov.querySelector('#bc-task-naming-mode')?.addEventListener('change', (e) => {
        try { localStorage.setItem('reels_bulk_task_naming_mode', e.target.value); } catch (_) {}
        _bulkState.taskNamingMode = e.target.value;
        const custom = ov.querySelector('#bc-task-naming-custom');
        if (custom) custom.style.display = e.target.value === 'custom' ? '' : 'none';
        const help = ov.querySelector('#bc-task-naming-help');
        if (help) help.style.display = e.target.value === 'custom' ? '' : 'none';
        _bcScheduleDraftSave();
    });
    ov.querySelector('#bc-task-naming-custom')?.addEventListener('input', (e) => {
        _bulkState.taskNamingCustomPattern = e.target.value;
        _bcScheduleDraftSave();
    });
    ov.querySelector('#bc-task-group-naming-mode')?.addEventListener('change', (e) => {
        _bulkState.taskGroupNamingMode = e.target.value;
        const custom = ov.querySelector('#bc-task-group-custom');
        if (custom) custom.style.display = e.target.value === 'custom' ? '' : 'none';
        _bcScheduleDraftSave();
    });
    ov.querySelector('#bc-task-group-custom')?.addEventListener('input', (e) => {
        _bulkState.taskGroupCustomPattern = e.target.value;
        _bcScheduleDraftSave();
    });
    const _bcCloseModal = () => {
        if (_bcAudioPreview) {
            _bcAudioPreview.pause();
            _bcAudioPreview = null;
            _bcCurrentPlayingMusic = null;
        }
        _bcSaveDraftNow();
        if (_bcModalAbort) {
            _bcModalAbort.abort();
            _bcModalAbort = null;
        }
        _bcIsSelecting = false;
        ov.remove();
    };

    // Block events from leaking to app-level handlers after modal controls handle them.
    ov.addEventListener('mousedown', e => e.stopPropagation());
    ov.addEventListener('pointerdown', e => e.stopPropagation());
    ov.addEventListener('dragover', e => {
        const hasFiles = Array.from(e.dataTransfer?.types || []).includes('Files');
        if (!hasFiles) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'copy';
        const hint = ov.querySelector('#bc-folder-drop');
        if (hint) hint.style.background = 'rgba(124,92,255,.22)';
    });
    ov.addEventListener('dragleave', e => {
        if (e.relatedTarget && ov.contains(e.relatedTarget)) return;
        const hint = ov.querySelector('#bc-folder-drop');
        if (hint) hint.style.background = '';
    });
    ov.addEventListener('drop', async e => {
        const files = Array.from(e.dataTransfer?.files || []);
        if (!files.length) return;
        e.preventDefault();
        e.stopPropagation();
        const hint = ov.querySelector('#bc-folder-drop');
        if (hint) hint.style.background = '';
        const paths = files.map(f => typeof getFileNativePath === 'function'
            ? getFileNativePath(f) : (f.path || '')).filter(Boolean);
        if (e.target.closest?.('#bc-music-library')) {
            _bcImportMusicFiles(paths);
            return;
        }
        const dirs = paths.filter(p => typeof _isDirectoryPath === 'function' && _isDirectoryPath(p));
        if (!dirs.length) {
            if (typeof showToast === 'function') showToast('这里请拖入一个或多个文件夹', 'warning');
            return;
        }
        if (e.target.closest?.('#bc-background-library')) {
            await _bcImportBackgroundFolders(dirs);
            return;
        }
        if (e.target.closest?.('#bc-overlay-media-library')) {
            await _bcImportOverlayMediaFolders(dirs);
            return;
        }
        if (typeof window.reelsImportFoldersAsTaskTabs !== 'function') {
            if (typeof showToast === 'function') showToast('文件夹任务导入器尚未加载，请重启应用', 'error');
            return;
        }
        const result = await window.reelsImportFoldersAsTaskTabs(dirs);
        if (result?.tabCount > 0) _bcCloseModal();
    });

    // ── Click events ──
    ov.addEventListener('click', e => {
        const t = e.target;
        if (t.id === 'bc-close') { _bcCloseModal(); return; }
        if (t.id === 'bc-preview-all') { _bcPreviewAll(); return; }
        if (t.id === 'bc-toggle-all-sections') {
            const nextState = !['templates', 'backgrounds', 'music', 'groups'].every(k => _bulkState.collapsedSections?.[k]);
            _bulkState.collapsedSections = {
                templates: nextState,
                backgrounds: nextState,
                music: nextState,
                groups: nextState,
            };
            _bcRenderBindings();
            _bcScheduleDraftSave();
            return;
        }
        // 这些按钮位于可折叠标题内，必须在标题的折叠逻辑之前处理。
        if (t.id === 'bc-copy-group-assignments') { e.stopPropagation(); _bcCopyGroupAssignmentsToClipboard(t); return; }
        if (t.id === 'bc-add-viral-groups') { e.stopPropagation(); _bcAddViralGroupsFromLibrary(); return; }
        if (t.id === 'bc-export-viral-groups') { e.stopPropagation(); _bcExportViralGroups(); return; }
        if (t.id === 'bc-import-viral-groups') { e.stopPropagation(); _bcImportViralGroups(); return; }
        const toggleHeader = t.closest?.('[data-toggle-section]');
        // 标题空白处用于折叠；标题内的操作控件（添加、清空、分配等）
        // 必须继续落到下方各自的处理逻辑，不能在这里提前退出。
        if (toggleHeader && !t.closest('button, input, select, label, .bc-btn, a')) {
            const sec = toggleHeader.dataset.toggleSection;
            if (!_bulkState.collapsedSections) _bulkState.collapsedSections = {};
            _bulkState.collapsedSections[sec] = !_bulkState.collapsedSections[sec];
            _bcRenderBindings();
            _bcScheduleDraftSave();
            return;
        }
        if (t.id === 'bc-random-backgrounds') { _bcRandomizeBackgroundGroups(); return; }
        if (t.id === 'bc-random-music') { _bcRandomizeMusicGroups(); return; }
        if (t.classList.contains('bc-group-rebind')) { _bcChooseNewHeaderGroup(t.dataset.group); return; }
        if (t.classList.contains('bc-preview-group')) { _bcPreviewGroup(t.dataset.group); return; }
        if (t.id === 'bc-add-background-folders') {
            if (!window.electronAPI?.showOpenDialog) { alert('请在桌面版中选择文件夹'); return; }
            window.electronAPI.showOpenDialog({ title: '添加背景素材（每个文件夹为一组背景）', properties: ['openDirectory', 'multiSelections'] })
                .then(result => _bcImportBackgroundFolders(result?.filePaths || [])).catch(error => alert(error.message));
            return;
        }
        if (t.id === 'bc-add-overlay-media-folders') {
            if (!window.electronAPI?.showOpenDialog) { alert('请在桌面版中选择文件夹'); return; }
            window.electronAPI.showOpenDialog({ title: '添加覆层媒体文件夹（每夹可分配给不同任务组）', properties: ['openDirectory', 'multiSelections'] })
                .then(result => _bcImportOverlayMediaFolders(result?.filePaths || [])).catch(error => alert(error.message));
            return;
        }
        if (t.id === 'bc-seq-overlay-media') { _bcAssignOverlayMediaGroups(); return; }
        if (t.id === 'bc-add-logo-files') {
            if (!window.electronAPI?.showOpenDialog) { alert('请在桌面版中选择 Logo 媒体'); return; }
            window.electronAPI.showOpenDialog({ title: '添加 Logo 图片或视频', properties: ['openFile', 'multiSelections'], filters: [{ name: '图片或视频', extensions: [...BC_FOLDER_OVERLAY_EXTS] }] })
                .then(result => _bcImportLogoMediaFiles(result?.filePaths || [])).catch(error => alert(error.message));
            return;
        }
        if (t.id === 'bc-add-logo-folders') {
            if (!window.electronAPI?.showOpenDialog) { alert('请在桌面版中选择 Logo 媒体文件夹'); return; }
            window.electronAPI.showOpenDialog({ title: '添加 Logo 媒体文件夹', properties: ['openDirectory', 'multiSelections'] })
                .then(result => _bcImportLogoMediaFolders(result?.filePaths || [])).catch(error => alert(error.message));
            return;
        }
        if (t.id === 'bc-seq-logo-media') { _bcAssignLogoMediaGroups(false); return; }
        if (t.id === 'bc-random-logo-media') { _bcAssignLogoMediaGroups(true); return; }
        if (t.classList.contains('bc-logo-media-remove')) {
            const [removed] = _bulkState.logoMediaLibrary.splice(Number(t.dataset.li), 1);
            (_bulkState.groupAssignments || []).forEach(entry => { if (entry.logoOverlay?.sourceId === removed?.id) entry.logoOverlay.sourceId = ''; });
            _bcRenderBindings(); _bcScheduleDraftSave(); return;
        }
        if (t.classList.contains('bc-group-logo-edit')) { _bcEditGroupLogoOverlay(t.dataset.group); return; }
        if (t.id === 'bc-clear-overlay-media') {
            if (!confirm('清空覆层媒体文件夹库？已生成的任务不会受影响。')) return;
            _bulkState.overlayMediaFolders = [];
            (_bulkState.groupAssignments || []).forEach(entry => { entry.overlayMediaFolder = ''; });
            _bcRenderBindings(); _bcScheduleDraftSave(); return;
        }
        if (t.classList.contains('bc-overlay-folder-remove')) {
            const [folder] = _bulkState.overlayMediaFolders.splice(Number(t.dataset.fi), 1);
            (_bulkState.groupAssignments || []).forEach(entry => { if (entry.overlayMediaFolder === folder?.path) entry.overlayMediaFolder = ''; });
            _bcRenderBindings(); _bcScheduleDraftSave(); return;
        }
        if (t.id === 'bc-add-music') {
            if (!window.electronAPI?.showOpenDialog) { alert('请在桌面版中选择配乐文件'); return; }
            window.electronAPI.showOpenDialog({
                title: '添加配乐（可多选）', properties: ['openFile', 'multiSelections'],
                filters: [{ name: '音频', extensions: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'wma'] }],
            }).then(result => _bcImportMusicFiles(result?.filePaths || [])).catch(error => alert(error.message));
            return;
        }
        if (t.id === 'bc-clear-tpl-assignments') { _bcClearTemplateAssignments(); return; }
        if (t.id === 'bc-clear-templates') { _bcClearTemplateLibrary(); return; }
        if (t.id === 'bc-seq-backgrounds') { _bcAssignBackgroundGroups(false); return; }
        if (t.id === 'bc-clear-bg-assignments') { _bcClearBackgroundAssignments(); return; }
        if (t.id === 'bc-seq-music') { _bcAssignMusicGroups(false); return; }
        if (t.id === 'bc-clear-music-assignments') { _bcClearMusicAssignments(); return; }

        const playBtn = t.closest?.('.bc-music-play');
        if (playBtn) {
            const audioPath = playBtn.dataset.path;
            if (audioPath) _bcToggleMusicPreview(audioPath);
            return;
        }

        const unassignTplBtn = t.closest?.('.bc-template-unassign');
        if (unassignTplBtn) {
            const groupKey = unassignTplBtn.dataset.group;
            if (groupKey) _bcUnassignTemplateFromGroup(groupKey);
            return;
        }
        const unassignAllTplBtn = t.closest?.('.bc-template-unassign-all');
        if (unassignAllTplBtn) {
            const ti = Number(unassignAllTplBtn.dataset.template);
            if (!isNaN(ti)) _bcUnassignAllGroupsForTemplate(ti);
            return;
        }

        const unassignMusicBtn = t.closest?.('.bc-music-unassign');
        if (unassignMusicBtn) {
            const groupKey = unassignMusicBtn.dataset.group;
            if (groupKey) _bcUnassignMusicFromGroup(groupKey);
            return;
        }
        const unassignAllMusicBtn = t.closest?.('.bc-music-unassign-all');
        if (unassignAllMusicBtn) {
            const musicPath = unassignAllMusicBtn.dataset.music;
            if (musicPath) _bcUnassignAllMusicForPath(musicPath);
            return;
        }

        if (t.id === 'bc-clear-backgrounds') {
            if (!_bulkState.backgroundFolders?.length) {
                if (typeof showToast === 'function') showToast('背景库已经是空的', 'info');
                else alert('背景库已经是空的');
                return;
            }
            if (confirm('确定清空背景库中的所有素材？')) {
                _bcClearBackgroundFolders();
            }
            return;
        }
        if (t.id === 'bc-clear-music') {
            if (!_bulkState.musicFiles?.length) {
                if (typeof showToast === 'function') showToast('配乐库已经是空的', 'info');
                else alert('配乐库已经是空的');
                return;
            }
            if (confirm('确定清空所有配乐文件？')) {
                _bcClearMusicFiles();
            }
            return;
        }
        if (t.classList.contains('bc-music-remove')) {
            const [music] = _bulkState.musicFiles.splice(Number(t.dataset.mi), 1);
            (_bulkState.groupAssignments || []).forEach(entry => {
                if (entry.musicPath === music?.path) entry.musicPath = '';
            });
            _bcRenderBindings(); _bcScheduleDraftSave(); return;
        }
        if (t.classList.contains('bc-background-refresh')) {
            const folder = _bulkState.backgroundFolders[Number(t.dataset.fi)];
            if (folder) _bcImportBackgroundFolders([folder.path]);
            return;
        }
        if (t.classList.contains('bc-background-open-folder')) {
            const folder = _bulkState.backgroundFolders[Number(t.dataset.fi)];
            if (!folder?.path) return;
            const openFolder = window.bridge?.openPath;
            if (typeof openFolder !== 'function') { alert('当前环境不支持打开文件夹'); return; }
            openFolder(folder.path).then(result => {
                if (result?.success === false) alert(`无法打开背景文件夹：${result.error || '路径不存在'}`);
            }).catch(error => alert(`无法打开背景文件夹：${error.message}`));
            return;
        }
        const openGroupBackgroundFolder = t.closest?.('.bc-group-open-background-folder');
        if (openGroupBackgroundFolder) {
            const groupKey = openGroupBackgroundFolder.dataset.group;
            const entry = (_bulkState.groupAssignments || []).find(item => item.key === groupKey);
            const folderPath = entry?.backgroundFolder || '';
            if (!folderPath) {
                if (typeof showToast === 'function') showToast('请先为该任务组选择背景文件夹', 'info');
                else alert('请先选择背景文件夹');
                return;
            }
            const openFolder = window.bridge?.openPath;
            if (typeof openFolder !== 'function') {
                alert('当前环境不支持打开文件夹');
                return;
            }
            openFolder(folderPath).then(result => {
                if (result?.success === false) alert(`无法打开背景文件夹：${result.error || '路径不存在'}`);
            }).catch(error => alert(`无法打开背景文件夹：${error.message}`));
            return;
        }
        const thumbBtn = t.closest?.('.bc-bg-folder-thumb');
        if (thumbBtn) {
            const folder = _bulkState.backgroundFolders[Number(thumbBtn.dataset.fi)];
            if (folder) _bcVisualPicker('folder', folder.path, null);
            return;
        }
        const unassignBtn = t.closest?.('.bc-folder-unassign');
        if (unassignBtn) {
            const groupKey = unassignBtn.dataset.group;
            if (groupKey) _bcUnassignFolderFromGroup(groupKey);
            return;
        }
        const unassignAllBtn = t.closest?.('.bc-folder-unassign-all');
        if (unassignAllBtn) {
            const folderPath = unassignAllBtn.dataset.folder;
            if (folderPath) _bcUnassignAllFoldersForPath(folderPath);
            return;
        }
        if (t.classList.contains('bc-background-remove')) {
            const [folder] = _bulkState.backgroundFolders.splice(Number(t.dataset.fi), 1);
            (_bulkState.groupAssignments || []).forEach(entry => {
                if (entry.backgroundFolder === folder?.path) entry.backgroundFolder = '';
            });
            _bcRenderBindings(); _bcScheduleDraftSave(); return;
        }
        if (t.id === 'bc-add-row') { _bulkState.rows.push(new Array(_bulkState.columns.length).fill('')); _bcRenderTable(); return; }
        if (t.id === 'bc-duplicate-rows') {
            const bounds = _bcSelectionBounds();
            let indices = [];
            if (bounds) {
                for (let r = bounds.minR; r <= bounds.maxR; r++) {
                    if (r >= 0 && r < _bulkState.rows.length) indices.push(r);
                }
            }
            if (!indices.length) {
                if (_bulkState.rows.length === 1) {
                    indices = [0];
                } else if (_bulkState.rows.length > 1) {
                    alert('请先在表格中点击选中要复制的行或单元格');
                    return;
                } else {
                    return;
                }
            }
            _bcPromptRowDuplication(indices);
            return;
        }
        if (t.id === 'bc-copy-table') { _bcCopyWholeTable(); return; }
        if (t.id === 'bc-clear-all-headers') {
            const namedCount = (_bulkState.columns || []).filter(column => String(column?.name || '').trim()).length;
            if (!namedCount) { if (typeof showToast === 'function') showToast('当前表头已经全部为空', 'info'); return; }
            const currentGroupKeys = _bcNumberedColumnGroups().map(group => group.key);
            const clearBindings = confirm(`确定清空 ${namedCount} 个表头吗？\n\n确定：清空表头，并清空全部模板绑定。\n取消：只清空表头，保留全部绑定；各任务组会显示“缺少表头”提醒。`);
            const originalHeaders = JSON.parse(JSON.stringify(_bulkState.columns || []));
            (_bulkState.columns || []).forEach(column => { column.name = ''; });
            if (clearBindings) {
                (_bulkState.templates || []).forEach(tpl => { tpl.bindings = {}; });
                _bulkState.groupAssignments = [];
                _bulkState.missingHeaderGroupKeys = [];
                _bulkState.retainedHeaderColumns = [];
            } else {
                // 只保留清空前真实存在的组，避免把历史替换表格的旧组带回来。
                _bulkState.missingHeaderGroupKeys = currentGroupKeys;
                _bulkState.retainedHeaderColumns = originalHeaders;
            }
            _bcRenderTable();
            _bcRenderBindings();
            _bcScheduleDraftSave();
            if (typeof showToast === 'function') showToast(clearBindings ? '已清空全部表头、绑定和任务组分配' : '已清空全部表头，绑定已保留；请查看任务组缺少表头提醒', clearBindings ? 'success' : 'warning');
            return;
        }
        if (t.id === 'bc-build-column-groups') {
            const presetId = ov.querySelector('#bc-quick-columns')?.value || 'default';
            const groupCount = ov.querySelector('#bc-quick-group-count')?.value || 1;
            _bcApplyQuickColumnPreset(presetId, groupCount);
            return;
        }
        if (t.id === 'bc-add-col') {
            _bcPrompt('输入列名（多列用逗号分隔）', 'FB标题, FB正文, FB尾标, TK标题, TK正文').then(input => {
                if (!input || !input.trim()) return;
                const names = input.split(/[,，\n]+/).map(s => s.trim()).filter(Boolean);
                names.forEach(name => {
                    _bulkState.columns.push(_bcColumnFromName(name));
                    _bulkState.rows.forEach(r => r.push(''));
                });
                _bcRenderTable(); _bcRenderBindings();
                _bcScheduleDraftSave();
            });
            return;
        }
        if (t.id === 'bc-clear') { if(confirm('清空所有数据？')){ _bulkState.rows=[]; for(let i=0;i<20;i++) _bulkState.rows.push(new Array(_bulkState.columns.length).fill('')); _bcRenderTable(); _bcScheduleDraftSave(); } return; }
        if (t.id === 'bc-add-tpl') { _bcPickTemplates(); return; }
        if (t.classList.contains('bc-select-background-files')) { _bcOpenSelectedBackgroundPicker(t.dataset.group); return; }
        if (t.id === 'bc-match-groups') { _bcAssignNumberedGroups(); return; }
        if (t.id === 'bc-random-groups') { _bcAssignNumberedGroups(true); return; }
        if (t.id === 'bc-manual-bindings') {
            if (_bulkState.groupAssignments) {
                _bulkState.groupAssignments = null;
            } else {
                _bcAssignNumberedGroups();
            }
            _bcRenderBindings();
            _bcScheduleDraftSave();
            return;
        }
        if (t.id === 'bc-clear-bindings') { if (confirm('清空所有模板的列绑定？')) _bcClearAllTemplateBindings(); return; }
        if (t.id === 'bc-rebind-tpl') { if (confirm('按当前列名重新自动绑定所有模板字段？')) _bcAutoRebindAllTemplates(); return; }
        if (t.id === 'bc-save-preset') { _bcSavePreset(); return; }
        if (t.id === 'bc-backup-current') { _bcDownloadCurrentPresetBackup(); return; }
        if (t.id === 'bc-load-preset') { _bcLoadPreset(); return; }
        if (t.id === 'bc-relink-media' || t.hasAttribute?.('data-bc-relink-media')) { _bcRelinkMissingMedia(t); return; }
        if (t.id === 'bc-new-empty-project') { _bcCreateEmptyProject(); return; }
        if (t.classList.contains('bc-viral-group-save')) {
            const button = t;
            if (button.disabled) return;
            const originalText = button.textContent;
            button.disabled = true;
            button.textContent = '⏳ 保存中…';
            _bcSaveViralGroupPreset(button.dataset.group).then(name => {
                if (!name) { button.textContent = originalText; button.disabled = false; return; }
                button.textContent = '✓ 已保存';
                button.title = `已保存为爆帖工程组合「${name}」`;
                button.style.background = 'rgba(34,197,94,.18)';
                button.style.borderColor = 'rgba(74,222,128,.65)';
                button.style.color = '#bbf7d0';
                setTimeout(() => {
                    if (!button.isConnected) return;
                    button.textContent = originalText;
                    button.title = '把当前这个任务组完整保存为独立的爆帖工程组合，不影响原有预设';
                    button.style.background = '';
                    button.style.borderColor = '';
                    button.style.color = '';
                    button.disabled = false;
                }, 3000);
            }).catch(error => {
                button.textContent = originalText;
                button.disabled = false;
                alert(`保存爆帖工程组合失败：${error.message}`);
            });
            return;
        }
        if (t.id === 'bc-reload-source') { _bcReloadLoadedTemplates(); return; }
        if (t.id === 'bc-export-preset') { _bcExportPreset(); return; }
        if (t.id === 'bc-import-preset') { _bcImportPreset(); return; }
        if (t.id === 'bc-generate') {
            const count = _bcGenerateTasks();
            if (count > 0) {
                // 大量制作是一次结构性操作。必须先保存“生成后”快照，
                // 否则用户第一次撤销会直接回到生成前，整批任务组都会消失。
                window.reelsSaveHistory?.();
                alert(`✅ 已生成 ${count} 个任务`);
                _bcCloseModal();
                if(typeof _renderBatchTable==='function') _renderBatchTable();
                if(typeof _renderTaskList==='function') _renderTaskList();
            }
            return;
        }
        if (t.id === 'bc-update-existing-names') {
            const count = _bcUpdateExistingTaskNames('all');
            if (count > 0) alert(`✅ 已按当前规则更新 ${count} 条已有任务名称`);
            return;
        }
        if (t.id === 'bc-update-current-name') {
            const count = _bcUpdateExistingTaskNames('current');
            if (count > 0) alert('✅ 已按当前规则更新当前任务名称');
            else alert('当前没有可更新的任务名称');
            return;
        }
        if (t.classList.contains('bc-tpl-edit-overlays')) {
            const ti = parseInt(t.dataset.ti);
            if (_bulkState.templates[ti]) _bcEditTemplateOverlays(ti);
            return;
        }
        if (t.classList.contains('bc-tpl-save-preset')) {
            const ti = parseInt(t.dataset.ti);
            const tpl = _bulkState.templates[ti];
            if (tpl) {
                _bcPrompt('请输入覆层预设名称', `${tpl.label} 覆层预设`).then(name => {
                    if (!name || !name.trim()) return;
                    const customPresets = JSON.parse(localStorage.getItem('reels_custom_presets') || '[]');
                    const p = {
                        id: 'custom_' + Date.now(),
                        name: name.trim(),
                        desc: `由批量模板「${tpl.label}」导出`,
                        overlays: JSON.parse(JSON.stringify(tpl.task?.overlays || tpl.overlays || []))
                    };
                    customPresets.push(p);
                    localStorage.setItem('reels_custom_presets', JSON.stringify(customPresets));
                    alert(`✅ 已保存为覆层预设「${p.name}」`);
                });
            }
            return;
        }
        if (t.classList.contains('bc-tpl-rename')) {
            const ti = parseInt(t.dataset.ti);
            const tpl = _bulkState.templates[ti];
            if (tpl) {
                _bcPrompt('请输入新的模板名称', tpl.label || `模板 ${ti + 1}`).then(name => {
                    if (!name || !name.trim()) return;
                    tpl.label = name.trim();
                    if (tpl.task) tpl.task.name = tpl.label;
                    _bcRenderBindings();
                    _bcScheduleDraftSave();
                });
            }
            return;
        }
        if (t.classList.contains('bc-col-clear-name')) {
            const ci = parseInt(t.dataset.ci);
            const input = t.closest('th')?.querySelector('.bc-col-name');
            if (!input || !Number.isInteger(ci)) return;
            input.value = '';
            // 复用表头 change 流程，确保弹窗以及“保留绑定后的组提醒”一致。
            input.dispatchEvent(new Event('change', { bubbles: true }));
            return;
        }
        if (t.classList.contains('bc-col-del')) { const ci=parseInt(t.dataset.ci); if(_bulkState.columns.length<=1)return; _bulkState.columns.splice(ci,1); _bulkState.rows.forEach(r=>r.splice(ci,1)); _bcRenderTable(); _bcRenderBindings(); _bcScheduleDraftSave(); return; }
        if (t.classList.contains('bc-group-presets')) { _bcChooseGroupPresets(t.dataset.group); return; }
        if (t.classList.contains('bc-cell-presets')) { _bcChooseRowPresets(Number(t.dataset.ri), Number(t.dataset.ci)); return; }
        if (t.id === 'bc-show-template-assignments') { localStorage.setItem('reels_bulk_show_template_assignments',String(t.checked)); _bcRenderTable(); return; }
        if (t.id === 'bc-cell-preset-mode') { _bulkState.cellPresetMode = t.checked; if(t.checked) { _bulkState.rowPresetMode=false; const other=document.getElementById('bc-row-preset-mode'); if(other)other.checked=false; } _bcRenderRowPresetCount(); _bcScheduleDraftSave(); return; }
        if (t.classList.contains('bc-row-presets')) { _bcChooseRowPresets(Number(t.dataset.ri)); return; }
        if (t.id === 'bc-row-preset-mode') { _bulkState.rowPresetMode = t.checked; if(t.checked) { _bulkState.cellPresetMode=false; const other=document.getElementById('bc-cell-preset-mode'); if(other)other.checked=false; } _bcRenderRowPresetCount(); _bcScheduleDraftSave(); return; }
        if (t.classList.contains('bc-row-copy')) { const ri = parseInt(t.dataset.ri); if (!isNaN(ri) && _bulkState.rows[ri]) { _bcPromptRowDuplication([ri]); } return; }
        if (t.classList.contains('bc-row-del')) { _bulkState.cellTemplateIds.splice(parseInt(t.dataset.ri),1); _bulkState.rowTemplateIds.splice(parseInt(t.dataset.ri),1); _bulkState.rows.splice(parseInt(t.dataset.ri),1); _bcRenderTable(); _bcScheduleDraftSave(); return; }
        if (t.classList.contains('bc-tpl-bgcycle')) {
            const ti = parseInt(t.dataset.ti);
            const tpl = _bulkState.templates[ti];
            if (!tpl) return;
            if (tpl.bgCycle && tpl.bgCycle.length > 0) {
                // 显示背景循环详情
                _bcShowBgCycleDetail(tpl, ti);
            } else {
                // 选择文件
                _bcPickBgCycleFiles(tpl, ti);
            }
            return;
        }
        if (t.classList.contains('bc-tpl-folder-pick')) {
            const ti = parseInt(t.dataset.ti);
            const tpl = _bulkState.templates[ti];
            if (tpl) _bcPickTemplateMaterialFolder(tpl, ti);
            return;
        }
        if (t.classList.contains('bc-tpl-folder-refresh')) {
            const ti = parseInt(t.dataset.ti);
            const tpl = _bulkState.templates[ti];
            if (tpl) _bcRefreshTemplateMaterialFolder(tpl, ti);
            return;
        }
        if (t.classList.contains('bc-tpl-del')) {
            const ti = Number(t.dataset.ti);
            _bulkState.templates.splice(ti, 1);
            (_bulkState.groupAssignments || []).forEach(entry => {
                if (entry.templateIndex === ti) { entry.templateIndex = -1; entry.bindings = {}; }
                else if (entry.templateIndex > ti) entry.templateIndex--;
            });
            _bcRenderBindings();
            _bcScheduleDraftSave();
            return;
        }
        if (t.classList.contains('bc-col-insert')) {
            const ci = parseInt(t.dataset.ci);
            _bulkState.columns.splice(ci + 1, 0, { name: `列${_bulkState.columns.length+1}`, type: 'text' });
            _bulkState.rows.forEach(r => r.splice(ci + 1, 0, ''));
            // Update bindings: shift column indices >= ci+1
            _bulkState.templates.forEach(tpl => {
                for (const [k, v] of Object.entries(tpl.bindings)) { if (v > ci) tpl.bindings[k] = v + 1; }
            });
            _bcRenderTable(); _bcRenderBindings(); _bcScheduleDraftSave(); return;
        }
        if (t.classList.contains('bc-col-left')) {
            const ci = parseInt(t.dataset.ci); if (ci <= 0) return;
            [_bulkState.columns[ci-1], _bulkState.columns[ci]] = [_bulkState.columns[ci], _bulkState.columns[ci-1]];
            _bulkState.rows.forEach(r => { [r[ci-1], r[ci]] = [r[ci], r[ci-1]]; });
            // Swap binding references
            _bulkState.templates.forEach(tpl => {
                for (const [k, v] of Object.entries(tpl.bindings)) {
                    if (v === ci) tpl.bindings[k] = ci - 1;
                    else if (v === ci - 1) tpl.bindings[k] = ci;
                }
            });
            _bcRenderTable(); _bcRenderBindings(); _bcScheduleDraftSave(); return;
        }
        if (t.classList.contains('bc-col-right')) {
            const ci = parseInt(t.dataset.ci); if (ci >= _bulkState.columns.length - 1) return;
            [_bulkState.columns[ci], _bulkState.columns[ci+1]] = [_bulkState.columns[ci+1], _bulkState.columns[ci]];
            _bulkState.rows.forEach(r => { [r[ci], r[ci+1]] = [r[ci+1], r[ci]]; });
            _bulkState.templates.forEach(tpl => {
                for (const [k, v] of Object.entries(tpl.bindings)) {
                    if (v === ci) tpl.bindings[k] = ci + 1;
                    else if (v === ci + 1) tpl.bindings[k] = ci;
                }
            });
            _bcRenderTable(); _bcRenderBindings(); _bcScheduleDraftSave(); return;
        }
    });
    ov.querySelector('#bc-quick-columns')?.addEventListener('change', e => {
        const presetId = e.target.value;
        if (presetId && !_bcApplyQuickColumnPreset(presetId)) {
            e.target.value = _bcCurrentQuickColumnPresetId();
        }
    });

    // ── Change events ──
    ov.addEventListener('change', e => {
        const t = e.target;
        if (t.classList.contains('bc-folder-assign-group')) {
            const folderPath = t.dataset.folder;
            const oldGroupKey = t.dataset.currentGroup || '';
            const newGroupKey = t.value || '';
            _bcChangeFolderGroupAssignment(folderPath, oldGroupKey, newGroupKey);
            return;
        }
        if (t.classList.contains('bc-group-background') || t.classList.contains('bc-group-background-mode') || t.classList.contains('bc-group-music') || t.classList.contains('bc-group-music-mode') || t.classList.contains('bc-group-logo-source') || t.classList.contains('bc-group-logo-mode') || t.classList.contains('bc-group-logo-stack') || t.classList.contains('bc-group-overlay-media') || t.classList.contains('bc-group-overlay-preset') || t.classList.contains('bc-group-overlay-slot')) {
            if (!_bulkState.groupAssignments) _bulkState.groupAssignments = [];
            let entry = _bulkState.groupAssignments.find(item => item.key === t.dataset.group);
            if (!entry) { entry = { key: t.dataset.group, templateIndex: -1, bindings: {} }; _bulkState.groupAssignments.push(entry); }
            if (t.classList.contains('bc-group-background')) { entry.backgroundFolder = t.value; entry.selectedBackgroundFiles = []; }
            else if (t.classList.contains('bc-group-background-mode')) entry.backgroundMode = t.value;
            else if (t.classList.contains('bc-group-music-mode')) {
                entry.musicMode = t.value;
                if (t.value !== 'random') delete entry.musicTaskAssignments;
            }
            else if (t.classList.contains('bc-group-overlay-media')) entry.overlayMediaFolder = t.value;
            else if (t.classList.contains('bc-group-logo-source')) {
                entry.logoOverlay = entry.logoOverlay || { overlay: _bcDefaultLogoOverlay(), taskMode: 'cycle' };
                entry.logoOverlay.enabled = !!t.value;
                entry.logoOverlay.sourceId = t.value;
            }
            else if (t.classList.contains('bc-group-logo-mode')) {
                entry.logoOverlay = entry.logoOverlay || { enabled: true, sourceId: '', overlay: _bcDefaultLogoOverlay() };
                entry.logoOverlay.taskMode = t.value;
            }
            else if (t.classList.contains('bc-group-logo-stack')) {
                entry.logoOverlay = entry.logoOverlay || { enabled: true, sourceId: '', overlay: _bcDefaultLogoOverlay() };
                entry.logoOverlay.stackPosition = t.value;
            }
            else if (t.classList.contains('bc-group-overlay-slot')) {
                entry.overlayMediaSlot = String(t.value).startsWith('custom:') || /^(script|title|gif|pip_|phone_)/.test(String(t.value))
                    ? t.value : Number(t.value);
            }
            else if (t.classList.contains('bc-group-overlay-preset')) {
                let presets = [];
                try { presets = JSON.parse(localStorage.getItem('reels_custom_presets') || '[]'); } catch (_) { }
                const preset = presets.find(item => item?.name === t.value);
                entry.overlayMediaPresetName = preset?.name || '';
                entry.overlayMediaPresetLayers = Array.isArray(preset?.overlays) ? JSON.parse(JSON.stringify(preset.overlays)) : null;
            }
            else entry.musicPath = t.value;
            _bcRenderBindings();
            _bcScheduleDraftSave();
            return;
        }
        if (t.id === 'bc-allow-reuse') {
            if (!t.checked) {
                const used = new Set();
                const repeated = (_bulkState.groupAssignments || []).some(entry => {
                    if (entry.templateIndex < 0) return false;
                    if (used.has(entry.templateIndex)) return true;
                    used.add(entry.templateIndex);
                    return false;
                });
                if (repeated) {
                    alert('当前有模板被重复选用，请先调整重复的匹配或设为未分配，再关闭重复使用。');
                    t.checked = true;
                    return;
                }
            }
            _bulkState.allowTemplateReuse = t.checked;
            _bcRenderBindings();
            _bcScheduleDraftSave();
            return;
        }
        if (t.id === 'bc-allow-bg-reuse') {
            _bulkState.allowBackgroundReuse = t.checked;
            _bcRenderBindings();
            _bcScheduleDraftSave();
            return;
        }
        if (t.classList.contains('bc-template-assign-group')) {
            const ti = Number(t.dataset.template);
            const oldGroupKey = t.dataset.currentGroup || '';
            const newGroupKey = t.value || '';
            _bcChangeTemplateGroupAssignment(ti, oldGroupKey, newGroupKey);
            return;
        }
        if (t.classList.contains('bc-music-assign-group')) {
            const musicPath = t.dataset.music;
            const oldGroupKey = t.dataset.currentGroup || '';
            const newGroupKey = t.value || '';
            _bcChangeMusicGroupAssignment(musicPath, oldGroupKey, newGroupKey);
            return;
        }
        if (t.id === 'bc-filter-unassigned-tpls') {
            _bulkState.filterUnassignedTemplates = t.checked;
            _bcRenderBindings();
            _bcScheduleDraftSave();
            return;
        }
        if (t.id === 'bc-filter-unassigned-bgs') {
            _bulkState.filterUnassignedBackgrounds = t.checked;
            _bcRenderBindings();
            _bcScheduleDraftSave();
            return;
        }
        if (t.id === 'bc-allow-music-reuse') {
            _bulkState.allowMusicReuse = t.checked;
            _bcRenderBindings();
            _bcScheduleDraftSave();
            return;
        }
        if (t.id === 'bc-filter-unassigned-music') {
            _bulkState.filterUnassignedMusic = t.checked;
            _bcRenderBindings();
            _bcScheduleDraftSave();
            return;
        }
        if (t.id === 'bc-filter-unassigned-groups') {
            _bulkState.filterUnassignedGroups = t.checked;
            _bcRenderBindings();
            _bcScheduleDraftSave();
            return;
        }
        if (t.classList.contains('bc-group-template')) {
            _bcSetGroupTemplate(t.dataset.group, Number(t.value));
            return;
        }
        if (t.classList.contains('bc-group-field')) {
            const entry = _bulkState.groupAssignments?.find(item => item.key === t.dataset.group);
            if (entry) {
                if (!entry.bindings) entry.bindings = {};
                entry.bindings[t.dataset.field] = _bulkState.columns[Number(t.value)]?.name ?? null;
                _bcScheduleDraftSave();
            }
            return;
        }
        if (t.classList.contains('bc-tpl-folder-mode')) {
            const ti = parseInt(t.dataset.ti);
            const tpl = _bulkState.templates[ti];
            if (!tpl) return;
            tpl.materialFolder = {
                path: tpl.materialFolder?.path || '',
                files: Array.isArray(tpl.materialFolder?.files) ? tpl.materialFolder.files : [],
                refreshedAt: tpl.materialFolder?.refreshedAt || 0,
                columnIndex: Number.isInteger(tpl.materialFolder?.columnIndex) ? tpl.materialFolder.columnIndex : null,
                mode: t.value === 'concat' ? 'concat' : 'rows',
            };
            if (tpl.materialFolder.mode === 'concat' && Number.isInteger(tpl.materialFolder.columnIndex)) {
                const oldFiles = new Set(tpl.materialFolder.files || []);
                const ci = tpl.materialFolder.columnIndex;
                _bulkState.rows.forEach(row => {
                    if (oldFiles.has(row?.[ci])) row[ci] = '';
                });
                _bcRenderTable();
            }
            if (tpl.materialFolder.path) _bcRefreshTemplateMaterialFolder(tpl, ti);
            else _bcScheduleDraftSave();
            return;
        }
        if (t.classList.contains('bc-col-name')) {
            const ci = parseInt(t.dataset.ci);
            const nextName = String(t.value || '');
            const oldName = String(_bulkState.columns[ci].name || '');
            const groupKeysBeforeEdit = _bcNumberedColumnGroups().map(group => group.key);
            const hasBindings = (_bulkState.templates || []).some(tpl =>
                Object.values(tpl.bindings || {}).some(boundCi => Number(boundCi) === ci));
            let keptBinding = false;
            if (!nextName.trim() && oldName.trim() && hasBindings) {
                const clearBinding = confirm(`表头「${oldName}」仍有模板字段绑定。\n\n确定：清空表头，并解除这一列的绑定。\n取消：清空表头，但保留原绑定；对应任务组会显示“缺少表头”提醒。`);
                if (clearBinding) _bcClearBindingsForColumn(ci);
                else keptBinding = true;
            }
            _bulkState.columns[ci].name = nextName;
            const groupKeysAfterEdit = new Set(_bcNumberedColumnGroups().map(group => group.key));
            const disappearedKeys = groupKeysBeforeEdit.filter(key => !groupKeysAfterEdit.has(key));
            const retained = new Set(_bulkState.missingHeaderGroupKeys || []);
            if (keptBinding) disappearedKeys.forEach(key => retained.add(key));
            else disappearedKeys.forEach(key => retained.delete(key));
            // 一旦表头重新出现，它不再是“缺少表头”的临时组。
            groupKeysAfterEdit.forEach(key => retained.delete(key));
            _bulkState.missingHeaderGroupKeys = [...retained];
            _bcWarnDuplicateHeaderGroups();
            _bcRenderBindings(); _bcScheduleDraftSave(); return;
        }
        if (t.classList.contains('bc-col-kind')) {
            const ci = parseInt(t.dataset.ci);
            _bcSetColumnKind(_bulkState.columns[ci], t.value);
            _bcClearInvalidBindingsForColumn(ci);
            _bcRenderTable();
            _bcRenderBindings();
            _bcScheduleDraftSave();
            return;
        }
        if (t.classList.contains('bc-tpl-group')) {
            const tpl = _bulkState.templates[Number(t.dataset.ti)];
            const group = _bcNumberedColumnGroups().find(group => group.key === t.value);
            if (tpl && group) _bcBindNumberedGroup(tpl, group);
            _bcRenderBindings();
            _bcScheduleDraftSave();
            return;
        }
        if (t.classList.contains('bc-bind-sel')) {
            const ti = parseInt(t.dataset.ti);
            const fk = t.dataset.fk;
            const newVal = parseInt(t.value);
            const colName = newVal >= 0 ? (_bulkState.columns[newVal]?.name || '') : '不绑定';
            console.log(`[BulkCreate] ✅ 绑定变更: 模板[${ti}]「${_bulkState.templates[ti]?.label}」字段[${fk}] → col[${newVal}]「${colName}」`);
            _bulkState.templates[ti].bindings[fk] = newVal;
            // 视觉反馈：闪烁
            t.style.border = '1px solid #4ade80';
            t.style.background = 'rgba(74,222,128,0.15)';
            setTimeout(() => { t.style.border = ''; t.style.background = ''; }, 600);
            _bcScheduleDraftSave();
            return;
        }
    });

    // ── Video thumbnail hover preview ──
    ov.addEventListener('mouseover', e => {
        const thumb = e.target.closest?.('.bc-bg-folder-thumb');
        if (thumb) {
            const vid = thumb.querySelector('video');
            if (vid && vid.paused) vid.play().catch(() => {});
        }
    });
    ov.addEventListener('mouseout', e => {
        const thumb = e.target.closest?.('.bc-bg-folder-thumb');
        if (thumb && (!e.relatedTarget || !thumb.contains(e.relatedTarget))) {
            const vid = thumb.querySelector('video');
            if (vid) {
                vid.pause();
                try { vid.currentTime = 0.1; } catch (_) {}
            }
        }
    });

    // ── Input events (live cell editing) ──
    const tableBody = ov.querySelector('#bc-table-body');
    tableBody.addEventListener('input', e => {
        const t = e.target;
        if (t.classList.contains('bc-cell')) {
            const ri=parseInt(t.dataset.ri), ci=parseInt(t.dataset.ci);
            if (_bulkState.rows[ri]) _bulkState.rows[ri][ci] = t.value;
            _bcScheduleDraftSave();
        }
    });

    // ── Text Processing Utilities ──
    function _bcCleanBreaks(text) {
        return (text || '').replace(/\r?\n+/g, ' ').replace(/ {2,}/g, ' ').trim();
    }
    function _bcCleanBlankLines(text) {
        const lines = text.split(/\r?\n/);
        const newLines = [];
        let blank = false;
        for (const line of lines) {
            if (line.trim() === '') {
                if (!blank) { newLines.push(''); blank = true; }
            } else { newLines.push(line); blank = false; }
        }
        return newLines.join('\n');
    }
    function _bcAutoWrapText(text, width = 18) {
        const paragraphs = (text || '').trim().split(/\n\s*\n/);
        const wrappedResult = [];
        for (const para of paragraphs) {
            const words = para.trim().split(/\s+/);
            if (!words || (words.length === 1 && words[0] === '')) continue;
            let line = '';
            for (const word of words) {
                if (!line) { line = word; }
                else if (line.length + 1 + word.length <= width) { line += ' ' + word; }
                else { wrappedResult.push(line); line = word; }
                const lastChar = line.slice(-1);
                if (line && [':', '.', '?', '!', '：', '。', '？', '！'].includes(lastChar)) {
                    wrappedResult.push(line);
                    line = '';
                }
            }
            if (line) wrappedResult.push(line);
            wrappedResult.push('');
        }
        while (wrappedResult.length > 0 && wrappedResult[wrappedResult.length - 1] === '') wrappedResult.pop();
        return _bcCleanBlankLines(wrappedResult.join('\n'));
    }
    function _bcSplitTwoParts(text) {
        text = (text || '').toString().trim();
        if (!text) return { title: '', content: '' };
        let lines = text.split(/\r?\n/);
        while (lines.length > 0 && lines[0].trim() === '') lines.shift();
        if (lines.length > 1) {
            const contentLines = lines.slice(1);
            while (contentLines.length > 0 && contentLines[0].trim() === '') contentLines.shift();
            return { title: lines[0].trim(), content: contentLines.join('\n').trim() };
        } else {
            const sentences = text.match(/[^。！？?!]+[。！？?!]?/g);
            if (sentences && sentences.length > 1) {
                return { title: sentences[0].trim(), content: sentences.slice(1).join('').trim() };
            } else {
                return { title: text.trim(), content: '' };
            }
        }
    }
    function _bcSplitThreeParts(text) {
        text = (text || '').toString().trim();
        if (!text) return { title: '', content: '', ending: '' };
        let lines = text.split(/\r?\n/);
        while (lines.length > 0 && lines[0].trim() === '') lines.shift();
        if (lines.length > 1) {
            const contentLines = lines.slice(1, -1);
            while (contentLines.length > 0 && contentLines[0].trim() === '') contentLines.shift();
            return { title: lines[0].trim(), content: contentLines.join('\n').trim(), ending: lines[lines.length - 1].trim() };
        } else {
            const sentences = text.match(/[^。！？?!]+[。！？?!]?/g);
            if (sentences && sentences.length > 1) {
                return { title: sentences[0].trim(), content: sentences.slice(1, -1).join('').trim(), ending: sentences[sentences.length - 1].trim() };
            } else {
                return { title: text.trim(), content: '', ending: '' };
            }
        }
    }

    // ── Context menu for text processing ──
    tableBody.addEventListener('contextmenu', e => {
        const t = e.target;
        const cellEl = t.closest('.bc-cell, .bc-grid-td');
        let isCell = !!cellEl;
        let isColHeader = t.closest('th') && !t.classList.contains('bc-col-insert') && !t.classList.contains('bc-col-del') && !t.classList.contains('bc-col-kind');
        
        if (!isCell && !isColHeader) return;
        e.preventDefault();
        
        document.querySelectorAll('.bc-context-menu').forEach(el => el.remove());
        const menu = document.createElement('div');
        menu.className = 'bc-context-menu';
        menu.style.cssText = `position:fixed;top:${e.clientY}px;left:${e.clientX}px;background:#1a1a2e;border:1px solid #333;border-radius:8px;padding:4px;box-shadow:0 4px 12px rgba(0,0,0,0.5);z-index:500000;display:flex;flex-direction:column;min-width:160px;`;
        
        let targetCi = -1, targetRi = -1;
        if (isCell) {
            targetCi = parseInt(cellEl.dataset.ci);
            targetRi = parseInt(cellEl.dataset.ri);
        } else {
            const input = t.closest('th').querySelector('.bc-col-name');
            if (input) targetCi = parseInt(input.dataset.ci);
        }
        if (targetCi < 0) return;

        const createItem = (label, icon, onClick) => {
            const btn = document.createElement('button');
            btn.style.cssText = 'padding:8px 12px;background:transparent;border:none;color:#ddd;font-size:12px;text-align:left;cursor:pointer;border-radius:4px;display:flex;align-items:center;gap:8px;';
            btn.innerHTML = `<span>${icon}</span> <span>${label} ${isCell ? '(单格)' : '(整列)'}</span>`;
            btn.onmouseenter = () => btn.style.background = 'rgba(255,255,255,0.1)';
            btn.onmouseleave = () => btn.style.background = 'transparent';
            btn.onclick = () => { 
                onClick(); 
                menu.remove(); 
                _bcRenderTable(); 
                if (isCell) _bcUpdateSelectionUI(); // Keep selection after process
                _bcScheduleDraftSave();
            };
            return btn;
        };

        const processItems = (processor, needsExtraCols) => {
            let selectedRows = [targetRi];
            let processTargetCi = targetCi;

            if (isCell && _bcSelection) {
                const minR = Math.min(_bcSelection.r1, _bcSelection.r2);
                const maxR = Math.max(_bcSelection.r1, _bcSelection.r2);
                const minC = Math.min(_bcSelection.c1, _bcSelection.c2);
                const maxC = Math.max(_bcSelection.c1, _bcSelection.c2);
                // Check if the clicked cell is within the selection grid
                if (targetRi >= minR && targetRi <= maxR && targetCi >= minC && targetCi <= maxC) {
                    selectedRows = [];
                    for (let r = minR; r <= maxR; r++) selectedRows.push(r);
                    processTargetCi = minC; // Default to leftmost column of selection for processing outputs
                }
            } else if (!isCell) {
                selectedRows = _bulkState.rows.map((_, i) => i);
            }

            if (needsExtraCols > 0) {
                // Safely insert new columns immediately to the right instead of overwriting
                for (let i = 0; i < needsExtraCols; i++) {
                    _bulkState.columns.splice(processTargetCi + 1 + i, 0, { name: '拆分列', type: 'text' });
                    _bulkState.rows.forEach(r => r.splice(processTargetCi + 1 + i, 0, ''));
                }
                // Shift bindings for any columns that moved
                _bulkState.templates.forEach(tpl => {
                    for (const [k, v] of Object.entries(tpl.bindings)) {
                        if (v > processTargetCi) tpl.bindings[k] = v + needsExtraCols;
                    }
                });
            }
            selectedRows.forEach(ri => {
                if (!_bulkState.rows[ri]) return;
                const val = _bulkState.rows[ri][processTargetCi] || '';
                if (!val.trim()) return;
                const res = processor(val);
                if (typeof res === 'string') {
                    _bulkState.rows[ri][processTargetCi] = res;
                } else if (res.title !== undefined) {
                    _bulkState.rows[ri][processTargetCi] = res.title;
                    if (res.content !== undefined) _bulkState.rows[ri][processTargetCi + 1] = res.content;
                    if (res.ending !== undefined) _bulkState.rows[ri][processTargetCi + 2] = res.ending;
                }
            });
        };

        if (isColHeader) {
            menu.appendChild(createItem('向左插入一列', '⬅️', () => {
                _bulkState.columns.splice(targetCi, 0, { name: `新列`, type: 'text' });
                _bulkState.rows.forEach(r => r.splice(targetCi, 0, ''));
                _bulkState.templates.forEach(tpl => {
                    for (const [k, v] of Object.entries(tpl.bindings)) { if (v >= targetCi) tpl.bindings[k] = v + 1; }
                });
            }));
            menu.appendChild(createItem('向右插入一列', '➡️', () => {
                _bulkState.columns.splice(targetCi + 1, 0, { name: `新列`, type: 'text' });
                _bulkState.rows.forEach(r => r.splice(targetCi + 1, 0, ''));
                _bulkState.templates.forEach(tpl => {
                    for (const [k, v] of Object.entries(tpl.bindings)) { if (v > targetCi) tpl.bindings[k] = v + 1; }
                });
            }));
            menu.appendChild(createItem('清空整列内容', '🧽', () => {
                _bulkState.rows.forEach(r => { if (r) r[targetCi] = ''; });
            }));
            menu.appendChild(createItem('删除该列', '🗑️', () => {
                if (_bulkState.columns.length <= 1) return;
                _bulkState.columns.splice(targetCi, 1);
                _bulkState.rows.forEach(r => r.splice(targetCi, 1));
                _bulkState.templates.forEach(tpl => {
                    for (const [k, v] of Object.entries(tpl.bindings)) {
                        if (v === targetCi) delete tpl.bindings[k];
                        else if (v > targetCi) tpl.bindings[k] = v - 1;
                    }
                });
                _bcRenderBindings();
            }));
            const div2 = document.createElement('div'); div2.style.cssText = 'height:1px;background:#333;margin:4px 0;';
            menu.appendChild(div2);
            menu.appendChild(createItem('向左移动列', '⏪', () => {
                if (targetCi <= 0) return;
                const ci = targetCi;
                [_bulkState.columns[ci-1], _bulkState.columns[ci]] = [_bulkState.columns[ci], _bulkState.columns[ci-1]];
                _bulkState.rows.forEach(r => { [r[ci-1], r[ci]] = [r[ci], r[ci-1]]; });
                _bulkState.templates.forEach(tpl => {
                    for (const [k, v] of Object.entries(tpl.bindings)) {
                        if (v === ci) tpl.bindings[k] = ci - 1;
                        else if (v === ci - 1) tpl.bindings[k] = ci;
                    }
                });
                _bcRenderBindings();
            }));
            menu.appendChild(createItem('向右移动列', '⏩', () => {
                if (targetCi >= _bulkState.columns.length - 1) return;
                const ci = targetCi;
                [_bulkState.columns[ci], _bulkState.columns[ci+1]] = [_bulkState.columns[ci+1], _bulkState.columns[ci]];
                _bulkState.rows.forEach(r => { [r[ci], r[ci+1]] = [r[ci+1], r[ci]]; });
                _bulkState.templates.forEach(tpl => {
                    for (const [k, v] of Object.entries(tpl.bindings)) {
                        if (v === ci) tpl.bindings[k] = ci + 1;
                        else if (v === ci + 1) tpl.bindings[k] = ci;
                    }
                });
                _bcRenderBindings();
            }));
            const div3 = document.createElement('div'); div3.style.cssText = 'height:1px;background:#333;margin:4px 0;';
            menu.appendChild(div3);
        }

        menu.appendChild(createItem('清理换行', '🧹', () => processItems(v => _bcCleanBreaks(v), 0)));
        const savedWrapWidth = parseInt(localStorage.getItem('bc_auto_wrap_width') || '18', 10) || 18;
        menu.appendChild(createItem(`自动断行 (${savedWrapWidth}字)`, '↩️', () => processItems(v => _bcAutoWrapText(v, savedWrapWidth), 0)));
        menu.appendChild(createItem('设置断行字数...', '⚙️', async () => {
            const input = await _bcPrompt('设置自动断行字数', '当前字数: ' + savedWrapWidth);
            if (input !== null) {
                const newWidth = parseInt(input.trim(), 10);
                if (!isNaN(newWidth) && newWidth > 0) {
                    localStorage.setItem('bc_auto_wrap_width', newWidth);
                    if (typeof showToast === 'function') showToast(`自动断行字数已设置为 ${newWidth}，再次右键生效`, 'success');
                } else {
                    if (typeof showToast === 'function') showToast('请输入有效的正整数', 'error');
                }
            }
        }));
        const div = document.createElement('div'); div.style.cssText = 'height:1px;background:#333;margin:4px 0;';
        menu.appendChild(div);
        menu.appendChild(createItem('拆分两段 (标/内)', '✂️', () => processItems(v => _bcSplitTwoParts(v), 1)));
        menu.appendChild(createItem('拆分三段 (标/内/尾)', '📑', () => processItems(v => _bcSplitThreeParts(v), 2)));
        
        document.body.appendChild(menu);
        
        // Auto-close on click outside. Use capture because the modal stops bubbling events.
        const closeMenu = (ev) => {
            if (!menu.contains(ev.target)) {
                menu.remove();
                document.removeEventListener('mousedown', closeMenu, true);
                document.removeEventListener('contextmenu', closeMenu, true);
                document.removeEventListener('scroll', closeMenu, true);
                document.removeEventListener('keydown', closeMenuKey, true);
            }
        };
        const closeMenuKey = (ev) => {
            if (ev.key === 'Escape') closeMenu(ev);
        };
        setTimeout(() => {
            document.addEventListener('mousedown', closeMenu, true);
            document.addEventListener('contextmenu', closeMenu, true);
            document.addEventListener('scroll', closeMenu, true);
            document.addEventListener('keydown', closeMenuKey, true);
        }, 10);
    });

    function _bcOpenExpandedEditor(ri, ci, initialValue) {
        if (ri < 0 || ci < 0 || !_bulkState.rows[ri]) return;
        const colName = _bulkState.columns[ci]?.name || `列${ci + 1}`;
        const val = initialValue !== undefined ? initialValue : (_bulkState.rows[ri]?.[ci] || '');

        const m = document.createElement('div');
        m.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:400000;background:rgba(0,0,0,0.88);display:flex;align-items:center;justify-content:center;';
        m.innerHTML = `<div style="background:#1a1a2e;border:1px solid #444;border-radius:12px;width:600px;max-width:90vw;max-height:85vh;display:flex;flex-direction:column;box-shadow:0 10px 40px rgba(0,0,0,0.8);">
            <div style="padding:10px 16px;border-bottom:1px solid #333;display:flex;justify-content:space-between;align-items:center;flex-shrink:0;">
                <span style="color:#fff;font-size:13px;font-weight:600;">✏️ ${_bcEsc(colName)} — 第 ${ri + 1} 行</span>
                <div style="display:flex;gap:6px;">
                    <button id="bc-exp-ok" style="padding:4px 16px;background:linear-gradient(135deg,#7c5cff,#a855f7);border:none;border-radius:5px;color:#fff;cursor:pointer;font-size:11px;font-weight:600;">保存</button>
                    <button id="bc-exp-cancel" style="padding:4px 12px;background:rgba(255,255,255,0.05);border:1px solid #333;border-radius:5px;color:#888;cursor:pointer;font-size:11px;">取消</button>
                </div>
            </div>
            <div style="padding:12px;flex:1;overflow:auto;">
                <textarea id="bc-exp-textarea" style="width:100%;min-height:300px;max-height:60vh;background:#0a0a14;border:1px solid #333;border-radius:8px;color:#ddd;font-size:13px;line-height:1.6;padding:12px;resize:vertical;box-sizing:border-box;font-family:inherit;">${_bcEsc(val)}</textarea>
                <div style="margin-top:6px;font-size:10px;color:#555;text-align:right;">Ctrl+Enter 保存 · Esc 取消</div>
            </div>
        </div>`;
        document.body.appendChild(m);

        const ta = m.querySelector('#bc-exp-textarea');
        setTimeout(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 50);

        const save = () => {
            if (_bulkState.rows[ri]) _bulkState.rows[ri][ci] = ta.value;
            m.remove();
            _bcRenderTable();
            _bcScheduleDraftSave();
        };
        m.querySelector('#bc-exp-ok').onclick = save;
        m.querySelector('#bc-exp-cancel').onclick = () => m.remove();
        ta.addEventListener('keydown', ev => {
            if (ev.key === 'Escape') { ev.preventDefault(); m.remove(); }
            if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); save(); }
        });
        m.addEventListener('click', ev => { if (ev.target === m) m.remove(); });
    }

    async function _bcPickMediaFiles(ri, ci) {
        if (!_bcIsMediaColumn(ci)) return;
        let paths = null;
        const kind = _bcColumnKind(_bulkState.columns[ci]);
        const filterByKind = {
            image: { name: '图片文件', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'] },
            video: { name: '视频文件', extensions: ['mp4', 'mov', 'mkv', 'avi', 'wmv', 'flv', 'webm'] },
            audio: { name: '音频文件', extensions: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'wma'] },
            subtitle: { name: '字幕文件', extensions: ['srt', 'vtt', 'ass'] },
        };
        if (window.electronAPI?.selectFiles) {
            paths = await window.electronAPI.selectFiles({
                title: `选择${_bulkState.columns[ci]?.name || '素材'}文件`,
                multiple: true,
                filters: [
                    filterByKind[kind] || { name: '媒体与字幕文件', extensions: ['mp4', 'mov', 'mkv', 'avi', 'wmv', 'flv', 'webm', 'jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'wma', 'srt', 'vtt', 'ass'] },
                    { name: '所有文件', extensions: ['*'] },
                ],
            });
        } else {
            const input = document.createElement('input');
            input.type = 'file';
            input.multiple = true;
            input.accept = 'video/*,image/*,audio/*';
            paths = await new Promise(resolve => {
                input.onchange = () => resolve(Array.from(input.files || []).map(_bcNativeFilePath));
                input.click();
            });
        }
        const count = _bcFillMediaColumn(paths || [], ri, ci);
        if (count && typeof showToast === 'function') showToast(`已添加 ${count} 个素材到「${_bulkState.columns[ci]?.name || '素材'}」列`, 'success');
    }

    // ── Double-click to expand cell editor ──
    tableBody.addEventListener('dblclick', e => {
        const cell = e.target.closest('.bc-cell, .bc-grid-td');
        if (!cell) return;
        e.preventDefault(); e.stopPropagation();
        const ri = parseInt(cell.dataset.ri);
        const ci = parseInt(cell.dataset.ci);
        if (_bcIsMediaColumn(ci)) {
            _bcPickMediaFiles(ri, ci);
            return;
        }
        _bcOpenExpandedEditor(ri, ci);
    });

    // ── Mouse Selection Events ──
    const bcCellFromPoint = (clientX, clientY) => {
        const el = document.elementFromPoint(clientX, clientY);
        return el ? el.closest('.bc-cell, .bc-grid-td') : null;
    };
    const bcExtendSelectionTo = (cell) => {
        if (!cell || !_bcSelection) return;
        const ri = parseInt(cell.dataset.ri);
        const ci = parseInt(cell.dataset.ci);
        if (Number.isNaN(ri) || Number.isNaN(ci)) return;
        if (_bcSelection.r2 === ri && _bcSelection.c2 === ci) return;
        _bcSelection.r2 = ri;
        _bcSelection.c2 = ci;
        _bcUpdateSelectionUI();
    };

    tableBody.addEventListener('mousedown', e => {
        if (e.button !== 0) return;
        if (e.target.closest('.bc-cell-presets')) return;
        const cell = e.target.closest('.bc-cell, .bc-grid-td');
        if (!cell) {
            _bcSelection = null;
            _bcUpdateSelectionUI();
            return;
        }
        e.preventDefault();
        tableBody.focus();

        const ri = parseInt(cell.dataset.ri);
        const ci = parseInt(cell.dataset.ci);
        _bcIsSelecting = true;
        if (e.shiftKey && _bcSelection) {
            _bcSelection.r2 = ri;
            _bcSelection.c2 = ci;
        } else {
            _bcSelection = { r1: ri, c1: ci, r2: ri, c2: ci };
        }
        _bcUpdateSelectionUI();
    });

    document.addEventListener('mousemove', e => {
        if (!_bcIsSelecting) return;
        e.preventDefault();
        bcExtendSelectionTo(bcCellFromPoint(e.clientX, e.clientY));
    }, { signal: bcModalSignal });

    document.addEventListener('mouseup', () => {
        if (_bcIsSelecting) {
            _bcIsSelecting = false;
            _bcUpdateSelectionUI();
        }
    }, { signal: bcModalSignal });

    const _bcClearMediaDropTargets = () => {
        tableBody.querySelectorAll('.bc-media-drop-target').forEach(el => el.classList.remove('bc-media-drop-target'));
    };
    const _bcMediaDropTarget = (target) => {
        const cell = target.closest?.('.bc-grid-td, .bc-cell');
        if (cell) {
            const ci = parseInt(cell.dataset.ci);
            if (_bcIsMediaColumn(ci)) {
                return {
                    ci,
                    ri: parseInt(cell.dataset.ri),
                    el: cell.classList.contains('bc-grid-td') ? cell : cell.closest('.bc-grid-td'),
                };
            }
        }
        const th = target.closest?.('.bc-col-header');
        if (th) {
            const ci = parseInt(th.dataset.ci);
            if (_bcIsMediaColumn(ci)) return { ci, ri: 0, el: th };
        }
        return null;
    };

    tableBody.addEventListener('dragover', e => {
        const target = _bcMediaDropTarget(e.target);
        if (!target) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'copy';
        _bcClearMediaDropTargets();
        if (target.el) target.el.classList.add('bc-media-drop-target');
    });

    tableBody.addEventListener('dragleave', e => {
        if (!tableBody.contains(e.relatedTarget)) _bcClearMediaDropTargets();
    });

    tableBody.addEventListener('drop', e => {
        const target = _bcMediaDropTarget(e.target);
        _bcClearMediaDropTargets();
        if (!target) return;
        const files = Array.from(e.dataTransfer.files || []);
        if (!files.length) return;
        e.preventDefault();
        e.stopPropagation();
        const paths = files.map(_bcNativeFilePath).filter(Boolean);
        const count = _bcFillMediaColumn(paths, target.ri, target.ci);
        if (count && typeof showToast === 'function') showToast(`已拖入 ${count} 个素材到「${_bulkState.columns[target.ci]?.name || '素材'}」列`, 'success');
    });

    // ── Keyboard Navigation & Bulk Operations ──
    tableBody.addEventListener('keydown', e => {
        const t = e.target;
        const isTable = t === tableBody;
        if (!isTable) return;
        if (!_bcSelection && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'Enter', 'Backspace', 'Delete'].includes(e.key)) {
            _bcSelection = { r1: 0, c1: 0, r2: 0, c2: 0 };
            _bcUpdateSelectionUI();
        }
        if (!_bcSelection) return;

        const bounds = _bcSelectionBounds();
        const isMulti = bounds && (bounds.minR !== bounds.maxR || bounds.minC !== bounds.maxC);

        // Copy (Ctrl+C / Cmd+C)
        if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
            e.preventDefault();
            let clip = '';
            for (let r = bounds.minR; r <= bounds.maxR; r++) {
                let rowClip = [];
                for (let c = bounds.minC; c <= bounds.maxC; c++) {
                    let val = _bulkState.rows[r]?.[c] || '';
                    if (val.includes('\n') || val.includes('\t') || val.includes('"')) {
                        val = '"' + val.replace(/"/g, '""') + '"';
                    }
                    rowClip.push(val);
                }
                clip += rowClip.join('\t') + '\n';
            }
            navigator.clipboard.writeText(clip);
            return;
        }

        // Delete Bulk Content
        if ((e.key === 'Backspace' || e.key === 'Delete') && _bcSelection) {
            e.preventDefault();
            for (let r = bounds.minR; r <= bounds.maxR; r++) {
                for (let c = bounds.minC; c <= bounds.maxC; c++) {
                    if (_bulkState.rows[r]) _bulkState.rows[r][c] = '';
                }
            }
            _bcRenderTable();
            _bcScheduleDraftSave();
            return;
        }

        let ri = _bcSelection.r1;
        let ci = _bcSelection.c1;
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
            e.preventDefault();
            _bcOpenExpandedEditor(ri, ci, e.key);
            return;
        }
        if ((e.key === 'Enter' && (e.ctrlKey || e.metaKey)) || e.key === 'F2') {
            e.preventDefault();
            _bcOpenExpandedEditor(ri, ci);
            return;
        }

        let nextRi = ri, nextCi = ci;
        if (e.key === 'Tab') {
            e.preventDefault();
            if (e.shiftKey) { nextCi = ci - 1; if (nextCi < 0) { nextCi = _bulkState.columns.length - 1; nextRi = ri - 1; } }
            else { nextCi = ci + 1; if (nextCi >= _bulkState.columns.length) { nextCi = 0; nextRi = ri + 1; } }
        } else if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            if (isMulti) {
                _bcOpenExpandedEditor(ri, ci);
                return;
            }
            nextRi = ri + 1;
        } else if (e.key === 'ArrowUp') {
            e.preventDefault(); nextRi = ri - 1;
        } else if (e.key === 'ArrowDown') {
            e.preventDefault(); nextRi = ri + 1;
        } else if (e.key === 'ArrowLeft') {
            e.preventDefault(); nextCi = ci - 1;
        } else if (e.key === 'ArrowRight') {
            e.preventDefault(); nextCi = ci + 1;
        } else { return; }
        // Auto-add row if needed
        if (nextRi >= _bulkState.rows.length) {
            _bulkState.rows.push(new Array(_bulkState.columns.length).fill(''));
            _bcRenderTable();
        }
        if (nextRi < 0) return;
        if (nextCi < 0 || nextCi >= _bulkState.columns.length) return;
        if (e.shiftKey && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
            _bcSelection.r2 = nextRi;
            _bcSelection.c2 = nextCi;
        } else {
            _bcSelection = { r1: nextRi, c1: nextCi, r2: nextRi, c2: nextCi };
        }
        _bcUpdateSelectionUI();
    });

    // ── Smart paste: handles both TSV button and direct Ctrl+V ──
    function _bcHandlePaste(text, anchorRi, anchorCi) {
        if (!text || (!Array.isArray(text) && !text.trim())) return;
        const lines = Array.isArray(text) ? text : _bcParseTSV(text);
        if (lines.length === 0) return;

        // If pasting into a specific cell (not full-table mode)
        if (anchorRi >= 0 && anchorCi >= 0) {
            // Auto-add columns if pasted data exceeds current table width
            const maxPastedCols = Math.max(...lines.map(l => l.length));
            const neededCols = anchorCi + maxPastedCols;
            while (_bulkState.columns.length < neededCols) {
                _bulkState.columns.push({ name: `列${_bulkState.columns.length + 1}`, type: 'text' });
                // Pad all existing rows to match new column count
                _bulkState.rows.forEach(r => r.push(''));
            }
            // Paste starting from anchor cell, expand grid as needed
            lines.forEach((cols, li) => {
                const targetRi = anchorRi + li;
                while (targetRi >= _bulkState.rows.length)
                    _bulkState.rows.push(new Array(_bulkState.columns.length).fill(''));
                cols.forEach((val, colOff) => {
                    const targetCi = anchorCi + colOff;
                    if (targetCi < _bulkState.columns.length && _bulkState.rows[targetRi])
                        _bulkState.rows[targetRi][targetCi] = val;
                });
            });
            _bcSelection = {
                r1: anchorRi,
                c1: anchorCi,
                r2: anchorRi + lines.length - 1,
                c2: anchorCi + maxPastedCols - 1,
            };
            _bcRenderTable();
            _bcRenderBindings();
            _bcScheduleDraftSave();
            return;
        }

        // Full-table paste mode (button or empty table)
        const first = lines[0];
        const colCount = Math.max(...lines.map(l => l.length));

        if (ov.querySelector('#bc-auto-headers').checked) {
            const rule = readHeaderRule();
            if (!rule || !Number.isSafeInteger(rule.start + Math.floor((colCount - 1) / rule.names.length))) {
                alert('请填写有效的整数起始编号和循环列名（逗号或顿号分隔）。');
                return;
            }
            const bindingSnapshot = _bcSnapshotBindingsByHeader();
            _bulkState.columns = Array.from({ length: colCount }, (_, index) => _bcColumnFromName(headerName(rule, index)));
            _bulkState.rowTemplateIds = []; _bulkState.cellTemplateIds = [];
            _bulkState.rows = lines.map(line => Array.from({ length: colCount }, (_, index) => line[index] || ''));
            // 明确保留的任务组跨粘贴继续存在，未匹配组显示缺少表头。
            _bcSelection = null;
            _bcRestoreBindingsByHeader(bindingSnapshot);
            _bcWarnDuplicateHeaderGroups();
            _bcRenderTable();
            _bcRenderBindings();
            _bcScheduleDraftSave();
            return;
        }

        // Ask user about header row
        let hasHdr = false;
        if (lines.length > 1) {
            hasHdr = confirm(`粘贴了 ${lines.length} 行 × ${colCount} 列数据\n\n第一行是否为标题行？\n\n"${first.slice(0, 4).join(' | ')}${first.length > 4 ? ' ...' : ''}"\n\n确定 = 第一行作为列标题\n取消 = 全部作为数据`);
        }

        if (hasHdr) {
            const bindingSnapshot = _bcSnapshotBindingsByHeader();
            _bulkState.columns = first.map(h => _bcColumnFromName(h.trim() || '列'));
            _bulkState.rowTemplateIds = []; _bulkState.cellTemplateIds = [];
            _bulkState.rows = lines.slice(1).map(l => {
                const r = new Array(_bulkState.columns.length).fill('');
                l.forEach((v, i) => { if (i < r.length) r[i] = v; });
                return r;
            });
            _bcRestoreBindingsByHeader(bindingSnapshot);
            _bcWarnDuplicateHeaderGroups();
        } else {
            // Expand columns if needed
            while (_bulkState.columns.length < colCount)
                _bulkState.columns.push({ name: `列${_bulkState.columns.length + 1}`, type: 'text' });
            _bulkState.rowTemplateIds = []; _bulkState.cellTemplateIds = [];
            _bulkState.rows = lines.map(l => {
                const r = new Array(_bulkState.columns.length).fill('');
                l.forEach((v, i) => { if (i < r.length) r[i] = v; });
                return r;
            });
        }
        _bcRenderTable(); _bcRenderBindings(); _bcScheduleDraftSave();
    }

    function _bcPasteIntoSelection(e) {
        const active = document.activeElement;
        if (active && active !== tableBody && /^(INPUT|TEXTAREA|SELECT)$/i.test(active.tagName)) return false;
        if (active && active.isContentEditable) return false;

        const clipboard = e.clipboardData || window.clipboardData;
        const text = _bcParseClipboardTable(clipboard.getData('text/html')) || clipboard.getData('text/plain') || clipboard.getData('text');
        if (!text) return false;

        e.preventDefault();
        e.stopPropagation();
        const cell = e.target.closest?.('.bc-cell, .bc-grid-td');
        if (_bcSelection || cell) {
            const startRi = _bcSelection ? Math.min(_bcSelection.r1, _bcSelection.r2) : parseInt(cell.dataset.ri);
            const startCi = _bcSelection ? Math.min(_bcSelection.c1, _bcSelection.c2) : parseInt(cell.dataset.ci);
            _bcHandlePaste(text, startRi, startCi);
        } else {
            _bcHandlePaste(text, -1, -1);
        }
        return true;
    }

    // Direct Ctrl+V anywhere in the modal as long as a grid cell is selected.
    document.addEventListener('paste', e => {
        const modal = document.getElementById('bc-modal');
        if (!modal) return;
        const active = document.activeElement;
        const eventInsideModal = modal.contains(e.target);
        const focusInsideModal = active && modal.contains(active);
        if (!eventInsideModal && !focusInsideModal) return;
        _bcPasteIntoSelection(e);
    }, { capture: true, signal: bcModalSignal });

    // Paste TSV button (full-table replace mode)
    ov.querySelector('#bc-paste-tsv').addEventListener('click', async () => {
        let text = '';
        try { text = await _bcReadClipboardGrid(); } catch(e) { text = await _bcPrompt('粘贴 TSV 数据', '从 Google Sheets 复制的内容'); }
        _bcHandlePaste(text, -1, -1);
    });
}

window._showBulkCreateModal = _showBulkCreateModal;
