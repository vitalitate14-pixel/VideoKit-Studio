(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory;
    else root.BatchThumbnailLoader = factory(root);
})(typeof window === 'object' ? window : globalThis, function (env) {
    let active = null;
    function dispose() { active?.dispose(); active = null; }
    function hydrate(container, { independent = false } = {}) {
        if (!independent) dispose();
        const videos = [...container.querySelectorAll('video.rbt-thumb-previewable')].filter(video => !video.closest('details') || video.closest('details').open);
        const visible = new Set(), queue = new Set(), jobs = new Map();
        let disposed = false, observer = null;
        const release = video => {
            video.pause(); video.removeAttribute('src'); video.preload = 'none';
            try { video.load(); } catch (_) {}
        };
        function pump() {
            if (disposed) return;
            for (const video of queue) {
                if (jobs.size >= 2) break;
                queue.delete(video);
                if (!visible.has(video) || video.isConnected === false || video.dataset.thumbHydrated === 'true') continue;
                start(video);
            }
        }
        function start(video) {
            let timer = null, done = false;
            const source = video.dataset.thumbSrc;
            if (!source) return;
            function finish(cancelled = false, failed = false) {
                if (done) return;
                done = true;
                if (timer !== null) env.clearTimeout(timer);
                for (const [event, listener] of listeners) video.removeEventListener(event, listener);
                jobs.delete(video);
                release(video);
                if (!cancelled) {
                    video.dataset.thumbHydrated = 'true';
                    observer?.unobserve(video);
                    if (failed) video.title = `${video.title || ''} 缩略图加载失败`.trim();
                }
                pump();
            }
            function capture() {
                if (done || video.readyState < 2) return;
                try {
                    const canvas = env.document.createElement('canvas');
                    const ratio = (video.videoWidth || 1) / (video.videoHeight || 1);
                    const size = Math.max(96, Math.min(1440, Number(video.dataset.thumbSize) || 96));
                    canvas.width = Math.max(1, Math.round(Math.min(video.videoWidth || size, size, size * ratio)));
                    video.style.aspectRatio = `${video.videoWidth || canvas.width} / ${video.videoHeight || Math.round(canvas.width / ratio)}`;
                    canvas.height = Math.max(1, Math.round(canvas.width / ratio));
                    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
                    video.poster = canvas.toDataURL('image/jpeg', Number(video.dataset.thumbQuality) || .75);
                    finish();
                } catch (_) { finish(false, true); }
            }
            function seek() {
                const requested = Number(source.match(/#t=([0-9.]+)/)?.[1]) || .1;
                const target = Number.isFinite(video.duration) ? Math.min(requested, Math.max(0, video.duration - .05)) : requested;
                try {
                    if (Math.abs(video.currentTime - target) < .01) capture();
                    else video.currentTime = target;
                } catch (_) { finish(false, true); }
            }
            const listeners = [['loadedmetadata', seek], ['loadeddata', () => { if (!video.seeking) capture(); }],
                ['seeked', capture], ['error', () => finish(false, true)]];
            jobs.set(video, finish);
            for (const [event, listener] of listeners) video.addEventListener(event, listener);
            timer = env.setTimeout(() => finish(false, true), 8000);
            // local-media:// must use CORS mode both to load in Electron and
            // to keep the frame readable when drawing the thumbnail canvas.
            video.crossOrigin = 'anonymous';
            video.muted = true; video.playsInline = true; video.preload = 'metadata';
            video.src = source;
            try { video.load(); } catch (_) { finish(false, true); }
        }
        const controller = { dispose() {
            disposed = true;
            observer?.disconnect();
            queue.clear(); visible.clear();
            for (const finish of [...jobs.values()]) finish(true);
        } };
        if (!independent) active = controller;
        if (env.IntersectionObserver) {
            observer = new env.IntersectionObserver(entries => {
                for (const entry of entries) {
                    if (entry.isIntersecting) { visible.add(entry.target); queue.add(entry.target); }
                    else { visible.delete(entry.target); queue.delete(entry.target); jobs.get(entry.target)?.(true); }
                }
                pump();
            }, { root: container.querySelector('.rbt-table-wrap'), rootMargin: '100px', threshold: .01 });
            videos.forEach(video => observer.observe(video));
        } else {
            videos.forEach(video => { visible.add(video); queue.add(video); });
            pump();
        }
        return controller;
    }
    return { hydrate, dispose };
});
