/**
 * 桌面端精准路径安全边界模块
 *
 * 设计原则（兼顾安全审计与桌面剪辑工作流）：
 * 1. 绝不限制用户访问任意正常盘符、外置硬盘（/Volumes/...、D:\...）、历史素材库与工程目录；
 * 2. 精确拦截应用自身密钥文件与系统敏感凭据区（支持软链接真实路径还原，含尚未创建的新文件父目录还原）；
 * 3. 普通用户项目/模板文件夹下的同名 config.json 正常放行，仅保护应用 userData 配置目录下的 config.json；
 * 4. 拦截单文件名参数中的 ../ 跨目录逃逸，以及通用写入接口写入脚本/可执行文件。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const ALWAYS_SENSITIVE_FILENAMES = new Set([
    'ai-api.json',
    'ai-api-log.jsonl',
    'elevenlabs_settings.json',
    'gemini_keys.json',
    'gladia_keys.json',
    'transcription_providers.json',
    'updater-settings.json',
    '.env',
    '.npmrc',
    '.netrc',
    '.pypirc',
    '.zshrc',
    '.bashrc',
    '.bash_profile',
    '.zprofile',
    'id_rsa',
    'id_ed25519',
    'id_ecdsa',
    'authorized_keys',
    'known_hosts',
]);

const DANGEROUS_WRITE_EXTENSIONS = new Set([
    '.sh', '.bash', '.zsh', '.command', '.py', '.pyc', '.js', '.mjs', '.cjs',
    '.exe', '.bat', '.cmd', '.ps1', '.vbs', '.dll', '.so', '.dylib', '.app', '.plist',
]);

const ALLOWED_BRIDGE_CHANNELS = new Set([
    'hedra:import-autoedit',
    'hedra:clip-updated',
    'upload-organizer:progress',
    'gdrive-download-progress',
    'gdrive-parse-progress',
    'gdrive-size-progress',
    'gdrive-review-progress',
    'batch-download-progress',
    'url-thumbnail-progress',
    'template-package-progress',
    'batch-used-media-progress',
    'elevenlabs-web-auth-status',
    'isolated-wysiwyg-progress',
    'parallel-export-progress',
    'update-status',
]);

/**
 * 解析目标路径的真实物理路径；当目标文件或中间子目录尚未创建时，
 * 向上回溯到最近存在的祖先目录做 realpathSync 再拼接剩余相对段，
 * 既能防符号链接目录穿越，又不会误伤尚未 mkdir 的正常导出路径。
 */
function resolveRealOrTargetPath(filePath) {
    const abs = path.resolve(filePath);
    try {
        if (fs.existsSync(abs)) {
            return fs.realpathSync(abs);
        }
    } catch (_) {
        return abs;
    }

    const tailParts = [];
    let cur = abs;
    for (let i = 0; i < 64; i++) {
        const parent = path.dirname(cur);
        tailParts.unshift(path.basename(cur));
        if (parent === cur) break;
        cur = parent;
        try {
            if (fs.existsSync(cur)) {
                const realAncestor = fs.realpathSync(cur);
                return path.join(realAncestor, ...tailParts);
            }
        } catch (_) {
            break;
        }
    }
    return abs;
}

function getAppProtectedDataPrefixes() {
    const prefixes = [];
    const addDir = (d) => {
        if (!d) return;
        const resolved = resolveRealOrTargetPath(d).replace(/\\/g, '/').toLowerCase();
        prefixes.push(resolved.endsWith('/') ? resolved : `${resolved}/`);
    };

    try {
        const electron = require('electron');
        const appObj = electron?.app;
        if (appObj && typeof appObj.getPath === 'function') {
            addDir(appObj.getPath('userData'));
        }
    } catch (_) { }

    const home = os.homedir();
    if (home) {
        addDir(path.join(home, 'Library', 'Application Support', 'videokit'));
        addDir(path.join(home, 'Library', 'Application Support', 'VideoKit'));
        addDir(path.join(home, 'Library', 'Application Support', 'pymediatools'));
        addDir(path.join(home, 'AppData', 'Roaming', 'videokit'));
        addDir(path.join(home, 'AppData', 'Roaming', 'VideoKit'));
        addDir(path.join(home, '.config', 'videokit'));
        addDir(path.join(home, '.config', 'VideoKit'));
    }
    return prefixes;
}

function isInsideAppConfigDir(normLower) {
    const prefixes = getAppProtectedDataPrefixes();
    return prefixes.some((prefix) => normLower.startsWith(prefix));
}

