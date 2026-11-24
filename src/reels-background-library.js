/** Independent, single-video background library and portable title bindings. */
(() => {
    'use strict';
    const libraryPaths=new Map();
    const normalizePath=path=>String(path || '').replace(/\\/g,'/').normalize('NFC');
    const hasPath=path=>[...libraryPaths.values()].some(paths=>paths.has(normalizePath(path)));
    const video = path => /\.(mp4|mov|avi|mkv|webm|m4v)$/i.test(path);
    const escape = value => String(value || '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const basename = path => String(path).split(/[\\/]/).pop();
    // Spreadsheet TSV: quoted cells may contain tabs, newlines and doubled quotes.
    function parseTable(text){
        const src=String(text || '').replace(/\r\n?/g,'\n'),rows=[];
        let row=[],cell='',quoted=false;
        for(let i=0;i<src.length;i++){
            const ch=src[i];
            if(quoted){
                if(ch==='"' && src[i+1]==='"'){cell+='"';i++;}
                else if(ch==='"' && (i+1===src.length || src[i+1]==='\t' || src[i+1]==='\n'))quoted=false;
                else cell+=ch;
            }else if(ch==='"' && cell==='')quoted=true;
            else if(ch==='\t'){row.push(cell);cell='';}
            else if(ch==='\n'){row.push(cell);rows.push(row);row=[];cell='';}
            else cell+=ch;
        }
        if(quoted)throw new Error('表格引号未闭合，请重新复制完整单元格');
        if(cell!=='' || row.length || (src.length && !src.endsWith('\n'))){row.push(cell);rows.push(row);}
        return rows;
    }
    function pairTable(rows,videos,root){
        rows=rows.map(row=>[...row]);
        if(rows.length && ((rows[0].length===1 && /^(标题|配套标题)$/.test(rows[0][0])) || (rows[0].length===2 && /^(视频|视频名|文件名|背景视频)$/.test(rows[0][0]) && /^(标题|配套标题)$/.test(rows[0][1]))))rows.shift();
        if(!rows.length)throw new Error('请先粘贴标题或视频、标题两列');
        const columns=rows[0].length;
        if(![1,2].includes(columns) || rows.some(row=>row.length!==columns))throw new Error('请粘贴一列标题，或两列“视频、标题”，每行列数保持一致');
        if(columns===1 && rows.length>videos.length)throw new Error(`标题有 ${rows.length} 行，视频只有 ${videos.length} 个，请检查数量`);
        const normalize=value=>String(value).replace(/\\/g,'/').replace(/^\.\//,''),base=normalize(root).replace(/\/$/,'')+'/',lookup=new Map();
        for(const item of videos){
            const path=normalize(item.path),relative=path.startsWith(base)?path.slice(base.length):path;
            for(const name of new Set([path,relative,basename(path)]))lookup.set(name,[...(lookup.get(name) || []),item.path]);
        }
        const result=videos.map(item=>({...item})),byPath=new Map(result.map(item=>[item.path,item])),seen=new Set();
        rows.forEach((row,index)=>{
            let item=result[index];
            if(columns===2){
                const matches=lookup.get(normalize(row[0].trim())) || [];
                if(matches.length!==1)throw new Error(`第 ${index+1} 行视频${matches.length?'重名，请填写相对路径或完整路径':'未找到，请检查视频名'}：${row[0]}`);
                item=byPath.get(matches[0]);
            }
            if(seen.has(item.path))throw new Error(`第 ${index+1} 行重复指定同一个视频`);
            const title=row[columns-1];if(title.length>20000)throw new Error(`第 ${index+1} 行标题超过 20000 字`);
            seen.add(item.path);item.title=title;
        });
        return {rows:result,count:rows.length};
    }
    function titleLayers(task) {
        return (task?.overlays || []).flatMap((layer,index)=>{
            const type=layer.type || ('title_text' in layer?'textcard':'');
            if(layer.disabled || !['textcard','text','scroll'].includes(type))return [];
            const field=type==='textcard'?'title_text':type==='scroll'?'scroll_title':'content';
            return [{type,field,index,slotKey:layer.slotKey || '',templateId:layer._templateOverlayId || layer.id || '',name:layer.name || '',
                label:`${layer.name || layer.slotLabel || `第 ${index+1} 层`} · ${field==='content'?'文字':'标题'}`}];
        });
    }
    function resolveTarget(task,target) {
        if(!target)throw new Error('请先指定背景配套的标题层');
        const layers=task.overlays || [],same=layer=>layer && (layer.type || ('title_text' in layer?'textcard':''))===target.type && !layer.disabled;
        let layer;
        if(target.slotKey)layer=layers.find(layer=>same(layer) && layer.slotKey===target.slotKey);
        else if(target.templateId)layer=layers.find(layer=>same(layer) && (layer._templateOverlayId===target.templateId || layer.id===target.templateId));
        else if(target.name)layer=layers.find(layer=>same(layer) && layer.name===target.name);
        else if(same(layers[target.index]))layer=layers[target.index];
        const field=target.type==='textcard'?'title_text':target.type==='scroll'?'scroll_title':'content';
        if(!layer || field!==target.field)throw new Error(`任务缺少绑定的标题层：${target.name || target.slotKey || `第 ${target.index+1} 层`}，请重新选择标题层`);
        return layer;
    }
    function applyTitle(task,binding) {
        const layer=resolveTarget(task,binding.target);
        layer[binding.target.field]=binding.title;
        for(const key of binding.target.field==='title_text'?['title_styled_ranges']:binding.target.field==='scroll_title'?['scroll_title_styled_ranges']:['styled_ranges','scroll_styled_ranges'])layer[key]=null;
    }
    function isBackgroundLinked(layer) {
        return !!layer && !layer.disabled && ['image','video'].includes(layer.type)
            && (layer.backgroundLinked===true || (layer.backgroundLinked===undefined &&
                /讲道|sermon|preach/i.test([layer.name,layer.slotLabel,layer.slotKey,layer._templateOverlayId].filter(Boolean).join(' '))));
    }
    const mediaFields=['content','type','media_loop','media_folder_path','media_folder_files','media_folder_items','media_folder_interval',
        'media_folder_durations','media_folder_duration_paths','is_img_sequence','sequence_frames','fps','video_start_offset','video_end_offset'];
    function captureLinkedMedia(task) {
        return (task.overlays || []).filter(isBackgroundLinked).map(layer=>({
            id:layer.id,slot:layer.slotKey || layer._templateOverlayId,
            value:JSON.parse(JSON.stringify(Object.fromEntries(mediaFields.filter(key=>layer[key]!==undefined).map(key=>[key,layer[key]])))),
        }));
    }
    function restoreLinkedMedia(task,snapshot,write) {
        for(const entry of snapshot || []) {
            const layer=(task.overlays || []).find(layer=>entry.id ? layer.id===entry.id : entry.slot && (layer.slotKey===entry.slot || layer._templateOverlayId===entry.slot));
            if(layer){for(const key of mediaFields)delete layer[key];write(layer,entry.value);}
        }
    }
    function syncLinkedMedia(task,background,write) {
        const pool=background.bgMode==='multi'?(background.bgClipActivePool?.length?background.bgClipActivePool:background.bgClipPool || []):[];
        const files=pool.map(item=>typeof item==='string'?item:item?.path).filter(Boolean);
        const path=files[0] || background.bgPath || background.videoPath || '';
        const value={content:path,type:/\.(png|jpe?g|webp|gif|bmp)$/i.test(path)?'image':'video',media_loop:true,
            ...(files.length?{media_folder_files:files,media_folder_interval:0}:{})};
        for(const layer of (task.overlays || []).filter(isBackgroundLinked)){
            for(const key of mediaFields)delete layer[key];
            write(layer,JSON.parse(JSON.stringify(value)));
        }
    }
    // Weighted draws repeat independently when reuse is allowed; otherwise remove each pick.
    function assignmentOrder(paths,count,{random=false,repeat=true,weight=()=>1,rng=Math.random}={}) {
        if(!paths.length)throw new Error('请先勾选背景视频');
        const pool=paths.map(path=>({path,weight:weight(path)}));
        if(pool.some(item=>!Number.isFinite(item.weight) || item.weight<0))throw new Error('分配权重请输入非负数字');
        const available=pool.filter(item=>item.weight>0),order=[];
        if(!available.length)throw new Error('请至少为一个已勾选背景设置大于 0 的分配权重');
        if(!repeat && available.length<count)throw new Error('正权重背景少于任务数量；请补充背景或允许循环使用');
        // Scaling avoids overflow when several large, finite weights are added.
        const max=available.reduce((max,item)=>Math.max(max,item.weight),0);
        for(const item of available)item.weight/=max;
        if(!random){
            if(!repeat){
                const chosen=new Set([...available].sort((a,b)=>b.weight-a.weight).slice(0,count).map(item=>item.path));
                return available.filter(item=>chosen.has(item.path)).map(item=>item.path);
            }
            // Largest remainders give deterministic per-batch counts, including decimal weights.
            const total=available.reduce((sum,item)=>sum+item.weight,0);
            const quotas=available.map((item,index)=>{
                const exact=count*(item.weight/total),uses=Math.floor(exact);
                return {...item,index,uses,remainder:exact-uses};
            });
            const remaining=count-quotas.reduce((sum,item)=>sum+item.uses,0);
            const ranked=[...quotas].sort((a,b)=>b.remainder-a.remainder || a.index-b.index);
            for(let i=0;i<remaining;i++)ranked[i].uses++;
            // Keep list order within each pass; equal weights retain ordinary round-robin order.
            while(order.length<count)for(const item of quotas)if(item.uses>0){order.push(item.path);item.uses--;}
            return order;
        }
        while(order.length<count){
            let draw=rng()*available.reduce((sum,item)=>sum+item.weight,0),index=available.length-1;
            for(let i=0;i<available.length;i++){draw-=available[i].weight;if(draw<0){index=i;break;}}
            order.push(available[index].path);
            if(!repeat)available.splice(index,1);
        }
        return order;
    }
    function adjustedAssignmentOrder(paths,previous,fixed={},options={}){
        const total=previous.length,counts=new Map(),automatic=[];let specified=0;
        for(const path of paths){
            const raw=fixed[path];
            if(raw===undefined || raw===''){automatic.push(path);continue;}
            const count=Number(raw);
            if(!Number.isSafeInteger(count) || count<0)throw new Error('分配次数请输入 0 或正整数，留空自动补齐');
            if(options.repeat===false && count>1)throw new Error('不允许循环时，每个背景最多分配 1 次');
            counts.set(path,count);specified+=count;
        }
        if(specified>total)throw new Error(`手动次数合计 ${specified} 次，超过本次 ${total} 个任务`);
        if(specified<total && !automatic.length)throw new Error(`还差 ${total-specified} 次，请至少留一个背景自动补齐`);
        if(specified<total)for(const path of assignmentOrder(automatic,total-specified,{...options,random:false}))counts.set(path,(counts.get(path)||0)+1);
        const remaining=new Map(counts),order=previous.map(path=>{if((remaining.get(path)||0)>0){remaining.set(path,remaining.get(path)-1);return path;}return null;});
        const spare=[];while([...remaining.values()].some(count=>count>0))for(const path of paths)if(remaining.get(path)>0){spare.push(path);remaining.set(path,remaining.get(path)-1);}
        let index=0;return order.map(path=>path ?? spare[index++]);
    }
    function assignmentSummary(paths,order){
        const counts=new Map([...new Set(paths)].map(path=>[path,0]));
        for(const path of order)counts.set(path,(counts.get(path) || 0)+1);
        return [...counts].map(([path,count])=>({path,count}));
    }
    function assignmentReportHtml(rows,label){
        const total=rows.reduce((sum,row)=>sum+row.count,0),used=rows.filter(row=>row.count>0).length;
        return `<summary>最近一次分配 · ${escape(label)} · ${total} 个任务 · 使用 ${used} 个背景</summary><p class="rom-hint">以下为本次实际分配次数，包含勾选但未使用的背景。</p><div class="rom-bg-result-list">${rows.map(({path,count,title})=>{
            const src=window.electronAPI?.toFileUrl?.(path) || path;
            return `<div class="rom-bg-result-row"><video crossorigin="anonymous" class="rbt-thumb-previewable" data-thumb-size="240" data-thumb-quality="0.9" muted preload="none" playsinline aria-label="${escape(basename(path))} 背景缩略图" data-path="${escape(path)}" data-thumb-src="${escape(src)}#t=0.1"></video><span title="${escape(path)}"><b>${escape(basename(path))}</b>${backgroundTitleHtml(title)}</span><span><strong>${count} 次</strong><label style="display:block;font-size:11px">调整为 <input data-bg-fixed-count="${escape(path)}" aria-label="${escape(basename(path))} 的指定分配次数" type="number" min="0" step="1" placeholder="自动" style="width:65px"> 次</label><small data-bg-next-count="${escape(path)}"></small></span></div>`;
        }).join('')}</div><p>填写的次数固定，留空背景按当前比例自动补齐；0 次表示不分配。只预览调整，点击应用后更新原来的任务范围。</p><output data-bg-count-status role="status"></output><button data-bg-count-apply>应用次数并自动补齐</button>`;
    }
    function backgroundPercentages(paths,infoFor){
        const result=new Map(),automatic=[];let fixed=0;
        for(const path of paths){
            const info=infoFor(path) || {},raw=info.percentage;
            if(raw===null || raw===undefined || raw===''){automatic.push({path,weight:Number(info.weight ?? 1)});continue;}
            const percentage=Number(raw);
            if(!Number.isFinite(percentage) || percentage<0 || percentage>100)throw new Error('固定比例请输入 0–100%，留空自动分配剩余比例');
            result.set(path,percentage);fixed+=percentage;
        }
        if(fixed>100+1e-8)throw new Error(`手动固定比例合计 ${Number(fixed.toFixed(4))}%，超过 100%，请调整部分比例；其他固定值保持不变`);
        const remaining=Math.max(0,100-fixed);
        if(!automatic.length && remaining>1e-8)throw new Error(`还剩 ${Number(remaining.toFixed(4))}% 未分配，请留一个背景自动，或手动补足 100%`);
        if(automatic.some(item=>!Number.isFinite(item.weight) || item.weight<0))throw new Error('自动背景的分配比例无效');
        const max=automatic.reduce((max,item)=>Math.max(max,item.weight),0),total=max?automatic.reduce((sum,item)=>sum+item.weight/max,0):0;
        if(automatic.length && remaining>1e-8 && !max)throw new Error('自动背景均为零权重，无法补齐剩余比例，请设置固定比例');
        const sum=automatic.reduce((sum,item)=>sum+item.weight,0);
        for(const item of automatic)result.set(item.path,total?remaining*(Number.isFinite(sum)?item.weight/sum:(item.weight/max)/total):0);
        return result;
    }
    function backgroundTitleHtml(title){
        const text=String(title || '');
        return text.trim()?`<small class="rom-bg-title">配套标题：${escape(text)}</small>`:'<small class="rom-bg-title rom-bg-title-missing" style="color:#ff8585;font-weight:700">配套标题：无</small>';
    }
    function mount(container,hooks) {
        const libraries=new Map(),checked=new Set(),drafts=new Map();let active=null,disposed=false,busy=false,pairingDialog=null,weightSave=Promise.resolve(),lastDistribution=null,lastAssignment=null;
        const module=document.createElement('details');module.className='rom-source-section rom-background-library';
        module.innerHTML='<summary>背景库 · 单视频＋配套标题</summary><div class="rom-source-tools"><div class="rom-tools"><button data-add>添加背景库文件夹（可多选）</button><button data-refresh>刷新全部库</button><button data-unbind>移出当前库</button></div><select data-library aria-label="选择要设置的背景库"><option value="">请选择背景库</option></select><small>下方按文件夹分组显示全部背景；此下拉框仅选择要设置的库。</small><label>当前库默认配套标题层<select data-default aria-label="背景库默认标题层"></select></label><button data-layers>重新读取当前任务的标题层</button><button data-pair-table>表格配对标题</button><small>一个视频就是一个背景；配套标题、分配权重、常用标记和标题层绑定保存在库目录的 .videokit-background-library.json。未配标题也可分配，保留任务原标题；分配不改正文。背景库素材不受名字关键词限制。</small><input data-search placeholder="搜索视频名或配套标题" aria-label="搜索背景视频"><label><input data-favorites type="checkbox" style="width:auto">只看常用</label><label>分配到层<select data-media-layer aria-label="背景库分配目标层"></select></label><small>分配到普通媒体层时仅替换该层素材；配套标题在分配到背景时应用。</small><fieldset><legend>背景联动媒体层</legend><div data-background-links></div><small>绑定设置应用于本批已有对应层的任务。分配或替换背景时一起换素材，保留画中画位置、大小和裁切。名为“讲道”的层默认联动。</small></fieldset><label>分配范围<select data-scope><option value="selected">勾选任务</option><option value="current">当前任务</option><option value="all">本批全部任务</option></select></label><label><input data-repeat type="checkbox" style="width:auto" checked>背景少于任务时允许循环使用</label><div class="rom-tools"><button data-sequential>顺序分配已勾选背景</button><button data-random>随机分配已勾选背景</button><button data-select-all>全选当前显示</button><button data-clear>取消全选</button><button data-invert>反选当前显示</button></div><small>顺序分配按权重比例确定使用次数，再按素材顺序轮流填入任务；随机分配按权重抽取。填写的百分比固定保留，其他修改只调整自动背景；留空自动分配剩余比例，0% 不参与分配。固定比例合计不能超过 100%。不允许循环时每个背景最多使用一次，任务较少时优先使用高权重背景。修改后自动保存到背景库，留空恢复自动分配。</small><output data-status aria-live="polite"></output></div><details class="rom-bg-distribution-result" data-distribution-result hidden open aria-label="背景分配结果"></details><div class="rom-background-groups" data-items></div><div class="rom-tools"><output data-count></output></div>';
        const style=document.createElement('style');
        style.textContent='.rom-bg-folder{border:1px solid #454c61;border-radius:9px;padding:10px;margin-bottom:12px}.rom-bg-folder>summary{cursor:pointer;font-weight:600;color:#d5d0ee;padding:4px 0}.rom-bg-folder>.rom-grid{margin-top:10px}.rom-bg-item{cursor:pointer;display:flex;flex-direction:column;gap:4px;min-width:0;padding:4px;border:1px solid #424654;border-radius:5px;background:#292c37;font-size:11px}.rom-bg-item.rom-bg-checked{box-shadow:inset 0 0 0 2px #9b91ff;background:#37314e}.rom-bg-item>video{pointer-events:none;width:100%;height:auto;object-fit:contain;background:#111}.rom-bg-item>b{overflow-wrap:anywhere;line-height:1.45}.rom-bg-item>button{font-size:11px;padding:4px}.rom-bg-item>small{overflow-wrap:anywhere;color:#bcb8d6}.rom-bg-editor>summary{cursor:pointer;color:#d5d0ee;padding:6px 0}.rom-bg-editor-body{display:flex;flex-direction:column;gap:8px;padding:8px 0}.rom-bg-item:has(.rom-bg-editor[open]){grid-column:1/-1}.rom-bg-item:has(.rom-bg-editor[open])>video{max-height:180px}.rom-bg-item:has(.rom-bg-editor[open])>b{font-size:12px}';
        style.textContent+='.rom-bg-distribution-result{border:1px solid #7669bc;background:#272438;border-radius:8px;padding:10px;margin-bottom:12px}.rom-bg-distribution-result[hidden]{display:none}.rom-bg-distribution-result>summary{cursor:pointer;font-weight:600;color:#e4ddff}.rom-bg-result-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr));gap:8px;max-height:420px;overflow:auto}.rom-bg-result-row{display:grid;grid-template-columns:72px minmax(0,1fr) auto;align-items:center;gap:8px;padding:6px;background:#1e2029;border-radius:6px}.rom-bg-result-row>video{width:72px;height:72px;object-fit:contain;background:#111;border-radius:4px}.rom-bg-result-row>span{font-size:12px;overflow-wrap:anywhere}.rom-bg-result-row strong,.rom-bg-item>[data-assigned-count]{color:#a9e4bb;font-weight:600;white-space:nowrap}';
        style.textContent+='.rom-bg-title{display:block;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.5;margin:4px 0}.rom-bg-item>.rom-bg-title-missing{color:#ff8585;font-weight:700}';
        module.appendChild(style);
        const fixedModule=container.querySelector('[data-source="library"]');
        if(fixedModule)container.insertBefore(module,fixedModule);else container.appendChild(module);
        const query=selector=>module.querySelector(selector),status=value=>{query('[data-status]').textContent=value;};
        const mediaGroups=(hooks.groups || []).filter(group=>group.field==='bg' || group.field==='pip');
        query('[data-media-layer]').innerHTML=mediaGroups.length
            ? mediaGroups.map(group=>`<option value="${escape(group.key)}">${escape(group.label)}</option>`).join('')
            : '<option value="bg">背景</option>';
        const backgroundGroup=mediaGroups.find(group=>group.field==='bg');
        if(backgroundGroup)query('[data-media-layer]').value=backgroundGroup.key;
        const linkedGroups=mediaGroups.filter(group=>group.field==='pip');
        query('[data-background-links]').innerHTML=linkedGroups.map(group=>`<label style="display:block"><input type="checkbox" data-background-link="${escape(group.key)}" style="width:auto" ${hooks.backgroundLinked?.(group)?'checked':''}>${escape(group.label)}</label>`).join('') || '<small>当前任务没有可绑定的媒体层</small>';
        query('[data-background-links]').onchange=event=>{
            const input=event.target.closest('[data-background-link]');if(!input)return;
            const group=linkedGroups.find(group=>group.key===input.dataset.backgroundLink);if(!group)return;
            try{hooks.setBackgroundLinked?.(group,input.checked);status(input.checked?`已绑定「${group.label}」，将跟随本任务的背景素材`:`已解除「${group.label}」的背景联动`);}
            catch(error){input.checked=!input.checked;status(error.message);}
        };
        function assignmentGroup(){return mediaGroups.find(group=>group.key===query('[data-media-layer]').value);}
        async function call(data){
            if(!window.electronAPI?.apiCall)throw new Error('请在桌面版使用背景库');
            const response=await window.electronAPI.apiCall('background-library',data);
            if(!response?.success)throw new Error(response?.error || '背景库操作失败');
            return response.data;
        }
        async function run(action,{redraw=true}={}){
            if(busy)return;busy=true;
            module.querySelectorAll('button,[data-weight],[data-bg-fixed-count]').forEach(button=>button.disabled=true);
            try{await weightSave;await action();}catch(error){if(!disposed){status(error.message);window.showToast?.(error.message,'warning');}}
            finally{busy=false;if(!disposed){module.querySelectorAll('button,[data-weight],[data-bg-fixed-count]').forEach(button=>button.disabled=false);if(redraw)render();else updateCount();}}
        }
        function layers(){return titleLayers(hooks.current()?.task);}
        function key(target){return JSON.stringify(target?[target.type,target.field,target.slotKey || target.templateId || target.name || target.index]:null);}
        function options(target,inherit=false){
            const choices=layers();
            return `<option value="">${inherit?'沿用库的默认标题层':'请选择标题层'}</option>`+choices.map((item,index)=>`<option value="${escape(JSON.stringify(item))}" ${key(item)===key(target)?'selected':''}>${escape(item.label)}</option>`).join('')
                + (target && !choices.some(item=>key(item)===key(target))?'<option value="missing" selected>已绑定层不在当前任务中，请重新选择</option>':'');
        }
        function merge(result,activate=true){
            const previous=libraries.get(result.root) || {};
            const updated={...previous,...result};libraries.set(result.root,updated);
            libraryPaths.set(result.root,new Set((updated.paths || []).map(normalizePath)));
            if(!activate){if(active?.root===result.root)active=updated;return;}active=updated;
            query('[data-library]').innerHTML=[...libraries.values()].map(item=>`<option value="${escape(item.root)}">${escape(item.root)}</option>`).join('');
            query('[data-library]').value=active.root;
        }
        const libraryForPath=path=>[...libraries.values()].filter(item=>item.paths?.includes(path)).sort((a,b)=>b.root.length-a.root.length)[0];
        const allPaths=()=>[...new Set([...libraries.values()].flatMap(item=>item.paths || []))].filter(video);
        function filteredPaths(){
            const search=query('[data-search]').value.trim().toLowerCase(),favorites=query('[data-favorites]').checked;
            return allPaths().sort((a,b)=>basename(a).localeCompare(basename(b),'zh-CN',{numeric:true}) || a.localeCompare(b,'zh-CN',{numeric:true})).filter(path=>{const info=libraryForPath(path)?.backgroundMetadata?.[path] || {};return (!favorites || info.favorite) && `${basename(path)} ${info.title || ''}`.toLowerCase().includes(search);});
        }
        function percentageInfo(path){return {...libraryForPath(path)?.backgroundMetadata?.[path],...drafts.get(path)};}
        function percentageScope(){const selected=[...checked].filter(path=>libraryForPath(path));return selected.length?selected:allPaths();}
        function assignmentPercentages(paths){return backgroundPercentages(paths,percentageInfo);}
        function updateWeightPercentages(){
            let shares,error;
            try{shares=assignmentPercentages(percentageScope());}catch(e){error=e.message;}
            for(const card of query('[data-items]').querySelectorAll?.('.rom-bg-item') || []){
                const input=card.querySelector('[data-weight]'),hint=card.querySelector('[data-bg-ratio-state]');
                if(!input)continue;
                const info=percentageInfo(card.dataset.path),fixed=info.percentage!==undefined && info.percentage!==null && info.percentage!=='';
                // Fixed input values are never rescaled when another material changes.
                if(document.activeElement!==input && !input.validity?.badInput)input.value=fixed?String(info.percentage):'';
                const share=shares?.get(card.dataset.path);
                input.placeholder=share===undefined?'自动':`自动 ${Number(share.toFixed(2))}`;
                if(hint)hint.textContent=fixed?'固定比例':share===undefined?'未参与本次分配':`自动：${Number(share.toFixed(2))}%`;
            }
            if(error)status(error);
        }
        function updateCount(){
            updateWeightPercentages();
            query('[data-count]').textContent=`显示 ${filteredPaths().length} 个背景 · 勾选 ${checked.size} 个背景`;
            hooks.checkedChanged?.(checked.size);
            const paths=allPaths();module.querySelector('summary').textContent=`背景库 · ${libraries.size} 个文件夹 · ${paths.length} 个背景 · 常用 ${paths.filter(path=>libraryForPath(path)?.backgroundMetadata?.[path]?.favorite).length}`;
            for(const group of query('[data-items]').querySelectorAll?.('[data-bg-root]') || []){
                const item=libraries.get(group.dataset.bgRoot),visible=group.querySelectorAll('.rom-bg-item').length;
                group.querySelector('[data-bg-group-title]').textContent=`📁 ${basename(item.root)} · ${visible} 个背景 · 常用 ${(item.paths || []).filter(path=>item.backgroundMetadata?.[path]?.favorite).length}`;
            }
        }
        function render(){
            if(disposed)return;
            const filtered=filteredPaths(),expanded=new Map([...query('[data-items]').querySelectorAll?.('[data-bg-root]') || []].map(group=>[group.dataset.bgRoot,group.open]));
            query('[data-default]').innerHTML=options(active?.backgroundTarget);
            const tile=path=>{
                const info={...libraryForPath(path)?.backgroundMetadata?.[path],...drafts.get(path)},src=window.electronAPI?.toFileUrl?.(path) || path;
                return `<article draggable="true" class="rom-bg-item ${checked.has(path)?'rom-bg-checked':''}" data-path="${escape(path)}"><video crossorigin="anonymous" class="rbt-thumb-previewable" data-thumb-size="720" data-thumb-quality="0.92" muted preload="none" data-path="${escape(path)}" data-thumb-src="${escape(src)}#t=0.1"></video><label><input data-check type="checkbox" style="width:auto" ${checked.has(path)?'checked':''}>勾选分配</label><b>${escape(basename(path))}</b><button data-favorite aria-pressed="${!!info.favorite}">${info.favorite?'★ 常用':'☆ 标记常用'}</button><label class="rom-bg-weight">分配比例 <input data-weight type="number" min="0" max="100" step="any" aria-label="${escape(basename(path))} 的分配比例（百分比）" value="${escape(info.percentage==null?'':String(info.percentage))}" placeholder="自动" style="width:75px" title="填写即固定，留空自动分配剩余比例，其他修改不会改变固定值"> %</label><small data-bg-ratio-state></small><small data-assigned-count ${lastDistribution?'':'hidden'}>本次分配 ${lastDistribution?.get(path) || 0} 次</small>${backgroundTitleHtml(info.title)}<details class="rom-bg-editor"><summary>编辑配套</summary><div class="rom-bg-editor-body"><label>配套标题<textarea data-title rows="3" style="width:100%;box-sizing:border-box;background:#161e30;color:#edf2ff;border:1px solid #53658d">${escape(info.title)}</textarea></label><label>此背景的标题层<select data-target>${options(info.target,true)}</select></label><div class="rom-tools"><button data-capture>取当前任务的对应标题</button><button data-save>保存配套</button></div></div></details><button data-apply>应用背景＋标题</button></article>`;
            };
            query('[data-items]').innerHTML=[...libraries.values()].map(item=>{
                const paths=filtered.filter(path=>libraryForPath(path)?.root===item.root);
                return `<details data-bg-root="${escape(item.root)}" class="rom-bg-folder" ${expanded.get(item.root)!==false?'open':''}><summary data-bg-group-title title="${escape(item.root)}"></summary><small class="rom-hint">${escape(item.root)}</small><div class="rom-grid rom-background-grid">${paths.map(tile).join('') || '<p class="rom-hint">此文件夹没有符合筛选的背景。</p>'}</div></details>`;
            }).join('') || '<p class="rom-hint">请添加背景库文件夹；每个视频独立显示。</p>';
            updateCount();
            hooks.thumbnails();
        }
        async function open(root,action='refresh'){
            status('正在读取背景库…');const result=await call({root,action});if(disposed)return;merge(result);
            try{localStorage.setItem('videokit_background_library_root',result.root);}catch(_){}
            status(result.warning || '背景库已读取；可直接分配背景，配套标题为选填。');
        }
        function targetFrom(select){if(!select.value)return null;if(select.value==='missing')throw new Error('请重新选择有效的标题层');return JSON.parse(select.value);}
        function values(path){
            const card=[...query('[data-items]').querySelectorAll('.rom-bg-item')].find(item=>item.dataset.path===path),info={...libraryForPath(path)?.backgroundMetadata?.[path],...drafts.get(path)};
            const title=card?card.querySelector('[data-title]').value:info.title || '';
            const target=title.trim()?(card?targetFrom(card.querySelector('[data-target]')):info.target || null):null;
            const input=card?.querySelector('[data-weight]'),raw=input?input.value:info.percentage;
            if(input?.validity?.badInput)throw new Error(`「${basename(path)}」的分配比例无效，请输入 0–100%`);
            const percentage=raw===null || raw===undefined || String(raw).trim()===''?null:Number(raw);
            if(percentage!==null && (!Number.isFinite(percentage) || percentage<0 || percentage>100))throw new Error(`「${basename(path)}」的固定比例请输入 0–100%，留空自动`);
            return {title,target,weight:Number(info.weight ?? 1),percentage};
        }
        async function save(path){
            const value=values(path),library=libraryForPath(path),info=library.backgroundMetadata?.[path] || {};
            if(value.title===(info.title || '') && JSON.stringify(value.target)===JSON.stringify(info.target || null) && value.weight===(info.weight ?? 1) && (value.percentage ?? null)===(info.percentage ?? null)){
                drafts.delete(path);return value;
            }
            const result=await call({action:'background-meta',root:library.root,path,...value});
            merge(result,false);drafts.delete(path);status(result.unsynced?result.warning:'配套标题、分配权重与标题层绑定已保存到背景库文件夹');return value;
        }
        function openPairTable(){
            if(busy)return;
            if(!active){status('请先添加背景库');return;}
            const root=active.root,paths=filteredPaths().filter(path=>libraryForPath(path)?.root===root);
            if(!paths.length){status('当前筛选下没有背景视频');return;}
            if(paths.length>5000){status('请先筛选到 5000 个视频以内再进行表格配对');return;}
            let rows=paths.map(path=>({path,title:drafts.get(path)?.title ?? active.backgroundMetadata?.[path]?.title ?? ''})),tablePage=0,saving=false;
            const dialog=document.createElement('dialog');pairingDialog=dialog;dialog.className='rom-confirm rom-background-pairing-dialog';
            dialog.setAttribute('aria-label','背景视频与标题表格配对');
            dialog.style.cssText='inset:0;margin:auto;width:min(1000px,94vw);max-height:90vh;padding:20px;border-color:#7d9fdc';
            dialog.innerHTML=`<h3>背景视频 · 表格配对标题</h3><p>当前筛选共 ${rows.length} 个视频（包含所有分页），按文件名数字顺序排列。每行一个视频、一个标题；保存后沿用各视频已有的标题层绑定和常用标记。</p><label>从 Excel 或表格粘贴<textarea data-paste rows="4" aria-label="粘贴视频和标题表格" placeholder="视频名（或相对路径）&#9;标题&#10;背景01.mp4&#9;第一个标题&#10;背景02.mp4&#9;第二个标题" style="width:100%;box-sizing:border-box"></textarea></label><p>只粘贴一列标题：从第一行开始按顺序对应，空行保留位置。粘贴两列：按第一列视频名称匹配，重名时填写相对路径。可包含“视频 / 标题”表头。</p><button data-import>预览粘贴配对</button><output data-message aria-live="polite" style="display:block;margin:10px 0;white-space:pre-wrap"></output><div style="max-height:42vh;overflow:auto"><table style="width:100%;table-layout:fixed;border-collapse:collapse"><thead style="position:sticky;top:0;background:#243552"><tr><th style="width:42%;padding:8px;text-align:left">视频（顺序固定）</th><th style="padding:8px;text-align:left">配套标题（可编辑）</th></tr></thead><tbody data-rows></tbody></table></div><div class="rom-tools" style="display:flex;gap:12px;align-items:center;margin-top:10px"><button data-table-prev>上一页</button><output data-table-page></output><button data-table-next>下一页</button></div><div class="rom-confirm-actions"><button data-close>取消</button><button data-save-table class="rom-confirm-ok">保存全部配对</button></div>`;
            // Keep spreadsheet editing shortcuts inside this modal, away from overview actions.
            dialog.addEventListener('keydown',event=>event.stopPropagation());
            const find=selector=>dialog.querySelector(selector),message=text=>{find('[data-message]').textContent=text;};
            const draw=()=>{
                const pages=Math.max(1,Math.ceil(rows.length/50));tablePage=Math.min(tablePage,pages-1);
                find('[data-rows]').innerHTML=rows.slice(tablePage*50,(tablePage+1)*50).map((row,offset)=>{
                    const index=tablePage*50+offset,relative=row.path.slice(root.length+1);
                    return `<tr><td style="padding:8px;vertical-align:top;border-bottom:1px solid #4c5266;overflow-wrap:anywhere"><b>${index+1}. ${escape(basename(row.path))}</b><small style="display:block">${escape(relative)}</small></td><td style="padding:8px;border-bottom:1px solid #4c5266"><textarea data-row="${index}" aria-label="第 ${index+1} 个视频的标题" rows="3" style="width:100%;box-sizing:border-box;background:#162138;color:#edf2ff">${escape(row.title)}</textarea></td></tr>`;
                }).join('');
                find('[data-table-page]').textContent=`${tablePage+1} / ${pages} 页 · ${rows.length} 行`;
                find('[data-table-prev]').disabled=tablePage===0;find('[data-table-next]').disabled=tablePage===pages-1;
            };
            find('[data-rows]').oninput=event=>{if(event.target.matches('[data-row]'))rows[Number(event.target.dataset.row)].title=event.target.value;};
            find('[data-table-prev]').onclick=()=>{tablePage--;draw();};find('[data-table-next]').onclick=()=>{tablePage++;draw();};
            let pastedTable=null,appliedText=null;
            find('[data-paste]').addEventListener('paste',event=>{
                // HTML tables preserve multiline cells even when clipboard text is unquoted.
                const html=event.clipboardData?.getData('text/html');
                pastedTable=html && typeof window._bcParseClipboardTable==='function'?window._bcParseClipboardTable(html):null;
            });
            find('[data-paste]').addEventListener('input',event=>{if(event.inputType!=='insertFromPaste')pastedTable=null;});
            find('[data-import]').onclick=()=>{
                try{const result=pairTable(pastedTable || parseTable(find('[data-paste]').value),rows,root);rows=result.rows;appliedText=find('[data-paste]').value;tablePage=0;draw();message(`已预览 ${result.count} 行配对，其他行保持原标题。请检查下方表格，确认后保存。`);}
                catch(error){message(error.message);}
            };
            find('[data-close]').onclick=()=>dialog.close();
            dialog.addEventListener('cancel',event=>{if(saving)event.preventDefault();});
            dialog.addEventListener('close',()=>{dialog.remove();if(pairingDialog===dialog)pairingDialog=null;},{once:true});
            find('[data-save-table]').onclick=async()=>{
                if(saving)return;
                // Require an explicit preview when pasted text has not yet been applied.
                if(find('[data-paste]').value && appliedText!==find('[data-paste]').value){
                    message('请先点击“预览粘贴配对”，检查后再保存。');return;
                }
                saving=true;dialog.querySelectorAll('button,textarea').forEach(el=>el.disabled=true);message('正在统一保存配对…');
                try{
                    const result=await call({action:'background-titles',root,rows});
                    if(disposed)return;
                    merge(result);
                    for(const row of rows){const draft=drafts.get(row.path);if(draft){delete draft.title;if(!Object.keys(draft).length)drafts.delete(row.path);}}
                    status(result.unsynced?result.warning:`已保存 ${rows.length} 行背景标题配对到库文件夹`);dialog.close();render();
                }catch(error){message(error.message);}
                finally{saving=false;if(dialog.isConnected){dialog.querySelectorAll('button,textarea').forEach(el=>el.disabled=false);draw();}}
            };
            document.body.appendChild(dialog);draw();dialog.showModal();
        }
        function showDistributionResult(paths,order,group){
            const rows=assignmentSummary(paths,order).map(row=>({...row,title:values(row.path).title}));
            lastDistribution=new Map(rows.map(row=>[row.path,row.count]));
            const report=query('[data-distribution-result]');
            report.innerHTML=assignmentReportHtml(rows,group?.label || '背景');report.hidden=false;report.open=true;
            for(const card of query('[data-items]').querySelectorAll('.rom-bg-item')){
                const badge=card.querySelector('[data-assigned-count]');
                badge.hidden=false;badge.textContent=`本次分配 ${lastDistribution.get(card.dataset.path) || 0} 次`;
            }
            hooks.thumbnails();
        }
        function previewAdjustedCounts(){
            const report=query('[data-distribution-result]');
            try{
                if(!lastAssignment)throw new Error('请先分配背景');
                const fixed=Object.fromEntries([...report.querySelectorAll('[data-bg-fixed-count]')].map(input=>[input.dataset.bgFixedCount,input.value]));
                const order=adjustedAssignmentOrder(lastAssignment.paths,lastAssignment.order,fixed,{repeat:lastAssignment.repeat,weight:path=>assignmentPercentages(lastAssignment.paths).get(path)});
                const counts=new Map(assignmentSummary(lastAssignment.paths,order).map(row=>[row.path,row.count]));
                report.querySelectorAll('[data-bg-next-count]').forEach(label=>label.textContent=`调整后 ${counts.get(label.dataset.bgNextCount) || 0} 次`);
                report.querySelector('[data-bg-count-status]').textContent=`自动补齐完成，合计 ${order.length} 次；尚未应用。`;
                report.querySelector('[data-bg-count-apply]').disabled=false;return order;
            }catch(error){report.querySelector('[data-bg-count-status]').textContent=error.message;report.querySelector('[data-bg-count-apply]').disabled=true;return null;}
        }
        query('[data-distribution-result]').oninput=event=>{if(event.target.matches('[data-bg-fixed-count]'))previewAdjustedCounts();};
        query('[data-distribution-result]').onclick=event=>{
            if(!event.target.closest('[data-bg-count-apply]'))return;
            run(async()=>{const order=previewAdjustedCounts();if(order)distribute(lastAssignment.paths,false,{...lastAssignment,order});},{redraw:false});
        };
        function distribute(paths,random=false,adjustment=null,manual=false){
            const group=adjustment?.group || hooks.groups?.find(group=>group.key===query('[data-media-layer]').value);
            if(hooks.groups && !group)throw new Error('请选择有效的分配目标层');
            const targets=adjustment?.targets || hooks.targets(query('[data-scope]').value);if(!targets.length)throw new Error(query('[data-scope]').value==='current'?'请先点击右侧一张任务卡作为当前任务，或将分配范围改为“勾选任务”':'请先勾选右侧要分配的任务');
            const shares=adjustment || manual?null:assignmentPercentages(paths);
            const order=adjustment?.order || assignmentOrder(paths,targets.length,{random,repeat:query('[data-repeat]').checked,weight:path=>manual?1:shares.get(path)});
            const pairs=targets.map((card,index)=>{
                const path=order[index],value=values(path),target=value.target || libraryForPath(path)?.backgroundTarget;
                const background=group?.field==='pip'
                    ? {content:path,type:'video',media_loop:true}
                    : {bgPath:path,videoPath:path,bgMode:'single',bgClipPool:[],bgClipActivePool:[]};
                if(group?.field!=='pip' && value.title.trim()) {
                    resolveTarget(card.task,target);
                    background._overviewTitleBinding={target,title:value.title};
                }
                return {card,group,value:background};
            });
            hooks.apply(pairs);lastAssignment={paths:[...paths],order:[...order],targets:[...targets],group,repeat:adjustment?.repeat ?? query('[data-repeat]').checked};showDistributionResult(paths,order,group);status(group?.field==='pip'?`已分配 ${pairs.length} 个任务的「${group.label}」，可使用“撤销分配”恢复`:`已分配 ${pairs.length} 个任务的背景；有配套标题时一起应用，无标题时保留任务原标题，可使用“撤销分配”恢复`);
        }
        query('[data-add]').onclick=()=>run(async()=>{const api=window.electronAPI,roots=api?.selectDirectories?await api.selectDirectories():[await api?.selectDirectory?.()].filter(Boolean);for(const root of roots || [])await open(root,'bind');module.open=true;});
        query('[data-refresh]').onclick=()=>run(async()=>{if(!active)throw new Error('请先添加背景库');for(const root of libraries.keys())merge(await call({root,action:'refresh'}),false);status('全部背景库已刷新');});
        query('[data-library]').onchange=()=>run(()=>open(query('[data-library]').value));
        query('[data-unbind]').onclick=()=>run(async()=>{if(!active)return;const root=active.root;await call({action:'unbind',root});libraries.delete(root);libraryPaths.delete(root);for(const path of [...checked])if(!libraryForPath(path))checked.delete(path);active=[...libraries.values()].at(-1) || null;query('[data-library]').innerHTML=[...libraries.keys()].map(root=>`<option value="${escape(root)}">${escape(root)}</option>`).join('');status('已移出本机背景库列表，原视频和配套记录保留');});
        query('[data-default]').onchange=()=>run(async()=>{if(!active)throw new Error('请先添加背景库');merge(await call({action:'background-default',root:active.root,target:targetFrom(query('[data-default]'))}));status('默认配套标题层已保存');});
        query('[data-layers]').onclick=()=>render();
        query('[data-pair-table]').onclick=openPairTable;
        query('[data-search]').oninput=render;query('[data-favorites]').onchange=render;
        function selectVisible(mode){
            if(busy)return;
            if(mode==='clear')checked.clear();
            else for(const path of filteredPaths()){
                if(mode==='invert' && checked.has(path))checked.delete(path);else checked.add(path);
            }
            hooks.select?.([...checked].filter(path=>libraryForPath(path)).at(-1) || null);
            query('[data-items]').querySelectorAll('.rom-bg-item').forEach(card=>{
                const selected=checked.has(card.dataset.path);
                card.classList.toggle('rom-bg-checked',selected);card.querySelector('[data-check]').checked=selected;
            });
            updateCount();
        }
        query('[data-select-all]').onclick=()=>selectVisible('all');
        query('[data-clear]').onclick=()=>selectVisible('clear');
        query('[data-invert]').onclick=()=>selectVisible('invert');
        query('[data-sequential]').onclick=()=>run(async()=>{const paths=[...checked].filter(path=>libraryForPath(path));for(const path of paths)values(path);status('正在分配背景…');for(const path of paths)await save(path);distribute([...checked].filter(path=>libraryForPath(path)));},{redraw:false});
        query('[data-random]').onclick=()=>run(async()=>{const paths=[...checked].filter(path=>libraryForPath(path));for(const path of paths)values(path);status('正在分配背景…');for(const path of paths)await save(path);distribute([...checked].filter(path=>libraryForPath(path)),true);},{redraw:false});
        query('[data-items]').oninput=event=>{if(event.target.matches('[data-weight]')){const path=event.target.closest('.rom-bg-item').dataset.path;drafts.set(path,{...drafts.get(path),percentage:event.target.value.trim()===''?null:Number(event.target.value)});}if(event.target.matches('[data-title]')){const card=event.target.closest('[data-path]');drafts.set(card.dataset.path,{...drafts.get(card.dataset.path),title:event.target.value});}};
        function saveWeight(path,input){
            let percentage;
            try{
                const raw=input.value.trim();percentage=raw===''?null:Number(raw);
                if(input.validity?.badInput || (percentage!==null && (!Number.isFinite(percentage) || percentage<0 || percentage>100)))throw new Error('固定比例请输入 0–100%，留空自动');
                // Validate against the active pool without changing any other fixed value.
                assignmentPercentages(percentageScope());
            }catch(error){status(error.message);window.showToast?.(error.message,'warning');return;}
            weightSave=weightSave.then(async()=>{
                if(disposed)return;
                const result=await call({action:'background-meta',root:libraryForPath(path).root,path,percentage});
                if(disposed)return;
                merge(result,false);const draft=drafts.get(path);
                if(draft && draft.percentage===percentage){delete draft.percentage;if(!Object.keys(draft).length)drafts.delete(path);}
                updateWeightPercentages();status(result.unsynced?result.warning:'固定比例已保存，其他手动比例保持不变');
            }).catch(error=>{if(!disposed){status(error.message);window.showToast?.(error.message,'warning');}});
        }
        query('[data-items]').onchange=event=>{if(event.target.matches('[data-weight]')){
            saveWeight(event.target.closest('.rom-bg-item').dataset.path,event.target);return;
        }if(event.target.matches('[data-target]')){const card=event.target.closest('[data-path]');drafts.set(card.dataset.path,{...drafts.get(card.dataset.path),target:targetFrom(event.target)});return;}if(!event.target.matches('[data-check]'))return;const path=event.target.closest('[data-path]').dataset.path;if(event.target.checked){checked.add(path);hooks.select?.(path);}else{checked.delete(path);hooks.select?.([...checked].filter(path=>libraryForPath(path)).at(-1) || null);}event.target.closest('.rom-bg-item').classList.toggle('rom-bg-checked',event.target.checked);updateCount();};
        async function toggleFavorite(card,path){
            const library=libraryForPath(path);if(!library)throw new Error('背景库已移出，请刷新后重试');
            const result=await call({action:'background-meta',root:library.root,path,favorite:!library.backgroundMetadata?.[path]?.favorite});
            if(disposed)return;merge(result,false);
            const favorite=!!libraryForPath(path)?.backgroundMetadata?.[path]?.favorite,button=card.querySelector('[data-favorite]');
            button.textContent=favorite?'★ 常用':'☆ 标记常用';button.setAttribute('aria-pressed',String(favorite));
            if(query('[data-favorites]').checked && !favorite){checked.delete(path);card.remove();hooks.select?.([...checked].at(-1) || null);}
            updateCount();status(result.unsynced?result.warning:'常用标记已保存到对应背景库文件夹');
        }
        query('[data-items]').onclick=event=>{
            const card=event.target.closest('.rom-bg-item');if(!card || busy)return;
            const button=event.target.closest('button'),path=card.dataset.path;
            if(!button){
                // Inputs and their labels retain native behavior; the rest of the tile toggles selection.
                if(event.target.closest('input,textarea,select,label,summary,.rom-bg-editor'))return;
                const input=card.querySelector('[data-check]');input.checked=!input.checked;
                input.dispatchEvent(new Event('change',{bubbles:true}));return;
            }
            if(button.hasAttribute('data-favorite'))run(()=>toggleFavorite(card,path),{redraw:false});
            if(button.hasAttribute('data-save'))run(()=>save(path));
            if(button.hasAttribute('data-apply'))run(async()=>{await save(path);distribute([path],false,null,true);},{redraw:false});
            if(button.hasAttribute('data-capture')){try{const target=targetFrom(card.querySelector('[data-target]')) || libraryForPath(path)?.backgroundTarget,task=hooks.current()?.task;if(!task)throw new Error('请先选中任务');const title=resolveTarget(task,target)[target.field] || '';card.querySelector('[data-title]').value=title;drafts.set(path,{...drafts.get(path),title});}catch(error){status(error.message);}}
        };
        module.addEventListener('toggle',()=>hooks.thumbnails());
        status('正在恢复背景库…');
        const ready=run(async()=>{
            const {roots}=await call({action:'list'});let preferred;try{preferred=localStorage.getItem('videokit_background_library_root');}catch(_){}
            for(const root of roots.filter(root=>root!==preferred)){if(disposed)return;const result=await call({action:'refresh',root});if(!disposed)merge(result);}
            if(roots.includes(preferred))await open(preferred);else if(active)status('背景库及配套标题已恢复');else status('请添加一个背景库文件夹，每个视频将独立显示。');
        });
        return {selectVisible,async refreshAll(){
            await ready;await weightSave;const failures=[];
            for(const root of [...libraries.keys()]){if(disposed)break;try{merge(await call({root,action:'refresh'}),false);}catch(error){failures.push(`${root}：${error.message}`);}}
            if(!disposed)render();return failures;
        },get checkedCount(){return checked.size;},targetGroup:assignmentGroup,selectionChanged(count){query('[data-scope] option[value="selected"]').textContent=`勾选任务（${count}）`;if(count)query('[data-scope]').value='selected';},dispose(){disposed=true;pairingDialog?.close();module.remove();}};
    }
    window.ReelsBackgroundLibrary={backgroundPercentages,backgroundTitleHtml,adjustedAssignmentOrder,assignmentSummary,assignmentReportHtml,assignmentOrder,isBackgroundLinked,captureLinkedMedia,restoreLinkedMedia,syncLinkedMedia,mount,titleLayers,resolveTarget,applyTitle,parseTable,pairTable,hasPath};
})();
