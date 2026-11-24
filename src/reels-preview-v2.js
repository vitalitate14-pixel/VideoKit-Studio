/**
 * reels-preview-v2.js - independent Batch Reels preview window.
 *
 * This module intentionally does not reuse the legacy preview media elements or
 * playback state. It reads the current task/style and renders into its own
 * canvas so it can evolve without destabilizing the original preview.
 */
(function () {
    'use strict';

    const PREVIEW_ID = 'reels-preview-v2-root';
    const BTN_ID = 'reels-preview-v2-open-btn';
    const DEFAULT_W = 1080;
    const DEFAULT_H = 1920;

    const state = {
        root: null,
        canvas: null,
        renderer: null,
        bgVideo: null,
        bgFadeVideo: null,
        audio: null,
        bgmAudio: null,
        contentVideo: null,
        hookVideo: null,
        hookAudio: null,
        coverVideo: null,
        bgImage: null,
        contentImage: null,
        coverImage: null,
        multiBgImages: new Map(),
        raf: null,
        isOpen: false,
        isPlaying: false,
        layoutEditing: false,
        previewSuspended:false,
        startedAt: 0,
        playbackSpeed: 1,
        pausedAt: 0,
        duration: 0,
        taskSig: '',
        bgSig: '',
        audioSig: '',
        bgmSig: '',
        contentSig: '',
        hookSig: '',
        coverSig: '',
        dragSeek: false,
        seekFrameLock: null,
        seekFrameToken: 0,
        queuedSeek: null,
        seekQueueTimer: null,
        lastSeekRequestAt: 0,
        legacyEls: [],
        resizeObserver: null,
        lastLegacyTime: null,
        viewScale: 1,
        panX: 0,
        panY: 0,
        panning: false,
        panStartX: 0,
        panStartY: 0,
        panOrigX: 0,
        panOrigY: 0,
        audioCtx: null,
        mediaSources: new Map(),
        gainNodes: new Map(),
        audioFxNodes: [],
        audioFxSig: '',
        recoveryTimer: null,
        recoveryAttempts: 0,
        recoveryInProgress: false,
        wasDocumentHidden: false,
    };
    const watermarkImageCache = new Map();
    const previewMediaAvailability = new Map();
    const REVERB_PRESETS = {
        room: { decay: 0.8, duration: 0.6 },
        hall: { decay: 2.0, duration: 1.5 },
        church: { decay: 4.0, duration: 3.0 },
        plate: { decay: 1.2, duration: 1.0 },
        echo: { decay: 1.5, duration: 0.8 },
    };

    function init() {
        injectStyles();
        installOpenButton();
        // V2 是默认预览；用户仍可通过工具栏按钮切回原预览。
        open();
    }

    function installOpenButton() {
        if (document.getElementById(BTN_ID)) return;

        const oldToolbarTitle = Array.from(document.querySelectorAll('#reels-col-preview span'))
            .find(el => String(el.textContent || '').includes('预览窗口'));
        const toolbar = oldToolbarTitle ? oldToolbarTitle.parentElement : null;

        const btn = document.createElement('button');
        btn.id = BTN_ID;
        btn.type = 'button';
        btn.className = 'btn btn-secondary';
        btn.textContent = '切到 V2';
        btn.title = '在当前预览区域切换新/旧预览';
        btn.addEventListener('click', toggleInlinePreview);

        if (toolbar) {
            btn.style.cssText = 'padding:2px 8px;font-size:10px;background:rgba(76,158,255,0.16);border:1px solid rgba(76,158,255,0.35);color:#9fc7ff;';
            const spacer = toolbar.querySelector('span[style*="flex:1"]');
            toolbar.insertBefore(btn, spacer || toolbar.children[1] || null);
        } else {
            btn.className = 'rpv2-floating-open';
            document.body.appendChild(btn);
        }
    }

    function injectStyles() {
        if (document.getElementById('reels-preview-v2-style')) return;
        const style = document.createElement('style');
        style.id = 'reels-preview-v2-style';
        style.textContent = `
            #${PREVIEW_ID} {
                display: none;
                flex: 1;
                min-height: 0;
                min-width: 0;
                width: 100%;
                max-width: 100%;
                box-sizing: border-box;
                background: #07090d;
                color: #e8edf7;
                font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                overflow: hidden;
            }
            #${PREVIEW_ID}.open { display: flex; flex-direction: column; }
            .rpv2-window {
                width: 100%;
                max-width: 100%;
                height: 100%;
                min-height: 0;
                min-width: 0;
                display: grid;
                grid-template-rows: minmax(0, 1fr) auto;
                background: #11151d;
                overflow: hidden;
            }
            .rpv2-controls {
                display: flex;
                align-items: center;
                flex-wrap: wrap;
                gap: 5px;
                min-width: 0;
                max-width: 100%;
                padding: 7px 8px;
                box-sizing: border-box;
                background: #171c26;
                border-top: 1px solid rgba(142,157,185,0.16);
                overflow: hidden;
            }
            .rpv2-stage-wrap {
                position: relative;
                min-width: 0;
                min-height: 0;
                display: grid;
                place-items: center;
                overflow: hidden;
                background: #07090d;
                cursor: grab;
            }
            .rpv2-stage-wrap.panning { cursor: grabbing; }
            .rpv2-stage {
                position: relative;
                width: 270px;
                height: 480px;
                max-width: calc(100% - 16px);
                max-height: calc(100% - 16px);
                aspect-ratio: 9 / 16;
                background: #000;
                box-shadow: 0 0 0 1px rgba(255,255,255,0.08), 0 18px 60px rgba(0,0,0,0.5);
                transform-origin: center center;
                will-change: transform;
            }
            .rpv2-stage canvas {
                width: 100%;
                height: 100%;
                display: block;
            }
            .rpv2-empty {
                position: absolute;
                inset: 0;
                display: none;
                align-items: center;
                justify-content: center;
                color: rgba(232,237,247,0.52);
                font-size: 13px;
                text-align: center;
                padding: 24px;
                pointer-events: none;
            }
            .rpv2-icon-btn {
                width: 28px;
                height: 28px;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                flex: 0 0 28px;
                border: 1px solid rgba(142,157,185,0.28);
                background: rgba(255,255,255,0.04);
                color: #e8edf7;
                border-radius: 5px;
                cursor: pointer;
                font-size: 13px;
            }
            .rpv2-icon-btn:hover { background: rgba(255,255,255,0.09); }
            .rpv2-icon-btn[data-action="snapshot-transparent"],
            .rpv2-icon-btn[data-action="layout"] {
                width: auto;
                flex: 0 0 auto;
                padding: 0 8px;
                white-space: nowrap;
                font-size: 11px;
            }
            .rpv2-controls .rpv2-check { white-space: nowrap; }
            .rpv2-pill {
                font-size: 10px;
                color: #8fb4ff;
                border: 1px solid rgba(143,180,255,0.3);
                background: rgba(143,180,255,0.08);
                padding: 2px 6px;
                border-radius: 4px;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
                flex: 1 1 150px;
                min-width: 90px;
                max-width: 240px;
            }
            .rpv2-time {
                flex: 0 0 88px;
                text-align: center;
                font: 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
                color: #b6c1d4;
            }
            .rpv2-seek {
                flex: 1 1 110px;
                min-width: 80px;
                max-width: 100%;
                accent-color: #6ea8ff;
            }
            .rpv2-zoom-label {
                width: 38px;
                text-align: center;
                font-size: 10px;
                color: #9aa8bd;
                font-variant-numeric: tabular-nums;
                flex: 0 0 38px;
            }
            .rpv2-check {
                display: inline-flex;
                align-items: center;
                gap: 5px;
                font-size: 11px;
                color: #b6c1d4;
                white-space: nowrap;
                flex: 0 0 auto;
            }
            @media (max-width: 520px) {
                .rpv2-check { display: none; }
                .rpv2-pill { flex-basis: 120px; max-width: 170px; }
                .rpv2-time { flex-basis: 82px; font-size: 10px; }
                .rpv2-seek { flex-basis: 90px; }
            }
            .rpv2-media {
                position: absolute;
                left: 0;
                top: 0;
                width: 2px;
                height: 2px;
                /* Chromium may suspend a fully transparent video decoder. */
                opacity: 0.002;
                pointer-events: none;
            }
            .rpv2-floating-open {
                position: fixed;
                right: 18px;
                bottom: 18px;
                z-index: 9990;
                padding: 7px 10px;
                border: 1px solid rgba(76,158,255,0.4);
                background: #162033;
                color: #cfe0ff;
                border-radius: 6px;
                cursor: pointer;
            }
        `;
        document.head.appendChild(style);
    }

    function ensureDom() {
        if (state.root) return state.root;

        const root = document.createElement('div');
        root.id = PREVIEW_ID;
        root.innerHTML = `
            <div class="rpv2-window" aria-label="V2 预览">
                <div class="rpv2-stage-wrap">
                    <div class="rpv2-stage" data-role="stage">
                        <canvas data-role="canvas"></canvas>
                        <div class="rpv2-empty" data-role="empty">请选择一个 Reels 任务</div>
                    </div>
                    <video class="rpv2-media" data-role="bg-video" playsinline preload="auto"></video>
                    <video class="rpv2-media" data-role="bg-fade-video" playsinline preload="auto"></video>
                    <video class="rpv2-media" data-role="content-video" playsinline preload="auto"></video>
                    <video class="rpv2-media" data-role="hook-video" playsinline preload="auto"></video>
                    <video class="rpv2-media" data-role="hook-audio" playsinline preload="auto"></video>
                    <video class="rpv2-media" data-role="cover-video" playsinline preload="auto" muted></video>
                    <audio class="rpv2-media" data-role="audio" preload="metadata"></audio>
                    <audio class="rpv2-media" data-role="bgm-audio" preload="metadata"></audio>
                </div>
                <div class="rpv2-controls">
                    <span class="rpv2-pill" data-role="title">V2 预览</span>
                    <button class="rpv2-icon-btn" data-action="play" title="播放/暂停">▶</button>
                    <div class="rpv2-time" data-role="time">00:00/00:00</div>
                    <input class="rpv2-seek" data-role="seek" type="range" min="0" max="1000" value="0" step="1">
                    <label class="rpv2-check" title="循环播放"><input data-role="loop" type="checkbox" checked>循环</label>
                    <label class="rpv2-check" title="预览与导出字幕总开关：关闭后，导出的视频也不会带字幕"><input data-role="subs" type="checkbox" checked>字幕(关闭=导出不带)</label>
                    <label class="rpv2-check" title="仅显示/隐藏字幕区域辅助线，不影响导出"><input data-role="subtitle-guides" type="checkbox" checked>字幕辅助线</label>
                    <label class="rpv2-check" title="仅在预览中显示/隐藏覆层，不改变导出设置"><input data-role="overlays" type="checkbox" checked>覆层(预览)</label>
                    <button class="rpv2-icon-btn" data-action="fit" title="适应窗口">适</button>
                    <button class="rpv2-icon-btn" data-action="zoom-out" title="缩小">−</button>
                    <span class="rpv2-zoom-label" data-role="zoom-label">100%</span>
                    <button class="rpv2-icon-btn" data-action="zoom-in" title="放大">+</button>
                    <button class="rpv2-icon-btn" data-action="zoom-reset" title="1:1">1:1</button>
                    <button class="rpv2-icon-btn" data-action="snapshot" title="保存当前合成画面为 PNG">📸</button>
                    <button class="rpv2-icon-btn" data-action="snapshot-transparent" title="导出当前单帧透明 PNG（覆层、字幕、水印；不含背景与插入视频）">透明 PNG</button>
                    <button class="rpv2-icon-btn" data-action="layout" title="调整当前任务的讲道、观众分割布局">📐 布局</button><button class="rpv2-icon-btn" data-action="refresh" title="重新加载当前任务">↻</button>
                </div>
            </div>
        `;
        mountInlineRoot(root);

        state.root = root;
        state.canvas = root.querySelector('[data-role="canvas"]');
        state.bgVideo = root.querySelector('[data-role="bg-video"]');
        state.bgFadeVideo = root.querySelector('[data-role="bg-fade-video"]');
        state.audio = root.querySelector('[data-role="audio"]');
        state.bgmAudio = root.querySelector('[data-role="bgm-audio"]');
        state.contentVideo = root.querySelector('[data-role="content-video"]');
        state.hookVideo = root.querySelector('[data-role="hook-video"]');
        state.hookAudio = root.querySelector('[data-role="hook-audio"]');
        state.coverVideo = root.querySelector('[data-role="cover-video"]');
        // Custom local-media URLs are cross-origin too. CORS must be enabled
        // before src so decoded frames remain usable for canvas snapshots.
        root.querySelectorAll('video,audio').forEach(media => { media.crossOrigin = 'anonymous'; });

        // Many overview players share the same disk/network. Fetch metadata and
        // the requested frame, rather than buffering every complete soundtrack.
        if (window.__reelsOverviewCard) {
            root.querySelectorAll('video').forEach(media => { media.preload = 'auto'; });
            root.querySelectorAll('audio').forEach(media => { media.preload = 'metadata'; });
        }

        state.canvas.width = getTargetWidth();
        state.canvas.height = getTargetHeight();
        state.renderer = window.ReelsCanvasRenderer ? new window.ReelsCanvasRenderer(state.canvas) : null;

        root.querySelector('[data-action="refresh"]').addEventListener('click', () => recoverMedia('manual-refresh', true));
        root.querySelector('[data-action="fit"]').addEventListener('click', () => fitStage(true));
        root.querySelector('[data-action="zoom-in"]').addEventListener('click', () => zoomView(1.25));
        root.querySelector('[data-action="zoom-out"]').addEventListener('click', () => zoomView(0.8));
        root.querySelector('[data-action="zoom-reset"]').addEventListener('click', resetZoomOneToOne);
        // 用 onclick 覆盖式绑定，避免预览根节点重挂载后留下旧监听器；点击后
        // 立即给出按钮状态，不能再出现“点了毫无反应”。
        root.querySelector('[data-action="layout"]').onclick = () => {
            if (state.isPlaying) togglePlay();
            state.layoutEditing = !state.layoutEditing;
            syncInlineLayout();
        };
        const snapshotBtn = root.querySelector('[data-action="snapshot"]');
        if (snapshotBtn) snapshotBtn.onclick = event => { event.preventDefault(); captureCurrentFrame(snapshotBtn); };
        const transparentSnapshotBtn = root.querySelector('[data-action="snapshot-transparent"]');
        if (transparentSnapshotBtn) transparentSnapshotBtn.onclick = event => { event.preventDefault(); captureCurrentFrame(transparentSnapshotBtn, true); };
        root.querySelector('[data-action="play"]').addEventListener('click', togglePlay);
        const subtitleToggle = root.querySelector('[data-role="subs"]');
        const exportSubtitleToggle = document.getElementById('reels-subtitle-toggle');
        if (subtitleToggle && exportSubtitleToggle) subtitleToggle.checked = exportSubtitleToggle.checked;
        subtitleToggle?.addEventListener('change', () => {
            if (exportSubtitleToggle) exportSubtitleToggle.checked = subtitleToggle.checked;
            if (typeof window.reelsOnSubtitleToggleChange === 'function') {
                window.reelsOnSubtitleToggleChange(exportSubtitleToggle || subtitleToggle);
            }
            render();
        });
        const guideToggle = root.querySelector('[data-role="subtitle-guides"]');
        const rangeToggle = document.getElementById('reels-show-subtitle-range');
        if (guideToggle && rangeToggle) guideToggle.checked = rangeToggle.checked;
        guideToggle?.addEventListener('change', () => {
            if (rangeToggle) rangeToggle.checked = guideToggle.checked;
            render();
        });
        rangeToggle?.addEventListener('change', () => {
            if (guideToggle) guideToggle.checked = rangeToggle.checked;
            render();
        });
        root.querySelector('[data-role="seek"]').addEventListener('input', onSeekInput);
        root.querySelector('[data-role="seek"]').addEventListener('pointerdown', () => { state.dragSeek = true; });
        root.querySelector('[data-role="seek"]').addEventListener('pointerup', () => { state.dragSeek = false; });
        root.querySelector('[data-role="loop"]').addEventListener('change', syncLoopFlags);
        setupPanZoomHandlers();
        setupFitObserver();

        for (const media of [state.bgVideo, state.bgFadeVideo, state.audio, state.bgmAudio, state.contentVideo, state.hookVideo, state.hookAudio, state.coverVideo]) {
            media.addEventListener('loadedmetadata', () => {
                if ((media === state.bgVideo || media === state.bgFadeVideo) && media.dataset.multiPath && media.duration > 0) {
                    const rs = window._reelsState;
                    if (rs) {
                        if (!rs._multiBgDurations) rs._multiBgDurations = {};
                        rs._multiBgDurations[media.dataset.multiPath] = media.duration;
                    }
                }
                state.duration = computeDuration();
                syncMediaToTime(getCurrentTime());
                render();
            });
            media.addEventListener('seeked', () => releaseSeekFrameWhenReady());
            media.addEventListener('loadeddata', () => markMediaHealthy());
            media.addEventListener('canplay', () => {
                markMediaHealthy();
                releaseSeekFrameWhenReady();
            });
            if (media.tagName === 'VIDEO') {
                media.addEventListener('error', () => {
                    const requestedSource = media.getAttribute('src');
                    if (!state.isOpen || !requestedSource || !media.error) return;
                    // 文件不存在、编码不支持时，反复重新加载同一来源不会恢复，
                    // 只会制造三轮错误并掩盖真正的媒体路径。保留可诊断信息，
                    // 让用户修正素材后使用 ↻ 手动重载。
                    const code = media.error?.code || 0;
                    const source = media.currentSrc || media.getAttribute('src') || '(空来源)';
                    console.error(`[PreviewV2] ${media.dataset.role || 'video'} 无法读取 (code ${code}): ${source}`);
                    const title = state.root?.querySelector('[data-role="title"]');
                    if (title) title.textContent = `视频无法读取（${media.dataset.role || 'video'}），请检查文件后点 ↻`;
                });
                media.addEventListener('stalled', () => scheduleMediaRecovery(`stalled:${media.dataset.role || 'video'}`, false, 900));
            }
            media.addEventListener('ended', onMediaEnded);
        }

        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                state.wasDocumentHidden = true;
                return;
            }
            if (state.wasDocumentHidden) {
                state.wasDocumentHidden = false;
                scheduleMediaRecovery('window-visible', false, 120);
            }
        });
        window.addEventListener('focus', () => {
            if (!document.hidden) scheduleMediaRecovery('window-focus', false, 120);
        });

        document.addEventListener('keydown', (e) => {
            if (!state.isOpen) return;
            if (e.key === 'Escape') close();
            if (e.key === ' ' && !isEditable(e.target)) {
                e.preventDefault();
                togglePlay();
            }
        });

        return root;
    }

    function mountInlineRoot(root) {
        const viewport = document.getElementById('reels-preview-viewport');
        const host = viewport && viewport.parentElement ? viewport.parentElement : document.body;
        if (viewport && viewport.nextSibling) {
            host.insertBefore(root, viewport.nextSibling);
        } else {
            host.appendChild(root);
        }
        state.legacyEls = [
            document.getElementById('reels-preview-viewport'),
            document.getElementById('reels-preview-play')?.closest('div'),
            document.getElementById('reels-preview-text'),
            ...getLegacyToolbarZoomEls(),
        ].filter(Boolean);
    }

    function toggleInlinePreview() {
        if (state.isOpen) close();
        else open();
    }

    function open() {
        ensureDom();
        setLegacyVisible(false);
        state.root.classList.add('open');
        state.isOpen = true;
        updateModeButton();
        queueFitStage();
        loadCurrentTask(true);
        startLoop();
    }

    function close() {
        state.isOpen = false;
        clearTimeout(state.recoveryTimer);
        state.recoveryTimer = null;
        state.recoveryInProgress = false;
        clearTimeout(state.seekQueueTimer);
        state.seekQueueTimer=null;state.queuedSeek=null;state.seekFrameLock=null;
        state.root?.classList.remove('open');
        setLegacyVisible(true);
        pauseMedia();
        disconnectAudioGraph();
        state.isPlaying = false;
        if (state.raf) cancelAnimationFrame(state.raf);
        state.raf = null;
        updatePlayButton();
        updateModeButton();
    }

    function setupFitObserver() {
        if (state.resizeObserver || typeof ResizeObserver === 'undefined') return;
        const wrap = state.root?.querySelector('.rpv2-stage-wrap');
        if (!wrap) return;
        state.resizeObserver = new ResizeObserver(() => fitStage());
        state.resizeObserver.observe(wrap);
        window.addEventListener('resize', queueFitStage);
    }

    function setLegacyVisible(visible) {
        if (!state.legacyEls.length) {
            state.legacyEls = [
                document.getElementById('reels-preview-viewport'),
                document.getElementById('reels-preview-play')?.closest('div'),
                document.getElementById('reels-preview-text'),
                ...getLegacyToolbarZoomEls(),
            ].filter(Boolean);
        }
        for (const el of state.legacyEls) {
            if (!el) continue;
            if (visible) {
                const previous = el.dataset.rpv2PreviousDisplay;
                el.style.display = previous || '';
                delete el.dataset.rpv2PreviousDisplay;
            } else {
                if (el.dataset.rpv2PreviousDisplay === undefined) {
                    el.dataset.rpv2PreviousDisplay = el.style.display || '';
                }
                el.style.display = 'none';
            }
        }
    }

    function getLegacyToolbarZoomEls() {
        const root = document.getElementById('reels-col-preview');
        if (!root) return [];
        return Array.from(root.querySelectorAll('#reels-preview-zoom-label, button[onclick^="reelsPreviewZoom"]'));
    }

    function updateModeButton() {
        const btn = document.getElementById(BTN_ID);
        if (!btn) return;
        btn.textContent = state.isOpen ? '切回原预览' : '切到 V2';
        btn.title = state.isOpen ? '切回原来的预览窗口' : '切换到新的 V2 预览';
    }

    function startLoop() {
        if (!state.isOpen || state.previewSuspended) return;
        if (state.raf) cancelAnimationFrame(state.raf);
        let lastOverviewFrame = 0;
        const tick = (now) => {
            if (!state.isOpen || state.previewSuspended) return;
            if (document.hidden || !state.root?.getClientRects().length) {
                state.raf = requestAnimationFrame(tick);
                return;
            }
            // Overview cards seek explicitly during hover/scrubbing. Their idle
            // refresh only needs to catch decoded media and asynchronously loaded fonts.
            if (!state.isPlaying && !state.seekFrameLock && (window.ReelsPreviewEdit?.isDragging?.() || now - lastOverviewFrame < (window.__reelsOverviewCard ? 1000 : 100))) {
                state.raf = requestAnimationFrame(tick);
                return;
            }
            lastOverviewFrame = now;
            loadCurrentTask(false);
            render();
            state.raf = requestAnimationFrame(tick);
        };
        state.raf = requestAnimationFrame(tick);
    }

    function syncInlineLayout() {
        const stage = state.root?.querySelector('[data-role="stage"]');
        if (!stage) return;
        window.ReelsLayoutEditor?.stopInlineLayout?.(stage);
        if (state.layoutEditing) window.ReelsLayoutEditor?.toggleInlineLayout(stage, getTask(),
            () => { loadCurrentTask(false); render(); }, null, { hideTools: true });
        const button = state.root.querySelector('[data-action="layout"]');
        if (button) {
            button.textContent = state.layoutEditing ? '✓ 布局编辑已开启' : '📐 布局';
            button.setAttribute('aria-pressed', String(state.layoutEditing));
        }
    }

    function loadCurrentTask(force) {
        const task = getTask();
        if(!window.__reelsOverviewCard) window.ReelsPreviewEdit?.attach(state.root,task);
        const sig = makeTaskSignature(task);
        if (!force && sig === state.taskSig) return;
        const layoutTaskChanged = state.layoutTask !== task;
        state.layoutTask = task;
        if (layoutTaskChanged) syncInlineLayout();

        const mediaOwner = [getSelectedIndex(), task?.id || '', task?.fileName || '', task?.audioPath || ''].join('|');
        const recoverySourceKey = [mediaOwner, getBackgroundPath(task), task?.contentVideoPath || '',
            task?.cover?.bgPath || '', getHookPath(task)].join('|');
        if (state.recoverySourceKey !== recoverySourceKey) {
            clearTimeout(state.recoveryTimer);
            state.recoveryTimer = null;
            state.recoveryAttempts = 0;
            state.recoveryInProgress = false;
            state.recoverySourceKey = recoverySourceKey;
        }
        if (state.mediaOwner !== undefined && state.mediaOwner !== mediaOwner) window.ReelsOverlay?.disposePreviewMedia?.();
        state.mediaOwner = mediaOwner;
        state.taskSig = sig;
        if (window.__reelsOverviewCard) state.pausedAt = getCurrentTime();
        state.duration = computeDuration();
        state.pausedAt = Math.min(state.pausedAt || 0, Math.max(0, state.duration || 0));
        updateTitle(task);
        resizeCanvas();
        loadBackground(task, force);
        loadAudio(task, force);
        loadBgm(task, force);
        loadContent(task, force);
        loadHook(task, force);
        loadCover(task, force);
        const failure = currentVisualFailure();
        if (failure) showMediaRecoveryFailure(failure);
        applyAudioVolumes(task);
        syncLoopFlags();
        syncMediaToTime(state.pausedAt || 0);
        render();
    }

    function mediaHasDecodedFrame(media) {
        return !!(media && media.src && media.readyState >= 2 && media.videoWidth > 0 && media.videoHeight > 0);
    }

    function imageHasDecodedFrame(image) {
        return !!(image && image.complete && image.naturalWidth > 0 && image.naturalHeight > 0);
    }

    function currentVisualIsReady() {
        const task = getTask();
        if (!task) return true;
        const phase = getPhaseInfo(getCurrentTime(), task);
        const coverPath = task.cover && task.cover.enabled ? task.cover.bgPath : '';
        if (phase.inCover && coverPath) {
            return isImagePath(coverPath) ? imageHasDecodedFrame(state.coverImage) : mediaHasDecodedFrame(state.coverVideo);
        }
        const hookPath = getHookPath(task);
        if (phase.inHook && hookPath) return mediaHasDecodedFrame(state.hookVideo);

        const bgPath = getBackgroundPath(task);
        if (bgPath) {
            if (isImagePath(bgPath)) return imageHasDecodedFrame(state.bgImage);
            if (isMultiBackgroundTask(task)) {
                if (mediaHasDecodedFrame(state.bgVideo) || mediaHasDecodedFrame(state.bgFadeVideo)) return true;
                for (const image of state.multiBgImages.values()) {
                    if (imageHasDecodedFrame(image)) return true;
                }
                return false;
            }
            return mediaHasDecodedFrame(state.bgVideo);
        }

        const contentPath = task.contentVideoPath || '';
        if (contentPath) {
            return isImagePath(contentPath)
                ? imageHasDecodedFrame(state.contentImage)
                : mediaHasDecodedFrame(state.contentVideo);
        }
        return true;
    }

    function isPreviewMediaAvailable(path) {
        if (!path) return false;
        if (previewMediaAvailability.has(path)) return previewMediaAvailability.get(path);
        if (typeof window.electronAPI?.fileExists !== 'function') return true;
        try {
            const exists = window.electronAPI.fileExists(path);
            if (typeof exists !== 'boolean') return true;
            previewMediaAvailability.set(path, exists);
            return exists;
        } catch (_) { return true; }
    }

    function currentVisualMedia() {
        const task = getTask();
        if (!task) return [];
        const phase = getPhaseInfo(getCurrentTime(), task);
        if (phase.inCover && task.cover?.enabled && task.cover.bgPath) {
            return isImagePath(task.cover.bgPath) ? [] : [state.coverVideo];
        }
        const hookPath = getHookPath(task);
        if (phase.inHook && hookPath) return [state.hookVideo];
        const bgPath = getBackgroundPath(task);
        if (bgPath) {
            if (isImagePath(bgPath)) return [];
            return isMultiBackgroundTask(task) ? [state.bgVideo, state.bgFadeVideo] : [state.bgVideo];
        }
        return task.contentVideoPath && !isImagePath(task.contentVideoPath) ? [state.contentVideo] : [];
    }

    function currentVisualFailure() {
        const task = getTask();
        if (!task) return null;
        const phase = getPhaseInfo(getCurrentTime(), task);
        const cover = phase.inCover && task?.cover?.enabled && task.cover.bgPath;
        const hook = phase.inHook && getHookPath(task);
        const background = getBackgroundPath(task);
        const path = cover || hook || background || task?.contentVideoPath;
        if (path && previewMediaAvailability.get(path) === false) {
            return {role:cover ? '封面' : hook ? '前置视频' : background ? '背景' : '内容视频', code:'missing', source:path};
        }
        const media = currentVisualMedia().find(media => media?.getAttribute('src') && [3, 4].includes(media.error?.code));
        if (!media) return null;
        return {role:media.dataset?.role || 'video', code:media.error.code,
            source:media.currentSrc || media.getAttribute('src')};
    }

    function showMediaRecoveryFailure(failure) {
        const title = state.root?.querySelector('[data-role="title"]');
        if (title) {
            title.textContent = failure.code === 'missing'
                ? `${failure.role}素材缺失，已跳过` : `视频无法读取（${failure.role}，code ${failure.code}），请检查素材后点 ↻`;
            title.title = failure.source;
        }
    }

    function isComposedPreviewReady() {
        if (state.seekFrameLock) return false;
        if (!currentVisualIsReady() && !currentVisualFailure()) return false;
        const task = getTask();
        if (!task) return true;
        const phase = getPhaseInfo(getCurrentTime(), task);
        const overlays = phase.inCover ? task.cover?.overlays || [] : phase.inHook ? [] : getLiveOverlays(task);
        const time = phase.inCover ? phase.time : phase.mainTime;
        const overlay = window.ReelsOverlay;
        const settled = overlay?.isPreviewMediaSettled || overlay?.isPreviewMediaReady;
        return !settled || overlays.every(ov => settled(ov, time));
    }

    function markMediaHealthy() {
        if (!currentVisualIsReady()) return;
        state.recoveryAttempts = 0;
        state.recoveryInProgress = false;
        if (state.recoveryTimer) clearTimeout(state.recoveryTimer);
        state.recoveryTimer = null;
        updateTitle(getTask());
        render();
    }

    function scheduleMediaRecovery(reason, force = false, delay = 250) {
        if (!state.isOpen || !getTask() || document.hidden || state.previewSuspended) return;
        if (!force && currentVisualIsReady()) return;
        const failure = currentVisualFailure();
        if (!force && failure) { showMediaRecoveryFailure(failure); return; }
        // A manual refresh, completed import, or foreground restore starts a
        // fresh bounded recovery cycle. Verification retries use force=false.
        if (force && !state.recoveryInProgress) state.recoveryAttempts = 0;
        if (state.recoveryTimer) clearTimeout(state.recoveryTimer);
        const task = getTask();
        state.recoveryTimer = setTimeout(() => {
            state.recoveryTimer = null;
            if (getTask() !== task) return;
            recoverMedia(reason, force);
        }, delay);
    }

    function recoverMedia(reason, force = false) {
        if (!state.isOpen || !getTask() || document.hidden || state.previewSuspended || state.recoveryInProgress) return;
        if (reason === 'manual-refresh') {
            previewMediaAvailability.clear();
            window.ReelsOverlay?.disposePreviewMedia?.();
            state.recoveryAttempts = 0;
        }
        if (!force && currentVisualIsReady()) return;
        const failure = currentVisualFailure();
        if (!force && failure) { showMediaRecoveryFailure(failure); return; }
        if (state.recoveryAttempts >= 3) {
            console.error(`[PreviewV2] media recovery stopped after 3 attempts (${reason})`, {
                task:getTask()?.fileName || getTask()?.baseName,
                background:getBackgroundPath(getTask()),
                media:currentVisualMedia().map(media => ({source:media?.currentSrc || media?.getAttribute('src'),
                    readyState:media?.readyState, networkState:media?.networkState, code:media?.error?.code || 0})),
            });
            const title = state.root?.querySelector('[data-role="title"]');
            if (title) title.textContent = '预览加载失败，请检查素材后点 ↻';
            return;
        }

        const resumeAt = getCurrentTime();
        const wasPlaying = state.isPlaying;
        state.recoveryAttempts += 1;
        state.recoveryInProgress = true;
        const title = state.root?.querySelector('[data-role="title"]');
        if (title) title.textContent = `正在恢复视频… (${state.recoveryAttempts}/3)`;
        console.warn(`[PreviewV2] reloading media (${reason}), attempt ${state.recoveryAttempts}`);

        loadCurrentTask(true);
        state.pausedAt = resumeAt;
        if (wasPlaying) state.startedAt = performance.now() / 1000 - resumeAt / state.playbackSpeed;
        syncMediaToTime(resumeAt);
        state.recoveryInProgress = false;

        const task = getTask(), verifyStarted = performance.now();
        const verify = () => {
            state.recoveryTimer = null;
            if (getTask() !== task || !state.isOpen || state.previewSuspended || document.hidden) return;
            if (currentVisualIsReady()) markMediaHealthy();
            else {
                const loading = currentVisualMedia().some(media => media?.networkState === 2 && !media.error);
                // A slow read from an external disk needs time to produce its
                // first frame; restarting it every 1.4 seconds prevents that.
                if (loading && performance.now() - verifyStarted < 8000) {
                    state.recoveryTimer = setTimeout(verify, 1400);
                } else recoverMedia(`${reason}:verify`, false);
            }
        };
        state.recoveryTimer = setTimeout(verify, 1400);
    }

    function resizeCanvas() {
        const w = getTargetWidth();
        const h = getTargetHeight();
        if (state.canvas.width !== w || state.canvas.height !== h) {
            state.canvas.width = w;
            state.canvas.height = h;
            if (window.ReelsCanvasRenderer) {
                state.renderer = new window.ReelsCanvasRenderer(state.canvas);
            }
            const stage = state.root.querySelector('[data-role="stage"]');
            if (stage) stage.style.aspectRatio = `${w} / ${h}`;
        }
        queueFitStage();
    }

    function queueFitStage() {
        requestAnimationFrame(() => {
            fitStage(false);
            requestAnimationFrame(() => fitStage(false));
        });
    }

    function fitStage(resetView = false) {
        if (!state.root || !state.isOpen) return;
        const wrap = state.root.querySelector('.rpv2-stage-wrap');
        const stage = state.root.querySelector('[data-role="stage"]');
        if (!wrap || !stage) return;

        const rect = wrap.getBoundingClientRect();
        if (rect.width < 40 || rect.height < 40) {
            requestAnimationFrame(fitStage);
            return;
        }
        const inset = window.__reelsOverviewCard ? 0 : 12;
        const availableW = Math.max(80, rect.width - inset);
        const availableH = Math.max(80, rect.height - inset);
        const targetW = getTargetWidth();
        const targetH = getTargetHeight();
        const aspect = targetW > 0 && targetH > 0 ? targetW / targetH : DEFAULT_W / DEFAULT_H;

        let stageW = availableW;
        let stageH = stageW / aspect;
        if (stageH > availableH) {
            stageH = availableH;
            stageW = stageH * aspect;
        }

        stage.style.width = `${Math.max(60, Math.floor(stageW))}px`;
        stage.style.height = `${Math.max(60, Math.floor(stageH))}px`;
        stage.style.aspectRatio = `${targetW} / ${targetH}`;
        if (resetView) {
            state.viewScale = 1;
            state.panX = 0;
            state.panY = 0;
        }
        applyViewTransform();
    }

    function setupPanZoomHandlers() {
        const wrap = state.root?.querySelector('.rpv2-stage-wrap');
        if (!wrap || wrap.dataset.rpv2PanZoomBound === '1') return;
        wrap.dataset.rpv2PanZoomBound = '1';

        wrap.addEventListener('wheel', (e) => {
            e.preventDefault();
            const factor = e.deltaY > 0 ? 0.9 : 1.1;
            zoomView(factor);
        }, { passive: false });

        wrap.addEventListener('mousedown', (e) => {
            if (e.button !== 0 || e.target.closest('.rto-edit-layer')) return;
            state.panning = true;
            state.panStartX = e.clientX;
            state.panStartY = e.clientY;
            state.panOrigX = state.panX;
            state.panOrigY = state.panY;
            wrap.classList.add('panning');
            e.preventDefault();
        });

        window.addEventListener('mousemove', (e) => {
            if (!state.panning) return;
            state.panX = state.panOrigX + (e.clientX - state.panStartX);
            state.panY = state.panOrigY + (e.clientY - state.panStartY);
            applyViewTransform();
        });

        window.addEventListener('mouseup', () => {
            if (!state.panning) return;
            state.panning = false;
            wrap.classList.remove('panning');
        });
    }

    function zoomView(factor) {
        state.viewScale = clamp(state.viewScale * factor, 0.1, 5);
        applyViewTransform();
    }

    function resetZoomOneToOne() {
        state.viewScale = 1;
        state.panX = 0;
        state.panY = 0;
        applyViewTransform();
    }

    function applyViewTransform() {
        const stage = state.root?.querySelector('[data-role="stage"]');
        if (stage) {
            stage.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.viewScale})`;
        }
        const label = state.root?.querySelector('[data-role="zoom-label"]');
        if (label) label.textContent = `${Math.round(state.viewScale * 100)}%`;
    }

    function loadBackground(task, force) {
        const bgPath = getBackgroundPath(task);
        const sig = `${bgPath || ''}`;
        if (!force && sig === state.bgSig) return;
        state.bgSig = sig;
        state.bgImage = null;
        state.bgVideo.pause();
        state.bgFadeVideo.pause();
        state.bgVideo.removeAttribute('src');
        state.bgFadeVideo.removeAttribute('src');

        if (!bgPath || !isPreviewMediaAvailable(bgPath)) return;
        const url = toPlayablePath(bgPath);
        if (isImagePath(bgPath)) {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => {
                if (state.bgSig === sig) state.bgImage = img;
                render();
            };
            img.onerror = () => render();
            img.src = url;
        } else {
            state.bgVideo.src = url;
            state.bgVideo.load();
        }
    }

    function loadAudio(task, force) {
        const audioPath = task && task.audioPath ? task.audioPath : '';
        const sig = audioPath;
        if (!force && sig === state.audioSig) return;
        state.audioSig = sig;
        state.audio.pause();
        state.audio.removeAttribute('src');
        if (audioPath && isPreviewMediaAvailable(audioPath)) {
            state.audio.src = toPlayablePath(audioPath);
            state.audio.load();
        }
    }

    function loadBgm(task, force) {
        const bgmPath = getBgmPath(task);
        const sig = bgmPath || '';
        if (!force && sig === state.bgmSig) return;
        state.bgmSig = sig;
        state.bgmAudio.pause();
        state.bgmAudio.removeAttribute('src');
        if (bgmPath && isPreviewMediaAvailable(bgmPath)) {
            state.bgmAudio.src = toPlayablePath(bgmPath);
        }
        // Reset the decoded resource even when clearing the source.
        state.bgmAudio.load();
    }

    function loadContent(task, force) {
        const contentPath = task && task.contentVideoPath ? task.contentVideoPath : '';
        const sig = contentPath;
        if (!force && sig === state.contentSig) return;
        state.contentSig = sig;
        state.contentImage = null;
        state.contentVideo.pause();
        state.contentVideo.removeAttribute('src');

        if (!contentPath || !isPreviewMediaAvailable(contentPath)) return;
        const url = toPlayablePath(contentPath);
        if (isImagePath(contentPath)) {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => {
                if (state.contentSig === sig) state.contentImage = img;
                render();
            };
            img.src = url;
        } else {
            state.contentVideo.src = url;
            state.contentVideo.load();
        }
    }

    function loadHook(task, force) {
        const hookPath = getHookPath(task);
        const hookAudioPath = getHookAudioPath(task);
        const sig = [
            hookPath || '',
            task && task.hookDurationMode || '',
            task && task.hookTrimStart != null ? task.hookTrimStart : '',
            task && task.hookTrimEnd != null ? task.hookTrimEnd : '',
            task && task.hookSpeed != null ? task.hookSpeed : '',
            task && task.hookKeepAudio === false ? '0' : '1',
            task && task.hookVolume != null ? task.hookVolume : '100',
            hookAudioPath || '',
            task && task.hookAudioTrimStart != null ? task.hookAudioTrimStart : '',
            task && task.hookAudioTrimEnd != null ? task.hookAudioTrimEnd : '',
            task && task.hookAudioVolume != null ? task.hookAudioVolume : '100',
        ].join('|');
        if (!force && sig === state.hookSig) return;
        state.hookSig = sig;
        state.hookVideo.pause();
        state.hookVideo.removeAttribute('src');
        const validHookVideo = hookPath && isPreviewMediaAvailable(hookPath)
            && (!window.ReelsHookUtils || window.ReelsHookUtils.isSupportedHookVideoPath(hookPath));
        if (validHookVideo) {
            state.hookVideo.src = toPlayablePath(hookPath);
            state.hookVideo.playbackRate = Math.max(0.1, numberOr(task && task.hookSpeed, 1));
            state.hookVideo.load();
        }
        if (state.hookAudio) {
            state.hookAudio.pause();
            state.hookAudio.removeAttribute('src');
            if (hookAudioPath && isPreviewMediaAvailable(hookAudioPath)) {
                state.hookAudio.src = toPlayablePath(hookAudioPath);
                state.hookAudio.playbackRate = state.playbackSpeed || 1;
                state.hookAudio.load();
            }
        }
        applyAudioVolumes(task);
    }

    function loadCover(task, force) {
        const coverPath = task && task.cover && task.cover.enabled && task.cover.bgPath ? task.cover.bgPath : '';
        const sig = coverPath || '';
        if (!force && sig === state.coverSig) return;
        state.coverSig = sig;
        state.coverImage = null;
        state.coverVideo.pause();
        state.coverVideo.removeAttribute('src');
        if (!coverPath || !isPreviewMediaAvailable(coverPath)) return;
        const url = toPlayablePath(coverPath);
        if (isImagePath(coverPath)) {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => {
                if (state.coverSig === sig) state.coverImage = img;
                render();
            };
            img.onerror = () => render();
            img.src = url;
        } else {
            state.coverVideo.src = url;
            state.coverVideo.load();
        }
    }

    function togglePlay() {
        if (!state.isOpen) return;
        const task = getTask();
        if (!task) return;

        if (state.isPlaying) {
            state.pausedAt = getCurrentTime();
            pauseMedia();
            state.isPlaying = false;
            updatePlayButton();
            render();
            return;
        }

        const dur = computeDuration();
        if (dur > 0 && state.pausedAt >= dur - 0.02) state.pausedAt = 0;
        state.startedAt = performance.now() / 1000 - (state.pausedAt || 0) / state.playbackSpeed;
        syncMediaToTime(state.pausedAt || 0);
        playMedia();
        state.isPlaying = true;
        updatePlayButton();
    }

    function playMedia() {
        const task = getTask();
        applyAudioVolumes(task);
        applyPlaybackRates(task);
        if (state.audioCtx && state.audioCtx.state === 'suspended') {
            state.audioCtx.resume().catch(() => {});
        }
        syncPhasePlayback(getPhaseInfo(state.pausedAt || 0, task), task);
    }

    function pauseMedia() {
        state.audio?.pause();
        state.bgmAudio?.pause();
        state.bgVideo?.pause();
        state.bgFadeVideo?.pause();
        state.contentVideo?.pause();
        state.hookVideo?.pause();
        state.hookAudio?.pause();
        state.coverVideo?.pause();
    }

    function onMediaEnded() {
        if (!state.isOpen || isLoopEnabled()) return;
        const dur = computeDuration();
        if (dur > 0 && getCurrentTime() >= dur - 0.2) {
            state.pausedAt = dur;
            state.isPlaying = false;
            pauseMedia();
            updatePlayButton();
        }
    }

    function onSeekInput(e) {
        const dur = computeDuration();
        const next = dur > 0 ? (parseFloat(e.target.value || '0') / 1000) * dur : 0;
        seekTo(next);
    }

    function seekTo(time) {
        if(!state.isOpen || !getTask())return;
        state.queuedSeek=clamp(numberOr(time,0),0,computeDuration() || Number.MAX_SAFE_INTEGER);
        updateTimeUI(state.queuedSeek,computeDuration());
        if(state.seekQueueTimer)return;
        const flush=()=>{
            state.seekQueueTimer=null;
            const target=state.queuedSeek;state.queuedSeek=null;
            if(target===null || !state.isOpen)return;
            state.lastSeekRequestAt=performance.now();
            applySeek(target);
        };
        const wait=Math.max(0,32-(performance.now()-state.lastSeekRequestAt));
        if(wait>0)state.seekQueueTimer=setTimeout(flush,wait);else flush();
    }

    function applySeek(time) {
        if(!state.isOpen || !getTask())return;
        const dur=computeDuration();
        const next=clamp(numberOr(time,0),0,dur || Number.MAX_SAFE_INTEGER);
        state.pausedAt = next;
        state.startedAt = performance.now() / 1000 - next / state.playbackSpeed;
        const token = ++state.seekFrameToken;
        state.seekFrameLock = { token, target: next, createdAt: performance.now() };
        if(state.isPlaying)pauseMedia();
        syncMediaToTime(next);
        prepareMultiBackgroundSeek(next);
        updateTimeUI(next, dur);
        // 某些编码不会稳定发出 seeked；短延时兜底会重新检查，而不是直接清屏。
        setTimeout(() => {
            if (state.seekFrameLock?.token === token) releaseSeekFrameWhenReady(true);
        }, 180);
        render();
    }

    function prepareMultiBackgroundSeek(time) {
        const task = getTask();
        if (!isMultiBackgroundTask(task)) return;
        const phase = getPhaseInfo(time, task);
        const clips = resolveMultiBackgroundAtTime(task, phase.mainTime);
        if (clips) syncMultiVideoPlayers(task, clips);
    }

    function getSeekVisualMedia(time, task) {
        const phase = getPhaseInfo(time, task);
        if (phase.inCover) return [state.coverVideo].filter(media => media?.src);
        if (phase.inHook) return [state.hookVideo].filter(media => media?.src);
        if (isMultiBackgroundTask(task)) {
            return [state.bgVideo, state.bgFadeVideo].filter(media => media?.src);
        }
        if (task && (task.contentVideoDirectBg || task.contentVideoBlurBg)) {
            return [state.contentVideo].filter(media => media?.src);
        }
        const media = [];
        if (state.bgVideo.src) media.push(state.bgVideo);
        if (task?.contentVideoPath && state.contentVideo.src) media.push(state.contentVideo);
        return media;
    }

    function isSeekFramePending(lock = state.seekFrameLock) {
        if (!lock) return false;
        if(!lock.overlayVideos || lock.waitingMetadata?.some(video=>Number.isFinite(video.duration))) {
            const task=getTask(),phase=getPhaseInfo(lock.target,task);
            lock.overlays ||= phase.inCover?task?.cover?.overlays:phase.inHook?[]:
                window.ReelsRenderPlan?.getCompositedOverlays?.(task,{width:getTargetWidth(),height:getTargetHeight()}) || getLiveOverlays(task);
            lock.overlayVideos=window.ReelsOverlay?.preparePreviewSeek?.(lock.overlays,phase.inCover?phase.time:phase.mainTime) || [];
            lock.waitingMetadata=lock.overlayVideos.filter(video=>!Number.isFinite(video.duration));
        }
        // 一个损坏/缺失/被系统回收解码器的视频永远到不了 readyState≥2；
        // 若无限等待，画布与播放时间都会卡在 seek 目标（总览里表现为一直停在缓存图）。
        // 出错或无源的媒体不参与等待，且整体等待有上限，超时后照常渲染已就绪的层。
        const maxWait = window.__reelsOverviewCard ? 2500 : 4000;
        if (performance.now() - (lock.createdAt || 0) > maxWait) return false;
        const media = [...getSeekVisualMedia(lock.target, getTask()),...lock.overlayVideos]
            .filter(item => item && !item.error && item.networkState !== 3 && (item.currentSrc || item.getAttribute?.('src')));
        return media.some(item => item.seeking || item.readyState < 2);
    }

    function releaseSeekFrameWhenReady(forceCheck = false) {
        if(!state.isOpen)return;
        const lock = state.seekFrameLock;
        if (!lock) return;
        if (isSeekFramePending(lock) && !forceCheck) return;
        if (isSeekFramePending(lock) && forceCheck) {
            setTimeout(() => releaseSeekFrameWhenReady(true), 80);
            return;
        }
        state.seekFrameLock = null;
        if(state.isPlaying){state.startedAt=performance.now()/1000-lock.target/state.playbackSpeed;playMedia();}
        render();
    }

    function getCurrentTime() {
        if(state.seekFrameLock)return state.seekFrameLock.target;
        if (state.isPlaying) {
            // V2 是合成时间轴；背景/BGM/内容视频都可能循环，它们的
            // currentTime 只是素材局部时间，不能作为总时间，否则每次循环都会跳回 0。
            return Math.max(0, ((performance.now() / 1000) - state.startedAt) * state.playbackSpeed);
        }
        return state.pausedAt || 0;
    }

    function syncMediaToTime(time) {
        const task = getTask();
        const phase = getPhaseInfo(time, task);
        const mainTime = phase.mainTime;
        const bgDur = mediaDuration(state.bgVideo);
        const audioDur = mediaDuration(state.audio);
        const bgmDur = mediaDuration(state.bgmAudio);
        const contentDur = mediaDuration(state.contentVideo);
        const hookDurRaw = mediaDuration(state.hookVideo);
        const coverDurRaw = mediaDuration(state.coverVideo);
        const atTimelineEnd = isAtTimelineEnd(time);
        const isMultiBg = isMultiBackgroundTask(task);

        if (state.audio.src && audioDur > 0) {
            setMediaTime(state.audio, clamp(mainTime / getAudioDurationScale(task), 0, audioDur));
        }
        if (!isMultiBg && state.bgVideo.src && bgDur > 0) {
            const bgTime = mainTime / getBgDurationScale(task);
            setMediaTime(state.bgVideo, isLoopEnabled() ? loopMediaTime(bgTime, bgDur, atTimelineEnd) : clamp(bgTime, 0, bgDur));
        }
        if (state.bgmAudio.src && bgmDur > 0) {
            const bgmStart = Math.max(0, numberOr(task && task.bgmStart, 0));
            setMediaTime(state.bgmAudio, loopMediaTime(bgmStart + mainTime, bgmDur, atTimelineEnd));
        }
        if (state.contentVideo.src && contentDur > 0) {
            const trimStart = parseFloat((task || {}).contentVideoTrimStart) || 0;
            const trimEnd = parseFloat((task || {}).contentVideoTrimEnd) || 0;
            const usableDur = trimEnd > trimStart ? trimEnd - trimStart : Math.max(0.01, contentDur - trimStart);
            setMediaTime(state.contentVideo, trimStart + loopMediaTime(mainTime, usableDur, atTimelineEnd));
        }
        if (state.hookVideo.src && hookDurRaw > 0) {
            const timing = window.ReelsHookUtils
                ? window.ReelsHookUtils.computeHookVideoTiming(task, hookDurRaw)
                : { trimStart: Math.max(0, numberOr(task && task.hookTrimStart, 0)), speed: Math.max(0.1, numberOr(task && task.hookSpeed, 1)), trimEnd: hookDurRaw, outputDuration: phase.hookDuration };
            const hookLocalTime = Math.max(0, time - phase.coverDuration);
            const hookTarget = timing.trimStart + hookLocalTime * timing.speed;
            setMediaTime(state.hookVideo, clamp(hookTarget, 0, Math.min(hookDurRaw, timing.trimEnd || hookDurRaw)));
            if (state.hookAudio && state.hookAudio.src) {
                const hookAudioRaw = mediaDuration(state.hookAudio);
                const audioPlan = window.ReelsHookUtils
                    ? window.ReelsHookUtils.computeHookAudioPlan(task, phase.hookDuration, hookAudioRaw > 0 ? hookAudioRaw : null)
                    : { mode: 'custom_audio', trimStart: Math.max(0, numberOr(task && task.hookAudioTrimStart, 0)), audioSpan: phase.hookDuration };
                const audioTarget = audioPlan.trimStart + Math.min(hookLocalTime, audioPlan.audioSpan);
                setMediaTime(state.hookAudio, hookAudioRaw > 0 ? clamp(audioTarget, 0, hookAudioRaw) : audioTarget);
            }
        }
        if (state.coverVideo.src && coverDurRaw > 0) {
            setMediaTime(state.coverVideo, clamp(time, 0, Math.max(0, coverDurRaw - 0.03)));
        }
    }

    function setMediaTime(media, target) {
        if (!media || !media.src || !Number.isFinite(target)) return;
        if (Math.abs((media.currentTime || 0) - target) > 0.25) {
            try { media.currentTime = target; } catch (_) {}
        }
    }

    function syncMediaWhilePlaying(time) {
        if (!state.isPlaying) return;
        const task = getTask();
        const phase = getPhaseInfo(time, task);
        const mainTime = phase.mainTime;
        const bgDur = mediaDuration(state.bgVideo);
        const bgmDur = mediaDuration(state.bgmAudio);
        const contentDur = mediaDuration(state.contentVideo);
        const isMultiBg = isMultiBackgroundTask(task);
        const hasAudioClock = !!(state.audio.src && !state.audio.paused);
        const bgIsClock = !isMultiBg && !hasAudioClock && state.bgVideo.src && !state.bgVideo.paused;
        const contentIsClock = !hasAudioClock && !bgIsClock && state.contentVideo.src && !state.contentVideo.paused;
        if (!isMultiBg && hasAudioClock && state.bgVideo.src && bgDur > 0) {
            const bgTime = mainTime / getBgDurationScale(task);
            const target = isLoopEnabled() ? positiveModulo(bgTime, bgDur) : clamp(bgTime, 0, bgDur);
            setMediaTime(state.bgVideo, target);
        }
        if (state.bgmAudio.src && bgmDur > 0) {
            const bgmStart = Math.max(0, numberOr(task && task.bgmStart, 0));
            setMediaTime(state.bgmAudio, positiveModulo(bgmStart + mainTime, bgmDur));
        }
        if (!contentIsClock && state.contentVideo.src && contentDur > 0) {
            const trimStart = parseFloat((task || {}).contentVideoTrimStart) || 0;
            const trimEnd = parseFloat((task || {}).contentVideoTrimEnd) || 0;
            const usableDur = trimEnd > trimStart ? trimEnd - trimStart : Math.max(0.01, contentDur - trimStart);
            setMediaTime(state.contentVideo, trimStart + positiveModulo(mainTime, usableDur));
        }
        syncPhasePlayback(phase, task);
    }

    function syncPhasePlayback(phase, task) {
        if (!state.isPlaying) return;
        if (phase.inCover) {
            if (state.coverVideo.src) state.coverVideo.play().catch(() => {});
            state.hookVideo?.pause();
        state.hookAudio?.pause();
            pauseMainMedia();
            return;
        }
        if (phase.inHook) {
            state.coverVideo?.pause();
            if (state.hookVideo.src && state.hookVideo.paused) state.hookVideo.play().catch(() => {});
            if (state.hookAudio && state.hookAudio.src) {
                const hookLocalTime = Math.max(0, phase.time - phase.coverDuration);
                const hookAudioRaw = mediaDuration(state.hookAudio);
                const audioPlan = window.ReelsHookUtils
                    ? window.ReelsHookUtils.computeHookAudioPlan(task, phase.hookDuration, hookAudioRaw > 0 ? hookAudioRaw : null)
                    : { mode: 'custom_audio', trimStart: Math.max(0, numberOr(task && task.hookAudioTrimStart, 0)), audioSpan: phase.hookDuration };
                if (audioPlan.mode === 'custom_audio' && hookLocalTime < audioPlan.audioSpan - 0.03) {
                    const expectedAudioTime = audioPlan.trimStart + hookLocalTime;
                    setMediaTime(state.hookAudio, hookAudioRaw > 0 ? clamp(expectedAudioTime, 0, hookAudioRaw) : expectedAudioTime);
                    if (state.hookAudio.paused) state.hookAudio.play().catch(() => {});
                } else {
                    state.hookAudio.pause();
                }
            }
            pauseMainMedia();
            return;
        }
        state.coverVideo?.pause();
        state.hookVideo?.pause();
        state.hookAudio?.pause();
        playMainMedia(task);
    }

    function pauseMainMedia() {
        state.audio?.pause();
        state.bgmAudio?.pause();
        state.bgVideo?.pause();
        state.bgFadeVideo?.pause();
        state.contentVideo?.pause();
    }

    function playMainMedia(task) {
        if (state.audio.src && task && task.audioPath && state.audio.paused) state.audio.play().catch(() => {});
        if (state.bgVideo.src && state.bgVideo.paused) state.bgVideo.play().catch(() => {});
        if (state.bgFadeVideo.src && state.bgFadeVideo.paused) state.bgFadeVideo.play().catch(() => {});
        if (state.contentVideo.src && state.contentVideo.paused) state.contentVideo.play().catch(() => {});
        if (state.bgmAudio.src && task && getBgmPath(task) && state.bgmAudio.paused) state.bgmAudio.play().catch(() => {});
    }

    function render() {
        if (!state.canvas || state.previewSuspended) return;
        const task = getTask();
        const ctx = state.canvas.getContext('2d');
        const w = state.canvas.width;
        const h = state.canvas.height;
        const empty = state.root?.querySelector('[data-role="empty"]');
        const t = getCurrentTime();
        const dur = computeDuration();
        state.duration = dur;
        applyAudioVolumes(task);
        applyPlaybackRates(task);

        // seek 目标帧尚未解码时保持 Canvas 上一帧，避免清屏后短暂出现黑色。
        if (state.seekFrameLock && isSeekFramePending()) {
            updateTimeUI(state.queuedSeek ?? state.seekFrameLock.target, dur);
            return;
        }
        if (state.seekFrameLock) {
            if(state.isPlaying){state.startedAt=performance.now()/1000-state.seekFrameLock.target/state.playbackSpeed;playMedia();}
            state.seekFrameLock = null;
        }

        if (!task) {
            ctx.clearRect(0, 0, w, h);
            ctx.fillStyle = '#05070b';
            ctx.fillRect(0, 0, w, h);
            if (empty) empty.style.display = 'flex';
            updateTimeUI(0, 0);
            return;
        }
        if (empty) empty.style.display = 'none';

        if (state.isPlaying && dur > 0 && t >= dur) {
            if (isLoopEnabled()) {
                state.startedAt = performance.now() / 1000;
                state.pausedAt = 0;
                syncMediaToTime(0);
            } else {
                state.pausedAt = dur;
                state.isPlaying = false;
                pauseMedia();
                updatePlayButton();
            }
        }

        syncMediaWhilePlaying(t);
        const phase = getPhaseInfo(t, task);
        const drawTime = phase.mainTime;
        const overlayTime = phase.inCover ? phase.time : drawTime;
        // 与原始预览一致：配音时长缩放后，用原始音频时间查找/渲染字幕。
        const subtitleTime = drawTime / getAudioDurationScale(task);

        // A previous effect may leave a clip or transform on the context.
        // Reset the whole drawing state so scaled layers cannot leave trails.
        if (typeof ctx.reset === 'function') ctx.reset();
        else { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, w, h); }
        drawBackground(ctx, task, w, h, phase, { preview: true });
        drawGlobalMask(ctx, getResolvedStyle(task), w, h, phase);
        drawContentVideo(ctx, task, w, h, phase);
        state.renderer?.renderAmbientLightingBase?.(getResolvedStyle(task), w, h);
        const overlayAboveSubtitle = task.overlayAboveSubtitle !== false;
        if (!overlayAboveSubtitle) drawOverlays(ctx, task, overlayTime, w, h, phase);
        drawSubtitles(ctx, task, subtitleTime, w, h, phase);
        if (overlayAboveSubtitle) drawOverlays(ctx, task, overlayTime, w, h, phase);
        drawWatermarks(ctx, w, h);
        updateTimeUI(Math.min(t, dur || t), dur);
        syncTimelinePlayhead(t, task);
        syncTimelineDuration(dur, task);
    }

    function syncTimelinePlayhead(absoluteTime, task) {
        const editor = window._reelsState && window._reelsState.timelineEditor;
        if (!editor || typeof editor.setPlayhead !== 'function') return;
        editor.setPlayhead(absoluteToTimeline(absoluteTime, task));
    }

    function syncTimelineDuration(absoluteDuration, task) {
        const editor = window._reelsState && window._reelsState.timelineEditor;
        if (!editor || typeof editor.setDuration !== 'function') return;
        const timelineDuration = absoluteToTimeline(absoluteDuration, task);
        if (Math.abs((editor._duration || 0) - timelineDuration) > 0.01) {
            editor.setDuration(timelineDuration);
        }
    }

    function absoluteToTimeline(absoluteTime, task = getTask()) {
        return Math.max(0, (numberOr(absoluteTime, 0) - getTimelineOffset(task)) / getAudioDurationScale(task));
    }

    function timelineToAbsolute(timelineTime, task = getTask()) {
        return Math.max(0, numberOr(timelineTime, 0) * getAudioDurationScale(task) + getTimelineOffset(task));
    }

    function syncLegacySeekTime() {
        if (state.isPlaying || !state.isOpen) return;
        const legacyTime = readLegacyPreviewTime();
        if (!Number.isFinite(legacyTime)) return;
        if (state.lastLegacyTime == null) {
            state.lastLegacyTime = legacyTime;
            return;
        }
        if (Math.abs(legacyTime - state.lastLegacyTime) > 0.03) {
            state.lastLegacyTime = legacyTime;
            state.pausedAt = Math.max(0, legacyTime);
            syncMediaToTime(state.pausedAt);
        }
    }

    function readLegacyPreviewTime() {
        const rs = window._reelsState;
        if (!rs) return NaN;
        const lock = rs.previewSeekLock;
        if (lock && Number.isFinite(lock.target) && (!lock.until || performance.now() < lock.until)) {
            return lock.target;
        }
        if (Number.isFinite(rs.mockPausedTime)) return rs.mockPausedTime;
        return NaN;
    }

    function drawBackground(ctx, task, w, h, phase = getPhaseInfo(getCurrentTime(), task), options = {}) {
        // Red reveals uncovered areas only in the editor. Snapshot exports use
        // the default black backing, independently of the live preview canvas.
        ctx.fillStyle = options.preview ? '#ff0000' : '#000000';
        ctx.fillRect(0, 0, w, h);
        const bgScale = numberOr(task && task.bgScale, 100);
        const bgRotation = numberOr(task && task.bgRotation, 0);
        const bgX = numberOr(task && task.bgX, 0);
        const bgY = numberOr(task && task.bgY, 0);

        if (phase.inCover) {
            drawCoverPhase(ctx, task, w, h);
            return;
        }
        if (phase.inHook && state.hookVideo.src && state.hookVideo.readyState >= 2 && state.hookVideo.videoWidth > 0) {
            drawMediaCover(ctx, state.hookVideo, w, h, 100, 0, 0, false, false);
            drawHookTransition(ctx, task, w, h, phase);
            return;
        }
        if (task && task.contentVideoBlurBg && getContentSource()) {
            drawContentBlurBackground(ctx, task, w, h);
            return;
        }
        if (task && task.contentVideoDirectBg && (state.contentVideo.src || state.contentImage)) {
            drawCroppedCover(ctx, getContentSource(), parseCrop(task.contentVideoCrop), w, h, bgScale, bgX, bgY, !!task.bgFlipH, !!task.bgFlipV, bgRotation);
            return;
        }
        if (task && task.bgMode === 'multi' && getEffectiveBgClipPool(task).length > 0) {
            drawMultiBackground(ctx, task, w, h, resolveMultiBackgroundAtTime(task, phase.mainTime));
        } else if (state.bgImage && state.bgImage.complete && state.bgImage.naturalWidth > 0) {
            drawMediaCover(ctx, state.bgImage, w, h, bgScale, bgX, bgY, !!task.bgFlipH, !!task.bgFlipV, bgRotation);
        } else if (state.bgVideo.src && state.bgVideo.readyState >= 2 && state.bgVideo.videoWidth > 0) {
            drawMediaCover(ctx, state.bgVideo, w, h, bgScale, bgX, bgY, !!task.bgFlipH, !!task.bgFlipV, bgRotation);
        } else {
            const grad = ctx.createLinearGradient(0, 0, 0, h);
            grad.addColorStop(0, '#101622');
            grad.addColorStop(1, '#05070b');
            ctx.fillStyle = grad;
            ctx.fillRect(0, 0, w, h);
        }
    }

    function drawCoverPhase(ctx, task, w, h) {
        const cover = (task && task.cover) || {};
        const scale = numberOr(cover.bgScale, numberOr(task && task.bgScale, 100));
        const x = numberOr(cover.bgX, numberOr(task && task.bgX, 0));
        const y = numberOr(cover.bgY, numberOr(task && task.bgY, 0));
        const rotation = numberOr(cover.bgRotation, numberOr(task && task.bgRotation, 0));
        const flipH = !!(cover.bgFlipH || (task && task.bgFlipH));
        const flipV = !!(cover.bgFlipV || (task && task.bgFlipV));
        if (state.coverImage && state.coverImage.complete && state.coverImage.naturalWidth > 0) {
            drawMediaCover(ctx, state.coverImage, w, h, scale, x, y, flipH, flipV, rotation);
        } else if (state.coverVideo.src && state.coverVideo.readyState >= 2 && state.coverVideo.videoWidth > 0) {
            drawMediaCover(ctx, state.coverVideo, w, h, scale, x, y, flipH, flipV, rotation);
        } else if (state.bgImage && state.bgImage.complete && state.bgImage.naturalWidth > 0) {
            drawMediaCover(ctx, state.bgImage, w, h, scale, x, y, flipH, flipV, rotation);
        } else if (state.bgVideo.src && state.bgVideo.readyState >= 2 && state.bgVideo.videoWidth > 0) {
            drawMediaCover(ctx, state.bgVideo, w, h, scale, x, y, flipH, flipV, rotation);
        } else {
            ctx.fillStyle = '#000';
            ctx.fillRect(0, 0, w, h);
        }
    }

    function drawHookTransition(ctx, task, w, h, phase) {
        const transition = (task && task.hookTransition) || 'none';
        const transitionDur = transition !== 'none' ? numberOr(task && task.hookTransDuration, 0.5) : 0;
        const timeToEnd = phase.coverDuration + phase.hookDuration - phase.time;
        if (!(transitionDur > 0 && timeToEnd < transitionDur)) return;
        const bg = state.bgImage || state.bgVideo;
        if (!bg) return;
        const canDraw = bg === state.bgImage
            ? state.bgImage.complete && state.bgImage.naturalWidth > 0
            : state.bgVideo.readyState >= 2 && state.bgVideo.videoWidth > 0;
        if (!canDraw) return;
        ctx.save();
        ctx.globalAlpha = clamp(1 - timeToEnd / transitionDur, 0, 1);
        drawMediaCover(ctx, bg, w, h, numberOr(task && task.bgScale, 100), numberOr(task && task.bgX, 0), numberOr(task && task.bgY, 0), !!task.bgFlipH, !!task.bgFlipV, numberOr(task && task.bgRotation, 0));
        ctx.restore();
    }

    function drawMultiBackground(ctx, task, w, h, clips) {
        const bgScale = numberOr(task && task.bgScale, 100);
        const bgX = numberOr(task && task.bgX, 0);
        const bgY = numberOr(task && task.bgY, 0);
        const bgRotation = numberOr(task && task.bgRotation, 0);
        const flipH = !!(task && task.bgFlipH);
        const flipV = !!(task && task.bgFlipV);
        if (!clips || !clips.current) {
            ctx.fillStyle = '#000';
            ctx.fillRect(0, 0, w, h);
            return;
        }

        syncMultiVideoPlayers(task, clips);
        const drawClip = (clip) => {
            const src = getMultiClipSource(clip);
            if (src) {
                drawMediaCover(ctx, src, w, h, bgScale, bgX, bgY, flipH, flipV, bgRotation);
            } else {
                ctx.fillStyle = '#11151d';
                ctx.fillRect(0, 0, w, h);
            }
        };

        if (!clips.transition) {
            drawClip(clips.current);
            return;
        }

        const outgoing = clips.transition;
        const incoming = clips.current;
        const progress = clamp(numberOr(outgoing.progress, 0), 0, 1);
        const type = outgoing.type || 'crossfade';
        drawClip(outgoing);

        ctx.save();
        if (type === 'crossfade' || type === 'fade') {
            ctx.globalAlpha = progress;
            drawClip(incoming);
        } else if (type === 'fade_black' || type === 'fadeblack') {
            if (progress < 0.5) {
                ctx.fillStyle = `rgba(0,0,0,${progress * 2})`;
                ctx.fillRect(0, 0, w, h);
            } else {
                ctx.globalAlpha = (progress - 0.5) * 2;
                drawClip(incoming);
            }
        } else if (type === 'fade_white' || type === 'fadewhite') {
            if (progress < 0.5) {
                ctx.fillStyle = `rgba(255,255,255,${progress * 2})`;
                ctx.fillRect(0, 0, w, h);
            } else {
                ctx.globalAlpha = (progress - 0.5) * 2;
                drawClip(incoming);
            }
        } else if (type === 'slide_left' || type === 'slideleft') {
            ctx.beginPath();
            ctx.rect(w * (1 - progress), 0, w * progress, h);
            ctx.clip();
            drawClip(incoming);
        } else if (type === 'slide_right' || type === 'slideright' || type === 'wipe' || type === 'wipeleft') {
            ctx.beginPath();
            ctx.rect(0, 0, w * progress, h);
            ctx.clip();
            drawClip(incoming);
        } else {
            drawClip(incoming);
        }
        ctx.restore();
    }

    function getMultiClipSource(clip) {
        if (!clip) return null;
        if (clip.isImage) {
            let img = state.multiBgImages.get(clip.path);
            if (!img) {
                img = new Image();
                img.crossOrigin = 'anonymous';
                img.onload = () => render();
                img.onerror = () => render();
                img.src = toPlayablePath(clip.path);
                state.multiBgImages.set(clip.path, img);
            }
            return img.complete && img.naturalWidth > 0 ? img : null;
        }
        for (const video of [state.bgVideo, state.bgFadeVideo]) {
            if (video.dataset.multiPath === clip.path && video.readyState >= 2 && video.videoWidth > 0) return video;
        }
        return null;
    }

    function syncMultiVideoPlayers(task, clips) {
        const bgDurFactor = Math.max(0.01, numberOr(task && task.bgDurScale, 100) / 100);
        const playbackRate = state.playbackSpeed / bgDurFactor;
        const shouldPlay = state.isPlaying && !getPhaseInfo(getCurrentTime(), task).inCover && !getPhaseInfo(getCurrentTime(), task).inHook;
        const bgBaseGain = Math.max(0, effectiveBgVolume(task) / 100);
        const needed = [];
        if (clips.transition && !clips.transition.isImage) needed.push(clips.transition);
        if (clips.current && !clips.current.isImage) needed.push(clips.current);

        const setPreviewVideoGain = (video, gain) => {
            const nextGain = clamp(gain, 0, 1);
            const gainNode = state.gainNodes && state.gainNodes.get(video);
            if (gainNode && state.audioCtx) {
                gainNode.gain.setValueAtTime(nextGain, state.audioCtx.currentTime);
                video.volume = nextGain > 0 ? 1 : 0;
            } else {
                video.volume = nextGain;
            }
            video.muted = nextGain <= 0.001;
        };

        const assign = (video, clip, gain) => {
            const url = toPlayablePath(clip.path);
            
            const norm = (s) => {
                if (!s) return '';
                try {
                    let dec = decodeURIComponent(s);
                    dec = dec.replace(/^file:\/\/\//i, '/').replace(/^file:\/\//i, '/');
                    dec = dec.replace(/\\/g, '/');
                    dec = dec.replace(/\/+/g, '/');
                    return dec;
                } catch (_) {
                    return s;
                }
            };

            if (video.dataset.multiPath !== clip.path || norm(video.src) !== norm(url)) {
                video.pause();
                video.dataset.multiPath = clip.path;
                video.src = url;
                video.load();
            }
            video.playbackRate = playbackRate;
            const dur = mediaDuration(video);
            const target = dur > 0 ? Math.min(clip.localTime, Math.max(0, dur - 0.03)) : clip.localTime;
            setMediaTime(video, target);
            setPreviewVideoGain(video, gain);
            if (shouldPlay && video.paused) video.play().catch(() => {});
            if (!shouldPlay && !video.paused) video.pause();
        };

        let firstGain = bgBaseGain;
        let secondGain = bgBaseGain;
        if (clips.transition && needed.length > 1) {
            const progress = clamp(numberOr(clips.transition.progress, 0), 0, 1);
            firstGain = bgBaseGain * (1 - progress);
            secondGain = bgBaseGain * progress;
        }

        if (needed[0]) assign(state.bgVideo, needed[0], firstGain);
        else state.bgVideo.pause();
        if (needed[1]) assign(state.bgFadeVideo, needed[1], secondGain);
        else state.bgFadeVideo.pause();
    }

    function drawContentBlurBackground(ctx, task, w, h) {
        const src = task.contentVideoBlurStatic ? window.ReelsOverlay.getContentBlurSource(task) : getContentSource();
        if (!src) return;
        const crop = parseCrop(task.contentVideoCrop);
        const srcW = src.videoWidth || src.naturalWidth || src.width || 0;
        const srcH = src.videoHeight || src.naturalHeight || src.height || 0;
        if (!(srcW > 0 && srcH > 0)) return;
        ctx.save();
        const blur = numberOr(task.contentVideoBlur, 40);
        const brightness = numberOr(task.contentVideoBrightness, 60) / 100;
        ctx.filter = `blur(${blur}px) brightness(${brightness})`;
        drawCroppedCover(ctx, src, crop, w, h, numberOr(task.bgScale, 100), numberOr(task.bgX, 0), numberOr(task.bgY, 0), !!task.bgFlipH, !!task.bgFlipV, numberOr(task.bgRotation, 0));
        ctx.restore();
    }

    function drawContentVideo(ctx, task, w, h, phase = getPhaseInfo(getCurrentTime(), task)) {
        if (!task || !task.contentVideoPath || task.contentVideoDirectBg || phase.inCover || phase.inHook) return;
        const src = getContentSource();
        if (!src) return;

        const srcW = src.videoWidth || src.naturalWidth || src.width || 0;
        const srcH = src.videoHeight || src.naturalHeight || src.height || 0;
        if (!(srcW > 0 && srcH > 0)) return;

        const crop = parseCrop(task.contentVideoCrop);
        const sx = srcW * crop.x;
        const sy = srcH * crop.y;
        const sw = srcW * crop.w;
        const sh = srcH * crop.h;
        const scale = (numberOr(task.contentVideoScale, 100) / 100) * (w / sw);
        const dw = sw * scale;
        const dh = sh * scale;
        let dx = (w - dw) / 2;
        let dy = (h - dh) / 2;

        const posX = task.contentVideoX;
        const posY = task.contentVideoY;
        if (posX && posX !== 'center') {
            const n = parseFloat(posX);
            if (Number.isFinite(n)) dx += Math.abs(n) <= 1 ? w * n : (n / DEFAULT_W) * w;
        }
        if (posY && posY !== 'center') {
            const n = parseFloat(posY);
            if (Number.isFinite(n)) dy += Math.abs(n) <= 1 ? h * n : (n / DEFAULT_H) * h;
        }
        drawImageMaybeFlipped(ctx, src, sx, sy, sw, sh, dx, dy, dw, dh, !!task.contentVideoFlipH, !!task.contentVideoFlipV);
    }

    function drawGlobalMask(ctx, style, w, h, phase) {
        if (!style || !style.global_mask_enabled || phase.inHook) return;
        ctx.save();
        ctx.globalAlpha = clamp(numberOr(style.global_mask_opacity, 0.5), 0, 1);
        ctx.fillStyle = style.global_mask_color || '#000000';
        ctx.fillRect(0, 0, w, h);
        ctx.restore();
    }

    function drawSubtitles(ctx, task, time, w, h, phase = getPhaseInfo(getCurrentTime(), task), options = {}) {
        const show = state.root?.querySelector('[data-role="subs"]')?.checked !== false;
        const renderer = options.renderer || state.renderer;
        if (!renderer || !task) return;
        const style = getResolvedStyle(task);
        if (!style) return;

        try {
            // This is an editing guide, not subtitle content. Keep it visible
            // through subtitle gaps (and cover/hook phases) whenever enabled.
            if (!options.exporting) drawSubtitleRange(ctx, style, w, h);
            if (!show || phase.inCover || phase.inHook) return;
            const uniform = window.ReelsUniformScroll?.isEnabled(style);
            const timeScale = getAudioDurationScale(task);
            const mainDuration = Math.max(0.001, computeDuration() - getTimelineOffset(task));
            const segments = uniform ? window.ReelsUniformScroll.segments(task.segments,
                task.txtContent || task.ttsText || task.aiScript, mainDuration / timeScale) : (task.segments || []);
            const segment = uniform ? segments[0] : findActiveSegment(task, time, style);
            if (!segment) return;
            if (typeof renderer.setContextSegments === 'function') renderer.setContextSegments(segments, task.txtContent || task.ttsText || task.aiScript || '');
            renderer.setScrollTiming?.({ duration: mainDuration, timeScale,
                audioDuration: mediaDuration(state.audio) * timeScale,
                backgroundDuration: isMultiBackgroundTask(task) ? getMultiBackgroundDuration(task) : mediaDuration(state.bgVideo) * getBgDurationScale(task) });
            renderer.renderSubtitle(style, segment, time, w, h);
        } catch (err) {
            if (options.exporting) throw err;
            console.warn('[PreviewV2] subtitle render failed', err);
        }
    }

    function drawOverlays(ctx, task, time, w, h, phase = getPhaseInfo(getCurrentTime(), task), options = {}) {
        const show = options.exporting || state.root?.querySelector('[data-role="overlays"]')?.checked !== false;
        if (!window.ReelsOverlay || !task) return;
        // 插入轨不是用户创建的“覆层”。无论普通覆层预览开关状态如何，它都
        // 必须按时间线独立合成；否则用户会看到插入片段存在但画面消失。
        const inserts = !phase.inCover && !phase.inHook
            ? getInsertTrackOverlays(task, w, h)
            : [];
        const overlays = phase.inCover && task.cover && Array.isArray(task.cover.overlays)
            ? task.cover.overlays
            : (phase.inHook ? [] : getLiveOverlays(task));
        const visibleOverlays = show ? overlays : [];
        const drawable = !phase.inCover && !phase.inHook && typeof window.ReelsRenderPlan?.getCompositedOverlays === 'function'
            ? window.ReelsRenderPlan.getCompositedOverlays(task, { width: w, height: h }).filter(ov => ov._insertClip || show)
            : [...inserts, ...visibleOverlays];
        const preparedDrawable = options.preparedOverlays || drawable;
        const frameOverlays = options.transparent ? preparedDrawable.filter(ov => !ov._insertClip) : preparedDrawable;
        for (const ov of frameOverlays) {
            if (!ov || ov.disabled) continue;
            const start = numberOr(ov.start, 0);
            const end = numberOr(ov.end, 9999);
            // 与 WYSIWYG 输出一致：普通覆层只在时间范围内显示；
            // 滚动覆层到达结束时间后保留最终位置。
            const phonePreview = !options.exporting && ov.is_phone_cta && ov._ctaAnimPreviewStart && (performance.now() - ov._ctaAnimPreviewStart) < 2400;
            if (!phonePreview && (time < start || (ov.type !== 'scroll' && time > end))) continue;
            try {
                // Preview must never inherit a stale/concurrent export marker,
                // otherwise ReelsOverlay intentionally suppresses guide boxes.
                const previewOv = { ...ov, _previewPlaying: state.isPlaying, _taskSegments: ov.type === 'scroll' && ov.scroll_typewriter_enabled ? (task.segments||[]).map(seg=>({...seg,start:seg.start*getAudioDurationScale(task),end:seg.end*getAudioDurationScale(task),words:seg.words?.map(w=>({...w,start:w.start*getAudioDurationScale(task),end:w.end*getAudioDurationScale(task)}))})) : undefined, _allOverlays: frameOverlays, _exporting: !!options.exporting };
                window.ReelsOverlay.drawOverlay(ctx, previewOv, time, w, h);
                // Keep computed bounds available to hit-testing/property UI.
                for (const key of ['_renderedX', '_renderedY', '_renderedW', '_renderedH']) {
                    if (!options.exporting && previewOv[key] != null) ov[key] = previewOv[key];
                }
            } catch (err) {
                if (options.exporting) throw err;
                console.warn('[PreviewV2] overlay render failed', err);
            }
        }
        if (!options.exporting && !phase.inCover && !phase.inHook) drawOverlaySelection(ctx, drawable, time, w, h);
    }

    function drawOverlaySelection(ctx, overlays, time, w, h) {
        const selectedId = window._reelsState && window._reelsState.overlaySelectedId;
        if (!selectedId || !Array.isArray(overlays)) return;
        const ov = overlays.find(item => item && item.id === selectedId);
        if (!ov || ov.disabled) return;
        const bounds = ov.is_phone_cta
            ? measureEditableBounds((surface, width, height) => window.ReelsOverlay.drawOverlay(surface,
                { ...ov, _selected: false, _exporting: true, _hitTesting: true, _previewPlaying: state.isPlaying }, time, width, height))
            : getOverlayBounds(ov, time, w, h);
        if (!bounds) return;
        const handle = Math.max(8, Math.min(14, w / 90));

        ctx.save();
        ctx.strokeStyle = '#4c9eff';
        ctx.lineWidth = Math.max(2, w / 540);
        ctx.setLineDash([8, 5]);
        ctx.strokeRect(bounds.x, bounds.y, bounds.w, bounds.h);
        ctx.setLineDash([]);
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = '#4c9eff';
        const points = [
            [bounds.x, bounds.y],
            [bounds.x + bounds.w / 2, bounds.y],
            [bounds.x + bounds.w, bounds.y],
            [bounds.x, bounds.y + bounds.h / 2],
            [bounds.x + bounds.w, bounds.y + bounds.h / 2],
            [bounds.x, bounds.y + bounds.h],
            [bounds.x + bounds.w / 2, bounds.y + bounds.h],
            [bounds.x + bounds.w, bounds.y + bounds.h],
        ];
        for (const [x, y] of points) {
            ctx.fillRect(x - handle / 2, y - handle / 2, handle, handle);
            ctx.strokeRect(x - handle / 2, y - handle / 2, handle, handle);
        }
        ctx.restore();
    }

    // Measure only the selected layer on a transparent surface, using the same
    // renderer and output coordinates as the composed preview.
    function measureEditableBounds(draw, withHit = false) {
        const width = getTargetWidth(), height = getTargetHeight();
        const surface = document.createElement('canvas');
        const scale = Math.min(1, 360 / width);
        surface.width = Math.ceil(width * scale); surface.height = Math.ceil(height * scale);
        const ctx = surface.getContext('2d', {willReadFrequently:true});
        ctx.scale(scale, scale);
        try {
            draw(ctx, width, height, surface);
            const pixels = ctx.getImageData(0, 0, surface.width, surface.height).data;
            const mask=withHit?new Uint8Array(surface.width*surface.height):null;
            let left=surface.width, top=surface.height, right=-1, bottom=-1;
            for (let y=0; y<surface.height; y++) for (let x=0; x<surface.width; x++) {
                if (pixels[(y*surface.width+x)*4+3] < 16) continue;
                if(mask)mask[y*surface.width+x]=1;
                left=Math.min(left,x); right=Math.max(right,x); top=Math.min(top,y); bottom=Math.max(bottom,y);
            }
            if(right<left)return null;
            const bounds={x:left/scale,y:top/scale,w:(right-left+1)/scale,h:(bottom-top+1)/scale};
            if(mask){const mw=surface.width,mh=surface.height;bounds.hitTest=(x,y)=>{const px=Math.floor(x*scale),py=Math.floor(y*scale);return px>=0 && py>=0 && px<mw && py<mh && mask[py*mw+px]===1;};}
            return bounds;
        } catch (_) { return null; }
    }
    function getOverlayBounds(ov, time, canvasW, canvasH) {
        if(ov.title_frame_enabled && ['text','textcard'].includes(ov.type)){
            const w=numberOr(ov.w,100),h=numberOr(ov.h,100),sx=numberOr(ov.scale_x,numberOr(ov.scale,1)),sy=numberOr(ov.scale_y,numberOr(ov.scale,1));
            return {x:numberOr(ov.x,0)+(w-w*sx)/2,y:numberOr(ov.y,0)+(h-h*sy)/2,w:w*sx,h:h*sy};
        }
        let width = ov.type === 'textcard' ? numberOr(ov._renderedW, numberOr(ov.w, 100)) : numberOr(ov.w, 100);
        let height = numberOr(ov.h, 100);
        let x = ov.type === 'textcard' ? numberOr(ov._renderedX, numberOr(ov.x, 0)) : numberOr(ov.x, 0);
        let y = ov.type === 'textcard' && ov._renderedY != null ? numberOr(ov._renderedY, 0) : numberOr(ov.y, 0);
        // 媒体的选择框表示外层窗口，而不是窗口内被移动/缩放后的素材。
        if ((ov.type === 'image' || ov.type === 'video') && ov.media_window_mode) {
            const win = ov.media_window || {};
            if (ov.media_window_mode === 'top_half' || ov.media_window_mode === 'bottom_half') {
                const half=window.ReelsMediaWindow?.halfScreen(ov.media_window_mode,ov.media_split_angle,canvasW,canvasH);
                x=0;y=half?.rect.y ?? (ov.media_window_mode==='top_half'?0:canvasH/2);width=canvasW;height=half?.rect.h ?? canvasH/2;
            } else {
                x = numberOr(win.x, x);
                y = numberOr(win.y, y);
                width = numberOr(win.w, width);
                height = numberOr(win.h, height);
                // PIP 的顶部“变换缩放”缩放的是整个窗口，选择框与预览辅助线
                // 使用同一套中心缩放计算，避免框仍停留在未缩放的旧尺寸。
                const outerScaleX = Math.max(0.01, numberOr(ov.scale_x, numberOr(ov.scale, 1)));
                const outerScaleY = Math.max(0.01, numberOr(ov.scale_y, numberOr(ov.scale, 1)));
                x += (width - width * outerScaleX) / 2;
                y += (height - height * outerScaleY) / 2;
                width *= outerScaleX;
                height *= outerScaleY;
            }
        }
        if (ov.type === 'textcard' && ov._renderedH != null) height = numberOr(ov._renderedH, height);

        if (ov.anim_dest_enabled && ov.type !== 'scroll') {
            const start = numberOr(ov.start, 0);
            const end = numberOr(ov.end, 0);
            if (end > start) {
                const fallbackStartX = (x + width / 2) - canvasW / 2;
                const fallbackStartY = (y + height / 2) - canvasH / 2;
                const startX = numberOr(ov.anim_start_x, fallbackStartX);
                const startY = numberOr(ov.anim_start_y, fallbackStartY);
                const endX = numberOr(ov.anim_end_x, startX);
                const endY = numberOr(ov.anim_end_y, startY);
                const explicitDuration = numberOr(ov.anim_duration, 0);
                const speed = numberOr(ov.anim_speed, 0);
                const distance = Math.hypot(endX - startX, endY - startY);
                const fallbackDuration = end >= 9999 ? 5 : end - start;
                const animDuration = ov.anim_timing_mode === 'speed' && speed > 0
                    ? Math.max(0.001, distance / speed)
                    : (explicitDuration > 0 ? explicitDuration : fallbackDuration);
                let progress = clamp((time - start) / Math.max(0.001, animDuration), 0, 1);
                if (ov._previewAtEnd) progress = 1;
                const easingName = ov.anim_easing || 'ease_in_out_quad';
                const easing = window.ReelsAnimEngine && window.ReelsAnimEngine.EASING_MAP
                    ? window.ReelsAnimEngine.EASING_MAP[easingName] || window.ReelsAnimEngine.EASING_MAP.ease_in_out_quad
                    : null;
                const eased = easing ? easing(progress) : progress;
                const pointX = startX + (endX - startX) * eased;
                const pointY = startY + (endY - startY) * eased;
                x = canvasW / 2 + pointX - width / 2;
                y = canvasH / 2 + pointY - height / 2;
            }
        }
        return { x, y, w: width, h: height };
    }

    function drawSubtitleRange(ctx, style, w, h) {
        const rangeToggle = document.getElementById('reels-show-subtitle-range');
        if (rangeToggle ? !rangeToggle.checked : state.root?.querySelector('[data-role="subtitle-guides"]')?.checked === false) return;
        if (typeof window._drawSubtitlePreviewRange === 'function') {
            window._drawSubtitlePreviewRange(ctx, style, w, h);
            return;
        }
        const x = Number.isFinite(parseFloat(style.range_x)) ? parseFloat(style.range_x) : 0;
        const y = Number.isFinite(parseFloat(style.range_y)) ? parseFloat(style.range_y) : 0;
        const rw = Number.isFinite(parseFloat(style.range_w)) ? parseFloat(style.range_w) : 100;
        const rh = Number.isFinite(parseFloat(style.range_h)) ? parseFloat(style.range_h) : 100;
        if (rw >= 99.9 && rh >= 99.9 && Math.abs(x) < 0.01 && Math.abs(y) < 0.01) return;
        ctx.save();
        ctx.strokeStyle = 'rgba(76, 158, 255, 0.75)';
        ctx.lineWidth = Math.max(2, w / 540);
        ctx.setLineDash([10, 8]);
        ctx.strokeRect((x / 100) * w, (y / 100) * h, (rw / 100) * w, (rh / 100) * h);
        ctx.restore();
    }

    function drawWatermarks(ctx, w, h) {
        const watermarks = (window._reelsState && window._reelsState.watermarks) || [];
        if (!Array.isArray(watermarks) || watermarks.length === 0) return;
        for (const wm of watermarks) {
            if (!wm || !wm.enabled) continue;
            if (wm.type === 'image') drawImageWatermark(ctx, wm, w, h);
            else drawTextWatermark(ctx, wm, w, h);
        }
    }

    function drawImageWatermark(ctx, wm, w, h) {
        if (!wm.imagePath) return;
        const entry = getWatermarkImage(wm.imagePath);
        if (!entry || entry.status !== 'loaded' || !entry.img) return;
        const img = entry.img;
        const imgW = img.naturalWidth || img.width || 0;
        const imgH = img.naturalHeight || img.height || 0;
        if (!(imgW > 0 && imgH > 0)) return;

        const scale = numberOr(wm.imageScale, 100) / 100;
        const dw = imgW * scale;
        const dh = imgH * scale;
        const point = watermarkPoint(wm, w, h);
        let dx = point.x;
        let dy = point.y;
        switch (wm.imageAnchor || 'center') {
            case 'top-left': break;
            case 'top-right': dx -= dw; break;
            case 'bottom-left': dy -= dh; break;
            case 'bottom-right': dx -= dw; dy -= dh; break;
            case 'center':
            default:
                dx -= dw / 2;
                dy -= dh / 2;
                break;
        }

        ctx.save();
        ctx.globalAlpha = clamp(numberOr(wm.opacity, 1), 0, 1);
        drawImageMaybeFlipped(ctx, img, 0, 0, imgW, imgH, dx, dy, dw, dh, !!wm.flipH, !!wm.flipV);
        ctx.restore();
    }

    function drawTextWatermark(ctx, wm, w, h) {
        if (!wm.text) return;
        const fontSize = Math.max(4, numberOr(wm.fontSize, 20));
        const lines = String(wm.text).split('\n');
        const fontFamily = wm.fontFamily || wm.font || 'Arial, sans-serif';
        const padH = Math.round(fontSize * 0.5);
        const padV = Math.round(fontSize * 0.35);
        const lineGap = Math.round(fontSize * 0.18);

        ctx.save();
        ctx.font = `${fontSize}px ${fontFamily}`;
        ctx.textBaseline = 'middle';
        let maxTextW = 0;
        for (const line of lines) maxTextW = Math.max(maxTextW, ctx.measureText(line).width);
        const boxW = maxTextW + padH * 2;
        const boxH = lines.length * fontSize + Math.max(0, lines.length - 1) * lineGap + padV * 2;
        const pos = watermarkBoxPosition(wm, w, h, boxW, boxH);

        const bgOpacity = clamp(numberOr(wm.bgOpacity, 0.5), 0, 1);
        if (bgOpacity > 0) {
            ctx.globalAlpha = bgOpacity;
            ctx.fillStyle = wm.bgColor || '#000000';
            roundRect(ctx, pos.x, pos.y, boxW, boxH, Math.round(fontSize * 0.2));
            ctx.fill();
        }

        ctx.globalAlpha = clamp(numberOr(wm.textOpacity ?? wm.opacity, 1), 0, 1);
        ctx.fillStyle = wm.color || '#FFFFFF';
        if (wm.shadow) {
            ctx.shadowColor = wm.shadowColor || 'rgba(0,0,0,0.65)';
            ctx.shadowBlur = numberOr(wm.shadowBlur, 4);
            ctx.shadowOffsetX = numberOr(wm.shadowX, 1);
            ctx.shadowOffsetY = numberOr(wm.shadowY, 1);
        }
        let y = pos.y + padV + fontSize / 2;
        for (const line of lines) {
            if (wm.stroke) {
                ctx.lineWidth = numberOr(wm.strokeWidth, 3);
                ctx.strokeStyle = wm.strokeColor || '#000000';
                ctx.strokeText(line, pos.x + padH, y);
            }
            ctx.fillText(line, pos.x + padH, y);
            y += fontSize + lineGap;
        }
        ctx.restore();
    }

    function getWatermarkImage(pathValue) {
        const src = toPlayablePath(pathValue);
        if (!src) return null;
        let entry = watermarkImageCache.get(src);
        if (!entry) {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            entry = { img, status: 'loading' };
            img.onload = () => {
                entry.status = 'loaded';
                render();
            };
            img.onerror = () => {
                entry.status = 'error';
                render();
            };
            img.src = src;
            watermarkImageCache.set(src, entry);
        }
        return entry;
    }

    function watermarkPoint(wm, w, h) {
        const margin = 16;
        let x = w - margin;
        let y = margin;
        switch (wm.position || 'top-right') {
            case 'top-left': x = margin; y = margin; break;
            case 'top-center': x = w / 2; y = margin; break;
            case 'top-right': x = w - margin; y = margin; break;
            case 'center-left': x = margin; y = h / 2; break;
            case 'center': x = w / 2; y = h / 2; break;
            case 'center-right': x = w - margin; y = h / 2; break;
            case 'bottom-left': x = margin; y = h - margin; break;
            case 'bottom-center': x = w / 2; y = h - margin; break;
            case 'bottom-right': x = w - margin; y = h - margin; break;
            case 'custom': x = 0; y = 0; break;
        }
        return { x: x + numberOr(wm.x, 0), y: y + numberOr(wm.y, 0) };
    }

    function watermarkBoxPosition(wm, w, h, boxW, boxH) {
        const margin = 16;
        let x = w - boxW - margin;
        let y = margin;
        switch (wm.position || 'top-right') {
            case 'top-left': x = margin; y = margin; break;
            case 'top-center': x = (w - boxW) / 2; y = margin; break;
            case 'top-right': x = w - boxW - margin; y = margin; break;
            case 'center-left': x = margin; y = (h - boxH) / 2; break;
            case 'center': x = (w - boxW) / 2; y = (h - boxH) / 2; break;
            case 'center-right': x = w - boxW - margin; y = (h - boxH) / 2; break;
            case 'bottom-left': x = margin; y = h - boxH - margin; break;
            case 'bottom-center': x = (w - boxW) / 2; y = h - boxH - margin; break;
            case 'bottom-right': x = w - boxW - margin; y = h - boxH - margin; break;
            case 'custom': x = 0; y = 0; break;
        }
        return { x: x + numberOr(wm.x, 0), y: y + numberOr(wm.y, 0) };
    }

    function roundRect(ctx, x, y, w, h, r) {
        if (typeof ctx.roundRect === 'function') {
            ctx.beginPath();
            ctx.roundRect(x, y, w, h, r);
            return;
        }
        const rr = Math.min(r, w / 2, h / 2);
        ctx.beginPath();
        ctx.moveTo(x + rr, y);
        ctx.lineTo(x + w - rr, y);
        ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
        ctx.lineTo(x + w, y + h - rr);
        ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
        ctx.lineTo(x + rr, y + h);
        ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
        ctx.lineTo(x, y + rr);
        ctx.quadraticCurveTo(x, y, x + rr, y);
    }

    function getLiveOverlays(task) {
        const rs = window._reelsState;
        const selected = rs && rs.tasks ? rs.tasks[rs.selectedIdx] : null;
        if (selected === task && rs.overlayProxy && rs.overlayProxy.overlayMgr) {
            window.ReelsLayerSlots?.syncPhoneMedia?.({overlays:rs.overlayProxy.overlayMgr.overlays});
            return rs.overlayProxy.overlayMgr.overlays || [];
        }
        window.ReelsLayerSlots?.syncPhoneMedia?.(task);
        return task.overlays || [];
    }

    function getInsertTrackOverlays(task, width, height) {
        return window.ReelsRenderPlan?.getInsertOverlays?.(task, {
            width: width || state.canvas?.width || 1080,
            height: height || state.canvas?.height || 1920,
        }) || [];
    }

    function findActiveSegment(task, time, style = null) {
        const segs = task && Array.isArray(task.segments) ? task.segments : [];
        if (segs.length === 0) return null;
        const active = segs.find(seg => time >= numberOr(seg.start, 0) && time <= numberOr(seg.end, 0));
        if (active) return active;
        if (!(style && (style.scrolling_mode || style.fullpage_typewriter))) return null;

        // 滚动/打字机模式在句间空隙保留最近一个已开始的片段。
        let nearest = null;
        for (const seg of segs) {
            if (numberOr(seg.start, 0) <= time) nearest = seg;
            else break;
        }
        return nearest;
    }

    function getResolvedStyle(task) {
        if (typeof window._resolveSubtitleStyleForTask === 'function') {
            return window._resolveSubtitleStyleForTask(task);
        }
        if (task && task.subtitleStyle) return clone(task.subtitleStyle);
        if (window._reelsState && window._reelsState.globalSubtitleStyle) {
            return clone(window._reelsState.globalSubtitleStyle);
        }
        if (typeof window._readStyleFromUI === 'function') return window._readStyleFromUI();
        return null;
    }

    function computeDuration() {
        const task = getTask();
        if (!task) return 0;
        const offset = getTimelineOffset(task);

        // ⏱ 文字翻转器 (Dynamic Flipper) 时长优先
        let maxFlipperDuration = 0;
        const overlays = getLiveOverlays(task);
        if (Array.isArray(overlays)) {
            for (const ov of overlays) {
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
        if (maxFlipperDuration > 0) {
            return Math.max(maxFlipperDuration, window.ReelsPlaybackDelay?.minimumDuration(task) || 0) + offset;
        }

        const custom = getEffectiveCustomDuration(task);
        if (custom > 0) return custom + offset;
        const audioDur = mediaDuration(state.audio);
        const audioScale = getAudioDurationScale(task);
        if (audioDur > 0) return (audioDur * Math.max(0.01, audioScale)) + offset;
        const cvDur = mediaDuration(state.contentVideo);
        if (cvDur > 0) {
            const trimStart = parseFloat(task.contentVideoTrimStart) || 0;
            const trimEnd = parseFloat(task.contentVideoTrimEnd) || 0;
            const usable = trimEnd > trimStart ? trimEnd - trimStart : Math.max(0, cvDur - trimStart);
            return Math.max(usable, subtitleDuration(task)) + offset;
        }
        const bgDur = mediaDuration(state.bgVideo);
        const isMultiBg = isMultiBackgroundTask(task);
        const multiDur = isMultiBg ? getMultiBackgroundDuration(task) : 0;
        const subDur = subtitleDuration(task);
        return Math.max(isMultiBg ? 0 : bgDur * getBgDurationScale(task), multiDur, subDur, state.bgImage ? 5 : 0, state.contentImage ? 5 : 0) + offset;
    }

    function getEffectiveCustomDuration(task) {
        const taskCustom = parseFloat(task && task.customDuration || 0);
        if (taskCustom > 0) return taskCustom;
        const globalEl = document.getElementById('reels-custom-duration');
        const globalCustom = parseFloat(globalEl ? globalEl.value : '0');
        return Number.isFinite(globalCustom) && globalCustom > 0 ? globalCustom
            : window.ReelsPlaybackDelay?.minimumDuration(task) || 0;
    }

    function subtitleDuration(task) {
        return task && task.segments && task.segments.length
            ? numberOr(task.segments[task.segments.length - 1].end, 0)
            : 0;
    }

    function updateTimeUI(current, duration) {
        const timeEl = state.root?.querySelector('[data-role="time"]');
        const seekEl = state.root?.querySelector('[data-role="seek"]');
        if (timeEl) timeEl.textContent = `${formatTime(current)}/${formatTime(duration)}`;
        if (seekEl && !state.dragSeek) {
            seekEl.value = duration > 0 ? String(Math.round((current / duration) * 1000)) : '0';
        }
    }

    function updatePlayButton() {
        const btn = state.root?.querySelector('[data-action="play"]');
        if (btn) btn.textContent = state.isPlaying ? 'Ⅱ' : '▶';
    }

    function createTransparentFrame(task, time, dimensions = null, transparent = true, preparedOverlays = null) {
        const canvas = document.createElement('canvas');
        canvas.width = dimensions?.width || state.canvas.width;
        canvas.height = dimensions?.height || state.canvas.height;
        const ctx = canvas.getContext('2d', { alpha: true, willReadFrequently: true });
        const w = canvas.width;
        const h = canvas.height;
        ctx.clearRect(0, 0, w, h);
        const phase = getPhaseInfo(time, task);
        const overlayTime = phase.inCover ? phase.time : phase.mainTime;
        const options = {
            exporting: true, transparent, preparedOverlays,
            renderer: window.ReelsCanvasRenderer ? new window.ReelsCanvasRenderer(canvas) : null,
        };
        const above = task?.overlayAboveSubtitle !== false;
        if (!above) drawOverlays(ctx, task, overlayTime, w, h, phase, options);
        drawSubtitles(ctx, task, phase.mainTime / getAudioDurationScale(task), w, h, phase, options);
        if (above) drawOverlays(ctx, task, overlayTime, w, h, phase, options);
        drawWatermarks(ctx, w, h);
        return canvas;
    }

    async function exportSingleFrame({ time = 0, transparent = false, outputPath, isCancelled, returnCanvas = false, includeHook = false }) {
        if (!state.isOpen) open();
        if (state.isPlaying) togglePlay();
        const task = getTask();
        if (!task) throw new Error('请先选择任务');
        const checkCancelled = () => {
            if (isCancelled?.()) throw new Error('__CANCELLED__');
        };
        const waitFor = async (ready, label) => {
            const deadline = performance.now() + 15000;
            while (!ready()) {
                checkCancelled();
                if (performance.now() > deadline) throw new Error(`${label}加载超时`);
                await new Promise(resolve => setTimeout(resolve, 50));
            }
        };
        const fonts = window.getFontManager?.();
        if (fonts?.ensureFontsLoaded) {
            const style = getResolvedStyle(task) || {};
            const families = fonts.collectFonts({ style, segments: task.segments || [], overlays: getLiveOverlays(task) });
            await fonts.ensureFontsLoaded(families);
        }
        loadCurrentTask(true);
        // 单帧 PNG / 透明覆层帧默认取正片时间，跳过前置 Hook，避免截成钩子第一帧或空白透明图
        const hookOffset = includeHook ? 0 : getHookDuration(task);
        const targetTime = Math.max(0, Number(time) || 0) + hookOffset;
        state.pausedAt = targetTime;
        syncMediaToTime(targetTime);
        if (!transparent) {
            await waitFor(currentVisualIsReady, '背景');
            syncMediaToTime(targetTime);
            await waitFor(() => !isSeekFramePending() && getSeekVisualMedia(targetTime, task).every(media => !media.seeking && media.readyState >= 2), '当前帧');
        }
        // Prepare independent media so the first exported frame cannot miss a
        // lazily loaded image or use a video frame from another task.
        const frameTask = { ...task, overlays: getLiveOverlays(task).map(ov => ({ ...ov })) };
        if (task.cover) frameTask.cover = { ...task.cover, overlays: (task.cover.overlays || []).map(ov => ({ ...ov })) };
        const phase = getPhaseInfo(targetTime, frameTask);
        const overlayTime = phase.inCover ? phase.time : phase.mainTime;
        const overlays = phase.inCover ? frameTask.cover?.overlays || [] : phase.inHook ? [] :
            (window.ReelsRenderPlan?.getCompositedOverlays?.(frameTask, { width: state.canvas.width, height: state.canvas.height }) || frameTask.overlays)
                .filter(ov => !transparent || !ov._insertClip).map(ov => ({ ...ov }));
        for (const ov of overlays) {
            checkCancelled();
            if (ov.disabled || !['image', 'video'].includes(ov.type)) continue;
            if (overlayTime < numberOr(ov.start, 0) || overlayTime > numberOr(ov.end, 9999)) continue;
            let path = ov.content;
            let localTime = Math.max(0, overlayTime - numberOr(ov.start, 0));
            if (ov.media_folder_files?.length && window.ReelsOverlay?.resolveFolderMedia) {
                const playback = window.ReelsOverlay.resolveFolderMedia(ov, overlayTime);
                path = playback.path; localTime = playback.time;
            }
            if (!path) continue;
            if (ov.type === 'image') {
                const img = new Image();
                img.crossOrigin = 'anonymous';
                img.src = toPlayablePath(path);
                await waitFor(() => img.complete, '覆层图片');
                if (!img.naturalWidth) throw new Error(`覆层图片无法加载：${path}`);
                ov._exportImage = img;
                ov._exportFolderImages = { [path]: img };
            } else {
                const video = document.createElement('video');
                video.crossOrigin = 'anonymous';
                video.muted = true; video.preload = 'auto';
                video.src = toPlayablePath(path); video.load();
                try {
                    await waitFor(() => video.readyState >= 2, '覆层视频');
                    const offsetTime = localTime + numberOr(ov.video_start_offset, 0);
                    const seekTime = window.ReelsOverlay?.resolveVideoTime
                        ? window.ReelsOverlay.resolveVideoTime(ov, offsetTime, video.duration, 1 / 30)
                        : Math.min(offsetTime, Math.max(0, video.duration - 0.03));
                    video.currentTime = seekTime;
                    await new Promise(resolve => setTimeout(resolve, 50));
                    await waitFor(() => !video.seeking && video.readyState >= 2, '覆层视频帧');
                    const image = document.createElement('canvas');
                    image.width = video.videoWidth; image.height = video.videoHeight;
                    image.getContext('2d').drawImage(video, 0, 0);
                    ov._currentFrameImage = image;
                } finally {
                    video.pause(); video.removeAttribute('src'); video.load();
                }
            }
        }
        for (const wm of window._reelsState?.watermarks || []) {
            if (wm.enabled && wm.type === 'image' && wm.imagePath) {
                const entry = getWatermarkImage(wm.imagePath);
                await waitFor(() => entry.status !== 'loading', '水印图片');
                if (entry.status !== 'loaded') throw new Error('水印图片无法加载');
            }
        }
        const canvas = createTransparentFrame(frameTask, targetTime, null, transparent, overlays);
        if (!transparent) {
            const ctx = canvas.getContext('2d');
            ctx.save();
            ctx.globalCompositeOperation = 'destination-over';
            // Render background and content on a separate canvas, preserving
            // foreground layer order and excluding editing guides.
            const background = document.createElement('canvas');
            background.width = canvas.width; background.height = canvas.height;
            const bgCtx = background.getContext('2d');
            drawBackground(bgCtx, task, canvas.width, canvas.height, phase);
            drawGlobalMask(bgCtx, getResolvedStyle(task), canvas.width, canvas.height, phase);
            drawContentVideo(bgCtx, task, canvas.width, canvas.height, phase);
            ctx.drawImage(background, 0, 0);
            ctx.restore();
        }
        checkCancelled();
        if (returnCanvas) return canvas;
        const result = await window.electronAPI.savePngFrame({
            outputPath, rawRGBA: canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data.buffer,
            width: canvas.width, height: canvas.height, isPng: false,
        });
        if (result?.ok === false) throw new Error(result.error || 'PNG 写入失败');
        return { outputPath };
    }

    async function captureCurrentFrame(button = null, transparent = false) {
        const snapshotBtn = button || state.root?.querySelector('[data-action="snapshot"]');
        if (!state.canvas || !state.canvas.width || !state.canvas.height) {
            alert('当前预览画布尚未准备好，请等待画面显示后重试。');
            return;
        }
        if (snapshotBtn?.dataset.saving === '1') return;
        if (snapshotBtn) {
            snapshotBtn.dataset.saving = '1';
            snapshotBtn.disabled = true;
            snapshotBtn.textContent = '⌛';
        }
        const api = window.electronAPI;

        const task = getTask();
        const time = Math.max(0, getCurrentTime());
        const safeName = String(task?.fileName || task?.name || 'reels')
            .replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
        const filename = `${safeName}.png`;
        try {
            if (!api?.savePngFrame) throw new Error('当前环境无法保存 PNG 截图');
            if (!task) throw new Error('请先选择一个任务');
            const frameCanvas = await exportSingleFrame({ time, transparent, returnCanvas: true });
            const width = frameCanvas.width;
            const height = frameCanvas.height;
            // Freeze pixels before the save dialog; playback must not change the chosen frame.
            const frameCtx = frameCanvas.getContext('2d', { willReadFrequently: true });
            const rgba = frameCtx.getImageData(0, 0, width, height).data.buffer;
            let outputDir = localStorage.getItem('vk_default_output_dir') || '';
            if (!outputDir && typeof api.getDownloadsPath === 'function') outputDir = await api.getDownloadsPath();
            const sep = String(outputDir).includes('\\') ? '\\' : '/';
            const defaultPath = outputDir
                ? `${String(outputDir).replace(/[\\/]$/, '')}${sep}${filename}`
                : filename;
            // 截图是用户主动保存的文件，必须弹出系统保存窗口；此前静默写到
            // 默认目录，路径不存在或不清楚时会让人以为按钮没有反应。
            let outputPath = defaultPath;
            if (typeof api.saveFile === 'function') {
                const chosen = await api.saveFile({
                    title: transparent ? '保存当前单帧透明 PNG' : '保存当前合成画面',
                    defaultPath,
                    filters: [{ name: 'PNG 图片', extensions: ['png'] }],
                });
                if (chosen?.canceled) return;
                if (!chosen?.success || !chosen.filePath) throw new Error(chosen?.error || '未获得保存路径');
                outputPath = chosen.filePath;
            } else if (!outputDir) {
                throw new Error('当前环境不支持选择保存位置');
            }
            if (typeof api.ensureDirectory === 'function' && outputDir) await api.ensureDirectory(outputDir);
            // 直接取合成画布 RGBA 像素交给主进程编码，避免 Electron 某些
            // canvas 实现的 toBlob 回调不触发或返回空 Blob。
            const result = await api.savePngFrame({
                outputPath,
                rawRGBA: rgba,
                width,
                height,
                isPng: false,
            });
            if (result?.ok === false) throw new Error(result.error || '写入文件失败');
            if (typeof window.showToast === 'function') window.showToast(`已保存当前帧：${outputPath}`, 'success');
            else alert(`已保存当前帧：\n${outputPath}`);
        } catch (error) {
            console.error('[PreviewV2] snapshot failed', error);
            alert(`保存当前帧失败：${error.message || error}`);
        } finally {
            if (snapshotBtn) {
                delete snapshotBtn.dataset.saving;
                snapshotBtn.disabled = false;
                snapshotBtn.textContent = transparent ? '透明 PNG' : '📸';
            }
        }
    }

    function updateTitle(task) {
        const title = state.root?.querySelector('[data-role="title"]');
        if (!title) return;
        const name = task ? (task.fileName || task.name || task.audioName || `任务 ${getSelectedIndex() + 1}`) : '独立预览';
        title.textContent = `独立预览 - ${name}`;
        title.title = '';
    }

    function syncLoopFlags() {
        const loop = isLoopEnabled();
        state.bgVideo.loop = loop;
        state.bgFadeVideo.loop = loop;
        state.audio.loop = loop;
        state.bgmAudio.loop = loop;
        state.contentVideo.loop = loop;
        state.hookVideo.loop = false;
        if (state.hookAudio) state.hookAudio.loop = false;
        state.coverVideo.loop = loop;
    }

    function getTask() {
        const rs = window._reelsState;
        if (!rs || !Array.isArray(rs.tasks) || rs.selectedIdx < 0) return null;
        const task = rs.tasks[rs.selectedIdx] || null;
        // 预览与导出都在入口处执行同一份时间线→渲染字段同步。
        return window.ReelsRenderPlan?.syncLegacyFields(task) || task;
    }

    function getSelectedIndex() {
        const rs = window._reelsState;
        return rs && Number.isInteger(rs.selectedIdx) ? rs.selectedIdx : -1;
    }

    function getTargetWidth() {
        const rs = window._reelsState;
        return window.ReelsLayoutTemplate?.taskCanvas?.(rs?.tasks?.[rs.selectedIdx], rs)?.width || rs?.targetWidth || DEFAULT_W;
    }

    function getTargetHeight() {
        const rs = window._reelsState;
        return window.ReelsLayoutTemplate?.taskCanvas?.(rs?.tasks?.[rs.selectedIdx], rs)?.height || rs?.targetHeight || DEFAULT_H;
    }

    function getBackgroundPath(task) {
        if (!task) return '';
        if (typeof window._resolvePreviewBackgroundPath === 'function') {
            const resolved = window._resolvePreviewBackgroundPath(task);
            return resolved && resolved.path ? resolved.path : '';
        }
        if (task.bgMode === 'multi' && Array.isArray(task.bgClipPool) && task.bgClipPool.length > 0) {
            return task.bgClipPool.find(Boolean) || '';
        }
        return task.bgPath || task.videoPath || '';
    }

    function getEffectiveBgClipPool(task) {
        if (!task) return [];
        if (typeof window._getEffectiveBgClipPool === 'function') {
            return window._getEffectiveBgClipPool(task) || [];
        }
        const pool = Array.isArray(task.bgClipPool) ? task.bgClipPool.filter(Boolean) : [];
        const active = Array.isArray(task.bgClipActivePool)
            ? task.bgClipActivePool.filter(path => path && pool.includes(path))
            : [];
        return active.length > 0 ? active : pool;
    }

    function isMultiBackgroundTask(task) {
        return !!(task && task.bgMode === 'multi' && getEffectiveBgClipPool(task).length > 0);
    }

    function getPreviewMultiClipPool(task) {
        const pool = getEffectiveBgClipPool(task);
        const isRandom = task && (task.bgClipOrder === 'random' || task.bgClipOrder === 'random_align');
        if (!isRandom || pool.length <= 1) return pool;
        const seedText = `${task.id || task.fileName || ''}|${pool.join('|')}`;
        const rng = mulberry32(presetSeed(seedText));
        const shuffled = pool.slice();
        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(rng() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        return shuffled;
    }

    function getMultiClipBaseDuration(task, path) {
        let trimStart = 0;
        let trimEnd = null;
        const settings = task && task.bgClipSettings && task.bgClipSettings[path];
        if (settings) {
            if (settings.trimStart != null) trimStart = numberOr(settings.trimStart, 0);
            if (settings.trimEnd != null) trimEnd = numberOr(settings.trimEnd, 0);
        }
        let dur = 5;
        if (!isImagePath(path)) {
            if (trimEnd != null && trimEnd > trimStart) {
                dur = trimEnd - trimStart;
            } else if (window._reelsState && window._reelsState._multiBgDurations && window._reelsState._multiBgDurations[path] > 0) {
                dur = window._reelsState._multiBgDurations[path] - trimStart;
            }
        }
        const factor = Math.max(0.01, numberOr(task && task.bgDurScale, 100) / 100);
        return Math.max(0.5, dur) * factor;
    }

    function calculateMultiBackgroundSegments(task) {
        const pool = getPreviewMultiClipPool(task);
        if (!pool.length) return [];
        const factor = Math.max(0.01, numberOr(task && task.bgDurScale, 100) / 100);
        const clips = pool.map(path => {
            const settings = task && task.bgClipSettings && task.bgClipSettings[path];
            const trimStart = settings && settings.trimStart != null ? numberOr(settings.trimStart, 0) : 0;
            return {
                path,
                isImage: isImagePath(path),
                trimStart,
                speedFactor: factor,
                baseDuration: getMultiClipBaseDuration(task, path),
            };
        });

        const isAlign = task && (task.bgClipOrder === 'random_align' || task.bgClipOrder === 'sequence_align');
        const audioScale = getAudioDurationScale(task);
        const rawSegments = Array.isArray(task && task.segments) ? task.segments : [];
        const audioDurRaw = mediaDuration(state.audio);
        const hasAudioDuration = audioDurRaw > 0;
        const segments = hasAudioDuration && Math.abs(audioScale - 1) > 0.001
            ? rawSegments.map(seg => ({
                ...seg,
                start: numberOr(seg.start, 0) * audioScale,
                end: numberOr(seg.end, 0) * audioScale,
                words: Array.isArray(seg.words) ? seg.words.map(w => ({
                    ...w,
                    start: numberOr(w.start, 0) * audioScale,
                    end: numberOr(w.end, 0) * audioScale,
                })) : seg.words,
            }))
            : rawSegments;
        const subDur = segments.length ? numberOr(segments[segments.length - 1].end, 0) : 0;
        const transitionTypeForDuration = task && task.bgTransition || 'crossfade';
        const transitionOverlap = transitionTypeForDuration !== 'none' ? Math.max(0, numberOr(task && task.bgTransDur, 0.5)) : 0;
        const poolRawDur = clips.reduce((sum, c) => sum + c.baseDuration, 0);
        const poolDur = Math.max(0.5, poolRawDur - transitionOverlap * Math.max(0, clips.length - 1));
        const totalDur = hasAudioDuration
            ? Math.max(audioDurRaw * audioScale, 0.5)
            : Math.max(subDur || 0, poolDur, 5);
        const result = [];

        if (isAlign && segments.length > 0) {
            const cutPoints = [0];
            const preSwitchOffset = 0.2;
            const bgMinClipDur = task.bgMinClipDur !== undefined ? numberOr(task.bgMinClipDur, 5) : 5;
            const bgMaxClipDur = task.bgMaxClipDur !== undefined ? numberOr(task.bgMaxClipDur, 7) : 7;
            const originalScript = task.ttsText || task.aiScript || task.txtContent || '';

            const getSentenceBoundaries = (segs, originalText) => {
                const strongBoundaries = new Set();
                const weakBoundaries = new Set();
                if (!segs || segs.length === 0) return { strongBoundaries, weakBoundaries };

                const lastIdx = segs.length - 1;
                strongBoundaries.add(lastIdx);

                const sentencePunct = new Set([
                    '。', '！', '？', '，', '、', '；', '：',
                    '.', '!', '?', ',', ';', ':', '\n', '\r',
                    '…', '—', '“', '”', '‘', '’', '（', '）',
                    '(', ')', '[', ']', '【', '】'
                ]);
                const strongPunct = new Set(['。', '！', '？', '.', '!', '?', '\n', '\r', '…', '—']);

                segs.forEach((seg, i) => {
                    const txt = String(seg.edited_text || seg.text || '').trim();
                    if (txt && sentencePunct.has(txt[txt.length - 1])) {
                        const char = txt[txt.length - 1];
                        if (strongPunct.has(char)) strongBoundaries.add(i);
                        else weakBoundaries.add(i);
                    }
                });

                if (!originalText) return { strongBoundaries, weakBoundaries };

                const rawChars = Array.from(originalText);
                const cleanOriginalText = [];
                const cleanToRawMap = [];
                for (let i = 0; i < rawChars.length; i++) {
                    const char = rawChars[i];
                    if (!/\s/.test(char) && !sentencePunct.has(char)) {
                        cleanToRawMap.push(i);
                        cleanOriginalText.push(char);
                    }
                }
                const cleanOrigStr = cleanOriginalText.join('');

                let accumulatedCleanText = '';
                for (let idx = 0; idx < segs.length; idx++) {
                    const segVal = segs[idx].edited_text || segs[idx].text || '';
                    const cleanSegText = String(segVal)
                        .replace(/\s+/g, '')
                        .split('')
                        .filter(c => !sentencePunct.has(c))
                        .join('');

                    accumulatedCleanText += cleanSegText;
                    if (accumulatedCleanText.length === 0) continue;

                    const matchIdx = cleanOrigStr.toLowerCase().indexOf(accumulatedCleanText.toLowerCase());
                    if (matchIdx === -1) continue;

                    const endCleanIdx = matchIdx + accumulatedCleanText.length - 1;
                    const endRawIdx = cleanToRawMap[endCleanIdx];
                    if (endRawIdx === undefined) continue;

                    let isBoundary = false;
                    let matchedChar = '';
                    let k = endRawIdx + 1;
                    for (; k < rawChars.length; k++) {
                        const nextChar = rawChars[k];
                        if (sentencePunct.has(nextChar)) {
                            isBoundary = true;
                            matchedChar = nextChar;
                            break;
                        }
                        if (!/\s/.test(nextChar)) break;
                    }
                    if (k === rawChars.length) isBoundary = true;
                    if (isBoundary) {
                        if (k === rawChars.length || strongPunct.has(matchedChar)) strongBoundaries.add(idx);
                        else weakBoundaries.add(idx);
                    }
                }
                return { strongBoundaries, weakBoundaries };
            };

            const { strongBoundaries, weakBoundaries } = getSentenceBoundaries(segments, originalScript);
            const strongCandidates = [];
            const weakCandidates = [];
            const allCandidates = [];

            segments.forEach((seg, idx) => {
                const endVal = numberOr(seg.end, 0);
                if (endVal > 0) {
                    const shiftedPt = Math.max(0.1, endVal - preSwitchOffset);
                    if (shiftedPt < totalDur) {
                        allCandidates.push(shiftedPt);
                        if (strongBoundaries.has(idx)) strongCandidates.push(shiftedPt);
                        else if (weakBoundaries.has(idx)) weakCandidates.push(shiftedPt);
                    }
                }
            });

            const sortedStrongCands = Array.from(new Set(strongCandidates)).sort((a, b) => a - b);
            const sortedWeakCands = Array.from(new Set(weakCandidates)).sort((a, b) => a - b);
            const sortedAllCands = Array.from(new Set(allCandidates)).sort((a, b) => a - b);

            const preferredSplit = Math.max(1.0, bgMinClipDur > 0 ? Math.min(bgMaxClipDur, bgMinClipDur + 1) : 5);
            const minOk = Math.max(1.0, bgMinClipDur - 1.0);
            const maxOk = bgMaxClipDur + 1.0;
            let lastCut = 0;
            let candIdx = 0;

            while (candIdx < sortedAllCands.length) {
                const remainingAll = sortedAllCands.filter(pt => pt > lastCut + 0.01);
                if (remainingAll.length === 0) break;

                const remainingStrong = sortedStrongCands.filter(pt => pt > lastCut + 0.01);
                const remainingWeak = sortedWeakCands.filter(pt => pt > lastCut + 0.01);

                let bestPt = null;
                for (const pt of remainingStrong) {
                    const dist = pt - lastCut;
                    if (dist >= minOk && dist <= maxOk) {
                        if (bestPt === null || Math.abs(dist - preferredSplit) < Math.abs(bestPt - lastCut - preferredSplit)) {
                            bestPt = pt;
                        }
                    }
                }

                if (bestPt === null) {
                    for (const pt of remainingWeak) {
                        const dist = pt - lastCut;
                        if (dist >= minOk && dist <= maxOk) {
                            if (bestPt === null || Math.abs(dist - preferredSplit) < Math.abs(bestPt - lastCut - preferredSplit)) {
                                bestPt = pt;
                            }
                        }
                    }
                }

                if (bestPt !== null) {
                    cutPoints.push(bestPt);
                    lastCut = bestPt;
                    const idx = sortedAllCands.indexOf(bestPt);
                    candIdx = idx !== -1 ? idx + 1 : candIdx + 1;
                    continue;
                }

                const hasExceedingStrong = remainingStrong.some(pt => pt - lastCut > maxOk);
                const hasExceedingWeak = remainingWeak.some(pt => pt - lastCut > maxOk);
                if (!hasExceedingStrong && !hasExceedingWeak) break;

                const smallerStrong = remainingStrong.filter(pt => pt - lastCut < minOk);
                const smallerWeak = remainingWeak.filter(pt => pt - lastCut < minOk);
                let forcedPt = null;
                if (smallerStrong.length > 0) {
                    forcedPt = smallerStrong[smallerStrong.length - 1];
                } else if (smallerWeak.length > 0) {
                    forcedPt = smallerWeak[smallerWeak.length - 1];
                } else {
                    for (const pt of remainingAll) {
                        const dist = pt - lastCut;
                        if (dist >= minOk && dist <= maxOk) {
                            if (forcedPt === null || Math.abs(dist - preferredSplit) < Math.abs(forcedPt - lastCut - preferredSplit)) {
                                forcedPt = pt;
                            }
                        }
                    }
                    if (forcedPt === null) forcedPt = lastCut + preferredSplit;
                }

                cutPoints.push(forcedPt);
                lastCut = forcedPt;
                const idx = sortedAllCands.indexOf(forcedPt);
                candIdx = idx !== -1 ? idx + 1 : candIdx + 1;
            }

            if (bgMaxClipDur > 0) {
                while ((totalDur - lastCut) > bgMaxClipDur) {
                    const nextForcedCut = lastCut + preferredSplit;
                    cutPoints.push(nextForcedCut);
                    lastCut = nextForcedCut;
                }
            }
            if (cutPoints.length > 1 && totalDur - cutPoints[cutPoints.length - 1] < 1.5) {
                cutPoints[cutPoints.length - 1] = totalDur;
            } else if (cutPoints[cutPoints.length - 1] < totalDur - 0.01) {
                cutPoints.push(totalDur);
            } else {
                cutPoints[cutPoints.length - 1] = totalDur;
            }

            for (let i = 0; i < cutPoints.length - 1; i++) {
                const clip = clips[i % clips.length];
                result.push({
                    ...clip,
                    start: cutPoints[i],
                    end: cutPoints[i + 1],
                    duration: cutPoints[i + 1] - cutPoints[i],
                });
            }
            return result;
        }

        let cursor = 0;
        for (let i = 0; i < clips.length * 20 && cursor < totalDur; i++) {
            const clip = clips[i % clips.length];
            const start = cursor;
            const end = Math.min(totalDur, start + clip.baseDuration);
            result.push({ ...clip, start, end, duration: end - start });
            if (end >= totalDur - 0.001) break;
            cursor = Math.max(start + 0.01, end - transitionOverlap);
        }
        return result;
    }

    function getMultiBackgroundDuration(task) {
        const segs = calculateMultiBackgroundSegments(task);
        return segs.length ? segs[segs.length - 1].end : 0;
    }

    function resolveMultiBackgroundAtTime(task, timeSec) {
        const segments = calculateMultiBackgroundSegments(task);
        if (!segments.length) return null;
        const total = segments[segments.length - 1].end;
        const atEnd = isAtTimelineEnd(getTimelineOffset(task) + (timeSec || 0));
        const loopTime = isLoopEnabled() && total > 0
            ? loopMediaTime(timeSec || 0, total, atEnd)
            : Math.min(timeSec || 0, Math.max(0, total - 0.001));
        const current = segments.find(seg => loopTime >= seg.start && loopTime < seg.end) || segments[segments.length - 1];
        const index = segments.indexOf(current);
        const transitionType = task.bgTransition || 'crossfade';
        const transitionDur = transitionType !== 'none' ? numberOr(task.bgTransDur, 0.5) : 0;
        const localTime = (seg) => seg.trimStart + Math.max(0, loopTime - seg.start) / Math.max(0.01, seg.speedFactor);
        let transition = null;
        if (transitionDur > 0 && index > 0 && loopTime < current.start + transitionDur) {
            const prev = segments[index - 1];
            transition = {
                ...prev,
                localTime: localTime(prev),
                progress: (loopTime - current.start) / transitionDur,
                type: transitionType,
            };
        }
        return {
            current: { ...current, localTime: localTime(current) },
            transition,
            totalDuration: total,
        };
    }

    function getHookPath(task) {
        if (!task) return '';
        const globalIntroPath = (document.getElementById('reels-intro-path') || {}).value || '';
        if (window.ReelsHookUtils) {
            return window.ReelsHookUtils.resolveHookVideoPath(task, globalIntroPath) || '';
        }
        if (typeof window._resolveTaskHookPath === 'function') {
            return window._resolveTaskHookPath(task, globalIntroPath) || '';
        }
        if (task.hookFile === '__NONE__') return '';
        if (task.hookFile) return task.hookFile;
        if (task.hook && task.hook.path) return task.hook.path;
        return globalIntroPath;
    }

    function getHookAudioPath(task) {
        if (!task) return '';
        if (window.ReelsHookUtils) return window.ReelsHookUtils.resolveHookAudioPath(task) || '';
        return String(task.hookAudioFile || '').trim();
    }

    function getCoverDuration(task) {
        return task && task.cover && task.cover.enabled ? Math.max(0, numberOr(task.cover.duration, 0.01)) : 0;
    }

    function getHookDuration(task) {
        const hookPath = getHookPath(task);
        if (!task || !hookPath) return 0;
        if (window.ReelsHookUtils && !window.ReelsHookUtils.isSupportedHookVideoPath(hookPath)) return 0;
        const rawDur = mediaDuration(state.hookVideo);
        if (rawDur > 0) {
            if (window.ReelsHookUtils) {
                const timing = window.ReelsHookUtils.computeHookVideoTiming(task, rawDur);
                return timing.valid ? timing.outputDuration : 0;
            }
            const trimStart = Math.max(0, numberOr(task.hookTrimStart, 0));
            const trimEndRaw = numberOr(task.hookTrimEnd, 0);
            const trimEnd = trimEndRaw > trimStart ? Math.min(rawDur, trimEndRaw) : rawDur;
            const speed = Math.max(0.1, numberOr(task.hookSpeed, 1));
            return Math.max(0, trimEnd - trimStart) / speed;
        }
        // 元数据尚未加载时，不借用上一条任务的旧 hookDuration，仅按本任务规则保守估算
        const speed = Math.max(0.1, numberOr(task.hookSpeed, 1));
        const mode = window.ReelsHookUtils ? window.ReelsHookUtils.inferHookDurationMode(task) : 'full';
        if (mode === 'first3') return 3 / speed;
        if (mode === 'custom') {
            const s = Math.max(0, numberOr(task.hookTrimStart, 0));
            const e = numberOr(task.hookTrimEnd, 0);
            if (e > s) return (e - s) / speed;
        }
        return Math.max(0, numberOr(task.hookDuration, 0));
    }

    function getTimelineOffset(task) {
        return getCoverDuration(task) + getHookDuration(task);
    }

    function getPhaseInfo(time, task) {
        const coverDuration = getCoverDuration(task);
        const hookDuration = getHookDuration(task);
        const inCover = coverDuration > 0 && time < coverDuration;
        const inHook = !inCover && hookDuration > 0 && time < coverDuration + hookDuration;
        return {
            time,
            coverDuration,
            hookDuration,
            inCover,
            inHook,
            mainTime: Math.max(0, time - coverDuration - hookDuration),
        };
    }

    function getBgmPath(task) {
        if (!task) return '';
        if (typeof window._getEffectiveBgmPath === 'function') {
            return window._getEffectiveBgmPath(task, getSelectedIndex()) || '';
        }
        if (task.bgmMode === 'multi' && Array.isArray(task.bgmClipPool) && task.bgmClipPool.length > 0) {
            const active = Array.isArray(task.bgmClipActivePool) && task.bgmClipActivePool.length > 0
                ? task.bgmClipActivePool.filter(path => path && task.bgmClipPool.includes(path))
                : task.bgmClipPool.filter(Boolean);
            return active[0] || '';
        }
        return task.bgmPath || '';
    }

    function applyAudioVolumes(task) {
        const routed = setupAudioGraph(task);
        const voicePct = effectiveVoiceVolume(task);
        const bgPct = effectiveBgVolume(task);
        const bgmPct = effectiveBgmVolume(task);
        const contentPct = numberOr(task && task.contentVideoVolume, 100);
        applyVolume(state.audio, voicePct, routed);
        applyVolume(state.bgVideo, bgPct, routed);
        applyVolume(state.bgFadeVideo, bgPct, routed);
        applyVolume(state.bgmAudio, bgmPct, routed);
        applyVolume(state.contentVideo, contentPct, routed);
        // 钩子声音：支持原声 / 静音 / 独立钩子配音
        const hookDur = getHookDuration(task);
        const hookAudioPlan = window.ReelsHookUtils
            ? window.ReelsHookUtils.computeHookAudioPlan(task, hookDur)
            : { mode: getHookAudioPath(task) ? 'custom_audio' : (task?.hookKeepAudio === false ? 'mute' : 'original'), volumePct: 100 };
        if (hookAudioPlan.mode === 'custom_audio') {
            applyVolume(state.hookVideo, 0, false);
            applyVolume(state.hookAudio, hookAudioPlan.volumePct, false);
        } else if (hookAudioPlan.mode === 'original') {
            applyVolume(state.hookVideo, hookAudioPlan.volumePct, false);
            applyVolume(state.hookAudio, 0, false);
        } else {
            applyVolume(state.hookVideo, 0, false);
            applyVolume(state.hookAudio, 0, false);
        }
    }

    function applyPlaybackRates(task) {
        const audioScale = getAudioDurationScale(task);
        const bgScale = getBgDurationScale(task);
        setPlaybackRate(state.audio, state.playbackSpeed / audioScale);
        setPlaybackRate(state.bgmAudio, state.playbackSpeed);
        setPlaybackRate(state.coverVideo, state.playbackSpeed);
        setPlaybackRate(state.bgVideo, state.playbackSpeed / bgScale);
        setPlaybackRate(state.bgFadeVideo, state.playbackSpeed / bgScale);
        setPlaybackRate(state.contentVideo, state.playbackSpeed);
        if (state.hookVideo) setPlaybackRate(state.hookVideo, Math.max(0.1, numberOr(task && task.hookSpeed, 1)) * state.playbackSpeed);
        if (state.hookAudio) setPlaybackRate(state.hookAudio, state.playbackSpeed);
    }

    function setPlaybackRate(media, rate) {
        if (!media) return;
        const next = clamp(Number.isFinite(rate) ? rate : 1, 0.05, 16);
        if (Math.abs((media.playbackRate || 1) - next) > 0.001) {
            media.playbackRate = next;
        }
        try { media.preservesPitch = true; } catch (_) {}
    }

    function getAudioDurationScale(task) {
        return Math.max(0.01, numberOr(task && task.audioDurScale, 100) / 100);
    }

    function getBgDurationScale(task) {
        return Math.max(0.01, numberOr(task && task.bgDurScale, 100) / 100);
    }

    function applyVolume(media, pct, routed) {
        if (!media) return;
        const gain = window.__reelsOverviewMuted ? 0 : Math.max(0, numberOr(pct, 100) / 100);
        const gainNode = routed && state.gainNodes.get(media);
        if (gainNode && state.audioCtx) {
            gainNode.gain.setValueAtTime(gain, state.audioCtx.currentTime);
            media.volume = gain > 0 ? 1 : 0;
        } else {
            media.volume = clamp(gain, 0, 1);
        }
        media.muted = gain <= 0.001;
    }

    function setupAudioGraph(task) {
        const cfg = readAudioFxConfig();
        const needsFx = cfg.enabled || cfg.stereoWidth > 1.05;
        if (!needsFx && !state.audioCtx) return false;

        const els = [state.audio, state.bgVideo, state.bgFadeVideo, state.contentVideo, state.bgmAudio].filter(Boolean);
        if (!els.length) return false;

        if (!state.audioCtx) {
            try {
                state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            } catch (err) {
                console.warn('[PreviewV2] Web Audio unavailable', err);
                return false;
            }
        }

        for (const el of els) {
            if (!state.mediaSources.has(el)) {
                try {
                    state.mediaSources.set(el, state.audioCtx.createMediaElementSource(el));
                } catch (err) {
                    console.warn('[PreviewV2] failed to route media element', err);
                }
            }
            if (!state.gainNodes.has(el)) {
                const gainNode = state.audioCtx.createGain();
                gainNode.gain.setValueAtTime(1, state.audioCtx.currentTime);
                state.gainNodes.set(el, gainNode);
            }
        }

        const sig = [
            cfg.enabled ? '1' : '0',
            cfg.preset,
            cfg.mix,
            cfg.stereoWidth,
            cfg.target,
            state.audio.src ? 'voice' : '',
            state.bgVideo.src ? 'bg' : '',
            state.bgFadeVideo.src ? 'bg2' : '',
            state.contentVideo.src ? 'content' : '',
            state.bgmAudio.src ? 'bgm' : '',
        ].join('|');
        if (sig === state.audioFxSig) return true;
        state.audioFxSig = sig;

        disconnectAudioNodesOnly();
        for (const [el, source] of state.mediaSources.entries()) {
            const gainNode = state.gainNodes.get(el);
            if (!gainNode) continue;
            try { source.connect(gainNode); } catch (_) {}
        }

        const targetEl = needsFx ? pickAudioFxTarget(cfg.target, task) : null;
        const targetGain = targetEl ? state.gainNodes.get(targetEl) : null;
        for (const [el, gainNode] of state.gainNodes.entries()) {
            if (!gainNode || el === targetEl) continue;
            try { gainNode.connect(state.audioCtx.destination); } catch (_) {}
        }

        if (!needsFx || !targetGain) {
            if (targetGain) {
                try { targetGain.connect(state.audioCtx.destination); } catch (_) {}
            }
            return true;
        }

        const master = state.audioCtx.createGain();
        master.gain.value = 1;
        const dry = state.audioCtx.createGain();
        dry.gain.value = cfg.enabled ? (1 - cfg.mix * 0.5) : 1;
        targetGain.connect(dry);
        dry.connect(master);
        state.audioFxNodes.push(master, dry);

        if (cfg.enabled) {
            const convolver = state.audioCtx.createConvolver();
            convolver.buffer = generateImpulseResponse(state.audioCtx, cfg.preset);
            const wet = state.audioCtx.createGain();
            wet.gain.value = cfg.mix;
            targetGain.connect(convolver);
            convolver.connect(wet);
            wet.connect(master);
            state.audioFxNodes.push(convolver, wet);
        }

        if (cfg.stereoWidth > 1.05) {
            const splitter = state.audioCtx.createChannelSplitter(2);
            const merger = state.audioCtx.createChannelMerger(2);
            const delayL = state.audioCtx.createDelay(0.05);
            const delayR = state.audioCtx.createDelay(0.05);
            const widthFactor = Math.max(0, cfg.stereoWidth - 1) * 0.015;
            delayL.delayTime.value = widthFactor * 0.3;
            delayR.delayTime.value = widthFactor * 0.7;
            master.connect(splitter);
            splitter.connect(delayL, 0);
            splitter.connect(delayR, 1);
            delayL.connect(merger, 0, 0);
            delayR.connect(merger, 0, 1);
            merger.connect(state.audioCtx.destination);
            state.audioFxNodes.push(splitter, merger, delayL, delayR);
        } else {
            master.connect(state.audioCtx.destination);
        }
        return true;
    }

    function disconnectAudioGraph() {
        disconnectAudioNodesOnly();
        state.audioFxSig = '';
    }

    function disconnectAudioNodesOnly() {
        for (const source of state.mediaSources.values()) {
            try { source.disconnect(); } catch (_) {}
        }
        for (const gainNode of state.gainNodes.values()) {
            try { gainNode.disconnect(); } catch (_) {}
        }
        for (const node of state.audioFxNodes) {
            try { node.disconnect(); } catch (_) {}
        }
        state.audioFxNodes = [];
    }

    function pickAudioFxTarget(target, task) {
        if ((target === 'voice' || target === 'all') && state.audio.src && task && task.audioPath) return state.audio;
        if ((target === 'bg' || target === 'all') && state.bgVideo.src) return state.bgVideo;
        if ((target === 'content' || target === 'all') && state.contentVideo.src) return state.contentVideo;
        if ((target === 'bgm' || target === 'all') && state.bgmAudio.src && task && getBgmPath(task)) return state.bgmAudio;
        if (state.audio.src && task && task.audioPath) return state.audio;
        if (state.bgVideo.src) return state.bgVideo;
        if (state.bgmAudio.src && task && getBgmPath(task)) return state.bgmAudio;
        if (state.contentVideo.src) return state.contentVideo;
        return null;
    }

    function readAudioFxConfig() {
        return {
            enabled: document.getElementById('reels-reverb-enabled')?.checked || false,
            preset: document.getElementById('reels-reverb-preset')?.value || 'hall',
            mix: clamp(readNumberInput('reels-reverb-mix', 30) / 100, 0, 1),
            stereoWidth: Math.max(0, readNumberInput('reels-stereo-width', 100) / 100),
            target: document.getElementById('reels-audio-fx-target')?.value || 'all',
        };
    }

    function generateImpulseResponse(ctx, preset) {
        const config = REVERB_PRESETS[preset] || REVERB_PRESETS.hall;
        const sampleRate = ctx.sampleRate;
        const length = Math.ceil(sampleRate * config.duration);
        const buffer = ctx.createBuffer(2, length, sampleRate);
        for (let ch = 0; ch < 2; ch++) {
            const rng = mulberry32(presetSeed(preset || 'hall') + ch * 0xDEAD);
            const data = buffer.getChannelData(ch);
            for (let i = 0; i < length; i++) {
                const t = i / sampleRate;
                const envelope = Math.exp(-t / (config.decay * 0.3));
                data[i] = (rng() * 2 - 1) * envelope;
            }
        }
        return buffer;
    }

    function presetSeed(preset) {
        let h = 0x811c9dc5;
        for (let i = 0; i < preset.length; i++) {
            h ^= preset.charCodeAt(i);
            h = Math.imul(h, 0x01000193);
        }
        return h >>> 0;
    }

    function mulberry32(seed) {
        return function () {
            seed |= 0;
            seed = seed + 0x6D2B79F5 | 0;
            let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
            t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
            return ((t ^ t >>> 14) >>> 0) / 4294967296;
        };
    }

    function effectiveVoiceVolume(task) {
        if (typeof window._getEffectiveVoiceVolumePercent === 'function') {
            return window._getEffectiveVoiceVolumePercent(task);
        }
        const global = readNumberInput('reels-voice-volume', 100);
        const raw = task && task.voiceVolume != null ? parseFloat(task.voiceVolume) : NaN;
        return Number.isFinite(raw) ? Math.max(0, global) * Math.max(0, raw) / 100 : Math.max(0, global);
    }

    function effectiveBgVolume(task) {
        if (typeof window._getEffectiveBgVolumePercent === 'function') {
            return window._getEffectiveBgVolumePercent(task);
        }
        const global = readNumberInput('reels-bg-volume', 100);
        const raw = task && task.bgVideoVolume != null ? parseFloat(task.bgVideoVolume) : NaN;
        if (Number.isFinite(raw)) return Math.max(0, global) * Math.max(0, raw) / 100;
        const ui = readCustomTaskVolume('reels-bg-volume-range', 'reels-bg-volume-num');
        return ui == null ? Math.max(0, global) : Math.max(0, global) * Math.max(0, ui) / 100;
    }

    function effectiveBgmVolume(task) {
        if (typeof window._getEffectiveBgmVolumePercent === 'function') {
            return window._getEffectiveBgmVolumePercent(task);
        }
        const global = readNumberInput('reels-bgm-volume', 30);
        const raw = task && task.bgmVolume != null ? parseFloat(task.bgmVolume) : NaN;
        if (Number.isFinite(raw)) return Math.max(0, global) * Math.max(0, raw) / 100;
        const ui = readCustomTaskVolume('reels-bgm-task-volume-range', 'reels-bgm-task-volume-num');
        return ui == null ? Math.max(0, global) : Math.max(0, global) * Math.max(0, ui) / 100;
    }

    function readCustomTaskVolume(rangeId, numId) {
        const range = document.getElementById(rangeId);
        const num = document.getElementById(numId);
        const isCustom = range?.dataset?.isCustom === 'true' || num?.dataset?.isCustom === 'true';
        if (!isCustom) return null;
        const value = parseFloat((num && num.value !== '') ? num.value : (range || {}).value);
        return Number.isFinite(value) ? value : null;
    }

    function readNumberInput(id, fallback) {
        const el = document.getElementById(id);
        const value = parseFloat(el ? el.value : '');
        return Number.isFinite(value) ? value : fallback;
    }

    function toPlayablePath(path) {
        if (!path) return '';
        if (typeof window._toPlayablePath === 'function') return window._toPlayablePath(path, null);
        if (window.electronAPI && typeof window.electronAPI.toFileUrl === 'function') {
            const url = window.electronAPI.toFileUrl(path);
            if (url) return url;
        }
        if (/^(file:|blob:|data:|https?:)/i.test(path)) return path;
        return path;
    }

    function isImagePath(path) {
        if (!path) return false;
        if (typeof window._isImagePath === 'function') return window._isImagePath(path);
        return /\.(png|jpe?g|webp|bmp|gif)$/i.test(path);
    }

    function mediaDuration(media) {
        return media && Number.isFinite(media.duration) && media.duration > 0 ? media.duration : 0;
    }

    function isAtTimelineEnd(time) {
        const dur = state.duration || computeDuration();
        return dur > 0 && Math.abs((time || 0) - dur) < 0.04;
    }

    function loopMediaTime(time, duration, forceLastFrame = false) {
        if (!(duration > 0)) return 0;
        if (forceLastFrame) return Math.max(0, duration - 0.03);
        return positiveModulo(time, duration);
    }

    function isLoopEnabled() {
        return state.root?.querySelector('[data-role="loop"]')?.checked !== false;
    }

    function getContentSource() {
        if (state.contentImage && state.contentImage.complete && state.contentImage.naturalWidth > 0) return state.contentImage;
        if (state.contentVideo.src && state.contentVideo.readyState >= 2 && state.contentVideo.videoWidth > 0) return state.contentVideo;
        return null;
    }

    function drawMediaCover(ctx, media, targetW, targetH, scalePct, offsetX, offsetY, flipH, flipV, rotation = 0) {
        if (!media) return;
        const srcW = media.videoWidth || media.naturalWidth || media.width || targetW;
        const srcH = media.videoHeight || media.naturalHeight || media.height || targetH;
        if (!(srcW > 0 && srcH > 0)) return;

        let scale = Math.max(targetW / srcW, targetH / srcH) * (numberOr(scalePct, 100) / 100);
        const radians = Math.abs(numberOr(rotation, 0) % 180) * Math.PI / 180;
        const preRotateW = srcW * scale;
        const preRotateH = srcH * scale;
        scale *= Math.max(1, targetW / (Math.abs(preRotateW * Math.cos(radians)) + Math.abs(preRotateH * Math.sin(radians))), targetH / (Math.abs(preRotateW * Math.sin(radians)) + Math.abs(preRotateH * Math.cos(radians))));
        const drawW = srcW * scale;
        const drawH = srcH * scale;
        const maxShiftX = Math.abs(targetW - drawW) / 2;
        const maxShiftY = Math.abs(targetH - drawH) / 2;
        const x = (targetW - drawW) / 2 + targetW * (numberOr(offsetX, 0) / 100);
        const y = (targetH - drawH) / 2 + targetH * (numberOr(offsetY, 0) / 100);
        drawImageMaybeFlipped(ctx, media, 0, 0, srcW, srcH, x, y, drawW, drawH, flipH, flipV, rotation);
    }

    function drawCroppedCover(ctx, media, crop, targetW, targetH, scalePct, offsetX, offsetY, flipH, flipV, rotation = 0) {
        if (!media) return;
        const srcW = media.videoWidth || media.naturalWidth || media.width || targetW;
        const srcH = media.videoHeight || media.naturalHeight || media.height || targetH;
        if (!(srcW > 0 && srcH > 0)) return;
        const sx = srcW * crop.x;
        const sy = srcH * crop.y;
        const sw = srcW * crop.w;
        const sh = srcH * crop.h;
        let scale = Math.max(targetW / sw, targetH / sh) * (numberOr(scalePct, 100) / 100);
        const radians = Math.abs(numberOr(rotation, 0) % 180) * Math.PI / 180;
        const preRotateW = sw * scale;
        const preRotateH = sh * scale;
        scale *= Math.max(1, targetW / (Math.abs(preRotateW * Math.cos(radians)) + Math.abs(preRotateH * Math.sin(radians))), targetH / (Math.abs(preRotateW * Math.sin(radians)) + Math.abs(preRotateH * Math.cos(radians))));
        const drawW = sw * scale;
        const drawH = sh * scale;
        const maxShiftX = Math.abs(targetW - drawW) / 2;
        const maxShiftY = Math.abs(targetH - drawH) / 2;
        const x = (targetW - drawW) / 2 + targetW * (numberOr(offsetX, 0) / 100);
        const y = (targetH - drawH) / 2 + targetH * (numberOr(offsetY, 0) / 100);
        drawImageMaybeFlipped(ctx, media, sx, sy, sw, sh, x, y, drawW, drawH, flipH, flipV, rotation);
    }

    function drawImageMaybeFlipped(ctx, img, sx, sy, sw, sh, dx, dy, dw, dh, flipH, flipV, rotation = 0) {
        if (!flipH && !flipV && !rotation) {
            ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
            return;
        }
        ctx.save();
        ctx.translate(dx + dw / 2, dy + dh / 2);
        if (rotation) ctx.rotate(numberOr(rotation, 0) * Math.PI / 180);
        ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1);
        ctx.drawImage(img, sx, sy, sw, sh, -dw / 2, -dh / 2, dw, dh);
        ctx.restore();
    }

    function parseCrop(value) {
        const fallback = { x: 0, y: 0, w: 1, h: 1 };
        if (!value || typeof value !== 'string') return fallback;
        const parts = value.split(',').map(v => parseFloat(v.trim()));
        if (parts.length !== 4 || parts.some(v => !Number.isFinite(v))) return fallback;
        return {
            x: clamp(parts[0], 0, 100) / 100,
            y: clamp(parts[1], 0, 100) / 100,
            w: clamp(parts[2], 1, 100) / 100,
            h: clamp(parts[3], 1, 100) / 100,
        };
    }

    function makeTaskSignature(task) {
        if (!task) return 'none';
        const segs = Array.isArray(task.segments) ? task.segments.length : 0;
        const lastEnd = segs ? task.segments[segs - 1].end : '';
        return [
            getSelectedIndex(),
            task.id || '',
            task.fileName || '',
            getBackgroundPath(task),
            task.audioPath || '',
            getBgmPath(task),
            task.contentVideoPath || '',
            getHookPath(task),
            task.hookDurationMode || '',
            task.hookTrimStart ?? '',
            task.hookTrimEnd ?? '',
            task.hookSpeed ?? '',
            task.hookTransition || '',
            task.hookTransDuration ?? '',
            task.hookKeepAudio === false ? '0' : '1',
            task.hookVolume ?? '100',
            getHookAudioPath(task),
            task.hookAudioTrimStart ?? '',
            task.hookAudioTrimEnd ?? '',
            task.hookAudioVolume ?? '100',
            task.cover && task.cover.enabled ? task.cover.bgPath || '' : '',
            task.cover && task.cover.enabled ? task.cover.duration || '' : '',
            task.customDuration || '',
            segs,
            lastEnd,
            getTargetWidth(),
            getTargetHeight(),
        ].join('|');
    }

    function formatTime(sec) {
        const s = Math.max(0, Number.isFinite(sec) ? sec : 0);
        const m = Math.floor(s / 60);
        const r = Math.floor(s % 60);
        return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
    }

    function numberOr(value, fallback) {
        const n = parseFloat(value);
        return Number.isFinite(n) ? n : fallback;
    }

    function clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }

    function positiveModulo(value, mod) {
        if (!(mod > 0)) return 0;
        return ((value % mod) + mod) % mod;
    }

    function clone(value) {
        try { return JSON.parse(JSON.stringify(value)); } catch (_) { return value ? { ...value } : value; }
    }

    function isEditable(el) {
        if (!el) return false;
        const tag = String(el.tagName || '').toLowerCase();
        return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
    }

    window.ReelsPreviewV2 = {
        open,
        close,
        dispose: () => {
            close();
            [state.bgVideo,state.bgFadeVideo,state.contentVideo,state.hookVideo,state.hookAudio,state.coverVideo,state.audio,state.bgmAudio].forEach(media => {
                if (media) { media.removeAttribute('src'); media.load(); }
            });
            state.bgImage = null; state.contentImage = null; state.coverImage = null;
            state.multiBgImages.clear();
            watermarkImageCache.clear();
            if (state.audioCtx) {
                state.audioCtx.close().catch(() => {});
                state.audioCtx = null;
            }
            state.mediaSources.clear(); state.gainNodes.clear();
            state.resizeObserver?.disconnect(); state.resizeObserver = null;
            window.removeEventListener('resize', queueFitStage);
            if (state.canvas) { state.canvas.width = 0; state.canvas.height = 0; }
            state.renderer = null;
            window.ReelsOverlay?.disposePreviewMedia?.();
        },
        isFrameReady: isComposedPreviewReady,
        isReplacementFrameReady: isComposedPreviewReady,
        getMediaFailure: currentVisualFailure,
        render,
        reload: () => loadCurrentTask(true),
        refresh: () => { loadCurrentTask(false); render(); },
        recover: (reason = 'external-refresh') => scheduleMediaRecovery(reason, true, 0),
        isOpen: () => state.isOpen,
        setSuspended: suspended => {
            state.previewSuspended=!!suspended;
            if(suspended){if(state.raf)cancelAnimationFrame(state.raf);state.raf=null;window.ReelsOverlay?.pausePreviewMedia?.();}
            else if(state.isOpen){startLoop();render();}
        },
        isSuspended: () => state.previewSuspended,
        getCanvas: () => state.isOpen ? state.canvas : null,
        getViewportElement: () => state.isOpen
            ? (state.root?.querySelector('.rpv2-stage-wrap') || state.root)
            : null,
        getCanvasSize: () => state.isOpen && state.canvas
            ? { width: state.canvas.width, height: state.canvas.height }
            : null,
        togglePlay,
        setMuted: muted => {
            window.__reelsOverviewMuted = !!muted;
            applyAudioVolumes(getTask());
        },
        play: (speed = 1) => {
            const time = getCurrentTime();
            state.playbackSpeed = clamp(numberOr(speed, 1), 0.25, 4);
            state.pausedAt = time;
            state.startedAt = performance.now() / 1000 - time / state.playbackSpeed;
            if (!state.isPlaying) togglePlay();
            else playMedia();
        },
        pause: () => {
            if (state.isPlaying) togglePlay();
        },
        // 任务切换时不能复用上一任务的 pausedAt。若用户正在播放，保持播放状态，
        // 但让新任务从自己的 0:00 开始。
        resetForTaskSwitch: () => {
            if (!state.isOpen) return;
            const wasPlaying = state.isPlaying;
            pauseMedia();
            state.isPlaying = false;
            state.pausedAt = 0;
            state.startedAt = performance.now() / 1000;
            state.seekFrameLock = null;
            clearTimeout(state.seekQueueTimer);state.seekQueueTimer=null;state.queuedSeek=null;
            loadCurrentTask(true);
            if (wasPlaying) {
                state.isPlaying = true;
                state.startedAt = performance.now() / 1000;
                syncMediaToTime(0);
                playMedia();
            }
            updatePlayButton();
            render();
        },
        seek: seekTo,
        getCurrentTime,
        isPlaying: () => state.isPlaying,
        getPlaybackSpeed: () => state.playbackSpeed,
        setPlaybackSpeed: speed => {const time=getCurrentTime();state.playbackSpeed=clamp(numberOr(speed,1),.25,4);state.pausedAt=time;state.startedAt=performance.now()/1000-time/state.playbackSpeed;applyPlaybackRates(getTask());},
        updateEditableGeometry: (type, id, fields) => {
            const task=getTask();
            const object=type==='overlay' ? getLiveOverlays(task).find(ov=>String(ov.id)===String(id)) : type==='subtitle' ? task.subtitleStyle : task;
            if(object) Object.assign(object,clone(fields));
            render();
        },
        getEditableOverlays: (ids, withHit = false) => {
            const task = getTask();
            if (!task) return [];
            const phase = getPhaseInfo(getCurrentTime(), task);
            const time = phase.inCover ? phase.time : phase.mainTime;
            const live=getLiveOverlays(task),liveIds=new Set(live.map(ov=>String(ov.id)));
            const ordered=window.ReelsRenderPlan?.getCompositedOverlays?.(task,{width:getTargetWidth(),height:getTargetHeight()}) || live;
            return ordered.filter(ov => !ov._insertClip && liveIds.has(String(ov.id)) && (!ids || ids.some(id=>String(id)===String(ov.id))) && !ov.disabled && ((ov.is_phone_cta && ov._ctaAnimPreviewStart && performance.now()-ov._ctaAnimPreviewStart<2400) || (time >= numberOr(ov.start, 0) && (ov.type==='scroll' || time <= numberOr(ov.end, 9999))))).map(ov => {
                // Pointer picking uses rendered alpha; passive geometry requests keep the fast window path.
                const windowBounds=['image','video'].includes(ov.type) && ov.media_window_mode;
                const measured=(!windowBounds || withHit)?measureEditableBounds((ctx,w,h)=>window.ReelsOverlay.drawOverlay(ctx,{...ov,_allOverlays:ordered,_selected:false,_exporting:true,_hitTesting:true,_previewPlaying:state.isPlaying},time,w,h),withHit):null;
                const result={id:ov.id,bounds:ov.title_frame_enabled ? getOverlayBounds(ov,time,getTargetWidth(),getTargetHeight()) : measured || getOverlayBounds(ov,time,getTargetWidth(),getTargetHeight())};
                if(withHit)result.hitTest=measured?.hitTest || (()=>false);
                return result;
            });
        },
        getEditableSubtitleBounds: (withHit = false) => {
            const task = getTask(), phase = getPhaseInfo(getCurrentTime(), task);
            if (!task) return null;
            return measureEditableBounds((ctx,w,h,surface) => drawSubtitles(ctx,task,phase.mainTime / getAudioDurationScale(task),w,h,phase,{exporting:true,renderer:new window.ReelsCanvasRenderer(surface)}),withHit);
        },
        exportSingleFrame,
        getDuration: computeDuration,
        getTimelineDuration: () => absoluteToTimeline(computeDuration()),
        timelineToAbsolute,
        absoluteToTimeline,
        getContentDimensions: () => {
            const source = getContentSource();
            const width = numberOr(source && (source.videoWidth || source.naturalWidth || source.width), 0);
            const height = numberOr(source && (source.videoHeight || source.naturalHeight || source.height), 0);
            return width > 0 && height > 0 ? { width, height } : null;
        },
        syncAudio: () => applyAudioVolumes(getTask()),
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
