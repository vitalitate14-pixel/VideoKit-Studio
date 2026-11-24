/**
 * Settings and file management service
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const archiver = require('archiver');
const { isBlockedSensitivePath, isBlockedWritePath } = require('./pathSecurity');
const cacheManager = require('./cacheManager');

// ==================== JSON Settings ====================

function getBackendDir() {
    let dir = null;
    try {
        const { app } = require('electron');
        if (app && typeof app.getPath === 'function') {
            dir = path.join(app.getPath('userData'), 'backend');
        }
    } catch { }

    if (!dir) {
        dir = path.join(os.homedir(), 'Library', 'Application Support', 'videokit', 'backend');
    }
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function getAllCandidateBackendDirs() {
    const list = [getBackendDir()];
    try {
        const legacy1 = path.join(os.homedir(), 'Library', 'Application Support', 'videokit', 'backend');
        if (!list.includes(legacy1) && fs.existsSync(legacy1)) list.push(legacy1);
    } catch { }
    try {
        const legacy2 = path.join(os.homedir(), 'Library', 'Application Support', 'pymediatools', 'backend');
        if (!list.includes(legacy2) && fs.existsSync(legacy2)) list.push(legacy2);
    } catch { }
    try {
        const workspaceDir = path.join(__dirname, '..', '..', 'backend');
        if (!list.includes(workspaceDir) && fs.existsSync(workspaceDir)) list.push(workspaceDir);
    } catch { }
    return list;
}

function getSecureTmpDir(subDir) {
    let dir;
    try {
        const { app } = require('electron');
        if (app && typeof app.getPath === 'function') {
            dir = cacheManager.getEffectiveTmpDir(app.getPath('userData'), subDir);
        }
    } catch { }
    if (!dir) {
        const fallbackBase = path.join(os.homedir(), '.videokit_tmp');
        dir = subDir ? path.join(fallbackBase, subDir) : fallbackBase;
    }
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function secureTmpFile(prefix, ext) {
    const dir = getSecureTmpDir();
    const safePrefix = String(prefix || 'tmp')
        .replace(/[\0/\\:*?"<>|]/g, '_')
        .replace(/\.\.+/g, '_')
        .slice(0, 80) || 'tmp';
    const safeExt = String(ext || '')
        .replace(/[\0/\\:*?"<>|]/g, '')
        .replace(/\.\.+/g, '')
        .slice(0, 20);
    const fullPath = path.resolve(dir, `${safePrefix}_${crypto.randomUUID()}${safeExt}`);
    const dirRoot = path.resolve(dir) + path.sep;
    if (!fullPath.startsWith(dirRoot)) {
        throw new Error('安全策略拦截：临时文件路径越界');
    }
    return fullPath;
}

function readJSON(filePath) {
    if (!fs.existsSync(filePath)) return null;
    try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')); } catch { return null; }
}

function writeJSON(filePath, data) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 });
    if (process.platform !== 'win32') {
        try { fs.chmodSync(filePath, 0o600); } catch { }
    }
}

function readEnvKeys(...envNames) {
    const out = [];
    for (const name of envNames) {
        const raw = process.env[name];
        if (!raw || typeof raw !== 'string') continue;
        for (const item of raw.split(/[\r\n,]+/)) {
            const clean = item.trim();
            if (clean && !out.includes(clean)) out.push(clean);
        }
    }
    return out;
}

// Gladia Keys
function getGladiaKeysPath() { return path.join(getBackendDir(), 'gladia_keys.json'); }

function getSafeStorage() {
    try {
        const electron = require('electron');
        if (!electron || typeof electron !== 'object') return null;
        if (electron.app && typeof electron.app.isReady === 'function' && !electron.app.isReady()) {
            return null;
        }
        return electron.safeStorage || null;
    } catch {
        return null;
    }
}

function isSafeStorageReady() {
    const safeStorage = getSafeStorage();
    try { return Boolean(safeStorage?.isEncryptionAvailable?.()); } catch { return false; }
}

function encryptJsonSecret(value) {
    if (!isSafeStorageReady()) return null;
    try {
        return getSafeStorage().encryptString(JSON.stringify(value)).toString('base64');
    } catch {
        return null;
    }
}

function decryptJsonSecret(base64Str) {
    if (!base64Str || typeof base64Str !== 'string' || !isSafeStorageReady()) return undefined;
    try {
        return JSON.parse(getSafeStorage().decryptString(Buffer.from(base64Str, 'base64')));
    } catch {
        return undefined;
    }
}

function maskApiKey(key) {
    if (!key) return '';
    const value = String(key).trim();
    if (!value) return '';
    if (value === '__WEB_TOKEN__') return '__WEB_TOKEN__';
    if (value.includes('••••')) return value;
    if (value.length <= 8) return '••••••••';
    return `${value.slice(0, 4)}••••••••${value.slice(-4)}`;
}

function _legacyShortMask(key) {
    const value = String(key || '').trim();
    if (value.length <= 8) return '••••••••';
    return `${value.slice(0, 4)}••••${value.slice(-4)}`;
}

function isMaskedApiKey(value) {
    return typeof value === 'string' && value.includes('••••');
}

/**
 * 将前端提交的密钥列表还原为真实密钥列表：
 * - 若条目未脱敏（用户新粘贴或已点击显示并修改），直接使用该明文；
 * - 若条目是脱敏占位串（含 ••••），自动按顺序匹配回磁盘已有的真实 Key，
 *   彻底杜绝「未展开明文直接点保存把星号写进配置文件覆盖真 Key」的问题。
 */
