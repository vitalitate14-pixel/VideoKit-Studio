// Without background/voice, infer one pass from active visual overlays.
// The 9999 end sentinel means full duration, not a 2-hour movie.
async function reelsResolveOverlayOnlyDuration(overlays, probeDuration) {
    let duration = 0;
    for (const ov of overlays || []) {
        if (!ov || ov.disabled || ov.type === 'audio') continue;
        const start = Math.max(0, Number(ov.start) || 0);
        const end = Number(ov.end);
        if (Number.isFinite(end) && end > start && end < 9999) {
            duration = Math.max(duration, end);
            continue;
        }
        if (ov.type === 'video') {
            const source = ov.media_folder_files?.[0] || ov.content;
            if (!source) continue;
            const raw = ov.is_img_sequence && ov.sequence_frames?.length
                ? ov.sequence_frames.length / (Number(ov.fps) || 30)
                : await probeDuration('覆层视频', source);
            const offset = Math.max(0, Number(ov.video_start_offset) || 0);
            const sourceEnd = Number(ov.video_end_offset);
            const effectiveEnd = Number.isFinite(sourceEnd) && sourceEnd > offset ? Math.min(raw, sourceEnd) : raw;
            duration = Math.max(duration, start + Math.max(0.1, effectiveEnd - offset));
        }
    }
    return duration || 5;
}

/**
 * reels-wysiwyg-export.js — WYSIWYG 混合导出引擎
 *
 * 混合架构：
 *   1. FFmpeg 处理背景视频（循环+淡入淡出+缩放+音频混合）→ 临时背景视频
 *   2. FFmpeg 提取背景帧序列 → JPEG 文件
 *   3. Canvas 逐帧渲染：背景帧 + 全局蒙版 + 字幕（与预览完全相同的 renderer）
 *   4. 合成帧 → JPEG pipe → FFmpeg 编码 → 临时纯视频
 *   5. Web Audio OfflineAudioContext 离线渲染音频（含混响+立体声）→ WAV
 *   6. FFmpeg 简单合并视频 + 预渲染音频 → 最终输出
 *
 * 音频效果完全使用 Web Audio API 渲染，确保导出与预览 100% 一致。
 */

/**
 * Canvas → Raw RGBA Uint8Array（零压缩，专业级画质）
 * 精准模式复制一个独立副本；流水线模式直接转移 ArrayBuffer，避免额外复制。
 */
function _canvasToRawRGBA(canvas, transferable = false) {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return transferable ? imageData.data.buffer : imageData.data.buffer.slice(0);
}

function _createFramePipeline(sessionId, batchSize = 3) {
    let frames = [];
    const flush = async () => {
        if (!frames.length) return;
        const batch = frames;
        frames = [];
        const result = await window.electronAPI.reelsComposeWysiwyg('frames', { sessionId, frames: batch });
        const ok = result === true || (result && result.ok);
        if (!ok) throw new Error((result && result.error) || '批量写入视频帧失败');
    };
    return {
        async send(raw) {
            frames.push(raw);
            if (frames.length >= batchSize) await flush();
        },
        async drain() {
            await flush();
        },
    };
}

/**
 * 加载图片为 Image 对象 (返回 Promise)
 */
function _loadImage(src) {
    return new Promise((resolve, reject) => {
        let normSrc = src;
        const isRemoteOrBrowserUrl = /^(local-media:|https?:|blob:|data:)/i.test(String(normSrc || ''));
        if (normSrc && typeof normSrc === 'string' && !isRemoteOrBrowserUrl
            && window.electronAPI && typeof window.electronAPI.toFileUrl === 'function') {
            normSrc = window.electronAPI.toFileUrl(normSrc);
        }
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error(`图片加载失败: ${normSrc}`));
        if (/^local-media:/i.test(normSrc)) img.crossOrigin = 'anonymous';
        img.src = normSrc;
    });
}

function _normalizeOverlayLocalPath(filePath) {
    if (!filePath || typeof filePath !== 'string') return '';
    let s = filePath;
    if (/^local-media:\/\//i.test(s)) {
        s = s.replace(/^local-media:\/\//i, '');
    } else if (/^file:\/\//i.test(s)) {
        try {
            const u = new URL(s);
            s = u.pathname || s.replace(/^file:\/\//i, '');
        } catch (_) {
            s = s.replace(/^file:\/\//i, '');
        }
    }
    try { s = decodeURIComponent(s); } catch (_) { }
    if (/^\/[A-Za-z]:[\\/]/.test(s)) s = s.slice(1);
    return s;
}

function _overlayPathBaseName(filePath) {
    const s = _normalizeOverlayLocalPath(filePath || '');
    return (s.replace(/\\/g, '/').split('/').pop() || '').trim();
}

function _overlayPathDirName(filePath) {
    const s = _normalizeOverlayLocalPath(filePath || '').replace(/\\/g, '/');
    const idx = s.lastIndexOf('/');
    return idx > 0 ? s.slice(0, idx) : '';
}

async function _overlayLocalPathExists(filePath) {
    const p = _normalizeOverlayLocalPath(filePath);
    if (!p || /^blob:/i.test(p)) return false;
    if (window.electronAPI && typeof window.electronAPI.checkFilesExist === 'function') {
        try {
            const map = await window.electronAPI.checkFilesExist([p]);
            return !!map[p];
        } catch (_) { }
    }
    return false;
}

function _collectOverlaySearchDirs(taskOverlays) {
    const dirs = [];
    const add = (dir) => {
        if (!dir || typeof dir !== 'string') return;
        const d = _normalizeOverlayLocalPath(dir).replace(/[\\/]+$/, '');
        if (d && !/^blob:/i.test(d) && !dirs.includes(d)) dirs.push(d);
    };

    try { add(localStorage.getItem('videokit_overlay_lib_path') || ''); } catch (_) { }

    try {
        const tabs = (typeof _batchTableState !== 'undefined' && _batchTableState?.tabs) ? _batchTableState.tabs : [];
        for (const tab of tabs) add(tab?.materialDir || '');
    } catch (_) { }

    try {
        const activeTab = (typeof _getActiveTab === 'function') ? _getActiveTab() : null;
        add(activeTab?.materialDir || '');
    } catch (_) { }

    const tasks = window._reelsState?.tasks || [];
    for (const task of tasks) {
        add(_overlayPathDirName(task?.bgPath || task?.videoPath || ''));
        add(_overlayPathDirName(task?.audioPath || ''));
        add(_overlayPathDirName(task?.bgmPath || ''));
        add(_overlayPathDirName(task?.contentVideoPath || ''));
        for (const ov of (task?.overlays || [])) add(_overlayPathDirName(ov?.content || ''));
    }

    for (const ov of (taskOverlays || [])) add(_overlayPathDirName(ov?.content || ''));
    return dirs;
}

function _cloneOverlaysForWysiwygExport(overlays) {
    if (!Array.isArray(overlays)) return overlays;
    const runtimeKeys = new Set([
        '_allOverlays',
        '_cachedUrl',
        '_currentFrameImage',
        '_exportImage',
        '_dirty',
        '_exportDuration',
        '_exporting',
        '_fcpxml_generating',
        '_flipper_drawing',
        '_frameCount',
        '_framesDir',
        '_imageEl',
        '_img',
        '_imgLoaded',
        '_original_body_text',
        '_original_footer_text',
        '_original_title_text',
        '_previewAtEnd',
        '_renderedH',
        '_renderedW',
        '_renderedX',
        '_renderedY',
        '_scrollBodyCurX',
        '_scrollBodyFirstLineY',
        '_scrollBodyLineHeight',
        '_selected',
        '_sideBySideCacheOwner',
        '_videoEl',
    ]);
    try {
        const cloned = JSON.parse(JSON.stringify(overlays, (key, value) => {
            if (runtimeKeys.has(key)) return undefined;
            if (key && key.startsWith('_') && key !== '_templateName') return undefined;
            if (typeof Element !== 'undefined' && value instanceof Element) return undefined;
            if (typeof HTMLCanvasElement !== 'undefined' && value instanceof HTMLCanvasElement) return undefined;
            if (typeof HTMLImageElement !== 'undefined' && value instanceof HTMLImageElement) return undefined;
            if (typeof HTMLVideoElement !== 'undefined' && value instanceof HTMLVideoElement) return undefined;
            return value;
        }));
        if(typeof window !== 'undefined')window.ReelsLayerSlots?.syncPhoneMedia?.({overlays:cloned});
        return cloned;
    } catch (e) {
        console.warn('[WYSIWYG] clone overlays failed, falling back to shallow copies:', e);
        return overlays.map(ov => ov && typeof ov === 'object' ? { ...ov } : ov);
    }
}

async function _resolveMissingOverlayPath(ov, taskOverlays, log) {
    const opath = _normalizeOverlayLocalPath(ov?.content || '');
    if (await _overlayLocalPathExists(opath)) return opath;
    // 导出时禁止在其他任务/素材目录中按文件名猜测。不同任务很容易都有
    // overlay.mp4、logo.png 等同名文件，旧逻辑取第一个搜索结果会生成内容
    // 完整但绑定错误的成片。素材丢失应明确失败，由用户重新关联。
    if (log) log(`覆层素材路径无效，停止自动同名搜索: ${ov?.name || ov?.content || '(空)'}`);
    return opath;
}

/**
 * AudioBuffer → WAV (PCM 16-bit) ArrayBuffer
 */
function _audioBufferToWav(buffer, maxSamples) {
    const numChannels = buffer.numberOfChannels;
    const sampleRate = buffer.sampleRate;
    const bitsPerSample = 16;
    const bytesPerSample = bitsPerSample / 8;
    const blockAlign = numChannels * bytesPerSample;
    const numSamples = maxSamples ? Math.min(maxSamples, buffer.length) : buffer.length;
    const dataSize = numSamples * blockAlign;
    const headerSize = 44;
    const totalSize = headerSize + dataSize;

    const wav = new ArrayBuffer(totalSize);
    const view = new DataView(wav);

    const writeStr = (offset, str) => {
        for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    };
    writeStr(0, 'RIFF');
    view.setUint32(4, totalSize - 8, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitsPerSample, true);
    writeStr(36, 'data');
    view.setUint32(40, dataSize, true);

    const channels = [];
    for (let ch = 0; ch < numChannels; ch++) {
        channels.push(buffer.getChannelData(ch));
    }

    let offset = headerSize;
    for (let i = 0; i < numSamples; i++) {
        for (let ch = 0; ch < numChannels; ch++) {
            let sample = channels[ch][i];
            sample = Math.max(-1, Math.min(1, sample));
            const int16 = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
            view.setInt16(offset, int16, true);
            offset += bytesPerSample;
        }
    }

    return wav;
}

function _parseCropString(cropStr) {
    let cropX = 0, cropY = 0, cropW = 1, cropH = 1;
    if (cropStr && typeof cropStr === 'string' && cropStr.trim() !== '') {
        const parts = cropStr.split(',').map(p => parseFloat(p.trim()));
        if (parts.length === 4 && parts.every(p => !isNaN(p))) {
            cropX = Math.max(0, Math.min(100, parts[0])) / 100;
            cropY = Math.max(0, Math.min(100, parts[1])) / 100;
            cropW = Math.max(1, Math.min(100, parts[2])) / 100;
            cropH = Math.max(1, Math.min(100, parts[3])) / 100;
        }
    }
    return { cropX, cropY, cropW, cropH };
}

function _drawImageFlipped(ctx, img, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, flipH, flipV) {
    if (!flipH && !flipV) {
        if (arg5 !== undefined) {
            ctx.drawImage(img, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8);
        } else if (arg3 !== undefined) {
            ctx.drawImage(img, arg1, arg2, arg3, arg4);
        } else {
            ctx.drawImage(img, arg1, arg2);
        }
        return;
    }
    
    ctx.save();
    let dx, dy, dw, dh;
    if (arg5 !== undefined) {
        // 9 arguments: img, sx, sy, sw, sh, dx, dy, dw, dh
        dx = arg5; dy = arg6; dw = arg7; dh = arg8;
        ctx.translate(dx + dw / 2, dy + dh / 2);
        ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1);
        ctx.drawImage(img, arg1, arg2, arg3, arg4, -dw / 2, -dh / 2, dw, dh);
    } else if (arg3 !== undefined) {
        // 5 arguments: img, dx, dy, dw, dh
        dx = arg1; dy = arg2; dw = arg3; dh = arg4;
        ctx.translate(dx + dw / 2, dy + dh / 2);
        ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1);
        ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
    } else {
        // 3 arguments: img, dx, dy
        dx = arg1; dy = arg2; dw = img.naturalWidth || img.width || 0; dh = img.naturalHeight || img.height || 0;
        ctx.translate(dx + dw / 2, dy + dh / 2);
        ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1);
        ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
    }
    ctx.restore();
}

