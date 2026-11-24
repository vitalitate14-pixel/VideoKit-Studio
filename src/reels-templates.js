/**
 * reels-templates.js — 视频模板库 UI + 逻辑
 * 
 * 功能：
 *   - 模板库面板（网格缩略图列表）
 *   - 保存当前工程为模板
 *   - 打开模板 → 独立编辑器窗口
 *   - 删除/重命名模板
 *   - 启动时检测 URL hash 自动加载模板
 */

// ═══════════════════════════════════════════════════════
// 1. 模板库 Modal UI
// ═══════════════════════════════════════════════════════

function _tplEscapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
}

function _templateStorageLabel(entry){
    if(!entry.kind)return '旧版工程 · 素材状态未记录';
    if(entry.kind==='preset')return '样式预设';
    const status=entry.assetCollection?.status;
    if(entry.kind==='package')return status==='complete'?'完整工程包 · 素材已收集':status==='partial'?'完整工程包 · 素材收集不完整':'完整工程包 · 素材状态待核验';
    return '工程快照 · 未收集外部素材';
}
function _allTasksSnapshot(project){
    const tabs=project.batchTable?.tabs;
    if(!Array.isArray(tabs) || !tabs.length)return project;
    const tasks=tabs.flatMap((tab,tabIndex)=>(tab.tasks || []).map((task,index)=>({...task,
        _batchTabId:tab.id,_batchTabName:tab.name,_batchTabOrder:tabIndex,_batchTaskOrder:index})));
    return {...project,tasks,selectedIdx:tasks.length?0:-1,batchTable:{...project.batchTable,appliedTabIds:tabs.map(tab=>tab.id)}};
}

let _currentTemplateContext = {
    id: '',
    name: '',
};

const TEMPLATE_CARD_SIZE_KEY = 'videokit_template_card_size';
let _templateLibraryConfig = { categories: ['口播', '人声reels', '字幕reels', '滚动字幕'] };
let _templateUpdateTarget = null;

async function _tplLibraryApi(action, data = {}) {
    const response = await apiFetch(`${API_BASE}/templates/${action}`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
    const result = await response.json();
    if (result.error || result.success === false) throw new Error(result.error || '操作失败');
    return result.data || result;
}
function _tplDateKey(value) {
    const date = new Date(value);
    if (!value || !Number.isFinite(date.getTime())) return '日期未记录';
    return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
}
function _tplMatchesFilters(tpl, filters, now = new Date()) {
    const index = tpl.searchIndex || {};
    const metadata = [tpl.name,tpl.description,...(tpl.tags || []),tpl.category].filter(Boolean).join('\n').toLocaleLowerCase();
    const all = [metadata,index.media,index.exports,index.keywords].filter(Boolean).join('\n');
    const matches = (text, query) => String(query || '').trim().toLocaleLowerCase().split(/\s+/).filter(Boolean).every(word=>text.includes(word));
    if (!matches(all,filters.search) || !matches(index.media || '',filters.media) || !matches(index.exports || '',filters.exportName)) return false;
    if (filters.category && (tpl.category || '') !== (filters.category === '__uncategorized__' ? '' : filters.category)) return false;
    const day = _tplDateKey(filters.dateField === 'createdAt' ? tpl.createdAt : tpl.updatedAt || tpl.createdAt);
    if (filters.period === 'range') {
        if (filters.start && filters.end && filters.start > filters.end) return false;
        return (!filters.start && !filters.end) || (day !== '日期未记录' && (!filters.start || day >= filters.start) && (!filters.end || day <= filters.end));
    }
    if (filters.period === 'date') return !filters.date || day === filters.date;
    const days = Number(filters.period);
    if (days > 0) {
        const start = new Date(now.getFullYear(),now.getMonth(),now.getDate());
        start.setDate(start.getDate()-days+1);
        return day !== '日期未记录' && day >= _tplDateKey(start) && day <= _tplDateKey(now);
    }
    return true;
}
function _tplVisibleCards(modal) { return [...modal.querySelectorAll('.tpl-card')].filter(card => card.style.display !== 'none'); }
function _tplMatchingIds(modal) { return modal._templateMatches ? modal._templateMatches.map(tpl=>String(tpl.id)) : _tplVisibleCards(modal).map(card=>card.dataset.id); }
function tplDateFilterChanged() {
    const period = document.getElementById('tpl-date-period').value;
    document.getElementById('tpl-exact-date').hidden = period !== 'date';
    document.getElementById('tpl-date-range').hidden = period !== 'range';
    window.tplFilterTemplates();
}
function tplResetFilters() {
    for (const id of ['tpl-library-search','tpl-media-search','tpl-export-search','tpl-category-filter','tpl-exact-date','tpl-date-start','tpl-date-end']) {
        const element = document.getElementById(id); if (element) element.value = '';
    }
    document.getElementById('tpl-date-field').value = 'updatedAt';
    document.getElementById('tpl-date-period').value = 'all';
    document.getElementById('template-library-modal')._templateSearch = '';
    tplDateFilterChanged();
}
function tplInvertSelection() {
    const modal = document.getElementById('template-library-modal');
    if (!modal || modal._onSelectCallback) return;
    const selected = modal._selectedTemplateIds;
    _tplMatchingIds(modal).forEach(id => { if(selected.has(id))selected.delete(id);else selected.add(id); });
    modal.querySelectorAll('.tpl-select-preset').forEach(box => {box.checked=selected.has(box.closest('.tpl-card').dataset.id);});
    _updateTemplatePresetSelectionUI();
}
async function tplManageCategory(remove = false) {
    try {
        const select=document.getElementById('tpl-category-filter');
        let categories=[..._templateLibraryConfig.categories];
        if(remove){
            const category=select.value;
            if(!categories.includes(category))return showToast('请先选择要删除的分类','info');
            if(!confirm(`删除分类「${category}」？该分类的模板将移到未分类，模板不会删除。`))return;
            categories=categories.filter(name=>name!==category);
        }else{
            const name=await _showInputDialog('新建模板分类','分类名称');
            if(!name?.trim())return;
            categories.push(name.trim());
        }
        _templateLibraryConfig=await _tplLibraryApi('save-library-config',{categories});
        await _refreshTemplateList();
    }catch(error){showToast(error.message,'error');}
}
async function tplClassifySelected() {
    const modal=document.getElementById('template-library-modal');
    const ids=[...(modal?._selectedTemplateIds || [])];
    if(!ids.length)return;
    try {await _tplLibraryApi('classify',{ids,category:document.getElementById('tpl-category-target').value});await _refreshTemplateList();}
    catch(error){showToast(error.message,'error');}
}
async function tplDeleteSelected() {
    const modal=document.getElementById('template-library-modal');
    const ids=[...(modal?._selectedTemplateIds || [])];
    if(!ids.length || !confirm(`删除选中的 ${ids.length} 个模板？只删除模板，不删除原始素材。此操作不可撤销。`))return;
    try {for(const id of ids){await _tplLibraryApi('delete',{id});modal._selectedTemplateIds.delete(id);}await _refreshTemplateList();}
    catch(error){showToast(error.message,'error');await _refreshTemplateList();}
}
function _tplSelectUpdateTarget(tpl) {
    _templateUpdateTarget={id:tpl.id,name:tpl.name};
    const modal=document.getElementById('template-library-modal');
    modal?.querySelectorAll('.tpl-card').forEach(card=>{card.style.outline=card.dataset.id===String(tpl.id)?'2px solid #fbbf24':'';});
    _updateCurrentTemplateButton();
}

function _getTemplateCardSize() {
    const stored = parseInt(localStorage.getItem(TEMPLATE_CARD_SIZE_KEY) || '240', 10);
    return Number.isFinite(stored) ? Math.max(100, Math.min(360, stored)) : 240;
}

function _setTemplateCardSize(value) {
    const size = Math.max(100, Math.min(360, parseInt(value, 10) || 240));
    localStorage.setItem(TEMPLATE_CARD_SIZE_KEY, String(size));
    const slider = document.getElementById('tpl-card-size-slider');
    const label = document.getElementById('tpl-card-size-value');
    const grid = document.getElementById('tpl-card-grid');
    if (slider && Number(slider.value) !== size) slider.value = String(size);
    if (label) label.textContent = `${size}px`;
    if (grid) grid.style.setProperty('--tpl-card-size', `${size}px`);
}

function _setCurrentTemplateContext(id, name) {
    _currentTemplateContext = {
        id: id || '',
        name: name || '',
    };
    _updateCurrentTemplateButton();
}

function _updateCurrentTemplateButton() {
    const target = _templateUpdateTarget || _currentTemplateContext;
    const btn = document.getElementById('tpl-update-current-btn');
    const label = document.getElementById('tpl-current-template-label');
    if (btn) {
        btn.disabled = !target.id;
        btn.style.opacity = target.id ? '1' : '0.45';
        btn.style.cursor = target.id ? 'pointer' : 'not-allowed';
        btn.title = target.id ? `用当前工程覆盖模板「${target.name || target.id}」` : '请先点击要更新的模板';
    }
    if (label) {
        label.textContent = target.id ? `更新目标: ${target.name || target.id}` : '请点击模板选择更新目标';
        label.title = target.name || target.id || '';
    }
}

function openTemplateLibrary(onSelectCallback = null, opts = {}) {
    // 如果已存在就显示
    let modal = document.getElementById('template-library-modal');
    if (modal) {
        modal.style.display = 'flex';
        // 绑定回调到全局，方便 _refreshTemplateList 中使用
        modal._onSelectCallback = onSelectCallback;
        modal._pickerDisabledIds = new Set(opts.disabledIds || []);
        modal._resetTemplatePage=true;
        if(modal._templateSummaries)window.tplFilterTemplates();
        _updateCurrentTemplateButton();
        _refreshTemplateList();
        return;
    }

    modal = document.createElement('div');
    modal.id = 'template-library-modal';
    modal._onSelectCallback = onSelectCallback;
    modal._pickerDisabledIds = new Set(opts.disabledIds || []);
    modal._selectedTemplateIds = new Set();
    modal.style.cssText = 'display:flex;align-items:center;justify-content:center;z-index:400000;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.6);backdrop-filter:blur(4px);';
    
    // UI elements hide/show based on mode
    const isPicker = !!onSelectCallback;
    
    modal.innerHTML = `
        <div class="modal-content" style="width:90vw;max-width:1100px;height:80vh;display:flex;flex-direction:column;background:var(--bg-secondary,#1a1a2e);border-radius:16px;overflow:hidden;border:1px solid rgba(255,255,255,0.08);">
            <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;padding:18px 24px;border-bottom:1px solid rgba(255,255,255,0.06);">
                <div style="display:flex;align-items:center;gap:12px;">
                    <span style="font-size:22px;">📂</span>
                    <h2 id="tpl-lib-title" style="margin:0;font-size:18px;font-weight:700;color:#fff;">${isPicker ? '选择视频模板' : '工程与模板库'}</h2>
                    <span id="tpl-count-badge" style="font-size:11px;padding:2px 8px;background:rgba(110,231,183,0.15);color:#6ee7b7;border-radius:10px;"></span>
                </div>
                <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;justify-content:flex-end;">
                    <label title="搜索工程名、描述、标签、素材、导出名和文字；空格分隔的关键词需全部匹配" style="display:flex;align-items:center;gap:5px;padding:4px 8px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);border-radius:8px;">
                        <span style="font-size:13px;">🔎</span><input id="tpl-library-search" type="search" aria-label="搜索工程关键词" placeholder="工程 / 素材 / 导出名 / 关键词" oninput="tplFilterTemplates(this.value)" style="width:210px;border:0;outline:0;background:transparent;color:#eee;font-size:12px;">
                    </label>
                    ${isPicker ? '' : `
                    <button onclick="saveProjectSnapshot()" style="padding:5px 12px;font-size:11px;font-weight:600;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;border:none;border-radius:8px;cursor:pointer;">💾 保存工程快照</button>
                    <button class="btn btn-secondary" onclick="saveCurrentStylePreset()">🎨 保存样式预设</button>
                    <button class="btn btn-secondary" onclick="saveProjectSnapshot('package')">📦 打包完整工程</button>
                    <button id="tpl-update-current-btn" onclick="updateCurrentTemplate()" style="padding:5px 12px;font-size:11px;font-weight:600;background:rgba(245,158,11,0.16);color:#fbbf24;border:1px solid rgba(245,158,11,0.35);border-radius:8px;cursor:pointer;">♻️ 更新选中模板</button>
                    <button id="tpl-repair-thumbnails-btn" onclick="repairDuplicateTemplateThumbnails()" style="padding:5px 12px;font-size:11px;font-weight:600;background:rgba(14,165,233,0.15);color:#7dd3fc;border:1px solid rgba(14,165,233,0.35);border-radius:8px;cursor:pointer;">📸 修复重复封面</button>
                    <button onclick="_importTemplate()" style="padding:5px 12px;font-size:11px;font-weight:600;background:rgba(16,185,129,0.15);color:#10b981;border:1px solid rgba(16,185,129,0.3);border-radius:8px;cursor:pointer;">📥 导入</button>
                    <button id="tpl-export-all-btn" onclick="_exportAllTemplates()" style="padding:5px 12px;font-size:11px;font-weight:600;background:rgba(236,72,153,0.15);color:#ec4899;border:1px solid rgba(236,72,153,0.3);border-radius:8px;cursor:pointer;">📤 导出全部</button>
                    <button id="tpl-export-selected-btn" class="btn btn-secondary" onclick="_exportSelectedTemplates()" disabled title="仅导出勾选工程的配置，不收集外部素材">📤 导出选中工程</button>
                    <button id="tpl-select-all-btn" onclick="tplSelectAllTemplates()" style="padding:5px 12px;font-size:11px;font-weight:600;background:rgba(59,130,246,0.14);color:#93c5fd;border:1px solid rgba(59,130,246,0.34);border-radius:8px;cursor:pointer;">☑ 全选模板</button>
                    <button id="tpl-save-selected-presets-btn" onclick="tplSaveSelectedPresets()" style="padding:5px 12px;font-size:11px;font-weight:600;background:rgba(16,185,129,0.16);color:#6ee7b7;border:1px solid rgba(16,185,129,0.36);border-radius:8px;cursor:pointer;">💾 保存所选预设</button>
                    <button id="tpl-export-selected-skill-btn" onclick="tplExportSelectedSkills()" disabled title="将勾选模板导出为 AI 复刻渲染 Skill（自动剥离素材路径与文案，支持合并为预设库 Skill）" style="padding:5px 12px;font-size:11px;font-weight:600;background:rgba(139,92,246,0.2);color:#ddd6fe;border:1px solid rgba(139,92,246,0.42);border-radius:8px;cursor:not-allowed;opacity:.48;">⚡ 导出选中 Skill</button>
                    <span id="tpl-selected-count" style="font-size:10px;color:#94a3b8;white-space:nowrap;">未选择</span>
                    <span id="tpl-current-template-label" style="max-width:170px;font-size:10px;color:#777;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"></span>
                    `}
                    <label title="调整模板卡片大小" style="display:flex;align-items:center;gap:5px;padding:3px 7px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08);border-radius:8px;color:#999;font-size:10px;white-space:nowrap;">
                        <span>卡片</span>
                        <input id="tpl-card-size-slider" type="range" min="100" max="360" step="20" value="${_getTemplateCardSize()}" oninput="_setTemplateCardSize(this.value)" style="width:82px;accent-color:#7c5cff;">
                        <span id="tpl-card-size-value" style="width:35px;text-align:right;">${_getTemplateCardSize()}px</span>
                    </label>
                    <button onclick="document.getElementById('template-library-modal').style.display='none'" style="background:none;border:none;color:#888;font-size:20px;cursor:pointer;padding:4px 8px;">✕</button>
                </div>
            </div>
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:10px 24px;border-bottom:1px solid #444;color:#ccc;">
                <label>分类 <select id="tpl-category-filter" onchange="tplFilterTemplates()"><option value="">全部</option></select></label>
                ${isPicker ? '' : `<button class="btn btn-secondary" onclick="tplManageCategory()">＋分类</button><button class="btn btn-secondary" onclick="tplManageCategory(true)">删除分类</button><select id="tpl-category-target" aria-label="所选模板移动到分类"></select><button class="btn btn-secondary" onclick="tplClassifySelected()">移动所选</button><button class="btn btn-secondary" onclick="tplInvertSelection()">反选</button><button class="btn btn-secondary" onclick="tplDeleteSelected()">删除所选</button>`}
                <label>日期依据 <select id="tpl-date-field" onchange="tplFilterTemplates()"><option value="updatedAt">最近更新</option><option value="createdAt">创建时间</option></select></label>
                <label>日期 <select id="tpl-date-period" onchange="tplDateFilterChanged()"><option value="all">全部日期</option><option value="3">三天内</option><option value="7">一周内</option><option value="30">一个月内（30天）</option><option value="date">具体日期</option><option value="range">日期范围</option></select></label>
                <input id="tpl-exact-date" type="date" hidden aria-label="筛选具体日期" onchange="tplFilterTemplates()">
                <span id="tpl-date-range" hidden><input id="tpl-date-start" type="date" aria-label="起始日期（含当天）" onchange="tplFilterTemplates()"> 至 <input id="tpl-date-end" type="date" aria-label="结束日期（含当天）" onchange="tplFilterTemplates()"></span>
                <button class="btn btn-secondary" onclick="tplResetFilters()">清空筛选</button>
                <small>先加载最近两天 · 向下滚动加载更早工程</small>
            </div>
            <details style="padding:10px 24px;border-bottom:1px solid #444;color:#ccc;font-size:12px;">
                <summary style="cursor:pointer;">高级搜索 <span id="tpl-advanced-status" style="color:#a5b4fc;"></span></summary>
                <div style="display:flex;flex-wrap:wrap;align-items:center;gap:12px;margin-top:10px;">
                    <label>素材 <input id="tpl-media-search" type="search" placeholder="文件名、路径或素材文件夹" oninput="tplFilterTemplates()" style="width:220px;"></label>
                    <label>导出名称 <input id="tpl-export-search" type="search" placeholder="任务导出名 / 默认任务名" oninput="tplFilterTemplates()" style="width:220px;"></label>
                </div>
                <p style="margin:8px 0 0;color:#999;">关键词之间用空格分隔，需全部匹配；所有筛选条件同时生效。素材按工程内记录的名称或路径匹配，日期包含起止当天。</p>
            </details>
            <div id="tpl-filter-feedback" role="status" style="padding:8px 24px;color:#fbbf24;font-size:12px;" hidden></div>
            <div id="tpl-grid-container" style="flex:1;overflow-y:auto;padding:20px 24px;">
                <div style="color:#666;text-align:center;padding:60px 0;">加载中...</div>
            </div>
        </div>
    `;

    // 点击遮罩关闭
    modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.style.display = 'none';
    });

    document.body.appendChild(modal);
    _updateCurrentTemplateButton();
    _refreshTemplateList();
}

