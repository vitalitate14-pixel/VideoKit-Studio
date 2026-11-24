/**
 * reels-turbo-planner.js — 新极速导出（turbo）的“智能判断”。
 *
 * 导出开始前分析任务实际用到的图层与效果，为每一层选择最快且画面一致的
 * 处理方式，并给出可读的原因（写入导出日志）。
 *
 * 设计前提：turbo 的所有图层都在同一块 GPU 画布上合成（绘制代码与旧导出完全
 * 相同），所以混合模式、毛玻璃、环境光等“需要读取背景像素”的效果不需要降级；
 * 判断的重点是“每一层的帧从哪里来、怎么读最快”。
 *
 * 纯函数，无 DOM 依赖：浏览器中挂到 window.ReelsTurboPlanner，Node 中可 require 测试。
 */
(function (root) {
    const IMAGE_EXT = /\.(jpe?g|png|webp|bmp)$/i;
    const GIF_EXT = /\.gif$/i;

    function isImage(file) { return IMAGE_EXT.test(String(file || '')); }

    function activeOverlays(overlays) {
        return (Array.isArray(overlays) ? overlays : []).filter(ov => ov && !ov.disabled && ov.type !== 'audio');
    }

    // 字幕样式中启用的特性（仅用于日志说明，不影响绘制）。
    function describeStyleEffects(style = {}, showSubtitle = true) {
        if (!showSubtitle) return [];
        const s = style || {};
        const list = [];
        const anim = [s.anim_in_type, s.anim_out_type].filter(v => v && v !== 'none');
        if (anim.length) list.push(`动画 ${[...new Set(anim)].join('/')}`);
        const flags = [
            ['karaoke_highlight', '卡拉OK'], ['dynamic_box', '动态高亮框'], ['use_box', '背景框'],
            ['bg_gradient_enabled', '渐变背景'], ['stroke_expand_enabled', '多层描边'], ['use_underline', '下划线'],
            ['speed_trail_enabled', '速度拖尾'], ['ambient_glow_enabled', '环境光'], ['ambient_lighting_enabled', '环境光照'],
            ['scrolling_mode', '滚动歌词'], ['fullpage_typewriter', '整页打字机'], ['block_typography_enabled', '方块排版'],
            ['advanced_textbox_enabled', '高级文本框'], ['spectrum_enabled', '频谱'], ['global_mask_enabled', '全局蒙版'],
            ['dyn_box_image_enabled', '动态框贴图'], ['box_transition_enabled', '框色过渡'],
        ];
        for (const [key, label] of flags) if (s[key]) list.push(label);
        if (s.scrolling_mode && s.scrolling_card_blur_enabled) list.push('毛玻璃卡片');
        if (s.box_brush_style && s.box_brush_style !== 'rect') list.push(`笔刷框 ${s.box_brush_style}`);
        return list;
    }

    function overlayDecision(ov) {
        const name = ov.name || ov.id || ov.type;
        const extras = [];
        if (ov.blend_mode && ov.blend_mode !== 'source-over') extras.push(`混合模式 ${ov.blend_mode}`);
        if (ov.card_blur_enabled || ov.bg_blur_enabled) extras.push('毛玻璃');
        const suffix = extras.length ? `；${extras.join('、')}在 GPU 画布内直接合成，不降级` : '';
        if (ov.type === 'video') {
            if (ov.is_img_sequence) {
                return { name, layer: 'overlay', method: 'sequence', reason: `图片序列：直接读取原始帧并后台并行解码${suffix}` };
            }
            const gif = GIF_EXT.test(ov.content || '');
            return {
                name, layer: 'overlay', method: 'png-frames',
                reason: `${gif ? 'GIF' : '视频'}：FFmpeg 预抽 PNG 帧（保留透明通道，与旧导出同一来源），后台并行解码、按需预读${suffix}`,
            };
        }
        if (ov.type === 'image') {
            const folder = Array.isArray(ov.media_folder_files) && ov.media_folder_files.length > 1;
            return { name, layer: 'overlay', method: 'still', reason: `${folder ? '图片文件夹循环' : '静态图片'}：导出前一次性解码，常驻显存复用${suffix}` };
        }
        return { name, layer: 'overlay', method: 'canvas', reason: `${ov.type || '图层'}：沿用现有绘制代码，在 GPU 画布绘制${suffix}` };
    }

    /**
     * @param {object} params  与 reelsWysiwygExport 相同的导出参数
     * @returns {{background, contentVideo, overlays, effects, prefetch, lines}}
     */
    function planTurboExport(params = {}) {
        const overlays = activeOverlays(params.overlays);
        const isMulti = params.bgMode === 'multi' && Array.isArray(params.bgClipPool) && params.bgClipPool.length > 0;
        const cvBg = !!params.contentVideoPath && (params.contentVideoBlurBg || params.contentVideoDirectBg);
        const overlayOnly = !params.backgroundPath && !isMulti && !cvBg;

        let background;
        if (cvBg) {
            background = { method: 'content-video', reason: params.contentVideoBlurBg ? '内容视频模糊背景：复用内容视频帧，在画布上做模糊/压暗' : '内容视频直接作背景：复用内容视频帧' };
        } else if (overlayOnly) {
            background = { method: 'black', reason: '仅覆层：黑色底画布，跳过背景处理' };
        } else if (isMulti) {
            background = { method: 'frames', reason: `多素材 ${params.bgClipPool.length} 段 + 转场：FFmpeg 一次拼接为 JPG 帧（与旧导出同源），后台并行解码` };
        } else if (isImage(params.backgroundPath)) {
            background = { method: 'still', reason: '图片背景：FFmpeg 只处理 1 帧（缩放/旋转/裁切与旧导出一致），整段复用' };
        } else {
            background = { method: 'frames', reason: 'FFmpeg 预处理背景（循环淡化/缩放/变速与旧导出一致）为 JPG 帧，后台多线程并行解码，不再逐帧同步加载' };
        }

        let contentVideo = null;
        if (params.contentVideoPath) {
            contentVideo = { method: 'frames', reason: '内容视频：FFmpeg 预抽帧（含裁剪区间），后台并行解码、按需预读' };
        }

        const overlayPlans = overlays.map(overlayDecision);
        const videoLayers = overlayPlans.filter(p => p.method === 'png-frames' || p.method === 'sequence').length
            + (background.method === 'frames' ? 1 : 0) + (contentVideo ? 1 : 0);
        const pixels = (Number(params.targetWidth) || 1080) * (Number(params.targetHeight) || 1920);
        // 预读深度：显存/内存预算约 160MB（每帧 RGBA ≈ 宽×高×4）。
        const budget = 160 * 1024 * 1024;
        const prefetch = Math.max(2, Math.min(8, Math.floor(budget / Math.max(1, videoLayers) / (pixels * 4))));

        const effects = describeStyleEffects(params.style, params.showSubtitle !== false);
        if ((params.watermarks || []).some(w => w && w.enabled)) effects.push('水印');
        if (params.style && params.style.global_mask_enabled) effects.push('全局蒙版');

        const lines = [];
        lines.push(`⚡ 新极速：检测到 ${overlays.length} 个覆层${effects.length ? `，字幕效果：${[...new Set(effects)].join('、')}` : ''}`);
        lines.push(`  · 背景 → ${background.reason}`);
        if (contentVideo) lines.push(`  · 内容视频 → ${contentVideo.reason}`);
        for (const p of overlayPlans) lines.push(`  · 覆层「${p.name}」→ ${p.reason}`);
        lines.push(`  · 字幕/文字 → 现有渲染器原样绘制（GPU 画布），与旧导出同一套代码`);
        lines.push(`  · 预读深度 ${prefetch} 帧（${videoLayers} 个视频层）`);
        return { background, contentVideo, overlays: overlayPlans, effects, prefetch, lines };
    }

    /**
     * 根据旧导出 h264RateControlArgs 的同一规则推导码率（bps）。
     * 硬件编码器同码率下细节略弱于 libx264，乘以 hwFactor 补偿，使画质不低于旧导出。
     */
    function turboBitrate({ crf = 23, targetBitrateMbps = null, maxBitrateMbps = null } = {}, hwFactor = 1.0) {
        const target = Number(targetBitrateMbps);
        let mbps;
        if (Number.isFinite(target) && target > 0) {
            mbps = Math.max(1, Math.min(30, target));
        } else {
            const c = Number.isFinite(Number(crf)) ? Number(crf) : 23;
            mbps = c <= 15 ? 12 : c <= 18 ? 8 : c >= 26 ? 2.5 : 2;
        }
        const factor = Number.isFinite(Number(hwFactor)) && Number(hwFactor) > 0 ? Number(hwFactor) : 1;
        const max = Number(maxBitrateMbps);
        const adjusted = mbps * factor;
        return Math.round((Number.isFinite(max) && max > 0 ? Math.min(adjusted, Math.max(1, Math.min(50, max))) : adjusted) * 1e6);
    }

    const api = { planTurboExport, describeStyleEffects, turboBitrate };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.ReelsTurboPlanner = api;
})(typeof window !== 'undefined' ? window : null);