function resolveSubmittedKeys(submittedKeys, existingRealKeys = []) {
    const list = Array.isArray(submittedKeys) ? submittedKeys : [];
    const realPool = (Array.isArray(existingRealKeys) ? existingRealKeys : [])
        .map(k => String(k || '').trim())
        .filter(Boolean);
    const usedIndices = new Set();
    const out = [];

    for (const raw of list) {
        const clean = String(raw || '').trim();
        if (!clean) continue;
        if (!isMaskedApiKey(clean)) {
            out.push(clean);
            continue;
        }
        let matchedIdx = -1;
        for (let i = 0; i < realPool.length; i++) {
            if (usedIndices.has(i)) continue;
            if (maskApiKey(realPool[i]) === clean || _legacyShortMask(realPool[i]) === clean) {
                matchedIdx = i;
                break;
            }
        }
        if (matchedIdx !== -1) {
            usedIndices.add(matchedIdx);
            out.push(realPool[matchedIdx]);
        }
    }
    return [...new Set(out)];
}

function buildEncryptedKeyPayload(keys) {
    const cleanKeys = [...new Set((Array.isArray(keys) ? keys : []).map(k => String(k || '').trim()).filter(Boolean))];
    const enc = encryptJsonSecret(cleanKeys);
    if (enc) {
        return { keys_encrypted: enc };
    }
    return { keys: cleanKeys };
}

function decryptTranscriptionKeys(payload) {
    if (!payload || typeof payload !== 'object') return [];
    if (payload.keys_encrypted) {
        const dec = decryptJsonSecret(payload.keys_encrypted);
        if (Array.isArray(dec)) {
            return dec.map(k => String(k || '').trim()).filter(Boolean);
        }
    }
    if (Array.isArray(payload.keys) && payload.keys.length > 0) {
        return payload.keys.map(k => String(k || '').trim()).filter(Boolean);
    }
    return [];
}

function loadGladiaKeys() {
    const allKeys = [];
    for (const dir of getAllCandidateBackendDirs()) {
        const file = path.join(dir, 'gladia_keys.json');
        const data = readJSON(file);
        const fileKeys = decryptTranscriptionKeys(data);
        for (const k of fileKeys) {
            if (k && !allKeys.includes(k)) allKeys.push(k);
        }
    }
    // Also check if transcription_providers.json has Gladia keys
    for (const dir of getAllCandidateBackendDirs()) {
        const transPath = path.join(dir, 'transcription_providers.json');
        const trans = readJSON(transPath);
        const pKeys = decryptTranscriptionKeys(trans?.providers?.gladia);
        for (const k of pKeys) {
            if (k && !allKeys.includes(k)) allKeys.push(k);
        }
    }
    for (const envKey of readEnvKeys('GLADIA_API_KEY', 'GLADIA_API_KEYS')) {
        if (!allKeys.includes(envKey)) allKeys.push(envKey);
    }
    return { keys: allKeys };
}

function getPublicGladiaKeys() {
    const { keys } = loadGladiaKeys();
    return { keys: keys.map(maskApiKey) };
}

function saveGladiaKeys(data) {
    const existing = loadGladiaKeys().keys || [];
    const submitted = Array.isArray(data?.keys) ? data.keys : [];
    const resolvedKeys = resolveSubmittedKeys(submitted, existing);
    const payload = buildEncryptedKeyPayload(resolvedKeys);
    const primaryFile = getGladiaKeysPath();
    writeJSON(primaryFile, payload);
    
    // Sync to existing candidate dirs so legacy plaintext copies don't resurrect deleted keys
    for (const dir of getAllCandidateBackendDirs()) {
        const target = path.join(dir, 'gladia_keys.json');
        if (target !== primaryFile && fs.existsSync(target)) {
            try { writeJSON(target, payload); } catch { }
        }
    }

    // Also sync to transcription_providers.json
    try {
        const transPath = getTranscriptionSettingsPath();
        const trans = readJSON(transPath) || { version: 1, providers: {} };
        if (!trans.providers) trans.providers = {};
        trans.providers.gladia = buildEncryptedKeyPayload(resolvedKeys);
        writeJSON(transPath, trans);
    } catch { }
}

