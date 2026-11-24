/**
 * Google Drive 批量与文件夹流式下载 - 渲染端核心控制器 (VideoKit)
 * 
 * 核心特性与用户体验提升：
 * 1. 原始图片比例预览：缩略图完全按原图比例自适应呈现（9:16 竖屏、16:9 横屏等绝不拉伸裁剪），悬停提示真实分辨率与比例。
 * 2. 原始名与最终名清晰对照：
 *    - 目标重命名输入框（留空则不改名）；
 *    - 清晰展示 📄 原始名：真实文件名；
 *    - 清晰展示 ✨ 最终名：实时计算并预览最终落盘文件名（自动安全保留真实扩展名）。
 * 3. 文件夹层级分组与折叠：按真实云端目录树自动多级分组，支持文件夹层级展开/折叠、批量文件夹勾选。
 * 4. 文件夹多维统计看板：每个文件夹头部清晰展示总文件数、图片数、视频数与已勾选数。
 * 5. 识别分析实时反馈：流式显示当前分析行号、递归扫描目录与已发现文件数；识别完成播放清脆提示音。
 * 6. 全局下载看板与进度条：显示总数、已完成、剩余、失败、总下载速度及动态渐变总体进度条；完成播放提示音。
 * 7. 真实原名与真实层级：默认 100% 保持 Google Drive 原始文件夹名称、子文件夹层级与文件原始扩展名。
 * 8. 缩略图直出与防盗链防护：采用 Google 嵌入直显 CDN 并附加 referrerpolicy="no-referrer"，杜绝 403 错误。
 * 9. 主题安全按钮控制：停止按钮采用醒目的鲜红背景加白字，杜绝白底白字看不清的问题。
 */