window.tplFilterTemplates = function (query) {
    const modal = document.getElementById('template-library-modal');
    if (!modal) return;
    if (query !== undefined) modal._templateSearch = String(query || '').trim().toLocaleLowerCase();
    const filters={search:modal._templateSearch || '', category:document.getElementById('tpl-category-filter')?.value || '',
        media:document.getElementById('tpl-media-search')?.value || '',exportName:document.getElementById('tpl-export-search')?.value || '',
        dateField:document.getElementById('tpl-date-field')?.value || 'updatedAt',
        start:document.getElementById('tpl-date-start')?.value || '',end:document.getElementById('tpl-date-end')?.value || '',
        period:document.getElementById('tpl-date-period')?.value || 'all',date:document.getElementById('tpl-exact-date')?.value || ''};
    _tplRenderPage(modal,filters);
    const shown=(modal._templateMatches || []).length,total=(modal._templateSummaries || []).length;
    const badge=document.getElementById('tpl-count-badge');if(badge)badge.textContent=`${shown}/${total} 个模板`;
    const status=document.getElementById('tpl-advanced-status');if(status)status.textContent=filters.media.trim() || filters.exportName.trim()?'（已启用）':'';
    const feedback=document.getElementById('tpl-filter-feedback');
    const needsSearch=!!(filters.search.trim() || filters.media.trim() || filters.exportName.trim());
    if(needsSearch)_loadTemplateSearchIndexes(modal);
    if(feedback){
        const invalid=filters.period==='range' && filters.start && filters.end && filters.start>filters.end;
        const unavailable=(modal._templateSummaries || []).filter(tpl=>tpl.searchIndex?.unavailable).length;
        const pending=needsSearch && (modal._templateSummaries || []).some(tpl=>!tpl.searchIndex);
        feedback.textContent=invalid?'起始日期不能晚于结束日期。':pending
            ? modal._searchIndexError || `正在后台搜索工程内容（${(modal._templateSummaries || []).filter(tpl=>tpl.searchIndex).length}/${total}），可继续操作…`
            :total && !shown?'没有符合条件的工程，请调整关键词或清空筛选。':unavailable?`${unavailable} 个工程文件暂时无法读取，素材和导出名称搜索可能不完整。`:'';
        feedback.hidden=!feedback.textContent;
    }
    _updateTemplatePresetSelectionUI();
};

async function _loadTemplateSearchIndexes(modal) {
    if(modal._searchIndexLoading || modal._searchIndexError)return;
    const summaries=modal._templateSummaries || [];
    if(!summaries.some(tpl=>!tpl.searchIndex))return;
    const token={};
    modal._searchIndexLoading=token;
    try {
        for(let offset=0;offset<summaries.length;offset+=4){
            if(modal._templateSummaries!==summaries || modal.style.display==='none')break;
            const searching=[modal._templateSearch,document.getElementById('tpl-media-search')?.value,document.getElementById('tpl-export-search')?.value].some(value=>String(value || '').trim());
            if(!searching)break;
            const ids=summaries.slice(offset,offset+4).filter(tpl=>!tpl.searchIndex).map(tpl=>tpl.id);
            if(!ids.length)continue;
            const results=await _tplLibraryApi('search-index',{ids});
            if(modal._templateSummaries!==summaries)break;
            const indexed=new Map(results.map(entry=>[String(entry.id),entry.searchIndex]));
            for(const tpl of summaries.slice(offset,offset+4))if(indexed.has(String(tpl.id)))tpl.searchIndex=indexed.get(String(tpl.id));
            window.tplFilterTemplates();
            // Give input, scrolling and paint a turn between search batches.
            await new Promise(resolve=>setTimeout(resolve,0));
        }
    }catch(error){
        if(modal._templateSummaries===summaries){
            modal._searchIndexError='工程内容搜索失败：'+error.message;
            window.tplFilterTemplates();
        }
    }finally{
        if(modal._searchIndexLoading===token)modal._searchIndexLoading=null;
    }
}

function _hydrateTemplateLibraryThumbnails(modal,container) {
    if(modal._thumbnailLoader?.container===container){modal._thumbnailLoader.add();return;}
    modal._thumbnailLoader?.dispose();
    let disposed=false,active=0;
    const queue=[];
    const pending=new Set();
    const pump=()=>{
        while(!disposed && active<4 && queue.length){
            const img=queue.shift();active++;
            _tplLibraryApi('thumbnail',{id:img.dataset.tplThumbnailId}).then(result=>{
                if(!disposed && result.thumbnail)img.src=result.thumbnail;
            }).catch(()=>{if(!disposed)img.alt='封面暂不可用';}).finally(()=>{active--;pump();});
        }
    };
    const enqueue=img=>{if(disposed || pending.has(img))return;pending.add(img);queue.push(img);pump();};
    const observer=window.IntersectionObserver?new window.IntersectionObserver(entries=>{
        for(const entry of entries)if(entry.isIntersecting){observer.unobserve(entry.target);enqueue(entry.target);}
    },{root:container,rootMargin:'150px'}):null;
    const observed=new WeakSet();
    const add=()=>{
        for(const img of container.querySelectorAll('img[data-tpl-thumbnail-id]')){
            if(!img.dataset.tplThumbnailId || observed.has(img))continue;
            observed.add(img);
            if(observer)observer.observe(img);else enqueue(img);
        }
    };
    modal._thumbnailLoader={container,add,dispose(){disposed=true;queue.length=0;observer?.disconnect();}};
    add();
}

function _tplInitialRenderCount(templates, filters, now = new Date()) {
    const filtered = filters.search || filters.media || filters.exportName || filters.category || filters.period !== 'all';
    if (filtered) return Math.min(24,templates.length);
    const yesterday = new Date(now.getFullYear(),now.getMonth(),now.getDate()-1);
    const cutoff = _tplDateKey(yesterday);
    return Math.min(24,templates.filter(tpl=>_tplDateKey(tpl.updatedAt || tpl.createdAt)>=cutoff && _tplDateKey(tpl.updatedAt || tpl.createdAt)!=='日期未记录').length);
}

