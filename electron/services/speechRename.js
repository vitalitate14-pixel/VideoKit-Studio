const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const DiffMatchPatch = require('diff-match-patch');
const nameRules = require('../../src/speech-rename-names');
const normalize = text => String(text || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

function similarity(a, b) {
    if (!a || !b) return 0;
    if (a === b || (a.length >= 6 && b.includes(a))) return 1;
    if (b.length >= 8 && a.includes(b)) return 0.98;
    // A title may be much shorter than the recognized opening. Score its
    // best matching passage too, rather than penalizing the rest of the speech.
    if (a.length > b.length) return similarity(b, a);
    // Compare short recognition with windows throughout a longer reference script.
    const grams = s => { const m = new Map(); for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1); } return m; };
    const left = grams(a);
    let best = 0;
    for (let start = 0; start <= Math.max(0, b.length - a.length); start++) {
        const part = b.slice(start, start + a.length);
        const right = grams(part);
        let common = 0;
        for (const [g, n] of left) common += Math.min(n, right.get(g) || 0);
        best = Math.max(best, 2 * common / Math.max(1, a.length + part.length - 2));
    }
    return best;
}

function matchText(text, candidates = []) {
    const recognized = normalize(text);
    const ranked = candidates.map((item, index) => {
        const title = String(item.title || ''), text = String(item.text || item.title || '');
        const spokenText = text.replace(/^\s*\d{1,8}\s*[-_.]\s*/, '');
        const reference = normalize(spokenText);
        return { index, title, text, score: reference.length >= 6 ? similarity(recognized, reference) : 0 };
    }).sort((a, b) => b.score - a.score);
    const best = ranked[0];
    const matched = recognized.length >= 6 && best?.score >= 0.82 && (!ranked[1] || best.score - ranked[1].score >= 0.08);
    return { status: matched ? 'matched' : best?.score >= 0.55 ? 'uncertain' : 'unmatched', candidate: best || null, suggestions: ranked.slice(0, 3), proposedName: matched ? best.title : String(text || '').trim(), comparison: best ? compareText(text, best.text) : null };
}

function compareText(recognized, supplied) {
    const a = normalize(recognized), b = normalize(String(supplied || '').replace(/^\s*\d{1,8}\s*[-_.]\s*/, ''));
    if (a && b && (a.includes(b) || b.includes(a))) return { equal: true, note: '识别区间覆盖的文字一致（忽略大小写、标点、空格及编号）；区间外正文不算差异', parts: [] };
    const diff = new DiffMatchPatch();
    const parts = diff.diff_main(String(supplied || ''), String(recognized || ''));
    diff.diff_cleanupSemantic(parts);
    return { equal: false, note: '黄色：提供文案中未识别到的文字；蓝色：识别结果中新增或不同的文字。也可能是识别区间未覆盖，请试听核对。', parts };
}

async function analyze(options, deps = {}) {
    const ffmpeg = deps.ffmpeg || require('./ffmpeg');
    const settings = deps.settings || require('./settings');
    const cloud = deps.cloud || require('./cloudTranscription');
    const source = options.source;
    if (!source || !path.isAbsolute(source) || !fs.statSync(source).isFile()) throw new Error('请选择有效的本地视频');
    const start = Number(options.start ?? 0), end = Number(options.end ?? 10);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) throw new Error('结束时间必须大于开始时间，开始时间不能小于 0');
    const duration = await ffmpeg.getDuration(source);
    if (!Number.isFinite(duration) || duration <= start) throw new Error('开始时间超出视频时长，或无法读取时长');
    const actualEnd = Math.min(end, duration);
    const dir = fs.mkdtempSync(path.join(settings.getSecureTmpDir(), 'speech-rename-'));
    try {
        const audio = path.join(dir, 'range.wav');
        await ffmpeg.runCommand('ffmpeg', ['-nostdin', '-y', '-ss', String(start), '-i', source, '-t', String(actualEnd - start), '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', audio]);
        const result = await cloud.transcribeWithFallback(audio, settings.loadTranscriptionProviders(), options.language || 'en', path.join(dir, 'transcript.json'), path.join(dir, 'transcript.txt'), 5);
        const text = String(result.fullText || '').trim();
        if (!text) throw new Error('所选时间范围没有识别出语音，请调整时间范围后重试');
        return { source, text, start, end: actualEnd, ...matchText(text, options.candidates) };
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function validateName(name, options = {}) {
    const result = nameRules.inspect(name, { platform: process.platform, ...options });
    if (!result.valid) throw new Error(result.issues.join('；'));
}

function renameReviewed(entries, options = {}) {
    if (!Array.isArray(entries) || !entries.length) throw new Error('没有已确认的命名');
    const sources = new Set(), targets = new Set();
    const plan = entries.map(item => {
        if (item.confirmed !== true) throw new Error('请先逐条确认命名');
        try { validateName(item.name, { extension: path.extname(item.source || '') }); }
        catch (error) { throw new Error(`“${path.basename(item.source || '')}”：${error.message}`); }
        if (!path.isAbsolute(item.source || '') || !fs.statSync(item.source).isFile()) throw new Error('源视频不存在');
        const source = path.resolve(item.source), ext = path.extname(source);
        if (sources.has(source)) throw new Error('存在重复视频');
        const base = String(options.prefix || '') + item.name + String(options.suffix || '');
        validateName(base, { extension: ext });
        let target = path.join(path.dirname(source), base + ext), number = 0;
        const existing = new Set(fs.readdirSync(path.dirname(source)).map(name => name.normalize('NFC').toLowerCase()));
        while (targets.has(target.normalize('NFC').toLowerCase()) || (target !== source && existing.has(path.basename(target).normalize('NFC').toLowerCase()))) {
            const name = `${base} (${++number})`;
            validateName(name, { extension: ext });
            target = path.join(path.dirname(source), name + ext);
        }
        sources.add(source); targets.add(target.normalize('NFC').toLowerCase());
        return { source, target };
    });
    const results = [];
    for (const item of plan) {
        try {
            if (item.source !== item.target) {
                // Exclusive creation also protects against a target appearing after preflight.
                try { fs.linkSync(item.source, item.target); }
                catch (error) { if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV'].includes(error.code)) throw error; fs.copyFileSync(item.source, item.target, fs.constants.COPYFILE_EXCL); }
                try { fs.unlinkSync(item.source); } catch (error) { fs.unlinkSync(item.target); throw error; }
            }
            results.push({ ...item, success: true });
        } catch (error) { results.push({ ...item, success: false, error: error.message }); break; }
    }
    return { results, success: results.length === plan.length && results.every(item => item.success) };
}

async function thumbnail({ source }, deps = {}) {
    if (!source || !path.isAbsolute(source) || !fs.statSync(source).isFile()) throw new Error('视频不存在');
    const settings = deps.settings || require('./settings');
    const ffmpeg = deps.ffmpeg || require('./ffmpeg');
    const file = path.join(settings.getSecureTmpDir(), `speech-thumb-${crypto.randomUUID()}.jpg`);
    try {
        await ffmpeg.runCommand('ffmpeg', ['-nostdin', '-y', '-i', source, '-frames:v', '1', '-vf', 'scale=240:160:force_original_aspect_ratio=decrease', '-q:v', '4', file]);
        return { image: `data:image/jpeg;base64,${fs.readFileSync(file).toString('base64')}` };
    } finally { fs.rmSync(file, { force: true }); }
}

module.exports = { analyze, matchText, compareText, renameReviewed, validateName, thumbnail };