function _drawCroppedVideoCover(ctx, videoEl, cropX, cropY, cropW, cropH, targetW, targetH, scalePct, offsetX = 0, offsetY = 0, flipH = false, flipV = false, rotation = 0) {
    if (!ctx || !videoEl || !(targetW > 0) || !(targetH > 0)) return;
    const srcW = videoEl.videoWidth || videoEl.naturalWidth || videoEl.width || targetW;
    const srcH = videoEl.videoHeight || videoEl.naturalHeight || videoEl.height || targetH;
    if (!(srcW > 0) || !(srcH > 0)) {
        _drawImageFlipped(ctx, videoEl, 0, 0, targetW, targetH, undefined, undefined, undefined, undefined, flipH, flipV);
        return;
    }
    const sx = srcW * cropX;
    const sy = srcH * cropY;
    const sWidth = srcW * cropW;
    const sHeight = srcH * cropH;

    const userScale = (scalePct || 100) / 100;
    let scale = Math.max(targetW / sWidth, targetH / sHeight) * userScale;
    // A quarter-turn swaps the drawn bounds.  Increase the scale enough to
    // keep the canvas filled, matching the interactive preview behaviour.
    const radians = Math.abs((Number(rotation) || 0) % 180) * Math.PI / 180;
    const preRotateW = sWidth * scale;
    const preRotateH = sHeight * scale;
    scale *= Math.max(1,
        targetW / (Math.abs(preRotateW * Math.cos(radians)) + Math.abs(preRotateH * Math.sin(radians))),
        targetH / (Math.abs(preRotateW * Math.sin(radians)) + Math.abs(preRotateH * Math.cos(radians))));
    const drawW = sWidth * scale;
    const drawH = sHeight * scale;
    const maxShiftX = Math.abs(targetW - drawW) / 2;
    const maxShiftY = Math.abs(targetH - drawH) / 2;
    const drawX = (targetW - drawW) / 2 + targetW * ((Number(offsetX) || 0) / 100);
    const drawY = (targetH - drawH) / 2 + targetH * ((Number(offsetY) || 0) / 100);
    if (!rotation) {
        _drawImageFlipped(ctx, videoEl, sx, sy, sWidth, sHeight, drawX, drawY, drawW, drawH, flipH, flipV);
        return;
    }
    ctx.save();
    ctx.translate(targetW / 2, targetH / 2);
    ctx.rotate((Number(rotation) || 0) * Math.PI / 180);
    ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1);
    ctx.drawImage(videoEl, sx, sy, sWidth, sHeight, -drawW / 2 + (drawX + drawW / 2 - targetW / 2), -drawH / 2 + (drawY + drawH / 2 - targetH / 2), drawW, drawH);
    ctx.restore();
}


/**
 * WYSIWYG 导出一个 Reel 任务
 */
function _createWysiwygStaticImageCache(width, height, createCanvas = () => document.createElement('canvas'), maxBytes = 24 * 1024 * 1024) {
    const cached = new Map();
    const failed = new WeakSet();
    let bytes = 0;
    const eligible = ov => ov.type === 'image' && !ov.disabled && /\.(png|jpe?g|bmp)$/i.test(ov.content || '')
        && Number(ov._exportImage?.naturalWidth) > 0
        && !(ov.is_phone_cta && ov.cta_loop_anim && ov.cta_loop_anim !== 'none')
        && !ov.anim_dest_enabled && !ov.is_img_sequence && !ov.media_folder_files?.length
        && !ov.display_ranges?.length && !ov.timeSlices?.length && !ov.subtitleTimeSlices?.length
        && !ov.card_blur_enabled && !ov.bg_blur_enabled
        && (!ov.blend_mode || ov.blend_mode === 'source-over')
        && [ov.transition_preset, ov.anim_in_type, ov.anim_out_type].every(value => !value || value === 'none');
    return {
        draw(ctx, ov, time, drawOverlay) {
            if (failed.has(ov) || !eligible(ov)) { drawOverlay(ctx, ov, time, width, height); return; }
            let entry = cached.get(ov);
            if (!entry) {
                // 临时整幅画布也计入预算，避免批量/高分辨率导出累积像素内存。
                if (bytes + width * height * 4 > maxBytes) { drawOverlay(ctx, ov, time, width, height); return; }
                const raster = createCanvas(); raster.width = width; raster.height = height;
                let cropped;
                try {
                    const rasterCtx = raster.getContext('2d');
                    drawOverlay(rasterCtx, ov, time, width, height);
                    const pixels = rasterCtx.getImageData(0, 0, width, height).data;
                    let left = width, top = height, right = -1, bottom = -1;
                    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
                        if (!pixels[(y * width + x) * 4 + 3]) continue;
                        left = Math.min(left, x); top = Math.min(top, y);
                        right = Math.max(right, x); bottom = Math.max(bottom, y);
                    }
                    if (right < 0) {
                        entry = { empty: true };
                    } else {
                        // 只复用实际有像素的区域，小 Logo 不必每帧复制整个 1080p 画布。
                        cropped = createCanvas(); cropped.width = right - left + 1; cropped.height = bottom - top + 1;
                        cropped.getContext('2d').drawImage(raster, left, top, cropped.width, cropped.height, 0, 0, cropped.width, cropped.height);
                        entry = { canvas: cropped, left, top };
                        bytes += cropped.width * cropped.height * 4;
                    }
                    cached.set(ov, entry);
                } catch (_) {
                    failed.add(ov);
                    if (cropped) { cropped.width = 1; cropped.height = 1; }
                    drawOverlay(ctx, ov, time, width, height);
                    return;
                } finally {
                    raster.width = 1; raster.height = 1;
                }
            }
            if (!entry.empty) ctx.drawImage(entry.canvas, entry.left, entry.top);
        },
        dispose() {
            for (const entry of cached.values()) if (entry.canvas) { entry.canvas.width = 1; entry.canvas.height = 1; }
            cached.clear(); bytes = 0;
        },
    };
}

