/**
 * reels-turbo-export.js — 新极速导出（turbo，实验）
 *
 * 完全独立于 reels-wysiwyg-export.js 中的三种旧导出（精准画布 / 极速流水线 / 极速硬件），
 * 不修改旧导出的任何流程。只复用旧文件里已稳定的工具函数（路径解析、裁切绘制等），
 * 画面绘制仍是同一个 ReelsCanvasRenderer / ReelsOverlay.drawOverlay。
 *
 * 与旧导出的区别只在“画好之后”：
 *   旧：画布 → getImageData（每帧 8MB 读回内存）→ IPC 复制 → FFmpeg stdin → libx264
 *   新：画布（GPU）→ VideoFrame → WebCodecs 硬件 H.264 编码 → 只写压缩数据
 * 以及帧读取：后台并行解码 + 预读（reels-turbo-decoder.js）。
 * 每个任务开始前由 reels-turbo-planner.js 判断每层素材的读取方式并写入日志。
 */

function _turboIpc(action, data) {
    if (window.electronAPI && typeof window.electronAPI.reelsTurboExport === 'function') {
        return window.electronAPI.reelsTurboExport(action, data);
    }
    const { ipcRenderer } = require('electron');
    return ipcRenderer.invoke('reels-turbo-export', action, data);
}

// H.264 等级候选：先硬件，后软件（同一 WebCodecs 流程，不回退旧导出）。
async function _turboPickEncoderConfig({ width, height, fps, bitrate }) {
    const codecs = ['avc1.640033', 'avc1.64002A', 'avc1.640028', 'avc1.4D0033', 'avc1.42E033'];
    for (const hardwareAcceleration of ['prefer-hardware', 'no-preference']) {
        for (const codec of codecs) {
            const config = {
                codec, width, height, bitrate, framerate: fps,
                hardwareAcceleration,
                bitrateMode: 'variable',
                latencyMode: 'quality',
                avc: { format: 'annexb' },
            };
            try {
                const support = await VideoEncoder.isConfigSupported(config);
                if (support && support.supported) return { config: support.config || config, hardware: hardwareAcceleration === 'prefer-hardware' };
            } catch (_) { }
        }
    }
    throw new Error('当前系统不支持 WebCodecs H.264 编码');
}

function _turboCreateEncoder(config, fd) {
    const fs = require('fs');
    const state = { chunks: 0, bytes: 0, error: null };
    const encoder = new VideoEncoder({
        output: (chunk) => {
            try {
                const buf = new Uint8Array(chunk.byteLength);
                chunk.copyTo(buf);
                fs.writeSync(fd, buf);
                state.chunks++;
                state.bytes += buf.byteLength;
            } catch (error) {
                state.error = error;
            }
        },
        error: (error) => { state.error = error; },
    });
    encoder.configure(config);
    const waitQueue = (limit) => new Promise((resolve) => {
        if (encoder.encodeQueueSize <= limit) { resolve(); return; }
        const onDequeue = () => {
            if (encoder.encodeQueueSize <= limit || state.error) {
                encoder.removeEventListener('dequeue', onDequeue);
                resolve();
            }
        };
        encoder.addEventListener('dequeue', onDequeue);
    });
    return { encoder, state, waitQueue };
}

