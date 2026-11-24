/**
 * Google Drive 批量与文件夹流式下载服务
 * 
 * 核心特性：
 * 1. 真实名称与层级还原：递归提取 Google 网页端的真实文件夹名、子目录层级与真实文件名，默认绝不修改！
 * 2. 识别进度实时反馈：流式通知当前扫描目标、正在读取的文件夹、已检索文件数
 * 3. 真实高清缩略图：从 Drive 视图直接提取包含鉴权 token 的 Google 原生直显缩略图，防止防盗链拦截
 * 4. 零 API Key 依赖：纯公开网络抓取，无须申请配置任何 API Key
 * 5. 大文件断点续传：支持 HTTP Range、.part 临时文件流式落盘、自动绕过病毒扫描确认提示
 * 6. 并发与取消控制：支持多任务并行调度、独立取消与全局取消
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const axios = require('axios');
const driveInput = require('../../src/google-drive-input');

// 标准请求头，伪装桌面浏览器以避免反爬限制
const DEFAULT_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
};

const COMMON_KNOWN_EXTENSIONS = [
    '.tar.gz', '.tar.bz2', '.mp4', '.mov', '.mkv', '.avi', '.webm',
    '.flv', '.m4v', '.wmv', '.ts', '.3gp', '.jpg', '.jpeg', '.png',
    '.webp', '.gif', '.svg', '.bmp', '.mp3', '.wav', '.m4a', '.aac',
    '.flac', '.docx', '.xlsx', '.pptx', '.zip', '.rar', '.7z', '.pdf', '.json', '.txt'
];

// 当前活跃的下载任务与控制器
const activeDownloads = new Map(); // taskId -> { controller, task }

// ==================== 1. URL 解析与文件名安全处理 ====================

/**
 * 提取 Google Drive 文件 ID
 */
function extractGoogleDriveFileId(url) {
    const link = driveInput.parseLink(url);
    return link?.type === 'file' ? link.id : null;
}

/**
 * 提取 Google Drive 文件夹 ID
 */
function extractGoogleDriveFolderId(url) {
    const link = driveInput.parseLink(url);
    return link?.type === 'folder' ? link.id : null;
}

/**
 * `open?id=...` 不是文件专用格式：Google 会用 307 把它转到 file 或 folders。
 * 不能仅凭 query id 判断，否则文件夹会被误当成单文件下载。
 */
async function resolveOpenLinkTarget(url) {
    let parsed;
    try { parsed = new URL(url); } catch (_) { return null; }
    if (!/(^|\.)drive\.google\.com$/i.test(parsed.hostname)) return null;

    try {
        const res = await axios.get(url, {
            headers: DEFAULT_HEADERS,
            maxRedirects: 5,
            timeout: 10000,
            validateStatus: () => true,
        });
        const location = res.headers?.location || res.request?.res?.responseUrl || res.request?._redirectable?._currentUrl || '';
        const folderId = extractGoogleDriveFolderId(location);
        if (folderId) return { type: 'folder', id: folderId };
        // 即便输入是 /file/d/ID/view，云端页面也可能明确标记为文件夹。
        const html = String(res.data || '');
        const rootId = extractGoogleDriveFileId(url);
        if (rootId && /application\/vnd\.google-apps\.folder/.test(html)) {
            // 不凭子项 MIME 推断根目录类型；仅接受指向当前 ID 的目录地址。
            const folderLinks = html.match(/(?:https?:\/\/drive\.google\.com)?\/drive\/(?:u\/\d+\/)?folders\/[a-zA-Z0-9_-]+/g) || [];
            if (folderLinks.some(link => extractGoogleDriveFolderId(link) === rootId)) {
                return { type: 'folder', id: rootId };
            }
        }
        const fileId = extractGoogleDriveFileId(location);
        if (fileId) return { type: 'file', id: fileId };
    } catch (_) { }
    return null;
}

/**
 * 修复常见 UTF-8 / Latin-1 乱码
 */
function fixMojibake(text) {
    if (!text || typeof text !== 'string') return text;
    const markers = ['Ã', 'Â', 'â', 'ð', 'è', 'é', 'ê', 'ë', 'ì', 'í', 'î', 'ï', 'æ', 'ç', 'å', 'ã', '¤', ' '];
    if (!markers.some(m => text.includes(m))) return text;

    try {
        const decoded = Buffer.from(text, 'latin1').toString('utf8');
        if (/[\u4e00-\u9fa5]/.test(decoded)) return decoded;
    } catch (_) { }

    return text;
}

/**
 * 清洗 Google Drive 页面标题（剥离 - Google Drive / Google 云端硬盘）
 */
function cleanDriveFilename(title) {
    if (!title || typeof title !== 'string') return '';
    let cleaned = fixMojibake(title.trim());
    cleaned = cleaned.replace(/\s*-\s*Google\s+(?:云端硬盘|云端硬碟|Drive|Docs|Sheets|Slides|Drawings).*$/i, '').trim();
    return cleaned;
}

/**
 * 从用户输入中安全分离主体名称与常见扩展名
 */
function splitUserNameAndExt(customName) {
    if (!customName) return { base: '', ext: '' };
    const name = String(customName).trim();
    for (const ext of COMMON_KNOWN_EXTENSIONS) {
        if (name.toLowerCase().endsWith(ext)) {
            return {
                base: name.slice(0, -ext.length).replace(/[. ]+$/, ''),
                ext: ext,
            };
        }
    }
    return { base: name, ext: '' };
}

/**
 * 根据用户给定的新名称和真实文件名，计算最终重命名的文件名。
 * 核心原则：严格保留或匹配文件的真实文件扩展名（绝不乱改后缀）。
 */
function resolveRenamedFilename(customName, driveFilename) {
    if (!customName || !String(customName).trim()) return driveFilename || 'file';

    const { base: userBase, ext: userExt } = splitUserNameAndExt(customName);
    const driveExt = path.extname(driveFilename || '').toLowerCase();

    const finalExt = driveExt || userExt || '';
    const finalBase = userBase || String(customName).trim();
    return `${finalBase}${finalExt}`;
}

/**
 * 文件夹内批量多文件按序号对齐补零命名
 */
function makeNumberedName(customName, index, total) {
    if (!customName) return null;
    if (total <= 1) return customName;
    const { base: userBase, ext: userExt } = splitUserNameAndExt(customName);
    const padLen = Math.max(2, String(total).length);
    const numStr = String(index).padStart(padLen, '0');
    const sep = /[_ \-\.]$/.test(userBase) ? '' : '_';
    return `${userBase}${sep}${numStr}${userExt}`;
}

