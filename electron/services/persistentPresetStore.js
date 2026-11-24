/**
 * Durable user-preset storage.
 *
 * Renderer localStorage is convenient for the UI, but it is tied to Chromium's
 * page origin.  This copy lives alongside the template library so a rebuilt or
 * moved desktop app can restore the user's presets before the UI starts.
 */
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const presetFolderLibrary = require('./presetFolderLibrary').createPresetFolderLibrary(app);

const FILE_NAME = 'local-storage-presets.json';
const OVERLAY_GROUP_FILE_NAME = 'overlay-group-presets.json';
const TITLE_COLOR_FILE_NAME = 'title-color-presets.json';
const SUBTITLE_FILE_NAME = 'subtitle-presets.json';
const MAX_BYTES = 48 * 1024 * 1024;

function getPresetLibraryDir() {
    const dir = presetFolderLibrary.root();
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function getPresetFilePath() {
    return presetFolderLibrary.file('other');
}

function getOverlayGroupPresetFilePath() {
    return presetFolderLibrary.file('overlay');
}

// 覆层组预设可能含缩略图、复杂图层和媒体元数据，不能放进 Chromium
// localStorage 的小配额。它是独立的文件库，不参与旧 localStorage 快照迁移。
// 个人预设库（预设库/*-library.json）只读，“我的预设”（原文件）可写。界面看到的是：
// 库（去掉已隐藏）+ 我的预设，同名时我的预设优先。保存时：
//   与库中完全相同 → 不写；新建/改过 → 写入我的预设；库条目被删 → 记入 hidden.json。
const sameJSON = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const omit = (map, keys) => Object.fromEntries(Object.entries(map || {}).filter(([k]) => !keys.has(k)));
function readMerged(type) {
    const lib = presetFolderLibrary.readLibrary(type).presets;
    const hidden = new Set(presetFolderLibrary.readHidden()[type]);
    const mine = presetFolderLibrary.read(type);
    if (type !== 'subtitle') return { ...omit(lib, hidden), ...mine };
    return {
        ...lib, ...mine,
        presets: { ...omit(lib.presets, hidden), ...mine.presets },
        presetGroups: { ...omit(lib.presetGroups, hidden), ...mine.presetGroups },
    };
}
function writeSplit(type, full) {
    const libAll = presetFolderLibrary.readLibrary(type).presets;
    const lib = type === 'subtitle' ? libAll.presets || {} : libAll;
    const incoming = type === 'subtitle' ? full?.presets || {} : full || {};
    const personal = {};
    for (const [k, v] of Object.entries(incoming)) if (!(k in lib) || !sameJSON(lib[k], v)) personal[k] = v;
    // 库里有、界面里没了、我的预设里也没有 → 用户删除了库条目，记为隐藏
    const hiddenAll = presetFolderLibrary.readHidden();
    const hidden = new Set(hiddenAll[type]);
    for (const k of Object.keys(lib)) {
        if (k in incoming) hidden.delete(k); else hidden.add(k);
    }
    if (!sameJSON([...hidden].sort(), [...hiddenAll[type]].sort())) presetFolderLibrary.writeHidden({ ...hiddenAll, [type]: [...hidden] });
    if (type !== 'subtitle') return presetFolderLibrary.write(type, personal);
    const libGroups = libAll.presetGroups || {};
    const myGroups = {};
    for (const [k, g] of Object.entries(full?.presetGroups || {})) if (k in personal || libGroups[k] !== g) myGroups[k] = g;
    return presetFolderLibrary.write(type, { ...full, presets: personal, presetGroups: myGroups });
}
function readOverlayGroupPresets() { return readMerged('overlay'); }
function writeOverlayGroupPresets(presets) { return writeSplit('overlay', presets); }
function readTitleColorPresets() { return readMerged('color'); }
function writeTitleColorPresets(presets) { return writeSplit('color', presets); }
function readSubtitlePresets() { return readMerged('subtitle'); }
function writeSubtitlePresets(presets) { return writeSplit('subtitle', presets); }
function libraryInfo() { return presetFolderLibrary.libraryInfo(); }
function unhideLibraryPresets() { presetFolderLibrary.writeHidden({ overlay: [], color: [], subtitle: [] }); return libraryInfo(); }
function readBrushPresets() {
    const legacy = fs.existsSync(presetFolderLibrary.file('brush')) ? null : readSnapshot().reels_custom_brushes;
    return { ...(legacy ? JSON.parse(legacy) : {}), ...presetFolderLibrary.read('brush') };
}
function writeBrushPresets(presets) { return presetFolderLibrary.write('brush', presets); }

function readSnapshot() {
    const values = { ...presetFolderLibrary.readValues('other'), ...(presetFolderLibrary.custom() ? presetFolderLibrary.readValues('decoration') : {}) };
    if (fs.existsSync(presetFolderLibrary.file('brush'))) delete values.reels_custom_brushes;
    return values;
}

function sanitize(values) {
    const result = {};
    if (!values || typeof values !== 'object') return result;
    for (const [key, value] of Object.entries(values)) {
        if (typeof key === 'string' && key.length <= 200 && typeof value === 'string') result[key] = value;
    }
    return result;
}

// Most UI storage values are JSON maps, for example
// { "我的样式": {...}, "另一个样式": {...} }. Merge those maps recursively so
// a development build and a packaged build can contribute separate presets.
// For a genuinely identical name with different content, the currently opened
// app wins: that is the only side the user can see and deliberately edit.
function mergeValue(storedValue, currentValue) {
    if (storedValue === currentValue) return storedValue;
    let stored;
    let current;
    try { stored = JSON.parse(storedValue); current = JSON.parse(currentValue); } catch (_) { return currentValue; }
    if (!stored || !current || Array.isArray(stored) || Array.isArray(current)
        || typeof stored !== 'object' || typeof current !== 'object') return currentValue;
    const mergeObject = (older, newer) => {
        const result = { ...older };
        for (const [key, value] of Object.entries(newer)) {
            const oldValue = result[key];
            if (oldValue && value && !Array.isArray(oldValue) && !Array.isArray(value)
                && typeof oldValue === 'object' && typeof value === 'object') {
                result[key] = mergeObject(oldValue, value);
            } else {
                result[key] = value;
            }
        }
        return result;
    };
    return JSON.stringify(mergeObject(stored, current));
}

// Large-creation templates are a map of user-assigned names.  Their contents
// are complete snapshots, not field patches: recursively blending two
// snapshots bearing the same name can create an invalid template.  Keep both
// when two running builds saved a different version under one name.
function mergeNamedLibrary(storedValue, currentValue) {
    if (storedValue === currentValue) return storedValue;
    let stored;
    let current;
    try { stored = JSON.parse(storedValue); current = JSON.parse(currentValue); } catch (_) { return currentValue; }
    if (!stored || !current || Array.isArray(stored) || Array.isArray(current)
        || typeof stored !== 'object' || typeof current !== 'object') return currentValue;
    const result = { ...stored };
    for (const [name, incoming] of Object.entries(current)) {
        if (name.includes('冲突备份')) continue;
        const existing = result[name];
        if (!existing || JSON.stringify(existing) === JSON.stringify(incoming)) {
            result[name] = incoming;
            continue;
        }
        const incomingAt = Date.parse(incoming?.savedAt || incoming?.updatedAt || incoming?.createdAt || 0) || 0;
        const existingAt = Date.parse(existing?.savedAt || existing?.updatedAt || existing?.createdAt || 0) || 0;
        result[name] = incomingAt >= existingAt ? incoming : existing;
    }
    // Clean any legacy conflict keys from stored
    for (const key of Object.keys(result)) {
        if (key.includes('冲突备份')) {
            delete result[key];
        }
    }
    return JSON.stringify(result);
}

function mergeSnapshots(storedValues, currentValues) {
    const result = { ...sanitize(storedValues) };
    for (const [key, value] of Object.entries(sanitize(currentValues))) {
        if (!Object.prototype.hasOwnProperty.call(result, key)) {
            result[key] = value;
        } else if (/(?:preset|template|watermark|brush|overlay.*group)/i.test(key)) {
            // All named user libraries use the same non-destructive merge:
            // two app instances can contribute entries without wiping each
            // other, and a same-name collision retains a dated backup.
            result[key] = mergeNamedLibrary(result[key], value);
        } else if (key === 'reels_bulk_create_last_state') {
            // A live draft is one internally linked snapshot.  Do not
            // recursively mix rows, bindings and media arrays from two apps.
            let older = result[key];
            let newer = value;
            try {
                const oldAt = Date.parse(JSON.parse(older)?.savedAt || 0) || 0;
                const newAt = Date.parse(JSON.parse(newer)?.savedAt || 0) || 0;
                if (oldAt > newAt) { older = value; newer = result[key]; }
            } catch (_) { /* keep current app's draft as the winner */ }
            // 草稿是完整快照，每次自动保存都会更新 savedAt。此前把旧快照也
            // 作为一个 localStorage 键回灌，会在大工程中累积 20 份完整草稿，
            // 最终触发浏览器配额错误。硬盘库只保留最新可恢复草稿即可。
            result[key] = newer;
        } else {
            result[key] = mergeValue(result[key], value);
        }
    }
    // Keep recovery useful without allowing frequent autosaves to grow the
    // durable library forever.
    // 清理此前版本写入的历史草稿备份，防止它们在启动时重新灌满 localStorage。
    Object.keys(result)
        .filter(key => key.startsWith('reels_bulk_create_draft_backup_'))
        .forEach(key => delete result[key]);
    return result;
}

function writeSnapshot(values) {
    // A renderer can be behind another build/origin after a restart.  Never let
    // that stale snapshot replace presets which have already reached the
    // durable library; merge it first so a crash/reload cannot erase them.
    const safeValues = mergeSnapshots(readSnapshot(), values);
    if (presetFolderLibrary.custom()) {
        const decorations = Object.fromEntries(Object.entries(safeValues).filter(([key]) => /decoration|vector_dividers/.test(key)));
        presetFolderLibrary.writeValues('decoration', decorations);
        for (const key of Object.keys(decorations)) delete safeValues[key];
    }

    const filePath = getPresetFilePath();
    const body = JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), values: safeValues }, null, 2);
    if (Buffer.byteLength(body, 'utf8') > MAX_BYTES) throw new Error('预设库文件过大，未保存');
    const backupPath = `${filePath}.bak`;
    const tempPath = `${filePath}.${process.pid}.tmp`;
    if (fs.existsSync(filePath)) fs.copyFileSync(filePath, backupPath);
    fs.writeFileSync(tempPath, body, 'utf8');
    fs.renameSync(tempPath, filePath);
    return { count: Object.keys(safeValues).length, path: filePath };
}