// Cloud transcription providers (Deepgram, Groq, Gladia)
function getTranscriptionSettingsPath() { return path.join(getBackendDir(), 'transcription_providers.json'); }

function normalizeProvider(value) {
    return ['deepgram', 'groq', 'gladia'].includes(value) ? value : null;
}

function getEffectiveConcurrency(config) {
    return 1;
}

function loadTranscriptionProviders() {
    const commonPath = getTranscriptionSettingsPath();
    const raw = readJSON(commonPath);
    
    // Auto-migrate from all candidate backend dirs
    const candidateDirs = getAllCandidateBackendDirs();
    const mergedProviders = { deepgram: [], groq: [], gladia: [] };
    let foundPrimary = null;
    let foundConcurrency = null;

    for (const dir of candidateDirs) {
        const file = path.join(dir, 'transcription_providers.json');
        const fileData = readJSON(file);
        if (fileData) {
            if (!foundPrimary && fileData.primary) foundPrimary = fileData.primary;
            if (!foundConcurrency && fileData.concurrency) foundConcurrency = fileData.concurrency;
            for (const name of ['deepgram', 'groq', 'gladia']) {
                const p = fileData.providers?.[name];
                if (p) {
                    const keys = decryptTranscriptionKeys(p);
                    for (const k of keys) {
                        if (k && !mergedProviders[name].includes(k)) mergedProviders[name].push(k);
                    }
                }
            }
        }
    }

    // Always merge historical gladia_keys.json into gladia provider
    const gladiaLegacy = loadGladiaKeys().keys || [];
    for (const k of gladiaLegacy) {
        if (k && !mergedProviders.gladia.includes(k)) mergedProviders.gladia.push(k);
    }

    for (const k of readEnvKeys('DEEPGRAM_API_KEY', 'DEEPGRAM_API_KEYS')) {
        if (!mergedProviders.deepgram.includes(k)) mergedProviders.deepgram.push(k);
    }
    for (const k of readEnvKeys('GROQ_API_KEY', 'GROQ_API_KEYS')) {
        if (!mergedProviders.groq.includes(k)) mergedProviders.groq.push(k);
    }

    const primary = normalizeProvider(foundPrimary || raw?.primary) || 'deepgram';
    const allProviders = ['deepgram', 'groq', 'gladia'];
    const others = allProviders.filter(p => p !== primary);

    const result = {
        primary,
        fallback: others[0] || 'groq',
        rescue: others[1] || 'gladia',
        concurrency: 1,
        providers: {
            deepgram: { keys: mergedProviders.deepgram, source: mergedProviders.deepgram.length ? 'saved' : 'none' },
            groq: { keys: mergedProviders.groq, source: mergedProviders.groq.length ? 'saved' : 'none' },
            gladia: { keys: mergedProviders.gladia, source: mergedProviders.gladia.length ? 'saved' : 'none' }
        }
    };

    // If common storage was missing or didn't have keys/encrypted keys yet, persist now
    const hasSavedGladia = Array.isArray(raw?.providers?.gladia?.keys) || Boolean(raw?.providers?.gladia?.keys_encrypted);
    if (!raw || !raw.providers || !hasSavedGladia) {
        try {
            saveTranscriptionProviders({
                primary: result.primary,
                concurrency: result.concurrency,
                deepgram_keys: result.providers.deepgram.keys,
                groq_keys: result.providers.groq.keys,
                gladia_keys: result.providers.gladia.keys,
            });
        } catch (_) { }
    }

    return result;
}

function getPublicTranscriptionProviders() {
    const data = loadTranscriptionProviders();
    return {
        primary: data.primary,
        fallback: data.fallback,
        rescue: data.rescue,
        concurrency: data.concurrency,
        providers: Object.fromEntries(Object.entries(data.providers).map(([name, item]) => [name, {
            configured: item.keys.length > 0,
            keyCount: item.keys.length,
            keyPreviews: item.keys.map(maskApiKey),
            editableKeys: item.keys.map(maskApiKey),
            source: item.source,
        }])),
    };
}

