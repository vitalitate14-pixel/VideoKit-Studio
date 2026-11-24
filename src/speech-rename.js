(() => {
    const rows = [];
    let nextRowId = 1;
    const translations = new Map();
    const mediaUrl = path => window.electronAPI?.toFileUrl?.(path) || path;
    const nameRules = window.SpeechRenameNames;
    const platform = window.electronAPI?.platform || (/Mac/.test(navigator.platform || '') ? 'darwin' : /Linux/.test(navigator.platform || '') ? 'linux' : 'win32');
    const finalBase = row => row.done ? row.fileName.slice(0, -row.ext.length) : (document.getElementById('sr-prefix')?.value || '') + row.name + (document.getElementById('sr-suffix')?.value || '');
    const inspectName = row => nameRules.inspect(row.name.trim() ? finalBase(row) : '', { platform, extension: row.ext });
    let busy = false, stop = false;
    const root = document.getElementById('speech-rename-root');
    if (!root) return;
    const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const api = async (route, data) => {
        if (!window.electronAPI?.apiCall) throw new Error('请在桌面版中使用本地视频命名');
        const response = await window.electronAPI.apiCall(`speech-rename/${route}`, data);
        if (!response.success) throw new Error(response.error || '操作失败');
        return response.data;
    };
    root.innerHTML = `<style>
      #sr-list table { table-layout:fixed; border-collapse:collapse; }
      #sr-list tbody tr + tr td { border-top:2px solid #64748b; padding-top:18px; }
      #sr-list tbody tr:nth-child(even) { background:rgba(128,128,128,.05); }
      #sr-list td, #sr-list th { vertical-align:top; padding:10px 8px; overflow-wrap:anywhere; }
      #sr-list textarea { width:100%; min-width:0; box-sizing:border-box; }
      #sr-list [data-play] { min-height:90px; }
      #sr-list [data-play]:has(img[src]:not([src=""])) { min-height:0; }
      #sr-list mark { background:#991b1b !important; color:#fff !important; outline:2px solid #fb7185; }
      #sr-list [aria-invalid="true"] { border:2px solid #fb7185 !important; }
    </style><h3>语音匹配命名</h3>
      <p class="hint">添加视频 → 识别指定区间 → 匹配文案 → 编辑并逐条确认 → 重命名原文件。识别只上传临时音频片段。</p>
      <div id="sr-drop" style="border:1px dashed var(--border-color);padding:18px;margin:12px 0;">
        <button class="btn btn-secondary" id="sr-add">添加视频</button> 或拖入视频
        <input id="sr-files" type="file" accept="video/*,.mkv,.avi,.m4v,.webm,.mts,.m2ts" multiple hidden>
      </div>
      <label>对应标题和文案（每行一条；可从 Excel 粘贴“标题 [Tab] 文案”两列；只有一列时同时作为文案和名称；顺序可任意）</label>
      <textarea id="sr-candidates" class="input" rows="6" style="width:100%;margin:8px 0;" placeholder="标题一&#9;对应文案内容\n标题二&#9;对应文案内容"></textarea>
      <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin:12px 0;">
        <select id="sr-range" class="select"><option value="10">前 10 秒</option><option value="20">前 20 秒</option><option value="custom">自定义区间</option></select>
        <label>开始（秒） <input id="sr-start" type="number" class="input" min="0" step="0.1" value="0" style="width:90px"></label>
        <label>结束（秒） <input id="sr-end" type="number" class="input" min="0" step="0.1" value="10" style="width:90px"></label>
        <label>语言 <input id="sr-language" class="input" value="en" placeholder="en（英文）/ auto / zh" style="width:100px"></label>
        <button id="sr-analyze" class="btn btn-primary">识别未完成的视频</button>
        <button id="sr-stop" class="btn btn-secondary" disabled>完成当前视频后停止</button>
        <label><input id="sr-translate-auto" type="checkbox" checked> 识别后自动翻译中文</label>
        <button id="sr-translate-all" class="btn btn-secondary">全部翻译中文</button>
        <button id="sr-rematch" class="btn btn-secondary">按当前文案重新匹配</button>
        <button id="sr-use-all" class="btn btn-secondary" title="将各视频当前候选的标题填入最终名称；两列文案使用第一列标题">全部使用提供的文案</button>
        <button id="sr-select-all" class="btn btn-secondary">全选</button>
        <button id="sr-invert" class="btn btn-secondary">反选</button>
        <button id="sr-clear" class="btn btn-secondary" title="只清空视频列表，不删除视频文件，保留提供的文案">清空列表</button>
        <label>固定前缀 <input id="sr-prefix" class="input" placeholder="例如 1010-" style="width:130px"></label>
        <label>固定后缀 <input id="sr-suffix" class="input" placeholder="例如 -完整版" style="width:130px"></label>
        <span class="hint">重名自动添加 (1)、(2) 序号</span>
        <button id="sr-apply" class="btn btn-primary">重命名已确认视频</button>
        <button id="sr-clean-names" class="btn btn-secondary">一键清理不允许字符</button>
        <button id="sr-copy-names" class="btn btn-secondary" title="按列表顺序复制所有已填写的最终名称，每行一个，包含扩展名">复制所有最终名字</button>
      </div>
      <p class="hint">语音识别沿用 Deepgram / Groq / Gladia；中文翻译使用设置中的 Gemini，仅供核对，最终命名仍使用原文。相近候选会标记为待核对；未匹配项可直接编辑识别文字作为名称。名称不含扩展名。</p>
      <p style="font-size:12px"><span style="color:#34d399">● 一致</span>　<span style="color:#fbbf24">● 有差异 / 待核对</span>　<span style="color:#f87171">● 找不到匹配</span>　<span style="color:#60a5fa">● 直接使用提供的文案</span></p>
      <div id="sr-status" role="status">就绪</div><div id="sr-list" style="overflow:auto;margin-top:14px;"></div>`;
    const $ = id => document.getElementById(`sr-${id}`);
    const candidates = () => $('candidates').value.split(/\r?\n/).filter(line => line.trim()).map(line => {
        const parts = line.split('\t');
        return { title: parts[0].trim(), text: (parts.length > 1 ? parts.slice(1).join(' ').trim() : parts[0].trim()) };
    });
    const status = text => { $('status').textContent = text; };
    function translationBlock(text) {
        const translated = translations.get(text);
        return translated ? `<div style="margin-top:10px;padding-top:8px;border-top:1px dashed #8b8b8b;white-space:pre-wrap"><strong style="color:#fbbf24;font-size:12px">中文参考译文</strong><div style="margin-top:4px">${esc(translated)}</div></div>` : '';
    }
    async function translateRow(row) {
        const texts = [...new Set([row.text, row.candidate?.title, row.candidate?.text].filter(text => text?.trim() && !translations.has(text)))];
        if (!texts.length) { row.translationError = ''; return; }
        try {
            const result = await api('translate', { texts });
            if (!Array.isArray(result.translations) || result.translations.length !== texts.length) throw new Error('翻译返回条数不一致');
            texts.forEach((text, index) => translations.set(text, result.translations[index]));
            row.translationError = '';
        } catch (error) { row.translationError = `中文翻译失败：${error.message}`; }
    }
    async function translateRows(selected) {
        if (busy || !selected.length) return;
        busy = true; stop = false; render();
        let count = 0;
        try {
            for (const row of selected) {
                if (stop) break;
                status(`正在翻译中文 ${count + 1}/${selected.length}：${row.fileName}`);
                await translateRow(row); count++; render();
            }
            const failed = selected.filter(row => row.translationError).length;
            status(`中文翻译已处理 ${count}/${selected.length} 个视频${failed ? `，${failed} 个失败，可逐条重试；翻译使用设置中的 Gemini` : '，请对照英文与中文核对标题范围'}`);
        } finally { busy = false; render(); }
    }
    function nameState(row) {
        if (row.usingProvidedText) return { color: '#60a5fa', background: 'rgba(59,130,246,.10)', label: '蓝色 · 直接使用你提供的文案' };
        if (!row.text && !row.error) return { color: '#94a3b8', background: 'rgba(148,163,184,.06)', label: '待识别' };
        if (!row.candidate || row.candidate.score < 0.55 || row.label?.startsWith('识别失败')) return { color: '#f87171', background: 'rgba(239,68,68,.10)', label: '红色 · 找不到匹配文案' };
        const normalize = text => String(text || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
        const recognized = normalize(row.text);
        const supplied = normalize(row.candidate.text.replace(/^\s*\d{1,8}\s*[-_.]\s*/, ''));
        const exact = recognized.length >= 6 && supplied.length >= 6 && (recognized.includes(supplied) || supplied.includes(recognized));
        if (row.comparison?.equal || exact) return { color: '#34d399', background: 'rgba(16,185,129,.10)', label: '绿色 · 识别区间与提供的文案一致' };
        return { color: '#fbbf24', background: 'rgba(245,158,11,.10)', label: '黄色 · 文案存在差异或匹配待核对' };
    }
    function comparisonBlock(row) {
        if (!row.comparison) return '';
        const result = row.comparison;
        const renderParts = kind => result.parts.filter(([op]) => op === 0 || op === kind).map(([op, text]) => op === 0 ? esc(text) : `<mark style="background:${kind === -1 ? '#854d0e' : '#1e40af'} !important;color:white !important;outline:none !important">${esc(text)}</mark>`).join('');
        return `<details style="margin:10px 0;border:1px solid #64748b;padding:8px" ${result.equal ? '' : 'open'}><summary>${result.equal ? '文字一致：查看说明' : '查看具体差异'}</summary><small>${esc(result.note)}</small>${result.equal ? '' : `<div style="white-space:pre-wrap;margin-top:8px"><strong>你提供的文案（黄色差异）</strong><br>${renderParts(-1)}<br><strong>视频识别（蓝色差异）</strong><br>${renderParts(1)}</div>`}</details>`;
    }
    function namePreview(row) {
        const validation = inspectName(row);
        const positions = new Set(validation.positions);
        const highlighted = Array.from(finalBase(row)).map((char, index) => positions.has(index)
            ? `<mark style="background:#7f1d1d;color:#fff;border:1px solid #f87171;border-radius:3px;padding:0 2px;" title="不允许的字符">${esc(char === '\n' ? '↵' : char === '\r' ? '␍' : char === '\t' ? '⇥' : /\s/.test(char) ? '␠' : char.charCodeAt(0) < 32 ? '␀' : char)}</mark>`
            : esc(char)).join('');
        return `<div style="${!validation.valid && row.name ? 'border:2px solid #fb7185;background:rgba(127,29,29,.25);padding:8px;border-radius:6px;' : ''}white-space:pre-wrap;overflow-wrap:anywhere">${!validation.valid && row.name ? '<strong style="color:#fda4af">⚠ 文件名检查（红色为问题字符）</strong><br>' : ''}${highlighted}${row.name ? esc(row.ext) : ''}</div>${!validation.valid && row.name ? `<div style="color:#f87171;margin-top:5px" role="alert">${esc(validation.issues.join('；'))}</div>` : ''}`;
    }
    function updateNameRow(index) {
        const row = rows[index], validation = inspectName(row);
        const input = $('list').querySelector(`[data-name="${index}"]`);
        const check = $('list').querySelector(`[data-confirm="${index}"]`);
        const state = nameState(row);
        const area = document.getElementById(`sr-name-area-${index}`);
        area.style.borderLeft = `3px solid ${state.color}`;
        area.style.backgroundColor = state.background;
        area.style.color = state.color;
        document.getElementById(`sr-name-state-${index}`).textContent = state.label;
        input.style.setProperty('color', state.color, 'important');
        input.style.borderColor = row.name && !validation.valid ? '#f87171' : state.color;
        input.setAttribute('aria-invalid', String(!validation.valid));
        const locate = $('list').querySelector(`[data-locate="${index}"]`);
        if (locate) locate.disabled = validation.valid;
        check.checked = row.confirmed;
        check.disabled = !validation.valid || busy || Boolean(row.done);
        document.getElementById(`sr-name-preview-${index}`).innerHTML = namePreview(row);
    }
    function render() {
        $('list').innerHTML = `<table style="width:100%;min-width:1000px"><colgroup><col style="width:16%"><col style="width:12%"><col style="width:12%"><col style="width:20%"><col style="width:18%"><col style="width:22%"></colgroup><thead><tr><th>原始名字</th><th>缩略图 / 试听</th><th>识别状态</th><th style="color:#60a5fa">语音识别结果</th><th style="color:#34d399">你提供的原始文案</th><th>最终命名</th></tr></thead><tbody>${rows.map((r, i) => `<tr>
          <td>${esc(r.originalName || r.fileName)}${r.done ? `<br><small>已改名：${esc(r.fileName)}</small>` : ''}<br><button class="btn btn-secondary" data-remove="${i}" ${busy ? 'disabled' : ''}>移除</button></td>
          <td><button class="btn btn-secondary" data-play="${i}" title="播放视频并试听识别区间" style="padding:0;width:100%;max-width:132px;height:auto;position:relative;overflow:hidden;margin-bottom:6px;"><img${/^local-media:/i.test(String(esc(r.thumbnail ? mediaUrl(r.thumbnail) : ''))) ? ' crossorigin="anonymous"' : ''} data-thumb-id="${r.rowId}" src="${esc(r.thumbnail ? mediaUrl(r.thumbnail) : '')}" alt="视频缩略图" style="width:100%;height:auto;display:block;${r.thumbnail ? '' : 'display:none;'}"><span style="position:absolute;inset:0;display:grid;place-items:center;background:rgba(0,0,0,.15);color:white;">▶ 试听</span></button><small data-thumb-status="${r.rowId}">${esc(r.thumbnail ? '' : r.thumbnailError || '正在生成缩略图…')}</small></td>
          <td>${esc(r.label || '待识别')}${r.done ? ' · 已命名' : ''}${r.error ? `<br><span style="color:#f87171">${esc(r.error)}</span>` : ''}<br><button class="btn btn-secondary" data-retry="${i}" ${busy || r.done ? 'disabled' : ''}>重新识别</button><br><button class="btn btn-secondary" data-translate="${i}" ${busy || (!r.text && !r.candidate) ? 'disabled' : ''} style="margin-top:6px">翻译中文</button>${r.translationError ? `<div style="color:#f87171;font-size:12px">${esc(r.translationError)}</div>` : ''}</td>
          <td><div style="border-left:3px solid #60a5fa;padding:6px 8px;background:rgba(59,130,246,.08);white-space:pre-wrap"><strong style="color:#60a5fa;font-size:12px">视频语音识别</strong>${r.text ? `<br><small>${esc(r.start)}–${esc(r.end)} 秒</small>` : ''}<div style="margin-top:6px">${esc(r.text || '尚未识别')}</div>${translationBlock(r.text)}</div></td>
          <td><div style="border-left:3px solid #34d399;padding:6px 8px;background:rgba(16,185,129,.08);white-space:pre-wrap"><strong style="color:#34d399;font-size:12px">你提供的原始文案（匹配候选）</strong>${r.candidate ? `<div style="margin-top:6px">${r.candidate.title.trim() === r.candidate.text.trim() ? esc(r.candidate.text) : `<small style="color:#34d399">你提供的标题</small><br>${esc(r.candidate.title)}${translationBlock(r.candidate.title)}<br><small style="color:#34d399">你提供的正文</small><br>${esc(r.candidate.text)}`}</div>${translationBlock(r.candidate.text)}${comparisonBlock(r)}<div style="margin-top:6px;color:var(--text-secondary)">与识别结果的相似度：${Math.round(r.candidate.score * 100)}%</div>` : '<div>暂无匹配候选</div>'}</div><br><button class="btn btn-secondary" data-use="${i}" ${busy || r.done || !r.candidate?.title?.trim() ? 'disabled' : ''}>使用提供的文案</button>${(r.suggestions || []).map(c => `<button class="btn btn-secondary" data-pick="${i}" data-candidate="${c.index}" ${busy || r.done ? 'disabled' : ''} style="display:block;max-width:100%;white-space:normal;font-size:12px;margin-top:6px">选用：${esc(c.title)}（${Math.round(c.score * 100)}%）</button>`).join('')}</td>
          <td><div id="sr-name-area-${i}" style="padding:8px;border-left:3px solid ${nameState(r).color};background:${nameState(r).background};color:${nameState(r).color}"><strong id="sr-name-state-${i}" style="display:block;margin-bottom:8px;font-size:12px">${nameState(r).label}</strong><textarea class="input" data-name="${i}" aria-label="最终名称 ${i + 1}" aria-invalid="${!inspectName(r).valid}" style="color:${nameState(r).color} !important;border-color:${r.name && !inspectName(r).valid ? '#f87171' : nameState(r).color}" rows="3" ${busy || r.done ? 'disabled' : ''}>${esc(r.name)}</textarea><div id="sr-name-preview-${i}" style="margin:6px 0;font-size:13px">${namePreview(r)}</div><label style="display:block;margin:8px 0"><input data-confirm="${i}" type="checkbox" ${r.confirmed ? 'checked' : ''} ${!inspectName(r).valid || busy || r.done ? 'disabled' : ''}> 确认此名称</label><button class="btn btn-secondary" data-locate="${i}" ${inspectName(r).valid ? 'disabled' : ''}>定位问题字符</button></div></td>
        </tr>`).join('')}</tbody></table>`;
        for (const id of ['add', 'files', 'range', 'start', 'end', 'language', 'candidates', 'analyze', 'rematch', 'translate-auto', 'translate-all', 'use-all', 'select-all', 'invert', 'clear', 'apply', 'prefix', 'suffix', 'copy-names', 'clean-names']) $(id).disabled = busy;
        $('stop').disabled = !busy;
    }
    function add(files) {
        if (busy) return;
        for (const file of files) {
            const source = window.getFileNativePath(file);
            if (!source) { status('无法读取本地路径，请在桌面版中添加视频'); continue; }
            if (!/\.(mp4|mov|mkv|avi|m4v|webm|mts|m2ts|wmv|flv|mpg|mpeg)$/i.test(file.name) || rows.some(r => r.source === source)) continue;
            const row = { rowId: nextRowId++, source, originalName: file.name, fileName: file.name, ext: file.name.match(/\.[^.]+$/)?.[0] || '', name: '', text: '', confirmed: false };
            rows.push(row);
            loadThumbnail(row);
        }
        render();
    }
    const thumbnailQueue = [];
    let loadingThumbnail = false;
    async function loadThumbnail(row) {
        thumbnailQueue.push(row);
        if (loadingThumbnail) return;
        loadingThumbnail = true;
        try {
            while (thumbnailQueue.length) {
                const item = thumbnailQueue.shift();
                if (!rows.includes(item)) continue;
                try {
                    const result = await api('thumbnail', { source: item.source });
                    item.thumbnail = result.image;
                    if (!item.thumbnail) throw new Error('未生成缩略图');
                    const image = $('list').querySelector(`[data-thumb-id="${item.rowId}"]`);
                    if (image && item.thumbnail) { image.src = mediaUrl(item.thumbnail); image.style.display = 'block'; }
                    const label = $('list').querySelector(`[data-thumb-status="${item.rowId}"]`);
                    if (label) label.textContent = '';
                } catch (error) {
                    item.thumbnailError = `缩略图生成失败：${error.message}，仍可点击试听`;
                    const label = $('list').querySelector(`[data-thumb-status="${item.rowId}"]`);
                    if (label) label.textContent = item.thumbnailError;
                }
            }
        } finally { loadingThumbnail = false; }
    }
    function playRow(row) {
        const dialog = document.createElement('dialog');
        dialog.style.cssText = 'width:min(820px,90vw);background:#202020;color:white;border:1px solid #666;border-radius:12px;padding:16px;';
        const start = Number(row.start ?? $('start').value) || 0;
        const end = Number(row.end ?? $('end').value) || 10;
        dialog.innerHTML = `<div style="display:flex;justify-content:space-between;gap:12px"><strong>${esc(row.fileName)}</strong><button class="btn btn-secondary" data-close>关闭</button></div><video${/^local-media:/i.test(String(esc(mediaUrl(row.source)))) ? ' crossorigin="anonymous"' : ''} controls preload="metadata" playsinline style="width:100%;max-height:65vh;margin:12px 0" src="${esc(mediaUrl(row.source))}"></video><button class="btn btn-secondary" data-range>重播 ${start}–${end} 秒</button> <label><input type="checkbox" data-limit checked> 只试听识别区间</label><p data-error style="color:#fda4af"></p><p style="white-space:pre-wrap">${esc(row.text)}</p>`;
        document.body.appendChild(dialog);
        const video = dialog.querySelector('video');
        const begin = () => { video.currentTime = start; video.play().catch(error => { dialog.querySelector('[data-error]').textContent = `无法自动播放，请点击播放按钮：${error.message}`; }); };
        video.onloadedmetadata = begin;
        video.ontimeupdate = () => { if (dialog.querySelector('[data-limit]').checked && video.currentTime >= end) video.pause(); };
        video.onerror = () => { dialog.querySelector('[data-error]').textContent = '视频无法播放，请检查文件是否存在或视频编码是否支持'; };
        dialog.querySelector('[data-range]').onclick = begin;
        dialog.querySelector('[data-close]').onclick = () => dialog.close();
        dialog.onclose = () => { video.pause(); video.removeAttribute('src'); video.load(); dialog.remove(); };
        dialog.showModal();
    }
    function assign(row, result) {
        Object.assign(row, result, { name: result.proposedName || '', usingProvidedText: false, confirmed: false, error: '', label: ({ matched: '匹配成功 · 待确认', uncertain: '匹配不确定 · 请核对', unmatched: '未匹配 · 可编辑命名' })[result.status] });
    }
    async function run(selected) {
        if (busy || !selected.length) return;
        const options = { start: Number($('start').value), end: Number($('end').value), language: $('language').value.trim() || 'en', candidates: candidates(), translate: $('translate-auto').checked };
        if (!Number.isFinite(options.start) || !Number.isFinite(options.end) || options.start < 0 || options.end <= options.start) return status('请输入有效的开始和结束时间');
        busy = true; stop = false; render();
        let count = 0;
        try {
            for (const row of selected) {
                if (stop) break;
                row.confirmed = false; row.label = '正在识别'; row.error = ''; render();
                status(`正在识别 ${count + 1}/${selected.length}：${row.fileName}`);
                try {
                    assign(row, await api('analyze', { source: row.source, ...options }));
                    if (options.translate) {
                        render(); status(`正在翻译中文：${row.fileName}`);
                        await translateRow(row);
                    }
                }
                catch (error) { row.label = '识别失败 · 可重试或手动命名'; row.error = error.message; }
                count++; render();
            }
            status(`${stop ? '已停止' : '识别完成'}，已处理 ${count}/${selected.length} 个视频。请核对并勾选确认。`);
        } finally { busy = false; render(); }
    }
    $('add').onclick = () => $('files').click();
    $('files').onchange = e => { add(Array.from(e.target.files)); e.target.value = ''; };
    $('drop').ondragover = e => e.preventDefault();
    $('drop').ondrop = e => { e.preventDefault(); add(Array.from(e.dataTransfer.files)); };
    $('range').onchange = () => { if ($('range').value !== 'custom') { $('start').value = '0'; $('end').value = $('range').value; } render(); };
    $('prefix').oninput = $('suffix').oninput = () => { rows.forEach((row, index) => { if (!row.done) { row.confirmed = false; updateNameRow(index); } }); status('前缀 / 后缀已更新，请重新核对并选择'); };
    $('start').oninput = $('end').oninput = () => { $('range').value = 'custom'; };
    $('translate-all').onclick = () => translateRows(rows.filter(row => row.text || row.candidate));
    $('analyze').onclick = () => run(rows.filter(r => !r.text && !r.done));
    $('stop').onclick = () => { stop = true; status('将在当前视频识别完成后停止'); };
    function useProvidedText(row) {
        if (row.done || !row.candidate?.title?.trim()) return false;
        row.name = row.candidate.title;
        row.usingProvidedText = true;
        row.confirmed = false;
        return true;
    }
    $('use-all').onclick = () => {
        if (busy) return;
        let count = 0;
        for (const row of rows) if (useProvidedText(row)) count++;
        render();
        status(`已将 ${count} 个视频的当前候选文案填入最终名称，跳过 ${rows.length - count} 个无候选或已命名视频。请核对不确定的匹配后勾选确认。`);
    };
    function selectRows(invert) {
        if (busy) return;
        for (const row of rows) {
            row.confirmed = !row.done && inspectName(row).valid && (invert ? !row.confirmed : true);
        }
        render();
        status(`已${invert ? '反选' : '全选'}，确认 ${rows.filter(row => row.confirmed).length} 个视频；空名称、非法名称和已命名视频不参与选择。`);
    }
    $('select-all').onclick = () => selectRows(false);
    $('invert').onclick = () => selectRows(true);
    $('clear').onclick = () => {
        if (busy) return;
        rows.length = 0;
        thumbnailQueue.length = 0;
        render();
        status('视频列表已清空，原视频文件和提供的文案保留');
    };
    $('clean-names').onclick = () => {
        if (busy) return;
        let count = 0;
        for (const row of rows.filter(row => !row.done)) {
            const cleaned = nameRules.clean(row.name, { platform, extension: row.ext });
            if (cleaned !== row.name) { row.name = cleaned; row.usingProvidedText = false; row.confirmed = false; count++; }
        }
        render();
        status(count ? `已清理 ${count} 个名称，请核对后重新勾选确认；过长或空名称仍需手动编辑` : '没有需要清理的字符；过长或空名称请手动编辑');
    };
    $('copy-names').onclick = async () => {
        const named = rows.filter(row => row.name.trim());
        if (!named.length) return status('没有可复制的最终名字，请先识别或填写名称');
        const text = named.map(row => row.done ? row.fileName : finalBase(row) + row.ext).join('\n');
        try {
            if (window.electronAPI?.writeClipboardText) await window.electronAPI.writeClipboardText(text);
            else await navigator.clipboard.writeText(text);
            const skipped = rows.length - named.length;
            status(`已复制 ${named.length} 个最终名字（包含扩展名，每行一个）${skipped ? `，跳过 ${skipped} 个未填写名称的视频` : ''}`);
        } catch (error) { status(`复制失败：${error.message}`); }
    };
    $('rematch').onclick = async () => {
        if (busy) return;
        busy = true; render();
        try { for (const row of rows.filter(r => r.text && !r.done)) assign(row, await api('match', { text: row.text, candidates: candidates() })); status('已重新匹配，请重新核对最终名称'); }
        catch (error) { status(error.message); } finally { busy = false; render(); }
    };
    $('list').oninput = e => {
        if (e.target.dataset.name !== undefined) {
            const index = Number(e.target.dataset.name), row = rows[index];
            row.name = e.target.value; row.usingProvidedText = false; row.confirmed = false;
            updateNameRow(index);
        }
    };
    $('list').onchange = e => { if (e.target.dataset.confirm !== undefined) rows[Number(e.target.dataset.confirm)].confirmed = e.target.checked; };
    $('list').onclick = async e => {
        const button = e.target.closest('button');
        if (!button) return;
        if (button.dataset.play !== undefined) return playRow(rows[Number(button.dataset.play)]);
        if (busy) return;
        if (button.dataset.translate !== undefined) return translateRows([rows[Number(button.dataset.translate)]]);
        if (button.dataset.use !== undefined) {
            if (useProvidedText(rows[Number(button.dataset.use)])) {
                render();
                status('已使用当前候选文案作为最终名称，请核对后勾选确认');
            }
            return;
        }
        if (button.dataset.locate !== undefined) {
            const index = Number(button.dataset.locate), row = rows[index];
            const positions = inspectName(row).positions;
            const input = $('list').querySelector(`[data-name="${index}"]`);
            const offset = Array.from(row.name).slice(0, positions[0] ?? 0).join('').length;
            input.focus(); input.setSelectionRange(offset, offset + (Array.from(row.name)[positions[0]]?.length || 0));
            return;
        }
        if (button.dataset.pick !== undefined) {
            const row = rows[Number(button.dataset.pick)];
            const candidate = row.suggestions.find(c => c.index === Number(button.dataset.candidate));
            row.name = candidate.title; row.candidate = candidate; row.usingProvidedText = true; row.confirmed = false;
            row.comparison = null;
            try { row.comparison = await api('compare', { text: row.text, supplied: candidate.text }); } catch (_) { }
            render(); return;
        }
        if (button.dataset.retry !== undefined) run([rows[Number(button.dataset.retry)]]);
        if (button.dataset.remove !== undefined) { rows.splice(Number(button.dataset.remove), 1); render(); }
    };
    $('apply').onclick = async () => {
        const selected = rows.filter(r => r.confirmed && !r.done);
        if (!selected.length) return status('请先核对名称并勾选确认');
        const invalid = selected.filter(row => !inspectName(row).valid);
        if (invalid.length) {
            render();
            const first = invalid[0];
            const index = rows.indexOf(first);
            const input = $('list').querySelector(`[data-name="${index}"]`);
            input.scrollIntoView({ block: 'center' }); input.focus();
            return status(`有 ${invalid.length} 个名称需要修正：“${first.fileName}” ${inspectName(first).issues.join('；')}`);
        }
        if (!confirm(`确认按核对后的名称及前后缀重命名 ${selected.length} 个原视频？重名自动加序号。`)) return;
        busy = true; render();
        try {
            const result = await api('apply', { entries: selected.map(r => ({ source: r.source, name: r.name, confirmed: true })), prefix: $('prefix').value, suffix: $('suffix').value });
            for (const item of result.results) { const row = rows.find(r => r.source === item.source); if (item.success) { row.source = item.target; row.fileName = item.target.split(/[\\/]/).pop(); row.done = true; row.confirmed = false; } else row.error = item.error; }
            status(`已重命名 ${result.results.filter(r => r.success).length} 个视频${result.success ? '' : '，执行中断，请查看失败原因；其余视频尚未执行'}`);
        } catch (error) { status(error.message); } finally { busy = false; render(); }
    };
    render();
})();
