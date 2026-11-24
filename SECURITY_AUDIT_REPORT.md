# VideoKit Studio 安全审核报告

- **审核对象**：`videokit`（`VideoKit Studio` `v1.0.0`）
- **审核时间**：2026-11-24
- **审核结论**：**通过桌面应用与公开仓库发布安全审核（0 Critical / 0 High 可利用代码漏洞与依赖漏洞，0 密钥与本机个人路径泄露）**。全部可修复的代码安全项、依赖补丁、AI 接口边界加固与 Windows 跨平台兼容项均已修复并通过构建与测试；仅保留 1 项不可利用的 Moderate 间接依赖告警及 2 项架构级低风险观察项。

---

## 一、项目概况

- **技术架构**：
  - 桌面主进程：Electron `45.0.0` + Node.js（`electron/`，68 个源文件，含安全缓存管理 `cacheManager.js` 与跨盘符文件工具 `fsUtils.js`）
  - 渲染前端：Vite `6.4.6` 构建的静态前端（`src/`，94 个源文件，默认渲染引擎 `turbo`）
  - 辅助脚本与 MCP 桥接：Node.js（`scripts/`，10 个文件）
  - 媒体工具链：FFmpeg / FFprobe + Python `yt-dlp` 运行时（`backend/requirements.txt`）
- **审核范围**：`package.json`、`package-lock.json`、`backend/requirements.txt`、`electron/`、`src/`、`scripts/`、`.github/workflows/`、`.gitignore`、`.env.example`、`dist/`（共 478 个入库文件）。
- **终版验证结果**：
  - `npm audit --omit=dev`：0 Critical / 0 High / 5 Moderate（仅 `archiver` 间接依赖，无利用条件）
  - `npm audit`（含开发依赖）：0 Critical / 0 High / 10 Moderate
  - `node scripts/pre-build-check.js`：**0 ERROR / 0 WARN**
  - `npm run build`（Vite `6.4.6`）：通过
  - 全仓静态复查：0 `eval` / `new Function`、0 跳过二次确认快捷分支、0 密钥与个人本机路径泄露
  - 安全与 Windows 兼容单元测试（AI API Host/Origin/原型链/鉴权、跨盘移动 `EXDEV`、Windows 盘符 URL 重定位、FFmpeg 字幕转义）：全部通过

---

## 二、问题汇总表

| 编号 | 类别 | 严重级别 | 位置 | 状态 | 说明 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **C-01** | 代码 | **High** | `electron/aiApi/handlers.js`、`src/ai-api-bridge.js`、`scripts/videokit-ai-mcp.cjs` | **已修复** | 彻底移除 `renderer_inspect` / `renderer_execute` 中的 `new Function()` 动态脚本执行，仅保留安全 DOM 选择器检视与受控后端路由调用。 |
| **D-01** | 依赖 | **High**（开发态） | `package.json`、`package-lock.json` | **已修复** | `vite` 由 `6.4.5` 升级至 `6.4.6`（修复 `CVE-2026-118662` / `GHSA-8g5g-mxqh-grgj` 及 `GHSA-p4f5-76q4-ffq7`）。 |
| **C-02** | 代码 | **Medium** | `electron/main.js`（`hedraBridgeServer`） | **已修复** | 新增 `Host` 回环校验、拒绝 `Origin: null`、强制 `hedra.com` 使用 `https:`、移除 `Access-Control-Allow-Origin: *`。 |
| **C-03** | 代码 | **Medium** | `electron/aiApi/server.js`、`src/ai-api-bridge.js` | **已修复** | 路由与动作分发改用 `hasOwnProperty` 防原型链查找；补充 `Host` 校验与审计日志/发现文件 `0o600` 权限。 |
| **C-04** | 代码 | **Medium** | `electron/services/google-drive-review.js` | **已修复** | `isPrivateHost` 补充拦截 `::`、`::ffff:*`（IPv6 映射 IPv4）与 `100.64.0.0/10`（CGNAT）。 |
| **C-05** | 代码 | **Medium** | `electron/aiApi/handlers.js` | **已修复** | 彻底移除 `trash_files`、删模板、清缓存、清空列表等全部破坏性操作的 `confirm: true` 跳过分支，统一强制走一次性 `confirmToken` 两步确认。 |
| **D-03** | 依赖 | **Medium** | `backend/requirements.txt` | **已修复** | 下限抬高至 `requests>=2.33.0`（修复 `CVE-2026-25645`）与 `yt-dlp>=2026.10.26`。 |
| **S-02** | 隐私/配置 | **Medium** | `src/reels-gdrive-download.js`、`scripts/videokit-ai-mcp.cjs`、`electron/main.js` | **已修复** | 移除硬编码的开发者本机下载路径与私有磁盘路径，改用 `getDownloadsPath()` 动态获取与通用占位符。 |
| **C-06** | 代码 | **Low** | `electron/main.js`（`show-item-in-folder`） | **已修复** | 增加 `isBlockedSensitiveFilePath` 敏感路径拦截，与 `open-path` 保持一致。 |
| **W-01** | 跨平台 | **Medium** | `electron/services/fsUtils.js`、`davinciFusionExport.js`、`ffmpeg.js`、`reels-media-relocation.js`、`localOrganizerService.js` 等 | **已修复** | 补齐 Windows 跨盘符安全移动、达芬奇 Windows 兼容与未安装静默跳过、非 N 卡 GPU 真实探测、Windows 盘符 URL 编码修复、字幕路径转义、`windowsHide: true` 与文件剪贴板复制。 |
| **D-02** | 依赖 | **Medium** | `package.json`（`archiver@^7.0.1`、`electron-builder@^26.18.1`） | **架构保留** | 间接依赖 `glob`（`GHSA-3g3m-2fjr-6pw4`）与 `minimatch`（`GHSA-g3hv-75wg-m249`）。项目仅打包本地受控目录，未传入不可信 glob，实际不可利用；暂保留稳定版，后续按计划升级 `archiver@8.0.0`。 |
| **C-07** | 代码 | **Medium** | `electron/main.js`、`electron/services/ffmpeg-rawvideo.js` | **架构保留** | 隐藏离线渲染窗口保留 `nodeIntegration: true` + `webSecurity: false` 以兼容本地视频 Canvas 导出（已锁死外部导航与弹窗，仅加载本地受控页面）。 |
| **S-01** | 密钥 | **Info** | 历史旧仓库（非本仓库） | **提醒事项** | 本公开仓库从干净初始状态建立（0 密钥入库）；如早期私有/旧仓库曾提交过真实 API Key，请确保已在对应平台完成轮换作废。 |

---

## 三、核心安全基线确认

- **路径与缓存安全**：`electron/services/pathSecurity.js` 与 `electron/services/cacheManager.js` 采用白名单机制 + 软链接真实路径还原，严格保护 `backend/` 密钥配置、预设、模板、`Local Storage`、云端转录记录（`videokit_log`）及系统凭据目录。
- **进程与解压安全**：全部外部命令（FFmpeg / FFprobe / yt-dlp / PowerShell / osascript）均采用参数数组调用，无 `shell: true` 拼接；ZIP 解压统一走 `safeZipExtract.js`（防 Zip Slip 与符号链接逃逸）。
- **凭据加密存储**：API Key 使用 Electron `safeStorage` 加密存储，列表与 AI 查询接口默认脱敏返回；`.env` 与本地密钥文件均由 `.gitignore` 严格排除。
- **CI/CD 安全**：`.github/workflows/build.yml` 与 `codeql.yml` 所有第三方 Action 均锁定完整 Commit SHA，并配置最小 `permissions`。
