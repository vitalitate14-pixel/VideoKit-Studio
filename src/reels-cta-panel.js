/* Original VideoKit-Y phone CTA controls, hosted by the native overlay inspector. */
(() => {
function preparePhoneOverlay(ov) {
    if (!ov?.is_phone_cta) return;
    if (['image', 'video'].includes(ov.type)) {
        ov.cta_mode ||= 'image';
        ov.cta_image_src ||= ov.content || '';
        ov.cta_image_name ||= ov.name || '';
        if (ov.body_text === undefined) {
            const defaults = window.ReelsOverlay.createPhoneCtaOverlay();
            for (const [key, value] of Object.entries(defaults)) if (ov[key] === undefined) ov[key] = value;
        }
    }
}
class ReelsPhoneCtaPanel {
    constructor(container, videoCanvas, linkedOverlayPanel) {
        this.container = container;
        this.videoCanvas = videoCanvas;
        this.linkedOverlayPanel = linkedOverlayPanel;
        this._renderUI();
        this._bindPhoneCtaModuleEvents();
        this.refresh();
    }
    _getPhoneCta() {
        const ov = this.linkedOverlayPanel?._selectedOv;
        return ov?.is_phone_cta ? ov : null;
    }
    _ensurePhoneCtaOverlay() { return this._getPhoneCta(); }
    _setVal(id, value) {
        const el = this.container.querySelector('#' + id);
        if (!el) return;
        if (el.type === 'checkbox') el.checked = Boolean(value);
        else el.value = value;
        const readout = this.container.querySelector(`[data-cta-link="${id}"]`);
        if (readout) readout.value = value;
    }
    _getVal(id) {
        const el = this.container.querySelector('#' + id);
        if (!el) return undefined;
        return el.type === 'checkbox' ? el.checked : ['number', 'range'].includes(el.type) ? Number(el.value) : el.value;
    }
    _renderUI() {
        const ctaStyleOptionsHtml = Object.entries(window.ReelsOverlay?.PHONE_CTA_STYLES || {})
            .map(([id, preset]) => `<option value="${id}">${preset.name}</option>`).join('');
        this.container.innerHTML = `
                <!-- ═══ 独立专区: 📞 邀约电话 (支持上传设计好的电话图片 / 文字蒙版号码) ═══ -->
                <div id="rdp-phone-cta-card" style="padding:10px 11px;background:linear-gradient(155deg,rgba(6,78,59,0.34),rgba(15,23,42,0.92));border:1px solid rgba(16,185,129,0.55);border-radius:9px;display:flex;flex-direction:column;gap:8px;box-shadow:0 4px 14px rgba(0,0,0,0.22);">
                    <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;flex-wrap:wrap;">
                        <label style="display:flex;align-items:center;gap:7px;cursor:pointer;margin:0;">
                            <span style="font-weight:800;font-size:13px;color:#6ee7b7;">📞 邀约电话 (上传电话图 / 文字蒙版)</span>
                            <span id="rdp-cta-status-badge" style="font-size:10px;padding:1px 7px;border-radius:999px;background:rgba(148,163,184,0.2);color:#cbd5e1;border:1px solid rgba(148,163,184,0.38);font-weight:700;">未启用</span>
                        </label>
                        <div style="display:flex;align-items:center;gap:5px;">
                            <button type="button" id="rdp-cta-preview-btn" class="rop-btn" style="padding:3px 8px;font-size:11px;font-weight:700;background:linear-gradient(135deg,#059669,#10b981);color:#fff;border:1px solid #6ee7b7;border-radius:5px;cursor:pointer;" title="在画布上立即演示邀约电话的出场动画与呼吸动态">▶ 预览动画</button>
                        </div>
                    </div>

                    <!-- 模式切换栏: 上传电话图片 vs 文字蒙版号码 -->
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
                        <button type="button" id="rdp-cta-mode-image" class="rdp-cta-mode-btn" data-mode="image"
                            style="padding:6px 8px;font-size:11.5px;font-weight:700;border-radius:6px;border:1px solid #38bdf8;background:rgba(14,116,144,0.35);color:#e0f2fe;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:5px;">
                            🖼️ 上传电话图片 (现成设计图)
                        </button>
                        <button type="button" id="rdp-cta-mode-text" class="rdp-cta-mode-btn" data-mode="text"
                            style="padding:6px 8px;font-size:11.5px;font-weight:700;border-radius:6px;border:1px solid #10b981;background:rgba(16,185,129,0.28);color:#ecfdf5;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:5px;">
                            📝 文字蒙版号码 (自定义文案)
                        </button>
                    </div>

                    <!-- 模式A: 🖼️ 上传电话图片专区 -->
                    <div id="rdp-cta-image-section" style="display:none;flex-direction:column;gap:7px;padding:8px 9px;border-radius:7px;background:rgba(15,23,42,0.68);border:1px solid rgba(56,189,248,0.38);">
                        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
                            <button type="button" id="rdp-cta-upload-btn" class="rop-btn"
                                style="flex:1;padding:6px 10px;font-size:11.5px;font-weight:700;background:linear-gradient(135deg,#0284c7,#2563eb);color:#fff;border:1px solid #7dd3fc;border-radius:6px;cursor:pointer;">
                                📁 上传电话图片 (PNG / JPG / WEBP / GIF)
                            </button>
                            <button type="button" id="rdp-cta-reuse-last-btn" class="rop-btn"
                                style="display:none;padding:6px 8px;font-size:11px;background:rgba(56,189,248,0.16);color:#bae6fd;border:1px solid rgba(56,189,248,0.45);border-radius:6px;cursor:pointer;"
                                title="一键加载上次上传过的电话图片">
                                🕘 用上次电话图
                            </button>
                            <input type="file" id="rdp-cta-file-input" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml,image/jpg" style="display:none;">
                        </div>

                        <div id="rdp-cta-img-dropzone" style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:7px 9px;border-radius:6px;background:rgba(2,6,23,0.65);border:1px dashed rgba(125,211,252,0.45);min-height:52px;">
                            <div style="display:flex;align-items:center;gap:8px;min-width:0;flex:1;">
                                <img id="rdp-cta-img-thumb" alt="电话图片预览" style="display:none;max-width:110px;max-height:46px;object-fit:contain;border-radius:4px;border:1px solid rgba(255,255,255,0.2);background:repeating-conic-gradient(#1e293b 0% 25%, #0f172a 0% 50%) 50% / 10px 10px;">
                                <div style="display:flex;flex-direction:column;gap:2px;min-width:0;">
                                    <div id="rdp-cta-img-name" style="font-size:11px;font-weight:600;color:#e0f2fe;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">尚未上传电话图片（支持点击上方按钮或直接把图片拖进此处）</div>
                                    <div style="font-size:10px;color:#94a3b8;">💡 上传别人设计好的电话条/联系方式卡片后，可在下方或直接在画面中拖拽调节位置、大小、出场时间与动画</div>
                                </div>
                            </div>
                            <button type="button" id="rdp-cta-clear-img-btn" class="rop-btn" style="display:none;padding:3px 7px;font-size:10.5px;background:rgba(239,68,68,0.18);color:#fca5a5;border:1px solid rgba(239,68,68,0.4);border-radius:5px;cursor:pointer;flex-shrink:0;" title="清除已上传的电话图片并切回文字模式">✕ 清除图片</button>
                        </div>

                        <div class="rop-grid" style="gap:5px;">
                            <label style="color:#bae6fd;font-weight:600;">图片宽度(px)</label>
                            <div class="rop-slider-combo">
                                <input type="range" id="rdp-cta-img-width" class="rop-range" min="120" max="1080" step="10" value="880">
                                <input type="number" class="rop-num-readout" data-cta-link="rdp-cta-img-width" min="80" max="1080" step="10" value="880">
                            </div>

                            <label style="color:#bae6fd;font-weight:600;">图片缩放%</label>
                            <div class="rop-slider-combo">
                                <input type="range" id="rdp-cta-img-scale" class="rop-range" min="20" max="220" step="2" value="100">
                                <input type="number" class="rop-num-readout" data-cta-link="rdp-cta-img-scale" min="10" max="300" step="2" value="100">
                            </div>
                        </div>
                    </div>

                    <!-- 模式B: 📝 文字蒙版号码专区 -->
                    <div id="rdp-cta-text-section" style="display:flex;flex-direction:column;gap:6px;padding:8px 9px;border-radius:7px;background:rgba(15,23,42,0.62);border:1px solid rgba(16,185,129,0.35);">
                        <div class="rop-grid" style="gap:5px;">
                            <label style="color:#a7f3d0;font-weight:600;">样式模板</label>
                            <select id="rdp-cta-style" class="rop-select">
                                ${ctaStyleOptionsHtml}
                            </select>

                            <label style="color:#a7f3d0;font-weight:600;">邀约电话文案<br><span style="font-size:10px;color:#94a3b8;font-weight:400;">(支持多行回车)</span></label>
                            <textarea id="rdp-cta-body" class="rop-textarea" rows="3" placeholder="Message on Whats/App&#10;at +1 (315) 277-2179&#10;to join our Free Bible study." style="font-size:12.5px;font-weight:700;color:#fde047;line-height:1.35;">Message on Whats/App&#10;at +1 (315) 277-2179&#10;to join our Free Bible&#10;study.</textarea>

                            <label>顶部副标题(可选)</label>
                            <input type="text" id="rdp-cta-title" class="rop-input" placeholder="默认留空，可填 CALL OR TEXT NOW">

                            <label style="color:#86efac;font-weight:600;">蒙版样式</label>
                            <select id="rdp-cta-mask-mode" class="rop-select">
                                <option value="inline-joined">🟩 逐行紧贴连通蒙版 (WhatsApp同款推荐)</option>
                                <option value="inline">💊 逐行独立圆角胶囊条</option>
                                <option value="block-fit">📦 整块自适应包裹框</option>
                                <option value="card">💳 完整横幅卡片底框</option>
                                <option value="none">🚫 无底框 (纯文字+描边)</option>
                            </select>

                            <label style="color:#86efac;font-weight:600;">蒙版颜色 & 透明%</label>
                            <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                                <input type="color" id="rdp-cta-mask-color" class="rop-color" value="#E0FF14" title="蒙版背景颜色">
                                <button type="button" class="rdp-cta-mask-chip" data-color="#E0FF14" style="padding:1px 5px;font-size:10px;background:#E0FF14;color:#000;border:1px solid #65a30d;border-radius:4px;cursor:pointer;font-weight:700;">荧光黄绿</button>
                                <button type="button" class="rdp-cta-mask-chip" data-color="#15803D" style="padding:1px 5px;font-size:10px;background:#15803D;color:#fff;border:1px solid #4ade80;border-radius:4px;cursor:pointer;">翠绿</button>
                                <button type="button" class="rdp-cta-mask-chip" data-color="#0B1021" style="padding:1px 5px;font-size:10px;background:#0B1021;color:#fde047;border:1px solid #f59e0b;border-radius:4px;cursor:pointer;">黑金底</button>
                                <button type="button" class="rdp-cta-mask-chip" data-color="#FFFFFF" style="padding:1px 5px;font-size:10px;background:#FFFFFF;color:#000;border:1px solid #94a3b8;border-radius:4px;cursor:pointer;">纯白</button>
                                <div class="rop-slider-combo" style="flex:1;min-width:110px;">
                                    <input type="range" id="rdp-cta-mask-opacity" class="rop-range" min="0" max="100" step="2" value="100">
                                    <input type="number" class="rop-num-readout" data-cta-link="rdp-cta-mask-opacity" min="0" max="100" step="2" value="100">
                                </div>
                            </div>

                            <label>蒙版圆角 & 内距</label>
                            <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
                                <div style="display:flex;align-items:center;gap:4px;">
                                    <span style="font-size:10px;color:var(--text-muted);white-space:nowrap;">圆角</span>
                                    <input type="number" id="rdp-cta-mask-radius" class="rop-input" min="0" max="80" step="1" value="14">
                                </div>
                                <div style="display:flex;align-items:center;gap:4px;">
                                    <span style="font-size:10px;color:var(--text-muted);white-space:nowrap;">左右内距</span>
                                    <input type="number" id="rdp-cta-pad-h" class="rop-input" min="0" max="80" step="2" value="22">
                                </div>
                            </div>

                            <label style="color:#fda4af;font-weight:600;">文字色 & 号码色</label>
                            <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
                                <div style="display:flex;align-items:center;gap:5px;">
                                    <input type="color" id="rdp-cta-text-color" class="rop-color" value="#000000" title="普通文案颜色">
                                    <span style="font-size:11px;color:var(--text-secondary);">正文色</span>
                                </div>
                                <div style="display:flex;align-items:center;gap:5px;">
                                    <input type="color" id="rdp-cta-phone-color" class="rop-color" value="#E60039" title="电话号码自动高亮颜色">
                                    <span style="font-size:11px;color:#fda4af;font-weight:600;">📞 号码高亮色</span>
                                </div>
                            </div>

                            <label>字号 & 横幅宽度</label>
                            <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
                                <div style="display:flex;align-items:center;gap:4px;">
                                    <span style="font-size:10px;color:var(--text-muted);white-space:nowrap;">字号</span>
                                    <input type="number" id="rdp-cta-fontsize" class="rop-input" min="18" max="130" step="2" value="48">
                                </div>
                                <div style="display:flex;align-items:center;gap:4px;">
                                    <span style="font-size:10px;color:var(--text-muted);white-space:nowrap;">宽度</span>
                                    <input type="number" id="rdp-cta-text-width" class="rop-input" min="260" max="1080" step="10" value="920">
                                </div>
                            </div>
                        </div>
                    </div>

                    <div class="rop-grid"><label>蒙版上下内距</label><input id="rdp-cta-pad-v" class="rop-input" type="number" min="0" max="200"><label>退场时长(秒)</label><input id="rdp-cta-out-dur" class="rop-input" type="number" min="0.05" max="10" step="0.05"></div>
                    <!-- 公共控制区: 位置调节 + 几秒后出现 + 出场动画与持续动态 (对上传电话图片与文字蒙版同时生效) -->
                    <div style="display:flex;flex-direction:column;gap:6px;padding:8px 9px;border-radius:7px;background:rgba(15,23,42,0.52);border:1px solid rgba(148,163,184,0.22);">
                        <div class="rop-grid" style="gap:5px;">
                            <label style="color:#fde047;font-weight:700;">快速定位<br><span style="font-size:10px;color:#94a3b8;font-weight:400;">(可画布直接拖移)</span></label>
                            <div style="display:flex;gap:4px;flex-wrap:wrap;">
                                <button type="button" class="rop-btn rdp-cta-pos-btn" data-pos="top" style="padding:2px 6px;font-size:10.5px;">⬆️ 顶部横幅</button>
                                <button type="button" class="rop-btn rdp-cta-pos-btn" data-pos="center" style="padding:2px 6px;font-size:10.5px;">🎯 画面正中</button>
                                <button type="button" class="rop-btn rdp-cta-pos-btn" data-pos="lower" style="padding:2px 6px;font-size:10.5px;border-color:#10b981;color:#6ee7b7;">⬇️ 中下黄金位</button>
                                <button type="button" class="rop-btn rdp-cta-pos-btn" data-pos="bottom" style="padding:2px 6px;font-size:10.5px;">⬇️ 底部贴边</button>
                                <button type="button" class="rop-btn rdp-cta-pos-btn" data-pos="center-x" style="padding:2px 6px;font-size:10.5px;">↔️ 水平居中</button>
                            </div>

                            <label>水平位置 X</label>
                            <div class="rop-slider-combo">
                                <input type="range" id="rdp-cta-x" class="rop-range" min="-540" max="540" step="2" value="0">
                                <input type="number" class="rop-num-readout" data-cta-link="rdp-cta-x" min="-1080" max="1080" step="2" value="0">
                            </div>

                            <label>垂直位置 Y</label>
                            <div class="rop-slider-combo">
                                <input type="range" id="rdp-cta-y" class="rop-range" min="-960" max="960" step="2" value="550">
                                <input type="number" class="rop-num-readout" data-cta-link="rdp-cta-y" min="-1920" max="1920" step="2" value="550">
                            </div>

                            <label style="color:#fde047;font-weight:700;">几秒后出现</label>
                            <div style="display:flex;flex-direction:column;gap:4px;">
                                <div style="display:flex;align-items:center;gap:5px;">
                                    <input type="number" id="rdp-cta-start" class="rop-input" min="0" max="3600" step="0.5" value="10" style="width:70px;font-weight:700;color:#fde047;">
                                    <span style="font-size:11px;color:var(--text-secondary);">秒出现 → 结束:</span>
                                    <input type="number" id="rdp-cta-end" class="rop-input" min="0" max="9999" step="0.5" value="9999" style="width:72px;">
                                    <button type="button" class="rop-btn" id="rdp-cta-end-full" style="padding:2px 6px;font-size:10px;" title="一直显示到视频结束">全程</button>
                                </div>
                                <div style="display:flex;gap:3px;flex-wrap:wrap;">
                                    <button type="button" class="rop-btn rdp-cta-time-chip" data-sec="0" style="padding:1px 5px;font-size:10px;">0s立即</button>
                                    <button type="button" class="rop-btn rdp-cta-time-chip" data-sec="5" style="padding:1px 5px;font-size:10px;">5s</button>
                                    <button type="button" class="rop-btn rdp-cta-time-chip" data-sec="10" style="padding:1px 5px;font-size:10px;">10s</button>
                                    <button type="button" class="rop-btn rdp-cta-time-chip" data-sec="15" style="padding:1px 5px;font-size:10px;">15s</button>
                                    <button type="button" class="rop-btn rdp-cta-time-chip" data-sec="20" style="padding:1px 5px;font-size:10px;">20s</button>
                                    <button type="button" class="rop-btn rdp-cta-time-chip" data-sec="25" style="padding:1px 5px;font-size:10px;">25s</button>
                                    <button type="button" class="rop-btn rdp-cta-time-chip" data-sec="30" style="padding:1px 5px;font-size:10px;border-color:#10b981;color:#6ee7b7;font-weight:700;">30s(默认)</button>
                                    <button type="button" class="rop-btn rdp-cta-time-chip" data-sec="45" style="padding:1px 5px;font-size:10px;">45s</button>
                                    <button type="button" class="rop-btn rdp-cta-time-chip" data-sec="60" style="padding:1px 5px;font-size:10px;">60s</button>
                                </div>
                            </div>

                            <label style="color:#a7f3d0;font-weight:600;">出场动画</label>
                            <select id="rdp-cta-anim-in" class="rop-select">
                                <option value="ring_shake">📳 来电震动弹出 (最吸睛推荐)</option>
                                <option value="pop">💥 弹跳放大 (Pop)</option>
                                <option value="elastic_pop">🍮 Q弹果冻弹出 (Elastic)</option>
                                <option value="zoom_bounce">🚀 冲刺回弹放大 (Bounce)</option>
                                <option value="slide_up">⬆️ 底部上滑推入</option>
                                <option value="slide_down">⬇️ 顶部下滑落入</option>
                                <option value="slide_left">⬅️ 右侧滑入</option>
                                <option value="slide_right">➡️ 左侧滑入</option>
                                <option value="fade">✨ 柔和渐显 (Fade)</option>
                                <option value="none">无入场动画</option>
                            </select>

                            <label>动画时长 & 退场</label>
                            <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
                                <div style="display:flex;align-items:center;gap:4px;">
                                    <span style="font-size:10px;color:var(--text-muted);white-space:nowrap;">入场(s)</span>
                                    <input type="number" id="rdp-cta-anim-dur" class="rop-input" value="0.55" min="0.1" max="3" step="0.05">
                                </div>
                                <select id="rdp-cta-anim-out" class="rop-select">
                                    <option value="fade">退场: 渐隐</option>
                                    <option value="pop">退场: 缩回</option>
                                    <option value="slide_down">退场: 下滑</option>
                                    <option value="none">退场: 无</option>
                                </select>
                            </div>

                            <label style="color:#a7f3d0;font-weight:600;">出现后动态</label>
                            <select id="rdp-cta-loop-anim" class="rop-select">
                                <option value="pulse">💓 持续呼吸放大脉冲 (推荐)</option>
                                <option value="ring">🔔 间歇来电震动提醒</option>
                                <option value="float">🎈 持续柔和上下轻浮</option>
                                <option value="none">⏸️ 保持静止</option>
                            </select>
                        </div>
                    </div>
                </div>


            <label style="display:flex;align-items:center;gap:6px;margin:8px 0;"><input type="checkbox" id="phone-apply-group">应用本层设置到当前分组 / 文件夹队列</label>
        `;
    }

    _toCtaCenterPos(ov) {
        const canvasSize = this.videoCanvas?.getCanvasSize?.() || { w: 1080, h: 1920 };
        const cw = canvasSize.w || 1080;
        const ch = canvasSize.h || 1920;
        const w = Math.max(40, Number(ov?.w) || 860);
        const h = Math.max(24, Number(ov?.h || ov?._renderedH) || 220);
        const x = Number(ov?.x) || 0;
        const y = Number(ov?.y) || 0;
        return {
            x: Math.round((x + w / 2) - cw / 2),
            y: Math.round((y + h / 2) - ch / 2),
        };
    }

    _applyCtaCenterPos(ov, centerX, centerY) {
        if (!ov) return;
        const canvasSize = this.videoCanvas?.getCanvasSize?.() || { w: 1080, h: 1920 };
        const cw = canvasSize.w || 1080;
        const ch = canvasSize.h || 1920;
        const w = Math.max(40, Number(ov.w) || 860);
        const h = Math.max(24, Number(ov.h || ov._renderedH) || 220);
        ov.x = Math.round(cw / 2 + Number(centerX || 0) - w / 2);
        ov.y = Math.round(ch / 2 + Number(centerY || 0) - h / 2);
    }

    _resolvePreviewImgUrl(src) {
        if (!src || typeof src !== 'string') return '';
        if (/^(data|blob|https?|local-media):/i.test(src)) return src;
        if (window.electronAPI && typeof window.electronAPI.toFileUrl === 'function') {
            return window.electronAPI.toFileUrl(src.replace(/^\/+([a-zA-Z]:)/, '$1'));
        }
        const clean = src.replace(/\\/g, '/');
        return clean.startsWith('/') ? `local-media://${clean}` : `local-media:///${clean}`;
    }

    _previewPhoneCtaAnim(ov) {
        const target = ov || this._getPhoneCta();
        if (!target) return;
        this._previewOverlay = target;
        target._ctaAnimPreviewStart = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        if (this._ctaPreviewRaf) cancelAnimationFrame(this._ctaPreviewRaf);
        const startWall = target._ctaAnimPreviewStart;
        const redraw = () => {
            this.videoCanvas?.render?.();
            if (typeof window.reelsUpdatePreview === 'function') window.reelsUpdatePreview(true);
            if (window.ReelsPreviewV2?.isOpen?.()) window.ReelsPreviewV2.render();
        };
        const step = () => {
            const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
            if (!target._ctaAnimPreviewStart || (now - startWall) > 2450) {
                delete target._ctaAnimPreviewStart;
                this._ctaPreviewRaf = null;
                redraw();
                return;
            }
            redraw();
            this._ctaPreviewRaf = requestAnimationFrame(step);
        };
        this._ctaPreviewRaf = requestAnimationFrame(step);
    }

    _bindPhoneCtaModuleEvents() {
        if (!this.container) return;
        const q = (sel) => this.container.querySelector(sel);

        // 绑定 range <-> number readout (data-cta-link)
        this.container.querySelectorAll('.rop-num-readout[data-cta-link]').forEach(numEl => {
            const rangeId = numEl.dataset.ctaLink;
            const rangeEl = this.container.querySelector('#' + rangeId);
            if (!rangeEl) return;
            rangeEl.addEventListener('input', () => {
                numEl.value = rangeEl.value;
                this._syncToPhoneCtaOverlay();
            });
            numEl.addEventListener('input', () => {
                rangeEl.value = numEl.value;
                this._syncToPhoneCtaOverlay();
            });
        });

        // 预览出场动画按钮
        q('#rdp-cta-preview-btn')?.addEventListener('click', (e) => {
            e.preventDefault();
            const ov = this._ensurePhoneCtaOverlay();
            if (!ov) return;

            if (typeof window !== 'undefined' && window._reelsState) {
                window._reelsState.overlaySelectedId = ov.id;
            }
            this._syncPhoneCtaUI(ov);
            this._syncScopeAndRender(ov);
            this._previewPhoneCtaAnim(ov);
        });

        // 模式切换按钮 (🖼️ 上传电话图片 vs 📝 文字蒙版号码)
        this.container.querySelectorAll('.rdp-cta-mode-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                const targetMode = btn.dataset.mode === 'image' ? 'image' : 'text';
                const ov = this._ensurePhoneCtaOverlay({ cta_mode: targetMode });
                if (!ov) return;

                ov.cta_mode = targetMode;
                if (typeof window !== 'undefined' && window._reelsState) {
                    window._reelsState.overlaySelectedId = ov.id;
                }
                this._syncScopeAndRender(ov);
                this._syncPhoneCtaUI(ov);
            });
        });

        // 上传电话图片按钮 + 文件选择器 + 拖拽上传
        const fileInput = q('#rdp-cta-file-input');
        q('#rdp-cta-upload-btn')?.addEventListener('click', (e) => {
            e.preventDefault();
            if (fileInput) {
                fileInput.value = '';
                fileInput.click();
            }
        });
        fileInput?.addEventListener('change', (e) => {
            const file = e.target.files?.[0];
            if (file) this._handlePhoneCtaImageFile(file);
        });

        const dropzone = q('#rdp-cta-img-dropzone');
        if (dropzone) {
            dropzone.addEventListener('dragover', (e) => {
                e.preventDefault();
                dropzone.style.borderColor = '#38bdf8';
                dropzone.style.background = 'rgba(14,116,144,0.28)';
            });
            dropzone.addEventListener('dragleave', () => {
                dropzone.style.borderColor = 'rgba(125,211,252,0.45)';
                dropzone.style.background = 'rgba(2,6,23,0.65)';
            });
            dropzone.addEventListener('drop', (e) => {
                e.preventDefault();
                dropzone.style.borderColor = 'rgba(125,211,252,0.45)';
                dropzone.style.background = 'rgba(2,6,23,0.65)';
                const file = e.dataTransfer?.files?.[0];
                if (file && file.type.startsWith('image/')) {
                    this._handlePhoneCtaImageFile(file);
                }
            });
        }

        // 一键复用上次上传的电话图
        q('#rdp-cta-reuse-last-btn')?.addEventListener('click', (e) => {
            e.preventDefault();
            try {
                const raw = localStorage.getItem('vk_last_phone_cta_image');
                if (!raw) return;
                const saved = JSON.parse(raw);
                if (!saved || !saved.src) return;
                if (/^data:image\//i.test(saved.src)) {
                    const match = saved.src.match(/^data:([^;,]+)/);
                    const bytes = Uint8Array.from(atob(saved.src.split(',')[1]), c => c.charCodeAt(0));
                    this._handlePhoneCtaImageFile(new File([bytes], saved.name || 'phone.png', { type: match?.[1] || 'image/png' }));
                    return;
                }
                const ov = this._ensurePhoneCtaOverlay({
                    cta_mode: 'image',
                    cta_image_src: saved.src,
                    cta_image_name: saved.name || '上次电话图片',
                });
                if (!ov) return;

                ov.cta_mode = 'image';
                ov.cta_image_src = saved.src;
                ov.cta_image_name = saved.name || '上次电话图片';
                if (saved.aspect > 0) {
                    const pos = this._toCtaCenterPos(ov);
                    ov.h = Math.max(30, Math.round((ov.w || 880) / saved.aspect));
                    this._applyCtaCenterPos(ov, pos.x, pos.y);
                }
                if (typeof window !== 'undefined' && window._reelsState) {
                    window._reelsState.overlaySelectedId = ov.id;
                }
                this._syncScopeAndRender(ov);
                this._syncPhoneCtaUI(ov);
                this._previewPhoneCtaAnim(ov);
            } catch (_) {}
        });

        // 清除已上传电话图片并切回文字模式
        q('#rdp-cta-clear-img-btn')?.addEventListener('click', (e) => {
            e.preventDefault();
            const ov = this._getPhoneCta();
            if (!ov) return;
            ov.cta_image_src = '';
            ov.cta_image_name = '';
            ov.cta_mode = 'text';
            this._syncPhoneCtaUI(ov);
            this._syncScopeAndRender(ov);
        });

        // 预设模板下拉切换
        q('#rdp-cta-style')?.addEventListener('change', (e) => {
            const ov = this._ensurePhoneCtaOverlay({ cta_mode: 'text' });
            if (!ov) return;

            ov.cta_mode = 'text';
            window.ReelsOverlay?.applyPhoneCtaStylePreset?.(ov, e.target.value);
            this._syncPhoneCtaUI(ov);
            this._syncScopeAndRender(ov);
        });

        // 快捷蒙版色块
        this.container.querySelectorAll('.rdp-cta-mask-chip').forEach(chip => {
            chip.addEventListener('click', (e) => {
                e.preventDefault();
                const col = chip.dataset.color || '#E0FF14';
                this._setVal('rdp-cta-mask-color', col);
                this._syncToPhoneCtaOverlay();
            });
        });

        // 快速定位按钮 (顶部 / 正中 / 中下黄金位 / 底部 / 水平居中)
        this.container.querySelectorAll('.rdp-cta-pos-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                const ov = this._ensurePhoneCtaOverlay();
                if (!ov) return;
                const posKey = btn.dataset.pos || 'lower';
                const curPos = this._toCtaCenterPos(ov);
                const posMap = {
                    top: -715,
                    center: 0,
                    lower: 550,
                    bottom: 780,
                };
                const nextX = posKey === 'center-x' ? 0 : 0;
                const nextY = posKey === 'center-x' ? curPos.y : (posMap[posKey] ?? 550);
                this._setVal('rdp-cta-x', nextX);
                this._setVal('rdp-cta-y', nextY);
                this._syncToPhoneCtaOverlay();
            });
        });

        // 快速出现秒数按钮 (0s / 5s / 10s / 15s / 20s / 25s / 30s / 45s / 60s)
        this.container.querySelectorAll('.rdp-cta-time-chip').forEach(chip => {
            chip.addEventListener('click', (e) => {
                e.preventDefault();
                const sec = Math.max(0, parseFloat(chip.dataset.sec) || 0);
                this._setVal('rdp-cta-start', sec);
                this._syncToPhoneCtaOverlay();
            });
        });

        // 结束时间：全程按钮
        q('#rdp-cta-end-full')?.addEventListener('click', (e) => {
            e.preventDefault();
            this._setVal('rdp-cta-end', 9999);
            this._syncToPhoneCtaOverlay();
        });

        // 绑定所有表单输入项到 _syncToPhoneCtaOverlay
        const ctaFieldIds = [
            'rdp-cta-body', 'rdp-cta-title',
            'rdp-cta-mask-mode', 'rdp-cta-mask-color', 'rdp-cta-mask-radius', 'rdp-cta-pad-h',
            'rdp-cta-text-color', 'rdp-cta-phone-color',
            'rdp-cta-fontsize', 'rdp-cta-text-width', 'rdp-cta-pad-v', 'rdp-cta-out-dur',
            'rdp-cta-start', 'rdp-cta-end',
            'rdp-cta-anim-in', 'rdp-cta-anim-dur', 'rdp-cta-anim-out', 'rdp-cta-loop-anim',
        ];
        ctaFieldIds.forEach(id => {
            const el = q('#' + id);
            if (!el) return;
            const onChange = () => {
                this._syncToPhoneCtaOverlay();
                if (id === 'rdp-cta-anim-in' || id === 'rdp-cta-loop-anim') {
                    this._previewPhoneCtaAnim();
                }
            };
            el.addEventListener('input', onChange);
            el.addEventListener('change', onChange);
        });
    }

    _handlePhoneCtaImageFile(file) {
        if (!file) return;
        const selected = this._getPhoneCta();
        const token = this._uploadToken = (this._uploadToken || 0) + 1;
        if (!selected) return;
        const applyLoadedImage = async (imgSrc, fileName) => {
            if (/^data:image\//i.test(imgSrc)) {
                try {
                    const response = await apiFetch(API_BASE + '/media/phone-cta-image', {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ data_url: imgSrc }),
                    });
                    const result = await response.json();
                    if (!response.ok || !result.path) throw new Error(result.error || '图片保存失败');
                    imgSrc = result.path;
                } catch (error) { window.showToast?.(error.message, 'error'); return; }
            }
            if (this._getPhoneCta() !== selected || this._uploadToken !== token) return;
            const ov = this._ensurePhoneCtaOverlay({
                cta_mode: 'image',
                cta_image_src: imgSrc,
                cta_image_name: fileName,
            });
            if (!ov) return;
            ov.cta_mode = 'image';
            ov.cta_image_src = imgSrc;
            ov.cta_image_name = fileName || '自定义电话图片';
            if (!ov.w || ov.w < 120) ov.w = 880;
            if (!ov.cta_image_scale) ov.cta_image_scale = 100;

            const probeImg = new Image();
            probeImg.onload = () => {
                if (this._getPhoneCta() !== selected || this._uploadToken !== token || ov.cta_image_src !== imgSrc) return;
                window.ReelsOverlay?.primeImageCache?.(imgSrc, probeImg);
                const nw = probeImg.naturalWidth || probeImg.width || 880;
                const nh = probeImg.naturalHeight || probeImg.height || 220;
                const aspect = nw / Math.max(1, nh);
                const curPos = this._toCtaCenterPos(ov);
                ov.h = Math.max(30, Math.round((ov.w || 880) / aspect));
                this._applyCtaCenterPos(ov, curPos.x, curPos.y);
                try {
                    if (imgSrc.length < 2_500_000) {
                        localStorage.setItem('vk_last_phone_cta_image', JSON.stringify({
                            src: imgSrc,
                            name: ov.cta_image_name,
                            aspect,
                        }));
                    }
                } catch (_) {}
                this._syncPhoneCtaUI(ov);
                this._syncScopeAndRender(ov);
                this._previewPhoneCtaAnim(ov);
            };
            probeImg.onerror = () => {
                if (this._getPhoneCta() !== selected || this._uploadToken !== token) return;
                this._syncPhoneCtaUI(ov);
                this._syncScopeAndRender(ov);
            };
            probeImg.src = this._resolvePreviewImgUrl(imgSrc);

            if (typeof window !== 'undefined' && window._reelsState) {
                window._reelsState.overlaySelectedId = ov.id;
            }
            this._syncPhoneCtaUI(ov);
            this._syncScopeAndRender(ov);
        };

        const nativePath = (typeof getFileNativePath === 'function') ? getFileNativePath(file) : (file.path || '');
        if (nativePath && nativePath !== file.name) {
            applyLoadedImage(nativePath, file.name || nativePath.split(/[\\/]/).pop());
            return;
        }
        const reader = new FileReader();
        reader.onload = () => {
            const dataUrl = String(reader.result || '');
            if (dataUrl) applyLoadedImage(dataUrl, file.name || '自定义电话图片');
        };
        reader.readAsDataURL(file);
    }

    _syncPhoneCtaUI(ov = undefined) {
        if (!this.container) return;
        const target = ov !== undefined ? ov : this._getPhoneCta();
        this._syncingCta = true;
        try {
            const exists = Boolean(target);
            const isEnabled = Boolean(target && !target.disabled);
            this._setVal('rdp-cta-enable', isEnabled);

            const badge = this.container.querySelector('#rdp-cta-status-badge');
            if (badge) {
                if (!exists) {
                    badge.textContent = '未添加 (勾选或上传图片即启用)';
                    badge.style.background = 'rgba(148,163,184,0.18)';
                    badge.style.color = '#cbd5e1';
                    badge.style.borderColor = 'rgba(148,163,184,0.38)';
                } else if (isEnabled) {
                    const startSec = Number(target.start ?? 10);
                    const modeTag = (target.cta_mode === 'image' && target.cta_image_src) ? '图片模式' : '文字模式';
                    badge.textContent = `已启用 · ${modeTag} · ${startSec}s弹出`;
                    badge.style.background = 'rgba(16,185,129,0.26)';
                    badge.style.color = '#6ee7b7';
                    badge.style.borderColor = 'rgba(52,211,153,0.55)';
                } else {
                    badge.textContent = '已暂停·不显示';
                    badge.style.background = 'rgba(239,68,68,0.22)';
                    badge.style.color = '#fca5a5';
                    badge.style.borderColor = 'rgba(248,113,113,0.48)';
                }
            }

            // 检查是否有上次保存的电话图可供一键复用
            const reuseBtn = this.container.querySelector('#rdp-cta-reuse-last-btn');
            if (reuseBtn) {
                let hasSaved = false;
                try { hasSaved = Boolean(localStorage.getItem('vk_last_phone_cta_image')); } catch (_) {}
                reuseBtn.style.display = hasSaved ? 'inline-block' : 'none';
            }

            const mode = (target?.cta_mode === 'image' || (!target?.cta_mode && target?.cta_image_src)) ? 'image' : 'text';
            const imgBtn = this.container.querySelector('#rdp-cta-mode-image');
            const txtBtn = this.container.querySelector('#rdp-cta-mode-text');
            if (imgBtn) {
                const act = mode === 'image';
                imgBtn.style.background = act ? 'linear-gradient(135deg,#0284c7,#2563eb)' : 'rgba(15,23,42,0.55)';
                imgBtn.style.borderColor = act ? '#7dd3fc' : '#334155';
                imgBtn.style.color = act ? '#ffffff' : '#94a3b8';
                imgBtn.style.boxShadow = act ? '0 0 0 1px rgba(125,211,252,0.45)' : 'none';
            }
            if (txtBtn) {
                const act = mode === 'text';
                txtBtn.style.background = act ? 'linear-gradient(135deg,#059669,#10b981)' : 'rgba(15,23,42,0.55)';
                txtBtn.style.borderColor = act ? '#6ee7b7' : '#334155';
                txtBtn.style.color = act ? '#ffffff' : '#94a3b8';
                txtBtn.style.boxShadow = act ? '0 0 0 1px rgba(110,231,183,0.45)' : 'none';
            }

            const imgSec = this.container.querySelector('#rdp-cta-image-section');
            const txtSec = this.container.querySelector('#rdp-cta-text-section');
            if (imgSec) imgSec.style.display = mode === 'image' ? 'flex' : 'none';
            if (txtSec) txtSec.style.display = mode === 'text' ? 'flex' : 'none';

            // 同步图片预览
            const imgSrc = target?.cta_image_src || '';
            const thumbEl = this.container.querySelector('#rdp-cta-img-thumb');
            const nameEl = this.container.querySelector('#rdp-cta-img-name');
            const clearImgBtn = this.container.querySelector('#rdp-cta-clear-img-btn');
            if (thumbEl) {
                if (imgSrc) {
                    thumbEl.src = this._resolvePreviewImgUrl(imgSrc);
                    thumbEl.style.display = 'block';
                } else {
                    thumbEl.removeAttribute('src');
                    thumbEl.style.display = 'none';
                }
            }
            if (nameEl) {
                nameEl.textContent = imgSrc
                    ? `已加载电话图: ${target?.cta_image_name || (imgSrc.startsWith('data:') ? '自定义电话图片' : imgSrc.split(/[\\/]/).pop())}`
                    : '尚未上传电话图片（支持点击上方按钮或直接把图片拖进此处）';
                nameEl.style.color = imgSrc ? '#6ee7b7' : '#e0f2fe';
            }
            if (clearImgBtn) {
                clearImgBtn.style.display = imgSrc ? 'inline-block' : 'none';
            }

            if (!target) return;

            const setCtaVal = (id, val) => {
                const el = this.container.querySelector('#' + id);
                if (!el) return;
                el.value = val;
                const ro = this.container.querySelector(`.rop-num-readout[data-cta-link="${id}"]`);
                if (ro) ro.value = val;
            };

            const wVal = Math.round(Number(target.w) || 880);
            setCtaVal('rdp-cta-pad-v', target.cta_mask_pad_v ?? target.body_bg_pad_top ?? 14);
            setCtaVal('rdp-cta-out-dur', target.anim_out_duration ?? 0.3);
            setCtaVal('rdp-cta-img-width', wVal);
            setCtaVal('rdp-cta-img-scale', Math.round(Number(target.cta_image_scale) || 100));
            setCtaVal('rdp-cta-text-width', wVal);
            setCtaVal('rdp-cta-style', target.cta_style_id || 'whatsapp_lime_inline');
            setCtaVal('rdp-cta-body', target.body_text ?? '');
            setCtaVal('rdp-cta-title', target.title_text ?? '');

            const maskMode = target.cta_mask_mode
                || (target.body_bg_enabled ? (target.body_bg_mode || 'inline-joined') : (target.card_enabled !== false ? 'card' : 'none'));
            const maskColor = target.cta_mask_color || (maskMode === 'card' ? (target.card_color || '#0B1021') : (target.body_bg_color || '#E0FF14'));
            const maskOp = target.cta_mask_opacity ?? (maskMode === 'card' ? (target.card_opacity ?? 92) : (target.body_bg_opacity ?? 100));
            const maskRad = target.cta_mask_radius ?? (maskMode === 'card' ? (target.radius_tl ?? 36) : (target.body_bg_radius ?? 14));
            const padH = target.cta_mask_pad_h ?? (target.body_bg_pad_h ?? 22);

            setCtaVal('rdp-cta-mask-mode', maskMode);
            setCtaVal('rdp-cta-mask-color', maskColor);
            setCtaVal('rdp-cta-mask-opacity', maskOp);
            setCtaVal('rdp-cta-mask-radius', maskRad);
            setCtaVal('rdp-cta-pad-h', padH);
            setCtaVal('rdp-cta-text-color', target.body_color || '#000000');
            setCtaVal('rdp-cta-phone-color', target.cta_phone_color || '#E60039');
            setCtaVal('rdp-cta-fontsize', target.body_fontsize ?? 48);

            const pos = this._toCtaCenterPos(target);
            setCtaVal('rdp-cta-x', pos.x);
            setCtaVal('rdp-cta-y', pos.y);

            const startSec = Number(target.start ?? 10);
            const endSec = Number(target.end ?? 9999);
            setCtaVal('rdp-cta-start', startSec);
            setCtaVal('rdp-cta-end', endSec);
            this.container.querySelectorAll('.rdp-cta-time-chip').forEach(btn => {
                const chipSec = parseFloat(btn.dataset.sec);
                const active = Math.abs(chipSec - startSec) < 0.01;
                btn.style.borderColor = active ? '#10b981' : '';
                btn.style.color = active ? '#6ee7b7' : '';
                btn.style.fontWeight = active ? '700' : '';
                btn.style.background = active ? 'rgba(16,185,129,0.2)' : '';
            });

            setCtaVal('rdp-cta-anim-in', target.anim_in_type || 'ring_shake');
            setCtaVal('rdp-cta-anim-dur', target.anim_in_duration ?? 0.55);
            setCtaVal('rdp-cta-anim-out', target.anim_out_type || 'fade');
            setCtaVal('rdp-cta-loop-anim', target.cta_loop_anim || 'pulse');
        } finally {
            this._syncingCta = false;
        }
    }

    _syncToPhoneCtaOverlay() {
        if (this._syncingCta) return;
        const ov = this._ensurePhoneCtaOverlay();
        if (!ov) return;

        const mode = (ov.cta_mode === 'image' || (!ov.cta_mode && ov.cta_image_src)) ? 'image' : 'text';
        if (mode === 'image') {
            ov.w = Math.max(80, Number(this._getVal('rdp-cta-img-width') ?? ov.w ?? 880));
            ov.cta_image_scale = Math.max(10, Math.min(300, Number(this._getVal('rdp-cta-img-scale') ?? ov.cta_image_scale ?? 100)));
        } else {
            ov.w = Math.max(200, Number(this._getVal('rdp-cta-text-width') ?? ov.w ?? 920));
            ov.body_text = String(this._getVal('rdp-cta-body') ?? ov.body_text ?? '');
            ov.title_text = String(this._getVal('rdp-cta-title') ?? ov.title_text ?? '');
            ov.body_fontsize = Math.max(16, Number(this._getVal('rdp-cta-fontsize') ?? ov.body_fontsize ?? 48));
            ov.cta_mask_mode = this._getVal('rdp-cta-mask-mode') || 'inline-joined';
            ov.cta_mask_color = this._getVal('rdp-cta-mask-color') || '#E0FF14';
            ov.cta_mask_opacity = Math.max(0, Math.min(100, Number(this._getVal('rdp-cta-mask-opacity') ?? 100)));
            ov.cta_mask_radius = Math.max(0, Number(this._getVal('rdp-cta-mask-radius') ?? 14));
            ov.cta_mask_pad_h = Math.max(0, Number(this._getVal('rdp-cta-pad-h') ?? 22));
            ov.body_color = this._getVal('rdp-cta-text-color') || '#000000';
            ov.cta_phone_color = this._getVal('rdp-cta-phone-color') || '#E60039';
            window.ReelsOverlay?.syncPhoneCtaMaskAndColors?.(ov);
        }

        ov.cta_mask_pad_v = Math.max(0, Number(this._getVal('rdp-cta-pad-v') ?? ov.cta_mask_pad_v ?? 14));
        ov.anim_out_duration = Math.max(0.05, Number(this._getVal('rdp-cta-out-dur') ?? ov.anim_out_duration ?? 0.3));
        if (mode !== 'image') window.ReelsOverlay?.syncPhoneCtaMaskAndColors?.(ov);
        const centerX = Number(this._getVal('rdp-cta-x') ?? 0);
        const centerY = Number(this._getVal('rdp-cta-y') ?? 550);
        ov.auto_center_v = false;
        this._applyCtaCenterPos(ov, centerX, centerY);

        const startSec = Math.max(0, Number(this._getVal('rdp-cta-start') ?? 10));
        const endSec = Math.max(0, Number(this._getVal('rdp-cta-end') ?? 9999));
        ov.start = startSec;
        ov.mask_start = startSec;
        ov.end = endSec;
        ov.mask_end = endSec;

        ov.anim_in_type = this._getVal('rdp-cta-anim-in') || 'ring_shake';
        ov.anim_in_duration = Math.max(0.05, Number(this._getVal('rdp-cta-anim-dur') ?? 0.55));
        ov.anim_out_type = this._getVal('rdp-cta-anim-out') || 'fade';
        ov.cta_loop_anim = this._getVal('rdp-cta-loop-anim') || 'pulse';

        if (typeof window !== 'undefined' && window._reelsState) {
            window._reelsState.overlaySelectedId = ov.id;
        }
        this._syncScopeAndRender(ov);
        this._syncPhoneCtaUI(ov);
    }

    _syncScopeAndRender(ov) {
        if (!ov) return;
        const oldType = ov.type;
        if (ov.cta_mode === 'image') {
            const src = ov.cta_image_src || '';
            ov.type = /\.gif(?:[?#]|$)/i.test(src) || /^data:image\/gif/i.test(src) ? 'video' : 'image';
            ov.content = src;
            ov.scale = Math.max(0.1, Math.min(3, (ov.cta_image_scale || 100) / 100));
            ov.scale_x = ov.scale_y = ov.scale;
            ov.keep_aspect = true;
        } else {
            ov.type = 'textcard';
            window.ReelsOverlay.syncPhoneCtaMaskAndColors(ov);
        }
        if (this.container.querySelector('#phone-apply-group')?.checked) this._syncParametersToGroup(ov);
        window.ReelsOverviewBatch?.modelChanged?.(this.linkedOverlayPanel, ov);
        this.videoCanvas?.onOverlayChange?.(ov, { source: this.linkedOverlayPanel });
        if (oldType !== ov.type) this.linkedOverlayPanel.selectOverlay(ov);
        else this.linkedOverlayPanel._syncFromOverlay(ov);
        this.linkedOverlayPanel._refreshList();
        this.videoCanvas?.render?.();
        window.ReelsPreviewV2?.requestRender?.();
    }
    _syncParametersToGroup(ov) {
        const source = this.videoCanvas?.overlayMgr?.overlays || [];
        const ordinal = source.filter(layer => layer.is_phone_cta).indexOf(ov);
        const tasks = this.videoCanvas?.scopedTask ? [this.videoCanvas.scopedTask]
            : typeof _getCurrentReelsGroupTasks === 'function' ? _getCurrentReelsGroupTasks() : [];
        for (const task of tasks) {
            const cover = !this.videoCanvas?.scopedTask && window._reelsState?._coverEditMode;
            const layers = (cover ? task.cover?.overlays : task.overlays) || [];
            const target = ov.slotKey ? layers.find(o => o.is_phone_cta && o.slotKey === ov.slotKey)
                : layers.filter(o => o.is_phone_cta)[ordinal];
            if (!target || target === ov) continue;
            for (const [key, value] of Object.entries(ov)) {
                if (key.startsWith('_') || ['id','name','slotKey','slotLabel','disabled','z_index'].includes(key)) continue;
                target[key] = typeof value === 'object' && value !== null ? JSON.parse(JSON.stringify(value)) : value;
            }
        }
    }
    refresh() {
        const ov = this._getPhoneCta();
        if (!ov) return;
        preparePhoneOverlay(ov);
        if (ov.cta_mode === 'image') ov.cta_image_scale = Math.round((ov.scale_x ?? ov.scale ?? 1) * 100);
        this._syncPhoneCtaUI(ov);
    }
    dispose() {
        if (this._ctaPreviewRaf) cancelAnimationFrame(this._ctaPreviewRaf);
        const ov = this._previewOverlay;
        if (ov) delete ov._ctaAnimPreviewStart;
        this._uploadToken = (this._uploadToken || 0) + 1;
    }
}
window.ReelsCtaPanel = { prepareOverlay: preparePhoneOverlay };
window.ReelsPhoneCtaPanel = ReelsPhoneCtaPanel;
window.addEventListener('reels-overlay-selection-changed', event => {
    const { panel, overlay } = event.detail || {};
    const root = panel?.container?.querySelector('#rop-phone-cta-props');
    if (!root) return;
    root.style.display = overlay?.is_phone_cta ? 'block' : 'none';
    if (panel._ctaEditor?._boundOverlay !== overlay) panel._ctaEditor?.dispose();
    if (!overlay?.is_phone_cta) return;
    if (!panel._ctaEditor) panel._ctaEditor = new ReelsPhoneCtaPanel(root, panel.videoCanvas, panel);
    else panel._ctaEditor.refresh();
    panel._ctaEditor._boundOverlay = overlay;
});
})();
