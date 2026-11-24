# VideoKit Studio 完整应用安全审核报告

- **项目名称**：`videokit`（VideoKit Studio `v1.0.0`）
- **审核日期**：2026-11-24
- **仓库状态**：Git 单一初始干净提交（`d2c1621`），工作区审核并直接完成全部可安全修复项
- **验证状态**：`npm test`（4/4 通过）、`node scripts/pre-build-check.js`（0 ERROR / 0 WARN）、`npm run build`（Vite `6.4.6` 通过）、专项安全回归断言（5/5 通过）

---

## 一、项目概况

### 1. 技术栈与审核范围
- **语言与框架**：
  - 桌面主进程：Electron `45.4.1` + Node.js（`electron/`，含主进程、预加载桥、IPC 路由、本地 AI API、Hedra 桥接及各类媒体/云盘/模板服务）
  - 渲染前端：Vite `6.4.6` 构建的原生 HTML/CSS/JavaScript（`src/`）
  - 辅助脚本与 MCP 桥接：Node.js（`scripts/`）
  - Python 媒体下载运行时：`backend/requirements.txt`（供 `yt-dlp` 使用，另有 gitignored 的本地 `vendor/darwin/python` 与 `vendor/windows/python`）
  - CI/CD：GitHub Actions（`.github/workflows/build.yml`、`.github/workflows/codeql.yml`、`.github/dependabot.yml`）
- **包管理器与依赖数量**：
  - npm（`package.json` + `package-lock.json`）：**8 个直接运行依赖** + **6 个直接开发依赖**，锁文件共解析 **476 个包**
  - pip（`backend/requirements.txt`）：**4 个直接依赖约束**
- **审核范围**：`package.json`、`package-lock.json`、`backend/requirements.txt`、`electron/**`、`src/**`、`scripts/**`、`.github/**`、`.gitignore`、`.env.example`、`backend/*.json`（本地配置检查）、`logs/app.log`、`dist/` 与 Git 历史。

### 2. 全部直接依赖与关键间接依赖清单

#### (1) npm 直接运行依赖（`dependencies`）

| 包名 | 声明范围 | 锁文件实际版本 | 最新版本（参考） | 漏洞与维护状态 |
| :--- | :--- | :--- | :--- | :--- |
| `@google/genai` | `^1.50.1` | `1.50.1` | `3.6.1` | 未见针对核心 SDK 的直接已知 CVE；活跃维护 |
| `archiver` | `^7.0.1` | `7.0.1` | `8.0.0` | 间接依赖 `glob@10.5.0`（`GHSA-3g3m-2fjr-6pw4`）与 `minimatch@9.0.9`（`GHSA-g3hv-75wg-m249`），均 Moderate；需大版本升级至 `8.0.0`（待开发者决定） |
| `axios` | `^1.21.1` | `1.21.1` | `1.21.1` | 已更新至最新小版本；已高于 2026 年 3 月供应链投毒版本（`1.14.1` / `GHSA-fw8c-xr5c-95f9`），已确认锁文件不含 `plain-crypto-js`；包含 `NO_PROXY` SSRF 补丁 |
| `diff-match-patch` | `^1.0.5` | `1.0.5` | `1.0.5` | 未见直接 CVE；**长期无更新/原上游已归档**（纯文本 diff 算法，无网络/FS 接触，风险低） |
| `electron-store` | `^8.1.0` | `8.2.0` | `12.0.0` | 未见直接 CVE；**旧大版本**（v9+ 切换为纯 ESM，升级需改写 CommonJS 导入） |
| `electron-updater` | `^6.8.3` | `6.8.11` | `6.8.11` | 已修复 Windows 签名校验绕过 `CVE-2024-39698` / `GHSA-9jxc-qjr9-vjxq`（`>=6.3.0-alpha.6`） |
| `node-web-audio-api` | `^1.0.8` | `1.0.8` | `2.3.0` | 未见主流 CVE/GHSA；含原生二进制（`.node`），已在 `package.json` 启用 `npmRebuild: true` |
| `yauzl` | `^2.10.0` | `2.10.0` | `3.4.0` | 未受 `CVE-2026-31988`（仅影响 `3.2.0`）影响；**v2 分支已长期无更新**（v3 为活跃分支） |

#### (2) npm 直接开发依赖（`devDependencies`）

