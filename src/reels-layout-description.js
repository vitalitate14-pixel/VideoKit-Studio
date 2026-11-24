/** Plain-language layout copy with a shared, persistent layer selection. */
window.ReelsLayoutDescription=(()=>{
    const STORE_KEY='videokit_layout_copy_layers_v1';
    const n=(value,fallback=0)=>Number.isFinite(Number(value))?Number(value):fallback;
    const fmt=value=>Math.round(n(value)*100)/100;
    const pct=(value,max=255)=>fmt(n(value,max)/max*100);
    const align=value=>({left:'左对齐',center:'居中',right:'右对齐',top:'顶部对齐',bottom:'底部对齐'}[value] || value);
    function liveOverlays(task){
        const rs=window._reelsState;
        return rs?.tasks?.[rs.selectedIdx]===task && rs.overlayProxy?.overlayMgr?.overlays || task.overlays || [];
    }
    function subtitleStyle(task){return window._resolveSubtitleStyleForTask?.(task) || task.subtitleStyle || task.style || window._reelsState?.globalSubtitleStyle;}
    function hasSubtitleContent(task){
        const style=subtitleStyle(task);
        if(!style)return false;
        if((task.segments || []).some(segment=>String(segment?.edited_text || segment?.text || '').trim()))return true;
        // Uniform scrolling can render the task text without timed segments.
        const uniform=window.ReelsUniformScroll?.isEnabled?.(style) ?? (!!style.scrolling_mode && style.scrolling_motion==='uniform');
        return !!uniform && !!String(task.txtContent || task.ttsText || task.aiScript || '').trim();
    }
    const labelParts=label=>{
        const value=String(label || '').trim().replace(/\s+/g,' ');
        const match=value.match(/^(.*?)\s+(\d+)$/);
        return {base:match?match[1]:value,number:match && Number(match[2])>0?Number(match[2]):null};
    };
    function numberedLabels(labels){
        const parts=labels.map(labelParts),used=new Map(),assigned=new Map();
        // Reserve existing numbers first so adding an old, unnumbered layer
        // does not rename a layer that already has an explicit number.
        parts.forEach((part,index)=>{
            if(!used.has(part.base))used.set(part.base,new Set());
            if(part.number && !used.get(part.base).has(part.number)){
                used.get(part.base).add(part.number);assigned.set(index,part.number);
            }
        });
        return parts.map((part,index)=>{
            let number=assigned.get(index);
            if(!number){number=1;while(used.get(part.base).has(number))number++;used.get(part.base).add(number);}
            return `${part.base} ${number}`;
        });
    }
    function entries(task,overlayList=liveOverlays(task)){
        const items=[],seen=new Map();
        const labels=numberedLabels(overlayList.map(ov=>ov.slotLabel || window.ReelsLayerSlots?.describe?.(ov.slotKey)?.label || ({text:'文字层',textcard:'文字卡片',image:'媒体窗口',video:'媒体窗口',solid_mask:'色块层',scroll:'滚动文字'}[ov.type]) || '图层'));
        if(task.bgPath || task.bgClipPool?.length)items.push({key:'background',label:'背景层',kind:'background'});
        if(task.contentVideoPath)items.push({key:'content',label:'内容视频层',kind:'content'});
        for(const [index,ov] of overlayList.entries()){
            const base=ov.slotKey?`slot:${ov.slotKey}`:ov._templateOverlayId?`template:${ov._templateOverlayId}`:`layer:${index}:${ov.type}`;
            const occurrence=seen.get(base) || 0;seen.set(base,occurrence+1);
            items.push({key:`${base}:${occurrence}`,label:labels[index],kind:'overlay',ov});
        }
        const order=task.visualOverlayOrder || [];
        const base=items.filter(item=>item.kind!=='overlay'),overlays=items.filter(item=>item.kind==='overlay');
        const rank=item=>{const index=order.indexOf(item.ov._compositeOrderKey || `overlay:${item.ov.id}`);return index<0?order.length+overlays.indexOf(item):index;};
        const sorted=[...base,...overlays.slice().sort((a,b)=>rank(a)-rank(b))];
        if(hasSubtitleContent(task))sorted.push({key:'subtitle',label:'字幕轨（自动字幕）',kind:'subtitle'});
        return sorted;
    }
    const displayId=entry=>'display:'+JSON.stringify([entry.kind,entry.label]);
    const isTitleStyleEntry=entry=>{const ov=entry.ov;return !!(ov && ov.type==='textcard' && !/(?:watermark|水印)/i.test(String(ov.slotKey || '')+' '+String(ov.slotLabel || '')) && (ov.title_text || ov.enabled_slots?.title || /(?:title|标题)/i.test(String(ov.slotKey || '')+' '+String(ov.slotLabel || ''))));};
    function listLayers(tasks){
        const result=new Map();
        for(const task of tasks)for(const entry of entries(task)){
            const id=displayId(entry);
            if(!result.has(id))result.set(id,{key:id,label:entry.label,tasks:new Set(),keys:new Set()});
            result.get(id).tasks.add(task);result.get(id).keys.add(entry.key);
        }
        return [...result.values()].map(row=>({key:row.key,label:row.label,count:row.tasks.size,keys:[...row.keys]}));
    }
    function savedExclusions(){
        try{const value=JSON.parse(window.localStorage?.getItem(STORE_KEY) || '[]');return Array.isArray(value)?value.filter(key=>typeof key==='string'):[];}catch(_){return [];}
    }
    // Include label variants: two tasks can share a slot but use different names.
    const layerId=entry=>JSON.stringify([entry.key,entry.label]);
    function layerInventory(tasks){
        const rows=new Map();
        for(const task of tasks)for(const entry of entries(task)){
            const id=layerId(entry);
            if(!rows.has(id))rows.set(id,{id,key:entry.key,label:entry.label,kind:entry.kind,tasks:new Set()});
            rows.get(id).tasks.add(task);
        }
        return [...rows.values()];
    }
    function groupLayerRows(rows){
        const groups=new Map();
        for(const row of rows){
            const id=JSON.stringify([row.kind,row.label]);
            if(!groups.has(id))groups.set(id,{id,label:row.label,kind:row.kind,rows:[],tasks:new Set()});
            const group=groups.get(id);group.rows.push(row);
            for(const task of row.tasks)group.tasks.add(task);
        }
        return [...groups.values()];
    }
    function matchingTasks(tasks,ids,mode='any'){
        if(!ids.length)return [];
        return tasks.filter(task=>{
            const present=new Set(entries(task).map(layerId));
            // A displayed name can represent several original slots. Any one
            // of those slots satisfies that name, including in ALL-name mode.
            const matches=id=>(Array.isArray(id)?id:[id]).some(value=>present.has(value));
            return mode==='all'?ids.every(matches):ids.some(matches);
        });
    }
    function renameLayers(tasks,ids,name){
        name=String(name || '').trim();
        if(!name)throw new Error('请输入统一后的层名');
        const selected=new Set(ids),changes=[],changedTasks=new Set(),seen=new Set();
        for(const task of tasks){
            const matches=entries(task).filter(entry=>entry.ov && selected.has(layerId(entry)));
            const stored=entries(task,task.overlays || []);
            for(const entry of matches){
                const mirrors=[entry.ov,...stored.filter(item=>item.key===entry.key).map(item=>item.ov)];
                for(const ov of mirrors){
                    if(!ov || seen.has(ov) || (ov.slotLabel===name && ov.name===name))continue;
                    seen.add(ov);changes.push({task,key:entry.key,ov,live:ov===entry.ov,slotLabel:ov.slotLabel,name:ov.name,hadLabel:Object.hasOwn(ov,'slotLabel'),hadName:Object.hasOwn(ov,'name')});
                    ov.slotLabel=name;ov.name=name;changedTasks.add(task);
                }
            }
        }
        return {tasks:[...changedTasks],changes,undo(){
            const restore=(ov,change)=>{for(const [field,had] of [['slotLabel','hadLabel'],['name','hadName']]){
                if(change[had])ov[field]=change[field];else delete ov[field];
            }};
            for(const change of changes)restore(change.ov,change);
            // Selecting another task can replace the inspector's overlay objects.
            // Resolve the layer again so undo also reaches the current mirrors.
            for(const task of changedTasks){
                const taskChanges=changes.filter(change=>change.task===task);
                for(const live of [true,false])for(const entry of entries(task,live?liveOverlays(task):task.overlays || [])){
                    if(!entry.ov)continue;
                    const change=taskChanges.find(change=>change.key===entry.key && change.live===live) || taskChanges.find(change=>change.key===entry.key);
                    if(change)restore(entry.ov,change);
                }
            }
        }};
    }
    function qLayerSetup(dialog){
        dialog.querySelector('[data-layer-close]').classList?.add('vk-overview-close');
        dialog.querySelector('[data-layer-rename]').classList?.add('vk-overview-primary');
        dialog.querySelector('[data-layer-filter]').classList?.add('vk-overview-primary');
        const close = document.createElement('button');
        close.type = 'button'; close.className = 'vk-overview-close-top';
        close.textContent = '×'; close.setAttribute('aria-label', '关闭窗口');
        close.onclick = () => dialog.close();
        dialog.append(close);
    }
    let lastRename=null;
    function openLayerManager(tasks,options={}){
        if(!tasks.length)return null;
        document.querySelector('.reels-layer-manager')?.close();
        const dialog=document.createElement('dialog');dialog.className='reels-layer-manager';
        dialog.style.cssText='width:min(760px,92vw);max-height:88vh;overflow:auto;background:#20212b;color:#eee;border:1px solid #454758;border-radius:12px;padding:18px;font:12px system-ui';
        dialog.innerHTML='<h3>按层查找任务 / 统一修改勾选层的名称</h3><p>同名层合并成一行，勾选后查找对应任务；需要单独处理时，展开查看明细。统一名称会保留素材和布局。</p><div style="display:flex;gap:8px;flex-wrap:wrap"><input data-layer-search type="search" placeholder="搜索层名" aria-label="搜索层名"><select data-layer-mode aria-label="图层匹配方式"><option value="any">包含任意一个勾选名称</option><option value="all">同时包含全部勾选名称</option></select><button data-layer-clear>清空勾选</button></div><div data-layer-list style="display:grid;gap:8px;max-height:34vh;overflow:auto;margin:14px 0"></div><p data-layer-count role="status"></p><div style="display:flex;gap:8px;flex-wrap:wrap"><button data-layer-filter>仅显示匹配任务</button><button data-layer-select>选中匹配任务</button><button data-layer-reset>显示全部任务</button></div><div data-layer-results style="display:grid;gap:8px;max-height:22vh;overflow:auto;margin:14px 0"></div><fieldset><legend>统一勾选层的名称（当前范围内全部匹配任务）</legend><input data-layer-name placeholder="例如：画中画（主观众）" aria-label="统一后的层名"><button data-layer-rename>应用统一名称</button><button data-layer-undo>撤销上次统一命名</button><small style="display:block;margin-top:8px">背景、内容视频和字幕是固定名称，不能在此改名。改成相同名称不会合并或删除图层。</small></fieldset><p data-layer-status role="status"></p><button data-layer-close>关闭</button>';
        qLayerSetup(dialog);
        const q=selector=>dialog.querySelector(selector),checked=new Set(),expanded=new Set(),status=q('[data-layer-status]');
        let rows=layerInventory(tasks),matched=[];
        const tools=()=>window.ReelsTaskLayerTools;
        const activeFilter=tools()?.getFilterCriteria?.();
        if (!options.initialKeys && !options.initialLabels && activeFilter) {
            for (const row of rows) if (activeFilter.ids.includes(row.id)) checked.add(row.id);
            q('[data-layer-mode]').value=activeFilter.mode;
        } else {
            for(const row of rows)if(options.initialKeys?.includes(row.key) || options.initialLabels?.includes(row.label))checked.add(row.id);
        }
        const taskLabel=task=>tools()?.taskLabel(task) || `任务 ${Math.max(0,window._reelsState?.tasks?.indexOf(task) ?? tasks.indexOf(task))+1} · ${task.exportName || task.fileName || task.name || ''}`;
        function updateResults(){
            const criteria=groupLayerRows(rows).map(group=>group.rows.filter(row=>checked.has(row.id)).map(row=>row.id)).filter(ids=>ids.length);
            matched=matchingTasks(tasks,criteria,q('[data-layer-mode]').value);
            q('[data-layer-count]').textContent=criteria.length?`已勾选 ${criteria.length} 个名称，匹配 ${matched.length} / ${tasks.length} 个任务`:'勾选图层后显示对应任务';
            q('[data-layer-results]').replaceChildren();
            for(const task of matched){
                const line=document.createElement('div'),label=document.createElement('span');
                line.style.cssText='display:flex;gap:8px;align-items:center;flex-wrap:wrap';label.textContent=taskLabel(task);line.append(label);
                const taskEntries=entries(task).filter(entry=>checked.has(layerId(entry)));
                for(const entry of taskEntries){
                    const namesakes=taskEntries.filter(item=>item.label===entry.label);
                    const locate=document.createElement('button');locate.textContent=`定位：${entry.label}${namesakes.length>1?`（本任务第 ${namesakes.indexOf(entry)+1} 个）`:''}`;
                    locate.onclick=()=>{dialog.close();if(tools())tools().locate(task,entry.key);else{
                        const index=window._reelsState?.tasks?.indexOf(task);if(index>=0)window.reelsSelectTask?.(index);
                        const ov=entries(task).find(item=>item.key===entry.key)?.ov;if(ov)window._reelsState?.overlayPanel?.selectOverlay?.(ov);
                    }};line.append(locate);
                }
                q('[data-layer-results]').append(line);
            }
            for(const selector of ['[data-layer-filter]','[data-layer-select]'])q(selector).disabled=!matched.length || !tools();
            q('[data-layer-reset]').disabled=!tools();
            const targetLayers=matched.flatMap(task=>entries(task).filter(entry=>entry.ov && checked.has(layerId(entry))));
            q('[data-layer-rename]').disabled=!targetLayers.length;
            q('[data-layer-rename]').textContent=`应用统一名称（${targetLayers.length} 层）`;
            q('[data-layer-undo]').disabled=!lastRename || !lastRename.tasks.every(task=>tasks.includes(task));
        }
        function renderRows(){
            const search=q('[data-layer-search]').value.trim().toLowerCase();q('[data-layer-list]').replaceChildren();
            for(const group of groupLayerRows(rows).filter(group=>group.label.toLowerCase().includes(search))){
                const line=document.createElement('label'),input=document.createElement('input'),text=document.createElement('span'),identity=document.createElement('small');
                line.style.cssText='display:flex;gap:8px;align-items:center;flex-wrap:wrap';input.type='checkbox';
                input.checked=group.rows.every(row=>checked.has(row.id));input.indeterminate=!input.checked && group.rows.some(row=>checked.has(row.id));input.setAttribute('aria-label',group.label);
                text.textContent=`${group.label}（${group.tasks.size}/${tasks.length} 个任务）`;
                identity.textContent=group.kind==='subtitle'?'独立字幕轨，不在覆层列表中':group.kind==='overlay'?'':'固定层';identity.style.cssText='color:#aaa;font-size:11px';
                input.onchange=()=>{for(const row of group.rows)if(input.checked)checked.add(row.id);else checked.delete(row.id);renderRows();updateResults();};
                line.append(input,text,identity);
                if(group.rows.length===1){q('[data-layer-list]').append(line);continue;}
                const wrapper=document.createElement('div'),details=document.createElement('details'),summary=document.createElement('summary');
                details.open=expanded.has(group.id);details.style.cssText='margin:4px 0 6px 26px;color:#bbb';
                details.ontoggle=()=>{if(details.open)expanded.add(group.id);else expanded.delete(group.id);};
                summary.textContent=`展开 ${group.rows.length} 个明细`;details.append(summary);
                for(const [index,row] of group.rows.entries()){
                    const detail=document.createElement('label'),check=document.createElement('input'),label=document.createElement('span');
                    detail.style.cssText='display:flex;gap:8px;align-items:center;margin:7px 0';check.type='checkbox';check.checked=checked.has(row.id);
                    label.textContent=`明细 ${index+1}（${row.tasks.size} 个任务）`;
                    check.onchange=()=>{if(check.checked)checked.add(row.id);else checked.delete(row.id);expanded.add(group.id);renderRows();updateResults();};
                    detail.append(check,label);details.append(detail);
                }
                wrapper.append(line,details);q('[data-layer-list]').append(wrapper);
            }
        }
        function saveChanges(changed){
            const panel=window._reelsState?.overlayPanel;panel?._refreshList?.();panel?._refreshBatchSlotSchema?.();
            if(panel?._selectedOv)panel.selectOverlay?.(panel._selectedOv);
            window._syncTasksToActiveTab?.();window._batchAutoSave?.({skipSync:true});window.reelsSaveHistory?.();
            tools()?.changed(changed);
        }
        q('[data-layer-search]').oninput=renderRows;q('[data-layer-mode]').onchange=updateResults;
        q('[data-layer-clear]').onclick=()=>{checked.clear();renderRows();updateResults();};
        q('[data-layer-filter]').onclick=()=>{const found=[...matched],criteria={ids:[...checked],mode:q('[data-layer-mode]').value};dialog.close();tools()?.filter(found,criteria);};
        q('[data-layer-select]').onclick=()=>{tools()?.select(matched);status.textContent=`已选中 ${matched.length} 个任务，可关闭窗口后批量编辑。`;};
        q('[data-layer-reset]').onclick=()=>{dialog.close();tools()?.filter(null);};
        q('[data-layer-rename]').onclick=()=>{
            try{
                const selected=rows.filter(row=>checked.has(row.id));
                const change=renameLayers(matched,[...checked],q('[data-layer-name]').value);
                if(!change.changes.length){status.textContent='所选层名称已一致，无需修改';return;}
                lastRename=change;saveChanges(change.tasks);
                status.textContent=`已统一 ${change.tasks.length} 个任务中的层名，可撤销。`;
                const keys=new Set(selected.map(row=>row.key));rows=layerInventory(tasks);checked.clear();
                for(const row of rows)if(keys.has(row.key) && labelParts(row.label).base===labelParts(q('[data-layer-name]').value).base)checked.add(row.id);
                renderRows();updateResults();
            }catch(error){status.textContent=error.message;}
        };
        q('[data-layer-undo]').onclick=()=>{if(!lastRename)return;const change=lastRename;change.undo();lastRename=null;saveChanges(change.tasks);rows=layerInventory(tasks);checked.clear();renderRows();updateResults();status.textContent='已撤销上次统一命名';};
        q('[data-layer-close]').onclick=()=>dialog.close();dialog.onclose=()=>dialog.remove();
        dialog.addEventListener('keydown',event=>event.stopPropagation());
        document.body.append(dialog);renderRows();updateResults();dialog.showModal();return dialog;
    }
    function selectedEntries(task,options){
        const excluded=new Set(options.excludedLayers ?? savedExclusions());
        const included=options.includedLayers===undefined?null:new Set(options.includedLayers);
        return entries(task).filter(entry=>!excluded.has(entry.key) && !excluded.has(displayId(entry)) && (!included || included.has(entry.key) || included.has(displayId(entry))));
    }
    function windowRect(ov,width,height){
        const isFullMask=ov.fullscreen_mask===true || ov.fullscreen_mask===1 || ov.fullscreen_mask==='1';
        if(isFullMask && ['textcard','solid_mask'].includes(ov.type))return {x:0,y:0,w:width,h:height};
        let rect;
        if(['top_half','bottom_half'].includes(ov.media_window_mode)){
            const half=window.ReelsMediaWindow?.halfScreen?.(ov.media_window_mode,ov.media_split_angle,width,height);
            rect=half?.rect || {x:0,y:ov.media_window_mode==='top_half'?0:height/2,w:width,h:height/2};
        }else if(ov.media_window_mode==='pip' && ['image','video'].includes(ov.type)){
            const saved=ov.media_window || {};
            const bx=Number.isFinite(Number(saved.x))?Number(saved.x):n(ov.x);
            const by=Number.isFinite(Number(saved.y))?Number(saved.y):n(ov.y);
            const bw=Number(saved.w)>0?Number(saved.w):n(ov.w,100);
            const bh=Number(saved.h)>0?Number(saved.h):n(ov.h,100);
            const sx=Math.max(.01,n(ov.scale_x,n(ov.scale,1))),sy=Math.max(.01,n(ov.scale_y,n(ov.scale,1)));
            rect={x:bx+(bw-bw*sx)/2,y:by+(bh-bh*sy)/2,w:bw*sx,h:bh*sy};
        }else{
            const base=ov.media_window_mode?ov.media_window || ov:ov;
            const w=n(base.w,n(ov.w)),h=n(base.h,n(ov.h));
            const sx=Math.max(.01,n(ov.scale_x,n(ov.scale,1))),sy=Math.max(.01,n(ov.scale_y,n(ov.scale,1)));
            rect={x:n(base.x,n(ov.x))+(w-w*sx)/2,y:n(base.y,n(ov.y))+(h-h*sy)/2,w:w*sx,h:h*sy};
            if(!ov.media_window_mode && ov.clip_rect && Number(ov.clip_rect.w)>0 && Number(ov.clip_rect.h)>0){
                rect={x:n(ov.clip_rect.x),y:n(ov.clip_rect.y),w:Number(ov.clip_rect.w),h:Number(ov.clip_rect.h)};
            }
        }
        const cropPct=key=>Math.max(0,Math.min(99,Number(ov[key]) || 0));
        const cropLeft=cropPct('media_crop_left'),cropTop=cropPct('media_crop_top');
        const cropRight=Math.min(cropPct('media_crop_right'),99-cropLeft),cropBottom=Math.min(cropPct('media_crop_bottom'),99-cropTop);
        if(cropLeft || cropTop || cropRight || cropBottom){
            return {
                x:rect.x+rect.w*cropLeft/100,
                y:rect.y+rect.h*cropTop/100,
                w:Math.max(1,rect.w*(100-cropLeft-cropRight)/100),
                h:Math.max(1,rect.h*(100-cropTop-cropBottom)/100),
            };
        }
        return rect;
    }
    const rectText=rect=>`左上角位置(${fmt(rect.x)},${fmt(rect.y)})，宽${fmt(rect.w)}px、高${fmt(rect.h)}px`;
    function textStyle(ov,prefix=''){
        const card=!!prefix,p=prefix?prefix+'_':'';
        const family=ov[p+'font_family'] || (prefix==='title'?'Crimson Pro':'Arial');
        const size=n(ov[p+'fontsize'],prefix==='title'?60:40);
        const weight=n(ov[p+'font_weight'],ov[p+'bold']?700:400);
        const result=[`字体${family}，保存字号${fmt(size)}px，字重${weight}，字色${ov[p+'color'] || '#FFFFFF'}，${align(ov[p+'align'] || ov.text_layout?.align || 'center')}`];
        if(ov[p+'uppercase'])result.push('英文转为大写');
        if(ov[p+'italic'])result.push('使用斜体');
        if(n(ov[p+'letter_spacing']))result.push(`额外字间距${fmt(ov[p+'letter_spacing'])}px`);
        if(n(ov[p+'line_spacing']))result.push(`额外行间距${fmt(ov[p+'line_spacing'])}px`);
        const effects=card?(ov.independent_effects?p:'text_'):'';
        if(n(ov[effects+'stroke_width'])>0 && (card || ov.use_stroke))result.push(`文字描边${ov[effects+'stroke_color'] || '#000000'}、${fmt(ov[effects+'stroke_width'])}px`);
        if(n(ov[effects+'shadow_blur'])>0 && (card || ov.shadow_enabled))result.push(`文字阴影${ov[effects+'shadow_color'] || '#000000'}，模糊${fmt(ov[effects+'shadow_blur'])}px，偏移(${fmt(ov[effects+'shadow_x'] ?? ov.shadow_offset_x)},${fmt(ov[effects+'shadow_y'] ?? ov.shadow_offset_y)})`);
        if(ov[p+'bg_enabled'] && (!card || ov.independent_effects)){
            result.push(`背景${ov[p+'bg_color'] || '#000000'}，不透明度${card?fmt(ov[p+'bg_opacity'] ?? 60):pct(ov.bg_opacity)}%，圆角${fmt(ov[p+'bg_radius'])}px`);
            result.push(`背景${ov[p+'bg_mode']==='inline'?'随每行文字分别显示':'为整块色块'}，左右内边距各${fmt(ov[p+'bg_pad_h'] ?? ov.bg_padding)}px，上${fmt(ov[p+'bg_pad_top'] ?? ov.bg_padding)}px，下${fmt(ov[p+'bg_pad_bottom'] ?? ov.bg_padding)}px`);
            if(ov[p+'bg_border_enabled'])result.push(`背景边框${ov[p+'bg_border_color']}、${fmt(ov[p+'bg_border_width'])}px、${ov[p+'bg_border_style']==='dashed'?'虚线':'实线'}`);
        }
        return result.join('；')+'。';
    }
    function describeScroll(ov){
        const lines=[],on=v=>v?'开启':'关闭';
        const dx=n(ov.scroll_offset_x),dy=n(ov.scroll_offset_y),x=n(ov.x)+dx,y=n(ov.y)+dy,w=n(ov.w),h=n(ov.h);
        const rawX=n(ov.scroll_from_x,x+w/2),rawToX=n(ov.scroll_to_x,rawX);
        const legacy=ov.scroll_x_anchor==null && Math.abs(rawX-90)<.001 && Math.abs(rawToX-90)<.001;
        const centered=ov.scroll_x_anchor==='center' || legacy;
        const fromX=legacy?x+w/2:rawX+dx,toX=legacy?x+w/2:rawToX+dx;
        const fromY=n(ov.scroll_from_y,y+h)+dy,toY=n(ov.scroll_to_y,y-500)+dy;
        lines.push(`滚动覆层可视裁切区：${rectText({x,y,w,h})}；整体偏移(${fmt(dx)},${fmt(dy)})px已计入；超出裁切区的正文不显示。`);
        lines.push(`正文排版：字体${ov.font_family || 'Arial'}，保存字号${fmt(ov.fontsize || 40)}px，字重${ov.font_weight ?? (ov.bold?700:400)}，字色${ov.color || '#FFFFFF'}，${align(ov.text_align || 'center')}，斜体${on(ov.italic)}；文字宽${fmt(ov.text_width || w-40)}px，按宽度自动换行，额外行距${fmt(ov.line_spacing ?? 6)}px，字间距${fmt(ov.scroll_letter_spacing)}px；英文大写${on(ov.scroll_uppercase!==false)}，文字方向${({auto:'自动',ltr:'从左到右',rtl:'从右到左'})[ov.text_direction || 'auto'] || ov.text_direction}。`);
        lines.push(`正文描边${on(ov.use_stroke)}${ov.use_stroke?`，${ov.stroke_color || '#000000'}、${fmt(ov.stroke_width || 2)}px`:''}；阴影${on(ov.shadow_enabled)}${ov.shadow_enabled?`，${ov.shadow_color || '#000000'}、不透明度${pct(ov.shadow_opacity || 120)}%，模糊${fmt(ov.shadow_blur || 4)}px，偏移(${fmt(ov.shadow_offset_x || 2)},${fmt(ov.shadow_offset_y || 2)})px`:''}。`);
        lines.push(`滚动路径：${centered?'文字中心轴X':'文字左边缘X'}，Y为文字块顶部；起点(${fmt(fromX)},${fmt(fromY)})，设定终点(${fmt(toX)},${fmt(toY)})。`);
        lines.push(ov.scroll_static?'固定显示开启：正文Y固定在正文裁切区顶部加顶部羽化及偏移处；固定且非独立的标题占用空间。水平位置仍按起终点插值。':'滚动显示：按覆层起止时间在线性进度内从起点移动至终点；提前完成'+fmt(Math.max(0,n(ov.scroll_auto_stop_lead)))+'秒，有效滚动时长至少0.1秒。');
        lines.push(`显示时间：${fmt(ov.start)}秒至${n(ov.end,9999)>=9999?'实际媒体结束（预览或导出时长）':fmt(ov.end)+'秒'}。自动停止${on(ov.scroll_auto_stop)}${ov.scroll_auto_stop?'：最终Y按文字实际高度、标题占位和上下羽化重新计算；短文尽量完整可见，长文使末端停在可视边缘，停下后保持显示，设定终点Y不作为最终停点':''}。`);
        lines.push(`正文自动缩小适配${on(ov.scroll_auto_fit)}${ov.scroll_auto_fit?`，最小字号${fmt(ov.scroll_min_fontsize ?? 16)}px；保存字号为起始值，最终字号受文字和可用空间影响`:''}。`);
        for(const side of ['top','bottom','left','right'])lines.push(`${({top:'顶部',bottom:'底部',left:'左侧',right:'右侧'})[side]}羽化${fmt(ov['feather_'+side] ?? (['top','bottom'].includes(side)?80:0))}px，羽化偏移${fmt(ov['feather_'+side+'_offset'])}px。`);
        const bg=(prefix,label)=>{
            if(!ov[prefix+'_bg_enabled'])return;
            lines.push(`${label}背景：${({inline:'逐行包裹','inline-joined':'逐行包裹',block:'整块'})[ov[prefix+'_bg_mode']] || '整块'}，${ov[prefix+'_bg_color'] || '#000000'}，不透明度${fmt(ov[prefix+'_bg_opacity'] ?? 60)}%，圆角${fmt(ov[prefix+'_bg_radius'] ?? 12)}px；左右内边距各${fmt(ov[prefix+'_bg_pad_h'])}px，上${fmt(ov[prefix+'_bg_pad_top'])}px，下${fmt(ov[prefix+'_bg_pad_bottom'])}px。`);
        };
        bg('scroll_body','正文');
        if(String(ov.scroll_title || '').trim()){
            lines.push(`滚动覆层标题：${ov.scroll_title_fixed!==false?'固定在顶部，不随正文滚动':'随正文一起滚动'}；${ov.scroll_title_independent?'独立布局，不为正文预留标题空间':'为正文预留标题高度及间距'}。字体${ov.scroll_title_font_family || ov.font_family || 'Arial'}，字号${fmt(ov.scroll_title_fontsize ?? 56)}px，字重${ov.scroll_title_font_weight ?? (ov.scroll_title_bold?700:400)}，字色${ov.scroll_title_color || ov.color || '#FFFFFF'}，${align(ov.scroll_title_align || ov.text_align || 'center')}；标题宽${fmt(ov.scroll_title_text_width || ov.text_width || w-40)}px，额外行距${fmt(ov.scroll_title_line_spacing ?? ov.line_spacing ?? 6)}px，字间距${fmt(ov.scroll_title_letter_spacing)}px，标题正文间距${fmt(ov.scroll_title_gap ?? 20)}px；英文大写${on(ov.scroll_title_uppercase!==false)}。`);
            if(ov.scroll_title_fixed!==false)lines.push(`固定标题位置：水平参考点${fmt(ov.scroll_title_x!=null?n(ov.scroll_title_x)+dx:fromX)}px（${centered?'中心轴':'左边缘'}），顶部Y ${fmt(ov.scroll_title_y!=null?n(ov.scroll_title_y)+dy:y)}px；固定标题不受正文裁切。`);
            lines.push(`标题自动缩小${on(ov.scroll_title_auto_fit)}，最大高度${n(ov.scroll_title_max_height)>0?fmt(ov.scroll_title_max_height)+'px':'未限制'}，最小字号${fmt(ov.scroll_min_fontsize ?? 16)}px；标题描边${ov.scroll_title_stroke_color || '#000000'}、${fmt(ov.scroll_title_stroke_width)}px。`);
            if(ov.scroll_title_shadow_enabled ?? ov.shadow_enabled)lines.push(`标题阴影：${ov.scroll_title_shadow_color || ov.shadow_color || '#000000'}，模糊${fmt(ov.scroll_title_shadow_blur ?? ov.shadow_blur ?? 4)}px，偏移(${fmt(ov.scroll_title_shadow_x ?? ov.shadow_offset_x ?? 2)},${fmt(ov.scroll_title_shadow_y ?? ov.shadow_offset_y ?? 2)})px。`);
            bg('scroll_title','标题');
            if(ov.scroll_title_deco_enabled)lines.push(`标题装饰线：位置${ov.scroll_title_deco_position || 'bottom'}，样式${ov.scroll_title_deco_style || 'solid'}，颜色${ov.scroll_title_deco_color || '#FFD700'} / ${ov.scroll_title_deco_color2 || '#FF6B35'}，渐变方向${ov.scroll_title_deco_gradient_direction || 'horizontal'}，粗细${fmt(ov.scroll_title_deco_thickness ?? 3)}px，长度${n(ov.scroll_title_deco_length)>0?fmt(ov.scroll_title_deco_length)+'px':'自动'}，间距${fmt(ov.scroll_title_deco_gap ?? 12)}px，不透明度${fmt(ov.scroll_title_deco_opacity ?? 100)}%，${align(ov.scroll_title_deco_align || 'center')}。`);
        }
        if(ov.bg_enabled || ov.bg_blur_enabled || ov.bg_border_enabled){
            lines.push(`整张卡片：${ov.bg_fullscreen?'覆盖全画布':'包围裁切区'}；背景${on(ov.bg_enabled)}${ov.bg_enabled?`，${ov.bg_color || '#000000'}、不透明度${pct(ov.bg_opacity || 191)}%`:''}；圆角${fmt(ov.bg_radius || 12)}px，外扩上/下/左/右 ${[ov.bg_padding_top ?? 16,ov.bg_padding_bottom ?? 16,ov.bg_padding_left ?? 16,ov.bg_padding_right ?? 16].map(fmt).join('/')}px；磨砂模糊${on(ov.bg_blur_enabled)}${ov.bg_blur_enabled?'，强度'+fmt(ov.bg_blur_amount ?? 10)+'px':''}。`);
            if(ov.bg_border_enabled)lines.push(`卡片边框：${ov.bg_border_color || '#FFD700'}，宽${fmt(ov.bg_border_width ?? 3)}px，样式${ov.bg_border_style || 'solid'}，边${ov.bg_border_sides || 'all'}，不透明度${fmt(ov.bg_border_opacity ?? 100)}%。`);
        }
        if(ov.transition_preset && ov.transition_preset!=='none')lines.push(`覆层转场：${ov.transition_preset}，时长${fmt(ov.transition_duration ?? .35)}秒。`);
        if(ov.scroll_styled_ranges?.length || ov.scroll_title_styled_ranges?.length)lines.push('存在局部富文本样式；需同时提供原文及富文本范围数据以还原局部效果。');
        return lines;
    }
    // Describe the resolved rendering style, including defaults, rather than preset names.
    function describeSubtitle(task,width,height,resolvedStyle){
        const defaults=window.ReelsStyleEngine?.DEFAULT_SUBTITLE_STYLE || {};
        const base={...defaults,...(resolvedStyle ?? subtitleStyle(task))};
        const names={none:'无',fade:'淡入淡出',slide_up:'上滑',slide_down:'下滑',slide_left:'左滑',slide_right:'右滑',pop:'弹出',typewriter:'打字机',char_bounce:'逐字弹跳',letter_jump:'逐字放大',word_pop_random:'逐词随机弹出',word_pop_random_pulse:'逐词回弹',metronome:'节奏逐词',blur_sharp:'模糊渐清',holy_glow:'圣光',floating:'漂浮',bullet_reveal:'逐行出现',flash_highlight:'闪光高亮',ease_out:'缓出',ease_in:'缓入',ease_in_out:'缓入缓出',linear:'匀速',center:'居中',left:'左对齐',right:'右对齐',auto:'自动',ltr:'从左到右',rtl:'从右到左',horizontal:'水平',vertical:'垂直'};
        Object.assign(names,{fixed:'固定范围',adaptive:'自适应范围',final:'最终视频时长',audio:'音频时长',subtitle:'字幕时长',lyrics:'歌词跟随',uniform:'匀速滚动',uppercase:'转大写',lowercase:'转小写',capitalize:'首字母大写',char:'逐字',word:'逐词',all:'四边',solid:'实线',dashed:'虚线',top:'顶部',bottom:'底部',both:'双向',rect:'矩形',tint:'按颜色染色',normal:'正常',lighter:'叠加增亮',radial:'径向',bars:'柱状',curve:'曲线',zigzag:'折线',dots:'圆点',hearts:'心形',behind:'文字后方'});
        const motionDescriptions={
            fade:['淡入淡出','通过透明度渐变显示或隐藏字幕'], slide_up:['上滑','字幕沿垂直方向向上滑动'], slide_down:['下滑','字幕沿垂直方向向下滑动'], slide_left:['左滑','字幕向左滑动'], slide_right:['右滑','字幕向右滑动'], pop:['弹出','字幕通过缩放产生弹出效果'], typewriter:['打字机','文字按时间逐步显现'],
            char_bounce:['逐字弹跳','文字逐字弹跳'], letter_jump:['逐字放大','文字逐字放大'], word_pop_random:['逐词随机弹出','按词出现，并以随机缩放形成弹出效果'], word_pop_random_pulse:['逐词回弹','按词出现并产生缩放回弹'], metronome:['节奏逐词','按节拍推进逐词效果'], blur_sharp:['模糊渐清','文字从模糊逐渐变清晰'], holy_glow:['圣光','文字呈现周期性光晕'], floating:['漂浮','文字周期性上下浮动'], bullet_reveal:['逐行出现','各行按间隔依次出现'], flash_highlight:['闪光高亮','文字出现短暂高亮闪光'],
            char_float_up:['逐字上浮','字符依次向上浮现'], char_pop_elastic:['逐字弹性放大','字符依次弹性放大'], char_wave:['逐字波浪','字符依次形成波浪运动'], char_drop_bounce:['逐字落下回弹','字符依次落下并回弹'], char_squash_bounce:['逐字挤压弹跳','字符依次挤压并弹跳'], char_center_spread:['中心扩散','字符从中心向两侧展开'],
            scatter_pop:['随机散布弹出','词语在指定区域内随机排布并弹出'], word_random_position:['逐词随机位置','词语在指定区域内以不同位置和大小出现'], box_wipe:['底条进度擦除','底条随字幕进度产生擦除效果'], zoom_typewriter:['远景打字推进','文字逐步显现，同时画面文字进行缩放推进'], line_focus:['双行焦点放大','突出当前行，其余行缩小'], underline_sweep:['底线扫描显字','底线扫描并逐步显现文字'], three_word_focus_stack:['三词叠排（中词放大）','词语叠排，突出放大中间词'], rolling_rainbow_karaoke:['四行滚词（彩虹跟读）','词语滚动排列，并以彩虹色突出跟读进度'], kinetic_glow_stack:['黄绿辉光逐词叠排','词语逐步叠排弹出，并配合辉光和背景压暗']
        };
        for(const [key,[label]] of Object.entries(motionDescriptions))names[key]=label;
        const val=v=>typeof v==='boolean'?(v?'开启':'关闭'):Array.isArray(v)?v.map(val).join('、'):names[v] || String(v ?? '未设置');
        function styleLines(s){
            const lines=[],coord=(v,total)=>typeof v==='number' && v<=1?v*total:n(v,total/2);
            lines.push(`中心参考点(${fmt(coord(s.pos_x ?? .5,width))},${fmt(coord(s.pos_y ?? .5,height))})；字体${s.font_family || 'Arimo'}，字号${fmt(s.fontsize ?? 74)}px，字重${s.font_weight ?? (s.bold===false?400:700)}，斜体${val(!!s.italic)}，字色${s.color_text || '#FFFFFF'}，整体不透明度${fmt(n(s.opacity_text_global,1)*100)}%，旋转${fmt(s.rotation)}°。`);
            lines.push(`排版：文字方向${val(s.text_direction || 'auto')}，大小写处理${val(s.text_transform || 'none')}；自动换行${val(s.auto_wrap!==false)}，换行宽度为画布${s.wrap_width_percent ?? 90}%，行数设置${s.wrap_lines ?? 2}；行距倍数${s.line_spacing ?? 1.2}，字间距${fmt(s.letter_spacing)}px，词间距${fmt(s.word_spacing)}px。`);
            const params=(title,defs)=>{
                const values=defs.split('|').map(pair=>pair.split(':')).filter(([key])=>s[key]!==undefined).map(([key,label])=>`${label}＝${val(s[key])}`);
                if(values.length)lines.push(title+'：'+values.join('；')+'。');
            };
            lines.push(`文字描边${val(!!s.use_stroke)}；整句背景${val(!!s.use_box)}；逐词文字高亮${val(!!s.karaoke_highlight)}；逐词背景框${val(!!s.dynamic_box)}；只显示当前词${val(!!s.only_show_active_word)}。`);
            if(s.use_stroke)params('描边','border_width:宽度(px)|color_outline:颜色|opacity_outline:不透明度(0–255)');
            if(n(s.shadow_blur)>0 || n(s.shadow_offset_x) || n(s.shadow_offset_y))params('文字阴影','color_shadow:颜色|opacity_shadow:不透明度(0–255)|shadow_blur:模糊(px)|shadow_offset_x:水平偏移(px)|shadow_offset_y:垂直偏移(px)');
            if(s.use_box)params('整句背景','color_bg:颜色|opacity_bg:不透明度(0–255)|box_padding_x:水平内边距(px)|box_padding_y:垂直内边距(px)|box_radius:圆角(px)|box_blur:模糊(px)|box_adaptive_width:宽度随文字适配|box_brush_style:笔刷形状|box_brush_color_mode:笔刷着色方式|box_brush_w:笔刷宽(px)|box_brush_h:笔刷高(px)|box_brush_x:笔刷水平偏移(px)|box_brush_y:笔刷垂直偏移(px)|box_brush_solid:笔刷实心度(%)');
            if(s.karaoke_highlight || s.scrolling_word_highlight)params('朗读到的词变色','color_high:高亮颜色|high_gradient_direction:渐变方向');
            if(s.dynamic_box)params('跟随当前朗读词的背景框','color_high_bg:颜色|opacity_high_bg:不透明度(0–1)|dynamic_radius:圆角(px)|high_padding:内边距(px)|high_offset_y:垂直偏移(px)|dynamic_box_stroke:框描边|dynamic_box_stroke_width:框描边宽(px)|dyn_box_anim:框弹性动画|dyn_box_anim_overshoot:回弹倍率|dyn_box_anim_duration:动画时长(秒)');
            for(const [phase,label] of [['in','入场'],['out','退场']])lines.push(`${label}动画：${val(s['anim_'+phase+'_type'] || 'none')}，时长${fmt(s['anim_'+phase+'_duration'])}秒，缓动${val(s['anim_'+phase+'_easing'] || 'ease_out')}。`);
            for(const [phase,label] of [['in','入场'],['out','退场']]){
                const type=s['anim_'+phase+'_type'];
                if(motionDescriptions[type])lines.push(`${label}效果说明：${motionDescriptions[type][1]}。`);
            }
            const activeTypes=new Set([s.anim_in_type,s.anim_out_type]);
            if([...activeTypes].some(type=>['char_float_up','char_pop_elastic','char_wave','char_drop_bounce','char_squash_bounce','char_center_spread'].includes(type)))params('逐字动画参数','char_anim_duration:每字时长(秒)|char_anim_intensity:动作强度|char_anim_stagger:逐字间隔(秒)');
            if(activeTypes.has('scatter_pop') || activeTypes.has('word_random_position'))params('随机位置参数','scatter_max_words:最多显示词数|scatter_seed:随机种子|scatter_min_scale:最小缩放|scatter_max_scale:最大缩放|scatter_min_rotate:最小旋转角度|scatter_max_rotate:最大旋转角度|scatter_accum_prob:累积概率|scatter_area_left:区域左边界(%)|scatter_area_right:区域右边界(%)|scatter_area_top:区域上边界(%)|scatter_area_bottom:区域下边界(%)');
            if(activeTypes.has('zoom_typewriter'))params('打字推进参数','zoom_tw_start_scale:起始缩放|zoom_tw_end_scale:结束缩放');
            if(activeTypes.has('line_focus') || s.active_line_focus_enabled)params('行焦点参数','inactive_line_scale:非焦点行缩放');
            if(activeTypes.has('three_word_focus_stack'))params('三词叠排参数','three_word_hero_scale:中间词缩放');
            if(activeTypes.has('rolling_rainbow_karaoke'))params('彩虹跟读参数','rolling_rainbow_colors:彩虹颜色序列');
            if(activeTypes.has('kinetic_glow_stack'))params('辉光叠排参数','kinetic_group_words:每组词数|kinetic_scale_min:最小缩放|kinetic_scale_max:最大缩放|kinetic_line_gap:行距|kinetic_pop_duration:弹出时长(秒)|kinetic_old_word_opacity:已出现词不透明度|kinetic_old_glow_opacity:旧词辉光不透明度|kinetic_glow_color:辉光颜色|kinetic_glow_blur:辉光模糊|kinetic_background_dim:背景压暗|kinetic_tint_opacity:色调不透明度|kinetic_vignette_strength:暗角强度|kinetic_vignette_radius:暗角半径|kinetic_spotlight_opacity:聚光不透明度');
            if(s.scrolling_mode){
                lines.push(`滚动字幕：${s.scrolling_motion==='uniform'?'全文匀速滚动，按所选时长来源计算滚动速度':'歌词跟随滚动，按字幕时间推进并突出当前句'}；上下文行不透明度${fmt(n(s.scrolling_opacity_context,.3)*100)}%。`);
                params('滚动区域与节奏','scrolling_width_percent:区域宽(画布%)|scrolling_height_percent:区域高(画布%)|scrolling_visible_lines:可见行数|scrolling_line_spacing:额外行距(px)|scrolling_range_mode:范围模式|scrolling_duration_source:时长来源|scrolling_initial_lines:开始可见行数|scrolling_final_lines:结束可见行数|scrolling_end_early:提前结束(秒)|scrolling_feather_top:顶部羽化|scrolling_feather_bottom:底部羽化|scrolling_inset_top:上内缩(px)|scrolling_inset_bottom:下内缩(px)|scrolling_inset_left:左内缩(px)|scrolling_inset_right:右内缩(px)|scrolling_word_highlight:逐词高亮');
            }
            const groups=[
                [s.scrolling_mode && s.scrolling_card_enabled,'滚动字幕卡片','scrolling_card_color:颜色|scrolling_card_opacity:不透明度(%)|scrolling_card_radius:圆角(px)|scrolling_card_fullscreen:全屏|scrolling_card_padding_top:上内边距(px)|scrolling_card_padding_bottom:下内边距(px)|scrolling_card_padding_left:左内边距(px)|scrolling_card_padding_right:右内边距(px)|scrolling_card_border_enabled:边框|scrolling_card_border_sides:边框方向|scrolling_card_border_color:边框颜色|scrolling_card_border_width:边框宽(px)|scrolling_card_border_style:边框样式|scrolling_card_border_opacity:边框不透明度(%)|scrolling_card_blur_enabled:背景模糊|scrolling_card_blur_amount:模糊量|scrolling_card_feather_enabled:羽化|scrolling_card_feather_direction:羽化方向|scrolling_card_feather_start:羽化起点(%)|scrolling_card_feather_end:羽化终点(%)'],
                [s.advanced_textbox_enabled,'高级文本框（像素坐标）','advanced_textbox_x:左上角X|advanced_textbox_y:左上角Y|advanced_textbox_w:宽|advanced_textbox_h:高|advanced_textbox_align:水平对齐|advanced_textbox_valign:垂直对齐|adv_line_spacing:行距倍数|adv_bg_enabled:背景|adv_bg_offset_x:背景偏移X|adv_bg_offset_y:背景偏移Y|adv_bg_w:背景宽|adv_bg_h:背景高|adv_bg_radius:背景圆角|adv_bg_color:背景色|adv_bg_opacity:背景不透明度(0–1)|adv_stroke_enabled:描边|adv_stroke_width:描边宽|adv_stroke_color:描边色'],
                [s.fullpage_typewriter || s.anim_in_type==='typewriter','打字机逐步显字','fullpage_typewriter:整页模式|fullpage_typewriter_reveal_type:显字单位|fullpage_typewriter_align:对齐|fullpage_typewriter_cursor:光标|fullpage_typewriter_cursor_char:光标字符|fullpage_typewriter_cursor_color:光标颜色|fullpage_typewriter_first_line_bold:首行加粗|fullpage_typewriter_first_line_scale:首行缩放|fullpage_typewriter_first_line_color:首行颜色|tw_revealed_color:已显字颜色|tw_revealed_opacity:已显字不透明度(0–1)|tw_unrevealed_color:未显字颜色|tw_unrevealed_opacity:未显字不透明度(0–1)'],
                [s.stroke_expand_enabled,'多层扩展描边','stroke_expand_layers:层数|stroke_expand_step:扩展步长(px)|stroke_expand_feather:羽化|stroke_expand_colors:各层颜色|stroke_expand_layer_widths:各层宽(px)|stroke_expand_layer_feathers:各层羽化'],
                [s.ambient_glow_enabled,'文字环境光','ambient_glow_color:颜色|ambient_glow_radius:半径(px)|ambient_glow_opacity:不透明度(0–1)|ambient_glow_blend_mode:混合模式'],
                [s.ambient_lighting_enabled,'环境压暗','ambient_dark_color:颜色|ambient_dark_opacity:外围不透明度(0–1)|ambient_dark_center_opacity:中心不透明度(0–1)|ambient_dark_radius:半径比例'],
                [s.global_mask_enabled,'全局画面蒙版','global_mask_color:颜色|global_mask_opacity:不透明度(0–1)'],
                [s.bg_gradient_enabled,'背景渐变','bg_gradient_type:类型|bg_gradient_colors:颜色序列|bg_gradient_highlight:高亮'],
                [s.speed_trail_enabled,'速度拖影','speed_trail_layers:层数|speed_trail_step:步长(px)|speed_trail_color:颜色|speed_trail_opacity:不透明度'],
                [s.block_typography_enabled,'方块排版（各行适配宽度）','block_scale_min:最小缩放|block_scale_max:最大缩放'],
                [s.spectrum_enabled,'音频频谱','spectrum_bands:频带数|spectrum_bar_width:柱宽(px)|spectrum_bar_gap:柱间距(px)|spectrum_max_height:最大高度(px)|spectrum_color_bottom:底色|spectrum_color_top:顶色|spectrum_position:位置|spectrum_shape:形状|spectrum_dual:双频谱|spectrum_top_shape:顶部形状|spectrum_opacity:不透明度(0–1)|spectrum_roundness:圆角'],
                [s.use_underline,'文字下划线','color_underline:颜色'],
                [s.box_transition_enabled,'背景框颜色过渡','box_transition_color_to:目标颜色']
            ];
            for(const [enabled,title,defs] of groups)if(enabled)params(title,defs);
            const animations={char_bounce:'char_bounce_height:弹跳高度(px)|char_bounce_stagger:逐字间隔(秒)',letter_jump:'letter_jump_scale:放大倍率|letter_jump_duration:持续时间(秒)',word_pop_random:'word_pop_random_min_scale:最小倍率|word_pop_random_max_scale:最大倍率|word_pop_random_duration:持续时间(秒)|word_pop_random_unread_opacity:未读不透明度(0–1)|word_pop_random_read_opacity:已读不透明度(0–1)',word_pop_random_pulse:'word_pop_random_pulse_min_scale:最小倍率|word_pop_random_pulse_max_scale:最大倍率|word_pop_random_pulse_duration:回弹时长(秒)',floating:'floating_amplitude:浮动幅度(px)|floating_period:周期(秒)',metronome:'metronome_bpm:每分钟节拍|metro_read_color:已读色|metro_read_opacity:已读不透明度(0–1)|metro_unread_color:未读色|metro_unread_opacity:未读不透明度(0–1)',blur_sharp:'blur_sharp_max:最大模糊|blur_sharp_clear_frac:变清时长比例',holy_glow:'holy_glow_radius:光晕半径(px)|holy_glow_color:光晕色|holy_glow_period:周期(秒)',bullet_reveal:'bullet_stagger:逐行间隔(秒)',flash_highlight:'flash_color:闪光色|flash_duration:闪光时长(秒)'};
            for(const type of new Set([s.anim_in_type,s.anim_out_type]))if(animations[type])params(val(type)+'细节',animations[type]);
            if(s.dyn_box_image_enabled){lines.push('动态框图片效果开启；图片素材须另行提供。');params('动态框图片布局','dyn_box_image_scale:缩放倍率|dyn_box_image_offset_x:水平偏移(px)|dyn_box_image_offset_y:垂直偏移(px)|dyn_box_image_blend:混合方式');}
            if(s.color_text?.includes('gradient'))params('文字渐变','text_gradient_direction:方向');
            if(s.advanced_textbox_enabled && s.adv_bg_gradient_enabled)params('高级文本框背景渐变','adv_bg_gradient_type:类型|adv_bg_gradient_colors:颜色序列|adv_bg_gradient_highlight:高亮');
            if(s.box_custom_brush_data)lines.push('使用自定义笔刷；笔刷资源须另行提供。');
            if(n(s.random_word_spacing) || n(s.random_line_spacing))params('随机排版','random_word_spacing:随机词距|random_line_spacing:随机行距|random_spacing_seed:随机种子|random_position_use_layout_range:使用布局范围|random_position_height_percent:随机位置高度(%)');
            return lines;
        }
        const lines=['动态字幕效果说明：',...styleLines(base),`与覆层叠放关系：${task.overlayAboveSubtitle!==false?'覆层在动态字幕上方':'动态字幕在覆层上方'}。`];
        lines.push('普通字幕按各句起止时间显示，匀速滚动按全文和选定时长推进；逐词效果依赖词级时间。文字、断行及逐句/逐词时间数据需另行提供，本文说明不能替代这些数据或参考视频。');
        for(const [i,seg] of (task.segments || []).entries()){
            const override=seg.style_override || seg.subtitle_style;
            if(override && Object.keys(override).length)lines.push(`第${i+1}句独立样式（${fmt(seg.start)}–${fmt(seg.end)}秒）：`,...styleLines({...base,...override}));
        }
        return lines;
    }
    function canvasSize(task,options={}){
        const rs=window._reelsState || {},target=task || rs.tasks?.[rs.selectedIdx],canvas=target?window.ReelsLayoutTemplate?.taskCanvas?.(target,rs):null;
        return {width:options.width || canvas?.width || rs.targetWidth || 1080,height:options.height || canvas?.height || rs.targetHeight || 1920};
    }
    function describe(task,options={}){
        const {index=0}=options,{width,height}=canvasSize(task,options);
        if(options.includedTitleStyles?.length && !selectedEntries(task,options).length){
            const data=titleStyleData([task],{includedLayers:options.includedTitleStyles,excludedLayers:[]});
            return JSON.stringify(data,null,2);
        }
        const lines=[`任务 ${index+1} 排版说明`,`画布${width}×${height}像素。以下均为全局坐标，原点在左上角，X向右、Y向下；默认位置指左上角，中心定位单独注明。文字内容和素材另行提供。`];
        let count=0;
        for(const entry of selectedEntries(task,options)){
            if(entry.kind==='background'){
                const dx=width*n(task.bgX)/100,dy=height*n(task.bgY)/100;
                lines.push(`背景层：画布显示区域${rectText({x:0,y:0,w:width,h:height})}；背景定位中心(${fmt(width/2+dx)},${fmt(height/2+dy)})，相对画布居中位置偏移X ${fmt(dx)}px、Y ${fmt(dy)}px；以居中铺满画布为基准缩放${fmt(n(task.bgScale,100))}%，绕背景中心旋转${fmt(task.bgRotation)}°。`);
                lines.push(`背景水平翻转${task.bgFlipH?'开启':'关闭'}，垂直翻转${task.bgFlipV?'开启':'关闭'}；显示区域尺寸不等于缩放后背景的实际尺寸，背景移出画布的部分不显示，位置偏移不触发额外缩放。`);
                continue;
            }
            if(entry.kind==='content'){lines.push(`${entry.label}：覆盖画布，${rectText({x:0,y:0,w:width,h:height})}。`);continue;}
            if(entry.kind==='subtitle'){
                lines.push(...describeSubtitle(task,width,height));continue;
            }
            const ov=entry.ov;
            const includeTitleStyle=!isTitleStyleEntry(entry) || (options.includedTitleStyles===undefined ? options.includeTitleStyle!==false : new Set(options.includedTitleStyles).has(displayId(entry)));
            if(ov.disabled){lines.push(`${entry.label}：当前关闭。`);continue;}
            count++;
            if(options.positionOnlyTitleId && ov.id === options.positionOnlyTitleId){
                const autoCenterV=ov.auto_center_v===true || ov.auto_center_v===1 || ov.auto_center_v==='1';
                const cy=(autoCenterV?height/2:n(ov.y)+n(ov.h)/2)+n(ov.offset_y)+n(ov.title_offset_y);
                lines.push(`${entry.label}：标题中心位置 Y ${fmt(cy)}px（距画布顶部）。`);
                continue;
            }
            if(ov.type==='scroll'){lines.push(`${entry.label}：`,...describeScroll(ov));}
            else if(['textcard','text'].includes(ov.type)){
                if(ov.type==='textcard' && !ov.body_text && !ov.footer_text && !ov.fullscreen_mask && !ov.title_frame_enabled && ov.layout_mode!=='side_by_side'){
                    const autoCenterV=ov.auto_center_v===true || ov.auto_center_v===1 || ov.auto_center_v==='1';
                    const cx=n(ov.x)+n(ov.w)/2+n(ov.offset_x)+n(ov.title_offset_x),cy=(autoCenterV?height/2:n(ov.y)+n(ov.h)/2)+n(ov.offset_y)+n(ov.title_offset_y);
                    lines.push(`${entry.label}：中心参考点(${fmt(cx)},${fmt(cy)})。`);
                }else lines.push(`${entry.label}：${rectText(windowRect(ov,width,height))}。`);
                if(ov.type==='textcard'){
                    for(const prefix of ['title','body','footer'])if(ov[prefix+'_text'] && (prefix!=='title' || includeTitleStyle))lines.push(({title:'标题',body:'正文',footer:'页脚'}[prefix])+'样式：'+textStyle(ov,prefix));
                    if(ov.title_adaptive_enabled && includeTitleStyle){
                        const limit=ov.title_frame_enabled?n(ov.w,width):width;
                        const maxW=Math.min(limit,n(ov.title_adaptive_max_w,1080)),minW=Math.min(maxW,n(ov.title_adaptive_min_w,1080));
                        lines.push(`标题背景设计宽度${minW===maxW?`${fmt(maxW)}px`:`${fmt(minW)}–${fmt(maxW)}px`}，高度${fmt(n(ov.title_adaptive_min_h,200))}–${fmt(n(ov.title_adaptive_max_h,300))}px自适应；最多${ov.title_adaptive_max_lines || 3}行，自动换行并适配字号。`);
                        const positive=(value,fallback)=>n(value)>0?n(value):fallback;
                        const preferred=positive(ov.title_preferred_glyph_height,45),maximum=positive(ov.title_max_glyph_height,60);
                        lines.push(`标题字形高度优先${fmt(preferred)}px，最大${fmt(maximum)}px（指实际可见字形高度，与字体字号不同）；优先高度超过上限时按上限执行，保存字号不作为最终固定字号。`);
                        lines.push('排版规则：保持标题框中心位置不变，先在最大范围内自动换行，尽量保持优先字形高度；若宽度、高度或行数超限，则缩小文字直至适配。之后在不增加行数的前提下收窄标题框，高度随内容调整，均不小于最小范围、不超过最大范围；范围受画布可用空间限制，文字区域须扣除背景内边距及描边、阴影占用。');
                        if(n(ov.title_adaptive_min_w,1080)>=n(ov.title_adaptive_max_w,1080))lines.push('最小宽度不小于最大宽度，标题框宽度固定为有效最大宽度，不随内容变窄。');
                        if(n(ov.title_adaptive_min_h,200)>=n(ov.title_adaptive_max_h,300))lines.push('最小高度不小于最大高度，标题框高度固定为有效最大高度。');
                    }
                }else lines.push(textStyle(ov));
                const sx=n(ov.scale_x,n(ov.scale,1)),sy=n(ov.scale_y,n(ov.scale,1));
                if(ov.type==='textcard' && (sx!==1 || sy!==1))lines.push(`整个文字层水平缩放${fmt(sx*100)}%、垂直缩放${fmt(sy*100)}%，背景尺寸随之缩放。`);
            }else {
                const rect=windowRect(ov,width,height);
                lines.push(`${entry.label}：${rectText(rect)}。`);
                if(['image','video'].includes(ov.type) && ov.media_window_mode==='pip'){
                    const base=ov.media_window || {};
                    const bx=n(base.x,n(ov.x)),by=n(base.y,n(ov.y)),bw=n(base.w,n(ov.w)),bh=n(base.h,n(ov.h));
                    const sx=n(ov.scale_x,n(ov.scale,1)),sy=n(ov.scale_y,n(ov.scale,1));
                    lines.push(`面板原始设置：中心相对画布中心偏移(${fmt(bx+bw/2-width/2)},${fmt(by+bh/2-height/2)})px，窗口宽${fmt(bw)}px、高${fmt(bh)}px，缩放X ${fmt(sx*100)}%、Y ${fmt(sy*100)}%；上方位置为缩放和裁切后的窗口范围。`);
                }
                if(['image','video'].includes(ov.type) && ['pip','top_half','bottom_half'].includes(ov.media_window_mode)){
                    lines.push(`窗口内素材调整：X位移${fmt(ov.media_inner_x)}px，Y位移${fmt(ov.media_inner_y)}px，缩放${fmt(n(ov.media_inner_scale,1)*100)}%，旋转${fmt(ov.media_inner_rotation)}°；这些参数调整窗口内素材，不改变窗口位置。`);
                }
                if(['image','video'].includes(ov.type) && (rect.x<0 || rect.y<0 || rect.x+rect.w>width || rect.y+rect.h>height)){
                    const left=Math.max(0,rect.x),top=Math.max(0,rect.y),right=Math.min(width,rect.x+rect.w),bottom=Math.min(height,rect.y+rect.h);
                    if(right>left && bottom>top)lines.push(`画布内的窗口范围（未扣除上方图层遮挡，也未考虑旋转、形状遮罩和动画）：${rectText({x:left,y:top,w:right-left,h:bottom-top})}；画布外部分不显示。`);
                    else lines.push('窗口位于画布外（未考虑旋转和动画），静止时无可见区域。');
                }
            }
            if(n(ov.rotation))lines.push(`旋转${fmt(ov.rotation)}°。`);
            if(n(ov.opacity,255)!==255)lines.push(`图层不透明度${pct(ov.opacity)}%。`);
            if(n(ov.start)>0 || (ov.end!==undefined && n(ov.end)<9999))lines.push(`显示时间：第${fmt(ov.start)}秒至${ov.end===undefined || n(ov.end)>=9999?'任务结束':`第${fmt(ov.end)}秒`}。`);
        }
        if(options.includedTitleStyles){
            const selectedIds=new Set(selectedEntries(task,options).map(displayId));
            const only=options.includedTitleStyles.filter(id=>!selectedIds.has(id));
            if(only.length)for(const style of titleStyleData([task],{includedLayers:only,excludedLayers:[]}).styles)lines.push(`${style.layer}（仅标题样式，不含位置）：\n${JSON.stringify(style.style,null,2)}`);
            if(options.includeFullTitleStyleData){
                const withLayer=options.includedTitleStyles.filter(id=>selectedIds.has(id));
                if(withLayer.length)for(const style of titleStyleData([task],{includedLayers:withLayer,excludedLayers:[]}).styles)lines.push(`${style.layer}完整标题样式参数（不含画布位置）：\n${JSON.stringify(style.style,null,2)}`);
            }
        }
        if(count>1)lines.push('以上已启用的覆层按列出顺序由下到上叠放。');
        return lines.join('\n');
    }
    function cells(tasks,options={}){return tasks.map((task,index)=>describe(task,{...options,index})).map(text=>text.replace(/[\t\r\n]+/g,' ｜ ')).join('\n');}
    function titleStyleData(tasks,options={}){
        const excluded=new Set(['title_text','title_styled_ranges','title_offset_x','title_offset_y']);
        const shared=/^(?:independent_effects|text_direction|text_(?:stroke|shadow)_|card_(?:enabled|color|gradient|opacity|border|blur|feather)|radius_(?:tl|tr|bl|br)|padding_(?:top|bottom|left|right)|layout_mode|side_by_side_(?:gap|title_ratio)|auto_fit|auto_shrink|min_fontsize|max_height|fullscreen_mask|opacity|blend_mode|transition_(?:preset|duration)|anim_(?:in|out)_(?:type|duration))$/;
        const styles=[];
        tasks.forEach((task,index)=>{
            for(const entry of selectedEntries(task,options)){
                const ov=entry.ov;
                if(!ov || ov.disabled || ov.type!=='textcard' || /(?:watermark|水印)/i.test(String(ov.slotKey || '')+' '+String(ov.slotLabel || '')) || !(ov.title_text || ov.enabled_slots?.title || /(?:title|标题)/i.test(String(ov.slotKey || '')+' '+String(ov.slotLabel || ''))))continue;
                const fields={};
                for(const [key,value] of Object.entries(ov)){
                    if(excluded.has(key) || /(?:_path|_url|_src)$/i.test(key) || !(key.startsWith('title_') || shared.test(key) || /^(?:text_(?:stroke|shadow)|card_(?:gradient|border|blur|feather))_/.test(key)) || value==null || typeof value==='function')continue;
                    if(typeof value==='string' && /^(?:data:|blob:|file:|https?:|\/Users\/|\/Volumes\/|[A-Za-z]:[\\/])/i.test(value))continue;
                    fields[key]=value;
                }
                styles.push({...(tasks.length>1?{task_index:index+1}:{}),layer:entry.label,style:fields});
            }
        });
        return {schema:'videokit-title-style/v1',description:'标题样式参数，不包含标题文案、画布坐标、覆层尺寸、素材路径或显示时间；阴影和笔刷等效果内部偏移属于样式。',styles};
    }
    async function copy(tasks,{batch=false,...options}={}){
        try{
            if(!tasks.length)throw new Error('请先选择任务');
            const text=batch?cells(tasks,options):describe(tasks[0],options);
            if(window.electronAPI?.writeClipboardText)await window.electronAPI.writeClipboardText(text);else await navigator.clipboard.writeText(text);
            window.showToast?.(batch?`已复制 ${tasks.length} 个任务的排版信息，每个任务一个单元格`:'已复制当前任务排版信息','success');return true;
        }catch(error){window.showToast?.(`复制失败：${error.message}`,'warning');return false;}
    }
    function openCopyDialog(tasks,options={}){
        if(!tasks.length){window.showToast?.('请先选择任务','warning');return null;}
        document.querySelector('.reels-layout-copy-dialog')?.close();
        const dialog=document.createElement('dialog');dialog.className='reels-layout-copy-dialog';
        dialog.style.cssText='width:min(540px,92vw);max-height:85vh;overflow:auto;background:#232530;color:#eee;border:1px solid #666;border-radius:12px;padding:20px;font:14px system-ui';
        const heading=document.createElement('h3');
        heading.textContent=options.intent==='skill'
            ?(options.batch?`生成排版 Skill · 勾选图层（${tasks.length} 个任务）`:'生成当前排版 Skill · 勾选图层')
            :(options.batch?`整批复制排版信息（${tasks.length} 个任务）`:'复制当前排版信息');
        const hint=document.createElement('p');hint.textContent='勾选需要复制或生成 Skill 的项目。标题层位置和标题样式可以单独选择；标题样式包含自适应设置。选择会记住。';
        const tools=document.createElement('div'),list=document.createElement('div'),footer=document.createElement('div');
        list.style.cssText='display:grid;gap:10px;margin:16px 0';footer.style.cssText='display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap';
        const inputs=[],styleInputs=[],excluded=new Set(savedExclusions());
        let excludedStyles=new Set();try{excludedStyles=new Set(JSON.parse(window.localStorage?.getItem('videokit_copy_excluded_title_styles_v1') || '[]'));}catch(_){}
        const titleIds=new Set(tasks.flatMap(task=>entries(task).filter(isTitleStyleEntry).map(displayId)));
        for(const entry of listLayers(tasks)){
            const label=document.createElement('div'),input=document.createElement('input'),text=document.createElement('span');
            input.type='checkbox';input.checked=!excluded.has(entry.key) && !entry.keys.every(key=>excluded.has(key));input.dataset.layerKey=entry.key;input._legacyKeys=entry.keys;
            if(entry.keys.includes('subtitle'))text.title='语音转写或导入的逐句字幕，也包括字幕样式中的滚动字幕；这是独立字幕轨，不在覆层列表中。';
            text.textContent=entry.label+(options.batch?`（${entry.count}/${tasks.length} 个任务）`:'');label.style.cssText='display:flex;gap:8px;align-items:center';label.append(input,text);list.appendChild(label);inputs.push(input);
            const find=document.createElement('button');find.textContent='查找任务 / 改名';
            find.onclick=event=>{event.preventDefault();dialog.close();openLayerManager(tasks,{initialLabels:[entry.label]});};label.append(find);
            if(titleIds.has(entry.key)){
                const styleLabel=document.createElement('label'),styleInput=document.createElement('input');
                styleLabel.style.cssText='display:flex;align-items:center;gap:8px;color:#c4b5fd;cursor:pointer';
                styleInput.type='checkbox';styleInput.checked=!excludedStyles.has(entry.key);styleInput.dataset.layerKey=entry.key;
                styleLabel.append(styleInput,document.createTextNode(`${entry.label} · 标题样式（含自适应）${options.batch?`（${entry.count}/${tasks.length} 个任务）`:''}`));list.appendChild(styleLabel);styleInputs.push(styleInput);
            }
        }
        for(const [text,action] of [['全选',()=>[...inputs,...styleInputs].forEach(input=>input.checked=true)],['反选',()=>[...inputs,...styleInputs].forEach(input=>input.checked=!input.checked)],['取消全选',()=>[...inputs,...styleInputs].forEach(input=>input.checked=false)]]){
            const button=document.createElement('button');button.textContent=text;button.onclick=action;tools.appendChild(button);
        }
        const persistCheckedLayers=()=>{
            for(const input of inputs){for(const key of input._legacyKeys)excluded.delete(key);if(input.checked)excluded.delete(input.dataset.layerKey);else excluded.add(input.dataset.layerKey);}
            try{window.localStorage?.setItem(STORE_KEY,JSON.stringify([...excluded]));}catch(_){}
            for(const input of styleInputs){if(input.checked)excludedStyles.delete(input.dataset.layerKey);else excludedStyles.add(input.dataset.layerKey);}
            try{window.localStorage?.setItem('videokit_copy_excluded_title_styles_v1',JSON.stringify([...excludedStyles]));}catch(_){}
        };
        const cancel=document.createElement('button'),skillBtn=document.createElement('button'),styleBtn=document.createElement('button'),confirm=document.createElement('button'),status=document.createElement('p');
        cancel.textContent='取消';cancel.onclick=()=>dialog.close();
        skillBtn.textContent='⚡ 生成 Skill';
        skillBtn.title='将所选图层的像素级排版与动效导出为 AI Skill（自动剥离素材与具体台词）';
        if(options.intent==='skill')skillBtn.style.cssText='background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;border:none;border-radius:6px;padding:6px 12px;font-weight:600;cursor:pointer';
        skillBtn.onclick=()=>{
            const keys=inputs.filter(input=>input.checked).map(input=>input.dataset.layerKey);
            const styleKeys=styleInputs.filter(input=>input.checked).map(input=>input.dataset.layerKey);
            if(!keys.length && !styleKeys.length){status.textContent='请至少勾选一个图层或标题样式';return;}
            if(!window.ReelsSkillExporter?.openForTasks){status.textContent='Skill 导出模块尚未加载，请刷新后重试';return;}
            persistCheckedLayers();
            dialog.close();
            window.ReelsSkillExporter.openForTasks(tasks,{...options,includedLayers:keys,includedTitleStyles:styleKeys,excludedLayers:[]});
        };
        styleBtn.textContent='🎨 复制标题样式';
        styleBtn.title='复制勾选的标题层完整样式参数 JSON，不含文字、画面坐标、图层尺寸和素材';
        styleBtn.onclick=async()=>{
            const keys=styleInputs.filter(input=>input.checked).map(input=>input.dataset.layerKey);
            if(!keys.length){status.textContent='请先勾选标题样式';return;}
            const data=titleStyleData(tasks,{includedLayers:keys,excludedLayers:[]});
            if(!data.styles.length){status.textContent='勾选的图层中没有启用的标题层';return;}
            try{
                const text=JSON.stringify(data,null,2);
                if(window.electronAPI?.writeClipboardText)await window.electronAPI.writeClipboardText(text);else await navigator.clipboard.writeText(text);
                persistCheckedLayers();dialog.close();window.showToast?.(`已复制 ${data.styles.length} 个标题样式参数`,'success');
            }catch(error){status.textContent=`复制失败：${error.message}`;}
        };
        confirm.textContent='复制所选层';
        confirm.onclick=async()=>{
            const keys=inputs.filter(input=>input.checked).map(input=>input.dataset.layerKey);
            const styleKeys=styleInputs.filter(input=>input.checked).map(input=>input.dataset.layerKey);
            if(!keys.length && !styleKeys.length){status.textContent='请至少勾选一个图层或标题样式';return;}
            confirm.disabled=true;
            if(await copy(tasks,{...options,includedLayers:keys,includedTitleStyles:styleKeys,includeFullTitleStyleData:true,excludedLayers:[]})){
                // Retain exclusions for layers absent from this batch, too.
                persistCheckedLayers();
                dialog.close();
            }else confirm.disabled=false;
        };
        footer.append(cancel,styleBtn,skillBtn,confirm);dialog.append(heading,hint,tools,list,status,footer);dialog.onclose=()=>dialog.remove();document.body.appendChild(dialog);dialog.showModal();return dialog;
    }
    function describeWatermarksText(watermarks,opts={}){
        watermarks=(watermarks || []).filter(wm=>wm?.enabled);
        if(!watermarks.length)throw new Error('暂无已启用的水印，请先启用要复制的水印');
        const {width,height}=canvasSize(null,opts);
        const positions={'top-left':'左上','top-center':'上中','top-right':'右上','center-left':'左中',center:'居中','center-right':'右中','bottom-left':'左下','bottom-center':'下中','bottom-right':'右下',custom:'自定义坐标'};
        const lines=[opts.stripMediaPaths?`水印位置与样式说明`:`水印内容与样式说明`, `参考画布${width}×${height}像素，原点在左上角，X向右、Y向下；水印按以下顺序叠放，后列出的在上方。`];
        watermarks.forEach((wm,index)=>{
            const image=wm.type==='image',position=wm.position || 'top-right';
            lines.push(`水印 ${index+1}：${image?'图片':'文字'}，${wm.enabled?'已启用':'已关闭（当前不显示）'}。`);
            lines.push(`位置：${positions[position] || position}，偏移X ${fmt(wm.x)}px、Y ${fmt(wm.y)}px；${position==='custom'?'自定义模式以画布原点为位置基准':'九宫格定位，靠边位置距离画布边缘16px'}。`);
            if(image){
                lines.push(opts.stripMediaPaths?'图片来源：需外部提供图片水印素材（已脱敏，不含原素材路径）。':`图片来源：${wm.imagePath || '未选择图片'}。图片素材需同时提供。`);
                lines.push(`按图片原始像素尺寸缩放${fmt(wm.imageScale || 100)}%，图片锚点${positions[wm.imageAnchor || 'center'] || wm.imageAnchor}与位置参考点重合；不透明度${fmt(n(wm.opacity,1)*100)}%，水平翻转${wm.flipH?'开启':'关闭'}，垂直翻转${wm.flipV?'开启':'关闭'}。`);
            }else{
                const size=wm.fontSize || 20;
                lines.push('水印样式：');
                lines.push(`字体Arial（sans-serif回退），常规字重，字号${fmt(size)}px，字色${wm.color || '#FFFFFF'}，文字不透明度${fmt(n(wm.textOpacity,1)*100)}%；各行左对齐，额外行距4px，不自动换行。`);
                lines.push(`背景${wm.bgColor || '#000000'}，背景不透明度${fmt(n(wm.bgOpacity,.5)*100)}%，圆角${Math.round(size*.2)}px，左右内边距各${Math.round(size*.5)}px，上下内边距各${Math.round(size*.35)}px；背景宽度随最长行适配，高度随行数适配。位置按整个背景框计算，自定义坐标对应背景框左上角。`);
                if(opts.includeTextContent!==false){
                    lines.push('水印内容（保留换行）：',String(wm.text || ''),'【此水印说明结束】');
                }else{
                    lines.push('水印内容：由调用方传入文字内容（当前仅保留样式与坐标，不附带原文字）。');
                }
            }
        });
        return lines.join('\n');
    }
    async function copyWatermarks(watermarks){
        try{
            const list=(watermarks || []).filter(wm=>wm?.enabled);
            const text=describeWatermarksText(list);
            if(window.electronAPI?.writeClipboardText)await window.electronAPI.writeClipboardText(text);else await navigator.clipboard.writeText(text);
            window.showToast?.(`已复制${list.length}个水印的内容和样式`,'success');return true;
        }catch(error){window.showToast?.('复制失败：'+error.message,'warning');return false;}
    }
    function describeSubtitlePresetText(name,style,opts={}){
        if(!style || typeof style!=='object')throw new Error('未找到此预设的样式');
        const {width,height}=canvasSize(null,opts);
        const allLines=describeSubtitle({overlayAboveSubtitle:opts.overlayAboveSubtitle},width,height,style);
        const lines=opts.includeOverlayRelation?allLines:allLines.filter(line=>!line.startsWith('与覆层叠放关系：'));
        return [`动态字幕预设：${name || '默认样式'}`,`参考画布${width}×${height}像素；坐标原点为左上角，X向右、Y向下。此说明为预设本身的效果，不包含任务或逐句修改。`,...lines].join('\n');
    }
    async function copySubtitlePreset(name,style){
        try{
            const text=describeSubtitlePresetText(name,style);
            if(window.electronAPI?.writeClipboardText)await window.electronAPI.writeClipboardText(text);else await navigator.clipboard.writeText(text);
            window.showToast?.('已复制预设效果说明：'+name,'success');return true;
        }catch(error){window.showToast?.('复制失败：'+error.message,'warning');return false;}
    }
    function appendAction(menu,task,player){
        const button=document.createElement('button');button.textContent='复制当前排版信息';button.setAttribute('role','menuitem');button.onclick=()=>{menu.remove();openCopyDialog([task],{playerFor:()=>player});};menu.appendChild(button);
        const skillButton=document.createElement('button');skillButton.textContent='⚡ 生成当前排版 Skill';skillButton.setAttribute('role','menuitem');skillButton.onclick=()=>{menu.remove();openCopyDialog([task],{intent:'skill',playerFor:()=>player});};menu.appendChild(skillButton);
    }
    return {describe,cells,copy,titleStyleData,copySubtitlePreset,copyWatermarks,describeSubtitlePresetText,describeWatermarksText,appendAction,listLayers,openCopyDialog,entries,layerInventory,groupLayerRows,matchingTasks,renameLayers,openLayerManager};
})();
