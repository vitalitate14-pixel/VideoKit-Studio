/* Stable business identities for overlays.  A slot identifies what a layer
 * means in a batch; the overlay's `type` still describes how it is drawn. */
(function (root) {
    'use strict';
    const PRESETS = Object.freeze([
        { key: 'script', label: '文案层', description: '标题、正文、结尾共用一个文案槽位' },
        { key: 'media', label: '媒体层', description: '通用图片、视频或 GIF 媒体槽位' },
        { key: 'phone_cta', label: '电话邀约层', description: '电话邀约文字卡片或图片' },
        { key: 'particle', label: '粒子层', description: '粒子、暗角与电影颗粒覆层' },
        { key: 'scroll_subtitle', label: '滚动字幕层', description: '独立的滚动字幕覆层' },
        { key: 'title', label: '仅标题层', description: '单独标题文字卡片' },
        { key: 'gif', label: 'GIF 动态层', description: '动态效果素材槽位' },
        { key: 'watermark', label: '水印层', description: '固定水印、台标或角标' },
        { key: 'background_layer', label: '背景层', description: '覆层体系中的背景画面层' },
        { key: 'pip_sermon', label: '画中画（讲道）', description: '讲道画中画内容' },
        { key: 'pip_audience', label: '画中画（观众）', description: '观众画中画内容' },
        { key: 'pip_audience_main', label: '画中画（主观众）', description: '主观众画中画，面积仅次于讲道' },
        { key: 'pip_primary', label: '画中画主层', description: '主画中画' },
        { key: 'pip_secondary', label: '画中画次层', description: '次画中画' },
        { key: 'pip_general', label: '通用画中画层', description: '备用/通用画中画' },
        { key: 'phone_primary', label: '电话主层', description: '主电话素材' },
        { key: 'phone_secondary', label: '电话次层', description: '次电话素材' },
        { key: 'phone_general', label: '通用电话层', description: '备用/通用电话素材' },
    ]);
    const byKey = new Map(PRESETS.map(item => [item.key, item]));
    const AUTO_NUMBERED = new Set(['script', 'media', 'scroll_subtitle', 'title', 'gif', 'particle', 'phone_cta', 'pip_audience']);
    const ALL_PRESET_KEYS = new Set(PRESETS.map(item => item.key));
    const normalize = value => String(value || '').trim().replace(/\s+/g, ' ');
    const customKey = name => `custom:${normalize(name).toLowerCase()}`;
    function describe(key, fallbackLabel = '') {
        const item = byKey.get(String(key || ''));
        if (item) return item;
        const numbered = String(key || '').match(/^(.+?)_(\d+)$/);
        if (numbered && ALL_PRESET_KEYS.has(numbered[1])) {
            const base = byKey.get(numbered[1]);
            return { key: String(key), label: `${base?.label || numbered[1]} ${numbered[2]}`, autoNumbered: true };
        }
        const custom = String(key || '').startsWith('custom:') ? String(key).slice(7) : '';
        return { key: String(key || ''), label: normalize(fallbackLabel) || custom || '未分类层', custom: true };
    }
    function apply(overlay, key, customLabel = '') {
        if (!overlay || !key) return overlay;
        const info = describe(key, customLabel);
        overlay.slotKey = info.key;
        overlay.slotLabel = normalize(customLabel) || info.label;
        // The label is intentionally not forced into `name`: users can still
        // name files/layers freely while the stable slot remains immutable.
        return overlay;
    }
    function nextKey(overlays, baseKey, exclude = null) {
        const matcher = new RegExp(`^${baseKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_(\\d+)$`);
        const highest = (overlays || []).reduce((max, item) => {
            if (!item || item === exclude) return max;
            const found = String(item.slotKey || '').match(matcher);
            return found ? Math.max(max, Number(found[1])) : max;
        }, 0);
        return `${baseKey}_${highest + 1}`;
    }
    function makeKey(overlays, baseKey, numbered = false, exclude = null) {
        return numbered ? nextKey(overlays, baseKey, exclude) : baseKey;
    }
    function applyUnique(overlay,key,overlays=[],label=''){
        if(key==='pip_audience'){
            // The first audience layer is number 1 too. Upgrade an older bare
            // slot before adding its next sibling, rather than leaving it bare.
            for(const item of overlays)if(item && item!==overlay && item.slotKey==='pip_audience')ensureDefault(item,overlays);
            key=nextKey(overlays,key,overlay);
            if(!label || normalize(label)===byKey.get('pip_audience').label)label=describe(key).label;
        }
        if(/^pip_audience_\d+$/.test(key) && normalize(label)===byKey.get('pip_audience').label)label=describe(key).label;
        const occupied=new Set(overlays.filter(item=>item && item!==overlay).map(item=>item.slotKey));
        if(!occupied.has(key))return apply(overlay,key,label);
        const numbered=String(key).match(/^(.+?)_(\d+)$/);
        const base=numbered && (ALL_PRESET_KEYS.has(numbered[1]) || numbered[1].startsWith('custom:'))?numbered[1]:key;
        let candidate=nextKey(overlays,base,overlay);
        if(candidate===`${base}_1` && occupied.has(base))candidate=`${base}_2`;
        const number=candidate.slice(base.length+1);
        const originalLabel=normalize(label || describe(base).label);
        const baseLabel=ALL_PRESET_KEYS.has(base)?describe(base).label:(numbered?originalLabel.replace(/\s+\d+$/,''):originalLabel);
        return apply(overlay,candidate,`${baseLabel} ${number}`);
    }
    // Legacy templates do not have slotKey.  Their visual type is an
    // unambiguous default, so populate it on first open.  An explicit empty
    // slotKey is respected as the user's intentional “未分类” choice.
    function ensureDefault(overlay, overlays = []) {
        if (!overlay) return false;
        // An explicit empty value remains an intentional opt-out.  Earlier
        // development builds wrote bare `media`/`script`; upgrade those to
        // the numbered identities so multiple legacy layers never share one
        // batch column.
        const existing = overlay.slotKey;
        // Early CTA layers inherited the generic add-menu classification.
        // Correct generated text/media labels while preserving custom slots and names.
        const legacyPhoneSlot = /^(script|media|gif)(?:_\d+)?$/.test(String(existing || ''));
        const generatedPhoneLabel = !normalize(overlay.slotLabel)
            || /^(文案层|媒体层|GIF 动态层)(?:\s*\d+)?$/.test(normalize(overlay.slotLabel));
        if (overlay.is_phone_cta && legacyPhoneSlot && generatedPhoneLabel) {
            apply(overlay, nextKey(overlays, 'phone_cta', overlay));
            return true;
        }
        const audienceNumber=String(existing || '').match(/^pip_audience_(\d+)$/);
        // Older tasks also labelled secondary/general/media slots as audience.
        // Number those names too while preserving their original slot identity.
        const audienceLabel=normalize(overlay.slotLabel).match(/^画中画（观众）(?:\s+(\d+))?$/);
        if(existing && existing!=='pip_audience' && !audienceNumber && audienceLabel){
            const index=overlays.indexOf(overlay),occupied=new Set();
            for(const [i,item] of overlays.entries()){
                if(!item || item===overlay)continue;
                const keyNumber=String(item.slotKey || '').match(/^pip_audience_(\d+)$/);
                const labelNumber=normalize(item.slotLabel).match(/^画中画（观众）\s+(\d+)$/);
                if(keyNumber)occupied.add(Number(keyNumber[1]));
                if(labelNumber && (!audienceLabel[1] || i<index || keyNumber || labelNumber[1]!==audienceLabel[1]))occupied.add(Number(labelNumber[1]));
            }
            let number=Number(audienceLabel[1]) || 1;
            if(!audienceLabel[1] || occupied.has(number)){number=1;while(occupied.has(number))number++;}
            const label=`画中画（观众） ${number}`;
            if(label!==overlay.slotLabel){overlay.slotLabel=label;return true;}
        }
        if(existing==='pip_audience' || audienceNumber){
            const index=overlays.indexOf(overlay);
            const duplicate=audienceNumber && overlays.some((item,i)=>i<index && item?.slotKey===existing);
            let key=existing;
            if(existing==='pip_audience'){
                let number=1;while(overlays.some(item=>item!==overlay && item?.slotKey===`pip_audience_${number}`))number++;
                key=`pip_audience_${number}`;
            }else if(duplicate)key=nextKey(overlays,'pip_audience',overlay);
            const defaultLabel=byKey.get('pip_audience').label;
            const oldLabel=normalize(overlay.slotLabel);
            const generated=!oldLabel || oldLabel===defaultLabel || /^画中画（观众）\s+\d+$/.test(oldLabel);
            const label=generated?describe(key).label:overlay.slotLabel;
            if(key!==existing || label!==overlay.slotLabel){apply(overlay,key,label);return true;}
            return false;
        }
        const mediaHints = [overlay.content, overlay.name, ...(overlay.media_folder_files || [])].filter(Boolean).join('\n');
        const isGif = /\.gif(?:[?#\s].*)?$/im.test(mediaHints);
        // 早期版本或复制旧任务时，多个文字卡片可能都带着同一个
        // script_1（同理 media_1 等）。“批量表按 slotKey 建列”会因此
        // 把多张卡片合并为一列。保留本行中第一个，给后续重复层重新
        // 分配下一个编号；编号一旦写入就不再随排序变化。
        const numberedExisting = String(existing || '').match(/^(.+?)_(\d+)$/);
        if(existing && !(numberedExisting && AUTO_NUMBERED.has(numberedExisting[1]))){
            const index=overlays.indexOf(overlay);
            if(overlays.some((item,i)=>i<index && item?.slotKey===existing)){
                applyUnique(overlay,existing,overlays,overlay.slotLabel);return true;
            }
        }
        if (numberedExisting && AUTO_NUMBERED.has(numberedExisting[1])) {
            const currentIndex = (overlays || []).indexOf(overlay);
            const hasEarlierSameSlot = (overlays || []).some((item, index) =>
                index < currentIndex && item && item.slotKey === existing
            );
            if (hasEarlierSameSlot) {
                apply(overlay, nextKey(overlays, numberedExisting[1], overlay));
                return true;
            }
        }
        // Earlier automatic classification ran before GIF had its own default
        // slot. Upgrade only those generated `media_N` identities, retaining
        // their number. Explicitly named/other slots are never touched.
        const legacyMediaNumber = String(existing || '').match(/^media_(\d+)$/);
        if (isGif && legacyMediaNumber && /^媒体层\s*\d+$/u.test(String(overlay.slotLabel || ''))) {
            apply(overlay, `gif_${legacyMediaNumber[1]}`);
            return true;
        }
        if (legacyMediaNumber) return false;
        if (Object.prototype.hasOwnProperty.call(overlay, 'slotKey') && existing !== '' && !AUTO_NUMBERED.has(existing)) return false;
        if (existing === '') return false;
        const key = overlay.is_phone_cta && !existing ? 'phone_cta' : isGif ? 'gif' : (AUTO_NUMBERED.has(existing) ? existing : ((overlay.type === 'image' || overlay.type === 'video') ? 'media'
            : overlay.type === 'decor' ? 'particle'
            : overlay.type === 'scroll' ? 'scroll_subtitle'
                : (overlay.type === 'textcard' || overlay.type === 'text' || !overlay.type) ? 'script'
                    : ''));
        if (!key) return false;
        apply(overlay, nextKey(overlays, key, overlay));
        return true;
    }
    function matches(overlay, key) {
        return !!overlay && String(overlay.slotKey || '') === String(key || '');
    }
    const phoneMediaFields = ['type','content','media_loop','media_folder_path','media_folder_files','media_folder_items','media_folder_interval',
        'media_folder_durations','media_folder_duration_paths','is_img_sequence','sequence_frames','fps','video_start_offset','video_end_offset'];
    const phoneMediaCaches = ['_cachedUrl','_currentFrameImage','_exportImage','_exportFolderImages','_folderFramesByPath',
        '_framesDir','_frameCount','_folderDurationPending','_imageEl','_videoEl','_img'];
    const isPhoneSecondary = layer => /^phone_secondary(?:_\d+)?$/.test(layer?.slotKey || '');
    function phonePrimary(overlays) {
        const layers = (overlays || []).filter(layer => !layer.disabled && /^phone_primary(?:_\d+)?$/.test(layer.slotKey || '') && ['image','video'].includes(layer.type));
        return layers.length === 1 ? layers[0] : null;
    }
    function syncPhoneMedia(task) {
        const primary = phonePrimary(task?.overlays);
        if (!primary) return;
        const value = Object.fromEntries(phoneMediaFields.filter(key => primary[key] !== undefined).map(key => [key,primary[key]]));
        for (const layer of task.overlays || []) {
            if (!isPhoneSecondary(layer) || !layer.phonePrimaryLinked || layer.disabled) continue;
            const current = Object.fromEntries(phoneMediaFields.filter(key => layer[key] !== undefined).map(key => [key,layer[key]]));
            if (JSON.stringify(current) === JSON.stringify(value)) continue;
            for (const key of [...phoneMediaFields,...phoneMediaCaches]) delete layer[key];
            Object.assign(layer,JSON.parse(JSON.stringify(value)));
        }
    }
    root.ReelsLayerSlots = { PRESETS, customKey, describe, apply, applyUnique, nextKey, makeKey, ensureDefault, matches, normalize,
        isPhoneSecondary, phonePrimary, syncPhoneMedia };
})(window);