| 包名 | 声明范围 | 锁文件实际版本 | 最新版本（参考） | 漏洞与维护状态 |
| :--- | :--- | :--- | :--- | :--- |
| `concurrently` | `^8.2.2` | `8.2.2` | `10.0.7` | 未见直接 CVE；旧大版本（仅开发脚本） |
| `electron` | `^45.4.1` | `45.4.1` | `45.4.1` | 已更新至最新 45.x 补丁版，包含 Chromium/V8/Node.js 最新安全回移 |
| `electron-builder` | `^26.8.1` | `26.18.1` | `26.18.0` | 开发打包工具；间接依赖 `@electron/universal` / `app-builder-lib` 引入 `minimatch@9.0.9` 与 `10.2.6`（`GHSA-g3hv-75wg-m249`，Moderate，无不升级降级的上游修复） |
| `shell-quote` | `^1.8.4` | `1.12.0` | `1.12.0` | 已高于 `1.11.0`，已修复 `CVE-2026-9277`、`CVE-2026-102422`、`CVE-2026-13311` |
| `vite` | `^6.4.6` | `6.4.6` | `8.3.8` | 已修复 `CVE-2026-39363` 与 `CVE-2026-118662`（`>=6.4.5`）；大版本已到 v8 |
| `wait-on` | `^7.2.0` | `7.2.0` | `9.5.1` | 未见直接 CVE；旧大版本（仅开发启动脚本） |

#### (3) 锁文件中关键间接依赖实际版本（交叉核对）
- `follow-redirects@1.16.3`、`form-data@4.0.6`、`proxy-from-env@2.1.0`、`ws@8.21.0`、`google-auth-library@10.6.2`、`gaxios@7.1.4`、`node-fetch@3.3.2`
- `undici@6.29.1` / `7.30.1`、`tar@7.5.23`、`js-yaml@4.3.2`、`lodash@4.18.1`、`ajv@8.20.0`、`nanoid@3.3.20`、`esbuild@0.25.12`、`rollup@4.60.2`、`postcss@8.5.31`、`plist@3.1.0`
- `glob@10.5.0`（及 `@electron/asar` / `rimraf` 下 `7.2.3`）、`minimatch@5.1.9` / `9.0.9` / `10.2.6` / `3.1.5`、`got@11.8.6`（旧版本，仅构建/间接链路）
- **仿冒包核查**：全部直接依赖及关键间接依赖名称均核对为官方正规包，未发现疑似 typosquatting / 仿冒依赖。

#### (4) Python 依赖（`backend/requirements.txt` 与本地 `vendor/`）
- `requests>=2.33.0`（已修复 `CVE-2026-25645`）
- `urllib3>=2.6.3` → **本次已修复为 `urllib3>=2.8.0`**（修复 High 漏洞 `CVE-2026-9375` 与 `CVE-2026-97689`）
- `yt-dlp>=2026.10.26`（已修复 `CVE-2026-26331`、`CVE-2026-50019`、`CVE-2026-50023`）
- `setuptools>=78.1.1`（已修复 `CVE-2025-47273`）
- **本地未入库缓存提示**：本地 `vendor/windows/python/Lib/site-packages` 仍残留旧版 `requests-2.32.5`、`urllib3-2.6.3`、`yt_dlp-2025.12.8`，`vendor/darwin/python` 残留 `setuptools 70.3.0`（详见第四节 D-04）。

---

## 二、问题汇总表

