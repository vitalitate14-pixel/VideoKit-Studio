/** Direct manipulation of a selected overview task; writes the same task fields as the inspector. */
window.ReelsOverviewEdit = (() => {
    const history = [];
    const settings={enabled:true,target:'auto',targets:[],axis:'y',mediaPart:'inner',guides:false,muted:false,speed:1,hover:false,hoverSpeed:2};
    function configure(values){
        const next={...values};
        // Hover playback and pointer editing compete for the same preview surface.
        if(next.hover===true)next.enabled=false;
        if(next.enabled===true)next.hover=false;
        Object.assign(settings,next);window.dispatchEvent(new Event('reels-preview-edit-settings'));
    }
    const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
    // 当前选中的图层（用于键盘微调、复制/粘贴）与图层剪贴板。
    let current = null, clipboard = null;
    const mountedCards=new Set();
    function activate(card,target,nudge){
        for(const other of mountedCards)if(other!==card)other.clearOverviewSelection?.();
        current={card,target,nudge};
    }
    function hitEditable(item,x,y){
        if(!item?.bounds)return false;
        const b=item.bounds;
        if(x<b.x || y<b.y || x>b.x+b.w || y>b.y+b.h)return false;
        if(item.hitTest)return item.hitTest(x,y);
        return !item.polygon || !!window.ReelsMediaWindow?.contains(item.polygon,x,y);
    }
    function selectOverlay(card,id){return !!card?.selectOverviewOverlay?.(id);}
    function clearSelection(card){card?.clearOverviewSelection?.();if(current?.card===card)current=null;}
    const TEXT_FRAME_KEYS=['w','h','title_frame_enabled','title_adaptive_enabled','title_adaptive_min_w','title_adaptive_max_w','title_adaptive_min_h','title_adaptive_max_h','title_adaptive_max_lines','auto_fit','auto_center_v','offset_x','offset_y','title_offset_x','title_offset_y'];
    const geometryKeys = type => type==='overlay'
        ? ['x','y','scale','scale_x','scale_y','media_window_mode','media_window','media_inner_x','media_inner_y','media_inner_scale',...TEXT_FRAME_KEYS]
        : type==='subtitle' ? ['pos_x','pos_y','font_size']
        : ['bgX','bgY','bgScale','contentVideoX','contentVideoY','contentVideoScale'];
    function resizeTextFrame(object,before,rect,edge,dx,dy) {
        let {x,y,w,h}=rect;
        if(edge==='e')w=Math.max(24,w+dx);
        if(edge==='s')h=Math.max(24,h+dy);
        if(edge==='w'){const right=x+w;x=Math.min(right-24,x+dx);w=right-x;}
        if(edge==='n'){const bottom=y+h;y=Math.min(bottom-24,y+dy);h=bottom-y;}
        const sx=Math.max(.01,Number(before.scale_x ?? before.scale)||1),sy=Math.max(.01,Number(before.scale_y ?? before.scale)||1);
        const localW=w/sx,localH=h/sy;
        Object.assign(object,{x:x+(w-localW)/2,y:y+(h-localH)/2,w:localW,h:localH,title_frame_enabled:true});
        if(object.type==='textcard')Object.assign(object,{
            title_frame_enabled:true,title_adaptive_enabled:true,
            title_adaptive_min_w:localW,title_adaptive_max_w:localW,
            title_adaptive_min_h:localH,title_adaptive_max_h:localH,title_adaptive_max_lines:10,
            auto_fit:false,auto_center_v:false,offset_x:0,offset_y:0,title_offset_x:0,title_offset_y:0,
        });
        return {x,y,w,h};
    }
    function mount(card, hooks) {
        if (card.editLayer) return;
        const layer = document.createElement('div'); card.editLayer = layer;
        layer.className = 'rto-edit-layer';
        layer.style.cssText = 'position:absolute;inset:0;z-index:2;touch-action:none;cursor:move';
        const box = document.createElement('div');
        box.style.cssText = 'display:none;position:absolute;border:2px solid #a99aff;box-sizing:border-box;pointer-events:none';
        for (const corner of ['nw','ne','sw','se']) {
            const handle = document.createElement('span'); handle.dataset.corner = corner;
            handle.style.cssText = `position:absolute;width:14px;height:14px;background:#b2a2ff;border:1px solid #fff;pointer-events:auto;cursor:${corner}-resize;${corner.includes('n')?'top':'bottom'}:-7px;${corner.includes('w')?'left':'right'}:-7px`;
            box.appendChild(handle);
        }
        const edgeHandles=[];
        for(const edge of ['n','e','s','w']){
            const handle=document.createElement('span');handle.dataset.edge=edge;
            const horizontal=edge==='n'||edge==='s';
            handle.title=horizontal?'拖动调整文字框高度':'拖动调整文字框宽度，文字自动换行';
            handle.style.cssText=`display:none;position:absolute;pointer-events:auto;${horizontal?`left:10px;right:10px;height:10px;${edge==='n'?'top':'bottom'}:-6px;cursor:ns-resize`:`top:10px;bottom:10px;width:10px;${edge==='w'?'left':'right'}:-6px;cursor:ew-resize`};background:rgba(169,154,255,.3);border-radius:4px`;
            box.appendChild(handle);edgeHandles.push(handle);
        }
        for (const axis of ['x','y']) {
            const handle=document.createElement('span');handle.dataset.axis=axis;
            handle.textContent=axis==='x'?'↔ X':'↕ Y';
            handle.title=axis==='x'?'只沿 X 轴左右拖动':'只沿 Y 轴上下拖动';
            handle.style.cssText=`position:absolute;${axis==='x'?'right:4px;top:50%;transform:translateY(-50%)':'left:50%;bottom:4px;transform:translateX(-50%)'};padding:2px 4px;white-space:nowrap;border-radius:3px;border:1px solid rgba(190,182,230,.45);font:10px system-ui;color:#ddd8ef;background:rgba(20,22,30,.35);opacity:.45;pointer-events:auto;cursor:${axis==='x'?'ew':'ns'}-resize;user-select:none;transition:opacity .15s,background .15s`;
            handle.onpointerenter=()=>{handle.style.opacity='1';handle.style.background='rgba(35,38,50,.8)';};
            handle.onpointerleave=()=>{handle.style.opacity='.45';handle.style.background='rgba(20,22,30,.35)';};
            box.appendChild(handle);
        }
        layer.appendChild(box); card.stage.appendChild(layer);
        let target, bounds, drag, group = [], moveFrame, pendingMove, lastUI = 0;
        const dimensions = () => {
            const rs = window._reelsState || {};
            const size = window.ReelsLayoutTemplate?.taskCanvas?.(card.task, rs);
            return { w: Number(size?.width) || rs.targetWidth || 1080, h: Number(size?.height) || rs.targetHeight || 1920 };
        };
        const overlays = () => window._reelsState.overlayProxy?.overlayMgr?.overlays || card.task.overlays || [];
        function choose(x,y) {
            const selected=hooks.targets?.() || [];
            let mode = hooks.target();
            group=[];
            if(mode==='multi' && !selected.length){target=null;box.style.display='none';card.status.textContent='请先勾选允许编辑的图层';return;}
            const {w,h} = dimensions();
            const allowed = mode==='multi' && selected.length ? selected.flatMap(key=>{
                if(key==='background') return [];
                const matches=key.startsWith('slot:')?overlays().filter(ov=>ov.slotKey===key.slice(5)):[overlays()[Number(key.slice(12))]].filter(Boolean);
                return matches.length===1 && !matches[0].disabled ? matches : [];
            }) : null;
            const ids = allowed ? allowed.map(ov=>ov.id)
                : mode.startsWith('slot:') ? overlays().filter(ov=>ov.slotKey===mode.slice(5)).map(ov=>ov.id)
                : mode.startsWith('layer-index:') ? [overlays()[Number(mode.slice(12))]?.id]
                : mode.startsWith('overlay:') ? [mode.slice(8)]
                : ['background','content','subtitle'].includes(mode) ? [] : undefined;
            const items = card.player.getEditableOverlays(ids,true);
            const hit=[...items].reverse().find(item=>(!allowed || allowed.some(ov=>String(ov.id)===String(item.id))) && hitEditable(item,x,y));
            const lockedMode=mode.startsWith('slot:') || mode.startsWith('layer-index:') || mode.startsWith('overlay:');
            if(lockedMode && !hit){clearSelection(card);card.status.textContent='请点击该图层实际可见的内容';return;}
            if(mode==='multi'){
                if(hit) mode='auto';
                else if(selected.includes('background')) mode='background';
                else {target=null;box.style.display='none';card.status.textContent='请点击勾选范围内的图层';return;}
            }
            let subtitleBounds;
            if(mode==='auto' && !hit){
                subtitleBounds=card.player.getEditableSubtitleBounds?.(true);
                mode=subtitleBounds && hitEditable({bounds:subtitleBounds,hitTest:subtitleBounds.hitTest},x,y)?'subtitle':'background';
            }
            const locked = mode.startsWith('slot:') || mode.startsWith('layer-index:');
            if ((mode==='auto' && hit) || mode.startsWith('overlay:') || locked) {
                const candidates = mode.startsWith('slot:') ? overlays().filter(ov=>ov.slotKey===mode.slice(5))
                    : mode.startsWith('layer-index:') ? [overlays()[Number(mode.slice(12))]].filter(Boolean)
                    : overlays().filter(item=>String(item.id)===String(mode==='auto'?hit.id:mode.slice(8)));
                const ov = candidates.length===1 ? candidates[0] : null;
                if (!ov || ov.disabled) { target=null;box.style.display='none';card.status.textContent=candidates.length>1?'同名图层有多个，请明确图层':'此任务没有可编辑的指定图层';return; }
                const id=ov.id;
                target={type:'overlay',object:ov};
                bounds=(items.find(item=>String(item.id)===String(id)) || {}).bounds || {x:ov.x||0,y:ov.y||0,w:ov.w||200,h:ov.h||200};
                window.reelsInspectorSwitch?.('overlay'); window._reelsState.overlayPanel?.selectOverlay(ov);
            } else if (mode==='background' || mode==='content') {
                target={type:mode,object:card.task}; bounds={x:0,y:0,w,h};
                window.reelsInspectorSwitch?.('background');
            } else {
                subtitleBounds=subtitleBounds || card.player.getEditableSubtitleBounds?.();
                if(!subtitleBounds){target=null;box.style.display='none';card.status.textContent='当前时间没有可见字幕';return;}
                const style=copy(window._resolveSubtitleStyleForTask?.(card.task) || card.task.subtitleStyle || {});
                card.task.subtitleStyle=style; card.task._subtitlePreset='';
                target={type:'subtitle',object:style};
                bounds=subtitleBounds;
                window.reelsInspectorSwitch?.('subtitle');
            }
            drawBox();
            activate(card,target,nudgeLocal);
        }
        function drawBox() {
            if (!bounds) return;
            const {w,h}=dimensions();
            box.style.display='block';
            const textFrame=target?.type==='overlay' && ['text','textcard'].includes(target.object.type) && group.length<=1;
            for(const handle of edgeHandles)handle.style.display=textFrame?'block':'none';
            Object.assign(box.style,{left:`${bounds.x/w*100}%`,top:`${bounds.y/h*100}%`,width:`${bounds.w/w*100}%`,height:`${bounds.h/h*100}%`});
        }
        mountedCards.add(card);
        card.clearOverviewSelection=()=>{if(drag)return;target=null;group=[];box.style.display='none';};
        card.selectOverviewOverlay=id=>{
            if(drag || !card.player)return false;
            const ov=overlays().find(item=>String(item.id)===String(id));
            if(!ov || ov.disabled){clearSelection(card);return false;}
            const item=card.player.getEditableOverlays([ov.id]).find(item=>String(item.id)===String(ov.id));
            if(!item?.bounds){clearSelection(card);card.status.textContent='已选中图层，当前预览时间内不可见';return false;}
            target={type:'overlay',object:ov};bounds=item.bounds;group=[];
            drawBox();activate(card,target,nudgeLocal);return true;
        };
        function sync(force = false) {
            const updateUI = force || performance.now()-lastUI > 100;
            if(updateUI) lastUI=performance.now();
            if (updateUI && target.type==='subtitle') window._writeStyleToUI?.(target.object);
            else if (updateUI && (target.type==='background'||target.type==='content')) window.reelsSyncBackgroundTabUI?.(card.task);
            if (updateUI && target.type === 'overlay' && target.object.type === 'textcard') {
                const panel = window._reelsState?.overlayPanel;
                if (panel?._selectedOv?.id === target.object.id) panel._syncTitleLayerPosition?.(target.object);
            }
            if(target.type==='overlay'){
                for(const [id,value] of [['rop-media-inner-x',target.object.media_inner_x||0],['rop-media-inner-y',target.object.media_inner_y||0],['rop-media-inner-scale',Math.round((target.object.media_inner_scale??1)*100)]]){
                    const field=document.getElementById(id);if(field)field.value=value;
                }
            }
            if(target.type==='overlay') card.task.overlays=overlays();
            const keys=geometryKeys(target.type);
            const fields={};for(const key of keys) if(key in target.object) fields[key]=target.object[key];
            card.player.updateEditableGeometry(target.type,target.object.id,fields);
        }
        layer.onpointerdown = event => {
            if (event.button > 0) return;
            if(window.ReelsOverviewBatch?.canEditTask?.(card.task)===false)return;
            hooks.select();
            const rect=layer.getBoundingClientRect(),{w,h}=dimensions();
            const x=(event.clientX-rect.left)/rect.width*w,y=(event.clientY-rect.top)/rect.height*h;
            if (!event.target.dataset.corner && !event.target.dataset.axis && !event.target.dataset.edge) choose(x,y);
            if (!target) return;
            if (target.type==='overlay') {
                const current = overlays().find(ov=>String(ov.id)===String(target.object.id));
                if(!current) return;
                target.object=current;
            }
            drag={x,y,rect,w,h,axis:event.target.dataset.axis || hooks.axis?.() || 'free',inner:target.type==='overlay' && ['image','video'].includes(target.object.type) && ['pip','top_half','bottom_half'].includes(target.object.media_window_mode) && hooks.mediaPart?.()==='inner',corner:event.target.dataset.corner,edge:event.target.dataset.edge,before:copy(target.object),bounds:{...bounds},target};
            drag.members=(drag.edge?[target]:(group.length?group:[target])).map(member=>{
                if(member.type==='overlay') member.object=overlays().find(ov=>String(ov.id)===String(member.object.id)) || member.object;
                return {target:member,before:copy(member.object)};
            });
            card.dragging=true;
            layer.setPointerCapture(event.pointerId); event.preventDefault(); event.stopPropagation();
        };
        const applyOne = event => {
            if (!drag) return;
            let dx=(event.clientX-drag.rect.left)/drag.rect.width*drag.w-drag.x;
            let dy=(event.clientY-drag.rect.top)/drag.rect.height*drag.h-drag.y;
            if (!drag.corner && !drag.edge) {
                if (drag.axis==='x') dy=0;
                else if (drag.axis==='y') dx=0;
                else if (event.shiftKey) { if (Math.abs(dx)>=Math.abs(dy)) dy=0; else dx=0; }
            }
            if(target.type==='overlay'){
                const current=overlays().find(ov=>String(ov.id)===String(target.object.id));
                if(current) target.object=current;
            }
            const object=target.object,before=drag.before;
            if (drag.edge && target.type==='overlay' && ['text','textcard'].includes(target.object.type)) {
                bounds=resizeTextFrame(object,before,drag.bounds,drag.edge,dx,dy);
            } else if (drag.corner) {
                const centerX=drag.bounds.x+drag.bounds.w/2,centerY=drag.bounds.y+drag.bounds.h/2;
                const oldDistance=Math.hypot(drag.x-centerX,drag.y-centerY) || 1;
                const factor=Math.max(.1,Math.min(10,Math.hypot(drag.x+dx-centerX,drag.y+dy-centerY)/oldDistance));
                if(drag.inner){object.media_inner_scale=Math.max(.01,(Number(before.media_inner_scale)||1)*factor);}
                else if(target.type==='overlay'){object.scale_x=(Number(before.scale_x ?? before.scale)||1)*factor;object.scale_y=(Number(before.scale_y ?? before.scale)||1)*factor;object.scale=(Number(before.scale)||1)*factor;}
                else if(target.type==='subtitle') object.font_size=Math.max(8,Math.round((Number(before.font_size)||74)*factor));
                else {const key=target.type==='background'?'bgScale':'contentVideoScale';object[key]=Math.max(1,(Number(before[key])||100)*factor);}
                bounds={x:centerX-drag.bounds.w*factor/2,y:centerY-drag.bounds.h*factor/2,w:drag.bounds.w*factor,h:drag.bounds.h*factor};
            } else {
                if(target.type==='overlay') {
                    if(drag.inner){
                        const sx=object.media_window_mode==='pip'?Math.max(.01,Number(before.scale_x ?? before.scale)||1):1;
                        const sy=object.media_window_mode==='pip'?Math.max(.01,Number(before.scale_y ?? before.scale)||1):1;
                        object.media_inner_x=(Number(before.media_inner_x)||0)+dx/sx;
                        object.media_inner_y=(Number(before.media_inner_y)||0)+dy/sy;
                    }
                    else if(object.media_window_mode && object.media_window_mode!=='top_half' && object.media_window_mode!=='bottom_half'){object.media_window={...(before.media_window||{}),x:(Number(before.media_window?.x ?? before.x)||0)+dx,y:(Number(before.media_window?.y ?? before.y)||0)+dy};}
                    else if(object.media_window_mode){object.media_window_mode='custom';object.media_window={x:drag.bounds.x+dx,y:drag.bounds.y+dy,w:drag.bounds.w,h:drag.bounds.h};}
                    else {object.x=(Number(before.x)||0)+dx;object.y=(Number(before.y)||0)+dy;}
                } else if(target.type==='subtitle') {const px=Number(before.pos_x)||.5,py=Number(before.pos_y)||.85;object.pos_x=(px<=1?px:px/drag.w)+dx/drag.w;object.pos_y=(py<=1?py:py/drag.h)+dy/drag.h;}
                else if(target.type==='background'){object.bgX=(Number(before.bgX)||0)+dx/drag.w*100;object.bgY=(Number(before.bgY)||0)+dy/drag.h*100;}
                else {const x=Number(before.contentVideoX)||0,y=Number(before.contentVideoY)||0;object.contentVideoX=(Math.abs(x)<=1?x:x/1080)+dx/drag.w;object.contentVideoY=(Math.abs(y)<=1?y:y/1920)+dy/drag.h;}
                bounds={...drag.bounds,x:drag.bounds.x+dx,y:drag.bounds.y+dy};
            }
            if(drag.inner) bounds={...drag.bounds};
            sync();
            drawBox();
        };
        const applyMove = event => {
            if(!drag)return;
            const original=target, before=drag.before;
            for(const member of drag.members){
                target=member.target;drag.before=member.before;
                drag.inner=target.type==='overlay' && ['image','video'].includes(target.object.type) && ['pip','top_half','bottom_half'].includes(target.object.media_window_mode) && hooks.mediaPart?.()==='inner';
                applyOne(event);
            }
            target=original;drag.before=before;
        };
        layer.onpointermove = event => {
            pendingMove = event;
            if(!moveFrame) moveFrame=requestAnimationFrame(()=>{moveFrame=null;const latest=pendingMove;pendingMove=null;applyMove(latest);});
        };
        const finish = () => {
            if(moveFrame){cancelAnimationFrame(moveFrame);moveFrame=null;}
            if(pendingMove){applyMove(pendingMove);pendingMove=null;}
            if(!drag)return;
            sync(true); hooks.refresh();
            const liveBounds=target.type==='overlay'?card.player.getEditableOverlays(drag.members.map(member=>member.target.object.id)):[];
            const rects=drag.members.map(member=>liveBounds.find(item=>String(item.id)===String(member.target.object.id))?.bounds).filter(Boolean);
            let actual=target.type==='overlay'?rects[0]:target.type==='subtitle'?card.player.getEditableSubtitleBounds?.():null;
            if(rects.length>1){const x=Math.min(...rects.map(r=>r.x)),y=Math.min(...rects.map(r=>r.y));actual={x,y,w:Math.max(...rects.map(r=>r.x+r.w))-x,h:Math.max(...rects.map(r=>r.y+r.h))-y};}
            if(actual){bounds=actual;drawBox();}
            const changes=drag.members.filter(member=>geometryKeys(member.target.type).some(key=>JSON.stringify(member.before[key])!==JSON.stringify(member.target.object[key])));
            const batched=changes.length && changes.every(member=>member.target.type==='overlay') && window.ReelsOverviewBatch?.mutations?.(card.task,changes,geometryKeys('overlay'));
            if(changes.length && !batched){history.push({card,members:changes.map(member=>({type:member.target.type,id:member.target.object.id,before:member.before}))});if(history.length>50)history.shift();window.dispatchEvent(new CustomEvent('reels-overview-undo-push',{detail:'edit'}));}
            card.dragging=false;
            if(target.type==='overlay') window._reelsState.overlayPanel?.selectOverlay(target.object);
            window._syncTasksToActiveTab?.(); window._batchAutoSave?.({skipSync:true});
            drag=null;
        };
        layer.onpointerup=finish;layer.onpointercancel=finish;
        layer.onkeydown=event=>{if(event.key==='Escape'){finish();}};
        // 键盘微调：复用拖动逻辑（含画中画、字幕、背景），并进入撤销历史。
        function nudgeLocal(dx, dy) {
            if (!target || drag || !card.player) return false;
            if (target.type==='overlay') {
                const live = overlays().find(ov=>String(ov.id)===String(target.object.id));
                if (!live) return false;
                target.object = live;
            }
            const {w,h} = dimensions();
            drag={x:0,y:0,rect:{left:0,top:0,width:w,height:h},w,h,axis:'free',inner:target.type==='overlay' && ['image','video'].includes(target.object.type) && ['pip','top_half','bottom_half'].includes(target.object.media_window_mode) && hooks.mediaPart?.()==='inner',before:copy(target.object),bounds:{...bounds},target,members:[{target,before:copy(target.object)}]};
            card.dragging=true;
            applyMove({clientX:dx, clientY:dy, shiftKey:false});
            finish();
            return true;
        }
    }
    function unmount(card){card.dragging=false;card.editLayer?.remove();card.editLayer=null;mountedCards.delete(card);delete card.selectOverviewOverlay;delete card.clearOverviewSelection;if(current?.card===card)current=null;}
    function nudge(dx, dy){ return !!current?.nudge?.(dx, dy); }

    // ── 复制 / 粘贴图层样式与位置 ──
    const POSITION_KEYS = ['x','y','w','h','scale','scale_x','scale_y','rotation','media_window_mode','media_window','media_inner_x','media_inner_y','media_inner_scale','media_split_angle',...TEXT_FRAME_KEYS];
    const NEVER_KEYS = new Set(['id','type','name','content','slotKey','slotLabel','disabled','start','end','card_time_linked','mask_start','mask_end','media_folder_path','media_folder_files','media_folder_items','is_img_sequence','sequence_frames']);
    const isTextKey = key => /(^|_)texts?$/.test(key) || /_rich|_html|_segments$/.test(key);
    function pickFields(ov, kind) {
        const out = {};
        for (const key of Object.keys(ov)) {
            if (NEVER_KEYS.has(key) || isTextKey(key) || key.startsWith('_')) continue;
            const isPos = POSITION_KEYS.includes(key);
            if (kind === 'all' || (kind === 'position' ? isPos : !isPos)) out[key] = copy(ov[key]);
        }
        return out;
    }
    function copyLayer(kind) {
        if (current?.target?.type !== 'overlay') { window.showToast?.('请先在卡片上点选一个覆层（如文字卡片）', 'warning'); return false; }
        const sel = current.target.object;
        const liveList = window._reelsState?.overlayProxy?.overlayMgr?.overlays || current.card.task.overlays || [];
        const ov = liveList.find(item => String(item.id) === String(sel.id)) || sel;
        clipboard = {kind, type: ov.type, slotKey: ov.slotKey || '', name: ov.slotLabel || ov.name || ov.type, fields: pickFields(ov, kind)};
        const label = {style:'样式', position:'位置', all:'样式+位置'}[kind];
        window.showToast?.(`已复制「${clipboard.name}」的${label}`, 'success');
        return true;
    }
    // 在目标任务里找对应图层：优先同层位，其次是唯一的同类型图层。
    function findMatch(list) {
        if (clipboard.slotKey) { const bySlot = list.filter(ov => ov.slotKey === clipboard.slotKey && !ov.disabled); if (bySlot.length === 1) return bySlot[0]; if (bySlot.length > 1) return null; }
        const byType = list.filter(ov => ov.type === clipboard.type && !ov.disabled);
        return byType.length === 1 ? byType[0] : null;
    }
    function pasteLayer(tasks) {
        if (!clipboard) { window.showToast?.('还没有复制任何图层', 'warning'); return []; }
        const rs = window._reelsState, selectedTask = rs.tasks?.[rs.selectedIdx];
        const changed = [], skipped = [], snapshots = [];
        for (const task of tasks) {
            const list = task === selectedTask && rs.overlayProxy?.overlayMgr ? rs.overlayProxy.overlayMgr.overlays : (task.overlays || []);
            const ov = findMatch(list);
            if (!ov) { skipped.push(task); continue; }
            snapshots.push({task,before:copy(list)});
            Object.assign(ov, copy(clipboard.fields));
            if(Object.prototype.hasOwnProperty.call(clipboard.fields,'media_split_angle') && ['top_half','bottom_half'].includes(ov.media_window_mode)){
                for(const layer of list)if(['top_half','bottom_half'].includes(layer.media_window_mode))layer.media_split_angle=ov.media_split_angle;
            }
            if (task === selectedTask) task.overlays = list;
            changed.push(task);
        }
        if(snapshots.length){history.push({paste:snapshots});if(history.length>50)history.shift();window.dispatchEvent(new CustomEvent('reels-overview-undo-push',{detail:'edit'}));}
        if (changed.includes(selectedTask)) { rs.overlayPanel?._refreshList?.(); if (current?.target?.type === 'overlay') rs.overlayPanel?.selectOverlay?.(current.target.object); }
        window._syncTasksToActiveTab?.(); window._batchAutoSave?.({skipSync:true});
        window.showToast?.(`已粘贴到 ${changed.length} 个任务${skipped.length ? `，${skipped.length} 个任务没有对应图层已跳过` : ''}`, changed.length ? 'success' : 'warning');
        return changed;
    }
    const clipboardInfo = () => clipboard ? {...clipboard, fields: undefined} : null;
    const backgroundFillFields={bgX:0,bgY:0,bgScale:100,bgRotation:0};
    function syncBackgroundFill(task){
        for(const card of mountedCards)if(card.task===task){
            card.player?.updateEditableGeometry?.('background',null,Object.fromEntries(Object.keys(backgroundFillFields).map(key=>[key,task[key] ?? backgroundFillFields[key]])));
            card.clearOverviewSelection?.();
        }
        if(window._reelsState.tasks?.[window._reelsState.selectedIdx]===task)window.reelsSyncBackgroundTabUI?.(task);
        window._syncTasksToActiveTab?.();window._batchAutoSave?.({skipSync:true});
        refreshScaleReset(task);
    }
    function fillBackground(task){
        if(!window._reelsState.tasks?.includes(task))return false;
        const before={};
        for(const key of Object.keys(backgroundFillFields))if(Object.prototype.hasOwnProperty.call(task,key))before[key]=task[key];
        if(Object.entries(backgroundFillFields).every(([key,value])=>(task[key] ?? value)===value))return true;
        history.push({backgroundFill:{task,before}});if(history.length>50)history.shift();
        Object.assign(task,backgroundFillFields);
        window.dispatchEvent(new CustomEvent('reels-overview-undo-push',{detail:'edit'}));
        syncBackgroundFill(task);return true;
    }
    function refreshScaleReset(task) {
        const rs=window._reelsState;
        if(rs.tasks?.[rs.selectedIdx]===task){
            window.reelsUpdatePreview?.();
            window.ReelsPreviewV2?.refresh?.();
        }
        window.dispatchEvent(new CustomEvent('reels-task-media-changed',{detail:task}));
    }
    function resetMediaScale(task, overlay, part) {
        const rs=window._reelsState;
        if(!rs.tasks?.includes(task) || !['outer','inner'].includes(part))return false;
        const selected=rs.tasks[rs.selectedIdx]===task;
        const list=selected && rs.overlayProxy?.overlayMgr ? rs.overlayProxy.overlayMgr.overlays : task.overlays || [];
        const live=list.find(item=>String(item.id)===String(overlay?.id));
        if(!live || live.disabled || !['image','video'].includes(live.type))return false;
        const fields=part==='inner'?{media_inner_scale:1}:{scale:1,scale_x:1,scale_y:1};
        if(Object.entries(fields).every(([key,value])=>live[key]===value))return true;
        history.push({paste:[{task,before:copy(list)}],scaleReset:true});
        if(history.length>50)history.shift();
        Object.assign(live,fields);task.overlays=list;
        window.dispatchEvent(new CustomEvent('reels-overview-undo-push',{detail:'edit'}));
        for(const card of mountedCards){
            if(card.task!==task)continue;
            card.player?.updateEditableGeometry?.('overlay',live.id,fields);
            if(selected)card.selectOverviewOverlay?.(live.id);
            else card.clearOverviewSelection?.();
        }
        if(selected)rs.overlayPanel?.selectOverlay?.(live);
        window._syncTasksToActiveTab?.();window._batchAutoSave?.({skipSync:true});
        refreshScaleReset(task);
        return true;
    }
    function addBackgroundLayer(task,existing=null) {
        const rs=window._reelsState,library=window.ReelsBackgroundLibrary;
        if(!rs?.tasks?.includes(task))return false;
        if(!library?.syncLinkedMedia || !window.ReelsOverlay?.createImageOverlay)throw new Error('背景层组件尚未加载');
        const pool=task.bgMode==='multi'?(task.bgClipActivePool?.length?task.bgClipActivePool:task.bgClipPool || []):[];
        if(!pool.length && !task.bgPath && !task.videoPath)throw new Error('当前任务没有背景素材，请先设置背景');
        const selected=rs.tasks[rs.selectedIdx]===task;
        const mgr=selected?rs.overlayProxy?.overlayMgr:null;
        const list=mgr?.overlays || task.overlays || [];
        if(existing){existing=list.find(layer=>String(layer.id)===String(existing.id));if(!existing)return false;}
        const before=copy(list),visualOverlayOrder=copy(task.visualOverlayOrder);
        const size=window.ReelsLayoutTemplate?.taskCanvas?.(task,rs);
        const w=Number(size?.width) || (Number(rs.targetWidth)>0?Number(rs.targetWidth):1080),h=Number(size?.height) || (Number(rs.targetHeight)>0?Number(rs.targetHeight):1920);
        const previous=existing?.media_window || existing;
        const rect=previous && (previous.w!==w || previous.h!==h)
            ? {x:previous.x || 0,y:previous.y || 0,w:previous.w,h:previous.h} : {x:w/4,y:h/4,w:w/2,h:h/2};
        const layer=existing?{...copy(existing),...rect}:window.ReelsOverlay.createImageOverlay({...rect,start:0,end:9999});
        Object.assign(layer,{name:'画中画（讲道）',backgroundLinked:true,backgroundReplacesBase:false,disabled:false,media_audio_enabled:false,
            media_window_mode:'pip',media_window:{...rect},media_window_initialized:true,media_window_ratio:existing?.media_window_ratio || 'free',
            media_inner_x:existing?.media_inner_x ?? 0,media_inner_y:existing?.media_inner_y ?? 0,
            media_inner_scale:existing?.media_inner_scale ?? 1,media_inner_rotation:existing?.media_inner_rotation ?? 0,
            crop_fill:true,clip_rect:{...rect},media_window_generated_clip:true});
        if(window.ReelsLayerSlots?.applyUnique)window.ReelsLayerSlots.applyUnique(layer,'pip_sermon',list.filter(item=>item!==existing),'画中画（讲道）');
        else Object.assign(layer,{slotKey:'pip_sermon',slotLabel:'画中画（讲道）'});
        library.syncLinkedMedia({overlays:[layer]},task,(target,value)=>Object.assign(target,value));
        // 新背景层放在已有覆层下方，保留原有卡片、电话和画中画的显示顺序。
        task.overlays=existing?list.map(item=>item===existing?layer:item):[layer,...list];
        if(!existing)task.visualOverlayOrder=[`overlay:${layer.id}`,...(visualOverlayOrder || [])];
        if(mgr)mgr.overlays=task.overlays;
        history.push({paste:[{task,before,visualOverlayOrder}],mediaChanged:true});if(history.length>50)history.shift();
        window.dispatchEvent(new CustomEvent('reels-overview-undo-push',{detail:'edit'}));
        if(selected){rs.overlayPanel?._refreshList?.();rs.overlayPanel?.selectOverlay?.(layer);}
        window._syncTasksToActiveTab?.();window._batchAutoSave?.({skipSync:true});
        refreshScaleReset(task);
        return layer;
    }
    function linkMediaToBackground(task,overlay,enabled=true) {
        const rs=window._reelsState,library=window.ReelsBackgroundLibrary;
        if(!rs?.tasks?.includes(task) || !library?.syncLinkedMedia)return false;
        const selected=rs.tasks[rs.selectedIdx]===task;
        const list=selected && rs.overlayProxy?.overlayMgr ? rs.overlayProxy.overlayMgr.overlays : task.overlays || [];
        const live=list.find(item=>String(item.id)===String(overlay?.id));
        if(!live || live.disabled || !['image','video'].includes(live.type))return false;
        const pool=task.bgMode==='multi'?(task.bgClipActivePool?.length?task.bgClipActivePool:task.bgClipPool || []):[];
        if(enabled && !pool.length && !task.bgPath && !task.videoPath)throw new Error('当前任务没有背景素材，请先设置背景');
        const before=copy(list);
        live.backgroundLinked=!!enabled;
        if(enabled)live.phonePrimaryLinked=false;
        if(enabled)library.syncLinkedMedia({overlays:[live]},task,(layer,value)=>{
            if(window._rbtApplyOverlayMediaValue)window._rbtApplyOverlayMediaValue(layer,value);
            else Object.assign(layer,value);
        });
        task.overlays=list;
        history.push({paste:[{task,before}],mediaChanged:true});if(history.length>50)history.shift();
        window.dispatchEvent(new CustomEvent('reels-overview-undo-push',{detail:'edit'}));
        if(selected)rs.overlayPanel?.selectOverlay?.(live);
        window._syncTasksToActiveTab?.();window._batchAutoSave?.({skipSync:true});
        refreshScaleReset(task);
        return true;
    }
    function linkMediaToPhonePrimary(task,overlay,enabled=true) {
        const rs=window._reelsState,slots=window.ReelsLayerSlots;
        if(!rs?.tasks?.includes(task) || !slots)return false;
        const selected=rs.tasks[rs.selectedIdx]===task;
        const list=selected && rs.overlayProxy?.overlayMgr ? rs.overlayProxy.overlayMgr.overlays : task.overlays || [];
        const live=list.find(item=>String(item.id)===String(overlay?.id));
        if(!live || live.disabled || !slots.isPhoneSecondary(live) || !['image','video'].includes(live.type))return false;
        const primary=slots.phonePrimary(list);
        if(enabled && (!primary || !primary.content))throw new Error('请先设置唯一的电话主层及其媒体');
        const before=copy(list);
        live.phonePrimaryLinked=!!enabled;
        if(enabled){live.backgroundLinked=false;slots.syncPhoneMedia({overlays:list});}
        task.overlays=list;
        history.push({paste:[{task,before}],mediaChanged:true});if(history.length>50)history.shift();
        window.dispatchEvent(new CustomEvent('reels-overview-undo-push',{detail:'edit'}));
        if(selected)rs.overlayPanel?.selectOverlay?.(live);
        window._syncTasksToActiveTab?.();window._batchAutoSave?.({skipSync:true});
        refreshScaleReset(task);
        return true;
    }
    function recordBatch(snapshots,key=''){
        const last=history.at(-1),now=Date.now();
        if(key && last?.batchKey===key && now-last.at<600){
            for(const item of snapshots)if(!last.paste.some(entry=>entry.task===item.task))last.paste.push(item);
            last.at=now;return;
        }
        history.push({paste:snapshots,batchKey:key,at:now});if(history.length>50)history.shift();
        window.dispatchEvent(new CustomEvent('reels-overview-undo-push',{detail:'edit'}));
    }
    function recordBackgroundBatch(snapshots,key){
        const last=history.at(-1),now=Date.now();
        if(last?.backgroundBatch && last.batchKey===key && now-last.at<600){
            for(const item of snapshots)if(!last.backgroundBatch.some(old=>old.task===item.task))last.backgroundBatch.push(item);
            last.at=now;return;
        }
        history.push({backgroundBatch:snapshots,batchKey:key,at:now});if(history.length>50)history.shift();
        window.dispatchEvent(new CustomEvent('reels-overview-undo-push',{detail:'edit'}));
    }
    function undo(hooks){
        const entry=history.pop();
        if(!entry){window.showToast?.('没有可撤销的画面调整');return;}
        if(entry.backgroundBatch){
            for(const {task,key,had,value} of entry.backgroundBatch){if(had)task[key]=copy(value);else delete task[key];}
            const task=window._reelsState.tasks?.[window._reelsState.selectedIdx];
            if(entry.backgroundBatch.some(item=>item.task===task))window.reelsSyncBackgroundTabUI?.(task);
            hooks.refresh(entry.backgroundBatch.map(item=>item.task));
            for(const item of entry.backgroundBatch)window.dispatchEvent(new CustomEvent('reels-task-media-changed',{detail:item.task}));
            window._syncTasksToActiveTab?.();window._batchAutoSave?.({skipSync:true});return;
        }
        if(entry.backgroundFill){
            const {task,before}=entry.backgroundFill;
            for(const key of Object.keys(backgroundFillFields)){
                if(Object.prototype.hasOwnProperty.call(before,key))task[key]=before[key];else delete task[key];
            }
            syncBackgroundFill(task);hooks.refresh([task]);return;
        }
        if(entry.paste){
            const rs=window._reelsState, selectedTask=rs.tasks?.[rs.selectedIdx];
            for(const item of entry.paste){
                const {task,before}=item;task.overlays=copy(before);
                if(Object.prototype.hasOwnProperty.call(item,'visualOverlayOrder')){
                    if(item.visualOverlayOrder===undefined)delete task.visualOverlayOrder;
                    else task.visualOverlayOrder=copy(item.visualOverlayOrder);
                }
            }
            if(entry.paste.some(item=>item.task===selectedTask) && rs.overlayProxy?.overlayMgr)rs.overlayProxy.overlayMgr.overlays=selectedTask.overlays;
            current=null;
            rs.overlayPanel?.deselectOverlay?.();rs.overlayPanel?._refreshList?.();
            hooks.refresh(entry.paste.map(item=>item.task));
            if(entry.scaleReset || entry.mediaChanged)for(const {task} of entry.paste)refreshScaleReset(task);
            window._syncTasksToActiveTab?.();window._batchAutoSave?.({skipSync:true});
            return;
        }
        // Selecting a task may clone its overlays: resolve current objects afterwards.
        hooks.select(entry.card);
        const rs=window._reelsState, task=entry.card.task;
        const overlays=rs.overlayProxy?.overlayMgr?.overlays || task.overlays || [];
        for(const member of entry.members){
            const object=member.type==='overlay' ? overlays.find(ov=>String(ov.id)===String(member.id))
                : member.type==='subtitle' ? task.subtitleStyle : task;
            if(!object)continue;
            for(const key of geometryKeys(member.type)){
                if(Object.prototype.hasOwnProperty.call(member.before,key)) object[key]=member.before[key]===undefined ? undefined : copy(member.before[key]);
                else delete object[key];
            }
        }
        task.overlays=overlays;
        window._writeStyleToUI?.(window._resolveSubtitleStyleForTask?.(task)||{});
        window.reelsSyncBackgroundTabUI?.(task);
        rs.overlayPanel?.deselectOverlay?.();rs.overlayPanel?._refreshList();
        hooks.refresh();window._syncTasksToActiveTab?.();window._batchAutoSave?.({skipSync:true});
        entry.card.status.textContent='已撤销画面调整';
    }
    return {recordBatch,recordBackgroundBatch,resetHistory(){history.length=0;current=null;},mount,unmount,undo,settings,configure,nudge,copyLayer,pasteLayer,clipboardInfo,selectOverlay,clearSelection,hitEditable,resetMediaScale,fillBackground,resizeTextFrame,addBackgroundLayer,linkMediaToBackground,linkMediaToPhonePrimary};
})();
