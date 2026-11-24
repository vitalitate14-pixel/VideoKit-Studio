/**
 * reels-skill-exporter.js — 一键将排版、模板、动态字幕预设与水印导出为 AI 复刻渲染 Skill
 *
 * 设计原则：
 * 1. 严禁泄露任何本地/远程素材路径、Base64 内嵌贴图、媒体池列表、任务文案及逐句台词；
 * 2. 完整保留全部像素级布局坐标、自适应字高规则、字体配色、装饰线、滚动羽化、图层叠放顺序、
 *    动态字幕动效、混音/转场比例参数与水印样式（中文规格书 references/*.md + 脱敏纯样式 JSON resources/*.json）；
 * 3. 支持批量导出合并为 1 个「预设库 Skill」（自动去重相同排版）或每条各自生成独立 Skill 文件夹；
 * 4. 每次导出直接调用系统文件夹选择框，写入用户指定的任意目录。
 */
(function (root, factory) {
    const exported = factory(root);
    if (typeof root !== 'undefined') root.ReelsSkillExporter = exported;
    if (typeof module !== 'undefined' && module.exports) module.exports = exported;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';

    const LAST_DIR_STORE_KEY = 'videokit_skill_export_last_dir_v1';

    // 明确属于素材引用、文件路径、二进制贴图或单素材微调的字段名（一律剔除）
    const MEDIA_AND_ASSET_KEYS = new Set([
        'bgPath', 'videoPath', 'audioPath', 'srtPath', 'txtPath', 'bgmPath',
        'contentVideoPath', 'pipPath', 'hookFile', 'bgSrcUrl', 'srcUrl',
        '_sourceFolder', 'bgClipPool', 'bgClipSettings', 'bgmClipPool',
        'bgmClipActivePool', 'bgmClipOrder', 'insertClips', 'insertMediaFolder',
        'insertMediaFiles', 'autoEditProject', 'timeline', 'introMedia',
        'fileName', 'baseName', 'exportName',
        'path', 'filePath', 'localPath', 'nativePath', 'fullPath', 'folderPath',
        'media_path', 'media_folder_path', 'media_folder_files', 'media_folder_items',
        'media_folder_duration_paths', 'media_window_generated_clip',
        'imagePath', 'url', 'src', 'thumbSrc', 'thumbUrl', 'thumbnail',
        'dataUrl', 'image_data',
        'box_custom_brush_data', 'title_custom_brush_data', 'body_custom_brush_data',
        'footer_custom_brush_data', 'custom_brush_data', '_custom_brush_data',
        'custom_brush_path', 'brush_image_path', 'mask_image_path',
        'clip_rect',
    ]);

    // 明确属于具体视频台词、脚本或覆层业务文案的字段名（一律清空）
    const TASK_COPYWRITING_KEYS = new Set([
        'txtContent', 'ttsText', 'aiScript', 'script', 'aligned', 'ttsVoiceId',
        'status', 'error',
    ]);

    const OVERLAY_COPYWRITING_KEYS = new Set([
        'title_text', 'body_text', 'footer_text',
        'text', 'content', 'scroll_text', 'scroll_title',
        'scroll_styled_ranges', 'scroll_title_styled_ranges',
        'title_styled_ranges', 'body_styled_ranges', 'footer_styled_ranges',
    ]);

    const ALLOWED_LEADING_UNDERSCORE_KEYS = new Set([
        '_subtitlePreset', '_overlayPresetName', '_compositeOrderKey',
    ]);

    const MEDIA_EXT_RE = /\.(?:mp4|mov|mkv|webm|m4v|avi|wmv|flv|mpg|mpeg|mts|m2ts|ts|3gp|ogv|mp3|wav|m4a|aac|flac|ogg|opus|aiff?|srt|vtt|ass|ssa|png|jpe?g|webp|gif|bmp|tiff?|heic|heif|avif|svg|ttf|otf|woff2?)(?:[?#].*)?$/i;

    function num(v, fallback = 0) {
        const n = Number(v);
        return Number.isFinite(n) ? n : fallback;
    }

    function fmt(v) {
        return Math.round(num(v) * 100) / 100;
    }

    function looksLikeMediaOrPathString(str) {
        if (typeof str !== 'string') return false;
        const s = str.trim();
        if (!s) return false;
        if (/^(?:data:|blob:|file:\/\/|local-media:\/\/|https?:\/\/)/i.test(s)) return true;
        if (/^(?:\/Volumes\/|\/Users\/|\/home\/|\/var\/|\/tmp\/|\/private\/|[A-Za-z]:[\\/]|\\\\)/i.test(s)) return true;
        if ((s.includes('/') || s.includes('\\')) && MEDIA_EXT_RE.test(s)) return true;
        if (!s.includes(' ') && MEDIA_EXT_RE.test(s)) return true;
        return false;
    }

    /**
     * 深度清洗任意对象，剥离一切素材路径、二进制数据、运行时缓存与业务文案
     */
    function sanitizeStyleValue(value, key = '', context = 'generic') {
        if (value === null || value === undefined) return undefined;
        if (typeof value === 'function' || typeof value === 'symbol') return undefined;

        if (key) {
            if (MEDIA_AND_ASSET_KEYS.has(key)) return undefined;
            if (key.startsWith('_') && !ALLOWED_LEADING_UNDERSCORE_KEYS.has(key)) return undefined;
            if (context === 'task' && TASK_COPYWRITING_KEYS.has(key)) return undefined;
            if (context === 'overlay' && OVERLAY_COPYWRITING_KEYS.has(key)) return undefined;
        }

        if (typeof value === 'string') {
            if (looksLikeMediaOrPathString(value)) return undefined;
            return value;
        }

        if (typeof value === 'number') {
            return Number.isFinite(value) ? value : undefined;
        }

        if (typeof value === 'boolean') {
            return value;
        }

        if (Array.isArray(value)) {
            const arr = value
                .map(item => sanitizeStyleValue(item, '', context))
                .filter(item => item !== undefined);
            return arr;
        }

        if (typeof value === 'object') {
            // 排除 DOM 节点或 Image 实例
            if (typeof value.nodeType === 'number' || typeof value.getContext === 'function') return undefined;
            const out = {};
            for (const [k, v] of Object.entries(value)) {
                const cleaned = sanitizeStyleValue(v, k, context);
                if (cleaned !== undefined) out[k] = cleaned;
            }
            return out;
        }

        return undefined;
    }

    function computeOverlayWindowRect(ov, width, height) {
        const isFullMask = ov.fullscreen_mask === true || ov.fullscreen_mask === 1 || ov.fullscreen_mask === '1';
        if (isFullMask && ['textcard', 'solid_mask'].includes(ov.type)) {
            return { x: 0, y: 0, w: width, h: height };
        }
        let rect;
        if (['top_half', 'bottom_half'].includes(ov.media_window_mode)) {
            const half = root.ReelsMediaWindow?.halfScreen?.(ov.media_window_mode, ov.media_split_angle, width, height);
            rect = half?.rect || { x: 0, y: ov.media_window_mode === 'top_half' ? 0 : height / 2, w: width, h: height / 2 };
        } else if (ov.media_window_mode === 'pip' && ['image', 'video'].includes(ov.type)) {
            const saved = ov.media_window || {};
            const bx = Number.isFinite(Number(saved.x)) ? Number(saved.x) : num(ov.x);
            const by = Number.isFinite(Number(saved.y)) ? Number(saved.y) : num(ov.y);
            const bw = Number(saved.w) > 0 ? Number(saved.w) : num(ov.w, 100);
            const bh = Number(saved.h) > 0 ? Number(saved.h) : num(ov.h, 100);
            const sx = Math.max(0.01, num(ov.scale_x, num(ov.scale, 1)));
            const sy = Math.max(0.01, num(ov.scale_y, num(ov.scale, 1)));
            rect = { x: bx + (bw - bw * sx) / 2, y: by + (bh - bh * sy) / 2, w: bw * sx, h: bh * sy };
        } else {
            const base = ov.media_window_mode ? (ov.media_window || ov) : ov;
            const w = num(base.w, num(ov.w));
            const h = num(base.h, num(ov.h));
            const sx = Math.max(0.01, num(ov.scale_x, num(ov.scale, 1)));
            const sy = Math.max(0.01, num(ov.scale_y, num(ov.scale, 1)));
            rect = { x: num(base.x, num(ov.x)) + (w - w * sx) / 2, y: num(base.y, num(ov.y)) + (h - h * sy) / 2, w: w * sx, h: h * sy };
            if (!ov.media_window_mode && ov.clip_rect && Number(ov.clip_rect.w) > 0 && Number(ov.clip_rect.h) > 0) {
                rect = { x: num(ov.clip_rect.x), y: num(ov.clip_rect.y), w: Number(ov.clip_rect.w), h: Number(ov.clip_rect.h) };
            }
        }
        const cropPct = k => Math.max(0, Math.min(99, Number(ov[k]) || 0));
        const cropLeft = cropPct('media_crop_left'), cropTop = cropPct('media_crop_top');
        const cropRight = Math.min(cropPct('media_crop_right'), 99 - cropLeft);
        const cropBottom = Math.min(cropPct('media_crop_bottom'), 99 - cropTop);
        if (cropLeft || cropTop || cropRight || cropBottom) {
            return {
                x: fmt(rect.x + rect.w * cropLeft / 100),
                y: fmt(rect.y + rect.h * cropTop / 100),
                w: fmt(Math.max(1, rect.w * (100 - cropLeft - cropRight) / 100)),
                h: fmt(Math.max(1, rect.h * (100 - cropTop - cropBottom) / 100)),
            };
        }
        return { x: fmt(rect.x), y: fmt(rect.y), w: fmt(rect.w), h: fmt(rect.h) };
    }

    function sanitizeOverlay(ov, width, height) {
        if (!ov || typeof ov !== 'object') return null;
        const cleaned = sanitizeStyleValue(ov, '', 'overlay') || {};

        // 避免覆层 name 中残留源媒体文件名（如 person.mp4）
        if (typeof cleaned.name === 'string' && looksLikeMediaOrPathString(cleaned.name)) {
            delete cleaned.name;
        }
        if (typeof cleaned.slotLabel === 'string' && looksLikeMediaOrPathString(cleaned.slotLabel)) {
            delete cleaned.slotLabel;
        }

        // 记录结构槽位启用状态（不保存具体文案文字）
        if (ov.type === 'textcard') {
            const hasAnySlot = Boolean(String(ov.title_text || '').trim() || String(ov.body_text || '').trim() || String(ov.footer_text || '').trim());
            cleaned.enabled_slots = {
                title: hasAnySlot ? Boolean(String(ov.title_text || '').trim()) : true,
                body: Boolean(String(ov.body_text || '').trim()),
                footer: Boolean(String(ov.footer_text || '').trim()),
            };
        } else if (ov.type === 'scroll') {
            cleaned.enabled_slots = {
                scroll_title: Boolean(String(ov.scroll_title || '').trim()),
                scroll_body: true,
            };
        } else if (ov.type === 'text') {
            cleaned.enabled_slots = { text: true };
        }

        if (ov.box_custom_brush_data || ov.title_custom_brush_data || ov.body_custom_brush_data || ov.custom_brush_data) {
            cleaned.uses_custom_brush = true;
        }

        cleaned.resolved_rect = computeOverlayWindowRect(ov, width, height);
        return cleaned;
    }

    function sanitizeSubtitleStyle(style) {
        if (!style || typeof style !== 'object') return null;
        const cleaned = sanitizeStyleValue(style, '', 'subtitle') || {};
        if (style.box_custom_brush_data) cleaned.uses_custom_brush = true;
        if (style.dyn_box_image_enabled) cleaned.uses_dynamic_box_image = true;
        return cleaned;
    }

    function sanitizeWatermark(wm, { keepWatermarkText = true } = {}) {
        if (!wm || typeof wm !== 'object') return null;
        const cleaned = sanitizeStyleValue(wm, '', 'watermark') || {};
        delete cleaned.imagePath;
        delete cleaned.src;
        delete cleaned.dataUrl;
        if (wm.type === 'image') {
            delete cleaned.text;
            cleaned.requires_external_image = true;
        } else if (!keepWatermarkText) {
            delete cleaned.text;
            cleaned.text_slot_enabled = true;
        }
        return cleaned;
    }

    /**
     * 补充描述 ReelsLayoutDescription.describe 之外的非素材排版/装饰线/媒体框/混音细节
     */
    function buildSupplementaryTaskLines(task, { width = 1080, height = 1920, includedEntries = null } = {}) {
        const extra = [];
        const hasKind = kind => !includedEntries || includedEntries.some(e => e.kind === kind);

        // 1. 背景多段转场与混音比例（不含素材路径）
        if (hasKind('background')) {
            const bgExtras = [];
            if (task.bgMode && task.bgMode !== 'single') bgExtras.push(`多段背景模式：${task.bgMode}`);
            if (task.bgTransition && task.bgTransition !== 'none') {
                bgExtras.push(`背景片段转场：${task.bgTransition}（时长${fmt(num(task.bgTransDur, 0.5))}秒）`);
            }
            if (num(task.bgMinClipDur) > 0 || num(task.bgMaxClipDur) > 0) {
                bgExtras.push(`单段背景时长范围：${fmt(num(task.bgMinClipDur, 2))}–${fmt(num(task.bgMaxClipDur, 5))}秒`);
            }
            if (task.bgVideoVolume !== undefined && num(task.bgVideoVolume, 0) > 0) {
                bgExtras.push(`背景原声音量：${fmt(num(task.bgVideoVolume) * (num(task.bgVideoVolume) <= 1 ? 100 : 1))}%`);
            }
            if (bgExtras.length) extra.push(`背景扩展规则：${bgExtras.join('；')}。`);
        }

        // 2. 内容视频层非默认变换与模糊背景填充
        if (hasKind('content')) {
            const cvExtras = [];
            if (task.contentVideoScale !== undefined && num(task.contentVideoScale, 100) !== 100) {
                cvExtras.push(`缩放${fmt(task.contentVideoScale)}%`);
            }
            if (num(task.contentVideoX) || num(task.contentVideoY)) {
                cvExtras.push(`偏移(${fmt(task.contentVideoX)}, ${fmt(task.contentVideoY)})`);
            }
            if (task.contentVideoFlipH) cvExtras.push('水平翻转开启');
            if (task.contentVideoFlipV) cvExtras.push('垂直翻转开启');
            if (task.contentVideoBlurBg) {
                cvExtras.push(`模糊背景填充开启（模糊${fmt(num(task.contentVideoBlur, 20))}px，亮度${fmt(num(task.contentVideoBrightness, 100))}%）`);
            }
            if (task.contentVideoCrop && typeof task.contentVideoCrop === 'object') {
                const c = task.contentVideoCrop;
                if (num(c.top) || num(c.bottom) || num(c.left) || num(c.right)) {
                    cvExtras.push(`裁剪上/下/左/右 ${[c.top, c.bottom, c.left, c.right].map(v => fmt(num(v)) + '%').join('/')}`);
                }
            }
            if (cvExtras.length) extra.push(`内容视频层变换细节：${cvExtras.join('；')}。`);
        }

        // 3. 音频节奏与全局混音比例（不含音频文件路径）
        const audioExtras = [];
        if (num(task.playbackDelay) > 0) audioExtras.push(`配音起始延迟${fmt(task.playbackDelay)}秒`);
        if (task.bgmMode && (task.bgmPath || task.bgmClipPool?.length || task.bgmMode !== 'suite')) {
            audioExtras.push(`配乐模式：${task.bgmMode}，配乐音量${fmt(num(task.bgmVolume, 0.25) * (num(task.bgmVolume, 0.25) <= 1 ? 100 : 1))}%`);
        }
        if (task.hookTransition && task.hookTransition !== 'none' && (task.hookFile || task.hook)) {
            audioExtras.push(`片头Hook转场：${task.hookTransition}（时长${fmt(num(task.hookTransDuration, 0.4))}秒，倍速${fmt(num(task.hookSpeed, 1))}x）`);
        }
        if (audioExtras.length) extra.push(`时间轴与混音规则：${audioExtras.join('；')}。`);

        // 4. 覆层扩展视觉细节（标题装饰线、媒体窗口边框/圆角/遮罩、纯色蒙版颜色等）
        const ovEntries = (includedEntries || []).filter(e => e.kind === 'overlay' && e.ov && !e.ov.disabled);
        for (const entry of ovEntries) {
            const ov = entry.ov;
            const details = [];

            if (ov.type === 'textcard' && ov.title_deco_enabled) {
                const lenText = num(ov.title_deco_length) > 0 ? `${fmt(ov.title_deco_length)}px` : '随标题自动适配';
                details.push(
                    `标题装饰线：位置=${ov.title_deco_position || 'bottom'}，矢量样式=${ov.title_deco_style || 'solid'}，` +
                    `颜色=${ov.title_deco_color || '#FFD700'}${ov.title_deco_color2 ? ` → ${ov.title_deco_color2}（渐变方向 ${ov.title_deco_gradient_direction || 'horizontal'}）` : ''}，` +
                    `粗细=${fmt(num(ov.title_deco_thickness, 3))}px，长度=${lenText}，间距=${fmt(num(ov.title_deco_gap, 12))}px，` +
                    `不透明度=${fmt(num(ov.title_deco_opacity, 100))}%，对齐=${ov.title_deco_align || 'center'}`
                );
            }

            if (ov.type === 'textcard' && (ov.bg_enabled || ov.bg_blur_enabled || ov.bg_border_enabled)) {
                const cardParts = [];
                if (ov.bg_enabled) cardParts.push(`底色${ov.bg_color || '#000000'}（不透明度${fmt(num(ov.bg_opacity, 191) / 255 * 100)}%，圆角${fmt(num(ov.bg_radius, 0))}px）`);
                if (ov.bg_blur_enabled) cardParts.push(`毛玻璃模糊${fmt(num(ov.bg_blur_amount, 10))}px`);
                if (ov.bg_border_enabled) cardParts.push(`卡片外框${ov.bg_border_color || '#FFFFFF'}、宽${fmt(num(ov.bg_border_width, 2))}px、${ov.bg_border_style || 'solid'}`);
                if (cardParts.length) details.push(`卡片整框样式：${cardParts.join('，')}`);
            }

            if (ov.type === 'solid_mask') {
                details.push(`色块蒙版样式：颜色=${ov.color || ov.bg_color || '#000000'}，全屏=${ov.fullscreen_mask ? '是' : '否'}`);
            }

            if (['image', 'video'].includes(ov.type)) {
                const mediaParts = [];
                if (ov.media_window_mode) {
                    mediaParts.push(`窗口模式=${ov.media_window_mode}${['top_half', 'bottom_half'].includes(ov.media_window_mode) && num(ov.media_split_angle) ? `（分割斜角${fmt(ov.media_split_angle)}°）` : ''}`);
                }
                if (ov.media_mask_shape && ov.media_mask_shape !== 'rect') {
                    mediaParts.push(`遮罩形状=${ov.media_mask_shape}`);
                }
                const corners = [ov.media_corner_tl, ov.media_corner_tr, ov.media_corner_br, ov.media_corner_bl].map(v => num(v));
                if (corners.some(v => v > 0)) {
                    mediaParts.push(`圆角(左上/右上/右下/左下)=${corners.map(fmt).join('/')}px`);
                } else if (num(ov.border_radius || ov.media_radius) > 0) {
                    mediaParts.push(`圆角=${fmt(num(ov.border_radius || ov.media_radius))}px`);
                }
                if (num(ov.media_border_width) > 0) {
                    mediaParts.push(`窗口边框=${ov.media_border_color || '#FFFFFF'}、宽${fmt(ov.media_border_width)}px、${ov.media_border_style || 'solid'}、不透明度${fmt(num(ov.media_border_opacity, 100))}%`);
                }
                if (ov.media_blur_fill) mediaParts.push('窗口内模糊填充开启');
                if (num(ov.media_folder_interval) > 0) mediaParts.push(`多图轮播间隔=${fmt(ov.media_folder_interval)}秒`);
                if (mediaParts.length) details.push(`媒体窗口样式：${mediaParts.join('；')}`);
            }

            if (ov.transition_preset && ov.transition_preset !== 'none' && ov.type !== 'scroll') {
                details.push(`覆层出入场转场：${ov.transition_preset}（时长${fmt(num(ov.transition_duration, 0.35))}秒）`);
            }

            if (details.length) {
                extra.push(`${entry.label} 补充参数：${details.join('；')}。`);
            }
        }

        // 5. 首句独立动态字幕覆盖样式
        if (hasKind('subtitle') && task.firstSubtitleStyleOverride && typeof task.firstSubtitleStyleOverride === 'object' && Object.keys(task.firstSubtitleStyleOverride).length) {
            const cleanedFirst = sanitizeSubtitleStyle(task.firstSubtitleStyleOverride);
            if (cleanedFirst && Object.keys(cleanedFirst).length) {
                extra.push(`首句字幕独立覆盖参数：${Object.entries(cleanedFirst).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join('，')}。`);
            }
        }

        return extra;
    }

    /**
     * 为未填充文本的模板克隆一份仅含占位标记的临时任务供 ReelsLayoutDescription.describe 生成完整样式说明，
     * 绝不修改原任务，也不会在说明中输出占位文本本身。
     */
    function prepareTaskForDescription(task, liveOverlays) {
        const clone = Object.assign({}, task);
        const srcOverlays = Array.isArray(liveOverlays) ? liveOverlays : (Array.isArray(task?.overlays) ? task.overlays : []);
        clone.overlays = srcOverlays.map(ov => {
            if (!ov || typeof ov !== 'object') return ov;
            const copy = Object.assign({}, ov);
            if (copy.type === 'textcard' && !copy.title_text && !copy.body_text && !copy.footer_text) {
                // 让 describe 输出默认主标题槽位的字体/颜色/描边样式（describe 本身不会输出 title_text 内容）
                copy.title_text = '__SLOT__';
            }
            return copy;
        });
        return clone;
    }

    function resolveCanvasDimensions(task, options = {}) {
        if (options.width && options.height) {
            return { width: Number(options.width), height: Number(options.height) };
        }
        const rs = root._reelsState || {};
        const canvas = task ? root.ReelsLayoutTemplate?.taskCanvas?.(task, rs) : null;
        return {
            width: Number(canvas?.width || task?.targetWidth || rs.targetWidth || 1080),
            height: Number(canvas?.height || task?.targetHeight || rs.targetHeight || 1920),
        };
    }

    function resolveTaskLiveOverlays(task) {
        const rs = root._reelsState;
        if (rs?.tasks?.[rs.selectedIdx] === task && Array.isArray(rs.overlayProxy?.overlayMgr?.overlays)) {
            return rs.overlayProxy.overlayMgr.overlays;
        }
        return Array.isArray(task?.overlays) ? task.overlays : [];
    }

    function resolveTaskSubtitleStyle(task, fallbackStyle = null) {
        if (root._resolveSubtitleStyleForTask && root._reelsState?.tasks?.includes?.(task)) {
            const resolved = root._resolveSubtitleStyleForTask(task);
            if (resolved && typeof resolved === 'object' && Object.keys(resolved).length) return resolved;
        }
        for (const candidate of [task?.subtitleStyle, task?.subtitle_style, task?.style, fallbackStyle, root._reelsState?.globalSubtitleStyle]) {
            if (candidate && typeof candidate === 'object' && Object.keys(candidate).length) return candidate;
        }
        return null;
    }

    function isLayerAllowed(layerKey, displayKey, options = {}) {
        const excluded = new Set(options.excludedLayers || []);
        if (excluded.has(layerKey) || (displayKey && excluded.has(displayKey))) return false;
        if (options.includedLayers !== undefined && options.includedLayers !== null) {
            const included = new Set(options.includedLayers);
            return included.has(layerKey) || Boolean(displayKey && included.has(displayKey));
        }
        return true;
    }

    /**
     * 从单个视频任务构建脱敏 Skill 条目
     */
    function createTaskSkillItem(task, options = {}) {
        const descApi = root.ReelsLayoutDescription;
        if (!descApi) throw new Error('排版说明模块 ReelsLayoutDescription 尚未加载');

        const { width, height } = resolveCanvasDimensions(task, options);
        const liveOvs = resolveTaskLiveOverlays(task);
        const prepared = prepareTaskForDescription(task, liveOvs);

        const descOpts = {
            ...options,
            index: options.index ?? 0,
            width,
            height,
        };

        let mainSpec = descApi.describe(prepared, descOpts);
        // 去掉首行“任务 N 排版说明”，由统一的预设标题管理
        const mainLines = mainSpec.split('\n');
        if (/^任务\s+\d+\s+排版说明$/.test(mainLines[0] || '')) {
            mainLines.shift();
        }

        const allEntries = descApi.entries(prepared);
        const selectedEntries = allEntries.filter(entry => {
            const dispKey = 'display:' + JSON.stringify([entry.kind, entry.label]);
            return isLayerAllowed(entry.key, dispKey, options);
        });

        // 若模板任务尚未生成转写 segments（因此 entries 中没有 subtitle），但本身配置了字幕样式且未被排除，主动补齐动态字幕规格
        const hasSubtitleInEntries = allEntries.some(e => e.kind === 'subtitle');
        const subtitleExplicitlyAllowed = options.includedLayers === undefined
            ? !(options.excludedLayers || []).includes('subtitle')
            : isLayerAllowed('subtitle', 'display:["subtitle","字幕轨（自动字幕）"]', options) || options.forceIncludeTemplateSubtitle === true;
        const resolvedSubStyle = resolveTaskSubtitleStyle(task, options.fallbackSubtitleStyle);

        const chosenTitleStyles = options.includedTitleStyles === undefined ? null : new Set(options.includedTitleStyles);
        const titleStyleFor = entry => descApi.titleStyleData?.( [prepared], { includedLayers: ['display:' + JSON.stringify([entry.kind, entry.label])], excludedLayers: [] }).styles[0]?.style || {};
        const includeEntryStyle = entry => !chosenTitleStyles || chosenTitleStyles.has('display:' + JSON.stringify([entry.kind, entry.label]));
        const extraEntries = selectedEntries.map(entry => {
            if (includeEntryStyle(entry) || entry.ov?.type !== 'textcard') return entry;
            const ov = { ...entry.ov };
            for (const key of Object.keys(titleStyleFor(entry))) delete ov[key];
            return { ...entry, ov };
        });
        const extraLines = buildSupplementaryTaskLines(prepared, { width, height, includedEntries: extraEntries });
        const specSections = [mainLines.join('\n').trim()];
        if (extraLines.length) {
            specSections.push('### 补充视觉与合成细节\n' + extraLines.map(l => `- ${l}`).join('\n'));
        }

        if (!hasSubtitleInEntries && subtitleExplicitlyAllowed && resolvedSubStyle && descApi.describeSubtitlePresetText) {
            const subPresetText = descApi.describeSubtitlePresetText(task._subtitlePreset || '任务动态字幕样式', resolvedSubStyle, {
                width,
                height,
                overlayAboveSubtitle: task.overlayAboveSubtitle,
                includeOverlayRelation: true,
            });
            if (subPresetText) specSections.push('### 动态字幕轨规格\n' + subPresetText);
        }

        // 水印（支持任务自带或工程全局已启用水印）
        const rawWatermarks = (Array.isArray(options.watermarks) ? options.watermarks : (Array.isArray(task.watermarks) ? task.watermarks : []))
            .filter(wm => wm && wm.enabled);
        const includeWatermarks = options.includeWatermarks !== false && rawWatermarks.length > 0;
        const keepWatermarkText = options.keepWatermarkText !== false;

        if (includeWatermarks && descApi.describeWatermarksText) {
            const wmText = descApi.describeWatermarksText(rawWatermarks, {
                width,
                height,
                stripMediaPaths: true,
                includeTextContent: keepWatermarkText,
            });
            if (wmText) specSections.push('### 全局水印层规格\n' + wmText);
        }

        // 构建纯样式脱敏 JSON（绝不含路径/二进制/台词）
        const sanitizedOverlays = selectedEntries
            .filter(e => e.kind === 'overlay' && e.ov)
            .map(e => {
                const cleanedOv = sanitizeOverlay(e.ov, width, height);
                if (cleanedOv && !includeEntryStyle(e) && e.ov.type === 'textcard') {
                    for (const key of Object.keys(titleStyleFor(e))) delete cleanedOv[key];
                }
                if (cleanedOv) cleanedOv.layer_label = e.label;
                return cleanedOv;
            })
            .filter(Boolean);

        const includeSubtitleJson = (selectedEntries.some(e => e.kind === 'subtitle') || (!hasSubtitleInEntries && subtitleExplicitlyAllowed)) && Boolean(resolvedSubStyle);
        const segmentStyleOverrides = includeSubtitleJson && Array.isArray(task.segments)
            ? task.segments
                .map((seg, idx) => {
                    const ovr = seg?.style_override || seg?.subtitle_style;
                    if (!ovr || typeof ovr !== 'object' || !Object.keys(ovr).length) return null;
                    return {
                        sentence_index: idx + 1,
                        start_sec: fmt(num(seg.start)),
                        end_sec: fmt(num(seg.end)),
                        style_override: sanitizeSubtitleStyle(ovr),
                    };
                })
                .filter(Boolean)
            : [];

        const styleJson = {
            schema: 'videokit-skill-style/v1',
            kind: options.itemKind || 'video-layout-preset',
            canvas: { width, height },
            composition_order: {
                overlay_above_subtitle: task.overlayAboveSubtitle !== false,
                layers_bottom_to_top: [
                    ...(selectedEntries.some(e => e.kind === 'background') ? ['background'] : []),
                    ...(selectedEntries.some(e => e.kind === 'content') ? ['content_video'] : []),
                    ...(includeSubtitleJson && task.overlayAboveSubtitle !== false ? ['dynamic_subtitle'] : []),
                    ...sanitizedOverlays.map(ov => ov.layer_label || ov.slotKey || ov.type),
                    ...(includeSubtitleJson && task.overlayAboveSubtitle === false ? ['dynamic_subtitle'] : []),
                    ...(includeWatermarks ? ['watermarks'] : []),
                ],
            },
        };

        if (selectedEntries.some(e => e.kind === 'background')) {
            styleJson.background = sanitizeStyleValue({
                scale_percent: num(task.bgScale, 100),
                rotation_deg: num(task.bgRotation, 0),
                offset_x_percent: num(task.bgX, 0),
                offset_y_percent: num(task.bgY, 0),
                center_px: {
                    x: fmt(width / 2 + width * num(task.bgX, 0) / 100),
                    y: fmt(height / 2 + height * num(task.bgY, 0) / 100),
                },
                flip_h: Boolean(task.bgFlipH),
                flip_v: Boolean(task.bgFlipV),
                mode: task.bgMode || 'single',
                transition: task.bgTransition || 'none',
                transition_duration_sec: task.bgTransDur !== undefined ? fmt(num(task.bgTransDur, 0.5)) : undefined,
                min_clip_duration_sec: task.bgMinClipDur !== undefined ? fmt(num(task.bgMinClipDur)) : undefined,
                max_clip_duration_sec: task.bgMaxClipDur !== undefined ? fmt(num(task.bgMaxClipDur)) : undefined,
                video_volume: task.bgVideoVolume !== undefined ? fmt(num(task.bgVideoVolume)) : undefined,
            }, '', 'task');
        }

        if (selectedEntries.some(e => e.kind === 'content')) {
            styleJson.content_video = sanitizeStyleValue({
                rect_px: { x: 0, y: 0, w: width, h: height },
                scale_percent: num(task.contentVideoScale, 100),
                offset_x: num(task.contentVideoX, 0),
                offset_y: num(task.contentVideoY, 0),
                flip_h: Boolean(task.contentVideoFlipH),
                flip_v: Boolean(task.contentVideoFlipV),
                crop: task.contentVideoCrop || undefined,
                blur_bg: Boolean(task.contentVideoBlurBg),
                blur_px: task.contentVideoBlurBg ? num(task.contentVideoBlur, 20) : undefined,
                brightness_percent: task.contentVideoBlurBg ? num(task.contentVideoBrightness, 100) : undefined,
                volume: task.contentVideoVolume !== undefined ? fmt(num(task.contentVideoVolume, 1)) : undefined,
            }, '', 'task');
        }

        if (sanitizedOverlays.length) {
            styleJson.overlays = sanitizedOverlays;
        }
        if (chosenTitleStyles) {
            const selectedIds = new Set(selectedEntries.map(entry => 'display:' + JSON.stringify([entry.kind, entry.label])));
            const styleOnly = [...chosenTitleStyles].filter(id => !selectedIds.has(id));
            const items = descApi.titleStyleData?.([prepared], { includedLayers: styleOnly, excludedLayers: [] }).styles || [];
            if (items.length) styleJson.title_styles = items.map(item => ({ ...item, style: sanitizeStyleValue(item.style, '', 'overlay') || {} }));
        }

        if (includeSubtitleJson) {
            const defaults = root.ReelsStyleEngine?.DEFAULT_SUBTITLE_STYLE || {};
            styleJson.dynamic_subtitle = {
                preset_name: task._subtitlePreset || undefined,
                resolved_style: sanitizeSubtitleStyle({ ...defaults, ...resolvedSubStyle }),
                first_sentence_override: task.firstSubtitleStyleOverride ? sanitizeSubtitleStyle(task.firstSubtitleStyleOverride) : undefined,
                segment_style_overrides: segmentStyleOverrides.length ? segmentStyleOverrides : undefined,
            };
        }

        if (includeWatermarks) {
            styleJson.watermarks = rawWatermarks
                .map(wm => sanitizeWatermark(wm, { keepWatermarkText }))
                .filter(Boolean);
        }

        if (num(task.playbackDelay) > 0 || task.bgmMode) {
            styleJson.audio_mix = sanitizeStyleValue({
                voice_delay_sec: num(task.playbackDelay, 0),
                bgm_mode: task.bgmMode || undefined,
                bgm_volume: task.bgmVolume !== undefined ? fmt(num(task.bgmVolume, 0.25)) : undefined,
            }, '', 'task');
        }

        const layerSummaryParts = [];
        if (styleJson.background) layerSummaryParts.push('背景层');
        if (styleJson.content_video) layerSummaryParts.push('内容视频层');
        if (sanitizedOverlays.length) layerSummaryParts.push(`${sanitizedOverlays.length}个覆层`);
        if (styleJson.dynamic_subtitle) layerSummaryParts.push('动态字幕轨');
        if (styleJson.watermarks?.length) layerSummaryParts.push(`${styleJson.watermarks.length}个水印`);

        const title = String(options.title || '').trim() || `排版预设 ${(options.index ?? 0) + 1}`;
        const specBody = specSections.filter(Boolean).join('\n\n');
        const fingerprint = JSON.stringify({
            canvas: styleJson.canvas,
            composition_order: styleJson.composition_order,
            background: styleJson.background,
            content_video: styleJson.content_video,
            overlays: (styleJson.overlays || []).map(ov => {
                const c = Object.assign({}, ov);
                delete c.id;
                delete c._compositeOrderKey;
                return c;
            }),
            title_styles: styleJson.title_styles,
            dynamic_subtitle: styleJson.dynamic_subtitle,
            watermarks: styleJson.watermarks,
            spec: specBody,
        });

        return {
            title,
            kind: options.itemKind || 'video-layout-preset',
            width,
            height,
            summary: `${width}×${height} · ${layerSummaryParts.join(' + ') || '基础画布'}`,
            specMarkdown: specBody,
            styleJson,
            fingerprint,
            sourceCount: 1,
        };
    }

    /**
     * 从工程与模板库的模板对象提取脱敏 Skill 条目
     */
    function createTemplateSkillItems(templates, options = {}) {
        const items = [];
        for (const [tplIdx, rawTpl] of (templates || []).entries()) {
            if (!rawTpl) continue;
            const rawProject = rawTpl.projectData || rawTpl;
            const projectData = root.ReelsProjectAssets?.decode
                ? root.ReelsProjectAssets.decode(JSON.parse(JSON.stringify(rawProject)))
                : rawProject;
            const tasks = Array.isArray(projectData?.tasks) ? projectData.tasks : [];
            const tplName = String(rawTpl.name || `模板 ${tplIdx + 1}`).trim();
            const exportOpts = projectData?.exportOpts || {};
            const width = Number(exportOpts.width || exportOpts.targetWidth || projectData?.targetWidth || 1080);
            const height = Number(exportOpts.height || exportOpts.targetHeight || projectData?.targetHeight || 1920);
            const tplWatermarks = Array.isArray(exportOpts.watermarks) ? exportOpts.watermarks : [];

            const scope = exportOpts.subtitleStyleScopeVersion === 2
                ? (exportOpts.subtitleStyleScope || (exportOpts.subtitleStyleApplyAll === true ? 'all' : 'folder'))
                : (exportOpts.subtitleStyleApplyAll === true ? 'all' : 'folder');
            const applyAllSub = scope === 'all';
            const subtitlePresets = root.ReelsStyleEngine?.loadSubtitlePresets?.()?.presets || {};

            if (!tasks.length) {
                if (projectData?.style && Object.keys(projectData.style).length) {
                    items.push(createSubtitlePresetSkillItem(`${tplName} · 动态字幕`, projectData.style, { width, height }));
                }
                continue;
            }

            // 提取模板内不重复的排版变体（若模板内 20 个任务都是同一排版，自动合并为 1 条）
            const selectedIdx = Number(projectData?.selectedIdx ?? projectData?.curr_idx ?? 0);
            const orderedTasks = tasks.slice();
            if (Number.isInteger(selectedIdx) && selectedIdx > 0 && selectedIdx < orderedTasks.length) {
                const [primary] = orderedTasks.splice(selectedIdx, 1);
                orderedTasks.unshift(primary);
            }

            const tplSeen = new Map();
            for (const task of orderedTasks) {
                const namedStyle = task?._subtitlePreset && subtitlePresets[task._subtitlePreset];
                const fallbackStyle = namedStyle
                    || (applyAllSub ? projectData?.style : null)
                    || task?.subtitleStyle || task?.subtitle_style || task?.style || projectData?.style || null;
                const syntheticTask = Object.assign({}, task);
                if (!syntheticTask.bgPath && !syntheticTask.bgClipPool?.length) {
                    // 保证模板背景变换参数正常输出，随后由脱敏逻辑剥离占位标记
                    syntheticTask.bgPath = '__TEMPLATE_BG__';
                }
                const item = createTaskSkillItem(syntheticTask, {
                    ...options,
                    title: tplName,
                    itemKind: 'template-preset',
                    width,
                    height,
                    fallbackSubtitleStyle: fallbackStyle,
                    forceIncludeTemplateSubtitle: Boolean(fallbackStyle),
                    watermarks: tplWatermarks,
                });
                if (!tplSeen.has(item.fingerprint)) {
                    tplSeen.set(item.fingerprint, item);
                } else {
                    tplSeen.get(item.fingerprint).sourceCount += 1;
                }
            }

            const variants = [...tplSeen.values()];
            variants.forEach((variant, vIdx) => {
                if (variants.length > 1) {
                    variant.title = `${tplName}（排版变体 ${vIdx + 1}）`;
                }
                items.push(variant);
            });
        }
        return items;
    }

    /**
     * 从布局编辑器当前布局方案创建 Skill 条目
     */
    function createLayoutSchemeSkillItem(scheme, task, options = {}) {
        const cleanScheme = sanitizeStyleValue(scheme, '', 'layout') || {};
        const baseItem = createTaskSkillItem(task, {
            ...options,
            title: scheme?.name || options.title || '布局参数预设',
            itemKind: 'layout-scheme',
            positionOnlyTitleId: options.positionOnlyTitleId,
            excludedLayers: options.excludedLayers || [],
            includeWatermarks: false,
        });
        baseItem.styleJson.layout_scheme = cleanScheme;
        baseItem.fingerprint = JSON.stringify({ spec: baseItem.specMarkdown, scheme: cleanScheme });
        return baseItem;
    }

    /**
     * 从单个动态字幕预设创建 Skill 条目
     */
    function createSubtitlePresetSkillItem(name, style, options = {}) {
        const descApi = root.ReelsLayoutDescription;
        if (!descApi?.describeSubtitlePresetText) {
            throw new Error('效果说明模块 ReelsLayoutDescription 尚未加载');
        }
        const { width, height } = resolveCanvasDimensions(null, options);
        const presetName = String(name || '动态字幕预设').trim();
        const specMarkdown = descApi.describeSubtitlePresetText(presetName, style, { width, height });
        const defaults = root.ReelsStyleEngine?.DEFAULT_SUBTITLE_STYLE || {};
        const cleanedResolved = sanitizeSubtitleStyle({ ...defaults, ...(style || {}) });
        const cleanedRaw = sanitizeSubtitleStyle(style || {});

        const styleJson = {
            schema: 'videokit-skill-style/v1',
            kind: 'subtitle-preset',
            preset_name: presetName,
            canvas: { width, height },
            raw_preset_style: cleanedRaw,
            resolved_style: cleanedResolved,
        };

        const animIn = cleanedResolved?.anim_in_type || 'none';
        const karaoke = cleanedResolved?.karaoke_highlight ? '逐词高亮' : '';
        const dynBox = cleanedResolved?.dynamic_box ? '动态词框' : '';
        const scrollMode = cleanedResolved?.scrolling_mode ? '滚动字幕' : '';
        const tags = [
            `字体 ${cleanedResolved?.font_family || 'Arimo'} ${fmt(num(cleanedResolved?.fontsize, 74))}px`,
            animIn !== 'none' ? `入场:${animIn}` : '',
            karaoke,
            dynBox,
            scrollMode,
        ].filter(Boolean).join(' · ');

        return {
            title: presetName,
            kind: 'subtitle-preset',
            width,
            height,
            summary: `${width}×${height} · ${tags || '动态字幕样式'}`,
            specMarkdown,
            styleJson,
            fingerprint: JSON.stringify({ kind: 'subtitle-preset', resolved: cleanedResolved }),
            sourceCount: 1,
        };
    }

    /**
     * 从已启用水印列表创建 Skill 条目
     */
    function createWatermarkSkillItem(watermarks, options = {}) {
        const descApi = root.ReelsLayoutDescription;
        if (!descApi?.describeWatermarksText) {
            throw new Error('效果说明模块 ReelsLayoutDescription 尚未加载');
        }
        const enabled = (watermarks || []).filter(wm => wm && wm.enabled);
        if (!enabled.length) throw new Error('暂无已启用的水印，请先启用要生成 Skill 的水印');

        const { width, height } = resolveCanvasDimensions(null, options);
        const keepWatermarkText = options.keepWatermarkText !== false;
        const specMarkdown = descApi.describeWatermarksText(enabled, {
            width,
            height,
            stripMediaPaths: true,
            includeTextContent: keepWatermarkText,
        });
        const sanitizedList = enabled.map(wm => sanitizeWatermark(wm, { keepWatermarkText })).filter(Boolean);
        const styleJson = {
            schema: 'videokit-skill-style/v1',
            kind: 'watermark-preset',
            canvas: { width, height },
            watermarks: sanitizedList,
        };

        return {
            title: String(options.title || (enabled.length === 1 ? '水印样式预设' : `水印组合预设（${enabled.length}个）`)).trim(),
            kind: 'watermark-preset',
            width,
            height,
            summary: `${width}×${height} · ${enabled.length} 个已启用水印（${enabled.map(w => w.type === 'image' ? '图片水印' : '文字水印').join('、')}）`,
            specMarkdown,
            styleJson,
            fingerprint: JSON.stringify({ kind: 'watermark-preset', watermarks: sanitizedList }),
            sourceCount: 1,
        };
    }

    /**
     * 对相同排版与样式指纹的条目合并去重
     */
    function deduplicateItems(items) {
        const map = new Map();
        for (const item of (items || [])) {
            if (!item) continue;
            const key = item.fingerprint || JSON.stringify(item.styleJson || item.specMarkdown);
            if (!map.has(key)) {
                map.set(key, Object.assign({}, item, {
                    sourceCount: item.sourceCount || 1,
                    mergedTitles: [item.title],
                }));
            } else {
                const existing = map.get(key);
                existing.sourceCount += (item.sourceCount || 1);
                if (item.title && !existing.mergedTitles.includes(item.title)) {
                    existing.mergedTitles.push(item.title);
                }
            }
        }
        return [...map.values()];
    }

    /**
     * 生成合法的 YAML Skill ID（小写字母、数字与连字符）
     */
    function toSkillId(input, fallback = 'videokit-render-preset') {
        const raw = String(input || '').trim().toLowerCase();
        const ascii = raw
            .replace(/['"`]/g, '')
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '');
        if (ascii && /[a-z0-9]/.test(ascii)) {
            return ascii.slice(0, 64).replace(/-+$/g, '');
        }
        // 纯中文名称时生成稳定可读哈希后缀，确保 YAML frontmatter 100% 符合规范
        let hash = 2166136261;
        for (let i = 0; i < raw.length; i++) {
            hash ^= raw.charCodeAt(i);
            hash = Math.imul(hash, 16777619);
        }
        const shortHash = (hash >>> 0).toString(36).slice(0, 6);
        return `${fallback}-${shortHash}`;
    }

    function toSafeFolderName(input, fallback = 'videokit-render-skill') {
        const cleaned = String(input || '')
            .replace(/[\\/:*?"<>|\0]/g, '-')
            .replace(/\s+/g, '-')
            .replace(/\.+$/g, '')
            .trim();
        if (!cleaned || cleaned === '.' || cleaned === '..' || cleaned.includes('..')) {
            return fallback;
        }
        return cleaned.slice(0, 80);
    }

    function toSafeEntrySlug(title, index) {
        const prefix = String(index + 1).padStart(2, '0');
        const cleaned = String(title || '')
            .replace(/[\\/:*?"<>|\0[\]()（）]/g, '-')
            .replace(/\s+/g, '-')
            .replace(/-+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 48);
        return cleaned ? `${prefix}-${cleaned}` : `preset-${prefix}`;
    }

    function yamlBlockScalar(text, indent = '  ') {
        const lines = String(text || '').trim().split(/\r?\n/);
        return '>-\n' + lines.map(l => indent + l.trim()).join('\n');
    }

    function buildSkillMarkdown({ skillId, displayTitle, description, entries, includeJson = true }) {
        const isSingle = entries.length === 1;
        const frontmatter = [
            '---',
            `name: ${skillId}`,
            `description: ${yamlBlockScalar(description)}`,
            '---',
            '',
        ].join('\n');

        const header = [
            `# ${displayTitle}`,
            '',
            '> 本 Skill 由 **VideoKit** 自动脱敏导出，专用于指导 AI 根据用户新提供的文案与媒体素材，按像素级排版坐标、字体配色、装饰线与字幕动效规范复刻生成画面或成片视频。',
            '> **隐私与无素材保证**：本包已彻底剥离原视频/音频/图片路径与具体业务台词，所有素材与新文案均由调用时外部传入。',
            '',
        ].join('\n');

        const rulesSection = [
            '## 一、像素级复刻渲染核心规范',
            '',
            '1. **全局像素坐标系**：',
            '   - 除明确标注百分比（`%`）的属性外，所有坐标与尺寸均基于对应预设声明的参考画布（如 `1080×1920`），**原点 `(0, 0)` 在画布左上角，`X` 向右递增、`Y` 向下递增**。',
            '   - 若目标导出分辨率与参考画布不同，须按宽高比将所有像素值（位置、宽高、字号、描边、阴影、圆角、内边距、羽化）等比缩放。',
            '2. **图层由底到顶合成顺序**：',
            '   - `背景层` → `内容视频层（若启用）` → `动态字幕轨（当 overlay_above_subtitle 为 true 时位于覆层下方；为 false 时位于覆层上方）` → `各已启用覆层（严格按规格书中列出的先后顺序由下到上叠放）` → `全局水印层（最顶层）`。',
            '3. **标题自适应字形高度与收窄规则（启用 `title_adaptive_enabled` 时）**：',
            '   - 规格书中的**字形高度（glyph height）**指大写字母或汉字的实际可见墨迹高度，而非 CSS `font-size`（渲染时请通过 Canvas `measureText` 的 `actualBoundingBoxAscent + actualBoundingBoxDescent` 实测反推 `font-size`）。',
            '   - 保持标题框中心坐标 `(cx, cy)` 不变：先在最大宽高范围内（扣除内边距与描边阴影占用）按优先字形高度自动换行；若超出最大行数或高度上限，逐步缩小字号直至适配；随后在**不增加行数**的前提下收窄背景框宽度并按实际行高收缩高度（均不低于最小宽高限制）。',
            '4. **滚动覆层与羽化裁切**：',
            '   - 在可视裁切框 `(x, y, w, h)` 内建立离屏 Alpha 遮罩，按上/下/左/右羽化像素做线性渐变柔化边缘；固定标题若为非独立布局，正文滚动区顶部须预留标题高度与间距；开启自动停止时，长文末行停在可视底边后保持静止至视频结束。',
            '5. **动态字幕与逐词高亮/词框动画**：',
            '   - 开启逐词高亮（`karaoke_highlight`）、跟随词框（`dynamic_box`）或逐词/逐字动画时，须结合词级时间轴（Word-level timestamps）逐帧插值计算当前朗读词的缩放、弹性回弹与底框坐标。',
            '',
            '## 二、AI 复刻执行工作流',
            '',
            '1. **选定预设并按需加载**：从下方「预设索引目录」定位用户指定的预设（若用户未指定且有多套，先简要列出可选预设供选择，或按场景匹配最合适的一套），读取对应的中文规格书 `references/*.md`' + (includeJson ? ' 与精确结构化参数 `resources/*.json`' : '') + '。',
            '2. **对齐输入素材与新文案**：将用户提供的背景视频/图片、画中画素材、标题/正文新文案、配音音频及字幕时间轴（SRT / 词级时间戳）映射到预设槽位。',
            '3. **程序化精确合成**：推荐使用 HTML5 Canvas / Playwright / Remotion 逐帧渲染文字排版、多色渐变装饰线、毛玻璃模糊与四边羽化，再通过 FFmpeg 合成音视频轨并输出标准 MP4（H.264 + AAC）。',
            '4. **关键帧自检**：导出后抽检首帧、标题完整帧与字幕高亮帧，核对坐标边界、换行行数、字形高度及叠放顺序与规格书完全一致。',
            '',
        ].join('\n');

        const indexLines = [
            `## 三、预设索引目录（共 ${entries.length} 套）`,
            '',
            includeJson
                ? '| # | 预设名称 | 规格摘要 | 像素级中文规格书 | 脱敏纯样式 JSON |'
                : '| # | 预设名称 | 规格摘要 | 像素级中文规格书 |',
            includeJson
                ? '| :- | :------- | :------- | :--------------- | :-------------- |'
                : '| :- | :------- | :------- | :--------------- |',
        ];

        entries.forEach((entry, idx) => {
            const safeTitle = String(entry.title || `预设 ${idx + 1}`).replace(/\|/g, '\\|');
            const mergeBadge = entry.sourceCount > 1 ? `（合并 ${entry.sourceCount} 条同款）` : '';
            const safeSummary = String(entry.summary || '').replace(/\|/g, '\\|');
            const refLink = `[${entry.slug}.md](./references/${entry.slug}.md)`;
            const jsonLink = `[${entry.slug}.json](./resources/${entry.slug}.json)`;
            if (includeJson) {
                indexLines.push(`| ${idx + 1} | **${safeTitle}**${mergeBadge} | ${safeSummary} | ${refLink} | ${jsonLink} |`);
            } else {
                indexLines.push(`| ${idx + 1} | **${safeTitle}**${mergeBadge} | ${safeSummary} | ${refLink} |`);
            }
        });

        if (isSingle) {
            indexLines.push(
                '',
                '### 单预设快速预览',
                '',
                `完整参数详见 [${entries[0].slug}.md](./references/${entries[0].slug}.md)` +
                (includeJson ? ` 与 [${entries[0].slug}.json](./resources/${entries[0].slug}.json)。` : '。'),
                '',
                '```text',
                entries[0].specMarkdown,
                '```'
            );
        }

        return frontmatter + header + rulesSection + indexLines.join('\n') + '\n';
    }

    function buildReferenceMarkdown(entry, index, includeJson) {
        const lines = [
            `# ${index + 1}. ${entry.title}`,
            '',
            `- **预设分类**：\`${entry.kind}\``,
            `- **参考画布**：\`${entry.width}×${entry.height}\` 像素`,
            `- **结构摘要**：${entry.summary}`,
        ];
        if (entry.sourceCount > 1) {
            lines.push(`- **同款合并计数**：原选中项中共 ${entry.sourceCount} 条共享此完全一致的排版与动效规格`);
        }
        if (includeJson) {
            lines.push(`- **对应结构化参数文件**：\`../resources/${entry.slug}.json\``);
        }
        lines.push('', '---', '', '## 像素级排版与动效规格说明', '', entry.specMarkdown.trim(), '');
        return lines.join('\n');
    }

    function buildPackageReadme(includeJson, hasDiagram = true, hasStylePreview = false) {
        return [
            '# 视频排版模板使用说明',
            '',
            '这是可重复使用的排版模板。请使用本次提供的新素材、新文案和字幕，不要将模板当成原视频内容。',
            '',
            '- `SKILL.md`：AI 使用模板的指导与预设索引。',
            '- `references/`：各预设的中文排版与动效规格。',
            ...(hasDiagram ? ['- `排版示意图.svg`：参考批量布局预览绘制的媒体、电话和标题位置示意。标题标记为近似位置，色块不代表实际渲染效果。'] : []),
            ...(hasStylePreview ? ['- `标题样式预览/`：使用示例文字的样式示意图；字体需本机安装，渐变、笔刷和复杂动效可能与实际效果不同。'] : []),
            ...(includeJson ? ['- `resources/`：供程序读取的结构化样式参数。'] : []),
            '',
            '参数中的参考画布以左上角为原点，X 向右、Y 向下；具体字段、尺寸与图层顺序以规格书和参数文件为准。',
            '',
            '此包不附带素材或渲染脚本。生成视频需要另行提供素材、文案和字幕，并使用支持相应效果的渲染工具。',
            '',
        ].join('\n');
    }

    function buildTitleStylePreviews(item, prefix = '') {
        const data = item.styleJson || {};
        const styles = [...(data.title_styles || []).map(entry => entry.style), ...(data.overlays || []).filter(ov => ov.type === 'textcard' && ov.enabled_slots?.title && !/(?:watermark|水印)/i.test(String(ov.slotKey || '') + String(ov.slotLabel || '')) && Object.keys(ov).some(key => /^title_(?:color|font|bg|adaptive)/.test(key)))];
        const esc = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
        const color = (value, fallback) => typeof value === 'string' && /^(?:#[0-9a-f]{3,8}|[a-z]{3,20})$/i.test(value.trim()) ? value.trim() : fallback;
        return styles.filter(Boolean).map((s, i) => {
            const fg = color(s.title_color, '#ffffff'), bg = color(s.title_bg_color, '#303c53');
            const family = esc(s.title_font_family || 'Arial');
            const size = Math.max(20, Math.min(100, num(s.title_fontsize, 60)));
            const weight = Math.max(100, Math.min(900, num(s.title_font_weight, s.title_bold ? 700 : 400)));
            const radius = Math.max(0, Math.min(100, num(s.title_bg_radius, 0)));
            const opacity = Math.max(0, Math.min(1, num(s.title_bg_opacity, 100) / 100));
            const stroke = color(s.independent_effects ? s.title_stroke_color : s.text_stroke_color, '#000000');
            const sw = Math.max(0, Math.min(12, num(s.independent_effects ? s.title_stroke_width : s.text_stroke_width)));
            const border = s.title_bg_border_enabled ? ` stroke="${color(s.title_bg_border_color, '#ffffff')}" stroke-width="${Math.max(0, Math.min(16, num(s.title_bg_border_width, 0)))}"` : '';
            const card = s.title_bg_enabled ? `<rect x="40" y="80" width="1000" height="170" rx="${radius}" fill="${bg}" fill-opacity="${opacity}"${border}/>` : '';
            const content = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="330" viewBox="0 0 1080 330"><title>标题样式示意（使用示例文字）</title><rect width="1080" height="330" fill="#222630"/>${card}<text x="540" y="165" text-anchor="middle" dominant-baseline="middle" font-family="${family}" font-size="${size}" font-weight="${weight}" font-style="${s.title_italic ? 'italic' : 'normal'}" fill="${fg}" stroke="${stroke}" stroke-width="${sw}" paint-order="stroke">SAMPLE TITLE</text></svg>\n`;
            return { relPath: `标题样式预览/${prefix}标题样式-${i + 1}.svg`, content };
        });
    }

    function buildLayoutDiagram(item) {
        const s = item.styleJson || {};
        const w = Math.max(1, num(s.canvas?.width, 1080));
        const h = Math.max(1, num(s.canvas?.height, 1920));
        const media = (s.overlays || []).filter(ov => !ov.disabled && ov.type === 'video');
        const boxes = media.map((ov, i) => {
            const r = ov.resolved_rect || ov.media_window || ov;
            const x = num(r.x), y = num(r.y), rw = num(r.w), rh = num(r.h);
            if (rw <= 0 || rh <= 0) return '';
            const key = String(ov.slotKey || '').toLowerCase();
            const role = key.includes('sermon') ? 'sermon' : key.includes('audience_main') ? 'main' : key.includes('audience') ? 'audience' : 'extra';
            const color = { sermon: '#2f6fed', main: '#f59e0b', audience: '#16a34a', extra: '#0d9488' }[role];
            const label = { sermon: '讲道', main: '主观众', audience: '观众', extra: '媒体' }[role];
            return `<rect x="${x}" y="${y}" width="${rw}" height="${rh}" fill="${color}" fill-opacity=".88" stroke="#ffffff" stroke-opacity=".35" stroke-width="${Math.max(2, w / 300)}"/><text x="${x + rw / 2}" y="${y + rh / 2}" text-anchor="middle" dominant-baseline="middle" fill="white" font-weight="600" font-size="${Math.max(24, Math.min(w * .04, rw / 5, rh / 4))}" font-family="sans-serif">${label}</text>`;
        }).join('');
        const annotations = (s.overlays || []).filter(ov => !ov.disabled).map(ov => {
            const key = String(ov.slotKey || '').toLowerCase();
            const r = ov.resolved_rect || ov;
            const x = num(r.x), y = num(r.y), rw = num(r.w), rh = num(r.h);
            if (rw <= 0 || rh <= 0) return '';
            const stroke = Math.max(3, w / 180), font = Math.max(26, w * .035);
            if (ov.type === 'image' && key.includes('phone')) {
                return `<rect x="${x}" y="${y}" width="${rw}" height="${rh}" fill="none" stroke="#f472b6" stroke-width="${stroke}" stroke-dasharray="${stroke * 3} ${stroke * 2}"/><text x="${Math.max(0, x) + 10}" y="${Math.max(font, y + font)}" fill="#fff" stroke="#111827" stroke-width="${stroke}" paint-order="stroke" font-size="${font}" font-weight="bold" font-family="sans-serif">电话层</text>`;
            }
            if (ov.type === 'textcard' && ov.enabled_slots?.title && !key.includes('watermark')) {
                const autoCenter = ov.auto_center_v === true || ov.auto_center_v === 1 || ov.auto_center_v === '1';
                const centerY = (autoCenter ? h / 2 : num(ov.y) + num(ov.h) / 2) + num(ov.offset_y) + num(ov.title_offset_y);
                const ty = Math.max(font, Math.min(h - font, centerY));
                return `<line x1="0" x2="${w}" y1="${ty}" y2="${ty}" stroke="#facc15" stroke-width="${stroke}" stroke-dasharray="${stroke * 3} ${stroke * 2}"/><text x="${w / 2}" y="${ty - font * .3}" text-anchor="middle" fill="#fff" stroke="#111827" stroke-width="${stroke}" paint-order="stroke" font-size="${font}" font-weight="bold" font-family="sans-serif">标题位置（示意）</text>`;
            }
            return '';
        }).join('');
        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><title>批量布局风格的排版示意（非实际渲染效果）</title><rect width="${w}" height="${h}" fill="#0b0d12"/>${boxes}${annotations}</svg>\n`;
    }

    /**
     * 纯函数：根据条目列表与导出配置构建完整的 Skill 文件夹与文件树
     */
    function buildSkillPackage(rawItems, config = {}) {
        const mode = config.mode === 'separate' ? 'separate' : 'library';
        const dedupe = config.deduplicate !== false;
        const includeJson = config.includeJson !== false;
        const items = dedupe ? deduplicateItems(rawItems) : (rawItems || []).slice();
        if (!items.length) throw new Error('没有可导出的预设或排版条目');

        const defaultDesc = 'Pixel-accurate short-form video layout, adaptive title card, overlay typography, scrolling text, watermark, and dynamic subtitle animation specifications exported from VideoKit. Use this skill when rendering or recreating videos and visual frames from new scripts and media assets.';

        if (mode === 'separate') {
            const date = config.exportDate || (() => {
                const d = new Date();
                return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            })();
            const templateName = toSafeFolderName(String(config.templateName || '').trim() || '模版', '模版');
            const rootFolders = items.map((item, idx) => {
                const folderName = `${date}-${templateName}-${idx + 1}`;

                const skillId = toSkillId(item.title, `videokit-preset-${idx + 1}`);
                const entry = Object.assign({}, item, { slug: 'preset-spec' });
                const desc = String(config.description || '').trim()
                    ? `${String(config.description).trim()} (Preset: ${item.title}, ${item.summary})`
                    : `${defaultDesc} Preset: ${item.title} (${item.summary}).`;

                const previews = buildTitleStylePreviews(item);
                const files = [
                    { relPath: '使用说明.md', content: buildPackageReadme(includeJson, true, previews.length > 0) },
                    { relPath: '排版示意图.svg', content: buildLayoutDiagram(item) },
                    ...previews,
                    {
                        relPath: 'SKILL.md',
                        content: buildSkillMarkdown({
                            skillId,
                            displayTitle: item.title,
                            description: desc,
                            entries: [entry],
                            includeJson,
                        }),
                    },
                    {
                        relPath: 'references/preset-spec.md',
                        content: buildReferenceMarkdown(entry, 0, includeJson),
                    },
                ];
                if (includeJson) {
                    files.push({
                        relPath: 'resources/preset-spec.json',
                        content: JSON.stringify(item.styleJson, null, 2) + '\n',
                    });
                }
                return { folderName, skillId, itemCount: 1, files };
            });

            return {
                mode: 'separate',
                inputCount: (rawItems || []).length,
                exportedPresetCount: items.length,
                rootFolders,
            };
        }

        // mode === 'library'：合并为 1 个预设库 Skill
        const folderName = toSafeFolderName(config.folderName || config.displayTitle || 'videokit-preset-skill');
        const displayTitle = String(config.displayTitle || config.folderName || 'VideoKit 排版与动效预设库').trim();
        const skillId = toSkillId(config.skillId || folderName, 'videokit-preset-library');
        const description = String(config.description || '').trim() || defaultDesc;

        const usedSlugs = new Set();
        const entries = items.map((item, idx) => {
            let slug = toSafeEntrySlug(item.title, idx);
            let n = 2;
            while (usedSlugs.has(slug.toLowerCase())) {
                slug = `${toSafeEntrySlug(item.title, idx)}-${n++}`;
            }
            usedSlugs.add(slug.toLowerCase());
            return Object.assign({}, item, { slug });
        });

        const previews = entries.flatMap((entry, index) => buildTitleStylePreviews(entry, `${index + 1}-`));
        const files = [
            { relPath: '使用说明.md', content: buildPackageReadme(includeJson, entries.length === 1, previews.length > 0) },
            ...previews,
            ...(entries.length === 1 ? [{ relPath: '排版示意图.svg', content: buildLayoutDiagram(entries[0]) }] : []),
            {
                relPath: 'SKILL.md',
                content: buildSkillMarkdown({
                    skillId,
                    displayTitle,
                    description,
                    entries,
                    includeJson,
                }),
            },
        ];

        entries.forEach((entry, idx) => {
            files.push({
                relPath: `references/${entry.slug}.md`,
                content: buildReferenceMarkdown(entry, idx, includeJson),
            });
            if (includeJson) {
                files.push({
                    relPath: `resources/${entry.slug}.json`,
                    content: JSON.stringify(entry.styleJson, null, 2) + '\n',
                });
            }
        });

        if (includeJson && entries.length > 1) {
            files.push({
                relPath: 'resources/index.json',
                content: JSON.stringify({
                    schema: 'videokit-skill-library-index/v1',
                    skill_id: skillId,
                    title: displayTitle,
                    total_presets: entries.length,
                    source_item_count: (rawItems || []).length,
                    presets: entries.map((e, idx) => ({
                        index: idx + 1,
                        title: e.title,
                        kind: e.kind,
                        canvas: { width: e.width, height: e.height },
                        summary: e.summary,
                        merged_source_count: e.sourceCount,
                        reference_markdown: `references/${e.slug}.md`,
                        style_json: `resources/${e.slug}.json`,
                    })),
                }, null, 2) + '\n',
            });
        }

        return {
            mode: 'library',
            inputCount: (rawItems || []).length,
            exportedPresetCount: entries.length,
            rootFolders: [{ folderName, skillId, itemCount: entries.length, files }],
        };
    }

    function joinFsPath(baseDir, ...parts) {
        const base = String(baseDir || '').replace(/[\\/]+$/, '');
        const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/';
        const normalizedParts = parts
            .flatMap(p => String(p || '').split(/[\\/]+/))
            .filter(Boolean);
        return [base, ...normalizedParts].join(sep);
    }

    function dirnameFsPath(fullPath) {
        const str = String(fullPath || '');
        const idx = Math.max(str.lastIndexOf('/'), str.lastIndexOf('\\'));
        return idx > 0 ? str.slice(0, idx) : str;
    }

    /**
     * 弹出系统文件夹选择框并将 Skill 包写入磁盘
     */
    async function chooseDirectoryAndWritePackage(pkg, options = {}) {
        const api = root.electronAPI;
        let baseDir = '';

        if (api?.showOpenDialog) {
            let lastDir = '';
            try { lastDir = root.localStorage?.getItem(LAST_DIR_STORE_KEY) || ''; } catch (_) {}
            const dialogOpts = {
                title: options.dialogTitle || '选择保存 Skill 的目标文件夹',
                properties: ['openDirectory', 'createDirectory'],
            };
            if (lastDir) dialogOpts.defaultPath = lastDir;
            const res = await api.showOpenDialog(dialogOpts);
            if (res?.canceled || !res?.filePaths?.length) return { canceled: true };
            baseDir = res.filePaths[0];
        } else if (api?.selectDirectory) {
            baseDir = await api.selectDirectory();
            if (!baseDir) return { canceled: true };
        } else if (typeof root.showDirectoryPicker === 'function') {
            // 浏览器 File System Access API 回退
            const dirHandle = await root.showDirectoryPicker({ mode: 'readwrite' });
            for (const folder of pkg.rootFolders) {
                const skillDirHandle = await dirHandle.getDirectoryHandle(folder.folderName, { create: true });
                for (const file of folder.files) {
                    const segs = file.relPath.split('/').filter(Boolean);
                    let cur = skillDirHandle;
                    for (let i = 0; i < segs.length - 1; i++) {
                        cur = await cur.getDirectoryHandle(segs[i], { create: true });
                    }
                    const fh = await cur.getFileHandle(segs[segs.length - 1], { create: true });
                    const writable = await fh.createWritable();
                    await writable.write(file.content);
                    await writable.close();
                }
            }
            return {
                canceled: false,
                baseDir: dirHandle.name,
                writtenPaths: pkg.rootFolders.map(f => `${dirHandle.name}/${f.folderName}`),
            };
        } else {
            throw new Error('当前环境不支持选择本地文件夹，请在桌面版中使用');
        }

        try { root.localStorage?.setItem(LAST_DIR_STORE_KEY, baseDir); } catch (_) {}

        // 检查同名目录是否已存在，提示确认覆盖
        const targetSkillDirs = pkg.rootFolders.map(f => joinFsPath(baseDir, f.folderName));
        if (typeof api?.checkFilesExist === 'function' && options.confirmOverwrite !== false) {
            try {
                const existsMap = await api.checkFilesExist(targetSkillDirs.map(d => joinFsPath(d, 'SKILL.md')));
                const existing = Object.entries(existsMap || {}).filter(([, ok]) => ok).map(([p]) => p);
                if (existing.length > 0 && typeof root.confirm === 'function') {
                    const ok = root.confirm(`所选目录中已存在 ${existing.length} 个同名 Skill（如 ${pkg.rootFolders[0].folderName}），是否覆盖更新？`);
                    if (!ok) return { canceled: true };
                }
            } catch (_) {}
        }

        const writtenPaths = [];
        for (const folder of pkg.rootFolders) {
            const skillRoot = joinFsPath(baseDir, folder.folderName);
            const dirsToCreate = new Set([skillRoot]);
            for (const file of folder.files) {
                dirsToCreate.add(dirnameFsPath(joinFsPath(skillRoot, file.relPath)));
            }
            for (const dir of dirsToCreate) {
                if (typeof api.ensureDirectory === 'function') {
                    const res = await api.ensureDirectory(dir);
                    if (res && res.ok === false) {
                        throw new Error(res.error || `无法创建目录：${dir}`);
                    }
                }
            }
            for (const file of folder.files) {
                const targetFile = joinFsPath(skillRoot, file.relPath);
                const ok = await api.writeFileText(targetFile, file.content);
                if (ok === false) {
                    throw new Error(`写入文件失败：${targetFile}`);
                }
            }
            writtenPaths.push(skillRoot);
        }

        return { canceled: false, baseDir, writtenPaths };
    }

    /**
     * 打开交互式 Skill 导出配置弹窗
     * @param {object} params
     * @param {Function|Array} params.buildItems - `(opts) => items[]` 或直接传 `items[]`
     * @param {string} [params.defaultName] - 默认文件夹/标题名称
     * @param {string} [params.sourceLabel] - 来源说明（如“已选 12 个视频任务”）
     * @param {boolean} [params.hasWatermarkOption] - 是否显示“保留文字水印固定文案”开关
     * @param {boolean} [params.hasGlobalWatermarks] - 是否存在可附带的全局已启用水印
     */
    function openSkillExportDialog(params = {}) {
        const doc = root.document;
        if (!doc?.createElement) return null;

        doc.querySelector('.videokit-skill-export-dialog')?.close?.();
        doc.querySelector('.videokit-skill-export-dialog')?.remove?.();

        const getItems = opts => {
            if (typeof params.buildItems === 'function') return params.buildItems(opts) || [];
            return Array.isArray(params.items) ? params.items : [];
        };

        let initialItems;
        try {
            initialItems = getItems({ includeWatermarks: true, keepWatermarkText: true });
        } catch (err) {
            root.showToast?.(`无法生成 Skill：${err.message}`, 'warning');
            return null;
        }

        if (!initialItems.length) {
            root.showToast?.('没有可导出的排版或预设数据', 'warning');
            return null;
        }

        const isMulti = initialItems.length > 1;
        const defaultBaseName = String(params.defaultName || (isMulti ? 'videokit-reels-preset-library' : initialItems[0].title || 'videokit-render-preset')).trim();
        const defaultFolder = toSafeFolderName(defaultBaseName, 'videokit-render-skill');
        const defaultSkillId = toSkillId(defaultBaseName, isMulti ? 'videokit-preset-library' : 'videokit-render-preset');
        const defaultDesc = 'Pixel-accurate video layout, overlay typography, adaptive title card, scrolling text, watermark, and dynamic subtitle animation specifications exported from VideoKit. Use this skill when the user provides new scripts/copywriting and media assets and wants to render or recreate videos/frames matching these exact preset styles.';

        const dialog = doc.createElement('dialog');
        dialog.className = 'videokit-skill-export-dialog';
        dialog.style.cssText = 'z-index:500000;width:min(580px,92vw);max-height:88vh;overflow:auto;background:#1e2030;color:#eef2ff;border:1px solid #4b5563;border-radius:14px;padding:22px;font:13px/1.5 system-ui,-apple-system,sans-serif;box-shadow:0 20px 50px rgba(0,0,0,0.65);';

        const heading = doc.createElement('h3');
        heading.textContent = '⚡ 一键生成 AI 复刻渲染 Skill';
        heading.style.cssText = 'margin:0 0 6px 0;font-size:17px;color:#fff;';

        const subHint = doc.createElement('p');
        subHint.textContent = `${params.sourceLabel || `共选中 ${initialItems.length} 个条目`} · 自动剥离全部视频/音频/图片路径与具体台词，仅保留像素坐标、字体配色、装饰线与动效规范。`;
        subHint.style.cssText = 'margin:0 0 14px 0;font-size:12px;color:#94a3b8;';

        const form = doc.createElement('div');
        form.style.cssText = 'display:grid;gap:12px;';

        // 1. 多条目组织方式
        let modeSelectLibrary = null, modeSelectSeparate = null, dedupeCheck = null, dedupeBadge = null;
        if (isMulti) {
            const modeBox = doc.createElement('div');
            modeBox.style.cssText = 'padding:10px 12px;background:#26293d;border:1px solid #3b4261;border-radius:9px;display:grid;gap:8px;';
            const modeTitle = doc.createElement('div');
            modeTitle.textContent = '批量组织方式';
            modeTitle.style.cssText = 'font-weight:600;color:#cbd5e1;font-size:12px;';

            const optLibLabel = doc.createElement('label');
            optLibLabel.style.cssText = 'display:flex;align-items:flex-start;gap:8px;cursor:pointer;';
            modeSelectLibrary = doc.createElement('input');
            modeSelectLibrary.type = 'radio';
            modeSelectLibrary.name = 'vk-skill-org-mode';
            modeSelectLibrary.value = 'library';
            modeSelectLibrary.checked = params.defaultMode === 'library';
            const optLibText = doc.createElement('span');
            optLibText.textContent = '合并为 1 个「预设库 Skill」';
            optLibLabel.append(modeSelectLibrary, optLibText);

            const optSepLabel = doc.createElement('label');
            optSepLabel.style.cssText = 'display:flex;align-items:flex-start;gap:8px;cursor:pointer;';
            modeSelectSeparate = doc.createElement('input');
            modeSelectSeparate.type = 'radio';
            modeSelectSeparate.name = 'vk-skill-org-mode';
            modeSelectSeparate.value = 'separate';
            modeSelectSeparate.checked = params.defaultMode !== 'library';
            const optSepText = doc.createElement('span');
            optSepText.textContent = '每条各自生成 1 个独立的 Skill 文件夹（在所选目录下批量创建多个子文件夹）';
            optSepLabel.append(modeSelectSeparate, optSepText);

            const dedupeLabel = doc.createElement('label');
            dedupeLabel.style.cssText = 'display:flex;align-items:center;gap:8px;cursor:pointer;margin-top:2px;padding-top:6px;border-top:1px dashed #3b4261;color:#a5b4fc;font-size:12px;';
            dedupeCheck = doc.createElement('input');
            dedupeCheck.type = 'checkbox';
            dedupeCheck.checked = false;
            dedupeBadge = doc.createElement('span');
            dedupeLabel.append(dedupeCheck, dedupeBadge);

            modeBox.append(modeTitle, optLibLabel, optSepLabel, dedupeLabel);
            form.append(modeBox);
        }

        // 2. 名称与 ID 输入区
        const nameSection = doc.createElement('div');
        nameSection.style.cssText = 'display:grid;gap:10px;';

        const makeField = (labelText, inputEl, helperText = '') => {
            const wrap = doc.createElement('div');
            wrap.style.cssText = 'display:grid;gap:4px;';
            const lbl = doc.createElement('label');
            lbl.textContent = labelText;
            lbl.style.cssText = 'font-size:12px;font-weight:600;color:#cbd5e1;';
            wrap.append(lbl, inputEl);
            if (helperText) {
                const small = doc.createElement('small');
                small.textContent = helperText;
                small.style.cssText = 'font-size:11px;color:#64748b;';
                wrap.append(small);
            }
            return wrap;
        };

        const inputCss = 'width:100%;box-sizing:border-box;padding:7px 10px;border-radius:7px;border:1px solid #475569;background:#131520;color:#f8fafc;font-size:13px;outline:none;';

        const folderInput = doc.createElement('input');
        folderInput.type = 'text';
        folderInput.value = defaultFolder;
        folderInput.style.cssText = inputCss;

        const idInput = doc.createElement('input');
        idInput.type = 'text';
        idInput.value = defaultSkillId;
        idInput.style.cssText = inputCss;
        let userEditedId = false;
        idInput.oninput = () => { userEditedId = true; };
        folderInput.oninput = () => {
            if (!userEditedId) {
                idInput.value = toSkillId(folderInput.value, isMulti ? 'videokit-preset-library' : 'videokit-render-preset');
            }
        };

        const folderFieldWrap = makeField('Skill 文件夹 / 预设库名称', folderInput, '将在你选择的目标目录下创建此名称的 Skill 文件夹');
        const idFieldWrap = makeField('Skill 英文标识 (SKILL.md name)', idInput, '仅限小写字母、数字与连字符（如 videokit-reels-presets）');
        const templateNameInput = doc.createElement('input');
        templateNameInput.type = 'text';
        templateNameInput.placeholder = '模版';
        templateNameInput.style.cssText = inputCss;
        const templateNameField = makeField('独立文件夹的模版名称', templateNameInput, '留空使用“模版”；文件夹格式：日期-模版名称-序号');
        form.append(templateNameField);
        nameSection.append(folderFieldWrap, idFieldWrap);
        form.append(nameSection);

        const descInput = doc.createElement('textarea');
        descInput.rows = 3;
        descInput.value = defaultDesc;
        descInput.style.cssText = inputCss + 'resize:vertical;font-family:inherit;';
        form.append(makeField('AI 触发与用途描述 (description)', descInput));

        // 3. 参数细节勾选区
        const optsBox = doc.createElement('div');
        optsBox.style.cssText = 'padding:10px 12px;background:#26293d;border:1px solid #3b4261;border-radius:9px;display:grid;gap:7px;font-size:12px;';

        const jsonLabel = doc.createElement('label');
        jsonLabel.style.cssText = 'display:flex;align-items:center;gap:8px;cursor:pointer;';
        const jsonCheck = doc.createElement('input');
        jsonCheck.type = 'checkbox';
        jsonCheck.checked = true;
        const jsonSpan = doc.createElement('span');
        jsonSpan.textContent = '同时写入「中文像素级排版动效说明 (references/*.md)」与「脱敏纯样式参数 (resources/*.json)」';
        jsonLabel.append(jsonCheck, jsonSpan);
        optsBox.append(jsonLabel);

        let includeGlobalWmCheck = null;
        if (params.hasGlobalWatermarks) {
            const gwmLabel = doc.createElement('label');
            gwmLabel.style.cssText = 'display:flex;align-items:center;gap:8px;cursor:pointer;';
            includeGlobalWmCheck = doc.createElement('input');
            includeGlobalWmCheck.type = 'checkbox';
            includeGlobalWmCheck.checked = true;
            const gwmSpan = doc.createElement('span');
            gwmSpan.textContent = '一并附带当前工程已启用的全局水印位置与样式（自动剥离图片水印路径）';
            gwmLabel.append(includeGlobalWmCheck, gwmSpan);
            optsBox.append(gwmLabel);
        }

        let keepWmTextCheck = null;
        if (params.hasWatermarkOption || params.hasGlobalWatermarks) {
            const wmLabel = doc.createElement('label');
            wmLabel.style.cssText = 'display:flex;align-items:center;gap:8px;cursor:pointer;';
            keepWmTextCheck = doc.createElement('input');
            keepWmTextCheck.type = 'checkbox';
            keepWmTextCheck.checked = false;
            const wmSpan = doc.createElement('span');
            wmSpan.textContent = '保留文字水印中的固定水印文案（取消勾选则文字水印也只留样式不留字）';
            wmLabel.append(keepWmTextCheck, wmSpan);
            optsBox.append(wmLabel);
        }

        form.append(optsBox);

        const statusEl = doc.createElement('p');
        statusEl.setAttribute('role', 'status');
        statusEl.style.cssText = 'margin:4px 0 0 0;min-height:18px;font-size:12px;color:#fbbf24;';

        const footer = doc.createElement('div');
        footer.style.cssText = 'display:flex;justify-content:flex-end;gap:10px;margin-top:14px;';

        const cancelBtn = doc.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.textContent = '取消';
        cancelBtn.style.cssText = 'padding:7px 15px;border-radius:8px;border:1px solid #475569;background:#2a2e42;color:#e2e8f0;cursor:pointer;font-size:13px;';
        cancelBtn.onclick = () => dialog.close();

        const exportBtn = doc.createElement('button');
        exportBtn.type = 'button';
        exportBtn.textContent = '📂 选择保存文件夹并生成 Skill';
        exportBtn.style.cssText = 'padding:7px 16px;border-radius:8px;border:none;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;font-weight:600;cursor:pointer;font-size:13px;';

        const refreshPreviewCounts = () => {
            const currentItems = getItems({
                includeWatermarks: includeGlobalWmCheck ? includeGlobalWmCheck.checked : true,
                keepWatermarkText: keepWmTextCheck ? keepWmTextCheck.checked : true,
            });
            const uniqueCount = deduplicateItems(currentItems).length;
            if (dedupeBadge) {
                dedupeBadge.textContent = `自动合并完全相同的排版与动效样式（${currentItems.length} 条输入 → 去重后 ${uniqueCount} 套独立样式）`;
            }
            const isSep = !isMulti || Boolean(modeSelectSeparate?.checked);
            nameSection.style.display = isSep ? 'none' : 'grid';
            templateNameField.style.display = isSep ? 'grid' : 'none';
        };

        if (modeSelectLibrary) modeSelectLibrary.onchange = refreshPreviewCounts;
        if (modeSelectSeparate) modeSelectSeparate.onchange = refreshPreviewCounts;
        if (dedupeCheck) dedupeCheck.onchange = refreshPreviewCounts;
        if (includeGlobalWmCheck) includeGlobalWmCheck.onchange = refreshPreviewCounts;
        if (keepWmTextCheck) keepWmTextCheck.onchange = refreshPreviewCounts;
        refreshPreviewCounts();

        exportBtn.onclick = async () => {
            statusEl.textContent = '';
            exportBtn.disabled = true;
            const prevLabel = exportBtn.textContent;
            exportBtn.textContent = '正在准备并打开目录选择…';
            try {
                const mode = !isMulti || modeSelectSeparate?.checked ? 'separate' : 'library';
                const currentItems = getItems({
                    includeWatermarks: includeGlobalWmCheck ? includeGlobalWmCheck.checked : true,
                    keepWatermarkText: keepWmTextCheck ? keepWmTextCheck.checked : true,
                });
                const pkg = buildSkillPackage(currentItems, {
                    mode,
                    templateName: templateNameInput.value,
                    deduplicate: dedupeCheck ? dedupeCheck.checked : true,
                    includeJson: jsonCheck.checked,
                    folderName: folderInput.value.trim() || defaultFolder,
                    displayTitle: folderInput.value.trim() || defaultBaseName,
                    skillId: idInput.value.trim() || defaultSkillId,
                    description: descInput.value.trim() || defaultDesc,
                });

                const res = await chooseDirectoryAndWritePackage(pkg);
                if (res?.canceled) {
                    exportBtn.disabled = false;
                    exportBtn.textContent = prevLabel;
                    return;
                }

                dialog.close();
                const summaryMsg = pkg.mode === 'separate'
                    ? `✅ 已导出 ${pkg.rootFolders.length} 个独立 Skill 到：${res.baseDir}`
                    : `✅ 已生成 Skill「${pkg.rootFolders[0].folderName}」（含 ${pkg.exportedPresetCount} 套预设）→ ${res.writtenPaths[0]}`;
                root.showToast?.(summaryMsg, 'success', 6000);
            } catch (error) {
                statusEl.textContent = `生成失败：${error.message}`;
                exportBtn.disabled = false;
                exportBtn.textContent = prevLabel;
            }
        };

        footer.append(cancelBtn, exportBtn);
        dialog.append(heading, subHint, form, statusEl, footer);
        dialog.onclose = () => dialog.remove();
        dialog.addEventListener?.('keydown', event => event.stopPropagation());
        doc.body.appendChild(dialog);
        if (typeof dialog.showModal === 'function') dialog.showModal();
        else dialog.open = true;
        return dialog;
    }

    /**
     * 快捷入口 1：从任务列表打开生成 Skill 弹窗（已在勾选层弹窗选好层后调用，或直接传入任务列表）
     */
    function openForTasks(tasks, layerOptions = {}) {
        const list = Array.isArray(tasks) ? tasks.filter(Boolean) : [];
        if (!list.length) {
            root.showToast?.('请先选择至少一个任务', 'warning');
            return null;
        }
        const globalWms = (root._reelsState?.watermarks || []).filter(wm => wm && wm.enabled);
        const defaultName = list.length === 1
            ? `videokit-layout-preset`
            : `videokit-layout-presets-${list.length}`;

        return openSkillExportDialog({
            sourceLabel: list.length === 1 ? '当前选中 1 个视频任务排版' : `已选中 ${list.length} 个视频任务排版`,
            defaultName,
            hasGlobalWatermarks: globalWms.length > 0,
            buildItems: ({ includeWatermarks, keepWatermarkText }) =>
                list.map((task, index) => createTaskSkillItem(task, {
                    ...layerOptions,
                    index,
                    title: list.length === 1 ? '视频排版与动效预设' : `排版预设 ${index + 1}`,
                    watermarks: includeWatermarks ? globalWms : [],
                    includeWatermarks,
                    keepWatermarkText,
                })),
        });
    }

    /**
     * 快捷入口 2：从工程与模板库导出选中的模板列表为 Skill
     */
    function openForTemplates(templates) {
        const list = Array.isArray(templates) ? templates.filter(Boolean) : [];
        if (!list.length) {
            root.showToast?.('请先勾选至少一个模板', 'warning');
            return null;
        }
        const anyWatermark = list.some(tpl => {
            const wms = tpl?.projectData?.exportOpts?.watermarks || tpl?.exportOpts?.watermarks || [];
            return Array.isArray(wms) && wms.some(w => w && w.enabled);
        });
        const firstName = String(list[0]?.name || 'videokit-template').trim();
        const defaultName = list.length === 1 ? `${firstName}-skill` : `videokit-template-presets-${list.length}`;

        return openSkillExportDialog({
            sourceLabel: list.length === 1 ? `工程模板「${firstName}」` : `已选 ${list.length} 个工程模板`,
            defaultName,
            hasWatermarkOption: anyWatermark,
            buildItems: ({ keepWatermarkText }) =>
                createTemplateSkillItems(list, { keepWatermarkText, includeWatermarks: true }),
        });
    }

    /**
     * 快捷入口 3：从布局编辑器导出当前布局方案为 Skill
     */
    function openForLayoutScheme(scheme, task, options = {}) {
        const schemeName = String(scheme?.name || '布局方案').trim();
        return openSkillExportDialog({
            sourceLabel: `布局编辑器方案「${schemeName}」`,
            defaultName: `${schemeName}-layout-skill`,
            buildItems: () => [createLayoutSchemeSkillItem(scheme, task, options)],
        });
    }

    /**
     * 快捷入口 4：从动态字幕预设（单个或批量）生成 Skill
     */
    function openForSubtitlePresets(presetEntries, options = {}) {
        // presetEntries: [{ name, style }]
        const list = (presetEntries || []).filter(e => e && e.name && e.style && typeof e.style === 'object');
        if (!list.length) {
            root.showToast?.('未找到可导出的动态字幕预设', 'warning');
            return null;
        }
        const defaultName = list.length === 1
            ? `${list[0].name}-subtitle-skill`
            : (options.defaultName || `videokit-subtitle-presets-${list.length}`);

        return openSkillExportDialog({
            sourceLabel: list.length === 1 ? `动态字幕预设「${list[0].name}」` : `共 ${list.length} 套动态字幕预设`,
            defaultName,
            buildItems: () => list.map(entry => createSubtitlePresetSkillItem(entry.name, entry.style, options)),
        });
    }

    /**
     * 快捷入口 5：从水印面板生成 Skill
     */
    function openForWatermarks(watermarks, options = {}) {
        const enabled = (watermarks || []).filter(wm => wm && wm.enabled);
        if (!enabled.length) {
            root.showToast?.('暂无已启用的水印，请先启用要生成 Skill 的水印', 'warning');
            return null;
        }
        return openSkillExportDialog({
            sourceLabel: `已启用水印（${enabled.length} 个）`,
            defaultName: enabled.length === 1 ? 'videokit-watermark-skill' : `videokit-watermarks-${enabled.length}-skill`,
            hasWatermarkOption: enabled.some(w => w.type !== 'image'),
            buildItems: ({ keepWatermarkText }) => [
                createWatermarkSkillItem(enabled, { ...options, keepWatermarkText }),
            ],
        });
    }

    return {
        looksLikeMediaOrPathString,
        sanitizeStyleValue,
        sanitizeOverlay,
        sanitizeSubtitleStyle,
        sanitizeWatermark,
        createTaskSkillItem,
        createTemplateSkillItems,
        createLayoutSchemeSkillItem,
        createSubtitlePresetSkillItem,
        createWatermarkSkillItem,
        deduplicateItems,
        toSkillId,
        toSafeFolderName,
        buildSkillPackage,
        chooseDirectoryAndWritePackage,
        openSkillExportDialog,
        openForTasks,
        openForTemplates,
        openForLayoutScheme,
        openForSubtitlePresets,
        openForWatermarks,
    };
});
