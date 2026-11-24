/**
 * reels-overlay.js — 覆层系统（图片/文本 Overlay）
 * 
 * 完整移植自 AutoSub_v8 FrameRenderer:
 *   - draw_single_overlay()    → 渲染单个覆层
 *   - draw_image_elements()    → 渲染图片元素组
 *   - 文本覆层: 多样式、描边、阴影、背景框
 *   - 图片覆层: 缩放、翻转、混合模式
 *   - 覆层管理: CRUD、z-order、时间范围
 * 
 * 使用 Canvas 2D API 替代 Qt QPainter。
 */

// ═══════════════════════════════════════════════════════
// 1. Overlay Data Model
// ═══════════════════════════════════════════════════════

/**
 * 创建文本覆层对象。
 * @param {object} opts
 * @returns {object} overlay
 */
function createTextOverlay(opts = {}) {
    return {
        id: _overlayId(),
        type: 'text',
        synthetic_bold_enabled: opts.synthetic_bold_enabled === true,
        content: opts.content || '标题文字',
        x: opts.x ?? 100,
        y: opts.y ?? 100,
        w: opts.w ?? 400,
        h: opts.h ?? 120,
        rotation: opts.rotation ?? 0,
        opacity: opts.opacity ?? 255,
        start: opts.start ?? 0,
        end: opts.end ?? 5,
        // 字体
        font_family: opts.font_family || 'Arial',
        font_weight: opts.font_weight ?? (opts.bold ? 700 : 400),
        fontsize: opts.fontsize || 40,
        bold: opts.bold || false,
        italic: opts.italic || false,
        color: opts.color || '#FFFFFF',
        // auto follows the first strong character (Arabic/Hebrew → RTL).
        text_direction: opts.text_direction || 'auto',
        // 描边
        use_stroke: opts.use_stroke || false,
        stroke_color: opts.stroke_color || '#000000',
        stroke_width: opts.stroke_width || 2,
        // 阴影
        shadow_enabled: opts.shadow_enabled || false,
        shadow_color: opts.shadow_color || '#000000',
        shadow_opacity: opts.shadow_opacity || 120,
        shadow_blur: opts.shadow_blur || 4,
        shadow_offset_x: opts.shadow_offset_x || 4,
        shadow_offset_y: opts.shadow_offset_y || 4,
        // 背景
        bg_enabled: opts.bg_enabled || false,
        bg_color: opts.bg_color || '#000000',
        bg_opacity: opts.bg_opacity || 191,
        bg_radius: opts.bg_radius || 12,
        bg_padding: opts.bg_padding || 12,
        // 动画
        transition_preset: opts.transition_preset || 'none',
        transition_duration: opts.transition_duration || 0.35,
        anim_in_type: opts.anim_in_type || 'none',
        anim_out_type: opts.anim_out_type || 'none',
        anim_in_duration: opts.anim_in_duration || 0.3,
        anim_out_duration: opts.anim_out_duration || 0.3,
        // 文本布局
        text_layout: opts.text_layout || { align: 'center', left_pad: 10, right_pad: 10, top_pad: 10, bottom_pad: 10, line_spacing: 0 },
        // 文字翻转器
        flipper_enabled: opts.flipper_enabled || false,
        flipper_duration: opts.flipper_duration ?? 2.0,
        flipper_lines: opts.flipper_lines ?? 2,
        flipper_loop: opts.flipper_loop ?? false,
        flipper_effect: opts.flipper_effect || 'none',
        flipper_transition_duration: opts.flipper_transition_duration ?? 0.3,
    };
}

/**
 * 创建图片覆层对象。
 */
function createImageOverlay(opts = {}) {
    return {
        id: _overlayId(),
        type: 'image',
        content: opts.content || '',   // 图片路径
        // 新建图片覆层默认铺满 9:16 画布；需要小贴纸时仍可在属性面板调整。
        x: opts.x ?? 0,
        y: opts.y ?? 0,
        w: opts.w ?? 1080,
        h: opts.h ?? 1920,
        rotation: opts.rotation ?? 0,
        opacity: opts.opacity ?? 255,
        // 单轴缩放保留给旧工程兼容；新覆层可分别调节水平和垂直缩放。
        scale: opts.scale ?? 1.0,
        scale_x: opts.scale_x ?? opts.scale ?? 1.0,
        scale_y: opts.scale_y ?? opts.scale ?? 1.0,
        start: opts.start ?? 0,
        end: opts.end ?? 5,
        flip_x: opts.flip_x || false,
        flip_y: opts.flip_y || false,
        keep_aspect: opts.keep_aspect !== false,
        media_blur_fill: opts.media_blur_fill === true,
        blend_mode: opts.blend_mode || 'source-over',
        transition_preset: opts.transition_preset || 'none',
        transition_duration: opts.transition_duration || 0.35,
        // 入/出场动画
        anim_in_type: opts.anim_in_type || 'none',
        anim_out_type: opts.anim_out_type || 'none',
        anim_in_duration: opts.anim_in_duration || 0.3,
        anim_out_duration: opts.anim_out_duration || 0.3,
    };
}

/**
 * 创建文字卡片覆层对象。
 * 包含：纯色半透明背景 + 四角独立圆角 + 标题 + 内容（不同字体样式）
 */
function createTextCardOverlay(opts = {}) {
    return {
        id: _overlayId(),
        type: 'textcard',
        synthetic_bold_enabled: opts.synthetic_bold_enabled === true,
        // ── 卡片位置/尺寸 ──
        // Top-left defaults corresponding to center position (0,0) for 1080x1920 with 910x1300 card
        x: opts.x ?? 85,
        y: opts.y ?? 310,
        w: opts.w ?? 910,
        h: opts.h ?? 1300,        // 默认1300；手动设为0时表示自动计算高度
        rotation: opts.rotation ?? 0,
        opacity: opts.opacity ?? 255,
        start: opts.start ?? 0,
        end: opts.end ?? 9999,
        // 默认蒙版与文字共用时间；关闭后可分别安排背景蒙版。
        card_time_linked: opts.card_time_linked !== false,
        mask_start: opts.mask_start ?? (opts.start ?? 0),
        mask_end: opts.mask_end ?? (opts.end ?? 9999),
        // Text-card sections inherit this setting; auto detects each card's content.
        text_direction: opts.text_direction || 'auto',
        // ── 卡片背景 ──
        card_color: opts.card_color || '#FFFFFF',
        card_opacity: opts.card_opacity ?? 80,    // 0-100 (百分比)
        // ── 四角独立圆角 ──
        radius_tl: opts.radius_tl ?? 33,  // 左上
        radius_tr: opts.radius_tr ?? 33,  // 右上
        radius_bl: opts.radius_bl ?? 33,  // 左下
        radius_br: opts.radius_br ?? 33,  // 右下
        // ── 标题 ──
        title_text: opts.title_text ?? '标题文字',
        title_font_family: opts.title_font_family || 'Crimson Pro',
        title_font_weight: opts.title_font_weight ?? (opts.title_bold !== false ? 900 : 400),
        title_fontsize: opts.title_fontsize ?? 60,
        title_bold: opts.title_bold !== false,
        title_italic: opts.title_italic || false,
        title_color: opts.title_color || '#000000',
        title_gradient_direction: opts.title_gradient_direction || 'horizontal',
        title_align: opts.title_align || 'center',
        title_valign: opts.title_valign || 'top',
        title_uppercase: opts.title_uppercase ?? true,
        title_letter_spacing: opts.title_letter_spacing ?? 0,
        title_line_spacing: opts.title_line_spacing ?? 0,
        // 独立标题旋转：围绕标题区中心旋转，不影响卡片或正文。
        title_rotation: opts.title_rotation ?? 0,
        // ── 内容 ──
        body_text: opts.body_text ?? '内容文字',
        body_font_family: opts.body_font_family || 'Arial',
        body_font_weight: opts.body_font_weight ?? (opts.body_bold ? 700 : 400),
        body_fontsize: opts.body_fontsize ?? 40,
        body_bold: opts.body_bold || false,
        body_italic: opts.body_italic || false,
        body_color: opts.body_color || '#000000',
        body_gradient_direction: opts.body_gradient_direction || 'horizontal',
        body_align: opts.body_align || 'center',
        body_valign: opts.body_valign || 'top',
        body_letter_spacing: opts.body_letter_spacing ?? 0,
        body_line_spacing: opts.body_line_spacing ?? 6,
        // ── 结尾 ──
        footer_text: opts.footer_text ?? '',
        footer_font_family: opts.footer_font_family || 'Arial',
        footer_font_weight: opts.footer_font_weight ?? (opts.footer_bold ? 700 : 400),
        footer_fontsize: opts.footer_fontsize ?? 32,
        footer_bold: opts.footer_bold || false,
        footer_italic: opts.footer_italic || false,
        footer_color: opts.footer_color || '#666666',
        footer_gradient_direction: opts.footer_gradient_direction || 'horizontal',
        footer_align: opts.footer_align || 'center',
        footer_valign: opts.footer_valign || 'top',
        footer_letter_spacing: opts.footer_letter_spacing ?? 0,
        footer_line_spacing: opts.footer_line_spacing ?? 0,
        // ── 文字效果（共享模式）──
        text_stroke_color: opts.text_stroke_color || '#000000',
        text_stroke_width: opts.text_stroke_width ?? 0,
        text_shadow_color: opts.text_shadow_color || '#000000',
        text_shadow_blur: opts.text_shadow_blur ?? 0,
        text_shadow_x: opts.text_shadow_x ?? 0,
        text_shadow_y: opts.text_shadow_y ?? 0,
        // ── 独立效果模式 ──
        independent_effects: opts.independent_effects ?? false,
        // 标题独立效果
        title_stroke_color: opts.title_stroke_color || '#000000',
        title_stroke_width: opts.title_stroke_width ?? 0,
        title_shadow_color: opts.title_shadow_color || '#000000',
        title_shadow_blur: opts.title_shadow_blur ?? 0,
        title_shadow_x: opts.title_shadow_x ?? 0,
        title_shadow_y: opts.title_shadow_y ?? 0,
        // 内容独立效果
        body_stroke_color: opts.body_stroke_color || '#000000',
        body_stroke_width: opts.body_stroke_width ?? 0,
        body_shadow_color: opts.body_shadow_color || '#000000',
        body_shadow_blur: opts.body_shadow_blur ?? 0,
        body_shadow_x: opts.body_shadow_x ?? 0,
        body_shadow_y: opts.body_shadow_y ?? 0,
        // 结尾独立效果
        footer_stroke_color: opts.footer_stroke_color || '#000000',
        footer_stroke_width: opts.footer_stroke_width ?? 0,
        footer_shadow_color: opts.footer_shadow_color || '#000000',
        footer_shadow_blur: opts.footer_shadow_blur ?? 0,
        footer_shadow_x: opts.footer_shadow_x ?? 0,
        footer_shadow_y: opts.footer_shadow_y ?? 0,
        // 独立背景（每部分单独背景色/透明度/圆角）
        title_bg_enabled: opts.title_bg_enabled ?? false,
        title_bg_mode: opts.title_bg_mode || 'block',
        title_bg_color: opts.title_bg_color || '#000000',
        title_bg_opacity: opts.title_bg_opacity ?? 60,
        title_bg_border_enabled: opts.title_bg_border_enabled ?? false,
        title_bg_border_color: opts.title_bg_border_color ?? '#ffffff',
        title_bg_border_width: opts.title_bg_border_width ?? 3,
        title_bg_border_style: opts.title_bg_border_style ?? 'solid',
        title_bg_border_opacity: opts.title_bg_border_opacity ?? 100,
        title_bg_radius: opts.title_bg_radius ?? 12,
        title_bg_concave_radius: opts.title_bg_concave_radius ?? 10,
        title_bg_snap_threshold: opts.title_bg_snap_threshold ?? 18,
        title_bg_pad_h: opts.title_bg_pad_h ?? 0,
        title_bg_pad_top: opts.title_bg_pad_top ?? 0,
        title_bg_pad_bottom: opts.title_bg_pad_bottom ?? 0,

        body_bg_enabled: opts.body_bg_enabled ?? false,
        body_bg_mode: opts.body_bg_mode || 'block',
        body_bg_color: opts.body_bg_color || '#000000',
        body_bg_opacity: opts.body_bg_opacity ?? 60,
        body_bg_border_enabled: opts.body_bg_border_enabled ?? false,
        body_bg_border_color: opts.body_bg_border_color ?? '#ffffff',
        body_bg_border_width: opts.body_bg_border_width ?? 3,
        body_bg_border_style: opts.body_bg_border_style ?? 'solid',
        body_bg_border_opacity: opts.body_bg_border_opacity ?? 100,
        body_bg_radius: opts.body_bg_radius ?? 12,
        body_bg_concave_radius: opts.body_bg_concave_radius ?? 10,
        body_bg_snap_threshold: opts.body_bg_snap_threshold ?? 18,
        body_bg_pad_h: opts.body_bg_pad_h ?? 0,
        body_bg_pad_top: opts.body_bg_pad_top ?? 0,
        body_bg_pad_bottom: opts.body_bg_pad_bottom ?? 0,

        footer_bg_enabled: opts.footer_bg_enabled ?? false,
        footer_bg_mode: opts.footer_bg_mode || 'block',
        footer_bg_color: opts.footer_bg_color || '#000000',
        footer_bg_opacity: opts.footer_bg_opacity ?? 60,
        footer_bg_border_enabled: opts.footer_bg_border_enabled ?? false,
        footer_bg_border_color: opts.footer_bg_border_color ?? '#ffffff',
        footer_bg_border_width: opts.footer_bg_border_width ?? 3,
        footer_bg_border_style: opts.footer_bg_border_style ?? 'solid',
        footer_bg_border_opacity: opts.footer_bg_border_opacity ?? 100,
        footer_bg_radius: opts.footer_bg_radius ?? 12,
        footer_bg_concave_radius: opts.footer_bg_concave_radius ?? 10,
        footer_bg_snap_threshold: opts.footer_bg_snap_threshold ?? 18,
        footer_bg_pad_h: opts.footer_bg_pad_h ?? 0,
        footer_bg_pad_top: opts.footer_bg_pad_top ?? 0,
        footer_bg_pad_bottom: opts.footer_bg_pad_bottom ?? 0,
        // ── 自动适配 ──
        auto_fit: opts.auto_fit === true,         // 默认关闭；仅显式开启时生效
        auto_center_v: opts.auto_center_v === true, // 默认关闭；仅显式开启时生效
        // ── 内边距 ──
        padding_top: opts.padding_top ?? 60,
        padding_bottom: opts.padding_bottom ?? 60,
        padding_left: opts.padding_left ?? 40,
        padding_right: opts.padding_right ?? 40,
        title_body_gap: opts.title_body_gap ?? 42,  // 标题与正文间距
        body_footer_gap: opts.body_footer_gap ?? 42, // 正文与结尾间距
        layout_mode: opts.layout_mode || 'flow',
        side_by_side_gap: opts.side_by_side_gap ?? 90,
        side_by_side_title_ratio: opts.side_by_side_title_ratio ?? 50,
        // ── 自适应限制 ──
        max_height: opts.max_height ?? 1400,
        auto_shrink: opts.auto_shrink === true,
        title_max_lines: opts.title_max_lines ?? 3,
        min_fontsize: opts.min_fontsize ?? 16,
        title_auto_shrink: opts.title_auto_shrink ?? false,
        title_override_w: opts.title_override_w ?? 0,
        title_override_h: opts.title_override_h ?? 0,
        title_max_glyph_height: opts.title_max_glyph_height ?? 60,
        title_adaptive_enabled: opts.title_adaptive_enabled === true,
        title_frame_enabled: opts.title_frame_enabled === true,
        title_preferred_glyph_height: opts.title_preferred_glyph_height ?? 45,
        title_adaptive_min_w: opts.title_adaptive_min_w ?? 1080,
        title_adaptive_min_h: opts.title_adaptive_min_h ?? 200,
        title_adaptive_max_w: opts.title_adaptive_max_w ?? 1080,
        title_adaptive_max_h: opts.title_adaptive_max_h ?? 300,
        title_adaptive_max_lines: opts.title_adaptive_max_lines ?? 3,
        fullscreen_mask: opts.fullscreen_mask ?? false,
        // ── 蒙版边框 ──
        card_border_enabled: opts.card_border_enabled ?? false,
        card_border_color: opts.card_border_color || '#FFD700',
        card_border_width: opts.card_border_width ?? 3,
        card_border_style: opts.card_border_style || 'solid',   // solid | dashed | dotted
        card_border_opacity: opts.card_border_opacity ?? 100,    // 0-100 (百分比)
        // ── 磨砂模糊 ──
        card_blur_enabled: opts.card_blur_enabled ?? false,
        card_blur_amount: opts.card_blur_amount ?? 10,           // 模糊强度 px (1-30)
        // ── 标题装饰线 ──
        title_deco_enabled: opts.title_deco_enabled ?? false,
        title_deco_parameters: opts.title_deco_parameters ? JSON.parse(JSON.stringify(opts.title_deco_parameters)) : undefined,
        title_deco_position: opts.title_deco_position || 'bottom',  // top | bottom
        title_deco_style: opts.title_deco_style || 'solid',         // solid | dashed | dotted | double | gradient
        title_deco_color: opts.title_deco_color || '#FFD700',
        title_deco_color2: opts.title_deco_color2 || '#FF6B35',     // gradient 模式的第二色
        title_deco_gradient_direction: opts.title_deco_gradient_direction || 'horizontal',
        title_deco_thickness: opts.title_deco_thickness ?? 3,       // 线条粗细 px
        title_deco_length: opts.title_deco_length ?? 0,             // 0=跟随标题宽度
        title_deco_gap: opts.title_deco_gap ?? 12,                  // 与标题的距离 px
        title_deco_opacity: opts.title_deco_opacity ?? 100,         // 0-100
        title_deco_align: opts.title_deco_align || 'center',        // left | center | right
        // ── 获取位置偏移 ──
        offset_x: opts.offset_x ?? 0,
        offset_y: opts.offset_y ?? 0,
        // ── 动画 ──
        transition_preset: opts.transition_preset || 'none',
        transition_duration: opts.transition_duration || 0.35,
        anim_in_type: opts.anim_in_type || 'none',
        anim_out_type: opts.anim_out_type || 'none',
        anim_in_duration: opts.anim_in_duration || 0.3,
        anim_out_duration: opts.anim_out_duration || 0.3,
        // ── 富文本样式范围 ──
        title_styled_ranges: opts.title_styled_ranges || null,
        body_styled_ranges: opts.body_styled_ranges || null,
        footer_styled_ranges: opts.footer_styled_ranges || null,
        // 文字翻转器
        flipper_enabled: opts.flipper_enabled || false,
        flipper_duration: opts.flipper_duration ?? 2.0,
        flipper_lines: opts.flipper_lines ?? 2,
        flipper_loop: opts.flipper_loop ?? false,
        flipper_effect: opts.flipper_effect || 'none',
        flipper_transition_duration: opts.flipper_transition_duration ?? 0.3,
    };
}

/**
 * 创建纯色蒙版覆层对象。
 */
function createSolidMaskOverlay(opts = {}) {
    return {
        id: _overlayId(),
        type: 'solid_mask',
        x: opts.x ?? 85,
        y: opts.y ?? 310,
        w: opts.w ?? 910,
        h: opts.h ?? 1300,
        rotation: opts.rotation ?? 0,
        opacity: opts.opacity ?? 255,
        start: opts.start ?? 0,
        end: opts.end ?? 9999,
        // 背景/蒙版
        card_color: opts.card_color || '#000000',
        card_opacity: opts.card_opacity ?? 50,
        // 四角圆角
        radius_tl: opts.radius_tl ?? 0,
        radius_tr: opts.radius_tr ?? 0,
        radius_bl: opts.radius_bl ?? 0,
        radius_br: opts.radius_br ?? 0,
        // 全屏蒙版
        fullscreen_mask: opts.fullscreen_mask ?? false,
        // 磨砂模糊
        card_blur_enabled: opts.card_blur_enabled ?? false,
        card_blur_amount: opts.card_blur_amount ?? 10,
        // 羽化
        card_feather_enabled: opts.card_feather_enabled ?? false,
        card_feather_dir: opts.card_feather_dir || 'bottom',
        card_feather_start: opts.card_feather_start ?? 50,
        card_feather_end: opts.card_feather_end ?? 100,
        // 边框
        card_border_enabled: opts.card_border_enabled ?? false,
        card_border_sides: opts.card_border_sides || 'all',
        card_border_color: opts.card_border_color || '#FFD700',
        card_border_width: opts.card_border_width ?? 3,
        card_border_style: opts.card_border_style || 'solid',
        card_border_opacity: opts.card_border_opacity ?? 100,
        // 入/出场动画
        anim_in_type: opts.anim_in_type || 'none',
        anim_out_type: opts.anim_out_type || 'none',
        anim_in_duration: opts.anim_in_duration || 0.3,
        anim_out_duration: opts.anim_out_duration || 0.3,
    };
}

/**
 * 创建滚动字幕覆层对象。
 * x/y/w/h 用作裁切区域（可见窗口），文本在其中滚动。
 */
function createScrollOverlay(opts = {}) {
    return {
        id: _overlayId(),
        type: 'scroll',
        synthetic_bold_enabled: opts.synthetic_bold_enabled === true,
        content: opts.content || '滚动文字内容\n第二行文字\n第三行文字\n第四行文字\n第五行文字',
        scroll_title_styled_ranges: opts.scroll_title_styled_ranges || null,
        scroll_styled_ranges: opts.scroll_styled_ranges || null,
        // x/y/w/h = 裁切区域
        x: opts.x ?? 40,
        y: opts.y ?? 400,
        w: opts.w ?? 1000,
        h: opts.h ?? 1120,
        rotation: opts.rotation ?? 0,
        opacity: opts.opacity ?? 255,
        start: opts.start ?? 0,
        end: opts.end ?? 10,
        // ── 标题 ──
        scroll_title: opts.scroll_title ?? '',
        scroll_title_fontsize: opts.scroll_title_fontsize ?? 56,
        scroll_title_font_family: opts.scroll_title_font_family || '',  // 空 = 跟随正文字体
        scroll_title_font_weight: opts.scroll_title_font_weight ?? 700,
        scroll_title_bold: opts.scroll_title_bold !== false,
        scroll_title_color: opts.scroll_title_color || '',  // 空 = 跟随正文颜色
        scroll_title_align: opts.scroll_title_align || '',  // 空 = 跟随正文对齐
        scroll_title_gap: opts.scroll_title_gap ?? 20,      // 标题与正文间距
        scroll_title_fixed: opts.scroll_title_fixed !== false, // 默认固定不滚动
        scroll_title_independent: opts.scroll_title_independent === true,
        scroll_title_x: opts.scroll_title_x ?? null,        // 独立标题中心 X；null = 跟随正文中心
        scroll_title_y: opts.scroll_title_y ?? null,        // 独立标题顶部 Y；null = 裁切区顶部
        scroll_title_auto_fit: opts.scroll_title_auto_fit === true,
        scroll_title_max_height: opts.scroll_title_max_height ?? 0,
        // 标题描边/阴影
        scroll_title_stroke_color: opts.scroll_title_stroke_color || '#000000',
        scroll_title_stroke_width: opts.scroll_title_stroke_width || 0,
        scroll_title_shadow_enabled: opts.scroll_title_shadow_enabled || false,
        scroll_title_shadow_color: opts.scroll_title_shadow_color || '#000000',
        scroll_title_shadow_blur: opts.scroll_title_shadow_blur || 4,
        scroll_title_shadow_x: opts.scroll_title_shadow_x || 2,
        scroll_title_shadow_y: opts.scroll_title_shadow_y || 2,
        // 标题独立背景
        scroll_title_bg_enabled: opts.scroll_title_bg_enabled || false,
        scroll_title_bg_mode: opts.scroll_title_bg_mode || 'block',
        scroll_title_bg_color: opts.scroll_title_bg_color || '#000000',
        scroll_title_bg_opacity: opts.scroll_title_bg_opacity ?? 60,
        scroll_title_bg_radius: opts.scroll_title_bg_radius ?? 12,
        scroll_title_bg_concave_radius: opts.scroll_title_bg_concave_radius ?? 10,
        scroll_title_bg_snap_threshold: opts.scroll_title_bg_snap_threshold ?? 18,
        scroll_title_bg_pad_h: opts.scroll_title_bg_pad_h ?? 0,
        scroll_title_bg_pad_top: opts.scroll_title_bg_pad_top ?? 0,
        scroll_title_bg_pad_bottom: opts.scroll_title_bg_pad_bottom ?? 0,
        // ── 标题装饰线 ──
        scroll_title_deco_enabled: opts.scroll_title_deco_enabled ?? false,
        scroll_title_deco_parameters: opts.scroll_title_deco_parameters ? JSON.parse(JSON.stringify(opts.scroll_title_deco_parameters)) : undefined,
        scroll_title_deco_position: opts.scroll_title_deco_position || 'bottom',
        scroll_title_deco_style: opts.scroll_title_deco_style || 'solid',
        scroll_title_deco_color: opts.scroll_title_deco_color || '#FFD700',
        scroll_title_deco_color2: opts.scroll_title_deco_color2 || '#FF6B35',
        scroll_title_deco_gradient_direction: opts.scroll_title_deco_gradient_direction || 'horizontal',
        scroll_title_deco_thickness: opts.scroll_title_deco_thickness ?? 3,
        scroll_title_deco_length: opts.scroll_title_deco_length ?? 0,
        scroll_title_deco_gap: opts.scroll_title_deco_gap ?? 12,
        scroll_title_deco_opacity: opts.scroll_title_deco_opacity ?? 100,
        scroll_title_deco_align: opts.scroll_title_deco_align || 'center',
        // 正文独立背景
        scroll_body_bg_enabled: opts.scroll_body_bg_enabled || false,
        scroll_body_bg_mode: opts.scroll_body_bg_mode || 'block',
        scroll_body_bg_color: opts.scroll_body_bg_color || '#000000',
        scroll_body_bg_opacity: opts.scroll_body_bg_opacity ?? 60,
        scroll_body_bg_radius: opts.scroll_body_bg_radius ?? 12,
        scroll_body_bg_concave_radius: opts.scroll_body_bg_concave_radius ?? 10,
        scroll_body_bg_snap_threshold: opts.scroll_body_bg_snap_threshold ?? 18,
        scroll_body_bg_pad_h: opts.scroll_body_bg_pad_h ?? 0,
        scroll_body_bg_pad_top: opts.scroll_body_bg_pad_top ?? 0,
        scroll_body_bg_pad_bottom: opts.scroll_body_bg_pad_bottom ?? 0,
        // ── 正文字体 ──
        font_family: opts.font_family || 'Arial',
        font_weight: opts.font_weight ?? (opts.bold ? 700 : 400),
        fontsize: opts.fontsize || 40,
        bold: opts.bold || false,
        italic: opts.italic || false,
        color: opts.color || '#FFFFFF',
        text_align: opts.text_align || 'center',
        // Applies to both the scrolling body and title; auto resolves each independently.
        text_direction: opts.text_direction || 'auto',
        line_spacing: opts.line_spacing ?? 6,
        text_width: opts.text_width ?? 900,
        // 描边
        use_stroke: opts.use_stroke || false,
        stroke_color: opts.stroke_color || '#000000',
        stroke_width: opts.stroke_width || 2,
        // 阴影
        shadow_enabled: opts.shadow_enabled || false,
        shadow_color: opts.shadow_color || '#000000',
        shadow_opacity: opts.shadow_opacity || 120,
        shadow_blur: opts.shadow_blur || 4,
        shadow_offset_x: opts.shadow_offset_x || 2,
        shadow_offset_y: opts.shadow_offset_y || 2,
        // 滚动参数
        scroll_x_anchor: opts.scroll_x_anchor || 'center',
        scroll_from_x: opts.scroll_from_x ?? 540,
        scroll_from_y: opts.scroll_from_y ?? 960,   // 裁切区域内部开始，直接可见
        scroll_to_x: opts.scroll_to_x ?? 540,
        scroll_to_y: opts.scroll_to_y ?? -200,      // 向上滚出
        scroll_speed: opts.scroll_speed ?? 0.8,
        scroll_auto_stop: opts.scroll_auto_stop === true, // 默认关闭
        scroll_auto_stop_lead: opts.scroll_auto_stop_lead ?? 0, // 提前完成秒数，默认0
        scroll_static: opts.scroll_static === true,       // 固定显示模式（关闭滚动）
        scroll_auto_fit: opts.scroll_auto_fit === true,   // 默认关闭
        scroll_min_fontsize: opts.scroll_min_fontsize ?? 16,
        // 卡片背景
        bg_enabled: opts.bg_enabled || false,
        bg_color: opts.bg_color || '#000000',
        bg_opacity: opts.bg_opacity || 191,
        bg_radius: opts.bg_radius || 12,
        bg_padding_top: opts.bg_padding_top ?? 55,
        bg_padding_bottom: opts.bg_padding_bottom ?? 55,
        bg_padding_left: opts.bg_padding_left ?? 16,
        bg_padding_right: opts.bg_padding_right ?? 16,
        bg_fullscreen: opts.bg_fullscreen ?? false,
        // 卡片边框
        bg_border_enabled: opts.bg_border_enabled ?? false,
        bg_border_color: opts.bg_border_color || '#FFD700',
        bg_border_width: opts.bg_border_width ?? 3,
        bg_border_style: opts.bg_border_style || 'solid',   // solid | dashed | dotted
        bg_border_opacity: opts.bg_border_opacity ?? 100,    // 0-100 (百分比)
        // 磨砂模糊
        bg_blur_enabled: opts.bg_blur_enabled ?? false,
        bg_blur_amount: opts.bg_blur_amount ?? 10,             // 模糊强度 px (1-30)
        // 羽化
        feather_top: opts.feather_top ?? 80,
        feather_bottom: opts.feather_bottom ?? 80,
        // 整体偏移（裁切区+滚动坐标一起移动）
        scroll_offset_x: opts.scroll_offset_x ?? 0,
        scroll_offset_y: opts.scroll_offset_y ?? 0,
        // 动画
        scroll_typewriter_enabled: opts.scroll_typewriter_enabled === true,
        scroll_tw_start: opts.scroll_tw_start ?? null,
        scroll_tw_end: opts.scroll_tw_end ?? null,
        scroll_tw_speech_sync: opts.scroll_tw_speech_sync !== false,
        scroll_tw_reveal_type: opts.scroll_tw_reveal_type || 'char', // 'char' | 'word' | 'sentence'
        scroll_tw_hide_unread: opts.scroll_tw_hide_unread !== undefined
            ? Boolean(opts.scroll_tw_hide_unread)
            : (Number(opts.scroll_tw_unrevealed_opacity ?? 0) < 100),
        scroll_tw_unrevealed_opacity: opts.scroll_tw_unrevealed_opacity !== undefined
            ? Number(opts.scroll_tw_unrevealed_opacity)
            : (opts.scroll_tw_hide_unread === false ? 100 : 0), // 0~100 (%)
        scroll_tw_active_highlight: opts.scroll_tw_active_highlight !== false,
        scroll_tw_active_color: opts.scroll_tw_active_color || '#FFD700',
        scroll_tw_active_scale_enabled: opts.scroll_tw_active_scale_enabled !== undefined
            ? Boolean(opts.scroll_tw_active_scale_enabled)
            : (Number(opts.scroll_tw_active_scale ?? 100) !== 100),
        scroll_tw_active_scale: opts.scroll_tw_active_scale ?? 100, // 100~200 (%)
        scroll_tw_cursor_enabled: opts.scroll_tw_cursor_enabled !== false,
        scroll_tw_cursor_kind: opts.scroll_tw_cursor_kind || 'quill', // 'quill' | 'rose' | 'image' | 'char'
        scroll_tw_cursor_image: opts.scroll_tw_cursor_image || '',
        scroll_tw_cursor_anchor_x: opts.scroll_tw_cursor_anchor_x ?? 15,
        scroll_tw_cursor_anchor_y: opts.scroll_tw_cursor_anchor_y ?? 85,
        scroll_tw_cursor_scale: opts.scroll_tw_cursor_scale ?? 1.1,
        scroll_tw_cursor_offset_x: opts.scroll_tw_cursor_offset_x ?? 0,
        scroll_tw_cursor_offset_y: opts.scroll_tw_cursor_offset_y ?? 0,
        scroll_tw_cursor_angle: opts.scroll_tw_cursor_angle ?? -8,
        scroll_tw_cursor_char: opts.scroll_tw_cursor_char || '|',
        scroll_tw_cursor_color: opts.scroll_tw_cursor_color || '#FFD700',
        // 动画
        transition_preset: opts.transition_preset || 'none',
        transition_duration: opts.transition_duration || 0.35,
    };
}

// ═══════════════════════════════════════════════════════
// 2. Overlay Renderer
// ═══════════════════════════════════════════════════════

// 必须使用模块专属名称。batch-reels.js 也有一个方向相反的同名工具（把
// local-media URL 还原为文件路径）；经典 script 标签会把顶层函数放入同一
// 全局作用域，后加载者曾覆盖这里，导致绝对路径被浏览器解析成 localhost URL。
function _normalizeOverlayMediaPath(p) {
    if (!p || typeof p !== 'string') return '';
    if (/^(local-media|https?|blob|data):/i.test(p)) return p;
    
    let clean = p;
    if (clean.startsWith('file://')) {
        clean = clean.substring(7);
    }
    // Normalize backslashes to forward slashes for Windows compatibility
    clean = clean.replace(/\\/g, '/');

    const isWin = (typeof process !== 'undefined' && process.platform === 'win32') || navigator.userAgent.toLowerCase().includes('windows');
    if (isWin || (clean.includes(':') && !clean.startsWith('/'))) {
        if (!clean.startsWith('/') && /^[a-zA-Z]:/.test(clean)) {
            clean = '/' + clean;
        }
    } else {
        if (!clean.startsWith('/')) {
            clean = '/' + clean;
        }
    }
    
    if (window.electronAPI && typeof window.electronAPI.toFileUrl === 'function') {
        return window.electronAPI.toFileUrl(clean);
    }
    // For shadow-renderer (loaded via file: protocol in BrowserWindow with webSecurity: false)
    if (window.location.protocol === 'file:') {
        try {
            if (typeof require === 'function') {
                const { pathToFileURL, fileURLToPath } = require('url');
                const nativePath = /^file:\/\//i.test(p) ? fileURLToPath(p) : p;
                return pathToFileURL(nativePath).href;
            }
        } catch (_) { }
        const encodedPath = clean.split('/').map(part => /^[a-zA-Z]:$/.test(part) ? part : encodeURIComponent(part)).join('/');
        return 'file://' + encodedPath;
    }
    return `local-media://${clean}`;
}

const _imageCache = {};
let _previewMediaGeneration = 0;
const _IMAGE_LOADING = { _loading: true }; // sentinel (truthy, prevents re-creation)
const _IMAGE_FAILED = { _failed: true };

/**
 * 加载并缓存图片。
 */
function _getCachedImage(path) {
    if (!path) return null;
    const cached = _imageCache[path];
    if (cached === _IMAGE_LOADING || cached === _IMAGE_FAILED) return null;
    if (cached) return cached;                     // loaded Image

    const img = new Image();
    const generation = _previewMediaGeneration;
    // local-media is cross-origin too; keep canvas previews exportable.
    img.crossOrigin = 'anonymous';
    const isGif = path.toLowerCase().endsWith('.gif');
    img.onload = () => {
        if (generation !== _previewMediaGeneration) { img.onload = null; img.onerror = null; img.src = ''; return; }
        _imageCache[path] = img;
        // GIF 需要挂到可见 DOM 中才能让 Chromium 推进动画帧
        if (isGif) _attachGifToDom(img);
        if (typeof window !== 'undefined' && typeof window.ReelsPreviewV2?.render === 'function') {
            window.ReelsPreviewV2.render();
        }
        if (typeof window !== 'undefined' && typeof window.reelsUpdatePreview === 'function') {
            window.reelsUpdatePreview();
        }
    };
    img.onerror = () => { if (generation === _previewMediaGeneration) _imageCache[path] = _IMAGE_FAILED; };
    _imageCache[path] = _IMAGE_LOADING;
    img.src = _normalizeOverlayMediaPath(path);
    return null;
}

// 隐藏容器：让 GIF <img> 挂在 DOM 中以驱动动画帧
// 必须在视口内（不能 left:-9999px），否则 Chromium 可能不推进动画
let _gifDomContainer = null;
function _attachGifToDom(img) {
    if (!_gifDomContainer) {
        _gifDomContainer = document.createElement('div');
        _gifDomContainer.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;overflow:hidden;pointer-events:none;opacity:0.001;z-index:-9999;';
        document.body.appendChild(_gifDomContainer);
    }
    // 强制 img 尺寸极小，避免影响性能
    img.style.cssText = 'width:1px;height:1px;';
    if (!img.parentNode) _gifDomContainer.appendChild(img);
}

const _videoCache = {};
const _previewDecodedFrames = new WeakMap();
function _getStablePreviewVideoFrame(video, capture) {
    if(!video)return null;
    let saved=_previewDecodedFrames.get(video);
    if(capture && !video.seeking && video.readyState>=2 && video.videoWidth && video.videoHeight) {
        if(!saved || saved.time!==video.currentTime || saved.canvas.width!==video.videoWidth || saved.canvas.height!==video.videoHeight){
            try {
                const canvas=saved?.canvas || document.createElement('canvas');
                if(canvas.width!==video.videoWidth)canvas.width=video.videoWidth;
                if(canvas.height!==video.videoHeight)canvas.height=video.videoHeight;
                canvas.getContext('2d').drawImage(video,0,0);
                saved={canvas,time:video.currentTime};_previewDecodedFrames.set(video,saved);
            } catch (_) {}
        }
    }
    return saved?.canvas || null;
}
let _overlayVideoDomContainer = null;

// Chromium/Electron 可能暂停完全脱离 DOM 的 <video> 解码器。插入轨的视频
// 原先只存在于 JS 缓存中，因此路径和时间都正确，Canvas 仍拿不到可绘制帧。
// 容器保持在视口内并使用极低透明度，与独立预览自身的媒体元素采用同一策略。
function _attachOverlayVideoToDom(video) {
    if (!video || typeof document === 'undefined') return;
    if (!_overlayVideoDomContainer) {
        _overlayVideoDomContainer = document.createElement('div');
        _overlayVideoDomContainer.id = 'reels-overlay-video-decoder-host';
        _overlayVideoDomContainer.setAttribute('aria-hidden', 'true');
        _overlayVideoDomContainer.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;overflow:hidden;pointer-events:none;opacity:0.001;z-index:-1;';
        document.body.appendChild(_overlayVideoDomContainer);
    }
    video.style.cssText = 'display:block;width:2px;height:2px;object-fit:cover;';
    if (video.parentNode !== _overlayVideoDomContainer) {
        _overlayVideoDomContainer.appendChild(video);
    }
}

function _getCachedVideo(path) {
    if (!path) return null;
    if (_videoCache[path]) return _videoCache[path];
    const vid = document.createElement('video');
    vid.crossOrigin = 'anonymous';
    vid.src = _normalizeOverlayMediaPath(path);
    vid.muted = true;
    vid.loop = true;
    vid.playsInline = true;
    // 暂停预览也需要解码首帧；metadata 在部分编码上只提供尺寸和时长。
    vid.preload = 'auto';
    vid.autoplay = false;
    _attachOverlayVideoToDom(vid);
    const notifyPreview = () => {
        if(window.ReelsPreviewV2?.isSuspended?.()){vid.pause();return;}
        if (typeof window !== 'undefined' && typeof window.ReelsPreviewV2?.render === 'function') {
            window.ReelsPreviewV2.render();
        }
        if (typeof window !== 'undefined'
            && !window.ReelsPreviewV2?.isOpen?.()
            && typeof window.reelsUpdatePreview === 'function') {
            window.reelsUpdatePreview();
        }
    };
    vid.addEventListener('loadeddata', notifyPreview, { once: true });
    vid.addEventListener('canplay', notifyPreview);
    vid.addEventListener('seeked', notifyPreview);
    vid.load();
    // loadeddata 会通知预览；播放由主时间轴决定，创建媒体时不抢先播放。
    _videoCache[path] = vid;
    return vid;
}

// 文件夹素材切换后，不能等下一次播放帧才创建解码器：暂停预览时没有新的帧，
// 画面就会一直是空的。只预热首项即可，后续项仍按播放时间按需加载。
function primeFolderMedia(ov) {
    const files = Array.isArray(ov?.media_folder_files) ? ov.media_folder_files.filter(Boolean) : [];
    const path = files[0] || ov?.content;
    if (!path) return;
    if (_isVideoOverlayPath(path)) _getCachedVideo(path);
    else _getCachedImage(path);
}

// ═══ GIF 逐帧解码器 (WebCodecs ImageDecoder API) ═══
const _gifDecoderCache = {};

// GIF 的帧时长可从块头读取，不必解码全部像素才能得到准确循环时间。
function _readGifFrameDurations(buffer) {
    const bytes = new Uint8Array(buffer), durations = [];
    if (bytes.length < 13 || String.fromCharCode(...bytes.slice(0, 3)) !== 'GIF') return durations;
    let offset = 13 + (bytes[10] & 128 ? 3 * (1 << ((bytes[10] & 7) + 1)) : 0);
    let delay = 100;
    const skipBlocks = () => {
        while (offset < bytes.length) {
            const size = bytes[offset++];
            if (!size) return;
            offset += size;
        }
    };
    while (offset < bytes.length) {
        const kind = bytes[offset++];
        if (kind === 0x3b) break;
        if (kind === 0x21) {
            const label = bytes[offset++];
            if (label === 0xf9 && bytes[offset] === 4 && offset + 4 < bytes.length) {
                delay = Math.max(10, (bytes[offset + 2] | bytes[offset + 3] << 8) * 10 || 100);
            }
            skipBlocks();
        } else if (kind === 0x2c) {
            if (offset + 9 > bytes.length) break;
            const packed = bytes[offset + 8];
            offset += 9 + (packed & 128 ? 3 * (1 << ((packed & 7) + 1)) : 0);
            offset++; // LZW minimum code size
            skipBlocks();
            durations.push(delay);
            delay = 100;
        } else break;
    }
    return durations;
}

async function _createPreviewGifBitmap(image) {
    const limit = window.__reelsOverviewCard ? 360 : 1080;
    const width = image.displayWidth || image.codedWidth;
    const height = image.displayHeight || image.codedHeight;
    const scale = Math.min(1, limit / Math.max(width || 1, height || 1));
    return scale < 1 ? createImageBitmap(image, {resizeWidth:Math.max(1,Math.round(width*scale)), resizeHeight:Math.max(1,Math.round(height*scale))}) : createImageBitmap(image);
}

function _trimGifFrames(data, keepFrame) {
    const keys = Object.keys(data.frames);
    for (const key of keys) {
        if (Object.keys(data.frames).length <= 8) break;
        if (Number(key) === 0 || Number(key) === keepFrame) continue;
        data.frames[key]?.close?.();
        delete data.frames[key];
    }
}


function _getGifDecoder(path) {
    if (!path) return null;
    if (_gifDecoderCache[path]) {
        const cached = _gifDecoderCache[path];
        delete _gifDecoderCache[path]; _gifDecoderCache[path] = cached;
        return cached;
    }
    while (Object.keys(_gifDecoderCache).length >= 4) {
        const oldest = Object.keys(_gifDecoderCache)[0], data = _gifDecoderCache[oldest];
        data.disposed = true;
        Object.values(data.frames).forEach(frame => frame?.close?.());
        data.decoder?.close?.();
        delete _gifDecoderCache[oldest];
    }

    // 创建解码器对象
    const gifData = {
        ready: false,
        failed: false,
        frameCount: 0,
        frameDurations: [],    // 每帧持续时间(ms)
        totalDuration: 0,      // 总时长(秒)
        frames: {},            // frameIndex → ImageBitmap
        decoder: null,
        _decoding: new Set(),  // 正在解码的帧索引
    };
    _gifDecoderCache[path] = gifData;

    // 异步初始化解码器
    (async () => {
        try {
            const url = _normalizeOverlayMediaPath(path);
            const response = await fetch(url);
            const arrayBuffer = await response.arrayBuffer();
            if (gifData.disposed) return;

            // 使用 ImageDecoder（Chromium 94+, Electron 支持）
            if (typeof ImageDecoder !== 'undefined') {
                const decoder = new ImageDecoder({ data: arrayBuffer, type: 'image/gif' });
                gifData.decoder = decoder;
                await decoder.tracks.ready;
                if (gifData.disposed) return;
                const track = decoder.tracks.selectedTrack;
                gifData.frameCount = track.frameCount;

                gifData.frameDurations = _readGifFrameDurations(arrayBuffer);
                // 首屏只准备两帧，其余按播放位置解码。
                const preloadCount = Math.min(2, gifData.frameCount);
                for (let i = 0; i < preloadCount; i++) {
                    try {
                        const result = await decoder.decode({ frameIndex: i });
                        if (gifData.disposed) { result.image.close(); return; }
                        // duration 单位: 微秒 → 毫秒，最小 10ms 防止除零
                        const durMs = Math.max(10, result.image.duration ? result.image.duration / 1000 : 100);
                        gifData.frameDurations[i] = durMs;
                        // 转为 ImageBitmap 用于 Canvas 绘制
                        const bitmap = await _createPreviewGifBitmap(result.image);
                        if (gifData.disposed) { bitmap.close(); result.image.close(); return; }
                        gifData.frames[i] = bitmap;
                        result.image.close();
                    } catch (e) {
                        gifData.frameDurations[i] = 100; // 默认 100ms
                    }
                }

                // 补齐未预解码的帧时长（用平均值）
                const avgDur = gifData.frameDurations.length > 0
                    ? gifData.frameDurations.reduce((a, b) => a + b, 0) / gifData.frameDurations.length
                    : 100;
                for (let i = preloadCount; i < gifData.frameCount; i++) {
                    if (!gifData.frameDurations[i]) gifData.frameDurations[i] = avgDur;
                }
                gifData.totalDuration = gifData.frameDurations.reduce((a, b) => a + b, 0) / 1000;
                gifData.nativeFps = gifData.frameCount / Math.max(0.01, gifData.totalDuration);
                gifData.ready = true;
                console.log(`[GIF] 解码完成: ${gifData.frameCount} 帧, 总时长 ${gifData.totalDuration.toFixed(2)}s, 原始帧率 ${gifData.nativeFps.toFixed(1)}fps`);
            } else {
                // ImageDecoder 不可用，回退到静态图
                console.warn('[GIF] ImageDecoder API 不可用, GIF 将显示为静态图');
                const img = new Image();
                img.crossOrigin = 'anonymous';
                img.src = _normalizeOverlayMediaPath(path);
                img.onload = () => {
                    gifData.frames[0] = img;
                    gifData.frameCount = 1;
                    gifData.frameDurations = [100];
                    gifData.totalDuration = 0.1;
                    gifData.ready = true;
                };
            }
        } catch (err) {
            // 素材被移动/删除时，缩略图预览应静默跳过，不能让图库持续报错。
            gifData.failed = true;
            console.warn('[GIF] 预览素材不可用，已跳过:', path);
        }
    })();

    return gifData;
}

// 异步按需解码指定帧（不阻塞渲染循环）
function _ensureGifFrameDecoded(gifData, frameIdx) {
    if (!gifData || !gifData.decoder || gifData.disposed) return;
    // 预解码当前帧和下一帧
    const toLoad = [frameIdx, (frameIdx + 1) % gifData.frameCount];
    for (const fi of toLoad) {
        if (gifData.frames[fi] || gifData._decoding.has(fi)) continue;
        if (gifData._decoding.size >= 2) break;
        gifData._decoding.add(fi);
        (async () => {
            try {
                const result = await gifData.decoder.decode({ frameIndex: fi });
                const bitmap = await _createPreviewGifBitmap(result.image);
                result.image.close();
                if (gifData.disposed) { bitmap.close(); return; }
                gifData.frames[fi] = bitmap;
                _trimGifFrames(gifData, frameIdx);
            } catch (e) { /* ignore */ }
            gifData._decoding.delete(fi);
        })();
    }
}
// ═══════════════════════════════════════════════════════
// Auto-Colorize Engine — 自动着色引擎
// ═══════════════════════════════════════════════════════

/**
 * 根据关键词规则列表，自动生成 styled_ranges。
 * @param {string} text - 原始文本
 * @param {Array} rules - 规则数组 [{ keywords: [...], color, bold, fontsize, ... }]
 * @returns {Array} styled_ranges
 */
function _autoColorize(text, rules) {
    if (!text || !rules || rules.length === 0) return [];
    const ranges = [];
    // 正则类型规则 — keywords 内容是正则表达式模式，不应转义
    const REGEX_TYPES = new Set(['number', 'english', 'punctuation', 'regex']);
    for (const rule of rules) {
        if (!rule.keywords || rule.keywords.length === 0) continue;
        const sorted = [...rule.keywords].filter(k => k).sort((a, b) => b.length - a.length);
        if (sorted.length === 0) continue;

        let pattern;
        if (rule.type === 'english') {
            // Legacy rule name; match words in every Latin/Unicode language.
            pattern = new RegExp("[\\p{L}\\p{M}]+(?:[’'\\-][\\p{L}\\p{M}]+)*", 'gu');
        } else if (REGEX_TYPES.has(rule.type)) {
            // 正则类型：直接拼接为正则，不转义
            try {
                pattern = new RegExp(sorted.join('|'), 'gu');
            } catch (e) {
                console.warn('[AutoColor] 无效正则:', sorted, e);
                continue;
            }
        } else {
            // 关键词类型：转义特殊字符，按长度降序排列（优先匹配长词）
            const escaped = sorted.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
            pattern = new RegExp(escaped.join('|'), rule.case_sensitive === true ? 'gu' : 'giu');
        }

        let match;
        while ((match = pattern.exec(text)) !== null) {
            if (match[0].length === 0) { pattern.lastIndex++; continue; } // 防止空匹配死循环
            const r = { start: match.index, end: match.index + match[0].length };
            if (rule.color) r.color = rule.color;
            if (rule.bold === true) r.bold = true;
            if (rule.fontsize && rule.fontsize > 0) r.fontsize = rule.fontsize;
            if (rule.italic === true) r.italic = true;
            ranges.push(r);
        }
    }
    return ranges;
}

/**
 * 合并自动着色范围和手动 styled_ranges。
 * 手动优先 — 手动范围覆盖的字符位置，自动着色不生效。
 * @param {Array} autoRanges - 自动生成的范围
 * @param {Array} manualRanges - 用户手动编辑的富文本范围
 * @returns {Array} 合并后的 styled_ranges
 */
function _mergeAutoAndManual(autoRanges, manualRanges) {
    if (!autoRanges || autoRanges.length === 0) return manualRanges || [];
    if (!manualRanges || manualRanges.length === 0) return autoRanges;
    
    // 采用合并叠加策略：autoRanges 为底，manualRanges 覆盖在上面
    // ReelsRichText.normalizeRanges 可以合并冲突属性（后者的属性优先级高）
    if (typeof ReelsRichText !== 'undefined' && typeof ReelsRichText.normalizeRanges === 'function') {
        return ReelsRichText.normalizeRanges([...autoRanges, ...manualRanges]);
    }
    return [...autoRanges, ...manualRanges];
}

// 缓存：避免每帧重复计算（text 不变时复用）
const _autoColorCache = new Map();
const _AUTO_COLOR_CACHE_MAX = 50;

function _getCachedAutoColor(text, rules) {
    if (!text || !rules || rules.length === 0) return [];
    // 用 text + rules JSON 生成缓存 key
    const key = text + '||' + JSON.stringify(rules);
    if (_autoColorCache.has(key)) return _autoColorCache.get(key);
    const result = _autoColorize(text, rules);
    if (_autoColorCache.size > _AUTO_COLOR_CACHE_MAX) _autoColorCache.clear();
    _autoColorCache.set(key, result);
    return result;
}

/**
 * 获取某个覆层某个区段的最终合并 styled_ranges
 * @param {object} ov - overlay 对象
 * @param {string} section - 'title' | 'body' | 'footer' | 'scroll_title' | 'scroll_body'
 * @param {string} text - 该区段的文本
 * @returns {Array|null} 合并后的 styled_ranges，null 表示无需富文本渲染
 */
function _getAutoColorMergedRanges(ov, section, text) {
    const rules = ov.auto_color_rules;
    if (!rules || rules.length === 0) return null;
    
    // 检查该 section 是否在 targets 中（默认全部启用）
    const targets = ov.auto_color_targets;
    if (targets && targets.length > 0 && !targets.includes(section)) return null;
    
    const autoRanges = _getCachedAutoColor(text, rules);
    if (autoRanges.length === 0) return null;
    
    // 获取手动编辑的 styled_ranges
    let manualKey;
    if (section === 'scroll_title') manualKey = 'scroll_title_styled_ranges';
    else if (section === 'scroll_body') manualKey = 'scroll_styled_ranges';
    else manualKey = `${section}_styled_ranges`;
    
    const manual = ov[manualKey] || [];
    return _mergeAutoAndManual(autoRanges, manual);
}

function splitBodyText(text) {
    if (!text) return ['', ''];
    // FCPX replaces \n with '   ', handle both
    const str = text.replace(/   /g, '\n');
    let idx = str.indexOf('\n\n');
    if (idx > -1) {
        return [str.substring(0, idx).trim(), str.substring(idx).trim()];
    }
    const lines = str.split('\n');
    if (lines.length > 1) {
        const half = Math.ceil(lines.length / 2);
        return [lines.slice(0, half).join('\n').trim(), lines.slice(half).join('\n').trim()];
    }
    const puncIdx = Math.max(str.indexOf('。'), str.indexOf('！'), str.indexOf('？'), str.indexOf('.'), str.indexOf('!'), str.indexOf('?'));
    if (puncIdx > 0 && puncIdx < str.length - 1) {
        return [str.substring(0, puncIdx + 1).trim(), str.substring(puncIdx + 1).trim()];
    }
    const halfLen = Math.ceil(str.length / 2);
    return [str.substring(0, halfLen).trim(), str.substring(halfLen).trim()];
}

/**
 * 渲染单个覆层到 Canvas。
 * 移植自 FrameRenderer.draw_single_overlay
 * 
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} ov - overlay 对象
 * @param {number} currentTime - 当前播放时间
 * @param {number} canvasW - 画布宽度
 * @param {number} canvasH - 画布高度
 */
// 统一绘制标题装饰线；普通卡片标题与滚动标题共用，保证预览、导出效果一致。
function _drawTitleDecoration(ctx, { startX, startY, endX, endY, isVertical, position, style, thickness, parameters }) {
    const isVectorId = style.startsWith('divider_') || style.startsWith('custom_') || style.startsWith('vector_');
    const vectorPreset = (parameters?.preset?.id === style ? parameters.preset : null) || (isVectorId && window.DividerPresets ? window.DividerPresets.get(style) : null);
    if (vectorPreset && window.DividerPresets) {
        ctx.save();
        ctx.translate((startX + endX) / 2, (startY + endY) / 2);
        ctx.rotate(Math.atan2(endY - startY, endX - startX));
        window.DividerPresets.draw(ctx, vectorPreset, { ...parameters, width: Math.hypot(endX-startX,endY-startY), strokeWidth: thickness, color: ctx.strokeStyle, opacity: 1 });
        ctx.restore();
        return;
    }
    const dx = endX - startX;
    const dy = endY - startY;
    const length = Math.hypot(dx, dy) || 1;
    const ux = dx / length, uy = dy / length;
    const px = -uy, py = ux;
    const line = () => { ctx.beginPath(); ctx.moveTo(startX, startY); ctx.lineTo(endX, endY); ctx.stroke(); };
    const point = (t, offset = 0) => [startX + dx * t + px * offset, startY + dy * t + py * offset];

    // 图库中的“中间装饰线”。使用同一套局部坐标，所以横线和竖线都能正常旋转。
    // classic01–30 对应简约几何组，floral01–30 对应花饰/卷草组。
    const libraryMatch = /^(classic|floral)(\d{2})$/.exec(style);
    if (libraryMatch) {
        const family = libraryMatch[1];
        const n = Number(libraryMatch[2]);
        // 参考线稿的中心纹样约占整条线高度的 2–3 倍；此前 r 太小，缩略图和成片都像一条普通横线。
        // 这里统一放大中心符号与卷草，保留线段留白，才会有参考图那种“标题分隔饰”的层次。
        const r = Math.max(7, thickness * 3.05);
        const p = (along, across = 0) => point(0.5 + along / length, across);
        const segment = (gap = r * 1.8) => {
            const a = point(0.5 - gap / length), b = point(0.5 + gap / length);
            ctx.beginPath(); ctx.moveTo(startX, startY); ctx.lineTo(...a);
            ctx.moveTo(...b); ctx.lineTo(endX, endY); ctx.stroke();
        };
        const dot = (along = 0, across = 0, size = r * .32, fill = true) => {
            const [x, y] = p(along, across); ctx.beginPath(); ctx.arc(x, y, size, 0, Math.PI * 2); fill ? ctx.fill() : ctx.stroke();
        };
        const diamond = (along = 0, across = 0, size = r, fill = true) => {
            const [x, y] = p(along, across); ctx.beginPath();
            ctx.moveTo(x, y - size); ctx.lineTo(x + size, y); ctx.lineTo(x, y + size); ctx.lineTo(x - size, y); ctx.closePath();
            fill ? ctx.fill() : ctx.stroke();
        };
        const plus = (size = r) => { const [x, y] = p(0); ctx.beginPath(); ctx.moveTo(x - size, y); ctx.lineTo(x + size, y); ctx.moveTo(x, y - size); ctx.lineTo(x, y + size); ctx.stroke(); };
        const chevron = (doubleLine = false, up = false) => {
            const draw = (off) => { const [x, y] = p(0, off); const h = up ? -r : r; ctx.moveTo(x - r, y - h); ctx.lineTo(x, y); ctx.lineTo(x + r, y - h); };
            ctx.beginPath(); draw(0); if (doubleLine) draw(up ? r * .85 : -r * .85); ctx.stroke();
        };
        const star = (size = r) => { const [x, y] = p(0); ctx.beginPath(); for (let i = 0; i < 8; i++) { const a = -Math.PI / 2 + i * Math.PI / 4; const rr = i % 2 ? size * .38 : size; const qx = x + Math.cos(a) * rr, qy = y + Math.sin(a) * rr; i ? ctx.lineTo(qx, qy) : ctx.moveTo(qx, qy); } ctx.closePath(); ctx.fill(); };
        const flourish = (leaves = false) => {
            segment(r * 2.8); const [x, y] = p(0);
            ctx.beginPath();
            ctx.moveTo(x - r * 2.6, y); ctx.bezierCurveTo(x - r * 1.8, y - r * 1.7, x - r * .8, y - r * 1.7, x, y);
            ctx.bezierCurveTo(x + r * .8, y - r * 1.7, x + r * 1.8, y - r * 1.7, x + r * 2.6, y); ctx.stroke();
            if (leaves) { diamond(0, -r * 1.45, r * .78); dot(-r * 1.7, 0); dot(r * 1.7, 0); }
        };
        const petal = (count = 3) => {
            segment(r * 2.5); const [x, y] = p(0);
            for (let i = 0; i < count; i++) { const a = -Math.PI / 2 + (i - (count - 1) / 2) * .55; const tipX = x + Math.cos(a) * r * 1.65, tipY = y + Math.sin(a) * r * 1.65; ctx.beginPath(); ctx.moveTo(x, y); ctx.quadraticCurveTo(x + Math.cos(a - .6) * r, y + Math.sin(a - .6) * r, tipX, tipY); ctx.quadraticCurveTo(x + Math.cos(a + .6) * r, y + Math.sin(a + .6) * r, x, y); ctx.fill(); }
            dot(0, r * .75, r * .18);
        };
        const wedgePair = (middle = null) => {
            segment(r * 2.8); const [x, y] = p(0);
            ctx.beginPath();
            ctx.moveTo(x - r * 3.4, y); ctx.lineTo(x - r * .85, y - r * .45); ctx.lineTo(x - r * .85, y + r * .45); ctx.closePath();
            ctx.moveTo(x + r * 3.4, y); ctx.lineTo(x + r * .85, y - r * .45); ctx.lineTo(x + r * .85, y + r * .45); ctx.closePath(); ctx.fill();
            if (middle === 'dot') dot(); else if (middle === 'diamond') diamond(); else if (middle === 'star') star(r * .9);
        };
        const infinity = () => { segment(r * 3.2); const [x, y] = p(0); ctx.beginPath(); ctx.moveTo(x, y); ctx.bezierCurveTo(x-r*1.7,y-r*1.8,x-r*3,y+r*1.8,x,y); ctx.bezierCurveTo(x+r*1.7,y-r*1.8,x+r*3,y+r*1.8,x,y); ctx.stroke(); };
        const heart = () => { segment(r * 3); const [x,y]=p(0); ctx.beginPath(); ctx.moveTo(x,y+r*1.5); ctx.bezierCurveTo(x-r*3,y-r*.2,x-r*1.5,y-r*2,x,y-r*.45); ctx.bezierCurveTo(x+r*1.5,y-r*2,x+r*3,y-r*.2,x,y+r*1.5); ctx.stroke(); };
        const laurel = () => { segment(r * 3.2); const [x,y]=p(0); for (const side of [-1,1]) for (let i=0;i<3;i++) { const xx=x+side*(r*.65+i*r*.75), yy=y-r*.2-i*r*.36; ctx.beginPath();ctx.ellipse(xx,yy,r*.38,r*.82,side*.55,0,Math.PI*2);ctx.fill(); } star(r*.72); };
        if (family === 'classic') {
            switch (n) {
                case 0: segment(r * 2.1); ctx.fillRect(...p(-r * .8, -r * .42), r * 1.6, r * .84); break;
                case 1: segment(r*3.8); { const [x,y]=p(0); ctx.fillRect(x-r*2.65,y-r*.38,r*5.3,r*.76); } break;
                case 2: segment(r*1.7); { const [x,y]=p(0);ctx.beginPath();[-1,0,1].forEach(s=>{ctx.moveTo(x+s*r*.68-r*.3,y+r);ctx.lineTo(x+s*r*.68+r*.3,y-r);});ctx.stroke(); } break;
                case 3: segment(r*1.8); diamond(); break;
                case 4: segment(r*4.15); { const [x,y]=p(0);ctx.fillRect(x-r*2.55,y-r*.35,r*5.1,r*.7);ctx.beginPath();[-r*2.05,r*2.05].forEach(o=>{const a=p(o,-r*.82),b=p(o,r*.82);ctx.moveTo(...a);ctx.lineTo(...b);});ctx.stroke(); } break;
                case 5: segment(r*1.5); dot(); break;
                case 6: segment(r*1.85); chevron(false); break;
                case 7: segment(r*1.55); plus(r*1.15); break;
                case 8: segment(r*2.15); dot(-r*1.05);diamond();dot(r*1.05);break;
                case 9: wedgePair();break;
                case 10: segment(r*1.45);dot(0,0,r*.72,false);break;
                case 11: segment(r*2.25);dot(-r*.85);dot(0);dot(r*.85);break;
                case 12: petal(3);break;
                case 13: wedgePair('dot');break;
                case 14: segment(r*2.2); {const [x,y]=p(0);ctx.beginPath();[-r*.55,r*.55].forEach(o=>{ctx.moveTo(x+o,y-r*.6);ctx.lineTo(x+o,y+r*.6);});ctx.stroke();}break;
                case 15: segment(r*1.9);diamond(0,0,r,false);break;
                case 16: segment(r*1.8); {const [x,y]=p(0);ctx.beginPath();[-r*.35,r*.35].forEach(o=>{ctx.moveTo(x+o,y-r*1.15);ctx.lineTo(x+o,y+r*1.15);});ctx.stroke();}break;
                case 17: segment(r*2);chevron(true);break;
                case 18: segment(r*2.25);ctx.setLineDash([r*.8,r*.45]);line();ctx.setLineDash([]);diamond();break;
                case 19: segment(r*3.9); {const[x,y]=p(0);ctx.fillRect(x-r*2.45,y-r*.42,r*4.9,r*.84);}break;
                case 20: segment(r*1.8);{const [x,y]=p(0);ctx.beginPath();ctx.moveTo(x-r*.8,y-r*.55);ctx.lineTo(x+r*.8,y-r*.55);ctx.lineTo(x,y+r*.75);ctx.closePath();ctx.fill();}break;
                case 21: wedgePair('diamond');break;
                case 22: segment(r*2);{const[x,y]=p(0);ctx.beginPath();[-1,0,1].forEach(s=>{ctx.moveTo(x+s*r*.65-r*.25,y+r);ctx.lineTo(x+s*r*.65+r*.25,y-r);});ctx.stroke();}break;
                case 23: segment(r*2.1);ctx.setLineDash([r*1.5,r*.8]);line();ctx.setLineDash([]);dot();break;
                case 24: wedgePair();plus(r*1.25);break;
                case 25: segment(r*4.1);{const[x,y]=p(0);[-r*.78,0,r*.78].forEach(o=>{const a=p(-r*2.5,o),b=p(r*2.5,o);ctx.beginPath();ctx.moveTo(...a);ctx.lineTo(...b);ctx.stroke();});ctx.fillRect(x-r*2.45,y-r*.3,r*4.9,r*.6);}break;
                case 26: segment(r*2.4);dot(-r*1.18);diamond();dot(r*1.18);break;
                case 27: wedgePair('dot');break;
                case 28: segment(r*1.8);dot(0,0,r*.72,false);break;
                case 29: segment(r*2.2);ctx.setLineDash([r*1.3,r*.6]);line();ctx.setLineDash([]);chevron(false);break;
                case 30: petal(3);break;
                default: segment();
            }
        } else {
            switch (n) {
                case 1: petal(3); break; case 2: flourish(true); break; case 3: petal(5); break;
                case 4: flourish(false); diamond(0,-r*.65,r*.55,false); diamond(0,r*.65,r*.55,false); break;
                case 5: flourish(true); petal(3); break; case 6: flourish(true); dot(0,-r*.55,r*.5,false); break;
                case 7: segment(r*2.2); petal(4); break; case 8: infinity(); break; case 9: flourish(true);star(r*.7);break;
                case 10: segment(r*2.5);petal(3);break; case 11: wedgePair('star');break; case 12: flourish(false);diamond(0,-r*.8,r*.5,false);diamond(0,r*.8,r*.5,false);break;
                case 13: laurel();break; case 14: infinity();dot(-r*2);dot(r*2);break; case 15: segment(r*2.5);star(r*.95);dot(-r*1.5);dot(r*1.5);break;
                case 16: heart();break; case 17: flourish(false);star(r*.9);break; case 18: petal(5);dot(-r*2);dot(r*2);break;
                case 19: flourish(true);star(r*.9);break; case 20: segment(r*2.8);diamond(-r*.95,0,r*.65,false);diamond(0,0,r*.95,false);diamond(r*.95,0,r*.65,false);break;
                case 21: petal(3);break; case 22: flourish(false);star(r*.9);break; case 23: laurel();break; case 24: flourish(true);petal(3);break;
                case 25: flourish(false);diamond(0,0,r*.85);break; case 26: flourish(true);star(r*.75);break; case 27: infinity();break;
                case 28: petal(4);dot(-r*1.9);dot(r*1.9);break; case 29: flourish(false);star(r*.95);dot(-r*1.6);dot(r*1.6);break; case 30: wedgePair('star');break;
                default: petal(3);
            }
        }
        return;
    }

    if (style === 'dashdot' || style === 'dashdotdot') {
        ctx.setLineDash(style === 'dashdot'
            ? [thickness * 5, thickness * 2, thickness, thickness * 2]
            : [thickness * 5, thickness * 2, thickness, thickness * 1.5, thickness, thickness * 1.5]);
        line(); ctx.setLineDash([]); return;
    }

    if (style === 'wave' || style === 'zigzag' || style === 'scallop' || style === 'chevron') {
        const step = Math.max(4, thickness * 2);
        const amplitude = Math.max(3, thickness * 1.7);
        ctx.beginPath();
        for (let dist = 0; dist <= length; dist += step) {
            const t = Math.min(1, dist / length);
            const phase = dist / Math.max(10, thickness * 5);
            const offset = style === 'wave' ? Math.sin(phase * Math.PI * 2) * amplitude
                : style === 'scallop' ? Math.abs(Math.sin(phase * Math.PI)) * amplitude
                : style === 'chevron' ? ((Math.floor(dist / step) % 2) ? 0 : amplitude)
                : ((Math.floor(dist / step) % 2) ? amplitude : -amplitude);
            const [x, y] = point(t, offset);
            if (dist === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.lineTo(endX, endY);
        ctx.stroke();
        return;
    }

    if (style === 'ornament') {
        const center = point(0.5);
        const gap = Math.max(12, thickness * 4);
        ctx.beginPath();
        ctx.moveTo(startX, startY); ctx.lineTo(center[0] - ux * gap, center[1] - uy * gap);
        ctx.moveTo(center[0] + ux * gap, center[1] + uy * gap); ctx.lineTo(endX, endY);
        ctx.stroke();
        const r = Math.max(4, thickness * 1.6);
        ctx.beginPath();
        ctx.moveTo(center[0], center[1] - r); ctx.lineTo(center[0] + r, center[1]);
        ctx.lineTo(center[0], center[1] + r); ctx.lineTo(center[0] - r, center[1]); ctx.closePath();
        ctx.fill();
        return;
    }

    line();
    if (style === 'chain') {
        const r = Math.max(3, thickness * 1.25);
        const count = Math.max(2, Math.floor(length / (r * 3.3)));
        for (let i = 0; i <= count; i++) {
            const [x, y] = point(i / count);
            ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
        }
    } else if (style === 'sparkle' || style === 'burst') {
        const r = Math.max(3, thickness * 1.8);
        (style === 'burst' ? [0.5] : [0, 0.5, 1]).forEach(t => {
            const [x, y] = point(t);
            ctx.beginPath();
            ctx.moveTo(x - r, y); ctx.lineTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.closePath();
            ctx.fill();
            if (style === 'burst') {
                ctx.beginPath(); ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r);
                ctx.moveTo(x + r, y - r); ctx.lineTo(x - r, y + r); ctx.stroke();
            }
        });
    } else if (style === 'enddots' || style === 'enddiamonds') {
        const r = Math.max(3, thickness * 1.7);
        [0, 1].forEach(t => {
            const [x, y] = point(t);
            ctx.beginPath();
            if (style === 'enddots') ctx.arc(x, y, r, 0, Math.PI * 2);
            else { ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath(); }
            ctx.fill();
        });
    } else if (style === 'arrow') {
        const r = Math.max(5, thickness * 2.5);
        ctx.beginPath();
        ctx.moveTo(endX, endY);
        ctx.lineTo(endX - ux * r + px * r * .65, endY - uy * r + py * r * .65);
        ctx.moveTo(endX, endY);
        ctx.lineTo(endX - ux * r - px * r * .65, endY - uy * r - py * r * .65);
        ctx.stroke();
    } else if (style === 'double') {
        const gap = Math.max(2, thickness * 1.5);
        const side = isVertical ? (position === 'left' ? -gap : gap) : (position === 'top' ? -gap : gap);
        ctx.beginPath();
        if (isVertical) { ctx.moveTo(startX + side, startY); ctx.lineTo(endX + side, endY); }
        else { ctx.moveTo(startX, startY + side); ctx.lineTo(endX, endY + side); }
        ctx.stroke();
    } else if (style === 'ribbon') {
        const r = Math.max(5, thickness * 2.2);
        ctx.beginPath();
        [-1, 1].forEach(dir => {
            const base = dir === -1 ? [startX, startY] : [endX, endY];
            ctx.moveTo(base[0] + dir * ux * r, base[1] + dir * uy * r);
            ctx.lineTo(base[0] + px * r * 0.7, base[1] + py * r * 0.7);
            ctx.lineTo(base[0] - px * r * 0.7, base[1] - py * r * 0.7);
            ctx.closePath();
        });
        ctx.fill();
    } else if (style === 'crown') {
        const c = point(0.5);
        const r = Math.max(6, thickness * 2.8);
        ctx.beginPath();
        ctx.moveTo(c[0] - r, c[1] + r * 0.5);
        ctx.lineTo(c[0] - r * 1.2, c[1] - r * 0.6);
        ctx.lineTo(c[0] - r * 0.4, c[1] - r * 0.1);
        ctx.lineTo(c[0], c[1] - r * 0.9);
        ctx.lineTo(c[0] + r * 0.4, c[1] - r * 0.1);
        ctx.lineTo(c[0] + r * 1.2, c[1] - r * 0.6);
        ctx.lineTo(c[0] + r, c[1] + r * 0.5);
        ctx.closePath();
        ctx.fill();
    } else if (style === 'crossstars') {
        const r = Math.max(4, thickness * 1.8);
        [0.2, 0.8].forEach(t => {
            const [cx, cy] = point(t);
            ctx.beginPath();
            ctx.moveTo(cx, cy - r); ctx.lineTo(cx + r * 0.3, cy - r * 0.3); ctx.lineTo(cx + r, cy);
            ctx.lineTo(cx + r * 0.3, cy + r * 0.3); ctx.lineTo(cx, cy + r);
            ctx.lineTo(cx - r * 0.3, cy + r * 0.3); ctx.lineTo(cx - r, cy);
            ctx.lineTo(cx - r * 0.3, cy - r * 0.3); ctx.closePath();
            ctx.fill();
        });
    } else if (style === 'swallowtail') {
        const r = Math.max(5, thickness * 2.2);
        ctx.beginPath();
        ctx.moveTo(endX + ux * r, endY + uy * r);
        ctx.lineTo(endX + px * r * 0.8, endY + py * r * 0.8);
        ctx.lineTo(endX - ux * r * 0.5, endY - uy * r * 0.5);
        ctx.lineTo(endX - px * r * 0.8, endY - py * r * 0.8);
        ctx.closePath();
        ctx.fill();
    } else if (style === 'techline') {
        ctx.setLineDash([thickness * 6, thickness * 2, thickness * 2, thickness * 2]);
        line();
        ctx.setLineDash([]);
        const c = point(0.5);
        ctx.fillRect(c[0] - thickness * 2, c[1] - thickness * 2, thickness * 4, thickness * 4);
    } else if (style === 'glowpulse') {
        const c = point(0.5);
        const r = Math.max(6, thickness * 3);
        ctx.beginPath();
        ctx.moveTo(c[0] - r * 1.5, c[1]);
        ctx.lineTo(c[0] - r * 0.8, c[1]);
        ctx.lineTo(c[0] - r * 0.4, c[1] - r);
        ctx.lineTo(c[0] + r * 0.2, c[1] + r);
        ctx.lineTo(c[0] + r * 0.7, c[1] - r * 0.5);
        ctx.lineTo(c[0] + r * 1.1, c[1]);
        ctx.lineTo(c[0] + r * 1.5, c[1]);
        ctx.stroke();
    } else if (style === 'diamondchain') {
        const r = Math.max(4, thickness * 1.8);
        [-r * 2.2, 0, r * 2.2].forEach((offset, idx) => {
            const sz = idx === 1 ? r * 1.2 : r * 0.75;
            const [cx, cy] = [point(0.5)[0] + ux * offset, point(0.5)[1] + uy * offset];
            ctx.beginPath();
            ctx.moveTo(cx, cy - sz); ctx.lineTo(cx + sz, cy); ctx.lineTo(cx, cy + sz); ctx.lineTo(cx - sz, cy); ctx.closePath();
            ctx.fill();
        });
    } else if (style === 'triangles') {
        const r = Math.max(4, thickness * 1.8);
        const c = point(0.5);
        ctx.beginPath();
        ctx.moveTo(c[0] - r * 1.6, c[1] - r); ctx.lineTo(c[0] - r * 0.3, c[1]); ctx.lineTo(c[0] - r * 1.6, c[1] + r); ctx.closePath();
        ctx.moveTo(c[0] + r * 1.6, c[1] - r); ctx.lineTo(c[0] + r * 0.3, c[1]); ctx.lineTo(c[0] + r * 1.6, c[1] + r); ctx.closePath();
        ctx.fill();
    } else if (style === 'feather') {
        const r = Math.max(4, thickness * 1.8);
        [-r * 2, r * 2].forEach(offset => {
            const [cx, cy] = [point(0.5)[0] + ux * offset, point(0.5)[1] + uy * offset];
            ctx.beginPath();
            ctx.ellipse(cx, cy, r * 1.2, r * 0.45, Math.atan2(dy, dx) + (offset > 0 ? 0.4 : -0.4), 0, Math.PI * 2);
            ctx.fill();
        });
    } else if (style === 'curls') {
        const c = point(0.5);
        const r = Math.max(6, thickness * 2.5);
        ctx.beginPath();
        ctx.arc(c[0] - r * 0.8, c[1], r * 0.6, 0, Math.PI * 1.5);
        ctx.arc(c[0] + r * 0.8, c[1], r * 0.6, Math.PI * 0.5, Math.PI * 2);
        ctx.stroke();
    }
}

// 属性面板的“样式图库”直接调用这一个绘制器，因此画廊缩略图、画布预览和导出不会各画各的。
if (typeof window !== 'undefined') {
    window.ReelsTitleDecoration = { draw: _drawTitleDecoration };
}

function drawOverlay(ctx, origOv, currentTime = 0, canvasW = 1920, canvasH = 1080) {
    if (origOv.disabled) return;

    // 一个覆层可拥有多个不连续的显示区间。每次命中区间都投影为独立的
    // start/end，因此原有入场、出场和转场动画会在每个区间重新触发。
    if (Array.isArray(origOv.display_ranges) && !origOv._displayRangeDrawing) {
        const range = origOv.display_ranges.find(item => {
            const start = Number(item?.start);
            const end = Number(item?.end);
            return Number.isFinite(start) && Number.isFinite(end) && currentTime >= start && currentTime <= end + 0.001;
        });
        if (!range) return;
        drawOverlay(ctx, Object.assign({}, origOv, {
            _displayRangeDrawing: true,
            start: Number(range.start),
            end: Number(range.end),
        }), currentTime, canvasW, canvasH);
        return;
    }

    // 文字卡片可选择让蒙版与文字使用不同时间。拆成两个同布局的绘制
    // 分支：一个只画蒙版/边框/模糊，一个只画文字，避免其中一方结束时
    // 被另一方的时间范围提前裁掉。
    if (origOv.type === 'textcard' && origOv.card_time_linked === false && !origOv._cardTimingPart) {
        const textStart = Number(origOv.start || 0);
        const textEnd = Number(origOv.end || 9999);
        const maskStart = Number.isFinite(Number(origOv.mask_start)) ? Number(origOv.mask_start) : textStart;
        const maskEnd = Number.isFinite(Number(origOv.mask_end)) ? Number(origOv.mask_end) : textEnd;
        const textActive = currentTime >= textStart && (textEnd >= 9999 || currentTime <= textEnd + 0.001);
        const maskActive = currentTime >= maskStart && (maskEnd >= 9999 || currentTime <= maskEnd + 0.001);
        if (!textActive && !maskActive) return;

        if (maskActive) {
            const maskOv = Object.assign({}, origOv, {
                _cardTimingPart: true,
                card_time_linked: true,
                start: maskStart,
                end: maskEnd,
                // 保留原文用于自动高度测量，但不绘制任何文字。
                _original_title_text: origOv.title_text,
                _original_body_text: origOv.body_text,
                _original_footer_text: origOv.footer_text,
                title_text: '', body_text: '', footer_text: '',
            });
            drawOverlay(ctx, maskOv, currentTime, canvasW, canvasH);
        }
        if (textActive) {
            const textOv = Object.assign({}, origOv, {
                _cardTimingPart: true,
                card_time_linked: true,
                card_enabled: false,
                card_border_enabled: false,
                card_blur_enabled: false,
            });
            drawOverlay(ctx, textOv, currentTime, canvasW, canvasH);
        }
        return;
    }
    
    let ov = origOv;

    // ── 文字翻转器 (Dynamic Flipper) 拦截 ──
    if (ov.flipper_enabled && !ov._flipper_drawing && (ov.type === 'text' || ov.type === 'textcard')) {
        const text = (ov.type === 'textcard') ? (ov.body_text || '') : (ov.content || '');
        const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0);
        if (lines.length > 0) {
            const flipper_lines = parseInt(ov.flipper_lines) || 2;
            const flipper_duration = parseFloat(ov.flipper_duration) || 2.0;
            const totalChunks = Math.ceil(lines.length / flipper_lines);
            const startSec = parseFloat(ov.start || 0);
            const t = currentTime - startSec;
            
            if (t >= 0) {
                let chunkIndex = Math.floor(t / flipper_duration);
                const rawTransDuration = parseFloat(ov.flipper_transition_duration);
                const transitionDuration = Math.min(isNaN(rawTransDuration) ? 0.3 : rawTransDuration, flipper_duration);
                const phase = t % flipper_duration;
                
                let inTransition = false;
                let transitionProgress = 0;
                let prevChunkIndex = -1;
                let currentChunkIndex = chunkIndex;
                
                if (ov.flipper_loop) {
                    currentChunkIndex = currentChunkIndex % totalChunks;
                    prevChunkIndex = (currentChunkIndex - 1 + totalChunks) % totalChunks;
                    if (phase < transitionDuration) {
                        inTransition = true;
                        transitionProgress = phase / transitionDuration;
                    }
                } else {
                    if (currentChunkIndex < totalChunks) {
                        prevChunkIndex = currentChunkIndex - 1;
                        if (phase < transitionDuration && currentChunkIndex > 0) {
                            inTransition = true;
                            transitionProgress = phase / transitionDuration;
                        }
                    } else {
                        currentChunkIndex = -1;
                    }
                }
                
                const getChunkText = (idx) => {
                    if (idx < 0 || idx >= totalChunks) return '';
                    const startLine = idx * flipper_lines;
                    return lines.slice(startLine, startLine + flipper_lines).join('\n');
                };

                const effect = ov.flipper_effect || 'none';
                
                if (inTransition && effect !== 'none') {
                    // 1. 绘制静态背景/标题/结尾
                    if (ov.type === 'textcard') {
                        const ovStatic = Object.assign({}, origOv);
                        ovStatic._flipper_drawing = true;
                        ovStatic.body_text = '';
                        ovStatic._original_body_text = getChunkText(currentChunkIndex); // 测量占位
                        drawOverlay(ctx, ovStatic, currentTime, canvasW, canvasH);
                    }
                    
                    // 2. 绘制淡出/移出中的前一组文字
                    const ovOld = Object.assign({}, origOv);
                    ovOld._flipper_drawing = true;
                    ovOld.card_enabled = false;
                    ovOld.card_border_enabled = false;
                    ovOld.card_blur_enabled = false;
                    
                    if (ov.type === 'textcard') {
                        ovOld.title_text = '';
                        ovOld.footer_text = '';
                        ovOld.body_text = getChunkText(prevChunkIndex);
                        ovOld._original_title_text = origOv.title_text;
                        ovOld._original_footer_text = origOv.footer_text;
                        ovOld._original_body_text = getChunkText(currentChunkIndex); // Keep baseline aligned to ovNew!
                    } else {
                        ovOld.content = getChunkText(prevChunkIndex);
                    }
                    
                    const origOpacity = ov.opacity ?? 255;
                    if (effect === 'fade') {
                        ovOld.opacity = origOpacity * (1 - transitionProgress);
                    } else if (effect === 'slide') {
                        ovOld.opacity = origOpacity * (1 - transitionProgress);
                        if (ov.type === 'textcard') {
                            ovOld.body_offset_y = (parseFloat(origOv.body_offset_y) || 0) - transitionProgress * 40;
                        } else {
                            ovOld.y = (parseFloat(origOv.y) || 0) - transitionProgress * 40;
                        }
                    }
                    drawOverlay(ctx, ovOld, currentTime, canvasW, canvasH);
                    
                    // 3. 绘制淡入/移入中的新一组文字
                    const ovNew = Object.assign({}, origOv);
                    ovNew._flipper_drawing = true;
                    ovNew.card_enabled = false;
                    ovNew.card_border_enabled = false;
                    ovNew.card_blur_enabled = false;
                    
                    if (ov.type === 'textcard') {
                        ovNew.title_text = '';
                        ovNew.footer_text = '';
                        ovNew.body_text = getChunkText(currentChunkIndex);
                        ovNew._original_title_text = origOv.title_text;
                        ovNew._original_footer_text = origOv.footer_text;
                        ovNew._original_body_text = getChunkText(currentChunkIndex);
                    } else {
                        ovNew.content = getChunkText(currentChunkIndex);
                    }
                    
                    if (effect === 'fade') {
                        ovNew.opacity = origOpacity * transitionProgress;
                    } else if (effect === 'slide') {
                        ovNew.opacity = origOpacity * transitionProgress;
                        if (ov.type === 'textcard') {
                            ovNew.body_offset_y = (parseFloat(origOv.body_offset_y) || 0) + (1 - transitionProgress) * 40;
                        } else {
                            ovNew.y = (parseFloat(origOv.y) || 0) + (1 - transitionProgress) * 40;
                        }
                    }
                    drawOverlay(ctx, ovNew, currentTime, canvasW, canvasH);
                    return;
                } else {
                    // 硬切模式
                    ov = Object.assign({}, origOv);
                    ov._flipper_drawing = true;
                    const txt = getChunkText(currentChunkIndex);
                    if (ov.type === 'textcard') {
                        ov.body_text = txt;
                        ov._original_body_text = txt;
                    } else {
                        ov.content = txt;
                    }
                }
            }
        }
    }
    
    // ── 时间切片模式拦截 (分段正文) ──
    if (ov._subtitleTimeMode === 'split' && ov._subtitleTimeSlices && ov.type === 'textcard' && !ov._fcpxml_generating) {
        const slices = ov._subtitleTimeSlices;
        let currentSource = 'all';
        let matchedSlice = null;
        for (const s of slices) {
            if (currentTime >= (s.startSec || 0) && (!s.endSec || currentTime < s.endSec)) {
                currentSource = s.source || 'all';
                matchedSlice = s;
                break;
            }
        }
        if (currentSource !== 'all' && matchedSlice) {
            ov = Object.assign({}, origOv); // 浅拷贝
            // 覆写进出场时间以触发进出场动画
            ov.start = matchedSlice.startSec || 0;
            if (matchedSlice.endSec) ov.end = matchedSlice.endSec;
            
            // 备份原始文本供测算布局高度，避免高度塌陷与抖动
            ov._original_title_text = origOv.title_text;
            ov._original_body_text = origOv.body_text;
            ov._original_footer_text = origOv.footer_text;
            
            if (currentSource === 'body_part1') {
                ov.body_text = splitBodyText(origOv.body_text)[0];
            } else if (currentSource === 'body_part2') {
                ov.body_text = splitBodyText(origOv.body_text)[1];
            } else if (currentSource === 'title') {
                ov.body_text = ''; ov.footer_text = '';
            } else if (currentSource === 'body') {
                ov.title_text = ''; ov.footer_text = '';
            }
        }
    }

    const start = parseFloat(ov.start || 0);
    const end = parseFloat(ov.end || 0);
    // Original phone preview plays on the current canvas without seeking the video.
    if (ov.is_phone_cta && (!ov._exporting || ov._hitTesting) && ov._ctaAnimPreviewStart && typeof performance !== 'undefined') {
        const elapsed = (performance.now() - ov._ctaAnimPreviewStart) / 1000;
        if (elapsed >= 0 && elapsed <= 2.4) currentTime = start + Math.max(0.06, elapsed);
    }

    // 时间范围检查 (允许边界值)
    // end >= 9999 = 全程，永不超时
    // scroll 覆层: 动画完成后保持在最终位置
    // _previewAtEnd: 跳过时间检查，强制渲染终点位置
    const isPreviewingEnd = ov._previewAtEnd && ov.anim_dest_enabled;
    if (!isPreviewingEnd && currentTime < start) {
        if (ov._insertClip) console.log('[InsertDraw] SKIPPED: currentTime', currentTime, '< start', start);
        return;
    }
    if (!isPreviewingEnd && end < 9999 && ov.type !== 'scroll' && currentTime > end + 0.001) {
        if (ov._insertClip) { console.log('[InsertDraw] SKIPPED: currentTime', currentTime, '> end', end); return; }
        // 对于 video/image 覆层，如果 end 恰好等于视频时长（被 9999 覆盖的遗留问题），也视为全程
        if ((ov.type === 'video' || ov.type === 'image') && end > 0 && ov.media_loop !== false) {
            // 允许继续绘制（循环播放）
        } else {
            return;
        }
    }

    let x = parseFloat(ov.x || 0);
    let y = parseFloat(ov.y || 0);
    let destScaleOffset = 1.0;
    let w = parseFloat(ov.w || 100);
    let h = parseFloat(ov.h || 100);
    // 媒体窗口有两层坐标：PIP 的 ov.x/y 是窗口位置，inner 是素材在
    // 窗口内的位置；上、下半屏窗口固定，只有 inner 可移动。裁切始终固定在窗口。
    let mediaWindowRect = null;
    const halfWindow=['image','video'].includes(ov.type)?window.ReelsMediaWindow?.halfScreen(ov.media_window_mode,ov.media_split_angle,canvasW,canvasH):null;
    const diagonalWindow=halfWindow && Math.abs(halfWindow.angle)>0.0001?halfWindow:null;
    if ((ov.type === 'image' || ov.type === 'video') && ov.media_window_mode === 'pip') {
        const savedWindow = ov.media_window || {};
        const baseWindow = {
            x: Number.isFinite(Number(savedWindow.x)) ? Number(savedWindow.x) : x,
            y: Number.isFinite(Number(savedWindow.y)) ? Number(savedWindow.y) : y,
            w: Number(savedWindow.w) > 0 ? Number(savedWindow.w) : w,
            h: Number(savedWindow.h) > 0 ? Number(savedWindow.h) : h,
        };
        // 原“变换缩放”是整个覆层窗口的总缩放：PIP 的裁切框、素材与
        // 预览辅助线必须同缩放。下半屏则保持固定裁切区，只缩放区内素材。
        const outerScaleX = Math.max(0.01, parseFloat(ov.scale_x ?? ov.scale ?? 1) || 1);
        const outerScaleY = Math.max(0.01, parseFloat(ov.scale_y ?? ov.scale ?? 1) || 1);
        mediaWindowRect = {
            x: baseWindow.x + (baseWindow.w - baseWindow.w * outerScaleX) / 2,
            y: baseWindow.y + (baseWindow.h - baseWindow.h * outerScaleY) / 2,
            w: baseWindow.w * outerScaleX,
            h: baseWindow.h * outerScaleY,
        };
        // 素材绘制尺寸由窗口尺寸决定；外层窗口与内层素材彻底分离。
        x = mediaWindowRect.x;
        y = mediaWindowRect.y;
        w = mediaWindowRect.w;
        h = mediaWindowRect.h;
        x += (parseFloat(ov.media_inner_x || 0) || 0) * outerScaleX;
        y += (parseFloat(ov.media_inner_y || 0) || 0) * outerScaleY;
    } else if ((ov.type === 'image' || ov.type === 'video') && ['top_half', 'bottom_half'].includes(ov.media_window_mode)) {
        const windowY = ov.media_window_mode === 'top_half' ? 0 : canvasH / 2;
        mediaWindowRect = diagonalWindow?.rect || { x: 0, y: windowY, w: canvasW, h: canvasH / 2 };
        if(diagonalWindow){w=mediaWindowRect.w;h=mediaWindowRect.h;}
        x = mediaWindowRect.x + parseFloat(ov.media_inner_x || 0);
        y = mediaWindowRect.y + parseFloat(ov.media_inner_y || 0);
    }

    // ── 跟随滚动字幕正文绑定 ──
    if (ov.bind_scroll_overlay_id && (ov.type === 'image' || ov.type === 'video')) {
        const allOvs = ov._allOverlays || [];
        const scrollOv = allOvs.find(o => o.id === ov.bind_scroll_overlay_id && o.type === 'scroll');
        if (scrollOv && scrollOv._scrollBodyFirstLineY != null) {
            const bindOffsetX = parseFloat(ov.bind_scroll_offset_x || 0);
            const bindOffsetY = parseFloat(ov.bind_scroll_offset_y || 0);
            const bindMinY = ov.bind_scroll_clamp_min_y;
            const bindMaxY = ov.bind_scroll_clamp_max_y;

            // Y 跟随正文第一行
            let targetY = scrollOv._scrollBodyFirstLineY + bindOffsetY;
            // 应用边界钳制
            if (bindMinY != null && !isNaN(parseFloat(bindMinY))) {
                targetY = Math.max(parseFloat(bindMinY), targetY);
            }
            if (bindMaxY != null && !isNaN(parseFloat(bindMaxY))) {
                targetY = Math.min(parseFloat(bindMaxY), targetY);
            }
            y = targetY;

            // X 可选跟随
            if (ov.bind_scroll_follow_x) {
                x = scrollOv._scrollBodyCurX + bindOffsetX - w / 2;
            }
        }
    }

    if (ov.anim_dest_enabled && end > start) {
        // A→B 面板坐标与普通位置控件保持一致：
        // 媒体/文本/文字卡片使用“相对画布中心的中心点偏移”，scroll 使用左上角。
        // 渲染内部统一转换为左上角。
        const useCenterPoint = ov.type !== 'scroll';
        const fallbackStartX = useCenterPoint ? (x + w / 2) - canvasW / 2 : x;
        const fallbackStartY = useCenterPoint ? (y + h / 2) - canvasH / 2 : y;
        const readAnimNumber = (value, fallback) => {
            const n = parseFloat(value);
            return Number.isFinite(n) ? n : fallback;
        };
        const startPointX = readAnimNumber(ov.anim_start_x, fallbackStartX);
        const startPointY = readAnimNumber(ov.anim_start_y, fallbackStartY);
        const endPointX = readAnimNumber(ov.anim_end_x, startPointX);
        const endPointY = readAnimNumber(ov.anim_end_y, startPointY);
        // 计算动画进度。支持按时长或按速度控制；
        // 速度模式：时长 = A/B 距离 / px/s。
        const fallbackDuration = (end >= 9999) ? 5.0 : (end - start);
        const explicitDuration = parseFloat(ov.anim_duration || 0);
        const speed = parseFloat(ov.anim_speed || 0);
        const distance = Math.hypot(endPointX - startPointX, endPointY - startPointY);
        const animDuration = (ov.anim_timing_mode === 'speed' && speed > 0)
            ? Math.max(0.001, distance / speed)
            : (explicitDuration > 0 ? explicitDuration : fallbackDuration);
        let p = Math.max(0, Math.min(1, (currentTime - start) / Math.max(0.001, animDuration)));
        // 预览终点模式：强制显示在终点位置
        if (ov._previewAtEnd) p = 1;
        const easingName = ov.anim_easing || 'ease_in_out_quad';
        const easingFn = window.ReelsAnimEngine
            ? (window.ReelsAnimEngine.EASING_MAP[easingName] || window.ReelsAnimEngine.EASING_MAP.ease_in_out_quad)
            : null;
        const easedP = easingFn ? easingFn(p) : p;
        const startX = useCenterPoint ? canvasW / 2 + startPointX - w / 2 : startPointX;
        const startY = useCenterPoint ? canvasH / 2 + startPointY - h / 2 : startPointY;
        const endX = useCenterPoint ? canvasW / 2 + endPointX - w / 2 : endPointX;
        const endY = useCenterPoint ? canvasH / 2 + endPointY - h / 2 : endPointY;
        const startScale = readAnimNumber(ov.anim_start_scale, 100) / 100.0;
        const endScale = readAnimNumber(ov.anim_end_scale, 100) / 100.0;
        
        x = startX + (endX - startX) * easedP;
        y = startY + (endY - startY) * easedP;
        destScaleOffset = startScale + (endScale - startScale) * easedP;
    }

    const rotation = parseFloat(ov.rotation || 0);
    const rawOp = Number.isFinite(parseFloat(ov.opacity)) ? parseFloat(ov.opacity) : 255;
    const opacity = (rawOp <= 1.0 && rawOp >= 0) ? rawOp : rawOp / 255;

    ctx.save();

    // 固定分屏窗口（例如“下半屏”）：先在画布坐标裁切，再在窗口内移动
    // 素材本身。这样 X/Y 调整不会把窗口整体拖离下半屏。
    ctx.save(); // Keep the picture clip separate from an optional outside border.
    if(diagonalWindow){
        ctx.beginPath();diagonalWindow.polygon.forEach(([px,py],index)=>index?ctx.lineTo(px,py):ctx.moveTo(px,py));ctx.closePath();ctx.clip();
    }
    let clipRect = mediaWindowRect || ov.clip_rect;
    // 四向裁切收缩“显示窗口”，不会改变素材的取景比例或绘制尺寸，
    // 因此不会出现裁切后画面被放大的效果。
    const cropPct = key => Math.max(0, Math.min(99, Number(ov[key]) || 0));
    const cropLeft = cropPct('media_crop_left'), cropTop = cropPct('media_crop_top');
    const cropRight = Math.min(cropPct('media_crop_right'), 99 - cropLeft);
    const cropBottom = Math.min(cropPct('media_crop_bottom'), 99 - cropTop);
    if (cropLeft || cropTop || cropRight || cropBottom) {
        const base = clipRect || { x, y, w, h };
        clipRect = {
            x: (Number(base.x) || 0) + Number(base.w) * cropLeft / 100,
            y: (Number(base.y) || 0) + Number(base.h) * cropTop / 100,
            w: Math.max(1, Number(base.w) * (100 - cropLeft - cropRight) / 100),
            h: Math.max(1, Number(base.h) * (100 - cropTop - cropBottom) / 100),
        };
    }
    if (clipRect && Number(clipRect.w) > 0 && Number(clipRect.h) > 0) {
        const cx = Number(clipRect.x) || 0, cy = Number(clipRect.y) || 0;
        const cw = Number(clipRect.w), ch = Number(clipRect.h);
        const shape = ov.media_window_mode === 'pip' ? (ov.media_mask_shape || 'rect') : 'rect';
        ctx.beginPath();
        if (shape === 'circle') {
            ctx.arc(cx + cw / 2, cy + ch / 2, Math.min(cw, ch) / 2, 0, Math.PI * 2);
        } else if (shape === 'ellipse') {
            ctx.ellipse(cx + cw / 2, cy + ch / 2, cw / 2, ch / 2, 0, 0, Math.PI * 2);
        } else if (shape === 'round_rect') {
            // Use the same circular corners as the inset media border.
            const radii = ['tl','tr','br','bl'].map(key =>
                Math.max(0, Math.min(cw / 2, ch / 2, Number(ov['media_corner_' + key]) || 0)));
            ctx.roundRect(cx, cy, cw, ch, radii);
        } else {
            ctx.rect(cx, cy, cw, ch);
        }
        ctx.clip();
    }

    const mediaBorderTransform = window.ReelsMediaBorder?.enabled(ov) ? ctx.getTransform() : null;

    // 旋转
    const cx = x + w / 2;
    const cy = y + h / 2;
    ctx.translate(cx, cy);
    if (rotation) ctx.rotate(rotation * Math.PI / 180);

    // 转场动画
    let transOp = 1, transScale = 1, transDx = 0, transDy = 0;
    if (window.ReelsAnimEngine) {
        const preset = ov.transition_preset || 'none';
        const dur = parseFloat(ov.transition_duration || 0.35);
        const result = ReelsAnimEngine.computeTransitionParams(currentTime, start, end, preset, dur);
        // result is an array: [opacityFactor, scale, dx, dy]
        transOp = result[0];
        transScale = result[1];
        transDx = result[2];
        transDy = result[3];
    }
    
    transScale *= destScaleOffset;

    ctx.translate(transDx, transDy);
    if (Math.abs(transScale - 1) > 0.0001) {
        ctx.scale(transScale, transScale);
    }
    ctx.translate(-cx, -cy);

    ctx.globalAlpha = opacity * transOp;

    // ── 入/出场动画（image/video/text 在此统一处理；textcard 有自己的特化实现）──
    const inType = ov.anim_in_type || 'none';
    const outType = ov.anim_out_type || 'none';
    const _applySharedAnim = !ov.is_phone_cta && ov.type !== 'textcard' && ov.type !== 'scroll';
    if (_applySharedAnim && window.ReelsAnimEngine && (inType !== 'none' || outType !== 'none')) {
        const inDur = inType !== 'none' ? parseFloat(ov.anim_in_duration || 0.3) : 0;
        const outDur = outType !== 'none' ? parseFloat(ov.anim_out_duration || 0.3) : 0;
        const [inProgress, outProgress] = ReelsAnimEngine.computeAnimProgress(
            currentTime, start, end, inDur, outDur
        );

        // 淡入/淡出
        if (inType === 'fade') ctx.globalAlpha *= inProgress;
        if (outType === 'fade') ctx.globalAlpha *= outProgress;

        // 弹出
        if (inType === 'pop' || outType === 'pop') {
            let popScale = 1;
            if (inType === 'pop') popScale = Math.min(popScale, ReelsAnimEngine.computePopScale(inProgress));
            if (outType === 'pop') popScale = Math.min(popScale, ReelsAnimEngine.computePopScale(outProgress));
            if (popScale < 0.999) {
                ctx.translate(x + w / 2, y + h / 2);
                ctx.scale(popScale, popScale);
                ctx.translate(-(x + w / 2), -(y + h / 2));
            }
        }

        // 滑入/滑出
        const slideDistance = Math.max(w, h) * 0.5;
        if (inType.startsWith('slide_') && inProgress < 1) {
            const ease = 1 - inProgress;
            if (inType === 'slide_up') ctx.translate(0, slideDistance * ease);
            else if (inType === 'slide_down') ctx.translate(0, -slideDistance * ease);
            else if (inType === 'slide_left') ctx.translate(slideDistance * ease, 0);
            else if (inType === 'slide_right') ctx.translate(-slideDistance * ease, 0);
        }
        if (outType.startsWith('slide_') && outProgress < 1) {
            const ease = 1 - outProgress;
            if (outType === 'slide_up') ctx.translate(0, -slideDistance * ease);
            else if (outType === 'slide_down') ctx.translate(0, slideDistance * ease);
        }
    }

    // 循环文件夹可以混放图片、视频和 GIF。ov.type 只由首个文件决定，
    // 因此轮到后续素材时必须按当前路径选择绘制器。
    const activeFolderPath = ov.media_folder_files?.length ? _resolveFolderMediaPath(ov, currentTime) : '';
    const activeType = activeFolderPath ? (_isVideoOverlayPath(activeFolderPath) ? 'video' : 'image') : ov.type;
    if (ov.is_phone_cta) _applyPhoneCtaAnimation(ctx, ov, currentTime, start, end, x+w/2, y+h/2, Math.max(w,h)*0.5);
    if (!ov._mediaBorderOnly) _drawMediaBlurFill(ctx, ov, mediaWindowRect, currentTime);
    if (ov._mediaBlurBackgroundOnly) {
        ctx.restore();
        ctx.restore();
        return;
    }
    if (ov._mediaBorderOnly) {
        // Export a transparent border asset without baking the editable media.
    } else if (activeType === 'image') {
        _drawImageOverlay(ctx, ov, x, y, w, h, currentTime);
    } else if (activeType === 'text') {
        _drawTextOverlay(ctx, ov, x, y, w, h, currentTime);
    } else if (activeType === 'textcard') {
        const cardOv = ov.is_phone_cta ? { ...ov, anim_in_type: 'none', anim_out_type: 'none' } : ov;
        _drawTextCardOverlay(ctx, cardOv, x, y, w, h, canvasW, canvasH, currentTime);
        if (cardOv !== ov) for (const key of ['_renderedX','_renderedY','_renderedW','_renderedH']) if (cardOv[key] !== undefined) ov[key] = cardOv[key];
    } else if (activeType === 'solid_mask') {
        _drawSolidMaskOverlay(ctx, ov, x, y, w, h, canvasW, canvasH, currentTime);
    } else if (activeType === 'scroll') {
        _drawScrollOverlay(ctx, ov, x, y, w, h, currentTime, canvasW, canvasH);
    } else if (activeType === 'decor') {
        _drawDecorOverlay(ctx, ov, x, y, w, h, currentTime, canvasW, canvasH);
    } else if (activeType === 'video') {
        _drawVideoOverlay(ctx, ov, x, y, w, h, currentTime);
    }

    const mediaBorderAlpha = ctx.globalAlpha;
    ctx.restore(); // Release the picture mask before drawing the border.
    if (mediaBorderTransform && !ov._mediaBlurBackgroundOnly) {
        ctx.save();ctx.setTransform(mediaBorderTransform);
        ctx.globalAlpha = mediaBorderAlpha;
        window.ReelsMediaBorder.draw(ctx, ov, clipRect || {x,y,w,h}, diagonalWindow?.polygon);
        ctx.restore();
    }
    ctx.restore();

    // 仅编辑预览：画中画/半屏的窗口是固定裁切区，给出边框提示，
    // 方便区分“移动窗口”和“在窗口内移动素材”。导出对象标记为
    // _exporting，因此成片和分层 PNG 中绝不会包含这条辅助线。
    if (!ov._exporting && !window.__reelsLayoutReview && mediaWindowRect) {
        const rx = Number(mediaWindowRect.x) || 0;
        const ry = Number(mediaWindowRect.y) || 0;
        const rw = Number(mediaWindowRect.w) || 0;
        const rh = Number(mediaWindowRect.h) || 0;
        if (rw > 0 && rh > 0) {
            const isHalfScreen = ['top_half', 'bottom_half'].includes(ov.media_window_mode);
            const isTop = ov.media_window_mode === 'top_half';
            ctx.save();
            ctx.setLineDash([8, 5]);
            ctx.lineWidth = ov._selected ? 3 : 1.5;
            ctx.strokeStyle = isHalfScreen ? 'rgba(255, 190, 70, .9)' : 'rgba(52, 211, 153, .9)';
            if(diagonalWindow){ctx.beginPath();diagonalWindow.polygon.forEach(([px,py],index)=>index?ctx.lineTo(px,py):ctx.moveTo(px,py));ctx.closePath();ctx.stroke();}
            else ctx.strokeRect(rx + 0.5, ry + 0.5, Math.max(0, rw - 1), Math.max(0, rh - 1));
            ctx.setLineDash([]);
            ctx.font = '600 15px sans-serif';
            const label = isHalfScreen ? `${isTop ? '上' : '下'}半屏固定裁切区` : '画中画固定窗口';
            const labelW = ctx.measureText(label).width + 12;
            const labelY = Math.max(0, ry - 23);
            ctx.fillStyle = isHalfScreen ? 'rgba(111, 78, 15, .88)' : 'rgba(6, 78, 59, .88)';
            ctx.fillRect(rx, labelY, labelW, 21);
            ctx.fillStyle = '#fff';
            ctx.fillText(label, rx + 6, labelY + 15);
            ctx.restore();
        }
    }
}

/**
 * 渲染图片覆层 (内部)。
 */
const _folderDurationCache = new Map();
async function prepareFolderMedia(ov) {
    const files = Array.isArray(ov.media_folder_files) ? ov.media_folder_files.filter(Boolean) : [];
    const durations = await Promise.all(files.map(async path => {
        if (!/\.(mp4|mov|avi|mkv|webm|m4v|gif)$/i.test(path)) return 5;
        if (!_folderDurationCache.has(path)) {
            _folderDurationCache.set(path, Promise.resolve(window.electronAPI?.getMediaDuration?.(path)).then(value => {
                const duration = Number(value);
                if (!(duration > 0)) throw new Error(`无法读取素材原始时长：${path}`);
                return duration;
            }).catch(error => {
                // 单个损坏或暂时无法探测的文件不能让整个素材池停留在
                // 上一次选择文件夹的时长表里。保留顺序循环，按 5 秒兜底。
                _folderDurationCache.delete(path);
                console.warn('[Overlay] 无法读取文件夹媒体时长，按 5 秒循环：', path, error);
                return 5;
            }));
        }
        return _folderDurationCache.get(path);
    }));
    ov.media_folder_durations = durations;
    ov.media_folder_duration_paths = [...files];
    return durations;
}

function resolveFolderMedia(ov, currentTime) {
    const files = Array.isArray(ov.media_folder_files) ? ov.media_folder_files.filter(Boolean) : [];
    if (!files.length) return { path: ov.content || '', time: Math.max(0, currentTime - (Number(ov.start) || 0)) };
    const elapsed = Math.max(0, currentTime - (parseFloat(ov.start || 0)));
    const fixed = Number(ov.media_folder_interval) || 0;
    const durations = files.map((_, i) => {
        const value = fixed > 0 ? fixed : Number(ov.media_folder_durations?.[i]);
        return Number.isFinite(value) && value > 0 ? value : 5;
    });
    const total = durations.reduce((a, b) => a + b, 0);
    let time = elapsed % (total > 0 ? total : 5);
    for (let i = 0; i < files.length; i++) {
        if (time < durations[i]) return { path: files[i], time };
        time -= durations[i];
    }
    return { path: files[0], time: 0 };
}
function _resolveFolderMediaPath(ov, currentTime) {
    const files = Array.isArray(ov.media_folder_files) ? ov.media_folder_files.filter(Boolean) : [];
    const durationPaths = Array.isArray(ov.media_folder_duration_paths) ? ov.media_folder_duration_paths : [];
    const durationListMatchesFiles = files.length === durationPaths.length
        && files.every((file, index) => file === durationPaths[index]);
    if (files.length && (!ov.media_folder_durations || !durationListMatchesFiles) && !ov._folderDurationPending) {
        ov._folderDurationPending = true;
        prepareFolderMedia(ov).catch(console.warn).finally(() => { ov._folderDurationPending = false; });
    }
    return resolveFolderMedia(ov, currentTime).path;
}

function _isVideoOverlayPath(mediaPath) {
    return /\.(mp4|mov|avi|mkv|webm|m4v|gif)(?:[?#]|$)/i.test(String(mediaPath || ''));
}

// A separate decoder freezes the trim-in frame, independent of playback/seek.
const _mediaBlurFrames = new Map();
function hasMediaBlurFill(ov) {
    return ov.media_blur_fill === true && ['pip', 'top_half', 'bottom_half'].includes(ov.media_window_mode);
}
function _mediaBlurEntry(ov, path) {
    const offset = Math.max(0, Number(ov.video_start_offset) || 0);
    const key = JSON.stringify([path, offset]);
    if (_mediaBlurFrames.has(key)) return _mediaBlurFrames.get(key);
    const entry = { canvas: null, promise: null };
    _mediaBlurFrames.set(key, entry);
    entry.promise = new Promise((resolve, reject) => {
        const video = _isVideoOverlayPath(path) && !/\.gif$/i.test(path);
        const media = video ? document.createElement('video') : new Image();
        media.crossOrigin = 'anonymous';
        const timer = setTimeout(() => finish(new Error('静态模糊帧加载超时：' + path)), 30000);
        function finish(error) {
            clearTimeout(timer);
            media.onerror = media.onload = media.onloadeddata = media.onseeked = null;
            if (video) { media.pause(); media.removeAttribute('src'); media.load(); media.remove(); }
            if (error) reject(error); else resolve(entry.canvas);
        }
        function capture() {
            try {
                const canvas = document.createElement('canvas');
                canvas.width = media.videoWidth || media.naturalWidth;
                canvas.height = media.videoHeight || media.naturalHeight;
                if (!canvas.width || !canvas.height) throw new Error('静态模糊帧尺寸无效');
                canvas.getContext('2d').drawImage(media, 0, 0);
                entry.canvas = canvas;
                finish();
                if (typeof window !== 'undefined') {
                    window.ReelsPreviewV2?.render?.();
                    if (!window.ReelsPreviewV2?.isOpen?.()) window.reelsUpdatePreview?.();
                }
            } catch (error) { finish(error); }
        }
        media.onerror = () => finish(new Error('静态模糊帧加载失败：' + path));
        if (video) {
            media.muted = true; media.preload = 'auto'; media.playsInline = true;
            _attachOverlayVideoToDom(media);
            media.onloadeddata = () => {
                const target = Math.min(offset, Math.max(0, media.duration - .001));
                if (Math.abs(media.currentTime - target) > .0001) {
                    media.onseeked = capture; media.currentTime = target;
                } else capture();
            };
        } else media.onload = capture;
        media.src = _normalizeOverlayMediaPath(path);
    });
    // Preview may start loading without awaiting; export still propagates errors.
    entry.promise.catch(() => {});
    return entry;
}
async function prepareMediaBlurFill(overlays) {
    await Promise.all((overlays || []).filter(ov => !ov.disabled && hasMediaBlurFill(ov)).flatMap(ov =>
        (ov.media_folder_files?.length ? ov.media_folder_files : [ov.content]).filter(Boolean)
            .map(path => _mediaBlurEntry(ov, path).promise)));
}
function getContentBlurSource(task) {
    if (!task?.contentVideoPath || !task.contentVideoBlurBg || !task.contentVideoBlurStatic) return null;
    return _mediaBlurEntry({ video_start_offset: task.contentVideoTrimStart }, task.contentVideoPath).canvas;
}
async function prepareContentBlurBackground(task) {
    if (!task?.contentVideoPath || !task.contentVideoBlurBg || !task.contentVideoBlurStatic) return null;
    return _mediaBlurEntry({ video_start_offset: task.contentVideoTrimStart }, task.contentVideoPath).promise;
}
function _drawMediaBlurFill(ctx, ov, rect, currentTime) {
    if (!hasMediaBlurFill(ov) || !rect) return;
    const path = _resolveFolderMediaPath(ov, currentTime);
    if (!path) return;
    const frame = _mediaBlurEntry(ov, path).canvas;
    if (!frame) return;
    const blur = 30;
    // Overscan prevents transparent edges caused by the Gaussian kernel.
    const fit = Math.max((rect.w + blur * 6) / frame.width, (rect.h + blur * 6) / frame.height);
    const dw = frame.width * fit, dh = frame.height * fit;
    ctx.save();
    ctx.filter = `blur(${blur}px)`;
    ctx.drawImage(frame, rect.x + (rect.w - dw) / 2, rect.y + (rect.h - dh) / 2, dw, dh);
    ctx.restore();
}

function _drawMissingMediaPlaceholder(ctx, ov, x, y, w, h) {
    if (ov._exporting && !ov._hitTesting) return;
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = ov._hitTesting ? '#ff0000' : 'rgba(255,0,0,0.2)';
    ctx.fillRect(x, y, w, h);
    ctx.restore();
}

function _drawImageOverlay(ctx, ov, x, y, w, h, currentTime = 0) {
    const imgPath = _resolveFolderMediaPath(ov, currentTime);
    if (!imgPath) return;

    // 导出时使用 job 私有的预加载图片。预览才走全局缓存；否则连续导出
    // 的不同任务可能在异步加载/缓存复用期间错误地画出上一任务的图片。
    const img = (ov._exporting && !ov._hitTesting && (ov._exportFolderImages?.[imgPath] || ov._exportImage)) || _getCachedImage(imgPath);
    if (!img) {
        if (_imageCache[imgPath] === _IMAGE_FAILED) _drawMissingMediaPlaceholder(ctx, ov, x, y, w, h);
        return;
    }

    const scaleX = ov.media_window_mode === 'pip' ? 1 : Math.max(0.01, parseFloat(ov.scale_x ?? ov.scale ?? 1) || 1);
    const scaleY = ov.media_window_mode === 'pip' ? 1 : Math.max(0.01, parseFloat(ov.scale_y ?? ov.scale ?? 1) || 1);
    const innerScale = Math.max(0.01, parseFloat(ov.media_inner_scale ?? 1) || 1);
    const innerRotation = parseFloat(ov.media_inner_rotation || 0);
    const flipX = ov.flip_x || false;
    const flipY = ov.flip_y || false;
    const keepAspect = ov.keep_aspect !== false || hasMediaBlurFill(ov);

    // 混合模式
    const blendMode = ov.blend_mode || 'source-over';
    ctx.globalCompositeOperation = blendMode;

    ctx.save();
    ctx.translate(x + w / 2, y + h / 2);
    if (innerRotation) ctx.rotate(innerRotation * Math.PI / 180);
    ctx.scale(flipX ? -scaleX * innerScale : scaleX * innerScale, flipY ? -scaleY * innerScale : scaleY * innerScale);

    let drawW = w, drawH = h;
    if (keepAspect) {
        const imgRatio = img.naturalWidth / img.naturalHeight;
        const boxRatio = w / h;
        if (ov.crop_fill && !hasMediaBlurFill(ov) && imgRatio > boxRatio) {
            drawH = h;
            drawW = h * imgRatio;
        } else if (ov.crop_fill && !hasMediaBlurFill(ov)) {
            drawW = w;
            drawH = w / imgRatio;
        } else if (imgRatio > boxRatio) {
            drawH = w / imgRatio;
        } else {
            drawW = h * imgRatio;
        }
    }

    ctx.drawImage(img, -drawW / 2, -drawH / 2, drawW, drawH);
    ctx.restore();
    ctx.globalCompositeOperation = 'source-over';
}

/**
 * 渲染视频覆层 (内部)。
 * 支持导出模式 (PNG序列) 和 预览模式(<video> / <img>)
 */
function resolveVideoTime(ov, elapsed, duration, frameDuration = 0.001) {
    if (!(duration > 0)) return 0;
    const last = Math.max(0, duration - frameDuration);
    const begin = Math.min(last, Math.max(0, Number(ov.video_start_offset) || 0));
    const requestedEnd = Number(ov.video_end_offset);
    const end = requestedEnd > begin ? Math.min(duration, requestedEnd) : duration;
    const span = Math.max(frameDuration, end - begin);
    const time = Math.max(0, elapsed);
    return Math.min(last, begin + (ov.media_loop === false ? Math.min(time, Math.max(0, span - frameDuration)) : time % span));
}

function _drawVideoOverlay(ctx, ov, x, y, w, h, currentTime) {
    const videoPath = _resolveFolderMediaPath(ov, currentTime);
    if (!videoPath) return;

    const scaleX = ov.media_window_mode === 'pip' ? 1 : Math.max(0.01, parseFloat(ov.scale_x ?? ov.scale ?? 1) || 1);
    const scaleY = ov.media_window_mode === 'pip' ? 1 : Math.max(0.01, parseFloat(ov.scale_y ?? ov.scale ?? 1) || 1);
    const innerScale = Math.max(0.01, parseFloat(ov.media_inner_scale ?? 1) || 1);
    const innerRotation = parseFloat(ov.media_inner_rotation || 0);
    const flipX = ov.flip_x || false;
    const flipY = ov.flip_y || false;
    const keepAspect = ov.keep_aspect !== false || hasMediaBlurFill(ov);
    const blendMode = ov.blend_mode || 'source-over';
    
    // 相对本覆层的播放时间
    const start = parseFloat(ov.start || 0);
    const videoOffset = parseFloat(ov.video_start_offset || 0);
    let relTime = Math.max(0, currentTime - start) + videoOffset;
    // 文件夹轮换时，每条视频从自己的开头开始播放；导出预取和预览保持一致。
    if (Array.isArray(ov.media_folder_files) && ov.media_folder_files.length) {
        relTime = resolveFolderMedia(ov, currentTime).time + videoOffset;
    }

    let drawable = null;
    const isGif = videoPath ? videoPath.toLowerCase().endsWith('.gif') : false;

    if (ov.is_img_sequence && ov.sequence_frames && ov.sequence_frames.length > 0) {
        // ═══ 图像序列处理 (预览与导出通用) ═══
        const fps = ov.fps || 30;
        let frameIdx = Math.floor(relTime * fps);
        if (frameIdx >= ov.sequence_frames.length) {
            frameIdx = ov.media_loop === false ? ov.sequence_frames.length - 1 : frameIdx % ov.sequence_frames.length;
        }
        if (ov._exporting && !ov._hitTesting && ov._currentFrameImage) {
            drawable = ov._currentFrameImage;
        } else {
            drawable = _getCachedImage(ov.sequence_frames[frameIdx]);
        }
    } else if (ov._exporting && !ov._hitTesting && (ov._folderFramesByPath?.[videoPath] || ov._framesDir)) {
        // ═══ 导出模式：读取预处理的 PNG 序列 ═══
        const prepared = ov._folderFramesByPath?.[videoPath] || ov._framesDir && {
            framesDir: ov._framesDir,
            frameCount: ov._frameCount,
        };
        if (!prepared?.framesDir) return;
        const fps = 30; // 假设提取是30fps
        let frameIdx = Math.floor(relTime * fps);
        if (!ov.media_folder_files?.length) {
            frameIdx = Math.floor(resolveVideoTime(ov, Math.max(0, currentTime - start), prepared.frameCount / fps, 1 / fps) * fps + 1e-7);
        }
        if (frameIdx >= prepared.frameCount) {
            frameIdx = ov.media_loop === false ? Math.max(0, prepared.frameCount - 1) : frameIdx % Math.max(1, prepared.frameCount);
        }
        const frameName = `frame_${String(frameIdx + 1).padStart(6, '0')}.png`;
        const fPath = `${prepared.framesDir}/${frameName}`;
        if (ov._currentFrameImage) {
            drawable = ov._currentFrameImage;
        } else {
            drawable = _getCachedImage(_normalizeOverlayMediaPath(fPath)); 
        }
    } else if (ov._hitTesting && !isGif) {
        // Pick the frame actually visible in the preview, including the held
        // frame during seeks. Picking must not seek/play/mute the decoder.
        const video = _videoCache[videoPath];
        drawable = _getStablePreviewVideoFrame(video, true)
            || (video && !video.seeking && video.readyState >= 2 ? video : null);
    } else {
        // ═══ 预览模式：使用 <video> 或 GIF 解码器 ═══
        if (isGif) {
            // GIF: 使用 ImageDecoder 逐帧解码，按原始帧时长播放
            const gifData = _getGifDecoder(videoPath);
            if (gifData && gifData.ready && gifData.frameCount > 0) {
                // 计算速度倍率：ov.fps / 原始帧率，默认 1x 原速
                const nativeFps = gifData.nativeFps || 10;
                const speedMul = (ov.fps && ov.fps !== 30) ? (ov.fps / nativeFps) : 1;
                const adjustedTime = relTime * speedMul;
                const totalGifDur = gifData.totalDuration || 1;
                const loopedTime = ov.media_loop === false
                    ? Math.min(adjustedTime, Math.max(0, totalGifDur - 0.000001))
                    : adjustedTime % totalGifDur;
                // 按累计帧时长查找当前帧
                let accumulated = 0;
                let targetFrame = 0;
                for (let fi = 0; fi < gifData.frameCount; fi++) {
                    accumulated += (gifData.frameDurations[fi] || 100) / 1000;
                    if (loopedTime < accumulated) { targetFrame = fi; break; }
                    targetFrame = fi;
                }
                drawable = gifData.frames[targetFrame] || gifData.frames[0] || null;
                _ensureGifFrameDecoded(gifData, targetFrame);
            }
        } else {
            const vid = _getCachedVideo(videoPath);
            const stablePreview=!ov._exporting && window.ReelsPreviewV2?.isOpen?.();
            const previewPlaying=stablePreview && window.ReelsPreviewV2.isPlaying?.();
            const heldFrame=stablePreview ? _getStablePreviewVideoFrame(vid,!previewPlaying) : null;
            if(heldFrame)drawable=heldFrame;
            if (vid && vid.readyState >= 2) {
                drawable = previewPlaying && !vid.seeking ? vid : heldFrame || vid;
                // 预览与复合片段共用同一个开关：默认静音，明确开启后才让
                // 视频媒体覆层播放原声。导出帧渲染始终不发声。
                const sourceBegin = Math.max(0, Number(ov.video_start_offset) || 0);
                const sourceEnd = Number(ov.video_end_offset) > sourceBegin
                    ? Math.min(vid.duration || Infinity, Number(ov.video_end_offset)) : vid.duration;
                const sourceFinished = ov.media_loop === false && !ov.media_folder_files?.length
                    && currentTime - start >= sourceEnd - sourceBegin;
                const shouldPlayAudio = ov.media_audio_enabled === true && !sourceFinished && !ov._exporting && !window.__reelsOverviewMuted;
                if (vid.muted === shouldPlayAudio) {
                    vid.muted = !shouldPlayAudio;
                    if (shouldPlayAudio) {
                        vid.volume = 1;
                        vid.play().catch(() => {});
                    }
                }
                const d = vid.duration || 1;
                let targetTime = ov.media_folder_files?.length
                    ? (ov.media_loop === false ? Math.min(relTime, Math.max(0, d - 0.001)) : relTime % d)
                    : resolveVideoTime(ov, Math.max(0, currentTime - start), d);

                // 检测主时间轴是否在推进（预览是否正在播放）。状态必须保存在
                // 真正长期存在的 video 元素上；独立预览会为每帧创建 ov 浅拷贝，
                // 存在 ov 上会每帧丢失，造成暂停画面反复 play/seek 而无法解码。
                const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
                const prevMasterTime = Number(vid._reelsLastMasterTime);
                const prevWallTime = Number(vid._reelsLastWallTime);
                const hasPreviousSample = Number.isFinite(prevMasterTime) && Number.isFinite(prevWallTime);
                const wallDelta = hasPreviousSample ? nowMs - prevWallTime : Infinity;
                const masterDelta = hasPreviousSample ? currentTime - prevMasterTime : 0;
                const explicitPlaying = !ov._exporting && window.ReelsPreviewV2?.isOpen?.()
                    ? window.ReelsPreviewV2.isPlaying?.() : undefined;
                if(typeof explicitPlaying==='boolean'){
                    const speed=window.ReelsPreviewV2.getPlaybackSpeed?.() || 1;
                    if(Math.abs(vid.playbackRate-speed)>.001)vid.playbackRate=speed;
                }
                const timeAdvancing = typeof explicitPlaying==='boolean' ? explicitPlaying : hasPreviousSample
                    && wallDelta >= 0 && wallDelta < 500
                    && masterDelta > 0.0005;
                vid._reelsLastMasterTime = currentTime;
                vid._reelsLastWallTime = nowMs;
                vid._reelsLastPreviewTime = relTime;

                if (!timeAdvancing || sourceFinished) {
                    // 预览暂停中 → 暂停覆层视频，seek 到目标帧
                    if (!vid.paused) vid.pause();
                    if (!vid.seeking && Math.abs(vid.currentTime - targetTime) > 0.05) {
                        vid.currentTime = targetTime;
                    }
                } else {
                    // 预览播放中 → 让视频自由播放，仅在大跳转时 seek
                    if (vid.paused && document.visibilityState === 'visible') {
                        if (!vid.seeking && Math.abs(vid.currentTime-targetTime)>.05) vid.currentTime = targetTime;
                        vid.play().catch(e => {});
                    } else if (!vid.seeking && Math.abs(vid.currentTime - targetTime) > 0.5) {
                        // 大的时间跳转（用户拖动进度条等）
                        vid.currentTime = targetTime;
                    }
                }
            }
        }
    }

    if (!drawable) {
        if (_videoCache[videoPath]?.error || _imageCache[videoPath] === _IMAGE_FAILED) {
            _drawMissingMediaPlaceholder(ctx, ov, x, y, w, h);
        }
        return;
    }
    // 失败的 GIF/视频加载偶尔会留下非 CanvasImageSource 的占位对象；
    // 缩略图渲染必须直接跳过，不能把它传给 drawImage。
    const sourceW = Number(drawable.naturalWidth || drawable.videoWidth || drawable.width || 0);
    const sourceH = Number(drawable.naturalHeight || drawable.videoHeight || drawable.height || 0);
    if (!(sourceW > 0 && sourceH > 0)) return;

    ctx.globalCompositeOperation = blendMode;
    ctx.save();
    ctx.translate(x + w / 2, y + h / 2);
    if (innerRotation) ctx.rotate(innerRotation * Math.PI / 180);
    ctx.scale(flipX ? -scaleX * innerScale : scaleX * innerScale, flipY ? -scaleY * innerScale : scaleY * innerScale);

    let drawW = w, drawH = h;
    if (keepAspect) {
        const srcW = sourceW;
        const srcH = sourceH;
        const imgRatio = sourceW / sourceH;
        const boxRatio = w / h;
        if (ov.crop_fill && !hasMediaBlurFill(ov)) {
            // cover：填满固定窗口，多出的边缘交给 clip_rect 裁掉。
            if (imgRatio > boxRatio) {
                drawH = h;
                drawW = h * imgRatio;
            } else {
                drawW = w;
                drawH = w / imgRatio;
            }
        } else if (imgRatio > boxRatio) {
            drawH = w / imgRatio;
        } else {
            drawW = h * imgRatio;
        }
    }

    try {
        ctx.drawImage(drawable, -drawW / 2, -drawH / 2, drawW, drawH);
    } catch (_) {
        // 资源在浏览器解码阶段失效时安全跳过本帧。
    }
    ctx.restore();
    ctx.globalCompositeOperation = 'source-over';
}


/**
 * 渲染文本覆层 (内部)。
 * 完整移植自 FrameRenderer.draw_single_overlay (text 分支)
 */
// Search both up and down. The upper glyph-size bound makes the range finite;
// a fractional numeric floor is only for Canvas stability, not a user minimum.
const _titleFontFitCache = new WeakMap();
let _titleFontFitRevision = 0;
if (typeof document !== 'undefined' && document.fonts?.addEventListener) {
    document.fonts.addEventListener('loadingdone', () => { _titleFontFitRevision++; });
    document.fonts.addEventListener('loadingerror', () => { _titleFontFitRevision++; });
}

function _cachedTitleFontFit(owner, ov, dimensions, fits, seed) {
    const typography = {};
    for (const key of Object.keys(ov)) {
        if (key.startsWith('title_') || key.startsWith('text_') || key.startsWith('auto_color_') ||
            key === 'independent_effects' || key === '_original_title_text') typography[key] = ov[key];
    }
    const key = JSON.stringify([_titleFontFitRevision, dimensions, typography]);
    const cached = _titleFontFitCache.get(owner);
    if (cached?.key === key) return cached.size;
    const size = _findLargestTitleFont(fits, seed);
    _titleFontFitCache.set(owner, { key, size });
    return size;
}

const _adaptiveTitleCache = new WeakMap();
const _adaptiveTitleFrames = new WeakMap();

// Dynamic title frames favor a preferred visual size, then tighten their width
// without adding lines. Font size is reduced only when the largest frame fails.
function _layoutAdaptiveTitle(ctx, ov, owner, availableW, availableH, sideBySide = false) {
    const typography = {};
    for (const key of Object.keys(ov)) {
        if (key.startsWith('title_') || key.startsWith('text_') || key.startsWith('auto_color_') ||
            ['independent_effects', 'card_enabled', '_original_title_text'].includes(key)) typography[key] = ov[key];
    }
    const signature = JSON.stringify([_titleFontFitRevision, availableW, availableH, sideBySide, typography]);
    const cached = _adaptiveTitleCache.get(owner);
    if (cached?.signature === signature) return cached.layout;
    const positive = (value, fallback) => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
    const maxW = Math.max(1, Math.min(positive(ov.title_adaptive_max_w, 1080), availableW));
    const maxH = Math.max(1, Math.min(positive(ov.title_adaptive_max_h, 300), availableH));
    const maxLines = Math.max(1, Math.min(10, parseInt(ov.title_adaptive_max_lines, 10) || 3));
    const minW = Math.min(maxW, positive(ov.title_adaptive_min_w, 1080));
    const minH = Math.min(maxH, positive(ov.title_adaptive_min_h, 200));
    const glyphLimit = Math.min(positive(ov.title_preferred_glyph_height, 45), positive(ov.title_max_glyph_height, 60));
    const original = String(ov._original_title_text ?? ov.title_text ?? '').replace(/[\r\n]/g, ' ');
    const text = ov.title_uppercase !== false ? original.toUpperCase() : original;
    const family = ov.title_font_family || 'Crimson Pro';
    const fallback = _resolveOverlayFallback(family);
    const weight = _resolveOverlayFontWeight(ov.title_font_weight, ov.title_bold ? 900 : 400);
    const italic = ov.title_italic ? 'italic' : 'normal';
    const referenceSize = positive(ov.title_fontsize, 60);
    const autoOv = { ...ov, title_auto_shrink: true };
    const effects = ov.independent_effects ? 'title' : 'text';
    const stroke = Math.max(0, Number(ov[effects + '_stroke_width']) || 0) / 2;
    const blur = Math.max(0, Number(ov[effects + '_shadow_blur']) || 0);
    const shadowX = Number(ov[effects + '_shadow_x']) || 0;
    const shadowY = Number(ov[effects + '_shadow_y']) || 0;
    const hasBg = ov.independent_effects && ov.title_bg_enabled;
    function measure(size, width) {
        const ranges = sideBySide ? [] : _getTitleLayoutRanges(autoOv, text, size);
        const actualSize = _getMaxFontSizeFromRanges(size, ranges);
        ctx.font = `${italic} ${_getMaxFontWeightFromRanges(weight, ranges)} ${actualSize}px "${family}", ${fallback}`;
        ctx.letterSpacing = `${ov.title_letter_spacing || 0}px`;
        const padH = sideBySide ? (ov.title_bg_pad_h ?? Math.max(20, Math.round(size * 0.55))) :
            (hasBg ? (ov.title_bg_pad_h ?? Math.max(14, Math.round(actualSize * 0.25))) : 0);
        const extH = !sideBySide && hasBg ? Math.max(stroke, blur + Math.max(0, -shadowX)) + Math.max(stroke, blur + Math.max(0, shadowX)) : 0;
        const contentW = Math.max(0.01, width - 2 * padH - extH);
        const lines = text.trim() ? _wrapText(ctx, text, contentW) : [];
        let glyphH = 0, widest = 0, ascent = 0, descent = 0;
        for (const line of lines) {
            const metrics = ctx.measureText(line);
            const asc = Number.isFinite(metrics.actualBoundingBoxAscent) ? Math.max(0, metrics.actualBoundingBoxAscent) : actualSize * 0.8;
            const desc = Number.isFinite(metrics.actualBoundingBoxDescent) ? Math.max(0, metrics.actualBoundingBoxDescent) : actualSize * 0.2;
            glyphH = Math.max(glyphH, asc + desc);
            ascent = Math.max(ascent, asc);
            descent = Math.max(descent, desc);
            widest = Math.max(widest, metrics.width, (metrics.actualBoundingBoxLeft || 0) + (metrics.actualBoundingBoxRight || 0));
        }
        ctx.letterSpacing = '0px';
        if (!sideBySide && lines.length) {
            const stdDesc = ctx.measureText('pjyqg,').actualBoundingBoxDescent;
            descent = Math.max(descent, stdDesc > 0 ? stdDesc : Math.round(actualSize * 0.22));
            if (ascent <= 0) ascent = Math.round(actualSize * 0.8);
        }
        const lineH = Math.max(actualSize * 0.2, actualSize * 1.3 + Number(ov.title_line_spacing || 0) * Math.min(1, size / referenceSize));
        const autoPad = sideBySide ? Math.max(12, Math.round(size * 0.35)) : Math.max(12, Math.round(actualSize * 0.2));
        const padT = sideBySide || hasBg ? (ov.title_bg_pad_top ?? autoPad) : 0;
        const padB = sideBySide || hasBg ? (ov.title_bg_pad_bottom ?? autoPad) : 0;
        const extV = !sideBySide && hasBg ? Math.max(stroke, blur + Math.max(0, -shadowY)) + Math.max(stroke, blur + Math.max(0, shadowY)) : 0;
        const height = lines.length ? ascent + descent + (lines.length - 1) * lineH + padT + padB + extV : 0;
        return { lines: lines.length, glyphH, height, contentW, fits: widest <= contentW && height <= maxH && glyphH <= glyphLimit && lines.length <= maxLines };
    }
    ctx.save();
    ctx.textBaseline = 'alphabetic';
    try {
        const fontSize = text.trim() ? _findLargestTitleFont(size => measure(size, maxW).fits, glyphLimit) : referenceSize;
        const atMax = measure(fontSize, maxW);
        const targetLines = atMax.lines;
        let low = minW, high = maxW;
        for (let i = 0; i < 20 && high - low > 0.1; i++) {
            const middle = (low + high) / 2;
            const result = measure(fontSize, middle);
            if (result.fits && result.lines <= targetLines) high = middle;
            else low = middle;
        }
        // Small rounding margin prevents a boundary word from wrapping in draw.
        const width = Math.min(maxW, Math.max(minW, high + 0.1));
        const measured = measure(fontSize, width);
        const layout = { fontSize, width, height: Math.min(maxH, Math.max(minH, measured.height)), contentW: measured.contentW, lines: measured.lines, glyphH: measured.glyphH, minW, minH, maxW, maxH };
        _adaptiveTitleCache.set(owner, { signature, layout });
        return layout;
    } finally {
        ctx.restore();
    }
}

// Preview-only geometry is kept outside project data and never serialized.
function _measureTitleGlyphGuide(ctx, lines, firstBaseline, lineHeight, font, boxX, boxW, align) {
    ctx.save();
    ctx.font = font;
    let guide = null;
    for (let i = 0; i < lines.length; i++) {
        const metrics = ctx.measureText(lines[i]);
        const ascent = Math.max(0, Number(metrics.actualBoundingBoxAscent) || 0);
        const descent = Math.max(0, Number(metrics.actualBoundingBoxDescent) || 0);
        const height = ascent + descent;
        if (height > (guide?.height || 0)) {
            guide = { x: _alignX(ctx, lines[i], boxX, boxW, align),
                y: firstBaseline + i * lineHeight - ascent, width: metrics.width, height };
        }
    }
    ctx.restore();
    return guide;
}

function _drawAdaptiveTitleGuides(ctx, frame, unit = 2) {
    ctx.save();
    ctx.globalAlpha = 0.95;
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.lineWidth = unit;
    const cx = frame.x + frame.width / 2, cy = frame.y + frame.height / 2;
    for (const [width, height, color, dash] of [
        [frame.maxW, frame.maxH, '#60a5fa', [5 * unit, 3 * unit]],
        [frame.minW, frame.minH, '#fbbf24', [2 * unit, 3 * unit]],
        [frame.width, frame.height, '#4ade80', []],
    ]) {
        ctx.strokeStyle = color;
        ctx.setLineDash(dash);
        ctx.strokeRect(cx - width / 2, cy - height / 2, width, height);
    }
    ctx.setLineDash([]);
    ctx.strokeStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(cx - 4 * unit, cy); ctx.lineTo(cx + 4 * unit, cy);
    ctx.moveTo(cx, cy - 4 * unit); ctx.lineTo(cx, cy + 4 * unit);
    ctx.stroke();
    const glyph = frame.glyphBounds;
    if (glyph?.height > 0) {
        const gx = Math.max(frame.x + 4 * unit, glyph.x - 8 * unit);
        const top = glyph.y, bottom = glyph.y + glyph.height;
        ctx.strokeStyle = '#e879f9';
        ctx.fillStyle = '#e879f9';
        ctx.lineWidth = unit;
        ctx.beginPath();
        ctx.moveTo(gx, top); ctx.lineTo(gx, bottom);
        ctx.moveTo(gx - 3 * unit, top); ctx.lineTo(gx + 3 * unit, top);
        ctx.moveTo(gx - 3 * unit, bottom); ctx.lineTo(gx + 3 * unit, bottom);
        ctx.stroke();
        ctx.font = `${9 * unit}px sans-serif`;
        ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
        ctx.fillText(`字形高 ${glyph.height.toFixed(1)}px`, gx + 5 * unit, top - 3 * unit);
    }
    ctx.restore();
}

function _recordAdaptiveTitleFrame(ctx, owner, ov, rect, glyphH, lines, canvasW) {
    if (!ov._titleAdaptiveLayout) return;
    const layout = ov._titleAdaptiveLayout;
    const frame = { ...layout, ...rect, glyphH, lines };
    _adaptiveTitleFrames.set(owner, frame);
    if (!ov._exporting && ov._selected) _drawAdaptiveTitleGuides(ctx, frame, Math.max(1.5, canvasW / 540));
}

// Draws the actual title renderer into a focused panel preview, then overlays
// its measured limits. It shares all wrapping/font-fitting code with export.
function drawAdaptiveTitlePreview(ctx, overlay, width, height) {
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#111827'; ctx.fillRect(0, 0, width, height);
    if (overlay.title_adaptive_enabled !== true) return null;
    const ov = { ...overlay, _selected: false, _exporting: true, title_rotation: 0,
        title_text: overlay._original_title_text ?? overlay.title_text ?? '',
        body_text: '', footer_text: '', _original_body_text: '', _original_footer_text: '',
        debug_layout: false, debug_title: false, debug_body: false, debug_footer: false,
        card_blur_enabled: false, card_border_enabled: false, fullscreen_mask: false,
        anim_in_type: 'none', anim_out_type: 'none' };
    const cardW = Math.max(1, Number(ov.w) || 910), cardH = Math.max(1, Number(ov.h) || 1300);
    ctx.save();
    ctx.globalAlpha = 0;
    _drawTextCardOverlay(ctx, ov, 0, 0, cardW, cardH, 1080, 1920, 0);
    ctx.restore();
    const frame = _adaptiveTitleFrames.get(ov);
    if (!frame) return null;
    const scale = Math.min((width - 28) / Math.max(1, frame.maxW), (height - 28) / Math.max(1, frame.maxH));
    ctx.save();
    ctx.translate(width / 2, height / 2);
    ctx.scale(scale, scale);
    ctx.translate(-frame.x - frame.width / 2, -frame.y - frame.height / 2);
    _drawTextCardOverlay(ctx, ov, 0, 0, cardW, cardH, 1080, 1920, 0);
    _drawAdaptiveTitleGuides(ctx, frame, 1.3 / scale);
    ctx.restore();
    return frame;
}

function _findLargestTitleFont(fits, seed = 80) {
    let low = 0.01;
    let high = Math.max(1, Number(seed) || 80);
    while (high < 16384 && fits(high)) { low = high; high *= 2; }
    for (let i = 0; i < 24 && high - low > 0.01; i++) {
        const mid = (low + high) / 2;
        if (fits(mid)) low = mid;
        else high = mid;
    }
    return low;
}

function _getTitleLayoutRanges(ov, text, fontSize) {
    const ranges = _getAutoColorMergedRanges(ov, 'title', text) || ov.title_styled_ranges || [];
    if (!ov.title_auto_shrink) return ranges;
    const scale = fontSize / Math.max(1, Number(ov.title_fontsize) || 60);
    return ranges.map(range => range.fontsize > 0 ? { ...range, fontsize: range.fontsize * scale } : range);
}

function _getMaxFontSizeFromRanges(baseSize, ranges) {
    if (!ranges || ranges.length === 0) return baseSize;
    let max = baseSize;
    for (const r of ranges) {
        if (r && r.fontsize && r.fontsize > max) {
            max = r.fontsize;
        }
    }
    return max;
}

// A bold rich-text fragment is wider than the section's normal font.  Layout
// must reserve that width, otherwise a colored emphasis word can escape its box.
function _getMaxFontWeightFromRanges(baseWeight, ranges) {
    let max = Number(baseWeight) || 400;
    for (const r of (ranges || [])) {
        if (r && r.bold) max = Math.max(max, 700);
    }
    return max;
}

// Scope compensation to this layer's text, including off-screen feather canvases.
// Never patch Canvas prototypes or change fonts on other layers.
const _overlayBoldContexts = new WeakSet();
function _withOverlaySyntheticBold(ctx, ov, draw) {
    const compensate=typeof window!=='undefined' ? window.ReelsSubtitleUpgrade?.withBoldContext : null;
    if(ov?.synthetic_bold_enabled!==true || !compensate || _overlayBoldContexts.has(ctx))return draw();
    _overlayBoldContexts.add(ctx);
    try {return compensate(ctx,true,draw);}
    finally {_overlayBoldContexts.delete(ctx);}
}

function _drawTextOverlay(ctx, ov, x, y, w, h, currentTime) {
    return _withOverlaySyntheticBold(ctx, ov, () => _drawTextOverlayCore(ctx, ov, x, y, w, h, currentTime));
}

function _drawTextOverlayCore(ctx, ov, x, y, w, h, currentTime) {
    const content = ov.content || '';
    if (!content) return;
    ctx.direction = (typeof ReelsTextDirection !== 'undefined')
        ? ReelsTextDirection.resolve(ov.text_direction, content)
        : 'ltr';

    const layout = ov.text_layout || {};
    const padL = layout.left_pad || 10;
    const padR = layout.right_pad || 10;
    const padT = layout.top_pad || 10;
    const padB = layout.bottom_pad || 10;
    let lineSpacing = layout.line_spacing || 0;
    const align = layout.align || 'center';

    const boxX = x + padL;
    const boxY = y + padT;
    const boxW = Math.max(1, w - padL - padR);
    const boxH = Math.max(1, h - padT - padB);

    let fontSize = ov.fontsize || 40;
    const fontFamily = ov.font_family || 'Arial';
    const fontWeight = _resolveOverlayFontWeight(ov.font_weight, ov.bold ? 700 : 400);
    const italic = ov.italic ? 'italic' : 'normal';
    const fallbackFamily = _resolveOverlayFallback(fontFamily);
    let fontStr = `${italic} ${fontWeight} ${fontSize}px "${fontFamily}", ${fallbackFamily}`;
    ctx.font = fontStr;

    // 自动换行
    let lines = _wrapText(ctx, content, boxW);
    let lineHeight = fontSize * 1.3 + lineSpacing;
    if(ov.title_frame_enabled && (lines.length*lineHeight>boxH || lines.some(line=>ctx.measureText(line).width>boxW))){
        const originalSize=fontSize,originalSpacing=lineSpacing;
        let low=.01,high=fontSize;
        for(let i=0;i<18 && high-low>.01;i++){
            const size=(low+high)/2;
            ctx.font=`${italic} ${fontWeight} ${size}px "${fontFamily}", ${fallbackFamily}`;
            const wrapped=_wrapText(ctx,content,boxW),height=size*1.3+originalSpacing*size/originalSize;
            if(wrapped.length*height<=boxH && wrapped.every(line=>ctx.measureText(line).width<=boxW))low=size;else high=size;
        }
        fontSize=low;lineSpacing=originalSpacing*fontSize/originalSize;
        fontStr=`${italic} ${fontWeight} ${fontSize}px "${fontFamily}", ${fallbackFamily}`;ctx.font=fontStr;
        lines=_wrapText(ctx,content,boxW);lineHeight=fontSize*1.3+lineSpacing;
    }

    // 入/出场动画已由 drawOverlay() 统一处理，此处不再重复

    // ── 背景框 ──
    if (ov.bg_enabled) {
        const bgAlpha = (ov.bg_opacity || 191) / 255;
        const totalH = lines.length * lineHeight;
        const pad = ov.bg_padding || 12;
        const rad = ov.bg_radius || 12;

        ctx.save();
        ctx.globalAlpha = bgAlpha * ctx.globalAlpha;
        ctx.fillStyle = ov.bg_color || '#000000';
        _roundRect(ctx, boxX - pad, boxY - pad, boxW + pad * 2, totalH + pad * 2, rad);
        ctx.fill();
        ctx.restore();
    }

    // ── 阴影 ──
    if (ov.shadow_enabled) {
        ctx.save();
        // 0 是有效设置（无偏移/完全透明），不能用 || 把它回退成默认值。
        const sx = parseFloat(ov.shadow_offset_x ?? 4);
        const sy = parseFloat(ov.shadow_offset_y ?? 4);
        const blur = parseFloat(ov.shadow_blur ?? 4);
        const shadowAlpha = (ov.shadow_opacity ?? 120) / 255;

        ctx.shadowColor = _withAlpha(ov.shadow_color || '#000000', shadowAlpha);
        ctx.shadowBlur = blur;
        ctx.shadowOffsetX = sx;
        ctx.shadowOffsetY = sy;

        _drawTextLines(ctx, lines, boxX, boxY, boxW, lineHeight, align, ov.color || '#FFFFFF');
        ctx.restore();
    }

    // ── 描边 ──
    if (ov.use_stroke) {
        ctx.save();
        ctx.strokeStyle = ov.stroke_color || '#000000';
        ctx.lineWidth = parseFloat(ov.stroke_width ?? 2) * 2;
        ctx.lineJoin = 'round';
        ctx.miterLimit = 2;

        let yc = boxY + fontSize;
        for (const line of lines) {
            const lx = _alignX(ctx, line, boxX, boxW, align);
            ctx.strokeText(line, lx, yc);
            yc += lineHeight;
        }
        ctx.restore();
    }

    // ── 文字填充 ──
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    _drawTextLines(ctx, lines, boxX, boxY, boxW, lineHeight, align, ov.color || '#FFFFFF');
}

// ═══════════════════════════════════════════════════════
// 2b. Text Card Overlay Renderer
// ═══════════════════════════════════════════════════════

/**
 * 渲染文字卡片覆层。
 * 功能：半透明纯色背景 + 四角独立圆角 + 标题（粗体大字）+ 内容（正常字体）
 * 自动适配：根据文案长短调整蒙版大小和位置
 */
function _drawTextCardOverlay(ctx, ov, x, y, w, h, canvasW, canvasH, currentTime) {
    return _withOverlaySyntheticBold(ctx, ov, () => _drawTextCardOverlayCore(ctx, ov, x, y, w, h, canvasW, canvasH, currentTime));
}

function _drawTextCardOverlayCore(ctx, ov, x, y, w, h, canvasW, canvasH, currentTime) {
    const directionSample = [ov.title_text, ov.body_text, ov.footer_text].filter(Boolean).join('\n');
    ctx.direction = (typeof ReelsTextDirection !== 'undefined')
        ? ReelsTextDirection.resolve(ov.text_direction, directionSample)
        : 'ltr';
    const originalOverlay = ov;
    const guideLineW = Math.max(2, canvasW / 540);
    if (ov.body_follow_title) {
        const indep = ov.independent_effects;
        const strokeC = (indep ? ov.title_stroke_color : ov.text_stroke_color) || '#000000';
        const strokeW = (indep ? ov.title_stroke_width : ov.text_stroke_width) ?? 0;
        const shadowC = (indep ? ov.title_shadow_color : ov.text_shadow_color) || '#000000';
        const shadowBlur = (indep ? ov.title_shadow_blur : ov.text_shadow_blur) ?? 0;
        const shadowX = (indep ? ov.title_shadow_x : ov.text_shadow_x) ?? 0;
        const shadowY = (indep ? ov.title_shadow_y : ov.text_shadow_y) ?? 0;

        ov = Object.assign({}, ov, {
            body_font_family: ov.title_font_family,
            body_fontsize: ov.title_fontsize,
            body_font_weight: ov.title_font_weight,
            body_bold: ov.title_bold,
            body_italic: ov.title_italic,
            body_color: ov.title_color,
            body_letter_spacing: ov.title_letter_spacing,
            body_line_spacing: ov.title_line_spacing,
            
            body_stroke_color: strokeC,
            body_stroke_width: strokeW,
            body_shadow_color: shadowC,
            body_shadow_blur: shadowBlur,
            body_shadow_x: shadowX,
            body_shadow_y: shadowY,

            title_stroke_color: strokeC,
            title_stroke_width: strokeW,
            title_shadow_color: shadowC,
            title_shadow_blur: shadowBlur,
            title_shadow_x: shadowX,
            title_shadow_y: shadowY,

            body_bg_enabled: ov.title_bg_enabled,
            body_bg_mode: ov.title_bg_mode,
            body_bg_color: ov.title_bg_color,
            body_bg_opacity: ov.title_bg_opacity,
            body_bg_radius: ov.title_bg_radius,
            body_bg_concave_radius: ov.title_bg_concave_radius,
            body_bg_snap_threshold: ov.title_bg_snap_threshold,
            body_bg_pad_h: ov.title_bg_pad_h,
            body_bg_pad_top: ov.title_bg_pad_top,
            body_bg_pad_bottom: ov.title_bg_pad_bottom,
            body_bg_border_enabled: ov.title_bg_border_enabled,
            body_bg_border_color: ov.title_bg_border_color,
            body_bg_border_width: ov.title_bg_border_width,
            body_bg_border_style: ov.title_bg_border_style,
            body_bg_border_opacity: ov.title_bg_border_opacity,


            independent_effects: true
        });
    }
    // The new master switch owns title automation. Ignore stale legacy flags
    // once a card has the explicit switch (old projects can still be read).
    if (ov.title_adaptive_enabled === false && ov.title_auto_shrink) ov = { ...ov, title_auto_shrink: false };
    if (ov.title_adaptive_enabled === true) {
        const side = ov.layout_mode === 'side_by_side';
        const fit = ov.auto_fit === true || ov.auto_fit === 1 || ov.auto_fit === '1';
        const padL = side || fit ? (ov.padding_left ?? 40) : 0;
        const padR = side || fit ? (ov.padding_right ?? 40) : 0;
        // Title bounds are independent of the card/mask dimensions and padding.
        // Only a real side-by-side column retains its own layout constraint.
        const availableW = side ? Math.max(1, w - padL - padR - (ov.side_by_side_gap ?? ov.title_body_gap ?? 80)) * Math.max(10, Math.min(90, ov.side_by_side_title_ratio ?? 50)) / 100 : Math.max(1, ov.title_frame_enabled ? w : canvasW);
        const layout = _layoutAdaptiveTitle(ctx, ov, originalOverlay, availableW, Math.max(1, ov.title_frame_enabled ? h : canvasH), side);
        ov = { ...ov, title_auto_shrink: true, title_override_w: layout.contentW, title_override_h: layout.height,
            title_text: String(ov.title_text || '').replace(/[\r\n]/g, ' '),
            _titleAdaptiveLayout: layout,
            title_valign: 'center',
            _titleAdaptiveCenterY: (ov.auto_center_v ? canvasH / 2 : y + h / 2) + Number(ov.offset_y || 0) + Number(ov.title_offset_y || 0),
            _titleAdaptiveAnchorH: h };
        // A title-only card's global background is part of the same title frame.
        // It must not retain the old, tall manual card rectangle behind the text.
        if (!side && !String(ov._original_body_text ?? ov.body_text ?? '').trim() && !String(ov._original_footer_text ?? ov.footer_text ?? '').trim() && !ov.fullscreen_mask) {
            const centerX = x + w / 2 + Number(ov.offset_x || 0) + Number(ov.title_offset_x || 0);
            x = centerX - layout.width / 2;
            y = ov._titleAdaptiveCenterY - layout.height / 2;
            w = layout.width;
            h = layout.height;
            ov = { ...ov, auto_fit: false, auto_center_v: false, auto_shrink: false,
                offset_x: 0, offset_y: 0, title_offset_x: 0, title_offset_y: 0 };
        }
        if (ov._original_title_text !== undefined) ov._original_title_text = String(ov._original_title_text || '').replace(/[\r\n]/g, ' ');
        if (ov.title_bg_mode === 'block-fit') ov.title_bg_mode = 'block';
    }
    if (ov !== originalOverlay) ov._sideBySideCacheOwner = originalOverlay;

    if (ov.layout_mode === 'side_by_side') {
        _drawTextCardSideBySideOverlay(ctx, ov, x, y, w, h, canvasW, canvasH);
        if (ov._titleAdaptiveLayout) {
            originalOverlay._renderedH = ov._renderedH;
            originalOverlay._renderedY = ov._renderedY;
        }
        return;
    }
    // 注意：auto_center_v 仅控制垂直居中，不应改动 X（避免手动 X 被每帧覆盖）
    
    // 关键修正：必须明确指定为 alphabetic，否则由于上层可能污染 ctx.textBaseline='top'
    // 会导致 actualBoundingBoxAscent 计算为负数，触发 fallback（0.8 * fontSize）
    // 进而使 ty = topY + 0.8*fontSize 形成视觉上的“多出一个空行”。
    ctx.textBaseline = 'alphabetic';

    const useAutoFit = (ov.auto_fit === true || ov.auto_fit === 1 || ov.auto_fit === '1');
    const useAutoCenterV = (ov.auto_center_v === true || ov.auto_center_v === 1 || ov.auto_center_v === '1');
    const useAutoShrink = useAutoFit && (ov.auto_shrink === true);

    // 自动适配开：使用边距；自动适配关：边距一律归0（全充实）
    const padL = useAutoFit ? (ov.padding_left ?? 40) : 0;
    const padR = useAutoFit ? (ov.padding_right ?? 40) : 0;
    const padT = useAutoFit ? (ov.padding_top ?? 60) : 0;
    const padB = useAutoFit ? (ov.padding_bottom ?? 60) : 0;
    
    const minFont = ov.min_fontsize ?? 16;
    const maxH = ov.max_height ?? 1400;
    const titleMaxLines = ov.title_max_lines ?? 3;
    const doShrink = useAutoShrink && maxH > 0;
    const gap = ov.title_body_gap ?? 42;
    const gapFooter = ov.body_footer_gap ?? 42;
    const offsetX = parseFloat(ov.offset_x || 0);

    const contentW = Math.max(1, w - padL - padR);

    // ── 测量所使用的原始文本 (避免时间切片导致高度塌陷与抖动) ──
    const measureTitleText = ov._original_title_text !== undefined ? (ov.title_uppercase ? (ov._original_title_text || '').toUpperCase() : (ov._original_title_text || '')) : (ov.title_uppercase ? (ov.title_text || '').toUpperCase() : (ov.title_text || ''));
    const measureBodyText = ov._original_body_text !== undefined ? (ov._original_body_text || '') : (ov.body_text || '');
    const measureFooterText = ov._original_footer_text !== undefined ? (ov._original_footer_text || '') : (ov.footer_text || '');

    // ── 原始字号 ──
    const titleText = ov.title_uppercase ? (ov.title_text || '').toUpperCase() : (ov.title_text || '');
    let titleFontSize = ov.title_fontsize ?? 60;
    const titleWeight = _resolveOverlayFontWeight(ov.title_font_weight, ov.title_bold ? 900 : 400);
    const titleItalic = ov.title_italic ? 'italic' : 'normal';
    const titleFamily = ov.title_font_family || 'Crimson Pro';
    const titleFallback = _resolveOverlayFallback(titleFamily);

    const bodyText = ov.body_text || '';
    let bodyFontSize = ov.body_fontsize ?? 40;
    const bodyWeight = _resolveOverlayFontWeight(ov.body_font_weight, ov.body_bold ? 700 : 400);
    const bodyItalic = ov.body_italic ? 'italic' : 'normal';
    const bodyFamily = ov.body_font_family || 'Arial';
    const bodyFallback = _resolveOverlayFallback(bodyFamily);

    const footerText = ov.footer_text || '';
    let footerFontSize = ov.footer_fontsize ?? 32;
    const footerWeight = _resolveOverlayFontWeight(ov.footer_font_weight, ov.footer_bold ? 700 : 400);
    const footerItalic = ov.footer_italic ? 'italic' : 'normal';
    const footerFamily = ov.footer_font_family || 'Arial';
    const footerFallback = _resolveOverlayFallback(footerFamily);

    // Text effects — resolve per-section when independent mode
    const indep = ov.independent_effects;

    // Shared (fallback) values
    const _shStrokeW = ov.text_stroke_width ?? 0;
    const _shStrokeC = ov.text_stroke_color || '#000000';
    const _shShadowBlur = ov.text_shadow_blur ?? 0;
    const _shShadowColor = ov.text_shadow_color || '#000000';
    const _shShadowX = ov.text_shadow_x ?? 0;
    const _shShadowY = ov.text_shadow_y ?? 0;

    function _resolveEffects(prefix) {
        if (!indep) return {
            strokeW: _shStrokeW, strokeC: _shStrokeC,
            shadowBlur: _shShadowBlur, shadowColor: _shShadowColor,
            shadowX: _shShadowX, shadowY: _shShadowY,
        };
        return {
            strokeW: ov[prefix + '_stroke_width'] ?? _shStrokeW,
            strokeC: ov[prefix + '_stroke_color'] || _shStrokeC,
            shadowBlur: ov[prefix + '_shadow_blur'] ?? _shShadowBlur,
            shadowColor: ov[prefix + '_shadow_color'] || _shShadowColor,
            shadowX: ov[prefix + '_shadow_x'] ?? _shShadowX,
            shadowY: ov[prefix + '_shadow_y'] ?? _shShadowY,
        };
    }



    function _fontMetrics(font, testStr = 'H国T', fontSize = 40, descentText = null) {
        ctx.font = font;
        const sample = ctx.measureText(testStr);
        let asc = Number(sample.actualBoundingBoxAscent);
        if (!Number.isFinite(asc) || asc <= 0) asc = Math.round(fontSize * 0.8);
        
        // 视觉光学平衡：即使文本没有下沉字母（如 p,y,j），排版上如果下底线紧贴英文基线，
        // 人眼会因为缺少“行高预留的安全区”而感觉整个文字块“偏上”。
        // 所以我们需要保证至少有一个标准的下沉空间（约字号的 20% - 25%）。
        let stdDesc = Number(ctx.measureText('pjyqg,').actualBoundingBoxDescent);
        if (!Number.isFinite(stdDesc) || stdDesc <= 0) stdDesc = Math.round(fontSize * 0.22);
        
        let desc = stdDesc; 
        if (descentText) {
            const mLine = ctx.measureText(descentText);
            const rawDesc = Number(mLine.actualBoundingBoxDescent);
            if (Number.isFinite(rawDesc) && rawDesc > 0) {
                desc = Math.max(stdDesc, rawDesc);
            }
        }
        return { ascent: asc, descent: desc };
    }

    function _getSectionExtents(prefix, fontSize) {
        if (!indep || !ov[prefix + '_bg_enabled']) return { padT: 0, padB: 0, extTop: 0, extBot: 0 };
        const fx = _resolveEffects(prefix);
        const autoPad = Math.max(12, Math.round(fontSize * 0.2));
        const pT = ov[prefix + '_bg_pad_top'] !== undefined ? ov[prefix + '_bg_pad_top'] : autoPad;
        const pB = ov[prefix + '_bg_pad_bottom'] !== undefined ? ov[prefix + '_bg_pad_bottom'] : autoPad;
        const strokeExt = Math.max(0, (fx.strokeW || 0) / 2);
        const shBlur = Math.max(0, fx.shadowBlur || 0);
        const shY = fx.shadowY || 0;
        return { padT: pT, padB: pB, extTop: Math.max(strokeExt, shBlur + Math.max(0, -shY)), extBot: Math.max(strokeExt, shBlur + Math.max(0, shY)) };
    }

    const tW = (ov.title_override_w > 0) ? Number(ov.title_override_w) : contentW;
    const bW = (ov.body_override_w > 0) ? Number(ov.body_override_w) : contentW;
    const fW = (ov.footer_override_w > 0) ? Number(ov.footer_override_w) : contentW;

    // ── 内部测量函数 ──
    function _measure(tfs, bfs, ffs) {
        // 先合并自动着色范围，再用最宽的字号/字重做换行测量。
        // 自动着色可以把部分词加粗；若仍以普通字重测量，会出现“测量未超宽、实际绘制超宽”。
        const tMergedRanges = _getTitleLayoutRanges(ov, measureTitleText, tfs);
        const actualTfs = _getMaxFontSizeFromRanges(tfs, tMergedRanges);
        const actualTfw = _getMaxFontWeightFromRanges(titleWeight, tMergedRanges);
        const tfActual = `${titleItalic} ${actualTfw} ${actualTfs}px "${titleFamily}", ${titleFallback}`;
        ctx.font = tfActual;
        ctx.letterSpacing = `${ov.title_letter_spacing || 0}px`;
        const tLines = measureTitleText ? _wrapText(ctx, measureTitleText, tW) : [];
        let tMaxWidth = 0, tGlyphH = 0, glyphAscent = 0, glyphDescent = 0;
        for (const line of tLines) {
            const metrics = ctx.measureText(line);
            tMaxWidth = Math.max(tMaxWidth, metrics.width, (metrics.actualBoundingBoxLeft || 0) + (metrics.actualBoundingBoxRight || 0));
            const asc = Number.isFinite(metrics.actualBoundingBoxAscent) ? Math.max(0, metrics.actualBoundingBoxAscent) : actualTfs * 0.8;
            const desc = Number.isFinite(metrics.actualBoundingBoxDescent) ? Math.max(0, metrics.actualBoundingBoxDescent) : actualTfs * 0.2;
            glyphAscent = Math.max(glyphAscent, asc);
            glyphDescent = Math.max(glyphDescent, desc);
            tGlyphH = Math.max(tGlyphH, asc + desc);
        }
        ctx.letterSpacing = '0px';
        const titleSpacingScale = ov.title_auto_shrink ? Math.min(1, tfs / Math.max(1, Number(ov.title_fontsize) || 60)) : 1;
        const rawTitleLineH = actualTfs * 1.3 + parseFloat(ov.title_line_spacing || 0) * titleSpacingScale;
        const tLineH = ov.title_auto_shrink ? Math.max(actualTfs * 0.2, rawTitleLineH) : rawTitleLineH;
        const tExt = _getSectionExtents('title', actualTfs);
        const tFirstFM = tLines.length > 0 ? _fontMetrics(tfActual, tLines[0], actualTfs) : null;
        const tFM = tFirstFM || { ascent: actualTfs * 0.8, descent: 0 };
        if (ov.title_auto_shrink) {
            tFM.ascent = Math.max(tFM.ascent, glyphAscent);
            tFM.descent = Math.max(tFM.descent, glyphDescent);
        }
        const tDesc = ov.title_auto_shrink ? tFM.descent : (tLines.length > 0 ? _fontMetrics(tfActual, tLines[0], actualTfs, tLines[tLines.length - 1]).descent : 0);
        const tTextH = tLines.length > 0 ? (tFM.ascent + tDesc + (tLines.length - 1) * tLineH) : 0;
        const tBlockH = tLines.length > 0 ? (tTextH + tExt.padT + tExt.padB + tExt.extTop + tExt.extBot) : 0;

        const bMergedRanges = _getAutoColorMergedRanges(ov, 'body', measureBodyText) || ov.body_styled_ranges || [];
        const actualBfs = _getMaxFontSizeFromRanges(bfs, bMergedRanges);
        const actualBfw = _getMaxFontWeightFromRanges(bodyWeight, bMergedRanges);
        const bfActual = `${bodyItalic} ${actualBfw} ${actualBfs}px "${bodyFamily}", ${bodyFallback}`;
        ctx.font = bfActual;
        ctx.letterSpacing = `${ov.body_letter_spacing || 0}px`;
        const bLines = measureBodyText ? _wrapText(ctx, measureBodyText, bW) : [];
        ctx.letterSpacing = '0px';
        const bLineH = actualBfs * 1.3 + parseFloat(ov.body_line_spacing || 0);
        const bExt = _getSectionExtents('body', actualBfs);
        const bFirstFM = bLines.length > 0 ? _fontMetrics(bfActual, bLines[0], actualBfs) : null;
        const bFM = bFirstFM || { ascent: actualBfs * 0.8, descent: 0 };
        const bDesc = bLines.length > 0 ? _fontMetrics(bfActual, bLines[0], actualBfs, bLines[bLines.length - 1]).descent : 0;
        const bTextH = bLines.length > 0 ? (bFM.ascent + bDesc + (bLines.length - 1) * bLineH) : 0;
        const bBlockH = bLines.length > 0 ? (bTextH + bExt.padT + bExt.padB + bExt.extTop + bExt.extBot) : 0;

        const fMergedRanges = _getAutoColorMergedRanges(ov, 'footer', measureFooterText) || ov.footer_styled_ranges || [];
        const actualFfs = _getMaxFontSizeFromRanges(ffs, fMergedRanges);
        const actualFfw = _getMaxFontWeightFromRanges(footerWeight, fMergedRanges);
        const ffActual = `${footerItalic} ${actualFfw} ${actualFfs}px "${footerFamily}", ${footerFallback}`;
        ctx.font = ffActual;
        ctx.letterSpacing = `${ov.footer_letter_spacing || 0}px`;
        const fLines = measureFooterText ? _wrapText(ctx, measureFooterText, fW) : [];
        ctx.letterSpacing = '0px';
        const fLineH = actualFfs * 1.3 + parseFloat(ov.footer_line_spacing || 0);
        const fExt = _getSectionExtents('footer', actualFfs);
        const fFirstFM = fLines.length > 0 ? _fontMetrics(ffActual, fLines[0], actualFfs) : null;
        const fFM = fFirstFM || { ascent: actualFfs * 0.8, descent: 0 };
        const fDesc = fLines.length > 0 ? _fontMetrics(ffActual, fLines[0], actualFfs, fLines[fLines.length - 1]).descent : 0;
        const fTextH = fLines.length > 0 ? (fFM.ascent + fDesc + (fLines.length - 1) * fLineH) : 0;
        const fBlockH = fLines.length > 0 ? (fTextH + fExt.padT + fExt.padB + fExt.extTop + fExt.extBot) : 0;

        const hasT = tLines.length > 0;
        const hasB = bLines.length > 0;
        const hasF = fLines.length > 0;
        
        const tSpace = (ov.title_override_h > 0) ? Number(ov.title_override_h) : tBlockH;
        const bSpace = (ov.body_override_h > 0) ? Number(ov.body_override_h) : bBlockH;
        const fSpace = (ov.footer_override_h > 0) ? Number(ov.footer_override_h) : fBlockH;

        let total = padT + padB;
        if (ov.layout_mode === 'absolute') {
            const tBot = hasT ? (ov.title_offset_y || 0) + tSpace : 0;
            const bBot = hasB ? (ov.body_offset_y || 0) + bSpace : 0;
            const fBot = hasF ? (ov.footer_offset_y || 0) + fSpace : 0;
            total += Math.max(0, tBot, bBot, fBot);
        } else {
            if (hasT) total += tSpace;
            if (hasB) {
                if (hasT) total += gap;
                total += bSpace;
            }
            if (hasF) {
                if (hasT || hasB) total += gapFooter;
                total += fSpace;
            }
        }

        return {
            tLines, tLineH, tTextH, tBlockH, tFM, tExt, tSpace, tMaxWidth, tGlyphH,
            bLines, bLineH, bTextH, bBlockH, bFM, bExt, bSpace,
            fLines, fLineH, fTextH, fBlockH, fFM, fExt, fSpace,
            total, tf: tfActual, bf: bfActual, ff: ffActual, hasT, hasB, hasF
        };
    }

    // ── 自动缩放循环 ──
    let m = _measure(titleFontSize, bodyFontSize, footerFontSize);
    const naturalTitleBlockH = ov._titleAdaptiveLayout ? ov._titleAdaptiveAnchorH : m.tBlockH;

    // 标题范围优先；字号上下都可调，仅限制实际字形的最大高度。
    const titleMinFont = ov.title_adaptive_enabled === false ? titleFontSize : (ov.title_auto_shrink ? 0.01 : minFont);
    if (ov._titleAdaptiveLayout) {
        titleFontSize = ov._titleAdaptiveLayout.fontSize;
        m = _measure(titleFontSize, bodyFontSize, footerFontSize);
    } else if (ov.title_auto_shrink && measureTitleText.trim()) {
        const fitHeight = ov.title_override_h > 0 ? Number(ov.title_override_h) : Math.max(1, h - padT - padB);
        const glyphLimit = Math.max(1, Number(ov.title_max_glyph_height) || 60);
        titleFontSize = _cachedTitleFontFit(originalOverlay, ov, ['flow', tW, fitHeight], size => {
            const measured = _measure(size, bodyFontSize, footerFontSize);
            return measured.tMaxWidth <= tW && measured.tBlockH <= fitHeight && measured.tGlyphH <= glyphLimit;
        }, Math.max(titleFontSize, glyphLimit));
        m = _measure(titleFontSize, bodyFontSize, footerFontSize);
    }
    if (ov.body_override_h > 0 && ov.body_auto_shrink) {
        while (m.bBlockH > Number(ov.body_override_h) && bodyFontSize > minFont) {
            bodyFontSize = Math.max(minFont, bodyFontSize - 1);
            m = _measure(titleFontSize, bodyFontSize, footerFontSize);
        }
    }
    if (ov.footer_override_h > 0 && ov.footer_auto_shrink) {
        while (m.fBlockH > Number(ov.footer_override_h) && footerFontSize > minFont) {
            footerFontSize = Math.max(minFont, footerFontSize - 1);
            m = _measure(titleFontSize, bodyFontSize, footerFontSize);
        }
    }

    // 阶段 0: 仅在自动缩放模式下执行标题行数限制
    while (ov.title_adaptive_enabled !== false && !ov.title_auto_shrink && m.tLines.length > titleMaxLines && titleFontSize > minFont) {
        if (!doShrink) break;
        titleFontSize = Math.max(minFont, titleFontSize - 2);
        m = _measure(titleFontSize, bodyFontSize, footerFontSize);
    }

    if (doShrink && m.total > maxH) {
        // 第一阶段: 只缩内容字号
        while (m.total > maxH && bodyFontSize > minFont) {
            bodyFontSize = Math.max(minFont, bodyFontSize - 2);
            m = _measure(titleFontSize, bodyFontSize, footerFontSize);
        }
        // 缩小结尾字号
        while (m.total > maxH && footerFontSize > minFont) {
            footerFontSize = Math.max(minFont, footerFontSize - 2);
            m = _measure(titleFontSize, bodyFontSize, footerFontSize);
        }
        // 第二阶段: 都缩
        while (m.total > maxH && (titleFontSize > titleMinFont || bodyFontSize > minFont)) {
            if (bodyFontSize > minFont) bodyFontSize = Math.max(minFont, bodyFontSize - 1);
            if (titleFontSize > titleMinFont) titleFontSize = Math.max(titleMinFont, titleFontSize - 1);
            if (footerFontSize > minFont) footerFontSize = Math.max(minFont, footerFontSize - 1);
            m = _measure(titleFontSize, bodyFontSize, footerFontSize);
        }
    }

    const { tLines: titleLines, tLineH: titleLineH, tTextH: titleTextH, tBlockH: titleBlockH, tFM: titleFM, tExt: titleExt, tSpace,
        bLines: bodyLines, bLineH: bodyLineH, bTextH: bodyTextH, bBlockH: bodyBlockH, bFM: bodyFM, bExt: bodyExt, bSpace,
        fLines: footerLines, fLineH: footerLineH, fTextH: footerTextH, fBlockH: footerBlockH, fFM: footerFM, fExt: footerExt, fSpace,
        total: autoH, tf: titleFont, bf: bodyFont, ff: footerFont,
        hasT: hasTitle, hasB: hasBody, hasF: hasFooter } = m;

    let drawTitleLines = [];
    if (ov.title_text) {
        ctx.save();
        ctx.font = titleFont;
        ctx.letterSpacing = `${ov.title_letter_spacing || 0}px`;
        drawTitleLines = _wrapText(ctx, ov.title_uppercase ? ov.title_text.toUpperCase() : ov.title_text, tW);
        ctx.restore();
    }

    let drawBodyLines = [];
    if (ov.body_text) {
        ctx.save();
        ctx.font = bodyFont;
        ctx.letterSpacing = `${ov.body_letter_spacing || 0}px`;
        drawBodyLines = _wrapText(ctx, ov.body_text, bW);
        ctx.restore();
    }

    let drawFooterLines = [];
    if (ov.footer_text) {
        ctx.save();
        ctx.font = footerFont;
        ctx.letterSpacing = `${ov.footer_letter_spacing || 0}px`;
        drawFooterLines = _wrapText(ctx, ov.footer_text, fW);
        ctx.restore();
    }

    // ── 计算总高度与锚点 ──
    // 自动适配开：高度跟随内容；无适配：手动设定的 h 或回退到内容。
    let cardH = useAutoFit ? autoH : (h > 0 ? h : autoH);
    if (doShrink && cardH > maxH) cardH = maxH;

    // flow 布局保持中心锚定，避免内容缩放时视觉“漂移”。
    // absolute 布局（完全解绑）固定顶部锚点，避免调整 footer 时 title 跟着移动。
    const isAbsoluteLayout = ov.layout_mode === 'absolute';
    let cardY = y;
    if (!isAbsoluteLayout) {
        const originalCenterY = y + (h > 0 ? h : cardH) / 2;
        cardY = useAutoFit ? (originalCenterY - cardH / 2) : y;
    }

    // 全局物理垂直居中 (如果开启，覆盖原居中系)
    if (useAutoCenterV) {
        cardY = Math.max(60, (canvasH - cardH) / 2);
    }

    // 全屏蒙版模式
    const isFullMask = (ov.fullscreen_mask === true || ov.fullscreen_mask === 1 || ov.fullscreen_mask === '1');
    let maskX = x, maskY = cardY, maskW = w, maskH = cardH;
    if (isFullMask) {
        maskX = 0; maskY = 0; maskW = canvasW; maskH = canvasH;
    }

    // 入/出场动画
    let animOpFactor = 1;
    const inType = ov.anim_in_type || 'none';
    const outType = ov.anim_out_type || 'none';
    const start = parseFloat(ov.start || 0);
    const end = parseFloat(ov.end || 0);

    if (window.ReelsAnimEngine && (inType !== 'none' || outType !== 'none')) {
        const inDur = inType !== 'none' ? parseFloat(ov.anim_in_duration || 0.3) : 0;
        const outDur = outType !== 'none' ? parseFloat(ov.anim_out_duration || 0.3) : 0;
        const [inProgress, outProgress] = ReelsAnimEngine.computeAnimProgress(
            currentTime, start, end, inDur, outDur
        );
        if (inType === 'fade') animOpFactor *= inProgress;
        if (outType === 'fade') animOpFactor *= outProgress;

        if (inType === 'pop' || outType === 'pop') {
            let popScale = 1;
            if (inType === 'pop') popScale = Math.min(popScale, ReelsAnimEngine.computePopScale(inProgress));
            if (outType === 'pop') popScale = Math.min(popScale, ReelsAnimEngine.computePopScale(outProgress));
            if (popScale < 0.999) {
                const pcx = x + w / 2, pcy = cardY + cardH / 2;
                ctx.translate(pcx, pcy);
                ctx.scale(popScale, popScale);
                ctx.translate(-pcx, -pcy);
            }
        }

        const slideTypes = ['slide_up', 'slide_down', 'slide_left', 'slide_right'];
        if (slideTypes.includes(inType) || slideTypes.includes(outType)) {
            let sdx = 0, sdy = 0;
            if (slideTypes.includes(inType)) {
                const [dx, dy] = ReelsAnimEngine.computeSlideOffset(inProgress, inType, 120);
                sdx += dx; sdy += dy;
            }
            if (slideTypes.includes(outType)) {
                const [dx, dy] = ReelsAnimEngine.computeSlideOffset(outProgress, outType, 120);
                sdx += dx; sdy += dy;
            }
            ctx.translate(sdx, sdy);
        }
    }
    ctx.globalAlpha *= animOpFactor;

    // ── 磨砂模糊 (Frosted Glass) ──
    if (ov.card_blur_enabled) {
        const blurPx = Math.max(1, Math.min(40, parseFloat(ov.card_blur_amount ?? 10)));
        ctx.save();
        if (isFullMask) {
            ctx.rect(maskX, maskY, maskW, maskH);
        } else {
            _roundRectIndividual(ctx, x, cardY, w, cardH,
                ov.radius_tl || 0, ov.radius_tr || 0, ov.radius_br || 0, ov.radius_bl || 0);
        }
        ctx.clip();
        ctx.filter = `blur(${blurPx}px)`;
        ctx.drawImage(ctx.canvas, 0, 0);
        ctx.filter = 'none';
        ctx.restore();
    }

    // ── 绘制背景 ──
    if (ov.card_enabled !== false) {
        const cardAlpha = (ov.card_opacity ?? 80) / 100;
        ctx.save();
        ctx.globalAlpha = cardAlpha * ctx.globalAlpha;
        
        let fillStyle = ov.card_color || '#FFFFFF';
        
        // 羽化逻辑
        if (ov.card_feather_enabled) {
            const hexMatch = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(fillStyle);
            if (hexMatch) {
                const r = parseInt(hexMatch[1], 16);
                const g = parseInt(hexMatch[2], 16);
                const b = parseInt(hexMatch[3], 16);
                
                const bx = isFullMask ? maskX : x;
                const by = isFullMask ? maskY : cardY;
                const bw = isFullMask ? maskW : w;
                const bh = isFullMask ? maskH : cardH;
                const cx = bx + bw / 2;
                const cy = by + bh / 2;
                
                const dir = ov.card_feather_dir || 'bottom';
                
                const startRatio = (ov.card_feather_start ?? 50) / 100;
                const endRatio = (ov.card_feather_end ?? 100) / 100;
                
                let grad;
                
                if (dir === 'radial') {
                    // 对于矩形，为了保证四角平滑，使用对角线的一半作为半径
                    const radius = Math.sqrt(bw*bw + bh*bh) / 2;
                    grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
                    grad.addColorStop(0, `rgba(${r},${g},${b},1)`);
                    grad.addColorStop(startRatio, `rgba(${r},${g},${b},1)`);
                    grad.addColorStop(endRatio, `rgba(${r},${g},${b},0)`);
                    if (endRatio < 1) grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
                } else {
                    let x0=bx, y0=by, x1=bx, y1=by;
                    if (dir === 'bottom') { y0=by; y1=by+bh; }
                    else if (dir === 'top') { y0=by+bh; y1=by; }
                    else if (dir === 'right') { x0=bx; x1=bx+bw; }
                    else if (dir === 'left') { x0=bx+bw; x1=bx; }
                    
                    grad = ctx.createLinearGradient(x0, y0, x1, y1);
                    grad.addColorStop(0, `rgba(${r},${g},${b},1)`);
                    grad.addColorStop(startRatio, `rgba(${r},${g},${b},1)`);
                    grad.addColorStop(endRatio, `rgba(${r},${g},${b},0)`);
                    if (endRatio < 1) grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
                }
                fillStyle = grad;
            }
        } else if (typeof fillStyle === 'string' && fillStyle.includes(',')) {
            const bDir = ov.card_gradient_direction || 'horizontal';
            fillStyle = _resolveOverlayBgFill(ctx, fillStyle, x, cardY, w, cardH, bDir);
        }
        ctx.fillStyle = fillStyle;
        if (isFullMask) {
            ctx.fillRect(maskX, maskY, maskW, maskH);
        } else if (ov.card_brush) {
            const bStyle = ov.card_brush_style || '';
            // 旧版本默认保存的 'tint' 不再生效：只有新版面板里明确选择过（带 _v2 标记）才染色，否则一律原图不处理
            const bColorMode = ov.card_brush_colormode_v2 ? (ov.card_brush_color_mode || 'original') : 'original';
            const bDir = ov.card_gradient_direction || 'horizontal';
            const bSolid = ov.card_brush_solid ?? 100;
            const brushW = Number(ov.card_brush_w) || 0;
            const brushH = Number(ov.card_brush_h) || 0;
            const brushX = Number(ov.card_brush_x) || 0;
            const brushY = Number(ov.card_brush_y) || 0;
            let bx = x, by = cardY, bw = w, bh = cardH;
            if (brushW > 0) {
                const bcx = bx + bw / 2;
                bw = brushW;
                bx = bcx - bw / 2;
            }
            if (brushH > 0) {
                const bcy = by + bh / 2;
                bh = brushH;
                by = bcy - bh / 2;
            }
            bx += brushX;
            by += brushY;
            const bFit = { mode: ov.card_brush_fit || 'stretch', zoom: ov.card_brush_zoom ?? 100 };
            ReelsBrushEngine.drawBrush(ctx, bx, by, bw, bh, bStyle, ov.card_color || '#000000', 1, bColorMode, bDir, ov.card_custom_brush_data, bSolid, bFit);
        } else {
            _roundRectIndividual(ctx, x, cardY, w, cardH,
                ov.radius_tl || 0, ov.radius_tr || 0, ov.radius_br || 0, ov.radius_bl || 0);
            ctx.fill();
        }
        ctx.restore();
    }

    // ── 蒙版边框 ──
    if (ov.card_border_enabled && !isFullMask) {
        const borderW = parseFloat(ov.card_border_width ?? 3);
        const borderOp = (ov.card_border_opacity ?? 100) / 100;
        const borderStyle = ov.card_border_style || 'solid';
        const borderSides = ov.card_border_sides || 'all';
        ctx.save();
        ctx.globalAlpha = borderOp * ctx.globalAlpha;
        ctx.strokeStyle = ov.card_border_color || '#FFD700';
        ctx.lineWidth = borderW;
        ctx.lineJoin = 'round';
        // 虚线/点线
        if (borderStyle === 'dashed') {
            ctx.setLineDash([borderW * 4, borderW * 3]);
        } else if (borderStyle === 'dotted') {
            ctx.setLineDash([borderW, borderW * 2]);
        } else {
            ctx.setLineDash([]);
        }

        if (borderSides === 'all') {
            _roundRectIndividual(ctx, x, cardY, w, cardH,
                ov.radius_tl || 0, ov.radius_tr || 0, ov.radius_br || 0, ov.radius_bl || 0);
            ctx.stroke();
        } else {
            ctx.beginPath();
            if (borderSides === 'top' || borderSides === 'top-bottom') {
                ctx.moveTo(x, cardY);
                ctx.lineTo(x + w, cardY);
            }
            if (borderSides === 'bottom' || borderSides === 'top-bottom') {
                ctx.moveTo(x, cardY + cardH);
                ctx.lineTo(x + w, cardY + cardH);
            }
            if (borderSides === 'left' || borderSides === 'left-right') {
                ctx.moveTo(x, cardY);
                ctx.lineTo(x, cardY + cardH);
            }
            if (borderSides === 'right' || borderSides === 'left-right') {
                ctx.moveTo(x + w, cardY);
                ctx.lineTo(x + w, cardY + cardH);
            }
            ctx.stroke();
        }

        ctx.setLineDash([]);
        ctx.restore();
    }

    // ── 文字内部锚点 ──
    // absolute 布局必须固定锚点，避免 footer 调整反向影响 title/body。
    // flow 布局保留原有“内容居中”行为。
    const textY = isAbsoluteLayout
        ? (cardY + (ov.offset_y || 0))
        : (useAutoFit ? cardY : cardY + (h - autoH) / 2 + (ov.offset_y || 0));

    const _sectionX = (secW, customX = 0) => (
        x + padL + offsetX + customX + (contentW - secW) / 2
    );

    // Helper: draw per-section background (when independent mode enabled)
    // Helper: draw per-section background (when independent mode enabled)
    // 使用文字实际视觉高度来居中、支持独立上/下/水平 padding，完美支持整块自适应(block-fit)与整块铺满(block)
    function _drawSectionBg(prefix, secY, secH, secW, fontSize, fx, customX = 0, origBaseY = undefined, drawLines = null, align = 'center') {
        if (!indep) return;
        if (!ov[prefix + '_bg_enabled']) return;
        const bgMode = ov[prefix + '_bg_mode'] || 'block';
        if (bgMode !== 'block' && bgMode !== 'block-fit') return;
        const bgColor = ov[prefix + '_bg_color'] || '#000000';
        const bgOp = (ov[prefix + '_bg_opacity'] ?? 60) / 100;
        const bgR = ov[prefix + '_bg_radius'] ?? 12;

        const isBrush = !!(ov[prefix + '_bg_brush'] || ov.card_brush);

        // secH 已经是按真实字形上下界估算后的视觉高度
        const textVisualH = secH;

        // ── padding：设值 >= 0 时用自定义值，无值时按字号比例自动计算 ──
        const autoPad = Math.max(12, Math.round(fontSize * 0.2));
        const autoPadH = Math.max(14, Math.round(fontSize * 0.25));
        
        const bgPadTop    = ov[prefix + '_bg_pad_top']    !== undefined ? ov[prefix + '_bg_pad_top']    : autoPad;
        const bgPadBottom = ov[prefix + '_bg_pad_bottom'] !== undefined ? ov[prefix + '_bg_pad_bottom'] : autoPad;
        const bgPadH      = ov[prefix + '_bg_pad_h']      !== undefined ? ov[prefix + '_bg_pad_h']      : autoPadH;

        // Include stroke/shadow extents to avoid text visually spilling outside background
        const strokeExt = Math.max(0, (fx?.strokeW || 0) / 2);
        const shBlur = Math.max(0, fx?.shadowBlur || 0);
        const shX = fx?.shadowX || 0;
        const shY = fx?.shadowY || 0;
        const extTop = Math.max(strokeExt, shBlur + Math.max(0, -shY));
        const extBottom = Math.max(strokeExt, shBlur + Math.max(0, shY));
        const extLeft = Math.max(strokeExt, shBlur + Math.max(0, -shX));
        const extRight = Math.max(strokeExt, shBlur + Math.max(0, shX));

        // ── 艺术笔刷专属呼吸与飞白延伸补偿 ──
        // 笔刷右端有 ~28% 飞白拉丝，左端有 ~18% 起笔弧，上下有波浪毛刺，需留足平涂实色安全区
        const extraPadL = isBrush ? Math.max(30, Math.round(fontSize * 0.45)) : 0;
        const extraPadR = isBrush ? Math.max(50, Math.round(fontSize * 0.75)) : 0;
        const extraPadT = isBrush ? Math.max(16, Math.round(fontSize * 0.28)) : 0;
        const extraPadB = isBrush ? Math.max(16, Math.round(fontSize * 0.28)) : 0;

        // ── 宽度自适应计算 (block-fit 模式，或画笔在未锁死override_w时的智能贴合) ──
        let fitW = secW;
        const isFitMode = (bgMode === 'block-fit');
        if (isFitMode && drawLines && drawLines.length > 0) {
            let maxLW = 0;
            for (const line of drawLines) {
                const lw = ctx.measureText(line).width;
                if (lw > maxLW) maxLW = lw;
            }
            if (maxLW > 0) fitW = maxLW;
        }

        let baseSecX = _sectionX(secW, customX);
        if (isFitMode && fitW < secW) {
            const a = align || 'center';
            if (a === 'center') {
                baseSecX += (secW - fitW) / 2;
            } else if (a === 'right') {
                baseSecX += (secW - fitW);
            }
        }

        // ── 绘制背景矩形（基于文字视觉高度，上下等 padding = 居中）──
        let bgH = bgPadTop + textVisualH + bgPadBottom + extTop + extBottom;
        let finalY = secY - bgPadTop - extTop;

        const overrideH = Number(ov[prefix + '_override_h']) || 0;
        if (overrideH > 0 && ov[prefix + '_bg_mode'] !== 'inline' && ov[prefix + '_bg_mode'] !== 'inline-joined') {
            bgH = overrideH;
            if (origBaseY !== undefined) {
                finalY = origBaseY;
            }
        }

        if (isBrush) {
            const bStyle = ov[prefix + '_bg_brush_style'] || ov.card_brush_style || '';
            const customData = ov[prefix + '_custom_brush_data'] || ov.card_custom_brush_data;
            if (customData && ReelsBrushEngine.registerBrush && (!ReelsBrushEngine._rawImages || !ReelsBrushEngine._rawImages[bStyle])) {
                ReelsBrushEngine.registerBrush(bStyle, customData);
            }
            let bx = baseSecX - bgPadH - extraPadL - extLeft;
            let by = finalY - extraPadT;
            let bw = fitW + bgPadH * 2 + extraPadL + extraPadR + extLeft + extRight;
            let bh = bgH + extraPadT + extraPadB;

            const brushW = Number(ov[prefix + '_bg_brush_w']) || 0;
            const brushH = Number(ov[prefix + '_bg_brush_h']) || 0;
            const brushScaleX = Number(ov[prefix + '_bg_brush_scale_x']);
            const brushScaleY = Number(ov[prefix + '_bg_brush_scale_y']);
            const brushX = Number(ov[prefix + '_bg_brush_x']) || 0;
            const brushY = Number(ov[prefix + '_bg_brush_y']) || 0;
            // 新项目使用相对文字尺寸的倍率，不受 1080×1920 画布限制；
            // 旧项目没有倍率字段时仍按保存的像素宽高渲染。
            if (Number.isFinite(brushScaleX) && brushScaleX > 0) {
                const cx = bx + bw / 2;
                bw *= brushScaleX / 100;
                bx = cx - bw / 2;
            } else if (brushW > 0) {
                const a = align || 'center';
                if (a === 'left') {
                    bw = brushW;
                } else if (a === 'right') {
                    const rightEdge = bx + bw;
                    bw = brushW;
                    bx = rightEdge - bw;
                } else {
                    const cx = bx + bw / 2;
                    bw = brushW;
                    bx = cx - bw / 2;
                }
            }
            if (Number.isFinite(brushScaleY) && brushScaleY > 0) {
                const cy = by + bh / 2;
                bh *= brushScaleY / 100;
                by = cy - bh / 2;
            } else if (brushH > 0) {
                const cy = by + bh / 2;
                bh = brushH;
                by = cy - bh / 2;
            }
            bx += brushX;
            by += brushY;

            // 旧版本默认保存的 'tint' 不再生效：只有新版面板里明确选择过（带 _v2 标记）才染色，否则一律原图不处理
            const bColorMode = ov[prefix + '_bg_brush_colormode_v2'] ? (ov[prefix + '_bg_brush_colormode'] || 'original') : 'original';
            const bDir = ov[prefix + '_bg_gradient_direction'] || 'horizontal';
            const bSolid = ov[prefix + '_bg_brush_solid'] ?? 100;
            const bFit = { mode: ov[prefix + '_bg_brush_fit'] || 'stretch', zoom: ov[prefix + '_bg_brush_zoom'] ?? 100 };
            ReelsBrushEngine.drawBrush(ctx, bx, by, bw, bh, bStyle, bgColor, bgOp, bColorMode, bDir, customData, bSolid, bFit);
        } else {
            ctx.save();
            ctx.globalAlpha = bgOp * ctx.globalAlpha;
            const bDir = ov[prefix + '_bg_gradient_direction'] || 'horizontal';
            const bx = baseSecX - bgPadH - extLeft;
            const by = finalY;
            const bw = fitW + bgPadH * 2 + extLeft + extRight;
            ctx.fillStyle = _resolveOverlayBgFill(ctx, bgColor, bx, by, bw, bgH, bDir);
            _roundRect(ctx,
                bx,
                by,
                bw,
                bgH,
                bgR
            );
            ctx.fill();
            ctx.restore();
            _strokeSectionBackground(ctx, ov, prefix);
        }
    }

    function _roundRectPath(ctx, x, y, w, h, r) {
        r = Math.min(r, w / 2, h / 2);
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y);
        ctx.quadraticCurveTo(x + w, y, x + w, y + r);
        ctx.lineTo(x + w, y + h - r);
        ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
        ctx.lineTo(x + r, y + h);
        ctx.quadraticCurveTo(x, y + h, x, y + h - r);
        ctx.lineTo(x, y + r);
        ctx.quadraticCurveTo(x, y, x + r, y);
    }

    function _drawInlineBgGroup(ctx, prefix, boxes, fontAscent, fontDescent, fontSize, fx) {
        if (!indep || !ov[prefix + '_bg_enabled']) return;
        const mode = ov[prefix + '_bg_mode'] || 'block';
        if (mode === 'block' || mode === 'block-fit') return;
        const bgColor = ov[prefix + '_bg_color'] || '#000000';
        const bgOp = (ov[prefix + '_bg_opacity'] ?? 60) / 100;
        const bgR = ov[prefix + '_bg_radius'] ?? 12;

        const autoPad = Math.max(12, Math.round(fontSize * 0.2));
        const autoPadH = Math.max(14, Math.round(fontSize * 0.25));
        
        const bgPadTop    = ov[prefix + '_bg_pad_top']    !== undefined ? ov[prefix + '_bg_pad_top']    : autoPad;
        const bgPadBottom = ov[prefix + '_bg_pad_bottom'] !== undefined ? ov[prefix + '_bg_pad_bottom'] : autoPad;
        const bgPadH      = ov[prefix + '_bg_pad_h']      !== undefined ? ov[prefix + '_bg_pad_h']      : autoPadH;

        const strokeExt = Math.max(0, (fx?.strokeW || 0) / 2);
        const shBlur = Math.max(0, fx?.shadowBlur || 0);
        const shX = Math.abs(fx?.shadowX || 0);
        const shY = Math.abs(fx?.shadowY || 0);
        const extTop = Math.max(strokeExt, shBlur + shY);
        const extBottom = Math.max(strokeExt, shBlur + shY);
        const extLeft = Math.max(strokeExt, shBlur + shX);
        const extRight = Math.max(strokeExt, shBlur + shX);

        const lh = fontAscent + fontDescent;
        const bgH = bgPadTop + lh + bgPadBottom + extTop + extBottom;

        if (ov[prefix + '_bg_brush']) {
            const bStyle = ov[prefix + '_bg_brush_style'] || '';
            const customData = ov[prefix + '_custom_brush_data'];
            if (customData && ReelsBrushEngine.registerBrush && (!ReelsBrushEngine._rawImages || !ReelsBrushEngine._rawImages[bStyle])) {
                ReelsBrushEngine.registerBrush(bStyle, customData);
            }
            const bColorMode = ov[prefix + '_bg_brush_colormode_v2'] ? (ov[prefix + '_bg_brush_colormode'] || 'original') : 'original';
            const bDir = ov[prefix + '_bg_gradient_direction'] || 'horizontal';
            const bSolid = ov[prefix + '_bg_brush_solid'] ?? 100;

            // 艺术笔刷逐行包裹专属呼吸与飞白拉丝延伸
            const extraPadL = Math.max(30, Math.round(fontSize * 0.45));
            const extraPadR = Math.max(50, Math.round(fontSize * 0.75));
            const extraPadT = Math.max(14, Math.round(fontSize * 0.25));
            const extraPadB = Math.max(14, Math.round(fontSize * 0.25));

            const brushW = Number(ov[prefix + '_bg_brush_w']) || 0;
            const brushH = Number(ov[prefix + '_bg_brush_h']) || 0;
            const brushScaleX = Number(ov[prefix + '_bg_brush_scale_x']);
            const brushScaleY = Number(ov[prefix + '_bg_brush_scale_y']);
            const brushX = Number(ov[prefix + '_bg_brush_x']) || 0;
            const brushY = Number(ov[prefix + '_bg_brush_y']) || 0;

            const bFit = { mode: ov[prefix + '_bg_brush_fit'] || 'stretch', zoom: ov[prefix + '_bg_brush_zoom'] ?? 100 };
            for (const b of boxes) {
                if (!b.lw || b.lw <= 0) continue;
                let rx = b.lx - bgPadH - extraPadL - extLeft;
                let ry = b.y - fontAscent - bgPadTop - extraPadT - extTop;
                let rw = b.lw + bgPadH * 2 + extraPadL + extraPadR + extLeft + extRight;
                let rh = bgH + extraPadT + extraPadB;

                if (Number.isFinite(brushScaleX) && brushScaleX > 0) {
                    const cx = rx + rw / 2;
                    rw *= brushScaleX / 100;
                    rx = cx - rw / 2;
                } else if (brushW > 0) {
                    const cx = rx + rw / 2;
                    rw = brushW;
                    rx = cx - rw / 2;
                }
                if (Number.isFinite(brushScaleY) && brushScaleY > 0) {
                    const cy = ry + rh / 2;
                    rh *= brushScaleY / 100;
                    ry = cy - rh / 2;
                } else if (brushH > 0) {
                    const cy = ry + rh / 2;
                    rh = brushH;
                    ry = cy - rh / 2;
                }
                rx += brushX;
                ry += brushY;

                ReelsBrushEngine.drawBrush(ctx, rx, ry, rw, rh, bStyle, bgColor, bgOp, bColorMode, bDir, customData, bSolid, bFit);
            }
            return;
        }

        ctx.save();
        ctx.globalAlpha = bgOp * ctx.globalAlpha;
        const bDir = ov[prefix + '_bg_gradient_direction'] || 'horizontal';
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const b of boxes) {
            if (!b.lw || b.lw <= 0) continue;
            const rx = b.lx - bgPadH - extLeft;
            const ry = b.y - fontAscent - bgPadTop - extTop;
            const rw = b.lw + bgPadH * 2 + extLeft + extRight;
            const rh = bgH;
            minX = Math.min(minX, rx);
            minY = Math.min(minY, ry);
            maxX = Math.max(maxX, rx + rw);
            maxY = Math.max(maxY, ry + rh);
        }
        ctx.fillStyle = _resolveOverlayBgFill(ctx, bgColor, minX, minY, Math.max(1, maxX - minX), Math.max(1, maxY - minY), bDir);
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;

        if (mode === 'inline-connected') {
            const slabs=boxes.filter(b=>b.lw>0).map(b=>({left:b.lx-bgPadH-extLeft,right:b.lx+b.lw+bgPadH+extRight,
                top:b.y-fontAscent-bgPadTop-extTop,bottom:b.y-fontAscent-bgPadTop-extTop+bgH}));
            _traceConnectedOverlayBackground(ctx,slabs,ov,prefix,bgR);
            ctx.fill();ctx.restore();_strokeSectionBackground(ctx,ov,prefix);return;
        }

        ctx.beginPath();
        
        const rects = [];
        for (const b of boxes) {
            if (!b.lw || b.lw <= 0) continue;
            const rx = b.lx - bgPadH - extLeft;
            const ry = b.y - fontAscent - bgPadTop - extTop;
            const rw = b.lw + bgPadH * 2 + extLeft + extRight;
            const rh = bgH;
            
            _roundRectPath(ctx, rx, ry, rw, rh, bgR);
            rects.push({ L: rx, R: rx + rw, T: ry, B: ry + rh });
        }

        if (mode === 'inline-joined' && rects.length > 1) {
            for (let i = 0; i < rects.length - 1; i++) {
                const r1 = rects[i];
                const r2 = rects[i + 1];
                // 如果两行垂直间距过大（如空行段落），不跨段连接
                if (r2.T - r1.B > bgH * 0.7) continue;
                const iL = Math.max(r1.L, r2.L);
                const iR = Math.min(r1.R, r2.R);
                if (iL < iR) {
                    const jointTop = Math.min(r1.B - bgR, r2.T);
                    const jointBot = Math.max(r2.T + bgR, r1.B);
                    if (jointTop < jointBot) {
                        ctx.rect(iL, jointTop, iR - iL, jointBot - jointTop);
                    }
                }
            }
        }

        ctx.fill();
        ctx.restore();
        _strokeSectionBackground(ctx, ov, prefix);
    }

    // ── 绘制文字与其独立背景 ──
    let currentY = textY + padT;

    // 流式排版的 textY 已按总高度居中；独立排版原来固定上沿，
    // 需补偿一半的范围高度变化，让背景、边界和文字共用中心锚点。
    // 自动适配 + 垂直居中也已由 cardY 完成同样的补偿，避免重复偏移。
    const titleRangeOffsetY = isAbsoluteLayout && ov.title_override_h > 0 && !(useAutoFit && useAutoCenterV)
        ? (naturalTitleBlockH - tSpace) / 2
        : 0;

    // ── 绘制标题文字 ──
    if (hasTitle) {
        const disableOffsets = (useAutoFit || useAutoCenterV) && !ov._titleAdaptiveLayout;
        const customX = disableOffsets ? 0 : (ov.title_offset_x || 0);
        const customY = disableOffsets ? 0 : (ov.title_offset_y || 0);

        const secBaseY = ov._titleAdaptiveLayout && isAbsoluteLayout ? ov._titleAdaptiveCenterY - tSpace / 2 :
            ((ov.layout_mode === 'absolute') ? (textY + padT + customY) : (currentY + customY)) + titleRangeOffsetY;
        if (drawTitleLines.length > 0) {
            let availSpace = tSpace;
            if (ov.title_override_h == 0 && ov.layout_mode === 'absolute') availSpace = cardH - padT - padB;
            let tDeltaY = 0;
            if (availSpace > titleBlockH) {
                const vAlign = ov.title_valign || 'top';
                if (vAlign === 'center') tDeltaY = (availSpace - titleBlockH) / 2;
                else if (vAlign === 'bottom') tDeltaY = availSpace - titleBlockH;
            }
            const titleTextTopY = secBaseY + tDeltaY + titleExt.padT + titleExt.extTop;
            const fx = _resolveEffects('title');
            const titleRotation = parseFloat(ov.title_rotation || 0);
            // 标题的背景、文字、描边和阴影应作为一个整体旋转；卡片本身不受影响。
            ctx.save();
            if (titleRotation) {
                const titleCenterX = _sectionX(tW, customX) + tW / 2;
                const titleCenterY = titleTextTopY + titleTextH / 2;
                ctx.translate(titleCenterX, titleCenterY);
                ctx.rotate(titleRotation * Math.PI / 180);
                ctx.translate(-titleCenterX, -titleCenterY);
            }
            _drawSectionBg('title', titleTextTopY, titleTextH, tW, titleFontSize, fx, customX, secBaseY, drawTitleLines, ov.title_align);
            ctx.save();
            ctx.font = titleFont;
            ctx.letterSpacing = `${ov.title_letter_spacing || 0}px`;
            if (fx.shadowBlur > 0 || fx.shadowX !== 0 || fx.shadowY !== 0) {
                ctx.shadowColor = fx.shadowColor;
                ctx.shadowBlur = fx.shadowBlur;
                ctx.shadowOffsetX = fx.shadowX;
                ctx.shadowOffsetY = fx.shadowY;
            }
            let ty = titleTextTopY + titleFM.ascent;
            const titleBgMode = ov.title_bg_mode || 'block';
            if (indep && ov.title_bg_enabled && (titleBgMode === 'inline' || titleBgMode === 'inline-joined' || titleBgMode === 'inline-connected')) {
                const boxes = [];
                let bY = ty;
                for (const line of drawTitleLines) {
                    const lx = _alignX(ctx, line, _sectionX(tW, customX), tW, ov.title_align || 'center');
                    const lw = ctx.measureText(line).width;
                    boxes.push({ lx, y: bY, lw });
                    bY += titleLineH;
                }
                _drawInlineBgGroup(ctx, 'title', boxes, titleFM.ascent, titleFM.descent, titleFontSize, fx);
            }
            if (typeof _drawRichLine !== 'undefined') _drawRichLine._searchFrom = 0;
            for (const line of drawTitleLines) {
                const lx = _alignX(ctx, line, _sectionX(tW, customX), tW, ov.title_align || 'center');
                if (fx.strokeW > 0) {
                    ctx.strokeStyle = fx.strokeC;
                    ctx.lineWidth = fx.strokeW;
                    ctx.lineJoin = 'round';
                    ctx.strokeText(line, lx, ty);
                }
                // ── 富文本检测 (含自动着色) ──
                const _titleRanges = _getTitleLayoutRanges(ov, ov.title_uppercase ? ov.title_text.toUpperCase() : ov.title_text, titleFontSize);
                if (_titleRanges && _titleRanges.length > 0 && typeof ReelsRichText !== 'undefined') {
                    _drawRichLine(ctx, line, ov.title_text, _titleRanges, lx, ty,
                        ov.title_color || '#1A1A1A', titleFontSize, titleFamily, titleFallback, titleWeight, ov.title_letter_spacing || 0,
                        _sectionX(tW, customX), tW, ov.title_align || 'center', ov.title_gradient_direction || 'horizontal');
                } else {
                    if (!indep && ov.title_color_from_style) {
                        ctx.fillStyle = _resolveTitleColor(ov.title_color_from_style);
                    } else {
                        ctx.fillStyle = _resolveOverlayTextFill(ctx, ov.title_color || '#1A1A1A', lx, ty, titleFontSize, ctx.measureText(line).width, ov.title_gradient_direction || 'horizontal');
                    }
                    ctx.fillText(line, lx, ty);
                }
                ty += titleLineH;
            }
            ctx.restore();
            
            _recordAdaptiveTitleFrame(ctx, originalOverlay, ov, {
                x: _sectionX(tW, customX) - (ov._titleAdaptiveLayout ? (ov._titleAdaptiveLayout.width - tW) / 2 : 0),
                y: secBaseY, width: ov._titleAdaptiveLayout?.width ?? tW, height: tSpace,
                glyphBounds: ov._titleAdaptiveLayout ? _measureTitleGlyphGuide(ctx, drawTitleLines,
                    titleTextTopY + titleFM.ascent, titleLineH, titleFont, _sectionX(tW, customX), tW, ov.title_align || 'center') : null,
            }, m.tGlyphH, drawTitleLines.length, canvasW);
            if (!ov._exporting && (ov.debug_title || (ov.debug_title === undefined && ov.debug_layout))) {
                ctx.save(); ctx.globalAlpha = 1; ctx.strokeStyle='#ff5555'; ctx.lineWidth=guideLineW; ctx.setLineDash([guideLineW * 2, guideLineW * 2]);
                ctx.strokeRect(_sectionX(tW, customX), secBaseY, tW, tSpace);
                ctx.restore();
            }
            ctx.restore();
        }

        if (ov.layout_mode !== 'absolute') currentY += tSpace;
    }

    // ── 标题装饰线 ──
    if (drawTitleLines.length > 0 && ov.title_deco_enabled) {
        const disableOffsets = (useAutoFit || useAutoCenterV) && !ov._titleAdaptiveLayout;
        const customX = disableOffsets ? 0 : (ov.title_offset_x || 0);
        const decoThickness = parseFloat(ov.title_deco_thickness ?? 3);
        const decoGap = parseFloat(ov.title_deco_gap ?? 12);
        const decoOp = (ov.title_deco_opacity ?? 100) / 100;
        const decoStyle = ov.title_deco_style || 'solid';
        const decoPos = ov.title_deco_position || 'bottom';
        const decoAlign = ov.title_deco_align || 'center';
        // titleTextTopY, titleTextH 已在 title 绘制阶段计算出
        // 重新计算标题块的 secBaseY 和 tDeltaY 以定位装饰线
        const _dOff = disableOffsets ? 0 : (ov.title_offset_y || 0);
        const _dSecBaseY = ov._titleAdaptiveLayout && isAbsoluteLayout ? ov._titleAdaptiveCenterY - tSpace / 2 : textY + padT + _dOff + titleRangeOffsetY;
        let _dAvailSpace = tSpace;
        if (ov.title_override_h == 0 && ov.layout_mode === 'absolute') _dAvailSpace = cardH - padT - padB;
        let _dDeltaY = 0;
        if (_dAvailSpace > titleBlockH) {
            const vAlign = ov.title_valign || 'top';
            if (vAlign === 'center') _dDeltaY = (_dAvailSpace - titleBlockH) / 2;
            else if (vAlign === 'bottom') _dDeltaY = _dAvailSpace - titleBlockH;
        }
        const _dTopY = _dSecBaseY + _dDeltaY + titleExt.padT + titleExt.extTop;
        const titleRotation = parseFloat(ov.title_rotation || 0);
        // 测量标题实际最大行宽度
        ctx.save();
        ctx.font = titleFont;
        ctx.letterSpacing = `${ov.title_letter_spacing || 0}px`;
        let titleMaxW = 0;
        for (const line of titleLines) {
            titleMaxW = Math.max(titleMaxW, ctx.measureText(line).width);
        }
        ctx.restore();
        const isVertical = (decoPos === 'left' || decoPos === 'right');
        const defaultLen = isVertical ? titleTextH : titleMaxW;
        const decoLen = parseFloat(ov.title_deco_length ?? 0) || defaultLen;

        let startX, startY, endX, endY;

        if (isVertical) {
            let baseY = _dTopY;
            if (decoAlign === 'left') startY = baseY; // align top
            else if (decoAlign === 'right') startY = baseY + titleTextH - decoLen; // align bottom
            else startY = baseY + (titleTextH - decoLen) / 2; // align center
            
            let textBoundX = _sectionX(tW, customX);
            if (tAlign === 'center') textBoundX += (tW - titleMaxW) / 2;
            else if (tAlign === 'right') textBoundX += tW - titleMaxW;
            
            if (decoPos === 'left') {
                startX = textBoundX - decoGap - decoThickness / 2;
            } else {
                startX = textBoundX + titleMaxW + decoGap + decoThickness / 2;
            }
            endX = startX;
            endY = startY + decoLen;
        } else {
            const sectionCX = _sectionX(tW, customX) + tW / 2;
            if (decoAlign === 'left') startX = _sectionX(tW, customX);
            else if (decoAlign === 'right') startX = _sectionX(tW, customX) + tW - decoLen;
            else startX = sectionCX - decoLen / 2;

            if (decoPos === 'top') {
                startY = _dTopY - decoGap - decoThickness / 2;
            } else {
                startY = _dTopY + titleTextH + decoGap + decoThickness / 2;
            }
            endX = startX + decoLen;
            endY = startY;
        }

        ctx.save();
        if (titleRotation) {
            const titleCenterX = _sectionX(tW, customX) + tW / 2;
            const titleCenterY = _dTopY + titleTextH / 2;
            ctx.translate(titleCenterX, titleCenterY);
            ctx.rotate(titleRotation * Math.PI / 180);
            ctx.translate(-titleCenterX, -titleCenterY);
        }
        ctx.globalAlpha = decoOp * ctx.globalAlpha;
        ctx.lineWidth = decoThickness;
        ctx.lineCap = 'round';

        if (decoStyle === 'dashed') {
            ctx.setLineDash([decoThickness * 4, decoThickness * 3]);
        } else if (decoStyle === 'dotted') {
            ctx.setLineDash([decoThickness, decoThickness * 2]);
        } else {
            ctx.setLineDash([]);
        }

        const decoDir = ov.title_deco_gradient_direction || 'horizontal';
        const decoFill = _resolveOverlayDecoFill(ctx, ov.title_deco_color, (decoStyle === 'gradient' ? ov.title_deco_color2 : null), startX, startY, endX, endY, isVertical, decoDir, decoThickness);
        ctx.strokeStyle = decoFill;
        ctx.fillStyle = decoFill;

        _drawTitleDecoration(ctx, { startX, startY, endX, endY, isVertical, position: decoPos, style: decoStyle, thickness: decoThickness, parameters: ov.title_deco_parameters });

        ctx.setLineDash([]);
        ctx.restore();
    }

    // ── 绘制内容文字 ──
    if (hasBody) {
        const disableOffsets = useAutoFit || useAutoCenterV;
        const customX = disableOffsets ? 0 : (ov.body_offset_x || 0);
        const customY = disableOffsets ? 0 : (ov.body_offset_y || 0);

        let secBaseY;
        if (ov.layout_mode === 'absolute') {
            secBaseY = textY + padT + customY;
        } else {
            if (hasTitle) currentY += gap;
            secBaseY = currentY + customY;
        }

        if (drawBodyLines.length > 0) {
            let availSpace = bSpace;
            if (ov.body_override_h == 0 && ov.layout_mode === 'absolute') availSpace = cardH - padT - padB;
            let bDeltaY = 0;
            if (availSpace > bodyBlockH) {
                const vAlign = ov.body_valign || 'top';
                if (vAlign === 'center') bDeltaY = (availSpace - bodyBlockH) / 2;
                else if (vAlign === 'bottom') bDeltaY = availSpace - bodyBlockH;
            }
            const bodyTextTopY = secBaseY + bDeltaY + bodyExt.padT + bodyExt.extTop;
            const fx = _resolveEffects('body');
            _drawSectionBg('body', bodyTextTopY, bodyTextH, bW, bodyFontSize, fx, customX, secBaseY, drawBodyLines, ov.body_align);
            ctx.save();
            ctx.font = bodyFont;
            ctx.letterSpacing = `${ov.body_letter_spacing || 0}px`;
            if (fx.shadowBlur > 0 || fx.shadowX !== 0 || fx.shadowY !== 0) {
                ctx.shadowColor = fx.shadowColor;
                ctx.shadowBlur = fx.shadowBlur;
                ctx.shadowOffsetX = fx.shadowX;
                ctx.shadowOffsetY = fx.shadowY;
            }
            let by = bodyTextTopY + bodyFM.ascent;
            const bodyBgMode = ov.body_bg_mode || 'block';
            if (indep && ov.body_bg_enabled && (bodyBgMode === 'inline' || bodyBgMode === 'inline-joined' || bodyBgMode === 'inline-connected')) {
                const boxes = [];
                let bY2 = by;
                for (const line of drawBodyLines) {
                    const lx = _alignX(ctx, line, _sectionX(bW, customX), bW, ov.body_align || 'center');
                    const lw = ctx.measureText(line).width;
                    boxes.push({ lx, y: bY2, lw });
                    bY2 += bodyLineH;
                }
                _drawInlineBgGroup(ctx, 'body', boxes, bodyFM.ascent, bodyFM.descent, bodyFontSize, fx);
            }
            if (typeof _drawRichLine !== 'undefined') _drawRichLine._searchFrom = 0;
            for (const line of drawBodyLines) {
                const lx = _alignX(ctx, line, _sectionX(bW, customX), bW, ov.body_align || 'center');
                if (fx.strokeW > 0) {
                    ctx.strokeStyle = fx.strokeC;
                    ctx.lineWidth = fx.strokeW;
                    ctx.lineJoin = 'round';
                    ctx.strokeText(line, lx, by);
                }
                // ── 富文本检测 (含自动着色) ──
                const _bodyMerged = _getAutoColorMergedRanges(ov, 'body', ov.body_text);
                const _bodyRanges = _bodyMerged || ov.body_styled_ranges;
                if (_bodyRanges && _bodyRanges.length > 0 && typeof ReelsRichText !== 'undefined') {
                    _drawRichLine(ctx, line, ov.body_text, _bodyRanges, lx, by,
                        ov.body_color || '#333333', bodyFontSize, bodyFamily, bodyFallback, bodyWeight, ov.body_letter_spacing || 0,
                        _sectionX(bW, customX), bW, ov.body_align || 'center', ov.body_gradient_direction || 'horizontal');
                } else {
                    ctx.fillStyle = _resolveOverlayTextFill(ctx, ov.body_color || '#333333', lx, by, bodyFontSize, ctx.measureText(line).width, ov.body_gradient_direction || 'horizontal');
                    ctx.fillText(line, lx, by);
                }
                by += bodyLineH;
            }
            ctx.restore();
            
            if (!ov._exporting && (ov.debug_body || (ov.debug_body === undefined && ov.debug_layout))) {
                ctx.save(); ctx.globalAlpha = 1; ctx.strokeStyle='#55ff55'; ctx.lineWidth=guideLineW; ctx.setLineDash([guideLineW * 2, guideLineW * 2]);
                ctx.strokeRect(_sectionX(bW, customX), secBaseY, bW, bSpace);
                ctx.restore();
            }
        }

        if (ov.layout_mode !== 'absolute') currentY += bSpace;
    }

    // ── 绘制结尾文字 ──
    if (hasFooter) {
        const disableOffsets = useAutoFit || useAutoCenterV;
        const customX = disableOffsets ? 0 : (ov.footer_offset_x || 0);
        const customY = disableOffsets ? 0 : (ov.footer_offset_y || 0);

        let secBaseY;
        if (ov.layout_mode === 'absolute') {
            secBaseY = textY + padT + customY;
        } else {
            if (hasTitle || hasBody) currentY += gapFooter;
            secBaseY = currentY + customY;
        }

        if (drawFooterLines.length > 0) {
            let availSpace = fSpace;
            if (ov.footer_override_h == 0 && ov.layout_mode === 'absolute') availSpace = cardH - padT - padB;
            let fDeltaY = 0;
            if (availSpace > footerBlockH) {
                const vAlign = ov.footer_valign || 'top';
                if (vAlign === 'center') fDeltaY = (availSpace - footerBlockH) / 2;
                else if (vAlign === 'bottom') fDeltaY = availSpace - footerBlockH;
            }
            const footerTextTopY = secBaseY + fDeltaY + footerExt.padT + footerExt.extTop;
            const fx = _resolveEffects('footer');
            _drawSectionBg('footer', footerTextTopY, footerTextH, fW, footerFontSize, fx, customX, secBaseY, drawFooterLines, ov.footer_align);
            ctx.save();
            ctx.font = footerFont;
            ctx.letterSpacing = `${ov.footer_letter_spacing || 0}px`;
            if (fx.shadowBlur > 0 || fx.shadowX !== 0 || fx.shadowY !== 0) {
                ctx.shadowColor = fx.shadowColor;
                ctx.shadowBlur = fx.shadowBlur;
                ctx.shadowOffsetX = fx.shadowX;
                ctx.shadowOffsetY = fx.shadowY;
            }
            let fy = footerTextTopY + footerFM.ascent;
            const footerBgMode = ov.footer_bg_mode || 'block';
            if (indep && ov.footer_bg_enabled && (footerBgMode === 'inline' || footerBgMode === 'inline-joined' || footerBgMode === 'inline-connected')) {
                const boxes = [];
                let bY3 = fy;
                for (const line of drawFooterLines) {
                    const lx = _alignX(ctx, line, _sectionX(fW, customX), fW, ov.footer_align || 'center');
                    const lw = ctx.measureText(line).width;
                    boxes.push({ lx, y: bY3, lw });
                    bY3 += footerLineH;
                }
                _drawInlineBgGroup(ctx, 'footer', boxes, footerFM.ascent, footerFM.descent, footerFontSize, fx);
            }
            if (typeof _drawRichLine !== 'undefined') _drawRichLine._searchFrom = 0;
            for (const line of drawFooterLines) {
                const lx = _alignX(ctx, line, _sectionX(fW, customX), fW, ov.footer_align || 'center');
                if (fx.strokeW > 0) {
                    ctx.strokeStyle = fx.strokeC;
                    ctx.lineWidth = fx.strokeW;
                    ctx.lineJoin = 'round';
                    ctx.strokeText(line, lx, fy);
                }
                // ── 富文本检测 (含自动着色) ──
                const _footerMerged = _getAutoColorMergedRanges(ov, 'footer', ov.footer_text);
                const _footerRanges = _footerMerged || ov.footer_styled_ranges;
                if (_footerRanges && _footerRanges.length > 0 && typeof ReelsRichText !== 'undefined') {
                    _drawRichLine(ctx, line, ov.footer_text, _footerRanges, lx, fy,
                        ov.footer_color || '#666666', footerFontSize, footerFamily, footerFallback, footerWeight, ov.footer_letter_spacing || 0,
                        _sectionX(fW, customX), fW, ov.footer_align || 'center', ov.footer_gradient_direction || 'horizontal');
                } else {
                    ctx.fillStyle = _resolveOverlayTextFill(ctx, ov.footer_color || '#666666', lx, fy, footerFontSize, ctx.measureText(line).width, ov.footer_gradient_direction || 'horizontal');
                    ctx.fillText(line, lx, fy);
                }
                fy += footerLineH;
            }
            ctx.restore();
            
            if (!ov._exporting && (ov.debug_footer || (ov.debug_footer === undefined && ov.debug_layout))) {
                ctx.save(); ctx.globalAlpha = 1; ctx.strokeStyle='#5590ff'; ctx.lineWidth=guideLineW; ctx.setLineDash([guideLineW * 2, guideLineW * 2]);
                ctx.strokeRect(_sectionX(fW, customX), secBaseY, fW, fSpace);
                ctx.restore();
            }
        }

        if (ov.layout_mode !== 'absolute') currentY += fSpace;
    }

    // 将实际绘制的尺寸存回 ov，供 hit-test 和属性面板使用
    ov._renderedX = x;
    ov._renderedW = w;
    ov._renderedH = cardH;
    ov._renderedY = cardY;
    if (ov._titleAdaptiveLayout) {
        for (const key of ['_renderedX', '_renderedW', '_renderedH', '_renderedY']) originalOverlay[key] = ov[key];
    }

    // ── 排版辅助线（基准线与边距）──
    if (ov.debug_layout && !ov._exporting) {
        ctx.save();
        ctx.globalAlpha = 0.9;
        
        ctx.strokeStyle = '#00ff00';
        ctx.lineWidth = guideLineW;
        ctx.setLineDash([guideLineW * 2, guideLineW * 2]);
        
        // 上边距线
        const topEdge = cardY + padT;
        ctx.beginPath();
        ctx.moveTo(x, topEdge);
        ctx.lineTo(x + w, topEdge);
        ctx.stroke();

        // 下边距线
        const botEdge = cardY + autoH - padB;
        ctx.beginPath();
        ctx.moveTo(x, botEdge);
        ctx.lineTo(x + w, botEdge);
        ctx.stroke();

        ctx.fillStyle = '#00ff00';
        ctx.font = '14px sans-serif';
        if (padT > 0) ctx.fillText(`上边距: ${padT}px`, x + 5, cardY + padT / 2 + 5);
        if (padB > 0) ctx.fillText(`下边距: ${padB}px`, x + 5, botEdge + padB / 2 + 5);
        
        // 框选边界
        ctx.strokeStyle = '#ff00ff';
        ctx.setLineDash([2, 5]);
        ctx.strokeRect(x, cardY, w, cardH);
        
        ctx.restore();
    }

    // ── 最大高度辅助线（仅预览时显示，导出时跳过）──
    if (doShrink && !ov._exporting) {
        const guideY_top = useAutoCenterV ? (canvasH - maxH) / 2 : cardY;
        const guideY_bot = guideY_top + maxH;
        ctx.save();
        ctx.setLineDash([10, 6]);
        ctx.strokeStyle = '#4c9eff';
        ctx.lineWidth = 2;
        ctx.globalAlpha = 0.7;
        // 上边界
        ctx.beginPath();
        ctx.moveTo(x - 20, guideY_top);
        ctx.lineTo(x + w + 20, guideY_top);
        ctx.stroke();
        // 下边界
        ctx.beginPath();
        ctx.moveTo(x - 20, guideY_bot);
        ctx.lineTo(x + w + 20, guideY_bot);
        ctx.stroke();
        // 标签
        ctx.setLineDash([]);
        ctx.font = '22px sans-serif';
        ctx.fillStyle = '#4c9eff';
        ctx.globalAlpha = 0.85;
        ctx.fillText(`最大高度: ${maxH}px`, x + w + 28, guideY_top + 26);
        // 高度标尺线
        ctx.beginPath();
        ctx.moveTo(x + w + 16, guideY_top);
        ctx.lineTo(x + w + 16, guideY_bot);
        ctx.strokeStyle = '#4c9eff';
        ctx.lineWidth = 1;
        ctx.restore();
    }
}

function _drawTextCardSideBySideOverlay(ctx, ov, x, y, w, h, canvasW, canvasH) {
    return _withOverlaySyntheticBold(ctx, ov, () => _drawTextCardSideBySideOverlayCore(ctx, ov, x, y, w, h, canvasW, canvasH));
}

function _drawTextCardSideBySideOverlayCore(ctx, ov, x, y, w, h, canvasW, canvasH) {
    ctx.save();
    ctx.textBaseline = 'alphabetic';
    const cacheOwner = ov._sideBySideCacheOwner || ov;
    const guideLineW = Math.max(2, canvasW / 540);

    const padL = ov.padding_left ?? 40;
    const padR = ov.padding_right ?? 40;
    const padT = ov.padding_top ?? 28;
    const padB = ov.padding_bottom ?? 28;
    const gap = ov.side_by_side_gap ?? ov.title_body_gap ?? 80;
    const titleRatio = Math.max(10, Math.min(90, ov.side_by_side_title_ratio ?? 50)) / 100;
    const contentW = Math.max(1, w - padL - padR - gap);
    const titleBoxW = contentW * titleRatio;
    const bodyBoxW = contentW - titleBoxW;

    // ── 标题与正文的字号与排版测量 ──
    let titleFontSize = ov._titleAdaptiveLayout?.fontSize ?? ov.title_fontsize ?? 60;
    const titleWeight = _resolveOverlayFontWeight(ov.title_font_weight, ov.title_bold ? 900 : 400);
    const titleItalic = ov.title_italic ? 'italic' : 'normal';
    const titleFamily = ov.title_font_family || 'Crimson Pro';
    const titleFallback = _resolveOverlayFallback(titleFamily);
    let titleFont = `${titleItalic} ${titleWeight} ${titleFontSize}px "${titleFamily}", ${titleFallback}`;

    const bodyFontSize = ov.body_fontsize ?? 40;
    const bodyWeight = _resolveOverlayFontWeight(ov.body_font_weight, ov.body_bold ? 700 : 400);
    const bodyItalic = ov.body_italic ? 'italic' : 'normal';
    const bodyFamily = ov.body_font_family || 'Arial';
    const bodyFallback = _resolveOverlayFallback(bodyFamily);
    const bodyFont = `${bodyItalic} ${bodyWeight} ${bodyFontSize}px "${bodyFamily}", ${bodyFallback}`;
    _ensureSideBySideFontsReady(titleFont, bodyFont);

    const titleText = ov.title_uppercase !== false ? String(ov.title_text || '').toUpperCase() : String(ov.title_text || '');
    let titleBgPadH = ov.title_bg_pad_h ?? Math.max(20, Math.round(titleFontSize * 0.55));
    let titleTextW = Math.max(1, Math.min(ov.title_override_w > 0 ? Number(ov.title_override_w) : Infinity, titleBoxW - titleBgPadH * 2));
    ctx.font = titleFont;
    ctx.letterSpacing = `${ov.title_letter_spacing || 0}px`;
    let titleLines = titleText ? _wrapText(ctx, titleText, titleTextW) : [];
    ctx.letterSpacing = '0px';
    const adaptiveSpacingScale = ov._titleAdaptiveLayout ? Math.min(1, titleFontSize / Math.max(1, Number(ov.title_fontsize) || 60)) : 1;
    let titleLineH = titleFontSize * 1.3 + parseFloat(ov.title_line_spacing || 0) * adaptiveSpacingScale;
    if (ov._titleAdaptiveLayout) titleLineH = Math.max(titleFontSize * 0.2, titleLineH);
    let titleMetrics = _measureSideTextBlock('title', titleFont, titleLines, titleFontSize, titleLineH);
    let titleTextH = titleMetrics.height;

    if (ov.title_auto_shrink && !ov._titleAdaptiveLayout && titleText.trim()) {
        const glyphLimit = Math.max(1, Number(ov.title_max_glyph_height) || 60);
        const fitHeight = ov.title_override_h > 0 ? Number(ov.title_override_h) : Math.max(1, h - padT - padB);
        const measureTitle = size => {
            titleFontSize = size;
            titleFont = `${titleItalic} ${titleWeight} ${size}px "${titleFamily}", ${titleFallback}`;
            titleBgPadH = ov.title_bg_pad_h ?? Math.max(20, Math.round(size * 0.55));
            titleTextW = Math.max(1, Math.min(ov.title_override_w > 0 ? Number(ov.title_override_w) : Infinity, titleBoxW - titleBgPadH * 2));
            ctx.font = titleFont;
            ctx.letterSpacing = `${ov.title_letter_spacing || 0}px`;
            titleLines = _wrapText(ctx, titleText, titleTextW);
            let glyphH = 0, maxWidth = 0;
            for (const line of titleLines) {
                const metrics = ctx.measureText(line);
                maxWidth = Math.max(maxWidth, metrics.width, (metrics.actualBoundingBoxLeft || 0) + (metrics.actualBoundingBoxRight || 0));
                const asc = Number.isFinite(metrics.actualBoundingBoxAscent) ? Math.max(0, metrics.actualBoundingBoxAscent) : size * 0.8;
                const desc = Number.isFinite(metrics.actualBoundingBoxDescent) ? Math.max(0, metrics.actualBoundingBoxDescent) : size * 0.2;
                glyphH = Math.max(glyphH, asc + desc);
            }
            ctx.letterSpacing = '0px';
            const spacingScale = Math.min(1, size / Math.max(1, Number(ov.title_fontsize) || 60));
            titleLineH = Math.max(size * 0.2, size * 1.3 + parseFloat(ov.title_line_spacing || 0) * spacingScale);
            titleMetrics = _measureSideTextBlock('title', titleFont, titleLines, size, titleLineH);
            titleTextH = titleMetrics.height;
            const blockH = titleTextH + (ov.title_bg_pad_top ?? Math.max(12, Math.round(size * 0.35))) +
                (ov.title_bg_pad_bottom ?? Math.max(12, Math.round(size * 0.35)));
            return maxWidth <= titleTextW && blockH <= fitHeight && glyphH <= glyphLimit;
        };
        const fittedSize = _cachedTitleFontFit(cacheOwner, ov, ['side_by_side', titleBoxW, fitHeight], measureTitle, Math.max(titleFontSize, glyphLimit));
        measureTitle(fittedSize);
    }

    const bodyText = String(ov.body_text || '');
    const bodyBgPadH = ov.body_bg_pad_h ?? Math.max(20, Math.round(bodyFontSize * 0.55));
    const bodyTextW = Math.max(1, bodyBoxW - bodyBgPadH * 2);
    ctx.font = bodyFont;
    ctx.letterSpacing = `${ov.body_letter_spacing || 0}px`;
    const bodyLines = bodyText ? _wrapText(ctx, bodyText, bodyTextW) : [];
    ctx.letterSpacing = '0px';
    const bodyLineH = bodyFontSize * 1.3 + parseFloat(ov.body_line_spacing || 0);
    const bodyMetrics = _measureSideTextBlock('body', bodyFont, bodyLines, bodyFontSize, bodyLineH);
    const bodyTextH = bodyMetrics.height;

    // 计算各区段在 block 模式下的独立高度 (以便 auto_fit 动态计算总卡片高)
    const titleBgPadTop = ov.title_bg_pad_top ?? Math.max(12, Math.round(titleFontSize * 0.35));
    const titleBgPadBottom = ov.title_bg_pad_bottom ?? Math.max(12, Math.round(titleFontSize * 0.35));
    const titleSecH = titleText ? (ov.title_override_h > 0 ? Number(ov.title_override_h) : titleTextH + titleBgPadTop + titleBgPadBottom) : 0;

    const bodyBgPadTop = ov.body_bg_pad_top ?? Math.max(12, Math.round(bodyFontSize * 0.35));
    const bodyBgPadBottom = ov.body_bg_pad_bottom ?? Math.max(12, Math.round(bodyFontSize * 0.35));
    const bodySecH = bodyText ? (bodyTextH + bodyBgPadTop + bodyBgPadBottom) : 0;

    // ── 确定卡片最终高度 ──
    const maxContentH = Math.max(titleSecH, bodySecH);
    const autoH = padT + maxContentH + padB;
    const useAutoFit = (ov.auto_fit === true || ov.auto_fit === 1 || ov.auto_fit === '1');
    let cardH = useAutoFit ? autoH : (h > 0 ? h : autoH);
    const maxH = ov.max_height ?? 1400;
    if (useAutoFit && ov.auto_shrink && maxH > 0 && cardH > maxH) {
        cardH = maxH;
    }

    // ── 确定垂直起点 cardY ──
    const useAutoCenterV = (ov.auto_center_v === true || ov.auto_center_v === 1 || ov.auto_center_v === '1');
    let cardY = y;
    const isAbsoluteLayout = ov.layout_mode === 'absolute';
    if (!isAbsoluteLayout) {
        const originalCenterY = y + (h > 0 ? h : cardH) / 2;
        cardY = useAutoFit ? (originalCenterY - cardH / 2) : y;
    }
    if (useAutoCenterV) {
        cardY = Math.max(60, (canvasH - cardH) / 2);
    }

    // 保存计算值，利于交互选中等功能
    ov._renderedH = cardH;
    ov._renderedY = cardY;

    // ── 1. 磨砂玻璃背景 ──
    if (ov.card_blur_enabled) {
        const blurPx = Math.max(1, Math.min(40, parseFloat(ov.card_blur_amount ?? 10)));
        ctx.save();
        _roundRectIndividual(ctx, x, cardY, w, cardH,
            ov.radius_tl || 0, ov.radius_tr || 0, ov.radius_br || 0, ov.radius_bl || 0);
        ctx.clip();
        ctx.filter = `blur(${blurPx}px)`;
        ctx.drawImage(ctx.canvas, 0, 0);
        ctx.filter = 'none';
        ctx.restore();
    }

    // ── 2. 绘制卡片全局背景 ──
    if (ov.card_enabled !== false) {
        const cardAlpha = (ov.card_opacity ?? 80) / 100;
        ctx.save();
        ctx.globalAlpha = cardAlpha * ctx.globalAlpha;
        let fillStyle = ov.card_color || '#FFFFFF';
        ctx.fillStyle = fillStyle;
        _roundRectIndividual(ctx, x, cardY, w, cardH,
            ov.radius_tl || 0, ov.radius_tr || 0, ov.radius_br || 0, ov.radius_bl || 0);
        ctx.fill();
        ctx.restore();
    }

    // ── 3. 绘制卡片全局边框 ──
    if (ov.card_border_enabled) {
        const borderW = parseFloat(ov.card_border_width ?? 3);
        const borderOp = (ov.card_border_opacity ?? 100) / 100;
        const borderStyle = ov.card_border_style || 'solid';
        ctx.save();
        ctx.globalAlpha = borderOp * ctx.globalAlpha;
        ctx.strokeStyle = ov.card_border_color || '#FFD700';
        ctx.lineWidth = borderW;
        ctx.lineJoin = 'round';
        if (borderStyle === 'dashed') {
            ctx.setLineDash([borderW * 4, borderW * 3]);
        } else if (borderStyle === 'dotted') {
            ctx.setLineDash([borderW, borderW * 2]);
        }
        _roundRectIndividual(ctx, x, cardY, w, cardH,
            ov.radius_tl || 0, ov.radius_tr || 0, ov.radius_br || 0, ov.radius_bl || 0);
        ctx.stroke();
        ctx.restore();
    }

    // ── 4. 绘制两侧内容 ──
    const titleX = x + padL;
    const bodyX = titleX + titleBoxW + gap;
    const boxY = cardY + padT;
    const boxH = Math.max(1, cardH - padT - padB);

    drawSideSection('title', titleLines, titleFont, titleFontSize, titleBgPadH, titleBgPadTop, titleBgPadBottom, titleMetrics, titleX, boxY, titleBoxW, boxH);
    drawSideSection('body', bodyLines, bodyFont, bodyFontSize, bodyBgPadH, bodyBgPadTop, bodyBgPadBottom, bodyMetrics, bodyX, boxY, bodyBoxW, boxH);

    if (ov.debug_layout && !ov._exporting) {
        ctx.save();
        ctx.globalAlpha = 1;
        ctx.strokeStyle = 'rgba(76,158,255,0.75)';
        ctx.lineWidth = guideLineW;
        ctx.setLineDash([guideLineW * 3, guideLineW * 2]);
        ctx.strokeRect(x, cardY, w, cardH);
        ctx.restore();
    }
    ctx.restore();

    function _ensureSideBySideFontsReady(...fontList) {
        if (typeof document === 'undefined' || !document.fonts) return;
        const fontKey = fontList.join('|');
        if (cacheOwner._sideBySideFontKey === fontKey) return;
        cacheOwner._sideBySideFontKey = fontKey;
        cacheOwner._sideBySideFontsReady = false;
        cacheOwner._sideBySideFontLoadPending = true;
        Promise.allSettled(fontList.map(font => document.fonts.load(font)))
            .then(() => document.fonts.ready)
            .then(() => {
                cacheOwner._sideBySideFontsReady = true;
                cacheOwner._sideBySideFontLoadPending = false;
                if (typeof reelsUpdatePreview === 'function') {
                    requestAnimationFrame(() => reelsUpdatePreview());
                }
            })
            .catch(() => {
                cacheOwner._sideBySideFontLoadPending = false;
            });
    }

    function _measureSideTextBlock(prefix, fontStr, lines, fontSize, lineH) {
        if (!lines || lines.length === 0) return { height: 0, firstAscent: fontSize * 0.8, lastDescent: fontSize * 0.22 };
        if (!cacheOwner._sideBySideMetricCache || typeof cacheOwner._sideBySideMetricCache !== 'object') {
            cacheOwner._sideBySideMetricCache = {};
        }
        const cacheKey = [
            prefix,
            fontStr,
            fontSize,
            lineH,
            ctx.letterSpacing || '',
            lines.join('\n'),
        ].join('|');
        const cached = cacheOwner._sideBySideMetricCache[cacheKey];
        if (cached && cacheOwner._sideBySideFontLoadPending && !cacheOwner._sideBySideFontsReady) {
            return cached;
        }
        ctx.save();
        ctx.font = fontStr;
        let firstAscent = 0;
        let lastDescent = 0;
        for (let i = 0; i < lines.length; i++) {
            const m = ctx.measureText(lines[i] || 'H');
            const asc = Number(m.actualBoundingBoxAscent);
            const desc = Number(m.actualBoundingBoxDescent);
            if (i === 0) firstAscent = Number.isFinite(asc) && asc > 0 ? asc : fontSize * 0.8;
            if (i === lines.length - 1) lastDescent = Number.isFinite(desc) && desc >= 0 ? desc : fontSize * 0.22;
        }
        ctx.restore();
        const measured = {
            height: firstAscent + lastDescent + Math.max(0, lines.length - 1) * lineH,
            firstAscent,
            lastDescent,
        };
        if (cached) {
            const sameHeight = Math.abs(cached.height - measured.height) < 0.5;
            const sameAscent = Math.abs(cached.firstAscent - measured.firstAscent) < 0.5;
            const sameDescent = Math.abs(cached.lastDescent - measured.lastDescent) < 0.5;
            if (sameHeight && sameAscent && sameDescent) return cached;
        }
        cacheOwner._sideBySideMetricCache[cacheKey] = measured;
        return measured;
    }

    function drawSideSection(prefix, lines, fontStr, fontSize, bgPadH, bgPadT, bgPadB, textMetrics, sx, sy, sw, sh) {
        if (lines.length === 0) return;
        const indep = ov.independent_effects;
        const color = ov[`${prefix}_color`] || '#ffffff';
        const align = ov[`${prefix}_align`] || 'center';
        const valign = ov[`${prefix}_valign`] || 'middle';
        const letterSpacing = ov[`${prefix}_letter_spacing`] || 0;
        const lineSpacing = ov[`${prefix}_line_spacing`] || 0;
        const fx = resolveSideFx(prefix);

        // 如果开启了独立效果且显式启用了区段背景，或者在禁用全局卡片背景时默认为真
        const bgEnabled = (indep && ov[`${prefix}_bg_enabled`] === true) || (ov.card_enabled === false && ov[`${prefix}_bg_enabled`] !== false);
        const bgColor = ov[`${prefix}_bg_color`] || ov.card_color || '#4a1405';
        const bgOpacity = (ov[`${prefix}_bg_opacity`] ?? ov.card_opacity ?? 80) / 100;
        const bgRadius = ov[`${prefix}_bg_radius`] ?? ov.radius_tl ?? 12;

        const bgW = Math.min(sw, Math.max(1, Math.max(...lines.map(line => ctx.measureText(line).width), 0) + bgPadH * 2));
        const hasTitleRange = prefix === 'title' && ov.title_override_h > 0;
        const bgH = hasTitleRange ? Number(ov.title_override_h) : Math.min(sh, Math.max(1, textMetrics.height + bgPadT + bgPadB));
        
        // 若独立区段背景关闭，整个渲染框占满 sw 以便左右对齐正确；若开启则使用测量宽度居中
        const boxW = prefix === 'title' && ov._titleAdaptiveLayout ? ov._titleAdaptiveLayout.width : (bgEnabled ? bgW : sw);
        let bgX = sx + (sw - boxW) / 2 + (ov[`${prefix}_offset_x`] || 0);
        let bgY = sy + (ov[`${prefix}_offset_y`] || 0);
        if (hasTitleRange || valign === 'middle' || valign === 'center') bgY = sy + (sh - bgH) / 2 + (ov[`${prefix}_offset_y`] || 0);
        else if (valign === 'bottom') bgY = sy + sh - bgH + (ov[`${prefix}_offset_y`] || 0);

        // Side-by-side 模板同样允许标题独立旋转，背景与文字保持对齐。
        const sectionRotation = prefix === 'title' ? parseFloat(ov.title_rotation || 0) : 0;
        ctx.save();
        if (sectionRotation) {
            const sectionCenterX = bgX + boxW / 2;
            const sectionCenterY = bgY + bgH / 2;
            ctx.translate(sectionCenterX, sectionCenterY);
            ctx.rotate(sectionRotation * Math.PI / 180);
            ctx.translate(-sectionCenterX, -sectionCenterY);
        }

        if (bgEnabled) {
            ctx.save();
            ctx.globalAlpha *= Math.max(0, Math.min(1, bgOpacity));
            ctx.fillStyle = bgColor;
            if(ov[prefix+'_bg_mode']==='inline-connected') {
                ctx.font=fontStr;ctx.letterSpacing=`${letterSpacing}px`;
                const scale=prefix==='title'&&ov.title_auto_shrink?Math.min(1,fontSize/Math.max(1,Number(ov.title_fontsize)||60)):1;
                const step=fontSize*1.3+parseFloat(lineSpacing||0)*scale;
                const free=hasTitleRange?Math.max(0,bgH-bgPadT-bgPadB-textMetrics.height):0;
                const top=bgY+bgPadT+((valign==='middle'||valign==='center')?free/2:valign==='bottom'?free:0);
                const slabs=lines.map((line,i)=>{const lx=_alignX(ctx,line,bgX+bgPadH,Math.max(1,boxW-bgPadH*2),align,letterSpacing),lw=ctx.measureText(line).width;
                    return {left:lx-bgPadH,right:lx+lw+bgPadH,top:top+i*step-bgPadT,bottom:top+(i+1)*step+bgPadB,visible:line.trim().length>0};}).filter(s=>s.visible);
                _traceConnectedOverlayBackground(ctx,slabs,ov,prefix,bgRadius);
            } else _roundRect(ctx, bgX, bgY, boxW, bgH, bgRadius);
            ctx.fill();
            ctx.restore();
            _strokeSectionBackground(ctx, ov, prefix);
        }

        const textX = bgX + bgPadH;
        const alignW = Math.max(1, boxW - bgPadH * 2);
        let ty = bgY + bgPadT + textMetrics.firstAscent;
        if (hasTitleRange) {
            const freeH = Math.max(0, bgH - bgPadT - bgPadB - textMetrics.height);
            if (valign === 'middle' || valign === 'center') ty += freeH / 2;
            else if (valign === 'bottom') ty += freeH;
        }
        const firstTextBaseline = ty;
        ctx.font = fontStr;
        ctx.letterSpacing = `${letterSpacing}px`;
        if (fx.shadowBlur > 0 || fx.shadowX || fx.shadowY) {
            ctx.shadowColor = fx.shadowColor;
            ctx.shadowBlur = fx.shadowBlur;
            ctx.shadowOffsetX = fx.shadowX;
            ctx.shadowOffsetY = fx.shadowY;
        }
        for (const line of lines) {
            const lx = _alignX(ctx, line, textX, alignW, align, letterSpacing);
            if (fx.strokeW > 0) {
                ctx.save();
                ctx.lineJoin = 'round';
                ctx.strokeStyle = fx.strokeColor;
                ctx.lineWidth = fx.strokeW * 2;
                ctx.strokeText(line, lx, ty);
                ctx.restore();
            }
            ctx.fillStyle = color;
            ctx.fillText(line, lx, ty);
            const spacingScale = prefix === 'title' && ov.title_auto_shrink ? Math.min(1, fontSize / Math.max(1, Number(ov.title_fontsize) || 60)) : 1;
            const lineH = fontSize * 1.3 + parseFloat(lineSpacing || 0) * spacingScale;
            ty += prefix === 'title' && ov.title_auto_shrink ? Math.max(fontSize * 0.2, lineH) : lineH;
        }
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;
        ctx.letterSpacing = '0px';

        if (prefix === 'title') _recordAdaptiveTitleFrame(ctx, cacheOwner, ov,
            { x: bgX, y: bgY, width: boxW, height: bgH,
                glyphBounds: ov._titleAdaptiveLayout ? _measureTitleGlyphGuide(ctx, lines, firstTextBaseline,
                    Math.max(fontSize * 0.2, fontSize * 1.3 + Number(lineSpacing || 0) * Math.min(1, fontSize / Math.max(1, Number(ov.title_fontsize) || 60))),
                    fontStr, textX, alignW, align) : null,
            }, ov._titleAdaptiveLayout?.glyphH ?? fontSize, lines.length, canvasW);
        if (!ov._exporting && ((prefix === 'title' && ov.debug_title) || (prefix === 'body' && ov.debug_body))) {
            ctx.save();
            ctx.globalAlpha = 1;
            ctx.strokeStyle = prefix === 'title' ? 'rgba(255,215,0,0.85)' : 'rgba(110,198,255,0.85)';
            ctx.lineWidth = guideLineW;
            ctx.setLineDash([guideLineW * 3, guideLineW * 2]);
            ctx.strokeRect(bgX, bgY, boxW, bgH);
            ctx.restore();
        }
        ctx.restore();
    }

    function resolveSideFx(prefix) {
        const indep = ov.independent_effects;
        return {
            strokeW: indep ? (ov[`${prefix}_stroke_width`] ?? 0) : (ov.text_stroke_width ?? 0),
            strokeColor: indep ? (ov[`${prefix}_stroke_color`] || '#000000') : (ov.text_stroke_color || '#000000'),
            shadowBlur: indep ? (ov[`${prefix}_shadow_blur`] ?? 0) : (ov.text_shadow_blur ?? 0),
            shadowColor: indep ? (ov[`${prefix}_shadow_color`] || '#000000') : (ov.text_shadow_color || '#000000'),
            shadowX: indep ? (ov[`${prefix}_shadow_x`] ?? 0) : (ov.text_shadow_x ?? 0),
            shadowY: indep ? (ov[`${prefix}_shadow_y`] ?? 0) : (ov.text_shadow_y ?? 0),
        };
    }
}

/**
 * 渲染纯色蒙版覆层。
 */
function _drawSolidMaskOverlay(ctx, ov, x, y, w, h, canvasW, canvasH, currentTime) {
    // 全屏蒙版模式
    const isFullMask = (ov.fullscreen_mask === true || ov.fullscreen_mask === 1 || ov.fullscreen_mask === '1');
    let maskX = x, maskY = y, maskW = w, maskH = h;
    if (isFullMask) {
        maskX = 0; maskY = 0; maskW = canvasW; maskH = canvasH;
    }

    // 入/出场动画
    let animOpFactor = 1;
    const inType = ov.anim_in_type || 'none';
    const outType = ov.anim_out_type || 'none';
    const start = parseFloat(ov.start || 0);
    const end = parseFloat(ov.end || 0);

    if (window.ReelsAnimEngine && (inType !== 'none' || outType !== 'none')) {
        const inDur = inType !== 'none' ? parseFloat(ov.anim_in_duration || 0.3) : 0;
        const outDur = outType !== 'none' ? parseFloat(ov.anim_out_duration || 0.3) : 0;
        const [inProgress, outProgress] = ReelsAnimEngine.computeAnimProgress(
            currentTime, start, end, inDur, outDur
        );
        if (inType === 'fade') animOpFactor *= inProgress;
        if (outType === 'fade') animOpFactor *= outProgress;

        if (inType === 'pop' || outType === 'pop') {
            let popScale = 1;
            if (inType === 'pop') popScale = Math.min(popScale, ReelsAnimEngine.computePopScale(inProgress));
            if (outType === 'pop') popScale = Math.min(popScale, ReelsAnimEngine.computePopScale(outProgress));
            if (popScale < 0.999) {
                const pcx = x + w / 2, pcy = y + h / 2;
                ctx.translate(pcx, pcy);
                ctx.scale(popScale, popScale);
                ctx.translate(-pcx, -pcy);
            }
        }

        const slideTypes = ['slide_up', 'slide_down', 'slide_left', 'slide_right'];
        if (slideTypes.includes(inType) || slideTypes.includes(outType)) {
            let sdx = 0, sdy = 0;
            if (slideTypes.includes(inType)) {
                const [dx, dy] = ReelsAnimEngine.computeSlideOffset(inProgress, inType, 120);
                sdx += dx; sdy += dy;
            }
            if (slideTypes.includes(outType)) {
                const [dx, dy] = ReelsAnimEngine.computeSlideOffset(outProgress, outType, 120);
                sdx += dx; sdy += dy;
            }
            ctx.translate(sdx, sdy);
        }
    }
    ctx.globalAlpha *= animOpFactor;

    // ── 磨砂模糊 (Frosted Glass) ──
    if (ov.card_blur_enabled) {
        const blurPx = Math.max(1, Math.min(40, parseFloat(ov.card_blur_amount ?? 10)));
        ctx.save();
        if (isFullMask) {
            ctx.rect(maskX, maskY, maskW, maskH);
        } else {
            _roundRectIndividual(ctx, x, y, w, h,
                ov.radius_tl || 0, ov.radius_tr || 0, ov.radius_br || 0, ov.radius_bl || 0);
        }
        ctx.clip();
        ctx.filter = `blur(${blurPx}px)`;
        ctx.drawImage(ctx.canvas, 0, 0);
        ctx.filter = 'none';
        ctx.restore();
    }

    // ── 绘制背景 ──
    const cardAlpha = (ov.card_opacity ?? 50) / 100;
    ctx.save();
    ctx.globalAlpha = cardAlpha * ctx.globalAlpha;
    
    let fillStyle = ov.card_color || '#000000';
    
    // 羽化逻辑
    if (ov.card_feather_enabled) {
        const hexMatch = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(fillStyle);
        if (hexMatch) {
            const r = parseInt(hexMatch[1], 16);
            const g = parseInt(hexMatch[2], 16);
            const b = parseInt(hexMatch[3], 16);
            
            const bx = isFullMask ? maskX : x;
            const by = isFullMask ? maskY : y;
            const bw = isFullMask ? maskW : w;
            const bh = isFullMask ? maskH : h;
            const cx = bx + bw / 2;
            const cy = by + bh / 2;
            
            const dir = ov.card_feather_dir || 'bottom';
            
            const startRatio = (ov.card_feather_start ?? 50) / 100;
            const endRatio = (ov.card_feather_end ?? 100) / 100;
            
            let grad;
            
            if (dir === 'radial') {
                const radius = Math.sqrt(bw*bw + bh*bh) / 2;
                grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
                grad.addColorStop(0, `rgba(${r},${g},${b},1)`);
                grad.addColorStop(startRatio, `rgba(${r},${g},${b},1)`);
                grad.addColorStop(endRatio, `rgba(${r},${g},${b},0)`);
                if (endRatio < 1) grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
            } else {
                let x0=bx, y0=by, x1=bx, y1=by;
                if (dir === 'bottom') { y0=by; y1=by+bh; }
                else if (dir === 'top') { y0=by+bh; y1=by; }
                else if (dir === 'right') { x0=bx; x1=bx+bw; }
                else if (dir === 'left') { x0=bx+bw; x1=bx; }
                
                grad = ctx.createLinearGradient(x0, y0, x1, y1);
                grad.addColorStop(0, `rgba(${r},${g},${b},1)`);
                grad.addColorStop(startRatio, `rgba(${r},${g},${b},1)`);
                grad.addColorStop(endRatio, `rgba(${r},${g},${b},0)`);
                if (endRatio < 1) grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
            }
            fillStyle = grad;
        }
    }
    
    ctx.fillStyle = fillStyle;
    if (isFullMask) {
        ctx.fillRect(maskX, maskY, maskW, maskH);
    } else {
        _roundRectIndividual(ctx, x, y, w, h,
            ov.radius_tl || 0, ov.radius_tr || 0, ov.radius_br || 0, ov.radius_bl || 0);
        ctx.fill();
    }
    ctx.restore();

    // ── 蒙版边框 ──
    if (ov.card_border_enabled && !isFullMask) {
        const borderW = parseFloat(ov.card_border_width ?? 3);
        const borderOp = (ov.card_border_opacity ?? 100) / 100;
        const borderStyle = ov.card_border_style || 'solid';
        const borderSides = ov.card_border_sides || 'all';
        ctx.save();
        ctx.globalAlpha = borderOp * ctx.globalAlpha;
        ctx.strokeStyle = ov.card_border_color || '#FFD700';
        ctx.lineWidth = borderW;
        ctx.lineJoin = 'round';
        if (borderStyle === 'dashed') {
            ctx.setLineDash([borderW * 4, borderW * 3]);
        } else if (borderStyle === 'dotted') {
            ctx.setLineDash([borderW, borderW * 2]);
        } else {
            ctx.setLineDash([]);
        }

        if (borderSides === 'all') {
            _roundRectIndividual(ctx, x, y, w, h,
                ov.radius_tl || 0, ov.radius_tr || 0, ov.radius_br || 0, ov.radius_bl || 0);
            ctx.stroke();
        } else {
            ctx.beginPath();
            if (borderSides === 'top' || borderSides === 'top-bottom') {
                ctx.moveTo(x, y);
                ctx.lineTo(x + w, y);
            }
            if (borderSides === 'bottom' || borderSides === 'top-bottom') {
                ctx.moveTo(x, y + h);
                ctx.lineTo(x + w, y + h);
            }
            if (borderSides === 'left' || borderSides === 'left-right') {
                ctx.moveTo(x, y);
                ctx.lineTo(x, y + h);
            }
            if (borderSides === 'right' || borderSides === 'left-right') {
                ctx.moveTo(x + w, y);
                ctx.lineTo(x + w, y + h);
            }
            ctx.stroke();
        }
        ctx.setLineDash([]);
        ctx.restore();
    }
}

// ═══════════════════════════════════════════════════════
// 2c. Scroll Overlay Renderer
// ═══════════════════════════════════════════════════════

/**
 * 渲染滚动字幕覆层。
 * x/y/w/h = 裁切区域; 文本从 scroll_from → scroll_to 移动。
 */
function _drawScrollOverlay(ctx, ov, clipX, clipY, clipW, clipH, currentTime, canvasW, canvasH) {
    return _withOverlaySyntheticBold(ctx, ov, () => _drawScrollOverlayCore(ctx, ov, clipX, clipY, clipW, clipH, currentTime, canvasW, canvasH));
}

function _drawScrollOverlayCore(ctx, ov, clipX, clipY, clipW, clipH, currentTime, canvasW, canvasH) {
    // 整体偏移：裁切区域 + 滚动坐标一起移动
    const offsetX = parseFloat(ov.scroll_offset_x ?? 0);
    const offsetY = parseFloat(ov.scroll_offset_y ?? 0);
    clipX += offsetX;
    clipY += offsetY;

    let content = ov.content || '';
    if (ov.scroll_uppercase !== false) content = content.toUpperCase();
    if (!content) return;
    const bodyDirection = (typeof ReelsTextDirection !== 'undefined')
        ? ReelsTextDirection.resolve(ov.text_direction, content)
        : 'ltr';
    ctx.direction = bodyDirection;

    const start = parseFloat(ov.start || 0);
    let end = parseFloat(ov.end || 0);
    // 当 end 是占位值(9999)，用实际媒体时长来计算滚动速度
    if (end >= 9999) {
        if (ov._exportDuration && ov._exportDuration > 0) {
            end = ov._exportDuration; // 导出时由导出引擎设置
        } else {
            const v2Duration = window.ReelsPreviewV2?.isOpen?.()
                ? window.ReelsPreviewV2.getDuration?.()
                : 0;
            const mediaEl = document.getElementById('reels-preview-video') || document.querySelector('#reels-preview video');
            const audioEl = document.getElementById('reels-preview-audio');
            if (v2Duration && isFinite(v2Duration) && v2Duration > 0) {
                end = v2Duration;
            } else if (audioEl && audioEl.duration && isFinite(audioEl.duration) && audioEl.duration > 0) {
                end = audioEl.duration;
            } else if (mediaEl && mediaEl.duration && isFinite(mediaEl.duration)) {
                end = mediaEl.duration;
            } else {
                end = 30;
            }
        }
    }
    const duration = end - start;
    if (duration <= 0) return;

    // 进度 = (当前时间 - 开始) / 有效时长，clamp 到 [0, 1]
    // scroll_auto_stop_lead: 提前N秒完成滚动（默认0，即不提前）
    const leadTime = Math.max(0, parseFloat(ov.scroll_auto_stop_lead ?? 0));
    const effectiveDuration = Math.max(0.1, duration - leadTime);
    let progress = (currentTime - start) / effectiveDuration;
    progress = Math.max(0, Math.min(1, progress));

    // 插值当前位置（加上整体偏移）。
    // scroll_x_anchor=center 时，scroll_from_x/scroll_to_x 表示文本中心轴，
    // text_width 会从中心轴向两侧展开。
    const rawFromX = parseFloat(ov.scroll_from_x ?? (clipX + clipW / 2));
    const rawToX = parseFloat(ov.scroll_to_x ?? rawFromX);
    const legacyDefaultLeftX = ov.scroll_x_anchor == null
        && Math.abs(rawFromX - 90) < 0.001
        && Math.abs(rawToX - 90) < 0.001;
    const useCenterAnchor = ov.scroll_x_anchor === 'center' || legacyDefaultLeftX;
    const fromX = (legacyDefaultLeftX ? (clipX + clipW / 2) : rawFromX + offsetX);
    const fromY = parseFloat(ov.scroll_from_y ?? (clipY + clipH)) + offsetY;
    const toX   = (legacyDefaultLeftX ? (clipX + clipW / 2) : rawToX + offsetX);
    const toY   = parseFloat(ov.scroll_to_y ?? (clipY - 500)) + offsetY;

    // 字体设置
    // 字体设置 (可能被 auto_fit 缩小)
    let fontSize     = ov.fontsize || 40;
    const fontFamily  = ov.font_family || 'Arial';
    const fontWeight  = _resolveOverlayFontWeight(ov.font_weight, ov.bold ? 700 : 400);
    const italicStr   = ov.italic ? 'italic' : 'normal';
    const fallback    = _resolveOverlayFallback(fontFamily);
    const lineSpacing = parseFloat(ov.line_spacing ?? 6);
    const align       = ov.text_align || 'center';
    const textW       = Math.max(1, parseFloat(ov.text_width || (clipW - 40)));

    // ── 计算标题占用高度 ──
    let titleOccupiedH = 0;
    const scrollTitleText = (ov.scroll_title || '').trim();
    const titleIndependent = ov.scroll_title_independent === true;
    let actualTitleFontSize = 56;
    if (scrollTitleText) {
        let tSize = parseFloat(ov.scroll_title_fontsize ?? 56);
        const tMergedRanges = _getAutoColorMergedRanges(ov, 'scroll_title', scrollTitleText) || ov.scroll_title_styled_ranges || [];
        const tFamily = ov.scroll_title_font_family || fontFamily;
        const tWeight = _resolveOverlayFontWeight(ov.scroll_title_font_weight, ov.scroll_title_bold ? 700 : 400);
        const tFallback = _resolveOverlayFallback(tFamily);
        const tLineSpacing = parseFloat(ov.scroll_title_line_spacing ?? lineSpacing);
        const tGap = parseFloat(ov.scroll_title_gap ?? 20);
        const tLetterSpacing = parseFloat(ov.scroll_title_letter_spacing || 0);
        const tTextW = parseFloat(ov.scroll_title_text_width || 0) || textW;
        const tMaxH = parseFloat(ov.scroll_title_max_height || 0);
        const tMinSize = parseFloat(ov.scroll_min_fontsize ?? 16);
        let titleLines = [];
        let tLineH = 0;
        for (let trySize = tSize; trySize >= tMinSize; trySize -= 2) {
            const actualTrySize = _getMaxFontSizeFromRanges(trySize, tMergedRanges);
            tLineH = actualTrySize * 1.3 + tLineSpacing;
            ctx.font = `${italicStr} ${tWeight} ${trySize}px "${tFamily}", ${tFallback}`;
            titleLines = _wrapText(ctx, scrollTitleText, tTextW, tLetterSpacing);
            const blockH = titleLines.length * tLineH;
            tSize = trySize;
            actualTitleFontSize = actualTrySize;
            if (!ov.scroll_title_auto_fit || !(tMaxH > 0) || blockH <= tMaxH) break;
        }
        titleOccupiedH = titleIndependent ? 0 : (titleLines.length * tLineH + tGap);
    }

    // ── 自动缩放字号：确保文字在裁切区内全部可见 ──
    const featherT_pre = parseFloat(ov.feather_top ?? 0);
    const featherB_pre = parseFloat(ov.feather_bottom ?? 0);
    const visibleH = clipH - featherT_pre - featherB_pre;
    const bodyVisibleH = visibleH - titleOccupiedH;  // 可用于正文的高度
    const minFontSize = parseFloat(ov.scroll_min_fontsize ?? 16);

    const bMergedRanges = _getAutoColorMergedRanges(ov, 'scroll', content) || ov.scroll_styled_ranges || [];
    let fontStr, lineHeight, lines;
    if (ov.scroll_auto_fit && bodyVisibleH > 0) {
        // 循环缩小字号直到正文高度 <= 可用高度
        for (let trySize = fontSize; trySize >= minFontSize; trySize -= 2) {
            const actualTrySize = _getMaxFontSizeFromRanges(trySize, bMergedRanges);
            lineHeight = actualTrySize * 1.3 + lineSpacing;
            fontStr = `${italicStr} ${fontWeight} ${trySize}px "${fontFamily}", ${fallback}`;
            ctx.font = fontStr;
            lines = _wrapText(ctx, content, textW, parseFloat(ov.scroll_letter_spacing || 0));
            const totalH = lines.length * lineHeight;
            if (totalH <= bodyVisibleH) {
                fontSize = trySize;
                break;
            }
            fontSize = trySize; // 即使到了 minFontSize 也要用
        }
    } else {
        const actualBfs = _getMaxFontSizeFromRanges(fontSize, bMergedRanges);
        lineHeight = actualBfs * 1.3 + lineSpacing;
        fontStr = `${italicStr} ${fontWeight} ${fontSize}px "${fontFamily}", ${fallback}`;
        ctx.font = fontStr;
        lines = _wrapText(ctx, content, textW, parseFloat(ov.scroll_letter_spacing || 0));
    }

    // ── 自动停止：到达最终位置后冻结 ──
    let effectiveToY = toY;
    if (ov.scroll_auto_stop) {
        // 正文行高度
        let totalTextH = lines.length * lineHeight;
        // 非固定标题会跟随滚动，它的高度也要计入总文本高度
        const titleFixed = ov.scroll_title_fixed !== false && (ov.scroll_title || '').trim();
        if (!titleFixed && titleOccupiedH > 0) {
            // titleOccupiedH = titleLines.length * tLineH + tGap
            totalTextH += titleOccupiedH;
        }

        const featherT = parseFloat(ov.feather_top ?? 0) + parseFloat(ov.feather_top_offset ?? 0);
        const featherB = parseFloat(ov.feather_bottom ?? 0) + parseFloat(ov.feather_bottom_offset ?? 0);

        // 固定标题模式下正文 clip 区会缩小
        const bodyClipTop = (titleFixed && !titleIndependent) ? (clipY + titleOccupiedH) : clipY;
        const bodyClipBot = clipY + clipH;
        const bodyClipH = bodyClipBot - bodyClipTop;

        // 向上滚 (fromY > toY)
        if (fromY > toY) {
            const visibleBodyH = bodyClipH - featherT - featherB;
            if (totalTextH <= visibleBodyH) {
                // 文字短于可见区：停在文字顶部刚好在 bodyClipTop + featherT 处（全部可见）
                effectiveToY = bodyClipTop + featherT;
            } else {
                // 文字长于可见区：停在文字底部刚好到达 bodyClipBot - featherB 处
                effectiveToY = bodyClipBot - featherB - totalTextH;
            }
        }
        // 向下滚 (fromY < toY)
        else if (fromY < toY) {
            const visibleBodyH = bodyClipH - featherT - featherB;
            if (totalTextH <= visibleBodyH) {
                // 文字短于可见区：停在文字底部刚好在 bodyClipBot - featherB 处（全部可见）
                effectiveToY = bodyClipBot - featherB - totalTextH;
            } else {
                // 文字长于可见区：停在文字顶部刚好到达 bodyClipTop + featherT 处
                effectiveToY = bodyClipTop + featherT;
            }
        }
    }

    const curAxisX = fromX + (toX - fromX) * progress;
    const curX  = useCenterAnchor ? curAxisX - textW / 2 : curAxisX;
    let curY;
    if (ov.scroll_static) {
        // 固定显示模式：文字固定在裁切区顶部（考虑羽化偏移）
        const featherT_static = parseFloat(ov.feather_top ?? 0) + parseFloat(ov.feather_top_offset ?? 0);
        const titleFixed = ov.scroll_title_fixed !== false && (ov.scroll_title || '').trim();
        const staticBaseY = (titleFixed && !titleIndependent) ? (clipY + titleOccupiedH + featherT_static) : (clipY + featherT_static);
        curY = staticBaseY;
    } else {
        curY = fromY + (effectiveToY - fromY) * progress;
    }

    // 将正文第一行的实时位置暴露出去，供媒体覆层「跟随滚动」绑定使用
    // 固定标题模式下正文直接从 curY 开始（_skipTitle 跳过标题绘制）；
    // 标题跟随滚动时正文在标题块后面，需加 titleOccupiedH。
    const _titleFixed = ov.scroll_title_fixed !== false && (ov.scroll_title || '').trim();
    ov._scrollBodyFirstLineY = _titleFixed ? curY : (curY + titleOccupiedH);
    ov._scrollBodyLineHeight = lineHeight;
    ov._scrollBodyCurX = curAxisX;

    // ── 磨砂模糊 (Frosted Glass) ──
    if (ov.bg_blur_enabled) {
        const blurPx = Math.max(1, Math.min(40, parseFloat(ov.bg_blur_amount ?? 10)));
        const padT_blur = parseFloat(ov.bg_padding_top ?? 16);
        const padB_blur = parseFloat(ov.bg_padding_bottom ?? 16);
        const padL_blur = parseFloat(ov.bg_padding_left ?? 16);
        const padR_blur = parseFloat(ov.bg_padding_right ?? 16);
        const rad_blur = parseFloat(ov.bg_radius || 12);
        ctx.save();
        if (ov.bg_fullscreen) {
            ctx.rect(0, 0, canvasW, canvasH);
        } else {
            _roundRect(ctx, clipX - padL_blur, clipY - padT_blur, clipW + padL_blur + padR_blur, clipH + padT_blur + padB_blur, rad_blur);
        }
        ctx.clip();
        ctx.filter = `blur(${blurPx}px)`;
        ctx.drawImage(ctx.canvas, 0, 0);
        ctx.filter = 'none';
        ctx.restore();
    }

    // ── 卡片背景 ──
    if (ov.bg_enabled) {
        const bgAlpha = (ov.bg_opacity || 191) / 255;
        const padT = parseFloat(ov.bg_padding_top ?? 16);
        const padB = parseFloat(ov.bg_padding_bottom ?? 16);
        const padL = parseFloat(ov.bg_padding_left ?? 16);
        const padR = parseFloat(ov.bg_padding_right ?? 16);
        const rad = parseFloat(ov.bg_radius || 12);
        ctx.save();
        ctx.globalAlpha = bgAlpha * ctx.globalAlpha;
        ctx.fillStyle = ov.bg_color || '#000000';
        if (ov.bg_fullscreen) {
            // 全屏蒙版
            _roundRect(ctx, 0, 0, canvasW, canvasH, 0);
        } else {
            _roundRect(ctx, clipX - padL, clipY - padT, clipW + padL + padR, clipH + padT + padB, rad);
        }
        ctx.fill();
        ctx.restore();
    }

    // ── 卡片边框 ──
    if (ov.bg_border_enabled && !ov.bg_fullscreen) {
        const padT_b = parseFloat(ov.bg_padding_top ?? 16);
        const padB_b = parseFloat(ov.bg_padding_bottom ?? 16);
        const padL_b = parseFloat(ov.bg_padding_left ?? 16);
        const padR_b = parseFloat(ov.bg_padding_right ?? 16);
        const rad_b = parseFloat(ov.bg_radius || 12);
        const borderW = parseFloat(ov.bg_border_width ?? 3);
        const borderOp = (ov.bg_border_opacity ?? 100) / 100;
        const borderStyle = ov.bg_border_style || 'solid';
        const borderSides = ov.bg_border_sides || 'all';

        const rx = clipX - padL_b;
        const ry = clipY - padT_b;
        const rw = clipW + padL_b + padR_b;
        const rh = clipH + padT_b + padB_b;

        ctx.save();
        ctx.globalAlpha = borderOp * ctx.globalAlpha;
        ctx.strokeStyle = ov.bg_border_color || '#FFD700';
        ctx.lineWidth = borderW;
        ctx.lineJoin = 'round';
        if (borderStyle === 'dashed') {
            ctx.setLineDash([borderW * 4, borderW * 3]);
        } else if (borderStyle === 'dotted') {
            ctx.setLineDash([borderW, borderW * 2]);
        } else {
            ctx.setLineDash([]);
        }

        if (borderSides === 'all') {
            _roundRect(ctx, rx, ry, rw, rh, rad_b);
            ctx.stroke();
        } else {
            ctx.beginPath();
            if (borderSides === 'top' || borderSides === 'top-bottom') {
                ctx.moveTo(rx, ry);
                ctx.lineTo(rx + rw, ry);
            }
            if (borderSides === 'bottom' || borderSides === 'top-bottom') {
                ctx.moveTo(rx, ry + rh);
                ctx.lineTo(rx + rw, ry + rh);
            }
            if (borderSides === 'left' || borderSides === 'left-right') {
                ctx.moveTo(rx, ry);
                ctx.lineTo(rx, ry + rh);
            }
            if (borderSides === 'right' || borderSides === 'left-right') {
                ctx.moveTo(rx + rw, ry);
                ctx.lineTo(rx + rw, ry + rh);
            }
            ctx.stroke();
        }

        ctx.setLineDash([]);
        ctx.restore();
    }

    const featherTop    = parseFloat(ov.feather_top ?? 0);
    const featherBottom = parseFloat(ov.feather_bottom ?? 0);
    const featherTopOff = parseFloat(ov.feather_top_offset ?? 0);
    const featherBotOff = parseFloat(ov.feather_bottom_offset ?? 0);
    const featherLeft   = parseFloat(ov.feather_left ?? 0);
    const featherRight  = parseFloat(ov.feather_right ?? 0);
    const featherLeftOff = parseFloat(ov.feather_left_offset ?? 0);
    const featherRightOff = parseFloat(ov.feather_right_offset ?? 0);

    // ── 固定标题模式 ──
        let titleText = (ov.scroll_title || '').trim();
        if (ov.scroll_title_uppercase !== false) titleText = titleText.toUpperCase();
        const titleFixed = ov.scroll_title_fixed !== false && titleText;

        if (titleFixed) {
            // 计算标题尺寸
            let tSize = parseFloat(ov.scroll_title_fontsize ?? 56);
            const tFamily = ov.scroll_title_font_family || fontFamily;
            const tWeight = _resolveOverlayFontWeight(ov.scroll_title_font_weight, ov.scroll_title_bold ? 700 : 400);
            const tFallback = _resolveOverlayFallback(tFamily);
            const tColor = ov.scroll_title_color || ov.color || '#FFFFFF';
            const tAlign = ov.scroll_title_align || align;
            const tLineSpacing = parseFloat(ov.scroll_title_line_spacing ?? lineSpacing);
            const tGap = parseFloat(ov.scroll_title_gap ?? 20);
            const tLetterSpacing = parseFloat(ov.scroll_title_letter_spacing || 0);
            const tTextW = parseFloat(ov.scroll_title_text_width || 0) || textW; // 0 = 跟随正文

            ctx.save();
            ctx.direction = (typeof ReelsTextDirection !== 'undefined')
                ? ReelsTextDirection.resolve(ov.text_direction, titleText)
                : 'ltr';
            if (tLetterSpacing !== 0 && typeof ctx.letterSpacing !== 'undefined') {
                ctx.letterSpacing = tLetterSpacing + 'px';
            }
            const tMergedRanges = _getAutoColorMergedRanges(ov, 'scroll_title', titleText) || ov.scroll_title_styled_ranges || [];
            const tMaxH = parseFloat(ov.scroll_title_max_height || 0);
            const tMinSize = parseFloat(ov.scroll_min_fontsize ?? 16);
            let titleLines = [];
            let tLineH = 0;
            for (let trySize = tSize; trySize >= tMinSize; trySize -= 2) {
                const actualTrySize = _getMaxFontSizeFromRanges(trySize, tMergedRanges);
                tLineH = actualTrySize * 1.3 + tLineSpacing;
                ctx.font = `${italicStr} ${tWeight} ${trySize}px "${tFamily}", ${tFallback}`;
                titleLines = _wrapText(ctx, titleText, tTextW, tLetterSpacing);
                const blockH = titleLines.length * tLineH;
                tSize = trySize;
                if (!ov.scroll_title_auto_fit || !(tMaxH > 0) || blockH <= tMaxH) break;
            }
            const titleBlockH = titleLines.length * tLineH;

            // ── 1. 绘制固定标题 (在覆层顶部，不受裁切) ──
            // 标题X/Y 只要填了值就生效，不需要勾选"独立位置"
            const titleDrawY = ov.scroll_title_y != null ? parseFloat(ov.scroll_title_y) + offsetY : clipY;
            const titleAxisX = ov.scroll_title_x != null
                ? parseFloat(ov.scroll_title_x) + offsetX
                : (legacyDefaultLeftX ? (clipX + clipW / 2) : fromX);
            const titleDrawX = useCenterAnchor ? titleAxisX - tTextW / 2 : titleAxisX;

            // 标题独立背景
            if (ov.scroll_title_bg_enabled && titleLines.length > 0) {
                ctx.save();
                const tbgAlpha = (ov.scroll_title_bg_opacity ?? 60) / 100;
                ctx.globalAlpha = tbgAlpha * ctx.globalAlpha;
                ctx.fillStyle = ov.scroll_title_bg_color || '#000000';
                const tbgPadH = parseFloat(ov.scroll_title_bg_pad_h ?? 0);
                const tbgPadTop = parseFloat(ov.scroll_title_bg_pad_top ?? 0);
                const tbgPadBot = parseFloat(ov.scroll_title_bg_pad_bottom ?? 0);
                const tbgRad = parseFloat(ov.scroll_title_bg_radius ?? 12);
                if (ov.scroll_title_bg_mode === 'inline-connected') {
                    const slabs=titleLines.map((line,i)=>{const lx=_alignX(ctx,line,titleDrawX,tTextW,tAlign,tLetterSpacing),lw=ctx.measureText(line).width;
                        return {left:lx-tbgPadH,right:lx+lw+tbgPadH,top:titleDrawY+i*tLineH-tbgPadTop,bottom:titleDrawY+(i+1)*tLineH+tbgPadBot,visible:line.trim().length>0};}).filter(s=>s.visible);
                    _traceConnectedOverlayBackground(ctx,slabs,ov,'scroll_title',tbgRad);ctx.fill();
                } else if (ov.scroll_title_bg_mode === 'inline' || ov.scroll_title_bg_mode === 'inline-joined') {
                    // 每行独立包裹
                    let ty = titleDrawY;
                    for (const line of titleLines) {
                        const lw = ctx.measureText(line).width;
                        const lx = _alignX(ctx, line, titleDrawX, tTextW, tAlign, tLetterSpacing);
                        _roundRect(ctx, lx - tbgPadH, ty - tbgPadTop, lw + tbgPadH * 2, tLineH + tbgPadTop + tbgPadBot, tbgRad);
                        ctx.fill();
                        ty += tLineH;
                    }
                } else {
                    // 整块
                    _roundRect(ctx, titleDrawX - tbgPadH, titleDrawY - tbgPadTop, tTextW + tbgPadH * 2, titleBlockH + tbgPadTop + tbgPadBot, tbgRad);
                    ctx.fill();
                }
                ctx.restore();
            }

            // 阴影
            const tShadowEnabled = ov.scroll_title_shadow_enabled !== undefined ? ov.scroll_title_shadow_enabled : ov.shadow_enabled;
            if (tShadowEnabled) {
                ctx.save();
                ctx.shadowColor = _withAlpha(ov.scroll_title_shadow_color || ov.shadow_color || '#000000', (ov.shadow_opacity || 120) / 255);
                ctx.shadowBlur = parseFloat(ov.scroll_title_shadow_blur ?? ov.shadow_blur ?? 4);
                ctx.shadowOffsetX = parseFloat(ov.scroll_title_shadow_x ?? ov.shadow_offset_x ?? 2);
                ctx.shadowOffsetY = parseFloat(ov.scroll_title_shadow_y ?? ov.shadow_offset_y ?? 2);
                ctx.fillStyle = tColor;
                let ty = titleDrawY + tSize;
                for (const line of titleLines) {
                    if (typeof _fillTextWithLetterSpacing !== 'undefined' && tLetterSpacing !== 0 && typeof ctx.letterSpacing === 'undefined') {
                        _fillTextWithLetterSpacing(ctx, line, _alignX(ctx, line, titleDrawX, tTextW, tAlign, tLetterSpacing), ty, tLetterSpacing);
                    } else {
                        ctx.fillText(line, _alignX(ctx, line, titleDrawX, tTextW, tAlign, tLetterSpacing), ty);
                    }
                    ty += tLineH;
                }
                ctx.restore();
            }
            // 描边
            const tStrokeWidth = parseFloat(ov.scroll_title_stroke_width ?? ov.stroke_width ?? 0);
            const tUseStroke = tStrokeWidth > 0;
            if (tUseStroke) {
                ctx.save();
                ctx.strokeStyle = ov.scroll_title_stroke_color || ov.stroke_color || '#000000';
                ctx.lineWidth = tStrokeWidth * 2;
                ctx.lineJoin = 'round'; ctx.miterLimit = 2;
                let ty = titleDrawY + tSize;
                for (const line of titleLines) {
                    if (typeof _strokeTextWithLetterSpacing !== 'undefined' && tLetterSpacing !== 0 && typeof ctx.letterSpacing === 'undefined') {
                        _strokeTextWithLetterSpacing(ctx, line, _alignX(ctx, line, titleDrawX, tTextW, tAlign, tLetterSpacing), ty, tLetterSpacing);
                    } else {
                        ctx.strokeText(line, _alignX(ctx, line, titleDrawX, tTextW, tAlign, tLetterSpacing), ty);
                    }
                    ty += tLineH;
                }
                ctx.restore();
            }
            // 填充
            if (typeof _drawRichLine !== 'undefined') _drawRichLine._searchFrom = 0;
            ctx.fillStyle = tColor;
            let ty = titleDrawY + tSize;
            for (const line of titleLines) {
                const lx = _alignX(ctx, line, titleDrawX, tTextW, tAlign, tLetterSpacing);
                const _scrollTitleMerged1 = _getAutoColorMergedRanges(ov, 'scroll_title', titleText);
                const _scrollTitleRanges1 = _scrollTitleMerged1 || ov.scroll_title_styled_ranges;
                const lineW = ctx.measureText(line).width;
                ctx.fillStyle = _resolveOverlayTextFill(ctx, tColor, lx, ty, tSize, lineW, ov.scroll_title_gradient_direction || 'horizontal');
                if (_scrollTitleRanges1 && _scrollTitleRanges1.length > 0 && typeof ReelsRichText !== 'undefined') {
                    _drawRichLine(ctx, line, titleText, _scrollTitleRanges1, lx, ty, tColor, tSize, tFamily, tFallback, tWeight, tLetterSpacing, undefined, undefined, undefined, ov.scroll_title_gradient_direction || 'horizontal');
                } else {
                    if (typeof _fillTextWithLetterSpacing !== 'undefined' && tLetterSpacing !== 0 && typeof ctx.letterSpacing === 'undefined') {
                        _fillTextWithLetterSpacing(ctx, line, lx, ty, tLetterSpacing);
                    } else {
                        ctx.fillText(line, lx, ty);
                    }
                }
                ty += tLineH;
            }
            ctx.restore();

            // ── 标题装饰线 ──
            if (ov.scroll_title_deco_enabled && titleLines.length > 0) {
                const decoThickness = parseFloat(ov.scroll_title_deco_thickness ?? 3);
                const decoGap = parseFloat(ov.scroll_title_deco_gap ?? 12);
                const decoOp = (ov.scroll_title_deco_opacity ?? 100) / 100;
                const decoStyle = ov.scroll_title_deco_style || 'solid';
                const decoPos = ov.scroll_title_deco_position || 'bottom';
                const decoAlign = ov.scroll_title_deco_align || 'center';

                ctx.save();
                ctx.font = `${tWeight} ${tSize}px ${tFamily}, ${tFallback}`;
                if (typeof ctx.letterSpacing !== 'undefined') {
                    ctx.letterSpacing = `${tLetterSpacing}px`;
                }
                let titleMaxW = 0;
                for (const line of titleLines) {
                    titleMaxW = Math.max(titleMaxW, ctx.measureText(line).width);
                }
                if (typeof ctx.letterSpacing !== 'undefined') {
                    ctx.letterSpacing = '0px';
                }
                ctx.restore();

                const isVertical = (decoPos === 'left' || decoPos === 'right');
                const defaultLen = isVertical ? titleBlockH : titleMaxW;
                const decoLen = parseFloat(ov.scroll_title_deco_length ?? 0) || defaultLen;

                let startX, startY, endX, endY;

                if (isVertical) {
                    let baseY = titleDrawY;
                    if (decoAlign === 'left') startY = baseY; // align top
                    else if (decoAlign === 'right') startY = baseY + titleBlockH - decoLen; // align bottom
                    else startY = baseY + (titleBlockH - decoLen) / 2; // align center
                    
                    let textBoundX = titleDrawX;
                    if (tAlign === 'center') textBoundX += (tTextW - titleMaxW) / 2;
                    else if (tAlign === 'right') textBoundX += tTextW - titleMaxW;
                    
                    if (decoPos === 'left') {
                        startX = textBoundX - decoGap - decoThickness / 2;
                    } else {
                        startX = textBoundX + titleMaxW + decoGap + decoThickness / 2;
                    }
                    endX = startX;
                    endY = startY + decoLen;
                } else {
                    const sectionCX = titleDrawX + tTextW / 2;
                    if (decoAlign === 'left') startX = titleDrawX;
                    else if (decoAlign === 'right') startX = titleDrawX + tTextW - decoLen;
                    else startX = sectionCX - decoLen / 2;

                    if (decoPos === 'top') {
                        startY = titleDrawY - decoGap - decoThickness / 2;
                    } else {
                        startY = titleDrawY + titleBlockH + decoGap + decoThickness / 2;
                    }
                    endX = startX + decoLen;
                    endY = startY;
                }

                ctx.save();
                ctx.globalAlpha = decoOp * ctx.globalAlpha;
                ctx.lineWidth = decoThickness;
                ctx.lineCap = 'round';

                if (decoStyle === 'dashed') {
                    ctx.setLineDash([decoThickness * 4, decoThickness * 3]);
                } else if (decoStyle === 'dotted') {
                    ctx.setLineDash([decoThickness, decoThickness * 2]);
                } else {
                    ctx.setLineDash([]);
                }

                const sDecoDir = ov.scroll_title_deco_gradient_direction || 'horizontal';
                const sDecoFill = _resolveOverlayDecoFill(ctx, ov.scroll_title_deco_color, (decoStyle === 'gradient' ? ov.scroll_title_deco_color2 : null), startX, startY, endX, endY, isVertical, sDecoDir, decoThickness);
                ctx.strokeStyle = sDecoFill;
                ctx.fillStyle = sDecoFill;

                _drawTitleDecoration(ctx, { startX, startY, endX, endY, isVertical, position: decoPos, style: decoStyle, thickness: decoThickness, parameters: ov.scroll_title_deco_parameters });

                ctx.setLineDash([]);
                ctx.restore();
            }

        // ── 2. 正文在标题下方的剩余空间内滚动 ──
        const bodyClipY = titleIndependent ? clipY : (clipY + titleBlockH + tGap);
        const bodyClipH = titleIndependent ? clipH : (clipH - titleBlockH - tGap);
        if (bodyClipH > 0) {
            const ovProxy = Object.assign({}, ov, { _skipTitle: true });
            const hasFeather = featherTop > 0 || featherBottom > 0 || featherTopOff > 0 || featherBotOff > 0 || featherLeft > 0 || featherRight > 0 || featherLeftOff > 0 || featherRightOff > 0;
            if (hasFeather) {
                const cW = Math.ceil(clipW), cH = Math.ceil(bodyClipH);
                const tmp = document.createElement('canvas');
                tmp.width = cW; tmp.height = cH;
                const tc = tmp.getContext('2d');
                tc.font = fontStr;
                const offX = curX - clipX;
                const offY = curY - bodyClipY;
                _drawScrollTextBlock(tc, ovProxy, lines, offX, offY, textW, lineHeight, fontSize, align, { currentTime, start, end, effectiveDuration, segments: ov._taskSegments || [] });

                // 渐变遮罩：固定标题只作用于正文裁切区，标题本身不参与羽化。
                tc.globalCompositeOperation = 'destination-in';
                const grad = tc.createLinearGradient(0, 0, 0, cH);
                const _cs = (v) => Math.max(0, Math.min(1, v)); // clamp to [0,1]
                if (featherTop > 0 || featherTopOff > 0) {
                    grad.addColorStop(0, 'rgba(0,0,0,0)');
                    if (featherTopOff > 0) grad.addColorStop(_cs(Math.min(featherTopOff / cH, 0.49)), 'rgba(0,0,0,0)');
                    if (featherTop > 0) {
                        grad.addColorStop(_cs(Math.min((featherTopOff + featherTop) / cH, 0.499)), 'rgba(0,0,0,1)');
                    } else {
                        grad.addColorStop(_cs(Math.min(featherTopOff / cH, 0.499)), 'rgba(0,0,0,1)');
                    }
                } else {
                    grad.addColorStop(0, 'rgba(0,0,0,1)');
                }
                
                if (featherBottom > 0 || featherBotOff > 0) {
                    if (featherBottom > 0) {
                        grad.addColorStop(_cs(Math.max(1 - (featherBotOff + featherBottom) / cH, 0.501)), 'rgba(0,0,0,1)');
                    } else {
                        grad.addColorStop(_cs(Math.max(1 - featherBotOff / cH, 0.501)), 'rgba(0,0,0,1)');
                    }
                    if (featherBotOff > 0) grad.addColorStop(_cs(Math.max(1 - featherBotOff / cH, 0.502)), 'rgba(0,0,0,0)');
                    grad.addColorStop(1, 'rgba(0,0,0,0)');
                } else {
                    grad.addColorStop(1, 'rgba(0,0,0,1)');
                }
                tc.fillStyle = grad;
                tc.fillRect(0, 0, cW, cH);
                
                if (featherLeft > 0 || featherRight > 0 || featherLeftOff > 0 || featherRightOff > 0) {
                    const gradX = tc.createLinearGradient(0, 0, cW, 0);
                    if (featherLeft > 0 || featherLeftOff > 0) {
                        gradX.addColorStop(0, 'rgba(0,0,0,0)');
                        if (featherLeftOff > 0) gradX.addColorStop(_cs(Math.min(featherLeftOff / cW, 0.49)), 'rgba(0,0,0,0)');
                        if (featherLeft > 0) {
                            gradX.addColorStop(_cs(Math.min((featherLeftOff + featherLeft) / cW, 0.499)), 'rgba(0,0,0,1)');
                        } else {
                            gradX.addColorStop(_cs(Math.min(featherLeftOff / cW, 0.499)), 'rgba(0,0,0,1)');
                        }
                    } else {
                        gradX.addColorStop(0, 'rgba(0,0,0,1)');
                    }
                    
                    if (featherRight > 0 || featherRightOff > 0) {
                        if (featherRight > 0) {
                            gradX.addColorStop(_cs(Math.max(1 - (featherRightOff + featherRight) / cW, 0.501)), 'rgba(0,0,0,1)');
                        } else {
                            gradX.addColorStop(_cs(Math.max(1 - featherRightOff / cW, 0.501)), 'rgba(0,0,0,1)');
                        }
                        if (featherRightOff > 0) gradX.addColorStop(_cs(Math.max(1 - featherRightOff / cW, 0.502)), 'rgba(0,0,0,0)');
                        gradX.addColorStop(1, 'rgba(0,0,0,0)');
                    } else {
                        gradX.addColorStop(1, 'rgba(0,0,0,1)');
                    }
                    tc.fillStyle = gradX;
                    tc.fillRect(0, 0, cW, cH);
                }
                
                ctx.drawImage(tmp, clipX, bodyClipY);
            } else {
                ctx.save();
                ctx.beginPath();
                ctx.rect(clipX, bodyClipY, clipW, bodyClipH);
                ctx.clip();
                _drawScrollTextBlock(ctx, ovProxy, lines, curX, curY, textW, lineHeight, fontSize, align, { currentTime, start, end, effectiveDuration, segments: ov._taskSegments || [] });
                ctx.restore();
            }
        }
    } else {
        // ── 标题跟随滚动 (原有逻辑) ──
        const hasFeather = featherTop > 0 || featherBottom > 0 || featherTopOff > 0 || featherBotOff > 0 || featherLeft > 0 || featherRight > 0 || featherLeftOff > 0 || featherRightOff > 0;
        if (hasFeather) {
            const cW = Math.ceil(clipW), cH = Math.ceil(clipH);
            const tmp = document.createElement('canvas');
            tmp.width = cW; tmp.height = cH;
            const tc = tmp.getContext('2d');
            tc.font = fontStr;

            const offX = curX - clipX;
            const offY = curY - clipY;
            _drawScrollTextBlock(tc, ov, lines, offX, offY, textW, lineHeight, fontSize, align, { currentTime, start, end, effectiveDuration, segments: ov._taskSegments || [] });

            tc.globalCompositeOperation = 'destination-in';
            const grad = tc.createLinearGradient(0, 0, 0, cH);
            const _cs2 = (v) => Math.max(0, Math.min(1, v));
            if (featherTop > 0 || featherTopOff > 0) {
                grad.addColorStop(0, 'rgba(0,0,0,0)');
                if (featherTopOff > 0) grad.addColorStop(_cs2(Math.min(featherTopOff / cH, 0.49)), 'rgba(0,0,0,0)');
                if (featherTop > 0) {
                    grad.addColorStop(_cs2(Math.min((featherTopOff + featherTop) / cH, 0.499)), 'rgba(0,0,0,1)');
                } else {
                    grad.addColorStop(_cs2(Math.min(featherTopOff / cH, 0.499)), 'rgba(0,0,0,1)');
                }
            } else {
                grad.addColorStop(0, 'rgba(0,0,0,1)');
            }
            
            if (featherBottom > 0 || featherBotOff > 0) {
                if (featherBottom > 0) {
                    grad.addColorStop(_cs2(Math.max(1 - (featherBotOff + featherBottom) / cH, 0.501)), 'rgba(0,0,0,1)');
                } else {
                    grad.addColorStop(_cs2(Math.max(1 - featherBotOff / cH, 0.501)), 'rgba(0,0,0,1)');
                }
                if (featherBotOff > 0) grad.addColorStop(_cs2(Math.max(1 - featherBotOff / cH, 0.502)), 'rgba(0,0,0,0)');
                grad.addColorStop(1, 'rgba(0,0,0,0)');
            } else {
                grad.addColorStop(1, 'rgba(0,0,0,1)');
            }
            tc.fillStyle = grad;
            tc.fillRect(0, 0, cW, cH);
            
            if (featherLeft > 0 || featherRight > 0 || featherLeftOff > 0 || featherRightOff > 0) {
                const gradX = tc.createLinearGradient(0, 0, cW, 0);
                if (featherLeft > 0 || featherLeftOff > 0) {
                    gradX.addColorStop(0, 'rgba(0,0,0,0)');
                    if (featherLeftOff > 0) gradX.addColorStop(_cs2(Math.min(featherLeftOff / cW, 0.49)), 'rgba(0,0,0,0)');
                    if (featherLeft > 0) {
                        gradX.addColorStop(_cs2(Math.min((featherLeftOff + featherLeft) / cW, 0.499)), 'rgba(0,0,0,1)');
                    } else {
                        gradX.addColorStop(_cs2(Math.min(featherLeftOff / cW, 0.499)), 'rgba(0,0,0,1)');
                    }
                } else {
                    gradX.addColorStop(0, 'rgba(0,0,0,1)');
                }
                
                if (featherRight > 0 || featherRightOff > 0) {
                    if (featherRight > 0) {
                        gradX.addColorStop(_cs2(Math.max(1 - (featherRightOff + featherRight) / cW, 0.501)), 'rgba(0,0,0,1)');
                    } else {
                        gradX.addColorStop(_cs2(Math.max(1 - featherRightOff / cW, 0.501)), 'rgba(0,0,0,1)');
                    }
                    if (featherRightOff > 0) gradX.addColorStop(_cs2(Math.max(1 - featherRightOff / cW, 0.502)), 'rgba(0,0,0,0)');
                    gradX.addColorStop(1, 'rgba(0,0,0,0)');
                } else {
                    gradX.addColorStop(1, 'rgba(0,0,0,1)');
                }
                tc.fillStyle = gradX;
                tc.fillRect(0, 0, cW, cH);
            }

            ctx.drawImage(tmp, clipX, clipY);
        } else {
            ctx.save();
            ctx.beginPath();
            ctx.rect(clipX, clipY, clipW, clipH);
            ctx.clip();
            _drawScrollTextBlock(ctx, ov, lines, curX, curY, textW, lineHeight, fontSize, align, { currentTime, start, end, effectiveDuration, segments: ov._taskSegments || [] });
            ctx.restore();
        }
    }

    // ── 预览辅助线 ──
    if (!ov._exporting) {
        ctx.save();
        ctx.setLineDash([8, 4]);
        ctx.strokeStyle = '#FF6B35';
        ctx.lineWidth = 1.5;
        ctx.globalAlpha = 0.5;
        ctx.strokeRect(clipX, clipY, clipW, clipH);
        if (featherTopOff > 0) {
            ctx.strokeStyle = '#FF4444'; ctx.setLineDash([2, 2]); // Red dashed for total transparency zone
            ctx.beginPath(); ctx.moveTo(clipX, clipY + featherTopOff);
            ctx.lineTo(clipX + clipW, clipY + featherTopOff); ctx.stroke();
        }
        if (featherTop > 0) {
            ctx.strokeStyle = '#FFD700'; ctx.setLineDash([4, 4]);
            ctx.beginPath(); ctx.moveTo(clipX, clipY + featherTop + featherTopOff);
            ctx.lineTo(clipX + clipW, clipY + featherTop + featherTopOff); ctx.stroke();
        }
        if (featherBotOff > 0) {
            ctx.strokeStyle = '#FF4444'; ctx.setLineDash([2, 2]);
            ctx.beginPath(); ctx.moveTo(clipX, clipY + clipH - featherBotOff);
            ctx.lineTo(clipX + clipW, clipY + clipH - featherBotOff); ctx.stroke();
        }
        if (featherBottom > 0) {
            ctx.strokeStyle = '#FFD700'; ctx.setLineDash([4, 4]);
            ctx.beginPath(); ctx.moveTo(clipX, clipY + clipH - featherBottom - featherBotOff);
            ctx.lineTo(clipX + clipW, clipY + clipH - featherBottom - featherBotOff); ctx.stroke();
        }
        if (featherLeftOff > 0) {
            ctx.strokeStyle = '#FF4444'; ctx.setLineDash([2, 2]);
            ctx.beginPath(); ctx.moveTo(clipX + featherLeftOff, clipY);
            ctx.lineTo(clipX + featherLeftOff, clipY + clipH); ctx.stroke();
        }
        if (featherLeft > 0) {
            ctx.strokeStyle = '#FFD700'; ctx.setLineDash([4, 4]);
            ctx.beginPath(); ctx.moveTo(clipX + featherLeft + featherLeftOff, clipY);
            ctx.lineTo(clipX + featherLeft + featherLeftOff, clipY + clipH); ctx.stroke();
        }
        if (featherRightOff > 0) {
            ctx.strokeStyle = '#FF4444'; ctx.setLineDash([2, 2]);
            ctx.beginPath(); ctx.moveTo(clipX + clipW - featherRightOff, clipY);
            ctx.lineTo(clipX + clipW - featherRightOff, clipY + clipH); ctx.stroke();
        }
        if (featherRight > 0) {
            ctx.strokeStyle = '#FFD700'; ctx.setLineDash([4, 4]);
            ctx.beginPath(); ctx.moveTo(clipX + clipW - featherRight - featherRightOff, clipY);
            ctx.lineTo(clipX + clipW - featherRight - featherRightOff, clipY + clipH); ctx.stroke();
        }
        ctx.setLineDash([]);
        ctx.font = '20px sans-serif';
        ctx.fillStyle = '#FF6B35';
        ctx.globalAlpha = 0.8;
        ctx.fillText(`裁切区 ${Math.round(clipW)}×${Math.round(clipH)}`, clipX + 8, clipY - 8);
        ctx.restore();
    }
}

/**
 * 绘制滚动字幕文本块 (内部)。
 */
function _drawScrollTextBlock(ctx, ov, lines, textX, textY, textW, lineHeight, fontSize, align, twContext = null) {
    return _withOverlaySyntheticBold(ctx, ov, () => _drawScrollTextBlockCore(ctx, ov, lines, textX, textY, textW, lineHeight, fontSize, align, twContext));
}

function _drawScrollTextBlockCore(ctx, ov, lines, textX, textY, textW, lineHeight, fontSize, align, twContext = null) {
    let drawY = textY;

    // ── 标题 (如果 _skipTitle 则跳过，由外部固定绘制) ──
    const titleText = (ov.scroll_title || '').trim();
    if (titleText && !ov._skipTitle) {
        let tSize = parseFloat(ov.scroll_title_fontsize ?? 56);
        const tFamily = ov.scroll_title_font_family || ov.font_family || 'Arial';
        const tWeight = _resolveOverlayFontWeight(ov.scroll_title_font_weight, ov.scroll_title_bold ? 700 : 400);
        const tItalic = ov.italic ? 'italic' : 'normal';
        const tFallback = _resolveOverlayFallback(tFamily);
        const tColor = ov.scroll_title_color || ov.color || '#FFFFFF';
        const tAlign = ov.scroll_title_align || align;
        
        const tMergedRanges = _getAutoColorMergedRanges(ov, 'scroll_title', titleText) || ov.scroll_title_styled_ranges || [];
        const tGap = parseFloat(ov.scroll_title_gap ?? 20);

        ctx.save();
        ctx.direction = (typeof ReelsTextDirection !== 'undefined')
            ? ReelsTextDirection.resolve(ov.text_direction, titleText)
            : 'ltr';
        const tLetterSpacing = parseFloat(ov.scroll_title_letter_spacing || 0);
        if (tLetterSpacing !== 0 && typeof ctx.letterSpacing !== 'undefined') {
            ctx.letterSpacing = tLetterSpacing + 'px';
        }
        const titleTextW = parseFloat(ov.scroll_title_text_width || 0) || textW;
        const titleTextX = textX + (textW - titleTextW) / 2;
        const tMaxH = parseFloat(ov.scroll_title_max_height || 0);
        const tMinSize = parseFloat(ov.scroll_min_fontsize ?? 16);
        let titleLines = [];
        let tLineH = 0;
        for (let trySize = tSize; trySize >= tMinSize; trySize -= 2) {
            const actualTrySize = _getMaxFontSizeFromRanges(trySize, tMergedRanges);
            tLineH = actualTrySize * 1.3 + parseFloat(ov.scroll_title_line_spacing ?? ov.line_spacing ?? 6);
            ctx.font = `${tItalic} ${tWeight} ${trySize}px "${tFamily}", ${tFallback}`;
            titleLines = _wrapText(ctx, titleText, titleTextW, tLetterSpacing);
            const blockH = titleLines.length * tLineH;
            tSize = trySize;
            if (!ov.scroll_title_auto_fit || !(tMaxH > 0) || blockH <= tMaxH) break;
        }

        // 阴影
        const tShadowEnabled2 = ov.scroll_title_shadow_enabled !== undefined ? ov.scroll_title_shadow_enabled : ov.shadow_enabled;
        if (tShadowEnabled2) {
            ctx.save();
            ctx.shadowColor = _withAlpha(ov.scroll_title_shadow_color || ov.shadow_color || '#000000', (ov.shadow_opacity || 120) / 255);
            ctx.shadowBlur = parseFloat(ov.scroll_title_shadow_blur ?? ov.shadow_blur ?? 4);
            ctx.shadowOffsetX = parseFloat(ov.scroll_title_shadow_x ?? ov.shadow_offset_x ?? 2);
            ctx.shadowOffsetY = parseFloat(ov.scroll_title_shadow_y ?? ov.shadow_offset_y ?? 2);
            ctx.fillStyle = tColor;
            let ty = drawY + tSize;
            for (const line of titleLines) {
                ctx.fillText(line, _alignX(ctx, line, titleTextX, titleTextW, tAlign, tLetterSpacing), ty);
                ty += tLineH;
            }
            ctx.restore();
        }
        // 描边
        const tStrokeWidth2 = parseFloat(ov.scroll_title_stroke_width ?? ov.stroke_width ?? 0);
        if (tStrokeWidth2 > 0) {
            ctx.save();
            ctx.strokeStyle = ov.scroll_title_stroke_color || ov.stroke_color || '#000000';
            ctx.lineWidth = tStrokeWidth2 * 2;
            ctx.lineJoin = 'round'; ctx.miterLimit = 2;
            let ty = drawY + tSize;
            for (const line of titleLines) {
                ctx.strokeText(line, _alignX(ctx, line, titleTextX, titleTextW, tAlign, tLetterSpacing), ty);
                ty += tLineH;
            }
            ctx.restore();
        }
        // 填充
        if (typeof _drawRichLine !== 'undefined') _drawRichLine._searchFrom = 0;
        ctx.fillStyle = tColor;
        let ty = drawY + tSize;
        for (const line of titleLines) {
            const lx = _alignX(ctx, line, titleTextX, titleTextW, tAlign, tLetterSpacing);
            const _scrollTitleMerged2 = _getAutoColorMergedRanges(ov, 'scroll_title', titleText);
            const _scrollTitleRanges2 = _scrollTitleMerged2 || ov.scroll_title_styled_ranges;
            const lineW = ctx.measureText(line).width;
            ctx.fillStyle = _resolveOverlayTextFill(ctx, tColor, lx, ty, tSize, lineW, ov.scroll_title_gradient_direction || 'horizontal');
            if (_scrollTitleRanges2 && _scrollTitleRanges2.length > 0 && typeof ReelsRichText !== 'undefined') {
                _drawRichLine(ctx, line, titleText, _scrollTitleRanges2, lx, ty, tColor, tSize, tFamily, tFallback, tWeight, tLetterSpacing, undefined, undefined, undefined, ov.scroll_title_gradient_direction || 'horizontal');
            } else {
                ctx.fillText(line, lx, ty);
            }
            ty += tLineH;
        }
        drawY += titleLines.length * tLineH + tGap;
        ctx.restore();
        ctx.font = `${ov.italic ? 'italic' : 'normal'} ${_resolveOverlayFontWeight(ov.font_weight, ov.bold ? 700 : 400)} ${fontSize}px "${ov.font_family || 'Arial'}", ${_resolveOverlayFallback(ov.font_family || 'Arial')}`;
    }

    // ── 正文 ──
    ctx.direction = (typeof ReelsTextDirection !== 'undefined')
        ? ReelsTextDirection.resolve(ov.text_direction, ov.content || '')
        : 'ltr';
    const bLetterSpacing = parseFloat(ov.scroll_letter_spacing || 0);
    if (bLetterSpacing !== 0 && typeof ctx.letterSpacing !== 'undefined') {
        ctx.letterSpacing = bLetterSpacing + 'px';
    }

    if (ov.scroll_typewriter_enabled && twContext) {
        _renderScrollTypewriterBody(ctx, ov, lines, textX, drawY, textW, lineHeight, fontSize, align, bLetterSpacing, twContext);
        return;
    }

    // 正文独立背景
    if (ov.scroll_body_bg_enabled && lines.length > 0) {
        ctx.save();
        const bbgAlpha = (ov.scroll_body_bg_opacity ?? 60) / 100;
        ctx.globalAlpha = bbgAlpha * ctx.globalAlpha;
        ctx.fillStyle = ov.scroll_body_bg_color || '#000000';
        const bbgPadH = parseFloat(ov.scroll_body_bg_pad_h ?? 0);
        const bbgPadTop = parseFloat(ov.scroll_body_bg_pad_top ?? 0);
        const bbgPadBot = parseFloat(ov.scroll_body_bg_pad_bottom ?? 0);
        const bbgRad = parseFloat(ov.scroll_body_bg_radius ?? 12);
        const bodyBlockH = lines.length * lineHeight;
        if (ov.scroll_body_bg_mode === 'inline-connected') {
                    const slabs=lines.map((line,i)=>{const lx=_alignX(ctx,line,textX,textW,align,bLetterSpacing),lw=ctx.measureText(line).width;
                        return {left:lx-bbgPadH,right:lx+lw+bbgPadH,top:drawY+i*lineHeight-bbgPadTop,bottom:drawY+(i+1)*lineHeight+bbgPadBot,visible:line.trim().length>0};}).filter(s=>s.visible);
                    _traceConnectedOverlayBackground(ctx,slabs,ov,'scroll_body',bbgRad);ctx.fill();
                } else if (ov.scroll_body_bg_mode === 'inline' || ov.scroll_body_bg_mode === 'inline-joined') {
            let by = drawY;
            for (const line of lines) {
                const lw = ctx.measureText(line).width;
                const lx = _alignX(ctx, line, textX, textW, align, bLetterSpacing);
                _roundRect(ctx, lx - bbgPadH, by - bbgPadTop, lw + bbgPadH * 2, lineHeight + bbgPadTop + bbgPadBot, bbgRad);
                ctx.fill();
                by += lineHeight;
            }
        } else {
            _roundRect(ctx, textX - bbgPadH, drawY - bbgPadTop, textW + bbgPadH * 2, bodyBlockH + bbgPadTop + bbgPadBot, bbgRad);
            ctx.fill();
        }
        ctx.restore();
    }

    // 阴影
    if (ov.shadow_enabled) {
        ctx.save();
        ctx.shadowColor = _withAlpha(ov.shadow_color || '#000000', (ov.shadow_opacity || 120) / 255);
        ctx.shadowBlur = parseFloat(ov.shadow_blur || 4);
        ctx.shadowOffsetX = parseFloat(ov.scroll_shadow_x ?? ov.shadow_offset_x ?? 2);
        ctx.shadowOffsetY = parseFloat(ov.scroll_shadow_y ?? ov.shadow_offset_y ?? 2);
        ctx.fillStyle = ov.color || '#FFFFFF';
        let sy = drawY + fontSize;
        for (const line of lines) {
            const lx = _alignX(ctx, line, textX, textW, align, bLetterSpacing);
            if (typeof _fillTextWithLetterSpacing !== 'undefined' && bLetterSpacing !== 0 && typeof ctx.letterSpacing === 'undefined') {
                _fillTextWithLetterSpacing(ctx, line, lx, sy, bLetterSpacing);
            } else {
                ctx.fillText(line, lx, sy);
            }
            sy += lineHeight;
        }
        ctx.restore();
    }
    // 描边
    if (ov.use_stroke && (ov.stroke_width || 0) > 0) {
        ctx.save();
        ctx.strokeStyle = ov.stroke_color || '#000000';
        ctx.lineWidth = parseFloat(ov.stroke_width || 2) * 2;
        ctx.lineJoin = 'round';
        ctx.miterLimit = 2;
        let sy = drawY + fontSize;
        for (const line of lines) {
            const lx = _alignX(ctx, line, textX, textW, align, bLetterSpacing);
            if (typeof _strokeTextWithLetterSpacing !== 'undefined' && bLetterSpacing !== 0 && typeof ctx.letterSpacing === 'undefined') {
                _strokeTextWithLetterSpacing(ctx, line, lx, sy, bLetterSpacing);
            } else {
                ctx.strokeText(line, lx, sy);
            }
            sy += lineHeight;
        }
        ctx.restore();
    }
    // 填充
    if (typeof _drawRichLine !== 'undefined') _drawRichLine._searchFrom = 0;
    ctx.fillStyle = ov.color || '#FFFFFF';
    let yc = drawY + fontSize;
    const bodyFamily = ov.font_family || 'Arial';
    const bodyFallback = _resolveOverlayFallback(bodyFamily);
    const bodyWeight = _resolveOverlayFontWeight(ov.font_weight, ov.bold ? 700 : 400);
    
    let rawContent = ov.content || '';
    if (ov.scroll_uppercase !== false) rawContent = rawContent.toUpperCase();

    for (const line of lines) {
        const lx = _alignX(ctx, line, textX, textW, align, bLetterSpacing);
        const _scrollBodyMerged = _getAutoColorMergedRanges(ov, 'scroll_body', rawContent);
        const _scrollBodyRanges = _scrollBodyMerged || ov.scroll_styled_ranges;
        const lineW = ctx.measureText(line).width;
        ctx.fillStyle = _resolveOverlayTextFill(ctx, ov.color || '#FFFFFF', lx, yc, fontSize, lineW, ov.scroll_body_gradient_direction || ov.scroll_gradient_direction || 'horizontal');
        if (_scrollBodyRanges && _scrollBodyRanges.length > 0 && typeof ReelsRichText !== 'undefined') {
            _drawRichLine(ctx, line, rawContent, _scrollBodyRanges, lx, yc, ov.color || '#FFFFFF', fontSize, bodyFamily, bodyFallback, bodyWeight, bLetterSpacing, undefined, undefined, undefined, ov.scroll_body_gradient_direction || ov.scroll_gradient_direction || 'horizontal');
        } else {
            if (typeof _fillTextWithLetterSpacing !== 'undefined' && bLetterSpacing !== 0 && typeof ctx.letterSpacing === 'undefined') {
                _fillTextWithLetterSpacing(ctx, line, lx, yc, bLetterSpacing);
            } else {
                ctx.fillText(line, lx, yc);
            }
        }
        yc += lineHeight;
    }
}

/**
 * 绘制四角独立圆角矩形。
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x @param {number} y @param {number} w @param {number} h
 * @param {number} tl - 左上 @param {number} tr - 右上
 * @param {number} br - 右下 @param {number} bl - 左下
 */
function _roundRectIndividual(ctx, x, y, w, h, tl, tr, br, bl) {
    tl = Math.min(tl, w / 2, h / 2);
    tr = Math.min(tr, w / 2, h / 2);
    br = Math.min(br, w / 2, h / 2);
    bl = Math.min(bl, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + tl, y);
    ctx.lineTo(x + w - tr, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + tr);
    ctx.lineTo(x + w, y + h - br);
    ctx.quadraticCurveTo(x + w, y + h, x + w - br, y + h);
    ctx.lineTo(x + bl, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - bl);
    ctx.lineTo(x, y + tl);
    ctx.quadraticCurveTo(x, y, x + tl, y);
    ctx.closePath();
}

function _resolveOverlayFontWeight(weight, fallback = 400) {
    const n = parseInt(weight, 10);
    const base = Number.isFinite(n) ? n : fallback;
    return Math.max(100, Math.min(900, base));
}

function _resolveOverlayFallback(fontFamily) {
    const f = String(fontFamily || '').toLowerCase();
    const serifHints = [
        'serif', 'times', 'georgia', 'playfair', 'crimson', 'lora', 'gelasio',
        'caslon', 'vidaloka', 'yeseva', 'dm serif', 'young serif', 'rye',
        'song', 'ming', 'mincho',
    ];
    return serifHints.some(k => f.includes(k)) ? 'serif' : 'sans-serif';
}

// ═══════════════════════════════════════════════════════
// 3. Overlay Manager
// ═══════════════════════════════════════════════════════

class OverlayManager {
    constructor() {
        this.overlays = [];
    }

    addOverlay(ov) {
        this.overlays.push(ov);
        this._sortByZ();
        return ov;
    }

    removeOverlay(id) {
        this.overlays = this.overlays.filter(o => o.id !== id);
    }

    getOverlay(id) {
        return this.overlays.find(o => o.id === id) || null;
    }

    updateOverlay(id, updates) {
        const ov = this.getOverlay(id);
        if (ov) Object.assign(ov, updates);
        return ov;
    }

    /**
     * 获取在指定时间可见的覆层列表。
     */
    getVisibleOverlays(currentTime) {
        // 确保所有覆层都有 ID，防止因缺少 ID 导致“跟随滚动字幕”绑定失效
        for (const ov of this.overlays) {
            if (!ov.id) {
                ov.id = 'ov_' + Math.random().toString(36).slice(2, 9) + '_' + Date.now().toString(36);
            }
        }
        return this.overlays.filter(ov => {
            if (ov.disabled) return false;
            const start = parseFloat(ov.start || 0);
            const end = parseFloat(ov.end || 0);
            return currentTime >= start && currentTime <= end;
        });
    }

    /**
     * 渲染所有可见覆层。
     */
    renderAll(ctx, currentTime, canvasW = 1920, canvasH = 1080) {
        const visible = this.getVisibleOverlays(currentTime);
        // 离开覆层时间段后立即静音缓存的视频，避免画面已消失但原声继续播放。
        const audiblePaths = new Set(visible
            .filter(ov => ov.media_audio_enabled === true && (ov.type === 'video' || ov.type === 'image'))
            .map(ov => _resolveFolderMediaPath(ov, currentTime))
            .filter(Boolean));
        Object.entries(_videoCache).forEach(([path, video]) => {
            if (!audiblePaths.has(path) && !video.muted) video.muted = true;
        });
        // 将完整覆层列表引用注入每个可见覆层，供「跟随滚动绑定」使用
        for (const ov of visible) {
            ov._allOverlays = this.overlays;
        }
        // 确保 scroll 覆层先渲染，这样绑定它们的媒体覆层能读到 _scrollBodyFirstLineY
        const scrollFirst = visible.slice().sort((a, b) => {
            const aIsScroll = a.type === 'scroll' ? 0 : 1;
            const bIsScroll = b.type === 'scroll' ? 0 : 1;
            return aIsScroll - bIsScroll;
        });
        for (const ov of scrollFirst) {
            drawOverlay(ctx, ov, currentTime, canvasW, canvasH);
        }
    }

    /**
     * Hit testing — 检测点击是否命中某个覆层。
     */
    hitTest(mx, my, currentTime) {
        const visible = this.getVisibleOverlays(currentTime);
        // 从上到下（后绘制的在上面）
        for (let i = visible.length - 1; i >= 0; i--) {
            const ov = visible[i];
            const scope=typeof window==='object'?window:null;
            const half=scope?.ReelsMediaWindow?.halfScreen(ov.media_window_mode,ov.media_split_angle,scope?._reelsState?.targetWidth || 1080,scope?._reelsState?.targetHeight || 1920);
            if(half && Math.abs(half.angle)>0.0001){if(scope.ReelsMediaWindow.contains(half.polygon,mx,my))return ov;continue;}
            const x = parseFloat(ov.x || 0);
            // For textcard: use rendered Y/H (auto-fit) if available
            const y = ov.type === 'textcard' && ov._renderedY != null
                ? ov._renderedY : parseFloat(ov.y || 0);
            const w = parseFloat(ov.w || 100);
            const h = ov.type === 'textcard' && ov._renderedH != null
                ? ov._renderedH : parseFloat(ov.h || 100);
            if (mx >= x && mx <= x + w && my >= y && my <= y + h) {
                return ov;
            }
        }
        return null;
    }

    _sortByZ() {
        this.overlays.sort((a, b) => (a.z || 0) - (b.z || 0));
    }

    toJSON() {
        return this.overlays.map(o => ({ ...o }));
    }

    static fromJSON(data) {
        const mgr = new OverlayManager();
        if (Array.isArray(data)) {
            mgr.overlays = data.map(d => ({ ...d }));
        }
        return mgr;
    }
}

// ═══════════════════════════════════════════════════════
// 4. Drawing Helpers
// ═══════════════════════════════════════════════════════

function _resolveOverlayTextFill(ctx, colorVal, x, y, fontSize, textW = 0, direction = 'horizontal') {
    if (typeof colorVal === 'string' && colorVal.includes(',')) {
        const colors = colorVal.split(',').map(c => c.trim()).filter(Boolean);
        if (colors.length >= 2) {
            const fs = Number(fontSize) || 40;
            const w = Number(textW) || fs * 3;
            let grad;
            if (direction === 'vertical') {
                grad = ctx.createLinearGradient(x, y - fs * 0.8, x, y + fs * 0.25);
            } else if (direction === 'diagonal') {
                grad = ctx.createLinearGradient(x, y - fs * 0.8, x + w, y + fs * 0.25);
            } else if (direction === 'diagonal-up') {
                // ↗ 左下 → 右上
                grad = ctx.createLinearGradient(x, y + fs * 0.25, x + w, y - fs * 0.8);
            } else {
                // 默认水平渐变：从左到右流光
                grad = ctx.createLinearGradient(x, y, x + w, y);
            }
            colors.forEach((c, i) => {
                grad.addColorStop(i / Math.max(1, colors.length - 1), c);
            });
            return grad;
        }
    }
    return colorVal;
}

// Stroke the current background path; opacity is independent of the background fill.
function _buildConnectedOverlayPath(ctx, rawSlabs, outerRadius = 8, concaveRadius = 10, snapThreshold = 18) {
        const slabs = rawSlabs.map(s => ({
            left: Number(s.left) || 0,
            right: Number(s.right) || 0,
            top: Number(s.top) || 0,
            bottom: Number(s.bottom) || 0,
        }));
        const N = slabs.length;
        if (N === 0) return;

        // 1. 相邻行宽度接近时自动对齐，避免产生微小台阶和小凸角
        const thr = Math.max(0, Number(snapThreshold) || 0);
        if (thr > 0) {
            for (let pass = 0; pass < 2; pass++) {
                for (let i = 0; i < N - 1; i++) {
                    const dl = Math.abs(slabs[i].left - slabs[i + 1].left);
                    if (dl > 0 && dl <= thr) {
                        const minL = Math.min(slabs[i].left, slabs[i + 1].left);
                        slabs[i].left = minL;
                        slabs[i + 1].left = minL;
                    }
                    const dr = Math.abs(slabs[i].right - slabs[i + 1].right);
                    if (dr > 0 && dr <= thr) {
                        const maxR = Math.max(slabs[i].right, slabs[i + 1].right);
                        slabs[i].right = maxR;
                        slabs[i + 1].right = maxR;
                    }
                }
            }
        }

        // 2. 相邻行垂直缝隙桥接，形成连续无断缝的上下边界
        for (let i = 0; i < N - 1; i++) {
            const seamY = (slabs[i].bottom + slabs[i + 1].top) / 2;
            slabs[i].bottom = seamY;
            slabs[i + 1].top = seamY;
        }

        // 3. 按顺时针顺序提取正交多边形顶点
        const rawPts = [];
        const pushPt = (x, y) => {
            if (rawPts.length > 0) {
                const prev = rawPts[rawPts.length - 1];
                if (Math.hypot(x - prev.x, y - prev.y) < 0.5) return;
            }
            rawPts.push({ x, y });
        };

        pushPt(slabs[0].left, slabs[0].top);
        pushPt(slabs[0].right, slabs[0].top);
        for (let i = 0; i < N; i++) {
            pushPt(slabs[i].right, slabs[i].bottom);
            if (i < N - 1 && Math.abs(slabs[i + 1].right - slabs[i].right) >= 0.5) {
                pushPt(slabs[i + 1].right, slabs[i].bottom);
            }
        }
        pushPt(slabs[N - 1].left, slabs[N - 1].bottom);
        for (let i = N - 1; i >= 0; i--) {
            pushPt(slabs[i].left, slabs[i].top);
            if (i > 0 && Math.abs(slabs[i - 1].left - slabs[i].left) >= 0.5) {
                pushPt(slabs[i - 1].left, slabs[i].top);
            }
        }
        if (rawPts.length > 1) {
            const first = rawPts[0];
            const last = rawPts[rawPts.length - 1];
            if (Math.hypot(first.x - last.x, first.y - last.y) < 0.5) {
                rawPts.pop();
            }
        }

        // 移除共线冗余点
        const pts = [];
        const M = rawPts.length;
        for (let i = 0; i < M; i++) {
            const prev = rawPts[(i - 1 + M) % M];
            const curr = rawPts[i];
            const next = rawPts[(i + 1) % M];
            const v1x = curr.x - prev.x, v1y = curr.y - prev.y;
            const v2x = next.x - curr.x, v2y = next.y - curr.y;
            const cross = v1x * v2y - v1y * v2x;
            if (Math.abs(cross) > 0.01) {
                pts.push(curr);
            }
        }

        const K = pts.length;
        if (K < 3) return;

        const outR = Math.max(0, Number(outerRadius) || 0);
        const inR = Math.max(0, Number(concaveRadius) || 0);

        // 从第一条边的中点开始，使用 arcTo 绘制外圆角与内凹圆角
        const mid0 = {
            x: (pts[K - 1].x + pts[0].x) / 2,
            y: (pts[K - 1].y + pts[0].y) / 2,
        };
        ctx.moveTo(mid0.x, mid0.y);
        for (let i = 0; i < K; i++) {
            const prev = pts[(i - 1 + K) % K];
            const curr = pts[i];
            const next = pts[(i + 1) % K];
            const v1x = curr.x - prev.x, v1y = curr.y - prev.y;
            const v2x = next.x - curr.x, v2y = next.y - curr.y;
            const len1 = Math.hypot(v1x, v1y);
            const len2 = Math.hypot(v2x, v2y);
            const cross = v1x * v2y - v1y * v2x;
            // 屏幕坐标系顺时针多边形：cross > 0 为外凸角，cross < 0 为内凹角
            const targetR = cross >= 0 ? outR : inR;
            const r = Math.max(0, Math.min(targetR, len1 / 2, len2 / 2));
            if (r > 0.25) {
                ctx.arcTo(curr.x, curr.y, next.x, next.y, r);
            } else {
                ctx.lineTo(curr.x, curr.y);
            }
        }
        ctx.closePath();
    }

// Keep paragraph breaks and non-overlapping columns separate instead of bridging them.
function _traceConnectedOverlayBackground(ctx, slabs, ov, prefix, radius) {
    const concave=Math.max(0,Number(ov[prefix+'_bg_concave_radius'] ?? 10)||0);
    const snap=Math.max(0,Number(ov[prefix+'_bg_snap_threshold'] ?? 18)||0);
    const groups=[];
    for(const slab of slabs){
        const last=groups.at(-1)?.at(-1);
        if(!last || slab.top-last.bottom > (last.bottom-last.top)*.7 || Math.min(last.right,slab.right)<=Math.max(last.left,slab.left)) groups.push([]);
        groups.at(-1).push(slab);
    }
    ctx.beginPath();
    for(const group of groups)_buildConnectedOverlayPath(ctx,group,radius,concave,snap);
}

function _strokeSectionBackground(ctx, ov, prefix) {
    const key = prefix + '_bg_border_';
    const width = Math.max(0, Math.min(100, Number(ov[key + 'width'] ?? 3) || 0));
    if (!ov[key + 'enabled'] || !width) return;
    ctx.save();
    ctx.globalAlpha *= Math.max(0, Math.min(100, Number(ov[key + 'opacity'] ?? 100) || 0)) / 100;
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    ctx.strokeStyle = ov[key + 'color'] || '#ffffff';
    ctx.lineWidth = width;
    const style = ov[key + 'style'] || 'solid';
    ctx.lineCap = style === 'dotted' ? 'round' : 'butt';
    ctx.setLineDash(style === 'dashed' ? [width * 3, width * 2] : style === 'dotted' ? [0, width * 2] : []);
    ctx.stroke();
    ctx.restore();
}

function _resolveOverlayBgFill(ctx, colorVal, x, y, w, h, direction = 'horizontal') {
    if (typeof colorVal === 'string' && colorVal.includes(',')) {
        const colors = colorVal.split(',').map(c => c.trim()).filter(Boolean);
        if (colors.length >= 2) {
            let grad;
            if (direction === 'vertical') {
                grad = ctx.createLinearGradient(x, y, x, y + h);
            } else if (direction === 'diagonal') {
                grad = ctx.createLinearGradient(x, y, x + w, y + h);
            } else if (direction === 'diagonal-up') {
                grad = ctx.createLinearGradient(x, y + h, x + w, y);
            } else {
                grad = ctx.createLinearGradient(x, y, x + w, y);
            }
            colors.forEach((c, i) => {
                grad.addColorStop(i / Math.max(1, colors.length - 1), c);
            });
            return grad;
        }
    }
    return colorVal;
}

function _resolveOverlayDecoFill(ctx, colorVal, color2Val, startX, startY, endX, endY, isVertical = false, direction = 'horizontal', thickness = 3) {
    let colors = [];
    if (typeof colorVal === 'string' && colorVal.includes(',')) {
        colors = colorVal.split(',').map(c => c.trim()).filter(Boolean);
    } else if (color2Val && typeof color2Val === 'string' && color2Val !== colorVal) {
        colors = [colorVal || '#FFD700', color2Val];
    }

    if (colors.length >= 2) {
        const th = Math.max(Number(thickness) || 3, 20);
        let gx1 = startX, gy1 = startY, gx2 = endX, gy2 = endY;
        if (!isVertical) {
            if (direction === 'vertical') {
                gx1 = (startX + endX) / 2;
                gy1 = startY - th;
                gx2 = gx1;
                gy2 = startY + th;
            } else if (direction === 'diagonal') {
                gx1 = startX;
                gy1 = startY - th;
                gx2 = endX;
                gy2 = endY + th;
            } else if (direction === 'diagonal-up') {
                gx1 = startX;
                gy1 = endY + th;
                gx2 = endX;
                gy2 = startY - th;
            } else {
                gx1 = startX;
                gy1 = startY;
                gx2 = endX;
                gy2 = endY;
            }
        } else {
            if (direction === 'horizontal') {
                gx1 = startX - th;
                gy1 = (startY + endY) / 2;
                gx2 = startX + th;
                gy2 = gy1;
            } else if (direction === 'diagonal') {
                gx1 = startX - th;
                gy1 = startY;
                gx2 = startX + th;
                gy2 = endY;
            } else {
                gx1 = startX;
                gy1 = startY;
                gx2 = endX;
                gy2 = endY;
            }
        }
        const grad = ctx.createLinearGradient(gx1, gy1, gx2, gy2);
        colors.forEach((c, i) => {
            grad.addColorStop(i / Math.max(1, colors.length - 1), c);
        });
        return grad;
    }
    return colorVal || '#FFD700';
}

function _measureTextWithLetterSpacing(ctx, text, letterSpacing = 0) {
    const spacing = parseFloat(letterSpacing || 0);
    const baseW = ctx.measureText(text || '').width;
    if (!spacing || !text || text.length <= 1) return baseW;
    return baseW + spacing * (text.length - 1);
}

function _fillTextWithLetterSpacing(ctx, text, x, y, letterSpacing = 0) {
    const spacing = parseFloat(letterSpacing || 0);
    if (!spacing) {
        ctx.fillText(text, x, y);
        return;
    }
    let cx = x;
    for (const ch of text) {
        ctx.fillText(ch, cx, y);
        cx += ctx.measureText(ch).width + spacing;
    }
}

function _strokeTextWithLetterSpacing(ctx, text, x, y, letterSpacing = 0) {
    const spacing = parseFloat(letterSpacing || 0);
    if (!spacing) {
        ctx.strokeText(text, x, y);
        return;
    }
    let cx = x;
    for (const ch of text) {
        ctx.strokeText(ch, cx, y);
        cx += ctx.measureText(ch).width + spacing;
    }
}

function _wrapText(ctx, text, maxWidth, letterSpacing = 0) {
    if (maxWidth <= 0) return [text];
    const paragraphs = text.split('\n');
    const lines = [];
    for (const para of paragraphs) {
        if (!para) { lines.push(''); continue; }
        // Split into segments: CJK chars are each their own segment, whitespace-separated words stay together
        const segments = [];
        let buf = '';
        for (let i = 0; i < para.length; i++) {
            const ch = para[i];
            const isCJK = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\u3000-\u303f\uff00-\uffef\u2e80-\u2eff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(ch);
            if (isCJK) {
                if (buf) { segments.push(buf); buf = ''; }
                segments.push(ch);
            } else {
                buf += ch;
                // Flush at whitespace boundaries
                if (/\s/.test(ch)) {
                    segments.push(buf); buf = '';
                }
            }
        }
        if (buf) segments.push(buf);

        let line = '';
        for (const seg of segments) {
            const test = line + seg;
            if (_measureTextWithLetterSpacing(ctx, test, letterSpacing) > maxWidth && line) {
                lines.push(line.trimEnd());
                line = '';
            }

            if (_measureTextWithLetterSpacing(ctx, seg, letterSpacing) > maxWidth) {
                for (const ch of seg) {
                    const charTest = line + ch;
                    if (_measureTextWithLetterSpacing(ctx, charTest, letterSpacing) > maxWidth && line) {
                        lines.push(line.trimEnd());
                        line = ch;
                    } else {
                        line = charTest;
                    }
                }
            } else {
                line = line ? line + seg : seg;
            }
        }
        if (line) lines.push(line.trimEnd());
    }
    return lines;
}

function _drawTextLines(ctx, lines, boxX, boxY, boxW, lineHeight, align, color) {
    ctx.fillStyle = color;
    let yc = boxY + lineHeight * 0.77; // approx baseline
    for (const line of lines) {
        const lx = _alignX(ctx, line, boxX, boxW, align);
        ctx.fillText(line, lx, yc);
        yc += lineHeight;
    }
}

/**
 * 绘制一行富文本（覆层 textcard 用）
 * 在已有的行级渲染中替换 fillText，按 styled_ranges 分段渲染。
 * 
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} lineText       本行文字
 * @param {string} fullText       完整段落文字（用于定位 lineText 在 fullText 中的偏移）
 * @param {Array}  styledRanges   styled_ranges 数组
 * @param {number} x              行起点 X
 * @param {number} y              行基线 Y
 * @param {string} defaultColor   默认颜色
 * @param {number} baseFontSize   基础字号
 * @param {string} fontFamily     字体族
 * @param {string} fallback       字体 fallback
 * @param {number} fontWeight     字重
 * @param {number} letterSpacing  字母间距
 * @param {number} boxX           可选：文本区左侧，用真实富文本宽度重新对齐
 * @param {number} boxW           可选：文本区宽度
 * @param {string} align          可选：left | center | right
 */
function _drawRichLine(ctx, lineText, fullText, styledRanges, x, y, defaultColor, baseFontSize, fontFamily, fallback, fontWeight, letterSpacing, boxX, boxW, align, direction = 'horizontal') {
    // Rich chunks may change font size/weight. Keep those changes local so the
    // next line's alignment is still measured with the section's base font.
    ctx.save();
    // 定位 lineText 在 fullText 中的字符偏移
    // 使用 _drawRichLine._searchFrom 跟踪当前搜索起点, 避免重复行错位
    const searchFrom = _drawRichLine._searchFrom || 0;
    let lineStart = fullText.indexOf(lineText, searchFrom);
    if (lineStart < 0) {
        // 原始搜索失败 —— 尝试从头搜索 (首次调用场景)
        lineStart = fullText.indexOf(lineText);
    }
    if (lineStart < 0) {
        // fallback: 找不到就原样绘制
        ctx.fillStyle = _resolveOverlayTextFill(ctx, defaultColor, x, y, baseFontSize, _measureTextWithLetterSpacing(ctx, lineText, letterSpacing), direction);
        if (letterSpacing && typeof _fillTextWithLetterSpacing !== 'undefined' && typeof ctx.letterSpacing === 'undefined') {
            _fillTextWithLetterSpacing(ctx, lineText, x, y, letterSpacing);
        } else {
            ctx.fillText(lineText, x, y);
        }
        ctx.restore();
        return;
    }
    // 推进搜索游标到本行末尾，供下一次同段落调用使用
    _drawRichLine._searchFrom = lineStart + lineText.length;

    const lineEnd = lineStart + lineText.length;

    const baseStyle = {
        fontsize: baseFontSize,
        color: defaultColor,
        bold: (fontWeight >= 700),
    };

    // 利用 ReelsRichText.splitByRanges 对整段文字做切片，然后只取落入本行的部分
    const allChunks = ReelsRichText.splitByRanges(fullText, styledRanges, baseStyle);

    // `_alignX` previously measured the whole line using one font.  That is
    // wrong for a mixed normal/bold line: center/right aligned text drifts and
    // can run past its section.  Measure the exact chunks before choosing X.
    if (Number.isFinite(boxX) && Number.isFinite(boxW) && align && align !== 'left') {
        let richWidth = 0;
        let previousText = false;
        for (const chunk of allChunks) {
            const overlapStart = Math.max(chunk.start, lineStart);
            const overlapEnd = Math.min(chunk.end, lineEnd);
            if (overlapStart >= overlapEnd) continue;
            const segText = fullText.substring(overlapStart, overlapEnd);
            if (!segText) continue;
            const tokFs = chunk.style.fontsize || baseFontSize;
            const tokBold = chunk.style.bold ? 700 : fontWeight;
            ctx.font = `${tokBold} ${tokFs}px "${fontFamily}", ${fallback}`;
            richWidth += _measureTextWithLetterSpacing(ctx, segText, letterSpacing);
            // _measureTextWithLetterSpacing only includes spacing within a
            // chunk, so add the gap at a style boundary once.
            if (previousText && letterSpacing) richWidth += parseFloat(letterSpacing);
            previousText = true;
        }
        x = align === 'right' ? boxX + boxW - richWidth : boxX + (boxW - richWidth) / 2;
    }
    
    let cx = x;
    for (const chunk of allChunks) {
        // 计算 chunk 与本行的交集
        const overlapStart = Math.max(chunk.start, lineStart);
        const overlapEnd = Math.min(chunk.end, lineEnd);
        if (overlapStart >= overlapEnd) continue;

        const segText = fullText.substring(overlapStart, overlapEnd);
        if (!segText) continue;

        // 设置该 token 的字体
        const tokFs = chunk.style.fontsize || baseFontSize;
        const tokBold = chunk.style.bold ? 700 : fontWeight;
        const tokFont = `${tokBold} ${tokFs}px "${fontFamily}", ${fallback}`;
        ctx.font = tokFont;
        const segColor = chunk.style.color || defaultColor;
        const segW = _measureTextWithLetterSpacing(ctx, segText, letterSpacing);
        ctx.fillStyle = _resolveOverlayTextFill(ctx, segColor, cx, y, tokFs, segW, direction);
        
        if (letterSpacing && typeof _fillTextWithLetterSpacing !== 'undefined' && typeof ctx.letterSpacing === 'undefined') {
            _fillTextWithLetterSpacing(ctx, segText, cx, y, letterSpacing);
        } else {
            ctx.fillText(segText, cx, y);
        }
        cx += _measureTextWithLetterSpacing(ctx, segText, letterSpacing);
    }
    ctx.restore();
}

function _alignX(ctx, text, boxX, boxW, align, letterSpacing = 0) {
    if (align === 'center') {
        const tw = _measureTextWithLetterSpacing(ctx, text, letterSpacing);
        return boxX + (boxW - tw) / 2;
    } else if (align === 'right') {
        const tw = _measureTextWithLetterSpacing(ctx, text, letterSpacing);
        return boxX + boxW - tw;
    }
    return boxX;
}

function _roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
}

function _brushHexToRgba(hex, alpha = 1) {
    hex = String(hex || '#000000').replace('#', '');
    if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
    if (hex.length < 6) hex = '000000';
    const num = parseInt(hex.slice(0, 6), 16) || 0;
    const r = (num >> 16) & 255;
    const g = (num >> 8) & 255;
    const b = num & 255;
    return `rgba(${r},${g},${b},${alpha})`;
}

function _drawOrganicBlobPath(ctx, x, y, w, h, seed, rnd) {
    if (!rnd) {
        let s = (seed * 16807) % 2147483647;
        rnd = () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
    }
    const rad = Math.min(18, h * 0.35);
    ctx.moveTo(x + rad, y);
    ctx.bezierCurveTo(x + w * 0.3, y - (rnd() - 0.3) * 6, x + w * 0.7, y + (rnd() - 0.3) * 6, x + w - rad, y);
    ctx.quadraticCurveTo(x + w + (rnd() - 0.2) * 8, y + rad * 0.5, x + w, y + rad);
    ctx.bezierCurveTo(x + w + (rnd() - 0.5) * 10, y + h * 0.3, x + w - (rnd() - 0.5) * 8, y + h * 0.7, x + w - rad * 0.5, y + h - rad);
    ctx.quadraticCurveTo(x + w, y + h + (rnd() - 0.2) * 6, x + w - rad, y + h);
    ctx.bezierCurveTo(x + w * 0.7, y + h + (rnd() - 0.3) * 6, x + w * 0.3, y + h - (rnd() - 0.3) * 6, x + rad, y + h);
    ctx.quadraticCurveTo(x - (rnd() - 0.2) * 8, y + h - rad * 0.5, x, y + h - rad);
    ctx.bezierCurveTo(x - (rnd() - 0.5) * 10, y + h * 0.7, x + (rnd() - 0.5) * 8, y + h * 0.3, x + rad * 0.5, y + rad);
    ctx.quadraticCurveTo(x, y - (rnd() - 0.2) * 6, x + rad, y);
    ctx.closePath();
}

const ReelsBrushEngine = {
    _masks: {},
    _tintCache: {},
    _rawImages: {},
    _cutoutImages: {},
    // 内置笔刷素材已移除：图片背景完全由用户导入的图片提供
    _builtinB64: {},

    _powLut: (() => {
        const lut = new Uint8Array(256);
        for (let i = 0; i < 256; i++) {
            lut[i] = Math.min(255, Math.round(Math.pow(i / 255, 0.72) * 255));
        }
        return lut;
    })(),

    /**
     * 针对笔刷透明度生成 S 曲线实心增强查找表：
     * - 核心笔触区域直接推向 255 纯实心（彻底遮挡视频背景，保证文字清晰可读，消除半透明透底）
     * - 边缘笔刷毛刺、飞白、水痕过渡区域以 S 曲线平滑羽化，保留丰富的艺术质感
     * - 微弱噪点（alpha <= 6）直接归零，防止外接矩形边缘脏线
     */
    getSolidLut(strength = 1.0) {
        const str = (typeof strength === 'number' && !isNaN(strength)) ? Math.max(0, Math.min(1.0, strength)) : 1.0;
        const lut = new Uint8Array(256);
        const edgeLow = 6;
        const edgeHigh = Math.max(edgeLow + 1, Math.round(255 - str * 180));
        for (let a = 0; a < 256; a++) {
            if (a <= 0) { lut[a] = 0; continue; }
            if (a <= edgeLow) { lut[a] = Math.round(a * (1 - str)); continue; }
            if (a >= edgeHigh) { lut[a] = Math.min(255, Math.round(a + (255 - a) * str)); continue; }
            const t = (a - edgeLow) / (edgeHigh - edgeLow);
            const smooth = t * t * (3 - 2 * t);
            const boosted = Math.round(smooth * 255);
            lut[a] = Math.round(a * (1 - str) + boosted * str);
        }
        return lut;
    },

    /**
     * 性能优化：缓存每张源图「实心度处理前」的基础像素数据（亮度→透明度的逐像素计算只做一次），
     * 拖动「笔刷实心度」滑块时只需对 alpha 通道套一次查找表，避免每帧重复 getImageData + 全量亮度运算。
     */
    _baseCache: (typeof WeakMap !== 'undefined') ? new WeakMap() : null,

    _getProcessSize(img) {
        const nw = img.naturalWidth || img.width;
        const nh = img.naturalHeight || img.height;
        if (!nw || !nh) return null;
        // 超大图降采样至最宽1200/最高600，大幅降低显存和像素运算耗时，消除卡顿
        let w = nw, h = nh;
        if (w > 1200 || h > 600) {
            const ratio = Math.min(1200 / w, 600 / h);
            w = Math.max(1, Math.round(w * ratio));
            h = Math.max(1, Math.round(h * ratio));
        }
        return { w, h };
    },

    _readSourcePixels(img, w, h) {
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, w, h);
        return ctx.getImageData(0, 0, w, h).data;
    },

    _getBaseEntry(img) {
        if (!this._baseCache) return {};
        let entry = this._baseCache.get(img);
        if (!entry) {
            entry = {};
            this._baseCache.set(img, entry);
        }
        return entry;
    },

    /** 纯白蒙版的基础 alpha（未经实心度增强） */
    _getMaskBase(img) {
        const entry = this._getBaseEntry(img);
        if (entry.mask) return entry.mask;
        const size = this._getProcessSize(img);
        if (!size) return null;
        const { w, h } = size;
        const d = this._readSourcePixels(img, w, h);
        const lut = this._powLut;
        const alphaArr = new Uint8Array(w * h);

        // 检测是否已经包含透明通道
        let hasAlpha = false;
        for (let i = 3; i < d.length; i += 40) {
            if (d[i] < 240) { hasAlpha = true; break; }
        }

        if (!hasAlpha) {
            // 是黑白底图（如白底黑墨、黑底白墨）
            const cornerLum = d[0] * 0.299 + d[1] * 0.587 + d[2] * 0.114;
            const isWhiteBg = cornerLum > 128;

            for (let y = 0; y < h; y++) {
                const borderDistY = Math.min(y, h - 1 - y);
                const yFactor = borderDistY < 12 ? (borderDistY / 12) : 1;

                for (let x = 0; x < w; x++) {
                    const p = y * w + x;
                    const i = p * 4;
                    const lum = Math.round(d[i] * 0.299 + d[i+1] * 0.587 + d[i+2] * 0.114);
                    let alpha = 0;
                    if (isWhiteBg) {
                        if (lum < 235) {
                            const normIdx = Math.max(0, Math.min(255, Math.round((235 - lum) * 255 / 225)));
                            alpha = lut[normIdx];
                        }
                    } else {
                        if (lum > 20) {
                            const normIdx = Math.max(0, Math.min(255, Math.round((lum - 20) * 255 / 225)));
                            alpha = lut[normIdx];
                        }
                    }

                    // 边缘平滑淡化，防止矩形硬切边缘
                    if (yFactor < 1) alpha = Math.round(alpha * yFactor);
                    const borderDistX = Math.min(x, w - 1 - x);
                    if (borderDistX < 8) alpha = Math.round(alpha * (borderDistX / 8));

                    alphaArr[p] = alpha;
                }
            }
        } else {
            for (let p = 0, i = 3; p < alphaArr.length; p++, i += 4) {
                alphaArr[p] = d[i];
            }
        }
        entry.mask = { w, h, alpha: alphaArr };
        return entry.mask;
    },

    /** 去底彩色图的基础 RGBA（alpha 未经实心度增强） */
    _getCutoutBase(img) {
        const entry = this._getBaseEntry(img);
        if (entry.cutout) return entry.cutout;
        const size = this._getProcessSize(img);
        if (!size) return null;
        const { w, h } = size;
        const d = this._readSourcePixels(img, w, h);
        const lut = this._powLut;

        // 检测是否已经包含透明通道（如透明PNG）
        let hasAlpha = false;
        for (let i = 3; i < d.length; i += 40) {
            if (d[i] < 240) { hasAlpha = true; break; }
        }

        if (!hasAlpha) {
            // 边角亮度判定底色
            const cornerLum = d[0] * 0.299 + d[1] * 0.587 + d[2] * 0.114;
            const isWhiteBg = cornerLum > 128;

            for (let y = 0; y < h; y++) {
                const borderDistY = Math.min(y, h - 1 - y);
                const yFactor = borderDistY < 10 ? (borderDistY / 10) : 1;

                for (let x = 0; x < w; x++) {
                    const i = (y * w + x) * 4;
                    const r = d[i], g = d[i+1], b = d[i+2];
                    const lum = Math.round(r * 0.299 + g * 0.587 + b * 0.114);
                    let alpha = 0;
                    if (isWhiteBg) {
                        if (lum < 240) {
                            const normIdx = Math.max(0, Math.min(255, Math.round((240 - lum) * 255 / 230)));
                            alpha = lut[normIdx];
                        }
                    } else {
                        if (lum > 20) {
                            const normIdx = Math.max(0, Math.min(255, Math.round((lum - 20) * 255 / 225)));
                            alpha = lut[normIdx];
                        }
                    }

                    // 边缘渐隐淡化，防止矩形硬切边
                    if (yFactor < 1) alpha = Math.round(alpha * yFactor);
                    const borderDistX = Math.min(x, w - 1 - x);
                    if (borderDistX < 8) alpha = Math.round(alpha * (borderDistX / 8));

                    // 保持原始 RGB 彩色，仅提取透明度通道
                    d[i+3] = alpha;
                }
            }
        }
        entry.cutout = { w, h, data: d };
        return entry.cutout;
    },

    /**
     * 自动处理传入的任何图片（黑白蒙版图/白底黑墨/黑底白墨/透明PNG），生成纯白染色蒙版 Canvas
     * 支持 solidStrength 笔刷主体实心度调节（0~1.0，默认1.0）
     */
    processMaskCanvas(img, solidStrength = 1.0) {
        try {
            if (typeof document === 'undefined') return null;
            const base = this._getMaskBase(img);
            if (!base) return null;
            const { w, h, alpha } = base;
            const solidLut = this.getSolidLut(solidStrength);

            const c = document.createElement('canvas');
            c.width = w;
            c.height = h;
            const ctx = c.getContext('2d');
            const idata = ctx.createImageData(w, h);
            const d = idata.data;
            // 核心实心化增强：核心区域压实为255实心，边缘柔和羽化
            for (let p = 0, i = 0; p < alpha.length; p++, i += 4) {
                d[i] = 255; d[i+1] = 255; d[i+2] = 255; d[i+3] = solidLut[alpha[p]];
            }
            ctx.putImageData(idata, 0, 0);
            return c;
        } catch (e) {
            console.error('[ReelsBrushEngine] processMaskCanvas error:', e);
            return null;
        }
    },

    /**
     * 针对彩色底图（如白底彩色水彩/水墨、黑底高光等）：
     * 智能扣除背景，同时完整保留笔触原图丰富的 RGB 彩色和水彩水痕质感
     * 支持 solidStrength 核心实心度增强
     */
    processCutoutCanvas(img, solidStrength = 1.0) {
        try {
            if (typeof document === 'undefined') return null;
            const base = this._getCutoutBase(img);
            if (!base) return null;
            const { w, h, data: src } = base;
            const solidLut = this.getSolidLut(solidStrength);

            const c = document.createElement('canvas');
            c.width = w;
            c.height = h;
            const ctx = c.getContext('2d');
            const idata = ctx.createImageData(w, h);
            const d = idata.data;
            d.set(src);
            for (let i = 3; i < d.length; i += 4) {
                d[i] = solidLut[d[i]];
            }
            ctx.putImageData(idata, 0, 0);
            return c;
        } catch (e) {
            console.error('[ReelsBrushEngine] processCutoutCanvas error:', e);
            return null;
        }
    },

    /** 实心度变体缓存上限，防止连续拖动滑块时内存暴增 */
    _rememberVariant(store, key, value) {
        if (!this._variantKeys) this._variantKeys = [];
        store[key] = value;
        this._variantKeys.push([store, key]);
        while (this._variantKeys.length > 24) {
            const [s, k] = this._variantKeys.shift();
            delete s[k];
        }
    },

    /** 超大导入图降采样为绘制用 Canvas，避免每帧从数千像素原图缩放绘制 */
    _downscaleForDraw(img) {
        try {
            if (typeof document === 'undefined') return img;
            const nw = img.naturalWidth || img.width;
            const nh = img.naturalHeight || img.height;
            const maxW = 2048, maxH = 1024;
            if (!nw || !nh || (nw <= maxW && nh <= maxH)) return img;
            const ratio = Math.min(maxW / nw, maxH / nh);
            const c = document.createElement('canvas');
            c.width = Math.max(1, Math.round(nw * ratio));
            c.height = Math.max(1, Math.round(nh * ratio));
            const ctx = c.getContext('2d');
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(img, 0, 0, c.width, c.height);
            return c;
        } catch (_) {
            return img;
        }
    },

    _customBrushes: {},
    _customLoaded: false,

    /**
     * 用户自定义笔刷注册接口（支持：白底黑墨图、黑底白墨图、透明PNG、彩色原图、Base64 或 Image 元素）
     */
    registerBrush(name, imageOrDataUrl, displayName) {
        if (!name || !imageOrDataUrl) return;
        const dName = displayName || name;
        this._customBrushes[name] = { name, dataUrl: (typeof imageOrDataUrl === 'string' ? imageOrDataUrl : (this._customBrushes[name]?.dataUrl || '')), displayName: dName };

        // 同一张图已经加载过，直接复用（同名但换了图片则重新加载）
        if (!this._rawSrc) this._rawSrc = {};
        if (this._rawImages[name] && (typeof imageOrDataUrl !== 'string' || this._rawSrc[name] === imageOrDataUrl)) return;

        if (typeof imageOrDataUrl === 'string') {
            // 性能：渲染循环每帧都会调用 registerBrush，图片解码完成前不能重复 new Image()
            // （大图 dataURL 每帧重新解码是笔刷卡顿的主要来源）；同一 URL 加载失败也不再每帧重试
            if (!this._pendingLoads) this._pendingLoads = {};
            if (this._pendingLoads[name] === imageOrDataUrl) return;
            this._pendingLoads[name] = imageOrDataUrl;
            if (typeof Image !== 'undefined') {
                const img = new Image();
                img.crossOrigin = 'anonymous';
                let done = false;
                const onLoaded = () => {
                    if (done) return;
                    done = true;
                    if (this._pendingLoads[name] !== imageOrDataUrl) return; // 已被更新的图片取代
                    delete this._pendingLoads[name];
                    // 默认就是一张普通图片：只解码保存，不做任何像素计算；
                    // 只有切到「染成背景颜色」时才会按需生成染色蒙版（见 getMask）
                    this._rawImages[name] = this._downscaleForDraw(img);
                    this._rawSrc[name] = imageOrDataUrl;
                    delete this._masks[name];
                    delete this._cutoutImages[name];
                    this._clearVariants(name);
                };
                img.onload = onLoaded;
                img.src = imageOrDataUrl;
                if (img.complete && img.naturalWidth > 0) {
                    onLoaded();
                }
            }
        } else if (imageOrDataUrl.width) {
            this._rawImages[name] = this._downscaleForDraw(imageOrDataUrl);
            delete this._rawSrc[name];
            delete this._masks[name];
            delete this._cutoutImages[name];
            this._clearVariants(name);
        }
    },

    /** 清理某个笔刷名下的实心度/染色变体缓存（重新导入同名笔刷时避免用到旧图） */
    _clearVariants(name) {
        const prefix = name + '_';
        for (const store of [this._masks, this._cutoutImages, this._tintCache]) {
            for (const k of Object.keys(store)) {
                if (k.startsWith(prefix) && (k.includes('_solid_') || store === this._tintCache)) delete store[k];
            }
        }
    },

    saveCustomBrush(name, dataUrl, displayName) {
        if (!name || !dataUrl) return;
        const dName = displayName || name;
        this.registerBrush(name, dataUrl, dName);
        if (typeof localStorage !== 'undefined') {
            try {
                const stored = JSON.parse(localStorage.getItem('reels_custom_brushes') || '{}');
                stored[name] = { name, dataUrl, displayName: dName };
                localStorage.setItem('reels_custom_brushes', JSON.stringify(stored));
            } catch (err) {
                console.warn('[ReelsBrushEngine] saveCustomBrush error:', err);
            }
        }
    },

    loadCustomBrushes() {
        if (this._customLoaded || typeof localStorage === 'undefined') return;
        this._customLoaded = true;
        try {
            const stored = JSON.parse(localStorage.getItem('reels_custom_brushes') || '{}');
            Object.keys(stored).forEach(name => {
                const item = stored[name];
                if (item) {
                    const dataUrl = typeof item === 'string' ? item : item.dataUrl;
                    const dName = (typeof item === 'object' && item.displayName) ? item.displayName : name;
                    this.registerBrush(name, dataUrl, dName);
                }
            });
        } catch (err) {
            console.warn('[ReelsBrushEngine] loadCustomBrushes error:', err);
        }
    },

    getCustomBrushes() {
        this.loadCustomBrushes();
        return this._customBrushes;
    },

    getCustomBrushData(name) {
        return this._customBrushes[name]?.dataUrl || null;
    },

    deleteCustomBrush(name) {
        delete this._customBrushes[name];
        delete this._masks[name];
        delete this._rawImages[name];
        delete this._cutoutImages[name];
        if (this._pendingLoads) delete this._pendingLoads[name];
        if (this._rawSrc) delete this._rawSrc[name];
        this._clearVariants(name);
        if (typeof localStorage !== 'undefined') {
            try {
                const stored = JSON.parse(localStorage.getItem('reels_custom_brushes') || '{}');
                delete stored[name];
                localStorage.setItem('reels_custom_brushes', JSON.stringify(stored));
            } catch (_) {}
        }
    },

    /**
     * 初始化/预加载内置与自定义笔刷
     */
    init() {
        if (this._initialized || typeof Image === 'undefined') return;
        this._initialized = true;
        this.loadCustomBrushes();
    },

    /**
     * 获取原始未染色图片/Canvas（保留原图色彩与纹理）
     */
    getRawImage(style) {
        this.init();
        return (this._rawImages && this._rawImages[style]) || null;
    },

    /**
     * 获取指定风格和实心度的蒙版 Canvas
     */
    getMask(style, solidStrength = 100) {
        this.init();
        const str = (typeof solidStrength === 'number' && !isNaN(solidStrength)) ? Math.max(0, Math.min(100, Math.round(solidStrength))) : 100;
        const activeStyle = style || '';
        if (str === 100 && this._masks[activeStyle]) {
            return this._masks[activeStyle];
        }
        const cacheKey = activeStyle + '_solid_' + str;
        if (this._masks[cacheKey]) return this._masks[cacheKey];

        const raw = this._rawImages[activeStyle];
        if (raw) {
            const m = this.processMaskCanvas(raw, str / 100);
            if (m) {
                if (str === 100) this._masks[activeStyle] = m;
                else this._rememberVariant(this._masks, cacheKey, m);
                return m;
            }
        }
        return this._masks[activeStyle] || null;
    },

    /**
     * 获取原始未染色图片/Canvas（保留原图色彩与纹理）
     */
    getRawImage(style) {
        this.init();
        return (this._rawImages && this._rawImages[style]) || null;
    },

    /**
     * 获取去除了白底/黑底的彩色笔刷图片/Canvas（支持实心度）
     */
    getCutoutImage(style, solidStrength = 100) {
        this.init();
        const str = (typeof solidStrength === 'number' && !isNaN(solidStrength)) ? Math.max(0, Math.min(100, Math.round(solidStrength))) : 100;
        const activeStyle = style || '';
        if (str === 100 && this._cutoutImages[activeStyle]) {
            return this._cutoutImages[activeStyle];
        }
        const cacheKey = activeStyle + '_cutout_solid_' + str;
        if (this._cutoutImages[cacheKey]) return this._cutoutImages[cacheKey];

        const raw = this._rawImages[activeStyle];
        if (raw) {
            const c = this.processCutoutCanvas(raw, str / 100);
            if (c) {
                if (str === 100) this._cutoutImages[activeStyle] = c;
                else this._rememberVariant(this._cutoutImages, cacheKey, c);
                return c;
            }
        }
        return this._cutoutImages[activeStyle] || this.getRawImage(activeStyle);
    },

    /**
     * 获取指定风格和颜色的染色蒙版 Canvas（带内存 LRU 缓存，支持实心度）
     */
    getTintedMask(style, color, direction = 'horizontal', solidStrength = 100) {
        this.init();
        const str = (typeof solidStrength === 'number' && !isNaN(solidStrength)) ? Math.max(0, Math.min(100, Math.round(solidStrength))) : 100;
        const key = style + '_' + color + '_' + direction + '_' + str;
        if (this._tintCache[key]) return this._tintCache[key];

        let mask = this.getMask(style, str);
        if (!mask) return null;

        if (typeof document === 'undefined') return null;
        const c = document.createElement('canvas');
        c.width = mask.width;
        c.height = mask.height;
        const ctx = c.getContext('2d');
        ctx.fillStyle = _resolveOverlayBgFill(ctx, color, 0, 0, c.width, c.height, direction);
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.globalCompositeOperation = 'destination-in';
        ctx.drawImage(mask, 0, 0);

        // 限制缓存数量，防止连续拖动滑块时内存暴增
        const cacheKeys = Object.keys(this._tintCache);
        if (cacheKeys.length > 50) {
            delete this._tintCache[cacheKeys[0]];
        }
        this._tintCache[key] = c;
        return c;
    },

    /**
     * 把图片按适配方式画进 (x, y, w, h) 背景范围，超出范围的部分裁掉。
     * fit.mode:
     *   - 'stretch': 变形拉伸，整张图铺满背景范围
     *   - 'cover'  : 保持原图比例，铺满背景范围后居中裁切
     *   - 'slice3' : 两端保护拉伸（左右端头不变形，中间拉长；旧版笔刷行为）
     * fit.zoom: 整体缩放百分比（100 = 刚好适配），以背景范围中心为基准
     */
    _drawFitted(target, source, x, y, w, h, fit, style) {
        const nw = source.naturalWidth || source.width;
        const nh = source.naturalHeight || source.height;
        if (!nw || !nh) return;
        const mode = (fit && fit.mode) || 'slice3';
        const zoomRaw = Number(fit && fit.zoom);
        const zoom = Number.isFinite(zoomRaw) && zoomRaw > 0 ? zoomRaw / 100 : 1;
        const cx = x + w / 2, cy = y + h / 2;

        if (mode === 'stretch' || mode === 'cover') {
            let dw = w, dh = h;
            if (mode === 'cover') {
                const s = Math.max(w / nw, h / nh);
                dw = nw * s;
                dh = nh * s;
            }
            dw *= zoom;
            dh *= zoom;
            const needClip = dw > w + 0.5 || dh > h + 0.5;
            if (needClip) {
                target.save();
                target.beginPath();
                target.rect(x, y, w, h);
                target.clip();
            }
            target.drawImage(source, cx - dw / 2, cy - dh / 2, dw, dh);
            if (needClip) target.restore();
            return;
        }

        // slice3：缩放作用于整个背景范围（以中心为基准），再做两端保护拉伸
        const zw = w * zoom, zh = h * zoom;
        const zx = cx - zw / 2, zy = cy - zh / 2;
        let sCapL = Math.round(nw * 0.18);
        let sCapR = Math.round(nw * 0.28);
        if (style === 'watercolor') {
            sCapL = Math.round(nw * 0.12);
            sCapR = Math.round(nw * 0.15);
        } else if (style === 'drybrush') {
            sCapL = Math.round(nw * 0.15);
            sCapR = Math.round(nw * 0.25);
        }
        const sMidW = nw - sCapL - sCapR;
        let dCapL = Math.round(zh * (sCapL / nh) * 0.9);
        let dCapR = Math.round(zh * (sCapR / nh) * 1.1);
        if (dCapL + dCapR > zw * 0.6) {
            const factor = (zw * 0.6) / (dCapL + dCapR);
            dCapL = Math.round(dCapL * factor);
            dCapR = Math.round(dCapR * factor);
        }
        const dMidW = Math.max(0, zw - dCapL - dCapR);
        const needClip = zoom > 1.0001;
        if (needClip) {
            target.save();
            target.beginPath();
            target.rect(x, y, w, h);
            target.clip();
        }
        if (dMidW > 0 && sMidW > 0) {
            target.drawImage(source, 0, 0, sCapL, nh, zx, zy, dCapL, zh);
            target.drawImage(source, sCapL, 0, sMidW, nh, zx + dCapL, zy, dMidW, zh);
            target.drawImage(source, nw - sCapR, 0, sCapR, nh, zx + dCapL + dMidW, zy, dCapR, zh);
        } else {
            target.drawImage(source, zx, zy, zw, zh);
        }
        if (needClip) target.restore();
    },

    /**
     * 文字图片背景 / 艺术笔刷绘制核心
     * colormode:
     *   - 'tint': 蒙版染色（跟随 bgColor 及渐变，适合黑白白墨素材）
     *   - 'original' / 'raw': 直接使用原图（保留原图所有的色彩与纹理，不转黑白不染色）
     *   - 'original_nobg': 原图智能去白底/黑底（保留原图彩色，自动去除外层实色矩形底色）
     * fit: { mode: 'stretch' | 'cover' | 'slice3', zoom: 100 }，见 _drawFitted；不传时为 slice3（兼容旧调用）
     */
    drawBrush(ctx, x, y, w, h, style = '', color = '#0D47A1', opacity = 1, colormode = 'original', direction = 'horizontal', customBrushData = null, solidStrength = 100, fit = null) {
        if (w <= 0 || h <= 0) return;
        let activeStyle = style || '';
        if (customBrushData) {
            const customKey = (activeStyle && activeStyle !== 'custom') ? activeStyle : ('_custom_' + customBrushData.length);
            if (!this._rawImages[customKey] || (this._rawSrc && this._rawSrc[customKey] && this._rawSrc[customKey] !== customBrushData)) {
                this.registerBrush(customKey, customBrushData);
            }
            activeStyle = customKey;
        }
        ctx.save();
        ctx.globalAlpha *= opacity;

        // 默认（original）：直接画原图，零像素计算；只有「染成背景颜色」(tint) 才生成蒙版
        const isTint = colormode === 'tint';
        const isGrad = isTint && typeof color === 'string' && color.includes(',');

        let source = null;
        if (colormode === 'original_nobg') {
            source = this.getCutoutImage(activeStyle, solidStrength);
        } else if (isGrad) {
            source = this.getMask(activeStyle, solidStrength);
        } else if (isTint) {
            source = this.getTintedMask(activeStyle, color, direction, solidStrength);
        } else {
            source = this.getRawImage(activeStyle);
        }

        if (source) {
            if (isGrad && typeof document !== 'undefined') {
                if (!this._scratchCanvas) {
                    this._scratchCanvas = document.createElement('canvas');
                }
                const off = this._scratchCanvas;
                const reqW = Math.max(1, Math.ceil(w));
                const reqH = Math.max(1, Math.ceil(h));
                // 只增不减：多行笔刷尺寸各不相同，每次改 canvas 尺寸都会重新分配显存，导致卡顿
                if (off.width < reqW || off.height < reqH) {
                    off.width = Math.max(off.width, reqW);
                    off.height = Math.max(off.height, reqH);
                }
                const octx = off.getContext('2d');
                octx.save();
                octx.clearRect(0, 0, off.width, off.height);
                octx.globalCompositeOperation = 'source-over';
                this._drawFitted(octx, source, 0, 0, w, h, fit, style);
                octx.globalCompositeOperation = 'source-in';
                octx.fillStyle = _resolveOverlayBgFill(octx, color, 0, 0, w, h, direction);
                octx.fillRect(0, 0, w, h);
                octx.restore();
                ctx.drawImage(off, 0, 0, reqW, reqH, x, y, reqW, reqH);
            } else {
                this._drawFitted(ctx, source, x, y, w, h, fit, style);
            }
        } else {
            // 兜底微圆角矩形
            ctx.fillStyle = _resolveOverlayBgFill(ctx, color, x, y, w, h, direction);
            ctx.beginPath();
            if (ctx.roundRect) ctx.roundRect(x, y, w, h, 8);
            else ctx.rect(x, y, w, h);
            ctx.fill();
        }
        ctx.restore();
    },

    getBrushSvg(style, color) {
        return '';
    }
};

// 页面/脚本解析时自启动预加载
if (typeof ReelsBrushEngine !== 'undefined' && ReelsBrushEngine.init) {
    ReelsBrushEngine.init();
}

function _withAlpha(hexColor, alpha) {
    const r = parseInt(hexColor.slice(1, 3), 16);
    const g = parseInt(hexColor.slice(3, 5), 16);
    const b = parseInt(hexColor.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
}

function _overlayId() {
    return 'ov_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ═══════════════════════════════════════════════════════
// Exports
// ═══════════════════════════════════════════════════════

OverlayManager.prototype._resolveOverlayTextFill = _resolveOverlayTextFill;
OverlayManager.prototype._resolveOverlayDecoFill = _resolveOverlayDecoFill;

function preparePreviewSeek(overlays, currentTime) {
    const videos=[];
    for(const ov of overlays || []) {
        if(!ov || ov.disabled || !['image','video'].includes(ov.type) || ov.is_img_sequence) continue;
        const start=Number(ov.start)||0,end=Number(ov.end ?? 9999);
        if(currentTime<start || currentTime>end)continue;
        const path=_resolveFolderMediaPath(ov,currentTime);
        if(!path || !_isVideoOverlayPath(path) || path.toLowerCase().endsWith('.gif'))continue;
        const video=_getCachedVideo(path);if(!video)continue;
        video.pause();
        const duration=video.duration;
        if(Number.isFinite(duration) && duration>0) {
            const offset=Number(ov.video_start_offset)||0;
            const local=resolveFolderMedia(ov,currentTime).time+offset;
            const target=ov.media_folder_files?.length
                ? (ov.media_loop===false?Math.min(local,Math.max(0,duration-.001)):local%duration)
                : resolveVideoTime(ov,Math.max(0,currentTime-start),duration);
            if(!video.seeking && Math.abs(video.currentTime-target)>.05)video.currentTime=target;
        }
        videos.push(video);
    }
    return videos;
}

function disposePreviewMedia() {
    _mediaBlurFrames.clear();
    _previewMediaGeneration++;
    Object.values(_videoCache).forEach(video => {
        video.pause(); video.removeAttribute('src'); video.load(); video.remove();
        _previewDecodedFrames.delete(video);
    });
    for (const key of Object.keys(_videoCache)) delete _videoCache[key];
    for (const [key,data] of Object.entries(_gifDecoderCache)) {
        data.disposed = true;
        Object.values(data.frames).forEach(frame => frame?.close?.());
        data.decoder?.close?.(); delete _gifDecoderCache[key];
    }
    for (const [key,image] of Object.entries(_imageCache)) {
        if (image && image !== _IMAGE_LOADING && image !== _IMAGE_FAILED) { image.onload = null; image.onerror = null; image.remove?.(); image.src = ''; }
        delete _imageCache[key];
    }
}

function isPreviewMediaReady(ov, time) {
    if (!ov || ov.disabled || !['image','video'].includes(ov.type) || time<(Number(ov.start)||0) || time>Number(ov.end ?? 9999)) return true;
    const path=_resolveFolderMediaPath(ov,time);
    if (!path) return true;
    if (ov.is_img_sequence) return !!ov._currentFrameImage;
    if (ov.type==='image') {
        const img=_imageCache[path];return !!(img && img.complete && img.naturalWidth>0);
    }
    if (path.toLowerCase().endsWith('.gif')) return !!_gifDecoderCache[path]?.frames?.[0];
    const video=_videoCache[path];
    return !!(video && !video.seeking && video.readyState>=2 && video.videoWidth>0);
}

// Failed layers are settled too: keep rendering the available layers without
// holding every overview card behind a missing image or video.
function isPreviewMediaSettled(ov, time) {
    if (isPreviewMediaReady(ov, time)) return true;
    const path = _resolveFolderMediaPath(ov, time);
    if (_imageCache[path] === _IMAGE_FAILED) return true;
    const video = _videoCache[path];
    return !!video?.error;
}


// 独立的程序绘制点缀图层；保留主软件现有覆层实现。
function createDecorOverlay(opts = {}) {
    const styleId = opts.decor_style || 'dark_floating_dust';
    const preset = (typeof DECOR_OVERLAY_STYLES !== 'undefined' && DECOR_OVERLAY_STYLES[styleId])
        ? DECOR_OVERLAY_STYLES[styleId]
        : null;
    return {
        id: opts.id || _overlayId(),
        name: opts.name || '',
        fixed_text: opts.fixed_text ?? true,
        type: 'decor',
        x: opts.x ?? 0,
        y: opts.y ?? 0,
        w: opts.w ?? 1080,
        h: opts.h ?? 1920,
        rotation: opts.rotation ?? 0,
        opacity: opts.opacity ?? 255,
        start: opts.start ?? 0,
        end: opts.end ?? 9999,
        decor_style: styleId,
        decor_layout: opts.decor_layout || preset?.layout || 'edges_and_float', // 'edges_and_float' | 'edges_only' | 'corners_only' | 'top_bottom' | 'full_scatter'
        decor_density: opts.decor_density ?? preset?.density ?? 55,              // 5 ~ 200
        decor_size: opts.decor_size ?? preset?.size ?? 100,                      // 20 ~ 300 (%)
        decor_glow: opts.decor_glow ?? preset?.glow ?? 100,                      // 0 ~ 200 (%)
        decor_speed: opts.decor_speed ?? preset?.speed ?? 100,                   // 0 ~ 300 (%)
        decor_margin: opts.decor_margin ?? preset?.margin ?? 36,                 // 0 ~ 300 (px)
        decor_center_clear: opts.decor_center_clear ?? preset?.center_clear ?? 65, // 0 ~ 95 (%)
        decor_color1: opts.decor_color1 || preset?.color1 || '#FFD700',
        decor_color2: opts.decor_color2 || preset?.color2 || '#FFFDF5',
        decor_glow_stars: opts.decor_glow_stars !== undefined ? Boolean(opts.decor_glow_stars) : (preset ? Boolean(preset.glow_stars) : true),
        decor_snowflakes: opts.decor_snowflakes !== undefined ? Boolean(opts.decor_snowflakes) : (preset ? Boolean(preset.snowflakes) : false),
        decor_corner_ornaments: opts.decor_corner_ornaments !== undefined ? Boolean(opts.decor_corner_ornaments) : (preset ? Boolean(preset.corner_ornaments) : true),
        decor_edge_garland: opts.decor_edge_garland !== undefined ? Boolean(opts.decor_edge_garland) : (preset ? Boolean(preset.edge_garland) : true),
        // 黑色氛围模板 & 飘浮粒子控制
        decor_dark_enabled: opts.decor_dark_enabled !== undefined
            ? Boolean(opts.decor_dark_enabled)
            : ((opts.decor_dark_vignette ?? preset?.dark_vignette ?? 0) > 0),
        decor_dark_vignette: opts.decor_dark_vignette ?? preset?.dark_vignette ?? 0,       // 0 ~ 100 (%)
        decor_vignette_spread: opts.decor_vignette_spread ?? preset?.vignette_spread ?? 55, // 10 ~ 95 (%)
        decor_dark_tint: opts.decor_dark_tint || preset?.dark_tint || '#05070B',
        decor_floating_particles: opts.decor_floating_particles !== undefined ? Boolean(opts.decor_floating_particles) : Boolean(preset?.floating_particles),
        decor_particle_mode: opts.decor_particle_mode || preset?.particle_mode || 'dust',   // 'dust' | 'embers' | 'fireflies' | 'ash' | 'neon' | 'sunset_bokeh' | 'prism'
        // 电影颗粒 & 回忆颗粒感控制
        decor_grain_enabled: opts.decor_grain_enabled !== undefined
            ? Boolean(opts.decor_grain_enabled)
            : (((opts.decor_grain_intensity ?? preset?.grain_intensity ?? 0) > 0) || ((opts.decor_grain_warmth ?? preset?.grain_warmth ?? 0) > 0)),
        decor_grain_intensity: opts.decor_grain_intensity ?? preset?.grain_intensity ?? 0,  // 0 ~ 100 (%)
        decor_grain_size: opts.decor_grain_size ?? preset?.grain_size ?? 100,               // 50 ~ 250 (%)
        decor_grain_warmth: opts.decor_grain_warmth ?? preset?.grain_warmth ?? 0,           // 0 ~ 100 (%)
        decor_film_scratches: opts.decor_film_scratches !== undefined ? Boolean(opts.decor_film_scratches) : Boolean(preset?.film_scratches),
        decor_light_leak: opts.decor_light_leak !== undefined ? Boolean(opts.decor_light_leak) : Boolean(preset?.light_leak),
        transition_preset: opts.transition_preset || 'none',
        transition_duration: opts.transition_duration || 0.35,
        anim_in_type: opts.anim_in_type || 'none',
        anim_out_type: opts.anim_out_type || 'none',
        anim_in_duration: opts.anim_in_duration ?? 0.3,
        anim_out_duration: opts.anim_out_duration ?? 0.3,
    };
}


function applyDecorStylePreset(ov, styleId) {
    if (!ov || !styleId) return ov;
    const preset = DECOR_OVERLAY_STYLES[styleId];
    ov.decor_style = styleId;
    if (!preset) return ov;
    ov.decor_color1 = preset.color1 || '#FFD700';
    ov.decor_color2 = preset.color2 || '#FFFDF5';
    ov.decor_glow_stars = Boolean(preset.glow_stars);
    ov.decor_snowflakes = Boolean(preset.snowflakes);
    ov.decor_corner_ornaments = Boolean(preset.corner_ornaments);
    ov.decor_edge_garland = Boolean(preset.edge_garland);
    ov.decor_dark_enabled = (preset.dark_vignette ?? 0) > 0;
    ov.decor_dark_vignette = preset.dark_vignette ?? 0;
    ov.decor_vignette_spread = preset.vignette_spread ?? 55;
    ov.decor_dark_tint = preset.dark_tint || '#05070B';
    ov.decor_floating_particles = Boolean(preset.floating_particles);
    ov.decor_particle_mode = preset.particle_mode || 'dust';
    ov.decor_grain_enabled = ((preset.grain_intensity ?? 0) > 0) || ((preset.grain_warmth ?? 0) > 0);
    ov.decor_grain_intensity = preset.grain_intensity ?? 0;
    ov.decor_grain_size = preset.grain_size ?? 100;
    ov.decor_grain_warmth = preset.grain_warmth ?? 0;
    ov.decor_film_scratches = Boolean(preset.film_scratches);
    ov.decor_light_leak = Boolean(preset.light_leak);
    if (preset.layout) ov.decor_layout = preset.layout;
    if (preset.density !== undefined) ov.decor_density = preset.density;
    if (preset.center_clear !== undefined) ov.decor_center_clear = preset.center_clear;
    return ov;
}

const DECOR_OVERLAY_CATEGORIES = [
    { id: 'dark_particles', name: '🖤 黑色氛围模板 & 飘浮粒子 (7款)' },
    { id: 'film_grain',     name: '🎞️ 电影颗粒 & 回忆质感 (7款)' },
    { id: 'stars',          name: '🌟 发光星芒 & 梦幻光斑 (6款)' },
    { id: 'xmas',           name: '🎄 圣诞节限定点缀 (5款)' },
    { id: 'frame',          name: '⚜️ 复古画框 & 边缘装饰 (5款)' },
];

const DECOR_OVERLAY_STYLES = {
    // ── A. 🖤 黑色氛围模板 & 飘浮粒子 (7款) ──
    dark_floating_dust: {
        name: '🖤 暗黑深邃模板 + 悬浮微尘',
        category: 'dark_particles',
        color1: '#E2E8F0',
        color2: '#FFFDF5',
        glow_stars: false,
        snowflakes: false,
        corner_ornaments: false,
        edge_garland: false,
        dark_vignette: 78,
        vignette_spread: 62,
        dark_tint: '#05070C',
        floating_particles: true,
        particle_mode: 'dust',
        grain_intensity: 24,
        grain_size: 100,
        grain_warmth: 0,
        film_scratches: false,
        light_leak: false,
        layout: 'full_scatter',
        density: 75,
        center_clear: 35,
    },
    dark_gold_embers: {
        name: '🔥 黑金暗夜模板 + 升腾火星余烬',
        category: 'dark_particles',
        color1: '#F97316',
        color2: '#FDE047',
        glow_stars: false,
        snowflakes: false,
        corner_ornaments: false,
        edge_garland: false,
        dark_vignette: 82,
        vignette_spread: 65,
        dark_tint: '#0B0503',
        floating_particles: true,
        particle_mode: 'embers',
        grain_intensity: 20,
        grain_size: 100,
        grain_warmth: 25,
        film_scratches: false,
        light_leak: false,
        layout: 'full_scatter',
        density: 80,
        center_clear: 35,
    },
    dark_starlight_mist: {
        name: '🌌 暗夜星空黑底 + 呼吸星芒微粒',
        category: 'dark_particles',
        color1: '#93C5FD',
        color2: '#FFFFFF',
        glow_stars: true,
        snowflakes: false,
        corner_ornaments: false,
        edge_garland: false,
        dark_vignette: 76,
        vignette_spread: 60,
        dark_tint: '#040814',
        floating_particles: true,
        particle_mode: 'dust',
        grain_intensity: 18,
        grain_size: 95,
        grain_warmth: 0,
        film_scratches: false,
        light_leak: false,
        layout: 'edges_and_float',
        density: 65,
        center_clear: 48,
    },
    dark_firefly_woods: {
        name: '✨ 暗调森林黑底 + 萤火虫漂浮',
        category: 'dark_particles',
        color1: '#A3E635',
        color2: '#FEF08A',
        glow_stars: false,
        snowflakes: false,
        corner_ornaments: false,
        edge_garland: false,
        dark_vignette: 75,
        vignette_spread: 60,
        dark_tint: '#040C08',
        floating_particles: true,
        particle_mode: 'fireflies',
        grain_intensity: 16,
        grain_size: 100,
        grain_warmth: 15,
        film_scratches: false,
        light_leak: false,
        layout: 'full_scatter',
        density: 60,
        center_clear: 40,
    },
    dark_silver_snow_ash: {
        name: '🌨️ 暗黑冰原模板 + 银白灰烬细雪',
        category: 'dark_particles',
        color1: '#CBD5E1',
        color2: '#F8FAFC',
        glow_stars: false,
        snowflakes: true,
        corner_ornaments: false,
        edge_garland: false,
        dark_vignette: 78,
        vignette_spread: 62,
        dark_tint: '#06090F',
        floating_particles: true,
        particle_mode: 'ash',
        grain_intensity: 28,
        grain_size: 105,
        grain_warmth: 0,
        film_scratches: false,
        light_leak: false,
        layout: 'full_scatter',
        density: 75,
        center_clear: 35,
    },
    dark_holy_halo_dust: {
        name: '🕯️ 暗夜烛光圣殿 + 鎏金圣尘',
        category: 'dark_particles',
        color1: '#F59E0B',
        color2: '#FFFBEB',
        glow_stars: true,
        snowflakes: false,
        corner_ornaments: true,
        edge_garland: true,
        dark_vignette: 80,
        vignette_spread: 64,
        dark_tint: '#0E0804',
        floating_particles: true,
        particle_mode: 'dust',
        grain_intensity: 22,
        grain_size: 100,
        grain_warmth: 35,
        film_scratches: false,
        light_leak: true,
        layout: 'edges_and_float',
        density: 68,
        center_clear: 50,
    },
    dark_cyber_neon_sparks: {
        name: '⚡ 暗黑赛博黑底 + 霓虹微光粒子',
        category: 'dark_particles',
        color1: '#22D3EE',
        color2: '#F472B6',
        glow_stars: true,
        snowflakes: false,
        corner_ornaments: false,
        edge_garland: false,
        dark_vignette: 78,
        vignette_spread: 58,
        dark_tint: '#06030F',
        floating_particles: true,
        particle_mode: 'neon',
        grain_intensity: 20,
        grain_size: 95,
        grain_warmth: 0,
        film_scratches: false,
        light_leak: false,
        layout: 'full_scatter',
        density: 70,
        center_clear: 40,
    },

    // ── B. 🎞️ 电影颗粒 & 回忆质感 (7款) ──
    cinema_35mm_grain: {
        name: '🎞️ 35mm 经典电影颗粒 + 宽银幕暗角',
        category: 'film_grain',
        color1: '#E5E7EB',
        color2: '#FFFDF5',
        glow_stars: false,
        snowflakes: false,
        corner_ornaments: false,
        edge_garland: true,
        dark_vignette: 52,
        vignette_spread: 48,
        dark_tint: '#060709',
        floating_particles: true,
        particle_mode: 'dust',
        grain_intensity: 62,
        grain_size: 105,
        grain_warmth: 12,
        film_scratches: false,
        light_leak: false,
        layout: 'full_scatter',
        density: 32,
        center_clear: 45,
    },
    memory_sepia_grain: {
        name: '🕰️ 怀旧泛黄回忆颗粒 + 老照片柔光',
        category: 'film_grain',
        color1: '#D97706',
        color2: '#FEF3C7',
        glow_stars: false,
        snowflakes: false,
        corner_ornaments: false,
        edge_garland: false,
        dark_vignette: 58,
        vignette_spread: 54,
        dark_tint: '#261507',
        floating_particles: true,
        particle_mode: 'dust',
        grain_intensity: 65,
        grain_size: 118,
        grain_warmth: 78,
        film_scratches: false,
        light_leak: true,
        layout: 'full_scatter',
        density: 45,
        center_clear: 40,
    },
    vintage_8mm_scratches: {
        name: '📽️ 8mm 老电影划痕 + 闪烁噪点颗粒',
        category: 'film_grain',
        color1: '#FBBF24',
        color2: '#FFFBEB',
        glow_stars: false,
        snowflakes: false,
        corner_ornaments: false,
        edge_garland: true,
        dark_vignette: 64,
        vignette_spread: 56,
        dark_tint: '#181008',
        floating_particles: true,
        particle_mode: 'dust',
        grain_intensity: 75,
        grain_size: 138,
        grain_warmth: 55,
        film_scratches: true,
        light_leak: false,
        layout: 'full_scatter',
        density: 40,
        center_clear: 35,
    },
    noir_bw_high_grain: {
        name: '🎬 黑白胶片高反差粗颗粒',
        category: 'film_grain',
        color1: '#D4D4D8',
        color2: '#FFFFFF',
        glow_stars: false,
        snowflakes: false,
        corner_ornaments: false,
        edge_garland: true,
        dark_vignette: 74,
        vignette_spread: 60,
        dark_tint: '#030303',
        floating_particles: true,
        particle_mode: 'ash',
        grain_intensity: 82,
        grain_size: 150,
        grain_warmth: 0,
        film_scratches: true,
        light_leak: false,
        layout: 'full_scatter',
        density: 38,
        center_clear: 40,
    },
    dreamy_light_leak_grain: {
        name: '🌅 复古胶片漏光 + 柔焦回忆颗粒',
        category: 'film_grain',
        color1: '#FB923C',
        color2: '#FDE68A',
        glow_stars: false,
        snowflakes: false,
        corner_ornaments: false,
        edge_garland: false,
        dark_vignette: 38,
        vignette_spread: 42,
        dark_tint: '#1E0D06',
        floating_particles: true,
        particle_mode: 'sunset_bokeh',
        grain_intensity: 50,
        grain_size: 100,
        grain_warmth: 62,
        film_scratches: false,
        light_leak: true,
        layout: 'edges_and_float',
        density: 48,
        center_clear: 45,
    },
    vhs_retro_scanlines: {
        name: '📼 90年代 VHS 扫描线 + 磁带噪点',
        category: 'film_grain',
        color1: '#38BDF8',
        color2: '#F43F5E',
        glow_stars: false,
        snowflakes: false,
        corner_ornaments: true,
        edge_garland: true,
        dark_vignette: 46,
        vignette_spread: 45,
        dark_tint: '#070913',
        floating_particles: false,
        particle_mode: 'dust',
        grain_intensity: 58,
        grain_size: 125,
        grain_warmth: 18,
        film_scratches: true,
        light_leak: false,
        layout: 'edges_only',
        density: 35,
        center_clear: 65,
    },
    cinema_vignette_grain: {
        name: '🎥 电影取景框暗角 + 胶片星尘',
        category: 'film_grain',
        color1: '#F59E0B',
        color2: '#FFFBEB',
        glow_stars: true,
        snowflakes: false,
        corner_ornaments: true,
        edge_garland: true,
        dark_vignette: 56,
        vignette_spread: 50,
        dark_tint: '#080A0F',
        floating_particles: true,
        particle_mode: 'dust',
        grain_intensity: 52,
        grain_size: 108,
        grain_warmth: 22,
        film_scratches: false,
        light_leak: false,
        layout: 'edges_and_float',
        density: 45,
        center_clear: 60,
    },

    // ── C. 🌟 发光星芒 & 梦幻光斑 (6款) ──
    glowing_starfield: {
        name: '🌟 璀璨发光星芒点缀',
        category: 'stars',
        color1: '#FFD700',
        color2: '#FFFDF5',
        glow_stars: true,
        snowflakes: false,
        corner_ornaments: true,
        edge_garland: true,
    },
    fairy_bokeh_lights: {
        name: '💡 梦幻暖金串灯与光斑',
        category: 'stars',
        color1: '#FBBF24',
        color2: '#FEF3C7',
        glow_stars: true,
        snowflakes: false,
        corner_ornaments: true,
        edge_garland: true,
    },
    golden_meteor_dust: {
        name: '✨ 圣光鎏金星尘飘落',
        category: 'stars',
        color1: '#F5D061',
        color2: '#FFFBEB',
        glow_stars: true,
        snowflakes: false,
        corner_ornaments: false,
        edge_garland: true,
        floating_particles: true,
        particle_mode: 'dust',
    },
    angelic_rays_stars: {
        name: '🕊️ 圣洁光芒与四角星辉',
        category: 'stars',
        color1: '#FDE68A',
        color2: '#FFFFFF',
        glow_stars: true,
        snowflakes: false,
        corner_ornaments: true,
        edge_garland: true,
    },
    diamond_prism_sparkles: {
        name: '💎 钻石棱镜十字星芒闪烁',
        category: 'stars',
        color1: '#A5F3FC',
        color2: '#FFFFFF',
        glow_stars: true,
        snowflakes: false,
        corner_ornaments: true,
        edge_garland: false,
        floating_particles: true,
        particle_mode: 'prism',
        density: 65,
    },
    warm_sunset_bokeh: {
        name: '🌇 落日暖阳大光斑漂浮',
        category: 'stars',
        color1: '#FB923C',
        color2: '#FEF08A',
        glow_stars: true,
        snowflakes: false,
        corner_ornaments: false,
        edge_garland: false,
        floating_particles: true,
        particle_mode: 'sunset_bokeh',
        light_leak: true,
        grain_warmth: 35,
        density: 55,
    },

    // ── D. 🎄 圣诞节限定点缀 (5款) ──
    xmas_holly_pine_garland: {
        name: '🎄 圣诞松枝冬青花环框',
        category: 'xmas',
        color1: '#DC2626',
        color2: '#FFD700',
        glow_stars: true,
        snowflakes: true,
        corner_ornaments: true,
        edge_garland: true,
    },
    xmas_snowfall_frost: {
        name: '❄️ 圣诞漫天飘雪与冰晶边',
        category: 'xmas',
        color1: '#E0F2FE',
        color2: '#7DD3FC',
        glow_stars: true,
        snowflakes: true,
        corner_ornaments: true,
        edge_garland: true,
    },
    xmas_hanging_baubles: {
        name: '🎅 圣诞顶部挂球与金星吊坠',
        category: 'xmas',
        color1: '#EF4444',
        color2: '#FDE047',
        glow_stars: true,
        snowflakes: true,
        corner_ornaments: true,
        edge_garland: true,
    },
    xmas_candy_corner_ribbons: {
        name: '🍬 圣诞拐杖糖与蝴蝶结角花',
        category: 'xmas',
        color1: '#DC2626',
        color2: '#FFFFFF',
        glow_stars: true,
        snowflakes: false,
        corner_ornaments: true,
        edge_garland: true,
    },
    xmas_golden_bells_reindeer: {
        name: '🔔 圣诞金铃铛与雪花金框',
        category: 'xmas',
        color1: '#F59E0B',
        color2: '#DC2626',
        glow_stars: true,
        snowflakes: true,
        corner_ornaments: true,
        edge_garland: true,
        dark_vignette: 28,
        dark_tint: '#0A0604',
    },

    // ── E. ⚜️ 复古画框 & 边缘装饰 (5款) ──
    vintage_gold_filigree: {
        name: '⚜️ 古典烫金巴洛克雕花角框',
        category: 'frame',
        color1: '#D4AF37',
        color2: '#FFF6D6',
        glow_stars: true,
        snowflakes: false,
        corner_ornaments: true,
        edge_garland: true,
    },
    newspaper_torn_tape_frame: {
        name: '📰 复古报刊手撕边与胶带点缀',
        category: 'frame',
        color1: '#E6DEC8',
        color2: '#8B1E1E',
        glow_stars: false,
        snowflakes: false,
        corner_ornaments: true,
        edge_garland: true,
        grain_intensity: 30,
        grain_warmth: 30,
    },
    rose_botanical_vine: {
        name: '🌹 复古玫瑰藤蔓边缘点缀',
        category: 'frame',
        color1: '#E11D48',
        color2: '#FDE68A',
        glow_stars: true,
        snowflakes: false,
        corner_ornaments: true,
        edge_garland: true,
    },
    sacred_cathedral_arch: {
        name: '⛪ 圣经哥特拱窗烫金边框',
        category: 'frame',
        color1: '#D4AF37',
        color2: '#FEF3C7',
        glow_stars: true,
        snowflakes: false,
        corner_ornaments: true,
        edge_garland: true,
        dark_vignette: 42,
        dark_tint: '#0B0704',
        floating_particles: true,
        particle_mode: 'dust',
    },
    polaroid_memory_border: {
        name: '🖼️ 拍立得回忆相纸框 + 胶片颗粒',
        category: 'frame',
        color1: '#FAF6EE',
        color2: '#D97706',
        glow_stars: false,
        snowflakes: false,
        corner_ornaments: false,
        edge_garland: true,
        grain_intensity: 46,
        grain_size: 110,
        grain_warmth: 52,
        light_leak: true,
        floating_particles: true,
        particle_mode: 'dust',
    },
};


const DecorOrnaments = {
    _drawHollyOrnament(ctx, cx, cy, scale = 1, flipX = false) {
        ctx.save();
        ctx.translate(cx, cy);
        if (flipX) ctx.scale(-scale, scale);
        else ctx.scale(scale, scale);
        ctx.shadowColor = 'rgba(0, 0, 0, 0.28)';
        ctx.shadowBlur = 4;
        ctx.shadowOffsetY = 1.5;

        // Left holly leaf
        ctx.fillStyle = '#15803D';
        ctx.strokeStyle = '#052E16';
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.bezierCurveTo(-8, -10, -20, -12, -26, -6);
        ctx.bezierCurveTo(-20, 2, -10, 6, 0, 0);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        // Lower holly leaf
        ctx.fillStyle = '#16A34A';
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.bezierCurveTo(-4, 10, -12, 20, -6, 25);
        ctx.bezierCurveTo(4, 19, 8, 9, 0, 0);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        // Leaf veins
        ctx.strokeStyle = '#86EFAC';
        ctx.lineWidth = 1.1;
        ctx.beginPath();
        ctx.moveTo(-2, -1);
        ctx.lineTo(-20, -6);
        ctx.moveTo(-1, 2);
        ctx.lineTo(-5, 19);
        ctx.stroke();

        // Three glossy crimson holly berries
        const berries = [[-3, -3, 4.6, '#DC2626'], [4, -1, 4.2, '#EF4444'], [0, 5, 4.2, '#B91C1C']];
        for (const [bx, by, br, col] of berries) {
            ctx.fillStyle = col;
            ctx.strokeStyle = '#7F1D1D';
            ctx.lineWidth = 1.1;
            ctx.beginPath();
            ctx.arc(bx, by, br, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
            ctx.fillStyle = '#FFFFFF';
            ctx.beginPath();
            ctx.arc(bx - br * 0.3, by - br * 0.3, br * 0.28, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.restore();
    },

    _drawSnowflakeOrnament(ctx, cx, cy, r = 10, strokeColor = '#FFFFFF') {
        ctx.save();
        ctx.translate(cx, cy);
        ctx.strokeStyle = strokeColor || '#FFFFFF';
        ctx.lineWidth = 1.8;
        ctx.lineCap = 'round';
        for (let i = 0; i < 6; i++) {
            const ang = (i * Math.PI) / 3;
            const ex = Math.cos(ang) * r;
            const ey = Math.sin(ang) * r;
            const mx = Math.cos(ang) * (r * 0.56);
            const my = Math.sin(ang) * (r * 0.56);
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.lineTo(ex, ey);
            ctx.moveTo(mx, my);
            ctx.lineTo(mx + Math.cos(ang + 0.6) * (r * 0.34), my + Math.sin(ang + 0.6) * (r * 0.34));
            ctx.moveTo(mx, my);
            ctx.lineTo(mx + Math.cos(ang - 0.6) * (r * 0.34), my + Math.sin(ang - 0.6) * (r * 0.34));
            ctx.stroke();
        }
        ctx.fillStyle = '#FEF08A';
        ctx.beginPath();
        ctx.arc(0, 0, r * 0.22, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    },

    _traceHandTornCardPath(ctx, rx, ry, rw, rh, amp = 4.5, seedBase = 101, scrollOffsetY = 0) {
        const step = 18;
        const jit = (idx, salt) => {
            const h = Math.sin((idx * 127.1 + seedBase * 311.7 + salt * 74.7)) * 43758.5453;
            return ((h - Math.floor(h)) - 0.5) * 2 * amp;
        };
        const smoothJit = (coord, period, salt) => {
            const u = coord / period;
            const i0 = Math.floor(u);
            const f = u - i0;
            const s = f * f * (3 - 2 * f);
            return jit(i0, salt) * (1 - s) + jit(i0 + 1, salt) * s;
        };
        const vScroll = Number.isFinite(Number(scrollOffsetY)) ? Number(scrollOffsetY) : 0;
        ctx.beginPath();
        ctx.moveTo(rx + jit(0, 1) * 0.4, ry + jit(0, 2) * 0.4);
        const topSteps = Math.max(4, Math.round(rw / step));
        for (let i = 1; i <= topSteps; i++) {
            const px = rx + (rw * i) / topSteps;
            const py = ry + jit(i, 3);
            ctx.lineTo(px, py);
        }
        const rightSteps = Math.max(4, Math.round(rh / step));
        for (let i = 1; i <= rightSteps; i++) {
            const frac = i / rightSteps;
            const py = ry + rh * frac;
            const edgeTaper = Math.min(1, Math.min(frac, 1 - frac) * 5);
            const tearX = Math.abs(vScroll) > 0.01
                ? smoothJit((py - ry) - vScroll, step, 4) * edgeTaper + jit(i, 4) * (1 - edgeTaper)
                : jit(i, 4);
            const px = rx + rw + tearX;
            ctx.lineTo(px, py);
        }
        for (let i = topSteps - 1; i >= 0; i--) {
            const px = rx + (rw * i) / topSteps;
            const py = ry + rh + jit(i, 5);
            ctx.lineTo(px, py);
        }
        for (let i = rightSteps - 1; i >= 1; i--) {
            const frac = i / rightSteps;
            const py = ry + rh * frac;
            const edgeTaper = Math.min(1, Math.min(frac, 1 - frac) * 5);
            const tearX = Math.abs(vScroll) > 0.01
                ? smoothJit((py - ry) - vScroll, step, 6) * edgeTaper + jit(i, 6) * (1 - edgeTaper)
                : jit(i, 6);
            const px = rx + tearX;
            ctx.lineTo(px, py);
        }
        ctx.closePath();
    },

    /**
     * 绘制滚动字幕 / 文字卡片的整块主题背景画板（旧报纸整版、羊皮卷、牛皮纸画板、圣诞拐杖糖框、圣诞红丝绒贺卡、松林覆雪板、姜饼屋糖霜卡、飘雪夜空等）
     * 支持 opts.scrollOffsetY 让报纸版面、纹理、折痕与内嵌装饰跟随字幕向上循环卷动。
     */
};
function _decorHash(n) {
    const s = Math.sin(n * 127.1 + 311.7) * 43758.5453123;
    return s - Math.floor(s);
}

/**
 * 绘制一颗带柔和放射光晕与十字/八角星芒的发光星星
 */
function _drawGlowingStar(ctx, cx, cy, radius, colorCore, colorHalo, glowMul, points = 4, rot = 0) {
    if (radius <= 0.5) return;
    ctx.save();
    ctx.translate(cx, cy);
    if (rot) ctx.rotate(rot);

    // 1. 柔和放射光晕 (Radial Halo)
    if (glowMul > 0.02 && typeof ctx.createRadialGradient === 'function') {
        const haloR = radius * (1.8 + glowMul * 1.6);
        const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, haloR);
        grad.addColorStop(0, colorCore || '#FFFDF5');
        grad.addColorStop(0.28, colorHalo || '#FFD700');
        grad.addColorStop(1, 'rgba(255, 215, 0, 0)');
        ctx.save();
        ctx.globalAlpha *= Math.min(1, 0.55 * glowMul);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(0, 0, haloR, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }

    // 2. 四角或八角星芒尖刺
    ctx.fillStyle = colorHalo || '#FFD700';
    const drawFourPoint = (rOuter, rInner) => {
        ctx.beginPath();
        for (let i = 0; i < 8; i++) {
            const a = (i * Math.PI) / 4;
            const r = (i % 2 === 0) ? rOuter : rInner;
            const px = Math.cos(a) * r;
            const py = Math.sin(a) * r;
            if (i === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.fill();
    };
    drawFourPoint(radius * 1.35, radius * 0.22);
    if (points >= 8) {
        ctx.save();
        ctx.rotate(Math.PI / 4);
        ctx.globalAlpha *= 0.78;
        drawFourPoint(radius * 0.92, radius * 0.16);
        ctx.restore();
    }

    // 3. 高亮白金星核
    ctx.fillStyle = colorCore || '#FFFFFF';
    ctx.beginPath();
    ctx.arc(0, 0, Math.max(1.2, radius * 0.26), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
}

/**
 * 绘制圣诞蝴蝶结与松枝角花
 */
function _drawXmasCornerBowAndPine(ctx, cx, cy, scale, rotRad, colorRibbon = '#DC2626', colorGold = '#FFD700') {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rotRad);
    ctx.scale(scale, scale);

    // 1. 两侧松枝 (Pine boughs)
    ctx.strokeStyle = '#14532D';
    ctx.lineWidth = 3.2;
    ctx.lineCap = 'round';
    for (const dir of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.quadraticCurveTo(dir * 38, -8, dir * 78, dir === 1 ? 18 : -18);
        ctx.stroke();
        // 松针簇
        ctx.strokeStyle = '#15803D';
        ctx.lineWidth = 1.8;
        for (let step = 12; step <= 72; step += 10) {
            const bx = dir * step;
            const by = (step / 78) * (dir === 1 ? 10 : -10);
            ctx.beginPath();
            ctx.moveTo(bx, by);
            ctx.lineTo(bx + dir * 8, by - 11);
            ctx.moveTo(bx, by);
            ctx.lineTo(bx + dir * 10, by + 9);
            ctx.stroke();
        }
    }

    // 2. 蝴蝶结双耳与飘带 (Festive Ribbon Bow)
    ctx.fillStyle = colorRibbon;
    ctx.strokeStyle = colorGold;
    ctx.lineWidth = 1.6;
    for (const dir of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.bezierCurveTo(dir * 26, -24, dir * 36, 12, 0, 6);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        // 垂下的飘带尾
        ctx.beginPath();
        ctx.moveTo(dir * 4, 4);
        ctx.quadraticCurveTo(dir * 18, 22, dir * 24, 38);
        ctx.lineTo(dir * 14, 34);
        ctx.lineTo(dir * 10, 42);
        ctx.quadraticCurveTo(dir * 6, 22, 0, 6);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
    }

    // 3. 中心金结与冬青红果
    ctx.fillStyle = colorGold;
    ctx.beginPath();
    ctx.arc(0, 2, 6.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#EF4444';
    for (const [bx, by] of [[-6, -5], [6, -5], [0, -8]]) {
        ctx.beginPath();
        ctx.arc(bx, by, 3.8, 0, Math.PI * 2);
        ctx.fill();
    }
    ctx.restore();
}

/**
 * 绘制古典巴洛克烫金雕花角饰
 */
function _drawBaroqueCornerFlourish(ctx, cx, cy, scale, flipX, flipY, colorGold = '#D4AF37', colorLight = '#FFF6D6') {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(flipX ? -scale : scale, flipY ? -scale : scale);

    ctx.strokeStyle = colorGold;
    ctx.lineWidth = 2.6;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // 主L形双轨涡卷
    ctx.beginPath();
    ctx.moveTo(6, 78);
    ctx.bezierCurveTo(6, 26, 26, 6, 78, 6);
    ctx.stroke();

    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(14, 62);
    ctx.bezierCurveTo(14, 30, 30, 14, 62, 14);
    ctx.stroke();

    // 巴洛克内旋涡卷 (Scroll curls)
    ctx.beginPath();
    ctx.moveTo(6, 78);
    ctx.bezierCurveTo(18, 82, 24, 70, 16, 64);
    ctx.moveTo(78, 6);
    ctx.bezierCurveTo(82, 18, 70, 24, 64, 16);
    ctx.moveTo(22, 22);
    ctx.bezierCurveTo(38, 22, 44, 36, 32, 42);
    ctx.bezierCurveTo(24, 46, 20, 36, 28, 32);
    ctx.stroke();

    // 角顶菱形星花
    ctx.fillStyle = colorLight;
    ctx.beginPath();
    ctx.moveTo(10, 2);
    ctx.lineTo(16, 10);
    ctx.lineTo(10, 18);
    ctx.lineTo(4, 10);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.restore();
}

/**
 * 绘制复古玫瑰与藤蔓角饰
 */
function _drawRoseCornerVine(ctx, cx, cy, scale, flipX, flipY, colorRose = '#E11D48', colorGold = '#FDE68A') {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(flipX ? -scale : scale, flipY ? -scale : scale);

    // 藤蔓枝条
    ctx.strokeStyle = '#3F6212';
    ctx.lineWidth = 2.4;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(8, 82);
    ctx.quadraticCurveTo(10, 14, 82, 8);
    ctx.stroke();

    // 叶片
    ctx.fillStyle = '#4D7C0F';
    ctx.strokeStyle = colorGold;
    ctx.lineWidth = 1;
    for (const [lx, ly, ang] of [[14, 52, -0.5], [26, 32, -0.8], [52, 14, -1.1], [34, 46, 0.4], [48, 28, 0.2]]) {
        ctx.save();
        ctx.translate(lx, ly);
        ctx.rotate(ang);
        ctx.beginPath();
        ctx.ellipse(0, 0, 9, 4.5, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
    }

    // 玫瑰主花朵 (Layered Rose Blossom)
    const drawRose = (rx, ry, rSize) => {
        ctx.save();
        ctx.translate(rx, ry);
        ctx.fillStyle = colorRose;
        ctx.strokeStyle = '#FFF1F2';
        ctx.lineWidth = 1.1;
        for (let p = 0; p < 5; p++) {
            const a = (p * Math.PI * 2) / 5;
            ctx.beginPath();
            ctx.arc(Math.cos(a) * rSize * 0.38, Math.sin(a) * rSize * 0.38, rSize * 0.55, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
        }
        ctx.fillStyle = '#FB7185';
        ctx.beginPath();
        ctx.arc(0, 0, rSize * 0.45, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = colorGold;
        ctx.beginPath();
        ctx.arc(0, 0, rSize * 0.22, 0, Math.PI * 1.5);
        ctx.stroke();
        ctx.restore();
    };
    drawRose(20, 20, 14);
    drawRose(44, 14, 8.5);
    drawRose(14, 44, 8.5);
    ctx.restore();
}

const _filmGrainTileCache = new Map();

/**
 * 获取或生成 240x240 离屏 35mm 胶片颗粒噪点瓦片 (支持暖黄怀旧色调与银盐黑白颗粒)
 */
function _getFilmGrainTileCanvas(warmthRatio = 0) {
    const bucket = Math.round(Math.max(0, Math.min(1, warmthRatio)) * 4);
    if (_filmGrainTileCache.has(bucket)) return _filmGrainTileCache.get(bucket);
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null;
    try {
        const size = 240;
        const c = document.createElement('canvas');
        c.width = size;
        c.height = size;
        const gctx = c.getContext && c.getContext('2d');
        if (!gctx || typeof gctx.createImageData !== 'function') return null;
        const img = gctx.createImageData(size, size);
        const data = img.data;
        const wMix = bucket / 4;
        for (let i = 0, p = 0; p < size * size; p++, i += 4) {
            const n = _decorHash(p * 1.37 + bucket * 97.3);
            const n2 = _decorHash(p * 3.71 + 19.1);
            // 模拟银盐胶片双峰微粒：高光亮斑 + 暗部微粒，中间透明不发灰
            if (n > 0.62) {
                const intensity = (n - 0.62) / 0.38;
                data[i] = 255;
                data[i + 1] = Math.round(252 - wMix * 28);
                data[i + 2] = Math.round(245 - wMix * 68);
                data[i + 3] = Math.round((45 + n2 * 115) * intensity);
            } else if (n < 0.34) {
                const intensity = (0.34 - n) / 0.34;
                data[i] = Math.round(24 * wMix);
                data[i + 1] = Math.round(14 * wMix);
                data[i + 2] = Math.round(6 * wMix);
                data[i + 3] = Math.round((42 + n2 * 110) * intensity);
            } else {
                data[i + 3] = 0;
            }
        }
        gctx.putImageData(img, 0, 0);
        _filmGrainTileCache.set(bucket, c);
        return c;
    } catch (_) {
        return null;
    }
}

/**
 * 绘制圣诞金铃铛与冬青红丝带角饰
 */
function _drawXmasGoldenBellOrnament(ctx, cx, cy, scale, swayAng = 0, colorGold = '#F59E0B', colorRibbon = '#DC2626') {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(swayAng);
    ctx.scale(scale, scale);

    // 顶部冬青叶与蝴蝶结
    ctx.fillStyle = '#15803D';
    for (const dir of [-1, 1]) {
        ctx.beginPath();
        ctx.ellipse(dir * 16, -12, 14, 6.5, dir * 0.35, 0, Math.PI * 2);
        ctx.fill();
    }
    ctx.fillStyle = colorRibbon;
    for (const dir of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(0, -10);
        ctx.bezierCurveTo(dir * 22, -26, dir * 28, 4, 0, -4);
        ctx.closePath();
        ctx.fill();
    }

    // 双金铃铛 (Twin Golden Bells)
    for (const [bx, by, rot] of [[-11, 8, 0.24], [11, 8, -0.24]]) {
        ctx.save();
        ctx.translate(bx, by);
        ctx.rotate(rot);
        ctx.fillStyle = colorGold;
        ctx.strokeStyle = '#FEF08A';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(-10, -12);
        ctx.quadraticCurveTo(-12, 4, -16, 12);
        ctx.lineTo(16, 12);
        ctx.quadraticCurveTo(12, 4, 10, -12);
        ctx.arc(0, -12, 10, 0, Math.PI, true);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        // 铃舌圆珠
        ctx.fillStyle = '#B45309';
        ctx.beginPath();
        ctx.arc(0, 14, 4.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }

    // 中心红果
    ctx.fillStyle = '#EF4444';
    for (const [rx, ry] of [[-4, -9], [4, -9], [0, -13]]) {
        ctx.beginPath();
        ctx.arc(rx, ry, 3.6, 0, Math.PI * 2);
        ctx.fill();
    }
    ctx.restore();
}

/**
 * 渲染点缀装饰覆层 (_drawDecorOverlay)
 * 支持：黑色氛围模板 / 飘浮粒子 / 电影颗粒 / 回忆颗粒感 / 胶片划痕与漏光 / 发光星芒 / 圣诞装饰 / 复古边框
 */
function _drawDecorOverlay(ctx, ov, x, y, w, h, currentTime, canvasW, canvasH) {
    if (w <= 10 || h <= 10) return;
    const styleId = ov.decor_style || 'glowing_starfield';
    const preset = DECOR_OVERLAY_STYLES[styleId] || DECOR_OVERLAY_STYLES.glowing_starfield;
    const layout = ov.decor_layout || preset.layout || 'edges_and_float';
    const density = Math.max(5, Math.min(200, Number(ov.decor_density ?? preset.density ?? 55)));
    const sizeMul = Math.max(0.2, Math.min(3.5, Number(ov.decor_size ?? 100) / 100));
    const glowMul = Math.max(0, Math.min(2.5, Number(ov.decor_glow ?? 100) / 100));
    const speedMul = Math.max(0, Math.min(3.5, Number(ov.decor_speed ?? 100) / 100));
    const margin = Math.max(0, Math.min(Math.min(w, h) * 0.35, Number(ov.decor_margin ?? 36)));
    const centerClearRatio = Math.max(0, Math.min(0.95, Number(ov.decor_center_clear ?? preset.center_clear ?? 65) / 100));
    const color1 = ov.decor_color1 || preset.color1 || '#FFD700';
    const color2 = ov.decor_color2 || preset.color2 || '#FFFDF5';

    const showStars = ov.decor_glow_stars !== undefined ? Boolean(ov.decor_glow_stars) : Boolean(preset.glow_stars);
    const showSnow = ov.decor_snowflakes !== undefined ? Boolean(ov.decor_snowflakes) : Boolean(preset.snowflakes);
    const showCorners = ov.decor_corner_ornaments !== undefined ? Boolean(ov.decor_corner_ornaments) : Boolean(preset.corner_ornaments);
    const showEdgeGarland = ov.decor_edge_garland !== undefined ? Boolean(ov.decor_edge_garland) : Boolean(preset.edge_garland);

    // 黑色模板 / 飘浮粒子 / 电影与回忆颗粒参数
    const darkVignette = Math.max(0, Math.min(100, Number(ov.decor_dark_vignette ?? preset.dark_vignette ?? 0)));
    const vignetteSpread = Math.max(10, Math.min(95, Number(ov.decor_vignette_spread ?? preset.vignette_spread ?? 55)));
    const darkTint = ov.decor_dark_tint || preset.dark_tint || '#05070B';
    const showDarkTemplate = ov.decor_dark_enabled !== undefined
        ? Boolean(ov.decor_dark_enabled)
        : (darkVignette > 0);
    const showFloatingParticles = ov.decor_floating_particles !== undefined
        ? Boolean(ov.decor_floating_particles)
        : Boolean(preset.floating_particles);
    const particleMode = ov.decor_particle_mode || preset.particle_mode || 'dust';
    const grainIntensity = Math.max(0, Math.min(100, Number(ov.decor_grain_intensity ?? preset.grain_intensity ?? 0)));
    const grainSizeMul = Math.max(0.5, Math.min(2.5, Number(ov.decor_grain_size ?? preset.grain_size ?? 100) / 100));
    const grainWarmth = Math.max(0, Math.min(100, Number(ov.decor_grain_warmth ?? preset.grain_warmth ?? 0)));
    const showFilmGrain = ov.decor_grain_enabled !== undefined
        ? Boolean(ov.decor_grain_enabled)
        : (grainIntensity > 0 || grainWarmth > 0);
    const showFilmScratches = ov.decor_film_scratches !== undefined
        ? Boolean(ov.decor_film_scratches)
        : Boolean(preset.film_scratches);
    const showLightLeak = ov.decor_light_leak !== undefined
        ? Boolean(ov.decor_light_leak)
        : Boolean(preset.light_leak);

    const rawTime = Math.max(0, Number(currentTime) || 0);
    const t = rawTime * speedMul;
    const filmFrameIdx = Math.floor(rawTime * 24);

    ov._renderedX = x;
    ov._renderedY = y;
    ov._renderedW = w;
    ov._renderedH = h;

    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();

    const bx = x + margin;
    const by = y + margin;
    const bw = Math.max(20, w - margin * 2);
    const bh = Math.max(20, h - margin * 2);

    // ══════════════════════════════════════════════════
    // 0A. 黑色氛围模板 / 宽银幕暗角 / 怀旧泛黄色调 (Dark Template & Nostalgia Tint)
    // ══════════════════════════════════════════════════
    if (showFilmGrain && grainWarmth > 0) {
        ctx.save();
        const warmAlpha = (grainWarmth / 100) * 0.24;
        ctx.fillStyle = `rgba(196, 134, 62, ${warmAlpha.toFixed(3)})`;
        ctx.fillRect(x, y, w, h);
        ctx.restore();
    }

    if (showDarkTemplate && darkVignette > 0) {
        ctx.save();
        const vigAlpha = Math.min(0.96, (darkVignette / 100) * 0.94);
        const spreadFrac = vignetteSpread / 100; // 越大越向中心聚拢
        const cx = x + w * 0.5;
        const cy = y + h * 0.5;
        const rInner = Math.min(w, h) * Math.max(0.08, (1 - spreadFrac) * 0.52);
        const rOuter = Math.hypot(w, h) * 0.54;

        if (typeof ctx.createRadialGradient === 'function') {
            const vigGrad = ctx.createRadialGradient(cx, cy, rInner, cx, cy, rOuter);
            vigGrad.addColorStop(0, _withAlpha(darkTint, 0));
            vigGrad.addColorStop(0.55, _withAlpha(darkTint, vigAlpha * 0.48));
            vigGrad.addColorStop(1, _withAlpha(darkTint, vigAlpha));
            ctx.fillStyle = vigGrad;
            ctx.fillRect(x, y, w, h);
        } else {
            ctx.fillStyle = _withAlpha(darkTint, vigAlpha * 0.35);
            ctx.fillRect(x, y, w, h);
        }

        // 上下暗黑电影遮幅渐变（让顶部标题与底部滚动字幕更醒目深邃）
        if (typeof ctx.createLinearGradient === 'function') {
            const matteH = h * (0.16 + spreadFrac * 0.16);
            const topMatte = ctx.createLinearGradient(0, y, 0, y + matteH);
            topMatte.addColorStop(0, _withAlpha(darkTint, Math.min(0.95, vigAlpha * 0.85)));
            topMatte.addColorStop(1, _withAlpha(darkTint, 0));
            ctx.fillStyle = topMatte;
            ctx.fillRect(x, y, w, matteH);

            const botMatte = ctx.createLinearGradient(0, y + h, 0, y + h - matteH * 1.15);
            botMatte.addColorStop(0, _withAlpha(darkTint, Math.min(0.96, vigAlpha * 0.92)));
            botMatte.addColorStop(1, _withAlpha(darkTint, 0));
            ctx.fillStyle = botMatte;
            ctx.fillRect(x, y + h - matteH * 1.15, w, matteH * 1.15);

            // 黑金余烬底部炽热烘托或烛光圣殿顶部暖光
            if (styleId === 'dark_gold_embers' || particleMode === 'embers') {
                const emberGlow = ctx.createLinearGradient(0, y + h, 0, y + h * 0.72);
                emberGlow.addColorStop(0, _withAlpha(color1, 0.28 * glowMul));
                emberGlow.addColorStop(1, 'rgba(0,0,0,0)');
                ctx.fillStyle = emberGlow;
                ctx.fillRect(x, y + h * 0.72, w, h * 0.28);
            } else if (styleId === 'dark_holy_halo_dust') {
                const haloGlow = ctx.createRadialGradient(cx, y + h * 0.12, 0, cx, y + h * 0.12, w * 0.65);
                haloGlow.addColorStop(0, _withAlpha(color1, 0.26 * glowMul));
                haloGlow.addColorStop(1, 'rgba(0,0,0,0)');
                ctx.fillStyle = haloGlow;
                ctx.fillRect(x, y, w, h * 0.6);
            }
        }
        ctx.restore();
    }

    // ══════════════════════════════════════════════════
    // 0B. 复古胶片边缘漏光与柔焦光晕 (Film Light Leaks)
    // ══════════════════════════════════════════════════
    if (showLightLeak && typeof ctx.createRadialGradient === 'function') {
        ctx.save();
        const leakSpots = [
            { ux: 0.05 + 0.08 * Math.sin(t * 0.45), uy: 0.22 + 0.12 * Math.cos(t * 0.35), col: '#FB923C', rMul: 0.58 },
            { ux: 0.94 + 0.06 * Math.cos(t * 0.52), uy: 0.76 + 0.10 * Math.sin(t * 0.4),  col: '#F43F5E', rMul: 0.52 },
            { ux: 0.18 + 0.10 * Math.sin(t * 0.3 + 2), uy: 0.88, col: '#FBBF24', rMul: 0.45 },
        ];
        for (let li = 0; li < leakSpots.length; li++) {
            const sp = leakSpots[li];
            const pulse = 0.55 + 0.45 * Math.sin(t * 0.9 + li * 2.1);
            const lx = x + w * sp.ux;
            const ly = y + h * sp.uy;
            const lr = Math.max(w, h) * sp.rMul * sizeMul;
            const lg = ctx.createRadialGradient(lx, ly, 0, lx, ly, lr);
            lg.addColorStop(0, _withAlpha(sp.col, 0.34 * pulse * glowMul));
            lg.addColorStop(0.45, _withAlpha('#FDE68A', 0.14 * pulse * glowMul));
            lg.addColorStop(1, 'rgba(255, 180, 80, 0)');
            ctx.fillStyle = lg;
            ctx.fillRect(x, y, w, h);
        }
        ctx.restore();
    }

    // ══════════════════════════════════════════════════
    // 0C. 电影颗粒 / 回忆颗粒感 / 8mm划痕 / VHS扫描线 (Film Grain & Scratches)
    // ══════════════════════════════════════════════════
    if (showFilmGrain && grainIntensity > 0) {
        ctx.save();
        const gAlpha = Math.min(0.92, (grainIntensity / 100) * 0.78);
        const tile = _getFilmGrainTileCanvas(grainWarmth / 100);
        if (tile && typeof ctx.drawImage === 'function') {
            ctx.globalAlpha *= gAlpha;
            const tileDrawSize = Math.max(96, Math.round(220 * grainSizeMul));
            const jitterX = Math.floor(_decorHash(filmFrameIdx * 17.3 + 3.1) * tileDrawSize);
            const jitterY = Math.floor(_decorHash(filmFrameIdx * 31.7 + 9.7) * tileDrawSize);
            for (let gy = y - jitterY; gy < y + h; gy += tileDrawSize) {
                for (let gx = x - jitterX; gx < x + w; gx += tileDrawSize) {
                    ctx.drawImage(tile, gx, gy, tileDrawSize, tileDrawSize);
                }
            }
        }
        // 叠加动态胶片微粒点（同时保证无 DOM 单元测试与高分辨率质感）
        const speckCount = Math.round((28 + grainIntensity * 0.85) * Math.min(1.6, density / 50));
        for (let gi = 0; gi < speckCount; gi++) {
            const gh1 = _decorHash(filmFrameIdx * 43.1 + gi * 7.13);
            const gh2 = _decorHash(filmFrameIdx * 19.7 + gi * 13.37);
            const gh3 = _decorHash(filmFrameIdx * 11.3 + gi * 29.1);
            const gx = x + gh1 * w;
            const gy = y + gh2 * h;
            const gr = (0.9 + gh3 * 2.1) * grainSizeMul;
            ctx.fillStyle = (gi % 3 === 0)
                ? `rgba(255, 248, 231, ${(0.12 + 0.25 * gh3) * gAlpha})`
                : `rgba(15, 12, 8, ${(0.14 + 0.28 * gh3) * gAlpha})`;
            ctx.fillRect(gx, gy, gr, gr);
        }
        ctx.restore();
    }

    if (showFilmScratches) {
        ctx.save();
        if (styleId === 'vhs_retro_scanlines') {
            // VHS CRT 水平扫描线与磁带追踪波纹
            ctx.fillStyle = 'rgba(0, 0, 0, 0.16)';
            const stepY = Math.max(4, Math.round(6 * sizeMul));
            for (let sy = y; sy < y + h; sy += stepY) {
                ctx.fillRect(x, sy, w, Math.max(1.5, stepY * 0.42));
            }
            const trackY = y + ((rawTime * 160) % h);
            ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
            ctx.fillRect(x, trackY, w, 14 * sizeMul);
        } else {
            // 8mm / 老电影纵向划痕、毛发灰尘与轻微放映机明暗闪烁
            const flicker = _decorHash(filmFrameIdx * 7.9);
            if (flicker > 0.78) {
                ctx.fillStyle = `rgba(255, 245, 220, ${(flicker - 0.78) * 0.18})`;
                ctx.fillRect(x, y, w, h);
            }
            const scratchCount = 3;
            for (let si = 0; si < scratchCount; si++) {
                const sVis = _decorHash(filmFrameIdx * 3.1 + si * 41.7);
                if (sVis > 0.35) {
                    const sx = x + w * (0.12 + 0.76 * _decorHash(Math.floor(filmFrameIdx / 2) * 13.7 + si * 23.1));
                    const drift = (_decorHash(filmFrameIdx + si) - 0.5) * 6;
                    ctx.strokeStyle = (si % 2 === 0)
                        ? 'rgba(255, 250, 235, 0.28)'
                        : 'rgba(20, 15, 10, 0.32)';
                    ctx.lineWidth = (0.9 + (si % 2) * 0.7) * sizeMul;
                    ctx.beginPath();
                    ctx.moveTo(sx, y);
                    ctx.quadraticCurveTo(sx + drift * 2, y + h * 0.5, sx - drift, y + h);
                    ctx.stroke();
                }
            }
        }
        ctx.restore();
    }

    // ══════════════════════════════════════════════════
    // 1. 主题专属边缘底纹 / 光束 / 串灯 / 藤蔓 / 吊球 / 画框 (Edge Garland Layer)
    // ══════════════════════════════════════════════════
    if (showEdgeGarland && layout !== 'corners_only') {
        if (styleId === 'angelic_rays_stars' || styleId === 'golden_meteor_dust' || styleId === 'dark_holy_halo_dust') {
            // 顶部圣洁光芒束 (Heavenly Light Rays from Top)
            ctx.save();
            const rayCount = 7;
            for (let r = 0; r < rayCount; r++) {
                const sway = Math.sin(t * 0.7 + r * 1.1) * 0.04;
                const angle = Math.PI * 0.32 + (r / (rayCount - 1)) * Math.PI * 0.36 + sway;
                const ox = x + w * (0.2 + 0.6 * (r / (rayCount - 1)));
                const oy = y - 40;
                const rayLen = Math.max(w, h) * 0.75;
                if (typeof ctx.createLinearGradient === 'function') {
                    const grad = ctx.createLinearGradient(ox, oy, ox + Math.cos(angle) * rayLen, oy + Math.sin(angle) * rayLen);
                    grad.addColorStop(0, _withAlpha(color1, 0.22 * glowMul));
                    grad.addColorStop(0.5, _withAlpha(color2, 0.08 * glowMul));
                    grad.addColorStop(1, 'rgba(255,255,255,0)');
                    ctx.fillStyle = grad;
                    ctx.beginPath();
                    ctx.moveTo(ox - 28 * sizeMul, oy);
                    ctx.lineTo(ox + 28 * sizeMul, oy);
                    ctx.lineTo(ox + Math.cos(angle) * rayLen + 95 * sizeMul, oy + Math.sin(angle) * rayLen);
                    ctx.lineTo(ox + Math.cos(angle) * rayLen - 95 * sizeMul, oy + Math.sin(angle) * rayLen);
                    ctx.closePath();
                    ctx.fill();
                }
            }
            ctx.restore();
        }

        if (styleId === 'fairy_bokeh_lights') {
            // 顶部与左右边缘梦幻暖金串灯 (Hanging Fairy String Lights)
            ctx.save();
            const arches = Math.max(3, Math.round(bw / 210));
            const archW = bw / arches;
            ctx.strokeStyle = 'rgba(253, 230, 138, 0.45)';
            ctx.lineWidth = 1.8 * sizeMul;
            for (let a = 0; a < arches; a++) {
                const sx = bx + a * archW;
                const ex = sx + archW;
                const sag = (34 + (a % 2) * 14) * sizeMul;
                ctx.beginPath();
                ctx.moveTo(sx, by);
                ctx.quadraticCurveTo((sx + ex) * 0.5, by + sag, ex, by);
                ctx.stroke();

                const bulbs = 5;
                for (let b = 0; b <= bulbs; b++) {
                    const u = b / bulbs;
                    const lx = sx + (ex - sx) * u;
                    const ly = by + 4 * u * (1 - u) * sag;
                    const pulse = 0.65 + 0.35 * Math.sin(t * 3.2 + a * 1.7 + b * 1.3);
                    _drawGlowingStar(ctx, lx, ly + 4 * sizeMul, (10 + 4 * pulse) * sizeMul, color2, color1, glowMul * pulse, 4, 0);
                }
            }
            ctx.restore();
        }

        if (styleId === 'xmas_holly_pine_garland' || styleId === 'xmas_golden_bells_reindeer') {
            // 四周松枝花环与彩灯点缀
            ctx.save();
            const step = Math.max(36, 56 * sizeMul);
            ctx.strokeStyle = '#15803D';
            ctx.lineWidth = 4.5 * sizeMul;
            ctx.lineCap = 'round';
            for (const edgeY of [by, by + bh]) {
                for (let gx = bx + 20; gx < bx + bw - 20; gx += step) {
                    const wave = Math.sin(gx * 0.04) * 6 * sizeMul;
                    ctx.strokeStyle = '#14532D';
                    ctx.beginPath();
                    ctx.moveTo(gx - step * 0.5, edgeY + wave);
                    ctx.lineTo(gx + step * 0.5, edgeY - wave);
                    ctx.stroke();
                    ctx.strokeStyle = '#16A34A';
                    ctx.lineWidth = 2.2 * sizeMul;
                    for (let k = -2; k <= 2; k++) {
                        ctx.beginPath();
                        ctx.moveTo(gx + k * 7 * sizeMul, edgeY);
                        ctx.lineTo(gx + (k * 7 + 6) * sizeMul, edgeY + (k % 2 === 0 ? -11 : 11) * sizeMul);
                        ctx.stroke();
                    }
                    if (Math.round(gx / step) % 2 === 0) {
                        ctx.fillStyle = color1;
                        ctx.beginPath();
                        ctx.arc(gx, edgeY, 4.5 * sizeMul, 0, Math.PI * 2);
                        ctx.fill();
                        const twinkle = 0.6 + 0.4 * Math.sin(t * 3.0 + gx * 0.1);
                        _drawGlowingStar(ctx, gx + step * 0.45, edgeY, 9 * sizeMul * twinkle, '#FFFBEB', color2, glowMul, 4, 0);
                    }
                }
            }
            if (styleId === 'xmas_golden_bells_reindeer') {
                ctx.strokeStyle = _withAlpha(color1, 0.72);
                ctx.lineWidth = 2.5 * sizeMul;
                ctx.strokeRect(bx, by, bw, bh);
                // 顶部中央悬挂双金铃铛
                const bellSway = Math.sin(t * 2.2) * 0.08;
                _drawXmasGoldenBellOrnament(ctx, bx + bw * 0.5, by + 10 * sizeMul, 1.25 * sizeMul, bellSway, color1, color2);
            }
            ctx.restore();
        }

        if (styleId === 'xmas_hanging_baubles') {
            // 顶部垂挂圣诞彩球、八角金星与拐杖糖吊坠
            ctx.save();
            const count = Math.max(5, Math.min(16, Math.round(bw / (115 / Math.max(0.6, sizeMul)))));
            const spacing = bw / count;
            for (let i = 0; i < count; i++) {
                const hx = bx + spacing * (i + 0.5);
                const ropeLen = (55 + ((i * 37) % 75)) * sizeMul;
                const swayAng = Math.sin(t * 1.8 + i * 1.15) * 0.07;
                ctx.save();
                ctx.translate(hx, y);
                ctx.rotate(swayAng);

                ctx.strokeStyle = color2;
                ctx.lineWidth = 1.8 * sizeMul;
                ctx.beginPath();
                ctx.moveTo(0, 0);
                ctx.lineTo(0, ropeLen);
                ctx.stroke();

                const byBall = ropeLen + 16 * sizeMul;
                if (i % 3 === 1) {
                    _drawGlowingStar(ctx, 0, byBall, 20 * sizeMul, '#FFFFFF', color2, glowMul, 8, 0);
                } else {
                    const ballR = 16 * sizeMul;
                    const ballColor = (i % 2 === 0) ? color1 : '#15803D';
                    ctx.fillStyle = ballColor;
                    ctx.strokeStyle = color2;
                    ctx.lineWidth = 2 * sizeMul;
                    ctx.beginPath();
                    ctx.arc(0, byBall, ballR, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.stroke();
                    ctx.fillStyle = 'rgba(255,255,255,0.45)';
                    ctx.beginPath();
                    ctx.arc(-ballR * 0.32, byBall - ballR * 0.32, ballR * 0.28, 0, Math.PI * 2);
                    ctx.fill();
                }
                ctx.restore();
            }
            ctx.restore();
        }

        if (styleId === 'xmas_snowfall_frost') {
            ctx.save();
            if (typeof ctx.createLinearGradient === 'function') {
                const frostH = 95 * sizeMul;
                const topGrad = ctx.createLinearGradient(0, y, 0, y + frostH);
                topGrad.addColorStop(0, _withAlpha(color1, 0.55));
                topGrad.addColorStop(1, 'rgba(224, 242, 254, 0)');
                ctx.fillStyle = topGrad;
                ctx.fillRect(x, y, w, frostH);

                const botGrad = ctx.createLinearGradient(0, y + h, 0, y + h - frostH);
                botGrad.addColorStop(0, _withAlpha(color1, 0.55));
                botGrad.addColorStop(1, 'rgba(224, 242, 254, 0)');
                ctx.fillStyle = botGrad;
                ctx.fillRect(x, y + h - frostH, w, frostH);
            }
            ctx.restore();
        }

        if (styleId === 'xmas_candy_corner_ribbons') {
            ctx.save();
            ctx.strokeStyle = '#FFFFFF';
            ctx.lineWidth = 5 * sizeMul;
            ctx.strokeRect(bx, by, bw, bh);
            ctx.strokeStyle = color1;
            ctx.lineWidth = 5 * sizeMul;
            ctx.setLineDash([14 * sizeMul, 14 * sizeMul]);
            ctx.lineDashOffset = -t * 24;
            ctx.strokeRect(bx, by, bw, bh);
            ctx.setLineDash([]);
            ctx.restore();
        }

        if (styleId === 'vintage_gold_filigree' || styleId === 'rose_botanical_vine') {
            ctx.save();
            const frameCol = styleId === 'rose_botanical_vine' ? color2 : color1;
            ctx.strokeStyle = _withAlpha(frameCol, 0.72);
            ctx.lineWidth = 2.2 * sizeMul;
            ctx.strokeRect(bx, by, bw, bh);
            ctx.strokeStyle = _withAlpha(frameCol, 0.38);
            ctx.lineWidth = 1.1 * sizeMul;
            ctx.strokeRect(bx + 8 * sizeMul, by + 8 * sizeMul, Math.max(4, bw - 16 * sizeMul), Math.max(4, bh - 16 * sizeMul));

            for (const [mx, my] of [
                [bx + bw * 0.5, by],
                [bx + bw * 0.5, by + bh],
                [bx, by + bh * 0.5],
                [bx + bw, by + bh * 0.5],
            ]) {
                _drawGlowingStar(ctx, mx, my, 12 * sizeMul, color2, frameCol, glowMul * 0.8, 4, 0);
            }
            ctx.restore();
        }

        if (styleId === 'sacred_cathedral_arch') {
            // 圣经哥特尖拱窗烫金边框与顶部玫瑰花窗纹
            ctx.save();
            ctx.strokeStyle = _withAlpha(color1, 0.85);
            ctx.lineWidth = 3.2 * sizeMul;
            ctx.strokeRect(bx, by, bw, bh);
            const archTopY = by + 18 * sizeMul;
            const archSpringY = by + Math.min(bh * 0.28, 260 * sizeMul);
            ctx.beginPath();
            ctx.moveTo(bx + 12 * sizeMul, by + bh - 12 * sizeMul);
            ctx.lineTo(bx + 12 * sizeMul, archSpringY);
            ctx.quadraticCurveTo(bx + 12 * sizeMul, archTopY + 24 * sizeMul, bx + bw * 0.5, archTopY);
            ctx.quadraticCurveTo(bx + bw - 12 * sizeMul, archTopY + 24 * sizeMul, bx + bw - 12 * sizeMul, archSpringY);
            ctx.lineTo(bx + bw - 12 * sizeMul, by + bh - 12 * sizeMul);
            ctx.closePath();
            ctx.stroke();
            _drawGlowingStar(ctx, bx + bw * 0.5, archTopY + 28 * sizeMul, 18 * sizeMul, color2, color1, glowMul, 8, t * 0.2);
            ctx.restore();
        }

        if (styleId === 'polaroid_memory_border') {
            // 拍立得复古相纸边框（上左右窄白边 + 底部宽留白相纸框）
            ctx.save();
            const sideB = Math.max(18, margin * 0.85);
            const topB = Math.max(22, margin * 1.0);
            const botB = Math.max(68, margin * 2.5);
            ctx.fillStyle = color1 || '#FAF6EE';
            // 顶部、底部、左侧、右侧相纸遮罩条
            ctx.fillRect(x, y, w, topB);
            ctx.fillRect(x, y + h - botB, w, botB);
            ctx.fillRect(x, y + topB, sideB, Math.max(0, h - topB - botB));
            ctx.fillRect(x + w - sideB, y + topB, sideB, Math.max(0, h - topB - botB));
            // 相纸内框细微暗影边
            ctx.strokeStyle = 'rgba(60, 45, 30, 0.35)';
            ctx.lineWidth = 2;
            ctx.strokeRect(x + sideB, y + topB, Math.max(10, w - sideB * 2), Math.max(10, h - topB - botB));
            ctx.restore();
        }

        if (styleId === 'newspaper_torn_tape_frame') {
            ctx.save();
            ctx.strokeStyle = color1;
            ctx.lineWidth = 4 * sizeMul;
            DecorOrnaments._traceHandTornCardPath(ctx, bx, by, bw, bh, 12, 4.5 * sizeMul, t * 40);
            ctx.stroke();
            ctx.strokeStyle = color2;
            ctx.lineWidth = 1.8 * sizeMul;
            ctx.strokeRect(bx + 10 * sizeMul, by + 10 * sizeMul, Math.max(4, bw - 20 * sizeMul), Math.max(4, bh - 20 * sizeMul));
            ctx.restore();
        }

        if (
            styleId === 'cinema_vignette_grain' ||
            styleId === 'cinema_35mm_grain' ||
            styleId === 'vintage_8mm_scratches' ||
            styleId === 'noir_bw_high_grain'
        ) {
            // 电影感取景细框线
            ctx.save();
            ctx.strokeStyle = _withAlpha(color1, 0.36);
            ctx.lineWidth = 1.4 * sizeMul;
            ctx.strokeRect(bx, by, bw, bh);
            ctx.restore();
        }
    }

    // ══════════════════════════════════════════════════
    // 2. 四角主题精致挂饰 (Corner Ornaments Layer)
    // ══════════════════════════════════════════════════
    if (showCorners && layout !== 'full_scatter') {
        const cScale = 1.15 * sizeMul;
        const corners = [
            { cx: bx, cy: by, fx: false, fy: false, rot: -Math.PI * 0.25 },
            { cx: bx + bw, cy: by, fx: true, fy: false, rot: Math.PI * 0.25 },
            { cx: bx, cy: by + bh, fx: false, fy: true, rot: -Math.PI * 0.75 },
            { cx: bx + bw, cy: by + bh, fx: true, fy: true, rot: Math.PI * 0.75 },
        ];
        for (let ci = 0; ci < corners.length; ci++) {
            const c = corners[ci];
            if (
                styleId === 'xmas_holly_pine_garland' ||
                styleId === 'xmas_candy_corner_ribbons' ||
                styleId === 'xmas_hanging_baubles'
            ) {
                _drawXmasCornerBowAndPine(ctx, c.cx, c.cy, cScale, c.rot + Math.PI * 0.25, color1, color2);
            } else if (styleId === 'xmas_golden_bells_reindeer') {
                const bellSway = Math.sin(t * 2.1 + ci) * 0.08;
                _drawXmasGoldenBellOrnament(
                    ctx,
                    c.cx + (c.fx ? -24 : 24) * sizeMul,
                    c.cy + (c.fy ? -24 : 24) * sizeMul,
                    0.95 * sizeMul,
                    bellSway,
                    color1,
                    color2
                );
            } else if (styleId === 'xmas_snowfall_frost') {
                DecorOrnaments._drawSnowflakeOrnament(ctx, c.cx + (c.fx ? -16 : 16) * sizeMul, c.cy + (c.fy ? -16 : 16) * sizeMul, 20 * sizeMul, color1);
                DecorOrnaments._drawHollyOrnament(ctx, c.cx + (c.fx ? -36 : 36) * sizeMul, c.cy + (c.fy ? -12 : 12) * sizeMul, 0.95 * sizeMul, c.fx);
            } else if (
                styleId === 'vintage_gold_filigree' ||
                styleId === 'angelic_rays_stars' ||
                styleId === 'sacred_cathedral_arch' ||
                styleId === 'dark_holy_halo_dust'
            ) {
                _drawBaroqueCornerFlourish(ctx, c.cx, c.cy, cScale, c.fx, c.fy, color1, color2);
            } else if (styleId === 'rose_botanical_vine') {
                _drawRoseCornerVine(ctx, c.cx, c.cy, cScale, c.fx, c.fy, color1, color2);
            } else if (styleId === 'newspaper_torn_tape_frame') {
                ctx.save();
                ctx.translate(c.cx + (c.fx ? -22 : 22) * sizeMul, c.cy + (c.fy ? -22 : 22) * sizeMul);
                ctx.rotate((c.fx === c.fy) ? -Math.PI / 4 : Math.PI / 4);
                ctx.fillStyle = 'rgba(245, 236, 212, 0.78)';
                ctx.strokeStyle = 'rgba(180, 160, 125, 0.65)';
                ctx.lineWidth = 1.2;
                ctx.fillRect(-38 * sizeMul, -11 * sizeMul, 76 * sizeMul, 22 * sizeMul);
                ctx.strokeRect(-38 * sizeMul, -11 * sizeMul, 76 * sizeMul, 22 * sizeMul);
                ctx.restore();
            } else if (styleId === 'vhs_retro_scanlines' || styleId === 'cinema_vignette_grain') {
                // 电影/摄像机取景框直角折线 + REC 闪烁红点
                ctx.save();
                const arm = 36 * sizeMul;
                const dx = c.fx ? -1 : 1;
                const dy = c.fy ? -1 : 1;
                ctx.strokeStyle = 'rgba(255, 255, 255, 0.78)';
                ctx.lineWidth = 2.6 * sizeMul;
                ctx.beginPath();
                ctx.moveTo(c.cx, c.cy + dy * arm);
                ctx.lineTo(c.cx, c.cy);
                ctx.lineTo(c.cx + dx * arm, c.cy);
                ctx.stroke();
                if (ci === 0 && Math.floor(rawTime * 2) % 2 === 0) {
                    ctx.fillStyle = '#EF4444';
                    ctx.beginPath();
                    ctx.arc(c.cx + 22 * sizeMul, c.cy + 22 * sizeMul, 6 * sizeMul, 0, Math.PI * 2);
                    ctx.fill();
                }
                ctx.restore();
            } else {
                const pulse = 0.8 + 0.2 * Math.sin(t * 2.5 + ci);
                const sx = c.cx + (c.fx ? -18 : 18) * sizeMul;
                const sy = c.cy + (c.fy ? -18 : 18) * sizeMul;
                _drawGlowingStar(ctx, sx, sy, 22 * sizeMul * pulse, color2, color1, glowMul, 8, t * 0.25);
                _drawGlowingStar(ctx, sx + (c.fx ? -28 : 28) * sizeMul, sy + (c.fy ? 10 : -10) * sizeMul, 11 * sizeMul, color2, color1, glowMul * 0.8, 4, 0);
                _drawGlowingStar(ctx, sx + (c.fx ? 10 : -10) * sizeMul, sy + (c.fy ? -28 : 28) * sizeMul, 11 * sizeMul, color2, color1, glowMul * 0.8, 4, 0);
            }
        }
    }

    // 辅助函数：根据 layout 与 centerClearRatio 将 [0..1, 0..1] 映射到边缘或全屏坐标
    const mapParticlePos = (uRaw, vRaw, idx) => {
        if (layout === 'full_scatter') {
            return [bx + uRaw * bw, by + vRaw * bh];
        }
        if (layout === 'corners_only') {
            const cornerIdx = idx % 4;
            const spreadX = bw * Math.max(0.12, (1 - centerClearRatio) * 0.45);
            const spreadY = bh * Math.max(0.12, (1 - centerClearRatio) * 0.45);
            const cx = (cornerIdx % 2 === 0) ? (bx + uRaw * spreadX) : (bx + bw - uRaw * spreadX);
            const cy = (cornerIdx < 2) ? (by + vRaw * spreadY) : (by + bh - vRaw * spreadY);
            return [cx, cy];
        }
        if (layout === 'top_bottom') {
            const bandH = bh * Math.max(0.08, (1 - centerClearRatio) * 0.42);
            const px = bx + uRaw * bw;
            const py = (idx % 2 === 0) ? (by + vRaw * bandH) : (by + bh - vRaw * bandH);
            return [px, py];
        }
        // 'edges_only' 或 'edges_and_float'
        const isFloatInCenter = (layout === 'edges_and_float') && (idx % 5 === 0);
        if (isFloatInCenter) {
            return [bx + uRaw * bw, by + vRaw * bh];
        }
        const side = idx % 4;
        const bandW = bw * Math.max(0.06, (1 - centerClearRatio) * 0.35);
        const bandH = bh * Math.max(0.06, (1 - centerClearRatio) * 0.35);
        if (side === 0) return [bx + uRaw * bw, by + vRaw * bandH]; // top
        if (side === 1) return [bx + uRaw * bw, by + bh - vRaw * bandH]; // bottom
        if (side === 2) return [bx + uRaw * bandW, by + vRaw * bh]; // left
        return [bx + bw - uRaw * bandW, by + vRaw * bh]; // right
    };

    // ══════════════════════════════════════════════════
    // 2.5 飘浮微尘 / 升腾火星余烬 / 森林萤火虫 / 灰烬 / 霓虹微粒层 (Floating Particles Layer)
    // ══════════════════════════════════════════════════
    if (showFloatingParticles) {
        const pCount = Math.max(10, Math.round(density * 0.95));
        for (let i = 0; i < pCount; i++) {
            const h1 = _decorHash(i * 5.17 + 17.3);
            const h2 = _decorHash(i * 9.43 + 53.1);
            const h3 = _decorHash(i * 15.89 + 91.7);
            const h4 = _decorHash(i * 27.61 + 143.9);

            const [baseX, baseY] = mapParticlePos(h1, h2, i);
            let px = baseX;
            let py = baseY;
            const pulse = 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(t * (1.4 + h3 * 2.1) + h4 * Math.PI * 2));

            ctx.save();
            if (particleMode === 'embers') {
                // 🔥 升腾火星余烬：从下往上热流飘升 + 橘金火核与尾晕
                const riseDist = t * (48 + h3 * 65);
                const swayX = Math.sin(t * (1.5 + h2 * 1.3) + i * 1.9) * (18 + h4 * 24) * sizeMul;
                px = baseX + swayX;
                py = y + ((baseY - y - riseDist) % h + h) % h;
                const emberR = (2.2 + h3 * 5.8) * sizeMul;
                ctx.globalAlpha *= (0.45 + 0.55 * pulse);
                if (typeof ctx.createRadialGradient === 'function' && glowMul > 0.05) {
                    const hr = emberR * (2.6 + glowMul * 1.4);
                    const eg = ctx.createRadialGradient(px, py, 0, px, py, hr);
                    eg.addColorStop(0, color2 || '#FDE047');
                    eg.addColorStop(0.35, color1 || '#F97316');
                    eg.addColorStop(1, 'rgba(239, 68, 68, 0)');
                    ctx.fillStyle = eg;
                    ctx.beginPath();
                    ctx.arc(px, py, hr, 0, Math.PI * 2);
                    ctx.fill();
                }
                ctx.fillStyle = '#FFFBEB';
                ctx.beginPath();
                ctx.arc(px, py, emberR * 0.55, 0, Math.PI * 2);
                ctx.fill();
            } else if (particleMode === 'fireflies') {
                // ✨ 森林萤火虫：有机曲线游走 + 暖黄绿生物荧光呼吸
                const wanderX = Math.sin(t * (0.8 + h3 * 0.9) + i * 2.3) * 32 * sizeMul;
                const wanderY = Math.cos(t * (0.65 + h4 * 0.85) + i * 1.7) * 28 * sizeMul;
                px = ((baseX + wanderX - x) % w + w) % w + x;
                py = ((baseY + wanderY - y) % h + h) % h + y;
                const flyR = (3.5 + h3 * 6.5) * sizeMul * (0.6 + 0.4 * pulse);
                ctx.globalAlpha *= (0.2 + 0.8 * pulse);
                _drawGlowingStar(ctx, px, py, flyR * 1.3, color2 || '#FEF08A', color1 || '#A3E635', glowMul * 1.35 * pulse, 4, 0);
            } else if (particleMode === 'ash') {
                // 🌨️ 银白灰烬：斜向缓慢飘落与翻转微粒
                const driftX = t * (16 + h2 * 22) + Math.sin(t * 1.2 + i) * 14 * sizeMul;
                const fallY = t * (32 + h3 * 44);
                px = x + ((baseX - x + driftX) % w + w) % w;
                py = y + ((baseY - y + fallY) % h + h) % h;
                const ashR = (1.8 + h3 * 4.5) * sizeMul;
                ctx.globalAlpha *= (0.35 + 0.55 * h4);
                ctx.fillStyle = (i % 2 === 0) ? (color2 || '#F8FAFC') : (color1 || '#CBD5E1');
                ctx.beginPath();
                ctx.ellipse(px, py, ashR, ashR * (0.45 + 0.45 * Math.abs(Math.sin(t * 2 + i))), t + i, 0, Math.PI * 2);
                ctx.fill();
            } else if (particleMode === 'neon') {
                // ⚡ 赛博霓虹微光：青蓝/洋红/鎏金悬浮闪烁微粒
                const driftX = Math.sin(t * (0.9 + h3) + i) * 18 * sizeMul;
                const driftY = -((t * (22 + h4 * 30)) % h);
                px = baseX + driftX;
                py = y + ((baseY - y + driftY) % h + h) % h;
                const neonCol = (i % 3 === 0) ? (color1 || '#22D3EE') : ((i % 3 === 1) ? (color2 || '#F472B6') : '#A855F7');
                const nr = (3 + h3 * 8) * sizeMul;
                ctx.globalAlpha *= (0.35 + 0.65 * pulse);
                _drawGlowingStar(ctx, px, py, nr, '#FFFFFF', neonCol, glowMul * pulse, 4, Math.PI * 0.25);
            } else if (particleMode === 'sunset_bokeh') {
                // 🌇 落日暖阳大光斑：柔焦大圆景深光斑缓缓漂浮
                const driftX = Math.sin(t * 0.45 + i * 1.3) * 24 * sizeMul;
                const driftY = Math.cos(t * 0.38 + i * 1.7) * 24 * sizeMul;
                px = baseX + driftX;
                py = baseY + driftY;
                const bokehR = (16 + h3 * 36) * sizeMul;
                ctx.globalAlpha *= (0.18 + 0.34 * pulse);
                if (typeof ctx.createRadialGradient === 'function') {
                    const bg = ctx.createRadialGradient(px, py, 0, px, py, bokehR);
                    bg.addColorStop(0, _withAlpha(color2 || '#FEF08A', 0.65));
                    bg.addColorStop(0.65, _withAlpha(color1 || '#FB923C', 0.35));
                    bg.addColorStop(1, 'rgba(255,255,255,0)');
                    ctx.fillStyle = bg;
                } else {
                    ctx.fillStyle = _withAlpha(color1 || '#FB923C', 0.25);
                }
                ctx.beginPath();
                ctx.arc(px, py, bokehR, 0, Math.PI * 2);
                ctx.fill();
            } else if (particleMode === 'prism') {
                // 💎 钻石棱镜十字星芒
                const driftX = Math.sin(t * 0.55 + i) * 10 * sizeMul;
                const driftY = Math.cos(t * 0.5 + i * 1.4) * 10 * sizeMul;
                px = baseX + driftX;
                py = baseY + driftY;
                const pr = (7 + h3 * 15) * sizeMul * (0.5 + 0.5 * pulse);
                ctx.globalAlpha *= (0.3 + 0.7 * pulse);
                _drawGlowingStar(ctx, px, py, pr, '#FFFFFF', (i % 2 === 0) ? color1 : '#F0ABFC', glowMul * 1.25 * pulse, 8, t * 0.4);
            } else {
                // 🖤 默认 'dust' 悬浮微尘：远近景深双层微粒缓慢漂移
                const driftX = Math.sin(t * (0.5 + h3 * 0.7) + i * 1.7) * 20 * sizeMul;
                const driftY = -((t * (14 + h4 * 22)) % h);
                px = ((baseX + driftX - x) % w + w) % w + x;
                py = y + ((baseY - y + driftY) % h + h) % h;
                const isBokehMote = (i % 5 === 0);
                const moteR = (isBokehMote ? (6 + h3 * 12) : (1.5 + h3 * 3.4)) * sizeMul;
                ctx.globalAlpha *= (isBokehMote ? (0.14 + 0.22 * pulse) : (0.32 + 0.58 * pulse));
                if (isBokehMote && typeof ctx.createRadialGradient === 'function') {
                    const mg = ctx.createRadialGradient(px, py, 0, px, py, moteR);
                    mg.addColorStop(0, _withAlpha(color2 || '#FFFDF5', 0.75));
                    mg.addColorStop(0.6, _withAlpha(color1 || '#E2E8F0', 0.35));
                    mg.addColorStop(1, 'rgba(255,255,255,0)');
                    ctx.fillStyle = mg;
                } else {
                    ctx.fillStyle = (i % 2 === 0) ? (color2 || '#FFFDF5') : (color1 || '#E2E8F0');
                }
                ctx.beginPath();
                ctx.arc(px, py, moteR, 0, Math.PI * 2);
                ctx.fill();
            }
            ctx.restore();
        }
    }

    // ══════════════════════════════════════════════════
    // 3. 发光闪烁星星与梦幻光斑层 (Glowing Twinkling Stars & Bokeh Layer)
    // ══════════════════════════════════════════════════
    if (showStars) {
        const starCount = Math.round(density);
        for (let i = 0; i < starCount; i++) {
            const h1 = _decorHash(i * 3.17 + 1.1);
            const h2 = _decorHash(i * 7.31 + 2.3);
            const h3 = _decorHash(i * 13.7 + 5.9);
            const h4 = _decorHash(i * 19.3 + 8.7);

            const driftX = Math.sin(t * (0.6 + h3 * 0.8) + i) * 14 * sizeMul;
            const driftY = styleId === 'golden_meteor_dust'
                ? -((t * (28 + h4 * 35)) % Math.max(120, bh * 0.35))
                : Math.cos(t * (0.5 + h4 * 0.7) + i * 1.3) * 14 * sizeMul;

            const [baseX, baseY] = mapParticlePos(h1, h2, i);
            const px = baseX + driftX;
            const py = ((baseY + driftY - y) % h + h) % h + y;

            const twinkle = 0.25 + 0.75 * (0.5 + 0.5 * Math.sin(t * (1.8 + h3 * 2.6) + h4 * Math.PI * 2));
            const rBase = (6 + h3 * 16) * sizeMul * (0.65 + 0.35 * twinkle);

            ctx.save();
            ctx.globalAlpha *= (0.35 + 0.65 * twinkle);
            if ((styleId === 'fairy_bokeh_lights' || styleId === 'warm_sunset_bokeh') && i % 2 === 1) {
                const bokehR = rBase * 1.45;
                if (typeof ctx.createRadialGradient === 'function') {
                    const g = ctx.createRadialGradient(px, py, 0, px, py, bokehR);
                    g.addColorStop(0, _withAlpha(color2, 0.55));
                    g.addColorStop(0.65, _withAlpha(color1, 0.28));
                    g.addColorStop(1, 'rgba(255,255,255,0)');
                    ctx.fillStyle = g;
                } else {
                    ctx.fillStyle = _withAlpha(color1, 0.3);
                }
                ctx.beginPath();
                ctx.arc(px, py, bokehR, 0, Math.PI * 2);
                ctx.fill();
            } else {
                const pts = (i % 4 === 0) ? 8 : 4;
                const rot = (i % 5 === 0) ? (t * 0.35 * (i % 2 === 0 ? 1 : -1)) : 0;
                _drawGlowingStar(ctx, px, py, rBase, color2, color1, glowMul * twinkle, pts, rot);
            }
            ctx.restore();
        }
    }

    // ══════════════════════════════════════════════════
    // 4. 圣诞飘雪与冰晶层 (Falling Snowflakes Layer)
    // ══════════════════════════════════════════════════
    if (showSnow) {
        const snowCount = Math.max(8, Math.round(density * 0.65));
        for (let i = 0; i < snowCount; i++) {
            const h1 = _decorHash(i * 11.3 + 101.5);
            const h2 = _decorHash(i * 23.7 + 203.1);
            const h3 = _decorHash(i * 37.9 + 307.7);

            const fallDist = t * (42 + h3 * 55);
            const swayX = Math.sin(t * (1.1 + h2) + i * 2.1) * 22 * sizeMul;
            const [baseX, baseY] = mapParticlePos(h1, h2, i + 1);
            const sx = baseX + swayX;
            const sy = y + ((baseY - y + fallDist) % h + h) % h;
            const flakeR = (5 + h3 * 11) * sizeMul;

            ctx.save();
            ctx.globalAlpha *= (0.45 + 0.5 * h2);
            if (i % 3 === 0) {
                DecorOrnaments._drawSnowflakeOrnament(ctx, sx, sy, flakeR, '#FFFFFF');
            } else {
                ctx.fillStyle = '#FFFFFF';
                ctx.beginPath();
                ctx.arc(sx, sy, flakeR * 0.45, 0, Math.PI * 2);
                ctx.fill();
            }
            ctx.restore();
        }
    }

    ctx.restore();
}


function _applyPhoneCtaAnimation(ctx, ov, currentTime, start, end, centerX, centerY, slideDist = 140) {
    const ReelsAnimEngine = window.ReelsAnimEngine;
    let animOpFactor = 1;
    const inType = ov.anim_in_type || 'none';
    const outType = ov.anim_out_type || 'none';
    const loopType = ov.cta_loop_anim || 'none';
    const inDur = inType !== 'none' ? Math.max(0.05, parseFloat(ov.anim_in_duration || 0.3)) : 0;
    const outDur = outType !== 'none' ? Math.max(0.05, parseFloat(ov.anim_out_duration || 0.3)) : 0;

    if (window.ReelsAnimEngine && (inType !== 'none' || outType !== 'none')) {
        const [inProgress, outProgress] = ReelsAnimEngine.computeAnimProgress(
            currentTime, start, end, inDur, outDur
        );

        if (inType === 'fade') animOpFactor *= inProgress;
        else if (inType !== 'none' && inProgress < 1) animOpFactor *= Math.min(1, inProgress * 2.2);

        if (outType === 'fade') animOpFactor *= outProgress;
        else if (outType !== 'none' && outProgress < 1) animOpFactor *= Math.min(1, outProgress * 2.2);

        let scaleX = 1, scaleY = 1, rotRad = 0, extraDx = 0, extraDy = 0;

        if (inProgress < 1) {
            if (inType === 'pop') {
                const sc = ReelsAnimEngine.computePopScale(inProgress);
                scaleX *= sc; scaleY *= sc;
            } else if (inType === 'elastic_pop') {
                const sc = ReelsAnimEngine.EASING_MAP?.elastic
                    ? Math.max(0.05, ReelsAnimEngine.EASING_MAP.elastic(inProgress))
                    : ReelsAnimEngine.computePopScale(inProgress);
                scaleX *= sc; scaleY *= sc;
            } else if (inType === 'ring_shake') {
                const sc = ReelsAnimEngine.computePopScale(Math.min(1, inProgress * 1.45));
                scaleX *= sc; scaleY *= sc;
                const env = Math.pow(1 - inProgress, 1.15);
                rotRad += Math.sin(inProgress * Math.PI * 9) * env * (7.5 * Math.PI / 180);
                extraDx += Math.sin(inProgress * Math.PI * 11) * env * 14;
            } else if (inType === 'zoom_bounce') {
                const b = ReelsAnimEngine.EASING_MAP?.bounce
                    ? ReelsAnimEngine.EASING_MAP.bounce(inProgress)
                    : inProgress;
                const sc = 1 + 0.65 * (1 - b);
                scaleX *= sc; scaleY *= sc;
            }
        }

        if (outProgress < 1) {
            if (outType === 'pop' || outType === 'elastic_pop' || outType === 'ring_shake' || outType === 'zoom_bounce') {
                const sc = ReelsAnimEngine.computePopScale(outProgress);
                scaleX *= sc; scaleY *= sc;
            }
        }

        const slideTypes = ['slide_up', 'slide_down', 'slide_left', 'slide_right'];
        if (slideTypes.includes(inType) && inProgress < 1) {
            const [dx, dy] = ReelsAnimEngine.computeSlideOffset(inProgress, inType, slideDist, false);
            extraDx += dx; extraDy += dy;
        }
        if (slideTypes.includes(outType) && outProgress < 1) {
            const [dx, dy] = ReelsAnimEngine.computeSlideOffset(outProgress, outType, slideDist, true);
            extraDx += dx; extraDy += dy;
        }

        if (extraDx !== 0 || extraDy !== 0) {
            ctx.translate(extraDx, extraDy);
        }
        if (Math.abs(scaleX - 1) > 0.001 || Math.abs(scaleY - 1) > 0.001 || Math.abs(rotRad) > 0.0005) {
            ctx.translate(centerX, centerY);
            if (Math.abs(rotRad) > 0.0005) ctx.rotate(rotRad);
            if (Math.abs(scaleX - 1) > 0.001 || Math.abs(scaleY - 1) > 0.001) ctx.scale(scaleX, scaleY);
            ctx.translate(-centerX, -centerY);
        }
    }

    // 出现后持续动态（仅在播放、导出或点击“预览出场动画”时生效，暂停编辑时静止以便拖拽）
    const elapsedAfterIn = currentTime - (start + inDur);
    const isPlayingOrPreview = Boolean(
        (ov._exporting && !ov._hitTesting) ||
        ov._ctaAnimPreviewStart ||
        (ov._previewPlaying !== undefined ? ov._previewPlaying :
            (typeof window !== 'undefined' && (window._reelsState?.playing || window.ReelsPreviewV2?.isPlaying?.())))
    );
    if (loopType && loopType !== 'none' && elapsedAfterIn > 0 && isPlayingOrPreview) {
        if (loopType === 'pulse') {
            const pulse = 1 + 0.042 * Math.sin(elapsedAfterIn * Math.PI * 2.2);
            ctx.translate(centerX, centerY);
            ctx.scale(pulse, pulse);
            ctx.translate(-centerX, -centerY);
        } else if (loopType === 'ring') {
            const cycle = elapsedAfterIn % 2.2;
            if (cycle < 0.55) {
                const p = cycle / 0.55;
                const env = Math.sin(p * Math.PI);
                const angle = Math.sin(p * Math.PI * 8) * env * (4.5 * Math.PI / 180);
                const sc = 1 + 0.035 * env;
                ctx.translate(centerX, centerY);
                ctx.rotate(angle);
                ctx.scale(sc, sc);
                ctx.translate(-centerX, -centerY);
            }
        } else if (loopType === 'float') {
            const dy = Math.sin(elapsedAfterIn * Math.PI * 1.6) * 8;
            ctx.translate(0, dy);
        }
    }

    ctx.globalAlpha *= animOpFactor;
    return animOpFactor;
}

const _scrollTwTokenCache = new Map();

function _buildScrollTypewriterLines(ov, lines, textDirection, twContext) {
    const start = Number(twContext?.start) || 0;
    const effectiveDur = Math.max(0.1, Number(twContext?.effectiveDuration) || 10);
    const speechSync = ov.scroll_tw_speech_sync !== false;
    const rawRevealType = ov.scroll_tw_reveal_type || 'char';
    const revealType = (textDirection === 'rtl' && rawRevealType === 'char') ? 'word' : rawRevealType;
    const rawSegments = speechSync && Array.isArray(twContext?.segments) ? twContext.segments : null;
    const segSig = JSON.stringify((rawSegments || []).map(seg=>[seg.start,seg.end,seg.edited_text??seg.text,(seg.words||[]).map(w=>[w.word??w.text,w.start,w.end])]));
    const cacheId = ov.id || '_default';
    const cacheKey = `${lines.join('\n')}|${revealType}|${speechSync ? 1 : 0}|${start.toFixed(3)}|${effectiveDur.toFixed(3)}|${segSig}|${ov.scroll_title || ''}|${ov.scroll_tw_start ?? ''}|${ov.scroll_tw_end ?? ''}`;
    const existing = _scrollTwTokenCache.get(cacheId);
    if (existing && existing.key === cacheKey) {
        return existing.lineTokensList;
    }

    const splitGraphemes = (str) => (typeof getWritingGraphemes === 'function')
        ? getWritingGraphemes(str)
        : Array.from(str || '');
    const norm = (str) => String(str || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\p{M}]/gu, '');

    // 1. Build per-line tokens with charOffset within each line + word groups for active-word highlight/scale
    const lineTokensList = [];
    const allTokens = [];
    const bodySlots = [];
    const wordGroups = [];
    const wordSpanRegex = /[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]|[^\s\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]+/g;

    for (let li = 0; li < lines.length; li++) {
        const line = lines[li] || '';
        const lineWordGroups = [];
        wordSpanRegex.lastIndex = 0;
        let wm;
        while ((wm = wordSpanRegex.exec(line)) !== null) {
            const wg = {
                id: wordGroups.length,
                lineIdx: li,
                charStart: wm.index,
                charEnd: wm.index + wm[0].length,
                text: wm[0],
                tokens: [],
                start: start,
                end: start,
                activeEnd: start,
            };
            wordGroups.push(wg);
            lineWordGroups.push(wg);
        }

        let rawChunks;
        if (revealType === 'char') {
            rawChunks = splitGraphemes(line);
        } else {
            rawChunks = line.match(/[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]|\s+|[^\s\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]+/g) || (line ? [line] : []);
        }
        const lineTokens = [];
        let charOffset = 0;
        let wgCursor = 0;
        for (const chunk of rawChunks) {
            const cStart = charOffset;
            const cEnd = charOffset + chunk.length;
            charOffset = cEnd;
            let wordId = null;
            if (!/^\s+$/.test(chunk)) {
                while (wgCursor < lineWordGroups.length && lineWordGroups[wgCursor].charEnd <= cStart) {
                    wgCursor++;
                }
                const wg = lineWordGroups[wgCursor];
                if (wg && cStart < wg.charEnd && cEnd > wg.charStart) {
                    wordId = wg.id;
                }
            }
            const tok = {
                text: chunk,
                lineIdx: li,
                charStart: cStart,
                charEnd: cEnd,
                wordId,
                start: start,
                end: start,
                slots: [],
            };
            if (wordId !== null && wordGroups[wordId]) {
                wordGroups[wordId].tokens.push(tok);
            }
            const graphemes = splitGraphemes(chunk);
            for (const g of graphemes) {
                const n = norm(g);
                if (n) {
                    for (const ch of n) {
                        const slot = { tok, ch, start: start, end: start };
                        tok.slots.push(slot);
                        bodySlots.push(slot);
                    }
                }
            }
            lineTokens.push(tok);
            allTokens.push(tok);
        }
        lineTokensList.push(lineTokens);
    }

    // 2. Build speech character timings from aligned segments (if available)
    const speechChars = [];
    if (rawSegments && rawSegments.length > 0) {
        const repairedSegs = (typeof repairCollapsedWritingSegments === 'function')
            ? repairCollapsedWritingSegments(rawSegments, start + effectiveDur)
            : rawSegments;
        for (const seg of repairedSegs) {
            const segText = String(seg.edited_text ?? seg.text ?? '');
            if (!segText.trim()) continue;
            const segStart = Number(seg.start) || 0;
            const segEnd = Math.max(segStart + 0.001, Number(seg.end) || (segStart + 0.1));
            if (Array.isArray(seg.words) && seg.words.length > 0) {
                for (const w of seg.words) {
                    const wText = norm(w.word ?? w.text ?? '');
                    if (!wText) continue;
                    const wStart = Number.isFinite(Number(w.start)) ? Number(w.start) : segStart;
                    const wEnd = Number.isFinite(Number(w.end)) && Number(w.end) >= wStart ? Number(w.end) : segEnd;
                    const wDur = Math.max(0.001, wEnd - wStart);
                    for (let ci = 0; ci < wText.length; ci++) {
                        speechChars.push({
                            ch: wText[ci],
                            start: wStart + wDur * (ci / wText.length),
                            end: wStart + wDur * ((ci + 1) / wText.length),
                        });
                    }
                }
            } else {
                const sNorm = norm(segText);
                if (!sNorm) continue;
                const sDur = Math.max(0.001, segEnd - segStart);
                for (let ci = 0; ci < sNorm.length; ci++) {
                    speechChars.push({
                        ch: sNorm[ci],
                        start: segStart + sDur * (ci / sNorm.length),
                        end: segStart + sDur * ((ci + 1) / sNorm.length),
                    });
                }
            }
        }
    }

    // 3. Map bodySlots to speechChars or fallback to uniform timing
    const M = bodySlots.length;
    if (M > 0) {
        if (speechChars.length > 0) {
            // If speech starts with scroll_title (or hook) and body doesn't, skip title prefix in speechChars.
            // Supports both exact match and anchor substring search when title has digits ("4") vs ASR words ("four").
            let sOffset = 0;
            const titleNorm = norm(ov.scroll_title || '');
            const speechStr = speechChars.map(c => c.ch).join('');
            const bodyStr = bodySlots.map(c => c.ch).join('');
            if (titleNorm.length > 0 && speechChars.length > titleNorm.length) {
                const speechPrefix = speechStr.slice(0, titleNorm.length);
                const bodyPrefix = bodyStr.slice(0, titleNorm.length);
                if (speechPrefix === titleNorm && bodyPrefix !== titleNorm) {
                    sOffset = titleNorm.length;
                } else if (bodyPrefix !== titleNorm && bodyStr.length >= 6) {
                    const maxSearchEnd = Math.min(speechStr.length, Math.max(titleNorm.length * 2 + 60, 140));
                    const minSearchStart = Math.max(0, Math.floor(titleNorm.length * 0.4));
                    const searchRegion = speechStr.slice(0, maxSearchEnd);
                    for (const anchorOff of [0, 3, 6, 10]) {
                        if (anchorOff + 6 > bodyStr.length) break;
                        const anchor = bodyStr.slice(anchorOff, Math.min(bodyStr.length, anchorOff + 12));
                        if (anchor.length < 6) continue;
                        const idx = searchRegion.indexOf(anchor, Math.max(0, minSearchStart - anchorOff));
                        if (idx >= 0) {
                            sOffset = Math.max(0, idx - anchorOff);
                            break;
                        }
                    }
                }
            } else if (bodyStr.length >= 10 && speechStr.length > bodyStr.length + 8 && speechStr.slice(0, 8) !== bodyStr.slice(0, 8)) {
                const searchRegion = speechStr.slice(0, Math.min(speechStr.length, 160));
                const anchor = bodyStr.slice(0, Math.min(12, bodyStr.length));
                const idx = searchRegion.indexOf(anchor);
                if (idx > 4) {
                    sOffset = idx;
                }
            }
            const activeSpeech = speechChars.slice(sOffset);
            const K = activeSpeech.length;
            if (K > 0) {
                // Two-pointer alignment with lookahead resync
                const matched = new Array(M).fill(null);
                let bi = 0, si = 0;
                const lookahead = 40;
                while (bi < M && si < K) {
                    if (bodySlots[bi].ch === activeSpeech[si].ch) {
                        matched[bi] = activeSpeech[si];
                        bi++;
                        si++;
                        continue;
                    }
                    let foundB = -1, foundS = -1, bestDist = 999;
                    for (let db = 0; db <= lookahead && bi + db < M; db++) {
                        for (let ds = 0; ds <= lookahead && si + ds < K; ds++) {
                            if (db === 0 && ds === 0) continue;
                            if (db + ds >= bestDist) break;
                            if (bodySlots[bi + db].ch === activeSpeech[si + ds].ch) {
                                // Require consecutive matching chars when jumping across mismatches
                                if (db + ds > 2 && bi + db + 1 < M && si + ds + 1 < K) {
                                    if (bodySlots[bi + db + 1].ch !== activeSpeech[si + ds + 1].ch) continue;
                                }
                                if (db + ds > 10 && bi + db + 2 < M && si + ds + 2 < K) {
                                    if (bodySlots[bi + db + 2].ch !== activeSpeech[si + ds + 2].ch) continue;
                                }
                                bestDist = db + ds;
                                foundB = bi + db;
                                foundS = si + ds;
                                break;
                            }
                        }
                    }
                    if (foundB >= 0) {
                        bi = foundB;
                        si = foundS;
                        matched[bi] = activeSpeech[si];
                        bi++;
                        si++;
                    } else {
                        // Pair 1-to-1 proportionally when no local match
                        matched[bi] = activeSpeech[si];
                        bi++;
                        si++;
                    }
                }
                // Interpolate any unmatched slots
                let idx = 0;
                const firstSpeechStart = activeSpeech[0].start;
                const lastSpeechEnd = activeSpeech[K - 1].end;
                while (idx < M) {
                    if (matched[idx]) {
                        bodySlots[idx].start = matched[idx].start;
                        bodySlots[idx].end = matched[idx].end;
                        idx++;
                        continue;
                    }
                    const gapStartIdx = idx;
                    while (idx < M && !matched[idx]) idx++;
                    const gapCount = idx - gapStartIdx;
                    const t0 = gapStartIdx > 0 ? bodySlots[gapStartIdx - 1].end : firstSpeechStart;
                    const t1 = idx < M && matched[idx] ? matched[idx].start : Math.max(t0 + 0.02 * gapCount, lastSpeechEnd);
                    const span = Math.max(0.001, t1 - t0);
                    for (let g = 0; g < gapCount; g++) {
                        bodySlots[gapStartIdx + g].start = t0 + span * (g / gapCount);
                        bodySlots[gapStartIdx + g].end = t0 + span * ((g + 1) / gapCount);
                    }
                }
            } else {
                for (let i = 0; i < M; i++) {
                    bodySlots[i].start = start + effectiveDur * (i / M);
                    bodySlots[i].end = start + effectiveDur * ((i + 1) / M);
                }
            }
        } else {
            for (let i = 0; i < M; i++) {
                bodySlots[i].start = start + effectiveDur * (i / M);
                bodySlots[i].end = start + effectiveDur * ((i + 1) / M);
            }
        }
    }

    // 4. Assign token start/end from their slots
    let prevEnd = bodySlots.length > 0 ? bodySlots[0].start : start;
    for (const tok of allTokens) {
        if (tok.slots.length > 0) {
            tok.start = tok.slots[0].start;
            tok.end = tok.slots[tok.slots.length - 1].end;
            prevEnd = tok.end;
        } else {
            tok.start = prevEnd;
            tok.end = prevEnd;
        }
        delete tok.slots;
    }

    // 5. If sentence mode, group tokens by sentence boundaries
    if (revealType === 'sentence' && allTokens.length > 0) {
        let group = [];
        const flushSentenceGroup = () => {
            if (!group.length) return;
            const spoken = group.filter(t => norm(t.text).length > 0);
            const first = spoken[0] || group[0];
            const last = spoken[spoken.length - 1] || group[group.length - 1];
            const sStart = first.start;
            const sEnd = last.end;
            for (const t of group) {
                t.start = sStart;
                t.end = sEnd;
                t._sentenceToken = true;
            }
            group = [];
        };
        for (let i = 0; i < allTokens.length; i++) {
            const tok = allTokens[i];
            group.push(tok);
            const nextTok = allTokens[i + 1];
            const endsPunct = /[.!?。！？；;…]+['"”’)\]]*$/.test(tok.text.trim());
            const lineBreakAfter = nextTok && nextTok.lineIdx !== tok.lineIdx && endsPunct;
            if (endsPunct || lineBreakAfter) {
                flushSentenceGroup();
            }
        }
        flushSentenceGroup();
    }

    // Blank values preserve the original speech alignment. Explicit values
    // retime the same tokens (including pauses) without moving the scroll layer.
    const writingWindow = _getScrollWritingWindow(ov, twContext);
    if (writingWindow && allTokens.length) {
        const from = Math.min(...allTokens.map(t => t.start));
        const to = Math.max(...allTokens.map(t => t.end));
        const sourceDuration = Math.max(0.001, to - from);
        const ratio = (writingWindow.end - writingWindow.start) / sourceDuration;
        for (const token of allTokens) {
            token.start = writingWindow.start + (token.start - from) * ratio;
            token.end = writingWindow.start + (token.end - from) * ratio;
        }
    }

    // 6. Finalize wordGroups timing and bridge inter-word pauses so active-word highlight/scale works in char & word modes
    for (const wg of wordGroups) {
        const spoken = wg.tokens.filter(t => norm(t.text).length > 0);
        const src = spoken.length > 0 ? spoken : wg.tokens;
        if (src.length > 0) {
            wg.start = src[0].start;
            wg.end = Math.max(wg.start + 0.04, src[src.length - 1].end);
        }
    }
    for (let wi = 0; wi < wordGroups.length; wi++) {
        const wg = wordGroups[wi];
        const nextWg = wordGroups[wi + 1];
        wg.activeEnd = (nextWg && nextWg.start > wg.end)
            ? nextWg.start
            : Math.max(wg.end, wg.start + 0.08);
        for (const t of wg.tokens) {
            t.wordStart = wg.start;
            t.wordEnd = wg.end;
            t.wordActiveEnd = wg.activeEnd;
        }
    }

    const lineTimeRanges = lines.map((_, li) => {
        const lToks = (lineTokensList[li] || []).filter(t => !/^\s+$/.test(t.text));
        if (!lToks.length) return null;
        const lStart = lToks[0].start;
        const lEnd = Math.max(lStart + 0.05, lToks[lToks.length - 1].end);
        return { start: lStart, end: lEnd };
    });
    lineTokensList._wordGroups = wordGroups;
    lineTokensList._lineTimeRanges = lineTimeRanges;

    if (_scrollTwTokenCache.size > 120) {
        const oldestKey = _scrollTwTokenCache.keys().next().value;
        _scrollTwTokenCache.delete(oldestKey);
    }
    _scrollTwTokenCache.set(cacheId, { key: cacheKey, lineTokensList });
    return lineTokensList;
}

function _getScrollWritingWindow(ov, twContext) {
    const optionalTime = value => value == null || String(value).trim() === ''
        ? null : (Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : null);
    const customStart = optionalTime(ov.scroll_tw_start);
    const customEnd = optionalTime(ov.scroll_tw_end);
    if (customStart === null && customEnd === null) return null;
    const start = customStart ?? Math.max(0, Number(twContext?.start) || 0);
    const end = customEnd ?? (Math.max(0, Number(twContext?.start) || 0) + Math.max(0.1, Number(twContext?.effectiveDuration) || 10));
    return { start, end: Math.max(start + 0.1, end) };
}

function _measureScrollSubstrWidth(ctx, line, startIdx, endIdx, letterSpacing) {
    if (endIdx <= startIdx) return 0;
    const sub = line.slice(startIdx, endIdx);
    if (!sub) return 0;
    if (letterSpacing !== 0 && typeof ctx.letterSpacing === 'undefined') {
        const chars = Array.from(sub);
        let w = 0;
        for (let i = 0; i < chars.length; i++) {
            w += ctx.measureText(chars[i]).width;
            if (i < chars.length - 1) w += letterSpacing;
        }
        return w;
    }
    return ctx.measureText(sub).width;
}

function _drawScrollTypewriterCursorImage(ctx, ov, x, y, size, angle, currentTime) {
    const imgPath = ov.scroll_tw_cursor_image || '';
    if (!imgPath) return;
    if (typeof ReelsCanvasRenderer !== 'undefined' && ReelsCanvasRenderer.prototype?._drawWritingCursorImage) {
        const styleAdapter = {
            fullpage_typewriter_cursor_image: imgPath,
            fullpage_typewriter_cursor_image_anchor_x: ov.scroll_tw_cursor_anchor_x ?? 15,
            fullpage_typewriter_cursor_image_anchor_y: ov.scroll_tw_cursor_anchor_y ?? 85,
        };
        ReelsCanvasRenderer.prototype._drawWritingCursorImage.call(
            ReelsCanvasRenderer.prototype,
            ctx, styleAdapter, x, y, size, angle, currentTime
        );
    }
}

async function prepareScrollWritingCursorImage(ov) {
    if (!ov || !ov.scroll_typewriter_enabled || ov.scroll_tw_cursor_enabled === false) return;
    if ((ov.scroll_tw_cursor_kind || 'quill') !== 'image' || !ov.scroll_tw_cursor_image) return;
    if (typeof ReelsCanvasRenderer !== 'undefined' && ReelsCanvasRenderer.prototype?._getWritingCursorImage) {
        const entry = ReelsCanvasRenderer.prototype._getWritingCursorImage.call(
            ReelsCanvasRenderer.prototype,
            ov.scroll_tw_cursor_image
        );
        if (entry?.promise) await entry.promise;
    }
}

function _renderScrollTypewriterBody(ctx, ov, lines, textX, drawY, textW, lineHeight, fontSize, align, bLetterSpacing, twContext) {
    const rawCurrentTime = Number(twContext?.currentTime) || 0;
    const textDirection = ctx.direction || 'ltr';
    const isRtl = textDirection === 'rtl';
    const rawRevealType = ov.scroll_tw_reveal_type || 'char';
    const revealType = (isRtl && rawRevealType === 'char') ? 'word' : rawRevealType;
    const lineTokensList = _buildScrollTypewriterLines(ov, lines, textDirection, twContext);
    const wordGroups = lineTokensList._wordGroups || [];

    const hideUnread = ov.scroll_tw_hide_unread !== undefined
        ? Boolean(ov.scroll_tw_hide_unread)
        : (Number(ov.scroll_tw_unrevealed_opacity ?? 0) < 100);
    const unrevealedOpacity = hideUnread
        ? Math.max(0, Math.min(1, Number(ov.scroll_tw_unrevealed_opacity ?? 0) / 100))
        : 1.0;
    let currentTime = rawCurrentTime;
    const isRealExport = Boolean(ov._exporting && !ov._staticPreview);
    const isPlayingPreview = Boolean(ov._previewPlaying);
    const firstWordStart = wordGroups.length > 0 ? wordGroups[0].start : 0;
    const activeHighlight = ov.scroll_tw_active_highlight !== false;
    const activeColor = ov.scroll_tw_active_color || '#FFD700';
    const keepReadColor = Boolean(ov.scroll_tw_keep_read_color);
    const activeScaleEnabled = ov.scroll_tw_active_scale_enabled !== undefined
        ? Boolean(ov.scroll_tw_active_scale_enabled)
        : (Number(ov.scroll_tw_active_scale || 100) !== 100);
    const activeScale = activeScaleEnabled
        ? Math.max(0.5, Math.min(2.5, (Number(ov.scroll_tw_active_scale) || 125) / 100))
        : 1.0;
    const cursorEnabled = ov.scroll_tw_cursor_enabled !== false;
    const tipKind = ov.scroll_tw_cursor_kind || 'quill';
    const isImageTip = tipKind !== 'char';

    // Resolve the currently active word across both char and word reveal modes
    let activeWord = null;
    if (revealType !== 'sentence' && wordGroups.length > 0) {
        const firstWg = wordGroups[0];
        const lastWg = wordGroups[wordGroups.length - 1];
        if (currentTime < firstWg.start) {
            // In full-text follow mode or live preview at t=0 / during fixed title narration,
            // highlight the first word so the user always sees immediate highlight feedback.
            if (!hideUnread || !ov._exporting) {
                activeWord = firstWg;
            }
        } else if (currentTime >= lastWg.activeEnd) {
            if (!ov._exporting) {
                activeWord = lastWg;
            }
        } else {
            for (let wi = 0; wi < wordGroups.length; wi++) {
                const wg = wordGroups[wi];
                if (currentTime >= wg.start && currentTime < wg.activeEnd) {
                    activeWord = wg;
                    break;
                }
            }
            if (!activeWord) {
                for (let wi = wordGroups.length - 1; wi >= 0; wi--) {
                    if (currentTime >= wordGroups[wi].start) {
                        activeWord = wordGroups[wi];
                        break;
                    }
                }
            }
        }
    }

    const baseColor = ov.color || '#FFFFFF';
    const bodyFamily = ov.font_family || 'Arial';
    const bodyFallback = _resolveOverlayFallback(bodyFamily);
    const bodyWeight = _resolveOverlayFontWeight(ov.font_weight, ov.bold ? 700 : 400, ov.bold);
    const gradDir = ov.scroll_body_gradient_direction || ov.scroll_gradient_direction || 'horizontal';

    let rawContent = ov.content || '';
    if (ov.scroll_uppercase !== false) rawContent = rawContent.toUpperCase();
    const _scrollBodyMerged = _getAutoColorMergedRanges(ov, 'scroll_body', rawContent);
    const _scrollBodyRanges = _scrollBodyMerged || ov.scroll_styled_ranges;
    if (typeof _drawRichLine !== 'undefined') _drawRichLine._searchFrom = 0;

    let cursorX = null;
    let cursorBaselineY = null;
    let hasWritingStarted = false;

    const preparedLines = [];
    for (let li = 0; li < lines.length; li++) {
        const line = lines[li] || '';
        const lineTokens = lineTokensList[li] || [];
        const yc = drawY + fontSize + li * lineHeight;
        const lx = _alignX(ctx, line, textX, textW, align, bLetterSpacing);
        const lineW = ctx.measureText(line).width;

        if (li === 0 && lineTokens.length > 0 && cursorX === null) {
            cursorX = isRtl ? (lx + lineW) : lx;
            cursorBaselineY = yc;
        }

        // Build contiguous runs on this line with identical (state, opacity, color, scale)
        const runs = [];
        for (const tok of lineTokens) {
            let state = 'unread';
            let opacity = unrevealedOpacity;
            let color = baseColor;
            let scale = 1.0;

            if (revealType === 'sentence') {
                if (currentTime >= tok.end) {
                    state = 'read';
                    opacity = 1.0;
                    if (keepReadColor && activeHighlight) color = activeColor;
                } else if (currentTime >= tok.start && currentTime < tok.end) {
                    state = 'active';
                    opacity = 1.0;
                    if (activeHighlight) color = activeColor;
                    scale = activeScale;
                }
            } else {
                const isInActiveWord = Boolean(activeWord && tok.wordId === activeWord.id);
                const isBeforeActiveWord = Boolean(activeWord && tok.wordId != null && tok.wordId < activeWord.id);
                if (isInActiveWord) {
                    const charRevealed = !hideUnread
                        || revealType === 'word'
                        || currentTime >= tok.start
                        || tok === activeWord.tokens[0];
                    if (charRevealed) {
                        state = 'active';
                        opacity = 1.0;
                        if (activeHighlight) color = activeColor;
                        scale = activeScale;
                    } else {
                        state = 'unread';
                        opacity = unrevealedOpacity;
                    }
                } else if (isBeforeActiveWord || currentTime >= tok.end) {
                    state = 'read';
                    opacity = 1.0;
                    if (keepReadColor && activeHighlight && !/^\s+$/.test(tok.text)) color = activeColor;
                } else if (currentTime >= tok.start && currentTime < tok.end) {
                    state = 'active';
                    opacity = 1.0;
                    if (activeHighlight && !/^\s+$/.test(tok.text)) color = activeColor;
                    if (!/^\s+$/.test(tok.text)) scale = activeScale;
                }
            }

            const shouldAdvanceCursor = (currentTime >= tok.start && !/^\s+$/.test(tok.text))
                || (!hasWritingStarted && activeWord && tok === activeWord.tokens[0] && (!hideUnread || !ov._exporting));
            if (shouldAdvanceCursor) {
                const prefixW = _measureScrollSubstrWidth(ctx, line, 0, tok.charStart, bLetterSpacing);
                const nextPrefixW = _measureScrollSubstrWidth(ctx, line, 0, tok.charEnd, bLetterSpacing);
                const tokW = nextPrefixW - prefixW;
                const tokenX = isRtl ? (lx + lineW - nextPrefixW) : (lx + prefixW);
                const p = (isImageTip && !tok._sentenceToken && tok.end > tok.start && currentTime >= tok.start)
                    ? Math.max(0, Math.min(1, (currentTime - tok.start) / (tok.end - tok.start)))
                    : (currentTime < tok.start ? 0.25 : 1);
                cursorX = isRtl ? (tokenX + tokW * (1 - p)) : (tokenX + tokW * p);
                cursorBaselineY = yc;
                hasWritingStarted = true;
            }

            const prevRun = runs[runs.length - 1];
            const sameScaleGroup = scale === 1.0 || (tok.wordId != null && prevRun && prevRun.wordId === tok.wordId);
            if (prevRun && prevRun.state === state && prevRun.opacity === opacity && prevRun.color === color && prevRun.scale === scale && sameScaleGroup) {
                prevRun.charEnd = tok.charEnd;
                prevRun.text = line.slice(prevRun.charStart, prevRun.charEnd);
            } else {
                runs.push({
                    state,
                    opacity,
                    color,
                    scale,
                    wordId: tok.wordId ?? null,
                    charStart: tok.charStart,
                    charEnd: tok.charEnd,
                    text: line.slice(tok.charStart, tok.charEnd),
                });
            }
        }
        preparedLines.push({ li, line, yc, lx, lineW, runs });
    }

    // Dynamic progressive background / newspaper cutout pre-pass when unread text is hidden
    const bbgStyle = ov.scroll_body_bg_style || 'solid';
    const isBackingStyle = typeof ReelsBrushEngine !== 'undefined' && ReelsBrushEngine.isTextBackingStyle && ReelsBrushEngine.isTextBackingStyle(bbgStyle);
    if (ov.scroll_body_bg_enabled && !isBackingStyle && !(unrevealedOpacity <= 0.05 && ['inline','inline-joined','inline-connected'].includes(ov.scroll_body_bg_mode))) {
        ctx.save();ctx.globalAlpha *= (ov.scroll_body_bg_opacity ?? 60)/100;ctx.fillStyle=ov.scroll_body_bg_color || '#000000';
        const px=Number(ov.scroll_body_bg_pad_h)||0,pt=Number(ov.scroll_body_bg_pad_top)||0,pb=Number(ov.scroll_body_bg_pad_bottom)||0,rad=Number(ov.scroll_body_bg_radius)||0;
        if (ov.scroll_body_bg_mode==='inline-connected') {
            const slabs=preparedLines.filter(line=>line.lineW>0).map(line=>({left:line.lx-px,right:line.lx+line.lineW+px,top:drawY+line.li*lineHeight-pt,bottom:drawY+(line.li+1)*lineHeight+pb}));
            _traceConnectedOverlayBackground(ctx,slabs,ov,'scroll_body',rad);ctx.fill();
        } else if (['inline','inline-joined','inline-connected'].includes(ov.scroll_body_bg_mode)) { for(const line of preparedLines){_roundRect(ctx,line.lx-px,drawY+line.li*lineHeight-pt,line.lineW+px*2,lineHeight+pt+pb,rad);ctx.fill();} }
        else {_roundRect(ctx,textX-px,drawY-pt,textW+px*2,lines.length*lineHeight+pt+pb,rad);ctx.fill();}
        ctx.restore();
    }

    if (ov.scroll_body_bg_enabled && unrevealedOpacity <= 0.05 && (isBackingStyle || ov.scroll_body_bg_mode === 'inline' || ov.scroll_body_bg_mode === 'inline-joined' || ov.scroll_body_bg_mode === 'inline-connected')) {
        const bbgAlpha = (ov.scroll_body_bg_opacity ?? (isBackingStyle ? 98 : 60)) / 100;
        const bbgPadH = parseFloat(ov.scroll_body_bg_pad_h ?? (isBackingStyle ? 16 : 0));
        const bbgPadTop = parseFloat(ov.scroll_body_bg_pad_top ?? (isBackingStyle ? 10 : 0));
        const bbgPadBot = parseFloat(ov.scroll_body_bg_pad_bottom ?? (isBackingStyle ? 10 : 0));
        const bbgRad = parseFloat(ov.scroll_body_bg_radius ?? 12);
        if (isBackingStyle) {
            const backingLines = [];
            for (const pl of preparedLines) {
                const visRuns = pl.runs.filter(r => r.opacity > 0.05 && r.text && r.text.trim().length > 0);
                if (!visRuns.length) continue;
                const firstChar = Math.min(...visRuns.map(r => r.charStart));
                const lastChar = Math.max(...visRuns.map(r => r.charEnd));
                const subText = pl.line.slice(firstChar, lastChar);
                if (!subText.trim()) continue;
                const prefixW = _measureScrollSubstrWidth(ctx, pl.line, 0, firstChar, bLetterSpacing);
                const nextPrefixW = _measureScrollSubstrWidth(ctx, pl.line, 0, lastChar, bLetterSpacing);
                const subW = Math.max(1, nextPrefixW - prefixW);
                const subX = isRtl ? (pl.lx + pl.lineW - nextPrefixW) : (pl.lx + prefixW);
                backingLines.push({
                    text: subText,
                    x: subX,
                    y: drawY + pl.li * lineHeight,
                    textY: pl.yc,
                    textBaseline: 'alphabetic',
                    w: subW,
                    h: lineHeight,
                    fontSize,
                    fontStr: ctx.font,
                    letterSpacing: bLetterSpacing,
                    lineIndex: pl.li,
                });
            }
            if (backingLines.length > 0) {
                ReelsBrushEngine.drawTextCutoutBacking(ctx, backingLines, {
                    style: bbgStyle,
                    color: ov.scroll_body_bg_color || '#F3EFE6',
                    opacity: bbgAlpha,
                    padX: bbgPadH,
                    padY: (bbgPadTop + bbgPadBot) * 0.5,
                    padTop: bbgPadTop,
                    padBottom: bbgPadBot,
                });
            }
        } else {
            ctx.save();
            ctx.globalAlpha = bbgAlpha * ctx.globalAlpha;
            ctx.fillStyle = ov.scroll_body_bg_color || '#000000';
            const connectedSlabs=[];
            for (const pl of preparedLines) {
                const visRuns = pl.runs.filter(r => r.opacity > 0.05 && r.text && r.text.trim().length > 0);
                if (!visRuns.length) continue;
                const firstChar = Math.min(...visRuns.map(r => r.charStart));
                const lastChar = Math.max(...visRuns.map(r => r.charEnd));
                const prefixW = _measureScrollSubstrWidth(ctx, pl.line, 0, firstChar, bLetterSpacing);
                const nextPrefixW = _measureScrollSubstrWidth(ctx, pl.line, 0, lastChar, bLetterSpacing);
                const subW = Math.max(1, nextPrefixW - prefixW);
                const subX = isRtl ? (pl.lx + pl.lineW - nextPrefixW) : (pl.lx + prefixW);
                const by = drawY + pl.li * lineHeight;
                if(ov.scroll_body_bg_mode==='inline-connected')connectedSlabs.push({left:subX-bbgPadH,right:subX+subW+bbgPadH,top:by-bbgPadTop,bottom:by+lineHeight+bbgPadBot});
                else {
                _roundRect(ctx, subX - bbgPadH, by - bbgPadTop, subW + bbgPadH * 2, lineHeight + bbgPadTop + bbgPadBot, bbgRad);
                ctx.fill();
                }
            }
            if(ov.scroll_body_bg_mode==='inline-connected'){_traceConnectedOverlayBackground(ctx,connectedSlabs,ov,'scroll_body',bbgRad);ctx.fill();}
            ctx.restore();
        }
    }

    for (const pl of preparedLines) {
        const { line, yc, lx, lineW, runs } = pl;
        // Draw non-active runs first, then active runs on top so active word stroke/fill/scale never gets clipped by adjacent run strokes
        const orderedRuns = runs.filter(r => r.state !== 'active').concat(runs.filter(r => r.state === 'active'));
        for (const run of orderedRuns) {
            if (run.opacity <= 0.001 || !run.text) continue;
            const prefixW = _measureScrollSubstrWidth(ctx, line, 0, run.charStart, bLetterSpacing);
            const nextPrefixW = _measureScrollSubstrWidth(ctx, line, 0, run.charEnd, bLetterSpacing);
            const runW = nextPrefixW - prefixW;
            const runX = isRtl ? (lx + lineW - nextPrefixW) : (lx + prefixW);

            ctx.save();
            ctx.globalAlpha = ctx.globalAlpha * run.opacity;

            if (Math.abs(run.scale - 1.0) > 0.005) {
                const cx = runX + runW / 2;
                const cy = yc - fontSize * 0.35;
                ctx.translate(cx, cy);
                ctx.scale(run.scale, run.scale);
                ctx.translate(-cx, -cy);
            }

            // 1) Shadow
            if (ov.shadow_enabled) {
                ctx.save();
                ctx.shadowColor = _withAlpha(ov.shadow_color || '#000000', (ov.shadow_opacity || 120) / 255);
                ctx.shadowBlur = parseFloat(ov.shadow_blur || 4);
                ctx.shadowOffsetX = parseFloat(ov.scroll_shadow_x ?? ov.shadow_offset_x ?? 2);
                ctx.shadowOffsetY = parseFloat(ov.scroll_shadow_y ?? ov.shadow_offset_y ?? 2);
                ctx.fillStyle = String(run.color || '#000000').split(',')[0].trim() || '#000000';
                if (typeof _fillTextWithLetterSpacing !== 'undefined' && bLetterSpacing !== 0 && typeof ctx.letterSpacing === 'undefined') {
                    _fillTextWithLetterSpacing(ctx, run.text, runX, yc, bLetterSpacing);
                } else {
                    ctx.fillText(run.text, runX, yc);
                }
                ctx.restore();
            }

            // 2) Stroke
            if (ov.use_stroke && (ov.stroke_width || 0) > 0) {
                ctx.save();
                ctx.strokeStyle = ov.stroke_color || '#000000';
                ctx.lineWidth = parseFloat(ov.stroke_width || 2) * 2;
                ctx.lineJoin = 'round';
                ctx.miterLimit = 2;
                if (typeof _strokeTextWithLetterSpacing !== 'undefined' && bLetterSpacing !== 0 && typeof ctx.letterSpacing === 'undefined') {
                    _strokeTextWithLetterSpacing(ctx, run.text, runX, yc, bLetterSpacing);
                } else {
                    ctx.strokeText(run.text, runX, yc);
                }
                ctx.restore();
            }

            // 3) Fill
            if (run.state !== 'active' && !(keepReadColor && run.state === 'read') && _scrollBodyRanges && _scrollBodyRanges.length > 0 && typeof ReelsRichText !== 'undefined') {
                _drawRichLine(ctx, run.text, rawContent, _scrollBodyRanges, runX, yc, run.color, fontSize, bodyFamily, bodyFallback, bodyWeight, bLetterSpacing, undefined, undefined, undefined, gradDir);
            } else {
                const isSingleWordGrad = (run.state === 'active' && !keepReadColor && typeof run.color === 'string' && run.color.includes(','));
                const fillSpanX = isSingleWordGrad ? runX : lx;
                const fillSpanW = isSingleWordGrad ? Math.max(1, runW) : lineW;
                const fillGradDir = isSingleWordGrad ? 'horizontal' : gradDir;
                ctx.fillStyle = _resolveOverlayTextFill(ctx, run.color, fillSpanX, yc, fontSize, fillSpanW, fillGradDir);
                if (typeof _fillTextWithLetterSpacing !== 'undefined' && bLetterSpacing !== 0 && typeof ctx.letterSpacing === 'undefined') {
                    _fillTextWithLetterSpacing(ctx, run.text, runX, yc, bLetterSpacing);
                } else {
                    ctx.fillText(run.text, runX, yc);
                }
            }

            ctx.restore();
        }
    }

    // Draw writing tip / cursor
    const writingWindow = _getScrollWritingWindow(ov, twContext);
    const cursorInWindow = !writingWindow || (currentTime >= writingWindow.start && currentTime < writingWindow.end);
    if (cursorEnabled && cursorInWindow && cursorX !== null && cursorBaselineY !== null) {
        if (isImageTip && hasWritingStarted) {
            const rawScale = Number(ov.scroll_tw_cursor_scale) || 100;
            const scale = Math.max(0.2, Math.min(4, rawScale > 10 ? (rawScale / 100) * 1.15 : rawScale));
            const offX = Number(ov.scroll_tw_cursor_offset_x) || 0;
            const offY = Number(ov.scroll_tw_cursor_offset_y) || 0;
            const angle = Number(ov.scroll_tw_cursor_angle) ?? -8;
            const tipX = cursorX + offX;
            const tipY = cursorBaselineY - fontSize * 0.08 + offY;
            const tipSize = fontSize * scale;
            if (tipKind === 'image') {
                _drawScrollTypewriterCursorImage(ctx, ov, tipX, tipY, tipSize, angle, currentTime);
            } else if (typeof drawSpeechWritingTip === 'function') {
                drawSpeechWritingTip(ctx, tipKind, tipX, tipY, tipSize, angle);
            }
        } else if (!isImageTip && Math.floor(currentTime * 2) % 2 === 0) {
            ctx.save();
            ctx.fillStyle = ov.scroll_tw_cursor_color || '#FFD700';
            ctx.fillText(ov.scroll_tw_cursor_char || '|', cursorX, cursorBaselineY);
            ctx.restore();
        }
    }
}


const PHONE_CTA_STYLES = {
    whatsapp_lime_inline: {
        name: '🟢 荧光黄逐行紧贴蒙版 (WhatsApp同款)',
        cta_mask_mode: 'inline-joined',
        cta_mask_color: '#E0FF14',
        cta_mask_opacity: 100,
        cta_mask_radius: 14,
        cta_mask_pad_h: 22,
        cta_mask_pad_v: 14,
        cta_phone_color: '#E60039',
        card_enabled: false,
        card_color: '#E0FF14',
        card_opacity: 100,
        radius_tl: 18, radius_tr: 18, radius_bl: 18, radius_br: 18,
        card_border_enabled: false,
        card_blur_enabled: false,
        title_font_family: 'Montserrat, Arial, sans-serif',
        title_fontsize: 42,
        title_font_weight: 800,
        title_bold: true,
        title_italic: false,
        title_color: '#000000',
        title_uppercase: false,
        title_line_spacing: 6,
        body_font_family: 'Montserrat, Arial, sans-serif',
        body_fontsize: 48,
        body_font_weight: 800,
        body_bold: true,
        body_italic: false,
        body_color: '#000000',
        body_line_spacing: 10,
        independent_effects: true,
        title_stroke_color: '#000000',
        title_stroke_width: 0,
        title_shadow_blur: 0,
        body_stroke_color: '#000000',
        body_stroke_width: 0,
        body_shadow_color: '#000000',
        body_shadow_blur: 0,
        body_shadow_x: 0,
        body_shadow_y: 0,
        body_bg_enabled: true,
        body_bg_mode: 'inline-joined',
        body_bg_color: '#E0FF14',
        body_bg_opacity: 100,
        body_bg_radius: 14,
        body_bg_pad_h: 22,
        body_bg_pad_top: 14,
        body_bg_pad_bottom: 14,
        padding_top: 16,
        padding_bottom: 16,
        padding_left: 24,
        padding_right: 24,
        title_body_gap: 8,
    },
    white_red_inline: {
        name: '⬜ 白底红号逐行紧贴蒙版 (高对比)',
        cta_mask_mode: 'inline-joined',
        cta_mask_color: '#FFFFFF',
        cta_mask_opacity: 98,
        cta_mask_radius: 14,
        cta_mask_pad_h: 22,
        cta_mask_pad_v: 14,
        cta_phone_color: '#DC2626',
        card_enabled: false,
        card_color: '#FFFFFF',
        card_opacity: 98,
        radius_tl: 18, radius_tr: 18, radius_bl: 18, radius_br: 18,
        card_border_enabled: false,
        card_blur_enabled: false,
        title_font_family: 'Montserrat, Arial, sans-serif',
        title_fontsize: 42,
        title_font_weight: 800,
        title_bold: true,
        title_italic: false,
        title_color: '#111827',
        title_uppercase: false,
        title_line_spacing: 6,
        body_font_family: 'Montserrat, Arial, sans-serif',
        body_fontsize: 48,
        body_font_weight: 800,
        body_bold: true,
        body_italic: false,
        body_color: '#111827',
        body_line_spacing: 10,
        independent_effects: true,
        title_stroke_width: 0,
        title_shadow_blur: 0,
        body_stroke_width: 0,
        body_shadow_blur: 0,
        body_bg_enabled: true,
        body_bg_mode: 'inline-joined',
        body_bg_color: '#FFFFFF',
        body_bg_opacity: 98,
        body_bg_radius: 14,
        body_bg_pad_h: 22,
        body_bg_pad_top: 14,
        body_bg_pad_bottom: 14,
        padding_top: 16,
        padding_bottom: 16,
        padding_left: 24,
        padding_right: 24,
        title_body_gap: 8,
    },
    black_gold_inline: {
        name: '🖤 黑底金号逐行紧贴蒙版 (沉稳醒目)',
        cta_mask_mode: 'inline-joined',
        cta_mask_color: '#0B1021',
        cta_mask_opacity: 94,
        cta_mask_radius: 14,
        cta_mask_pad_h: 22,
        cta_mask_pad_v: 14,
        cta_phone_color: '#FFD700',
        card_enabled: false,
        card_color: '#0B1021',
        card_opacity: 94,
        radius_tl: 18, radius_tr: 18, radius_bl: 18, radius_br: 18,
        card_border_enabled: false,
        card_blur_enabled: false,
        title_font_family: 'Montserrat, Arial, sans-serif',
        title_fontsize: 42,
        title_font_weight: 800,
        title_bold: true,
        title_italic: false,
        title_color: '#FFFFFF',
        title_uppercase: false,
        title_line_spacing: 6,
        body_font_family: 'Montserrat, Arial, sans-serif',
        body_fontsize: 48,
        body_font_weight: 800,
        body_bold: true,
        body_italic: false,
        body_color: '#FFFFFF',
        body_line_spacing: 10,
        independent_effects: true,
        title_stroke_width: 0,
        title_shadow_blur: 0,
        body_stroke_width: 0,
        body_shadow_blur: 0,
        body_bg_enabled: true,
        body_bg_mode: 'inline-joined',
        body_bg_color: '#0B1021',
        body_bg_opacity: 94,
        body_bg_radius: 14,
        body_bg_pad_h: 22,
        body_bg_pad_top: 14,
        body_bg_pad_bottom: 14,
        padding_top: 16,
        padding_bottom: 16,
        padding_left: 24,
        padding_right: 24,
        title_body_gap: 8,
    },
    gold_dark_banner: {
        name: '📞 黑金祈祷热线横幅 (经典整块卡)',
        cta_mask_mode: 'card',
        cta_mask_color: '#0B1021',
        cta_mask_opacity: 92,
        cta_mask_radius: 48,
        cta_mask_pad_h: 24,
        cta_mask_pad_v: 14,
        cta_phone_color: '#FFD700',
        card_enabled: true,
        card_color: '#0B1021',
        card_opacity: 92,
        radius_tl: 48, radius_tr: 48, radius_bl: 48, radius_br: 48,
        card_border_enabled: true,
        card_border_color: '#FFD700',
        card_border_width: 4,
        card_border_style: 'solid',
        card_border_opacity: 100,
        card_blur_enabled: false,
        title_font_family: 'Montserrat, Arial, sans-serif',
        title_fontsize: 34,
        title_font_weight: 800,
        title_bold: true,
        title_italic: false,
        title_color: '#FFD700',
        title_uppercase: true,
        title_line_spacing: 4,
        body_font_family: 'Montserrat, Impact, Arial, sans-serif',
        body_fontsize: 56,
        body_font_weight: 900,
        body_bold: true,
        body_italic: false,
        body_color: '#FFFFFF',
        body_line_spacing: 4,
        independent_effects: true,
        title_stroke_color: '#000000',
        title_stroke_width: 0,
        title_shadow_color: '#000000',
        title_shadow_blur: 6,
        title_shadow_x: 0,
        title_shadow_y: 2,
        body_stroke_color: '#000000',
        body_stroke_width: 3,
        body_shadow_color: '#000000',
        body_shadow_blur: 8,
        body_shadow_x: 0,
        body_shadow_y: 3,
        padding_top: 24,
        padding_bottom: 24,
        padding_left: 36,
        padding_right: 36,
        title_body_gap: 10,
    },
    green_call_pill: {
        name: '🟢 翠绿来电胶囊条 (醒目按钮)',
        card_enabled: true,
        card_color: '#15803D',
        card_opacity: 95,
        radius_tl: 64, radius_tr: 64, radius_bl: 64, radius_br: 64,
        card_border_enabled: true,
        card_border_color: '#86EFAC',
        card_border_width: 4,
        card_border_style: 'solid',
        card_border_opacity: 100,
        card_blur_enabled: false,
        title_font_family: 'Montserrat, Arial, sans-serif',
        title_fontsize: 32,
        title_font_weight: 800,
        title_bold: true,
        title_italic: false,
        title_color: '#FEF08A',
        title_uppercase: true,
        title_line_spacing: 4,
        body_font_family: 'Montserrat, Impact, Arial, sans-serif',
        body_fontsize: 56,
        body_font_weight: 900,
        body_bold: true,
        body_italic: false,
        body_color: '#FFFFFF',
        body_line_spacing: 4,
        independent_effects: true,
        title_stroke_color: '#052E16',
        title_stroke_width: 0,
        title_shadow_color: '#052E16',
        title_shadow_blur: 4,
        title_shadow_x: 0,
        title_shadow_y: 2,
        body_stroke_color: '#052E16',
        body_stroke_width: 3,
        body_shadow_color: '#052E16',
        body_shadow_blur: 8,
        body_shadow_x: 0,
        body_shadow_y: 3,
        padding_top: 24,
        padding_bottom: 24,
        padding_left: 38,
        padding_right: 38,
        title_body_gap: 10,
    },
    yellow_black_alert: {
        name: '🟡 黄底黑字热线牌 (强视觉冲击)',
        card_enabled: true,
        card_color: '#FFD700',
        card_opacity: 96,
        radius_tl: 32, radius_tr: 32, radius_bl: 32, radius_br: 32,
        card_border_enabled: true,
        card_border_color: '#000000',
        card_border_width: 5,
        card_border_style: 'solid',
        card_border_opacity: 100,
        card_blur_enabled: false,
        title_font_family: 'Montserrat, Impact, Arial, sans-serif',
        title_fontsize: 33,
        title_font_weight: 900,
        title_bold: true,
        title_italic: false,
        title_color: '#111827',
        title_uppercase: true,
        title_line_spacing: 4,
        body_font_family: 'Impact, Montserrat, Arial, sans-serif',
        body_fontsize: 58,
        body_font_weight: 900,
        body_bold: true,
        body_italic: false,
        body_color: '#B91C1C',
        body_line_spacing: 4,
        independent_effects: true,
        title_stroke_color: '#FFFFFF',
        title_stroke_width: 0,
        title_shadow_blur: 0,
        body_stroke_color: '#FFFFFF',
        body_stroke_width: 3,
        body_shadow_color: '#000000',
        body_shadow_blur: 0,
        body_shadow_x: 0,
        body_shadow_y: 0,
        padding_top: 22,
        padding_bottom: 22,
        padding_left: 36,
        padding_right: 36,
        title_body_gap: 8,
    },
    red_white_urgent: {
        name: '🔴 红白紧急呼召卡 (高转化)',
        card_enabled: true,
        card_color: '#B91C1C',
        card_opacity: 95,
        radius_tl: 38, radius_tr: 38, radius_bl: 38, radius_br: 38,
        card_border_enabled: true,
        card_border_color: '#FDE047',
        card_border_width: 4,
        card_border_style: 'solid',
        card_border_opacity: 100,
        card_blur_enabled: false,
        title_font_family: 'Montserrat, Arial, sans-serif',
        title_fontsize: 33,
        title_font_weight: 800,
        title_bold: true,
        title_italic: false,
        title_color: '#FDE047',
        title_uppercase: true,
        title_line_spacing: 4,
        body_font_family: 'Montserrat, Impact, Arial, sans-serif',
        body_fontsize: 56,
        body_font_weight: 900,
        body_bold: true,
        body_italic: false,
        body_color: '#FFFFFF',
        body_line_spacing: 4,
        independent_effects: true,
        title_stroke_color: '#450A0A',
        title_stroke_width: 0,
        title_shadow_color: '#450A0A',
        title_shadow_blur: 4,
        title_shadow_x: 0,
        title_shadow_y: 2,
        body_stroke_color: '#450A0A',
        body_stroke_width: 3,
        body_shadow_color: '#450A0A',
        body_shadow_blur: 6,
        body_shadow_x: 0,
        body_shadow_y: 3,
        padding_top: 24,
        padding_bottom: 24,
        padding_left: 36,
        padding_right: 36,
        title_body_gap: 10,
    },
    frosted_glass_gold: {
        name: '✨ 磨砂玻璃金字条 (高级感)',
        card_enabled: true,
        card_color: '#0F172A',
        card_opacity: 72,
        radius_tl: 44, radius_tr: 44, radius_bl: 44, radius_br: 44,
        card_border_enabled: true,
        card_border_color: '#F59E0B',
        card_border_width: 2,
        card_border_style: 'solid',
        card_border_opacity: 90,
        card_blur_enabled: true,
        card_blur_amount: 14,
        title_font_family: 'Montserrat, Arial, sans-serif',
        title_fontsize: 31,
        title_font_weight: 700,
        title_bold: true,
        title_italic: false,
        title_color: '#FDE68A',
        title_uppercase: true,
        title_line_spacing: 4,
        body_font_family: 'Montserrat, Arial, sans-serif',
        body_fontsize: 52,
        body_font_weight: 900,
        body_bold: true,
        body_italic: false,
        body_color: '#FFFFFF',
        body_line_spacing: 4,
        independent_effects: true,
        title_stroke_color: '#000000',
        title_stroke_width: 0,
        title_shadow_color: '#000000',
        title_shadow_blur: 6,
        title_shadow_x: 0,
        title_shadow_y: 2,
        body_stroke_color: '#000000',
        body_stroke_width: 2,
        body_shadow_color: '#000000',
        body_shadow_blur: 8,
        body_shadow_x: 0,
        body_shadow_y: 3,
        padding_top: 22,
        padding_bottom: 22,
        padding_left: 36,
        padding_right: 36,
        title_body_gap: 8,
    },
    pure_text_stroked: {
        name: '💬 纯文字粗描边 (无底框)',
        card_enabled: false,
        card_color: '#000000',
        card_opacity: 0,
        radius_tl: 0, radius_tr: 0, radius_bl: 0, radius_br: 0,
        card_border_enabled: false,
        card_blur_enabled: false,
        title_font_family: 'Montserrat, Impact, Arial, sans-serif',
        title_fontsize: 38,
        title_font_weight: 900,
        title_bold: true,
        title_italic: false,
        title_color: '#FFD700',
        title_uppercase: true,
        title_line_spacing: 4,
        body_font_family: 'Montserrat, Impact, Arial, sans-serif',
        body_fontsize: 64,
        body_font_weight: 900,
        body_bold: true,
        body_italic: false,
        body_color: '#FFFFFF',
        body_line_spacing: 4,
        independent_effects: true,
        title_stroke_color: '#000000',
        title_stroke_width: 7,
        title_shadow_color: '#000000',
        title_shadow_blur: 8,
        title_shadow_x: 0,
        title_shadow_y: 3,
        body_stroke_color: '#000000',
        body_stroke_width: 9,
        body_shadow_color: '#000000',
        body_shadow_blur: 10,
        body_shadow_x: 0,
        body_shadow_y: 4,
        padding_top: 14,
        padding_bottom: 14,
        padding_left: 24,
        padding_right: 24,
        title_body_gap: 8,
    },
};

function syncPhoneCtaMaskAndColors(ov) {
    if (!ov) return ov;
    ov.independent_effects = true;
    const mode = ov.cta_mask_mode
        || (ov.body_bg_enabled ? (ov.body_bg_mode || 'inline-joined') : (ov.card_enabled !== false ? 'card' : 'none'));
    ov.cta_mask_mode = mode;

    const maskColor = ov.cta_mask_color || (mode === 'card' ? (ov.card_color || '#0B1021') : (ov.body_bg_color || '#E0FF14'));
    const maskOpacity = Number.isFinite(Number(ov.cta_mask_opacity))
        ? Math.max(0, Math.min(100, Number(ov.cta_mask_opacity)))
        : (mode === 'card' ? (ov.card_opacity ?? 92) : (ov.body_bg_opacity ?? 100));
    const maskRadius = Number.isFinite(Number(ov.cta_mask_radius))
        ? Math.max(0, Number(ov.cta_mask_radius))
        : (mode === 'card' ? (ov.radius_tl ?? 36) : (ov.body_bg_radius ?? 14));
    const padH = Number.isFinite(Number(ov.cta_mask_pad_h))
        ? Math.max(0, Number(ov.cta_mask_pad_h))
        : (ov.body_bg_pad_h ?? 22);
    const padV = Number.isFinite(Number(ov.cta_mask_pad_v))
        ? Math.max(0, Number(ov.cta_mask_pad_v))
        : (ov.body_bg_pad_top ?? 14);

    ov.cta_mask_color = maskColor;
    ov.cta_mask_opacity = maskOpacity;
    ov.cta_mask_radius = maskRadius;
    ov.cta_mask_pad_h = padH;
    ov.cta_mask_pad_v = padV;

    if (mode === 'inline-joined' || mode === 'inline' || mode === 'block-fit') {
        ov.card_enabled = false;
        ov.card_border_enabled = false;
        ov.card_blur_enabled = false;
        ov.body_bg_enabled = true;
        ov.body_bg_mode = mode;
        ov.body_bg_color = maskColor;
        ov.body_bg_opacity = maskOpacity;
        ov.body_bg_radius = maskRadius;
        ov.body_bg_pad_h = padH;
        ov.body_bg_pad_top = padV;
        ov.body_bg_pad_bottom = padV;
        if ((ov.title_text || '').trim()) {
            ov.title_bg_enabled = true;
            ov.title_bg_mode = mode;
            ov.title_bg_color = maskColor;
            ov.title_bg_opacity = maskOpacity;
            ov.title_bg_radius = maskRadius;
            ov.title_bg_pad_h = padH;
            ov.title_bg_pad_top = padV;
            ov.title_bg_pad_bottom = padV;
        } else {
            ov.title_bg_enabled = false;
        }
    } else if (mode === 'card') {
        ov.card_enabled = true;
        ov.card_color = maskColor;
        ov.card_opacity = maskOpacity;
        ov.radius_tl = maskRadius;
        ov.radius_tr = maskRadius;
        ov.radius_bl = maskRadius;
        ov.radius_br = maskRadius;
        ov.body_bg_enabled = false;
        ov.title_bg_enabled = false;
    } else {
        ov.card_enabled = false;
        ov.card_border_enabled = false;
        ov.card_blur_enabled = false;
        ov.body_bg_enabled = false;
        ov.title_bg_enabled = false;
    }

    const phoneColor = (ov.cta_phone_color || '').trim();
    const otherRules = Array.isArray(ov.auto_color_rules)
        ? ov.auto_color_rules.filter(r => !r || !r._ctaPhoneRule)
        : [];
    if (phoneColor) {
        otherRules.push({
            _ctaPhoneRule: true,
            type: 'regex',
            keywords: ['(?:[aA][tT]\\s+)?[+\\d][\\d\\s()\\-\\.]{5,}\\d'],
            color: phoneColor,
            bold: true,
        });
    }
    ov.auto_color_rules = otherRules;
    return ov;
}

function applyPhoneCtaStylePreset(ov, styleId) {
    if (!ov || !styleId || !PHONE_CTA_STYLES[styleId]) return ov;
    const preset = PHONE_CTA_STYLES[styleId];
    ov.cta_style_id = styleId;
    ov.is_phone_cta = true;
    for (const [k, v] of Object.entries(preset)) {
        if (k === 'name') continue;
        ov[k] = v;
    }
    if (!preset.cta_mask_mode) {
        ov.cta_mask_mode = preset.card_enabled === false ? 'none' : 'card';
        ov.cta_mask_color = preset.card_color || '#0B1021';
        ov.cta_mask_opacity = preset.card_opacity ?? 92;
        ov.cta_mask_radius = preset.radius_tl ?? 38;
        ov.cta_phone_color = preset.body_color || '#FFD700';
        ov.body_bg_enabled = false;
        ov.title_bg_enabled = false;
    }
    syncPhoneCtaMaskAndColors(ov);
    return ov;
}

/**
 * 创建邀约电话 (Phone Call-to-Action) 覆层对象。
 * 默认在 10 秒后出现 (start: 10, end: 9999)，固定文案 (fixed_text: true)，自带入场动画与呼吸/震动效果。
 */
function createPhoneCtaOverlay(opts = {}) {
    const styleId = (opts.cta_style_id && PHONE_CTA_STYLES[opts.cta_style_id])
        ? opts.cta_style_id
        : 'whatsapp_lime_inline';
    const preset = PHONE_CTA_STYLES[styleId];
    const ov = createTextCardOverlay({
        ...preset,
        x: opts.x ?? 80,
        y: opts.y ?? 1380,
        w: opts.w ?? 920,
        h: opts.h ?? 260,
        start: opts.start ?? 10,
        end: opts.end ?? 9999,
        title_text: opts.title_text ?? '',
        body_text: opts.body_text ?? 'Message on Whats/App\nat +1 (315) 277-2179\nto join our Free Bible\nstudy.',
        footer_text: opts.footer_text ?? '',
        auto_fit: opts.auto_fit ?? true,
        auto_center_v: opts.auto_center_v ?? false,
        anim_in_type: opts.anim_in_type || 'ring_shake',
        anim_in_duration: opts.anim_in_duration ?? 0.55,
        anim_out_type: opts.anim_out_type || 'fade',
        anim_out_duration: opts.anim_out_duration ?? 0.3,
        cta_loop_anim: opts.cta_loop_anim ?? 'pulse',
        is_phone_cta: true,
        cta_style_id: styleId,
        fixed_text: opts.fixed_text ?? true,
        ...opts,
    });
    Object.assign(ov, preset, opts);
    ov.name = opts.name || '📞 邀约电话';
    ov.is_phone_cta = true;
    ov.fixed_text = opts.fixed_text ?? true;
    ov.cta_style_id = styleId;
    ov.cta_mode = opts.cta_mode || (opts.cta_image_src ? 'image' : 'text');
    ov.cta_image_src = opts.cta_image_src || '';
    ov.cta_image_name = opts.cta_image_name || '';
    ov.cta_image_scale = opts.cta_image_scale ?? 100;
    syncPhoneCtaMaskAndColors(ov);
    return ov;
}


async function prepareScrollWritingLayers(layers, segments, timeScale = 1) {
    for (const ov of layers || []) if (ov?.type === 'scroll' && ov.scroll_typewriter_enabled) {
        ov._taskSegments=(segments||[]).map(seg=>({...seg,start:Number(seg.start)*timeScale,end:Number(seg.end)*timeScale,words:seg.words?.map(w=>({...w,start:Number(w.start)*timeScale,end:Number(w.end)*timeScale}))}));
        await prepareScrollWritingCursorImage(ov);
    }
}

const ReelsOverlay = {
    prepareScrollWritingLayers,
    prepareScrollWritingCursorImage,
    buildScrollWritingLines: _buildScrollTypewriterLines,
    createPhoneCtaOverlay, applyPhoneCtaStylePreset, syncPhoneCtaMaskAndColors, PHONE_CTA_STYLES,
    createDecorOverlay,
    DECOR_OVERLAY_CATEGORIES,
    DECOR_OVERLAY_STYLES,
    applyDecorStylePreset,
    drawAdaptiveTitlePreview,
    isPreviewMediaReady,
    isPreviewMediaSettled,
    getContentBlurSource,
    prepareContentBlurBackground,
    hasMediaBlurFill,
    prepareMediaBlurFill,
    disposePreviewMedia,
    pausePreviewMedia: () => Object.values(_videoCache).forEach(video=>video.pause()),
    preparePreviewSeek,
    resolveVideoTime,
    prepareFolderMedia,
    primeFolderMedia,
    resolveFolderMedia,
    buildConnectedBackgroundPath: _traceConnectedOverlayBackground,
    createTextOverlay,
    createImageOverlay,
    createTextCardOverlay,
    createSolidMaskOverlay,
    createScrollOverlay,
    drawOverlay,
    splitBodyText,
    OverlayManager,
    ReelsBrushEngine,
    _resolveOverlayTextFill,
    _resolveOverlayDecoFill,
};

if (typeof window !== 'undefined') {
    window.ReelsOverlay = ReelsOverlay;
    window.ReelsBrushEngine = ReelsBrushEngine;
}
if (typeof module !== 'undefined' && module.exports) module.exports = ReelsOverlay;