function sanitizeSingleFileName(name, fallback = 'file') {
    const cleaned = String(name || '')
        .replace(/[\x00-\x1f/\\<>:"|?*]/g, '_')
        .replace(/^\.+$/, '')
        .trim();
    return cleaned || fallback;
}

function sanitizeRelativeFolderPath(relPath) {
    if (!relPath || typeof relPath !== 'string') return '';
    return relPath
        .split(/[\\/]+/)
        .map(seg => seg.replace(/[\x00-\x1f<>:"|?*]/g, '_').trim())
        .filter(seg => seg && seg !== '.' && seg !== '..')
        .join(path.sep);
}

/**
 * 解析 Content-Disposition 响应头中的文件名
 */
function parseContentDispositionFilename(header) {
    if (!header || typeof header !== 'string') return null;

    const rfcMatch = header.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
    if (rfcMatch) {
        try {
            const decoded = decodeURIComponent(rfcMatch[1].trim().replace(/^["']|["']$/g, ''));
            return sanitizeSingleFileName(path.basename(decoded), null);
        } catch (_) { }
    }

    const stdMatch = header.match(/filename\s*=\s*"?([^";]+)"?/i);
    if (stdMatch) {
        const raw = stdMatch[1].trim();
        return sanitizeSingleFileName(path.basename(fixMojibake(raw)), null);
    }

    return null;
}

/**
 * 生成多级预览缩略图候选端点（包含原生 drive-storage 端点）
 */
function getDrivePreviewUrls(fileId, directThumbUrl = null) {
    const list = [];
    if (directThumbUrl) {
        list.push(directThumbUrl);
    }
    if (fileId) {
        list.push(
            `https://drive.google.com/thumbnail?id=${fileId}&sz=w800`,
            `https://drive.google.com/thumbnail?id=${fileId}&sz=w1600`,
            `https://lh3.googleusercontent.com/d/${fileId}=w800`,
            `https://lh3.googleusercontent.com/d/${fileId}`,
            `https://drive.google.com/thumbnail?id=${fileId}&sz=w320`
        );
    }
    return Array.from(new Set(list));
}

/**
 * 获取单文件的原始页面真实标题（不依赖 API Key）
 */
async function getDrivePageFileInfo(fileId, resourceKey = '', originalUrl = '') {
    if (!fileId) return null;
    const url = new URL(driveInput.parseLink(originalUrl)?.documentType ? originalUrl : `https://drive.google.com/file/d/${fileId}/view`);
    if (resourceKey) url.searchParams.set('resourcekey', resourceKey);
    try {
        const res = await axios.get(url.href, { headers: DEFAULT_HEADERS, timeout: 8000 });
        const html = String(res.data || '');
        const ogTitle = html.match(/<meta property="og:title" content="([^"]+)"/i);
        if (ogTitle && ogTitle[1]) {
            const clean = cleanDriveFilename(ogTitle[1]);
            if (clean && !clean.includes('404') && !clean.includes('Google Drive')) return clean;
        }
        const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
        if (titleMatch && titleMatch[1]) {
            const clean = cleanDriveFilename(titleMatch[1]);
            if (clean && !clean.includes('404') && !clean.includes('Google Drive')) return clean;
        }
    } catch (_) { }
    return null;
}

// ==================== 2. 文件夹递归扫描与识别 ====================

/**
/**
 * 广度优先 (BFS) 扫描 Google Drive 文件夹层级
 * 提取真实文件夹名、完整子目录层级、真实文件名与直显缩略图
 * 核心特性：维护显式队列，实时准确获知「已扫描多少个目录，还有多少个目录待扫描」！
 */
async function scanFolderRecursiveWeb(rootFolderId, initialParentPath = '', onProgress = null, visited = new Set(), lineContext = null, resourceKey = '') {
    if (!rootFolderId) return [];

    const queue = [{ id: rootFolderId, parentPath: initialParentPath, knownTitle: '', resourceKey }];
    visited.add(rootFolderId);

    const allFilesFound = [];
    const usedFolderRelPaths = new Set();
    let completedFoldersCount = 0;
    let totalDiscoveredFolders = 1;

    while (queue.length > 0) {
        const item = queue.shift();
        const currentFolderId = item.id;
        completedFoldersCount++;
        const pendingFoldersCount = queue.length;

        const keyParam = item.resourceKey ? `&resourcekey=${encodeURIComponent(item.resourceKey)}` : '';
        const url = `https://drive.google.com/embeddedfolderview?id=${encodeURIComponent(currentFolderId)}${keyParam}`;
        let html = '';
        try {
            const res = await axios.get(url, { headers: DEFAULT_HEADERS, timeout: 20000 });
            html = String(res.data || '');
        } catch (err) {
            // 备用尝试 /drive/folders/ 页面
            try {
                const res2 = await axios.get(`https://drive.google.com/drive/folders/${encodeURIComponent(currentFolderId)}${keyParam.replace(/^&/, '?')}`, {
                    headers: DEFAULT_HEADERS,
                    timeout: 20000,
                });
                html = String(res2.data || '');
            } catch (_) {
                continue;
            }
        }

        // 1. 获取当前文件夹真实名称
        const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
        let folderTitle = titleMatch ? cleanDriveFilename(titleMatch[1]) : (item.knownTitle || '');
        if (!folderTitle || folderTitle.toLowerCase().includes('error') || folderTitle.includes('404')) {
            folderTitle = item.knownTitle || `Folder_${currentFolderId}`;
        }

        // 🌟 同名文件夹不能合并：若同层级已有相同名称目录，自动重命名为 (2), (3) 等
        let candidateRelPath = item.parentPath ? `${item.parentPath}/${folderTitle}` : folderTitle;
        if (usedFolderRelPaths.has(candidateRelPath)) {
            let counter = 2;
            while (usedFolderRelPaths.has(item.parentPath ? `${item.parentPath}/${folderTitle} (${counter})` : `${folderTitle} (${counter})`)) {
                counter++;
            }
            folderTitle = `${folderTitle} (${counter})`;
            candidateRelPath = item.parentPath ? `${item.parentPath}/${folderTitle}` : folderTitle;
        }
        usedFolderRelPaths.add(candidateRelPath);

        const currentFolderRelPath = candidateRelPath;

        if (onProgress) {
            onProgress({
                stage: 'scanning_folder',
                folderTitle,
                folderRelPath: currentFolderRelPath,
                scannedFolders: completedFoldersCount,
                pendingFolders: pendingFoldersCount,
                totalDiscoveredFolders,
                percent: Math.round((completedFoldersCount / Math.max(1, totalDiscoveredFolders)) * 100),
                totalFilesFound: allFilesFound.length,
                lineContext,
                message: `正在扫描：${folderTitle} · 已扫描 ${completedFoldersCount} 个目录，剩余 ${pendingFoldersCount} 个待扫描`,
            });
        }

        const currentFiles = [];
        const currentSubFolders = [];

        // 解析 embeddedfolderview 条目
        const entryRegex = /<div class="flip-entry"[^>]*id="entry-([a-zA-Z0-9_-]+)"[\s\S]*?<div class="flip-entry-title">([^<]+)<\/div>/g;
        let m;
        while ((m = entryRegex.exec(html)) !== null) {
            const entryId = m[1];
            const entryTitle = fixMojibake(m[2].trim());
            const entrySnippet = m[0];
            const linkedResource = (entrySnippet.match(/href=["']([^"']+)/g) || []).map(attr => driveInput.parseLink(attr.slice(6))).find(link => link?.id === entryId);
            const entryResourceKey = linkedResource?.resourceKey || '';

            const isSubFolder = entrySnippet.includes('/drive/folders/') || entrySnippet.includes('drive-sprite-folder');
            const thumbMatch = entrySnippet.match(/class="flip-entry-thumb"><img src="([^"]+)"/);
            const directThumbUrl = thumbMatch ? thumbMatch[1].replace(/&amp;/g, '&') : null;

            if (isSubFolder) {
                currentSubFolders.push({ id: entryId, title: entryTitle, resourceKey: entryResourceKey });
            } else {
                currentFiles.push({
                    id: `gdrive_${entryId}_${Date.now()}_${allFilesFound.length + currentFiles.length}`,
                    fileId: entryId,
                    resourceKey: entryResourceKey,
                    type: 'file',
                    originalUrl: `https://drive.google.com/file/d/${entryId}/view`,
                    name: entryTitle, // 真实文件名！默认绝不乱改！
                    rename: '', // 默认保持原名！
                    folderPath: currentFolderRelPath, // 真实多层级完整路径！
                    previewUrl: directThumbUrl || `https://drive.google.com/thumbnail?id=${entryId}&sz=w800`,
                    previewCandidates: getDrivePreviewUrls(entryId, directThumbUrl),
                    formula: `=IMAGE("https://drive.google.com/thumbnail?id=${entryId}&sz=w1600")`,
                    status: 'ready',
                    size: 0,
                    progress: 0,
                    speed: 0,
                });
            }
        }

        // 备用：如果页面没有 flip-entry，使用通用链接匹配
        if (currentFiles.length === 0 && currentSubFolders.length === 0) {
            const fileRegex = /https:\/\/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)\/view/g;
            let fm;
            while ((fm = fileRegex.exec(html)) !== null) {
                const fid = fm[1];
                currentFiles.push({
                    id: `gdrive_${fid}_${Date.now()}_${allFilesFound.length + currentFiles.length}`,
                    fileId: fid,
                    type: 'file',
                    originalUrl: `https://drive.google.com/file/d/${fid}/view`,
                    name: '',
                    nameReadError: '未读取到文件名',
                    rename: '',
                    folderPath: currentFolderRelPath,
                    previewUrl: `https://drive.google.com/thumbnail?id=${fid}&sz=w800`,
                    previewCandidates: getDrivePreviewUrls(fid),
                    formula: `=IMAGE("https://drive.google.com/thumbnail?id=${fid}&sz=w1600")`,
                    status: 'ready',
                    size: 0,
                    progress: 0,
                    speed: 0,
                });
            }
        }

        // 将新发现的未访问子文件夹加入队列
        for (const sub of currentSubFolders) {
            if (!visited.has(sub.id)) {
                visited.add(sub.id);
                queue.push({
                    id: sub.id,
                    parentPath: currentFolderRelPath,
                    knownTitle: sub.title,
                    resourceKey: sub.resourceKey
                });
                totalDiscoveredFolders++;
            }
        }

        allFilesFound.push(...currentFiles);

        if (onProgress) {
            onProgress({
                stage: 'folder_parsed',
                folderTitle,
                folderRelPath: currentFolderRelPath,
                filesInFolder: currentFiles.length,
                scannedFolders: completedFoldersCount,
                pendingFolders: queue.length,
                totalDiscoveredFolders,
                percent: Math.round((completedFoldersCount / Math.max(1, totalDiscoveredFolders)) * 100),
                totalFilesFound: allFilesFound.length,
                lineContext,
                message: `[${folderTitle}] 扫描完成 (+${currentFiles.length} 文件) · 目录进度: ${completedFoldersCount}/${totalDiscoveredFolders} (还有 ${queue.length} 个待扫描)`,
            });
        }
    }

    return allFilesFound;
}

/**
 * 提取层级路径中的首层（根）文件夹名称
 */
function getRootFolderSegment(folderPath) {
    if (!folderPath || typeof folderPath !== 'string') return '';
    const parts = folderPath.trim().split('/');
    return parts[0] || '';
}

/**
 * 替换层级路径中的首层（根）文件夹名称（保留下级所有子目录与层级结构）
 */
function replaceRootFolderSegment(folderPath, newRootName) {
    if (!newRootName || !newRootName.trim()) return folderPath || '';
    const cleanRoot = fixMojibake(newRootName.trim());
    if (!folderPath || !folderPath.trim()) return cleanRoot;
    const parts = folderPath.split('/');
    parts[0] = cleanRoot;
    return parts.join('/');
}

/**
 * 保证文件夹名称在集合中全局唯一（遇到同名自动重命名为 Name (2), Name (3) 等，杜绝同名合并）
 */
function getUniqueFolderName(baseName, usedNamesSet) {
    const cleanBase = (baseName && String(baseName).trim()) ? String(baseName).trim() : 'Folder';
    if (!usedNamesSet.has(cleanBase)) {
        usedNamesSet.add(cleanBase);
        return cleanBase;
    }
    const match = cleanBase.match(/^(.*?)(?:\s*\((\d+)\))?$/);
    const stem = (match && match[1]) ? match[1].trim() : cleanBase;
    let counter = match && match[2] ? parseInt(match[2], 10) + 1 : 2;

    while (usedNamesSet.has(`${stem} (${counter})`)) {
        counter++;
    }
    const unique = `${stem} (${counter})`;
    usedNamesSet.add(unique);
    return unique;
}

/**
 * 保证在目标磁盘目录下文件夹名称唯一，杜绝同名合并
 */
function resolveUniqueDiskFolderPaths(tasks, baseTargetDir) {
    if (!tasks || !tasks.length || !baseTargetDir) return;

    const rootFolders = new Set();
    tasks.forEach(t => {
        if (t.folderPath) {
            const root = t.folderPath.split('/')[0].trim();
            if (root) rootFolders.add(root);
        }
    });

    const folderMapping = new Map();
    const reservedDiskPaths = new Set();

    for (const root of rootFolders) {
        let candidate = root;
        let destPath = path.join(baseTargetDir, candidate);
        let counter = 2;

        while (fs.existsSync(destPath) || reservedDiskPaths.has(destPath)) {
            candidate = `${root} (${counter})`;
            destPath = path.join(baseTargetDir, candidate);
            counter++;
        }

        reservedDiskPaths.add(destPath);
        if (candidate !== root) {
            folderMapping.set(root, candidate);
        }
    }

    if (folderMapping.size > 0) {
        tasks.forEach(t => {
            if (t.folderPath) {
                const parts = t.folderPath.split('/');
                const root = parts[0].trim();
                if (folderMapping.has(root)) {
                    parts[0] = folderMapping.get(root);
                    t.folderPath = parts.join('/');
                }
            }
        });
    }
}

/**
 * 统一解析用户输入的文本（支持多行链接、共享文件夹、表格两列复制）
 */
async function parseDriveInput(rawText, options = {}, onProgress = null) {
    if (!rawText || typeof rawText !== 'string') return [];

    const lines = driveInput.parseText(rawText);
    const parsedList = [];
    const seenFileIds = new Set();
    const usedRootFolderNames = new Set(options.existingFolderNames || []);
    const expandFolders = options.expandFolders !== false;
    const renameFolderOnly = options.renameFolderOnly !== false; // 默认：仅重命名链接对应的文件夹，保护子文件与子文件夹名

    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];

        if (onProgress) {
            onProgress({
                stage: 'processing_line',
                current: index + 1,
                total: lines.length,
                foundCount: parsedList.length,
                message: `正在分析第 ${index + 1}/${lines.length} 行...`,
            });
        }

        const urlCandidate = line.url;
        const userRename = line.rename;
        let fileId = line.type === 'file' ? line.id : null;
        let folderId = line.type === 'folder' ? line.id : null;
        // 分享链接的路径不保证实际类型；/file/d/ 和 open?id= 都可能指向文件夹。
        if (fileId && !folderId) {
            const resolvedTarget = await resolveOpenLinkTarget(urlCandidate);
            if (resolvedTarget?.type === 'folder') {
                fileId = null;
                folderId = resolvedTarget.id;
            } else if (resolvedTarget?.type === 'file') {
                fileId = resolvedTarget.id;
            }
        }

        if (fileId) {
            if (!options.allowDuplicate && seenFileIds.has(fileId)) {
                continue;
            }
            seenFileIds.add(fileId);

            // 解析真实文件名
            let realName = await getDrivePageFileInfo(fileId, line.resourceKey, urlCandidate);
            if (driveInput.isMissingFileName(realName, fileId)) realName = '';

            const exportExt = driveInput.downloadUrls(fileId, line.resourceKey, urlCandidate).extension;
            if (realName && exportExt && !realName.toLowerCase().endsWith(exportExt)) realName += exportExt;

            parsedList.push({
                id: `gdrive_file_${fileId}_${index}`,
                type: 'file',
                fileId,
                originalUrl: urlCandidate,
                resourceKey: line.resourceKey,
                name: realName,
                nameReadError: realName ? '' : '未读取到文件名',
                rename: userRename ? fixMojibake(userRename) : '', // 默认保持原名！除非表格指定了新名
                folderPath: '',
                previewUrl: `https://drive.google.com/thumbnail?id=${fileId}&sz=w800`,
                previewCandidates: getDrivePreviewUrls(fileId),
                formula: `=IMAGE("https://drive.google.com/thumbnail?id=${fileId}&sz=w1600")`,
                status: 'ready',
                size: 0,
                progress: 0,
                speed: 0,
            });
        } else if (folderId) {
            // 自动递归展开共享文件夹
            if (expandFolders) {
                try {
                    const lineContext = {
                        lineCurrent: index + 1,
                        lineTotal: lines.length,
                        lineRemaining: lines.length - (index + 1),
                    };
                    const scanned = await scanFolderRecursiveWeb(folderId, '', onProgress, new Set(), lineContext, line.resourceKey);
                    if (scanned.length > 0) {
                        // 🌟 同名文件夹不能合并，需要重命名！
                        const originalRoot = getRootFolderSegment(scanned[0].folderPath) || `Folder_${folderId}`;
                        const targetRoot = userRename ? fixMojibake(userRename.trim()) : originalRoot;
                        const uniqueRoot = getUniqueFolderName(targetRoot, usedRootFolderNames);

                        for (const sf of scanned) {
                            if (!options.allowDuplicate && seenFileIds.has(sf.fileId)) continue;
                            seenFileIds.add(sf.fileId);

                            // 如果用户在表格中为文件夹指定了自定义命名
                            if (userRename) {
                                if (renameFolderOnly) {
                                    // 仅重命名链接对应的首层文件夹！内部所有子文件夹及子文件保持原始名称
                                    sf.rename = ''; // 保持文件原始文件名（不改名）
                                    sf.folderPath = replaceRootFolderSegment(sf.folderPath, uniqueRoot);
                                } else {
                                    // 传统模式：将文件夹内部文件重命名
                                    sf.rename = userRename;
                                    sf.folderPath = replaceRootFolderSegment(sf.folderPath, uniqueRoot);
                                }
                            } else {
                                // 用户未指定重命名，若发生重名，依然自动重命名避免合并！
                                if (uniqueRoot !== originalRoot) {
                                    sf.folderPath = replaceRootFolderSegment(sf.folderPath, uniqueRoot);
                                }
                            }
                            parsedList.push(sf);
                        }
                        continue;
                    }
                } catch (_) { }
            }

            // 未展开或未扫出文件，作为待展开项加入
            const rawTargetRoot = (userRename && renameFolderOnly) ? fixMojibake(userRename) : (userRename || `Drive_Folder_${folderId}`);
            const uniqueRoot = getUniqueFolderName(rawTargetRoot, usedRootFolderNames);
            parsedList.push({
                id: `gdrive_folder_${folderId}_${index}`,
                type: 'folder',
                folderId,
                originalUrl: urlCandidate,
                resourceKey: line.resourceKey,
                name: uniqueRoot,
                rename: userRename || '',
                folderPath: '',
                status: 'pending_scan',
            });
        }
    }

    if (onProgress) {
        onProgress({
            stage: 'finished',
            totalFound: parsedList.length,
            message: `识别完成，共发现 ${parsedList.length} 个文件`,
        });
    }

    return parsedList;
}

/**
 * 独立扫描单文件夹
 */
async function scanDriveFolder(folderUrlOrId, options = {}, onProgress = null) {
    const folderId = extractGoogleDriveFolderId(folderUrlOrId) || folderUrlOrId;
    if (!folderId) {
        throw new Error('无效的 Google Drive 文件夹链接或 ID');
    }
    return await scanFolderRecursiveWeb(folderId, '', onProgress, new Set(), null, driveInput.parseLink(folderUrlOrId)?.resourceKey || '');
}

// ==================== 3. 流式下载与断点续传引擎 ====================

function describeDriveDownloadFailure({ status, body = '', cause = null } = {}) {
    const text = String(body || '').toLowerCase();
    if (status === 404 || /not found|找不到|文件不存在/.test(text)) {
        return '链接无效，或该 Google Drive 文件已被删除（404）';
    }
    if (status === 401 || /sign in|登录|login/.test(text)) {
        return '需要登录 Google 账号：该链接不是公开可下载链接（401）';
    }
    if (status === 403) {
        if (/quota|download limit|too many users|过多用户|下载次数/.test(text)) {
            return 'Google Drive 暂时限制下载次数，请稍后再试（403）';
        }
        return '没有访问权限：请将文件设为“知道链接的任何人可查看/下载”，或使用有权限的账号（403）';
    }
    if (status === 429) return 'Google Drive 请求过于频繁，请稍后再试（429）';
    if (status >= 500) return `Google Drive 服务暂时异常（${status}），请稍后重试`;

    const code = cause?.code;
    if (code === 'ENOTFOUND') return '网络或 DNS 无法连接到 Google Drive';
    if (code === 'ETIMEDOUT' || code === 'ECONNABORTED') return '连接 Google Drive 超时，请检查网络后重试';
    if (code === 'ECONNRESET' || code === 'ECONNREFUSED') return '连接 Google Drive 被中断，请检查网络后重试';
    return cause?.message || 'Google Drive 未返回可下载文件';
}

function readResponseText(stream) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        stream.on('data', chunk => chunks.push(chunk));
        stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
        stream.on('error', reject);
    });
}

function responseOriginHint(headers = {}) {
    // 仅展示与来源判断有关的响应头，不泄露 cookie、链接或文件信息。
    const source = headers.server || headers.via || headers['x-cache'] || '';
    return source ? `；响应来源：${String(source).slice(0, 80)}` : '';
}

/**
 * 探测并获取真正的可下载文件直链（含自动绕过病毒扫描警告页面）
 */
async function resolveDriveDownloadStreamUrl(fileId, headers = {}, resourceKey = '', originalUrl = '') {
    const urls = driveInput.downloadUrls(fileId, resourceKey, originalUrl);
    const initialUrl = urls.initial;
    const fallbackUrl = urls.fallback;

    let resp;
    let usedFallbackEndpoint = false;
    let primaryStatus = 0;
    try {
        resp = await axios.get(initialUrl, {
            headers: { ...DEFAULT_HEADERS, ...headers },
            maxRedirects: 5,
            timeout: 30000,
            // 要读取 Google 返回的错误页，才能区分链接失效、权限不足和限流。
            validateStatus: () => true,
            responseType: 'stream',
        });
    } catch (err) {
        throw new Error(describeDriveDownloadFailure({ cause: err }));
    }

    // drive.usercontent.google.com 偶发会对整批请求返回 5xx；切到 Google 的
    // 传统 uc 下载端点再试一次，避免把 Google 入口故障误报为文件本身不可下载。
    if (resp.status >= 500) {
        primaryStatus = resp.status;
        try { resp.data.destroy(); } catch (_) { }
        try {
            resp = await axios.get(fallbackUrl, {
                headers: { ...DEFAULT_HEADERS, ...headers },
                maxRedirects: 5,
                timeout: 30000,
                validateStatus: () => true,
                responseType: 'stream',
            });
            usedFallbackEndpoint = true;
        } catch (err) {
            throw new Error(describeDriveDownloadFailure({ cause: err }));
        }
    }

    const contentType = String(resp.headers['content-type'] || '').toLowerCase();

    // 如果直接返回二进制流，说明直链有效
    if (resp.status >= 200 && resp.status < 300 && !contentType.includes('text/html')) {
        return {
            stream: resp.data,
            headers: resp.headers,
            status: resp.status,
            finalUrl: resp.request?.res?.responseUrl || initialUrl,
        };
    }

    // 处理大文件“无法扫描病毒”页面
    let htmlContent = '';
    if (contentType.includes('text/html')) {
        htmlContent = await readResponseText(resp.data);
    } else {
        try { resp.data.destroy(); } catch (_) { }
    }

    if (resp.status < 200 || resp.status >= 300) {
        if (usedFallbackEndpoint && primaryStatus >= 500) {
            throw new Error(
                `Google Drive 两个下载入口均异常：主入口 ${primaryStatus}，备用入口 ${resp.status}`
                + responseOriginHint(resp.headers)
            );
        }
        throw new Error(describeDriveDownloadFailure({ status: resp.status, body: htmlContent }));
    }

    if (urls.extension) {
        throw new Error('Google 文档未返回可导出的文件，请检查该链接的访问权限及是否允许下载');
    }

    // 匹配 confirm token
    let confirmToken = null;
    const confirmMatch = htmlContent.match(/[?&]confirm=([a-zA-Z0-9_-]+)/);
    if (confirmMatch) {
        confirmToken = confirmMatch[1];
    } else {
        const inputMatch = htmlContent.match(/name="confirm"\s+value="([^"]+)"/);
        if (inputMatch) confirmToken = inputMatch[1];
    }

    const confirmBase = usedFallbackEndpoint
        ? `https://drive.google.com/uc?export=download&id=${fileId}&confirm=${confirmToken || 't'}`
        : `https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=${confirmToken || 't'}&authuser=0`;

    const confirmUrl = confirmBase + (resourceKey ? `&resourcekey=${encodeURIComponent(resourceKey)}` : '');

    let streamResp;
    try {
        streamResp = await axios.get(confirmUrl, {
            headers: { ...DEFAULT_HEADERS, ...headers },
            maxRedirects: 5,
            timeout: 30000,
            validateStatus: () => true,
            responseType: 'stream',
        });
    } catch (err) {
        throw new Error(describeDriveDownloadFailure({ cause: err }));
    }

    const confirmedType = String(streamResp.headers['content-type'] || '').toLowerCase();
    if (streamResp.status < 200 || streamResp.status >= 300 || confirmedType.includes('text/html')) {
        const body = confirmedType.includes('text/html') ? await readResponseText(streamResp.data) : '';
        if (!confirmedType.includes('text/html')) {
            try { streamResp.data.destroy(); } catch (_) { }
        }
        throw new Error(describeDriveDownloadFailure({ status: streamResp.status, body }));
    }

    return {
        stream: streamResp.data,
        headers: streamResp.headers,
        status: streamResp.status,
        finalUrl: streamResp.request?.res?.responseUrl || confirmUrl,
    };
}

/**
 * 单个任务执行下载（保留原始文件夹名、原始层级与原始文件名）
 */
async function downloadSingleFile(task, targetDir, options = {}, onProgress) {
    const fileId = task.fileId;
    if (!fileId) throw new Error('缺少 fileId');
    if (driveInput.isMissingFileName(task.name, fileId)) {
        task.name = '';
        if (driveInput.isMissingFileName(task.rename, fileId)) task.rename = '';
        if (!String(task.rename || '').trim()) {
            const pageName = await getDrivePageFileInfo(fileId, task.resourceKey, task.originalUrl);
            const headerName = pageName ? '' : (await probeDriveFileSize(fileId, task.abortController?.signal || options.signal, task.resourceKey, task.originalUrl)).serverFileName;
            task.name = pageName || headerName || '';
            if (driveInput.isMissingFileName(task.name, fileId)) task.name = '';
        }
        task.nameReadError = task.name ? '' : '未读取到文件名';
        if (!task.name && !String(task.rename || '').trim()) throw new Error('未读取到文件名，已停止此文件下载；请重新识别或手动填写目标名');
    }

    // 自动建立批次文件夹（默认勾选）
    let finalTargetDir = targetDir;
    if (options.batchFolder && options.batchFolderName) {
        finalTargetDir = path.join(targetDir, sanitizeSingleFileName(options.batchFolderName, 'batch'));
    }

    // 严格保留原文件夹层级（过滤任何 .. 路径穿越段）！
    const relFolder = (options.preserveHierarchy && task.folderPath) ? sanitizeRelativeFolderPath(task.folderPath) : '';
    const finalDir = path.join(finalTargetDir, relFolder);
    const resolvedTargetRoot = path.resolve(finalTargetDir);
    const resolvedFinalDir = path.resolve(finalDir);
    if (resolvedFinalDir !== resolvedTargetRoot && !resolvedFinalDir.startsWith(resolvedTargetRoot + path.sep)) {
        throw new Error('非法的目标文件夹层级路径');
    }
    fs.mkdirSync(finalDir, { recursive: true });

    // 计算安全文件名（默认绝不乱改名！只有用户显式提供 rename 且不等于原名时才重命名）
    let targetFileName = task.name || '';
    if (task.rename && String(task.rename).trim() && String(task.rename).trim() !== task.name) {
        targetFileName = resolveRenamedFilename(task.rename.trim(), task.name || '');
    }

    let baseName = sanitizeSingleFileName(targetFileName, null);
    if (!baseName) throw new Error('未读取到有效文件名，请手动填写目标名');
    let finalFilePath = path.join(finalDir, baseName);
    if (!path.resolve(finalFilePath).startsWith(resolvedFinalDir + path.sep)) {
        throw new Error('非法的文件保存路径');
    }
    let partFilePath = `${finalFilePath}.part`;

    let startByte = 0;
    if (fs.existsSync(partFilePath)) {
        try {
            startByte = fs.statSync(partFilePath).size;
        } catch (_) {
            startByte = 0;
        }
    }

    const rangeHeaders = {};
    if (startByte > 0) {
        rangeHeaders['Range'] = `bytes=${startByte}-`;
    }

    const response = await resolveDriveDownloadStreamUrl(fileId, rangeHeaders, task.resourceKey, task.originalUrl);
    const { stream, headers: respHeaders } = response;
    // 某些 Drive 直链会忽略 Range 并返回完整文件（200）。这时若继续
    // append 会生成损坏文件；安全地从 0 重写，仍然保留真正支持 Range 的续传。
    if (startByte > 0 && response.status !== 206) startByte = 0;

    const disposition = respHeaders['content-disposition'];
    const serverFileName = parseContentDispositionFilename(disposition);
    if (serverFileName) {
        const wasMissingName = driveInput.isMissingFileName(task.name, fileId);
        if (wasMissingName) { task.name = serverFileName; task.nameReadError = ''; }
        // 如果没有用户自定义命名，且当前文件名只是临时 ID 名，使用服务端返回的真实文件名
        if (!task.rename && wasMissingName) {
            baseName = serverFileName;
            finalFilePath = path.join(finalDir, baseName);
            const newPart = `${finalFilePath}.part`;
            if (partFilePath !== newPart && fs.existsSync(partFilePath)) {
                try { fs.renameSync(partFilePath, newPart); } catch (_) { }
                partFilePath = newPart;
            }
        }
    }

    let totalBytes = 0;
    const contentRange = respHeaders['content-range'];
    if (contentRange) {
        const m = contentRange.match(/\/(\d+)/);
        if (m) totalBytes = Number(m[1]);
    } else if (respHeaders['content-length']) {
        totalBytes = startByte + Number(respHeaders['content-length']);
    }

    const writeStream = fs.createWriteStream(partFilePath, { flags: startByte > 0 ? 'a' : 'w' });
    let downloadedBytes = startByte;
    let lastTime = Date.now();
    let lastBytes = downloadedBytes;
    let speed = 0;

    return new Promise((resolve, reject) => {
        const cleanup = () => {
            stream.destroy();
            writeStream.end();
        };

        if (task.abortController) {
            task.abortController.signal.addEventListener('abort', () => {
                cleanup();
                reject(new Error('用户取消下载'));
            });
        }

        stream.on('data', chunk => {
            downloadedBytes += chunk.length;
            const now = Date.now();
            const elapsed = (now - lastTime) / 1000;
            if (elapsed >= 0.5) {
                speed = (downloadedBytes - lastBytes) / elapsed;
                lastTime = now;
                lastBytes = downloadedBytes;

                if (onProgress) {
                    onProgress({
                        taskId: task.id,
                        fileId,
                        fileName: baseName,
                        originalFileName: task.name || '',
                        filePath: finalFilePath,
                        status: 'downloading',
                        downloadedBytes,
                        totalBytes,
                        speed,
                        percent: totalBytes > 0 ? Math.min(99.9, (downloadedBytes / totalBytes) * 100) : 0,
                    });
                }
            }
        });

        stream.pipe(writeStream);

        writeStream.on('finish', () => {
            try {
                if (fs.existsSync(finalFilePath) && !options.overwrite) {
                    const ext = path.extname(finalFilePath);
                    const stem = finalFilePath.slice(0, finalFilePath.length - ext.length);
                    let counter = 2;
                    while (fs.existsSync(`${stem} (${counter})${ext}`)) {
                        counter++;
                    }
                    finalFilePath = `${stem} (${counter})${ext}`;
                }
                fs.renameSync(partFilePath, finalFilePath);

                if (onProgress) {
                    onProgress({
                        taskId: task.id,
                        fileId,
                        fileName: path.basename(finalFilePath),
                        originalFileName: task.name || '',
                        filePath: finalFilePath,
                        status: 'completed',
                        downloadedBytes: totalBytes || downloadedBytes,
                        totalBytes: totalBytes || downloadedBytes,
                        percent: 100,
                        speed: 0,
                    });
                }
                resolve({ filePath: finalFilePath, fileName: path.basename(finalFilePath), totalBytes });
            } catch (err) {
                reject(err);
            }
        });

        stream.on('error', err => {
            cleanup();
            reject(err);
        });

        writeStream.on('error', err => {
            cleanup();
            reject(err);
        });
    });
}

// ==================== 4. 并发队列管理 ====================

function plannedDownloadFileName(task) {
    const original = driveInput.isMissingFileName(task.name, task.fileId) ? '' : task.name;
    return (!driveInput.isMissingFileName(task.rename, task.fileId))
        ? resolveRenamedFilename(String(task.rename).trim(), original)
        : original;
}

function normalizeFolderName(name) {
    return String(name || '').trim().normalize('NFC').toLocaleLowerCase();
}

/**
 * 用户可能选择了上次下载的“云端根文件夹”，也可能选择其外层的“批量下载批次”
 * 目录。两种情况都应复用已有层级，不能再创建新的批次目录或同名根目录。
 */
function prepareExistingRootFolderReuse(tasks, outputDir, options) {
    // A new batch must never be silently redirected into an older folder.
    if (options.batchFolder !== false) return false;
    if (options.reuseExistingRoot === false || !outputDir) return false;

    const roots = Array.from(new Set(tasks
        .map(task => String(task.folderPath || '').split('/')[0].trim())
        .filter(Boolean)));
    const outputBaseName = path.basename(path.resolve(outputDir));
    if (roots.length !== 1) {
        return false;
    }

    const root = roots[0];
    const selectedIsRootFolder = normalizeFolderName(root) === normalizeFolderName(outputBaseName);
    const selectedIsBatchFolder = (() => {
        try { return fs.statSync(path.join(outputDir, root)).isDirectory(); } catch (_) { return false; }
    })();
    if (!selectedIsRootFolder && !selectedIsBatchFolder) return false;

    // 若用户选择的是根目录本身，去掉任务里的重复根段；若选择的是批次目录，
    // 保留根段，目标会是“已选批次目录/云端根目录/...”。
    if (selectedIsRootFolder) {
        for (const task of tasks) {
            if (task.folderPath === root) task.folderPath = '';
            else if (task.folderPath.startsWith(`${root}/`)) task.folderPath = task.folderPath.slice(root.length + 1);
        }
    }
    options.batchFolder = false;
    options.reuseExistingTargetRoot = true;
    return true;
}

/**
 * 启动批量下载队列
 */
async function startDownloadQueue(tasks, outputDir, options = {}, onProgress) {
    if (!tasks || tasks.length === 0) return { total: 0, completed: 0, failed: 0 };

    options.batchFolder = options.batchFolder !== false;
    const concurrency = Math.max(1, Math.min(10, options.concurrency || 3));
    const reusedExistingTargetRoot = prepareExistingRootFolderReuse(tasks, outputDir, options);
    let currentIndex = 0;
    let completedCount = 0;
    let failedCount = 0;
    let skippedCount = 0;
    const failures = [];

    // 默认开启批次文件夹
    if (options.batchFolder !== false) {
        const now = new Date();
        const y = now.getFullYear();
        const m = String(now.getMonth() + 1).padStart(2, '0');
        const d = String(now.getDate()).padStart(2, '0');
        const hh = String(now.getHours()).padStart(2, '0');
        const mm = String(now.getMinutes()).padStart(2, '0');
        const ss = String(now.getSeconds()).padStart(2, '0');
        options.batchFolderName = `批量下载批次-${y}${m}${d}_${hh}${mm}${ss}`;
        const prefix = String(options.batchFolderPrefix || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').trim();
        const suffix = String(options.batchFolderSuffix || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').trim();
        const separator = String(options.batchFolderSeparator ?? '-').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
        options.batchFolderName = [prefix, options.batchFolderName, suffix].filter(Boolean).join(separator);
        const batchName = options.batchFolderName;
        let counter = 2;
        while (fs.existsSync(path.join(outputDir, options.batchFolderName))) {
            options.batchFolderName = `${batchName} (${counter++})`;
        }
    }

    // 🌟 同名文件夹不能合并，需要重命名：校验目标磁盘路径，确保不会与已存在本地文件夹合并！
    const effectiveBaseDir = (options.batchFolder && options.batchFolderName) 
        ? path.join(outputDir, options.batchFolderName) 
        : outputDir;
    // 复用已有根目录时，子目录也必须原样复用；否则会被重命名为 “(2)”。
    if (!options.reuseExistingTargetRoot) {
        resolveUniqueDiskFolderPaths(tasks, effectiveBaseDir);
    }
    const runWorker = async () => {
        while (currentIndex < tasks.length) {
            const taskIndex = currentIndex++;
            const task = tasks[taskIndex];

            const expectedName = plannedDownloadFileName(task);
            const relativeDir = options.preserveHierarchy && task.folderPath ? task.folderPath : '';
            const existingPath = path.join(effectiveBaseDir, relativeDir, expectedName);
            let targetExists = false;
            if (expectedName && options.skipExisting !== false) {
                try {
                    const stat = fs.statSync(existingPath);
                    targetExists = stat.isFile() && stat.size > 0;
                } catch (_) { }
            }
            if (targetExists) {
                skippedCount++;
                task.filePath = existingPath;
                if (onProgress) onProgress({
                    taskId: task.id, fileId: task.fileId, fileName: path.basename(existingPath),
                    filePath: existingPath, status: 'skipped', skipped: true,
                    downloadedBytes: 0, totalBytes: task.size || 0, percent: 100, speed: 0,
                });
                continue;
            }

            const controller = new AbortController();
            task.abortController = controller;
            activeDownloads.set(task.id, { controller, task });

            if (onProgress) {
                onProgress({
                    taskId: task.id,
                    fileId: task.fileId,
                    fileName: task.rename || task.name,
                    status: 'downloading',
                    downloadedBytes: 0,
                    totalBytes: task.size || 0,
                    percent: 0,
                    speed: 0,
                });
            }

            try {
                const res = await downloadSingleFile(task, outputDir, options, onProgress);
                task.filePath = res.filePath;
                completedCount++;
            } catch (err) {
                failedCount++;
                // 返回失败明细，避免渲染端错过 IPC 进度事件后只知道“失败”而没有原因。
                failures.push({ taskId: task.id, fileId: task.fileId, error: err.message || String(err) });
                if (onProgress) {
                    onProgress({
                        taskId: task.id,
                        fileId: task.fileId,
                        fileName: task.rename || task.name,
                        status: 'error',
                        error: err.message,
                        percent: 0,
                        speed: 0,
                    });
                }
            } finally {
                activeDownloads.delete(task.id);
            }
        }
    };

    const workers = [];
    for (let i = 0; i < concurrency; i++) {
        workers.push(runWorker());
    }

    await Promise.all(workers);
    return {
        total: tasks.length,
        completed: completedCount,
        skipped: skippedCount,
        failed: failedCount,
        failures,
        reusedExistingTargetRoot,
        outputDir: effectiveBaseDir,
        batchFolderName: options.batchFolderName || "",
    };
}

/**
 * 取消指定任务
 */
function cancelDownload(taskId) {
    const entry = activeDownloads.get(taskId);
    if (entry) {
        entry.controller.abort();
        activeDownloads.delete(taskId);
        return true;
    }
    return false;
}

/**
 * 取消所有进行中的下载
 */
function cancelAllDownloads() {
    let count = 0;
    for (const [id, entry] of activeDownloads.entries()) {
        try {
            entry.controller.abort();
            count++;
        } catch (_) { }
    }
    activeDownloads.clear();
    return count;
}

// ==================== 4. 预估大小后台高速探测引擎 ====================

let activeProbingController = null;

/**
 * 格式化预估字节大小为 MB/GB/KB
 */
function formatBytesForProbe(bytes) {
    if (!bytes || bytes <= 0) return '未知';
    const mb = bytes / (1024 * 1024);
    if (mb < 0.1) {
        return (bytes / 1024).toFixed(1) + ' KB';
    }
    if (mb >= 1024) {
        return (mb / 1024).toFixed(2) + ' GB';
    }
    return mb.toFixed(2) + ' MB';
}

/**
 * 探测单个 Google Drive 文件的实际字节大小（仅传输 1 字节网络消耗，极速返回）
 */
async function probeDriveFileSize(fileId, signal = null, resourceKey = '', originalUrl = '') {
    if (!fileId) return { size: 0, formatted: '0 MB', serverFileName: null };

    const urls = driveInput.downloadUrls(fileId, resourceKey, originalUrl);
    const initialUrl = urls.initial;

    try {
        let res = await axios.get(initialUrl, {
            headers: { ...DEFAULT_HEADERS, 'Range': 'bytes=0-0' },
            maxRedirects: 5,
            responseType: 'stream',
            timeout: 8000,
            signal: signal || undefined,
            validateStatus: s => s >= 200 && s < 400
        });

        const contentType = String(res.headers['content-type'] || '').toLowerCase();
        let serverFileName = parseContentDispositionFilename(res.headers['content-disposition']);

        // 如果遇到超大文件的病毒扫描确认页面
        if (contentType.includes('text/html')) {
            let html = await new Promise((resolve, reject) => {
                const chunks = [];
                res.data.on('data', c => chunks.push(c));
                res.data.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
                res.data.on('error', reject);
            });
            let confirmToken = 't';
            const m = html.match(/[?&]confirm=([a-zA-Z0-9_-]+)/) || html.match(/name="confirm"\s+value="([^"]+)"/);
            if (m) confirmToken = m[1];

            const confirmUrl = `https://drive.usercontent.google.com/download?id=${encodeURIComponent(fileId)}&export=download&confirm=${confirmToken}&authuser=0${resourceKey ? "&resourcekey=" + encodeURIComponent(resourceKey) : ""}`;
            res = await axios.get(confirmUrl, {
                headers: { ...DEFAULT_HEADERS, 'Range': 'bytes=0-0' },
                maxRedirects: 5,
                responseType: 'stream',
                timeout: 8000,
                signal: signal || undefined,
                validateStatus: s => s >= 200 && s < 400
            });
            if (!serverFileName) {
                serverFileName = parseContentDispositionFilename(res.headers['content-disposition']);
            }
        }

        let totalBytes = 0;
        const cr = res.headers['content-range'];
        if (cr) {
            const m = cr.match(/\/(\d+)/);
            if (m) totalBytes = Number(m[1]);
        } else if (res.headers['content-length']) {
            totalBytes = Number(res.headers['content-length']);
        }
        try { res.data.destroy(); } catch (_) { }

        return {
            size: totalBytes,
            formatted: formatBytesForProbe(totalBytes),
            serverFileName: serverFileName || null,
        };
    } catch (err) {
        // 备用尝试 https://drive.google.com/uc?export=download&id=...
        try {
            const altUrl = urls.fallback;
            const res2 = await axios.get(altUrl, {
                headers: { ...DEFAULT_HEADERS, 'Range': 'bytes=0-0' },
                maxRedirects: 5,
                responseType: 'stream',
                timeout: 8000,
                signal: signal || undefined,
                validateStatus: s => s >= 200 && s < 400
            });
            let totalBytes = 0;
            const cr = res2.headers['content-range'];
            if (cr) {
                const m = cr.match(/\/(\d+)/);
                if (m) totalBytes = Number(m[1]);
            } else if (res2.headers['content-length']) {
                totalBytes = Number(res2.headers['content-length']);
            }
            const sName = parseContentDispositionFilename(res2.headers['content-disposition']);
            try { res2.data.destroy(); } catch (_) { }

            return {
                size: totalBytes,
                formatted: formatBytesForProbe(totalBytes),
                serverFileName: sName || null,
            };
        } catch (_) {
            return { size: 0, formatted: '未知', serverFileName: null };
        }
    }
}

/**
 * 批量探测多个文件的预计大小（高并发池化，流式进度回调）
 */
async function probeBatchSizes(tasks, options = {}, onProgress = null) {
    if (!Array.isArray(tasks) || tasks.length === 0) {
        return { total: 0, completed: 0, totalBytes: 0, formattedTotal: '0 MB' };
    }

    abortBatchProbing();
    const controller = new AbortController();
    activeProbingController = controller;
    const signal = controller.signal;

    const concurrency = Math.max(1, Math.min(10, options.concurrency || 6));
    let currentIndex = 0;
    let completedCount = 0;
    let totalBytesSoFar = 0;

    const runWorker = async () => {
        while (currentIndex < tasks.length) {
            if (signal.aborted) break;
            const taskIndex = currentIndex++;
            const task = tasks[taskIndex];
            if (!task || !task.fileId) continue;

            // 如果已有有效大小，直接计入
            if (task.size && task.size > 0) {
                totalBytesSoFar += task.size;
                completedCount++;
                if (onProgress && !signal.aborted) {
                    onProgress({
                        taskId: task.id,
                        fileId: task.fileId,
                        size: task.size,
                        formatted: formatBytesForProbe(task.size),
                        completedCount,
                        totalCount: tasks.length,
                        totalBytesSoFar,
                        isComplete: completedCount >= tasks.length
                    });
                }
                continue;
            }

            try {
                const probeRes = await probeDriveFileSize(task.fileId, signal, task.resourceKey, task.originalUrl);
                if (signal.aborted) break;

                if (probeRes.size > 0) {
                    task.size = probeRes.size;
                    totalBytesSoFar += probeRes.size;
                }
                if (probeRes.serverFileName && driveInput.isMissingFileName(task.name, task.fileId)) {
                    task.name = probeRes.serverFileName;
                    task.nameReadError = '';
                }
                completedCount++;

                if (onProgress && !signal.aborted) {
                    onProgress({
                        taskId: task.id,
                        fileId: task.fileId,
                        size: task.size || 0,
                        formatted: probeRes.formatted,
                        serverFileName: probeRes.serverFileName,
                        completedCount,
                        totalCount: tasks.length,
                        totalBytesSoFar,
                        isComplete: completedCount >= tasks.length
                    });
                }
            } catch (err) {
                if (signal.aborted) break;
                completedCount++;
                if (onProgress) {
                    onProgress({
                        taskId: task.id,
                        fileId: task.fileId,
                        size: 0,
                        formatted: '未知',
                        completedCount,
                        totalCount: tasks.length,
                        totalBytesSoFar,
                        isComplete: completedCount >= tasks.length
                    });
                }
            }
        }
    };

    const workers = [];
    for (let i = 0; i < concurrency; i++) {
        workers.push(runWorker());
    }

    await Promise.all(workers);
    if (activeProbingController === controller) {
        activeProbingController = null;
    }

    return {
        total: tasks.length,
        completed: completedCount,
        totalBytes: totalBytesSoFar,
        formattedTotal: formatBytesForProbe(totalBytesSoFar)
    };
}

/**
 * 中止当前正在进行的大小探测
 */
function abortBatchProbing() {
    if (activeProbingController) {
        try { activeProbingController.abort(); } catch (_) { }
        activeProbingController = null;
        return true;
    }
    return false;
}

module.exports = {
    parseContentDispositionFilename,
    resolveDriveDownloadStreamUrl,
    extractGoogleDriveFileId,
    extractGoogleDriveFolderId,
    getDrivePreviewUrls,
    getDrivePageFileInfo,
    parseDriveInput,
    scanDriveFolder,
    startDownloadQueue,
    cancelDownload,
    cancelAllDownloads,
    resolveRenamedFilename,
    makeNumberedName,
    probeDriveFileSize,
    probeBatchSizes,
    abortBatchProbing,
};