function isBlockedSensitivePath(filePath) {
    if (!filePath || typeof filePath !== 'string' || filePath.includes('\0')) return true;
    try {
        const resolved = resolveRealOrTargetPath(filePath);
        const baseLower = path.basename(resolved).toLowerCase();
        const normLower = resolved.replace(/\\/g, '/').toLowerCase();

        if (ALWAYS_SENSITIVE_FILENAMES.has(baseLower)) return true;
        if (baseLower.startsWith('.env.')) return true;

        // 仅拦截应用自身配置目录下的 config.json（如 electron-store），放行用户素材/模板目录中的 config.json
        if (baseLower === 'config.json' && isInsideAppConfigDir(normLower)) {
            return true;
        }

        if (
            normLower.includes('/.ssh/') ||
            normLower.endsWith('/.ssh') ||
            normLower.includes('/.aws/') ||
            normLower.endsWith('/.aws') ||
            normLower.includes('/.gnupg/') ||
            normLower.endsWith('/.gnupg') ||
            normLower.includes('/.kube/') ||
            normLower.endsWith('/.kube') ||
            normLower.includes('/.git/') ||
            normLower.endsWith('/.git') ||
            normLower.endsWith('/voice-studio/state.json')
        ) {
            return true;
        }
        return false;
    } catch (_) {
        return true;
    }
}

function isBlockedWritePath(filePath, { allowExecutableExt = false } = {}) {
    if (isBlockedSensitivePath(filePath)) return true;
    try {
        const resolved = resolveRealOrTargetPath(filePath);
        const normLower = resolved.replace(/\\/g, '/').toLowerCase();
        if (normLower.includes('/app.asar/') || normLower.endsWith('/app.asar')) {
            return true;
        }
        if (!allowExecutableExt) {
            const ext = path.extname(resolved).toLowerCase();
            if (DANGEROUS_WRITE_EXTENSIONS.has(ext)) return true;
        }
        return false;
    } catch (_) {
        return true;
    }
}

function assertSafeFileMutation(filePath, { allowExecutableExt = false } = {}) {
    if (!filePath || typeof filePath !== 'string' || filePath.includes('\0')) {
        throw new Error('缺少有效文件路径');
    }
    if (isBlockedSensitivePath(filePath)) {
        throw new Error('安全策略拦截：不允许修改或删除受保护的密钥与系统配置路径');
    }
    const resolved = resolveRealOrTargetPath(filePath);
    const normLower = resolved.replace(/\\/g, '/').toLowerCase();
    if (normLower.includes('/app.asar/') || normLower.endsWith('/app.asar')) {
        throw new Error('安全策略拦截：不允许修改应用内部程序包');
    }
    if (!allowExecutableExt) {
        const ext = path.extname(resolved).toLowerCase();
        if (DANGEROUS_WRITE_EXTENSIONS.has(ext)) {
            throw new Error(`安全策略拦截：不允许通过通用文件接口写入可执行或脚本格式 (${ext})`);
        }
    }
    return resolved;
}

/**
 * 确保单文件名不包含目录分隔符或 ..（防止 destFileName 跳出 destDir），
 * 同时 100% 保留中文、空格、符号等正常媒体文件名。
 */
function assertSafeSingleFileName(fileName) {
    const raw = String(fileName || '').trim();
    if (!raw || raw === '.' || raw === '..' || raw.includes('/') || raw.includes('\\') || raw.includes('\0')) {
        throw new Error(`非法目标文件名: ${raw || '(空)'}`);
    }
    return raw;
}

/**
 * 清理子目录名（如审核批次目录名），确保不会通过 .. 跳出父目录。
 */
function sanitizeChildDirName(name) {
    const cleaned = String(name || '')
        .replace(/[\\/:*?"<>|\0]/g, '_')
        .trim();
    if (!cleaned || cleaned === '.' || cleaned === '..' || cleaned.includes('..')) {
        const safe = cleaned.replace(/\.+/g, '_').replace(/^_+|_+$/g, '');
        return safe || 'batch';
    }
    return cleaned;
}

function isAllowedBridgeChannel(channel) {
    return typeof channel === 'string' && ALLOWED_BRIDGE_CHANNELS.has(channel);
}

module.exports = {
    ALWAYS_SENSITIVE_FILENAMES,
    DANGEROUS_WRITE_EXTENSIONS,
    ALLOWED_BRIDGE_CHANNELS,
    resolveRealOrTargetPath,
    isBlockedSensitivePath,
    isBlockedWritePath,
    assertSafeFileMutation,
    assertSafeSingleFileName,
    sanitizeChildDirName,
    isAllowedBridgeChannel,
};