function saveTranscriptionProviders(input = {}) {
    const existing = loadTranscriptionProviders();
    const providers = {};
    const resolvedByProvider = {};
    for (const name of ['deepgram', 'groq', 'gladia']) {
        const existingKeys = existing.providers?.[name]?.keys || [];
        let keys;
        if (Object.prototype.hasOwnProperty.call(input, `${name}_keys`)) {
            keys = resolveSubmittedKeys(input[`${name}_keys`], existingKeys);
        } else {
            keys = [...new Set(existingKeys)];
        }
        resolvedByProvider[name] = keys;
        providers[name] = buildEncryptedKeyPayload(keys);
    }

    const primary = normalizeProvider(input.primary) || normalizeProvider(existing.primary) || 'deepgram';
    const allProviders = ['deepgram', 'groq', 'gladia'];
    const others = allProviders.filter(p => p !== primary);
    // 总设置只服务于其他转录入口，固定串行。自动剪辑会在每次请求中单独覆盖。
    const concurrency = 1;

    const payload = {
        version: 1,
        primary,
        fallback: others[0] || 'groq',
        rescue: others[1] || 'gladia',
        concurrency,
        providers,
    };

    // 写入主配置目录，并同步已存在的历史候选文件（用加密结构替换旧明文，防止已删旧 Key 复活）
    const primaryTransFile = getTranscriptionSettingsPath();
    writeJSON(primaryTransFile, payload);
    const candidateDirs = getAllCandidateBackendDirs();
    for (const dir of candidateDirs) {
        const candidateFile = path.join(dir, 'transcription_providers.json');
        if (candidateFile !== primaryTransFile && fs.existsSync(candidateFile)) {
            try { writeJSON(candidateFile, payload); } catch { }
        }
    }

    // 3. Keep gladia_keys.json in sync for legacy compatibility
    try {
        const gladiaPayload = buildEncryptedKeyPayload(resolvedByProvider.gladia || []);
        const primaryGladiaFile = getGladiaKeysPath();
        writeJSON(primaryGladiaFile, gladiaPayload);
        for (const dir of candidateDirs) {
            const candidateGladia = path.join(dir, 'gladia_keys.json');
            if (candidateGladia !== primaryGladiaFile && fs.existsSync(candidateGladia)) {
                try { writeJSON(candidateGladia, gladiaPayload); } catch { }
            }
        }
    } catch { }

    return getPublicTranscriptionProviders();
}

// Gemini Keys
const DEFAULT_GEMINI_PROMPT = "ElevenLabs 配音文案格式化助手 — 为祷告/宣告/属灵鼓励/短视频旁白文案添加情感标签、拆句断行、排节奏，可直接复制粘贴用于 ElevenLabs 生成配音\n\n## 核心用途\n用于 ElevenLabs 配音\n场景：祷告 / 宣告 / 属灵鼓励 / 短视频旁白\n需要可直接复制粘贴使用\n\n## 情感标签（最重要）\n✅ 只用情感 / 语气标签（如 [calm] [reverent] [faith-filled]）\n❌ 不要 emoji\n❌ 不要解释标签含义\n标签要：克制、稳定、不浮夸、不戏剧化\n\n## 节奏与结构\n每段都有清晰停顿\n常用：[pause]\n适合：跟读、默读、夜间 / 安静场景\n长文也要分层，不能一口气读完\n\n## 语气取向\n偏向：祷告感、安抚感、权柄但不咆哮\n避免：情绪炸裂、表演感、过度煽动\n\n## 内容处理原则\n❌ 不改原文意思\n❌ 不擅自删句\n❌ 不加新神学内容\n❌ 不删除标题\n对于文案中关于上帝的单词、代词都要标准的首字母大写（如 God / He / Him / His / Lord / Father）\n只做三件事：拆句断行、排节奏、加合适的情感标签\n\n## 输出要求 - 分两部分\n你需要输出两个结果，用 ||| 分隔：\n1. 加标签结果：带情感标签的完整文案（用于 ElevenLabs 配音）\n2. 断句结果：根据标签合理断行后的文案（用于字幕显示）\n\n断行规则：\n- 断句合理，符合语言习惯\n- 每行不超过 4 个单词，便于字幕显示\n- 也不要太短（至少有完整的意思单元）\n- 在 [pause] 标签处自然断行\n- 断句结果不包含情感标签，只保留纯文本\n- ⚠️ 断句结果不包含省略号（...），省略号仅用于配音的加标签结果\n\n输出格式示例：\n[calm] Lord... I come before You today, with a grateful heart...\n|||\nLord,\nI come before You today,\nwith a grateful heart.\n\n## 批量处理输出规则\n你需要处理多条文案，每条以 [编号] 开头。\n对于每条文案，输出格式为：[编号] 加标签结果|||断句结果\n⚠️ 断句结果中的换行用 \\\\n 表示（字面的反斜杠n），不要真正换行，保持每条结果在同一行。\n每条结果占一行。";

