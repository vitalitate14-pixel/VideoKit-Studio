/** Column-aware media inventory. Counts are derived from assignments, never incremented counters. */
(() => {
    'use strict';
    const valid = path => /\.(mp4|mov|avi|mkv|webm|m4v|jpe?g|png|webp|gif|bmp)$/i.test(path || '');
    const image = path => /\.(jpe?g|png|webp|gif|bmp)$/i.test(path || '');
    const basename = path => String(path).split(/[\\/]/).pop();
    const parent = path => String(path).replace(/[\\/][^\\/]+$/, '');
    const escape = text => String(text).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    function originalGroupCandidates(value, entries, {useLatest=false}={}) {
        const clean = path => String(path || '').replace(/\\/g,'/').replace(/\/$/,'');
        const key = path => clean(path).normalize('NFC').toLowerCase();
        const original = clean(value.media_folder_path), name = basename(original);
        if(!original)return [];
        const files = new Map(entries.map(entry=>typeof entry==='string'?entry:entry.path).filter(valid).map(path=>[key(path),path]));
        const directories = new Map();
        for(const file of files.values()){
            let directory=parent(clean(file));
            while(directory && directory!==parent(directory)){
                if(key(basename(directory))===key(name))directories.set(key(directory),directory);
                directory=parent(directory);
            }
        }
        const expected = value.media_folder_files?.length ? value.media_folder_files : [value.content].filter(Boolean);
        const candidates=[];
        for(const directory of directories.values()){
            const mapped=useLatest ? [...files.values()].filter(file=>key(file).startsWith(key(directory)+'/'))
                .sort((a,b)=>a.localeCompare(b,undefined,{numeric:true,sensitivity:'base'})) : expected.map(file=>{
                const raw=clean(file),relative=key(raw).startsWith(key(original)+'/')?raw.slice(original.length+1):basename(raw);
                return files.get(key(directory+'/'+relative));
            });
            if(!mapped.length || mapped.some(file=>!file))continue;
            const a=key(original).split('/'),b=key(directory).split('/');let score=0;
            while(score<Math.min(a.length,b.length) && a[a.length-1-score]===b[b.length-1-score])score++;
            candidates.push({directory,files:mapped,score,useLatest});
        }
        return candidates.sort((a,b)=>b.score-a.score || a.directory.localeCompare(b.directory));
    }
    function relinkedGroupValue(original,candidate) {
        const transient=new Set(['_allOverlays','_cachedUrl','_currentFrameImage','_exportImage','_exportFolderImages','_folderFramesByPath','_imageEl','_videoEl','_img']);
        const value={...JSON.parse(JSON.stringify(original,(key,value)=>transient.has(key)?undefined:value)),content:candidate.files[candidate.useLatest?0:Math.max(0,(original.media_folder_files || []).indexOf(original.content))] || candidate.files[0],
            media_folder_path:candidate.directory,media_folder_files:[...candidate.files]};
        if(candidate.useLatest){
            value.type=image(value.content)?'image':'video';
            for(const key of ['media_folder_items','media_folder_durations','media_folder_duration_paths',
                'sequence_frames','is_img_sequence','fps','video_start_offset','video_end_offset',
                '_cachedUrl','_currentFrameImage','_exportImage','_exportFolderImages','_folderFramesByPath','_framesDir','_frameCount',
                '_folderDurationPending','_imageEl','_videoEl','_img'])delete value[key];
        }else{
            if(Array.isArray(value.media_folder_items))value.media_folder_items=value.media_folder_items.map(item=>{
                const index=(original.media_folder_files || []).indexOf(item.path);
                return index<0?item:{...item,path:candidate.files[index]};
            });
            if(Array.isArray(value.media_folder_duration_paths))value.media_folder_duration_paths=value.media_folder_duration_paths.map(path=>{
                const index=(original.media_folder_files || []).indexOf(path);
                return index<0?path:candidate.files[index];
            });
        }
        return value;
    }
    // Refresh exact bindings only: never search elsewhere for missing files or groups.
    async function refreshLinkedBindings(context,tasks,api,{stopped=()=>false,onProgress=()=>{}}={}) {
        if(!api?.scanDirectoryRecursive || !api?.checkFilesExist)throw new Error('请在桌面版刷新关联素材');
        const directories=new Map(),entries=[],failures=[],checks=new Map();
        const exists=path=>{
            if(!checks.has(path))checks.set(path,api.checkFilesExist([path]).then(result=>!!result[path]));
            return checks.get(path);
        };
        let removed=0,added=0;
        for(const task of tasks)for(const group of context.groups){
            if(stopped())return {entries:[],failures,removed:0,added:0,cancelled:true};
            const before=context.read(task,group);if(!before)continue;
            const folder=before.media_folder_path;
            let next;
            try{
                if(folder){
                    onProgress(`正在刷新素材组：${folder}`);
                    if(!directories.has(folder))directories.set(folder,api.scanDirectoryRecursive(folder,{maxDepth:20,throwOnError:true}));
                    const scanned=await directories.get(folder);
                    const files=[...new Set(scanned.filter(item=>!item?.isDirectory).map(item=>typeof item==='string'?item:item.path).filter(valid))]
                        .sort((a,b)=>a.localeCompare(b,undefined,{numeric:true,sensitivity:'base'}));
                    next=relinkedGroupValue(before,{directory:folder,files,useLatest:true});
                    next.content=files.includes(before.content)?before.content:(files[0] || '');
                    if(next.content)next.type=image(next.content)?'image':'video';else next.type=before.type;
                    const old=new Set(before.media_folder_files || [before.content].filter(Boolean));
                    removed+=[...old].filter(path=>!files.includes(path)).length;added+=files.filter(path=>!old.has(path)).length;
                }else if(group.field==='bg'){
                    const paths=[...new Set([before.bgPath,before.videoPath,...(before.bgClipPool || []).map(item=>typeof item==='string'?item:item?.path),...(before.bgClipActivePool || []).map(item=>typeof item==='string'?item:item?.path)].filter(Boolean))];
                    if(!paths.length)continue;
                    const present=new Set();for(const path of paths)if(await exists(path))present.add(path);
                    const keep=items=>(items || []).filter(item=>present.has(typeof item==='string'?item:item?.path));
                    next={...before,bgClipPool:keep(before.bgClipPool),bgClipActivePool:keep(before.bgClipActivePool)};
                    delete next._overviewTextcards;
                    const first=next.bgClipActivePool[0] || next.bgClipPool[0];
                    next.bgPath=present.has(before.bgPath)?before.bgPath:(typeof first==='string'?first:first?.path) || '';
                    next.videoPath=next.bgPath && !image(next.bgPath)?next.bgPath:'';
                    if(present.size!==paths.length){
                        // Removed sources must not return through the saved background timeline.
                        delete next._overviewBackgroundState;delete next._overviewLinkedMedia;
                    }
                    removed+=paths.length-present.size;
                }else if(before.media_folder_files?.length){
                    const files=[];for(const path of before.media_folder_files)if(await exists(path))files.push(path);
                    next=relinkedGroupValue(before,{directory:'',files,useLatest:true});delete next.media_folder_path;
                    next.content=files.includes(before.content)?before.content:(files[0] || '');
                    if(next.content)next.type=image(next.content)?'image':'video';else next.type=before.type;
                    removed+=before.media_folder_files.length-files.length;
                }else if(before.content){
                    const present=await exists(before.content);
                    next={...before};
                    for(const key of ['_cachedUrl','_currentFrameImage','_exportImage','_imageEl','_videoEl','_img'])delete next[key];
                    next.content=present?before.content:'';next.type=before.type;
                    if(!present)removed++;
                }else continue;
                entries.push({task,group,value:before,next});
            }catch(error){failures.push(`${folder || before.content || before.bgPath || group.label}：${error.message}`);}
        }
        if(stopped())return {entries:[],failures,removed:0,added:0,cancelled:true};
        return {entries,failures,removed,added,directories:directories.size};
    }
    function readSourceQuantityRules(scope,prefix,keys){
        return Object.fromEntries(keys.map(key=>{
            const inputs=[...scope.querySelectorAll(`[data-${prefix}-weight="${key}"]`)];
            const percentages=Object.fromEntries(inputs.filter(input=>input.value.trim()!=='').map(input=>[input.dataset.quantity,Number(input.value)]));
            const automaticQuantities=inputs.filter(input=>input.value.trim()==='').map(input=>input.dataset.quantity);
            const fixed=Object.values(percentages).reduce((sum,value)=>sum+value,0),automatic=automaticQuantities.length?Math.max(0,100-fixed)/automaticQuantities.length:0;
            return [key,{min:Number(scope.querySelector(`[data-${prefix}-min="${key}"]`).value),max:Number(scope.querySelector(`[data-${prefix}-max="${key}"]`).value),percentages,automaticQuantities,
                weights:Object.fromEntries(inputs.map(input=>[input.dataset.quantity,percentages[input.dataset.quantity] ?? automatic]))}];
        }));
    }
    function renderSourceQuantityWeights(scope,prefix,rules,maxSlots){
        for(const [key,rule] of Object.entries(rules)){
            const maxInput=scope.querySelector(`[data-${prefix}-max="${key}"]`);if(!maxInput)continue;
            let host=scope.querySelector(`[data-${prefix}-weights="${key}"]`);
            if(!host){host=document.createElement('div');host.setAttribute(`data-${prefix}-weights`,key);host.style.cssText='flex-basis:100%;padding:6px 0;font-size:12px';maxInput.closest('label').after(host);}
            const low=rule.min || 0,high=Math.min(rule.max || maxSlots,maxSlots);
            const choices=Array.from({length:Math.max(0,high-low+1)},(_,index)=>low+index);
            const complete=choices.every(count=>rule.weights?.[count]!==undefined);
            const total=choices.reduce((sum,count)=>sum+(rule.weights?.[count] || 0),0);
            const scale=complete && total>0?total/100:1;
            const percentages=rule.percentages ?? Object.fromEntries(choices.filter(count=>rule.weights?.[count]!==undefined).map(count=>[count,Number((rule.weights[count]/scale).toFixed(6))]));
            host.innerHTML='数量比例：'+Array.from({length:Math.max(0,high-low+1)},(_,index)=>{
                const count=low+index;
                return `<label style="display:inline-flex;gap:4px;margin:4px">${count} 个 <input data-${prefix}-weight="${escape(key)}" data-quantity="${count}" aria-label="${escape(key)} ${count} 个的比例（百分比）" type="number" min="0" max="100" step="any" placeholder="自动" value="${escape(percentages[count] ?? '')}" style="width:75px"> %</label>`;
            }).join('')+'<button type="button" data-quantity-reset style="font-size:11px;margin:4px">恢复随机比例</button><small style="display:block">填写的百分比固定保留，留空自动分配剩余比例；0% 不抽取该数量。手动合计不能超过 100%，全部手填时需合计 100%。可用素材、层数和其他来源限制仍须满足。</small>';
            host.querySelector('[data-quantity-reset]').onclick=()=>{
                const inputs=[...host.querySelectorAll('input')];inputs.forEach(input=>input.value='');
                inputs[0]?.dispatchEvent(new Event('change',{bubbles:true}));
            };
        }
    }
    function syncPreviewVisibility(dialog){
        const names=dialog.querySelector('[data-plan-names]').checked;
        const phones=dialog.querySelector('[data-plan-phones]').checked;
        dialog.classList.toggle('rom-plan-hide-names',!names);
        for(const label of dialog.querySelectorAll('[data-file-position]'))label.textContent=names?label.dataset.fullLabel:label.dataset.position;
        for(const group of dialog.querySelectorAll('.rom-plan-pairs')){
            let visible=0;
            for(const tile of group.querySelectorAll('[data-pair-tile]')){
                tile.hidden=!phones && tile.dataset.pairPhone==='true';
                if(tile.hidden)tile.querySelectorAll('video').forEach(video=>video.pause());else visible++;
            }
            group.style.setProperty('--pair-slots',String(Math.max(1,visible)));
        }
    }
    function materialSourceInfo(item){
        const paths=[item.path,...(item.files || [])].filter(Boolean).map(path=>String(path).replace(/\\/g,'/'));
        const archived=paths.find(path=>/(?:^|\/)本批已经使用\//.test(path));
        const batch=isPersistentSource(item.origin)?'':(item.archiveBatchId || archived?.match(/(?:^|\/)本批已经使用\/([^/]+)/)?.[1] || '');
        const root=String(item.archiveRoot || item.root || (archived?archived.split('/本批已经使用/')[0]:parent(paths[0] || ''))).replace(/\\/g,'/');
        const origin={temporary:'临时素材',library:'固定素材',characters:'爆贴人物库',batch:'本批素材'}[item.origin] || item.origin || '素材';
        const parts=item.phone?['电话库','来源文件夹：'+basename(parent(paths[0] || ''))]
            : [origin,batch?'历史批次：'+batch:item.origin==='temporary'?'本次导入':'',root?'来源文件夹：'+basename(root):''].filter(Boolean);
        const html=parts.map((part,index)=>{
            if(!item.phone && item.origin==='characters' && index===0)return `<span data-source-highlight="characters" style="color:#ffbd69;font-weight:800;background:#573714;padding:2px 5px;border-radius:4px">🔥 ${escape(part)}</span>`;
            if(!item.phone && item.origin==='temporary' && index===0)return `<span data-source-highlight="temporary" style="color:#75dcff;font-weight:700">${escape(part)}</span>`;
            if(!item.phone && item.origin==='temporary' && batch && index===1)return `<span data-source-highlight="history" style="color:#ffd479;font-weight:700">${escape(part)}</span>`;
            return escape(part);
        }).join(' · ');
        return {label:parts.join(' · '),html,title:[...new Set([root,...paths].filter(Boolean))].join('\n')};
    }
    function batchUsageReportHtml(planned,materials,quotas={}){
        const rows=window.ReelsCombinationPlanner.batchUsage(planned,materials);
        const table=(items,keyword=false)=>`<table><thead><tr><th>${keyword?'关键词':'来源 / 素材套上一层父文件夹'}</th><th>${keyword?'当前预览套数':'填入媒体层次数'}</th>${keyword?'':'<th>使用素材组数（去重）</th>'}<th>${keyword?'指定套数':'指定使用次数'}</th></tr></thead><tbody>${items.map(row=>`<tr><td title="${escape(row.label)}">${escape(row.label)}</td><td>${row.count} ${row.unit}</td>${keyword?'':`<td>${row.unique} 组</td>`}<td><input data-batch-quota-key="${escape(row.key)}" aria-label="${escape(row.label)} 的本批指定数量" type="number" min="0" step="1" placeholder="自动" value="${escape(quotas[row.key] ?? '')}" style="width:85px"> ${row.unit}</td></tr>`).join('')}</tbody></table>`;
        return `<section class="rom-batch-usage-report"><h4>本批匹配用量 · 可调整数量</h4><p>普通素材按填入媒体层的次数统计，同一素材组重复使用会分别计数；历史指位于历史批次的临时素材。指定数量固定，留空自动补齐，0 表示本轮不用；文件夹按素材套的上一层父级统计，关键词按组合套数统计。</p>${table(rows.filter(row=>row.key.startsWith('source:') || (row.key.startsWith('history:') && !['history:library','history:characters'].includes(row.key))))}<details open><summary>父文件夹用量与数量调整</summary><div style="max-height:360px;overflow:auto">${table(rows.filter(row=>row.key.startsWith('folder:')))}</div></details><details open><summary>关键词套数与数量调整</summary>${table(rows.filter(row=>row.key.startsWith('keyword:')),true)}</details><output data-batch-quota-status role="status"></output><button data-batch-quota-apply>按数量调整并补齐</button><button data-batch-quota-clear>清除指定数量</button></section>`;
    }
    function combinationReportHtml(planned,materials,quotas={}){
        const rows=window.ReelsCombinationPlanner.distributionReport(planned,materials);
        const phones=rows.flatMap(row=>row.phones.map(phone=>`<tr><td>${escape(row.keyword)}</td><td>${escape(phone.label)}${phone.recognized?'':'（按文件名分组，未识别到号码）'}</td><td>${phone.uses} 次</td><td><input data-batch-quota-key="${escape(phone.quotaKey)}" aria-label="${escape(row.keyword)} ${escape(phone.label)} 的指定使用次数" type="number" min="0" step="1" placeholder="自动" value="${escape(quotas[phone.quotaKey] ?? '')}" style="width:85px"> 次</td></tr>`));
        return `<style>.rom-result-report table{width:100%;border-collapse:collapse;font-size:12px;margin:10px 0}.rom-result-report th,.rom-result-report td{border:1px solid #555c70;padding:7px 10px;text-align:left;overflow-wrap:anywhere}.rom-result-report th{background:#303647}.rom-result-report p{font-size:12px;line-height:1.6;color:#c5c9d5}</style><div class="rom-result-report">${batchUsageReportHtml(planned,materials,quotas)}<p data-report-state>当前预览：已配 ${planned.combinations.length} 套，未配 ${planned.shortage || 0} 套。确认采用后生效；更换素材后报告自动更新。</p><table aria-label="每个关键词的电话组使用次数"><thead><tr><th>关键词</th><th>电话组（整组号码）</th><th>当前预览使用次数</th><th>指定使用次数</th></tr></thead><tbody>${phones.join('') || '<tr><td colspan="4">当前没有电话素材</td></tr>'}</tbody></table><p>电话组指定次数按当前关键词统计，同一组号码的不同样式合并计数；留空自动分配，0 表示本轮不用，正整数表示指定次数。与上方关键词、来源数量一起点击“按数量调整并补齐”后更新预览，确认替换后生效。</p><button data-batch-quota-apply>按数量调整并补齐</button><p>未指定次数的电话组在同一关键词下按整组号码尽量均衡，样式随机；号码组本轮次数相同时优先历史使用较少的组。已有草稿、手动选择和使用上限等限制可能影响均衡。</p></div>`;
    }
    const available = path => !window.electronAPI?.fileExists || window.electronAPI.fileExists(path);
    function mediaSource(path) {
        if (!available(path)) return '';
        // 空返回值表示加载检查未通过，不能再回退到已失效的原路径。
        if (typeof window._toPlayablePath === 'function') return window._toPlayablePath(path) || '';
        return window.electronAPI?.toFileUrl?.(path) || path;
    }
    function orderPaths(paths, compare, previous = []) {
        const available = new Set(paths);
        const retained = previous.filter(path => available.has(path));
        const seen = new Set(retained);
        return [...retained, ...paths.filter(path => !seen.has(path)).sort(compare)];
    }
    const pathsOf = (value, group) => {
        if (!value) return [];
        const items = group.field === 'bg'
            ? (value.bgMode === 'multi' ? (value.bgClipActivePool?.length ? value.bgClipActivePool : value.bgClipPool || []) : [value.bgPath || value.videoPath])
            : (value.media_folder_files?.length ? value.media_folder_files : [value.content]);
        return [...new Set(items.map(item => typeof item === 'string' ? item : item?.path).filter(valid))];
    };
    function bindingOf(value, group, check = available) {
        const files = pathsOf(value, group);
        if (group.field !== 'bg' && (value?.media_folder_path || value?.media_folder_files?.length)) {
            if(!files.length)return [];
            const first = files[0] || value.content || '';
            const path = value.media_folder_path || parent(first) || (first.startsWith('/') ? '/' : '');
            return path ? [{path, folder:true, files, preview:files.find(check) || files[0] || '', value:JSON.parse(JSON.stringify(value))}] : [];
        }
        return files.map(path => ({path, folder:false, files:[path], preview:path}));
    }
    function unitFor(context, path, key) {
        const units = context.saved._units || {};
        return units[`${key}\n${path}`] || Object.values(units).find(unit => unit.path === path);
    }
    function listPaths(context, key) {
        // 文件夹绑定以目录路径为素材单元，目录本身没有媒体扩展名。
        // 与普通文件一起显示，不能再按单文件扩展名过滤掉整个覆层。
        return [...new Set(context.saved[key] || [])]
            .filter(path => unitFor(context, path, key)?.folder || valid(path));
    }
    const importGroupKey = selected => selected === 'all' ? 'unclassified' : selected;
    const selectedTaskCards = (cards, selected) => cards.filter(card => selected.has(card.task));
    function pairingFailureDetails(planned,candidates,slots,options={},excluded=[]){
        if(!planned?.shortage)return '';
        const lines=[`目标 ${planned.requested || options.count || 0} 套，已配 ${planned.combinations?.length || 0} 套，还缺 ${planned.shortage} 套。`];
        const counts=new Map();for(const item of excluded)counts.set(item.reason,(counts.get(item.reason)||0)+1);
        for(const [reason,count] of counts){const examples=excluded.filter(item=>item.reason===reason).slice(0,3).map(item=>item.name || item.path).join('、');lines.push(`排除 ${count} 组：${reason}${examples?'（'+examples+'）':''}`);}
        const keys=[...new Set(candidates.flatMap(item=>item.keywords || [item.keyword]).filter(Boolean))];
        for(const key of keys)for(const slot of slots){
            const eligible=candidates.filter(item=>(item.keywords || [item.keyword]).includes(key) && (!options.accept || options.accept(item,slot,planned.missing?.[0] || 0,key)));
            const round=eligible.filter(item=>(planned.uses?.[item.id] || 0)>=(item.phone?(options.phoneMaxUses || Infinity):item.origin==='characters' && options.characterMaxUses!=null?(options.characterMaxUses || Infinity):options.maxUses || Infinity));
            const history=eligible.filter(item=>!item.phone && options.totalMax && (item.history || 0)+(planned.uses?.[item.id] || 0)>=options.totalMax);
            if(!eligible.length)lines.push(`「${key}」→「${slot.label || slot.key}」：没有符合条件的素材${/电话/.test(slot.label || '')?'，请检查电话库关键词和绑定层':''}。`);
            else if(new Set([...round,...history].map(item=>item.id)).size===eligible.length)lines.push(`「${key}」→「${slot.label || slot.key}」：${eligible.length} 组均已达到限制（本轮 ${round.length} 组，历史 ${history.length} 组）。`);
        }
        for(const [source,limit] of Object.entries(options.sourceLimits || {}))if(limit.min){
            const count=candidates.filter(item=>!item.phone && item.origin===source).length;
            if(count<limit.min)lines.push(`来源「${source}」每套至少 ${limit.min} 组，目前只有 ${count} 组。`);
        }
        if(lines.length===1 || planned.combinations?.length)lines.push(`当前限制：普通素材每轮 ${options.maxUses || '不限'} 次，电话 ${options.phoneMaxUses || '不限'} 次，历史 ${options.totalMax || '不限'} 次；${options.allowRepeated?'允许':'不允许'}重复整套组合。请检查每套来源数量、同关键词素材能否填满所选层，以及指定数量。`);
        return lines.join('\n');
    }
    async function previewAction(settings, action, {paint=()=>new Promise(resolve=>requestAnimationFrame(()=>setTimeout(resolve,0))), onError=()=>{}}={}) {
        const button=settings.querySelector('[data-pair-preview]'),message=settings.querySelector('[data-pair-feedback]');
        if(button.disabled)return;
        const label=button.textContent;
        button.disabled=true;button.textContent='正在随机配对…';message.textContent='正在计算配对并加载预览…';
        settings.setAttribute('aria-busy','true');
        try{await paint();await action();message.textContent='预览已打开，确认替换后生效。';}
        catch(error){message.textContent=`无法预览：${error.message}`;onError(message.textContent);}
        finally{button.disabled=false;button.textContent=label;settings.removeAttribute('aria-busy');}
    }
    // Apply the preview to existing tasks, with one undo batch and rollback on failure.
    async function replaceCombinations(context, targets, combinations, {validate=()=>{}, beforeWrite=()=>{}, recordUse=()=>null, recordUses=null, cancelUse=()=>{}, onProgress=()=>{}}={}) {
        if(!targets.length || combinations.length!==targets.length)throw new Error('配对数量与目标任务不一致，请重新预览');
        const prepared=targets.flatMap((card,index)=>{
            const combo=combinations[index];
            validate(card,combo);
            return combo.pairs.map(({slot,item})=>({task:card.task,group:slot,item,
                value:context.read(card.task,slot),next:JSON.parse(JSON.stringify(item.values[slot.key]))}));
        });
        beforeWrite();
        const entries=[];context.beginBatch?.();
        try {
            for(const entry of prepared){
                await onProgress({stage:"replace",completed:entries.length,total:prepared.length,item:entry.item.name});
                entries.push(entry);
                context.write(entry.task,entry.group,entry.next);
                if(JSON.stringify(pathsOf(context.read(entry.task,entry.group),entry.group))!==JSON.stringify(pathsOf(entry.next,entry.group)))throw new Error(`任务 ${targets.findIndex(card=>card.task===entry.task)+1} · ${entry.group.label || entry.group.key}：素材写入未生效，已撤销本次替换`);
                if(JSON.stringify(pathsOf(entry.value,entry.group))!==JSON.stringify(pathsOf(entry.next,entry.group))){
                    if(recordUses)continue;
                    const usage=recordUse(entry.task,pathsOf(entry.next,entry.group),{root:entry.item.folder===false?parent(entry.item.path):entry.item.path});
                    entry.usage=usage?.record;
                    await usage?.ready;
                }
            }
            if(recordUses){
                const changed=entries.filter(entry=>JSON.stringify(pathsOf(entry.value,entry.group))!==JSON.stringify(pathsOf(entry.next,entry.group)));
                if(changed.length){
                    const batch=recordUses(changed.map(entry=>({task:entry.task,paths:pathsOf(entry.next,entry.group),options:{root:entry.item.folder===false?parent(entry.item.path):entry.item.path}})));
                    changed.forEach((entry,index)=>entry.usage=batch.entries[index].record);
                    await batch.ready;
                }
            }
            await onProgress({stage:"replace",completed:prepared.length,total:prepared.length});
        }catch(error){
            await onProgress({stage:"rollback",completed:0,total:entries.length});
            for(const entry of entries.slice().reverse()){
                context.write(entry.task,entry.group,entry.value);
                if(entry.usage)await cancelUse(entry.task,entry.usage);
            }
            throw error;
        }finally{context.endBatch?.();}
        return entries;
    }
    async function replaceSingle(context, task, group, next, {beforeWrite=()=>{},recordUse=()=>null,cancelUse=()=>{},move=async()=>null,rollback=async()=>{},relocate=()=>{},usageRoot=''}={}) {
        const entry={task,group,value:context.read(task,group)};
        const changed=JSON.stringify(pathsOf(entry.value,group))!==JSON.stringify(pathsOf(next,group));
        beforeWrite();context.beginBatch?.();
        try{
            context.write(task,group,next);
            if(JSON.stringify(pathsOf(context.read(task,group),group))!==JSON.stringify(pathsOf(next,group)))throw new Error(`${group.label || group.key}：素材写入未生效，原素材已保留`);
            if(changed){
                const usage=recordUse(task,pathsOf(next,group),{root:usageRoot});
                entry.usage=usage?.record;await usage?.ready;
                entry.archive=await move();
                if(entry.archive){
                    window.ReelsMediaRelocation.remap([entry.value,entry.usage],entry.archive.mappings);
                    relocate(entry.archive.mappings);
                }
            }
            return entry;
        }catch(error){
            if(entry.archive){
                const restored=await rollback(entry.archive);
                window.ReelsMediaRelocation.remap([entry.value,entry.usage],restored.mappings);
                relocate(restored.mappings);
            }
            context.write(task,group,entry.value);
            if(entry.usage)await cancelUse(task,entry.usage);
            throw error;
        }finally{context.endBatch?.();}
    }
    function selectTasks(cards, selected, mode) {
        for(const card of cards) {
            if(mode==='clear' || (mode==='invert' && selected.has(card.task)))selected.delete(card.task);
            else selected.add(card.task);
        }
    }
    function archiveCandidates(combinations,{isPhone=slot=>/^phone_|^pip:phone_/.test(slot?.mediaSlot || slot?.key || ''),protectedPaths=[]}={}){
        const pairs=combinations.flatMap(combo=>combo.pairs);
        const protectedPair=({slot,item})=>slot.field==='bg' || item.phone || isPhone(slot);
        const normalize=path=>String(path || '').replace(/\\/g,'/').replace(/\/+$/,'');
        const keep=new Set([...protectedPaths,...pairs.filter(protectedPair).flatMap(({item})=>item.files || [])].map(normalize));
        return [...new Map(pairs.filter(pair=>!protectedPair(pair)).map(({item})=>[item.id,item])).values()].filter(item=>{
            const directory=normalize(item.path);
            return ![...keep].some(file=>file===directory || file.startsWith(directory+'/') || (item.files || []).some(path=>normalize(path)===file));
        });
    }
    function archiveUnits(items,{roots=[],rootFor=()=>''}={}){
        const norm=path=>String(path || '').replace(/\\/g,'/').replace(/\/+$/,'');
        const within=(root,path)=>root && norm(path).startsWith(norm(root)+'/');
        return items.map(item=>{
            const explicit=[item.archiveRoot,item.root].find(root=>within(root,item.path));
            const known=roots.map(entry=>typeof entry==='string'?entry:entry.root).filter(root=>within(root,item.path)).sort((a,b)=>norm(b).length-norm(a).length)[0];
            const tracked=rootFor(item.files[0],true);
            // recordUse may track a suite itself. Such a root would scatter each clip
            // into suite/本批已经使用 instead of archiving the whole suite under its library.
            const root=norm(explicit || known || (within(tracked,item.path)?tracked:parent(item.path)));
            if(!root || !within(root,item.path))throw new Error(`无法确定素材归档根目录：${item.name || item.path}`);
            return {root,path:item.path};
        });
    }
    function syncCandidateBadges(container,pool,create=()=>document.createElement('small')) {
        const normalize=path=>String(path || '').replace(/\\/g,'/').replace(/\/+$/,'').normalize('NFC');
        const included=new Set(pool.map(item=>normalize(item.path)));
        for(const tile of container.querySelectorAll('.rom-item[data-path]')){
            const joined=included.has(normalize(tile.dataset.path));
            let badge=tile.querySelector('.rom-candidate-badge');
            tile.classList.toggle('rom-in-candidate-pool',joined);
            if(!joined){badge?.remove();continue;}
            if(!badge){badge=create();badge.className='rom-candidate-badge';badge.textContent='✓ 已加入候选池';tile.appendChild(badge);}
        }
    }
    function mergeCandidatePool(pool,entries){
        const key=item=>String(item.path || item.id || '').replace(/\\/g,'/').replace(/\/+$/,'');
        const seen=new Set(pool.map(key));let added=0;
        for(const entry of entries){const id=key(entry);if(!id || seen.has(id))continue;seen.add(id);pool.push(JSON.parse(JSON.stringify(entry)));added++;}
        return added;
    }
    function setMediaChecked(selection, path, poolKey, checked) {
        const key=`${poolKey}\n${path}`;
        if(checked)selection.set(key,{path,poolKey});else selection.delete(key);
    }
    function createRefreshQueue(render, schedule, cancel) {
        let pending = null;
        function refresh() {
            if (pending !== null) return;
            pending = schedule(() => {pending=null;render();});
        }
        refresh.cancel = () => {if(pending!==null){cancel(pending);pending=null;}};
        refresh.flush = () => {refresh.cancel();render();};
        return refresh;
    }
    // Usage/selection changes must not tear down video thumbnails or their decoders.
    function updateMediaTiles(list, sections, selectedPath, selectedGroup, checkedMedia) {
        const layout = JSON.stringify(sections.map(({key, sectionKey, items}) => [sectionKey || key, items.map(item =>
            [item.path, item.src, item.unit?.preview, item.unit?.folder, item.unit?.files?.length])]));
        if (list._romLayout !== layout) return {layout, reused:false};
        const tiles = [...list.querySelectorAll('.rom-source-content .rom-item')];
        const byMaterial=new Map(tiles.map(tile=>[`${tile.dataset.group}\n${tile.dataset.path}`,tile]));
        if(sections.some(({key,items})=>items.some(({path})=>!byMaterial.has(`${key}\n${path}`))))return {layout,reused:false};
        for (const {key, items} of sections) for (const {path, rows, history} of items) {
            const tile = byMaterial.get(`${key}\n${path}`);
            const checked = checkedMedia.has(`${key}\n${path}`);
            tile.classList.toggle('unused', !rows.length);
            tile.classList.toggle('rom-used', rows.length>0 || (history?.count || 0)>0);
            tile.classList.toggle('selected', path === selectedPath && key === selectedGroup);
            tile.classList.toggle('checked', checked);
            tile.querySelector('.rom-check').checked = checked;
            const title = `${path}${rows.length ? '\n任务：' + rows.join('、') : ''}`;
            if (tile.title !== title) tile.title = title;
            const label = `${rows.length} 次${rows.length ? ' · 已使用 · 任务 ' + rows.join('、') : ' · 未使用'}`;
            const usage = tile.querySelector('.rom-usage');
            if (usage.textContent !== label) usage.textContent = label;
            if (history) {
                const badge=tile.querySelector('.rom-history');badge.hidden=!history.known;badge.textContent=history.label;badge.title=history.title;
                badge.classList.toggle('rom-history-used',history.count>0);
            }
        }
        return {layout, reused:true};
    }
    function routeDrop(data, hit) {
        // 来源分类不限制目标；poolKey 保留原始文件夹绑定。
        return hit ? {...data,group:hit,selected:hit.key===data.group?.key ? data.selected : ''} : data;
    }
    function quickReplacement(data, choices) {
        if (!data?.group || data.ambiguous) return {confirm:true};
        if (!choices?.length) return {confirm:false};
        const bundle = choices.length === 1 ? choices[0] : choices.find(choice => choice.signature === data.selected);
        return {confirm:!bundle, bundle};
    }
    function attachLayerHighlight(card, create = tag => document.createElement(tag)) {
        const highlight=create('div');highlight.className='rom-layer-highlight';highlight.hidden=true;
        highlight.style.cssText='position:absolute;box-sizing:border-box;border:4px solid #91dcab;background:#91dcab22;pointer-events:none;z-index:101;';
        // stage.replaceChildren(frame) 会替换预览内容，高亮必须挂在稳定的卡片上。
        card.el.style.position ||= 'relative';card.el.appendChild(highlight);
        return highlight;
    }
    function mediaHit(groups, overlays, rendered, x, y, time, width=1080, height=1920) {
        const items = rendered?.length ? rendered : overlays.map(ov => {
            let bounds={x:Number(ov.x)||0,y:Number(ov.y)||0,w:Number(ov.w)||0,h:Number(ov.h)||0},polygon;
            if(['top_half','bottom_half'].includes(ov.media_window_mode)) {
                const half=window.ReelsMediaWindow?.halfScreen(ov.media_window_mode,ov.media_split_angle,width,height);
                bounds=half?.rect || {x:0,y:ov.media_window_mode==='top_half'?0:height/2,w:width,h:height/2};polygon=half?.polygon;
            }else {
                if(ov.media_window_mode)bounds={...bounds,...ov.media_window};
                const sx=Number(ov.scale_x ?? ov.scale)||1,sy=Number(ov.scale_y ?? ov.scale)||1;
                if(ov.media_window_mode){bounds.x+=(bounds.w-bounds.w*sx)/2;bounds.y+=(bounds.h-bounds.h*sy)/2;}
                bounds.w*=sx;bounds.h*=sy;
            }
            return {id:ov.id,bounds,polygon};
        });
        for (const item of [...items].reverse()) {
            const ov=overlays.find(overlay=>overlay && String(overlay.id)===String(item.id));
            if(!ov || !['image','video'].includes(ov.type) || ov.disabled)continue;
            if(time<(Number(ov.start)||0) || time>(ov.end==null?Infinity:Number(ov.end)))continue;
            if(item.hitTest && !item.hitTest(x,y))continue;
            if(item.polygon && window.ReelsMediaWindow && !window.ReelsMediaWindow.contains(item.polygon,x,y))continue;
            const bounds=item.bounds;
            if(!bounds || x<bounds.x || x>=bounds.x+bounds.w || y<bounds.y || y>=bounds.y+bounds.h)continue;
            const group=groups.find(group=>group.field==='pip' && [ov.slotKey,ov._templateOverlayId,ov.id].filter(Boolean).includes(group.mediaSlot));
            if(group)return {group,bounds};
        }
        return null;
    }
    function replacementValue(context, path, group, poolKey = group.key, bundle = null) {
        const unit = unitFor(context, path, poolKey);
        if (unit?.folder) {
            if (group.field === 'pip') return JSON.parse(JSON.stringify(unit.value));
            return {bgPath:unit.preview,videoPath:image(unit.preview)?'':unit.preview,bgMode:'multi',bgClipPool:[...unit.files],bgClipActivePool:[...unit.files],...(bundle?{_overviewTextBundle:bundle}:{})};
        }
        return group.field === 'bg'
            ? {bgPath:path,videoPath:image(path)?'':path,bgMode:'single',bgClipPool:[],bgClipActivePool:[],...(bundle?{_overviewTextBundle:bundle}:{})}
            : {content:path,type:image(path)?'image':'video',media_loop:true};
    }
    function rememberFolder(context, key, directory, files) {
        files = [...new Set(files.filter(valid))];
        if (!files.length) return;
        const units = context.saved._units || (context.saved._units = {});
        units[`${key}\n${directory}`] = {path:directory,folder:true,files,preview:files.find(available)||files[0],
            value:{content:files[0],type:image(files[0])?'image':'video',media_loop:true,media_folder_path:directory,media_folder_files:files,media_folder_interval:0}};
        context.saved[key] = [...new Set([...(context.saved[key] || []),directory])];
    }
    function rememberImports(saved, key, paths) {
        saved[key] = [...new Set([...(saved[key] || []), ...paths.filter(valid)])];
    }
    function libraryImportPaths(directory,paths,roots) {
        const clean=path=>String(path || '').replace(/\\/g,'/').replace(/\/+$/,'').normalize('NFC');
        const nested=roots.map(clean).filter(root=>root.startsWith(clean(directory)+'/'));
        return paths.filter(file=>!nested.some(root=>clean(file).startsWith(root+'/')));
    }
    function importDirectory(context, key, directory, paths, mode = 'suites') {
        const files = [...new Set(paths.filter(valid).filter(path=>!String(path).replace(/\\/g,'/').split('/').includes('本批已经使用')))];
        if (!files.length) return {mediaCount:0,unitCount:0,firstPath:null};
        if (mode === 'suites' || mode === 'categories') {
            const prefix = directory.replace(/\\/g, '/').replace(/\/+$/, '') + '/';
            const separator = directory.includes('\\') && !directory.includes('/') ? '\\' : '/';
            const base = directory.replace(/[\\/]+$/, '');
            const suites = new Map(), loose = [];
            for (const file of files) {
                const normalized = file.replace(/\\/g, '/');
                if (!normalized.startsWith(prefix)) continue;
                const relative = normalized.slice(prefix.length);
                const parts = relative.split('/');
                // Library: root / category / suite / media (deeper members stay in the suite).
                // Loose files remain individual files; a category must never become a suite.
                if (mode === 'categories' && parts.length < 3) { loose.push(file); continue; }
                const depth = mode === 'categories' ? 2 : 1;
                const suite = relative.includes('/') ? base + separator + parts.slice(0,depth).join(separator) : directory;
                if (!suites.has(suite)) suites.set(suite, []);
                suites.get(suite).push(file);
            }
            for (const [suite, members] of suites) rememberFolder(context, key, suite, members);
            rememberImports(context.saved,key,loose);
            return {mediaCount:[...suites.values()].reduce((count, members) => count + members.length, loose.length),
                unitCount:suites.size+loose.length,firstPath:suites.keys().next().value || loose[0] || null};
        }
        if (mode === 'files') rememberImports(context.saved, key, files);
        else rememberFolder(context, key, directory, files);
        return {mediaCount:files.length,unitCount:mode === 'files' ? files.length : 1,
            firstPath:mode === 'files' ? files[0] : directory};
    }
    // Refresh the source inventory without rewriting media already assigned to tasks.
    function syncDirectoryImport(context, source, paths) {
        const staged = {saved:{}};
        const result = importDirectory(staged, source.key, source.directory, paths, source.mode);
        const next = staged.saved[source.key] || [];
        const removed = new Set((source.paths || []).filter(path => !next.includes(path)));
        context.saved[source.key] = (context.saved[source.key] || []).filter(path => !removed.has(path));
        for (const path of removed) delete context.saved._units?.[`${source.key}\n${path}`];
        // Directory units have no media extension, so copy their paths explicitly.
        context.saved[source.key] = [...new Set([...context.saved[source.key], ...next])];
        for (const unit of Object.values(staged.saved._units || {})) unit._directoryInventory = true;
        Object.assign(context.saved._units ||= {}, staged.saved._units || {});
        source.paths = next;
        return result;
    }
    function libraryCategory(root, file) {
        if(Array.isArray(root)){for(const directory of [...root].sort((a,b)=>b.length-a.length)){const category=libraryCategory(directory,file);if(category!==null)return root.length>1?`${basename(directory)} / ${category || '根目录'}`:category;}return null;}
        if (!root) return null;
        const prefix = root.replace(/\\/g,'/').replace(/\/+$/,'')+'/';
        const normalized = String(file).replace(/\\/g,'/');
        if (!normalized.startsWith(prefix)) return null;
        const parts=normalized.slice(prefix.length).split('/');
        return parts.length>1 ? parts[0] : '';
    }
    function categorizeSections(sections, root) {
        if (!root) return sections;
        const categories=new Map();
        for (const section of sections) {
            const buckets=new Map();
            for(const item of section.items){
                const category=libraryCategory(root,item.unit?.files?.[0] || item.path);
                if(!buckets.has(category))buckets.set(category,[]);
                buckets.get(category).push(item);
            }
            for(const [category,items] of buckets){
                if(!categories.has(category))categories.set(category,[]);
                categories.get(category).push({...section,category,sectionKey:JSON.stringify([section.key,category]),items});
            }
        }
        return [...categories.keys()].sort((a,b)=>a===null?-1:b===null?1:String(a).localeCompare(String(b),'zh',{numeric:true}))
            .flatMap(category=>categories.get(category));
    }
    const characterRoots=()=>window.ReelsCharacterLibrary?.roots || [];
    const isPersistentSource=source=>source==='library' || source==='characters';
    const librarySource=root=>window.ReelsCharacterLibrary?.hasPath(root)?'characters':'library';
    const fixedRoots=()=>window.ReelsMediaLibrary?.opened?.map(item=>item.root) || window.ReelsMediaLibrary?.active?.root;
    function materialSource(key,item,root,temporary=new Set()) {
        const manual=temporary.has(`${key}\n${item.path}`);
        return !manual && key!=='unclassified' ? 'batch'
            : !manual && window.ReelsCharacterLibrary?.hasPath(item.unit?.files?.[0] || item.path) ? 'characters'
            : !manual && libraryCategory(root,item.unit?.files?.[0] || item.path)!==null ? 'library' : 'temporary';
    }
    function sourceSections(sections, root, temporary = new Set()) {
        const sources=new Map(['batch','temporary','library','characters'].map(key=>[key,[]]));
        for(const section of sections){
            const buckets=new Map();
            for(const item of section.items){
                const source=materialSource(section.key,item,root,temporary);
                if(!buckets.has(source))buckets.set(source,[]);buckets.get(source).push(item);
            }
            for(const [source,items] of buckets)sources.get(source).push({...section,source,items});
        }
        return [...sources].flatMap(([source,members])=>(isPersistentSource(source)?categorizeSections(members,source==='characters'?characterRoots():root):members)
            .map(section=>({...section,source,sectionKey:JSON.stringify(['source',source,section.sectionKey || section.key])})));
    }
    function keywordSections(sections,match,order=[]){
        return sections.flatMap(section=>{
            if(!section.items.length)return [section];
            const buckets=new Map();
            for(const item of section.items){
                const text=item.unit?.folder?basename(item.path):basename(parent(item.path))+' '+basename(item.path);
                const keyword=(match(text) || []).find(Boolean) || '';
                if(!buckets.has(keyword))buckets.set(keyword,[]);
                buckets.get(keyword).push(item);
            }
            const rank=key=>{const index=order.indexOf(key);return !key?Infinity:index<0?order.length:index;};
            return [...buckets].sort(([a],[b])=>rank(a)-rank(b) || a.localeCompare(b,'zh',{numeric:true})).map(([keyword,items])=>({
                ...section,keyword,label:`${keyword || '未匹配关键词'} · ${section.label || '素材'}`,
                sectionKey:JSON.stringify([section.sectionKey || section.key,'keyword',keyword]),items,
            }));
        });
    }
    async function importDirectories(context,key,directories,mode,scan,stopped=()=>false,importOne=importDirectory) {
        const result={mediaCount:0,unitCount:0,firstPath:null,failures:[],empty:[]};
        for(const directory of [...new Set(directories)]) {
            if(stopped())break;
            try {
                const entries=await scan(directory);
                if(stopped())break;
                const paths=entries.map(entry=>typeof entry==='string'?entry:entry.path);
                const imported=importOne(context,key,directory,paths,mode);
                if(!imported.unitCount)result.empty.push(directory);
                result.mediaCount+=imported.mediaCount;result.unitCount+=imported.unitCount;
                result.firstPath ||= imported.firstPath;
            } catch(error) {result.failures.push({directory,error:error.message || String(error)});}
        }
        return result;
    }
    function collect(context, tasks) {
        // Check each shared file once per inventory refresh, including folder bindings.
        const availability = new Map();
        const check = path => {
            if (!availability.has(path)) availability.set(path, available(path));
            return availability.get(path);
        };
        const usage = new Map(), known = new Map(), current = new Map(), fileUsage = new Map();
        for (const group of context.groups) {
            const pool = [];
            current.set(group.key, pool);
            tasks.forEach((task, index) => {
                const value = context.readInventory ? context.readInventory(task, group, index) : context.read(task, group);
                for(const file of pathsOf(value,group)) {
                    if(!fileUsage.has(file))fileUsage.set(file,new Set());
                    fileUsage.get(file).add(index+1);
                }
                if (group.field === 'bg') context.rememberBackground?.(task, pathsOf(value, group));
                // Inactive background candidates remain available with zero uses.
                if (group.field === 'bg') for (const item of value?.bgClipPool || []) {
                    const path = typeof item === 'string' ? item : item?.path;
                    if (valid(path) && !pool.includes(path)) pool.push(path);
                }
                for (const unit of bindingOf(value, group, check)) {
                    const path = unit.path;
                    const units = context.saved._units || (context.saved._units = {});
                    // Task assignments are snapshots; a scanned candidate keeps the current folder contents.
                    if (!units[`${group.key}\n${path}`]?._directoryInventory) units[`${group.key}\n${path}`] = unit;
                    if (!pool.includes(path)) pool.push(path);
                    const key = `${group.key}\n${path}`;
                    if (!usage.has(key)) usage.set(key, []);
                    usage.get(key).push(index + 1);
                    if (!known.has(path)) known.set(path, new Set());
                    known.get(path).add(group.key);
                }
            });
        }
        let missingUnused = 0, removedUnused = 0;
        const keys = new Set([...current.keys(), ...Object.keys(context.saved).filter(key => Array.isArray(context.saved[key]))]);
        for (const key of keys) {
            const previous = context.saved[key] || [];
            // saved 只属于本次总览会话。替换下来的素材留到本次总览关闭；
            // 下次打开使用新的空清单，仅重新读取当前任务媒体。
            const retained = [...new Set([...(current.get(key) || []), ...previous.filter(path => {
                const unit = unitFor(context,path,key);
                return unit?.folder ? unit.files.some(check) : valid(path) && check(path);
            })])];
            for (const path of previous) if (!retained.includes(path)) {
                removedUnused++;
                if (!check(path)) missingUnused++;
            }
            context.saved[key] = retained;
            for (const path of retained) {
                if (!known.has(path)) known.set(path, new Set());
                known.get(path).add(key);
            }
        }
        const retainedPaths = new Set([...known.keys()]);
        for (const path of Object.keys(context.saved._backgroundTextPairs || {})) {
            if (!retainedPaths.has(path)) delete context.saved._backgroundTextPairs[path];
        }
        return {usage, known, fileUsage, missingUnused, removedUnused};
    }
    function usageRows(context, inventory, path, key) {
        const unit=unitFor(context,path,key);
        const rows=new Set();
        for(const file of unit?.files || [path])for(const row of inventory.fileUsage.get(file) || [])rows.add(row);
        return [...rows].sort((a,b)=>a-b);
    }
    function distributionPairs(context,inventory,selected,cards,group,policy={}) {
        const inScope=new Set(cards.map(card=>card.id+1));
        // 同一素材在不同分类中被勾选时只分配一次。
        const unique=[...new Map(selected.map(item=>[item.path,item])).values()];
        if(!unique.length)return [];
        const uses=new Map(unique.map(item=>[item.path,usageRows(context,inventory,item.path,item.poolKey).filter(row=>!inScope.has(row)).length]));
        return cards.flatMap(card=>{
            const candidates=unique.filter(item=>!policy.accept || policy.accept(item,card,group));
            if(!candidates.length)return [];
            const item=candidates.reduce((best,next)=>uses.get(next.path)<uses.get(best.path)?next:best);
            uses.set(item.path,uses.get(item.path)+1);policy.onPick?.(item,card,group);
            return [{card,group,...item}];
        });
    }
    function filterSelectedPaths(paths,selection,poolKey,onlySelected) {
        return onlySelected ? paths.filter(path=>selection.has(`${poolKey}\n${path}`)) : paths;
    }
    function filterUnusedPaths(paths, count, onlyUnused) {
        return onlyUnused ? paths.filter(path => count(path) === 0) : paths;
    }
    function selectedMaterialsInOrder(selection,orders) {
        const result=[],seen=new Set();
        for(const [poolKey,paths] of orders)for(const path of paths){
            const key=`${poolKey}\n${path}`;
            if(selection.has(key) && !seen.has(key)){result.push(selection.get(key));seen.add(key);}
        }
        for(const [key,item] of selection)if(!seen.has(key))result.push(item);
        return result;
    }
    function multiLayerDistributionPairs(selected,cards,groups,{mode='random',maxUses=0,random=Math.random,accept=()=>true,onPick=()=>{}}={}) {
        const materials=[...new Map(selected.map(item=>[item.path,item])).values()];
        if(mode==='same' && materials.length!==1)throw new Error('统一使用一个素材时只能选择一个素材');
        const layers=[...new Map(groups.filter(group=>group.field==='pip').map(group=>[group.key,group])).values()];
        if(!materials.length || !layers.length)return [];
        const limit=maxUses>0?Math.floor(maxUses):Infinity;
        const uses=new Map(materials.map(item=>[item.path,0]));
        const pairs=[];let cursor=0;
        for(const card of cards){
            const usedInTask=new Set();
            for(const group of layers){
                let available=materials.filter(item=>uses.get(item.path)<limit && accept(item,card,group));
                if(!available.length)continue;
                const fresh=available.filter(item=>!usedInTask.has(item.path));
                if(fresh.length)available=fresh;
                let item;
                if(mode==='sequential' || mode==='same'){
                    for(let k=0;k<materials.length;k++){
                        const index=(cursor+k)%materials.length;
                        if(available.includes(materials[index])){item=materials[index];cursor=(index+1)%materials.length;break;}
                    }
                }else item=available[Math.floor(random()*available.length)];
                pairs.push({card,group,...item});onPick(item,card,group);uses.set(item.path,uses.get(item.path)+1);usedInTask.add(item.path);
            }
        }
        return pairs;
    }
    function randomDistributionPairs(selected,cards,groups,random=Math.random) {
        return multiLayerDistributionPairs(selected,cards,groups,{random});
    }
    const externalFileDrag=event=>Array.from(event.dataTransfer?.types || []).includes('Files');
    function externalDropPaths(event,api=window.electronAPI){
        const captured=api?.consumeDroppedFilePaths?.() || [];
        const files=Array.from(event.dataTransfer?.files || []);
        return [...new Set(files.map((file,index)=>captured[index] || file.path || api?.getFilePath?.(file) || window.bridge?.getPathForFile?.(file)).filter(Boolean))];
    }
    async function prepareExternalDrop(paths,api=window.electronAPI){
        if(paths.length!==1)throw new Error('请每次拖入一个媒体文件或一个素材组文件夹，替换到当前媒体层');
        const path=paths[0];
        if(api?.isDirectory?.(path)){
            if(!api.scanDirectoryRecursive)throw new Error('当前版本无法读取素材文件夹');
            const entries=await api.scanDirectoryRecursive(path,{maxDepth:20});
            const files=[...new Set(entries.map(entry=>typeof entry==='string'?entry:entry.path).filter(valid))]
                .sort((a,b)=>a.localeCompare(b,'zh-CN',{numeric:true}));
            if(!files.length)throw new Error('文件夹中没有支持的视频或图片，原素材未更换');
            return {path,files,folder:true};
        }
        if(!valid(path))throw new Error('请拖入图片、视频或素材组文件夹');
        if(api?.fileExists && !api.fileExists(path))throw new Error('文件不存在或无法读取');
        return {path,files:[path],folder:false};
    }
    function mount(root, cards, hooks) {
        let pool = null, visible = false;
        const toggle = document.createElement('button');
        toggle.textContent = '打开媒体池';
        const panelHooks = {...hooks, showPool(){visible=true;pool?.setVisible(true);toggle.textContent='收起媒体池';}};
        root.querySelector('.rto-heading .rto-tool-scroll, .rto-toolbar').prepend(toggle);
        toggle.onclick = () => {
            if (!pool) {
                pool = mountPanel(root, cards, panelHooks);
                if (!pool) return;
                visible = true;
            } else {
                visible = !visible;
                pool.setVisible(visible);
            }
            toggle.textContent = visible ? '收起媒体池' : '打开媒体池';
        };
        // Native file drags should work even before the user opens the media pool.
        const externalEnter=event=>{
            if(!externalFileDrag(event))return;
            event.preventDefault();
            if(!pool){pool=mountPanel(root,cards,panelHooks);pool?.setVisible(false);}
            if(pool)root.classList.add('rom-dragging');
        };
        const externalEnd=event=>{if(event.type==='drop' || !root.contains(event.relatedTarget))root.classList.remove('rom-dragging');};
        const externalUnused=event=>{
            if(!externalFileDrag(event))return;
            event.preventDefault();event.stopPropagation();
            window.electronAPI?.consumeDroppedFilePaths?.();
            window.showToast?.('请拖到任务预览画面中的背景或媒体层','warning');
        };
        root.addEventListener('dragenter',externalEnter,true);
        root.addEventListener('dragover',externalEnter,true);
        root.addEventListener('dragleave',externalEnd);
        root.addEventListener('drop',externalEnd,true);
        root.addEventListener('drop',externalUnused);
        return {
            refresh() { if (visible) pool?.refresh(); },
            async refreshAllLinked(){
                if(!pool){pool=mountPanel(root,cards,panelHooks);pool?.setVisible(false);}
                return pool?.refreshAllLinked();
            },
            appendPhoneActions(...args){
                if(!pool){pool=mountPanel(root,cards,panelHooks);pool?.setVisible(false);}
                pool?.appendPhoneActions(...args);
            },
            appendReplacementActions(...args){
                if(!pool){pool=mountPanel(root,cards,panelHooks);pool?.setVisible(false);}
                pool?.appendReplacementActions(...args);
            },
            cancelReplacement(){pool?.cancelReplacement();},
            selectionChanged() {pool?.selectionChanged();},
            dispose() {root.removeEventListener('dragenter',externalEnter,true);root.removeEventListener('dragover',externalEnter,true);root.removeEventListener('dragleave',externalEnd);root.removeEventListener('drop',externalEnd,true);root.removeEventListener('drop',externalUnused);pool?.dispose(); toggle.remove(); }
        };
    }
    function mountPanel(root, cards, hooks) {
        const context = window.reelsOverviewMediaContext?.();
        if (!context) return;
        const tasks = cards.map(card => card.task);
        const candidatePool=context.candidatePool || (context.candidatePool=[]);
        const candidateRules=context.candidateRules || (context.candidateRules={});
        const archiveBatchState=context.archiveBatches || (context.archiveBatches={});
        const batchAllowed=item=>{
            const unit=item?.files?item:unitFor(context,item?.path,item?.poolKey);
            return window.ReelsUsedBatches?.enabled({...item,files:unit?.files || []},archiveBatchState) ?? !String(item?.path || '').replace(/\\/g,'/').includes('/本批已经使用');
        };
        const originNames={temporary:"临时素材",library:"固定素材",characters:"爆贴人物库",batch:"本批素材"};
        let cancelActivePlanning = null;
        let disposed = false, selectedPath = '', selectedGroup = '', drag = null, undo = [], inventory, thumbnailLoader, confirmation = null, backgroundLibrary = null, phoneLibrary = null, usedBatches = null;
        const checkedMedia = new Map(), temporaryImports = new Set(), temporaryDirectories = new Map();
        const checkedTasks = root._rtoSelectedTasks ||= new Set(window.reelsGetSelectedBatchTasks?.() || []);
        const posters = new Map(), aspects = new Map(), collapsed = new Set(), displayOrders = new Map();
        let clickMode = false, workspaceNavigation=null, syncScopeLayers=()=>{};
        const geometry = new Map();
        const panel = document.createElement('aside'); panel.className = 'rom-panel';
        const style = document.createElement('style');
        style.textContent = `.rom-panel{width:50%;max-width:none;flex-shrink:0;border-right:1px solid #444;background:#1e2029;display:flex;flex-direction:column;min-height:0;padding:10px;box-sizing:border-box;gap:8px}.rom-panel[hidden]{display:none}.rom-panel select,.rom-panel input{box-sizing:border-box;width:100%;background:#15171c;color:#eee;border:1px solid #555;border-radius:4px;padding:6px}.rom-tools{display:flex;gap:5px;flex-wrap:wrap}.rom-list{overflow:auto;flex:1;min-height:0}.rom-item{display:flex;align-items:center;gap:8px;padding:7px;border:1px solid #424654;border-radius:5px;margin-bottom:5px;cursor:grab;background:#292c37}.rom-item.checked{box-shadow:inset 0 0 0 2px #9b91ff;background:#37314e}.rom-item.selected{border-color:#9b91ff;background:#37314e}.rom-item img,.rom-item video{width:46px;height:46px;object-fit:cover;pointer-events:none}.rom-item span{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.rom-item small{display:block;color:#bcb8d6;margin-top:4px}.rom-item.unused small{color:#91dcab}.rom-hint{color:#c2bdd8;font-size:11px;line-height:1.5}.rom-drop-shield{display:none;position:absolute;inset:0;z-index:100;background:#8f88ff18;align-items:center;justify-content:center;pointer-events:auto;color:#fff;text-shadow:0 1px 4px #000}.rom-dragging .rom-drop-shield{display:flex}.rom-drop{outline:3px solid #91dcab!important}.rom-preview{height:140px;background:#111;object-fit:contain;width:100%}.rom-preview[hidden]{display:none}`;
        root.appendChild(style);
        style.textContent += `.rom-drop,.rom-pending{outline:4px solid #91dcab!important;box-shadow:0 0 0 7px #91dcab40!important}.rom-drop .rom-drop-shield{background:#10281bd9;font-size:18px;font-weight:700;text-align:center;padding:12px;box-sizing:border-box;white-space:pre-line}.rom-confirm{background:#242631;color:#eee;border:1px solid #777;border-radius:12px;width:min(520px,85vw);max-height:85vh;overflow:auto;padding:22px;box-shadow:0 18px 60px #0009}.rom-confirm::backdrop{background:#0009}.rom-confirm h3{margin:0 0 16px}.rom-confirm p{overflow-wrap:anywhere;line-height:1.5}.rom-confirm select{width:100%;background:#15171c;color:#eee;padding:8px;border:1px solid #777;border-radius:4px}.rom-confirm-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:20px}.rom-confirm button{padding:9px 18px;cursor:pointer;background:#383b4b;color:#eee;border:1px solid #777;border-radius:6px}.rom-confirm .rom-confirm-ok{background:#6555b7}.rom-confirm button:disabled{opacity:.4;cursor:default}.rom-confirm-words{white-space:pre-wrap;max-height:180px;overflow:auto;padding:12px;background:#171920;border-radius:6px}`;
        style.textContent += `.rom-confirm{position:fixed;inset:auto;margin:0;width:min(340px,calc(100vw - 24px));max-height:calc(100vh - 24px);padding:14px;box-sizing:border-box;border-color:#91dcab}.rom-confirm::backdrop{background:#0003}.rom-confirm h3{font-size:14px;margin:0 0 12px}.rom-confirm-details{margin:10px 0 0}.rom-confirm-details summary{cursor:pointer;color:#c2bdd8;font-size:12px}.rom-confirm-details[open] summary{margin-bottom:12px}.rom-confirm p{font-size:12px;margin:10px 0}.rom-confirm-actions{margin-top:12px}.rom-confirm-required{color:#f4d59e}.rom-confirm-required[hidden]{display:none}`;
        style.textContent += `.rom-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(var(--rom-size,110px),100%),1fr));gap:8px;align-items:start}.rom-item{display:flex;flex-direction:column;gap:4px;margin:0;padding:4px;min-width:0}.rom-item img,.rom-item video{width:100%;height:auto;object-fit:contain;background:#111}.rom-item span{width:100%;font-size:11px;overflow:visible;white-space:normal;overflow-wrap:anywhere}.rom-name,.rom-folder-name{white-space:normal;overflow-wrap:anywhere;line-height:1.45}.rom-name{display:none}.rom-folder-name{display:block}.rom-panel.rom-show-names .rom-name{display:block}.rom-item small{margin:0;font-size:11px;white-space:normal}.rom-section{margin-bottom:12px}.rom-section summary{cursor:pointer;padding:8px 0;color:#d5d0ee}.rom-display{display:flex;align-items:center;gap:8px;font-size:12px}.rom-display input[type=range]{flex:1;width:80px}.rom-display input[type=checkbox]{width:auto}`;
        style.textContent += `.rom-combination-preview>h3,.rom-combination-preview>p,.rom-combination-preview>.rom-confirm-actions,.rom-plan-toolbar{flex-shrink:0}.rom-plan-toolbar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:0 0 12px;font-size:12px}.rom-plan-toolbar label{display:flex;align-items:center;gap:5px}.rom-plan-toolbar select{width:auto}.rom-plan-grid{display:grid;grid-auto-rows:max-content;grid-template-columns:repeat(var(--pair-columns,4),minmax(0,1fr));gap:14px;align-items:start;align-content:start;overflow:visible;flex:none;min-height:0;padding:2px 8px 2px 2px}.rom-plan-card{display:flex;flex-direction:column;align-self:start;min-width:0;flex-shrink:0;border:2px solid #373a47;border-radius:9px;background:#22252d;padding:10px;overflow:hidden;font-size:12px}.rom-plan-card header{display:grid;gap:6px;margin-bottom:10px}.rom-plan-task-name,.rom-plan-material-name,.rom-plan-file-nav [data-file-position]{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere;line-height:1.45}.rom-plan-task-name{color:#bcb8d6;font-size:11px;min-height:2.9em}.rom-plan-pairs{display:grid;grid-template-columns:repeat(var(--pair-slots,2),minmax(0,1fr));gap:8px}.rom-plan-tile{min-width:0;overflow-wrap:anywhere}.rom-plan-tile>strong{display:block;white-space:nowrap;text-overflow:ellipsis;overflow:hidden;font-size:11px}.rom-plan-tile [data-pair-media]{position:relative;box-sizing:content-box;width:100%;height:0;min-height:0;padding-top:177.777778%;margin:6px 0;background:#111;color:#ffb09f;overflow:hidden;border-radius:6px;font-size:11px}.rom-plan-file-nav{display:flex;align-items:center;gap:4px}.rom-plan-file-nav button{padding:4px 7px}.rom-plan-card small{font-size:10px;color:#bcb8d6}.rom-plan-file-nav [data-file-position]{flex:1;min-width:0}.rom-plan-card .rom-plan-material-name{font-size:10px;margin:6px 0}.rom-plan-hide-names .rom-plan-material-name{display:none}.rom-plan-hide-names .rom-plan-file-nav [data-file-position]{white-space:nowrap;text-overflow:ellipsis;display:block}`;
        style.textContent += `.rom-plan-rows .rom-plan-grid{grid-template-columns:repeat(var(--pair-columns,1),minmax(0,1fr))}.rom-plan-rows .rom-plan-card{display:grid;grid-template-columns:minmax(180px,230px) minmax(0,1fr);gap:18px}.rom-plan-rows .rom-plan-card header{align-content:start;margin-bottom:0}.rom-plan-rows .rom-plan-pairs{display:grid;grid-template-columns:repeat(var(--pair-slots,1),minmax(0,1fr));align-items:start;gap:8px;min-width:0}.rom-plan-rows .rom-plan-tile{min-width:0}@media(max-width:800px){.rom-plan-rows .rom-plan-card{grid-template-columns:minmax(0,1fr)}}`;
        style.textContent += '.rom-plan-rows.rom-plan-multi .rom-plan-card{grid-template-columns:minmax(0,1fr);gap:10px}.rom-plan-rows.rom-plan-multi .rom-plan-pairs{display:grid;grid-template-columns:repeat(var(--pair-slots,2),minmax(0,1fr));gap:8px;overflow:visible}.rom-plan-rows.rom-plan-multi .rom-plan-tile{min-width:0}';
        style.textContent += '.rom-plan-tile[hidden]{display:none!important}.rom-plan-hide-names [data-plan-origin]{display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;overflow:hidden}.rom-plan-pairs>.rom-plan-tile{min-width:0}.rom-plan-file-nav>button{flex-shrink:1;min-width:0}';
        panel.innerHTML = `<strong>媒体分配 · 当前批次</strong><select class="rom-group" aria-label="媒体分类"><option value="all">全部媒体列</option>${context.groups.map(group => `<option value="${escape(group.key)}">${escape(group.label)}</option>`).join('')}<option value="unclassified">待分类素材</option></select><label class="rom-hint">读取文件夹方式<select class="rom-folder-mode" aria-label="读取文件夹方式"><option value="suites">按素材套读取（每个子文件夹一套）</option><option value="categories">总文件夹 → 分类 → 素材组 → 媒体</option><option value="folder">整个所选文件夹作为一套</option><option value="files">按文件平铺（里面的文件分别显示）</option></select></label><div class="rom-tools"><button class="rom-import">导入文件</button><button class="rom-folder" title="可一次选择多个总文件夹">读取文件夹（可多选）</button><button class="rom-daily">刷新素材目录</button></div><input class="rom-search" placeholder="搜索文件名" aria-label="搜索媒体"><select class="rom-sort" aria-label="媒体排序"><option value="usage">使用少的优先</option><option value="name">按文件名</option><option value="unused">只看未使用</option></select><div class="rom-hint">素材可拖到任意图片或视频层替换；拖拽、点选替换后按用后移动设置归档（背景库、电话库保留原位），撤销时移回。也可勾选素材、目标层和任务后执行分配。次数表示当前批次使用该媒体的任务数。</div><video crossorigin="anonymous" class="rom-preview" controls muted preload="none" hidden></video><div class="rom-display"><label>缩略图大小</label><input class="rom-size" type="range" min="70" max="240" value="110" step="10" aria-label="缩略图大小"><output class="rom-size-value">110px</output></div><label class="rom-display"><input class="rom-names" type="checkbox">显示文件名</label><div class="rom-list"></div><div class="rom-tools"><button class="rom-undo" disabled>撤销分配</button></div><div class="rom-tools"><button class="rom-select-all">全选当前显示</button><button class="rom-select-clear">取消全选</button><button class="rom-select-invert">反选当前显示</button><output class="rom-selection-count">已勾选 0 个素材</output></div><label class="rom-scope-label">任务范围<select class="rom-scope" aria-label="分配任务范围"><option value="selected">选定任务（0）</option><option value="current">当前任务</option><option value="group">当前任务组</option><option value="all">本批全部任务</option></select></label><output class="rom-status" aria-live="polite"></output>`;
        const libraryTools=document.createElement('details');libraryTools.className='rom-settings rom-library-tools';
        libraryTools.innerHTML='<summary>固定素材库 · 未绑定</summary><div class="rom-settings-body"><select class="rom-library-select" aria-label="切换固定素材库"><option value="">请选择素材库</option></select><label>素材库目录结构<select class="rom-library-layout" aria-label="素材库目录结构"><option value="categories">总库 → 分类 → 素材组 → 媒体（默认）</option><option value="suites">总库 → 素材组 → 媒体</option><option value="files">按单个文件平铺</option></select></label><div class="rom-tools"><button class="rom-library-bind">添加固定总文件夹（可多选）</button><button class="rom-library-refresh">刷新与同步记录</button><button class="rom-library-unbind">解除绑定</button></div><output class="rom-library-info"></output><div class="rom-tools"><button class="rom-library-mark">将已勾选素材标记已用</button><button class="rom-library-clear">清除已勾选素材的历史标记</button></div><small>执行分配、拖拽替换或确认采用后记为已用；试看、重新随机不记。撤销操作会取消对应记录，素材套按整套记录。记录保存在素材库里的 .videokit-library.json。</small></div>';
        const rulesEditor=document.createElement('details');rulesEditor.className='rom-settings rom-binding-rules';
        rulesEditor.innerHTML='<summary>名字固定组合（共用）· 未启用</summary><div class="rom-settings-body"><label><input class="rom-binding-enabled" type="checkbox" style="width:auto">启用名字固定组合</label><label>自定义关键词（每行一个）<textarea class="rom-binding-keywords" rows="4" aria-label="名字固定组合关键词" placeholder="输入你自己的固定字符，每行一个" style="box-sizing:border-box;width:100%;background:#15171c;color:#eee;border:1px solid #555;padding:6px"></textarea></label><small>共用于本批素材、临时文件夹、固定素材库、爆贴人物库和电话库；点选、拖拽、互换、随机配对都遵守此规则。匹配素材组文件夹名，电话媒体匹配文件名。一个关键词只能配该名字；多个关键词可配其中任意名字，但一整套媒体必须有共同关键词。未命中关键词的素材不参与固定组合；背景库来源不受关键词限制。修改后自动保存并生效。</small><button class="rom-binding-save">保存共用名字规则</button><output class="rom-binding-preview" style="font-size:11px;white-space:pre-wrap"></output></div>';

        const historyFilter=document.createElement('select');historyFilter.className='rom-history-filter';historyFilter.setAttribute('aria-label','历史使用筛选');historyFilter.disabled=true;
        historyFilter.innerHTML='<option value="all">全部历史状态</option><option value="unused">历史未用</option><option value="used">历史已用</option><option value="month">近 30 天未用</option>';
        const bindingCaps=document.createElement('fieldset');bindingCaps.className='rom-binding-caps';
        bindingCaps.innerHTML='<legend>本批次每个关键词最多配多少套</legend><div data-binding-cap-inputs></div><small>0 表示不限，修改后自动保存。已有预览可在配对限制中调整后补齐，或全部重新随机。只限制本轮随机配对套数。</small>';
        rulesEditor.querySelector('.rom-binding-save').before(bindingCaps);
        const bindingKeywordList=()=>[...new Set(rulesEditor.querySelector('.rom-binding-keywords').value.split(/[\n,，;；]+/).map(value=>value.trim()).filter(Boolean))];
        function renderBindingCaps(){
            const pending=new Map([...bindingCaps.querySelectorAll('input')].map(input=>[input.dataset.keyword,input.value]));
            bindingCaps.querySelector('[data-binding-cap-inputs]').innerHTML=bindingKeywordList().map(key=>`<label style="display:inline-flex;gap:8px;align-items:center;margin:6px">${escape(key)} <input data-keyword="${escape(key)}" type="number" min="0" step="1" value="${escape(pending.get(key) ?? String(candidateRules.keywordLimits?.[key] ?? 0))}" style="width:80px"> 套</label>`).join('') || '<small>填写关键词后，可分别设置上限。</small>';
        }
        rulesEditor.querySelector('.rom-binding-keywords').addEventListener('input',renderBindingCaps);
        const categoryFilter=document.createElement('select');categoryFilter.className='rom-library-category';categoryFilter.setAttribute('aria-label','素材库分类');categoryFilter.hidden=true;
        categoryFilter.innerHTML='<option value="all">全部素材分类</option>';
        panel.querySelector('.rom-search').before(libraryTools,categoryFilter,historyFilter);
        const characterTools=libraryTools.cloneNode(true);
        characterTools.className='rom-settings rom-characters-tools';
        characterTools.innerHTML=characterTools.innerHTML.replaceAll('rom-library-','rom-characters-').replaceAll('固定素材库','爆贴人物库').replace('添加固定总文件夹','添加爆贴人物总文件夹');
        const characterCategory=categoryFilter.cloneNode(true),characterHistory=historyFilter.cloneNode(true);
        characterCategory.className='rom-characters-category';characterCategory.setAttribute('aria-label','爆贴人物素材分类');
        characterHistory.className='rom-characters-history';characterHistory.setAttribute('aria-label','爆贴人物历史筛选');
        characterTools.querySelector('.rom-characters-layout').value='suites';
        const persistentTools=source=>source==='characters'?characterTools:libraryTools;
        const persistentControl=(source,name)=>persistentTools(source).querySelector(`.rom-${source==='characters'?'characters':'library'}-${name}`);
        const persistentCategory=source=>source==='characters'?characterCategory:categoryFilter;
        const persistentHistory=source=>source==='characters'?characterHistory:historyFilter;

        panel.querySelector('.rom-sort').insertAdjacentHTML('beforeend','<option value="history-count">历史使用少的优先</option><option value="history-time">历史最久未用优先</option>');
        panel.querySelector('.rom-only-unused')?.setAttribute('title','仅统计本批次的分配情况');
        style.textContent += '.rom-source-section[data-source=characters]>summary{color:#ffbd69}.rom-source-section[data-source=temporary]>summary{color:#75dcff}';
        style.textContent += '.rom-item.rom-in-candidate-pool{position:relative}.rom-item>.rom-candidate-badge{position:absolute;top:8px;left:8px;z-index:2;padding:4px 7px;border:1px solid #91dcab;border-radius:5px;background:#173b2aeb;color:#d5ffe0!important;font-size:11px;font-weight:600;line-height:1.4;pointer-events:none;box-shadow:0 2px 6px #0005}';
        style.textContent += '.rom-library-category[hidden],.rom-characters-category[hidden],.rom-history[hidden]{display:none!important}.rom-history{color:#91dcab!important;margin-top:4px!important}.rom-history-used{color:#dfbb8f!important}.rom-item.rom-used>span,.rom-item.rom-used>span b,.rom-item.rom-used>span small{color:#f3ba82!important}.rom-category-section{margin:8px 0 14px;border:1px solid #4d5262;border-radius:6px;padding:0 8px}.rom-category-section>summary{cursor:pointer;font-weight:700;color:#d5d0ee;padding:10px 0}.rom-category-section>.rom-section{padding-left:4px}.rom-library-info,.rom-characters-info{font-size:11px;white-space:pre-wrap;overflow-wrap:anywhere}.rom-library-tools small,.rom-characters-tools small{font-size:11px;color:#c2bdd8;line-height:1.5}';
        const swapMode = document.createElement('button'); swapMode.className='rom-swap-mode';
        swapMode.textContent='点选替换：关';swapMode.setAttribute('aria-pressed','false');
        panel.querySelector('.rom-search').before(swapMode);
        style.textContent += `.rom-click-swapping .rom-drop-shield{display:flex;background:transparent;color:transparent;cursor:crosshair}.rom-click-swapping .rom-drop .rom-drop-shield{color:white;background:#10281b77;font-size:13px}.rom-swap-mode[aria-pressed=true]{background:#6555b7;color:white}.rom-swap-feedback{position:absolute;left:8px;right:8px;bottom:48px;z-index:110;background:#173628ed;color:#d5ffe0;padding:8px;border:1px solid #91dcab;border-radius:6px;font-size:12px;display:flex;align-items:center;justify-content:space-between;gap:6px}.rom-swap-feedback button{cursor:pointer;color:white;background:#334f3d;border:1px solid #91dcab;border-radius:4px;padding:4px 8px}`;
        // 常用操作集中排列；移动原节点，保留唯一的计数和事件入口。
        const actionBar=document.createElement('div');actionBar.className='rom-action-bar';
        actionBar.setAttribute('role','region');actionBar.setAttribute('aria-label','素材选择与替换');
        actionBar.append(panel.querySelector('strong'),panel.querySelector('.rom-undo').parentElement,panel.querySelector('.rom-select-all').parentElement);
        actionBar.querySelector('.rom-selection-count').setAttribute('aria-live','polite');
        panel.prepend(actionBar);
        style.textContent += '.rom-action-bar{position:static;flex-shrink:0;display:flex;flex-direction:column;gap:8px;background:#1e2029;padding:8px;border:1px solid #555064;border-radius:7px;box-shadow:0 4px 12px #0005}.rom-action-bar .rom-tools{align-items:center}.rom-action-bar .rom-selection-count{font-size:12px;font-weight:600;color:#e5dfff}';
        // 收起低频设置，把默认可见高度留给文件浏览与滚动。
        const selectedFilter=document.createElement('label');selectedFilter.className='rom-display';
        selectedFilter.innerHTML='<input type="checkbox" class="rom-only-selected">仅显示已选素材';
        panel.querySelector('.rom-search').after(selectedFilter);
        const keywordGrouping=document.createElement('label');keywordGrouping.className='rom-display';
        keywordGrouping.innerHTML='<input type="checkbox" class="rom-keyword-grouping" checked>按关键词分组显示';
        try{keywordGrouping.querySelector('input').checked=localStorage.getItem('reels_media_keyword_grouping_v1')!=='false';}catch(_){}
        selectedFilter.after(keywordGrouping);
        const unusedFilter=document.createElement('label');unusedFilter.className='rom-display';
        unusedFilter.innerHTML='<input type="checkbox" class="rom-only-unused">本批次未使用';
        selectedFilter.after(unusedFilter);
        const folderLabel=panel.querySelector('.rom-folder-mode').parentElement;
        const sort=panel.querySelector('.rom-sort');
        const hint=sort.nextElementSibling;
        const size=panel.querySelector('.rom-size').parentElement;
        const names=panel.querySelector('.rom-names').parentElement;
        const randomLayers=document.createElement('fieldset');randomLayers.className='rom-random-layers';
        randomLayers.style.cssText='margin:0;padding:0;border:0;min-width:0;display:flex;flex-direction:column;gap:8px;';
        randomLayers.innerHTML='<legend>分配目标（可多选）</legend>'
            +context.groups.filter(group=>group.field==='pip').map(group=>`<label style="display:block;padding:4px 0"><input type="checkbox" class="rom-random-layer" style="width:auto" value="${escape(group.key)}"> ${escape(group.label)}</label>`).join('');
        const distributionMode=document.createElement('label');distributionMode.textContent='分配模式';
        distributionMode.innerHTML+='<select class="rom-multi-mode" aria-label="分配模式"><option value="sequential">顺序</option><option value="random">随机</option><option value="same">统一使用一个素材</option></select>';
        const repeatLimit=document.createElement('label');repeatLimit.innerHTML='每个素材／套本次最多使用<input type="number" class="rom-max-uses" min="0" step="1" value="1" aria-label="每个素材本次最多使用次数">次（0 表示不限；每填入一个目标层计 1 次）';
        const execute=document.createElement('button');execute.className='rom-random-distribute';execute.textContent='执行分配';
        style.textContent += '.rom-panel{overflow-y:auto}.rom-panel>:not(.rom-list){flex-shrink:0}.rom-list{flex:1 1 0;min-height:min(540px,67.5vh);overscroll-behavior:contain}.rom-settings{flex-shrink:0}.rom-settings summary{cursor:pointer;color:#d5d0ee;font-size:12px;padding:4px 0}.rom-settings-body{display:flex;flex-direction:column;gap:8px;max-height:none;overflow:visible;padding:8px 0}.rom-preview{display:none!important}.rom-task-pane{display:flex;flex:1;flex-direction:column;min-width:0;min-height:0}.rom-task-tools{display:flex;flex-shrink:0;gap:8px;align-items:center;flex-wrap:wrap;padding:8px 16px;border-bottom:1px solid #444;background:#1e2029}.rom-task-tools[hidden]{display:none}';
        style.textContent += `.rom-layer-highlight[hidden]{display:none!important}.rom-check-label{font-size:11px}.rom-panel .rom-check{width:auto}.rom-panel{max-width:none}.rom-resize{width:7px;flex-shrink:0;cursor:col-resize;touch-action:none;background:#292c37;outline-offset:-2px}.rom-resize:hover,.rom-resize:focus-visible,.rom-resizing .rom-resize{background:#9b91ff}.rom-resize[hidden]{display:none}.rom-resizing,.rom-resizing *{cursor:col-resize!important;user-select:none!important}.rom-resizing iframe{pointer-events:none}`;
        // 三个来源模块保留稳定外壳：刷新时仅更新素材区，不销毁设置或正在编辑的输入。
        const materialList=panel.querySelector('.rom-list');
        const materialFolds=document.createElement('div');materialFolds.className='rom-tools rom-material-folds';
        materialFolds.setAttribute('role','group');materialFolds.setAttribute('aria-label','素材文件夹展开与折叠');
        materialFolds.innerHTML='<button data-fold-open>全部展开</button><button data-fold-close>全部折叠</button>';
        materialList.before(materialFolds);
        const foldMaterials=open=>{
            materialList.querySelectorAll('details[data-section]').forEach(section=>{
                const key=section.dataset.section;
                if(open)collapsed.delete(key);else collapsed.add(key);
                section.open=open;
            });
            const background=materialList.querySelector('.rom-background-library');if(background)background.open=open;
            thumbnailLoader?.dispose();
            if(!panel.hidden)thumbnailLoader=window.BatchThumbnailLoader?.hydrate(panel);
        };
        materialFolds.querySelector('[data-fold-open]').onclick=()=>foldMaterials(true);
        materialFolds.querySelector('[data-fold-close]').onclick=()=>foldMaterials(false);
        const moduleTools={};
        for(const [source,label] of [['batch','本批视频素材'],['temporary','临时加载素材'],['library','固定素材库'],['characters','爆贴人物库']]){
            const module=document.createElement('details');module.className='rom-source-section';module.open=true;
            module.dataset.section=JSON.stringify(['material-source',source]);module.dataset.source=source;
            module.innerHTML=`<summary data-source-summary="${source}">${label} · 0</summary><div class="rom-source-tools"></div><div class="rom-source-content"></div>`;
            materialList.appendChild(module);moduleTools[source]=module.querySelector('.rom-source-tools');
        }
        const poolSection=document.createElement('details');poolSection.className='rom-candidate-pool rom-settings';poolSection.open=true;
        poolSection.innerHTML='<summary data-candidate-summary>统一候选池 · 0</summary><div class="rom-tools"><button data-candidate-add>将已勾选素材加入候选池</button><button data-candidate-clear>清空候选池</button></div><small>从各来源勾选后加入。保留来源标签，同一素材只入池一次；不复制或移动原文件。加入候选池即参与本次配对，不受历史批次启用开关限制。电话由电话库自动配套。</small><div data-candidate-list class="rom-grid" style="max-height:520px;overflow:auto;margin:8px 0"></div><div data-candidate-tools></div>';
        materialList.prepend(poolSection);moduleTools.pool=poolSection.querySelector('[data-candidate-tools]');
        style.textContent+='.rom-candidate-item{display:flex;flex-direction:column;gap:4px;background:#292c37;border:1px solid #555;border-radius:6px;padding:6px;min-width:0;overflow-wrap:anywhere;font-size:11px}.rom-candidate-item img,.rom-candidate-item video{display:block;width:100%;height:auto;aspect-ratio:9/16;object-fit:contain;background:#111}.rom-candidate-item strong{display:block;color:#b6d5ff;margin:5px 0}.rom-candidate-item button{font-size:11px;margin-top:5px}';
        const persistCandidates=()=>{window.reelsScheduleUnifiedProjectSave?.();};
        function renderCandidates(){
            const counts=Object.keys(originNames).map(source=>`${originNames[source]} ${candidatePool.filter(item=>item.origin===source).length}`).join(' · ');
            poolSection.querySelector('[data-candidate-summary]').textContent=`统一候选池 · ${candidatePool.length}（${counts}）`;
            poolSection.querySelector('[data-candidate-list]').innerHTML=candidatePool.map((item,index)=>{
                const src=mediaSource(item.files?.[0]),archived=!!window.ReelsUsedBatches?.batchId(item);
                const thumb=!src?'文件已缺失':image(item.files[0])?`<img crossorigin="anonymous" src="${escape(src)}" loading="lazy" alt="${escape(item.name)}">`:`<video crossorigin="anonymous" class="rbt-thumb-previewable" data-path="${escape(item.path)}" data-thumb-size="320" data-thumb-src="${escape(src)}#t=0.1" preload="none" muted></video>`;
                return `<article class="rom-candidate-item">${thumb}<strong data-source-highlight="${escape(item.origin)}" style="${item.origin==='characters'?'color:#ffbd69;background:#573714;padding:3px 5px;border-radius:4px':item.origin==='temporary'?'color:#75dcff':''}">${item.origin==='characters'?'🔥 ':''}${escape(originNames[item.origin] || item.origin)}</strong><div title="${escape(item.path)}">${escape(item.name)}</div>${archived?`<small>历史批次 · ${escape(window.ReelsUsedBatches.batchId(item))} · 已加入候选池，参与随机</small>`:''}<button data-candidate-remove="${index}">移出候选池</button></article>`;
            }).join('') || '<p class="rom-hint">先在各来源勾选素材，再点击“加入候选池”。</p>';
            syncCandidateBadges(materialList,candidatePool);
            thumbnailLoader?.dispose();thumbnailLoader=window.BatchThumbnailLoader?.hydrate(panel);
        }
        function addCandidateTiles(tiles,onlyChecked=true){
            const entries=[];let skipped=0;
            for(const tile of tiles){
                const {path,group:poolKey}=tile.dataset;if(onlyChecked && !checkedMedia.has(`${poolKey}\n${path}`))continue;
                const origin=tile.dataset.origin || tile.closest('[data-source]')?.dataset.source;if(!originNames[origin])continue;
                const sourceGroup=groupFor(poolKey);if(sourceGroup && window.ReelsNameBinding.isPhoneGroup(sourceGroup)){skipped++;continue;}
                const unit=unitFor(context,path,poolKey),files=unit?.files?.length?unit.files:[path];
                if(!sourceFor(path,poolKey)){skipped++;continue;}
                entries.push({id:path,path,name:basename(path),origin,originalPoolKey:poolKey,poolKey:'unclassified',files,
                    archiveRoot:unit?.root || (isPersistentSource(origin)?(library?.opened || []).map(entry=>entry.root):[...temporaryDirectories.values()].map(entry=>entry.directory)).filter(root=>String(path).startsWith(root.replace(/[/\\]+$/,'')+'/')).sort((a,b)=>b.length-a.length)[0] || '',archiveBatchId:unit?.archiveBatchId || '',originalFiles:unit?.originalFiles || [],folder:!!unit?.folder,unit:unit?.folder?unit:null,values:Object.fromEntries(context.groups.map(slot=>[slot.key,replacementValue(context,path,slot,poolKey)]))});
            }
            const added=mergeCandidatePool(candidatePool,entries);persistCandidates();renderCandidates();poolSection.open=true;workspaceNavigation?.select('pool');
            status(`已加入 ${added} 个素材，候选池共 ${candidatePool.length} 个；相同素材不会重复入池${skipped?'；电话层或不可用素材已跳过':''}`);
        }
        poolSection.querySelector('[data-candidate-add]').onclick=()=>addCandidateTiles(materialList.querySelectorAll('.rom-source-section .rom-item,.rom-used-batches .rom-item'));
        poolSection.querySelector('[data-candidate-clear]').onclick=()=>{candidatePool.splice(0);persistCandidates();renderCandidates();status('已清空候选池，原素材与任务保留');};
        poolSection.querySelector('[data-candidate-list]').onclick=event=>{const button=event.target.closest('[data-candidate-remove]');if(!button)return;candidatePool.splice(Number(button.dataset.candidateRemove),1);persistCandidates();renderCandidates();};
        renderCandidates();
        const importTools=panel.querySelector('.rom-import').parentElement;
        moduleTools.batch.append(panel.querySelector('.rom-daily'),unusedFilter);
        moduleTools.temporary.append(importTools,folderLabel);
        const temporaryRefresh=document.createElement('button');temporaryRefresh.className='rom-temporary-refresh';
        temporaryRefresh.textContent='刷新临时文件夹';moduleTools.temporary.appendChild(temporaryRefresh);
        moduleTools.library.append(libraryTools,categoryFilter,historyFilter);
        moduleTools.characters.append(characterTools,characterCategory,characterHistory);
        for(const source of ['temporary','library','characters','pool']){
            const pairing=document.createElement('details');pairing.className='rom-pairing-settings';pairing.dataset.pairing=source;
            pairing.innerHTML=`<summary>按关键词随机配对 · 先预览再采用</summary><div style="display:grid;gap:8px;padding:8px 0"><label>参与配对的目录<select data-pair-root><option value="all">本模块全部目录</option></select></label><small>替换下方“任务范围”内的现有任务，每个任务配一套素材。</small><label>每个素材组本轮最多使用<input data-pair-uses type="number" min="1" value="1">次</label><label>每张电话本轮最多使用<input data-pair-phone-uses type="number" min="0" value="0">次（0 不限，电话可跨组合复用）</label><label>每个素材组历史累计最多<input data-pair-total type="number" min="0" value="0">次（0 不限）</label><label><input data-pair-selected type="checkbox" style="width:auto">只用本模块已勾选的素材组</label><label><input data-pair-repeat type="checkbox" style="width:auto">允许本轮重复同一套组合</label><fieldset><legend>哪些普通媒体层按关键词配套（自定义勾选）</legend>${context.groups.filter(group=>!window.ReelsNameBinding.isPhoneGroup(group)).map((group,index)=>`<label style="display:block"><input type="checkbox" data-pair-slot value="${escape(group.key)}" style="width:auto" ${group.field==='pip' && index<=2?'checked':''}>${escape(group.label)}</label>`).join('')}</fieldset><small>只替换并校验勾选的层；未勾选的层不限制本次配对。背景、讲道及背景联动层不参与普通素材的关键词配套。电话使用电话库选定的层，自动加入组合。</small><small>电话库绑定的电话层会自动加入，与所选媒体组成同一套，按同一名字关键词配套。统一预览并确认后替换现有任务，保留文案、布局和名称。</small><button data-pair-preview>随机配对并预览</button><output data-pair-feedback role="status" aria-live="polite" style="color:#f4d59e;white-space:pre-wrap;overflow-wrap:anywhere"></output></div>`;
            const characterCap=document.createElement('label');
            characterCap.innerHTML=`爆贴素材每组本批最多使用 <input data-pair-character-uses type="number" min="0" step="1" value="${candidateRules.characterMaxUses ?? ''}" placeholder="跟随普通素材" style="width:90px"> 次（留空跟随普通素材，0 不限）`;
            pairing.querySelector('[data-pair-uses]').closest('label').after(characterCap);
            characterCap.onchange=()=>{const raw=characterCap.querySelector('input').value;candidateRules.characterMaxUses=raw===''?null:Number(raw);persistCandidates();};
            const savedSlots=candidateRules.keywordPairingSlots?.[source];
            if(Array.isArray(savedSlots))pairing.querySelectorAll('[data-pair-slot]').forEach(input=>input.checked=savedSlots.includes(input.value));
            pairing.addEventListener('change',event=>{
                if(!event.target.matches('[data-pair-slot]'))return;
                candidateRules.keywordPairingSlots ||= {};
                candidateRules.keywordPairingSlots[source]=[...pairing.querySelectorAll('[data-pair-slot]:checked')].map(input=>input.value);
                persistCandidates();
            });
            if(source==='pool'){
                pairing.open=true;pairing.querySelector('summary').textContent='候选池随机配对 · 新老搭配';
                const basis=document.createElement('label');basis.innerHTML=`配对依据<select data-pair-basis><option value="">完全随机</option>${Object.entries(originNames).map(([key,label])=>`<option value="${key}">以${label}为依据，每个用一次</option>`).join('')}</select><small>依据来源每套恰好一个、每个素材整轮只用一次；其他来源按关键词和电话配套。只替换现有任务，未配成的素材逐个列出原因。</small>`;pairing.querySelector('[data-pair-preview]').before(basis);basis.querySelector('select').value=candidateRules.basisSource || '';basis.onchange=()=>{candidateRules.basisSource=basis.querySelector('select').value;persistCandidates();};
                pairing.querySelector('[data-pair-root]').closest('label').hidden=true;pairing.querySelector('[data-pair-selected]').closest('label').hidden=true;
                const limits=document.createElement('fieldset');limits.innerHTML=`<legend>每套组合的来源数量（电话不计入）</legend>${Object.entries(originNames).map(([key,label])=>`<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap"><b>${label}</b><label>最少 <input data-source-min="${key}" type="number" min="0" value="0" style="width:55px"></label><label>最多 <input data-source-max="${key}" type="number" min="0" value="1" style="width:55px"></label></div>`).join('')}<small>在最少与最多之间随机抽取每套数量；例如最少 1、最多 2，会随机用 1 或 2 个。最多 0 表示不限；作为配对依据的来源仍固定每套 1 个。新老搭配示例：临时最少 1、最多 1；固定和本批各最多 1。其余规则仍遵守名字关键词和电话绑定。</small>`;
                pairing.querySelector('[data-pair-preview]').before(limits);pairing.querySelector('[data-pair-preview]').textContent='从候选池随机配对并预览';
                for(const key of Object.keys(originNames)){
                    limits.querySelector(`[data-source-min="${key}"]`).value=candidateRules[key]?.min ?? 0;
                    limits.querySelector(`[data-source-max="${key}"]`).value=candidateRules[key]?.max ?? 1;
                }
                renderSourceQuantityWeights(limits,'source',Object.fromEntries(Object.keys(originNames).map(key=>[key,candidateRules[key] || {min:0,max:1}])),context.groups.length);
                limits.onchange=event=>{
                    const next=readSourceQuantityRules(limits,'source',Object.keys(originNames));
                    try{window.ReelsCombinationPlanner.validateSourceLimits(next);Object.assign(candidateRules,next);if(event.target.matches('[data-source-min],[data-source-max]'))renderSourceQuantityWeights(limits,'source',next,context.groups.length);persistCandidates();status('候选池来源限制已保存；已调好的草稿组合保留，采用时会按新限制检查');}catch(error){status(error.message);}
                };
                // Keep the existing controls and handlers; only group their presentation.
                pairing.classList.add('rom-pairing-cards');
                const body=pairing.querySelector('summary').nextElementSibling;
                body.className='rom-pairing-card-grid';body.removeAttribute('style');
                const card=(title,wide=false)=>{
                    const section=document.createElement('section');section.className='rom-pair-card'+(wide?' rom-pair-card-wide':'');
                    const heading=document.createElement('h4');heading.textContent=title;section.appendChild(heading);return section;
                };
                const modeCard=card('配对方式',true),layersCard=card('参与的媒体层'),usesCard=card('本轮使用次数'),sourcesCard=card('每套的来源搭配',true);
                const layers=pairing.querySelector('[data-pair-slot]').closest('fieldset');
                layers.querySelector('legend').textContent='选择需要替换的层';
                const phoneNote=document.createElement('small');phoneNote.textContent='电话层自动加入，按同一名字关键词配套。';
                modeCard.appendChild(basis);layersCard.append(layers,phoneNote);
                const numberField=(selector,title,note)=>{
                    const input=pairing.querySelector(selector),label=input.closest('label'),caption=document.createElement('span'),help=document.createElement('small');
                    caption.textContent=title;help.textContent=note;label.classList.add('rom-pair-number');label.replaceChildren(caption,input,help);return label;
                };
                usesCard.append(numberField('[data-pair-uses]','普通素材','每个素材组本轮最多使用的次数'),numberField('[data-pair-character-uses]','爆贴素材','独立的每组本批使用上限；留空跟随普通素材，0 不限'),numberField('[data-pair-phone-uses]','电话素材','0 表示不限，可跨组合复用'));
                sourcesCard.appendChild(limits);
                const advanced=document.createElement('details');advanced.className='rom-pair-advanced rom-pair-card-wide';advanced.innerHTML='<summary>更多限制 · 历史次数与重复组合</summary>';
                advanced.append(numberField('[data-pair-total]','历史累计上限','0 表示不限'),pairing.querySelector('[data-pair-repeat]').closest('label'));
                const previewButton=pairing.querySelector('[data-pair-preview]'),feedback=pairing.querySelector('[data-pair-feedback]');
                const footer=document.createElement('div');footer.className='rom-pair-card-footer rom-pair-card-wide';
                const note=document.createElement('small');note.textContent='先预览和调整，确认后替换当前任务；保留文案、布局和名称。';footer.append(note,previewButton,feedback);
                // The hidden source-only controls are retained for the shared planner.
                const rootControl=pairing.querySelector('[data-pair-root]').closest('label'),selectedControl=pairing.querySelector('[data-pair-selected]').closest('label');
                body.replaceChildren(rootControl,selectedControl,modeCard,layersCard,usesCard,sourcesCard,advanced,footer);
            }
            const stopPairing=document.createElement('button');stopPairing.dataset.pairStop='';stopPairing.hidden=true;stopPairing.textContent='停止配对';pairing.querySelector('[data-pair-preview]').after(stopPairing);
            pairing.querySelector('[data-pair-preview]').onclick=()=>previewAction(pairing,()=>openCombinationPreview(source,pairing),{onError:text=>{if(!disposed)status(text);}});
            moduleTools[source].appendChild(pairing);
        }
        const temporaryHistory=document.createElement('select');temporaryHistory.className='rom-temporary-history';temporaryHistory.setAttribute('aria-label','临时素材历史筛选');
        temporaryHistory.innerHTML='<option value="all">全部历史状态</option><option value="unused">历史未用</option><option value="used">历史已用</option>';
        moduleTools.temporary.prepend(temporaryHistory);
        const generalSettings=document.createElement('section');generalSettings.className='rom-settings rom-general-settings';
        generalSettings.innerHTML='<div class="rom-settings-body"></div>';
        generalSettings.prepend(actionBar);
        const generalBody=generalSettings.querySelector('.rom-settings-body');
        const addCategory=(title,elements)=>{
            const section=document.createElement('div');section.className='rom-settings-category';
            const heading=document.createElement('h5');heading.textContent=title;section.appendChild(heading);
            section.append(...elements);generalBody.appendChild(section);
        };
        const mediaCategory=document.createElement('label');mediaCategory.textContent='显示素材分类';mediaCategory.appendChild(panel.querySelector('.rom-group'));
        const sortLabel=document.createElement('label');sortLabel.textContent='素材排序';sortLabel.appendChild(sort);
        const selectionTools=actionBar.querySelector('.rom-select-all').parentElement;
        const distributionActions=actionBar.querySelector('.rom-undo').parentElement;distributionActions.classList.add('rom-distribution-actions');
        distributionActions.prepend(execute);
        addCategory('1. 选择素材',[selectionTools,selectedFilter]);
        addCategory('2. 设置分配',[randomLayers,panel.querySelector('.rom-scope-label'),distributionMode,repeatLimit,distributionActions,panel.querySelector('.rom-status')]);
        addCategory('3. 共用名字绑定',[rulesEditor]);
        addCategory('快捷操作',[swapMode,hint]);
        addCategory('浏览与筛选',[panel.querySelector('.rom-search'),mediaCategory,sortLabel,size,names]);
        // One outer settings module; every control scrolls together with the panel.
        panel.prepend(generalSettings);
        style.textContent += '.rom-source-tools{display:flex;flex-direction:column;gap:8px;padding:8px 0;border-bottom:1px solid #393c49;margin-bottom:8px}.rom-source-content{padding-top:4px}.rom-list{flex:none;min-height:0;overflow:visible}.rom-panel{overflow-y:auto}.rom-source-tools>.rom-settings{margin:0}';
        style.textContent += '.rom-panel .rom-settings,.rom-panel .rom-pairing-settings{background:#242b40;border:1px solid #4f6085;border-left:3px solid #819bed;border-radius:7px;padding:8px 10px;color:#dce6ff}.rom-panel .rom-general-settings{background:#2b3150;border-color:#697cc1;border-left-color:#a2b4ff}.rom-panel .rom-settings>summary,.rom-panel .rom-pairing-settings>summary{color:#dce6ff;font-weight:600;cursor:pointer;line-height:1.5;padding:2px 0}.rom-panel .rom-settings>summary:hover,.rom-panel .rom-pairing-settings>summary:hover{color:#fff}.rom-panel .rom-settings[open]>summary,.rom-panel .rom-pairing-settings[open]>summary{border-bottom:1px solid #53618b;padding-bottom:8px;margin-bottom:6px}.rom-panel .rom-settings .rom-settings{background:#20283b;border-color:#485b7c}.rom-panel .rom-settings select,.rom-panel .rom-settings input:not([type=checkbox]):not([type=range]),.rom-panel .rom-pairing-settings select,.rom-panel .rom-pairing-settings input:not([type=checkbox]){background:#161e30;border-color:#53658d;color:#edf2ff}';
        style.textContent += '.rom-settings-heading{font-size:12px;line-height:1.5;font-weight:600;margin:0 0 6px;padding:2px 0 8px;border-bottom:1px solid #53618b;color:#dce6ff}';
        style.textContent += `
            #reels-task-overview .rom-panel .rom-pairing-cards{background:transparent;border:0;padding:0;color:#e3e6f0}
            #reels-task-overview .rom-pairing-cards>summary{border:0;margin:0;padding:8px 0 12px;color:#eceafa;font-size:14px}
            .rom-pairing-card-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;container-type:inline-size}
            .rom-pair-card{min-width:0;background:#262a35;border:1px solid #454c61;border-radius:12px;padding:14px;display:flex;flex-direction:column;gap:10px}
            .rom-pair-card-wide{grid-column:1/-1}
            .rom-pair-card h4{margin:0;color:#f0edff;font-size:13px;font-weight:650}
            .rom-pair-card small,.rom-pair-card-footer small,.rom-pair-advanced small{display:block;color:#aeb7cc;line-height:1.6;font-size:12px}
            .rom-pair-card>label{display:grid;gap:6px;min-width:0}
            #reels-task-overview .rom-pairing-cards select{box-sizing:border-box;width:100%;min-width:0;padding:9px;border:1px solid #596079;border-radius:7px;background:#191d27;color:#f0edff}
            #reels-task-overview .rom-pairing-cards input[type=number]{box-sizing:border-box;width:76px;padding:7px;border:1px solid #596079;border-radius:7px;background:#191d27;color:#f0edff}
            .rom-pair-number{display:grid;grid-template-columns:1fr auto;align-items:center;gap:6px;font-size:12px}
            .rom-pair-number small{grid-column:1/-1}
            .rom-pair-card fieldset{min-width:0;border:0;padding:0;margin:0}
            .rom-pair-card legend{font-size:12px;color:#aeb7cc;margin-bottom:8px}
            .rom-pair-card fieldset label{font-size:12px;line-height:1.8}
            #reels-task-overview .rom-pair-card input[type=checkbox]{accent-color:#9b8cff;margin-right:6px}
            .rom-pair-card fieldset>div{padding:8px 0;border-bottom:1px solid #3c4252;display:grid!important;grid-template-columns:minmax(80px,1fr) auto auto!important;gap:12px!important}
            .rom-pair-card fieldset>div:last-of-type{border-bottom:0}
            .rom-pair-card fieldset>div>b{font-size:12px;font-weight:500}
            .rom-pair-card fieldset>div>label{display:flex;align-items:center;gap:5px}
            .rom-pair-advanced{padding:12px 14px;border:1px solid #454c61;border-radius:10px;font-size:12px;background:#222630}
            .rom-pair-advanced>summary{cursor:pointer;color:#c7cce0}
            .rom-pair-advanced>.rom-pair-number{margin:12px 0}
            .rom-pair-card-footer{display:grid;gap:10px}
            #reels-task-overview .rom-pair-card-footer button{padding:12px;background:#6757d9;color:white;border:1px solid #a89cf5;border-radius:9px;font-weight:600}
            @container (max-width:440px){.rom-pair-card{grid-column:1/-1}.rom-pair-card fieldset>div{gap:6px!important}#reels-task-overview .rom-pair-card fieldset input[type=number]{width:56px}}
        `;
        style.textContent += '.rom-general-settings>.rom-settings-body{gap:0;padding:0}.rom-settings-category{display:flex;flex-direction:column;gap:8px;padding:12px 0}.rom-settings-category+.rom-settings-category{border-top:1px solid #53618b}.rom-settings-category>h5{margin:0 0 2px;font-size:12px;font-weight:600;color:#b7caff}.rom-settings-category>label{font-size:12px;line-height:1.5}';
        style.textContent += '.rom-general-settings>.rom-action-bar{background:#2b3150;border:0;border-radius:0;padding:4px 0 10px;box-shadow:none;border-bottom:1px solid #53618b}.rom-general-settings>.rom-action-bar>strong{font-size:14px;color:#edf2ff}.rom-general-settings .rom-selection-count{font-size:12px}.rom-general-settings>.rom-action-bar .rom-display{margin:0}';
        const body = root.querySelector('.rto-body');
        body.prepend(panel);
        const resizeHandle = document.createElement('div');
        resizeHandle.className = 'rom-resize';
        resizeHandle.tabIndex = 0;
        resizeHandle.setAttribute('role', 'separator');
        resizeHandle.setAttribute('aria-label', '调整媒体池宽度');
        resizeHandle.setAttribute('aria-orientation', 'vertical');
        resizeHandle.title = '拖动调整媒体池宽度；方向键也可调整';
        panel.after(resizeHandle);
        let panelWidth = body.getBoundingClientRect().width / 2, resizing = null, customPanelWidth = false;
        function setPanelWidth(width) {
            const max = Math.max(240, Math.min(body.getBoundingClientRect().width * .75, body.getBoundingClientRect().width - 240));
            panelWidth = Math.round(Math.max(240, Math.min(max, width)));
            panel.style.width = `${panelWidth}px`;
            resizeHandle.setAttribute('aria-valuemin', '240');
            resizeHandle.setAttribute('aria-valuemax', String(Math.round(max)));
            resizeHandle.setAttribute('aria-valuenow', String(panelWidth));
        }
        function endResize() { resizing = null; root.classList.remove('rom-resizing'); }
        resizeHandle.onpointerdown = event => {
            if (event.button !== 0) return;
            event.preventDefault();
            customPanelWidth = true;
            resizing = {x:event.clientX, width:panelWidth};
            resizeHandle.setPointerCapture(event.pointerId);
            root.classList.add('rom-resizing');
        };
        resizeHandle.onpointermove = event => {if (resizing) setPanelWidth(resizing.width + event.clientX - resizing.x);};
        resizeHandle.onpointerup = resizeHandle.onpointercancel = resizeHandle.onlostpointercapture = endResize;
        resizeHandle.onkeydown = event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            customPanelWidth = true;
            setPanelWidth(event.key === 'Home' ? 240 : event.key === 'End' ? Infinity : panelWidth + (event.key === 'ArrowRight' ? 24 : -24));
        };
        const onResize = () => {if (!panel.hidden) setPanelWidth(customPanelWidth ? panelWidth : body.getBoundingClientRect().width / 2);};
        window.addEventListener('resize', onResize);
        setPanelWidth(panelWidth);
        const query = selector => panel.querySelector(selector);
        const taskGrid=root.querySelector('.rto-grid');
        const taskPane=document.createElement('div');taskPane.className='rom-task-pane';
        taskGrid.before(taskPane);taskPane.appendChild(taskGrid);
        const taskTools=document.createElement('div');taskTools.className='rom-task-tools';
        taskTools.innerHTML='<strong>任务选择</strong><button data-select="all">全选</button><button data-select="invert">反选</button><button data-select="clear">取消选择</button><output class="rom-task-count"></output>';
        taskPane.prepend(taskTools);
        taskTools.onclick=event=>{
            const button=event.target.closest('[data-select]');if(!button)return;
            selectTasks(cards,checkedTasks,button.dataset.select);
            for(const card of cards) {
                const checkbox=card.el.querySelector('.rom-task-select input');if(checkbox)checkbox.checked=checkedTasks.has(card.task);
            }
            query('.rom-scope').value='selected';updateTaskSelectionCount();root._rtoSelectionChanged?.();
        };
        const groupFor = key => context.groups.find(group => group.key === key);
        const targetGroup = key => key==='background-library' ? backgroundLibrary?.targetGroup?.() || groupFor('bg') : key==='unclassified' ? groupFor(query('.rom-random-layer:checked')?.value) || context.groups.find(group=>group.field==='pip') || groupFor('bg') : groupFor(key);
        style.textContent += '.rom-folder-select-all{margin-left:12px;padding:3px 8px;border:1px solid #77719a;border-radius:5px;background:#39344f;color:#e6dfff;font-size:11px;vertical-align:middle;cursor:pointer}.rom-folder-select-all:hover{background:#51476b}';
        style.textContent += '.rom-source-section{border:1px solid #555064;border-radius:8px;padding:8px;margin:0 0 12px}.rom-source-section>summary{font-weight:700;color:#eee;cursor:pointer;padding:6px 0}.rom-source-section>.rom-section,.rom-source-section>.rom-category-section{margin-left:6px}';
        const status = text => {query('.rom-status').textContent = text;};
        const sourceFor = (path, key) => mediaSource(unitFor(context,path,key)?.preview || path);
        const refresh = createRefreshQueue(() => renderRefresh(), callback => window.setTimeout(callback, 80), id => window.clearTimeout(id));
        function updatePairRoots(){
            for(const source of ['temporary','library','characters']){
                const select=query(`[data-pairing="${source}"] [data-pair-root]`);
                const roots=isPersistentSource(source)?(window.ReelsMediaLibrary?.opened || []).filter(item=>librarySource(item.root)===source):(window.ReelsMediaLibrary?.tracked || []);
                const signature=JSON.stringify(roots.map(item=>item.root));if(select.dataset.roots===signature)continue;
                const previous=select.value;select.innerHTML='<option value="all">本模块全部目录</option>'+roots.map(item=>`<option value="${escape(item.root)}">${escape(item.root)}</option>`).join('');
                select.value=roots.some(item=>item.root===previous)?previous:'all';select.dataset.roots=signature;
            }
        }
        function updateBindingPreview(){
            const materials=[];
            for(const group of [...context.groups,{key:'unclassified'}])for(const path of listPaths(context,group.key)){
                const unit=unitFor(context,path,group.key);
                if(!sourceFor(path,group.key))continue;
                materials.push({path,name:unit?.folder?basename(path):basename(parent(path))+' '+basename(path)});
            }
            for(const item of candidatePool)if(item.files?.length && item.files.every(file=>mediaSource(file)))materials.push({path:item.path,name:item.folder?item.name:basename(parent(item.path))+' '+item.name});
            query('.rom-binding-preview').textContent=window.ReelsNameBinding?.summarizeMaterials(materials) || '';
        }
        function renderRefresh() {
            if (disposed || panel.hidden) return;
            updateBindingPreview();
            updatePairRoots();usedBatches?.refresh();
            const scrollTop = query('.rom-list').scrollTop;
            query('.rom-list').querySelectorAll('video[poster]').forEach(video => {
                posters.set(video.dataset.path, video.poster);
                if (video.style.aspectRatio) aspects.set(video.dataset.path, video.style.aspectRatio);
            });
            inventory = collect(context, tasks);
            const groupKey = query('.rom-group').value, sort = query('.rom-sort').value;
            const search = query('.rom-search').value.trim().toLowerCase();
            const groups = [...context.groups, {key:'unclassified',label:'待分类素材'}].filter(group => groupKey === 'all' || group.key === groupKey);
            let sections = sourceSections(groups.map(group => {
                const key = group.key;
                const rowsOf = path => usageRows(context,inventory,path,key);
                const count = path => rowsOf(path).length;
                const histories=new Map();
                const historyOf=path=>{if(!histories.has(path))histories.set(path,window.ReelsMediaLibrary?.historyFor(unitFor(context,path,key)?.files || [path]));return histories.get(path);};
                const paths = listPaths(context, key);
                const order = orderPaths(paths, (a,b) => (sort === 'usage' ? count(a) - count(b) : sort==='history-count' ? (historyOf(a)?.count || 0)-(historyOf(b)?.count || 0) : sort==='history-time' ? String(historyOf(a)?.lastUsedAt || '').localeCompare(historyOf(b)?.lastUsedAt || '') : 0) || basename(a).localeCompare(basename(b), 'zh', {numeric:true}), displayOrders.get(key));
                displayOrders.set(key, order);
                const items = filterSelectedPaths(order.filter(path=>{
                    const unit=unitFor(context,path,key),source=materialSource(key,{path,unit},fixedRoots(),temporaryImports);
                    return basename(path).toLowerCase().includes(search)
                        && (!isPersistentSource(source) || persistentCategory(source).value==='all' || (unit?.files || [path]).some(file=>'c:'+libraryCategory(source==='characters'?characterRoots():fixedRoots(),file)===persistentCategory(source).value))
                        && (!window.ReelsMediaLibrary || window.ReelsMediaLibrary.matchesHistory(historyOf(path),isPersistentSource(source)?persistentHistory(source).value:source==='temporary'?temporaryHistory.value:'all'))
                        && (!(sort==='unused' || (source==='batch' && query('.rom-only-unused').checked)) || count(path)===0);
                }),checkedMedia,key,query('.rom-only-selected').checked);
                return {key, label:group.label, items:items.map(path => ({path, rows:rowsOf(path),
                    unit:unitFor(context,path,key), src:sourceFor(path,key), history:historyOf(path)}))};
            }),fixedRoots(),temporaryImports);
            if(query('.rom-keyword-grouping').checked)sections=keywordSections(sections,text=>window.ReelsNameBinding?.match(text) || [],window.ReelsMediaLibrary?.bindingRules?.keywords || []);
            const list = query('.rom-list');
            const sourceFiltered=source=>groupKey!=='all' || !!search || query('.rom-only-selected').checked || sort==='unused'
                || (isPersistentSource(source) && (persistentCategory(source).value!=='all' || persistentHistory(source).value!=='all'))
                || (source==='batch' && query('.rom-only-unused').checked) || (source==='temporary' && temporaryHistory.value!=='all');
            const sourceLabels={batch:'本批视频素材',temporary:'临时加载素材',library:'固定素材库',characters:'爆贴人物库'};
            const sourceTitle=source=>`${sourceLabels[source]} · ${sections.filter(section=>section.source===source).reduce((n,section)=>n+section.items.length,0)}${sourceFiltered(source)?'（筛选结果）':''}`;
            const updated = updateMediaTiles(list, sections, selectedPath, selectedGroup, checkedMedia);
            if (updated.reused) {
                syncCandidateBadges(list,candidatePool);
                list.querySelectorAll('[data-source-summary]').forEach(summary=>summary.textContent=sourceTitle(summary.dataset.sourceSummary));
                if (!thumbnailLoader) thumbnailLoader = window.BatchThumbnailLoader?.hydrate(panel);
                renderPair();
                return;
            }
            thumbnailLoader?.dispose();
            const renderSection=({key, sectionKey=key, label, items, keyword}) => {
                const tiles = items.map(({path, rows, unit, src, history}) => {
                    const thumbnail = !src ? `<div style="padding:12px;color:#fca5a5;overflow-wrap:anywhere;">文件不存在或不可读取<br>${escape(basename(path))}</div>`
                        : image(unit?.preview || path) ? `<img crossorigin="anonymous" loading="lazy" src="${escape(src)}">`
                        : `<video crossorigin="anonymous" class="rbt-thumb-previewable" style="aspect-ratio:${escape(aspects.get(path) || 'auto')}" data-thumb-size="720" data-thumb-quality="0.92" data-path="${escape(path)}" data-thumb-src="${escape(src)}#t=0.1" preload="none" muted ${posters.has(path) ? `poster="${escape(posters.get(path))}" data-thumb-hydrated="true"` : ''}></video>`;
                    return `<div class="rom-item ${rows.length || history?.count ? 'rom-used' : ''} ${!rows.length ? 'unused' : ''} ${path === selectedPath && key === selectedGroup ? 'selected' : ''} ${checkedMedia.has(`${key}\n${path}`)?'checked':''}" draggable="${!!src}" aria-disabled="${!src}" tabindex="0" role="button" data-group="${escape(key)}" data-path="${escape(path)}" title="${escape(path)}${rows.length ? '\n任务：' + rows.join('、') : ''}">${thumbnail}<label class="rom-check-label"><input type="checkbox" class="rom-check" aria-label="勾选素材" ${checkedMedia.has(`${key}\n${path}`)?'checked':''}>选中分配</label><span>${unit?.folder ? `<b class="rom-folder-name">📁 ${escape(basename(path))}</b><small>文件夹 · ${unit.files.length} 个文件</small>` : `<b class="rom-name">${escape(basename(path))}</b>`}<small class="rom-usage">${rows.length} 次${rows.length ? ' · 已使用 · 任务 ' + rows.join('、') : ' · 未使用'}</small><small class="rom-history ${history?.count ? 'rom-history-used' : ''}" ${history?.known ? '' : 'hidden'} title="${escape(history?.title || '')}">${escape(history?.label || '')}</small></span></div>`;
                }).join('');
                return `<details class="rom-section" data-group="${escape(key)}" data-section="${escape(sectionKey)}" ${collapsed.has(sectionKey) ? '' : 'open'}><summary>${escape(label)} · ${items.length}<button type="button" class="rom-folder-select-all" title="勾选此分组当前显示的全部素材，保留其他分组的勾选">${keyword!==undefined?'全选本组':'全选当前文件夹'}</button></summary><div class="rom-grid">${tiles || '<p class="rom-hint">此列暂无素材，可导入文件或读取素材文件夹。</p>'}</div></details>`;
            };
            for(const source of ['batch','temporary','library','characters']){
                const members=sections.filter(section=>section.source===source);
                const sectionKey=JSON.stringify(['material-source',source]),count=members.reduce((n,section)=>n+section.items.length,0);
                let body=members.map(renderSection).join('');
                if(isPersistentSource(source)){
                    const categories=new Map();
                    for(const section of members){if(!categories.has(section.category))categories.set(section.category,[]);categories.get(section.category).push(section);}
                    body=[...categories].map(([category,children])=>{
                        const key=JSON.stringify(['library-category',source,category]);
                        return `<details class="rom-category-section" data-section="${escape(key)}" ${collapsed.has(key)?'':'open'}><summary>📁 ${escape(category || '库根目录散文件')} · ${children.reduce((n,item)=>n+item.items.length,0)}<button type="button" class="rom-folder-select-all" title="勾选此分类文件夹当前显示的全部素材，包含子文件夹">全选当前文件夹</button></summary>${children.map(renderSection).join('')}</details>`;
                    }).join('');
                }
                const module=list.querySelector(`[data-source="${source}"]`);
                module.querySelector('[data-source-summary]').textContent=sourceTitle(source);
                module.querySelector('.rom-source-content').innerHTML=body || (sourceFiltered(source) ? '<p class="rom-hint">暂无符合此模块筛选的素材</p>' : '<p class="rom-hint">此类暂无素材</p>');
            }
            syncCandidateBadges(list,candidatePool);
            list._romLayout = updated.layout;
            list.scrollTop = scrollTop;
            query('.rom-list').querySelectorAll('details[data-section]').forEach(section => {
                if(section._romToggleBound)return;section._romToggleBound=true;
                section.addEventListener('toggle', () => {
                const key=section.dataset.section || section.dataset.group;
                if(collapsed.has(key)===!section.open)return;
                if (section.open) collapsed.delete(key); else collapsed.add(key);
                thumbnailLoader?.dispose();
                if (!panel.hidden) thumbnailLoader = window.BatchThumbnailLoader?.hydrate(panel);
                });
            });
            thumbnailLoader = window.BatchThumbnailLoader?.hydrate(panel);
            renderPair();
            if (inventory.removedUnused) status(`已同步当前任务，移除 ${inventory.removedUnused} 条旧素材记录${inventory.missingUnused ? `（${inventory.missingUnused} 条文件已不存在）` : ''}`);
        }
        function payload(path, key) {
            const group = targetGroup(key);
            const selected = path === selectedPath ? query('.rom-pair')?.value : '';
            return {path, group, selected, poolKey:key};
        }
        function requestReplacement(card, data) {
            if (!data?.group) return status('请点击任务中的背景或媒体层');
            // An external background has no saved copy pairing: preserve the task's existing text.
            const choices = !data.external && data.group.field === 'bg' && context.backgroundChoices ? context.backgroundChoices(data.path) : null;
            const decision = quickReplacement(data, choices);
            if (decision.confirm) confirmReplacement(card, data);
            else apply(card, {...data, bundle:decision.bundle});
        }
        function showReplacementFeedback(card, entry, label) {
            root.querySelectorAll('.rom-swap-feedback').forEach(node=>node.remove());
            const feedback=document.createElement('div');feedback.className='rom-swap-feedback';feedback.setAttribute('role','status');
            const text=document.createElement('span');text.textContent=`已替换 · ${label}`;
            const button=document.createElement('button');button.textContent='撤销';
            button.onclick=event=>{event.stopPropagation();if(undo[undo.length-1]!==entry)return status('请使用撤销分配按钮撤销后续操作');query('.rom-undo').click();feedback.remove();};
            feedback.append(text,button);card.el.appendChild(feedback);
        }
        function confirmReplacement(card, data) {
            if (!sourceFor(data?.path,data?.poolKey)) return status('文件不存在或不可读取，请重新读取素材文件夹');
            if (disposed || !card || !data?.group) return;
            confirmation?.close();
            const choices = !data.external && data.group.field === 'bg' && context.backgroundChoices ? context.backgroundChoices(data.path) : null;
            let bundle = choices?.length === 1 ? choices[0] : choices?.find(choice => choice.signature === data.selected);
            const beforeOf = group => pathsOf(context.read(card.task, group), group).map(basename).join('、') || '未设置';
            const before = beforeOf(data.group);
            // 同一任务有多个覆层媒体时，允许在确认前改选要替换的层位。
            const pipGroups = data.group.field === 'pip' ? context.groups.filter(group => group.field === 'pip') : [];
            const dialog = document.createElement('dialog'); dialog.className = 'rom-confirm';
            dialog.setAttribute('aria-label', `确认替换任务 ${card.id + 1}`);
            dialog.innerHTML = `<h3>替换任务 ${card.id + 1} · <span class="rom-confirm-label">${escape(data.group.label)}</span></h3>${choices?.length > 1 ? `<label>选择配套文案<select class="rom-confirm-pair" aria-label="选择配套文案"><option value="">请选择配套文案</option>${choices.map(choice => `<option value="${escape(choice.signature)}">${escape(choice.historical ? '已保存的配套文字' : '当前任务 ' + choice.rows.join('、'))} · ${escape(choice.cards.map(entry => entry.overlay.title_text || entry.overlay.body_text || '').join(' / ').slice(0,50) || '无文字卡片')}</option>`).join('')}</select></label>` : ''}<p class="rom-confirm-required" hidden></p><details class="rom-confirm-details"><summary>展开替换详情</summary>${pipGroups.length > 1 ? `<label>更换目标层<select class="rom-confirm-slot" aria-label="选择要替换的覆层媒体">${pipGroups.map(group => `<option value="${escape(group.key)}"${group.key === data.group.key ? ' selected' : ''}>${escape(group.label)}</option>`).join('')}</select></label>` : ''}<p>原素材：<span class="rom-confirm-before">${escape(before)}</span></p><p>新素材：${escape(basename(data.path))}</p>${choices ? `<p>${choices.length?'背景与配套文字一起替换，保留当前布局。':'仅替换背景，保留任务原有文字。'}</p><p class="rom-confirm-words"></p>` : ''}</details><div class="rom-confirm-actions"><button class="rom-confirm-cancel">取消</button><button class="rom-confirm-ok">确认替换</button></div>`;
            const slotSelect = dialog.querySelector('.rom-confirm-slot');
            if (slotSelect) slotSelect.onchange = () => {
                const group = groupFor(slotSelect.value); if (!group) return;
                data = {...data, group};
                dialog.querySelector('.rom-confirm-label').textContent = group.label;
                dialog.querySelector('.rom-confirm-before').textContent = beforeOf(group);
            };
            const ok = dialog.querySelector('.rom-confirm-ok'), selector = dialog.querySelector('.rom-confirm-pair');
            const update = () => {
                if (selector) bundle = choices.find(choice => choice.signature === selector.value);
                ok.disabled = choices?.length > 1 && !bundle;
                const required = dialog.querySelector('.rom-confirm-required');
                required.hidden = !ok.disabled;
                required.textContent = '请选择配套文案后确认。';
                const words = dialog.querySelector('.rom-confirm-words');
                if (words) words.textContent = bundle ? bundle.cards.map(entry => [entry.overlay.title_text,entry.overlay.body_text,entry.overlay.footer_text].filter(Boolean).join('\n')).join('\n\n') || '配套方案无文字卡片，将清除旧文字。' : choices.length ? '请选择配套文案后确认。' : '此背景没有配套文字：只替换背景，保留任务原有文字。';
            };
            if (selector) {selector.value = bundle?.signature || ''; selector.onchange = update;}
            update();
            const focused = document.activeElement;
            // Keep confirmation at the target card, including when details expand.
            const position = () => {
                if (!dialog.open || !card.el.isConnected) return;
                const rect = card.stage?.getBoundingClientRect() || card.el.getBoundingClientRect();
                const width = dialog.getBoundingClientRect().width;
                const height = dialog.getBoundingClientRect().height;
                const inset = 12;
                dialog.style.left = `${Math.max(inset, Math.min(window.innerWidth-width-inset, rect.left+(rect.width-width)/2))}px`;
                dialog.style.top = `${Math.max(inset, Math.min(window.innerHeight-height-inset, rect.top+20))}px`;
            };
            const sizeObserver = window.ResizeObserver ? new window.ResizeObserver(position) : null;
            dialog.querySelector('.rom-confirm-details').addEventListener('toggle', position);
            window.addEventListener('resize', position);
            root.addEventListener('scroll', position, true);
            dialog.onclose = () => {sizeObserver?.disconnect();window.removeEventListener('resize',position);root.removeEventListener('scroll',position,true);card.el.classList.remove('rom-pending');dialog.remove();if(confirmation===dialog)confirmation=null;if(focused?.isConnected)focused.focus();};
            dialog.querySelector('.rom-confirm-cancel').onclick = () => {status('已取消替换');dialog.close();};
            ok.onclick = () => {if(ok.disabled || disposed)return;apply(card,{...data,bundle});dialog.close();};
            root.appendChild(dialog); confirmation = dialog;
            card.el.classList.add('rom-pending');
            dialog.showModal();
            position();
            sizeObserver?.observe(dialog);
            dialog.querySelector('.rom-confirm-cancel').focus({preventScroll:true});
        }
        function showBindingConflict(card,check,data) {
            root.querySelector('.rom-binding-conflict')?.close();
            const dialog=document.createElement('dialog');dialog.className='rom-confirm rom-binding-conflict';
            dialog.style.cssText='position:fixed;inset:0;margin:auto;width:min(620px,90vw);height:fit-content;max-height:85vh;overflow:auto';
            const heading=document.createElement('h3');heading.textContent=`任务 ${card.id+1} · 素材关键词不匹配`;
            const details=document.createElement('p');details.style.whiteSpace='pre-wrap';details.textContent=check.reason;
            const actions=document.createElement('div');actions.className='rom-confirm-actions';
            const close=document.createElement('button');close.textContent='返回选择素材';close.onclick=()=>dialog.close();actions.appendChild(close);
            const force=document.createElement('button');force.className='rom-confirm-ok';force.textContent='强制替换';
            force.title='仅本次忽略关键词限制，保留其他层和全局名字规则';
            force.onclick=async()=>{if(force.disabled)return;force.disabled=true;dialog.close();await apply(card,{...data,forceKeyword:true});};actions.appendChild(force);
            dialog.append(heading,details,actions);dialog.onclose=()=>dialog.remove();root.appendChild(dialog);dialog.showModal();
            close.focus({preventScroll:true});
        }
        let replacingMedia=false;
        async function apply(card, data) {
            if(replacingMedia || window._reelsMediaWriteBatchDepth>0)return status('正在处理素材，请稍候…');
            if (!card || !data?.group) return;
            if (!sourceFor(data.path,data.poolKey)) return status('文件不存在或不可读取，未替换任务');
            const value = replacementValue(context,data.path,data.group,data.poolKey,data.bundle);
            const bindingCheck=data.forceKeyword?null:window.ReelsNameBinding?.checkReplacement(context,card.task,data.group,value);
            if(bindingCheck && !bindingCheck.allowed){status(`任务 ${card.id+1} 的素材关键词不匹配，请查看提示`);showBindingConflict(card,bindingCheck,data);return;}
            const unit=unitFor(context,data.path,data.poolKey);
            const item={id:data.path,path:data.path,name:basename(data.path),folder:!!unit?.folder,files:pathsOf(value,data.group)};
            const sharedLibrary=data.poolKey==='background-library' || data.poolKey==='phone-library'
                || item.files.some(path=>window.ReelsBackgroundLibrary?.hasPath?.(path) || phoneLibrary?.hasPath?.(path));
            item.origin=unit?._archiveOrigin || materialSource(data.poolKey,{path:data.path,unit},fixedRoots(),temporaryImports);
            const movable=data.preserveSource || sharedLibrary || ['library','characters'].includes(item.origin) || window.ReelsUsedBatches?.shouldMove(item,archiveBatchState)===false?[]:[item];
            // 单次替换只记录本次改动；完整工程由自动保存恢复文件负责，避免每次序列化整个工程。
            const beforePaths=pathsOf(context.read(card.task,data.group),data.group);
            const beforeTask=JSON.parse(JSON.stringify(card.task));
            replacingMedia=true;query('.rom-undo').disabled=true;
            status(movable.length?'正在替换并移动已用素材…':'正在替换素材，保留原位置…');
            try{
                const baseline=window.electronAPI?.autoSavePath;
                if(baseline && window.electronAPI.fileExists && !window.electronAPI.fileExists(baseline)){
                    if(await window.reelsSaveUnifiedProject?.({wait:true})===false)throw new Error('无法建立工程恢复基线，未移动素材');
                }
                const entry=await replaceSingle(context,card.task,data.group,value,{
                    beforeWrite:()=>hooks.beforeWrite(),usageRoot:unit?.folder?data.path:'',
                    recordUse:(...args)=>window.ReelsMediaLibrary?.recordUse?.(...args),
                    cancelUse:(...args)=>window.ReelsMediaLibrary?.cancelUse?.(...args),
                    move:async()=>{
                        if(!movable.length)return null;
                        if(!window.electronAPI?.apiCall)throw new Error('移动素材需要桌面版');
                        const roots=[...(library?.opened || []),...temporaryDirectories.values()].map(source=>source.root || source.directory);
                        const units=archiveUnits(movable,{roots,rootFor:(...args)=>library?.rootFor?.(...args) || ''});
                        const recovery={kind:'single-replace',at:new Date().toISOString(),taskId:card.task?.id || '',taskNumber:card.id+1,
                            layer:{key:data.group.key,label:data.group.label},before:beforePaths,after:item.files,
                            basePath:window.electronAPI.autoSavePath || '',tabId:context.tabId,beforeTask,afterTask:JSON.parse(JSON.stringify(card.task))};
                        const response=await window.electronAPI.apiCall('batch-used-media',{action:'move',units,recovery,recoveryName:'替换记录.json'});
                        if(!response?.success)throw new Error(response?.error || '移动已用素材失败');
                        return response.data;
                    },
                    rollback:async archive=>{
                        const response=await window.electronAPI.apiCall('batch-used-media',{action:'rollback',id:archive.id,directories:archive.directories});
                        if(!response?.success)throw new Error(response?.error || '素材移回失败，请检查使用清单');
                        return response.data;
                    },
                    relocate:applyRelocation,
                });
                undo.push(entry);geometry.delete(card);
                showReplacementFeedback(card,entry,data.group.label);
                window.dispatchEvent(new CustomEvent('reels-overview-undo-push', {detail:'media'}));
                // endBatch() 已安排 200ms 防抖的自动保存（异步原子写入），连续替换时合并为一次保存。
                status(`已${data.forceKeyword?'强制':''}替换任务 ${card.id + 1} · ${data.group.label}${data.bundle ? '及配套文字卡片' : ''}${entry.archive?.mappings?.length?'；素材已移动到“本批已经使用”':'；素材保留原位置'}`);
            }catch(error){status(`替换失败：${error.message}`);window.showToast?.(error.message,'warning');}
            finally{replacingMedia=false;query('.rom-undo').disabled=!undo.length;refresh();}
        }
        const preview = query('.rom-preview');
        function renderPair() {
            const selected = query('.rom-pair')?.value;
            panel.querySelector('.rom-pair-label')?.remove();
            if (!selectedPath || targetGroup(selectedGroup)?.field !== 'bg' || !context.backgroundChoices) return;
            const choices = context.backgroundChoices(selectedPath);
            const words = choice => choice.cards.map(entry => [entry.overlay.title_text,entry.overlay.body_text].filter(Boolean).join(' ')).join(' / ').slice(0,80) || '无文字卡片';
            const source = choice => choice.historical ? '已保存的配套文字' : `当前任务 ${choice.rows.join('、')}`;
            const label = document.createElement('label'); label.className = 'rom-hint rom-pair-label';
            if (choices.length === 1) {
                label.textContent = `自动带入配套文字 · ${source(choices[0])}：${words(choices[0])}`;
            } else if (choices.length > 1) {
                label.innerHTML = `同一视频有多套文字，请选择<select class="rom-pair" aria-label="背景配套文字来源"><option value="">请选择配套文字</option>${choices.map(choice => `<option value="${escape(choice.signature)}">${escape(source(choice))} · ${escape(words(choice))}</option>`).join('')}</select>`;
                if (choices.some(choice => choice.signature === selected)) label.querySelector('select').value = selected;
            } else label.textContent = '这个背景没有配套文字，替换时保留任务原有文字';
            query('.rom-distribution-actions').before(label);
        }
        function cancelReplacement() {
            root._romReplacementTarget=null;
            panel.querySelector('.rom-target-replacement')?.remove();
        }
        function replacementGroup(card, overlay) {
            if(!cards.includes(card) || !window._reelsState?.tasks?.includes(card.task))return null;
            if(!overlay)return context.groups.find(group=>group.field==='bg');
            if(!(card.task.overlays || []).some(item=>!item.disabled && String(item.id)===String(overlay.id)))return null;
            return context.groups.find(group=>group.field==='pip' &&
                ([overlay.slotKey,overlay._templateOverlayId,overlay.id].filter(Boolean).includes(group.mediaSlot)
                || String(context.mediaLayer?.(card.task,group)?.id)===String(overlay.id)));
        }
        function beginReplacement(card,group,overlay=null) {
            if(!group)return;
            setClickMode(false);cancelReplacement();hooks.showPool?.();
            root._romReplacementTarget={card,group,overlay};
            const banner=document.createElement('div');banner.className='rom-target-replacement';
            banner.style.cssText='padding:10px;border:1px solid #aa94ff;background:#332d48;border-radius:6px;display:flex;gap:8px;align-items:center;flex-wrap:wrap';
            const label=document.createElement('span');label.textContent=`替换任务 ${card.id+1} · ${group.label}：点击下方素材`;
            const cancel=document.createElement('button');cancel.textContent='取消替换';cancel.onclick=()=>{cancelReplacement();status('已取消定向替换');};
            banner.append(label,cancel);
            const header=panel.querySelector('.rom-workspace-header');
            if(header)header.appendChild(banner);else panel.querySelector('strong').after(banner);
            query('.rom-group').value='all';query('.rom-search').value='';
            refresh.flush();status(label.textContent+'（Esc 取消）');query('.rom-search').focus();
        }
        function appendReplacementActions(menu,card,overlay) {
            const group=replacementGroup(card,overlay);if(!group)return;
            const add=(text,action)=>{const button=document.createElement('button');button.setAttribute('role','menuitem');button.textContent=`${text} · ${group.label}`;button.onclick=()=>{menu.remove();return action();};menu.appendChild(button);};
            const original=context.read?.(card.task,group) || overlay;
            let useLatest=window.localStorage?.getItem('reels_relink_group_contents')==='latest';
            if(original?.media_folder_path)add('查找原素材组',()=>run(async()=>{
                const api=window.electronAPI;
                if(!api?.selectDirectory || !api.scanDirectoryRecursive)return status('请在桌面版查找素材组');
                status(`请选择搜索范围，将在其中查找原素材组「${basename(original.media_folder_path)}」`);
                const searchRoot=await api.selectDirectory();
                if(disposed || !searchRoot || replacementGroup(card,overlay)!==group)return;
                status(`正在搜索原素材组「${basename(original.media_folder_path)}」…`);
                const entries=await api.scanDirectoryRecursive(searchRoot,{maxDepth:20});
                if(disposed || replacementGroup(card,overlay)!==group)return;
                const candidates=originalGroupCandidates(original,entries,{useLatest});
                if(!candidates.length)return status(`未找到完整素材组「${basename(original.media_folder_path)}」，请扩大搜索范围；原绑定未修改`);
                const applyFound=async candidate=>{
                    if(disposed || replacementGroup(card,overlay)!==group)return;
                    const value=relinkedGroupValue(original,candidate);
                    if(!window.ReelsMediaRelocation?.review)return status('人工确认组件未加载，请刷新后重试；原绑定未修改');
                    const approved=await window.ReelsMediaRelocation.review([{id:'target-group',taskNumber:card.id+1,taskName:card.task.fileName || card.task.name || '',
                        tabName:card.task._batchTabName || '',layer:group.label,oldFolder:original.media_folder_path,newFolder:candidate.directory,
                        oldFiles:original.media_folder_files || [original.content].filter(Boolean),newFiles:candidate.files,available:true,
                        reason:candidate.useLatest?'将按最新文件夹内容重建素材组，待人工确认':'找到原素材组，待人工确认'}]);
                    if(!approved?.has('target-group'))return status('未确认关联，原素材组保留');
                    if(disposed || replacementGroup(card,overlay)!==group)return;
                    if(api.checkFilesExist){const exists=await api.checkFilesExist(candidate.files);if(candidate.files.some(path=>!exists[path]))return status('确认期间素材组已有片段不可用，原绑定未修改，请重新查找');}
                    rememberFolder(context,'unclassified',candidate.directory,candidate.files);
                    const unit=context.saved._units[`unclassified\n${candidate.directory}`];
                    unit.value=value;
                    requestReplacement(card,{path:candidate.directory,poolKey:'unclassified',group,external:true,ambiguous:false,preserveSource:true});
                };
                if(candidates.length===1 || candidates[0].score>candidates[1].score)return applyFound(candidates[0]);
                const dialog=document.createElement('dialog');dialog.className='rom-confirm';
                const title=document.createElement('h3');title.textContent='找到多个同名素材组，请选择原素材组';dialog.appendChild(title);
                for(const candidate of candidates){
                    const button=document.createElement('button');button.textContent=candidate.directory;
                    button.onclick=()=>{dialog.close();applyFound(candidate);};dialog.appendChild(button);
                }
                const cancel=document.createElement('button');cancel.textContent='取消';cancel.onclick=()=>dialog.close();dialog.appendChild(cancel);
                dialog.onclose=()=>dialog.remove();root.appendChild(dialog);dialog.showModal();
            }));
            add('选择文件并替换',()=>run(async()=>{
                if(!window.electronAPI?.selectFiles)return status('请选择桌面版中的本地素材');
                const paths=await window.electronAPI.selectFiles({title:`查找并替换 · ${group.label}`,multiple:false,filters:[{name:'视频和图片',extensions:['mp4','mov','mkv','avi','webm','m4v','jpg','jpeg','png','webp','gif','bmp']}]});
                if(disposed || !paths?.[0] || replacementGroup(card,overlay)!==group)return;
                if(!window.ReelsMediaRelocation?.review)return status('人工确认组件未加载，请刷新后重试；原绑定未修改');
                const approved=await window.ReelsMediaRelocation.review([{id:'target-file',taskNumber:card.id+1,taskName:card.task.fileName || card.task.name || '',
                    tabName:card.task._batchTabName || '',layer:group.label,oldFolder:original?.media_folder_path || '',
                    oldFiles:original?.media_folder_files || [original?.content || original?.bgPath || card.task.bgPath].filter(Boolean),newFiles:[paths[0]],available:true,reason:'已选择新素材，待人工确认'}]);
                if(!approved?.has('target-file'))return status('未确认替换，原素材保留');
                if(disposed || replacementGroup(card,overlay)!==group)return;
                rememberImports(context.saved,'unclassified',[paths[0]]);
                requestReplacement(card,{path:paths[0],poolKey:'unclassified',group,external:true,ambiguous:false,preserveSource:true});
            }));
            add('从媒体池替换',()=>beginReplacement(card,group,overlay));
            if(original?.media_folder_path){
                const label=document.createElement('label');label.style.cssText='display:flex;gap:7px;align-items:center;padding:8px;font-size:12px;';
                const check=document.createElement('input');check.type='checkbox';check.checked=useLatest;
                check.onchange=()=>{
                    useLatest=check.checked;window.localStorage?.setItem('reels_relink_group_contents',useLatest?'latest':'strict');
                    const bulk=document.getElementById?.('rbt-relink-latest');if(bulk)bulk.checked=useLatest;
                };
                label.title='勾选：以找到的素材组文件夹现有片段重建循环列表，包含新增片段并移除旧引用；不勾选：要求原片段完整存在。';
                label.append(check,document.createTextNode('按最新素材组内容重新关联'));label.onclick=event=>event.stopPropagation();menu.appendChild(label);
            }
        }
        function choose(item) {
            const target=root._romReplacementTarget;
            if(target){
                if(replacementGroup(target.card,target.overlay)!==target.group){cancelReplacement();return status('任务或媒体层已变化，请重新右键选择');}
                const data={...payload(item.dataset.path,item.dataset.group),group:target.group,ambiguous:false,external:true};
                if(!sourceFor(data.path,data.poolKey))return status('文件不存在或不可读取，请选择其他素材');
                cancelReplacement();requestReplacement(target.card,data);return;
            }
            if(!clickMode && item.querySelector('.rom-check').checked) {
                setCheckedTile(item,false);item.classList.remove('selected');
                if(selectedPath===item.dataset.path && selectedGroup===item.dataset.group) {
                    selectedPath='';selectedGroup='';preview.pause();preview.removeAttribute('src');preview.load();preview.hidden=true;renderPair();
                }
                return;
            }
            const src = sourceFor(item.dataset.path,item.dataset.group);
            if (!src) return status('文件不存在或不可读取，请重新读取素材文件夹');
            selectedPath = item.dataset.path; selectedGroup = item.dataset.group;
            // 单击只负责选中素材，默认不加载或展开独立视频预览。
            preview.hidden = true;
            // 选中状态不改变清单或使用次数，不重建成千上万个缩略图。
            query('.rom-list').querySelector('.rom-item.selected')?.classList.remove('selected');
            item.classList.add('selected');
            if (!clickMode) setCheckedTile(item,true);
            renderPair();
            if (clickMode) status(`已选「${basename(selectedPath)}」，点击任务里的背景或媒体层替换；Esc 退出`);
        }
        query('.rom-list').onclick = event => {
            const selectFolder=event.target.closest('.rom-folder-select-all');
            if(selectFolder){
                event.preventDefault();event.stopPropagation();
                const folder=selectFolder.closest('details');
                if(folder){
                    const count=setCheckedTiles(folder.querySelectorAll('.rom-item[data-path][data-group]'),true);
                    status(`已勾选当前分组 ${count} 个素材`);
                }
                return;
            }
            if(event.target.closest('.rom-check-label'))return;
            const item=event.target.closest('.rom-item');if(item)choose(item);
        };
        query('.rom-list').onkeydown = event => {if(event.target.closest('.rom-check-label'))return;if(['Enter',' '].includes(event.key)){const item=event.target.closest('.rom-item');if(item){event.preventDefault();choose(item);}}};
        query('.rom-list').ondragstart = event => {
            if(event.target.closest('.rom-check-label')){event.preventDefault();return;}
            const item = event.target.closest('.rom-item,.rom-bg-item'); if (!item) return;
            drag = payload(item.dataset.path, item.dataset.group || 'background-library');
            if (!drag) {event.preventDefault();return;}
            hooks.beforeWrite(); geometry.clear();
            root.classList.add('rom-dragging');
            panel.querySelectorAll('video').forEach(video => video.pause());
            cards.filter(card=>card.el.isConnected).forEach(card => {card.el.querySelector('.rom-drop-shield').textContent = '';});
            event.dataTransfer.effectAllowed = 'copy';
            event.dataTransfer.setData('application/x-reels-overview-media', JSON.stringify({path:drag.path, key:drag.group.key}));
            status(`拖到任务卡片替换：${drag.group.label}`);
        };
        query('.rom-list').ondragend = () => {drag=null;root.classList.remove('rom-dragging');clearHighlights();};
        // 按松手位置命中卡片里的覆层媒体（与编辑器 hitTest 同一套 x/y/w/h 画布坐标），
        // 左右分屏等多个画中画同时存在时，拖到哪个窗口就替换哪个。
        function cardGeometry(card) {
            const cached=geometry.get(card);
            if(cached && cached.time===card.time && cached.player===card.player && cached.overlays===card.task.overlays)return cached;
            const rect=card.stage.getBoundingClientRect(), cardRect=card.el.getBoundingClientRect();
            const media=(card.task.overlays || []).filter(ov=>['image','video'].includes(ov.type));
            // Replacement targets are media windows, including paused or unloaded video windows.
            const rendered=card.player?.getEditableOverlays?.(media.map(ov=>ov.id));
            const value={rect,cardRect,rendered,time:card.time,player:card.player,overlays:card.task.overlays};geometry.set(card,value);return value;
        }
        function hitTarget(card, event) {
            const {rect,rendered}=cardGeometry(card);
            if (!rect.width || !rect.height || event.clientX<rect.left || event.clientX>=rect.right || event.clientY<rect.top || event.clientY>=rect.bottom) return null;
            const rs=window._reelsState || {}, width=Number(rs.targetWidth)||1080, height=Number(rs.targetHeight)||1920;
            const hit=mediaHit(context.groups,card.task.overlays || [],rendered,
                (event.clientX-rect.left)/rect.width*width,(event.clientY-rect.top)/rect.height*height,Number(card.time)||0,width,height);
            return hit ? {...hit,width,height} : null;
        }
        function targetAt(card,event,data) {
            const hit=hitTarget(card,event);
            const {rect}=cardGeometry(card);
            const inside=event.clientX>=rect.left && event.clientX<rect.right && event.clientY>=rect.top && event.clientY<rect.bottom;
            const background=inside && context.groups.find(group=>group.field==='bg');
            return {hit,data:routeDrop(data,hit?.group || background),inside};
        }
        // 所有来源分类都允许按松手位置替换媒体覆层。
        function dropTarget(card, event) {
            if (!drag) return null;
            const target=targetAt(card,event,drag);
            return {...target.data,ambiguous:!target.inside};
        }
        let highlightedCard = null, highlightedTarget = null;
        function clearHighlights() {
            if(!highlightedCard)return;
            highlightedCard.el.classList.remove('rom-drop');
            highlightedCard.el.querySelector('.rom-layer-highlight')?.setAttribute('hidden','');
            highlightedCard=null; highlightedTarget=null;
        }
        function invalidateGeometry() {geometry.clear();clearHighlights();}
        function positionClickShields() {
            for (const card of cards) {
                const shield=card.el.querySelector('.rom-drop-shield');
                shield.style.cssText='';
                if (clickMode && card.el.isConnected) {
                    const {rect,cardRect}=cardGeometry(card);
                    Object.assign(shield.style,{inset:'auto',left:`${rect.left-cardRect.left-card.el.clientLeft}px`,top:`${rect.top-cardRect.top-card.el.clientTop}px`,width:`${rect.width}px`,height:`${rect.height}px`});
                }
            }
        }
        function setClickMode(enabled) {
            if(enabled)cancelReplacement();
            clickMode=enabled;hooks.beforeWrite();invalidateGeometry();
            root.classList.toggle('rom-click-swapping',enabled);root._romClickSwap=enabled;
            swapMode.textContent=`点选替换：${enabled?'开':'关'}`;swapMode.setAttribute('aria-pressed',String(enabled));
            positionClickShields();status(enabled?'先选择左侧素材，再点击任务中的背景或媒体层；Esc 退出':'已退出点选替换');
        }
        swapMode.onclick=()=>setClickMode(!clickMode);
        const escapeSwap=event=>{if(event.key==='Escape' && clickMode && !confirmation){event.preventDefault();event.stopImmediatePropagation();setClickMode(false);}};
        const onLayoutChange=()=>{invalidateGeometry();if(clickMode)positionClickShields();};
        const gridObserver=window.ResizeObserver ? new window.ResizeObserver(onLayoutChange) : null;
        gridObserver?.observe(taskGrid);
        window.addEventListener('keydown',escapeSwap,true);window.addEventListener('resize',onLayoutChange);root.addEventListener('scroll',onLayoutChange,true);
        const pendingExternal=new WeakSet();
        async function replaceExternal(card,event){
            if(pendingExternal.has(card))return;
            const fallback=context.groups.find(group=>group.field==='bg') || context.groups[0];
            const target=targetAt(card,event,{group:fallback});
            const fail=message=>{status(message);window.showToast?.(message,'warning');};
            const paths=externalDropPaths(event);
            if(!target.inside || !target.data?.group)return fail('请把文件或文件夹拖到预览画面中需要更换的媒体层');
            if(!paths.length)return fail('未能读取拖入文件的本地路径，请从 Finder 或资源管理器拖入');
            pendingExternal.add(card);
            try{
                status('正在读取拖入的素材…');
                const item=await prepareExternalDrop(paths);
                if(disposed || !cards.includes(card) || !window._reelsState?.tasks?.includes(card.task))return;
                const poolKey='unclassified';
                if(item.folder)rememberFolder(context,poolKey,item.path,item.files);
                else rememberImports(context.saved,poolKey,item.files);
                requestReplacement(card,{path:item.path,poolKey,group:target.data.group,external:true,ambiguous:false});
            }catch(error){if(!disposed)fail(error.message);}
            finally{pendingExternal.delete(card);}
        }
        const handlers = cards.map(card => {
            const shield = document.createElement('div'); shield.className = 'rom-drop-shield'; card.el.appendChild(shield);
            const highlight = attachLayerHighlight(card);
            const taskSelect=card.el.querySelector('.rom-task-select') || document.createElement('label');taskSelect.className='rom-task-select';
            taskSelect.style.cssText='position:absolute;right:8px;top:8px;z-index:105;background:#171920dd;color:#fff;padding:5px;border-radius:5px;font-size:12px;';
            taskSelect.innerHTML=`<input type="checkbox" aria-label="勾选任务 ${card.id+1}" ${checkedTasks.has(card.task)?'checked':''}>选中任务`;
            taskSelect.onclick=event=>event.stopPropagation();
            taskSelect.onchange=()=>{
                if(taskSelect.querySelector('input').checked)checkedTasks.add(card.task);else checkedTasks.delete(card.task);
                query('.rom-scope').value='selected';
                updateTaskSelectionCount();root._rtoSelectionChanged?.();
            };
            card.el.appendChild(taskSelect);
            const over = event => {
                const external=externalFileDrag(event);
                const source=drag || (external?{group:context.groups.find(group=>group.field==='bg') || context.groups[0]}:clickMode && selectedPath ? payload(selectedPath,selectedGroup) : null);
                if (!source) return;
                if (drag || external) {event.preventDefault(); event.dataTransfer.dropEffect='copy';}
                const resolved=targetAt(card,event,source);
                if ((external || clickMode && !drag) && !resolved.inside) return clearHighlights();
                const hit=resolved.hit, target=resolved.data;
                const targetKey = `${target.group.key}:${hit ? JSON.stringify(hit.bounds) : 'card'}`;
                if (highlightedCard === card && highlightedTarget === targetKey) return;
                clearHighlights();
                highlightedCard=card; highlightedTarget=targetKey;
                if(hit){
                    const bounds=hit.bounds, {rect:stageRect,cardRect}=cardGeometry(card);
                    Object.assign(highlight.style,{left:`${stageRect.left-cardRect.left-card.el.clientLeft+bounds.x/hit.width*stageRect.width}px`,
                        top:`${stageRect.top-cardRect.top-card.el.clientTop+bounds.y/hit.height*stageRect.height}px`,
                        width:`${bounds.w/hit.width*stageRect.width}px`,height:`${bounds.h/hit.height*stageRect.height}px`});
                    highlight.hidden=false;
                } else card.el.classList.add('rom-drop');
                shield.textContent=`${drag || external?'松开':'点击'}替换 · ${target.group.label}${!external && target.group.field==='bg'?'及配套文字':''}`;
                status(`当前目标：任务 ${card.id + 1} · ${target.group.label}，${drag || external?'松开':'点击'}替换`);
            };
            const leave = event => {if(!card.el.contains(event.relatedTarget) && highlightedCard===card)clearHighlights();};
            const drop = event => {
                if(!drag && !externalFileDrag(event))return;
                event.preventDefault();event.stopImmediatePropagation();
                root.classList.remove('rom-dragging');clearHighlights();
                if(!drag){void replaceExternal(card,event);return;}
                const data=dropTarget(card,event);drag=null;requestReplacement(card,data);
            };
            const clickReplace=event=>{
                if(!clickMode || event.target.closest('button,input,select,.rom-task-select,.rom-swap-feedback'))return;
                const {rect}=cardGeometry(card);
                if(event.clientX<rect.left || event.clientX>=rect.right || event.clientY<rect.top || event.clientY>=rect.bottom)return;
                event.preventDefault();event.stopImmediatePropagation();
                if(!selectedPath)return status('请先选择左侧素材');
                const target=targetAt(card,event,payload(selectedPath,selectedGroup));
                requestReplacement(card,target.data);
            };
            const blockEdit=event=>{if(clickMode && event.target.closest('.rom-drop-shield'))event.stopImmediatePropagation();};
            card.el.addEventListener('click',clickReplace,true);card.el.addEventListener('pointerdown',blockEdit,true);card.el.addEventListener('mousemove',over);card.el.addEventListener('mouseleave',clearHighlights);
            card.el.addEventListener('dragover',over,true);card.el.addEventListener('dragleave',leave);card.el.addEventListener('drop',drop,true);
            return () => {card.el.removeEventListener('click',clickReplace,true);card.el.removeEventListener('pointerdown',blockEdit,true);card.el.removeEventListener('mousemove',over);card.el.removeEventListener('mouseleave',clearHighlights);taskSelect.remove();highlight.remove();shield.remove();card.el.removeEventListener('dragover',over,true);card.el.removeEventListener('dragleave',leave);card.el.removeEventListener('drop',drop,true);};
        });
        query('.rom-undo').onclick = async () => {
            if(replacingMedia || window._reelsMediaWriteBatchDepth>0)return;
            const entry=undo[undo.length-1];if(!entry)return;
            replacingMedia=true;query('.rom-undo').disabled=true;
            root.querySelectorAll('.rom-swap-feedback').forEach(node=>node.remove());geometry.clear();
            let undoBatchOpen=false;
            try{
                hooks.beforeWrite();context.beginBatch?.();undoBatchOpen=true;
                // Move back first, so a failed filesystem rollback leaves a usable task and undo entry.
                if(entry.archive){
                    const restored=await window.electronAPI.apiCall('batch-used-media',{action:'rollback',id:entry.archive.id,directories:entry.archive.directories});
                    if(!restored?.success)throw new Error(restored?.error || '素材移回失败，请检查使用清单');
                    applyRelocation(restored.data.mappings);delete entry.archive;
                }
                for(const item of (Array.isArray(entry)?entry.slice().reverse():[entry])){
                    context.write(item.task,item.group,item.value);
                    if(item.usage)await window.ReelsMediaLibrary?.cancelUse?.(item.task,item.usage);
                }
                undo.pop();const order=root._rtoUndoOrder,at=order?order.lastIndexOf('media'):-1;if(at>=0)order.splice(at,1);
                context.endBatch?.();undoBatchOpen=false;
                if(await window.reelsSaveUnifiedProject?.({wait:true,skipSync:true})===false)throw new Error('撤销已应用，但任务保存失败');
                status(Array.isArray(entry)?`已撤销分配（${entry.length} 个媒体位置）`:'已撤销媒体更换，已移动的素材已移回原位');
            }catch(error){status(`撤销失败：${error.message}`);window.showToast?.(error.message,'warning');}
            finally{if(undoBatchOpen)context.endBatch?.();replacingMedia=false;query('.rom-undo').disabled=!undo.length;refresh();}
        };
        function applyRelocation(mappings){
            window.ReelsMediaRelocation.remap([context.saved,undo,candidatePool],mappings);
            window.reelsRelocateMediaReferences(mappings);
            library?.relocatePaths?.(mappings);phoneLibrary?.relocatePaths?.(mappings);
            for(const source of temporaryDirectories.values())window.ReelsMediaRelocation.remap(source,mappings);
            for(const [root,paths] of importedLibraryByRoot)importedLibraryByRoot.set(root,new Set([...paths].map(path=>window.ReelsMediaRelocation.remap(path,mappings))));
            importedLibraryPaths=new Set([...importedLibraryPaths].map(path=>window.ReelsMediaRelocation.remap(path,mappings)));
            const imports=[...temporaryImports].map(path=>window.ReelsMediaRelocation.remap(path,mappings));temporaryImports.clear();imports.forEach(path=>temporaryImports.add(path));
            // 文件只是换了位置，画面不变：按新路径保留缩略图，避免每次替换后重新解码整个素材库。
            for(const cache of [posters,aspects]){
                const entries=[...cache].map(([path,value])=>[window.ReelsMediaRelocation.remap(path,mappings),value]);
                cache.clear();entries.forEach(([path,value])=>cache.set(path,value));
            }
            checkedMedia.clear();selectedPath='';selectedGroup='';displayOrders.clear();renderCandidates();scheduleUsedBatchesRefresh();
        }
        // 每次归档都会新增一个批次；连续替换时合并重新扫描，避免批次越多越慢。
        let usedBatchesTimer=null;
        function scheduleUsedBatchesRefresh(){
            clearTimeout(usedBatchesTimer);
            usedBatchesTimer=setTimeout(()=>{usedBatchesTimer=null;if(!disposed)usedBatches?.refresh(true);},3000);
        }
        function flushUsedBatchesRefresh(){
            if(usedBatchesTimer===null)return false;
            clearTimeout(usedBatchesTimer);usedBatchesTimer=null;usedBatches?.refresh(true);return true;
        }
        function scopeCards() {
            if (query('.rom-scope').value === 'selected') return selectedTaskCards(cards,checkedTasks);
            if (query('.rom-scope').value === 'all') return cards;
            if (query('.rom-scope').value === 'current') return [hooks.selected()].filter(Boolean);
            const groupTasks = window._reelsState?.overlayProxy?.getTaskGroupTasks?.() || [];
            const list = cards.filter(card => groupTasks.includes(card.task));
            if (list.length) return list;
            const selected = hooks.selected();
            return selected ? [selected] : [];
        }
        function updateTaskSelectionCount() {
            const count=selectedTaskCards(cards,checkedTasks).length;
            query('.rom-scope option[value="selected"]').textContent=`选定任务（${count}）`;
            taskTools.querySelector('.rom-task-count').textContent=`已选 ${count} / ${cards.length} 个任务`;
            backgroundLibrary?.selectionChanged(count);syncScopeLayers();
        }
        updateTaskSelectionCount();
        // 批量写入：背景列只在配套文字唯一时自动带入，多套文字的跳过并提示。
        async function writeMany(pairs) {
            if(replacingMedia || window._reelsMediaWriteBatchDepth>0)throw new Error('正在处理素材，请稍候');
            hooks.beforeWrite();
            replacingMedia=true;
            const entries=[],skipped=[],skipReasons=[],byCard=new Map();
            for(const pair of pairs){if(!byCard.has(pair.card))byCard.set(pair.card,[]);byCard.get(pair.card).push(pair);}
            context.beginBatch?.();try{
            for(const [card,items] of byCard){
                const prepared=[];let blocked=false;let blockedReason='';
                for(const {path,group,poolKey} of items){
                    const key=poolKey || selectedGroup || group.key;
                    if(!sourceFor(path,key)){blocked=true;blockedReason=`${group.label || group.key}：文件不存在或不可读取（${path}）`;break;}
                    let bundle;
                    if(group.field==='bg' && context.backgroundChoices){const choices=context.backgroundChoices(path);if(choices.length>1){blocked=true;blockedReason=`${group.label || group.key}：有 ${choices.length} 个背景配套方案，请单独选择`;break;}bundle=choices[0];}
                    const value=replacementValue(context,path,group,key,bundle);
                    if(window.ReelsNameBinding?.enabled){
                        const sourceCheck=window.ReelsNameBinding.checkSource(value,group);
                        if(!sourceCheck.allowed){blocked=true;blockedReason=`${group.label || group.key}：${sourceCheck.reason}`;break;}
                    }
                    prepared.push({group,value,path,poolKey:key,before:context.read(card.task,group)});
                }
                if(!blocked && window.ReelsNameBinding?.enabled){
                    const values=window.ReelsNameBinding.entriesFor(context,card.task).map(entry=>{
                        const change=prepared.find(item=>item.group.key===entry.group.key);return change?{group:change.group,value:change.value}:entry;
                    });
                    const check=window.ReelsNameBinding.checkValues(values);if(!check.allowed){blocked=true;blockedReason=check.reason;}
                }
                if(blocked){skipped.push(card.id+1);skipReasons.push(`任务 ${card.id+1}：${blockedReason}`);continue;}
                for(const {group,value,before,path,poolKey} of prepared){
                    const entry={task:card.task,group,value:before,next:value,path,poolKey};entries.push(entry);context.write(card.task,group,value);
                    if(JSON.stringify(pathsOf(context.read(card.task,group),group))!==JSON.stringify(pathsOf(value,group)))throw new Error(`任务 ${card.id+1} · ${group.label || group.key}：素材写入未生效，已撤销本次分配`);
                }
                if(entries.length%30===0)await new Promise(resolve=>setTimeout(resolve,0));
            }
            const changed=entries.filter(entry=>JSON.stringify(pathsOf(entry.value,entry.group))!==JSON.stringify(pathsOf(entry.next,entry.group)));
            if(changed.length && window.ReelsMediaLibrary?.recordUses){
                const usage=window.ReelsMediaLibrary.recordUses(changed.map(entry=>({task:entry.task,paths:pathsOf(entry.next,entry.group),options:{root:unitFor(context,entry.path,entry.poolKey)?.folder?entry.path:''}})));
                changed.forEach((entry,index)=>entry.usage=usage.entries[index].record);await usage.ready;
            }else for(const entry of changed){
                const usage=window.ReelsMediaLibrary?.recordUse?.(entry.task,pathsOf(entry.next,entry.group));entry.usage=usage?.record;await usage?.ready;
            }
            }catch(error){
                for(const entry of entries.slice().reverse()){
                    context.write(entry.task,entry.group,entry.value);
                    if(entry.usage)await window.ReelsMediaLibrary?.cancelUse?.(entry.task,entry.usage);
                }
                throw error;
            }finally{context.endBatch?.();replacingMedia=false;}
            if(entries.length){undo.push(entries);window.dispatchEvent(new CustomEvent('reels-overview-undo-push',{detail:'media'}));query('.rom-undo').disabled=false;}
            if(await window.reelsSaveUnifiedProject?.({wait:true,skipSync:true})===false)throw new Error('任务保存失败');
            const changedCount=entries.filter(entry=>JSON.stringify(pathsOf(entry.value,entry.group))!==JSON.stringify(pathsOf(entry.next,entry.group))).length;
            refresh();return {count:changedCount,unchanged:entries.length-changedCount,skipped,skipReasons};
        }
        function namePlanSummary(pairs) {
            if(!window.ReelsNameBinding?.enabled)return '';
            const owners=new Map();
            for(const pair of pairs){
                const value=replacementValue(context,pair.path,pair.group,pair.poolKey),key=window.ReelsNameBinding.namesOf(value,pair.group).flatMap(name=>window.ReelsNameBinding.match(name))[0];
                if(!key)continue;if(!owners.has(key))owners.set(key,new Set());owners.get(key).add(pair.card.task);
            }
            return '\n名字固定组合：'+[...owners].map(([key,tasks])=>`${key} → ${tasks.size} 个任务`).join('；');
        }
        const skippedText = skipped => skipped.length ? `；任务 ${skipped.join('、')} 存在名字绑定冲突、未命中关键词、配套文字不唯一或素材无法读取，已跳过，请单独检查` : '';
        query('.rom-random-distribute').onclick = async () => {
            const materials=selectedMaterialsInOrder(checkedMedia,displayOrders).filter(item=>sourceFor(item.path,item.poolKey) && batchAllowed(item));
            if(!materials.length)return status('请先勾选要分配的素材或素材套');
            const groups=[...panel.querySelectorAll('.rom-random-layer:checked')].map(input=>groupFor(input.value)).filter(Boolean);
            if(!groups.length)return status('请勾选要分配的覆层媒体层');
            const list=scopeCards();
            if(!list.length)return status('请先勾选右侧目标任务，或选择任务范围');
            const maxUses=Number(query('.rom-max-uses').value);
            if(!Number.isSafeInteger(maxUses) || maxUses<0)return status('最大使用次数请填写 0 或正整数');
            const mode=query('.rom-multi-mode').value, label=mode==='same'?'统一素材':mode==='sequential'?'按顺序':'随机';
            if(mode==='same' && new Set(materials.map(item=>item.path)).size!==1)return status('统一使用一个素材：请只勾选一个素材或素材套');
            const policy=window.ReelsNameBinding?.planner(context,groups,(item,target)=>replacementValue(context,item.path,target,item.poolKey));
            const pairs=multiLayerDistributionPairs(materials,list,groups,{mode,maxUses,...policy});
            if(!pairs.length)return status('没有符合次数上限与名字绑定规则的可分配位置');
            const needed=list.length*groups.length, shortage=needed-pairs.length;
            const uniqueCount=new Set(materials.map(item=>item.path)).size;
            if(!confirm(`把 ${uniqueCount} 个选中素材${label}分配到 ${list.length} 个任务的 ${groups.length} 个媒体层？\n目标层：${groups.map(group=>group.label).join('、')}${namePlanSummary(pairs)}\n每个素材本次最多使用：${maxUses||'不限'}${shortage?`\n次数上限或名字绑定限制，${shortage} 个位置将保留原素材。`:''}`))return;
            const button=query('.rom-random-distribute');button.disabled=true;
            try{
                const result=await writeMany(pairs);
                status(`已${label}分配 ${result.count} 个媒体层位置${shortage?`；${shortage} 个位置因次数上限或名字绑定保留原素材`:''}${result.unchanged?`；${result.unchanged} 个位置原本已是相同素材`:''}${result.skipReasons?.length?'\n'+result.skipReasons.join('\n'):skippedText(result.skipped)}`);
                if(result.skipReasons?.length)window.showToast?.(`部分任务未替换：\n${result.skipReasons.join('\n')}`,'warning',10000);
            }catch(error){status(`分配失败：${error.message}`);window.showToast?.(error.message,'warning');}
            finally{button.disabled=false;}
        };
        function setCheckedTiles(tiles,checked) {
            let count=0;
            for(const tile of tiles){
                const input=tile?.querySelector('.rom-check');if(!input)continue;
                setMediaChecked(checkedMedia,tile.dataset.path,tile.dataset.group,checked);
                input.checked=checked;tile.classList.toggle('checked',checked);count++;
            }
            updateSelectionCount();
            if(query('.rom-only-selected').checked)refresh();
            return count;
        }
        function setCheckedTile(tile,checked) {setCheckedTiles([tile],checked);}
        query('.rom-list').onchange = event => {
            const input=event.target.closest('.rom-check');if(!input)return;
            setCheckedTile(input.closest('.rom-item'),input.checked);
        };
        const backgroundPageActive=()=>!!query('[data-workspace-tab="background"][aria-selected="true"]');
        function updateSelectionCount(){
            const background=backgroundPageActive();
            query('.rom-selection-count').textContent=`已勾选 ${background?backgroundLibrary?.checkedCount || 0:checkedMedia.size} 个${background?'背景':'素材'}`;
        }
        query('.rom-select-all').onclick = () => {
            if(backgroundPageActive()){backgroundLibrary?.selectVisible('all');return;}
            setCheckedTiles([...query('.rom-list').querySelectorAll('.rom-check')].map(input=>input.closest('.rom-item')).filter(tile=>tile && !tile.closest('[hidden]')),true);
        };
        query('.rom-select-clear').onclick = () => {
            if(backgroundPageActive()){backgroundLibrary?.selectVisible('clear');return;}
            checkedMedia.clear();query('.rom-list').querySelectorAll('.rom-check').forEach(input=>input.checked=false);
            query('.rom-list').querySelectorAll('.rom-item.checked').forEach(tile=>tile.classList.remove('checked'));
            query('.rom-selection-count').textContent='已勾选 0 个素材';
            if(query('.rom-only-selected').checked)refresh();
        };
        query('.rom-select-invert').onclick = () => {
            if(backgroundPageActive()){backgroundLibrary?.selectVisible('invert');return;}
            for(const tile of query('.rom-list').querySelectorAll('.rom-item')){
                if(tile.closest('[hidden]'))continue;
                const input=tile.querySelector('.rom-check');if(input)setCheckedTile(tile,!input.checked);
            }
        };
        query('.rom-only-selected').onchange=refresh;
        query('.rom-only-unused').onchange=refresh;
        query('.rom-keyword-grouping').onchange=event=>{try{localStorage.setItem('reels_media_keyword_grouping_v1',String(event.target.checked));}catch(_){}refresh();};
        query('.rom-group').onchange = refresh;panel.querySelectorAll('.rom-random-layer').forEach(input=>input.onchange=renderPair);query('.rom-sort').onchange=()=>{displayOrders.clear();refresh();};query('.rom-search').oninput=refresh;
        query('.rom-size').oninput = () => {
            const size = query('.rom-size').value;
            panel.style.setProperty('--rom-size', `${size}px`);
            query('.rom-size-value').textContent = `${size}px`;
        };
        query('.rom-names').onchange = () => panel.classList.toggle('rom-show-names', query('.rom-names').checked);
        const library=window.ReelsMediaLibrary;
        let libraryBusy=false,libraryQueue=Promise.resolve(),directoryPickerOpen=false, loadedLibrary='', importedLibraryPaths=new Set(),importedLibraryByRoot=new Map(),rulesSignature='';
        const libraryOperation=source=>persistentTools(source).querySelector('[data-library-operation]');
        for(const source of ['library','characters']){
            const output=document.createElement('output');output.dataset.libraryOperation='';output.setAttribute('role','status');output.setAttribute('aria-live','polite');
            output.style.cssText='display:block;white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;color:#c9d5fa';
            persistentTools(source).querySelector('.rom-settings-body').appendChild(output);
        }
        function libraryAction(action,source) {
            const sources=source?[source]:['library','characters'];
            if(libraryBusy)for(const key of sources)libraryOperation(key).textContent='操作已排队，当前读取完成后继续；仍可添加其他目录。';
            const pending=libraryQueue.then(async()=>{
                if(disposed)return;
                libraryBusy=true;
                for(const key of sources){
                    persistentTools(key).setAttribute('aria-busy','true');libraryOperation(key).textContent='正在处理素材库，请稍候…';
                    persistentTools(key).querySelectorAll('button,select').forEach(control=>{if(control!==persistentControl(key,'bind'))control.disabled=true;});
                }
                try{await action();for(const key of sources)if(!disposed)libraryOperation(key).textContent='操作完成';}
                catch(error){if(!disposed){for(const key of sources)libraryOperation(key).textContent=`操作失败：${error.message}`;status(`素材库：${error.message}`);}}
                finally{
                    libraryBusy=false;
                    if(!disposed)for(const key of sources){persistentTools(key).removeAttribute('aria-busy');persistentTools(key).querySelectorAll('button,select').forEach(control=>{if(control!==persistentControl(key,'bind'))control.disabled=false;});}
                }
            });
            libraryQueue=pending.catch(()=>{});return pending;
        }
        async function chooseLibraryDirectories(source){
            if(directoryPickerOpen){status('目录选择窗口已打开，请先完成或取消选择');return;}
            if(!library){status('素材库模块未加载，请重新打开软件');return;}
            const api=window.electronAPI;
            if(!api?.showOpenDialog && !api?.selectDirectories && !api?.selectDirectory){status('读取本地素材库需要桌面版');return;}
            directoryPickerOpen=true;
            for(const key of ['library','characters'])persistentControl(key,'bind').disabled=true;
            try{
                const title=source==='characters'?'选择爆贴人物库文件夹（可多选）':'选择固定素材库文件夹（可多选）';
                let directories;
                if(api.showOpenDialog){const selection=await api.showOpenDialog({title,properties:['openDirectory','multiSelections']});directories=selection?.canceled?[]:selection?.filePaths || [];}
                else directories=api.selectDirectories?await api.selectDirectories():[await api.selectDirectory()].filter(Boolean);
                if(directories?.length && !disposed)await libraryAction(async()=>{
                    for(const directory of directories){if(disposed)return;libraryOperation(source).textContent=`正在读取：${directory}`;await openLibrary(directory,'bind',source);}
                },source);
            }catch(error){if(!disposed){libraryOperation(source).textContent=`选择目录失败：${error.message}`;status(`素材库：${error.message}`);}}
            finally{directoryPickerOpen=false;if(!disposed)for(const key of ['library','characters'])persistentControl(key,'bind').disabled=false;}
        }
        function updateCategories(result) {
            for(const source of ['library','characters']){
                const filter=persistentCategory(source),previous=filter.value;
                const libraries=(library?.opened?.length?library.opened:[result]).filter(item=>librarySource(item.root)===source);
                const roots=libraries.map(item=>item.root);
                const categories=[...new Set(libraries.flatMap(item=>(item.paths || []).filter(file=>librarySource(file)===source).map(file=>libraryCategory(roots,file))).filter(value=>value!==null))].sort((a,b)=>a.localeCompare(b,'zh',{numeric:true}));
                filter.innerHTML='<option value="all">全部素材分类</option>'+categories.map(category=>`<option value="${escape('c:'+category)}">${escape(category || '库根目录散文件')}</option>`).join('');
                filter.value=categories.some(category=>'c:'+category===previous)?previous:'all';filter.hidden=!libraries.length;
            }
        }
        function importLibrary(result) {
            // 每个固定目录只更新自己的候选集，其他固定目录与临时导入保留。
            const otherRoots=[...importedLibraryByRoot].filter(([root])=>root!==result.root);
            importedLibraryPaths=new Set([...(importedLibraryByRoot.get(result.root) || [])].filter(path=>!temporaryImports.has(`unclassified\n${path}`)));
            context.saved.unclassified=(context.saved.unclassified || []).filter(path=>!importedLibraryPaths.has(path));
            for(const path of importedLibraryPaths){
                delete context.saved._units?.[`unclassified\n${path}`];
                checkedMedia.delete(`unclassified\n${path}`);
                if(selectedGroup==='unclassified' && selectedPath===path){selectedPath='';selectedGroup='';}
            }
            const previous=new Set(context.saved.unclassified);
            const source=librarySource(result.root);
            // Resolve each root independently: the visible selector may belong to
            // another library while restore/refresh imports several roots.
            let layout=source==='characters'?'suites':'categories';
            try{layout=localStorage.getItem(`videokit_library_layout:${result.libraryId}`) || layout;}catch(_){}
            // A separately bound child library owns its inventory. Reading it
            // through the parent as well can turn its suites into loose files.
            const paths=libraryImportPaths(result.root,result.paths || [],(library?.opened || []).map(item=>item.root).concat(characterRoots()));
            const imported=importDirectory(context,'unclassified',result.root,paths,layout);
            importedLibraryPaths=new Set((context.saved.unclassified || []).filter(path=>!previous.has(path)));
            importedLibraryByRoot.set(result.root,importedLibraryPaths);
            importedLibraryPaths=new Set([...otherRoots.flatMap(([,paths])=>[...paths]),...importedLibraryPaths]);
            displayOrders.delete('unclassified');
            query('.rom-selection-count').textContent=`已勾选 ${checkedMedia.size} 个素材`;
            updateCategories(result);
            return imported;
        }
        function syncPersistentControls() {
            for(const source of ['library','characters']){
                const libraries=(library?.opened || []).filter(item=>librarySource(item.root)===source),control=persistentControl(source,'select');
                const previous=control.value;
                control.innerHTML='<option value="">请选择素材库</option>'+libraries.map(item=>`<option value="${escape(item.root)}">${escape(item.root)}</option>`).join('');
                control.value=libraries.some(item=>item.root===previous)?previous:libraries.some(item=>item.root===library.active?.root)?library.active.root:libraries[0]?.root || '';
                const result=libraries.find(item=>item.root===control.value);
                persistentTools(source).querySelector('summary').textContent=`${source==='characters'?'爆贴人物库':'固定素材库'} · ${libraries.length} 个目录`;
                persistentControl(source,'info').textContent=libraries.map(item=>item.root).join('\n')+(result?.unsynced?'\n⚠ 使用记录暂存在本机':result?.warning?'\n'+result.warning:'');
                persistentHistory(source).disabled=!libraries.length;
                if(result){
                    let layout='';try{layout=localStorage.getItem(`videokit_library_layout:${result.libraryId}`) || '';}catch(_){}
                    persistentControl(source,'layout').value=['categories','suites','files'].includes(layout)?layout:source==='characters'?'suites':'categories';
                }
            }
        }
        function updateLibrary(result) {
            if(disposed)return;
            const rules=library.bindingRules || result?.bindingRules || {enabled:false,keywords:[]},signature=JSON.stringify(rules);
            if(signature!==rulesSignature && bindingSaveRevision===bindingSavedRevision){rulesSignature=signature;query('.rom-binding-enabled').checked=rules.enabled;query('.rom-binding-keywords').value=rules.keywords.join('\n');renderBindingCaps();rulesEditor.querySelector('summary').textContent=`名字固定组合（共用）· ${rules.enabled?'已启用':'未启用'}`;}
            syncPersistentControls();
            if(result){
                if(loadedLibrary!==result.root){
                    loadedLibrary=result.root;
                    // Remove earlier parent imports before registering the child
                    // under its own layout, including during background restore.
                    for(const ancestor of library?.opened || [])if(result.root.startsWith(ancestor.root.replace(/[/\\]+$/,'')+'/'))importLibrary(ancestor);
                    importLibrary(result);displayOrders.clear();
                }
            }else{loadedLibrary='';for(const source of ['library','characters']){persistentCategory(source).value='all';persistentCategory(source).hidden=true;persistentHistory(source).value='all';}}
            refresh();
        }
        const unsubscribeLibrary=library?.subscribe(updateLibrary);
        async function listLibraries(){if(!disposed)syncPersistentControls();}
        async function openLibrary(directory,action='refresh',source=librarySource(directory)) {
            status('正在读取素材库及历史记录…');
            const wasCharacter=window.ReelsCharacterLibrary?.roots.includes(directory);
            if(source==='characters')window.ReelsCharacterLibrary?.addRoot(directory);
            else if(wasCharacter)window.ReelsCharacterLibrary.removeRoot(directory);
            let result;
            try{result=await library.open(directory,action);}
            catch(error){if(wasCharacter)window.ReelsCharacterLibrary?.addRoot(directory);else window.ReelsCharacterLibrary?.removeRoot(directory);throw error;}
            if(disposed)return;
            if(source==='characters')window.ReelsCharacterLibrary?.addRoot(result.root);
            const imported=importLibrary(result);collapsed.delete('unclassified');refresh();await listLibraries();
            status(result.warning || `素材库已就绪：${imported.unitCount} 个素材组／文件，共 ${result.paths?.length || 0} 个媒体；可按分类与历史筛选`);
        }
        for(const source of ['library','characters']){
            persistentCategory(source).onchange=refresh;persistentHistory(source).onchange=refresh;
            persistentControl(source,'layout').onchange=()=>{
                const result=library?.opened.find(item=>item.root===persistentControl(source,'select').value);if(!result)return;
                try{localStorage.setItem(`videokit_library_layout:${result.libraryId}`,persistentControl(source,'layout').value);}catch(_){}
                importLibrary(result);refresh();
            };
        }
        temporaryHistory.onchange=refresh;
        let bindingSaveTimer,bindingSavePromise=null,bindingSaveRevision=0,bindingSavedRevision=0;
        const bindingSaveStatus=document.createElement('output');bindingSaveStatus.setAttribute('role','status');
        query('.rom-binding-save').before(bindingSaveStatus);
        query('.rom-binding-save').textContent='立即保存／重试';
        async function flushBindingRules(){
            clearTimeout(bindingSaveTimer);
            if(bindingSavePromise){await bindingSavePromise;if(bindingSavedRevision!==bindingSaveRevision)return flushBindingRules();return;}
            if(bindingSavedRevision===bindingSaveRevision)return;
            const revision=bindingSaveRevision,keywords=bindingKeywordList(),enabled=query('.rom-binding-enabled').checked;
            const keywordLimits=Object.fromEntries([...bindingCaps.querySelectorAll('input')].map(input=>[input.dataset.keyword,Number(input.value)]));
            window.ReelsCombinationPlanner.checkLimits({combinations:[]},{keywordLimits});
            bindingSaveStatus.textContent='正在自动保存…';
            bindingSavePromise=(async()=>{
                const result=await library.saveBindingRules(enabled,keywords);
                candidateRules.keywordLimits=keywordLimits;
                if(await window.reelsSaveUnifiedProject?.({wait:true,skipSync:true})===false)throw new Error('关键词已保存，但本批套数上限保存失败，请重试');
                bindingSavedRevision=revision;
                if(!disposed)bindingSaveStatus.textContent=result.warning || '已自动保存';
            })();
            try{await bindingSavePromise;}
            catch(error){if(!disposed)bindingSaveStatus.textContent='自动保存失败：'+error.message;throw error;}
            finally{bindingSavePromise=null;}
            if(bindingSavedRevision!==bindingSaveRevision)return flushBindingRules();
        }
        function scheduleBindingSave(){
            bindingSaveRevision++;bindingSaveStatus.textContent='修改待保存…';clearTimeout(bindingSaveTimer);
            bindingSaveTimer=setTimeout(()=>flushBindingRules().catch(error=>{if(!disposed)bindingSaveStatus.textContent='自动保存失败：'+error.message;}),350);
        }
        rulesEditor.addEventListener('input',scheduleBindingSave);
        query('.rom-binding-enabled').addEventListener('change',scheduleBindingSave);
        query('.rom-binding-save').onclick=()=>{bindingSaveRevision++;flushBindingRules().catch(error=>status(error.message));};
        async function refreshLibraries(source) {
            const activeRoot=library?.active?.root;
            const roots=(library?.opened || []).filter(item=>!source || librarySource(item.root)===source).map(item=>item.root).sort((a,b)=>Number(a===activeRoot)-Number(b===activeRoot));
            if(!roots.length)throw new Error('请先绑定素材库文件夹');
            const failures=[];
            for(const root of roots){if(disposed)return;try{await openLibrary(root);}catch(error){failures.push(`${basename(root)}：${error.message}`);}}
            if(!disposed)status(`已刷新 ${roots.length-failures.length} 个素材库`+(failures.length?`；失败：${failures.join('；')}`:''));
        }
        async function markHistory(clear,source='library') {
            const root=persistentControl(source,'select').value;if(!root)throw new Error('请先绑定素材库文件夹');
            const selected=[...checkedMedia.values()];if(!selected.length)throw new Error('请先勾选要标记的素材或素材套');
            const paths=[...new Set(selected.flatMap(item=>unitFor(context,item.path,item.poolKey)?.files || [item.path]))];
            if(clear && !confirm('清除这些已勾选素材的历史使用标记？当前任务与原始媒体文件不会改变。'))return;
            const result=await library.mark(paths,clear,root);if(disposed)return;
            status(result.warning || (result.marked?`已${clear?'清除历史标记':'标记历史已用'}：${result.marked} 个库内文件`:'所选素材不在当前目录中'));
        }
        for(const source of ['library','characters']){
            persistentControl(source,'bind').onclick=()=>chooseLibraryDirectories(source);
            persistentControl(source,'select').onchange=event=>libraryAction(()=>event.target.value?openLibrary(event.target.value):Promise.resolve(),source);
            persistentControl(source,'refresh').onclick=()=>libraryAction(()=>refreshLibraries(source),source);
            persistentControl(source,'unbind').onclick=()=>libraryAction(async()=>{
                const root=persistentControl(source,'select').value;if(!root)throw new Error('请选择要解除绑定的素材库');
                const paths=importedLibraryByRoot.get(root) || new Set();
                await library.unbind(root);if(source==='characters')window.ReelsCharacterLibrary?.removeRoot(root);
                context.saved.unclassified=(context.saved.unclassified || []).filter(path=>!paths.has(path));importedLibraryByRoot.delete(root);
                for(const path of paths){delete context.saved._units?.[`unclassified\n${path}`];checkedMedia.delete(`unclassified\n${path}`);}
                syncPersistentControls();refresh();status('已解除本机绑定，素材文件与历史记录均保留');
            },source);
            persistentControl(source,'mark').onclick=()=>libraryAction(()=>markHistory(false,source),source);
            persistentControl(source,'clear').onclick=()=>libraryAction(()=>markHistory(true,source),source);
        }
        usedBatches=window.ReelsUsedBatches?.mount(materialList,{
            repair:async roots=>{
                const protectedPaths=(context.groups || []).filter(group=>group.field==='bg' || window.ReelsNameBinding.isPhoneGroup(group)).flatMap(group=>window._reelsState.tasks.flatMap(task=>pathsOf(context.readInventory?context.readInventory(task,group,window._reelsState.tasks.indexOf(task)):context.read(task,group),group)));
                const response=await window.electronAPI.apiCall('batch-used-media',{action:'repair-layout',roots,protectedPaths,recovery:window.reelsCollectUnifiedProjectData?.()});
                if(!response?.success)throw new Error(response?.error || '整理归档位置失败');
                if(response.data.mappings.length){for(const entry of undo)if(entry.archive)window.ReelsMediaRelocation.remap(entry.archive,response.data.mappings);applyRelocation(response.data.mappings);}persistCandidates();return response.data;
            },
            state:archiveBatchState,api:window.electronAPI,escape,mediaSource,save:persistCandidates,hosts:{temporary:moduleTools.temporary},
            candidatePool,
            onCancelAll:()=>{
                for(const key of checkedMedia.keys())if(window.ReelsUsedBatches.isHistorical(key.slice(key.indexOf('\n')+1)))checkedMedia.delete(key);
                for(const history of materialList.querySelectorAll('.rom-source-history')){
                    history.querySelector('summary').textContent='历史已用批次 · 默认不参与匹配';
                    history.querySelector('.rom-hint').textContent='已取消所有历史参与；需要复用时，可逐批开启或全选参与本次匹配。';
                }
            },
            getRoots:()=>{
                const normRoot=value=>String(value || '').replace(/\\/g,'/').replace(/\/+$/,'');
                const persistentRoots=[...(library?.opened || []).map(item=>normRoot(item.root)),...characterRoots().map(normRoot)].filter(Boolean);
                const isPersistentPath=target=>{
                    const normalized=normRoot(target);
                    if(!normalized)return true;
                    if(window.ReelsCharacterLibrary?.hasPath?.(normalized))return true;
                    return persistentRoots.some(root=>normalized===root || normalized.startsWith(root+'/'));
                };
                if(Array.isArray(archiveBatchState.roots)){
                    archiveBatchState.roots=archiveBatchState.roots.filter(entry=>!isPersistentSource(entry?.origin) && !isPersistentPath(entry?.root));
                }
                const roots=[...temporaryDirectories.values()].filter(item=>!isPersistentPath(item.directory)).map(item=>({root:item.directory,origin:'temporary'}));
                if(context.directory && !isPersistentPath(context.directory))roots.push({root:context.directory,origin:'temporary'});
                for(const item of candidatePool)if(!isPersistentSource(item.origin) && String(item.path).replace(/\\/g,'/').includes('/本批已经使用/')){
                    const root=String(item.path).replace(/\\/g,'/').split('/本批已经使用/')[0];
                    if(!isPersistentPath(root))roots.push({root,origin:'temporary'});
                }
                for(const task of tasks)for(const group of context.groups.filter(group=>group.field==='pip' && !window.ReelsNameBinding.isPhoneGroup(group))){
                    const value=context.readInventory?context.readInventory(task,group,window._reelsState.tasks.indexOf(task)):context.read(task,group);
                    for(const file of pathsOf(value,group))if(String(file).replace(/\\/g,'/').includes('/本批已经使用/')){
                        const root=String(file).replace(/\\/g,'/').split('/本批已经使用/')[0];
                        if(!isPersistentPath(root))roots.push({root,origin:'temporary'});
                    }
                }
                return roots;
            },
            register:item=>{
                const unit={path:item.path,root:item.root,folder:item.folder,files:item.files,preview:item.files[0],archiveBatchId:item.archiveBatchId,_archiveOrigin:item.origin,originalFiles:item.originalFiles};
                if(item.folder)unit.value={content:item.files[0],type:image(item.files[0])?'image':'video',media_loop:true,media_folder_path:item.path,media_folder_files:item.files,media_folder_interval:0};
                (context.saved._units ||= {})[`unclassified\n${item.path}`]=unit;
            },
            addCandidates:items=>{
                const paths=new Set(items.map(item=>item.path));
                addCandidateTiles([...materialList.querySelectorAll('[data-used-source] .rom-item,.rom-used-batches .rom-item')].filter(tile=>paths.has(tile.dataset.path)),false);
            },
            isChecked:item=>checkedMedia.has(`unclassified\n${item.path}`),
            onChange:()=>{renderCandidates();refresh();},
            thumbnails:()=>{if(disposed || panel.hidden)return;syncCandidateBadges(materialList,candidatePool);thumbnailLoader?.dispose();thumbnailLoader=window.BatchThumbnailLoader?.hydrate(panel);},
        });
        // Restoring old roots must never lock the directory picker or discard a new click.
        if(library)(async()=>{
            const showRestore=text=>{if(!disposed && !libraryBusy)for(const key of ['library','characters'])libraryOperation(key).textContent=text;};
            showRestore('正在后台恢复素材库绑定，可继续添加目录…');
            try{
                await library.restore({onProgress:event=>showRestore(`正在恢复 ${event.completed+1}/${event.total}：${event.root}\n可继续添加其他目录。`)});
                for(const root of characterRoots())if(!disposed && !library.opened.some(item=>item.root===root))try{await openLibrary(root,'bind','characters');}catch(error){status(`爆贴人物库恢复失败：${error.message}`);}
                if(!disposed){updateLibrary(library.active);await listLibraries();showRestore(library.restoreWarnings?.length?'部分目录无法恢复，可重新添加：\n'+library.restoreWarnings.join('\n'):'素材库绑定恢复完成');}
            }catch(error){showRestore(`自动恢复未完成：${error.message}\n可点击“添加”重新选择目录。`);}
        })();
        function trackTemporary(key,before,explicitFiles=[]) {
            const imported=new Set(explicitFiles);
            for(const path of listPaths(context,key))if(!before.has(path) || imported.has(path) || (unitFor(context,path,key)?.files || []).some(file=>imported.has(file))){
                temporaryImports.add(`${key}\n${path}`);
                for(const item of candidatePool)if(item.path===path)item.origin='temporary';
            }
        }
        async function openCombinationPreview(source,settings,selectedSources=[source]){
            await flushBindingRules();
            selectedSources=[...new Set(selectedSources)];
            if(!selectedSources.length)throw new Error('请至少选择一个素材来源');
            if(selectedSources.length>1)source='pool';
            const previewBatchAllowed=item=>source==='pool' || batchAllowed(item);
            if(!flushUsedBatchesRefresh())usedBatches?.refresh();await usedBatches?.ready();
            const rules=window.ReelsNameBinding;
            if(!rules?.enabled)throw new Error('请先在“名字固定组合”中启用并保存自定义关键词规则');
            const targets=scopeCards().slice();
            if(!targets.length)throw new Error('请先勾选要替换的任务，或在“任务范围”中选择当前任务、当前任务组或本批全部任务');
            if(targets.length>500)throw new Error('一次最多替换 500 个任务，请缩小任务范围');
            const selectedSlots=[...settings.querySelectorAll('[data-pair-slot]:checked')].filter(input=>!input.disabled).map(input=>groupFor(input.value)).filter(group=>!targets.some(({task})=>rules.isIndependentGroup?.(group,task)));
            const slots=window.ReelsPhoneLibrary.pairingSlots(selectedSlots,phoneLibrary?.pairingGroup());
            const wanted=targets.length;let maxUses=Number(settings.querySelector('[data-pair-uses]').value),phoneMaxUses=Number(settings.querySelector('[data-pair-phone-uses]').value),totalMax=Number(settings.querySelector('[data-pair-total]').value);
            let characterMaxUses=candidateRules.characterMaxUses ?? null;
            const selectedRoot=source==='pool'?'all':settings.querySelector('[data-pair-root]').value;
            const selectedOnly=source!=='pool' && settings.querySelector('[data-pair-selected]').checked;let allowRepeated=settings.querySelector('[data-pair-repeat]').checked;
            const draftScope=JSON.stringify({source,selectedSources:[...selectedSources].sort(),slots:slots.map(slot=>slot.key),targets:targets.map(card=>[card.task._batchTabId || '',card.task.id || '',card.id,card.task.fileName || card.name || ''])});
            const draftStore=context.previewDrafts || (context.previewDrafts={});
            const previousDraft=draftStore[source] ? JSON.parse(JSON.stringify(draftStore[source])) : null;
            let savedDraft=draftStore[source]?.scope===draftScope?draftStore[source]:null;
            if(savedDraft?.options){({maxUses,phoneMaxUses,totalMax,allowRepeated}=savedDraft.options);characterMaxUses=savedDraft.options.characterMaxUses ?? characterMaxUses;}
            let sourceLimits=source==='pool'?readSourceQuantityRules(settings,'source',Object.keys(originNames)):{};
            if(source!=='pool' && savedDraft?.options?.sourceLimits)sourceLimits=savedDraft.options.sourceLimits;
            let basisSource=source==='pool'?(settings.querySelector('[data-pair-basis]').value || ''):'';
            let keywordLimits={...(candidateRules.keywordLimits || savedDraft?.options?.keywordLimits || {})};
            if(basisSource)sourceLimits[basisSource]={min:1,max:1};
            const candidates=[],excluded=[];
            if(selectedSources.includes('pool'))for(const item of candidatePool){
                if(!item.files?.length || item.files.some(file=>!mediaSource(file))){excluded.push({...item,reason:'素材文件缺失或不可读取'});continue;}
                const keywords=rules.match(item.folder?item.name:basename(parent(item.path))+' '+item.name);if(!keywords.length){excluded.push({...item,reason:'没有命中共用名字关键词'});continue;}
                const snapshot={saved:{_units:item.unit?{[`unclassified\n${item.path}`]:item.unit}:{}}};
                const values=Object.fromEntries(slots.map(slot=>[slot.key,item.values?.[slot.key] || replacementValue(snapshot,item.path,slot,'unclassified')]));
                candidates.push({...item,keywords,keyword:keywords[0],history:library.historyFor([...item.files,...(item.originalFiles || [])]).count,values});
            }
            for(const tile of selectedSources.filter(key=>key!=='pool').flatMap(key=>[...query(`.rom-source-section[data-source="${key}"]`).querySelectorAll('.rom-item')])){
                const path=tile.dataset.path,poolKey=tile.dataset.group,unit=unitFor(context,path,poolKey);
                if(path.replace(/\\/g,'/').split('/').includes('本批已经使用'))continue;
                const reject=reason=>excluded.push({path,name:basename(path),reason});
                if(!sourceFor(path,poolKey)){reject('素材文件缺失或不可读取');continue;}
                if(selectedOnly && !checkedMedia.has(`${poolKey}\n${path}`)){reject('已开启只用勾选素材，但该素材未勾选');continue;}
                const matches=rules.match(unit?.folder?basename(path):basename(parent(path))+' '+basename(path));if(!matches.length){reject('素材名称未命中自定义关键词');continue;}
                if(selectedRoot!=='all' && !(unit?.files?.length?unit.files:[path]).some(file=>file.replace(/\\/g,'/').startsWith(selectedRoot.replace(/\\/g,'/').replace(/\/+$/,'')+'/')))continue;
                const history=library.historyFor(unit?.files?.length?unit.files:[path]).count;
                candidates.push({id:path,path,poolKey,folder:!!unit?.folder,origin:tile.dataset.origin || tile.closest('[data-source]')?.dataset.source,files:unit?.files?.length?unit.files:[path],name:basename(path),keyword:matches[0],keywords:matches,history,
                    values:Object.fromEntries(slots.map(slot=>[slot.key,replacementValue(context,path,slot,poolKey)]))});
            }
            for(const item of selectedSources.filter(key=>!['pool','library','characters'].includes(key)).flatMap(key=>usedBatches?.items(key) || [])){
                if(!batchAllowed(item) || (selectedRoot!=='all' && item.root!==selectedRoot) || (selectedOnly && !checkedMedia.has(`unclassified\n${item.path}`)))continue;
                const keywords=rules.match(item.folder?item.name:basename(parent(item.path))+' '+item.name);if(!keywords.length)continue;
                candidates.push({...item,poolKey:'unclassified',keywords,keyword:keywords[0],history:library.historyFor([...item.files,...item.originalFiles]).count,
                    values:Object.fromEntries(slots.map(slot=>[slot.key,replacementValue(context,item.path,slot,'unclassified')]))});
            }
            candidates.splice(0,candidates.length,...new Map(candidates.map(item=>[item.id,item])).values());
            candidates.push(...(phoneLibrary?.candidates(slots) || []));
            // 电话候选以当前库、目录和勾选为准，草稿不能把已移出的电话带回来。
            const currentPhoneIds=new Set(candidates.filter(item=>item.phone).map(item=>item.id));
            const phoneDraftInvalid=!!savedDraft?.planned?.combinations?.some(combo=>(combo.pairs || []).some(({item})=>item?.phone && !currentPhoneIds.has(item.id)));
            if(phoneDraftInvalid)savedDraft=null;

            // Keep the chosen media available even if the temporary folder panel was reopened.
            for(const combo of savedDraft?.planned?.combinations || [])for(const {item} of combo.pairs || []){
                if(!previewBatchAllowed(item) || (item.phone || source==='pool') || candidates.some(candidate=>candidate.id===item.id) || !item.files?.length || item.files.some(file=>!mediaSource(file)))continue;
                const keywords=rules.match(item.name);if(!keywords.length)continue;
                candidates.push({...item,keywords,keyword:keywords[0],history:library.historyFor(item.files).count});
            }
            if(slots.some(slot=>rules.isPhoneGroup(slot)) && !candidates.some(item=>item.phone))throw new Error(`电话候选为 0，绑定层：${slots.filter(slot=>rules.isPhoneGroup(slot)).map(slot=>slot.label).join('、')}。请在电话库检查目录、勾选范围及文件名关键词。普通候选 ${candidates.filter(item=>!item.phone).length} 组。`);
            if(!candidates.some(item=>!item.phone))throw new Error('所选来源没有可配对的普通素材。\n'+(excluded.length?Object.entries(excluded.reduce((counts,item)=>{counts[item.reason]=(counts[item.reason]||0)+1;return counts;},{})).map(([reason,count])=>`${count} 组：${reason}`).join('\n'):'请检查已选素材来源、目录筛选，以及是否已读取素材或加入候选池。'));
            const audienceLayers=index=>(targets[index]?.task?.overlays || []).filter(overlay=>!overlay.disabled && ['image','video'].includes(overlay.type) && window.ReelsCombinationPlanner.isAudienceSlot({mediaSlot:overlay.slotKey,label:overlay.slotLabel || overlay.name}));
            const audienceCountForTarget=index=>audienceLayers(index).length;
            const audienceExistingForTarget=index=>audienceLayers(index).filter(overlay=>!slots.some(slot=>slot.mediaSlot && [overlay.slotKey,overlay._templateOverlayId,overlay.id].includes(slot.mediaSlot))).map(overlay=>({slot:{mediaSlot:overlay.slotKey,label:overlay.slotLabel || overlay.name},item:{path:overlay.media_folder_path || overlay.content || '',folder:!!overlay.media_folder_path}}));
            const options={batchQuotas:{...(savedDraft?.options?.batchQuotas || {})},count:wanted,ordinarySlotCount:slots.filter(slot=>!rules.isPhoneGroup(slot)).length,maxUses,phoneMaxUses,characterMaxUses,totalMax,allowRepeated,sourceLimits,basisSource,keywordLimits,includeBasisDetails:false,accept:(item,slot,index,keyword)=>{
                if(!previewBatchAllowed(item))return false;
                if(!(rules.isPhoneGroup(slot)?!!item.phone:!item.phone) || !(item.phone?!!item.values[slot.key]:(item.poolKey==='unclassified' || item.poolKey===slot.key)))return false;
                if(!rules.checkSource(item.values[slot.key],slot).allowed)return false;
                const check=rules.checkValues([{group:slot,value:item.values[slot.key]}]);
                return check.allowed && (!keyword || !check.keys?.length || check.keys.includes(keyword));
            }};
            const capacityIssue=window.ReelsCombinationPlanner.sourceCapacityIssue(candidates,options);
            if(capacityIssue)throw new Error(capacityIssue.message);
            let planned,applying=false,planning=false,previewOpened=false,planningSettingsChanged=false,planningStopped=false;const dialog=document.createElement('dialog');dialog.className='rom-confirm rom-combination-preview rom-plan-rows';
            Object.assign(options,{audienceCountForTarget,audienceExistingForTarget});
            dialog.addEventListener('cancel',event=>{if(applying)event.preventDefault();});
            let mediaObserver;
            const releaseMedia=()=>{
                mediaObserver?.disconnect();
                dialog.querySelectorAll('video').forEach(video=>{video.pause();video.removeAttribute('src');video.load();});
            };
            const showMedia=(tile,files,index)=>{
                const frame=tile.querySelector('[data-pair-media]');
                const old=frame.querySelector('video');
                if(old){mediaObserver?.unobserve(old);old.pause();old.removeAttribute('src');old.load();}
                frame.replaceChildren();
                tile.dataset.fileIndex=String(index);
                const position=tile.querySelector('[data-file-position]');
                position.dataset.position=`${index+1} / ${files.length}`;
                position.dataset.fullLabel=`${position.dataset.position} · ${basename(files[index])}`;
                position.title=basename(files[index]);
                position.textContent=dialog.querySelector('[data-plan-names]').checked?position.dataset.fullLabel:position.dataset.position;
                const src=mediaSource(files[index]);
                if(!src){frame.textContent='文件不存在或不可读取';return;}
                const media=document.createElement(image(files[index])?'img':'video');
                media.crossOrigin='anonymous';
                media.style.cssText='position:absolute;inset:0;display:block;width:100%;height:100%;object-fit:contain;background:#111;border-radius:6px';
                const failed=()=>{frame.replaceChildren();frame.textContent='画面加载失败，请检查文件是否可读取或编码是否支持';};
                media.onerror=failed;
                if(image(files[index])){media.alt=basename(files[index]);media.loading='lazy';media.src=src;}
                else{
                    media.controls=true;media.muted=true;media.playsInline=true;media.preload='none';
                    media.dataset.previewSrc=src+'#t=0.1';
                    media.onplay=()=>dialog.querySelectorAll('video').forEach(other=>{if(other!==media)other.pause();});
                }
                frame.appendChild(media);
                if(!image(files[index])){
                    if(mediaObserver)mediaObserver.observe(media);
                    else{media.preload='metadata';media.src=media.dataset.previewSrc;}
                }
            };
            dialog.style.cssText='position:fixed;inset:4vh 2vw;margin:auto;width:96vw;max-width:1800px;height:92vh;max-height:92vh;display:block;overflow-y:auto;overflow-x:hidden;';
            let savedPreviewColumns=1;
            try{savedPreviewColumns=Number(localStorage.getItem('reels_combination_preview_columns')) || 1;}catch(_){}
            const columns=Math.max(1,Math.min(20,savedPreviewColumns));
            let previewShowNames=false,previewShowPhones=true;
            try{previewShowNames=localStorage.getItem('reels_combination_preview_names')==='true';previewShowPhones=localStorage.getItem('reels_combination_preview_phones')!=='false';}catch(_){}
            dialog.style.setProperty('--pair-columns',String(columns));
            dialog.innerHTML=`<h3>${source==='pool'?'统一候选池':(originNames[source] || '临时文件夹')} · 组合预览</h3><p>将替换 ${targets.length} 个现有任务所选层的素材，保留各任务的文案、布局和名称。确认替换后才记录使用次数。</p><div class="rom-plan-toolbar"><label>布局 <select data-plan-layout aria-label="组合预览布局"><option value="rows" selected>同套素材横排</option><option value="grid">多套并排对比</option></select></label><label>每行 <select data-plan-columns aria-label="组合预览每行卡片数量">${Array.from({length:20},(_,index)=>`<option value="${index+1}" ${index+1===columns?'selected':''}>${index+1}</option>`).join('')}</select> 套</label><label><input data-plan-names type="checkbox" ${previewShowNames?'checked':''}> 显示素材名字</label><label title="仅控制预览显示，电话仍参与匹配与采用"><input data-plan-phones type="checkbox" ${previewShowPhones?'checked':''}> 显示电话层</label><span data-plan-status role="status"></span></div><details data-plan-limits style="flex-shrink:0;padding:8px;border:1px solid #555;border-radius:6px"><summary>配对限制（可直接修改，保留已调整的组合）</summary><div style="display:flex;gap:12px;flex-wrap:wrap;padding-top:8px"><label>素材组本轮上限 <input data-plan-max type="number" min="1" value="${maxUses}" style="width:70px"></label><label>爆贴素材每组本批上限 <input data-plan-character-max type="number" min="0" step="1" placeholder="跟随普通素材" value="${characterMaxUses ?? ''}" style="width:90px"></label><label>电话本轮上限 <input data-plan-phone-max type="number" min="0" value="${phoneMaxUses}" style="width:70px"></label><label>历史累计上限 <input data-plan-total-max type="number" min="0" value="${totalMax}" style="width:70px"></label><label><input data-plan-repeat type="checkbox" ${allowRepeated?'checked':''}>允许重复整套组合</label></div><small>电话和历史上限 0 表示不限。修改只影响后续更换和采用，不会重新排列当前组合。</small>${source==='pool'?`<label>配对依据<select data-plan-basis><option value="">完全随机</option>${Object.entries(originNames).map(([key,label])=>`<option value="${key}" ${key===basisSource?'selected':''}>以${label}为依据，每个用一次</option>`).join('')}</select></label><small>依据来源每套恰好一个、整轮每个只用一次。修改设置保留当前组合，可点击“补齐剩余任务”继续配对，或“全部重新随机”。</small><fieldset><legend>每套组合的来源数量（电话不计入）</legend>${Object.entries(originNames).map(([key,label])=>`<label style="display:inline-flex;gap:5px;margin:6px">${label} 最少 <input data-plan-source-min="${key}" type="number" min="0" value="${sourceLimits[key]?.min || 0}" style="width:55px"> 最多 <input data-plan-source-max="${key}" type="number" min="0" value="${sourceLimits[key]?.max || 0}" style="width:55px"></label>`).join('')}<small>每套数量在最少与最多之间随机；最少 1、最多 2 表示随机用 1 或 2 个。最多 0 表示不限；依据来源固定每套 1 个。修改保留当前组合，点击“全部重新随机”按新范围生成。</small></fieldset>`:''}</details><p data-plan-draft role="status" style="flex-shrink:0;font-size:12px;margin:4px 0;color:#b9d5af"></p><details data-plan-diagnostics><summary>候选素材统计（表格）</summary><div data-plan-details></div></details><label style="flex-shrink:0;font-size:12px;margin:8px 0"><input data-plan-move type="checkbox" checked>确认后按“历史已用批次”中的用后移动开关归档临时／本批素材组；固定素材库、爆贴人物库、电话和背景始终保留原位置</label><div data-plan-list class="rom-plan-grid"></div><div data-plan-progress hidden style="flex-shrink:0;padding:12px;border:1px solid #8582b9;border-radius:8px;background:#24283b"><strong data-plan-phase role="status" aria-live="polite"></strong><progress data-plan-bar style="display:block;width:100%;margin:8px 0" aria-label="当前处理阶段进度"></progress><div data-plan-current style="overflow-wrap:anywhere;font-size:12px"></div><div data-plan-elapsed style="font-size:12px;margin-top:6px"></div></div><p data-plan-error role="alert" style="color:#ffb09f"></p><div class="rom-confirm-actions"><button data-plan-discard>不保存返回</button><button data-plan-close>保存并返回</button><button data-plan-save>保存草稿</button><button data-plan-fill>保留已有组合，补齐剩余任务</button><button data-plan-stop hidden>停止配对</button><button data-plan-reroll>全部重新随机</button><button data-plan-adopt>确认替换当前任务</button></div>`;
            // 操作在视频列表之前，并在本对话框滚动时保持可见。
            const planActions=dialog.querySelector('.rom-confirm-actions');
            planActions.style.cssText='position:sticky;top:0;z-index:10;display:flex;flex-wrap:wrap;justify-content:flex-start;gap:8px;margin:8px 0;padding:10px 0;background:#242631;border-bottom:1px solid #555;';
            dialog.querySelector('.rom-plan-toolbar').after(planActions);
            planActions.after(dialog.querySelector('[data-plan-progress]'),dialog.querySelector('[data-plan-error]'));
            const keywordKeys=[...new Set(candidates.flatMap(item=>item.keywords || [item.keyword]).filter(Boolean))];
            const keywordControls=document.createElement('fieldset');
            keywordControls.innerHTML=`<legend>每个关键词本轮最多配多少套</legend>${keywordKeys.map((key,index)=>`<label style="display:inline-flex;gap:6px;margin:6px">${escape(key)} <input data-plan-keyword-limit="${index}" type="number" min="0" step="1" value="${Number(keywordLimits[key]) || 0}" style="width:75px"> 套</label>`).join('')}<small style="display:block">0 表示不限；修改后可点击“补齐剩余任务”保留已有结果继续配对，或全部重新随机。上限合计不足任务数量时，剩余任务不替换。</small>`;
            dialog.querySelector('[data-plan-limits]').appendChild(keywordControls);
            let adopted=false,discarded=false,saveTimer;
            const saveDraft=(immediate=false)=>{
                if(adopted || discarded || !planned)return true;
                clearTimeout(saveTimer);
                draftStore[source]={version:1,scope:draftScope,at:new Date().toISOString(),options:{maxUses,phoneMaxUses,characterMaxUses,totalMax,allowRepeated,sourceLimits,basisSource,keywordLimits,batchQuotas:options.batchQuotas},
                    layout:dialog.querySelector('[data-plan-layout]').value,move:dialog.querySelector('[data-plan-move]').checked,columns:Number(dialog.querySelector('[data-plan-columns]').value),names:dialog.querySelector('[data-plan-names]').checked,showPhones:dialog.querySelector('[data-plan-phones]').checked,
                    planned:JSON.parse(JSON.stringify(planned))};
                const persist=()=>{
                    const result=window.reelsSaveUnifiedProject?.({immediate:true,skipSync:true});
                    dialog.querySelector('[data-plan-draft]').textContent=result===false?'草稿写入失败，请保持此窗口并重试保存。':'草稿已保存；关闭或重启后，按相同任务范围和媒体层打开可继续。';
                    return result!==false;
                };
                if(immediate)return persist();
                dialog.querySelector('[data-plan-draft]').textContent='正在自动保存草稿…';saveTimer=setTimeout(persist,350);return true;
            };
            if(source==='pool')renderSourceQuantityWeights(dialog,'plan-source',sourceLimits,slots.filter(slot=>!rules.isPhoneGroup(slot)).length);
            const syncLimits=event=>{
                const next={maxUses:Number(dialog.querySelector('[data-plan-max]').value),phoneMaxUses:Number(dialog.querySelector('[data-plan-phone-max]').value),totalMax:Number(dialog.querySelector('[data-plan-total-max]').value),allowRepeated:dialog.querySelector('[data-plan-repeat]').checked,sourceLimits:source==='pool'?readSourceQuantityRules(dialog,'plan-source',Object.keys(originNames)):{}};
                next.characterMaxUses=dialog.querySelector('[data-plan-character-max]').value===''?null:Number(dialog.querySelector('[data-plan-character-max]').value);
                next.keywordLimits=Object.fromEntries(keywordKeys.map((key,index)=>[key,Number(dialog.querySelector(`[data-plan-keyword-limit="${index}"]`).value)]));
                try{window.ReelsCombinationPlanner.checkLimits({combinations:[]},next);}catch(error){dialog.querySelector('[data-plan-error]').textContent=error.message;return;}
                basisSource=source==='pool'?dialog.querySelector('[data-plan-basis]').value:'';next.basisSource=basisSource;if(basisSource)next.sourceLimits[basisSource]={min:1,max:1};
                ({maxUses,phoneMaxUses,characterMaxUses,totalMax,allowRepeated,sourceLimits,keywordLimits}=next);candidateRules.characterMaxUses=characterMaxUses;settings.querySelector('[data-pair-character-uses]').value=characterMaxUses ?? '';Object.assign(options,next);candidateRules.keywordLimits={...keywordLimits};bindingCaps.querySelectorAll('input').forEach(input=>{input.value=keywordLimits[input.dataset.keyword] ?? 0;});
                if(source==='pool'){candidateRules.basisSource=basisSource;settings.querySelector('[data-pair-basis]').value=basisSource;for(const [key,rule] of Object.entries(sourceLimits)){dialog.querySelector(`[data-plan-source-min="${key}"]`).value=rule.min;dialog.querySelector(`[data-plan-source-max="${key}"]`).value=rule.max;}}
                if(source==='pool')for(const [key,rule] of Object.entries(sourceLimits)){candidateRules[key]={...rule};settings.querySelector(`[data-source-min="${key}"]`).value=rule.min;settings.querySelector(`[data-source-max="${key}"]`).value=rule.max;}
                settings.querySelector('[data-pair-uses]').value=maxUses;settings.querySelector('[data-pair-phone-uses]').value=phoneMaxUses;settings.querySelector('[data-pair-total]').value=totalMax;settings.querySelector('[data-pair-repeat]').checked=allowRepeated;
                if(source==='pool'){
                    renderSourceQuantityWeights(settings,'source',sourceLimits,context.groups.length);
                    if(event?.target?.matches('[data-plan-source-min],[data-plan-source-max],[data-plan-basis]'))renderSourceQuantityWeights(dialog,'plan-source',sourceLimits,slots.filter(slot=>!rules.isPhoneGroup(slot)).length);
                }
                updateDiagnostics();
                try{window.ReelsCombinationPlanner.checkLimits(planned,options);dialog.querySelector('[data-plan-error]').textContent='设置已更新，已调好的组合保持不变；可点击“保留已有组合，补齐剩余任务”继续配对。';}
                catch(error){dialog.querySelector('[data-plan-error]').textContent=error.message;}
                saveDraft();
            };
            if(source==='pool')dialog.querySelector('[data-plan-basis]').onchange=syncLimits;
            for(const selector of ['max','character-max','phone-max','total-max','repeat'])dialog.querySelector(`[data-plan-${selector}]`).onchange=syncLimits;
            dialog.querySelector('[data-plan-limits]').addEventListener('change',event=>{if(event.target.matches('[data-plan-source-min],[data-plan-source-max],[data-plan-source-weight],[data-plan-keyword-limit]'))syncLimits(event);});
            dialog.querySelector('[data-plan-save]').onclick=()=>saveDraft(true);
            dialog.querySelector('[data-plan-move]').onchange=()=>saveDraft();
            function readBatchQuotas(){
                const quotas={};
                for(const input of dialog.querySelectorAll('[data-batch-quota-key]')){
                    if(input.validity?.badInput)throw new Error('指定数量请输入 0 或正整数');
                    if(input.value.trim()!=='')quotas[input.dataset.batchQuotaKey]=Number(input.value);
                }
                window.ReelsCombinationPlanner.validateBatchQuotas(quotas);return quotas;
            }
            let availabilityCache,diagnosticsRun=0;
            const diagnosticsSignature=()=>JSON.stringify({maxUses,phoneMaxUses,characterMaxUses,totalMax,sourceLimits,basisSource,keywordLimits});
            const updateDiagnostics=(includeDetails=false)=>{
                dialog.querySelector('[data-plan-status]').textContent=`目标 ${wanted} 套，当前已配好 ${planned.combinations.length} 套，未配好 ${planned.shortage} 套。`;
                let failure=dialog.querySelector('[data-plan-failure]');
                if(!failure){failure=document.createElement('output');failure.dataset.planFailure='';failure.setAttribute('role','alert');failure.style.cssText='display:block;white-space:pre-wrap;color:#ffc3ab;border:1px solid #9b665a;padding:10px;font-size:12px;max-height:210px;overflow:auto;flex-shrink:0';dialog.querySelector('[data-plan-list]').before(failure);}
                failure.textContent=pairingFailureDetails(planned,candidates,slots,options,excluded);failure.hidden=!planned.shortage;

                let report=dialog.querySelector('[data-plan-report]');
                if(!report){
                    report=document.createElement('details');report.dataset.planReport='';report.open=true;
                    report.innerHTML='<summary>配对结果报告 · 关键词套数与电话组使用次数</summary><div data-plan-report-body></div>';
                    dialog.querySelector('[data-plan-diagnostics]').before(report);
                    report.addEventListener('input',event=>{
                        if(!event.target.matches('[data-batch-quota-key]'))return;
                        try{
                            const quotas=readBatchQuotas();options.batchQuotas=quotas;saveDraft();
                            report.querySelector('[data-batch-quota-status]').textContent='数量已设置，点击“按数量调整并补齐”更新预览；尚未替换任务。';
                            report.querySelectorAll('[data-batch-quota-apply]').forEach(button=>button.disabled=false);
                        }catch(error){report.querySelector('[data-batch-quota-status]').textContent=error.message;report.querySelectorAll('[data-batch-quota-apply]').forEach(button=>button.disabled=true);}
                    });
                    report.addEventListener('click',async event=>{
                        if(event.target.closest('[data-batch-quota-clear]')){if(planning || applying)return;options.batchQuotas={};updateDiagnostics();saveDraft();return;}
                        if(!event.target.closest('[data-batch-quota-apply]') || planning || applying)return;
                        try{
                            options.batchQuotas=readBatchQuotas();
                            await computePlan(async()=>{planned=await window.ReelsCombinationPlanner.rebalanceBatchAsync(planned,candidates,slots,options,planScheduling);});
                            await render(true);saveDraft();
                            dialog.querySelector('[data-plan-error]').textContent=planned.shortage?`按指定数量已匹配 ${planned.combinations.length} 套，还缺 ${planned.shortage} 套。请检查素材、关键词、每套来源和使用上限，或降低指定数量；未替换任务。`:'已按指定数量调整并补齐，确认替换后生效。';
                        }catch(error){dialog.querySelector('[data-plan-error]').textContent=error.message;}
                    });
                }
                report.querySelector('[data-plan-report-body]').innerHTML=combinationReportHtml(planned,candidates,options.batchQuotas);
                const details=dialog.querySelector('[data-plan-details]');
                if(includeDetails!==true){
                    if(source==='pool' && availabilityCache?.signature!==diagnosticsSignature()){
                        details.innerHTML='<p>展开后计算候选素材统计，不影响组合预览和采用。</p>';
                        if(dialog.querySelector('[data-plan-diagnostics]').open)queueDiagnostics();
                        return;
                    }
                }
                const expandedStats=new Set([...details.querySelectorAll('[data-stat-table][open]')].map(node=>node.dataset.statTable));
                if(source==='pool'){
                    planned.basis=window.ReelsCombinationPlanner.basisDetails(planned,candidates,slots,options);
                    const signature=diagnosticsSignature();
                    if(availabilityCache?.signature!==signature)return;
                    const eligibility=new Map(availabilityCache.items.map(item=>[item.id,item]));
                    const entries=[...candidates.map(item=>({...item,available:eligibility.get(item.id)?.available || false,reason:eligibility.get(item.id)?.reason || ''})),
                        ...excluded.map(item=>({...item,keywords:rules.match(item.folder?item.name:basename(parent(item.path))+' '+item.name),available:false}))];
                    const unique=[...new Map(entries.map(item=>[item.id,item])).values()];
                    const sources={...originNames,phone:'电话库'};
                    const origin=item=>item.phone?'phone':item.origin;
                    const stats=items=>{const matched=items.filter(item=>item.available).length,selected=items.filter(item=>planned.uses[item.id]).length;return [items.length,matched,items.length-matched,selected,items.length-selected];};
                    const cells=values=>values.map((value,index)=>`<td class="${index===2 && value?'rom-stat-blocked':''}">${value} 个</td>`).join('');
                    const headers='<th>候选总数</th><th>可用于匹配</th><th>不能匹配</th><th>随机匹配已用</th><th>随机匹配未用</th>';
                    const table=(head,body,includeCounts=true)=>`<table class="rom-candidate-stats"><thead><tr>${head}${includeCounts?headers:''}</tr></thead><tbody>${body}</tbody></table>`;
                    const sourceRows=Object.entries(sources).map(([key,label])=>`<tr><th>${escape(label)}</th>${cells(stats(unique.filter(item=>origin(item)===key)))}</tr>`).join('');
                    const keys=[...new Set(unique.flatMap(item=>item.keywords?.length?item.keywords:['未命中关键词']))];
                    const keywordRows=keys.map(key=>{
                        const items=unique.filter(item=>key==='未命中关键词'?!item.keywords?.length:item.keywords?.includes(key));
                        return `<tr class="rom-stat-total"><th>${escape(key)}</th><th>小计</th>${cells(stats(items))}</tr>`+Object.entries(sources).map(([originKey,label])=>`<tr><th>${escape(key)}</th><th>${escape(label)}</th>${cells(stats(items.filter(item=>origin(item)===originKey)))}</tr>`).join('');
                    }).join('');
                    const blocked=unique.filter(item=>!item.available);
                    details.innerHTML=`<style>.rom-candidate-stats{width:100%;border-collapse:collapse;font-size:12px;margin:8px 0 16px}.rom-candidate-stats th,.rom-candidate-stats td{border:1px solid #555c70;padding:7px 10px;text-align:left;white-space:nowrap}.rom-candidate-stats thead,.rom-stat-total{background:#303647}.rom-candidate-stats td{text-align:right;font-variant-numeric:tabular-nums}.rom-candidate-stats .rom-stat-blocked{color:#ffb09f}.rom-stats-caption{font-size:12px;color:#c9c6db;margin:8px 0}</style><details data-stat-table="source" ${expandedStats.has('source')?'open':''}><summary>按来源统计</summary>${table('<th>素材来源</th>',sourceRows+`<tr class="rom-stat-total"><th>合计（去重）</th>${cells(stats(unique))}</tr>`)}</details><details data-stat-table="keyword" ${expandedStats.has('keyword')?'open':''}><summary>按关键词和来源统计</summary>${table('<th>关键词</th><th>素材来源</th>',keywordRows)}<p class="rom-stats-caption">可用于匹配：按当前设置能找到整套配套。随机匹配已用：当前预览已经采用的不同素材数。多关键词素材会分别计入对应关键词，来源合计不重复计数。</p></details><details><summary>查看不能匹配的素材和原因（${blocked.length} 个）</summary>${table('<th>来源</th><th>素材名字</th><th>不能匹配原因</th>',blocked.map(item=>`<tr><td>${escape(sources[origin(item)])}</td><td style="white-space:normal;overflow-wrap:anywhere">${escape(item.name)}</td><td style="white-space:normal">${escape(item.reason)}</td></tr>`).join(''),false)}</details>`;
                    if(planned.basis)details.innerHTML+=`<details style="margin-top:10px"><summary>查看未配入组合的依据素材（${planned.basis.unmatched.length} 个）</summary><table class="rom-candidate-stats"><thead><tr><th>素材名字</th><th>关键词</th><th>原因</th></tr></thead><tbody>${planned.basis.unmatched.map(item=>`<tr><td style="white-space:normal">${escape(item.name)}</td><td>${escape(item.keys.join('、'))}</td><td style="white-space:normal">${escape(item.reasons.join('；'))}</td></tr>`).join('')}</tbody></table></details>`;
                }else{
                    details.innerHTML=`<table class="rom-candidate-stats" style="width:100%;text-align:left"><thead><tr><th>关键词</th><th>媒体层</th><th>候选总数</th><th>剩余可用</th><th>本轮次数已满</th><th>历史次数已满</th></tr></thead><tbody>${(planned.diagnostics || []).flatMap(entry=>entry.slots.map(slot=>`<tr><td>${escape(entry.keyword)}</td><td>${escape(slot.label)}</td><td>${slot.total} 个</td><td>${slot.available} 个</td><td>${slot.roundLimited} 个</td><td>${slot.historyLimited} 个</td></tr>`)).join('')}</tbody></table>`;
                }
            };
            const queueDiagnostics=async()=>{
                const run=++diagnosticsRun,signature=diagnosticsSignature(),details=dialog.querySelector('[data-plan-details]');
                if(source!=='pool' || availabilityCache?.signature===signature){updateDiagnostics(true);return;}
                const items=[],snapshot={...options};
                try{
                    for(let index=0;index<candidates.length;index++){
                        if(run!==diagnosticsRun || !dialog.open || !dialog.querySelector('[data-plan-diagnostics]').open)return;
                        details.textContent=`正在统计候选素材：${index} / ${candidates.length}（可收起停止）`;
                        await new Promise(resolve=>setTimeout(resolve,0));
                        if(run!==diagnosticsRun || !dialog.open || signature!==diagnosticsSignature())return;
                        items.push(...window.ReelsCombinationPlanner.availability(candidates,slots,snapshot,[candidates[index]]));
                    }
                    if(run!==diagnosticsRun || signature!==diagnosticsSignature())return;
                    availabilityCache={signature,items};updateDiagnostics(true);
                }catch(error){details.textContent='统计失败：'+error.message;}
            };
            dialog.querySelector('[data-plan-diagnostics]').addEventListener('toggle',()=>{
                if(dialog.querySelector('[data-plan-diagnostics]').open)queueDiagnostics();else diagnosticsRun++;
            });
            const planScheduling={
                isCancelled:()=>planningStopped?'配对已停止，原有预览和任务保持不变':planningSettingsChanged?'配对设置已改变，旧计算已停止，请重新点击随机匹配并预览':disposed || (previewOpened && !dialog.open),
                onProgress:({completed,total,matched,attempt})=>{
                    if(total!==wanted)return;
                    const text=`正在配对 ${completed} / ${total} 个任务，已配好 ${matched} 套（第 ${attempt} 轮）…`;
                    settings.querySelector('[data-pair-feedback]').textContent=text;
                    if(dialog.open)dialog.querySelector('[data-plan-status]').textContent=text;
                    status(text);
                },
            };
            const computePlan=async action=>{
                if(planning)return;
                planning=true;planningSettingsChanged=false;planningStopped=false;
                cancelActivePlanning=()=>{planningStopped=true;};
                const stopButtons=[...root.querySelectorAll('[data-pair-stop]'),dialog.querySelector('[data-plan-stop]')];
                stopButtons.forEach(button=>{button.hidden=false;button.disabled=false;button.textContent='停止配对';button.onclick=()=>{cancelActivePlanning?.();button.disabled=true;button.textContent='正在停止…';};});
                const settingsChanged=()=>{planningSettingsChanged=true;};
                root.addEventListener('change',settingsChanged);
                const buttons=[...dialog.querySelectorAll('[data-plan-reroll],[data-plan-fill],[data-plan-adopt],[data-batch-quota-key],[data-batch-quota-apply],[data-batch-quota-clear]')];
                buttons.forEach(button=>button.disabled=true);
                try{return await action();}
                finally{root.removeEventListener('change',settingsChanged);planning=false;cancelActivePlanning=null;stopButtons.forEach(button=>button.hidden=true);buttons.forEach(button=>button.disabled=false);if(planned && previewOpened && !disposed)updateDiagnostics();}
            };
            const render=async(keep=false)=>{
                if(planning)return;
                const previous=planned?.combinations.map(combo=>combo.signature).sort().join('|');let changed=false;
                if(!keep)await computePlan(async()=>{
                    // Only rerolls need another draw; never repeat an empty first preview eight times.
                    for(let attempt=0;attempt<(previous?3:1);attempt++){
                        planned=await window.ReelsCombinationPlanner.planAsync(candidates,slots,options,planScheduling);
                        changed=previous!==planned.combinations.map(combo=>combo.signature).sort().join('|');
                        if(changed || !planned.combinations.length)break;
                    }
                });
                dialog.querySelector('[data-plan-error]').textContent=!keep && previous && !changed?'当前次数和关键词限制下未找到另一组结果，可增加素材或放宽次数限制。':'';
                releaseMedia();
                updateDiagnostics();
                const previewTargets=planned.combinations.map((combo,index)=>targets[combo.targetIndex ?? index]);
                const list=dialog.querySelector('[data-plan-list]');
                list.innerHTML=planned.combinations.map((combo,index)=>`<article class="rom-plan-card"><header><strong>任务 ${previewTargets[index].id+1} · ${escape(combo.keyword)}</strong><div class="rom-plan-task-name" title="${escape(previewTargets[index].name || previewTargets[index].task.fileName || '')}">${escape(previewTargets[index].name || previewTargets[index].task.fileName || '')}</div><div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap"><select data-combo-keyword aria-label="任务 ${previewTargets[index].id+1} 的新关键词" style="min-width:0;max-width:100%"><option value="">随机换其他关键词</option>${[...new Set(candidates.flatMap(item=>item.keywords || [item.keyword]))].filter(key=>key && key!==combo.keyword).map(key=>`<option value="${escape(key)}">${escape(key)}</option>`).join('')}</select><button data-combo-random="${index}" title="更换本组合全部媒体，其他组合保留">整组换关键词</button></div></header><div class="rom-plan-pairs" style="--pair-slots:${combo.pairs.length}">${combo.pairs.map(({slot,item},pairIndex)=>`<div data-pair-tile data-pair-phone="${!!item.phone}" data-combo="${index}" data-pair="${pairIndex}" class="rom-plan-tile"><strong title="${escape(slot.label)}">${escape(slot.label)}</strong><div data-pair-media></div><div class="rom-plan-file-nav"><button data-file-step="-1" aria-label="上一个素材" ${item.files.length<2?'disabled':''}>‹</button><small data-file-position style="flex:1;min-width:0"></small><button data-file-step="1" aria-label="下一个素材" ${item.files.length<2?'disabled':''}>›</button></div><p class="rom-plan-material-name" title="${escape(item.name)}">${escape(item.name)}</p><small data-plan-origin title="${escape(materialSourceInfo(item).title)}">${materialSourceInfo(item).html}</small><small data-plan-usage>历史 ${item.history} 次 · 本轮跨套使用 ${planned.uses[item.id]} 次</small><button data-pair-random style="display:block;width:100%;margin-top:8px;padding:6px 4px;font-size:11px" aria-label="随机更换任务 ${previewTargets[index].id+1} 的${escape(slot.label)}">随机更换</button><button data-pair-pick style="display:block;width:100%;margin-top:6px;padding:6px 4px;font-size:11px" aria-label="选择任务 ${previewTargets[index].id+1} 的${escape(slot.label)}配套素材">选择配套素材</button></div>`).join('')}</div></article>`).join('');
                if(window.IntersectionObserver)mediaObserver=new IntersectionObserver(entries=>{
                    for(const {target,isIntersecting} of entries){
                        if(isIntersecting && !target.getAttribute('src')){target.preload='metadata';target.src=target.dataset.previewSrc;}
                        else if(!isIntersecting && target.getAttribute('src')){target.pause();target.removeAttribute('src');target.load();}
                    }
                },{root:dialog,rootMargin:'100px'});
                list.querySelectorAll('[data-pair-tile]').forEach(tile=>{
                    const {item}=planned.combinations[Number(tile.dataset.combo)].pairs[Number(tile.dataset.pair)];
                    showMedia(tile,item.files,0);
                });
                syncPreviewVisibility(dialog);saveDraft();
                dialog.querySelector('[data-plan-fill]').disabled=!planned.shortage;
                dialog.querySelector('[data-plan-adopt]').disabled=!planned.combinations.length;
                dialog.querySelector('[data-plan-adopt]').textContent=planned.shortage?`先采用已配出的 ${planned.combinations.length} 套（其余任务保留）`:`确认替换 ${targets.length} 个任务的素材`;
            };
            const applyPreviewLayout=()=>{
                const rows=dialog.querySelector('[data-plan-layout]').value!=='grid';
                dialog.classList.toggle('rom-plan-rows',rows);
                const columns=Math.max(1,Math.min(20,Number(dialog.querySelector('[data-plan-columns]').value)||1));
                dialog.querySelector('[data-plan-columns]').disabled=false;
                dialog.style.setProperty('--pair-columns',String(columns));
                dialog.classList.toggle('rom-plan-multi',columns>1);
            };
            dialog.querySelector('[data-plan-layout]').onchange=()=>{applyPreviewLayout();saveDraft();};
            dialog.querySelector('[data-plan-columns]').onchange=event=>{applyPreviewLayout();try{localStorage.setItem('reels_combination_preview_columns',event.target.value);}catch(_){}saveDraft();};
            dialog.querySelector('[data-plan-names]').onchange=event=>{
                syncPreviewVisibility(dialog);saveDraft();
                try{localStorage.setItem('reels_combination_preview_names',String(event.target.checked));}catch(_){}
            };
            dialog.querySelector('[data-plan-phones]').onchange=event=>{
                syncPreviewVisibility(dialog);saveDraft();
                try{localStorage.setItem('reels_combination_preview_phones',String(event.target.checked));}catch(_){}
            };
            function applyPairChoice(tile,comboIndex,pairIndex,itemId){
                        planned=itemId===undefined?window.ReelsCombinationPlanner.replacePair(planned,candidates,comboIndex,pairIndex,options):window.ReelsCombinationPlanner.selectPair(planned,candidates,comboIndex,pairIndex,itemId,options);
                        updateDiagnostics();saveDraft();
                        const {item}=planned.combinations[comboIndex].pairs[pairIndex];
                        tile.closest('.rom-plan-card').querySelector('header>strong').textContent=`任务 ${targets[planned.combinations[comboIndex].targetIndex ?? comboIndex].id+1} · ${planned.combinations[comboIndex].keyword}`;
                        showMedia(tile,item.files,0);
                        const name=tile.querySelector('.rom-plan-material-name');name.textContent=item.name;name.title=item.name;
                        const origin=tile.querySelector('[data-plan-origin]');if(origin){const info=materialSourceInfo(item);origin.innerHTML=info.html;origin.title=info.title;}
                        tile.querySelectorAll('[data-file-step]').forEach(control=>{control.disabled=item.files.length<2;});
                        dialog.querySelectorAll('[data-pair-tile]').forEach(other=>{
                            const {item:material}=planned.combinations[Number(other.dataset.combo)].pairs[Number(other.dataset.pair)];
                            other.querySelector('[data-plan-usage]').textContent=`历史 ${material.history} 次 · 本轮跨套使用 ${planned.uses[material.id]} 次`;
                        });
                        dialog.querySelector('[data-plan-error]').textContent=`已更换任务 ${targets[planned.combinations[comboIndex].targetIndex ?? comboIndex].id+1} 的${planned.combinations[comboIndex].pairs[pairIndex].slot.label}，其他媒体保持不变；确认替换后生效。`;
            }
            function openPairPicker(tile,comboIndex,pairIndex){
                const combo=planned.combinations[comboIndex],slot=combo.pairs[pairIndex].slot;
                const picker=document.createElement('dialog');picker.className='rom-confirm rom-material-picker';
                picker.style.cssText='position:fixed;inset:3vh 3vw;margin:auto;width:94vw;max-width:1400px;height:90vh;max-height:90vh;overflow:auto;box-sizing:border-box;background:#242631;color:#eee;border:1px solid #8b89bc;border-radius:10px;padding:16px';
                const references=combo.pairs.filter((_,index)=>index!==pairIndex);
                picker.innerHTML=`<h3>选择配套素材 · ${escape(slot.label)}</h3><details><summary>配套依据：同套其他素材的名字关键词</summary>${references.map(({slot,item})=>`<p>${escape(slot.label)}：${escape(item.name)}</p>`).join('')}</details><div style="display:flex;gap:12px;flex-wrap:wrap;margin:12px 0"><label>本轮使用<select data-picker-round><option value="all">全部素材</option><option value="unused">本轮未用过</option><option value="used">本轮已用过</option></select></label><label>历史使用<select data-picker-history><option value="all">全部历史状态</option><option value="unused">历史未用过</option><option value="used">历史已用过</option></select></label><label>素材来源<select data-picker-source><option value="all">全部来源</option>${Object.entries(originNames).map(([key,label])=>`<option value="${key}">${label}</option>`).join('')}<option value="phone">电话库</option></select></label><label>搜索名字<input data-picker-search type="search" placeholder="输入素材名字"></label><label style="display:inline-flex;align-items:center;gap:6px"><input data-picker-adoptable type="checkbox">仅显示可直接采用</label><button data-picker-close>关闭</button></div><p data-picker-count role="status"></p><p data-picker-error role="alert" style="color:#ffb09f"></p><div data-picker-grid style="display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:12px;align-items:start"></div>`;
                const q=selector=>picker.querySelector(selector);let observer,choices=[];
                function release(){observer?.disconnect();picker.querySelectorAll('video').forEach(video=>{video.pause();video.removeAttribute('src');video.load();});}
                function paint(){
                    release();choices=window.ReelsCombinationPlanner.pairChoices(planned,candidates,comboIndex,pairIndex,options).map(choice=>({...choice,canAdopt:!!choice.allowed && choice.item.files.length>0 && choice.item.files.every(file=>!!mediaSource(file))}));
                    const round=q('[data-picker-round]').value,history=q('[data-picker-history]').value,source=q('[data-picker-source]').value,search=q('[data-picker-search]').value.trim().toLocaleLowerCase();
                    const onlyAdoptable=q('[data-picker-adoptable]').checked;
                    const shown=choices.filter(choice=>(!onlyAdoptable || choice.canAdopt) && (round==='all'||(round==='used'?choice.roundUses>0:!choice.roundUses)) && (history==='all'||(history==='used'?choice.history>0:!choice.history)) && (source==='all'||(choice.item.phone?'phone':choice.item.origin)===source) && choice.item.name.toLocaleLowerCase().includes(search));
                    q('[data-picker-count]').textContent=`找到 ${choices.length} 个同关键词配套素材，当前显示 ${shown.length} 个，可直接采用 ${shown.filter(choice=>choice.canAdopt).length} 个。`;
                    q('[data-picker-grid]').innerHTML=shown.map(choice=>{
                        const {item}=choice,index=choices.indexOf(choice),path=item.files[0],src=mediaSource(path);
                        const thumb=!src?'<div>文件不可读取</div>':image(path)?`<img crossorigin="anonymous" loading="lazy" src="${escape(src)}" alt="${escape(item.name)}" style="width:100%;aspect-ratio:9/16;object-fit:contain;background:#111">`:`<video crossorigin="anonymous" data-picker-src="${escape(src)}#t=0.1" muted controls preload="none" style="width:100%;aspect-ratio:9/16;object-fit:contain;background:#111"></video>`;
                        return `<article style="min-width:0;border:1px solid #555;border-radius:8px;padding:8px;overflow-wrap:anywhere">${thumb}<strong style="display:block;margin:7px 0">${escape(item.name)}</strong><small style="display:block">${materialSourceInfo(item).html} · 配套关键词：${escape(choice.keyword)}</small>${item.phone?`<small title="${escape(parent(item.path || item.files[0]))}" style="display:block;overflow-wrap:anywhere">来源文件夹：${escape(basename(parent(item.path || item.files[0])))}</small>`:''}<small style="display:block;margin:7px 0">历史用过 ${choice.history} 次 · 本轮用过 ${choice.roundUses} 次</small>${choice.reason?`<p style="color:#ffb09f;font-size:12px">${escape(choice.reason)}</p>`:''}<button data-picker-use="${index}" style="width:100%" ${!choice.canAdopt?'disabled':''}>采用这个素材</button></article>`;
                    }).join('') || '<p>没有符合筛选的配套素材，可以切换使用状态或清空搜索。</p>';
                    if(window.IntersectionObserver)observer=new IntersectionObserver(entries=>entries.forEach(({target,isIntersecting})=>{if(isIntersecting && !target.getAttribute('src')){target.preload='metadata';target.src=target.dataset.pickerSrc;}else if(!isIntersecting && target.getAttribute('src')){target.pause();target.removeAttribute('src');target.load();}}),{root:picker,rootMargin:'150px'});
                    picker.querySelectorAll('video').forEach(video=>{video.onplay=()=>picker.querySelectorAll('video').forEach(other=>{if(other!==video)other.pause();});if(observer)observer.observe(video);else{video.preload='metadata';video.src=video.dataset.pickerSrc;}});
                }
                picker.querySelectorAll('select').forEach(input=>input.onchange=paint);q('[data-picker-adoptable]').onchange=paint;q('[data-picker-search]').oninput=paint;
                q('[data-picker-close]').onclick=()=>picker.close();
                q('[data-picker-grid]').onclick=event=>{const button=event.target.closest('[data-picker-use]');if(!button)return;try{const choice=choices[Number(button.dataset.pickerUse)];if(!choice?.item.files.every(file=>mediaSource(file)))throw new Error('素材文件已不可读取，请刷新素材后重试');applyPairChoice(tile,comboIndex,pairIndex,choice.item.id);picker.close();}catch(error){q('[data-picker-error]').textContent=error.message;}};
                const disposePicker=()=>{release();picker.remove();};
                picker.onclose=()=>{disposePicker();const index=handlers.indexOf(disposePicker);if(index>=0)handlers.splice(index,1);};handlers.push(disposePicker);
                document.body.appendChild(picker);picker.showModal();paint();
            }
            dialog.querySelector('[data-plan-list]').onclick=async event=>{
                if(applying || planning)return;
                const whole=event.target.closest('[data-combo-random]');
                if(whole){
                    const comboIndex=Number(whole.dataset.comboRandom),keyword=whole.closest('.rom-plan-card').querySelector('[data-combo-keyword]').value;
                    try{
                        await computePlan(async()=>{planned=await window.ReelsCombinationPlanner.replaceCombinationAsync(planned,candidates,comboIndex,options,planScheduling,keyword);});
                        await render(true);
                        dialog.querySelector('[data-plan-error]').textContent=`已将本组合全部媒体换成「${planned.combinations[comboIndex].keyword}」配套素材；确认替换后生效。`;
                    }catch(error){dialog.querySelector('[data-plan-error]').textContent=error.message;}
                    return;
                }
                const button=event.target.closest('[data-file-step],[data-pair-random],[data-pair-pick]');if(!button)return;
                const tile=button.closest('[data-pair-tile]');
                const comboIndex=Number(tile.dataset.combo),pairIndex=Number(tile.dataset.pair);
                if(button.hasAttribute('data-pair-pick')){openPairPicker(tile,comboIndex,pairIndex);return;}
                if(button.hasAttribute('data-pair-random')){
                    try{
                        applyPairChoice(tile,comboIndex,pairIndex);
                    }catch(error){dialog.querySelector('[data-plan-error]').textContent=error.message+'；已调整的组合已保留。可展开上方配对限制，修改后再次点击此媒体的随机更换。';dialog.querySelector('[data-plan-limits]').open=true;saveDraft();}
                    return;
                }
                const {item}=planned.combinations[comboIndex].pairs[pairIndex];
                showMedia(tile,item.files,(Number(tile.dataset.fileIndex)+Number(button.dataset.fileStep)+item.files.length)%item.files.length);
            };
            dialog.querySelectorAll('[data-plan-discard]').forEach(button=>{button.onclick=()=>{
                if(applying || adopted)return;
                clearTimeout(saveTimer);
                // 自动保存可能已经覆盖旧草稿；放弃时恢复进入预览前的记录。
                if(previousDraft)draftStore[source]=JSON.parse(JSON.stringify(previousDraft));
                else delete draftStore[source];
                const result=window.reelsSaveUnifiedProject?.({immediate:true,skipSync:true});
                if(result===false){
                    dialog.querySelector('[data-plan-error]').textContent='撤回预览草稿保存失败，请重试“不保存返回”。';
                    return;
                }
                discarded=true;
                dialog.close();
                status('已放弃本次组合预览，保留进入前的草稿；任务和素材未改动');
            };});
            dialog.querySelector('[data-plan-close]').onclick=()=>{if(adopted || saveDraft(true))dialog.close();};
            dialog.addEventListener('cancel',event=>{if(!applying && !adopted && !saveDraft(true))event.preventDefault();});
            dialog.onclose=()=>{releaseMedia();dialog.remove();};
            dialog.querySelector('[data-plan-fill]').onclick=async()=>{
                if(planning)return;
                try{const before=planned.combinations.length;await computePlan(async()=>{planned=await window.ReelsCombinationPlanner.fillMissingAsync(planned,candidates,slots,options,planScheduling);});await render(true);dialog.querySelector('[data-plan-error]').textContent=`保留原有 ${before} 套，新增随机配好 ${planned.combinations.length-before} 套，当前共 ${planned.combinations.length} 套；尚未替换任务。`;}
                catch(error){dialog.querySelector('[data-plan-error]').textContent=error.message;}
            };
            dialog.querySelector('[data-plan-reroll]').onclick=async()=>{try{await render();}catch(error){dialog.querySelector('[data-plan-error]').textContent=error.message;}};
            dialog.querySelector('[data-plan-adopt]').onclick=async()=>{
                if(applying)return;
                if(adopted){
                    applying=true;
                    try{
                        if(await window.reelsSaveUnifiedProject?.({wait:true,skipSync:true})===false)throw new Error('任务保存失败');
                        dialog.querySelector('[data-plan-error]').textContent='';
                        dialog.querySelector('[data-plan-phase]').textContent='保存完成';
                        dialog.querySelector('[data-plan-adopt]').disabled=true;
                        dialog.querySelector('[data-plan-close]').disabled=false;
                    }catch(error){dialog.querySelector('[data-plan-error]').textContent=error.message;}
                    finally{applying=false;}return;
                }
                if(replacingMedia || window._reelsMediaWriteBatchDepth>0)return status('正在处理其他素材操作，请稍候');
                applying=true;replacingMedia=true;let batchOpen=false;
                const button=dialog.querySelector('[data-plan-adopt]'), originalLabel=button.textContent;
                const controls=[...dialog.querySelectorAll('button,input,select')], disabled=controls.map(node=>node.disabled);
                const moveUsed=dialog.querySelector('[data-plan-move]').checked;
                controls.forEach(node=>node.disabled=true);dialog.setAttribute('aria-busy','true');
                dialog.querySelector('[data-plan-error]').textContent='';
                const panel=dialog.querySelector('[data-plan-progress]');panel.hidden=false;
                const started=Date.now(), elapsed=()=>{dialog.querySelector('[data-plan-elapsed]').textContent=`已用时 ${Math.floor((Date.now()-started)/1000)} 秒 · 处理中请勿关闭应用`;};
                elapsed();const timer=setInterval(elapsed,1000);
                const progress=({stage,completed,total,item,message})=>{
                    const labels={replace:'替换任务素材并记录使用次数',prepare:'检查移动路径',move:'移动到“本批已经使用”',rollback:'正在恢复原素材和任务',save:'更新路径并保存任务',done:'处理完成'};
                    const label=labels[stage] || '正在处理';
                    dialog.querySelector('[data-plan-phase]').textContent=label+(total?` · ${completed} / ${total}`:'');
                    const bar=dialog.querySelector('[data-plan-bar]');
                    if(total){bar.max=total;bar.value=completed;}else bar.removeAttribute('value');
                    dialog.querySelector('[data-plan-current]').textContent=message || item || '';
                    button.textContent='正在处理…';
                };
                const paint=()=>new Promise(resolve=>setTimeout(resolve,0));
                const requestId=`pair-adopt-${Date.now()}-${Math.random().toString(36).slice(2)}`;
                const unsubscribe=window.electronAPI.onBatchUsedMediaProgress?.(data=>{if(data.request_id===requestId)progress(data);});
                progress({stage:'prepare',message:'正在准备替换，请稍候…'});
                await paint();
                try{
                    if(disposed || targets.some(card=>!window._reelsState.tasks.includes(card.task)))throw new Error('目标任务已改变，请关闭并重新预览');
                    saveDraft(true);releaseMedia();context.beginBatch?.();batchOpen=true;
                    window.ReelsCombinationPlanner.checkLimits(planned,options);
                    const pendingUses=new Map();
                    const affectedTargets=planned.combinations.map((combo,index)=>targets[combo.targetIndex ?? index]);
                    const entries=await replaceCombinations(context,affectedTargets,planned.combinations,{
                        beforeWrite:()=>hooks.beforeWrite(),
                        onProgress:async data=>{progress(data);await paint();},
                        validate:(card,combo)=>{
                            for(const {slot,item} of combo.pairs){
                                if(!previewBatchAllowed(item))throw new Error('该历史批次未启用，请先打开此批次的参与随机开关');
                                if(item.files.some(file=>!mediaSource(file)))throw new Error(`素材已失效：${item.name}，请刷新目录后重试`);
                                const check=rules.checkSource(item.values[slot.key],slot);if(!check.allowed)throw new Error(check.reason);
                                const used=(pendingUses.get(item.id)||0)+1;pendingUses.set(item.id,used);
                                if(!item.phone && totalMax && library.historyFor([...item.files,...(item.originalFiles || [])]).count+used>totalMax)throw new Error(`素材 ${item.name} 已达到历史累计上限，请重新随机`);
                            }
                            const values=combo.pairs.map(({slot:group,item})=>({group,value:item.values[group.key]}));
                            const check=rules.checkValues(values);if(!check.allowed)throw new Error(check.reason);
                        },
                        recordUse:(...args)=>library?.recordUse?.(...args),
                        recordUses:library?.recordUses ? changes=>library.recordUses(changes) : null,
                        cancelUse:(...args)=>library?.cancelUse?.(...args),
                    });
                    if(moveUsed){
                        try{
                            const protectedPaths=(context.groups || []).filter(group=>group.field==='bg' || rules.isPhoneGroup(group)).flatMap(group=>window._reelsState.tasks.flatMap(task=>pathsOf(context.readInventory?context.readInventory(task,group,window._reelsState.tasks.indexOf(task)):context.read(task,group),group)));
                            const selectedUnits=archiveCandidates(planned.combinations,{isPhone:rules.isPhoneGroup,protectedPaths})
                                .filter(item=>!['library','characters'].includes(item.origin) && window.ReelsUsedBatches?.shouldMove(item,archiveBatchState)!==false);
                            if(selectedUnits.length){
                            const roots=[...(library?.opened || []),...temporaryDirectories.values()].map(entry=>entry.root || entry.directory);
                            const units=archiveUnits(selectedUnits,{roots,rootFor:(...args)=>library.rootFor(...args)});
                            progress({stage:'prepare',message:'正在检查归档目录并保存恢复清单…'});await paint();
                            const response=await window.electronAPI.apiCall('batch-used-media',{action:'move',request_id:requestId,units,recovery:window.reelsCollectUnifiedProjectData?.()});
                            if(!response?.success)throw new Error(response?.error || '移动已用素材失败');
                            window.ReelsMediaRelocation.remap(entries,response.data.mappings);
                            entries.archive=response.data;
                            progress({stage:"save",message:"正在同步所有任务的素材路径…"});await paint();
                            applyRelocation(response.data.mappings);
                            }
                        }catch(error){
                            progress({stage:"rollback",message:error.message});await paint();
                            if(entries.archive){const restored=await window.electronAPI.apiCall('batch-used-media',{action:'rollback',id:entries.archive.id,directories:entries.archive.directories});if(!restored?.success){undo.push(entries);throw new Error(`${error.message}；素材回滚失败，已保留当前引用和撤销记录：${restored?.error || '请检查使用清单'}`);}window.ReelsMediaRelocation.remap(entries,restored.data.mappings);applyRelocation(restored.data.mappings);}
                            for(const entry of entries.slice().reverse()){context.write(entry.task,entry.group,entry.value);if(entry.usage)await library.cancelUse(entry.task,entry.usage);}
                            throw error;
                        }
                    }
                    undo.push(entries);window.dispatchEvent(new CustomEvent('reels-overview-undo-push',{detail:'media'}));query('.rom-undo').disabled=false;
                    adopted=true;dialog.querySelectorAll('[data-plan-discard]').forEach(button=>{button.hidden=true;});clearTimeout(saveTimer);delete draftStore[source];
                    context.endBatch?.();batchOpen=false;
                    if(await window.reelsSaveUnifiedProject?.({wait:true,skipSync:true})===false)throw new Error('任务保存失败，请重试保存后再关闭');
                    dialog.querySelector('[data-report-state]').textContent=`已确认采用 ${affectedTargets.length} 套，未配 ${planned.shortage || 0} 套；下表为本次采用结果。`;
                    refresh();releaseMedia();dialog.querySelector('[data-plan-list]').style.display='none';
                    const result=`已替换 ${affectedTargets.length} 个任务${entries.archive?'，已按用后移动设置归档并同步路径':'，素材保留原位置'}；电话和背景保留原位置；可撤销分配`;
                    progress({stage:'done',completed:1,total:1,message:result});
                    button.textContent='已完成';
                    const close=dialog.querySelector('[data-plan-close]');close.disabled=false;close.textContent='完成，返回任务';
                    status(result);window.showToast?.(result,'success');
                }catch(error){
                    dialog.querySelector('[data-plan-phase]').textContent='处理失败';
                    dialog.querySelector('[data-plan-current]').textContent='请查看下方错误信息，处理未完成。';
                    dialog.querySelector('[data-plan-bar]').removeAttribute('value');
                    dialog.querySelector('[data-plan-error]').textContent=error.message;
                    controls.forEach((node,index)=>node.disabled=disabled[index]);button.textContent=adopted?'重试保存':originalLabel;
                }finally{
                    if(batchOpen)context.endBatch?.();applying=false;replacingMedia=false;clearInterval(timer);unsubscribe?.();dialog.removeAttribute('aria-busy');
                    dialog.querySelector('[data-plan-elapsed]').textContent=`总用时 ${Math.floor((Date.now()-started)/1000)} 秒`;
                }
            };
            if(savedDraft){
                planned=window.ReelsCombinationPlanner.restore(savedDraft.planned,candidates,slots,options);
                dialog.querySelector('[data-plan-layout]').value=savedDraft.layout==='grid'?'grid':'rows';
                if(savedDraft.columns){dialog.querySelector('[data-plan-columns]').value=savedDraft.columns;dialog.style.setProperty('--pair-columns',String(savedDraft.columns));}
                applyPreviewLayout();
                dialog.querySelector('[data-plan-move]').checked=savedDraft.move!==false;
                dialog.querySelector('[data-plan-names]').checked=savedDraft.names ?? previewShowNames;
                dialog.querySelector('[data-plan-phones]').checked=savedDraft.showPhones ?? previewShowPhones;
                dialog.classList.toggle('rom-plan-hide-names',savedDraft.names===false);
                await render(true);
                try{window.ReelsCombinationPlanner.checkLimits(planned,options);}catch(error){planned.issues.push(error.message);}
                dialog.querySelector('[data-plan-error]').textContent=(planned.issues || []).join('；');
                dialog.querySelector('[data-plan-draft]').textContent=`当前是上次保存的 ${planned.combinations.length} 套随机匹配结果，并未按新增候选重新匹配。可点“保留已有组合，补齐剩余任务”，或“全部重新随机”。`;
            }else{applyPreviewLayout();await render();if(phoneDraftInvalid)dialog.querySelector('[data-plan-error]').textContent='电话库或勾选范围已变更，旧草稿电话已排除，已按当前电话候选重新生成组合。';}
            if(disposed)throw new Error('配对预览已取消');
            document.body.appendChild(dialog);dialog.showModal();previewOpened=true;
            const cleanup=()=>{if(!applying && !adopted && !discarded)saveDraft(true);clearTimeout(saveTimer);releaseMedia();dialog.remove();};
            handlers.push(cleanup);
            dialog.addEventListener('close',()=>{const index=handlers.indexOf(cleanup);if(index>=0)handlers.splice(index,1);},{once:true});
        }
        function importTemporaryDirectory(ctx,key,directory,paths,mode) {
            const id=JSON.stringify([key,directory]);
            const source=temporaryDirectories.get(id) || {key,directory,mode,paths:[]};
            source.mode=mode;
            const result=syncDirectoryImport(ctx,source,paths);
            temporaryDirectories.set(id,source);
            usedBatches?.refresh(true);
            for(const path of source.paths)temporaryImports.add(`${key}\n${path}`);
            return result;
        }
        async function refreshTemporaryDirectories() {
            const sources=[...temporaryDirectories.values()];
            if(!sources.length)return status('请先读取临时文件夹');
            const api=window.electronAPI;
            if(!api?.scanDirectoryRecursive)throw new Error('请在桌面版读取素材目录');
            const failures=[];
            for(const source of sources) {
                if(disposed)return;
                try {
                    const entries=await api.scanDirectoryRecursive(source.directory,{maxDepth:20});
                    if(disposed)return;
                    const paths=entries.map(entry=>typeof entry==='string'?entry:entry.path).filter(valid);
                    importTemporaryDirectory(context,source.key,source.directory,paths,source.mode);
                    await trackFolder(source.directory,paths);
                }catch(error){failures.push(`${basename(source.directory)}：${error.message}`);}
            }
            if(disposed)return;
            refresh.flush();
            status(`已刷新 ${sources.length-failures.length} 个临时文件夹`+(failures.length?`；失败：${failures.join('；')}`:''));
            return failures;
        }
        let directoriesBusy=false;
        async function refreshAllLinked(){
            if(directoriesBusy || replacingMedia || window._reelsMediaWriteBatchDepth>0)throw new Error('正在处理素材，请稍候再刷新');
            directoriesBusy=true;replacingMedia=true;
            const button=query('.rom-refresh-linked');if(button)button.disabled=true;
            const failures=[];
            try{
                status('正在刷新所有关联素材…');
                await libraryQueue;
                // Refresh library inventories without allocating or recording another use.
                if(context.directory && ![...temporaryDirectories.values()].some(source=>source.directory===context.directory)){
                    try{await scan(context.directory,true);}catch(error){failures.push(`${context.directory}：${error.message}`);}
                }
                if(temporaryDirectories.size)failures.push(...(await refreshTemporaryDirectories() || []));
                for(const root of (library?.opened || []).map(item=>item.root)){
                    if(disposed)return;try{await openLibrary(root);}catch(error){failures.push(`${root}：${error.message}`);}
                }
                for(const source of [backgroundLibrary,phoneLibrary]){
                    if(disposed)return;try{failures.push(...(await source?.refreshAll?.() || []));}catch(error){failures.push(error.message);}
                }
                const result=await refreshLinkedBindings(context,tasks,window.electronAPI,{stopped:()=>disposed,onProgress:status});
                if(disposed || result.cancelled)return;
                failures.push(...result.failures);
                if(result.entries.length){
                    hooks.beforeWrite();replacingMedia=true;context.beginBatch?.();
                    const applied=[];
                    try{
                        for(const entry of result.entries){applied.push(entry);context.write(entry.task,entry.group,entry.next);}
                    }catch(error){for(const entry of applied.reverse())context.write(entry.task,entry.group,entry.value);throw error;}
                    finally{context.endBatch?.();}
                    undo.push(result.entries);query('.rom-undo').disabled=false;
                    window.dispatchEvent(new CustomEvent('reels-overview-undo-push',{detail:'media'}));
                }
                // Keep the user's candidate selection, replacing its source snapshots in place.
                const candidateResult=await refreshLinkedBindings({groups:context.groups,read:(item,group)=>item.values?.[group.key]},candidatePool,window.electronAPI,{stopped:()=>disposed,onProgress:status});
                if(disposed || candidateResult.cancelled)return;
                failures.push(...candidateResult.failures);
                for(const entry of candidateResult.entries)entry.task.values[entry.group.key]=entry.next;
                for(let index=candidatePool.length-1;index>=0;index--){
                    const item=candidatePool[index],value=Object.values(item.values || {}).find(value=>value && ('media_folder_path' in value || 'content' in value));
                    if(!value)continue;
                    const files=value.media_folder_files || [value.content].filter(Boolean);
                    if(!files.length){candidatePool.splice(index,1);continue;}
                    item.files=[...files];
                    if(item.unit && item.folder)Object.assign(item.unit,{files:[...files],preview:value.content,value});
                }
                persistCandidates();renderCandidates();posters.clear();aspects.clear();geometry.clear();
                for(const entry of result.entries)if(entry.next.media_folder_path){
                    const key=entry.group.key,path=entry.next.media_folder_path,files=entry.next.media_folder_files;
                    if(files.length){rememberFolder(context,key,path,files);context.saved._units[`${key}\n${path}`].value=entry.next;}
                    else{context.saved[key]=(context.saved[key] || []).filter(item=>item!==path);delete context.saved._units?.[`${key}\n${path}`];}
                }
                for(const [key,item] of checkedMedia)if(!available(item.path) && !unitFor(context,item.path,item.poolKey)?.folder)checkedMedia.delete(key);
                materialList._romLayout=null;refresh.flush();
                if(await window.reelsSaveUnifiedProject?.({wait:true,skipSync:true})===false)failures.push('关联已更新，但工程保存失败，请手动保存');
                const message=`已刷新本批 ${tasks.length} 个任务的关联素材：新增 ${result.added} 个、移除失效引用 ${result.removed} 个`+(failures.length?`；${failures.length} 项读取失败，保留原关联：${failures.join('；')}`:'');
                status(message);window.showToast?.(message,failures.length?'warning':'success',7000);
                return {...result,failures};
            }finally{directoriesBusy=false;replacingMedia=false;if(!disposed && button)button.disabled=false;}
        }
        async function refreshDirectories(temporaryOnly=false) {
            if(directoriesBusy)return;directoriesBusy=true;
            query('.rom-daily').disabled=true;temporaryRefresh.disabled=true;
            try {
                if(temporaryDirectories.size)await refreshTemporaryDirectories();
                else if(temporaryOnly)status('请先读取临时文件夹');
                if(!temporaryOnly && !disposed) {
                    if(context.directory)await scan(context.directory,true);
                    if(library?.active)await libraryAction(refreshLibraries);
                    if(!context.directory && !temporaryDirectories.size && !library?.active)status('请先读取素材文件夹或绑定素材库');
                }
            }finally{directoriesBusy=false;if(!disposed){query('.rom-daily').disabled=false;temporaryRefresh.disabled=false;}}
        }
        const refreshLinkedButton=document.createElement('button');refreshLinkedButton.className='rom-refresh-linked';refreshLinkedButton.textContent='刷新所有关联素材';
        refreshLinkedButton.title='更新各素材库和本批全部任务的关联；素材组使用原文件夹当前内容，新增纳入、缺失移除，不搜索其他目录。可撤销任务关联更新。';
        refreshLinkedButton.onclick=()=>run(refreshAllLinked);query('.rom-daily').after(refreshLinkedButton);
        temporaryRefresh.onclick=()=>run(()=>refreshDirectories(true));
        function trackFolder(directory,paths){return library?.track?.(directory,paths).then(result=>{if(disposed)return;updatePairRoots();const select=query('[data-pairing="temporary"] [data-pair-root]');select.value=result.root;refresh();}).catch(error=>status(`临时素材记录：${error.message}`));}
        function ingest(paths, key) {
            const before=new Set(listPaths(context,key));
            rememberImports(context.saved, key, paths);trackTemporary(key,before,paths);
            for(const directory of new Set(paths.map(parent)))trackFolder(directory,paths.filter(path=>parent(path)===directory));
            revealImports(key, paths.find(valid)); status(`已读取 ${paths.filter(valid).length} 个媒体文件`);
        }
        function revealImports(key, firstPath) {
            // 导入后仍显示本批素材，避免待分类筛选把本批数量变成 0。
            query('.rom-group').value = 'all';
            categoryFilter.value='all';historyFilter.value='all';temporaryHistory.value='all';
            query('.rom-only-selected').checked=false;
            query('.rom-only-unused').checked=false;
            query('.rom-search').value = '';
            query('.rom-sort').value = 'usage';
            collapsed.delete(key);
            collapsed.delete(JSON.stringify(['material-source','temporary']));
            const temporaryModule=query('.rom-list').querySelector?.('[data-source="temporary"]');if(temporaryModule)temporaryModule.open=true;
            collapsed.delete(JSON.stringify(['source','temporary',key]));
            refresh.flush();
            const tile = [...query('.rom-list').querySelectorAll('.rom-item')]
                .find(item => item.dataset.group === key && item.dataset.path === firstPath);
            tile?.scrollIntoView({block:'nearest'});
        }
        async function run(action) {try {await action();} catch(error) {if(!disposed)status(`读取失败：${error.message}`);}}
        query('.rom-import').onclick = () => run(async () => {
            if (!window.electronAPI?.selectFiles) return status('请在桌面版导入媒体文件');
            const key=importGroupKey(query('.rom-group').value);
            const paths=await window.electronAPI.selectFiles({title:'导入媒体到当前分类',multiple:true,filters:[{name:'视频和图片',extensions:['mp4','mov','mkv','avi','webm','m4v','jpg','jpeg','png','webp','gif','bmp']}]});
            if(!disposed && paths?.length)ingest(paths,key);
        });
        async function scan(directory, auto = false) {
            if(!directory)return status('当前批次未绑定素材文件夹，请使用“读取文件夹”');
            if(!window.electronAPI?.scanDirectoryRecursive)return status('请在桌面版读取素材目录');
            status('正在读取素材目录…');
            const entries=await window.electronAPI.scanDirectoryRecursive(directory,{maxDepth:20});
            if(disposed)return;
            const paths=entries.map(entry=>typeof entry==='string'?entry:entry.path).filter(valid);
            if(!auto){
                const key=importGroupKey(query('.rom-group').value);
                const mode=query('.rom-folder-mode').value;
                const before=new Set(listPaths(context,key));
                const imported=importTemporaryDirectory(context,key,directory,paths,mode);trackTemporary(key,before,paths);
                await trackFolder(directory,paths);
                if(!imported.mediaCount)return status(`文件夹「${basename(directory)}」中没有支持的视频或图片`);
                revealImports(key,imported.firstPath);
                const label=context.groups.find(group=>group.key===key)?.label || '待分类素材';
                status(['suites','categories'].includes(mode) ? `已读取 ${imported.unitCount} 套素材文件夹（共 ${imported.mediaCount} 个媒体）→ ${label}`
                    : mode==='files' ? `已平铺读取 ${imported.mediaCount} 个媒体文件 → ${label}`
                    : `已读取 1 个文件夹：${basename(directory)}（内含 ${imported.mediaCount} 个媒体）→ ${label}`);
                return;
            }
            inventory=collect(context,tasks);
            // Only infer a column when the entire parent folder has one known column.
            const folders=new Map();
            for(const [path,keys] of inventory.known){const dir=parent(path);if(!folders.has(dir))folders.set(dir,new Set());for(const key of keys)folders.get(dir).add(key);}
            for(const path of paths){
                const keys=inventory.known.get(path) || folders.get(parent(path));
                const key=keys?.size===1?[...keys][0]:'unclassified';
                const before=new Set(listPaths(context,key));
                rememberImports(context.saved, key, [path]);trackTemporary(key,before,[path]);
            }
            refresh();status(`素材目录已读取 ${paths.length} 个媒体；无法确定列的素材放在待分类`);
        }
        query('.rom-folder').onclick=()=>run(async()=>{
            const api=window.electronAPI;
            if(!api?.selectDirectories && !api?.selectDirectory)return status('请在桌面版读取素材目录');
            const key=importGroupKey(query('.rom-group').value),mode=query('.rom-folder-mode').value;
            const directories=api.selectDirectories ? await api.selectDirectories() : [await api.selectDirectory()].filter(Boolean);
            if(disposed || !directories?.length)return;
            if(!api.scanDirectoryRecursive)return status('当前版本不支持读取素材目录');
            status(`正在读取 ${directories.length} 个总文件夹…`);
            const before=new Set(listPaths(context,key));
            const result=await importDirectories(context,key,directories,mode,
                async directory=>{const entries=await api.scanDirectoryRecursive(directory,{maxDepth:20});await trackFolder(directory,entries.map(entry=>typeof entry==='string'?entry:entry.path));return entries;},()=>disposed,importTemporaryDirectory);
            if(disposed)return;
            trackTemporary(key,before,[...temporaryDirectories.values()].filter(entry=>entry.key===key && directories.includes(entry.directory)).flatMap(entry=>entry.paths || []));
            if(result.unitCount)revealImports(key,result.firstPath);
            const label=context.groups.find(group=>group.key===key)?.label || '待分类素材';
            status(`已读取 ${result.unitCount} ${mode==='files'?'个文件':'套素材'}（共 ${result.mediaCount} 个媒体）→ ${label}`
                +(result.empty.length?`；${result.empty.length} 个文件夹无支持的媒体`:'' )
                +(result.failures.length?`；读取失败：${result.failures.map(item=>basename(item.directory)+'：'+item.error).join('；')}`:''));
        });
        query('.rom-daily').onclick=()=>run(()=>refreshDirectories());
        backgroundLibrary=window.ReelsBackgroundLibrary?.mount(query('.rom-list'),{
            groups:context.groups,
            checkedChanged:()=>{if(backgroundPageActive())updateSelectionCount();},
            backgroundLinked:group=>context.backgroundLinked?.(group),
            setBackgroundLinked:(group,enabled)=>{hooks.beforeWrite();context.setBackgroundLinked?.(group,enabled);refresh();},
            current:()=>hooks.selected(),
            select:path=>{
                if(!path){if(selectedGroup==='background-library'){selectedPath='';selectedGroup='';}return;}
                if(root._romReplacementTarget){
                    const {card,group}=root._romReplacementTarget;cancelReplacement();
                    requestReplacement(card,{path,poolKey:'background-library',group,external:true,ambiguous:false});return;
                }
                selectedPath=path;selectedGroup='background-library';
                if(clickMode)status(`已选「${basename(path)}」，点击右侧需要替换的媒体层`);
            },
            targets:scope=>scope==='all'?cards:scope==='selected'?selectedTaskCards(cards,checkedTasks):[hooks.selected()].filter(Boolean),
            thumbnails:()=>{if(disposed || panel.hidden)return;thumbnailLoader?.dispose();thumbnailLoader=window.BatchThumbnailLoader?.hydrate(panel);},
            apply:pairs=>{
                const entries=pairs.map(({card,value,group})=>{
                    if(!group || !context.groups.includes(group))throw new Error('分配目标层已变化，请重新打开媒体池');
                    if(group.field==='bg'){
                        const staged={...card.task,...value,overlays:JSON.parse(JSON.stringify(card.task.overlays || []))};
                        window.ReelsBackgroundLibrary?.syncLinkedMedia?.(staged,value,(layer,next)=>Object.assign(layer,next));
                        if(value._overviewTitleBinding)window.ReelsBackgroundLibrary.applyTitle(staged,value._overviewTitleBinding);
                    }else{
                        const check=window.ReelsNameBinding?.checkReplacement(context,card.task,group,value);if(check && !check.allowed)throw new Error(check.reason);
                    }
                    return {task:card.task,group,value:context.read(card.task,group)};
                });
                hooks.beforeWrite();context.beginBatch?.();
                try{for(const {card,value,group} of pairs)context.write(card.task,group,value);}
                catch(error){for(const entry of entries.slice().reverse())context.write(entry.task,entry.group,entry.value);throw error;}
                finally{context.endBatch?.();}
                undo.push(entries);window.dispatchEvent(new CustomEvent('reels-overview-undo-push',{detail:'media'}));query('.rom-undo').disabled=false;
                refresh();
            },
        });
        phoneLibrary=window.ReelsPhoneLibrary?.mount(query('.rom-list'),{
            groups:context.groups,mediaSource,
            columns:()=>root.querySelector('.rto-density')?.value || 4,showTaskNames:()=>root.querySelector('.rto-task-names')?.checked!==false,
            read:(task,group)=>context.readInventory?context.readInventory(task,group,window._reelsState.tasks.indexOf(task)):context.read(task,group),
            targets:mode=>mode==='all'?cards:mode==='selected'?selectedTaskCards(cards,checkedTasks):mode==='scope'?scopeCards():[hooks.selected()].filter(Boolean),
            applyMatched:async(rows,phoneGroup,layers,onProgress)=>{
                if(!rows.length)return;
                if(replacingMedia || window._reelsMediaWriteBatchDepth>0)throw new Error('正在处理其他素材，请稍后重试');
                replacingMedia=true;let entries;
                try{
                const combinations=rows.map(row=>({pairs:[{slot:phoneGroup,item:{id:row.path,path:row.path,files:[row.path],folder:false,phone:true,name:basename(row.path),values:{[phoneGroup.key]:window.ReelsPhoneLibrary.valueFor(row.path)}}}]}));
                entries=await replaceCombinations(context,rows.map(row=>row.card),combinations,{
                    beforeWrite:()=>hooks.beforeWrite(),
                    validate:(card,combo)=>{
                        if(disposed || !window._reelsState.tasks.includes(card.task))throw new Error('目标任务已变化，请重新打开电话匹配预览');
                        const item=combo.pairs[0].item;if(!mediaSource(item.path))throw new Error('电话媒体已失效，请刷新电话库后重试');
                        const read=(task,group)=>context.readInventory?context.readInventory(task,group,window._reelsState.tasks.indexOf(task)):context.read(task,group);
                        const match=window.ReelsPhoneLibrary.materialKeywords(card.task,layers,read),keys=window.ReelsNameBinding.match(basename(item.path));
                        if(!match.keys.some(key=>keys.includes(key)))throw new Error(match.reason || '任务参考素材已变化，所选电话不再配套，请重新预览');
                    },
                    recordUses:library?.recordUses ? changes=>library.recordUses(changes) : null,
                        recordUse:(...args)=>library?.recordUse?.(...args),cancelUse:(...args)=>library?.cancelUse?.(...args),
                    onProgress:async progress=>{onProgress?.(progress);await new Promise(resolve=>setTimeout(resolve,0));},
                });
                if(await window.reelsSaveUnifiedProject?.({wait:true})===false)throw new Error('任务保存失败');
                undo.push(entries);window.dispatchEvent(new CustomEvent('reels-overview-undo-push',{detail:'media'}));refresh();
                }catch(error){
                    if(entries){
                        context.beginBatch?.();
                        try{for(const entry of entries.slice().reverse()){context.write(entry.task,entry.group,entry.value);if(entry.usage)await library?.cancelUse?.(entry.task,entry.usage);}}
                        finally{context.endBatch?.();}
                        await window.reelsSaveUnifiedProject?.({wait:true});refresh();
                    }
                    throw error;
                }finally{replacingMedia=false;query('.rom-undo').disabled=!undo.length;}
            },
            thumbnails:()=>{if(disposed || panel.hidden)return;thumbnailLoader?.dispose();thumbnailLoader=window.BatchThumbnailLoader?.hydrate(panel);},
        });
        // One material workbench: stable source surfaces, shared matching controls and a fixed action dock.
        const workspacePages=new Map(),workspaceHeader=document.createElement('header');workspaceHeader.className='rom-workspace-header';
        workspaceHeader.innerHTML='<div class="rom-workspace-title"><strong>素材工作台</strong><span>选素材 · 配组合 · 替换当前任务</span></div><nav class="rom-workspace-nav" role="tablist" aria-label="素材来源"></nav>';
        const nav=workspaceHeader.querySelector('nav');panel.prepend(workspaceHeader);
        function workspacePage(key,title,description){
            const page=document.createElement('section');page.dataset.workspacePage=key;page.className='rom-workspace-page';page.id=`rom-workspace-${key}`;page.setAttribute('role','tabpanel');
            const intro=document.createElement('p');intro.className='rom-workspace-intro';intro.textContent=description;page.appendChild(intro);materialList.appendChild(page);
            const button=document.createElement('button');button.type='button';button.textContent=title;button.dataset.workspaceTab=key;button.setAttribute('role','tab');button.setAttribute('aria-controls',page.id);nav.appendChild(button);
            workspacePages.set(key,{page,button});return page;
        }
        const sourcePairings={};
        for(const [key,label] of [['temporary','临时素材'],['library','固定素材'],['characters','爆贴人物库'],['batch','本批素材']]){
            const page=workspacePage(key,label,'勾选素材加入候选池，或直接拖到右侧任务。');
            const section=materialList.querySelector(`.rom-source-section[data-source="${key}"]`);page.appendChild(section);section.open=true;
            const settings=section.querySelector('[data-pairing]');if(settings){sourcePairings[key]=settings;settings.hidden=true;}
        }
        const poolPage=workspacePage('pool','候选池','本次参与混合匹配的素材；保留原来源，同一素材不重复入池。');
        const poolSettings=poolSection.querySelector('[data-candidate-tools]');poolPage.appendChild(poolSection);poolSection.open=true;
        for(const [key,title,selector] of [['phone','电话库','.rom-phone-library'],['background','背景库','.rom-background-library']]){
            const page=workspacePage(key,title,'在这里管理素材和绑定关系。');const section=materialList.querySelector(selector);if(section){page.appendChild(section);section.open=true;}
        }
        const history=materialList.querySelector('.rom-used-batches');if(history)history.open=false;
        for(const surface of [...materialList.querySelectorAll('[data-used-source]')]){
            const source=surface.dataset.usedSource,section=materialList.querySelector(`.rom-source-section[data-source="${source}"]`);
            if(!section || isPersistentSource(source))continue;
            const batches=document.createElement('details');batches.className='rom-source-history';batches.open=true;
            batches.innerHTML='<summary>历史已用批次 · 默认不参与匹配</summary><p class="rom-hint">此来源以前用过的素材，按批次展开查看；可逐批开启，或全选参与本次匹配。</p>';
            batches.appendChild(surface);section.appendChild(batches);
        }
        const browseTools=document.createElement('div');browseTools.className='rom-workspace-browse-tools';
        const browseFilters=document.createElement('details');browseFilters.className='rom-browse-filters';browseFilters.innerHTML='<summary>搜索与显示</summary>';
        browseFilters.append(panel.querySelector('.rom-search'),mediaCategory,sortLabel,size,names,keywordGrouping,selectedFilter);
        if(history)browseFilters.appendChild(history);
        const addToPool=document.createElement('button');addToPool.type='button';addToPool.className='rom-workspace-primary';addToPool.textContent='勾选素材加入候选池';addToPool.onclick=()=>poolSection.querySelector('[data-candidate-add]').click();
        browseTools.append(browseFilters,selectionTools,addToPool,materialFolds);workspaceHeader.appendChild(browseTools);
        const expandBrowser=document.createElement('button');expandBrowser.type='button';expandBrowser.className='rom-browser-expand';expandBrowser.textContent='放大素材区';expandBrowser.setAttribute('aria-pressed','false');
        expandBrowser.onclick=()=>{
            const expanded=panel.classList.toggle('rom-browser-expanded');
            expandBrowser.textContent=expanded?'恢复操作区':'放大素材区';expandBrowser.setAttribute('aria-pressed',String(expanded));
            panel.scrollTop=0;
        };
        workspaceHeader.querySelector('.rom-workspace-title').appendChild(expandBrowser);
        const settingsDock=document.createElement('section');settingsDock.className='rom-workspace-settings';settingsDock.hidden=true;settingsDock.setAttribute('aria-label','配对与分配设置');

        const matchSettings=document.createElement('div');matchSettings.appendChild(poolSettings);
        const sharedPairing=poolSettings.querySelector('[data-pairing="pool"]');sharedPairing.open=true;sharedPairing.querySelector('summary').hidden=true;sharedPairing.querySelector('[data-pair-preview]').hidden=true;
        const scopeLabel=document.createElement('label');scopeLabel.className='rom-match-source';scopeLabel.innerHTML='匹配素材范围<select aria-label="匹配素材范围"><option value="pool">候选池 · 混合来源</option><option value="temporary">仅临时素材</option><option value="library">仅固定素材</option></select>';
        const matchSource=scopeLabel.querySelector('select');matchSettings.prepend(scopeLabel);
        matchSource.add(new Option('仅爆贴人物库','characters'));matchSource.add(new Option('仅本批素材','batch'));matchSource.hidden=true;
        const sourceChecks=document.createElement('div');sourceChecks.className='rom-match-source-checks';
        sourceChecks.innerHTML=[['pool','候选池'],['temporary','临时素材'],['library','固定素材'],['characters','爆贴人物库'],['batch','本批素材']].map(([key,label])=>`<label style="display:inline-flex;align-items:center;gap:6px;margin:6px 12px 6px 0"><input type="checkbox" data-match-source="${key}" style="width:auto">${label}</label>`).join('')+'<small style="display:block">可多选，合并后按素材路径去重；电话库自动配套。</small>';
        scopeLabel.appendChild(sourceChecks);
        const selectedMatchSources=()=>[...sourceChecks.querySelectorAll('input:checked')].map(input=>input.dataset.matchSource);
        let sourceSelectionExplicit=Array.isArray(candidateRules.matchSources);
        const initialSources=sourceSelectionExplicit?candidateRules.matchSources:['temporary'];
        sourceChecks.querySelectorAll('input').forEach(input=>{input.checked=initialSources.includes(input.dataset.matchSource);});
        const routeMatchSources=()=>{const sources=selectedMatchSources();matchSource.value=sources.length===1?sources[0]:'pool';};
        routeMatchSources();

        rulesEditor.open=true;matchSettings.appendChild(rulesEditor);
        const manualSettings=document.createElement('div');manualSettings.hidden=true;manualSettings.className='rom-manual-settings';manualSettings.innerHTML='<h4>手动分配</h4>';
        const manualTargets=document.createElement('section');manualTargets.className='rom-manual-card';manualTargets.appendChild(randomLayers);
        const manualOptions=document.createElement('section');manualOptions.className='rom-manual-card rom-manual-options';
        const repeatInput=repeatLimit.querySelector('input'),repeatTitle=document.createElement('span'),repeatNote=document.createElement('small');repeatTitle.textContent='本轮使用上限';repeatNote.textContent='0 不限；每填入一个目标层计 1 次';repeatLimit.replaceChildren(repeatTitle,repeatInput,repeatNote);
        manualOptions.append(distributionMode,repeatLimit,distributionActions);
        const manualHelp=document.createElement('section');manualHelp.className='rom-manual-help';manualHelp.innerHTML='<h4>拖拽与点选替换</h4>';manualHelp.append(swapMode,hint);
        manualSettings.append(manualTargets,manualOptions,manualHelp);
        settingsDock.append(matchSettings,manualSettings);
        const dock=document.createElement('footer');dock.className='rom-workspace-dock';dock.innerHTML='<div class="rom-dock-context"></div><p class="rom-dock-rule" role="status"></p><div class="rom-dock-actions"><button data-manual>手动分配</button><button data-settings>配对设置 ⚙</button><button data-match>随机匹配并预览</button><button data-pair-stop hidden>停止配对</button></div>';
        const scopeControl=panel.querySelector('.rom-scope-label'),undoButton=distributionActions.querySelector('.rom-undo') || query('.rom-undo');dock.querySelector('.rom-dock-context').append(scopeControl);if(undoButton)dock.querySelector('.rom-dock-context').appendChild(undoButton);
        const feedback=query('.rom-status');feedback.classList.add('rom-workspace-feedback');dock.append(settingsDock,feedback);panel.appendChild(dock);
        for(const settings of Object.values(sourcePairings))panel.appendChild(settings);
        actionBar.remove();generalSettings.remove();
        syncScopeLayers=()=>{
            const targets=scopeCards();
            sharedPairing.querySelectorAll('[data-pair-slot]').forEach(input=>{
                const group=groupFor(input.value);
                const overlays=targets.map(({task})=>context.mediaLayer?.(task,group) || (!context.mediaLayer?(task.overlays || []).find(overlay=>['image','video'].includes(overlay.type) && [overlay.slotKey,overlay._templateOverlayId,overlay.id].includes(group.mediaSlot)):null)).filter(overlay=>overlay && !overlay.disabled);
                const present=group.field==='bg'?targets.length:overlays.length;
                const independent=window.ReelsNameBinding?.isIndependentGroup?.(group) || targets.some(({task})=>window.ReelsNameBinding?.isIndependentGroup?.(group,task));
                input.disabled=!present || independent;input.closest('label').hidden=!present || independent;
                const label=input.closest('label');
                const name=overlays[0]?.name || group.label;
                if(label.lastChild?.nodeType===3)label.lastChild.textContent=name+(present && present<targets.length?`（${present}/${targets.length} 个任务）`:'');
                label.title=`当前任务范围内 ${present} / ${targets.length} 个任务含此层`;
            });
        };
        query('.rom-scope').addEventListener('change',syncScopeLayers);
        const sourceRoot=sharedPairing.querySelector('[data-pair-root]'),selectedOnly=sharedPairing.querySelector('[data-pair-selected]');
        const sourceCard=sharedPairing.querySelector('[data-source-min]').closest('.rom-pair-card'),basisCard=sharedPairing.querySelector('[data-pair-basis]').closest('.rom-pair-card');
        function syncSourceOptions(){
            const source=matchSource.value,original=sourcePairings[source]?.querySelector('[data-pair-root]');
            if(original){const previous=sourceRoot.value;sourceRoot.innerHTML=original.innerHTML;sourceRoot.value=[...sourceRoot.options].some(option=>option.value===previous)?previous:'all';}else if(source==='batch'){sourceRoot.innerHTML='<option value="all">本批全部素材</option>';}
            sourceRoot.closest('label').hidden=source==='pool';selectedOnly.closest('label').hidden=source==='pool';sourceCard.hidden=source!=='pool';basisCard.hidden=source!=='pool';
        }
        function updateDock(){
            const source=selectedMatchSources().map(key=>key==='pool'?'候选池':originNames[key]).join(' + ') || '未选择来源',basis=sharedPairing.querySelector('[data-pair-basis]');
            const mode=matchSource.value==='pool'?(basis.value?basis.selectedOptions[0].textContent:'完全随机'):source;
            const scope=matchSource.value==='pool'?`${source} · ${mode}`:source;
            dock.querySelector('.rom-dock-rule').textContent=`${scope} · 普通素材最多 ${sharedPairing.querySelector('[data-pair-uses]').value} 次 · 电话自动配套`;
            workspacePages.get('pool').button.textContent=`候选池 · ${candidatePool.length}`;
        }
        function showSettings(mode){
            settingsDock.hidden=false;
            manualSettings.hidden=mode!=='manual';matchSettings.hidden=mode==='manual';
            dock.querySelector('[data-manual]').setAttribute('aria-expanded',String(mode==='manual'));dock.querySelector('[data-settings]').setAttribute('aria-expanded',String(mode!=='manual'));
            syncSourceOptions();syncScopeLayers();
            requestAnimationFrame(()=>dock.querySelector('.rom-dock-actions').scrollIntoView({block:'start',behavior:'smooth'}));
        }
        dock.querySelector('[data-manual]').onclick=()=>showSettings('manual');dock.querySelector('[data-settings]').onclick=()=>showSettings('match');
        sourceChecks.onchange=()=>{sourceSelectionExplicit=true;candidateRules.matchSources=selectedMatchSources();routeMatchSources();persistCandidates();syncSourceOptions();updateDock();};
        matchSource.onchange=()=>{syncSourceOptions();updateDock();};sharedPairing.addEventListener('change',updateDock);
        const matchFeedback=document.createElement('output');matchFeedback.dataset.matchFeedback='';matchFeedback.setAttribute('role','alert');matchFeedback.setAttribute('aria-live','assertive');
        matchFeedback.style.cssText='display:block;white-space:pre-wrap;overflow-wrap:anywhere;color:#ffbfaa;font-size:12px;max-height:220px;overflow:auto;padding:6px 0';
        dock.querySelector('.rom-dock-actions').after(matchFeedback);
        const runMatch=()=>previewAction(sharedPairing,()=>{syncSourceOptions();syncScopeLayers();return openCombinationPreview(matchSource.value,sharedPairing,selectedMatchSources());},{onError:text=>{if(!disposed){matchFeedback.textContent=text;status(text);window.showToast?.(text,'warning');}}});
        sharedPairing.querySelector('[data-pair-preview]').onclick=runMatch;
        dock.querySelector('[data-match]').onclick=async()=>{
            const button=dock.querySelector('[data-match]');button.disabled=true;button.textContent='正在准备预览…';matchFeedback.textContent='正在检查任务范围、媒体层、素材来源与电话配套…';
            try{await runMatch();if(matchFeedback.textContent.startsWith('正在检查'))matchFeedback.textContent=sharedPairing.querySelector('[data-pair-feedback]').textContent;}
            catch(error){matchFeedback.textContent=`配对失败：${error.message || String(error)}`;status(matchFeedback.textContent);}
            finally{button.disabled=false;button.textContent='随机匹配并预览';}
        };
        const poolCountObserver=new MutationObserver(updateDock);poolCountObserver.observe(poolSection.querySelector('[data-candidate-summary]'),{childList:true,characterData:true,subtree:true});handlers.push(()=>poolCountObserver.disconnect());
        style.textContent+=`
            #reels-task-overview .rom-panel{overflow-y:auto;gap:0;padding:10px}
            #reels-task-overview .rom-panel>.rom-list{flex:none;height:var(--rom-browser-height,72vh);min-height:min(680px,72vh);box-sizing:border-box;overflow-y:auto;padding:12px 0;overscroll-behavior:contain}
            #reels-task-overview .rom-panel.rom-browser-expanded{overflow:hidden}
            #reels-task-overview .rom-panel.rom-browser-expanded>.rom-list{flex:1;min-height:0;height:auto}
            .rom-browser-expanded .rom-workspace-browse-tools,.rom-browser-expanded .rom-workspace-dock{display:none}
            .rom-browser-expand{flex-shrink:0;padding:5px 9px;border:1px solid #8e83d2;border-radius:5px;background:#4f4981;color:#fff;cursor:pointer;white-space:nowrap;font-size:12px}
            .rom-workspace-header{flex-shrink:0;display:grid;gap:10px;padding-bottom:10px;border-bottom:1px solid #444b5e;background:#1e2029}
            .rom-workspace-title{display:flex;align-items:center;justify-content:space-between;gap:8px}.rom-workspace-title strong{font-size:16px}.rom-workspace-title span{font-size:11px;color:#acb4cb}
            .rom-workspace-nav{display:flex;gap:5px;flex-wrap:wrap}#reels-task-overview .rom-workspace-nav button{flex:1 0 auto;padding:8px;border:1px solid #4c5369;background:#292e3b;color:#d7dcec;border-radius:7px;font-size:12px;cursor:pointer}#reels-task-overview .rom-workspace-nav button[aria-selected="true"]{background:#6757d9;border-color:#b9afff;color:white;font-weight:700}
            .rom-workspace-browse-tools{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.rom-workspace-browse-tools .rom-tools{align-items:center}.rom-workspace-browse-tools button{font-size:11px}.rom-browse-filters{flex-basis:100%;font-size:12px}.rom-browse-filters summary{cursor:pointer;color:#bec6db}.rom-browse-filters[open]{display:grid;gap:8px}.rom-workspace-primary{background:#4f4981!important;color:#fff!important;border:1px solid #8e83d2!important;border-radius:6px}
            .rom-workspace-page{display:flex;flex-direction:column;gap:10px}.rom-workspace-page[hidden],.rom-panel [hidden]{display:none!important}.rom-workspace-intro{margin:0;font-size:12px;line-height:1.6;color:#b6bfd5}.rom-source-history{border-top:1px solid #454c61;padding-top:12px;margin-top:16px}.rom-source-history>summary{cursor:pointer;font-size:13px;color:#c9c2f5;font-weight:600}.rom-workspace-page>h4{font-size:13px;margin:6px 0}.rom-workspace-page>.rom-source-section{border:0;padding:0}.rom-workspace-page>.rom-source-section>summary{font-size:12px;color:#bac3db;padding:5px 0}
            #reels-task-overview .rom-candidate-pool [data-candidate-list]{max-height:none!important;overflow:visible!important}
            .rom-workspace-settings{flex:none;max-height:none;overflow:visible;padding:16px 0;margin-top:16px;border-top:1px solid #646183}.rom-workspace-settings-close{display:block;margin:0 0 10px auto;font-size:11px}.rom-match-source{display:grid;gap:7px;margin-bottom:12px;font-size:12px}.rom-workspace-settings .rom-pairing-card-grid{gap:10px}.rom-workspace-settings .rom-settings{margin-top:10px}.rom-manual-settings{display:grid;gap:10px} .rom-manual-settings h4{margin:0;font-size:13px}.rom-manual-card{padding:10px;border:1px solid #454c61;border-radius:9px;background:#262a35;min-width:0}
            #reels-task-overview .rom-manual-settings .rom-random-layers{flex-direction:row!important;flex-wrap:wrap;gap:8px!important;align-items:center}
            .rom-manual-settings legend{font-size:12px;margin-bottom:6px;color:#bdc6dc}
            #reels-task-overview .rom-manual-settings .rom-random-layers label{display:inline-flex!important;align-items:center;gap:5px;padding:6px 9px!important;border:1px solid #535b72;border-radius:6px;font-size:12px;line-height:1.3;background:#303646}
            #reels-task-overview .rom-manual-settings input[type=checkbox]{width:auto;margin:0;accent-color:#9b8cff}
            .rom-manual-options{display:grid;grid-template-columns:minmax(110px,1fr) minmax(140px,1fr) auto;gap:10px;align-items:start}
            .rom-manual-options>label{display:grid;gap:5px;font-size:12px;min-width:0}
            #reels-task-overview .rom-manual-options select{padding:7px;font-size:12px;min-width:0;width:100%}
            #reels-task-overview .rom-manual-options input[type=number]{width:76px;padding:7px;font-size:12px}
            .rom-manual-options small{font-size:11px;color:#adb6cd;line-height:1.4}
            .rom-manual-options .rom-distribution-actions{margin-top:20px}
            #reels-task-overview .rom-manual-options button{padding:8px 12px;font-size:12px;background:#6757d9;color:#fff;border:1px solid #a89cf5;border-radius:7px}
            .rom-manual-help{font-size:12px}.rom-manual-help summary{cursor:pointer;color:#bcb5e7;padding:4px 0}.rom-manual-help .rom-hint{margin:6px 0}
            #reels-task-overview .rom-manual-help button{width:auto;padding:7px 12px;font-size:12px}

            .rom-workspace-dock{flex-shrink:0;padding:10px 0 0;border-top:1px solid #646183;background:#1e2029;display:grid;gap:8px}.rom-dock-context{display:flex;align-items:end;gap:8px}.rom-dock-context>.rom-scope-label{flex:1;min-width:0;font-size:12px}.rom-dock-context button{font-size:12px}.rom-dock-rule{margin:0;font-size:11px;color:#c5bfef;line-height:1.6}.rom-dock-actions{display:grid;grid-template-columns:1fr 1fr 1.6fr;gap:7px}#reels-task-overview .rom-dock-actions button{padding:10px 6px;border-radius:8px;font-size:12px}#reels-task-overview .rom-dock-actions [data-match]{background:#6757d9;color:white;border:1px solid #b9afff;font-weight:650}#reels-task-overview .rom-dock-actions [aria-expanded="true"]{background:#494366;border-color:#b9afff;color:white}.rom-workspace-feedback{white-space:pre-wrap;font-size:12px;color:#a6dab7;overflow-wrap:anywhere;max-height:200px;overflow:auto}.rom-workspace-feedback:empty{display:none}
        `;
        workspaceNavigation={select(key){
            const next=key==='browse'?'temporary':key;
            for(const [id,{page,button}] of workspacePages){page.hidden=id!==next;button.setAttribute('aria-selected',String(id===next));button.tabIndex=id===next?0:-1;}
            // 切换素材页时，配对来源随页切换；电话库和背景库保留最近的配对来源。
            if(!sourceSelectionExplicit && [...matchSource.options].some(option=>option.value===next)){
                matchSource.value=next;sourceChecks.querySelectorAll('input').forEach(input=>{input.checked=input.dataset.matchSource===next;});syncSourceOptions();updateDock();
            }
            materialList.scrollTop=0;thumbnailLoader?.dispose();thumbnailLoader=window.BatchThumbnailLoader?.hydrate(panel);
        }};
        nav.onclick=event=>{const button=event.target.closest('[data-workspace-tab]');if(button)workspaceNavigation.select(button.dataset.workspaceTab);updateSelectionCount();};
        nav.onkeydown=event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const buttons=[...nav.querySelectorAll('button')],at=buttons.indexOf(document.activeElement),next=event.key==='Home'?0:event.key==='End'?buttons.length-1:(at+(event.key==='ArrowRight'?1:-1)+buttons.length)%buttons.length;workspaceNavigation.select(buttons[next].dataset.workspaceTab);buttons[next].focus();updateSelectionCount();};
        // Reserve the browser's collapsed height. Opening controls grows below the
        // buttons in the outer scroll, without shrinking the material browser.
        const sizeBrowser=()=>{
            if(panel.hidden)return;
            const baseHeight=[...dock.children].filter(child=>child!==settingsDock).reduce((height,child)=>height+child.getBoundingClientRect().height,0)+36;
            panel.style.setProperty('--rom-browser-height',Math.max(180,panel.clientHeight-workspaceHeader.offsetHeight-baseHeight-20)+'px');
        };
        const workbenchResize=new ResizeObserver(sizeBrowser);workbenchResize.observe(panel);workbenchResize.observe(workspaceHeader);handlers.push(()=>workbenchResize.disconnect());
        syncSourceOptions();updateDock();workspaceNavigation.select('temporary');sizeBrowser();
        settingsDock.hidden=false;manualSettings.hidden=false;matchSettings.hidden=true;dock.querySelector('[data-manual]').setAttribute('aria-expanded','true');dock.querySelector('[data-settings]').setAttribute('aria-expanded','false');
        updateTaskSelectionCount();
        refresh();
        return {refresh,refreshAllLinked,appendReplacementActions,cancelReplacement,appendPhoneActions:(...args)=>phoneLibrary?.appendReplacementActions(...args), selectionChanged:updateTaskSelectionCount, setVisible(visible){if(!visible)cancelReplacement();if(!visible && clickMode)setClickMode(false);panel.hidden=!visible;resizeHandle.hidden=!visible;taskTools.hidden=!visible;cards.forEach(card=>{const label=card.el.querySelector('.rom-task-select');if(label)label.hidden=false;});if(visible){setPanelWidth(customPanelWidth ? panelWidth : body.getBoundingClientRect().width / 2);refresh();}else{endResize();preview.pause();thumbnailLoader?.dispose();thumbnailLoader=null;}}, dispose(){cancelReplacement();flushBindingRules().catch(()=>{});disposed=true;clearTimeout(bindingSaveTimer);clearTimeout(usedBatchesTimer);usedBatches?.dispose();backgroundLibrary?.dispose();phoneLibrary?.dispose();unsubscribeLibrary?.();refresh.cancel();confirmation?.close();endResize();window.removeEventListener('resize',onResize);root.classList.remove('rom-dragging','rom-click-swapping');root._romClickSwap=false;gridObserver?.disconnect();window.removeEventListener('keydown',escapeSwap,true);window.removeEventListener('resize',onLayoutChange);root.removeEventListener('scroll',onLayoutChange,true);root.querySelectorAll('.rom-swap-feedback').forEach(node=>node.remove());thumbnailLoader?.dispose();preview.pause();preview.removeAttribute('src');preview.load();handlers.forEach(fn=>fn());taskPane.before(taskGrid);taskPane.remove();resizeHandle.remove();panel.remove();style.remove();}};
    }
    window.ReelsOverviewMediaPool = {libraryImportPaths,refreshLinkedBindings,originalGroupCandidates,relinkedGroupValue,syncPreviewVisibility,pairingFailureDetails,batchUsageReportHtml,readSourceQuantityRules,renderSourceQuantityWeights,keywordSections,materialSourceInfo,combinationReportHtml,syncCandidateBadges,replaceSingle,archiveCandidates,archiveUnits,mergeCandidatePool,previewAction,replaceCombinations,externalFileDrag,externalDropPaths,prepareExternalDrop,mount, collect, pathsOf, orderPaths, mediaSource, rememberImports, bindingOf, replacementValue, rememberFolder, listPaths, syncDirectoryImport, importDirectory, importDirectories, importGroupKey, routeDrop, mediaHit, createRefreshQueue, usageRows, distributionPairs, randomDistributionPairs, multiLayerDistributionPairs, filterUnusedPaths, filterSelectedPaths, selectedMaterialsInOrder, attachLayerHighlight, selectedTaskCards, selectTasks, setMediaChecked, updateMediaTiles, quickReplacement, libraryCategory, categorizeSections, sourceSections, materialSource, isPersistentSource};
})();