| 编号 | 类别 | 严重级别 | 位置 | 状态 | 简述 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **D-01** | 依赖 | **High** | `backend/requirements.txt:2` | **已修复** | `urllib3>=2.6.3` 存在 Brotli 流式解压炸弹绕过（`CVE-2026-9375`）及分块响应内存耗尽（`CVE-2026-97689`），已升级下限至 `>=2.8.0`。 |
| **C-01** | 代码 | **High** | `electron/services/settings.js:63,869`、`electron/apiRouter.js:2621,2680,527` | **已修复** | `createZip` 与模板导出未校验 `isBlockedSensitivePath`，可借 `.zip` 绕过敏感文件读取封锁；`secureTmpFile` 存在前缀路径穿越风险；`uploadFile` 未拦截可执行扩展名；合集归档导入无嵌套深度限制。 |
| **C-02** | 代码 | **High** | `electron/services/davinciFusionExport.js:605-626` | **已修复** | 提权执行 `osascript do shell script` 使用双引号（`JSON.stringify`）未防 POSIX `$()` / 反引号展开；写入 `/Users/Shared` 未校验符号链接攻击。 |
| **C-03** | 代码 | **High** | `src/app.js:37675,9497,20794,34101` | **已修复** | `onclick="organizerOpenAddRule(${escapedFile})"` 仅转义双引号未转义 `&`，恶意文件名含 `&quot;` 可触发 DOM XSS；多处缩略图 `src` 与远程 GitHub Release `tag_name` 未转义拼入 `innerHTML`。 |
| **C-04** | 代码 | **Medium** | `electron/aiApi/handlers.js:29-40` | **已修复** | `BLOCKED_API_ENDPOINTS` 遗漏 `settings/transcription-providers` 与 `settings/elevenlabs-keys-status`，允许通用 `api_call` 路由篡改密钥配置。 |
| **C-05** | 代码 | **Medium** | `electron/main.js:908,1745,1805,2258,2442,2612` | **已修复** | 工程打包 IPC（`collect-reels-project-assets` / `copy-reels-project-package`）未过滤敏感路径；`local-media://` 中 `decodeURIComponent` 位于 `try` 外可致未捕获异常；取色窗口缺 `sandbox: true` 与导航加固；`vk-server.json` 缺 `0o600` 权限。 |
| **C-06** | 代码 | **Medium** | `electron/services/ytdlp.js:200,331,383` | **已修复** | `outputTemplate` 未拦截 `../`、路径分隔符与前导 `-`，`ext` / `subLang` 未做白名单校验。 |
| **C-07** | 代码 | **Medium** | `electron/services/safeZipExtract.js:45-250` | **已修复** | ZIP 解压缺少条目数上限与总解压字节上限（Zip Bomb 防护），已补充预校验及流式实时限额。 |
| **C-08** | 代码 | **Low** | `electron/services/google-drive-review.js:299`、`font-cache.js:159`、`elevenlabsAuth.js:160`、`updater.js:226,286,314` | **已修复** | 云端审核 SVG 缺 CSP 响应头；字体缓存下载未校验 `fonts.gstatic.com` 域名与扩展名；ElevenLabs 登录窗未约束弹窗 `webPreferences`；绿色版更新器缺重定向次数上限与版本号字符校验。 |
| **S-01** | 密钥 | **Low** | `.gitignore:55` | **已修复** | 原 `.gitignore` 未覆盖 `.env.production` / `.env.development` 等变体，已补充 `.env.*` 与 `!.env.example`。 |
| **D-02** | 依赖 | **Medium** | `package.json`（`archiver@^7.0.1`、`electron-builder@^26.8.1`） | **待开发者决定** | `npm audit` 报告 10 条 Moderate（源自 `glob` `GHSA-3g3m-2fjr-6pw4` 与 `minimatch` `GHSA-g3hv-75wg-m249`），修复 `archiver` 需大版本升至 `8.0.0`。 |
| **D-03** | 依赖 | **Medium** | `package.json`、`package-lock.json`（`electron`、`axios`） | **已修复**（旧大版本暂缓） | 已经开发者确认将 `electron` 由 `45.0.0` 升级至 `45.4.1`、`axios` 由 `1.20.0` 升级至 `1.21.1`；`yauzl` / `electron-store` / `vite` 等大版本升级暂缓。 |
| **D-04** | 依赖 | **High**（仅本地打包时） | `vendor/windows/python/`、`vendor/darwin/python/`（未入库） | **待开发者决定** | 本地磁盘缓存的 Windows vendor Python 含 `requests 2.32.5`、`urllib3 2.6.3`、`yt-dlp 2025.12.8`，macOS 含 `setuptools 70.3.0`，本地运行 `pack:win-x64` 会将旧包打入安装包。 |
| **C-09** | 代码（CI/CD） | **Medium** | `.github/workflows/build.yml:62,124,149,173,249` | **待开发者决定** | CI 下载 Python Embedded `3.11.9`、`python-build-standalone`、`get-pip.py` 及浮动 `latest` 标签的 FFmpeg，均缺少 SHA-256 完整性校验。 |
| **C-10** | 代码 | **Medium** | `electron/updater.js:308-341` | **待开发者决定** | Windows 绿色版更新直接解压 GitHub Release ZIP，未像安装版那样校验 SHA-512 哈希（`latest.yml`）或 Authenticode 签名。 |
| **C-11** | 代码 | **Medium** | `electron/main.js:2480-2613` | **待开发者决定** | `hedraBridgeServer`（`127.0.0.1:18190`）无身份令牌鉴权，允许任意本机进程、任意浏览器扩展及 `localhost` 页面推送自动剪辑导入指令。 |
| **C-12** | 代码 | **Medium** | `electron/main.js:766,1547`、`ffmpeg-rawvideo.js:2578,2858` | **待开发者决定** | 隐藏离线渲染窗口使用 `nodeIntegration: true` + `contextIsolation: false` + `webSecurity: false`；主窗口因 preload 直调 `fs` 保持 `sandbox: false`。 |
| **C-13** | 代码 | **Medium** | `electron/services/davinciFusionExport.js:605-615` | **待开发者决定** | macOS 达芬奇菜单入口指向 `/Users/Shared/VideoKit/Resolve`，在多用户共用 Mac 场景下存在跨用户脚本篡改面。 |
| **S-02** | 密钥 | **High**（本地磁盘） | `backend/elevenlabs_settings.json`、`backend/gladia_keys.json`、`backend/transcription_providers.json`（均未入库） | **待开发者决定** | Git 仓库内 0 密钥泄露（已核验历史与追踪文件）；但开发者本机 `backend/` 目录下仍存有旧版明文 API Key（含 19 个 ElevenLabs `sk_` 密钥及 Gladia/转录平台密钥），需重新加密存储并评估旧仓库历史轮换。 |