function getGeminiKeysPath() { return path.join(getBackendDir(), 'gemini_keys.json'); }
function loadGeminiKeys() {
    const raw = readJSON(getGeminiKeysPath()) || {};
    const data = { ...raw };
    const decKeys = raw.keys_encrypted ? decryptJsonSecret(raw.keys_encrypted) : undefined;
    const rawKeys = Array.isArray(decKeys) ? decKeys : (Array.isArray(raw.keys) ? raw.keys : []);
    data.keys = rawKeys.map(k => typeof k === 'string' ? k.trim() : '').filter(Boolean);

    const decTtsKeys = raw.tts_keys_encrypted ? decryptJsonSecret(raw.tts_keys_encrypted) : undefined;
    const rawTtsKeys = Array.isArray(decTtsKeys) ? decTtsKeys : (Array.isArray(raw.tts_keys) ? raw.tts_keys : []);
    if (rawTtsKeys.length > 0 || raw.tts_keys !== undefined || raw.tts_keys_encrypted !== undefined) {
        data.tts_keys = rawTtsKeys.map(k => typeof k === 'string' ? k.trim() : '').filter(Boolean);
    }
    delete data.keys_encrypted;
    delete data.tts_keys_encrypted;

    for (const envKey of readEnvKeys('GEMINI_API_KEY', 'GEMINI_API_KEYS')) {
        if (!data.keys.includes(envKey)) data.keys.push(envKey);
    }
    // 迁移旧版界面曾保存的无效/非标准模型 ID。
    const legacyModelMap = {
        'gemini-3.1-pro': 'gemini-3.1-pro-preview',
        'gemini-3.1-flash': 'gemini-3.5-flash',
        'gemma-4-26b-it': 'gemma-4-26b-a4b-it',
    };
    if (legacyModelMap[data.model]) data.model = legacyModelMap[data.model];
    if (!data.model) data.model = 'gemini-3.5-flash-lite';
    if (!data.prompt || !data.prompt.trim()) {
        data.prompt = DEFAULT_GEMINI_PROMPT;
    }
    return data;
}

function getPublicGeminiKeys() {
    const data = loadGeminiKeys();
    const out = {
        ...data,
        keys: (data.keys || []).map(maskApiKey),
    };
    if (Array.isArray(data.tts_keys)) {
        out.tts_keys = data.tts_keys.map(maskApiKey);
    }
    return out;
}

function saveGeminiKeys(inputData) {
    const existing = loadGeminiKeys();
    const persisted = { ...existing, ...(inputData || {}) };

    const nextKeys = Array.isArray(inputData?.keys)
        ? resolveSubmittedKeys(inputData.keys, existing.keys || [])
        : (existing.keys || []);

    const hasTtsKeys = Array.isArray(inputData?.tts_keys) || Array.isArray(existing.tts_keys);
    const nextTtsKeys = Array.isArray(inputData?.tts_keys)
        ? resolveSubmittedKeys(inputData.tts_keys, [...(existing.tts_keys || []), ...(existing.keys || [])])
        : (existing.tts_keys || []);

    const encKeys = encryptJsonSecret(nextKeys);
    if (encKeys) {
        persisted.keys_encrypted = encKeys;
        delete persisted.keys;
    } else {
        persisted.keys = nextKeys;
        delete persisted.keys_encrypted;
    }

    if (hasTtsKeys) {
        const encTts = encryptJsonSecret(nextTtsKeys);
        if (encTts) {
            persisted.tts_keys_encrypted = encTts;
            delete persisted.tts_keys;
        } else {
            persisted.tts_keys = nextTtsKeys;
            delete persisted.tts_keys_encrypted;
        }
    }

    writeJSON(getGeminiKeysPath(), persisted);
}

// ElevenLabs Settings (shared encryption/decryption for elevenlabs_settings.json)
function getElevenLabsSettingsPath() { return path.join(getBackendDir(), 'elevenlabs_settings.json'); }

function readElevenLabsRawData() {
    const raw = readJSON(getElevenLabsSettingsPath()) || {};
    const data = { ...raw };

    if (!data.web_token && data.web_token_encrypted) {
        const decWeb = decryptJsonSecret(data.web_token_encrypted);
        if (decWeb !== undefined) data.web_token = decWeb;
    }
    if (data.api_keys_encrypted) {
        const decKeys = decryptJsonSecret(data.api_keys_encrypted);
        if (Array.isArray(decKeys)) {
            data.api_keys = decKeys;
            data.api_key = decKeys[0] || '';
        }
    }
    if (data.keys_with_status_encrypted) {
        const decStatus = decryptJsonSecret(data.keys_with_status_encrypted);
        if (Array.isArray(decStatus)) {
            data.keys_with_status = decStatus;
        }
    }
    return data;
}

function writeElevenLabsRawData(data) {
    const persisted = { ...(data || {}) };

    if (persisted.web_token) {
        const encWeb = encryptJsonSecret(persisted.web_token);
        if (encWeb) {
            persisted.web_token_encrypted = encWeb;
            delete persisted.web_token;
        }
    } else if (!persisted.web_token_encrypted) {
        delete persisted.web_token_encrypted;
    }

    if (Array.isArray(persisted.api_keys)) {
        const encApiKeys = encryptJsonSecret(persisted.api_keys);
        if (encApiKeys) {
            persisted.api_keys_encrypted = encApiKeys;
            delete persisted.api_keys;
            delete persisted.api_key;
        }
    }

    if (Array.isArray(persisted.keys_with_status)) {
        const encStatus = encryptJsonSecret(persisted.keys_with_status);
        if (encStatus) {
            persisted.keys_with_status_encrypted = encStatus;
            delete persisted.keys_with_status;
        }
    }

    writeJSON(getElevenLabsSettingsPath(), persisted);
}

