(function () {
    const root = document.getElementById('name-matching-root');
    if (!root || !window.NameMatching) return;
    const matcher = window.NameMatching, storageKey = 'videokit-name-matching-v1';
    const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
    let rows = [], timer;
    const sources = { original: [], canonical: [] };
    root.innerHTML = `<style>
      #name-matching-root .nm-inputs{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:18px 0}
      #name-matching-root textarea{width:100%;box-sizing:border-box;resize:vertical;line-height:1.6}
      #name-matching-root .nm-input-table{max-height:360px;overflow:auto;border:1px solid var(--border-color);border-radius:8px}
      #name-matching-root .nm-input-table .nm-number{width:52px;text-align:center;color:var(--text-secondary);font-size:12px;white-space:nowrap}
      #name-matching-root .nm-input-table .nm-remove-col{width:48px;padding:8px 3px;text-align:center;white-space:nowrap}
      #name-matching-root .nm-input-table td{padding:8px}
      #name-matching-root .nm-input-table textarea{field-sizing:content;min-height:68px;resize:vertical;line-height:1.6;font-family:inherit;overflow-wrap:anywhere}
      #name-matching-root .nm-column-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px}
      #name-matching-root .nm-row-remove{border:0;background:transparent;color:var(--text-secondary);cursor:pointer;padding:6px;font-size:16px}
      #name-matching-root .nm-toolbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:14px 0}
      #name-matching-root .nm-table-wrap{overflow:auto;max-height:65vh;border:1px solid var(--border-color);border-radius:8px}
      #name-matching-root table{width:100%;border-collapse:collapse;table-layout:fixed}
      #name-matching-root th,#name-matching-root td{padding:12px;vertical-align:top;border-bottom:1px solid var(--border-color);word-break:break-word;text-align:left}
      #name-matching-root th{position:sticky;top:0;background:var(--bg-secondary);z-index:1}
      #name-matching-root td:first-child{white-space:pre-wrap;user-select:text}
      #name-matching-root .nm-badge{display:inline-block;font-size:12px;margin-bottom:6px}
      #name-matching-root .nm-exact,#name-matching-root .nm-manual{color:#34d399}
      #name-matching-root .nm-review,#name-matching-root .nm-ambiguous{color:#fbbf24}
      #name-matching-root .nm-unmatched{color:#f87171}
      #name-matching-root select{width:100%;margin:7px 0;white-space:normal}
      #name-matching-root .nm-summary{margin:12px 0;line-height:1.7}
      @media(max-width:850px){#name-matching-root .nm-inputs{grid-template-columns:1fr}}
    </style>
    <h3>名字匹配</h3>
    <p class="hint">粘贴原始文件名和正规名字，按原始顺序生成两列表格，重复行会保留。支持逐行文本、Excel 单列和 Markdown 表格。</p>
    <div class="nm-inputs">
      ${['original', 'canonical'].map(kind => {
          const label = kind === 'original' ? '原始名字' : '正规名字';
          return `<div><div class="nm-column-head"><strong>${kind === 'original' ? '①' : '②'} ${label}</strong><div style="display:flex;gap:8px;"><button id="nm-add-${kind}" class="btn btn-secondary">添加一行</button><button id="nm-clear-${kind}" class="btn btn-secondary" title="只清空${label}，保留另一列">清空${label}</button></div></div>
            <textarea id="nm-${kind}" hidden aria-hidden="true"></textarea>
            <div class="nm-input-table"><table aria-label="${label}输入表格"><thead><tr><th class="nm-number" scope="col">序号</th><th scope="col">${label}</th><th class="nm-remove-col" scope="col">移除</th></tr></thead><tbody id="nm-${kind}-table"></tbody></table></div>
            <span id="nm-${kind}-count" class="hint"></span>${kind === 'canonical' ? '<div class="nm-toolbar"><button id="nm-import" class="btn btn-secondary">导入正规名字 TXT</button><input id="nm-file" type="file" accept=".txt,text/plain" hidden></div>' : ''}</div>`;
      }).join('')}
    </div>
    <p class="hint">在任意名字单元格粘贴整列内容，每行自动填入一格；可逐格编辑。左右列表按标题匹配，行号不需要对应。</p>
    <div class="nm-toolbar"><button id="nm-match" class="btn btn-primary">开始匹配</button><button id="nm-clear" class="btn btn-secondary">清空全部</button><span class="hint">输入和核对结果自动保存在本机，下次打开可继续使用。</span></div>
    <p id="nm-message" class="hint" role="status" aria-live="polite"></p>
    <div id="nm-results" hidden>
      <div id="nm-summary" class="nm-summary"></div>
      <div class="nm-toolbar"><button id="nm-copy" class="btn btn-primary">复制两列表格</button><button id="nm-markdown" class="btn btn-secondary">复制 Markdown 表格</button><button id="nm-copy-names" class="btn btn-secondary">仅复制匹配名字</button><button id="nm-csv" class="btn btn-secondary">导出 CSV</button><label><input id="nm-header" type="checkbox" checked>包含表头</label></div>
      <div class="nm-table-wrap"><table><thead><tr><th scope="col">原始名字</th><th scope="col">匹配名字</th></tr></thead><tbody id="nm-body"></tbody></table></div>
    </div>`;
    const get = id => document.getElementById('nm-' + id);
    const message = text => { get('message').textContent = text; };
    const labels = { exact: '匹配成功', review: '相近匹配 · 请核对', ambiguous: '多个正规版本 · 请选择', unmatched: '未找到匹配 · 可手动填写', manual: '已手动核对' };
    function sourceRow(kind, value, index, removable) {
        const label = kind === 'original' ? '原始名字' : '正规名字';
        return `<tr><td class="nm-number">${index + 1}</td><td>
          <textarea class="input" rows="2" data-source-row="${index}" aria-label="第 ${index + 1} 行${label}" placeholder="${index === 0 ? '在这里粘贴整列名字，或直接输入' : '输入或粘贴名字'}">${esc(value)}</textarea>
          </td><td class="nm-remove-col">${removable ? `<button class="nm-row-remove" data-remove-source="${index}" aria-label="移除第 ${index + 1} 行${label}">×</button>` : ''}</td></tr>`;
    }
    function renderSource(kind) {
        get(kind + '-table').innerHTML = [...sources[kind], ''].map((value, index) => sourceRow(kind, value, index, index < sources[kind].length)).join('');
    }
    function syncSource(kind) {
        get(kind).value = sources[kind].join('\n');
        inputChanged();
    }
    for (const kind of ['original', 'canonical']) {
        const body = get(kind + '-table');
        body.addEventListener('input', event => {
            if (event.target.dataset.sourceRow === undefined) return;
            const index = Number(event.target.dataset.sourceRow);
            const adding = index === sources[kind].length;
            sources[kind][index] = event.target.value.replace(/[\r\n]+/g, ' ');
            syncSource(kind);
            if (adding) {
                const label = kind === 'original' ? '原始名字' : '正规名字';
                event.target.closest('tr').querySelector('.nm-remove-col').innerHTML = `<button class="nm-row-remove" data-remove-source="${index}" aria-label="移除第 ${index + 1} 行${label}">×</button>`;
                body.insertAdjacentHTML('beforeend', sourceRow(kind, '', sources[kind].length, false));
            }
        });
        body.addEventListener('paste', event => {
            if (event.target.dataset.sourceRow === undefined) return;
            const text = event.clipboardData?.getData('text/plain') || '';
            if (!/[\r\n\t]/.test(text) && !/^\s*\|/.test(text)) return;
            event.preventDefault();
            const names = matcher.parseLines(text);
            if (!names.length) return;
            const index = Number(event.target.dataset.sourceRow);
            sources[kind].splice(index, names.length, ...names);
            syncSource(kind); renderSource(kind);
            message(`已粘贴 ${names.length} 行${kind === 'original' ? '原始名字' : '正规名字'}，保持粘贴顺序。`);
        });
        body.addEventListener('click', event => {
            if (event.target.dataset.removeSource === undefined) return;
            sources[kind].splice(Number(event.target.dataset.removeSource), 1);
            syncSource(kind); renderSource(kind);
        });
        get('add-' + kind).onclick = () => {
            sources[kind].push(''); syncSource(kind); renderSource(kind);
        };
        get('clear-' + kind).onclick = () => {
            sources[kind] = [];
            syncSource(kind); renderSource(kind);
            clearTimeout(timer); save();
            message(`已清空${kind === 'original' ? '原始名字' : '正规名字'}，另一列已保留。`);
        };
    }
    function counts() {
        get('original-count').textContent = `原始名字 ${matcher.parseLines(get('original').value).length} 行`;
        get('canonical-count').textContent = `正规名字 ${matcher.parseLines(get('canonical').value).length} 行`;
    }
    function save() {
        try { localStorage.setItem(storageKey, JSON.stringify({ original: get('original').value, canonical: get('canonical').value, rows, header: get('header').checked })); }
        catch { message('本机保存失败；请先复制或导出结果，避免关闭后丢失。'); }
    }
    function summary() {
        const count = status => rows.filter(row => row.status === status).length;
        get('summary').textContent = `共 ${rows.length} 行 · 匹配成功 ${count('exact')} · 已手动核对 ${count('manual')} · 待核对 ${count('review') + count('ambiguous')} · 未匹配 ${count('unmatched')}。输出始终保持原始顺序；待核对行导出当前候选，未匹配行保留空白。`;
    }
    function render() {
        get('results').hidden = !rows.length;
        summary();
        get('body').innerHTML = rows.map((row, index) => `<tr><td>${esc(row.original)}</td><td>
          <span id="nm-badge-${index}" class="nm-badge nm-${esc(row.status)}">${esc(labels[row.status])}</span>
          <textarea class="input" rows="2" data-edit="${index}" aria-label="第 ${index + 1} 行匹配名字">${esc(row.matched)}</textarea>
          ${row.suggestions.length > 1 || row.status === 'unmatched' ? `<select class="input" data-pick="${index}" aria-label="第 ${index + 1} 行候选"><option value="">选择候选名字</option>${row.suggestions.map((candidate, i) => `<option value="${i}">${esc(candidate.name)}（${Math.round(candidate.score * 100)}%）</option>`).join('')}</select>` : ''}
          <button class="btn btn-secondary" data-confirm="${index}">确认此行</button>
        </td></tr>`).join('');
    }
    function updateRow(index, value, confirmed) {
        const row = rows[index];
        row.matched = value;
        row.status = !value.trim() ? 'unmatched' : confirmed ? 'manual' : 'review';
        const badge = document.getElementById('nm-badge-' + index);
        badge.className = 'nm-badge nm-' + row.status;
        badge.textContent = labels[row.status];
        summary();
        clearTimeout(timer); timer = setTimeout(save, 250);
    }
    get('body').addEventListener('input', event => {
        if (event.target.dataset.edit !== undefined) updateRow(Number(event.target.dataset.edit), event.target.value, false);
    });
    get('body').addEventListener('change', event => {
        const index = event.target.dataset.pick;
        if (index === undefined || event.target.value === '') return;
        const value = rows[Number(index)].suggestions[Number(event.target.value)].name;
        event.target.closest('td').querySelector('textarea').value = value;
        updateRow(Number(index), value, true);
    });
    get('body').addEventListener('click', event => {
        if (event.target.dataset.confirm === undefined) return;
        const index = Number(event.target.dataset.confirm);
        if (!rows[index].matched.trim()) return message('请先填写或选择这一行的匹配名字。');
        updateRow(index, rows[index].matched, true);
    });
    function inputChanged() {
        rows = []; render(); counts();
        message('输入已更新，点击“开始匹配”生成新结果。');
        clearTimeout(timer); timer = setTimeout(save, 250);
    }
    get('original').addEventListener('input', inputChanged);
    get('canonical').addEventListener('input', inputChanged);
    get('header').addEventListener('change', save);
    get('match').onclick = () => {
        if (!matcher.parseLines(get('original').value).length || !matcher.parseLines(get('canonical').value).length) return message('请先填写原始名字和正规名字。');
        rows = matcher.matchNames(get('original').value, get('canonical').value);
        render(); message('匹配完成。黄色行请核对候选；红色行可手动填写。'); save();
    };
    get('clear').onclick = () => {
        if ((get('original').value || get('canonical').value) && !confirm('清空原始名字、正规名字和匹配结果？')) return;
        get('original').value = ''; get('canonical').value = ''; sources.original = []; sources.canonical = [];
        renderSource('original'); renderSource('canonical'); rows = []; render(); counts(); message('已清空。'); save();
    };
    get('import').onclick = () => get('file').click();
    get('file').onchange = async event => {
        const file = event.target.files[0];
        if (!file) return;
        try { sources.canonical = matcher.parseLines(await file.text()); get('canonical').value = sources.canonical.join('\n'); renderSource('canonical'); inputChanged(); message(`已导入 ${file.name}，点击“开始匹配”。`); }
        catch (error) { message(`读取失败：${error.message}`); }
        event.target.value = '';
    };
    async function copy(text) {
        try {
            if (window.electronAPI?.writeClipboardText) {
                if (window.electronAPI.writeClipboardText(text) === false) throw new Error('剪贴板不可用');
            } else if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
            else {
                const field = document.createElement('textarea'); field.value = text; document.body.appendChild(field); field.select();
                const copied = document.execCommand('copy'); field.remove(); if (!copied) throw new Error('剪贴板不可用');
            }
            message('已复制，顺序和行数保持不变。');
        } catch (error) { message(`复制失败：${error.message}。可使用“导出 CSV”。`); }
    }
    get('copy').onclick = () => copy(matcher.exportTable(rows, 'tsv', get('header').checked));
    get('markdown').onclick = () => copy(matcher.exportTable(rows, 'markdown', get('header').checked));
    get('copy-names').onclick = () => copy(rows.map(row => row.matched.replace(/[\r\n]+/g, ' ')).join('\n'));
    get('csv').onclick = async () => {
        const content = matcher.exportTable(rows, 'csv', get('header').checked);
        if (window.electronAPI?.saveFile) {
            try {
                const result = await window.electronAPI.saveFile({ title: '保存名字匹配表格', defaultPath: '名字匹配.csv', filters: [{ name: 'CSV 表格', extensions: ['csv'] }], content });
                if (result?.canceled) return message('已取消导出。');
                if (!result?.success) throw new Error(result?.error || '保存失败');
                return message(`已保存两列表格：${result.filePath}`);
            } catch (error) { return message(`导出失败：${error.message}`); }
        }
        const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
        const link = document.createElement('a'); link.href = url; link.download = '名字匹配.csv'; document.body.appendChild(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000); message('已导出两列 CSV，顺序和重复行保持不变。');
    };
    try {
        const saved = JSON.parse(localStorage.getItem(storageKey) || 'null');
        if (saved && typeof saved.original === 'string' && typeof saved.canonical === 'string') {
            get('original').value = saved.original; get('canonical').value = saved.canonical; get('header').checked = saved.header !== false;
            const originalLines = matcher.parseLines(saved.original);
            if (Array.isArray(saved.rows) && saved.rows.length === originalLines.length && saved.rows.every((row, i) => row.original === originalLines[i] && typeof row.matched === 'string' && labels[row.status] && Array.isArray(row.suggestions))) rows = saved.rows;
            message('已恢复上次输入和核对结果。');
        }
    } catch { message('上次保存的数据无法读取，请重新粘贴。'); }
    sources.original = get('original').value ? get('original').value.split('\n') : [];
    sources.canonical = get('canonical').value ? get('canonical').value.split('\n') : [];
    renderSource('original'); renderSource('canonical'); counts(); render();
})();