---

## 三、已修复的问题及具体改动

### 1. [D-01] `urllib3` 高危流式解压与内存耗尽漏洞（High）
- **位置**：`backend/requirements.txt:2`
- **风险与利用条件**：原下限 `urllib3>=2.6.3` 允许 CI 或本地打包解析到受 `CVE-2026-9375`（Brotli 流式解压绕过 `max_length` 保护）与 `CVE-2026-97689`（chunked 响应解析无界内存分配）影响的版本，恶意远程视频站或重定向响应可触发 OOM 拒绝服务。
- **改动**：将 `urllib3>=2.6.3` 升级为 `urllib3>=2.8.0`（小版本兼容升级，直接覆盖两项修复）。

### 2. [C-01] 敏感文件经 ZIP 打包外泄、`secureTmpFile` 路径穿越与上传扩展名拦截（High）
- **位置**：`electron/services/settings.js:9,63-78,868-899`、`electron/apiRouter.js:41-46,527-552,2621,2680-2698`
- **风险与利用条件**：
  1. `file/download-zip` / `subtitle/download-zip` 调用 `createZip(files, outputPath)` 时未校验 `isBlockedSensitivePath`，攻击者（经渲染层 XSS 或受控接口）可将 `~/.ssh/id_rsa`、`ai-api.json`、`elevenlabs_settings.json` 打包进临时 `.zip`，再通过允许 `.zip` 扩展名的 `local-media://` 协议读出，直接绕过整套 `pathSecurity.js` 敏感文件保护。
  2. `templates/export-archive`（`extractAndRewritePaths`）同样未校验 `isBlockedSensitivePath`，畸形模板 JSON 可夹带敏感文件进入 `.vkpkg`。
  3. `secureTmpFile(prefix, ext)` 直接拼接未清洗的 `prefix`（如用户模板名 `tplData.name`），含 `../` 时可逃逸出临时目录。
  4. `uploadFile` 未拦截可执行脚本扩展名（`.sh` / `.exe` / `.ps1` / `.js` 等）；`templates/import-archive` 递归导入 `manifest.json` 缺少深度限制；`media/rename-original-clips` 未校验受保护路径。
- **改动**：
  - `settings.js`：`createZip` 逐项校验 `isBlockedSensitivePath` 并拒绝敏感文件；`secureTmpFile` 清洗 `prefix`/`ext` 并做 `dirRoot` 前缀边界校验；`uploadFile` 接入 `isBlockedWritePath` 拦截可执行扩展名。
  - `apiRouter.js`：`extractAndRewritePaths` 过滤 `isBlockedSensitivePath`；`templates/import-archive` 增加 `_collectionDepth <= 1` 嵌套上限；`media/rename-original-clips` 增加敏感路径与目标写路径校验。