function loadElevenLabsSettings() {
    const data = readElevenLabsRawData();
    let keys = data.api_keys || [];
    if (typeof keys === 'string') keys = [keys];
    if (keys.length === 0 && data.api_key) keys = [data.api_key];
    keys = keys.filter(k => typeof k === 'string' && k.trim());
    for (const envKey of readEnvKeys('ELEVENLABS_API_KEY', 'ELEVENLABS_API_KEYS')) {
        if (!keys.includes(envKey)) keys.push(envKey);
    }
    return {
        api_key: keys[0] || '',
        api_keys: keys,
        use_web_token: !!data.use_web_token
    };
}

function getPublicElevenLabsSettings() {
    const data = loadElevenLabsSettings();
    return {
        api_key: maskApiKey(data.api_key),
        api_keys: (data.api_keys || []).map(maskApiKey),
        use_web_token: !!data.use_web_token,
    };
}

function saveElevenLabsSettings(inputData) {
    const existingData = readElevenLabsRawData();
    const existingKeys = loadElevenLabsSettings().api_keys || [];
    let rawSubmitted = inputData.api_keys || [];
    if (typeof rawSubmitted === 'string') rawSubmitted = [rawSubmitted];
    if (rawSubmitted.length === 0 && inputData.api_key) rawSubmitted = [inputData.api_key];
    const keys = resolveSubmittedKeys(rawSubmitted, existingKeys);

    const existingStatus = normalizeElevenLabsKeysWithStatus(existingData.keys_with_status);
    const existingByKey = new Map(existingStatus.map(entry => [entry.key, entry]));
    const keysWithStatus = keys.map(key => ({
        ...(existingByKey.get(key) || {}),
        key,
        enabled: true,
        manual_disabled: false,
        auto_disabled: false,
        auto_disabled_reason: ''
    }));

    const payload = {
        ...existingData,
        api_key: keys[0] || '',
        api_keys: keys,
        keys_with_status: keysWithStatus
    };

    if (inputData.use_web_token !== undefined) {
        payload.use_web_token = !!inputData.use_web_token;
    }

    writeElevenLabsRawData(payload);
    return getPublicElevenLabsSettings();
}

// ElevenLabs Keys with Status
function normalizeElevenLabsKeysWithStatus(value) {
    if (Array.isArray(value)) {
        return value
            .map(entry => typeof entry === 'string' ? { key: entry, enabled: true } : entry)
            .filter(entry => entry && typeof entry === 'object' && typeof entry.key === 'string' && entry.key.trim());
    }
    if (typeof value === 'string' && value.trim()) {
        return [{ key: value.trim(), enabled: true }];
    }
    if (value && typeof value === 'object') {
        return Object.values(value)
            .map(entry => typeof entry === 'string' ? { key: entry, enabled: true } : entry)
            .filter(entry => entry && typeof entry === 'object' && typeof entry.key === 'string' && entry.key.trim());
    }
    return [];
}

function loadElevenLabsKeysWithStatus() {
    const data = readElevenLabsRawData();
    const kws = normalizeElevenLabsKeysWithStatus(data.keys_with_status);
    if (kws.length > 0) return kws;
    const legacyKeys = Array.isArray(data.api_keys) ? data.api_keys : (data.api_keys ? [data.api_keys] : []);
    const result = legacyKeys.map(k => ({ key: k, enabled: true })).filter(entry => entry.key && entry.key.trim());
    for (const envKey of readEnvKeys('ELEVENLABS_API_KEY', 'ELEVENLABS_API_KEYS')) {
        if (!result.some(entry => entry.key === envKey)) {
            result.push({ key: envKey, enabled: true });
        }
    }
    return result;
}

function getPublicElevenLabsKeysWithStatus() {
    return loadElevenLabsKeysWithStatus().map(entry => ({
        ...entry,
        key: maskApiKey(entry.key),
    }));
}

function _resolveElevenLabsStatusList(incomingList, existingList) {
    const normalized = normalizeElevenLabsKeysWithStatus(incomingList);
    const realKeys = existingList.map(e => e.key);
    const used = new Set();
    return normalized.map(entry => {
        const k = String(entry.key || '').trim();
        if (!isMaskedApiKey(k)) return { ...entry, key: k };
        for (let i = 0; i < realKeys.length; i++) {
            if (used.has(i)) continue;
            if (maskApiKey(realKeys[i]) === k || _legacyShortMask(realKeys[i]) === k) {
                used.add(i);
                return { ...existingList[i], ...entry, key: realKeys[i] };
            }
        }
        return null;
    }).filter(Boolean);
}

function saveElevenLabsKeysWithStatus(keysData) {
    const data = readElevenLabsRawData();
    const existing = loadElevenLabsKeysWithStatus();
    const resolved = _resolveElevenLabsStatusList(keysData, existing);
    data.keys_with_status = resolved;
    data.api_keys = resolved.map(entry => entry.key);
    data.api_key = data.api_keys[0] || '';
    writeElevenLabsRawData(data);
}

