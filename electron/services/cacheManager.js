/**
 * VideoKit 安全缓存管理模块
 *
 * 设计原则：
 * 1. 严格白名单清理：只统计与清理可再生的运行时缓存、覆层拆帧与过期临时任务文件。
 * 2. 绝对保护用户数据：绝不触碰预设(videokit-presets)、模板(videokit-templates)、
 *    API 密钥与后端配置(backend/)、Local Storage、IndexedDB、Cookies、Preferences、
 *    字体缓存(fonts-cache)以及云端转录记录(tmp 下的 videokit_log)。
 * 3. 自定义缓存位置只重定向重型临时/缓存目录(tmp)，绝不篡改 Electron userData 目录，
 *    从根源避免“改完缓存位置后预设、密钥、模板全部变空”的问题。
 * 4. 真实统计释放空间：按清理前后实际磁盘占用差值计算 freedSize，并对运行中占用的
 *    Chromium 缓存目录采取逐项清理策略，避免报错中断或虚报释放空间。
 */

const fs = require('fs');
const path = require('path');
const { isBlockedSensitivePath, resolveRealOrTargetPath } = require('./pathSecurity');

const CACHE_SETTINGS_FILENAME = 'cache-settings.json';
const CUSTOM_TMP_SUBDIR_NAME = 'videokit_tmp';
const OVERLAY_CACHE_DIR_NAME = 'videokit_overlay_cache';
const AUTOEDIT_CACHE_DIR_NAME = 'videokit_autoedit_cache';
const DEFAULT_STALE_TMP_MIN_AGE_MS = 10 * 60 * 1000; // 10 分钟内的新建临时文件跳过，避免打断进行中的任务

// 运行时可安全清理的缓存目录（位于 userData 根目录内，严格白名单）
const RUNTIME_CACHE_DIRS = [
    { dir: 'Cache', label: 'Cache' },
    { dir: 'Code Cache', label: 'Code Cache' },
    { dir: 'GPUCache', label: 'GPUCache' },
    { dir: 'GPUPersistentCache', label: 'GPUPersistentCache' },
    { dir: 'DawnGraphiteCache', label: 'DawnGraphiteCache' },
    { dir: 'GraphiteDawnCache', label: 'GraphiteDawnCache' },
    { dir: 'DawnWebGPUCache', label: 'DawnWebGPUCache' },
    { dir: 'blob_storage', label: 'blob_storage' },
    { dir: 'local-video-thumbnails', label: '视频缩略图缓存' },
];

// 绝对禁止删除的 userData 用户数据条目（纵深防御）
const PROTECTED_USER_DATA_ENTRIES = new Set([
    'backend',
    'local storage',
    'indexeddb',
    'session storage',
    'webstorage',
    'preferences',
    'cookies',
    'cookies-journal',
    'local state',
    'partitions',
    'videokit-presets',
    'preset-folder-settings.json',
    'storage-backups',
    'videokit-templates',
    'ai-api.json',
    'ai-api-log.jsonl',
    'fonts-cache',
    'logs',
    'diagnostics',
    'batch-recovery',
    'drive-review',
    'resolve',
    'phone-cta-assets',
    CACHE_SETTINGS_FILENAME,
]);

// tmp 目录下绝对禁止清理的子项（如云端付费转录结果记录）
const PROTECTED_TMP_ENTRIES = new Set([
    'videokit_log',
]);

// tmp 目录下可安全清理的临时子目录（精确匹配）
const TRANSIENT_TMP_EXACT_DIRS = new Set([
    'smart_keyframes',
    'smart_kf_dl',
    'thumbnails',
    'url_thumbnails',
    'url_thumb_dl',
]);

// tmp 目录下可安全清理的临时任务文件/目录前缀（精确对应代码内生成的临时项）
const TRANSIENT_TMP_PREFIXES = [
    'gladia_',
    'transcription_',
    'reels_bg_',
    'reels_turbo_',
    'reels_wysiwyg_',
    'reels_sub_',
    'reels_compose_',
    'reels_rendered_audio_',
    'frame_raw_',
    'voice_decode_',
    'voice_rendered_',
    'audiofx_extracted_',
    'ir_reverb_',
    'parallel_chunk_',
    'parallel_concat_',
    'parallel_merged_',
    'gpu_probe_',
    'edge_',
    'gg_tts_in_',
    'gg_tts_out_',
    'speech-rename-',
    'speech-thumb-',
    'download_',
    'template_',
    'import_',
    'source_',
    'translate_',
    'source_upload_',
    'translate_upload_',
];

function formatBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function getPathSizeSafe(targetPath) {
    let size = 0;
    try {
        const stat = fs.lstatSync(targetPath);
        if (stat.isSymbolicLink()) return 0;
        if (!stat.isDirectory()) return stat.size || 0;
        const items = fs.readdirSync(targetPath, { withFileTypes: true });
        for (const item of items) {
            if (item.isSymbolicLink()) continue;
            const fullPath = path.join(targetPath, item.name);
            try {
                if (item.isDirectory()) {
                    size += getPathSizeSafe(fullPath);
                } else {
                    size += fs.lstatSync(fullPath).size || 0;
                }
            } catch (_) { /* skip unreadable entry */ }
        }
    } catch (_) { /* skip unreadable path */ }
    return size;
}

function getLatestMtimeMsSafe(targetPath) {
    let latest = 0;
    try {
        const stat = fs.lstatSync(targetPath);
        latest = Math.max(latest, stat.mtimeMs || 0);
        if (stat.isSymbolicLink() || !stat.isDirectory()) return latest;
        const items = fs.readdirSync(targetPath, { withFileTypes: true });
        for (const item of items) {
            if (item.isSymbolicLink()) continue;
            try {
                const st = fs.lstatSync(path.join(targetPath, item.name));
                latest = Math.max(latest, st.mtimeMs || 0);
            } catch (_) { /* ignore */ }
        }
    } catch (_) { /* ignore */ }
    return latest;
}

function isStrictlyInside(targetPath, rootPath) {
    if (!targetPath || !rootPath) return false;
    const resolvedRoot = path.resolve(rootPath);
    const resolvedTarget = path.resolve(targetPath);
    const rel = path.relative(resolvedRoot, resolvedTarget);
    if (!rel || rel === '.' || rel.startsWith(`..${path.sep}`) || rel === '..' || path.isAbsolute(rel)) {
        return false;
    }
    return true;
}

function isProtectedUserDataName(name) {
    return PROTECTED_USER_DATA_ENTRIES.has(String(name || '').toLowerCase());
}

function isProtectedTmpName(name) {
    return PROTECTED_TMP_ENTRIES.has(String(name || '').toLowerCase());
}

