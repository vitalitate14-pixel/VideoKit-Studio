/**
 * reels-preset-thumb.js - 覆层预设缩略图渲染引擎
 * 
 * 用于在 OffscreenCanvas / Canvas 上将覆层数据渲染为 270x480 的缩略图。
 */

class PresetThumbRenderer {
    constructor() {
        this.THUMB_W = 360;
        this.THUMB_H = 640;
        this.SCALE = this.THUMB_W / 1080; // 从 1080x1920 缩放
        this.canvas = document.createElement('canvas');
        this.canvas.width = this.THUMB_W;
        this.canvas.height = this.THUMB_H;
        this.ctx = this.canvas.getContext('2d');
        this._thumbMedia = [];
    }

    async _loadOverlayThumb(ov) {
        if (!ov || ov.disabled || !['image', 'video'].includes(ov.type)) return null;
        const sequence = ov.is_img_sequence && ov.sequence_frames?.length;
        const offset = Math.max(0, Number(ov.video_start_offset) || 0);
        const source = sequence
            ? ov.sequence_frames[Math.min(ov.sequence_frames.length - 1, Math.floor(offset * (Number(ov.fps) || 30)))]
            : ov.media_folder_files?.[0] || ov.content;
        if (!source) return null;
        const video = !sequence && /\.(mp4|mov|avi|mkv|webm|m4v)(?:[?#]|$)/i.test(source);
        const media = document.createElement(video ? 'video' : 'img');
        if (/^https?:\/\//.test(source)) media.crossOrigin = 'anonymous';
        media.muted = true;
        media.preload = 'auto';
        const url = typeof _normalizeOverlayMediaPath === 'function' ? _normalizeOverlayMediaPath(source)
            : window.electronAPI?.toFileUrl ? window.electronAPI.toFileUrl(source) : source;
        const waitFor = (event, action) => new Promise((resolve, reject) => {
            const timer = setTimeout(() => done(new Error('覆层媒体缩略图加载超时')), 2000);
            const done = error => {
                clearTimeout(timer);
                media.removeEventListener(event, loaded);
                media.removeEventListener('error', failed);
                error ? reject(error) : resolve();
            };
            const loaded = () => done();
            const failed = () => done(new Error('覆层媒体无法读取'));
            media.addEventListener(event, loaded, { once: true });
            media.addEventListener('error', failed, { once: true });
            action();
        });
        try {
            await waitFor(video ? 'loadeddata' : 'load', () => { media.src = url; });
            if (!video) return media;
            const time = Number.isFinite(media.duration) ? Math.min(offset, Math.max(0, media.duration - 0.05)) : offset;
            if (time > 0) await waitFor('seeked', () => { media.currentTime = time; });
            const frame = document.createElement('canvas');
            frame.width = media.videoWidth;
            frame.height = media.videoHeight;
            frame.getContext('2d').drawImage(media, 0, 0);
            return frame;
        } catch (error) {
            console.warn('[PresetThumb] 覆层媒体加载失败:', source, error);
            return null;
        } finally {
            if (video) { media.pause(); media.removeAttribute('src'); media.load(); }
        }
    }

    /**
     * 渲染覆层组缩略图
     * @param {Array} layers - 覆层数据数组
     * @param {string} bgColor - 背景色
     * @returns {string} base64 DataURL (image/webp)
     */
    renderThumb(layers, bgColor = '#1a1a2e', previewText = this._previewText || '') {
        const previewCopy = typeof previewText === 'object' && previewText ? previewText : { title: previewText, body: previewText, footer: '' };
        const ctx = this.ctx;
        ctx.clearRect(0, 0, this.THUMB_W, this.THUMB_H);
        
        ctx.fillStyle = bgColor;
        ctx.fillRect(0, 0, this.THUMB_W, this.THUMB_H);
        if (this._previewBgMedia) {
            const media = this._previewBgMedia;
            const sw = media.naturalWidth || media.videoWidth || 0;
            const sh = media.naturalHeight || media.videoHeight || 0;
            if (sw > 0 && sh > 0) {
                const scale = Math.max(this.THUMB_W / sw, this.THUMB_H / sh);
                const dw = sw * scale, dh = sh * scale;
                ctx.drawImage(media, (this.THUMB_W - dw) / 2, (this.THUMB_H - dh) / 2, dw, dh);
            }
        }

        ctx.save();
        ctx.scale(this.SCALE, this.SCALE);

        // 屏蔽导出标志，否则会跳过一些预览辅助线(但这里我们不想看辅助线,所以强制导出模式为 true 以隐藏辅助线)
        for (const [index, ov] of layers.entries()) {
            const renderOv = JSON.parse(JSON.stringify(ov)); // 深拷贝防止污染
            renderOv._exporting = true; // 隐藏辅助线
            const media = this._thumbMedia[index];
            if (media) {
                if (ov.type === 'image') renderOv._exportImage = media;
                else {
                    renderOv._currentFrameImage = media;
                    renderOv._framesDir = 'thumbnail';
                    renderOv._frameCount = 1;
                }
            }
            
            // 预设库临时文案只用于预览；固定文案不替换。
            if ((previewCopy.title || previewCopy.body || previewCopy.footer) && !renderOv.fixed_text) {
                if (renderOv.type === 'textcard') {
                    renderOv.title_text = previewCopy.title || renderOv.title_text;
                    renderOv.body_text = previewCopy.body || renderOv.body_text;
                    renderOv.footer_text = previewCopy.footer || renderOv.footer_text;
                } else if (renderOv.type === 'scroll') {
                    renderOv.scroll_title = previewCopy.title || renderOv.scroll_title;
                    renderOv.content = previewCopy.body || renderOv.content;
                } else if (renderOv.type === 'text') {
                    renderOv.content = previewCopy.body || previewCopy.title || renderOv.content;
                }
            }
            // 占位文案处理
            if (!renderOv.fixed_text) {
                if (renderOv.type === 'textcard') {
                    if (renderOv.title_text == null) renderOv.title_text = 'IN MARCH, READ THIS JUST ONCE AND IT WILL COME TO PASS IMMEDIATELY';
                    if (renderOv.body_text == null)  renderOv.body_text  = 'Lord, in the name of Jesus, March has begun. I rebuke every spiritual curse, evil eye, jealousy, sickness, and confusion coming against me and my family! I cut off every hidden opening and destroy every trap set by the enemy.';
                } else if (renderOv.type === 'scroll') {
                    if (!renderOv.scroll_title) renderOv.scroll_title = 'IN MARCH, READ THIS JUST ONCE AND IT WILL COME TO PASS IMMEDIATELY';
                    if (!renderOv.content) renderOv.content = 'Lord, in the name of Jesus, March has begun. I rebuke every spiritual curse, evil eye, jealousy, sickness, and confusion coming against me and my family! I cut off every hidden opening and destroy every trap set by the enemy.';
                } else if (renderOv.type === 'text') {
                    if (!renderOv.content) renderOv.content = 'IN MARCH, READ THIS JUST ONCE AND IT WILL COME TO PASS IMMEDIATELY';
                }
            }

            // 时间置零以显示初始状态
            const currentTime = Math.max(parseFloat(renderOv.start || 0), 0);

            if (typeof ReelsOverlay !== 'undefined' && ReelsOverlay.drawOverlay) {
                ReelsOverlay.drawOverlay(ctx, renderOv, currentTime, 1080, 1920);
            }
        }

        ctx.restore();
        
        try {
            // 压缩成 WebP 返回 (0.75 兼顾画质与轻量体积)
            return this.canvas.toDataURL('image/webp', 0.75);
        } catch (e) {
            console.warn('[PresetThumb] toDataURL 失败(可能是本地图片跨域污染):', e);
            return ''; // 返回空字符串以触发 fallback
        }
    }

    /**
     * 异步渲染缩略图（等待媒体资源加载）
     * @param {Array} layers - 覆层数据数组
     * @param {string} bgColor - 背景色
     * @returns {Promise<string>} base64 DataURL (image/webp)
     */
    async renderThumbAsync(layers, bgColor = '#1a1a2e', previewBackgroundPath = '', previewText = '', bgMedia = null) {
        const ctx = this.ctx;
        this._previewBgMedia = null;
        this._previewText = previewText;
        // 等待图片解码、视频首帧/裁剪起点，再把已准备的画面交给覆层绘制。
        // 不能依赖预览缓存：它的异步加载往往在缩略图保存后才结束。
        const overlayMediaPromise = Promise.all(layers.map(ov => this._loadOverlayThumb(ov)));
        if (bgMedia && (bgMedia.naturalWidth || bgMedia.videoWidth)) {
            this._previewBgMedia = bgMedia;
        } else if (previewBackgroundPath) {
            try {
                const isImage = /\.(jpg|jpeg|png|webp|gif)$/i.test(previewBackgroundPath);
                const media = document.createElement(isImage ? 'img' : 'video');
                media.muted = true; media.preload = isImage ? 'metadata' : 'auto';
                media.src = window.electronAPI?.toFileUrl ? window.electronAPI.toFileUrl(previewBackgroundPath) : previewBackgroundPath;
                if (!isImage) {
                    media.currentTime = 0.1;
                }
                // 视频的 loadeddata 在损坏、编码不兼容或网络/本地协议短暂失效时
                // 可能永远不触发。图库缩略图使用单队列，不能让一张卡永久堵住
                // 后面全部预设；超时后退回纯色背景继续生成。
                await new Promise((resolve, reject) => {
                    const timer = setTimeout(() => reject(new Error('背景缩略图加载超时')), 2500);
                    const done = () => { clearTimeout(timer); resolve(); };
                    const fail = () => { clearTimeout(timer); reject(new Error('背景无法读取')); };
                    media.onload = media.onloadeddata = done;
                    media.onerror = fail;
                });
                this._previewBgMedia = media;
            } catch (_) { /* 背景不可用时仍保留纯色缩略图 */ }
        }
        
        this._thumbMedia = await overlayMediaPromise;
        // 1. 先触发一次绘制，让底层的 ReelsOverlay 发起本地文件预载请求
        let needsWait = false;
        for (const ov of layers) {
            if (ov.title_bg_brush || ov.body_bg_brush || ov.card_brush || ov.bg_image || ov.title_custom_brush_data || ov.body_custom_brush_data) {
                needsWait = true;
            }
            const renderOv = JSON.parse(JSON.stringify(ov));
            const currentTime = Math.max(parseFloat(renderOv.start || 0), 0);
            if (typeof ReelsOverlay !== 'undefined' && ReelsOverlay.drawOverlay) {
                ReelsOverlay.drawOverlay(ctx, renderOv, currentTime, 1080, 1920);
            }
        }
        
        // 2. 如果包含笔刷或外部图片才稍微等待，否则立即完成，避免无谓阻塞
        if (needsWait) {
            await new Promise(resolve => setTimeout(resolve, 60));
        }
        
        // 3. 再次正式渲染并返回
        return this.renderThumb(layers, bgColor, previewText);
    }
}

// 导出
if (typeof window !== 'undefined') {
    window.PresetThumbRenderer = PresetThumbRenderer;
}
