#!/usr/bin/env node
/**
 * VideoKit Studio · AI 工具桥（MCP stdio 服务）
 * 把 VideoKit 主进程里的「本机 AI 操作接口」包装成 Antigravity 可直接调用的中文工具。
 *
 * 用法（~/.gemini/config/mcp_config.json）：
 *   "videokit": {
 *     "command": "node",
 *     "args": ["<path-to-VideoKit>/scripts/videokit-ai-mcp.cjs"],
 *     "env": { "VIDEOKIT_USERDATA": "<path-to-VideoKit-userData>" }
 *   }
 *
 * 口令与端口从 VideoKit 的 <userData>/ai-api.json 读取（软件首次启动自动生成），
 * 并自动参考 ~/.videokit/ai-api-discovery.json 以同时兼容开发版、正式打包版与自定义缓存目录。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

function isPidAlive(pid) {
    const n = Number(pid);
    if (!Number.isInteger(n) || n <= 0) return false;
    try {
        process.kill(n, 0);
        return true;
    } catch (err) {
        return err && err.code === 'EPERM';
    }
}

function candidateUserDataDirs() {
    const dirs = [];
    const add = (d) => {
        if (!d) return;
        const resolved = path.resolve(String(d));
        if (!dirs.includes(resolved)) dirs.push(resolved);
    };

    // 1. 优先读取活跃运行实例写出的目录指针（不含口令）
    try {
        const discoveryFile = path.join(os.homedir(), '.videokit', 'ai-api-discovery.json');
        if (fs.existsSync(discoveryFile)) {
            const info = JSON.parse(fs.readFileSync(discoveryFile, 'utf8'));
            if (info?.userDataDir && isPidAlive(info.pid)) {
                add(info.userDataDir);
            }
        }
    } catch (_) { }

    // 2. 环境变量显式指定
    if (process.env.VIDEOKIT_USERDATA) add(process.env.VIDEOKIT_USERDATA);

    // 3. 常见平台默认 userData 目录（同时兼容正式版 VideoKit 与开发版 videokit）
    const home = os.homedir();
    if (process.platform === 'darwin') {
        add(path.join(home, 'Library', 'Application Support', 'VideoKit'));
        add(path.join(home, 'Library', 'Application Support', 'videokit'));
    } else if (process.platform === 'win32') {
        const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
        add(path.join(appData, 'VideoKit'));
        add(path.join(appData, 'videokit'));
    } else {
        add(path.join(home, '.config', 'VideoKit'));
        add(path.join(home, '.config', 'videokit'));
    }

    // 4. 若 discovery 里的进程已退，仍作为兜底目录尝试
    try {
        const discoveryFile = path.join(os.homedir(), '.videokit', 'ai-api-discovery.json');
        if (fs.existsSync(discoveryFile)) {
            const info = JSON.parse(fs.readFileSync(discoveryFile, 'utf8'));
            if (info?.userDataDir) add(info.userDataDir);
        }
    } catch (_) { }

    return dirs;
}

function loadCfg() {
    const dirs = candidateUserDataDirs();
    let lastErr = null;
    for (const dir of dirs) {
        const p = path.join(dir, 'ai-api.json');
        if (!fs.existsSync(p)) continue;
        try {
            const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
            if (cfg && cfg.port && cfg.token) {
                return { ...cfg, _configPath: p };
            }
        } catch (err) {
            lastErr = err;
        }
    }
    throw new Error(
        '找不到 VideoKit 的 ai-api.json，请先启动一次新版 VideoKit（开发版或重新打包后的正式版）。' +
        (lastErr ? `（${lastErr.message}）` : '')
    );
}

function callApi(name, body) {
    return new Promise((resolve, reject) => {
        let cfg;
        try {
            cfg = loadCfg();
        } catch (err) {
            reject(err);
            return;
        }
        const data = Buffer.from(JSON.stringify(body || {}));
        const req = http.request(
            {
                host: '127.0.0.1',
                port: cfg.port,
                path: '/api/' + name,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': data.length,
                    Authorization: 'Bearer ' + cfg.token,
                },
                timeout: 65000,
            },
            (res) => {
                let raw = '';
                res.on('data', (c) => (raw += c));
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(raw));
                    } catch (_) {
                        reject(new Error('接口返回无法解析：' + raw.slice(0, 200)));
                    }
                });
            }
        );
        req.on('timeout', () => req.destroy(new Error('请求 VideoKit 超时（65s）')));
        req.on('error', (err) => reject(new Error('连不上 VideoKit 软件（软件未打开，或请检查顶部「🤖 AI 操作」开关）：' + err.message)));
        req.end(data);
    });
}

const TOOLS = [
    {
        name: 'videokit_overview',
        description:
            'VideoKit 全局总览（只读）：查看软件版本、开发版/正式版模式、当前所在界面、是否有任务正在运行（批量 Reels 导出 / 文案自动剪辑 / 一键配音 / 微软谷歌配音 / 电话卡片 / 后台任务）、各核心工作台队列数量、模板库数量、缓存体积与最近崩溃诊断。',
        inputSchema: { type: 'object', properties: {} },
        api: 'overview',
    },
    {
        name: 'videokit_ui_navigate',
        description:
            '切换 VideoKit 界面与定位文件（无破坏性副作用）：切换顶部 11 个主标签页、切换媒体转换/SRT/下载/Reels 检查器子面板、将 VideoKit 窗口拉到前台（focus_window），或在访达/资源管理器中定位显示指定本地文件或文件夹（reveal_path / open_path）。',
        inputSchema: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['switch_tab', 'focus_window', 'reveal_path', 'open_path'],
                    description: '默认 switch_tab',
                },
                tab: {
                    type: 'string',
                    enum: [
                        'voiceover-workflow',
                        'elevenlabs',
                        'microsoft-tts',
                        'google-tts',
                        'subtitle',
                        'srt-tools',
                        'video-download',
                        'media',
                        'batch-reels',
                        'phone-cards',
                        'settings',
                    ],
                    description: '要切换的主标签页 ID',
                },
                subtab: {
                    type: 'string',
                    description: '子面板 ID（如 media-autoedit / media-visualreview / media-organizer / media-multiwindow / media-speechrename / media-namematching / dl-gdrive / srt-adjust 等）',
                },
                mediaMode: {
                    type: 'string',
                    description: '媒体转换左侧格式模式（如 h264 / x264 / mp3 / wav / audio_split / png / txt_wrap）',
                },
                inspectorTab: {
                    type: 'string',
                    enum: ['subtitle', 'overlay', 'watermark', 'background'],
                    description: '批量 Reels 右侧检查器标签',
                },
                path: { type: 'string', description: 'reveal_path / open_path 时的本地路径' },
            },
        },
        api: 'ui_navigate',
    },
    {
        name: 'videokit_job',
        description:
            '查看 VideoKit 后台长任务（视频转码、下载、自动剪辑、字幕识别、模板打包等）的实时状态、进度与结果。不传 jobId 则列出最近 20 个后台任务。',
        inputSchema: {
            type: 'object',
            properties: {
                jobId: { type: 'string', description: '后台任务 ID（可选）' },
                limit: { type: 'number', description: '不传 jobId 时最多返回条数，默认 20' },
            },
        },
        api: 'job',
    },
    {
        name: 'videokit_confirm',
        description:
            '统一两步确认执行入口（第二步）：当预览类操作返回 previewOnly: true 和 confirmToken 后，必须先将完整预览清单、输出路径和风险提示给用户看；只有在用户明确同意后才能调用本工具正式执行！没有用户明确同意绝不要调用。',
        inputSchema: {
            type: 'object',
            properties: {
                confirmToken: { type: 'string', description: '第一步预览返回的 confirmToken（10 分钟内有效，一次性消费）' },
            },
            required: ['confirmToken'],
        },
        api: 'confirm',
    },
    {
        name: 'videokit_stop_task',
        description:
            '安全急停当前正在运行的任务（可直接调用）：支持停止全部（all）、批量 Reels 导出（reels_export）、文案自动剪辑（autoedit）、一键配音（voiceover_workflow）、微软/谷歌配音（microsoft_tts / google_tts）、Google Drive 下载（gdrive_download）、电话卡片导出（phone_cards）或指定后台 jobId。',
        inputSchema: {
            type: 'object',
            properties: {
                target: {
                    type: 'string',
                    enum: ['all', 'reels_export', 'autoedit', 'voiceover_workflow', 'microsoft_tts', 'google_tts', 'gdrive_download', 'phone_cards'],
                    description: '要停止的模块，默认 all',
                },
                jobId: { type: 'string', description: '仅停止某一个后台 jobId（可选）' },
            },
        },
        api: 'stop_task',
    },
    {
        name: 'videokit_reels_query',
        description:
            '只读查询「🎬 批量 Reels」工作台全量状态：工程与队列总览（summary）、筛选任务列表（tasks，支持序号范围/分组/勾选/缺素材筛选）、单条任务完整详情（task_detail，含字幕/覆层/水印/路径）、预设列表（presets）、个人预设库统计（preset_library_info）、大量制作草稿（bulk_create）、背景库/电话人物库/已用批次只读查询（background_library / media_library / used_batches）、会话自动备份列表（autosaves）、排版纯文字说明（layout_description）。',
        inputSchema: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: [
                        'summary',
                        'tasks',
                        'task_detail',
                        'presets',
                        'preset_library_info',
                        'bulk_create',
                        'background_library',
                        'media_library',
                        'used_batches',
                        'autosaves',
                        'layout_description',
                    ],
                },
                range: { type: 'string', description: '任务序号范围，如 "1-20"、"3,5,8"' },
                group: { type: 'string', description: '按队列/分组名筛选（包含即可）' },
                selectedOnly: { type: 'boolean', description: '仅看已勾选导出的任务' },
                missingOnly: { type: 'boolean', description: '仅看缺失素材的任务' },
                index: { type: 'number', description: 'task_detail 时的任务序号（从 1 开始）' },
                taskId: { type: 'string', description: 'task_detail 时的任务 ID' },
                subAction: { type: 'string', description: '查询素材库/已用批次时的只读子动作，默认 list' },
                params: { type: 'object', description: '附加查询参数' },
                limit: { type: 'number', description: '最多返回条数，默认 100' },
            },
        },
        api: 'reels_query',
    },
    {
        name: 'videokit_reels_edit',
        description:
            '编排与修改「🎬 批量 Reels」任务：轻量无损界面切换（select_task / select_all / invert_selection / select_first_n / open_overview / close_overview / toggle_batch_table / undo / redo）可直接执行；其余批量改动、导入文件夹、套用预设、修改覆层文字、SRT 重分段/对齐、保存加载工程、Gemini 批量处理文案（ai_process_scripts）及删除清空任务均走预览 + videokit_confirm（或破坏性操作传 confirm:true）。',
        inputSchema: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: [
                        'select_task',
                        'select_all',
                        'invert_selection',
                        'select_first_n',
                        'open_overview',
                        'close_overview',
                        'toggle_batch_table',
                        'open_bulk_create',
                        'open_layout_batch',
                        'undo',
                        'redo',
                        'import_folders',
                        'auto_match',
                        'duplicate_selected',
                        'group_selected',
                        'delete_selected_tasks',
                        'clear_tasks',
                        'set_work_mode',
                        'set_karaoke',
                        'apply_subtitle_preset',
                        'apply_animation_preset',
                        'apply_crop_preset',
                        'update_overlay_text',
                        'resegment_srt',
                        'merge_short_srt',
                        'align_all_tasks',
                        'relocate_media',
                        'save_project',
                        'load_project',
                        'recover_autoedit_last',
                        'ai_process_scripts',
                    ],
                },
                index: { type: 'number', description: '目标任务序号（从 1 开始）' },
                checked: { type: 'boolean' },
                count: { type: 'number' },
                mode: { type: 'string' },
                enabled: { type: 'boolean' },
                preset: { type: 'string' },
                folders: { type: 'array', items: { type: 'string' } },
                scripts: { type: 'array', items: { type: 'string' }, description: 'ai_process_scripts 的文案列表' },
                overlayId: { type: 'string' },
                slot: { type: 'string' },
                name: { type: 'string' },
                text: { type: 'string' },
                searchDir: { type: 'string' },
                outputPath: { type: 'string' },
                projectPath: { type: 'string' },
                confirm: { type: 'boolean', description: '删除/清空等破坏性操作经用户确认后可传 true' },
            },
            required: ['action'],
        },
        api: 'reels_edit',
    },
    {
        name: 'videokit_reels_export',
        description:
            '批量 Reels 导出（第一步只预览，强制两步确认）：检查已勾选任务数、输出目录、渲染引擎（wysiwyg / turbo / parallel / burn / fcpxml / layered_png / package_only / install_resolve_script）及缺失素材告警，返回 confirmToken；把预览清单给用户确认后再调 videokit_confirm 正式启动导出。',
        inputSchema: {
            type: 'object',
            properties: {
                mode: {
                    type: 'string',
                    enum: ['wysiwyg', 'turbo', 'parallel', 'burn', 'fcpxml', 'layered_png', 'package_only', 'install_resolve_script'],
                    description: '导出引擎或模式，默认 wysiwyg',
                },
                outputDir: { type: 'string', description: '可选：覆盖指定本次输出目录' },
                params: { type: 'object' },
            },
        },
        api: 'reels_export',
    },
    {
        name: 'videokit_templates',
        description:
            '视频模板库与个人预设库：查列表(list)、看详情(get)、看历史版本(versions)、看分类配置(library_config)、看预设库信息(preset_library_info)、估算合集包大小(estimate_collection)、新窗口打开模板(open_window)可直接调用；重命名、改分类、恢复版本、删除、导入导出合集包、导出 AI Skill（export_skill）与恢复隐藏预设需经确认。',
        inputSchema: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: [
                        'list',
                        'get',
                        'versions',
                        'library_config',
                        'preset_library_info',
                        'estimate_collection',
                        'open_window',
                        'open_library',
                        'rename',
                        'classify',
                        'restore_version',
                        'delete',
                        'save_library_config',
                        'export_collection',
                        'import_collection',
                        'export_skill',
                        'unhide_preset_library',
                    ],
                },
                id: { type: 'string', description: '模板 ID' },
                ids: { type: 'array', items: { type: 'string' } },
                query: { type: 'string', description: 'list 搜索关键词' },
                category: { type: 'string' },
                categories: { type: 'array', items: { type: 'string' } },
                name: { type: 'string' },
                newName: { type: 'string' },
                revision: { type: 'string' },
                outputPath: { type: 'string' },
                filePath: { type: 'string' },
                limit: { type: 'number' },
                params: { type: 'object' },
                confirm: { type: 'boolean' },
            },
            required: ['action'],
        },
        api: 'templates',
    },
    {
        name: 'videokit_autoedit',
        description:
            '文案自动剪辑（单套 + 批量工作台 + Hedra 双向联动）：查状态(status)、查 Hedra 实时连线状态与批次条数(hedra_status)、批量问题报告(batch_report)可直接调用；从 Hedra 拉取当前批次(pull_from_hedra)、重试接收上次 Hedra 推送(retry_hedra_import)、将全部问题任务/当前任务/指定片段/自定义行发回 Hedra 立即重跑或标待重跑(send_to_hedra / send_current_task_to_hedra / send_segment_to_hedra / send_rows_to_hedra)、单套/批量分析(analyze / headless_run)、自动断行(auto_break)、智能配对(smart_pair)、正式导出(export / export_only / export_project)、送入 Reels(send_to_reels)、归档文件夹(archive_selected / archive_failed)、片段重识别/排除/恢复/替换/重命名与清缓存均走两步确认。',
        inputSchema: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: [
                        'status',
                        'hedra_status',
                        'batch_report',
                        'set_mode',
                        'auto_break',
                        'smart_pair',
                        'pull_from_hedra',
                        'retry_hedra_import',
                        'analyze',
                        'headless_run',
                        'export',
                        'export_only',
                        'export_project',
                        'send_to_reels',
                        'archive_selected',
                        'archive_failed',
                        'send_to_hedra',
                        'send_current_task_to_hedra',
                        'send_segment_to_hedra',
                        'send_rows_to_hedra',
                        'select_all',
                        'deselect_all',
                        'select_passed',
                        'select_failed',
                        'select_unexported',
                        'open_issue_review',
                        'retranscribe_clip',
                        'replace_clip',
                        'partial_replace_clip',
                        'move_clip_excluded',
                        'restore_clip_excluded',
                        'rename_original_clips',
                        'clear_tasks',
                        'clear_clip_cache',
                    ],
                },
                mode: { type: 'string', enum: ['single', 'batch'] },
                clips: { type: 'array', items: { type: 'string' }, description: 'headless_run 时的视频片段路径列表' },
                scriptText: { type: 'string', description: 'headless_run 时的断行文案' },
                outputDir: { type: 'string' },
                language: { type: 'string' },
                analysisOnly: { type: 'boolean' },
                forceReanalysis: { type: 'boolean' },
                forceExport: { type: 'boolean' },
                autoStart: { type: 'boolean', description: '发回 Hedra 时 true=立即重跑，false=仅标待重跑（默认 false）' },
                reviewIndex: { type: 'number', description: 'send_segment_to_hedra 时的片段索引' },
                batchTaskIndex: { type: 'number', description: 'send_segment_to_hedra 时的批量任务索引（可选）' },
                source: { type: 'string', description: 'send_segment_to_hedra 时的片段源路径（可选）' },
                records: { type: 'array', items: { type: 'object' }, description: 'send_rows_to_hedra 的生成资料行数组' },
                options: { type: 'object' },
                params: { type: 'object' },
                confirm: { type: 'boolean' },
            },
            required: ['action'],
        },
        api: 'autoedit',
    },
    {
        name: 'videokit_visual_review',
        description:
            '素材快速审核：查审核面板状态(status)可直接调用；刷新目录(refresh)、保存审核记录(save)、移动淘汰素材(move_rejects)、移动图片(move_images)、将问题发回 Hedra(send_to_hedra)、展示报告(show_report)走两步确认。',
        inputSchema: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['status', 'refresh', 'save', 'move_rejects', 'move_images', 'send_to_hedra', 'show_report'],
                },
            },
            required: ['action'],
        },
        api: 'visual_review',
    },
    {
        name: 'videokit_voiceover_workflow',
        description:
            '🚀 一键配音字幕（Tab 1）：查当前队列与进度(status)、查 ElevenLabs 可用音色(voices)、暂停队列(pause)可直接调用；启动生成(start)、全部重跑(restart_all)、重试失败字幕(retry_failed_subtitles)、清空任务(clear)走两步确认。',
        inputSchema: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['status', 'voices', 'pause', 'start', 'restart_all', 'retry_failed_subtitles', 'clear'],
                },
                outputDir: { type: 'string' },
                keyIndex: { type: 'number' },
            },
            required: ['action'],
        },
        api: 'voiceover_workflow',
    },
    {
        name: 'videokit_tts_studio',
        description:
            '配音工坊总控（覆盖 ElevenLabs / Voice Studio / 微软 Edge TTS / 谷歌配音 Gemini TTS）：查音色(voices)、搜音色(search_voices)、查额度与测试 Key(quotas)、查队列进度(queue_status)、查 Voice Studio 快照(voice_studio_snapshot)与停止生产(vs_stop)可直接调用；单条/批量生成语音、生成音效(sfx)、打包 ZIP、启停 Key、Voice Studio 生成候选/保存/预分配/启动批量生产与清空队列走两步确认。',
        inputSchema: {
            type: 'object',
            properties: {
                provider: {
                    type: 'string',
                    enum: ['elevenlabs', 'microsoft', 'google', 'all'],
                    description: '配音平台，默认 elevenlabs',
                },
                action: {
                    type: 'string',
                    enum: [
                        'voices',
                        'search_voices',
                        'quotas',
                        'queue_status',
                        'voice_studio_snapshot',
                        'tts_single',
                        'tts_batch_add',
                        'tts_batch_start',
                        'sfx',
                        'create_zip',
                        'toggle_key',
                        'clear_queue',
                        'vs_sync_voices',
                        'vs_put_designs',
                        'vs_generate',
                        'vs_save_candidate',
                        'vs_forget_design',
                        'vs_plan',
                        'vs_start',
                        'vs_stop',
                    ],
                },
                text: { type: 'string' },
                voiceId: { type: 'string' },
                modelId: { type: 'string' },
                outputPath: { type: 'string' },
                outputDir: { type: 'string' },
                fileName: { type: 'string' },
                query: { type: 'string' },
                keyIndex: { type: 'number' },
                enabled: { type: 'boolean' },
                all: { type: 'boolean' },
                includeBalances: { type: 'boolean' },
                durationSeconds: { type: 'number' },
                rate: { type: 'string' },
                pitch: { type: 'string' },
                style: { type: 'string' },
                jobId: { type: 'string' },
                params: { type: 'object' },
            },
            required: ['action'],
        },
        api: 'tts_studio',
    },
    {
        name: 'videokit_subtitle_align',
        description:
            '字幕对齐（Tab 5）：查支持语种(languages)、查切片识别耗时记录(records)、查面板状态(status)可直接调用；启动单文件识别对齐(generate)、触发面板生成(start)、清理识别缓存(clear_cache)或清空记录(clear_records)需经确认。',
        inputSchema: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['status', 'languages', 'records', 'generate', 'start', 'clear_batch', 'clear_cache', 'clear_records'],
                },
                audioPath: { type: 'string', description: '待识别对齐的音视频路径' },
                sourceText: { type: 'string', description: '原文断行文案' },
                translateText: { type: 'string', description: '译文文案（可选）' },
                language: { type: 'string', description: '识别语种，如 英语 / 中文' },
                outputDir: { type: 'string' },
                exportFcpxml: { type: 'boolean' },
                seamlessFcpxml: { type: 'boolean' },
                options: { type: 'object' },
                confirm: { type: 'boolean' },
            },
            required: ['action'],
        },
        api: 'subtitle_align',
    },
    {
        name: 'videokit_srt_tools',
        description:
            'SRT 工具（Tab 6）与 TXT 工具：测算单字符时长(compute_char_time)、TXT 智能断行预览(txt_wrap_preview)可直接调用；SRT 时间轴重分配写出(adjust)、生成无缝字幕(seamless)、批量导出编号 TXT(batch_txt_export)走两步确认。',
        inputSchema: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['compute_char_time', 'txt_wrap_preview', 'adjust', 'seamless', 'batch_txt_export'],
                },
                srtPath: { type: 'string' },
                srcSrt: { type: 'string' },
                orgiSrt: { type: 'string' },
                refSrt: { type: 'string' },
                outputPath: { type: 'string' },
                outputDir: { type: 'string' },
                text: { type: 'string' },
                texts: { type: 'array', items: { type: 'string' } },
                maxChars: { type: 'number' },
                startNumber: { type: 'number' },
                padDigits: { type: 'number' },
                prefix: { type: 'string' },
                excludeChars: { type: 'string' },
                params: { type: 'object' },
            },
            required: ['action'],
        },
        api: 'srt_tools',
    },
    {
        name: 'videokit_download',
        description:
            '下载工具（Tab 7，含 yt-dlp 视频下载与 Google Drive 批量文件夹下载）：解析视频链接画质时长(analyze_url)、解析 Google Drive 链接清单(gdrive_parse)、查看下载队列状态(gdrive_status)可直接调用；启动单链接/批量链接/GDrive 下载、将已下载素材批量导入到 Reels / 素材审核 / 批量重命名以及清空清单均走两步确认。',
        inputSchema: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['analyze_url', 'gdrive_parse', 'gdrive_status', 'download_single', 'download_batch', 'gdrive_download', 'send_downloaded_to', 'clear_tasks'],
                },
                url: { type: 'string' },
                urls: { type: 'array', items: { type: 'string' } },
                links: { type: 'string', description: 'Google Drive 链接多行文本' },
                outputDir: { type: 'string' },
                format: { type: 'string' },
                quality: { type: 'string' },
                target: { type: 'string', enum: ['reels', 'visual_review', 'batch_rename'], description: 'send_downloaded_to 的目标模块' },
                options: { type: 'object' },
            },
            required: ['action'],
        },
        api: 'download',
    },
    {
        name: 'videokit_media_convert',
        description:
            '媒体转换、音频处理与水印（Tab 8）：查媒体编码/分辨率/时长(media_info)、静音检测(detect_silence)、智能分割点分析(smart_split_analyze)、音频波形(waveform)、音频匹配状态(audio_match_analyze)可直接调用；视频/图片/音频转码压缩、裁切(trim)、拼接(concat_clips)、音频替换(replace_audio)、智能分割(smart_split)、Logo/文字水印与等待播放预处理均走两步确认（并在后台运行返回 jobId）。',
        inputSchema: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: [
                        'media_info',
                        'detect_silence',
                        'smart_split_analyze',
                        'waveform',
                        'audio_match_analyze',
                        'convert',
                        'trim',
                        'concat_clips',
                        'replace_audio',
                        'smart_split',
                        'prepare_playback_delay',
                    ],
                },
                mode: {
                    type: 'string',
                    description: 'convert 时的目标模式：h264 / x264 / dnxhr / dnxhr_hqx / mov / webm / gif / mp3 / wav / aac / flac / audio_black / audio_split / audio_fx / png / jpg / jpeg / logo / watermark',
                },
                filePath: { type: 'string' },
                files: { type: 'array', items: { type: 'string' } },
                audioPath: { type: 'string' },
                outputDir: { type: 'string' },
                noiseDb: { type: 'number' },
                minDuration: { type: 'number' },
                maxDuration: { type: 'number' },
                options: { type: 'object' },
            },
            required: ['action'],
        },
        api: 'media_convert',
    },
    {
        name: 'videokit_media_analyze_cut',
        description:
            '镜头分析、截图、画面聚类与批量剪辑（Tab 8）：场景切点检测(scene_detect)与状态查询(status)可直接调用；按场景切分视频(scene_split)、导出场景帧(scene_frames)、智能关键帧(smart_keyframes / download_and_detect_frames)、本地/链接批量截图(batch_thumbnail / url_thumbnail)、画面相似度聚类分类(image_classify)、按入出点批量剪辑与导出 FCPXML(batch_cut / batch_cut_fcpxml)均走两步确认。',
        inputSchema: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: [
                        'scene_detect',
                        'status',
                        'scene_split',
                        'scene_frames',
                        'smart_keyframes',
                        'download_and_detect_frames',
                        'batch_thumbnail',
                        'url_thumbnail',
                        'image_classify',
                        'batch_cut',
                        'batch_cut_fcpxml',
                    ],
                },
                filePath: { type: 'string' },
                folderPath: { type: 'string' },
                outputDir: { type: 'string' },
                threshold: { type: 'number' },
                minSceneLen: { type: 'number' },
                options: { type: 'object' },
            },
            required: ['action'],
        },
        api: 'media_analyze_cut',
    },
    {
        name: 'videokit_rename_match',
        description:
            '四大命名与匹配工具（Tab 8）：重命名新旧对照冲突预览(rename_preview)、语音匹配状态/文案匹配/差异对比(speech_status / speech_match / speech_compare)、名字智能匹配计算(name_match)可直接调用；统一命名(uni_rename)、批量重命名(batch_rename，默认复制模式)、语音匹配云端识别/翻译/应用改名(speech_analyze / speech_translate / speech_apply)及导出名字匹配 CSV(name_match_export)均走两步确认。',
        inputSchema: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: [
                        'rename_preview',
                        'uni_rename',
                        'batch_rename',
                        'speech_status',
                        'speech_match',
                        'speech_compare',
                        'speech_analyze',
                        'speech_translate',
                        'speech_apply',
                        'name_match',
                        'name_match_export',
                    ],
                },
                items: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            source: { type: 'string' },
                            newName: { type: 'string' },
                            targetDir: { type: 'string' },
                        },
                    },
                    description: '重命名映射列表',
                },
                copyMode: { type: 'boolean', description: 'true=复制并重命名保留原文件（默认），false=直接重命名原文件' },
                original: { type: 'string', description: 'name_match 原始名字多行文本' },
                canonical: { type: 'string', description: 'name_match 正规名字多行文本' },
                outputPath: { type: 'string' },
                includeHeader: { type: 'boolean' },
                params: { type: 'object' },
            },
            required: ['action'],
        },
        api: 'rename_match',
    },
    {
        name: 'videokit_file_organizer',
        description:
            '素材整理、目录扫描、查重与多窗口整理（Tab 8）：目录扫描(scan_dir)、提取文件名清单(extract_filenames)、按内容 MD5 查找重复文件(find_duplicates)、规则整理预览(organize_preview)、多窗口整理状态(multiwindow_status)可直接调用；执行规则整理移动/撤销(organize_apply / organize_undo)、文件夹合并/平铺归集(merge_apply / flatten_apply)、多窗口按分配复制/移动/上传(multiwindow_execute / multiwindow_upload)、批量复制/移动/新建目录、去重与移入废纸篓(remove_duplicates / trash_files)均走两步确认。',
        inputSchema: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: [
                        'scan_dir',
                        'extract_filenames',
                        'find_duplicates',
                        'organize_preview',
                        'organize_apply',
                        'organize_undo',
                        'multiwindow_status',
                        'multiwindow_execute',
                        'multiwindow_upload',
                        'merge_apply',
                        'flatten_apply',
                        'copy_files',
                        'move_files',
                        'create_folder',
                        'remove_duplicates',
                        'trash_files',
                    ],
                },
                dirPath: { type: 'string' },
                recursive: { type: 'boolean' },
                stripExt: { type: 'boolean' },
                maxDepth: { type: 'number' },
                limit: { type: 'number' },
                exts: { type: 'array', items: { type: 'string' } },
                filePaths: { type: 'array', items: { type: 'string' } },
                targetDir: { type: 'string' },
                parentDir: { type: 'string' },
                folderName: { type: 'string' },
                mode: { type: 'string', enum: ['copy', 'move'] },
                params: { type: 'object' },
                confirm: { type: 'boolean' },
            },
            required: ['action'],
        },
        api: 'file_organizer',
    },
    {
        name: 'videokit_phone_cards',
        description:
            '☎️ 电话卡片工坊（Tab 10）：查询样式库数量、表格行数与导出状态(status)可直接调用；按勾选模板随机分配(random_assign)、批量导出 1080×1920 透明 PNG(export)、删除样式(delete_styles)或清空表格(clear_rows)走两步确认。',
        inputSchema: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['status', 'random_assign', 'export', 'delete_styles', 'clear_rows'],
                },
                count: { type: 'number', description: '每行随机分配的模板数' },
                target: { type: 'string', enum: ['all', 'unassigned', 'current'] },
                outputDir: { type: 'string' },
                all: { type: 'boolean' },
                confirm: { type: 'boolean' },
            },
            required: ['action'],
        },
        api: 'phone_cards',
    },
    {
        name: 'videokit_settings',
        description:
            '软件设置、缓存与诊断（Tab 11，绝不泄露明文 API Key / Token）：查配置概览(overview)、查缓存占用明细(cache_info)、测试 API 连通性(test_keys)、查崩溃诊断(crash_diagnostic)、查软件运行日志(app_log)可直接调用；修改默认输出目录(update_output_dir)、修改转录平台/并发(update_transcription_providers)、修改翻译替换规则(update_replace_rules)、修改主题或缩放(update_theme_scale)、一键清理缓存(clear_cache)需经确认。',
        inputSchema: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: [
                        'overview',
                        'cache_info',
                        'test_keys',
                        'crash_diagnostic',
                        'app_log',
                        'clear_cache',
                        'update_output_dir',
                        'update_transcription_providers',
                        'update_replace_rules',
                        'update_theme_scale',
                    ],
                },
                target: { type: 'string', enum: ['all', 'gemini', 'google_tts', 'elevenlabs'] },
                lines: { type: 'number', description: 'app_log 读取行数，默认 60' },
                outputDir: { type: 'string' },
                primary: { type: 'string', enum: ['deepgram', 'groq', 'gladia'] },
                concurrency: { type: 'number' },
                rules: { type: 'object' },
                theme: { type: 'string' },
                scale: { type: 'number', description: '界面缩放百分比 80-150' },
                confirm: { type: 'boolean' },
            },
            required: ['action'],
        },
        api: 'settings',
    },
    {
        name: 'videokit_renderer_action',
        description:
            '受控通用检视与后端路由调用工具：mode="inspect" 可安全只读检视 DOM 元素或当前界面状态；mode="api_call" 强制走两步确认（返回 confirmToken，用户同意后调 videokit_confirm 执行），内置严格拦截一切密钥与登出凭据操作。',
        inputSchema: {
            type: 'object',
            properties: {
                mode: { type: 'string', enum: ['inspect', 'api_call'], description: '默认 inspect' },
                selector: { type: 'string', description: 'inspect 时的 CSS 选择器' },
                endpoint: { type: 'string', description: 'api_call 时的后端 apiRouter 路由名' },
                data: { type: 'object', description: 'api_call 的参数对象' },
                description: { type: 'string', description: '给人看的操作说明' },
            },
            required: ['mode'],
        },
        api: 'renderer_action',
    },
];

const INSTRUCTIONS = `你可以通过这些工具操控用户的「VideoKit Studio」音视频桌面软件（支持开发版与正式打包版，软件未打开或顶部「🤖 AI 操作」总开关关闭时工具不可用）。
- 先查再做：只读查询工具（总览、Reels 队列/详情、自动剪辑状态、配音队列与额度、模板库、媒体信息/静音/场景检测、目录扫描、查重、重命名预览、设置与缓存）可以按需直接调用。
- 严格遵守两步确认：所有真正执行任务、消耗外部付费 API（ElevenLabs / Gladia / Deepgram / Groq / Gemini）、渲染导出音视频、下载、改名/移动/删除文件或修改配置的操作，第一步调用会返回 previewOnly: true 与 confirmToken。拿到预览结果后，必须把受影响条数/文件名、输出目录与风险警告完整告诉用户；只有用户明确回复同意后，才调用 videokit_confirm 并带上 confirmToken 正式执行！绝不擅自确认。
- 后台长任务：转码、下载、自动剪辑、字幕对齐等耗时任务会在后台执行并返回 jobId，可用 videokit_job 查看实时进度和结果；批量 Reels 导出与配音队列也可通过 videokit_overview / videokit_reels_query 查进度。
- 随时可停：用户喊停时可直接调用 videokit_stop_task 停止当前运行任务。
- 隐私与安全：所有密钥与登录凭证均已脱敏拦截，绝不要尝试读取明文 API Key 或修改账号凭证。
- 用户在讨论其他项目或纯写代码问题、而非让你操控 VideoKit 时，不要调用这些工具。`;

function reply(id, result) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function replyError(id, code, message) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

async function handle(msg) {
    const { id, method, params } = msg;
    if (method === 'initialize') {
        return reply(id, {
            protocolVersion: params?.protocolVersion || '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'videokit-studio', version: '1.0.0' },
            instructions: INSTRUCTIONS,
        });
    }
    if (method === 'notifications/initialized' || (typeof method === 'string' && method.startsWith('notifications/'))) {
        return;
    }
    if (method === 'ping') return reply(id, {});
    if (method === 'tools/list') {
        return reply(id, { tools: TOOLS.map(({ api, ...tool }) => tool) });
    }
    if (method === 'tools/call') {
        const tool = TOOLS.find((t) => t.name === params?.name);
        if (!tool) return replyError(id, -32602, '没有这个工具：' + params?.name);
        try {
            const res = await callApi(tool.api, params?.arguments || {});
            const ok = Boolean(res && res.ok);
            const text = ok ? JSON.stringify(res.result, null, 1) : '出错：' + (res?.error || '未知错误');
            return reply(id, { content: [{ type: 'text', text }], isError: !ok });
        } catch (err) {
            return reply(id, { content: [{ type: 'text', text: '出错：' + (err?.message || err) }], isError: true });
        }
    }
    if (id !== undefined) replyError(id, -32601, '不支持的方法：' + method);
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try {
            msg = JSON.parse(line);
        } catch (_) {
            continue;
        }
        handle(msg).catch((err) => msg.id !== undefined && replyError(msg.id, -32603, String(err?.message || err)));
    }
});