// Keep existing durable data on conflict. It is the cross-package source of
// truth; browser storage merely seeds it on the first upgraded launch.
function hydrate(currentValues) {
    const current = sanitize(currentValues);
    const stored = readSnapshot();
    const merged = mergeSnapshots(stored, current);
    if (Object.keys(merged).length && JSON.stringify(merged) !== JSON.stringify(stored)) writeSnapshot(merged);
    return merged;
}

module.exports = { presetFolderLibrary, libraryInfo, unhideLibraryPresets, readBrushPresets, writeBrushPresets, getPresetFilePath, hydrate, writeSnapshot, mergeSnapshots, readOverlayGroupPresets, writeOverlayGroupPresets, readTitleColorPresets, writeTitleColorPresets, readSubtitlePresets, writeSubtitlePresets };

const BULK_STORAGE_KEYS = new Set(['reels_bulk_create_presets', 'reels_bulk_create_last_state', 'reels_bulk_create_viral_projects', 'reels_bulk_create_viral_group_presets']);
function readBulkCreateStorage() {
    let filePath = presetFolderLibrary.file('bulk');
    if (!fs.existsSync(filePath) && presetFolderLibrary.custom()) {
        const oldPath = presetFolderLibrary.file('other', 'bulk-create-storage.json');
        if (fs.existsSync(oldPath)) filePath = oldPath;
    }
    if (fs.existsSync(filePath)) {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (!parsed.values || typeof parsed.values !== 'object') throw new Error('大量制作存储文件格式无效，请保留文件并从备份恢复');
        return parsed.values;
    }
    const legacy = readSnapshot();
    return Object.fromEntries(Object.entries(legacy).filter(([key]) => BULK_STORAGE_KEYS.has(key)));
}
function writeBulkCreateStorage(key, value) {
    if (!BULK_STORAGE_KEYS.has(key)) throw new Error('不支持的存储键');
    if (value !== null && typeof value !== 'string') throw new Error('存储内容必须是 JSON 文本');
    if (value !== null) JSON.parse(value);
    const values = { ...readBulkCreateStorage() };
    if (value === null) delete values[key]; else values[key] = value;
    const filePath = presetFolderLibrary.file('bulk');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const body = JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), values });
    const tempPath = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, body, 'utf8');
    // Keep the previous successful snapshot; replace only after the complete file is written.
    if (fs.existsSync(filePath)) fs.copyFileSync(filePath, `${filePath}.bak`);
    fs.renameSync(tempPath, filePath);
    return { path: filePath };
}
module.exports.readBulkCreateStorage = readBulkCreateStorage;
module.exports.writeBulkCreateStorage = writeBulkCreateStorage;

function backupBulkCreateLegacy(key, value) {
    if (!BULK_STORAGE_KEYS.has(key) || typeof value !== 'string') throw new Error('旧预设备份内容无效');
    JSON.parse(value);
    const hash = require('crypto').createHash('sha256').update(value).digest('hex').slice(0, 16);
    const dir = path.join(getPresetLibraryDir(), 'legacy-browser-backups');
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${key}-${hash}.json`);
    if (!fs.existsSync(filePath)) {
        const values = { [key]: value };
        const body = JSON.stringify({ version: 1, source: 'legacy-browser-localStorage', backedUpAt: new Date().toISOString(), values });
        fs.writeFileSync(filePath, body, { encoding: 'utf8', flag: 'wx' });
    }
    return { path: filePath };
}
module.exports.backupBulkCreateLegacy = backupBulkCreateLegacy;
