/* eslint-disable no-console */
/**
 * harness.js — 新极速导出（turbo）对比测试执行器（开发用）。
 *
 * 读取 build-cases.js 生成的 spec.json，对每个用例：
 *   1. 依次用 spec.engines 中的每个引擎导出（与主界面相同的 isolated-wysiwyg-export 通道）
 *   2. 以 spec.reference（默认 precise）为基准，用 FFmpeg 逐帧计算 SSIM / PSNR
 *   3. 校验帧数、时长、音频是否一致，抽取最差帧的对比图
 * 最后输出 results.json 与 report.html。
 */
const { ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const specPath = new URLSearchParams(location.search).get('spec');
const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
const FFMPEG = spec.ffmpeg || '/opt/homebrew/bin/ffmpeg';
const FFPROBE = spec.ffprobe || '/opt/homebrew/bin/ffprobe';
const outDir = spec.outDir;
const reference = spec.reference || 'precise';
const engines = spec.engines || ['precise', 'turbo'];
const thresholds = { ssimAvg: 0.98, ssimMin: 0.95, ...(spec.thresholds || {}) };
fs.mkdirSync(outDir, { recursive: true });

function run(cmd, args, { capture = true } = {}) {
    return new Promise((resolve) => {
        const proc = spawn(cmd, args, { stdio: ['ignore', capture ? 'pipe' : 'ignore', 'pipe'] });
        let stdout = '';
        let stderr = '';
        if (capture) proc.stdout.on('data', d => { stdout += d; });
        proc.stderr.on('data', d => { stderr = (stderr + d).slice(-20000); });
        proc.on('close', code => resolve({ code, stdout, stderr }));
        proc.on('error', err => resolve({ code: -1, stdout, stderr: String(err) }));
    });
}

function canUseAlpha(params) {
    if (!params.backgroundPath) return false;
    if ((params.bgMode || 'single') !== 'single') return false;
    if (params.contentVideoDirectBg || params.contentVideoBlurBg) return false;
    return !(params.overlays || []).some(ov => ov && !ov.disabled && ov.blend_mode && ov.blend_mode !== 'source-over');
}

// 与 batch-reels.js 中各引擎的参数映射保持一致。
function engineParams(base, engine) {
    const params = JSON.parse(JSON.stringify(base));
    Object.assign(params, spec.paramOverrides || {});
    params.exportEngine = engine;
    if (engine === 'precise') {
        params.forceCanvasBackground = true;
        params.alphaOverlayBgPath = null;
        params.useGPU = false;
    } else if (engine === 'pipeline' || engine === 'hardware') {
        params.forceCanvasBackground = false;
        params.alphaOverlayBgPath = canUseAlpha(params) ? params.backgroundPath : null;
        params.useGPU = engine === 'hardware';
    } else if (engine === 'turbo') {
        params.forceCanvasBackground = false;
        params.alphaOverlayBgPath = null;
        params.useGPU = false;
    }
    return params;
}

async function exportOnce(caseDir, testCase, engine) {
    const params = engineParams(testCase.params, engine);
    params.outputPath = path.join(caseDir, `${engine}.mp4`);
    try { fs.unlinkSync(params.outputPath); } catch (_) { }
    const requestId = `turbo-compare-${testCase.id}-${engine}-${Date.now()}`;
    const t0 = performance.now();
    try {
        const result = await ipcRenderer.invoke('isolated-wysiwyg-export', { requestId, params });
        const seconds = (performance.now() - t0) / 1000;
        if (result && result.cancelled) return { engine, ok: false, error: '已取消', seconds };
        if (!fs.existsSync(params.outputPath)) return { engine, ok: false, error: '没有生成输出文件', seconds };
        return { engine, ok: true, seconds, file: params.outputPath };
    } catch (error) {
        return { engine, ok: false, error: String(error && error.message || error), seconds: (performance.now() - t0) / 1000 };
    }
}

async function probe(file) {
    const r = await run(FFPROBE, ['-v', 'error', '-count_frames', '-select_streams', 'v:0',
        '-show_entries', 'stream=nb_read_frames,width,height,r_frame_rate,pix_fmt,color_space,color_range',
        '-show_entries', 'format=duration', '-of', 'json', file]);
    try {
        const j = JSON.parse(r.stdout);
        const s = (j.streams || [])[0] || {};
        return {
            frames: Number(s.nb_read_frames) || 0,
            width: s.width, height: s.height, fps: s.r_frame_rate,
            pixFmt: s.pix_fmt, colorSpace: s.color_space, colorRange: s.color_range,
            duration: Number(j.format && j.format.duration) || 0,
        };
    } catch (_) { return null; }
}

const { checkAudioMatch: compareAudio } = require('./audio-compare');
const checkAudioMatch = (refFile, testFile) => compareAudio(refFile, testFile, { run, ffmpeg: FFMPEG, ffprobe: FFPROBE });

async function frameMetrics(refFile, testFile, statsBase) {
    const ssimLog = `${statsBase}_ssim.log`;
    const psnrLog = `${statsBase}_psnr.log`;
    // 统一转成标准 yuv420p 比较，符合视频编码工程标准，避免 RGB 变换矩阵的色度放大误差
    const graph = `[0:v]setpts=PTS-STARTPTS,format=yuv420p,split[a1][a2];[1:v]setpts=PTS-STARTPTS,format=yuv420p,split[b1][b2];`
        + `[a1][b1]ssim=stats_file='${ssimLog.replace(/'/g, "\\'")}';[a2][b2]psnr=stats_file='${psnrLog.replace(/'/g, "\\'")}'`;
    await run(FFMPEG, ['-v', 'error', '-i', refFile, '-i', testFile, '-lavfi', graph, '-f', 'null', '-'], { capture: false });
    const ssim = [];
    const psnr = [];
    try {
        for (const line of fs.readFileSync(ssimLog, 'utf8').split('\n')) {
            const m = /All:([0-9.]+)/.exec(line);
            if (m) ssim.push(Number(m[1]));
        }
        for (const line of fs.readFileSync(psnrLog, 'utf8').split('\n')) {
            const m = /psnr_avg:([0-9.inf]+)/.exec(line);
            if (m) psnr.push(m[1] === 'inf' ? 100 : Number(m[1]));
        }
    } catch (_) { }
    const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
    let worst = 0;
    ssim.forEach((v, i) => { if (v < ssim[worst]) worst = i; });
    return {
        frames: ssim.length,
        ssimAvg: avg(ssim), ssimMin: ssim.length ? Math.min(...ssim) : 0,
        psnrAvg: avg(psnr), psnrMin: psnr.length ? Math.min(...psnr) : 0,
        worstFrame: worst,
    };
}

async function worstFrameImages(refFile, testFile, frame, base) {
    const sel = `select=eq(n\\,${frame}),format=rgb24`;
    const ref = `${base}_ref.jpg`;
    const test = `${base}_test.jpg`;
    const diff = `${base}_diff.jpg`;
    await run(FFMPEG, ['-v', 'error', '-y', '-i', refFile, '-i', testFile, '-lavfi',
        `[0:v]${sel},split[r1][r2];[1:v]${sel},split[t1][t2];[r2][t2]blend=all_mode=difference,lutrgb=r='min(val*6,255)':g='min(val*6,255)':b='min(val*6,255)'[d]`,
        '-map', '[r1]', '-frames:v', '1', '-q:v', '3', ref,
        '-map', '[t1]', '-frames:v', '1', '-q:v', '3', test,
        '-map', '[d]', '-frames:v', '1', '-q:v', '3', diff], { capture: false });
    return { ref: path.basename(ref), test: path.basename(test), diff: path.basename(diff) };
}

function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function writeReport(results) {
    fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(results, null, 2));
    const rows = [];
    let pass = 0;
    let total = 0;
    for (const r of results) {
        for (const c of r.comparisons || []) {
            total++;
            if (c.pass) pass++;
            const ref = r.exports.find(e => e.engine === reference);
            const test = r.exports.find(e => e.engine === c.engine);
            const speed = ref && test && test.seconds ? (ref.seconds / test.seconds).toFixed(2) + '×' : '-';
            const imgs = c.images ? `<a href="${esc(r.id)}/${esc(c.images.ref)}"><img src="${esc(r.id)}/${esc(c.images.ref)}"></a>`
                + `<a href="${esc(r.id)}/${esc(c.images.test)}"><img src="${esc(r.id)}/${esc(c.images.test)}"></a>`
                + `<a href="${esc(r.id)}/${esc(c.images.diff)}"><img src="${esc(r.id)}/${esc(c.images.diff)}"></a>` : '';
            rows.push(`<tr class="${c.pass ? 'ok' : 'bad'}"><td>${esc(r.name)}<div class="tags">${esc((r.tags || []).join(' · '))}</div></td>`
                + `<td>${esc(c.engine)}</td><td>${c.pass ? '✅ 通过' : '❌ ' + esc(c.reason || '')}</td>`
                + `<td>${ref ? ref.seconds.toFixed(1) : '-'}s → ${test ? test.seconds.toFixed(1) : '-'}s<br><b>${speed}</b></td>`
                + `<td>${c.metrics ? c.metrics.ssimAvg.toFixed(4) + ' / ' + c.metrics.ssimMin.toFixed(4) : '-'}</td>`
                + `<td>${c.metrics ? c.metrics.psnrAvg.toFixed(1) + ' / ' + c.metrics.psnrMin.toFixed(1) : '-'}</td>`
                + `<td>${esc(c.framesInfo || '')}</td><td>${c.audioMatch ? '一致' : '不同'}</td>`
                + `<td class="imgs">${imgs}${c.metrics ? `<div>最差帧 #${c.metrics.worstFrame}</div>` : ''}</td></tr>`);
        }
        for (const e of r.exports.filter(x => !x.ok)) {
            rows.push(`<tr class="bad"><td>${esc(r.name)}</td><td>${esc(e.engine)}</td><td colspan="7">❌ 导出失败：${esc(e.error)}</td></tr>`);
        }
    }
    const refTotal = results.reduce((s, r) => s + ((r.exports.find(e => e.engine === reference) || {}).seconds || 0), 0);
    const turboTotal = results.reduce((s, r) => s + ((r.exports.find(e => e.engine === 'turbo') || {}).seconds || 0), 0);
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Turbo 对比报告</title><style>
body{font:13px -apple-system,sans-serif;background:#111;color:#ddd;margin:20px}
table{border-collapse:collapse;width:100%}td,th{border:1px solid #333;padding:6px;vertical-align:top}
tr.ok td:nth-child(3){color:#43c977}tr.bad td:nth-child(3){color:#ff6b6b}.tags{color:#888;font-size:11px}
.imgs img{height:120px;margin-right:4px}h1{font-size:18px}</style></head><body>
<h1>新极速导出对比报告 — 通过 ${pass}/${total}</h1>
<p>基准引擎：${esc(reference)} ｜ 判定：SSIM 平均 ≥ ${thresholds.ssimAvg}，单帧最低 ≥ ${thresholds.ssimMin}，帧数一致，音频一致</p>
<p>总用时：${esc(reference)} ${refTotal.toFixed(1)}s → turbo ${turboTotal.toFixed(1)}s（${turboTotal ? (refTotal / turboTotal).toFixed(2) : '-'}×）</p>
<table><tr><th>用例</th><th>引擎</th><th>结果</th><th>用时</th><th>SSIM 平均/最低</th><th>PSNR 平均/最低</th><th>帧数</th><th>音频</th><th>最差帧：基准 / 新 / 差异×6</th></tr>
${rows.join('\n')}</table></body></html>`;
    fs.writeFileSync(path.join(outDir, 'report.html'), html);
    return { pass, total };
}

async function main() {
    const results = [];
    const only = process.env.TURBO_CASES ? new Set(process.env.TURBO_CASES.split(',')) : null;
    const cases = spec.cases.filter(c => !only || only.has(c.id));
    console.log(`开始对比：${cases.length} 个用例，引擎 ${engines.join(', ')}`);
    for (let i = 0; i < cases.length; i++) {
        const testCase = cases[i];
        const caseDir = path.join(outDir, testCase.id);
        fs.mkdirSync(caseDir, { recursive: true });
        const entry = { id: testCase.id, name: testCase.name, tags: testCase.tags || [], exports: [], comparisons: [] };
        for (const engine of engines) {
            const r = await exportOnce(caseDir, testCase, engine);
            entry.exports.push(r);
            console.log(`[${i + 1}/${cases.length}] ${testCase.name} · ${engine}: ${r.ok ? r.seconds.toFixed(1) + 's' : '失败 ' + r.error}`);
        }
        const refExport = entry.exports.find(e => e.engine === reference && e.ok);
        if (refExport) {
            const refProbe = await probe(refExport.file);
            for (const e of entry.exports.filter(x => x.engine !== reference && x.ok)) {
                const testProbe = await probe(e.file);
                const metrics = await frameMetrics(refExport.file, e.file, path.join(caseDir, e.engine));
                const audioOk = await checkAudioMatch(refExport.file, e.file);
                const framesOk = refProbe && testProbe && refProbe.frames === testProbe.frames;
                const c = {
                    engine: e.engine,
                    metrics,
                    refProbe, testProbe,
                    framesInfo: `${refProbe ? refProbe.frames : '?'} / ${testProbe ? testProbe.frames : '?'}`,
                    audioMatch: audioOk,
                };
                const reasons = [];
                if (!framesOk) reasons.push('帧数不同');
                if (metrics.ssimAvg < thresholds.ssimAvg) reasons.push(`SSIM 平均 ${metrics.ssimAvg.toFixed(4)}`);
                if (metrics.ssimMin < thresholds.ssimMin) reasons.push(`SSIM 最低 ${metrics.ssimMin.toFixed(4)}`);
                if (!c.audioMatch && !spec.ignoreAudio) reasons.push('音频不同');
                c.pass = reasons.length === 0;
                c.reason = reasons.join('，');
                c.images = await worstFrameImages(refExport.file, e.file, metrics.worstFrame, path.join(caseDir, `${e.engine}_worst`));
                entry.comparisons.push(c);
                console.log(`    ${e.engine} vs ${reference}: ${c.pass ? '通过' : '不通过 ' + c.reason} | SSIM ${metrics.ssimAvg.toFixed(4)}/${metrics.ssimMin.toFixed(4)} | 帧 ${c.framesInfo} | 音频${c.audioMatch ? '一致' : '不同'}`);
            }
        }
        results.push(entry);
        writeReport(results);
        if (!spec.keepVideos) {
            for (const e of entry.exports) if (e.file && e.engine !== reference && entry.comparisons.every(c => c.pass)) {
                try { fs.unlinkSync(e.file); } catch (_) { }
            }
        }
    }
    const { pass, total } = writeReport(results);
    console.log(`完成：通过 ${pass}/${total}，报告 ${path.join(outDir, 'report.html')}`);
    ipcRenderer.send('turbo-compare-done', pass === total ? 0 : 1);
}

main().catch(error => {
    console.log(`对比执行器异常：${error && error.stack || error}`);
    ipcRenderer.send('turbo-compare-done', 2);
});
