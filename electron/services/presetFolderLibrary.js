const fs = require('fs');
const path = require('path');
const MAX_BYTES = 48 * 1024 * 1024;
const TYPES = {
    subtitle: { folder: '动态字幕预设', file: 'subtitle-presets.json', library: 'subtitle-library.json' },
    overlay: { folder: '覆层预设', file: 'overlay-group-presets.json', library: 'overlay-library.json' },
    color: { folder: '色板预设', file: 'title-color-presets.json', library: 'title-color-library.json' },
    brush: { folder: '笔刷预设', file: 'brush-presets.json' },
    decoration: { folder: '装饰线预设', file: 'decoration-storage.json' },
    bulk: { folder: '大量建立预设', file: 'bulk-create-storage.json' },
    other: { folder: '其他预设', file: 'local-storage-presets.json' },
};
const isMap = value => value && typeof value === 'object' && !Array.isArray(value);
function atomicJSON(file, value) {
    const body = JSON.stringify(value, null, 2);
    if (Buffer.byteLength(body) > MAX_BYTES) throw new Error('预设文件超过 48 MB，未保存');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, body, 'utf8');
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
    fs.renameSync(temp, file);
}
function readJSON(file) {
    if (fs.statSync(file).size > MAX_BYTES) throw new Error('预设文件超过 48 MB');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function normalize(type, data) {
    if (type === 'subtitle') {
        if (isMap(data) && !Object.keys(data).length) return { presets: {} };
        if (!isMap(data) || !isMap(data.presets)) throw new Error('动态字幕文件需包含 presets 字典');
        if (Object.values(data.presets).some(v => !isMap(v) || !['fontsize', 'font_family', 'color_text', 'karaoke_highlight', 'use_box', 'color_bg', 'box_adaptive_width'].some(k => k in v))) throw new Error('不是动态字幕样式');
        return data;
    }
    let items = isMap(data?.presets) ? data.presets : data;
    if (type === 'color' && Array.isArray(items)) items = Object.fromEntries(items.map((v, i) => [v.id || `color_${i + 1}`, v]));
    if (!isMap(items)) throw new Error('预设需为字典');
    for (const v of Object.values(items)) {
        if (type === 'overlay' && !(Array.isArray(v) || (isMap(v) && (Array.isArray(v.layers) || Array.isArray(v.overlays))))) throw new Error('覆层预设需包含 layers 或 overlays');
        if (type === 'color' && !(isMap(v) && (v.titleColor || v.textColor))) throw new Error('色板预设需包含 titleColor 或 textColor');
        if (type === 'brush' && !(typeof v === 'string' && v.startsWith('data:image/') || isMap(v) && typeof v.dataUrl === 'string' && v.dataUrl.startsWith('data:image/'))) throw new Error('笔刷预设需包含图片 dataUrl');
    }
    return items;
}
function merge(type, older, newer) {
    if (type !== 'subtitle') return { ...older, ...newer };
    return { ...older, ...newer, presets: { ...older.presets, ...newer.presets }, presetGroups: { ...older.presetGroups, ...newer.presetGroups } };
}
function createPresetFolderLibrary(app) {
    let active;
    const warnings = new Map();
    // Keep the pointer independent of Chromium origin, install path and custom cache location.
    const configPath = () => path.join(app.getPath('appData'), 'VideoKit', 'preset-folder-settings.json');
    const legacyRoot = () => path.join(app.getPath('userData'), 'videokit-presets');
    function root() {
        if (active === undefined) active = fs.existsSync(configPath()) ? readJSON(configPath()).directory || null : null;
        if (active && (!fs.existsSync(active) || !fs.statSync(active).isDirectory())) throw new Error(`个人预设文件夹不可访问：${active}。请重新连接磁盘或在设置中选择文件夹。`);
        if (!active) fs.mkdirSync(legacyRoot(), { recursive: true });
        return active || legacyRoot();
    }
    function custom() { root(); return !!active; }
    function file(type, filename = TYPES[type].file) { return path.join(root(), ...(custom() ? [TYPES[type].folder] : []), filename); }
    function read(type) {
        const target = file(type);
        let result = type === 'subtitle' ? { presets: {} } : {};
        if (custom()) {
            const dir = path.dirname(target);
            if (fs.existsSync(dir)) for (const entry of fs.readdirSync(dir).sort()) {
                const source = path.join(dir, entry);
                if (!entry.endsWith('.json') || entry === path.basename(target) || entry === TYPES[type].library || !fs.lstatSync(source).isFile()) continue;
                try { result = merge(type, result, normalize(type, readJSON(source))); warnings.delete(source); }
                catch (error) { warnings.set(source, `${source}：${error.message}`); }
            }
        }
        if (fs.existsSync(target)) {
            const data = readJSON(target);
            // Managed stores wrap the renderer payload once. Subtitle's payload
            // itself contains presets/default, unlike palette and overlay maps.
            const saved = data.version === 1 && isMap(data.presets) ? data.presets : data;
            result = merge(type, result, normalize(type, saved));
        }
        return result;
    }
    function write(type, presets) {
        const target = file(type);
        // A damaged library must never be silently replaced with an empty UI cache.
        if (fs.existsSync(target)) read(type);
        normalize(type, presets);
        atomicJSON(target, { version: 1, updatedAt: new Date().toISOString(), presets });
        return { path: target, count: Object.keys(type === 'subtitle' ? presets.presets || {} : presets).length };
    }
    // 个人预设库：统一放在 <个人预设文件夹>/预设库/，界面只读；
    // 删除 = 记入 hidden.json 隐藏，修改 = 另存到“我的预设”。升级靠导入预设库包。
    const LIB_DIR = '预设库';
    const LIB_TYPES = ['overlay', 'color', 'subtitle'];
    const libDir = () => path.join(root(), LIB_DIR);
    const libFile = type => path.join(libDir(), TYPES[type].library);
    const hiddenFile = () => path.join(libDir(), 'hidden.json');
    function migrateLegacyLibrary(type) {
        // 旧版本把库文件放在分类目录或根目录；第一次读取时搬到 预设库/。
        const target = libFile(type);
        if (fs.existsSync(target)) return;
        for (const old of [file(type, TYPES[type].library), path.join(root(), TYPES[type].library)]) {
            if (old !== target && fs.existsSync(old)) {
                fs.mkdirSync(libDir(), { recursive: true });
                fs.renameSync(old, target);
                return;
            }
        }
    }
    function readLibrary(type) {
        migrateLegacyLibrary(type);
        const target = libFile(type);
        const empty = { meta: null, presets: type === 'subtitle' ? { presets: {} } : {} };
        if (!fs.existsSync(target)) return empty;
        const data = readJSON(target);
        return { meta: { libraryVersion: data.libraryVersion || '', libraryDate: data.libraryDate || '' }, presets: normalize(type, data.presets || {}) };
    }
    function readHidden() {
        try { const d = readJSON(hiddenFile()); return Object.fromEntries(LIB_TYPES.map(t => [t, Array.isArray(d[t]) ? d[t] : []])); }
        catch (_) { return { overlay: [], color: [], subtitle: [] }; }
    }
    function writeHidden(hidden) {
        atomicJSON(hiddenFile(), { version: 1, updatedAt: new Date().toISOString(), ...hidden });
    }
    function libraryInfo() {
        const hidden = readHidden();
        return Object.fromEntries(LIB_TYPES.map(t => {
            const { meta, presets } = readLibrary(t);
            const keys = Object.keys(t === 'subtitle' ? presets.presets || {} : presets);
            return [t, { ...(meta || {}), count: keys.length, hidden: hidden[t].length, keys }];
        }));
    }
    function exportLibraryBundle() {
        const bundle = { format: 'videokit-preset-library', version: 1, exportedAt: new Date().toISOString(), libraries: {} };
        for (const t of LIB_TYPES) {
            migrateLegacyLibrary(t);
            if (fs.existsSync(libFile(t))) bundle.libraries[t] = readJSON(libFile(t));
        }
        const v = Object.values(bundle.libraries)[0] || {};
        bundle.libraryVersion = v.libraryVersion || ''; bundle.libraryDate = v.libraryDate || '';
        return bundle;
    }
    function importLibraryBundle(bundle) {
        if (!bundle || bundle.format !== 'videokit-preset-library' || !isMap(bundle.libraries)) throw new Error('不是 VideoKit 预设库文件');
        // 全部校验通过后再写入；旧版本整体存到 预设库/历史版本/。
        const staged = [];
        for (const t of LIB_TYPES) {
            const lib = bundle.libraries[t];
            if (!lib) continue;
            normalize(t, lib.presets || {});
            staged.push([t, lib]);
        }
        if (!staged.length) throw new Error('预设库文件里没有可导入的内容');
        const old = exportLibraryBundle();
        if (Object.keys(old.libraries).length) {
            const archive = path.join(libDir(), '历史版本', `${old.libraryVersion || 'unversioned'}_${Date.now()}.json`);
            atomicJSON(archive, old);
        }
        for (const [t, lib] of staged) atomicJSON(libFile(t), { ...lib, updatedAt: new Date().toISOString() });
        return libraryInfo();
    }
    function readValues(type) {
        const target = file(type);
        let values = {};
        if (custom() && fs.existsSync(path.dirname(target))) {
            for (const entry of fs.readdirSync(path.dirname(target)).sort()) {
                const source = path.join(path.dirname(target), entry);
                if (!entry.endsWith('.json') || entry === path.basename(target) || entry === 'bulk-create-storage.json' || !fs.lstatSync(source).isFile()) continue;
                try {
                    const data = readJSON(source);
                    if (type === 'decoration' && data.format === 'videokit-divider-presets' && Array.isArray(data.presets)) {
                        const key = 'videokit_vector_dividers_v1';
                        const existing = values[key] ? JSON.parse(values[key]).presets : [];
                        const items = new Map([...existing, ...data.presets].map(v => [v.id, v]));
                        values[key] = JSON.stringify({ ...data, presets: [...items.values()] });
                    } else if (type === 'decoration' && data.format === 'videokit-title-decoration-presets' && Array.isArray(data.presets)) {
                        if (data.presets.some(v => !v || !/^((classic|floral)\d{2})$/.test(v.id) || !v.name)) throw new Error('私人装饰线格式错误');
                        const key = 'videokit_personal_title_decoration_presets_v1';
                        const existing = values[key] ? JSON.parse(values[key]).presets : [];
                        const items = new Map([...existing, ...data.presets].map(v => [v.id, v]));
                        values[key] = JSON.stringify({ ...data, presets: [...items.values()] });
                    } else {
                        if (data.format !== 'videokit-storage-values' || !isMap(data.values)) throw new Error('其他预设需使用 videokit-storage-values 格式');
                        for (const [key, value] of Object.entries(data.values)) {
                            if (typeof value !== 'string' || !/(?:preset|template|watermark|brush|vector_dividers)/i.test(key)) throw new Error('不是可识别的预设存储键');
                            if (type === 'decoration' && !/decoration|vector_dividers/.test(key)) throw new Error('不是装饰线预设');
                            values[key] = value;
                        }
                    }
                    warnings.delete(source);
                } catch (error) { warnings.set(source, `${source}：${error.message}`); }
            }
        }
        if (fs.existsSync(target)) {
            const data = readJSON(target);
            if (!isMap(data.values)) throw new Error(`预设存储文件格式错误：${target}`);
            values = { ...values, ...data.values };
        }
        return values;
    }
    function writeValues(type, values) {
        const target = file(type);
        if (fs.existsSync(target)) readJSON(target);
        atomicJSON(target, { version: 1, updatedAt: new Date().toISOString(), values });
    }
    function info() {
        warnings.clear();
        const directory = root();
        for (const type of ['subtitle', 'overlay', 'color', 'brush']) read(type);
        if (custom()) { readValues('decoration'); readValues('other'); }
        return { directory, custom: custom(), configPath: configPath(), categories: Object.entries(TYPES).map(([type, item]) => ({ type, ...item, path: file(type) })), warnings: [...warnings.values()] };
    }
    function select(directory) {
        if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error('请选择绝对路径的文件夹');
        const next = path.resolve(directory);
        if (!fs.statSync(next).isDirectory()) throw new Error('所选路径不是文件夹');
        let previous;
        try { previous = root(); } catch (error) {
            if (!active || fs.existsSync(active)) throw error;
            previous = active;
        }
        const previousAvailable = fs.existsSync(previous);
        if (next === previous) return info();
        // Copy managed libraries only; source JSON files remain independently editable.
        // Stage every source read before mutation, and retain both originals and backups.
        const transfers = [];
        for (const type of ['subtitle', 'overlay', 'color', 'brush']) {
            if (TYPES[type].library && previousAvailable) {
                const target = path.join(next, LIB_DIR, TYPES[type].library);
                const candidates = [path.join(previous, LIB_DIR, TYPES[type].library), path.join(previous, ...(active ? [TYPES[type].folder] : []), TYPES[type].library)];
                const libSource = candidates.find(p => fs.existsSync(p));
                if (libSource && !fs.existsSync(target)) {
                    const data = readJSON(libSource);
                    normalize(type, data.presets || {});
                    transfers.push([target, data, 'library', type]);
                }
            }
            const source = path.join(previous, ...(active ? [TYPES[type].folder] : []), TYPES[type].file);
            if (previousAvailable && fs.existsSync(source)) {
                const data = readJSON(source);
                normalize(type, data.version === 1 ? data.presets : data);
                transfers.push([path.join(next, TYPES[type].folder, TYPES[type].file), data, 'presets', type]);
            }
        }
        for (const [type, filename] of [['other', 'local-storage-presets.json'], ['bulk', 'bulk-create-storage.json'], ['decoration', 'decoration-storage.json']]) {
            let source = path.join(previous, ...(active ? [TYPES[type].folder] : []), filename);
            if (type === 'bulk' && active && !fs.existsSync(source)) source = path.join(previous, TYPES.other.folder, filename);
            if (previousAvailable && fs.existsSync(source)) {
                const data = readJSON(source);
                if (!isMap(data.values)) throw new Error(`预设存储文件格式错误：${source}`);
                transfers.push([path.join(next, TYPES[type].folder, filename), data, 'values', type]);
            }
        }
        const hiddenSource = path.join(previous, LIB_DIR, 'hidden.json');
        if (previousAvailable && fs.existsSync(hiddenSource) && !fs.existsSync(path.join(next, LIB_DIR, 'hidden.json'))) {
            transfers.push([path.join(next, LIB_DIR, 'hidden.json'), readJSON(hiddenSource), 'library', 'hidden']);
        }
        for (const [target, source, key, type] of transfers) {
            if (key === 'library') continue;
            if (fs.existsSync(target)) {
                const destination = readJSON(target);
                if (!isMap(source[key]) || !isMap(destination[key])) throw new Error(`预设库格式不正确：${target}`);
                source[key] = type === 'subtitle' ? merge(type, source[key], destination[key]) : { ...source[key], ...destination[key] };
            }
        }
        for (const [type, item] of Object.entries(TYPES)) {
            const target = path.join(next, item.folder, item.file);
            if (!fs.existsSync(target)) continue;
            const data = readJSON(target);
            if (['subtitle', 'overlay', 'color', 'brush'].includes(type)) normalize(type, data.version === 1 ? data.presets : data);
            else if (!isMap(data.values)) throw new Error(`预设存储文件格式错误：${target}`);
        }
        for (const { folder } of Object.values(TYPES)) fs.mkdirSync(path.join(next, folder), { recursive: true });
        for (const [target, value] of transfers) atomicJSON(target, value);
        atomicJSON(configPath(), { version: 1, directory: next });
        active = next;
        warnings.clear();
        return info();
    }
    return { root, custom, file, read, write, readLibrary, readHidden, writeHidden, libraryInfo, exportLibraryBundle, importLibraryBundle, readValues, writeValues, info, select };
}
module.exports = { createPresetFolderLibrary, TYPES, normalize, atomicJSON };
