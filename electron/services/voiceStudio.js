/** Voice Design, account-bound voices and resumable long-form production. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const keyId = key => `key_${hash(key).slice(0, 24)}`;
const count = text => Array.from(String(text)).length;

// Quota is per account, not per API key. Reserve each article's entire cost.
function allocate(items, voices, accounts, modelId) {
    const budgets = new Map();
    for (const a of accounts) if (a.enabled && !a.error && a.account_id) {
        budgets.set(a.account_id, Math.min(budgets.get(a.account_id) ?? Infinity, a.remaining));
    }
    const assigned = new Map();
    return items.map(item => {
        if (item.status === 'completed') return { ...item };
        const pinned = item.parts?.length > 0 || !!item.inflight;
        if (pinned && (item.chunks?.length !== 1 || item.chunks[0] !== item.text)) {
            return { ...item, status: 'blocked', error: '旧任务已按分段方式请求，不能继续分段生产；请核对原结果后新建整篇任务' };
        }
        let lengthError = '';
        const candidates = voices.filter(v => (!item.requested_voice_id || v.voice_id === item.requested_voice_id) &&
            (!pinned || v.voice_id === item.voice_id));
        const choices = candidates.map(v => {
            const a = accounts.find(a => a.key_id === v.key_id && a.enabled && !a.error);
            const model = a?.models?.find(m => m.model_id === modelId && m.can_do_text_to_speech !== false);
            if (!a || !a.account_id || !model) return null;
            const multiplier = Number(model.model_rates?.character_cost_multiplier ?? 1);
            const rate = Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1;
            const limit = Number(model.maximum_text_length_per_request);
            if (!Number.isFinite(limit) || limit < 1) { lengthError = '无法确认模型单次长度上限，请刷新模型信息后重试'; return null; }
            if (count(item.text) > limit) { lengthError = `文案 ${count(item.text)} 字符，超过模型单次上限 ${limit} 字符；请选择支持整篇长度的模型，不会自动分段`; return null; }
            const chunks = [item.text];
            const cost = chunks.slice(item.parts?.length || 0).reduce((n, s) => n + Math.ceil(count(s) * rate), 0);
            return { v, a, chunks, rate, cost, left: budgets.get(a.account_id) ?? 0 };
        }).filter(Boolean).filter(c => c.left >= c.cost)
            .sort((a, b) => (assigned.get(a.v.voice_id) || 0) - (assigned.get(b.v.voice_id) || 0) || b.left - a.left);
        const best = choices[0];
        if (!best) return { ...item, status: 'blocked', error: lengthError || '绑定账号不可用、模型不可用或余额不足以完成整篇文案', ...(pinned ? {} : { voice_id: '', key_id: '' }) };
        budgets.set(best.a.account_id, best.left - best.cost);
        assigned.set(best.v.voice_id, (assigned.get(best.v.voice_id) || 0) + 1);
        return { ...item, voice_id: best.v.voice_id, voice_name: best.v.name, key_id: best.v.key_id,
            account_id: best.a.account_id, chunks: best.chunks, rate: best.rate, estimated_credits: best.cost,
            status: 'queued', error: '' };
    });
}

function createStudio(deps = {}) {
    const api = deps.api || require('./elevenlabs');
    const root = deps.root || path.join(path.dirname(api.getSettingsPath()), 'voice-studio');
    const statePath = path.join(root, 'state.json');
    const locks = new Map();
    const runs = new Map();
    const generating = new Set();
    const saving = new Set();
    fs.mkdirSync(root, { recursive: true });
    function read() {
        if (!fs.existsSync(statePath)) return { version: 1, designs: [], voices: [], jobs: [] };
        return JSON.parse(fs.readFileSync(statePath, 'utf8'));
    }
    function update(fn) {
        const state = read();
        const result = fn(state);
        const temp = `${statePath}.tmp`;
        fs.writeFileSync(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
        fs.renameSync(temp, statePath);
        return result;
    }
    function redact(error) {
        let msg = String(error?.message || error);
        for (const e of credentials()) msg = msg.split(e.key).join('[Key]');
        return msg;
    }
    function credentials() {
        const settings = api.loadSettings();
        let entries = settings.keys_with_status;
        if (!Array.isArray(entries)) entries = entries && typeof entries === 'object' ? Object.values(entries) : [];
        const known = new Set(entries.map(e => typeof e === 'string' ? e : e.key));
        let legacy = settings.api_keys || (settings.api_key ? [settings.api_key] : []);
        if (typeof legacy === 'string') legacy = [legacy];
        entries = [...entries, ...legacy.filter(k => !known.has(k))];
        const seen = new Set();
        return entries.map(e => typeof e === 'string' ? { key: e, enabled: true } : e).filter(e => {
            if (!e?.key || seen.has(e.key)) return false;
            seen.add(e.key); return true;
        }).map(e => ({ ...e, key_id: keyId(e.key), label: `${e.name || e.label || 'API Key'} · …${e.key.slice(-4)}` }));
    }
    function credential(id) {
        const c = credentials().find(c => c.key_id === id);
        if (!c || c.enabled === false) throw new Error('绑定的 API Key 已删除或停用，请在我的声音中重新绑定');
        return c;
    }
    async function exclusive(id, fn) {
        const prior = locks.get(id) || Promise.resolve();
        let release;
        const current = new Promise(resolve => { release = resolve; });
        locks.set(id, current);
        await prior;
        try { return await fn(); } finally { release(); if (locks.get(id) === current) locks.delete(id); }
    }
    async function json(method, url, key, body, timeout = 30000) {
        const res = await api.request(method, url, key, body, timeout);
        if (res.status < 200 || res.status >= 300) {
            const info = api.parseElevenLabsError(res.status, res.body);
            const error = new Error(info.message || `ElevenLabs HTTP ${res.status}`);
            error.httpStatus = res.status; error.detail = info.detailStatus || info.detailCode;
            throw error;
        }
        return JSON.parse(res.body.toString());
    }
    async function accounts() {
        const results = [];
        // Read all real API keys, including disabled keys; never expose credentials.
        for (const c of credentials()) {
            const result = { key_id: c.key_id, label: c.label, enabled: c.enabled !== false };
            try {
                const user = await json('GET', '/user', c.key);
                const sub = user.subscription || await json('GET', '/user/subscription', c.key);
                if (!user.user_id) throw new Error('无法确认账号身份，不能合并额度');
                result.account_id = `account_${hash(user.user_id).slice(0, 24)}`;
                result.remaining = Math.max(0, Number(sub.character_limit || 0) - Number(sub.character_count || 0));
                result.voice_slots_used = sub.voice_slots_used;
                result.voice_limit = sub.voice_limit;
                result.models = await json('GET', '/models', c.key);
            } catch (e) { result.error = redact(e); }
            results.push(result);
        }
        return results;
    }
    function library() {
        const keys = credentials();
        return read().voices.map(v => {
            const c = keys.find(c => c.key_id === v.key_id);
            return { ...v, category: v.category || 'generated', name: v.name,
                preview_url: v.preview_path || v.preview_url || '',
                binding_available: !!c && c.enabled !== false, key_label: c?.label || 'Key 已删除' };
        });
    }
    function snapshot() {
        const s = read();
        // Interrupted work is visible and can be reconciled/resumed, never replayed silently.
        return { ...s, voices: library(), keys: credentials().map(c => ({ key_id: c.key_id, label: c.label, enabled: c.enabled !== false })),
            jobs: s.jobs.map(j => ({ ...j, running: runs.has(j.id) })) };
    }
    function binding(voiceId) {
        const v = read().voices.find(v => v.voice_id === voiceId);
        if (!v) return null;
        return { voice: v, credential: credential(v.key_id) };
    }
    async function rebind(voiceId, id) {
        const c = credential(id);
        await json('GET', `/voices/${encodeURIComponent(voiceId)}`, c.key);
        update(s => {
            const v = s.voices.find(v => v.voice_id === voiceId);
            if (!v) throw new Error('声音不存在');
            v.key_id = id;
        });
        return library();
    }
    async function syncVoices() {
        const failures = [];
        for (const c of credentials().filter(c => c.enabled !== false)) {
            try {
                const voices = await api.getVoices(c.key);
                update(s => {
                    for (const v of voices) {
                        if (s.voices.some(existing => existing.voice_id === v.voice_id)) continue;
                        s.voices.push({ voice_id: v.voice_id, name: v.name.replace(/^\[[^\]]+\]\s*/, ''),
                            description: v.description || '', key_id: c.key_id, category: v.category,
                            preview_url: v.preview_url || '', created_at: new Date().toISOString() });
                    }
                });
            } catch (e) { failures.push(`${c.label}：${redact(e)}`); }
        }
        return { ...snapshot(), sync_errors: failures };
    }
    function putDesigns(rows) {
        if (!Array.isArray(rows) || !rows.length || rows.length > 500) throw new Error('请添加 1–500 条声音描述');
        return update(s => {
            const ids = [];
            for (const row of rows) {
                const existing = row.id && s.designs.find(d => d.id === row.id);
                if (existing && (generating.has(existing.id) || saving.has(existing.id))) throw new Error('任务正在执行');
                const data = { name: String(row.name || '').trim() || '自定义声音',
                    description: String(row.description || '').trim(), key_id: row.key_id,
                    text: String(row.text || '').trim(), model_id: row.model_id || 'eleven_ttv_v3',
                    should_enhance: row.should_enhance === true };
                if (existing) {
                    // Editing is a new generation; preserve old candidates and their original key/description.
                    Object.assign(existing, data); ids.push(existing.id);
                } else {
                    const d = { ...data, id: crypto.randomUUID(), status: 'draft', candidates: [], created_at: new Date().toISOString() };
                    s.designs.push(d); ids.push(d.id);
                }
            }
            return ids;
        });
    }
    function editDesign(id, patch) {
        return update(s => {
            const d = s.designs.find(d => d.id === id);
            if (!d) throw new Error('任务不存在');
            if (patch.selected_id != null) {
                if (!d.candidates.some(c => c.id === patch.selected_id)) throw new Error('候选声音不存在');
                d.selected_id = patch.selected_id;
            }
            if (patch.name != null) d.name = String(patch.name).trim() || d.name;
        });
    }
    async function generate(id) {
        if (generating.has(id)) throw new Error('正在生成，请等待');
        const d = read().designs.find(d => d.id === id);
        if (!d) throw new Error('任务不存在');
        const c = credential(d.key_id);
        if (count(d.description) < 20 || count(d.description) > 1000) throw new Error('声音描述需为 20–1000 个字符');
        if (d.text && (count(d.text) < 100 || count(d.text) > 1000)) throw new Error('试听文本需为 100–1000 个字符，或留空自动生成');
        if (!['eleven_ttv_v3', 'eleven_multilingual_ttv_v2'].includes(d.model_id)) throw new Error('不支持的声音设计模型');
        generating.add(id);
        update(s => { const row = s.designs.find(r => r.id === id); row.status = 'generating'; row.error = ''; });
        try {
            await exclusive(c.key_id, async () => {
                const result = await json('POST', '/text-to-voice/design', c.key, {
                    voice_description: d.description, model_id: d.model_id, should_enhance: d.should_enhance,
                    ...(d.text ? { text: d.text } : { auto_generate_text: true })
                }, 180000);
                if (!Array.isArray(result.previews) || !result.previews.length) throw new Error('接口未返回候选声音');
                const candidates = result.previews.map(p => {
                    if (!p.generated_voice_id || !p.audio_base_64) throw new Error('候选音频数据不完整');
                    const cid = crypto.randomUUID();
                    const previewPath = path.join(root, `${cid}.mp3`);
                    fs.writeFileSync(previewPath, Buffer.from(p.audio_base_64, 'base64'));
                    return { id: cid, generated_voice_id: p.generated_voice_id, preview_path: previewPath,
                        key_id: c.key_id, description: d.description, model_id: d.model_id,
                        duration_secs: p.duration_secs, text: result.text || d.text, created_at: new Date().toISOString() };
                });
                update(s => { const row = s.designs.find(r => r.id === id); row.candidates.push(...candidates); row.status = 'ready'; });
            });
        } catch (e) {
            update(s => { const row = s.designs.find(r => r.id === id); row.status = 'failed'; row.error = redact(e); });
            throw e;
        } finally { generating.delete(id); }
        return snapshot();
    }
    async function saveCandidate(id, candidateId) {
        if (saving.has(id)) throw new Error('正在保存，请等待');
        const d = read().designs.find(d => d.id === id);
        const p = d?.candidates.find(p => p.id === candidateId);
        if (!p) throw new Error('请先选择候选声音');
        if (p.voice_id) return snapshot();
        const c = credential(p.key_id);
        saving.add(id);
        try {
            await exclusive(c.key_id, async () => {
                let remote;
                if (p.save_state === 'saving' || p.save_state === 'uncertain') {
                    const voices = await api.getVoices(c.key);
                    remote = voices.find(v => v.labels?.videokit_candidate === p.id);
                    if (!remote) throw new Error('上次保存结果不明，账号中暂未找到该声音。请稍后重新核对，避免重复创建');
                } else {
                    update(s => { s.designs.find(d => d.id === id).candidates.find(c => c.id === candidateId).save_state = 'saving'; });
                    try {
                        remote = await json('POST', '/text-to-voice', c.key, {
                            voice_name: d.name, voice_description: p.description,
                            generated_voice_id: p.generated_voice_id, labels: { videokit_candidate: p.id }
                        }, 60000);
                    } catch (e) {
                        update(s => { s.designs.find(d => d.id === id).candidates.find(c => c.id === candidateId).save_state = e.httpStatus ? 'failed' : 'uncertain'; });
                        throw e;
                    }
                }
                if (!remote.voice_id) throw new Error('保存返回缺少 Voice ID，请重新核对');
                update(s => {
                    const row = s.designs.find(d => d.id === id);
                    const candidate = row.candidates.find(c => c.id === candidateId);
                    candidate.voice_id = remote.voice_id; candidate.save_state = 'saved'; row.status = 'saved';
                    if (!s.voices.some(v => v.voice_id === remote.voice_id)) s.voices.push({ voice_id: remote.voice_id,
                        name: d.name, description: p.description, key_id: p.key_id, design_model_id: p.model_id,
                        preview_path: p.preview_path, preview_url: remote.preview_url || '', created_at: new Date().toISOString() });
                });
            });
        } finally { saving.delete(id); }
        return snapshot();
    }
    function forgetDesign(id) {
        if (generating.has(id) || saving.has(id)) throw new Error('任务正在执行');
        update(s => { s.designs = s.designs.filter(d => d.id !== id); });
        return snapshot();
    }
    async function plan(data) {
        const old = data.job_id && read().jobs.find(j => j.id === data.job_id);
        if (old && runs.has(old.id)) throw new Error('生产进行中，请先停止');
        const voiceIds = data.voice_ids || old?.voice_ids || [];
        const pinnedIds = (old?.items || []).filter(i => i.parts?.length || i.inflight).map(i => i.voice_id);
        const voices = library().filter(v => [...voiceIds, ...pinnedIds].includes(v.voice_id));
        if (!voices.length) throw new Error('请至少选择一个已保存声音');
        const rows = old?.items || data.items;
        if (!Array.isArray(rows) || !rows.length || rows.length > 1000) throw new Error('请添加 1–1000 篇文案');
        const modelId = data.model_id || old?.model_id || 'eleven_multilingual_v2';
        if (old && modelId !== old.model_id && old.items.some(i => i.status !== 'completed' && (i.parts?.length || i.inflight))) {
            throw new Error('未完成任务已有音频或请求结果不明，请先核对原结果，不能更换其生成模型');
        }
        const balances = await accounts();
        const items = allocate(rows.map((r, i) => {
            const text = String(r.text || '').trim();
            if (!text) throw new Error(`第 ${i + 1} 篇文案为空`);
            return { ...r, id: r.id || crypto.randomUUID(), name: r.name || `文案 ${i + 1}`, text, parts: r.parts || [] };
        }), voices, balances, modelId).map(i => i.inflight ? { ...i, status: 'uncertain', error: '上次整篇请求结果不明，请先核对历史再继续' } : i);
        const outputDir = old?.output_dir || data.output_dir || (deps.outputDir || path.join(require('os').homedir(), 'Downloads', 'VideoKit声音生产'));
        if (!path.isAbsolute(outputDir)) throw new Error('保存文件夹必须是完整绝对路径');
        const job = { ...(old || {}), id: old?.id || crypto.randomUUID(), model_id: modelId,
            voice_ids: voices.map(v => v.voice_id), output_dir: outputDir, items, accounts: balances,
            status: 'planned', stop_requested: false, created_at: old?.created_at || new Date().toISOString() };
        update(s => { const idx = s.jobs.findIndex(j => j.id === job.id); if (idx < 0) s.jobs.push(job); else s.jobs[idx] = job; });
        return snapshot();
    }
    function stop(id) {
        update(s => { const j = s.jobs.find(j => j.id === id); if (j) { j.stop_requested = true; j.status = 'stopping'; } });
        return snapshot();
    }
    const getJob = id => read().jobs.find(j => j.id === id);
    function patchItem(jobId, itemId, patch) {
        update(s => { Object.assign(s.jobs.find(j => j.id === jobId).items.find(i => i.id === itemId), patch); });
    }
    async function produce(jobId, itemId) {
        let job = getJob(jobId), item = job.items.find(i => i.id === itemId);
        if (job.stop_requested || item.status === 'completed') return;
        if (item.chunks?.length !== 1 || item.chunks[0] !== item.text) {
            throw new Error('当前任务使用旧分段计划，请重新分配为整篇请求；不会继续分段生成');
        }
        const c = credential(item.key_id);
        await exclusive(item.account_id || c.key_id, async () => {
            job = getJob(jobId); item = job.items.find(i => i.id === itemId);
            if (job.stop_requested) return;
            if (item.inflight) throw new Error('上次整篇请求结果不明，需先核对 ElevenLabs 历史，确认后再继续');
            if (item.parts.some(p => !fs.existsSync(p))) throw new Error('已生成整篇音频丢失，请恢复文件后继续，避免重复扣费');
            const dir = path.join(root, 'production', jobId, itemId);
            fs.mkdirSync(dir, { recursive: true });
            patchItem(jobId, itemId, { status: 'running', error: '' });
            for (let n = item.parts.length; n < item.chunks.length; n++) {
                if (getJob(jobId).stop_requested) { patchItem(jobId, itemId, { status: 'paused' }); return; }
                const currentKey = credential(item.key_id).key;
                const quota = await api.getQuota(currentKey);
                const needed = item.chunks.slice(n).reduce((total, text) => total + Math.ceil(count(text) * item.rate), 0);
                if (quota.limit - quota.usage < needed) throw new Error('账号余额不足以完成整篇文案');
                if (getJob(jobId).stop_requested) { patchItem(jobId, itemId, { status: 'paused' }); return; }
                const partPath = path.join(dir, `${n}.mp3`);
                // Persist before sending a charged request. A crash never silently replays it.
                patchItem(jobId, itemId, { inflight: { index: n, started_at: new Date().toISOString() } });
                try {
                    const res = await api.request('POST', `/text-to-speech/${encodeURIComponent(item.voice_id)}?output_format=mp3_44100_128`, currentKey, {
                        text: item.chunks[n], model_id: job.model_id,
                        voice_settings: { stability: 0.5, similarity_boost: 0.75 }
                    }, 300000);
                    if (res.status !== 200) {
                        patchItem(jobId, itemId, { inflight: null });
                        const info = api.parseElevenLabsError(res.status, res.body);
                        throw new Error(info.message || `HTTP ${res.status}`);
                    }
                    if (!res.body.length) throw new Error('接口返回空音频，请核对历史');
                    fs.writeFileSync(partPath, res.body);
                    item.parts.push(partPath);
                    patchItem(jobId, itemId, { parts: item.parts, inflight: null });
                } catch (e) { throw e; }
            }
            fs.mkdirSync(job.output_dir, { recursive: true });
            const safeName = String(item.name).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 70) || 'audio';
            const outputPath = path.join(job.output_dir, `${safeName}-${item.id.slice(0, 8)}.mp3`);
            fs.copyFileSync(item.parts[0], outputPath);
            patchItem(jobId, itemId, { status: 'completed', file_path: outputPath, error: '' });
        });
    }
    function start(id) {
        if (runs.has(id)) return snapshot();
        const j = getJob(id);
        if (!j) throw new Error('生产任务不存在');
        update(s => { const j = s.jobs.find(j => j.id === id); j.status = 'running'; j.stop_requested = false; });
        const run = (async () => {
            // One article at a time makes live quota checks and recovery deterministic.
            for (const original of getJob(id).items) {
                if (getJob(id).stop_requested) break;
                const item = getJob(id).items.find(i => i.id === original.id);
                if (item.status === 'completed' || item.status === 'blocked') continue;
                const tried = new Set();
                while (!getJob(id).stop_requested) {
                    try { await produce(id, item.id); break; }
                    catch (e) {
                        const current = getJob(id).items.find(i => i.id === item.id);
                        tried.add(current.account_id);
                        // Switching is safe only before any audio or ambiguous charged request exists.
                        if (!current.parts.length && !current.inflight && !current.requested_voice_id &&
                            /quota|credits?|balance|额度|余额|401|invalid.*key|unauthorized|Key.*(?:删除|停用)/i.test(redact(e))) {
                            const balances = (await accounts()).filter(a => !tried.has(a.account_id));
                            const voices = library().filter(v => getJob(id).voice_ids.includes(v.voice_id));
                            const [replacement] = allocate([current], voices, balances, getJob(id).model_id);
                            if (replacement.status === 'queued') {
                                patchItem(id, item.id, replacement);
                                continue;
                            }
                        }
                        patchItem(id, item.id, { status: current.inflight ? 'uncertain' : 'failed', error: redact(e) });
                        break;
                    }
                }
            }
            update(s => { const job = s.jobs.find(j => j.id === id); job.status = job.stop_requested ? 'paused' : job.items.every(i => i.status === 'completed') ? 'completed' : 'needs_attention'; });
        })().catch(e => update(s => { const job = s.jobs.find(j => j.id === id); job.status = 'needs_attention'; job.error = redact(e); })).finally(() => runs.delete(id));
        runs.set(id, run);
        return snapshot();
    }
    function acknowledge(id, itemId) {
        if (runs.has(id)) throw new Error('请先停止任务');
        patchItem(id, itemId, { inflight: null, status: 'paused', error: '' });
        return snapshot();
    }
    return { snapshot, library, binding, accounts, rebind, syncVoices, putDesigns, editDesign, generate, saveCandidate,
        forgetDesign, plan, start, stop, acknowledge, wait: id => runs.get(id) || Promise.resolve() };
}
let singleton;
function studio() { if (!singleton) singleton = createStudio(); return singleton; }
module.exports = { createStudio, studio, keyId, allocate, count };