(function () {
    let gdriveTasks = [];
    let isDownloading = false;
    let lastBatchDownloadDir = '';
    let currentOutputDir = '';
    let isUserSelectedOutputDir = false;
    let downloadStartTime = 0;
    let lastParsedRawText = '';
    const collapsedFolders = new Set();

    // ==================== 1. Web Audio API 提示音合成 ====================
    function playAudioCue(type = 'recognize') {
        try {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            if (!AudioCtx) return;
            const ctx = new AudioCtx();

            if (type === 'recognize') {
                // 识别完成：清脆双音提示 (C5 -> G5)
                const now = ctx.currentTime;
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.type = 'sine';
                osc.frequency.setValueAtTime(523.25, now); // C5
                osc.frequency.exponentialRampToValueAtTime(783.99, now + 0.08); // G5
                gain.gain.setValueAtTime(0.15, now);
                gain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
                osc.connect(gain);
                gain.connect(ctx.destination);
                osc.start(now);
                osc.stop(now + 0.23);
            } else if (type === 'download_complete') {
                // 下载全部完成：四音节胜利 chord (C5 -> E5 -> G5 -> C6)
                const notes = [523.25, 659.25, 783.99, 1046.50];
                notes.forEach((freq, i) => {
                    const osc = ctx.createOscillator();
                    const gain = ctx.createGain();
                    const start = ctx.currentTime + (i * 0.09);
                    const dur = 0.25;
                    osc.type = 'triangle';
                    osc.frequency.setValueAtTime(freq, start);
                    gain.gain.setValueAtTime(0.2, start);
                    gain.gain.exponentialRampToValueAtTime(0.001, start + dur);
                    osc.connect(gain);
                    gain.connect(ctx.destination);
                    osc.start(start);
                    osc.stop(start + dur);
                });
            }
        } catch (_) { }
    }

    // ==================== 2. 格式化工具与最终文件名计算 ====================
    function formatBytes(bytes) {
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

    function getFolderDomId(folderPath) {
        let hash = 0;
        const str = String(folderPath || 'root');
        for (let i = 0; i < str.length; i++) {
            hash = ((hash << 5) - hash) + str.charCodeAt(i) | 0;
        }
        return 'f_' + Math.abs(hash);
    }

    function formatSpeed(bytesPerSec) {
        if (!bytesPerSec || bytesPerSec <= 0) return '0.0 KB/s';
        if (bytesPerSec < 1024 * 1024) {
            return (bytesPerSec / 1024).toFixed(1) + ' KB/s';
        }
        return (bytesPerSec / (1024 * 1024)).toFixed(2) + ' MB/s';
    }

    function escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function escapeJsAttr(str) {
        if (!str) return '';
        return escapeHtml(
            String(str)
                .replace(/\\/g, '\\\\')
                .replace(/'/g, "\\'")
                .replace(/\r/g, '\\r')
                .replace(/\n/g, '\\n')
        );
    }

    function classifyTaskItem(filename, itemType) {
        if (itemType === 'folder') return '文件夹';
        const ext = (String(filename || '').match(/\.[^.]+$/) || [''])[0].toLowerCase();
        const videoExts = ['.mp4', '.m4v', '.mov', '.avi', '.mkv', '.webm', '.mpeg', '.mpg', '.3gp', '.3g2', '.flv', '.wmv', '.ts'];
        const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.bmp', '.tif', '.tiff', '.svg', '.avif'];
        const audioExts = ['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.wma'];
        if (videoExts.includes(ext)) return '视频';
        if (imageExts.includes(ext)) return '图片';
        if (audioExts.includes(ext)) return '音频';
        return '文件';
    }

    /**
     * 计算任务最终保存时的文件名（安全保留真实后缀）
     */
    function getGDriveBatchRenameRule() {
        const includeNumber = document.getElementById('gdrive-batch-number-enabled')?.checked === true;
        const prefix = document.getElementById('gdrive-batch-prefix')?.value || '';
        const suffix = document.getElementById('gdrive-batch-suffix')?.value || '';
        const startValue = Number.parseInt(document.getElementById('gdrive-batch-number-start')?.value || '1', 10);
        const paddingValue = Number.parseInt(document.getElementById('gdrive-batch-number-padding')?.value || '0', 10);
        return {
            active: document.getElementById('gdrive-child-naming-enabled')?.checked === true
                && (includeNumber || !!prefix || !!suffix || !!document.getElementById('gdrive-batch-name-template')?.value?.trim()),
            prefix,
            suffix,
            separator: document.getElementById('gdrive-batch-separator')?.value ?? '-',
            includeNumber,
            number: Number.isFinite(startValue) ? Math.max(0, startValue) : 1,
            padding: Number.isFinite(paddingValue) ? Math.max(0, paddingValue) : 0,
            numberPosition: document.getElementById('gdrive-batch-number-position')?.value === 'after' ? 'after' : 'before',
            template: document.getElementById('gdrive-batch-name-template')?.value || '',
        };
    }

    function getGDriveBatchTaskIndex(task) {
        // 以清单勾选顺序固定编号：任务完成或失败后，其他项目的序号也不会跳变。
        return gdriveTasks.filter(item => item.selected).indexOf(task);
    }

    function getGDriveTotalFolderNaming() {
        const prefix = document.getElementById('gdrive-total-prefix')?.value || '';
        const suffix = document.getElementById('gdrive-total-suffix')?.value || '';
        return { prefix, suffix, separator: document.getElementById('gdrive-total-separator')?.value ?? '-', active: !!prefix || !!suffix };
    }

    function getGDriveBatchFolderOptions() {
        const total = getGDriveTotalFolderNaming();
        return {
            batchFolder: total.active || (!isUserSelectedOutputDir && document.getElementById('gdrive-batch-folder')?.checked === true),
            batchFolderPrefix: total.prefix, batchFolderSuffix: total.suffix, batchFolderSeparator: total.separator,
        };
    }

    function saveGDriveBatchRenameRule() {
        try {
            localStorage.setItem('videokit_gdrive_folder_naming_v2', JSON.stringify({
                total: getGDriveTotalFolderNaming(), child: getGDriveBatchRenameRule(),
                childEnabled: document.getElementById('gdrive-child-naming-enabled')?.checked === true,
            }));
        } catch (_) { }
    }

    function restoreGDriveBatchRenameRule() {
        try {
            const saved = JSON.parse(localStorage.getItem('videokit_gdrive_folder_naming_v2') || 'null');
            const legacy = saved ? null : JSON.parse(localStorage.getItem('videokit_gdrive_folder_naming_v1') || 'null');
            if (!saved && !legacy) return;
            const total = saved?.total || legacy || {};
            for (const key of ['prefix', 'suffix', 'separator']) {
                const el = document.getElementById(`gdrive-total-${key}`);
                if (el && total[key] !== undefined) el.value = String(total[key]);
            }
            const enabled = document.getElementById('gdrive-child-naming-enabled');
            if (enabled) enabled.checked = saved?.childEnabled === true;
            const rule = saved?.child;
            if (!rule) return; // 旧快捷后缀只迁移到总目录，不启用内部改名。
            const fields = { prefix: 'prefix', suffix: 'suffix', separator: 'separator',
                number: 'number-start', padding: 'number-padding', numberPosition: 'number-position', template: 'name-template' };
            for (const [key, field] of Object.entries(fields)) {
                const el = document.getElementById(`gdrive-batch-${field}`);
                if (el && rule[key] !== undefined) el.value = String(rule[key]);
            }
            const number = document.getElementById('gdrive-batch-number-enabled');
            if (number) number.checked = rule.includeNumber === true;
        } catch (_) { }
    }

    function missingGDriveFileName(task) {
        return window.GoogleDriveInput.isMissingFileName(task.name, task.fileId);
    }

    function computeFinalFilename(task) {
        const orig = missingGDriveFileName(task) ? '' : task.name;
        const custom = (task.rename || '').trim();
        if (window.GoogleDriveInput.isMissingFileName(custom, task.fileId)) {
            return orig;
        }

        // 分离用户输入的 base 和 ext
        const origExt = (orig.match(/\.[a-zA-Z0-9]{1,8}$/) || [''])[0].toLowerCase();
        const userMatch = custom.match(/^(.+?)(\.[a-zA-Z0-9]{1,8})?$/);
        const userBase = userMatch ? userMatch[1] : custom;
        const userExt = userMatch && userMatch[2] ? userMatch[2].toLowerCase() : '';

        // 优先保留原文件真实扩展名，若原文件没有扩展名则使用用户输入的扩展名
        const finalExt = origExt || userExt || '';
        return `${userBase}${finalExt}`;
    }

    // 同一下载根文件夹共用一个序号，子目录保持原样；不把规则应用到内部文件。
    function computeFinalFolderPath(task) {
        const original = String(task.folderPath || '').replace(/\\/g, '/');
        const rule = getGDriveBatchRenameRule();
        if (!original || !rule.active) return original;
        const [root, ...children] = original.split('/');
        const roots = [...new Set(gdriveTasks.filter(item => item.selected).map(item => String(item.folderPath || '').replace(/\\/g, '/').split('/')[0]).filter(Boolean))];
        if (!roots.includes(root)) roots.push(root);
        const name = buildGDriveBatchRename({ name: root }, { ...rule, number: rule.number + roots.indexOf(root) });
        // 文件夹名必须是单个路径段，防止自定义模板意外创建额外目录。
        const safeName = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').trim() || root;
        return [safeName, ...children].join('/');
    }

    function prepareGDriveDownloadTask(task) {
        return { ...task, name: missingGDriveFileName(task) ? '' : task.name,
            rename: task.rename?.trim() ? computeFinalFilename(task) : '', folderPath: computeFinalFolderPath(task) };
    }

    function refreshGDriveFileNameDisplay(task) {
        const row=document.getElementById(`gdrive-row-${task.id}`);if(!row)return;
        const original=row.querySelector('.gdrive-orig-name'),final=row.querySelector('.gdrive-final-name-text'),label=row.querySelector('.gdrive-final-label'),container=row.querySelector('.gdrive-final-name-container');
        const name=computeFinalFilename(task),missing=missingGDriveFileName(task);
        if(original){original.textContent=missing?'未读取到文件名':task.name;original.title=original.textContent;original.style.color=missing?'#f59e0b':'#94a3b8';}
        if(final)final.textContent=name?name+(!task.rename?'（保持原名）':''):'未读取到文件名，请重新识别或填写目标名';
        if(label)label.textContent=!name?'⚠ 保存名称未确定:':task.rename?'✨ 最终将保存为:':'✓ 最终将保存为:';
        if(container)container.style.color=!name?'#f59e0b':task.rename?'#38bdf8':'#10b981';
    }

    /** 根据批量规则生成下载根文件夹名，点号也是名称的一部分。 */
    function buildGDriveBatchRename(task, { prefix, suffix, separator = '-', includeNumber, number, padding, numberPosition = 'before', template = '' }) {
        const stem = String(task.name || '未命名文件夹');
        const sequence = includeNumber
            ? String(number).padStart(Math.max(0, padding), '0')
            : '';
        if (template.trim()) {
            const tokens = {
                '{prefix}': prefix,
                '{number}': sequence,
                '{name}': stem,
                '{suffix}': suffix,
                '{sep}': separator,
            };
            return template.replace(/\{prefix\}|\{number\}|\{name\}|\{suffix\}|\{sep\}/g, token => tokens[token]);
        }

        const nameParts = numberPosition === 'after'
            ? [prefix, stem, suffix, sequence]
            : [prefix, sequence, stem, suffix];
        // 连接符可清空；空片段不参与拼接，避免出现连续的 "--"。
        return nameParts.filter(part => part !== '').join(separator);
    }

    // ==================== 3. 识别分析与流式进度 ====================
    function updateParseProgressUI(payload) {
        const banner = document.getElementById('gdrive-parse-banner');
        const msgEl = document.getElementById('gdrive-parse-msg');
        const countEl = document.getElementById('gdrive-parse-count');
        const pendingBadge = document.getElementById('gdrive-parse-pending-badge');
        const progressContainer = document.getElementById('gdrive-parse-progress-container');
        const progressFill = document.getElementById('gdrive-parse-progress-fill');
        const spinner = document.getElementById('gdrive-parse-spinner');
        if (!banner) return;

        banner.style.display = 'flex';

        // 1. 待扫描目录徽标与进度条控制
        if (payload.pendingFolders !== undefined) {
            if (pendingBadge) {
                pendingBadge.style.display = 'inline-flex';
                if (payload.pendingFolders > 0) {
                    pendingBadge.textContent = `⏳ 待扫描: ${payload.pendingFolders} 个目录`;
                    pendingBadge.style.background = 'rgba(245, 158, 11, 0.2)';
                    pendingBadge.style.color = '#fbbf24';
                    pendingBadge.style.borderColor = 'rgba(245, 158, 11, 0.4)';
                } else {
                    pendingBadge.textContent = `✓ 目录全部扫描完成`;
                    pendingBadge.style.background = 'rgba(34, 197, 94, 0.2)';
                    pendingBadge.style.color = '#86efac';
                    pendingBadge.style.borderColor = 'rgba(34, 197, 94, 0.4)';
                }
            }

            if (progressContainer && progressFill) {
                if (payload.totalDiscoveredFolders > 1) {
                    progressContainer.style.display = 'block';
                    const pct = Math.max(2, Math.min(100, payload.percent || Math.round((payload.scannedFolders / payload.totalDiscoveredFolders) * 100)));
                    progressFill.style.width = `${pct}%`;
                }
            }
        }

        // 2. 状态文案呈现
        if (payload.stage === 'processing_line') {
            const lineInfo = payload.total > 1 ? `（第 ${payload.current}/${payload.total} 项）` : '';
            if (msgEl) msgEl.textContent = `正在分析链接${lineInfo}...`;
            if (countEl) countEl.textContent = `已发现 ${payload.foundCount || 0} 个文件`;
            if (spinner) spinner.style.display = 'inline-block';
        } else if (payload.stage === 'scanning_folder' || payload.stage === 'folder_parsed') {
            let linePrefix = '';
            if (payload.lineContext && payload.lineContext.lineTotal > 1) {
                linePrefix = `[链接 ${payload.lineContext.lineCurrent}/${payload.lineContext.lineTotal}] `;
            }

            if (msgEl) {
                if (payload.pendingFolders !== undefined) {
                    const actionWord = payload.stage === 'folder_parsed' ? '已扫描' : '正在扫描';
                    msgEl.textContent = `${linePrefix}${actionWord}: [${payload.folderTitle || ''}] · 目录进度: ${payload.scannedFolders}/${payload.totalDiscoveredFolders} (还有 ${payload.pendingFolders} 个待扫描)`;
                } else {
                    msgEl.textContent = linePrefix + (payload.message || `正在扫描: ${payload.folderTitle || ''}`);
                }
            }
            if (countEl) {
                countEl.textContent = `已发现 ${payload.totalFilesFound !== undefined ? payload.totalFilesFound : (payload.filesInFolder || 0)} 个文件`;
            }
            if (spinner) spinner.style.display = 'inline-block';
        } else if (payload.stage === 'finished') {
            if (msgEl) msgEl.textContent = payload.message || `识别完成，共发现 ${payload.totalFound || 0} 个文件`;
            if (countEl) countEl.textContent = `共 ${payload.totalFound || 0} 个文件`;
            if (pendingBadge) {
                pendingBadge.style.display = 'inline-flex';
                pendingBadge.textContent = `✓ 全部目录扫描完成`;
                pendingBadge.style.background = 'rgba(34, 197, 94, 0.2)';
                pendingBadge.style.color = '#86efac';
                pendingBadge.style.borderColor = 'rgba(34, 197, 94, 0.4)';
            }
            if (progressContainer && progressFill) {
                progressFill.style.width = '100%';
            }
            if (spinner) spinner.style.display = 'none';
        }
    }

    window.normalizeGDriveInputLinks = function () {
        const input = document.getElementById('gdrive-input-text');
        const entries = window.GoogleDriveInput.parseText(input?.value || '');
        if (!entries.length) return showToast('未读取到有效的 Google Drive 链接', 'warning');
        const unique = window.GoogleDriveInput.uniqueLinks(entries);
        input.value = window.GoogleDriveInput.toInputList(unique);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        showToast(`已整理为 ${unique.length} 个不重复链接，去除 ${entries.length - unique.length} 个重复项`, 'success');
    };

    window.parseGDriveInput = async function () {
        const rawText = document.getElementById('gdrive-input-text')?.value?.trim();
        if (!rawText) {
            showToast('请先输入或粘贴 Google Drive 链接或表格内容', 'warning');
            return;
        }

        const parseBtn = document.getElementById('btn-gdrive-parse');
        const banner = document.getElementById('gdrive-parse-banner');
        const msgEl = document.getElementById('gdrive-parse-msg');
        const countEl = document.getElementById('gdrive-parse-count');
        const spinner = document.getElementById('gdrive-parse-spinner');

        if (parseBtn) {
            parseBtn.disabled = true;
            parseBtn.textContent = '⏳ 正在识别...';
        }

        if (banner) {
            banner.style.display = 'flex';
            if (msgEl) msgEl.textContent = '正在连接 Google Drive 云端并检索目录...';
            if (countEl) countEl.textContent = '正在检索...';
            if (spinner) spinner.style.display = 'inline-block';
        }

        // 隐藏并重置上一次遗留的下载看板与完成通知，避免造成误导
        const dash = document.getElementById('gdrive-download-dashboard');
        if (dash) dash.style.display = 'none';
        const notice = document.getElementById('gdrive-dash-complete-notice');
        if (notice) notice.style.display = 'none';

        try {
            const expandFolders = document.getElementById('gdrive-expand-folders')?.checked !== false;
            const renameFolderOnly = document.getElementById('gdrive-rename-folder-only')?.checked !== false;
            const shouldProbeSizes = document.getElementById('gdrive-probe-sizes')?.checked === true;

            const existingFolderNames = Array.from(new Set(
                gdriveTasks
                    .map(t => t.folderPath ? t.folderPath.split('/')[0].trim() : '')
                    .filter(Boolean)
            ));

            console.log('[GDrive Frontend] Parsing text lines...', rawText);
            const res = await window.electronAPI.apiCall('gdrive/parse', {
                rawText,
                options: {
                    allowDuplicate: false,
                    expandFolders,
                    renameFolderOnly,
                    existingFolderNames,
                },
            });

            const taskList = Array.isArray(res) ? res : (res?.data || []);
            console.log('[GDrive Frontend] Received tasks count:', taskList.length, taskList);

            if (!taskList || taskList.length === 0) {
                if (banner) banner.style.display = 'none';
                if (res && res.error) {
                    showToast('识别失败: ' + res.error, 'error');
                } else {
                    showToast('未检测到有效的 Google Drive 链接或公开文件夹', 'warning');
                }
                updateDownloadButtonState();
                return false;
            }

            gdriveTasks = taskList.map(item => ({
                ...item,
                selected: true,
                status: item.status || 'ready',
                percent: item.percent || 0,
                speed: item.speed || 0,
                downloadedBytes: item.downloadedBytes || 0,
            }));

            // 默认清空折叠状态，保持初次展示友好展开
            collapsedFolders.clear();

            renderGDriveTable();
            updateDownloadButtonState();

            // 仅在用户勾选「预估文件大小」时启动后台探测（默认不勾选，避免大目录反复计算耗时）
            if (shouldProbeSizes && window.electronAPI && window.electronAPI.apiCall) {
                window.electronAPI.apiCall('gdrive/probe-batch-sizes', { tasks: gdriveTasks }).catch(err => {
                    console.warn('探测大小异常:', err);
                });
            }

            // 识别完成反馈与提示音
            if (banner) {
                const pendingBadge = document.getElementById('gdrive-parse-pending-badge');
                if (pendingBadge) {
                    pendingBadge.style.display = 'inline-flex';
                    pendingBadge.textContent = '✓ 全部目录扫描完成';
                    pendingBadge.style.background = 'rgba(34, 197, 94, 0.2)';
                    pendingBadge.style.color = '#86efac';
                    pendingBadge.style.borderColor = 'rgba(34, 197, 94, 0.4)';
                }
                const progressFill = document.getElementById('gdrive-parse-progress-fill');
                if (progressFill) progressFill.style.width = '100%';

                const probeHint = shouldProbeSizes ? '正在探测预计下载大小...' : '准备就绪，随时可开始下载。';
                if (msgEl) msgEl.textContent = `✅ 识别成功！共抓取到 ${gdriveTasks.length} 个文件，已按云端目录层级自动归类。${probeHint}`;
                if (countEl) countEl.textContent = `共 ${gdriveTasks.length} 个素材`;
                if (spinner) spinner.style.display = 'none';
            }
            lastParsedRawText = rawText;
            playAudioCue('recognize');
            showToast(`成功识别 ${gdriveTasks.length} 个任务！🎉`, 'success');
            return true;

        } catch (error) {
            if (banner) banner.style.display = 'none';
            showToast(`识别失败: ${error.message}`, 'error');
            updateDownloadButtonState();
            return false;
        } finally {
            if (parseBtn) {
                parseBtn.disabled = false;
                parseBtn.textContent = '🔍 开始识别';
            }
        }
    };

    window.clearGDriveInput = function () {
        const input = document.getElementById('gdrive-input-text');
        if (input) input.value = '';
        const banner = document.getElementById('gdrive-parse-banner');
        if (banner) banner.style.display = 'none';
        const pendingBadge = document.getElementById('gdrive-parse-pending-badge');
        if (pendingBadge) pendingBadge.style.display = 'none';
        const progressContainer = document.getElementById('gdrive-parse-progress-container');
        if (progressContainer) progressContainer.style.display = 'none';
    };

    window.toggleGDriveThumbnails = function () {
        renderGDriveTable();
    };

    // ==================== 4. 文件夹层级折叠展开与勾选控制 ====================
    window.toggleGDriveFolderCollapse = function (folderPath) {
        if (collapsedFolders.has(folderPath)) {
            collapsedFolders.delete(folderPath);
        } else {
            collapsedFolders.add(folderPath);
        }
        renderGDriveTable();
    };

    window.expandAllGDriveFolders = function () {
        collapsedFolders.clear();
        renderGDriveTable();
        showToast('已展开所有文件夹层级 📂', 'info');
    };

    window.collapseAllGDriveFolders = function () {
        const folderPaths = new Set(gdriveTasks.map(t => t.folderPath || ''));
        folderPaths.forEach(fp => collapsedFolders.add(fp));
        renderGDriveTable();
        showToast('已折叠所有文件夹层级 📁', 'info');
    };

    window.toggleGDriveFolderSelect = function (folderPath, checked) {
        gdriveTasks.forEach(task => {
            if ((task.folderPath || '') === folderPath) {
                task.selected = !!checked;
            }
        });
        renderGDriveTable();
        updateDownloadButtonState();
    };

    // ==================== 5. 渲染任务表格（真实比例预览 + 原名最终名对照） ====================
    function renderGDriveTable() {
        const tbody = document.getElementById('gdrive-table-body');
        const countSpan = document.getElementById('gdrive-list-count');
        const startBtn = document.getElementById('btn-gdrive-start-download');
        const showThumb = document.getElementById('gdrive-show-thumbnails')?.checked ?? false;

        const thumbThs = document.querySelectorAll('.gdrive-col-thumb');
        thumbThs.forEach(th => {
            th.style.display = showThumb ? 'table-cell' : 'none';
        });

        if (!tbody) return;

        if (gdriveTasks.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="${showThumb ? 7 : 6}" style="text-align: center; padding: 36px; color: var(--text-secondary); font-size: 13px;">
                        暂无识别任务，请在上方粘贴 Google Drive 链接并点击「开始识别」
                    </td>
                </tr>
            `;
            if (countSpan) countSpan.textContent = '0 项';
            if (startBtn) startBtn.disabled = true;
            return;
        }

        if (startBtn) startBtn.disabled = false;

        // 1. 按真实文件夹路径聚合分组
        const folderMap = new Map();
        gdriveTasks.forEach((task, idx) => {
            const fPath = task.folderPath || '';
            if (!folderMap.has(fPath)) {
                folderMap.set(fPath, []);
            }
            folderMap.get(fPath).push({ task, index: idx });
        });

        const selectedCount = gdriveTasks.filter(t => t.selected).length;
        const totalFolders = folderMap.size;
        const selectedBytes = gdriveTasks.filter(t => t.selected).reduce((acc, t) => acc + (t.size || 0), 0);
        let sizeHtml = '';
        if (selectedBytes > 0) {
            sizeHtml = ` · <span style="color: #38bdf8; font-weight: 600;">💾 预计下载: ${formatBytes(selectedBytes)}</span>`;
        }
        if (countSpan) {
            countSpan.innerHTML = `共 ${gdriveTasks.length} 项（已勾选 ${selectedCount} 项）· 包含 ${totalFolders} 个文件夹层级${sizeHtml}`;
        }

        let html = '';

        for (const [folderPath, items] of folderMap.entries()) {
            const total = items.length;
            const images = items.filter(it => classifyTaskItem(it.task.name || it.task.rename, it.task.type) === '图片').length;
            const videos = items.filter(it => classifyTaskItem(it.task.name || it.task.rename, it.task.type) === '视频').length;
            const others = total - images - videos;
            const folderSelectedCount = items.filter(it => it.task.selected).length;
            const isAllSelected = folderSelectedCount === total && total > 0;
            const isCollapsed = collapsedFolders.has(folderPath);

            let folderBytes = 0;
            items.forEach(it => { if (it.task.size > 0) folderBytes += it.task.size; });

            const finalFolderPath = computeFinalFolderPath(items[0].task);
            const displayFolderName = folderPath ? (finalFolderPath !== folderPath ? `${folderPath} → ${finalFolderPath}` : folderPath) : '根目录 (Root)';

            // 文件夹组头行（带折叠指示箭头、文件夹整体复选框、图片视频统计徽标）
            html += `
                <tr class="gdrive-folder-group-row">
                    <td colspan="${showThumb ? 7 : 6}">
                        <div class="gdrive-folder-header">
                            <div style="display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; cursor: pointer;" onclick="toggleGDriveFolderCollapse('${escapeJsAttr(folderPath)}')">
                                <span class="gdrive-folder-chevron" style="transform: ${isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)'};">▼</span>
                                <input type="checkbox" class="gdrive-folder-check" ${isAllSelected ? 'checked' : ''} onclick="event.stopPropagation(); toggleGDriveFolderSelect('${escapeJsAttr(folderPath)}', this.checked)" title="勾选/取消勾选该文件夹内所有文件">
                                <span class="gdrive-folder-title" title="${escapeHtml(displayFolderName)}">
                                    📁 ${escapeHtml(displayFolderName)}
                                </span>
                                <div style="display: flex; align-items: center; gap: 6px; margin-left: 8px; flex-wrap: wrap;">
                                    <span class="badge badge-info gdrive-folder-badge">共 ${total} 项</span>
                                    <span id="gdrive-folder-size-${getFolderDomId(folderPath)}" class="badge gdrive-folder-badge" style="background: rgba(14, 165, 233, 0.15); color: #38bdf8; border: 1px solid rgba(14, 165, 233, 0.3); ${folderBytes > 0 ? '' : 'display: none;'}">💾 约 ${formatBytes(folderBytes)}</span>
                                    ${images > 0 ? `<span class="badge gdrive-folder-badge" style="background: rgba(59, 130, 246, 0.15); color: #60a5fa; border: 1px solid rgba(59, 130, 246, 0.3);">🖼️ ${images} 图片</span>` : ''}
                                    ${videos > 0 ? `<span class="badge gdrive-folder-badge" style="background: rgba(168, 85, 247, 0.15); color: #c084fc; border: 1px solid rgba(168, 85, 247, 0.3);">🎬 ${videos} 视频</span>` : ''}
                                    ${others > 0 ? `<span class="badge gdrive-folder-badge" style="background: rgba(100, 116, 139, 0.15); color: #94a3b8; border: 1px solid rgba(100, 116, 139, 0.3);">📄 ${others} 其他</span>` : ''}
                                </div>
                            </div>
                            <div style="display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--text-secondary); flex-shrink: 0;">
                                <span>已勾选 ${folderSelectedCount}/${total} 项</span>
                                <button class="btn btn-secondary btn-small" style="padding: 2px 8px; font-size: 11px;" onclick="event.stopPropagation(); renameGDriveFolderGroup('${escapeJsAttr(folderPath)}')" title="重命名此文件夹（仅改动对应文件夹名，不修改内部子文件及下级目录名称）">
                                    ✏️ 重命名
                                </button>
                                <button class="btn btn-secondary btn-small" style="padding: 2px 8px; font-size: 11px;" onclick="event.stopPropagation(); toggleGDriveFolderCollapse('${escapeJsAttr(folderPath)}')">
                                    ${isCollapsed ? '📂 展开' : '📁 折叠'}
                                </button>
                            </div>
                        </div>
                    </td>
                </tr>
            `;

            // 子文件列表行
            for (const { task, index: idx } of items) {
                const previewUrl = task.previewUrl || '';
                const candidatesJson = JSON.stringify(task.previewCandidates || []).replace(/"/g, '&quot;');
                const checkedAttr = task.selected ? 'checked' : '';
                const computedFinalName = computeFinalFilename(task);
                const taskLink = task.originalUrl || `https://drive.google.com/file/d/${task.fileId}/view`;

                let statusBadge = missingGDriveFileName(task) ? '<span class="badge badge-warning">未读取到文件名</span>' : '<span class="badge badge-info">就绪</span>';
                if (task.status === 'downloading') {
                    statusBadge = `<span class="badge badge-warning">下载中 (${task.percent ? task.percent.toFixed(1) : 0}%)</span>`;
                } else if (task.status === 'completed') {
                    statusBadge = '<span class="badge badge-success">✓ 已完成</span>';
                } else if (task.status === 'skipped') {
                    statusBadge = '<span class="badge" style="background:rgba(245,158,11,.16);color:#fbbf24;border:1px solid rgba(245,158,11,.38);" title="本次目标路径已存在非空文件，未重复下载">⏭ 目标文件已存在，已跳过</span>';
                } else if (task.status === 'error') {
                    const errorText = task.error || '下载失败，但未收到详细错误信息';
                    statusBadge = `<div class="gdrive-error-status" title="${escapeHtml(errorText)}">
                        <span class="badge badge-error">失败</span>
                        <span class="gdrive-error-detail">${escapeHtml(errorText)}</span>
                    </div>`;
                }

                html += `
                    <tr id="gdrive-row-${escapeHtml(task.id)}" class="gdrive-row gdrive-row-grouped ${escapeHtml(task.status)}" data-folder="${escapeHtml(folderPath)}" style="${isCollapsed ? 'display: none;' : ''}">
                        <td style="width: 40px; text-align: center;">
                            <input type="checkbox" class="gdrive-item-check" data-index="${idx}" ${checkedAttr} onchange="toggleGDriveTaskCheck(${idx}, this.checked)">
                        </td>
                        <td class="gdrive-col-thumb" style="width: 80px; text-align: center; ${showThumb ? '' : 'display: none;'}">
                            ${showThumb ? `
                                <div class="gdrive-thumb-wrapper" onclick="previewGDriveLargeThumb('${escapeJsAttr(task.fileId)}')" title="点击放大查看 (原始比例)">
                                    <img class="gdrive-thumb-img" 
                                         referrerpolicy="no-referrer"
                                         src="${escapeHtml(previewUrl)}" 
                                         loading="lazy" 
                                         data-candidates="${candidatesJson}" 
                                         data-candidate-index="0" 
                                         onload="handleGDriveThumbLoad(this)"
                                         onerror="handleGDriveThumbError(this)">
                                    <div class="gdrive-thumb-fallback" style="display: none;">🎬</div>
                                </div>
                            ` : ''}
                        </td>
                        <td style="min-width: 280px;">
                            <div class="gdrive-name-cell" style="display: flex; flex-direction: column; gap: 4px; padding: 2px 0;">
                                <!-- 1. 目标重命名输入框（留空则不改名） -->
                                <div style="display: flex; align-items: center; gap: 6px;">
                                    <span style="font-size: 11px; color: var(--text-secondary); white-space: nowrap; flex-shrink: 0;" title="自定义重命名（留空则保持原名）">🎯 目标名:</span>
                                    <input type="text" class="input input-small gdrive-rename-input" 
                                           style="flex: 1; font-family: var(--font-mono, monospace); font-size: 12px; padding: 4px 8px;"
                                           value="${escapeHtml(task.rename || '')}" 
                                           oninput="updateGDriveTaskRename(${idx}, this.value)" 
                                           placeholder="留空则保持原始文件名（不改名）">
                                </div>

                                <!-- 2. 原始名与最终落盘名字对照 -->
                                <div style="display: flex; flex-direction: column; gap: 2px; font-size: 11px; padding-left: 2px;">
                                    <div style="display: flex; align-items: center; gap: 5px; color: var(--text-secondary);">
                                        <span style="opacity: 0.75; white-space: nowrap;">📄 原始名:</span>
                                        <span class="gdrive-orig-name" style="font-family: monospace; color: ${missingGDriveFileName(task) ? '#f59e0b' : '#94a3b8'}; word-break: break-all;" title="${missingGDriveFileName(task) ? '未读取到文件名，请重新识别或填写目标名' : `原始文件名: ${escapeHtml(task.name)}`}">
                                            ${escapeHtml(missingGDriveFileName(task) ? '未读取到文件名' : task.name)}
                                        </span>
                                    </div>

                                    <div class="gdrive-link-row" title="${escapeHtml(taskLink)}">
                                        <span class="gdrive-link-label">🔗 链接:</span>
                                        <span class="gdrive-link-text">${escapeHtml(taskLink)}</span>
                                        <button class="btn btn-secondary btn-small gdrive-copy-link-btn" onclick="copyGDriveTaskLink(${idx})" title="复制此文件对应的原始 Google Drive 链接">📋 复制链接</button>
                                    </div>

                                    <div class="gdrive-final-name-container" style="display: flex; align-items: center; gap: 5px; color: ${!computedFinalName ? '#f59e0b' : task.rename ? '#38bdf8' : '#10b981'};">
                                        <span class="gdrive-final-label" style="opacity: 0.9; font-weight: 600; white-space: nowrap;">
                                            ${!computedFinalName ? '⚠ 保存名称未确定:' : task.rename ? '✨ 最终将保存为:' : '✓ 最终将保存为:'}
                                        </span>
                                        <span class="gdrive-final-name-text" style="font-family: monospace; font-weight: 600; word-break: break-all;">
                                            ${escapeHtml(computedFinalName || '未读取到文件名，请重新识别或填写目标名')}${computedFinalName && !task.rename ? '（保持原名）' : ''}
                                        </span>
                                    </div>
                                </div>
                            </div>
                        </td>
                        <td style="width: 160px; color: var(--text-secondary); font-size: 12px;">
                            ${task.folderPath ? `<span class="gdrive-folder-tag" title="${escapeHtml(task.folderPath)}">📁 ${escapeHtml(task.folderPath)}</span>` : '<span style="opacity: 0.5;">根目录</span>'}
                        </td>
                        <td id="gdrive-size-${task.id}" style="width: 90px; text-align: center; font-size: 12px; color: var(--text-secondary); font-family: var(--font-mono, monospace);">
                            ${task.size > 0 
                                ? `<span class="badge" style="background: rgba(56, 189, 248, 0.15); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.3); font-size: 11px; padding: 2px 6px;">${formatBytes(task.size)}</span>`
                                : (document.getElementById('gdrive-probe-sizes')?.checked ? `<span style="color: var(--text-tertiary); font-size: 11px;">⏳ 探测中...</span>` : `<span style="color: var(--text-tertiary); font-size: 11px;">-</span>`)
                            }
                        </td>
                        <td style="width: 180px;">
                            <div class="gdrive-progress-cell">
                                <div class="gdrive-row-progress-bar">
                                    <div class="gdrive-row-progress-fill" style="width: ${task.percent || 0}%;"></div>
                                </div>
                                <div class="gdrive-progress-info">
                                    <span class="gdrive-status-badge">${statusBadge}</span>
                                    <span class="gdrive-speed-text" style="font-size: 11px; color: var(--text-secondary);">${task.speed ? formatSpeed(task.speed) : ''}</span>
                                </div>
                            </div>
                        </td>
                        <td style="width: 140px; text-align: right;">
                            <div class="gdrive-action-buttons">
                                ${task.status === 'completed' || task.status === 'skipped' ? `
                                    <button class="btn btn-secondary btn-small" onclick="revealGDriveFile('${escapeJsAttr(task.filePath || '')}')" title="在访达/资源管理器中查看">📁</button>
                                    <button class="btn btn-primary btn-small" onclick="sendGDriveFileToReels('${escapeJsAttr(task.filePath || '')}')" title="导入到批量 Reels">🎬</button>
                                    <button class="btn btn-secondary btn-small" onclick="sendGDriveFileToVisualReview('${escapeJsAttr(task.filePath || '')}')" title="导入到素材快速审核">🔍</button>
                                    <button class="btn btn-secondary btn-small" onclick="sendGDriveFileToBatchRename('${escapeJsAttr(task.filePath || '')}', '${escapeJsAttr(task.rename || '')}')" title="导入到批量重命名">🏷️</button>
                                ` : `
                                    <button class="btn btn-secondary btn-small" onclick="downloadSingleGDriveTask(${idx})" title="单独下载此项">⬇️</button>
                                    <button class="btn btn-secondary btn-small" onclick="deleteGDriveTask(${idx})" title="从清单中移除">✕</button>
                                `}
                            </div>
                        </td>
                    </tr>
                `;
            }
        }

        tbody.innerHTML = html;
    }

    // 缩略图加载与原始比例提示
    window.handleGDriveThumbLoad = function (imgEl) {
        if (!imgEl || !imgEl.naturalWidth || !imgEl.naturalHeight) return;
        const w = imgEl.naturalWidth;
        const h = imgEl.naturalHeight;
        let ratioLabel = '';
        const ratio = w / h;
        if (Math.abs(ratio - 9/16) < 0.05) ratioLabel = ' (9:16 竖屏)';
        else if (Math.abs(ratio - 16/9) < 0.05) ratioLabel = ' (16:9 横屏)';
        else if (Math.abs(ratio - 1) < 0.05) ratioLabel = ' (1:1 正方形)';
        else if (Math.abs(ratio - 4/3) < 0.05) ratioLabel = ' (4:3)';
        else if (Math.abs(ratio - 3/4) < 0.05) ratioLabel = ' (3:4)';
        else if (w > h) ratioLabel = ' (横屏)';
        else if (h > w) ratioLabel = ' (竖屏)';

        const wrapper = imgEl.closest('.gdrive-thumb-wrapper');
        if (wrapper) {
            wrapper.title = `点击放大查看 · 原始分辨率: ${w}×${h}${ratioLabel}`;
        }
    };

    // 缩略图容灾降级
    window.handleGDriveThumbError = function (imgEl) {
        try {
            const candidates = JSON.parse(imgEl.dataset.candidates || '[]');
            let nextIndex = parseInt(imgEl.dataset.candidateIndex || '0', 10) + 1;
            if (nextIndex < candidates.length) {
                imgEl.dataset.candidateIndex = nextIndex;
                imgEl.src = candidates[nextIndex];
            } else {
                imgEl.style.display = 'none';
                const fallback = imgEl.parentElement?.querySelector('.gdrive-thumb-fallback');
                if (fallback) fallback.style.display = 'flex';
            }
        } catch (_) { }
    };

    window.previewGDriveLargeThumb = function (fileId) {
        if (!fileId) return;
        const modal = document.createElement('div');
        modal.className = 'gdrive-modal-backdrop';
        modal.innerHTML = `
            <div class="gdrive-modal-content">
                <div class="gdrive-modal-header">
                    <span>高清封面预览（原始比例）</span>
                    <button class="gdrive-modal-close" onclick="this.closest('.gdrive-modal-backdrop').remove()">✕</button>
                </div>
                <div class="gdrive-modal-body" style="text-align: center; padding: 20px;">
                    <img referrerpolicy="no-referrer" src="https://drive.google.com/thumbnail?id=${fileId}&sz=w1600" style="max-width: 90vw; max-height: 80vh; object-fit: contain; border-radius: 8px;">
                </div>
            </div>
        `;
        document.body.appendChild(modal);
    };

    // 表格单行交互与重命名实时反馈
    window.toggleGDriveTaskCheck = function (index, checked) {
        if (gdriveTasks[index]) {
            gdriveTasks[index].selected = !!checked;
        }
        renderGDriveTable();
        updateDownloadButtonState();
    };

    window.toggleSelectAllGDrive = function (checked) {
        gdriveTasks.forEach(t => t.selected = !!checked);
        renderGDriveTable();
        updateDownloadButtonState();
    };

    window.updateGDriveTaskRename = function (index, value) {
        if (!gdriveTasks[index]) return;
        gdriveTasks[index].rename = value.trim();

        // 实时更新当前行最终名称预览，避免重刷整表打断用户输入焦点
        const row = document.getElementById(`gdrive-row-${gdriveTasks[index].id}`);
        if (row) {
            const finalSpan = row.querySelector('.gdrive-final-name-text');
            const finalContainer = row.querySelector('.gdrive-final-name-container');
            const finalName = computeFinalFilename(gdriveTasks[index]);

            if (finalSpan) {
                finalSpan.textContent = finalName ? finalName + (!gdriveTasks[index].rename ? '（保持原名）' : '') : '未读取到文件名，请重新识别或填写目标名';
            }
            if (finalContainer) {
                const label = finalContainer.querySelector('.gdrive-final-label');
                if (!finalName) {
                    if (label) label.textContent = '⚠ 保存名称未确定:';
                    finalContainer.style.color = '#f59e0b';
                } else if (gdriveTasks[index].rename) {
                    if (label) label.textContent = '✨ 最终将保存为:';
                    finalContainer.style.color = '#38bdf8';
                } else {
                    if (label) label.textContent = '✓ 最终将保存为:';
                    finalContainer.style.color = '#10b981';
                }
            }
        }
    };

    // 批量规则在输入时即生效；重绘列表只更新预览，不会覆盖用户填写的单项目标名。
    window.setGDriveBatchSuffix = function (suffix) {
        const input = document.getElementById('gdrive-total-suffix');
        if (!input) return;
        input.value = suffix;
        window.refreshGDriveBatchRenamePreview();
        showToast(`总文件夹后缀已设为「${suffix}」`, 'success');
    };

    window.refreshGDriveBatchRenamePreview = function () {
        saveGDriveBatchRenameRule();
        if (getGDriveTotalFolderNaming().active) {
            const batch = document.getElementById('gdrive-batch-folder');
            if (batch) batch.checked = true;
        }
        if (getGDriveBatchRenameRule().active) {
            const hierarchy = document.getElementById('gdrive-preserve-hierarchy');
            if (hierarchy) hierarchy.checked = true;
        }
        renderGDriveTable();
    };

    window.deleteGDriveTask = function (index) {
        gdriveTasks.splice(index, 1);
        renderGDriveTable();
        updateDownloadButtonState();
    };


    window.clearGDriveTasks = function () {
        if (window.electronAPI && window.electronAPI.apiCall) {
            window.electronAPI.apiCall('gdrive/abort-probe-sizes').catch(() => {});
        }
        gdriveTasks = [];
        collapsedFolders.clear();
        renderGDriveTable();
        updateDownloadButtonState();
        const dash = document.getElementById('gdrive-download-dashboard');
        if (dash) dash.style.display = 'none';
        const banner = document.getElementById('gdrive-parse-banner');
        if (banner) banner.style.display = 'none';
    };

    // ==================== 6. 复制导出 ====================
    window.copyGDriveManifest = function () {
        if (!gdriveTasks.length) {
            showToast('清单为空', 'warning');
            return;
        }
        const lines = gdriveTasks.map(t => {
            const finalName = computeFinalFilename(t);
            const type = classifyTaskItem(finalName, t.type);
            const url = t.originalUrl || `https://drive.google.com/file/d/${t.fileId}/view`;
            return `${finalName}\t${type}\t${url}`;
        });
        copyToClipboard(lines.join('\n'), `已复制 ${lines.length} 行数据（最终名称、类型、链接三列）📋`);
    };

    window.copyGDriveLinks = function () {
        if (!gdriveTasks.length) return showToast('清单为空', 'warning');
        const lines = gdriveTasks.map(t => t.originalUrl || `https://drive.google.com/file/d/${t.fileId}/view`);
        copyToClipboard(lines.join('\n'), `已复制 ${lines.length} 个链接🔗`);
    };

    window.copyGDriveFailedLinks = function () {
        const failedTasks = gdriveTasks.filter(task => task.status === 'error');
        if (!failedTasks.length) return showToast('当前没有失败任务可复制', 'info');
        const lines = failedTasks.map(task => task.originalUrl || `https://drive.google.com/file/d/${task.fileId}/view`);
        copyToClipboard(lines.join('\n'), `已复制 ${lines.length} 个失败链接，可直接排查或重新粘贴下载`);
    };

    window.copyGDriveTaskLink = function (idx) {
        const task = gdriveTasks[idx];
        if (!task) return showToast('找不到对应下载任务', 'error');
        const url = task.originalUrl || `https://drive.google.com/file/d/${task.fileId}/view`;
        copyToClipboard(url, `已复制问题链接：${task.name || '未命名文件'}`);
    };

    window.copyGDriveNames = function () {
        if (!gdriveTasks.length) return showToast('清单为空', 'warning');
        const lines = gdriveTasks.map(t => computeFinalFilename(t));
        copyToClipboard(lines.join('\n'), `已复制 ${lines.length} 个最终文件名🏷️`);
    };

    window.copyGDriveFormulas = function () {
        if (!gdriveTasks.length) return showToast('清单为空', 'warning');
        const lines = gdriveTasks.map(t => t.formula || `=IMAGE("https://drive.google.com/thumbnail?id=${t.fileId}&sz=w1600")`);
        copyToClipboard(lines.join('\n'), `已复制 ${lines.length} 个表格图片公式📊`);
    };

    window.showGDriveSkippedItems = function () {
        const skipped = gdriveTasks.filter(task => task.status === 'skipped');
        if (!skipped.length) return showToast('本次还没有因已下载而跳过的文件', 'info');
        const lines = skipped.map(task => `${computeFinalFilename(task)}\n${task.filePath || ''}`).join('\n\n');
        const popup = window.open('', '_blank', 'width=760,height=560');
        if (popup) {
            popup.document.title = `已跳过 ${skipped.length} 个文件`;
            popup.document.body.innerHTML = `<pre style="white-space:pre-wrap;word-break:break-all;font:13px/1.55 ui-monospace,Menlo,monospace;padding:16px;">已下载并跳过：${skipped.length} 个\n\n${escapeHtml(lines)}</pre>`;
        } else {
            copyToClipboard(lines, `已复制 ${skipped.length} 个已跳过文件的名称与路径`);
        }
    };

    function copyToClipboard(text, successMsg) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(() => showToast(successMsg, 'success'));
        } else {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
            showToast(successMsg, 'success');
        }
    }

    // ==================== 7. 保存目录与主题按钮控制 ====================
    window.browseGDriveDownloadDir = async function () {
        try {
            if (window.electronAPI && window.electronAPI.selectDirectory) {
                const dir = await window.electronAPI.selectDirectory();
                if (dir) {
                    currentOutputDir = dir;
                    isUserSelectedOutputDir = true;
                    markGDriveSelectedDirectory();
                    updateDirDisplay();
                }
            } else if (window.bridge && window.bridge.selectDirectory) {
                const dir = await window.bridge.selectDirectory();
                if (dir) {
                    currentOutputDir = dir;
                    isUserSelectedOutputDir = true;
                    markGDriveSelectedDirectory();
                    updateDirDisplay();
                }
            }
        } catch (_) { }
    };

    function updateDirDisplay() {
        const input = document.getElementById('gdrive-download-dir');
        if (input && currentOutputDir) {
            input.value = currentOutputDir;
        }
    }

    function markGDriveSelectedDirectory() {
        const batchCheckbox = document.getElementById('gdrive-batch-folder');
        if (batchCheckbox) batchCheckbox.checked = false;
        showToast('已选定已有目录：本次将直接写入该目录，不创建新的批次文件夹', 'info', 5000);
    }

    function initDefaultDownloadDir() {
        isUserSelectedOutputDir = false;
        if (typeof window.electronAPI?.getDownloadsPath === 'function') {
            window.electronAPI.getDownloadsPath().then((dir) => {
                if (!isUserSelectedOutputDir && dir && typeof dir === 'string') {
                    currentOutputDir = dir;
                    updateDirDisplay();
                }
            }).catch(() => { });
        }
        updateDirDisplay();
    }

    // 更新下载控制按钮状态（鲜红主题防护，杜绝白底白字看不见）
    function updateDownloadButtonState() {
        const startBtn = document.getElementById('btn-gdrive-start-download');
        if (!startBtn) return;

        const hasSelected = gdriveTasks.some(t => t.selected);
        const inputText = document.getElementById('gdrive-input-text')?.value?.trim();
        const hasInput = !!inputText;

        if (isDownloading) {
            startBtn.disabled = false;
            startBtn.textContent = '⏹ 停止批量下载';
            startBtn.className = 'btn btn-danger';
            startBtn.style.backgroundColor = '#e53e3e';
            startBtn.style.color = '#ffffff';
            startBtn.style.borderColor = '#c53030';
            startBtn.style.boxShadow = '0 4px 12px rgba(229, 62, 62, 0.4)';
        } else {
            // 只要清单中有选中的项，或者输入框中有尚未解析的链接内容，按钮始终可用！
            startBtn.disabled = !hasSelected && !hasInput;
            startBtn.textContent = '⬇️ 开始批量下载';
            startBtn.className = 'btn btn-primary';
            startBtn.style.backgroundColor = '';
            startBtn.style.color = '';
            startBtn.style.borderColor = '';
            startBtn.style.boxShadow = '';
        }
    }
    window.updateDownloadButtonState = updateDownloadButtonState;

    // 手动重命名文件夹分组（仅修改对应顶层文件夹名称，不影响子文件及子目录原名）
    window.renameGDriveFolderGroup = function (oldFolderPath) {
        const currentName = oldFolderPath || '';
        const newName = prompt('请输入该文件夹的新名称（仅重命名文件夹，不修改子文件及下级目录名称）：', currentName);
        if (newName === null) return;
        let trimmed = newName.trim();
        if (!trimmed || trimmed === currentName) return;

        // 🌟 检查是否有其他同名文件夹，杜绝合并！
        const otherFolderPaths = new Set(
            gdriveTasks
                .map(t => t.folderPath ? t.folderPath.split('/')[0].trim() : '')
                .filter(fp => fp && fp !== oldFolderPath)
        );

        if (otherFolderPaths.has(trimmed)) {
            let counter = 2;
            while (otherFolderPaths.has(`${trimmed} (${counter})`)) {
                counter++;
            }
            const uniqueName = `${trimmed} (${counter})`;
            showToast(`检测到同名文件夹，已自动重命名为【${uniqueName}】避免合并`, 'info');
            trimmed = uniqueName;
        }

        gdriveTasks.forEach(task => {
            if (task.folderPath === oldFolderPath) {
                task.folderPath = trimmed;
            } else if (task.folderPath && task.folderPath.startsWith(oldFolderPath + '/')) {
                task.folderPath = trimmed + task.folderPath.slice(oldFolderPath.length);
            }
        });
        renderGDriveTable();
        showToast(`已将文件夹重命名为: ${trimmed}`, 'success');
    };

    // ==================== 8. 全局下载进度看板更新 ====================
    function updateGlobalDashboard(activeTasks) {
        const dash = document.getElementById('gdrive-download-dashboard');
        if (!dash) return;

        const totalEl = document.getElementById('gdrive-dash-total');
        const doneEl = document.getElementById('gdrive-dash-completed');
        const remainEl = document.getElementById('gdrive-dash-remaining');
        const failedEl = document.getElementById('gdrive-dash-failed');
        const speedEl = document.getElementById('gdrive-dash-speed');
        const percentEl = document.getElementById('gdrive-dash-percent');
        const barFill = document.getElementById('gdrive-dash-bar');
        const statusEl = document.getElementById('gdrive-dash-status');

        const total = activeTasks.length;
        const completed = activeTasks.filter(t => t.status === 'completed').length;
        const skipped = activeTasks.filter(t => t.status === 'skipped').length;
        const failed = activeTasks.filter(t => t.status === 'error').length;
        const remaining = Math.max(0, total - completed - skipped - failed);

        // 计算当前并发总速度
        let totalSpeed = 0;
        let partialPercents = 0;
        for (const t of activeTasks) {
            if (t.status === 'downloading') {
                totalSpeed += (t.speed || 0);
                partialPercents += ((t.percent || 0) / 100);
            }
        }

        const overallPercent = total > 0 ? Math.min(100, (((completed + skipped + partialPercents) / total) * 100)).toFixed(1) : 0;

        if (totalEl) totalEl.textContent = total;
        if (doneEl) doneEl.textContent = completed;
        if (remainEl) remainEl.textContent = remaining;
        if (failedEl) failedEl.textContent = failed;
        if (speedEl) speedEl.textContent = formatSpeed(totalSpeed);
        if (percentEl) percentEl.textContent = `${overallPercent}%`;
        if (barFill) barFill.style.width = `${overallPercent}%`;

        if (statusEl) {
            if (isDownloading) {
                statusEl.textContent = `⬇️ 正在高速批量下载... [已下载 ${completed}/${total}${skipped ? `，跳过 ${skipped}` : ''}]`;
            } else if (completed + skipped === total && total > 0) {
                statusEl.textContent = `✅ 批量处理完成！${skipped ? `其中 ${skipped} 个已下载而跳过。` : ''}`;
            }
        }
    }

    // ==================== 9. 开始与停止批量下载 ====================
    window.startGDriveDownload = async function () {
        if (isDownloading) {
            try {
                await window.electronAPI.apiCall('gdrive/cancel-all');
                isDownloading = false;
                updateDownloadButtonState();
                const statusEl = document.getElementById('gdrive-dash-status');
                if (statusEl) statusEl.textContent = '⏹ 已停止批量下载任务';
                showToast('已停止所有下载任务', 'info');
            } catch (err) {
                showToast('取消失败: ' + err.message, 'error');
            }
            return;
        }

        // 🌟 贴了链接直接点开始下载就下载：
        // 若任务列表为空，或输入框有全新未解析内容，或当前所有任务均已完成且输入框有新内容：
        const rawText = document.getElementById('gdrive-input-text')?.value?.trim() || '';
        const isInputNew = rawText && rawText !== lastParsedRawText;
        const hasUnfinishedTasks = gdriveTasks.some(t => t.selected && t.status !== 'completed');

        if (gdriveTasks.length === 0 || isInputNew || (!hasUnfinishedTasks && rawText)) {
            if (rawText) {
                const startBtn = document.getElementById('btn-gdrive-start-download');
                if (startBtn) {
                    startBtn.disabled = true;
                    startBtn.textContent = '⏳ 正在极速识别并准备下载...';
                }
                const ok = await window.parseGDriveInput();
                if (!ok || !gdriveTasks.length) {
                    updateDownloadButtonState();
                    return;
                }
            } else if (gdriveTasks.length === 0) {
                showToast('请先输入或粘贴 Google Drive 链接', 'warning');
                return;
            }
        }

        const selectedTasks = gdriveTasks.filter(t => t.selected && t.status !== 'completed');
        if (!selectedTasks.length) {
            showToast('没有待下载的勾选任务（请粘贴有效链接或勾选任务）', 'warning');
            return;
        }

        const outputDir = document.getElementById('gdrive-download-dir')?.value?.trim() || currentOutputDir;
        if (!outputDir) {
            showToast('请选择或指定保存目录', 'warning');
            return;
        }

        const concurrency = parseInt(document.getElementById('gdrive-threads')?.value || '3', 10);
        const preserveHierarchy = getGDriveTotalFolderNaming().active || getGDriveBatchRenameRule().active || document.getElementById('gdrive-preserve-hierarchy')?.checked !== false;
        // 总目录命名启用时在所选保存目录内创建总目录，否则沿用目录选择行为。
        const batchFolderOptions = getGDriveBatchFolderOptions();
        const skipExisting = document.getElementById('gdrive-skip-existing')?.checked !== false;
        // 将即时预览出来的最终名称随本次请求发送给下载端，保证无需“应用”步骤。
        const downloadTasks = selectedTasks.map(prepareGDriveDownloadTask);

        isDownloading = true;
        downloadStartTime = Date.now();
        updateDownloadButtonState();

        // 显示并初始化全局下载看板
        const dash = document.getElementById('gdrive-download-dashboard');
        if (dash) dash.style.display = 'block';
        const notice = document.getElementById('gdrive-dash-complete-notice');
        if (notice) notice.style.display = 'none';

        updateGlobalDashboard(selectedTasks);
        showToast(`开始流式下载 ${selectedTasks.length} 个文件...`, 'info');

        try {
            const res = await window.electronAPI.apiCall('gdrive/start-download', {
                tasks: downloadTasks,
                outputDir,
                options: {
                    concurrency,
                    preserveHierarchy,
                    ...batchFolderOptions,
                    overwrite: false,
                    skipExisting,
                },
            });

            const downloadResult = res?.data || res || {};
            if (downloadResult.outputDir) {
                lastBatchDownloadDir = downloadResult.outputDir;
            }
            const reusedRootMessage = downloadResult.reusedExistingTargetRoot
                ? '已识别所选目录为已有下载层级，已直接复用，未创建重复目录。'
                : '';

            // IPC 事件理论上会逐条到达；仍以最终返回值兜底，确保失败原因不会丢失。
            for (const failure of (downloadResult.failures || [])) {
                const failedTask = gdriveTasks.find(task => task.id === failure.taskId);
                if (failedTask) {
                    failedTask.status = 'error';
                    failedTask.error = failure.error || '下载失败，但未收到详细错误信息';
                }
            }

            isDownloading = false;
            updateDownloadButtonState();

            // 更新完成状态
            const totalEl = document.getElementById('gdrive-dash-total');
            const doneEl = document.getElementById('gdrive-dash-completed');
            const remainEl = document.getElementById('gdrive-dash-remaining');
            const percentEl = document.getElementById('gdrive-dash-percent');
            const barFill = document.getElementById('gdrive-dash-bar');
            const statusEl = document.getElementById('gdrive-dash-status');

            if (totalEl) totalEl.textContent = selectedTasks.length;
            const skipped = selectedTasks.filter(task => task.status === 'skipped').length;
            const completed = selectedTasks.filter(task => task.status === 'completed').length;
            const failed = selectedTasks.filter(task => task.status === 'error').length;
            if (doneEl) doneEl.textContent = completed;
            if (remainEl) remainEl.textContent = 0;
            if (percentEl) percentEl.textContent = '100%';
            if (barFill) barFill.style.width = '100%';
            if (statusEl) statusEl.textContent = failed
                ? `⚠️ 批量处理结束：成功 ${completed} 个，跳过 ${skipped} 个，失败 ${failed} 个（失败原因已显示在对应行）。`
                : `✅ 批量处理完成！下载 ${completed} 个，已下载跳过 ${skipped} 个。`;

            // “全部完成”横幅不应在有失败项时出现。
            if (notice) notice.style.display = failed ? 'none' : 'flex';

            // 播放下载完成提示音
            if (failed) {
                renderGDriveTable();
                showToast(`下载结束：成功 ${completed} 个，跳过 ${skipped} 个，失败 ${failed} 个。${reusedRootMessage}请查看每一行“失败”后的原因。`, 'warning', 8000);
            } else {
                playAudioCue('download_complete');
                showToast(`🎉 已下载 ${completed} 个，跳过 ${skipped} 个已存在文件。${reusedRootMessage}`, 'success');
            }

        } catch (err) {
            isDownloading = false;
            updateDownloadButtonState();
            showToast('下载遇到错误: ' + err.message, 'error');
        }
    };

    // 单项单独下载
    window.downloadSingleGDriveTask = async function (idx) {
        const task = gdriveTasks[idx];
        if (!task) return;

        const outputDir = document.getElementById('gdrive-download-dir')?.value?.trim() || currentOutputDir;
        if (!outputDir) return showToast('请指定保存目录', 'warning');

        const preserveHierarchy = getGDriveTotalFolderNaming().active || getGDriveBatchRenameRule().active || document.getElementById('gdrive-preserve-hierarchy')?.checked !== false;
        const batchFolderOptions = getGDriveBatchFolderOptions();
        const skipExisting = document.getElementById('gdrive-skip-existing')?.checked !== false;
        const downloadTask = prepareGDriveDownloadTask(task);

        showToast(`正在单独下载: ${task.rename || task.name}`, 'info');

        try {
            const res = await window.electronAPI.apiCall('gdrive/start-download', {
                tasks: [downloadTask],
                outputDir,
                options: {
                    concurrency: 1,
                    preserveHierarchy,
                    ...batchFolderOptions,
                    overwrite: false,
                    skipExisting,
                },
            });
            const downloadResult = res?.data || res || {};
            if (downloadResult.outputDir) {
                lastBatchDownloadDir = downloadResult.outputDir;
            }
            const failure = (downloadResult.failures || []).find(item => item.taskId === task.id);
            if (failure) {
                task.status = 'error';
                task.error = failure.error || '下载失败，但未收到详细错误信息';
                renderGDriveTable();
                showToast(`下载失败：${task.error}`, 'error', 8000);
            } else {
                showToast(`下载完成: ${computeFinalFilename(task)} ✓`, 'success');
                playAudioCue('recognize');
            }
        } catch (err) {
            showToast(`下载失败: ${err.message}`, 'error');
        }
    };

    // ==================== 10. 下载进度流式事件监听 ====================
    function handleDownloadProgressEvent(payload) {
        if (!payload || !payload.taskId) return;

        const task = gdriveTasks.find(t => t.id === payload.taskId);
        if (task) {
            task.percent = payload.percent || 0;
            task.speed = payload.speed || 0;
            task.status = payload.status || task.status;
            task.downloadedBytes = payload.downloadedBytes || task.downloadedBytes;
            if (payload.totalBytes && payload.totalBytes > 0) {
                task.size = payload.totalBytes;
            }
            if (payload.filePath) {
                task.filePath = payload.filePath;
                if (!lastBatchDownloadDir) {
                    const baseDir = document.getElementById('gdrive-download-dir')?.value?.trim() || currentOutputDir;
                    if (baseDir && payload.filePath.startsWith(baseDir)) {
                        const rel = payload.filePath.slice(baseDir.length).replace(/^[\/\\]/, '');
                        const firstSeg = rel.split(/[\/\\]/)[0];
                        if (firstSeg && firstSeg.startsWith('批量下载批次-')) {
                            lastBatchDownloadDir = `${baseDir}/${firstSeg}`;
                        }
                    }
                }
            }
            const originalName=payload.originalFileName || (!task.rename?payload.fileName:'');
            if (originalName && !window.GoogleDriveInput.isMissingFileName(originalName,task.fileId) && missingGDriveFileName(task)) {
                task.name = originalName;
                task.nameReadError = '';
                refreshGDriveFileNameDisplay(task);
            }
            if (payload.error) {
                task.error = payload.error;
            }
        }

        // 更新单行表格进度条
        const row = document.getElementById(`gdrive-row-${payload.taskId}`);
        if (row && task) {
            if (payload.totalBytes && payload.totalBytes > 0) {
                task.size = payload.totalBytes;
                const sizeCell = document.getElementById(`gdrive-size-${task.id}`);
                if (sizeCell) {
                    sizeCell.innerHTML = `<span class="badge" style="background: rgba(56, 189, 248, 0.15); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.3); font-family: monospace; font-size: 11px; padding: 2px 6px;">${formatBytes(task.size)}</span>`;
                }
            }

            const fill = row.querySelector('.gdrive-row-progress-fill');
            if (fill) fill.style.width = `${task.percent || 0}%`;

            const speedEl = row.querySelector('.gdrive-speed-text');
            if (speedEl) speedEl.textContent = task.speed ? formatSpeed(task.speed) : '';

            const badge = row.querySelector('.gdrive-status-badge');
            if (badge) {
                if (task.status === 'downloading') {
                    badge.innerHTML = `<span class="badge badge-warning">下载中 (${task.percent ? task.percent.toFixed(1) : 0}%)</span>`;
                } else if (task.status === 'completed') {
                    badge.innerHTML = `<span class="badge badge-success">✓ 已完成</span>`;
                    const actCell = row.querySelector('.gdrive-action-buttons');
                    if (actCell) {
                        actCell.innerHTML = `
                            <button class="btn btn-secondary btn-small" onclick="revealGDriveFile('${escapeJsAttr(task.filePath || '')}')" title="在访达/资源管理器中查看">📁</button>
                            <button class="btn btn-primary btn-small" onclick="sendGDriveFileToReels('${escapeJsAttr(task.filePath || '')}')" title="导入到批量 Reels">🎬</button>
                            <button class="btn btn-secondary btn-small" onclick="sendGDriveFileToVisualReview('${escapeJsAttr(task.filePath || '')}')" title="导入到素材快速审核">🔍</button>
                            <button class="btn btn-secondary btn-small" onclick="sendGDriveFileToBatchRename('${escapeJsAttr(task.filePath || '')}', '${escapeJsAttr(task.rename || '')}')" title="导入到批量重命名">🏷️</button>
                        `;
                    }
                } else if (task.status === 'skipped') {
                    badge.innerHTML = '<span class="badge" style="background:rgba(245,158,11,.16);color:#fbbf24;border:1px solid rgba(245,158,11,.38);" title="本次目标路径已存在非空文件，未重复下载">⏭ 目标文件已存在，已跳过</span>';
                    const actCell = row.querySelector('.gdrive-action-buttons');
                    if (actCell) actCell.innerHTML = `<button class="btn btn-secondary btn-small" onclick="revealGDriveFile('${escapeJsAttr(task.filePath || '')}')" title="查看已存在的文件">📁</button>`;
                } else if (task.status === 'error') {
                    const errorText = task.error || '下载失败，但未收到详细错误信息';
                    badge.innerHTML = `<div class="gdrive-error-status" title="${escapeHtml(errorText)}">
                        <span class="badge badge-error">失败</span>
                        <span class="gdrive-error-detail">${escapeHtml(errorText)}</span>
                    </div>`;
                }
            }
        }

        // 更新全局下载看板
        const selectedTasks = gdriveTasks.filter(t => t.selected);
        updateGlobalDashboard(selectedTasks);
    }

    // ==================== 10-b. 预计文件大小探测事件监听 ====================
    function handleSizeProgressEvent(payload) {
        if (!payload || !payload.taskId) return;

        const task = gdriveTasks.find(t => t.id === payload.taskId);
        if (task) {
            task.size = payload.size || 0;
            if (payload.serverFileName && missingGDriveFileName(task)) {
                task.name = payload.serverFileName;
                task.nameReadError = '';
                refreshGDriveFileNameDisplay(task);
            }
        }

        // 更新单元格大小
        const sizeCell = document.getElementById(`gdrive-size-${payload.taskId}`);
        if (sizeCell) {
            if (payload.size > 0) {
                const formatted = payload.formatted || formatBytes(payload.size);
                sizeCell.innerHTML = `<span class="badge" style="background: rgba(56, 189, 248, 0.15); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.3); font-family: monospace; font-size: 11px; padding: 2px 6px;">${formatted}</span>`;
            } else {
                sizeCell.innerHTML = `<span style="color: var(--text-tertiary); font-size: 11px;">-</span>`;
            }
        }

        // 更新所在文件夹组头大小
        if (task && task.folderPath) {
            updateFolderHeaderSize(task.folderPath);
        }

        // 更新顶部汇总
        updateSummaryCountAndSize(payload.completedCount, payload.totalCount);
    }

    function updateFolderHeaderSize(folderPath) {
        const folderItems = gdriveTasks.filter(t => (t.folderPath || '') === folderPath);
        let fBytes = 0;
        let knownCount = 0;
        folderItems.forEach(it => {
            if (it.size > 0) {
                fBytes += it.size;
                knownCount++;
            }
        });
        const folderSizeEl = document.getElementById(`gdrive-folder-size-${getFolderDomId(folderPath)}`);
        if (folderSizeEl) {
            if (fBytes > 0) {
                folderSizeEl.style.display = 'inline-flex';
                folderSizeEl.textContent = `💾 约 ${formatBytes(fBytes)}${knownCount < folderItems.length ? ' (探测中...)' : ''}`;
            }
        }
    }

    function updateSummaryCountAndSize(completedProbeCount, totalProbeCount) {
        const countSpan = document.getElementById('gdrive-list-count');
        if (!countSpan || gdriveTasks.length === 0) return;

        const folderMap = new Map();
        let selectedBytes = 0;
        let selectedCount = 0;
        let totalKnownBytes = 0;

        gdriveTasks.forEach(t => {
            const fp = t.folderPath || '';
            folderMap.set(fp, true);
            if (t.size > 0) totalKnownBytes += t.size;
            if (t.selected) {
                selectedCount++;
                if (t.size > 0) selectedBytes += t.size;
            }
        });

        let sizeText = '';
        if (selectedBytes > 0) {
            sizeText = ` · <span style="color: #38bdf8; font-weight: 600;">💾 预计下载: ${formatBytes(selectedBytes)}</span>`;
            if (completedProbeCount !== undefined && totalProbeCount !== undefined && completedProbeCount < totalProbeCount) {
                sizeText += ` <span style="font-size: 11px; opacity: 0.75;">(已测定 ${completedProbeCount}/${totalProbeCount} 项)</span>`;
            }
        } else if (totalProbeCount && completedProbeCount < totalProbeCount) {
            sizeText = ` · <span style="color: #94a3b8; font-size: 12px;">⏳ 正在读取文件大小 (${completedProbeCount}/${totalProbeCount})...</span>`;
        }

        countSpan.innerHTML = `共 ${gdriveTasks.length} 项（已勾选 ${selectedCount} 项）· 包含 ${folderMap.size} 个文件夹层级${sizeText}`;
    }

    // ==================== 11. 工作流联动 ====================
    window.revealGDriveFile = function (filePath) {
        if (!filePath) return;
        if (window.electronAPI && window.electronAPI.showItemInFolder) {
            window.electronAPI.showItemInFolder(filePath);
        } else if (window.bridge && window.bridge.openPath) {
            window.bridge.openPath(filePath);
        }
    };

    window.openCurrentGDriveFolder = function () {
        let targetDir = lastBatchDownloadDir;

        // 1. 如果有明确记录的本次批次下载目录且存在，直接使用
        // 2. 否则从已完成的任务中获取其下载的具体文件夹路径（提取批次文件夹或直接所在目录）
        if (!targetDir) {
            const completedTask = gdriveTasks.find(t => t.status === 'completed' && t.filePath);
            if (completedTask && completedTask.filePath) {
                const baseDir = document.getElementById('gdrive-download-dir')?.value?.trim() || currentOutputDir;
                if (baseDir && completedTask.filePath.startsWith(baseDir)) {
                    const rel = completedTask.filePath.slice(baseDir.length).replace(/^[\/\\]/, '');
                    const firstSeg = rel.split(/[\/\\]/)[0];
                    if (firstSeg && firstSeg.startsWith('批量下载批次-')) {
                        targetDir = `${baseDir}/${firstSeg}`;
                    } else {
                        const lastSlash = Math.max(completedTask.filePath.lastIndexOf('/'), completedTask.filePath.lastIndexOf('\\'));
                        targetDir = lastSlash > 0 ? completedTask.filePath.slice(0, lastSlash) : baseDir;
                    }
                } else {
                    const lastSlash = Math.max(completedTask.filePath.lastIndexOf('/'), completedTask.filePath.lastIndexOf('\\'));
                    targetDir = lastSlash > 0 ? completedTask.filePath.slice(0, lastSlash) : baseDir;
                }
            }
        }

        // 3. 兜底为配置的根输出目录
        if (!targetDir) {
            targetDir = document.getElementById('gdrive-download-dir')?.value?.trim() || currentOutputDir;
        }

        if (targetDir) {
            console.log('[GDrive] 打开本次下载保存的目标文件夹:', targetDir);
            if (window.bridge && window.bridge.openPath) {
                window.bridge.openPath(targetDir);
            } else if (window.electronAPI && window.electronAPI.openPath) {
                window.electronAPI.openPath(targetDir);
            } else if (window.electronAPI && window.electronAPI.showItemInFolder) {
                window.electronAPI.showItemInFolder(targetDir);
            }
        } else {
            showToast('未检测到可打开的本地保存文件夹', 'warning');
        }
    };

    window.sendGDriveFileToReels = function (filePath) {
        if (!filePath) return;
        window.batchImportGDriveToReels([filePath]);
    };

    window.batchImportGDriveToReels = function (explicitPaths) {
        let filePaths = [];
        if (Array.isArray(explicitPaths) && explicitPaths.length) {
            filePaths = explicitPaths;
        } else {
            filePaths = gdriveTasks
                .filter(t => t.selected && t.status === 'completed' && t.filePath)
                .map(t => t.filePath);
        }

        if (!filePaths.length) {
            showToast('未发现已下载完成的文件，请先勾选并下载素材', 'warning');
            return;
        }

        // 切换到批量 Reels 标签页
        const reelsTabBtn = document.querySelector('[data-tab="batch-reels"]');
        if (reelsTabBtn) {
            reelsTabBtn.click();
        }

        // 联动导入到素材或表格
        if (window.handleBatchImportLocalMedia) {
            window.handleBatchImportLocalMedia(filePaths);
            showToast(`已成功将 ${filePaths.length} 个素材导入到批量 Reels 制作！🎬`, 'success');
        } else if (window.electronAPI && window.electronAPI.apiCall) {
            window.electronAPI.apiCall('reels/import-media', { paths: filePaths }).then(() => {
                showToast(`已成功将 ${filePaths.length} 个素材导入到批量 Reels 制作！🎬`, 'success');
            }).catch(() => {
                showToast(`已导入 ${filePaths.length} 个素材文件`, 'info');
            });
        }
    };

    window.sendGDriveFileToVisualReview = function (filePath) {
        if (!filePath) return;
        window.batchImportGDriveToVisualReview([filePath]);
    };

    window.batchImportGDriveToVisualReview = function (explicitPaths) {
        let filePaths = [];
        if (Array.isArray(explicitPaths) && explicitPaths.length) {
            filePaths = explicitPaths;
        } else {
            filePaths = gdriveTasks
                .filter(t => t.selected && t.status === 'completed' && t.filePath)
                .map(t => t.filePath);
        }

        if (!filePaths.length) {
            showToast('请先下载素材后再导入素材快速审核', 'warning');
            return;
        }

        const reviewTabBtn = document.querySelector('[data-tab="visual-review"]');
        if (reviewTabBtn) {
            reviewTabBtn.click();
        }

        if (window.loadReviewFiles) {
            window.loadReviewFiles(filePaths);
            showToast(`已将 ${filePaths.length} 个素材导入到【素材快速审核】🔍`, 'success');
        } else {
            showToast(`已成功联动 ${filePaths.length} 个素材到审核面板`, 'success');
        }
    };

    window.sendGDriveFileToBatchRename = function (filePath, targetName) {
        if (!filePath) return;
        window.batchImportGDriveToBatchRename([{ filePath, targetName }]);
    };

    window.batchImportGDriveToBatchRename = function (explicitItems) {
        let items = [];
        if (Array.isArray(explicitItems) && explicitItems.length) {
            items = explicitItems;
        } else {
            items = gdriveTasks
                .filter(t => t.selected && t.status === 'completed' && t.filePath)
                .map(t => ({
                    filePath: t.filePath,
                    targetName: t.rename || '',
                }));
        }

        if (!items.length) {
            showToast('请先下载素材后再导入批量重命名', 'warning');
            return;
        }

        const renameTabBtn = document.querySelector('[data-tab="batch-rename"]');
        if (renameTabBtn) {
            renameTabBtn.click();
        }

        if (window.loadBatchRenameItems) {
            window.loadBatchRenameItems(items);
            showToast(`已将 ${items.length} 个素材与重命名规则导入到【批量重命名】🏷️`, 'success');
        } else {
            showToast(`已成功联动 ${items.length} 个素材到重命名面板`, 'success');
        }
    };

    // ==================== 12. 初始化与事件挂载 ====================
    function initGDriveDownloader() {
        restoreGDriveBatchRenameRule();
        initDefaultDownloadDir();
        renderGDriveTable();
        updateDownloadButtonState();

        // 默认不新建批次目录；需要时间戳批次时由用户明确勾选。
        const batchFolderCheck = document.getElementById('gdrive-batch-folder');
        if (batchFolderCheck) {
            batchFolderCheck.checked = getGDriveTotalFolderNaming().active;
        }

        // 默认勾选「仅重命名链接对应的文件夹」
        const renameFolderOnlyCheck = document.getElementById('gdrive-rename-folder-only');
        if (renameFolderOnlyCheck) {
            renameFolderOnlyCheck.checked = true;
        }

        // 默认不勾选「预估文件大小」（避免大目录反复计算耗时，下载时流式获取）
        const probeSizesCheck = document.getElementById('gdrive-probe-sizes');
        if (probeSizesCheck) {
            probeSizesCheck.checked = false;
        }

        // 输入框内容变动即刻响应下载按钮可用状态，并在贴新内容时隐藏上次遗留的旧看板
        function handleGDriveInputChange() {
            const currentText = document.getElementById('gdrive-input-text')?.value?.trim() || '';
            if (currentText !== lastParsedRawText) {
                const dash = document.getElementById('gdrive-download-dashboard');
                if (dash) dash.style.display = 'none';
                const banner = document.getElementById('gdrive-parse-banner');
                if (banner) banner.style.display = 'none';
                const notice = document.getElementById('gdrive-dash-complete-notice');
                if (notice) notice.style.display = 'none';
            }
            updateDownloadButtonState();
        }

        const inputText = document.getElementById('gdrive-input-text');
        if (inputText) {
            inputText.addEventListener('input', handleGDriveInputChange);
            inputText.addEventListener('paste', event => {
                const clipboard = event.clipboardData;
                if (!clipboard || !window.GoogleDriveInput) return;
                const plainText = clipboard.getData('text/plain');
                const parsed = window.GoogleDriveInput.parseClipboard(clipboard.getData('text/html'), plainText);
                if (parsed.entries.length) {
                    event.preventDefault();
                    inputText.setRangeText(window.GoogleDriveInput.toInputList(parsed.entries), inputText.selectionStart, inputText.selectionEnd, 'end');
                    const all = window.GoogleDriveInput.parseText(inputText.value);
                    const unique = window.GoogleDriveInput.uniqueLinks(all);
                    inputText.value = window.GoogleDriveInput.toInputList(unique);
                    inputText.dispatchEvent(new Event('input', { bubbles: true }));
                    showToast(`已提取 ${unique.length} 个不重复链接（每行一个）`, 'success');
                } else {
                    setTimeout(() => {
                        handleGDriveInputChange();
                        if (plainText.trim()) showToast('未读取到链接地址。如果复制后只有名称，请从原表格正常复制单元格，或复制链接地址', 'warning');
                    }, 0);
                }
            });
        }

        // 监听下载进度
        if (window.electronAPI && window.electronAPI.onGDriveDownloadProgress) {
            window.electronAPI.onGDriveDownloadProgress(handleDownloadProgressEvent);
        } else if (window.ipcRenderer) {
            window.ipcRenderer.on('gdrive-download-progress', (_e, data) => handleDownloadProgressEvent(data));
        }

        // 监听识别分析进度
        if (window.electronAPI && window.electronAPI.onGDriveParseProgress) {
            window.electronAPI.onGDriveParseProgress(updateParseProgressUI);
        } else if (window.ipcRenderer) {
            window.ipcRenderer.on('gdrive-parse-progress', (_e, data) => updateParseProgressUI(data));
        }

        // 监听预估文件大小探测进度
        if (window.electronAPI && window.electronAPI.onGDriveSizeProgress) {
            window.electronAPI.onGDriveSizeProgress(handleSizeProgressEvent);
        } else if (window.ipcRenderer) {
            window.ipcRenderer.on('gdrive-size-progress', (_e, data) => handleSizeProgressEvent(data));
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initGDriveDownloader);
    } else {
        initGDriveDownloader();
    }
})();
