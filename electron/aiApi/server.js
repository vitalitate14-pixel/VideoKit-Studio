/**
 * VideoKit 本机 AI 操作接口服务
 *
 * - 仅监听本机 127.0.0.1（默认端口 18220），拒绝所有带 Origin / Sec-Fetch-Site 的网页跨站请求
 * - 校验 Bearer Token（随机生成并保存在 <userData>/ai-api.json）
 * - 每次调用追加审计日志到 <userData>/ai-api-log.jsonl
 * - 内置两步确认（confirmToken，10 分钟有效、一次性消费）与后台长任务管理（bgJobs）
 * - 同步写出不含口令的运行指针 ~/.videokit/ai-api-discovery.json，兼容开发版、正式打包版与自定义缓存目录
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_PORT = 18220;
const CONFIRM_TTL_MS = 10 * 60 * 1000;
const MAX_CONFIRMS_PER_HOUR = 60;
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const MAX_BG_JOBS = 30;
const MAX_PENDING_ACTIONS = 100;

function timingSafeBearerMatch(authHeader, token) {
    if (typeof authHeader !== 'string' || typeof token !== 'string' || !token) return false;
    const expected = `Bearer ${token}`;
    const a = Buffer.from(authHeader, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

function sanitizeForLog(value, depth = 0) {
    if (value == null) return value;
    if (depth > 4) return '[depth-limit]';
    if (typeof value === 'string') {
        if (value.length > 300) return `${value.slice(0, 260)}…(${value.length} chars)`;
        return value;
    }
    if (typeof value !== 'object') return value;
    if (Array.isArray(value)) {
        if (value.length > 20) {
            return [...value.slice(0, 20).map((item) => sanitizeForLog(item, depth + 1)), `…(+${value.length - 20} items)`];
        }
        return value.map((item) => sanitizeForLog(item, depth + 1));
    }
    const out = {};
    for (const [k, v] of Object.entries(value)) {
        if (/token|secret|password|apikey|api_key|authorization/i.test(k) && k !== 'confirmToken') {
            out[k] = '***';
        } else {
            out[k] = sanitizeForLog(v, depth + 1);
        }
    }
    return out;
}

function writePrivateFile(filePath, content) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
    if (process.platform !== 'win32') {
        try { fs.chmodSync(filePath, 0o600); } catch (_) { }
    }
}

function createAiApiServer(options = {}) {
    const getUserDataDir = options.getUserDataDir || (() => {
        const { app } = require('electron');
        return app.getPath('userData');
    });
    const getMainWindow = options.getMainWindow || (() => null);
    const getTemplateWindows = options.getTemplateWindows || (() => new Map());
    const getLatestRendererCrashReport = options.getLatestRendererCrashReport || (() => null);
    const getAppMeta = options.getAppMeta || (() => {
        try {
            const { app } = require('electron');
            return {
                version: app.getVersion(),
                isPackaged: app.isPackaged,
                mode: app.isPackaged ? 'packaged' : 'dev',
            };
        } catch (_) {
            return { version: '0.0.0', isPackaged: false, mode: 'test' };
        }
    });
    const logDir = options.logDir || null;
    const defaultPort = Number(options.port) > 0 ? Number(options.port) : DEFAULT_PORT;
    const writeDiscovery = options.writeDiscovery !== false;
    const logger = options.logger || console.log;

    const configPath = () => path.join(getUserDataDir(), 'ai-api.json');
    const logPath = () => path.join(getUserDataDir(), 'ai-api-log.jsonl');
    const discoveryPath = () => path.join(os.homedir(), '.videokit', 'ai-api-discovery.json');

    let server = null;
    let listening = false;
    let listenError = '';
    let activePort = defaultPort;

    const pendingActions = new Map();
    const confirmHistory = [];
    const bgJobs = new Map();
    const rendererWaiters = new Map();
    let rendererIpcRegistered = false;

    function loadConfig() {
        let cfg = {};
        try {
            if (fs.existsSync(configPath())) {
                cfg = JSON.parse(fs.readFileSync(configPath(), 'utf8')) || {};
            }
        } catch (_) {
            cfg = {};
        }
        const merged = {
            enabled: cfg.enabled !== false,
            port: Number(cfg.port) > 0 ? Number(cfg.port) : defaultPort,
            token: typeof cfg.token === 'string' && cfg.token.length >= 16
                ? cfg.token
                : crypto.randomBytes(24).toString('hex'),
            maxTargetsPerCall: Number(cfg.maxTargetsPerCall) > 0 ? Number(cfg.maxTargetsPerCall) : 500,
        };
        if (JSON.stringify(cfg) !== JSON.stringify(merged)) {
            try {
                writePrivateFile(configPath(), JSON.stringify(merged, null, 2));
            } catch (_) { }
        }
        return merged;
    }

    function saveConfig(cfg) {
        writePrivateFile(configPath(), JSON.stringify(cfg, null, 2));
        return cfg;
    }

    function audit(entry) {
        try {
            fs.mkdirSync(path.dirname(logPath()), { recursive: true });
            const record = {
                at: new Date().toISOString(),
                ...entry,
            };
            if (record.params !== undefined) {
                record.params = sanitizeForLog(record.params);
            }
            fs.appendFileSync(logPath(), JSON.stringify(record) + '\n', 'utf8');
            if (process.platform !== 'win32') {
                try { fs.chmodSync(logPath(), 0o600); } catch (_) { }
            }
        } catch (_) { }
    }

    function updateDiscoveryFile() {
        if (!writeDiscovery) return;
        try {
            const meta = getAppMeta();
            const payload = {
                app: 'videokit',
                userDataDir: getUserDataDir(),
                port: activePort,
                pid: process.pid,
                isPackaged: Boolean(meta.isPackaged),
                mode: meta.mode,
                version: meta.version,
                updatedAt: new Date().toISOString(),
            };
            writePrivateFile(discoveryPath(), JSON.stringify(payload, null, 2));
        } catch (_) { }
    }

    function cleanupPending() {
        const now = Date.now();
        for (const [token, item] of pendingActions) {
            if (now - item.createdAt > CONFIRM_TTL_MS) {
                pendingActions.delete(token);
            }
        }
        while (pendingActions.size > MAX_PENDING_ACTIONS) {
            const oldestKey = pendingActions.keys().next().value;
            if (!oldestKey) break;
            pendingActions.delete(oldestKey);
        }
    }

    function createPendingAction({ kind, summary, preview = {}, execute, meta = {} }) {
        cleanupPending();
        const confirmToken = crypto.randomBytes(8).toString('hex');
        pendingActions.set(confirmToken, {
            token: confirmToken,
            kind: String(kind || 'action'),
            summary: String(summary || ''),
            meta,
            execute,
            createdAt: Date.now(),
        });
        return {
            previewOnly: true,
            confirmToken,
            expiresInMinutes: Math.round(CONFIRM_TTL_MS / 60000),
            kind: String(kind || 'action'),
            summary: String(summary || ''),
            ...preview,
            nextStep: '请先将以上预览清单、输出路径和风险提示完整告知用户，用户明确同意后再调用 videokit_confirm 并带上 confirmToken 正式执行。',
        };
    }

    async function confirmPendingAction(confirmToken) {
        cleanupPending();
        const token = String(confirmToken || '').trim();
        if (!token) throw new Error('请传入 confirmToken');
        const pending = pendingActions.get(token);
        if (!pending) {
            throw new Error('确认口令无效、已使用或已过期（有效期 10 分钟），请重新预览生成新口令');
        }
        const now = Date.now();
        while (confirmHistory.length && now - confirmHistory[0] > 3600_000) {
            confirmHistory.shift();
        }
        if (confirmHistory.length >= MAX_CONFIRMS_PER_HOUR) {
            throw new Error(`一小时内已确认执行 ${MAX_CONFIRMS_PER_HOUR} 次操作，已达安全上限，请稍后再试`);
        }
        // 消费一次性口令后再执行，防止重复触发
        pendingActions.delete(token);
        confirmHistory.push(now);
        const result = await pending.execute();
        return {
            confirmed: true,
            kind: pending.kind,
            summary: pending.summary,
            result,
        };
    }

    function startBgJob(kind, meta, fn) {
        const id = crypto.randomBytes(6).toString('hex');
        const controller = new AbortController();
        const job = {
            id,
            kind: String(kind || 'task'),
            status: 'running',
            startedAt: Date.now(),
            finishedAt: null,
            progress: null,
            meta: meta || {},
            result: null,
            error: null,
            _controller: controller,
        };
        bgJobs.set(id, job);
        while (bgJobs.size > MAX_BG_JOBS) {
            const oldest = bgJobs.keys().next().value;
            if (!oldest) break;
            bgJobs.delete(oldest);
        }
        const reportProgress = (p) => {
            job.progress = p;
        };
        Promise.resolve()
            .then(() => fn({ signal: controller.signal, reportProgress, jobId: id }))
            .then((res) => {
                if (job.status === 'cancelled') return;
                job.status = 'done';
                job.result = res;
            })
            .catch((err) => {
                if (controller.signal.aborted || job.status === 'cancelled') {
                    job.status = 'cancelled';
                    job.error = '已取消';
                } else {
                    job.status = 'failed';
                    job.error = String(err?.message || err);
                }
            })
            .finally(() => {
                job.finishedAt = Date.now();
                audit({
                    action: `job:${job.kind}`,
                    jobId: job.id,
                    status: job.status,
                    ok: job.status === 'done',
                    ms: job.finishedAt - job.startedAt,
                    error: job.error || undefined,
                });
            });
        return serializeJob(job);
    }

    function serializeJob(job) {
        if (!job) return null;
        return {
            id: job.id,
            kind: job.kind,
            status: job.status,
            startedAt: new Date(job.startedAt).toISOString(),
            finishedAt: job.finishedAt ? new Date(job.finishedAt).toISOString() : null,
            seconds: Math.round(((job.finishedAt || Date.now()) - job.startedAt) / 1000),
            progress: job.progress,
            meta: job.meta,
            result: job.result,
            error: job.error,
        };
    }

    function getJob(jobId) {
        const job = bgJobs.get(String(jobId || ''));
        return serializeJob(job);
    }

    function listJobs(limit = 20) {
        const max = Math.min(MAX_BG_JOBS, Math.max(1, Number(limit) || 20));
        return Array.from(bgJobs.values()).reverse().slice(0, max).map(serializeJob);
    }

    function stopBgJob(jobId) {
        if (jobId) {
            const job = bgJobs.get(String(jobId));
            if (!job) return { stopped: false, message: '找不到该后台任务' };
            if (job.status !== 'running') return { stopped: false, message: `任务已处于 ${job.status} 状态` };
            job.status = 'cancelled';
            try { job._controller.abort(); } catch (_) { }
            return { stopped: true, jobId: job.id, kind: job.kind };
        }
        const stoppedIds = [];
        for (const job of bgJobs.values()) {
            if (job.status === 'running') {
                job.status = 'cancelled';
                try { job._controller.abort(); } catch (_) { }
                stoppedIds.push(job.id);
            }
        }
        return { stopped: stoppedIds.length > 0, stoppedIds };
    }

    function ensureRendererIpc() {
        if (rendererIpcRegistered) return;
        try {
            const { ipcMain } = require('electron');
            if (!ipcMain) return;
            rendererIpcRegistered = true;
            ipcMain.on('ai-api:renderer-response', (_event, payload = {}) => {
                const waiter = rendererWaiters.get(payload.reqId);
                if (!waiter) return;
                rendererWaiters.delete(payload.reqId);
                clearTimeout(waiter.timer);
                if (payload.ok) waiter.resolve(payload.result);
                else waiter.reject(new Error(payload.error || '渲染进程执行失败'));
            });
        } catch (_) { }
    }

    async function callRenderer(action, params = {}, timeoutMs = 30000) {
        if (typeof options.mockCallRenderer === 'function') {
            return options.mockCallRenderer(action, params);
        }
        const win = getMainWindow();
        if (!win || win.isDestroyed() || !win.webContents || win.webContents.isDestroyed()) {
            throw new Error('VideoKit 主窗口尚未就绪或已关闭');
        }
        ensureRendererIpc();
        const reqId = `vkai-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                rendererWaiters.delete(reqId);
                reject(new Error(`调用界面能力「${action}」超时（${Math.round(timeoutMs / 1000)}s），请确认软件界面未卡死或正在弹出模态确认框`));
            }, timeoutMs);
            rendererWaiters.set(reqId, { resolve, reject, timer });
            try {
                win.webContents.send('ai-api:renderer-request', { reqId, action, params });
            } catch (err) {
                rendererWaiters.delete(reqId);
                clearTimeout(timer);
                reject(err);
            }
        });
    }

    const customHandlers = options.handlers || (() => {
        const { createHandlers } = require('./handlers');
        return createHandlers({
            loadConfig,
            getUserDataDir,
            getMainWindow,
            getTemplateWindows,
            getLatestRendererCrashReport,
            getAppMeta,
            logDir,
            callRenderer,
            createPendingAction,
            confirmPendingAction,
            startBgJob,
            getJob,
            listJobs,
            stopBgJob,
            readLog,
            getStatus,
        });
    })();

    function readBody(req) {
        return new Promise((resolve, reject) => {
            const chunks = [];
            let received = 0;
            let aborted = false;
            req.on('data', (chunk) => {
                if (aborted) return;
                received += chunk.length;
                if (received > MAX_BODY_BYTES) {
                    aborted = true;
                    req.destroy();
                    reject(new Error('请求体超过大小限制（5MB）'));
                    return;
                }
                chunks.push(chunk);
            });
            req.on('end', () => {
                if (aborted) return;
                const raw = Buffer.concat(chunks).toString('utf8').trim();
                if (!raw) return resolve({});
                try {
                    resolve(JSON.parse(raw));
                } catch (_) {
                    resolve({});
                }
            });
            req.on('error', (err) => {
                if (!aborted) reject(err);
            });
        });
    }

    function sendJson(res, statusCode, payload) {
        if (res.writableEnded) return;
        res.writeHead(statusCode, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
        });
        res.end(JSON.stringify(payload));
    }

    function getStatus() {
        const cfg = loadConfig();
        const meta = getAppMeta();
        return {
            enabled: cfg.enabled,
            port: activePort || cfg.port,
            configuredPort: cfg.port,
            listening,
            listenError: listenError || null,
            maxTargetsPerCall: cfg.maxTargetsPerCall,
            mode: meta.mode,
            version: meta.version,
            userDataDir: getUserDataDir(),
            pendingConfirmCount: pendingActions.size,
            runningJobsCount: Array.from(bgJobs.values()).filter((j) => j.status === 'running').length,
        };
    }

    function setEnabled(enabled) {
        const cfg = loadConfig();
        cfg.enabled = Boolean(enabled);
        saveConfig(cfg);
        audit({ action: 'ui:set_enabled', enabled: cfg.enabled, ok: true });
        return getStatus();
    }

    function resetToken() {
        const cfg = loadConfig();
        cfg.token = crypto.randomBytes(24).toString('hex');
        saveConfig(cfg);
        pendingActions.clear();
        audit({ action: 'ui:reset_token', ok: true });
        return { ok: true };
    }

    function readLog(limit = 200) {
        const max = Math.min(500, Math.max(1, Number(limit) || 200));
        try {
            if (!fs.existsSync(logPath())) return [];
            const raw = fs.readFileSync(logPath(), 'utf8').trim();
            if (!raw) return [];
            return raw
                .split('\n')
                .slice(-max)
                .reverse()
                .map((line) => {
                    try { return JSON.parse(line); } catch (_) { return { raw: line }; }
                });
        } catch (_) {
            return [];
        }
    }

    function registerIpcHandlers() {
        try {
            const { ipcMain } = require('electron');
            if (!ipcMain) return;
            ensureRendererIpc();
            const safeHandle = (ch, fn) => {
                try { ipcMain.removeHandler(ch); } catch (_) { }
                ipcMain.handle(ch, fn);
            };
            safeHandle('ai-api:get-status', async () => getStatus());
            safeHandle('ai-api:set-enabled', async (_event, enabled) => setEnabled(Boolean(enabled)));
            safeHandle('ai-api:reset-token', async () => resetToken());
            safeHandle('ai-api:get-log', async (_event, limit) => readLog(Number(limit) || 200));
        } catch (_) { }
    }

    async function handleHttpRequest(req, res) {
        const remote = req.socket?.remoteAddress || '';
        if (!/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(remote)) {
            return sendJson(res, 403, { ok: false, error: '只允许本机 127.0.0.1 访问' });
        }
        const hostHeader = String(req.headers.host || '').trim();
        if (hostHeader && !/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(hostHeader)) {
            return sendJson(res, 403, { ok: false, error: '安全策略拦截：非法 Host 头' });
        }
        // 拒绝任何浏览器跨站/网页请求（带 Origin 或 Fetch Metadata 头）
        if (req.headers.origin || req.headers['sec-fetch-site']) {
            return sendJson(res, 403, { ok: false, error: '安全策略拦截：不允许网页跨域调用本机 AI 接口' });
        }
        const current = loadConfig();
        if (!current.enabled) {
            return sendJson(res, 503, { ok: false, error: 'AI 操作接口已关闭，请在 VideoKit 顶部导航栏打开「🤖 AI 操作」开关' });
        }
        const auth = String(req.headers.authorization || '');
        if (!timingSafeBearerMatch(auth, current.token)) {
            return sendJson(res, 401, { ok: false, error: '口令校验失败（Bearer Token 不匹配）' });
        }

        const parsedUrl = new URL(req.url || '/', 'http://127.0.0.1');
        const name = parsedUrl.pathname.replace(/^\/api\//, '').replace(/^\/+/, '');
        if (name === 'health') {
            const meta = getAppMeta();
            return sendJson(res, 200, {
                ok: true,
                app: 'videokit',
                version: meta.version,
                mode: meta.mode,
                port: activePort,
                protocolVersion: 1,
            });
        }

        const handler = Object.prototype.hasOwnProperty.call(customHandlers, name) ? customHandlers[name] : null;
        if (typeof handler !== 'function') {
            return sendJson(res, 404, { ok: false, error: `没有这个接口：${name}` });
        }

        let body = {};
        try {
            body = req.method === 'POST'
                ? await readBody(req)
                : Object.fromEntries(parsedUrl.searchParams.entries());
        } catch (err) {
            return sendJson(res, 413, { ok: false, error: String(err?.message || err) });
        }

        const t0 = Date.now();
        try {
            const result = await handler(body);
            audit({ action: name, params: body, ok: true, ms: Date.now() - t0 });
            return sendJson(res, 200, { ok: true, result });
        } catch (err) {
            const message = String(err?.message || err);
            audit({ action: name, params: body, ok: false, error: message, ms: Date.now() - t0 });
            return sendJson(res, 200, { ok: false, error: message });
        }
    }

    function start() {
        if (server) return Promise.resolve({ port: activePort, listening });
        registerIpcHandlers();
        const cfg = loadConfig();
        activePort = cfg.port;
        return new Promise((resolve) => {
            server = http.createServer((req, res) => {
                handleHttpRequest(req, res).catch((err) => {
                    sendJson(res, 500, { ok: false, error: String(err?.message || err) });
                });
            });
            server.on('error', (err) => {
                listening = false;
                listenError = err?.code === 'EADDRINUSE'
                    ? `端口 ${cfg.port} 已被另一个 VideoKit 实例或进程占用`
                    : String(err?.message || err);
                logger(`[AiApi] 启动失败: ${listenError}`);
                resolve({ port: activePort, listening: false, error: listenError });
            });
            server.listen(cfg.port, '127.0.0.1', () => {
                const addr = server.address();
                activePort = (addr && typeof addr === 'object' && addr.port) ? addr.port : cfg.port;
                listening = true;
                listenError = '';
                updateDiscoveryFile();
                logger(`[AiApi] 已在 127.0.0.1:${activePort} 开放 (enabled=${cfg.enabled})`);
                resolve({ port: activePort, listening: true });
            });
        });
    }

    function stop() {
        return new Promise((resolve) => {
            if (!server) return resolve();
            const s = server;
            server = null;
            listening = false;
            s.close(() => resolve());
        });
    }

    return {
        start,
        stop,
        loadConfig,
        getStatus,
        setEnabled,
        resetToken,
        readLog,
        audit,
        createPendingAction,
        confirmPendingAction,
        startBgJob,
        getJob,
        listJobs,
        stopBgJob,
        callRenderer,
    };
}

let singletonInstance = null;

function startAiApiServer(options = {}) {
    if (!singletonInstance) {
        singletonInstance = createAiApiServer(options);
    }
    return singletonInstance.start();
}

function getAiApiServer() {
    return singletonInstance;
}

module.exports = {
    DEFAULT_PORT,
    createAiApiServer,
    startAiApiServer,
    getAiApiServer,
    timingSafeBearerMatch,
    sanitizeForLog,
};
