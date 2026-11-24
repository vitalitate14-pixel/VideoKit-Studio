/** Temporary and batch media can archive into historical batches; persistent libraries track usage in .videokit-library.json instead. */
(function(root,factory){
    if(typeof module==='object' && module.exports)module.exports=factory();
    else root.ReelsUsedBatches=factory();
})(typeof window==='object'?window:globalThis,function(){
    const normalize=value=>String(value || '').replace(/\\/g,'/');
    const isPersistent=origin=>origin==='library' || origin==='characters';
    const batchId=value=>isPersistent(value?.origin)?'':(normalize(typeof value==='string'?value:value?.path || '').match(/(?:^|\/)本批已经使用\/([^/]+)/)?.[1] || value?.archiveBatchId || '');
    const isHistorical=item=>!isPersistent(item?.origin) && (!!batchId(item) || [typeof item==='string'?item:item?.path,...(item?.files || [])].some(path=>/(?:^|\/)本批已经使用(?:\/|$)/.test(normalize(path))));
    function cancelAll(state,items=[],candidates=[]){
        state.enabled ||= {};
        const ids=new Set(Object.keys(state.enabled));
        for(const item of [...items,...candidates]){
            if(isPersistent(item?.origin))continue;
            for(const value of [item,...(item?.files || [])]){const id=batchId(value);if(id)ids.add(id);}
        }
        for(const id of ids)state.enabled[id]=false;
        const retained=candidates.filter(item=>!isHistorical(item)),removed=candidates.length-retained.length;
        candidates.splice(0,candidates.length,...retained);
        return {batches:ids.size,removed};
    }
    function enabled(item,state){
        if(isPersistent(item?.origin))return true;
        const paths=[typeof item==='string'?item:item?.path,...(item?.files || [])].filter(Boolean);
        const ids=new Set([batchId(item),...paths.map(batchId)].filter(Boolean));
        if(paths.some(path=>/(?:^|\/)本批已经使用(?:\/|$)/.test(normalize(path))) && !ids.size)return false;
        return [...ids].every(id=>state?.enabled?.[id]===true);
    }
    function shouldMove(item,state){
        const origin=item?.origin || 'temporary';
        if(isPersistent(origin))return false;
        return state?.moveAfterUse?.[origin] ?? true;
    }
    function setBatchEnabled(state,id,origin,checked){
        if(isPersistent(origin))return;
        (state.enabled ||= {})[id]=checked;
    }
    function mergeRoots(previous,current){
        const roots=new Map();
        for(const entry of [...previous,...current]){
            if(!entry?.root || isPersistent(entry.origin))continue;
            const root=normalize(entry.root).split('/本批已经使用')[0].replace(/\/+$/,'');
            if(root)roots.set(root,{root,origin:'temporary'});
        }
        return [...roots.values()];
    }
    function mount(container,{state,getRoots,api,save,register,onChange,thumbnails,mediaSource,escape,isChecked=()=>false,hosts={},repair,addCandidates,candidatePool=[],onCancelAll}){
        state.enabled ||= {};state.roots ||= [];
        let disposed=false,busy=false,lastSignature='',loaded=[],pending=false,pendingForce=false;const waiters=[];
        const section=document.createElement('details');section.className='rom-used-batches rom-settings';section.open=true;
        section.innerHTML='<summary data-used-title>历史已用批次 · 临时素材归档</summary><div class="rom-tools"><button data-used-refresh>读取／刷新已用批次</button><button data-used-add>添加临时素材根目录查看批次</button><button data-used-repair>修复批次文件夹位置</button></div><small>按归档时间分批显示临时素材的历史已用批次，默认不参与匹配；需要复用时可逐批打开“参与本次随机”，或点击“全选参与随机”。历史批次复用时保留原目录，不再搬动。固定素材库与爆贴人物库常驻原位，直接通过库内使用次数与时间筛选管理。</small><output data-used-status role="status" style="display:block;font-size:11px;margin:8px 0"></output><div data-used-list></div>';
        const moveSettings=document.createElement('div');moveSettings.className='rom-tools';
        moveSettings.innerHTML='<strong>使用后移动到“本批已经使用”</strong>'+[['temporary','临时素材'],['batch','本批素材']].map(([origin,label])=>`<label style="display:inline-flex;align-items:center;gap:5px"><input data-used-move="${origin}" type="checkbox" style="width:auto" ${shouldMove({origin},state)?'checked':''}>${label}</label>`).join('')+'<small style="display:block;width:100%">临时素材和本批素材默认在使用后移入“本批已经使用”；固定素材库与爆贴人物库始终保留原位置，仅记录使用次数与时间。设置随工程保存，对单次替换和组合替换均生效。</small>';
        section.querySelector('summary').after(moveSettings);
        moveSettings.onchange=event=>{const input=event.target.closest('[data-used-move]');if(!input)return;(state.moveAfterUse ||= {})[input.dataset.usedMove]=input.checked;save();};
        container.prepend(section);
        const q=selector=>section.querySelector(selector);
        const sourceLists=Object.fromEntries(Object.entries(hosts).filter(([origin])=>!isPersistent(origin)).map(([origin,host])=>{const list=document.createElement('div');list.dataset.usedSource=origin;host.appendChild(list);return [origin,list];}));
        const surfaces=()=>[section,...Object.values(sourceLists)];
        const selectionTools='<div class="rom-tools"><button data-used-select="all">全选参与随机</button><button data-used-select="none">取消全选</button><button data-used-cancel-all title="关闭临时素材历史批次参与，并移出候选池中的历史素材">取消所有历史参与</button>'+(addCandidates?'<button data-used-candidate-enabled>已启用批次加入候选池</button>':'')+'</div>';
        const batchEnabled=batch=>batch.items.every(item=>enabled(item,state));
        const label=batch=>{const date=new Date(batch.at);return Number.isNaN(date.getTime())?batch.id:date.toLocaleString();};
        function render(){
            if(disposed)return;
            const expanded=new Set(surfaces().flatMap(surface=>[...surface.querySelectorAll('[data-used-batch-id][open]')]).map(node=>node.dataset.usedBatchId));
            q('[data-used-title]').textContent=`历史已用批次 · ${loaded.length} 批 · 已启用 ${loaded.filter(batch=>batchEnabled(batch)).length} 批`;
            const markup=batches=>batches.map(batch=>`<details data-used-batch-id="${escape(batch.id)}" ${expanded.has(batch.id)?'open':''} class="rom-used-batch" style="border:1px solid #555;border-radius:6px;padding:6px;margin:8px 0"><summary style="overflow-wrap:anywhere">${escape(label(batch))} · ${batch.items.length} 组 · ${batchEnabled(batch)?'参与随机':'不参与随机'}</summary><label style="display:block;margin:8px 0"><input data-used-enable="${escape(batch.id)}" data-used-origin="temporary" type="checkbox" style="width:auto" ${batchEnabled(batch)?'checked':''}>参与本次随机</label>${addCandidates?`<button data-used-candidate-batch="${escape(batch.id)}">本批加入候选池</button>`:''}${batch.recoveryAvailable && batch.transactionId?`<button data-used-recovery="${escape(batch.id)}">生成并查看恢复工程</button>`:''}<small title="${escape(batch.directories.join('\n'))}">${escape(batch.directories.join('\n'))}</small><div class="rom-grid" style="margin-top:8px">${batch.items.map(item=>{
                const src=mediaSource(item.files[0]),isImage=/\.(png|jpe?g|webp|gif|bmp)$/i.test(item.files[0]);
                const thumb=!src?'文件不可读取':isImage?`<img crossorigin="anonymous" loading="lazy" src="${escape(src)}">`:`<video crossorigin="anonymous" class="rbt-thumb-previewable" data-thumb-size="320" data-path="${escape(item.path)}" data-thumb-src="${escape(src)}#t=0.1" muted preload="none"></video>`;
                return `<div class="rom-item" draggable="false" data-origin="temporary" data-group="unclassified" data-path="${escape(item.path)}"><label class="rom-check-label"><input class="rom-check" type="checkbox" style="width:auto" ${isChecked(item)?'checked':''}>选中入池</label>${thumb}<span><b>${escape(item.name)}</b><small>临时素材 · ${escape(label(batch))}</small><small>历史批次 · ${batchEnabled(batch)?'参与随机':'未启用，不参与随机'}</small></span></div>`;
            }).join('')}</div></details>`).join('') || '<p class="rom-hint">已读取的临时素材目录下暂无已用批次；可添加包含“本批已经使用”的临时素材根目录。</p>';
            if(Object.keys(sourceLists).length){
                q('[data-used-list]').innerHTML='<small>历史批次位于“临时素材”列表下方；可逐批或全选控制是否参与。</small>';
                for(const [origin,list] of Object.entries(sourceLists))list.innerHTML=selectionTools+markup(loaded.map(batch=>({...batch,items:batch.items.filter(item=>item.origin===origin)})).filter(batch=>batch.items.length));
            }else q('[data-used-list]').innerHTML=selectionTools+markup(loaded);
            surfaces().flatMap(surface=>[...surface.querySelectorAll('.rom-used-batch')]).forEach(node=>node.ontoggle=()=>thumbnails?.());
            thumbnails?.();
        }
        async function refresh(force=false){
            const currentRoots=getRoots(),roots=mergeRoots(state.roots,currentRoots),signature=JSON.stringify(roots);
            if(disposed || (!force && signature===lastSignature))return;
            if(busy){pending=true;pendingForce ||= force;return;}
            if(!roots.length){state.roots=[];loaded=[];lastSignature=signature;render();return;}
            busy=true;lastSignature=signature;q('[data-used-refresh]').disabled=true;q('[data-used-refresh]').textContent='正在读取批次…';
            q('[data-used-status]').textContent='正在扫描历史批次，仅加载清单和媒体路径…';
            try{
                const response=await api.apiCall('batch-used-media',{action:'list',roots});
                if(!response?.success)throw new Error(response?.error || '读取批次失败');if(disposed)return;
                state.roots=roots;loaded=(response.data.batches || []).map(batch=>({...batch,items:(batch.items || []).filter(item=>!isPersistent(item.origin))})).filter(batch=>batch.items.length);
                for(const batch of loaded)for(const item of batch.items)register(item);
                save();render();q('[data-used-status]').textContent=response.data.warnings?.join('；') || `已加载 ${loaded.length} 个历史批次，临时素材按批次开关参与。`;
                onChange();
            }catch(error){if(!disposed)q('[data-used-status]').textContent=error.message;lastSignature='';}
            finally{busy=false;if(!disposed){q('[data-used-refresh]').disabled=false;q('[data-used-refresh]').textContent='读取／刷新已用批次';if(pending){const force=pendingForce;pending=false;pendingForce=false;refresh(force);}}if(!busy)waiters.splice(0).forEach(resolve=>resolve());}
        }
        q('[data-used-repair]').hidden=!repair;
        q('[data-used-repair]').onclick=async()=>{
            if(busy)return;const button=q('[data-used-repair]');button.disabled=true;button.textContent='正在整理归档位置…';q('[data-used-status]').textContent='正在检查素材组内部误建的批次文件夹…';
            try{const currentRoots=getRoots(),result=await repair(mergeRoots(state.roots,currentRoots));await refresh(true);q('[data-used-status]').textContent=result.repaired?`已整理 ${result.repaired} 个文件／素材组，任务路径已同步到库根目录下的批次文件夹。`:'未发现需要修复的嵌套批次目录。';}
            catch(error){q('[data-used-status]').textContent=`整理失败：${error.message}`;}
            finally{button.disabled=false;button.textContent='修复批次文件夹位置';}
        };
        q('[data-used-refresh]').onclick=()=>refresh(true);
        q('[data-used-add]').onclick=async()=>{const root=await api.selectDirectory?.();if(root){state.roots=mergeRoots(state.roots,[{root,origin:'temporary'}]);save();refresh(true);}};
        const onToggle=event=>{
            const input=event.target.closest('[data-used-enable]');if(!input)return;
            setBatchEnabled(state,input.dataset.usedEnable,input.dataset.usedOrigin,input.checked);save();render();onChange();
        };
        const onRecovery=async event=>{
            if(event.target.closest('[data-used-cancel-all]')){
                const result=cancelAll(state,loaded.flatMap(batch=>batch.items),candidatePool);
                onCancelAll?.();save();render();onChange();
                q('[data-used-status]').textContent=`已取消所有临时历史批次参与，移出候选池中的 ${result.removed} 个历史素材`;
                return;
            }
            const candidate=event.target.closest('[data-used-candidate-enabled],[data-used-candidate-batch]');
            if(candidate && addCandidates){
                const origin=event.currentTarget.dataset?.usedSource,batchId=candidate.dataset.usedCandidateBatch;
                const items=loaded.filter(batch=>!batchId || batch.id===batchId)
                    .flatMap(batch=>batch.items).filter(item=>(!origin || item.origin===origin) && (batchId || enabled(item,state)));
                if(!items.length){q('[data-used-status]').textContent='请先开启要加入候选池的历史批次';return;}
                candidate.disabled=true;
                try{await addCandidates(items);q('[data-used-status]').textContent='历史素材已加入候选池，可在候选池中查看和匹配';}
                catch(error){q('[data-used-status]').textContent=`加入候选池失败：${error.message}`;}
                finally{candidate.disabled=false;}
                return;
            }
            const select=event.target.closest('[data-used-select]');
            if(select){
                const origin=event.currentTarget.dataset?.usedSource;
                const batches=loaded.filter(batch=>!origin || batch.items.some(item=>item.origin===origin));
                const checked=select.dataset.usedSelect==='all';
                for(const batch of batches)setBatchEnabled(state,batch.id,origin || 'temporary',checked);
                save();render();onChange();
                q('[data-used-status]').textContent=`已${checked?'启用':'取消'}${batches.length} 个批次参与本次随机`;
                return;
            }
            const button=event.target.closest('[data-used-recovery]');if(!button || busy)return;
            const batch=loaded.find(batch=>batch.id===button.dataset.usedRecovery);if(!batch)return;
            button.disabled=true;
            try{
                const response=await api.apiCall('batch-used-media',{action:'recover-project',id:batch.transactionId,directories:batch.directories});
                if(!response?.success)throw new Error(response?.error || '生成恢复工程失败');
                api.showItemInFolder?.(response.data.filePath);
                q('[data-used-status]').textContent='已生成恢复工程，可通过工程导入打开；当前任务未改变。';
            }catch(error){q('[data-used-status]').textContent=error.message;}
            finally{button.disabled=false;}
        };
        q('[data-used-list]').onclick=onRecovery;for(const list of Object.values(sourceLists))list.onclick=onRecovery;
        q('[data-used-list]').onchange=onToggle;for(const list of Object.values(sourceLists))list.onchange=onToggle;
        return {refresh,ready:()=>busy?new Promise(resolve=>waiters.push(resolve)):Promise.resolve(),items:source=>isPersistent(source)?[]:loaded.flatMap(batch=>batch.items).filter(item=>!source || item.origin===source),dispose(){disposed=true;waiters.splice(0).forEach(resolve=>resolve());section.remove();Object.values(sourceLists).forEach(list=>list.remove());}};
    }
    return {batchId,isHistorical,cancelAll,enabled,shouldMove,setBatchEnabled,mergeRoots,mount};
});
