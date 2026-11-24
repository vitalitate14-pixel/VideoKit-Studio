/**
 * turbo-export.js — 新极速导出（turbo）主进程服务。
 *
 * 渲染端用 WebCodecs 硬件编码器直接把 Canvas 压成 H.264（Annex B），写入临时文件；
 * 本服务只负责：
 *   1. begin  ：建立会话（与旧导出相同的音频参数字段）
 *   2. finish ：把 H.264 封装为 MP4；指定最大码率时以 VBV 限码率重新编码，
 *               再调用旧导出完全相同的 mixAudio() 混合配音/BGM/混响
 *   3. abort  ：清理临时文件
 *
 * 不修改、不替代 ffmpeg-rawvideo.js 中的任何旧导出流程。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const raw = require('./ffmpeg-rawvideo');

const sessions = new Map();

function tmpDir() {
    return require('./settings').getSecureTmpDir();
}

function findFileRecursive(dir, fileName, maxDepth) {
    if (maxDepth < 0) return null;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return null; }
    for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isFile() && entry.name === fileName) return full;
    }
    for (const entry of entries) {
        if (entry.name.startsWith('.') || !entry.isDirectory()) continue;
        const found = findFileRecursive(path.join(dir, entry.name), fileName, maxDepth - 1);
        if (found) return found;
    }
    return null;
}

// 与 startSession() 相同的背景路径自动修复（背景原声来源）。
function repairBackgroundPath(backgroundPath) {
    if (!backgroundPath || (path.isAbsolute(backgroundPath) && fs.existsSync(backgroundPath))) return backgroundPath;
    const bare = path.basename(backgroundPath);
    for (const dir of ['Downloads', 'Desktop', 'Documents'].map(d => path.join(os.homedir(), d))) {
        if (!fs.existsSync(dir)) continue;
        const found = findFileRecursive(dir, bare, 4);
        if (found) return found;
    }
    return backgroundPath;
}

function begin(opts = {}) {
    const id = `${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
    const dir = tmpDir();
    const session = {
        id,
        h264Path: path.join(dir, `reels_turbo_${id}.h264`),
        tempVideo: path.join(dir, `reels_turbo_${id}.mp4`),
        outputPath: opts.outputPath,
        voicePath: opts.voicePath,
        voiceVolume: opts.voiceVolume ?? 1.0,
        bgVolume: opts.bgVolume ?? 0.1,
        backgroundPath: repairBackgroundPath(opts.backgroundPath),
        bgHasAudio: !!opts.bgHasAudio,
        bgmPath: opts.bgmPath || '',
        bgmVolume: opts.bgmVolume || 0,
        bgmStart: Math.max(0, Number(opts.bgmStart) || 0),
        contentVideoPath: opts.contentVideoPath || '',
        contentVideoVolume: opts.contentVideoVolume ?? 1.0,
        bgDurScale: opts.bgDurScale || 100,
        audioDurScale: opts.audioDurScale || 100,
        reverbEnabled: !!opts.reverbEnabled,
        reverbPreset: opts.reverbPreset || 'hall',
        reverbMix: opts.reverbMix ?? 30,
        stereoWidth: opts.stereoWidth ?? 100,
        audioFxTarget: opts.audioFxTarget || 'all',
        insertAudioClips: opts.insertAudioClips || [],
        overlayAudioClips: opts.overlayAudioClips || [],
        renderedAudioPath: opts.renderedAudioPath || null,
        targetDuration: Number(opts.targetDuration) || 0,
        totalFrames: Number(opts.totalFrames) || 0,
        width: opts.width || 1080,
        height: opts.height || 1920,
        fps: opts.fps || 30,
        targetBitrateMbps: opts.targetBitrateMbps,
        maxBitrateMbps: opts.maxBitrateMbps,
        frameCount: 0,
    };
    if (!session.outputPath) throw new Error('缺少输出路径');
    sessions.set(id, session);
    return { sessionId: id, h264Path: session.h264Path };
}

function runFFmpeg(args) {
    return new Promise((resolve, reject) => {
        const proc = spawn(raw.shared.findFFmpeg(), args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
        let stderr = '';
        proc.stderr.on('data', d => { stderr = (stderr + d).slice(-6000); });
        proc.on('error', reject);
        proc.on('close', code => (code === 0 ? resolve() : reject(new Error(raw.shared.formatMediaError(stderr, { action: '封装视频', code })))));
    });
}

function cleanup(session) {
    sessions.delete(session.id);
    for (const file of [session.h264Path, session.tempVideo]) {
        try { if (file && fs.existsSync(file)) fs.unlinkSync(file); } catch (_) { }
    }
}

function videoEncodingArgs(session) {
    const requestedMax = Number(session.maxBitrateMbps);
    if (!Number.isFinite(requestedMax) || requestedMax <= 0) return ['-c:v', 'copy'];
    // WebCodecs VBR 不提供 maxrate/VBV。只有明确要求上限时才重编码。
    const max = Math.max(1, Math.min(50, requestedMax));
    const requestedTarget = Number(session.targetBitrateMbps);
    const target = Math.min(max, Number.isFinite(requestedTarget) && requestedTarget > 0 ? requestedTarget : max);
    return ['-c:v', 'libx264', '-preset', 'fast', '-pix_fmt', 'yuv420p',
        ...raw.shared.h264RateControlArgs(23, target, max)];
}

async function finish({ sessionId, frameCount, colorTags } = {}) {
    const session = sessions.get(sessionId);
    if (!session) return { error: '新极速导出会话不存在' };
    try {
        session.frameCount = Number(frameCount) || 0;
        if (session.totalFrames && session.frameCount !== session.totalFrames) {
            throw new Error(`编码帧数不完整：${session.frameCount}/${session.totalFrames}`);
        }
        if (!fs.existsSync(session.h264Path) || fs.statSync(session.h264Path).size < 64) {
            throw new Error('硬件编码没有产生视频数据');
        }
        // 无上限时原样拷贝；设置上限时使用与旧导出相同的 VBV 约束。
        const tags = colorTags || {};
        const bsf = `h264_metadata=video_full_range_flag=0:colour_primaries=${tags.primaries ?? 1}`
            + `:transfer_characteristics=${tags.transfer ?? 1}:matrix_coefficients=${tags.matrix ?? 1}`;
        await runFFmpeg([
            '-y', '-fflags', '+genpts', '-r', String(session.fps), '-i', session.h264Path,
            ...videoEncodingArgs(session), '-bsf:v', bsf,
            '-color_range', 'tv',
            '-colorspace', tags.matrixName || 'bt709',
            '-color_primaries', tags.primariesName || 'bt709',
            '-color_trc', tags.transferName || 'bt709',
            '-frames:v', String(session.frameCount),
            '-movflags', '+faststart', session.tempVideo,
        ]);
        try { fs.unlinkSync(session.h264Path); } catch (_) { }
        await raw.shared.mixAudio(session);
        cleanup(session);
        return { output_path: session.outputPath };
    } catch (error) {
        cleanup(session);
        return { error: error && error.message ? error.message : String(error) };
    }
}

function abort({ sessionId } = {}) {
    const session = sessions.get(sessionId);
    if (session) cleanup(session);
    return true;
}

async function handleTurboIPC(action, data) {
    switch (action) {
        case 'begin': return begin(data);
        case 'finish': return finish(data);
        case 'abort': return abort(data);
        case 'rate-control': return raw.shared.h264RateControlArgs(data?.crf, data?.targetBitrateMbps, data?.maxBitrateMbps);
        default: throw new Error(`未知的新极速导出操作: ${action}`);
    }
}

module.exports = { handleTurboIPC, _test: { videoEncodingArgs } };
