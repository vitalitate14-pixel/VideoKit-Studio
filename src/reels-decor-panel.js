/* Particle effect controls embedded in the native overlay property panel. */
(() => {
class ReelsDecorPanel {
    constructor(container, videoCanvasProxy, linkedOverlayPanel) {
        this.container = container;
        this.videoCanvas = videoCanvasProxy;
        this.linkedOverlayPanel = linkedOverlayPanel;
        this._activeCategory = 'all';
        this._syncing = false;
        this._renderUI();
        this._bindEvents();
        this.refresh();
    }

    _getSelectedDecor() {
        const ov = this.linkedOverlayPanel?._selectedOv;
        return ov?.type === 'decor' ? ov : null;
    }

    _ensureDecorOverlay() {
        return this._getSelectedDecor();
    }

    _renderUI() {
        if (!this.container) return;
        const styles = window.ReelsOverlay?.DECOR_OVERLAY_STYLES || {};
        const styleEntries = Object.entries(styles);

        const catBadgeMap = {
            dark_particles: { bg: 'linear-gradient(135deg,#090d16,#1e293b)', border: '#475569', text: '#e2e8f0', tag: '🖤 黑色&粒子' },
            film_grain:     { bg: 'linear-gradient(135deg,#271c12,#451a03)', border: '#d97706', text: '#fde68a', tag: '🎞️ 电影颗粒' },
            stars:          { bg: 'linear-gradient(135deg,#1e1b4b,#3b0764)', border: '#eab308', text: '#fef08a', tag: '🌟 星芒光斑' },
            xmas:           { bg: 'linear-gradient(135deg,#14532d,#7f1d1d)', border: '#f87171', text: '#fef9c3', tag: '🎄 圣诞限定' },
            frame:          { bg: 'linear-gradient(135deg,#292524,#44403c)', border: '#d4af37', text: '#fde68a', tag: '⚜️ 复古画框' },
        };

        const cardsHtml = styleEntries.map(([id, cfg], idx) => {
            const theme = catBadgeMap[cfg.category] || catBadgeMap.stars;
            return `
                <button type="button" class="rdp-preset-card" data-style-id="${id}" data-cat="${cfg.category || 'stars'}"
                    style="display:flex;flex-direction:column;align-items:flex-start;gap:3px;padding:7px 8px;border-radius:7px;background:${theme.bg};border:1px solid ${theme.border};color:${theme.text};cursor:pointer;text-align:left;transition:all 0.15s;">
                    <div style="display:flex;width:100%;justify-content:space-between;align-items:center;gap:4px;">
                        <span style="font-size:10px;opacity:0.82;padding:1px 5px;border-radius:4px;background:rgba(0,0,0,0.35);">${idx + 1}. ${theme.tag}</span>
                        <span style="display:inline-flex;gap:3px;">
                            <i style="width:9px;height:9px;border-radius:50%;background:${cfg.color1 || '#FFD700'};display:inline-block;border:1px solid rgba(255,255,255,0.4);"></i>
                            <i style="width:9px;height:9px;border-radius:50%;background:${cfg.color2 || '#FFFFFF'};display:inline-block;border:1px solid rgba(255,255,255,0.4);"></i>
                        </span>
                    </div>
                    <div style="font-size:11.5px;font-weight:700;line-height:1.25;word-break:break-word;">${cfg.name}</div>
                </button>
            `;
        }).join('');

        const selectOptionsHtml = styleEntries.map(([id, cfg], idx) =>
            `<option value="${id}">${idx + 1}. ${cfg.name}</option>`
        ).join('');

        this.container.innerHTML = `
            <div class="rop-root rdp-root" style="display:flex;flex-direction:column;gap:8px;font-size:12px;color:var(--text-primary,#e2e8f0);">
                <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
                    <span style="font-weight:700;">✨ 粒子参数</span>
                    <button type="button" id="rdp-fit-full-btn" class="rop-btn">📐 全屏</button>
                    <button type="button" id="rdp-fit-card-btn" class="rop-btn">🎯 贴合中间</button>
                </div>
                <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
                    <label for="rdp-style-scope">参数作用：</label>
                    <select id="rdp-style-scope" class="rop-select" style="width:auto;">
                        <option value="task">仅当前任务</option>
                        <option value="folder" selected>当前分组 / 文件夹队列</option>
                        <option value="all">全部任务</option>
                    </select>
                    <label style="display:flex;align-items:center;gap:4px;"><input type="checkbox" id="rdp-apply-all">同步本层参数</label>
                </div>
                <!-- 30款模板分类筛选与可视化卡片库 -->
                <div style="padding:8px 10px;background:var(--bg-tertiary,#181a24);border:1px solid var(--border-color,#2d3142);border-radius:8px;">
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;gap:6px;flex-wrap:wrap;">
                        <span style="font-size:11.5px;font-weight:700;color:#93c5fd;">🎨 30款预设库 (点击任意卡片立即应用)：</span>
                        <select id="rdp-style-select" class="rop-select" style="max-width:210px;font-size:11px;padding:2px 6px;">
                            ${selectOptionsHtml}
                        </select>
                    </div>
                    <div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:8px;">
                        <button type="button" class="rdp-cat-btn active" data-cat="all" style="padding:3px 7px;font-size:11px;border-radius:5px;border:1px solid #6366f1;background:#4f46e5;color:#fff;cursor:pointer;font-weight:700;">全部 (30)</button>
                        <button type="button" class="rdp-cat-btn" data-cat="dark_particles" style="padding:3px 7px;font-size:11px;border-radius:5px;border:1px solid #475569;background:#1e293b;color:#e2e8f0;cursor:pointer;">🖤 黑色模板&粒子 (7)</button>
                        <button type="button" class="rdp-cat-btn" data-cat="film_grain" style="padding:3px 7px;font-size:11px;border-radius:5px;border:1px solid #b45309;background:#271c12;color:#fde68a;cursor:pointer;">🎞️ 电影&回忆颗粒 (7)</button>
                        <button type="button" class="rdp-cat-btn" data-cat="stars" style="padding:3px 7px;font-size:11px;border-radius:5px;border:1px solid #a16207;background:#1e1b4b;color:#fef08a;cursor:pointer;">🌟 发光星芒&光斑 (6)</button>
                        <button type="button" class="rdp-cat-btn" data-cat="xmas" style="padding:3px 7px;font-size:11px;border-radius:5px;border:1px solid #15803d;background:#14532d;color:#fef9c3;cursor:pointer;">🎄 圣诞装饰 (5)</button>
                        <button type="button" class="rdp-cat-btn" data-cat="frame" style="padding:3px 7px;font-size:11px;border-radius:5px;border:1px solid #a16207;background:#292524;color:#fde68a;cursor:pointer;">⚜️ 复古画框 (5)</button>
                    </div>
                    <div id="rdp-preset-grid" style="display:grid;grid-template-columns:repeat(2, minmax(0, 1fr));gap:6px;max-height:255px;overflow-y:auto;padding-right:2px;">
                        ${cardsHtml}
                    </div>
                </div>

                <!-- 专区1: 🖤 黑色氛围模板 & 宽银幕暗角调节 -->
                <div class="rop-group" style="padding:8px 10px;background:var(--bg-tertiary,#181a24);border:1px solid var(--border-color,#2d3142);border-radius:8px;">
                    <div style="display:flex;justify-content:space-between;align-items:center;margin:0 0 6px 0;">
                        <div class="rop-group-title" style="margin:0;color:#f87171;">🖤 1. 黑色氛围模板 & 电影暗角遮罩</div>
                        <label style="display:flex;align-items:center;gap:5px;font-size:11.5px;font-weight:700;color:#fecaca;cursor:pointer;margin:0;" title="勾选后启用黑色氛围模板和电影暗角；取消勾选则关闭黑底暗角">
                            <input type="checkbox" id="rdp-dark-enabled" checked style="width:14px;height:14px;accent-color:#ef4444;cursor:pointer;">
                            <span>启用黑色模板</span>
                        </label>
                    </div>
                    <div class="rop-grid">
                        <label title="四周暗黑遮罩与上下宽银幕暗角浓度">黑色模板浓度%</label>
                        <div class="rop-slider-combo"><input type="range" id="rdp-dark-vignette" class="rop-range" min="0" max="100" step="2" value="78"><input type="number" class="rop-num-readout" data-link="rdp-dark-vignette" min="0" max="100" step="2" value="78"></div>

                        <label title="暗角向画面中心聚拢扩散的范围">暗角扩散范围%</label>
                        <div class="rop-slider-combo"><input type="range" id="rdp-vignette-spread" class="rop-range" min="10" max="95" step="5" value="62"><input type="number" class="rop-num-readout" data-link="rdp-vignette-spread" min="10" max="95" step="5" value="62"></div>

                        <label>暗底氛围色调</label>
                        <div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;">
                            <input type="color" id="rdp-dark-tint" class="rop-color" value="#05070C" style="width:32px;height:24px;">
                            <button type="button" class="rdp-tint-chip" data-tint="#05070C" style="padding:2px 5px;font-size:10px;background:#05070C;color:#e2e8f0;border:1px solid #475569;border-radius:4px;cursor:pointer;">纯黑</button>
                            <button type="button" class="rdp-tint-chip" data-tint="#0B0503" style="padding:2px 5px;font-size:10px;background:#1c0a05;color:#fdba74;border:1px solid #9a3412;border-radius:4px;cursor:pointer;">黑金余烬</button>
                            <button type="button" class="rdp-tint-chip" data-tint="#261507" style="padding:2px 5px;font-size:10px;background:#261507;color:#fde68a;border:1px solid #b45309;border-radius:4px;cursor:pointer;">怀旧深褐</button>
                            <button type="button" class="rdp-tint-chip" data-tint="#040814" style="padding:2px 5px;font-size:10px;background:#040814;color:#93c5fd;border:1px solid #1d4ed8;border-radius:4px;cursor:pointer;">暗夜蓝</button>
                            <button type="button" class="rdp-tint-chip" data-tint="#040C08" style="padding:2px 5px;font-size:10px;background:#040C08;color:#86efac;border:1px solid #15803d;border-radius:4px;cursor:pointer;">森林暗绿</button>
                        </div>
                    </div>
                </div>

                <!-- 专区2: 🎞️ 电影颗粒 & 回忆颗粒感调节 -->
                <div class="rop-group" style="padding:8px 10px;background:var(--bg-tertiary,#181a24);border:1px solid var(--border-color,#2d3142);border-radius:8px;">
                    <div style="display:flex;justify-content:space-between;align-items:center;margin:0 0 6px 0;">
                        <div class="rop-group-title" style="margin:0;color:#fbbf24;">🎞️ 2. 电影颗粒 & 怀旧回忆颗粒感</div>
                        <label style="display:flex;align-items:center;gap:5px;font-size:11.5px;font-weight:700;color:#fde68a;cursor:pointer;margin:0;" title="勾选后启用电影胶片颗粒与怀旧暖调；取消勾选则关闭颗粒噪点">
                            <input type="checkbox" id="rdp-grain-enabled" checked style="width:14px;height:14px;accent-color:#f59e0b;cursor:pointer;">
                            <span>启用电影颗粒</span>
                        </label>
                    </div>
                    <div class="rop-grid">
                        <label title="35mm/8mm胶片噪点与回忆颗粒感强度">电影颗粒强度%</label>
                        <div class="rop-slider-combo"><input type="range" id="rdp-grain-intensity" class="rop-range" min="0" max="100" step="2" value="24"><input type="number" class="rop-num-readout" data-link="rdp-grain-intensity" min="0" max="100" step="2" value="24"></div>

                        <label title="胶片颗粒的粗细大小">颗粒粗细度%</label>
                        <div class="rop-slider-combo"><input type="range" id="rdp-grain-size" class="rop-range" min="50" max="250" step="5" value="100"><input type="number" class="rop-num-readout" data-link="rdp-grain-size" min="50" max="250" step="5" value="100"></div>

                        <label title="老照片泛黄暖调回忆感">怀旧泛黄暖调%</label>
                        <div class="rop-slider-combo"><input type="range" id="rdp-grain-warmth" class="rop-range" min="0" max="100" step="5" value="0"><input type="number" class="rop-num-readout" data-link="rdp-grain-warmth" min="0" max="100" step="5" value="0"></div>

                        <label>📽️ 启用老电影划痕/扫描线</label><input type="checkbox" id="rdp-film-scratches">
                        <label>🌅 启用复古胶片边缘漏光</label><input type="checkbox" id="rdp-light-leak">
                    </div>
                </div>

                <!-- 专区3: ✨ 飘浮粒子 & 发光星芒 & 圣诞装饰组合 -->
                <div class="rop-group" style="padding:8px 10px;background:var(--bg-tertiary,#181a24);border:1px solid var(--border-color,#2d3142);border-radius:8px;">
                    <div class="rop-group-title" style="margin:0 0 6px 0;color:#38bdf8;">✨ 3. 子效果自由勾选开关 (打勾即启用，自由混搭您想要的效果)</div>
                    <div class="rop-grid">
                        <label>✨ 启用飘浮粒子</label><input type="checkbox" id="rdp-floating-particles" checked>
                        <label>飘浮粒子形态</label>
                        <select id="rdp-particle-mode" class="rop-select">
                            <option value="dust">🖤 悬浮微尘粒子 (Dust)</option>
                            <option value="embers">🔥 升腾火星余烬 (Embers)</option>
                            <option value="fireflies">✨ 森林萤火虫 (Fireflies)</option>
                            <option value="ash">🌨️ 银白灰烬细雪 (Ash)</option>
                            <option value="neon">⚡ 赛博霓虹微粒 (Neon)</option>
                            <option value="sunset_bokeh">🌇 落日暖阳大光斑 (Bokeh)</option>
                            <option value="prism">💎 钻石棱镜星芒 (Prism)</option>
                        </select>
                        <label>🌟 启用发光闪烁星芒</label><input type="checkbox" id="rdp-glow-stars">
                        <label>❄️ 启用漫天飘雪与冰晶</label><input type="checkbox" id="rdp-snowflakes">
                        <label>🎀 启用四角主题挂饰</label><input type="checkbox" id="rdp-corner-ornaments">
                        <label>🌿 启用边缘花环/串灯/画框</label><input type="checkbox" id="rdp-edge-garland">
                    </div>
                </div>

                <!-- 专区4: 📐 分布区域 / 密度 / 尺寸 / 速度 / 边距 / 配色 -->
                <div class="rop-group" style="padding:8px 10px;background:var(--bg-tertiary,#181a24);border:1px solid var(--border-color,#2d3142);border-radius:8px;">
                    <div class="rop-group-title" style="margin:0 0 6px 0;color:#a78bfa;">📐 4. 密度 / 尺寸 / 速度 / 边距 / 颜色精调</div>
                    <div class="rop-grid">
                        <label>分布位置</label>
                        <select id="rdp-layout" class="rop-select">
                            <option value="edges_and_float">四周边缘环绕 + 少量轻柔漂浮</option>
                            <option value="edges_only">仅四周边缘环绕 (中心留空)</option>
                            <option value="corners_only">仅四角精致点缀</option>
                            <option value="top_bottom">仅上下边缘点缀 (顶部+底部)</option>
                            <option value="full_scatter">全画面均匀漫天分布 (适合粒子/颗粒)</option>
                        </select>

                        <label>粒子/点缀密度</label>
                        <div class="rop-slider-combo"><input type="range" id="rdp-density" class="rop-range" min="5" max="200" step="5" value="75"><input type="number" class="rop-num-readout" data-link="rdp-density" min="5" max="200" step="5" value="75"></div>

                        <label>元素尺寸缩放%</label>
                        <div class="rop-slider-combo"><input type="range" id="rdp-size" class="rop-range" min="25" max="250" step="5" value="100"><input type="number" class="rop-num-readout" data-link="rdp-size" min="20" max="300" step="5" value="100"></div>

                        <label>发光光晕强度%</label>
                        <div class="rop-slider-combo"><input type="range" id="rdp-glow" class="rop-range" min="0" max="200" step="5" value="100"><input type="number" class="rop-num-readout" data-link="rdp-glow" min="0" max="200" step="5" value="100"></div>

                        <label>飘动/闪烁速度%</label>
                        <div class="rop-slider-combo"><input type="range" id="rdp-speed" class="rop-range" min="0" max="250" step="10" value="100"><input type="number" class="rop-num-readout" data-link="rdp-speed" min="0" max="300" step="10" value="100"></div>

                        <label>距画布边缘px</label>
                        <div class="rop-slider-combo"><input type="range" id="rdp-margin" class="rop-range" min="0" max="220" step="4" value="36"><input type="number" class="rop-num-readout" data-link="rdp-margin" min="0" max="300" step="4" value="36"></div>

                        <label>中心留白保护%</label>
                        <div class="rop-slider-combo"><input type="range" id="rdp-center-clear" class="rop-range" min="0" max="90" step="5" value="40"><input type="number" class="rop-num-readout" data-link="rdp-center-clear" min="0" max="95" step="5" value="40"></div>

                        <label>图层总不透明度</label>
                        <div class="rop-slider-combo"><input type="range" id="rdp-opacity" class="rop-range" min="0" max="255" step="5" value="255"><input type="number" class="rop-num-readout" data-link="rdp-opacity" min="0" max="255" step="5" value="255"></div>

                        <label>主色调</label><input type="color" id="rdp-color1" class="rop-color" value="#E2E8F0">
                        <label>副色/星核色</label><input type="color" id="rdp-color2" class="rop-color" value="#FFFDF5">
                    </div>
                </div>
            </div>
        `;
    }

    _bindEvents() {
        if (!this.container) return;

        // 绑定 range <-> number readout 双向同步
        this.container.querySelectorAll('.rop-num-readout[data-link]').forEach(numEl => {
            const rangeId = numEl.dataset.link;
            const rangeEl = this.container.querySelector('#' + rangeId);
            if (!rangeEl) return;
            const onRangeOrNumInput = (val) => {
                // 当用户主动拉大黑色模板浓度或颗粒强度时，自动打勾对应分区的启用开关
                if ((rangeId === 'rdp-dark-vignette' || rangeId === 'rdp-vignette-spread') && Number(val) > 0) {
                    const darkEn = this.container.querySelector('#rdp-dark-enabled');
                    if (darkEn && !darkEn.checked) darkEn.checked = true;
                }
                if ((rangeId === 'rdp-grain-intensity' || rangeId === 'rdp-grain-warmth') && Number(val) > 0) {
                    const grainEn = this.container.querySelector('#rdp-grain-enabled');
                    if (grainEn && !grainEn.checked) grainEn.checked = true;
                }
                this._syncToDecorOverlay();
            };
            rangeEl.addEventListener('input', () => {
                numEl.value = rangeEl.value;
                onRangeOrNumInput(rangeEl.value);
            });
            numEl.addEventListener('input', () => {
                rangeEl.value = numEl.value;
                onRangeOrNumInput(numEl.value);
            });
        });

        // 绑定复选框、下拉框、颜色选择器
        const inputIds = [
            'rdp-dark-enabled', 'rdp-dark-tint',
            'rdp-grain-enabled', 'rdp-film-scratches', 'rdp-light-leak',
            'rdp-floating-particles', 'rdp-particle-mode',
            'rdp-glow-stars', 'rdp-snowflakes', 'rdp-corner-ornaments', 'rdp-edge-garland',
            'rdp-layout', 'rdp-color1', 'rdp-color2',
        ];
        inputIds.forEach(id => {
            const el = this.container.querySelector('#' + id);
            if (!el) return;
            el.addEventListener('input', () => this._syncToDecorOverlay());
            el.addEventListener('change', () => this._syncToDecorOverlay());
        });

        // 快捷氛围暗底色块
        this.container.querySelectorAll('.rdp-tint-chip').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                const tint = btn.dataset.tint || '#05070C';
                const tintEl = this.container.querySelector('#rdp-dark-tint');
                if (tintEl) tintEl.value = tint;
                const darkEn = this.container.querySelector('#rdp-dark-enabled');
                if (darkEn) darkEn.checked = true;
                const vigEl = this.container.querySelector('#rdp-dark-vignette');
                if (vigEl && Number(vigEl.value) < 35) {
                    vigEl.value = 75;
                    const num = this.container.querySelector('.rop-num-readout[data-link="rdp-dark-vignette"]');
                    if (num) num.value = 75;
                }
                this._syncToDecorOverlay();
            });
        });

        // 分类筛选按钮
        this.container.querySelectorAll('.rdp-cat-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                this._activeCategory = btn.dataset.cat || 'all';
                this.container.querySelectorAll('.rdp-cat-btn').forEach(b => {
                    const active = (b === btn);
                    b.classList.toggle('active', active);
                    b.style.boxShadow = active ? '0 0 0 2px rgba(99,102,241,0.55)' : 'none';
                });
                this.container.querySelectorAll('.rdp-preset-card').forEach(card => {
                    const match = (this._activeCategory === 'all') || (card.dataset.cat === this._activeCategory);
                    card.style.display = match ? 'flex' : 'none';
                });
            });
        });

        // 30款预设卡片点击：一键应用（若无图层则自动创建）
        this.container.querySelectorAll('.rdp-preset-card').forEach(card => {
            card.addEventListener('click', (e) => {
                e.preventDefault();
                const styleId = card.dataset.styleId || 'dark_floating_dust';
                this.applyPreset(styleId);
            });
        });

        // 下拉菜单选择预设
        const styleSel = this.container.querySelector('#rdp-style-select');
        if (styleSel) {
            styleSel.addEventListener('change', () => {
                this.applyPreset(styleSel.value || 'dark_floating_dust');
            });
        }

        for (const id of ['rdp-style-scope', 'rdp-apply-all']) {
            this.container.querySelector('#' + id)?.addEventListener('change', () => {
                const ov = this._getSelectedDecor();
                if (ov) this._syncScopeAndRender(ov);
            });
        }

        // 铺满全屏 / 贴合中间
        const fitFullBtn = this.container.querySelector('#rdp-fit-full-btn');
        if (fitFullBtn) {
            fitFullBtn.addEventListener('click', (e) => {
                e.preventDefault();
                const ov = this._ensureDecorOverlay();
                if (!ov) return;
                ov.x = 0; ov.y = 0; ov.w = 1080; ov.h = 1920; ov.decor_margin = 36;
                this._syncFromDecorOverlay(ov);
                this._syncScopeAndRender(ov);
            });
        }
        const fitCardBtn = this.container.querySelector('#rdp-fit-card-btn');
        if (fitCardBtn) {
            fitCardBtn.addEventListener('click', (e) => {
                e.preventDefault();
                const ov = this._ensureDecorOverlay();
                if (!ov) return;
                ov.x = 70; ov.y = 330; ov.w = 940; ov.h = 1260; ov.decor_margin = 16;
                this._syncFromDecorOverlay(ov);
                this._syncScopeAndRender(ov);
            });
        }

    }

    applyPreset(styleId) {
        const ov = this._ensureDecorOverlay(styleId);
        if (!ov) return;
        if (typeof window.ReelsOverlay?.applyDecorStylePreset === 'function') {
            window.ReelsOverlay.applyDecorStylePreset(ov, styleId);
        } else {
            ov.decor_style = styleId;
        }
        this._syncFromDecorOverlay(ov);
        this._syncScopeAndRender(ov);
        if (this.linkedOverlayPanel) {
            this.linkedOverlayPanel._refreshList();
            if (this.linkedOverlayPanel._selectedOv?.id === ov.id) {
                this.linkedOverlayPanel._syncFromOverlay(ov);
            }
        }
    }

    _setVal(id, val) {
        const el = this.container?.querySelector('#' + id);
        if (!el) return;
        if (el.type === 'checkbox') {
            el.checked = Boolean(val);
        } else {
            el.value = val;
            const readout = this.container.querySelector(`.rop-num-readout[data-link="${id}"]`);
            if (readout) readout.value = val;
        }
    }

    _getVal(id) {
        const el = this.container?.querySelector('#' + id);
        if (!el) return undefined;
        if (el.type === 'checkbox') return el.checked;
        if (el.type === 'range' || el.type === 'number') return Number(el.value);
        return el.value;
    }

    _syncFromDecorOverlay(ov) {
        if (!ov || !this.container) return;
        this._syncing = true;
        try {
            const st = ov.decor_style || 'dark_floating_dust';
            const preset = window.ReelsOverlay?.DECOR_OVERLAY_STYLES?.[st] || {};
            const darkVignetteVal = ov.decor_dark_vignette ?? preset.dark_vignette ?? 0;
            const grainIntensityVal = ov.decor_grain_intensity ?? preset.grain_intensity ?? 0;
            const grainWarmthVal = ov.decor_grain_warmth ?? preset.grain_warmth ?? 0;
            this._setVal('rdp-style-select', st);
            this._setVal('rdp-dark-enabled', ov.decor_dark_enabled !== undefined ? Boolean(ov.decor_dark_enabled) : (Number(darkVignetteVal) > 0));
            this._setVal('rdp-dark-vignette', darkVignetteVal);
            this._setVal('rdp-vignette-spread', ov.decor_vignette_spread ?? preset.vignette_spread ?? 55);
            this._setVal('rdp-dark-tint', ov.decor_dark_tint || preset.dark_tint || '#05070C');
            this._setVal('rdp-grain-enabled', ov.decor_grain_enabled !== undefined ? Boolean(ov.decor_grain_enabled) : (Number(grainIntensityVal) > 0 || Number(grainWarmthVal) > 0));
            this._setVal('rdp-grain-intensity', grainIntensityVal);
            this._setVal('rdp-grain-size', ov.decor_grain_size ?? preset.grain_size ?? 100);
            this._setVal('rdp-grain-warmth', grainWarmthVal);
            this._setVal('rdp-film-scratches', ov.decor_film_scratches !== undefined ? Boolean(ov.decor_film_scratches) : Boolean(preset.film_scratches));
            this._setVal('rdp-light-leak', ov.decor_light_leak !== undefined ? Boolean(ov.decor_light_leak) : Boolean(preset.light_leak));
            this._setVal('rdp-floating-particles', ov.decor_floating_particles !== undefined ? Boolean(ov.decor_floating_particles) : Boolean(preset.floating_particles));
            this._setVal('rdp-particle-mode', ov.decor_particle_mode || preset.particle_mode || 'dust');
            this._setVal('rdp-glow-stars', ov.decor_glow_stars !== undefined ? Boolean(ov.decor_glow_stars) : Boolean(preset.glow_stars));
            this._setVal('rdp-snowflakes', ov.decor_snowflakes !== undefined ? Boolean(ov.decor_snowflakes) : Boolean(preset.snowflakes));
            this._setVal('rdp-corner-ornaments', ov.decor_corner_ornaments !== undefined ? Boolean(ov.decor_corner_ornaments) : Boolean(preset.corner_ornaments));
            this._setVal('rdp-edge-garland', ov.decor_edge_garland !== undefined ? Boolean(ov.decor_edge_garland) : Boolean(preset.edge_garland));
            this._setVal('rdp-layout', ov.decor_layout || preset.layout || 'edges_and_float');
            this._setVal('rdp-density', ov.decor_density ?? preset.density ?? 55);
            this._setVal('rdp-size', ov.decor_size ?? 100);
            this._setVal('rdp-glow', ov.decor_glow ?? 100);
            this._setVal('rdp-speed', ov.decor_speed ?? 100);
            this._setVal('rdp-margin', ov.decor_margin ?? 36);
            this._setVal('rdp-center-clear', ov.decor_center_clear ?? preset.center_clear ?? 65);
            this._setVal('rdp-opacity', ov.opacity ?? 255);
            this._setVal('rdp-color1', ov.decor_color1 || preset.color1 || '#FFD700');
            this._setVal('rdp-color2', ov.decor_color2 || preset.color2 || '#FFFDF5');

            // 高亮当前预设卡片
            this.container.querySelectorAll('.rdp-preset-card').forEach(card => {
                const isSelected = card.dataset.styleId === st;
                card.style.boxShadow = isSelected ? '0 0 0 2px #fde047, 0 4px 12px rgba(250,204,21,0.35)' : 'none';
                card.style.transform = isSelected ? 'translateY(-1px)' : 'none';
            });
        } finally {
            this._syncing = false;
        }
    }

    _syncToDecorOverlay() {
        if (this._syncing) return;
        const ov = this._ensureDecorOverlay(this._getVal('rdp-style-select') || 'dark_floating_dust');
        if (!ov) return;
        ov.decor_style = this._getVal('rdp-style-select') || ov.decor_style || 'dark_floating_dust';
        ov.decor_dark_enabled = Boolean(this._getVal('rdp-dark-enabled'));
        ov.decor_dark_vignette = Number(this._getVal('rdp-dark-vignette') ?? 0);
        ov.decor_vignette_spread = Number(this._getVal('rdp-vignette-spread') ?? 55);
        ov.decor_dark_tint = this._getVal('rdp-dark-tint') || '#05070C';
        ov.decor_grain_enabled = Boolean(this._getVal('rdp-grain-enabled'));
        ov.decor_grain_intensity = Number(this._getVal('rdp-grain-intensity') ?? 0);
        ov.decor_grain_size = Number(this._getVal('rdp-grain-size') ?? 100);
        ov.decor_grain_warmth = Number(this._getVal('rdp-grain-warmth') ?? 0);
        ov.decor_film_scratches = Boolean(this._getVal('rdp-film-scratches'));
        ov.decor_light_leak = Boolean(this._getVal('rdp-light-leak'));
        ov.decor_floating_particles = Boolean(this._getVal('rdp-floating-particles'));
        ov.decor_particle_mode = this._getVal('rdp-particle-mode') || 'dust';
        ov.decor_glow_stars = Boolean(this._getVal('rdp-glow-stars'));
        ov.decor_snowflakes = Boolean(this._getVal('rdp-snowflakes'));
        ov.decor_corner_ornaments = Boolean(this._getVal('rdp-corner-ornaments'));
        ov.decor_edge_garland = Boolean(this._getVal('rdp-edge-garland'));
        ov.decor_layout = this._getVal('rdp-layout') || 'edges_and_float';
        ov.decor_density = Number(this._getVal('rdp-density') ?? 55);
        ov.decor_size = Number(this._getVal('rdp-size') ?? 100);
        ov.decor_glow = Number(this._getVal('rdp-glow') ?? 100);
        ov.decor_speed = Number(this._getVal('rdp-speed') ?? 100);
        ov.decor_margin = Number(this._getVal('rdp-margin') ?? 36);
        ov.decor_center_clear = Number(this._getVal('rdp-center-clear') ?? 65);
        ov.opacity = Number(this._getVal('rdp-opacity') ?? 255);
        ov.decor_color1 = this._getVal('rdp-color1') || '#FFD700';
        ov.decor_color2 = this._getVal('rdp-color2') || '#FFFDF5';

        this._syncScopeAndRender(ov);
        if (this.linkedOverlayPanel) {
            this.linkedOverlayPanel._refreshList();
            if (this.linkedOverlayPanel._selectedOv?.id === ov.id) {
                this.linkedOverlayPanel._syncFromOverlay(ov);
            }
        }
    }

    _getDecorScopeTasks() {
        const state = window._reelsState;
        const selectedTask = state?.tasks?.[state.selectedIdx];
        if (this.videoCanvas?.scopedTask) return [this.videoCanvas.scopedTask];
        if (!selectedTask) return [];
        const sync = this.container?.querySelector('#rdp-apply-all')?.checked !== false;
        const scope = this.container?.querySelector('#rdp-style-scope')?.value || 'folder';
        if (!sync || scope === 'task') return [selectedTask];
        if (scope === 'all') return (state.tasks || []).filter(Boolean);
        // Use the host application's group/folder rules, including one-task groups.
        return typeof _getCurrentReelsGroupTasks === 'function'
            ? _getCurrentReelsGroupTasks()
            : [selectedTask];
    }

    _syncParametersToScopeTasks(ov) {
        if (!ov || !this.container.querySelector('#rdp-apply-all')?.checked) return;
        const sourceLayers = this.videoCanvas?.overlayMgr?.overlays || [];
        const ordinal = sourceLayers.filter(layer => layer.type === 'decor').indexOf(ov);
        if (ordinal < 0) return;
        const coverMode = !this.videoCanvas?.scopedTask && window._reelsState?._coverEditMode;
        const keys = Object.keys(ov).filter(key => key.startsWith('decor_') || ['x', 'y', 'w', 'h', 'rotation', 'opacity'].includes(key));
        for (const task of this._getDecorScopeTasks()) {
            const layers = (coverMode ? task.cover?.overlays : task.overlays) || [];
            const target = ov.slotKey
                ? layers.find(layer => layer.type === 'decor' && layer.slotKey === ov.slotKey)
                : layers.filter(layer => layer.type === 'decor')[ordinal];
            if (!target || target === ov) continue;
            for (const key of keys) target[key] = ov[key];
        }
    }

    _syncScopeAndRender(ov) {
        this._syncParametersToScopeTasks(ov);
        if (this.linkedOverlayPanel) window.ReelsOverviewBatch?.modelChanged?.(this.linkedOverlayPanel, ov);
        this.videoCanvas?.onOverlayChange?.(ov, { source: this.linkedOverlayPanel });
        this.videoCanvas?.render?.();
        window.ReelsPreviewV2?.requestRender?.();
    }

    refresh() {
        const ov = this._getSelectedDecor();
        if (ov) this._syncFromDecorOverlay(ov);
    }
}

window.ReelsDecorPanel = ReelsDecorPanel;
window.addEventListener('reels-overlay-selection-changed', event => {
    const { panel, overlay } = event.detail || {};
    const root = panel?.container?.querySelector('#rop-decor-props');
    if (!root) return;
    root.style.display = overlay?.type === 'decor' ? 'block' : 'none';
    if (overlay?.type !== 'decor') return;
    if (!panel._decorEditor) panel._decorEditor = new ReelsDecorPanel(root, panel.videoCanvas, panel);
    else panel._decorEditor.refresh();
});
})();