function _tplAppendCards(modal, container, templates) {
    const isPicker = !!modal._onSelectCallback;
        let lastDate = null;
        let html = `<div class="tpl-page">`;
        for (const tpl of templates) {
            const day=_tplDateKey(tpl.updatedAt || tpl.createdAt);
            if(day!==lastDate){
                if(lastDate!==null)html+='</div></section>';
                html+=`<section class="tpl-date-section" data-tpl-day="${day}" style="margin-bottom:24px;"><h3 style="display:flex;gap:12px;color:#ddd;margin:0 0 12px;">${day}<small data-date-count></small></h3><div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(var(--tpl-card-size),var(--tpl-card-size)));gap:16px;align-items:start;">`;
                lastDate=day;
            }
            const thumbSrc = tpl.thumbnail || '';
            const dateStr = tpl.updatedAt ? new Date(tpl.updatedAt).toLocaleDateString('zh-CN') : '';
            const taskInfo = (tpl.taskCount ? `${tpl.taskCount} 个任务 · ` : '') + _templateStorageLabel(tpl);
            const safeId = _tplEscapeHtml(tpl.id);
            const safeName = _tplEscapeHtml(tpl.name || '');
            const safeThumb = _tplEscapeHtml(thumbSrc);
            const safeDate = _tplEscapeHtml(dateStr);
            const safeTaskInfo = _tplEscapeHtml(taskInfo);
            const isDisabledPick = isPicker && modal._pickerDisabledIds && modal._pickerDisabledIds.has(tpl.id);
            const isSelected = !isPicker && modal._selectedTemplateIds.has(String(tpl.id));
            const thumbSync = `onload="if(this.naturalWidth&&this.naturalHeight){var b=this.closest('.tpl-thumb-box');if(b)b.style.aspectRatio=this.naturalWidth+'/'+this.naturalHeight;}"`;
            const thumbAspect = (Number(tpl.canvasWidth) > 0 && Number(tpl.canvasHeight) > 0)
                ? `${Number(tpl.canvasWidth)}/${Number(tpl.canvasHeight)}`
                : '9/16';
            const thumbHtml = thumbSrc
                ? `<img loading="lazy" src="${safeThumb}" ${thumbSync} style="width:100%;height:100%;object-fit:cover;" />`
                : tpl.hasThumbnail ? `<img loading="lazy" decoding="async" data-tpl-thumbnail-id="${safeId}" alt="模板封面" ${thumbSync} style="width:100%;height:100%;object-fit:cover;" />`
                : `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#555;font-size:36px;">🎬</div>`;

            const actionsHtml = isPicker ? `
                <div class="tpl-actions" style="position:absolute;top:8px;right:8px;left:8px;display:flex;flex-wrap:wrap;justify-content:flex-end;gap:4px;opacity:0;transition:opacity 0.2s;background:rgba(0,0,0,0.7);padding:6px;border-radius:8px;">
                    <button data-action="pick" ${isDisabledPick ? 'disabled' : ''} style="padding:4px 12px;font-size:12px;font-weight:600;background:${isDisabledPick ? 'rgba(120,120,130,0.35)' : 'linear-gradient(135deg,#7c5cff,#a855f7)'};color:${isDisabledPick ? '#999' : '#fff'};border:none;border-radius:6px;cursor:${isDisabledPick ? 'not-allowed' : 'pointer'};">${isDisabledPick ? '已添加' : '✅ 选用此模板'}</button>
                </div>
            ` : `
                <div class="tpl-actions" style="position:absolute;top:8px;right:8px;left:8px;display:flex;flex-wrap:wrap;justify-content:flex-end;gap:4px;opacity:1;transition:opacity 0.2s;background:rgba(0,0,0,0.5);padding:4px;border-radius:8px;">
                    <button data-action="load" style="padding:4px 6px;font-size:11px;background:rgba(59,130,246,0.9);color:#fff;border:none;border-radius:6px;cursor:pointer;" title="覆盖当前工程直接载入">🔽</button>
                    <button data-action="append" style="padding:4px 6px;font-size:11px;background:rgba(16,185,129,0.25);color:#6ee7b7;border:1px solid rgba(16,185,129,0.4);border-radius:6px;cursor:pointer;" title="保留已有任务，将模板任务追加到列表末尾">＋追加</button>
                    <button data-action="window" style="padding:4px 6px;font-size:11px;background:rgba(99,102,241,0.9);color:#fff;border:none;border-radius:6px;cursor:pointer;" title="独立新窗口打开">🪟</button>
                    <button data-action="export" style="padding:4px 6px;font-size:11px;background:rgba(16,185,129,0.2);color:#10b981;border:none;border-radius:6px;cursor:pointer;" title="仅导出 JSON 配置">📤</button>
                    <button data-action="export_skill" style="padding:4px 6px;font-size:11px;background:rgba(139,92,246,0.28);color:#ddd6fe;border:none;border-radius:6px;cursor:pointer;" title="一键生成 AI 复刻渲染 Skill（不含素材与台词）">⚡</button>
                    <button data-action="versions" title="查看覆盖前的版本">↶ 历史版本</button>
                    <button data-action="export_archive" style="padding:4px 6px;font-size:11px;background:rgba(245,158,11,0.2);color:#fbbf24;border:none;border-radius:6px;cursor:pointer;" title="打包导出关联素材 (归档)">📦</button>
                    <button data-action="rename" style="padding:4px 6px;font-size:11px;background:rgba(255,255,255,0.1);color:#ccc;border:none;border-radius:6px;cursor:pointer;" title="重命名">✏️</button>
                    <button data-action="delete" style="padding:4px 6px;font-size:11px;background:rgba(239,68,68,0.2);color:#f87171;border:none;border-radius:6px;cursor:pointer;" title="删除">🗑</button>
                </div>
            `;

            html += `
                <div class="tpl-card" data-id="${safeId}" data-name="${safeName}" data-disabled-pick="${isDisabledPick ? 'true' : 'false'}" style="background:rgba(255,255,255,${isDisabledPick ? '0.018' : '0.03'});border:1px solid ${isDisabledPick ? 'rgba(120,120,130,0.28)' : 'rgba(255,255,255,0.06)'};border-radius:12px;overflow:hidden;cursor:${isDisabledPick ? 'not-allowed' : 'pointer'};transition:all 0.2s;position:relative;${isDisabledPick ? 'opacity:0.58;' : ''}"
                     onmouseenter="this.style.borderColor='rgba(99,102,241,0.4)';this.style.transform='translateY(-2px)'"
                     onmouseleave="this.style.borderColor='rgba(255,255,255,0.06)';this.style.transform='none'">
                    <div class="tpl-thumb-box" style="width:100%;aspect-ratio:${thumbAspect};background:#0a0a1a;overflow:hidden;position:relative;">
                        ${thumbHtml}
                        ${isPicker ? '' : `<label title="选择模板进行批量分类、删除或保存预设" style="position:absolute;left:8px;bottom:8px;z-index:3;display:flex;align-items:center;gap:4px;padding:4px 7px;background:rgba(0,0,0,.72);border-radius:7px;color:#fff;font-size:11px;cursor:pointer;"><input class="tpl-select-preset" type="checkbox" ${isSelected ? 'checked' : ''} style="accent-color:#34d399;cursor:pointer;"> 选择模板</label>`}
                    </div>
                    ${isDisabledPick ? '<div style="position:absolute;left:8px;top:8px;background:rgba(16,185,129,0.9);color:#06150f;font-size:11px;font-weight:700;padding:3px 8px;border-radius:999px;">已添加</div>' : ''}
                    <div style="padding:10px 12px;">
                        <div class="tpl-name" style="font-size:13px;font-weight:600;color:#e0e0e0;white-space:normal;overflow-wrap:anywhere;line-height:1.5;" title="${safeName}">${safeName}</div>
                        <div class="tpl-card-meta" style="font-size:10px;color:#666;margin-top:4px;">
                            <span>${safeDate} · ${_tplEscapeHtml(tpl.category || '未分类')}</span>
                            <span>${safeTaskInfo}</span>
                        </div>
                    </div>
                    ${actionsHtml}
                </div>
            `;
        }
        html += '</div></section></div>';
        const grid = document.getElementById('tpl-card-grid');
        grid.insertAdjacentHTML('beforeend', html);
        const page = grid.lastElementChild;
        const addedCards = [...page.querySelectorAll('.tpl-card')];
        // 显示操作按钮的 hover 效果
        addedCards.forEach(card => {
            const selectBox = card.querySelector('.tpl-select-preset');
            if (selectBox) {
                selectBox.addEventListener('click', event => event.stopPropagation());
                selectBox.closest('label')?.addEventListener('click', event => event.stopPropagation());
                selectBox.addEventListener('change', event => {
                    const selected = modal._selectedTemplateIds || (modal._selectedTemplateIds = new Set());
                    if (event.currentTarget.checked) selected.add(card.dataset.id);
                    else selected.delete(card.dataset.id);
                    _updateTemplatePresetSelectionUI();
                });
            }
            if (isPicker) {
                card.addEventListener('mouseenter', () => card.querySelector('.tpl-actions').style.opacity = '1');
                card.addEventListener('mouseleave', () => card.querySelector('.tpl-actions').style.opacity = '0');
            } else {
                card.addEventListener('mouseenter', () => card.querySelector('.tpl-actions').style.opacity = '1');
                card.addEventListener('mouseleave', () => card.querySelector('.tpl-actions').style.opacity = '0');
            }
            
            card.querySelector('.tpl-actions')?.addEventListener('click', async (e) => {
                const btn = e.target.closest('button[data-action]');
                if (!btn) return;
                e.stopPropagation();
                const id = card.dataset.id || '';
                const name = card.dataset.name || '';
                const action = btn.dataset.action;
                
                if (action === 'pick') {
                    if (btn.disabled || card.dataset.disabledPick === 'true') return;
                    // Fetch full data and pass to callback
                    btn.textContent = '加载中...';
                    try {
                        const r = await apiFetch(`${API_BASE}/templates/get`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({id}) });
                        const res = await r.json();
                        const tplData = res.data || res;
                        if (modal._onSelectCallback) {
                            modal._onSelectCallback(tplData);
                        }
                        btn.textContent = '✅ 已添加';
                        btn.style.background = 'rgba(16,185,129,0.8)';
                        setTimeout(() => {
                            btn.textContent = '✅ 选用此模板';
                            btn.style.background = 'linear-gradient(135deg,#7c5cff,#a855f7)';
                        }, 1500);
                    } catch(err) {
                        alert('读取模板失败');
                        btn.textContent = '✅ 选用此模板';
                    }
                }
                else if (action === 'load') _loadTemplateInCurrentWindow(id);
                else if (action === 'append') _appendTemplateInCurrentWindow(id);
                else if (action === 'window') _openTemplateInWindow(id, name);
                else if (action === 'versions') showTemplateVersions(id,name);
                else if (action === 'export') _exportTemplate(id, name);
                else if (action === 'export_skill') _exportTemplatesAsSkill([id]);
                else if (action === 'export_archive') _exportArchiveTemplate(id, name);
                else if (action === 'rename') _renameTemplate(id);
                else if (action === 'delete') _deleteTemplate(id, name);
            });
            
            if (!isPicker) card.addEventListener('click', () => _tplSelectUpdateTarget({id:card.dataset.id,name:card.dataset.name}));
            // 双击打开
            card.addEventListener('dblclick', async () => {
                const id = card.dataset.id;
                const name = card.dataset.name || '';
                if (isPicker) {
                    if (card.dataset.disabledPick === 'true') return;
                    try {
                        const r = await apiFetch(`${API_BASE}/templates/get`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({id}) });
                        const res = await r.json();
                        if (modal._onSelectCallback) modal._onSelectCallback(res.data || res);
                    } catch(err) {}
                } else {
                    _openTemplateInWindow(id, name);
                }
            });
        });


    // Continue the same date section across pages without rebuilding existing cards.
    const days = new Map();
    for (const section of grid.querySelectorAll('.tpl-date-section')) {
        const day = section.dataset.tplDay;
        if (days.has(day)) {
            days.get(day).lastElementChild.append(...section.lastElementChild.children);
            section.remove();
        } else days.set(day,section);
    }
    for (const section of days.values()) section.querySelector('[data-date-count]').textContent = `${section.querySelectorAll('.tpl-card').length} 个模板`;
    _hydrateTemplateLibraryThumbnails(modal,container);
}

function _tplLoadMore(modal, container) {
    const matches = modal._templateMatches || [];
    const start = modal._templateRenderedCount || 0;
    const end = Math.min(matches.length,start+24);
    if (end>start) _tplAppendCards(modal,container,matches.slice(start,end));
    modal._templateRenderedCount = end;
    _tplUpdatePagingFooter(modal,container);
    _updateTemplatePresetSelectionUI();
}

function _tplUpdatePagingFooter(modal, container) {
    const button = document.getElementById('tpl-load-more');
    if (!button) return;
    const count = modal._templateRenderedCount || 0,total = (modal._templateMatches || []).length;
    button.hidden = count>=total;
    button.style.display = count>=total ? 'none' : 'block';
    button.textContent = count ? `已加载 ${count}/${total} 个 · 向下滚动或点击加载更早工程` : `最近两天没有工程 · 点击加载更早工程（${total} 个）`;
}

