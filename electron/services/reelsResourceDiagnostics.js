const fs = require('fs');
const path = require('path');

// All memory values below are KiB. A video element count is not a decoder count.
function createReelsResourceDiagnostics({ app, runtime = process, log = () => {}, getProcessRoles = () => ({}), setTimer = setInterval, clearTimer = clearInterval }) {
    let overview = null, timer = null, history = [], lastEventAt = 0;
    const number = value => Number.isFinite(value) ? Math.max(0, Math.min(value, 1e12)) : 0;
    const fields = ['tasks', 'page', 'visible', 'players', 'loading', 'queued', 'posters', 'videos', 'playingVideos', 'seekingVideos', 'mediaErrors', 'canvasBytes'];
    const reasons = new Set(['open', 'close', 'sample', 'load', 'release', 'page', 'play', 'media-error']);
    function sample(reason, lifecycle = null) {
        try {
            const dir = path.join(app.getPath('userData'), 'diagnostics');
            const file = path.join(dir, 'reels-resources.jsonl');
            const record = {
                timestamp: new Date().toISOString(), reason,
                lifecycle,
                processRoles: getProcessRoles(),
                systemMemoryKiB: runtime.getSystemMemoryInfo(),
                processes: app.getAppMetrics().map(metric => ({
                    pid: metric.pid, type: metric.type, cpuPercent: metric.cpu?.percentCPUUsage,
                    memoryKiB: metric.memory,
                })),
                gpuFeatureStatus: app.getGPUFeatureStatus(),
                overview,
            };
            history.push(record); history = history.slice(-30);
            fs.mkdirSync(dir, { recursive: true });
            if (fs.existsSync(file) && fs.statSync(file).size > 5 * 1024 * 1024) {
                fs.renameSync(file, `${file}.previous`);
            }
            fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
            return record;
        } catch (error) { log(`[ReelsResources] 采样失败: ${error.message}`); return null; }
    }
    function stop() { if (timer !== null) clearTimer(timer); timer = null; }
    function update(payload = {}) {
        const wasOpen = overview?.open === true;
        overview = { open: payload.open === true, playing: payload.playing === true };
        for (const field of fields) overview[field] = number(payload[field]);
        overview.jsHeapBytes = payload.jsHeapBytes ? {
            used: number(payload.jsHeapBytes.used), total: number(payload.jsHeapBytes.total), limit: number(payload.jsHeapBytes.limit),
        } : null;
        overview.media = (Array.isArray(payload.media) ? payload.media : []).slice(0, 64).map(media => {
            const result = {};
            for (const key of ['cardId', 'readyState', 'networkState', 'width', 'height', 'errorCode', 'totalFrames', 'droppedFrames']) result[key] = number(media?.[key]);
            return result;
        });
        const reason = reasons.has(payload.reason) ? payload.reason : 'sample';
        if (wasOpen !== overview.open || reason === 'media-error' || Date.now() - lastEventAt >= 1000) {
            lastEventAt = Date.now(); sample(reason);
        }
        if (overview.open && timer === null) { timer = setTimer(() => sample('periodic'), 5000); timer?.unref?.(); }
        if (!overview.open) stop();
    }
    function crashContext(reason = 'crash') {
        sample(reason);
        return { resourceDiagnosticFile: path.join(app.getPath('userData'), 'diagnostics', 'reels-resources.jsonl'), resourceHistory: history.slice() };
    }
    return { update, stop, crashContext, recordEvent: sample };
}
module.exports = { createReelsResourceDiagnostics };
