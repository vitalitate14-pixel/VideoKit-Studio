/**
 * VideoKit 渲染端 AI 操作桥接与顶部开关 UI
 *
 * 1. 在顶部导航栏右侧渲染「🤖 AI 操作」总开关 + 「日志」按钮 + 日志弹窗（支持刷新、重置口令）
 * 2. 监听主进程 ai-api:renderer-request，向本机 AI 接口提供全量实时界面状态与受控操作能力
 */
(function () {
    'use strict';

    if (typeof window === 'undefined' || !window.electronAPI) return;

    const ACTION_LABELS = {
        overview: '看总览',
        ui_navigate: '切换界面 / 定位文件',
        job: '查后台任务',
        confirm: '✅ 确认执行',
        stop_task: '⏹ 停止任务',
        reels_query: '查批量 Reels',
        reels_edit: '🎬 编辑批量 Reels',
        reels_export: '🚀 批量 Reels 导出',
        templates: '📂 模板库操作',
        autoedit: '✂️ 文案自动剪辑',
        visual_review: '🔍 素材快速审核',
        voiceover_workflow: '🎙️ 一键配音字幕',
        tts_studio: '🔊 配音工坊 / Voice Studio',
        subtitle_align: '📝 字幕对齐',
        srt_tools: '⏱️ SRT / TXT 工具',
        download: '⬇️ 下载工具 / GDrive',
        media_convert: '🎞️ 媒体转换 / 音频 / 水印',
        media_analyze_cut: '🎬 场景检测 / 截图 / 剪辑',
        rename_match: '🏷️ 命名与匹配',
        file_organizer: '📁 素材整理 / 多窗口',
        phone_cards: '☎️ 电话卡片',
        settings: '⚙️ 设置与缓存',
        renderer_action: '🧩 界面通用检视 / 操作',
        'ui:set_enabled': '🔘 切换总开关',
        'ui:reset_token': '🔑 重置口令',
    };

    const IMPORTANT_RE = /^(confirm|reels_export|reels_edit|autoedit|file_organizer|rename_match|tts_studio|voiceover_workflow|subtitle_align|download|media_convert|media_analyze_cut|phone_cards|templates|renderer_action|ui:)/;

    function escHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
        }[ch]));
    }

    function notify(msg, type = 'info') {
        if (typeof window.showToast === 'function') {
            window.showToast(msg, type);
        }
    }

    // ==================== 1. 顶部开关与日志弹窗 UI ====================

    function injectStyles() {
        if (document.getElementById('vk-ai-api-styles')) return;
        const style = document.createElement('style');
        style.id = 'vk-ai-api-styles';
        style.textContent = `
          .vk-ai-pill {
            margin-left: auto;
            flex-shrink: 0;
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 2px 9px;
            border-radius: 999px;
            border: 1px solid rgba(255, 255, 255, 0.14);
            background: rgba(255, 255, 255, 0.05);
            color: #cbd5e1;
            font-size: 11px;
            line-height: 1.4;
            user-select: none;
            transition: background 0.18s ease, border-color 0.18s ease, color 0.18s ease;
          }
          .vk-ai-pill.is-enabled {
            border-color: rgba(167, 139, 250, 0.52);
            background: rgba(139, 92, 246, 0.18);
            color: #ede9fe;
          }
          .vk-ai-switch {
            position: relative;
            display: inline-block;
            width: 28px;
            height: 15px;
            cursor: pointer;
          }
          .vk-ai-switch input {
            opacity: 0;
            width: 0;
            height: 0;
          }
          .vk-ai-slider {
            position: absolute;
            inset: 0;
            background: #475569;
            border-radius: 999px;
            transition: background 0.18s ease;
          }
          .vk-ai-slider::before {
            content: '';
            position: absolute;
            width: 11px;
            height: 11px;
            left: 2px;
            top: 2px;
            border-radius: 50%;
            background: #ffffff;
            transition: transform 0.18s ease;
          }
          .vk-ai-switch input:checked + .vk-ai-slider {
            background: #8b5cf6;
          }
          .vk-ai-switch input:checked + .vk-ai-slider::before {
            transform: translateX(13px);
          }
          .vk-ai-log-btn {
            background: transparent;
            border: 0;
            padding: 0 2px;
            color: #c4b5fd;
            font-size: 11px;
            cursor: pointer;
            text-decoration: underline;
            text-underline-offset: 2px;
          }
          .vk-ai-log-btn:hover {
            color: #ffffff;
          }
          .vk-ai-modal-overlay {
            position: fixed;
            left: 0;
            right: 0;
            top: var(--window-chrome-height, 38px);
            bottom: 0;
            z-index: 420000;
            background: rgba(0, 0, 0, 0.72);
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 18px;
            -webkit-app-region: no-drag;
          }
          .vk-ai-modal {
            width: min(860px, 94vw);
            max-height: 84vh;
            display: flex;
            flex-direction: column;
            background: #161822;
            color: #e2e8f0;
            border: 1px solid rgba(167, 139, 250, 0.32);
            border-radius: 12px;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.6);
            overflow: hidden;
          }
          .vk-ai-modal-head {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
            padding: 12px 16px;
            background: #10121b;
            border-bottom: 1px solid rgba(255, 255, 255, 0.08);
          }
          .vk-ai-modal-head h3 {
            margin: 0;
            font-size: 14px;
            color: #f8fafc;
          }
          .vk-ai-modal-meta {
            display: flex;
            align-items: center;
            justify-content: space-between;
            flex-wrap: wrap;
            gap: 8px;
            padding: 8px 16px;
            font-size: 12px;
            color: #94a3b8;
            background: rgba(139, 92, 246, 0.08);
            border-bottom: 1px solid rgba(255, 255, 255, 0.06);
          }
          .vk-ai-modal-actions {
            display: flex;
            gap: 8px;
            align-items: center;
          }
          .vk-ai-modal-btn {
            padding: 4px 10px;
            border-radius: 6px;
            border: 1px solid rgba(255, 255, 255, 0.14);
            background: #232638;
            color: #e2e8f0;
            font-size: 12px;
            cursor: pointer;
          }
          .vk-ai-modal-btn:hover {
            background: #31354d;
            border-color: rgba(167, 139, 250, 0.5);
          }
          .vk-ai-modal-btn-danger {
            border-color: rgba(248, 113, 113, 0.35);
            color: #fca5a5;
          }
          .vk-ai-modal-body {
            flex: 1;
            min-height: 220px;
            max-height: 62vh;
            overflow: auto;
            padding: 8px 14px 14px;
            font-size: 12px;
          }
          .vk-ai-log-row {
            padding: 6px 8px;
            border-bottom: 1px solid rgba(255, 255, 255, 0.06);
            border-radius: 4px;
            line-height: 1.45;
            word-break: break-all;
          }
          .vk-ai-log-row.is-important {
            background: rgba(139, 92, 246, 0.12);
          }
          .vk-ai-log-row.is-error {
            background: rgba(239, 68, 68, 0.12);
            color: #fca5a5;
          }
          .vk-ai-log-time {
            color: #94a3b8;
            margin-right: 8px;
            font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
            font-size: 11px;
          }
          .vk-ai-log-act {
            font-weight: 600;
            color: #f1f5f9;
            margin-right: 8px;
          }
          .vk-ai-log-row.is-error .vk-ai-log-act {
            color: #fca5a5;
          }
          .vk-ai-log-ms {
            color: #64748b;
            font-size: 11px;
            margin-right: 8px;
          }
          .vk-ai-log-params {
            color: #94a3b8;
            font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
            font-size: 11px;
          }
        `;
        document.head.appendChild(style);
    }

    let currentStatus = null;

    function updatePillUI(pill, checkbox, status) {
        currentStatus = status || null;
        const enabled = Boolean(status?.enabled);
        checkbox.checked = enabled;
        pill.classList.toggle('is-enabled', enabled);
        const portText = status?.port ? `127.0.0.1:${status.port}` : '127.0.0.1:18220';
        const modeText = status?.mode === 'packaged' ? '正式版' : '开发版';
        const errHint = status?.listenError ? `（⚠️ ${status.listenError}）` : '';
        pill.title = `允许 AI（Antigravity）通过本机接口 ${portText}（${modeText}）查看状态与操控 VideoKit；高风险操作均需确认；关闭后 AI 立即无法调用${errHint}`;
    }

    async function openLogModal() {
        const existing = document.getElementById('vk-ai-log-modal');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.id = 'vk-ai-log-modal';
        overlay.className = 'vk-ai-modal-overlay';
        overlay.innerHTML = `
          <div class="vk-ai-modal" role="dialog" aria-label="AI 操作日志">
            <div class="vk-ai-modal-head">
              <h3>🤖 AI 操作日志（最近 200 条，新的在前）</h3>
              <button type="button" class="vk-ai-modal-btn" data-close>✕ 关闭</button>
            </div>
            <div class="vk-ai-modal-meta">
              <span data-meta-text>正在读取状态…</span>
              <div class="vk-ai-modal-actions">
                <button type="button" class="vk-ai-modal-btn" data-refresh>🔄 刷新</button>
                <button type="button" class="vk-ai-modal-btn vk-ai-modal-btn-danger" data-reset-token>🔑 重置口令</button>
              </div>
            </div>
            <div class="vk-ai-modal-body" data-log-body>正在加载日志…</div>
          </div>
        `;
        document.body.appendChild(overlay);

        const close = () => overlay.remove();
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay || e.target.closest('[data-close]')) close();
        });
        const onEsc = (e) => {
            if (e.key === 'Escape') {
                close();
                document.removeEventListener('keydown', onEsc);
            }
        };
        document.addEventListener('keydown', onEsc);

        const renderLogs = async () => {
            const metaEl = overlay.querySelector('[data-meta-text]');
            const bodyEl = overlay.querySelector('[data-log-body]');
            try {
                const [st, logs] = await Promise.all([
                    window.electronAPI.aiApiGetStatus(),
                    window.electronAPI.aiApiGetLog(200),
                ]);
                const pill = document.getElementById('vk-ai-api-pill');
                const cb = document.getElementById('vk-ai-api-checkbox');
                if (pill && cb) updatePillUI(pill, cb, st);

                const modeLabel = st?.mode === 'packaged' ? '正式版' : '开发版';
                const stateLabel = st?.enabled
                    ? (st?.listening ? `🟢 已开启 · 127.0.0.1:${st.port}` : `🟡 已开启（${st?.listenError || '未监听'}）`)
                    : '⚪ 已关闭';
                metaEl.textContent = `${stateLabel} · ${modeLabel} · 后台任务 ${st?.runningJobsCount || 0} 个 · 待确认口令 ${st?.pendingConfirmCount || 0} 个`;

                const list = Array.isArray(logs) ? logs : [];
                if (!list.length) {
                    bodyEl.innerHTML = '<div style="padding:20px;text-align:center;color:#94a3b8;">还没有任何 AI 操作记录</div>';
                    return;
                }
                bodyEl.innerHTML = list.map((l) => {
                    const act = String(l.action || '');
                    const label = ACTION_LABELS[act] || act || '未知操作';
                    const isError = l.ok === false;
                    const isImportant = IMPORTANT_RE.test(act);
                    const time = l.at ? new Date(String(l.at)).toLocaleString() : '';
                    const ms = Number.isFinite(l.ms) ? `${l.ms}ms` : '';
                    const paramsText = l.params && Object.keys(l.params).length ? JSON.stringify(l.params) : '';
                    const errText = l.error ? ` ❌ ${l.error}` : '';
                    const cls = `vk-ai-log-row${isError ? ' is-error' : (isImportant ? ' is-important' : '')}`;
                    return `<div class="${cls}">
                      <span class="vk-ai-log-time">${escHtml(time)}</span>
                      <span class="vk-ai-log-act">${escHtml(label)}</span>
                      ${ms ? `<span class="vk-ai-log-ms">${escHtml(ms)}</span>` : ''}
                      ${paramsText ? `<span class="vk-ai-log-params">${escHtml(paramsText.slice(0, 320))}</span>` : ''}
                      ${errText ? `<span>${escHtml(errText)}</span>` : ''}
                    </div>`;
                }).join('');
            } catch (err) {
                bodyEl.innerHTML = `<div style="padding:16px;color:#fca5a5;">读取日志失败：${escHtml(err?.message || err)}</div>`;
            }
        };

        overlay.querySelector('[data-refresh]').addEventListener('click', () => void renderLogs());
        overlay.querySelector('[data-reset-token]').addEventListener('click', async () => {
            if (!window.confirm('确认重置本机 AI 接口口令？重置后旧口令立即失效，MCP 工具桥下次调用会自动读取新口令。')) return;
            try {
                await window.electronAPI.aiApiResetToken();
                notify('已重置 AI 操作口令', 'success');
                await renderLogs();
            } catch (err) {
                notify('重置口令失败：' + (err?.message || err), 'error');
            }
        });

        await renderLogs();
    }

    function mountTitlebarToggle() {
        const header = document.querySelector('header.titlebar');
        if (!header || document.getElementById('vk-ai-api-pill')) return;
        injectStyles();

        const pill = document.createElement('div');
        pill.id = 'vk-ai-api-pill';
        pill.className = 'vk-ai-pill';
        pill.innerHTML = `
          <span>🤖 AI 操作</span>
          <label class="vk-ai-switch">
            <input type="checkbox" id="vk-ai-api-checkbox" aria-label="允许 AI 操作 VideoKit">
            <span class="vk-ai-slider"></span>
          </label>
          <button type="button" class="vk-ai-log-btn" id="vk-ai-api-log-btn">日志</button>
        `;
        header.appendChild(pill);

        const checkbox = pill.querySelector('#vk-ai-api-checkbox');
        const logBtn = pill.querySelector('#vk-ai-api-log-btn');

        checkbox.addEventListener('change', async () => {
            try {
                const next = await window.electronAPI.aiApiSetEnabled(checkbox.checked);
                updatePillUI(pill, checkbox, next);
                notify(
                    next.enabled
                        ? `已开启 AI 操作接口 (127.0.0.1:${next.port})`
                        : '已关闭 AI 操作，AI 将无法查看或控制 VideoKit',
                    next.enabled ? 'success' : 'info'
                );
            } catch (err) {
                checkbox.checked = !checkbox.checked;
                notify('切换 AI 操作开关失败：' + (err?.message || err), 'error');
            }
        });

        logBtn.addEventListener('click', () => void openLogModal());

        window.electronAPI.aiApiGetStatus()
            .then((st) => updatePillUI(pill, checkbox, st))
            .catch(() => { });
    }

    // ==================== 2. 渲染端能力与状态查询 ====================

    function parseIndexSelector(rangeSpec, total) {
        if (!rangeSpec) return null;
        const set = new Set();
        const parts = (Array.isArray(rangeSpec) ? rangeSpec : String(rangeSpec).split(/[,，、\s]+/))
            .map((s) => String(s || '').trim())
            .filter(Boolean);
        for (const p of parts) {
            const m = p.match(/^(\d+)\s*[-~～—到至]\s*(\d+)$/);
            if (m) {
                const a = Math.max(1, Number(m[1]));
                const b = Math.min(total, Number(m[2]));
                for (let i = Math.min(a, b); i <= Math.max(a, b); i++) set.add(i - 1);
            } else if (/^\d+$/.test(p)) {
                const idx = Number(p) - 1;
                if (idx >= 0 && idx < total) set.add(idx);
            }
        }
        return set;
    }

    function readJsonLocalStorage(key, fallback = null) {
        try {
            const raw = localStorage.getItem(key);
            return raw ? JSON.parse(raw) : fallback;
        } catch (_) {
            return fallback;
        }
    }

    function getActiveTabInfo() {
        const activeTab = document.querySelector('.titlebar .tabs .tab.active');
        const activeMediaItem = document.querySelector('#media-panel .sidebar-item.active');
        const activeSrtSub = document.querySelector('#srt-tools-panel .sub-tab.active');
        const activeDlSub = document.querySelector('#video-download-panel .sub-tab.active');
        const activeInspector = document.querySelector('#batch-reels-panel .inspector-tab.active');
        return {
            tab: activeTab?.dataset?.tab || '',
            tabLabel: activeTab?.textContent?.trim() || '',
            mediaSubtab: activeMediaItem?.dataset?.subtab || activeMediaItem?.dataset?.mode || '',
            mediaSubtabLabel: activeMediaItem?.textContent?.trim() || '',
            srtSubtab: activeSrtSub?.dataset?.subtab || '',
            downloadSubtab: activeDlSub?.dataset?.subtab || '',
            reelsInspectorTab: activeInspector?.dataset?.tab || '',
        };
    }

    function summarizeReelsTask(t, idx) {
        const subs = Array.isArray(t?.subtitles) ? t.subtitles : (Array.isArray(t?.srtEntries) ? t.srtEntries : []);
        const overlays = Array.isArray(t?.overlays) ? t.overlays : [];
        const pathsToCheck = [t?.bgPath, t?.cvPath, t?.audioPath, t?.videoPath, t?.srtPath, t?.bgmPath].filter((p) => typeof p === 'string' && p && !/^blob:|^data:|^https?:/i.test(p));
        const missingPaths = pathsToCheck.filter((p) => window.electronAPI?.fileExists ? !window.electronAPI.fileExists(p) : false);
        return {
            index: idx + 1,
            id: t?.id || '',
            name: t?.baseName || t?.fileName || `任务 ${idx + 1}`,
            group: t?._folderQueueName || t?._groupName || '',
            selected: t?.exportSelected !== false,
            duration: Number(t?.duration) || null,
            bgPath: t?.bgPath || '',
            cvPath: t?.cvPath || '',
            audioPath: t?.audioPath || '',
            srtPath: t?.srtPath || '',
            bgmPath: t?.bgmPath || '',
            subtitleCount: subs.length,
            overlayCount: overlays.length,
            presetName: t?._subtitlePreset || '',
            hasMissingMedia: missingPaths.length > 0,
            missingPaths,
        };
    }

    function getReelsSummary() {
        const st = window._reelsState || {};
        const tasks = Array.isArray(st.tasks) ? st.tasks : [];
        const selected = tasks.filter((t) => t?.exportSelected !== false);
        const tabs = Array.isArray(window._batchTableState?.tabs)
            ? window._batchTableState.tabs.map((tab) => ({
                id: tab.id,
                name: tab.name,
                taskCount: Array.isArray(tab.tasks) ? tab.tasks.length : 0,
                active: tab.id === window._batchTableState?.activeTabId,
            }))
            : [];
        const outputDirEl = document.getElementById('reels-output-dir');
        const engineEl = document.getElementById('reels-export-engine') || document.getElementById('reels-export-mode');
        const workModeEl = document.getElementById('reels-work-mode');
        const karaokeEl = document.getElementById('reels-karaoke-hl');
        const exportBtn = document.getElementById('reels-export-btn');
        const progressEl = document.getElementById('reels-export-progress-text') || document.getElementById('reels-export-status');
        return {
            totalTasks: tasks.length,
            selectedCount: selected.length,
            selectedIdx: Number.isInteger(st.selectedIdx) ? st.selectedIdx + 1 : null,
            isExporting: Boolean(st.isExporting),
            exportStatusText: progressEl?.textContent?.trim() || '',
            exportButtonText: exportBtn?.textContent?.trim() || '',
            lastExportOutputPath: st.lastExportOutputPath || '',
            outputDir: outputDirEl?.value || '',
            exportEngine: engineEl?.value || '',
            resolution: `${st.targetWidth || 1080}x${st.targetHeight || 1920}`,
            workMode: workModeEl?.value || 'srt',
            karaokeHighlight: Boolean(karaokeEl?.checked),
            tabs,
            watermarksCount: Array.isArray(st.watermarks) ? st.watermarks.length : 0,
        };
    }

    function getAutoEditStatus() {
        const batchBtn = document.getElementById('autoedit-mode-batch');
        const mode = batchBtn?.classList?.contains('active') ? 'batch' : 'single';
        const stopBtn = document.getElementById('autoedit-batch-stop-btn') || document.getElementById('autoedit-stop-btn');
        const running = Boolean(stopBtn && !stopBtn.disabled && !/无运行任务/.test(stopBtn.textContent || ''));
        const statusText = (document.getElementById('autoedit-batch-status') || document.getElementById('autoedit-status'))?.textContent?.trim() || '';
        const hedraStatus = document.getElementById('autoedit-hedra-bridge-status')?.textContent?.trim() || '';
        const rows = document.querySelectorAll('#autoedit-batch-task-list tr, #autoedit-batch-task-list .autoedit-batch-card');
        return {
            mode,
            running,
            statusText,
            hedraBridgeStatus: hedraStatus,
            visibleTaskElements: rows.length,
            lastMismatchesCount: Array.isArray(window.autoEditLastMismatches) ? window.autoEditLastMismatches.length : 0,
            lastMissingBlocksCount: Array.isArray(window.autoEditLastMissingBlocks) ? window.autoEditLastMissingBlocks.length : 0,
        };
    }

    function getVoiceoverStatus() {
        const saved = readJsonLocalStorage('videokit_voiceover_resume_v1', null);
        const startBtn = document.getElementById('vw-start-btn');
        const pauseBtn = document.getElementById('vw-pause-btn');
        const outEl = document.getElementById('vw-output-dir');
        const voiceEl = document.getElementById('vw-default-voice');
        const tasks = Array.isArray(saved?.tasks) ? saved.tasks : [];
        const counts = { total: tasks.length, pending: 0, generating: 0, done: 0, error: 0 };
        for (const t of tasks) {
            const st = t?.status || 'pending';
            if (counts[st] !== undefined) counts[st]++;
        }
        return {
            running: Boolean(startBtn?.disabled && pauseBtn && !pauseBtn.disabled),
            outputDir: outEl?.value || saved?.batchOutputDir || window._vwLastOutputFolder || '',
            defaultVoiceId: voiceEl?.value || '',
            counts,
            tasksPreview: tasks.slice(0, 30).map((t, i) => ({
                index: i + 1,
                status: t.status || 'pending',
                folderName: t.folderName || '',
                textPreview: String(t.text || '').slice(0, 80),
                error: t.error || null,
            })),
        };
    }

    function getTtsQueueStatus(provider) {
        const readOne = (key, prefix) => {
            const saved = readJsonLocalStorage(key, {});
            const rows = Array.isArray(saved?.rows) ? saved.rows : [];
            const stopBtn = document.getElementById(`${prefix}-stop`);
            const progress = document.getElementById(`${prefix}-progress`)?.textContent?.trim() || '';
            return {
                running: Boolean(stopBtn && !stopBtn.disabled),
                progress,
                voice: saved?.voice || '',
                language: saved?.language || '',
                outputDir: saved?.output || '',
                taskFolder: saved?.taskFolder || '',
                total: rows.length,
                done: rows.filter((r) => r.state === 'done').length,
                failed: rows.filter((r) => r.state === 'failed').length,
                waiting: rows.filter((r) => !r.state || r.state === 'waiting').length,
            };
        };
        if (provider === 'microsoft') return readOne('videokit_microsoft_tts_queue_v1', 'ms');
        if (provider === 'google') return readOne('videokit_google_tts_queue_v1', 'gg');
        if (provider === 'elevenlabs') {
            const rows = document.querySelectorAll('#tts-batch-list .tts-batch-item, #tts-batch-table tbody tr');
            return {
                batchRowCount: rows.length,
                voiceSelected: document.getElementById('tts-voice-select')?.value || '',
                modelSelected: document.getElementById('tts-model-select')?.value || '',
            };
        }
        return {
            elevenlabs: getTtsQueueStatus('elevenlabs'),
            microsoft: readOne('videokit_microsoft_tts_queue_v1', 'ms'),
            google: readOne('videokit_google_tts_queue_v1', 'gg'),
        };
    }

    function getPhoneCardsStatus() {
        const panel = document.getElementById('phone-cards-panel');
        if (!panel) return { mounted: false };
        const stylesCount = panel.querySelectorAll('[data-styles] .pc-style').length;
        const rowsCount = panel.querySelectorAll('[data-rows] tr').length;
        const outputDir = panel.querySelector('[data-output-dir]')?.value || '';
        const statusText = panel.querySelector('[data-status]')?.textContent?.trim() || '';
        const cancelBtn = panel.querySelector('[data-cancel]');
        return {
            mounted: true,
            stylesCount,
            rowsCount,
            outputDir,
            statusText,
            exporting: Boolean(cancelBtn && !cancelBtn.hidden),
        };
    }

    function getDownloadStatus() {
        const gdriveRows = document.querySelectorAll('#gdrive-task-list tr, #gdrive-task-list .gdrive-task-row');
        const gdriveOut = document.getElementById('gdrive-download-dir')?.value || '';
        const gdriveBtn = document.getElementById('btn-gdrive-start-download');
        const dlOut = document.getElementById('download-dir')?.value || '';
        const batchOut = document.getElementById('batch-download-dir')?.value || '';
        return {
            singleOutputDir: dlOut,
            batchOutputDir: batchOut,
            gdrive: {
                outputDir: gdriveOut,
                taskRows: gdriveRows.length,
                startButtonText: gdriveBtn?.textContent?.trim() || '',
            },
        };
    }

    // ==================== 3. 主渲染端分发器 ====================

    const rendererHandlers = {
        async overview() {
            const nav = getActiveTabInfo();
            const reels = getReelsSummary();
            const autoedit = getAutoEditStatus();
            const voiceover = getVoiceoverStatus();
            const tts = getTtsQueueStatus('all');
            const phoneCards = getPhoneCardsStatus();
            const download = getDownloadStatus();
            const runningModules = [];
            if (reels.isExporting) runningModules.push('batch-reels:export');
            if (autoedit.running) runningModules.push('autoedit');
            if (voiceover.running) runningModules.push('voiceover-workflow');
            if (tts.microsoft?.running) runningModules.push('microsoft-tts');
            if (tts.google?.running) runningModules.push('google-tts');
            if (phoneCards.exporting) runningModules.push('phone-cards');
            return {
                navigation: nav,
                runningModules,
                isBusy: runningModules.length > 0,
                queues: {
                    reelsTasks: reels.totalTasks,
                    reelsSelected: reels.selectedCount,
                    reelsTabs: reels.tabs.length,
                    voiceoverTasks: voiceover.counts.total,
                    microsoftTtsRows: tts.microsoft?.total || 0,
                    googleTtsRows: tts.google?.total || 0,
                    gdriveTasks: download.gdrive.taskRows,
                    phoneCardStyles: phoneCards.stylesCount || 0,
                    phoneCardRows: phoneCards.rowsCount || 0,
                },
                reels: {
                    isExporting: reels.isExporting,
                    exportStatusText: reels.exportStatusText,
                    outputDir: reels.outputDir,
                    lastExportOutputPath: reels.lastExportOutputPath,
                },
                autoedit: {
                    mode: autoedit.mode,
                    running: autoedit.running,
                    statusText: autoedit.statusText,
                },
                defaultOutputDir: localStorage.getItem('videokit_default_output_dir') || '',
            };
        },

        async ui_navigate(params = {}) {
            if (params.tab) {
                const btn = document.querySelector(`.titlebar .tabs .tab[data-tab="${CSS.escape(String(params.tab))}"]`);
                if (!btn) throw new Error(`找不到主标签页：${params.tab}`);
                btn.click();
            }
            if (params.subtab) {
                const sub = document.querySelector(`[data-subtab="${CSS.escape(String(params.subtab))}"]`);
                if (!sub) throw new Error(`找不到子面板：${params.subtab}`);
                sub.click();
            }
            if (params.mediaMode) {
                const modeBtn = document.querySelector(`#media-panel .sidebar-item[data-mode="${CSS.escape(String(params.mediaMode))}"]`);
                if (!modeBtn) throw new Error(`找不到媒体转换模式：${params.mediaMode}`);
                modeBtn.click();
            }
            if (params.inspectorTab && typeof window.reelsInspectorSwitch === 'function') {
                window.reelsInspectorSwitch(String(params.inspectorTab));
            }
            return { ok: true, active: getActiveTabInfo() };
        },

        async stop_task(params = {}) {
            const target = String(params.target || 'all');
            const stopped = [];
            if ((target === 'all' || target === 'reels_export') && window._reelsState?.isExporting && typeof window.reelsCancelExport === 'function') {
                window.reelsCancelExport();
                stopped.push('reels_export');
            }
            if ((target === 'all' || target === 'autoedit') && typeof window.cancelAutoEditRunningTasks === 'function') {
                window.cancelAutoEditRunningTasks();
                stopped.push('autoedit');
            }
            if ((target === 'all' || target === 'voiceover_workflow') && typeof window.pauseVoiceoverWorkflow === 'function') {
                const pauseBtn = document.getElementById('vw-pause-btn');
                if (pauseBtn && !pauseBtn.disabled) {
                    window.pauseVoiceoverWorkflow();
                    stopped.push('voiceover_workflow');
                }
            }
            if (target === 'all' || target === 'microsoft_tts') {
                const btn = document.getElementById('ms-stop');
                if (btn && !btn.disabled) { btn.click(); stopped.push('microsoft_tts'); }
            }
            if (target === 'all' || target === 'google_tts') {
                const btn = document.getElementById('gg-stop');
                if (btn && !btn.disabled) { btn.click(); stopped.push('google_tts'); }
            }
            if (target === 'all' || target === 'phone_cards') {
                const btn = document.querySelector('#phone-cards-panel [data-cancel]');
                if (btn && !btn.hidden) { btn.click(); stopped.push('phone_cards'); }
            }
            return { stopped };
        },

        async reels_query(params = {}) {
            const action = String(params.action || 'summary');
            const st = window._reelsState || {};
            const tasks = Array.isArray(st.tasks) ? st.tasks : [];

            if (action === 'summary') return getReelsSummary();

            if (action === 'tasks') {
                const idxSet = parseIndexSelector(params.range, tasks.length);
                const groupFilter = String(params.group || '').trim();
                const limit = Math.min(300, Math.max(1, Number(params.limit) || 100));
                let list = tasks.map((t, i) => summarizeReelsTask(t, i));
                if (idxSet) list = list.filter((item) => idxSet.has(item.index - 1));
                if (groupFilter) list = list.filter((item) => item.group.includes(groupFilter));
                if (params.selectedOnly) list = list.filter((item) => item.selected);
                if (params.missingOnly) list = list.filter((item) => item.hasMissingMedia);
                return { total: tasks.length, matched: list.length, returned: Math.min(limit, list.length), tasks: list.slice(0, limit) };
            }

            if (action === 'task_detail') {
                let idx = -1;
                if (params.taskId) idx = tasks.findIndex((t) => t?.id === params.taskId);
                else if (Number(params.index) > 0) idx = Number(params.index) - 1;
                else idx = Number.isInteger(st.selectedIdx) && st.selectedIdx >= 0 ? st.selectedIdx : 0;
                const task = tasks[idx];
                if (!task) throw new Error('找不到指定的 Reels 任务');
                const subs = Array.isArray(task.subtitles) ? task.subtitles : (Array.isArray(task.srtEntries) ? task.srtEntries : []);
                return {
                    ...summarizeReelsTask(task, idx),
                    subtitleStyle: task.style || task.subtitleStyle || null,
                    subtitlesPreview: subs.slice(0, 30).map((s) => ({
                        start: s.start,
                        end: s.end,
                        text: String(s.text || '').slice(0, 200),
                    })),
                    overlays: (Array.isArray(task.overlays) ? task.overlays : []).map((ov) => ({
                        id: ov.id,
                        type: ov.type,
                        slot: ov.slot || ov.layerSlot || '',
                        name: ov.name || ov.label || '',
                        text: ov.text ? String(ov.text).slice(0, 300) : undefined,
                        path: ov.path || ov.src || undefined,
                        x: ov.x,
                        y: ov.y,
                        width: ov.width,
                        height: ov.height,
                        visible: ov.visible !== false,
                    })),
                    watermarks: task.watermarks || st.watermarks || [],
                };
            }

            if (action === 'presets') {
                const subRes = window.electronAPI.getSubtitlePresets?.();
                const ovRes = window.electronAPI.getOverlayGroupPresets?.();
                const tcRes = window.electronAPI.getTitleColorPresets?.();
                const wmPresets = readJsonLocalStorage('reels_watermark_presets', {});
                const subSelect = document.getElementById('reels-preset-select');
                const animSelect = document.getElementById('reels-anim-preset-select');
                return {
                    subtitlePresets: Object.keys(subRes?.presets || {}),
                    overlayGroupPresets: Object.keys(ovRes?.presets || {}),
                    titleColorPresets: Object.keys(tcRes?.presets || {}),
                    watermarkPresets: Object.keys(wmPresets || {}),
                    dropdownSubtitlePresets: subSelect ? Array.from(subSelect.options).map((o) => o.value).filter(Boolean) : [],
                    dropdownAnimationPresets: animSelect ? Array.from(animSelect.options).map((o) => o.value).filter(Boolean) : [],
                };
            }

            if (action === 'bulk_create') {
                const bs = window._reelsBulkState || {};
                return {
                    columns: bs.columns || [],
                    rowCount: Array.isArray(bs.rows) ? bs.rows.length : 0,
                    templateCount: Array.isArray(bs.templates) ? bs.templates.length : 0,
                    backgroundFoldersCount: Array.isArray(bs.backgroundFolders) ? bs.backgroundFolders.length : 0,
                    overlayMediaFoldersCount: Array.isArray(bs.overlayMediaFolders) ? bs.overlayMediaFolders.length : 0,
                    musicFilesCount: Array.isArray(bs.musicFiles) ? bs.musicFiles.length : 0,
                };
            }

            if (action === 'autosaves') {
                return { autosaves: window.electronAPI.listBatchAutoSaves ? window.electronAPI.listBatchAutoSaves() : [] };
            }

            if (action === 'layout_description') {
                if (window.ReelsLayoutDescription?.describeAllTasks) {
                    return { description: window.ReelsLayoutDescription.describeAllTasks(tasks) };
                }
                return { note: 'ReelsLayoutDescription 未导出 describeAllTasks，请用 task_detail 查看各层结构' };
            }

            throw new Error(`未知 reels_query action：${action}`);
        },

        async reels_edit_preview(params = {}) {
            const st = window._reelsState || {};
            const tasks = Array.isArray(st.tasks) ? st.tasks : [];
            const selected = tasks.filter((t) => t?.exportSelected !== false);
            return {
                summary: `将对批量 Reels 执行「${params.action}」（当前共 ${tasks.length} 条任务，已勾选 ${selected.length} 条）`,
                totalTasks: tasks.length,
                selectedCount: selected.length,
                params,
            };
        },

        async reels_edit(params = {}) {
            const action = String(params.action || '');
            const st = window._reelsState || {};
            const tasks = Array.isArray(st.tasks) ? st.tasks : [];

            if (action === 'select_task') {
                const idx = Math.max(0, Math.min(tasks.length - 1, (Number(params.index) || 1) - 1));
                if (!tasks[idx]) throw new Error('任务索引超出范围');
                if (typeof window.reelsSelectTask === 'function') window.reelsSelectTask(idx);
                return { ok: true, selectedIdx: idx + 1, name: tasks[idx].baseName || tasks[idx].fileName };
            }
            if (action === 'select_all') {
                if (typeof window.reelsToggleExportSelectAll === 'function') window.reelsToggleExportSelectAll(params.checked !== false);
                return getReelsSummary();
            }
            if (action === 'invert_selection') {
                if (typeof window.reelsInvertExportSelection === 'function') window.reelsInvertExportSelection();
                return getReelsSummary();
            }
            if (action === 'select_first_n') {
                const nInput = document.getElementById('reels-select-first-n-input');
                if (nInput && Number(params.count) > 0) nInput.value = String(Number(params.count));
                if (typeof window.reelsSelectFirstNPerGroup === 'function') window.reelsSelectFirstNPerGroup();
                return getReelsSummary();
            }
            if (action === 'undo') {
                if (typeof window.reelsUndo === 'function') window.reelsUndo();
                return { ok: true };
            }
            if (action === 'redo') {
                if (typeof window.reelsRedo === 'function') window.reelsRedo();
                return { ok: true };
            }
            if (action === 'open_overview') {
                if (typeof window.reelsOpenTaskOverview === 'function') window.reelsOpenTaskOverview();
                return { ok: true };
            }
            if (action === 'close_overview') {
                if (typeof window.reelsCloseTaskOverview === 'function') window.reelsCloseTaskOverview();
                return { ok: true };
            }
            if (action === 'toggle_batch_table') {
                if (typeof window.reelsToggleBatchTable === 'function') window.reelsToggleBatchTable();
                return { ok: true };
            }
            if (action === 'open_bulk_create') {
                if (typeof window._showBulkCreateModal === 'function') window._showBulkCreateModal();
                return { ok: true };
            }
            if (action === 'open_layout_batch') {
                if (typeof window.reelsOpenLayoutBatch === 'function') window.reelsOpenLayoutBatch();
                return { ok: true };
            }
            if (action === 'duplicate_selected') {
                if (typeof window.reelsDuplicateSelectedTasks === 'function') window.reelsDuplicateSelectedTasks();
                return getReelsSummary();
            }
            if (action === 'group_selected') {
                if (typeof window.reelsGroupSelectedTasks === 'function') window.reelsGroupSelectedTasks();
                return getReelsSummary();
            }
            if (action === 'delete_selected_tasks') {
                const toDelete = tasks.filter((t) => t?.exportSelected !== false).map((t) => t.id).filter(Boolean);
                if (typeof window.reelsDeleteTasks === 'function') {
                    window.reelsDeleteTasks(toDelete, { silent: true });
                } else {
                    st.tasks = tasks.filter((t) => t?.exportSelected === false);
                    if (typeof window.reelsRenderTaskList === 'function') window.reelsRenderTaskList();
                }
                return getReelsSummary();
            }
            if (action === 'clear_tasks') {
                if (typeof window.reelsClearPersistedBatchTasks === 'function') window.reelsClearPersistedBatchTasks();
                st.tasks = [];
                st.selectedIdx = -1;
                if (typeof window.reelsRenderTaskList === 'function') window.reelsRenderTaskList();
                return getReelsSummary();
            }
            if (action === 'set_work_mode') {
                const sel = document.getElementById('reels-work-mode');
                if (!sel) throw new Error('找不到工作模式下拉框');
                sel.value = String(params.mode || 'srt');
                sel.dispatchEvent(new Event('change'));
                return { ok: true, workMode: sel.value };
            }
            if (action === 'set_karaoke') {
                const cb = document.getElementById('reels-karaoke-hl');
                if (!cb) throw new Error('找不到卡拉OK开关');
                cb.checked = Boolean(params.enabled);
                cb.dispatchEvent(new Event('change'));
                return { ok: true, karaokeHighlight: cb.checked };
            }
            if (action === 'apply_crop_preset') {
                if (typeof window.reelsApplyCropPresetUI === 'function') window.reelsApplyCropPresetUI(String(params.preset || 'full'));
                return { ok: true, preset: params.preset || 'full' };
            }
            if (action === 'apply_animation_preset') {
                const sel = document.getElementById('reels-anim-preset-select');
                if (sel && params.preset) {
                    sel.value = String(params.preset);
                    sel.dispatchEvent(new Event('change'));
                }
                if (typeof window.reelsApplyAnimationPreset === 'function') window.reelsApplyAnimationPreset();
                return { ok: true, preset: params.preset };
            }
            if (action === 'apply_subtitle_preset') {
                const sel = document.getElementById('reels-preset-select');
                if (!sel) throw new Error('找不到字幕预设下拉框');
                sel.value = String(params.preset || '');
                sel.dispatchEvent(new Event('change'));
                return { ok: true, preset: sel.value };
            }
            if (action === 'import_folders') {
                const folders = Array.isArray(params.folders) ? params.folders : [];
                if (!folders.length) throw new Error('请提供 folders 文件夹路径数组');
                if (typeof window.reelsImportFoldersAsTaskTabs !== 'function') throw new Error('批量导入函数未加载');
                await window.reelsImportFoldersAsTaskTabs(folders);
                return getReelsSummary();
            }
            if (action === 'auto_match') {
                if (typeof window.reelsAutoMatchFiles === 'function') window.reelsAutoMatchFiles();
                return getReelsSummary();
            }
            if (action === 'resegment_srt') {
                if (typeof window.reelsResegment === 'function') window.reelsResegment();
                return { ok: true };
            }
            if (action === 'merge_short_srt') {
                if (typeof window.reelsMergeShort === 'function') window.reelsMergeShort();
                return { ok: true };
            }
            if (action === 'align_all_tasks') {
                if (typeof window.reelsAlignAllTasks === 'function') await window.reelsAlignAllTasks();
                return { ok: true };
            }
            if (action === 'relocate_media') {
                if (typeof window.reelsRelocateMediaReferences === 'function') {
                    return await window.reelsRelocateMediaReferences(params.searchDir || '');
                }
                throw new Error('素材重定位函数未加载');
            }
            if (action === 'save_project') {
                if (params.outputPath && typeof window.reelsCollectUnifiedProjectData === 'function') {
                    const data = window.reelsCollectUnifiedProjectData();
                    window.electronAPI.writeFileText(String(params.outputPath), JSON.stringify(data, null, 2));
                    return { ok: true, outputPath: params.outputPath, taskCount: tasks.length };
                }
                if (typeof window.reelsSaveUnifiedProject === 'function') {
                    await window.reelsSaveUnifiedProject();
                    return { ok: true };
                }
                throw new Error('保存工程函数未加载');
            }
            if (action === 'load_project') {
                if (!params.projectPath) throw new Error('请提供 projectPath');
                if (typeof window._extLoadProject !== 'function') throw new Error('加载工程函数未加载');
                const raw = window.electronAPI.readFileText(String(params.projectPath));
                if (!raw) throw new Error(`读取工程文件失败：${params.projectPath}`);
                await window._extLoadProject(JSON.parse(raw), String(params.projectPath));
                return getReelsSummary();
            }
            if (action === 'recover_autoedit_last') {
                if (typeof window.reloadLastAutoEditBatchReelsProject === 'function') {
                    await window.reloadLastAutoEditBatchReelsProject();
                    return getReelsSummary();
                }
                throw new Error('恢复上次自动剪辑工程函数未加载');
            }
            if (action === 'update_overlay_text') {
                const idx = Math.max(0, (Number(params.index) || 1) - 1);
                const task = tasks[idx];
                if (!task) throw new Error('找不到指定任务');
                const overlays = Array.isArray(task.overlays) ? task.overlays : [];
                const targetOv = params.overlayId
                    ? overlays.find((o) => o.id === params.overlayId)
                    : overlays.find((o) => o.type === 'text' || o.slot === params.slot || o.name === params.name) || overlays[0];
                if (!targetOv) throw new Error('该任务没有可修改的文字覆层');
                targetOv.text = String(params.text ?? '');
                if (typeof window.reelsSyncOverlayTextToBatchTable === 'function') window.reelsSyncOverlayTextToBatchTable(task);
                if (typeof window.reelsUpdatePreview === 'function') window.reelsUpdatePreview();
                return { ok: true, taskIndex: idx + 1, overlayId: targetOv.id, text: targetOv.text };
            }
            throw new Error(`暂不支持的 reels_edit action：${action}`);
        },

        async reels_export_preview(params = {}) {
            const st = window._reelsState || {};
            const tasks = Array.isArray(st.tasks) ? st.tasks : [];
            const selected = tasks.map((t, i) => summarizeReelsTask(t, i)).filter((item) => item.selected);
            const missing = selected.filter((item) => item.hasMissingMedia);
            const outputDir = params.outputDir || document.getElementById('reels-output-dir')?.value || localStorage.getItem('videokit_default_output_dir') || '';
            const modeLabels = {
                wysiwyg: 'WYSIWYG 逐帧渲染',
                turbo: '⚡ 极速硬件渲染 (Turbo)',
                parallel: 'V3 并行影子窗口',
                burn: '快速 ASS 字幕烧录',
                fcpxml: 'FCPXML / 达芬奇时间线',
                layered_png: '分层 PNG 序列',
                package_only: '📦 仅打包二剪工程',
            };
            return {
                mode: params.mode || 'wysiwyg',
                engineLabel: modeLabels[params.mode] || params.mode || '默认引擎',
                isCurrentlyExporting: Boolean(st.isExporting),
                totalTasks: tasks.length,
                selectedCount: selected.length,
                outputDir: outputDir || '(未指定，将使用默认目录)',
                resolution: `${st.targetWidth || 1080}x${st.targetHeight || 1920}`,
                tasksPreview: selected.slice(0, 20).map((t) => ({ index: t.index, name: t.name, group: t.group, hasMissingMedia: t.hasMissingMedia })),
                warnings: missing.length ? missing.slice(0, 10).map((m) => `任务 #${m.index}「${m.name}」存在缺失素材：${m.missingPaths.join(', ')}`) : [],
            };
        },

        async reels_export_start(params = {}) {
            const mode = String(params.mode || 'wysiwyg');
            const tabBtn = document.querySelector('.titlebar .tabs .tab[data-tab="batch-reels"]');
            if (tabBtn && !tabBtn.classList.contains('active')) tabBtn.click();

            if (params.outputDir) {
                const outEl = document.getElementById('reels-output-dir');
                if (outEl) {
                    outEl.value = String(params.outputDir);
                    outEl.dispatchEvent(new Event('change'));
                }
            }
            if (mode === 'fcpxml') {
                if (typeof window.reelsBatchFcpxmlExport !== 'function') throw new Error('FCPXML 导出函数未加载');
                window.reelsBatchFcpxmlExport();
                return { started: true, mode, message: '已触发批量 FCPXML 导出' };
            }
            if (mode === 'layered_png') {
                if (typeof window.reelsLayeredExport !== 'function') throw new Error('分层 PNG 导出函数未加载');
                window.reelsLayeredExport();
                return { started: true, mode, message: '已触发分层 PNG 序列导出' };
            }
            if (mode === 'package_only') {
                if (typeof window.reelsPackageSelectedProjects !== 'function') throw new Error('打包工程函数未加载');
                window.reelsPackageSelectedProjects();
                return { started: true, mode, message: '已触发批量工程打包' };
            }
            const engineEl = document.getElementById('reels-export-engine') || document.getElementById('reels-export-mode');
            if (engineEl && ['wysiwyg', 'turbo', 'parallel', 'burn'].includes(mode)) {
                const opt = Array.from(engineEl.options).find((o) => o.value.includes(mode));
                if (opt) {
                    engineEl.value = opt.value;
                    engineEl.dispatchEvent(new Event('change'));
                }
            }
            if (typeof window.reelsStartExport !== 'function') {
                const btn = document.getElementById('reels-export-btn');
                if (!btn) throw new Error('找不到批量导出按钮');
                btn.click();
            } else {
                window.reelsStartExport();
            }
            return { started: true, mode, message: '已启动批量 Reels 导出，可用 videokit_reels_query 或 videokit_overview 查看实时进度' };
        },

        async templates_action(params = {}) {
            const action = String(params.action || '');
            if (action === 'open_window') {
                return window.electronAPI.openTemplateWindow(String(params.id), String(params.name || params.id));
            }
            if (action === 'open_library') {
                if (typeof window.openTemplateLibrary === 'function') window.openTemplateLibrary();
                return { ok: true };
            }
            if (action === 'export_skill') {
                if (typeof window.tplExportSelectedSkills === 'function') {
                    await window.tplExportSelectedSkills(params.ids);
                    return { ok: true };
                }
                throw new Error('模板 Skill 导出函数未加载');
            }
            throw new Error(`未知 templates_action：${action}`);
        },

        async autoedit_query(params = {}) {
            const action = String(params.action || 'status');
            if (action === 'hedra_status') {
                const live = typeof window.refreshHedraBridgeStatus === 'function'
                    ? await window.refreshHedraBridgeStatus(false).catch((e) => ({ connected: false, error: e?.message }))
                    : { connected: false, error: 'refreshHedraBridgeStatus 未加载' };
                const badgeText = document.querySelector('[data-role="hedra-bridge-status-badge"]')?.textContent?.trim() || '';
                return { ...live, badgeText };
            }
            if (action === 'batch_report' && typeof window.buildAutoEditBatchIssuesTable === 'function') {
                return { status: getAutoEditStatus(), issuesTable: window.buildAutoEditBatchIssuesTable('all') };
            }
            return getAutoEditStatus();
        },

        async autoedit_action(params = {}) {
            const action = String(params.action || '');
            const autoStart = Boolean(params.autoStart ?? params.autoRun);
            const map = {
                set_mode: () => window.setAutoEditMode?.(String(params.mode || 'batch')),
                auto_break: () => (params.mode === 'single' ? window.autoBreakAutoEditScript?.() : window.autoBreakAutoEditBatchScripts?.()),
                smart_pair: () => window.startAutoEditBatchSmartPairing?.(),
                pull_from_hedra: () => window.pullGenerationAndFoldersFromHedra?.(),
                retry_hedra_import: () => window.retryLastHedraImport?.(),
                analyze: () => (params.mode === 'single' ? window.startAutoEditByScript?.(false, { analysisOnly: true }) : window.startAutoEditBatchAnalysis?.({ forceReanalysis: Boolean(params.forceReanalysis) })),
                export: () => window.startAutoEditBatchExport?.({ forceExport: Boolean(params.forceExport) }),
                export_only: () => window.startAutoEditBatchExportOnly?.(),
                export_project: () => window.startAutoEditBatchExportProject?.(),
                send_to_reels: () => window.sendAutoEditResultToReels?.(),
                archive_selected: () => window.archiveAutoEditBatchSelectedTasks?.(),
                archive_failed: () => window.archiveAutoEditBatchFailedTasks?.(),
                send_to_hedra: () => window.sendAutoEditMatchedProblemGenerationToHedra?.({ autoStart }),
                send_current_task_to_hedra: () => window.sendAutoEditCurrentTaskProblemsToHedra?.({ autoStart }),
                send_segment_to_hedra: () => window.sendAutoEditSegmentGenerationToHedra?.(
                    Number(params.reviewIndex ?? 0),
                    params.batchTaskIndex !== undefined && params.batchTaskIndex !== null ? Number(params.batchTaskIndex) : null,
                    String(params.source || ''),
                    { autoStart }
                ),
                send_rows_to_hedra: () => window.sendAutoEditGenerationRowsToHedra?.(Array.isArray(params.records) ? params.records : [], { autoStart }),
                select_all: () => window.selectAllAutoEditBatchTasks?.(),
                deselect_all: () => window.deselectAllAutoEditBatchTasks?.(),
                select_passed: () => window.selectAutoEditBatchPassedTasks?.(),
                select_failed: () => window.selectAutoEditBatchFailedTasks?.(),
                select_unexported: () => window.selectAutoEditBatchUnexportedTasks?.(),
                clear_tasks: () => window.clearAutoEditBatchTasks?.(),
                open_issue_review: () => window.openAutoEditBatchIssueReview?.(),
            };
            const fn = map[action];
            if (!fn) throw new Error(`未知 autoedit_action：${action}`);
            const res = await fn();
            return { ok: true, action, result: res ?? null, status: getAutoEditStatus() };
        },

        async visual_review_query() {
            const rootEl = document.querySelector('#media-visualreview-subtab, [id*="visual-review"]');
            const cards = document.querySelectorAll('.vr-card, [data-vr-card]');
            return {
                mounted: Boolean(rootEl),
                visibleCards: cards.length,
                reportVisible: Boolean(document.querySelector('.vr-report-modal')),
            };
        },

        async visual_review_action(params = {}) {
            const action = String(params.action || '');
            const map = {
                refresh: () => window.visualReviewRefreshCurrentFolder?.(),
                save: () => window.visualReviewSave?.(),
                move_rejects: () => window.visualReviewMoveRejects?.(),
                move_images: () => window.visualReviewMoveImages?.(),
                send_to_hedra: () => window.sendVisualReviewIssuesToHedra?.(),
                show_report: () => window.showVisualReviewReport?.(),
            };
            if (!map[action]) throw new Error(`未知 visual_review_action：${action}`);
            await map[action]();
            return { ok: true, action };
        },

        async voiceover_query() {
            return getVoiceoverStatus();
        },

        async voiceover_action(params = {}) {
            const action = String(params.action || '');
            if (params.outputDir) {
                const out = document.getElementById('vw-output-dir');
                if (out) { out.value = String(params.outputDir); out.dispatchEvent(new Event('change')); }
            }
            if (action === 'start') {
                if (typeof window.startVoiceoverWorkflow !== 'function') throw new Error('startVoiceoverWorkflow 未加载');
                window.startVoiceoverWorkflow();
                return { started: true };
            }
            if (action === 'pause') {
                window.pauseVoiceoverWorkflow?.();
                return { paused: true };
            }
            if (action === 'restart_all') {
                window.restartAllVoiceoverWorkflow?.();
                return { started: true };
            }
            if (action === 'retry_failed_subtitles') {
                window.retryAllVWSubtitles?.();
                return { started: true };
            }
            if (action === 'clear') {
                window.vwClearAll?.();
                return { cleared: true };
            }
            throw new Error(`未知 voiceover_action：${action}`);
        },

        async tts_query(params = {}) {
            return getTtsQueueStatus(String(params.provider || 'all'));
        },

        async tts_action(params = {}) {
            const provider = String(params.provider || 'microsoft');
            const action = String(params.action || '');
            const prefix = provider === 'google' ? 'gg' : provider === 'microsoft' ? 'ms' : 'tts-batch';
            if (provider === 'microsoft' || provider === 'google') {
                if (params.outputDir) {
                    const out = document.getElementById(`${prefix}-output`);
                    if (out) { out.value = String(params.outputDir); out.dispatchEvent(new Event('input')); }
                }
                if (params.text && action === 'tts_batch_add') {
                    const area = document.getElementById(`${prefix}-text`);
                    if (area) { area.value = String(params.text); area.dispatchEvent(new Event('input')); }
                    document.getElementById(`${prefix}-add`)?.click();
                    return getTtsQueueStatus(provider);
                }
                const btnMap = {
                    tts_batch_start: `${prefix}-start`,
                    create_zip: `${prefix}-create-zip`,
                    clear_queue: `${prefix}-clear`,
                    refresh_voices: `${prefix}-refresh`,
                };
                const btnId = btnMap[action];
                if (!btnId) throw new Error(`未知 ${provider} 操作：${action}`);
                document.getElementById(btnId)?.click();
                return { ok: true, provider, action, status: getTtsQueueStatus(provider) };
            }
            if (provider === 'elevenlabs') {
                const btnMap = {
                    tts_batch_start: 'tts-batch-generate',
                    clear_queue: 'tts-batch-clear',
                };
                const btnId = btnMap[action];
                if (!btnId) throw new Error(`未知 elevenlabs 队列操作：${action}`);
                document.getElementById(btnId)?.click();
                return { ok: true, provider, action };
            }
            throw new Error(`未知配音平台：${provider}`);
        },

        async subtitle_query() {
            const srcLen = (document.getElementById('source-text')?.value || '').length;
            const transLen = (document.getElementById('translate-text')?.value || '').length;
            const batchRows = document.querySelectorAll('#subtitle-batch-list tr, #subtitle-batch-list .batch-item').length;
            const langText = document.getElementById('subtitle-lang-picker-btn')?.textContent?.trim() || '';
            return { sourceTextLength: srcLen, translateTextLength: transLen, batchCount: batchRows, language: langText };
        },

        async subtitle_action(params = {}) {
            if (params.action === 'start') {
                window.startGeneration?.();
                return { started: true };
            }
            if (params.action === 'clear_batch') {
                window.clearSubtitleBatchList?.();
                return { cleared: true };
            }
            throw new Error(`未知 subtitle_action：${params.action}`);
        },

        async download_query() {
            return getDownloadStatus();
        },

        async download_action(params = {}) {
            const action = String(params.action || '');
            if (action === 'gdrive_download') {
                if (params.links) {
                    const input = document.getElementById('gdrive-links-input');
                    if (input) { input.value = String(params.links); input.dispatchEvent(new Event('input')); }
                    if (typeof window.parseGDriveInput === 'function') await window.parseGDriveInput();
                }
                if (params.outputDir) {
                    const dir = document.getElementById('gdrive-download-dir');
                    if (dir) { dir.value = String(params.outputDir); dir.dispatchEvent(new Event('change')); }
                }
                if (typeof window.startGDriveDownload === 'function') window.startGDriveDownload();
                return { started: true, action };
            }
            if (action === 'send_downloaded_to') {
                const dest = String(params.target || 'reels');
                if (dest === 'reels') window.batchImportGDriveToReels?.();
                else if (dest === 'visual_review') window.batchImportGDriveToVisualReview?.();
                else if (dest === 'batch_rename') window.batchImportGDriveToBatchRename?.();
                else throw new Error(`未知导入目标：${dest}（支持 reels / visual_review / batch_rename）`);
                return { ok: true, target: dest };
            }
            if (action === 'clear_tasks') {
                window.clearGDriveTasks?.();
                return { cleared: true };
            }
            throw new Error(`未知 download_action：${action}`);
        },

        async media_query() {
            return {
                active: getActiveTabInfo(),
                audioMatchReady: Boolean(document.getElementById('am-btn-analyze')),
            };
        },

        async rename_match_query(params = {}) {
            const action = String(params.action || 'speech_status');
            if (action === 'speech_status') {
                const statusText = document.getElementById('sr-status')?.textContent?.trim() || '';
                const rows = document.querySelectorAll('#sr-list tbody tr').length;
                return { statusText, rowCount: rows };
            }
            if (action === 'name_match') {
                if (!window.NameMatching?.matchNames) throw new Error('NameMatching 核心未加载');
                const original = String(params.original || document.getElementById('nm-original')?.value || '');
                const canonical = String(params.canonical || document.getElementById('nm-canonical')?.value || '');
                const rows = window.NameMatching.matchNames(original, canonical);
                return { count: rows.length, rows };
            }
            if (action === 'name_match_csv') {
                if (!window.NameMatching?.exportTable) throw new Error('NameMatching 导出未加载');
                const saved = readJsonLocalStorage('videokit-name-matching-v1', {});
                const rows = Array.isArray(saved?.rows) ? saved.rows : [];
                return { csv: window.NameMatching.exportTable(rows, 'csv', params.includeHeader !== false) };
            }
            throw new Error(`未知 rename_match_query：${action}`);
        },

        async multiwindow_query() {
            const panel = document.getElementById('sort-upload-panel');
            if (!panel) return { mounted: false };
            const copyBtn = document.getElementById('su-local-copy');
            const moveBtn = document.getElementById('su-local-move');
            const uploadBtn = document.getElementById('su-start-upload');
            return {
                mounted: true,
                copyButtonText: copyBtn?.textContent?.trim() || '',
                moveButtonText: moveBtn?.textContent?.trim() || '',
                uploadButtonText: uploadBtn?.textContent?.trim() || '',
            };
        },

        async multiwindow_action(params = {}) {
            const action = String(params.action || '');
            if (action === 'multiwindow_execute') {
                const mode = params.mode === 'move' ? 'su-local-move' : 'su-local-copy';
                document.getElementById(mode)?.click();
                return { ok: true, mode };
            }
            if (action === 'multiwindow_upload') {
                document.getElementById('su-start-upload')?.click();
                return { ok: true };
            }
            if (action === 'merge_apply') {
                window.folderMergeApply?.();
                return { ok: true };
            }
            if (action === 'flatten_apply') {
                window.flatCollectApply?.();
                return { ok: true };
            }
            throw new Error(`未知 multiwindow_action：${action}`);
        },

        async phone_cards_query() {
            return getPhoneCardsStatus();
        },

        async phone_cards_action(params = {}) {
            const panel = document.getElementById('phone-cards-panel');
            if (!panel) throw new Error('电话卡片面板未挂载');
            const action = String(params.action || '');
            if (action === 'random_assign') {
                if (Number(params.count) > 0) {
                    const input = panel.querySelector('[data-random-count]');
                    if (input) input.value = String(Number(params.count));
                }
                if (params.target) {
                    const sel = panel.querySelector('[data-random-target]');
                    if (sel) sel.value = String(params.target);
                }
                panel.querySelector('[data-random-assign]')?.click();
                return getPhoneCardsStatus();
            }
            if (action === 'export') {
                if (params.outputDir) {
                    const out = panel.querySelector('[data-output-dir]');
                    if (out) out.value = String(params.outputDir);
                }
                panel.querySelector('[data-export]')?.click();
                return { started: true, status: getPhoneCardsStatus() };
            }
            if (action === 'clear_rows') {
                panel.querySelector('[data-clear-rows]')?.click();
                return getPhoneCardsStatus();
            }
            if (action === 'delete_styles') {
                panel.querySelector(params.all ? '[data-clear-library]' : '[data-delete-selected]')?.click();
                return getPhoneCardsStatus();
            }
            throw new Error(`未知 phone_cards_action：${action}`);
        },

        async settings_query() {
            return {
                theme: localStorage.getItem('videokit_theme') || 'dark',
                zoomFactor: window.electronAPI.getZoomFactor ? window.electronAPI.getZoomFactor() : 1,
                defaultOutputDir: localStorage.getItem('videokit_default_output_dir') || '',
            };
        },

        async settings_action(params = {}) {
            if (params.action === 'update_output_dir') {
                const dir = String(params.outputDir || '');
                localStorage.setItem('videokit_default_output_dir', dir);
                const el = document.getElementById('settings-default-output-dir');
                if (el) el.value = dir;
                return { ok: true, defaultOutputDir: dir };
            }
            if (params.action === 'update_theme_scale') {
                if (params.theme && typeof window.applyTheme === 'function') window.applyTheme(String(params.theme));
                if (Number(params.scale) >= 80 && Number(params.scale) <= 150 && typeof window.applyUIScale === 'function') {
                    window.applyUIScale(Number(params.scale));
                }
                return {
                    ok: true,
                    theme: localStorage.getItem('videokit_theme') || 'dark',
                    zoomFactor: window.electronAPI.getZoomFactor ? window.electronAPI.getZoomFactor() : 1,
                };
            }
            throw new Error(`未知 settings_action：${params.action}`);
        },

        async renderer_inspect(params = {}) {
            if (params.selector) {
                const nodes = Array.from(document.querySelectorAll(String(params.selector))).slice(0, 50);
                return {
                    selector: params.selector,
                    count: nodes.length,
                    elements: nodes.map((el) => ({
                        tag: el.tagName.toLowerCase(),
                        id: el.id || undefined,
                        className: typeof el.className === 'string' ? el.className.slice(0, 120) : undefined,
                        text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160),
                        value: 'value' in el && el.type !== 'password' ? String(el.value || '').slice(0, 160) : undefined,
                        checked: 'checked' in el ? Boolean(el.checked) : undefined,
                        disabled: 'disabled' in el ? Boolean(el.disabled) : undefined,
                    })),
                };
            }
            return { active: getActiveTabInfo() };
        },
    };

    // ==================== 4. 注册 IPC 监听与初始化 ====================

    if (typeof window.electronAPI.onAiApiRequest === 'function') {
        window.electronAPI.onAiApiRequest(async (req) => {
            const action = String(req?.action || '');
            const handler = Object.prototype.hasOwnProperty.call(rendererHandlers, action) ? rendererHandlers[action] : null;
            if (typeof handler !== 'function') {
                throw new Error(`渲染进程不支持的 AI 动作：${action}`);
            }
            return handler(req?.params || {});
        });
    }

    window.__videokitAiBridge = {
        openLogModal,
        handlers: rendererHandlers,
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', mountTitlebarToggle, { once: true });
    } else {
        mountTitlebarToggle();
    }
})();