function addElevenLabsKey(key) {
    const cleanKey = typeof key === 'string' ? key.trim() : '';
    if (!cleanKey) throw new Error('Key 不能为空');
    const data = readElevenLabsRawData();
    const keys = loadElevenLabsKeysWithStatus();
    if (keys.some(entry => entry.key === cleanKey)) throw new Error('Key 已存在');
    keys.push({
        key: cleanKey,
        enabled: true,
        manual_disabled: false,
        auto_disabled: false,
        auto_disabled_reason: ''
    });
    data.keys_with_status = keys;
    data.api_keys = keys.map(entry => entry.key);
    data.api_key = data.api_keys[0] || '';
    writeElevenLabsRawData(data);
}

function deleteElevenLabsKey(index) {
    const data = readElevenLabsRawData();
    const keys = loadElevenLabsKeysWithStatus();
    if (!Number.isInteger(index) || index < 0 || index >= keys.length) throw new Error('索引无效');
    keys.splice(index, 1);
    data.keys_with_status = keys;
    data.api_keys = keys.map(entry => entry.key);
    data.api_key = data.api_keys[0] || '';
    writeElevenLabsRawData(data);
}

function updateElevenLabsKeys(actionData) {
    const data = readElevenLabsRawData();
    const keys = loadElevenLabsKeysWithStatus();
    const action = actionData && actionData.action;

    if (action === 'toggle') {
        const index = actionData.index;
        if (!Number.isInteger(index) || index < 0 || index >= keys.length) throw new Error('索引无效');
        const nextEnabled = keys[index].enabled === false;
        keys[index].enabled = nextEnabled;
        keys[index].manual_disabled = !nextEnabled;
        if (nextEnabled) {
            keys[index].auto_disabled = false;
            keys[index].auto_disabled_reason = '';
        }
        data.keys_with_status = keys;
        writeElevenLabsRawData(data);
        return { enabled: nextEnabled };
    }

    if (action === 'move') {
        const from = actionData.from;
        const to = actionData.to;
        if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from >= keys.length || to < 0 || to >= keys.length) {
            throw new Error('索引无效');
        }
        const [item] = keys.splice(from, 1);
        keys.splice(to, 0, item);
        data.keys_with_status = keys;
        data.api_keys = keys.map(entry => entry.key);
        data.api_key = data.api_keys[0] || '';
        writeElevenLabsRawData(data);
        return { message: '顺序已更新' };
    }

    if (action === 'reorder') {
        const nextKeys = _resolveElevenLabsStatusList(actionData.keys, keys);
        data.keys_with_status = nextKeys;
        data.api_keys = nextKeys.map(entry => entry.key);
        data.api_key = data.api_keys[0] || '';
        writeElevenLabsRawData(data);
        return { message: '顺序已更新' };
    }

    throw new Error('无效操作');
}

/**
 * 仅在用户主动点击「显示明文」时按需返回对应平台的明文 Key。
 */
function revealKeys(scope, index = null) {
    let list = [];
    if (scope === 'deepgram' || scope === 'groq' || scope === 'gladia') {
        list = loadTranscriptionProviders().providers?.[scope]?.keys || [];
    } else if (scope === 'gemini') {
        list = loadGeminiKeys().keys || [];
    } else if (scope === 'google-tts') {
        const gem = loadGeminiKeys();
        list = Array.isArray(gem.tts_keys) && gem.tts_keys.length > 0
            ? gem.tts_keys
            : [...new Set([...(gem.tts_keys || []), ...(gem.keys || [])])];
    } else if (scope === 'elevenlabs') {
        list = loadElevenLabsSettings().api_keys || [];
    } else if (scope === 'elevenlabs-status') {
        list = loadElevenLabsKeysWithStatus().map(item => item.key);
    } else {
        throw new Error(`未知密钥类型: ${scope}`);
    }

    if (Number.isInteger(index)) {
        return { key: list[index] || '', index };
    }
    return { keys: list };
}

// Replace Rules
function getReplaceRulesPath() { return path.join(getBackendDir(), 'replace_rules.json'); }
function loadReplaceRules() { return readJSON(getReplaceRulesPath()) || { rules: [] }; }
function saveReplaceRules(data) { writeJSON(getReplaceRulesPath(), data); }

// ==================== File Operations ====================

