/** Cloud sources share the existing review cards and status workflow. */
function visualReviewIsCloud(){return visualReviewState.sourceKind==='gdrive';}
let visualReviewDrivePasteTimer;
function visualReviewDrivePaste(){
    clearTimeout(visualReviewDrivePasteTimer);
    visualReviewDrivePasteTimer=setTimeout(()=>{
        if(!document.getElementById('visual-review-drive-read')?.disabled)visualReviewImportDrive();
    },500);
}
async function visualReviewImportDrive(refresh=false,forceRedownload=false){
    const button=document.getElementById('visual-review-drive-read'),forceButton=document.getElementById('visual-review-drive-force'),message=document.getElementById('visual-review-drive-message');
    const rawText=refresh?visualReviewState.sourceLinks:document.getElementById('visual-review-drive-links')?.value?.trim();
    if(!rawText)return showToast('请先粘贴 Google Drive 或 Muse（muse.ai）链接','info');
    const activeTab=visualReviewActiveTabId;
    const cacheToLocal=forceRedownload || (refresh?visualReviewState.sourceCacheToLocal===true:document.getElementById('visual-review-drive-auto-download')?.checked!==false);
    const requestId='drive-review-'+Date.now()+'-'+Math.random().toString(36).slice(2);
    let unsubscribe;
    if(button?.disabled)return;
    if(button)button.disabled=true;if(forceButton)forceButton.disabled=true;
    if(message)message.textContent=forceRedownload?'正在重新下载并替换本地素材…':cacheToLocal?'正在检查历史下载记录；新增或缺失素材将自动下载…':'正在读取云端素材链接…';
    try{
        if(!window.electronAPI?.apiCall)throw Error('请在桌面版中读取云端链接。');
        if(refresh)visualReviewPersist();
        unsubscribe=window.electronAPI.onGDriveReviewProgress?.(progress=>{
            if(progress.requestId!==requestId||!message)return;
            if(progress.phase==='scan')message.textContent=progress.message;
            else if(progress.phase==='download'){
                const size=Number(progress.totalBytes)>0?` · ${(Number(progress.bytes||0)/1048576).toFixed(1)} / ${(progress.totalBytes/1048576).toFixed(1)} MB`:'';
                message.textContent=`处理素材 ${progress.completed||0}/${progress.total||0} · 已下载 ${progress.downloaded||0} 个 · 复用 ${progress.reused||0} 个 · ${progress.name||''}${size}`;
            }
        });
        const response=await window.electronAPI.apiCall('gdrive-review/open',{rawText,cacheToLocal,refresh,forceRedownload,requestId});
        if(!response?.success)throw Error(response?.error||'云端素材读取失败。');
        const result=response.data;if(!result?.files?.length)throw Error('没有找到可审核的图片或视频。');
        if(refresh&&activeTab!==visualReviewActiveTabId){if(message)message.textContent='已切换审核标签，本次刷新未覆盖新标签。';return;}
        visualReviewSyncActiveTab();
        const existing=!refresh?visualReviewTabs.find(tab=>tab.state.root===result.root):null;
        const previous=refresh?visualReviewState:existing?.state;
        const oldStatuses={...(previous?.statuses||{})};
        const oldFeedback={...(previous?.feedback||{})};
        const oldPaths=new Set(previous?previous.suites.flatMap(s=>s.groups.flatMap(g=>g.files.map(f=>f.path))):[]);
        if(!refresh){if(existing)visualReviewActivateTab(existing.id);else visualReviewStartTab(result.root);} 
        visualReviewState.sourceKind='gdrive';visualReviewState.sourceLinks=rawText;visualReviewState.sourceLabel=result.label;
        visualReviewState.sourceCacheToLocal=result.cacheToLocal===true;visualReviewState.sourceDownloadDirectory=result.downloadDirectory||'';
        visualReviewState.root=result.root;
        if(!previous && !result.session)visualReviewState.groupingMode='folder';
        visualReviewState.suites=visualReviewBuildSuites(result.files);
        visualReviewState.suiteIndex=0;visualReviewState.current=0;visualReviewState.activePath='';
        visualReviewState.batchName=result.session?.batchName||(result.sourceProvider==='muse'?'Muse 云端审核':result.sourceProvider==='mixed'?'云端素材审核':'Google Drive 审核');
        let cached=null;try{cached=JSON.parse(localStorage.getItem('visual-review:'+result.root)||'null');}catch(_){}
        const restored=previous ? { ...previous, statuses: oldStatuses, feedback: oldFeedback } : (result.session||cached);
        visualReviewState.statuses={...(result.cacheToLocal ? restored?.statuses||{} : {}),...visualReviewRestoreSavedStatuses(restored,result.files)};
        visualReviewState.feedback=visualReviewRestoreSavedStatuses({ ...restored, statuses: restored?.feedback || {} },result.files);
        if(previous)for(const file of result.files){if(oldStatuses[file.path])visualReviewState.statuses[file.path]=oldStatuses[file.path];else delete visualReviewState.statuses[file.path];}
        if(restored){
            visualReviewState.groupingMode=['name','folder','individual','count'].includes(restored.groupingMode)?restored.groupingMode:'name';
            visualReviewState.groupHoverPreview=restored.groupHoverPreview!==false;
            visualReviewState.groupSize=Math.max(1,Math.min(100,Number(restored.groupSize)||6));
            const settings=new Map((restored.suites||[]).map(suite=>[suite.key,suite]));
            for(const suite of visualReviewState.suites){const saved=settings.get(suite.key);if(saved){suite.groupingMode=['name','folder','individual','count'].includes(saved.groupingMode)?saved.groupingMode:visualReviewState.groupingMode;suite.collapsed=saved.collapsed===true;suite.groupSize=Number(saved.groupSize)||visualReviewState.groupSize;}}
            visualReviewState.suites=visualReviewBuildSuites(result.files);
        }
        visualReviewState.newlyAddedPaths=refresh?result.files.filter(file=>!oldPaths.has(file.path)).map(file=>file.path):[];
        const tab=visualReviewTabs.find(tab=>tab.id===visualReviewActiveTabId);if(tab)tab.label='☁️ '+result.label;
        visualReviewSyncActiveTab();visualReviewRender();
        const videos=result.files.filter(file=>file.type==='video').length,images=result.files.filter(file=>file.type==='image').length;
        const failed=Math.max(0,(result.total||result.files.length)-result.files.length);
        const note=`${result.cacheToLocal?`已就绪 ${result.files.length} 个本地素材 · 下载 ${result.downloaded||0} 个 · 复用 ${result.reused||0} 个${failed?` · 未就绪 ${failed} 个`:''}`:`已读取 ${result.files.length} 个云端素材`} · 视频 ${videos} 个 · 图片 ${images} 个${Object.keys(visualReviewState.statuses).length?` · 已恢复 ${Object.keys(visualReviewState.statuses).length} 个标记`:''}`;
        if(message)message.textContent=note+(result.warnings?.length?'；'+result.warnings.join('；'):'');showToast(note,'success');
    }catch(error){if(message)message.textContent=error.message;showToast(error.message,'error');}
    finally{unsubscribe?.();if(button)button.disabled=false;if(forceButton)forceButton.disabled=false;}
}
function visualReviewOpenDriveOriginal(filePath){
    const file=visualReviewState.suites.flatMap(s=>s.groups.flatMap(g=>g.files)).find(file=>file.path===filePath);
    const url=file?.sourceUrl||visualReviewState.sourceLinks?.match(/https?:\/\/[^\s"'<>]+/)?.[0];
    if(!url)return;
    if(window.electronAPI?.openExternal)window.electronAPI.openExternal(url);else window.open(url,'_blank');
}
function visualReviewDriveDecorate(){
    const root=document.getElementById('media-visual-review');if(!root)return;
    root.querySelector('#visual-review-drive-badge')?.remove();
    if(!visualReviewIsCloud())return;
    const badge=document.createElement('div');badge.id='visual-review-drive-badge';badge.className='hint';badge.style.cssText='padding:9px 0;color:#93c5fd;';
    badge.textContent='☁️ '+visualReviewState.sourceLabel+(visualReviewState.sourceCacheToLocal?' · 已下载，本地播放 · 审核记录已保留':' · 在线预览，审核标记保存在本机');
    const hasDrive=/drive\.google\.com|docs\.google\.com/i.test(visualReviewState.sourceLinks||'');
    const hasMuse=/muse\.ai/i.test(visualReviewState.sourceLinks||'');
    const open=document.createElement('button');open.type='button';open.className='btn btn-secondary';open.textContent=hasMuse&&!hasDrive?'打开原链接':'在 Google Drive 中打开';open.style.marginLeft='12px';open.onclick=()=>visualReviewOpenDriveOriginal();badge.append(open);
    if(visualReviewState.sourceCacheToLocal){const force=document.createElement('button');force.type='button';force.className='btn btn-secondary';force.textContent='强制重新下载并覆盖';force.title='重新读取云端目录并下载当前链接下全部素材，保留审核记录';force.style.marginLeft='8px';force.onclick=()=>visualReviewImportDrive(true,true);badge.append(force);}
    if(visualReviewState.sourceDownloadDirectory){
        const folder=document.createElement('button');folder.type='button';folder.className='btn btn-secondary';folder.textContent='打开下载文件夹';folder.style.marginLeft='8px';folder.onclick=()=>window.electronAPI?.apiCall?.('open-folder',{path:visualReviewState.sourceDownloadDirectory});badge.append(folder);
    }
    root.prepend(badge);
    for(const button of root.querySelectorAll('button[onclick]'))if(/visualReview(?:OpenBatchRenameModal|MoveImages|MoveRejects|CollectSelected|RelinkMovedSelected|OpenReviewFolder)/.test(button.getAttribute('onclick'))){button.disabled=true;button.title='云端素材请先下载，再进行本地文件整理';}
    for(const media of root.querySelectorAll('video[data-src],img'))if(String(media.dataset.src||media.src||'').startsWith('local-media://drive-review/')){
        media.addEventListener('error',()=>{media.title='云端媒体读取失败；可打开原链接检查，或检查共享权限后刷新。';const card=media.closest('article');if(card&&!card.querySelector('[data-cloud-error]')){const error=document.createElement('div');error.dataset.cloudError='true';error.style.cssText='padding:8px;font-size:11px;color:#fbbf24;';error.textContent=visualReviewState.sourceCacheToLocal?'本地素材无法预览，请重新读取链接补下载，或打开原链接查看。':'无法预览：请检查链接有效性或权限，或打开原链接查看。';card.append(error);}},{once:true});
    }
}