function _tplRenderPage(modal, filters) {
    const container = document.getElementById('tpl-grid-container');
    if (!container) return;
    if (!modal._templateSummaries?.length) {
        modal._templateMatches=[]; modal._templateRenderedCount=0;
        container.innerHTML='<div style="text-align:center;padding:80px 0;color:#777;">📂 还没有保存任何模板</div>';
        return;
    }
    const matches = (modal._templateSummaries || []).filter(tpl=>_tplMatchesFilters(tpl,filters));
    const filterKey = JSON.stringify(filters),matchesKey = JSON.stringify(matches.map(tpl=>tpl.id));
    const reset = modal._resetTemplatePage || modal._templateFilterKey!==filterKey;
    if (!reset && modal._templateMatchesKey===matchesKey) return;
    const count = reset ? _tplInitialRenderCount(matches,filters) : Math.min(matches.length,Math.max(24,modal._templateRenderedCount || 0));
    const scrollTop = reset ? 0 : container.scrollTop;
    modal._resetTemplatePage = false;
    modal._templateFilterKey = filterKey; modal._templateMatchesKey = matchesKey;
    modal._templateMatches = matches; modal._templateRenderedCount = count;
    modal._thumbnailLoader?.dispose(); modal._thumbnailLoader=null;
    container.innerHTML = `<div id="tpl-card-grid" style="--tpl-card-size:${_getTemplateCardSize()}px;display:block;"></div><button id="tpl-load-more" style="display:block;width:100%;padding:18px;margin-top:16px;background:#151925;color:#a5b4fc;border:1px dashed #475569;border-radius:8px;cursor:pointer;"></button>`;
    if (count) _tplAppendCards(modal,container,matches.slice(0,count));
    container.scrollTop = scrollTop;
    const button = document.getElementById('tpl-load-more');
    button.onclick = () => _tplLoadMore(modal,container);
    let queued = false, previousTop = container.scrollTop;
    const nearBottom = () => container.scrollHeight-container.scrollTop-container.clientHeight<240;
    const schedule = () => {
        if (queued || modal.style.display==='none' || !nearBottom() || modal._templateRenderedCount>=matches.length) return;
        queued=true;
        requestAnimationFrame(()=>{queued=false;if(modal._templateMatches===matches && modal.style.display!=='none')_tplLoadMore(modal,container);});
    };
    container.onscroll = () => { const top=container.scrollTop;if(top>previousTop)schedule();previousTop=top; };
    // A short recent list may not have a scrollbar yet; scrolling down still loads the next page.
    container.onwheel = event => { if(event.deltaY>0)schedule(); };
    _tplUpdatePagingFooter(modal,container);
}

async function _refreshTemplateList() {
    const modal = document.getElementById('template-library-modal');
    const container = document.getElementById('tpl-grid-container');
    const badge = document.getElementById('tpl-count-badge');
    if (!container || !modal) return;
    
    const isPicker = !!modal._onSelectCallback;
    const request=modal._templateListRequest=(modal._templateListRequest || 0)+1;

    try {
        const [parsed,config] = await Promise.all([
            _tplLibraryApi('list',{includeThumbnails:false,includeSearch:false}),
            _tplLibraryApi('library-config'),
        ]);
        if(request!==modal._templateListRequest)return;
        const templates = (parsed.data || parsed || []).slice().sort((a,b)=>(Date.parse(b.updatedAt || b.createdAt)||0)-(Date.parse(a.updatedAt || a.createdAt)||0));
        const signature=JSON.stringify([templates,config,isPicker,[...(modal._pickerDisabledIds || [])]]);
        if(modal._templateListSignature===signature){window.tplFilterTemplates();return;}
        modal._thumbnailLoader?.dispose();
        _templateLibraryConfig = config;
        for (const id of ['tpl-category-filter','tpl-category-target']) {
            const select=document.getElementById(id);if(!select)continue;
            const previous=select.value;
            select.innerHTML=(id==='tpl-category-filter'?'<option value="">全部分类</option><option value="__uncategorized__">未分类</option>':'<option value="">未分类</option>')
                +_templateLibraryConfig.categories.map(name=>`<option value="${_tplEscapeHtml(name)}">${_tplEscapeHtml(name)}</option>`).join('');
            if([...select.options].some(option=>option.value===previous))select.value=previous;
        }
        if (_templateUpdateTarget && !templates.some(tpl=>String(tpl.id)===String(_templateUpdateTarget.id)))_templateUpdateTarget=null;
        _updateCurrentTemplateButton();
        modal._templateSummaries = templates;
        modal._resetTemplatePage=true;
        modal._searchIndexLoading=null;
        modal._searchIndexError='';
        if (!modal._selectedTemplateIds) modal._selectedTemplateIds = new Set();
        const availableIds = new Set(templates.map(tpl => String(tpl.id)));
        [...modal._selectedTemplateIds].forEach(id => { if (!availableIds.has(String(id))) modal._selectedTemplateIds.delete(id); });

        badge.textContent = `${templates.length} 个模板`;

        // Also update title in case mode changed via display='flex'
        const titleEl = document.getElementById('tpl-lib-title');
        if (titleEl) titleEl.textContent = isPicker ? '选择视频模板' : '视频模板库';

        if (templates.length === 0) {
            modal._templateMatches=[];
            modal._templateListSignature=signature;
            container.innerHTML = `
                <div style="text-align:center;padding:80px 0;color:#555;">
                    <div style="font-size:48px;margin-bottom:16px;opacity:0.4;">📂</div>
                    <p style="font-size:14px;margin:0;">还没有保存任何模板</p>
                    ${isPicker ? '' : '<p style="font-size:12px;color:#444;margin-top:6px;">点击上方「保存当前工程为模板」开始</p>'}
                </div>
            `;
            return;
        }

        window.tplFilterTemplates();
        modal._templateListSignature=signature;
    } catch (e) {
        container.innerHTML = `<div style="color:#f87171;text-align:center;padding:40px;">加载失败: ${_tplEscapeHtml(e.message)}</div>`;
    }
}

function _updateTemplatePresetSelectionUI() {
    const modal = document.getElementById('template-library-modal');
    if (!modal || modal._onSelectCallback) return;
    const selected = modal._selectedTemplateIds || new Set();
    const visible = _tplMatchingIds(modal);
    const total = visible.length;
    const count = selected.size;
    const label = document.getElementById('tpl-selected-count');
    const allButton = document.getElementById('tpl-select-all-btn');
    const saveButton = document.getElementById('tpl-save-selected-presets-btn');
    const skillButton = document.getElementById('tpl-export-selected-skill-btn');
    const exportButton=document.getElementById('tpl-export-selected-btn');
    const exportAllButton=document.getElementById('tpl-export-all-btn');
    if(exportAllButton)exportAllButton.disabled=!!window._templateCollectionExporting;
    if(exportButton){exportButton.disabled=!count || !!window._templateCollectionExporting;exportButton.textContent=window._templateCollectionExporting?'正在导出…':`📤 导出选中工程（${count}）`;}
    if (label) label.textContent = `匹配 ${total} 个 · 已加载 ${_tplVisibleCards(modal).length} 个 · 已选 ${count} 个`;
    if (allButton) allButton.textContent = total && visible.every(id=>selected.has(id)) ? '☐ 取消当前全选' : '☑ 全选当前结果';
    if (saveButton) {
        saveButton.disabled = count === 0;
        saveButton.style.opacity = count ? '1' : '.48';
        saveButton.style.cursor = count ? 'pointer' : 'not-allowed';
    }
    if (skillButton) {
        skillButton.disabled = count === 0;
        skillButton.style.opacity = count ? '1' : '.48';
        skillButton.style.cursor = count ? 'pointer' : 'not-allowed';
        skillButton.textContent = count ? `⚡ 导出选中 Skill（${count}）` : '⚡ 导出选中 Skill';
    }
}

async function _exportTemplatesAsSkill(ids) {
    const targetIds = [...new Set((ids || []).filter(Boolean))];
    if (!targetIds.length) {
        if (typeof showToast === 'function') showToast('请先勾选要生成 Skill 的模板', 'warning');
        return;
    }
    if (!window.ReelsSkillExporter?.openForTemplates) {
        if (typeof showToast === 'function') showToast('Skill 导出模块尚未加载，请刷新后重试', 'warning');
        return;
    }
    const skillBtn = document.getElementById('tpl-export-selected-skill-btn');
    if (skillBtn) { skillBtn.disabled = true; skillBtn.textContent = '正在读取模板…'; }
    try {
        const loaded = [];
        for (const id of targetIds) {
            const resp = await apiFetch(`${API_BASE}/templates/get`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id }),
            });
            const parsed = await resp.json();
            const tpl = parsed.data || parsed;
            if (tpl && tpl.projectData) loaded.push(tpl);
        }
        if (!loaded.length) throw new Error('未能读取到有效的模板工程数据');
        window.ReelsSkillExporter.openForTemplates(loaded);
    } catch (error) {
        if (typeof showToast === 'function') showToast(`读取模板失败：${error.message}`, 'error');
    } finally {
        _updateTemplatePresetSelectionUI();
    }
}

async function tplExportSelectedSkills() {
    const modal = document.getElementById('template-library-modal');
    if (!modal || modal._onSelectCallback) return;
    const selected = [...(modal._selectedTemplateIds || [])];
    return _exportTemplatesAsSkill(selected);
}
window.tplExportSelectedSkills = tplExportSelectedSkills;

function tplSelectAllTemplates() {
    const modal = document.getElementById('template-library-modal');
    if (!modal || modal._onSelectCallback) return;
    const templates = _tplMatchingIds(modal).map(id=>({id}));
    const selected = modal._selectedTemplateIds || (modal._selectedTemplateIds = new Set());
    const selectAll = !templates.every(tpl=>selected.has(String(tpl.id)));
    templates.forEach(tpl=>{if(selectAll)selected.add(String(tpl.id));else selected.delete(String(tpl.id));});
    modal.querySelectorAll('.tpl-select-preset').forEach(box => { box.checked = selected.has(box.closest('.tpl-card').dataset.id); });
    _updateTemplatePresetSelectionUI();
}

async function tplSaveSelectedPresets() {
    const modal = document.getElementById('template-library-modal');
    if (!modal || modal._onSelectCallback) return;
    const selected = [...(modal._selectedTemplateIds || [])];
    if (!selected.length) return;
    const groupName = await (typeof _showInputDialog === 'function'
        ? _showInputDialog('预设保存分组', '例如：九月祷告、金色字幕', '我的预设')
        : Promise.resolve(prompt('输入预设分组名称：', '我的预设')));
    const category = String(groupName || '').trim();
    if (!category) return;
    if (!confirm(`将 ${selected.length} 个模板中的动态字幕和覆层分别保存到分组「${category}」？\n\n同名预设会自动重命名，不会修改原模板或已有预设。`)) return;

    const button = document.getElementById('tpl-save-selected-presets-btn');
    if (button) { button.disabled = true; button.textContent = '保存中…'; }
    let subtitles = 0, overlays = 0, failed = 0;
    for (const id of selected) {
        try {
            const resp = await apiFetch(`${API_BASE}/templates/get`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
            });
            const parsed = await resp.json();
            const template = parsed.data || parsed;
            if (!template?.projectData) throw new Error('模板工程数据不存在');
            const synced = _syncTemplatePresetAssets(template.name || id, template.projectData, category);
            if (synced.subtitle) subtitles++;
            if (synced.overlay) overlays++;
            if (synced.errors?.length) {
                failed++;
                console.warn('[Template] 部分预设未保存:', id, synced.errors);
            }
        } catch (error) {
            failed++;
            console.warn('[Template] 保存所选预设失败:', id, error);
        }
    }
    if (button) button.textContent = '💾 保存所选预设';
    _updateTemplatePresetSelectionUI();
    const message = `已保存到「${category}」：动态字幕 ${subtitles} 个、覆层 ${overlays} 个${failed ? `；${failed} 个失败` : ''}`;
    if (typeof showToast === 'function') showToast(message, failed ? 'warning' : 'success', 5000);
    else alert(message);
}

// ═══════════════════════════════════════════════════════
// 2. 保存当前工程为模板
// ═══════════════════════════════════════════════════════

/** 为队列生成稳定短编号；同一路径/标签在不同日期保存仍保持一致。 */
function _templateQueueShortId(value) {
    const input = String(value || 'queue').trim().toLowerCase().replace(/\\/g, '/');
    let hash = 2166136261;
    for (let i = 0; i < input.length; i++) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36).toUpperCase().padStart(7, '0').slice(-7);
}

function _templateQueueIdentityFromTasks(tasks) {
    const list = Array.isArray(tasks) ? tasks : [];
    const groupIds = [...new Set(list.map(t => t?._taskGroupId).filter(Boolean))];
    if (groupIds.length === 1) return `group:${groupIds[0]}`;
    const folderIds = [...new Set(list.map(t => t?._folderQueueId).filter(Boolean))];
    if (folderIds.length === 1) return `folder:${folderIds[0]}`;
    const tabIds = [...new Set(list.map(t => t?._batchTabId).filter(Boolean))];
    if (tabIds.length === 1) return `tab:${tabIds[0]}`;
    return '';
}

function _templateIdForQueue(baseName, queueIdentity) {
    return `tpl_queue_${_templateQueueShortId(`${baseName}|${queueIdentity}`)}`;
}