function openFolder(folderPath) {
    if (!folderPath || typeof folderPath !== 'string' || folderPath.includes('\0')) {
        return Promise.reject(new Error('无效的文件夹路径'));
    }
    let expandedPath = folderPath;
    if (expandedPath === '~') {
        expandedPath = os.homedir();
    } else if (expandedPath.startsWith('~/') || expandedPath.startsWith('~\\')) {
        expandedPath = path.join(os.homedir(), expandedPath.slice(2));
    }

    if (isBlockedSensitivePath(expandedPath)) {
        return Promise.reject(new Error('安全策略拦截：受保护路径不允许打开'));
    }

    if (!fs.existsSync(expandedPath)) {
        try {
            fs.mkdirSync(expandedPath, { recursive: true });
        } catch {
            throw new Error('路径不存在且创建失败: ' + expandedPath);
        }
    }

    try {
        const { shell } = require('electron');
        const stat = fs.statSync(expandedPath);
        if (!stat.isDirectory()) {
            // 若传入的是文件路径，使用 showItemInFolder 在文件管理器中定位，避免 shell.openPath 直接执行脚本/可执行程序
            shell.showItemInFolder(expandedPath);
            return Promise.resolve({ message: '已在文件夹中显示' });
        }
        return shell.openPath(expandedPath).then((errMsg) => {
            if (errMsg) throw new Error(errMsg);
            return { message: '已打开' };
        });
    } catch (err) {
        return Promise.reject(new Error('打开文件夹失败: ' + err.message));
    }
}

// Upload directory
const UPLOAD_DIR = path.join(getBackendDir(), 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

function uploadFile(buffer, filename) {
    const safeName = path.basename(String(filename || 'upload_file')).replace(/[\0/\\]/g, '_');
    if (!safeName || safeName === '.' || safeName === '..') {
        throw new Error('无效的上传文件名');
    }
    const uploadRoot = path.resolve(UPLOAD_DIR) + path.sep;
    const destPath = path.resolve(UPLOAD_DIR, safeName);
    if (!destPath.startsWith(uploadRoot)) {
        throw new Error('拒绝越界上传路径');
    }
    if (isBlockedWritePath(destPath)) {
        throw new Error('安全策略拦截：不允许上传可执行脚本或受保护文件名');
    }
    fs.writeFileSync(destPath, buffer);
    return { path: destPath };
}

function createZip(files, outputPath) {
    const validFiles = [];
    for (const f of (Array.isArray(files) ? files : [])) {
        if (typeof f !== 'string' || !f.trim()) continue;
        if (isBlockedSensitivePath(f)) {
            throw new Error('安全策略拦截：不允许将受保护的敏感文件打包为 ZIP');
        }
        if (fs.existsSync(f)) {
            validFiles.push(f);
        }
    }
    return new Promise((resolve, reject) => {
        const output = fs.createWriteStream(outputPath);
        const archive = archiver('zip', { zlib: { level: 6 } });
        output.on('close', () => resolve(outputPath));
        archive.on('error', reject);
        archive.pipe(output);
        for (const f of validFiles) {
            archive.file(f, { name: path.basename(f) });
        }
        archive.finalize();
    });
}

// ==================== Language Config ====================

const LANGUAGES = {
    en: { name: 'en', display: '英文', gladia: 'english' },
    ja: { name: 'ja', display: '日文', gladia: 'japanese' },
    ko: { name: 'ko', display: '韩文', gladia: 'korean' },
    es: { name: 'es', display: '西班牙文', gladia: 'spanish' },
    fr: { name: 'fr', display: '法文', gladia: 'french' },
    de: { name: 'de', display: '德文', gladia: 'german' },
    pt: { name: 'pt', display: '葡萄牙文', gladia: 'portuguese' },
    it: { name: 'it', display: '意大利文', gladia: 'italian' },
    zh: { name: 'zh', display: '中文', gladia: 'chinese' },
    ar: { name: 'ar', display: '阿拉伯文', gladia: 'arabic' },
    ru: { name: 'ru', display: '俄文', gladia: 'russian' },
};

function getLanguages() {
    return Object.entries(LANGUAGES).map(([code, lang]) => ({
        code,
        name: lang.name,
        display: lang.display,
    }));
}

module.exports = {
    getBackendDir,
    getSecureTmpDir,
    secureTmpFile,
    readJSON,
    writeJSON,
    maskApiKey,
    isMaskedApiKey,
    resolveSubmittedKeys,
    revealKeys,
    readElevenLabsRawData,
    writeElevenLabsRawData,
    loadGladiaKeys,
    getPublicGladiaKeys,
    saveGladiaKeys,
    loadTranscriptionProviders,
    getPublicTranscriptionProviders,
    saveTranscriptionProviders,
    getEffectiveConcurrency,
    loadGeminiKeys,
    getPublicGeminiKeys,
    saveGeminiKeys,
    loadElevenLabsSettings,
    getPublicElevenLabsSettings,
    saveElevenLabsSettings,
    loadElevenLabsKeysWithStatus,
    getPublicElevenLabsKeysWithStatus,
    saveElevenLabsKeysWithStatus,
    addElevenLabsKey,
    deleteElevenLabsKey,
    updateElevenLabsKeys,
    loadReplaceRules,
    saveReplaceRules,
    openFolder,
    uploadFile,
    createZip,
    getLanguages,
    LANGUAGES,
    UPLOAD_DIR,
    DEFAULT_GEMINI_PROMPT,
};
