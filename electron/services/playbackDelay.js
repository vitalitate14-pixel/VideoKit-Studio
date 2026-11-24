// Persist generated playback media separately from originals and disposable caches.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const ffmpeg = require('./ffmpeg');
function createPlaybackDelayService({ media = ffmpeg, root = path.join(os.homedir(), '.videokit', 'playback-effects') } = {}) {
    const pending = new Map();
    async function prepare({ source, delay = 0, trimStart = 0, trimEnd = null }) {
        if (!source || !path.isAbsolute(source)) throw new Error('请选择本地视频文件');
        const stat = fs.statSync(source);
        if (!stat.isFile()) throw new Error('素材不是文件');
        const seconds = Number(delay);
        const start = Number(trimStart);
        if (!Number.isFinite(seconds) || seconds < 0 || seconds > 600) throw new Error('等待时间应为 0–600 秒');
        if (!Number.isFinite(start) || start < 0) throw new Error('原片入点无效');
        if (!seconds) return { path: source, delay: 0 };
        const probe = await media.runCommand('ffprobe', ['-v','error','-show_streams','-show_format','-of','json',source]);
        const info = JSON.parse(probe.stdout);
        const video = info.streams?.find(stream => stream.codec_type === 'video');
        if (!video) throw new Error('该素材没有视频画面');
        const duration = Number(video.duration || info.format?.duration);
        const end = trimEnd == null ? duration : Math.min(duration, Number(trimEnd));
        if (!(duration > 0) || !Number.isFinite(end) || !(end > start)) throw new Error('原片入点或出点超出视频范围');
        // Preserve alpha where present; opaque videos use a broadly playable MP4.
        const alpha = /^(yuva|rgba|bgra|argb|abgr|gbrap)/.test(video.pix_fmt || '') || String(video.tags?.alpha_mode) === '1';
        const audio = info.streams?.some(stream => stream.codec_type === 'audio');
        const key = crypto.createHash('sha256').update(JSON.stringify({ version:3, source, size:stat.size, mtime:stat.mtimeMs, seconds, start, end, alpha })).digest('hex');
        const dir = path.join(root, key);
        const output = path.join(dir, path.basename(source, path.extname(source)) + (alpha ? '.webm' : '.mp4'));
        const result = { path:output, duration:seconds + end - start, delay:seconds };
        if (fs.existsSync(output) && fs.statSync(output).size > 0) return result;
        if (pending.has(key)) return pending.get(key);
        const work = (async () => {
            fs.mkdirSync(dir, {recursive:true});
            const temporary = path.join(dir, `pending-${process.pid}${alpha ? '.webm' : '.mp4'}`);
            const videoFilter = `trim=start=${start}:end=${end},setpts=PTS-STARTPTS,tpad=start_mode=clone:start_duration=${seconds}`;
            const silentAudio = path.join(dir, `audio-${process.pid}.wav`);
            const args = ['-y'];
            if (alpha && video.codec_name === 'vp9') args.push('-c:v','libvpx-vp9');
            args.push('-i',source);
            if (audio) args.push('-i',silentAudio);
            args.push('-map','0:v:0');
            if (audio) args.push('-map','1:a:0','-c:a',alpha?'libopus':'aac');
            else args.push('-an');
            if (alpha) args.push('-c:v','libvpx-vp9','-lossless','1','-pix_fmt','yuva420p','-auto-alt-ref','0','-vf',videoFilter);
            else args.push('-c:v','libx264','-preset','fast','-crf','16','-pix_fmt','yuv420p','-vf',`${videoFilter},pad=ceil(iw/2)*2:ceil(ih/2)*2`,'-movflags','+faststart');
            args.push('-t',String(result.duration),temporary);
            try {
                // Materialize PCM first: some AAC encoder builds collapse large
                // leading silent filter frames when trim/adelay feed them directly.
                if (audio) await media.runCommand('ffmpeg', ['-y','-i',source,'-vn','-af',
                    `atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS,adelay=${Math.round(seconds*1000)}:all=1,apad=whole_dur=${result.duration}`,
                    '-t',String(result.duration),'-c:a','pcm_s16le',silentAudio], {timeout:3600000});
                await media.runCommand('ffmpeg',args,{timeout:3600000});
                if (!fs.existsSync(temporary) || !fs.statSync(temporary).size) throw new Error('等待播放副本生成失败');
                fs.renameSync(temporary,output);
                return result;
            } finally {
                for (const file of [temporary,silentAudio]) { try { fs.unlinkSync(file); } catch (_) {} }
            }
        })();
        pending.set(key,work);
        try { return await work; } finally { pending.delete(key); }
    }
    return {prepare};
}
module.exports = {createPlaybackDelayService};