function _captureVisibleTemplateThumbnail() {
    let thumbnail = '';
    try {
        // V2 使用独立 Canvas。优先截取当前正在显示的预览，
        // 同时保留旧预览回退，避免已有模板流程受影响。
        const v2 = window.ReelsPreviewV2;
        const canvas = (v2?.isOpen?.() ? v2.getCanvas?.() : null)
            || document.getElementById('reels-preview-canvas');
        if (canvas) {
            // 按实际画布比例等比缩放生成缩略图（最长边不超过 480px，9:16 时保持 270×480）
            const srcW = Number(canvas.width) || 1080;
            const srcH = Number(canvas.height) || 1920;
            const scale = Math.min(1, 480 / Math.max(srcW, srcH));
            const thumbW = Math.max(1, Math.round(srcW * scale));
            const thumbH = Math.max(1, Math.round(srcH * scale));
            const thumbCanvas = document.createElement('canvas');
            thumbCanvas.width = thumbW;
            thumbCanvas.height = thumbH;
            const ctx = thumbCanvas.getContext('2d');
            ctx.drawImage(canvas, 0, 0, thumbW, thumbH);
            thumbnail = thumbCanvas.toDataURL('image/jpeg', 0.65);
        }
    } catch (e) {
        console.warn('[Template] 截图失败:', e);
    }
    return thumbnail;
}

async function _captureTemplateThumbnailForTasks(tasks, fallbackThumbnail = '') {
    const state = window._reelsState;
    if (!state || !Array.isArray(tasks) || tasks.length === 0) return fallbackThumbnail;
    const originalTasks = state.tasks;
    const originalSelectedIdx = state.selectedIdx;
    window._templateThumbnailCaptureActive = true;
    try {
        state.tasks = tasks;
        state.selectedIdx = -1;
        if (typeof reelsSelectTask === 'function') reelsSelectTask(0);
        else {
            state.selectedIdx = 0;
            if (typeof reelsUpdatePreview === 'function') reelsUpdatePreview();
        }
        // 等待图片/视频元数据和 Canvas 至少完成一次实际绘制。
        await new Promise(resolve => setTimeout(resolve, 450));
        return _captureVisibleTemplateThumbnail() || fallbackThumbnail;
    } catch (error) {
        console.warn('[Template] 队列独立截图失败:', error);
        return fallbackThumbnail;
    } finally {
        state.tasks = originalTasks;
        state.selectedIdx = -1;
        if (originalSelectedIdx >= 0 && originalSelectedIdx < originalTasks.length && typeof reelsSelectTask === 'function') {
            reelsSelectTask(originalSelectedIdx);
        } else {
            state.selectedIdx = originalSelectedIdx;
            if (typeof _renderTaskList === 'function') _renderTaskList();
        }
        window._templateThumbnailCaptureActive = false;
    }
}

async function _repairTemplateThumbnailsByIds(templateIds, options = {}) {
    const ids = [...new Set((templateIds || []).filter(Boolean))];
    if (!ids.length) return { repaired: 0, failed: 0 };
    const button = document.getElementById('tpl-repair-thumbnails-btn');
    const originalText = button?.textContent || '';
    if (button) button.disabled = true;
    let repaired = 0;
    let failed = 0;
    try {
        for (let i = 0; i < ids.length; i++) {
            if (button) button.textContent = `📸 ${i + 1}/${ids.length}`;
            try {
                const getResp = await apiFetch(`${API_BASE}/templates/get`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: ids[i] })
                });
                const getResult = await getResp.json();
                const tpl = getResult.data || getResult;
                const tasks = tpl?.projectData?.tasks || [];
                if (!tasks.length) throw new Error('模板没有任务');
                const thumbnail = await _captureTemplateThumbnailForTasks(tasks, tpl.thumbnail || '');
                if (!thumbnail) throw new Error('未能生成截图');
                const saveResp = await apiFetch(`${API_BASE}/templates/save`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: _templateSaveBody({
                        id: tpl.id,
                        name: tpl.name,
                        description: tpl.description || '',
                        tags: tpl.tags || [],
                        thumbnail,
                        projectData: tpl.projectData,
                    }),
                });
                const saveResult = await saveResp.json();
                if (!(saveResult.success || saveResult.data?.success)) throw new Error(saveResult.error || '保存失败');
                repaired++;
            } catch (error) {
                failed++;
                console.warn(`[Template] 修复模板封面失败 ${ids[i]}:`, error);
            }
        }
    } finally {
        if (button) {
            button.disabled = false;
            button.textContent = originalText || '📸 修复重复封面';
        }
        if (document.getElementById('template-library-modal')) _refreshTemplateList();
    }
    if (!options.silent && typeof showToast === 'function') {
        showToast(`已重新生成 ${repaired} 张模板封面${failed ? `，${failed} 张失败` : ''}`, failed ? 'warning' : 'success', 6000);
    }
    return { repaired, failed };
}

async function repairDuplicateTemplateThumbnails() {
    try {
        const resp = await apiFetch(`${API_BASE}/templates/list`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
        });
        const parsed = await resp.json();
        const templates = parsed.data || parsed || [];
        const byThumbnail = new Map();
        templates.forEach(tpl => {
            const key = String(tpl.thumbnail || '');
            if (!key) return;
            if (!byThumbnail.has(key)) byThumbnail.set(key, []);
            byThumbnail.get(key).push(tpl.id);
        });
        const duplicateIds = [...byThumbnail.values()].filter(group => group.length > 1).flat();
        if (!duplicateIds.length) {
            if (typeof showToast === 'function') showToast('没有检测到重复模板封面', 'info');
            return;
        }
        if (!confirm(`检测到 ${duplicateIds.length} 个模板共用了重复封面。\n\n是否逐模板重新生成独立截图？`)) return;
        await _repairTemplateThumbnailsByIds(duplicateIds);
    } catch (error) {
        if (typeof showToast === 'function') showToast(`修复模板封面失败：${error.message}`, 'error');
    }
}
window.repairDuplicateTemplateThumbnails = repairDuplicateTemplateThumbnails;
window._repairTemplateThumbnailsByIds = _repairTemplateThumbnailsByIds;

function _captureCurrentTemplatePayload(name) {
    // 截取当前 Canvas 预览作为缩略图
    const thumbnail = _captureVisibleTemplateThumbnail();

    // 用 ReelsProject.collectProjectData 序列化工程
    let projectData = {};
    try {
        if (typeof collectCurrentProjectState === 'function') {
            const state = collectCurrentProjectState();
            projectData = ReelsProject.collectProjectData(state);
        } else if (typeof ReelsProject !== 'undefined') {
            // 尝试直接收集
            projectData = ReelsProject.collectProjectData({
                tasks: window.reelsTasks || [],
                style: window.reelsGlobalStyle || {},
                exportOpts: window.reelsExportOpts || {},
                selectedIdx: window.reelsSelectedIdx || 0,
            });
        }
    } catch (e) {
        console.error('[Template] 工程序列化失败:', e);
        throw new Error('序列化工程失败: ' + e.message);
    }

    return {
        name,
        thumbnail,
        projectData,
    };
}

function _makeUniqueTemplatePresetName(baseName, existingNames) {
    const occupied = existingNames instanceof Set ? existingNames : new Set(existingNames || []);
    if (!occupied.has(baseName)) return baseName;
    let index = 2;
    let candidate = `${baseName}（${index}）`;
    while (occupied.has(candidate)) candidate = `${baseName}（${++index}）`;
    return candidate;
}

// 模板工程内的样式/覆层是快照；用户选择同步时，再生成可跨工程调用的独立预设。
// 同名不覆盖已有“我的预设”，而是自动创建带序号的新预设。
function _syncTemplatePresetAssets(templateName, projectData, category = '模板同步', selection = 'both') {
    const tasks = Array.isArray(projectData?.tasks) ? projectData.tasks : [];
    const result = { subtitle: false, overlay: false };
    // 与加载模板后的预览选择同一个任务，字幕与覆层不能各取不同任务。
    const selectedIdx = Number(projectData?.selectedIdx ?? projectData?.curr_idx ?? 0);
    const task = tasks[Number.isInteger(selectedIdx) && tasks[selectedIdx] ? selectedIdx : 0];
    const engine = window.ReelsStyleEngine;
    const subtitleData = engine?.loadSubtitlePresets?.() || {};
    const namedStyle = task?._subtitlePreset && subtitleData.presets?.[task._subtitlePreset];
    const opts = projectData?.exportOpts || {};
    const scope = opts.subtitleStyleScopeVersion === 2
        ? (opts.subtitleStyleScope || (opts.subtitleStyleApplyAll === true ? 'all' : 'folder'))
        : (opts.subtitleStyleApplyAll === true ? 'all' : 'folder');
    const applyAll = scope === 'all';
    const subtitleStyle = namedStyle
        || (applyAll ? projectData?.style : _templateTaskSubtitleStyle(task))
        || projectData?.style || null;
    if (selection !== 'overlay' && subtitleStyle && window.ReelsStyleEngine?.saveNamedSubtitlePreset) {
        const subtitleNames = new Set(Object.keys(subtitleData.presets || {}));
        const presetName = _makeUniqueTemplatePresetName(`${templateName} · 动态字幕`, subtitleNames);
        result.subtitle = window.ReelsStyleEngine.saveNamedSubtitlePreset(presetName, subtitleStyle, category);
        if (!result.subtitle) result.errors = ['动态字幕预设保存失败（预设数量已达上限或存储失败）'];
    }
    const sourceLayers = Array.isArray(task?.overlays) ? task.overlays : [];
    if (selection !== 'subtitle' && sourceLayers.length) {
        const order = Array.isArray(task.visualOverlayOrder) ? task.visualOverlayOrder : [];
        const keys = sourceLayers.map((layer, index) => `overlay:${layer.id || index}`);
        const stack = [...order.filter(key => keys.includes(key)), ...keys.filter(key => !order.includes(key))];
        const layers = sourceLayers.map((layer, index) => ({ layer, key: keys[index] }))
            .sort((a, b) => stack.indexOf(a.key) - stack.indexOf(b.key))
            .map(({ layer }) => JSON.parse(JSON.stringify(layer, (key, value) =>
                ['_img', '_imgLoaded', '_allOverlays', '_templateName'].includes(key) ? undefined : value)));
        // fixed_text 控制批量替换；保存仍需保留文本（含空值）和媒体路径。

        try {
            const key = 'reels_overlay_group_presets';
            const saved = JSON.parse(localStorage.getItem(key) || '{}');
            const layerTypes = [...new Set(layers.map(layer => ({ text:'纯文本', textcard:'文字卡片', scroll:'滚动字幕', image:'图片媒体', video:'视频媒体', solid_mask:'纯色蒙版' })[layer.type] || '其他覆层'))];
            const presetName = _makeUniqueTemplatePresetName(`${templateName} · 覆层`, new Set(Object.keys(saved)));
            saved[presetName] = { name:presetName, layers, updatedAt:new Date().toISOString(), meta:{ layerCount:layers.length, category, layerTypes, needsBatchText:layers.some(layer => !layer.fixed_text && ['text','textcard','scroll'].includes(layer.type)) } };
            localStorage.setItem(key, JSON.stringify(saved));
            result.overlay = true;
        } catch (error) {
            (result.errors ||= []).push(`覆层预设保存失败：${error.message}`);
            console.warn('[Template] 同步覆层预设失败:', error);
        }
    }
    return result;
}

function _templateTaskSubtitleStyle(task) {
    for (const style of [task?.subtitleStyle, task?.subtitle_style, task?.style]) {
        if (style && typeof style === 'object' && Object.keys(style).length) return style;
    }
    return null;
}

function _templateSaveBody(payload) {
    const assets=window.ReelsProjectAssets;
    return JSON.stringify(assets && payload.projectData
        ? {...payload,projectData:assets.encode(payload.projectData)} : payload);
}

function _collectTemplateSaveGroups(tasks, batchTable = null) {
    const visibleGroups = new Map();
    for (const task of tasks || []) {
        let id = 'legacy', name = '已有任务（未归档）';
        if (task._taskGroupId) {
            id = `group:${task._taskGroupId}`;
            name = task._taskGroupName || '未命名分组';
        } else if (task._folderQueueId) {
            id = `folder:${task._folderQueueId}`;
            name = task._folderQueueName || '文件夹队列';
        } else if (task._batchTabId) {
            id = `tab:${task._batchTabId}`;
            name = task._batchTabName || '未命名分组';
        }
        if (!visibleGroups.has(id)) visibleGroups.set(id, { id, name, tasks: [] });
        visibleGroups.get(id).tasks.push(task);
    }
    if (visibleGroups.size > 1) return Array.from(visibleGroups.values());
    const tabs = (batchTable?.tabs || []).filter(tab => tab.tasks?.length);
    // 单个标签页内仍可包含多个账号/任务组，按实际分组继续拆分。
    if (tabs.length > 1) return tabs.flatMap(tab => {
        const groups = _collectTemplateSaveGroups(tab.tasks);
        return groups.length > 1 ? groups : [{ ...tab, isActive: tab.id === batchTable.activeTabId }];
    });
    return Array.from(visibleGroups.values());
}

