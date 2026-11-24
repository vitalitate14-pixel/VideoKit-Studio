/**
 * reels-turbo-decoder.js — 新极速导出（turbo）的帧读取器。
 *
 * 旧导出每帧用 <img> 同步等待加载一张 JPG/PNG（读盘 + 解码串行在渲染循环里）。
 * 这里改为：
 *   - fs 异步读取文件（libuv 线程池）
 *   - createImageBitmap 在 Chromium 的后台解码线程中并行解码
 *   - 按“即将用到的帧”提前发起，渲染循环取帧时通常已解码完毕
 *   - 只保留当前帧 + 预读窗口，用完立即 close() 释放显存/内存
 * 帧文件与旧导出完全相同（同一 FFmpeg 预处理产物），所以像素来源一致。
 */
(function (root) {
    const nodeFs = typeof require === 'function' ? require('fs') : null;

    function toLocalPath(p) {
        if (!p || typeof p !== 'string') return p;
        if (/^local-media:\/\//i.test(p) || /^file:\/\//i.test(p)) {
            try { return require('url').fileURLToPath(p.replace(/^local-media:/i, 'file:')); } catch (_) { }
        }
        return p;
    }

    // 让 ImageBitmap 与 <img> 在现有绘制代码中表现一致（代码读取 naturalWidth/Height）。
    function decorate(bitmap) {
        try {
            Object.defineProperty(bitmap, 'naturalWidth', { value: bitmap.width, configurable: true });
            Object.defineProperty(bitmap, 'naturalHeight', { value: bitmap.height, configurable: true });
            Object.defineProperty(bitmap, 'complete', { value: true, configurable: true });
        } catch (_) { }
        return bitmap;
    }

    async function decodeFile(filePath) {
        const local = toLocalPath(filePath);
        if (nodeFs) {
            const buf = await nodeFs.promises.readFile(local);
            const type = /\.png$/i.test(local) ? 'image/png' : /\.webp$/i.test(local) ? 'image/webp' : 'image/jpeg';
            const blob = new Blob([buf], { type });
            return decorate(await createImageBitmap(blob));
        }
        const res = await fetch(local);
        return decorate(await createImageBitmap(await res.blob()));
    }

    class TurboFrameSource {
        /**
         * @param {string} label 日志名称
         * @param {number} keep  预读窗口大小
         */
        constructor(label, keep = 6) {
            this.label = label;
            this.keep = Math.max(2, keep);
            this.cache = new Map(); // path -> { promise, bitmap }
            this.waitMs = 0;
            this.decoded = 0;
        }

        _start(filePath) {
            if (!filePath || this.cache.has(filePath)) return;
            const entry = { promise: null, bitmap: null };
            entry.promise = decodeFile(filePath).then((bitmap) => {
                entry.bitmap = bitmap;
                this.decoded++;
                return bitmap;
            });
            // 预读失败不在这里抛出；真正取帧时再报告。
            entry.promise.catch(() => { });
            this.cache.set(filePath, entry);
        }

        /**
         * 取当前帧，并为 upcoming 中的帧提前发起解码。
         * @param {string} filePath 当前帧文件
         * @param {string[]} upcoming 接下来可能用到的帧文件（按顺序）
         */
        async get(filePath, upcoming = []) {
            this._start(filePath);
            for (const next of upcoming.slice(0, this.keep)) this._start(next);
            const entry = this.cache.get(filePath);
            const t0 = performance.now();
            let bitmap;
            try {
                bitmap = await entry.promise;
            } catch (error) {
                throw new Error(`${this.label}取帧失败：${filePath}。原因：${error.message || error}`);
            }
            this.waitMs += performance.now() - t0;
            this._evict(filePath, upcoming);
            return bitmap;
        }

        _evict(current, upcoming) {
            if (this.cache.size <= this.keep + 2) return;
            const wanted = new Set([current, ...upcoming.slice(0, this.keep)]);
            for (const [key, entry] of this.cache) {
                if (wanted.has(key)) continue;
                if (key === this._previous) continue;
                this.cache.delete(key);
                if (entry.bitmap) entry.bitmap.close();
                else entry.promise.then(b => b && b.close()).catch(() => { });
            }
            this._previous = current;
        }

        dispose() {
            for (const entry of this.cache.values()) {
                if (entry.bitmap) entry.bitmap.close();
                else entry.promise.then(b => b && b.close()).catch(() => { });
            }
            this.cache.clear();
        }
    }

    const api = { TurboFrameSource, decodeFile };
    if (root) root.ReelsTurboDecoder = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : null);
