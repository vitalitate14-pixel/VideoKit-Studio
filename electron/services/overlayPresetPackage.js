const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { fileURLToPath, pathToFileURL } = require('url');
const archiver = require('archiver');
const { pipeline } = require('stream/promises');
const { safeExtractZip: extract } = require('./safeZipExtract');

// Keep media formats aligned with the local-media protocol used by previews.
const ALLOWED_MEDIA_EXT_RE = /\.(png|jpe?g|webp|gif|bmp|svg|ico|tiff?|avif|mp4|mov|m4v|mkv|webm|avi|flv|3gp|wmv|ts|mp3|wav|m4a|aac|ogg|flac|opus|wma|aiff?|amr)$/i;

function layersOf(preset) { return Array.isArray(preset) ? preset : (preset?.layers || []); }
function isMediaLayer(layer) { return ['image', 'video', 'audio'].includes(layer?.type); }
function isInlineMedia(value) { return typeof value === 'string' && /^data:/i.test(value); }

function sourcePath(value) {
    if (typeof value !== 'string' || value.startsWith('data:')) return '';
    try {
        const localValue = value.replace(/^local-media:/i, 'file:');
        const p = /^file:/i.test(localValue) ? fileURLToPath(localValue) : (path.isAbsolute(localValue) ? localValue : '');
        if (!p || !ALLOWED_MEDIA_EXT_RE.test(p)) return '';
        const resolved = fs.existsSync(p) ? fs.realpathSync(p) : p;
        if (!ALLOWED_MEDIA_EXT_RE.test(resolved)) return '';
        const normLower = resolved.replace(/\\/g, '/').toLowerCase();
        if (normLower.includes('/.ssh/') || normLower.includes('/.aws/') || normLower.includes('/.gnupg/')) return '';
        return resolved;
    } catch (_) { return ''; }
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }

async function exportPackage({ presets, outputPath }) {
    const copied = new Map(), missing = [], packaged = clone(presets || {});
    for (const [presetName, preset] of Object.entries(packaged)) for (const [index, layer] of layersOf(preset).entries()) {
        if (!isMediaLayer(layer) || isInlineMedia(layer.content)) continue;
        const source = sourcePath(layer?.content);
        if (!source || !fs.existsSync(source) || !fs.statSync(source).isFile()) {
            missing.push(`预设「${presetName}」第 ${index + 1} 层${layer?.name ? `（${layer.name}）` : ''}：${String(layer?.content || '未指定文件')}`);
            continue;
        }
        let asset = copied.get(source);
        if (!asset) {
            const ext = path.extname(source);
            const name = path.basename(source, ext).replace(/[^\w.-]+/g, '_').slice(0, 80) || 'media';
            asset = `assets/${crypto.createHash('sha256').update(source).digest('hex').slice(0, 12)}_${name}${ext}`;
            copied.set(source, asset);
        }
        layer.content = asset;
    }
    if (missing.length) {
        throw new Error(`以下媒体无法打包（文件缺失、格式不支持或路径受保护），请修复后重试：\n${missing.join('\n')}`);
    }
    // Publish only complete archives; a failed export must preserve an existing package.
    const stagingPath = `${outputPath}.${crypto.randomUUID()}.tmp`;
    try {
        const out = fs.createWriteStream(stagingPath, { flags: 'wx' });
        const zip = archiver('zip', { zlib: { level: 6 } });
        zip.on('warning', error => zip.destroy(error));
        const completed = pipeline(zip, out);
        zip.append(JSON.stringify({ format: 'videokit-overlay-preset-package', version: 1, presets: packaged, missingMedia: missing }, null, 2), { name: 'manifest.json' });
        for (const [source, asset] of copied) zip.file(source, { name: asset });
        zip.finalize().catch(error => zip.destroy(error));
        await completed;
        await fs.promises.rename(stagingPath, outputPath);
    } finally {
        await fs.promises.rm(stagingPath, { force: true });
    }
    return { copied: copied.size, missing };
}

async function importPackage({ packagePath, destinationDir }) {
    const target = path.join(destinationDir, `overlay-package-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`);
    await extract(packagePath, { dir: target });
    const manifest = JSON.parse(await fs.promises.readFile(path.join(target, 'manifest.json'), 'utf8'));
    if (manifest?.format !== 'videokit-overlay-preset-package' || !manifest.presets || typeof manifest.presets !== 'object') throw new Error('不是有效的 VideoKit 覆层预设包');
    const assetsRoot = path.resolve(target, 'assets') + path.sep;
    for (const preset of Object.values(manifest.presets)) for (const layer of layersOf(preset)) {
        if (typeof layer?.content !== 'string' || !layer.content.startsWith('assets/')) continue;
        const assetPath = path.resolve(target, layer.content);
        if (!assetPath.startsWith(assetsRoot) || !fs.existsSync(assetPath)) throw new Error(`预设包中的媒体文件缺失：${layer.content}`);
        layer.content = pathToFileURL(assetPath).href;
    }
    return { presets: manifest.presets, assetDir: target, missing: manifest.missingMedia || [] };
}

async function savePresetAssets({ preset, destinationDir }) {
    const saved = clone(preset);
    const assetDir = path.join(destinationDir, `saved-overlay-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`, 'assets');
    let copied = 0;
    const missing = [];
    for (const [index, layer] of (saved.layers || []).entries()) {
        if (!isMediaLayer(layer)) continue;
        const source = sourcePath(layer?.content);
        // data: URL 已直接存入预设，不需要额外复制。其余媒体必须能被解析为
        // 本机文件；过去这里静默跳过，UI 却仍提示“已复制”，导致跨任务加载失效。
        if (isInlineMedia(layer?.content)) continue;
        if (!source || !fs.existsSync(source) || !fs.statSync(source).isFile()) {
            missing.push(`第 ${index + 1} 层${layer?.name ? `（${layer.name}）` : ''}：${String(layer?.content || '未指定文件')}`);
            continue;
        }
        await fs.promises.mkdir(assetDir, { recursive: true });
        const ext = path.extname(source), stem = path.basename(source, ext).replace(/[^\w.-]+/g, '_').slice(0, 80) || 'media';
        const target = path.join(assetDir, `${crypto.createHash('sha256').update(source).digest('hex').slice(0, 12)}_${stem}${ext}`);
        await fs.promises.copyFile(source, target);
        layer.content = pathToFileURL(target).href;
        copied++;
    }
    if (missing.length) {
        throw new Error(`以下媒体无法复制到预设库（文件缺失、格式不支持或路径受保护），请修复后重试：\n${missing.join('\n')}`);
    }
    saved.meta = { ...(saved.meta || {}), mediaStorage: copied ? 'packaged' : 'linked', packagedMediaCount: copied };
    return { preset: saved, copied };
}

module.exports = { exportPackage, importPackage, savePresetAssets };
