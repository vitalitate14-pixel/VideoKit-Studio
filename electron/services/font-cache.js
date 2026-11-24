/**
 * font-cache.js — 字体本地缓存
 *
 * 用户选用某个 Google 字体时，把它的所有字重/斜体变体以「完整 TTF」形式
 * 下载到 userData/fonts-cache/<family>/，之后预览与导出窗口都从本地加载：
 *   - 不再依赖 CDN 的 unicode-range 分片（避免非拉丁字符首帧缺字）
 *   - 离线可用，导出窗口与主窗口加载的是同一份文件
 *   - 下载失败不会写入清单，下次自动重试
 *
 * 用户上传的字体也保存在这里，重启后仍可用。
 */

const fs = require('fs');
const path = require('path');

// 非浏览器 UA：Google Fonts css2 接口会返回完整的 TTF（无 unicode-range 分片）
const CSS_USER_AGENT = 'VideoKit-FontCache/1.0';
const METADATA_URL = 'https://fonts.google.com/metadata/fonts';
const METADATA_TTL = 7 * 24 * 60 * 60 * 1000;
const MANIFEST = 'manifest.json';
const DOWNLOAD_CONCURRENCY = 6;
const UPLOAD_EXTS = new Set(['.ttf', '.otf', '.woff', '.woff2']);