### 3. [C-02] macOS 提权 `osascript` 双引号 Shell 注入面与 `/Users/Shared` 符号链接防护（High）
- **位置**：`electron/services/davinciFusionExport.js:605-646`
- **风险与利用条件**：使用 `osascript -e "do shell script ... with administrator privileges"` 时，原代码用 `JSON.stringify(tempLauncher)` 生成双引号参数；在 POSIX `sh` 中双引号不会阻止 `$()`、反引号和 `$VAR` 展开，若 `$TMPDIR` 含特殊字符将触发 root 权限命令注入。此外向 `/Users/Shared/VideoKit/Resolve` 直接 `copyFileSync` 会跟随恶意预先创建的符号链接覆写任意文件。
- **改动**：改为严格的 POSIX 单引号转义函数 `shellSingleQuote`；写入 `/Users/Shared` 前对路径层级执行 `lstatSync().isSymbolicLink()` 拦截，并改用临时文件原子 `renameSync` 落盘。

### 4. [C-03] 渲染进程多处 DOM XSS（High，因渲染层可调用 `electronAPI` 与密钥展示路由）
- **位置**：`src/app.js:37672-37690`、`src/app.js:9497`、`src/app.js:20794`、`src/app.js:34101`
- **风险与利用条件**：
  1. `src/app.js:37675` 对 `JSON.stringify(f)` 仅做 `.replace(/"/g, '&quot;')` 并拼入 `onclick="organizerOpenAddRule(...)"`，未转义 `&`；浏览器解析 HTML 属性时会先解码 `&quot;` 为 `"`，若本地待整理文件名中包含字面 `&quot;);...` 即可闭合 JS 字符串并执行任意脚本。
  2. `src/app.js:9497` 与 `20794` 将 `thumbnail` 未经 `escapeHtmlAttr` 直接拼入 `<img src="${thumbnail}">`，含双引号的文件路径可逃逸属性注入事件处理器。
  3. `src/app.js:34101` 将远端 GitHub Release 的 `tag_name`（`verName`）与日期未转义写入 `innerHTML`。
  - 在 Electron 主渲染窗口中，XSS 可直接调用 `window.electronAPI.apiCall('settings/reveal-keys', ...)` 窃取全部已存 API Key 并调用本地文件操作接口。
- **改动**：将待处理样本改为存表并通过数字索引 `organizerOpenAddRuleByIndex(${idx})` 调用；全部未转义的 `thumbnail`、`verName`、`relDate` 统一使用 `escapeHtmlAttr` 转义。

### 5. [C-04] AI API 通用路由凭据黑名单补全（Medium）
- **位置**：`electron/aiApi/handlers.js:29-41`
- **风险与利用条件**：`renderer_action(mode: 'api_call')` 的 `BLOCKED_API_ENDPOINTS` 遗漏 `settings/transcription-providers` 与 `settings/elevenlabs-keys-status`，可能绕过密钥隔离边界改写/清空云端转录与 ElevenLabs 密钥配置。
- **改动**：将上述两个路由加入 `BLOCKED_API_ENDPOINTS`。

### 6. [C-05] 主进程 IPC 边界、协议异常处理与窗口隔离加固（Medium）
- **位置**：`electron/main.js:908-920,1745-1770,1805-1870,2258-2266,2442-2450,2612-2622`
- **改动**：
  - `collect-reels-project-assets` 与 `copy-reels-project-package` 对目标路径、源工程目录、分析目录及每个被复制的素材路径增加 `isBlockedSensitiveFilePath` 校验。
  - `local-media://` 将 `decodeURIComponent` 移入 `try/catch`，非法百分号编码返回 HTTP `400`。
  - 屏幕取色窗口 `pickerWin` 启用 `sandbox: true` 并接入 `hardenPrivilegedWindowNavigation`。
  - `open-template-window` 对 `templateId` 使用 `encodeURIComponent`。
  - `hedraBridgeServer` 写出 `vk-server.json` 时设置 `0o600` 权限（受 `process.platform !== 'win32'` 保护）。

