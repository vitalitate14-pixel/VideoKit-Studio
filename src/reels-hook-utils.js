/**
 * reels-hook-utils.js — 批量 Reels 前置钩子（画面 + 配音）统一规则工具
 *
 * 同时兼容浏览器（window.ReelsHookUtils）和 Node（electron/services/ffmpeg.js 与单元测试），
 * 确保批量表格、预览器、导出预检和 FFmpeg 拼接严格遵循同一套时长、声音与格式规范。
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.ReelsHookUtils = factory();
    }
})(typeof window === 'object' ? window : globalThis, function () {
    const DEFAULT_HOOK_FIRST_SECONDS = 3;
    const HOOK_VIDEO_EXTS = new Set(['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v']);
    const HOOK_AUDIO_ONLY_EXTS = new Set(['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'wma', 'opus']);
    const HOOK_AUDIO_EXTS = new Set([...HOOK_AUDIO_ONLY_EXTS, ...HOOK_VIDEO_EXTS]);

    function _clamp(value, min, max) {
        const n = Number(value);
        if (!Number.isFinite(n)) return min;
        return Math.min(max, Math.max(min, n));
    }

    function _getExt(filePath) {
        const raw = String(filePath || '').trim().split(/[?#]/)[0];
        const base = raw.split(/[\\/]/).pop() || '';
        const idx = base.lastIndexOf('.');
        return idx >= 0 ? base.slice(idx + 1).toLowerCase() : '';
    }

    function _parseOptionalNonNegNumber(value) {
        if (value === null || value === undefined || value === '') return null;
        const n = Number(value);
        if (!Number.isFinite(n) || n < 0) return null;
        return n;
    }

    function isSupportedHookVideoPath(filePath) {
        const ext = _getExt(filePath);
        return !!ext && HOOK_VIDEO_EXTS.has(ext);
    }

    function isSupportedHookAudioPath(filePath) {
        const ext = _getExt(filePath);
        return !!ext && HOOK_AUDIO_EXTS.has(ext);
    }

    function isHookExplicitlyDisabled(task) {
        return !!(task && task.hookFile === '__NONE__');
    }

    function getOwnHookVideoPath(task) {
        if (!task || task.hookFile === '__NONE__') return '';
        if (task.hookFile && typeof task.hookFile === 'string') return task.hookFile.trim();
        if (task.hook && task.hook.enabled !== false && task.hook.path && typeof task.hook.path === 'string') {
            return task.hook.path.trim();
        }
        return '';
    }

    function resolveHookVideoPath(task, globalIntroPath = '') {
        if (!task) return String(globalIntroPath || '').trim();
        if (task.hookFile === '__NONE__') return '';
        const own = getOwnHookVideoPath(task);
        if (own) return own;
        return String(globalIntroPath || '').trim();
    }

    function isHookUsingGlobal(task, globalIntroPath = '') {
        if (!task || isHookExplicitlyDisabled(task)) return false;
        if (getOwnHookVideoPath(task)) return false;
        return !!String(globalIntroPath || '').trim();
    }

    function resolveHookAudioPath(task) {
        if (!task || !task.hookAudioFile || typeof task.hookAudioFile !== 'string') return '';
        return task.hookAudioFile.trim();
    }

    function inferHookDurationMode(task) {
        const explicit = task && task.hookDurationMode;
        if (explicit === 'first3' || explicit === 'full' || explicit === 'custom') return explicit;
        const hasStart = _parseOptionalNonNegNumber(task && task.hookTrimStart) != null && Number(task.hookTrimStart) > 0;
        const hasEnd = _parseOptionalNonNegNumber(task && task.hookTrimEnd) != null && Number(task.hookTrimEnd) > 0;
        if (hasStart || hasEnd) return 'custom';
        return 'full';
    }

    function applyDefaultHookVideo(task, filePath, options = {}) {
        if (!task) return task;
        const cleanPath = String(filePath || '').trim();
        const resetTrim = options.resetTrim !== false;
        task.hookFile = cleanPath;
        if (!task.hook || typeof task.hook !== 'object') task.hook = {};
        task.hook.enabled = !!cleanPath;
        task.hook.path = cleanPath;
        if (resetTrim) {
            task.hookDurationMode = options.durationMode || 'first3';
            if (task.hookDurationMode === 'first3') {
                task.hookTrimStart = 0;
                task.hookTrimEnd = DEFAULT_HOOK_FIRST_SECONDS;
            } else if (task.hookDurationMode === 'full') {
                task.hookTrimStart = null;
                task.hookTrimEnd = null;
            }
        }
        if (task.hookSpeed == null || !Number.isFinite(Number(task.hookSpeed)) || Number(task.hookSpeed) <= 0) {
            task.hookSpeed = 1;
        }
        if (task.hookTransition == null) task.hookTransition = 'none';
        if (task.hookTransDuration == null || !Number.isFinite(Number(task.hookTransDuration))) {
            task.hookTransDuration = 0.5;
        }
        if (task.hookKeepAudio === undefined) task.hookKeepAudio = true;
        if (task.hookVolume == null || !Number.isFinite(Number(task.hookVolume))) {
            task.hookVolume = 100;
        }
        return task;
    }

    function clearHookVideo(task, options = {}) {
        if (!task) return task;
        const disableGlobal = !!options.disableGlobal;
        task.hookFile = disableGlobal ? '__NONE__' : '';
        if (!task.hook || typeof task.hook !== 'object') task.hook = {};
        task.hook.enabled = false;
        task.hook.path = '';
        task.hookDurationMode = 'first3';
        task.hookTrimStart = null;
        task.hookTrimEnd = null;
        task.hookSpeed = 1;
        task.hookTransition = 'none';
        task.hookTransDuration = 0.5;
        task.hookKeepAudio = true;
        task.hookVolume = 100;
        return task;
    }

    function applyHookAudio(task, filePath, options = {}) {
        if (!task) return task;
        const cleanPath = String(filePath || '').trim();
        const resetTrim = options.resetTrim !== false;
        task.hookAudioFile = cleanPath;
        if (resetTrim) {
            task.hookAudioTrimStart = cleanPath ? 0 : null;
            task.hookAudioTrimEnd = null;
        }
        if (task.hookAudioVolume == null || !Number.isFinite(Number(task.hookAudioVolume))) {
            task.hookAudioVolume = 100;
        }
        return task;
    }

    function clearHookAudio(task) {
        if (!task) return task;
        task.hookAudioFile = '';
        task.hookAudioTrimStart = null;
        task.hookAudioTrimEnd = null;
        task.hookAudioVolume = 100;
        return task;
    }

    function computeHookVideoTiming(task, rawDuration) {
        const raw = Number(rawDuration);
        const mode = inferHookDurationMode(task);
        const speed = _clamp(task && task.hookSpeed != null ? task.hookSpeed : 1, 0.1, 10);
        if (!Number.isFinite(raw) || raw <= 0) {
            return {
                valid: false,
                mode,
                trimStart: 0,
                trimEnd: 0,
                speed,
                outputDuration: 0,
                rawDuration: 0,
                error: '无法读取钩子视频时长',
            };
        }

        let trimStart = 0;
        let trimEnd = raw;

        if (mode === 'full') {
            trimStart = 0;
            trimEnd = raw;
        } else if (mode === 'first3') {
            const parsedStart = _parseOptionalNonNegNumber(task && task.hookTrimStart);
            trimStart = parsedStart != null && parsedStart < raw ? parsedStart : 0;
            trimEnd = Math.min(raw, trimStart + DEFAULT_HOOK_FIRST_SECONDS);
        } else {
            const parsedStart = _parseOptionalNonNegNumber(task && task.hookTrimStart);
            const parsedEnd = _parseOptionalNonNegNumber(task && task.hookTrimEnd);
            trimStart = parsedStart != null ? parsedStart : 0;
            if (trimStart >= raw) {
                return {
                    valid: false,
                    mode,
                    trimStart,
                    trimEnd: raw,
                    speed,
                    outputDuration: 0,
                    rawDuration: raw,
                    error: `钩子画面起点 (${trimStart.toFixed(2)}s) 超过视频总时长 (${raw.toFixed(2)}s)`,
                };
            }
            if (parsedEnd != null && parsedEnd > 0) {
                if (parsedEnd <= trimStart) {
                    return {
                        valid: false,
                        mode,
                        trimStart,
                        trimEnd: parsedEnd,
                        speed,
                        outputDuration: 0,
                        rawDuration: raw,
                        error: `钩子画面终点 (${parsedEnd.toFixed(2)}s) 必须大于起点 (${trimStart.toFixed(2)}s)`,
                    };
                }
                trimEnd = Math.min(raw, parsedEnd);
            } else {
                trimEnd = raw;
            }
        }

        const sourceSpan = Math.max(0, trimEnd - trimStart);
        const outputDuration = sourceSpan / speed;
        return {
            valid: outputDuration > 0.01,
            mode,
            trimStart,
            trimEnd,
            speed,
            outputDuration,
            rawDuration: raw,
            error: outputDuration > 0.01 ? '' : '钩子有效时长过短',
        };
    }

    function computeHookAudioPlan(task, hookOutputDuration, rawAudioDuration = null) {
        const targetDuration = Math.max(0, Number(hookOutputDuration) || 0);
        const audioPath = resolveHookAudioPath(task);

        if (audioPath) {
            const volumePct = _clamp(task && task.hookAudioVolume != null ? task.hookAudioVolume : 100, 0, 200);
            const volume = volumePct / 100;
            const trimStart = _parseOptionalNonNegNumber(task && task.hookAudioTrimStart) || 0;
            const customEnd = _parseOptionalNonNegNumber(task && task.hookAudioTrimEnd);
            let maxSpan = targetDuration;
            if (customEnd != null && customEnd > trimStart) {
                maxSpan = Math.min(maxSpan, customEnd - trimStart);
            }
            const rawAudio = Number(rawAudioDuration);
            if (Number.isFinite(rawAudio) && rawAudio > 0) {
                maxSpan = Math.min(maxSpan, Math.max(0, rawAudio - trimStart));
            }
            const audioSpan = Math.max(0, maxSpan);
            return {
                mode: volume <= 0 ? 'mute' : 'custom_audio',
                audioPath,
                trimStart,
                trimEnd: trimStart + audioSpan,
                audioSpan,
                targetDuration,
                volume,
                volumePct,
            };
        }

        const keepAudio = !(task && task.hookKeepAudio === false);
        const volumePct = _clamp(task && task.hookVolume != null ? task.hookVolume : 100, 0, 200);
        const volume = keepAudio ? (volumePct / 100) : 0;

        if (!keepAudio || volume <= 0) {
            return {
                mode: 'mute',
                audioPath: '',
                trimStart: 0,
                trimEnd: 0,
                audioSpan: 0,
                targetDuration,
                volume: 0,
                volumePct: 0,
            };
        }

        return {
            mode: 'original',
            audioPath: '',
            trimStart: 0,
            trimEnd: targetDuration,
            audioSpan: targetDuration,
            targetDuration,
            volume,
            volumePct,
        };
    }

    function buildAtempoFilterChain(speed) {
        let ratio = _clamp(speed, 0.1, 10);
        if (Math.abs(ratio - 1) < 0.0005) return '';
        const parts = [];
        while (ratio > 2.0 + 1e-6) {
            parts.push('atempo=2.0');
            ratio /= 2.0;
        }
        while (ratio < 0.5 - 1e-6) {
            parts.push('atempo=0.5');
            ratio /= 0.5;
        }
        if (Math.abs(ratio - 1.0) >= 0.0005) {
            parts.push(`atempo=${ratio.toFixed(4)}`);
        }
        return parts.join(',');
    }

    function formatHookDurationBadge(task) {
        const mode = inferHookDurationMode(task);
        if (mode === 'first3') {
            const start = _parseOptionalNonNegNumber(task && task.hookTrimStart) || 0;
            return start > 0 ? `${start.toFixed(1)}s+3s` : '前3s';
        }
        if (mode === 'full') return '全程';
        const s = _parseOptionalNonNegNumber(task && task.hookTrimStart) || 0;
        const e = _parseOptionalNonNegNumber(task && task.hookTrimEnd);
        return e != null && e > 0 ? `${s.toFixed(1)}-${e.toFixed(1)}s` : `${s.toFixed(1)}s起`;
    }

    function validateTaskHookConfig(task, globalIntroPath = '') {
        const errors = [];
        const videoPath = resolveHookVideoPath(task, globalIntroPath);
        const audioPath = resolveHookAudioPath(task);

        if (videoPath) {
            if (!isSupportedHookVideoPath(videoPath)) {
                errors.push(`前置钩子仅支持视频文件（当前不支持：${videoPath.split(/[\\/]/).pop()}）`);
            }
            const mode = inferHookDurationMode(task);
            if (mode === 'custom') {
                const start = _parseOptionalNonNegNumber(task && task.hookTrimStart) || 0;
                const end = _parseOptionalNonNegNumber(task && task.hookTrimEnd);
                if (end != null && end > 0 && end <= start) {
                    errors.push(`钩子画面裁剪终点 (${end}s) 必须大于起点 (${start}s)`);
                }
            }
            const speed = Number(task && task.hookSpeed != null ? task.hookSpeed : 1);
            if (!Number.isFinite(speed) || speed < 0.1 || speed > 10) {
                errors.push(`钩子倍速需在 0.1 ~ 10 之间（当前：${task && task.hookSpeed}）`);
            }
        }

        if (audioPath) {
            if (!isSupportedHookAudioPath(audioPath)) {
                errors.push(`钩子配音仅支持音频或视频文件（当前不支持：${audioPath.split(/[\\/]/).pop()}）`);
            }
            const aStart = _parseOptionalNonNegNumber(task && task.hookAudioTrimStart) || 0;
            const aEnd = _parseOptionalNonNegNumber(task && task.hookAudioTrimEnd);
            if (aEnd != null && aEnd > 0 && aEnd <= aStart) {
                errors.push(`钩子配音裁剪终点 (${aEnd}s) 必须大于起点 (${aStart}s)`);
            }
        }

        return { valid: errors.length === 0, errors, videoPath, audioPath };
    }

    return {
        DEFAULT_HOOK_FIRST_SECONDS,
        HOOK_VIDEO_EXTS,
        HOOK_AUDIO_EXTS,
        HOOK_AUDIO_ONLY_EXTS,
        isSupportedHookVideoPath,
        isSupportedHookAudioPath,
        isHookExplicitlyDisabled,
        getOwnHookVideoPath,
        resolveHookVideoPath,
        isHookUsingGlobal,
        resolveHookAudioPath,
        inferHookDurationMode,
        applyDefaultHookVideo,
        clearHookVideo,
        applyHookAudio,
        clearHookAudio,
        computeHookVideoTiming,
        computeHookAudioPlan,
        buildAtempoFilterChain,
        formatHookDurationBadge,
        validateTaskHookConfig,
    };
});
