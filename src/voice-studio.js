/* Voice Studio is deliberately independent of the large application controller. */
(function (global) {
    function parseTable(text) {
        const delimiter = String(text).includes('\t') ? '\t' : ',';
        const rows = []; let row = [], cell = '', quoted = false;
        text = String(text).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
        for (let i = 0; i <= text.length; i++) {
            const c = text[i];
            if (c === '"' && (quoted || cell === '')) {
                if (quoted && text[i + 1] === '"') { cell += '"'; i++; }
                else quoted = !quoted;
            } else if ((c === delimiter || c === '\n' || c === undefined) && !quoted) {
                row.push(cell); cell = '';
                if (c !== delimiter) { if (row.some(v => v.trim())) rows.push(row); row = []; }
            } else if (c !== undefined) cell += c;
        }
        if (quoted) throw new Error('表格引号未闭合，请检查粘贴内容');
        return rows;
    }
    if (typeof module !== 'undefined' && module.exports) { module.exports = { parseTable }; return; }
    const $ = id => document.getElementById(id);
    const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const button = (action, label, attrs = '') => `<button type="button" class="btn btn-secondary" data-vs="${action}" ${attrs}>${label}</button>`;
    const media = p => typeof normalizeFilePath === 'function' ? normalizeFilePath(p) : p;
    const statuses = { draft: '待生成', generating: '生成中', ready: '待试听', saved: '已保存', failed: '失败',
        planned: '已预分配', queued: '待生产', running: '生产中', blocked: '待分配', uncertain: '需核对', paused: '已暂停', stopping: '正在停止', completed: '已完成', needs_attention: '部分任务待处理' };
    let state = { designs: [], voices: [], keys: [], jobs: [] };
    let balances = [];
    let activeTab = 'single', focused = '', jobId = '', busy = false, stopDesigns = false, pollTimer;
    let selectedVoices = new Set();
    async function call(action = 'snapshot', data = {}) {
        const res = await apiFetch('elevenlabs/voice-studio', { method: 'POST', body: JSON.stringify({ action, ...data }) });
        const result = await res.json();
        if (!res.ok) throw new Error(result.error || '操作失败');
        return result;
    }
    function apply(result) { if (result.designs) state = result; }
    function notice(text, error = false) { $('vs-notice').textContent = text; $('vs-notice').style.color = error ? '#ff7979' : 'var(--text-secondary)'; }
    function keyOptions(selected) {
        return state.keys.map(k => `<option value="${esc(k.key_id)}" ${k.key_id === selected ? 'selected' : ''} ${!k.enabled ? 'disabled' : ''}>${esc(k.label)}${k.enabled ? '' : '（停用）'}</option>`).join('');
    }
    function mount() {
        if ($('voice-studio-dialog')) return;
        const dialog = document.createElement('dialog'); dialog.id = 'voice-studio-dialog';
        dialog.innerHTML = `<div class="vs-header"><strong>声音设计与批量生产</strong>${button('close', '关闭')}</div>
        <div class="vs-tabs">${button('tab', '单个创建', 'data-tab="single"')}${button('tab', '批量创建', 'data-tab="batch"')}${button('tab', '我的声音', 'data-tab="library"')}${button('tab', '批量生产音频', 'data-tab="production"')}</div>
        <div id="vs-notice" role="status" aria-live="polite"></div>
        <section id="vs-design-input"><div class="vs-grid">
          <label>创建账号<select id="vs-key" class="select"></select></label>
          <label>声音名称<input id="vs-name" class="input" placeholder="例如：温暖男旁白"></label>
        </div><label>声音描述（20–1000 字符）<textarea id="vs-description" class="textarea" rows="3" placeholder="描述年龄、性别、音色、口音、语速及表达风格"></textarea></label>
        <label>试听文本（100–1000 字符，留空自动生成）<textarea id="vs-preview-text" class="textarea" rows="3" placeholder="使用同一段文本，方便比较不同声音"></textarea></label>
        <details><summary>高级设置</summary><div class="vs-grid"><label>设计模型<select id="vs-model" class="select"><option value="eleven_ttv_v3">Voice Design v3</option><option value="eleven_multilingual_ttv_v2">Voice Design v2</option></select></label><label><input id="vs-enhance" type="checkbox"> 自动丰富音色描述</label></div></details>
        <div id="vs-single-controls">${button('single', '生成候选声音')}</div>
        <div id="vs-batch-controls" hidden><label>批量描述（每行：名称 ⇥ 描述 ⇥ Key 尾号；可粘贴 Excel，也可导入 CSV/TSV）<textarea id="vs-import" class="textarea" rows="4" placeholder="温暖男旁白&#9;成年男性，音色低沉温暖，普通话清晰，表达自然，语速适中"></textarea></label><input id="vs-design-file" type="file" accept=".csv,.tsv,.txt">${button('import-designs', '添加到队列')}${button('add-design', '添加上方描述')}${button('generate-all', '生成待处理任务')}${button('stop-designs', '停止后续生成')}${button('save-selected', '保存全部已选声音')}</div>
        <p class="hint">生成试听会消耗账号额度；播放已生成试听使用本地音频。保存后自动绑定创建时的 Key。</p></section>
        <section id="vs-review"><div class="vs-grid vs-review-grid"><div id="vs-design-list"></div><div id="vs-candidates"></div></div></section>
        <section id="vs-library" hidden><div class="vs-toolbar"><input id="vs-search" class="input" placeholder="搜索名称或描述">${button('refresh', '刷新')}${button('sync-voices', '同步已配置账号声音')}</div><div id="vs-library-list"></div></section>
        <section id="vs-production" hidden><div class="vs-toolbar">${button('accounts', '刷新余额')}${button('sync-voices', '同步账号声音')}<span>选择参与生产的声音：</span></div><div id="vs-pool"></div>
        <label>文案表格（每行：名称 ⇥ 文案 ⇥ 指定 Voice ID〔可选〕；多行文案请从表格复制或导入带引号 CSV）<textarea id="vs-copy" class="textarea" rows="5" placeholder="视频一&#9;这里放完整文案……"></textarea></label><input id="vs-copy-file" type="file" accept=".csv,.tsv,.txt">
        <div class="vs-grid"><label>配音模型<select id="vs-tts-model" class="select"><option value="eleven_multilingual_v2">Multilingual v2</option><option value="eleven_v3">Eleven v3</option><option value="eleven_flash_v2_5">Flash v2.5</option><option value="eleven_turbo_v2_5">Turbo v2.5</option></select></label><label>保存文件夹<input id="vs-output" class="input" placeholder="默认：下载 / VideoKit声音生产">${button('browse-output', '选择文件夹')}</label></div>
        <div class="vs-toolbar">${button('plan', '新建并预分配')}${button('use-existing-rows', '导入现有批量配音文案')}${button('replan', '重新分配未完成任务')}${button('start', '开始 / 继续生产')}${button('stop-production', '停止后续文案')}</div>
        <p class="hint">每篇文案保持一个声音。不同声音按绑定账号余额分配；同一账号多把 Key 共用余额。预估仅供分配，实际扣费以服务端为准。每篇文案整篇一次请求，不拆分、不拼接。超过模型单次长度上限时暂停该文案，需更换支持整篇长度的模型。</p>
        <label>生产记录<select id="vs-jobs" class="select"></select></label><div id="vs-job-list"></div></section>`;
        document.body.appendChild(dialog);
        dialog.addEventListener('click', e => { const b = e.target.closest('[data-vs]'); if (b) handle(b).catch(e => notice(e.message, true)); });
        dialog.addEventListener('change', async e => {
            try {
                if (e.target.matches('[data-pool]')) { e.target.checked ? selectedVoices.add(e.target.value) : selectedVoices.delete(e.target.value); }
                if (e.target.matches('[data-candidate]')) { const d = state.designs.find(d => d.id === focused); if (d) d.selected_id = e.target.value; apply(await call('edit-design', { id: focused, patch: { selected_id: e.target.value } })); renderReview(); }
                if (e.target.id === 'vs-save-name') { apply(await call('edit-design', { id: focused, patch: { name: e.target.value } })); }
                if (e.target.id === 'vs-jobs') { jobId = e.target.value; const job = state.jobs.find(j => j.id === jobId); if (job && Array.from($('vs-tts-model').options).some(o => o.value === job.model_id)) $('vs-tts-model').value = job.model_id; selectedVoices = new Set(state.jobs.find(j => j.id === jobId)?.voice_ids || []); renderPool(); renderJobs(); }
                if (e.target.id === 'vs-design-file' || e.target.id === 'vs-copy-file') {
                    const file = e.target.files[0]; if (file) $(e.target.id === 'vs-design-file' ? 'vs-import' : 'vs-copy').value = await file.text();
                }
            } catch (err) { notice(err.message, true); }
        });
        $('vs-search').addEventListener('input', renderLibrary);
        dialog.addEventListener('play', e => { dialog.querySelectorAll('audio').forEach(a => { if (a !== e.target) a.pause(); }); }, true);
        dialog.addEventListener('close', () => { dialog.querySelectorAll('audio').forEach(a => a.pause()); clearTimeout(pollTimer); });
    }
    async function refreshAccounts() { notice('正在查询账号余额和可用模型…'); const r = await call('accounts'); balances = r.accounts; renderModels(); renderPool(); notice('账号余额已刷新'); }
    function renderTabs() {
        $('vs-design-input').hidden = !['single', 'batch'].includes(activeTab);
        $('vs-review').hidden = !['single', 'batch'].includes(activeTab);
        $('vs-single-controls').hidden = activeTab !== 'single'; $('vs-batch-controls').hidden = activeTab !== 'batch';
        $('vs-library').hidden = activeTab !== 'library'; $('vs-production').hidden = activeTab !== 'production';
        document.querySelectorAll('#voice-studio-dialog [data-tab]').forEach(b => b.classList.toggle('btn-primary', b.dataset.tab === activeTab));
        renderReview(); renderLibrary(); renderPool(); renderJobs();
    }
    function renderReview(preserveAudio = false) {
        if (!focused || !state.designs.some(d => d.id === focused)) focused = state.designs.at(-1)?.id || '';
        $('vs-design-list').innerHTML = state.designs.slice().reverse().map(d => `<div class="vs-card ${focused === d.id ? 'vs-selected' : ''}">${button('focus', esc(d.name), `data-id="${esc(d.id)}"`)} <span>${esc(statuses[d.status] || d.status)}</span><p>${esc(d.description)}</p><small>${esc(state.keys.find(k => k.key_id === d.key_id)?.label || '绑定 Key 不可用')}</small><p class="vs-error">${esc(d.error || '')}</p>${button('regenerate', '再次生成', `data-id="${esc(d.id)}"`)}${button('edit', '编辑描述', `data-id="${esc(d.id)}"`)}${button('forget', '移除任务', `data-id="${esc(d.id)}"`)}</div>`).join('') || '<p class="hint">生成声音后，在这里选择任务并试听。</p>';
        const d = state.designs.find(d => d.id === focused);
        const signature = d ? `${d.id}:${d.candidates.length}` : '';
        if (preserveAudio && $('vs-candidates').dataset.signature === signature) return;
        $('vs-candidates').dataset.signature = signature;
        $('vs-candidates').innerHTML = d ? `<label>保存名称<input id="vs-save-name" class="input" value="${esc(d.name)}"></label><div class="vs-toolbar">${button('save-next', '保存选中并下一条')}${button('next', '跳过 / 下一条')}</div>` + d.candidates.map((c, i) => `<div class="vs-card"><label><input type="radio" name="vs-candidate" data-candidate value="${esc(c.id)}" ${d.selected_id === c.id ? 'checked' : ''}> 候选 ${i + 1} · ${esc(c.model_id)}${c.voice_id ? ' · 已保存' : ''}</label><audio${/^local-media:/i.test(String(esc(media(c.preview_path)))) ? ' crossorigin="anonymous"' : ''} controls preload="none" src="${esc(media(c.preview_path))}"></audio><small>${esc(c.text)}</small><div>${button('save-one', c.voice_id ? '已保存' : c.save_state === 'uncertain' || c.save_state === 'saving' ? '核对保存结果' : '保存此声音', `data-cid="${esc(c.id)}" ${c.voice_id ? 'disabled' : ''}`)}</div></div>`).join('') : '';
    }
    function renderLibrary() {
        const q = $('vs-search').value.toLowerCase();
        $('vs-library-list').innerHTML = state.voices.filter(v => `${v.name} ${v.description}`.toLowerCase().includes(q)).map(v => `<div class="vs-card"><strong>${esc(v.name)}</strong> · ${esc(v.key_label)}${!v.binding_available ? ' · 绑定不可用' : ''}<p>${esc(v.description)}</p><code>${esc(v.voice_id)}</code>${v.preview_url ? `<audio${/^local-media:/i.test(String(esc(media(v.preview_url)))) ? ' crossorigin="anonymous"' : ''} controls preload="none" src="${esc(media(v.preview_url))}"></audio>` : ''}<div class="vs-toolbar">${button('use', '用于当前配音', `data-voice="${esc(v.voice_id)}"`)}${button('copy-id', '复制 Voice ID', `data-voice="${esc(v.voice_id)}"`)}<select class="select" data-rebind-select>${keyOptions(v.key_id)}</select>${button('rebind', '验证并重新绑定', `data-voice="${esc(v.voice_id)}"`)}</div></div>`).join('') || '<p class="hint">暂无声音。先创建并保存，或同步账号中的现有声音。</p>';
    }
    function renderModels() {
        const select = $('vs-tts-model');
        const previous = select.value;
        const models = new Map();
        for (const account of balances.filter(a => a.enabled && !a.error)) for (const model of account.models || []) {
            if (model.can_do_text_to_speech && model.model_id) models.set(model.model_id, model);
        }
        if (!models.size) return;
        select.innerHTML = [...models.values()].map(m => `<option value="${esc(m.model_id)}">${esc(m.name || m.model_id)}</option>`).join('');
        if (models.has(previous)) select.value = previous;
    }
    function renderPool() {
        $('vs-pool').innerHTML = state.voices.map(v => {
            const a = balances.find(a => a.key_id === v.key_id);
            return `<label class="vs-card vs-pool-row"><input type="checkbox" data-pool value="${esc(v.voice_id)}" ${selectedVoices.has(v.voice_id) ? 'checked' : ''} ${!v.binding_available ? 'disabled' : ''}><span>${esc(v.name)} · ${esc(v.key_label)}</span><small>${!v.binding_available ? 'Key 不可用' : a?.error ? esc(a.error) : a ? `剩余 ${a.remaining.toLocaleString()} credits` : '余额待查询'}</small></label>`;
        }).join('') || '<p class="hint">请先保存声音，或同步账号声音。</p>';
    }
    function renderJobs() {
        const select = $('vs-jobs');
        if (!jobId) jobId = state.jobs.at(-1)?.id || '';
        select.innerHTML = state.jobs.slice().reverse().map(j => `<option value="${esc(j.id)}" ${j.id === jobId ? 'selected' : ''}>${esc(j.created_at.slice(0, 19).replace('T', ' '))} · ${j.items.length} 篇 · ${esc(statuses[j.status] || j.status)}</option>`).join('');
        const job = state.jobs.find(j => j.id === jobId);
        if (!job) { $('vs-job-list').innerHTML = '<p class="hint">预分配后可以查看每篇文案的声音、预计额度和进度。</p>'; return; }
        $('vs-job-list').innerHTML = `<p>模型：${esc(job.model_id)} · 保存至：${esc(job.output_dir)} · ${esc(job.error || '')}</p><div class="vs-table-wrap"><table class="vs-table"><thead><tr><th>文案</th><th>声音 / 账号</th><th>预计剩余消耗</th><th>整篇进度</th><th>状态 / 结果</th></tr></thead><tbody>${job.items.map(i => `<tr><td>${esc(i.name)}<small>${Array.from(i.text).length} 字符</small></td><td>${esc(i.voice_name || '待分配')}<small>${esc(state.keys.find(k => k.key_id === i.key_id)?.label || '')}</small></td><td>${i.estimated_credits ?? '—'}</td><td>${i.parts.length} / ${i.chunks?.length || '—'}</td><td>${esc(statuses[i.status] || i.status)}<small class="vs-error">${esc(i.error || '')}</small>${i.file_path ? `<audio${/^local-media:/i.test(String(esc(media(i.file_path)))) ? ' crossorigin="anonymous"' : ''} controls preload="none" src="${esc(media(i.file_path))}"></audio>${button('reveal', '打开文件位置', `data-path="${esc(i.file_path)}"`)}` : ''}${i.inflight && !job.running ? button('acknowledge', '核对后允许重试', `data-item="${esc(i.id)}"`) : ''}</td></tr>`).join('')}</tbody></table></div>`;
        if (job.running) schedulePoll();
    }
    function schedulePoll() {
        clearTimeout(pollTimer);
        if (!$('voice-studio-dialog').open) return;
        pollTimer = setTimeout(async () => { try { apply(await call()); renderJobs(); } catch (e) { notice(e.message, true); } }, 1800);
    }
    function formRow() { return { name: $('vs-name').value, description: $('vs-description').value, key_id: $('vs-key').value,
        text: $('vs-preview-text').value, model_id: $('vs-model').value, should_enhance: $('vs-enhance').checked }; }
    async function synchronize() {
        apply(await call());
        renderTabs();
        if (typeof loadVoices === 'function') await loadVoices();
        if (typeof refreshVWVoices === 'function') await refreshVWVoices();
    }
    async function save(id, cid) {
        notice('正在保存声音…'); apply(await call('save', { id, candidate_id: cid }));
        await synchronize(); notice('声音已保存，并绑定创建账号的 Key');
    }
    function next() {
        const idx = state.designs.findIndex(d => d.id === focused);
        const ordered = [...state.designs.slice(idx + 1), ...state.designs.slice(0, idx)];
        focused = ordered.find(d => d.status !== 'saved')?.id || ordered[0]?.id || focused;
        renderReview();
    }
    async function handle(b) {
        const action = b.dataset.vs;
        if (action === 'close') { $('voice-studio-dialog').close(); return; }
        if (action === 'stop-designs') { stopDesigns = true; notice('当前请求完成后停止，已有候选会保留'); return; }
        if (action === 'tab') { activeTab = b.dataset.tab; renderTabs(); if (activeTab === 'production' && !balances.length) await refreshAccounts(); return; }
        if (action === 'focus') { focused = b.dataset.id; renderReview(); return; }
        if (action === 'next') { next(); return; }
        if (action === 'copy-id') { await navigator.clipboard.writeText(b.dataset.voice); notice('Voice ID 已复制'); return; }
        if (action === 'reveal') { await window.electronAPI.showItemInFolder(b.dataset.path); return; }
        if (action === 'stop-production') { apply(await call('stop', { job_id: jobId })); renderJobs(); notice('当前整篇请求完成后停止，保留成功音频'); return; }
        if (busy) throw new Error('当前操作正在执行，请等待');
        busy = true; b.disabled = true;
        try {
            if (action === 'refresh') { apply(await call()); renderTabs(); }
            if (action === 'accounts') await refreshAccounts();
            if (action === 'browse-output') { const folder = await window.electronAPI.selectDirectory(); if (folder) $('vs-output').value = folder; }
            if (action === 'single' || action === 'add-design') {
                const r = await call('put-designs', { rows: [formRow()] }); apply(r); focused = r.ids[0]; renderReview();
                if (action === 'single') { notice('正在生成候选声音…'); apply(await call('generate', { id: focused })); renderReview(); notice('候选已生成，请试听并保存'); }
            }
            if (action === 'import-designs') {
                const parsed = parseTable($('vs-import').value);
                if (/^(声音名称|名称|name)$/i.test(parsed[0]?.[0]?.trim())) parsed.shift();
                const defaults = formRow();
                const rows = parsed.map((r, i) => {
                    const token = r[2]?.trim();
                    const match = token ? state.keys.filter(k => k.key_id === token || k.label.endsWith(token)) : [];
                    if (token && match.length !== 1) throw new Error(`第 ${i + 1} 行账号标识无效或重复，请使用唯一 Key 尾号`);
                    return { ...defaults, name: r.length === 1 ? `声音 ${i + 1}` : r[0], description: r.length === 1 ? r[0] : r[1], key_id: token ? match[0].key_id : defaults.key_id };
                });
                const r = await call('put-designs', { rows }); apply(r); focused = r.ids[0]; renderReview(); notice(`已添加 ${rows.length} 条描述`);
            }
            if (action === 'generate-all') {
                stopDesigns = false;
                const ids = state.designs.filter(d => ['draft', 'failed'].includes(d.status)).map(d => d.id);
                let done = 0;
                for (const id of ids) {
                    if (stopDesigns) break;
                    notice(`正在生成 ${done + 1} / ${ids.length}…`);
                    try { apply(await call('generate', { id })); } catch (e) { notice(e.message, true); apply(await call()); }
                    if (done === 0) focused = id; done++; renderReview(true);
                }
                notice(`已处理 ${done} / ${ids.length} 条，候选可逐个试听保存`);
            }
            if (action === 'regenerate') { notice('正在生成新的候选…'); focused = b.dataset.id; apply(await call('generate', { id: focused })); renderReview(); notice('新候选已生成，旧候选保留'); }
            if (action === 'edit') {
                const d = state.designs.find(d => d.id === b.dataset.id); focused = d.id;
                $('vs-name').value = d.name; $('vs-description').value = d.description; $('vs-preview-text').value = d.text; $('vs-key').value = d.key_id; $('vs-model').value = d.model_id;
                notice('描述已载入；修改后点击生成，会新增任务并保留原候选');
            }
            if (action === 'forget') { apply(await call('forget-design', { id: b.dataset.id })); renderReview(); }
            if (action === 'save-one' || action === 'save-next') {
                const d = state.designs.find(d => d.id === focused); const cid = action === 'save-one' ? b.dataset.cid : document.querySelector('#vs-candidates [data-candidate]:checked')?.value || d?.selected_id;
                if (!cid) throw new Error('请先选中一个候选声音');
                apply(await call('edit-design', { id: focused, patch: { name: $('vs-save-name').value } }));
                await save(focused, cid); if (action === 'save-next') next();
            }
            if (action === 'save-selected') {
                let saved = 0, failure = '';
                for (const d of state.designs.filter(d => d.selected_id)) {
                    try { await save(d.id, d.selected_id); saved++; } catch (e) { failure = `${d.name}：${e.message}`; break; }
                }
                notice(failure || `已处理 ${saved} 条选中声音`, !!failure);
            }
            if (action === 'sync-voices') { notice('正在同步各账号声音…'); const result = await call('sync-voices'); apply(result); await synchronize(); notice(result.sync_errors?.length ? `部分账号同步失败：${result.sync_errors.join('；')}` : '账号声音已同步并绑定 Key', !!result.sync_errors?.length); }
            if (action === 'rebind') { apply(await call('rebind', { voice_id: b.dataset.voice, key_id: b.parentElement.querySelector('[data-rebind-select]').value })); await synchronize(); notice('新 Key 已验证并绑定'); }
            if (action === 'use') {
                await synchronize();
                for (const id of ['voice-select', 'tts-batch-voice', 'vw-default-voice']) { if ($(id)) { $(id).value = b.dataset.voice; $(id).dispatchEvent(new Event('change')); } }
                $('voice-studio-dialog').close(); showToast('已选中保存的声音，配音时自动使用绑定 Key', 'success');
            }
            if (action === 'use-existing-rows') {
                const rows = Array.from(document.querySelectorAll('#tts-batch-list .batch-row')).map((r, i) => [`文案 ${i + 1}`, r.querySelector('.batch-text')?.value || '']).filter(r => r[1].trim());
                $('vs-copy').value = rows.map(r => r.map(c => `"${c.replace(/"/g, '""')}"`).join('\t')).join('\n'); notice(`已导入 ${rows.length} 篇文案`);
            }
            if (action === 'plan') {
                const rows = parseTable($('vs-copy').value);
                if (/^(名称|文案名称|name)$/i.test(rows[0]?.[0]?.trim())) rows.shift();
                const items = rows.map((r, i) => ({ name: r.length === 1 ? `文案 ${i + 1}` : r[0], text: r.length === 1 ? r[0] : r[1], requested_voice_id: r[2]?.trim() || '' }));
                notice('正在查询余额并预分配…'); const r = await call('plan', { items, voice_ids: [...selectedVoices], model_id: $('vs-tts-model').value, output_dir: $('vs-output').value.trim() });
                apply(r); jobId = state.jobs.at(-1).id; renderJobs(); notice('预分配完成，请查看声音和额度后开始生产');
            }
            if (action === 'replan') { if (!jobId) throw new Error('请先新建生产任务'); notice('正在重新分配…'); apply(await call('plan', { job_id: jobId, model_id: $('vs-tts-model').value, ...(selectedVoices.size ? { voice_ids: [...selectedVoices] } : {}) })); renderJobs(); notice('未完成任务已重新分配，成功音频保留'); }
            if (action === 'start') { if (!jobId) throw new Error('请先预分配文案'); apply(await call('start', { job_id: jobId })); renderJobs(); notice('生产已开始，可关闭面板；退出程序后可从记录继续'); }
            if (action === 'acknowledge') {
                if (confirm('请先核对 ElevenLabs 历史记录。只有确认这篇文案未生成、未扣费时才允许重试。确认继续？')) { apply(await call('acknowledge', { job_id: jobId, item_id: b.dataset.item })); renderJobs(); }
            }
        } catch (error) {
            try { apply(await call()); renderTabs(); } catch (_) { /* keep the original error */ }
            throw error;
        } finally { busy = false; b.disabled = false; }
    }
    global.VoiceStudio = {
        async open(tab = 'single') {
            mount(); activeTab = tab; $('voice-studio-dialog').showModal(); notice('正在加载声音与任务…');
            try { apply(await call()); $('vs-key').innerHTML = keyOptions(); renderTabs(); notice('可输入描述创建声音，或继续已有任务');
                if (tab === 'production') { if (!selectedVoices.size) selectedVoices = new Set(state.jobs.find(j => j.id === jobId)?.voice_ids || []); await refreshAccounts(); const job = state.jobs.find(j => j.id === jobId); if (job && Array.from($('vs-tts-model').options).some(o => o.value === job.model_id)) $('vs-tts-model').value = job.model_id; }
            } catch (e) { notice(e.message, true); }
        }, parseTable
    };
})(typeof window !== 'undefined' ? window : globalThis);
