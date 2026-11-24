/** Independent, read-only V2 players; editing uses the original inspector. */
(() => {
    'use strict';
    let root, cards = [], inspectorHome, observer, timer, active, refreshTimer;
    let layerTaskFilter=null, layerFilterCriteria=null;
    const filteredCards=()=>layerTaskFilter?cards.filter(card=>layerTaskFilter.has(card.task)):cards;
    const pageCards=()=>filteredCards().slice(page*pageSize,(page+1)*pageSize);
    let resourceTimer, resourceDebounce, mediaPool;
    function reportResources(reason = 'sample') {
        if (!window.electronAPI?.reportReelsOverviewResources) return;
        const media = [], canvases = [];
        for (const card of cards) {
            const doc = card.frame?.contentDocument;
            doc?.querySelectorAll('video,audio').forEach(el => {
                if (!el.getAttribute('src') && !el.currentSrc) return;
                const quality = el.getVideoPlaybackQuality?.();
                media.push({cardId:card.id, readyState:el.readyState, networkState:el.networkState,
                    width:el.videoWidth || 0, height:el.videoHeight || 0, errorCode:el.error?.code || 0,
                    totalFrames:quality?.totalVideoFrames || 0, droppedFrames:quality?.droppedVideoFrames || 0,
                    video:el.tagName === 'VIDEO', playing:!el.paused, seeking:el.seeking});
            });
            doc?.querySelectorAll('canvas').forEach(canvas => canvases.push(canvas.width * canvas.height * 4));
        }
        window.electronAPI.reportReelsOverviewResources({reason, open:!!root, playing:allPlaying || !!active,
            tasks:cards.length, page, visible:cards.filter(c=>c.visible).length,
            players:cards.filter(c=>c.frame).length, loading:loadingCards.size, queued:loadQueue.length,
            posters:cards.filter(c=>c.poster).length, videos:media.filter(m=>m.video).length,
            playingVideos:media.filter(m=>m.video && m.playing).length, seekingVideos:media.filter(m=>m.video && m.seeking).length,
            mediaErrors:media.filter(m=>m.errorCode).length, canvasBytes:canvases.reduce((sum,n)=>sum+n,0), media,
            jsHeapBytes:performance.memory ? {used:performance.memory.usedJSHeapSize, total:performance.memory.totalJSHeapSize, limit:performance.memory.jsHeapSizeLimit} : null});
    }
    function queueResourceReport(reason) {
        clearTimeout(resourceDebounce);
        resourceDebounce = setTimeout(() => reportResources(reason), 250);
    }
    // 可在控制台用 localStorage 调整：reels_overview_max_live / reels_overview_max_loading
    const readLimit = (key, def, min, max) => { const n = Number(localStorage.getItem(key)); return Number.isFinite(n) && n >= min ? Math.min(max, n) : def; };
    let pageSize=Math.floor(readLimit('reels_overview_page_size',50,1,1000));
    // 默认按电脑配置决定（解码路数才是卡顿根源）；可用 localStorage 覆盖：
    // reels_overview_max_live / reels_overview_max_loading
    const cores = navigator.hardwareConcurrency || 4;
    const memGB = navigator.deviceMemory || 4;
    const strong = cores >= 10 && memGB >= 8;
    const MAX_LIVE_PLAYERS = readLimit('reels_overview_max_live', strong ? 6 : 4, 2, 8);
    const MAX_LOADING_PLAYERS = readLimit('reels_overview_max_loading', 2, 1, 3);
    // 关闭总览后保留合成截图；下次打开先显示截图，任务内容变了才重新生成。
    const posterCache = new WeakMap();
    const taskSignature = task => { try { return JSON.stringify(clone(task)); } catch (_) { return ''; } };
    const loadQueue = [], loadingCards = new Map();
    let loadTimer;
    let page = 0, allPlaying = false, allStarted = 0, allTime = 0, allSpeed = 1, allRaf;
    const groupTime = () => allTime + (allPlaying ? (performance.now() - allStarted) / 1000 * allSpeed : 0);
    const dependencies = ['reels-text-direction.js', 'reels-anim-engine.js', 'reels-style-engine.js', 'reels-canvas-renderer.js', 'reels-timeline.js', 'reels-render-plan.js', 'reels-media-window.js', 'reels-layer-slots.js', 'reels-overlay.js', 'reels-preview-v2.js'];
    const clone = value => JSON.parse(JSON.stringify(value, (key, item) => item instanceof Node || typeof item === 'function' ? undefined : item));
    const escape = text => String(text).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const fmt = t => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
    function setCardPlayLabel(card, label) {
        const playing = label.includes('暂停');
        card.playButton.innerHTML = `<span aria-hidden="true">${playing ? '⏸' : '▶'}</span><span class="rto-action-label"> ${playing ? '暂停' : '播放'}</span>`;
        card.playButton.title = playing ? '暂停' : '播放';
        card.playButton.setAttribute('aria-label', `${card.name} ${playing ? '暂停' : '播放'}`);
    }
    function updateMasterTime() {
        const slider = root?.querySelector('.rto-master');
        if (!slider) return;
        const time = Number(slider.value) || 0, duration = Number(slider.max) || 0;
        const label = root.querySelector('.rto-master-current');
        label.textContent = fmt(time);
        label.style.left = `clamp(28px, ${duration ? time / duration * 100 : 0}%, calc(100% - 28px))`;
        slider.setAttribute('aria-valuetext', fmt(time));
        const ticks = root.querySelector('.rto-master-ticks');
        const count = Math.max(2, Math.min(10, Math.floor(slider.getBoundingClientRect().width / 100)));
        const key = `${duration}|${count}`;
        if (ticks.dataset.duration !== key) {
            ticks.dataset.duration = key;
            const desiredStep = duration / count;
            const intervals = [1,2,5,10,15,20,30,60,120,300,600,900,1800,3600];
            const step = intervals.find(value => value >= desiredStep) || Math.ceil(desiredStep / 3600) * 3600;
            ticks.replaceChildren(...Array.from({length:Math.floor(duration / step) + 1}, (_, i) => {
                const seconds = i * step;
                const ratio = duration > 0 ? seconds / duration : 0;
                const tick = document.createElement('span');
                tick.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
                tick.style.left = `calc(${ratio * 100}% + ${8 - ratio * 16}px)`;
                return tick;
            }));
        }
    }
    function stop() {
        for(const card of cards)if(card.pendingPlayback){card.pendingPlayback=null;setCardPlayLabel(card,'▶ 播放');}
        if (!active) return;
        cancelAnimationFrame(active.raf);
        if (!active.hoverPlayback) { active.time = active.player?.getCurrentTime() ?? active.time; active.requestedTime = active.time; }
        active.player?.pause();
        active.player?.seek(active.time);
        active.slider.value = active.time; active.label.textContent = fmt(active.time);
        setCardPlayLabel(active, '▶ 播放');
        active.status.textContent = '已暂停';
        active = null;
    }
    function pauseAll() {
        if (!allPlaying) return;
        const time = groupTime();
        allPlaying = false; cancelAnimationFrame(allRaf); allTime = time;
        cards.forEach(card => { card.player?.pause(); seek(card, time); setCardPlayLabel(card, '▶ 播放'); });
        if (root) root.querySelector('.rto-play-all').textContent = '▶ 全部播放';
    }
    function playGroupCard(card) {
        if (!card.player || !allPlaying || !card.groupPlayback || card.visible===false) return;
        const time = groupTime();
        seek(card, time);
        card.frame.contentDocument.querySelector('[data-role="loop"]').checked = false;
        if (time < card.player.getDuration()) card.player.play(allSpeed);
        clearTimeout(card.posterTimer); card.poster?.remove(); card.poster = null;
        setCardPlayLabel(card, '⏸ 暂停');
    }
    function playAll() {
        stop();
        window.ReelsOverviewEdit.configure({muted:true});
        allTime = Number(root.querySelector('.rto-seconds').value) || 0;
        allSpeed = Number(root.querySelector('.rto-speed').value);
        allStarted = performance.now(); allPlaying = true;
        root.querySelector('.rto-play-all').textContent = '⏸ 全部暂停';
        const group = pageCards().filter(card => card.visible).slice(0, MAX_LIVE_PLAYERS);
        cards.forEach(card => { card.groupPlayback = group.includes(card); if (!card.groupPlayback) card.player?.pause(); });
        group.forEach(card => { load(card, true); playGroupCard(card); });
        queueResourceReport('play');
        const tick = () => {
            if (!allPlaying || !root) return;
            const time = groupTime();
            const max = cards.reduce((duration,card)=>Math.max(duration,card.duration),0);
            for (const card of pageCards()) {
                const duration = card.player?.getDuration() || card.duration;
                card.time = Math.min(time, duration); card.requestedTime = time;
                card.slider.value = card.time; card.label.textContent = fmt(card.time);
                if (time >= duration) { card.player?.pause(); card.status.textContent = '已到结尾'; setCardPlayLabel(card, '▶ 播放'); }
            }
            root.querySelector('.rto-master').value = time;
            updateMasterTime();
            root.querySelector('.rto-seconds').value = time.toFixed(1);
            root.querySelector('.rto-mode').textContent = '全部同步播放';
            if (time >= max) { pauseAll(); return; }
            allRaf = requestAnimationFrame(tick);
        };
        allRaf = requestAnimationFrame(tick);
    }
    function capturePoster(card) {
        try {
            const canvas = card.player?.getCanvas?.();
            if (canvas && (card.player?.isFrameReady?.() !== false || card.previewTimedOut)) {
                const image = document.createElement('canvas');
                image.width = 240; image.height = Math.round(240 * canvas.height / canvas.width);
                image.getContext('2d').drawImage(canvas, 0, 0, image.width, image.height);
                const src = image.toDataURL('image/jpeg', .8);
                posterCache.set(card.task, {src, time: card.time, sig: taskSignature(card.task)});
                return src;
            }
        } catch (_) {}
        return null;
    }
    function showPoster(card, src, time) {
        const poster = document.createElement('img');
        poster.src = src;
        poster.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:1';
        card.poster?.remove(); card.poster = poster;
        card.posterTime = time;
        card.stage.appendChild(poster);
    }
    function releaseCard(card) {
        if (!card.frame || card === active || card.dragging) return false;
        const src = capturePoster(card);
        if (src) showPoster(card, src, card.player?.isFrameReady?.() === false && !card.previewTimedOut ? null : card.time);
        window.ReelsOverviewEdit?.unmount(card);
        card.player?.dispose?.(); card.player?.close();
        clearTimeout(card.posterTimer);
        card.frame.onload = null; card.frame.remove();
        card.frame = null; card.player = null;
        queueResourceReport('release');
        return true;
    }
    function makePlayerRoom(nextCard) {
        // 可见卡片也可能很多；始终限制解码器数量，回收后保留合成截图。
        const limit = MAX_LIVE_PLAYERS;
        while (cards.filter(card => card.frame).length >= limit) {
            const candidates = cards.filter(card => card !== nextCard && card.frame && card !== active && !card.dragging && !card.contextMenuPending && !loadingCards.has(card) && (card.player?.isFrameReady?.() !== false || card.previewTimedOut))
                .sort((a,b) => Number(a.visible !== false) - Number(b.visible !== false) || (a.lastUsed || 0) - (b.lastUsed || 0));
            if (!candidates.length || !releaseCard(candidates[0])) return false;
        }
        return true;
    }
    const pendingMediaTasks=new Set();
    function onMediaBatchStart(){
        pauseAll();stop();clearTimeout(loadTimer);loadTimer=null;loadQueue.length=0;loadingCards.clear();
    }
    function syncCardStageAspect(card) {
        if (!card?.stage) return;
        const rs = window._reelsState || {};
        const size = window.ReelsLayoutTemplate?.taskCanvas?.(card.task, rs);
        const w = Number(size?.width) || Number(rs.targetWidth) || 1080;
        const h = Number(size?.height) || Number(rs.targetHeight) || 1920;
        if (w > 0 && h > 0) card.stage.style.paddingTop = `${(h / w) * 100}%`;
    }
    function onResolutionChanged() {
        if (!root) return;
        for (const card of cards) {
            syncCardStageAspect(card);
            posterCache.delete(card.task);
            if (card.player) refreshCards(card);
        }
    }
    function onMediaBatchEnd(event){
        if(!root)return;
        const changed=new Set([...(event.detail || []),...pendingMediaTasks]);pendingMediaTasks.clear();
        for(const card of cards){
            if(!changed.has(card.task))continue;
            renderMediaNames(card);syncCardStageAspect(card);posterCache.delete(card.task);card.posterTime=null;card.signature=null;
            // Recreate only changed compositions; preserve every unrelated decoder and poster.
            if(card.frame)releaseCard(card);
            if(card.visible)load(card,true);
        }
        mediaPool?.refresh();
    }
    function onMediaChanged(event){
        if(globalThis.window?._reelsMediaWriteBatchDepth>0){if(event.detail)pendingMediaTasks.add(event.detail);return;}
        const card=cards.find(card=>card.task===event.detail);
        if(card){
            renderMediaNames(card);
            syncCardStageAspect(card);
            // Retain the last complete composition until the new media has a decoded frame.
            const src=capturePoster(card);
            if(src)showPoster(card,src,null);
            posterCache.delete(card.task);
            clearTimeout(card.posterTimer);
            refreshCards(card);
            if(!card.frame && card.visible)load(card,true);
            if(card.player && card.poster){
                const frame=card.frame, started=performance.now();
                const reveal=()=>{
                    if(!root || card.frame!==frame)return;
                    const ready=card.player.isReplacementFrameReady?.() ?? card.player.isFrameReady?.();
                    if(ready!==false || performance.now()-started>4000){
                        card.player.render?.();card.poster?.remove();card.poster=null;card.posterTime=null;
                    }else card.posterTimer=setTimeout(reveal,50);
                };
                card.posterTimer=setTimeout(reveal,50);
            }
        }
        mediaPool?.refresh();
    }
    function onUndoPush(event){ if(root && ['media','edit'].includes(event.detail)) (root._rtoUndoOrder ||= []).push(event.detail); }
    function dropUndoOrder(kind){ const order=root?._rtoUndoOrder; const i=order?order.lastIndexOf(kind):-1; if(i>=0)order.splice(i,1); }
    function restoreInspector() {
        if (!inspectorHome) return;
        window.ReelsOverviewBatch?.detach();
        const {node, marker, css} = inspectorHome;
        marker.replaceWith(node); node.style.cssText = css;
        inspectorHome = null;
    }
    let swapMenuRequest = 0;
    function close() {
        document.querySelector('.reels-layer-manager')?.close();
        delete window.ReelsTaskLayerTools;layerTaskFilter=null;layerFilterCriteria=null;
        swapMenuRequest++;
        window.ReelsLayoutEditor?.stopInlineLayout?.();
        mediaPool?.dispose(); mediaPool = null;
        clearInterval(resourceTimer); clearTimeout(resourceDebounce);
        resetLoadQueue();
        pauseAll(); stop(); clearInterval(timer); clearTimeout(refreshTimer); observer?.disconnect(); restoreInspector();
        cards.forEach(c => { if (c.frame) capturePoster(c); });
        cards.forEach(c => {window.ReelsOverviewEdit?.unmount(c);clearTimeout(c.releaseTimer);clearTimeout(c.posterTimer);c.player?.dispose?.();c.player?.close();}); root?.remove(); root = null; cards = [];
        window.ReelsOverviewEdit?.resetHistory?.();
        reportResources('close');
        // 恢复主预览并保存总览期间留在任务中的修改。
        if (window._reelsState?.selectedIdx >= 0) window.reelsSelectTask(window._reelsState.selectedIdx);
        window.ReelsPreviewV2?.setSuspended?.(false);
        window.removeEventListener('reels-task-media-changed',onMediaChanged);
        window.removeEventListener('reels-media-batch-start',onMediaBatchStart);window.removeEventListener('reels-media-batch-end',onMediaBatchEnd);
        window.removeEventListener('reels-overlay-selection-changed',onOverlaySelectionChanged);
        window.removeEventListener('keydown', onKey, true);
        window.removeEventListener('reels-overview-undo-push', onUndoPush);
        window.removeEventListener('reels-preview-edit-settings',syncOverviewSettings);
        window.removeEventListener('reels-resolution-changed', onResolutionChanged);
    }
    function onKey(e) {
        if (e.key === 'Escape') { if(document.querySelector('.reels-layer-manager[open],.reels-layout-copy-dialog[open]'))return; if(root?.querySelector('.rto-swap-menu')){root.querySelector('.rto-swap-menu').remove();return;} if(root?._romReplacementTarget){mediaPool?.cancelReplacement?.();e.preventDefault();e.stopImmediatePropagation();return;} if(root?._romClickSwap || root?.querySelector('.rom-confirm[open]') || document.querySelector('.rbt-media-swap-dialog[open],.rom-combination-preview[open],.rom-background-pairing-dialog[open],.rom-phone-replacement[open],.reels-material-sources[open]'))return; close(); return; }
        const t = e.target;
        // 只有文本输入保留原生撤销；下拉框/复选框/按钮获得焦点时（例如确认框关闭后）仍应撤销总览修改。
        const inField = t?.closest?.('textarea,[contenteditable="true"]')
            || (t?.tagName === 'INPUT' && ['text','number','search','password','url','email',''].includes(t.type));
        if (inField || t?.closest?.('dialog')) return;
        const key = e.key.toLowerCase();
        // 总览打开时，Reels 主界面的全局 Cmd+Z/Cmd+Shift+Z 会用旧工程快照整体替换任务对象，
        // 卡片仍持有旧对象，表现为“撤销没反应”且之后的修改写不进工程。这里一律拦下。
        if ((e.metaKey || e.ctrlKey) && !e.altKey && (key === 'z' || key === 'y')) {
            e.preventDefault(); e.stopImmediatePropagation();
            if (key === 'y' || e.shiftKey) return;
            const order = root?._rtoUndoOrder || [];
            const mediaUndo = root?.querySelector('.rom-undo');
            if (order[order.length - 1] === 'media' && mediaUndo && !mediaUndo.disabled) mediaUndo.click();
            else root?.querySelector('.rto-edit-undo')?.click();
            return;
        }
        // 其余快捷键（方向键微调等）不能抢下拉框/滑块/弹窗自身的按键。
        if (t?.closest?.('input,select,dialog')) return;
        // Cmd+Option+C / V：复制样式 / 粘贴（Option 会改变 e.key，用 e.code）。
        if ((e.metaKey || e.ctrlKey) && e.altKey && (e.code === 'KeyC' || e.code === 'KeyV')) {
            e.preventDefault();
            root?.querySelector(e.code === 'KeyC' ? '.rto-copy-style' : '.rto-paste')?.click();
            return;
        }
        // 方向键微调选中图层：1px，Shift 10px。
        const arrows = {ArrowUp:[0,-1], ArrowDown:[0,1], ArrowLeft:[-1,0], ArrowRight:[1,0]};
        if (arrows[e.key] && !e.metaKey && !e.ctrlKey && !e.altKey) {
            const step = e.shiftKey ? 10 : 1;
            if (window.ReelsOverviewEdit?.nudge?.(arrows[e.key][0] * step, arrows[e.key][1] * step)) e.preventDefault();
        }
    }
    function overviewSwapOptions(card, secondTask) {
        return {firstTask:card.task,secondTask,overview:true,
            beforeSwap:(tasks,columns)=>rememberSwap(tasks.flatMap(task=>columns.map(column=>({task,column,value:window._rbtReadMediaCell(task,column)})))),
            afterSwap:undo=>{(root._rtoSwapUndo ||= []).push(undo);(root._rtoUndoOrder ||= []).push('swap');refreshNames();},
        };
    }
    function rememberSwap(entries) {
        return ()=>{
            const tasks=[...new Set(entries.map(item=>item.task))];
            pauseAll();stop();
            for(const {task,column,value} of entries){
                const idx=window._reelsState.tasks.indexOf(task);if(idx<0)continue;
                window._rbtWriteMediaCell(task,column,value,idx);
                if(column.field==='bg'){task.bgSrcUrl=null;task.srcUrl=null;}
                window._syncSelectedTaskOverlayMgrIfNeeded(idx);
            }
            finishSwap(tasks);window.showToast?.('已撤销素材互换','success');
        };
    }
    function finishSwap(tasks) {
        window._syncTasksToActiveTab();window._batchAutoSave({skipSync:true});window.reelsSaveHistory?.();
        for(const task of tasks)window.dispatchEvent(new CustomEvent('reels-task-media-changed',{detail:task}));
        refreshNames();
    }
    function openCardSwap(card,secondTask) {
        pauseAll();stop();window._rbtOpenMediaSwapDialog(overviewSwapOptions(card,secondTask));
    }
    function syncSwapSelection() {
        if(!root)return;
        const selectedCount=cards.filter(card=>root._rtoSelectedTasks.has(card.task)).length;
        for(const selector of ['.rom-task-count','.rto-selection-count']){const count=root.querySelector(selector);if(count)count.textContent=`已选 ${selectedCount} / ${cards.length} 个任务`;}
        const deleteButton=root.querySelector('.rto-delete-selected');
        if(deleteButton)deleteButton.disabled=selectedCount===0;
        const scope=root.querySelector('.rom-scope');if(scope)scope.value='selected';
        mediaPool?.selectionChanged();
        globalThis.window?.ReelsOverviewBatch?.update();
        for(const card of cards){
            const checked=root._rtoSelectedTasks.has(card.task);
            card.el.classList.toggle('rto-swap-selected',checked);
            const input=card.el.querySelector('.rom-task-select input');if(input)input.checked=checked;
        }
    }
    function deleteSelectedTasks() {
        const selected=cards.filter(card=>root?._rtoSelectedTasks.has(card.task)).map(card=>card.task);
        if(!selected.length || typeof window.reelsDeleteTasks!=='function')return;
        if(!window.confirm(`确定删除选中的 ${selected.length} 个任务吗？\n将从工程及所属标签页中删除任务，原始素材文件会保留。`))return;
        const previousPage=page;
        close();
        const count=window.reelsDeleteTasks(selected);
        if(window._reelsState.tasks.length){
            window.reelsOpenTaskOverview();
            if(previousPage>0)renderPage(previousPage);
        }
        window.showToast?.(`已删除 ${count} 个任务`,'success');
    }
    function openWithinCardSwap(card) {
        const layers=[{field:'bg',label:'背景'},...window._getStableBatchMediaLayers(card.task).map((layer,mediaIndex)=>({field:'pip',mediaSlot:layer.slotKey || layer._templateOverlayId || layer.id,mediaIndex,label:layer.name || `媒体层 ${mediaIndex+1}`}))]
            .filter(layer=>layer.field==='bg' || window._findBatchMediaOverlayForDisplay(card.task,layer.mediaSlot,layer.mediaIndex,card.id));
        const dialog=document.createElement('dialog');dialog.className='rbt-media-swap-dialog';
        dialog.style.cssText='width:min(480px,90vw);background:#232530;color:#eee;border:1px solid #666;border-radius:10px;padding:20px;';
        const choices=layers.map((layer,i)=>`<option value="${i}">${escape(layer.label)}</option>`).join('');
        dialog.innerHTML=`<h3>本任务内媒体互换</h3><p style="overflow-wrap:anywhere">${escape(card.name)}</p><label>素材 A <select data-a>${choices}</select></label><br><br><label>素材 B <select data-b>${choices}</select></label><p>只交换素材，保留各层的位置、尺寸和文案。支持撤销。</p><p data-error style="color:#ffb09f"></p><button data-cancel>取消</button> <button data-apply>确认互换</button>`;
        dialog.querySelector('[data-b]').value=layers.length>1?'1':'0';
        dialog.querySelector('[data-cancel]').onclick=()=>dialog.close();dialog.onclose=()=>dialog.remove();
        dialog.querySelector('[data-apply]').onclick=()=>{
            try{
                const columns=[layers[Number(dialog.querySelector('[data-a]').value)],layers[Number(dialog.querySelector('[data-b]').value)]];
                const undo=rememberSwap(columns.map(column=>({task:card.task,column,value:window._rbtReadMediaCell(card.task,column)})));
                pauseAll();stop();window.reelsSaveHistory?.();
                window._rbtSwapMediaCellPairs(window._reelsState.tasks,[columns.map(column=>({...column,task:card.task}))]);
                window._syncSelectedTaskOverlayMgrIfNeeded(window._reelsState.tasks.indexOf(card.task));
                overviewSwapOptions(card).afterSwap(undo);finishSwap([card.task]);dialog.close();window.showToast?.('已互换本任务的媒体','success');
            }catch(error){dialog.querySelector('[data-error]').textContent=error.message;}
        };
        root.appendChild(dialog);dialog.showModal();
    }
    function openSwapMenu(card,x,y,mediaPoint=null) {
        // Context actions edit task data; missing or buffering media must not
        // prevent opening them. Unloaded cards offer an explicit layer chooser.
        if(!root)return;
        ++swapMenuRequest;
        root.querySelector('.rto-swap-menu')?.remove();
        if(!root._rtoSelectedTasks.has(card.task)){root._rtoSelectedTasks.clear();root._rtoSelectedTasks.add(card.task);syncSwapSelection();}
        const selected=cards.filter(item=>root._rtoSelectedTasks.has(item.task));
        const menu=document.createElement('div');menu.className='rto-swap-menu';menu.setAttribute('role','menu');
        menu.style.cssText='position:fixed;z-index:100000;background:#262938;color:#eee;padding:8px;border:1px solid #777;border-radius:8px;box-shadow:0 8px 30px #0009;display:grid;gap:8px;max-width:300px';
        menu.style.maxHeight='calc(100vh - 16px)';menu.style.overflowY='auto';
        menu.style.left='8px';menu.style.top='8px';
        menu.onclick=event=>event.stopPropagation();
        const swap=document.createElement('button');swap.setAttribute('role','menuitem');swap.textContent=`⇄ 选中的两个任务互换素材（已选 ${selected.length} 个）`;swap.disabled=selected.length!==2;
        swap.onclick=()=>{menu.remove();openCardSwap(selected[0],selected[1].task);};
        const inner=document.createElement('button');inner.setAttribute('role','menuitem');inner.textContent='⇄ 本任务内两个媒体层互换';inner.onclick=()=>{menu.remove();openWithinCardSwap(card);};
        const hint=document.createElement('small');hint.textContent='勾选任务或 ⌘/Ctrl 点选两张卡片，再右键互换。同组任务也支持。';
        const frameRect=card.frame?.getBoundingClientRect();
        const point=mediaPoint || (frameRect?{x:(x-frameRect.left)*(card.frame.contentWindow.innerWidth/frameRect.width),y:(y-frameRect.top)*(card.frame.contentWindow.innerHeight/frameRect.height)}:{x,y});
        const overlay=window.reelsPreviewMediaAtPoint?.(card.task,card.player,card.stage,point.x,point.y);
        const group=(title,append)=>{
            const heading=document.createElement('div');heading.textContent=title;
            heading.style.cssText='padding:8px 5px 2px;color:#a9abc0;font-size:11px;font-weight:600;border-top:1px solid #414454';
            menu.appendChild(heading);
            const count=menu.children.length;append();
            if(menu.children.length===count)heading.remove?.();
        };
        group('查看与复制',()=>{
        window.ReelsMaterialSources?.appendAction(menu,card.task);
        window.ReelsLayoutDescription?.appendAction(menu,card.task,card.player);
        });
        const previewRect=card.player?.getCanvas?.()?.getBoundingClientRect?.() || card.stage.getBoundingClientRect();
        group('替换与关联素材',()=>{
        mediaPool?.appendPhoneActions?.(menu,card,overlay,()=>{pauseAll();stop();});
        window.reelsAppendBackgroundLinkActions?.(menu,card.task,overlay);
        if(overlay || (point.x>=previewRect.left && point.y>=previewRect.top && point.x<=previewRect.right && point.y<=previewRect.bottom))mediaPool?.appendReplacementActions?.(menu,card,overlay);
        if(overlay){const background=document.createElement('button');background.setAttribute('role','menuitem');background.textContent='设为背景';background.onclick=()=>{menu.remove();try{window.reelsSetOverlayAsBackground(card.task,overlay);}catch(error){window.showToast?.(error.message,'warning');}};menu.appendChild(background);}
        });
        group('画面调整',()=>{
            window.reelsAppendMediaScaleResetActions?.(menu,card.task,overlay);
            if(!overlay && point.x>=previewRect.left && point.y>=previewRect.top && point.x<=previewRect.right && point.y<=previewRect.bottom)window.reelsAppendBackgroundFillAction?.(menu,card.task);
        });
        group('素材互换',()=>menu.append(swap,inner,hint));
        root.appendChild(menu);
        menu.style.left=`${Math.max(8,Math.min(x,window.innerWidth-menu.offsetWidth-8))}px`;menu.style.top=`${Math.max(8,Math.min(y,window.innerHeight-menu.offsetHeight-8))}px`;
    }
    function refreshChangedTasks(tasks) {
        for (const card of cards) {
            if (!tasks.includes(card.task)) continue;
            syncCardStageAspect(card);
            posterCache.delete(card.task);
            if (card.player) refreshCards(card);
            else { card.poster?.remove(); card.poster = null; card.posterTime = null; if (card.visible) load(card, true); }
        }
    }
    function snapshot(card, child) {
        const rs = window._reelsState;
        const task = clone(card.task);
        if (rs.tasks[rs.selectedIdx] === card.task && rs.overlayProxy?.overlayMgr) task.overlays = clone(rs.overlayProxy.overlayMgr.overlays);
        task.subtitleStyle = clone(window._resolveSubtitleStyleForTask?.(card.task) || task.subtitleStyle || rs.globalSubtitleStyle || {});
        child._reelsState = {tasks:[task], selectedIdx:0, targetWidth:window.ReelsLayoutTemplate?.taskCanvas?.(task, rs)?.width || rs.targetWidth, targetHeight:window.ReelsLayoutTemplate?.taskCanvas?.(task, rs)?.height || rs.targetHeight, globalSubtitleStyle:task.subtitleStyle, watermarks:clone(rs.watermarks || []), _multiBgDurations:rs._multiBgDurations};
        child.__reelsOverviewCard = true;
        child.__reelsOverviewMuted = root?.querySelector('.rto-muted')?.checked !== false;
        child.electronAPI = window.electronAPI;
        document.fonts?.forEach(face => { try { child.document.fonts.add(face); } catch (_) {} });
        for (const name of ['_toPlayablePath','_isImagePath','_resolvePreviewBackgroundPath','_getEffectiveBgClipPool','_resolveTaskHookPath','_getEffectiveBgmPath','_getEffectiveVoiceVolumePercent','_getEffectiveBgVolumePercent','_getEffectiveBgmVolumePercent']) {
            if (typeof window[name] === 'function') child[name] = (...args) => window[name](...args);
        }
    }
    // Called synchronously before the frame loads any rendering modules.
    window.reelsOverviewBootstrap = (id, child) => {
        const card = cards.find(c => c.id === id);
        if (card) { snapshot(card, child); card.signature = JSON.stringify(child._reelsState); }
    };
    // Module initialization does not need to wait for media buffering / iframe load.
    window.reelsOverviewReady = (id, child) => {
        const card = cards.find(c => c.id === id);
        if (card?.frame?.contentWindow === child) card.frame.onload?.();
    };
    function previewDocument(bootstrap, ready) {
        const base = new URL('.', location.href).href;
        const settings = Array.from(document.querySelectorAll('input[id^="reels-"],select[id^="reels-"]')).map(el => {
            // 播放器只读取当前值，不能为每张卡复制数千个字体选项。
            const copy = el.cloneNode(false);
            if (copy.tagName === 'INPUT') { copy.setAttribute('value', el.value); copy.toggleAttribute('checked', el.checked); }
            else {
                const option = document.createElement('option');
                option.value = el.value; option.textContent = el.selectedOptions?.[0]?.textContent || el.value;
                option.setAttribute('selected', ''); copy.appendChild(option);
            }
            return copy.outerHTML;
        }).join('');
        return `<!doctype html><html><head><base href="${escape(base)}"><style>html,body{margin:0;height:100%;overflow:hidden;background:#111}#reels-preview-v2-root{height:100%!important}.rpv2-controls,.rpv2-floating-open{display:none!important}.rpv2-window{grid-template-rows:1fr!important}.rpv2-stage{max-width:100%!important;max-height:100%!important;box-shadow:none!important}</style></head><body><div hidden>${settings}</div><script>${bootstrap}<\/script>${dependencies.map(path => `<script src="${path}"><\/script>`).join('')}<script>${ready}<\/script></body></html>`;
    }
    // Reuse the overview's isolated player for staged layout previews. Only
    // snapshots enter the iframe; the task list and original player stay intact.
    const standalonePreviews = new Map();
    let standaloneId = 0;
    window.reelsLayoutPreviewBootstrap = (id, child) => {
        const entry = standalonePreviews.get(id);
        if (!entry) return;
        snapshot({ task: entry.task }, child);
        child.__reelsOverviewMuted = true;
        child.__reelsLayoutReview = true;
    };
    window.reelsLayoutPreviewReady = (id, child) => {
        const entry = standalonePreviews.get(id);
        if (!entry || entry.frame.contentWindow !== child || entry.player) return;
        entry.player = child.ReelsPreviewV2;
        if (!entry.player) return;
        entry.player.setMuted(true);
        entry.player.seek(entry.time);
        // Hide overview's editor guides; this is a review of a staged result.
        const guides = child.document.querySelector('#reels-show-subtitle-range');
        if (guides) guides.checked = false;
        entry.player.render?.();
        entry.onReady?.(entry.player);
    };
    window.ReelsOverviewPreview = {
        create(task, { time = 0, onReady } = {}) {
            const id = ++standaloneId;
            const frame = document.createElement('iframe');
            frame.title = '布局任务实际画面预览';
            frame.style.cssText = 'width:100%;height:100%;border:0;pointer-events:none';
            const entry = { frame, task: clone(task), time, onReady, player: null };
            standalonePreviews.set(id, entry);
            frame.srcdoc = previewDocument(`parent.reelsLayoutPreviewBootstrap(${id},window);`,
                `document.addEventListener('DOMContentLoaded',()=>parent.reelsLayoutPreviewReady(${id},window));`);
            return { frame, get player() { return entry.player; },
                updateTask(task) {
                    const next = clone(task);
                    // Keep layer identities stable while dragging geometry. This
                    // lets decoded video frames stay cached in the child player.
                    const previous = frame.contentWindow?._reelsState?.tasks?.[0] || entry.task;
                    const ids = new Map();
                    for (const layer of next.overlays || []) {
                        const old = (previous.overlays || []).find(ov => layer.slotKey && ov.slotKey === layer.slotKey);
                        if (old) { ids.set(layer.id, old.id); layer.id = old.id; }
                    }
                    if (next.visualOverlayOrder) next.visualOverlayOrder = next.visualOverlayOrder.map(key => key.startsWith('overlay:') ? `overlay:${ids.get(key.slice(8)) || key.slice(8)}` : key);
                    entry.task = next;
                    const state = frame.contentWindow?._reelsState;
                    if (state) { state.tasks = [next]; state.selectedIdx = 0; entry.player?.render?.(); }
                },
                dispose() {
                    if (!standalonePreviews.has(id)) return;
                    entry.player?.dispose?.(); entry.player?.close?.();
                    frame.remove(); standalonePreviews.delete(id);
                },
            };
        },
    };
    function resetLoadQueue() {
        clearTimeout(loadTimer); loadTimer = null;
        loadQueue.length = 0; loadingCards.clear();
        cards.forEach(card => { card.loadPriority = false; card.prewarm = false; });
    }
    function pumpLoadQueue() {
        loadTimer = null;
        if (!root || globalThis.window?._reelsMediaWriteBatchDepth>0) return;
        for (const [card, pending] of loadingCards) {
            if (card.frame !== pending.frame) { loadingCards.delete(card); continue; }
            if (!card.visible && !card.prewarm && !card.loadPriority && card !== active && !card.dragging) {
                releaseCard(card); loadingCards.delete(card); continue;
            }
            if (card.player?.isFrameReady?.() === true || performance.now() - pending.started > 15000) {
                const ready = card.player?.isFrameReady?.() === true;
                card.previewTimedOut = !ready;
                const failure = card.player?.getMediaFailure?.();
                card.status.textContent = ready ? (failure ? `${failure.role}不可用，显示现有素材` : '就绪') : '素材加载较慢';
                loadingCards.delete(card);
                if (ready && card.prewarm && !card.visible && !card.loadPriority) {
                    // 完整合成首帧保存为预览图，后台不长期占用视频解码器。
                    card.player.render(); releaseCard(card);
                }
                card.prewarm = false; card.loadPriority = false;
            }
        }
        for (let i = loadQueue.length - 1; i >= 0; i--) {
            if (loadQueue[i].frame || (allPlaying && !loadQueue[i].groupPlayback) || (!loadQueue[i].visible && !loadQueue[i].prewarm && !loadQueue[i].loadPriority)) loadQueue.splice(i, 1);
        }
        loadQueue.sort((a,b) => Number(!!b.loadPriority) - Number(!!a.loadPriority) || Number(!!b.visible) - Number(!!a.visible));
        while (loadQueue.length && loadingCards.size < MAX_LOADING_PLAYERS) {
            const card = loadQueue.shift();
            const frame = startCardLoad(card);
            if (!frame) { loadQueue.unshift(card); break; }
            loadingCards.set(card, {frame, started:performance.now()});
        }
        if (loadQueue.length || loadingCards.size) loadTimer = setTimeout(pumpLoadQueue, 120);
    }
    function load(card, priority = false) {
        if(globalThis.window?._reelsMediaWriteBatchDepth>0){if(event.detail)pendingMediaTasks.add(event.detail);return;}
        card.lastUsed = performance.now();
        if (card.frame) return;
        if (allPlaying && !card.groupPlayback) return;
        if (card.poster && card.posterTime === card.time && !priority) return;
        card.loadPriority ||= priority;
        const index = loadQueue.indexOf(card);
        if (index >= 0 && priority) loadQueue.splice(index, 1);
        if (index < 0 || priority) {
            if (priority) loadQueue.unshift(card); else loadQueue.push(card);
        }
        card.status.textContent = '排队加载';
        if (!loadTimer) loadTimer = setTimeout(pumpLoadQueue, 0);
    }
    function startCardLoad(card) {
        if (!makePlayerRoom(card)) return;
        card.previewTimedOut = false;
        card.status.textContent = '正在加载预览…';
        const frame = document.createElement('iframe'); card.frame = frame;
        frame.title = `${card.name} 合成预览`; frame.style.cssText = 'width:100%;height:100%;border:0;pointer-events:none';
        frame.srcdoc = previewDocument(`parent.reelsOverviewBootstrap(${card.id},window);`,
            `document.addEventListener('DOMContentLoaded',()=>parent.reelsOverviewReady(${card.id},window));`);
        frame.onload = () => {
            if (!root || card.frame !== frame || !frame.isConnected || card.player) return;
            card.player = frame.contentWindow.ReelsPreviewV2;
            if (!card.player) { card.status.textContent = '预览加载失败'; return; }
            frame.contentDocument.addEventListener('contextmenu',event=>{
                event.preventDefault();event.stopPropagation();const rect=frame.getBoundingClientRect();
                openSwapMenu(card,rect.left+event.clientX*rect.width/Math.max(1,frame.contentWindow.innerWidth),rect.top+event.clientY*rect.height/Math.max(1,frame.contentWindow.innerHeight),{x:event.clientX,y:event.clientY});
            },true);
            frame.contentDocument.addEventListener('error', event => {
                if (event.target?.matches?.('video,audio')) reportResources('media-error');
            }, true);
            queueResourceReport('load');
            card.player.setMuted(root.querySelector('.rto-muted').checked);
            card.player.setSuspended(card.visible===false && !card.prewarm && !card.loadPriority);
            seek(card, card.requestedTime ?? card.time);
            card.status.textContent = '正在加载画面…';
            const revealStarted = performance.now();
            const reveal = () => {
                if (card.frame !== frame || !frame.isConnected) return;
                // 素材损坏/解码器被回收时 isFrameReady 可能永远为 false；
                // 截图不能无限遮住真实播放器。
                if ((card.player?.isReplacementFrameReady?.() ?? card.player?.isFrameReady?.()) !== false || performance.now() - revealStarted > 4000) {
                    card.poster?.remove(); card.poster = null;
                } else card.posterTimer = setTimeout(reveal, 200);
            };
            if (card.poster) card.posterTimer = setTimeout(reveal, 200);
            if (root.querySelector('.rto-edit-mode').checked) enableEditing(card);
            if (allPlaying) { playGroupCard(card); return; }
            if (card.pendingPlayback) {
                const pending = card.pendingPlayback; card.pendingPlayback = null;
                if (!pending.hover || card.stage.matches(':hover')) startPlayback(card, pending.speed, pending.hover);
                return;
            }
            if (!root._romClickSwap && !root.classList.contains('rom-dragging') && card.stage.matches(':hover') && root.querySelector('.rto-hover').checked) startPlayback(card, Number(root.querySelector('.rto-hover-speed').value), true);
        };
        if (card.poster) card.stage.appendChild(frame);
        else {
            const layoutTools = [...card.stage.children].filter(el => el.classList.contains('lt-grid-handles') || el.querySelector('[data-inline-done]'));
            card.stage.replaceChildren(frame, ...layoutTools);
        }
        return frame;
    }
    function enableEditing(card) {
        if (!card.player || !root || root.querySelector('.rto-layout-mode')?.checked) return;
        window.ReelsOverviewEdit.mount(card, {
            select: () => { pauseAll(); stop(); selectCard(card); },
            refresh: () => refreshCards(card),
            target: () => root.querySelector('.rto-edit-target').value,
            targets: () => root.querySelector('.rto-edit-target').value === 'multi' ? Array.from(root.querySelectorAll('.rto-layer-check:checked'),input=>input.value) : [],
            axis: () => root.querySelector('.rto-edit-axis').value,
            mediaPart: () => root.querySelector('.rto-media-part').value,
        });
        const rs=window._reelsState,selected=rs.overlayPanel?._selectedOv;
        if(inspectorHome && rs.tasks?.[rs.selectedIdx]===card.task && selected)window.ReelsOverviewEdit.selectOverlay?.(card,selected.id);
    }
    function onOverlaySelectionChanged(event){
        if(!root || !inspectorHome || event.detail?.panel!==window._reelsState?.overlayPanel)return;
        const rs=window._reelsState,card=cards.find(card=>card.task===rs.tasks?.[rs.selectedIdx]);
        if(!card || card.dragging)return;
        const overlay=event.detail.overlay;
        if(!overlay){window.ReelsOverviewEdit.clearSelection?.(card);return;}
        if(root.querySelector('.rto-edit-mode').checked){
            enableEditing(card);window.ReelsOverviewEdit.selectOverlay?.(card,overlay.id);
        }
        rs.overlayPanel.container?.querySelector('.rop-list-item.selected')?.scrollIntoView({block:'nearest'});
    }
    function startPlayback(card, speed, hover = false) {
        if (hover && root.querySelector('.rto-edit-mode').checked) return;
        pauseAll();
        stop();
        if(!hover)window.ReelsOverviewEdit.configure({muted:false});
        if (!card.player) { card.pendingPlayback = {speed, hover};setCardPlayLabel(card,'⏸ 暂停');load(card, true); return; }
        active = card; card.hoverPlayback = hover;
        queueResourceReport('play');
        if (card.time >= card.player.getDuration()) card.player.seek(0);
        card.speedControl = hover ? '.rto-hover-speed' : '.rto-speed';
        card.player.play(speed);
        // 开始播放后截图必须让位，否则画面会停在缓存图上。
        clearTimeout(card.posterTimer); card.poster?.remove(); card.poster = null;
        setCardPlayLabel(card, '⏸ 暂停');
        card.status.textContent = `${speed} 倍速播放`;
        const tick = () => {
            if (active !== card) return;
            const time = Math.min(card.player.getDuration(), card.player.getCurrentTime());
            card.slider.value = time; card.label.textContent = fmt(time);
            card.raf = requestAnimationFrame(tick);
        };
        card.raf = requestAnimationFrame(tick);
    }
    function mediaFileRows(task) {
        const paths=values=>[...new Set(values.map(value=>typeof value==='string'?value:value?.path).filter(Boolean))];
        const bg=task.bgMode==='multi'?(task.bgClipActivePool?.length?task.bgClipActivePool:task.bgClipPool || []):[task.bgPath || task.videoPath];
        const rows=[],background=paths(bg);
        if(background.length)rows.push({label:'背景',paths:background});
        let index=0;
        for(const layer of task.overlays || []){
            if(!['image','video','media'].includes(layer.type))continue;index++;
            if(layer.disabled)continue;
            const files=paths(layer.media_folder_files?.length?layer.media_folder_files:[layer.content]);
            const folder=layer.media_folder_path || (layer.media_folder_files?.length?String(files[0] || '').replace(/[\\/][^\\/]+$/,''):'');
            const displayed=folder?[String(folder).replace(/[\\/]+$/,'') || folder]:files;
            if(displayed.length)rows.push({label:layer.slotLabel || layer.name || `媒体层 ${index}`,paths:displayed});
        }
        return rows;
    }
    function renderMediaNames(card){
        const element=card.el.querySelector('.rto-media-files');if(!element)return;
        const rows=mediaFileRows(card.task),signature=JSON.stringify(rows);if(element.dataset.signature===signature)return;
        element.dataset.signature=signature;
        element.innerHTML=rows.map(row=>`<div class="rto-media-file-row"><span class="rto-media-file-layer">${escape(row.label)}：</span>${row.paths.map(path=>`<span class="rto-media-file-name" title="${escape(path)}">${escape(String(path).split(/[\\/]/).pop() || path)}</span>`).join('<span>、</span>')}</div>`).join('') || '<div class="rto-media-file-row">暂无媒体文件</div>';
    }
    function refreshNames() {
        cards.forEach(renderMediaNames);
        if (!root || typeof window._reelsTaskDisplayName !== 'function') return;
        const names = window._reelsPreviewExportNames?.() || new Map();
        const source = window._getReelsTaskNameSource?.();
        cards.forEach(card => {
            const index = window._reelsState.tasks.indexOf(card.task);
            if (index < 0) return;
            const resolved = window._reelsTaskDisplayName(card.task, index, source, names.get(card.task));
            card.name = resolved.baseName;
            const label = card.el.querySelector('.rto-name');
            label.textContent = card.name; label.title = resolved.displayName;
            card.slider.setAttribute('aria-label', `${card.name} 播放进度`);
            if (card.frame) card.frame.title = `${card.name} 合成预览`;
            if (inspectorHome && window._reelsState.selectedIdx === index) root.querySelector('.rto-edit-title').textContent = card.name;
        });
    }
    function refreshCards(onlyCard) {
        if (!root || !onlyCard) return;
        for (const card of cards) {
            if (card !== onlyCard) continue;
            renderMediaNames(card);
            syncCardStageAspect(card);
            if (!card.player || card.dragging) continue;
            const before = card.signature;
            snapshot(card, card.frame.contentWindow);
            card.signature = JSON.stringify(card.frame.contentWindow._reelsState);
            if (before !== card.signature) card.player.refresh();
        }
    }
    function renderPage(nextPage) {
        pauseAll();
        resetLoadQueue();
        stop();
        observer.disconnect();
        restoreInspector();
        root.querySelector('.rto-drawer').hidden = true;
        const filtered=filteredCards();
        const pageCount = Math.max(1,Math.ceil(filtered.length / pageSize));
        page = Math.max(0, Math.min(pageCount - 1, nextPage));
        // Release the previous page's decoders and render loops, preserving each
        // task's requested time so returning to a page restores its position.
        for (const card of cards) {
            clearTimeout(card.releaseTimer);card.visible=false;
            window.ReelsOverviewEdit?.unmount(card);
            if (!card.frame) continue;
            clearTimeout(card.posterTimer);
            card.player?.dispose?.(); card.player?.close();
            card.poster?.remove(); card.poster = null;
            card.frame.onload = null;
            card.frame.remove();
            card.frame = null; card.player = null;
            card.stage.textContent = '加载合成预览…';
            card.status.textContent = '等待加载';
        }
        const grid = root.querySelector('.rto-grid');
        const start = page * pageSize;
        const visible = filtered.slice(start, start + pageSize);
        grid.replaceChildren(...visible.map(card => card.el));
        grid.scrollTop = 0;
        visible.forEach(card => { observer.observe(card.el); if (allPlaying && card.visible) load(card); });
        // 只加载进入视口的任务，避免打开总览就解码整页素材。
        root.querySelector('.rto-page-info').textContent = `第 ${page + 1} / ${pageCount} 页 · ${filtered.length?start + 1:0}–${start + visible.length} / ${filtered.length} 个任务${layerTaskFilter?`（按层筛选，原共 ${cards.length} 个）`:''}`;
        root.querySelector('.rto-select-all').textContent=layerTaskFilter?'全选筛选结果':'全选全部任务';
        const clearFilter=root.querySelector('.rto-layer-filter-clear');if(clearFilter)clearFilter.hidden=!layerTaskFilter;
        root.querySelector('.rto-prev').disabled = page === 0;
        root.querySelector('.rto-next').disabled = page === pageCount - 1;
        const pageSelect=root.querySelector('.rto-page-select');
        pageSelect.innerHTML=Array.from({length:pageCount},(_,i)=>`<option value="${i}">第 ${i+1} 页</option>`).join('');
        pageSelect.value=page;
        queueResourceReport('page');
    }
    function seek(card, time) {
        card.requestedTime = Math.max(0, Number(time) || 0);
        const duration = card.player?.getDuration() || card.duration;
        card.time = Math.min(Math.max(0, Number(time) || 0), duration || Infinity);
        card.slider.value = card.time; card.label.textContent = fmt(card.time);
        card.status.textContent = duration && time > duration ? '已到结尾' : '就绪';
        card.player?.seek(card.time);
        // Cached cards must regenerate their composed frame after a seek.
        // Keep the old image until the queued player has decoded the new frame;
        // hidden cards refresh when they enter the viewport.
        if (!card.frame && card.visible && card.posterTime !== card.time) load(card);
    }
    function selectCard(card) {
        const rs = window._reelsState;
        const idx = rs.tasks.indexOf(card.task);
        if (idx < 0) return false;
        load(card, true);
        if (rs.selectedIdx !== idx) window.reelsSelectTask(idx, {overview:true});
        cards.forEach(c => {c.el.classList.toggle('selected',c===card);if(c!==card)window.ReelsOverviewEdit?.clearSelection?.(c);});
        if (inspectorHome) {
            root.querySelector('.rto-edit-title').textContent = card.name;
            window.ReelsOverviewBatch?.update();
        }
        return true;
    }
    function edit(card) {
        stop();
        if (!selectCard(card)) return;
        const drawer = root.querySelector('.rto-drawer'); drawer.hidden = false;
        root.querySelector('.rto-edit-title').textContent = card.name;
        if (!inspectorHome) {
            const node = document.getElementById('reels-col-subtitle');
            const marker = document.createComment('overview inspector home');
            inspectorHome = {node, marker, css:node.style.cssText}; node.replaceWith(marker);
            node.style.cssText = 'display:flex;flex-direction:column;flex:1;min-height:0;width:100%;overflow:hidden';
            drawer.appendChild(node);
            window.ReelsOverviewBatch?.attach({root,host:drawer,panel:window._reelsState.overlayPanel,tasks:()=>cards.map(card=>card.task),isDragging:task=>cards.some(card=>card.task===task && card.dragging),refresh:tasks=>refreshChangedTasks(tasks)});
        }
    }
    const settingsControls={enabled:'.rto-edit-mode',target:'.rto-edit-target',axis:'.rto-edit-axis',mediaPart:'.rto-media-part',guides:'.rto-guides',muted:'.rto-muted',speed:'.rto-speed',hover:'.rto-hover',hoverSpeed:'.rto-hover-speed'};
    function syncOverviewSettings(){
        if(!root)return;
        const settings=window.ReelsOverviewEdit.settings;
        for(const [key,selector] of Object.entries(settingsControls)){
            const input=root.querySelector(selector);
            if(input.type==='checkbox')input.checked=settings[key];else input.value=settings[key];
        }
        root.querySelectorAll('.rto-layer-check').forEach(input=>input.checked=settings.targets.includes(input.value));
        const hint=root.querySelector('.rto-scope-hint');
        if(hint)hint.textContent=settings.target==='multi' ? `仅允许勾选的 ${settings.targets.length} 个层 · 每次单独编辑一层` : settings.target==='auto' ? '点击画面选择元素 · 所有层均可编辑' : '只编辑指定对象';
        root.querySelector('details summary').textContent=`允许编辑的层（${settings.targets.length}）`;
        root.classList.toggle('rto-show-guides',settings.guides);
        root.querySelector('.rto-play-all').disabled=false;
        cards.forEach(card=>{
            card.player?.setMuted(settings.muted);
            window.ReelsOverviewEdit.unmount(card);
            if(settings.enabled)enableEditing(card);
        });
        if(active)active.player.play(Number(root.querySelector(active.speedControl).value));
    }
    window.reelsCloseTaskOverview = close;
    window.reelsOpenTaskOverview = () => {
        if (root) return;
        const tasks = window._reelsState?.tasks || [];
        if (!tasks.length) { window.showToast?.('请先添加任务', 'warning'); return; }
        window.ReelsPreviewV2?.pause?.();
        window.ReelsPreviewV2?.setSuspended?.(true);
        // Repair repeated slot identities before building the overview's layer choices.
        for(const task of tasks)for(const overlay of task.overlays || [])window.ReelsLayerSlots?.ensureDefault?.(overlay,task.overlays);
        const live=window._reelsState?.overlayProxy?.overlayMgr?.overlays || [];
        for(const overlay of live)window.ReelsLayerSlots?.ensureDefault?.(overlay,live);
        const layerChoices = new Map();
        for (const task of tasks) (task.overlays || []).forEach((ov, index) => {
            const key = ov.slotKey ? `slot:${ov.slotKey}` : `layer-index:${index}`;
            const label = ov.slotKey ? (ov.slotLabel || window.ReelsLayerSlots?.describe?.(ov.slotKey)?.label || ov.slotKey)
                : `第 ${index + 1} 层 · ${ov.name || (['image','video'].includes(ov.type) ? '媒体' : ov.type || '覆层')}`;
            if (!layerChoices.has(key)) layerChoices.set(key, label);
        });
        const lockedLayerOptions = [...layerChoices].map(([key,label]) => `<option value="${escape(key)}">锁定：${escape(label)}</option>`).join('');
        root = document.createElement('div'); root.id = 'reels-task-overview';
        root._rtoSelectedTasks=new Set();root._rtoSelectionChanged=syncSwapSelection;
        root.addEventListener('click',()=>root?.querySelector('.rto-swap-menu')?.remove());
        root.addEventListener('scroll',event=>{const menu=root?.querySelector('.rto-swap-menu');if(menu && !menu.contains(event.target))menu.remove();},true);
        root.innerHTML = `<style>
#reels-task-overview{position:fixed;inset:var(--window-titlebar-height,0px) 0 0;-webkit-app-region:no-drag;z-index:9900;background:#15171c;color:#eee;display:flex;flex-direction:column;font-size:13px}
#reels-task-overview button,#reels-task-overview input,#reels-task-overview select{accent-color:#8983ff}#reels-task-overview button{background:#313444;color:#eee;border:1px solid #555;border-radius:5px;padding:5px 10px;cursor:pointer}
.rto-toolbar{display:flex;align-items:center;gap:12px;padding:12px;border-bottom:1px solid #363944;flex-wrap:wrap}.rto-toolbar input[type=range]{flex:1;min-width:100px}.rto-body{display:flex;flex:1;min-height:0}.rto-grid{display:grid;grid-auto-rows:max-content;align-items:start;grid-template-columns:repeat(var(--columns,4),minmax(0,1fr));gap:16px;padding:16px;overflow:auto;flex:1;align-content:start}.rto-card{display:flex;flex-direction:column;align-self:start;border:2px solid #373a47;border-radius:9px;overflow:hidden;min-width:0;background:#22252d}.rto-card.selected{border-color:#8f88ff}.rto-card.rto-swap-selected{border-color:#b6a1ff;box-shadow:0 0 0 2px #b6a1ff}.rto-stage{box-sizing:content-box;width:100%;height:0;min-height:0;padding-top:177.777778%;flex-shrink:0;overflow:hidden;background:#080a0e;display:flex;align-items:center;justify-content:center;position:relative}.rto-stage>iframe{position:absolute!important;inset:0;width:100%!important;height:100%!important;display:block}.rto-card footer{position:static;flex-shrink:0;padding:10px;display:grid;gap:10px;min-height:110px;box-sizing:border-box}.rto-hide-media-names .rto-media-files{display:none}.rto-hide-task-names .rto-name{display:none}.rto-media-files{display:grid;gap:5px;border-top:1px solid #3f4558;padding-top:8px;font-size:11px;line-height:1.5;overflow-wrap:anywhere;user-select:text}.rto-media-file-layer{color:#b9c6f3;font-weight:600}.rto-media-file-name{color:#d0d2db}.rto-name{white-space:normal;overflow-wrap:anywhere;line-height:1.5}.rto-progress{display:flex;align-items:center;gap:5px}.rto-progress input{display:block;flex:1;width:100%;min-width:0;height:8px;background:#505467;border-radius:5px;appearance:none;cursor:pointer}.rto-progress input::-webkit-slider-thumb{appearance:none;width:16px;height:16px;border:2px solid #c4b5fd;border-radius:50%;background:#8b72ed}.rto-progress span{flex-shrink:0;font-variant-numeric:tabular-nums}.rto-progress-title{font-size:11px;color:#bcb8d6}.rto-drawer{width:370px;max-width:45vw;display:flex;flex-direction:column;border-left:1px solid #444;min-height:0}.rto-drawer[hidden]{display:none}.rto-edit-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}@media(max-width:900px){.rto-grid{grid-template-columns:repeat(var(--columns,2),minmax(0,1fr))}}@media(max-width:550px){.rto-grid{grid-template-columns:repeat(var(--columns,1),minmax(0,1fr))}}
#reels-task-overview.rto-show-guides .rto-stage::before,#reels-task-overview.rto-show-guides .rto-stage::after{content:"";position:absolute;z-index:3;pointer-events:none;box-shadow:0 0 1px #000}
#reels-task-overview.rto-show-guides .rto-stage::before{left:50%;top:0;bottom:0;border-left:1px dashed rgba(210,220,255,.8)}
#reels-task-overview.rto-show-guides .rto-stage::after{top:50%;left:0;right:0;border-top:1px dashed rgba(210,220,255,.8)}
</style><div class="rto-toolbar"><strong>任务预览总览 · ${tasks.length}</strong><label>播放速度 <select class="rto-speed" aria-label="按钮播放速度"><option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="1.5">1.5×</option><option value="2">2×</option><option value="3">3×</option><option value="4">4×</option></select></label><label><input class="rto-hover" type="checkbox"> 悬停预览</label><label>悬停速度 <select class="rto-hover-speed" aria-label="悬停播放速度"><option value="0.5">0.5×</option><option value="1">1×</option><option value="1.5">1.5×</option><option value="2" selected>2×</option><option value="3">3×</option><option value="4">4×</option></select></label><label>每行 <select class="rto-density" aria-label="每行卡片数量">${Array.from({length:19}, (_, i) => `<option value="${i + 2}"${i + 2 === 4 ? ' selected' : ''}>${i + 2}</option>`).join('')}</select></label><button class="rto-play-all">▶ 全部播放</button><label><input class="rto-muted" type="checkbox">静音</label><label><input class="rto-layout-mode" type="checkbox">调整布局</label><label><input class="rto-edit-mode" type="checkbox" checked>编辑画面</label><label><input class="rto-task-names" type="checkbox" checked>显示任务名字</label><label><input class="rto-media-names" type="checkbox" checked>显示媒体文件名</label><label><input class="rto-guides" type="checkbox">显示参考线</label><label>调整对象 <select class="rto-edit-target"><option value="multi">仅编辑勾选的层</option><option value="auto" selected>点击选择（全部层）</option><option value="subtitle">字幕</option><option value="background">背景</option><option value="content">内容视频</option>${lockedLayerOptions}</select></label><label>画中画调整 <select class="rto-media-part"><option value="window">整个窗口</option><option value="inner" selected>窗口内素材</option></select></label><label>拖动方向 <select class="rto-edit-axis"><option value="free">自由 XY</option><option value="x">仅 X（左右）</option><option value="y" selected>仅 Y（上下）</option></select></label><button class="rto-edit-undo">撤销画面调整</button><button class="rto-close">返回列表</button></div><div class="rto-toolbar"><span>统一时间</span><div class="rto-master-track"><output class="rto-master-current">0:00.0</output><output class="rto-master-hover" hidden></output><input class="rto-master" aria-label="统一预览时间" type="range" min="0" max="60" step="0.1" value="0"><div class="rto-master-ticks"></div></div><input class="rto-seconds" aria-label="统一时间（秒）" type="number" min="0" step="0.1" value="0" style="width:70px">秒 <span class="rto-mode">全部对齐</span></div><div class="rto-body"><div class="rto-grid"></div><aside class="rto-drawer" hidden><div class="rto-toolbar"><span class="rto-edit-title"></span><button class="rto-hide">收起</button></div></aside></div>`;
        document.body.appendChild(root);
        const multiLayers=document.createElement('details');
        multiLayers.style.cssText='position:relative';
        multiLayers.innerHTML=`<summary style="cursor:pointer">选择允许编辑的层</summary><div style="position:absolute;top:100%;left:0;z-index:10;min-width:240px;max-height:320px;overflow:auto;background:#252832;border:1px solid #555;padding:10px;box-shadow:0 8px 24px #0008">${[["background","背景"],...layerChoices].map(([key,label])=>`<label style="display:flex;gap:8px;padding:5px"><input class="rto-layer-check" type="checkbox" value="${escape(key)}">${escape(label)}</label>`).join('')}</div>`;
        root.querySelector('.rto-edit-target').closest('label').after(multiLayers);
        multiLayers.onchange=()=>{
            window.ReelsOverviewEdit.configure({target:'multi',targets:Array.from(root.querySelectorAll('.rto-layer-check:checked'),input=>input.value)});
            multiLayers.querySelector('summary').textContent=`允许编辑的层（${root.querySelectorAll('.rto-layer-check:checked').length}）`;
        };

        const tools=root.querySelector('.rto-toolbar');
        tools.classList.add('rto-heading');
        const sections=document.createElement('div');sections.className='rto-sections';
        const group=(title,selectors,description)=>{
            const section=document.createElement('section');section.className='rto-tool-group';
            const heading=document.createElement('div');heading.className='rto-group-title';heading.textContent=title;section.appendChild(heading);
            const body=document.createElement('div');body.className='rto-group-controls';section.appendChild(body);
            for(const selector of selectors){const node=root.querySelector(selector);if(node)body.appendChild(node.closest('label') || node);}
            if(description){const hint=document.createElement('div');hint.className='rto-scope-hint';hint.textContent=description;section.appendChild(hint);}
            sections.appendChild(section);
        };
        group('播放预览',['.rto-play-all','.rto-speed','.rto-muted','.rto-hover','.rto-hover-speed','.rto-task-names','.rto-media-names']);
        const taskNamesToggle=sections.querySelector('.rto-task-names');
        try{taskNamesToggle.checked=localStorage.getItem('reels_overview_task_names')!=='false';}catch(_){}
        const applyTaskNamesVisibility=()=>root.classList.toggle('rto-hide-task-names',!taskNamesToggle.checked);
        applyTaskNamesVisibility();
        taskNamesToggle.onchange=()=>{applyTaskNamesVisibility();try{localStorage.setItem('reels_overview_task_names',String(taskNamesToggle.checked));}catch(_){}};
        const mediaNamesToggle=sections.querySelector('.rto-media-names');
        try{mediaNamesToggle.checked=localStorage.getItem('reels_overview_media_names')!=='false';}catch(_){}
        const applyMediaNamesVisibility=()=>{root.classList.toggle('rto-hide-media-names',!mediaNamesToggle.checked);};
        applyMediaNamesVisibility();
        mediaNamesToggle.onchange=()=>{applyMediaNamesVisibility();try{localStorage.setItem('reels_overview_media_names',String(mediaNamesToggle.checked));}catch(_){}};
        const clipBox=document.createElement('span');clipBox.className='rto-clip-box';clipBox.style.cssText='display:inline-flex;gap:6px;align-items:center;flex-wrap:wrap';
        clipBox.innerHTML=`<button class="rto-copy-style" title="复制选中覆层的颜色、字体、字号、底色、描边、阴影等（不含文字内容和位置）· ⌘⌥C">复制样式</button><button class="rto-copy-pos" title="复制选中覆层的位置和大小">复制位置</button><button class="rto-copy-all" title="样式+位置一起复制（不含文字内容）">复制全部</button><label>粘贴到 <select class="rto-paste-scope"><option value="card">当前卡</option><option value="group" selected>本组全部</option><option value="all">全部任务</option></select></label><button class="rto-paste" title="粘贴到同一层位的图层（标题粘标题）· ⌘⌥V">粘贴</button>`;
        tools.appendChild(clipBox);
        group('复制粘贴图层',['.rto-clip-box'],'点选覆层后复制 · ↑↓←→ 微调 1px，Shift 10px');
        group('画面编辑',['.rto-edit-mode','.rto-guides','.rto-edit-undo']);
        const batchButton=document.createElement('button');batchButton.textContent='批量调整选中任务';batchButton.className='rto-batch-edit';
        batchButton.onclick=()=>{
            const selected=cards.filter(card=>root._rtoSelectedTasks.has(card.task));
            if(!selected.length){window.showToast?.('请先勾选要调整的任务','warning');return;}
            const rs=window._reelsState,reference=selected.find(card=>card.task===rs.tasks?.[rs.selectedIdx]) || selected[0];
            edit(reference);window.reelsInspectorSwitch?.('overlay');window.ReelsOverviewBatch?.setSelectedScope();
        };
        clipBox.appendChild(batchButton);
        group('编辑范围与拖动',['.rto-edit-target','details','.rto-media-part','.rto-edit-axis'],'点击画面选择元素 · 所有层均可编辑');
        const layoutAnchor=tools.querySelector('.rto-density').closest('label');
        for(const section of sections.children){
            const divider=document.createElement('span');divider.className='rto-tool-divider';tools.insertBefore(divider,layoutAnchor);
            for(const node of Array.from(section.querySelector('.rto-group-controls').children))tools.insertBefore(node,layoutAnchor);
        }
        const title=tools.querySelector('strong'),backButton=tools.querySelector('.rto-close');
        const toolScroll=document.createElement('div');toolScroll.className='rto-tool-scroll';
        for(const node of Array.from(tools.children)){
            if(node!==layoutAnchor && node!==title && node!==backButton)toolScroll.appendChild(node);
        }
        tools.replaceChildren(layoutAnchor,title,toolScroll,backButton);
        multiLayers.ontoggle=()=>{if(!multiLayers.open)return;const rect=multiLayers.querySelector('summary').getBoundingClientRect();Object.assign(multiLayers.querySelector('div').style,{position:'fixed',left:`${Math.min(rect.left,window.innerWidth-260)}px`,top:`${rect.bottom+6}px`});};
        const css=document.createElement('style');
        css.textContent=`#reels-task-overview .rto-heading{padding:8px 12px;gap:10px;flex-wrap:nowrap;overflow-x:auto;flex-shrink:0;font-size:12px}#reels-task-overview .rto-heading>*{flex-shrink:0}#reels-task-overview .rto-heading strong{flex:0 0 auto;white-space:nowrap}.rto-heading label{display:flex;align-items:center;gap:5px;white-space:nowrap}.rto-heading select{background:#181b23;color:#eee;border:1px solid #484d60;border-radius:4px;padding:4px 6px;font:inherit}.rto-heading summary{padding:5px 7px;background:#303443;border:1px solid #484d60;border-radius:4px;color:#cbc5f3;white-space:nowrap}.rto-tool-divider{width:1px;height:24px;background:#484352;margin:0 3px}#reels-task-overview .rto-play-all{background:#4c426f;border-color:#7967a6}`;
        root.appendChild(css);
        css.textContent += `#reels-task-overview .rto-progress input[type=range]{appearance:none;box-sizing:border-box;height:20px;min-height:20px;padding:0;margin:0;border:0;background:transparent;box-shadow:none;outline:none}#reels-task-overview .rto-progress input[type=range]::-webkit-slider-runnable-track{height:3px;border-radius:2px;background:#505467}#reels-task-overview .rto-progress input[type=range]::-webkit-slider-thumb{appearance:none;box-sizing:border-box;width:12px;height:12px;margin-top:-4.5px;border:2px solid #c4b5fd;border-radius:50%;background:#8b72ed;box-shadow:none}@container(max-width:140px){#reels-task-overview .rto-progress input[type=range]{flex:none}}`;
        css.textContent += `.rto-card{container-type:inline-size;position:relative}.rto-actions{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));align-items:center;gap:6px}.rto-actions small{display:none}.rto-actions button{white-space:nowrap;min-width:0}.rto-card-id{position:absolute;left:4px;top:4px;z-index:4;padding:1px 4px;border-radius:3px;background:rgba(0,0,0,.55);color:#eee;font:10px system-ui;pointer-events:none}@container(max-width:220px){.rto-card footer{padding:7px;gap:6px;min-height:0}.rto-name{font-size:12px}.rto-progress-title{display:none}.rto-progress{font-size:11px;min-width:0}.rto-progress input{min-width:0}.rto-actions{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px}.rto-actions small{display:none}.rto-actions button{padding:5px 0;font-size:15px;line-height:20px}.rto-action-label{display:none}}@container(max-width:140px){.rto-card footer{padding:5px;gap:5px}.rto-name{font-size:11px}.rto-progress{flex-direction:column;align-items:stretch;gap:3px}.rto-progress span{text-align:right;font-size:10px}.rto-actions{gap:4px}.rto-actions button{padding:3px 0;font-size:13px;line-height:18px}}`;
        css.textContent += `.rto-master-track{position:relative;flex:1;min-width:160px;padding-top:23px}.rto-master-track input.rto-master{display:block;width:100%;margin:0}.rto-master-track output{position:absolute;top:0;transform:translateX(-50%);padding:2px 5px;border-radius:4px;background:#39334f;color:#fff;font:12px system-ui;font-variant-numeric:tabular-nums;white-space:nowrap;pointer-events:none}.rto-master-track output[hidden]{display:none}.rto-master-ticks{position:relative;height:24px;margin-top:5px;color:#bcb8d6;font:11px system-ui;font-variant-numeric:tabular-nums}.rto-master-ticks span{position:absolute;top:0;transform:translateX(-50%)}.rto-master-ticks span:before{content:'';display:block;width:1px;height:4px;background:#726c87;margin:0 auto 3px}`;
        css.textContent+=`#reels-task-overview .rto-heading{overflow:visible}#reels-task-overview .rto-heading .rto-tool-scroll{display:flex;align-items:center;gap:10px;flex:1 1 0;min-width:0;overflow-x:auto;padding:2px 0}#reels-task-overview .rto-tool-scroll>*{flex-shrink:0}#reels-task-overview .rto-close{white-space:nowrap}`;
        css.textContent+=`#reels-task-overview > .rto-toolbar{font-size:11px;gap:7px;padding:7px 10px;line-height:1.35}#reels-task-overview > .rto-toolbar button{font-size:11px;line-height:1.3;padding:4px 8px;white-space:nowrap}#reels-task-overview > .rto-toolbar :is(select,input:not([type=range]):not([type=checkbox])){font-size:11px;line-height:1.3;min-height:25px;box-sizing:border-box}#reels-task-overview > .rto-toolbar input[type=checkbox]{width:13px;height:13px;vertical-align:middle}#reels-task-overview .rto-heading .rto-tool-scroll{gap:7px}#reels-task-overview .rto-master-track{padding-top:19px}#reels-task-overview .rto-master-track output{font-size:10px}#reels-task-overview .rto-master-ticks{height:18px;font-size:10px}`;
        css.textContent+=`#reels-task-overview .rto-tool-scroll::-webkit-scrollbar{height:5px}#reels-task-overview .rto-tool-scroll::-webkit-scrollbar-track{background:transparent}#reels-task-overview .rto-tool-scroll::-webkit-scrollbar-thumb{background:#5a5b69;border-radius:4px}#reels-task-overview .rto-tool-scroll::-webkit-scrollbar-thumb:hover{background:#85859a}`;
        css.textContent+=`#reels-task-overview .rto-actions{grid-template-columns:repeat(4,minmax(0,1fr));gap:5px}#reels-task-overview .rto-actions button{min-width:0;padding:5px 2px;font-size:13px;line-height:20px;overflow:hidden}#reels-task-overview .rto-actions .rto-action-label{display:none}`;

        const pagination = document.createElement('div');
        pagination.className = 'rto-toolbar';
        pagination.style.flexWrap='wrap';
        const refreshLinked=document.createElement('button');refreshLinked.className='rto-refresh-linked';refreshLinked.textContent='刷新所有关联素材';
        refreshLinked.title='重新读取各素材库与本批全部任务绑定的文件夹和文件，素材组使用文件夹最新内容，缺失的片段直接移除。';
        refreshLinked.onclick=async()=>{
            refreshLinked.disabled=true;refreshLinked.textContent='正在刷新关联素材…';
            try{await mediaPool?.refreshAllLinked();}catch(error){window.showToast?.(`刷新失败：${error.message}`,'warning');}
            finally{refreshLinked.disabled=false;refreshLinked.textContent='刷新所有关联素材';}
        };
        pagination.innerHTML = `<button class="rto-prev">上一页</button><span class="rto-page-info"></span><button class="rto-next">下一页</button><label>跳转 <select class="rto-page-select" aria-label="任务总览页码"></select></label><label>每页 <input class="rto-page-size" type="number" min="1" max="1000" step="1" value="${pageSize}" aria-label="每页任务数量" style="width:76px" title="输入 1–1000，回车或离开输入框生效，自动记住"> 个</label><button class="rto-select-page">全选本页</button><button class="rto-select-all">全选全部任务</button><button class="rto-select-none">取消选择</button><span class="rto-selection-count" role="status">已选 0 / ${tasks.length} 个任务</span>`;
        root.querySelector('.rto-body').before(pagination);
        pagination.querySelector('.rto-prev').onclick = () => renderPage(page - 1);
        pagination.querySelector('.rto-next').onclick = () => renderPage(page + 1);
        pagination.querySelector('.rto-page-select').onchange = e => renderPage(Number(e.target.value));
        const deleteButton=document.createElement('button');
        deleteButton.className='rto-delete-selected';deleteButton.textContent='删除选中任务';deleteButton.disabled=true;
        deleteButton.onclick=()=>deleteSelectedTasks();
        pagination.querySelector('.rto-selection-count').before(deleteButton);
        for(const [label,selectedOnly] of [['整批复制排版信息',false],['复制选中排版信息',true]]){
            const button=document.createElement('button');button.textContent=label;
            button.title='复制为文字说明，不含素材信息；粘贴到表格时每个任务占一个单元格，按任务顺序排列，包含其他页';
            button.onclick=()=>window.ReelsLayoutDescription?.openCopyDialog(cards.filter(card=>!selectedOnly || root._rtoSelectedTasks.has(card.task)).map(card=>card.task),{batch:true,playerFor:task=>cards.find(card=>card.task===task)?.player});
            pagination.appendChild(button);
        }
        for(const [label,selectedOnly] of [['⚡ 整批生成 Skill',false],['⚡ 选中生成 Skill',true]]){
            const button=document.createElement('button');button.textContent=label;
            button.title='将任务排版、字体配色与动态字幕导出为 AI 复刻渲染 Skill（自动剥离素材与具体台词，支持相同排版自动合并去重）';
            button.onclick=()=>window.ReelsLayoutDescription?.openCopyDialog(cards.filter(card=>!selectedOnly || root._rtoSelectedTasks.has(card.task)).map(card=>card.task),{batch:true,intent:'skill',playerFor:task=>cards.find(card=>card.task===task)?.player});
            pagination.appendChild(button);
        }
        const layerManager=document.createElement('button');layerManager.textContent='按层查找 / 统一修改勾选层的名称';
        layerManager.onclick=()=>window.ReelsLayoutDescription?.openLayerManager(cards.map(card=>card.task));
        const clearLayerFilter=document.createElement('button');clearLayerFilter.className='rto-layer-filter-clear';clearLayerFilter.textContent='清除层筛选';clearLayerFilter.hidden=true;
        clearLayerFilter.onclick=()=>window.ReelsTaskLayerTools?.filter(null);
        pagination.append(layerManager,clearLayerFilter);
        const invertButton=document.createElement('button');invertButton.className='rto-select-invert';invertButton.textContent='反选';invertButton.title='反选全部任务（包含其他页）';
        pagination.appendChild(refreshLinked);
        invertButton.onclick=()=>{
            for(const card of filteredCards()){if(root._rtoSelectedTasks.has(card.task))root._rtoSelectedTasks.delete(card.task);else root._rtoSelectedTasks.add(card.task);}
            syncSwapSelection();
        };
        pagination.querySelector('.rto-select-none').after(invertButton);
        const sizeInput=pagination.querySelector('.rto-page-size');
        sizeInput.onchange=()=>{
            const value=Number(sizeInput.value);
            if(!Number.isInteger(value) || value<1 || value>1000){sizeInput.value=pageSize;window.showToast?.('每页数量请输入 1–1000 的整数','warning');return;}
            if(value===pageSize)return;
            const first=page*pageSize;pageSize=value;
            try{localStorage.setItem('reels_overview_page_size',String(pageSize));}catch(_){}
            renderPage(Math.floor(first/pageSize));
        };
        sizeInput.onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();sizeInput.onchange();sizeInput.blur();}};
        pagination.querySelector('.rto-select-page').onclick=()=>{
            for(const card of pageCards())root._rtoSelectedTasks.add(card.task);
            syncSwapSelection();
        };
        pagination.querySelector('.rto-select-all').onclick=()=>{for(const card of filteredCards())root._rtoSelectedTasks.add(card.task);syncSwapSelection();};
        pagination.querySelector('.rto-select-none').onclick=()=>{root._rtoSelectedTasks.clear();syncSwapSelection();};
        const grid = root.querySelector('.rto-grid');
        const exportNames = window._reelsPreviewExportNames?.() || new Map();
        const nameSource = window._getReelsTaskNameSource?.();
        cards = tasks.map((task, id) => {
            const name = window._reelsTaskDisplayName?.(task, id, nameSource, exportNames.get(task))?.baseName || task.exportName || task.fileName || task.name || `任务 ${id + 1}`;
            const el = document.createElement('article'); el.className = 'rto-card';
            el.innerHTML = `<div class="rto-stage">加载合成预览…</div><footer><div class="rto-name" title="${escape(name)}">${escape(name)}</div><div class="rto-media-files" aria-label="各媒体层文件名"></div><div class="rto-progress-title">播放进度（可拖动）</div><div class="rto-progress"><input aria-label="${escape(name)} 播放进度" type="range" min="0" max="60" step="0.1" value="0"><span>0:00.0</span></div><div class="rto-actions"><small>等待加载</small><button class="rto-play">▶ 播放</button><button class="rto-swap" title="与另一任务交换素材，保留文案和布局" aria-label="${escape(name)} 互换素材">⇄<span class="rto-action-label"> 互换</span></button><button class="rto-edit" title="打开参数" aria-label="${escape(name)} 打开参数"><span aria-hidden="true">⚙</span><span class="rto-action-label"> 打开参数</span></button></div></footer><span class="rto-card-id">${id + 1}</span>`;
            const card = {id,task,name,el,time:0,duration:Math.max(Number(task.customDuration) || 0, ...(task.segments || []).map(segment => Number(segment.end) || 0)) || 60,stage:el.querySelector('.rto-stage'),slider:el.querySelector('input'),label:el.querySelector('.rto-progress span'),status:el.querySelector('small'),playButton:el.querySelector('.rto-play')};
            syncCardStageAspect(card);
            renderMediaNames(card);
            const copyLayout=document.createElement('button');copyLayout.className='rto-copy-layout';copyLayout.textContent='📋';copyLayout.setAttribute('aria-label','复制当前排版信息');
            copyLayout.title='复制此任务的布局、字体、颜色等格式样式，不含文字内容和素材信息';
            copyLayout.onclick=event=>{event.stopPropagation();window.ReelsLayoutDescription?.openCopyDialog([card.task],{playerFor:()=>card.player});};
            const exportSkill=document.createElement('button');exportSkill.className='rto-export-skill';exportSkill.textContent='⚡';exportSkill.setAttribute('aria-label','生成当前排版 Skill');
            exportSkill.title='将此任务的排版、字体配色与动态字幕一键导出为 AI Skill（不含文字内容与素材信息）';
            exportSkill.onclick=event=>{event.stopPropagation();window.ReelsLayoutDescription?.openCopyDialog([card.task],{intent:'skill',playerFor:()=>card.player});};
            el.querySelector('.rto-actions').append(copyLayout,exportSkill);
            setCardPlayLabel(card, '▶ 播放');
            const checkbox=document.createElement('label');checkbox.className='rom-task-select';
            checkbox.style.cssText='position:absolute;right:8px;top:8px;z-index:105;background:#171920dd;color:#fff;padding:5px;border-radius:5px;font-size:12px;';
            checkbox.innerHTML=`<input type="checkbox" aria-label="勾选任务 ${id+1}">选中任务`;
            checkbox.onclick=event=>event.stopPropagation();
            checkbox.onchange=()=>{if(checkbox.querySelector('input').checked)root._rtoSelectedTasks.add(task);else root._rtoSelectedTasks.delete(task);syncSwapSelection();};
            el.appendChild(checkbox);
            el.onclick = event => {
                if((event.metaKey || event.ctrlKey) && !event.target.closest('button,input,select')){
                    if(root._rtoSelectedTasks.has(task))root._rtoSelectedTasks.delete(task);else root._rtoSelectedTasks.add(task);syncSwapSelection();return;
                }
                selectCard(card);
            };
            el.oncontextmenu=event=>{event.preventDefault();event.stopPropagation();openSwapMenu(card,event.clientX,event.clientY);};
            el.querySelector('.rto-edit').onclick = () => edit(card);
            el.querySelector('.rto-swap').onclick = event => {
                event.stopPropagation();
                const selected=cards.filter(item=>root._rtoSelectedTasks.has(item.task));
                if(selected.length!==2){window.showToast?.('请先勾选两个任务，再点击互换','warning');return;}
                openCardSwap(selected[0],selected[1].task);
            };
            card.playButton.onclick = () => { if (allPlaying) { pauseAll(); return; } if (active === card || card.pendingPlayback) stop(); else startPlayback(card, Number(root.querySelector('.rto-speed').value)); };
            card.slider.oninput = () => { const time = card.slider.value; pauseAll(); stop(); seek(card, time); root.querySelector('.rto-mode').textContent = '单卡查看'; };
            card.stage.onmouseenter = () => {
                if (!root._romClickSwap && !root.classList.contains('rom-dragging') && !allPlaying && root.querySelector('.rto-hover').checked) startPlayback(card, Number(root.querySelector('.rto-hover-speed').value), true);
            };
            card.stage.onmouseleave = () => { if (active === card && card.hoverPlayback) { stop(); seek(card,card.time); } };
            // 截图卡不能直接拖：按下鼠标就插队优先加载，不必先点一次再等。
            card.stage.addEventListener('pointerdown', () => {
                if (!card.frame && root.querySelector('.rto-edit-mode').checked) { load(card, true); card.status.textContent = '加载中，稍后即可拖动'; }
            });
            const cached = posterCache.get(task);
            if (cached && cached.sig === taskSignature(task)) {
                card.time = card.requestedTime = cached.time || 0;
                showPoster(card, cached.src, NaN); // NaN：仍在后台加载成可编辑状态，截图只用来遮住等待
                card.status.textContent = '预览图 · 后台加载中';
            }
            return card;
        });
        window.ReelsTaskLayerTools={
            taskLabel:task=>{const card=cards.find(card=>card.task===task);return card?`任务 ${card.id+1} · ${card.name}`:'';},
            getFilterCriteria:()=>layerTaskFilter && layerFilterCriteria ? {...layerFilterCriteria, ids:[...layerFilterCriteria.ids]} : null,
            filter:(tasks,criteria)=>{
                layerTaskFilter=tasks?new Set(tasks):null;
                layerFilterCriteria=tasks && criteria ? {ids:[...criteria.ids],mode:criteria.mode} : null;
                if(layerTaskFilter)for(const task of root._rtoSelectedTasks)if(!layerTaskFilter.has(task))root._rtoSelectedTasks.delete(task);
                renderPage(0);syncSwapSelection();
            },
            select:tasks=>{root._rtoSelectedTasks.clear();for(const task of tasks)root._rtoSelectedTasks.add(task);syncSwapSelection();},
            locate:(task,key)=>{
                const card=cards.find(card=>card.task===task);if(!card)return;
                if(layerTaskFilter && !layerTaskFilter.has(task)){layerTaskFilter=null;layerFilterCriteria=null;}
                renderPage(Math.floor(filteredCards().indexOf(card)/pageSize));edit(card);card.el.scrollIntoView({block:'center'});
                const entry=window.ReelsLayoutDescription.entries(task).find(entry=>entry.key===key);
                if(entry?.ov){window._reelsState.overlayPanel?.selectOverlay?.(entry.ov);window.ReelsOverviewEdit?.selectOverlay?.(card,entry.ov.id);}
                else card.status.textContent=`已定位：${entry?.label || '任务'}`;
            },
            changed:tasks=>{
                refreshChangedTasks(tasks);refreshNames();
                const labels=new Map();
                for(const card of cards)for(const entry of window.ReelsLayoutDescription.entries(card.task)){
                    if(!entry.ov)continue;
                    const index=(card.task.overlays || []).findIndex(ov=>ov.id===entry.ov.id);
                    const key=entry.ov.slotKey?`slot:${entry.ov.slotKey}`:`layer-index:${index}`;
                    if(!labels.has(key))labels.set(key,entry.label);
                }
                for(const option of root.querySelector('.rto-edit-target').options)if(labels.has(option.value))option.textContent=`锁定：${labels.get(option.value)}`;
                for(const input of root.querySelectorAll('.rto-layer-check'))if(labels.has(input.value))input.parentElement.replaceChildren(input,document.createTextNode(labels.get(input.value)));
            },
        };
        mediaPool = window.ReelsOverviewMediaPool?.mount(root, cards, {
            beforeWrite: () => { pauseAll(); stop(); },
            selected: () => cards.find(card => card.task === window._reelsState.tasks[window._reelsState.selectedIdx]),
        });
        observer = new IntersectionObserver(entries => {
            // 先更新整批可见性，避免边加载新卡边误回收仍在屏幕上的卡片。
            entries.forEach(entry => { const card=cards.find(c=>c.el===entry.target); if(card)card.visible=entry.isIntersecting; });
            entries.forEach(entry => {
            const card=cards.find(c=>c.el===entry.target);if(!card)return;
            clearTimeout(card.releaseTimer);
            card.visible=entry.isIntersecting;
            if(card.visible)load(card);
            card.player?.setSuspended?.(!card.visible && !card.prewarm && !card.loadPriority);
            if(allPlaying){if(card.visible)playGroupCard(card);else card.player?.pause();}
            if (!card.visible) {
                if (active === card) stop();
                card.player?.pause();
                card.releaseTimer = setTimeout(() => {
                    if (!card.visible && !card.dragging) releaseCard(card);
                }, 500);
            }
            });
            // 上一批因没有空位而等待的卡片也要重试，不能只处理发生交集变化的卡片。
            cards.filter(card => card.visible && !card.frame).forEach(card => load(card));
        }, {root:grid,rootMargin:'0px'});
        renderPage(0);
        reportResources('open');
        resourceTimer = setInterval(() => reportResources('sample'), 5000);
        root.querySelector('.rto-play-all').disabled = false;
        cards.forEach(card => card.playButton.disabled = false);
        const master = root.querySelector('.rto-master'), seconds = root.querySelector('.rto-seconds');
        const sync = value => { pauseAll(); stop(); const t = Math.max(0,Number(value)||0); master.value = t; seconds.value = t; updateMasterTime(); cards.forEach(c => seek(c,t)); root.querySelector('.rto-mode').textContent = '全部对齐'; };
        master.oninput = () => sync(master.value); seconds.oninput = () => sync(seconds.value);
        master.onpointermove = event => {
            const rect = master.getBoundingClientRect();
            const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left - 8) / Math.max(1, rect.width - 16)));
            const label = root.querySelector('.rto-master-hover');
            label.textContent = fmt(Math.round(ratio * Number(master.max) * 10) / 10);
            label.style.left = `clamp(28px, ${ratio * 100}%, calc(100% - 28px))`;
            label.hidden = false; root.querySelector('.rto-master-current').hidden = true;
        };
        master.onpointerleave = () => { root.querySelector('.rto-master-hover').hidden = true; root.querySelector('.rto-master-current').hidden = false; };
        updateMasterTime();
        root.querySelector('.rto-guides').onchange = e => root.classList.toggle('rto-show-guides',e.target.checked);
        window.addEventListener('reels-preview-edit-settings',syncOverviewSettings);
        root.addEventListener('change',event=>{
            for(const [key,selector] of Object.entries(settingsControls)){
                if(event.target.matches(selector)){
                    const input=event.target;
                    window.ReelsOverviewEdit.configure({[key]:input.type==='checkbox'?input.checked:['speed','hoverSpeed'].includes(key)?Number(input.value):input.value});
                    break;
                }
            }
        });
        syncOverviewSettings();
        root.querySelector('.rto-layout-mode').onchange = event => {
            pauseAll(); stop();
            const enabled = event.target.checked;
            for (const card of cards) {
                window.ReelsOverviewEdit?.unmount(card);
                if (enabled) window.ReelsLayoutEditor?.toggleInlineLayout(card.stage, card.task,
                    () => refreshChangedTasks([card.task]), null, { hideTools: true, quiet: true });
                else {
                    window.ReelsLayoutEditor?.stopInlineLayout(card.stage);
                    if (root.querySelector('.rto-edit-mode').checked) enableEditing(card);
                }
            }
            root.querySelector('.rto-mode').textContent = enabled ? '布局编辑：拖动各格蓝色分割线，松手保存；关闭总开关退出' : '全部对齐';
        };
        root.querySelector('.rto-edit-mode').onchange = e => {
            pauseAll(); stop();
            root.querySelector('.rto-play-all').disabled = false;
            cards.forEach(card => { card.playButton.disabled = false; if(e.target.checked) enableEditing(card); else window.ReelsOverviewEdit.unmount(card); });
        };
        root.querySelector('.rto-edit-target').onchange = () => {
            if (!root.querySelector('.rto-edit-mode').checked) return;
            cards.forEach(card => { window.ReelsOverviewEdit.unmount(card); enableEditing(card); });
        };
        root.querySelector('.rto-edit-undo').onclick = () => {
            if(root._rtoUndoOrder?.at(-1)==='swap'){dropUndoOrder('swap');root._rtoSwapUndo?.pop()?.();return;}
            dropUndoOrder('edit');
            // 被回收播放器的卡片只剩截图，必须重建；refreshChangedTasks 同时处理两种情况。
            window.ReelsOverviewEdit.undo({select:card=>selectCard(card),refresh:tasks=>{const task=window._reelsState.tasks[window._reelsState.selectedIdx];refreshChangedTasks(tasks || (task?[task]:[]));}});
            cards.forEach(card => { window.ReelsOverviewEdit.unmount(card); if(root.querySelector('.rto-edit-mode').checked) enableEditing(card); });
        };
        const clipOf = kind => () => window.ReelsOverviewEdit.copyLayer?.(kind);
        const bindClip = (sel, fn) => { const el = root.querySelector(sel); if (el) el.onclick = fn; };
        bindClip('.rto-copy-style', clipOf('style'));
        bindClip('.rto-copy-pos', clipOf('position'));
        bindClip('.rto-copy-all', clipOf('all'));
        bindClip('.rto-paste', () => {
            const rs = window._reelsState, scope = root.querySelector('.rto-paste-scope')?.value || 'group';
            const cur = rs.tasks[rs.selectedIdx];
            let targets = scope === 'all' ? rs.tasks : scope === 'card' ? [cur] : (rs.overlayProxy?.getTaskGroupTasks?.() || []);
            if (!targets?.length) targets = [cur];
            targets = targets.filter(Boolean);
            if (targets.length > 10 && !confirm(`将粘贴到 ${targets.length} 个任务，确定吗？`)) return;
            const changed = window.ReelsOverviewEdit.pasteLayer?.(targets) || [];
            refreshChangedTasks(changed);
        });
        root.querySelector('.rto-play-all').onclick = () => allPlaying ? pauseAll() : playAll();
        root.querySelector('.rto-play-all').title = `同时播放当前可见的前 ${MAX_LIVE_PLAYERS} 个任务，其余保留预览图，点击可单独播放`;
        root.querySelector('.rto-muted').onchange = e => cards.forEach(card => card.player?.setMuted(e.target.checked));
        root.querySelector('.rto-hover').onchange = () => { stop(); cards.forEach(c => seek(c,c.time)); };
        for (const selector of ['.rto-speed', '.rto-hover-speed']) {
            root.querySelector(selector).onchange = e => {
                if (allPlaying && selector === '.rto-speed') {
                    allTime = groupTime(); allStarted = performance.now(); allSpeed = Number(e.target.value);
                    cards.forEach(card => { if (card.groupPlayback && card.visible!==false && card.player && allTime < card.player.getDuration()) card.player.play(allSpeed); });
                }
                if (active && active.speedControl === selector) {
                    active.player.play(Number(e.target.value));
                    active.status.textContent = `${e.target.value} 倍速播放`;
                }
            };
        }
        root.querySelector('.rto-density').onchange = e => grid.style.setProperty('--columns', e.target.value);
        root.querySelector('.rto-close').onclick = close;
        root.querySelector('.rto-hide').onclick = () => { restoreInspector(); root.querySelector('.rto-drawer').hidden = true; };
        const onParameterChange = event => {
            if (!inspectorHome?.node.contains(event.target)) return;
            const card = cards.find(card => card.task === window._reelsState.tasks[window._reelsState.selectedIdx]);
            if (!card) return;
            clearTimeout(refreshTimer);
            refreshTimer = setTimeout(() => refreshCards(card), 80);
        };
        root.addEventListener('input', onParameterChange);
        root.addEventListener('change', onParameterChange);
        root.addEventListener('click', onParameterChange);
        window.addEventListener('reels-task-media-changed',onMediaChanged);
        window.addEventListener('reels-resolution-changed', onResolutionChanged);
        window.addEventListener('reels-media-batch-start',onMediaBatchStart);window.addEventListener('reels-media-batch-end',onMediaBatchEnd);
        window.addEventListener('reels-overlay-selection-changed',onOverlaySelectionChanged);
        root._rtoUndoOrder = [];
        window.addEventListener('reels-overview-undo-push', onUndoPush);
        // 捕获阶段拦截：必须早于 Reels 主界面 document 上的全局撤销监听。
        window.addEventListener('keydown', onKey, true);
        timer = setInterval(() => {
            if (!root) return;
            refreshNames();
            refreshCards(cards.find(card=>card.task===window._reelsState.tasks[window._reelsState.selectedIdx]));
            let max = 0;
            for (const card of cards) {
                if (card.player) {
                    const duration = card.player.getDuration() || card.duration;
                    if (duration !== card.duration) { card.duration = duration; if (!allPlaying && active !== card) seek(card, card.requestedTime ?? card.time); }
                    card.slider.max = card.duration;
                }
                max = Math.max(max, card.duration);
            }
            master.max = max;
            updateMasterTime();
        }, 1000);
    };
})();