async function _reelsWysiwygExportOnce(params) {
    let {
        canvas,
        style,
        segments,
        originalScript = '',
        scrollingText = '',
        overlays: taskOverlays,
        watermarks = [],
        cover = null,
        backgroundPath,
        bgMode = 'single',       // 'single' | 'multi'
        bgClipPool = [],         // 多素材池路径列表
        bgClipSettings = {},     // 多素材剪辑设置
        bgMinClipDur = 5,        // 最小卡点时长
        bgMaxClipDur = 7,        // 最大卡点时长
        bgClipOrder = 'random',  // 'random' | 'sequence'
        bgClipSeed = '',         // 随机顺序种子，与预览保持一致
        bgTransition = 'crossfade', // 多素材转场类型
        bgTransDur = 0.5,        // 多素材转场时长(秒)
        showSubtitle = true,
        overlayAboveSubtitle = true,
        voicePath,
        outputPath,
        targetWidth = 1080,
        targetHeight = 1920,
        fps = 30,
        voiceVolume = 1.0,
        bgVolume = 0.1,
        loopFade = true,
        loopFadeDur = 1.0,
        customDuration = 0,  // 自定义输出时长（秒），0 = 自动
        bgmPath = '',        // 配乐文件路径
        bgmVolume = 0.3,     // 配乐音量 (0~1)
        bgmStart = 0,        // 配乐素材起点（秒）
        contentVideoPath = null,
        contentVideoTrimStart = null,
        contentVideoTrimEnd = null,
        contentVideoScale = 100,
        contentVideoX = 'center',
        contentVideoY = 'center',
        contentVideoVolume = 1.0,
        contentVideoCrop = '',
        contentVideoBlurBg = false,
        contentVideoBlurStatic = false,
        contentVideoDirectBg = false,
        contentVideoBlur = 40,
        contentVideoBrightness = 60,
        bgScale = 100,       // 背景图片缩放 (50~300%)
        bgX = 0,
        bgY = 0,
        bgRotation = 0,
        bgFlipH = false,
        bgFlipV = false,
        contentVideoFlipH = false,
        contentVideoFlipV = false,
        bgDurScale = 100,    // 背景素材时长缩放 (10~500%)
        audioDurScale = 100,  // 音频素材时长缩放 (10~500%)
        reverbEnabled = false,
        reverbPreset = 'hall',
        reverbMix = 30,
        stereoWidth = 100,
        audioFxTarget = 'all',
        insertAudioClips = [],
        useMemoryDecoder = false,
        useGPU = false,
        crf = 23,
        qualityPreset = 'faster',
        targetBitrateMbps = null,
        maxBitrateMbps = null,
        exportEngine = 'precise',
        onProgress,
        onLog,
        isCancelled,
    } = params;

    const staticContentBlurFrame = await window.ReelsOverlay.prepareContentBlurBackground(params);


    const isMultiClip = bgMode === 'multi' && Array.isArray(bgClipPool) && bgClipPool.length > 0;
    if (params.forceCanvasBackground || isMultiClip) params.alphaOverlayBgPath = null;
    taskOverlays = _cloneOverlaysForWysiwygExport(taskOverlays);
    await window.ReelsOverlay.prepareScrollWritingLayers(taskOverlays, segments, (audioDurScale || 100) / 100);

    // ── 多素材诊断日志 ──
    console.log(`[WYSIWYG-EXPORT] bgMode=${bgMode}, bgClipPool=${Array.isArray(bgClipPool) ? bgClipPool.length : 'N/A'}, isMultiClip=${isMultiClip}, backgroundPath=${backgroundPath || '(empty)'}`);
    if (isMultiClip) {
        console.log(`[WYSIWYG-EXPORT] 多素材池:`, bgClipPool);
    }

    if (!canvas) throw new Error('需要提供 canvas');
    const overlayOnly = !backgroundPath && !isMultiClip && !contentVideoBlurBg && !contentVideoDirectBg;
    if (overlayOnly && !contentVideoPath && !(taskOverlays || []).some(ov => ov && !ov.disabled && ov.type !== 'audio')) {
        throw new Error('缺少可导出的画面：请添加背景或视觉覆层');
    }
    if (!outputPath) throw new Error('缺少输出路径');
    if (!window.electronAPI || !window.electronAPI.reelsComposeWysiwyg) {
        throw new Error('需要 reelsComposeWysiwyg IPC 接口');
    }

    if (voicePath && !(await _overlayLocalPathExists(voicePath))) {
        throw new Error(`配音文件不存在，请重新选择或生成配音：${voicePath}`);
    }
    if (bgmPath && bgmVolume > 0.001 && !(await _overlayLocalPathExists(bgmPath))) {
        throw new Error(`背景音乐文件不存在，请重新选择：${bgmPath}`);
    }

    // 允许无字幕（纯覆层模式）
    if (!segments) segments = [];

    const log = (msg) => { if (onLog) onLog(msg); console.log(`[WYSIWYG] ${msg}`); };
    const progress = (v) => { if (onProgress) onProgress(v); };

    // 媒体覆层必须使用本任务中保存的确切路径。预览可继续显示内存中的
    // blob/已解码元素，但隐藏导出窗口无法安全复用它们；更不能跨任务按同名
    // 文件猜测，否则会把另一任务的图片/GIF/视频覆层烧进成片。
    const overlayMediaBindings = [];
    for (const ov of (taskOverlays || [])) {
        if (!ov || ov.disabled || !['image', 'video'].includes(ov.type)) continue;
        const mediaPath = await _resolveMissingOverlayPath(ov, taskOverlays, log);
        if (!mediaPath || /^blob:/i.test(mediaPath) || !(await _overlayLocalPathExists(mediaPath))) {
            throw new Error(`覆层「${ov.name || ov.id || '未命名媒体'}」缺少有效本地路径，请重新选择该覆层素材后再导出：${ov.content || '(空)'}`);
        }
        // 导出快照必须只保留一种来源标识。此前这里虽然用解析后的绝对路径
        // 校验成功，但实际绘制仍使用 local-media:// / file:// 形式的旧 content，
        // 使图片缓存的 key 与校验路径脱节；连续任务时可能复用到前一任务的图。
        // taskOverlays 已是本次 job 的深拷贝，改写不会影响编辑器预览或其他任务。
        ov.content = mediaPath;
        // 文件夹循环也是本次导出的确定输入：把每一个候选文件预先校验并
        // 绑定，不能只用编辑器中当前显示的第一条素材。
        const folderFiles = Array.isArray(ov.media_folder_files) ? ov.media_folder_files : [];
        if (folderFiles.length) {
            const validFolderFiles = [];
            for (const source of folderFiles) {
                const local = _normalizeOverlayLocalPath(source);
                if (local && await _overlayLocalPathExists(local)) validFolderFiles.push(local);
            }
            ov.media_folder_files = validFolderFiles;
        }
        // 静态图片必须在导出开始前绑定到本 job 的私有 Image 对象。不要让
        // 逐帧绘制回落到跨任务常驻的预览图片缓存。
        if (ov.type === 'image') {
            ov._exportImage = await _loadImage(mediaPath);
            if (ov.media_folder_files?.length) {
                ov._exportFolderImages = {};
                for (const source of ov.media_folder_files) {
                    ov._exportFolderImages[source] = await _loadImage(source);
                }
            }
        }
        overlayMediaBindings.push(`${ov.name || ov.id || '未命名覆层'}=${mediaPath}`);
    }
    await window.ReelsOverlay.prepareMediaBlurFill(taskOverlays);
    if (overlayMediaBindings.length) {
        log(`覆层媒体绑定: ${overlayMediaBindings.join(' | ')}`);
    }

    // ── 确保所有覆层与字幕使用的字体全部预加载完成 ──
    if (window.getFontManager) {
        const fm = window.getFontManager();
        const fontsToLoad = fm.collectFonts({
            style,
            segments,
            overlays: taskOverlays,
            watermarks,
            cover: params.cover
        });
        if (fontsToLoad.length > 0) {
            log(`正在预加载字体: ${fontsToLoad.join(', ')}`);
        }
        await fm.ensureFontsLoaded(fontsToLoad);
        log('字体全部预加载就绪');
    }

    canvas.width = targetWidth;
    canvas.height = targetHeight;
    // willReadFrequently: 跳过每帧 GPU→CPU readback 同步（~1.5x 提速）
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const renderer = new ReelsCanvasRenderer(canvas);
    await renderer.prepareWritingCursorImage?.(style);

    // 获取时长：优先文字翻转器，其次自定义时长，否则音频时长，否则覆层视频时长，否则背景视频时长
    let duration = 0;
    const _audioDurFactor = (audioDurScale || 100) / 100;
    const _bgDurFactor = (bgDurScale || 100) / 100;
    const rawSubDuration = Array.isArray(segments) && segments.length > 0
        ? (parseFloat(segments[segments.length - 1].end) || 0)
        : 0;
    const effectiveSubDuration = voicePath ? rawSubDuration * _audioDurFactor : rawSubDuration;
    const requireMediaDuration = async (label, mediaPath) => {
        const fileName = String(mediaPath || '').split(/[/\\]/).pop() || '未知文件';
        if (window.electronAPI.getMediaDurationDetail) {
            const detail = await window.electronAPI.getMediaDurationDetail(mediaPath);
            if (detail?.ok && Number(detail.duration) > 0) return Number(detail.duration);
            throw new Error(`${label}无法读取时长：${fileName}。原因：${detail?.reason || '未知读取错误'}。路径：${detail?.path || mediaPath || '(空)'}`);
        }
        const numeric = Number(await window.electronAPI.getMediaDuration(mediaPath));
        if (Number.isFinite(numeric) && numeric > 0) return numeric;
        throw new Error(`${label}无法读取时长：${fileName}。原因：媒体未返回有效时长。路径：${mediaPath || '(空)'}`);
    };

    let maxFlipperDuration = 0;
    if (Array.isArray(taskOverlays)) {
        for (const ov of taskOverlays) {
            if (ov && !ov.disabled && ov.flipper_enabled) {
                const text = (ov.type === 'textcard') ? (ov.body_text || '') : (ov.content || '');
                const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
                const flipper_lines = parseInt(ov.flipper_lines) || 2;
                const flipper_duration = parseFloat(ov.flipper_duration) || 2.0;
                const totalChunks = Math.ceil(lines.length / flipper_lines);
                const flipperDur = (parseFloat(ov.start) || 0) + (totalChunks * flipper_duration);
                if (flipperDur > maxFlipperDuration) {
                    maxFlipperDuration = flipperDur;
                }
            }
        }
    }

    // A batch-wide custom duration is an explicit final cut point: it must
    // cap every source (background, voice and dynamic overlays), not merely
    // extend short videos.
    if (customDuration > 0) {
        duration = customDuration;
        log(`使用自定义时长: ${duration}s`);
    } else if (maxFlipperDuration > 0) {
        duration = maxFlipperDuration;
        log(`使用文字翻转器计算所得时长: ${duration}s`);
    } else {
        if (voicePath) {
            log('正在获取音频时长...');
            let rawAudioDur = await requireMediaDuration('配音/音频', voicePath);
            if (rawAudioDur > 0 && _audioDurFactor !== 1.0) {
                duration = rawAudioDur * _audioDurFactor;
                log(`音频原始时长: ${rawAudioDur.toFixed(2)}s × ${audioDurScale}% = ${duration.toFixed(2)}s`);
            } else {
                duration = rawAudioDur;
            }
        }
        // ── 覆层视频 (Content Video) 时长优先于背景 ──
        if ((!duration || duration <= 0) && contentVideoPath) {
            let cvDur = 0;
            // 情况1: 图片序列文件夹 → duration = imageCount / fps
            if (window.require) {
                try {
                    const fs = window.require('fs');
                    if (fs.existsSync(contentVideoPath) && fs.statSync(contentVideoPath).isDirectory()) {
                        const seqFiles = fs.readdirSync(contentVideoPath)
                            .filter(f => !f.startsWith('.') && /\.(png|jpg|jpeg|webp)$/i.test(f));
                        if (seqFiles.length > 0) {
                            cvDur = seqFiles.length / fps;
                            log(`覆层序列帧时长: ${seqFiles.length} 帧 / ${fps} fps = ${cvDur.toFixed(2)}s`);
                        }
                    }
                } catch (e) { /* not a directory or no fs */ }
            }
            // 情况2: 普通视频文件 → probe duration
            if (cvDur <= 0) {
                log('正在获取覆层视频时长...');
                let rawCvDur = await requireMediaDuration('覆层视频', contentVideoPath);
                if (rawCvDur > 0) {
                    const trimStart = parseFloat(contentVideoTrimStart) || 0;
                    const trimEnd   = parseFloat(contentVideoTrimEnd) || 0;
                    if (trimEnd > trimStart && trimStart >= 0) {
                        cvDur = trimEnd - trimStart;
                    } else {
                        cvDur = rawCvDur - trimStart;
                    }
                    log(`覆层视频时长: ${cvDur.toFixed(2)}s (原始 ${rawCvDur.toFixed(2)}s, trim ${trimStart}-${trimEnd || 'end'})`);
                }
            }
            if (cvDur > 0) {
                duration = Math.max(cvDur, effectiveSubDuration);
            }
        }
        if (!duration || duration <= 0) {
            if (isMultiClip) {
                // 多素材模式：按实际拼接后的有效时长计算。
                // 带转场时相邻素材会重叠 bgTransDur 秒，不能用素材时长简单相加，
                // 否则导出端会为了补足目标时长再次从素材池开头取片段。
                log(`正在获取多素材池时长 (${bgClipPool.length} 个)...`);
                let poolTotalDur = 0;
                let poolClipCount = 0;
                for (const clipPath of bgClipPool) {
                    if (_isImageFile(clipPath)) {
                        poolTotalDur += 5.0; // 图片默认 5 秒
                        poolClipCount++;
                    } else {
                        const clipDur = await requireMediaDuration('背景素材池视频', clipPath);
                        poolTotalDur += clipDur;
                        poolClipCount++;
                    }
                }
                const scaledPoolDur = poolTotalDur * _bgDurFactor;
                const transOverlap = bgTransition !== 'none' ? Math.max(0, bgTransDur || 0) : 0;
                const overlapTotal = transOverlap > 0 ? transOverlap * Math.max(0, poolClipCount - 1) : 0;
                duration = Math.max(0.5, scaledPoolDur - overlapTotal, effectiveSubDuration);
                log(`多素材池有效时长: ${scaledPoolDur.toFixed(2)}s - 转场重叠 ${overlapTotal.toFixed(2)}s = ${duration.toFixed(2)}s`);
            } else if (backgroundPath) {
                log('正在获取背景视频时长...');
                let rawBgDur = _isImageFile(backgroundPath)
                    ? 5
                    : await requireMediaDuration('背景视频', backgroundPath);
                if (rawBgDur > 0 && _bgDurFactor !== 1.0) {
                    duration = Math.max(rawBgDur * _bgDurFactor, effectiveSubDuration);
                    log(`背景原始时长: ${rawBgDur.toFixed(2)}s × ${bgDurScale}% = ${duration.toFixed(2)}s`);
                } else {
                    duration = Math.max(rawBgDur, effectiveSubDuration);
                }
            }
        }
        if (overlayOnly && !voicePath && !contentVideoPath) {
            duration = Math.max(duration || 0, effectiveSubDuration,
                await reelsResolveOverlayOnlyDuration(taskOverlays, requireMediaDuration));
        }
        if (!duration || duration <= 0) {
            // 图片背景无音频时默认 5 秒
            duration = 5;
            log(`无法获取时长，使用默认 ${duration}s`);
        }
    }
    const totalFrames = Math.max(1, Math.round(duration * fps));
    const outputDuration = totalFrames / fps;
    log(`时长: ${duration.toFixed(2)}s, 帧数: ${totalFrames}, FPS: ${fps}`);
    if (bgScale !== 100) log(`背景缩放: ${bgScale}%`);
    if (bgX !== 0 || bgY !== 0) log(`背景偏移: X=${bgX}%, Y=${bgY}%`);
    if (bgDurScale !== 100) log(`背景时长缩放: ${bgDurScale}%`);
    if (audioDurScale !== 100) log(`音频时长缩放: ${audioDurScale}%`);

    // ── 按 audioDurScale 缩放字幕时间戳（让字幕跟随音频拉长/缩短）──
    if (_audioDurFactor !== 1.0 && segments && segments.length > 0) {
        log(`字幕时间戳同步缩放 ×${_audioDurFactor.toFixed(2)}`);
        segments = segments.map(seg => ({
            ...seg,
            start: (seg.start || 0) * _audioDurFactor,
            end:   (seg.end   || 0) * _audioDurFactor,
            words: seg.words ? seg.words.map(w => ({
                ...w,
                start: (w.start || 0) * _audioDurFactor,
                end:   (w.end   || 0) * _audioDurFactor,
            })) : undefined
        }));
    }

    let uniformScrollTiming = null;
    if (window.ReelsUniformScroll?.isEnabled(style)) {
        let audioDuration = 0;
        let backgroundDuration = 0;
        if (style.scrolling_duration_source === 'audio' && voicePath) {
            audioDuration = await requireMediaDuration('滚动字幕音频', voicePath) * _audioDurFactor;
        }
        if (style.scrolling_duration_source === 'background') {
            const paths = isMultiClip ? bgClipPool : (backgroundPath ? [backgroundPath] : []);
            for (const mediaPath of paths) {
                backgroundDuration += (_isImageFile(mediaPath) ? 5 : await requireMediaDuration('滚动字幕背景', mediaPath)) * _bgDurFactor;
            }
            if (isMultiClip && bgTransition !== 'none') backgroundDuration = Math.max(0.5,
                backgroundDuration - Math.max(0, paths.length - 1) * Math.max(0, bgTransDur || 0));
        }
        uniformScrollTiming = { duration, audioDuration, backgroundDuration, timeScale: 1 };
        segments = window.ReelsUniformScroll.segments(segments, scrollingText || originalScript, duration);
    }

    // ── 检测覆层是否使用了非默认混合模式（screen/multiply 等需要背景像素才能生效）──
    const _hasBlendOverlay = (taskOverlays || []).some(ov =>
        !ov.disabled && ov.blend_mode && ov.blend_mode !== 'source-over'
    );
    // 磨砂不是一个独立的前景层：它要采样并模糊覆层下方已经画到 Canvas
    // 上的背景。Alpha Overlay 快速通道会故意把 Canvas 底图留为透明，改由
    // FFmpeg 在编码时补背景，因而磨砂在导出中只能采样到透明像素。
    const _hasBackdropSamplingOverlay = (taskOverlays || []).some(ov =>
        !ov.disabled && (ov.card_blur_enabled || ov.bg_blur_enabled)
    ) || (window.ReelsUniformScroll?.isEnabled(style) && style.scrolling_card_blur_enabled);

    // 完整成片的音频尾包、输出帧取整可能相差几毫秒，不应因此提前淡回片头。
    // 此处只决定是否需要循环，背景渲染路径始终遵循调用方传入的选择。
    if (loopFade && backgroundPath && !_isImageFile(backgroundPath) && !isMultiClip) {
        let _probedBg = await window.electronAPI.getMediaDuration(backgroundPath);
        _probedBg = _probedBg * (_bgDurFactor || 1.0);
        if (_probedBg > 0 && duration <= _probedBg + Math.max(0.1, 2 / fps)) {
            log(`成片时长(${duration.toFixed(2)}s)无需背景(${_probedBg.toFixed(2)}s)循环，跳过循环透明过渡。`);
            loopFade = false;
        }
    }

    // ── 有依赖 Canvas 背景像素的覆层时，直通路径必须降级 ──
    if ((_hasBlendOverlay || _hasBackdropSamplingOverlay) && params.alphaOverlayBgPath) {
        log(_hasBackdropSamplingOverlay
            ? '⚠️ 检测到磨砂覆层，禁用 Alpha Overlay 快速通道（需逐帧 Canvas 合成以保留背景采样）'
            : '⚠️ 检测到覆层使用混合模式，禁用 Alpha Overlay 快速通道（需逐帧 Canvas 合成以支持 blend mode）');
        params.alphaOverlayBgPath = null;
    }

    // 注意：OfflineAudioContext 在 Electron contextIsolation:true 下会崩溃
    // 所有音频效果由 FFmpeg afir 卷积滤镜处理（使用相同 seeded PRNG 的 IR）

    // Native media sits between the background and the Canvas foreground. Only
    // use it when there is no intervening content/mask/subtitle that it would
    // cross; the backend also stops at the first unsupported overlay layer.
    let directMedia = [];
    const directMediaSet = new Set();
    if (params.alphaOverlayBgPath && !params.forceCanvasBackground && backgroundPath && !isMultiClip && !_hasBlendOverlay && !_hasBackdropSamplingOverlay && !contentVideoPath
        && !contentVideoDirectBg && !contentVideoBlurBg && !style.global_mask_enabled
        && !style.ambient_lighting_enabled && !style.ambient_glow_enabled
        && !(overlayAboveSubtitle && showSubtitle && segments?.length)) {
        directMedia = await window.electronAPI.reelsComposeWysiwyg('plan-direct-media', {
            overlays: _cloneOverlaysForWysiwygExport(taskOverlays),
            width: targetWidth, height: targetHeight, duration: outputDuration,
        });
        if (Array.isArray(directMedia) && directMedia.length) {
            params.alphaOverlayBgPath = backgroundPath;
            for (const media of directMedia) directMediaSet.add(taskOverlays[media.index]);
            log(`⚡ 媒体直通：${directMedia.length} 个视频/图片层由 FFmpeg 直接合成，跳过逐帧抽图与 Canvas 绘制。`);
        } else directMedia = [];
    }

    // ═══ 阶段 1: 让主进程用 FFmpeg 预处理背景 + 提取帧序列 ═══
    let framesDir = null;
    let totalBgFrames = 0;
    let bgAudioPath = null;
    
    if (params.alphaOverlayBgPath) {
        log(loopFade && !_isImageFile(params.alphaOverlayBgPath)
            ? '⚡ 背景直通 + FFmpeg 循环透明过渡：跳过 Canvas 底图解压与搬运。'
            : '⚡ Alpha Overlay 模式激活：全面跳过底图解压与多层内存搬运！');
        progress(18);
    } else if (overlayOnly) {
        log('仅覆层模式：使用黑色底画布，跳过背景素材预处理');
        progress(18);
    } else if (contentVideoBlurBg || contentVideoDirectBg) {
        log('使用内容视频直接作为背景或模糊背景，跳过背景预处理');
        progress(18);
    } else {
        if (isMultiClip) {
            log(`阶段1: FFmpeg 多素材拼接（${bgClipPool.length}个片段，转场: ${bgTransition} ${bgTransDur}s）...`);
        } else {
            log('阶段1: FFmpeg 预处理背景视频（循环+淡入淡出+提取帧）...');
        }
        progress(2);

        const prepResult = await window.electronAPI.reelsComposeWysiwyg('prepare-bg', {
            backgroundPath: isMultiClip ? null : backgroundPath,
            bgMode: isMultiClip ? 'multi' : 'single',
            bgClipPool: isMultiClip ? bgClipPool : [],
            bgClipSettings: isMultiClip ? bgClipSettings : {},
            bgMinClipDur: isMultiClip ? bgMinClipDur : 0,
            bgMaxClipDur: isMultiClip ? bgMaxClipDur : 0,
            segments: isMultiClip ? (segments || []) : [],
            originalScript: isMultiClip ? (originalScript || '') : '',
            bgClipOrder: isMultiClip ? bgClipOrder : 'random',
            bgClipSeed: isMultiClip ? bgClipSeed : '',
            bgTransition: isMultiClip ? bgTransition : 'none',
            bgTransDur: isMultiClip ? bgTransDur : 0,
            voicePath,
            targetWidth,
            targetHeight,
            fps,
            duration: duration,
            loopFade: isMultiClip ? false : loopFade,
            loopFadeDur,
            bgScale: bgScale || 100,
            bgRotation: bgRotation || 0,
            bgX: bgX || 0,
            bgY: bgY || 0,
            bgFlipH: bgFlipH || false,
            bgFlipV: bgFlipV || false,
            bgDurScale: bgDurScale || 100,
        });

        if (!prepResult || prepResult.error) {
            throw new Error(prepResult?.error || '背景预处理失败');
        }
        framesDir = prepResult.framesDir;
        totalBgFrames = prepResult.frameCount;
        bgAudioPath = prepResult.bgAudioPath || null;
        log(`背景帧提取完成: ${totalBgFrames} 帧 → ${framesDir}`);
        const hasVideoBackground = isMultiClip
            ? bgClipPool.some(clipPath => !_isImageFile(clipPath))
            : !!backgroundPath && !_isImageFile(backgroundPath);
        const expectedBgFrames = Math.max(1, Math.round(duration * fps));
        const bgFrameTolerance = Math.max(2, Math.ceil(fps * 0.15));
        if (hasVideoBackground && totalBgFrames < expectedBgFrames - bgFrameTolerance) {
            const bgName = isMultiClip
                ? '背景素材池中的视频'
                : (String(backgroundPath).split(/[/\\]/).pop() || backgroundPath);
            throw new Error(`背景视频帧数不足：${bgName} 只提取到 ${totalBgFrames}/${expectedBgFrames} 帧。已停止导出，避免生成静帧视频；请检查素材编码或重新转码后再试。`);
        }
        // ── 安全检查：如果是多素材模式但提取了 0 帧，说明 FFmpeg 拼接出了问题 ──
        if (totalBgFrames === 0 && isMultiClip) {
            throw new Error(`多素材拼接失败：FFmpeg 提取了 0 帧。素材池: ${bgClipPool.length} 个文件`);
        }
        if (totalBgFrames === 0 && !contentVideoBlurBg && !contentVideoDirectBg) {
            log('⚠️ 警告: 背景帧数为 0，导出可能产生黑屏');
        }
        progress(18);
    }

    const videoOverlays = (taskOverlays || []).filter(ov => ov.type === 'video' && !ov.disabled && !directMediaSet.has(ov));
    if (videoOverlays.length > 0) {
        log(`阶段1.5: 预处理 ${videoOverlays.length} 个视频/动图覆层...`);
        for (const ov of videoOverlays) {
            if (!ov.content || ov.is_img_sequence) continue;
            const opath = await _resolveMissingOverlayPath(ov, taskOverlays, log);
            if (!opath || /^blob:/i.test(opath)) {
                throw new Error(`覆层素材不是可导出的本地文件路径: ${ov.name || ov.content}`);
            }
            const videoOffset = Math.max(0, parseFloat(ov.video_start_offset || 0));
            const overlayStart = Math.max(0, parseFloat(ov.start || 0));
            const configuredEnd = parseFloat(ov.end);
            // Clamp “whole project” (9999) and out-of-range ends to the actual export.
            const overlayEnd = Number.isFinite(configuredEnd) && configuredEnd < 9999
                ? Math.min(duration, configuredEnd) : duration;
            if (overlayStart >= overlayEnd) continue;
            let overlayPlayDur = overlayEnd - overlayStart;
            // Folder playback restarts each source at every interval, so frames
            // beyond that interval are never read, even on later cycles.
            if (ov.media_folder_files?.length) {
                const durations = await window.ReelsOverlay.prepareFolderMedia(ov);
                const interval = Number(ov.media_folder_interval) > 0 ? Number(ov.media_folder_interval) : Math.max(...durations);
                overlayPlayDur = Math.min(overlayPlayDur, interval);
            }
            const sources = ov.media_folder_files?.length ? ov.media_folder_files : [opath];
            if (sources.length > 1) ov._folderFramesByPath = {};
            for (const source of sources) {
                const oPrep = await window.electronAPI.reelsComposeWysiwyg('prepare-overlay', {
                    overlayPath: source,
                    fps,
                    duration: videoOffset + overlayPlayDur + 1,
                    loop: ov.media_loop !== false,
                    sourceFps: ov.fps || 30,
                });
                if (oPrep && oPrep.framesDir) {
                    if (ov._folderFramesByPath) ov._folderFramesByPath[source] = { framesDir: oPrep.framesDir, frameCount: oPrep.frameCount };
                    else { ov._framesDir = oPrep.framesDir; ov._frameCount = oPrep.frameCount; }
                }
            }
        }
    }

    let cvFramesDir = null;
    let cvFrameCount = 0;
    let cvPreparedDuration = duration;
    let cvIsImageSequence = false;
    // 任务私有：并发导出时不能共用 window 上的图片序列文件列表，
    // 否则后启动的任务会覆盖前一个任务的帧索引，造成静帧/错帧。
    let cvSeqFileList = null;
    if (contentVideoPath) {
        log(`阶段1.5: 预处理内容视频源 (${contentVideoPath})...`);
        const cvPathRaw = _normalizeOverlayLocalPath(contentVideoPath);

        // 检测是否为图片序列文件夹
        let isDir = false;
        if (window.require) {
            try {
                const fs = window.require('fs');
                if (fs.existsSync(cvPathRaw) && fs.statSync(cvPathRaw).isDirectory()) {
                    isDir = true;
                    const seqFiles = fs.readdirSync(cvPathRaw)
                        .filter(f => !f.startsWith('.') && /\.(png|jpg|jpeg|webp)$/i.test(f)).sort();
                    if (seqFiles.length > 0) {
                        cvFramesDir = cvPathRaw;
                        cvFrameCount = seqFiles.length;
                        cvIsImageSequence = true;
                        // 缓存文件名列表供本任务逐帧渲染使用（不可写入全局状态）。
                        cvSeqFileList = seqFiles;
                        log(`覆层图片序列: ${seqFiles.length} 帧 (直接使用源目录)`);
                    }
                }
            } catch (e) { /* not a directory */ }
        }

        if (!isDir) {
            const cvPrep = await window.electronAPI.reelsComposeWysiwyg('prepare-overlay', {
                overlayPath: cvPathRaw,
                fps,
                duration,
                trimStart: contentVideoTrimStart,
                trimEnd: contentVideoTrimEnd,
            });
            if (cvPrep && cvPrep.framesDir) {
                cvFramesDir = cvPrep.framesDir;
                cvFrameCount = cvPrep.frameCount;
                cvPreparedDuration = cvPrep.preparedDuration ?? duration;
            }
        }

        if (contentVideoBlurBg || contentVideoDirectBg) {
            let requiredDuration = Math.min(Number(duration), cvPreparedDuration);
            const trimStart = Number(contentVideoTrimStart);
            const trimEnd = Number(contentVideoTrimEnd);
            if (Number.isFinite(trimStart) && Number.isFinite(trimEnd) && trimEnd > trimStart) {
                requiredDuration = Math.min(requiredDuration, trimEnd - trimStart);
            }
            const requiredFrames = Math.max(1, Math.ceil(requiredDuration * fps) - 2);
            if (!cvFramesDir || cvFrameCount < requiredFrames) {
                throw new Error(
                    `内容背景帧数不足：需要约 ${requiredFrames} 帧，实际 ${cvFrameCount} 帧。` +
                    `为避免导出静帧，已停止导出，请检查内容视频或图片序列是否完整。`
                );
            }
        }
    }

    progress(20);

    // ═══ 阶段 2: 启动 FFmpeg 编码器 ═══
    log('阶段2: 启动 FFmpeg 编码器...');
    const sessionId = await window.electronAPI.reelsComposeWysiwyg('start', {
        width: targetWidth,
        height: targetHeight,
        fps,
        outputPath,
        voicePath,
        voiceVolume,
        bgVolume,
        backgroundPath: isMultiClip ? bgAudioPath : backgroundPath,
        alphaOverlayBgPath: params.alphaOverlayBgPath || null,
        overlayAudioClips: window.ReelsPlaybackDelay?.audioClips(taskOverlays) || [],
        directMedia,
        alphaBgDuration: params.alphaOverlayBgPath && !_isImageFile(params.alphaOverlayBgPath)
            ? await window.electronAPI.getMediaDuration(params.alphaOverlayBgPath)
            : 0,
        loopFade,
        loopFadeDur,
        // Multi-clip mode: use bgAudioPath if present. Single mode: check if bg has audio.
        bgHasAudio: isMultiClip ? (!!bgAudioPath) : (!!backgroundPath && !(voicePath && voicePath === backgroundPath) && !_isImageFile(backgroundPath)),
        bgmPath: bgmPath || '',
        bgmVolume: bgmVolume || 0,
        bgmStart: Math.max(0, parseFloat(bgmStart) || 0),
        bgScale: bgScale || 100,
        bgRotation: bgRotation || 0,
        bgFlipH,
        bgFlipV,
        bgX: bgX || 0,
        bgY: bgY || 0,
        bgDurScale: bgDurScale || 100,
        audioDurScale: audioDurScale || 100,
        targetDuration: outputDuration,
        totalFrames,
        reverbEnabled,
        reverbPreset,
        reverbMix,
        stereoWidth,
        audioFxTarget,
        insertAudioClips,
        useGPU,
        crf,
        qualityPreset,
        targetBitrateMbps,
        maxBitrateMbps,
        contentVideoPath: contentVideoPath || '',
        contentVideoVolume: contentVideoVolume,
        contentVideoCrop: contentVideoCrop || '',
        contentVideoBlurBg: contentVideoBlurBg || false,
    });
    if (!sessionId) throw new Error('FFmpeg 启动失败');

    // 极速流水线与极速硬件模式都使用无拷贝帧通道；硬件编码器由主进程探测并自动回退。
    let framePipeline = null;
    const normalizedEngine = exportEngine === 'experimental' ? 'hardware' : exportEngine;
    const wantsPipeline = normalizedEngine === 'pipeline' || normalizedEngine === 'hardware';
    if (normalizedEngine === 'hardware') log('极速硬件模式：正在自动探测系统 H.264 硬件编码器，不可用时回退 CPU。');
    if (wantsPipeline) {
        framePipeline = _createFramePipeline(sessionId, 3);
        log('阶段2.1: 已启用三帧批量流水线（同画布、同 FFmpeg 编码）。');
    }

    // 全局蒙版
    const hasMask = !!style.global_mask_enabled;
    const maskColor = style.global_mask_color || '#000000';
    const maskOpacity = style.global_mask_opacity ?? 0.5;


    // ═══ 阶段 2.5: 有界背景帧缓存 ═══
    // 禁止将整段视频的解码帧全部留在渲染进程中，避免长视频耗尽内存白屏。
    let _bgFrameCache = null;
    // 1080×1920 的一张解码图在 Chromium 中约占 8MB。旧上限 60~90 帧
    // 会让单个任务就占数百 MB，批量队列容易被系统直接终止。
    const frameCacheLimit = Math.max(8, Math.min(16, Math.round(fps / 2)));
    const framePrefetchSize = Math.max(4, Math.min(8, Math.round(fps / 4)));
    if (useMemoryDecoder && framesDir && totalBgFrames > 0) {
        _bgFrameCache = new Map();
        log(`阶段2.5: 启用滑动帧缓存（最多 ${frameCacheLimit} 帧）`);
        progress(19);
    }

    const loadBgFrame = async (idx) => {
        if (!framesDir || idx < 0 || idx >= totalBgFrames) return null;
        if (_bgFrameCache && _bgFrameCache.has(idx)) return _bgFrameCache.get(idx);
        const padRef = String(idx + 1).padStart(6, '0');
        const img = await _loadImage(`${framesDir}/frame_${padRef}.jpg`)
            .catch(() => _loadImage(`${framesDir}/frame_${padRef}.png`));
        if (_bgFrameCache) _bgFrameCache.set(idx, img);
        return img;
    };

    const prefetchBgFrames = async (startIdx) => {
        if (!_bgFrameCache) return;
        const end = Math.min(totalBgFrames, startIdx + framePrefetchSize);
        const pending = [];
        for (let idx = startIdx; idx < end; idx++) {
            if (!_bgFrameCache.has(idx)) pending.push(loadBgFrame(idx).catch(() => null));
        }
        await Promise.all(pending);
        const minKeep = Math.max(0, startIdx - 2);
        const maxKeep = startIdx + frameCacheLimit;
        for (const idx of _bgFrameCache.keys()) {
            if (idx < minKeep || idx >= maxKeep) {
                const oldImg = _bgFrameCache.get(idx);
                if (oldImg) oldImg.src = '';
                _bgFrameCache.delete(idx);
            }
        }
    };

    const clearBgFrameCache = () => {
        if (!_bgFrameCache) return;
        for (const img of _bgFrameCache.values()) {
            if (img) img.src = '';
        }
        _bgFrameCache.clear();
        _bgFrameCache = null;
    };
    const staticImageCache = _createWysiwygStaticImageCache(targetWidth, targetHeight);
    const sortedExportOverlays = (taskOverlays || []).filter(ov => !ov.disabled && !directMediaSet.has(ov))
        .slice().sort((a, b) => (Number(a.z_index) || 0) - (Number(b.z_index) || 0));

    // ═══ 阶段 3: 逐帧渲染 ═══
    log('阶段3: 逐帧 Canvas 渲染...');
    const t0 = Date.now();

    // 预加载第一帧
    let currentBgImg = null;
    let currentBgIdx = -1;
    let currentCvImg = null;
    let currentCvIdx = -1;

    try {
        for (let frameIdx = 0; frameIdx < totalFrames; frameIdx++) {
            // ── 取消检查 ──
            if (isCancelled && isCancelled()) {
                log('用户取消导出');
                throw new Error('__CANCELLED__');
            }
            const t = frameIdx / fps;

            // ── 预加载内容视频帧 ──
            if (contentVideoPath && cvFramesDir) {
                // Preview loops the selected content range until the task ends.
                let frameIdxCv = frameIdx;
                if (cvFrameCount > 0) {
                    frameIdxCv %= cvFrameCount;
                }
                if (frameIdxCv !== currentCvIdx) {
                    const previousCvImg = currentCvImg;
                    let framePath;
                    if (cvIsImageSequence && cvSeqFileList && cvSeqFileList.length > 0) {
                        // 图片序列: 使用原始文件名
                        const seqFile = cvSeqFileList[frameIdxCv];
                        framePath = `${cvFramesDir}/${seqFile}`;
                    } else {
                        // FFmpeg 提取的帧: frame_000001.png 格式
                        const frameName = `frame_${String(frameIdxCv + 1).padStart(6, '0')}.png`;
                        framePath = `${cvFramesDir}/${frameName}`;
                    }
                    try {
                        currentCvImg = await _loadImage(framePath);
                        currentCvIdx = frameIdxCv;
                        if (previousCvImg && previousCvImg !== currentCvImg) previousCvImg.src = '';
                    } catch (e) {
                        if (previousCvImg) previousCvImg.src = '';
                        currentCvImg = null;
                    }
                }
            }

            // 加载背景帧（兼容 jpg/png，优先使用内存预缓存）
            if (!contentVideoBlurBg && !contentVideoDirectBg && totalBgFrames > 0) {
                const bgFrameIdx = Math.min(frameIdx, totalBgFrames - 1);
                if (bgFrameIdx >= 0 && bgFrameIdx !== currentBgIdx) {
                    const previousBgImg = currentBgImg;
                    try {
                        if (_bgFrameCache && (bgFrameIdx === 0 || !_bgFrameCache.has(bgFrameIdx))) {
                            await prefetchBgFrames(bgFrameIdx);
                        }
                        currentBgImg = await loadBgFrame(bgFrameIdx);
                        currentBgIdx = bgFrameIdx;
                        if (!_bgFrameCache && previousBgImg && previousBgImg !== currentBgImg) previousBgImg.src = '';
                        if (_bgFrameCache && bgFrameIdx > 0 && bgFrameIdx % framePrefetchSize === 0) {
                            await prefetchBgFrames(bgFrameIdx + 1);
                        }
                    } catch (e) {
                        if (!_bgFrameCache && previousBgImg) previousBgImg.src = '';
                        currentBgImg = null;
                        currentBgIdx = -1;
                        ctx.fillStyle = '#000000';
                        ctx.fillRect(0, 0, targetWidth, targetHeight);
                    }
                }
            }

            // ── 预加载视频覆层帧 ──
            if (taskOverlays && taskOverlays.length > 0) {
                for (const ov of taskOverlays) {
                    if (ov.type === 'video' && !ov.disabled && !directMediaSet.has(ov)) {
                        const ovStart = parseFloat(ov.start || 0);
                        const ovEnd = Number.isFinite(parseFloat(ov.end)) ? parseFloat(ov.end) : duration;
                        // Hidden overlays need neither disk reads nor image decoding.
                        if (t < ovStart || t > ovEnd) {
                            ov._currentFrameImage = null;
                            continue;
                        }
                        let relTime = Math.max(0, t - ovStart);
                        let prepared = null;
                        if (ov.media_folder_files?.length) {
                            const playback = window.ReelsOverlay.resolveFolderMedia(ov, t);
                            const source = playback.path;
                            prepared = ov._folderFramesByPath?.[source] || null;
                            relTime = playback.time;
                        }
                        relTime += Math.max(0, Number(ov.video_start_offset) || 0);
                        const sourceRate = ov.is_img_sequence ? (Number(ov.fps) || 30) : fps;
                        let frameIdxOv = Math.floor(relTime * sourceRate);
                        
                        let fPath = null;
                        if (ov.is_img_sequence && ov.sequence_frames && ov.sequence_frames.length > 0) {
                            if (frameIdxOv >= ov.sequence_frames.length) {
                                frameIdxOv = ov.media_loop === false ? ov.sequence_frames.length - 1 : frameIdxOv % Math.max(1, ov.sequence_frames.length);
                            }
                            // sequence_frames 已经是合法的 url，若为原生路径等由外部处理（通常已处理好）
                            fPath = ov.sequence_frames[frameIdxOv];
                        } else if (prepared || ov._framesDir) {
                            const framesDir = prepared?.framesDir || ov._framesDir;
                            const frameCount = prepared?.frameCount || ov._frameCount;
                            if (!ov.media_folder_files?.length) {
                                frameIdxOv = Math.floor(window.ReelsOverlay.resolveVideoTime(ov, Math.max(0, t - ovStart), frameCount / sourceRate, 1 / sourceRate) * sourceRate + 1e-7);
                            }
                            if (frameIdxOv >= frameCount) {
                                frameIdxOv = ov.media_loop === false ? Math.max(0, frameCount - 1) : frameIdxOv % Math.max(1, frameCount);
                            }
                            const frameName = `frame_${String(frameIdxOv + 1).padStart(6, '0')}.png`;
                            fPath = `${framesDir}/${frameName}`;
                        }

                        if (fPath) {
                            try {
                                ov._currentFrameImage = await _loadImage(fPath);
                            } catch (e) {
                                ov._currentFrameImage = null;
                            }
                        }
                    }
                }
            }

            if (typeof ctx.reset === 'function') ctx.reset();
            else ctx.setTransform(1, 0, 0, 1, 0, 0);
            // ── 绘制背景帧 ──
            if (params.alphaOverlayBgPath) {
                ctx.clearRect(0, 0, targetWidth, targetHeight);
            } else {
                ctx.fillStyle = '#000000';
                ctx.fillRect(0, 0, targetWidth, targetHeight);
                if (contentVideoBlurBg && currentCvImg) {
                    const { cropX, cropY, cropW, cropH } = _parseCropString(contentVideoCrop);
                    const blurVal = contentVideoBlur != null ? contentVideoBlur : 40;
                    const brightnessVal = (contentVideoBrightness != null ? contentVideoBrightness : 60) / 100;
                    ctx.save();
                    ctx.filter = `blur(${blurVal}px) brightness(${brightnessVal})`;
                    _drawCroppedVideoCover(ctx, staticContentBlurFrame || currentCvImg, cropX, cropY, cropW, cropH, targetWidth, targetHeight, bgScale, bgX, bgY, bgFlipH, bgFlipV, bgRotation);
                    ctx.restore();
                } else if (contentVideoDirectBg && currentCvImg) {
                    const { cropX, cropY, cropW, cropH } = _parseCropString(contentVideoCrop);
                    _drawCroppedVideoCover(ctx, currentCvImg, cropX, cropY, cropW, cropH, targetWidth, targetHeight, bgScale, bgX, bgY, bgFlipH, bgFlipV, bgRotation);
                } else if (currentBgImg) {
                    // 直接绘制（FFmpeg 预处理时已完成缩放与裁切）
                    ctx.drawImage(currentBgImg, 0, 0, targetWidth, targetHeight);
                }
            }

            // ── 全局蒙版：与原始预览/V2 一致，只压暗背景层 ──
            if (hasMask) {
                ctx.save();
                ctx.globalAlpha = maskOpacity;
                ctx.fillStyle = maskColor;
                ctx.fillRect(0, 0, targetWidth, targetHeight);
                ctx.restore();
            }

            // ── 绘制合并内容视频 ──
            if (contentVideoPath && currentCvImg && !contentVideoDirectBg) {
                const imgW = currentCvImg.naturalWidth || targetWidth;
                const imgH = currentCvImg.naturalHeight || targetHeight;
                const { cropX, cropY, cropW, cropH } = _parseCropString(contentVideoCrop);
                const sx = imgW * cropX;
                const sy = imgH * cropY;
                const sWidth = imgW * cropW;
                const sHeight = imgH * cropH;

                const cScale = (contentVideoScale || 100) / 100;
                
                // Default width-fit
                const baseScale = targetWidth / sWidth;
                const finalScale = baseScale * cScale;
                const drawW = sWidth * finalScale;
                const drawH = sHeight * finalScale;
                
                let drawX = (targetWidth - drawW) / 2;
                let drawY = (targetHeight - drawH) / 2;
                
                if (contentVideoX && contentVideoX !== 'center') {
                    const relX = parseFloat(contentVideoX);
                    if (!isNaN(relX)) Math.abs(relX) <= 1 ? drawX += targetWidth * relX : drawX += relX * targetWidth / 1080;
                }
                if (contentVideoY && contentVideoY !== 'center') {
                    const relY = parseFloat(contentVideoY);
                    if (!isNaN(relY)) Math.abs(relY) <= 1 ? drawY += targetHeight * relY : drawY += relY * targetHeight / 1920;
                }
                
                _drawImageFlipped(ctx, currentCvImg, sx, sy, sWidth, sHeight, drawX, drawY, drawW, drawH, contentVideoFlipH, contentVideoFlipV);
            }

            // 环境暗部与逐字光源属于同一效果；先压暗画面，再由字幕光局部提亮。
            renderer.renderAmbientLightingBase?.(style, targetWidth, targetHeight);

            // ── 动态字幕 ──
            const renderSubtitle = () => {
                if (!showSubtitle) return;
                let activeSeg = segments.find(seg => t >= (seg.start || 0) && t <= (seg.end || 0));
                // Scrolling/typewriter mode: find nearest segment during gaps (same as preview logic)
                if (!activeSeg && (style.scrolling_mode || style.fullpage_typewriter) && segments.length > 0) {
                    let best = segments[0];
                    for (const seg of segments) {
                        if ((seg.start || 0) <= t) best = seg;
                    }
                    activeSeg = best;
                }
                if (activeSeg) {
                    renderer.setContextSegments(segments, originalScript);
                    renderer.setScrollTiming?.(uniformScrollTiming);
                    renderer.renderSubtitle(style, activeSeg, t, targetWidth, targetHeight);
                }
            };

            // 默认沿用旧项目：覆层在动态字幕上方。
            if (overlayAboveSubtitle) renderSubtitle();

            // ── 覆盖层（文字卡片等）──
            if (taskOverlays && taskOverlays.length > 0 && window.ReelsOverlay) {
                // 与主预览/分层导出一致：滚动覆层先绘制，其余按时间线层级顺序。
                for (const ov of sortedExportOverlays) {
                    ov._allOverlays = taskOverlays;
                    const ovStart = parseFloat(ov.start || 0);
                    const ovEnd = parseFloat(ov.end || 9999);
                    // scroll 覆层不受 end 限制（动画完成后保持最终位置）
                    if (t >= ovStart && (ov.type === 'scroll' || t <= ovEnd)) {
                        // 导出时不画辅助线和选中框
                        const origSelected = ov._selected;
                        try {
                            ov._selected = false;
                            ov._exporting = true;
                            ov._exportDuration = duration; // 让 scroll 覆层知道实际导出时长
                            staticImageCache.draw(ctx, ov, t, (drawCtx, layer, time, width, height) => ReelsOverlay.drawOverlay(drawCtx, layer, time, width, height));
                        } finally {
                            ov._selected = origSelected;
                            delete ov._exporting;
                        }
                    }
                }
            }


            if (!overlayAboveSubtitle) renderSubtitle();

            // ── AI 水印 ──
            if (typeof _drawWatermarks === 'function') {
                _drawWatermarks(ctx, targetWidth, targetHeight);
            }

            // ── Canvas → Raw RGBA → FFmpeg ──
            if (framePipeline) {
                // getImageData 已经返回独立 ArrayBuffer；直接交给 IPC，避免再 slice 一次整帧。
                await framePipeline.send(_canvasToRawRGBA(canvas, true));
            } else {
                const rawBuf = _canvasToRawRGBA(canvas);
                const frameResult = await window.electronAPI.reelsComposeWysiwyg('frame', { sessionId, raw: rawBuf });
                const frameOk = frameResult === true || (frameResult && frameResult.ok);
                if (!frameOk) {
                    const errMsg = (frameResult && frameResult.error) || '未知编码错误';
                    throw new Error(`第 ${frameIdx + 1} 帧写入失败：${errMsg}`);
                }
            }

            // ── 进度 + UI yield ──
            if (frameIdx % Math.max(1, Math.floor(fps / 2)) === 0) {
                const pct = 20 + Math.round((frameIdx / totalFrames) * 65);
                progress(pct);
                const elapsed = (Date.now() - t0) / 1000;
                const fpsActual = (frameIdx + 1) / Math.max(0.1, elapsed);
                const eta = (totalFrames - frameIdx) / Math.max(0.1, fpsActual);
                log(`帧 ${frameIdx + 1}/${totalFrames} (${pct}%) | ${fpsActual.toFixed(1)} fps | 剩余 ~${Math.ceil(eta)}s`);
                await new Promise(r => setTimeout(r, 0)); // yield
            }
        }

        // ═══ 阶段 4: 完成编码 + 混合音频 ═══
        if (framePipeline) await framePipeline.drain();
        log('阶段4: 完成编码与音频混合...');
        progress(88);
        const result = await window.electronAPI.reelsComposeWysiwyg('finish', { sessionId });
        if (!result || result.error) throw new Error(result?.error || 'FFmpeg 编码完成失败');

        // 释放解码图片和 Canvas 底层像素内存，避免下一个批量任务继续累积。
        clearBgFrameCache();
        staticImageCache.dispose();
        if (currentBgImg) currentBgImg.src = '';
        if (currentCvImg) currentCvImg.src = '';
        currentBgImg = null;
        currentCvImg = null;
        for (const ov of taskOverlays || []) {
            if (ov._exportImage) ov._exportImage.src = '';
            delete ov._exportImage;
            if (ov._exportFolderImages) Object.values(ov._exportFolderImages).forEach(img => { if (img) img.src = ''; });
            delete ov._exportFolderImages;
            if (ov._currentFrameImage) ov._currentFrameImage.src = '';
            delete ov._currentFrameImage;
            delete ov._allOverlays;
        }
        if (canvas) { canvas.width = 1; canvas.height = 1; }
        cvSeqFileList = null;

        // 清理背景帧（磁盘临时文件）
        if (framesDir) {
            await window.electronAPI.reelsComposeWysiwyg('cleanup-bg', { framesDir });
        }
        for (const ov of videoOverlays) {
            if (ov._framesDir) {
                try { await window.electronAPI.reelsComposeWysiwyg('cleanup-bg', { framesDir: ov._framesDir }); } catch (_) { }
            }
            for (const prep of Object.values(ov._folderFramesByPath || {})) {
                try { await window.electronAPI.reelsComposeWysiwyg('cleanup-bg', { framesDir: prep.framesDir }); } catch (_) { }
            }
            delete ov._folderFramesByPath;
        }
        if (cvFramesDir && !cvIsImageSequence) {
            try { await window.electronAPI.reelsComposeWysiwyg('cleanup-bg', { framesDir: cvFramesDir }); } catch (_) { }
        }

        progress(100);
        const totalTime = ((Date.now() - t0) / 1000).toFixed(1);
        log(`导出完成 (${totalTime}s): ${outputPath}`);
        return { output_path: result.output_path || outputPath };

    } catch (e) {
        clearBgFrameCache();
        staticImageCache.dispose();
        if (currentBgImg) currentBgImg.src = '';
        if (currentCvImg) currentCvImg.src = '';
        currentBgImg = null;
        currentCvImg = null;
        for (const ov of taskOverlays || []) {
            if (ov._exportImage) ov._exportImage.src = '';
            delete ov._exportImage;
            if (ov._exportFolderImages) Object.values(ov._exportFolderImages).forEach(img => { if (img) img.src = ''; });
            delete ov._exportFolderImages;
            if (ov._currentFrameImage) ov._currentFrameImage.src = '';
            delete ov._currentFrameImage;
            delete ov._allOverlays;
        }
        if (canvas) { canvas.width = 1; canvas.height = 1; }
        cvSeqFileList = null;
        try { await window.electronAPI.reelsComposeWysiwyg('abort', { sessionId }); } catch (_) { }
        if (framesDir) {
            try { await window.electronAPI.reelsComposeWysiwyg('cleanup-bg', { framesDir }); } catch (_) { }
        }
        for (const ov of videoOverlays) {
            if (ov._framesDir) {
                try { await window.electronAPI.reelsComposeWysiwyg('cleanup-bg', { framesDir: ov._framesDir }); } catch (_) { }
            }
            for (const prep of Object.values(ov._folderFramesByPath || {})) {
                try { await window.electronAPI.reelsComposeWysiwyg('cleanup-bg', { framesDir: prep.framesDir }); } catch (_) { }
            }
            delete ov._folderFramesByPath;
        }
        if (cvFramesDir && !cvIsImageSequence) {
            try { await window.electronAPI.reelsComposeWysiwyg('cleanup-bg', { framesDir: cvFramesDir }); } catch (_) { }
        }
        if (e && e.message === '__CANCELLED__') {
            log('导出已取消，资源已清理');
            return { cancelled: true };
        }
        throw e;
    }
}

