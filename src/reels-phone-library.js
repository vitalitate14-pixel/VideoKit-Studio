/** Phone media have their own library and may only be assigned to phone slots. */
(() => {
    'use strict';
    const KEY='videokit_phone_library_roots_v1';
    const valid=path=>/\.(mp4|mov|avi|mkv|webm|m4v|jpe?g|png|webp|gif|bmp)$/i.test(path || '');
    const image=path=>/\.(jpe?g|png|webp|gif|bmp)$/i.test(path || '');
    const basename=path=>String(path || '').split(/[\\/]/).pop();
    const folderOf=path=>String(path || '').replace(/\\/g,'/').replace(/\/[^/]*$/,'');
    const esc=value=>String(value || '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const valueFor=path=>({content:path,type:image(path)?'image':'video',media_loop:true,media_folder_path:'',media_folder_files:[]});
    const phoneItem=path=>({id:path,path,name:basename(path),phone:true,keywords:window.ReelsNameBinding.match(basename(path)),
        history:window.ReelsMediaLibrary?.historyFor?.([path])?.count || 0});
    function phoneCombinations(rows){
        return rows.filter(row=>row.path).map(row=>{
            const item=phoneItem(row.path),keyword=row.keys.find(key=>item.keywords.includes(key)) || row.keys[0];
            return {keyword,pairs:[{item}]};
        });
    }
    function pairingSlots(selected,phoneGroup){
        const isPhone=window.ReelsNameBinding.isPhoneGroup;
        if(!phoneGroup || !isPhone(phoneGroup))throw new Error('随机组合需要电话层，请先设置电话主层并绑定电话库');
        if(!selected.some(slot=>!isPhone(slot)))throw new Error('请至少勾选一个画中画或其他媒体层，与电话层一起配对');
        return [...new Map([...selected,phoneGroup].map(slot=>[slot.key,slot])).values()];
    }
    function defaultReferenceLayers(groups){
        const media=groups.filter(group=>!window.ReelsNameBinding.isPhoneGroup(group) && !window.ReelsNameBinding.isIndependentGroup?.(group));
        const preferred=media.filter(group=>/pip_audience|pip_secondary/.test(group.mediaSlot || group.key || '') || /画中画.*观众|画中画次层/.test(group.label || ''));
        return (preferred.length?preferred:media.filter(group=>group.field==='pip').slice(0,2)).map(group=>group.key);
    }
    function materialKeywords(task,layers,read){
        const rules=window.ReelsNameBinding;
        const choices=layers.filter(layer=>!rules.isPhoneGroup(layer) && !rules.isIndependentGroup?.(layer,task)).map(layer=>({layer,keys:[...new Set(rules.namesOf(read(task,layer),layer).flatMap(name=>rules.match(name)))]})).filter(entry=>entry.keys.length);
        if(!choices.length)return {keys:[],reason:'所选参考层的素材未命中名字关键词'};
        const keys=choices.reduce((shared,entry)=>shared.filter(key=>entry.keys.includes(key)),choices[0].keys);
        return keys.length?{keys,reason:''}:{keys,reason:`参考层关键词冲突：${choices.map(entry=>`${entry.layer.label || entry.layer.key}（${entry.keys.join(' / ')}）`).join('；')}`};
    }
    function matchExistingTasks(cards,layers,phoneGroup,phones,{read,available=()=>true,random=Math.random}={}){
        const rules=window.ReelsNameBinding;
        if(!rules.enabled)throw new Error('请先启用并保存共用名字绑定关键词');
        if(!phoneGroup || !rules.isPhoneGroup(phoneGroup))throw new Error('请先选择固定电话层');
        layers=layers.filter(layer=>!rules.isPhoneGroup(layer));
        if(!layers.length)throw new Error('请至少勾选一个参考媒体层');
        const candidates=[...new Set(phones)].filter(available).map(path=>({path,keys:rules.match(basename(path))}));
        const result=[],planner=window.ReelsCombinationPlanner;
        const history=planner?.phoneHistory(candidates.map(item=>phoneItem(item.path)));
        for(const card of cards){
            const {keys,reason}=materialKeywords(card.task,layers,read),current=read(card.task,phoneGroup)?.content || '';
            const choices=keys.length?candidates.filter(item=>item.keys.some(key=>keys.includes(key))).map(item=>item.path):[];
            let path;
            if(planner && choices.length){
                const keyword=keys.find(key=>candidates.some(item=>choices.includes(item.path) && item.keys.includes(key)));
                const items=choices.map(phoneItem).filter(item=>item.keywords.includes(keyword));
                const first=planner.orderPhones(items,phoneCombinations(result),keyword,history,random)[0];
                path=choices.includes(current) && items.some(item=>item.path===current) && planner.phoneGroup(phoneItem(current)).key===planner.phoneGroup(first).key?current:first.path;
            }else path=choices.includes(current)?current:choices[Math.min(choices.length-1,Math.floor(random()*choices.length))] || '';
            result.push({card,current,path,keys,choices,reason:reason || (!choices.length?`没有匹配 ${keys.join(' / ')} 的可用电话`:'')});
        }
        return result;
    }
    function referenceFiles(value,group){
        const files=group.field==='bg'?(value?.bgMode==='multi'?(value.bgClipActivePool?.length?value.bgClipActivePool:value.bgClipPool || []):[value?.bgPath || value?.videoPath]):value?.media_folder_files?.length?value.media_folder_files:[value?.content];
        return [...new Set(files.map(file=>typeof file==='string'?file:file?.path).filter(valid))];
    }
    function rerollExistingPhone(row,{available=()=>true,random=Math.random,rows=[]}={}){
        const choices=row.choices.filter(path=>path!==row.path && available(path) && window.ReelsNameBinding.match(basename(path)).some(key=>row.keys.includes(key)));
        if(!choices.length)throw new Error('没有其他符合当前参考层关键词的可用电话，原选择已保留');
        const planner=window.ReelsCombinationPlanner,items=choices.map(phoneItem);
        const keyword=row.keys.find(key=>items.some(item=>item.keywords.includes(key)));
        const first=planner?.orderPhones(items.filter(item=>item.keywords.includes(keyword)),phoneCombinations(rows.filter(other=>other!==row)),keyword,planner.phoneHistory(row.choices.map(phoneItem)),random)[0];
        return {...row,path:first?.path || choices[Math.min(choices.length-1,Math.floor(random()*choices.length))]};
    }
    function replacementChoices(card,layers,phoneGroup,phones,{read,available=()=>true}={}){
        if(!window.ReelsNameBinding.enabled)throw new Error('请先启用名字固定组合并设置关键词，再按关键词更换电话');
        if(!phoneGroup || !window.ReelsNameBinding.isPhoneGroup(phoneGroup))throw new Error('请选择已有电话层');
        const {keys,reason}=materialKeywords(card.task,layers,read);
        const current=read(card.task,phoneGroup)?.content || '';
        const choices=keys.length?[...new Set(phones)].filter(path=>valid(path) && available(path) && window.ReelsNameBinding.match(basename(path)).some(key=>keys.includes(key))):[];
        return {card,current,path:current,keys,choices,reason:reason || (!choices.some(path=>path!==current)?`没有其他匹配「${keys.join(' / ')}」的可用电话，原电话已保留`:'')};
    }
    function validateReplacement(row,path,options){
        const fresh=replacementChoices(row.card,options.layers,options.phoneGroup,options.phones,options);
        if(fresh.current!==row.current)throw new Error('此任务的电话已发生变化，请重新打开选择');
        if(path===fresh.current || !fresh.choices.includes(path))throw new Error(fresh.reason || '候选电话已失效或关键词已变化，请重新选择');
        return {...fresh,path};
    }
    // Shared by overview cards, the main preview and the task list.
    function createReplacementController(hooks){
        const groups=hooks.groups.filter(group=>window.ReelsNameBinding.isPhoneGroup(group));
        const replacementLayers=hooks.layers,allPhonePaths=hooks.phones;
        const status=hooks.status || (()=>{});
        let disposed=false,replacing=false,replaceDialog=null;
        const replacementRow=(card,phoneGroup)=>replacementChoices(card,replacementLayers(),phoneGroup,allPhonePaths(),{read:hooks.read,available:hooks.mediaSource});
        async function applyReplacement(row,path){
            if(disposed || replacing)throw new Error('正在更换电话，请稍候');
            const fresh=validateReplacement(row,path,{layers:replacementLayers(),phoneGroup:row.phoneGroup,phones:allPhonePaths(),read:hooks.read,available:hooks.mediaSource});
            replacing=true;
            try{
                await hooks.applyMatched([fresh],row.phoneGroup,replacementLayers());
                window.showToast?.(`已更换任务 ${row.card.id+1} 的电话 · ${fresh.keys.join(' / ')}，可撤销`,'success');
            }finally{replacing=false;}
        }
        async function replaceOnCard(card,phoneGroup,mode='choose'){
            try{
                await hooks.ready?.();if(disposed)return;
                if(hooks.busy?.() || replacing)throw new Error('电话库正在处理素材，请稍后重试');
                const row={...replacementRow(card,phoneGroup),phoneGroup};
                const choices=row.choices.filter(path=>path!==row.current);
                if(!choices.length)throw new Error(row.reason || '没有其他符合关键词的电话，原电话已保留');
                if(mode==='random'){
                    const next=rerollExistingPhone(row,{available:hooks.mediaSource});await applyReplacement(row,next.path);return;
                }
                replaceDialog?.close();
                const dialog=document.createElement('dialog');replaceDialog=dialog;dialog.className='rom-confirm rom-phone-replacement';
                dialog.style.cssText='position:fixed;inset:0;margin:auto;width:min(960px,94vw);max-height:90vh;padding:18px;overflow:auto;background:#242631;color:#eee;border:1px solid #777;border-radius:12px';
                dialog.innerHTML='<h3>更换电话 · 按关键词匹配</h3><p data-summary></p><input data-search placeholder="搜索候选电话文件名" aria-label="搜索候选电话"><p data-count role="status"></p><div data-grid style="display:grid;grid-template-columns:repeat(auto-fill,minmax(135px,1fr));gap:10px;max-height:58vh;overflow:auto"></div><p data-message role="status" style="color:#f4d59e"></p><div style="display:flex;gap:10px;justify-content:flex-end;margin-top:12px"><button data-cancel>取消</button><button data-apply disabled>应用所选电话</button></div>';
                const q=selector=>dialog.querySelector(selector);let selected='',applying=false,thumbnailLoader;
                q('[data-summary]').textContent=`任务 ${card.id+1} · ${phoneGroup.label}；匹配关键词：${row.keys.join(' / ')}。当前：${basename(row.current)}。候选来自全部已加载电话库，保留文案、其他媒体和布局。`;
                const videos=()=>dialog.querySelectorAll('video');
                const release=()=>{thumbnailLoader?.dispose();thumbnailLoader=null;videos().forEach(video=>{video.pause();video.removeAttribute('src');video.load();});};
                const render=()=>{
                    release();q('[data-grid]').replaceChildren();
                    const query=q('[data-search]').value.trim().toLocaleLowerCase(),filtered=choices.filter(path=>basename(path).toLocaleLowerCase().includes(query));
                    q('[data-count]').textContent=`符合关键词 ${choices.length} 个 · 显示 ${filtered.length} 个（已排除当前电话）`;
                    for(const path of filtered){
                        const button=document.createElement('button');button.type='button';button.style.cssText='padding:6px;background:#181b25;color:#eee;border:2px solid #4b5065;border-radius:8px;cursor:pointer;min-width:0';button.title=path;button.setAttribute('aria-label','选择电话 '+basename(path));button.setAttribute('aria-pressed',String(path===selected));
                        const media=document.createElement(image(path)?'img':'video'),src=hooks.mediaSource(path);media.crossOrigin='anonymous';
                        media.style.cssText='width:100%;height:145px;object-fit:contain;background:#090b10;display:block';
                        if(image(path)){media.loading='lazy';media.src=src;media.alt=basename(path);}
                        else{media.muted=true;media.playsInline=true;media.preload='none';media.className='rbt-thumb-previewable';media.dataset.thumbSrc=src;media.dataset.thumbSize='180';media.title=basename(path);}
                        const label=document.createElement('span');label.textContent=basename(path);label.style.cssText='display:block;overflow-wrap:anywhere;font-size:11px;margin-top:6px';button.append(media,label);
                        button.onclick=()=>{if(applying)return;selected=path;for(const other of q('[data-grid]').children){const picked=other===button;other.style.borderColor=picked?'#b19aff':'#4b5065';other.setAttribute('aria-pressed',String(picked));}q('[data-apply]').disabled=false;q('[data-message]').textContent='已选：'+basename(path);};
                        if(path===selected)button.style.borderColor='#b19aff';q('[data-grid]').appendChild(button);
                    }
                    thumbnailLoader=window.BatchThumbnailLoader?.hydrate(dialog);
                };
                q('[data-search]').oninput=render;q('[data-cancel]').onclick=()=>{if(!applying)dialog.close();};
                dialog.oncancel=event=>{if(applying)event.preventDefault();};
                q('[data-apply]').onclick=async()=>{
                    if(applying || !selected)return;applying=true;dialog.setAttribute('aria-busy','true');dialog.querySelectorAll('button,input').forEach(el=>el.disabled=true);
                    try{await applyReplacement(row,selected);dialog.close();}catch(error){q('[data-message]').textContent=error.message;}
                    finally{applying=false;if(dialog.isConnected){dialog.removeAttribute('aria-busy');dialog.querySelectorAll('button,input').forEach(el=>el.disabled=false);}}
                };
                dialog.onclose=()=>{release();dialog.remove();if(replaceDialog===dialog)replaceDialog=null;hooks.thumbnails?.();};
                document.body.appendChild(dialog);dialog.showModal();render();q('[data-search]').focus();
            }catch(error){window.showToast?.(error.message,'warning');status(error.message);}
        }
        function appendReplacementActions(menu,card,overlay,onClose){
            const applied=groups.filter(phoneGroup=>hooks.read(card.task,phoneGroup)?.content);
            const hit=overlay && applied.find(phoneGroup=>[overlay.slotKey,overlay._templateOverlayId,overlay.id].filter(Boolean).includes(phoneGroup.mediaSlot || String(phoneGroup.key).replace(/^pip:/,'')));
            for(const phoneGroup of hit?[hit]:applied){
                for(const [mode,label] of [['random','随机换一个'],['choose','看缩略图选择']]){
                    const button=document.createElement('button');button.setAttribute('role','menuitem');button.textContent=`☎ ${applied.length>1?phoneGroup.label+' · ':''}更换电话：${label}`;
                    button.onclick=()=>{menu.remove();onClose?.();return replaceOnCard(card,phoneGroup,mode);};menu.appendChild(button);
                }
            }
        }
        return {appendReplacementActions,replaceOnCard,dispose(){disposed=true;replaceDialog?.close();}};
    }
    function mount(container,hooks){
        const groups=hooks.groups.filter(group=>window.ReelsNameBinding.isPhoneGroup(group));
        const module=document.createElement('details');module.className='rom-source-section rom-phone-library';
        module.innerHTML=`<summary>电话库 · 固定绑定电话层</summary><div class="rom-settings-body"><div class="rom-tools"><button data-phone-add>添加电话库文件夹</button><button data-phone-refresh>刷新电话库</button><button data-phone-unbind title="先选择一个电话库目录，再移出；保留磁盘素材和任务中的电话">移出当前库</button></div><select data-phone-root aria-label="电话库目录"><option value="all">全部电话库目录</option></select><label>固定电话层<select data-phone-layer aria-label="电话库固定媒体层">${groups.map(group=>`<option value="${esc(group.key)}">${esc(group.label)}</option>`).join('')}</select></label><small>${groups.length?'电话库只分配到上面选定的电话层，保留布局与其他媒体。电话文件名需要包含对应的名字关键词，如“领会的图_电话.png”。':'当前任务没有电话媒体层，请先把对应覆层设为电话主层、电话次层或通用电话层。'}</small><small>此电话层自动参加“随机配对并预览”，与画中画等媒体组成同一套，统一确认替换。</small><input data-phone-search placeholder="搜索电话文件名" aria-label="搜索电话媒体"><div class="rom-tools"><button data-phone-all>全选电话候选</button><button data-phone-clear>取消勾选</button></div><small>有勾选时从勾选的电话中配套，没有勾选时使用当前目录全部电话。同一关键词内按整组号码尽量均衡，样式随机；组合随机时电话与其他媒体一起配套；也可在下方按已有任务素材单独补配电话。</small><output data-phone-status role="status" aria-live="polite"></output></div><div data-phone-items class="rom-grid"></div>`;
        const referenceLayers=hooks.groups.filter(layer=>!window.ReelsNameBinding.isPhoneGroup(layer));
        let selectedLayers=defaultReferenceLayers(hooks.groups);
        try{const saved=JSON.parse(localStorage.getItem('videokit_phone_reference_layers_v1') || 'null');if(Array.isArray(saved) && (!saved.length || saved.some(key=>referenceLayers.some(layer=>layer.key===key))))selectedLayers=saved;}catch(_){}
        const matching=document.createElement('fieldset');matching.innerHTML=`<legend>按任务现有素材匹配电话</legend><small>只根据下方勾选层的素材名字配套，默认参考画中画（观众）和画中画次层。多个关键词支持任意共同关键词；冲突或无匹配时保留原电话。</small>${referenceLayers.map(layer=>`<label style="display:block;margin:6px 0"><input data-phone-reference type="checkbox" value="${esc(layer.key)}" style="width:auto" ${selectedLayers.includes(layer.key)?'checked':''}>${esc(layer.label)}</label>`).join('')}<label>匹配任务范围<select data-phone-match-scope><option value="current">当前任务</option><option value="selected">已勾选任务</option><option value="all">本批全部任务</option><option value="scope">按上方任务范围</option></select></label><button data-phone-match style="width:100%;margin-top:8px">按任务素材匹配电话并预览</button>`;
        module.querySelector('.rom-settings-body').appendChild(matching);
        const fixed=container.querySelector('[data-source="library"]');if(fixed)container.insertBefore(module,fixed);else container.appendChild(module);
        const query=selector=>module.querySelector(selector),libraries=new Map(),checked=new Set();
        let disposed=false,busy=false,matchDialog=null;
        const status=text=>{if(!disposed)query('[data-phone-status]').textContent=text;};
        const group=()=>groups.find(entry=>entry.key===query('[data-phone-layer]').value);
        function paths(){const root=query('[data-phone-root]').value;return [...new Set([...libraries].filter(([key])=>root==='all'||key===root).flatMap(([,files])=>files))];}
        function filtered(){const search=query('[data-phone-search]').value.trim().toLowerCase();return paths().filter(path=>basename(path).toLowerCase().includes(search));}
        function render(){
            if(disposed)return;
            const entries=filtered();
            query('summary').textContent=`电话库 · ${paths().length} 个媒体 · 固定绑定电话层`;
            query('[data-phone-items]').innerHTML=entries.map(path=>{
                const src=hooks.mediaSource(path),keys=window.ReelsNameBinding.match(basename(path));
                return `<article class="rom-phone-item" data-phone-path="${esc(path)}" style="min-width:0;padding:5px;border:1px solid #424654;border-radius:5px;font-size:11px">${!src?'<small>文件不可读取，请刷新电话库</small>':image(path)?`<img crossorigin="anonymous" loading="lazy" src="${esc(src)}" style="width:100%;height:150px;object-fit:contain;background:#111">`:`<video crossorigin="anonymous" class="rbt-thumb-previewable" data-path="${esc(path)}" data-thumb-src="${esc(src)}#t=0.1" muted preload="none" style="width:100%;height:150px;object-fit:contain;background:#111"></video>`}<label style="display:block;overflow-wrap:anywhere"><input data-phone-check type="checkbox" style="width:auto" ${checked.has(path)?'checked':''}>${esc(basename(path))}</label><small>配套：${esc(keys.length?keys.join(' / ')+'（任一名字可配套）':'未命中名字关键词')}</small><small class="rom-phone-source" title="${esc(folderOf(path))}" style="display:block;overflow-wrap:anywhere">来源文件夹：${esc(basename(folderOf(path)))}</small></article>`;
            }).join('') || '<p class="rom-hint">请选择存放电话图片或视频的文件夹。</p>';
            hooks.thumbnails?.();
        }
        async function scan(directory){
            const api=window.electronAPI;if(!api?.scanDirectoryRecursive)throw new Error('请在桌面版读取电话库');
            const entries=await api.scanDirectoryRecursive(directory,{maxDepth:20});
            const files=entries.map(entry=>typeof entry==='string'?entry:entry.path).filter(valid).filter(file=>!file.replace(/\\/g,'/').split('/').includes('本批已经使用')).sort((a,b)=>a.localeCompare(b,'zh',{numeric:true}));
            if(disposed)return;
            await window.ReelsMediaLibrary?.track?.(directory,files);
            if(disposed)return;
            libraries.set(directory,files);
            const previous=query('[data-phone-root]').value;
            query('[data-phone-root]').innerHTML='<option value="all">全部电话库目录</option>'+[...libraries.keys()].map(root=>`<option value="${esc(root)}">${esc(root)}</option>`).join('');
            query('[data-phone-root]').value=libraries.has(previous)?previous:'all';
            try{localStorage.setItem(KEY,JSON.stringify([...libraries.keys()]));}catch(_){}
            const available=new Set(paths());for(const path of checked)if(!available.has(path))checked.delete(path);
        }
        async function run(action){
            if(busy)return;busy=true;module.querySelectorAll('button').forEach(button=>button.disabled=true);
            try{await action();}catch(error){status(error.message);}
            finally{busy=false;if(!disposed){module.querySelectorAll('button').forEach(button=>button.disabled=false);render();}}
        }
        matching.onchange=event=>{if(event.target.matches('[data-phone-reference]'))try{localStorage.setItem('videokit_phone_reference_layers_v1',JSON.stringify([...matching.querySelectorAll('[data-phone-reference]:checked')].map(input=>input.value)));}catch(_){}};
        query('[data-phone-match]').onclick=()=>run(async()=>{
            if(!hooks.read || !hooks.applyMatched)throw new Error('当前界面不支持按任务匹配，请重新打开媒体池');
            const cards=hooks.targets(query('[data-phone-match-scope]').value);if(!cards.length)throw new Error('此范围没有任务，请选择当前任务或勾选目标任务');
            const layers=[...matching.querySelectorAll('[data-phone-reference]:checked')].map(input=>referenceLayers.find(layer=>layer.key===input.value)).filter(Boolean),phoneGroup=group();
            const phones=paths().filter(path=>!checked.size || checked.has(path));
            const rows=matchExistingTasks(cards,layers,phoneGroup,phones,{read:hooks.read,available:hooks.mediaSource});
            const dialog=document.createElement('dialog');matchDialog=dialog;dialog.className='rom-confirm rom-combination-preview rom-phone-match-preview';
            dialog.style.cssText='position:fixed;inset:4vh 2vw;margin:auto;width:96vw;max-width:1800px;height:92vh;max-height:92vh;display:block;overflow-y:auto;overflow-x:hidden;';
            const columns=Math.max(1,Math.min(20,Number(hooks.columns?.()) || 4));dialog.style.setProperty('--pair-columns',String(columns));
            let applying=false,completed=false;
            dialog.innerHTML=`<style>.rom-phone-match-preview.rom-match-hide-task-names .rom-plan-task-name{display:none}.rom-phone-match-preview select[data-match-choice]{box-sizing:border-box;font-size:11px;width:100%;min-width:0;margin:6px 0}.rom-phone-match-preview .rom-match-card-status{font-size:11px;color:#f4d59e;margin:6px 0}</style><h3>按任务素材匹配电话 · 预览</h3><p>参考层：${esc(layers.map(layer=>layer.label).join('、'))}；目标电话层：${esc(phoneGroup.label)}。仅替换电话，保留其他媒体、文案和布局；不移动文件。</p><div class="rom-plan-toolbar"><label>每行 <select data-match-columns aria-label="电话匹配预览每行卡片数量">${Array.from({length:20},(_,index)=>`<option value="${index+1}" ${index+1===columns?'selected':''}>${index+1}</option>`).join('')}</select> 张任务卡</label><label><input data-match-task-names type="checkbox" ${hooks.showTaskNames?.()===false?'':'checked'}>显示任务名字</label><label><input data-match-file-names type="checkbox" checked>显示素材文件名</label><output data-match-summary role="status"></output></div><div data-match-rows class="rom-plan-grid"></div><p data-match-message role="status" style="color:#f4d59e"></p><div class="rom-confirm-actions"><button data-match-close>取消</button><button data-match-apply>确认替换电话</button></div>`;
            const q=selector=>dialog.querySelector(selector);
            const report=document.createElement('details');report.open=true;report.innerHTML='<summary>电话分配结果报告 · 关键词与号码组</summary><div data-phone-report></div>';q('[data-match-rows]').before(report);
            function updateSummary(){const changed=rows.filter(row=>row.path && row.path!==row.current).length,kept=rows.filter(row=>row.path && row.path===row.current).length;
                q('[data-match-summary]').textContent=`目标 ${rows.length} 个任务：待更换 ${changed} 个；原电话已匹配 ${kept} 个；无法匹配 ${rows.filter(row=>!row.path).length} 个（保留原电话）`;
                if(window.ReelsOverviewMediaPool?.combinationReportHtml){const combinations=phoneCombinations(rows);q('[data-phone-report]').innerHTML=window.ReelsOverviewMediaPool.combinationReportHtml({combinations,shortage:rows.length-combinations.length},phones.map(phoneItem));}
                q('[data-match-apply]').disabled=!changed;q('[data-match-apply]').textContent=`确认更换 ${changed} 个任务的电话`;
            }
            let observer;
            if(window.IntersectionObserver)observer=new IntersectionObserver(entries=>{for(const {target,isIntersecting} of entries){if(isIntersecting && !target.getAttribute('src')){target.preload='metadata';target.src=target.dataset.previewSrc;}else if(!isIntersecting)target.pause();}},{root:dialog,rootMargin:'100px'});
            function preview(frame,path){
                const old=frame.querySelector('video');if(old){observer?.unobserve(old);old.pause();old.removeAttribute('src');old.load();}frame.replaceChildren();
                if(!path){frame.textContent='暂无可用媒体';return;}
                const src=hooks.mediaSource(path);if(!src){frame.textContent='媒体不可读取';return;}
                const node=document.createElement(image(path)?'img':'video');node.crossOrigin='anonymous';node.style.cssText='position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#111';
                if(image(path)){node.alt=basename(path);node.loading='lazy';node.src=src;}
                else{node.controls=true;node.muted=true;node.playsInline=true;node.preload='none';node.dataset.previewSrc=src+'#t=0.1';node.onplay=()=>dialog.querySelectorAll('video').forEach(other=>{if(other!==node)other.pause();});}
                frame.appendChild(node);if(!image(path)){if(observer)observer.observe(node);else{node.preload='metadata';node.src=node.dataset.previewSrc;}}
            }
            const tile=(label,body)=>`<div class="rom-plan-tile"><strong>${esc(label)}</strong>${body}</div>`;
            q('[data-match-rows]').innerHTML=rows.map((row,index)=>`<article class="rom-plan-card" data-match-card="${index}"><header><strong>任务 ${(row.card.id ?? index)+1} · ${esc(row.keys.join(' / ') || '未命中')}</strong><div class="rom-plan-task-name" title="${esc(row.card.name || row.card.task.fileName || '')}">${esc(row.card.name || row.card.task.fileName || '')}</div><div class="rom-match-card-status" data-match-card-status="${index}"></div></header><div class="rom-plan-pairs" style="--pair-slots:${Math.min(layers.length+1,2)}">${layers.map((layer,layerIndex)=>tile(layer.label,`<div data-pair-media data-match-reference="${index}:${layerIndex}"></div><div class="rom-plan-file-nav"><button data-match-ref-step="-1" data-row="${index}" data-layer="${layerIndex}" aria-label="上一个参考素材">‹</button><small data-file-position data-match-reference-name="${index}:${layerIndex}"></small><button data-match-ref-step="1" data-row="${index}" data-layer="${layerIndex}" aria-label="下一个参考素材">›</button></div><small>参考素材</small>`)).join('')}${tile(phoneGroup.label+' · 待匹配电话',`<div data-pair-media data-match-preview="${index}"></div><p class="rom-plan-material-name" data-match-phone-name="${index}"></p><small data-match-phone-source="${index}" style="display:block;overflow-wrap:anywhere"></small>${row.choices.length?`<select data-match-choice="${index}" aria-label="任务 ${index+1} 的配套电话">${row.choices.map(path=>`<option value="${esc(path)}" ${path===row.path?'selected':''}>${esc(basename(path))}</option>`).join('')}</select><button data-match-random="${index}" style="display:block;width:100%;margin-top:6px;font-size:11px;padding:6px">随机更换电话</button>`:''}<small class="rom-plan-material-name">原电话：${esc(basename(row.current) || '无')}</small>`)}</div></article>`).join('');
            const references=rows.map(row=>layers.map(layer=>({files:referenceFiles(hooks.read(row.card.task,layer),layer),index:0})));
            function showReference(rowIndex,layerIndex){
                const ref=references[rowIndex][layerIndex],key=`${rowIndex}:${layerIndex}`;preview(q(`[data-match-reference="${key}"]`),ref.files[ref.index]);
                const name=q(`[data-match-reference-name="${key}"]`);name.dataset.position=ref.files.length?`${ref.index+1} / ${ref.files.length}`:'0 / 0';name.dataset.fullLabel=name.dataset.position+' · '+(basename(ref.files[ref.index]) || '无素材');name.title=ref.files[ref.index] || '';name.textContent=q('[data-match-file-names]').checked?name.dataset.fullLabel:name.dataset.position;
                q(`[data-match-card="${rowIndex}"]`).querySelectorAll(`[data-match-ref-step][data-layer="${layerIndex}"]`).forEach(button=>button.disabled=ref.files.length<2);
            }
            function showPhone(index){const row=rows[index];preview(q(`[data-match-preview="${index}"]`),row.path || row.current);
                const name=q(`[data-match-phone-name="${index}"]`);name.textContent=basename(row.path || row.current) || '无电话素材';name.title=row.path || row.current;
                const source=q(`[data-match-phone-source="${index}"]`),folder=folderOf(row.path || row.current);source.textContent=folder?'来源文件夹：'+basename(folder):'';source.title=folder;
                const choice=q(`[data-match-choice="${index}"]`);if(choice)choice.value=row.path;
                q(`[data-match-card-status="${index}"]`).textContent=row.reason || (row.path===row.current?'原电话已配套，保持不变':'待替换配套电话');
            }
            rows.forEach((row,index)=>{layers.forEach((_,layerIndex)=>showReference(index,layerIndex));showPhone(index);});updateSummary();
            dialog.classList.toggle('rom-match-hide-task-names',!q('[data-match-task-names]').checked);
            q('[data-match-columns]').onchange=event=>dialog.style.setProperty('--pair-columns',event.target.value);
            q('[data-match-task-names]').onchange=event=>dialog.classList.toggle('rom-match-hide-task-names',!event.target.checked);
            q('[data-match-file-names]').onchange=event=>{dialog.classList.toggle('rom-plan-hide-names',!event.target.checked);dialog.querySelectorAll('[data-match-reference-name]').forEach(node=>node.textContent=event.target.checked?node.dataset.fullLabel:node.dataset.position);};
            q('[data-match-rows]').onchange=event=>{const input=event.target.closest('[data-match-choice]');if(!input || applying || completed)return;const index=Number(input.dataset.matchChoice);rows[index].path=input.value;showPhone(index);updateSummary();};
            q('[data-match-rows]').onclick=event=>{
                if(applying || completed)return;
                const random=event.target.closest('[data-match-random]');if(random){const index=Number(random.dataset.matchRandom);
                    try{rows[index]=rerollExistingPhone(rows[index],{available:hooks.mediaSource,rows});showPhone(index);updateSummary();q('[data-match-message]').textContent=`已更换任务 ${(rows[index].card.id ?? index)+1} 的电话，其余任务和参考素材保持不变；确认后生效。`;}
                    catch(error){q('[data-match-message]').textContent=error.message;}return;
                }
                const step=event.target.closest('[data-match-ref-step]');if(step){const rowIndex=Number(step.dataset.row),layerIndex=Number(step.dataset.layer),ref=references[rowIndex][layerIndex];if(ref.files.length){ref.index=(ref.index+Number(step.dataset.matchRefStep)+ref.files.length)%ref.files.length;showReference(rowIndex,layerIndex);}}
            };
            q('[data-match-close]').onclick=()=>dialog.close();dialog.oncancel=event=>{if(applying)event.preventDefault();};
            dialog.onclose=()=>{observer?.disconnect();dialog.querySelectorAll('video').forEach(video=>{video.pause();video.removeAttribute('src');video.load();});dialog.remove();if(matchDialog===dialog)matchDialog=null;};
            q('[data-match-apply]').onclick=async()=>{
                if(applying || completed)return;applying=true;dialog.setAttribute('aria-busy','true');dialog.querySelectorAll('button,select').forEach(node=>node.disabled=true);
                q('[data-match-message]').textContent='正在检查任务素材并替换电话…';await new Promise(resolve=>setTimeout(resolve,0));
                try{
                    const changed=rows.filter(row=>row.path && row.path!==row.current);
                    await hooks.applyMatched(changed,phoneGroup,layers,progress=>{q('[data-match-message]').textContent=progress.stage==='rollback'?'电话替换失败，正在恢复原电话…':`正在替换并保存电话：${progress.completed} / ${progress.total}`;});
                    const reportState=q('[data-report-state]');if(reportState)reportState.textContent='已确认：下表为目标范围中已配套电话的分布（含保留原电话的任务）。';
                    completed=true;q('[data-match-message]').textContent=`已更换 ${changed.length} 个任务的电话；其余任务保留。可在媒体池撤销分配。`;q('[data-match-close]').textContent='完成';q('[data-match-apply]').textContent='已完成';status(`已按参考媒体层匹配 ${changed.length} 个电话，未移动文件`);
                }catch(error){q('[data-match-message]').textContent=error.message;dialog.querySelectorAll('select').forEach(node=>node.disabled=false);updateSummary();}
                finally{applying=false;dialog.removeAttribute('aria-busy');q('[data-match-close]').disabled=false;if(!completed){dialog.querySelectorAll('[data-match-random]').forEach(node=>node.disabled=false);dialog.querySelectorAll('[data-match-ref-step]').forEach(node=>node.disabled=references[Number(node.dataset.row)][Number(node.dataset.layer)].files.length<2);}}
            };
            document.body.appendChild(dialog);dialog.showModal();
        });
        const replacementLayers=()=>[...matching.querySelectorAll('[data-phone-reference]:checked')].map(input=>referenceLayers.find(layer=>layer.key===input.value)).filter(Boolean);
        const allPhonePaths=()=>[...new Set([...libraries.values()].flat())];
        query('[data-phone-add]').onclick=()=>run(async()=>{const root=await window.electronAPI?.selectDirectory?.();if(root){await scan(root);status('电话库已读取，电话层固定绑定已生效');}});
        query('[data-phone-refresh]').onclick=()=>run(async()=>{for(const root of [...libraries.keys()])await scan(root);status('电话库已刷新');});
        query('[data-phone-unbind]').onclick=()=>run(async()=>{
            const root=query('[data-phone-root]').value;
            if(!libraries.has(root))throw new Error('请先在电话库目录下拉框中选择要移出的文件夹');
            const remaining=[...libraries.keys()].filter(directory=>directory!==root);
            localStorage.setItem(KEY,JSON.stringify(remaining));
            libraries.delete(root);
            const retained=new Set([...libraries.values()].flat());
            for(const path of [...checked])if(!retained.has(path))checked.delete(path);
            query('[data-phone-root]').innerHTML='<option value="all">全部电话库目录</option>'+remaining.map(directory=>`<option value="${esc(directory)}">${esc(directory)}</option>`).join('');
            query('[data-phone-root]').value='all';
            status('已移出本机电话库列表，磁盘素材和任务中的电话保留');
        });
        query('[data-phone-root]').onchange=render;query('[data-phone-search]').oninput=render;
        query('[data-phone-layer]').onchange=()=>{try{localStorage.setItem('videokit_phone_library_layer',query('[data-phone-layer]').value);}catch(_){}};
        query('[data-phone-all]').onclick=()=>{filtered().forEach(path=>checked.add(path));render();};
        query('[data-phone-clear]').onclick=()=>{checked.clear();render();};
        query('[data-phone-items]').onchange=event=>{const item=event.target.closest('[data-phone-path]');if(!item)return;if(event.target.checked)checked.add(item.dataset.phonePath);else checked.delete(item.dataset.phonePath);};
        let roots=[];
        try{roots=JSON.parse(localStorage.getItem(KEY)||'[]');const key=localStorage.getItem('videokit_phone_library_layer');if(groups.some(item=>item.key===key))query('[data-phone-layer]').value=key;}catch(_){}
        const ready=run(async()=>{for(const root of roots)try{await scan(root);}catch(error){status(`电话库读取失败：${error.message}`);}});
        const replacement=createReplacementController({...hooks,layers:replacementLayers,phones:allPhonePaths,ready:()=>ready,busy:()=>busy,status});
        return {pairingGroup:group,...replacement,
            async refreshAll(){
                await ready;const failures=[];
                for(const root of [...libraries.keys()]){if(disposed)break;try{await scan(root);}catch(error){failures.push(`${root}：${error.message}`);}}
                if(!disposed)render();return failures;
            },
            relocatePaths(mappings){for(const [root,files] of libraries)libraries.set(root,files.map(file=>window.ReelsMediaRelocation.remap(file,mappings)).filter(file=>!file.replace(/\\/g,'/').split('/').includes('本批已经使用')));checked.clear();render();},
            hasPath:path=>[...libraries.values()].some(files=>files.includes(path)),
            candidates:slots=>paths().filter(path=>!checked.size || checked.has(path)).flatMap(path=>{
                const keys=window.ReelsNameBinding.match(basename(path)),phoneSlots=slots.filter(slot=>window.ReelsNameBinding.isPhoneGroup(slot));
                if(!phoneSlots.length || !keys.length || !hooks.mediaSource(path))return [];
                return [{id:path,path,phone:true,poolKey:'phone-library',files:[path],name:basename(path),keyword:keys[0],keywords:keys,history:window.ReelsMediaLibrary?.historyFor([path]).count || 0,values:Object.fromEntries(phoneSlots.map(slot=>[slot.key,valueFor(path)]))}];
            }),
            dispose(){disposed=true;matchDialog?.close();replacement.dispose();module.remove();}};
    }
    let taskReplacing=false;
    function appendTaskActions(menu,task,overlay,onClose){
        const state=window._reelsState;
        if(!state?.tasks.includes(task) || !window.reelsOverviewMediaContext)return;
        window._syncCurrentOverlayEditorToSelectedTask?.();
        const context=window.reelsOverviewMediaContext();
        let phones=[];
        const read=(task,group)=>context.readInventory(task,group,state.tasks.indexOf(task));
        const layers=()=>{
            const defaults=defaultReferenceLayers(context.groups);
            let keys=defaults;
            try{const saved=JSON.parse(localStorage.getItem('videokit_phone_reference_layers_v1') || 'null');
                if(Array.isArray(saved) && (!saved.length || saved.some(key=>context.groups.some(group=>group.key===key))))keys=saved;
            }catch(_){}
            return context.groups.filter(group=>keys.includes(group.key) && !window.ReelsNameBinding.isPhoneGroup(group));
        };
        const mediaSource=path=>window.ReelsOverviewMediaPool.mediaSource(path);
        const controller=createReplacementController({groups:context.groups,read,layers,phones:()=>phones,mediaSource,
            busy:()=>taskReplacing,
            ready:async()=>{
                let roots=[];
                try{roots=JSON.parse(localStorage.getItem(KEY) || '[]');}catch(_){}
                if(!Array.isArray(roots) || !roots.length)throw new Error('请先在总览媒体池中添加电话库文件夹');
                const found=[];
                for(const root of roots){
                    const entries=await window.electronAPI.scanDirectoryRecursive(root,{maxDepth:20});
                    const files=entries.map(entry=>typeof entry==='string'?entry:entry.path).filter(valid)
                        .filter(file=>!file.replace(/\\/g,'/').split('/').includes('本批已经使用'));
                    await window.ReelsMediaLibrary?.track?.(root,files);found.push(...files);
                }
                phones=[...new Set(found)];
            },
            applyMatched:async(rows,phoneGroup)=>{
                if(taskReplacing || window._reelsMediaWriteBatchDepth>0)throw new Error('正在处理素材，请稍后重试');
                taskReplacing=true;let entries;
                const library=window.ReelsMediaLibrary;
                try{
                    window._syncCurrentOverlayEditorToSelectedTask?.();
                    const combos=rows.map(row=>({pairs:[{slot:phoneGroup,item:{path:row.path,name:basename(row.path),files:[row.path],folder:false,values:{[phoneGroup.key]:valueFor(row.path)}}}]}));
                    entries=await window.ReelsOverviewMediaPool.replaceCombinations(context,rows.map(row=>row.card),combos,{
                        beforeWrite:()=>window.reelsSaveHistory?.(),
                        validate:card=>{
                            if(!window._reelsState.tasks.includes(card.task))throw new Error('任务已改变，请重新右键选择');
                            const row=rows.find(row=>row.card===card);
                            validateReplacement(row,row.path,{layers:layers(),phoneGroup,phones,read,available:mediaSource});
                        },
                        recordUses:library?.recordUses?changes=>library.recordUses(changes):null,
                        recordUse:(...args)=>library?.recordUse(...args),cancelUse:(...args)=>library?.cancelUse(...args)
                    });
                    if(await window.reelsSaveUnifiedProject?.({wait:true})===false)throw new Error('工程保存失败，已恢复原电话');
                    window.reelsSaveHistory?.();
                }catch(error){
                    if(entries){
                        context.beginBatch();
                        try{for(const entry of entries.slice().reverse()){
                            context.write(entry.task,entry.group,entry.value);
                            if(entry.usage)await library?.cancelUse(entry.task,entry.usage);
                        }}finally{context.endBatch();}
                        await window.reelsSaveUnifiedProject?.({wait:true});
                    }
                    throw error;
                }finally{taskReplacing=false;}
            }
        });
        const start=menu.children.length;
        controller.appendReplacementActions(menu,{task,id:state.tasks.indexOf(task)},overlay,onClose);
        for(const button of [...menu.children].slice(start))button.style.cssText='display:block;padding:10px 20px;background:#363a50;color:white;border:0;border-radius:5px;cursor:pointer;text-align:left';
    }
    window.ReelsPhoneLibrary={folderOf,mount,createReplacementController,appendTaskActions,pairingSlots,valueFor,defaultReferenceLayers,materialKeywords,matchExistingTasks,referenceFiles,rerollExistingPhone,replacementChoices,validateReplacement};
})();