function _chooseTemplateGroupSaveMode(groups) {
    return new Promise(resolve => {
        const modal = document.createElement('div');
        modal.id = 'tpl-group-save-dialog';
        modal.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.65);display:flex;align-items:center;justify-content:center;';
        const total = groups.reduce((sum, group) => sum + group.tasks.length, 0);
        modal.innerHTML = `<div role="dialog" aria-modal="true" aria-labelledby="tpl-group-save-title" style="width:520px;max-width:92vw;max-height:80vh;overflow:auto;background:#20212b;border:1px solid #444;border-radius:10px;padding:18px;color:#ddd;">
            <strong id="tpl-group-save-title">保存多个任务组</strong>
            <p>当前包含 ${groups.length} 个任务组，共 ${total} 条任务。请选择保存方式：</p>
            <div style="max-height:220px;overflow:auto;margin-bottom:14px;">${groups.map(group => `<div style="padding:5px 0;">${_tplEscapeHtml(group.name || '未命名分组')} · ${group.tasks.length} 条任务</div>`).join('')}</div>
            <p style="font-size:12px;color:#aaa;">一个模板工程中仍分别保留各任务组，加载后按组显示，并保留组名、顺序和独立设置；分别保存则每个任务组生成一个模板。</p>
            <div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;">
                <button class="btn btn-secondary" data-mode="cancel">取消</button>
                <button class="btn btn-secondary" data-mode="separate">按组分别保存</button>
                <button class="btn btn-primary" data-mode="combined">保存为一个模板（保留分组）</button>
            </div>
        </div>`;
        const finish = mode => { modal.remove(); resolve(mode); };
        modal.querySelectorAll('[data-mode]').forEach(button => { button.onclick = () => finish(button.dataset.mode); });
        modal.onkeydown = event => { if (event.key === 'Escape') finish('cancel'); };
        document.body.appendChild(modal);
        modal.querySelector('[data-mode="combined"]').focus();
    });
}

function _collectCombinedTemplateProject(baseProject, groups) {
    const tasks = groups.flatMap((group, groupIndex) => group.tasks.map(task => {
        // 每组保存明确的任务组身份。文件夹队列即使共用一个标签，也不能
        // 在加载时被外部列表当成同一个任务组。
        const groupedTask = { ...task,
            _taskGroupId: task._taskGroupId || `template-group:${group.id || groupIndex}`,
            _taskGroupName: task._taskGroupName || group.name || '未命名分组',
        };
        if (Object.prototype.hasOwnProperty.call(group, 'isActive')) {
            groupedTask._batchTabId = group.id;
            groupedTask._batchTabName = group.name;
        }
        return groupedTask;
    }));
    tasks.forEach((task, index) => { task._taskGroupOrder = index; });
    const batchTable = baseProject.batchTable ? { ...baseProject.batchTable,
        appliedTabIds: [...new Set(tasks.map(task => task._batchTabId).filter(Boolean))],
    } : null;
    return ReelsProject.collectProjectData({ ...baseProject, batchTable, tasks, selectedIdx: tasks.length ? 0 : -1 });
}

function _defaultTemplateSaveName(templates, now = new Date()) {
    const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const prefix = day + '_';
    let last = 0;
    for (const template of templates) {
        const name = String(template.name || '');
        if (!name.startsWith(prefix)) continue;
        // 分组保存会追加组名和队列编号，也应占用这次保存的编号。
        const match = name.slice(prefix.length).match(/^(\d+)(?:$|[_\s])/);
        const number = match ? Number(match[1]) : 0;
        if (Number.isSafeInteger(number)) last = Math.max(last, number);
    }
    return prefix + String(last + 1).padStart(2, '0');
}

let _projectSnapshotSaving=false;
function _defaultProjectSnapshotName(templates,date=VideoKitLocalTime.format().slice(0,10)){
    const base=`${date} 工程`;let last=0;
    for(const entry of templates){
        const name=String(entry.name || '').trim();
        if(!name.startsWith(base))continue;
        const match=name.slice(base.length).match(/^[-_ ](\d+)$/);
        if(match && Number.isSafeInteger(Number(match[1])))last=Math.max(last,Number(match[1]));
    }
    return `${base}-${last+1}`;
}

async function saveProjectSnapshot(kind='project'){
    if(_projectSnapshotSaving)return;
    _projectSnapshotSaving=true;let unsubscribe;
    try{
        const title=kind==='package'?'打包完整工程':'保存工程快照';
        const response=await apiFetch(`${API_BASE}/templates/list`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
        const listResult=await response.json(),templates=listResult.data || listResult;
        if(!Array.isArray(templates))throw new Error(listResult.error || '工程列表读取失败，无法生成编号');
        const defaultName=_defaultProjectSnapshotName(templates);
        const name=await (typeof _showInputDialog==='function'?_showInputDialog(title,'',defaultName):prompt(title,defaultName));
        if(!name?.trim())return;
        let outputPath;
        if(kind==='package'){
            if(!window.electronAPI?.saveFile)throw new Error('请在桌面版打包工程');
            const chosen=await window.electronAPI.saveFile({title:'保存完整工程包',defaultPath:name.trim().replace(/[\\/:*?"<>|]/g,'_')+'.vkpkg',filters:[{name:'VideoKit 完整工程包',extensions:['vkpkg']}]});
            if(chosen.canceled || !chosen.filePath)return;outputPath=chosen.filePath;
        }
        if(typeof _syncTasksToActiveTab==='function')_syncTasksToActiveTab();
        const payload=_captureCurrentTemplatePayload(name.trim());payload.projectData=_allTasksSnapshot(payload.projectData);
        if(!payload.projectData.tasks?.length)throw new Error('当前没有可保存的任务');
        payload.kind=kind;payload.assetCollection={status:'not-collected'};
        showToast(`正在${title} · ${payload.projectData.tasks.length} 个任务…`,'info');
        const requestId='project-package-'+Date.now();
        unsubscribe=window.electronAPI?.onTemplatePackageProgress?.(event=>{if(event.request_id===requestId)showToast(event.message || '正在打包…','info');});
        const resp=await apiFetch(`${API_BASE}/templates/${kind==='package'?'package-project':'save'}`,{method:'POST',headers:{'Content-Type':'application/json'},body:_templateSaveBody({...payload,outputPath,request_id:requestId})});
        const parsed=await resp.json(),result=parsed.data || parsed;
        if(result.error || result.success===false)throw new Error(result.error || '保存失败');
        if(result.id)_setCurrentTemplateContext(result.id,payload.name);
        const missing=result.assetCollection?.missing || [];
        showToast(missing.length?`工程包已保存，但有 ${missing.length} 个素材缺失；模板卡片已标记收集不完整`:`${title}成功 · ${payload.projectData.tasks.length} 个任务`,missing.length?'warning':'success');
        _refreshTemplateList();
        if(result.zip_path)window.electronAPI?.showItemInFolder?.(result.zip_path);
    }catch(error){showToast('保存失败：'+error.message,'error');}
    finally{unsubscribe?.();_projectSnapshotSaving=false;}
}
function _chooseStylePresetKind(){
    return new Promise(resolve=>{
        const modal=document.createElement('div');modal.className='modal';modal.style.cssText='display:flex;position:fixed;inset:0;z-index:30000;align-items:center;justify-content:center;background:#0009';
        modal.innerHTML='<div style="background:#252735;color:#eee;padding:24px;border-radius:12px"><h3>保存样式预设</h3><p>保存当前选中任务的效果到对应预设库，不保存整批任务。</p><button data-kind="overlay">仅覆层</button> <button data-kind="subtitle">仅动态字幕</button> <button data-kind="both">两者都保存</button> <button data-kind="cancel">取消</button></div>';
        const finish=kind=>{modal.remove();resolve(kind);};
        modal.querySelectorAll('[data-kind]').forEach(button=>button.onclick=()=>finish(button.dataset.kind));
        modal.onkeydown=event=>{if(event.key==='Escape')finish('cancel');};document.body.appendChild(modal);modal.querySelector('button').focus();
    });
}
async function saveCurrentStylePreset(){
    const selection=await _chooseStylePresetKind();if(selection==='cancel')return;
    const name=await (typeof _showInputDialog==='function'?_showInputDialog('预设名称','','我的样式'):prompt('预设名称','我的样式'));if(!name?.trim())return;
    const state=window._reelsState || {},settings=typeof collectCurrentProjectSettings==='function'?collectCurrentProjectSettings():{};
    const result=_syncTemplatePresetAssets(name.trim(),{tasks:state.tasks || [],selectedIdx:state.selectedIdx,...settings},'我的预设',selection);
    if(result.errors?.length){showToast(result.errors.join('；'),'error');return;}
    showToast(result.subtitle || result.overlay?'已保存到'+[result.overlay?'覆层预设库':'',result.subtitle?'动态字幕预设库':''].filter(Boolean).join('和'):'当前任务没有可保存的所选样式',result.subtitle || result.overlay?'success':'warning');
}
async function showTemplateVersions(id,name){
    try{
        const versions=await _tplLibraryApi('versions',{id});
        const modal=document.createElement('div');modal.className='modal';modal.style.cssText='display:flex;position:fixed;inset:0;z-index:30000;align-items:center;justify-content:center;background:#0009';
        modal.innerHTML=`<div style="background:#252735;color:#eee;padding:24px;border-radius:12px;max-height:80vh;overflow:auto"><h3>${_tplEscapeHtml(name)} · 覆盖前的版本</h3><p>恢复前也会保留当前版本。${versions.length?'':'暂无历史版本；新覆盖操作会自动备份。'}</p>${versions.map((v,i)=>`<p>${_tplEscapeHtml(v.at || v.revision)} · ${v.taskCount} 个任务 <button data-revision="${i}">恢复此版本</button></p>`).join('')}<button data-close>关闭</button></div>`;
        modal.querySelector('[data-close]').onclick=()=>modal.remove();
        modal.querySelectorAll('[data-revision]').forEach(button=>button.onclick=async()=>{
            const version=versions[Number(button.dataset.revision)];if(!confirm(`恢复为 ${version.taskCount} 个任务的版本？当前版本会先备份。`))return;
            button.disabled=true;try{await _tplLibraryApi('restore-version',{id,revision:version.revision});modal.remove();_refreshTemplateList();showToast('版本已恢复，可重新打开工程','success');}catch(error){showToast(error.message,'error');button.disabled=false;}
        });document.body.appendChild(modal);
    }catch(error){showToast(error.message,'error');}
}

async function saveCurrentAsTemplate() {
    let defaultName;
    try {
        const response = await apiFetch(`${API_BASE}/templates/list`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        const result = await response.json();
        const templates = result.data || result;
        if (!Array.isArray(templates)) throw new Error(result.error || '工程列表读取失败');
        defaultName = _defaultTemplateSaveName(templates);
    } catch (error) {
        showToast(`无法生成默认工程名称：${error.message}`, 'error');
        return;
    }
    const name = await (typeof _showInputDialog === 'function' ? _showInputDialog('请输入模板名称', '', defaultName) : prompt('请输入模板名称：', defaultName));
    if (!name || !name.trim()) return;
    const syncPresetAssets = confirm('是否同时同步保存独立预设？\n\n“是”：把模板内的动态字幕样式和覆层分别保存为同名独立预设。\n“否”：仅保存模板工程。');

    try {
        const baseName = name.trim();
        if (typeof _syncTasksToActiveTab === 'function') _syncTasksToActiveTab();
        const basePayload = _captureCurrentTemplatePayload(baseName);
        const groups = _collectTemplateSaveGroups(
            window._reelsState?.tasks || [],
            typeof _batchTableState !== 'undefined' ? _batchTableState : null,
        );

        const saveMode = groups.length > 1 ? await _chooseTemplateGroupSaveMode(groups) : 'single';
        if (saveMode === 'cancel') return;
        if (saveMode === 'combined') {
            basePayload.projectData = _collectCombinedTemplateProject(basePayload.projectData, groups);
        }

        if (saveMode === 'separate') {
            let saved = 0;
            let syncedSubtitle = 0, syncedOverlay = 0;
            const failed = [];
            const usedNames = new Map();

            for (let index = 0; index < groups.length; index++) {
                const group = groups[index];
                const rawGroupName = String(group.name || `分组${index + 1}`).trim() || `分组${index + 1}`;
                const seenCount = (usedNames.get(rawGroupName) || 0) + 1;
                usedNames.set(rawGroupName, seenCount);
                const groupName = seenCount > 1 ? `${rawGroupName}_${seenCount}` : rawGroupName;
                const queueIdentity = group.id || _templateQueueIdentityFromTasks(group.tasks) || `group:${index}`;
                const queueShortId = _templateQueueShortId(queueIdentity);
                const templateName = `${baseName}_${groupName} [Q-${queueShortId}]`;
                const stableTemplateId = _templateIdForQueue(baseName, queueIdentity);
                const projectData = ReelsProject.collectProjectData({
                    tasks: group.tasks,
                    backgroundLibrary: basePayload.projectData.backgroundLibrary || [],
                    style: _templateTaskSubtitleStyle(group.tasks[0]) || basePayload.projectData.style || {},
                    exportOpts: basePayload.projectData.exportOpts || {},
                    selectedIdx: group.tasks.length ? 0 : -1,
                });

                try {
                    const groupThumbnail = await _captureTemplateThumbnailForTasks(group.tasks, basePayload.thumbnail);
                    const resp = await apiFetch(`${API_BASE}/templates/save`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: _templateSaveBody({
                            id: stableTemplateId,
                            name: templateName,
                            // 账号队列拆分保存时，当前预览画面可作为本次保存的可见缩略图。
                            // 之前只给“激活标签”写缩略图，队列分组 ID 与标签 ID 不同，
                            // 导致所有新模板都显示为空白场记板。
                            thumbnail: groupThumbnail,
                            projectData,
                        }),
                    });
                    const result = await resp.json();
                    if (!(result.success || result.data?.success)) {
                        throw new Error(result.error || '保存失败');
                    }
                    if (syncPresetAssets) {
                        const synced = _syncTemplatePresetAssets(templateName, projectData);
                        if (synced.subtitle) syncedSubtitle++;
                        if (synced.overlay) syncedOverlay++;
                    }
                    saved++;
                } catch (e) {
                    failed.push(`${groupName}: ${e.message}`);
                }
            }

            if (!saved) throw new Error(failed.join('；') || '所有分组保存失败');
            _setCurrentTemplateContext('', '');
            if (typeof showToast === 'function') {
                showToast(
                    `已按分组保存 ${saved} 个模板${syncPresetAssets ? `；同步字幕 ${syncedSubtitle} 个、覆层 ${syncedOverlay} 个` : ''}${failed.length ? `，${failed.length} 个失败` : ''} ✅`,
                    failed.length ? 'warning' : 'success'
                );
            }
            if (failed.length) console.warn('[Template] 分组模板保存失败:', failed);
            _refreshTemplateList();
            return;
        }

        const payload = basePayload;
        const singleQueueIdentity = saveMode === 'combined' ? '' : _templateQueueIdentityFromTasks(window._reelsState?.tasks || []);
        if (singleQueueIdentity) {
            const queueShortId = _templateQueueShortId(singleQueueIdentity);
            payload.name = `${baseName} [Q-${queueShortId}]`;
            payload.id = _templateIdForQueue(baseName, singleQueueIdentity);
        }
        const resp = await apiFetch(`${API_BASE}/templates/save`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: _templateSaveBody(payload),
        });
        const result = await resp.json();
        if (!(result.success || result.data?.success)) throw new Error(result.error || '保存失败');
        const synced = syncPresetAssets ? _syncTemplatePresetAssets(payload.name || baseName, payload.projectData) : { subtitle:false, overlay:false };

        const savedId = result.id || result.data?.id || '';
        if (savedId) _setCurrentTemplateContext(savedId, payload.name || baseName);
        if (typeof showToast === 'function') showToast(`模板「${payload.name || baseName}」已保存${syncPresetAssets ? `；已同步${synced.subtitle ? '动态字幕' : ''}${synced.subtitle && synced.overlay ? '、' : ''}${synced.overlay ? '覆层预设' : ''}` : ''} ✅`, 'success');
        _refreshTemplateList();
    } catch (e) {
        if (typeof showToast === 'function') showToast('保存模板失败: ' + e.message, 'error');
    }
}

async function updateCurrentTemplate() {
    const target = _templateUpdateTarget || _currentTemplateContext;
    if (!target.id) {
        if (typeof showToast === 'function') showToast('请先点击要更新的模板，再点更新选中模板', 'warning');
        else alert('请先点击要更新的模板，再点更新选中模板');
        return;
    }

    const name = target.name || target.id;
    if (!confirm(`确定用当前工程覆盖模板「${name}」？`)) return;

    try {
        if(typeof _syncTasksToActiveTab==='function')_syncTasksToActiveTab();
        const payload = _captureCurrentTemplatePayload(name);
        payload.projectData=_allTasksSnapshot(payload.projectData);
        payload.kind='project';payload.assetCollection={status:'not-collected'};
        const resp = await apiFetch(`${API_BASE}/templates/save`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: _templateSaveBody({
                ...payload,
                id: target.id,
            }),
        });
        const result = await resp.json();
        if (result.success || result.data?.success) {
            if (typeof showToast === 'function') showToast(`模板「${name}」已更新 ✅`, 'success');
            _refreshTemplateList();
        } else {
            throw new Error(result.error || '更新失败');
        }
    } catch (e) {
        if (typeof showToast === 'function') showToast('更新模板失败: ' + e.message, 'error');
        else alert('更新模板失败: ' + e.message);
    }
}

// ═══════════════════════════════════════════════════════
// 3. 打开模板（新窗口 / 当前窗口）
// ═══════════════════════════════════════════════════════

async function _openTemplateInWindow(templateId, templateName) {
    if (window.electronAPI?.openTemplateWindow) {
        try {
            const result = await window.electronAPI.openTemplateWindow(templateId, templateName);
            if (result?.reused) {
                if (typeof showToast === 'function') showToast(`模板「${templateName}」窗口已聚焦`, 'info');
            }
        } catch (e) {
            console.error('[Template] 打开窗口失败:', e);
            // Fallback: 当前窗口加载
            _loadTemplateInCurrentWindow(templateId);
        }
    } else {
        // 浏览器模式：当前窗口加载
        _loadTemplateInCurrentWindow(templateId);
    }
}

async function _appendTemplateInCurrentWindow(templateId) {
    try {
        const resp = await apiFetch(`${API_BASE}/templates/get`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: templateId }),
        });
        const result = await resp.json();
        const tplData = result.data || result;
        if (!tplData.projectData || typeof ReelsProject === 'undefined') throw new Error('模板工程数据不可用');
        const restored = ReelsProject.applyProjectData(tplData.projectData);
        if (!restored.tasks?.length) throw new Error('模板中没有可追加的任务');
        const state = window._reelsState;
        if (!state) throw new Error('请先打开批量 Reels');
        if (typeof _syncCurrentOverlayEditorToSelectedTask === 'function') _syncCurrentOverlayEditorToSelectedTask();
        if (typeof _syncTasksToActiveTab === 'function') _syncTasksToActiveTab();
        const startIndex = state.tasks.length;
        for (const task of restored.tasks) {
            // Repeated appends must create independent tasks rather than reuse
            // saved IDs or the template's original group membership.
            delete task.id;
            delete task._batchTabId;
            delete task._batchTabName;
            delete task._batchTaskOrder;
            delete task._batchProjection;
            if (typeof _ensureTaskId === 'function') _ensureTaskId(task);
            state.tasks.push(task);
            window.reelsArchiveTaskToActiveBatchTab?.(task);
        }
        if (typeof _ensureBackgroundLibraryFromTasks === 'function') _ensureBackgroundLibraryFromTasks();
        if (typeof _syncTasksToActiveTab === 'function') _syncTasksToActiveTab();
        if (typeof _renderTaskList === 'function') _renderTaskList();
        if (typeof _renderBatchTable === 'function') {
            if (typeof _skipNextApply !== 'undefined') _skipNextApply = true;
            _renderBatchTable();
        }
        if (startIndex === 0 && typeof reelsSelectTask === 'function') reelsSelectTask(0);
        if (typeof _batchAutoSave === 'function') _batchAutoSave();
        const modal = document.getElementById('template-library-modal');
        if (modal) modal.style.display = 'none';
        if (typeof openPanelByName === 'function') openPanelByName('batch-reels');
        if (typeof showToast === 'function') showToast(`已追加模板「${tplData.name || ''}」的 ${restored.tasks.length} 个任务`, 'success');
    } catch (error) {
        if (typeof showToast === 'function') showToast('追加模板失败: ' + error.message, 'error');
    }
}