### 7. [C-06] `yt-dlp` 参数与输出模板防穿越加固（Medium）
- **位置**：`electron/services/ytdlp.js:200-226,331-355,383-425`
- **改动**：新增 `sanitizeOutputTemplate`（拒绝 `..`、`/`、`\`、前导 `-`、`\0`）、`sanitizeYtdlpExt`（扩展名白名单）与 `sanitizeYtdlpSubLang`（正则白名单），防止参数注入或写出目录逃逸。

### 8. [C-07] ZIP 解压增加 Zip Bomb 资源配额防护（Medium）
- **位置**：`electron/services/safeZipExtract.js:45-255`
- **改动**：在预校验与流式解压阶段均强制实施 `maxEntries`（默认 `10000`）与 `maxTotalUncompressedBytes`（默认 `4 GiB`），并挂接 `Transform` 字节计数器防止伪造 ZIP 头部声明大小绕过校验。

### 9. [C-08] 纵深防御细节补齐（Low）
- **位置**：`electron/services/google-drive-review.js:299-304`、`electron/services/font-cache.js:159-172`、`electron/services/elevenlabsAuth.js:162-182`、`electron/updater.js:226-320`
- **改动**：云端审核 `.svg` 增加严格 CSP；字体缓存下载限制仅允许 `https:` 且域名为 `fonts.gstatic.com` / `fonts.googleapis.com` / `*.gstatic.com` 及白名单字体后缀；ElevenLabs 登录窗为 OAuth 弹窗配置 `setWindowOpenHandler`（仅放行 `http/https` 并强制 `nodeIntegration: false, contextIsolation: true, sandbox: true`）；绿色版更新器增加最大 5 次重定向限制及版本号正则校验。

### 10. [S-01] `.gitignore` 环境变量文件规则加固（Low）
- **位置**：`.gitignore:54-60`
- **改动**：新增 `.env.*` 与 `!.env.example`，防止 `.env.production` / `.env.development` 等环境文件误提交。

### 11. [D-03] `electron` 与 `axios` 安全小版本更新（Medium）
- **位置**：`package.json`、`package-lock.json`
- **改动**：经开发者确认后，将 `electron` 由 `45.0.0` 更新至 `45.4.1`（纳入 2026 年 10–11 月 Chromium/V8/Node.js 上游安全补丁回移），将 `axios` 由 `1.20.0` 更新至 `1.21.1`；大版本依赖升级（`archiver@8`、`yauzl@3`、`electron-store@12`、`vite@8`）暂缓。

### 构建与测试验证结果
- 全量修改文件语法检查（`node --check`）：12/12 通过
- 单元测试（`npm test`）：4/4 通过
- 打包前跨平台体检（`node scripts/pre-build-check.js`）：**0 ERROR / 0 WARN**
- 生产构建（`npm run build`，Vite `6.4.6`）：通过
- 专项安全回归脚本验证：`secureTmpFile` 穿越拦截、`uploadFile` `.sh` 拦截、`createZip` 敏感文件拦截、`BLOCKED_API_ENDPOINTS`、Zip Bomb 字节超限拦截全部通过

---

## 四、需要开发者决定的问题（附可选方案与建议）

### 1. [S-02] 本地明文 API Key 文件重新加密与历史密钥轮换（High）
- **现状**：
  - 本公开 Git 仓库历史干净（仅 1 次初始提交，**0 密钥入库**，`.gitignore` 与 `package.json` 打包过滤均已排除）。
  - 但开发者本机工作区 `backend/elevenlabs_settings.json`（含 19 个明文 `sk_...` Key）、`backend/gladia_keys.json`、`backend/transcription_providers.json` 仍存在历史明文密钥（未加密）。
- **重要提醒**：如果这些 API Key **曾经在任何早期私有仓库、旧分支或压缩包备份中提交或泄露过，仅删除/忽略代码远远不够，必须立即前往 ElevenLabs / Gladia / Deepgram / Groq / Gemini 控制台作废旧密钥并重新生成**。
- **可选方案**：
  - **方案 A（推荐）**：启动桌面端并在「设置」页点击一次保存，让 `settings.js` 自动通过系统级 `safeStorage` 将本机配置重写为 `*_encrypted` 密文，并清理工作区 `backend/` 目录下的旧明文副本（生产与开发态统一读取 `userData/backend/`）；对任何曾外泄或提交过旧仓库的 Key 立即轮换作废。
  - **方案 B**：仅在本地开发继续保留（依赖 `.gitignore` 与打包过滤），但存在本机其他程序或误打包备份读取明文的风险。

### 2. [D-02] `archiver` 大版本升级（`7.0.1` → `8.0.0`）与 `electron-builder` 间接依赖 Moderate 告警
- **现状**：`npm audit` 剩余 10 条 Moderate 告警，根因均为间接依赖 `glob@10.5.0`（`GHSA-3g3m-2fjr-6pw4`）与 `minimatch@9.0.9`/`10.2.6`（`GHSA-g3hv-75wg-m249`）。项目中 `archiver` 仅打包本地受控目录与明确文件路径，未传入不可信 glob 模式，`electron-builder` 仅在构建期运行，当前场景**实际不可利用**。
- **可选方案**：
  - **方案 A（推荐）**：将 `archiver` 升级至 `8.0.0` 并验证模板导出、覆层预设包导出和批量打包 ZIP 功能（可消除全部运行态 `npm audit --omit=dev` 告警）；`electron-builder` 等待上游发布含 `minimatch >= 11.0.1` 的新版本后再跟进（切勿按 `npm audit fix --force` 降级到 `24.13.3`）。
  - **方案 B**：暂维持 `archiver@7.0.1`，在下次小版本迭代统一升级测试。

### 3. [D-03] 旧大版本依赖规划（`electron` 与 `axios` 小版本已完成更新）
- **现状**：已按开发者决定将 `electron` 更新至 `45.4.1`、`axios` 更新至 `1.21.1`（同大版本小更新，构建与测试均通过）；大版本升级暂缓：`yauzl@2.10.0`（最新 `3.4.0`）、`electron-store@8.2.0`（最新 `12.0.0`，ESM-only）、`vite@6.4.6`（最新 `8.3.8`）。
- **建议**：后续依靠 `.github/dependabot.yml` 定期跟踪，在独立迭代窗口按需评估大版本迁移。

### 4. [D-04] 本地 `vendor/` 缓存的旧版 Python 依赖（影响本地打包）
- **现状**：本地 `vendor/windows/python/Lib/site-packages/` 含有 `requests-2.32.5`（受 `CVE-2026-25645` 影响）、`urllib3-2.6.3`（受 `CVE-2026-9375` / `CVE-2026-97689` 影响）、`yt_dlp-2025.12.8`（早于多个 2026 高危修复）；`vendor/darwin/python` 含 `setuptools 70.3.0`（受 `CVE-2025-47273` 影响）。虽然 GitHub Actions 构建会按最新 `backend/requirements.txt` 重新下载，但**若开发者在本机运行 `npm run pack:win-x64`，会直接将旧版打入 Windows 安装包**。
- **可选方案**：
  - **方案 A（推荐）**：在下次本地打包 Windows 前重建 `vendor/windows/python/Lib/site-packages`（按更新后的 `backend/requirements.txt` 安装），并升级本地 `vendor/darwin/python` 的 `setuptools>=78.1.1`。
  - **方案 B**：仅通过 GitHub Actions CI 构建正式分发包，不在本地运行 `pack:win-x64`。

### 5. [C-09] CI/CD 外部二进制下载完整性校验（`.github/workflows/build.yml`）
- **现状**：Workflow 所有 GitHub Actions 均已锁定完整 Commit SHA 且配置最小 `permissions`（良好实践）；但仍通过 HTTPS 无校验地下载 `python-3.11.9-embed-amd64.zip`（Python 3.11.9 较旧）、`python-build-standalone`、`get-pip.py` 以及浮动 `latest` 标签的 `BtbN/FFmpeg-Builds`。
- **可选方案**：
  - **方案 A（推荐）**：固定 FFmpeg 发布日期标签与 Python 3.11 最新补丁版（如 `3.11.11+`），并在 `build.yml` 中对所有下载压缩包执行 SHA-256 校验后再解压。
  - **方案 B**：保持浮动 `latest` 获取最新 FFmpeg，但至少对 Python 安装包与 `get-pip.py` 增加哈希校验。

### 6. [C-10] Windows 绿色版自动更新包完整性校验（`electron/updater.js`）
- **现状**：NSIS 安装版走 `electron-updater` 标准校验流程，但 Windows 绿色版（`portableUpdate`）下载 `.zip` 后直接解压覆盖程序目录，未校验 `latest.yml` 中的 SHA-512 哈希或代码签名。
- **可选方案**：
  - **方案 A（推荐）**：在 Release 构建时同步上传绿色版 `.zip` 的 `.sha512` 校验文件（或从 `latest.yml` 读取），`portableUpdate` 下载后先比对 SHA-512 一致再调用 `safeExtractZip`。
  - **方案 B**：继续仅依赖 GitHub HTTPS 域名白名单，并在界面提示绿色版更新风险。

### 7. [C-11] Hedra 本地 HTTP 桥接鉴权（`electron/main.js:2480-2613`）
- **现状**：`hedraBridgeServer` 监听 `127.0.0.1:18190`，已校验 `Host` 与 `Origin`，但**无共享密钥/Token**，且放行所有 `chrome-extension://*` / `moz-extension://*` / `localhost` 来源，意味着本机恶意扩展或本地进程可伪造 `/import-from-hedra` 触发前端自动导入并弹出窗口。
- **可选方案**：
  - **方案 A（推荐）**：参照 `aiApi/server.js`，在 `~/.videokit/hedra-bridge/vk-server.json`（`0o600`）中生成随机 `token`，要求 `Authorization: Bearer <token>`（需要同步更新 Hedra 联动端/插件代码）。
  - **方案 B**：保持免令牌联动，在 `isAllowedHedraOrigin` 中将 `chrome-extension://` 缩窄为指定的固定扩展 ID。

