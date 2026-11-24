(function (root, factory) {
    const api = factory(typeof module === 'object' && module.exports ? require('./auto-edit-cut-coverage') : root.AutoEditCutCoverage);
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.AutoEditBatchIssueReview = api;
})(typeof window === 'object' ? window : globalThis, function (coverage) {
    const labels = {difference:'段内少量词差异', assignment:'缺失文案／上下段归属', missing:'缺失较多文案',
        cut:'切点问题', duplicate:'重复片段', take:'重复朗读', recognition:'识别异常', unmatched:'无法定位文案', other:'其他待审核'};
    const taskIds = new WeakMap();
    let nextTaskId = 0, session = null, refreshTimer = null;
    const taskId = task => {
        if (!taskIds.has(task)) taskIds.set(task, ++nextTaskId);
        return taskIds.get(task);
    };
    const sourceIndex = (segment, index) => Number(segment.source_index || segment.index) || index + 1;
    // 原列表输入框以毫秒显示，保存时的取整不能使刚完成的试听失效。
    const signature = segment => JSON.stringify([segment.script, segment.recognized_text, Number(Number(segment.start).toFixed(3)), Number(Number(segment.end).toFixed(3)),
        segment.word_timeline, segment.speed || 1]);
    const active = segment => segment.enabled !== false && !segment.is_hook;
    function neighbours(segments, block) {
        const line = Number(block.startLine) + 1;
        const previous = segments.filter(segment => Number(segment.script_end_line) > 0 && Number(segment.script_end_line) < line)
            .sort((a,b) => Number(b.script_end_line) - Number(a.script_end_line))[0];
        const next = segments.filter(segment => Number(segment.script_start_line) >= line)
            .sort((a,b) => Number(a.script_start_line) - Number(b.script_start_line))[0];
        return [Number(previous?.source_index) || Number(block.previous_source_index), Number(next?.source_index) || Number(block.next_source_index)].filter(Boolean);
    }
    // 只读取快照；问题汇总本身不恢复文案、不重算切点，也不落盘。
    function collect(snapshots) {
        const issues = [];
        for (const {task, result} of snapshots) {
            const prefix = taskId(task);
            const firstIssue = issues.length;
            if (!result) {
                if (task.status === 'error') issues.push({key:`${prefix}:task`,task,types:['recognition'],kind:'task',text:task.script || '',reason:task.message || '尚无可审核的分析结果'});
                continue;
            }
            const segments = result.segments || [], language = result.language || 'en';
            const missing = (result.missing_blocks || []).filter(block => !block.review_assignment);
            const boundary = (result.boundary_overlaps || []).filter(block => block.confirmed !== true);
            const contextSources = new Set(missing.flatMap(block => neighbours(segments, block)));
            boundary.forEach(block => [block.previous_source_index || Number(block.previous)+1,
                block.next_source_index || Number(block.next)+1].forEach(index => contextSources.add(Number(index))));
            const containment = new Set((coverage?.containedDuplicates(segments, language) || []).flatMap(pair => [pair.shortIndex,pair.longIndex]));
            const duplicateIndexes = new Set();
            const groups = new Map();
            const explicitGroups = new Map();
            segments.forEach((segment,index) => {
                if (!active(segment)) return;
                if (segment.duplicate_group_id) {
                    if (!explicitGroups.has(segment.duplicate_group_id)) explicitGroups.set(segment.duplicate_group_id,[]);
                    explicitGroups.get(segment.duplicate_group_id).push(index);
                }
                const key = coverage?.normalize(segment.script || '') || '';
                if (key) { if (!groups.has(key)) groups.set(key,[]); groups.get(key).push(index); }
                if (Number(segment.duplicate_of_source_index) > 0) {
                    const rootIndex = segments.findIndex((item, idx) => sourceIndex(item, idx) === Number(segment.duplicate_of_source_index));
                    if (rootIndex >= 0 && active(segments[rootIndex])) { duplicateIndexes.add(index); duplicateIndexes.add(rootIndex); }
                }
            });
            groups.forEach(indexes => { if (indexes.length > 1) indexes.forEach(index => duplicateIndexes.add(index)); });
            explicitGroups.forEach(indexes => { if (indexes.length > 1) indexes.forEach(index => duplicateIndexes.add(index)); });
            segments.forEach((segment,index) => {
                if (!active(segment)) return;
                const acknowledged = segment.review_acknowledged === true;
                const ordinaryDuplicate = duplicateIndexes.has(index) && !containment.has(index);
                if (acknowledged && !ordinaryDuplicate) return;
                const types = [], reason = String(segment.issue_reason || segment.ambiguity || '');
                const validation = coverage?.validate({script:segment.script,recognized:segment.recognized_text,
                    words:segment.word_timeline,start:segment.start,end:segment.end,language});
                const inspected = coverage?.inspect({script:segment.script,words:segment.word_timeline,start:segment.start,end:segment.end,language});
                if (ordinaryDuplicate || containment.has(index)) types.push('duplicate');
                if (!acknowledged) {
                    if (/转录失败|识别失败|未返回有效文字|未获得识别|空结果/.test(`${reason} ${segment.recognized_text || ''}`)
                        || !validation?.timingAvailable) types.push('recognition');
                    if (/重复朗读/.test(reason) || (!segment.manually_modified && (coverage?.takeOccurrences(segment.script, segment.word_timeline, language) || []).length > 1)) types.push('take');
                    if (!String(segment.script || '').trim()) types.push('unmatched');
                    else if (segment.ambiguity || /未能可靠定位|多处匹配|归属记录与保存的文案不一致/.test(reason)) types.push('unmatched');
                    if (segment.needs_replacement || segment.status === 'error') types.push('other');
                    if (validation?.partial || inspected?.removed?.length) types.push('cut');
                    if (contextSources.has(sourceIndex(segment,index)) && (segment.status !== 'ready' || !validation?.passed)) types.push('assignment');
                    if (!types.length && validation && !validation.equal) {
                        const target = coverage.tokens(segment.script,language), actual = coverage.tokens(validation.text,language);
                        // 只允许段内少量差异；首尾差异、截词及任何跨段问题都不能批量确认。
                        const smallInterior = validation.timingAvailable && target.length >= 3 && actual.length >= 3
                            && target[0] === actual[0] && target.at(-1) === actual.at(-1)
                            && validation.missing.length <= 2 && validation.extra.length <= 2;
                        types.push(smallInterior ? 'difference' : 'other');
                    }
                    if (!types.length && segment.status !== 'ready') types.push('other');
                }
                if (!types.length) return;
                issues.push({key:`${prefix}:segment:${segment.segment_id || segment.source || index}`,task,kind:'segment',
                    types,bulkEligible:types.length === 1 && types[0] === 'difference',segment,index,
                    source:segment.source || '',sourceIndex:sourceIndex(segment,index),text:segment.script || '',
                    recognized:segment.recognized_text || '',reason,signature:signature(segment)});
            });
            missing.forEach((block,index) => {
                const words = coverage?.tokens(block.text,language) || [];
                issues.push({key:`${prefix}:missing:${block.startLine}:${block.endLine}:${block.text}`,task,kind:'missing',
                    types:[words.length <= 8 && Number(block.endLine ?? block.startLine)-Number(block.startLine)<2 ? 'assignment' : 'missing'],block,index,text:block.text || '',reason:block.issue_reason || '',
                    startLine:Number(block.startLine)+1,endLine:Number(block.endLine ?? block.startLine)+1,
                    contextSources:neighbours(segments,block),source:''});
            });
            boundary.forEach((block,index) => issues.push({key:`${prefix}:boundary:${block.id || index}`,task,kind:'boundary',types:['assignment','duplicate'],
                block,text:block.text || '',source:'',contextSources:[Number(block.previous_source_index || Number(block.previous)+1),Number(block.next_source_index || Number(block.next)+1)]}));
            if (issues.length === firstIssue && (task.status === 'error' || task.reelsTransferError)) {
                issues.push({key:`${prefix}:task`,task,kind:'task',types:['other'],text:task.script || '',reason:task.reelsTransferError || task.message || '任务处理失败'});
            }
        }
        return issues;
    }
    function copyText(items) {
        const cell = value => `"${String(value || '').replace(/"/g,'""')}"`;
        return items.map(item => [item.task.outputName || item.task.name,
            item.source ? item.source.split(/[/\\]/).pop() : item.kind === 'missing' ? `第 ${item.startLine}–${item.endLine} 行` : '任务问题',
            item.text].map(cell).join('\t')).join('\n');
    }
    function filterIssues(items,type,search) {
        const query = String(search || '').trim().toLocaleLowerCase();
        return items.filter(item => (!type || item.types.includes(type)) && (!query ||
            `${item.task.name} ${item.task.outputName || ''} ${item.source || ''} ${item.text} ${item.reason || ''}`.toLocaleLowerCase().includes(query)));
    }
    function heardEligible(item, heard) { return item.bulkEligible && heard.get(item.key) === item.signature; }
    function element(tag,className,text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
    }
    function button(text,action) {
        const node = element('button','btn btn-secondary',text); node.type='button'; node.onclick=action; return node;
    }
    function rowFor(item,s) {
        if (item.kind !== 'segment' || item.task !== s.bridge.currentTask()) return null;
        return Array.from(s.content.querySelectorAll('.autoedit-review-row')).find(row =>
            (item.source && decodeURIComponent(row.dataset.source || '') === item.source)
            || (!item.source && Number(row.dataset.reviewIndex) === item.index));
    }
    function focus(item,s) {
        s.content.querySelectorAll('.ae-aggregate-focus,.ae-aggregate-context').forEach(node => node.classList.remove('ae-aggregate-focus','ae-aggregate-context'));
        let target = rowFor(item,s);
        const rows = Array.from(s.content.querySelectorAll('.autoedit-review-row'));
        let context = [];
        if (target) { const index = rows.indexOf(target); context = rows.slice(Math.max(0,index-1),index+2); }
        else if (item.kind === 'missing') {
            target = Array.from(s.content.querySelectorAll('.autoedit-missing-placeholder')).find(node =>
                Number(node.dataset.scriptStartLine) === item.startLine && decodeURIComponent(node.dataset.missingText || '') === item.text);
            const indexes = target ? [Number(target.dataset.previousSourceIndex),Number(target.dataset.nextSourceIndex)] : item.contextSources;
            context = rows.filter(row => indexes?.includes(Number(row.dataset.sourceIndex)));
        } else if (item.kind === 'boundary') {
            target = Array.from(s.content.querySelectorAll('.autoedit-boundary-overlap')).find(node =>
                decodeURIComponent(node.dataset.boundaryId || '') === (item.block.id || `boundary-${item.contextSources[0]}-${item.contextSources[1]}`));
            context = rows.filter(row => item.contextSources.includes(Number(row.dataset.sourceIndex)));
        }
        const pendingTextareas = [];
        context.forEach(row => {
            const hasRisk = row === target || ['warning', 'criticalMatch', 'duplicate', 'unmatched'].some(key => row.dataset[key] === 'true');
            if (!hasRisk) return;
            row.classList.add('ae-aggregate-context');
            const textarea = row.querySelector('.ae-review-script');
            if (textarea) { textarea.style.height='auto'; pendingTextareas.push(textarea); }
            const details = row.querySelector('.ae-review-details');
            if (details) {
                details.style.display='grid';
                if (typeof s.bridge.hydrateRowDetails === 'function') s.bridge.hydrateRowDetails(row);
            }
            const toggle = row.querySelector('[onclick="toggleAutoEditReviewDetails(this)"]'); if (toggle && details) toggle.textContent = '收起详情';
        });
        const measuredHeights = pendingTextareas.map(textarea => Math.max(64, textarea.scrollHeight));
        pendingTextareas.forEach((textarea, idx) => { textarea.style.height = `${measuredHeights[idx]}px`; });
        target?.classList.add('ae-aggregate-focus');
        (context[0] || target)?.scrollIntoView({block:'start',behavior:'smooth'});
    }
    function selectItem(item,s,fromPlayback=false,skipFocus=false) {
        if (s.busy && !fromPlayback) return false;
        if (!fromPlayback) stopPlayback(s);
        if (!item.task.result) { s.bridge.toast('此任务尚无可审核结果，请先完成分析或重试识别','info'); return false; }
        if (s.bridge.currentTask() !== item.task && !s.bridge.activate(item.task)) return false;
        s.activeKey=item.key;
        s.activeIndex=filterIssues(s.items,s.type.value,s.search.value).findIndex(entry=>entry.key===item.key);
        s.operation=null;s.operationStatus.textContent='';s.locate.style.display='none';
        s.content.querySelectorAll('.ae-aggregate-changed').forEach(node=>node.classList.remove('ae-aggregate-changed'));
        s.content.querySelectorAll('.ae-aggregate-change-label').forEach(node=>node.remove());
        if (!skipFocus) focus(item,s);
        if (!s.busy) render(s);
        return true;
    }
    function captureView(anchor) {
        const s=session;
        if (!s || !s.overlay.isConnected) return null;
        const rows=Array.from(s.content.querySelectorAll('.autoedit-review-row'));
        return {task:s.bridge.currentTask(),top:s.content.scrollTop,left:s.content.scrollLeft,listTop:s.list.scrollTop,
            anchor:anchor ? {startLine:anchor.dataset.scriptStartLine,endLine:anchor.dataset.scriptEndLine,
                offset:anchor.getBoundingClientRect().top-s.content.getBoundingClientRect().top} : null,
            rows:rows.map(row=>({source:row.dataset.source,index:row.dataset.reviewIndex,
                details:row.querySelector('.ae-review-details')?.style.display,
                height:row.querySelector('.ae-review-script')?.style.height,
                focused:row.classList.contains('ae-aggregate-focus'),context:row.classList.contains('ae-aggregate-context')}))};
    }
    function restoreView(view,changedRows=[],message='') {
        const s=session;
        if (!s || !view || view.task!==s.bridge.currentTask()) return;
        const rows=Array.from(s.content.querySelectorAll('.autoedit-review-row'));
        const changed=changedRows.map(row=>({source:row.dataset.source,index:row.dataset.reviewIndex,sourceIndex:row.dataset.sourceIndex}));
        const matches=(row,entry)=>entry.source ? row.dataset.source===entry.source : row.dataset.reviewIndex===entry.index;
        const pendingTextareas=[];
        rows.forEach(row=>{
            const saved=view.rows.find(entry=>matches(row,entry));
            const details=row.querySelector('.ae-review-details'),textarea=row.querySelector('.ae-review-script');
            if(saved) {
                if(details && saved.details != null) details.style.display=saved.details;
                if(textarea && saved.height) textarea.style.height=saved.height;
                if(saved.focused) row.classList.add('ae-aggregate-focus');
                if(saved.context) row.classList.add('ae-aggregate-context');
            }
            if(changed.some(entry=>matches(row,entry))) {
                row.classList.add('ae-aggregate-changed');
                if(details) details.style.display='grid';
                if(textarea) {textarea.style.height='auto';pendingTextareas.push(textarea);}
                const badge=element('div','ae-aggregate-change-label','本次归属改动的片段 · 请核对文案和入点 / 出点');
                row.prepend(badge);
            }
            if(details && details.style.display !== 'none' && typeof s.bridge.hydrateRowDetails === 'function') {
                s.bridge.hydrateRowDetails(row);
            }
            const toggle=row.querySelector('[onclick="toggleAutoEditReviewDetails(this)"]');
            if(toggle && details) toggle.textContent=details.style.display === 'none' ? '展开详情' : '收起详情';
        });
        const measuredHeights=pendingTextareas.map(textarea=>Math.max(64,textarea.scrollHeight));
        pendingTextareas.forEach((textarea,idx)=>{textarea.style.height=`${measuredHeights[idx]}px`;});
        const oldBehavior=s.content.style.scrollBehavior;s.content.style.scrollBehavior='auto';
        s.content.scrollTop=view.top;s.content.scrollLeft=view.left;
        if(view.anchor) {
            const anchor=Array.from(s.content.querySelectorAll('.autoedit-missing-placeholder')).find(node=>
                node.dataset.scriptStartLine===view.anchor.startLine && node.dataset.scriptEndLine===view.anchor.endLine);
            if(anchor) s.content.scrollTop+=anchor.getBoundingClientRect().top-s.content.getBoundingClientRect().top-view.anchor.offset;
        }
        s.content.style.scrollBehavior=oldBehavior;
        if(message) {
            s.operation={item:s.items.find(item=>item.key===s.activeKey) || s.operation?.item,changed,message};
            s.operationStatus.textContent=message;
            s.locate.style.display=changed.length ? '' : 'none';
        }
        refresh(s);s.list.scrollTop=view.listTop;
    }
    function collectSessionIssues(s) {
        if (typeof s.bridge.tasks === 'function' && typeof s.bridge.snapshotForTask === 'function') {
            const tasks = s.bridge.tasks() || [];
            const activeTask = s.bridge.currentTask();
            const allIssues = [];
            for (const task of tasks) {
                const cached = s.taskCache.get(task);
                if (task !== activeTask && cached
                    && cached.resultRef === task.result
                    && cached.reviewRef === task.reviewSegments
                    && cached.script === task.script
                    && cached.status === task.status
                    && cached.message === task.message
                    && cached.reelsErr === task.reelsTransferError) {
                    allIssues.push(...cached.issues);
                    continue;
                }
                const issues = collect([s.bridge.snapshotForTask(task)]);
                s.taskCache.set(task, {
                    resultRef: task.result,
                    reviewRef: task.reviewSegments,
                    script: task.script,
                    status: task.status,
                    message: task.message,
                    reelsErr: task.reelsTransferError,
                    issues,
                });
                allIssues.push(...issues);
            }
            return allIssues;
        }
        return collect(s.bridge.snapshots());
    }
    function refresh(s) {
        if (session !== s || !s.overlay.isConnected || s.busy) return;
        s.items=collectSessionIssues(s);
        const keys=new Set(s.items.map(item=>item.key));
        s.selected.forEach(key=>{if(!keys.has(key)) s.selected.delete(key);});
        render(s);
    }
    function scheduleRefresh() {
        if (!session) return;
        clearTimeout(refreshTimer);
        const s=session;
        refreshTimer=setTimeout(()=>refresh(s),100);
    }
    function updateToolbarState(s, visibleOverride=null) {
        const visible=visibleOverride || filterIssues(s.items,s.type.value,s.search.value);
        const selected=s.items.filter(item=>s.selected.has(item.key));
        const confirmable=selected.filter(item=>heardEligible(item,s.heard));
        s.summary.textContent=`${s.items.length} 项待处理 · ${new Set(s.items.map(item=>item.task)).size} 个任务 · 已勾选 ${selected.length} 项`;
        s.confirm.textContent=`确认已试听的段内差异（${confirmable.length}）`;
        s.confirm.disabled=s.busy || !confirmable.length;
        s.listen.disabled=s.busy || !selected.some(item=>item.kind==='segment');
        s.copy.disabled=s.busy || !selected.length; s.copyGeneration.disabled=s.busy || !selected.length;
        if (s.sendHedraImmediate) s.sendHedraImmediate.disabled=s.busy || !selected.length;
        if (s.sendHedraMark) s.sendHedraMark.disabled=s.busy || !selected.length;
        s.next.disabled=s.busy || !visible.length;
        return visible;
    }
    function render(s) {
        const listTop=s.list.scrollTop;
        const visible=updateToolbarState(s);
        s.list.replaceChildren();
        const resolved=s.operation?.item;
        if(resolved && !s.items.some(item=>item.key===resolved.key)) {
            const card=element('div','ae-aggregate-item is-active ae-aggregate-resolved');
            card.append(element('div','','已处理 · 留在当前处核对'),element('div','',s.operation.message),element('div','',resolved.text));
            s.list.append(card);
        }
        let lastTask=null;
        visible.forEach(item=>{
            if(item.task!==lastTask) { s.list.append(element('h4','ae-aggregate-task',item.task.outputName || item.task.name));lastTask=item.task; }
            const card=element('div',`ae-aggregate-item${item.key===s.activeKey?' is-active':''}`);
            const choose=element('input');choose.type='checkbox';choose.checked=s.selected.has(item.key);
            choose.setAttribute('aria-label',`勾选 ${item.task.name} ${item.text}`);
            choose.onchange=()=>{choose.checked?s.selected.add(item.key):s.selected.delete(item.key);updateToolbarState(s);};
            const open=button(`${item.types.map(type=>labels[type]).join(' · ')}\n${item.source?item.source.split(/[/\\]/).pop():item.kind==='missing'?`第 ${item.startLine}–${item.endLine} 行`:''}\n${item.text || item.reason || '待审核'}`,()=>selectItem(item,s));
            open.className='ae-aggregate-open';
            card.append(choose,open);
            if(item.bulkEligible) {
                const label=element('label','ae-aggregate-heard');const heard=element('input');heard.type='checkbox';heard.checked=heardEligible(item,s.heard);
                heard.onchange=()=>{heard.checked?s.heard.set(item.key,item.signature):s.heard.delete(item.key);updateToolbarState(s);};
                label.append(heard,document.createTextNode('已试听核对'));card.append(label);
            }
            s.list.append(card);
        });
        if(!visible.length) s.list.append(element('p','hint',s.items.length?'当前筛选没有问题':'全部审核问题已处理，可以关闭后批量选择已通过任务。'));
        s.list.scrollTop=listTop;
    }
    function stopPlayback(s) {
        ++s.playToken;
        const preview=s.preview;s.preview=null;
        preview?.close();
        s.playStatus.textContent='';
    }
    function listenSelected(s) {
        stopPlayback(s);
        const queue=s.items.filter(item=>s.selected.has(item.key) && item.kind==='segment');
        const token=s.playToken;
        let index=0;
        const next=()=>{
            if(session!==s || token!==s.playToken) return;
            if(index>=queue.length) {s.playStatus.textContent='所选片段试听结束；请核对后确认';render(s);return;}
            const item=queue[index++];
            if(!selectItem(item,s,true)) return stopPlayback(s);
            const row=rowFor(item,s);if(!row) return stopPlayback(s);
            const preview=s.bridge.play(row);if(!preview?.video) return stopPlayback(s);
            s.preview=preview;
            s.playStatus.textContent=`连续试听 ${index}/${queue.length} · ${item.task.name}`;
            let finished=false;
            const complete=()=>{
                if(finished || token!==s.playToken) return;
                finished=true;
                if(item.bulkEligible) s.heard.set(item.key,item.signature);
                s.preview=null;preview.close();
                setTimeout(next,150);
            };
            preview.video.addEventListener('ended',complete,{once:true});
            preview.video.addEventListener('autoedit-preview-complete',complete,{once:true});
            preview.video.addEventListener('error',()=>{
                if(finished || token!==s.playToken || !preview.overlay.isConnected) return;
                s.bridge.toast('试听加载失败，已停止连续播放；此片段未标记已试听','error');stopPlayback(s);
            },{once:true});
            preview.overlay.addEventListener('autoedit-preview-close',()=>{if(!finished && token===s.playToken) stopPlayback(s);},{once:true});
            const startPlayback=()=>preview.video.play().catch(()=>{
                if(token===s.playToken) s.playStatus.textContent='浏览器暂停了自动播放，请点击播放器的播放按钮继续试听';
            });
            if(preview.video.readyState>=1) startPlayback();
            else preview.video.addEventListener('loadedmetadata',startPlayback,{once:true});
        };
        next();
    }
    async function confirmSelected(s) {
        stopPlayback(s);
        const queue=s.items.filter(item=>s.selected.has(item.key) && heardEligible(item,s.heard));
        if(!queue.length) return;
        s.busy=true;updateToolbarState(s);
        let count=0;
        let dirtyTask=null;
        let cachedTask=null;
        let cachedIssues=null;
        let lastConfirmedItem=null;
        try {
            for(const item of queue) {
                if(session!==s || !s.overlay.isConnected) break;
                if(dirtyTask && dirtyTask!==item.task) {
                    s.bridge.save();
                    dirtyTask=null;
                }
                if(!selectItem(item,s,true,true)) break;
                // 切换及保存可能改变风险；按任务复用当前快照核对类型和已试听指纹。
                if(cachedTask!==item.task || !cachedIssues) {
                    const targetSnapshots = typeof s.bridge.snapshotForTask === 'function'
                        ? [s.bridge.snapshotForTask(item.task)]
                        : s.bridge.snapshots();
                    cachedIssues=collect(targetSnapshots);
                    cachedTask=item.task;
                }
                const current=cachedIssues.find(entry=>entry.key===item.key);
                if(!current || !heardEligible(current,s.heard)) continue;
                const row=rowFor(current,s);
                if(row && s.bridge.confirm(row,{batch:true})) {
                    count++;
                    dirtyTask=item.task;
                    lastConfirmedItem=current;
                    s.selected.delete(item.key);
                    s.taskCache.delete(item.task);
                }
            }
            if(dirtyTask) s.bridge.save();
            if(lastConfirmedItem && lastConfirmedItem.task===s.bridge.currentTask()) focus(lastConfirmedItem,s);
            s.bridge.toast(`已确认 ${count} 个已试听的段内少量词差异；归属、切点和重复问题仍保留待审核`,'success');
        } finally {s.busy=false;refresh(s);}
    }
    async function copySelected(s,generation=false) {
        const items=s.items.filter(item=>s.selected.has(item.key));
        try {
            if(!generation) {await s.bridge.copyText(copyText(items));s.bridge.toast(`已复制 ${items.length} 项问题文案，带任务与片段位置`,'success');return;}
            const records=s.bridge.generationRecords();
            if(!records.length) return s.bridge.toast('请先在批量页面粘贴原始生成资料表格','info');
            const matches=items.map(item=>window.AutoEditGeneration.matchIssue({kind:item.kind==='missing'?'missing':'segment',
                text:item.text,recognized:item.recognized,source:item.source,startLine:item.startLine,endLine:item.endLine},item.task,records));
            const selected=[...new Map(matches.flatMap(match=>match.selected).map(record=>[JSON.stringify(record.columns),record])).values()];
            if(!selected.length) return s.bridge.toast('所选问题没有可靠匹配的生成资料，请用“查看资料匹配”核对候选','warning');
            const ok=await s.bridge.copyGeneration(selected);
            const unresolved=matches.filter(match=>!match.selected.length).length;
            if(ok && unresolved) s.bridge.toast(`已复制可靠匹配的资料；另有 ${unresolved} 项待核对，未加入复制`,'info');
        } catch(error) {s.bridge.toast(`复制失败：${error.message}`,'error');}
    }
    async function sendSelectedToHedra(s,autoStart=false,btn=null) {
        const items=s.items.filter(item=>s.selected.has(item.key));
        try {
            const records=s.bridge.generationRecords();
            if(!records.length) return s.bridge.toast('请先在批量页面粘贴或从生成端拉取原始生成资料表格','info');
            const matches=items.map(item=>window.AutoEditGeneration.matchIssue({kind:item.kind==='missing'?'missing':'segment',
                text:item.text,recognized:item.recognized,source:item.source,startLine:item.startLine,endLine:item.endLine},item.task,records));
            const selected=[...new Map(matches.flatMap(match=>match.selected).map(record=>[JSON.stringify(record.columns),record])).values()];
            if(!selected.length) return s.bridge.toast('所选问题没有可靠匹配的生成资料，请用“查看资料匹配”核对候选','warning');
            if(typeof s.bridge.sendGenerationToHedra === 'function') {
                await s.bridge.sendGenerationToHedra(selected, { autoStart }, btn);
            } else if(typeof window.sendAutoEditGenerationRowsToHedra === 'function') {
                await window.sendAutoEditGenerationRowsToHedra(selected, { autoStart }, btn);
            }
        } catch(error) {s.bridge.toast(`发回生成端失败：${error.message}`,'error');}
    }
    function mount({overlay,panel,content,bridge}) {
        if(session) unmount(session.overlay);
        const s={overlay,panel,content,bridge,items:[],selected:new Set(),heard:new Map(),taskCache:new WeakMap(),activeKey:null,busy:false,playToken:0,preview:null};
        session=s;
        panel.classList.add('ae-aggregate-panel');content.classList.add('ae-aggregate-review');
        const toolbar=element('div','ae-aggregate-toolbar');
        s.summary=element('strong','ae-aggregate-summary');
        s.type=element('select','select');s.type.setAttribute('aria-label','问题类型');
        const all=element('option','','全部问题');all.value='';s.type.append(all);
        Object.entries(labels).forEach(([value,label])=>{const option=element('option','',label);option.value=value;s.type.append(option);});
        s.search=element('input','input');s.search.placeholder='搜索任务、片段或文案';s.search.setAttribute('aria-label','搜索问题');
        s.type.onchange=()=>render(s);s.search.oninput=()=>render(s);
        const selectAll=button('勾选当前筛选',()=>{filterIssues(s.items,s.type.value,s.search.value).forEach(item=>s.selected.add(item.key));render(s);});
        const clear=button('取消勾选',()=>{s.selected.clear();render(s);});
        s.listen=button('连续试听所选片段',()=>listenSelected(s));
        const stop=button('停止试听',()=>stopPlayback(s));
        s.confirm=button('确认已试听的段内差异',()=>confirmSelected(s));
        s.confirm.classList.add('btn-primary');
        s.copy=button('复制所选问题文案',()=>copySelected(s));
        s.copyGeneration=button('复制所选原始生成资料',()=>copySelected(s,true));
        s.sendHedraImmediate=button('🚀 所选发回生成端立即重跑',e=>sendSelectedToHedra(s,true,e.currentTarget));
        s.sendHedraImmediate.classList.add('btn-primary');
        s.sendHedraImmediate.style.cssText='background:#ea580c;border-color:#ea580c;color:#fff;font-weight:700;';
        s.sendHedraMark=button('⚠️ 所选发回生成端标待重跑',e=>sendSelectedToHedra(s,false,e.currentTarget));
        const matches=button('查看资料匹配',()=>bridge.showGenerationMatches());
        s.next=button('下一项问题',()=>{
            refresh(s);const visible=filterIssues(s.items,s.type.value,s.search.value);
            const index=visible.findIndex(item=>item.key===s.activeKey);
            if(visible.length) selectItem(visible[index<0 ? Math.min(Math.max(0,s.activeIndex || 0),visible.length-1) : (index+1)%visible.length],s);
        });
        s.playStatus=element('span','hint');
        toolbar.append(s.summary,s.type,s.search,selectAll,clear,s.listen,stop,s.confirm,s.copy,s.copyGeneration,s.sendHedraImmediate,s.sendHedraMark,matches,s.next,s.playStatus);
        const hint=element('p','ae-aggregate-hint','左侧汇总全部任务的问题，右侧复用原列表审核。缺失文案可查看完整上下段、试听并修改切点；只有已试听的段内少量词差异可批量确认。');
        s.operationStatus=element('div','ae-aggregate-operation');s.operationStatus.setAttribute('aria-live','polite');
        const locate=s.locate=button('查看本次改动片段',()=>{
            const changed=s.operation?.changed?.[0];if(!changed) return;
            const row=Array.from(s.content.querySelectorAll('.autoedit-review-row')).find(node=>changed.source ? node.dataset.source===changed.source : node.dataset.reviewIndex===changed.index);
            row?.scrollIntoView({block:'center',behavior:'smooth'});
        });
        locate.className='btn btn-secondary ae-aggregate-locate';
        locate.style.display='none';
        const layout=element('div','ae-aggregate-layout');
        s.list=element('aside','ae-aggregate-list');s.list.setAttribute('aria-label','所有任务的待处理问题');
        content.before(toolbar,hint,s.operationStatus,locate,layout);layout.append(s.list,content);
        refresh(s);
        const first=s.items.find(item=>item.task===bridge.currentTask());if(first) selectItem(first,s);
    }
    function unmount(overlay) {
        if(!session || session.overlay!==overlay) return;
        const s=session;session=null;clearTimeout(refreshTimer);stopPlayback(s);
        s.content.querySelectorAll('.ae-aggregate-focus,.ae-aggregate-context').forEach(node=>node.classList.remove('ae-aggregate-focus','ae-aggregate-context'));
    }
    return {collect,filterIssues,copyText,heardEligible,mount,unmount,scheduleRefresh,captureView,restoreView};
});
