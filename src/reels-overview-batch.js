/** Batch scope for the original overlay inspector. Stores patches, never a second form. */
(function(root,factory){const api=factory(root);if(typeof module==='object' && module.exports)module.exports=api;else root.ReelsOverviewBatch=api;})(typeof window==='object'?window:globalThis,function(win){
    'use strict';
    function clone(value,seen=new WeakSet()){
        if(!value || typeof value!=='object')return typeof value==='function'?undefined:value;
        if(seen.has(value) || (win.Node && value instanceof win.Node))return undefined;
        seen.add(value);const result=Array.isArray(value)?[]:{};
        for(const key of Object.keys(value))if(!['_img','_allOverlays'].includes(key))result[key]=clone(value[key],seen);
        seen.delete(value);return result;
    }
    const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
    const identity=new Set(['id','type','slotKey','slotLabel','_templateOverlayId','_templateName']);
    let context=null,sampling=false,saveTimer;
    // Bindings follow the existing inspector's _val/_get fields, including legacy aliases.
    const controls={"rop-name":["name"],"rop-rotation":["rotation","media_inner_rotation"],"rop-start":["start"],"rop-card-start":["start"],"rop-mask-start":["mask_start"],"rop-mask-end":["mask_end"],"rop-scroll-start-time":["start"],"rop-anim-easing":["anim_easing"],"rop-anim-timing-mode":["anim_timing_mode"],"rop-anim-duration":["anim_duration"],"rop-anim-speed":["anim_speed"],"rop-content":["content","type"],"rop-font":["font_family"],"rop-fontsize":["fontsize"],"rop-color":["color"],"rop-stroke-color":["stroke_color"],"rop-stroke-width":["stroke_width"],"rop-shadow-color":["shadow_color"],"rop-shadow-blur":["shadow_blur"],"rop-shadow-offset-x":["shadow_offset_x"],"rop-shadow-offset-y":["shadow_offset_y"],"rop-flip-h":["flip_x"],"rop-flip-v":["flip_y"],"rop-blend":["blend_mode"],"rop-video-offset":["video_start_offset"],"rop-video-end":["video_end_offset"],"rop-keep-aspect":["keep_aspect"],"rop-media-split-angle":["media_split_angle"],"rop-media-split-angle-slider":["media_split_angle"],"rop-media-window-ratio":["media_window_ratio"],"rop-media-mask-shape":["media_mask_shape"],"rop-media-corner-tl":["media_corner_tl"],"rop-media-corner-tr":["media_corner_tr"],"rop-media-corner-br":["media_corner_br"],"rop-media-corner-bl":["media_corner_bl"],"rop-media-loop":["media_loop"],"rop-media-audio-enabled":["media_audio_enabled"],"rop-media-border-style":["media_border_style"],"rop-media-border-position":["media_border_position"],"rop-media-border-color":["media_border_color"],"rop-media-border-width":["media_border_width"],"rop-media-border-opacity":["media_border_opacity"],"rop-media-blur-fill":["media_blur_fill"],"rop-media-folder-interval":["media_folder_interval"],"rop-media-inner-x":["media_inner_x"],"rop-media-inner-y":["media_inner_y"],"rop-media-inner-rotation":["media_inner_rotation"],"rop-media-crop-left":["media_crop_left"],"rop-media-crop-top":["media_crop_top"],"rop-media-crop-right":["media_crop_right"],"rop-media-crop-bottom":["media_crop_bottom"],"rop-bind-scroll-offset-y":["bind_scroll_offset_y"],"rop-bind-scroll-offset-x":["bind_scroll_offset_x"],"rop-bind-scroll-follow-x":["bind_scroll_follow_x"],"rop-card-enabled":["card_enabled","type"],"rop-card-color":["card_color"],"rop-card-opacity":["card_opacity"],"rop-card-feather-enabled":["card_feather_enabled"],"rop-card-feather-dir":["card_feather_dir"],"rop-card-feather-start":["card_feather_start"],"rop-card-feather-end":["card_feather_end"],"rop-card-border-enabled":["card_border_enabled"],"rop-card-border-sides":["card_border_sides"],"rop-card-border-color":["card_border_color"],"rop-card-border-width":["card_border_width"],"rop-card-border-style":["card_border_style"],"rop-card-border-opacity":["card_border_opacity"],"rop-card-blur-enabled":["card_blur_enabled"],"rop-card-blur-amount":["card_blur_amount"],"rop-radius-all":["radius_tl"],"rop-card-width":["w","type","x"],"rop-card-height":["h","y"],"rop-fixed-text":["fixed_text"],"rop-title-text":["title_text","type"],"rop-title-font":["title_font_family"],"rop-title-fontsize":["title_fontsize"],"rop-title-color":["title_color","title_gradient_direction"],"rop-title-uppercase":["title_uppercase"],"rop-title-align":["title_align"],"rop-title-valign":["title_valign"],"rop-title-letterspacing":["title_letter_spacing"],"rop-title-override-h":["title_override_h"],"rop-title-max-glyph-height":["title_max_glyph_height"],"rop-title-adaptive-enabled":["title_adaptive_enabled"],"rop-title-preferred-glyph-height":["title_preferred_glyph_height"],"rop-title-adaptive-min-w":["title_adaptive_min_w"],"rop-title-adaptive-min-h":["title_adaptive_min_h"],"rop-title-adaptive-max-w":["title_adaptive_max_w"],"rop-title-adaptive-max-h":["title_adaptive_max_h"],"rop-title-adaptive-max-lines":["title_adaptive_max_lines"],"rop-title-linespacing":["title_line_spacing"],"rop-title-rotation":["title_rotation"],"rop-title-offset-x":["title_offset_x"],"rop-title-offset-y":["title_offset_y"],"rop-body-text":["body_text"],"rop-body-follow-title":["body_follow_title"],"rop-body-font":["body_font_family"],"rop-body-fontsize":["body_fontsize"],"rop-body-color":["body_color"],"rop-body-letterspacing":["body_letter_spacing"],"rop-body-override-h":["body_override_h"],"rop-body-auto-shrink":["body_auto_shrink"],"rop-body-linespacing":["body_line_spacing"],"rop-body-align":["body_align"],"rop-body-valign":["body_valign"],"rop-body-offset-x":["body_offset_x"],"rop-body-offset-y":["body_offset_y"],"rop-footer-text":["footer_text"],"rop-footer-font":["footer_font_family"],"rop-footer-fontsize":["footer_fontsize"],"rop-footer-color":["footer_color"],"rop-footer-letterspacing":["footer_letter_spacing"],"rop-footer-override-h":["footer_override_h"],"rop-footer-auto-shrink":["footer_auto_shrink"],"rop-footer-linespacing":["footer_line_spacing"],"rop-footer-align":["footer_align"],"rop-footer-valign":["footer_valign"],"rop-footer-offset-x":["footer_offset_x"],"rop-footer-offset-y":["footer_offset_y"],"rop-title-bg-enabled":["title_bg_enabled"],"rop-title-bg-mode":["title_bg_mode"],"rop-title-bg-brush":["title_bg_brush"],"rop-title-bg-brush-style":["title_bg_brush_style"],"rop-title-bg-brush-colormode":["title_bg_brush_colormode_v2","title_bg_brush_colormode"],"rop-title-bg-brush-fit":["title_bg_brush_fit"],"rop-title-bg-brush-zoom":["title_bg_brush_zoom"],"rop-title-bg-brush-scale-x":["title_bg_brush_scale_x"],"rop-title-bg-brush-scale-y":["title_bg_brush_scale_y"],"rop-title-bg-brush-solid":["title_bg_brush_solid"],"rop-title-bg-brush-x":["title_bg_brush_x"],"rop-title-bg-brush-y":["title_bg_brush_y"],"rop-title-bg-color":["title_bg_color","title_bg_gradient_direction"],"rop-title-bg-opacity":["title_bg_opacity"],"rop-title-bg-radius":["title_bg_radius"],"rop-title-bg-pad-h":["title_bg_pad_h"],"rop-title-bg-pad-top":["title_bg_pad_top"],"rop-title-bg-border-enabled":["title_bg_border_enabled"],"rop-title-bg-border-color":["title_bg_border_color"],"rop-title-bg-border-width":["title_bg_border_width"],"rop-title-bg-border-style":["title_bg_border_style"],"rop-title-bg-border-opacity":["title_bg_border_opacity"],"rop-title-bg-pad-bottom":["title_bg_pad_bottom"],"rop-title-deco-enabled":["title_deco_enabled"],"rop-title-deco-position":["title_deco_position"],"rop-title-deco-style":["title_deco_style"],"rop-title-deco-color":["title_deco_color"],"rop-title-deco-color2":["title_deco_color2"],"rop-title-deco-thickness":["title_deco_thickness"],"rop-title-deco-length":["title_deco_length"],"rop-title-deco-gap":["title_deco_gap"],"rop-title-deco-opacity":["title_deco_opacity"],"rop-title-deco-align":["title_deco_align"],"rop-body-bg-enabled":["body_bg_enabled"],"rop-body-bg-mode":["body_bg_mode"],"rop-body-bg-brush":["body_bg_brush"],"rop-body-bg-brush-style":["body_bg_brush_style"],"rop-body-bg-brush-colormode":["body_bg_brush_colormode_v2","body_bg_brush_colormode"],"rop-body-bg-brush-fit":["body_bg_brush_fit"],"rop-body-bg-brush-zoom":["body_bg_brush_zoom"],"rop-body-bg-brush-scale-x":["body_bg_brush_scale_x"],"rop-body-bg-brush-scale-y":["body_bg_brush_scale_y"],"rop-body-bg-brush-solid":["body_bg_brush_solid"],"rop-body-bg-brush-x":["body_bg_brush_x"],"rop-body-bg-brush-y":["body_bg_brush_y"],"rop-body-bg-color":["body_bg_color"],"rop-body-bg-opacity":["body_bg_opacity"],"rop-body-bg-radius":["body_bg_radius"],"rop-body-bg-pad-h":["body_bg_pad_h"],"rop-body-bg-pad-top":["body_bg_pad_top"],"rop-body-bg-border-enabled":["body_bg_border_enabled"],"rop-body-bg-border-color":["body_bg_border_color"],"rop-body-bg-border-width":["body_bg_border_width"],"rop-body-bg-border-style":["body_bg_border_style"],"rop-body-bg-border-opacity":["body_bg_border_opacity"],"rop-body-bg-pad-bottom":["body_bg_pad_bottom"],"rop-footer-bg-enabled":["footer_bg_enabled"],"rop-footer-bg-mode":["footer_bg_mode"],"rop-footer-bg-color":["footer_bg_color"],"rop-footer-bg-opacity":["footer_bg_opacity"],"rop-footer-bg-radius":["footer_bg_radius"],"rop-footer-bg-pad-h":["footer_bg_pad_h"],"rop-footer-bg-pad-top":["footer_bg_pad_top"],"rop-footer-bg-border-enabled":["footer_bg_border_enabled"],"rop-footer-bg-border-color":["footer_bg_border_color"],"rop-footer-bg-border-width":["footer_bg_border_width"],"rop-footer-bg-border-style":["footer_bg_border_style"],"rop-footer-bg-border-opacity":["footer_bg_border_opacity"],"rop-footer-bg-pad-bottom":["footer_bg_pad_bottom"],"rop-auto-fit":["auto_fit"],"rop-auto-center":["auto_center_v"],"rop-offset-x":["offset_x"],"rop-offset-y":["offset_y"],"rop-title-body-gap":["title_body_gap"],"rop-side-by-side-gap":["side_by_side_gap"],"rop-side-by-side-title-ratio":["side_by_side_title_ratio"],"rop-layout-mode":["layout_mode"],"rop-debug-layout":["debug_layout"],"rop-debug-title":["debug_title"],"rop-debug-body":["debug_body"],"rop-debug-footer":["debug_footer"],"rop-body-footer-gap":["body_footer_gap"],"rop-pad-top":["padding_top"],"rop-pad-bottom":["padding_bottom"],"rop-pad-left":["padding_left"],"rop-pad-right":["padding_right"],"rop-auto-shrink":["auto_shrink"],"rop-max-height":["max_height"],"rop-title-max-lines":["title_max_lines"],"rop-min-fontsize":["min_fontsize"],"rop-scroll-content":["content","type"],"rop-scroll-title":["scroll_title"],"rop-scroll-title-fontsize":["scroll_title_fontsize"],"rop-scroll-title-color":["scroll_title_color"],"rop-scroll-title-font":["scroll_title_font_family"],"rop-scroll-title-weight":["scroll_title_font_weight"],"rop-scroll-title-uppercase":["scroll_title_uppercase"],"rop-scroll-title-letterspacing":["scroll_title_letter_spacing"],"rop-scroll-title-align":["scroll_title_align"],"rop-scroll-title-linespacing":["scroll_title_line_spacing"],"rop-scroll-title-textw":["scroll_title_text_width"],"rop-scroll-title-gap":["scroll_title_gap"],"rop-scroll-title-fixed":["scroll_title_fixed"],"rop-scroll-title-independent":["scroll_title_independent"],"rop-scroll-title-x":["scroll_title_x"],"rop-scroll-title-y":["scroll_title_y"],"rop-scroll-title-auto-fit":["scroll_title_auto_fit"],"rop-scroll-title-maxh":["scroll_title_max_height"],"rop-scroll-title-stroke-color":["scroll_title_stroke_color"],"rop-scroll-title-stroke-width":["scroll_title_stroke_width"],"rop-scroll-title-shadow":["scroll_title_shadow_enabled"],"rop-scroll-title-shadow-color":["scroll_title_shadow_color"],"rop-scroll-title-shadow-blur":["scroll_title_shadow_blur"],"rop-scroll-title-shadow-x":["scroll_title_shadow_x"],"rop-scroll-title-shadow-y":["scroll_title_shadow_y"],"rop-scroll-title-bg-enabled":["scroll_title_bg_enabled"],"rop-scroll-title-bg-mode":["scroll_title_bg_mode"],"rop-scroll-title-bg-color":["scroll_title_bg_color"],"rop-scroll-title-bg-opacity":["scroll_title_bg_opacity"],"rop-scroll-title-bg-radius":["scroll_title_bg_radius"],"rop-scroll-title-bg-pad-h":["scroll_title_bg_pad_h"],"rop-scroll-title-bg-pad-top":["scroll_title_bg_pad_top"],"rop-scroll-title-bg-pad-bottom":["scroll_title_bg_pad_bottom"],"rop-scroll-title-deco-enabled":["scroll_title_deco_enabled"],"rop-scroll-title-deco-position":["scroll_title_deco_position"],"rop-scroll-title-deco-style":["scroll_title_deco_style"],"rop-scroll-title-deco-align":["scroll_title_deco_align"],"rop-scroll-title-deco-color":["scroll_title_deco_color"],"rop-scroll-title-deco-color2":["scroll_title_deco_color2"],"rop-scroll-title-deco-thickness":["scroll_title_deco_thickness"],"rop-scroll-title-deco-length":["scroll_title_deco_length"],"rop-scroll-title-deco-opacity":["scroll_title_deco_opacity"],"rop-scroll-font":["font_family"],"rop-scroll-fontsize":["fontsize"],"rop-scroll-color":["color"],"rop-scroll-uppercase":["scroll_uppercase"],"rop-scroll-letterspacing":["scroll_letter_spacing"],"rop-scroll-align":["text_align"],"rop-scroll-text-direction":["text_direction"],"rop-scroll-linespacing":["line_spacing"],"rop-scroll-textw":["text_width"],"rop-scroll-stroke-color":["stroke_color"],"rop-scroll-stroke-width":["stroke_width"],"rop-scroll-shadow":["shadow_enabled"],"rop-scroll-shadow-color":["shadow_color"],"rop-scroll-shadow-blur":["shadow_blur"],"rop-scroll-shadow-x":["scroll_shadow_x"],"rop-scroll-shadow-y":["scroll_shadow_y"],"rop-scroll-body-bg-enabled":["scroll_body_bg_enabled"],"rop-scroll-body-bg-mode":["scroll_body_bg_mode"],"rop-scroll-body-bg-color":["scroll_body_bg_color"],"rop-scroll-body-bg-opacity":["scroll_body_bg_opacity"],"rop-scroll-body-bg-radius":["scroll_body_bg_radius"],"rop-scroll-body-bg-pad-h":["scroll_body_bg_pad_h"],"rop-scroll-body-bg-pad-top":["scroll_body_bg_pad_top"],"rop-scroll-body-bg-pad-bottom":["scroll_body_bg_pad_bottom"],"rop-scroll-from-y":["scroll_from_y"],"rop-scroll-to-y":["scroll_to_y"],"rop-scroll-offset-x":["scroll_offset_x"],"rop-scroll-offset-y":["scroll_offset_y"],"rop-scroll-feather-top":["feather_top"],"rop-scroll-feather-bottom":["feather_bottom"],"rop-scroll-feather-top-offset":["feather_top_offset"],"rop-scroll-feather-bottom-offset":["feather_bottom_offset"],"rop-scroll-feather-left":["feather_left"],"rop-scroll-feather-right":["feather_right"],"rop-scroll-feather-left-offset":["feather_left_offset"],"rop-scroll-feather-right-offset":["feather_right_offset"],"rop-scroll-auto-stop":["scroll_auto_stop"],"rop-scroll-auto-stop-lead":["scroll_auto_stop_lead"],"rop-scroll-static":["scroll_static"],"rop-scroll-auto-fit":["scroll_auto_fit"],"rop-scroll-min-fontsize":["scroll_min_fontsize"],"rop-scroll-bg-enabled":["bg_enabled"],"rop-scroll-bg-color":["bg_color"],"rop-scroll-bg-radius":["bg_radius"],"rop-scroll-bg-pad-top":["bg_padding_top"],"rop-scroll-bg-pad-bottom":["bg_padding_bottom"],"rop-scroll-bg-pad-left":["bg_padding_left"],"rop-scroll-bg-pad-right":["bg_padding_right"],"rop-scroll-bg-fullscreen":["bg_fullscreen"],"rop-scroll-bg-border-enabled":["bg_border_enabled"],"rop-scroll-bg-border-sides":["bg_border_sides"],"rop-scroll-bg-border-color":["bg_border_color"],"rop-scroll-bg-border-width":["bg_border_width"],"rop-scroll-bg-border-style":["bg_border_style"],"rop-scroll-bg-border-opacity":["bg_border_opacity"],"rop-scroll-bg-blur-enabled":["bg_blur_enabled"],"rop-scroll-bg-blur-amount":["bg_blur_amount"],"rop-anim-in":["anim_in_type"],"rop-anim-out":["anim_out_type"],"rop-anim-in-dur":["anim_in_duration"],"rop-anim-out-dur":["anim_out_duration"],"rop-flipper-duration":["flipper_duration"],"rop-flipper-lines":["flipper_lines"],"rop-flipper-effect":["flipper_effect"],"rop-flipper-transition-duration":["flipper_transition_duration"],"rop-media-window-width":["w"],"rop-media-window-height":["h"],"rop-w":["w","media_window"],"rop-h":["h","media_window"],"rop-x":["type","x","media_inner_x","media_window"],"rop-y":["y","type","media_inner_y","media_window"],"rop-card-x":["type","x"],"rop-card-y":["type","y"],"rop-opacity":["opacity"],"rop-anim-dest-enabled":["anim_dest_enabled"],"rop-use-stroke":["use_stroke"],"rop-shadow-enabled":["shadow_enabled"],"rop-shadow-opacity":["shadow_opacity"],"rop-scale-x":["type","scale","scale_x"],"rop-scale-y":["scale_y","scale"],"rop-media-inner-scale":["media_inner_scale"],"rop-fullscreen-mask":["fullscreen_mask"],"rop-title-stroke-color":["title_stroke_color"],"rop-title-stroke-width":["title_stroke_width"],"rop-title-shadow-color":["title_shadow_color"],"rop-title-shadow-blur":["title_shadow_blur"],"rop-title-shadow-x":["title_shadow_x"],"rop-title-shadow-y":["title_shadow_y"],"rop-title-deco-scale":["title_deco_parameters"],"rop-title-deco-center-gap":["title_deco_parameters"],"rop-title-deco-linecap":["title_deco_parameters"],"rop-title-deco-flip":["title_deco_parameters"],"rop-body-stroke-color":["body_stroke_color"],"rop-body-stroke-width":["body_stroke_width"],"rop-body-shadow-color":["body_shadow_color"],"rop-body-shadow-blur":["body_shadow_blur"],"rop-body-shadow-x":["body_shadow_x"],"rop-body-shadow-y":["body_shadow_y"],"rop-footer-stroke-color":["footer_stroke_color"],"rop-footer-stroke-width":["footer_stroke_width"],"rop-footer-shadow-color":["footer_shadow_color"],"rop-footer-shadow-blur":["footer_shadow_blur"],"rop-footer-shadow-x":["footer_shadow_x"],"rop-footer-shadow-y":["footer_shadow_y"],"rop-scroll-title-deco-gap":["scroll_title_deco_gap"],"rop-scroll-title-deco-scale":["scroll_title_deco_parameters"],"rop-scroll-title-deco-center-gap":["scroll_title_deco_parameters"],"rop-scroll-title-deco-linecap":["scroll_title_deco_parameters"],"rop-scroll-title-deco-flip":["scroll_title_deco_parameters"],"rop-scroll-from-x":["scroll_from_x"],"rop-scroll-bg-opacity":["bg_opacity"],"rop-flipper-enabled":["type"],"rop-flipper-loop":["flipper_loop"],"rop-media-corner-all":["media_corner_tl","media_corner_tr","media_corner_br","media_corner_bl","media_mask_shape"],"rop-media-window-mode":["media_window_mode","media_window","clip_rect","crop_fill","media_window_generated_clip","media_window_initialized","media_inner_x","media_inner_y","media_inner_scale","media_inner_rotation","media_window_ratio","media_split_angle","x","y","w","h","scale","scale_x","scale_y"],"rop-scale":["scale","scale_x","scale_y","media_inner_scale"]};
    // Composite inspector controls write more than their visible value.
    Object.assign(controls,{
        'rop-card-start':['start','mask_start'], 'rop-card-end':['end','mask_end'],
        'rop-card-time-linked':['card_time_linked','mask_start','mask_end'],
        'rop-scroll-end-time':['end'],
        'rop-scroll-from-x':['scroll_from_x','scroll_to_x','scroll_x_anchor'],
        'rop-bind-scroll-target':['bind_scroll_overlay_id'],
        'rop-radius-all':['radius_tl','radius_tr','radius_bl','radius_br'],
        'rop-media-border-style':['media_border_style','media_border_position','media_border_color','media_border_width','media_border_opacity'],
        'rop-media-window-width':['w','h','media_window','clip_rect','media_window_ratio'],
        'rop-media-window-height':['h','media_window','clip_rect','media_window_ratio'],
        'rop-media-window-ratio':['media_window_ratio','h','media_window','clip_rect'],
        'rop-autocolor-rules':['auto_color_rules'],
        'rop-autocolor-add':['auto_color_rules'], 'rop-autocolor-clear':['auto_color_rules'],
    });
    for(const [font,weight,bold,prefix] of [
        ['rop-font','rop-font-weight','rop-bold',''],
        ['rop-title-font','rop-title-weight','rop-title-bold','title_'],
        ['rop-body-font','rop-body-weight','rop-body-bold','body_'],
        ['rop-footer-font','rop-footer-weight','rop-footer-bold','footer_'],
        ['rop-scroll-font','rop-scroll-weight','rop-scroll-bold',''],
        ['rop-scroll-title-font','rop-scroll-title-weight','rop-scroll-title-bold','scroll_title_'],
    ]){
        controls[weight]=controls[bold]=[prefix+'font_weight',prefix+'bold'];
        controls[font]=[...(controls[font] || []),...controls[weight]];
    }
    for(const prefix of ['title','body']){
        const fields=[prefix+'_bg_brush',prefix+'_bg_brush_style',prefix+'_custom_brush_data'];
        controls[`rop-${prefix}-bg-brush-style`]=fields;
        for(const suffix of ['file-input','folder-input'])controls[`rop-${prefix}-brush-${suffix}`]=fields;
    }
    for(const [id,field] of Object.entries({
        'rop-color':'gradient_direction','rop-card-color':'card_gradient_direction',
        'rop-body-color':'body_gradient_direction','rop-footer-color':'footer_gradient_direction',
        'rop-body-bg-color':'body_bg_gradient_direction','rop-footer-bg-color':'footer_bg_gradient_direction',
        'rop-title-deco-color':'title_deco_gradient_direction',
        'rop-scroll-color':'scroll_gradient_direction','rop-scroll-title-color':'scroll_title_gradient_direction',
        'rop-scroll-title-deco-color':'scroll_title_deco_gradient_direction',
    }))controls[id]=[...(controls[id] || []),field];
    for(const id of ['rop-anim-timing-mode','rop-anim-duration','rop-anim-speed','rop-anim-start-x','rop-anim-start-y','rop-anim-end-x','rop-anim-end-y'])
        controls[id]=[...(controls[id] || []),id.slice(4).replaceAll('-','_'),'anim_timing_mode','anim_duration','anim_speed'];
    for(const section of ['title','body','footer'])controls[`rop-${section}-text`]=[section+'_text',section+'_styled_ranges'];
    function fieldsFor(id){
        if(id==='rop-card-reset-all' && context)return [...new Set([...context.panel.container.querySelectorAll('.rop-defaultable')].filter(el=>el.id && el.dataset.default!=null).flatMap(el=>fieldsFor(el.id)))];
        return [...new Set([...(controls[id] || []),String(id || '').replace(/^rop-/,'').replaceAll('-','_')])];
    }
    function match(layers,source,{includeDisabled=false}={}){
        const same=layers.filter(ov=>(includeDisabled || !ov.disabled) && ov.type===source.type);
        const slotted=layers.filter(ov=>(includeDisabled || !ov.disabled) && (ov.type===source.type || (['image','video'].includes(source.type) && ['image','video'].includes(ov.type))));
        for(const key of ['slotKey','_templateOverlayId'])if(source[key]){
            const matches=slotted.filter(ov=>ov[key]===source[key]);
            // A declared slot never falls through to a different slot.
            return matches.length===1?matches[0]:null;
        }
        if(source.name){const named=same.filter(ov=>ov.name===source.name);if(named.length===1)return named[0];if(named.length>1)return null;}
        return same.length===1?same[0]:null;
    }
    function diff(before,after,allowed=null){
        const changes=[];
        function walk(a,b,path){
            if(equal(a,b))return;
            if(a && b && typeof a==='object' && typeof b==='object' && !Array.isArray(a) && !Array.isArray(b)){
                for(const key of new Set([...Object.keys(a),...Object.keys(b)]))walk(a[key],b[key],path.concat(key));
            }else changes.push({path,value:clone(b),remove:b===undefined});
        }
        for(const key of new Set([...Object.keys(before),...Object.keys(after)])){
            if(identity.has(key) || (key.startsWith('_') && !key.startsWith('_preset_')) || (allowed && !allowed.includes(key)))continue;
            if(['image','video'].includes(after.type) && key!=='media_folder_interval' && /^(content|media_folder|media_file|_media|source|original_)/.test(key))continue;
            walk(before[key],after[key],[key]);
        }
        return changes;
    }
    function patch(overlay,changes){
        for(const change of changes){
            if(change.path.some(key=>['__proto__','constructor','prototype'].includes(key)))continue;
            let target=overlay;
            for(const key of change.path.slice(0,-1))target=target[key] ||= {};
            if(change.remove)delete target[change.path.at(-1)];else target[change.path.at(-1)]=clone(change.value);
        }
    }
    function list(task){const rs=win._reelsState;return task===rs?.tasks?.[rs.selectedIdx]?rs.overlayProxy?.overlayMgr?.overlays || task.overlays || []:task.overlays || [];}
    function sourceTask(){const rs=win._reelsState;return rs?.tasks?.[rs.selectedIdx];}
    function selected(){return context?[...context.root._rtoSelectedTasks].filter(task=>context.tasks().includes(task)):[];}
    function isSelectedScope(){return !!context && context.batchEnabled===true && context.scope.value==='selected';}
    function canEditTask(task){return !isSelectedScope() || selected().includes(task);}
    function snapshot(task,overlay,before){const layers=clone(list(task));if(overlay && before){const i=layers.findIndex(ov=>String(ov.id)===String(overlay.id));if(i>=0)layers[i]=clone(before);}return {task,before:layers};}
    function commit(snapshots,tasks,key){
        if(!snapshots.length)return;
        if(context?.transaction){
            const transaction=context.transaction;
            for(const item of snapshots)if(!transaction.snapshots.some(old=>old.task===item.task))transaction.snapshots.push(item.task===transaction.source?{task:item.task,before:transaction.sourceBefore}:item);
            tasks.forEach(task=>transaction.changed.add(task));return;
        }
        const gesture=key && context?`${context.tasks().indexOf(sourceTask())}:${selected().map(task=>context.tasks().indexOf(task)).join(',')}:${key}`:key;
        win.ReelsOverviewEdit?.recordBatch?.(snapshots,gesture);
        context?.refresh(tasks);
        clearTimeout(saveTimer);saveTimer=setTimeout(()=>{saveTimer=null;win._syncTasksToActiveTab?.();win._batchAutoSave?.({skipSync:true});},250);
    }
    function mutation(task,before,after,allowed=null,key='',sourceBeforeList=null,explicit=false){
        if(!isSelectedScope() || sampling || !selected().includes(task))return false;
        let changes=diff(before,after,allowed);
        if(explicit && allowed){
            // A committed value also applies when it already matches the
            // reference task. Mixed targets can still have different values.
            const candidates=diff({},after,allowed);
            // Expand objects so editing one dimension cannot replace another
            // task's entire window or decoration settings.
            const leaves=change=>change.value && typeof change.value==='object' && !Array.isArray(change.value)
                ? Object.entries(change.value).flatMap(([name,value])=>leaves({...change,path:[...change.path,name],value})) : [change];
            for(const change of candidates.flatMap(leaves))if(!changes.some(item=>equal(item.path,change.path)))changes.push(change);
            for(const field of allowed)if(!identity.has(field) && !field.startsWith('_') && after[field]===undefined && !changes.some(item=>item.path[0]===field))changes.push({path:[field],remove:true});
            const axes={
                'rop-x':['x'],'rop-y':['y'],'rop-w':['w'],'rop-h':['h'],
                'rop-media-window-width':['w','h'],'rop-media-window-height':['h'],'rop-media-window-ratio':['h'],
            }[key];
            if(axes)changes=changes.filter(change=>!['media_window','clip_rect'].includes(change.path[0]) || axes.includes(change.path[1]));
            const deco={scale:'decorationScale','center-gap':'centerGap',linecap:'lineCap',flip:'flip'};
            const suffix=key.match(/^rop-(?:scroll-title|title)-deco-(scale|center-gap|linecap|flip)$/)?.[1];
            if(suffix)changes=changes.filter(change=>!change.path[0].endsWith('_deco_parameters') || change.path[1]===deco[suffix]);
            changes=changes.filter(change=>selected().some(target=>{
                const overlay=target===task?before:match(list(target),before);
                return overlay && !equal(change.path.reduce((value,key)=>value?.[key],overlay),change.value);
            }));
        }
        if(!changes.length)return false;
        const snapshots=[],changed=[],targets=selected();let skipped=0;
        for(const target of targets){
            const ov=target===task?after:match(list(target),before);
            if(!ov){skipped++;continue;}
            let targetChanges=changes;
            if(target!==task && changes.some(change=>change.path[0]==='bind_scroll_overlay_id' && change.value)){
                const sourceScroll=list(task).find(layer=>String(layer.id)===String(after.bind_scroll_overlay_id));
                const targetScroll=sourceScroll && match(list(target),sourceScroll);
                if(!targetScroll){skipped++;continue;}
                targetChanges=changes.map(change=>change.path[0]==='bind_scroll_overlay_id'?{...change,value:targetScroll.id}:change);
            }
            if(target===task){snapshots.push(sourceBeforeList?{task:target,before:sourceBeforeList}:snapshot(target,after,before));}
            else{snapshots.push(snapshot(target));const oldX=ov.x || 0,oldY=ov.y || 0,oldW=ov.w || 0,oldH=ov.h || 0;patch(ov,targetChanges);
                if(changes.some(change=>change.path[0]==='media_split_angle') && ['top_half','bottom_half'].includes(ov.media_window_mode))for(const partner of list(target))if(['top_half','bottom_half'].includes(partner.media_window_mode))partner.media_split_angle=ov.media_split_angle;
                if(!['image','video','scroll'].includes(ov.type)){
                    if(['rop-card-x','rop-x'].includes(key))ov.x=(after.x || 0)+(after.w || 0)/2-(ov.w || 0)/2;
                    if(['rop-card-y','rop-y'].includes(key))ov.y=(after.y || 0)+(after.h || 0)/2-(ov.h || 0)/2;
                    if(key==='rop-card-width')ov.x=oldX+(oldW-(ov.w || 0))/2;
                    if(key==='rop-card-height')ov.y=oldY+(oldH-(ov.h || 0))/2;
                }
            }
            target.overlays=list(target);changed.push(target);
        }
        commit(snapshots,changed,key);
        if(context)context.status.textContent=`已调整 ${changed.length} 个任务${skipped?`；${skipped} 个缺少对应层或有多个候选，已跳过`:''}`;
        return true;
    }
    function mutations(task,members,allowed){
        if(!isSelectedScope() || !selected().includes(task))return false;
        const sourceBefore=clone(list(task));
        for(const member of members){const index=sourceBefore.findIndex(ov=>String(ov.id)===String(member.target.object.id));if(index>=0)sourceBefore[index]=clone(member.before);}
        const transaction={source:task,sourceBefore,snapshots:[],changed:new Set()};context.transaction=transaction;
        let changed=false;
        try{for(const member of members)changed=mutation(task,member.before,member.target.object,allowed) || changed;}
        finally{context.transaction=null;}
        if(changed)commit(transaction.snapshots,[...transaction.changed]);return changed;
    }
    function update(){
        if(!context)return;
        const {panel,scope,status,target}=context,source=panel._selectedOv,task=sourceTask();
        context.baseline=clone(source);context.baselineList=clone(list(task || {}));context.baselineOverlay=source;context.lastControl='';
        const choices=list(task || {}),value=source?.id;
        target.replaceChildren(...choices.map((ov,index)=>{const option=win.document.createElement('option');option.value=ov.id;option.textContent=ov.slotLabel || ov.name || `${ov.type} · ${index+1}`;return option;}));
        if(value!=null)target.value=value;
        context.batchToggle.checked=context.batchEnabled;scope.disabled=!context.batchEnabled;
        scope.options[1].textContent=`已选 ${selected().length} 个任务`;
        panel.container.inert=isSelectedScope() && !canEditTask(task);
        const background=win.document.getElementById?.('inspector-tab-background');
        if(background)background.inert=isSelectedScope() && !canEditTask(task);
        if(context.backgroundHint)context.backgroundHint.hidden=!isSelectedScope();
        status.textContent=panel.container.inert?'请先勾选参考任务，再修改设置':isSelectedScope()?`批量已开启：覆层及背景参数将作用于 ${selected().length} 个勾选任务，可撤销`:'当前只修改本任务；勾选任务不会自动开启批量操作';
        mixed();
    }
    function mixed(){
        if(!context)return;
        const {panel}=context,source=panel._selectedOv;
        panel.container.querySelectorAll('[data-rto-mixed]').forEach(el=>el.remove());
        if(!isSelectedScope() || !source)return;
        const matches=selected().map(task=>match(list(task),source)).filter(Boolean);
        for(const input of panel.container.querySelectorAll('input[id],select[id],textarea[id]')){
            const keys=fieldsFor(input.id);
            if(!matches.some(ov=>keys.some(key=>!equal(ov[key],source[key]))))continue;
            // The original panel uses label/control grid pairs. An extra sibling
            // would become another grid cell and shift every following setting.
            let label=input.closest('label');
            const grid=input.closest('.rop-grid');
            if(!label && grid){
                let field=input;
                while(field.parentElement && field.parentElement!==grid)field=field.parentElement;
                if(field.previousElementSibling?.tagName==='LABEL')label=field.previousElementSibling;
            }
            if(!label)continue;
            if(label.querySelector('[data-rto-mixed]'))continue;
            const badge=win.document.createElement('small');badge.dataset.rtoMixed='1';badge.textContent='多个值';badge.title='当前显示参考任务值；修改本项才会统一';badge.style.cssText='display:block;font-size:10px;color:#fbbf24;line-height:1.3;white-space:nowrap';label.appendChild(badge);
        }
    }
    function attach(options){
        detach();context={...options,batchEnabled:false};const doc=win.document,box=doc.createElement('div');box.className='rto-batch-inspector';
        box.style.cssText='padding:10px;display:grid;gap:8px;border-bottom:1px solid #555;background:#292c40;color:#eee;flex-shrink:0';
        box.innerHTML='<label style="display:flex;align-items:center;gap:8px;font-weight:600"><input type="checkbox" data-batch-enabled style="width:auto">启用批量操作（默认关闭）</label><label>调整范围 <select data-scope><option value="current">当前任务</option><option value="selected">已选任务</option></select></label><label>调整覆层 <select data-layer style="max-width:230px"></select></label><small data-status></small>';
        context.hiddenScopes=[...options.panel.container.querySelectorAll('#rop-card-apply-all,#rop-scroll-apply-all')].map(input=>{const label=input.closest('label');const hidden=label?.hidden;if(label)label.hidden=true;return {label,hidden};});
        context.header=box;context.scope=box.querySelector('[data-scope]');context.target=box.querySelector('[data-layer]');context.status=box.querySelector('[data-status]');context.batchToggle=box.querySelector('[data-batch-enabled]');
        context.batchToggle.checked=false;context.scope.value='current';
        context.batchToggle.onchange=()=>{
            context.batchEnabled=context.batchToggle.checked===true;
            context.scope.value=context.batchEnabled?'selected':'current';
            context.serial=(context.serial || 0)+1;update();
        };
        options.host.insertBefore(box,options.panel.container.closest('#reels-col-subtitle'));
        context.scope.onchange=()=>update();
        context.target.onchange=()=>{const ov=list(sourceTask()).find(ov=>String(ov.id)===context.target.value);if(ov){win.reelsInspectorSwitch?.('overlay');context.panel.selectOverlay(ov);}};
        const onEvent=event=>{
            if(!isSelectedScope() || sampling || !options.panel.container.contains(event.target))return;
            const field=event.target.closest?.('input,select,textarea,button');
            let id=field?.dataset?.link || field?.dataset?.target || field?.id;
            if(event.target.closest?.('#rop-autocolor-rules,.rop-autocolor-preset')?.matches?.('#rop-autocolor-rules,.rop-autocolor-preset'))id='rop-autocolor-rules';
            if(!id && field?.matches?.('.rop-reset-transform-btn,.rop-fill-screen-btn,.rop-media-window-align'))id='rop-batch-geometry';
            if(!id?.startsWith('rop-') || ['rop-card-apply-all','rop-scroll-apply-all','rop-card-reset-all'].includes(id))return;
            context.lastControl=id;
            const explicit=['input','change'].includes(event.type) || (event.type==='click' && field.tagName==='BUTTON');
            context.explicitControl=explicit;
            if(['pointerdown','focusin'].includes(event.type)){context.baseline=clone(options.panel._selectedOv);context.baselineList=clone(list(sourceTask()));context.baselineOverlay=options.panel._selectedOv;return;}
            const overlay=options.panel._selectedOv,task=sourceTask();if(!overlay || !canEditTask(task))return;
            const before=clone(overlay),sourceBeforeList=clone(list(task)),allowed=id==='rop-batch-geometry'?['x','y','w','h','scale','scale_x','scale_y','rotation','opacity','media_window','clip_rect','crop_fill']:fieldsFor(id);
            const serial=context.serial=(context.serial || 0)+1;
            queueMicrotask(()=>{if(context?.panel!==options.panel || overlay!==options.panel._selectedOv || context.serial!==serial)return;mutation(task,before,overlay,allowed,id,sourceBeforeList,explicit);context.explicitControl=false;context.baselineList=clone(list(task));context.baseline=clone(overlay);context.baselineOverlay=overlay;mixed();});
        };
        context.onEvent=onEvent;for(const type of ['input','change','click','pointerdown','focusin'])options.root.addEventListener(type,onEvent,true);
        const backgroundFields={'reels-bg-scale':'bgScale','reels-bg-rotate':'bgRotation','reels-bg-x':'bgX','reels-bg-y':'bgY','reels-bg-fliph':'bgFlipH','reels-bg-flipv':'bgFlipV','reels-bg-volume':'bgVideoVolume','reels-bg-dur-scale':'bgDurScale','reels-bg-transition':'bgTransition','reels-bg-transdur':'bgTransDur','reels-bg-cliporder':'bgClipOrder'};
        const background=doc.getElementById?.('inspector-tab-background');
        if(background){const hint=doc.createElement('p');hint.style.cssText='color:#fbbf24;font-size:11px;line-height:1.5';hint.textContent='批量支持背景缩放、旋转、位置、翻转、音量、时长、组合方式及转场。素材、模式和其他设置仍仅修改当前任务。';background.prepend(hint);context.backgroundHint=hint;}
        context.onBackground=event=>{
            if(!isSelectedScope() || !canEditTask(sourceTask()))return;
            const field=event.target.closest?.('input,select,button');if(!field)return;
            let id=field.id?.replace(/-(range|num|ui)$/,'');
            if(field.tagName==='BUTTON')id=field.getAttribute('onclick')?.match(/reelsResetParamUI\('(reels-bg-[^']+)'/)?.[1];
            const key=backgroundFields[id];if(!key || !(['input','change'].includes(event.type) || event.type==='click' && field.tagName==='BUTTON'))return;
            const task=sourceTask(),targets=selected(),before=targets.map(target=>({task:target,key,had:Object.hasOwn(target,key),value:clone(target[key])})),owner=context;
            queueMicrotask(()=>{
                if(context!==owner || !isSelectedScope() || sourceTask()!==task)return;
                const had=Object.hasOwn(task,key),value=clone(task[key]);
                const changed=before.filter(item=>item.had!==had || !equal(item.value,value));
                if(!changed.length)return;
                for(const item of changed){if(had)item.task[key]=clone(value);else delete item.task[key];}
                win.ReelsOverviewEdit?.recordBackgroundBatch?.(changed,`background:${key}:${targets.map(t=>context.tasks().indexOf(t)).join(',')}`);
                context.refresh(changed.map(item=>item.task));
                for(const item of changed)win.dispatchEvent(new CustomEvent('reels-task-media-changed',{detail:item.task}));
                clearTimeout(saveTimer);saveTimer=setTimeout(()=>{saveTimer=null;win._syncTasksToActiveTab?.();win._batchAutoSave?.({skipSync:true});},250);
            });
        };
        for(const type of ['input','change','click'])background?.addEventListener(type,context.onBackground,true);
        context.onSelection=event=>{if(event.detail?.panel===options.panel)update();};win.addEventListener('reels-overlay-selection-changed',context.onSelection);
        update();
    }
    function detach(){
        if(!context)return;
        if(saveTimer){clearTimeout(saveTimer);saveTimer=null;win._syncTasksToActiveTab?.();win._batchAutoSave?.({skipSync:true});}
        const old=context;context=null;old.panel.container.inert=false;
        const background=win.document.getElementById?.('inspector-tab-background');if(background){background.inert=false;for(const type of ['input','change','click'])background.removeEventListener(type,old.onBackground,true);}
        old.backgroundHint?.remove();
        old.hiddenScopes?.forEach(({label,hidden})=>{if(label)label.hidden=hidden;});
        old.header.remove();old.panel.container.querySelectorAll('[data-rto-mixed]').forEach(el=>el.remove());
        for(const type of ['input','change','click','pointerdown','focusin'])old.root.removeEventListener(type,old.onEvent,true);
        win.removeEventListener('reels-overlay-selection-changed',old.onSelection);
    }
    function modelChanged(panel,overlay){
        if(!isSelectedScope() || sampling || context.panel!==panel || overlay!==panel._selectedOv || context.isDragging?.(sourceTask()))return;
        if(context.baselineOverlay===overlay && context.baseline && context.lastControl){
            if(mutation(sourceTask(),context.baseline,overlay,fieldsFor(context.lastControl),context.lastControl,context.baselineList,context.explicitControl))context.serial=(context.serial || 0)+1;
        }
        context.explicitControl=false;
        context.baseline=clone(overlay);context.baselineList=clone(list(sourceTask()));context.baselineOverlay=overlay;
    }
    function fieldsChanged(panel,overlay,before,fields){
        if(!isSelectedScope() || sampling || context.panel!==panel || overlay!==panel._selectedOv)return false;
        const changed=mutation(sourceTask(),before,overlay,fields,'inspector-popup',null,true);
        context.serial=(context.serial || 0)+1;
        context.baseline=clone(overlay);context.baselineList=clone(list(sourceTask()));context.baselineOverlay=overlay;
        context.lastControl='';context.explicitControl=false;mixed();return changed;
    }
    function beginControl(panel,id){
        if(!isSelectedScope() || sampling || context.panel!==panel)return;
        context.baseline=clone(panel._selectedOv);context.baselineList=clone(list(sourceTask()));context.baselineOverlay=panel._selectedOv;
        context.lastControl=id;context.explicitControl=true;
    }
    function alignSelected(panel,align){
        if(!isSelectedScope() || context.panel!==panel)return false;
        const source=panel._selectedOv,task=sourceTask();
        if(!source || !canEditTask(task)){win.showToast?.('请勾选参考任务并选择对应画中画媒体层','warning');return true;}
        if(context.paletteBusy){win.showToast?.('正在分配色板，请稍后定位','warning');return true;}
        if(!win.ReelsMediaWindow?.alignWindow){win.showToast?.('定位组件需要刷新，请保存后刷新界面再试','warning');return true;}
        const snapshots=[],changed=[];let skipped=0;
        for(const target of selected()){
            const ov=target===task?source:match(list(target),source);
            const values=win.ReelsMediaWindow.alignWindow(ov,align);
            if(!values){skipped++;continue;}
            if(Object.keys(values).every(key=>equal(ov[key],values[key])))continue;
            snapshots.push(snapshot(target));Object.assign(ov,values);target.overlays=list(target);changed.push(target);
        }
        context.serial=(context.serial || 0)+1;
        panel._syncFromOverlay(source);commit(snapshots,changed);update();
        context.status.textContent=`已定位 ${changed.length} 个任务${skipped?`；跳过 ${skipped} 个无对应画中画窗口的任务`:''}，可撤销`;
        win.showToast?.(changed.length?context.status.textContent:skipped?'未找到可定位的对应画中画窗口，请检查层位和窗口模式':'所选窗口已经位于该位置',changed.length?'success':skipped?'warning':'info');
        return true;
    }
    function deleteSelected(panel){
        if(!isSelectedScope() || context.panel!==panel)return false;
        const source=panel._selectedOv,task=sourceTask();
        if(!source || !canEditTask(task)){win.showToast?.('请勾选参考任务，并选择要删除的层','warning');return true;}
        const targets=selected().map(target=>({task:target,overlay:target===task?source:match(list(target),source,{includeDisabled:true})})).filter(item=>item.overlay);
        const label=source.slotLabel || source.name || source.slotKey || '当前覆层';
        if(!targets.length)return true;
        if(!win.confirm(`从 ${targets.length} 个已选任务中删除「${label}」？\n只删除各任务的对应层，其他层保留；可在总览中撤销。`))return true;
        const snapshots=targets.map(item=>snapshot(item.task));
        for(const item of targets){const layers=list(item.task),index=layers.indexOf(item.overlay);if(index>=0)layers.splice(index,1);item.task.overlays=layers;}
        context.serial=(context.serial || 0)+1;
        panel.deselectOverlay?.();panel._selectedOv=null;panel._refreshList?.();
        commit(snapshots,targets.map(item=>item.task));update();
        win.showToast?.(`已删除 ${targets.length} 个任务的对应层，可撤销`,'success');return true;
    }
    function samplePalette(panel,overlay,id,options){
        const scratch=clone(overlay),keys=new Set();let tracking=false,syncing=false;
        const saved={overlay:panel._selectedOv,canvas:panel.videoCanvas,val:panel._val,sync:panel._syncToOverlay,get:panel._get};
        const proxy=new Proxy(scratch,{set(obj,key,value){if(tracking && !syncing)keys.add(key);obj[key]=value;return true;},deleteProperty(obj,key){if(tracking && !syncing)keys.add(key);delete obj[key];return true;}});
        sampling=true;
        try{
            const scratchManager={overlays:[proxy],getOverlay:id=>id===proxy.id?proxy:null,requestRender(){},addOverlay(){throw new Error('配色预设不能新增覆层');},removeOverlay(){throw new Error('配色预设不能删除覆层');}};
            panel._selectedOv=proxy;panel.videoCanvas={overlayMgr:scratchManager,scopedTask:{overlays:[proxy]},getTaskGroupTasks:()=>[],getOrderedOverlays:()=>[proxy],render(){},onOverlayChange(){},addOverlay:scratchManager.addOverlay,removeOverlay:scratchManager.removeOverlay};
            panel._val=function(id,value){if(tracking && !syncing)fieldsFor(id).forEach(key=>keys.add(key));return saved.val.call(this,id,value);};
            // A palette samples only its explicit style writes. Running the full
            // inspector writeback here can publish scratch layers into live tasks.
            panel._syncToOverlay=function(){};
            // Read this target directly instead of rebuilding hundreds of inspector controls.
            panel._get=function(id){const key=fieldsFor(id)[0];return scratch[key];};
            tracking=true;panel._applyTitleColorScheme(id,options);
            return diff(overlay,scratch,[...keys]);
        }finally{
            if(panel._overlayChangeRaf){win.cancelAnimationFrame(panel._overlayChangeRaf);panel._overlayChangeRaf=null;}
            panel._selectedOv=saved.overlay;panel.videoCanvas=saved.canvas;panel._val=saved.val;panel._syncToOverlay=saved.sync;panel._get=saved.get;sampling=false;
        }
    }
    function palettePercentages(ids,percentages={}){
        ids=[...new Set(ids)];const weights={};let fixed=0,auto=0;
        for(const id of ids){
            const value=Object.hasOwn(percentages,id)?percentages[id]:null;
            if(value===null || value===undefined || value===''){auto++;continue;}
            const n=Number(value);if(!Number.isFinite(n) || n<0 || n>100)throw new Error('固定比例请输入 0–100%，留空表示自动');
            weights[id]=n;fixed+=n;
        }
        if(fixed>100+1e-8)throw new Error(`固定比例合计 ${Number(fixed.toFixed(2))}%，超过 100%，请调低部分比例`);
        if(!auto && Math.abs(fixed-100)>1e-8)throw new Error(`还剩 ${Number((100-fixed).toFixed(2))}% 未分配，请将一个色板留空自动，或把比例补足 100%`);
        const remainder=Math.max(0,100-fixed);
        for(const id of ids)if(!Object.hasOwn(weights,id))weights[id]=auto?remainder/auto:0;
        return weights;
    }
    const distributionWeights=(ids,options)=>Object.hasOwn(options,'percentages')?palettePercentages(ids,options.percentages):options.weights;
    function paletteDistribution(ids,total,weights={}){
        ids=[...new Set(ids)];
        const rows=ids.map(id=>({id,weight:Object.hasOwn(weights,id)?Number(weights[id]):1}));
        if(rows.some(row=>!Number.isFinite(row.weight) || row.weight<0))throw new Error('色板权重请输入大于或等于 0 的数字');
        const max=Math.max(0,...rows.map(row=>row.weight));
        if(!max)throw new Error('至少一个已选色板的权重需要大于 0');
        const sum=rows.reduce((sum,row)=>sum+row.weight/max,0);
        for(const row of rows){row.share=(row.weight/max)/sum;row.count=Math.floor(total*row.share);row.remainder=total*row.share-row.count;}
        let remaining=total-rows.reduce((sum,row)=>sum+row.count,0);
        for(const row of [...rows].filter(row=>row.weight>0).sort((a,b)=>b.remainder-a.remainder))if(remaining-->0)row.count++;
        return rows;
    }
    function paletteBag(rows,total){
        const used=rows.map(()=>0),bag=[];
        for(let index=0;index<total;index++){
            let best=-1,score=-Infinity;
            rows.forEach((row,i)=>{if(used[i]>=row.count)return;const deficit=row.count*(index+1)/total-used[i];if(deficit>score){score=deficit;best=i;}});
            if(best<0)break;used[best]++;bag.push(rows[best].id);
        }
        return bag;
    }
    async function confirmPalettes(panel,ids,mode='random',options={}){
        if(!isSelectedScope() || context.panel!==panel){win.showToast?.('请先启用批量操作','warning');return false;}
        const source=panel._selectedOv;
        if(!source || source.type!=='textcard' || !canEditTask(sourceTask())){win.showToast?.('请勾选参考任务并选中文字卡片','warning');return false;}
        const schemes=panel._getTitleColorSchemes();ids=[...new Set(ids)].filter(id=>schemes[id]);
        if(!ids.length){win.showToast?.('请先选择色板','warning');return false;}
        const tasks=selected(),count=tasks.filter(task=>task===sourceTask() || match(list(task),source)).length;
        if(!count){win.showToast?.('选中任务中没有对应文字卡片','warning');return false;}
        let allocation;
        try{allocation=paletteDistribution(ids,count,distributionWeights(ids,options));}catch(error){win.showToast?.(error.message,'warning');return false;}
        const ratios=allocation.map(row=>`${schemes[row.id].name || row.id}：${(row.share*100).toFixed(1)}%（${row.count} 个任务）`).join('\n');
        const label=source.slotLabel || source.name || source.slotKey || '当前文字卡片';
        const details=[options.onlyColor?'仅应用颜色':options.onlyFont?'仅应用字体':'应用配色样式',options.ignoreBackground?'忽略背景':'',options.applyFontSize?'包含预设字号':'保留现有字号'].filter(Boolean).join('；');
        if(!win.confirm(`确认批量分配配色？\n\n任务：${count} 个（跳过 ${tasks.length-count} 个无对应层的任务）\n图层：${label}\n色板：${ids.length} 套\n方式：${mode==='cycle'?'按比例循环':'按比例随机分配'}\n比例与预计数量：\n${ratios}\n设置：${details}\n\n确认后才会修改，可在总览中撤销。`))return false;
        return assignPalettes(panel,ids,mode,options);
    }
    async function assignPalettes(panel,ids,mode='random',options={}){
        if(!isSelectedScope() || sampling || context.panel!==panel)return false;
        if(context.paletteBusy){win.showToast?.('正在分配色板，请稍候','warning');return false;}
        const source=panel._selectedOv,task=sourceTask();
        if(!source || source.type!=='textcard' || !canEditTask(task)){win.showToast?.('请勾选参考任务并选中文字卡片','warning');return true;}
        const schemes=panel._getTitleColorSchemes();ids=[...new Set(ids)].filter(id=>schemes[id]);
        if(!ids.length){win.showToast?.('请先勾选要分配的色板','warning');return true;}
        if(context.paletteBefore?.id===source.id && win.document.querySelector('.rop-title-palette-popover')){for(const key of Object.keys(source))if(!Object.hasOwn(context.paletteBefore,key))delete source[key];Object.assign(source,context.paletteBefore);context.paletteBefore=null;}
        const allTargets=selected(),targets=allTargets.map(task=>({task,overlay:task===sourceTask()?source:match(list(task),source)})).filter(item=>item.overlay),snapshots=[],changed=[];const skipped=allTargets.length-targets.length;
        let allocation;
        try{allocation=paletteDistribution(ids,targets.length,distributionWeights(ids,options));}catch(error){win.showToast?.(error.message,'warning');return false;}
        // Exact integer quotas, then spread or shuffle them without changing counts.
        const bag=paletteBag(allocation,targets.length);
        if(mode==='random')for(let i=bag.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[bag[i],bag[j]]=[bag[j],bag[i]];}
        const owner=context,cache=new Map(),getSchemes=panel._getTitleColorSchemes,wasInert=panel.container.inert;
        owner.paletteBusy=true;panel.container.inert=true;panel._getTitleColorSchemes=()=>schemes;
        const progress=done=>{if(context===owner)owner.status.textContent=`正在分配配色 ${done} / ${targets.length}…`;options.onProgress?.(done,targets.length);};
        const yieldUI=()=>new Promise(resolve=>win.setTimeout(resolve,0));
        const assertActive=()=>{if(context!==owner || !isSelectedScope() || panel._selectedOv!==source || sourceTask()!==task || targets.some(item=>!owner.tasks().includes(item.task)))throw new Error('任务或批量范围已变化，请重新分配');};
        try{
            progress(0);await yieldUI();assertActive();
            for(let index=0;index<targets.length;index++){
                const {task:target,overlay:ov}=targets[index];
                // Cache only identical starting styles. Text and layout stay task-specific.
                const style=Object.fromEntries(Object.entries(ov).filter(([key])=>(key.startsWith('title_') && !['title_text','title_styled_ranges'].includes(key)) || key==='_preset_border'));
                const signature=JSON.stringify([bag[index],style]);
                let changes=cache.get(signature);
                if(!changes){changes=samplePalette(panel,ov,bag[index],options);cache.set(signature,changes);}
                if(changes.length){snapshots.push(snapshot(target));patch(ov,changes);target.overlays=list(target);changed.push(target);}
                if((index+1)%8===0){progress(index+1);await yieldUI();assertActive();}
            }
            progress(targets.length);
        }catch(error){for(const item of snapshots){const layers=list(item.task);layers.splice(0,layers.length,...clone(item.before));item.task.overlays=layers;}win.showToast?.('色板分配失败，已恢复：'+error.message,'error');return false;}
        finally{panel._getTitleColorSchemes=getSchemes;owner.paletteBusy=false;panel.container.inert=wasInert;if(context===owner){const current=list(task).find(ov=>ov.id===source.id);if(current){panel._selectedOv=current;panel._syncFromOverlay(current);}}}
        commit(snapshots,changed);update();win.showToast?.(`已分配到 ${changed.length} 个任务${skipped?`，跳过 ${skipped} 个无对应层的任务`:''}`,'success');return true;
    }
    return {palettePercentages,paletteDistribution,paletteBag,match,diff,patch,fieldsFor,attach,detach,update,mixed,mutation,mutations,assignPalettes,confirmPalettes,
        modelChanged,fieldsChanged,beginControl,alignSelected,deleteSelected,isActive:()=>!!context,isSelectedScope,canEditTask,isSampling:()=>sampling,
        setSelectedScope(){if(context){context.batchEnabled=true;context.scope.value='selected';update();}},
        paletteOpened(panel){if(context?.panel===panel)context.paletteBefore=clone(panel._selectedOv);}
    };
});