// FFmpeg 的直通背景/原生媒体滤镜链遇到个别任务参数时，可能会在首几帧
// 重新配置失败。该快速路径只是优化，不应让单条任务无法导出；降级到原有
// 的逐帧 Canvas 背景路径后，仍会保留相同的画布、字幕与覆层效果。
async function reelsWysiwygExport(params) {
    try {
        return await _reelsWysiwygExportOnce(params);
    } catch (error) {
        const message = String(error?.message || error || '');
        const usedFastPath = !!params?.alphaOverlayBgPath;
        const filterFailure = /(?:滤镜或特效参数不兼容|Error (?:re)?initializing (?:complex )?filters|Failed to configure output pad)/i.test(message);
        if (!usedFastPath || !filterFailure || params?.forceCanvasBackground) throw error;

        params.onLog?.('⚠️ 直通渲染滤镜链初始化失败，自动切换到兼容渲染路径后重试…');
        const retryParams = {
            ...params,
            alphaOverlayBgPath: null,
            forceCanvasBackground: true,
        };
        return _reelsWysiwygExportOnce(retryParams);
    }
}

function _isImageFile(filePath) {
    const ext = (filePath || '').split('.').pop().toLowerCase();
    return ['jpg', 'jpeg', 'png', 'webp', 'bmp'].includes(ext);
}

if (typeof window !== 'undefined') {
    window.reelsWysiwygExport = reelsWysiwygExport;
}
