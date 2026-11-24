/** Persistent usage belongs to the bound folder; assignments remain session-only. */
(() => {
    'use strict';
    const STORAGE = 'videokit_media_library_root_v1';
    let active = null, cachedBinding={enabled:false,keywords:[]},cachedRoot='';
    try{cachedBinding=JSON.parse(localStorage.getItem('videokit_name_binding_rules') || 'null') || cachedBinding;cachedRoot=localStorage.getItem(STORAGE) || '';}catch(_){}
    const listeners = new Set(), opened=new Map(), tracked=new Map();
    async function call(data) {
        if (!window.electronAPI?.apiCall) throw new Error('请在桌面版使用固定素材库');
        const result = await window.electronAPI.apiCall('media-library', data);
        if (!result?.success) throw new Error(result?.error || '素材库操作失败');
        return result.data;
    }
    const notify = () => {if(active){opened.set(active.root,active);if(!cachedBinding.keywords?.length)cachedBinding=active.bindingRules || {enabled:false,keywords:[]};cachedRoot=active.root;try{localStorage.setItem('videokit_name_binding_rules',JSON.stringify(cachedBinding));}catch(_){}}for (const listener of listeners) listener(active);};
    const basename = file => String(file).split(/[\\/]/).pop();
    function historyFor(paths, library) {
        const entries = paths.map(file => library ? library.history?.[file] : (opened.get(rootFor(file,true)) || tracked.get(rootFor(file,true)))?.history?.[file]).filter(Boolean);
        const count = Math.max(0, ...entries.map(entry => entry.count || 0));
        const lastUsedAt = entries.map(entry=>entry.lastUsedAt).filter(Boolean).sort().pop() || null;
        const known = entries.length > 0;
        const label = !known ? '未纳入素材库' : count ? (paths.length>1 ? `套内已用 · 最高 ${count} 次` : `历史已用 ${count} 次`) : '历史未用';
        const recent = entries.flatMap(entry=>entry.recent || []).sort((a,b)=>b.at.localeCompare(a.at)).slice(0,5);
        const detail = recent.map(item=>`${new Date(item.at).toLocaleString()} · ${item.source==='export'?'成功导出':item.source==='adoption'?'确认采用':'手动标记'}${item.taskName?' · '+item.taskName:''}`).join('\n');
        return {known,count,lastUsedAt,label,title:detail || label};
    }
    function matchesHistory(history, filter, now = Date.now()) {
        if (filter === 'all') return true;
        if (!history.known) return false;
        if (filter === 'unused') return !history.count;
        if (filter === 'used') return history.count>0;
        if (filter === 'month') return !history.lastUsedAt || now-new Date(history.lastUsedAt).getTime()>=30*86400000;
        return true;
    }
    async function open(root, action = 'refresh') {
        const result = await call({action,root});
        active = result;
        try { localStorage.setItem(STORAGE,result.root); } catch (_) {}
        notify();return active;
    }
    let restoreWarnings=[];
    async function restore({onProgress=()=>{}}={}) {
        restoreWarnings=[];
        const {roots} = await call({action:'list'});
        let last;try {last=localStorage.getItem(STORAGE);}catch(_){}
        if (!roots.length) return null;
        const selected=roots.includes(last)?last:roots[0],ordered=[...roots.filter(root=>root!==selected),selected];
        for(let index=0;index<ordered.length;index++){
            const root=ordered[index];onProgress({root,completed:index,total:ordered.length});
            try{await open(root);}catch(error){restoreWarnings.push(`${root}：${error.message}`);}
        }
        return active;
    }
    async function unbind(root=active?.root) {
        if(!root)return;
        await call({action:'unbind',root});opened.delete(root);if(active?.root===root)active=[...opened.values()].at(-1) || null;cachedRoot=active?.root || '';
        try{localStorage.removeItem(STORAGE);}catch(_){}
        notify();
    }
    async function saveBindingRules(enabled,keywords) {
        if(!active){
            keywords=[...new Set(keywords.map(value=>String(value).trim()).filter(Boolean))];
            if(enabled && !keywords.length)throw new Error('请先填写自定义关键词');
            cachedBinding={enabled:!!enabled,keywords};try{localStorage.setItem('videokit_name_binding_rules',JSON.stringify(cachedBinding));}catch(_){}notify();return {bindingRules:cachedBinding};
        }
        const result=await call({action:'binding-rules',root:active.root,enabled,keywords});
        active={...active,...result};cachedBinding=result.bindingRules;
        for(const root of opened.keys())if(root!==active.root){const saved=await call({action:'binding-rules',root,enabled,keywords});opened.set(root,{...opened.get(root),...saved});}
        notify();return active;
    }
    async function mark(paths, clear = false, root=active?.root) {
        if (!root) throw new Error('请先绑定固定素材库');
        const result = await call({action:clear?'clear':'mark',root,paths});
        const updated={...(opened.get(root) || {}),...result};opened.set(root,updated);if(active?.root===root)active=updated;notify();return updated;
    }
    function taskPaths(task, {transparent = false} = {}) {
        if (!task) return [];
        const files = [], add = value => {
            for(const item of Array.isArray(value)?value:[value]) {
                const file = typeof item==='string'?item:item?.path;
                if (file && /\.(png|jpe?g|webp|gif|bmp|mp4|mov|avi|mkv|webm|m4v)$/i.test(file)) files.push(file);
            }
        };
        if (!transparent) {
            if(task.bgMode==='multi')add(task.bgClipActivePool?.length?task.bgClipActivePool:task.bgClipPool);
            else add(task.bgPath || task.videoPath || task.backgroundPath);
            add(task.contentVideoPath);add(task.hookFile);if(task.cover?.enabled)add(task.cover.bgPath);
        }
        const overlays=window.ReelsRenderPlan?.getCompositedOverlays?.(task,{forExport:true}) || task.overlays || [];
        for(const ov of overlays) if(ov && !ov.disabled && ['image','video'].includes(ov.type))add(ov.media_folder_files?.length?ov.media_folder_files:ov.content);
        return [...new Set(files)];
    }
    // Called only after each artifact was written successfully. History failures cannot fail an export.
    async function recordExport(task, output, options = {}) {
        try {
            await adoptionQueue.catch(()=>{});
            const records=[task._mediaAdoption,...(task._mediaUsageRecords || [])].filter(Boolean);
            const used=new Set(records.filter(record=>record===task._mediaAdoption || record.recorded).flatMap(record=>record.paths));
            const paths=taskPaths(task,options).filter(file=>!used.has(file));if(!paths.length)return;
            const {results}=await call({action:'record-export',paths,temporaryRoots:[...tracked.keys()],output,taskName:task.fileName || task.taskName || task.name || basename(output),eventId:options.eventId || (window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`)});
            const warnings=results.filter(result=>result.error || result.unsynced).map(result=>result.error || result.warning);
            if(warnings.length) {
                console.warn('[MediaLibrary]',warnings.join('\n'));
                window.showToast?.('成片已导出；素材使用记录未全部同步，请刷新对应的素材文件夹检查。','warning',7000);
            }
            for(const result of results.filter(result=>!result.error)){
                if(opened.has(result.root))opened.set(result.root,{...opened.get(result.root),...result});
                if(tracked.has(result.root))tracked.set(result.root,{...tracked.get(result.root),...result});
                if(result.root===active?.root)active={...active,...result};
            }
            notify();
        } catch(error) {
            console.warn('[MediaLibrary] 使用记录保存失败：',error);
            window.showToast?.('成片已导出；素材使用记录保存失败，请检查对应素材文件夹的记录。','warning',7000);
        }
    }
    const inside=(root,file)=>String(file).replace(/\\/g,'/').startsWith(String(root).replace(/\\/g,'/').replace(/\/+$/,'')+'/');
    function rootFor(file,includeTemporary=false){return [...opened.keys(),...(includeTemporary?tracked.keys():[])].filter(root=>inside(root,file)).sort((a,b)=>b.length-a.length)[0] || '';}
    async function track(root,paths){const result=await call({action:'track',root,paths});tracked.set(result.root,result);for(const listener of listeners)listener(active);return result;}
    async function adoption(record,used){
        const results=[];
        try{
            for(const root of record.roots){
                const paths=record.paths.filter(file=>inside(root,file));if(!paths.length)continue;
                const result=await call({action:'adoption',root,paths,eventId:record.eventId,used,limit:record.limit || 0,taskName:record.taskName});
                if(opened.has(root))opened.set(root,{...opened.get(root),...result});else tracked.set(root,{...tracked.get(root),...result});
                if(active?.root===root)active={...active,...result};results.push(root);
            }
        }catch(error){
            if(used)for(const root of results){const reverted=await call({action:'adoption',root,paths:record.paths.filter(file=>inside(root,file)),eventId:record.eventId,used:false}).catch(()=>null);if(reverted){if(opened.has(root))opened.set(root,{...opened.get(root),...reverted});else tracked.set(root,{...tracked.get(root),...reverted});if(active?.root===root)active={...active,...reverted};}}
            notify();
            throw error;
        }
        record.recorded=used;notify();
    }
    let adoptionQueue=Promise.resolve();
    function enqueueUsage(action){
        const operation=adoptionQueue.catch(()=>{}).then(action);
        adoptionQueue=operation.catch(error=>window.showToast?.(`使用记录同步失败：${error.message}`,'warning'));
        return operation;
    }
    function makeUsage(task,paths,{root=''}={}){
        paths=[...new Set(paths)].filter(Boolean);if(!paths.length)return null;
        const roots=[...new Set(paths.map(file=>rootFor(file,true) || root || String(file).replace(/[\\/][^\\/]+$/,'')))];
        const record={eventId:window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`,paths,roots,taskName:task.fileName || task.name || '媒体分配',recorded:false};
        (task._mediaUsageRecords ||= []).push(record);return record;
    }
    function recordUses(changes){
        const entries=changes.map(change=>({task:change.task,record:makeUsage(change.task,change.paths,change.options)}));
        const ready=enqueueUsage(async()=>{
            const byRoot=new Map(),completed=[];
            for(const {record} of entries)if(record)for(const root of record.roots){
                if(!byRoot.has(root))byRoot.set(root,[]);
                byRoot.get(root).push({...record,paths:record.paths.filter(file=>inside(root,file)),used:true});
            }
            const update=(root,result)=>{
                if(opened.has(root))opened.set(root,{...opened.get(root),...result});else tracked.set(root,result);
                if(active?.root===root)active={...active,...result};
            };
            try{
                for(const [root,records] of byRoot){
                    update(root,await call({action:'adoption-batch',root,records}));completed.push(root);
                }
                for(const {record} of entries)if(record)record.recorded=true;
            }catch(error){
                const failures=[];
                for(const root of completed)try{update(root,await call({action:'adoption-batch',root,records:byRoot.get(root).map(record=>({...record,used:false}))}));}catch(failure){failures.push(failure.message);}
                if(failures.length)throw new Error(`${error.message}；使用记录回滚未完成：${failures.join('；')}`);
                throw error;
            }finally{notify();}
            window.reelsScheduleUnifiedProjectSave?.();
        });
        return {entries,ready};
    }
    function recordUse(task,paths,{root=''}={}){
        paths=[...new Set(paths)].filter(Boolean);if(!paths.length)return null;
        const roots=[...new Set(paths.map(file=>rootFor(file,true) || root || String(file).replace(/[\\/][^\\/]+$/,'')))];
        const record={eventId:window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`,paths,roots,taskName:task.fileName || task.name || '媒体分配',recorded:false};
        (task._mediaUsageRecords ||= []).push(record);
        const ready=enqueueUsage(async()=>{
            for(const directory of roots)if(!opened.has(directory) && !tracked.has(directory))await track(directory,paths.filter(file=>inside(directory,file)));
            await adoption(record,true);record.recorded=true;
            if(window.reelsScheduleUnifiedProjectSave)window.reelsScheduleUnifiedProjectSave();
            else window._batchAutoSave?.({skipSync:true});
        });
        return {record,ready};
    }
    function cancelUse(task,record){
        if(!record)return Promise.resolve();
        task._mediaUsageRecords=(task._mediaUsageRecords || []).filter(item=>item.eventId!==record.eventId);
        return enqueueUsage(()=>adoption(record,false));
    }
    function transitionAdoptions(before,after){
        const records=tasks=>new Map((tasks || []).flatMap(task=>[task._mediaAdoption,...(task._mediaUsageRecords || [])].filter(Boolean)).map(record=>[record.eventId,record]));
        const old=records(before),next=records(after);
        const changes=[...[...old].filter(([id])=>!next.has(id)).map(([,record])=>[record,false]),...[...next].filter(([id])=>!old.has(id)).map(([,record])=>[record,true])];
        adoptionQueue=adoptionQueue.catch(()=>{}).then(async()=>{for(const [record,used] of changes)await adoption(record,used);});
        adoptionQueue.catch(error=>window.showToast?.(`使用记录同步失败：${error.message}`,'warning'));return adoptionQueue;
    }
    function relocatePaths(mappings){
        for(const [key,value] of [...opened]){window.ReelsMediaRelocation.remap(value,mappings);if(value.root!==key)opened.delete(key);opened.set(value.root,value);}
        for(const [key,value] of [...tracked]){window.ReelsMediaRelocation.remap(value,mappings);if(value.root!==key)tracked.delete(key);tracked.set(value.root,value);}
        if(active)window.ReelsMediaRelocation.remap(active,mappings);
    }
    window.ReelsMediaLibrary={relocatePaths,recordUse,recordUses,cancelUse,flushUsage:()=>adoptionQueue,track,adoption,transitionAdoptions,rootFor,get opened(){return [...opened.values()];},get tracked(){return [...tracked.values()];},open,restore,get restoreWarnings(){return restoreWarnings.slice();},unbind,mark,saveBindingRules,get bindingRules(){return cachedBinding;},get root(){return active?.root || cachedRoot;},historyFor,matchesHistory,taskPaths,recordExport,
        list:()=>call({action:'list'}),get active(){return active;},subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);}};
})();