function createFontCache({ app, net, log = console.log }) {
    const root = path.join(app.getPath('userData'), 'fonts-cache');
    const inflight = new Map();
    let metadataPromise = null;

    const doFetch = (url, options = {}) => {
        if (net && typeof net.fetch === 'function') return net.fetch(url, options);
        return fetch(url, options);
    };

    function ensureRoot() {
        fs.mkdirSync(root, { recursive: true });
    }

    function familyDir(family) {
        const safe = String(family).replace(/[^\w\- ]+/g, '_').trim() || 'font';
        return path.join(root, safe);
    }

    function readManifest(dir) {
        try {
            const manifest = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8'));
            if (!manifest || !manifest.family || !Array.isArray(manifest.files) || manifest.files.length === 0) return null;
            const files = manifest.files.map(f => ({ ...f, path: path.join(dir, f.file) }));
            if (!files.every(f => fs.existsSync(f.path))) return null;
            return { ...manifest, files };
        } catch {
            return null;
        }
    }

    function writeManifest(dir, manifest) {
        const tmp = path.join(dir, `${MANIFEST}.tmp`);
        fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2));
        fs.renameSync(tmp, path.join(dir, MANIFEST));
    }

    // family -> ['400', '400i', '700', ...]
    async function loadVariantIndex() {
        if (metadataPromise) return metadataPromise;
        metadataPromise = (async () => {
            ensureRoot();
            const cacheFile = path.join(root, '_metadata.json');
            let stale = null;
            try {
                const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
                if (cached && cached.variants) {
                    if (Date.now() - cached.ts < METADATA_TTL) return cached.variants;
                    stale = cached.variants;
                }
            } catch { /* no cache yet */ }

            try {
                const resp = await doFetch(METADATA_URL, { signal: AbortSignal.timeout(15000) });
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const text = (await resp.text()).replace(/^\)\]\}'\n?/, '');
                const data = JSON.parse(text);
                const variants = {};
                for (const item of data.familyMetadataList || []) {
                    if (item && item.family && item.fonts) variants[item.family] = Object.keys(item.fonts);
                }
                if (Object.keys(variants).length > 100) {
                    fs.writeFileSync(cacheFile, JSON.stringify({ ts: Date.now(), variants }));
                    return variants;
                }
                throw new Error('metadata empty');
            } catch (err) {
                log(`[FontCache] metadata fetch failed: ${err.message}`);
                if (stale) return stale;
                throw err;
            }
        })();
        // 失败时允许下次重新请求
        metadataPromise.catch(() => { metadataPromise = null; });
        return metadataPromise;
    }

    function buildCssUrl(family, variants) {
        const encoded = encodeURIComponent(family).replace(/%20/g, '+');
        const parsed = (variants || [])
            .map(v => ({ weight: parseInt(v, 10), italic: /i$/.test(v) ? 1 : 0 }))
            .filter(v => Number.isFinite(v.weight));
        if (parsed.length === 0) return `https://fonts.googleapis.com/css2?family=${encoded}`;
        parsed.sort((a, b) => a.italic - b.italic || a.weight - b.weight);
        if (parsed.some(v => v.italic)) {
            return `https://fonts.googleapis.com/css2?family=${encoded}:ital,wght@${parsed.map(v => `${v.italic},${v.weight}`).join(';')}`;
        }
        return `https://fonts.googleapis.com/css2?family=${encoded}:wght@${parsed.map(v => v.weight).join(';')}`;
    }

    function parseFontFaces(css) {
        const faces = [];
        const blockRe = /@font-face\s*\{([^}]*)\}/g;
        let m;
        while ((m = blockRe.exec(css))) {
            const block = m[1];
            const url = (/src:\s*url\(([^)]+)\)/.exec(block) || [])[1];
            if (!url) continue;
            faces.push({
                url: url.replace(/^['"]|['"]$/g, ''),
                weight: (/font-weight:\s*([\d\s]+);/.exec(block) || [])[1]?.trim() || '400',
                style: (/font-style:\s*(\w+)/.exec(block) || [])[1] || 'normal',
                unicodeRange: (/unicode-range:\s*([^;]+);/.exec(block) || [])[1]?.trim() || '',
            });
        }
        return faces;
    }

    async function downloadFile(url, dest) {
        const resp = await doFetch(url, { signal: AbortSignal.timeout(120000) });
        if (!resp.ok) throw new Error(`HTTP ${resp.status} ${url}`);
        const buf = Buffer.from(await resp.arrayBuffer());
        if (buf.length < 100) throw new Error(`font file too small: ${url}`);
        const tmp = `${dest}.part`;
        fs.writeFileSync(tmp, buf);
        fs.renameSync(tmp, dest);
        return buf.length;
    }

    async function downloadFamily(family) {
        const index = await loadVariantIndex();
        const variants = index[family];
        if (!variants) throw new Error(`不是 Google 字体: ${family}`);

        const cssResp = await doFetch(buildCssUrl(family, variants), {
            headers: { 'User-Agent': CSS_USER_AGENT },
            signal: AbortSignal.timeout(15000),
        });
        if (!cssResp.ok) throw new Error(`css HTTP ${cssResp.status}`);
        const faces = parseFontFaces(await cssResp.text());
        if (faces.length === 0) throw new Error('css 中没有字体文件');

        const dir = familyDir(family);
        fs.mkdirSync(dir, { recursive: true });

        const files = faces.map((face, i) => {
            const ext = (path.extname(new URL(face.url).pathname) || '.ttf').toLowerCase();
            const suffix = face.unicodeRange ? `-${i}` : '';
            return { ...face, file: `${face.weight.replace(/\s+/g, '-')}${face.style === 'italic' ? 'i' : ''}${suffix}${ext}` };
        });

        let totalBytes = 0;
        let cursor = 0;
        const worker = async () => {
            while (cursor < files.length) {
                const f = files[cursor++];
                totalBytes += await downloadFile(f.url, path.join(dir, f.file));
            }
        };
        await Promise.all(Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, files.length) }, worker));

        writeManifest(dir, {
            family,
            source: 'google',
            ts: Date.now(),
            files: files.map(({ file, weight, style, unicodeRange }) => ({ file, weight, style, unicodeRange })),
        });
        log(`[FontCache] cached ${family}: ${files.length} files, ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
        return readManifest(dir);
    }

    async function ensure(family) {
        if (typeof family !== 'string' || !family.trim() || family.length > 120) {
            throw new Error('invalid font family');
        }
        family = family.trim();
        const cached = readManifest(familyDir(family));
        if (cached) return cached;
        if (inflight.has(family)) return inflight.get(family);
        const pending = downloadFamily(family).finally(() => inflight.delete(family));
        inflight.set(family, pending);
        return pending;
    }

    function list() {
        try {
            if (!fs.existsSync(root)) return [];
            return fs.readdirSync(root, { withFileTypes: true })
                .filter(d => d.isDirectory())
                .map(d => readManifest(path.join(root, d.name)))
                .filter(Boolean);
        } catch (err) {
            log(`[FontCache] list failed: ${err.message}`);
            return [];
        }
    }

    function saveUpload(family, data, fileName) {
        if (typeof family !== 'string' || !family.trim()) throw new Error('invalid font family');
        const ext = path.extname(String(fileName || '')).toLowerCase() || '.ttf';
        if (!UPLOAD_EXTS.has(ext)) throw new Error(`不支持的字体格式: ${ext}`);
        const buf = Buffer.from(data);
        if (buf.length < 100) throw new Error('font file too small');
        const dir = familyDir(family.trim());
        fs.mkdirSync(dir, { recursive: true });
        const file = `upload${ext}`;
        fs.writeFileSync(path.join(dir, file), buf);
        writeManifest(dir, {
            family: family.trim(),
            source: 'upload',
            ts: Date.now(),
            files: [{ file, weight: '100 900', style: 'normal', unicodeRange: '' }],
        });
        return readManifest(dir);
    }

    return { root, ensure, list, saveUpload, _buildCssUrl: buildCssUrl, _parseFontFaces: parseFontFaces };
}

module.exports = { createFontCache };
