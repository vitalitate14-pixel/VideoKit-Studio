/**
 * ReelsGradientPicker - 多色自定义文字渐变拾色组件
 * 支持 2 个、3 个、4 个甚至任意多个颜色节点的自由增删、改色、方向控制与流行预设
 */

const ReelsGradientCategories = [
    { id: 'all', name: '全部' },
    { id: 'sunset', name: '🌅 落日晚霞' },
    { id: 'luxury', name: '🏛️ 典雅质感' },
    { id: 'modern', name: '⚡ 现代流行' },
    { id: 'vibrant', name: '🌈 多色炫彩' }
];

const ReelsGradientPresets = [
    // 🌅 落日晚霞 (14)
    { name: '暖金落日', category: 'sunset', colors: ['#FFF7D1', '#FFA629'] },
    { name: '暮光珊瑚', category: 'sunset', colors: ['#FFE9D1', '#FF8A64'] },
    { name: '晚霞金红', category: 'sunset', colors: ['#FFE1CC', '#FF6A3D'] },
    { name: '朝阳琥珀', category: 'sunset', colors: ['#FFF4C2', '#F59E0B'] },
    { name: '璀璨金光', category: 'sunset', colors: ['#FFF7D6', '#FFC247'] },
    { name: '晚霞极光', category: 'sunset', colors: ['#FFE5E8', '#FF7A7A'] },
    { name: '杏林暖光', category: 'sunset', colors: ['#FFEAD6', '#FF914D'] },
    { name: '暮色粉紫', category: 'sunset', colors: ['#FFD6E7', '#FF5B8F'] },
    { name: '晨曦金橙', category: 'sunset', colors: ['#FDDB6D', '#F59E0B'] },
    { name: '柔杏枫叶', category: 'sunset', colors: ['#FCA5A5', '#EA580C'] },
    { name: '落日熔金', category: 'sunset', colors: ['#FF2A85', '#FF9F21'] },
    { name: '日出金光', category: 'sunset', colors: ['#F12711', '#F5AF19'] },
    { name: '烈焰极光', category: 'sunset', colors: ['#FF416C', '#FF4B2B'] },
    { name: '炽热燃金', category: 'sunset', colors: ['#F83600', '#F9D423'] },

    // 🏛️ 典雅质感 (14)
    { name: '香槟白金', category: 'luxury', colors: ['#FFF3C7', '#FFB347'] },
    { name: '帝王古金', category: 'luxury', colors: ['#FFF3C4', '#D4A017'] },
    { name: '珍珠璨金', category: 'luxury', colors: ['#FFFBED', '#F4C430'] },
    { name: '华丽琥珀', category: 'luxury', colors: ['#FFF5D6', '#FFA726'] },
    { name: '象牙暖柿', category: 'luxury', colors: ['#FFE8D6', '#FF683D'] },
    { name: '柔杏暖金', category: 'luxury', colors: ['#FFF8D6', '#FACC15'] },
    { name: '浅草翡翠', category: 'luxury', colors: ['#E6FFE9', '#33D17A'] },
    { name: '清泉嫩绿', category: 'luxury', colors: ['#E8FFF1', '#7EE787'] },
    { name: '珍珠杏金', category: 'luxury', colors: ['#FFF0DB', '#FFB36B'] },
    { name: '暖米陶土', category: 'luxury', colors: ['#FFF6D0', '#E88649'] },
    { name: '奶油鲜杏', category: 'luxury', colors: ['#FFE6D1', '#FF8F3D'] },
    { name: '杏仁珊瑚', category: 'luxury', colors: ['#FFEBD9', '#FF8A5B'] },
    { name: '黑金奢华', category: 'luxury', colors: ['#FFE259', '#FFA751', '#FF6B35'] },
    { name: '紫金贵族', category: 'luxury', colors: ['#654EA3', '#EAA0A2'] },

    // ⚡ 现代流行 (20)
    { name: '电光宝石蓝', category: 'modern', colors: ['#00E0FF', '#0077FF'] },
    { name: '冰川靛青', category: 'modern', colors: ['#C7D2FE', '#6366F1'] },
    { name: '晴空深蓝', category: 'modern', colors: ['#E0F0FF', '#4A98FF'] },
    { name: '极光碧水', category: 'modern', colors: ['#D4FBFF', '#00C2FF'] },
    { name: '电光青绿', category: 'modern', colors: ['#00E5FF', '#84CC16'] },
    { name: '荧光碧空', category: 'modern', colors: ['#A3E635', '#22D3EE'] },
    { name: '薄荷翡翠', category: 'modern', colors: ['#A7F3D0', '#10B981'] },
    { name: '鲜柠焦糖', category: 'modern', colors: ['#FDE047', '#F59E0B'] },
    { name: '柔樱玫瑰', category: 'modern', colors: ['#FECACA', '#F472B6'] },
    { name: '芭比艳粉', category: 'modern', colors: ['#F9A8D4', '#EC4899'] },
    { name: '薰衣魅影', category: 'modern', colors: ['#C4B5FD', '#885CF6'] },
    { name: '丁香紫藤', category: 'modern', colors: ['#E9DDFF', '#9B6BFF'] },
    { name: '冰紫丁香', category: 'modern', colors: ['#E6E6FF', '#A788FA'] },
    { name: '浅翠墨松', category: 'modern', colors: ['#34D399', '#059669'] },
    { name: '清澈钴蓝', category: 'modern', colors: ['#93C5FD', '#3B82F6'] },
    { name: '天青蔚蓝', category: 'modern', colors: ['#60A5FA', '#2563EB'] },
    { name: '浅桃洋红', category: 'modern', colors: ['#FF9ED1', '#D946EF'] },
    { name: '奶桃玫瑰', category: 'modern', colors: ['#FFE1F2', '#FF6EB7'] },
    { name: '浅粉洋红', category: 'modern', colors: ['#FFEAF6', '#FF4FA3'] },
    { name: '冰蓝琉璃', category: 'modern', colors: ['#EAF2FF', '#6C8BFF'] },
    { name: '浅冰天空', category: 'modern', colors: ['#E0F1FF', '#5FA8FF'] },

    // 🌈 多色炫彩 (10)
    { name: '赛博霓虹', category: 'vibrant', colors: ['#FF0080', '#7928CA', '#00DFD8'] },
    { name: '幻彩极光', category: 'vibrant', colors: ['#FF0055', '#FFAA00', '#00FFAA', '#00AAFF'] },
    { name: '暮色魅紫', category: 'vibrant', colors: ['#8E2DE2', '#4A00E0', '#F000FF'] },
    { name: '冰晶蓝白', category: 'vibrant', colors: ['#FFFFFF', '#70A1FF', '#1E90FF'] },
    { name: '极光薄荷', category: 'vibrant', colors: ['#00F260', '#0575E6'] },
    { name: '糖果甜心', category: 'vibrant', colors: ['#FA709A', '#FEE140'] },
    { name: '梦幻独角兽', category: 'vibrant', colors: ['#A1C4FD', '#C2E9FB', '#FBC2EB'] },
    { name: '深海流光', category: 'vibrant', colors: ['#2193B0', '#6DD5ED'] },
    { name: '电波幻紫', category: 'vibrant', colors: ['#F355DA', '#7000FF', '#00E5FF'] },
    { name: '金芒炫火', category: 'vibrant', colors: ['#FF0844', '#FFB199'] }
];