async function _loadTemplateInCurrentWindow(templateId) {
    try {
        const resp = await apiFetch(`${API_BASE}/templates/get`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: templateId }),
        });
        const result = await resp.json();
        const tplData = result.data || result;

        if (tplData.projectData && typeof ReelsProject !== 'undefined') {
            // ── 诊断日志：模板加载数据追踪 ──
            const rawTasks = tplData.projectData.tasks || [];
            console.log(`[Template] 📦 原始模板数据: ${rawTasks.length} 个任务`);
            rawTasks.forEach((t, i) => {
                const ovCount = (t.overlays || []).length;
                const segCount = (t.segments || []).length;
                const coverOvCount = (t.cover?.overlays || []).length;
                console.log(`  [${i}] overlays=${ovCount}, segments=${segCount}, cover.overlays=${coverOvCount}, txtContent=${(t.txtContent || '').slice(0, 30)}`);
            });

            const restored = ReelsProject.applyProjectData(tplData.projectData);

            console.log(`[Template] 🔄 反序列化后: ${restored.tasks.length} 个任务`);
            restored.tasks.forEach((t, i) => {
                const ovCount = (t.overlays || []).length;
                const segCount = (t.segments || []).length;
                const coverOvCount = (t.cover?.overlays || []).length;
                console.log(`  [${i}] overlays=${ovCount}, segments=${segCount}, cover.overlays=${coverOvCount}`);
            });

            if (typeof applyRestoredProject === 'function') {
                applyRestoredProject(restored);
            }

            console.log(`[Template] ✅ applyRestoredProject 完成后:`);
            (_reelsState?.tasks || []).forEach((t, i) => {
                const ovCount = (t.overlays || []).length;
                const segCount = (t.segments || []).length;
                const coverOvCount = (t.cover?.overlays || []).length;
                console.log(`  [${i}] overlays=${ovCount}, segments=${segCount}, cover.overlays=${coverOvCount}`);
            });
            _setCurrentTemplateContext(tplData.id || templateId, tplData.name || '');
            if (typeof showToast === 'function') showToast(`模板「${tplData.name}」已加载`, 'success');

            // 关闭模板库面板
            const modal = document.getElementById('template-library-modal');
            if (modal) modal.style.display = 'none';

            // 自动切换到批量 Reels 标签页
            if (typeof openPanelByName === 'function') {
                openPanelByName('batch-reels');
            }
        }
    } catch (e) {
        if (typeof showToast === 'function') showToast('加载模板失败: ' + e.message, 'error');
    }
}

// ═══════════════════════════════════════════════════════
// 4. 删除 / 重命名
// ═══════════════════════════════════════════════════════