function isAllowlistedTransientTmpEntry(name) {
    const raw = String(name || '');
    const lower = raw.toLowerCase();
    if (!lower || isProtectedTmpName(lower)) return false;
    if (lower === OVERLAY_CACHE_DIR_NAME || lower === AUTOEDIT_CACHE_DIR_NAME) return false;
    if (TRANSIENT_TMP_EXACT_DIRS.has(lower)) return true;
    return TRANSIENT_TMP_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

function getCacheSettingsPath(userDataPath) {
    return path.join(userDataPath, CACHE_SETTINGS_FILENAME);
}

function readCacheSettings(userDataPath) {
    if (!userDataPath) return {};
    const cfgPath = getCacheSettingsPath(userDataPath);
    try {
        if (!fs.existsSync(cfgPath)) return {};
        const parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_) {
        return {};
    }
}

function getDefaultTmpDir(userDataPath) {
    return path.join(userDataPath, 'tmp');
}

function normalizeCustomTmpDir(selectedPath) {
    const resolved = path.resolve(String(selectedPath || '').trim());
    const base = path.basename(resolved).toLowerCase();
    if (base === CUSTOM_TMP_SUBDIR_NAME) return resolved;
    return path.join(resolved, CUSTOM_TMP_SUBDIR_NAME);
}

function validateCustomCacheTarget(userDataPath, selectedPath) {
    const raw = String(selectedPath || '').trim();
    if (!raw || raw.includes('\0')) {
        return { ok: false, error: '无效的目录路径' };
    }

    const resolvedSelected = resolveRealOrTargetPath(raw);
    if (isBlockedSensitivePath(resolvedSelected)) {
        return { ok: false, error: '安全策略拦截：不能将敏感系统或密钥目录设为缓存位置' };
    }

    const normLower = resolvedSelected.replace(/\\/g, '/').toLowerCase();
    if (normLower.includes('/app.asar/') || normLower.endsWith('/app.asar') || normLower.includes('.app/contents/')) {
        return { ok: false, error: '不能将应用程序包内部目录设为缓存位置' };
    }

    if (userDataPath) {
        const resolvedUserData = resolveRealOrTargetPath(userDataPath);
        if (resolvedSelected === resolvedUserData) {
            return { ok: false, error: '不能直接选择用户数据根目录，请选择独立文件夹或点击“恢复默认”' };
        }
        if (isStrictlyInside(resolvedSelected, resolvedUserData)) {
            const relFirst = path.relative(resolvedUserData, resolvedSelected).split(path.sep)[0];
            if (isProtectedUserDataName(relFirst)) {
                return { ok: false, error: `不能将受保护的用户数据目录 (${relFirst}) 设为缓存位置` };
            }
        }
    }

    const targetTmpDir = normalizeCustomTmpDir(resolvedSelected);
    if (isBlockedSensitivePath(targetTmpDir)) {
        return { ok: false, error: '目标缓存路径受安全策略保护' };
    }
    return { ok: true, targetTmpDir, selectedDir: resolvedSelected };
}

/**
 * 获取实际生效的临时缓存目录：
 * - videokit_log（云端转录记录）始终保留在 userData 默认临时目录内，避免外置盘断开导致记录丢失
 * - 其它临时/缓存目录优先使用用户自定义的 customTmpDir；若外置盘断开/不可写则自动安全回退到默认临时目录
 */
function getEffectiveTmpDir(userDataPath, subDir) {
    const defaultTmp = getDefaultTmpDir(userDataPath);
    if (subDir === 'videokit_log') {
        return path.join(defaultTmp, 'videokit_log');
    }

    const cfg = readCacheSettings(userDataPath);
    let baseDir = defaultTmp;
    if (cfg && typeof cfg.customTmpDir === 'string' && cfg.customTmpDir.trim()) {
        const candidate = path.resolve(cfg.customTmpDir.trim());
        try {
            fs.mkdirSync(candidate, { recursive: true });
            fs.accessSync(candidate, fs.constants.W_OK);
            baseDir = candidate;
        } catch (_) {
            // 外置磁盘未挂载或无权限时安全回退到默认 tmp，不崩溃
            baseDir = defaultTmp;
        }
    }
    return subDir ? path.join(baseDir, subDir) : baseDir;
}

function getManagedTmpRoots(userDataPath) {
    const roots = [];
    const seen = new Set();
    const addRoot = (dir) => {
        if (!dir) return;
        const resolved = path.resolve(dir);
        if (seen.has(resolved)) return;
        seen.add(resolved);
        roots.push(resolved);
    };
    addRoot(getEffectiveTmpDir(userDataPath));
    addRoot(getDefaultTmpDir(userDataPath));
    return roots;
}

function setCustomCachePath(userDataPath, newPath, { legacyConfigPath = null } = {}) {
    if (!userDataPath) {
        return { ok: false, error: '未获取到应用数据目录' };
    }
    const cfgPath = getCacheSettingsPath(userDataPath);
    const defaultTmpPath = getDefaultTmpDir(userDataPath);

    if (!newPath) {
        try {
            if (fs.existsSync(cfgPath)) fs.unlinkSync(cfgPath);
        } catch (e) {
            return { ok: false, error: '恢复默认失败: ' + e.message };
        }
        let hadLegacyConfig = false;
        if (legacyConfigPath && fs.existsSync(legacyConfigPath)) {
            hadLegacyConfig = true;
            try { fs.unlinkSync(legacyConfigPath); } catch (_) { /* best effort */ }
        }
        return {
            ok: true,
            isCustom: false,
            tmpPath: defaultTmpPath,
            userDataPath,
            needRestart: hadLegacyConfig,
        };
    }

    const validation = validateCustomCacheTarget(userDataPath, newPath);
    if (!validation.ok) return validation;

    const { targetTmpDir } = validation;
    try {
        fs.mkdirSync(targetTmpDir, { recursive: true });
        const probeFile = path.join(targetTmpDir, `.videokit_write_probe_${process.pid}_${Date.now()}`);
        fs.writeFileSync(probeFile, 'ok', 'utf-8');
        fs.unlinkSync(probeFile);
    } catch (e) {
        return { ok: false, error: '目标目录不可写入: ' + e.message };
    }

    try {
        fs.mkdirSync(userDataPath, { recursive: true });
        fs.writeFileSync(
            cfgPath,
            JSON.stringify({ customTmpDir: targetTmpDir, updatedAt: new Date().toISOString() }, null, 2),
            'utf-8'
        );
        return {
            ok: true,
            isCustom: true,
            tmpPath: targetTmpDir,
            userDataPath,
            needRestart: false,
        };
    } catch (e) {
        return { ok: false, error: '保存缓存位置配置失败: ' + e.message };
    }
}

function collectStaleTransientEntries(tmpRoot, { now = Date.now(), staleTmpMinAgeMs = DEFAULT_STALE_TMP_MIN_AGE_MS } = {}) {
    const entries = [];
    if (!tmpRoot || !fs.existsSync(tmpRoot)) return entries;
    let dirEntries = [];
    try {
        dirEntries = fs.readdirSync(tmpRoot, { withFileTypes: true });
    } catch (_) {
        return entries;
    }

    for (const dirent of dirEntries) {
        if (dirent.isSymbolicLink()) continue;
        if (!isAllowlistedTransientTmpEntry(dirent.name)) continue;
        const fullPath = path.join(tmpRoot, dirent.name);
        if (!isStrictlyInside(fullPath, tmpRoot)) continue;

        const latestMtime = getLatestMtimeMsSafe(fullPath);
        if (staleTmpMinAgeMs > 0 && latestMtime > 0 && (now - latestMtime) < staleTmpMinAgeMs) {
            continue;
        }
        const size = getPathSizeSafe(fullPath);
        entries.push({ name: dirent.name, fullPath, root: tmpRoot, size });
    }
    return entries;
}

function removePathSafely(targetPath, allowedRoot) {
    if (!targetPath || !fs.existsSync(targetPath)) {
        return { beforeSize: 0, afterSize: 0, freedSize: 0, partial: false };
    }
    if (!isStrictlyInside(targetPath, allowedRoot)) {
        throw new Error(`安全校验拒绝删除越界路径: ${targetPath}`);
    }
    const stat = fs.lstatSync(targetPath);
    if (stat.isSymbolicLink()) {
        return { beforeSize: 0, afterSize: 0, freedSize: 0, partial: false };
    }

    const beforeSize = getPathSizeSafe(targetPath);
    let partial = false;

    try {
        fs.rmSync(targetPath, { recursive: true, force: true });
    } catch (_) {
        partial = true;
    }

    // 如果整个目录因运行中句柄锁定无法整体删除，则逐项清理内部已释放的子文件/子目录
    if (fs.existsSync(targetPath) && stat.isDirectory()) {
        partial = true;
        try {
            const children = fs.readdirSync(targetPath, { withFileTypes: true });
            for (const child of children) {
                if (child.isSymbolicLink()) continue;
                const childPath = path.join(targetPath, child.name);
                if (!isStrictlyInside(childPath, targetPath)) continue;
                try {
                    fs.rmSync(childPath, { recursive: true, force: true });
                } catch (_) {
                    // 仍被 Chromium 占用的句柄跳过，不中断其余清理
                }
            }
        } catch (_) { /* ignore */ }
    }

    const afterSize = fs.existsSync(targetPath) ? getPathSizeSafe(targetPath) : 0;
    const freedSize = Math.max(0, beforeSize - afterSize);
    return { beforeSize, afterSize, freedSize, partial: afterSize > 0 || partial };
}

function getCacheInfo(userDataPath, { now = Date.now(), staleTmpMinAgeMs = DEFAULT_STALE_TMP_MIN_AGE_MS } = {}) {
    const cfg = readCacheSettings(userDataPath);
    const defaultTmpPath = getDefaultTmpDir(userDataPath);
    const effectiveTmpPath = getEffectiveTmpDir(userDataPath);
    const isCustomPath = Boolean(cfg.customTmpDir) && path.resolve(effectiveTmpPath) !== path.resolve(defaultTmpPath);
    const configuredCustomPath = typeof cfg.customTmpDir === 'string' && cfg.customTmpDir.trim()
        ? path.resolve(cfg.customTmpDir.trim())
        : null;
    const customPathUnavailable = Boolean(configuredCustomPath) && !isCustomPath;

    let totalSize = 0;
    let optionalSize = 0;
    const details = [];
    const optionalDetails = [];

    // 1. Electron 运行时缓存 & 视频缩略图缓存
    for (const item of RUNTIME_CACHE_DIRS) {
        if (isProtectedUserDataName(item.dir)) continue;
        const dirPath = path.join(userDataPath, item.dir);
        if (!fs.existsSync(dirPath)) continue;
        try {
            if (fs.lstatSync(dirPath).isSymbolicLink()) continue;
        } catch (_) { continue; }
        const size = getPathSizeSafe(dirPath);
        totalSize += size;
        details.push({
            id: `runtime:${item.dir}`,
            name: item.label,
            size,
            human: formatBytes(size),
            optional: false,
        });
    }

    // 2. GIF/视频覆层帧缓存（汇总当前生效 tmp 与默认 tmp）
    const tmpRoots = getManagedTmpRoots(userDataPath);
    let overlaySize = 0;
    let overlayExists = false;
    for (const root of tmpRoots) {
        const overlayPath = path.join(root, OVERLAY_CACHE_DIR_NAME);
        if (fs.existsSync(overlayPath)) {
            overlayExists = true;
            overlaySize += getPathSizeSafe(overlayPath);
        }
    }
    if (overlayExists || overlaySize > 0) {
        totalSize += overlaySize;
        details.push({
            id: 'overlay',
            name: 'GIF/视频覆层帧缓存',
            size: overlaySize,
            human: formatBytes(overlaySize),
            optional: false,
        });
    }

    // 3. 过期临时任务残留（gladia/deepgram/reels_bg/turbo/download 等超过 10 分钟的孤立临时项）
    let transientSize = 0;
    let transientCount = 0;
    for (const root of tmpRoots) {
        const staleEntries = collectStaleTransientEntries(root, { now, staleTmpMinAgeMs });
        transientCount += staleEntries.length;
        for (const entry of staleEntries) {
            transientSize += entry.size;
        }
    }
    if (transientCount > 0 || transientSize > 0) {
        totalSize += transientSize;
        details.push({
            id: 'transient_tmp',
            name: `临时任务残留 (${transientCount} 项)`,
            size: transientSize,
            human: formatBytes(transientSize),
            count: transientCount,
            optional: false,
        });
    }

    // 4. 可选深度清理项：自动剪辑/识别中间缓存（默认不自动勾选，由用户决定是否释放）
    let autoEditSize = 0;
    let autoEditExists = false;
    for (const root of tmpRoots) {
        const autoEditPath = path.join(root, AUTOEDIT_CACHE_DIR_NAME);
        if (fs.existsSync(autoEditPath)) {
            autoEditExists = true;
            autoEditSize += getPathSizeSafe(autoEditPath);
        }
    }
    if (autoEditExists || autoEditSize > 0) {
        optionalSize += autoEditSize;
        optionalDetails.push({
            id: 'autoedit_cache',
            name: '自动剪辑/识别缓存',
            size: autoEditSize,
            human: formatBytes(autoEditSize),
            optional: true,
        });
    }

    return {
        path: effectiveTmpPath,
        userDataPath,
        defaultTmpPath,
        isCustomPath,
        customPathUnavailable,
        configuredCustomPath,
        totalSize,
        totalHuman: formatBytes(totalSize),
        optionalSize,
        optionalHuman: formatBytes(optionalSize),
        grandTotalSize: totalSize + optionalSize,
        grandTotalHuman: formatBytes(totalSize + optionalSize),
        details,
        optionalDetails,
    };
}

async function clearCache(userDataPath, options = {}) {
    const {
        includeAutoEditCache = false,
        includeOverlayCache = true,
        now = Date.now(),
        staleTmpMinAgeMs = DEFAULT_STALE_TMP_MIN_AGE_MS,
        beforeRemoveRuntimeCaches = null,
        log = () => {},
    } = options || {};

    if (typeof beforeRemoveRuntimeCaches === 'function') {
        try {
            await beforeRemoveRuntimeCaches();
        } catch (e) {
            log(`[Cache] beforeRemoveRuntimeCaches warning: ${e.message}`);
        }
    }

    let freedSize = 0;
    let remainingLockedSize = 0;
    const cleared = [];
    const warnings = [];

    // 1. 清理 Electron 运行时缓存 & 视频缩略图缓存
    for (const item of RUNTIME_CACHE_DIRS) {
        if (isProtectedUserDataName(item.dir)) continue;
        const dirPath = path.join(userDataPath, item.dir);
        if (!fs.existsSync(dirPath)) continue;
        try {
            const res = removePathSafely(dirPath, userDataPath);
            freedSize += res.freedSize;
            remainingLockedSize += res.afterSize;
            if (res.freedSize > 0 || res.beforeSize === 0) {
                cleared.push(item.label);
                log(`[Cache] Cleared ${item.label}: freed ${formatBytes(res.freedSize)}, remaining ${formatBytes(res.afterSize)}`);
            }
            if (res.afterSize > 0) {
                warnings.push(`${item.label} 仍有 ${formatBytes(res.afterSize)} 正被运行中的进程占用`);
            }
        } catch (e) {
            warnings.push(`${item.label} 清理失败: ${e.message}`);
            log(`[Cache] Failed to clear ${dirPath}: ${e.message}`);
        }
    }

    const tmpRoots = getManagedTmpRoots(userDataPath);

    // 2. 清理 GIF/视频覆层帧缓存
    if (includeOverlayCache) {
        let overlayFreed = 0;
        let overlayHadTarget = false;
        for (const root of tmpRoots) {
            const overlayPath = path.join(root, OVERLAY_CACHE_DIR_NAME);
            if (!fs.existsSync(overlayPath)) continue;
            overlayHadTarget = true;
            try {
                const res = removePathSafely(overlayPath, root);
                overlayFreed += res.freedSize;
                freedSize += res.freedSize;
                remainingLockedSize += res.afterSize;
                log(`[Cache] Cleared overlay cache (${overlayPath}): freed ${formatBytes(res.freedSize)}`);
            } catch (e) {
                warnings.push(`GIF/视频覆层帧缓存清理失败: ${e.message}`);
                log(`[Cache] Failed to clear ${overlayPath}: ${e.message}`);
            }
        }
        if (overlayHadTarget) {
            cleared.push('GIF/视频覆层帧缓存');
        }
    }

    // 3. 清理过期临时任务残留
    let transientFreed = 0;
    let transientRemovedCount = 0;
    for (const root of tmpRoots) {
        const staleEntries = collectStaleTransientEntries(root, { now, staleTmpMinAgeMs });
        for (const entry of staleEntries) {
            if (isProtectedTmpName(entry.name)) continue;
            try {
                const res = removePathSafely(entry.fullPath, root);
                transientFreed += res.freedSize;
                freedSize += res.freedSize;
                remainingLockedSize += res.afterSize;
                if (!fs.existsSync(entry.fullPath) || res.freedSize > 0) {
                    transientRemovedCount += 1;
                }
            } catch (e) {
                log(`[Cache] Failed to clear transient entry ${entry.fullPath}: ${e.message}`);
            }
        }
    }
    if (transientRemovedCount > 0) {
        cleared.push(`临时任务残留 (${transientRemovedCount} 项)`);
        log(`[Cache] Cleared ${transientRemovedCount} stale transient tmp entries: freed ${formatBytes(transientFreed)}`);
    }

    // 4. 可选：清理自动剪辑/识别缓存
    if (includeAutoEditCache) {
        let autoEditHadTarget = false;
        for (const root of tmpRoots) {
            const autoEditPath = path.join(root, AUTOEDIT_CACHE_DIR_NAME);
            if (!fs.existsSync(autoEditPath)) continue;
            autoEditHadTarget = true;
            try {
                const res = removePathSafely(autoEditPath, root);
                freedSize += res.freedSize;
                remainingLockedSize += res.afterSize;
                log(`[Cache] Cleared autoedit cache (${autoEditPath}): freed ${formatBytes(res.freedSize)}`);
            } catch (e) {
                warnings.push(`自动剪辑/识别缓存清理失败: ${e.message}`);
                log(`[Cache] Failed to clear ${autoEditPath}: ${e.message}`);
            }
        }
        if (autoEditHadTarget) {
            cleared.push('自动剪辑/识别缓存');
        }
    }

    return {
        ok: true,
        freedSize,
        freedHuman: formatBytes(freedSize),
        remainingLockedSize,
        remainingLockedHuman: formatBytes(remainingLockedSize),
        cleared,
        warnings,
    };
}

module.exports = {
    CACHE_SETTINGS_FILENAME,
    CUSTOM_TMP_SUBDIR_NAME,
    OVERLAY_CACHE_DIR_NAME,
    AUTOEDIT_CACHE_DIR_NAME,
    DEFAULT_STALE_TMP_MIN_AGE_MS,
    RUNTIME_CACHE_DIRS,
    PROTECTED_USER_DATA_ENTRIES,
    PROTECTED_TMP_ENTRIES,
    formatBytes,
    getPathSizeSafe,
    isProtectedUserDataName,
    isProtectedTmpName,
    isAllowlistedTransientTmpEntry,
    readCacheSettings,
    getDefaultTmpDir,
    getEffectiveTmpDir,
    getManagedTmpRoots,
    validateCustomCacheTarget,
    setCustomCachePath,
    getCacheInfo,
    clearCache,
};