class ReelsGradientPicker {
    /**
     * @param {Object} options
     * @param {string} options.value 当前颜色值（单色或逗号多色，例如 "#FF0080,#7928CA,#00DFD8"）
     * @param {string} options.direction 'vertical' | 'horizontal' | 'diagonal'
     * @param {Function} options.onChange 回调函数 ({ value, direction, isGradient, colors }) => void
     * @param {string} options.title 弹窗或面板标题
     */
    constructor(options = {}) {
        this.options = Object.assign({
            value: '#FFFFFF',
            direction: 'horizontal',
            title: '文字渐变色配置',
            onChange: () => {}
        }, options);

        this.colors = this._parseColors(this.options.value);
        this.direction = this.options.direction || 'horizontal';
        this.isGradient = this.colors.length > 1;
        if (this.colors.length === 0) this.colors = ['#FFFFFF', '#FFD700'];

        this.selectedCategory = 'all';
        this.container = null;
        this.overlayEl = null;
        this.modalEl = null;
    }

    _parseColors(val) {
        if (!val || typeof val !== 'string') return ['#FFFFFF'];
        const parts = val.split(',').map(c => c.trim()).filter(Boolean);
        const valid = parts.filter(c => /^#[0-9a-fA-F]{3,8}$/.test(c) || /^rgba?/i.test(c));
        return valid.length > 0 ? valid : ['#FFFFFF'];
    }

    _formatValue() {
        return this.isGradient ? this.colors.join(',') : (this.colors[0] || '#FFFFFF');
    }

    _getLinearGradientCss() {
        const angle = this.direction === 'horizontal' ? 'to right' : (this.direction === 'diagonal' ? '135deg' : (this.direction === 'diagonal-up' ? '45deg' : 'to bottom'));
        if (!this.isGradient || this.colors.length < 2) {
            return this.colors[0] || '#FFFFFF';
        }
        return `linear-gradient(${angle}, ${this.colors.join(', ')})`;
    }

    /**
     * 便捷静态调用方法：实例化并立即打开浮窗
     * @param {Object} options
     * @returns {ReelsGradientPicker}
     */
    static open(options = {}) {
        if (ReelsGradientPicker._activeInstance) {
            try { ReelsGradientPicker._activeInstance.close(); } catch (e) {}
        }
        const picker = new ReelsGradientPicker(options);
        ReelsGradientPicker._activeInstance = picker;
        picker.open(options.anchorEl);
        return picker;
    }

    /**
     * 打开模态弹窗式编辑器
     * @param {HTMLElement} anchorEl 触发按钮元素
     */
    open(anchorEl = null) {
        this.close();

        const overlay = document.createElement('div');
        overlay.className = 'rgp-modal-overlay';
        overlay.style.cssText = `
            position: fixed; top: 0; left: 0; right: 0; bottom: 0;
            background: rgba(0,0,0,0.65); z-index: 999999;
            display: flex; align-items: center; justify-content: center;
            backdrop-filter: blur(4px);
        `;

        const modal = document.createElement('div');
        modal.className = 'rgp-modal-card';
        modal.style.cssText = `
            background: #181b26; color: #f1f5f9; width: 380px; max-width: 92vw;
            border-radius: 12px; box-shadow: 0 16px 36px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.08);
            border: 1px solid #2a3142; padding: 16px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            font-size: 13px; box-sizing: border-box; max-height: 90vh; overflow-y: auto;
        `;

        this.modalEl = modal;
        this.overlayEl = overlay;

        this._renderUI();

        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) this.close();
        });

        // 绑定 Esc 关闭
        this._escListener = (e) => {
            if (e.key === 'Escape') this.close();
        };
        window.addEventListener('keydown', this._escListener);
    }

    close() {
        if (ReelsGradientPicker._activeInstance === this) {
            ReelsGradientPicker._activeInstance = null;
        }
        if (this._escListener) {
            window.removeEventListener('keydown', this._escListener);
            this._escListener = null;
        }
        if (this.overlayEl && this.overlayEl.parentNode) {
            this.overlayEl.parentNode.removeChild(this.overlayEl);
        }
        this.overlayEl = null;
        this.modalEl = null;
    }

    _getFilteredPresets() {
        if (!this.selectedCategory || this.selectedCategory === 'all') {
            return ReelsGradientPresets;
        }
        return ReelsGradientPresets.filter(p => p.category === this.selectedCategory);
    }

    _renderUI() {
        if (!this.modalEl) return;
        const filteredPresets = this._getFilteredPresets();
        const curVal = this._formatValue().toLowerCase();

        this.modalEl.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
                <div style="font-weight:700; font-size:14px; display:flex; align-items:center; gap:6px;">
                    <span>🌈</span> <span>${this.options.title || '自定义文字渐变'}</span>
                </div>
                <button type="button" class="rgp-close-btn" style="background:none; border:none; color:#94a3b8; font-size:16px; cursor:pointer; padding:2px 6px; line-height:1;">✕</button>
            </div>

            <!-- 模式切换 -->
            <div style="display:flex; gap:8px; margin-bottom:12px; background:#0f172a; padding:3px; border-radius:8px; border:1px solid #2d3748;">
                <button type="button" class="rgp-mode-btn ${!this.isGradient ? 'active' : ''}" data-mode="solid" style="flex:1; padding:6px 0; border:none; border-radius:6px; font-size:12px; cursor:pointer; background:${!this.isGradient ? '#3b82f6' : 'transparent'}; color:#fff; font-weight:${!this.isGradient ? '700' : 'normal'}; transition:all 0.15s;">纯色模式</button>
                <button type="button" class="rgp-mode-btn ${this.isGradient ? 'active' : ''}" data-mode="gradient" style="flex:1; padding:6px 0; border:none; border-radius:6px; font-size:12px; cursor:pointer; background:${this.isGradient ? 'linear-gradient(135deg, #ec4899, #8b5cf6)' : 'transparent'}; color:#fff; font-weight:${this.isGradient ? '700' : 'normal'}; transition:all 0.15s;">多色渐变</button>
            </div>

            <!-- 渐变效果实时预览（真正呈现于文字本身） -->
            <div style="margin-bottom:12px; background:#0d111a; border:1px solid #242c3d; border-radius:8px; padding:10px;">
                <div style="font-size:11px; color:#94a3b8; margin-bottom:6px; display:flex; justify-content:space-between; align-items:center;">
                    <span>效果实时预览：</span>
                    <span class="rgp-preview-code" style="font-family:monospace; font-size:11px; color:#cbd5e1; max-width:200px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${this._formatValue()}</span>
                </div>
                <div class="rgp-preview-box" style="height:44px; border-radius:6px; background:#06080e; border:1px solid #1f2736; display:flex; align-items:center; justify-content:center; box-shadow:inset 0 2px 6px rgba(0,0,0,0.6); overflow:hidden; padding:0 8px;">
                    <span class="rgp-preview-text" style="font-weight:900; font-size:20px; letter-spacing:0.8px; display:inline-block; font-family:system-ui, -apple-system, BlinkMacSystemFont, sans-serif; white-space:nowrap;">
                        文字渐变效果 TEXT
                    </span>
                </div>
                <div class="rgp-preview-strip" style="height:5px; border-radius:3px; margin-top:6px; box-shadow:0 1px 3px rgba(0,0,0,0.4);"></div>
            </div>

            <!-- 渐变模式配置区域 -->
            ${this.isGradient ? `
            <!-- 渐变颜色节点管理 -->
            <div style="margin-bottom:12px;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
                    <span style="font-size:12px; font-weight:600; color:#cbd5e1;">颜色节点 (${this.colors.length}色)：</span>
                    <button type="button" class="rgp-add-stop-btn" style="padding:3px 8px; font-size:11px; background:#2563eb; border:none; border-radius:4px; color:#fff; cursor:pointer; font-weight:600;">+ 添加节点</button>
                </div>
                <div class="rgp-stops-list" style="display:flex; gap:6px; align-items:center; flex-wrap:wrap; background:#0f172a; padding:6px 8px; border-radius:6px; border:1px solid #2d3748;">
                    ${this.colors.map((c, i) => `
                        <div class="rgp-stop-item" style="display:inline-flex; align-items:center; gap:3px; background:#1e293b; padding:2px 5px; border-radius:5px; border:1px solid #475569;">
                            <span style="font-size:10px; color:#94a3b8; font-weight:bold;">#${i + 1}</span>
                            <input type="color" class="rgp-stop-color" data-index="${i}" value="${c.length === 7 ? c : (c.length === 4 ? '#' + c[1] + c[1] + c[2] + c[2] + c[3] + c[3] : '#ffffff')}" style="width:24px; height:22px; border:none; cursor:pointer; background:none; padding:0;">
                            ${this.colors.length > 2 ? `<button type="button" class="rgp-del-stop-btn" data-index="${i}" title="删除该颜色点" style="background:none; border:none; color:#f87171; cursor:pointer; font-size:12px; padding:0 2px; font-weight:bold; line-height:1;">×</button>` : ''}
                        </div>
                    `).join('')}
                </div>
            </div>

            <!-- 方向控制 -->
            <div style="margin-bottom:12px; display:flex; align-items:center; gap:8px;">
                <label style="font-size:12px; color:#cbd5e1; white-space:nowrap;">渐变方向：</label>
                <select class="rgp-direction-select" style="flex:1; background:#0f172a; color:#f1f5f9; border:1px solid #334155; padding:5px 8px; border-radius:5px; font-size:12px; outline:none;">
                    <option value="horizontal" ${this.direction === 'horizontal' ? 'selected' : ''}>↔ 水平渐变（左右流光）</option>
                    <option value="vertical" ${this.direction === 'vertical' ? 'selected' : ''}>↕ 垂直渐变（字顶至字底，爆款推荐）</option>
                    <option value="diagonal" ${this.direction === 'diagonal' ? 'selected' : ''}>⤡ 对角渐变（45° 光泽感）</option>
                    <option value="diagonal-up" ${this.direction === 'diagonal-up' ? 'selected' : ''}>⤢ 反向对角（左下→右上）</option>
                </select>
            </div>
            ` : `
            <!-- 纯色拾色器 -->
            <div style="margin-bottom:12px; display:flex; align-items:center; gap:10px; background:#0f172a; padding:8px 10px; border-radius:6px; border:1px solid #2d3748;">
                <label style="font-size:12px; color:#cbd5e1;">当前纯色：</label>
                <input type="color" class="rgp-solid-color" value="${this.colors[0] || '#ffffff'}" style="width:34px; height:28px; border:none; cursor:pointer; background:none;">
                <input type="text" class="rgp-solid-text" value="${this.colors[0] || '#ffffff'}" style="width:85px; background:#1e293b; border:1px solid #475569; color:#fff; padding:4px 6px; border-radius:4px; font-family:monospace; font-size:12px;">
            </div>
            `}

            <!-- 🎨 丰富渐变色预设库（点击即套用） -->
            <div style="margin-bottom:14px; background:#111520; border:1px solid #242c3d; border-radius:8px; padding:10px;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                    <div style="font-size:11px; font-weight:700; color:#cbd5e1; display:flex; align-items:center; gap:4px;">
                        <span>🎨 爆款渐变预设</span>
                        <span style="font-size:10px; color:#64748b; font-weight:normal;">(${ReelsGradientPresets.length}款精选)</span>
                    </div>
                    <span style="font-size:10px; color:#94a3b8;">点击即可套用</span>
                </div>

                <!-- 分类过滤 Tabs -->
                <div class="rgp-category-tabs" style="display:flex; gap:4px; margin-bottom:8px; overflow-x:auto; padding-bottom:2px;">
                    ${ReelsGradientCategories.map(cat => `
                        <button type="button" class="rgp-cat-tab ${this.selectedCategory === cat.id ? 'active' : ''}" data-cat="${cat.id}" style="padding:3px 8px; font-size:11px; border:none; border-radius:12px; cursor:pointer; white-space:nowrap; background:${this.selectedCategory === cat.id ? '#3b82f6' : '#1e293b'}; color:${this.selectedCategory === cat.id ? '#fff' : '#94a3b8'}; font-weight:${this.selectedCategory === cat.id ? '600' : 'normal'}; transition:all 0.12s;">
                            ${cat.name}
                        </button>
                    `).join('')}
                </div>

                <!-- 预设卡片列表 -->
                <div class="rgp-presets-container" style="display:grid; grid-template-columns:repeat(3, 1fr); gap:6px; max-height:165px; overflow-y:auto; padding-right:2px;">
                    ${filteredPresets.map(preset => {
                        const pColors = preset.colors.join(',');
                        const isActive = (curVal === pColors.toLowerCase());
                        const gradBg = `linear-gradient(135deg, ${preset.colors.join(', ')})`;
                        return `
                            <button type="button" class="rgp-preset-chip ${isActive ? 'active' : ''}" data-colors="${pColors}" style="display:flex; align-items:center; gap:5px; padding:5px 6px; font-size:11px; border:${isActive ? '1px solid #38bdf8' : '1px solid #2d3748'}; border-radius:6px; background:${isActive ? '#1e293b' : '#0f172a'}; color:#f8fafc; cursor:pointer; text-align:left; overflow:hidden; transition:all 0.15s; outline:none;" title="${preset.name}: ${preset.colors.join(' -> ')}">
                                <span style="display:inline-block; width:14px; height:14px; border-radius:50%; background:${gradBg}; flex-shrink:0; box-shadow:0 1px 3px rgba(0,0,0,0.5); border:1px solid rgba(255,255,255,0.25);"></span>
                                <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1;">${preset.name}</span>
                            </button>
                        `;
                    }).join('')}
                </div>
            </div>

            <!-- 底部确认按钮 -->
            <div style="display:flex; justify-content:space-between; align-items:center;">
                <span style="font-size:10px; color:#64748b;">支持多节点 / 实时生效</span>
                <button type="button" class="rgp-confirm-btn" style="background:linear-gradient(135deg, #3b82f6, #2563eb); border:none; color:#fff; padding:6px 20px; border-radius:6px; cursor:pointer; font-weight:700; font-size:12px; box-shadow:0 2px 8px rgba(37,99,235,0.4);">完成</button>
            </div>
        `;

        this._updatePreviewBar();
        this._bindEvents();
    }

    _bindEvents() {
        if (!this.modalEl) return;

        // 关闭
        this.modalEl.querySelector('.rgp-close-btn')?.addEventListener('click', () => this.close());
        this.modalEl.querySelector('.rgp-confirm-btn')?.addEventListener('click', () => this.close());

        // 模式切换
        this.modalEl.querySelectorAll('.rgp-mode-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const mode = btn.dataset.mode;
                this.isGradient = (mode === 'gradient');
                if (this.isGradient && this.colors.length < 2) {
                    this.colors = ['#FFF7D1', '#FFA629'];
                }
                this._renderUI();
                this._emitChange();
            });
        });

        // 分类切换
        this.modalEl.querySelectorAll('.rgp-cat-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                this.selectedCategory = tab.dataset.cat;
                this._renderUI();
            });
        });

        // 纯色修改
        const solidColor = this.modalEl.querySelector('.rgp-solid-color');
        const solidText = this.modalEl.querySelector('.rgp-solid-text');
        if (solidColor) {
            solidColor.addEventListener('input', (e) => {
                this.colors = [e.target.value];
                if (solidText) solidText.value = e.target.value;
                this._updatePreviewBar();
                this._emitChange();
            });
        }
        if (solidText) {
            solidText.addEventListener('change', (e) => {
                let v = e.target.value.trim();
                if (!v.startsWith('#')) v = '#' + v;
                if (/^#[0-9a-fA-F]{6}$/.test(v)) {
                    this.colors = [v];
                    if (solidColor) solidColor.value = v;
                    this._updatePreviewBar();
                    this._emitChange();
                }
            });
        }

        // 添加颜色节点
        this.modalEl.querySelector('.rgp-add-stop-btn')?.addEventListener('click', () => {
            if (this.colors.length >= 8) return alert('最多支持 8 个颜色节点');
            const last = this.colors[this.colors.length - 1] || '#FFD700';
            this.colors.push(last);
            this._renderUI();
            this._emitChange();
        });

        // 删除颜色节点
        this.modalEl.querySelectorAll('.rgp-del-stop-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const idx = parseInt(btn.dataset.index, 10);
                if (this.colors.length > 2) {
                    this.colors.splice(idx, 1);
                    this._renderUI();
                    this._emitChange();
                }
            });
        });

        // 修改节点颜色
        this.modalEl.querySelectorAll('.rgp-stop-color').forEach(input => {
            input.addEventListener('input', (e) => {
                const idx = parseInt(e.target.dataset.index, 10);
                this.colors[idx] = e.target.value;
                this._updatePreviewBar();
                this._emitChange();
            });
        });

        // 方向改变
        const dirSelect = this.modalEl.querySelector('.rgp-direction-select');
        if (dirSelect) {
            dirSelect.addEventListener('change', (e) => {
                this.direction = e.target.value;
                this._updatePreviewBar();
                this._emitChange();
            });
        }

        // 点击预设
        this.modalEl.querySelectorAll('.rgp-preset-chip').forEach(btn => {
            btn.addEventListener('click', () => {
                const raw = btn.dataset.colors;
                if (raw) {
                    this.colors = raw.split(',').map(c => c.trim());
                    this.isGradient = true;
                    this._renderUI();
                    this._emitChange();
                }
            });
        });
    }

    _applyPreviewStyle(textEl, stripEl) {
        if (!textEl) return;
        const gradCss = this._getLinearGradientCss();
        if (this.isGradient && this.colors.length >= 2) {
            textEl.style.backgroundImage = gradCss;
            textEl.style.webkitBackgroundClip = 'text';
            textEl.style.backgroundClip = 'text';
            textEl.style.webkitTextFillColor = 'transparent';
            textEl.style.color = 'transparent';
        } else {
            const solidColor = this.colors[0] || '#FFFFFF';
            textEl.style.backgroundImage = 'none';
            textEl.style.webkitBackgroundClip = '';
            textEl.style.backgroundClip = '';
            textEl.style.webkitTextFillColor = solidColor;
            textEl.style.color = solidColor;
        }
        if (stripEl) {
            stripEl.style.background = gradCss;
        }
    }

    _updatePreviewBar() {
        const textEl = this.modalEl?.querySelector('.rgp-preview-text');
        const stripEl = this.modalEl?.querySelector('.rgp-preview-strip');
        const codeEl = this.modalEl?.querySelector('.rgp-preview-code');
        if (codeEl) {
            codeEl.textContent = this._formatValue();
        }
        this._applyPreviewStyle(textEl, stripEl);
    }

    _emitChange() {
        if (typeof this.options.onChange === 'function') {
            this.options.onChange({
                value: this._formatValue(),
                direction: this.direction,
                isGradient: this.isGradient,
                colors: [...this.colors]
            });
        }
    }
}

// 导出全局组件供浏览器各模块直接调用
if (typeof window !== 'undefined') {
    window.ReelsGradientPicker = ReelsGradientPicker;
    window.ReelsGradientPresets = ReelsGradientPresets;
    window.ReelsGradientCategories = ReelsGradientCategories;
}
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { ReelsGradientPicker, ReelsGradientPresets, ReelsGradientCategories };
}