async function _deleteTemplate(id, name) {
    if (!confirm(`确定删除模板「${name}」？此操作不可恢复。`)) return;

    try {
        await apiFetch(`${API_BASE}/templates/delete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id }),
        });
        if (_currentTemplateContext.id === id) {
            _setCurrentTemplateContext('', '');
        }
        if (typeof showToast === 'function') showToast(`模板「${name}」已删除`, 'success');
        _refreshTemplateList();
    } catch (e) {
        if (typeof showToast === 'function') showToast('删除失败: ' + e.message, 'error');
    }
}

async function _renameTemplate(id) {
    const newName = await (typeof _showInputDialog === 'function' ? _showInputDialog('请输入新名称', '') : prompt('请输入新名称：'));
    if (!newName || !newName.trim()) return;

    try {
        await apiFetch(`${API_BASE}/templates/rename`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, name: newName.trim() }),
        });
        if (_currentTemplateContext.id === id) {
            _setCurrentTemplateContext(id, newName.trim());
        }
        if (typeof showToast === 'function') showToast('已重命名', 'success');
        _refreshTemplateList();
    } catch (e) {
        if (typeof showToast === 'function') showToast('重命名失败: ' + e.message, 'error');
    }
}

// ═══════════════════════════════════════════════════════
// 4b. 导入 / 导出模板文件
// ═══════════════════════════════════════════════════════

/**
 * 导出模板为 .vktpl 文件
 */
async function _exportTemplate(id, name) {
    try {
        const resp = await apiFetch(`${API_BASE}/templates/get`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id }),
        });
        const result = await resp.json();
        const tplData = result.data || result;

        // 导出完整数据（含缩略图）
        const exportObj = {
            _format: 'videokit-template',
            _version: 1,
            name: tplData.name,
            description: tplData.description || '',
            thumbnail: tplData.thumbnail || '',
            tags: tplData.tags || [],
            createdAt: tplData.createdAt,
            projectData: tplData.projectData,
        };

        const jsonStr = JSON.stringify(window.ReelsProjectAssets ? {...exportObj,projectData:window.ReelsProjectAssets.encode(exportObj.projectData)} : exportObj, null, 2);
        const blob = new Blob([jsonStr], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${name || 'template'}.vktpl`;
        a.click();
        URL.revokeObjectURL(url);

        if (typeof showToast === 'function') showToast(`模板「${name}」已导出`, 'success');
    } catch (e) {
        if (typeof showToast === 'function') showToast('导出失败: ' + e.message, 'error');
        else alert('导出失败: ' + e.message);
    }
}

/**
 * 打包导出模板及关联的本地素材 (归档)
 */
async function _exportArchiveTemplate(id,name){
    let unsubscribe;
    try{
        const api=window.electronAPI;if(!api?.saveFile)throw new Error('请在桌面版打包工程');
        const chosen=await api.saveFile({title:'打包完整工程',defaultPath:(name || '工程').replace(/[\\/:*?"<>|]/g,'_')+'.vkpkg',filters:[{name:'VideoKit 完整工程包',extensions:['vkpkg']}]});
        if(chosen.canceled || !chosen.filePath)return;
        const requestId='existing-package-'+Date.now();
        unsubscribe=api.onTemplatePackageProgress?.(event=>{if(event.request_id===requestId)showToast(event.message || '正在打包…','info');});
        showToast('正在收集素材并打包…','info');
        const result=await _tplLibraryApi('package-project',{id,outputPath:chosen.filePath,request_id:requestId});
        const missing=result.assetCollection?.missing || [];
        showToast(missing.length?`工程包已保存，但有 ${missing.length} 个素材缺失；已标记收集不完整`:'完整工程包已保存，并已加入工程库',missing.length?'warning':'success');
        _refreshTemplateList();api.showItemInFolder?.(result.zip_path);
    }catch(error){showToast('打包失败：'+error.message,'error');}finally{unsubscribe?.();}
}

/**
 * 导入 .vktpl 或 .vkpkg 模板文件
 */
async function _importTemplate() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.vktpl,.json,.vkpkg';
    input.multiple = true;
    input.onchange = async (e) => {
        const files = Array.from(e.target.files);
        if (files.length === 0) return;

        let imported = 0;
        for (const file of files) {
            if (file.name.endsWith('.vkpkg')) {
                const filePath = window.electronAPI ? window.electronAPI.getFilePath(file) : '';
                if (!filePath) {
                    if (typeof showToast === 'function') showToast(`跳过 ${file.name}: 无法获取本地路径`, 'warning');
                    continue;
                }
                try {
                    if (typeof showToast === 'function') showToast(`正在导入归档包 ${file.name}...`, 'info');
                    const resp = await apiFetch(`${API_BASE}/templates/import-archive`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ zip_path: filePath }),
                    });
                    const result = await resp.json();
                    const archiveResult=result.data || result;
                    if(archiveResult.count)imported+=archiveResult.count;
                    else if(archiveResult.id)imported++;
                } catch (err) {
                    if (typeof showToast === 'function') showToast(`导入失败 ${file.name}: ` + err.message, 'error');
                }
                continue;
            }

            try {
                const filePath=window.electronAPI?.getFilePath(file);
                if(filePath){
                    showToast(`正在后台读取并校验 ${file.name}…`,'info');
                    const result=await _tplLibraryApi('import-collection',{filePath});
                    imported+=result.count-(result.presetIds?.length || 0);
                    const completed=[];
                    for(const id of result.presetIds || []){
                        const preset=await _tplLibraryApi('get',{id});
                        const synced=_syncTemplatePresetAssets(preset.name,preset.projectData,preset.category || '导入预设',preset.projectData.presetSelection || 'both');
                        if(!synced.errors?.length && (synced.overlay || synced.subtitle)){completed.push(id);imported++;}
                        else showToast(`${preset.name}：${synced.errors?.join('；') || '没有可导入的样式'}，已保留在库中供检查`,'warning');
                    }
                    if(completed.length)await _tplLibraryApi('remove-imported-presets',{ids:completed});
                    continue;
                }
                if(file.size>64*1024*1024)throw new Error('大文件请使用桌面版后台导入');
                const text = await file.text();
                const data = JSON.parse(text);

                // 校验是否为合集
                const templatesToImport = [];
                if (data._format === 'videokit-template-collection' && Array.isArray(data.templates)) {
                    templatesToImport.push(...data.templates);
                } else if (data.projectData) {
                    templatesToImport.push(data);
                } else {
                    if (typeof showToast === 'function') showToast(`跳过 ${file.name}: 不是有效的模板文件`, 'warning');
                    else alert(`跳过 ${file.name}: 不是有效的模板文件`);
                    continue;
                }

                for (const tpl of templatesToImport) {
                    const resp = await apiFetch(`${API_BASE}/templates/save`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: _templateSaveBody({
                            name: tpl.name || file.name.replace(/\.(vktpl|json)$/i, ''),
                            description: tpl.description || '',
                            thumbnail: tpl.thumbnail || '',
                            tags: tpl.tags || [],
                            projectData: tpl.projectData,
                        }),
                    });
                    const result = await resp.json();
                    if (result.success || result.data?.success) {
                        imported++;
                    }
                }
            } catch (err) {
                console.error(`[Template] 导入 ${file.name} 失败:`, err);
                if (typeof showToast === 'function') showToast(`导入 ${file.name} 失败: ${err.message}`, 'error');
                else alert(`导入 ${file.name} 失败: ${err.message}`);
            }
        }

        if (imported > 0) {
            if (typeof showToast === 'function') showToast(`成功导入 ${imported} 个模板 ✅`, 'success');
            else alert(`成功导入 ${imported} 个模板 ✅`);
            _refreshTemplateList();
        }
    };
    input.click();
}

/**
 * 一键导出所有模板
 */
function _chooseTemplateExportMode(count){
    return new Promise(resolve=>{
        const modal=document.createElement('div');
        modal.style.cssText='position:fixed;inset:0;z-index:100101;background:#000a;display:flex;align-items:center;justify-content:center';
        modal.innerHTML=`<div role="dialog" aria-modal="true" aria-labelledby="tpl-export-mode-title" style="width:540px;max-width:92vw;max-height:90vh;overflow:auto;background:#252735;color:#eee;padding:24px;border-radius:12px">
            <h3 id="tpl-export-mode-title">导出 ${count} 个工程 · 选择模式</h3>
            <label style="display:block;padding:12px 0"><input type="radio" name="tpl-export-mode" value="project" checked> 工程快照（默认）<small style="display:block;margin:6px 0 0 24px;color:#b6bdce">保留全部任务、文案和编辑效果，保留素材引用，不额外收集外部素材。旧工程中已内嵌的图片仍会保留。</small></label>
            <label style="display:block;padding:12px 0"><input type="radio" name="tpl-export-mode" value="preset"> 样式预设<small style="display:block;margin:6px 0 0 24px;color:#b6bdce">每个工程提取保存时所选任务的样式，不包含整批任务、表格或背景视频。覆层自带的文字、贴图和画刷会保留；外部文件仍需原路径可用。</small></label>
            <div style="margin-left:24px">预设内容：<select data-preset-selection><option value="both">覆层和动态字幕</option><option value="overlay">仅覆层</option><option value="subtitle">仅动态字幕</option></select></div>
            <label style="display:block;padding:12px 0"><input type="radio" name="tpl-export-mode" value="package"> 完整工程包（含素材）<small style="display:block;margin:6px 0 0 24px;color:#b6bdce">收集工程引用的素材，便于换电脑恢复。多个工程放在一个包中，素材缺失时标记收集不完整。文件可能较大，耗时更长。</small></label>
            <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:16px"><button data-cancel>取消</button><button data-continue>选择保存位置</button></div>
        </div>`;
        const finish=value=>{modal.remove();resolve(value);};
        modal.querySelector('[data-cancel]').onclick=()=>finish(null);
        modal.querySelector('[data-continue]').onclick=()=>finish({mode:modal.querySelector('input:checked').value,presetSelection:modal.querySelector('[data-preset-selection]').value});
        const select=modal.querySelector('select');select.disabled=true;
        modal.querySelectorAll('input').forEach(input=>input.onchange=()=>{select.disabled=modal.querySelector('input:checked').value!=='preset';});
        modal.onkeydown=event=>{if(event.key==='Escape')finish(null);};
        document.body.appendChild(modal);modal.querySelector('[data-continue]').focus();
    });
}
async function _exportSelectedTemplates(){
    const modal=document.getElementById('template-library-modal');
    const ids=[...(modal?._selectedTemplateIds || [])];
    if(!ids.length){showToast('请先勾选要导出的工程','warning');return;}
    return _exportTemplateCollection(ids);
}
function _collectionBytes(bytes){return bytes>=1024**3?(bytes/1024**3).toFixed(2)+' GB':(bytes/1024**2).toFixed(1)+' MB';}
function _collectionProgressPanel(requestId){
    if(!document.createElement)return null;
    document.getElementById('tpl-collection-progress')?.remove();
    const panel=document.createElement('div');panel.id='tpl-collection-progress';
    panel.style.cssText='position:fixed;bottom:24px;right:24px;z-index:100100;background:#252a40;color:white;padding:18px;border:1px solid #64748b;border-radius:12px;width:360px;box-shadow:0 8px 30px #0008';
    panel.innerHTML='<div data-message style="margin-bottom:10px">正在准备导出…</div><progress max="100" value="0" style="width:100%"></progress><button style="margin-top:10px">取消导出</button>';
    panel.querySelector('button').onclick=async()=>{
        const button=panel.querySelector('button');button.disabled=true;button.textContent='正在取消…';
        try{await _tplLibraryApi('cancel-collection-export',{request_id:requestId});}catch(error){button.disabled=false;button.textContent='重试取消';showToast(error.message,'error');}
    };
    document.body.appendChild(panel);return panel;
}
async function _exportTemplateCollection(ids,all=false){
    if(window._templateCollectionExporting)return;
    window._templateCollectionExporting=true;let unsubscribe,panel;
    _updateTemplatePresetSelectionUI();
    try{
        const api=window.electronAPI;
        if(!api?.saveFile)throw new Error('请在桌面版导出工程合集');
        const estimate=await _tplLibraryApi('estimate-collection',{ids,all});
        ids=estimate.ids;
        const choice=await _chooseTemplateExportMode(ids.length);if(!choice)return;
        const {mode,presetSelection}=choice;
        const modeName={project:'工程快照',preset:'样式预设',package:'完整工程包'}[mode];
        const size=_collectionBytes(estimate.totalBytes);
        const sizeHint=mode==='project'?`约 ${size}`:mode==='package'?`工程数据约 ${size}，另加素材`:'仅导出样式，以实际大小为准';
        const extension=mode==='package'?'vkpkg':'vktpl';
        const date=VideoKitLocalTime.format().slice(0,10).replace(/-/g,'');
        const chosen=await api.saveFile({title:`导出${all?'全部':'选中的'} ${ids.length} 个工程 · ${modeName}，${sizeHint}`,defaultPath:`${all?'全部':'所选'}${modeName}_${date}_${ids.length}个.${extension}`,filters:[{name:'VideoKit '+modeName,extensions:[extension]}]});
        if(chosen.canceled || !chosen.filePath)return;
        const requestId='collection-export-'+Date.now();
        panel=_collectionProgressPanel(requestId);
        unsubscribe=api.onTemplatePackageProgress?.(event=>{
            if(event.request_id!==requestId)return;
            const message=(event.message || '正在导出…')+(event.totalBytes?` · ${_collectionBytes(event.completedBytes || 0)} / ${_collectionBytes(event.totalBytes)}`:'');
            if(panel){panel.querySelector('[data-message]').textContent=message;panel.querySelector('progress').value=event.totalBytes?event.completedBytes/event.totalBytes*100:event.total?event.completed/event.total*100:0;}
        });
        showToast(`正在后台导出 ${ids.length} 个${modeName}…`,'info');
        const subtitlePresets=mode==='preset'?(window.ReelsStyleEngine?.loadSubtitlePresets?.()?.presets || {}):undefined;
        const result=await _tplLibraryApi('export-collection',{ids,mode,presetSelection,subtitlePresets,outputPath:chosen.filePath,request_id:requestId});
        if(result.cancelled){showToast('已取消导出，未完成文件已清理','info');return;}
        const incomplete=result.assetCollection?.status==='partial';
        showToast(incomplete?`已导出 ${result.count} 个工程，但有 ${result.assetCollection.missingCount} 项素材缺失，包内已标记`:`已导出 ${result.count} 个${modeName}${mode==='project'?'（不额外收集素材）':''}${result.skippedCount?`，跳过 ${result.skippedCount} 个无所选样式的工程`:''}`,incomplete?'warning':'success');api.showItemInFolder?.(result.filePath);
    }catch(error){showToast('导出失败：'+error.message,'error');}
    finally{unsubscribe?.();panel?.remove();window._templateCollectionExporting=false;_updateTemplatePresetSelectionUI();}
}

async function _exportAllTemplates() {
    return _exportTemplateCollection(undefined,true);
}

// ═══════════════════════════════════════════════════════
// 5. 启动时自动检测 hash 参数加载模板
// ═══════════════════════════════════════════════════════

function _checkHashForTemplate() {
    const hash = window.location.hash; // e.g. #template=tpl_xxxxx
    const match = hash.match(/template=([^&]+)/);
    if (!match) return;

    const templateId = match[1];
    console.log('[Template] 检测到 URL hash 模板参数:', templateId);

    // 等 DOM 和 app 初始化完成后加载
    const tryLoad = () => {
        if (typeof ReelsProject === 'undefined' || typeof apiFetch === 'undefined') {
            setTimeout(tryLoad, 200);
            return;
        }
        _loadTemplateInCurrentWindow(templateId);
    };

    // 延迟执行，确保 app.js 已经初始化
    setTimeout(tryLoad, 500);
}

// DOM 加载后检测
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _checkHashForTemplate);
} else {
    _checkHashForTemplate();
}
