/* Shared settings entry for the standalone Google voice studio. */
document.addEventListener('DOMContentLoaded', () => {
    const keys = document.getElementById('gemini-tts-keys');
    const model = document.getElementById('gemini-tts-model');
    const status = document.getElementById('gemini-tts-key-status');
    const results = document.getElementById('gemini-tts-test-results');
    const save = document.getElementById('gemini-tts-save');
    const test = document.getElementById('gemini-tts-test');
    if (!keys || !model || !save || !test) return;

    let editVersion = 0;
    let isRevealed = false;
    const revealedServerSet = new Set();

    const maskClient = (raw) => {
        const k = String(raw || '').trim();
        if (!k || k.includes('••••')) return k;
        return k.length <= 8 ? `${k.slice(0, 2)}••••••••${k.slice(-2)}` : `${k.slice(0, 4)}••••••••${k.slice(-4)}`;
    };

    const revealBtn = document.createElement('button');
    revealBtn.type = 'button';
    revealBtn.className = test.className || 'btn btn-secondary';
    revealBtn.style.cssText = test.style.cssText || 'margin-left:6px;';
    revealBtn.textContent = '👁️ 显示明文';
    test.insertAdjacentElement('afterend', revealBtn);

    const updateRevealLabel = () => {
        revealBtn.textContent = isRevealed ? '🔒 隐藏明文' : '👁️ 显示明文';
    };

    const draft = () => ({
        tts_keys: keys.value.split('\n').map(k => k.trim()).filter(Boolean),
        tts_model: model.value,
    });
    const changed = () => {
        editVersion++;
        status.textContent = '有未保存的 TTS 配置';
    };
    keys.addEventListener('input', changed);
    model.addEventListener('change', changed);

    async function request(endpoint, data) {
        const response = await apiFetch(API_BASE + '/' + endpoint, data === undefined ? {} : {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
        });
        const value = await response.json();
        if (!response.ok || value.error) throw new Error(value.error || '请求失败');
        return value;
    }

    revealBtn.onclick = async () => {
        const currentLines = keys.value.split('\n').map(k => k.trim()).filter(Boolean);
        if (!currentLines.length) return;
        if (!isRevealed) {
            try {
                const res = await request('settings/reveal-keys', { scope: 'google-tts' });
                const plainPool = Array.isArray(res.keys) ? res.keys : [];
                plainPool.forEach(k => { if (k) revealedServerSet.add(k); });
                const used = new Set();
                const next = currentLines.map((line, idx) => {
                    if (!line.includes('••••')) return line;
                    if (idx < plainPool.length && !used.has(idx) && maskClient(plainPool[idx]) === line) {
                        used.add(idx);
                        return plainPool[idx];
                    }
                    for (let i = 0; i < plainPool.length; i++) {
                        if (!used.has(i) && maskClient(plainPool[i]) === line) {
                            used.add(i);
                            return plainPool[i];
                        }
                    }
                    return line;
                });
                keys.value = next.join('\n');
                isRevealed = true;
                updateRevealLabel();
            } catch (err) {
                status.textContent = '读取明文失败：' + err.message;
            }
        } else {
            keys.value = currentLines.map(line => (revealedServerSet.has(line) ? maskClient(line) : line)).join('\n');
            isRevealed = false;
            updateRevealLabel();
        }
    };

    function sync(config) {
        isRevealed = false;
        updateRevealLabel();
        keys.value = (config.tts_keys || []).join('\n');
        model.value = config.tts_model || 'gemini-2.5-flash-preview-tts';
        status.textContent = `已保存 ${config.tts_keys?.length || 0} 个 TTS Key`;
        // Keep both entry points current without touching the general Gemini settings.
        const studioKeys = document.getElementById('gg-api-keys');
        const studioModel = document.getElementById('gg-tts-model');
        if (studioKeys) studioKeys.value = keys.value;
        if (studioModel) studioModel.value = model.value;
    }

    window.addEventListener('vk-gemini-tts-keys-updated', event => {
        if (event.detail) { editVersion++; sync(event.detail); }
    });

    save.onclick = async () => {
        const config = draft();
        const version = editVersion;
        save.disabled = true;
        status.textContent = '正在保存…';
        try {
            const saved = await request('google-tts/keys', { ...config, syncAllKeys: false });
            const maskedKeys = Array.isArray(saved?.keys) ? saved.keys : config.tts_keys.map(maskClient);
            if (version === editVersion) {
                window.dispatchEvent(new CustomEvent('vk-gemini-tts-keys-updated', {
                    detail: { tts_keys: maskedKeys, tts_model: config.tts_model }
                }));
            } else {
                status.textContent = '已保存提交的配置；当前修改尚未保存';
            }
        } catch (error) { status.textContent = '保存失败：' + error.message; }
        finally { save.disabled = false; }
    };

    test.onclick = async () => {
        const config = draft();
        if (!config.tts_keys.length) { status.textContent = '请先填写 TTS Key'; return; }
        test.disabled = true;
        results.style.display = 'none';
        status.textContent = '正在测试当前输入的 Key…';
        try {
            const data = await request('google-tts/test-keys', { keys: config.tts_keys, model: config.tts_model });
            const list = Array.isArray(data.results) ? data.results : [];
            results.textContent = list.map(item => `${item.masked || ''}：${item.message || ''}`).join('\n');
            results.style.display = 'block';
            status.textContent = `测试完成：${list.filter(item => item.valid).length}/${list.length} 通过（测试不会保存配置）`;
        } catch (error) { status.textContent = '测试失败：' + error.message; }
        finally { test.disabled = false; }
    };

    const initialVersion = editVersion;
    request('google-tts/keys').then(config => {
        if (editVersion === initialVersion) sync(config);
    }).catch(error => { status.textContent = '加载失败：' + error.message; });
});