### 8. [C-12] Electron 离线渲染窗口 `nodeIntegration` 与主窗口 `sandbox` 架构取舍
- **现状**：`isolated-wysiwyg-renderer.html`、`shadow-renderer.html`、`audio-renderer.html` 仍启用 `nodeIntegration: true, contextIsolation: false`（前两者含 `webSecurity: false`）；主窗口与模板窗口因 `preload.js` 直接 `require('fs')` 保持 `sandbox: false`。已通过 `hardenPrivilegedWindowNavigation` 锁死外部导航与弹窗，降低直接远程利用面。
- **可选方案**：
  - **方案 A（长期推荐）**：逐步将隐藏渲染窗口改为 `nodeIntegration: false, contextIsolation: true` + 最小专用 `preload`（音频/视频通过 `local-media://` 或 IPC 传输），并将主窗口 `preload.js` 中的 `fs` 调用迁移到 `ipcMain`，最终全窗口开启 `sandbox: true`。
  - **方案 B（短期保持）**：维持现状以保障 WYSIWYG/WebAudio 离线渲染性能，严格禁止在这些隐藏窗口加载任何远端 URL 或未转义 HTML。

### 9. [C-13] macOS DaVinci Resolve 菜单脚本 `/Users/Shared` 多用户边界
- **现状**：本次已补齐 `/Users/Shared/VideoKit/Resolve` 符号链接检查和 `osascript` 单引号转义。但因 macOS 上 Resolve 20.2 仅扫描全局 `/Library/.../Scripts/Comp` 且无法跨 App 沙盒读用户目录，启动脚本仍指向 `/Users/Shared/VideoKit/Resolve/VideoKit Import Fusion Latest.py`。在**单人电脑**上无实质风险；在**多用户共用 Mac**上，其他本地账户若篡改该共享文件，会在管理员用户手动点击 Resolve 菜单时以管理员用户身份执行 Python。
- **可选方案**：
  - **方案 A（单用户/保持兼容）**：保留现状，在文档中注明仅建议在个人单用户 macOS 上安装全局菜单脚本，并可确保 `/Users/Shared/VideoKit` 目录权限为 `0o755`（非 `0o777`）。
  - **方案 B（多用户加固）**：改为导出后将最终 `.py` 直接安装到全局目录（每次变更再提权），或使用 Resolve 用户级脚本目录（若目标 Resolve 版本支持）。