async function reelsTurboExport(params) {
    let {
        canvas,
        style,
        segments,
        originalScript = '',
        scrollingText = '',
        overlays: taskOverlays,
        watermarks = [],
        backgroundPath,
        bgMode = 'single',
        bgClipPool = [],
        bgClipSettings = {},
        bgMinClipDur = 5,
        bgMaxClipDur = 7,
        bgClipOrder = 'random',
        bgClipSeed = '',
        bgTransition = 'crossfade',
        bgTransDur = 0.5,
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
        customDuration = 0,
        bgmPath = '',
        bgmVolume = 0.3,
        bgmStart = 0,
        contentVideoPath = null,
        contentVideoTrimStart = null,
        contentVideoTrimEnd = null,
        contentVideoScale = 100,
        contentVideoX = 'center',
        contentVideoY = 'center',
        contentVideoVolume = 1.0,
        contentVideoCrop = '',
        contentVideoBlurBg = false,
        contentVideoDirectBg = false,
        contentVideoBlur = 40,
        contentVideoBrightness = 60,
        bgScale = 100,
        bgX = 0,
        bgY = 0,
        bgRotation = 0,
        bgFlipH = false,
        bgFlipV = false,
        contentVideoFlipH = false,
        contentVideoFlipV = false,
        bgDurScale = 100,
        audioDurScale = 100,
        reverbEnabled = false,
        reverbPreset = 'hall',
        reverbMix = 30,
        stereoWidth = 100,
        audioFxTarget = 'all',
        insertAudioClips = [],
        crf = 23,
        targetBitrateMbps = null,
        maxBitrateMbps = null,
        onProgress,
        onLog,
        isCancelled,
    } = params;

    const log = (msg) => { if (onLog) onLog(msg); console.log(`[TURBO] ${msg}`); };
    const progress = (v) => { if (onProgress) onProgress(v); };
    const tStart = performance.now();
    const stats = { prepare: 0, decodeWait: 0, draw: 0, encodeWait: 0, finish: 0 };

    if (!canvas) throw new Error('需要提供 canvas');
    if (!outputPath) throw new Error('缺少输出路径');
    if (typeof VideoEncoder === 'undefined') throw new Error('当前环境不支持 WebCodecs，无法使用新极速导出');

    const staticContentBlurFrame = await window.ReelsOverlay.prepareContentBlurBackground(params);
    const isMultiClip = bgMode === 'multi' && Array.isArray(bgClipPool) && bgClipPool.length > 0;
    taskOverlays = _cloneOverlaysForWysiwygExport(taskOverlays);
    await window.ReelsOverlay.prepareScrollWritingLayers(taskOverlays, segments, (audioDurScale || 100) / 100);
    const overlayOnly = !backgroundPath && !isMultiClip && !contentVideoBlurBg && !contentVideoDirectBg;
    if (overlayOnly && !contentVideoPath && !(taskOverlays || []).some(ov => ov && !ov.disabled && ov.type !== 'audio')) {
        throw new Error('缺少可导出的画面：请添加背景或视觉覆层');
    }
    if (voicePath && !(await _overlayLocalPathExists(voicePath))) {
        throw new Error(`配音文件不存在，请重新选择或生成配音：${voicePath}`);
    }
    if (bgmPath && bgmVolume > 0.001 && !(await _overlayLocalPathExists(bgmPath))) {
        throw new Error(`背景音乐文件不存在，请重新选择：${bgmPath}`);
    }
    if (!segments) segments = [];

    // ── 智能判断：每层素材的读取方式 ──
    const plan = window.ReelsTurboPlanner.planTurboExport({ ...params, overlays: taskOverlays });
    for (const line of plan.lines) log(line);

    // ── 覆层媒体绑定（与旧导出相同的校验规则：只用本任务保存的确切路径）──
    const overlayMediaBindings = [];
    for (const ov of (taskOverlays || [])) {
        if (!ov || ov.disabled || !['image', 'video'].includes(ov.type)) continue;
        const mediaPath = await _resolveMissingOverlayPath(ov, taskOverlays, log);
        if (!mediaPath || /^blob:/i.test(mediaPath) || !(await _overlayLocalPathExists(mediaPath))) {
            throw new Error(`覆层「${ov.name || ov.id || '未命名媒体'}」缺少有效本地路径，请重新选择该覆层素材后再导出：${ov.content || '(空)'}`);
        }
        ov.content = mediaPath;
        const folderFiles = Array.isArray(ov.media_folder_files) ? ov.media_folder_files : [];
        if (folderFiles.length) {
            const validFolderFiles = [];
            for (const source of folderFiles) {
                const local = _normalizeOverlayLocalPath(source);
                if (local && await _overlayLocalPathExists(local)) validFolderFiles.push(local);
            }
            ov.media_folder_files = validFolderFiles;
        }
        if (ov.type === 'image') {
            ov._exportImage = await _loadImage(mediaPath);
            if (ov.media_folder_files?.length) {
                ov._exportFolderImages = {};
                for (const source of ov.media_folder_files) ov._exportFolderImages[source] = await _loadImage(source);
            }
        }
        overlayMediaBindings.push(`${ov.name || ov.id || '未命名覆层'}=${mediaPath}`);
    }
    await window.ReelsOverlay.prepareMediaBlurFill(taskOverlays);
    if (overlayMediaBindings.length) log(`覆层媒体绑定: ${overlayMediaBindings.join(' | ')}`);

    if (window.getFontManager) {
        const fm = window.getFontManager();
        const fontsToLoad = fm.collectFonts({ style, segments, overlays: taskOverlays, watermarks, cover: params.cover });
        if (fontsToLoad.length > 0) log(`正在预加载字体: ${fontsToLoad.join(', ')}`);
        await fm.ensureFontsLoaded(fontsToLoad);
    }

    canvas.width = targetWidth;
    canvas.height = targetHeight;
    // GPU 画布：不设置 willReadFrequently（那会强制 CPU 光栅化并为读回优化）。
    // turbo 不读回像素，画面直接以 GPU 纹理交给硬件编码器。
    const ctx = canvas.getContext('2d', params.turboRaster === 'cpu' ? { willReadFrequently: true } : undefined);
    const renderer = new ReelsCanvasRenderer(canvas);
    await renderer.prepareWritingCursorImage?.(style);

    // ── 时长（与旧导出相同的规则）──
    let duration = 0;
    const _audioDurFactor = (audioDurScale || 100) / 100;
    const _bgDurFactor = (bgDurScale || 100) / 100;
    const rawSubDuration = Array.isArray(segments) && segments.length > 0 ? (parseFloat(segments[segments.length - 1].end) || 0) : 0;
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
    for (const ov of (taskOverlays || [])) {
        if (ov && !ov.disabled && ov.flipper_enabled) {
            const text = (ov.type === 'textcard') ? (ov.body_text || '') : (ov.content || '');
            const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
            const flipperLines = parseInt(ov.flipper_lines) || 2;
            const flipperDurationEach = parseFloat(ov.flipper_duration) || 2.0;
            const flipperDur = (parseFloat(ov.start) || 0) + (Math.ceil(lines.length / flipperLines) * flipperDurationEach);
            if (flipperDur > maxFlipperDuration) maxFlipperDuration = flipperDur;
        }
    }

    if (customDuration > 0) {
        duration = customDuration;
        log(`使用自定义时长: ${duration}s`);
    } else if (maxFlipperDuration > 0) {
        duration = maxFlipperDuration;
        log(`使用文字翻转器计算所得时长: ${duration}s`);
    } else {
        if (voicePath) {
            const rawAudioDur = await requireMediaDuration('配音/音频', voicePath);
            duration = rawAudioDur > 0 && _audioDurFactor !== 1.0 ? rawAudioDur * _audioDurFactor : rawAudioDur;
        }
        if ((!duration || duration <= 0) && contentVideoPath) {
            let cvDur = 0;
            try {
                const fs = require('fs');
                const local = _normalizeOverlayLocalPath(contentVideoPath);
                if (fs.existsSync(local) && fs.statSync(local).isDirectory()) {
                    const seqFiles = fs.readdirSync(local).filter(f => !f.startsWith('.') && /\.(png|jpg|jpeg|webp)$/i.test(f));
                    if (seqFiles.length > 0) cvDur = seqFiles.length / fps;
                }
            } catch (_) { }
            if (cvDur <= 0) {
                const rawCvDur = await requireMediaDuration('覆层视频', contentVideoPath);
                if (rawCvDur > 0) {
                    const trimStart = parseFloat(contentVideoTrimStart) || 0;
                    const trimEnd = parseFloat(contentVideoTrimEnd) || 0;
                    cvDur = trimEnd > trimStart && trimStart >= 0 ? trimEnd - trimStart : rawCvDur - trimStart;
                }
            }
            if (cvDur > 0) duration = Math.max(cvDur, effectiveSubDuration);
        }
        if (!duration || duration <= 0) {
            if (isMultiClip) {
                let poolTotalDur = 0;
                let poolClipCount = 0;
                for (const clipPath of bgClipPool) {
                    poolTotalDur += _isImageFile(clipPath) ? 5.0 : await requireMediaDuration('背景素材池视频', clipPath);
                    poolClipCount++;
                }
                const scaledPoolDur = poolTotalDur * _bgDurFactor;
                const transOverlap = bgTransition !== 'none' ? Math.max(0, bgTransDur || 0) : 0;
                const overlapTotal = transOverlap > 0 ? transOverlap * Math.max(0, poolClipCount - 1) : 0;
                duration = Math.max(0.5, scaledPoolDur - overlapTotal, effectiveSubDuration);
            } else if (backgroundPath) {
                const rawBgDur = _isImageFile(backgroundPath) ? 5 : await requireMediaDuration('背景视频', backgroundPath);
                duration = rawBgDur > 0 && _bgDurFactor !== 1.0
                    ? Math.max(rawBgDur * _bgDurFactor, effectiveSubDuration)
                    : Math.max(rawBgDur, effectiveSubDuration);
            }
        }
        if (overlayOnly && !voicePath && !contentVideoPath) {
            duration = Math.max(duration || 0, effectiveSubDuration, await reelsResolveOverlayOnlyDuration(taskOverlays, requireMediaDuration));
        }
        if (!duration || duration <= 0) duration = 5;
    }
    const totalFrames = Math.max(1, Math.round(duration * fps));
    const outputDuration = totalFrames / fps;
    log(`时长: ${duration.toFixed(2)}s, 帧数: ${totalFrames}, FPS: ${fps}`);

    if (_audioDurFactor !== 1.0 && segments && segments.length > 0) {
        segments = segments.map(seg => ({
            ...seg,
            start: (seg.start || 0) * _audioDurFactor,
            end: (seg.end || 0) * _audioDurFactor,
            words: seg.words ? seg.words.map(w => ({ ...w, start: (w.start || 0) * _audioDurFactor, end: (w.end || 0) * _audioDurFactor })) : undefined,
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

    if (loopFade && backgroundPath && !_isImageFile(backgroundPath) && !isMultiClip) {
        const probedBg = (await window.electronAPI.getMediaDuration(backgroundPath)) * (_bgDurFactor || 1.0);
        if (probedBg > 0 && duration <= probedBg + Math.max(0.1, 2 / fps)) loopFade = false;
    }

    // ═══ 阶段 1：背景帧（与旧导出相同的 FFmpeg 预处理）═══
    let framesDir = null;
    let totalBgFrames = 0;
    let bgAudioPath = null;
    let bgFrameExt = 'jpg';
    const cleanupDirs = [];
    const sources = [];
    const newSource = (label) => {
        const source = new window.ReelsTurboDecoder.TurboFrameSource(label, plan.prefetch);
        sources.push(source);
        return source;
    };
    let sessionId = null;
    let fd = null;
    let h264Path = null;
    let enc = null;

    const disposeAll = async () => {
        for (const source of sources) source.dispose();
        for (const ov of taskOverlays || []) {
            if (ov._exportImage) ov._exportImage.src = '';
            delete ov._exportImage;
            if (ov._exportFolderImages) Object.values(ov._exportFolderImages).forEach(img => { if (img) img.src = ''; });
            delete ov._exportFolderImages;
            delete ov._currentFrameImage;
            delete ov._allOverlays;
        }
        if (enc && enc.encoder.state !== 'closed') { try { enc.encoder.close(); } catch (_) { } }
        if (fd !== null) { try { require('fs').closeSync(fd); } catch (_) { } fd = null; }
        for (const dir of cleanupDirs) {
            try { await window.electronAPI.reelsComposeWysiwyg('cleanup-bg', { framesDir: dir }); } catch (_) { }
        }
        if (canvas) { canvas.width = 1; canvas.height = 1; }
    };

    try {
        const tPrep = performance.now();
        if (!overlayOnly && !contentVideoBlurBg && !contentVideoDirectBg) {
            log(isMultiClip ? `阶段1: FFmpeg 多素材拼接（${bgClipPool.length}个片段）...` : '阶段1: FFmpeg 预处理背景...');
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
                voicePath, targetWidth, targetHeight, fps, duration,
                loopFade: isMultiClip ? false : loopFade,
                loopFadeDur,
                bgScale: bgScale || 100, bgRotation: bgRotation || 0, bgX: bgX || 0, bgY: bgY || 0,
                bgFlipH: bgFlipH || false, bgFlipV: bgFlipV || false, bgDurScale: bgDurScale || 100,
            });
            if (!prepResult || prepResult.error) throw new Error(prepResult?.error || '背景预处理失败');
            framesDir = prepResult.framesDir;
            totalBgFrames = prepResult.frameCount;
            bgAudioPath = prepResult.bgAudioPath || null;
            cleanupDirs.push(framesDir);
            try {
                const first = require('fs').readdirSync(framesDir).find(f => /^frame_\d+\.(jpg|png)$/i.test(f));
                if (first) bgFrameExt = first.split('.').pop();
            } catch (_) { }
            const hasVideoBackground = isMultiClip ? bgClipPool.some(p => !_isImageFile(p)) : !!backgroundPath && !_isImageFile(backgroundPath);
            const expectedBgFrames = Math.max(1, Math.round(duration * fps));
            const tolerance = Math.max(2, Math.ceil(fps * 0.15));
            if (hasVideoBackground && totalBgFrames < expectedBgFrames - tolerance) {
                throw new Error(`背景视频帧数不足：只提取到 ${totalBgFrames}/${expectedBgFrames} 帧。已停止导出，避免生成静帧视频；请检查素材编码或重新转码后再试。`);
            }
            if (!(totalBgFrames > 0)) throw new Error('背景预处理失败：没有生成有效视频帧。');
            log(`背景帧: ${totalBgFrames} 帧`);
        }
        progress(14);

        // ── 视频覆层帧 ──
        const videoOverlays = (taskOverlays || []).filter(ov => ov.type === 'video' && !ov.disabled);
        for (const ov of videoOverlays) {
            if (!ov.content || ov.is_img_sequence) continue;
            const opath = await _resolveMissingOverlayPath(ov, taskOverlays, log);
            if (!opath || /^blob:/i.test(opath)) throw new Error(`覆层素材不是可导出的本地文件路径: ${ov.name || ov.content}`);
            const videoOffset = Math.max(0, parseFloat(ov.video_start_offset || 0));
            const overlayStart = Math.max(0, parseFloat(ov.start || 0));
            const configuredEnd = parseFloat(ov.end);
            const overlayEnd = Number.isFinite(configuredEnd) && configuredEnd < 9999 ? Math.min(duration, configuredEnd) : duration;
            if (overlayStart >= overlayEnd) continue;
            let overlayPlayDur = overlayEnd - overlayStart;
            if (ov.media_folder_files?.length) {
                const durations = await window.ReelsOverlay.prepareFolderMedia(ov);
                const interval = Number(ov.media_folder_interval) > 0 ? Number(ov.media_folder_interval) : Math.max(...durations);
                overlayPlayDur = Math.min(overlayPlayDur, interval);
            }
            const sourcesList = ov.media_folder_files?.length ? ov.media_folder_files : [opath];
            if (sourcesList.length > 1) ov._folderFramesByPath = {};
            for (const source of sourcesList) {
                const oPrep = await window.electronAPI.reelsComposeWysiwyg('prepare-overlay', {
                    overlayPath: source, fps,
                    duration: videoOffset + overlayPlayDur + 1,
                    loop: ov.media_loop !== false,
                    sourceFps: ov.fps || 30,
                });
                if (oPrep?.framesDir) cleanupDirs.push(oPrep.framesDir);
                if (!oPrep || oPrep.error || !oPrep.framesDir || !(oPrep.frameCount > 0)) {
                    throw new Error(`覆层预处理失败：${source}。原因：${oPrep?.error || '没有生成有效视频帧'}`);
                }
                if (oPrep && oPrep.framesDir) {
                    if (ov._folderFramesByPath) ov._folderFramesByPath[source] = { framesDir: oPrep.framesDir, frameCount: oPrep.frameCount };
                    else { ov._framesDir = oPrep.framesDir; ov._frameCount = oPrep.frameCount; }
                }
            }
            ov._turboSource = newSource(`覆层 ${ov.name || ov.id}`);
        }

        // ── 内容视频帧 ──
        let cvFramesDir = null;
        let cvFrameCount = 0;
        let cvPreparedDuration = duration;
        let cvSeqFileList = null;
        if (contentVideoPath) {
            log(`阶段1.5: 预处理内容视频源 (${contentVideoPath})...`);
            const cvPathRaw = _normalizeOverlayLocalPath(contentVideoPath);
            let isDir = false;
            try {
                const fs = require('fs');
                if (fs.existsSync(cvPathRaw) && fs.statSync(cvPathRaw).isDirectory()) {
                    isDir = true;
                    const seqFiles = fs.readdirSync(cvPathRaw).filter(f => !f.startsWith('.') && /\.(png|jpg|jpeg|webp)$/i.test(f)).sort();
                    if (seqFiles.length > 0) {
                        cvFramesDir = cvPathRaw;
                        cvFrameCount = seqFiles.length;
                        cvSeqFileList = seqFiles;
                    }
                }
            } catch (_) { }
            if (!isDir) {
                const cvPrep = await window.electronAPI.reelsComposeWysiwyg('prepare-overlay', {
                    overlayPath: cvPathRaw, fps, duration,
                    trimStart: contentVideoTrimStart, trimEnd: contentVideoTrimEnd,
                });
                if (cvPrep?.error) throw new Error(`内容视频预处理失败：${cvPathRaw}。原因：${cvPrep.error}`);
                if (cvPrep && cvPrep.framesDir) {
                    cvFramesDir = cvPrep.framesDir;
                    cvFrameCount = cvPrep.frameCount;
                    cvPreparedDuration = cvPrep.preparedDuration ?? duration;
                    cleanupDirs.push(cvFramesDir);
                }
            }
            if (!cvFramesDir || !(cvFrameCount > 0)) {
                throw new Error(`内容视频预处理失败：${contentVideoPath}。没有生成有效视频帧。`);
            }
            if (contentVideoBlurBg || contentVideoDirectBg) {
                let requiredDuration = Math.min(Number(duration), cvPreparedDuration);
                const ts = Number(contentVideoTrimStart);
                const te = Number(contentVideoTrimEnd);
                if (Number.isFinite(ts) && Number.isFinite(te) && te > ts) requiredDuration = Math.min(requiredDuration, te - ts);
                const requiredFrames = Math.max(1, Math.ceil(requiredDuration * fps) - 2);
                if (!cvFramesDir || cvFrameCount < requiredFrames) {
                    throw new Error(`内容背景帧数不足：需要约 ${requiredFrames} 帧，实际 ${cvFrameCount} 帧。为避免导出静帧，已停止导出，请检查内容视频或图片序列是否完整。`);
                }
            }
        }
        stats.prepare = performance.now() - tPrep;
        progress(20);

        // ═══ 阶段 2：硬件编码器 ═══
        const bitrate = window.ReelsTurboPlanner.turboBitrate({ crf, targetBitrateMbps, maxBitrateMbps }, params.turboBitrateFactor || 1.0);
        const picked = await _turboPickEncoderConfig({ width: targetWidth, height: targetHeight, fps, bitrate });
        log(`阶段2: WebCodecs ${picked.hardware ? '硬件' : '软件'}编码 ${picked.config.codec}，码率 ${(bitrate / 1e6).toFixed(1)}Mbps`);
        const begin = await _turboIpc('begin', {
            width: targetWidth, height: targetHeight, fps, outputPath,
            targetBitrateMbps: bitrate / 1e6, maxBitrateMbps,
            voicePath, voiceVolume, bgVolume,
            backgroundPath: isMultiClip ? bgAudioPath : backgroundPath,
            bgHasAudio: isMultiClip ? (!!bgAudioPath) : (!!backgroundPath && !(voicePath && voicePath === backgroundPath) && !_isImageFile(backgroundPath)),
            bgmPath: bgmPath || '', bgmVolume: bgmVolume || 0, bgmStart: Math.max(0, parseFloat(bgmStart) || 0),
            bgDurScale: bgDurScale || 100, audioDurScale: audioDurScale || 100,
            overlayAudioClips: window.ReelsPlaybackDelay?.audioClips(taskOverlays) || [],
            targetDuration: outputDuration, totalFrames,
            reverbEnabled, reverbPreset, reverbMix, stereoWidth, audioFxTarget, insertAudioClips,
            contentVideoPath: contentVideoPath || '', contentVideoVolume,
        });
        sessionId = begin.sessionId;
        h264Path = begin.h264Path;
        fd = require('fs').openSync(h264Path, 'w');
        enc = _turboCreateEncoder(picked.config, fd);
        const gop = Math.max(1, Math.round(fps * 2));
        const frameDurationUs = Math.round(1e6 / fps);

        // ═══ 阶段 3：逐帧绘制（与旧导出同一套绘制代码）═══
        const hasMask = !!style.global_mask_enabled;
        const maskColor = style.global_mask_color || '#000000';
        const maskOpacity = style.global_mask_opacity ?? 0.5;
        const bgSource = framesDir ? newSource('背景') : null;
        const cvSource = cvFramesDir ? newSource('内容视频') : null;
        const bgFramePath = (idx) => `${framesDir}/frame_${String(idx + 1).padStart(6, '0')}.${bgFrameExt}`;
        const cvFramePath = (idx) => (cvSeqFileList ? `${cvFramesDir}/${cvSeqFileList[idx]}` : `${cvFramesDir}/frame_${String(idx + 1).padStart(6, '0')}.png`);
        const sortedOverlays = (taskOverlays || []).filter(ov => !ov.disabled).slice()
            .sort((a, b) => (Number(a.z_index) || 0) - (Number(b.z_index) || 0));
        const lookahead = plan.prefetch;

        const overlayFramePath = (ov, t) => {
            const ovStart = parseFloat(ov.start || 0);
            const ovEnd = Number.isFinite(parseFloat(ov.end)) ? parseFloat(ov.end) : duration;
            if (t < ovStart || t > ovEnd) return null;
            let relTime = Math.max(0, t - ovStart);
            let prepared = null;
            if (ov.media_folder_files?.length) {
                const playback = window.ReelsOverlay.resolveFolderMedia(ov, t);
                prepared = ov._folderFramesByPath?.[playback.path] || null;
                relTime = playback.time;
            }
            relTime += Math.max(0, Number(ov.video_start_offset) || 0);
            const sourceRate = ov.is_img_sequence ? (Number(ov.fps) || 30) : fps;
            let frameIdxOv = Math.floor(relTime * sourceRate);
            if (ov.is_img_sequence && ov.sequence_frames && ov.sequence_frames.length > 0) {
                if (frameIdxOv >= ov.sequence_frames.length) {
                    frameIdxOv = ov.media_loop === false ? ov.sequence_frames.length - 1 : frameIdxOv % Math.max(1, ov.sequence_frames.length);
                }
                return ov.sequence_frames[frameIdxOv];
            }
            if (prepared || ov._framesDir) {
                const dir = prepared?.framesDir || ov._framesDir;
                const frameCount = prepared?.frameCount || ov._frameCount;
                if (!ov.media_folder_files?.length) {
                    frameIdxOv = Math.floor(window.ReelsOverlay.resolveVideoTime(ov, Math.max(0, t - ovStart), frameCount / sourceRate, 1 / sourceRate) * sourceRate + 1e-7);
                }
                if (frameIdxOv >= frameCount) {
                    frameIdxOv = ov.media_loop === false ? Math.max(0, frameCount - 1) : frameIdxOv % Math.max(1, frameCount);
                }
                return `${dir}/frame_${String(frameIdxOv + 1).padStart(6, '0')}.png`;
            }
            return null;
        };

        log('阶段3: GPU 画布逐帧绘制 + 硬件编码...');
        const t0 = performance.now();
        for (let frameIdx = 0; frameIdx < totalFrames; frameIdx++) {
            if (isCancelled && isCancelled()) throw new Error('__CANCELLED__');
            if (enc.state.error) throw new Error(`硬件编码失败：${enc.state.error.message || enc.state.error}`);
            const t = frameIdx / fps;
            const tWait = performance.now();

            // ── 取帧（并行解码 + 预读）──
            let currentCvImg = null;
            if (cvSource) {
                const idx = cvFrameCount > 0 ? frameIdx % cvFrameCount : frameIdx;
                const upcoming = [];
                for (let k = 1; k <= lookahead; k++) upcoming.push(cvFramePath(cvFrameCount > 0 ? (frameIdx + k) % cvFrameCount : frameIdx + k));
                currentCvImg = await cvSource.get(cvFramePath(idx), upcoming);
            }
            let currentBgImg = null;
            if (bgSource && !contentVideoBlurBg && !contentVideoDirectBg && totalBgFrames > 0) {
                const idx = Math.min(frameIdx, totalBgFrames - 1);
                const upcoming = [];
                for (let k = 1; k <= lookahead; k++) upcoming.push(bgFramePath(Math.min(frameIdx + k, totalBgFrames - 1)));
                currentBgImg = await bgSource.get(bgFramePath(idx), upcoming);
            }
            for (const ov of videoOverlays) {
                if (!ov._turboSource && !ov.is_img_sequence) continue;
                if (ov.is_img_sequence && !ov._turboSource) ov._turboSource = newSource(`序列 ${ov.name || ov.id}`);
                const fPath = overlayFramePath(ov, t);
                if (!fPath) { ov._currentFrameImage = null; continue; }
                const upcoming = [];
                for (let k = 1; k <= lookahead; k++) {
                    const next = overlayFramePath(ov, (frameIdx + k) / fps);
                    if (next) upcoming.push(next);
                }
                ov._currentFrameImage = await ov._turboSource.get(fPath, upcoming);
            }
            const tDraw = performance.now();
            stats.decodeWait += tDraw - tWait;

            // ── 背景 ──
            if (typeof ctx.reset === 'function') ctx.reset();
            else ctx.setTransform(1, 0, 0, 1, 0, 0);
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
                ctx.drawImage(currentBgImg, 0, 0, targetWidth, targetHeight);
            }

            if (hasMask) {
                ctx.save();
                ctx.globalAlpha = maskOpacity;
                ctx.fillStyle = maskColor;
                ctx.fillRect(0, 0, targetWidth, targetHeight);
                ctx.restore();
            }

            // ── 内容视频 ──
            if (contentVideoPath && currentCvImg && !contentVideoDirectBg) {
                const imgW = currentCvImg.naturalWidth || currentCvImg.width || targetWidth;
                const imgH = currentCvImg.naturalHeight || currentCvImg.height || targetHeight;
                const { cropX, cropY, cropW, cropH } = _parseCropString(contentVideoCrop);
                const sx = imgW * cropX;
                const sy = imgH * cropY;
                const sWidth = imgW * cropW;
                const sHeight = imgH * cropH;
                const finalScale = (targetWidth / sWidth) * ((contentVideoScale || 100) / 100);
                const drawW = sWidth * finalScale;
                const drawH = sHeight * finalScale;
                let drawX = (targetWidth - drawW) / 2;
                let drawY = (targetHeight - drawH) / 2;
                if (contentVideoX && contentVideoX !== 'center') {
                    const relX = parseFloat(contentVideoX);
                    if (!isNaN(relX)) drawX += Math.abs(relX) <= 1 ? targetWidth * relX : relX * targetWidth / 1080;
                }
                if (contentVideoY && contentVideoY !== 'center') {
                    const relY = parseFloat(contentVideoY);
                    if (!isNaN(relY)) drawY += Math.abs(relY) <= 1 ? targetHeight * relY : relY * targetHeight / 1920;
                }
                _drawImageFlipped(ctx, currentCvImg, sx, sy, sWidth, sHeight, drawX, drawY, drawW, drawH, contentVideoFlipH, contentVideoFlipV);
            }

            renderer.renderAmbientLightingBase?.(style, targetWidth, targetHeight);

            const renderSubtitle = () => {
                if (!showSubtitle) return;
                let activeSeg = segments.find(seg => t >= (seg.start || 0) && t <= (seg.end || 0));
                if (!activeSeg && (style.scrolling_mode || style.fullpage_typewriter) && segments.length > 0) {
                    let best = segments[0];
                    for (const seg of segments) if ((seg.start || 0) <= t) best = seg;
                    activeSeg = best;
                }
                if (activeSeg) {
                    renderer.setContextSegments(segments, originalScript);
                    renderer.setScrollTiming?.(uniformScrollTiming);
                    renderer.renderSubtitle(style, activeSeg, t, targetWidth, targetHeight);
                }
            };

            if (overlayAboveSubtitle) renderSubtitle();
            if (sortedOverlays.length > 0 && window.ReelsOverlay) {
                for (const ov of sortedOverlays) {
                    ov._allOverlays = taskOverlays;
                    const ovStart = parseFloat(ov.start || 0);
                    const ovEnd = parseFloat(ov.end || 9999);
                    if (t >= ovStart && (ov.type === 'scroll' || t <= ovEnd)) {
                        const origSelected = ov._selected;
                        try {
                            ov._selected = false;
                            ov._exporting = true;
                            ov._exportDuration = duration;
                            ReelsOverlay.drawOverlay(ctx, ov, t, targetWidth, targetHeight);
                        } finally {
                            ov._selected = origSelected;
                            delete ov._exporting;
                        }
                    }
                }
            }

            if (!overlayAboveSubtitle) renderSubtitle();
            if (typeof _drawWatermarks === 'function') _drawWatermarks(ctx, targetWidth, targetHeight);

            // ── GPU 画布 → 硬件编码（不读回像素）──
            const tEnc = performance.now();
            stats.draw += tEnc - tDraw;
            const frame = new VideoFrame(canvas, { timestamp: frameIdx * frameDurationUs, duration: frameDurationUs, alpha: 'discard' });
            enc.encoder.encode(frame, { keyFrame: frameIdx % gop === 0 });
            frame.close();
            await enc.waitQueue(4);
            stats.encodeWait += performance.now() - tEnc;

            if (frameIdx % Math.max(1, Math.floor(fps / 2)) === 0) {
                const pct = 20 + Math.round((frameIdx / totalFrames) * 70);
                progress(pct);
                const elapsed = (performance.now() - t0) / 1000;
                const fpsActual = (frameIdx + 1) / Math.max(0.1, elapsed);
                log(`帧 ${frameIdx + 1}/${totalFrames} (${pct}%) | ${fpsActual.toFixed(1)} fps | 剩余 ~${Math.ceil((totalFrames - frameIdx) / Math.max(0.1, fpsActual))}s`);
                await new Promise(r => setTimeout(r, 0));
            }
        }

        await enc.encoder.flush();
        if (enc.state.error) throw new Error(`硬件编码失败：${enc.state.error.message || enc.state.error}`);
        enc.encoder.close();
        require('fs').closeSync(fd);
        fd = null;
        const renderSeconds = (performance.now() - t0) / 1000;

        // ═══ 阶段 4：封装 + 音频混合（与旧导出相同的 mixAudio）═══
        log('阶段4: 封装视频与音频混合...');
        if (Number(maxBitrateMbps) > 0) log(`已设置最大码率 ${maxBitrateMbps} Mbps：使用 FFmpeg 限码率编码，此步骤会增加耗时。`);
        progress(92);
        const tFinish = performance.now();
        const result = await _turboIpc('finish', { sessionId, frameCount: enc.state.chunks, colorTags: params.turboColorTags || null });
        sessionId = null;
        stats.finish = performance.now() - tFinish;
        if (!result || result.error) throw new Error(result?.error || '新极速导出封装失败');

        await disposeAll();
        progress(100);
        const total = (performance.now() - tStart) / 1000;
        log(`⚡ 新极速导出完成 (${total.toFixed(1)}s，逐帧 ${(totalFrames / Math.max(0.01, renderSeconds)).toFixed(1)} fps): ${outputPath}`);
        log(`  用时分布：准备 ${(stats.prepare / 1000).toFixed(1)}s ｜ 等待解码 ${(stats.decodeWait / 1000).toFixed(1)}s ｜ 绘制 ${(stats.draw / 1000).toFixed(1)}s ｜ 编码排队 ${(stats.encodeWait / 1000).toFixed(1)}s ｜ 封装混音 ${(stats.finish / 1000).toFixed(1)}s`);
        return { output_path: result.output_path || outputPath, turboStats: { ...stats, total, renderSeconds } };
    } catch (error) {
        if (sessionId) { try { await _turboIpc('abort', { sessionId }); } catch (_) { } }
        await disposeAll();
        if (error && error.message === '__CANCELLED__') {
            log('导出已取消，资源已清理');
            return { cancelled: true };
        }
        throw error;
    }
}

if (typeof window !== 'undefined') {
    window.reelsTurboExport = reelsTurboExport;
}
