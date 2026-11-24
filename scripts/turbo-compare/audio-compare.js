// Normalize both inputs before subtracting matching channels. amerge places
// reference L/R at c0/c1 and candidate L/R at c2/c3.
const AUDIO_DIFF_GRAPH = '[0:a:0]aformat=sample_rates=48000:channel_layouts=stereo[a];'
    + '[1:a:0]aformat=sample_rates=48000:channel_layouts=stereo[b];'
    + '[a][b]amerge=inputs=2,pan=stereo|c0=c0-c2|c1=c1-c3,volumedetect';

async function checkAudioMatch(refFile, testFile, { run, ffmpeg, ffprobe }) {
    async function probe(file) {
        const result = await run(ffprobe, ['-v', 'error', '-select_streams', 'a:0',
            '-show_entries', 'stream=duration:format=duration', '-of', 'json', file]);
        if (result.code !== 0) throw new Error('音频探测失败');
        const data = JSON.parse(result.stdout);
        const stream = data.streams?.[0];
        return stream ? { duration: Number(stream.duration ?? data.format?.duration) } : null;
    }
    try {
        const ref = await probe(refFile);
        const candidate = await probe(testFile);
        if (!ref || !candidate) return ref === null && candidate === null;
        if (!Number.isFinite(ref.duration) || !Number.isFinite(candidate.duration)) return false;
        // A missing tail must fail even when the common portion is identical.
        if (Math.abs(ref.duration - candidate.duration) > 0.05) return false;
        async function hash(file) {
            const result = await run(ffmpeg, ['-v', 'error', '-i', file, '-map', '0:a:0',
                '-vn', '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', '-f', 'md5', '-']);
            return result.code === 0 ? /MD5=([0-9a-f]+)/.exec(result.stdout)?.[1] : null;
        }
        const refHash = await hash(refFile);
        const candidateHash = await hash(testFile);
        if (!refHash || !candidateHash) return false;
        if (refHash === candidateHash) return true;
        const diff = await run(ffmpeg, ['-v', 'info', '-i', refFile, '-i', testFile,
            '-filter_complex', AUDIO_DIFF_GRAPH, '-vn', '-f', 'null', '-']);
        if (diff.code !== 0) return false;
        const mean = /mean_volume:\s*(-inf|-?[0-9.]+)\s*dB/.exec(diff.stderr)?.[1];
        return mean !== undefined && Number(mean === '-inf' ? -Infinity : mean) <= -45;
    } catch (_) {
        // Broken inputs or comparison failures must never count as a pass.
        return false;
    }
}

module.exports = { AUDIO_DIFF_GRAPH, checkAudioMatch };