---

## 五、剩余风险与后续建议

1. **前端持续消除内联事件与 `innerHTML`**：`src/app.js` 和 `src/batch-reels.js` 中仍存在数百处 `innerHTML` 与内联 `onclick`（多数传递数字索引或已转义，但随着功能迭代容易引入新的 XSS 回归）。建议后续新增 UI 统一采用 `document.createElement` + `textContent` + `addEventListener`，并在 CSP（`src/index.html:7`）中逐步规划移除 `script-src 'unsafe-inline'`。
2. **SSRF 纵深防护（DNS 解析层）**：`electron/services/google-drive-review.js` 已校验 URL 域名白名单（仅允许 Google Drive 与 `*.muse.ai`）及私网 IP 字面量，但未对重定向后的域名做 DNS 解析后 IP 校验（若白名单站点出现开放重定向指向解析到内网的自定义域名，存在理论 SSRF 风险）。可后续增加 `dns.lookup` 校验解析结果。
3. **非加密用途哈希说明**：代码中 15 处 `md5` / `sha1` 均用于文件去重、媒体缓存键生成等非安全场景（无密码哈希或签名用途），不存在密码学弱算法漏洞；新建缓存键建议统一优先使用 `sha256`。
4. **发布规范提醒**：后续如升级版本号打包发布，请遵循项目规则：先同步更新 `package.json` 与 `package-lock.json` 并推送到 `main`，确认 `.github/workflows/build.yml` 包含 `dist-electron/*.yml`，最后再打 Tag 推送触发构建。
