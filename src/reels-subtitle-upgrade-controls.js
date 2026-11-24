/** Optional subtitle effects; shares the native scope, history and preset flow. */
(() => {
    const animations = {
        box_wipe: '背景条逐行擦除',
        three_word_focus_stack: '三词叠排（中词放大）',
        rolling_rainbow_karaoke: '四行彩虹跟读',
        kinetic_glow_stack: '黄绿辉光叠排',
        zoom_typewriter: '远景打字推进',
        line_focus: '双行焦点放大',
        underline_sweep: '底线扫描显字',
        char_float_up: '逐字上浮',
        char_pop_elastic: '逐字弹性放大',
        char_wave: '逐字波浪',
        char_drop_bounce: '逐字下落弹跳',
        char_squash_bounce: '逐字挤压弹跳',
        char_center_spread: '逐字中心展开'
    };
    // [key, label, input type, fallback, options/min/max/step]
    const groups = [
        ['文字显示', [
            ['uppercase','AA 全大写（不修改原文）','checkbox',false],
            ['synthetic_bold_enabled','缺少粗体字重时补粗','checkbox',false]
        ]],
        ['连体背景与逐行擦除', [
            ['box_connected','连体轮廓（需启用底框及贴合行宽）','checkbox',true],
            ['box_concave_radius','内凹圆角（空白跟随外圆角）','number',null,0,40,1],
            ['box_snap_threshold','相邻行宽度吸附容差','number',18,0,80,1],
            ['box_wipe_enabled','背景条逐行进度擦除','checkbox',false],
            ['box_brush_style','字幕底框样式','select','rect',{rect:'普通底框',bottom_gold_bar:'鎏金半高底条',bottom_rose_brush:'玫瑰手绘底条',bottom_neon_marker:'荧光马克笔底条',xmas_candy_ribbon:'圣诞拐杖糖字幕带',xmas_velvet_gold:'圣诞红丝绒烫金带',xmas_pine_snow:'圣诞松林覆雪带',xmas_gingerbread_tag:'圣诞姜饼糖霜签'}],
            ['box_brush_color_mode','底框颜色模式','select','tint',{tint:'跟随底框颜色',original:'保留原色',original_nobg:'原图去底色'}]
        ]],
        ['朗读高亮与放大', [
            ['highlight_enabled','允许朗读高亮（配合原有高亮开关）','checkbox',true],
            ['highlight_scale_enabled','朗读当前词放大','checkbox',false],
            ['highlight_scale','当前词大小 %','number',125,50,300,5],
            ['highlight_push_apart','放大时推开相邻词','checkbox',true],
            ['highlight_include_punctuation','词尾标点一同高亮','checkbox',false],
            ['hide_until_spoken','未读文字降低透明度','checkbox',false],
            ['unread_opacity','未读文字可见度 %','number',0,0,100,5],
            ['active_line_focus_enabled','朗读行放大，其余行缩小','checkbox',false],
            ['inactive_line_scale','非朗读行大小倍率','number',.62,.1,1,.05]
        ]],
        ['渐变与换行排版', [
            ['text_gradient_scope','文字渐变范围','select','line',{line:'整行',word:'每个单词'}],
            ['high_gradient_scope','高亮渐变范围','select','word',{line:'整行',word:'每个单词'}],
            ['text_align','文字对齐','select','center',{center:'居中',left:'左对齐',right:'右对齐',smart_left_center:'智能左对齐居中'}],
            ['balanced_two_line_wrap','短句双行均衡排版','checkbox',false],
            ['max_words_per_segment','每屏最多词数（0 不限制）','number',0,0,50,1],
            ['max_words_per_line','每行最多词数（0 不限制）','number',0,0,30,1],
            ['mixed_layout','动态混合排版','select','none',{none:'关闭',cycle:'自动混合',stack:'叠排',focus:'焦点',collage:'拼贴',stairs:'阶梯'}]
        ]],
        ['描边与辉光扩展（配合原有扩展描边）', [
            ['effect_controls_enabled','扩展描边的独立辉光控制','checkbox',false],
            ['effect_inner_outline_width','内描边宽度','number',5,0,40,1],
            ['effect_glow_range','辉光范围','number',22,0,100,1],
            ['effect_glow_blur','辉光模糊','number',18,0,100,1],
            ['effect_glow_opacity','辉光不透明度 %','number',70,0,100,5]
        ]],
        ['新增动画参数', [
            ['char_anim_duration','逐字动画时长（秒）','number',.28,.04,3,.02],
            ['char_anim_stagger','逐字间隔（秒）','number',.04,0,.5,.01],
            ['char_anim_intensity','逐字动画强度','number',1,.1,3,.1],
            ['three_word_hero_scale','三词叠排中词放大倍率','number',1.92,1,4,.1],
            ['rolling_rainbow_colors','彩虹跟读颜色（逗号分隔）','text','#FF3824,#FF8800,#FFD600,#2AD648,#00C2D1,#246BFF,#9B4DFF'],
            ['kinetic_group_words','辉光叠排每组词数','number',3,1,12,1],
            ['kinetic_scale_min','辉光叠排最小字号倍率','number',.66,.1,3,.05],
            ['kinetic_scale_max','辉光叠排最大字号倍率','number',1.9,.1,4,.05],
            ['kinetic_line_gap','辉光叠排行间距','number',.14,0,1,.02],
            ['kinetic_pop_duration','辉光叠排弹入时间（秒）','number',.16,.04,2,.02],
            ['kinetic_old_word_opacity','已读词不透明度','number',.92,0,1,.05],
            ['kinetic_old_glow_opacity','已读词辉光强度','number',.78,0,1,.05],
            ['kinetic_glow_color','叠排辉光颜色','color','#E7FF00'],
            ['kinetic_glow_blur','叠排辉光模糊','number',64,0,150,1],
            ['kinetic_background_dim','叠排背景压暗','number',.52,0,1,.05],
            ['kinetic_tint_opacity','叠排背景染色','number',.26,0,1,.05],
            ['kinetic_vignette_strength','叠排暗角强度','number',.96,0,1,.05],
            ['kinetic_vignette_radius','叠排暗角半径','number',.62,.1,1,.05],
            ['kinetic_spotlight_opacity','叠排聚光强度','number',.42,0,1,.05]
        ]]
    ];
    const fields = [['subtitle_upgrade_enabled','启用字幕增强','checkbox',false], ...groups.flatMap(([,fields])=>fields)];
    const inputFor = key => document.getElementById('reels-upgrade-'+key);
    function read() {
        const values=Object.fromEntries(fields.map(([key,,type,fallback])=>{
            const input=inputFor(key);
            const number=input ? Number(input.value) : NaN;
            return [key, !input ? fallback : type==='checkbox' ? input.checked : type==='number' ? (key==='box_concave_radius' && input.value==='' ? null : Number.isFinite(number) ? number : fallback) : input.value];
        }));
        return {...values,text_transform:values.uppercase?'uppercase':'none'};
    }
    function restore(style={}) {
        for(const [key,,type,fallback] of fields) {
            const input=inputFor(key);if(!input)continue;
            if(type==='checkbox')input.checked=key==='uppercase' ? style.uppercase===true || ((style.subtitle_upgrade_enabled || animations[style.anim_in_type]) && style.text_transform==='uppercase') : style[key]??fallback;
            else {
                const value=style[key]??fallback;
                if(type==='select' && !Array.from(input.options).some(option=>option.value===String(value))) input.add(new Option('原有样式：'+value,value));
                input.value=value;
            }
        }
        updateAvailability();
    }
    function updateAvailability() {
        const enabled=!!inputFor('subtitle_upgrade_enabled')?.checked || !!animations[document.getElementById('reels-anim-in')?.value];
        for(const [key] of fields)if(!['subtitle_upgrade_enabled','uppercase','synthetic_bold_enabled'].includes(key) && inputFor(key))inputFor(key).disabled=!enabled;
    }
    function makeField([key,label,type,fallback,options,max,step]) {
        const row=document.createElement('label');
        row.style.cssText='display:flex;align-items:center;justify-content:space-between;gap:8px;margin:7px 0;font-size:12px;';
        const caption=document.createElement('span');caption.textContent=label;
        const input=document.createElement(type==='select'?'select':'input');
        input.id='reels-upgrade-'+key;input.className=type==='select'?'select':'input';
        input.style.cssText='max-width:145px;min-width:0;'+(type==='checkbox'?'':'width:120px;');
        if(type==='select')for(const [value,text] of Object.entries(options))input.add(new Option(text,value));
        else input.type=type;
        if(type==='number'){input.min=options;input.max=max;input.step=step;}
        if(type==='checkbox')input.checked=fallback;else input.value=fallback;
        input.addEventListener('change',()=>{updateAvailability();window.reelsUpdatePreview?.();});
        row.append(caption,input);return row;
    }
    document.addEventListener('DOMContentLoaded',()=>{
        const anim=document.getElementById('reels-anim-in');if(!anim)return;
        const options=document.createElement('optgroup');options.label='新增字幕效果';
        for(const [id,label] of Object.entries(animations))options.append(new Option(label,id));
        anim.append(options);anim.addEventListener('change',updateAvailability);
        const panel=document.createElement('details');panel.id='reels-subtitle-upgrade-controls';
        panel.style.cssText='margin:10px 0;padding:10px;border:1px solid var(--border-color,#444);border-radius:6px;';
        const title=document.createElement('summary');title.textContent='字幕增强（新增效果与排版）';title.style.cursor='pointer';panel.append(title);
        const hint=document.createElement('p');hint.style.cssText='font-size:12px;line-height:1.6;opacity:.75;';
        hint.textContent='新增动画在“入场动画”中选择，可直接使用。普通字幕需勾选增强；全大写和补粗可独立使用。未启用时保持原有效果。颜色、字体、描边及样式作用范围沿用现有设置。';panel.append(hint,makeField(fields[0]));
        for(const [name,entries] of groups){const section=document.createElement('details');const heading=document.createElement('summary');heading.textContent=name;heading.style.cssText='cursor:pointer;font-size:12px;margin-top:10px;';section.append(heading);for(const field of entries)section.append(makeField(field));panel.append(section);}
        const target=document.getElementById('reels-anim-param-container');
        if(target)target.after(panel);else anim.parentElement.after(panel);
        updateAvailability();
    });
    window.ReelsSubtitleUpgradeControls={read,restore,animations};
})();
