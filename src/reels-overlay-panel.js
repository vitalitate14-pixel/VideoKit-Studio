/**
 * reels-overlay-panel.js — 覆层属性面板
 *
 * 移植自 AutoSub_v8 属性面板 (PyQt6 prop_panel → HTML DOM)
 *
 * 功能:
 *   - 覆层列表 (添加/删除/选中)
 *   - 文本覆层属性: 内容、字体、大小、颜色、描边、阴影、背景、动画
 *   - 图片覆层属性: 源路径、缩放、翻转、混合模式
 *   - 时间范围: 起止时间编辑
 *   - 变换: X/Y/宽/高/旋转/不透明度
 */

/** 四舍五入到1位小数，避免浮点精度问题 (如 19.700000000000003) */
function _ropRound(v) {
    return Math.round((parseFloat(v) || 0) * 10) / 10;
}

// Preserve every existing text layer: transfer only to the same kind of editable
// layer, and append unmatched text layers intact rather than discarding them.
function _ropPresetLayersKeepingText(layers, existing) {
    const clone = value => JSON.parse(JSON.stringify(value, (key, val) => key === '_allOverlays' ? undefined : val));
    const result = clone(layers);
    const fields = { text: ['content'], textcard: ['title_text', 'body_text', 'footer_text'], scroll: ['scroll_title', 'content'] };
    const used = new Set();
    result.forEach((target, index) => {
        if (!target || target.fixed_text || !fields[target.type]) return;
        const compatible = source => source && source.type === target.type && !used.has(source);
        const source = compatible(existing[index]) ? existing[index] : existing.find(compatible);
        if (!source) return;
        used.add(source);
        for (const key of fields[target.type]) {
            if (typeof source[key] === 'string') target[key] = source[key];
        }
    });
    for (const source of existing) {
        if (source && fields[source.type] && !used.has(source)) result.push(clone(source));
    }
    return result;
}

/** 将内部播放 URI 转为用户可读的原始本地路径，避免中文文件名显示成 URL 编码。 */
function _ropDisplayMediaSource(source) {
    const raw = String(source || '');
    if (!raw) return '—';
    let path = raw;
    if (/^local-media:\/\//i.test(path)) path = path.replace(/^local-media:\/\//i, '');
    else if (/^file:\/\//i.test(path)) path = path.replace(/^file:\/\//i, '');
    try {
        return decodeURIComponent(path);
    } catch (_) {
        // 存在不完整的百分号编码时，仍显示未解码原值，不能让属性面板报错。
        return path;
    }
}

const ROP_TEXTCARD_DEFAULT_TRANSFORM = {
    // Center-coordinate defaults (0,0 in UI) converted to top-left for 1080x1920 canvas.
    x: 85,
    y: 310,
    w: 910,
    h: 1300,
    rotation: 0,
    opacity: 255,
};

// 标题装饰线仅读取私人文件库，不生成或自动导入扩展预设。
const ROP_PERSONAL_DECORATION_PRESET_KEY = 'videokit_personal_title_decoration_presets_v1';

// 标题配色方案采用用户个人预设系统管理（通过 localStorage['reels_title_color_presets'] 与导入导出持久化，非代码内置硬编码）

class ReelsOverlayPanel {
    constructor(containerEl, videoCanvas) {
        this.container = containerEl;
        this.videoCanvas = videoCanvas;
        this._selectedOv = null;
        this._renderRaf = null;
        this._mediaFolderSelectionSerial = 0;
        this._mediaFolderSelectionTokens = new WeakMap();
        this._init();
    }

    _getPersonalDecorationPresets() {
        try {
            const saved = JSON.parse(localStorage.getItem(ROP_PERSONAL_DECORATION_PRESET_KEY) || 'null');
            if (saved?.format === 'videokit-title-decoration-presets' && Array.isArray(saved.presets)) return saved;
        } catch (_) {}
        return { format: 'videokit-title-decoration-presets', version: 1, name: '我的标题装饰线', presets: [] };
    }

    _setPersonalDecorationPresets(data) {
        localStorage.setItem(ROP_PERSONAL_DECORATION_PRESET_KEY, JSON.stringify(data));
    }

    _getAllVectorPresets() {
        const api = window.DividerPresets;
        if (!api) return [];
        try {
            const saved = localStorage.getItem('videokit_vector_dividers_v1');
            if (saved) {
                const parsed = api.parse(saved);
                if (parsed.length > 0) return parsed;
            }
        } catch (_) {}
        return [];
    }

    _getAllDecorationItems() {
        const items = [];

        // 1. 爆款矢量预设 (50款)
        const vectorPresets = this._getAllVectorPresets();
        vectorPresets.forEach((vp, idx) => {
            items.push({
                id: vp.id,
                name: vp.name || `矢量 ${String(idx + 1).padStart(2, '0')}`,
                category: 'vector',
                categoryLabel: '🌟 爆款矢量',
                parameters: vp.parameters || vp.defaultProps,
                isVector: true,
                preset: vp
            });
        });

        // 旧版 60 款通过独立私人文件提供；名称与选择来自已保存数据。
        this._getPersonalDecorationPresets().presets.forEach(preset => {
            items.push({ ...preset,
                category: /^classic/.test(preset.id) ? 'classic' : /^floral/.test(preset.id) ? 'floral' : 'custom',
                categoryLabel: /^classic/.test(preset.id) ? '📐 我的简约线' : '🌿 我的花饰线'
            });
        });
        // 基础绘图控件，无扩展预设自动生成。
        items.push({ id: 'solid', name: '实线', category: 'basic' }, { id: 'dashed', name: '虚线', category: 'basic' });

        // 5. 用户自定私人预设
        try {
            const rawCustom = localStorage.getItem('videokit_custom_title_dividers');
            if (rawCustom) {
                const customs = JSON.parse(rawCustom);
                if (Array.isArray(customs)) {
                    customs.forEach(c => {
                        items.push({
                            id: c.id,
                            name: c.name || '我的自定线条',
                            category: 'custom',
                            categoryLabel: '⭐ 我的私存',
                            parameters: c.parameters,
                            isVector: !!c.isVector,
                            preset: c.preset
                        });
                    });
                }
            }
        } catch (_) {}

        return items;
    }

    _refreshPersonalDecorationOptions() {
        const allItems = this._getAllDecorationItems();
        this.container.querySelectorAll('#rop-title-deco-style, #rop-scroll-title-deco-style').forEach((select) => {
            const currentVal = select.value;
            select.innerHTML = '';

            const catGroups = [
                { id: 'vector', label: '🌟 爆款矢量' },
                { id: 'classic', label: '📐 简约几何' },
                { id: 'floral', label: '🌿 花体卷草' },
                { id: 'basic', label: '〰️ 基础纹理' },
                { id: 'custom', label: '⭐ 我的私存' }
            ];

            catGroups.forEach(grp => {
                const groupItems = allItems.filter(item => item.category === grp.id);
                if (groupItems.length > 0) {
                    const optgroup = document.createElement('optgroup');
                    optgroup.label = `${grp.label} (${groupItems.length}款)`;
                    groupItems.forEach(item => {
                        const opt = document.createElement('option');
                        opt.value = item.id;
                        opt.textContent = item.name;
                        optgroup.appendChild(opt);
                    });
                    select.appendChild(optgroup);
                }
            });

            if (currentVal && Array.from(select.options).some(o => o.value === currentVal)) {
                select.value = currentVal;
            } else if (select.options.length > 0) {
                select.value = 'solid';
            }
        });
    }

    _exportPersonalDecorationPresets() {
        if (window.DividerPresets) {
            const presets = this._getAllVectorPresets();
            if (presets.length === 0) {
                alert('当前暂无私人预设可供导出（代码零内置，仅默认保留基础实虚线）。');
                return;
            }
            const json = window.DividerPresets.serialize(presets);
            const blob = new Blob([json], { type: 'application/json' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = '美区爆贴标题装饰线_我的私人预设.json';
            a.click();
            URL.revokeObjectURL(a.href);
            return;
        }
        const json = JSON.stringify(this._getPersonalDecorationPresets(), null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = '我的标题装饰线预设_60款.json';
        a.click();
        URL.revokeObjectURL(a.href);
    }

    _importPersonalDecorationPresets() {
        const input = document.createElement('input');
        input.type = 'file'; input.accept = '.json';
        input.onchange = () => {
            const file = input.files?.[0]; if (!file) return;
            const reader = new FileReader();
            reader.onload = () => {
                try {
                    const text = reader.result;
                    if (window.DividerPresets && text.includes('videokit-divider-presets')) {
                        const imported = window.DividerPresets.parse(text);
                        localStorage.setItem('videokit_vector_dividers_v1', window.DividerPresets.serialize(imported));
                        this._refreshPersonalDecorationOptions();
                        alert(`✅ 已导入 ${imported.length} 款矢量装饰线预设`);
                        return;
                    }
                    const data = JSON.parse(text);
                    if (data?.format !== 'videokit-title-decoration-presets' || !Array.isArray(data.presets)) throw new Error('format');
                    const valid = data.presets.filter((item) => /^((classic|floral)\d{2})$/.test(item?.id) && item.name);
                    if (!valid.length) throw new Error('empty');
                    this._setPersonalDecorationPresets({ format: 'videokit-title-decoration-presets', version: 1, name: data.name || '我的标题装饰线', presets: valid });
                    this._refreshPersonalDecorationOptions();
                    alert(`✅ 已导入 ${valid.length} 个我的装饰线预设`);
                } catch (_) { alert('导入失败：请选择有效的标题装饰线预设 JSON 文件。'); }
            };
            reader.readAsText(file);
        };
        input.click();
    }

    _openPersonalDecorationGallery(kind, anchorEl) {
        // 与标题色板一致：完全无黑底遮罩，浮动在按钮旁不挡视频画布，鼠标划过实时更新画布预览，离开还原，点击确定选用。
        const existing = document.querySelector('.rop-decoration-palette-popover');
        if (existing) {
            existing._restorePreview?.();
            existing.remove();
            return;
        }

        const previewOverlay = this._selectedOv || this.currentOverlay;
        const fieldPrefix = kind === 'scroll' ? 'scroll_title_deco' : 'title_deco';
        const uiPrefix = kind === 'scroll' ? 'rop-scroll-title-deco' : 'rop-title-deco';
        const enabledKey = `${fieldPrefix}_enabled`;
        const styleKey = `${fieldPrefix}_style`;
        const paramsKey = `${fieldPrefix}_parameters`;
        const thickKey = `${fieldPrefix}_thickness`;
        const colorKey = `${fieldPrefix}_color`;
        const color2Key = `${fieldPrefix}_color2`;
        const posKey = `${fieldPrefix}_position`;
        const alignKey = `${fieldPrefix}_align`;
        const gapKey = `${fieldPrefix}_gap`;
        const lenKey = `${fieldPrefix}_length`;
        const opKey = `${fieldPrefix}_opacity`;

        const preSnapshot = previewOverlay ? {
            [enabledKey]: previewOverlay[enabledKey],
            [styleKey]: previewOverlay[styleKey],
            [paramsKey]: previewOverlay[paramsKey] ? JSON.parse(JSON.stringify(previewOverlay[paramsKey])) : undefined,
            [thickKey]: previewOverlay[thickKey],
            [colorKey]: previewOverlay[colorKey],
            [color2Key]: previewOverlay[color2Key],
            [posKey]: previewOverlay[posKey],
            [alignKey]: previewOverlay[alignKey],
            [gapKey]: previewOverlay[gapKey],
            [lenKey]: previewOverlay[lenKey],
            [opKey]: previewOverlay[opKey]
        } : null;

        let confirmed = false;

        const renderPreview = () => {
            if (typeof this.videoCanvas?.render === 'function') {
                this.videoCanvas.render();
            } else {
                this._requestRender();
            }
        };

        const restorePreview = () => {
            if (!confirmed && preSnapshot && previewOverlay) {
                Object.assign(previewOverlay, preSnapshot);
                renderPreview();
            }
        };

        const allItems = this._getAllDecorationItems();
        let currentTab = 'all';
        let searchQuery = '';

        const popover = document.createElement('div');
        popover.className = 'rop-decoration-palette-popover';
        popover._restorePreview = () => { if (!confirmed) restorePreview(); };
        popover.style.cssText = 'position:fixed; z-index:9999999; width:min(620px, calc(100vw - 20px)); max-height:min(580px, calc(100vh - 20px)); display:flex; flex-direction:column; background:#141722; border:1px solid #3d4663; border-radius:10px; box-shadow:0 16px 40px rgba(0,0,0,0.85); padding:10px 12px; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; color:#e2e8f0; pointer-events:auto;';

        // 顶部 Header
        const header = document.createElement('div');
        header.style.cssText = 'display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; padding-bottom:6px; border-bottom:1px solid rgba(255,255,255,0.08); gap:8px;';
        header.innerHTML = `
            <div style="display:flex; align-items:center; gap:6px; font-size:12px; font-weight:bold; color:#a5b4fc;">
                <span>✦ 标题装饰线视觉色板</span>
                <span style="font-size:10px; font-weight:normal; color:#94a3b8;">(共 ${allItems.length} 款 · 划过画布实时预览 · 点击应用)</span>
            </div>
            <div style="display:flex; align-items:center; gap:5px;">
                <button type="button" class="rop-palette-import-btn" style="background:#1e293b; border:1px solid #3b4258; border-radius:4px; color:#cbd5e1; font-size:11px; padding:2px 7px; cursor:pointer;" title="导入装饰线预设 JSON">📥 导入</button>
                <button type="button" class="rop-palette-export-btn" style="background:#1e293b; border:1px solid #3b4258; border-radius:4px; color:#cbd5e1; font-size:11px; padding:2px 7px; cursor:pointer;" title="导出当前装饰线预设 JSON">📤 导出</button>
                <input type="text" class="rop-palette-search-input" placeholder="🔍 搜索装饰线..." style="width:115px; height:23px; font-size:11px; padding:2px 6px; background:#0e111a; border:1px solid #3b4258; border-radius:4px; color:#e2e8f0; outline:none;" />
                <button type="button" class="rop-palette-close-btn" style="background:none; border:none; color:#94a3b8; font-size:16px; cursor:pointer; padding:0 4px; line-height:1;">✕</button>
            </div>
        `;
        popover.appendChild(header);

        // 分类标签栏
        const tabsContainer = document.createElement('div');
        tabsContainer.style.cssText = 'display:flex; align-items:center; gap:5px; margin-bottom:8px; background:#0c0e17; border:1px solid rgba(255,255,255,0.06); border-radius:7px; padding:5px 8px; overflow-x:auto; flex-wrap:wrap;';

        const tabsDef = [
            { id: 'all', label: '全部' },
            { id: 'vector', label: '🌟 爆款矢量' },
            { id: 'classic', label: '📐 简约几何' },
            { id: 'floral', label: '🌿 花体卷草' },
            { id: 'basic', label: '〰️ 基础纹理' }
        ];
        if (allItems.some(i => i.category === 'custom')) {
            tabsDef.push({ id: 'custom', label: '⭐ 我的私存' });
        }

        const renderTabs = () => {
            tabsContainer.innerHTML = '';
            tabsDef.forEach(tab => {
                const count = tab.id === 'all' ? allItems.length : allItems.filter(i => i.category === tab.id).length;
                const btn = document.createElement('button');
                btn.type = 'button';
                const active = currentTab === tab.id;
                btn.textContent = `${tab.label} (${count})`;
                btn.style.cssText = `padding:2.5px 8px; font-size:11px; font-weight:${active ? '700' : '500'}; border-radius:4px; border:1px solid ${active ? '#6366f1' : '#2b3346'}; background:${active ? '#312e81' : '#171b26'}; color:${active ? '#ffffff' : '#94a3b8'}; cursor:pointer; white-space:nowrap; transition:all 0.15s;`;
                btn.addEventListener('click', () => {
                    currentTab = tab.id;
                    renderTabs();
                    renderCards();
                });
                tabsContainer.appendChild(btn);
            });
        };
        popover.appendChild(tabsContainer);

        // 卡片网格
        const grid = document.createElement('div');
        grid.style.cssText = 'display:grid; grid-template-columns:repeat(3, minmax(0, 1fr)); gap:8px; overflow-y:auto; max-height:430px; padding-right:2px;';

        const drawProceduralCard = (canvas, item) => {
            const ctx = canvas.getContext('2d');
            const w = canvas.width;
            const h = canvas.height;
            const cy = h / 2;
            ctx.clearRect(0, 0, w, h);
            ctx.save();
            ctx.strokeStyle = '#1e293b';
            ctx.fillStyle = '#1e293b';
            ctx.lineWidth = 2.2;
            ctx.lineCap = 'round';

            if (item.id === 'dashed') {
                ctx.setLineDash([8, 6]);
            } else if (item.id === 'dotted') {
                ctx.setLineDash([2, 5]);
            } else if (item.id === 'gradient') {
                const grad = ctx.createLinearGradient(16, cy, w - 16, cy);
                grad.addColorStop(0, '#4f46e5');
                grad.addColorStop(1, '#ec4899');
                ctx.strokeStyle = grad;
            }

            if (window.ReelsTitleDecoration?.draw) {
                window.ReelsTitleDecoration.draw(ctx, {
                    startX: 16,
                    startY: cy,
                    endX: w - 16,
                    endY: cy,
                    isVertical: false,
                    position: 'bottom',
                    style: item.id,
                    thickness: 2.2,
                    parameters: item.parameters
                });
            } else {
                ctx.beginPath();
                ctx.moveTo(16, cy);
                ctx.lineTo(w - 16, cy);
                ctx.stroke();
            }
            ctx.restore();
        };

        const renderCards = () => {
            grid.innerHTML = '';
            const filtered = allItems.filter(item => {
                if (currentTab !== 'all' && item.category !== currentTab) return false;
                if (searchQuery) {
                    const matchName = (item.name || '').toLowerCase().includes(searchQuery);
                    const matchId = (item.id || '').toLowerCase().includes(searchQuery);
                    const matchCat = (item.categoryLabel || '').toLowerCase().includes(searchQuery);
                    if (!matchName && !matchCat && !matchId) return false;
                }
                return true;
            });

            if (filtered.length === 0) {
                grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:40px;color:#94a3b8;font-size:12px;">未找到匹配的装饰线样式</div>';
                return;
            }

            const currentStyleVal = previewOverlay?.[styleKey] || '';

            filtered.forEach(item => {
                const isSelected = item.id === currentStyleVal;
                const card = document.createElement('button');
                card.type = 'button';
                card.dataset.style = item.id;
                card.style.cssText = `border:1px solid ${isSelected ? '#818cf8' : '#2b3145'}; border-radius:7px; background:${isSelected ? '#1e2238' : '#1a1d2b'}; padding:5px; cursor:pointer; color:#cbd5e1; text-align:left; display:flex; flex-direction:column; gap:4px; transition:all 0.15s; outline:none; box-shadow:${isSelected ? '0 0 10px rgba(99,102,241,0.3)' : 'none'};`;

                const previewPaper = document.createElement('div');
                previewPaper.style.cssText = 'background:#f8fafc; border-radius:4px; height:46px; display:flex; align-items:center; justify-content:center; padding:2px 4px; box-shadow:inset 0 1px 2px rgba(0,0,0,0.06); width:100%; box-sizing:border-box; overflow:hidden;';

                if (item.category === 'vector' && window.DividerPresets?.svg) {
                    previewPaper.innerHTML = window.DividerPresets.svg(item.preset || item, {
                        width: 270,
                        height: 42,
                        strokeWidth: 2,
                        color: '#1e293b',
                        opacity: 1,
                        centerGap: item.parameters?.centerGap ?? 18,
                        decorationScale: item.parameters?.decorationScale ?? 1
                    });
                    if (previewPaper.firstElementChild) {
                        previewPaper.firstElementChild.style.cssText = 'width:100%; height:100%; display:block;';
                    }
                } else {
                    const canvas = document.createElement('canvas');
                    canvas.width = 320;
                    canvas.height = 48;
                    canvas.style.cssText = 'width:100%; height:42px; display:block;';
                    previewPaper.appendChild(canvas);
                    drawProceduralCard(canvas, item);
                }

                const infoRow = document.createElement('div');
                infoRow.style.cssText = 'display:flex; justify-content:space-between; align-items:center; padding:2px 2px 0; font-size:11px;';
                infoRow.innerHTML = `
                    <span style="font-weight:${isSelected ? '700' : '500'}; color:${isSelected ? '#c7d2fe' : '#cbd5e1'}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:130px;" title="${item.name}">${item.name}</span>
                    <span style="font-size:9.5px; color:#64748b; font-family:monospace; margin-left:4px; flex-shrink:0;">${item.id}</span>
                `;

                card.append(previewPaper, infoRow);
                grid.appendChild(card);

                // 🌟 核心：鼠标悬停在卡片上，左侧画布即时展示该线条在当前标题上的真实效果！
                card.addEventListener('mouseenter', () => {
                    card.style.borderColor = '#818cf8';
                    card.style.background = '#202846';
                    card.style.transform = 'translateY(-1px)';
                    card.style.boxShadow = '0 4px 12px rgba(99,102,241,0.25)';

                    if (previewOverlay && !confirmed) {
                        previewOverlay[enabledKey] = true;
                        previewOverlay[styleKey] = item.id;
                        if (!previewOverlay[thickKey] || previewOverlay[thickKey] <= 0) previewOverlay[thickKey] = 3;
                        if (!previewOverlay[colorKey]) previewOverlay[colorKey] = '#FFD700';
                        if (!previewOverlay[posKey]) previewOverlay[posKey] = 'bottom';
                        if (!previewOverlay[alignKey]) previewOverlay[alignKey] = 'center';
                        if (previewOverlay[gapKey] === undefined) previewOverlay[gapKey] = 12;
                        if (previewOverlay[opKey] === undefined) previewOverlay[opKey] = 100;
                        if (item.parameters) {
                            previewOverlay[paramsKey] = {
                                ...(previewOverlay[paramsKey] || {}),
                                ...item.parameters,
                                preset: item.preset || item
                            };
                        } else {
                            if (previewOverlay[paramsKey]) {
                                delete previewOverlay[paramsKey].preset;
                            }
                        }
                        renderPreview();
                    }
                });

                card.addEventListener('mouseleave', () => {
                    card.style.borderColor = isSelected ? '#818cf8' : '#2b3145';
                    card.style.background = isSelected ? '#1e2238' : '#1a1d2b';
                    card.style.transform = 'none';
                    card.style.boxShadow = isSelected ? '0 0 10px rgba(99,102,241,0.3)' : 'none';

                    if (!confirmed) {
                        restorePreview();
                    }
                });

                // 点击确定选用
                card.addEventListener('click', () => {
                    confirmed = true;
                    // 1. 勾选启用开关
                    this._val(`${uiPrefix}-enabled`, true);
                    const enabledEl = this.container.querySelector(`#${uiPrefix}-enabled`);
                    if (enabledEl) {
                        enabledEl.checked = true;
                        enabledEl.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                    // 2. 更新对应样式下拉菜单
                    const selectEl = this.container.querySelector(`#${uiPrefix}-style`);
                    if (selectEl) {
                        let opt = selectEl.querySelector(`option[value="${item.id}"]`);
                        if (!opt) {
                            opt = document.createElement('option');
                            opt.value = item.id;
                            opt.textContent = item.name;
                            selectEl.appendChild(opt);
                        }
                        selectEl.value = item.id;
                        selectEl.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                    // 3. 矢量参数同步到UI
                    if (item.parameters) {
                        const p = item.parameters;
                        if (p.decorationScale !== undefined) {
                            this._val(`${uiPrefix}-scale`, p.decorationScale);
                        }
                        if (p.centerGap !== undefined) {
                            this._val(`${uiPrefix}-center-gap`, p.centerGap);
                        }
                        if (p.lineCap) {
                            this._val(`${uiPrefix}-linecap`, p.lineCap);
                        }
                        if (p.flip !== undefined) {
                            this._val(`${uiPrefix}-flip`, !!p.flip);
                        }
                    }
                    if (previewOverlay) {
                        previewOverlay[enabledKey] = true;
                        previewOverlay[styleKey] = item.id;
                        if (!previewOverlay[thickKey] || previewOverlay[thickKey] <= 0) previewOverlay[thickKey] = 3;
                        if (!previewOverlay[colorKey]) previewOverlay[colorKey] = '#FFD700';
                        if (item.parameters) {
                            previewOverlay[paramsKey] = {
                                ...(previewOverlay[paramsKey] || {}),
                                ...item.parameters,
                                preset: item.preset || item
                            };
                        }
                    }
                    this._syncToOverlay();
                    this.videoCanvas?.onOverlayChange?.(previewOverlay);
                    renderPreview();
                    cleanup();
                    popover.remove();
                });
            });
        };

        renderTabs();
        renderCards();

        // 搜索过滤
        const searchInput = header.querySelector('.rop-palette-search-input');
        if (searchInput) {
            searchInput.addEventListener('input', () => {
                searchQuery = searchInput.value.trim().toLowerCase();
                renderCards();
            });
        }

        // 导入导出
        header.querySelector('.rop-palette-import-btn')?.addEventListener('click', (e) => {
            e.stopPropagation();
            this._importPersonalDecorationPresets(() => {
                renderTabs();
                renderCards();
            });
        });

        header.querySelector('.rop-palette-export-btn')?.addEventListener('click', (e) => {
            e.stopPropagation();
            this._exportPersonalDecorationPresets();
        });

        popover.appendChild(grid);
        document.body.appendChild(popover);

        // 精准定位：悬浮在按钮旁，靠右对齐避免挡住左侧视频画布
        const rect = anchorEl ? anchorEl.getBoundingClientRect() : null;
        let top = rect ? rect.bottom + 6 : 100;
        let left = rect ? rect.left - 240 : 100;

        if (!rect || (!rect.width && !rect.height)) {
            top = Math.max(20, (window.innerHeight - 560) / 2);
            left = Math.max(20, (window.innerWidth - 620) / 2);
        } else {
            if (top + 560 > window.innerHeight) {
                if (rect.top - 570 > 10) {
                    top = rect.top - 570;
                } else {
                    top = Math.max(10, window.innerHeight - 570);
                }
            }
            if (left + 630 > window.innerWidth) {
                left = Math.max(10, window.innerWidth - 630);
            }
            if (left < 10) left = 10;
            if (top < 10) top = 10;
        }

        popover.style.top = `${top}px`;
        popover.style.left = `${left}px`;

        const closePopover = () => {
            if (!confirmed) restorePreview();
            cleanup();
            popover.remove();
        };

        const onKey = (e) => {
            if (e.key === 'Escape') closePopover();
        };

        const onOutside = (e) => {
            if (!popover.contains(e.target) && e.target !== anchorEl && !anchorEl?.contains(e.target)) {
                closePopover();
            }
        };

        const cleanup = () => {
            document.removeEventListener('keydown', onKey);
            document.removeEventListener('mousedown', onOutside);
        };

        header.querySelector('.rop-palette-close-btn')?.addEventListener('click', closePopover);
        setTimeout(() => {
            document.addEventListener('keydown', onKey);
            document.addEventListener('mousedown', onOutside);
        }, 50);
    }


    _requestRender() {
        if (!this.videoCanvas) return;
        if (this._renderRaf) cancelAnimationFrame(this._renderRaf);
        this._renderRaf = requestAnimationFrame(() => {
            this._renderRaf = null;
            if (this.videoCanvas) this.videoCanvas.render();
        });
    }

    _syncPresetPreviewBackgroundLabel() {
        const label = this.container?.querySelector('#rop-preset-preview-bg-label');
        if (!label) return;
        const preview = window._reelsState?._overlayPresetPreviewBackground;
        label.textContent = preview?.path ? String(preview.path).split(/[/\\]/).pop() : '未设置';
        label.title = preview?.path
            ? `临时预览：${preview.path}\n不保存到预设或任务，也不影响导出`
            : '不保存到预设或任务，也不影响导出';
    }

    async _pickPresetPreviewBackground() {
        const state = window._reelsState;
        if (!state || state.selectedIdx < 0) return alert('请先选择一个 Reels 任务，再编辑覆层预设');
        const paths = await window.electronAPI?.selectFiles?.({
            title: '选择仅用于覆层预设编辑的背景', multiple: false,
            filters: [{ name: '图片或视频', extensions: ['mp4', 'mov', 'mkv', 'avi', 'webm', 'jpg', 'jpeg', 'png', 'webp', 'gif'] }]
        });
        const path = Array.isArray(paths) ? paths[0] : '';
        if (!path) return;
        // 只存内存中的预览覆写，不修改 task.bgPath，也不会进入预设序列化。
        state._overlayPresetPreviewBackground = { taskIndex: state.selectedIdx, path };
        this._syncPresetPreviewBackgroundLabel();
        if (typeof reelsUpdatePreview === 'function') reelsUpdatePreview();
    }

    _clearPresetPreviewBackground() {
        if (window._reelsState) delete window._reelsState._overlayPresetPreviewBackground;
        this._syncPresetPreviewBackgroundLabel();
        if (typeof reelsUpdatePreview === 'function') reelsUpdatePreview();
    }

    _init() {
        this.container.innerHTML = `
        <div class="rop-panel">
            <!-- 覆层组预设 (多层) -->
            <div class="rop-section">
                <div class="rop-group">
                    <div class="rop-group-title">覆层组预设</div>
                    <div style="display:flex;gap:4px;align-items:center;flex-wrap:wrap;">
                        <select id="rop-group-preset-select" class="rop-select" style="display:none;"></select>
                        <button type="button" id="rop-group-preset-trigger" class="rop-select" style="flex:1;min-width:110px;height:26px;padding:0 8px;display:flex;align-items:center;justify-content:space-between;gap:6px;cursor:pointer;text-align:left;" title="点击选择覆层预设（支持实时搜索）">
                            <span id="rop-group-preset-label" style="min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">-- 选择预设 --</span><span style="font-size:8px;flex-shrink:0;">▼</span>
                        </button>
                        <div style="display:flex;gap:4px;flex-shrink:0;">
                            <button class="btn btn-secondary rop-btn" id="rop-group-preset-load" style="padding:2px 8px;" title="加载预设（已有覆层时可选择合并追加或覆盖替换）">加载</button>
                            <button class="btn btn-secondary rop-btn" id="rop-group-preset-append" style="padding:2px 8px;background:rgba(16,185,129,0.18);color:#34d399;border:1px solid rgba(16,185,129,0.35);" title="直接将预设合并追加到现有覆层（不覆盖当前图层）">➕追加</button>
                            <button class="btn btn-secondary rop-btn" id="rop-group-preset-gallery" style="padding:2px 8px;background:var(--accent-primary,#7b8bef);color:#fff;" title="打开可视化预设库">📂 预设库</button>
                        </div>
                    </div>
                    <div class="rop-btn-grid" style="margin-top:4px;">
                        <button class="btn btn-secondary rop-btn" id="rop-group-preset-update" style="background:var(--accent-primary,#5b6abf);color:#fff;" title="直接覆盖更新当前选中的预设">更新</button>
                        <button class="btn btn-secondary rop-btn" id="rop-group-preset-save" title="另存为新预设">另存</button>
                        <button class="btn btn-secondary rop-btn" id="rop-group-preset-rename">重命名</button>
                        <button class="btn btn-secondary rop-btn" id="rop-group-preset-del">删除</button>
                        <button class="btn btn-secondary rop-btn" id="rop-group-preset-import">导入</button>
                        <button class="btn btn-secondary rop-btn" id="rop-group-preset-export">导出</button>
                    </div>
                    <div style="display:flex;align-items:center;gap:4px;margin-top:6px;padding-top:6px;border-top:1px solid var(--border-color);flex-wrap:wrap;">
                        <span style="font-size:11px;color:var(--text-secondary);white-space:nowrap;">仅预览背景</span>
                        <button class="btn btn-secondary rop-btn" id="rop-preset-preview-bg-pick" style="padding:2px 7px;">选择</button>
                        <button class="btn btn-secondary rop-btn" id="rop-preset-preview-bg-clear" style="padding:2px 7px;">清除</button>
                        <span id="rop-preset-preview-bg-label" title="不保存到预设或任务，也不影响导出" style="flex:1;min-width:50px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px;color:var(--text-muted);">未设置</span>
                    </div>
                </div>
            </div>

            <!-- 覆层列表 -->
            <div class="rop-section">
                <div class="rop-header">
                    <div style="display:flex;justify-content:space-between;align-items:center;">
                        <span>覆层列表</span>
                    </div>
                    <div class="rop-header-actions">
                        <div class="rop-layer-slot-picker">
                            <span class="rop-layer-slot-label">新增层分类</span>
                            <select id="rop-layer-slot" class="rop-select" title="新覆层的固定业务层位；批量表按此层位定位，不受添加顺序影响">
                            <option value="">自动按类型分类</option>
                            <option value="script">文案层</option><option value="media">媒体层</option><option value="scroll_subtitle">滚动字幕层</option><option value="particle">粒子层</option><option value="phone_cta">电话邀约层</option><option value="title">仅标题层</option><option value="gif">GIF 动态层</option><option value="watermark">水印层</option><option value="background_layer">背景层</option><option value="pip_sermon">画中画（讲道）</option><option value="pip_audience">画中画（观众）</option><option value="pip_audience_main">画中画（主观众）</option>
                            <option value="pip_primary">画中画主层</option><option value="pip_secondary">画中画次层</option><option value="pip_general">通用画中画层</option>
                            <option value="phone_primary">电话主层</option><option value="phone_secondary">电话次层</option><option value="phone_general">通用电话层</option>
                            <option value="__custom__">自定义层位…</option>
                            </select>
                        </div>
                        <div class="rop-header-add-actions">
                        <!-- 新增内容：先按用户最常添加的文字 → 媒体 → 辅助图层排序。 -->
                        <button class="btn btn-secondary rop-btn" id="rop-add-text" title="添加一个普通文字层（无底色）">+ 纯文字</button>
                        <button class="btn btn-secondary rop-btn" id="rop-add-textcard" title="添加带标题条/底色的文字卡片" style="background:#FFD700;color:#000;">+ 文字卡片</button>
                        <button class="btn btn-secondary rop-btn" id="rop-add-scroll" title="添加滚动字幕" style="background:#FF6B35;color:#fff;">+ 滚动字幕</button>
                        <button class="btn btn-secondary rop-btn" id="rop-add-image" title="从电脑选择图片/视频/动图加到当前任务；多选会批量添加为独立图层">+ 媒体</button>
                        <button class="btn btn-secondary rop-btn" id="rop-media-library" title="打开常用素材库（固定保存的图片/视频）" style="padding:2px 6px;">📂 素材</button>
                        <button class="btn btn-secondary rop-btn" id="rop-add-phone-cta" title="添加电话邀约覆层">+ 电话邀约</button>
                        <button class="btn btn-secondary rop-btn" id="rop-add-decor" title="添加一个粒子覆层，使用同一列表管理层级和显隐">+ 粒子</button>
                        <button class="btn btn-secondary rop-btn" id="rop-add-solidmask" title="添加一块纯色半透明遮罩（压暗背景用）" style="background:#4CAF50;color:#fff;">+ 纯色蒙版</button>
                        <!-- 批量与审计是后续操作，放在新增按钮之后。 -->
                        <button class="btn btn-secondary rop-btn" id="rop-batch-add-media" title="选择图片/视频，一次加到当前分组里的每一个任务（如统一加 logo、水印）；先选中一个图片层会沿用它的位置大小" style="background:rgba(59,130,246,.18);color:#bfdbfe;border-color:rgba(96,165,250,.5);">图片/视频加到整组</button>
                        <button class="btn btn-secondary rop-btn" id="rop-layer-slot-audit" title="检查本组每个任务的图层：有没有同一位置重复的层、有没有未分类的层；只检查，不会自动修改" style="color:#bfdbfe;border-color:rgba(96,165,250,.5);">检查重复图层</button>
                        </div>
                    </div>
                </div>
                <div id="rop-media-drop-target" title="拖入一个或多个图片、视频或动图；会添加到当前任务分组的每一个任务。若已选中媒体，新加图层会继承它的位置、大小、时间和动画设置。" style="margin:6px 0 4px;padding:7px 8px;border:1px dashed rgba(96,165,250,.62);border-radius:6px;color:#93c5fd;background:rgba(59,130,246,.06);font-size:11px;text-align:center;transition:.15s;">
                    📥 拖入多个图片/视频，批量添加到当前任务组（沿用当前媒体设置）
                </div>
                <label style="display:flex;align-items:center;gap:6px;margin:6px 0;font-size:11px;cursor:pointer;color:var(--text-secondary);flex-wrap:wrap;" title="关闭后，动态字幕会显示在所有覆层上方">
                    <input type="checkbox" id="rop-overlay-above-subtitle" checked> 覆层显示在动态字幕上方
                </label>
                <div id="rop-overlay-list" class="rop-list"></div>
            </div>

            <!-- 属性编辑 -->
            <div id="rop-props" class="rop-section" style="display:none;">
                <div class="rop-header"><span>属性</span></div>
                <div id="rop-decor-props" style="display:none;"></div>
                <div id="rop-phone-cta-props" style="display:none;"></div>

                <!-- 固定文案标记 -->
                <div id="rop-fixed-text-group" class="rop-group" style="display:none;">
                    <div style="display:flex;align-items:center;gap:8px;">
                        <input type="checkbox" id="rop-fixed-text" style="width:16px;height:16px;cursor:pointer;">
                        <label for="rop-fixed-text" style="font-size:12px;color:var(--text-secondary);cursor:pointer;">固定文案 / 纯蒙版 🔒 <span style="color:var(--text-muted);font-size:11px;">— 勾选后此卡片将拒绝接收表格中的批量文案</span></label>
                    </div>
                </div>

                <!-- 文字卡片专属：卡片模板与重置 (在全局最上面) -->
                <div id="rop-textcard-template-props" class="rop-group" style="display:none; padding-bottom: 12px; margin-bottom: 8px; border-bottom: 1px solid var(--border-color);">
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                        <div class="rop-group-title" style="margin:0;">卡片模板</div>
                        <label style="display:flex;align-items:center;gap:4px;font-size:11px;cursor:pointer;color:var(--text-primary); margin:0;">
                            <input type="checkbox" id="rop-card-apply-all">
                            <span title="批量生成的任务会限制在当前任务组内">应用到当前任务组</span>
                        </label>
                    </div>
                    <div style="display:flex;gap:4px;margin-top:4px;flex-wrap:wrap;">
                        <select id="rop-card-tpl-select" class="rop-select" style="flex:1;min-width:110px;">
                            <option value="">-- 选择模板 --</option>
                        </select>
                        <button class="btn btn-secondary rop-btn" id="rop-card-load-tpl" style="padding:2px 8px;">加载</button>
                    </div>
                    <div class="rop-btn-grid" style="margin-top:4px;">
                        <button class="btn btn-secondary rop-btn" id="rop-card-save-tpl">保存</button>
                        <button class="btn btn-secondary rop-btn" id="rop-card-del-tpl">删除</button>
                        <button class="btn btn-secondary rop-btn" id="rop-card-import-tpl">导入</button>
                        <button class="btn btn-secondary rop-btn" id="rop-card-export-tpl">导出</button>
                    </div>
                    <div class="rop-grid" style="margin-top:8px;">
                        <label>卡片开始(s)</label><input type="number" id="rop-card-start" class="rop-input" step="0.1" min="0" title="卡片文字和它的蒙版同时出现">
                        <label>卡片结束(s)</label><input type="number" id="rop-card-end" class="rop-input" step="0.1" min="0" title="卡片文字和它的蒙版同时消失">
                    </div>
                    <label style="display:flex;align-items:center;gap:6px;margin-top:7px;font-size:11px;cursor:pointer;">
                        <input type="checkbox" id="rop-card-time-linked" checked> 文字与蒙版共用时间
                    </label>
                    <div id="rop-mask-time-fields" class="rop-grid" style="margin-top:6px;display:none;">
                        <label>蒙版开始(s)</label><input type="number" id="rop-mask-start" class="rop-input" step="0.1" min="0">
                        <label>蒙版结束(s)</label><input type="number" id="rop-mask-end" class="rop-input" step="0.1" min="0">
                    </div>
                    <div style="margin-top:6px;">
                        <button class="btn btn-secondary rop-btn rop-reset-all" id="rop-card-reset-all" style="width:100%; border-color:#d75c5c; color:#d75c5c;" title="将整张卡片的排版、样式和特效彻底恢复为新建时的干净状态，保留文字内容与时间。">↺ 恢复卡片初始设置 (Factory Reset)</button>
                    </div>
                </div>

                <!-- 变换 -->
                <div id="rop-transform-group" class="rop-group">
                    <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;">
                        <div class="rop-group-title" style="margin:0;">变换</div>
                        <div style="display:flex;gap:4px;" id="rop-transform-btns">
                            <button class="rop-reset-all rop-reset-transform-btn" title="恢复默认位置和大小">↺ 默认</button>
                            <button class="rop-reset-all rop-fill-screen-btn" title="一键铺满画布">📐 全屏填充</button>
                        </div>
                    </div>
                    <div class="rop-grid" style="margin-top:6px;">
                        <label id="rop-xy-label-x">位置X</label><input type="number" id="rop-x" class="rop-input" step="1">
                        <label id="rop-xy-label-y">位置Y</label><input type="number" id="rop-y" class="rop-input" step="1">
                        <label id="rop-wh-label-w">宽度</label><input type="number" id="rop-w" class="rop-input" step="1">
                        <label id="rop-wh-label-h">高度</label><input type="number" id="rop-h" class="rop-input" step="1">
                        <label id="rop-rotation-label">旋转</label><input type="number" id="rop-rotation" class="rop-input" min="-360" max="360" value="0">
                        <label id="rop-opacity-label">不透明</label>
                        <input type="number" id="rop-opacity" class="rop-input" min="0" max="100" step="1" value="100">
                        <label id="rop-scale-label" style="display:none;">总缩放%</label>
                        <input type="number" id="rop-scale" class="rop-input" min="1" max="1000" step="0.1" value="100" style="display:none;" title="总缩放：调节时 X、Y 一起变化；可再用 X/Y 单独微调">
                        <label id="rop-scale-x-label" style="display:none;">缩放 X%</label>
                        <input type="number" id="rop-scale-x" class="rop-input" min="1" max="1000" step="0.1" value="100" style="display:none;">
                        <label id="rop-scale-y-label" style="display:none;">缩放 Y%</label>
                        <input type="number" id="rop-scale-y" class="rop-input" min="1" max="1000" step="0.1" value="100" style="display:none;">
                        <div id="rop-time-in-transform" style="display:contents;">
                        <label>开始时间(s)</label><input type="number" id="rop-start" class="rop-input" step="0.1" min="0">
                        <label>结束时间(s)</label><input type="number" id="rop-end" class="rop-input" step="0.1" min="0">
                        </div>
                        <!-- ═══ A→B 位移动画 ═══ -->
                        <div style="grid-column: span 2; font-size:12px; color:var(--accent); margin-top:8px; margin-bottom:2px; border-bottom: 1px solid var(--border-color); padding-bottom: 4px; display:flex; justify-content:space-between; align-items:center;">
                            🎬 A→B 位移动画
                            <div style="display:flex;align-items:center;gap:6px;">
                                <button id="rop-anim-preview-end" class="btn btn-secondary" style="padding:1px 8px;font-size:11px;border-radius:4px;" title="切换预览终点位置">👁 预览终点</button>
                                <label style="display:flex;align-items:center;gap:4px;font-weight:normal;color:var(--text-primary);cursor:pointer;">
                                    <input type="checkbox" id="rop-anim-dest-enabled"> 启用
                                </label>
                            </div>
                        </div>
                        <div style="grid-column: span 2; font-size:11px; color:var(--text-muted); margin-bottom:4px;">从起点坐标平滑移动到终点坐标，需要点击▶播放预览查看效果</div>
                        <label>缓动</label>
                        <select id="rop-anim-easing" class="rop-select">
                            <option value="ease_in_out_quad">缓入缓出</option>
                            <option value="ease_out_quad">仅缓出</option>
                            <option value="ease_in_quad">仅缓入</option>
                            <option value="linear">线性</option>
                            <option value="ease_out_expo">快速缓出</option>
                            <option value="ease_in_out_expo">快速缓入缓出</option>
                        </select>
                        <label>控制方式</label>
                        <select id="rop-anim-timing-mode" class="rop-select">
                            <option value="duration">按时长</option>
                            <option value="speed">按速度</option>
                        </select>
                        <label>移动时长(s)</label><input type="number" id="rop-anim-duration" class="rop-input" step="0.01" min="0" title="0=自动使用覆层结束时间-开始时间；大于0=按指定秒数从A移动到B">
                        <label>移动速度(px/s)</label><input type="number" id="rop-anim-speed" class="rop-input" step="1" min="0" title="按速度模式下生效；0=回退到按时长">
                        <div style="grid-column: span 2; display:grid; grid-template-columns: 58px 1fr 1fr; gap:6px; align-items:center;">
                            <label style="font-size:12px;color:var(--text-secondary);">起点</label>
                            <input type="number" id="rop-anim-start-x" class="rop-input" step="1" title="起点 X，媒体/文本为相对画布中心的中心点偏移">
                            <input type="number" id="rop-anim-start-y" class="rop-input" step="1" title="起点 Y，媒体/文本为相对画布中心的中心点偏移">
                        </div>
                        <div style="grid-column: span 2; display:grid; grid-template-columns: 58px 1fr 1fr; gap:6px; align-items:center;">
                            <label style="font-size:12px;color:var(--text-secondary);">终点</label>
                            <input type="number" id="rop-anim-end-x" class="rop-input" step="1" title="终点 X，媒体/文本为相对画布中心的中心点偏移">
                            <input type="number" id="rop-anim-end-y" class="rop-input" step="1" title="终点 Y，媒体/文本为相对画布中心的中心点偏移">
                        </div>
                        <label>起点缩放%</label>
                        <div style="display:flex;align-items:center;gap:6px;">
                            <input type="range" id="rop-anim-start-scale" class="rop-range" min="1" max="1000" step="0.1" value="100" style="flex:1;">
                            <span id="rop-anim-start-scale-val" style="min-width:36px;text-align:right;font-size:12px;color:var(--text-muted);">100%</span>
                        </div>
                        <label>终点缩放%</label>
                        <div style="display:flex;align-items:center;gap:6px;">
                            <input type="range" id="rop-anim-end-scale" class="rop-range" min="1" max="1000" step="0.1" value="100" style="flex:1;">
                            <span id="rop-anim-end-scale-val" style="min-width:36px;text-align:right;font-size:12px;color:var(--text-muted);">100%</span>
                        </div>
                    </div>
                </div>

                <div id="rop-card-position-props" class="rop-group" style="display:none;">
                    <div class="rop-section-title" style="font-size:13px;font-weight:bold;margin-bottom:8px;">整体卡片位移</div>
                    <div class="rop-grid" id="rop-card-position-grid" style="margin-bottom:8px;">
                        <label>整体卡片位置X</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-card-x" class="rop-range rop-defaultable" data-default="0" min="-540" max="540" value="0"><input type="number" class="rop-num-readout" data-link="rop-card-x" min="-540" max="540" value="0"><button class="rop-reset-btn" data-target="rop-card-x" title="恢复默认">↺</button></div>
                        <label>整体卡片位置Y</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-card-y" class="rop-range rop-defaultable" data-default="0" min="-960" max="960" value="0"><input type="number" class="rop-num-readout" data-link="rop-card-y" min="-960" max="960" value="0"><button class="rop-reset-btn" data-target="rop-card-y" title="恢复默认">↺</button></div>
                    </div>
                </div>

                <!-- 文字卡片布局/自动缩放（textcard覆层独有，靠近变换/动画） -->
                <div id="rop-textcard-layout-props" class="rop-group" style="display:none;">
                    <div class="rop-section-title" style="margin:0; font-size:13px; font-weight:bold; color:var(--text-color); margin-bottom:8px; border-bottom: 1px solid var(--border-color); padding-bottom: 4px;">蒙版与布局</div>
                    <div class="rop-group-title" style="display:flex; align-items:center; gap:6px; margin-top:8px; margin-bottom:4px;">
                        <span>蒙版设置</span>
                        <label style="display:flex; align-items:center; gap:4px; font-size:11px; color:var(--text-secondary); font-weight:normal; text-transform:none; letter-spacing:0; cursor:pointer; margin-left:auto;">
                            <input type="checkbox" id="rop-card-enabled" class="rop-defaultable" data-default="true">
                            启用
                        </label>
                    </div>
                    <div id="rop-card-mask-grid" class="rop-grid" style="margin-top:6px;">
                        <label>蒙版颜色</label><input type="color" id="rop-card-color" class="rop-color rop-defaultable" data-default="#ffffff" value="#ffffff">
                        <label>蒙版透明%</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-card-opacity" class="rop-range rop-defaultable" data-default="80" min="0" max="100" value="80"><input type="number" class="rop-num-readout" data-link="rop-card-opacity" min="0" max="100" value="80"><button class="rop-reset-btn" data-target="rop-card-opacity" title="恢复默认">↺</button></div>
                        <label>蒙版圆角</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-radius-all" class="rop-range rop-defaultable" data-default="33" min="0" max="200" value="33"><input type="number" class="rop-num-readout" data-link="rop-radius-all" min="0" max="200" value="33"><button class="rop-reset-btn" data-target="rop-radius-all" title="恢复默认">↺</button></div>
                        <label>蒙版宽度</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-card-width" class="rop-range rop-defaultable" data-default="910" min="100" max="1080" value="910"><input type="number" class="rop-num-readout" data-link="rop-card-width" min="100" max="1080" value="910"><button class="rop-reset-btn" data-target="rop-card-width" title="恢复默认">↺</button></div>
                        <label>蒙版高度</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-card-height" class="rop-range rop-defaultable" data-default="1300" min="0" max="1920" value="1300"><input type="number" class="rop-num-readout" data-link="rop-card-height" min="0" max="1920" value="1300"><button class="rop-reset-btn" data-target="rop-card-height" title="恢复默认">↺</button></div>
                        <label>全屏蒙版</label><input type="checkbox" id="rop-fullscreen-mask" class="rop-defaultable" data-default="false">
                        
                        <div style="grid-column: span 2; font-size:11px; color:var(--accent); margin-top:6px; margin-bottom:2px; border-bottom: 1px solid var(--border-color); padding-bottom: 4px;">背景羽化</div>
                        <label>开启羽化</label><input type="checkbox" id="rop-card-feather-enabled" class="rop-defaultable" data-default="false">
                        <label>羽化方向</label>
                        <select id="rop-card-feather-dir" class="rop-select rop-defaultable" data-default="bottom">
                            <option value="bottom">底部透明</option>
                            <option value="top">顶部透明</option>
                            <option value="left">左侧透明</option>
                            <option value="right">右侧透明</option>
                            <option value="radial">四周边缘透明</option>
                        </select>
                        <label>实体边界%</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-card-feather-start" class="rop-range rop-defaultable" data-default="50" min="0" max="100" value="50"><input type="number" class="rop-num-readout" data-link="rop-card-feather-start" min="0" max="100" value="50"><button class="rop-reset-btn" data-target="rop-card-feather-start" title="恢复默认">↺</button></div>
                        <label>全透明边界%</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-card-feather-end" class="rop-range rop-defaultable" data-default="100" min="0" max="100" value="100"><input type="number" class="rop-num-readout" data-link="rop-card-feather-end" min="0" max="100" value="100"><button class="rop-reset-btn" data-target="rop-card-feather-end" title="恢复默认">↺</button></div>
                    </div>

                    <div style="grid-column: span 2; font-size:11px; color:var(--accent); margin-top:6px; margin-bottom:2px; border-bottom: 1px solid var(--border-color); padding-bottom: 4px;">蒙版边框</div>
                    <div id="rop-card-border-grid" class="rop-grid" style="margin-top:6px;">
                        <label>开启边框</label><input type="checkbox" id="rop-card-border-enabled" class="rop-defaultable" data-default="false">
                        <label>边框位置</label>
                        <select id="rop-card-border-sides" class="rop-select rop-defaultable" data-default="all">
                            <option value="all">四周全包</option>
                            <option value="top">仅上方</option>
                            <option value="bottom">仅下方</option>
                            <option value="left">仅左侧</option>
                            <option value="right">仅右侧</option>
                            <option value="top-bottom">上下边</option>
                            <option value="left-right">左右边</option>
                        </select>
                        <label>边框颜色</label><input type="color" id="rop-card-border-color" class="rop-color rop-defaultable" data-default="#FFD700" value="#FFD700">
                        <label>边框粗细</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-card-border-width" class="rop-range rop-defaultable" data-default="3" min="1" max="20" value="3"><input type="number" class="rop-num-readout" data-link="rop-card-border-width" min="1" max="20" value="3"><button class="rop-reset-btn" data-target="rop-card-border-width" title="恢复默认">↺</button></div>
                        <label>边框样式</label>
                        <select id="rop-card-border-style" class="rop-select rop-defaultable" data-default="solid">
                            <option value="solid">实线</option><option value="dashed">虚线</option><option value="dotted">点线</option>
                        </select>
                        <label>边框透明%</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-card-border-opacity" class="rop-range rop-defaultable" data-default="100" min="0" max="100" value="100"><input type="number" class="rop-num-readout" data-link="rop-card-border-opacity" min="0" max="100" value="100"><button class="rop-reset-btn" data-target="rop-card-border-opacity" title="恢复默认">↺</button></div>
                    </div>

                    <div style="grid-column: span 2; font-size:11px; color:var(--accent); margin-top:6px; margin-bottom:2px; border-bottom: 1px solid var(--border-color); padding-bottom: 4px;">磨砂模糊</div>
                    <div id="rop-card-blur-grid" class="rop-grid" style="margin-top:6px;">
                        <label>开启磨砂</label><input type="checkbox" id="rop-card-blur-enabled" class="rop-defaultable" data-default="false">
                        <label>模糊强度</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-card-blur-amount" class="rop-range rop-defaultable" data-default="10" min="1" max="40" value="10"><input type="number" class="rop-num-readout" data-link="rop-card-blur-amount" min="1" max="40" value="10"><button class="rop-reset-btn" data-target="rop-card-blur-amount" title="恢复默认">↺</button></div>
                    </div>

                    <div id="rop-textcard-only-text-layout-inner" style="display:contents;">
                        <div class="rop-group-title" style="display:flex; align-items:center; gap:6px; margin-top:8px; margin-bottom:4px; padding-bottom:4px;">
                            <span>蒙版与文字设置</span>
                        </div>
                        <div class="rop-grid">
                            <label>自动适配</label><input type="checkbox" id="rop-auto-fit" class="rop-defaultable" data-default="false">
                            <label>垂直居中</label><input type="checkbox" id="rop-auto-center" class="rop-defaultable" data-default="false">
                            <label>文字位置X</label>
                            <div class="rop-slider-combo"><input type="range" id="rop-offset-x" class="rop-range rop-defaultable" data-default="0" min="-500" max="500" value="0"><input type="number" class="rop-num-readout" data-link="rop-offset-x" min="-500" max="500" value="0"><button class="rop-reset-btn" data-target="rop-offset-x" title="恢复默认">↺</button></div>
                            <label>文字位置Y</label>
                            <div class="rop-slider-combo"><input type="range" id="rop-offset-y" class="rop-range rop-defaultable" data-default="0" min="-500" max="500" value="0"><input type="number" class="rop-num-readout" data-link="rop-offset-y" min="-500" max="500" value="0"><button class="rop-reset-btn" data-target="rop-offset-y" title="恢复默认">↺</button></div>
                            <label>标题与正文间距</label>
                            <div class="rop-slider-combo"><input type="range" id="rop-title-body-gap" class="rop-range rop-defaultable" data-default="42" min="0" max="500" value="42"><input type="number" class="rop-num-readout" data-link="rop-title-body-gap" min="0" max="500" value="42"><button class="rop-reset-btn" data-target="rop-title-body-gap" title="恢复默认">↺</button></div>
                            <label>并排左右间距</label>
                            <div class="rop-slider-combo"><input type="range" id="rop-side-by-side-gap" class="rop-range rop-defaultable" data-default="90" min="0" max="500" value="90"><input type="number" class="rop-num-readout" data-link="rop-side-by-side-gap" min="0" max="500" value="90"><button class="rop-reset-btn" data-target="rop-side-by-side-gap" title="恢复默认">↺</button></div>
                            <label>标题宽度%</label>
                            <div class="rop-slider-combo"><input type="range" id="rop-side-by-side-title-ratio" class="rop-range rop-defaultable" data-default="50" min="10" max="90" value="50"><input type="number" class="rop-num-readout" data-link="rop-side-by-side-title-ratio" min="10" max="90" value="50"><button class="rop-reset-btn" data-target="rop-side-by-side-title-ratio" title="恢复默认">↺</button></div>
                            <label>正文与结尾间距</label>
                            <div class="rop-slider-combo"><input type="range" id="rop-body-footer-gap" class="rop-range rop-defaultable" data-default="42" min="0" max="500" value="42"><input type="number" class="rop-num-readout" data-link="rop-body-footer-gap" min="0" max="500" value="42"><button class="rop-reset-btn" data-target="rop-body-footer-gap" title="恢复默认">↺</button></div>
                            <label>文字上边距</label>
                            <div class="rop-slider-combo"><input type="range" id="rop-pad-top" class="rop-range rop-defaultable" data-default="60" min="0" max="200" value="60"><input type="number" class="rop-num-readout" data-link="rop-pad-top" min="0" max="200" value="60"><button class="rop-reset-btn" data-target="rop-pad-top" title="恢复默认">↺</button></div>
                            <label>文字下边距</label>
                            <div class="rop-slider-combo"><input type="range" id="rop-pad-bottom" class="rop-range rop-defaultable" data-default="60" min="0" max="200" value="60"><input type="number" class="rop-num-readout" data-link="rop-pad-bottom" min="0" max="200" value="60"><button class="rop-reset-btn" data-target="rop-pad-bottom" title="恢复默认">↺</button></div>
                            <label>左边距</label>
                            <div class="rop-slider-combo"><input type="range" id="rop-pad-left" class="rop-range rop-defaultable" data-default="40" min="0" max="200" value="40"><input type="number" class="rop-num-readout" data-link="rop-pad-left" min="0" max="200" value="40"><button class="rop-reset-btn" data-target="rop-pad-left" title="恢复默认">↺</button></div>
                            <label>右边距</label>
                            <div class="rop-slider-combo"><input type="range" id="rop-pad-right" class="rop-range rop-defaultable" data-default="40" min="0" max="200" value="40"><input type="number" class="rop-num-readout" data-link="rop-pad-right" min="0" max="200" value="40"><button class="rop-reset-btn" data-target="rop-pad-right" title="恢复默认">↺</button></div>
                        </div>
                    </div>
                    <div id="rop-textcard-only-shrink-inner" style="display:contents;">
                        <div class="rop-group-title" style="display:flex; align-items:center; gap:6px; margin-top:8px; margin-bottom:4px;">
                            <span>自动缩放设置</span>
                            <label style="display:flex; align-items:center; gap:4px; font-size:11px; color:var(--text-secondary); font-weight:normal; text-transform:none; letter-spacing:0; cursor:pointer; margin-left:auto;">
                                <input type="checkbox" id="rop-auto-shrink" class="rop-defaultable" data-default="false">
                                启用
                            </label>
                        </div>
                        <div style="font-size:11px;color:var(--text-secondary);margin:2px 0 6px 0;line-height:1.5;">
                            规则：开启“自动适配”后，按“最大高度/最小字号”自动缩字；关闭后，蒙版高度按手动值生效。
                        </div>
                        <div class="rop-grid">
                            <label>最大高度</label>
                            <div class="rop-slider-combo"><input type="range" id="rop-max-height" class="rop-range rop-defaultable" data-default="1400" min="200" max="1920" value="1400"><input type="number" class="rop-num-readout" data-link="rop-max-height" min="200" max="1920" value="1600"><button class="rop-reset-btn" data-target="rop-max-height" title="恢复默认">↺</button></div>
                            <label>标题缩放行</label>
                            <div class="rop-slider-combo"><input type="range" id="rop-title-max-lines" class="rop-range rop-defaultable" data-default="3" min="1" max="10" value="3"><input type="number" class="rop-num-readout" data-link="rop-title-max-lines" min="1" max="10" value="3"><button class="rop-reset-btn" data-target="rop-title-max-lines" title="恢复默认">↺</button></div>
                            <label>最小字号</label>
                            <div class="rop-slider-combo"><input type="range" id="rop-min-fontsize" class="rop-range rop-defaultable" data-default="16" min="8" max="40" value="16"><input type="number" class="rop-num-readout" data-link="rop-min-fontsize" min="8" max="40" value="16"><button class="rop-reset-btn" data-target="rop-min-fontsize" title="恢复默认">↺</button></div>
                        </div>
                    </div>
                </div>

                <div id="rop-textcard-debug-props" class="rop-group" style="display:none;">
                    <div class="rop-group-title rop-section-title" style="margin:0; font-size:13px; font-weight:bold; color:var(--text-color); margin-bottom:8px; border-bottom: 1px solid var(--border-color); padding-bottom: 4px;">排版模式与辅助线</div>
                    <div class="rop-grid">
                        <label>排版模式</label>
                        <select id="rop-layout-mode" class="rop-select rop-defaultable" data-default="flow">
                            <option value="flow">流式(自动向下贴叠)</option>
                            <option value="side_by_side">并排(标题 / 正文)</option>
                            <option value="absolute">独立(完全解绑坐标)</option>
                        </select>
                        <label>显示全局卡片框</label><input type="checkbox" id="rop-debug-layout" class="rop-defaultable" data-default="false">
                        <label>显示标题边界框</label><input type="checkbox" id="rop-debug-title" class="rop-defaultable" data-default="false">
                        <label>显示正文边界框</label><input type="checkbox" id="rop-debug-body" class="rop-defaultable" data-default="false">
                        <label>显示结尾边界框</label><input type="checkbox" id="rop-debug-footer" class="rop-defaultable" data-default="false">
                    </div>
                </div>


                <!-- 文本属性 (文本覆层独有) -->
                <div id="rop-text-props" class="rop-group" style="display:none;">
                    <div class="rop-group-title">文本</div>
                    <textarea id="rop-content" class="rop-textarea" rows="3" placeholder="覆层文本内容"></textarea>
                    <div class="rop-grid">
                        <label>字体</label>
                        <select id="rop-font" class="rop-select">
                            <option>Arial</option><option>Helvetica</option><option>Impact</option>
                            <option>Roboto</option><option>Open Sans</option>
                        </select>
                        <label>字号</label><input type="number" id="rop-fontsize" class="rop-input" min="8" max="300" value="40">
                        <label>颜色</label><input type="color" id="rop-color" class="rop-color" value="#ffffff">
                        <label>粗体</label><input type="checkbox" id="rop-bold">
                        <label>字重</label>
                        <select id="rop-font-weight" class="rop-select">
                            <option value="100">Thin</option><option value="200">ExtraLight</option><option value="300">Light</option>
                            <option value="400">Regular</option><option value="500">Medium</option><option value="600">SemiBold</option>
                            <option value="700" selected>Bold</option><option value="800">ExtraBold</option><option value="900">Black</option>
                        </select>
                        <label>开启描边</label><input type="checkbox" id="rop-use-stroke">
                        <label>描边色</label><input type="color" id="rop-stroke-color" class="rop-color" value="#000000">
                        <label>描边宽</label><input type="number" id="rop-stroke-width" class="rop-input" min="0" max="20" step="0.5" value="0">
                        <label>开启阴影</label><input type="checkbox" id="rop-shadow-enabled">
                        <label>阴影色</label><input type="color" id="rop-shadow-color" class="rop-color" value="#000000">
                        <label>阴影模糊</label><input type="number" id="rop-shadow-blur" class="rop-input" min="0" max="50" value="0">
                        <label>阴影 X</label><input type="number" id="rop-shadow-offset-x" class="rop-input" min="-100" max="100" step="0.5" value="4">
                        <label>阴影 Y</label><input type="number" id="rop-shadow-offset-y" class="rop-input" min="-100" max="100" step="0.5" value="4">
                        <label>阴影不透明%</label><input type="number" id="rop-shadow-opacity" class="rop-input" min="0" max="100" step="1" value="47">
                    </div>
                </div>

                <!-- 图片属性 (图片/视频覆层) -->
                <div id="rop-image-props" class="rop-group" style="display:none;">
                    <div class="rop-group-title">媒体(图/视/动图)</div>
                    <div id="rop-media-source-drop-target" title="拖入一个媒体文件替换当前覆层；拖入一个文件夹设置循环素材" style="margin:0 0 8px;padding:7px;border:1px dashed var(--border-color);border-radius:5px;background:rgba(255,255,255,.025);">
                        <div style="font-size:10px;color:#93c5fd;margin-bottom:5px;">📥 拖入文件替换 · 拖入文件夹循环</div>
                        <div id="rop-media-source-label" style="font-size:10px;color:var(--text-muted);margin-bottom:3px;">当前媒体路径</div>
                        <div id="rop-media-source" style="font-size:10px;line-height:1.35;word-break:break-all;color:var(--text-primary);max-height:42px;overflow:auto;">—</div>
                        <div style="display:flex;gap:5px;flex-wrap:wrap;margin-top:6px;">
                            <button type="button" id="rop-media-replace" class="rop-reset-all">替换媒体文件</button>
                            <button type="button" id="rop-media-folder" class="rop-reset-all">选择循环文件夹</button>
                            <button type="button" id="rop-pip-media-library" class="rop-reset-all" title="从总目录的子文件夹或独立媒体中选择">画中画媒体库</button>
                            <button type="button" id="rop-media-folder-clear" class="rop-reset-all">清除文件夹循环</button>
                        </div>
                        <div id="rop-media-folder-status" style="font-size:10px;color:var(--text-muted);margin-top:5px;">未使用文件夹循环</div>
                    </div>
                    <div class="rop-grid">
                        <label>显示模式</label><select id="rop-media-window-mode" class="rop-select"><option value="none">原始覆层媒体（默认）</option><option value="pip">画中画（固定窗口）</option><option value="top_half">上半屏（固定裁切窗口）</option><option value="bottom_half">下半屏（固定裁切窗口）</option></select>
                        <div id="rop-media-split-controls" style="grid-column:1 / -1;display:none;padding:8px 0;border-top:1px solid var(--border-color)">
                            <label for="rop-media-split-angle">上下拼接斜角（°）</label>
                            <div style="display:flex;gap:8px;align-items:center"><input type="range" id="rop-media-split-angle-slider" min="-45" max="45" step="1" value="0" style="flex:1;min-width:0"><input type="number" id="rop-media-split-angle" class="rop-input" min="-45" max="45" step="1" value="0" style="width:72px"></div>
                            <small>0° 为水平拼接；正数左高右低，负数左低右高。同任务的上、下半屏同步角度，人物保持正向。</small>
                        </div>
                        <div id="rop-media-crop" style="grid-column:1 / -1;margin:2px 0 0;padding:7px 0;border-top:1px solid var(--border-color);">
                            <div style="font-size:11px;color:var(--text-muted);margin-bottom:5px;">窗口四向裁切（%，收缩显示窗口，不放大素材；全部显示模式生效）</div>
                            <div class="rop-grid">
                                <label>裁左</label><input type="number" id="rop-media-crop-left" class="rop-input" min="0" max="99" step="1" value="0">
                                <label>裁上</label><input type="number" id="rop-media-crop-top" class="rop-input" min="0" max="99" step="1" value="0">
                                <label>裁右</label><input type="number" id="rop-media-crop-right" class="rop-input" min="0" max="99" step="1" value="0">
                                <label>裁下</label><input type="number" id="rop-media-crop-bottom" class="rop-input" min="0" max="99" step="1" value="0">
                            </div>
                        </div>
                        <label>画中画窗口比例</label><select id="rop-media-window-ratio" class="rop-select"><option value="free">自由比例</option><option value="1:1">1:1 方形</option><option value="9:16" selected>9:16 竖屏</option><option value="3:4">3:4 竖图</option><option value="4:3">4:3 横图</option><option value="16:9">16:9 横屏</option></select>
                        <label>画中画窗口宽</label><input type="number" id="rop-media-window-width" class="rop-input" min="1" step="1" value="540" title="自由比例时可独立调整；固定比例时高度自动跟随此宽度">
                        <label>画中画窗口高</label><input type="number" id="rop-media-window-height" class="rop-input" min="1" step="1" value="960" title="仅自由比例时可独立调整">
                        <label>画中画裁切形状</label><select id="rop-media-mask-shape" class="rop-select" title="仅画中画生效；圆形按短边裁切，椭圆按窗口尺寸裁切"><option value="rect">矩形</option><option value="round_rect">圆角矩形</option><option value="circle">圆形</option><option value="ellipse">椭圆</option></select>
                        <label>圆角</label><input type="number" id="rop-media-corner-all" class="rop-input" min="0" max="1000" step="1" value="0" title="统一调整四个圆角；大于 0 时自动切换为圆角矩形">
                        <input type="hidden" id="rop-media-corner-tl" value="0">
                        <input type="hidden" id="rop-media-corner-tr" value="0">
                        <input type="hidden" id="rop-media-corner-br" value="0">
                        <input type="hidden" id="rop-media-corner-bl" value="0">
                        <label>画中画边框样式</label><select id="rop-media-border-style" class="rop-select"><option value="none">无边框（默认）</option><option value="thin">白色细边</option><option value="bold">白色粗边</option><option value="gold">金色描边</option><option value="dark">深色描边</option><option value="double">双线边框</option><option value="dashed">虚线边框</option><option value="glow">柔光边框</option><option value="metal_silver">质感 · 拉丝银</option><option value="metal_gold">质感 · 香槟金</option><option value="glass">质感 · 通透玻璃</option><option value="embossed">质感 · 立体浮雕</option></select>
                        <label>边框位置</label><select id="rop-media-border-position" class="rop-select"><option value="inside">内边框</option><option value="outside">外边框</option></select>
                        <label>边框颜色</label><input type="color" id="rop-media-border-color" value="#ffffff">
                        <label>边框粗细(px)</label><input type="number" id="rop-media-border-width" class="rop-input" min="1" max="100" step="1" value="3">
                        <label>边框不透明度%</label><input type="number" id="rop-media-border-opacity" class="rop-input" min="0" max="100" value="100">
                        <label>静态模糊补满</label><input type="checkbox" id="rop-media-blur-fill" title="默认关闭；开启后用媒体入点的一帧模糊补满固定窗口，前景保持原比例">
                        <label>循环播放</label><input type="checkbox" id="rop-media-loop" checked title="视频不足成片时长时自动循环">
                        <label>开启媒体声音</label><input type="checkbox" id="rop-media-audio-enabled" title="默认关闭。开启后，视频媒体覆层的原声音轨会写入 MP4 和 FCPXML 复合片段">
                        <label>文件夹切换间隔(秒，0=原片全长)</label><input type="number" id="rop-media-folder-interval" class="rop-input" step="0.1" min="0" value="0" title="默认0：视频完整播放后切换，图片停留5秒；正数为固定切换间隔">
                        <label>窗口内素材 X</label><input type="number" id="rop-media-inner-x" class="rop-input" step="1" value="0" title="拖动素材在固定裁切区内的位置；上/下半屏同样生效">
                        <label>窗口内素材 Y</label><input type="number" id="rop-media-inner-y" class="rop-input" step="1" value="0" title="拖动素材在固定裁切区内的位置；上/下半屏同样生效">
                        <label>窗口内素材缩放%</label><input type="number" id="rop-media-inner-scale" class="rop-input" step="1" min="1" value="100" title="仅缩放固定窗口内的素材，不改变外层窗口">
                        <label>窗口内素材旋转</label><input type="number" id="rop-media-inner-rotation" class="rop-input" step="1" min="-360" max="360" value="0" title="仅旋转固定窗口内的素材，不改变外层窗口">
                        <label>先定格等待</label><input type="checkbox" id="rop-delay-enabled" title="默认关闭；等待时显示原片入点帧并静音。仅单个视频；循环播放时每轮均含等待段。">
                        <label>等待秒数</label><input type="number" id="rop-delay-seconds" class="rop-input" min="0" max="600" step="0.1" value="5">
                        <button type="button" id="rop-delay-apply" class="rop-btn">应用等待播放</button><span id="rop-delay-status" role="status"></span>
                        <label>原片入点（秒）</label><input type="number" id="rop-video-offset" class="rop-input" step="0.1" min="0" value="0" title="单个视频从此处开始；开启循环后回到此处">
                        <label>原片出点（秒）</label><input type="number" id="rop-video-end" class="rop-input" step="0.1" min="0" placeholder="留空＝原片结尾" title="单个视频只播放入点到出点之间的片段，循环也只循环此区间">
                        <label>保持比例</label><input type="checkbox" id="rop-keep-aspect" checked>
                        <label>水平翻转</label><input type="checkbox" id="rop-flip-h">
                        <label>垂直翻转</label><input type="checkbox" id="rop-flip-v">
                        <label>混合模式</label>
                        <select id="rop-blend" class="rop-select">
                            <option value="source-over">正常</option>
                            <option value="multiply">正片叠底</option>
                            <option value="screen">滤色</option>
                            <option value="overlay">叠加</option>
                        </select>
                    </div>
                    <div id="rop-media-window-align" style="margin-top:8px;padding-top:7px;border-top:1px solid var(--border-color);">
                        <div style="font-size:11px;color:var(--text-muted);margin-bottom:5px;">画中画窗口快速定位</div>
                        <div style="display:grid;grid-template-columns:repeat(3,32px);gap:4px;justify-content:start;">
                            <button type="button" class="rop-media-align" data-align="tl" title="左上">↖</button><button type="button" class="rop-media-align" data-align="tc" title="上方居中">↑</button><button type="button" class="rop-media-align" data-align="tr" title="右上">↗</button>
                            <button type="button" class="rop-media-align" data-align="cl" title="左侧居中">←</button><button type="button" class="rop-media-align" data-align="cc" title="居中">＋</button><button type="button" class="rop-media-align" data-align="cr" title="右侧居中">→</button>
                            <button type="button" class="rop-media-align" data-align="bl" title="左下">↙</button><button type="button" class="rop-media-align" data-align="bc" title="下方居中">↓</button><button type="button" class="rop-media-align" data-align="br" title="右下">↘</button>
                        </div>
                    </div>
                    <!-- 跟随滚动字幕绑定 -->
                    <div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border-color);">
                        <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">
                            <span style="font-size:12px;color:var(--accent-primary,#7b8bef);font-weight:600;">🔗 跟随滚动字幕</span>
                        </div>
                        <div class="rop-grid">
                            <label>绑定目标</label>
                            <select id="rop-bind-scroll-target" class="rop-select">
                                <option value="">— 不绑定 —</option>
                            </select>
                            <label title="Y方向偏移(正=下移)">Y偏移</label><input type="number" id="rop-bind-scroll-offset-y" class="rop-input" step="10" value="0">
                            <label title="Y上限(最小Y，图片不会超过此位置往上)">上边界Y</label><input type="number" id="rop-bind-scroll-clamp-min-y" class="rop-input" step="10" placeholder="不限">
                            <label title="Y下限(最大Y，图片不会超过此位置往下)">下边界Y</label><input type="number" id="rop-bind-scroll-clamp-max-y" class="rop-input" step="10" placeholder="不限">
                            <label title="X方向偏移(配合跟随X使用)">X偏移</label><input type="number" id="rop-bind-scroll-offset-x" class="rop-input" step="10" value="0">
                            <label>跟随X</label><input type="checkbox" id="rop-bind-scroll-follow-x">
                        </div>
                        <div style="font-size:10px;color:var(--text-muted);margin-top:4px;line-height:1.4;">绑定后，此媒体覆层的 Y 坐标将跟随滚动字幕正文第一行实时移动。上/下边界限制图片的移动范围。</div>
                    </div>
                </div>



                <!-- ⏱ 动态翻转设置 (适用于文本和文字卡片) -->
                <div id="rop-flipper-group" class="rop-group" style="display:none; border: 1px dashed var(--accent-primary,#7b8bef); padding: 8px; border-radius: 6px; margin-top: 8px;">
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
                        <div class="rop-group-title" style="margin:0;color:var(--accent-primary,#7b8bef);display:flex;align-items:center;gap:4px;">
                            <span>⏱ 动态翻转设置</span>
                        </div>
                        <label style="display:flex;align-items:center;gap:4px;font-size:12px;cursor:pointer;color:var(--accent-primary,#7b8bef);margin:0;font-weight:bold;">
                            <input type="checkbox" id="rop-flipper-enabled" style="width:14px;height:14px;">
                            <span>开启翻转</span>
                        </label>
                    </div>
                    <div class="rop-grid" id="rop-flipper-controls" style="margin-top:6px;">
                        <label>切换间隔(秒)</label>
                        <input type="number" id="rop-flipper-duration" class="rop-input" step="0.1" min="0.1" value="2.0">
                        
                        <label>每次显示行数</label>
                        <input type="number" id="rop-flipper-lines" class="rop-input" step="1" min="1" value="2">
                        
                        <label>切换效果</label>
                        <select id="rop-flipper-effect" class="rop-select">
                            <option value="none">硬切 (None)</option>
                            <option value="fade">渐变淡入淡出 (Fade)</option>
                            <option value="slide">平滑向上滑动 (Slide)</option>
                        </select>

                        <label>过渡动画时长(秒)</label>
                        <input type="number" id="rop-flipper-transition-duration" class="rop-input" step="0.05" min="0.0" value="0.3">

                        <label>播放完循环</label>
                        <input type="checkbox" id="rop-flipper-loop" style="width:16px;height:16px;">
                    </div>
                    <div id="rop-flipper-duration-info" style="font-size:11px;color:var(--text-secondary);margin-top:6px;line-height:1.4;background:rgba(123,139,239,0.1);padding:4px 6px;border-radius:4px;">
                        💡 翻转完毕需: -- 秒 (总行数: --)
                    </div>
                </div>

                <!-- 滚动字幕属性 (scroll覆层独合) -->
                <div id="rop-scroll-props" class="rop-group" style="display:none;">
                    <div style="display:flex;justify-content:space-between;align-items:center;">
                        <div class="rop-group-title" style="margin:0;">滚动字幕</div>
                        <label style="display:flex;align-items:center;gap:4px;font-size:11px;cursor:pointer;color:var(--text-primary); margin:0;">
                            <input type="checkbox" id="rop-scroll-apply-all">
                            <span title="批量生成的任务会限制在当前任务组内">应用到当前任务组</span>
                        </label>
                    </div>

                    <!-- ① 内容：标题在前，正文在后 -->
                    <div class="rop-group-title" style="margin-top:4px;">标题</div>
                    <div class="rop-grid">
                        <label>标题文字</label>
                        <div style="display:flex;gap:6px;align-items:center;">
                            <input type="text" id="rop-scroll-title" class="rop-input" placeholder="留空=无标题" style="flex:1;">
                            <button class="rop-richtext-btn" data-section="scroll_title" title="逐字样式编辑" style="padding:4px 8px;border:1px solid var(--border-color,#555);background:var(--bg-secondary,#2a2a3e);color:var(--accent-primary,#7b8bef);border-radius:6px;cursor:pointer;font-size:12px;white-space:nowrap;">✎ 富文本</button>
                        </div>
                        <label>固定标题</label>
                        <div style="display:flex;align-items:center;gap:6px;">
                            <input type="checkbox" id="rop-scroll-title-fixed" checked>
                            <span style="font-size:11px;color:var(--text-muted);">标题不参与滚动</span>
                        </div>
                        <label>独立位置</label>
                        <div style="display:flex;align-items:center;gap:6px;">
                            <input type="checkbox" id="rop-scroll-title-independent">
                            <span style="font-size:11px;color:var(--text-muted);">不挤占正文滚动区</span>
                        </div>
                        <label title="标题中心 X；留空时跟随正文中心">标题X</label><input type="number" id="rop-scroll-title-x" class="rop-input" step="10" placeholder="跟随正文">
                        <label title="标题顶部 Y；留空时使用裁切区顶部">标题Y</label><input type="number" id="rop-scroll-title-y" class="rop-input" step="10" placeholder="裁切顶部">
                        <label>标题字号</label><input type="number" id="rop-scroll-title-fontsize" class="rop-input" min="8" max="300" value="56">
                        <label>标题颜色</label><input type="color" id="rop-scroll-title-color" class="rop-color" value="#ffffff">
                        <label>标题字体</label>
                        <select id="rop-scroll-title-font" class="rop-select" data-allow-empty="true" data-empty-label="跟随正文"></select>
                        <label>标题字重</label>
                        <select id="rop-scroll-title-weight" class="rop-select">
                            <option value="400">Regular</option><option value="500">Medium</option>
                            <option value="600">SemiBold</option><option value="700" selected>Bold</option>
                            <option value="800">ExtraBold</option><option value="900">Black</option>
                        </select>
                        <label>标题大写</label><input type="checkbox" id="rop-scroll-title-uppercase" checked>
                        <label>字符间距</label><input type="number" id="rop-scroll-title-letterspacing" class="rop-input" min="-20" max="100" value="0">
                        <label>标题对齐</label>
                        <select id="rop-scroll-title-align" class="rop-select">
                            <option value="">跟随正文</option><option value="center">居中</option><option value="left">左对齐</option><option value="right">右对齐</option>
                        </select>
                        <label>文字方向</label>
                        <select id="rop-scroll-text-direction" class="rop-select" title="自动识别阿拉伯语、希伯来语等从右向左文字">
                            <option value="auto">自动（阿拉伯语 RTL）</option><option value="ltr">从左向右</option><option value="rtl">从右向左</option>
                        </select>
                        <label>标题行距</label><input type="number" id="rop-scroll-title-linespacing" class="rop-input" min="0" max="50" step="1" value="6">
                        <label>标题文本宽度</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-scroll-title-textw" class="rop-range" min="100" max="1920" step="10" value="900"><input type="number" class="rop-num-readout" data-link="rop-scroll-title-textw" min="100" max="1920" step="10" value="900"></div>
                        <span style="grid-column: span 2; font-size:10px; color:var(--text-muted);">默认显示当前正文宽度，可单独调整标题宽度</span>
                        <label>标题间距</label><input type="number" id="rop-scroll-title-gap" class="rop-input" min="0" max="200" step="5" value="20">
                        <label>标题自动缩放</label>
                        <div style="display:flex;align-items:center;gap:6px;">
                            <input type="checkbox" id="rop-scroll-title-auto-fit">
                            <span style="font-size:11px;color:var(--text-muted);">超高时自动缩小</span>
                        </div>
                        <label>标题最大高</label><input type="number" id="rop-scroll-title-maxh" class="rop-input" min="0" max="1000" step="10" value="0" title="0=不限制">
                        <div style="grid-column: span 2; font-size:11px; color:var(--accent); margin-top:6px; margin-bottom:2px; border-bottom: 1px solid var(--border-color); padding-bottom: 4px;">标题特效</div>
                        <label>描边颜色</label><input type="color" id="rop-scroll-title-stroke-color" class="rop-color" value="#000000">
                        <label>描边宽度</label><input type="number" id="rop-scroll-title-stroke-width" class="rop-input" min="0" max="20" step="0.5" value="0">
                        <label>开启阴影</label><input type="checkbox" id="rop-scroll-title-shadow">
                        <label>阴影颜色</label><input type="color" id="rop-scroll-title-shadow-color" class="rop-color" value="#000000">
                        <label>阴影模糊</label><input type="number" id="rop-scroll-title-shadow-blur" class="rop-input" min="0" max="50" value="4">
                        <label>阴影偏移X</label><input type="number" id="rop-scroll-title-shadow-x" class="rop-input" min="-20" max="20" value="2">
                        <label>阴影偏移Y</label><input type="number" id="rop-scroll-title-shadow-y" class="rop-input" min="-20" max="20" value="2">
                        <div style="grid-column: span 2; font-size:11px; color:var(--accent); margin-top:6px; margin-bottom:2px; border-bottom: 1px solid var(--border-color); padding-bottom: 4px;">标题独立背景</div>
                        <label>开启背景</label><input type="checkbox" id="rop-scroll-title-bg-enabled">
                        <label>背景模式</label>
                        <select id="rop-scroll-title-bg-mode" class="rop-select">
                            <option value="block">整块</option><option value="inline">每行独立包裹</option><option value="inline-joined">连体包裹</option>
                        </select>
                        <label>背景颜色</label><input type="color" id="rop-scroll-title-bg-color" class="rop-color" value="#000000">
                        <label>背景透明%</label><input type="number" id="rop-scroll-title-bg-opacity" class="rop-input" min="0" max="100" value="60">
                        <label>背景圆角</label><input type="number" id="rop-scroll-title-bg-radius" class="rop-input" min="0" max="100" value="12">
                        <label>背景水平内边距</label><input type="number" id="rop-scroll-title-bg-pad-h" class="rop-input" min="0" max="200" value="0">
                        <label>背景上边距</label><input type="number" id="rop-scroll-title-bg-pad-top" class="rop-input" min="0" max="200" value="0">
                        <label>背景下边距</label><input type="number" id="rop-scroll-title-bg-pad-bottom" class="rop-input" min="0" max="200" value="0">
                    </div>

                    <div style="font-size:11px; color:var(--accent); margin-top:8px; margin-bottom:2px; border-bottom: 1px solid var(--border-color); padding-bottom: 4px;">标题装饰线</div>
                    <div class="rop-grid">
                        <label>开启装饰线</label><input type="checkbox" id="rop-scroll-title-deco-enabled">
                        <label>线段位置</label>
                        <select id="rop-scroll-title-deco-position" class="rop-select">
                            <option value="top">上方</option><option value="bottom">下方</option><option value="left">左侧</option><option value="right">右侧</option>
                        </select>
                        <label>样式</label>
                        <div style="display:flex;gap:4px;align-items:center;min-width:0;"><select id="rop-scroll-title-deco-style" class="rop-select" style="flex:1;min-width:0;">
                            <option value="solid">实线</option><option value="dashed">虚线</option><option value="dotted">点线</option><option value="double">双线</option><option value="gradient">渐变线</option>
                        </select><button type="button" id="rop-scroll-title-deco-gallery" class="rop-btn" title="打开可视化装饰线色板 (划过实时预览 · 138款爆款/几何/花体样式)" style="padding:2px 6px;font-size:11px;height:24px;white-space:nowrap;background:linear-gradient(135deg, #2b3144, #1f2433);border:1px solid #4a5568;border-radius:4px;color:#c7d2fe;display:inline-flex;align-items:center;gap:2px;cursor:pointer;">👁 色板</button><button type="button" id="rop-scroll-title-deco-export" class="rop-btn" title="导出我的装饰线预设" style="padding:2px 5px;font-size:11px;height:24px;">📤</button></div>
                        <label>对齐</label>
                        <select id="rop-scroll-title-deco-align" class="rop-select">
                            <option value="left">左对齐</option><option value="center" selected>居中</option><option value="right">右对齐</option>
                        </select>
                        <label>线条颜色</label><input type="color" id="rop-scroll-title-deco-color" class="rop-color" value="#FFD700">
                        <label title="仅渐变样式生效">次颜色(渐变)</label><input type="color" id="rop-scroll-title-deco-color2" class="rop-color" value="#FF6B35">
                        <label>粗细</label><input type="number" id="rop-scroll-title-deco-thickness" class="rop-input" min="1" max="20" value="3">
                        <label title="0表示自动绑定文字本身的宽度/高度">长度(0=自动)</label><input type="number" id="rop-scroll-title-deco-length" class="rop-input" min="0" max="1000" value="0">
                        <label>距离</label><input type="number" id="rop-scroll-title-deco-gap" class="rop-input" min="-50" max="100" value="12">
                        <label>透明度%</label><input type="number" id="rop-scroll-title-deco-opacity" class="rop-input" min="0" max="100" value="100">
                        <label title="矢量装饰花纹整体缩放比例">花纹大小</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-scroll-title-deco-scale" class="rop-range" min="0.2" max="3" step="0.05" value="1"><input type="number" class="rop-num-readout" data-link="rop-scroll-title-deco-scale" min="0.2" max="3" step="0.05" value="1"></div>
                        <label title="中心花纹与左右两侧线段的避让留白距离">中心间距</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-scroll-title-deco-center-gap" class="rop-range" min="0" max="80" step="1" value="18"><input type="number" class="rop-num-readout" data-link="rop-scroll-title-deco-center-gap" min="0" max="80" step="1" value="18"></div>
                        <label>端点样式</label>
                        <select id="rop-scroll-title-deco-linecap" class="rop-select">
                            <option value="round" selected>圆角 (Round)</option>
                            <option value="butt">平头 (Butt)</option>
                            <option value="square">方形 (Square)</option>
                        </select>
                        <label>左右镜像</label>
                        <div style="display:flex;align-items:center;gap:6px;">
                            <input type="checkbox" id="rop-scroll-title-deco-flip">
                            <span style="font-size:11px;color:var(--text-muted);">水平翻转花纹</span>
                        </div>
                    </div>

                    <div class="rop-group-title" style="margin-top:6px;">正文</div>
                    <div style="display:flex;gap:6px;align-items:flex-start;">
                        <textarea id="rop-scroll-content" class="rop-textarea" rows="4" placeholder="滚动文字内容（正文）" style="flex:1;"></textarea>
                        <button class="rop-richtext-btn" data-section="scroll_body" title="逐字样式编辑" style="padding:4px 8px;border:1px solid var(--border-color,#555);background:var(--bg-secondary,#2a2a3e);color:var(--accent-primary,#7b8bef);border-radius:6px;cursor:pointer;font-size:12px;white-space:nowrap;">✎ 富文本</button>
                    </div>
                    <div class="rop-grid">
                        <label>字体</label>
                        <select id="rop-scroll-font" class="rop-select"></select>
                        <label>字号</label><input type="number" id="rop-scroll-fontsize" class="rop-input" min="8" max="300" value="40">
                        <label>颜色</label><input type="color" id="rop-scroll-color" class="rop-color" value="#ffffff">
                        <label>粗体</label><input type="checkbox" id="rop-scroll-bold">
                        <label>字重</label>
                        <select id="rop-scroll-weight" class="rop-select">
                            <option value="100">Thin</option><option value="200">ExtraLight</option><option value="300">Light</option>
                            <option value="400" selected>Regular</option><option value="500">Medium</option><option value="600">SemiBold</option>
                            <option value="700">Bold</option><option value="800">ExtraBold</option><option value="900">Black</option>
                        </select>
                        <label>正文大写</label><input type="checkbox" id="rop-scroll-uppercase">
                        <label>字符间距</label><input type="number" id="rop-scroll-letterspacing" class="rop-input" min="-20" max="100" value="0">
                        <label>对齐</label>
                        <select id="rop-scroll-align" class="rop-select">
                            <option value="center">居中</option><option value="left">左对齐</option><option value="right">右对齐</option>
                        </select>
                        <label>行距</label><input type="number" id="rop-scroll-linespacing" class="rop-input" min="0" max="50" step="1" value="6">
                        <label>文本宽度</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-scroll-textw" class="rop-range" min="100" max="1920" step="10" value="900"><input type="number" class="rop-num-readout" data-link="rop-scroll-textw" min="100" max="1920" step="10" value="900"></div>
                        <div style="grid-column: span 2; font-size:11px; color:var(--accent); margin-top:6px; margin-bottom:2px; border-bottom: 1px solid var(--border-color); padding-bottom: 4px;">正文特效</div>
                        <label>描边颜色</label><input type="color" id="rop-scroll-stroke-color" class="rop-color" value="#000000">
                        <label>描边宽度</label><input type="number" id="rop-scroll-stroke-width" class="rop-input" min="0" max="20" step="0.5" value="0">
                        <label>开启阴影</label><input type="checkbox" id="rop-scroll-shadow">
                        <label>阴影颜色</label><input type="color" id="rop-scroll-shadow-color" class="rop-color" value="#000000">
                        <label>阴影模糊</label><input type="number" id="rop-scroll-shadow-blur" class="rop-input" min="0" max="50" value="4">
                        <label>阴影偏移X</label><input type="number" id="rop-scroll-shadow-x" class="rop-input" min="-20" max="20" value="2">
                        <label>阴影偏移Y</label><input type="number" id="rop-scroll-shadow-y" class="rop-input" min="-20" max="20" value="2">
                        <div style="grid-column: span 2; font-size:11px; color:var(--accent); margin-top:6px; margin-bottom:2px; border-bottom: 1px solid var(--border-color); padding-bottom: 4px;">正文独立背景</div>
                        <label>开启背景</label><input type="checkbox" id="rop-scroll-body-bg-enabled">
                        <label>背景模式</label>
                        <select id="rop-scroll-body-bg-mode" class="rop-select">
                            <option value="block">整块</option><option value="inline">每行独立包裹</option><option value="inline-joined">连体包裹</option>
                        </select>
                        <label>背景颜色</label><input type="color" id="rop-scroll-body-bg-color" class="rop-color" value="#000000">
                        <label>背景透明%</label><input type="number" id="rop-scroll-body-bg-opacity" class="rop-input" min="0" max="100" value="60">
                        <label>背景圆角</label><input type="number" id="rop-scroll-body-bg-radius" class="rop-input" min="0" max="100" value="12">
                        <label>背景水平内边距</label><input type="number" id="rop-scroll-body-bg-pad-h" class="rop-input" min="0" max="200" value="0">
                        <label>背景上边距</label><input type="number" id="rop-scroll-body-bg-pad-top" class="rop-input" min="0" max="200" value="0">
                        <label>背景下边距</label><input type="number" id="rop-scroll-body-bg-pad-bottom" class="rop-input" min="0" max="200" value="0">
                    </div>

                    <!-- ③ 滚动运动：位置参数 -->
                    <div class="rop-group-title" style="margin-top:8px;">滚动运动
                        <button id="rop-scroll-show-end" class="btn btn-secondary" style="float:right;padding:1px 8px;font-size:11px;border-radius:4px;">👁 显示终点</button>
                    </div>
                    <div class="rop-grid">
                        <label title="整体水平位置（裁切区+文字一起移动）" style="font-weight:bold;color:#FF6B35;">整体X</label><input type="number" id="rop-scroll-offset-x" class="rop-input" step="10" value="0">
                        <label title="整体垂直位置（裁切区+文字一起移动）" style="font-weight:bold;color:#FF6B35;">整体Y</label><input type="number" id="rop-scroll-offset-y" class="rop-input" step="10" value="0">
                        <label>开始(s)</label><input type="number" id="rop-scroll-start-time" class="rop-input" step="0.1" min="0">
                        <label>结束(s)</label><input type="number" id="rop-scroll-end-time" class="rop-input" step="0.1" min="0">
                        <label title="文字开始向上滚动时的初始Y坐标">起始Y</label><input type="number" id="rop-scroll-from-y" class="rop-input" step="10" value="960">
                        <label title="文字向上滚动最终消失或停留的结束Y坐标">结束Y</label><input type="number" id="rop-scroll-to-y" class="rop-input" step="10" value="-200">
                        <label title="文字中心轴 X；文本宽度会从这个中心向左右展开">中心X</label><input type="number" id="rop-scroll-from-x" class="rop-input" step="10">
                        <!-- 速度参数已移除：速度由 距离÷时间 自动决定 -->
                        <input type="hidden" id="rop-scroll-speed" value="1">
                        <input type="hidden" id="rop-scroll-speed-num" value="1">
                    </div>

                    <!-- ④ 智能适配 -->
                    <div class="rop-group-title" style="margin-top:8px;">智能适配</div>
                    <div class="rop-grid">
                        <label>固定显示</label>
                        <div style="display:flex;align-items:center;gap:6px;">
                            <input type="checkbox" id="rop-scroll-static">
                            <span style="font-size:11px;color:var(--text-muted);">关闭滚动，全部文案固定显示</span>
                        </div>
                        <label>自动停止</label>
                        <div style="display:flex;align-items:center;gap:6px;">
                            <input type="checkbox" id="rop-scroll-auto-stop">
                            <span style="font-size:11px;color:var(--text-muted);">文字全显示后停止滚动</span>
                        </div>
                        <label>提前完成</label>
                        <div style="display:flex;align-items:center;gap:6px;">
                            <input type="number" id="rop-scroll-auto-stop-lead" class="rop-input" min="0" max="60" step="0.5" value="0" style="width:60px;">
                            <span style="font-size:11px;color:var(--text-muted);">秒（提前完成滚动，0=不提前）</span>
                        </div>
                        <label>正文自动缩放</label>
                        <div style="display:flex;align-items:center;gap:6px;">
                            <input type="checkbox" id="rop-scroll-auto-fit">
                            <span style="font-size:11px;color:var(--text-muted);">自动缩小确保全部显示</span>
                        </div>
                        <label>最小字号</label><input type="number" id="rop-scroll-min-fontsize" class="rop-input" min="8" max="200" value="16">
                    </div>

                    <!-- ⑤ 羽化 -->
                    <div class="rop-group-title" style="margin-top:8px;">羽化</div>
                    <div class="rop-grid">
                        <label>上羽化</label><input type="number" id="rop-scroll-feather-top" class="rop-input" min="0" max="500" step="10" value="80">
                        <label>上羽化偏移</label><input type="number" id="rop-scroll-feather-top-offset" class="rop-input" min="0" max="500" step="10" value="0" title="在此距离内文字完全透明，不改变整体裁切区">
                        <label>下羽化</label><input type="number" id="rop-scroll-feather-bottom" class="rop-input" min="0" max="500" step="10" value="80">
                        <label>下羽化偏移</label><input type="number" id="rop-scroll-feather-bottom-offset" class="rop-input" min="0" max="500" step="10" value="0" title="在此距离内文字完全透明，不改变整体裁切区">
                        <label>左羽化</label><input type="number" id="rop-scroll-feather-left" class="rop-input" min="0" max="500" step="10" value="0">
                        <label>左羽化偏移</label><input type="number" id="rop-scroll-feather-left-offset" class="rop-input" min="0" max="500" step="10" value="0">
                        <label>右羽化</label><input type="number" id="rop-scroll-feather-right" class="rop-input" min="0" max="500" step="10" value="0">
                        <label>右羽化偏移</label><input type="number" id="rop-scroll-feather-right-offset" class="rop-input" min="0" max="500" step="10" value="0">
                    </div>

                    <!-- ⑥ 卡片背景 -->
                    <div class="rop-group-title" style="margin-top:8px;">卡片背景</div>
                    <div class="rop-grid">
                        <label>启用</label><input type="checkbox" id="rop-scroll-bg-enabled">
                        <label>颜色</label><input type="color" id="rop-scroll-bg-color" class="rop-color" value="#000000">
                        <label>透明度%</label><input type="number" id="rop-scroll-bg-opacity" class="rop-input" min="0" max="100" value="75">
                        <label>圆角</label><input type="number" id="rop-scroll-bg-radius" class="rop-input" min="0" max="200" value="12">
                        <label>上边距</label><input type="number" id="rop-scroll-bg-pad-top" class="rop-input" min="0" max="500" value="55">
                        <label>下边距</label><input type="number" id="rop-scroll-bg-pad-bottom" class="rop-input" min="0" max="500" value="55">
                        <label>左边距</label><input type="number" id="rop-scroll-bg-pad-left" class="rop-input" min="0" max="500" value="16">
                        <label>右边距</label><input type="number" id="rop-scroll-bg-pad-right" class="rop-input" min="0" max="500" value="16">
                        <label>全屏蒙版</label>
                        <div style="display:flex;align-items:center;gap:6px;">
                            <input type="checkbox" id="rop-scroll-bg-fullscreen">
                            <span style="font-size:11px;color:var(--text-muted);">背景铺满整个画面</span>
                        </div>
                        <div style="grid-column: span 2; font-size:11px; color:var(--accent); margin-top:6px; margin-bottom:2px; border-bottom: 1px solid var(--border-color); padding-bottom: 4px;">卡片边框</div>
                        <label>开启边框</label><input type="checkbox" id="rop-scroll-bg-border-enabled">
                        <label>边框位置</label>
                        <select id="rop-scroll-bg-border-sides" class="rop-select">
                            <option value="all">四周全包</option>
                            <option value="top">仅上方</option>
                            <option value="bottom">仅下方</option>
                            <option value="left">仅左侧</option>
                            <option value="right">仅右侧</option>
                            <option value="top-bottom">上下边</option>
                            <option value="left-right">左右边</option>
                        </select>
                        <label>边框颜色</label><input type="color" id="rop-scroll-bg-border-color" class="rop-color" value="#FFD700">
                        <label>边框粗细</label><input type="number" id="rop-scroll-bg-border-width" class="rop-input" min="1" max="20" value="3">
                        <label>边框样式</label>
                        <select id="rop-scroll-bg-border-style" class="rop-select">
                            <option value="solid">实线</option><option value="dashed">虚线</option><option value="dotted">点线</option>
                        </select>
                        <label>边框透明%</label><input type="number" id="rop-scroll-bg-border-opacity" class="rop-input" min="0" max="100" value="100">
                        <div style="grid-column: span 2; font-size:11px; color:var(--accent); margin-top:6px; margin-bottom:2px; border-bottom: 1px solid var(--border-color); padding-bottom: 4px;">磨砂模糊</div>
                        <label>开启磨砂</label><input type="checkbox" id="rop-scroll-bg-blur-enabled">
                        <label>模糊强度</label><input type="number" id="rop-scroll-bg-blur-amount" class="rop-input" min="1" max="40" value="10">
                    </div>
                </div>

                <!-- 文字卡片属性 (textcard覆层独有) -->
                <div id="rop-textcard-props" class="rop-group" style="display:none;">
                    <div class="rop-section-title" style="margin:0; font-size:13px; font-weight:bold; color:var(--text-color); margin-bottom:8px; border-bottom: 1px solid var(--border-color); padding-bottom: 4px;">文字设置</div>
                    <div class="rop-group-title" style="margin-top:8px; display:flex; justify-content:space-between; align-items:center;">
                        <span>标题</span>
                        <div style="display:flex; align-items:center; gap:4px; font-weight:normal; flex-wrap:wrap; justify-content:flex-end;">
                            <label for="rop-title-scheme-select" style="font-size:11px; color:var(--accent,#7b8bef); margin:0;">🎨 配色方案:</label>
                            <select id="rop-title-scheme-select" class="rop-select" style="width:120px; font-size:11px; padding:2px 4px; height:24px;">
                                <option value="">-- 个人配色预设 --</option>
                            </select>
                            <span id="rop-title-scheme-preview" style="display:none; width:20px; height:20px; border-radius:4px; border:1px solid rgba(255,255,255,0.25); vertical-align:middle; box-shadow:0 1px 3px rgba(0,0,0,0.3); flex-shrink:0; cursor:pointer;" title="点击打开视觉色板"></span>
                            <button id="rop-title-scheme-palette-btn" type="button" class="rop-btn" title="打开可视化色板 (所见即所得 · 划过画布实时预览)" style="padding:2px 6px; font-size:11px; height:24px; cursor:pointer; background:linear-gradient(135deg, #2b3144, #1f2433); border:1px solid #4a5568; border-radius:4px; color:#c7d2fe; display:inline-flex; align-items:center; gap:2px; white-space:nowrap; box-shadow:0 1px 3px rgba(0,0,0,0.3);">👁 色板</button>
                            <button id="rop-title-scheme-save" type="button" class="rop-btn" title="将当前标题样式另存为个人配色预设" style="padding:2px 6px; font-size:11px; height:24px; cursor:pointer; background:rgba(255,255,255,0.06); border:1px solid #4a5568; border-radius:4px; color:#e2e8f0; display:inline-flex; align-items:center; gap:2px; white-space:nowrap;">💾 另存</button>
                            <button id="rop-title-scheme-import" type="button" class="rop-btn" title="导入个人配色预设 JSON" style="padding:2px 6px; font-size:11px; height:24px; cursor:pointer; background:rgba(255,255,255,0.06); border:1px solid #4a5568; border-radius:4px; color:#e2e8f0; display:inline-flex; align-items:center; gap:2px; white-space:nowrap;">📥 导入</button>
                            <button id="rop-title-scheme-export" type="button" class="rop-btn" title="导出个人配色预设 JSON" style="padding:2px 6px; font-size:11px; height:24px; cursor:pointer; background:rgba(255,255,255,0.06); border:1px solid #4a5568; border-radius:4px; color:#e2e8f0; display:inline-flex; align-items:center; gap:2px; white-space:nowrap;">📤 导出</button>
                            <button id="rop-title-scheme-del" type="button" class="rop-btn rop-btn-danger" title="删除当前选中的个人配色预设" style="padding:2px 5px; font-size:11px; height:24px; cursor:pointer; background:rgba(255,255,255,0.06); border:1px solid #4a5568; border-radius:4px; display:inline-flex; align-items:center; gap:2px; white-space:nowrap;">🗑️</button>
                        </div>
                    </div>
                    <div style="display:flex;gap:6px;align-items:flex-start;">
                        <textarea id="rop-title-text" class="rop-textarea" rows="2" placeholder="标题文字" style="flex:1;"></textarea>
                        <button class="rop-richtext-btn" data-section="title" title="逐字样式编辑" style="padding:4px 8px;border:1px solid var(--border-color,#555);background:var(--bg-secondary,#2a2a3e);color:var(--accent-primary,#7b8bef);border-radius:6px;cursor:pointer;font-size:12px;white-space:nowrap;">✎ 富文本</button>
                    </div>
                    <div class="rop-grid">
                        <label>字体</label>
                        <select id="rop-title-font" class="rop-select rop-defaultable" data-default="Crimson Pro">
                        </select>
                        <label>手动字号</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-title-fontsize" class="rop-range rop-defaultable" data-default="60" min="12" max="200" value="60"><input type="number" class="rop-num-readout" data-link="rop-title-fontsize" min="12" max="200" value="60"><button class="rop-reset-btn" data-target="rop-title-fontsize" title="恢复默认">↺</button></div>
                        <label>颜色</label><input type="color" id="rop-title-color" class="rop-color rop-defaultable" data-default="#000000" value="#000000">
                        <label>粗体</label><input type="checkbox" id="rop-title-bold" class="rop-defaultable" data-default="true" checked>
                        <label>字重</label>
                        <select id="rop-title-weight" class="rop-select rop-defaultable" data-default="900">
                            <option value="100">Thin</option><option value="200">ExtraLight</option><option value="300">Light</option>
                            <option value="400">Regular</option><option value="500">Medium</option><option value="600">SemiBold</option>
                            <option value="700">Bold</option><option value="800">ExtraBold</option><option value="900" selected>Black</option>
                        </select>
                        <label>大写</label><input type="checkbox" id="rop-title-uppercase" class="rop-defaultable" data-default="true" checked>
                        <label>对齐</label>
                        <select id="rop-title-align" class="rop-select rop-defaultable" data-default="center">
                            <option value="center">水平居中</option><option value="left">左对齐</option><option value="right">右对齐</option>
                        </select>
                        <label>垂直对齐</label>
                        <select id="rop-title-valign" class="rop-select rop-defaultable" data-default="top">
                            <option value="center">垂直居中</option><option value="top">顶部对齐</option><option value="bottom">底部对齐</option>
                        </select>
                        <label>字符间距</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-title-letterspacing" class="rop-range rop-defaultable" data-default="0" min="-20" max="100" value="0"><input type="number" class="rop-num-readout" data-link="rop-title-letterspacing" min="-20" max="100" value="0"><button class="rop-reset-btn" data-target="rop-title-letterspacing" title="恢复默认(0)">↺</button></div>
                        <div style="grid-column:span 2;border-top:1px solid var(--border-color);padding-top:8px;margin-top:4px;">
                            <label style="display:flex;align-items:center;gap:6px;cursor:pointer;"><input type="checkbox" id="rop-title-adaptive-enabled" class="rop-defaultable" data-default="false">标题自适应 · 总开关（默认关闭）</label>
                        </div>
                        <div id="rop-title-adaptive-settings" class="rop-grid" style="grid-column:span 2;">
                        <label>最大字形高度</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-title-max-glyph-height" class="rop-range rop-defaultable" data-default="60" min="1" max="400" value="60"><input type="number" class="rop-num-readout" data-link="rop-title-max-glyph-height" min="1" max="400" value="60"><button class="rop-reset-btn" data-target="rop-title-max-glyph-height" title="恢复默认(60px)">↺</button></div>

                            <label>最多行数</label>
                            <div class="rop-slider-combo"><input type="range" id="rop-title-adaptive-max-lines" class="rop-range rop-defaultable" data-default="3" min="1" max="10" value="3"><input type="number" class="rop-num-readout" data-link="rop-title-adaptive-max-lines" min="1" max="10" value="3"><button class="rop-reset-btn" data-target="rop-title-adaptive-max-lines" title="恢复默认(3行)">↺</button></div>
                            <label>适中字形高度</label>
                            <div class="rop-slider-combo"><input type="range" id="rop-title-preferred-glyph-height" class="rop-range rop-defaultable" data-default="45" min="1" max="400" value="45"><input type="number" class="rop-num-readout" data-link="rop-title-preferred-glyph-height" min="1" max="400" value="45"><button class="rop-reset-btn" data-target="rop-title-preferred-glyph-height" title="恢复默认(45px)">↺</button></div>
                            <label>最小标题宽度</label>
                            <div class="rop-slider-combo"><input type="range" id="rop-title-adaptive-min-w" class="rop-range rop-defaultable" data-default="1080" min="1" max="1080" value="1080"><input type="number" class="rop-num-readout" data-link="rop-title-adaptive-min-w" min="1" max="1080" value="1080"><button class="rop-reset-btn" data-target="rop-title-adaptive-min-w" title="恢复默认(1080px)">↺</button></div>
                            <label>最小标题高度</label>
                            <div class="rop-slider-combo"><input type="range" id="rop-title-adaptive-min-h" class="rop-range rop-defaultable" data-default="200" min="1" max="1920" value="200"><input type="number" class="rop-num-readout" data-link="rop-title-adaptive-min-h" min="1" max="1920" value="200"><button class="rop-reset-btn" data-target="rop-title-adaptive-min-h" title="恢复默认(200px)">↺</button></div>
                            <label>最大标题宽度</label>
                            <div class="rop-slider-combo"><input type="range" id="rop-title-adaptive-max-w" class="rop-range rop-defaultable" data-default="1080" min="1" max="1080" value="1080"><input type="number" class="rop-num-readout" data-link="rop-title-adaptive-max-w" min="1" max="1080" value="1080"><button class="rop-reset-btn" data-target="rop-title-adaptive-max-w" title="恢复默认(1080px)">↺</button></div>
                            <label>最大标题高度</label>
                            <div class="rop-slider-combo"><input type="range" id="rop-title-adaptive-max-h" class="rop-range rop-defaultable" data-default="300" min="1" max="1920" value="300"><input type="number" class="rop-num-readout" data-link="rop-title-adaptive-max-h" min="1" max="1920" value="300"><button class="rop-reset-btn" data-target="rop-title-adaptive-max-h" title="恢复默认(300px)">↺</button></div>
                            <div style="grid-column:span 2;background:#111827;border:1px solid var(--border-color);border-radius:8px;padding:8px;">
                                <div style="font-size:12px;color:#e2e8f0;margin-bottom:6px;">实时效果 · 当前标题</div>
                                <canvas id="rop-title-adaptive-preview" role="img" aria-label="当前标题与最小、最大范围的实时预览" width="640" height="320" style="display:block;width:100%;height:auto;border-radius:5px;"></canvas>
                                <div style="display:flex;gap:12px;flex-wrap:wrap;font-size:11px;margin-top:6px;"><span style="color:#60a5fa;">▱ 最大范围</span><span style="color:#fbbf24;">▱ 最小范围</span><span style="color:#4ade80;">□ 实际标题框</span><span style="color:#fff;">＋ 固定中心</span><span style="color:#e879f9;">↕ 实际字形高度</span></div>
                                <div id="rop-title-adaptive-result" aria-live="polite" style="font-size:12px;color:#e2e8f0;line-height:1.6;margin-top:6px;"></div>
                                <div id="rop-title-adaptive-hint" style="font-size:11px;color:#fbbf24;line-height:1.5;"></div>
                            </div>
                            <div style="grid-column:span 2;font-size:11px;color:var(--text-secondary);line-height:1.5;">一套开关控制以上全部参数。优先保持适中字形，并遵守“最多行数”；短标题收紧到最小范围，长标题先展开范围，达到最大范围后才缩字。文字与背景共同居中，上下左右对称收放。关闭后使用手动字号和手动范围。</div>
                        </div>
                        <details id="rop-title-manual-settings" style="grid-column:span 2;">
                            <summary style="cursor:pointer;">手动文字范围（关闭自适应时使用）</summary>
                            <div class="rop-grid">
                        <label>手动文字宽度</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-title-override-w" class="rop-range rop-defaultable" data-default="830" min="1" max="1080" value="830"><input type="number" class="rop-num-readout" data-link="rop-title-override-w" min="1" max="1080" value="830"><button class="rop-reset-btn" data-target="rop-title-override-w" title="恢复当前内容宽度">↺</button></div>
                        <label>手动范围高度</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-title-override-h" class="rop-range rop-defaultable" data-default="0" min="0" max="1920" value="0"><input type="number" class="rop-num-readout" data-link="rop-title-override-h" min="0" max="1920" value="0"><button class="rop-reset-btn" data-target="rop-title-override-h" title="0=无限制">↺</button></div>
                            </div>
                        </details>
                        <label>行距</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-title-linespacing" class="rop-range rop-defaultable" data-default="0" min="-50" max="100" value="0"><input type="number" class="rop-num-readout" data-link="rop-title-linespacing" min="-50" max="100" value="0"><button class="rop-reset-btn" data-target="rop-title-linespacing" title="恢复默认(0)">↺</button></div>
                        <label>标题旋转</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-title-rotation" class="rop-range rop-defaultable" data-default="0" min="-180" max="180" value="0"><input type="number" class="rop-num-readout" data-link="rop-title-rotation" min="-180" max="180" value="0"><button class="rop-reset-btn" data-target="rop-title-rotation" title="恢复默认(0°)">↺</button></div>
                        <label class="rop-offset-label">标题内部偏移X</label>
                        <div class="rop-slider-combo rop-offset-input"><input type="range" id="rop-title-offset-x" class="rop-range rop-defaultable" data-default="0" min="-1080" max="1080" value="0"><input type="number" class="rop-num-readout" data-link="rop-title-offset-x" min="-1080" max="1080" value="0"><button class="rop-reset-btn" data-target="rop-title-offset-x" title="恢复默认(0)">↺</button></div>
                        <label class="rop-offset-label">标题内部偏移Y</label>
                        <div class="rop-slider-combo rop-offset-input"><input type="range" id="rop-title-offset-y" class="rop-range rop-defaultable" data-default="0" min="-1920" max="1920" value="0"><input type="number" class="rop-num-readout" data-link="rop-title-offset-y" min="-1920" max="1920" value="0"><button class="rop-reset-btn" data-target="rop-title-offset-y" title="恢复默认(0)">↺</button></div>
                        <div style="grid-column: span 2; font-size:11px; color:var(--accent); margin-top:6px; margin-bottom:2px; border-bottom: 1px solid var(--border-color); padding-bottom: 4px;">独立特效 & 背景</div>
                        <label>描边颜色</label><input type="color" id="rop-title-stroke-color" class="rop-color rop-defaultable" data-default="#000000" value="#000000">
                        <label>描边宽度</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-title-stroke-width" class="rop-range rop-defaultable" data-default="0" min="0" max="20" value="0"><input type="number" class="rop-num-readout" data-link="rop-title-stroke-width" min="0" max="20" value="0"><button class="rop-reset-btn" data-target="rop-title-stroke-width" title="恢复默认">↺</button></div>
                        <label>阴影颜色</label><input type="color" id="rop-title-shadow-color" class="rop-color rop-defaultable" data-default="#000000" value="#000000">
                        <label>阴影模糊</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-title-shadow-blur" class="rop-range rop-defaultable" data-default="0" min="0" max="30" value="0"><input type="number" class="rop-num-readout" data-link="rop-title-shadow-blur" min="0" max="30" value="0"><button class="rop-reset-btn" data-target="rop-title-shadow-blur" title="恢复默认">↺</button></div>
                        <label>阴影偏移X</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-title-shadow-x" class="rop-range rop-defaultable" data-default="2" min="-20" max="20" value="2"><input type="number" class="rop-num-readout" data-link="rop-title-shadow-x" min="-20" max="20" value="2"><button class="rop-reset-btn" data-target="rop-title-shadow-x" title="恢复默认">↺</button></div>
                        <label>阴影偏移Y</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-title-shadow-y" class="rop-range rop-defaultable" data-default="2" min="-20" max="20" value="2"><input type="number" class="rop-num-readout" data-link="rop-title-shadow-y" min="-20" max="20" value="2"><button class="rop-reset-btn" data-target="rop-title-shadow-y" title="恢复默认">↺</button></div>
                        <label>开启背景</label><input type="checkbox" id="rop-title-bg-enabled" class="rop-defaultable" data-default="false">
                        <label>背景模式</label>
                        <select id="rop-title-bg-mode" class="rop-select rop-defaultable" data-default="block">
                            <option value="block">整块</option><option value="inline">每行独立包裹</option><option value="inline-joined">连体包裹</option>
                        </select>
                        <label title="用一张图片作为文字背景（自动拉伸适配文字区域）">图片背景</label><input type="checkbox" id="rop-title-bg-brush" class="rop-defaultable" data-default="false">
                        <label>背景图片</label>
                        <div style="display:flex; gap:6px; align-items:center; flex-wrap:wrap;">
                            <select id="rop-title-bg-brush-style" class="rop-select rop-defaultable" data-default="" style="flex:1; min-width:140px;">
                                <option value="">（未选择图片）</option>
                                <option value="custom">➕ 导入单张图片...</option>
                            </select>
                            <button id="rop-title-brush-gallery-btn" class="rop-btn" type="button" title="带缩略图选择背景图片" style="padding:4px 7px; font-size:11px; white-space:nowrap; cursor:pointer; background:#264b7d; border:1px solid #4d7fbd; border-radius:4px; color:#fff;">🖼 选样式</button>
                            <button id="rop-title-brush-upload-btn" class="rop-btn" type="button" title="选取单张图片导入 (PNG/JPG/WEBP)" style="padding:4px 7px; font-size:11px; white-space:nowrap; cursor:pointer; background:var(--bg-secondary, #333); border:1px solid var(--border-color, #555); border-radius:4px; color:var(--text-color, #fff);">📁 导入单图</button>
                            <button id="rop-title-brush-folder-btn" class="rop-btn" type="button" title="选取包含图片的文件夹批量导入" style="padding:4px 7px; font-size:11px; white-space:nowrap; cursor:pointer; background:var(--bg-secondary, #333); border:1px solid var(--border-color, #555); border-radius:4px; color:var(--text-color, #fff);">📂 导入文件夹</button>
                            <input type="file" id="rop-title-brush-file-input" accept="image/png,image/jpeg,image/webp,image/jpg" style="display:none;">
                            <input type="file" id="rop-title-brush-folder-input" webkitdirectory directory multiple style="display:none;">
                        </div>
                        <label title="默认直接使用原图（不做任何图像处理）；选「染成背景颜色」时才会去底并染成上方背景颜色">颜色处理</label>
                        <select id="rop-title-bg-brush-colormode" class="rop-select rop-defaultable" data-default="original">
                            <option value="original">原图（不处理）</option>
                            <option value="tint">染成背景颜色</option>
                        </select>
                        <label title="变形拉伸：整张图拉伸铺满背景范围（会变形）&#10;保持比例裁切：不变形，铺满背景范围后居中裁掉多余部分&#10;两端保护拉伸：左右端头不变形，只拉长中间（适合笔刷/横幅）">图片适配</label>
                        <select id="rop-title-bg-brush-fit" class="rop-select rop-defaultable" data-default="stretch">
                            <option value="stretch">变形拉伸铺满</option>
                            <option value="cover">保持比例 · 自动裁切</option>
                            <option value="slice3">两端保护拉伸</option>
                        </select>
                        <label title="在背景范围内整体放大/缩小图片（以中心为基准），超出背景范围的部分自动裁掉；100%=刚好适配">图片整体缩放</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-title-bg-brush-zoom" class="rop-range rop-defaultable" data-default="100" min="10" step="1" max="500" value="100"><input type="number" class="rop-num-readout" data-link="rop-title-bg-brush-zoom" min="10" step="1" max="1000" value="100"><button class="rop-reset-btn" data-target="rop-title-bg-brush-zoom" title="恢复默认(100%)">↺</button></div>
                        <label title="相对文字自动适配尺寸的缩放倍数；100%=原始适配尺寸，可超过画布">图片宽度缩放</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-title-bg-brush-scale-x" class="rop-range rop-defaultable" data-default="100" min="1" step="0.1" max="1000" value="100"><input type="number" class="rop-num-readout" data-link="rop-title-bg-brush-scale-x" min="1" step="0.1" max="10000" value="100"><button class="rop-reset-btn" data-target="rop-title-bg-brush-scale-x" title="恢复默认(100%)">↺</button></div>
                        <label title="相对文字自动适配尺寸的缩放倍数；100%=原始适配尺寸，可超过画布">图片高度缩放</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-title-bg-brush-scale-y" class="rop-range rop-defaultable" data-default="100" min="1" step="0.1" max="1000" value="100"><input type="number" class="rop-num-readout" data-link="rop-title-bg-brush-scale-y" min="1" step="0.1" max="10000" value="100"><button class="rop-reset-btn" data-target="rop-title-bg-brush-scale-y" title="恢复默认(100%)">↺</button></div>
                        <label title="仅在「染成背景颜色」时生效：强化图片主体不透明度，中间100%纯实心遮挡背景视频，同时保留边缘柔和羽化半透明（默认100%）">染色实心度</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-title-bg-brush-solid" class="rop-range rop-defaultable" data-default="100" min="0" max="100" value="100"><input type="number" class="rop-num-readout" data-link="rop-title-bg-brush-solid" min="0" max="100" value="100"><button class="rop-reset-btn" data-target="rop-title-bg-brush-solid" title="恢复默认(100%)">↺</button></div>
                        <label title="背景图片横向位置微调偏移量（像素）">图片位置X</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-title-bg-brush-x" class="rop-range rop-defaultable" data-default="0" min="-500" max="500" value="0"><input type="number" class="rop-num-readout" data-link="rop-title-bg-brush-x" min="-500" max="500" value="0"><button class="rop-reset-btn" data-target="rop-title-bg-brush-x" title="恢复默认(0)">↺</button></div>
                        <label title="背景图片纵向位置微调偏移量（像素）">图片位置Y</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-title-bg-brush-y" class="rop-range rop-defaultable" data-default="0" min="-500" max="500" value="0"><input type="number" class="rop-num-readout" data-link="rop-title-bg-brush-y" min="-500" max="500" value="0"><button class="rop-reset-btn" data-target="rop-title-bg-brush-y" title="恢复默认(0)">↺</button></div>
                        <label title="为普通文字背景添加独立边框">背景描边</label><input type="checkbox" id="rop-title-bg-border-enabled" class="rop-defaultable" data-default="false">
                        <label>描边颜色</label><input type="color" id="rop-title-bg-border-color" class="rop-color rop-defaultable" data-default="#ffffff" value="#ffffff">
                        <label>描边宽度</label><input type="number" id="rop-title-bg-border-width" class="rop-input rop-defaultable" data-default="3" min="0" max="100" step="1" value="3">
                        <label>描边样式</label><select id="rop-title-bg-border-style" class="rop-select rop-defaultable" data-default="solid"><option value="solid">实线</option><option value="dashed">虚线</option><option value="dotted">点线</option></select>
                        <label>描边不透明度</label><input type="number" id="rop-title-bg-border-opacity" class="rop-input rop-defaultable" data-default="100" min="0" max="100" value="100">
                        <label>背景颜色</label><input type="color" id="rop-title-bg-color" class="rop-color rop-defaultable" data-default="#000000" value="#000000">
                        <label>背景透明</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-title-bg-opacity" class="rop-range rop-defaultable" data-default="60" min="0" max="100" value="60"><input type="number" class="rop-num-readout" data-link="rop-title-bg-opacity" min="0" max="100" value="60"><button class="rop-reset-btn" data-target="rop-title-bg-opacity" title="恢复默认">↺</button></div>
                        <label>背景圆角</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-title-bg-radius" class="rop-range rop-defaultable" data-default="12" min="0" max="100" value="12"><input type="number" class="rop-num-readout" data-link="rop-title-bg-radius" min="0" max="100" value="12"><button class="rop-reset-btn" data-target="rop-title-bg-radius" title="恢复默认">↺</button></div>
                        <label>背景水平内边距</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-title-bg-pad-h" class="rop-range rop-defaultable" data-default="0" min="0" max="100" value="0"><input type="number" class="rop-num-readout" data-link="rop-title-bg-pad-h" min="0" max="200" value="0"><button class="rop-reset-btn" data-target="rop-title-bg-pad-h" title="恢复默认(自动)">↺</button></div>
                        <label>背景上边距</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-title-bg-pad-top" class="rop-range rop-defaultable" data-default="0" min="0" max="100" value="0"><input type="number" class="rop-num-readout" data-link="rop-title-bg-pad-top" min="0" max="200" value="0"><button class="rop-reset-btn" data-target="rop-title-bg-pad-top" title="恢复默认(自动)">↺</button></div>
                        <label>背景下边距</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-title-bg-pad-bottom" class="rop-range rop-defaultable" data-default="0" min="0" max="100" value="0"><input type="number" class="rop-num-readout" data-link="rop-title-bg-pad-bottom" min="0" max="200" value="0"><button class="rop-reset-btn" data-target="rop-title-bg-pad-bottom" title="恢复默认(自动)">↺</button></div>
                    </div>
                    
                    <div style="font-size:11px; color:var(--accent); margin-top:8px; margin-bottom:2px; border-bottom: 1px solid var(--border-color); padding-bottom: 4px;">标题装饰线</div>
                    <div class="rop-grid">
                        <label>开启装饰线</label><input type="checkbox" id="rop-title-deco-enabled" class="rop-defaultable" data-default="false">
                        <label>线段位置</label>
                        <select id="rop-title-deco-position" class="rop-select rop-defaultable" data-default="bottom">
                            <option value="top">上方</option><option value="bottom">下方</option><option value="left">左侧</option><option value="right">右侧</option>
                        </select>
                        <label>样式</label>
                        <div style="display:flex;gap:4px;align-items:center;min-width:0;"><select id="rop-title-deco-style" class="rop-select rop-defaultable" data-default="solid" style="flex:1;min-width:0;">
                            <option value="solid">实线</option><option value="dashed">虚线</option><option value="dotted">点线</option><option value="double">双线</option><option value="gradient">渐变线</option>
                        </select><button type="button" id="rop-title-deco-gallery" class="rop-btn" title="打开可视化装饰线色板 (划过实时预览 · 138款爆款/几何/花体样式)" style="padding:2px 6px;font-size:11px;height:24px;white-space:nowrap;background:linear-gradient(135deg, #2b3144, #1f2433);border:1px solid #4a5568;border-radius:4px;color:#c7d2fe;display:inline-flex;align-items:center;gap:2px;cursor:pointer;">👁 色板</button><button type="button" id="rop-title-deco-export" class="rop-btn" title="导出我的装饰线预设" style="padding:2px 5px;font-size:11px;height:24px;">📤</button></div>
                        <label>对齐</label>
                        <select id="rop-title-deco-align" class="rop-select rop-defaultable" data-default="center">
                            <option value="left">左对齐</option><option value="center">居中</option><option value="right">右对齐</option>
                        </select>
                        <label>线条颜色</label><input type="color" id="rop-title-deco-color" class="rop-color rop-defaultable" data-default="#FFD700" value="#FFD700">
                        <label title="仅渐变样式生效">次颜色(渐变)</label><input type="color" id="rop-title-deco-color2" class="rop-color rop-defaultable" data-default="#FF6B35" value="#FF6B35">
                        <label>粗细</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-title-deco-thickness" class="rop-range rop-defaultable" data-default="3" min="1" max="20" value="3"><input type="number" class="rop-num-readout" data-link="rop-title-deco-thickness" min="1" max="20" value="3"><button class="rop-reset-btn" data-target="rop-title-deco-thickness" title="恢复默认">↺</button></div>
                        <label title="0表示自动绑定文字本身的宽度/高度">长度(0=自动)</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-title-deco-length" class="rop-range rop-defaultable" data-default="0" min="0" max="1000" value="0"><input type="number" class="rop-num-readout" data-link="rop-title-deco-length" min="0" max="1000" value="0"><button class="rop-reset-btn" data-target="rop-title-deco-length" title="0=自动包裹文字">↺</button></div>
                        <label>距离</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-title-deco-gap" class="rop-range rop-defaultable" data-default="12" min="-50" max="100" value="12"><input type="number" class="rop-num-readout" data-link="rop-title-deco-gap" min="-50" max="100" value="12"><button class="rop-reset-btn" data-target="rop-title-deco-gap" title="恢复默认">↺</button></div>
                        <label>透明度%</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-title-deco-opacity" class="rop-range rop-defaultable" data-default="100" min="0" max="100" value="100"><input type="number" class="rop-num-readout" data-link="rop-title-deco-opacity" min="0" max="100" value="100"><button class="rop-reset-btn" data-target="rop-title-deco-opacity" title="恢复默认">↺</button></div>
                        <label title="矢量装饰花纹整体缩放比例">花纹大小</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-title-deco-scale" class="rop-range rop-defaultable" data-default="1" min="0.2" max="3" step="0.05" value="1"><input type="number" class="rop-num-readout" data-link="rop-title-deco-scale" min="0.2" max="3" step="0.05" value="1"><button class="rop-reset-btn" data-target="rop-title-deco-scale" title="恢复默认(1.0)">↺</button></div>
                        <label title="中心花纹与左右两侧线段的避让留白距离">中心间距</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-title-deco-center-gap" class="rop-range rop-defaultable" data-default="18" min="0" max="80" step="1" value="18"><input type="number" class="rop-num-readout" data-link="rop-title-deco-center-gap" min="0" max="80" step="1" value="18"><button class="rop-reset-btn" data-target="rop-title-deco-center-gap" title="恢复默认(18)">↺</button></div>
                        <label>端点样式</label>
                        <select id="rop-title-deco-linecap" class="rop-select rop-defaultable" data-default="round">
                            <option value="round">圆角 (Round)</option>
                            <option value="butt">平头 (Butt)</option>
                            <option value="square">方形 (Square)</option>
                        </select>
                        <label>左右镜像</label>
                        <div style="display:flex;align-items:center;gap:6px;">
                            <input type="checkbox" id="rop-title-deco-flip" class="rop-defaultable" data-default="false">
                            <span style="font-size:11px;color:var(--text-muted);">水平翻转花纹</span>
                        </div>
                    </div>
                    <div class="rop-group-title" style="margin-top:8px; display:flex; justify-content:space-between; align-items:center;">
                        <span>正文</span>
                        <label style="font-size:11px; font-weight:normal; display:flex; align-items:center; gap:4px; margin-right:8px; cursor:pointer; color:var(--accent);">
                            <input type="checkbox" id="rop-body-follow-title" class="rop-defaultable" data-default="false" style="margin:0;">
                            样式跟随标题
                        </label>
                    </div>
                    <div style="display:flex;gap:6px;align-items:flex-start;">
                        <textarea id="rop-body-text" class="rop-textarea" rows="4" placeholder="正文文字" style="flex:1;"></textarea>
                        <button class="rop-richtext-btn" data-section="body" title="逐字样式编辑" style="padding:4px 8px;border:1px solid var(--border-color,#555);background:var(--bg-secondary,#2a2a3e);color:var(--accent-primary,#7b8bef);border-radius:6px;cursor:pointer;font-size:12px;white-space:nowrap;">✎ 富文本</button>
                    </div>
                    <div class="rop-grid">
                        <label>字体</label>
                        <select id="rop-body-font" class="rop-select rop-defaultable" data-default="Arial">
                        </select>
                        <label>字号</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-body-fontsize" class="rop-range rop-defaultable" data-default="40" min="8" max="200" value="40"><input type="number" class="rop-num-readout" data-link="rop-body-fontsize" min="8" max="200" value="40"><button class="rop-reset-btn" data-target="rop-body-fontsize" title="恢复默认">↺</button></div>
                        <label>颜色</label><input type="color" id="rop-body-color" class="rop-color rop-defaultable" data-default="#000000" value="#000000">
                        <label>粗体</label><input type="checkbox" id="rop-body-bold" class="rop-defaultable" data-default="false">
                        <label>字重</label>
                        <select id="rop-body-weight" class="rop-select rop-defaultable" data-default="400">
                            <option value="100">Thin</option><option value="200">ExtraLight</option><option value="300">Light</option>
                            <option value="400" selected>Regular</option><option value="500">Medium</option><option value="600">SemiBold</option>
                            <option value="700">Bold</option><option value="800">ExtraBold</option><option value="900">Black</option>
                        </select>
                        <label>字符间距</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-body-letterspacing" class="rop-range rop-defaultable" data-default="0" min="-20" max="100" value="0"><input type="number" class="rop-num-readout" data-link="rop-body-letterspacing" min="-20" max="100" value="0"><button class="rop-reset-btn" data-target="rop-body-letterspacing" title="恢复默认(0)">↺</button></div>
                        <label>文字宽度</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-body-override-w" class="rop-range rop-defaultable" data-default="830" min="1" max="1080" value="830"><input type="number" class="rop-num-readout" data-link="rop-body-override-w" min="1" max="1080" value="830"><button class="rop-reset-btn" data-target="rop-body-override-w" title="恢复当前内容宽度">↺</button></div>
                        <label>独立边界高</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-body-override-h" class="rop-range rop-defaultable" data-default="0" min="0" max="1920" value="0"><input type="number" class="rop-num-readout" data-link="rop-body-override-h" min="0" max="1920" value="0"><button class="rop-reset-btn" data-target="rop-body-override-h" title="0=无限制">↺</button></div>
                        <label>独立自动缩放</label><input type="checkbox" id="rop-body-auto-shrink" class="rop-defaultable" data-default="false">
                        <label>行距</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-body-linespacing" class="rop-range rop-defaultable" data-default="6" min="-50" max="100" value="6"><input type="number" class="rop-num-readout" data-link="rop-body-linespacing" min="-50" max="100" value="6"><button class="rop-reset-btn" data-target="rop-body-linespacing" title="恢复默认(6)">↺</button></div>
                        <label>对齐</label>
                        <select id="rop-body-align" class="rop-select rop-defaultable" data-default="center">
                            <option value="center">水平居中</option><option value="left">左对齐</option><option value="right">右对齐</option>
                        </select>
                        <label>垂直对齐</label>
                        <select id="rop-body-valign" class="rop-select rop-defaultable" data-default="top">
                            <option value="center">垂直居中</option><option value="top">顶部对齐</option><option value="bottom">底部对齐</option>
                        </select>
                        <label class="rop-offset-label">位置X</label>
                        <div class="rop-slider-combo rop-offset-input"><input type="range" id="rop-body-offset-x" class="rop-range rop-defaultable" data-default="0" min="-1080" max="1080" value="0"><input type="number" class="rop-num-readout" data-link="rop-body-offset-x" min="-1080" max="1080" value="0"><button class="rop-reset-btn" data-target="rop-body-offset-x" title="恢复默认(0)">↺</button></div>
                        <label class="rop-offset-label">位置Y</label>
                        <div class="rop-slider-combo rop-offset-input"><input type="range" id="rop-body-offset-y" class="rop-range rop-defaultable" data-default="0" min="-1920" max="1920" value="0"><input type="number" class="rop-num-readout" data-link="rop-body-offset-y" min="-1920" max="1920" value="0"><button class="rop-reset-btn" data-target="rop-body-offset-y" title="恢复默认(0)">↺</button></div>
                        <div style="grid-column: span 2; font-size:11px; color:var(--accent); margin-top:6px; margin-bottom:2px; border-bottom: 1px solid var(--border-color); padding-bottom: 4px;">独立特效 & 背景</div>
                        <label>描边颜色</label><input type="color" id="rop-body-stroke-color" class="rop-color rop-defaultable" data-default="#000000" value="#000000">
                        <label>描边宽度</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-body-stroke-width" class="rop-range rop-defaultable" data-default="0" min="0" max="20" value="0"><input type="number" class="rop-num-readout" data-link="rop-body-stroke-width" min="0" max="20" value="0"><button class="rop-reset-btn" data-target="rop-body-stroke-width" title="恢复默认">↺</button></div>
                        <label>阴影颜色</label><input type="color" id="rop-body-shadow-color" class="rop-color rop-defaultable" data-default="#000000" value="#000000">
                        <label>阴影模糊</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-body-shadow-blur" class="rop-range rop-defaultable" data-default="0" min="0" max="30" value="0"><input type="number" class="rop-num-readout" data-link="rop-body-shadow-blur" min="0" max="30" value="0"><button class="rop-reset-btn" data-target="rop-body-shadow-blur" title="恢复默认">↺</button></div>
                        <label>阴影偏移X</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-body-shadow-x" class="rop-range rop-defaultable" data-default="2" min="-20" max="20" value="2"><input type="number" class="rop-num-readout" data-link="rop-body-shadow-x" min="-20" max="20" value="2"><button class="rop-reset-btn" data-target="rop-body-shadow-x" title="恢复默认">↺</button></div>
                        <label>阴影偏移Y</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-body-shadow-y" class="rop-range rop-defaultable" data-default="2" min="-20" max="20" value="2"><input type="number" class="rop-num-readout" data-link="rop-body-shadow-y" min="-20" max="20" value="2"><button class="rop-reset-btn" data-target="rop-body-shadow-y" title="恢复默认">↺</button></div>
                        <label>开启背景</label><input type="checkbox" id="rop-body-bg-enabled" class="rop-defaultable" data-default="false">
                        <label>背景模式</label>
                        <select id="rop-body-bg-mode" class="rop-select rop-defaultable" data-default="block">
                            <option value="block">整块</option><option value="inline">每行独立包裹</option><option value="inline-joined">连体包裹</option>
                        </select>
                        <label title="用一张图片作为文字背景（自动拉伸适配文字区域）">图片背景</label><input type="checkbox" id="rop-body-bg-brush" class="rop-defaultable" data-default="false">
                        <label>背景图片</label>
                        <div style="display:flex; gap:6px; align-items:center; flex-wrap:wrap;">
                            <select id="rop-body-bg-brush-style" class="rop-select rop-defaultable" data-default="" style="flex:1; min-width:140px;">
                                <option value="">（未选择图片）</option>
                                <option value="custom">➕ 导入单张图片...</option>
                            </select>
                            <button id="rop-body-brush-gallery-btn" class="rop-btn" type="button" title="带缩略图选择背景图片" style="padding:4px 7px; font-size:11px; white-space:nowrap; cursor:pointer; background:#264b7d; border:1px solid #4d7fbd; border-radius:4px; color:#fff;">🖼 选样式</button>
                            <button id="rop-body-brush-upload-btn" class="rop-btn" type="button" title="选取单张图片导入 (PNG/JPG/WEBP)" style="padding:4px 7px; font-size:11px; white-space:nowrap; cursor:pointer; background:var(--bg-secondary, #333); border:1px solid var(--border-color, #555); border-radius:4px; color:var(--text-color, #fff);">📁 导入单图</button>
                            <button id="rop-body-brush-folder-btn" class="rop-btn" type="button" title="选取包含图片的文件夹批量导入" style="padding:4px 7px; font-size:11px; white-space:nowrap; cursor:pointer; background:var(--bg-secondary, #333); border:1px solid var(--border-color, #555); border-radius:4px; color:var(--text-color, #fff);">📂 导入文件夹</button>
                            <input type="file" id="rop-body-brush-file-input" accept="image/png,image/jpeg,image/webp,image/jpg" style="display:none;">
                            <input type="file" id="rop-body-brush-folder-input" webkitdirectory directory multiple style="display:none;">
                        </div>
                        <label title="默认直接使用原图（不做任何图像处理）；选「染成背景颜色」时才会去底并染成上方背景颜色">颜色处理</label>
                        <select id="rop-body-bg-brush-colormode" class="rop-select rop-defaultable" data-default="original">
                            <option value="original">原图（不处理）</option>
                            <option value="tint">染成背景颜色</option>
                        </select>
                        <label title="变形拉伸：整张图拉伸铺满背景范围（会变形）&#10;保持比例裁切：不变形，铺满背景范围后居中裁掉多余部分&#10;两端保护拉伸：左右端头不变形，只拉长中间（适合笔刷/横幅）">图片适配</label>
                        <select id="rop-body-bg-brush-fit" class="rop-select rop-defaultable" data-default="stretch">
                            <option value="stretch">变形拉伸铺满</option>
                            <option value="cover">保持比例 · 自动裁切</option>
                            <option value="slice3">两端保护拉伸</option>
                        </select>
                        <label title="在背景范围内整体放大/缩小图片（以中心为基准），超出背景范围的部分自动裁掉；100%=刚好适配">图片整体缩放</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-body-bg-brush-zoom" class="rop-range rop-defaultable" data-default="100" min="10" step="1" max="500" value="100"><input type="number" class="rop-num-readout" data-link="rop-body-bg-brush-zoom" min="10" step="1" max="1000" value="100"><button class="rop-reset-btn" data-target="rop-body-bg-brush-zoom" title="恢复默认(100%)">↺</button></div>
                        <label title="相对文字自动适配尺寸的缩放倍数；100%=原始适配尺寸，可超过画布">图片宽度缩放</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-body-bg-brush-scale-x" class="rop-range rop-defaultable" data-default="100" min="1" step="0.1" max="1000" value="100"><input type="number" class="rop-num-readout" data-link="rop-body-bg-brush-scale-x" min="1" step="0.1" max="10000" value="100"><button class="rop-reset-btn" data-target="rop-body-bg-brush-scale-x" title="恢复默认(100%)">↺</button></div>
                        <label title="相对文字自动适配尺寸的缩放倍数；100%=原始适配尺寸，可超过画布">图片高度缩放</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-body-bg-brush-scale-y" class="rop-range rop-defaultable" data-default="100" min="1" step="0.1" max="1000" value="100"><input type="number" class="rop-num-readout" data-link="rop-body-bg-brush-scale-y" min="1" step="0.1" max="10000" value="100"><button class="rop-reset-btn" data-target="rop-body-bg-brush-scale-y" title="恢复默认(100%)">↺</button></div>
                        <label title="仅在「染成背景颜色」时生效：强化图片主体不透明度，中间100%纯实心遮挡背景视频，同时保留边缘柔和羽化半透明（默认100%）">染色实心度</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-body-bg-brush-solid" class="rop-range rop-defaultable" data-default="100" min="0" max="100" value="100"><input type="number" class="rop-num-readout" data-link="rop-body-bg-brush-solid" min="0" max="100" value="100"><button class="rop-reset-btn" data-target="rop-body-bg-brush-solid" title="恢复默认(100%)">↺</button></div>
                        <label title="背景图片横向位置微调偏移量（像素）">图片位置X</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-body-bg-brush-x" class="rop-range rop-defaultable" data-default="0" min="-500" max="500" value="0"><input type="number" class="rop-num-readout" data-link="rop-body-bg-brush-x" min="-500" max="500" value="0"><button class="rop-reset-btn" data-target="rop-body-bg-brush-x" title="恢复默认(0)">↺</button></div>
                        <label title="背景图片纵向位置微调偏移量（像素）">图片位置Y</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-body-bg-brush-y" class="rop-range rop-defaultable" data-default="0" min="-500" max="500" value="0"><input type="number" class="rop-num-readout" data-link="rop-body-bg-brush-y" min="-500" max="500" value="0"><button class="rop-reset-btn" data-target="rop-body-bg-brush-y" title="恢复默认(0)">↺</button></div>
                        <label title="为普通文字背景添加独立边框">背景描边</label><input type="checkbox" id="rop-body-bg-border-enabled" class="rop-defaultable" data-default="false">
                        <label>描边颜色</label><input type="color" id="rop-body-bg-border-color" class="rop-color rop-defaultable" data-default="#ffffff" value="#ffffff">
                        <label>描边宽度</label><input type="number" id="rop-body-bg-border-width" class="rop-input rop-defaultable" data-default="3" min="0" max="100" step="1" value="3">
                        <label>描边样式</label><select id="rop-body-bg-border-style" class="rop-select rop-defaultable" data-default="solid"><option value="solid">实线</option><option value="dashed">虚线</option><option value="dotted">点线</option></select>
                        <label>描边不透明度</label><input type="number" id="rop-body-bg-border-opacity" class="rop-input rop-defaultable" data-default="100" min="0" max="100" value="100">
                        <label>背景颜色</label><input type="color" id="rop-body-bg-color" class="rop-color rop-defaultable" data-default="#000000" value="#000000">
                        <label>背景透明</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-body-bg-opacity" class="rop-range rop-defaultable" data-default="60" min="0" max="100" value="60"><input type="number" class="rop-num-readout" data-link="rop-body-bg-opacity" min="0" max="100" value="60"><button class="rop-reset-btn" data-target="rop-body-bg-opacity" title="恢复默认">↺</button></div>
                        <label>背景圆角</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-body-bg-radius" class="rop-range rop-defaultable" data-default="12" min="0" max="100" value="12"><input type="number" class="rop-num-readout" data-link="rop-body-bg-radius" min="0" max="100" value="12"><button class="rop-reset-btn" data-target="rop-body-bg-radius" title="恢复默认">↺</button></div>
                        <label>背景水平内边距</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-body-bg-pad-h" class="rop-range rop-defaultable" data-default="0" min="0" max="100" value="0"><input type="number" class="rop-num-readout" data-link="rop-body-bg-pad-h" min="0" max="200" value="0"><button class="rop-reset-btn" data-target="rop-body-bg-pad-h" title="恢复默认(自动)">↺</button></div>
                        <label>背景上边距</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-body-bg-pad-top" class="rop-range rop-defaultable" data-default="0" min="0" max="100" value="0"><input type="number" class="rop-num-readout" data-link="rop-body-bg-pad-top" min="0" max="200" value="0"><button class="rop-reset-btn" data-target="rop-body-bg-pad-top" title="恢复默认(自动)">↺</button></div>
                        <label>背景下边距</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-body-bg-pad-bottom" class="rop-range rop-defaultable" data-default="0" min="0" max="100" value="0"><input type="number" class="rop-num-readout" data-link="rop-body-bg-pad-bottom" min="0" max="200" value="0"><button class="rop-reset-btn" data-target="rop-body-bg-pad-bottom" title="恢复默认(自动)">↺</button></div>
                    </div>
                    <div class="rop-group-title" style="margin-top:8px;">结尾</div>
                    <div style="display:flex;gap:6px;align-items:flex-start;">
                        <textarea id="rop-footer-text" class="rop-textarea" rows="2" placeholder="结尾文字（可选）" style="flex:1;"></textarea>
                        <button class="rop-richtext-btn" data-section="footer" title="逐字样式编辑" style="padding:4px 8px;border:1px solid var(--border-color,#555);background:var(--bg-secondary,#2a2a3e);color:var(--accent-primary,#7b8bef);border-radius:6px;cursor:pointer;font-size:12px;white-space:nowrap;">✎ 富文本</button>
                    </div>
                    <div class="rop-grid">
                        <label>字体</label>
                        <select id="rop-footer-font" class="rop-select rop-defaultable" data-default="Arial">
                        </select>
                        <label>字号</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-footer-fontsize" class="rop-range rop-defaultable" data-default="32" min="8" max="200" value="32"><input type="number" class="rop-num-readout" data-link="rop-footer-fontsize" min="8" max="200" value="32"><button class="rop-reset-btn" data-target="rop-footer-fontsize" title="恢复默认">↺</button></div>
                        <label>颜色</label><input type="color" id="rop-footer-color" class="rop-color rop-defaultable" data-default="#666666" value="#666666">
                        <label>粗体</label><input type="checkbox" id="rop-footer-bold" class="rop-defaultable" data-default="false">
                        <label>字重</label>
                        <select id="rop-footer-weight" class="rop-select rop-defaultable" data-default="400">
                            <option value="100">Thin</option><option value="200">ExtraLight</option><option value="300">Light</option>
                            <option value="400" selected>Regular</option><option value="500">Medium</option><option value="600">SemiBold</option>
                            <option value="700">Bold</option><option value="800">ExtraBold</option><option value="900">Black</option>
                        </select>
                        <label>对齐</label>
                        <select id="rop-footer-align" class="rop-select rop-defaultable" data-default="center">
                            <option value="center">水平居中</option><option value="left">左对齐</option><option value="right">右对齐</option>
                        </select>
                        <label>垂直对齐</label>
                        <select id="rop-footer-valign" class="rop-select rop-defaultable" data-default="top">
                            <option value="center">垂直居中</option><option value="top">顶部对齐</option><option value="bottom">底部对齐</option>
                        </select>
                        <label>字符间距</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-footer-letterspacing" class="rop-range rop-defaultable" data-default="0" min="-20" max="100" value="0"><input type="number" class="rop-num-readout" data-link="rop-footer-letterspacing" min="-20" max="100" value="0"><button class="rop-reset-btn" data-target="rop-footer-letterspacing" title="恢复默认(0)">↺</button></div>
                        <label>文字宽度</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-footer-override-w" class="rop-range rop-defaultable" data-default="830" min="1" max="1080" value="830"><input type="number" class="rop-num-readout" data-link="rop-footer-override-w" min="1" max="1080" value="830"><button class="rop-reset-btn" data-target="rop-footer-override-w" title="恢复当前内容宽度">↺</button></div>
                        <label>独立边界高</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-footer-override-h" class="rop-range rop-defaultable" data-default="0" min="0" max="1920" value="0"><input type="number" class="rop-num-readout" data-link="rop-footer-override-h" min="0" max="1920" value="0"><button class="rop-reset-btn" data-target="rop-footer-override-h" title="0=无限制">↺</button></div>
                        <label>独立自动缩放</label><input type="checkbox" id="rop-footer-auto-shrink" class="rop-defaultable" data-default="false">
                        <label>行距</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-footer-linespacing" class="rop-range rop-defaultable" data-default="0" min="-50" max="100" value="0"><input type="number" class="rop-num-readout" data-link="rop-footer-linespacing" min="-50" max="100" value="0"><button class="rop-reset-btn" data-target="rop-footer-linespacing" title="恢复默认(0)">↺</button></div>
                        <label class="rop-offset-label">位置X</label>
                        <div class="rop-slider-combo rop-offset-input"><input type="range" id="rop-footer-offset-x" class="rop-range rop-defaultable" data-default="0" min="-1080" max="1080" value="0"><input type="number" class="rop-num-readout" data-link="rop-footer-offset-x" min="-1080" max="1080" value="0"><button class="rop-reset-btn" data-target="rop-footer-offset-x" title="恢复默认(0)">↺</button></div>
                        <label class="rop-offset-label">位置Y</label>
                        <div class="rop-slider-combo rop-offset-input"><input type="range" id="rop-footer-offset-y" class="rop-range rop-defaultable" data-default="0" min="-1920" max="1920" value="0"><input type="number" class="rop-num-readout" data-link="rop-footer-offset-y" min="-1920" max="1920" value="0"><button class="rop-reset-btn" data-target="rop-footer-offset-y" title="恢复默认(0)">↺</button></div>
                        <div style="grid-column: span 2; font-size:11px; color:var(--accent); margin-top:6px; margin-bottom:2px; border-bottom: 1px solid var(--border-color); padding-bottom: 4px;">独立特效 & 背景</div>
                        <label>描边颜色</label><input type="color" id="rop-footer-stroke-color" class="rop-color rop-defaultable" data-default="#000000" value="#000000">
                        <label>描边宽度</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-footer-stroke-width" class="rop-range rop-defaultable" data-default="0" min="0" max="20" value="0"><input type="number" class="rop-num-readout" data-link="rop-footer-stroke-width" min="0" max="20" value="0"><button class="rop-reset-btn" data-target="rop-footer-stroke-width" title="恢复默认">↺</button></div>
                        <label>阴影颜色</label><input type="color" id="rop-footer-shadow-color" class="rop-color rop-defaultable" data-default="#000000" value="#000000">
                        <label>阴影模糊</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-footer-shadow-blur" class="rop-range rop-defaultable" data-default="0" min="0" max="30" value="0"><input type="number" class="rop-num-readout" data-link="rop-footer-shadow-blur" min="0" max="30" value="0"><button class="rop-reset-btn" data-target="rop-footer-shadow-blur" title="恢复默认">↺</button></div>
                        <label>阴影偏移X</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-footer-shadow-x" class="rop-range rop-defaultable" data-default="2" min="-20" max="20" value="2"><input type="number" class="rop-num-readout" data-link="rop-footer-shadow-x" min="-20" max="20" value="2"><button class="rop-reset-btn" data-target="rop-footer-shadow-x" title="恢复默认">↺</button></div>
                        <label>阴影偏移Y</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-footer-shadow-y" class="rop-range rop-defaultable" data-default="2" min="-20" max="20" value="2"><input type="number" class="rop-num-readout" data-link="rop-footer-shadow-y" min="-20" max="20" value="2"><button class="rop-reset-btn" data-target="rop-footer-shadow-y" title="恢复默认">↺</button></div>
                        <label>开启背景</label><input type="checkbox" id="rop-footer-bg-enabled" class="rop-defaultable" data-default="false">
                        <label>背景模式</label>
                        <select id="rop-footer-bg-mode" class="rop-select rop-defaultable" data-default="block">
                            <option value="block">整块</option><option value="inline">每行独立包裹</option><option value="inline-joined">连体包裹</option>
                        </select>
                        <label title="为普通文字背景添加独立边框">背景描边</label><input type="checkbox" id="rop-footer-bg-border-enabled" class="rop-defaultable" data-default="false">
                        <label>描边颜色</label><input type="color" id="rop-footer-bg-border-color" class="rop-color rop-defaultable" data-default="#ffffff" value="#ffffff">
                        <label>描边宽度</label><input type="number" id="rop-footer-bg-border-width" class="rop-input rop-defaultable" data-default="3" min="0" max="100" step="1" value="3">
                        <label>描边样式</label><select id="rop-footer-bg-border-style" class="rop-select rop-defaultable" data-default="solid"><option value="solid">实线</option><option value="dashed">虚线</option><option value="dotted">点线</option></select>
                        <label>描边不透明度</label><input type="number" id="rop-footer-bg-border-opacity" class="rop-input rop-defaultable" data-default="100" min="0" max="100" value="100">
                        <label>背景颜色</label><input type="color" id="rop-footer-bg-color" class="rop-color rop-defaultable" data-default="#000000" value="#000000">
                        <label>背景透明</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-footer-bg-opacity" class="rop-range rop-defaultable" data-default="60" min="0" max="100" value="60"><input type="number" class="rop-num-readout" data-link="rop-footer-bg-opacity" min="0" max="100" value="60"><button class="rop-reset-btn" data-target="rop-footer-bg-opacity" title="恢复默认">↺</button></div>
                        <label>背景圆角</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-footer-bg-radius" class="rop-range rop-defaultable" data-default="12" min="0" max="100" value="12"><input type="number" class="rop-num-readout" data-link="rop-footer-bg-radius" min="0" max="100" value="12"><button class="rop-reset-btn" data-target="rop-footer-bg-radius" title="恢复默认">↺</button></div>
                        <label>背景水平内边距</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-footer-bg-pad-h" class="rop-range rop-defaultable" data-default="0" min="0" max="100" value="0"><input type="number" class="rop-num-readout" data-link="rop-footer-bg-pad-h" min="0" max="200" value="0"><button class="rop-reset-btn" data-target="rop-footer-bg-pad-h" title="恢复默认(自动)">↺</button></div>
                        <label>背景上边距</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-footer-bg-pad-top" class="rop-range rop-defaultable" data-default="0" min="0" max="100" value="0"><input type="number" class="rop-num-readout" data-link="rop-footer-bg-pad-top" min="0" max="200" value="0"><button class="rop-reset-btn" data-target="rop-footer-bg-pad-top" title="恢复默认(自动)">↺</button></div>
                        <label>背景下边距</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-footer-bg-pad-bottom" class="rop-range rop-defaultable" data-default="0" min="0" max="100" value="0"><input type="number" class="rop-num-readout" data-link="rop-footer-bg-pad-bottom" min="0" max="200" value="0"><button class="rop-reset-btn" data-target="rop-footer-bg-pad-bottom" title="恢复默认(自动)">↺</button></div>
                    </div>
                </div>

                <!-- 动画 -->
                <div class="rop-group" id="rop-animation-props">
                    <div class="rop-group-title">动画</div>
                    <div class="rop-grid">
                        <label>入场</label>
                        <select id="rop-anim-in" class="rop-select">
                            <option value="none">无</option><option value="fade">淡入</option>
                            <option value="pop">弹出</option><option value="slide_up">上滑</option>
                            <option value="slide_down">下滑</option><option value="slide_left">左滑</option>
                            <option value="slide_right">右滑</option>
                        </select>
                        <label>出场</label>
                        <select id="rop-anim-out" class="rop-select">
                            <option value="none">无</option><option value="fade">淡出</option>
                            <option value="pop">弹出</option><option value="slide_up">上滑</option>
                            <option value="slide_down">下滑</option>
                        </select>
                        <label>入场时长</label><input type="number" id="rop-anim-in-dur" class="rop-input" min="0" max="5" step="0.05" value="0.3">
                        <label>出场时长</label><input type="number" id="rop-anim-out-dur" class="rop-input" min="0" max="5" step="0.05" value="0.3">
                    </div>
                </div>

                <!-- 自动着色 -->
                <div class="rop-group" id="rop-autocolor-props">
                    <div class="rop-group-title">🎨 自动着色</div>
                    <div style="padding:4px 0;">
                        <div id="rop-autocolor-rules" style="display:flex;flex-direction:column;gap:6px;margin-bottom:8px;"></div>
                        <div style="display:flex;gap:4px;flex-wrap:wrap;">
                            <button id="rop-autocolor-add" class="btn btn-secondary" style="font-size:11px;padding:3px 8px;">+ 添加关键词规则</button>
                            <button id="rop-autocolor-clear" class="btn btn-secondary" style="font-size:11px;padding:3px 8px;opacity:0.7;">清空全部</button>
                        </div>
                        <div style="margin-top:6px;font-size:10px;color:var(--text-secondary,#888);">
                            快捷预设:
                            <span class="rop-autocolor-preset" data-preset="gold_numbers" style="cursor:pointer;color:var(--accent-primary,#7b8bef);margin-left:4px;" title="数字→金色加粗">🌟金色数字</span>
                            <span class="rop-autocolor-preset" data-preset="brand" style="cursor:pointer;color:var(--accent-primary,#7b8bef);margin-left:4px;" title="英文→青色, 数字→金色">🎯品牌高亮</span>
                            <span class="rop-autocolor-preset" data-preset="red_emphasis" style="cursor:pointer;color:var(--accent-primary,#7b8bef);margin-left:4px;" title="数字+标点→红色加粗">🔥红色重点</span>
                        </div>
                    </div>
                </div>

                <!-- 操作 -->
                <div class="rop-actions">
                    <button class="btn btn-secondary rop-btn-full" id="rop-duplicate">📋 复制覆层</button>
                    <button class="btn btn-secondary rop-btn-full" id="rop-copy-to-tasks" title="将当前覆层复制到一个或多个其他任务">📤 粘贴到任务…</button>
                    <button class="btn btn-secondary rop-btn-full rop-btn-danger" id="rop-delete">🗑️ 删除覆层</button>
                </div>
            </div>
        </div>
        `;

        // 静态模板只保留内置基础线；扩展样式从“我的预设”读取，不会混入内置预设。
        this.container.querySelectorAll('#rop-title-deco-style optgroup, #rop-scroll-title-deco-style optgroup').forEach((group) => group.remove());
        this._refreshPersonalDecorationOptions();

        this._setupCollapsibleGroups();
        this._enhanceColorInputs();
        this._initSyntheticBoldControl();
        this._initConnectedBackgroundControls();
        this._bindEvents();
    }

    _normalizeHexColor(value) {
        const raw = String(value || '').trim();
        const match = raw.match(/^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
        if (!match) return null;
        const hex = match[1].toLowerCase();
        if (hex.length === 3) {
            return '#' + hex.split('').map((ch) => ch + ch).join('');
        }
        return '#' + hex;
    }

    _enhanceColorInputs(root = this.container) {
        const colorInputs = root.querySelectorAll('input[type="color"].rop-color');
        colorInputs.forEach((colorEl) => this._enhanceColorInput(colorEl));
    }

    _enhanceColorInput(colorEl, onChange) {
        if (!colorEl || colorEl.dataset.hexEnhanced === '1') return null;

        const wrapper = document.createElement('div');
        wrapper.className = 'rop-color-combo';
        const parent = colorEl.parentNode;
        parent.insertBefore(wrapper, colorEl);
        wrapper.appendChild(colorEl);

        const hexInput = document.createElement('input');
        hexInput.type = 'text';
        hexInput.className = 'rop-color-hex';
        hexInput.value = this._normalizeHexColor(colorEl.value) || '#000000';
        hexInput.placeholder = '#ffffff';
        hexInput.spellcheck = false;
        wrapper.appendChild(hexInput);

        colorEl.dataset.hexEnhanced = '1';
        colorEl._ropHexInput = hexInput;
        hexInput._ropColorInput = colorEl;

        let isInternalSync = false;

        const syncFromColor = () => {
            if (isInternalSync) return;
            const normalized = this._normalizeHexColor(colorEl.value);
            if (normalized) {
                hexInput.value = normalized;
                delete colorEl.dataset.gradientValue;
                colorEl.classList.remove('vk-has-gradient');
                colorEl.style.removeProperty('--vk-gradient-preview');
                if (colorEl._ropGradBtn) {
                    colorEl._ropGradBtn.classList.remove('vk-gradient-btn-active');
                    colorEl._ropGradBtn.style.boxShadow = '';
                    colorEl._ropGradBtn.style.borderColor = '';
                    colorEl._ropGradBtn.title = '设置渐变色 (支持多节点自定义)';
                }
            }
            if (typeof onChange === 'function') onChange(normalized || colorEl.value);
        };
        const syncFromHex = () => {
            if (isInternalSync) return;
            const raw = hexInput.value.trim();
            if (raw.includes(',')) {
                const parts = raw.split(',').map((s) => this._normalizeHexColor(s.trim())).filter(Boolean);
                if (parts.length >= 2) {
                    const gradStr = parts.join(',');
                    colorEl.dataset.gradientValue = gradStr;
                    const dir = colorEl.dataset.gradientDirection || 'horizontal';
                    const angle = dir === 'horizontal' ? 'to right' : (dir === 'diagonal' ? '135deg' : (dir === 'diagonal-up' ? '45deg' : 'to bottom'));
                    const gradCss = `linear-gradient(${angle}, ${parts.join(', ')})`;
                    colorEl.classList.add('vk-has-gradient');
                    colorEl.style.setProperty('--vk-gradient-preview', gradCss);
                    if (colorEl._ropGradBtn) {
                        colorEl._ropGradBtn.classList.add('vk-gradient-btn-active');
                        colorEl._ropGradBtn.title = `已启用渐变: ${gradStr}`;
                    }
                    isInternalSync = true;
                    try {
                        colorEl.value = parts[0];
                    } finally {
                        isInternalSync = false;
                    }
                    if (typeof onChange === 'function') onChange(gradStr);
                    this._syncToOverlay();
                    if (typeof this.videoCanvas?.onOverlayChange === 'function') {
                        this.videoCanvas.onOverlayChange(this._selectedOv);
                    }
                    return;
                }
            }
            const normalized = this._normalizeHexColor(hexInput.value);
            if (!normalized) return;
            delete colorEl.dataset.gradientValue;
            colorEl.classList.remove('vk-has-gradient');
            colorEl.style.removeProperty('--vk-gradient-preview');
            if (colorEl._ropGradBtn) {
                colorEl._ropGradBtn.classList.remove('vk-gradient-btn-active');
                colorEl._ropGradBtn.style.boxShadow = '';
                colorEl._ropGradBtn.style.borderColor = '';
                colorEl._ropGradBtn.title = '设置渐变色 (支持多节点自定义)';
            }
            isInternalSync = true;
            try {
                colorEl.value = normalized;
            } finally {
                isInternalSync = false;
            }
            hexInput.value = normalized;
            if (typeof onChange === 'function') onChange(normalized);
            this._syncToOverlay();
            if (typeof this.videoCanvas?.onOverlayChange === 'function') {
                this.videoCanvas.onOverlayChange(this._selectedOv);
            }
        };

        colorEl.addEventListener('input', syncFromColor);
        colorEl.addEventListener('change', syncFromColor);
        colorEl.addEventListener('click', (e) => {
            if (colorEl.dataset.gradientValue && colorEl.dataset.gradientValue.includes(',') && colorEl._ropGradBtn) {
                e.preventDefault();
                colorEl._ropGradBtn.click();
            }
        });
        hexInput.addEventListener('input', syncFromHex);
        hexInput.addEventListener('change', syncFromHex);

        const gradientIds = [
            'rop-title-color',
            'rop-body-color',
            'rop-footer-color',
            'rop-scroll-title-color',
            'rop-scroll-color',
            'rop-color',
            // 背景与笔刷底色渐变
            'rop-title-bg-color',
            'rop-body-bg-color',
            'rop-footer-bg-color',
            'rop-card-color',
            'rop-scroll-title-bg-color',
            'rop-scroll-body-bg-color',
            'rop-scroll-bg-color',
            // 装饰线渐变
            'rop-title-deco-color',
            'rop-scroll-title-deco-color'
        ];
        if (gradientIds.includes(colorEl.id)) {
            const gradBtn = document.createElement('button');
            gradBtn.type = 'button';
            gradBtn.className = 'rop-gradient-btn';
            gradBtn.title = '设置渐变色 (支持多节点自定义与流行预设)';
            gradBtn.innerHTML = '🌈';
            colorEl._ropGradBtn = gradBtn;
            gradBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (!window.ReelsGradientPicker) return;

                const currentVal = colorEl.dataset.gradientValue || (hexInput.value && hexInput.value.trim()) || (colorEl.value || '#ffffff');
                const ov = this._selectedOv;
                let curDir = colorEl.dataset.gradientDirection || 'horizontal';
                if (ov) {
                    if (colorEl.id === 'rop-title-color' && ov.title_gradient_direction) curDir = ov.title_gradient_direction;
                    else if (colorEl.id === 'rop-title-bg-color' && ov.title_bg_gradient_direction) curDir = ov.title_bg_gradient_direction;
                    else if (colorEl.id === 'rop-title-deco-color' && ov.title_deco_gradient_direction) curDir = ov.title_deco_gradient_direction;
                    else if (colorEl.id === 'rop-body-color' && ov.body_gradient_direction) curDir = ov.body_gradient_direction;
                    else if (colorEl.id === 'rop-body-bg-color' && ov.body_bg_gradient_direction) curDir = ov.body_bg_gradient_direction;
                    else if (colorEl.id === 'rop-footer-color' && ov.footer_gradient_direction) curDir = ov.footer_gradient_direction;
                    else if (colorEl.id === 'rop-footer-bg-color' && ov.footer_bg_gradient_direction) curDir = ov.footer_bg_gradient_direction;
                    else if (colorEl.id === 'rop-card-color' && ov.card_gradient_direction) curDir = ov.card_gradient_direction;
                    else if (colorEl.id === 'rop-scroll-title-color' && ov.scroll_title_gradient_direction) curDir = ov.scroll_title_gradient_direction;
                    else if (colorEl.id === 'rop-scroll-title-bg-color' && ov.scroll_title_bg_gradient_direction) curDir = ov.scroll_title_bg_gradient_direction;
                    else if (colorEl.id === 'rop-scroll-title-deco-color' && ov.scroll_title_deco_gradient_direction) curDir = ov.scroll_title_deco_gradient_direction;
                    else if (colorEl.id === 'rop-scroll-body-bg-color' && ov.scroll_body_bg_gradient_direction) curDir = ov.scroll_body_bg_gradient_direction;
                    else if (colorEl.id === 'rop-scroll-color' && (ov.scroll_gradient_direction || ov.gradient_direction)) curDir = ov.scroll_gradient_direction || ov.gradient_direction;
                    else if (colorEl.id === 'rop-color' && ov.gradient_direction) curDir = ov.gradient_direction;
                }

                const isBgColor = colorEl.id.includes('bg') || colorEl.id === 'rop-card-color';
                const isDecoColor = colorEl.id.includes('deco');
                const pickerTitle = isDecoColor ? '自定义装饰线渐变色' : (isBgColor ? '自定义背景/笔刷渐变色' : '自定义文字渐变色');
                window.ReelsGradientPicker.open({
                    title: pickerTitle,
                    value: currentVal,
                    direction: curDir,
                    anchorEl: gradBtn,
                    onChange: ({ value, direction }) => {
                        hexInput.value = value;
                        const first = value.split(',')[0].trim();
                        const normFirst = this._normalizeHexColor(first);

                        isInternalSync = true;
                        try {
                            if (normFirst) colorEl.value = normFirst;
                        } finally {
                            isInternalSync = false;
                        }

                        colorEl.dataset.gradientDirection = direction;
                        if (value.includes(',')) {
                            colorEl.dataset.gradientValue = value;
                            const angle = direction === 'horizontal' ? 'to right' : (direction === 'diagonal' ? '135deg' : (direction === 'diagonal-up' ? '45deg' : 'to bottom'));
                            const gradCss = `linear-gradient(${angle}, ${value.split(',').map(c => c.trim()).join(', ')})`;
                            colorEl.classList.add('vk-has-gradient');
                            colorEl.style.setProperty('--vk-gradient-preview', gradCss);
                            if (gradBtn) {
                                gradBtn.classList.add('vk-gradient-btn-active');
                                gradBtn.title = `已启用渐变 (${direction === 'horizontal' ? '水平' : (direction === 'diagonal' ? '对角' : (direction === 'diagonal-up' ? '反向对角' : '垂直'))}): ${value}`;
                            }
                        } else {
                            delete colorEl.dataset.gradientValue;
                            colorEl.classList.remove('vk-has-gradient');
                            colorEl.style.removeProperty('--vk-gradient-preview');
                            if (gradBtn) {
                                gradBtn.classList.remove('vk-gradient-btn-active');
                                gradBtn.style.boxShadow = '';
                                gradBtn.style.borderColor = '';
                                gradBtn.title = '设置渐变色 (支持多节点自定义)';
                            }
                        }

                        if (ov) {
                            if (colorEl.id === 'rop-title-color') {
                                ov.title_color = value;
                                ov.title_gradient_direction = direction;
                            } else if (colorEl.id === 'rop-title-bg-color') {
                                ov.title_bg_color = value;
                                ov.title_bg_gradient_direction = direction;
                            } else if (colorEl.id === 'rop-title-deco-color') {
                                ov.title_deco_color = value;
                                ov.title_deco_gradient_direction = direction;
                            } else if (colorEl.id === 'rop-body-color') {
                                ov.body_color = value;
                                ov.body_gradient_direction = direction;
                            } else if (colorEl.id === 'rop-body-bg-color') {
                                ov.body_bg_color = value;
                                ov.body_bg_gradient_direction = direction;
                            } else if (colorEl.id === 'rop-footer-color') {
                                ov.footer_color = value;
                                ov.footer_gradient_direction = direction;
                            } else if (colorEl.id === 'rop-footer-bg-color') {
                                ov.footer_bg_color = value;
                                ov.footer_bg_gradient_direction = direction;
                            } else if (colorEl.id === 'rop-card-color') {
                                ov.card_color = value;
                                ov.card_gradient_direction = direction;
                            } else if (colorEl.id === 'rop-scroll-title-color') {
                                ov.scroll_title_color = value;
                                ov.scroll_title_gradient_direction = direction;
                            } else if (colorEl.id === 'rop-scroll-title-bg-color') {
                                ov.scroll_title_bg_color = value;
                                ov.scroll_title_bg_gradient_direction = direction;
                            } else if (colorEl.id === 'rop-scroll-title-deco-color') {
                                ov.scroll_title_deco_color = value;
                                ov.scroll_title_deco_gradient_direction = direction;
                            } else if (colorEl.id === 'rop-scroll-body-bg-color') {
                                ov.scroll_body_bg_color = value;
                                ov.scroll_body_bg_gradient_direction = direction;
                            } else if (colorEl.id === 'rop-scroll-color') {
                                ov.color = value;
                                ov.scroll_gradient_direction = direction;
                            } else if (colorEl.id === 'rop-color') {
                                ov.color = value;
                                ov.gradient_direction = direction;
                            }
                        }

                        if (typeof onChange === 'function') onChange(value);
                        this._syncToOverlay();
                        if (typeof this.videoCanvas?.onOverlayChange === 'function') {
                            this.videoCanvas.onOverlayChange(ov);
                        }
                        if (typeof window.reelsSaveHistory === 'function') {
                            window.reelsSaveHistory();
                        }
                    }
                });
            });
            wrapper.appendChild(gradBtn);
        }

        return hexInput;
    }

    _setupCollapsibleGroups() {
        const groups = this.container.querySelectorAll('#rop-props .rop-group');
        groups.forEach((group) => {
            if (group.dataset.collapsibleReady === '1') return;
            let header = group.querySelector(':scope > .rop-group-title');
            let headerWrap = null;
            if (!header) {
                const first = group.firstElementChild;
                if (first && first.querySelector && first.querySelector('.rop-group-title')) {
                    header = first.querySelector('.rop-group-title');
                    headerWrap = first;
                    first.classList.add('rop-collapsible-head');
                }
            }
            if (!header) return;
            group.dataset.collapsibleReady = '1';
            const childTitles = Array.from(group.children || []).filter((el) => el.classList && el.classList.contains('rop-group-title'));
            const multiSection = childTitles.length >= 2;

            // 多小节面板改为“小节单独折叠”，避免整块一起收起造成混乱
            if (!multiSection) {
                group.classList.add('rop-collapsible-group');

                const icon = document.createElement('span');
                icon.className = 'rop-collapse-icon';
                icon.textContent = '▸'; // Default to collapsed
                icon.setAttribute('aria-hidden', 'true');
                header.prepend(icon);
                header.classList.add('rop-clickable');
                header.title = '点击折叠/展开';
                
                // Add initial collapsed class
                group.classList.add('rop-collapsed');
                header.addEventListener('click', (e) => {
                    if (e.target && e.target.closest && e.target.closest('button,input,select,textarea,a')) return;
                    e.preventDefault();
                    e.stopPropagation();
                    const next = !group.classList.contains('rop-collapsed');
                    group.classList.toggle('rop-collapsed', next);
                    icon.textContent = next ? '▸' : '▾';
                });

                if (!headerWrap) {
                    header.classList.add('rop-collapsible-head');
                }
            }

            if (multiSection) {
                this._setupSubsectionCollapsibles(group);
            }
        });
    }

    _setupSubsectionCollapsibles(group) {
        const titles = Array.from(group.children || []).filter((el) => el.classList && el.classList.contains('rop-group-title'));
        if (titles.length < 2) return;
        titles.forEach((title, idx) => {
            if (title.dataset.subsectionReady === '1') return;

            let cursor = title.nextElementSibling;
            const body = document.createElement('div');
            body.className = 'rop-subsection-body';
            while (cursor && !(cursor.classList && cursor.classList.contains('rop-group-title'))) {
                const next = cursor.nextElementSibling;
                body.appendChild(cursor);
                cursor = next;
            }

            if (!body.children.length) return;
            title.dataset.subsectionReady = '1';
            title.classList.add('rop-collapsible-head', 'rop-subsection-head');
            title.dataset.sectionTone = String((idx % 6) + 1);

            const icon = document.createElement('span');
            icon.className = 'rop-collapse-icon';
            icon.textContent = '▸'; // Default to collapsed
            icon.setAttribute('aria-hidden', 'true');
            title.prepend(icon);
            title.classList.add('rop-clickable');
            title.title = '点击折叠/展开小节';
            
            // Default to collapsed body
            body.classList.add('rop-collapsed');
            title.addEventListener('click', (e) => {
                if (e.target && e.target.closest && e.target.closest('button,input,select,textarea,a')) return;
                e.preventDefault();
                e.stopPropagation();
                const collapsed = !body.classList.contains('rop-collapsed');
                body.classList.toggle('rop-collapsed', collapsed);
                icon.textContent = collapsed ? '▸' : '▾';
            });

            title.insertAdjacentElement('afterend', body);
        });
    }

    _initSyntheticBoldControl() {
        const group=document.createElement('div');group.id='rop-synthetic-bold-group';group.className='rop-group';
        group.style.cssText='display:none;margin:8px 0;';
        const label=document.createElement('label');label.style.cssText='display:flex;align-items:center;gap:8px;';
        label.title='仅在当前覆层的粗体字重没有实际加粗时补偿；常规字重不变。';
        const input=document.createElement('input');input.type='checkbox';input.id='rop-synthetic-bold';input.className='rop-defaultable';input.dataset.default='false';
        label.append(input,document.createTextNode('字体合成加粗补偿（当前覆层）'));group.append(label);
        this.container.querySelector('#rop-text-props')?.before(group);
    }

    _initConnectedBackgroundControls() {
        for(const prefix of ['title','body','footer','scroll-title','scroll-body']) {
            const select=this.container.querySelector('#rop-'+prefix+'-bg-mode');if(!select)continue;
            select.add(new Option('连体轮廓（圆角与行宽吸附）','inline-connected'));
            let anchor=select;
            for(const [key,label,value,max] of [['concave-radius','内凹圆角',10,100],['snap-threshold','行宽吸附容差',18,100]]) {
                const caption=document.createElement('label');caption.textContent=label;
                const input=document.createElement('input');input.type='number';input.id='rop-'+prefix+'-bg-'+key;
                input.className='rop-input rop-defaultable';input.dataset.default=String(value);input.min='0';input.max=String(max);input.step='1';input.value=String(value);
                input.title='选择连体轮廓模式后生效';input.style.maxWidth='95px';anchor.after(caption,input);anchor=input;
            }
        }
    }

    _bindEvents() {
        const overlayAboveSubtitle = this.container.querySelector('#rop-overlay-above-subtitle');
        if (overlayAboveSubtitle) {
            overlayAboveSubtitle.checked = this.videoCanvas?.getOverlayAboveSubtitle?.() !== false;
            overlayAboveSubtitle.addEventListener('change', () => {
                this.videoCanvas?.setOverlayAboveSubtitle?.(overlayAboveSubtitle.checked);
                this._requestRender();
            });
        }

        // 添加覆层
        this.container.querySelector('#rop-add-text').addEventListener('click', () => this._addTextOverlay());
        this.container.querySelector('#rop-add-textcard').addEventListener('click', () => this._addTextCardOverlay());
        this.container.querySelector('#rop-add-phone-cta')?.addEventListener('click', () => this._addPhoneCtaOverlay());
        this.container.querySelector('#rop-add-decor')?.addEventListener('click', () => this._addDecorOverlay());
        this.container.querySelector('#rop-add-solidmask')?.addEventListener('click', () => this._addSolidMaskOverlay());
        this.container.querySelector('#rop-add-image').addEventListener('click', () => this._addImageOverlay());
        this.container.querySelector('#rop-layer-slot-audit')?.addEventListener('click', () => this._openLayerSlotAudit());
        this.container.querySelector('#rop-batch-add-media')?.addEventListener('click', () => this._pickBatchMediaForTaskGroup());
        this._bindMediaDropTarget();
        this._bindSelectedMediaDropTarget();
        this.container.querySelector('#rop-media-library').addEventListener('click', () => this._openMediaLibrary());
        this.container.querySelector('#rop-add-scroll').addEventListener('click', () => this._addScrollOverlay());
        this.container.querySelector('#rop-layer-slot')?.addEventListener('change', async (event) => {
            if (event.target.value !== '__custom__') return;
            const name = await _showInputDialog('自定义层位名称', '例如：产品展示层', '');
            if (!name || !name.trim()) { event.target.value = ''; return; }
            const slots = window.ReelsLayerSlots;
            const key = slots?.customKey(name) || `custom:${name.trim()}`;
            const option = document.createElement('option');
            option.value = key; option.textContent = name.trim(); option.selected = true;
            event.target.insertBefore(option, event.target.querySelector('option[value="__custom__"]'));
            event.target.dispatchEvent(new Event('change', { bubbles: true }));
        });
        this.container.querySelector('#rop-duplicate').addEventListener('click', () => this._duplicateOverlay());
        this.container.querySelector('#rop-copy-to-tasks')?.addEventListener('click', () => this._copySelectedOverlayToTasks());
        this.container.querySelector('#rop-delete').addEventListener('click', () => this._deleteOverlay());
        this.container.querySelector('#rop-media-replace')?.addEventListener('click', () => this._replaceSelectedMedia());
        this.container.querySelector('#rop-media-folder')?.addEventListener('click', () => this._pickSelectedMediaFolder());
        this.container.querySelector('#rop-pip-media-library')?.addEventListener('click', () => this._openPipMediaLibrary());
        this.container.querySelector('#rop-media-folder-clear')?.addEventListener('click', () => {
            const ov = this._selectedOv;
            if (!ov) return;
            delete ov.media_folder_path; delete ov.media_folder_files; delete ov.media_folder_items;
            this._syncFromOverlay(ov); this._requestRender();
        });

        // "显示终点" toggle
        const showEndBtn = this.container.querySelector('#rop-scroll-show-end');
        if (showEndBtn) {
            showEndBtn.addEventListener('click', () => {
                const active = showEndBtn.classList.toggle('active');
                showEndBtn.style.background = active ? '#FF6B35' : '';
                showEndBtn.style.color = active ? '#fff' : '';
                showEndBtn.textContent = active ? '👁 终点预览中' : '👁 显示终点';
                // Set global flag for render loop
                if (this.videoCanvas?.scopedTask) this.videoCanvas.previewEnd?.(active);
                else if (window._reelsState) window._reelsState._scrollPreviewEnd = active;
            });
        }

        // "预览终点" toggle for A→B animation
        const animPreviewEndBtn = this.container.querySelector('#rop-anim-preview-end');
        if (animPreviewEndBtn) {
            animPreviewEndBtn.addEventListener('click', () => {
                const active = animPreviewEndBtn.classList.toggle('active');
                animPreviewEndBtn.style.background = active ? '#7b8bef' : '';
                animPreviewEndBtn.style.color = active ? '#fff' : '';
                animPreviewEndBtn.textContent = active ? '👁 终点预览中' : '👁 预览终点';
                // Set flag on the selected overlay for renderer
                if (this._selectedOv) {
                    this._selectedOv._previewAtEnd = active;
                }
            });
        }

        // Overlay group presets
        this.container.querySelector('#rop-group-preset-update')?.addEventListener('click', () => this._updateOverlayGroupPreset());
        this.container.querySelector('#rop-group-preset-save')?.addEventListener('click', () => this._saveOverlayGroupPreset());
        this.container.querySelector('#rop-group-preset-load')?.addEventListener('click', () => this._loadOverlayGroupPreset());
        this.container.querySelector('#rop-group-preset-append')?.addEventListener('click', () => this._loadOverlayGroupPreset('merge'));
        this.container.querySelector('#rop-group-preset-gallery')?.addEventListener('click', () => this._showPresetGallery());
        this.container.querySelector('#rop-group-preset-trigger')?.addEventListener('click', () => this._openOverlayGroupPresetSearch());
        this.container.querySelector('#rop-group-preset-del')?.addEventListener('click', () => this._deleteOverlayGroupPreset());
        this.container.querySelector('#rop-group-preset-rename')?.addEventListener('click', () => this._renameOverlayGroupPreset());
        this.container.querySelector('#rop-group-preset-import')?.addEventListener('click', () => this._importOverlayGroupPresets());
        this.container.querySelector('#rop-group-preset-export')?.addEventListener('click', () => this._exportOverlayGroupPresets());
        this.container.querySelector('#rop-preset-preview-bg-pick')?.addEventListener('click', () => this._pickPresetPreviewBackground());
        this.container.querySelector('#rop-preset-preview-bg-clear')?.addEventListener('click', () => this._clearPresetPreviewBackground());
        this.container.querySelector('#rop-title-deco-gallery')?.addEventListener('click', (event) => this._openPersonalDecorationGallery('title', event.currentTarget));
        this.container.querySelector('#rop-scroll-title-deco-gallery')?.addEventListener('click', (event) => this._openPersonalDecorationGallery('scroll', event.currentTarget));
        this.container.querySelectorAll('#rop-title-deco-export, #rop-scroll-title-deco-export').forEach((button) => {
            button.addEventListener('click', () => this._exportPersonalDecorationPresets());
        });
        this._refreshOverlayGroupPresetSelect();
        this._syncPresetPreviewBackgroundLabel();

        // ── 富文本编辑按钮 (覆层 textcard) ──
        this.container.querySelectorAll('.rop-richtext-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const section = btn.getAttribute('data-section'); // title | body | footer
                if (!this._selectedOv || this._selectedOv.type !== 'textcard') return;
                this._openOverlayRichTextEditor(section);
            });
        });

        // Reset to default buttons
        this.container.querySelectorAll('.rop-reset-transform-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                if (!this._selectedOv) return;
                const ov = this._selectedOv;
                if (ov.type === 'textcard' || ov.type === 'solid_mask') {
                    ov.x = ROP_TEXTCARD_DEFAULT_TRANSFORM.x;
                    ov.y = ROP_TEXTCARD_DEFAULT_TRANSFORM.y;
                    ov.w = ROP_TEXTCARD_DEFAULT_TRANSFORM.w;
                    ov.h = ROP_TEXTCARD_DEFAULT_TRANSFORM.h;
                    ov.rotation = ROP_TEXTCARD_DEFAULT_TRANSFORM.rotation;
                    ov.opacity = ROP_TEXTCARD_DEFAULT_TRANSFORM.opacity;
                } else {
                    ov.w = 300;
                    ov.h = 300;
                    ov.x = (1080 - ov.w) / 2;  // 居中
                    ov.y = (1920 - ov.h) / 2;
                    ov.rotation = 0;
                    ov.opacity = 255;
                }
                if (ov.type === 'image' || ov.type === 'video') { ov.scale = 1; ov.scale_x = 1; ov.scale_y = 1; }
                this._syncFromOverlay(ov);
                
                const applyAllEl = this.container.querySelector('#rop-card-apply-all');
                if (ov.type === 'textcard' && applyAllEl && applyAllEl.checked) {
                    this._applyTextcardStyleToAllTasks(ov);
                }
                const scrollApplyAllEl = this.container.querySelector('#rop-scroll-apply-all');
                if (ov.type === 'scroll' && scrollApplyAllEl && scrollApplyAllEl.checked) {
                    this._applyScrollStyleToAllTasks(ov);
                }
                
                if (this.videoCanvas) this.videoCanvas.render();
            });
        });

        // Fill screen buttons
        this.container.querySelectorAll('.rop-fill-screen-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                if (!this._selectedOv) return;
                const ov = this._selectedOv;
                ov.x = 0;
                ov.y = 0;
                ov.w = 1080;
                ov.h = 1920;
                if (ov.type === 'image' || ov.type === 'video') { ov.scale = 1; ov.scale_x = 1; ov.scale_y = 1; }
                this._syncFromOverlay(ov);
                
                const applyAllEl = this.container.querySelector('#rop-card-apply-all');
                if (ov.type === 'textcard' && applyAllEl && applyAllEl.checked) {
                    this._applyTextcardStyleToAllTasks(ov);
                }
                const scrollApplyAllEl = this.container.querySelector('#rop-scroll-apply-all');
                if (ov.type === 'scroll' && scrollApplyAllEl && scrollApplyAllEl.checked) {
                    this._applyScrollStyleToAllTasks(ov);
                }
                
                if (this.videoCanvas) this.videoCanvas.render();
            });
        });

        // ── Auto-Colorize UI Events ──
        this.container.querySelector('#rop-autocolor-add')?.addEventListener('click', () => {
            if (!this._selectedOv) return;
            const ov = this._selectedOv;
            ov.auto_color_rules = ov.auto_color_rules || [];
            ov.auto_color_rules.push({
                type: 'keyword',
                keywords: [''],
                color: '#FFD700',
                bold: true,
                fontsize: null
            });
            this._renderAutoColorRules();
            this._notifyAutoColorChange();
        });

        this.container.querySelector('#rop-autocolor-clear')?.addEventListener('click', () => {
            if (!this._selectedOv) return;
            this._selectedOv.auto_color_rules = [];
            this._renderAutoColorRules();
            this._notifyAutoColorChange();
        });

        this.container.querySelectorAll('.rop-autocolor-preset').forEach(btn => {
            btn.addEventListener('click', () => {
                if (!this._selectedOv) return;
                const preset = btn.getAttribute('data-preset');
                const ov = this._selectedOv;
                ov.auto_color_rules = ov.auto_color_rules || [];
                
                if (preset === 'gold_numbers') {
                    // 数字 -> 金色
                    ov.auto_color_rules.push({ type: 'number', keywords: ['[+\\\\-]?\\\\d+([.,\\\\- ]\\\\d+)*'], color: '#FFD700', bold: true });
                } else if (preset === 'brand') {
                    ov.auto_color_rules.push({ type: 'english', keywords: ["[\\p{L}\\p{M}]+(?:[’'\\-][\\p{L}\\p{M}]+)*"], color: '#00D4FF', bold: true });
                    ov.auto_color_rules.push({ type: 'number', keywords: ['[+\\\\-]?\\\\d+([.,\\\\- ]\\\\d+)*'], color: '#FFD700', bold: true });
                } else if (preset === 'red_emphasis') {
                    ov.auto_color_rules.push({ type: 'number', keywords: ['[+\\\\-]?\\\\d+([.,\\\\- ]\\\\d+)*'], color: '#FF4444', bold: true });
                    ov.auto_color_rules.push({ type: 'punctuation', keywords: ['[!?！？❤️⭐✨🔥💪…]+'], color: '#FF4444', bold: true });
                }
                
                this._renderAutoColorRules();
                this._notifyAutoColorChange();
            });
        });

        // 使用 FontManager 填充字体下拉框（和字幕面板一致）
        if (window.getFontManager) {
            const fm = getFontManager();
            const refreshFont = (id, value) => fm.refreshFontSelect(this.container.querySelector('#' + id) || id, value);
            refreshFont('rop-font', 'Arial');
            refreshFont('rop-title-font', 'Crimson Pro');
            refreshFont('rop-body-font', 'Arial');
            refreshFont('rop-footer-font', 'Arial');
            refreshFont('rop-scroll-font', 'Arial');
            refreshFont('rop-scroll-title-font', 'Arial');
            if (fm && typeof fm.loadGoogleFont === 'function') {
                fm.loadGoogleFont('Crimson Pro').catch(() => { });
            }
        }

        const delayButton = this.container.querySelector('#rop-delay-apply');
        delayButton?.addEventListener('click', async () => {
            const ov = this._selectedOv;
            if (!ov) return;
            const status = this.container.querySelector('#rop-delay-status');
            const seconds = this._get('rop-delay-enabled') ? Number(this._get('rop-delay-seconds')) : 0;
            delayButton.disabled = true;
            if (status) status.textContent = '正在生成，请稍候…';
            try {
                await window.ReelsPlaybackDelay.apply(ov, 'overlay', seconds, window.electronAPI, () => this._selectedOv === ov);
                this.videoCanvas?.onOverlayChange?.(ov);
                this.videoCanvas?.render?.();
                if (this._selectedOv === ov) this.selectOverlay(ov);
                if (status) status.textContent = seconds ? `已应用：先静音定格 ${seconds} 秒` : '已恢复原素材';
            } catch (error) { if (status) status.textContent = error.message; }
            finally { delayButton.disabled = false; }
        });

        const allCorners = this.container.querySelector('#rop-media-corner-all');
        const applyAllCorners = () => {
            const value = Math.max(0, Math.min(1000, Number(allCorners.value) || 0));
            for (const corner of ['tl','tr','br','bl']) this._val('rop-media-corner-' + corner, value);
            const shape = this._get('rop-media-mask-shape');
            if (value > 0 && shape === 'rect') this._val('rop-media-mask-shape', 'round_rect');
            this._syncToOverlay();
        };
        allCorners?.addEventListener('input', applyAllCorners);
        allCorners?.addEventListener('change', applyAllCorners);

        this.container.querySelector('#rop-media-border-style')?.addEventListener('change', () => {
            const preset = window.ReelsMediaBorder?.presets[this._get('rop-media-border-style')];
            if (preset) {
                this._val('rop-media-border-color', preset.color);
                this._val('rop-media-border-width', preset.width);
                this._val('rop-media-border-opacity', 100);
            }
        });

        // 属性变更
        const fields = [
            'rop-video-end', 'rop-media-border-style', 'rop-media-border-position', 'rop-media-border-color', 'rop-media-border-width', 'rop-media-border-opacity',
            'rop-name', 'rop-fixed-text', 'rop-synthetic-bold',
            'rop-x', 'rop-y', 'rop-w', 'rop-h', 'rop-rotation', 'rop-opacity',
            'rop-start', 'rop-end', 'rop-content', 'rop-font', 'rop-fontsize',
            'rop-color', 'rop-bold', 'rop-font-weight', 'rop-use-stroke', 'rop-stroke-color', 'rop-stroke-width',
            'rop-shadow-enabled', 'rop-shadow-color', 'rop-shadow-blur', 'rop-shadow-offset-x', 'rop-shadow-offset-y', 'rop-shadow-opacity', 'rop-scale-x', 'rop-scale-y', 'rop-flip-h', 'rop-video-offset', 'rop-keep-aspect', 'rop-media-window-mode', 'rop-media-window-ratio', 'rop-media-window-width', 'rop-media-window-height', 'rop-media-mask-shape', 'rop-media-corner-tl', 'rop-media-corner-tr', 'rop-media-corner-br', 'rop-media-corner-bl', 'rop-media-loop', 'rop-media-audio-enabled', 'rop-media-blur-fill', 'rop-media-folder-interval', 'rop-media-inner-x', 'rop-media-inner-y', 'rop-media-inner-scale', 'rop-media-inner-rotation', 'rop-media-crop-left', 'rop-media-crop-top', 'rop-media-crop-right', 'rop-media-crop-bottom',
            'rop-flip-v', 'rop-blend', 'rop-anim-in', 'rop-anim-out',
            'rop-bind-scroll-target', 'rop-bind-scroll-offset-y', 'rop-bind-scroll-offset-x',
            'rop-bind-scroll-clamp-min-y', 'rop-bind-scroll-clamp-max-y', 'rop-bind-scroll-follow-x',
            'rop-anim-in-dur', 'rop-anim-out-dur',
            'rop-anim-dest-enabled', 'rop-anim-easing', 'rop-anim-timing-mode', 'rop-anim-duration', 'rop-anim-speed', 'rop-anim-start-x', 'rop-anim-start-y', 'rop-anim-end-x', 'rop-anim-end-y', 'rop-anim-start-scale', 'rop-anim-end-scale',
            // Text card fields
            'rop-card-enabled',
            'rop-card-color', 'rop-card-opacity', 'rop-radius-all', 'rop-card-feather-enabled', 'rop-card-feather-dir', 'rop-card-feather-start', 'rop-card-feather-end',
            'rop-card-border-enabled', 'rop-card-border-sides', 'rop-card-border-color', 'rop-card-border-width', 'rop-card-border-style', 'rop-card-border-opacity',
            'rop-card-blur-enabled', 'rop-card-blur-amount',
            'rop-title-text', 'rop-title-font', 'rop-title-fontsize',
            'rop-title-color', 'rop-title-bold', 'rop-title-weight', 'rop-title-uppercase', 'rop-title-align', 'rop-title-valign',
            'rop-title-offset-x', 'rop-title-offset-y', 'rop-title-linespacing', 'rop-title-rotation', 'rop-title-letterspacing',
            'rop-title-override-w', 'rop-title-override-h',
            'rop-title-max-glyph-height', 'rop-title-adaptive-enabled',
            'rop-title-adaptive-max-lines', 'rop-title-preferred-glyph-height', 'rop-title-adaptive-min-w', 'rop-title-adaptive-min-h', 'rop-title-adaptive-max-w', 'rop-title-adaptive-max-h',
            'rop-body-text', 'rop-body-follow-title', 'rop-body-font', 'rop-body-fontsize',
            'rop-body-color', 'rop-body-bold', 'rop-body-weight', 'rop-body-linespacing', 'rop-body-letterspacing', 'rop-body-align', 'rop-body-valign',
            'rop-body-offset-x', 'rop-body-offset-y',
            'rop-body-override-w', 'rop-body-override-h', 'rop-body-auto-shrink',
            'rop-footer-text', 'rop-footer-font', 'rop-footer-fontsize',
            'rop-footer-color', 'rop-footer-bold', 'rop-footer-weight', 'rop-footer-align', 'rop-footer-valign',
            'rop-footer-offset-x', 'rop-footer-offset-y', 'rop-footer-linespacing', 'rop-footer-letterspacing',
            'rop-footer-override-w', 'rop-footer-override-h', 'rop-footer-auto-shrink',
            'rop-title-stroke-color', 'rop-title-stroke-width',
            'rop-title-shadow-color', 'rop-title-shadow-blur', 'rop-title-shadow-x', 'rop-title-shadow-y',
            'rop-title-bg-border-enabled', 'rop-title-bg-border-color', 'rop-title-bg-border-width', 'rop-title-bg-border-style', 'rop-title-bg-border-opacity',
            'rop-title-bg-enabled', 'rop-title-bg-mode', 'rop-title-bg-concave-radius', 'rop-title-bg-snap-threshold', 'rop-title-bg-color', 'rop-title-bg-opacity', 'rop-title-bg-radius',
            'rop-title-bg-pad-h', 'rop-title-bg-pad-top', 'rop-title-bg-pad-bottom',
            'rop-title-bg-brush', 'rop-title-bg-brush-style', 'rop-title-bg-brush-colormode', 'rop-title-bg-brush-fit', 'rop-title-bg-brush-zoom', 'rop-title-bg-brush-scale-x', 'rop-title-bg-brush-scale-y', 'rop-title-bg-brush-solid', 'rop-title-bg-brush-x', 'rop-title-bg-brush-y',
            'rop-title-deco-enabled', 'rop-title-deco-position', 'rop-title-deco-style', 'rop-title-deco-align',
            'rop-title-deco-color', 'rop-title-deco-color2', 'rop-title-deco-thickness', 'rop-title-deco-length', 'rop-title-deco-gap', 'rop-title-deco-opacity',
            'rop-title-deco-scale', 'rop-title-deco-center-gap', 'rop-title-deco-linecap', 'rop-title-deco-flip',
            'rop-body-stroke-color', 'rop-body-stroke-width',
            'rop-body-shadow-color', 'rop-body-shadow-blur', 'rop-body-shadow-x', 'rop-body-shadow-y',
            'rop-body-bg-border-enabled', 'rop-body-bg-border-color', 'rop-body-bg-border-width', 'rop-body-bg-border-style', 'rop-body-bg-border-opacity',
            'rop-body-bg-enabled', 'rop-body-bg-mode', 'rop-body-bg-concave-radius', 'rop-body-bg-snap-threshold', 'rop-body-bg-color', 'rop-body-bg-opacity', 'rop-body-bg-radius',
            'rop-body-bg-pad-h', 'rop-body-bg-pad-top', 'rop-body-bg-pad-bottom',
            'rop-body-bg-brush', 'rop-body-bg-brush-style', 'rop-body-bg-brush-colormode', 'rop-body-bg-brush-fit', 'rop-body-bg-brush-zoom', 'rop-body-bg-brush-scale-x', 'rop-body-bg-brush-scale-y', 'rop-body-bg-brush-solid', 'rop-body-bg-brush-x', 'rop-body-bg-brush-y',
            'rop-footer-stroke-color', 'rop-footer-stroke-width',
            'rop-footer-shadow-color', 'rop-footer-shadow-blur', 'rop-footer-shadow-x', 'rop-footer-shadow-y',
            'rop-footer-bg-border-enabled', 'rop-footer-bg-border-color', 'rop-footer-bg-border-width', 'rop-footer-bg-border-style', 'rop-footer-bg-border-opacity',
            'rop-footer-bg-enabled', 'rop-footer-bg-mode', 'rop-footer-bg-concave-radius', 'rop-footer-bg-snap-threshold', 'rop-footer-bg-color', 'rop-footer-bg-opacity', 'rop-footer-bg-radius',
            'rop-footer-bg-pad-h', 'rop-footer-bg-pad-top', 'rop-footer-bg-pad-bottom',
            'rop-auto-fit', 'rop-auto-center', 'rop-fullscreen-mask', 'rop-title-body-gap', 'rop-body-footer-gap', 'rop-offset-x', 'rop-offset-y', 'rop-debug-layout', 'rop-debug-title', 'rop-debug-body', 'rop-debug-footer', 'rop-layout-mode',
            'rop-pad-top', 'rop-pad-bottom', 'rop-pad-left', 'rop-pad-right',
            'rop-card-width', 'rop-card-height', 'rop-card-x', 'rop-card-y',
            'rop-auto-shrink', 'rop-max-height', 'rop-title-max-lines', 'rop-min-fontsize',
            // Scroll fields
            'rop-scroll-content',
            'rop-scroll-title', 'rop-scroll-title-fontsize', 'rop-scroll-title-color',
            'rop-scroll-title-font', 'rop-scroll-title-weight', 'rop-scroll-title-gap', 'rop-scroll-title-fixed',
            'rop-scroll-title-independent', 'rop-scroll-title-x', 'rop-scroll-title-y',
            'rop-scroll-title-auto-fit', 'rop-scroll-title-maxh',
            'rop-scroll-title-uppercase', 'rop-scroll-title-letterspacing',
            'rop-scroll-title-align', 'rop-scroll-title-linespacing', 'rop-scroll-title-textw',
            'rop-scroll-title-stroke-color', 'rop-scroll-title-stroke-width',
            'rop-scroll-title-shadow', 'rop-scroll-title-shadow-color',
            'rop-scroll-title-shadow-blur', 'rop-scroll-title-shadow-x', 'rop-scroll-title-shadow-y',
            'rop-scroll-title-bg-enabled', 'rop-scroll-title-bg-mode', 'rop-scroll-title-bg-concave-radius', 'rop-scroll-title-bg-snap-threshold', 'rop-scroll-title-bg-color',
            'rop-scroll-title-bg-opacity', 'rop-scroll-title-bg-radius',
            'rop-scroll-title-bg-pad-h', 'rop-scroll-title-bg-pad-top', 'rop-scroll-title-bg-pad-bottom',
            'rop-scroll-title-deco-enabled', 'rop-scroll-title-deco-position', 'rop-scroll-title-deco-style',
            'rop-scroll-title-deco-align', 'rop-scroll-title-deco-color', 'rop-scroll-title-deco-color2',
            'rop-scroll-title-deco-thickness', 'rop-scroll-title-deco-length', 'rop-scroll-title-deco-gap',
            'rop-scroll-title-deco-opacity', 'rop-scroll-title-deco-scale', 'rop-scroll-title-deco-center-gap',
            'rop-scroll-title-deco-linecap', 'rop-scroll-title-deco-flip',
            'rop-scroll-font', 'rop-scroll-fontsize',
            'rop-scroll-color', 'rop-scroll-bold', 'rop-scroll-weight',
            'rop-scroll-align', 'rop-scroll-linespacing', 'rop-scroll-textw',
            'rop-scroll-text-direction',
            'rop-scroll-stroke-color', 'rop-scroll-stroke-width',
            'rop-scroll-shadow', 'rop-scroll-shadow-color', 'rop-scroll-shadow-blur',
            'rop-scroll-shadow-x', 'rop-scroll-shadow-y',
            'rop-scroll-body-bg-enabled', 'rop-scroll-body-bg-mode', 'rop-scroll-body-bg-concave-radius', 'rop-scroll-body-bg-snap-threshold', 'rop-scroll-body-bg-color',
            'rop-scroll-body-bg-opacity', 'rop-scroll-body-bg-radius',
            'rop-scroll-body-bg-pad-h', 'rop-scroll-body-bg-pad-top', 'rop-scroll-body-bg-pad-bottom',
            'rop-scroll-from-y', 'rop-scroll-to-y', 'rop-scroll-from-x', 'rop-scroll-to-x',
            'rop-scroll-offset-x', 'rop-scroll-offset-y',
            'rop-scroll-final-y', 'rop-scroll-start-offset',
            'rop-scroll-speed',
            'rop-scroll-auto-stop',
            'rop-scroll-auto-stop-lead',
            'rop-scroll-static',
            'rop-scroll-auto-fit', 'rop-scroll-min-fontsize',
            'rop-scroll-feather-top', 'rop-scroll-feather-bottom', 'rop-scroll-feather-top-offset', 'rop-scroll-feather-bottom-offset',
            'rop-scroll-feather-left', 'rop-scroll-feather-right', 'rop-scroll-feather-left-offset', 'rop-scroll-feather-right-offset',
            'rop-scroll-bg-enabled', 'rop-scroll-bg-color', 'rop-scroll-bg-opacity',
            'rop-scroll-bg-radius', 'rop-scroll-bg-pad-top', 'rop-scroll-bg-pad-bottom',
            'rop-scroll-bg-pad-left', 'rop-scroll-bg-pad-right', 'rop-scroll-bg-fullscreen',
            'rop-scroll-bg-border-enabled', 'rop-scroll-bg-border-sides', 'rop-scroll-bg-border-color', 'rop-scroll-bg-border-width',
            'rop-scroll-bg-border-style', 'rop-scroll-bg-border-opacity',
            'rop-scroll-bg-blur-enabled', 'rop-scroll-bg-blur-amount',
            // 文字翻转器
            'rop-flipper-enabled', 'rop-flipper-duration', 'rop-flipper-lines', 'rop-flipper-loop', 'rop-flipper-effect', 'rop-flipper-transition-duration'
        ];
        for (const fid of fields) {
            const el = this.container.querySelector('#' + fid);
            if (!el) continue;
            el.addEventListener('input', () => this._syncToOverlay(fid));
            el.addEventListener('change', () => this._syncToOverlay(fid));
        }
        const totalScale = this.container.querySelector('#rop-scale');
        const applyTotalScale = () => {
            const ov = this._selectedOv;
            if (!ov || !['image', 'video'].includes(ov.type)) return;
            const value = Math.max(1, Math.min(1000, Number(totalScale.value) || 1));
            // 总缩放是原有的一键等比控制；X/Y 保留给之后的独立拉伸。
            this._val('rop-scale-x', value);
            this._val('rop-scale-y', value);
            this._syncToOverlay();
        };
        totalScale?.addEventListener('input', applyTotalScale);
        totalScale?.addEventListener('change', applyTotalScale);
        const setSplitAngle=event=>{
            const ov=this._selectedOv;if(!ov || !['top_half','bottom_half'].includes(ov.media_window_mode))return;
            const rs=window._reelsState || {},width=rs.targetWidth || 1080,height=rs.targetHeight || 1920;
            const angle=window.ReelsMediaWindow.halfScreen(ov.media_window_mode,event.target.value,width,height).angle;
            this._val('rop-media-split-angle',angle);this._val('rop-media-split-angle-slider',angle);
            for(const layer of this.videoCanvas?.overlayMgr?.overlays || [ov]){
                if(!['image','video'].includes(layer.type) || !['top_half','bottom_half'].includes(layer.media_window_mode))continue;
                layer.media_split_angle=angle;this.videoCanvas?.onOverlayChange?.(layer);
            }
            this._requestRender();
        };
        for(const id of ['rop-media-split-angle','rop-media-split-angle-slider'])this.container.querySelector('#'+id)?.addEventListener('input',setSplitAngle);
        const mediaWindowMode = this.container.querySelector('#rop-media-window-mode');
        mediaWindowMode?.addEventListener('change', () => {
            const ov = this._selectedOv;
            if (!ov || !['image', 'video'].includes(ov.type)) return;
            if (mediaWindowMode.value === 'top_half' || mediaWindowMode.value === 'bottom_half') {
                // 上、下半屏窗口固定；接下来的位置、缩放、旋转全都只操作窗口里的素材。
                const isTopHalf = mediaWindowMode.value === 'top_half';
                const windowY = isTopHalf ? 0 : 960;
                const partner=(this.videoCanvas?.overlayMgr?.overlays || []).find(layer=>layer!==ov && ['top_half','bottom_half'].includes(layer.media_window_mode));
                ov.media_split_angle=partner?.media_split_angle ?? ov.media_split_angle ?? 0;
                ov.media_window_mode = mediaWindowMode.value;
                ov.media_window = { x: 0, y: windowY, w: 1080, h: 960, locked: true };
                ov.clip_rect = { x: 0, y: windowY, w: 1080, h: 960 };
                ov.crop_fill = true;
                ov.media_window_generated_clip = true;
                ov.w = 1080; ov.h = 960; ov.x = 0; ov.y = windowY;
                ov.media_inner_x = 0; ov.media_inner_y = 0;
                this._syncFromOverlay(ov);
            } else if (mediaWindowMode.value === 'pip') {
                ov.media_window_mode = 'pip';
                // 进入 PIP 一律建立 9:16 的真实窗口。此前仅全屏媒体会重置，
                // 非全屏旧覆层会保留原比例，造成“下拉是 9:16、提示框却不是”的错位。
                ov.w = 540; ov.h = 960;
                ov.x = 270; ov.y = 480;
                ov.scale = 1; ov.scale_x = 1; ov.scale_y = 1;
                // PIP 也必须有独立且固定的裁切窗，否则移动素材会视觉上像在拖整个画面。
                ov.clip_rect = { x: ov.x || 0, y: ov.y || 0, w: ov.w || 720, h: ov.h || 720 };
                ov.media_window = { x: ov.x || 0, y: ov.y || 0, w: ov.w || 720, h: ov.h || 720 };
                ov.media_window_initialized = true;
                ov.crop_fill = true;
                ov.media_window_generated_clip = true;
                ov.media_inner_x = 0; ov.media_inner_y = 0;
                ov.media_inner_scale = 1; ov.media_inner_rotation = 0;
                ov.media_window_ratio = '9:16';
                this._syncFromOverlay(ov);
            } else {
                // 默认模式不建立窗口对象，不改写原有覆层的尺寸、位置或裁切行为。
                delete ov.media_window_mode;
                delete ov.media_window;
                delete ov.media_window_initialized;
                delete ov.media_inner_x;
                delete ov.media_inner_y;
                delete ov.media_inner_scale;
                delete ov.media_inner_rotation;
                if (ov.media_window_generated_clip) {
                    delete ov.clip_rect;
                    delete ov.crop_fill;
                    delete ov.media_window_generated_clip;
                }
            }
            this._requestRender();
        });
        const mediaWindowRatio = this.container.querySelector('#rop-media-window-ratio');
        mediaWindowRatio?.addEventListener('change', () => {
            const ov = this._selectedOv;
            const choice = mediaWindowRatio.value;
            if (!ov || !['image', 'video'].includes(ov.type) || ov.media_window_mode !== 'pip' || choice === 'free') return;
            const [rw, rh] = choice.split(':').map(Number);
            if (!(rw > 0 && rh > 0)) return;
            // 只调外层窗口的宽高，保持窗口左上角和内部取景（inner 参数）不变。
            const currentW = Math.max(1, Number(ov.w) || 720);
            ov.w = currentW;
            ov.h = Math.round(currentW * rh / rw);
            ov.media_window = { x: ov.x || 0, y: ov.y || 0, w: ov.w, h: ov.h };
            ov.clip_rect = { ...ov.media_window };
            ov.media_window_ratio = choice;
            this._syncFromOverlay(ov);
            this._requestRender();
        });
        this.container.querySelectorAll('.rop-media-align').forEach(button => button.addEventListener('click', () => {
            const align=button.dataset.align || 'cc';
            if(window.ReelsOverviewBatch?.alignSelected(this,align))return;
            if(!window.ReelsMediaWindow?.alignWindow){window.showToast?.('定位组件需要刷新，请保存后刷新界面再试','warning');return;}
            const ov=this._selectedOv,values=window.ReelsMediaWindow.alignWindow(ov,align);
            if(!values){window.showToast?.('请先选择画中画窗口模式的媒体层','warning');return;}
            Object.assign(ov,values);this._syncFromOverlay(ov);this._requestRender();
            this.videoCanvas?.onOverlayChange?.(ov,{source:this});
            window.showToast?.(`已定位当前窗口：${button.title || align}`,'success');
        }));

        // ── Windows Electron 焦点修复 ──
        // 事件保护必须绑定在控件本身，不能绑在父容器捕获阶段；
        // 否则事件可能到不了 textarea，表现为标题/正文输入框点不动。
        this.container.querySelectorAll('textarea,input,select,[contenteditable="true"],.rop-textarea,.rop-input,.rop-select,.rop-range,.rop-color').forEach(el => {
            if (el.dataset.ropEditorEventGuard === '1') return;
            el.dataset.ropEditorEventGuard = '1';
            const stopEditorEvent = (e) => {
                e.stopPropagation();
                if ((e.type === 'pointerdown' || e.type === 'mousedown') &&
                    (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT')) {
                    setTimeout(() => {
                        if (document.activeElement !== el && typeof el.focus === 'function') {
                            el.focus({ preventScroll: true });
                        }
                    }, 0);
                }
            };
            ['pointerdown', 'mousedown', 'mouseup', 'click', 'dblclick'].forEach(type => {
                el.addEventListener(type, stopEditorEvent);
            });
        });
        ['rop-title-text', 'rop-body-text', 'rop-footer-text'].forEach(id => {
            const el = this.container.querySelector('#' + id);
            if (!el || el.dataset.ropTextcardTextGuard === '1') return;
            el.dataset.ropTextcardTextGuard = '1';
            const forceTextcardTextFocus = (e) => {
                e.stopPropagation();
                if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
                setTimeout(() => {
                    if (document.activeElement !== el && typeof el.focus === 'function') {
                        el.focus({ preventScroll: true });
                    }
                }, 0);
            };
            ['pointerdown', 'mousedown', 'click'].forEach(type => {
                el.addEventListener(type, forceTextcardTextFocus);
            });
        });
        for (const fid of ['rop-title-override-w', 'rop-body-override-w', 'rop-footer-override-w']) {
            const el = this.container.querySelector('#' + fid);
            if (!el) continue;
            const markEdited = () => { el.dataset.userEdited = '1'; el.dataset.followContentWidth = '0'; };
            el.addEventListener('input', markEdited);
            el.addEventListener('change', markEdited);
        }
        const animTimingBindings = [
            ['rop-anim-duration', 'duration'],
            ['rop-anim-speed', 'speed'],
            ['rop-anim-timing-mode', 'mode'],
            ['rop-anim-start-x', 'points'],
            ['rop-anim-start-y', 'points'],
            ['rop-anim-end-x', 'points'],
            ['rop-anim-end-y', 'points'],
        ];
        for (const [fid, source] of animTimingBindings) {
            const el = this.container.querySelector('#' + fid);
            if (!el) continue;
            el.addEventListener('input', () => this._syncAnimTimingFields(source));
            el.addEventListener('change', () => this._syncAnimTimingFields(source));
        }

        // 自动适配模式下：文字位置Y 与 上下边距互斥
        const autoFitEl = this.container.querySelector('#rop-auto-fit');
        if (autoFitEl) {
            autoFitEl.addEventListener('input', () => this._syncTextcardAutoFitModeUI());
            autoFitEl.addEventListener('change', () => this._syncTextcardAutoFitModeUI());
        }
        const autoCenterEl = this.container.querySelector('#rop-auto-center');
        if (autoCenterEl) {
            autoCenterEl.addEventListener('input', () => this._syncTextcardAutoFitModeUI());
            autoCenterEl.addEventListener('change', () => this._syncTextcardAutoFitModeUI());
        }
        const cardEnabledEl = this.container.querySelector('#rop-card-enabled');
        if (cardEnabledEl) {
            cardEnabledEl.addEventListener('input', () => this._syncTextcardMaskEnabledUI());
            cardEnabledEl.addEventListener('change', () => this._syncTextcardMaskEnabledUI());
        }
        const applyAllEl = this.container.querySelector('#rop-card-apply-all');
        if (applyAllEl) {
            applyAllEl.addEventListener('change', () => {
                if (applyAllEl.checked && this._selectedOv && this._selectedOv.type === 'textcard') {
                    this._syncToOverlay();
                }
            });
        }
        const scrollApplyAllEl = this.container.querySelector('#rop-scroll-apply-all');
        if (scrollApplyAllEl) {
            scrollApplyAllEl.addEventListener('change', () => {
                if (scrollApplyAllEl.checked && this._selectedOv && this._selectedOv.type === 'scroll') {
                    this._syncToOverlay();
                }
            });
        }

        // 文字卡片位置/尺寸已独立使用 rop-card-*，不再与变换区做镜像，避免输入时序冲突

        // 滚动字幕时间字段 ↔ 主时间字段 双向同步
        const scrollStartTime = this.container.querySelector('#rop-scroll-start-time');
        const scrollEndTime = this.container.querySelector('#rop-scroll-end-time');
        const mainStart = this.container.querySelector('#rop-start');
        const mainEnd = this.container.querySelector('#rop-end');
        if (scrollStartTime && mainStart) {
            const syncStart = () => { mainStart.value = scrollStartTime.value; this._syncToOverlay('rop-scroll-start-time'); };
            scrollStartTime.addEventListener('input', syncStart);
            scrollStartTime.addEventListener('change', syncStart);
        }
        if (scrollEndTime && mainEnd) {
            const syncEnd = () => { mainEnd.value = scrollEndTime.value; this._syncToOverlay('rop-scroll-end-time'); };
            scrollEndTime.addEventListener('input', syncEnd);
            scrollEndTime.addEventListener('change', syncEnd);
        }

        // 文字卡片的“变换”面板会被隐藏，因此给它单独提供时间字段。
        // 同步到通用 start/end 后再写入覆层，确保卡片文字和背后的蒙版使用同一时间范围。
        const cardStartTime = this.container.querySelector('#rop-card-start');
        const cardEndTime = this.container.querySelector('#rop-card-end');
        const cardTimeLinked = this.container.querySelector('#rop-card-time-linked');
        const maskStartTime = this.container.querySelector('#rop-mask-start');
        const maskEndTime = this.container.querySelector('#rop-mask-end');
        const maskTimeFields = this.container.querySelector('#rop-mask-time-fields');
        const syncMaskTimeVisibility = () => {
            if (maskTimeFields) maskTimeFields.style.display = cardTimeLinked?.checked ? 'none' : '';
        };
        const syncCardTime = () => {
            if (!this._selectedOv || this._selectedOv.type !== 'textcard') return;
            if (mainStart && cardStartTime) mainStart.value = cardStartTime.value;
            if (mainEnd && cardEndTime) mainEnd.value = cardEndTime.value;
            this._selectedOv.card_time_linked = cardTimeLinked?.checked !== false;
            if (this._selectedOv.card_time_linked) {
                if (maskStartTime && cardStartTime) maskStartTime.value = cardStartTime.value;
                if (maskEndTime && cardEndTime) maskEndTime.value = cardEndTime.value;
            }
            this._selectedOv.mask_start = parseFloat(maskStartTime?.value || cardStartTime?.value) || 0;
            this._selectedOv.mask_end = parseFloat(maskEndTime?.value || cardEndTime?.value) || 9999;
            syncMaskTimeVisibility();
            this._syncToOverlay();
        };
        if (cardStartTime) {
            cardStartTime.addEventListener('input', syncCardTime);
            cardStartTime.addEventListener('change', syncCardTime);
        }
        if (cardEndTime) {
            cardEndTime.addEventListener('input', syncCardTime);
            cardEndTime.addEventListener('change', syncCardTime);
        }
        if (cardTimeLinked) {
            cardTimeLinked.addEventListener('change', syncCardTime);
        }
        if (maskStartTime) {
            maskStartTime.addEventListener('input', syncCardTime);
            maskStartTime.addEventListener('change', syncCardTime);
        }
        if (maskEndTime) {
            maskEndTime.addEventListener('input', syncCardTime);
            maskEndTime.addEventListener('change', syncCardTime);
        }

        // 移除导致死循环的自动修正 "起始偏移" 逻辑（允许独立调节保证顺畅）
        const animStartScaleSlider = this.container.querySelector('#rop-anim-start-scale');
        const animStartScaleVal = this.container.querySelector('#rop-anim-start-scale-val');
        if (animStartScaleSlider && animStartScaleVal) {
            animStartScaleSlider.addEventListener('input', () => { animStartScaleVal.textContent = animStartScaleSlider.value + '%'; });
        }
        const animEndScaleSlider = this.container.querySelector('#rop-anim-end-scale');
        const animEndScaleVal = this.container.querySelector('#rop-anim-end-scale-val');
        if (animEndScaleSlider && animEndScaleVal) {
            animEndScaleSlider.addEventListener('input', () => { animEndScaleVal.textContent = animEndScaleSlider.value + '%'; });
        }

        // Scroll speed slider removed — speed is auto-calculated from distance ÷ time

        const syncBoldToWeight = (boldId, weightId, boldValue = '700', normalValue = '400') => {
            const boldEl = this.container.querySelector('#' + boldId);
            const weightEl = this.container.querySelector('#' + weightId);
            if (!boldEl || !weightEl) return;
            boldEl.addEventListener('change', () => {
                const target = boldEl.checked ? boldValue : normalValue;
                if (Array.from(weightEl.options).some(o => o.value === target)) {
                    weightEl.value = target;
                }
                this._syncToOverlay();
            });
            weightEl.addEventListener('change', () => {
                const w = parseInt(weightEl.value || normalValue, 10);
                boldEl.checked = Number.isFinite(w) ? w >= 600 : false;
                this._syncToOverlay();
            });
        };
        syncBoldToWeight('rop-bold', 'rop-font-weight', '700', '400');
        syncBoldToWeight('rop-title-bold', 'rop-title-weight', '900', '400');
        syncBoldToWeight('rop-body-bold', 'rop-body-weight', '700', '400');
        syncBoldToWeight('rop-footer-bold', 'rop-footer-weight', '700', '400');
        syncBoldToWeight('rop-scroll-bold', 'rop-scroll-weight', '700', '400');


        const fontWeightPairs = [
            ['rop-font', 'rop-font-weight'],
            ['rop-title-font', 'rop-title-weight'],
            ['rop-body-font', 'rop-body-weight'],
            ['rop-footer-font', 'rop-footer-weight'],
            ['rop-scroll-font', 'rop-scroll-weight'],
            ['rop-scroll-title-font', 'rop-scroll-title-weight'],
        ];
        for (const [fontId, weightId] of fontWeightPairs) {
            const fontEl = this.container.querySelector('#' + fontId);
            if (!fontEl) continue;
            fontEl.addEventListener('change', async () => {
                if (window.getFontManager) {
                    const fm = getFontManager();
                    if (fm && typeof fm.loadGoogleFont === 'function') {
                        try { await fm.loadGoogleFont(fontEl.value); } catch (_) { }
                    }
                }
                this._refreshWeightOptions(weightId, fontEl.value);
            });
        }

        this._bindNumericInputEditing();

        // Slider ↔ Number readout bidirectional linking
        this.container.querySelectorAll('.rop-num-readout').forEach(numEl => {
            const linkId = numEl.dataset.link;
            if (!linkId) return;
            const rangeEl = this.container.querySelector('#' + linkId);
            if (!rangeEl) return;
            // Some numeric controls allow a wider range than their original slider.
            for (const key of ['min', 'max', 'step']) {
                if (numEl.getAttribute(key) != null) rangeEl.setAttribute(key, numEl.getAttribute(key));
            }
            // Range → Number
            rangeEl.addEventListener('input', () => { numEl.value = rangeEl.value; });
            // Number → Range
            numEl.addEventListener('input', () => { rangeEl.value = numEl.value; this._syncToOverlay(linkId); });
            numEl.addEventListener('change', () => { rangeEl.value = numEl.value; this._syncToOverlay(linkId); });
        });

        // Drag-to-scrub on number inputs (click+drag horizontally to adjust value)
        // 使用 Pointer Events + setPointerCapture，确保松开鼠标时 pointerup 一定能触发
        this.container.querySelectorAll('input.rop-input[type="number"], input.rop-num-readout[type="number"]').forEach(el => {
            el.style.cursor = 'ew-resize';
            el.style.touchAction = 'none';
            let dragging = false, startX = 0, startVal = 0;

            const onMove = (me) => {
                if (!dragging) return;
                const dx = me.clientX - startX;
                const speed = me.shiftKey ? 0.1 : 1;
                const step = parseFloat(el.step) || 1;
                el.value = Math.round((startVal + dx * speed * step) / step) * step;
                el.dispatchEvent(new Event('input', { bubbles: true }));
            };
            const onUp = (ue) => {
                if (!dragging) return;
                dragging = false;
                try { el.releasePointerCapture(ue.pointerId); } catch (_) {}
                el.removeEventListener('pointermove', onMove);
                el.removeEventListener('pointerup', onUp);
                el.removeEventListener('pointercancel', onUp);
            };

            el.addEventListener('pointerdown', (e) => {
                e.stopPropagation();
                // Allow clicking into input to type when already focused
                if (document.activeElement === el) return;
                dragging = true;
                startX = e.clientX;
                startVal = parseFloat(el.value) || 0;
                e.preventDefault();
                try { el.setPointerCapture(e.pointerId); } catch (_) {}
                el.addEventListener('pointermove', onMove);
                el.addEventListener('pointerup', onUp);
                el.addEventListener('pointercancel', onUp);
            });
            // Double-click to focus for manual typing
            el.addEventListener('dblclick', (e) => {
                e.preventDefault();
                el.focus();
                el.select();
                el.style.cursor = 'text';
            });
            el.addEventListener('blur', () => {
                el.style.cursor = 'ew-resize';
            });
            el.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { el.blur(); }
            });
        });


        // Per-parameter ↺ reset buttons
        this.container.querySelectorAll('.rop-reset-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                const targetId = btn.dataset.target;
                const el = this.container.querySelector('#' + targetId);
                if (!el) return;
                const def = el.dataset.default;
                if (def == null) return;
                this._val(targetId, def);
                if (['rop-title-override-w', 'rop-body-override-w', 'rop-footer-override-w'].includes(targetId)) {
                    el.dataset.followContentWidth = '1';
                    el.dataset.userEdited = '0';
                }
                this._syncToOverlay();
            });
        });

        // "Reset all" button — resets all rop-defaultable controls
        const resetAllBtn = this.container.querySelector('#rop-card-reset-all');
        if (resetAllBtn) {
            resetAllBtn.addEventListener('click', () => {
                if (!confirm('是否彻底恢复为新建卡片时的初始设置？')) return;
                window.ReelsOverviewBatch?.beginControl(this, 'rop-card-reset-all');
                
                // 1. Reset everything except weight
                this.container.querySelectorAll('.rop-defaultable').forEach(el => {
                    if (el.id && el.id.endsWith('-weight')) return; // skip weight for now
                    const def = el.dataset.default;
                    if (def == null) return;
                    
                    const val = (el.type === 'checkbox') ? (def === 'true') : def;
                    if (el.id) {
                        this._val(el.id, val);
                        if (['rop-title-override-w', 'rop-body-override-w', 'rop-footer-override-w'].includes(el.id)) {
                            el.dataset.followContentWidth = '1';
                            el.dataset.userEdited = '0';
                        }
                    } else {
                        if (el.type === 'checkbox') {
                            el.checked = val;
                        } else {
                            el.value = val;
                        }
                    }
                });

                // 2. Refresh weight options specifically so that 900/400 exist before selecting
                if (this._get('rop-title-font')) this._refreshWeightOptions('rop-title-weight', this._get('rop-title-font'));
                if (this._get('rop-body-font')) this._refreshWeightOptions('rop-body-weight', this._get('rop-body-font'));
                if (this._get('rop-footer-font')) this._refreshWeightOptions('rop-footer-weight', this._get('rop-footer-font'));
                if (this._get('rop-scroll-font')) this._refreshWeightOptions('rop-scroll-weight', this._get('rop-scroll-font'));
                if (this._get('rop-scroll-title-font')) this._refreshWeightOptions('rop-scroll-title-weight', this._get('rop-scroll-title-font'));

                // 3. Now apply weights safely
                this.container.querySelectorAll('.rop-defaultable').forEach(el => {
                    if (el.id && el.id.endsWith('-weight')) {
                        const def = el.dataset.default;
                        if (def != null) this._val(el.id, def);
                    }
                });

                this._syncToOverlay();
            });
        }

        // Card template buttons
        const saveTpl = this.container.querySelector('#rop-card-save-tpl');
        const loadTpl = this.container.querySelector('#rop-card-load-tpl');
        const delTpl = this.container.querySelector('#rop-card-del-tpl');
        const importTpl = this.container.querySelector('#rop-card-import-tpl');
        const exportTpl = this.container.querySelector('#rop-card-export-tpl');

        if (saveTpl) saveTpl.addEventListener('click', () => this._saveCardTemplate());
        if (loadTpl) loadTpl.addEventListener('click', () => this._loadCardTemplate());
        if (delTpl) delTpl.addEventListener('click', () => this._deleteCardTemplate());
        if (importTpl) importTpl.addEventListener('click', () => this._importCardTemplates());
        if (exportTpl) exportTpl.addEventListener('click', () => this._exportCardTemplates());

        this._refreshCardTemplateSelect();
        this._refreshTitleSchemeSelect();

        this._bindCustomBrushUpload('title');
        this._bindCustomBrushUpload('body');
        this._bindBrushVisualPicker('title');
        this._bindBrushVisualPicker('body');

        // 标题配色方案预设选择监听与操作
        const titleSchemeSelect = this.container.querySelector('#rop-title-scheme-select');
        if (titleSchemeSelect) {
            titleSchemeSelect.addEventListener('change', () => {
                const val = titleSchemeSelect.value;
                if (val) {
                    this._applyTitleColorScheme(val);
                }
            });
        }

        const titleSchemePaletteBtn = this.container.querySelector('#rop-title-scheme-palette-btn');
        if (titleSchemePaletteBtn) {
            titleSchemePaletteBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this._openTitleSchemeVisualPalette(titleSchemePaletteBtn);
            });
        }

        const titleSchemeSaveBtn = this.container.querySelector('#rop-title-scheme-save');
        if (titleSchemeSaveBtn) {
            titleSchemeSaveBtn.addEventListener('click', (e) => {
                e.preventDefault();
                this._saveTitleColorScheme();
            });
        }

        const titleSchemeImportBtn = this.container.querySelector('#rop-title-scheme-import');
        if (titleSchemeImportBtn) {
            titleSchemeImportBtn.addEventListener('click', (e) => {
                e.preventDefault();
                this._importTitleColorSchemes();
            });
        }

        const titleSchemeExportBtn = this.container.querySelector('#rop-title-scheme-export');
        if (titleSchemeExportBtn) {
            titleSchemeExportBtn.addEventListener('click', (e) => {
                e.preventDefault();
                this._exportTitleColorSchemes();
            });
        }

        const titleSchemeDelBtn = this.container.querySelector('#rop-title-scheme-del');
        if (titleSchemeDelBtn) {
            titleSchemeDelBtn.addEventListener('click', (e) => {
                e.preventDefault();
                this._deleteTitleColorScheme();
            });
        }

        const titleSchemePreview = this.container.querySelector('#rop-title-scheme-preview');
        if (titleSchemePreview) {
            titleSchemePreview.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this._openTitleSchemeVisualPalette(titleSchemePreview);
            });
        }

        // VideoCanvas 回调
        if (this.videoCanvas) {
            // 宿主（批量任务编辑器）会在此回调中把完整覆层栈写回 task。
            // 面板不能覆盖它，否则界面属性虽已更新，导出仍可能读取旧快照。
            const hostOnOverlayChange = this.videoCanvas.onOverlayChange;
            this.videoCanvas.onSelect = (ov) => this.selectOverlay(ov);
            this.videoCanvas.onDeselect = () => this.deselectOverlay();
            this.videoCanvas.onOverlayChange = (ov, change = {}) => {
                // 列表中的改名、显示开关和上下移动以前没有传 ov，导致这里
                // 读取 ov.type 时抛错，中断了把最新覆层顺序同步回任务的流程。
                // 空变更只需要由外层回调保存/重绘，不应把它当作某个覆层的属性变更。
                // 面板输入已经写入模型并同步了“应用到全部”。只有画布拖动等
                // 外部修改才需要反向刷新整套表单，避免每次输入重建控件和重复批量同步。
                if (ov && typeof ov === 'object' && change?.source !== this) {
                    if (ov === this._selectedOv) this._syncFromOverlay(ov);
                    const applyAllEl = this.container.querySelector('#rop-card-apply-all');
                    if (ov.type === 'textcard' && applyAllEl && applyAllEl.checked) {
                        this._applyTextcardStyleToAllTasks(ov);
                    }
                    const scrollApplyAllEl = this.container.querySelector('#rop-scroll-apply-all');
                    if (ov.type === 'scroll' && scrollApplyAllEl && scrollApplyAllEl.checked) {
                        this._applyScrollStyleToAllTasks(ov);
                    }
                }
                window.ReelsOverviewBatch?.modelChanged(this,ov);
                // 无覆层对象代表删除等栈级变更，仍必须通知宿主保存。
                if (typeof hostOnOverlayChange === 'function') hostOnOverlayChange.call(this.videoCanvas, ov);
            };
        }
    }

    _refreshAllBrushSelects() {
        const engine = window.ReelsOverlay?.ReelsBrushEngine;
        if (!engine) return;
        const customBrushes = typeof engine.getCustomBrushes === 'function' ? engine.getCustomBrushes() : {};
        const brushKeys = Object.keys(customBrushes);

        const selects = this.container.querySelectorAll('#rop-title-bg-brush-style, #rop-body-bg-brush-style, #rop-card-brush-style');
        selects.forEach(sel => {
            const curVal = sel.value;
            let customGroup = sel.querySelector('optgroup[data-custom-brush-group="1"]');
            if (!customGroup) {
                customGroup = document.createElement('optgroup');
                customGroup.label = '📂 我的背景图片';
                customGroup.dataset.customBrushGroup = '1';
                sel.appendChild(customGroup);
            }
            customGroup.innerHTML = '';
            brushKeys.forEach(k => {
                const item = customBrushes[k];
                const opt = document.createElement('option');
                opt.value = k;
                opt.textContent = `📁 ${item.displayName || k}`;
                customGroup.appendChild(opt);
            });
            if (curVal && sel.querySelector(`option[value="${curVal}"]`)) {
                sel.value = curVal;
            }
        });

        if (typeof window.reelsSyncBoxBrushSelect === 'function') {
            window.reelsSyncBoxBrushSelect();
        }
    }

    _bindBrushVisualPicker(prefix) {
        const button = this.container.querySelector(`#rop-${prefix}-brush-gallery-btn`);
        const select = this.container.querySelector(`#rop-${prefix}-bg-brush-style`);
        if (!button || !select) return;

        const close = () => {
            document.querySelectorAll('.rop-brush-gallery-popover').forEach(el => {
                el._restorePreview?.();
                el.remove();
            });
        };

        button.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            const existing = document.querySelector('.rop-brush-gallery-popover');
            if (existing) { existing._restorePreview?.(); existing.remove(); return; }

            // 与标题色板一致：图库悬停仅临时作用于左侧画布，离开／关闭恢复，点击才保存。
            const previewOverlay = this._selectedOv;
            const enabledKey = `${prefix}_bg_enabled`;
            const brushKey = `${prefix}_bg_brush`;
            const styleKey = `${prefix}_bg_brush_style`;
            const customDataKey = `${prefix}_custom_brush_data`;
            const preSnapshot = previewOverlay ? {
                [enabledKey]: previewOverlay[enabledKey],
                [brushKey]: previewOverlay[brushKey],
                [styleKey]: previewOverlay[styleKey],
                [customDataKey]: previewOverlay[customDataKey],
            } : null;
            let confirmed = false;
            const renderPreview = () => {
                if (typeof this.videoCanvas?.render === 'function') this.videoCanvas.render();
                else this._requestRender();
            };
            const restorePreview = () => {
                if (preSnapshot && this._selectedOv === previewOverlay) {
                    Object.assign(previewOverlay, preSnapshot);
                    if (preSnapshot[customDataKey] === undefined) delete previewOverlay[customDataKey];
                    renderPreview();
                }
            };

            const engine = window.ReelsOverlay?.ReelsBrushEngine;
            const customBrushes = engine?.getCustomBrushes?.() || {};
            const choices = [
                ...Object.entries(customBrushes).map(([value, item]) => ({
                    value,
                    label: item.displayName || value,
                    image: item.dataUrl || '',
                    custom: true,
                })),
            ];
            const popover = document.createElement('div');
            popover.className = 'rop-brush-gallery-popover';
            popover._restorePreview = () => { if (!confirmed) restorePreview(); };
            popover.style.cssText = 'position:fixed;z-index:9999999;display:grid;grid-template-columns:repeat(2,minmax(145px,1fr));gap:8px;width:min(380px,calc(100vw - 20px));max-height:360px;overflow:auto;padding:10px;background:#151923;border:1px solid #4d7fbd;border-radius:8px;box-shadow:0 12px 32px rgba(0,0,0,.55);';
            choices.forEach(choice => {
                const item = document.createElement('button');
                const selected = select.value === choice.value;
                item.type = 'button';
                item.title = choice.label;
                item.style.cssText = `display:flex;flex-direction:column;gap:5px;padding:6px;background:${selected ? '#1d4f81' : '#252b38'};border:1px solid ${selected ? '#61b9ff' : '#475166'};border-radius:6px;color:#fff;cursor:pointer;text-align:left;overflow:hidden;`;
                const image = document.createElement('img');
                image.alt = `${choice.label} 缩略图`;
                image.src = choice.image;
                image.style.cssText = 'display:block;width:100%;height:52px;object-fit:fill;background:linear-gradient(135deg,#355d87,#17202e);border-radius:3px;';
                image.onerror = () => { image.style.display = 'none'; };
                const label = document.createElement('span');
                label.textContent = `${choice.custom ? '📁 ' : ''}${choice.label}`;
                label.style.cssText = 'font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
                item.append(image, label);
                item.addEventListener('mouseenter', () => {
                    item.style.borderColor = '#61b9ff';
                    item.style.background = '#1d4f81';
                    if (previewOverlay && !confirmed) {
                        previewOverlay[enabledKey] = true;
                        previewOverlay[brushKey] = true;
                        previewOverlay[styleKey] = choice.value;
                        const customData = engine?.getCustomBrushData?.(choice.value);
                        if (customData) previewOverlay[customDataKey] = customData;
                        else delete previewOverlay[customDataKey];
                        renderPreview();
                    }
                });
                item.addEventListener('mouseleave', () => {
                    if (!selected) {
                        item.style.borderColor = '#475166';
                        item.style.background = '#252b38';
                    }
                    if (!confirmed) restorePreview();
                });
                item.addEventListener('click', () => {
                    confirmed = true;
                    const brushEnabled = this.container.querySelector(`#rop-${prefix}-bg-brush`);
                    if (brushEnabled) {
                        brushEnabled.checked = true;
                        brushEnabled.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                    select.value = choice.value;
                    select.dispatchEvent(new Event('change', { bubbles: true }));
                    this._syncToOverlay();
                    renderPreview();
                    close();
                });
                popover.appendChild(item);
            });
            document.body.appendChild(popover);
            const rect = button.getBoundingClientRect();
            const left = Math.min(Math.max(10, rect.right - popover.offsetWidth), window.innerWidth - popover.offsetWidth - 10);
            const top = Math.min(rect.bottom + 6, window.innerHeight - popover.offsetHeight - 10);
            popover.style.left = `${left}px`;
            popover.style.top = `${Math.max(10, top)}px`;
            // 点选缩略图时不能先把菜单移除；只有点到菜单外才关闭。
            setTimeout(() => document.addEventListener('pointerdown', (outsideEvent) => {
                if (!popover.contains(outsideEvent.target) && outsideEvent.target !== button) close();
            }, { once: true }), 0);
        });
    }

    _bindCustomBrushUpload(prefix) {
        const btnSingle = this.container.querySelector(`#rop-${prefix}-brush-upload-btn`);
        const btnFolder = this.container.querySelector(`#rop-${prefix}-brush-folder-btn`);
        const fileInput = this.container.querySelector(`#rop-${prefix}-brush-file-input`);
        const folderInput = this.container.querySelector(`#rop-${prefix}-brush-folder-input`);
        const select = this.container.querySelector(`#rop-${prefix}-bg-brush-style`);
        if (!select) return;

        this._refreshAllBrushSelects();

        if (btnSingle && fileInput) {
            btnSingle.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                fileInput.value = '';
                fileInput.click();
            });

            fileInput.addEventListener('change', () => {
                const file = fileInput.files && fileInput.files[0];
                if (!file) return;
                const cleanName = file.name.replace(/\.[^/.]+$/, '').trim() || ('custom_' + Date.now());
                const reader = new FileReader();
                reader.onload = (e) => {
                    const dataUrl = e.target.result;
                    if (window.ReelsOverlay?.ReelsBrushEngine) {
                        window.ReelsOverlay.ReelsBrushEngine.saveCustomBrush(cleanName, dataUrl, cleanName);
                    }
                    this._refreshAllBrushSelects();
                    select.value = cleanName;
                    const brushCheck = this.container.querySelector(`#rop-${prefix}-bg-brush`);
                    if (brushCheck) brushCheck.checked = true;

                    const ov = this._selectedOv || this.currentOverlay;
                    if (ov) {
                        select.dispatchEvent(new Event('change', { bubbles: true }));
                        if (typeof this.videoCanvas?.render === 'function') this.videoCanvas.render();
                        else if (this.mgr?.requestRender) this.mgr.requestRender();
                    }
                    if (typeof showToast === 'function') showToast(`背景图片「${cleanName}」导入成功！`, 'success');
                };
                reader.readAsDataURL(file);
            });
        }

        if (btnFolder && folderInput) {
            btnFolder.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                folderInput.value = '';
                folderInput.click();
            });

            folderInput.addEventListener('change', () => {
                const files = Array.from(folderInput.files || []).filter(f => /\.(png|jpe?g|webp|bmp|svg)$/i.test(f.name));
                if (files.length === 0) {
                    if (typeof showToast === 'function') showToast('所选文件夹内未检测到支持的图片格式 (PNG/JPG/WEBP)', 'warning');
                    return;
                }
                let importedCount = 0;
                let firstCleanName = null;
                let firstDataUrl = null;

                const readPromises = files.map(file => {
                    return new Promise((resolve) => {
                        const cleanName = file.name.replace(/\.[^/.]+$/, '').trim();
                        if (!cleanName) return resolve();
                        const reader = new FileReader();
                        reader.onload = (e) => {
                            const dataUrl = e.target.result;
                            if (window.ReelsOverlay?.ReelsBrushEngine) {
                                window.ReelsOverlay.ReelsBrushEngine.saveCustomBrush(cleanName, dataUrl, cleanName);
                            }
                            if (!firstCleanName) {
                                firstCleanName = cleanName;
                                firstDataUrl = dataUrl;
                            }
                            importedCount++;
                            resolve();
                        };
                        reader.onerror = () => resolve();
                        reader.readAsDataURL(file);
                    });
                });

                Promise.all(readPromises).then(() => {
                    this._refreshAllBrushSelects();
                    if (firstCleanName) {
                        select.value = firstCleanName;
                        const brushCheck = this.container.querySelector(`#rop-${prefix}-bg-brush`);
                        if (brushCheck) brushCheck.checked = true;

                        const ov = this._selectedOv || this.currentOverlay;
                        if (ov) {
                            select.dispatchEvent(new Event('change', { bubbles: true }));
                            if (typeof this.videoCanvas?.render === 'function') this.videoCanvas.render();
                            else if (this.mgr?.requestRender) this.mgr.requestRender();
                        }
                    }
                    if (typeof showToast === 'function') {
                        showToast(`🎉 成功从文件夹导入 ${importedCount} 张背景图片！`, 'success');
                    }
                });
            });
        }

        select.addEventListener('change', () => {
            if (select.value === 'custom') {
                if (fileInput) {
                    fileInput.value = '';
                    fileInput.click();
                }
                return;
            }
            const ov = this._selectedOv || this.currentOverlay;
            if (ov && window.ReelsOverlay?.ReelsBrushEngine) {
                const customData = window.ReelsOverlay.ReelsBrushEngine.getCustomBrushData(select.value);
                if (customData) {
                    ov[prefix + '_custom_brush_data'] = customData;
                } else {
                    delete ov[prefix + '_custom_brush_data'];
                }
                this._syncToOverlay();
                if (typeof this.videoCanvas?.render === 'function') this.videoCanvas.render();
                else if (this.mgr?.requestRender) this.mgr.requestRender();
            }
        });
    }

    // ═══════════════════════════════════════════════
    // 标题配色个人预设 (LocalStorage 持久化 + 导入导出)
    // ═══════════════════════════════════════════════

    _getTitleColorSchemes() {
        try {
            const raw = localStorage.getItem('reels_title_color_presets');
            const userSchemes = raw ? JSON.parse(raw) : null;
            const builtin = (typeof window !== 'undefined' && window.REELS_BUILTIN_TITLE_SCHEMES && typeof window.REELS_BUILTIN_TITLE_SCHEMES === 'object')
                ? window.REELS_BUILTIN_TITLE_SCHEMES
                : {};
            if (userSchemes && typeof userSchemes === 'object' && Object.keys(userSchemes).length > 0) {
                return { ...builtin, ...userSchemes };
            }
            return { ...builtin };
        } catch (e) {
            return (typeof window !== 'undefined' && window.REELS_BUILTIN_TITLE_SCHEMES && typeof window.REELS_BUILTIN_TITLE_SCHEMES === 'object')
                ? { ...window.REELS_BUILTIN_TITLE_SCHEMES }
                : {};
        }
    }

    _setTitleColorSchemes(data) {
        try {
            localStorage.setItem('reels_title_color_presets', JSON.stringify(data || {}));
        } catch (e) {
            console.error('保存标题配色预设失败:', e);
        }
    }

    _getPresetCategoryMeta(cfg) {
        if (!cfg || typeof cfg !== 'object') {
            return { hasBg: false, style: 'sans' };
        }

        // 1. 背景判断
        const hasBg = (cfg.pureText !== true && cfg.category !== '纯字无底')
            && ((cfg.titleBgEnabled && cfg.titleBgColor && cfg.titleBgColor !== 'transparent')
                || (cfg.titleBgColor && cfg.titleBgColor !== 'transparent')
                || ['底色搭配', '胶囊底条', 'strip', 'paired'].includes(cfg.category));

        // 2. 风格判断（渐变单独放，不需要区分有无衬线）
        const isGradient = !!(cfg.dualColor || cfg.gradient || cfg.titleGradient
            || (cfg.category && (cfg.category.includes('双色') || cfg.category === 'dual')));

        let style = 'sans';
        if (isGradient) {
            style = 'gradient';
        } else {
            const SCRIPT_FONTS = new Set([
                'Amatic SC', 'Patrick Hand', 'Kaushan Script', 'Pinyon Script', 'Kalam',
                'Dancing Script', 'Caveat', 'Great Vibes', 'Allura', 'Satisfy', 'Pacifico',
                'Permanent Marker', 'Knewave'
            ]);
            const SERIF_FONTS = new Set([
                'Playfair Display', 'Fraunces', 'Cinzel', 'Cinzel Decorative', 'Special Elite',
                'Pirata One', 'Rye', 'Cormorant Garamond', 'Merriweather', 'Libre Baskerville',
                'DM Serif Display', 'Lora', 'Bodoni Moda', 'Prata', 'Roboto Slab', 'Spectral',
                'Abril Fatface', 'Rozha One', 'Newsreader', 'Poltawski Nowy', 'Playfair Display SC',
                'Marcellus', 'Crimson Text', 'EB Garamond', 'Glook', 'Cormorant SC', 'Marcellus SC'
            ]);
            const font = cfg.font || '';
            const cat = cfg.category || '';
            if (SCRIPT_FONTS.has(font) || cat === 'script' || cat.includes('手写')) {
                style = 'script';
            } else if (SERIF_FONTS.has(font) || cat === 'serif' || cat.includes('衬线')) {
                style = 'serif';
            } else {
                style = 'sans';
            }
        }
        return { hasBg, style };
    }

    _refreshTitleSchemeSelect() {
        if (!this.container) return;
        const select = this.container.querySelector('#rop-title-scheme-select');
        if (!select) return;
        const currentVal = select.value;
        const schemes = this._getTitleColorSchemes();
        const schemeKeys = Object.keys(schemes);

        select.innerHTML = '<option value="">-- 选择个人配色预设 --</option>';
        if (schemeKeys.length === 0) {
            return;
        }

        const groupOrder = [
            { id: 'has_bg_script', label: '🏷️ 有背景 · ✍️ 手写' },
            { id: 'has_bg_serif', label: '🏷️ 有背景 · 🏛️ 衬线' },
            { id: 'has_bg_sans', label: '🏷️ 有背景 · 🔤 无衬线' },
            { id: 'no_bg_script', label: '✨ 无背景 · ✍️ 手写' },
            { id: 'no_bg_serif', label: '✨ 无背景 · 🏛️ 衬线' },
            { id: 'no_bg_sans', label: '✨ 无背景 · 🔤 无衬线' },
            { id: 'gradient', label: '🌈 渐变 / 双色对比' }
        ];

        const STYLE_LABEL = { script: '手写', serif: '衬线', sans: '无衬线', gradient: '' };
        let libKeys = new Set();
        try { const info = window.electronAPI?.getPresetLibraryInfo?.(); if (info?.ok) libKeys = new Set(info.color?.keys || []); } catch (_) { }
        const groupOf = (cfg) => {
            if (['单色字', '双色字', '带底色', '线条装饰'].includes(cfg.group)) return cfg.group;
            const meta = this._getPresetCategoryMeta(cfg);
            if (meta.style === 'gradient') return '双色字';
            return meta.hasBg ? '带底色' : '单色字';
        };
        groupOrder.length = 0;
        const GROUPS = ['单色字', '双色字', '带底色', '线条装饰'];
        for (const [sec, secLabel] of [['mine', '⭐ 我的预设'], ['lib', '📚 预设库'], ['builtin', '内置']]) {
            for (const g of GROUPS) {
                for (const st of ['serif', 'sans', 'script']) groupOrder.push({ id: `${sec}_${g}_${st}`, label: `${secLabel} › ${g} · ${STYLE_LABEL[st]}` });
            }
        }

        const grouped = {};
        groupOrder.forEach(g => { grouped[g.id] = []; });

        for (const [key, cfg] of Object.entries(schemes)) {
            const meta = this._getPresetCategoryMeta(cfg);
            const st = meta.style === 'gradient' ? (/serif|衬线/i.test(cfg.category || '') ? 'serif' : 'sans') : meta.style;
            const builtinMap = window.REELS_BUILTIN_TITLE_SCHEMES || {};
            const sec = libKeys.has(key) ? 'lib' : (key in builtinMap && JSON.stringify(builtinMap[key]) === JSON.stringify(cfg)) ? 'builtin' : 'mine';
            const gId = `${sec}_${groupOf(cfg)}_${st}`;
            if (!grouped[gId]) grouped[gId] = [];
            grouped[gId].push({ key, cfg });
        }
        Object.values(grouped).forEach(list => list.sort((a, b) => String(a.cfg.name || a.key).localeCompare(String(b.cfg.name || b.key), 'zh')));

        for (const g of groupOrder) {
            const items = grouped[g.id];
            if (!items || items.length === 0) continue;
            const groupEl = document.createElement('optgroup');
            groupEl.label = `${g.label} (${items.length})`;
            for (const { key, cfg } of items) {
                const opt = document.createElement('option');
                opt.value = key;
                opt.textContent = cfg.name || key;
                groupEl.appendChild(opt);
            }
            select.appendChild(groupEl);
        }

        if (currentVal && schemes[currentVal]) {
            select.value = currentVal;
        }
    }

    async _saveTitleColorScheme() {
        if (!this._selectedOv || this._selectedOv.type !== 'textcard') {
            alert('请先在画布或列表中选择一个文字卡片覆层');
            return;
        }
        const select = this.container.querySelector('#rop-title-scheme-select');
        const defaultName = select?.value && this._getTitleColorSchemes()[select.value]
            ? this._getTitleColorSchemes()[select.value].name
            : '';
        const name = await this._showCardTemplateNameDialog(defaultName);
        if (!name) return;

        const ov = this._selectedOv;
        const colorVal = (ov.title_color || '#FFFFFF').trim();
        let dualColor = false;
        let titleColor = colorVal;
        let titleColor2 = '';

        if (colorVal.includes(',')) {
            const parts = colorVal.split(',').map(s => s.trim());
            if (parts.length >= 2) {
                dualColor = true;
                titleColor = parts[0];
                titleColor2 = parts[1];
            }
        }

        const schemeId = `custom_${Date.now()}`;
        const newScheme = {
            id: schemeId,
            name: name,
            category: 'custom',
            font: ov.title_font_family || 'Montserrat',
            weight: parseInt(ov.title_font_weight || 700, 10),
            titleColor: titleColor,
            dualColor: dualColor,
            pureText: !ov.title_bg_enabled && !ov.title_deco_enabled,
        };
        // 记录当前字号，配合色板“应用字号”开关使用
        const savedFontSize = Number(ov.title_fontsize) || 0;
        if (savedFontSize > 0) newScheme.titleFontSize = savedFontSize;
        if (dualColor) {
            newScheme.titleColor2 = titleColor2;
            newScheme.titleGradientDirection = ov.title_gradient_direction || 'vertical';
        }
        if (ov.title_bg_enabled) {
            newScheme.titleBgEnabled = true;
            newScheme.titleBgColor = ov.title_bg_color || '#111111';
            // 渐变底色：拆成两个色值 + 方向保存
            const bgParts = String(newScheme.titleBgColor).split(',').map(s => s.trim()).filter(Boolean);
            if (bgParts.length >= 2) {
                newScheme.titleBgColor = bgParts[0];
                newScheme.titleBgColor2 = bgParts[1];
                newScheme.titleBgGradientDirection = ov.title_bg_gradient_direction || 'horizontal';
                newScheme.gradient = true;
            }
            newScheme.titleBgMode = ov.title_bg_mode || 'block';
            if (ov.title_bg_radius !== undefined) newScheme.titleBgRadius = Number(ov.title_bg_radius) || 0;
            newScheme.titleBgBorderEnabled = !!ov.title_bg_border_enabled;
            if (ov.title_bg_border_enabled) {
                newScheme.titleBgBorderColor = ov.title_bg_border_color || '#FFFFFF';
                newScheme.titleBgBorderWidth = Number(ov.title_bg_border_width) || 3;
                newScheme.titleBgBorderStyle = ov.title_bg_border_style || 'solid';
                newScheme.titleBgBorderOpacity = ov.title_bg_border_opacity ?? 100;
            }
            if (ov.title_bg_brush) {
                newScheme.titleBgBrush = true;
                newScheme.titleBgBrushStyle = ov.title_bg_brush_style || 'brush1';
            }
        }
        // 个人另存必须保留阴影的真实开关状态。颜色控件即使阴影关闭时
        // 也会有默认黑色，不能把“有颜色”误判成需要发光。
        newScheme.titleShadowColor = ov.title_shadow_color || '#000000';
        newScheme.titleShadowBlur = Number(ov.title_shadow_blur) || 0;
        newScheme.titleShadowX = Number(ov.title_shadow_x) || 0;
        newScheme.titleShadowY = Number(ov.title_shadow_y) || 0;
        if (ov.title_deco_enabled) {
            newScheme.decoLine = true;
            newScheme.decoColor = ov.title_deco_color || '#FFD700';
        }

        // 不能把“内置 + 个人”的合并视图整包再写回 localStorage。内置方案
        // 数量较多，写入失败时旧代码吞掉异常却仍弹“保存成功”，造成用户
        // 看起来另存了、色板里却找不到。这里只持久化真正属于用户的项，
        // 并立即回读验证本次写入。
        try {
            const raw = localStorage.getItem('reels_title_color_presets');
            const personalSchemes = raw ? JSON.parse(raw) : {};
            if (!personalSchemes || typeof personalSchemes !== 'object') throw new Error('个人配色预设数据格式无效');
            // 旧版本可能已把整套内置方案复制进个人存储。删除完全相同的
            // 内置副本，既保留用户改写过的同名方案，也显著降低配额风险。
            const builtin = window.REELS_BUILTIN_TITLE_SCHEMES || {};
            Object.keys(personalSchemes).forEach(key => {
                if (builtin[key] && JSON.stringify(personalSchemes[key]) === JSON.stringify(builtin[key])) delete personalSchemes[key];
            });
            personalSchemes[schemeId] = newScheme;
            localStorage.setItem('reels_title_color_presets', JSON.stringify(personalSchemes));
            const verified = JSON.parse(localStorage.getItem('reels_title_color_presets') || '{}');
            if (!verified?.[schemeId]) throw new Error('保存后校验失败');
        } catch (error) {
            console.error('保存个人配色预设失败:', error);
            alert(`❌ 个人配色预设未保存：${error?.message || error}`);
            return;
        }
        this._refreshTitleSchemeSelect();
        if (select) select.value = schemeId;
        this._applyTitleColorScheme(schemeId);
        alert(`✅ 个人配色预设 "${name}" 已保存`);
    }

    async _deleteTitleColorScheme() {
        const select = this.container.querySelector('#rop-title-scheme-select');
        if (!select || !select.value) {
            alert('请先在下拉列表中选择要删除的个人配色预设');
            return;
        }
        const key = select.value;
        const schemes = this._getTitleColorSchemes();
        const scheme = schemes[key];
        const name = scheme ? scheme.name : key;
        if (!confirm(`确定要删除个人配色预设 "${name}" 吗？`)) return;

        delete schemes[key];
        this._setTitleColorSchemes(schemes);
        this._refreshTitleSchemeSelect();
        if (select) select.value = '';
        const previewEl = this.container.querySelector('#rop-title-scheme-preview');
        if (previewEl) previewEl.style.display = 'none';
        alert(`✅ 个人预设 "${name}" 已删除`);
    }

    _exportTitleColorSchemes() {
        const schemes = this._getTitleColorSchemes();
        const count = Object.keys(schemes).length;
        if (count === 0) {
            alert('当前没有可导出的个人配色预设。');
            return;
        }
        const json = JSON.stringify(schemes, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `标题颜色配色方案完整库_个人预设_${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(a.href);
    }

    _importTitleColorSchemes(onComplete) {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.onchange = (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (re) => {
                try {
                    const parsed = JSON.parse(re.target.result);
                    let importedSchemes = {};

                    if (Array.isArray(parsed)) {
                        parsed.forEach((item, idx) => {
                            if (item && (item.titleColor || item.title_color || item.name)) {
                                const id = item.id || `imported_${Date.now()}_${idx}`;
                                importedSchemes[id] = {
                                    id,
                                    name: item.name || `预设 ${idx + 1}`,
                                    font: item.font || item.title_font_family || 'Montserrat',
                                    weight: item.weight || item.title_font_weight || 700,
                                    titleColor: item.titleColor || item.title_color || '#FFFFFF',
                                    titleColor2: item.titleColor2 || '',
                                    dualColor: !!(item.dualColor || (item.titleColor && item.titleColor2)),
                                    pureText: item.pureText !== undefined ? item.pureText : true,
                                    category: item.category || 'custom',
                                    ...item
                                };
                            }
                        });
                    } else if (typeof parsed === 'object' && parsed !== null) {
                        for (const [k, v] of Object.entries(parsed)) {
                            if (!v || typeof v !== 'object') continue;
                            if (v.titleColor || v.textColor || v.name) {
                                importedSchemes[k] = { id: k, ...v };
                            } else if (Array.isArray(v.overlays) || Array.isArray(v)) {
                                const list = Array.isArray(v.overlays) ? v.overlays : v;
                                const tc = list.find(o => o && o.type === 'textcard');
                                if (tc) {
                                    const col = (tc.title_color || '#FFFFFF').trim();
                                    const isDual = col.includes(',');
                                    const parts = isDual ? col.split(',').map(s => s.trim()) : [col];
                                    const fontRaw = (tc.title_font_family || 'Montserrat').split(',')[0].replace(/['"]/g, '').trim();

                                    const scriptFonts = ['Amatic SC', 'Permanent Marker', 'Dancing Script', 'Caveat', 'Kalam', 'Patrick Hand', 'Kaushan Script', 'Pinyon Script', 'Lilita One'];
                                    const serifFonts = ['Cinzel Decorative', 'Cinzel', 'Playfair Display', 'EB Garamond', 'Fraunces'];
                                    let cat = 'creative';
                                    if (k.includes('139') || k.includes('163') || (tc.name && (tc.name.includes('139') || tc.name.includes('163')))) {
                                        cat = 'strip';
                                    } else if (scriptFonts.some(f => fontRaw.toLowerCase().includes(f.toLowerCase()))) {
                                        cat = 'script';
                                    } else if (serifFonts.some(f => fontRaw.toLowerCase().includes(f.toLowerCase()))) {
                                        cat = 'serif';
                                    }

                                    importedSchemes[`extract_${k}`] = {
                                        id: `extract_${k}`,
                                        name: tc.name || k,
                                        font: fontRaw,
                                        weight: tc.title_font_weight || 700,
                                        titleColor: parts[0],
                                        titleColor2: parts[1] || '',
                                        dualColor: isDual,
                                        pureText: !tc.title_bg_enabled && !tc.title_deco_enabled,
                                        titleBgEnabled: !!tc.title_bg_enabled,
                                        titleBgColor: tc.title_bg_color || '#111111',
                                        titleBgMode: tc.title_bg_mode || 'block',
                                        opacity: tc.title_bg_opacity || 95,
                                        decoLine: !!tc.title_deco_enabled,
                                        decoColor: tc.title_deco_color || '#FFD700',
                                        category: cat
                                    };
                                }
                            }
                        }
                    }

                    const importedCount = Object.keys(importedSchemes).length;
                    if (importedCount === 0) {
                        alert('未能从该文件中识别出有效的配色预设。');
                        return;
                    }

                    const schemes = this._getTitleColorSchemes();
                    let added = 0;
                    let overwritten = 0;
                    for (const [k, v] of Object.entries(importedSchemes)) {
                        if (schemes[k]) {
                            overwritten++;
                        } else {
                            added++;
                        }
                        schemes[k] = v;
                    }

                    this._setTitleColorSchemes(schemes);
                    this._refreshTitleSchemeSelect();
                    if (typeof onComplete === 'function') {
                        onComplete();
                    }
                    alert(`✅ 导入成功：新增 ${added} 套，覆盖更新 ${overwritten} 套个人配色预设。`);
                } catch (err) {
                    console.error('导入配色预设出错:', err);
                    alert('导入失败，请确保文件是有效的 JSON 格式。');
                }
            };
            reader.readAsText(file);
        };
        input.click();
    }

    /** 渐变方向 → CSS linear-gradient 角度 */
    _gradientCssAngle(dir) {
        if (dir === 'horizontal') return 'to right';
        if (dir === 'diagonal') return '135deg';
        if (dir === 'diagonal-up') return '45deg';
        return 'to bottom';
    }

    /**
     * 色板预设的标题底色描边字段。
     * 预设指定了 titleBgBorderEnabled → 按预设设置；
     * 预设没有描边、但当前描边是上一个预设带来的 → 关闭（用户手动开的描边保留）。
     */
    _titleSchemeBorderFields(cfg, ov) {
        const fields = {};
        if (cfg && cfg.titleBgBorderEnabled !== undefined) {
            Object.assign(fields, {
                title_bg_border_enabled: !!cfg.titleBgBorderEnabled,
                title_bg_border_color: cfg.titleBgBorderColor || '#FFFFFF',
                title_bg_border_width: Number(cfg.titleBgBorderWidth) || 3,
                title_bg_border_style: cfg.titleBgBorderStyle || 'solid',
                title_bg_border_opacity: cfg.titleBgBorderOpacity ?? 100,
                _preset_border: !!cfg.titleBgBorderEnabled,
            });
        } else if (ov && ov._preset_border) {
            Object.assign(fields, { title_bg_border_enabled: false, _preset_border: false });
        }
        if (cfg && cfg.titleBgRadius !== undefined) fields.title_bg_radius = Number(cfg.titleBgRadius) || 0;
        return fields;
    }

    _applyTitleColorScheme(schemeId, options = {}) {
        if(window.ReelsOverviewBatch?.isSelectedScope() && !window.ReelsOverviewBatch.isSampling()){window.showToast?.('批量模式请先在色板中选择预设，再点击上方分配按钮','warning');return;}
        if(this._selectedOv?.type!=='textcard'){window.showToast?.('请先选中已有的文字卡片，再应用配色','warning');return;}
        const cfg = this._getTitleColorSchemes()[schemeId];
        if (!cfg) return;
        const onlyColor = options.onlyColor === true;
        const onlyFont = options.onlyFont === true;
        const ignoreBackground = options.ignoreBackground === true;
        const applyFont = !onlyColor;
        const applyColor = !onlyFont;
        // “仅应用颜色/字体”都不应改动版式背景；完整应用时才可由
        // “忽略背景”单独阻止背景、笔刷和发光的更新。
        const applyBackground = !onlyColor && !onlyFont && !ignoreBackground;
        const applyDecoration = !onlyColor && !onlyFont;
        // “应用字号”开关：只有色板里存了字号才生效，否则保持当前字号
        const schemeFontSize = Number(cfg.titleFontSize) || 0;
        if (options.applyFontSize === true && !onlyColor && schemeFontSize > 0) {
            this._val('rop-title-fontsize', schemeFontSize);
            if (this._selectedOv) this._selectedOv.title_fontsize = schemeFontSize;
        }

        // 1. 设置标题字体（若方案指定）
        if (applyFont && cfg.font) {
            const fontEl = this.container.querySelector('#rop-title-font');
            if (fontEl) {
                let fontOptionFound = false;
                for (let i = 0; i < fontEl.options.length; i++) {
                    if (fontEl.options[i].value.toLowerCase() === cfg.font.toLowerCase()) {
                        fontEl.selectedIndex = i;
                        fontOptionFound = true;
                        break;
                    }
                }
                if (!fontOptionFound) {
                    const opt = new Option(cfg.font, cfg.font);
                    fontEl.add(opt);
                    fontEl.value = cfg.font;
                }
                if (window.getFontManager) {
                    const fm = getFontManager();
                    if (fm && typeof fm.loadGoogleFont === 'function') {
                        fm.loadGoogleFont(cfg.font).catch(() => {});
                    }
                }
                this._refreshWeightOptions('rop-title-weight', cfg.font);
            }
            if (this._selectedOv) {
                this._selectedOv.title_font_family = cfg.font;
            }
        }

        // 2. 设置标题字重与粗体
        if (applyFont && cfg.weight) {
            this._val('rop-title-weight', cfg.weight);
            this._val('rop-title-bold', cfg.weight >= 600);
            if (this._selectedOv) {
                this._selectedOv.title_font_weight = cfg.weight;
                this._selectedOv.title_bold = cfg.weight >= 600;
            }
        }

        // 3. 设置标题文字颜色 (支持纯色与双色渐变)
        if (applyColor && cfg.dualColor) {
            const dualTitleColor = `${cfg.titleColor}, ${cfg.titleColor2}`;
            const textDir = cfg.titleGradientDirection || 'vertical';
            const titleColEl = this.container.querySelector('#rop-title-color');
            if (titleColEl) {
                titleColEl.dataset.gradientDirection = textDir;
                titleColEl.dataset.gradientValue = dualTitleColor;
                titleColEl.classList.add('vk-has-gradient');
                titleColEl.style.setProperty('--vk-gradient-preview', `linear-gradient(${this._gradientCssAngle(textDir)}, ${cfg.titleColor}, ${cfg.titleColor2})`);
            }
            this._val('rop-title-color', dualTitleColor);
            if (this._selectedOv) {
                this._selectedOv.title_color = dualTitleColor;
                this._selectedOv.title_gradient_direction = textDir;
            }
        } else if (applyColor) {
            const titleColor = cfg.titleColor || cfg.textColor;
            if (titleColor) {
                const titleColEl = this.container.querySelector('#rop-title-color');
                if (titleColEl) {
                    delete titleColEl.dataset.gradientDirection;
                    delete titleColEl.dataset.gradientValue;
                    titleColEl.classList.remove('vk-has-gradient');
                    titleColEl.style.removeProperty('--vk-gradient-preview');
                }
                this._val('rop-title-color', titleColor);
                if (this._selectedOv) {
                    this._selectedOv.title_color = titleColor;
                    this._selectedOv.title_gradient_direction = 'horizontal';
                }
            }
        }

        // 5. 处理装饰线条 (若方案明确指定 decoLine 则开启并应用装饰线，其余方案保留用户原有的装饰线设置)
        if (applyDecoration && cfg.decoLine) {
            this._val('rop-title-deco-enabled', true);
            if (cfg.decoColor) {
                this._val('rop-title-deco-color', cfg.decoColor);
            }
            if (this._selectedOv) {
                this._selectedOv.title_deco_enabled = true;
                if (cfg.decoColor) {
                    this._selectedOv.title_deco_color = cfg.decoColor;
                }
            }
            const curPos = this._get('rop-title-deco-position');
            if (!curPos) {
                this._val('rop-title-deco-position', 'bottom');
                if (this._selectedOv) this._selectedOv.title_deco_position = 'bottom';
            }
            const curStyle = this._get('rop-title-deco-style');
            if (!curStyle) {
                this._val('rop-title-deco-style', 'solid');
                if (this._selectedOv) this._selectedOv.title_deco_style = 'solid';
            }
            const curThickness = parseInt(this._get('rop-title-deco-thickness') || 0, 10);
            if (curThickness <= 0) {
                this._val('rop-title-deco-thickness', 3);
                if (this._selectedOv) this._selectedOv.title_deco_thickness = 3;
            }
            const curOpacity = parseInt(this._get('rop-title-deco-opacity') || 0, 10);
            if (curOpacity <= 0) {
                this._val('rop-title-deco-opacity', 100);
                if (this._selectedOv) this._selectedOv.title_deco_opacity = 100;
            }
        }

        // 6. 处理标题底色、笔刷与发光效果
        if (applyBackground && (cfg.pureText || cfg.decoLine)) {
            this._val('rop-title-bg-enabled', false);
            this._val('rop-title-bg-brush', false);
            if (this._selectedOv) {
                this._selectedOv.title_bg_enabled = false;
                this._selectedOv.title_bg_brush = false;
            }
        } else if (applyBackground) {
            const baseBgColor = cfg.titleBgColor || cfg.bgColor;
            const bgGradDir = cfg.titleBgGradientDirection || 'horizontal';
            const titleBgColor = baseBgColor && cfg.titleBgColor2 ? `${baseBgColor}, ${cfg.titleBgColor2}` : baseBgColor;
            if (titleBgColor) {
                this._val('rop-title-bg-enabled', true);
                const titleBgColEl = this.container.querySelector('#rop-title-bg-color');
                if (titleBgColEl) {
                    delete titleBgColEl.dataset.gradientDirection;
                    delete titleBgColEl.dataset.gradientValue;
                    titleBgColEl.classList.remove('vk-has-gradient');
                    titleBgColEl.style.removeProperty('--vk-gradient-preview');
                    // 渐变底色：先写方向，_val 会据此生成预览
                    if (cfg.titleBgColor2) titleBgColEl.dataset.gradientDirection = bgGradDir;
                }
                this._val('rop-title-bg-color', titleBgColor);
                if (this._selectedOv && cfg.titleBgColor2) this._selectedOv.title_bg_gradient_direction = bgGradDir;
                if (cfg.opacity !== undefined) {
                    this._val('rop-title-bg-opacity', cfg.opacity);
                } else {
                    const curTitleBgOp = parseInt(this._get('rop-title-bg-opacity') || 0, 10);
                    if (curTitleBgOp <= 0) {
                        this._val('rop-title-bg-opacity', 95);
                    }
                }
                const curRadius = parseInt(this._get('rop-title-bg-radius') || 0, 10);
                if (curRadius <= 0) {
                    this._val('rop-title-bg-radius', 12);
                }
                if (this._selectedOv) {
                    this._selectedOv.title_bg_enabled = true;
                    this._selectedOv.title_bg_color = titleBgColor;
                    this._selectedOv.title_bg_opacity = cfg.opacity !== undefined ? cfg.opacity : 95;
                }
                // 描边与圆角
                const borderFields = this._titleSchemeBorderFields(cfg, this._selectedOv);
                const controlMap = {
                    title_bg_border_enabled: 'rop-title-bg-border-enabled',
                    title_bg_border_color: 'rop-title-bg-border-color',
                    title_bg_border_width: 'rop-title-bg-border-width',
                    title_bg_border_style: 'rop-title-bg-border-style',
                    title_bg_border_opacity: 'rop-title-bg-border-opacity',
                    title_bg_radius: 'rop-title-bg-radius',
                };
                for (const [field, value] of Object.entries(borderFields)) {
                    if (controlMap[field]) this._val(controlMap[field], value);
                }
                if (this._selectedOv) Object.assign(this._selectedOv, borderFields);
            }

            // 处理 strip 胶囊 / 笔刷 / 霓虹发光
            if (cfg.titleBgBrush) {
                this._val('rop-title-bg-brush', true);
                this._val('rop-title-bg-brush-style', cfg.titleBgBrushStyle || 'brush1');
                if (this._selectedOv) {
                    this._selectedOv.title_bg_brush = true;
                    this._selectedOv.title_bg_brush_style = cfg.titleBgBrushStyle || 'brush1';
                }
            } else {
                this._val('rop-title-bg-brush', false);
                if (this._selectedOv) {
                    this._selectedOv.title_bg_brush = false;
                }
            }
            if (cfg.titleBgMode) {
                this._val('rop-title-bg-mode', cfg.titleBgMode);
                if (this._selectedOv) {
                    this._selectedOv.title_bg_mode = cfg.titleBgMode;
                }
            }
        }

        // 个人另存带有完整阴影值时必须逐项还原（模糊 0 即关闭）。这段
        // 放在背景分支之外，纯文字和带装饰线的个人方案也同样严格还原。
        if (applyBackground && Object.prototype.hasOwnProperty.call(cfg, 'titleShadowBlur')) {
            this._val('rop-title-shadow-color', cfg.titleShadowColor || '#000000');
            this._val('rop-title-shadow-blur', cfg.titleShadowBlur);
            this._val('rop-title-shadow-x', cfg.titleShadowX ?? 0);
            this._val('rop-title-shadow-y', cfg.titleShadowY ?? 0);
            if (this._selectedOv) {
                this._selectedOv.title_shadow_color = cfg.titleShadowColor || '#000000';
                this._selectedOv.title_shadow_blur = cfg.titleShadowBlur;
                this._selectedOv.title_shadow_x = cfg.titleShadowX ?? 0;
                this._selectedOv.title_shadow_y = cfg.titleShadowY ?? 0;
            }
        } else if (applyBackground && cfg.glowColor && cfg.category !== 'custom') {
            // 旧内置“霓虹发光”预设兼容逻辑。
            this._val('rop-title-shadow-color', cfg.glowColor);
            this._val('rop-title-shadow-blur', 12);
            if (this._selectedOv) {
                this._selectedOv.title_shadow_color = cfg.glowColor;
                this._selectedOv.title_shadow_blur = 12;
            }
        }

        // 8. 更新配色预览指示色块
        const previewEl = this.container.querySelector('#rop-title-scheme-preview');
        if (previewEl) {
            if (cfg.dualColor) {
                previewEl.style.display = 'inline-flex';
                previewEl.style.alignItems = 'center';
                previewEl.style.justifyContent = 'center';
                previewEl.style.background = cfg.titleBgColor2
                    ? `linear-gradient(${this._gradientCssAngle(cfg.titleBgGradientDirection || 'horizontal')}, ${cfg.titleBgColor}, ${cfg.titleBgColor2})`
                    : `linear-gradient(135deg, ${cfg.titleColor} 50%, ${cfg.titleColor2} 50%)`;
                previewEl.style.color = '#111';
                previewEl.style.fontSize = '10.5px';
                previewEl.style.fontWeight = 'bold';
                previewEl.style.border = '1px solid rgba(255,255,255,0.4)';
                previewEl.style.borderBottom = '1px solid rgba(255,255,255,0.4)';
                previewEl.textContent = 'Aa';
                previewEl.title = `双色标题: ${cfg.name} (${cfg.titleColor} + ${cfg.titleColor2}) - 点击打开视觉色板`;
            } else if (cfg.decoLine) {
                previewEl.style.display = 'inline-flex';
                previewEl.style.alignItems = 'center';
                previewEl.style.justifyContent = 'center';
                previewEl.style.background = '#0e1017';
                previewEl.style.color = cfg.titleColor || '#fff';
                previewEl.style.fontSize = '10.5px';
                previewEl.style.fontWeight = 'bold';
                previewEl.style.border = '1px solid rgba(255,255,255,0.3)';
                previewEl.style.borderBottom = `3px solid ${cfg.decoColor}`;
                previewEl.textContent = 'Aa';
                previewEl.title = `排版装饰: ${cfg.name} (主色 ${cfg.titleColor} + 饰线 ${cfg.decoColor}) - 点击打开视觉色板`;
            } else if (cfg.pureText) {
                previewEl.style.display = 'inline-flex';
                previewEl.style.alignItems = 'center';
                previewEl.style.justifyContent = 'center';
                previewEl.style.background = '#0e1017';
                previewEl.style.color = cfg.titleColor || '#fff';
                previewEl.style.fontSize = '10.5px';
                previewEl.style.fontWeight = 'bold';
                previewEl.style.border = '1px solid rgba(255,255,255,0.3)';
                previewEl.style.borderBottom = '1px solid rgba(255,255,255,0.3)';
                previewEl.textContent = 'Aa';
                previewEl.title = `纯文字: ${cfg.titleColor} (无背景) - 点击打开视觉色板`;
            } else if (cfg.titleBgColor) {
                previewEl.style.display = 'inline-flex';
                previewEl.style.alignItems = 'center';
                previewEl.style.justifyContent = 'center';
                previewEl.style.background = cfg.titleBgColor2
                    ? `linear-gradient(${this._gradientCssAngle(cfg.titleBgGradientDirection || 'horizontal')}, ${cfg.titleBgColor}, ${cfg.titleBgColor2})`
                    : cfg.titleBgColor;
                previewEl.style.color = cfg.titleColor || '#000';
                previewEl.style.fontSize = '10.5px';
                previewEl.style.fontWeight = 'bold';
                previewEl.style.border = `1px solid ${cfg.titleColor || '#666'}`;
                previewEl.style.borderBottom = `1px solid ${cfg.titleColor || '#666'}`;
                previewEl.textContent = 'Aa';
                previewEl.title = `标题字: ${cfg.titleColor} | 标题底: ${cfg.titleBgColor} - 点击打开视觉色板`;
            } else {
                previewEl.style.display = 'none';
            }
        }

        // 9. 立即同步到覆层并重绘
        this._syncToOverlay();
        if (typeof this.videoCanvas?.render === 'function') {
            this.videoCanvas.render();
        } else if (this.mgr?.requestRender) {
            this.mgr.requestRender();
        }
        if (typeof this.videoCanvas?.onOverlayChange === 'function' && this._selectedOv) {
            this.videoCanvas.onOverlayChange(this._selectedOv);
        }
        const applyAllEl = this.container.querySelector('#rop-card-apply-all');
        if (this._selectedOv?.type === 'textcard' && applyAllEl && applyAllEl.checked) {
            this._applyTitleStyleToAllTasks(this._selectedOv);
        }
    }

    _openTitleSchemeVisualPalette(anchorEl) {
        window.ReelsOverviewBatch?.paletteOpened(this);
        const existing = document.querySelector('.rop-title-palette-popover');
        if (existing) { if(existing._closePalette)existing._closePalette();else existing.remove();return; }

        const ov = this._selectedOv;
        const preSnapshot = ov ? {
            title_color: ov.title_color,
            title_gradient_direction: ov.title_gradient_direction,
            title_bg_enabled: ov.title_bg_enabled,
            title_bg_color: ov.title_bg_color,
            title_bg_gradient_direction: ov.title_bg_gradient_direction,
            title_bg_opacity: ov.title_bg_opacity,
            title_bg_radius: ov.title_bg_radius,
            title_bg_border_enabled: ov.title_bg_border_enabled,
            title_bg_border_color: ov.title_bg_border_color,
            title_bg_border_width: ov.title_bg_border_width,
            title_bg_border_style: ov.title_bg_border_style,
            title_bg_border_opacity: ov.title_bg_border_opacity,
            _preset_border: ov._preset_border,
            title_bg_brush: ov.title_bg_brush,
            title_bg_brush_style: ov.title_bg_brush_style,
            title_bg_mode: ov.title_bg_mode,
            title_shadow_color: ov.title_shadow_color,
            title_shadow_blur: ov.title_shadow_blur,
            title_font_family: ov.title_font_family,
            title_fontsize: ov.title_fontsize,
            title_font_weight: ov.title_font_weight,
            title_bold: ov.title_bold,
            title_deco_enabled: ov.title_deco_enabled,
            title_deco_position: ov.title_deco_position,
            title_deco_style: ov.title_deco_style,
            title_deco_color: ov.title_deco_color,
            title_deco_thickness: ov.title_deco_thickness,
            title_deco_length: ov.title_deco_length,
            title_deco_gap: ov.title_deco_gap,
            title_deco_opacity: ov.title_deco_opacity,
            title_deco_align: ov.title_deco_align,
        } : null;

        let confirmed = false;

        const popover = document.createElement('div');
        popover.className = 'rop-title-palette-popover';
        popover.style.cssText = 'position:fixed; z-index:9999999; box-sizing:border-box;width:min(500px, calc(100vw - 20px));height:min(550px, calc(100vh - 20px));max-width:calc(100vw - 20px);max-height:calc(100vh - 20px);min-width:min(360px, calc(100vw - 20px));display:flex; flex-direction:column; background:#141722; border:1px solid #3d4663; border-radius:10px; box-shadow:0 16px 40px rgba(0,0,0,0.85); padding:10px 12px; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; color:#e2e8f0; pointer-events:auto;';

        // 顶部标题、搜索框与导入导出
        const header = document.createElement('div');
        header.style.cssText = 'display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; padding-bottom:6px; border-bottom:1px solid rgba(255,255,255,0.08); gap:8px;';
        header.innerHTML = `
            <div style="display:flex; align-items:center; gap:6px; font-size:12px; font-weight:bold; color:#a5b4fc;">
                <span>🎨 个人配色预设色板</span>
                <span style="font-size:10px; font-weight:normal; color:#94a3b8;">${window.ReelsOverviewBatch?.isSelectedScope()?'(点击卡片选择 · 分配前确认)':'(划过实时预览 · 点击应用)'}</span>
            </div>
            <div style="display:flex; align-items:center; gap:5px;">
                <button type="button" class="rop-palette-import-btn" style="background:#1e293b; border:1px solid #3b4258; border-radius:4px; color:#cbd5e1; font-size:11px; padding:2px 7px; cursor:pointer;" title="导入个人配色预设 JSON">📥 导入</button>
                <button type="button" class="rop-palette-export-btn" style="background:#1e293b; border:1px solid #3b4258; border-radius:4px; color:#cbd5e1; font-size:11px; padding:2px 7px; cursor:pointer;" title="导出个人配色预设 JSON">📤 导出</button>
                <input type="text" id="rop-palette-search" placeholder="🔍 搜索预设..." style="width:115px; height:23px; font-size:11px; padding:2px 6px; background:#0e111a; border:1px solid #3b4258; border-radius:4px; color:#e2e8f0; outline:none;" />
                <button type="button" class="rop-palette-close-btn" style="background:none; border:none; color:#94a3b8; font-size:16px; cursor:pointer; padding:0 4px; line-height:1;">✕</button>
            </div>
        `;
        popover.appendChild(header);

        // ═══════════════════════════════════════════════
        // 双层筛选条：
        // 总分类：全部 / 🏷️ 有背景 / ✨ 无背景
        // 下面风格：全部风格 / ✍️ 手写 / 🏛️ 衬线 / 🔤 无衬线 / 🌈 渐变（单独放，不需要区分有无衬线）
        // ═══════════════════════════════════════════════
        const filterContainer = document.createElement('div');
        filterContainer.style.cssText = 'display:flex; flex-direction:column; gap:5px; margin-bottom:8px; background:#0c0e17; border:1px solid rgba(255,255,255,0.06); border-radius:7px; padding:6px 8px;';

        let currentBgFilter = 'all';     // 分组：'all' | 单色字 | 双色字 | 带底色 | 线条装饰
        let currentStyleFilter = 'all';  // 'all' | 'script' | 'serif' | 'sans' | 'gradient'
        let currentSrcFilter = 'all';    // 'all' | 'mine' | 'lib' | 'builtin'
        let paletteLibKeys = new Set();
        try { const info = window.electronAPI?.getPresetLibraryInfo?.(); if (info?.ok) paletteLibKeys = new Set(info.color?.keys || []); } catch (_) { }
        const SRC_RANK = { mine: 0, lib: 1, builtin: 2 };
        const sourceOf = (key, cfg) => {
            if (paletteLibKeys.has(key)) return 'lib';
            const builtinMap = window.REELS_BUILTIN_TITLE_SCHEMES || {};
            return (key in builtinMap && JSON.stringify(builtinMap[key]) === JSON.stringify(cfg)) ? 'builtin' : 'mine';
        };
        const groupOf = (cfg) => {
            if (['单色字', '双色字', '带底色', '线条装饰'].includes(cfg.group)) return cfg.group;
            const meta = this._getPresetCategoryMeta(cfg);
            if (meta.style === 'gradient') return '双色字';
            return meta.hasBg ? '带底色' : '单色字';
        };

        const makeRow = (text, color) => {
            const row = document.createElement('div');
            row.style.cssText = 'display:flex; align-items:center; gap:5px; flex-wrap:wrap;';
            const label = document.createElement('span');
            label.textContent = text;
            label.style.cssText = `font-size:11px; font-weight:700; color:${color}; white-space:nowrap; min-width:32px;`;
            row.appendChild(label);
            return row;
        };
        const srcRow = makeRow('来源:', '#fbbf24');
        const bgRow = makeRow('分组:', '#818cf8');
        const styleRow = makeRow('风格:', '#94a3b8');

        filterContainer.appendChild(srcRow);
        filterContainer.appendChild(bgRow);
        filterContainer.appendChild(styleRow);

        // 应用范围开关：颜色/字体是两个互斥的精简应用模式；忽略背景可叠加。
        const applyOptionsRow = document.createElement('div');
        applyOptionsRow.style.cssText = 'display:flex; align-items:center; gap:10px; flex-wrap:wrap; padding-top:4px; border-top:1px solid rgba(255,255,255,0.06); font-size:11px; color:#cbd5e1;';
        applyOptionsRow.innerHTML = `
            <label style="display:inline-flex;align-items:center;gap:4px;cursor:pointer;"><input type="checkbox" class="rop-palette-only-color"> 仅应用颜色</label>
            <label style="display:inline-flex;align-items:center;gap:4px;cursor:pointer;"><input type="checkbox" class="rop-palette-only-font"> 仅应用字体</label>
            <label style="display:inline-flex;align-items:center;gap:4px;cursor:pointer;"><input type="checkbox" class="rop-palette-ignore-bg"> 忽略背景</label>
            <label style="display:inline-flex;align-items:center;gap:4px;cursor:pointer;" title="色板里存有字号时一并应用（个人另存的色板会记录字号）；没有字号的色板保持当前字号"><input type="checkbox" class="rop-palette-apply-size"> 应用字号</label>
        `;
        filterContainer.appendChild(applyOptionsRow);
        const onlyColorToggle = applyOptionsRow.querySelector('.rop-palette-only-color');
        const onlyFontToggle = applyOptionsRow.querySelector('.rop-palette-only-font');
        const ignoreBgToggle = applyOptionsRow.querySelector('.rop-palette-ignore-bg');
        const applySizeToggle = applyOptionsRow.querySelector('.rop-palette-apply-size');
        // “应用字号”记住上次选择
        if (applySizeToggle) {
            try { applySizeToggle.checked = localStorage.getItem('reels_palette_apply_size') === '1'; } catch (_) {}
            applySizeToggle.addEventListener('change', () => {
                try { localStorage.setItem('reels_palette_apply_size', applySizeToggle.checked ? '1' : '0'); } catch (_) {}
            });
        }
        onlyColorToggle?.addEventListener('change', () => { if (onlyColorToggle.checked && onlyFontToggle) onlyFontToggle.checked = false; });
        onlyFontToggle?.addEventListener('change', () => { if (onlyFontToggle.checked && onlyColorToggle) onlyColorToggle.checked = false; });
        const getApplyOptions = () => ({
            onlyColor: !!onlyColorToggle?.checked,
            onlyFont: !!onlyFontToggle?.checked,
            ignoreBackground: !!ignoreBgToggle?.checked,
            applyFontSize: !!applySizeToggle?.checked,
        });

        const batchMode=!!window.ReelsOverviewBatch?.isSelectedScope();
        const batchPalettes=new Set(),palettePercentages=new Map();
        // Restore the selection independently of the opt-in batch switch.
        // Missing/deleted presets are ignored, never applied on opening.
        if(batchMode)try{
            const saved=JSON.parse(localStorage.getItem('reels_palette_distribution_selected_v1') || '[]');
            const available=this._getTitleColorSchemes();
            if(Array.isArray(saved))for(const id of saved)if(typeof id==='string' && Object.hasOwn(available,id))batchPalettes.add(id);
        }catch(_){}
        const savePaletteSelection=()=>{
            if(batchMode)try{localStorage.setItem('reels_palette_distribution_selected_v1',JSON.stringify([...batchPalettes]));}catch(_){}
        };
        try{for(const [id,value] of Object.entries(JSON.parse(localStorage.getItem('reels_palette_distribution_percentages_v1') || '{}')))if(Number.isFinite(value) && value>=0 && value<=100)palettePercentages.set(id,value);}catch(_){}
        const percentages=()=>Object.fromEntries([...batchPalettes].filter(id=>palettePercentages.has(id)).map(id=>[id,palettePercentages.get(id)]));
        const updateShares=()=>{
            let values={},error='';
            try{if(batchPalettes.size)values=window.ReelsOverviewBatch.palettePercentages([...batchPalettes],percentages());}catch(e){error=e.message;}
            popover.querySelectorAll('[data-palette-share]').forEach(output=>{
                const id=output.dataset.paletteShare;
                output.textContent=palettePercentages.has(id)?'固定':values[id]!==undefined?`自动 ${values[id].toFixed(1)}%`:'自动';
            });
            const notice=popover.querySelector('[data-ratio-status]');if(notice)notice.textContent=error;
        };
        let selectedPalettesOnly=false,distributing=false;
        if(window.ReelsOverviewBatch?.isSelectedScope()){
            const actions=document.createElement('div');actions.style.cssText='display:flex;gap:8px;align-items:center;padding:8px 0;flex-wrap:wrap';
            actions.innerHTML='<span data-count>已选 0 套色板</span><button data-selected-only aria-pressed="false" title="查看所有已选色板，不受分类和搜索限制">查看已选择</button><button data-clear-selection title="取消所有已选色板">取消选择</button><button data-reset-weights title="清除手动百分比，恢复已选色板自动均分">恢复默认比例</button><button data-random>按比例随机分配</button><button data-cycle>按比例循环</button><small>填百分比即固定，留空自动平分剩余；选择和比例自动保存</small><small data-ratio-status role="status" style="color:#fbbf24"></small>';
            filterContainer.appendChild(actions);
            for(const [attr,mode] of [['data-random','random'],['data-cycle','cycle']])actions.querySelector('['+attr+']').onclick=async()=>{
                if(distributing)return;distributing=true;
                const buttons=[...actions.querySelectorAll('button')];buttons.forEach(button=>button.disabled=true);
                const count=actions.querySelector('[data-count]');
                try{if(await window.ReelsOverviewBatch.confirmPalettes(this,[...batchPalettes],mode,{...getApplyOptions(),percentages:percentages(),onProgress:(done,total)=>count.textContent=`正在分配 ${done} / ${total}…`}))confirmed=true;}
                finally{distributing=false;buttons.forEach(button=>button.disabled=false);count.textContent=`已选 ${batchPalettes.size} 套色板`;}
            };
            this._batchPaletteCounter=actions.querySelector('[data-count]');
            this._batchPaletteCounter.textContent=`已选 ${batchPalettes.size} 套色板`;
            const selectedFilter=actions.querySelector('[data-selected-only]');
            actions.querySelector('[data-clear-selection]').onclick=()=>{
                if(distributing)return;
                batchPalettes.clear();savePaletteSelection();
                this._batchPaletteCounter.textContent='已选 0 套色板';
                selectedPalettesOnly=false;selectedFilter.setAttribute('aria-pressed','false');
                selectedFilter.textContent='查看已选择';renderCards();
            };
            actions.querySelector('[data-reset-weights]').onclick=()=>{
                if(distributing)return;
                palettePercentages.clear();
                try{localStorage.setItem('reels_palette_distribution_percentages_v1','{}');}catch(_){}
                renderCards();
            };
            selectedFilter.onclick=()=>{
                selectedPalettesOnly=!selectedPalettesOnly;selectedFilter.setAttribute('aria-pressed',String(selectedPalettesOnly));
                selectedFilter.textContent=selectedPalettesOnly?'返回全部色板':'查看已选择';renderCards();
            };
        }
        const srcTabs = [
            { id: 'all', label: '全部' },
            { id: 'mine', label: '⭐ 我的预设' },
            { id: 'lib', label: '📚 预设库' },
            { id: 'builtin', label: '内置' }
        ];
        const bgTabs = [
            { id: 'all', label: '全部分组' },
            { id: '单色字', label: '单色字' },
            { id: '双色字', label: '双色字' },
            { id: '带底色', label: '带底色' },
            { id: '线条装饰', label: '线条装饰' }
        ];

        const styleTabs = [
            { id: 'all', label: '全部风格' },
            { id: 'script', label: '✍️ 手写' },
            { id: 'serif', label: '🏛️ 衬线' },
            { id: 'sans', label: '🔤 无衬线' },
            { id: 'gradient', label: '🌈 渐变' }
        ];

        const matchSrc = (key, cfg) => currentSrcFilter === 'all' || sourceOf(key, cfg) === currentSrcFilter;
        const matchGroup = (cfg) => currentBgFilter === 'all' || groupOf(cfg) === currentBgFilter;

        const renderTabRow = (row, tabs, counts, current, activeColors, onPick) => {
            row.querySelectorAll('button').forEach(b => b.remove());
            tabs.forEach(tab => {
                const count = counts[tab.id] || 0;
                if (tab.id !== 'all' && !count) return;
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.textContent = `${tab.label} (${count})`;
                const active = current === tab.id;
                btn.style.cssText = `padding:2.5px 9px; font-size:11px; font-weight:${active ? '700' : '500'}; border-radius:4px; border:1px solid ${active ? activeColors[0] : '#2b3346'}; background:${active ? activeColors[1] : '#171b26'}; color:${active ? '#ffffff' : '#94a3b8'}; cursor:pointer; white-space:nowrap; transition:all 0.15s;`;
                btn.addEventListener('click', () => { onPick(tab.id); renderFilters(); renderCards(); });
                row.appendChild(btn);
            });
        };

        const renderFilters = () => {
            const schemes = this._getTitleColorSchemes();
            const srcCounts = { all: 0, mine: 0, lib: 0, builtin: 0 };
            const groupCounts = { all: 0 };
            const styleCounts = { all: 0, script: 0, serif: 0, sans: 0, gradient: 0 };

            Object.entries(schemes).forEach(([key, cfg]) => {
                srcCounts.all++;
                srcCounts[sourceOf(key, cfg)]++;
                if (!matchSrc(key, cfg)) return;
                const g = groupOf(cfg);
                groupCounts.all++;
                groupCounts[g] = (groupCounts[g] || 0) + 1;
                if (!matchGroup(cfg)) return;
                const meta = this._getPresetCategoryMeta(cfg);
                styleCounts.all++;
                if (styleCounts[meta.style] !== undefined) styleCounts[meta.style]++;
            });

            renderTabRow(srcRow, srcTabs, srcCounts, currentSrcFilter, ['#f59e0b', '#78350f'], id => { currentSrcFilter = id; });
            renderTabRow(bgRow, bgTabs, groupCounts, currentBgFilter, ['#6366f1', '#312e81'], id => { currentBgFilter = id; });
            renderTabRow(styleRow, styleTabs, styleCounts, currentStyleFilter, ['#38bdf8', '#0369a1'], id => { currentStyleFilter = id; });
        };

        // 卡片网格容器
        const grid = document.createElement('div');
        // 在 flex 弹窗中明确网格可收缩高度，避免个别运行环境将卡片内容
        // 压扁成仅剩上下边框的细线。
        grid.style.cssText = 'display:grid; grid-template-columns:repeat(auto-fill, minmax(min(112px, 100%), 1fr)); grid-auto-rows:max-content;align-items:start; align-content:start; gap:5px; flex:1 1 auto; min-height:0; overflow-y:auto; padding:2px 4px 2px 0;';

        const renderCards = () => {
            grid.innerHTML = '';
            const selectEl = this.container.querySelector('#rop-title-scheme-select');
            const currentVal = selectEl?.value || '';
            const searchInput = header.querySelector('#rop-palette-search');
            const query = (searchInput?.value || '').trim().toLowerCase();
            const schemes = this._getTitleColorSchemes();
            // 先按来源（我的 → 预设库 → 内置），同一来源内新加的排最前：
            // 预设按写入顺序追加到存储末尾，因此按原始顺序倒序即可。
            const entries = Object.entries(schemes)
                .map((entry, index) => ({ entry, index, rank: SRC_RANK[sourceOf(entry[0], entry[1])] }))
                .sort((a, b) => a.rank - b.rank || b.index - a.index)
                .map(item => item.entry);

            if (entries.length === 0) {
                grid.innerHTML = '<div style="grid-column:1 / -1; padding:40px 10px; text-align:center; color:#94a3b8; font-size:12px;">暂无个人配色预设<br><span style="font-size:11px; color:#64748b; margin-top:6px; display:inline-block;">点击右上角「📥 导入」导入配色预设 JSON，或在主面板「💾 另存」当前样式。</span></div>';
                return;
            }

            entries.forEach(([key, cfg]) => {
                const meta = this._getPresetCategoryMeta(cfg);
                if(selectedPalettesOnly){if(!batchPalettes.has(key))return;}else{
                if (!matchSrc(key, cfg)) return;
                if (!matchGroup(cfg)) return;
                if (currentStyleFilter !== 'all' && meta.style !== currentStyleFilter) return;

                if (query) {
                    const matchName = (cfg.name || '').toLowerCase().includes(query);
                    const matchFont = (cfg.font || '').toLowerCase().includes(query);
                    const matchCol = (cfg.titleColor || '').toLowerCase().includes(query) || (cfg.titleColor2 || '').toLowerCase().includes(query);
                    if (!matchName && !matchFont && !matchCol) return;
                }
                }
                const isSelected = batchMode?batchPalettes.has(key):key === currentVal;

                const card = document.createElement('div');
                card.style.cssText = `position:relative;min-height:0;display:flex; flex-direction:column; background:${isSelected ? '#1e2846' : '#1a1d2b'}; border:1px solid ${isSelected ? '#6366f1' : '#2b3145'}; border-radius:7px; cursor:pointer; overflow:hidden; transition:all 0.15s ease; box-shadow:${isSelected ? '0 0 0 1px #6366f1, ' : ''}0 2px 5px rgba(0,0,0,0.3);`;
                let ratioControls;
                const selectPalette=checked=>{
                    if(distributing)return;
                    if(checked)batchPalettes.add(key);else batchPalettes.delete(key);savePaletteSelection();
                    card.setAttribute('aria-pressed',String(checked));
                    card.style.boxShadow=checked?'0 0 0 2px #818cf8':'0 2px 5px rgba(0,0,0,0.3)';
                    card.style.borderColor=checked?'#818cf8':'#2b3145';card.style.background=checked?'#1e2846':'#1a1d2b';
                    if(this._batchPaletteCounter)this._batchPaletteCounter.textContent=`已选 ${batchPalettes.size} 套色板`;
                    if(ratioControls)ratioControls.hidden=!checked;updateShares();
                    if(selectedPalettesOnly && !checked)renderCards();
                };
                if(batchMode){
                    card.setAttribute('role','button');card.setAttribute('aria-label','选择色板 '+(cfg.name || key));
                    card.setAttribute('aria-pressed',String(isSelected));card.tabIndex=0;
                    card.addEventListener('keydown',event=>{if(event.target!==card)return;if(event.key===' ' || event.key==='Enter'){event.preventDefault();selectPalette(!batchPalettes.has(key));}});
                }
                // 底部名称栏已去掉，名称与色值改为悬停提示
                card.title = [cfg.name || key, cfg.font, [cfg.titleColor, cfg.dualColor ? cfg.titleColor2 : '', cfg.titleBgEnabled || (!cfg.pureText && cfg.titleBgColor) ? `底 ${cfg.titleBgColor}` : ''].filter(Boolean).join(' / ')].filter(Boolean).join('\n');

                // 黑底预览区 (模拟暗色视频背景)
                const previewBox = document.createElement('div');
                previewBox.style.cssText = 'display:flex; flex:0 0 auto;box-sizing:border-box;width:100%; align-items:center; justify-content:center; background:#0b0d14; overflow:hidden;';
                const pillFont = `font-family:${cfg.font ? `"${cfg.font}", sans-serif` : 'sans-serif'}; font-size:11px; font-weight:${cfg.weight || 800}; letter-spacing:0.3px; white-space:nowrap; max-width:100%; overflow:hidden; text-overflow:ellipsis; box-sizing:border-box;`;
                // 描边/圆角按卡片尺寸缩小显示（视频里的像素值约为卡片的 3 倍）
                const pillBorder = cfg.titleBgBorderEnabled
                    ? `border:${Math.max(1, Math.min(3, (Number(cfg.titleBgBorderWidth) || 3) / 2))}px ${cfg.titleBgBorderStyle || 'solid'} ${cfg.titleBgBorderColor || '#FFFFFF'};`
                    : '';
                const pillRadius = cfg.titleBgRadius !== undefined ? `border-radius:${Math.round(Math.min(14, (Number(cfg.titleBgRadius) || 0) / 3))}px;` : '';

                if ((cfg.dualColor || cfg.titleBgColor2) && cfg.titleBgEnabled && cfg.titleBgColor && !cfg.pureText) {
                    // 渐变字/渐变底：与应用后的真实效果一致（含方向）
                    previewBox.style.height = '48px';
                    previewBox.style.padding = '4px 6px';
                    const pill = document.createElement('span');
                    const pillBg = cfg.titleBgColor2
                        ? `linear-gradient(${this._gradientCssAngle(cfg.titleBgGradientDirection || 'horizontal')}, ${cfg.titleBgColor}, ${cfg.titleBgColor2})`
                        : cfg.titleBgColor;
                    pill.style.cssText = `background:${pillBg}; padding:2px 7px; border-radius:4px; box-shadow:0 1px 4px rgba(0,0,0,0.4); ${pillFont} ${pillBorder} ${pillRadius}`;
                    const txt = document.createElement('span');
                    txt.textContent = 'READ IT ONCE';
                    txt.style.cssText = cfg.dualColor
                        ? `background:linear-gradient(${this._gradientCssAngle(cfg.titleGradientDirection || 'vertical')}, ${cfg.titleColor}, ${cfg.titleColor2}); -webkit-background-clip:text; background-clip:text; color:transparent;`
                        : `color:${cfg.titleColor};`;
                    pill.appendChild(txt);
                    previewBox.appendChild(pill);
                } else if (cfg.dualColor) {
                    previewBox.style.height = '56px';
                    previewBox.style.flexDirection = 'column';
                    previewBox.style.padding = '4px 8px';
                    previewBox.style.justifyContent = 'center';
                    previewBox.style.gap = '2px';

                    const sample1 = document.createElement('div');
                    sample1.textContent = 'WHETHER YOU GO TO';
                    sample1.style.cssText = `color:${cfg.titleColor}; font-size:11px; font-weight:${cfg.weight || 700}; font-family:${cfg.font ? `"${cfg.font}", sans-serif` : 'sans-serif'}; letter-spacing:0.5px; text-transform:uppercase; text-shadow:0 1px 3px rgba(0,0,0,0.9); line-height:1.15; text-align:center; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; width:100%;`;

                    const sample2 = document.createElement('div');
                    sample2.textContent = 'CHURCH OR NOT, SAY';
                    sample2.style.cssText = `color:${cfg.titleColor2}; font-size:11px; font-weight:${cfg.weight || 700}; font-family:${cfg.font ? `"${cfg.font}", sans-serif` : 'sans-serif'}; letter-spacing:0.5px; text-transform:uppercase; text-shadow:0 1px 3px rgba(0,0,0,0.9); line-height:1.15; text-align:center; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; width:100%;`;

                    previewBox.append(sample1, sample2);
                } else if (cfg.decoLine) {
                    previewBox.style.height = '62px';
                    previewBox.style.flexDirection = 'column';
                    previewBox.style.padding = '5px 8px';
                    previewBox.style.justifyContent = 'center';
                    previewBox.style.gap = '2px';

                    const sampleTitle = document.createElement('div');
                    sampleTitle.textContent = 'WHETHER YOU GO TO CHURCH';
                    sampleTitle.style.cssText = `color:${cfg.titleColor}; font-size:10.5px; font-weight:${cfg.weight || 700}; font-family:${cfg.font ? `"${cfg.font}", serif` : 'serif'}; letter-spacing:0.5px; text-transform:uppercase; text-shadow:0 1px 2px rgba(0,0,0,0.9); line-height:1.15; text-align:center; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; width:100%;`;

                    const sampleLine = document.createElement('div');
                    sampleLine.style.cssText = `height:2.5px; width:70%; background:${cfg.decoColor}; border-radius:2px; margin:2px auto; box-shadow:0 1px 4px ${cfg.decoColor}66;`;

                    const sampleBody = document.createElement('div');
                    sampleBody.textContent = 'Dear God, I am not asking...';
                    sampleBody.style.cssText = `color:#ffffff; font-size:8.5px; font-family:${cfg.bodyFont ? `"${cfg.bodyFont}", sans-serif` : 'sans-serif'}; opacity:0.85; text-align:center; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; width:100%;`;

                    previewBox.append(sampleTitle, sampleLine, sampleBody);
                // `pureText` 的优先级高于分类：例如“荧光笔划线”类预设的
                // 当前配置实际是纯文字，旧代码却因 strip 分类硬画了一块底色。
                // 这正是色板与点击后的真实预览不一致的来源。
                } else if (cfg.pureText) {
                    previewBox.style.height = '48px';
                    previewBox.style.padding = '4px 8px';
                    const sample = document.createElement('span');
                    sample.textContent = 'WHETHER YOU GO TO CHURCH';
                    sample.style.cssText = `color:${cfg.titleColor}; font-size:11px; font-weight:${cfg.weight || 800}; font-family:${cfg.font ? `"${cfg.font}", sans-serif` : 'sans-serif'}; letter-spacing:0.5px; text-transform:uppercase; text-shadow:0 1px 3px rgba(0,0,0,0.9); line-height:1.2; text-align:center; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; width:100%;`;
                    previewBox.appendChild(sample);
                } else if (cfg.titleBgBrush || cfg.category === 'strip') {
                    previewBox.style.height = '48px';
                    previewBox.style.padding = '4px 8px';
                    const pill = document.createElement('span');
                    // 预览样字必须是预设字体明确支持的拉丁字符；混入“标题”
                    // 会让浏览器为中文部分回退系统字体，从而误以为所有卡片
                    // 都使用同一种字体。
                    pill.textContent = 'READ IT ONCE';
                    if (cfg.titleBgBrush) {
                        pill.style.cssText = `background:${cfg.titleBgColor}; color:${cfg.titleColor}; padding:2px 8px; border-radius:2px; ${pillFont} clip-path:polygon(1% 8%, 98% 0, 100% 84%, 97% 100%, 3% 92%, 0 18%); box-shadow:0 2px 6px rgba(0,0,0,0.5);`;
                    } else if (cfg.glowColor) {
                        pill.style.cssText = `background:${cfg.titleBgColor}; color:${cfg.titleColor}; padding:2px 8px; border-radius:12px; ${pillFont} box-shadow:0 0 10px ${cfg.glowColor}; border:1px solid ${cfg.glowColor};`;
                    } else {
                        pill.style.cssText = `background:${cfg.titleBgColor}; color:${cfg.titleColor}; padding:2px 8px; border-radius:12px; ${pillFont} box-shadow:0 1px 5px rgba(0,0,0,0.4);`;
                    }
                    previewBox.appendChild(pill);
                } else {
                    previewBox.style.height = '48px';
                    previewBox.style.padding = '4px 6px';
                    const pill = document.createElement('span');
                    pill.textContent = 'READ IT ONCE';
                    pill.style.cssText = `background:${cfg.titleBgColor}; color:${cfg.titleColor}; padding:2px 7px; border-radius:4px; ${pillFont} box-shadow:0 1px 4px rgba(0,0,0,0.4); ${pillBorder} ${pillRadius}`;
                    previewBox.appendChild(pill);
                }

                card.append(previewBox);
                if(batchMode){
                    ratioControls=document.createElement('div');ratioControls.hidden=!batchPalettes.has(key);
                    ratioControls.style.cssText='padding:4px 6px;font-size:11px;background:#202438;flex-shrink:0';
                    const label=document.createElement('label');label.style.cssText='display:flex;align-items:center;gap:4px;justify-content:space-between';
                    const caption=document.createElement('span');caption.textContent='占比%';
                    const input=document.createElement('input');input.type='number';input.min='0';input.max='100';input.step='0.1';input.placeholder='自动';input.value=palettePercentages.has(key)?palettePercentages.get(key):'';input.style.cssText='width:50px;min-width:0;font-size:11px';input.setAttribute('aria-label',(cfg.name || key)+' 固定百分比，留空自动');
                    const share=document.createElement('span');share.dataset.paletteShare=key;
                    const changePercentage=()=>{
                        if(distributing)return;
                        if(input.value==='')palettePercentages.delete(key);
                        else{const value=Number(input.value);if(!Number.isFinite(value) || value<0 || value>100)return;palettePercentages.set(key,value);}
                        updateShares();
                        try{localStorage.setItem('reels_palette_distribution_percentages_v1',JSON.stringify(Object.fromEntries(palettePercentages)));}catch(_){}
                    };
                    input.oninput=changePercentage;input.onchange=()=>{changePercentage();input.value=palettePercentages.has(key)?palettePercentages.get(key):'';};
                    for(const type of ['click','keydown','pointerdown'])ratioControls.addEventListener(type,event=>event.stopPropagation());
                    label.append(caption,input,share);ratioControls.appendChild(label);card.appendChild(ratioControls);
                }


                // Hover 动效与实时画布预览
                card.addEventListener('mouseenter', () => {
                    card.style.borderColor = '#818cf8';
                    card.style.transform = 'translateY(-1px)';
                    card.style.boxShadow = '0 4px 12px rgba(99,102,241,0.25)';

                    // 批量模式只预览缩略图，悬停不能改写已分配的任务。
                    if (this._selectedOv && !window.ReelsOverviewBatch?.isSelectedScope()) {
                        const tempOv = this._selectedOv;
                        if (cfg.dualColor) {
                            tempOv.title_color = `${cfg.titleColor}, ${cfg.titleColor2}`;
                            tempOv.title_gradient_direction = cfg.titleGradientDirection || 'vertical';
                            // 双色字若带底色，悬停预览也要显示底色（与点击应用一致）
                            const dualBg = !!(cfg.titleBgEnabled && cfg.titleBgColor && !cfg.pureText);
                            tempOv.title_bg_enabled = dualBg;
                            if (dualBg) {
                                tempOv.title_bg_color = cfg.titleBgColor;
                                tempOv.title_bg_mode = cfg.titleBgMode || 'block';
                            }
                            tempOv.title_bg_brush = false;
                        } else if (cfg.decoLine) {
                            tempOv.title_color = cfg.titleColor;
                            tempOv.title_gradient_direction = 'horizontal';
                            tempOv.title_bg_enabled = false;
                            tempOv.title_bg_brush = false;
                            tempOv.title_deco_enabled = true;
                            if (cfg.decoColor) tempOv.title_deco_color = cfg.decoColor;
                            if (!tempOv.title_deco_position) tempOv.title_deco_position = 'bottom';
                            if (!tempOv.title_deco_style) tempOv.title_deco_style = 'solid';
                            if (!tempOv.title_deco_thickness) tempOv.title_deco_thickness = 3;
                            if (tempOv.title_deco_opacity === undefined) tempOv.title_deco_opacity = 100;
                        } else if (cfg.pureText) {
                            tempOv.title_color = cfg.titleColor;
                            tempOv.title_gradient_direction = 'horizontal';
                            tempOv.title_bg_enabled = false;
                            tempOv.title_bg_brush = false;
                        } else if (cfg.titleBgBrush || cfg.category === 'strip') {
                            tempOv.title_color = cfg.titleColor;
                            tempOv.title_gradient_direction = 'horizontal';
                            tempOv.title_bg_enabled = true;
                            tempOv.title_bg_color = cfg.titleBgColor;
                            tempOv.title_bg_brush = !!cfg.titleBgBrush;
                            tempOv.title_bg_brush_style = cfg.titleBgBrushStyle || 'brush1';
                            tempOv.title_bg_mode = cfg.titleBgMode || 'block';
                            if (cfg.glowColor) {
                                tempOv.title_shadow_color = cfg.glowColor;
                                tempOv.title_shadow_blur = 12;
                            }
                        } else {
                            tempOv.title_color = cfg.titleColor;
                            tempOv.title_gradient_direction = 'horizontal';
                            tempOv.title_bg_enabled = true;
                            tempOv.title_bg_color = cfg.titleBgColor;
                            tempOv.title_bg_brush = false;
                        }
                        // 渐变底色
                        if (tempOv.title_bg_enabled && cfg.titleBgColor2 && cfg.titleBgColor) {
                            tempOv.title_bg_color = `${cfg.titleBgColor}, ${cfg.titleBgColor2}`;
                            tempOv.title_bg_gradient_direction = cfg.titleBgGradientDirection || 'horizontal';
                        }
                        if (cfg.font) tempOv.title_font_family = cfg.font;
                        if (applySizeToggle?.checked && !onlyColorToggle?.checked && Number(cfg.titleFontSize) > 0) {
                            tempOv.title_fontsize = Number(cfg.titleFontSize);
                        }
                        if (tempOv.title_bg_enabled) Object.assign(tempOv, this._titleSchemeBorderFields(cfg, tempOv));
                        if (cfg.weight) {
                            tempOv.title_font_weight = cfg.weight;
                            tempOv.title_bold = cfg.weight >= 600;
                        }
                        if (typeof this.videoCanvas?.render === 'function') {
                            this.videoCanvas.render();
                        }
                    }
                });

                card.addEventListener('mouseleave', () => {
                    if (!(batchMode?batchPalettes.has(key):isSelected)) {
                        card.style.borderColor = '#2b3145';
                        card.style.transform = '';
                        card.style.boxShadow = '0 2px 5px rgba(0,0,0,0.3)';
                    }
                    // 恢复画布预览
                    if (!batchMode && !confirmed && preSnapshot && this._selectedOv===ov) {
                        Object.assign(this._selectedOv, preSnapshot);
                        if (typeof this.videoCanvas?.render === 'function') {
                            this.videoCanvas.render();
                        }
                    }
                });

                // 点击选中
                card.addEventListener('click', () => {
                    if(batchMode){selectPalette(!batchPalettes.has(key));return;}
                    confirmed = true;
                    if (selectEl) selectEl.value = key;
                    this._applyTitleColorScheme(key, getApplyOptions());
                    close();
                });

                grid.appendChild(card);
            });
            updateShares();
            if(!grid.childElementCount){const empty=document.createElement('div');empty.style.cssText='grid-column:1/-1;padding:24px;text-align:center;color:#94a3b8;font-size:12px';empty.textContent=selectedPalettesOnly?'还没有选择色板，点击“返回全部色板”继续选择':'当前筛选没有匹配的色板';grid.appendChild(empty);}
        };

        renderFilters();
        renderCards();

        // 色板必须等预设字体实际可用后再刷新卡片。此前这里只把 font-family
        // 写进样式，字体尚未下载/注册时 Chromium 会统一回退为默认字体，造成
        // 预览看起来所有预设都是同一种字。
        const preloadPaletteFonts = async () => {
            if (typeof window.getFontManager !== 'function') return;
            const fonts = [...new Set(Object.values(this._getTitleColorSchemes())
                .map(cfg => String(cfg?.font || '').split(',')[0].replace(/["']/g, '').trim())
                .filter(Boolean))];
            if (!fonts.length) return;
            try {
                const fm = window.getFontManager();
                if (!fm) return;
                if (typeof fm.register === 'function') await fm.register();
                if (typeof fm.loadGoogleFont === 'function') {
                    await Promise.all(fonts.map(font => fm.loadGoogleFont(font)));
                }
                if (document.fonts?.load) {
                    await Promise.all(fonts.map(font => document.fonts.load(`400 16px "${font}"`).catch(() => {})));
                }
                if (document.fonts?.ready) await document.fonts.ready;
                if (popover.isConnected) renderCards();
            } catch (error) {
                // 离线或个别字体不可用时保留已有卡片，不阻断色板使用。
                console.warn('[Reels] 色板预设字体预加载失败:', error);
            }
        };
        preloadPaletteFonts();

        // 搜索框动态筛选
        const searchInput = header.querySelector('#rop-palette-search');
        if (searchInput) {
            searchInput.addEventListener('input', () => {
                renderCards();
            });
        }

        // 导入与导出
        header.querySelector('.rop-palette-import-btn')?.addEventListener('click', (e) => {
            e.stopPropagation();
            this._importTitleColorSchemes(() => {
                renderFilters();
                renderCards();
            });
        });

        header.querySelector('.rop-palette-export-btn')?.addEventListener('click', (e) => {
            e.stopPropagation();
            this._exportTitleColorSchemes();
        });

        popover.appendChild(filterContainer);
        popover.appendChild(grid);
        document.body.appendChild(popover);

        // 定位 (确保在屏幕内，且高于任何弹窗，支持在“大量建立”全屏浮层中正常弹出)
        const rect = anchorEl ? anchorEl.getBoundingClientRect() : null;
        let top = rect ? rect.bottom + 6 : 100;
        let left = rect ? rect.left - 180 : 100;

        if (!rect || (!rect.width && !rect.height)) {
            top = Math.max(20, (window.innerHeight - 550) / 2);
            left = Math.max(20, (window.innerWidth - 500) / 2);
        } else {
            if (top + 550 > window.innerHeight) {
                if (rect.top - 560 > 10) {
                    top = rect.top - 560;
                } else {
                    top = Math.max(10, window.innerHeight - 560);
                }
            }
            if (left + 510 > window.innerWidth) {
                left = Math.max(10, window.innerWidth - 520);
            }
            if (left < 10) left = 10;
            if (top < 10) top = 10;
        }

        popover.style.top = `${top}px`;
        popover.style.left = `${left}px`;

        const resizeCorner=document.createElement('div');
        resizeCorner.title='拖动左下角调整窗口大小';resizeCorner.setAttribute('aria-label',resizeCorner.title);
        resizeCorner.style.cssText='position:absolute;left:0;bottom:0;width:20px;height:20px;cursor:nesw-resize;touch-action:none;user-select:none;z-index:5;background:repeating-linear-gradient(45deg,transparent 0 3px,#a5b4fc 3px 5px,transparent 5px 8px);clip-path:polygon(0 0,100% 100%,0 100%);';
        popover.appendChild(resizeCorner);
        let resizeStart=null;
        resizeCorner.onpointerdown=event=>{
            if(event.button!==0)return;
            event.preventDefault();event.stopPropagation();
            const bounds=popover.getBoundingClientRect();
            resizeStart={x:event.clientX,y:event.clientY,right:bounds.right,top:bounds.top,width:bounds.width,height:bounds.height};
            resizeCorner.setPointerCapture(event.pointerId);
        };
        resizeCorner.onpointermove=event=>{
            if(!resizeStart)return;event.preventDefault();event.stopPropagation();
            const r=resizeStart,minWidth=Math.min(360,window.innerWidth-20);
            const width=Math.min(r.right-10,Math.max(minWidth,r.width+r.x-event.clientX));
            const height=Math.min(window.innerHeight-r.top-10,Math.max(Math.min(350,window.innerHeight-r.top-10),r.height+event.clientY-r.y));
            popover.style.left=`${r.right-width}px`;popover.style.width=`${width}px`;popover.style.height=`${height}px`;
        };
        const endResize=()=>{resizeStart=null;};
        resizeCorner.onpointerup=endResize;resizeCorner.onpointercancel=endResize;resizeCorner.onlostpointercapture=endResize;
        resizeCorner.onclick=event=>event.stopPropagation();

        const close = () => {
            if(distributing)return;
            if (!confirmed && preSnapshot && this._selectedOv===ov) {
                Object.assign(this._selectedOv, preSnapshot);
                if (typeof this.videoCanvas?.render === 'function') {
                    this.videoCanvas.render();
                }
            }
            popover.remove();
            savePaletteSelection();
        };

        // Keep the picker open when the user interacts outside it.
        popover._closePalette=close;

        header.querySelector('.rop-palette-close-btn').addEventListener('click', close);
        renderCards('all');
    }

    // ═══════════════════════════════════════════════
    // 覆层 CRUD
    // ═══════════════════════════════════════════════

    _addTextCardOverlay() {
        const ReelsOverlay = window.ReelsOverlay;
        if (!ReelsOverlay) return;
        const ov = ReelsOverlay.createTextCardOverlay({
            title_text: 'IN MARCH, READ THIS JUST ONCE AND IT WILL COME TO PASS IMMEDIATELY',
            body_text: 'Lord, in the name of Jesus, March has begun. I rebuke every spiritual curse, evil eye, jealousy, sickness, and confusion coming against me and my family! I cut off every hidden opening and destroy every trap set by the enemy.',
            footer_text: 'I declare: the precious blood of Jesus covers my spouse, my children, and everyone I love. Angels guard every door and window—the enemy cannot come near, not even one step! Darkness cannot enter.\nLord, bring breakthrough to everyone who writes "Amen" and render every curse powerless!',
            x: ROP_TEXTCARD_DEFAULT_TRANSFORM.x,
            y: ROP_TEXTCARD_DEFAULT_TRANSFORM.y,
            w: ROP_TEXTCARD_DEFAULT_TRANSFORM.w,
            h: ROP_TEXTCARD_DEFAULT_TRANSFORM.h,
            rotation: ROP_TEXTCARD_DEFAULT_TRANSFORM.rotation,
            opacity: ROP_TEXTCARD_DEFAULT_TRANSFORM.opacity,
            start: 0, end: 9999,
        });
        this._applyNewOverlaySlot(ov, 'script');
        if (this.videoCanvas) this.videoCanvas.addOverlay(ov);
        this._refreshList();
        this.selectOverlay(ov);
    }

    _addSolidMaskOverlay() {
        const ReelsOverlay = window.ReelsOverlay;
        if (!ReelsOverlay) return;
        const ov = ReelsOverlay.createSolidMaskOverlay({
            x: ROP_TEXTCARD_DEFAULT_TRANSFORM.x,
            y: ROP_TEXTCARD_DEFAULT_TRANSFORM.y,
            w: ROP_TEXTCARD_DEFAULT_TRANSFORM.w,
            h: ROP_TEXTCARD_DEFAULT_TRANSFORM.h,
            rotation: ROP_TEXTCARD_DEFAULT_TRANSFORM.rotation,
            opacity: ROP_TEXTCARD_DEFAULT_TRANSFORM.opacity,
            start: 0, end: 9999,
            card_color: '#000000',
            card_opacity: 50,
        });
        if (this.videoCanvas) this.videoCanvas.addOverlay(ov);
        this._refreshList();
        this.selectOverlay(ov);
    }

    /**
     * 批量导入文字卡片 — 从 Google Sheets 粘贴 TSV
     * 格式: 第一列=标题, 第二列=内容 (支持单元格内换行)
     * 每行自动创建一个任务 + 文字卡片覆层
     */
    async _batchImportTextCards() {
        if (this.videoCanvas?.scopedTask) return;
        const ReelsOverlay = window.ReelsOverlay;
        if (!ReelsOverlay) return;

        // 弹窗让用户粘贴表格数据
        const result = await this._showBatchImportDialog();
        if (!result || !result.data || !result.data.trim()) return;

        const importType = result.type || 'textcard';

        // 解析 TSV (支持引号内换行)
        const rows = this._parseTSV(result.data);
        if (!rows.length) {
            alert('未检测到有效数据，请确保每行至少有一列内容。');
            return;
        }

        // 读取当前覆层模板样式
        const templateProps = importType === 'scroll'
            ? this._getCurrentScrollTemplate()
            : this._getCurrentCardTemplate();

        // 获取 _reelsState 来创建任务
        const state = window._reelsState;
        if (!state) {
            alert('批量Reels模块未初始化');
            return;
        }

        let created = 0;
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            let rawName = '', title = '', body = '', refContent = '';
            const map = result.mapping;

            if (map && (map.name >= 0 || map.title >= 0 || map.body >= 0)) {
                if (map.name >= 0) rawName = row[map.name] || '';
                if (map.title >= 0) title = row[map.title] || '';
                if (map.body >= 0) body = row[map.body] || '';
                if (map.ref >= 0) refContent = row[map.ref] || '';
            } else {
                // 回退到旧版的简单猜测模式
                if (importType === 'scroll') {
                    if (row.length >= 3) {
                        rawName = row[0] || '';
                        title = row[1] || '';
                        body = row[2] || '';
                    } else if (row.length === 2) {
                        title = row[0] || '';
                        body = row[1] || '';
                    } else {
                        body = row[0] || '';
                    }
                } else {
                    if (row.length >= 3) {
                        rawName = row[0] || '';
                        title = row[1] || '';
                        body = row[2] || '';
                    } else {
                        title = row[0] || '';
                        body = row[1] || '';
                    }
                }
            }

            if (!title && !body && !rawName) continue; // 跳过空行

            // 命名
            const baseNameInput = rawName.trim() || `batch_${importType}_${String(i + 1).padStart(3, '0')}`;

            let task = null;
            if (typeof _getOrCreateTaskByBase === 'function' && typeof _normalizeBaseName === 'function') {
                const normBase = _normalizeBaseName(baseNameInput);
                task = _getOrCreateTaskByBase(normBase, baseNameInput);
            } else {
                const taskName = baseNameInput;
                task = state.tasks.find(t => t.baseName === taskName);
                if (!task) {
                    task = {
                        baseName: taskName,
                        fileName: `${taskName}.mp4`,
                        bgPath: null, bgSrcUrl: null, audioPath: null, srtPath: null,
                        segments: [], videoPath: null, srcUrl: null,
                        overlays: [],
                    };
                    state.tasks.push(task);
                }
            }

            if (!task.overlays) task.overlays = [];
            
            // 记录专属的对齐文本内容到任务 (供字幕对齐使用)
            if (refContent) {
                task.txtContent = refContent;
            } else if (!task.txtContent && (title || body)) {
                task.txtContent = [title, body].filter(x => x).join('\\n'); // Fallback purely if ref missing
            }

            // 创建覆层
            if (importType === 'scroll') {
                const ovOpts = Object.assign({}, templateProps, {
                    scroll_title: title,
                    content: body,
                    start: 0,
                    end: 9999,
                });
                const ov = ReelsOverlay.createScrollOverlay(ovOpts);
                task.overlays.push(ov);
            } else {
                const ovOpts = Object.assign({}, templateProps, {
                    title_text: title,
                    body_text: body,
                    start: 0,
                    end: 9999,
                });
                const ov = ReelsOverlay.createTextCardOverlay(ovOpts);
                task.overlays.push(ov);
            }

            created++;
        }

        // 刷新任务列表
        if (typeof _renderTaskList === 'function') _renderTaskList();

        // 自动匹配素材
        if (typeof reelsAutoMatchFiles === 'function') reelsAutoMatchFiles();

        const typeLabel = importType === 'scroll' ? '滚动字幕' : '文字卡片';
        alert(`✅ 成功导入 ${created} 条${typeLabel}！\n\n请添加背景素材、音频等，系统将自动配对。`);
    }

    /**
     * 解析 TSV 数据 (支持引号内换行的 Google Sheets 格式)
     * 返回 [[title, body], ...]
     */
    _parseTSV(raw) {
        const rows = [];
        let i = 0;
        const len = raw.length;

        while (i < len) {
            const cells = [];
            // 解析一行的所有单元格
            while (i < len) {
                let cell = '';
                if (raw[i] === '"') {
                    // 引号字段 — 可能包含换行和tab
                    i++; // 跳过开头引号
                    while (i < len) {
                        if (raw[i] === '"') {
                            if (i + 1 < len && raw[i + 1] === '"') {
                                cell += '"'; // 转义引号
                                i += 2;
                            } else {
                                i++; // 跳过结尾引号
                                break;
                            }
                        } else {
                            cell += raw[i++];
                        }
                    }
                } else {
                    // 非引号字段
                    while (i < len && raw[i] !== '\t' && raw[i] !== '\n' && raw[i] !== '\r') {
                        cell += raw[i++];
                    }
                }
                cells.push(cell);
                // Tab = 下一列
                if (i < len && raw[i] === '\t') { i++; continue; }
                // 换行 = 下一行
                if (i < len && (raw[i] === '\n' || raw[i] === '\r')) {
                    if (raw[i] === '\r' && i + 1 < len && raw[i + 1] === '\n') i++;
                    i++;
                    break;
                }
            }
            if (cells.length > 0 && cells.some(c => c.trim())) {
                rows.push(cells); // 返回所有列，以支持 3 列解析
            }
        }
        return rows;
    }

    /**
     * 获取当前卡片模板的属性 (不含文本内容)
     */
    _getCurrentCardTemplate() {
        const props = {};
        if (this._selectedOv && this._selectedOv.type === 'textcard') {
            const ov = this._selectedOv;
            const keys = [
                'synthetic_bold_enabled',
                'card_color', 'card_opacity',
                'radius_tl', 'radius_tr', 'radius_bl', 'radius_br',
                'title_auto_shrink', 'title_max_glyph_height', 'title_override_w', 'title_override_h', 'title_valign',
                'title_adaptive_enabled', 'title_preferred_glyph_height', 'title_adaptive_min_w', 'title_adaptive_min_h', 'title_adaptive_max_w', 'title_adaptive_max_h', 'title_adaptive_max_lines',
                'title_font_family', 'title_fontsize', 'title_font_weight', 'title_bold', 'title_italic',
                'title_color', 'title_gradient_direction', 'title_align', 'title_uppercase', 'title_line_spacing', 'title_letter_spacing',
                'body_font_family', 'body_fontsize', 'body_font_weight', 'body_bold', 'body_italic',
                'body_color', 'body_gradient_direction', 'body_align', 'body_line_spacing', 'body_letter_spacing',
                'footer_font_family', 'footer_fontsize', 'footer_font_weight', 'footer_bold', 'footer_italic',
                'footer_color', 'footer_gradient_direction', 'footer_align', 'footer_line_spacing', 'footer_letter_spacing',
                'auto_fit', 'auto_center_v', 'debug_layout', 'debug_title', 'debug_body', 'debug_footer', 'layout_mode',
                'padding_top', 'padding_bottom', 'padding_left', 'padding_right',
                'title_body_gap', 'side_by_side_gap', 'side_by_side_title_ratio', 'w',
            ];
            for (const k of keys) {
                if (ov[k] !== undefined) props[k] = ov[k];
            }
        }
        return props;
    }

    _getCurrentScrollTemplate() {
        const props = {};
        if (this._selectedOv && this._selectedOv.type === 'scroll') {
            const ov = this._selectedOv;
            const keys = [
                'synthetic_bold_enabled',
                'font_family', 'fontsize', 'font_weight', 'bold', 'italic',
                'color', 'gradient_direction', 'scroll_gradient_direction', 'text_align', 'text_width',
                'use_stroke', 'stroke_color', 'stroke_width',
                'shadow_enabled', 'shadow_color', 'shadow_blur', 'shadow_opacity',
                'shadow_offset_x', 'shadow_offset_y',
                'scroll_x_anchor', 'scroll_from_x', 'scroll_from_y', 'scroll_to_x', 'scroll_to_y',
                'scroll_tw_active_color', 'scroll_tw_active_highlight', 'scroll_tw_active_scale', 'scroll_tw_active_scale_enabled', 'scroll_tw_cursor_anchor_x', 'scroll_tw_cursor_anchor_y', 'scroll_tw_cursor_angle', 'scroll_tw_cursor_char', 'scroll_tw_cursor_color', 'scroll_tw_cursor_enabled', 'scroll_tw_cursor_image', 'scroll_tw_cursor_kind', 'scroll_tw_cursor_offset_x', 'scroll_tw_cursor_offset_y', 'scroll_tw_cursor_scale', 'scroll_tw_end', 'scroll_tw_hide_unread', 'scroll_tw_keep_read_color', 'scroll_tw_reveal_type', 'scroll_tw_speech_sync', 'scroll_tw_start', 'scroll_tw_unrevealed_opacity', 'scroll_typewriter_enabled', 'scroll_speed', 'scroll_auto_stop', 'scroll_auto_stop_lead', 'scroll_static', 'scroll_auto_fit', 'scroll_min_fontsize',
                'scroll_title_fontsize', 'scroll_title_font_family', 'scroll_title_font_weight',
                'scroll_title_bold', 'scroll_title_color', 'scroll_title_gradient_direction', 'scroll_title_align', 'scroll_title_gap', 'scroll_title_fixed',
                'scroll_title_independent', 'scroll_title_x', 'scroll_title_y',
                'scroll_title_auto_fit', 'scroll_title_max_height',
                'feather_top', 'feather_bottom', 'feather_top_offset', 'feather_bottom_offset',
                'bg_enabled', 'bg_color', 'bg_opacity', 'bg_radius',
                'bg_padding_top', 'bg_padding_bottom', 'bg_padding_left', 'bg_padding_right', 'bg_fullscreen',
                'x', 'y', 'w', 'h',
            ];
            for (const k of keys) {
                if (ov[k] !== undefined) props[k] = ov[k];
            }
        }
        return props;
    }

    /**
     * 批量导入弹窗
     */
    _showBatchImportDialog() {
        return new Promise(resolve => {
            const overlay = document.createElement('div');
            overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:10000;display:flex;align-items:center;justify-content:center;';
            overlay.innerHTML = `
                <div style="background:#1e1e1e;border:1px solid var(--border-color);border-radius:12px;padding:24px;width:680px;max-height:90vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,0.5);">
                    <h3 style="margin:0 0 8px 0;color:var(--accent);font-size:16px;">批量导入文案 (高级映射)</h3>
                    <div style="display:flex;gap:8px;margin-bottom:10px;align-items:center;">
                        <label style="font-size:12px;color:#aaa;">覆层类型：</label>
                        <select id="rop-batch-type" style="padding:4px 8px;background:#141414;border:1px solid var(--border-color);border-radius:4px;color:#ddd;font-size:12px;">
                            <option value="textcard">📝 文字卡片</option>
                            <option value="scroll">🔄 滚动字幕</option>
                        </select>
                    </div>
                    <p id="rop-batch-help" style="margin:0 0 8px 0;color:#999;font-size:12px;line-height:1.5;">
                        请将任意多列的 Excel/Google 表格内容粘贴在下方。<br>
                        系统会自动检测列数，您可以在粘贴后自由分配 **哪一列** 对应 **哪个数据**（支持分离对齐专用的参考文案）。
                    </p>
                    <textarea id="rop-batch-data" style="flex:1;min-height:220px;padding:12px;background:#141414;border:1px solid var(--border-color);border-radius:8px;color:#ddd;font-size:13px;font-family:monospace;resize:vertical;" placeholder="从表格复制粘贴到此处..."></textarea>
                    
                    <div id="rop-batch-mapper" style="display:none;background:#2a2a3e;border:1px solid #444;border-radius:8px;padding:12px;margin-top:12px;">
                        <div style="font-size:12px;color:#ccc;margin-bottom:8px;border-bottom:1px solid #444;padding-bottom:4px;">识别到 <b id="rop-batch-col-count" style="color:var(--accent);">0</b> 列数据，请分配对应关系：</div>
                        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;font-size:12px;">
                            <div style="display:flex;justify-content:space-between;align-items:center;">
                                <span style="color:#aaa;">任务命名列</span>
                                <select id="rop-map-name" class="rop-select" style="width:100px;font-size:11px;"></select>
                            </div>
                            <div style="display:flex;justify-content:space-between;align-items:center;">
                                <span style="color:#a3e86c;">标题列</span>
                                <select id="rop-map-title" class="rop-select" style="width:100px;font-size:11px;"></select>
                            </div>
                            <div style="display:flex;justify-content:space-between;align-items:center;">
                                <span style="color:#6ec6ff;">正文列</span>
                                <select id="rop-map-body" class="rop-select" style="width:100px;font-size:11px;"></select>
                            </div>
                            <div style="display:flex;justify-content:space-between;align-items:center;">
                                <span style="color:#e8b839;" title="用于点击对齐生成字幕时的底层纯文本">对齐参考文案列</span>
                                <select id="rop-map-ref" class="rop-select" style="width:100px;font-size:11px;"></select>
                            </div>
                        </div>
                    </div>

                    <div style="display:flex;gap:8px;margin-top:12px;justify-content:flex-end;">
                        <button id="rop-batch-cancel" style="padding:8px 20px;background:#333;border:1px solid #555;border-radius:6px;color:#ccc;cursor:pointer;">取消</button>
                        <button id="rop-batch-ok" style="padding:8px 20px;background:var(--accent);border:none;border-radius:6px;color:#000;font-weight:bold;cursor:pointer;">导入并映射</button>
                    </div>
                </div>
            `;
            document.body.appendChild(overlay);

            const typeSelect = overlay.querySelector('#rop-batch-type');
            const textareaEl = overlay.querySelector('#rop-batch-data');
            const mapperEl = overlay.querySelector('#rop-batch-mapper');
            const mapName = overlay.querySelector('#rop-map-name');
            const mapTitle = overlay.querySelector('#rop-map-title');
            const mapBody = overlay.querySelector('#rop-map-body');
            const mapRef = overlay.querySelector('#rop-map-ref');
            const updateMappers = () => {
                const text = textareaEl.value;
                if (!text.trim()) { mapperEl.style.display = 'none'; return; }
                const rows = this._parseTSV(text);
                const cols = rows.length > 0 ? rows[0].length : 0;
                if (cols > 0) {
                    mapperEl.style.display = 'block';
                    overlay.querySelector('#rop-batch-col-count').innerText = cols;
                    let opts = `<option value="-1">-- 无 --</option>`;
                    for (let i = 0; i < cols; i++) opts += `<option value="${i}">第 ${i + 1} 列</option>`;
                    const refreshOptions = (selectEl, targetValue) => {
                        const cur = selectEl.value;
                        selectEl.innerHTML = opts;
                        if (targetValue !== undefined && parseInt(cur) === -1) selectEl.value = targetValue;
                        else if (cur && cur !== '-1') selectEl.value = cur;
                        else selectEl.value = targetValue !== undefined ? targetValue : "-1";
                    };
                    
                    // Defaults: (Name: Col 0), (Title: Col 1), (Body: Col 2), (Ref: None)
                    const nDefault = cols >= 3 ? 0 : -1;
                    const tDefault = cols >= 3 ? 1 : 0;
                    const bDefault = cols >= 3 ? 2 : (cols >= 2 ? 1 : 0);
                    refreshOptions(mapName, nDefault);
                    refreshOptions(mapTitle, tDefault);
                    refreshOptions(mapBody, bDefault);
                    refreshOptions(mapRef, -1);
                } else {
                    mapperEl.style.display = 'none';
                }
            };

            textareaEl.addEventListener('input', updateMappers);

            const close = (val) => {
                document.body.removeChild(overlay);
                resolve(val);
            };
            overlay.querySelector('#rop-batch-cancel').onclick = () => close(null);
            overlay.querySelector('#rop-batch-ok').onclick = () => {
                const data = textareaEl.value;
                const type = typeSelect.value;
                const mapping = {
                    name: parseInt(mapName.value),
                    title: parseInt(mapTitle.value),
                    body: parseInt(mapBody.value),
                    ref: parseInt(mapRef.value)
                };
                close({ data, type, mapping });
            };
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) close(null);
            });
            // 自动聚焦
            setTimeout(() => overlay.querySelector('#rop-batch-data').focus(), 100);
        });
    }

    _addTextOverlay() {
        const ReelsOverlay = window.ReelsOverlay;
        if (!ReelsOverlay) return;
        const ov = ReelsOverlay.createTextOverlay({
            content: '新文本',
            x: 200, y: 800, w: 680, h: 120,
            fontsize: 74, color: '#ffffff',
            start: 0, end: 5,
        });
        this._applyNewOverlaySlot(ov, 'script');
        if (this.videoCanvas) this.videoCanvas.addOverlay(ov);
        this._refreshList();
        this.selectOverlay(ov);
    }

    _addPhoneCtaOverlay() {
        const api = window.ReelsOverlay;
        if (!api?.createPhoneCtaOverlay || !this.videoCanvas) return;
        const ov = api.createPhoneCtaOverlay();
        this._applyNewOverlaySlot(ov, 'phone_cta', true);
        this.videoCanvas.addOverlay(ov);
        this._refreshList();
        this.selectOverlay(ov);
        this._requestRender();
    }

    _addDecorOverlay() {
        const api = window.ReelsOverlay;
        if (!api?.createDecorOverlay || !this.videoCanvas) return;
        const ov = api.createDecorOverlay();
        this._applyNewOverlaySlot(ov, 'particle');
        this.videoCanvas.addOverlay(ov);
        this._refreshList();
        this.selectOverlay(ov);
        this._requestRender();
    }

    _addScrollOverlay() {
        const ReelsOverlay = window.ReelsOverlay;
        if (!ReelsOverlay) return;
        const ov = ReelsOverlay.createScrollOverlay({
            content: '滚动字幕示例\n第二行\n第三行\n第四行\n第五行',
            start: 0, end: 10,
        });
        this._applyNewOverlaySlot(ov, 'scroll_subtitle');
        if (this.videoCanvas) this.videoCanvas.addOverlay(ov);
        this._refreshList();
        this.selectOverlay(ov);
    }

    async _openMediaLibrary() {
        let folderPath = localStorage.getItem('videokit_overlay_lib_path');
        let needsReselect = false;
        if (!folderPath) {
            if (window.electronAPI && window.electronAPI.selectDirectory) {
                folderPath = await window.electronAPI.selectDirectory();
                if (!folderPath) return;
                localStorage.setItem('videokit_overlay_lib_path', folderPath);
            } else {
                alert('环境不支持选择目录'); return;
            }
        }
        
        const loadItems = async () => {
            if (!window.electronAPI || !window.electronAPI.scanDirectory) return [];
            return await window.electronAPI.scanDirectory(folderPath);
        };
        
        let items = await loadItems();
        if (!items || items.length === 0) {
            if (confirm(`目录未找到或为空: ${folderPath}\n是否重新选择目录？`)) {
                if (window.electronAPI && window.electronAPI.selectDirectory) {
                    const newFolder = await window.electronAPI.selectDirectory();
                    if (newFolder) {
                        folderPath = newFolder;
                        localStorage.setItem('videokit_overlay_lib_path', newFolder);
                        items = await loadItems();
                    }
                }
            }
        }
        
        this._showMediaLibraryModal(folderPath, items);
    }
    
    _showMediaLibraryModal(folderPath, items) {
        let modal = document.getElementById('rop-library-modal');
        if (modal) modal.remove();
        
        modal = document.createElement('div');
        modal.id = 'rop-library-modal';
        modal.style.cssText = `
            position: fixed; inset: 0; background: rgba(0,0,0,0.85); z-index: 10000;
            display: flex; align-items: center; justify-content: center; backdrop-filter: blur(4px);
        `;
        
        const isMedia = (f) => /\.(png|jpg|jpeg|webp|gif|mp4|webm|mov)$/i.test(f);
        const folders = items.filter(i => i.isDirectory);
        const mediaFiles = items.filter(i => !i.isDirectory && isMedia(i.name));
        
        const rList = [];
        folders.forEach(f => rList.push({...f, icon: '📁', typeLabel: '序列帧'}));
        mediaFiles.forEach(m => rList.push({...m, icon: '🖼️', typeLabel: '媒体文件'}));
        
        const gridHtml = rList.map((item, idx) => `
            <div data-idx="${idx}" class="rop-lib-item" style="
                background: var(--bg-secondary); padding: 12px; border-radius: 8px; cursor: pointer;
                border: 1px solid var(--border-color); display: flex; flex-direction: column; align-items: center; gap: 8px;
                transition: all 0.2s;
            " onmouseover="this.style.borderColor='var(--accent-primary)';this.style.background='var(--hover-bg)'" 
               onmouseout="this.style.borderColor='var(--border-color)';this.style.background='var(--bg-secondary)'">
                <div style="font-size: 32px;">${item.icon}</div>
                <div style="font-size: 12px; color: #fff; text-align: center; word-break: break-all; width: 100%; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;">${item.name}</div>
                <div style="font-size: 10px; color: #888;">${item.typeLabel}</div>
            </div>
        `).join('');
        
        modal.innerHTML = `
            <div style="background: var(--bg-primary); width: 80%; max-width: 900px; height: 80vh; border-radius: 12px; display: flex; flex-direction: column; border: 1px solid var(--border-color); box-shadow: 0 10px 40px rgba(0,0,0,0.8);">
                <div style="padding: 16px 24px; border-bottom: 1px solid var(--border-color); display: flex; justify-content: space-between; align-items: center;">
                    <div>
                        <div style="font-size: 16px; font-weight: bold; color: #fff;">固定覆层素材库</div>
                        <div style="font-size: 12px; color: #888; margin-top: 4px; display: flex; gap: 8px; align-items:center;">
                            ${folderPath}
                            <button id="rop-lib-reselect" style="background:none; border:none; color: var(--accent-primary); cursor: pointer; font-size:11px; text-decoration:underline;">更改目录</button>
                        </div>
                    </div>
                    <button id="rop-lib-close" style="background:none; border:none; color: #fff; font-size: 24px; cursor: pointer;">&times;</button>
                </div>
                <div style="flex: 1; padding: 24px; overflow-y: auto; display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 16px; align-content: start;">
                    ${gridHtml || '<div style="grid-column: 1/-1; text-align: center; color: #666; padding: 40px;">目录中没有找到图片、视频或文件夹</div>'}
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        
        document.getElementById('rop-lib-close').onclick = () => modal.remove();
        document.getElementById('rop-lib-reselect').onclick = async () => {
            if (window.electronAPI && window.electronAPI.selectDirectory) {
                const newFolder = await window.electronAPI.selectDirectory();
                if (newFolder) {
                    localStorage.setItem('videokit_overlay_lib_path', newFolder);
                    modal.remove();
                    this._openMediaLibrary();
                }
            }
        };
        
        const itemsDom = modal.querySelectorAll('.rop-lib-item');
        itemsDom.forEach(dom => {
            dom.onclick = async () => {
                const item = rList[parseInt(dom.dataset.idx)];
                modal.remove();
                
                const ReelsOverlay = window.ReelsOverlay;
                if (!ReelsOverlay) return;
                
                const toUrl = (p) => (window.electronAPI && window.electronAPI.toFileUrl) ? window.electronAPI.toFileUrl(p) : p;
                
                if (item.isDirectory) {
                    // It's a sequence folder. Retrieve all images inside.
                    const subItems = await window.electronAPI.scanDirectory(item.path);
                    const seqFiles = subItems.filter(i => !i.isDirectory && /\.(png|jpg|jpeg|webp)$/i.test(i.name));
                    if (seqFiles.length === 0) {
                        alert('该文件夹中没有找到任何 png/jpg 序列帧图片。');
                        return;
                    }
                    seqFiles.sort((a, b) => a.name.localeCompare(b.name));
                    
                    const seqPaths = seqFiles.map(f => toUrl(f.path));
                    const ov = ReelsOverlay.createImageOverlay({
                        content: seqPaths[0],
                        x: 0, y: 0, w: 1080, h: 1920,
                        start: 0, end: Math.max(1, seqPaths.length / 30)
                    });
                    ov.type = 'video';
                    ov.name = '序列帧: ' + item.name;
                    ov.is_img_sequence = true;
                    ov.sequence_frames = seqPaths;
                    ov.fps = 30;
                    this._applyNewOverlaySlot(ov, 'media');
                    
                    if (this.videoCanvas) this.videoCanvas.addOverlay(ov);
                } else {
                    // Single file
                    const isVideo = /\.(mp4|webm|mov|gif)$/i.test(item.name);
                    const url = toUrl(item.path);
                    const ov = ReelsOverlay.createImageOverlay({
                        content: url,
                        x: 0, y: 0, w: 1080, h: 1920,
                        start: 0, end: 5
                    });
                    if (isVideo) ov.type = 'video';
                    ov.name = item.name;
                    this._applyNewOverlaySlot(ov, 'media');
                    
                    if (this.videoCanvas) this.videoCanvas.addOverlay(ov);
                }
                this._refreshList();
                this.selectOverlay(this.videoCanvas.overlayMgr.overlays[this.videoCanvas.overlayMgr.overlays.length - 1]);
            };
        });
    }

    _bindMediaDropTarget() {
        const target = this.container.querySelector('#rop-media-drop-target');
        if (!target) return;
        let entered = 0;
        const reset = () => {
            entered = 0;
            target.style.borderColor = 'rgba(96,165,250,.62)';
            target.style.background = 'rgba(59,130,246,.06)';
            target.style.color = '#93c5fd';
            target.textContent = '📥 拖入多个图片/视频，批量添加到当前任务组（沿用当前媒体设置）';
        };
        target.addEventListener('dragenter', event => {
            if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return;
            event.preventDefault(); event.stopPropagation();
            entered++;
            target.style.borderColor = '#60a5fa'; target.style.background = 'rgba(59,130,246,.18)';
            target.style.color = '#dbeafe';
            target.textContent = '松开即可添加到当前任务组的全部任务';
        });
        target.addEventListener('dragover', event => {
            event.preventDefault(); event.stopPropagation();
            event.dataTransfer.dropEffect = 'copy';
        });
        target.addEventListener('dragleave', event => {
            event.preventDefault(); event.stopPropagation();
            if (--entered <= 0) reset();
        });
        target.addEventListener('drop', event => {
            event.preventDefault(); event.stopPropagation(); reset();
            const files = Array.from(event.dataTransfer?.files || []);
            const paths = window.electronAPI?.consumeDroppedFilePaths?.() || [];
            files.forEach((file, index) => { if (paths[index]) file._nativePath = paths[index]; });
            // Some Electron builds provide native paths only through preload.
            const known = new Set(files.map(file => file._nativePath).filter(Boolean));
            for (const nativePath of paths) {
                if (!nativePath || known.has(nativePath)) continue;
                files.push({ name: String(nativePath).split(/[\\/]/).pop(), _nativePath: nativePath, path: nativePath });
            }
            this._addMediaFilesToTaskGroup(files);
        });
    }

    _pickBatchMediaForTaskGroup() {
        const input = document.createElement('input');
        input.type = 'file'; input.multiple = true;
        input.accept = 'image/*,video/mp4,video/webm,video/quicktime,video/x-matroska';
        input.onchange = event => this._addMediaFilesToTaskGroup(Array.from(event.target.files || []));
        input.click();
    }

    _addMediaFiles(files) {
        const ReelsOverlay = window.ReelsOverlay;
        if (!ReelsOverlay) return;
        const mediaPattern = /\.(png|jpe?g|webp|bmp|gif|mp4|mov|avi|mkv|webm|m4v)$/i;
        const videoPattern = /\.(mp4|mov|avi|mkv|webm|m4v|gif)$/i;
        const valid = (files || []).filter(file => mediaPattern.test(file?.name || ''));
        if (!valid.length) {
            if (typeof showToast === 'function') showToast('请拖入图片、视频或动图文件', 'warning');
            return;
        }
        const template = this._selectedOv && ['image', 'video'].includes(this._selectedOv.type)
            ? JSON.parse(JSON.stringify(this._selectedOv)) : null;
        const added = [];
        for (const file of valid) {
            const nativePath = (typeof getFileNativePath === 'function' ? getFileNativePath(file) : '') || file._nativePath || file.path || '';
            const content = nativePath && nativePath !== file.name && window.electronAPI?.toFileUrl
                ? window.electronAPI.toFileUrl(nativePath) : URL.createObjectURL(file);
            const ov = ReelsOverlay.createImageOverlay({
                content, x: 0, y: 0, w: 1080, h: 1920, start: 0, end: 9999,
            });
            // Copy the current media's presentation settings, but never its
            // identity, source, type-specific caches, or disabled state.
            if (template) {
                const id = ov.id;
                Object.assign(ov, template, { id, content, name: file.name || '覆层媒体', disabled: false });
                delete ov.media_folder_path; delete ov.media_folder_files; delete ov.media_folder_items;
                delete ov.is_img_sequence; delete ov.sequence_frames;
            } else {
                ov.name = file.name || '覆层媒体';
            }
            ov.type = videoPattern.test(file.name || '') ? 'video' : 'image';
            this._applyNewOverlaySlot(ov, 'media');
            if (this.videoCanvas) this.videoCanvas.addOverlay(ov);
            added.push(ov);
        }
        this._refreshList();
        if (added.length) this.selectOverlay(added[added.length - 1]);
        this._requestRender();
        if (typeof showToast === 'function') {
            showToast(`已批量添加 ${added.length} 个覆层媒体${template ? '（已沿用当前媒体设置）' : ''}`, 'success');
        }
    }

    _addMediaFilesToTaskGroup(files) {
        const ReelsOverlay = window.ReelsOverlay;
        if (!ReelsOverlay) return;
        const mediaPattern = /\.(png|jpe?g|webp|bmp|gif|mp4|mov|avi|mkv|webm|m4v)$/i;
        const videoPattern = /\.(mp4|mov|avi|mkv|webm|m4v|gif)$/i;
        const valid = (files || []).filter(file => mediaPattern.test(file?.name || ''));
        if (!valid.length) {
            if (typeof showToast === 'function') showToast('请选择或拖入图片、视频或动图文件', 'warning');
            return;
        }
        const tasks = this.videoCanvas?.getTaskGroupTasks?.() || [];
        const currentTask = window._reelsState?.tasks?.[window._reelsState?.selectedIdx];
        if (!currentTask || !tasks.length) {
            if (typeof showToast === 'function') showToast('请先选中一个任务', 'warning');
            return;
        }
        const template = this._selectedOv && ['image', 'video'].includes(this._selectedOv.type)
            ? JSON.parse(JSON.stringify(this._selectedOv)) : null;
        const makeOverlay = file => {
            const nativePath = (typeof getFileNativePath === 'function' ? getFileNativePath(file) : '') || file._nativePath || file.path || '';
            const content = nativePath && nativePath !== file.name && window.electronAPI?.toFileUrl
                ? window.electronAPI.toFileUrl(nativePath) : URL.createObjectURL(file);
            const ov = ReelsOverlay.createImageOverlay({ content, x: 0, y: 0, w: 1080, h: 1920, start: 0, end: 9999 });
            if (template) {
                const id = ov.id;
                Object.assign(ov, template, { id, content, name: file.name || '覆层媒体', disabled: false });
                delete ov.media_folder_path; delete ov.media_folder_files; delete ov.media_folder_items;
                delete ov.is_img_sequence; delete ov.sequence_frames;
            } else ov.name = file.name || '覆层媒体';
            ov.type = videoPattern.test(file.name || '') ? 'video' : 'image';
            this._applyNewOverlaySlot(ov, 'media');
            return ov;
        };
        let addedCount = 0;
        const currentAdded = [];
        for (const task of tasks) {
            const additions = valid.map(makeOverlay);
            if (task === currentTask) {
                for (const ov of additions) this.videoCanvas?.addOverlay(ov);
                currentAdded.push(...additions);
            } else {
                task.overlays = Array.isArray(task.overlays) ? task.overlays : [];
                task.overlays.push(...additions);
            }
            const keys = Array.isArray(task.visualOverlayOrder) ? task.visualOverlayOrder : [];
            task.visualOverlayOrder = [...keys, ...additions.map(ov => `overlay:${ov.id}`)];
            addedCount += additions.length;
        }
        this._refreshList();
        if (currentAdded.length) this.selectOverlay(currentAdded[currentAdded.length - 1]);
        this._requestRender();
        if (typeof _batchAutoSave === 'function') _batchAutoSave({ skipSync: true });
        if (typeof showToast === 'function') {
            showToast(`已将 ${valid.length} 个覆层媒体添加到当前任务组的 ${tasks.length} 个任务（共 ${addedCount} 层）${template ? '；已沿用当前媒体设置' : ''}`, 'success', 6000);
        }
    }

    _addImageOverlay() {
        // 弹出文件选择器
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        input.accept = 'image/*,video/mp4,video/webm,video/quicktime';
        input.onchange = (e) => {
            const files = Array.from(e.target.files);
            if (files.length === 0) return;

            const ReelsOverlay = window.ReelsOverlay;
            if (!ReelsOverlay) return;

            // 多选代表多个独立覆层媒体；序列帧仍可从“素材库”选择文件夹导入。
            if (files.length > 1) {
                this._addMediaFiles(files);
                return;
            }

            // 单个文件流程
            const file = files[0];
            let url;
            const nativePath = getFileNativePath(file);
            if (nativePath && nativePath !== file.name && window.electronAPI && window.electronAPI.toFileUrl) {
                url = window.electronAPI.toFileUrl(nativePath);
            }
            if (!url) {
                url = URL.createObjectURL(file);
            }
            const isVideo = file.type.startsWith('video/') || file.name.toLowerCase().endsWith('.gif');
            
            const ov = ReelsOverlay.createImageOverlay({
                content: url, x: 0, y: 0, w: 1080, h: 1920,
                start: 0, end: 9999,  // 9999 = 全程（跟随最终输出长度）
            });
            if (isVideo) ov.type = 'video';
            if (file.name) ov.name = file.name;
            this._applyNewOverlaySlot(ov, 'media');
            
            if (this.videoCanvas) this.videoCanvas.addOverlay(ov);
            this._refreshList();
            this.selectOverlay(ov);
        };
        input.click();
    }

    _applyNewOverlaySlot(overlay, fallbackKey = '', forceKey = false) {
        const select = this.container?.querySelector('#rop-layer-slot');
        let requestedKey = forceKey ? fallbackKey : (select?.value || fallbackKey);
        // GIF 是一种明确的默认业务层：未主动改层位时，不要归入普通媒体层。
        if ((!select?.value || select.value === 'media') && /\.gif(?:[?#].*)?$/i.test(String(overlay?.content || ''))) requestedKey = 'gif';
        if (!requestedKey || requestedKey === '__custom__') return overlay;
        const slots = window.ReelsLayerSlots;
        const autoNumbered = ['script', 'media', 'scroll_subtitle', 'title', 'gif', 'particle', 'phone_cta'].includes(requestedKey);
        const key = autoNumbered
            ? (slots?.nextKey?.(this.videoCanvas?.overlayMgr?.overlays || [], requestedKey, overlay) || requestedKey)
            : requestedKey;
        slots?.applyUnique?.(overlay,key,this.videoCanvas?.overlayMgr?.overlays || [],slots?.describe?.(key)?.label || select?.selectedOptions?.[0]?.textContent || '');
        // 文案层/仅标题层使用文字卡片时，明确初始化各自的文本结构；这
        // 不限制其它槽位承载图片、视频或 GIF。
        if (overlay?.type === 'textcard' && key === 'title') {
            overlay.body_text = '';
            overlay.footer_text = '';
        }
        // Most creation paths apply a slot before addOverlay(). Defer the
        // table refresh so the new layer is already present in task.overlays.
        setTimeout(() => this._refreshBatchSlotSchema(), 0);
        return overlay;
    }

    _refreshBatchSlotSchema() {
        if (typeof _batchTableState !== 'undefined') {
            const tabId = _batchTableState.activeTabId || 'default';
            delete _batchTableState.mediaLayerSchemas?.[tabId];
            delete _batchTableState.legacyMediaSlotMaps?.[tabId];
            const tab = typeof _getActiveTab === 'function' ? _getActiveTab() : null;
            if (tab) delete tab.mediaLayerSchema;
        }
        // 这里的覆层分类已直接写入当前任务。若立即重绘批量表，旧表格
        // DOM 会先执行一次“表格 → 任务”回写；其中残留的标题/文字卡片
        // 单元格在新层位尚不存在时会触发补层，表现为选择“仅标题层”
        // 莫名新增一张卡片。此次重绘只需要刷新列结构，严禁旧 DOM 回写。
        if (typeof _skipNextApply !== 'undefined') _skipNextApply = true;
        if (typeof _renderBatchTable === 'function') _renderBatchTable();
    }

    _hasLayerSlotConflict(overlay, slotKey) {
        return !!slotKey && (this.videoCanvas?.overlayMgr?.overlays || []).some(item => item !== overlay && item?.slotKey === slotKey);
    }

    _showLayerSlotSettings(overlay) {
        const slots = window.ReelsLayerSlots;
        const currentKey = String(overlay?.slotKey || '');
        const numbered = currentKey.match(/^(.+)_\d+$/);
        const currentBase = numbered?.[1] || currentKey || 'media';
        const currentLabel = overlay?.slotLabel || slots?.describe?.(currentKey)?.label || '';
        const esc = value => String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
        const options = (slots?.PRESETS || []).map(item => `<option value="${esc(item.key)}" ${item.key === currentBase ? 'selected' : ''}>${esc(item.label)}</option>`).join('');
        const modal = document.createElement('div');
        modal.style.cssText = 'position:fixed;inset:0;z-index:100110;background:rgba(0,0,0,.64);display:flex;align-items:center;justify-content:center;padding:20px;';
        modal.innerHTML = `<div style="width:min(430px,94vw);background:#171923;border:1px solid #4b5563;border-radius:10px;padding:16px;color:#e5e7eb;box-shadow:0 18px 50px rgba(0,0,0,.55);"><strong style="display:block;margin-bottom:12px;">覆层分类设置</strong><label style="display:flex;gap:7px;align-items:center;font-size:12px;margin:8px 0;"><input data-edit-type type="checkbox" checked> 修改层分类</label><label style="display:block;font-size:11px;color:#aab1c5;margin:8px 0 3px;">层分类</label><select data-type style="width:100%;padding:6px;background:#0f1118;color:#fff;border:1px solid #444;border-radius:5px;">${options}<option value="__custom__">自定义层分类…</option></select><label style="display:flex;gap:7px;align-items:center;font-size:12px;margin:12px 0 6px;"><input data-numbered type="checkbox" ${numbered ? 'checked' : ''}> 添加编号（同类可有多个层）</label><label style="display:block;font-size:11px;color:#aab1c5;margin:8px 0 3px;">分类显示名称（可修改）</label><input data-label value="${esc(currentLabel)}" style="width:100%;box-sizing:border-box;padding:6px;background:#0f1118;color:#fff;border:1px solid #444;border-radius:5px;"><div style="display:flex;justify-content:flex-end;gap:7px;margin-top:16px;"><button data-cancel style="padding:6px 12px;">取消</button><button data-save style="padding:6px 12px;background:#2563eb;color:#fff;border:0;border-radius:5px;">保存</button></div></div>`;
        const typeInput = modal.querySelector('[data-type]');
        const labelInput = modal.querySelector('[data-label]');
        const editType = modal.querySelector('[data-edit-type]');
        const numberedInput = modal.querySelector('[data-numbered]');
        const updateDisabled = () => { typeInput.disabled = !editType.checked; numberedInput.disabled = !editType.checked; };
        editType.onchange = updateDisabled;
        typeInput.onchange = () => { if (typeInput.value === '__custom__') labelInput.focus(); };
        modal.querySelector('[data-cancel]').onclick = () => modal.remove();
        modal.querySelector('[data-save]').onclick = () => {
            let base = currentBase;
            let label = labelInput.value.trim();
            if (editType.checked) {
                base = typeInput.value;
                if (base === '__custom__') {
                    if (!label) { alert('请输入自定义层分类名称'); return; }
                    base = slots?.customKey?.(label) || `custom:${label}`;
                }
            }
            const key = editType.checked
                ? (slots?.makeKey?.(this.videoCanvas?.overlayMgr?.overlays || [], base, numberedInput.checked, overlay) || base)
                : currentKey;
            if (!key) { alert('请先选择层分类'); return; }
            slots?.applyUnique?.(overlay,key,this.videoCanvas?.overlayMgr?.overlays || [],label);
            this._refreshBatchSlotSchema();
            this._refreshList();
            this.videoCanvas?.onOverlayChange?.(overlay);
            modal.remove();
        };
        modal.addEventListener('click', event => { if (event.target === modal) modal.remove(); });
        document.body.appendChild(modal);
    }

    _openLayerSlotAudit() {
        const tasks = this.videoCanvas?.getTaskGroupTasks?.() || [window._reelsState?.tasks?.[window._reelsState?.selectedIdx]].filter(Boolean);
        const esc = value => String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        const rows = tasks.map((task, index) => {
            const overlays = (task?.overlays || []).filter(ov => ov && !ov._insertClip);
            const slots = new Map();
            for (const ov of overlays) if (ov.slotKey) slots.set(ov.slotKey, [...(slots.get(ov.slotKey) || []), ov]);
            const duplicates = [...slots.entries()].filter(([, list]) => list.length > 1).map(([key]) => window.ReelsLayerSlots?.describe?.(key)?.label || key);
            const unclassified = overlays.filter(ov => !ov.slotKey).map(ov => ov.name || ov.type || '未命名层');
            const status = duplicates.length ? `⚠ 重复：${duplicates.join('、')}` : (unclassified.length ? `⏳ 未分类 ${unclassified.length} 层` : '✅ 已分类');
            return `<tr><td style="padding:7px;border-bottom:1px solid #30354a;white-space:nowrap;">${index + 1}</td><td style="padding:7px;border-bottom:1px solid #30354a;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${esc(task?.baseName || task?.fileName || '')}">${esc(task?.baseName || task?.fileName || `任务 ${index + 1}`)}</td><td style="padding:7px;border-bottom:1px solid #30354a;color:${duplicates.length ? '#fca5a5' : (unclassified.length ? '#fde68a' : '#86efac')};">${esc(status)}</td><td style="padding:7px;border-bottom:1px solid #30354a;color:#bfdbfe;">${esc([...slots.keys()].map(key => window.ReelsLayerSlots?.describe?.(key)?.label || key).join('、') || '—')}</td></tr>`;
        }).join('');
        const modal = document.createElement('div');
        modal.style.cssText = 'position:fixed;inset:0;z-index:100100;background:rgba(0,0,0,.65);display:flex;align-items:center;justify-content:center;padding:20px;';
        modal.innerHTML = `<div style="width:min(820px,96vw);max-height:80vh;overflow:auto;background:#171923;border:1px solid #4b5563;border-radius:10px;padding:16px;color:#e5e7eb;box-shadow:0 18px 50px rgba(0,0,0,.55);"><div style="display:flex;justify-content:space-between;gap:12px;align-items:center;"><strong>检查重复图层</strong><button data-close style="background:#30354a;color:#fff;border:0;border-radius:5px;padding:4px 8px;cursor:pointer;">关闭</button></div><p style="font-size:12px;color:#aab1c5;line-height:1.5;">此审核不会猜测或修改旧项目。请关闭后逐个任务在覆层列表中为“未分类层”选择明确层位；重复层位必须拆分为主/次/通用或自定义层位。</p><table style="width:100%;border-collapse:collapse;font-size:12px;"><thead><tr style="text-align:left;color:#a5b4fc;"><th style="padding:7px;">#</th><th style="padding:7px;">任务</th><th style="padding:7px;">状态</th><th style="padding:7px;">已分配层位</th></tr></thead><tbody>${rows || '<tr><td colspan="4" style="padding:12px;color:#94a3b8;">没有可审核任务</td></tr>'}</tbody></table></div>`;
        modal.querySelector('[data-close]').onclick = () => modal.remove();
        modal.addEventListener('click', event => { if (event.target === modal) modal.remove(); });
        document.body.appendChild(modal);
    }

    _bindSelectedMediaDropTarget() {
        const target = this.container.querySelector('#rop-media-source-drop-target');
        if (!target) return;
        let entered = 0;
        const reset = () => {
            entered = 0;
            target.style.borderColor = 'var(--border-color)';
            target.style.background = 'rgba(255,255,255,.025)';
        };
        target.addEventListener('dragenter', event => {
            if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return;
            event.preventDefault(); event.stopPropagation();
            entered++;
            target.style.borderColor = '#60a5fa';
            target.style.background = 'rgba(59,130,246,.18)';
        });
        target.addEventListener('dragover', event => {
            if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return;
            event.preventDefault(); event.stopPropagation();
            event.dataTransfer.dropEffect = 'copy';
        });
        target.addEventListener('dragleave', event => {
            event.preventDefault(); event.stopPropagation();
            if (--entered <= 0) reset();
        });
        target.addEventListener('drop', event => {
            event.preventDefault(); event.stopPropagation(); reset();
            // Capture entries synchronously: browsers clear DataTransfer after drop returns.
            const entries = Array.from(event.dataTransfer?.items || [])
                .filter(item => item.kind === 'file').map(item => item.webkitGetAsEntry?.() || null);
            const files = Array.from(event.dataTransfer?.files || []);
            const paths = window.electronAPI?.consumeDroppedFilePaths?.() || [];
            files.forEach((file, index) => { if (paths[index]) file._nativePath = paths[index]; });
            if (!files.length) paths.forEach(path => files.push({ name: path.split(/[\\/]/).pop(), _nativePath: path }));
            this._dropSelectedMedia(files, entries).catch(error => {
                console.warn('[Overlay] 拖入媒体失败', error);
                if (typeof showToast === 'function') showToast(`拖入失败：${error.message}`, 'error');
            });
        });
    }

    async _dropSelectedMedia(files, entries = []) {
        const ov = this._selectedOv;
        if (!ov || !['image', 'video'].includes(ov.type)) return;
        if (Math.max(files.length, entries.length) !== 1) {
            if (typeof showToast === 'function') showToast('请拖入一个媒体文件或一个循环文件夹', 'warning');
            return;
        }
        const file = files[0];
        const entry = entries[0];
        const nativePath = file && ((typeof getFileNativePath === 'function' ? getFileNativePath(file) : '') || file._nativePath || file.path || '');
        if (entry?.isDirectory || (nativePath && window.electronAPI?.isDirectory?.(nativePath))) {
            const token = ++this._mediaFolderSelectionSerial;
            this._mediaFolderSelectionTokens.set(ov, token);
            if (nativePath) {
                await this._loadSelectedMediaFolder(ov, nativePath, token);
            } else if (entry?.isDirectory) {
                const collected = [];
                const walk = async item => {
                    if (item.isFile) {
                        const media = await new Promise((resolve, reject) => item.file(resolve, reject));
                        if (/\.(mp4|mov|avi|mkv|webm|m4v|jpg|jpeg|png|webp|gif|bmp)$/i.test(media.name)) {
                            collected.push({ path: URL.createObjectURL(media), name: item.fullPath || media.name, isDirectory: false });
                        }
                        return;
                    }
                    const reader = item.createReader();
                    for (;;) {
                        const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
                        if (!batch.length) break;
                        for (const child of batch) await walk(child);
                    }
                };
                await walk(entry);
                await this._setSelectedMediaFolderFiles(ov, entry.name, collected, null, token);
            }
        } else if (file) {
            this._replaceSelectedMediaFile(ov, file);
        }
    }

    _replaceSelectedMediaFile(ov, file) {
        if (!/\.(png|jpe?g|webp|bmp|gif|mp4|mov|avi|mkv|webm|m4v)$/i.test(file.name || '')) {
            if (typeof showToast === 'function') showToast('请拖入图片、视频或动图文件', 'warning');
            return;
        }
        const path = (typeof getFileNativePath === 'function' ? getFileNativePath(file) : '') || file._nativePath || file.path || '';
        const content = path && path !== file.name && window.electronAPI?.toFileUrl ? window.electronAPI.toFileUrl(path) : URL.createObjectURL(file);
        // A file replacement must also cancel any older folder scan or duration probe.
        this._mediaFolderSelectionTokens.set(ov, ++this._mediaFolderSelectionSerial);
        ov.content = content;
        ov.type = /\.(mp4|mov|avi|mkv|webm|m4v|gif)$/i.test(file.name) ? 'video' : 'image';
        delete ov.media_folder_path; delete ov.media_folder_files; delete ov.media_folder_items;
        delete ov.media_folder_durations; delete ov.media_folder_duration_paths;
        delete ov._folderFramesByPath; delete ov._exportFolderImages;
        delete ov.is_img_sequence; delete ov.sequence_frames;
        this._syncFromOverlay(ov); this._refreshList(); this._requestRender();
        this.videoCanvas?.onOverlayChange?.(ov);
        window.ReelsPreviewV2?.requestRender?.();
    }

    _replaceSelectedMedia() {
        const ov = this._selectedOv;
        if (!ov || !['image', 'video'].includes(ov.type)) return;
        const input = document.createElement('input');
        input.type = 'file'; input.accept = 'image/*,video/*';
        input.onchange = e => {
            const file = e.target.files?.[0];
            if (file) this._replaceSelectedMediaFile(ov, file);
        };
        input.click();
    }

    async _pickSelectedMediaFolder() {
        const ov = this._selectedOv;
        if (!ov || !['image', 'video'].includes(ov.type)) return;
        const selectionToken = ++this._mediaFolderSelectionSerial;
        this._mediaFolderSelectionTokens.set(ov, selectionToken);
        let folder = '';
        try {
            if (window.electronAPI?.showOpenDialog) {
                const result = await window.electronAPI.showOpenDialog({ title: '选择覆层媒体循环文件夹', properties: ['openDirectory'] });
                folder = result?.filePaths?.[0] || '';
            } else if (window.bridge?.localFiles?.pickFolder) {
                folder = await window.bridge.localFiles.pickFolder({ title: '选择覆层媒体循环文件夹' }) || '';
            }
        } catch (error) {
            console.warn('[Overlay] 选择媒体文件夹失败', error);
        }
        // 浏览器/旧桌面壳的回退：仍允许用系统文件夹选择器读取其中的文件。
        if (!folder) {
            const input = document.createElement('input');
            input.type = 'file'; input.multiple = true; input.webkitdirectory = true;
            input.onchange = e => {
                const selected = Array.from(e.target.files || []);
                if (!selected.length) return;
                this._setSelectedMediaFolderFiles(ov, '', selected.map(file => ({
                    path: getFileNativePath(file) || URL.createObjectURL(file), name: file.name, isDirectory: false,
                })), null, selectionToken);
            };
            input.click();
            return;
        }
        await this._loadSelectedMediaFolder(ov, folder, selectionToken);
    }

    async _loadSelectedMediaFolder(ov, folder, selectionToken) {
        const exts = new Set(['mp4','mov','avi','mkv','webm','m4v','jpg','jpeg','png','webp','gif','bmp']);
        let entries = [];
        if (window.electronAPI?.scanDirectoryRecursive) entries = await window.electronAPI.scanDirectoryRecursive(folder, { maxDepth: 20 });
        else if (window.electronAPI?.scanDirectory) entries = await window.electronAPI.scanDirectory(folder);
        else { alert('已选择文件夹，但当前版本无法读取其中的媒体；请更新桌面版后重试。'); return; }
        await this._setSelectedMediaFolderFiles(ov, folder, entries, exts, selectionToken);
    }

    async _setSelectedMediaFolderFiles(ov, folder, entries, allowedExtensions = null, selectionToken = null) {
        if (selectionToken == null) {
            selectionToken = ++this._mediaFolderSelectionSerial;
            this._mediaFolderSelectionTokens.set(ov, selectionToken);
        }
        if (this._mediaFolderSelectionTokens.get(ov) !== selectionToken) return;
        const exts = allowedExtensions || new Set(['mp4','mov','avi','mkv','webm','m4v','jpg','jpeg','png','webp','gif','bmp']);
        const files = (entries || []).filter(item => !item.isDirectory && item.path && exts.has(String(item.name || item.path).split('.').pop().toLowerCase()))
            .sort((a,b) => String(a.name || a.path).localeCompare(String(b.name || b.path), undefined, { numeric: true })).map(item => item.path);
        if (!files.length) { alert('该文件夹没有图片或视频素材'); return; }
        // 在临时对象中探测时长。旧文件夹扫描即使晚返回，也没有机会写回
        // 当前覆层，从根源避免“已换目录却仍播放旧素材”。
        const staged = { media_folder_files: files, media_folder_interval: 0 };
        try { await window.ReelsOverlay.prepareFolderMedia(staged); }
        catch (error) { alert(error.message); }
        if (this._mediaFolderSelectionTokens.get(ov) !== selectionToken) return;
        ov.media_folder_path = folder || '通过文件夹选择器导入';
        ov.media_folder_files = files;
        ov.media_folder_interval = 0;
        ov.media_folder_durations = staged.media_folder_durations;
        ov.media_folder_duration_paths = staged.media_folder_duration_paths;
        delete ov._folderFramesByPath; delete ov._exportFolderImages;
        // 循环文件夹是此覆层自己的素材池；首个文件也立即作为当前来源，便于导出路径可见。
        ov.content = window.electronAPI?.toFileUrl ? window.electronAPI.toFileUrl(files[0]) : files[0];
        ov.type = /\.(mp4|mov|avi|mkv|webm|m4v|gif)$/i.test(files[0]) ? 'video' : 'image';
        // 暂停状态下画布不会自然推进到下一帧；这里立即为新文件夹首项建解码器，
        // loadeddata/canplay 触发后会自动重绘，避免“旧的没了，新的不出现”。
        window.ReelsOverlay.primeFolderMedia?.(ov);
        this._syncFromOverlay(ov); this._refreshList(); this._requestRender();
        this.videoCanvas?.onOverlayChange?.(ov);
        window.ReelsPreviewV2?.requestRender?.();
    }

    /**
     * 画中画媒体库：总目录下的每一个一级子目录都是一个独立的循环组；
     * 总目录中直接放置的媒体则是单文件循环。刻意不把子目录扁平化，避免
     * 例如“产品 A”和“产品 B”的素材被混到同一个循环里。
     */
    async _openPipMediaLibrary() {
        const ov = this._selectedOv;
        if (!ov || !['image', 'video'].includes(ov.type)) {
            alert('请先添加或选中一个图片/视频覆层，再选择画中画媒体。');
            return;
        }
        const mediaExts = new Set(['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v', 'jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp']);
        const videoExt = /\.(mp4|mov|avi|mkv|webm|m4v|gif)$/i;
        const natural = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
        const rootKey = 'reels_pip_media_library_root';
        let rootPath = localStorage.getItem(rootKey) || '';
        let selected = null;

        const backdrop = document.createElement('div');
        backdrop.style.cssText = 'position:fixed;inset:0;z-index:200080;background:rgba(0,0,0,.78);backdrop-filter:blur(6px);display:grid;place-items:center;padding:20px;box-sizing:border-box;';
        const dialog = document.createElement('section');
        dialog.style.cssText = 'width:min(1040px,96vw);height:min(720px,90vh);display:flex;flex-direction:column;background:#171923;border:1px solid rgba(96,165,250,.55);border-radius:12px;color:#e5e7eb;box-shadow:0 24px 80px rgba(0,0,0,.55);overflow:hidden;font-family:inherit;';
        const header = document.createElement('div');
        header.style.cssText = 'padding:14px 16px;border-bottom:1px solid rgba(148,163,184,.2);display:flex;gap:10px;align-items:center;flex-wrap:wrap;';
        header.innerHTML = '<div style="font-weight:700;font-size:16px;">🖼 画中画媒体库</div><div style="font-size:11px;color:#94a3b8;flex:1;min-width:180px;">一级子文件夹＝一组循环媒体；根目录的独立媒体＝自身循环</div>';
        const choose = document.createElement('button'); choose.className = 'rop-reset-all'; choose.textContent = rootPath ? '更换总文件夹' : '选择总文件夹';
        const close = document.createElement('button'); close.className = 'rop-reset-all'; close.textContent = '关闭';
        header.append(choose, close);
        const pathLabel = document.createElement('div');
        pathLabel.style.cssText = 'padding:8px 16px;font-size:11px;color:#93c5fd;background:rgba(59,130,246,.08);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
        const grid = document.createElement('div');
        grid.style.cssText = 'flex:1;overflow:auto;padding:16px;display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));align-content:start;gap:12px;';
        const footer = document.createElement('div');
        footer.style.cssText = 'padding:12px 16px;border-top:1px solid rgba(148,163,184,.2);display:flex;align-items:center;gap:10px;';
        const hint = document.createElement('span'); hint.style.cssText = 'font-size:11px;color:#94a3b8;flex:1;'; hint.textContent = '请选择一个素材组或独立媒体';
        const apply = document.createElement('button'); apply.className = 'rop-reset-all'; apply.textContent = '应用到当前覆层'; apply.disabled = true;
        footer.append(hint, apply); dialog.append(header, pathLabel, grid, footer); backdrop.append(dialog); document.body.append(backdrop);
        const remove = () => backdrop.remove(); close.onclick = remove; backdrop.onclick = e => { if (e.target === backdrop) remove(); };

        const setThumb = async (img, filePath) => {
            try {
                const thumb = videoExt.test(filePath)
                    ? await window.electronAPI?.getVideoThumbnail?.(filePath, 240)
                    : await window.electronAPI?.getLocalThumbnail?.(filePath);
                const url = thumb ? (window.electronAPI?.toFileUrl?.(thumb) || thumb) : (window.electronAPI?.toFileUrl?.(filePath) || filePath);
                img.src = url;
            } catch (_) { /* leave the neutral placeholder */ }
        };
        const chooseItem = (item, card) => {
            selected = item; apply.disabled = false;
            grid.querySelectorAll('[data-pip-library-card]').forEach(el => el.style.outline = 'none');
            card.style.outline = '2px solid #60a5fa';
            hint.textContent = item.kind === 'folder'
                ? `已选“${item.name}”：${item.files.length} 个素材将按文件名顺序循环`
                : `已选“${item.name}”：该媒体将自身循环`;
        };
        const render = items => {
            grid.replaceChildren(); selected = null; apply.disabled = true;
            if (!items.length) {
                const empty = document.createElement('div'); empty.style.cssText = 'grid-column:1/-1;color:#fbbf24;padding:30px 0;text-align:center;';
                empty.textContent = '此总文件夹中没有可用的子文件夹或媒体文件。'; grid.append(empty); return;
            }
            for (const item of items) {
                const card = document.createElement('button'); card.type = 'button'; card.dataset.pipLibraryCard = '1';
                card.style.cssText = 'border:1px solid rgba(148,163,184,.25);border-radius:8px;background:#202433;color:#e5e7eb;padding:0;text-align:left;overflow:hidden;cursor:pointer;min-width:0;';
                const firstPath = item.files[0]?.path || item.path;
                // 视频卡片直接使用静音循环预览，避免不同编码/时长的素材在
                // FFmpeg 截帧失败时只显示破图；图片仍使用静态缩略图。
                const isVideo = videoExt.test(firstPath);
                const preview = document.createElement(isVideo ? 'video' : 'img');
                // 媒体库用于挑选素材，优先完整展示原始构图；留出的区域以深色底衬托，
                // 不使用 cover 裁掉竖屏/横屏视频的边缘。
                preview.style.cssText = 'display:block;width:100%;height:116px;object-fit:contain;background:#111827;';
                if (isVideo) {
                    preview.muted = true; preview.loop = true; preview.autoplay = true;
                    preview.playsInline = true; preview.preload = 'metadata';
                    preview.src = window.electronAPI?.toFileUrl?.(firstPath) || firstPath;
                } else {
                    preview.alt = '';
                }
                const info = document.createElement('div'); info.style.cssText = 'padding:8px;';
                const name = document.createElement('div'); name.style.cssText = 'font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;'; name.textContent = item.name; name.title = item.name;
                const meta = document.createElement('div'); meta.style.cssText = 'font-size:10px;color:#93c5fd;margin-top:4px;';
                meta.textContent = item.kind === 'folder' ? `📁 ${item.files.length} 个素材 · 组内循环` : '🎬 单文件 · 自身循环';
                info.append(name, meta); card.append(preview, info); card.onclick = () => chooseItem(item, card); grid.append(card);
                // files 保留完整扫描条目供“应用”时写入循环列表；缩略图 API
                // 则只接收本地路径字符串，不能直接传条目对象。
                if (!isVideo) setThumb(preview, firstPath);
            }
        };
        const scan = async () => {
            pathLabel.textContent = rootPath ? `总文件夹：${rootPath}` : '请选择包含素材子文件夹的总文件夹';
            if (!rootPath) { grid.replaceChildren(); return; }
            grid.innerHTML = '<div style="grid-column:1/-1;color:#93c5fd;padding:30px 0;text-align:center;">正在读取媒体库…</div>';
            try {
                const top = await window.electronAPI?.scanDirectory?.(rootPath) || [];
                const items = [];
                const dirs = top.filter(entry => entry?.isDirectory).sort((a, b) => natural(a.name, b.name));
                for (const dir of dirs) {
                    const entries = await window.electronAPI?.scanDirectoryRecursive?.(dir.path, { maxDepth: 20 }) || [];
                    const files = entries.filter(entry => !entry?.isDirectory && entry?.path && mediaExts.has(String(entry.name || entry.path).split('.').pop().toLowerCase()))
                        .sort((a, b) => natural(a.name || a.path, b.name || b.path));
                    if (files.length) items.push({ kind: 'folder', name: dir.name, path: dir.path, files });
                }
                top.filter(entry => !entry?.isDirectory && entry?.path && mediaExts.has(String(entry.name || entry.path).split('.').pop().toLowerCase()))
                    .sort((a, b) => natural(a.name || a.path, b.name || b.path))
                    .forEach(file => items.push({ kind: 'file', name: file.name, path: file.path, files: [file] }));
                render(items);
            } catch (error) {
                const failure = document.createElement('div');
                failure.style.cssText = 'grid-column:1/-1;color:#fca5a5;padding:30px 0;text-align:center;';
                failure.textContent = `读取媒体库失败：${String(error?.message || error)}`;
                grid.replaceChildren(failure);
            }
        };
        choose.onclick = async () => {
            try {
                const hasDialog = typeof window.electronAPI?.showOpenDialog === 'function';
                const result = hasDialog ? await window.electronAPI.showOpenDialog({ title: '选择画中画媒体库总文件夹', properties: ['openDirectory'] }) : null;
                const picked = hasDialog ? result?.filePaths?.[0] : await window.electronAPI?.selectDirectory?.();
                if (!picked) return;
                rootPath = picked; localStorage.setItem(rootKey, rootPath); await scan();
            } catch (error) { alert(`选择媒体库失败：${error.message || error}`); }
        };
        apply.onclick = async () => {
            if (!selected) return;
            if (selected.kind === 'folder') {
                await this._setSelectedMediaFolderFiles(ov, selected.path, selected.files, mediaExts);
            } else {
                delete ov.media_folder_path; delete ov.media_folder_files; delete ov.media_folder_items;
                ov.content = window.electronAPI?.toFileUrl ? window.electronAPI.toFileUrl(selected.path) : selected.path;
                ov.type = videoExt.test(selected.path) ? 'video' : 'image'; ov.media_loop = true;
                this._syncFromOverlay(ov); this._refreshList(); this._requestRender();
            }
            ov.name = selected.name;
            this._refreshList();
            remove();
        };
        await scan();
    }

    _duplicateOverlay() {
        if (!this._selectedOv) return;
        const clone = JSON.parse(JSON.stringify(this._selectedOv, (key, val) => key === '_allOverlays' ? undefined : val));
        clone.id = 'ov_' + Date.now();
        clone.x += 30;
        clone.y += 30;
        if (this.videoCanvas) this.videoCanvas.addOverlay(clone);
        this._refreshList();
        this.selectOverlay(clone);
    }

    _copySelectedOverlayToTasks() {
        const source = this._selectedOv;
        const tasks = window._reelsState?.tasks || [];
        const currentTask = tasks[window._reelsState?.selectedIdx];
        const taskNumbers = new Map(tasks.map((task,index) => [task,index+1]));
        const scoped = this.videoCanvas?.getTaskGroupTasks?.();
        const candidates = (Array.isArray(scoped) ? scoped : (window._reelsState?.tasks || []))
            .filter(task => task && task !== currentTask);
        if (!source) { if (typeof showToast === 'function') showToast('请先在覆层列表中选择要复制的层', 'warning'); return; }
        if (!currentTask || !candidates.length) { if (typeof showToast === 'function') showToast('没有可粘贴的其他任务', 'info'); return; }

        const backdrop = document.createElement('div');
        backdrop.style.cssText = 'position:fixed;inset:0;z-index:200120;background:rgba(0,0,0,.65);display:grid;place-items:center;padding:20px;box-sizing:border-box;';
        const dialog = document.createElement('section');
        dialog.style.cssText = 'width:min(620px,95vw);max-height:80vh;display:flex;flex-direction:column;background:#171923;border:1px solid rgba(96,165,250,.55);border-radius:12px;color:#e5e7eb;box-shadow:0 24px 80px rgba(0,0,0,.55);overflow:hidden;';
        const header = document.createElement('div');
        header.style.cssText = 'padding:14px 16px;border-bottom:1px solid rgba(148,163,184,.2);display:flex;gap:10px;align-items:center;';
        const title = document.createElement('div'); title.style.cssText = 'font-weight:700;flex:1;';
        const layerName = source.name || source.title_text || source.content || source.type || '当前覆层';
        title.textContent = `📤 将「${String(layerName).slice(0, 48)}」粘贴到其他任务`;
        const close = document.createElement('button'); close.className = 'rop-reset-all'; close.textContent = '关闭';
        header.append(title, close);
        const sourceInfo = document.createElement('div');
        sourceInfo.style.cssText = 'padding:10px 16px;color:#c4b5fd;font-size:12px;border-bottom:1px solid rgba(148,163,184,.16);';
        sourceInfo.textContent = `来源：任务 #${taskNumbers.get(currentTask)}（当前任务，不在目标列表中）。下方编号与左侧任务列表一致。`;
        const thumbnailControl = document.createElement('label');
        thumbnailControl.style.cssText = 'padding:8px 16px;display:flex;align-items:center;gap:7px;font-size:12px;color:#bfdbfe;';
        const showThumbnails = document.createElement('input');showThumbnails.type='checkbox';
        thumbnailControl.append(showThumbnails,document.createTextNode('显示背景缩略图'));
        const controls = document.createElement('label'); controls.style.cssText = 'padding:10px 16px;border-bottom:1px solid rgba(148,163,184,.16);font-size:12px;color:#bfdbfe;display:flex;align-items:center;gap:7px;';
        const all = document.createElement('input'); all.type = 'checkbox'; all.checked = true;
        controls.append(all, document.createTextNode(`全选其余 ${candidates.length} 个任务（每个任务会生成独立覆层）`));
        const list = document.createElement('div'); list.style.cssText = 'padding:8px 16px;overflow:auto;display:grid;gap:5px;';
        const choices = candidates.map((task, index) => {
            const label = document.createElement('label'); label.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px;border:1px solid rgba(148,163,184,.2);border-radius:6px;cursor:pointer;font-size:12px;';
            const check = document.createElement('input'); check.type = 'checkbox'; check.checked = true;
            const number = document.createElement('strong');
            number.textContent = `#${taskNumbers.get(task) || '—'}`;
            number.title = '左侧任务列表编号';
            number.style.cssText = 'flex-shrink:0;min-width:4ch;color:#93c5fd;font-variant-numeric:tabular-nums;';
            const thumbnail = document.createElement('div');thumbnail.hidden=true;
            thumbnail.style.cssText = 'width:40px;height:64px;flex-shrink:0;background:#090b12;border-radius:4px;overflow:hidden;';
            const name = task.fileName || task.filename || task.name || task.bgPath?.split(/[\\/]/).pop() || `任务 ${index + 1}`;
            const text = document.createElement('span'); text.textContent = name; text.title = name;
            text.style.cssText='min-width:0;overflow-wrap:anywhere;';
            check.setAttribute('aria-label',`选择任务 #${taskNumbers.get(task) || '—'}：${name}`);
            label.append(check,number,thumbnail,text); list.append(label); return { task, check, thumbnail };
        });
        let thumbnailLoader=null,thumbnailsCreated=false;
        showThumbnails.onchange=()=>{
            choices.forEach(item=>{item.thumbnail.hidden=!showThumbnails.checked;});
            thumbnailLoader?.dispose();thumbnailLoader=null;
            if(!showThumbnails.checked)return;
            if(!thumbnailsCreated){
                for(const {task,thumbnail} of choices){
                    const pool=task.bgMode==='multi'?(task.bgClipActivePool?.length?task.bgClipActivePool:task.bgClipPool || []):[];
                    const first=pool[0];
                    const path=(typeof first==='string'?first:first?.path) || task.bgPath || task.videoPath || task.contentVideoPath || '';
                    if(!path){thumbnail.textContent='无背景';continue;}
                    const url=/^(file:|local-media:|blob:|data:|https?:)/i.test(path)?path:(window.electronAPI?.toFileUrl?.(path) || path);
                    const isImage=/\.(png|jpe?g|webp|gif|bmp)(?:[?#]|$)/i.test(path);
                    const media=document.createElement(isImage?'img':'video');
                    media.style.cssText='width:100%;height:100%;object-fit:contain;';
                    media.title='背景素材缩略图';media.crossOrigin='anonymous';
                    if(isImage){media.loading='lazy';media.alt='背景素材缩略图';media.src=url;}
                    else {media.className='rbt-thumb-previewable';media.preload='none';media.muted=true;media.dataset.thumbSrc=url+'#t=0.1';}
                    thumbnail.append(media);
                }
                thumbnailsCreated=true;
            }
            thumbnailLoader=window.BatchThumbnailLoader?.hydrate(list,{independent:true});
        };
        all.onchange = () => choices.forEach(item => { item.check.checked = all.checked; });
        choices.forEach(item => { item.check.onchange = () => { all.checked = choices.every(choice => choice.check.checked); }; });
        const footer = document.createElement('div'); footer.style.cssText = 'padding:12px 16px;border-top:1px solid rgba(148,163,184,.2);display:flex;gap:8px;justify-content:flex-end;';
        const apply = document.createElement('button'); apply.className = 'rop-reset-all'; apply.textContent = '粘贴到已选任务';
        const cancel = document.createElement('button'); cancel.className = 'rop-reset-all'; cancel.textContent = '取消';
        footer.append(cancel, apply); dialog.append(header, sourceInfo,thumbnailControl,controls, list, footer); backdrop.append(dialog); document.body.append(backdrop);
        const dismiss = () => {thumbnailLoader?.dispose();backdrop.remove();}; close.onclick = dismiss; cancel.onclick = dismiss; backdrop.onclick = event => { if (event.target === backdrop) dismiss(); };
        apply.onclick = () => {
            const selected = choices.filter(item => item.check.checked).map(item => item.task);
            if (!selected.length) { if (typeof showToast === 'function') showToast('请至少选择一个目标任务', 'warning'); return; }
            selected.forEach(task => {
                const clone = JSON.parse(JSON.stringify(source, (key, value) => key === '_allOverlays' ? undefined : value));
                clone.id = `ov_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
                task.overlays = Array.isArray(task.overlays) ? task.overlays : [];
                task.overlays.push(clone);
                task.visualOverlayOrder = [...(Array.isArray(task.visualOverlayOrder) ? task.visualOverlayOrder : []), `overlay:${clone.id}`];
            });
            // 非当前任务没有临时画布代理，需显式同步标签页并立即持久化。
            if (typeof _syncTasksToActiveTab === 'function') _syncTasksToActiveTab();
            if (typeof _batchAutoSave === 'function') _batchAutoSave({ skipSync: true });
            dismiss();
            if (typeof showToast === 'function') showToast(`已将覆层粘贴到 ${selected.length} 个任务`, 'success');
        };
    }

    _deleteOverlay() {
        if(window.ReelsOverviewBatch?.deleteSelected(this))return;
        if (!this._selectedOv) return;
        if (this.videoCanvas) this.videoCanvas.removeOverlay(this._selectedOv.id);
        this._selectedOv = null;
        this._refreshList();
        this.container.querySelector('#rop-props').style.display = 'none';
    }

    // ═══════════════════════════════════════════════
    // 列表
    // ═══════════════════════════════════════════════

    _refreshList() {
        const list = this.container.querySelector('#rop-overlay-list');
        if (!list || !this.videoCanvas) return;

        const overlayAboveSubtitle = this.container.querySelector('#rop-overlay-above-subtitle');
        if (overlayAboveSubtitle) overlayAboveSubtitle.checked = this.videoCanvas.getOverlayAboveSubtitle?.() !== false;

        // 面板显示顺序必须与时间线/预览/导出使用的合成栈一致。
        // getOrderedOverlays 会返回底到顶的普通覆层；列表反转后仍保持“顶层在最上”。
        const overlays = this.videoCanvas.getOrderedOverlays?.() || this.videoCanvas.overlayMgr.overlays || [];
        const defaulted = overlays.filter(overlay => window.ReelsLayerSlots?.ensureDefault?.(overlay, overlays));
        if (defaulted.length) {
            // 同步回任务数据并让批量表重新建立稳定槽位列；只在旧模板
            // 首次打开时发生一次，不会覆盖已有 slotKey。
            defaulted.forEach(overlay => this.videoCanvas?.onOverlayChange?.(overlay));
            setTimeout(() => this._refreshBatchSlotSchema(), 0);
        }
        if (overlays.length === 0) {
            list.innerHTML = '<div class="rop-empty">暂无覆层，点击上方按钮添加</div>';
            return;
        }

        const mediaLabel = (ov) => {
            const folderPath = String(ov.media_folder_path || '');
            const source = folderPath || String(ov.content || '');
            if (!source || /^blob:/i.test(source)) return '';
            let decoded = source.replace(/^file:\/\//i, '');
            try { decoded = decodeURIComponent(decoded); } catch (_) { }
            const filename = decoded.split(/[\\/]/).filter(Boolean).pop() || '';
            return filename || '';
        };
        const mediaKind = (ov) => {
            if (!['image', 'video'].includes(ov.type)) return null;
            // GIF 在画布中通常按 image 处理，因此不能只依赖 overlay type。
            // 文件夹循环时，列表名可以是文件夹名，但格式必须从当前实际播放
            // 的 content（或素材池首项）读取，不能把“视频”当成文件后缀。
            const pathCandidates = [ov.content, ...(Array.isArray(ov.media_folder_files) ? ov.media_folder_files.slice(0, 1) : []), ov.name]
                .map(value => String(value || '').split(/[\\/]/).pop().split('?')[0].toLowerCase());
            const filename = pathCandidates.find(value => value.includes('.')) || '';
            const ext = filename.includes('.') ? filename.split('.').pop() : '';
            if (ext === 'gif') return { icon: '🔁', label: 'GIF', ext: 'GIF' };
            if (['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v', 'wmv', 'flv'].includes(ext) || ov.type === 'video') {
                return { icon: '🎬', label: '视频', ext: ext ? ext.toUpperCase() : '未知' };
            }
            return { icon: '🖼️', label: '图片', ext: ext ? ext.toUpperCase() : '未知' };
        };
        const escapeHtml = (value) => String(value || '')
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        list.innerHTML = overlays.slice().reverse().map(ov => {
            const isSelected = this._selectedOv?.id === ov.id;
            const kind = mediaKind(ov);
            const icon = ov.is_phone_cta ? '📞' : kind?.icon || (ov.type === 'text' ? '📝' : (ov.type === 'textcard' ? '📋' : (ov.type === 'scroll' ? '🔄' : (ov.type === 'solid_mask' ? '🔳' : ov.type === 'decor' ? '✨' : '🖼️'))));
            const lockIcon = ov.fixed_text ? '🔒' : '';
            let label = ov.name;
            const isGenericMediaName = !label || ['图片', '视频/动图', '覆层媒体', '未命名媒体'].includes(String(label).trim());
            if (['image', 'video'].includes(ov.type) && isGenericMediaName) {
                label = mediaLabel(ov) || (ov.type === 'video' ? '视频/动图' : '图片');
            }
            if (!label) {
                if (ov.type === 'textcard') label = (ov.title_text || '').slice(0, 15) || '文字卡片';
                else if (ov.type === 'solid_mask') label = '纯色蒙版';
                else if (ov.type === 'decor') label = window.ReelsOverlay?.DECOR_OVERLAY_STYLES?.[ov.decor_style]?.name || '粒子';
                else if (ov.type === 'scroll') label = '滚动: ' + (ov.content || '').split('\n')[0].slice(0, 12);
                else if (ov.type === 'text') label = (ov.content || '').slice(0, 15) || '文本';
                else label = (ov.type==='video' ? '视频/动图' : '图片');
            }
            const opacityStyle = ov.disabled ? 'opacity: 0.5; filter: grayscale(1);' : '';
            const eyeIcon = ov.disabled ? '🙈' : '👁️'; 
            const fullLabel = ['image', 'video'].includes(ov.type) ? (mediaLabel(ov) || label) : label;
            const slotLabel = ov.slotLabel || window.ReelsLayerSlots?.describe?.(ov.slotKey)?.label || '';
            const tooltip = `${slotLabel ? `[${slotLabel}] ` : ''}${kind ? `${kind.label}：` : ''}${fullLabel}`;
            const slotChoices = window.ReelsLayerSlots?.PRESETS || [];
            const slotOptions = [
                '<option value="">未分类</option>',
                ...slotChoices.map(item => `<option value="${escapeHtml(item.key)}" ${ov.slotKey === item.key ? 'selected' : ''}>${escapeHtml(item.label)}</option>`),
                '<option value="__custom__">自定义层位…</option>',
                '<option value="__manage__">⚙ 分类设置…</option>',
                (ov.slotKey && !slotChoices.some(item => item.key === ov.slotKey)
                    ? `<option value="${escapeHtml(ov.slotKey)}" selected>${escapeHtml(slotLabel)}</option>` : ''),
            ].join('');
            return `<div class="rop-list-item ${isSelected ? 'selected' : ''}" data-id="${ov.id}" style="${opacityStyle}" title="${escapeHtml(tooltip)}">
                <span class="rop-list-arrow">${isSelected ? '▼' : '▶'}</span>
                ${icon}${kind ? `<span class="rop-list-media-ext" title="${escapeHtml(kind.label + ' 格式：' + kind.ext)}" style="font-size:9px;line-height:16px;padding:0 3px;border-radius:3px;background:rgba(148,163,184,.2);color:#cbd5e1;font-weight:700;letter-spacing:.15px;">${escapeHtml(kind.ext)}</span>` : ''}${slotLabel ? `<span title="固定层位：${escapeHtml(slotLabel)}" style="font-size:9px;line-height:16px;padding:0 3px;border-radius:3px;background:rgba(96,165,250,.20);color:#bfdbfe;font-weight:700;white-space:nowrap;">${escapeHtml(slotLabel)}</span>` : ''} <span class="rop-list-label" title="${escapeHtml(tooltip)}">${lockIcon}${escapeHtml(label)}</span>
                <select class="rop-list-slot" data-id="${ov.id}" title="设置固定业务层位；批量替换和删除按此层位定位" style="max-width:96px;font-size:10px;padding:1px 2px;">${slotOptions}</select>
                <span class="rop-list-time">${ov.start?.toFixed(1) || 0}s–${(ov.end >= 9999 ? '全程' : (ov.end?.toFixed(1) || 0) + 's')}</span>
                <button class="rop-list-edit-name" data-id="${ov.id}" title="重命名此图层">✏️</button>
                <button class="rop-list-toggle-eye" data-id="${ov.id}" title="${ov.disabled ? '启用 (取消隐藏)' : '临时禁用 (隐藏)'}">${eyeIcon}</button>
                <button class="rop-list-move-up" data-id="${ov.id}" title="层级上移 (置顶/覆盖其他)">⬆️</button>
                <button class="rop-list-move-down" data-id="${ov.id}" title="层级下移 (置底/被其他覆盖)">⬇️</button>
                <button class="rop-list-del" data-id="${ov.id}" title="删除此覆层">✕</button>
            </div>`;
        }).join('');

        list.querySelectorAll('.rop-list-item').forEach(el => {
            // Click label to select/toggle
            el.addEventListener('click', (e) => {
                if (e.target.classList.contains('rop-list-del')) return; // don't select when clicking delete
                const ov = (this.videoCanvas?.overlayMgr?.overlays || []).find(o => o.id === el.dataset.id);
                if (!ov) return;
                if (this._selectedOv?.id === ov.id) {
                    // Click again to collapse
                    this.deselectOverlay();
                } else {
                    this.selectOverlay(ov);
                }
                this._refreshList();
            });
        });

        list.querySelectorAll('.rop-list-slot').forEach(select => {
            select.addEventListener('click', event => event.stopPropagation());
            select.addEventListener('change', async event => {
                event.stopPropagation();
                const ov = (this.videoCanvas?.overlayMgr?.overlays || []).find(item => item.id === select.dataset.id);
                if (!ov) return;
                let selectedKey = select.value;
                let selectedLabel = select.selectedOptions?.[0]?.textContent || '';
                if (selectedKey === '__manage__') {
                    this._showLayerSlotSettings(ov);
                    this._refreshList();
                    return;
                }
                if (selectedKey === '__custom__') {
                    const name = await _showInputDialog('自定义层位名称', '例如：产品展示层', '');
                    if (!name || !name.trim()) { this._refreshList(); return; }
                    selectedKey = window.ReelsLayerSlots?.customKey?.(name) || `custom:${name.trim()}`;
                    selectedLabel = name.trim();
                }
                if (selectedKey) {
                    window.ReelsLayerSlots?.applyUnique?.(ov,selectedKey,this.videoCanvas?.overlayMgr?.overlays || [],selectedLabel);
                }
                else { delete ov.slotKey; delete ov.slotLabel; }
                this._refreshBatchSlotSchema();
                this._refreshList();
                this.videoCanvas?.onOverlayChange?.(ov);
                this._requestRender();
            });
        });

        // Disable/Enable toggles
        list.querySelectorAll('.rop-list-toggle-eye').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const id = btn.dataset.id;
                const ov = (this.videoCanvas?.overlayMgr?.overlays || []).find(o => o.id === id);
                if (ov) {
                    ov.disabled = !ov.disabled;
                    this._refreshList();
                    if (this.videoCanvas) this.videoCanvas.render();
                    if (typeof this.videoCanvas?.onOverlayChange === 'function') this.videoCanvas.onOverlayChange(ov);
                }
            });
        });

        // Edit Name
        list.querySelectorAll('.rop-list-edit-name').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const id = btn.dataset.id;
                const ov = (this.videoCanvas?.overlayMgr?.overlays || []).find(o => o.id === id);
                if (ov) {
                    const newName = await this._showLayerNameDialog(ov.name || '');
                    if (newName !== null) {
                        ov.name = newName; // If empty string, it clears the custom name
                        if (this._selectedOv?.id === id) {
                            this._val('rop-name', ov.name);
                        }
                        this._refreshList();
                        if (typeof this.videoCanvas?.onOverlayChange === 'function') this.videoCanvas.onOverlayChange(ov);
                    }
                }
            });
        });

        // Move Up：改写任务的唯一合成顺序，不再只交换临时 overlayMgr 数组。
        list.querySelectorAll('.rop-list-move-up').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const id = btn.dataset.id;
                const overlays = this.videoCanvas?.getOrderedOverlays?.()
                    || this.videoCanvas?.overlayMgr?.overlays || [];
                const idx = overlays.findIndex(o => o.id === id);
                if (idx >= 0 && idx < overlays.length - 1) {
                    const temp = overlays[idx];
                    overlays[idx] = overlays[idx + 1];
                    overlays[idx + 1] = temp;
                    this.videoCanvas?.setOverlayOrder?.(overlays.map(overlay => overlay.id));
                    this._refreshList();
                    if (this.videoCanvas) this.videoCanvas.render();
                    if (typeof this.videoCanvas?.onOverlayChange === 'function') this.videoCanvas.onOverlayChange(overlays[idx + 1]);
                }
            });
        });

        // Move Down：同上，所有渲染端读取同一份 visualOverlayOrder。
        list.querySelectorAll('.rop-list-move-down').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const id = btn.dataset.id;
                const overlays = this.videoCanvas?.getOrderedOverlays?.()
                    || this.videoCanvas?.overlayMgr?.overlays || [];
                const idx = overlays.findIndex(o => o.id === id);
                if (idx > 0) {
                    const temp = overlays[idx];
                    overlays[idx] = overlays[idx - 1];
                    overlays[idx - 1] = temp;
                    this.videoCanvas?.setOverlayOrder?.(overlays.map(overlay => overlay.id));
                    this._refreshList();
                    if (this.videoCanvas) this.videoCanvas.render();
                    if (typeof this.videoCanvas?.onOverlayChange === 'function') this.videoCanvas.onOverlayChange(overlays[idx - 1]);
                }
            });
        });

        // Delete buttons
        list.querySelectorAll('.rop-list-del').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const id = btn.dataset.id;
                const ov = (this.videoCanvas?.overlayMgr?.overlays || []).find(o => o.id === id);
                const label = ov ? (ov.name || ov.title_text || ov.content || '').slice(0, 20) || ov.type : id;
                if (!confirm(`确定删除覆层「${label}」吗？`)) return;
                // 不能直接删临时 overlayMgr：批量编辑器的代理会把删除
                // 同步回 task.overlays、标签页快照并立即保存；绕过它会导致
                // 界面已删但 FCPXML 仍导出旧覆层。
                if (typeof this.videoCanvas?.removeOverlay === 'function') this.videoCanvas.removeOverlay(id);
                else this.videoCanvas?.overlayMgr?.removeOverlay(id);
                if (this._selectedOv?.id === id) {
                    this._selectedOv = null;
                    this.container.querySelector('#rop-props').style.display = 'none';
                }
                this._refreshList();
            });
        });
    }

    // ═══════════════════════════════════════════════
    // 选中 / 属性同步
    // ═══════════════════════════════════════════════

    selectOverlay(ov) {
        window.ReelsCtaPanel?.prepareOverlay?.(ov);
        document.querySelectorAll('.rop-decoration-palette-popover').forEach(el=>{el._restorePreview?.();el.remove();});
        ['title_deco','scroll_title_deco'].forEach(prefix=>{
            const preset=ov[`${prefix}_parameters`]?.preset;
            const select=this.container.querySelector(prefix==='title_deco'?'#rop-title-deco-style':'#rop-scroll-title-deco-style');
            if(preset&&select&&!Array.from(select.options).some(o=>o.value===preset.id)){const o=document.createElement('option');o.value=preset.id;o.textContent=preset.name;select.append(o);}
        });
        // 清除之前选中的标记
        if (this._selectedOv) {
            this._selectedOv._selected = false;
            this._selectedOv._previewAtEnd = false; // 切换时关闭终点预览
        }
        this._selectedOv = ov;
        ov._selected = true;
        // 重置"预览终点"按钮
        const animPreviewBtn = this.container.querySelector('#rop-anim-preview-end');
        if (animPreviewBtn) {
            animPreviewBtn.classList.remove('active');
            animPreviewBtn.style.background = '';
            animPreviewBtn.style.color = '';
            animPreviewBtn.textContent = '👁 预览终点';
        }
        this.container.querySelector('#rop-props').style.display = 'block';
        this.container.querySelector('#rop-text-props').style.display = ov.type === 'text' ? 'block' : 'none';
        this.container.querySelector('#rop-image-props').style.display = !ov.is_phone_cta && (ov.type === 'image' || ov.type === 'video') ? 'block' : 'none';
        this.container.querySelector('#rop-textcard-props').style.display = !ov.is_phone_cta && ov.type === 'textcard' ? 'block' : 'none';
        
        const isCard = ov.type === 'textcard' || ov.type === 'solid_mask';
        this.container.querySelector('#rop-textcard-layout-props').style.display = isCard ? 'block' : 'none';
        const cardPositionProps = this.container.querySelector('#rop-card-position-props');
        if (cardPositionProps) cardPositionProps.style.display = isCard ? 'block' : 'none';
        this.container.querySelector('#rop-scroll-props').style.display = ov.type === 'scroll' ? 'block' : 'none';
        this.container.querySelector('#rop-textcard-debug-props').style.display = ov.type === 'textcard' ? 'block' : 'none';
        
        const innerTextLayout = this.container.querySelector('#rop-textcard-only-text-layout-inner');
        if (innerTextLayout) innerTextLayout.style.display = ov.type === 'textcard' ? 'contents' : 'none';
        const innerShrink = this.container.querySelector('#rop-textcard-only-shrink-inner');
        if (innerShrink) innerShrink.style.display = ov.type === 'textcard' ? 'contents' : 'none';

        // Dynamic labels for card X/Y
        const cardXInput = this.container.querySelector('#rop-card-x');
        if (cardXInput) {
            const label = cardXInput.closest('.rop-slider-combo')?.previousElementSibling;
            if (label && label.tagName === 'LABEL') {
                label.textContent = ov.type === 'solid_mask' ? '蒙版位置X' : '整体卡片位置X';
            }
        }
        const cardYInput = this.container.querySelector('#rop-card-y');
        if (cardYInput) {
            const label = cardYInput.closest('.rop-slider-combo')?.previousElementSibling;
            if (label && label.tagName === 'LABEL') {
                label.textContent = ov.type === 'solid_mask' ? '蒙版位置Y' : '整体卡片位置Y';
            }
        }

        // Show fixed_text toggle for text, textcard, and scroll overlays
        const hasText = ov.type === 'text' || ov.type === 'textcard' || ov.type === 'scroll';
        this.container.querySelector('#rop-fixed-text-group').style.display = hasText ? 'block' : 'none';

        // Image overlays: show scale, hide W/H. Others: show W/H, hide scale.
        const isImg = ov.type === 'image' || ov.type === 'video';
        // Only show template group if TextCard
        const templateGroup = this.container.querySelector('#rop-textcard-template-props');
        if (templateGroup) templateGroup.style.display = ov.type === 'textcard' ? 'block' : 'none';

        // Only show Transform buttons (Default, Fill Screen) for Image overlays in the generic Transform panel
        const transformBtns = this.container.querySelector('#rop-transform-btns');
        if (transformBtns) transformBtns.style.display = isImg ? 'flex' : 'none';

        // Hide entire Transform block for TextCard and Solid Mask
        const transformGroup = this.container.querySelector('#rop-transform-group');
        if (transformGroup) transformGroup.style.display = isCard ? 'none' : 'block';

        // Hide Rotation and Opacity for all text-related overlays since they don't commonly use them
        const isTextBased = ov.type === 'text' || ov.type === 'scroll' || ov.type === 'textcard';
        this.container.querySelector('#rop-rotation-label').style.display = isTextBased ? 'none' : '';
        this.container.querySelector('#rop-rotation').style.display = isTextBased ? 'none' : '';
        this.container.querySelector('#rop-opacity-label').style.display = isTextBased ? 'none' : '';
        this.container.querySelector('#rop-opacity').style.display = isTextBased ? 'none' : '';

        // 旧“变换”是整个覆层的总控制，媒体也必须保留；新增字段只管窗口内素材。
        this.container.querySelector('#rop-xy-label-x').style.display = isCard ? 'none' : '';
        this.container.querySelector('#rop-x').style.display = isCard ? 'none' : '';
        this.container.querySelector('#rop-xy-label-y').style.display = isCard ? 'none' : '';
        this.container.querySelector('#rop-y').style.display = isCard ? 'none' : '';
        this.container.querySelector('#rop-x').disabled = false;
        this.container.querySelector('#rop-y').disabled = false;
        this.container.querySelector('#rop-wh-label-w').style.display = (isImg || isCard) ? 'none' : '';
        this.container.querySelector('#rop-w').style.display = (isImg || isCard) ? 'none' : '';
        this.container.querySelector('#rop-wh-label-h').style.display = (isImg || isCard) ? 'none' : '';
        this.container.querySelector('#rop-h').style.display = (isImg || isCard) ? 'none' : '';
        const isMedia = ov.type === 'image' || ov.type === 'video';
        this.container.querySelector('#rop-scale-label').style.display = isMedia ? '' : 'none';
        this.container.querySelector('#rop-scale').style.display = isMedia ? '' : 'none';
        this.container.querySelector('#rop-scale-x-label').style.display = isMedia ? '' : 'none';
        this.container.querySelector('#rop-scale-x').style.display = isMedia ? '' : 'none';
        this.container.querySelector('#rop-scale-y-label').style.display = isMedia ? '' : 'none';
        this.container.querySelector('#rop-scale-y').style.display = isMedia ? '' : 'none';
        this.container.querySelector('#rop-rotation-label').textContent = '旋转';

        // Dynamic labels for scroll overlay (x/y/w/h = clip region)
        const isScroll = ov.type === 'scroll';
        this.container.querySelector('#rop-xy-label-x').textContent = isScroll ? '裁切X' : '位置X(中心)';
        this.container.querySelector('#rop-xy-label-y').textContent = isScroll ? '裁切Y' : '位置Y(中心)';
        this.container.querySelector('#rop-wh-label-w').textContent = isScroll ? '裁切宽' : '宽度';
        this.container.querySelector('#rop-wh-label-h').textContent = isScroll ? '裁切高' : '高度';

        // 滚动覆层和文字卡片: 隐藏变换区的时间字段
        // (滚动有自己的时间字段, 文字卡片通常全程显示)
        const timeInTransform = this.container.querySelector('#rop-time-in-transform');
        const hideTime = isScroll || isCard;
        if (timeInTransform) timeInTransform.style.display = hideTime ? 'none' : 'contents';

        // 媒体覆层（image/video）自动展开变换面板，方便设置位置和 A→B 过渡
        if (isImg && transformGroup && transformGroup.classList.contains('rop-collapsed')) {
            transformGroup.classList.remove('rop-collapsed');
            const icon = transformGroup.querySelector('.rop-collapse-icon');
            if (icon) icon.textContent = '▾';
        }

        this._syncFromOverlay(ov);
        this._refreshList();
        window.dispatchEvent(new CustomEvent('reels-overlay-selection-changed',{detail:{panel:this,overlay:ov}}));
    }

    deselectOverlay() {
        if (this._selectedOv) this._selectedOv._selected = false;
        this._selectedOv = null;
        this.container.querySelector('#rop-props').style.display = 'none';
        this._refreshList();
        window.dispatchEvent(new CustomEvent('reels-overlay-selection-changed',{detail:{panel:this,overlay:null}}));
    }

    _bindNumericInputEditing() {
        this.container.querySelectorAll('input[type="number"]').forEach(el => {
            let editStart = el.value;
            el.addEventListener('focus', () => {
                this._numericEditingOv = this._selectedOv;
                editStart = el.value;
            });
            // Empty text, a minus sign, or an unfinished decimal is an edit in progress.
            el.addEventListener('input', event => {
                if (el.value === '' || !Number.isFinite(Number(el.value))) event.stopImmediatePropagation();
            }, true);
            const normalize = () => {
                let value = Number(el.value);
                if (el.value === '' || !Number.isFinite(value)) {
                    const linked = el.dataset.link && this.container.querySelector('#' + el.dataset.link);
                    value = Number(linked?.value ?? editStart) || 0;
                }
                if (el.min !== '') value = Math.max(Number(el.min), value);
                if (el.max !== '') value = Math.min(Number(el.max), value);
                el.value = String(value);
            };
            el.addEventListener('change', normalize, true);
            el.addEventListener('blur', () => {
                const before = el.value;
                normalize();
                this._numericEditingOv = null;
                if (el.value !== before) el.dispatchEvent(new Event('change', { bubbles: true }));
            });
        });
    }

    _val(id, v) {
        const el = this.container.querySelector('#' + id);
        if (!el) return;
        if (el.type === 'number' && document.activeElement === el && this._numericEditingOv === this._selectedOv) return;
        if (el.type === 'checkbox') {
            el.checked = !!v;
        } else if (el.type === 'color') {
            if (typeof v === 'string' && v.includes(',')) {
                el.dataset.gradientValue = v;
                if (el._ropHexInput) el._ropHexInput.value = v;
                const first = v.split(',')[0].trim();
                const norm = this._normalizeHexColor(first);
                if (norm) el.value = norm;
                const dir = el.dataset.gradientDirection || 'horizontal';
                const angle = dir === 'horizontal' ? 'to right' : (dir === 'diagonal' ? '135deg' : (dir === 'diagonal-up' ? '45deg' : 'to bottom'));
                const gradCss = `linear-gradient(${angle}, ${v.split(',').map(c => c.trim()).join(', ')})`;
                el.classList.add('vk-has-gradient');
                el.style.setProperty('--vk-gradient-preview', gradCss);
            } else {
                delete el.dataset.gradientValue;
                const norm = this._normalizeHexColor(v);
                if (norm) el.value = norm;
                else if (v) el.value = v;
                if (el._ropHexInput) {
                    el._ropHexInput.value = this._normalizeHexColor(el.value) || (v ?? '');
                }
                el.classList.remove('vk-has-gradient');
                el.style.removeProperty('--vk-gradient-preview');
            }
            if (el._ropGradBtn) {
                if (el.dataset.gradientValue) {
                    el._ropGradBtn.classList.add('vk-gradient-btn-active');
                    el._ropGradBtn.title = `已启用渐变: ${el.dataset.gradientValue}`;
                } else {
                    el._ropGradBtn.classList.remove('vk-gradient-btn-active');
                    el._ropGradBtn.style.boxShadow = '';
                    el._ropGradBtn.style.borderColor = '';
                    el._ropGradBtn.title = '设置渐变色 (支持多节点自定义)';
                }
            }
        } else {
            el.value = v ?? '';
        }
        if (['rop-font', 'rop-title-font', 'rop-body-font', 'rop-footer-font', 'rop-scroll-font', 'rop-scroll-title-font'].includes(id)) {
            if (window.getFontManager) {
                const fm = getFontManager();
                if (fm && typeof fm.refreshFontSelect === 'function') {
                    fm.refreshFontSelect(el, v ?? '');
                }
            }
        }
        // Sync linked number readout
        const numReadout = this.container.querySelector(`.rop-num-readout[data-link="${id}"]`);
        if (numReadout && !(document.activeElement === numReadout && this._numericEditingOv === this._selectedOv)) numReadout.value = v ?? '';
    }

    _syncMediaCornerControl() {
        const values = ['tl','tr','br','bl'].map(corner => Math.max(0, Number(this._get('rop-media-corner-' + corner)) || 0));
        // Older presets can have different corners; still show a usable numeric value.
        this._val('rop-media-corner-all', Math.max(...values));
    }

    _get(id) {
        const el = this.container.querySelector('#' + id);
        if (!el) return undefined;
        if (el.type === 'range') {
            const readout = this.container.querySelector(`.rop-num-readout[data-link="${id}"]`);
            if (readout && document.activeElement === readout && readout.value !== '' && Number.isFinite(Number(readout.value))) return Number(readout.value);
        }
        if (el.type === 'checkbox') return el.checked;
        if (el.type === 'number' || el.type === 'range') return parseFloat(el.value) || 0;
        if (el.type === 'color') {
            if (el.dataset?.gradientValue) return el.dataset.gradientValue;
            if (el._ropHexInput && typeof el._ropHexInput.value === 'string' && el._ropHexInput.value.includes(',')) {
                return el._ropHexInput.value.trim();
            }
        }
        return el.value;
    }

    _getCanvasSize() {
        if (this.videoCanvas?.getCanvasSize) return this.videoCanvas.getCanvasSize();
        const v2Size = window.ReelsPreviewV2?.isOpen?.()
            ? window.ReelsPreviewV2.getCanvasSize?.()
            : null;
        const c = document.getElementById('reels-preview-canvas');
        const w = v2Size?.width || ((c && c.width) ? c.width : 1080);
        const h = v2Size?.height || ((c && c.height) ? c.height : 1920);
        return { w, h, cx: w / 2, cy: h / 2 };
    }

    _toCenterPos(topLeftX, topLeftY, width, height) {
        const { cx, cy } = this._getCanvasSize();
        return {
            x: Math.round((topLeftX + (width / 2)) - cx),
            y: Math.round((topLeftY + (height / 2)) - cy),
        };
    }

    _toTopLeftFromCenter(centerX, centerY, width, height) {
        const { cx, cy } = this._getCanvasSize();
        return {
            x: Math.round(centerX + cx - (width / 2)),
            y: Math.round(centerY + cy - (height / 2)),
        };
    }

    _getTextcardContentWidth(ov = this._selectedOv) {
        const cardW = Math.max(1, Number(ov?.w ?? this._get('rop-card-width') ?? 910) || 910);
        const padL = Math.max(0, Number(ov?.padding_left ?? this._get('rop-pad-left') ?? 40) || 0);
        const padR = Math.max(0, Number(ov?.padding_right ?? this._get('rop-pad-right') ?? 40) || 0);
        return Math.max(1, Math.round(cardW - padL - padR));
    }

    _setTextcardWidthField(id, storedValue, contentWidth) {
        const isFollow = !(Number(storedValue) > 0);
        const displayValue = isFollow ? contentWidth : Math.round(Number(storedValue));
        this._val(id, displayValue);
        const el = this.container.querySelector('#' + id);
        if (el) {
            el.dataset.followContentWidth = isFollow ? '1' : '0';
            el.dataset.userEdited = '0';
            el.dataset.default = String(contentWidth);
        }
        const readout = this.container.querySelector(`.rop-num-readout[data-link="${id}"]`);
        if (readout) readout.dataset.default = String(contentWidth);
    }

    _getTextcardStoredWidth(id) {
        const el = this.container.querySelector('#' + id);
        if (!el) return 0;
        const value = Math.max(1, parseFloat(el.value) || 1);
        const defaultValue = Math.max(1, parseFloat(el.dataset.default) || 1);
        if (el.dataset.followContentWidth === '1' && el.dataset.userEdited !== '1' && Math.abs(value - defaultValue) < 0.001) {
            return 0;
        }
        return value;
    }

    _refreshWeightOptions(weightSelectId, fontFamily) {
        const select = this.container.querySelector('#' + weightSelectId);
        if (!select) return;
        const current = String(select.value || '700');
        let entries = [
            { value: '100', label: 'Thin' },
            { value: '200', label: 'ExtraLight' },
            { value: '300', label: 'Light' },
            { value: '400', label: 'Regular' },
            { value: '500', label: 'Medium' },
            { value: '600', label: 'SemiBold' },
            { value: '700', label: 'Bold' },
            { value: '800', label: 'ExtraBold' },
            { value: '900', label: 'Black' },
        ];
        if (window.getFontManager) {
            const fm = getFontManager();
            if (fm && typeof fm.getFontWeightEntries === 'function') {
                const list = fm.getFontWeightEntries(fontFamily, 'normal');
                if (Array.isArray(list) && list.length > 0) {
                    entries = list.map(item => {
                        const value = String(item.value || '400');
                        const label = String(item.label || value);
                        return { value, label };
                    });
                }
            } else if (fm && typeof fm.getFontWeightOptions === 'function') {
                const list = fm.getFontWeightOptions(fontFamily);
                if (Array.isArray(list) && list.length > 0) {
                    entries = list.map(v => ({ value: String(v), label: String(v) }));
                }
            }
        }
        const weights = entries.map(x => x.value);
        select.innerHTML = entries.map(x => `<option value="${x.value}">${x.label}</option>`).join('');
        if (weights.includes(current)) select.value = current;
        else if (weights.includes('700')) select.value = '700';
        else select.value = weights[weights.length - 1] || '700';
    }

    _syncFromOverlay(ov) {
        if (!ov) return;
        this._val('rop-name', ov.name || '');
        this._val('rop-synthetic-bold', ov.synthetic_bold_enabled === true);
        const boldGroup=this.container.querySelector('#rop-synthetic-bold-group');
        if(boldGroup)boldGroup.style.display=['text','textcard','scroll'].includes(ov.type)?'':'none';
        this._decorEditor?.refresh();
        this._ctaEditor?.refresh();
        const mediaGeometry = this._getMediaWindowGeometry(ov);
        if (ov.type === 'scroll') {
            this._val('rop-x', Math.round(ov.x));
            this._val('rop-y', Math.round(ov.y));
        } else if (['textcard', 'solid_mask', 'image', 'video', 'decor'].includes(ov.type)) {
            // Media windows and cards use their stored transform, not temporary rendered bounds.
            const pos = this._toCenterPos(
                Math.round(mediaGeometry.x || 0),
                Math.round(mediaGeometry.y || 0),
                Math.max(0, Math.round(mediaGeometry.w ?? 0)),
                Math.max(0, Math.round(mediaGeometry.h ?? 0))
            );
            this._val('rop-x', pos.x);
            this._val('rop-y', pos.y);
        } else {
            const displayW = Math.max(0, Math.round(ov._renderedW ?? ov.w ?? 0));
            const displayH = Math.max(0, Math.round(ov._renderedH ?? ov.h ?? 0));
            const displayYTop = Math.round(ov._renderedY ?? ov.y ?? 0);
            const pos = this._toCenterPos(Math.round(ov.x || 0), displayYTop, displayW, displayH);
            this._val('rop-x', pos.x);
            this._val('rop-y', pos.y);
        }
        this._val('rop-w', Math.round(mediaGeometry.w));
        this._val('rop-h', Math.round(mediaGeometry.h));
        this._val('rop-rotation', ov.rotation || 0);
        const opacityPct = Math.round((ov.opacity ?? 255) / 255 * 100);
        this._val('rop-opacity', opacityPct);
        // 清理源数据浮点精度 + 显示
        ov.start = _ropRound(ov.start || 0);
        this._val('rop-start', ov.start);
        // 9999 = 全程，面板显示实际时长但不修改数据
        let displayEnd = ov.end || 0;
        if (displayEnd >= 9999) {
            const v2Duration = this.videoCanvas?.getDuration ? this.videoCanvas.getDuration() : window.ReelsPreviewV2?.isOpen?.()
                ? window.ReelsPreviewV2.getDuration?.()
                : 0;
            const mediaEl = document.getElementById('reels-preview-video') || document.querySelector('#reels-preview video');
            if (v2Duration && isFinite(v2Duration)) {
                displayEnd = _ropRound(v2Duration);
            } else if (mediaEl && mediaEl.duration && isFinite(mediaEl.duration)) {
                displayEnd = _ropRound(mediaEl.duration);
            } else {
                displayEnd = 9999; // 保持原值
            }
        } else {
            ov.end = _ropRound(displayEnd);
            displayEnd = ov.end;
        }
        this._val('rop-end', displayEnd);
        // 卡片的变换区默认隐藏，使用其专属字段显示同一套起止时间。
        this._val('rop-card-start', ov.start);
        this._val('rop-card-end', displayEnd);
        const cardTimeLinked = ov.card_time_linked !== false;
        this._val('rop-card-time-linked', cardTimeLinked);
        this._val('rop-mask-start', ov.mask_start ?? ov.start);
        this._val('rop-mask-end', ov.mask_end ?? displayEnd);
        const maskTimeFields = this.container.querySelector('#rop-mask-time-fields');
        if (maskTimeFields) maskTimeFields.style.display = cardTimeLinked ? 'none' : '';
        // 同步到滚动字幕专用的时间字段
        this._val('rop-scroll-start-time', ov.start);
        this._val('rop-scroll-end-time', displayEnd);

        // Animation: A/B 坐标使用当前面板同一套坐标语义。
        // 普通媒体/文本/文字卡片是中心点，scroll 是裁切区域左上角。
        const currentAnimX = this._get('rop-x') ?? 0;
        const currentAnimY = this._get('rop-y') ?? 0;
        const animStartX = Number.isFinite(parseFloat(ov.anim_start_x)) ? parseFloat(ov.anim_start_x) : currentAnimX;
        const animStartY = Number.isFinite(parseFloat(ov.anim_start_y)) ? parseFloat(ov.anim_start_y) : currentAnimY;
        const animEndX = Number.isFinite(parseFloat(ov.anim_end_x)) ? parseFloat(ov.anim_end_x) : animStartX;
        const animEndY = Number.isFinite(parseFloat(ov.anim_end_y)) ? parseFloat(ov.anim_end_y) : animStartY;
        this._val('rop-anim-dest-enabled', !!ov.anim_dest_enabled);
        this._val('rop-anim-easing', ov.anim_easing || 'ease_in_out_quad');
        this._val('rop-anim-timing-mode', ov.anim_timing_mode || 'duration');
        this._val('rop-anim-duration', ov.anim_duration ?? 0);
        this._val('rop-anim-speed', ov.anim_speed ?? 0);
        this._val('rop-anim-start-x', animStartX);
        this._val('rop-anim-start-y', animStartY);
        this._val('rop-anim-end-x', animEndX);
        this._val('rop-anim-end-y', animEndY);
        // anim_start_scale / anim_end_scale 存储为百分比整数（100 = 100%）
        const animStartScalePct = Math.round(ov.anim_start_scale ?? 100);
        this._val('rop-anim-start-scale', animStartScalePct);
        const animStartScaleValEl = this.container.querySelector('#rop-anim-start-scale-val');
        if (animStartScaleValEl) animStartScaleValEl.textContent = animStartScalePct + '%';
        const animEndScalePct = Math.round(ov.anim_end_scale ?? 100);
        this._val('rop-anim-end-scale', animEndScalePct);
        const animEndScaleValEl = this.container.querySelector('#rop-anim-end-scale-val');
        if (animEndScaleValEl) animEndScaleValEl.textContent = animEndScalePct + '%';
        // 更新 A 点参考标签
        this._updateAnimStartRef();

        if (ov.type === 'text') {
            this._val('rop-content', ov.content || '');
            this._val('rop-font', ov.font_family || 'Arial');
            this._refreshWeightOptions('rop-font-weight', ov.font_family || 'Arial');
            this._val('rop-fontsize', ov.fontsize || 40);
            const textColEl = this.container.querySelector('#rop-color');
            if (textColEl) textColEl.dataset.gradientDirection = ov.gradient_direction || 'horizontal';
            this._val('rop-color', ov.color || '#ffffff');
            const fw = Math.max(100, Math.min(900, parseInt(ov.font_weight || (ov.bold ? 700 : 400), 10) || 400));
            this._val('rop-font-weight', fw);
            this._val('rop-bold', fw >= 600);
            this._val('rop-use-stroke', !!ov.use_stroke);
            this._val('rop-stroke-color', ov.stroke_color || '#000000');
            this._val('rop-stroke-width', ov.stroke_width || 0);
            this._val('rop-shadow-enabled', !!ov.shadow_enabled);
            this._val('rop-shadow-color', ov.shadow_color || '#000000');
            this._val('rop-shadow-blur', ov.shadow_blur || 0);
            this._val('rop-shadow-offset-x', ov.shadow_offset_x ?? 4);
            this._val('rop-shadow-offset-y', ov.shadow_offset_y ?? 4);
            this._val('rop-shadow-opacity', Math.round((ov.shadow_opacity ?? 120) / 255 * 100));
        }

        if (ov.type === 'image' || ov.type === 'video') {
            const sourceEl = this.container.querySelector('#rop-media-source');
            const sourceLabelEl = this.container.querySelector('#rop-media-source-label');
            const folderFiles = Array.isArray(ov.media_folder_files) ? ov.media_folder_files : [];
            const folderPath = _ropDisplayMediaSource(ov.media_folder_path);
            if (sourceEl) {
                // 文件夹循环仍会把首个文件保存为 content，供预览和旧工程
                // 兼容使用；属性面板应优先告诉用户真正选择的文件夹，不能
                // 误导为“指定了一个视频”。
                const displaySource = folderFiles.length && ov.media_folder_path
                    ? folderPath : _ropDisplayMediaSource(ov.content);
                sourceEl.textContent = displaySource;
                sourceEl.title = displaySource === '—' ? '' : displaySource;
            }
            if (sourceLabelEl) sourceLabelEl.textContent = folderFiles.length && ov.media_folder_path
                ? '循环媒体文件夹' : '当前媒体路径';
            const folderStatus = this.container.querySelector('#rop-media-folder-status');
            if (folderStatus) {
                const count = folderFiles.length;
                const current = _ropDisplayMediaSource(ov.content);
                folderStatus.textContent = count
                    ? `🔁 共 ${count} 个素材；当前预览：${current}`
                    : '未使用文件夹循环';
            }
            const scaleXPct = _ropRound((ov.scale_x ?? ov.scale ?? 1) * 100);
            const scaleYPct = _ropRound((ov.scale_y ?? ov.scale ?? 1) * 100);
            // 分别缩放过时，总控显示 X 当前值；拖总控会明确重置 X/Y 为同一值。
            this._val('rop-scale', _ropRound((ov.scale ?? ov.scale_x ?? 1) * 100));
            this._val('rop-scale-x', scaleXPct);
            this._val('rop-scale-y', scaleYPct);
            this._val('rop-flip-h', ov.flip_x || false);
            this._val('rop-flip-v', ov.flip_y || false);
            this._val('rop-blend', ov.blend_mode || 'source-over');
            const delayEffect = window.ReelsPlaybackDelay?.active(ov, 'overlay');
            this._val('rop-delay-enabled', !!delayEffect);
            for (const id of ['rop-video-offset','rop-video-end']) {
                const input = this.container.querySelector('#' + id);
                if (input) input.disabled = !!delayEffect;
            }
            this._val('rop-delay-seconds', delayEffect?.seconds || 5);
            const delayStatus = this.container.querySelector('#rop-delay-status');
            if (delayStatus) delayStatus.textContent = delayEffect ? `已应用 ${delayEffect.seconds} 秒；关闭并应用后可修改入出点` : '';
            this._val('rop-video-offset', ov.video_start_offset || 0);
            this._val('rop-video-end', ov.video_end_offset ?? '');
            this._val('rop-keep-aspect', ov.keep_aspect !== false);
            this._val('rop-media-window-mode', ['top_half', 'bottom_half'].includes(ov.media_window_mode) ? ov.media_window_mode : (ov.media_window_mode === 'pip' ? 'pip' : 'none'));
            const splitControls=this.container.querySelector('#rop-media-split-controls');if(splitControls)splitControls.style.display=['top_half','bottom_half'].includes(ov.media_window_mode)?'block':'none';
            this._val('rop-media-split-angle',ov.media_split_angle || 0);this._val('rop-media-split-angle-slider',ov.media_split_angle || 0);
            this._val('rop-media-window-ratio', ov.media_window_ratio || '9:16');
            this._val('rop-media-window-width', Math.round(mediaGeometry.w || 540));
            this._val('rop-media-window-height', Math.round(mediaGeometry.h || 960));
            this._val('rop-media-mask-shape', ov.media_mask_shape || 'rect');
            this._val('rop-media-corner-tl', ov.media_corner_tl || 0);
            this._val('rop-media-corner-tr', ov.media_corner_tr || 0);
            this._val('rop-media-corner-br', ov.media_corner_br || 0);
            this._val('rop-media-corner-bl', ov.media_corner_bl || 0);
            this._syncMediaCornerControl();
            this._val('rop-media-loop', ov.media_loop !== false);
            this._val('rop-media-audio-enabled', ov.media_audio_enabled === true);
            this._val('rop-media-border-style', ov.media_border_style || 'none');
            this._val('rop-media-border-position', ov.media_border_position || 'inside');
            this._val('rop-media-border-color', ov.media_border_color || '#ffffff');
            this._val('rop-media-border-width', ov.media_border_width ?? 3);
            this._val('rop-media-border-opacity', ov.media_border_opacity ?? 100);
            this._val('rop-media-blur-fill', ov.media_blur_fill === true);
            this._val('rop-media-folder-interval', ov.media_folder_interval || 0);
            this._val('rop-media-inner-x', ov.media_inner_x || 0);
            this._val('rop-media-inner-y', ov.media_inner_y || 0);
            this._val('rop-media-inner-scale', Math.round((ov.media_inner_scale ?? 1) * 100));
            this._val('rop-media-inner-rotation', ov.media_inner_rotation || 0);
            this._val('rop-media-crop-left', ov.media_crop_left || 0);
            this._val('rop-media-crop-top', ov.media_crop_top || 0);
            this._val('rop-media-crop-right', ov.media_crop_right || 0);
            this._val('rop-media-crop-bottom', ov.media_crop_bottom || 0);
            const ratioEl = this.container.querySelector('#rop-media-window-ratio');
            if (ratioEl) ratioEl.disabled = ov.media_window_mode !== 'pip';
            const windowWidthEl = this.container.querySelector('#rop-media-window-width');
            const windowHeightEl = this.container.querySelector('#rop-media-window-height');
            if (windowWidthEl) windowWidthEl.disabled = ov.media_window_mode !== 'pip';
            if (windowHeightEl) windowHeightEl.disabled = ov.media_window_mode !== 'pip' || (ov.media_window_ratio || '9:16') !== 'free';
            const alignEl = this.container.querySelector('#rop-media-window-align');
            if (alignEl) alignEl.style.display = ov.media_window_mode === 'pip' ? 'block' : 'none';
            const cropEl = this.container.querySelector('#rop-media-crop');
            if (cropEl) cropEl.style.display = 'block';

            // 跟随滚动字幕绑定
            this._val('rop-bind-scroll-offset-y', ov.bind_scroll_offset_y || 0);
            this._val('rop-bind-scroll-offset-x', ov.bind_scroll_offset_x || 0);
            this._val('rop-bind-scroll-follow-x', ov.bind_scroll_follow_x || false);
            const clampMinEl = this.container.querySelector('#rop-bind-scroll-clamp-min-y');
            if (clampMinEl) clampMinEl.value = ov.bind_scroll_clamp_min_y != null ? ov.bind_scroll_clamp_min_y : '';
            const clampMaxEl = this.container.querySelector('#rop-bind-scroll-clamp-max-y');
            if (clampMaxEl) clampMaxEl.value = ov.bind_scroll_clamp_max_y != null ? ov.bind_scroll_clamp_max_y : '';
            // 填充绑定目标下拉列表
            const bindSelect = this.container.querySelector('#rop-bind-scroll-target');
            if (bindSelect) {
                const curVal = ov.bind_scroll_overlay_id || '';
                let opts = '<option value="">— 不绑定 —</option>';
                const mgr = this.videoCanvas && this.videoCanvas.overlayMgr;
                if (mgr && mgr.overlays) {
                    mgr.overlays.forEach(o => {
                        if (!o.id) {
                            o.id = 'ov_' + Math.random().toString(36).slice(2, 9) + '_' + Date.now().toString(36);
                        }
                        if (o.type === 'scroll') {
                            const label = o.name || o.scroll_title || o.content?.slice(0, 20) || o.id;
                            const sel = o.id === curVal ? ' selected' : '';
                            opts += `<option value="${o.id}"${sel}>${label}</option>`;
                        }
                    });
                }
                bindSelect.innerHTML = opts;
            }
        }

        if (ov.type === 'textcard' || ov.type === 'solid_mask') {
            this._val('rop-card-enabled', ov.card_enabled ?? true);
            const cardColEl = this.container.querySelector('#rop-card-color');
            if (cardColEl) {
                if (ov.card_gradient_direction) cardColEl.dataset.gradientDirection = ov.card_gradient_direction;
                else delete cardColEl.dataset.gradientDirection;
            }
            this._val('rop-card-color', ov.card_color || '#ffffff');
            this._val('rop-card-opacity', ov.card_opacity ?? 80);
            this._val('rop-card-feather-enabled', ov.card_feather_enabled ?? false);
            this._val('rop-card-feather-dir', ov.card_feather_dir || 'bottom');
            this._val('rop-card-feather-start', ov.card_feather_start ?? 50);
            this._val('rop-card-feather-end', ov.card_feather_end ?? 100);
            this._val('rop-card-border-enabled', ov.card_border_enabled ?? false);
            this._val('rop-card-border-sides', ov.card_border_sides || 'all');
            this._val('rop-card-border-color', ov.card_border_color || '#FFD700');
            this._val('rop-card-border-width', ov.card_border_width ?? 3);
            this._val('rop-card-border-style', ov.card_border_style || 'solid');
            this._val('rop-card-border-opacity', ov.card_border_opacity ?? 100);
            this._val('rop-card-blur-enabled', ov.card_blur_enabled ?? false);
            this._val('rop-card-blur-amount', ov.card_blur_amount ?? 10);
            this._val('rop-radius-all', ov.radius_tl ?? 33);

            const fullMask = (ov.fullscreen_mask === true || ov.fullscreen_mask === 1 || ov.fullscreen_mask === '1');
            this._val('rop-fullscreen-mask', fullMask);
            this._val('rop-card-width', ov.w || 910);
            this._val('rop-card-height', ov.h ?? 1300);
            this._val('rop-card-x', this._get('rop-x'));
            this._val('rop-card-y', this._get('rop-y'));
            this._val('rop-name', ov.name || '');
            this._val('rop-fixed-text', ov.fixed_text || false);
            this._syncTextcardMaskEnabledUI();

            if (ov.type === 'textcard') {
                const titleSchemeSelect = this.container.querySelector('#rop-title-scheme-select');
                const previewEl = this.container.querySelector('#rop-title-scheme-preview');
                let matchedSchemeKey = '';
                const curNormTitleCol = (ov.title_color || '').toLowerCase();
                const curNormBgCol = (ov.title_bg_color || '').toLowerCase();
                const isBgOn = ov.title_bg_enabled === true;

                const schemes = this._getTitleColorSchemes();
                for (const [key, cfg] of Object.entries(schemes)) {
                    if (cfg.dualColor) {
                        const expectedDual1 = `${cfg.titleColor}, ${cfg.titleColor2}`.toLowerCase();
                        const expectedDual2 = `${cfg.titleColor},${cfg.titleColor2}`.toLowerCase();
                        if (curNormTitleCol === expectedDual1 || curNormTitleCol === expectedDual2) {
                            matchedSchemeKey = key;
                            break;
                        }
                    } else if (cfg.decoLine && !isBgOn && ov.title_deco_enabled && cfg.titleColor.toLowerCase() === curNormTitleCol && (ov.title_deco_color || '').toLowerCase() === (cfg.decoColor || '').toLowerCase()) {
                        matchedSchemeKey = key;
                        break;
                    } else if (cfg.pureText && !isBgOn && cfg.titleColor.toLowerCase() === curNormTitleCol) {
                        matchedSchemeKey = key;
                        break;
                    } else if (!cfg.pureText && !cfg.decoLine && isBgOn && cfg.titleColor?.toLowerCase() === curNormTitleCol && cfg.titleBgColor?.toLowerCase() === curNormBgCol) {
                        matchedSchemeKey = key;
                        break;
                    }
                }

                if (titleSchemeSelect) titleSchemeSelect.value = matchedSchemeKey;
                if (previewEl) {
                    if (matchedSchemeKey && schemes[matchedSchemeKey]) {
                        const mCfg = schemes[matchedSchemeKey];
                        previewEl.style.display = 'inline-flex';
                        previewEl.style.alignItems = 'center';
                        previewEl.style.justifyContent = 'center';
                        previewEl.style.fontSize = '10.5px';
                        previewEl.style.fontWeight = 'bold';
                        previewEl.textContent = 'Aa';
                        if (mCfg.dualColor) {
                            previewEl.style.background = `linear-gradient(135deg, ${mCfg.titleColor} 50%, ${mCfg.titleColor2} 50%)`;
                            previewEl.style.color = '#111';
                            previewEl.style.border = '1px solid rgba(255,255,255,0.4)';
                            previewEl.style.borderBottom = '1px solid rgba(255,255,255,0.4)';
                            previewEl.title = `双色标题: ${mCfg.name} (${mCfg.titleColor} + ${mCfg.titleColor2}) - 点击打开视觉色板`;
                        } else if (mCfg.decoLine) {
                            previewEl.style.background = '#0e1017';
                            previewEl.style.color = mCfg.titleColor || '#fff';
                            previewEl.style.border = '1px solid rgba(255,255,255,0.3)';
                            previewEl.style.borderBottom = `3px solid ${mCfg.decoColor}`;
                            previewEl.title = `排版装饰: ${mCfg.name} (主色 ${mCfg.titleColor} + 饰线 ${mCfg.decoColor}) - 点击打开视觉色板`;
                        } else if (mCfg.pureText) {
                            previewEl.style.background = '#0e1017';
                            previewEl.style.color = mCfg.titleColor || '#fff';
                            previewEl.style.border = '1px solid rgba(255,255,255,0.3)';
                            previewEl.style.borderBottom = '1px solid rgba(255,255,255,0.3)';
                            previewEl.title = `纯文字: ${mCfg.titleColor} (无背景) - 点击打开视觉色板`;
                        } else {
                            previewEl.style.background = mCfg.titleBgColor || '#333';
                            previewEl.style.color = mCfg.titleColor || '#fff';
                            previewEl.style.border = `1px solid ${mCfg.titleColor || '#666'}`;
                            previewEl.style.borderBottom = `1px solid ${mCfg.titleColor || '#666'}`;
                            previewEl.title = `标题字: ${mCfg.titleColor} | 标题底: ${mCfg.titleBgColor} - 点击打开视觉色板`;
                        }
                    } else {
                        previewEl.style.display = 'none';
                    }
                }
                this._val('rop-title-text', ov.title_text || '');
                this._val('rop-title-font', ov.title_font_family || 'Crimson Pro');
                this._refreshWeightOptions('rop-title-weight', ov.title_font_family || 'Crimson Pro');
                this._val('rop-title-fontsize', ov.title_fontsize ?? 60);
                const titleColEl = this.container.querySelector('#rop-title-color');
                if (titleColEl) titleColEl.dataset.gradientDirection = ov.title_gradient_direction || 'horizontal';
                this._val('rop-title-color', ov.title_color || '#000000');
                const tw = Math.max(100, Math.min(900, parseInt(ov.title_font_weight || ((ov.title_bold !== false) ? 900 : 400), 10) || 900));
                this._val('rop-title-weight', tw);
                this._val('rop-title-bold', tw >= 600);
                this._val('rop-title-uppercase', ov.title_uppercase !== false);
                this._val('rop-title-align', ov.title_align || 'center');
                this._val('rop-title-valign', ov.title_valign || 'top');
                this._val('rop-title-letterspacing', ov.title_letter_spacing ?? 0);
                const textcardContentW = this._getTextcardContentWidth(ov);
                this._setTextcardWidthField('rop-title-override-w', ov.title_override_w, textcardContentW);
                this._val('rop-title-override-h', ov.title_override_h ?? 0);
                this._val('rop-title-max-glyph-height', ov.title_max_glyph_height ?? 60);
                this._val('rop-title-adaptive-enabled', ov.title_adaptive_enabled === true);
                this._val('rop-title-preferred-glyph-height', ov.title_preferred_glyph_height ?? 45);
                this._val('rop-title-adaptive-min-w', ov.title_adaptive_min_w ?? 1080);
                this._val('rop-title-adaptive-min-h', ov.title_adaptive_min_h ?? 200);
                this._val('rop-title-adaptive-max-w', ov.title_adaptive_max_w ?? 1080);
                this._val('rop-title-adaptive-max-h', ov.title_adaptive_max_h ?? 300);
                this._val('rop-title-adaptive-max-lines', ov.title_adaptive_max_lines ?? 3);
                this._syncTitleAdaptiveUI();
                this._val('rop-title-linespacing', ov.title_line_spacing ?? 0);
                this._val('rop-title-rotation', ov.title_rotation ?? 0);
                this._val('rop-title-offset-x', ov.title_offset_x ?? 0);
                this._val('rop-title-offset-y', ov.title_offset_y ?? 0);
                this._syncTitleLayerPosition(ov);
                this._val('rop-body-text', ov.body_text || '');
                this._val('rop-body-follow-title', ov.body_follow_title === true);
                this._val('rop-body-font', ov.body_font_family || 'Arial');
                this._refreshWeightOptions('rop-body-weight', ov.body_font_family || 'Arial');
                this._val('rop-body-fontsize', ov.body_fontsize ?? 40);
                const bodyColEl = this.container.querySelector('#rop-body-color');
                if (bodyColEl) bodyColEl.dataset.gradientDirection = ov.body_gradient_direction || 'horizontal';
                this._val('rop-body-color', ov.body_color || '#000000');
                const bw = Math.max(100, Math.min(900, parseInt(ov.body_font_weight || (ov.body_bold ? 700 : 400), 10) || 400));
                this._val('rop-body-weight', bw);
                this._val('rop-body-bold', bw >= 600);
                this._val('rop-body-letterspacing', ov.body_letter_spacing ?? 0);
                this._setTextcardWidthField('rop-body-override-w', ov.body_override_w, textcardContentW);
                this._val('rop-body-override-h', ov.body_override_h ?? 0);
                this._val('rop-body-auto-shrink', ov.body_auto_shrink === true);
                this._val('rop-body-linespacing', ov.body_line_spacing ?? 6);
                this._val('rop-body-align', ov.body_align || 'center');
                this._val('rop-body-valign', ov.body_valign || 'top');
                this._val('rop-body-offset-x', ov.body_offset_x ?? 0);
                this._val('rop-body-offset-y', ov.body_offset_y ?? 0);
                // Footer
                this._val('rop-footer-text', ov.footer_text || '');
                this._val('rop-footer-font', ov.footer_font_family || 'Arial');
                this._refreshWeightOptions('rop-footer-weight', ov.footer_font_family || 'Arial');
                this._val('rop-footer-fontsize', ov.footer_fontsize ?? 32);
                const footerColEl = this.container.querySelector('#rop-footer-color');
                if (footerColEl) footerColEl.dataset.gradientDirection = ov.footer_gradient_direction || 'horizontal';
                this._val('rop-footer-color', ov.footer_color || '#666666');
                const ftw = Math.max(100, Math.min(900, parseInt(ov.footer_font_weight || (ov.footer_bold ? 700 : 400), 10) || 400));
                this._val('rop-footer-weight', ftw);
                this._val('rop-footer-bold', ftw >= 600);
                this._val('rop-footer-letterspacing', ov.footer_letter_spacing ?? 0);
                this._setTextcardWidthField('rop-footer-override-w', ov.footer_override_w, textcardContentW);
                this._val('rop-footer-override-h', ov.footer_override_h ?? 0);
                this._val('rop-footer-auto-shrink', ov.footer_auto_shrink === true);
                this._val('rop-footer-linespacing', ov.footer_line_spacing ?? 0);
                this._val('rop-footer-align', ov.footer_align || 'center');
                this._val('rop-footer-valign', ov.footer_valign || 'top');
                this._val('rop-footer-offset-x', ov.footer_offset_x ?? 0);
                this._val('rop-footer-offset-y', ov.footer_offset_y ?? 0);
                // Text effects (unified fallback logic)
                const isIndep = ov.independent_effects === true;
                this._val('rop-title-stroke-color', (isIndep ? ov.title_stroke_color : ov.text_stroke_color) || '#000000');
                this._val('rop-title-stroke-width', (isIndep ? ov.title_stroke_width : ov.text_stroke_width) ?? 0);
                this._val('rop-title-shadow-color', (isIndep ? ov.title_shadow_color : ov.text_shadow_color) || '#000000');
                this._val('rop-title-shadow-blur', (isIndep ? ov.title_shadow_blur : ov.text_shadow_blur) ?? 0);
                this._val('rop-title-shadow-x', (isIndep ? ov.title_shadow_x : ov.text_shadow_x) ?? (isIndep ? 0 : 2));
                this._val('rop-title-shadow-y', (isIndep ? ov.title_shadow_y : ov.text_shadow_y) ?? (isIndep ? 0 : 2));
                // Backgrounds
                ['title', 'body'].forEach(pfx => {
                    const cData = ov[pfx + '_custom_brush_data'];
                    const sName = ov[pfx + '_bg_brush_style'];
                    if (cData && sName && ov[pfx + '_bg_brush'] && ov[pfx + '_bg_enabled']) {
                        if (window.ReelsOverlay && window.ReelsOverlay.ReelsBrushEngine) {
                            window.ReelsOverlay.ReelsBrushEngine.registerBrush(sName, cData);
                        }
                    }
                });
                this._refreshAllBrushSelects();

                this._val('rop-title-bg-enabled', ov.title_bg_enabled ?? false);
                this._val('rop-title-bg-mode', ov.title_bg_mode || 'block');
                this._val('rop-title-bg-brush', ov.title_bg_brush ?? false);
                this._val('rop-title-bg-brush-style', ov.title_bg_brush_style || '');
                this._val('rop-title-bg-brush-colormode', ov.title_bg_brush_colormode_v2 ? (ov.title_bg_brush_colormode || 'original') : 'original');
                this._val('rop-title-bg-brush-fit', ov.title_bg_brush_fit || 'stretch');
                this._val('rop-title-bg-brush-zoom', ov.title_bg_brush_zoom ?? 100);
                this._val('rop-title-bg-brush-scale-x', ov.title_bg_brush_scale_x ?? 100);
                this._val('rop-title-bg-brush-scale-y', ov.title_bg_brush_scale_y ?? 100);
                this._val('rop-title-bg-brush-solid', ov.title_bg_brush_solid ?? 100);
                this._val('rop-title-bg-brush-x', ov.title_bg_brush_x ?? 0);
                this._val('rop-title-bg-brush-y', ov.title_bg_brush_y ?? 0);
                const titleBgEl = this.container.querySelector('#rop-title-bg-color');
                if (titleBgEl) {
                    if (ov.title_bg_gradient_direction) titleBgEl.dataset.gradientDirection = ov.title_bg_gradient_direction;
                    else delete titleBgEl.dataset.gradientDirection;
                }
                this._val('rop-title-bg-color', ov.title_bg_color || '#000000');
                this._val('rop-title-bg-opacity', ov.title_bg_opacity ?? 60);
                this._val('rop-title-bg-radius', ov.title_bg_radius ?? 12);
            this._val('rop-title-bg-concave-radius', ov.title_bg_concave_radius ?? 10);
            this._val('rop-title-bg-snap-threshold', ov.title_bg_snap_threshold ?? 18);
                this._val('rop-title-bg-pad-h', ov.title_bg_pad_h ?? 0);
                this._val('rop-title-bg-pad-top', ov.title_bg_pad_top ?? 0);
                this._val('rop-title-bg-border-enabled', ov.title_bg_border_enabled ?? false);
                this._val('rop-title-bg-border-color', ov.title_bg_border_color ?? '#ffffff');
                this._val('rop-title-bg-border-width', ov.title_bg_border_width ?? 3);
                this._val('rop-title-bg-border-style', ov.title_bg_border_style ?? 'solid');
                this._val('rop-title-bg-border-opacity', ov.title_bg_border_opacity ?? 100);
                this._val('rop-title-bg-pad-bottom', ov.title_bg_pad_bottom ?? 0);
                // Title Decorator Line
                this._val('rop-title-deco-enabled', ov.title_deco_enabled ?? false);
                this._val('rop-title-deco-position', ov.title_deco_position || 'bottom');
                this._val('rop-title-deco-style', ov.title_deco_style || 'solid');
                const titleDecoColEl = this.container.querySelector('#rop-title-deco-color');
                if (titleDecoColEl) {
                    if (ov.title_deco_gradient_direction) titleDecoColEl.dataset.gradientDirection = ov.title_deco_gradient_direction;
                    else delete titleDecoColEl.dataset.gradientDirection;
                }
                this._val('rop-title-deco-color', ov.title_deco_color || '#FFD700');
                this._val('rop-title-deco-color2', ov.title_deco_color2 || '#FF6B35');
                this._val('rop-title-deco-thickness', ov.title_deco_thickness ?? 3);
                this._val('rop-title-deco-length', ov.title_deco_length ?? 0);
                this._val('rop-title-deco-gap', ov.title_deco_gap ?? 12);
                this._val('rop-title-deco-opacity', ov.title_deco_opacity ?? 100);
                this._val('rop-title-deco-align', ov.title_deco_align || 'center');
                const tDecoP = ov.title_deco_parameters || {};
                this._val('rop-title-deco-scale', tDecoP.decorationScale ?? 1);
                this._val('rop-title-deco-center-gap', tDecoP.centerGap ?? 18);
                this._val('rop-title-deco-linecap', tDecoP.lineCap || 'round');
                this._val('rop-title-deco-flip', tDecoP.flip ?? false);
                
                this._val('rop-body-stroke-color', (isIndep ? ov.body_stroke_color : ov.text_stroke_color) || '#000000');
                this._val('rop-body-stroke-width', (isIndep ? ov.body_stroke_width : ov.text_stroke_width) ?? 0);
                this._val('rop-body-shadow-color', (isIndep ? ov.body_shadow_color : ov.text_shadow_color) || '#000000');
                this._val('rop-body-shadow-blur', (isIndep ? ov.body_shadow_blur : ov.text_shadow_blur) ?? 0);
                this._val('rop-body-shadow-x', (isIndep ? ov.body_shadow_x : ov.text_shadow_x) ?? (isIndep ? 0 : 2));
                this._val('rop-body-shadow-y', (isIndep ? ov.body_shadow_y : ov.text_shadow_y) ?? (isIndep ? 0 : 2));
                this._val('rop-body-bg-enabled', ov.body_bg_enabled ?? false);
                this._val('rop-body-bg-mode', ov.body_bg_mode || 'block');
                this._val('rop-body-bg-brush', ov.body_bg_brush ?? false);
                this._val('rop-body-bg-brush-style', ov.body_bg_brush_style || '');
                this._val('rop-body-bg-brush-colormode', ov.body_bg_brush_colormode_v2 ? (ov.body_bg_brush_colormode || 'original') : 'original');
                this._val('rop-body-bg-brush-fit', ov.body_bg_brush_fit || 'stretch');
                this._val('rop-body-bg-brush-zoom', ov.body_bg_brush_zoom ?? 100);
                this._val('rop-body-bg-brush-scale-x', ov.body_bg_brush_scale_x ?? 100);
                this._val('rop-body-bg-brush-scale-y', ov.body_bg_brush_scale_y ?? 100);
                this._val('rop-body-bg-brush-solid', ov.body_bg_brush_solid ?? 100);
                this._val('rop-body-bg-brush-x', ov.body_bg_brush_x ?? 0);
                this._val('rop-body-bg-brush-y', ov.body_bg_brush_y ?? 0);
                const bodyBgEl = this.container.querySelector('#rop-body-bg-color');
                if (bodyBgEl) {
                    if (ov.body_bg_gradient_direction) bodyBgEl.dataset.gradientDirection = ov.body_bg_gradient_direction;
                    else delete bodyBgEl.dataset.gradientDirection;
                }
                this._val('rop-body-bg-color', ov.body_bg_color || '#000000');
                this._val('rop-body-bg-opacity', ov.body_bg_opacity ?? 60);
                this._val('rop-body-bg-radius', ov.body_bg_radius ?? 12);
            this._val('rop-body-bg-concave-radius', ov.body_bg_concave_radius ?? 10);
            this._val('rop-body-bg-snap-threshold', ov.body_bg_snap_threshold ?? 18);
                this._val('rop-body-bg-pad-h', ov.body_bg_pad_h ?? 0);
                this._val('rop-body-bg-pad-top', ov.body_bg_pad_top ?? 0);
                this._val('rop-body-bg-border-enabled', ov.body_bg_border_enabled ?? false);
                this._val('rop-body-bg-border-color', ov.body_bg_border_color ?? '#ffffff');
                this._val('rop-body-bg-border-width', ov.body_bg_border_width ?? 3);
                this._val('rop-body-bg-border-style', ov.body_bg_border_style ?? 'solid');
                this._val('rop-body-bg-border-opacity', ov.body_bg_border_opacity ?? 100);
                this._val('rop-body-bg-pad-bottom', ov.body_bg_pad_bottom ?? 0);
                
                this._val('rop-footer-stroke-color', (isIndep ? ov.footer_stroke_color : ov.text_stroke_color) || '#000000');
                this._val('rop-footer-stroke-width', (isIndep ? ov.footer_stroke_width : ov.text_stroke_width) ?? 0);
                this._val('rop-footer-shadow-color', (isIndep ? ov.footer_shadow_color : ov.text_shadow_color) || '#000000');
                this._val('rop-footer-shadow-blur', (isIndep ? ov.footer_shadow_blur : ov.text_shadow_blur) ?? 0);
                this._val('rop-footer-shadow-x', (isIndep ? ov.footer_shadow_x : ov.text_shadow_x) ?? (isIndep ? 0 : 2));
                this._val('rop-footer-shadow-y', (isIndep ? ov.footer_shadow_y : ov.text_shadow_y) ?? (isIndep ? 0 : 2));
                this._val('rop-footer-bg-enabled', ov.footer_bg_enabled ?? false);
                this._val('rop-footer-bg-mode', ov.footer_bg_mode || 'block');
                this._val('rop-footer-bg-color', ov.footer_bg_color || '#000000');
                this._val('rop-footer-bg-opacity', ov.footer_bg_opacity ?? 60);
                this._val('rop-footer-bg-radius', ov.footer_bg_radius ?? 12);
            this._val('rop-footer-bg-concave-radius', ov.footer_bg_concave_radius ?? 10);
            this._val('rop-footer-bg-snap-threshold', ov.footer_bg_snap_threshold ?? 18);
                this._val('rop-footer-bg-pad-h', ov.footer_bg_pad_h ?? 0);
                this._val('rop-footer-bg-pad-top', ov.footer_bg_pad_top ?? 0);
                this._val('rop-footer-bg-border-enabled', ov.footer_bg_border_enabled ?? false);
                this._val('rop-footer-bg-border-color', ov.footer_bg_border_color ?? '#ffffff');
                this._val('rop-footer-bg-border-width', ov.footer_bg_border_width ?? 3);
                this._val('rop-footer-bg-border-style', ov.footer_bg_border_style ?? 'solid');
                this._val('rop-footer-bg-border-opacity', ov.footer_bg_border_opacity ?? 100);
                this._val('rop-footer-bg-pad-bottom', ov.footer_bg_pad_bottom ?? 0);
                this._val('rop-auto-fit', ov.auto_fit === true);
                this._val('rop-auto-center', ov.auto_center_v === true);
                this._val('rop-offset-x', ov.offset_x ?? 0);
                this._val('rop-offset-y', ov.offset_y ?? 0);
                this._val('rop-title-body-gap', ov.title_body_gap ?? 42);
                this._val('rop-side-by-side-gap', ov.side_by_side_gap ?? 90);
                this._val('rop-side-by-side-title-ratio', ov.side_by_side_title_ratio ?? 50);
                this._val('rop-layout-mode', ov.layout_mode || 'flow');
                this._val('rop-debug-layout', ov.debug_layout === true);
                this._val('rop-debug-title', ov.debug_title === true);
                this._val('rop-debug-body', ov.debug_body === true);
                this._val('rop-debug-footer', ov.debug_footer === true);
                this._val('rop-body-footer-gap', ov.body_footer_gap ?? 42);
                this._val('rop-pad-top', ov.padding_top ?? 60);
                this._val('rop-pad-bottom', ov.padding_bottom ?? 60);
                this._val('rop-pad-left', ov.padding_left ?? 40);
                this._val('rop-pad-right', ov.padding_right ?? 40);
                this._val('rop-auto-shrink', ov.auto_shrink === true);
                this._val('rop-max-height', ov.max_height ?? 1400);
                this._val('rop-title-max-lines', ov.title_max_lines ?? 3);
                this._val('rop-min-fontsize', ov.min_fontsize ?? 16);
                this._syncTextcardAutoFitModeUI();
                this._syncBodyFollowTitleUI();
            }
        }

        if (ov.type === 'scroll') {
            this._val('rop-scroll-content', ov.content || '');
            // 标题
            this._val('rop-scroll-title', ov.scroll_title || '');
            this._val('rop-scroll-title-fontsize', ov.scroll_title_fontsize ?? 56);
            const scrollTitleColEl = this.container.querySelector('#rop-scroll-title-color');
            if (scrollTitleColEl) scrollTitleColEl.dataset.gradientDirection = ov.scroll_title_gradient_direction || 'horizontal';
            this._val('rop-scroll-title-color', ov.scroll_title_color || ov.color || '#ffffff');
            this._val('rop-scroll-title-font', ov.scroll_title_font_family || '');
            this._refreshWeightOptions('rop-scroll-title-weight', ov.scroll_title_font_family || ov.font_family || 'Arial');
            this._val('rop-scroll-title-weight', ov.scroll_title_font_weight ?? 700);
            this._val('rop-scroll-title-uppercase', ov.scroll_title_uppercase !== false);
            this._val('rop-scroll-title-letterspacing', ov.scroll_title_letter_spacing || 0);
            this._val('rop-scroll-title-align', ov.scroll_title_align || '');
            this._val('rop-scroll-title-linespacing', ov.scroll_title_line_spacing ?? 6);
            this._val('rop-scroll-title-textw', ov.scroll_title_text_width || ov.text_width || 900);
            this._val('rop-scroll-title-gap', ov.scroll_title_gap ?? 20);
            this._val('rop-scroll-title-fixed', ov.scroll_title_fixed !== false);
            this._val('rop-scroll-title-independent', ov.scroll_title_independent === true);
            // 标题X/Y：始终显示当前实际位置值（不再显示空的 placeholder）
            {
                const _clipX = parseFloat(ov.x ?? 40);
                const _clipW = parseFloat(ov.w ?? 1000);
                const _clipY = parseFloat(ov.y ?? 100);
                const _legacyLeftX = ov.scroll_x_anchor == null
                    && Math.abs((ov.scroll_from_x ?? 90) - 90) < 0.001
                    && Math.abs((ov.scroll_to_x ?? 90) - 90) < 0.001;
                const _defaultTitleX = _legacyLeftX ? (_clipX + _clipW / 2) : parseFloat(ov.scroll_from_x ?? (_clipX + _clipW / 2));
                const _defaultTitleY = _clipY;
                this._val('rop-scroll-title-x', ov.scroll_title_x ?? Math.round(_defaultTitleX));
                this._val('rop-scroll-title-y', ov.scroll_title_y ?? Math.round(_defaultTitleY));
            }
            this._val('rop-scroll-title-auto-fit', ov.scroll_title_auto_fit === true);
            this._val('rop-scroll-title-maxh', ov.scroll_title_max_height ?? 0);
            this._val('rop-scroll-title-stroke-color', ov.scroll_title_stroke_color || '#000000');
            this._val('rop-scroll-title-stroke-width', ov.scroll_title_stroke_width || 0);
            this._val('rop-scroll-title-shadow', ov.scroll_title_shadow_enabled || false);
            this._val('rop-scroll-title-shadow-color', ov.scroll_title_shadow_color || '#000000');
            this._val('rop-scroll-title-shadow-blur', ov.scroll_title_shadow_blur || 4);
            this._val('rop-scroll-title-shadow-x', ov.scroll_title_shadow_x || 2);
            this._val('rop-scroll-title-shadow-y', ov.scroll_title_shadow_y || 2);
            // 标题独立背景
            this._val('rop-scroll-title-bg-enabled', ov.scroll_title_bg_enabled || false);
            this._val('rop-scroll-title-bg-mode', ov.scroll_title_bg_mode || 'block');
            this._val('rop-scroll-title-bg-color', ov.scroll_title_bg_color || '#000000');
            this._val('rop-scroll-title-bg-opacity', ov.scroll_title_bg_opacity ?? 60);
            this._val('rop-scroll-title-bg-radius', ov.scroll_title_bg_radius ?? 12);
            this._val('rop-scroll-title-bg-concave-radius', ov.scroll_title_bg_concave_radius ?? 10);
            this._val('rop-scroll-title-bg-snap-threshold', ov.scroll_title_bg_snap_threshold ?? 18);
            this._val('rop-scroll-title-bg-pad-h', ov.scroll_title_bg_pad_h ?? 0);
            this._val('rop-scroll-title-bg-pad-top', ov.scroll_title_bg_pad_top ?? 0);
            this._val('rop-scroll-title-bg-pad-bottom', ov.scroll_title_bg_pad_bottom ?? 0);
            // 标题装饰线
            this._val('rop-scroll-title-deco-enabled', ov.scroll_title_deco_enabled || false);
            this._val('rop-scroll-title-deco-position', ov.scroll_title_deco_position || 'bottom');
            this._val('rop-scroll-title-deco-style', ov.scroll_title_deco_style || 'solid');
            this._val('rop-scroll-title-deco-align', ov.scroll_title_deco_align || 'center');
            const scrollTitleDecoColEl = this.container.querySelector('#rop-scroll-title-deco-color');
            if (scrollTitleDecoColEl) {
                if (ov.scroll_title_deco_gradient_direction) scrollTitleDecoColEl.dataset.gradientDirection = ov.scroll_title_deco_gradient_direction;
                else delete scrollTitleDecoColEl.dataset.gradientDirection;
            }
            this._val('rop-scroll-title-deco-color', ov.scroll_title_deco_color || '#FFD700');
            this._val('rop-scroll-title-deco-color2', ov.scroll_title_deco_color2 || '#FF6B35');
            this._val('rop-scroll-title-deco-thickness', ov.scroll_title_deco_thickness ?? 3);
            this._val('rop-scroll-title-deco-length', ov.scroll_title_deco_length ?? 0);
            this._val('rop-scroll-title-deco-opacity', ov.scroll_title_deco_opacity ?? 100);
            const sDecoP = ov.scroll_title_deco_parameters || {};
            this._val('rop-scroll-title-deco-scale', sDecoP.decorationScale ?? 1);
            this._val('rop-scroll-title-deco-center-gap', sDecoP.centerGap ?? 18);
            this._val('rop-scroll-title-deco-linecap', sDecoP.lineCap || 'round');
            this._val('rop-scroll-title-deco-flip', sDecoP.flip ?? false);
            // 正文
            this._val('rop-scroll-font', ov.font_family || 'Arial');
            this._refreshWeightOptions('rop-scroll-weight', ov.font_family || 'Arial');
            this._val('rop-scroll-fontsize', ov.fontsize || 40);
            const scrollColEl = this.container.querySelector('#rop-scroll-color');
            if (scrollColEl) scrollColEl.dataset.gradientDirection = ov.scroll_gradient_direction || ov.gradient_direction || 'horizontal';
            this._val('rop-scroll-color', ov.color || '#ffffff');
            const sw = Math.max(100, Math.min(900, parseInt(ov.font_weight || (ov.bold ? 700 : 400), 10) || 400));
            this._val('rop-scroll-weight', sw);
            this._val('rop-scroll-bold', sw >= 600);
            this._val('rop-scroll-uppercase', ov.scroll_uppercase !== false);
            this._val('rop-scroll-letterspacing', ov.scroll_letter_spacing || 0);
            this._val('rop-scroll-align', ov.text_align || 'center');
            this._val('rop-scroll-text-direction', ov.text_direction || 'auto');
            this._val('rop-scroll-linespacing', ov.line_spacing ?? 6);
            this._val('rop-scroll-textw', ov.text_width ?? 900);
            this._val('rop-scroll-stroke-color', ov.stroke_color || '#000000');
            this._val('rop-scroll-stroke-width', ov.stroke_width || 0);
            this._val('rop-scroll-shadow', ov.shadow_enabled || false);
            this._val('rop-scroll-shadow-color', ov.shadow_color || '#000000');
            this._val('rop-scroll-shadow-blur', ov.shadow_blur || 4);
            this._val('rop-scroll-shadow-x', ov.scroll_shadow_x || 2);
            this._val('rop-scroll-shadow-y', ov.scroll_shadow_y || 2);
            // 正文独立背景
            this._val('rop-scroll-body-bg-enabled', ov.scroll_body_bg_enabled || false);
            this._val('rop-scroll-body-bg-mode', ov.scroll_body_bg_mode || 'block');
            this._val('rop-scroll-body-bg-color', ov.scroll_body_bg_color || '#000000');
            this._val('rop-scroll-body-bg-opacity', ov.scroll_body_bg_opacity ?? 60);
            this._val('rop-scroll-body-bg-radius', ov.scroll_body_bg_radius ?? 12);
            this._val('rop-scroll-body-bg-concave-radius', ov.scroll_body_bg_concave_radius ?? 10);
            this._val('rop-scroll-body-bg-snap-threshold', ov.scroll_body_bg_snap_threshold ?? 18);
            this._val('rop-scroll-body-bg-pad-h', ov.scroll_body_bg_pad_h ?? 0);
            this._val('rop-scroll-body-bg-pad-top', ov.scroll_body_bg_pad_top ?? 0);
            this._val('rop-scroll-body-bg-pad-bottom', ov.scroll_body_bg_pad_bottom ?? 0);
            // 独立同步 起始Y 和 结束Y
            this._val('rop-scroll-from-y', ov.scroll_from_y ?? 960);
            this._val('rop-scroll-to-y', ov.scroll_to_y ?? -200);
            const legacyDefaultLeftX = ov.scroll_x_anchor == null
                && Math.abs((ov.scroll_from_x ?? 90) - 90) < 0.001
                && Math.abs((ov.scroll_to_x ?? 90) - 90) < 0.001;
            this._val('rop-scroll-from-x', legacyDefaultLeftX ? ((ov.x ?? 40) + (ov.w ?? 1000) / 2) : (ov.scroll_from_x ?? 540));
            // 整体偏移
            this._val('rop-scroll-offset-x', ov.scroll_offset_x ?? 0);
            this._val('rop-scroll-offset-y', ov.scroll_offset_y ?? 0);
            // scroll_speed 已移除，速度由 距离÷时间 自动决定
            this._val('rop-scroll-feather-top', ov.feather_top ?? 80);
            this._val('rop-scroll-feather-bottom', ov.feather_bottom ?? 80);
            this._val('rop-scroll-feather-top-offset', ov.feather_top_offset ?? 0);
            this._val('rop-scroll-feather-bottom-offset', ov.feather_bottom_offset ?? 0);
            this._val('rop-scroll-feather-left', ov.feather_left ?? 0);
            this._val('rop-scroll-feather-right', ov.feather_right ?? 0);
            this._val('rop-scroll-feather-left-offset', ov.feather_left_offset ?? 0);
            this._val('rop-scroll-feather-right-offset', ov.feather_right_offset ?? 0);
            this._val('rop-scroll-auto-stop', ov.scroll_auto_stop === true);
            this._val('rop-scroll-auto-stop-lead', ov.scroll_auto_stop_lead ?? 0);
            this._val('rop-scroll-static', ov.scroll_static === true);
            this._val('rop-scroll-auto-fit', ov.scroll_auto_fit === true);
            this._val('rop-scroll-min-fontsize', ov.scroll_min_fontsize ?? 16);
            // 卡片背景
            this._val('rop-scroll-bg-enabled', ov.bg_enabled || false);
            this._val('rop-scroll-bg-color', ov.bg_color || '#000000');
            this._val('rop-scroll-bg-opacity', Math.round((ov.bg_opacity ?? 191) / 255 * 100));
            this._val('rop-scroll-bg-radius', ov.bg_radius ?? 12);
            this._val('rop-scroll-bg-pad-top', ov.bg_padding_top ?? 55);
            this._val('rop-scroll-bg-pad-bottom', ov.bg_padding_bottom ?? 55);
            this._val('rop-scroll-bg-pad-left', ov.bg_padding_left ?? 16);
            this._val('rop-scroll-bg-pad-right', ov.bg_padding_right ?? 16);
            this._val('rop-scroll-bg-fullscreen', ov.bg_fullscreen || false);
            // 卡片边框
            this._val('rop-scroll-bg-border-enabled', ov.bg_border_enabled || false);
            this._val('rop-scroll-bg-border-sides', ov.bg_border_sides || 'all');
            this._val('rop-scroll-bg-border-color', ov.bg_border_color || '#FFD700');
            this._val('rop-scroll-bg-border-width', ov.bg_border_width ?? 3);
            this._val('rop-scroll-bg-border-style', ov.bg_border_style || 'solid');
            this._val('rop-scroll-bg-border-opacity', ov.bg_border_opacity ?? 100);
            // 磨砂模糊
            this._val('rop-scroll-bg-blur-enabled', ov.bg_blur_enabled || false);
            this._val('rop-scroll-bg-blur-amount', ov.bg_blur_amount ?? 10);
        }

        this._val('rop-anim-in', ov.anim_in_type || 'none');
        this._val('rop-anim-out', ov.anim_out_type || 'none');
        this._val('rop-anim-in-dur', ov.anim_in_duration || 0.3);
        this._val('rop-anim-out-dur', ov.anim_out_duration || 0.3);

        // Fixed text flag
        this._val('rop-fixed-text', ov.fixed_text || false);
        
        // ⏱ 文字翻转器 (Dynamic Flipper) 同步
        const hasFlipper = ov.type === 'text' || ov.type === 'textcard';
        const flipperGroup = this.container.querySelector('#rop-flipper-group');
        if (flipperGroup) {
            flipperGroup.style.display = hasFlipper ? 'block' : 'none';
        }
        if (hasFlipper) {
            this._val('rop-flipper-enabled', !!ov.flipper_enabled);
            this._val('rop-flipper-duration', ov.flipper_duration ?? 2.0);
            this._val('rop-flipper-lines', ov.flipper_lines ?? 2);
            this._val('rop-flipper-loop', !!ov.flipper_loop);
            this._val('rop-flipper-effect', ov.flipper_effect || 'none');
            this._val('rop-flipper-transition-duration', ov.flipper_transition_duration ?? 0.3);
            this._updateFlipperInfo(ov);
        }

        // 自动着色规则属于覆层数据，也会随项目和覆层组预设一起保存。
        // 之前这里仅同步普通表单字段，漏掉了动态规则列表，导致重启/加载
        // 后画面仍按规则着色，但设置区错误地显示“暂无规则”。
        const autoColorProps = this.container.querySelector('#rop-autocolor-props');
        if (autoColorProps) {
            const supportsAutoColor = ov.type === 'textcard' || ov.type === 'scroll';
            autoColorProps.style.display = supportsAutoColor ? '' : 'none';
            if (supportsAutoColor) this._renderAutoColorRules();
        }

        this._syncAnimTimingFields('mode', false);
    }

    /** A→B 起点字段现已独立，无需镜像同步 */
    _updateAnimStartRef() {
        // 起点X/Y/缩放已改为独立可编辑，不再自动同步
    }

    _syncAnimTimingFields(source = 'mode', syncOverlay = true) {
        if (!this._selectedOv) return;
        const modeEl = this.container.querySelector('#rop-anim-timing-mode');
        const durationEl = this.container.querySelector('#rop-anim-duration');
        const speedEl = this.container.querySelector('#rop-anim-speed');
        if (!modeEl || !durationEl || !speedEl) return;

        if (source === 'duration') modeEl.value = 'duration';
        if (source === 'speed') modeEl.value = 'speed';

        const sx = parseFloat(this._get('rop-anim-start-x'));
        const sy = parseFloat(this._get('rop-anim-start-y'));
        const ex = parseFloat(this._get('rop-anim-end-x'));
        const ey = parseFloat(this._get('rop-anim-end-y'));
        if (![sx, sy, ex, ey].every(Number.isFinite)) return;

        const distance = Math.hypot(ex - sx, ey - sy);
        if (!(distance > 0)) return;

        const mode = modeEl.value || 'duration';
        const duration = parseFloat(durationEl.value) || 0;
        const speed = parseFloat(speedEl.value) || 0;
        const roundDuration = (v) => Math.round(v * 1000) / 1000;
        const roundSpeed = (v) => Math.round(v * 100) / 100;

        if ((source === 'speed' || mode === 'speed') && speed > 0) {
            durationEl.value = String(roundDuration(distance / speed));
        } else if ((source === 'duration' || mode === 'duration' || source === 'points') && duration > 0) {
            speedEl.value = String(roundSpeed(distance / duration));
        }

        if (syncOverlay) this._syncToOverlay();
    }

    _updateFlipperInfo(ov) {
        if (!ov || (ov.type !== 'text' && ov.type !== 'textcard')) return;
        const text = (ov.type === 'textcard') ? (ov.body_text || '') : (ov.content || '');
        const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0);
        const totalLines = lines.length;
        const flipper_lines = parseInt(this._get('rop-flipper-lines')) || 2;
        const flipper_duration = parseFloat(this._get('rop-flipper-duration')) || 2.0;
        const totalChunks = Math.ceil(totalLines / flipper_lines);
        const totalDur = totalChunks * flipper_duration;
        
        const infoEl = this.container.querySelector('#rop-flipper-duration-info');
        if (infoEl) {
            infoEl.innerHTML = `💡 翻转完毕需: <strong>${totalDur.toFixed(1)}秒</strong> (总行数: ${totalLines}, 每组显示: ${flipper_lines}行, 切换间隔: ${flipper_duration}s)`;
        }
    }

    _getMediaWindowGeometry(ov) {
        const geometry = {x:ov.x,y:ov.y,w:ov.w,h:ov.h};
        if (['image','video'].includes(ov.type) && ov.media_window_mode === 'pip' && ov.media_window) {
            for (const key of ['x','y','w','h']) {
                const value = ov.media_window[key];
                if (value != null && Number.isFinite(Number(value)) &&
                    (key === 'x' || key === 'y' || Number(value) > 0)) geometry[key] = Number(value);
            }
        }
        return geometry;
    }

    _syncMediaGeometryToOverlay(ov, field) {
        // The renderer uses media_window as its source. Preserve that visible window
        // when legacy overlay coordinates or drag snapshots have diverged from it.
        Object.assign(ov, this._getMediaWindowGeometry(ov));
        // Style/crop/playback edits must never round-trip unrelated geometry through UI values.
        if (field === 'rop-x' || field === 'rop-y') {
            const { cx, cy } = this._getCanvasSize();
            if (field === 'rop-x') ov.x = this._get(field) + cx - (Number(ov.w) || 0) / 2;
            else ov.y = this._get(field) + cy - (Number(ov.h) || 0) / 2;
        }
        if (this._get('rop-media-window-mode') !== 'pip' ||
            !['rop-media-window-width', 'rop-media-window-height', 'rop-media-window-ratio'].includes(field)) return;
        const ratio = this._get('rop-media-window-ratio') || 'free';
        const width = Number(this._get('rop-media-window-width'));
        const height = Number(this._get('rop-media-window-height'));
        if (field === 'rop-media-window-width' && width > 0) ov.w = Math.max(1, Math.round(width));
        if (ratio === 'free') {
            if (field === 'rop-media-window-height' && height > 0) ov.h = Math.max(1, Math.round(height));
        } else {
            const [rw, rh] = ratio.split(':').map(Number);
            if (rw > 0 && rh > 0) ov.h = Math.max(1, Math.round(ov.w * rh / rw));
        }
        ov.media_window_ratio = ratio;
        // Resizing keeps the top-left anchor and refreshes the corresponding center readouts.
        const center = this._toCenterPos(ov.x, ov.y, ov.w, ov.h);
        this._val('rop-x', center.x);this._val('rop-y', center.y);
        this._val('rop-media-window-width', ov.w);this._val('rop-media-window-height', ov.h);
    }

    _syncToOverlay(changedField = null) {
        const ov = this._selectedOv;
        if (!ov) return;
        if(['text','textcard','scroll'].includes(ov.type))ov.synthetic_bold_enabled=this._get('rop-synthetic-bold')===true;
        // 同步后更新 A 点参考
        setTimeout(() => this._updateAnimStartRef(), 0);

        const isMedia = ov.type === 'image' || ov.type === 'video';
        if (ov.type === 'textcard' || ov.type === 'solid_mask') {
            ov.w = this._get('rop-card-width');
            ov.h = this._get('rop-card-height');
        } else if (!isMedia) {
            ov.w = this._get('rop-w');
            ov.h = this._get('rop-h');
        }
        if (isMedia) {
            this._syncMediaGeometryToOverlay(ov, changedField);
        } else if (ov.type === 'scroll') {
            ov.x = this._get('rop-x');
            ov.y = this._get('rop-y');
        } else {
            const centerX = (ov.type === 'textcard' || ov.type === 'solid_mask') ? this._get('rop-card-x') : this._get('rop-x');
            const centerY = (ov.type === 'textcard' || ov.type === 'solid_mask') ? this._get('rop-card-y') : this._get('rop-y');
            const mapW = Math.max(0, ov.w || 0);
            let mapH = Math.max(0, ov.h || 0);
            if ((ov.type === 'textcard' || ov.type === 'solid_mask') && mapH <= 0) {
                mapH = Math.max(0, ov._renderedH || 0);
            }
            const topLeft = this._toTopLeftFromCenter(centerX, centerY, mapW, mapH);
            ov.x = topLeft.x;
            ov.y = topLeft.y;
        }
        ov.rotation = this._get('rop-rotation');
        ov.opacity = Math.round(this._get('rop-opacity') / 100 * 255);
        ov.start = _ropRound(this._get('rop-start'));
        // 保留 9999（全程）：如果面板显示的值等于视频时长，说明用户没改，保持 9999
        const panelEnd = _ropRound(this._get('rop-end'));
        if (ov.end >= 9999) {
            // 检查用户是否手动修改了结束时间
            const v2Duration = this.videoCanvas?.getDuration ? this.videoCanvas.getDuration() : window.ReelsPreviewV2?.isOpen?.()
                ? window.ReelsPreviewV2.getDuration?.()
                : 0;
            const mediaEl = document.getElementById('reels-preview-video') || document.querySelector('#reels-preview video');
            const videoDur = (v2Duration && isFinite(v2Duration))
                ? _ropRound(v2Duration)
                : ((mediaEl && mediaEl.duration && isFinite(mediaEl.duration)) ? _ropRound(mediaEl.duration) : 9999);
            if (panelEnd === videoDur || panelEnd >= 9999) {
                // 用户没改，保持 9999（全程）
            } else {
                ov.end = panelEnd;  // 用户手动改了
            }
        } else {
            ov.end = panelEnd;
        }
        
        ov.anim_dest_enabled = !!this._get('rop-anim-dest-enabled');
        ov.anim_easing = this._get('rop-anim-easing') || 'ease_in_out_quad';
        ov.anim_timing_mode = this._get('rop-anim-timing-mode') || 'duration';
        ov.anim_duration = Math.max(0, parseFloat(this._get('rop-anim-duration')) || 0);
        ov.anim_speed = Math.max(0, parseFloat(this._get('rop-anim-speed')) || 0);
        const currentAnimX = ov.type === 'textcard' ? this._get('rop-card-x') : this._get('rop-x');
        const currentAnimY = ov.type === 'textcard' ? this._get('rop-card-y') : this._get('rop-y');
        const readAnimNumber = (id, fallback) => {
            const val = parseFloat(this._get(id));
            return Number.isFinite(val) ? val : fallback;
        };
        ov.anim_start_x = readAnimNumber('rop-anim-start-x', currentAnimX || 0);
        ov.anim_start_y = readAnimNumber('rop-anim-start-y', currentAnimY || 0);
        ov.anim_end_x = readAnimNumber('rop-anim-end-x', ov.anim_start_x);
        ov.anim_end_y = readAnimNumber('rop-anim-end-y', ov.anim_start_y);
        ov.anim_start_scale = readAnimNumber('rop-anim-start-scale', 100);
        ov.anim_end_scale = readAnimNumber('rop-anim-end-scale', ov.anim_start_scale);

        if (ov.type === 'text') {
            ov.content = this._get('rop-content');
            ov.font_family = this._get('rop-font');
            ov.fontsize = this._get('rop-fontsize');
            ov.color = this._get('rop-color');
            ov.gradient_direction = this.container.querySelector('#rop-color')?.dataset?.gradientDirection || ov.gradient_direction || 'horizontal';
            const fw = Math.max(100, Math.min(900, parseInt(this._get('rop-font-weight') || (this._get('rop-bold') ? 700 : 400), 10) || 400));
            ov.font_weight = fw;
            ov.bold = fw >= 600;
            ov.use_stroke = this._get('rop-use-stroke');
            ov.stroke_color = this._get('rop-stroke-color');
            ov.stroke_width = this._get('rop-stroke-width');
            ov.shadow_enabled = this._get('rop-shadow-enabled');
            ov.shadow_color = this._get('rop-shadow-color');
            ov.shadow_blur = this._get('rop-shadow-blur');
            ov.shadow_offset_x = this._get('rop-shadow-offset-x');
            ov.shadow_offset_y = this._get('rop-shadow-offset-y');
            ov.shadow_opacity = Math.round(Math.max(0, Math.min(100, this._get('rop-shadow-opacity'))) / 100 * 255);
        }

        if (ov.type === 'image' || ov.type === 'video') {
            ov.scale_x = Math.max(0.01, this._get('rop-scale-x') / 100);
            ov.scale_y = Math.max(0.01, this._get('rop-scale-y') / 100);
            // 兼容旧版工程/插件仍读取单轴 scale 的路径；新渲染优先使用 X/Y。
            ov.scale = ov.scale_x;
            ov.flip_x = this._get('rop-flip-h');
            ov.flip_y = this._get('rop-flip-v');
            ov.blend_mode = this._get('rop-blend');
            ov.video_start_offset = parseFloat(this._get('rop-video-offset')) || 0;
            const sourceEnd = parseFloat(this._get('rop-video-end'));
            ov.video_end_offset = Number.isFinite(sourceEnd) && sourceEnd > ov.video_start_offset ? sourceEnd : null;
            ov.keep_aspect = this._get('rop-keep-aspect');
            ov.media_loop = this._get('rop-media-loop') !== false;
            // 默认静音；只有用户明确开启时，才把视频覆层原声交给复合片段导出。
            ov.media_audio_enabled = this._get('rop-media-audio-enabled') === true;
            const borderStyle = this._get('rop-media-border-style') || 'none';
            if (borderStyle !== 'none') {
                ov.media_border_style = borderStyle;
                ov.media_border_position = this._get('rop-media-border-position') === 'outside' ? 'outside' : 'inside';
                ov.media_border_color = this._get('rop-media-border-color') || '#ffffff';
                ov.media_border_width = Math.max(1, Math.min(100, Number(this._get('rop-media-border-width')) || 3));
                ov.media_border_opacity = Math.max(0, Math.min(100, Number(this._get('rop-media-border-opacity')) || 0));
            } else {
                for (const key of ['media_border_style','media_border_position','media_border_color','media_border_width','media_border_opacity']) delete ov[key];
            }
            ov.media_blur_fill = this._get('rop-media-blur-fill') === true;
            ov.media_folder_interval = Math.max(0, parseFloat(this._get('rop-media-folder-interval')) || 0);
            const mediaWindowMode = this._get('rop-media-window-mode') || 'none';
            // 旧变换仍是外层覆层的总控制；PIP 只是基于这个总变换再增加内层取景。
            if (mediaWindowMode === 'none') {
                delete ov.media_window_mode;
                delete ov.media_window;
                delete ov.media_window_initialized;
                delete ov.media_inner_x;
                delete ov.media_inner_y;
                delete ov.media_inner_scale;
                delete ov.media_inner_rotation;
                if (ov.media_window_generated_clip) {
                    delete ov.clip_rect;
                    delete ov.crop_fill;
                    delete ov.media_window_generated_clip;
                }
            } else {
                ov.media_window = ['top_half', 'bottom_half'].includes(mediaWindowMode)
                    ? { x: 0, y: mediaWindowMode === 'top_half' ? 0 : 960, w: 1080, h: 960, locked: true }
                    : { x: ov.x || 0, y: ov.y || 0, w: ov.w || 1080, h: ov.h || 960 };
                if (mediaWindowMode === 'pip') ov.media_window_initialized = true;
                ov.media_inner_x = parseFloat(this._get('rop-media-inner-x')) || 0;
                ov.media_inner_y = parseFloat(this._get('rop-media-inner-y')) || 0;
                ov.media_inner_scale = Math.max(0.01, (parseFloat(this._get('rop-media-inner-scale')) || 100) / 100);
                ov.media_inner_rotation = parseFloat(this._get('rop-media-inner-rotation')) || 0;
                ov.media_mask_shape = this._get('rop-media-mask-shape') || 'rect';
                ov.media_corner_tl = Math.max(0, parseFloat(this._get('rop-media-corner-tl')) || 0);
                ov.media_corner_tr = Math.max(0, parseFloat(this._get('rop-media-corner-tr')) || 0);
                ov.media_corner_br = Math.max(0, parseFloat(this._get('rop-media-corner-br')) || 0);
                ov.media_corner_bl = Math.max(0, parseFloat(this._get('rop-media-corner-bl')) || 0);
                ov.media_window_mode = mediaWindowMode;
            }
            // 四向裁切独立于显示模式：原始覆层、画中画、上下半屏都使用同一取景。
            const crop = (id) => Math.max(0, Math.min(99, parseFloat(this._get(id)) || 0));
            ov.media_crop_left = crop('rop-media-crop-left');
            ov.media_crop_top = crop('rop-media-crop-top');
            ov.media_crop_right = crop('rop-media-crop-right');
            ov.media_crop_bottom = crop('rop-media-crop-bottom');
            if (mediaWindowMode === 'top_half' || mediaWindowMode === 'bottom_half') {
                const windowY = mediaWindowMode === 'top_half' ? 0 : 960;
                ov.clip_rect = { x: 0, y: windowY, w: 1080, h: 960 };
                ov.crop_fill = true;
                ov.media_window_generated_clip = true;
            } else if (mediaWindowMode === 'pip') {
                // 用窗口坐标保存裁切范围；渲染器只把 inner X/Y 加到素材上。
                ov.clip_rect = { x: ov.x || 0, y: ov.y || 0, w: ov.w || 1080, h: ov.h || 960 };
                ov.crop_fill = true;
                ov.media_window_generated_clip = true;
            }

            // 跟随滚动字幕绑定
            const bindTarget = this._get('rop-bind-scroll-target') || '';
            ov.bind_scroll_overlay_id = bindTarget || null;
            ov.bind_scroll_offset_y = parseFloat(this._get('rop-bind-scroll-offset-y')) || 0;
            ov.bind_scroll_offset_x = parseFloat(this._get('rop-bind-scroll-offset-x')) || 0;
            ov.bind_scroll_follow_x = this._get('rop-bind-scroll-follow-x') || false;
            const clampMinEl = this.container.querySelector('#rop-bind-scroll-clamp-min-y');
            ov.bind_scroll_clamp_min_y = (clampMinEl && clampMinEl.value !== '') ? parseFloat(clampMinEl.value) : null;
            const clampMaxEl = this.container.querySelector('#rop-bind-scroll-clamp-max-y');
            ov.bind_scroll_clamp_max_y = (clampMaxEl && clampMaxEl.value !== '') ? parseFloat(clampMaxEl.value) : null;
        }

        if (ov.type === 'textcard' || ov.type === 'solid_mask') {
            ov.card_enabled = this._get('rop-card-enabled');
            ov.card_color = this._get('rop-card-color');
            const cardColEl = this.container.querySelector('#rop-card-color');
            if (cardColEl?.dataset?.gradientDirection) ov.card_gradient_direction = cardColEl.dataset.gradientDirection;
            ov.card_opacity = this._get('rop-card-opacity');
            ov.card_feather_enabled = this._get('rop-card-feather-enabled');
            ov.card_feather_dir = this._get('rop-card-feather-dir');
            ov.card_feather_start = this._get('rop-card-feather-start');
            ov.card_feather_end = this._get('rop-card-feather-end');
            this._syncTextcardMaskEnabledUI();
            ov.card_border_enabled = this._get('rop-card-border-enabled');
            ov.card_border_sides = this._get('rop-card-border-sides') || 'all';
            ov.card_border_color = this._get('rop-card-border-color');
            ov.card_border_width = this._get('rop-card-border-width');
            ov.card_border_style = this._get('rop-card-border-style');
            ov.card_border_opacity = this._get('rop-card-border-opacity');
            ov.card_blur_enabled = this._get('rop-card-blur-enabled');
            ov.card_blur_amount = this._get('rop-card-blur-amount');
            const radius = this._get('rop-radius-all');
            ov.radius_tl = radius;
            ov.radius_tr = radius;
            ov.radius_bl = radius;
            ov.radius_br = radius;
            ov.fullscreen_mask = this._get('rop-fullscreen-mask');
            ov.name = this._get('rop-name') || '';
            ov.fixed_text = this._get('rop-fixed-text');

            if (ov.type === 'textcard') {
                const newTitleText = this._get('rop-title-text');
                if (newTitleText !== ov.title_text) ov.title_styled_ranges = null; // 文本改变→失效旧样式范围
                ov.title_text = newTitleText;
                ov.title_offset_x = this._get('rop-title-offset-x');
                ov.title_offset_y = this._get('rop-title-offset-y');
                ov.title_font_family = this._get('rop-title-font');
                ov.title_fontsize = this._get('rop-title-fontsize');
                ov.title_color = this._get('rop-title-color');
                ov.title_gradient_direction = this.container.querySelector('#rop-title-color')?.dataset?.gradientDirection || ov.title_gradient_direction || 'horizontal';
                const tw = Math.max(100, Math.min(900, parseInt(this._get('rop-title-weight') || (this._get('rop-title-bold') ? 900 : 400), 10) || 900));
                ov.title_font_weight = tw;
                ov.title_bold = tw >= 600;
                ov.title_uppercase = this._get('rop-title-uppercase');
                ov.title_align = this._get('rop-title-align');
                ov.title_valign = this._get('rop-title-valign');
                ov.title_letter_spacing = this._get('rop-title-letterspacing');
                ov.title_override_w = this._getTextcardStoredWidth('rop-title-override-w');
                ov.title_override_h = this._get('rop-title-override-h');
                ov.title_auto_shrink = false; // Replaced by the single adaptive master switch.
                ov.title_max_glyph_height = Math.max(1, this._get('rop-title-max-glyph-height') || 60);
                ov.title_adaptive_enabled = this._get('rop-title-adaptive-enabled') === true;
                ov.title_preferred_glyph_height = Math.max(1, this._get('rop-title-preferred-glyph-height') || 45);
                ov.title_adaptive_min_w = Math.max(1, this._get('rop-title-adaptive-min-w') || 1080);
                ov.title_adaptive_min_h = Math.max(1, this._get('rop-title-adaptive-min-h') || 200);
                ov.title_adaptive_max_w = Math.max(1, this._get('rop-title-adaptive-max-w') || 1080);
                ov.title_adaptive_max_h = Math.max(1, this._get('rop-title-adaptive-max-h') || 300);
                ov.title_adaptive_max_lines = Math.max(1, Math.min(10, parseInt(this._get('rop-title-adaptive-max-lines'), 10) || 3));
                this._syncTitleAdaptiveUI();
                ov.title_line_spacing = this._get('rop-title-linespacing');
                ov.title_rotation = this._get('rop-title-rotation');
                const newBodyText = this._get('rop-body-text');
                if (newBodyText !== ov.body_text) ov.body_styled_ranges = null;
                ov.body_text = newBodyText;
                ov.body_follow_title = this._get('rop-body-follow-title');
                ov.body_offset_x = this._get('rop-body-offset-x');
                ov.body_offset_y = this._get('rop-body-offset-y');
                ov.body_font_family = this._get('rop-body-font');
                ov.body_fontsize = this._get('rop-body-fontsize');
                ov.body_color = this._get('rop-body-color');
                ov.body_gradient_direction = this.container.querySelector('#rop-body-color')?.dataset?.gradientDirection || ov.body_gradient_direction || 'horizontal';
                const bw = Math.max(100, Math.min(900, parseInt(this._get('rop-body-weight') || (this._get('rop-body-bold') ? 700 : 400), 10) || 400));
                ov.body_font_weight = bw;
                ov.body_bold = bw >= 600;
                ov.body_letter_spacing = this._get('rop-body-letterspacing');
                ov.body_override_w = this._getTextcardStoredWidth('rop-body-override-w');
                ov.body_override_h = this._get('rop-body-override-h');
                ov.body_auto_shrink = this._get('rop-body-auto-shrink');
                ov.body_line_spacing = this._get('rop-body-linespacing');
                ov.body_align = this._get('rop-body-align');
                ov.body_valign = this._get('rop-body-valign');
                // Footer
                const newFooterText = this._get('rop-footer-text');
                if (newFooterText !== ov.footer_text) ov.footer_styled_ranges = null;
                ov.footer_text = newFooterText;
                ov.footer_offset_x = this._get('rop-footer-offset-x');
                ov.footer_offset_y = this._get('rop-footer-offset-y');
                ov.footer_font_family = this._get('rop-footer-font');
                ov.footer_fontsize = this._get('rop-footer-fontsize');
                ov.footer_color = this._get('rop-footer-color');
                ov.footer_gradient_direction = this.container.querySelector('#rop-footer-color')?.dataset?.gradientDirection || ov.footer_gradient_direction || 'horizontal';
                const ftw = Math.max(100, Math.min(900, parseInt(this._get('rop-footer-weight') || (this._get('rop-footer-bold') ? 700 : 400), 10) || 400));
                ov.footer_font_weight = ftw;
                ov.footer_bold = ftw >= 600;
                ov.footer_letter_spacing = this._get('rop-footer-letterspacing');
                ov.footer_override_w = this._getTextcardStoredWidth('rop-footer-override-w');
                ov.footer_override_h = this._get('rop-footer-override-h');
                ov.footer_auto_shrink = this._get('rop-footer-auto-shrink');
                ov.footer_line_spacing = this._get('rop-footer-linespacing');
                ov.footer_align = this._get('rop-footer-align');
                ov.footer_valign = this._get('rop-footer-valign');
                // We now permanently use independent effects format internally.
                ov.independent_effects = true;
                // Title effects
                ov.title_stroke_color = this._get('rop-title-stroke-color');
                ov.title_stroke_width = this._get('rop-title-stroke-width');
                ov.title_shadow_color = this._get('rop-title-shadow-color');
                ov.title_shadow_blur = this._get('rop-title-shadow-blur');
                ov.title_shadow_x = this._get('rop-title-shadow-x');
                ov.title_shadow_y = this._get('rop-title-shadow-y');
                ov.title_bg_border_enabled = this._get('rop-title-bg-border-enabled');
                ov.title_bg_border_color = this._get('rop-title-bg-border-color');
                ov.title_bg_border_width = this._get('rop-title-bg-border-width');
                ov.title_bg_border_style = this._get('rop-title-bg-border-style');
                ov.title_bg_border_opacity = this._get('rop-title-bg-border-opacity');
                ov.title_bg_enabled = this._get('rop-title-bg-enabled');
                ov.title_bg_mode = this._get('rop-title-bg-mode');
                ov.title_bg_color = this._get('rop-title-bg-color');
                const titleBgColEl = this.container.querySelector('#rop-title-bg-color');
                if (titleBgColEl?.dataset?.gradientDirection) ov.title_bg_gradient_direction = titleBgColEl.dataset.gradientDirection;
                ov.title_bg_opacity = this._get('rop-title-bg-opacity');
                ov.title_bg_concave_radius = this._get('rop-title-bg-concave-radius') ?? 10;
            ov.title_bg_snap_threshold = this._get('rop-title-bg-snap-threshold') ?? 18;
            ov.title_bg_radius = this._get('rop-title-bg-radius');
                ov.title_bg_brush = this._get('rop-title-bg-brush');
                ov.title_bg_brush_style = this._get('rop-title-bg-brush-style') || '';
                ov.title_bg_brush_colormode = this._get('rop-title-bg-brush-colormode') || 'original';
                ov.title_bg_brush_colormode_v2 = true;
                ov.title_bg_brush_fit = this._get('rop-title-bg-brush-fit') || 'stretch';
                const tBrushZoom = this._get('rop-title-bg-brush-zoom');
                ov.title_bg_brush_zoom = typeof tBrushZoom === 'number' && !isNaN(tBrushZoom) && tBrushZoom > 0 ? tBrushZoom : 100;
                const tBrushScaleX = this._get('rop-title-bg-brush-scale-x');
                const tBrushScaleY = this._get('rop-title-bg-brush-scale-y');
                ov.title_bg_brush_scale_x = typeof tBrushScaleX === 'number' && !isNaN(tBrushScaleX) ? tBrushScaleX : 100;
                ov.title_bg_brush_scale_y = typeof tBrushScaleY === 'number' && !isNaN(tBrushScaleY) ? tBrushScaleY : 100;
                const tBrushSolid = this._get('rop-title-bg-brush-solid');
                ov.title_bg_brush_solid = typeof tBrushSolid === 'number' && !isNaN(tBrushSolid) ? tBrushSolid : 100;
                const tBrushX = this._get('rop-title-bg-brush-x');
                const tBrushY = this._get('rop-title-bg-brush-y');
                ov.title_bg_brush_x = typeof tBrushX === 'number' && !isNaN(tBrushX) ? tBrushX : 0;
                ov.title_bg_brush_y = typeof tBrushY === 'number' && !isNaN(tBrushY) ? tBrushY : 0;
                if (ov.title_bg_brush && ov.title_bg_enabled && window.ReelsOverlay?.ReelsBrushEngine?.getCustomBrushData) {
                    const cData = window.ReelsOverlay.ReelsBrushEngine.getCustomBrushData(ov.title_bg_brush_style);
                    if (cData) ov.title_custom_brush_data = cData;
                    else delete ov.title_custom_brush_data;
                } else delete ov.title_custom_brush_data;
                const tPadH = this._get('rop-title-bg-pad-h');
                const tPadTop = this._get('rop-title-bg-pad-top');
                const tPadBot = this._get('rop-title-bg-pad-bottom');
                ov.title_bg_pad_h = typeof tPadH === 'number' && !isNaN(tPadH) ? tPadH : undefined;
                ov.title_bg_pad_top = typeof tPadTop === 'number' && !isNaN(tPadTop) ? tPadTop : undefined;
                ov.title_bg_pad_bottom = typeof tPadBot === 'number' && !isNaN(tPadBot) ? tPadBot : undefined;
                // Title Decorator Line
                ov.title_deco_enabled = this._get('rop-title-deco-enabled');
                ov.title_deco_position = this._get('rop-title-deco-position');
                ov.title_deco_style = this._get('rop-title-deco-style');
                ov.title_deco_color = this._get('rop-title-deco-color');
                const titleDecoColEl = this.container.querySelector('#rop-title-deco-color');
                if (titleDecoColEl?.dataset?.gradientDirection) ov.title_deco_gradient_direction = titleDecoColEl.dataset.gradientDirection;
                ov.title_deco_color2 = this._get('rop-title-deco-color2');
                ov.title_deco_thickness = this._get('rop-title-deco-thickness');
                ov.title_deco_length = this._get('rop-title-deco-length');
                ov.title_deco_gap = this._get('rop-title-deco-gap');
                ov.title_deco_opacity = this._get('rop-title-deco-opacity');
                ov.title_deco_align = this._get('rop-title-deco-align');
                ov.title_deco_parameters = {
                    ...(ov.title_deco_parameters || {}),
                    decorationScale: parseFloat(this._get('rop-title-deco-scale')) || 1,
                    centerGap: parseFloat(this._get('rop-title-deco-center-gap')) || 18,
                    lineCap: this._get('rop-title-deco-linecap') || 'round',
                    flip: !!this._get('rop-title-deco-flip')
                };
                // Body effects
                ov.body_stroke_color = this._get('rop-body-stroke-color');
                ov.body_stroke_width = this._get('rop-body-stroke-width');
                ov.body_shadow_color = this._get('rop-body-shadow-color');
                ov.body_shadow_blur = this._get('rop-body-shadow-blur');
                ov.body_shadow_x = this._get('rop-body-shadow-x');
                ov.body_shadow_y = this._get('rop-body-shadow-y');
                ov.body_bg_border_enabled = this._get('rop-body-bg-border-enabled');
                ov.body_bg_border_color = this._get('rop-body-bg-border-color');
                ov.body_bg_border_width = this._get('rop-body-bg-border-width');
                ov.body_bg_border_style = this._get('rop-body-bg-border-style');
                ov.body_bg_border_opacity = this._get('rop-body-bg-border-opacity');
                ov.body_bg_enabled = this._get('rop-body-bg-enabled');
                ov.body_bg_mode = this._get('rop-body-bg-mode');
                ov.body_bg_brush = this._get('rop-body-bg-brush');
                ov.body_bg_brush_style = this._get('rop-body-bg-brush-style') || '';
                ov.body_bg_brush_colormode = this._get('rop-body-bg-brush-colormode') || 'original';
                ov.body_bg_brush_colormode_v2 = true;
                ov.body_bg_brush_fit = this._get('rop-body-bg-brush-fit') || 'stretch';
                const bBrushZoom = this._get('rop-body-bg-brush-zoom');
                ov.body_bg_brush_zoom = typeof bBrushZoom === 'number' && !isNaN(bBrushZoom) && bBrushZoom > 0 ? bBrushZoom : 100;
                const bBrushScaleX = this._get('rop-body-bg-brush-scale-x');
                const bBrushScaleY = this._get('rop-body-bg-brush-scale-y');
                ov.body_bg_brush_scale_x = typeof bBrushScaleX === 'number' && !isNaN(bBrushScaleX) ? bBrushScaleX : 100;
                ov.body_bg_brush_scale_y = typeof bBrushScaleY === 'number' && !isNaN(bBrushScaleY) ? bBrushScaleY : 100;
                const bBrushSolid = this._get('rop-body-bg-brush-solid');
                ov.body_bg_brush_solid = typeof bBrushSolid === 'number' && !isNaN(bBrushSolid) ? bBrushSolid : 100;
                const bBrushX = this._get('rop-body-bg-brush-x');
                const bBrushY = this._get('rop-body-bg-brush-y');
                ov.body_bg_brush_x = typeof bBrushX === 'number' && !isNaN(bBrushX) ? bBrushX : 0;
                ov.body_bg_brush_y = typeof bBrushY === 'number' && !isNaN(bBrushY) ? bBrushY : 0;
                if (ov.body_bg_brush && ov.body_bg_enabled && window.ReelsOverlay?.ReelsBrushEngine?.getCustomBrushData) {
                    const cData = window.ReelsOverlay.ReelsBrushEngine.getCustomBrushData(ov.body_bg_brush_style);
                    if (cData) ov.body_custom_brush_data = cData;
                    else delete ov.body_custom_brush_data;
                } else delete ov.body_custom_brush_data;
                ov.body_bg_color = this._get('rop-body-bg-color');
                const bodyBgColEl = this.container.querySelector('#rop-body-bg-color');
                if (bodyBgColEl?.dataset?.gradientDirection) ov.body_bg_gradient_direction = bodyBgColEl.dataset.gradientDirection;
                ov.body_bg_opacity = this._get('rop-body-bg-opacity');
                ov.body_bg_concave_radius = this._get('rop-body-bg-concave-radius') ?? 10;
            ov.body_bg_snap_threshold = this._get('rop-body-bg-snap-threshold') ?? 18;
            ov.body_bg_radius = this._get('rop-body-bg-radius');
                const bPadH = this._get('rop-body-bg-pad-h');
                const bPadTop = this._get('rop-body-bg-pad-top');
                const bPadBot = this._get('rop-body-bg-pad-bottom');
                ov.body_bg_pad_h = typeof bPadH === 'number' && !isNaN(bPadH) ? bPadH : undefined;
                ov.body_bg_pad_top = typeof bPadTop === 'number' && !isNaN(bPadTop) ? bPadTop : undefined;
                ov.body_bg_pad_bottom = typeof bPadBot === 'number' && !isNaN(bPadBot) ? bPadBot : undefined;
                // Footer effects
                ov.footer_stroke_color = this._get('rop-footer-stroke-color');
                ov.footer_stroke_width = this._get('rop-footer-stroke-width');
                ov.footer_shadow_color = this._get('rop-footer-shadow-color');
                ov.footer_shadow_blur = this._get('rop-footer-shadow-blur');
                ov.footer_shadow_x = this._get('rop-footer-shadow-x');
                ov.footer_shadow_y = this._get('rop-footer-shadow-y');
                ov.footer_bg_border_enabled = this._get('rop-footer-bg-border-enabled');
                ov.footer_bg_border_color = this._get('rop-footer-bg-border-color');
                ov.footer_bg_border_width = this._get('rop-footer-bg-border-width');
                ov.footer_bg_border_style = this._get('rop-footer-bg-border-style');
                ov.footer_bg_border_opacity = this._get('rop-footer-bg-border-opacity');
                ov.footer_bg_enabled = this._get('rop-footer-bg-enabled');
                ov.footer_bg_mode = this._get('rop-footer-bg-mode');
                ov.footer_bg_color = this._get('rop-footer-bg-color');
                const footerBgColEl = this.container.querySelector('#rop-footer-bg-color');
                if (footerBgColEl?.dataset?.gradientDirection) ov.footer_bg_gradient_direction = footerBgColEl.dataset.gradientDirection;
                ov.footer_bg_opacity = this._get('rop-footer-bg-opacity');
                ov.footer_bg_concave_radius = this._get('rop-footer-bg-concave-radius') ?? 10;
            ov.footer_bg_snap_threshold = this._get('rop-footer-bg-snap-threshold') ?? 18;
            ov.footer_bg_radius = this._get('rop-footer-bg-radius');
                const fPadH = this._get('rop-footer-bg-pad-h');
                const fPadTop = this._get('rop-footer-bg-pad-top');
                const fPadBot = this._get('rop-footer-bg-pad-bottom');
                ov.footer_bg_pad_h = typeof fPadH === 'number' && !isNaN(fPadH) ? fPadH : undefined;
                ov.footer_bg_pad_top = typeof fPadTop === 'number' && !isNaN(fPadTop) ? fPadTop : undefined;
                ov.footer_bg_pad_bottom = typeof fPadBot === 'number' && !isNaN(fPadBot) ? fPadBot : undefined;
                ov.auto_fit = this._get('rop-auto-fit');
                ov.auto_center_v = this._get('rop-auto-center');
                ov.layout_mode = this._get('rop-layout-mode');
                ov.debug_layout = this._get('rop-debug-layout');
                ov.debug_title = this._get('rop-debug-title');
                ov.debug_body = this._get('rop-debug-body');
                ov.debug_footer = this._get('rop-debug-footer');
                ov.offset_x = this._get('rop-offset-x');
                ov.offset_y = this._get('rop-offset-y');
                ov.title_body_gap = this._get('rop-title-body-gap');
                ov.side_by_side_gap = this._get('rop-side-by-side-gap');
                ov.side_by_side_title_ratio = this._get('rop-side-by-side-title-ratio');
                ov.body_footer_gap = this._get('rop-body-footer-gap');
                const padTop = this._get('rop-pad-top');
                const padBottom = this._get('rop-pad-bottom');
                if (padTop !== undefined) ov.padding_top = padTop;
                if (padBottom !== undefined) ov.padding_bottom = padBottom;
                ov.padding_left = this._get('rop-pad-left');
                ov.padding_right = this._get('rop-pad-right');
                ov.auto_shrink = this._get('rop-auto-shrink');
                ov.max_height = this._get('rop-max-height');
                ov.title_max_lines = this._get('rop-title-max-lines');
                ov.min_fontsize = this._get('rop-min-fontsize');
                this._syncTextcardAutoFitModeUI();
                this._syncBodyFollowTitleUI();
            }
        }

        if (ov.type === 'scroll') {
            const newScrollContent = this._get('rop-scroll-content');
            if (newScrollContent !== ov.content) ov.scroll_styled_ranges = null;
            ov.content = newScrollContent;
            // 标题
            const newScrollTitle = this._get('rop-scroll-title') || '';
            if (newScrollTitle !== ov.scroll_title) ov.scroll_title_styled_ranges = null;
            ov.scroll_title = newScrollTitle;
            ov.scroll_title_fontsize = this._get('rop-scroll-title-fontsize') || 56;
            ov.scroll_title_font_family = this._get('rop-scroll-title-font') || '';
            ov.scroll_title_font_weight = this._get('rop-scroll-title-weight') || 700;
            ov.scroll_title_bold = (ov.scroll_title_font_weight >= 600);
            ov.scroll_title_color = this._get('rop-scroll-title-color') || '';
            ov.scroll_title_gradient_direction = this.container.querySelector('#rop-scroll-title-color')?.dataset?.gradientDirection || ov.scroll_title_gradient_direction || 'horizontal';
            ov.scroll_title_uppercase = this._get('rop-scroll-title-uppercase');
            ov.scroll_title_letter_spacing = this._get('rop-scroll-title-letterspacing');
            ov.scroll_title_align = this._get('rop-scroll-title-align') || '';
            ov.scroll_title_line_spacing = this._get('rop-scroll-title-linespacing') ?? 6;
            ov.scroll_title_text_width = this._get('rop-scroll-title-textw') || ov.text_width || 900;
            ov.scroll_title_gap = this._get('rop-scroll-title-gap') ?? 20;
            ov.scroll_title_fixed = this._get('rop-scroll-title-fixed');
            ov.scroll_title_independent = this._get('rop-scroll-title-independent');
            const titleXEl = this.container.querySelector('#rop-scroll-title-x');
            const titleYEl = this.container.querySelector('#rop-scroll-title-y');
            const titleXRaw = titleXEl ? titleXEl.value : '';
            const titleYRaw = titleYEl ? titleYEl.value : '';
            ov.scroll_title_x = titleXRaw === '' ? null : (parseFloat(titleXRaw) || 0);
            ov.scroll_title_y = titleYRaw === '' ? null : (parseFloat(titleYRaw) || 0);
            ov.scroll_title_auto_fit = this._get('rop-scroll-title-auto-fit');
            ov.scroll_title_max_height = this._get('rop-scroll-title-maxh') || 0;
            ov.scroll_title_stroke_color = this._get('rop-scroll-title-stroke-color');
            ov.scroll_title_stroke_width = this._get('rop-scroll-title-stroke-width');
            ov.scroll_title_shadow_enabled = this._get('rop-scroll-title-shadow');
            ov.scroll_title_shadow_color = this._get('rop-scroll-title-shadow-color');
            ov.scroll_title_shadow_blur = this._get('rop-scroll-title-shadow-blur');
            ov.scroll_title_shadow_x = this._get('rop-scroll-title-shadow-x');
            ov.scroll_title_shadow_y = this._get('rop-scroll-title-shadow-y');
            // 标题独立背景
            ov.scroll_title_bg_enabled = this._get('rop-scroll-title-bg-enabled');
            ov.scroll_title_bg_mode = this._get('rop-scroll-title-bg-mode') || 'block';
            ov.scroll_title_bg_color = this._get('rop-scroll-title-bg-color');
            ov.scroll_title_bg_opacity = this._get('rop-scroll-title-bg-opacity') ?? 60;
            ov.scroll_title_bg_concave_radius = this._get('rop-scroll-title-bg-concave-radius') ?? 10;
            ov.scroll_title_bg_snap_threshold = this._get('rop-scroll-title-bg-snap-threshold') ?? 18;
            ov.scroll_title_bg_radius = this._get('rop-scroll-title-bg-radius') ?? 12;
            ov.scroll_title_bg_pad_h = this._get('rop-scroll-title-bg-pad-h') ?? 0;
            ov.scroll_title_bg_pad_top = this._get('rop-scroll-title-bg-pad-top') ?? 0;
            ov.scroll_title_bg_pad_bottom = this._get('rop-scroll-title-bg-pad-bottom') ?? 0;
            // 标题装饰线
            ov.scroll_title_deco_enabled = this._get('rop-scroll-title-deco-enabled');
            ov.scroll_title_deco_position = this._get('rop-scroll-title-deco-position') || 'bottom';
            ov.scroll_title_deco_style = this._get('rop-scroll-title-deco-style') || 'solid';
            ov.scroll_title_deco_align = this._get('rop-scroll-title-deco-align') || 'center';
            ov.scroll_title_deco_color = this._get('rop-scroll-title-deco-color');
            const scrollTitleDecoColEl = this.container.querySelector('#rop-scroll-title-deco-color');
            if (scrollTitleDecoColEl?.dataset?.gradientDirection) ov.scroll_title_deco_gradient_direction = scrollTitleDecoColEl.dataset.gradientDirection;
            ov.scroll_title_deco_color2 = this._get('rop-scroll-title-deco-color2');
            ov.scroll_title_deco_thickness = this._get('rop-scroll-title-deco-thickness');
            ov.scroll_title_deco_length = this._get('rop-scroll-title-deco-length');
            ov.scroll_title_deco_gap = this._get('rop-scroll-title-deco-gap');
            ov.scroll_title_deco_opacity = this._get('rop-scroll-title-deco-opacity');
            ov.scroll_title_deco_parameters = {
                ...(ov.scroll_title_deco_parameters || {}),
                decorationScale: parseFloat(this._get('rop-scroll-title-deco-scale')) || 1,
                centerGap: parseFloat(this._get('rop-scroll-title-deco-center-gap')) || 18,
                lineCap: this._get('rop-scroll-title-deco-linecap') || 'round',
                flip: !!this._get('rop-scroll-title-deco-flip')
            };
            // 正文
            ov.font_family = this._get('rop-scroll-font');
            ov.fontsize = this._get('rop-scroll-fontsize');
            ov.color = this._get('rop-scroll-color');
            ov.scroll_gradient_direction = this.container.querySelector('#rop-scroll-color')?.dataset?.gradientDirection || ov.scroll_gradient_direction || 'horizontal';
            const sw = Math.max(100, Math.min(900, parseInt(this._get('rop-scroll-weight') || (this._get('rop-scroll-bold') ? 700 : 400), 10) || 400));
            ov.font_weight = sw;
            ov.bold = sw >= 600;
            ov.scroll_uppercase = this._get('rop-scroll-uppercase');
            ov.scroll_letter_spacing = this._get('rop-scroll-letterspacing');
            ov.text_align = this._get('rop-scroll-align');
            ov.text_direction = this._get('rop-scroll-text-direction') || 'auto';
            ov.line_spacing = this._get('rop-scroll-linespacing');
            ov.text_width = this._get('rop-scroll-textw');
            ov.stroke_color = this._get('rop-scroll-stroke-color');
            ov.stroke_width = this._get('rop-scroll-stroke-width');
            ov.use_stroke = (ov.stroke_width || 0) > 0;
            ov.shadow_enabled = this._get('rop-scroll-shadow');
            ov.shadow_color = this._get('rop-scroll-shadow-color');
            ov.shadow_blur = this._get('rop-scroll-shadow-blur');
            ov.scroll_shadow_x = this._get('rop-scroll-shadow-x');
            ov.scroll_shadow_y = this._get('rop-scroll-shadow-y');
            // 正文独立背景
            ov.scroll_body_bg_enabled = this._get('rop-scroll-body-bg-enabled');
            ov.scroll_body_bg_mode = this._get('rop-scroll-body-bg-mode') || 'block';
            ov.scroll_body_bg_color = this._get('rop-scroll-body-bg-color');
            ov.scroll_body_bg_opacity = this._get('rop-scroll-body-bg-opacity') ?? 60;
            ov.scroll_body_bg_concave_radius = this._get('rop-scroll-body-bg-concave-radius') ?? 10;
            ov.scroll_body_bg_snap_threshold = this._get('rop-scroll-body-bg-snap-threshold') ?? 18;
            ov.scroll_body_bg_radius = this._get('rop-scroll-body-bg-radius') ?? 12;
            ov.scroll_body_bg_pad_h = this._get('rop-scroll-body-bg-pad-h') ?? 0;
            ov.scroll_body_bg_pad_top = this._get('rop-scroll-body-bg-pad-top') ?? 0;
            ov.scroll_body_bg_pad_bottom = this._get('rop-scroll-body-bg-pad-bottom') ?? 0;
            // 独立获取设置，解耦拖动逻辑防止双重偏移修改死循环
            ov.scroll_from_y = this._get('rop-scroll-from-y') ?? 960;
            ov.scroll_to_y = this._get('rop-scroll-to-y') ?? -200;
            ov.scroll_x_anchor = 'center';
            ov.scroll_from_x = this._get('rop-scroll-from-x') ?? 540;
            ov.scroll_to_x = ov.scroll_from_x;  // X stays the same
            // 整体偏移
            ov.scroll_offset_x = this._get('rop-scroll-offset-x') ?? 0;
            ov.scroll_offset_y = this._get('rop-scroll-offset-y') ?? 0;
            ov.scroll_speed = 1;  // 固定为1，速度由 距离÷时间 自动决定
            ov.feather_top = this._get('rop-scroll-feather-top');
            ov.feather_bottom = this._get('rop-scroll-feather-bottom');
            ov.feather_top_offset = this._get('rop-scroll-feather-top-offset');
            ov.feather_bottom_offset = this._get('rop-scroll-feather-bottom-offset');
            ov.feather_left = this._get('rop-scroll-feather-left');
            ov.feather_right = this._get('rop-scroll-feather-right');
            ov.feather_left_offset = this._get('rop-scroll-feather-left-offset');
            ov.feather_right_offset = this._get('rop-scroll-feather-right-offset');
            ov.scroll_auto_stop = this._get('rop-scroll-auto-stop');
            ov.scroll_auto_stop_lead = parseFloat(this._get('rop-scroll-auto-stop-lead')) || 0;
            ov.scroll_static = this._get('rop-scroll-static');
            ov.scroll_auto_fit = this._get('rop-scroll-auto-fit');
            ov.scroll_min_fontsize = this._get('rop-scroll-min-fontsize');
            // 卡片背景
            ov.bg_enabled = this._get('rop-scroll-bg-enabled');
            ov.bg_color = this._get('rop-scroll-bg-color');
            ov.bg_opacity = Math.round(this._get('rop-scroll-bg-opacity') / 100 * 255);
            ov.bg_radius = this._get('rop-scroll-bg-radius');
            ov.bg_padding_top = this._get('rop-scroll-bg-pad-top');
            ov.bg_padding_bottom = this._get('rop-scroll-bg-pad-bottom');
            ov.bg_padding_left = this._get('rop-scroll-bg-pad-left');
            ov.bg_padding_right = this._get('rop-scroll-bg-pad-right');
            ov.bg_fullscreen = this._get('rop-scroll-bg-fullscreen');
            // 卡片边框
            ov.bg_border_enabled = this._get('rop-scroll-bg-border-enabled');
            ov.bg_border_sides = this._get('rop-scroll-bg-border-sides') || 'all';
            ov.bg_border_color = this._get('rop-scroll-bg-border-color');
            ov.bg_border_width = this._get('rop-scroll-bg-border-width');
            ov.bg_border_style = this._get('rop-scroll-bg-border-style');
            ov.bg_border_opacity = this._get('rop-scroll-bg-border-opacity');
            // 磨砂模糊
            ov.bg_blur_enabled = this._get('rop-scroll-bg-blur-enabled');
            ov.bg_blur_amount = this._get('rop-scroll-bg-blur-amount');
        }

        ov.anim_in_type = this._get('rop-anim-in');
        ov.anim_out_type = this._get('rop-anim-out');
        ov.anim_in_duration = this._get('rop-anim-in-dur');
        ov.anim_out_duration = this._get('rop-anim-out-dur');

        // Fixed text and name flags
        ov.fixed_text = this._get('rop-fixed-text');
        ov.name = this._get('rop-name') || '';

        // 规则列表在选择覆层及增删规则时更新；普通文字/样式输入无需重建它。

        if (ov.type === 'textcard') {
            const applyAllCheckbox = this.container.querySelector('#rop-card-apply-all');
            if (applyAllCheckbox && applyAllCheckbox.checked) {
                this._applyTextcardStyleToAllTasks(ov);
            }
        }

        if (ov.type === 'scroll') {
            const scrollApplyAllCb = this.container.querySelector('#rop-scroll-apply-all');
            if (scrollApplyAllCb && scrollApplyAllCb.checked) {
                this._applyScrollStyleToAllTasks(ov);
            }
        }

        if (ov.type === 'text' || ov.type === 'textcard') {
            ov.flipper_enabled = !!this._get('rop-flipper-enabled');
            ov.flipper_duration = parseFloat(this._get('rop-flipper-duration')) || 2.0;
            ov.flipper_lines = parseInt(this._get('rop-flipper-lines'), 10) || 2;
            ov.flipper_loop = !!this._get('rop-flipper-loop');
            ov.flipper_effect = this._get('rop-flipper-effect') || 'none';
            const flipperTransParsed = parseFloat(this._get('rop-flipper-transition-duration'));
            ov.flipper_transition_duration = isNaN(flipperTransParsed) ? 0.3 : flipperTransParsed;
            this._updateFlipperInfo(ov);
        }

        // Re-render canvas to reflect changes, coalesced to avoid intermediate frames while applying panel values.
        // Commit the batch patch before the next input/change event can replace
        // its baseline. The render callback may run much later than the edit.
        window.ReelsOverviewBatch?.modelChanged(this,ov);
        this._decorEditor?.refresh();
        this._ctaEditor?.refresh();
        this._requestRender();
        if (typeof this.videoCanvas?.onOverlayChange === 'function') {
            if (this._overlayChangeRaf) cancelAnimationFrame(this._overlayChangeRaf);
            this._overlayChangeRaf = requestAnimationFrame(() => {
                this._overlayChangeRaf = null;
                if (typeof this.videoCanvas?.onOverlayChange === 'function') {
                    this.videoCanvas.onOverlayChange(ov, { source: this });
                }
            });
        }
    }

    _applyTextcardStyleToAllTasks(ov) {
        if (!ov || ov.type !== 'textcard') return;
        const scopedTasks = this._getStyleApplyScopeTasks();
        if (!Array.isArray(scopedTasks)) return;
        const matchesSameCard = this._makeTextcardApplyMatcher(ov);
        if (!matchesSameCard) return;
        const sourceTask = this._getTextcardSourceTask(ov, scopedTasks);
        
        // Ensure we do not trigger an infinite loop by setting a flag
        if (this._isApplyingAllTextcards) return;
        this._isApplyingAllTextcards = true;
        
        try {
            const styleObj = this._extractCardStyle(ov);
            // explicitly include transforms for "apply to all" logic
            styleObj.x = ov.x;
            styleObj.y = ov.y;
            styleObj.w = ov.w;
            styleObj.h = ov.h;
            styleObj.rotation = ov.rotation;
            styleObj.opacity = ov.opacity;
            styleObj.scale = ov.scale;

            scopedTasks.forEach(task => {
                // 当前任务中的源卡片已经由用户直接修改；绝不能因为它有
                // 同 slotKey 的副本/代理对象而再覆盖该任务的其他卡片。
                if (task === sourceTask) return;
                if (task && Array.isArray(task.overlays)) {
                    task.overlays.forEach(otherOv => {
                        if (otherOv && otherOv !== ov && matchesSameCard(otherOv, task)) {
                            // Deep copy to prevent shared array/object references (like styled_ranges)
                            const styleCopy = JSON.parse(JSON.stringify(styleObj));
                            Object.assign(otherOv, styleCopy);
                        }
                    });
                }
            });
        } finally {
            this._isApplyingAllTextcards = false;
        }
    }

    _applyTitleStyleToAllTasks(ov) {
        if (!ov || ov.type !== 'textcard') return;
        const scopedTasks = this._getStyleApplyScopeTasks();
        if (!Array.isArray(scopedTasks)) return;
        const matchesSameCard = this._makeTextcardApplyMatcher(ov);
        if (!matchesSameCard) return;
        const sourceTask = this._getTextcardSourceTask(ov, scopedTasks);

        if (this._isApplyingAllTitleStyles) return;
        this._isApplyingAllTitleStyles = true;

        try {
            const titleKeys = [
                'title_font_family', 'title_font_weight', 'title_bold', 'title_italic',
                'title_color', 'title_gradient_direction', 'title_uppercase',
                'title_line_spacing', 'title_letter_spacing', 'title_rotation',
                'title_bg_enabled', 'title_bg_mode', 'title_bg_color', 'title_bg_opacity',
                'title_bg_radius', 'title_bg_concave_radius', 'title_bg_snap_threshold', 'title_bg_pad_h', 'title_bg_pad_top', 'title_bg_pad_bottom', 'title_bg_border_enabled', 'title_bg_border_color', 'title_bg_border_width', 'title_bg_border_style', 'title_bg_border_opacity',
                'title_bg_brush', 'title_bg_brush_style', 'title_bg_brush_colormode', 'title_bg_brush_colormode_v2', 'title_bg_brush_fit', 'title_bg_brush_zoom', 'title_shadow_color', 'title_shadow_blur',
                'text_stroke_color', 'text_stroke_width',
                'title_deco_enabled', 'title_deco_position', 'title_deco_style', 'title_deco_align',
                'title_deco_color', 'title_deco_color2', 'title_deco_gradient_direction', 'title_deco_thickness', 'title_deco_length',
                'title_deco_gap', 'title_deco_opacity', 'title_deco_parameters'
            ];

            scopedTasks.forEach(task => {
                if (task === sourceTask) return;
                if (task && Array.isArray(task.overlays)) {
                    task.overlays.forEach(otherOv => {
                        if (otherOv && otherOv !== ov && matchesSameCard(otherOv, task)) {
                            titleKeys.forEach(k => {
                                if (ov[k] !== undefined) {
                                    otherOv[k] = ov[k];
                                }
                            });
                        }
                    });
                }
            });
        } finally {
            this._isApplyingAllTitleStyles = false;
        }
    }

    /**
     * “应用到当前任务组”的文字卡片必须匹配同一个业务层位，而不是把
     * 当前任务组的全部 textcard 一并覆盖。旧项目没有 slotKey 时，保留
     * 第 N 个未分类文字卡片的兼容规则，且绝不匹配已分类的新层。
     */
    _makeTextcardApplyMatcher(sourceOv) {
        const slotKey = String(sourceOv?.slotKey || '').trim();
        if (slotKey) {
            return candidate => candidate?.type === 'textcard' && candidate.slotKey === slotKey;
        }

        const selectedTask = window._reelsState?.tasks?.[window._reelsState?.selectedIdx];
        const sourceId = sourceOv?.id;
        const legacyCards = (selectedTask?.overlays || [])
            .filter(item => item?.type === 'textcard' && !item.slotKey);
        const legacyIndex = legacyCards.findIndex(item => item === sourceOv || (sourceId && item.id === sourceId));
        if (legacyIndex < 0) return null;
        return (candidate, task) => {
            if (candidate?.type !== 'textcard' || candidate.slotKey) return false;
            const targetCards = (task?.overlays || [])
                .filter(item => item?.type === 'textcard' && !item.slotKey);
            return targetCards[legacyIndex] === candidate;
        };
    }

    _getTextcardSourceTask(sourceOv, tasks) {
        const sourceId = sourceOv?.id;
        const sourceTask = (tasks || []).find(task => (task?.overlays || []).some(item =>
            item === sourceOv || (sourceId && item?.id === sourceId)
        ));
        return sourceTask || window._reelsState?.tasks?.[window._reelsState?.selectedIdx] || null;
    }

    _extractScrollStyle(ov) {
        // Extract scroll overlay style properties (excludes text content)
        const keys = [
            'name', 'fixed_text', 'synthetic_bold_enabled',
            'x', 'y', 'w', 'h', 'rotation', 'opacity',
            // 标题样式
            'scroll_title_fontsize', 'scroll_title_font_family', 'scroll_title_font_weight',
            'scroll_title_bold', 'scroll_title_color', 'scroll_title_gradient_direction', 'scroll_title_uppercase',
            'scroll_title_letter_spacing', 'scroll_title_align', 'scroll_title_line_spacing',
            'scroll_title_text_width', 'scroll_title_gap', 'scroll_title_fixed',
            'scroll_title_independent', 'scroll_title_x', 'scroll_title_y',
            'scroll_title_auto_fit', 'scroll_title_max_height',
            'scroll_title_stroke_color', 'scroll_title_stroke_width',
            'scroll_title_shadow_enabled', 'scroll_title_shadow_color', 'scroll_title_shadow_blur',
            'scroll_title_shadow_x', 'scroll_title_shadow_y',
            'scroll_title_bg_enabled', 'scroll_title_bg_mode', 'scroll_title_bg_color',
            'scroll_title_bg_opacity', 'scroll_title_bg_radius', 'scroll_title_bg_concave_radius', 'scroll_title_bg_snap_threshold',
            'scroll_title_bg_pad_h', 'scroll_title_bg_pad_top', 'scroll_title_bg_pad_bottom',
            'scroll_title_deco_enabled', 'scroll_title_deco_position', 'scroll_title_deco_style',
            'scroll_title_deco_align', 'scroll_title_deco_color', 'scroll_title_deco_color2', 'scroll_title_deco_gradient_direction',
            'scroll_title_deco_thickness', 'scroll_title_deco_length', 'scroll_title_deco_gap', 'scroll_title_deco_opacity', 'scroll_title_deco_parameters',
            'scroll_title_styled_ranges',
            // 正文样式
            'font_family', 'fontsize', 'font_weight', 'bold', 'italic',
            'color', 'gradient_direction', 'scroll_gradient_direction', 'text_align', 'text_width', 'line_spacing',
            'scroll_uppercase', 'scroll_letter_spacing',
            'use_stroke', 'stroke_color', 'stroke_width',
            'shadow_enabled', 'shadow_color', 'shadow_blur',
            'scroll_shadow_x', 'scroll_shadow_y',
            // 正文独立背景
            'scroll_body_bg_enabled', 'scroll_body_bg_mode', 'scroll_body_bg_color',
            'scroll_body_bg_opacity', 'scroll_body_bg_radius', 'scroll_body_bg_concave_radius', 'scroll_body_bg_snap_threshold',
            'scroll_body_bg_pad_h', 'scroll_body_bg_pad_top', 'scroll_body_bg_pad_bottom',
            'scroll_styled_ranges',
            // 滚动参数
            'scroll_x_anchor', 'scroll_from_x', 'scroll_from_y', 'scroll_to_x', 'scroll_to_y',
            'scroll_offset_x', 'scroll_offset_y',
            'scroll_tw_active_color', 'scroll_tw_active_highlight', 'scroll_tw_active_scale', 'scroll_tw_active_scale_enabled', 'scroll_tw_cursor_anchor_x', 'scroll_tw_cursor_anchor_y', 'scroll_tw_cursor_angle', 'scroll_tw_cursor_char', 'scroll_tw_cursor_color', 'scroll_tw_cursor_enabled', 'scroll_tw_cursor_image', 'scroll_tw_cursor_kind', 'scroll_tw_cursor_offset_x', 'scroll_tw_cursor_offset_y', 'scroll_tw_cursor_scale', 'scroll_tw_end', 'scroll_tw_hide_unread', 'scroll_tw_keep_read_color', 'scroll_tw_reveal_type', 'scroll_tw_speech_sync', 'scroll_tw_start', 'scroll_tw_unrevealed_opacity', 'scroll_typewriter_enabled', 'scroll_speed', 'scroll_auto_stop', 'scroll_auto_stop_lead', 'scroll_static', 'scroll_auto_fit', 'scroll_min_fontsize',
            // 羽化
            'feather_top', 'feather_bottom', 'feather_top_offset', 'feather_bottom_offset',
            'feather_left', 'feather_right', 'feather_left_offset', 'feather_right_offset',
            // 卡片背景
            'bg_enabled', 'bg_color', 'bg_opacity', 'bg_radius',
            'bg_padding_top', 'bg_padding_bottom', 'bg_padding_left', 'bg_padding_right', 'bg_fullscreen',
            // 卡片边框
            'bg_border_enabled', 'bg_border_sides', 'bg_border_color', 'bg_border_width', 'bg_border_style', 'bg_border_opacity',
            // 磨砂模糊
            'bg_blur_enabled', 'bg_blur_amount',
            // 动画
            'anim_in_type', 'anim_out_type', 'anim_in_duration', 'anim_out_duration',
        ];
        const result = {};
        for (const k of keys) {
            if (ov[k] !== undefined) result[k] = ov[k];
        }
        return result;
    }

    _applyScrollStyleToAllTasks(ov) {
        if (!ov || ov.type !== 'scroll') return;
        const scopedTasks = this._getStyleApplyScopeTasks();
        if (!Array.isArray(scopedTasks)) return;
        
        if (this._isApplyingAllScrolls) return;
        this._isApplyingAllScrolls = true;
        
        try {
            const styleObj = this._extractScrollStyle(ov);

            scopedTasks.forEach(task => {
                if (task && Array.isArray(task.overlays)) {
                    task.overlays.forEach(otherOv => {
                        if (otherOv && otherOv.type === 'scroll' && otherOv !== ov) {
                            const styleCopy = JSON.parse(JSON.stringify(styleObj));
                            Object.assign(otherOv, styleCopy);
                        }
                    });
                }
            });
        } finally {
            this._isApplyingAllScrolls = false;
        }
    }

    // 在大量制作的分组投影中，主队列会同时显示多个任务组。样式同步只应
    // 修改所选任务所属的那一组；普通单组队列仍保持原来的全部任务范围。
    _getStyleApplyScopeTasks() {
        if(window.ReelsOverviewBatch?.isSampling())return [];
        if(window.ReelsOverviewBatch?.isActive()){const rs=window._reelsState;return rs?.tasks?.[rs.selectedIdx]?[rs.tasks[rs.selectedIdx]]:[];}
        if (this.videoCanvas?.scopedTask) return [this.videoCanvas.scopedTask];
        const groupTasks = this.videoCanvas?.getTaskGroupTasks?.();
        return Array.isArray(groupTasks) ? groupTasks : (window._reelsState?.tasks || []);
    }

    _syncTitlePositionControlsUI(ov) {
        const isCard = ov?.type === 'textcard';
        // Keep the overall card position visible even when its mask is off.
        for (const id of ['rop-card-x', 'rop-card-y', 'rop-offset-x', 'rop-offset-y']) {
            const input = this.container.querySelector('#' + id);
            const row = input?.closest?.('.rop-slider-combo');
            if (!row) continue;
            const hide = isCard && (id === 'rop-offset-x' || id === 'rop-offset-y');
            row.style.display = hide ? 'none' : '';
            const label = row.previousElementSibling;
            if (label?.tagName === 'LABEL') label.style.display = hide ? 'none' : '';
        }
    }

    _syncTitleLayerPosition(ov) {
        if (!ov || ov.type !== 'textcard') return;
        const height = Number(ov.h) > 0 ? Number(ov.h) : Number(ov._renderedH) || 0;
        const position = this._toCenterPos(Number(ov.x) || 0, Number(ov.y) || 0, Number(ov.w) || 0, height);
        this._val('rop-card-x', position.x);
        this._val('rop-card-y', position.y);
        this._val('rop-x', position.x);
        this._val('rop-y', position.y);
    }

    _queueTitleAdaptivePreview() {
        if (!this.container.querySelector('#rop-title-adaptive-preview')) return;
        if (this._titlePreviewRaf) cancelAnimationFrame(this._titlePreviewRaf);
        this._titlePreviewRaf = requestAnimationFrame(() => {
            this._titlePreviewRaf = null;
            this._renderTitleAdaptivePreview();
        });
    }

    _renderTitleAdaptivePreview() {
        const canvas = this.container.querySelector('#rop-title-adaptive-preview');
        const result = this.container.querySelector('#rop-title-adaptive-result');
        const hint = this.container.querySelector('#rop-title-adaptive-hint');
        const ov = this._selectedOv;
        if (!canvas || !result || !hint || !ov || !window.ReelsOverlay?.drawAdaptiveTitlePreview) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        if (typeof document !== 'undefined' && document.fonts?.status === 'loading' && !this._titlePreviewFontWait) {
            this._titlePreviewFontWait = true;
            document.fonts.ready.then(() => {
                this._titlePreviewFontWait = false;
                this._queueTitleAdaptivePreview();
            });
        }
        const frame = window.ReelsOverlay.drawAdaptiveTitlePreview(ctx, ov, canvas.width, canvas.height);
        if (!frame) {
            result.textContent = ov.title_adaptive_enabled ? '请输入标题文字以查看效果。' : '开启总开关后，在这里实时预览当前标题。';
            hint.textContent = '';
            return;
        }
        const preferred = Math.min(Number(ov.title_preferred_glyph_height) || 45, Number(ov.title_max_glyph_height) || 60);
        const shrunk = frame.glyphH + 1 < preferred;
        result.textContent = `实际标题框 ${Math.round(frame.width)} × ${Math.round(frame.height)} px · ${frame.lines} 行 · 实际字形 ${frame.glyphH.toFixed(1)} px · ${shrunk ? '最大范围内已缩小字形' : '保持适中字形'}`;
        const hints = [];
        if (Number(ov.title_preferred_glyph_height) > Number(ov.title_max_glyph_height)) hints.push(`适中字形 ${ov.title_preferred_glyph_height}px 超过最大字形，实际按 ${ov.title_max_glyph_height}px 限制。`);
        if (Number(ov.title_adaptive_min_w) >= Number(ov.title_adaptive_max_w)) hints.push('最小宽度 ≥ 最大宽度，标题框宽度固定，无法随内容变窄。');
        if (Number(ov.title_adaptive_min_h) >= Number(ov.title_adaptive_max_h)) hints.push('最小高度 ≥ 最大高度，标题框高度固定。');
        const widthBoundary = ov.layout_mode === 'side_by_side' ? '并排标题栏' : '画布';
        if (frame.maxW + 1 < Number(ov.title_adaptive_max_w)) hints.push(`${widthBoundary}可用宽度为 ${Math.round(frame.maxW)}px；最大范围受${widthBoundary}宽度限制。`);
        if (frame.maxH + 1 < Number(ov.title_adaptive_max_h)) hints.push(`画布可用高度为 ${Math.round(frame.maxH)}px；最大范围受画布高度限制。`);
        hint.textContent = hints.join(' ');
    }

    _syncTitleAdaptiveUI() {
        const settings = this.container.querySelector('#rop-title-adaptive-settings');
        const enabled = this.container.querySelector('#rop-title-adaptive-enabled');
        const active = enabled?.checked === true;
        if (settings) {
            settings.style.display = 'grid';
            settings.style.opacity = active ? '1' : '0.5';
            for (const control of settings.querySelectorAll?.('input, button') || []) control.disabled = !active;
        }
        this._queueTitleAdaptivePreview();
        const manual = this.container.querySelector('#rop-title-manual-settings');
        if (manual) {
            manual.style.display = active ? 'none' : 'block';
        }
    }

    _syncTextcardMaskEnabledUI() {
        if (!this._selectedOv || (this._selectedOv.type !== 'textcard' && this._selectedOv.type !== 'solid_mask')) return;
        this._syncTitlePositionControlsUI(this._selectedOv);
        const enabled = this._get('rop-card-enabled') === true;
        const grid = this.container.querySelector('#rop-card-mask-grid');
        if (!grid) return;
        grid.style.opacity = enabled ? '' : '0.45';
        const transformIds = new Set([
            'rop-card-x',
            'rop-card-y',
            'rop-card-width',
            'rop-card-height',
        ]);
        grid.querySelectorAll('input, select, textarea, button').forEach((el) => {
            const id = el.id || '';
            const linkedId = el.dataset ? (el.dataset.link || el.dataset.target || '') : '';
            const isTransformControl = transformIds.has(id) || transformIds.has(linkedId);
            el.disabled = !enabled && !isTransformControl;
        });
    }

    _syncTextcardAutoFitModeUI() {
        if (!this._selectedOv || this._selectedOv.type !== 'textcard') return;
        const autoFit = this._get('rop-auto-fit') === true;
        const autoCenter = this._get('rop-auto-center') === true;
        const disableOffsets = autoFit || autoCenter;
        
        const toggleControl = (id, disabled) => {
            const el = this.container.querySelector('#' + id);
            if (!el) return;
            el.disabled = !!disabled;
            const row = el.closest('.rop-slider-combo') || el.closest('div');
            if (row) row.style.opacity = disabled ? '0.5' : '';
            const label = row?.previousElementSibling;
            if (label && label.tagName === 'LABEL') label.style.opacity = disabled ? '0.55' : '';
            const num = this.container.querySelector(`.rop-num-readout[data-link="${id}"]`);
            if (num) num.disabled = !!disabled;
            const resetBtn = this.container.querySelector(`.rop-reset-btn[data-target="${id}"]`);
            if (resetBtn) resetBtn.disabled = !!disabled;
        };
        // 自动适配或居中开：禁用单独X/Y
        toggleControl('rop-offset-x', disableOffsets);
        toggleControl('rop-offset-y', disableOffsets);
        toggleControl('rop-title-offset-x', false);
        toggleControl('rop-title-offset-y', false);
        toggleControl('rop-body-offset-x', disableOffsets);
        toggleControl('rop-body-offset-y', disableOffsets);
        toggleControl('rop-footer-offset-x', disableOffsets);
        toggleControl('rop-footer-offset-y', disableOffsets);
        // 边距在自动适配下也生效（由于 autoH 依赖 padT 且 contentW 依赖 padL）
        toggleControl('rop-pad-top', false);
        toggleControl('rop-pad-bottom', false);
        toggleControl('rop-pad-left', false);
        toggleControl('rop-pad-right', false);
    }

    _syncBodyFollowTitleUI() {
        if (!this._selectedOv || this._selectedOv.type !== 'textcard') return;
        const follow = this._get('rop-body-follow-title') === true;
        
        const toggleControl = (id, disabled) => {
            const el = this.container.querySelector('#' + id);
            if (!el) return;
            el.disabled = !!disabled;
            
            const row = el.closest('.rop-slider-combo') || el.closest('.rop-grid > div') || el.closest('div');
            if (row) {
                row.style.opacity = disabled ? '0.5' : '';
            }
            
            let label = el.previousElementSibling;
            if (el.closest('.rop-slider-combo')) {
                label = el.closest('.rop-slider-combo').previousElementSibling;
            }
            if (label && label.tagName === 'LABEL') {
                label.style.opacity = disabled ? '0.55' : '';
            }
            
            const num = this.container.querySelector(`.rop-num-readout[data-link="${id}"]`);
            if (num) num.disabled = !!disabled;
            const resetBtn = this.container.querySelector(`.rop-reset-btn[data-target="${id}"]`);
            if (resetBtn) resetBtn.disabled = !!disabled;
        };

        const targetIds = [
            'rop-body-font', 'rop-body-fontsize', 'rop-body-color', 'rop-body-bold', 'rop-body-weight',
            'rop-body-letterspacing', 'rop-body-linespacing',
            'rop-body-stroke-color', 'rop-body-stroke-width',
            'rop-body-shadow-color', 'rop-body-shadow-blur', 'rop-body-shadow-x', 'rop-body-shadow-y',
            'rop-body-bg-enabled', 'rop-body-bg-mode', 'rop-body-bg-concave-radius', 'rop-body-bg-snap-threshold', 'rop-body-bg-color', 'rop-body-bg-opacity',
            'rop-body-bg-radius', 'rop-body-bg-pad-h', 'rop-body-bg-pad-top', 'rop-body-bg-pad-bottom'
        ];

        targetIds.forEach(id => toggleControl(id, follow));
    }

    // ═══════════════════════════════════════════════
    // 卡片模板管理
    // ═══════════════════════════════════════════════

    _getCardTemplates() {
        try {
            return JSON.parse(localStorage.getItem('reels_card_templates') || '{}');
        } catch (e) { return {}; }
    }

    _setCardTemplates(data) {
        localStorage.setItem('reels_card_templates', JSON.stringify(data));
    }

    _refreshCardTemplateSelect() {
        if (!this.container) return;
        const select = this.container.querySelector('#rop-card-tpl-select');
        if (!select) return;
        const current = select.value;
        const templates = this._getCardTemplates();
        select.innerHTML = '<option value="">-- 选择模板 --</option>';
        for (const name of Object.keys(templates)) {
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = name;
            select.appendChild(opt);
        }
        if (current && templates[current]) select.value = current;
    }

    /**
     * 渲染自动着色规则列表 UI
     */
    _notifyAutoColorChange() {
        window.ReelsOverviewBatch?.modelChanged(this, this._selectedOv);
        this.videoCanvas?.onOverlayChange?.(this._selectedOv, { source: this });
        this.videoCanvas?.render?.();
    }

    _renderAutoColorRules() {
        if (!this.container) return;
        const container = this.container.querySelector('#rop-autocolor-rules');
        if (!container) return;
        container.innerHTML = '';
        
        const ov = this._selectedOv;
        if (!ov || !ov.auto_color_rules || ov.auto_color_rules.length === 0) {
            container.innerHTML = '<div style="color:var(--text-secondary,#888);font-size:12px;text-align:center;padding:4px;">(暂无规则)</div>';
            return;
        }

        ov.auto_color_rules.forEach((rule, idx) => {
            const ruleDiv = document.createElement('div');
            ruleDiv.style.cssText = 'border:1px solid var(--border-color,#444);border-radius:4px;padding:4px 6px;background:var(--bg-tertiary,#1e1e2d);display:flex;flex-direction:column;gap:4px;';
            
            // Header: Type + Delete
            const header = document.createElement('div');
            header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;font-size:11px;';
            
            const select = document.createElement('select');
            select.className = 'rop-select';
            select.style.cssText = 'padding:2px 4px;font-size:11px;height:auto;flex:1;';
            const types = {
                'keyword': '🏷️ 自定义关键词',
                'number': '🔢 数字',
                'english': '🔤 单词（多语言）',
                'punctuation': '❗ 标点符号',
                'quoted': '「」 引号内容',
                'emoji': '😀 Emoji'
            };
            for (const [v, n] of Object.entries(types)) {
                const opt = document.createElement('option');
                opt.value = v; opt.textContent = n;
                select.appendChild(opt);
            }
            select.value = rule.type;
            select.addEventListener('change', () => {
                rule.type = select.value;
                if (rule.type === 'number') rule.keywords = ['[+\\\\-]?\\\\d+([.,\\\\- ]\\\\d+)*'];
                else if (rule.type === 'english') rule.keywords = ["[\\p{L}\\p{M}]+(?:[’'\\-][\\p{L}\\p{M}]+)*"];
                else if (rule.type === 'punctuation') rule.keywords = ['[!?！？❤️⭐✨🔥💪…]+'];
                else if (rule.type === 'quoted') rule.keywords = ['[「」"\'\'][^「」"\'\']*[「」"\'\']'];
                else if (rule.type === 'emoji') rule.keywords = ['\\p{Emoji_Presentation}|\\p{Extended_Pictographic}'];
                else rule.keywords = []; // keyword type
                this._renderAutoColorRules();
                this._notifyAutoColorChange();
            });
            header.appendChild(select);
            
            const delBtn = document.createElement('button');
            delBtn.innerHTML = '✕';
            delBtn.style.cssText = 'background:none;border:none;color:var(--danger,#ff4444);cursor:pointer;margin-left:8px;font-size:12px;';
            delBtn.addEventListener('click', () => {
                ov.auto_color_rules.splice(idx, 1);
                this._renderAutoColorRules();
                this._notifyAutoColorChange();
            });
            header.appendChild(delBtn);
            ruleDiv.appendChild(header);

            // Keywords Input (only for 'keyword' type)
            if (rule.type === 'keyword') {
                const kwInput = document.createElement('textarea');
                kwInput.className = 'rop-textarea';
                kwInput.rows = 2;
                kwInput.style.cssText = 'padding:4px;font-size:11px;min-height:40px;max-height:150px;resize:vertical;background:var(--bg-primary,#111116);border:1px solid var(--border-color,#333);color:var(--text-primary,#eee);border-radius:4px;width:100%;box-sizing:border-box;';
                kwInput.placeholder = '一行一个词或短语；支持逗号分隔\n不要粘贴整段文案，否则整段都会被着色';
                // Display keywords joined by newlines for better visibility
                kwInput.value = (rule.keywords || []).join('\n');
                kwInput.addEventListener('input', () => {
                    // Split by newlines, English commas, or Chinese commas
                    rule.keywords = kwInput.value.split(/[\n,，]+/).map(s => s.trim()).filter(s => s);
                    this._notifyAutoColorChange();
                });
                ruleDiv.appendChild(kwInput);
                const kwHint = document.createElement('div');
                kwHint.textContent = '提示：关键词默认忽略大小写，支持波兰语、法语等变音字母；长短语会按原样整体高亮。';
                kwHint.style.cssText = 'font-size:10px;line-height:1.35;color:var(--text-secondary,#888);';
                ruleDiv.appendChild(kwHint);
            }

            // Styles
            const stylesRow = document.createElement('div');
            stylesRow.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:11px;';
            
            const colorPicker = document.createElement('input');
            colorPicker.type = 'color';
            colorPicker.className = 'rop-color';
            colorPicker.style.cssText = 'width:20px;height:20px;padding:0;';
            colorPicker.value = rule.color || '#ffffff';
            colorPicker.addEventListener('input', () => {
                rule.color = colorPicker.value;
                this._notifyAutoColorChange();
            });
            stylesRow.appendChild(document.createTextNode('颜色'));
            stylesRow.appendChild(colorPicker);
            this._enhanceColorInput(colorPicker, (value) => {
                rule.color = value || colorPicker.value;
                this._notifyAutoColorChange();
            });
            
            const boldCheck = document.createElement('input');
            boldCheck.type = 'checkbox';
            boldCheck.checked = !!rule.bold;
            boldCheck.addEventListener('change', () => {
                rule.bold = boldCheck.checked;
                this._notifyAutoColorChange();
            });
            stylesRow.appendChild(document.createTextNode('粗体'));
            stylesRow.appendChild(boldCheck);

            ruleDiv.appendChild(stylesRow);
            container.appendChild(ruleDiv);
        });
    }

    /**
     * 打开覆层 textcard/scroll 区段的富文本编辑器
     * @param {'title'|'body'|'footer'|'scroll_title'|'scroll_body'} section
     */
    _openOverlayRichTextEditor(section) {
        const ov = this._selectedOv;
        if (!ov || (ov.type !== 'textcard' && ov.type !== 'scroll')) return;
        if (typeof ReelsRichTextEditor === 'undefined') {
            console.warn('[OverlayPanel] ReelsRichTextEditor not loaded');
            return;
        }

        // 关闭已有编辑器
        if (this._ovRtEditor) {
            this._ovRtEditor.close(false);
            this._ovRtEditor = null;
        }

        let textKey, rangesKey, baseStyle, titleStr;
        if (section === 'scroll_title') {
            textKey = 'scroll_title';
            rangesKey = 'scroll_title_styled_ranges';
            baseStyle = {
                fontsize: ov.scroll_title_fontsize || 56,
                color: ov.scroll_title_color || '#ffffff',
                bold: ov.scroll_title_bold || false,
            };
            titleStr = '滚动标题';
        } else if (section === 'scroll_body') {
            textKey = 'content';
            rangesKey = 'scroll_styled_ranges';
            baseStyle = {
                fontsize: ov.fontsize || 40,
                color: ov.color || '#ffffff',
                bold: ov.bold || false,
            };
            titleStr = '滚动正文';
        } else {
            textKey = `${section}_text`;
            rangesKey = `${section}_styled_ranges`;
            baseStyle = {
                fontsize: ov[`${section}_fontsize`] || 60,
                color: ov[`${section}_color`] || '#000000',
                bold: ov[`${section}_bold`] || false,
            };
            const sectionLabels = { title: '标题', body: '正文', footer: '结尾' };
            titleStr = sectionLabels[section] || section;
        }

        const batchBefore = JSON.parse(JSON.stringify(ov, (key, value) => ['_img', '_allOverlays'].includes(key) ? undefined : value));
        const text = ov[textKey] || '';
        const ranges = ov[rangesKey] || [];

        // 弹出位置：在按钮旁边
        const btn = this.container.querySelector(`.rop-richtext-btn[data-section="${section}"]`);
        const btnRect = btn ? btn.getBoundingClientRect() : { x: 300, y: 300, w: 80, h: 28 };

        const rtEditor = new ReelsRichTextEditor();
        this._ovRtEditor = rtEditor;

        rtEditor.onSave = (newText, newRanges) => {
            ov[textKey] = newText;
            ov[rangesKey] = (newRanges && newRanges.length > 0) ? newRanges : null;
            // 同步面板文本框
            let inputId = `rop-${section}-text`;
            if (section === 'scroll_title') inputId = 'rop-scroll-title';
            if (section === 'scroll_body') inputId = 'rop-scroll-content';
            this._val(inputId, newText);
            window.ReelsOverviewBatch?.fieldsChanged(this, ov, batchBefore, [textKey, rangesKey]);
            this.videoCanvas?.onOverlayChange?.(ov, { source: this });
            // 刷新预览
            if (this.videoCanvas) this.videoCanvas.render();
            this._ovRtEditor = null;
        };

        rtEditor.onChange = (newText, newRanges) => {
            ov[textKey] = newText;
            ov[rangesKey] = (newRanges && newRanges.length > 0) ? newRanges : null;
            if (this.videoCanvas) this.videoCanvas.render();
        };

        rtEditor.onCancel = () => {
            this._ovRtEditor = null;
        };

        rtEditor.open({
            title: `✎ 编辑${titleStr}富文本`,
            text,
            styled_ranges: ranges,
            baseStyle,
            rect: { x: btnRect.x, y: btnRect.y, w: btnRect.width || 80, h: btnRect.height || 28 },
        });
    }

    _extractCardStyle(ov) {
        // Extract only card-related style from overlay (not position/text content)
        const keys = [
            'name', 'fixed_text', 'synthetic_bold_enabled',
            'w', 'h',
            'card_enabled', 'card_color', 'card_opacity',
            'card_border_enabled', 'card_border_color', 'card_border_width', 'card_border_style', 'card_border_opacity',
            'card_blur_enabled', 'card_blur_amount',
            'radius_tl', 'radius_tr', 'radius_bl', 'radius_br',
            // 标题样式
            'title_font_family', 'title_fontsize', 'title_font_weight', 'title_bold', 'title_italic',
            'title_color', 'title_gradient_direction', 'title_align', 'title_valign', 'title_uppercase',
            'title_line_spacing', 'title_letter_spacing',
            'title_offset_x', 'title_offset_y',
            'title_override_w', 'title_override_h', 'title_auto_shrink',
            'title_max_glyph_height',
            'title_adaptive_enabled', 'title_preferred_glyph_height', 'title_adaptive_min_w', 'title_adaptive_min_h', 'title_adaptive_max_w', 'title_adaptive_max_h', 'title_adaptive_max_lines',
            // 正文样式
            'body_font_family', 'body_fontsize', 'body_font_weight', 'body_bold', 'body_italic',
            'body_color', 'body_gradient_direction', 'body_align', 'body_valign',
            'body_line_spacing', 'body_letter_spacing',
            'body_offset_x', 'body_offset_y',
            'body_override_w', 'body_override_h', 'body_auto_shrink',
            // 结尾样式
            'footer_font_family', 'footer_fontsize', 'footer_font_weight', 'footer_bold', 'footer_italic',
            'footer_color', 'footer_gradient_direction', 'footer_align', 'footer_valign',
            'footer_line_spacing', 'footer_letter_spacing',
            'footer_offset_x', 'footer_offset_y',
            'footer_override_w', 'footer_override_h', 'footer_auto_shrink',
            // 布局
            'auto_fit', 'auto_center_v', 'layout_mode',
            'padding_top', 'padding_bottom', 'padding_left', 'padding_right',
            'title_body_gap', 'body_footer_gap',
            'side_by_side_gap', 'side_by_side_title_ratio',
            'offset_x', 'offset_y',
            'max_height', 'auto_shrink', 'title_max_lines', 'min_fontsize', 'fullscreen_mask',
            // 独立区段背景
            'title_bg_enabled', 'title_bg_mode', 'title_bg_color', 'title_bg_opacity', 'title_bg_radius', 'title_bg_concave_radius', 'title_bg_snap_threshold', 'title_bg_pad_h', 'title_bg_pad_top', 'title_bg_pad_bottom', 'title_bg_border_enabled', 'title_bg_border_color', 'title_bg_border_width', 'title_bg_border_style', 'title_bg_border_opacity', 'title_bg_brush', 'title_bg_brush_style', 'title_bg_brush_w', 'title_bg_brush_h', 'title_bg_brush_scale_x', 'title_bg_brush_scale_y', 'title_bg_brush_solid', 'title_bg_brush_colormode', 'title_bg_brush_colormode_v2', 'title_bg_brush_fit', 'title_bg_brush_zoom', 'title_bg_brush_x', 'title_bg_brush_y', 'title_custom_brush_data',
            'title_deco_enabled', 'title_deco_position', 'title_deco_style', 'title_deco_align', 'title_deco_color', 'title_deco_color2', 'title_deco_gradient_direction', 'title_deco_thickness', 'title_deco_length', 'title_deco_gap', 'title_deco_opacity', 'title_deco_parameters',
            'body_bg_enabled', 'body_bg_mode', 'body_bg_color', 'body_bg_opacity', 'body_bg_radius', 'body_bg_concave_radius', 'body_bg_snap_threshold', 'body_bg_pad_h', 'body_bg_pad_top', 'body_bg_pad_bottom', 'body_bg_border_enabled', 'body_bg_border_color', 'body_bg_border_width', 'body_bg_border_style', 'body_bg_border_opacity', 'body_bg_brush', 'body_bg_brush_style', 'body_bg_brush_w', 'body_bg_brush_h', 'body_bg_brush_scale_x', 'body_bg_brush_scale_y', 'body_bg_brush_solid', 'body_bg_brush_colormode', 'body_bg_brush_colormode_v2', 'body_bg_brush_fit', 'body_bg_brush_zoom', 'body_bg_brush_x', 'body_bg_brush_y', 'body_custom_brush_data',
            'footer_bg_enabled', 'footer_bg_mode', 'footer_bg_color', 'footer_bg_opacity', 'footer_bg_radius', 'footer_bg_concave_radius', 'footer_bg_snap_threshold', 'footer_bg_pad_h', 'footer_bg_pad_top', 'footer_bg_pad_bottom', 'footer_bg_border_enabled', 'footer_bg_border_color', 'footer_bg_border_width', 'footer_bg_border_style', 'footer_bg_border_opacity',
            'card_brush', 'card_brush_style', 'card_brush_solid', 'card_brush_w', 'card_brush_h', 'card_brush_x', 'card_brush_y',
            // 独立效果
            'independent_effects',
            'title_stroke_color', 'title_stroke_width', 'title_shadow_color', 'title_shadow_blur', 'title_shadow_x', 'title_shadow_y',
            'body_stroke_color', 'body_stroke_width', 'body_shadow_color', 'body_shadow_blur', 'body_shadow_x', 'body_shadow_y',
            'footer_stroke_color', 'footer_stroke_width', 'footer_shadow_color', 'footer_shadow_blur', 'footer_shadow_x', 'footer_shadow_y',
            // 动画
            'anim_in_type', 'anim_out_type', 'anim_in_duration', 'anim_out_duration',
            // 富文本样式范围
            'title_styled_ranges', 'body_styled_ranges', 'footer_styled_ranges',
            // 文字翻转器
            'flipper_enabled', 'flipper_duration', 'flipper_lines', 'flipper_loop', 'flipper_effect', 'flipper_transition_duration',
        ];
        const result = {};
        for (const k of keys) {
            if (ov[k] !== undefined) result[k] = ov[k];
        }
        return result;
    }

    _showCardTemplateNameDialog(defaultName = '', suggestedCat = '', returnDetails = false) {
        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.style.cssText = [
                'position:fixed', 'inset:0', 'z-index:999999',
                'background:rgba(0,0,0,0.6)',
                'display:flex', 'align-items:center', 'justify-content:center',
            ].join(';');

            const box = document.createElement('div');
            box.style.cssText = [
                'background:var(--bg-primary,#1e1e2e)',
                'border:1px solid var(--border-color,#444)',
                'border-radius:12px',
                'padding:20px',
                'min-width:340px',
                'box-shadow:0 8px 32px rgba(0,0,0,0.5)',
            ].join(';');

            const tagsList = [
                { name: '文字卡片', icon: '🃏', tag: '【文字卡片】' },
                { name: '纯文本', icon: '📝', tag: '【纯文本】' },
                { name: '滚动字幕', icon: '📜', tag: '【滚动字幕】' },
                { name: '媒体覆层', icon: '🎬', tag: '【媒体覆层】' },
                { name: '双栏对比', icon: '⚖️', tag: '【双栏对比】' }
            ];

            const quickTagsHtml = tagsList.map(t => 
                `<button type="button" class="rop-dialog-tag-pill" data-tag="${t.tag}" style="padding:4px 8px;border-radius:5px;border:1px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.06);color:#ddd;font-size:11px;cursor:pointer;display:inline-flex;align-items:center;gap:3px;transition:all 0.15s;">${t.icon} ${t.name}</button>`
            ).join('');

            box.innerHTML = `
                <div style="font-size:15px;font-weight:600;margin-bottom:10px;color:var(--text-primary,#fff);">保存预设模板</div>
                <div style="font-size:11px;color:var(--text-secondary,#aaa);margin-bottom:6px;">快捷选择类型标签：</div>
                <div class="rop-dialog-tags" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px;">${quickTagsHtml}</div>
                <input type="text" class="rop-tpl-name-input" placeholder="请输入模板名称"
                    style="width:100%;box-sizing:border-box;padding:8px 12px;border-radius:6px;border:1px solid var(--border-color,#555);background:var(--bg-secondary,#2a2a3e);color:var(--text-primary,#fff);font-size:14px;outline:none;">
                ${returnDetails ? `<label style="display:block;margin-top:10px;font-size:12px;color:var(--text-secondary,#aaa);">自定义分组<input type="text" class="rop-tpl-group-input" value="${String(suggestedCat || '我的预设').replace(/&/g,'&amp;').replace(/\"/g,'&quot;')}" placeholder="例如：祷告 / 产品 / 媒体" style="width:100%;box-sizing:border-box;margin-top:5px;padding:7px 10px;border-radius:6px;border:1px solid var(--border-color,#555);background:var(--bg-secondary,#2a2a3e);color:var(--text-primary,#fff);font-size:13px;"></label>` : ''}
                <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:14px;">
                    <button class="rop-tpl-cancel" style="padding:6px 16px;border-radius:6px;border:1px solid var(--border-color,#555);background:transparent;color:var(--text-secondary,#aaa);cursor:pointer;font-size:13px;">取消</button>
                    <button class="rop-tpl-ok" style="padding:6px 16px;border-radius:6px;border:none;background:var(--accent-primary,#5b6abf);color:#fff;cursor:pointer;font-size:13px;">保存</button>
                </div>
            `;

            overlay.appendChild(box);
            document.body.appendChild(overlay);

            const input = box.querySelector('.rop-tpl-name-input');
            const okBtn = box.querySelector('.rop-tpl-ok');
            const cancelBtn = box.querySelector('.rop-tpl-cancel');
            const groupInput = box.querySelector('.rop-tpl-group-input');
            input.value = defaultName || '';

            const pills = box.querySelectorAll('.rop-dialog-tag-pill');
            const updateActivePill = () => {
                const val = (input.value || '').trim();
                pills.forEach(p => {
                    const tag = p.getAttribute('data-tag');
                    if (val.startsWith(tag)) {
                        p.style.background = 'rgba(91,106,191,0.35)';
                        p.style.borderColor = 'var(--accent-primary,#7b8bef)';
                        p.style.color = '#fff';
                    } else {
                        p.style.background = 'rgba(255,255,255,0.06)';
                        p.style.borderColor = 'rgba(255,255,255,0.15)';
                        p.style.color = '#ddd';
                    }
                });
            };
            updateActivePill();

            pills.forEach(pill => {
                pill.onclick = (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const tag = pill.getAttribute('data-tag');
                    let cur = (input.value || '').trim();
                    if (/^【.+?】/.test(cur)) {
                        input.value = cur.replace(/^【.+?】/, tag);
                    } else {
                        input.value = tag + cur;
                    }
                    updateActivePill();
                    input.focus();
                };
            });

            input.addEventListener('input', updateActivePill);
            input.addEventListener('mousedown', (e) => e.stopPropagation());
            input.addEventListener('click', (e) => e.stopPropagation());
            box.addEventListener('mousedown', (e) => e.stopPropagation());

            const close = (val) => {
                if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
                resolve(returnDetails && val ? { name: val, category: (groupInput?.value || '我的预设').trim() || '我的预设' } : val);
            };

            okBtn.onclick = () => close((input.value || '').trim() || null);
            cancelBtn.onclick = () => close(null);
            overlay.onclick = (e) => { if (e.target === overlay) close(null); };
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') close((input.value || '').trim() || null);
                if (e.key === 'Escape') close(null);
            });
            // 多次尝试 focus 确保 Electron 渲染完成后能获得焦点
            setTimeout(() => input.focus(), 50);
            setTimeout(() => { if (document.activeElement !== input) input.focus(); }, 150);
        });
    }

    _showLayerNameDialog(defaultName = '') {
        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.style.cssText = [
                'position:fixed', 'inset:0', 'z-index:999999',
                'background:rgba(0,0,0,0.6)',
                'display:flex', 'align-items:center', 'justify-content:center',
            ].join(';');

            const box = document.createElement('div');
            box.style.cssText = [
                'background:var(--bg-primary,#1e1e2e)',
                'border:1px solid var(--border-color,#444)',
                'border-radius:12px',
                'padding:20px',
                'min-width:320px',
                'box-shadow:0 8px 32px rgba(0,0,0,0.5)',
            ].join(';');

            box.innerHTML = `
                <div style="font-size:15px;font-weight:600;margin-bottom:12px;color:var(--text-primary,#fff);">重命名图层</div>
                <input type="text" class="rop-layer-name-input" placeholder="请输入自定义名称 (留空恢复默认)"
                    style="width:100%;box-sizing:border-box;padding:8px 12px;border-radius:6px;border:1px solid var(--border-color,#555);background:var(--bg-secondary,#2a2a3e);color:var(--text-primary,#fff);font-size:14px;outline:none;">
                <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:14px;">
                    <button class="rop-layer-cancel" style="padding:6px 16px;border-radius:6px;border:1px solid var(--border-color,#555);background:transparent;color:var(--text-secondary,#aaa);cursor:pointer;font-size:13px;">取消</button>
                    <button class="rop-layer-ok" style="padding:6px 16px;border-radius:6px;border:none;background:var(--accent-primary,#5b6abf);color:#fff;cursor:pointer;font-size:13px;">确定</button>
                </div>
            `;

            overlay.appendChild(box);
            document.body.appendChild(overlay);

            const input = box.querySelector('.rop-layer-name-input');
            const okBtn = box.querySelector('.rop-layer-ok');
            const cancelBtn = box.querySelector('.rop-layer-cancel');
            input.value = defaultName || '';

            input.addEventListener('mousedown', (e) => e.stopPropagation());
            input.addEventListener('click', (e) => e.stopPropagation());
            box.addEventListener('mousedown', (e) => e.stopPropagation());

            const close = (val) => {
                if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
                resolve(val);
            };

            okBtn.onclick = () => close((input.value || '').trim());
            cancelBtn.onclick = () => close(null);
            overlay.onclick = (e) => { if (e.target === overlay) close(null); };
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') close((input.value || '').trim());
                if (e.key === 'Escape') close(null);
            });
            setTimeout(() => input.focus(), 50);
            setTimeout(() => { if (document.activeElement !== input) input.focus(); }, 150);
        });
    }

    async _saveCardTemplate() {
        if (!this._selectedOv || this._selectedOv.type !== 'textcard') {
            alert('请先选择一个文字卡片覆层');
            return;
        }
        const select = this.container.querySelector('#rop-card-tpl-select');
        const defaultName = select ? select.value : '';
        const name = await this._showCardTemplateNameDialog(defaultName);
        if (!name) return;
        const templates = this._getCardTemplates();
        templates[name] = this._extractCardStyle(this._selectedOv);
        this._setCardTemplates(templates);
        this._refreshCardTemplateSelect();
        if (select) select.value = name;
        alert(`✅ 卡片模板 "${name}" 已保存`);
    }

    async _loadCardTemplate() {
        if (!this._selectedOv || this._selectedOv.type !== 'textcard') {
            alert('请先选择一个文字卡片覆层');
            return;
        }
        const select = this.container.querySelector('#rop-card-tpl-select');
        if (!select || !select.value) {
            alert('请先在下拉列表中选择一个模板');
            return;
        }
        const name = select.value;
        const templates = this._getCardTemplates();
        if (!templates[name]) return;

        Object.assign(this._selectedOv, templates[name]);
        this._syncFromOverlay(this._selectedOv);
        
        const applyAllCheckbox = this.container.querySelector('#rop-card-apply-all');
        if (applyAllCheckbox && applyAllCheckbox.checked) {
            this._applyTextcardStyleToAllTasks(this._selectedOv);
        }
        
        if (this.videoCanvas) this.videoCanvas.render();
    }

    async _deleteCardTemplate() {
        const select = this.container.querySelector('#rop-card-tpl-select');
        if (!select || !select.value) {
            alert('请先在下拉列表中选择要删除的模板');
            return;
        }
        const name = select.value;
        if (!confirm(`确定要删除模板 "${name}" 吗？`)) return;

        const templates = this._getCardTemplates();
        delete templates[name];
        this._setCardTemplates(templates);
        this._refreshCardTemplateSelect();
    }

    _exportCardTemplates() {
        const templates = this._getCardTemplates();
        if (Object.keys(templates).length === 0) {
            alert('您还没有保存任何自定义模板！');
            return;
        }
        const str = JSON.stringify(templates, null, 2);
        const blob = new Blob([str], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `textcard_templates_${new Date().getTime()}.json`;
        a.click();
        URL.revokeObjectURL(url);
    }

    _importCardTemplates() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,.zip';
        input.onchange = (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const localPath = window.electronAPI?.getFilePath?.(file);
            if (/\.zip$/i.test(file.name) && localPath && window.electronAPI?.importOverlayPresetPackage) {
                window.electronAPI.importOverlayPresetPackage(localPath).then(result => {
                    if (!result.ok) throw new Error(result.error || '预设包导入失败');
                    this._mergeImportedOverlayGroupPresets(result.presets, result.missing || []);
                }).catch(err => alert(`导入预设包失败：${err.message}`));
                return;
            }
            const reader = new FileReader();
            reader.onload = (e) => {
                try {
                    const data = JSON.parse(e.target.result);
                    const templates = this._getCardTemplates();
                    let addedCount = 0;
                    let overwrittenCount = 0;
                    const conflicts = [];
                    for (const name of Object.keys(data)) {
                        if (templates[name]) {
                            conflicts.push(name);
                        }
                    }
                    if (conflicts.length > 0) {
                        const ok = confirm(`导入的模板中包含以下已存在的模板：\n${conflicts.join(', ')}\n\n是否覆盖它们？(点击「取消」将跳过这些冲突的模板)`);
                        for (const [name, val] of Object.entries(data)) {
                            if (templates[name]) {
                                if (ok) {
                                    templates[name] = val;
                                    overwrittenCount++;
                                }
                            } else {
                                templates[name] = val;
                                addedCount++;
                            }
                        }
                    } else {
                        for (const [name, val] of Object.entries(data)) {
                            templates[name] = val;
                            addedCount++;
                        }
                    }
                    this._setCardTemplates(templates);
                    this._refreshCardTemplateSelect();
                    alert(`✅ 导入完成：新增了 ${addedCount} 个模板，覆盖了 ${overwrittenCount} 个模板。`);
                } catch (err) {
                    console.error('导入模板出错:', err);
                    alert('导入失败，不是有效的模板 JSON 文件。');
                }
            };
            reader.readAsText(file);
        };
        input.click();
    }

    // ═══════════════════════════════════════════════
    // 覆层组预设管理 (多层)
    // ═══════════════════════════════════════════════

    _getOverlayGroupPresets() {
        try {
            const presets = JSON.parse(localStorage.getItem('reels_overlay_group_presets') || '{}');
            let migrated = false;
            const builtInKeys = new Set(Object.keys(window.REELS_BUILTIN_OVERLAY_GROUP_PRESETS || {}));
            // 兼容旧版已写入 localStorage 的内置项；立即剔除以释放额度。
            for (const name of builtInKeys) {
                if (Object.prototype.hasOwnProperty.call(presets, name)) {
                    delete presets[name];
                    migrated = true;
                }
            }
            for (const [name, data] of Object.entries(presets)) {
                try {
                    // 强制清空旧的缩略图缓存（只清空一次），以便应用英文占位符
                    if (data && typeof data === 'object' && !Array.isArray(data)) {
                        if (data.meta && !data.meta.en_thumb_migrated_v3) {
                            delete data.thumbnail;
                            data.meta.en_thumb_migrated_v3 = true;
                            migrated = true;
                        }
                    }

                    if (Array.isArray(data)) {
                        presets[name] = this._migratePresetFormat(name, data);
                        migrated = true;
                    } else if (data && typeof data === 'object' && !data.layers && !data.meta && !data.id) {
                        // Edge case: single object instead of array
                        presets[name] = this._migratePresetFormat(name, [data]);
                        migrated = true;
                    }
                } catch (err) {
                    console.error(`[PresetMigration] Failed to migrate preset ${name}:`, err);
                    delete presets[name]; // Remove corrupted preset so it doesn't break everything else
                }
            }
            if (migrated) {
                this._setOverlayGroupPresets(presets);
                console.log('[PresetMigration] 已将旧格式的自定义预设迁移至新可视化格式');
            }
            // 内置项不写回 localStorage，避免它们挤占用户预设和媒体引用的
            // 存储额度；读取时再合并，调用方仍可像以前一样按名称使用。
            const builtIns = window.REELS_BUILTIN_OVERLAY_GROUP_PRESETS || {};
            return { ...builtIns, ...presets };
        } catch (e) {
            console.error('[PresetMigration] JSON parse error:', e);
            return {};
        }
    }

    _migratePresetFormat(name, layers) {
        if (!Array.isArray(layers)) layers = [];
        // Filter out null/undefined layers
        layers = layers.filter(l => l && typeof l === 'object');
        
        const category = this._detectPresetCategory(name, layers);
        const textcards = layers.filter(l => l.type === 'textcard');
        const scrolls = layers.filter(l => l.type === 'scroll');
        const nonFixed = textcards.filter(l => !l.fixed_text);
        const layerTypes = [category];
        
        const batchColumns = [];
        if (nonFixed.length > 0) {
            batchColumns.push('覆层标题', '覆层内容');
        }
        if (scrolls.length > 0) {
            batchColumns.push('滚动标题', '滚动内容');
        }

        return {
            id: `preset_${Date.now()}_${Math.random().toString(36).slice(2,8)}`,
            name,
            category,
            tags: [category],
            thumbnail: null,
            layers: layers,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            meta: {
                category,
                layerCount: layers.length,
                hasFixedText: textcards.some(l => l.fixed_text),
                hasScroll: scrolls.length > 0,
                hasTextcard: textcards.length > 0,
                needsBatchText: nonFixed.length > 0 || scrolls.length > 0,
                layerTypes,
                batchColumns
            }
        };
    }

    _setOverlayGroupPresets(data) {
        // _getOverlayGroupPresets 会返回“内置 + 我的预设”的合并视图，但只有
        // 我的预设需要持久化。旧版把全部内置层也写进去，导入稍大的预设包就会
        // 触发 Chromium 的 QuotaExceededError。
        const builtInKeys = new Set(Object.keys(window.REELS_BUILTIN_OVERLAY_GROUP_PRESETS || {}));
        const customPresets = Object.fromEntries(Object.entries(data || {})
            .filter(([name]) => !builtInKeys.has(name)));
        localStorage.setItem('reels_overlay_group_presets', JSON.stringify(customPresets));
    }

    _debouncedSavePresets(data) {
        if (this._savePresetsTimer) clearTimeout(this._savePresetsTimer);
        this._savePresetsTimer = setTimeout(() => {
            this._savePresetsTimer = null;
            try {
                this._setOverlayGroupPresets(data);
            } catch (err) {
                console.warn('[ReelsOverlayPanel] debounced save error:', err);
            }
        }, 800);
    }

    _notifyOverlayPresetsChanged() {
        this._refreshOverlayGroupPresetSelect();
        if (window._reelsState?.overlayPanel && window._reelsState.overlayPanel !== this) {
            try { window._reelsState.overlayPanel._refreshOverlayGroupPresetSelect(); } catch (_) {}
        }
        if (typeof _renderBatchTable === 'function') {
            // Preset changes only refresh the picker. The table's stale DOM must
            // not overwrite text just edited in the current overlay panel.
            if (typeof _skipNextApply !== 'undefined') _skipNextApply = true;
            try { _renderBatchTable(); } catch (e) { console.warn('[ReelsOverlayPanel] _renderBatchTable refresh failed:', e); }
        }
    }

    _syncOverlayGroupPresetTrigger() {
        const select = this.container?.querySelector('#rop-group-preset-select');
        const label = this.container?.querySelector('#rop-group-preset-label');
        if (!select || !label) return;
        const option = select.options[select.selectedIndex];
        const text = option?.textContent || '-- 选择预设 --';
        label.textContent = text;
        label.title = text;
    }

    _openOverlayGroupPresetSearch() {
        const select = this.container?.querySelector('#rop-group-preset-select');
        const trigger = this.container?.querySelector('#rop-group-preset-trigger');
        if (!select || !trigger) return;
        // 与批量表格“覆层预设”使用同一个搜索选择器：支持实时搜索、分组、Enter 选择。
        if (typeof window._openOverlayPresetPicker === 'function') {
            window._openOverlayPresetPicker(trigger, select.value, (name) => {
                select.value = name || '';
                this._syncOverlayGroupPresetTrigger();
            });
            return;
        }
        // 兜底：异常加载顺序下仍可通过图库选择，避免选择入口失效。
        this._showPresetGallery((name) => {
            select.value = name || '';
            this._syncOverlayGroupPresetTrigger();
        });
    }

    _refreshOverlayGroupPresetSelect() {
        const select = this.container?.querySelector('#rop-group-preset-select') || document.querySelector('#rop-group-preset-select');
        if (!select) return;
        const current = select.value;
        const presets = this._getOverlayGroupPresets();
        const oldPreviewText = this._presetGalleryPreviewText;
        const defaultPreviewTitle = "PRAY THIS NOW—AND STAND FIRM IN JESUS";
        const defaultPreviewBody = "Dear Lord, my Refuge and Defender, in the authority of Jesus' name, I reject every lie, fear, deception, and spiritual attack that tries to weaken my faith. Let the precious blood of Jesus cover my life, my home, my health, and the people I love. Expose every hidden trap and silence every voice that contradicts Your truth. Where fear has taken root, bring courage. Where confusion has entered, bring clarity. Where the past still speaks too loudly, remind me that my identity is in Christ. Put \"I love Jesus!\" and let your faith be known. If you want to study the Bible, \"Amen\".";
        const previewCopy = typeof oldPreviewText === 'object' && oldPreviewText ? oldPreviewText : {
            title: oldPreviewText || defaultPreviewTitle,
            body: oldPreviewText || defaultPreviewBody,
            footer: ''
        };
        this._presetGalleryPreviewText = previewCopy;
        const escAttr = value => String(value || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
        
        // 尝试合并代码内置的预设 (防丢失)
        if (window.REELS_BUILTIN_OVERLAY_GROUP_PRESETS) {
            for (const [k, v] of Object.entries(window.REELS_BUILTIN_OVERLAY_GROUP_PRESETS)) {
                if (!presets[k]) {
                    presets[k] = Array.isArray(v) ? this._migratePresetFormat(k, v) : v;
                }
            }
        }

        let customHtml = '';
        let builtInHtml = '';
        const builtInKeys = window.REELS_BUILTIN_OVERLAY_GROUP_PRESETS ? Object.keys(window.REELS_BUILTIN_OVERLAY_GROUP_PRESETS) : [];

        for (const name of Object.keys(presets)) {
            const data = presets[name];
            const layers = Array.isArray(data) ? data : data.layers;
            const count = Array.isArray(layers) ? layers.length : 0;
            const isBuiltin = builtInKeys.includes(name);
            const optHtml = `<option value="${name}">${name} (${count}层)</option>`;
            if (isBuiltin) builtInHtml += optHtml;
            else customHtml += optHtml;
        }

        let finalHtml = '<option value="">-- 选择预设 --</option>';
        if (builtInHtml) finalHtml += `<optgroup label="内置预设">${builtInHtml}</optgroup>`;
        if (customHtml) finalHtml += `<optgroup label="我的预设">${customHtml}</optgroup>`;
        
        select.innerHTML = finalHtml;
        if (current && presets[current]) select.value = current;
        this._syncOverlayGroupPresetTrigger();
    }

    async _updateOverlayGroupPreset() {
        const select = this.container.querySelector('#rop-group-preset-select');
        if (!select || !select.value) {
            alert('请先选择一个预设再进行更新');
            return;
        }
        const name = select.value;
        const builtInKeys = Object.keys(window.REELS_BUILTIN_OVERLAY_GROUP_PRESETS || {});
        if (builtInKeys.includes(name)) {
            alert('内置预设不能直接覆盖。请在图库中点“复制后编辑”，修改后再保存为新的“我的预设”。');
            return;
        }
        if (!confirm(`确定要使用当前画布的图层覆盖更新预设 "${name}" 吗？`)) {
            return;
        }
        await this._executeSavePreset(name, true);
    }

    async _saveOverlayGroupPreset() {
        if (!this.videoCanvas) {
            alert('没有可用的覆层管理器');
            return;
        }
        const overlays = this.videoCanvas.overlayMgr?.overlays || [];
        if (overlays.length === 0) {
            alert('当前没有覆层，请先添加覆层再保存');
            return;
        }
        const select = this.container.querySelector('#rop-group-preset-select');
        const currentName = select ? select.value : '';
        // 另存时默认追加 "_副本" 后缀，避免用户误覆盖原预设
        const sourceName = this._presetEditSourceName || '';
        let defaultName = currentName ? (currentName + '_副本') : (sourceName ? `${sourceName}_副本` : '');
        
        // 自动识别当前覆层类别并推荐标签
        const autoCat = this._detectPresetCategory(defaultName, overlays);
        const autoTag = `【${autoCat}】`;
        if (defaultName) {
            if (!defaultName.startsWith('【')) {
                defaultName = `${autoTag}${defaultName}`;
            }
        } else {
            defaultName = `${autoTag}未命名预设`;
        }

        const details = await this._showCardTemplateNameDialog(defaultName, autoCat, true);
        if (!details) return;
        const { name, category } = details;
        // 如果输入名称与已有预设重名，弹确认框
        const existingPresets = this._getOverlayGroupPresets();
        if (existingPresets[name]) {
            if (!confirm(`预设 "${name}" 已存在，确定要覆盖吗？`)) return;
        }
        await this._executeSavePreset(name, false, category);
        this._presetEditSourceName = '';
    }

    _showPresetMediaStorageDialog(mediaCount) {
        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.className = 'rop-preset-media-choice-modal';
            overlay.style.cssText = 'position:fixed;inset:0;z-index:1000000;background:rgba(0,0,0,.68);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;';
            const box = document.createElement('div');
            box.style.cssText = 'width:500px;max-width:92vw;box-sizing:border-box;padding:22px 24px;border-radius:12px;background:#181926;border:1px solid rgba(255,255,255,.14);box-shadow:0 20px 50px rgba(0,0,0,.65);color:#e2e8f0;';
            box.innerHTML = `
                <div style="font-size:16px;font-weight:700;color:#f8fafc;">保存含媒体的覆层预设</div>
                <div style="margin-top:10px;font-size:13px;line-height:1.6;color:#cbd5e1;">检测到 <b style="color:#f8fafc;">${Number(mediaCount) || 0}</b> 个图片、视频或音频文件。请选择预设如何保存这些媒体：</div>
                <div style="display:grid;gap:9px;margin-top:16px;">
                    <button data-choice="packaged" style="padding:11px 13px;border-radius:8px;border:1px solid rgba(16,185,129,.45);background:rgba(16,185,129,.10);color:#d1fae5;text-align:left;cursor:pointer;"><b style="display:block;color:#34d399;">复制媒体到预设库</b><span style="font-size:12px;color:#a7f3d0;">推荐：复制一份文件，原文件移动或删除后预设仍可用。</span></button>
                    <button data-choice="linked" style="padding:11px 13px;border-radius:8px;border:1px solid rgba(96,165,250,.38);background:rgba(59,130,246,.08);color:#dbeafe;text-align:left;cursor:pointer;"><b style="display:block;color:#93c5fd;">不复制媒体（保留原路径）</b><span style="font-size:12px;color:#bfdbfe;">不占用额外空间；原文件移动、删除或换电脑后，预设会找不到媒体。</span></button>
                </div>
                <div style="display:flex;justify-content:flex-end;margin-top:15px;"><button data-choice="cancel" style="padding:7px 14px;border-radius:6px;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.06);color:#cbd5e1;cursor:pointer;">取消保存</button></div>`;
            overlay.appendChild(box);
            document.body.appendChild(overlay);
            const finish = (choice) => {
                window.removeEventListener('keydown', onKeyDown);
                overlay.remove();
                resolve(choice === 'cancel' ? null : choice);
            };
            const onKeyDown = (event) => { if (event.key === 'Escape') finish('cancel'); };
            window.addEventListener('keydown', onKeyDown);
            box.querySelectorAll('[data-choice]').forEach(button => { button.onclick = () => finish(button.dataset.choice); });
            overlay.onclick = (event) => { if (event.target === overlay) finish('cancel'); };
        });
    }

    async _executeSavePreset(name, isUpdate = false, category = '') {
        const rawOverlays = this.videoCanvas.overlayMgr?.overlays || [];
        // 图层面板的上下移动写入的是 visualOverlayOrder；overlayMgr 的原始数组
        // 不会随之重排。保存时必须按最终合成栈取层，否则重载预设会回到创建顺序。
        // getOrderedOverlays 可能返回用于渲染的浅拷贝，因此再映射回原对象，避免
        // 把渲染期字段（例如 z_index）写进预设。
        // 旧工程中偶尔存在无 ID 的残留层。先给当前管理器里的对象补 ID，
        // 再按当前合成栈取值，不能把已经不在列表中的历史对象重新塞进预设。
        rawOverlays.forEach(overlay => {
            if (overlay && !overlay.id) {
                overlay.id = 'ov_' + Math.random().toString(36).slice(2, 9) + '_' + Date.now().toString(36);
            }
        });
        const rawById = new Map(rawOverlays.map(overlay => [String(overlay.id), overlay]));
        const composited = this.videoCanvas.getOrderedOverlays?.() || rawOverlays;
        const orderedIds = new Set();
        const overlays = composited.map(overlay => {
            const id = String(overlay?.id || '');
            if (!id || !rawById.has(id) || orderedIds.has(id)) return null;
            orderedIds.add(id);
            return rawById.get(id);
        }).filter(Boolean);
        // 有 getOrderedOverlays 时它就是面板实际显示的合成栈；不要把原始
        // 管理器中脱离当前任务的历史层追加回来。没有该接口才退回原数组。
        if (!this.videoCanvas.getOrderedOverlays) overlays.push(...rawOverlays);
        // Deep clone overlays and strip runtime-only keys; preserve text, including empty sections.
        const serialized = overlays.map(ov => {
            const clone = JSON.parse(JSON.stringify(ov, (key, val) => {
                if (key === '_allOverlays') return undefined;
                return val;
            }));
            delete clone._img;
            delete clone._imgLoaded;
            delete clone._templateName;
            // fixed_text controls whether batch operations may replace text, not whether
            // saving a preset retains it. Explicit blanks must survive the round trip.
            // 保留用户设置的入点/出点；只在旧数据缺少字段时使用全程默认值。
            const savedStart = Number(clone.start);
            const savedEnd = Number(clone.end);
            clone.start = Number.isFinite(savedStart) ? Math.max(0, savedStart) : 0;
            clone.end = Number.isFinite(savedEnd) && savedEnd >= clone.start ? savedEnd : 9999;
            return clone;
        });

        // 渲染缩略图
        let thumbnail = null;
        if (typeof PresetThumbRenderer !== 'undefined') {
            try {
                const renderer = new PresetThumbRenderer();
                thumbnail = renderer.renderThumb(serialized);
            } catch (err) {
                console.warn('Failed to generate preset thumbnail:', err);
            }
        }

        const presets = this._getOverlayGroupPresets();
        const newPreset = this._migratePresetFormat(name, serialized);
        newPreset.meta.category = category || presets[name]?.meta?.category || '我的预设';
        if (thumbnail) newPreset.thumbnail = thumbnail;
        const linkedMedia = serialized.filter(layer => ['video', 'image', 'audio'].includes(layer?.type) && typeof layer.content === 'string' && !layer.content.startsWith('data:'));
        if (linkedMedia.length && window.electronAPI?.saveOverlayPresetAssets) {
            const storageChoice = await this._showPresetMediaStorageDialog(linkedMedia.length);
            if (!storageChoice) return;
            if (storageChoice === 'packaged') {
                const result = await window.electronAPI.saveOverlayPresetAssets(newPreset);
                if (!result?.ok) { alert(`媒体保存到预设库失败：${result?.error || '未知错误'}`); return; }
                Object.assign(newPreset, result.preset);
            } else {
                newPreset.meta = { ...(newPreset.meta || {}), mediaStorage: linkedMedia.length ? 'linked' : 'none', packagedMediaCount: 0 };
            }
        }
        
        presets[name] = newPreset;
        this._setOverlayGroupPresets(presets);
        this._notifyOverlayPresetsChanged();
        const select = this.container?.querySelector('#rop-group-preset-select') || document.querySelector('#rop-group-preset-select');
        if (select) select.value = name;
        this._syncOverlayGroupPresetTrigger();
        if (isUpdate) {
            if (typeof window.showToast === 'function') {
                window.showToast(`✅ 预设 "${name}" 已更新`, 'success');
            } else {
                alert(`✅ 预设 "${name}" 已更新`);
            }
        } else {
            alert(`✅ 覆层组预设 "${name}" 已保存 (${serialized.length} 层)`);
        }
    }

    _showPresetLoadChoiceDialog(presetName, existingCount, newCount) {
        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.className = 'rop-preset-choice-modal';
            overlay.style.cssText = `
                position: fixed;
                inset: 0;
                z-index: 999999;
                background: rgba(0, 0, 0, 0.68);
                backdrop-filter: blur(4px);
                display: flex;
                align-items: center;
                justify-content: center;
                animation: ropFadeIn 0.15s ease-out;
            `;

            const box = document.createElement('div');
            box.className = 'rop-preset-choice-box';
            box.style.cssText = `
                background: #181926;
                border: 1px solid rgba(255, 255, 255, 0.14);
                border-radius: 12px;
                padding: 22px 24px;
                width: 470px;
                max-width: 92vw;
                max-height: 90vh;
                overflow-y: auto;
                box-shadow: 0 20px 50px rgba(0, 0, 0, 0.65), 0 0 0 1px rgba(255, 255, 255, 0.05);
                color: #e2e8f0;
                display: flex;
                flex-direction: column;
                gap: 16px;
                box-sizing: border-box;
            `;

            const esc = (str) => String(str || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            const safeName = esc(presetName);

            box.innerHTML = `
                <div style="display:flex;align-items:center;justify-content:space-between;">
                    <div style="display:flex;align-items:center;gap:8px;">
                        <span style="font-size:18px;">📦</span>
                        <div style="font-size:15px;font-weight:600;color:#f8fafc;">加载覆层预设</div>
                    </div>
                    <button class="rop-choice-close-btn" style="background:transparent;border:none;color:#94a3b8;font-size:16px;cursor:pointer;padding:2px 6px;border-radius:4px;line-height:1;">✕</button>
                </div>

                <div style="font-size:13px;color:#cbd5e1;line-height:1.5;">
                    即将加载预设「<b style="color:#60a5fa;">${safeName}</b>」（含 <b style="color:#f8fafc;">${newCount}</b> 个图层）。<br>
                    当前画布已有 <b style="color:#f59e0b;">${existingCount}</b> 个覆层，请选择载入方式：
                </div>

                <div style="display:flex;flex-direction:column;gap:10px;">
                    <button class="rop-choice-opt-btn" data-choice="merge" style="
                        display:flex;align-items:flex-start;gap:12px;
                        padding:12px 14px;border-radius:8px;
                        background:rgba(16,185,129,0.08);border:1px solid rgba(16,185,129,0.3);
                        color:#e2e8f0;cursor:pointer;text-align:left;
                        transition:all 0.15s ease;
                    ">
                        <span style="font-size:22px;line-height:1;margin-top:2px;">➕</span>
                        <div style="flex:1;min-width:0;">
                            <div style="display:flex;align-items:center;gap:6px;margin-bottom:3px;">
                                <span style="font-size:14px;font-weight:600;color:#34d399;">合并追加 (保留现有覆层)</span>
                                <span style="font-size:11px;background:rgba(16,185,129,0.2);color:#6ee7b7;padding:1px 6px;border-radius:4px;">推荐</span>
                            </div>
                            <div style="font-size:12px;color:#94a3b8;line-height:1.4;">
                                保留画布现有的 ${existingCount} 个图层，将该预设的 ${newCount} 个图层追加到上方（适合在文字卡片上叠加电话、水印、贴纸等）。
                            </div>
                        </div>
                    </button>

                    <button class="rop-choice-opt-btn" data-choice="replace" style="
                        display:flex;align-items:flex-start;gap:12px;
                        padding:12px 14px;border-radius:8px;
                        background:rgba(99,102,241,0.08);border:1px solid rgba(99,102,241,0.25);
                        color:#e2e8f0;cursor:pointer;text-align:left;
                        transition:all 0.15s ease;
                    ">
                        <span style="font-size:22px;line-height:1;margin-top:2px;">🔄</span>
                        <div style="flex:1;min-width:0;">
                            <div style="display:flex;align-items:center;gap:6px;margin-bottom:3px;">
                                <span style="font-size:14px;font-weight:600;color:#818cf8;">覆盖替换 (清空并套用)</span>
                            </div>
                            <div style="font-size:12px;color:#94a3b8;line-height:1.4;">
                                移除当前所有覆层，完全使用预设保存的图层、文案和样式。
                            </div>
                        </div>
                    </button>

                    <button class="rop-choice-opt-btn" data-choice="keep-text" style="display:flex;align-items:flex-start;gap:12px;padding:12px 14px;border-radius:8px;background:rgba(99,102,241,0.08);border:1px solid rgba(99,102,241,0.25);color:#e2e8f0;cursor:pointer;text-align:left;">
                        <span style="font-size:22px;line-height:1;margin-top:2px;">📝</span>
                        <div style="flex:1;min-width:0;"><div style="font-size:14px;font-weight:600;color:#a5b4fc;margin-bottom:3px;">替换样式，保留现有文案</div>
                        <div style="font-size:12px;color:#94a3b8;line-height:1.4;">将文字保留到同类型、非固定文案的预设层；无法对应的文字层会完整保留并追加。其他旧覆层会被移除。</div></div>
                    </button>
                </div>

                <div style="display:flex;justify-content:flex-end;margin-top:4px;">
                    <button class="rop-choice-cancel-btn" style="
                        padding:6px 16px;border-radius:6px;
                        background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);
                        color:#94a3b8;font-size:13px;cursor:pointer;
                        transition:all 0.15s;
                    ">取消</button>
                </div>
            `;

            overlay.appendChild(box);
            document.body.appendChild(overlay);

            const finish = (result) => {
                window.removeEventListener('keydown', onKeyDown);
                if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
                resolve(result);
            };

            const onKeyDown = (e) => {
                if (e.key === 'Escape') finish(null);
            };
            window.addEventListener('keydown', onKeyDown);

            const optButtons = box.querySelectorAll('.rop-choice-opt-btn');
            optButtons.forEach(btn => {
                const choice = btn.getAttribute('data-choice');
                btn.onmouseenter = () => {
                    if (choice === 'merge') {
                        btn.style.background = 'rgba(16,185,129,0.18)';
                        btn.style.borderColor = 'rgba(16,185,129,0.6)';
                        btn.style.transform = 'translateY(-1px)';
                    } else {
                        btn.style.background = 'rgba(99,102,241,0.18)';
                        btn.style.borderColor = 'rgba(99,102,241,0.6)';
                        btn.style.transform = 'translateY(-1px)';
                    }
                };
                btn.onmouseleave = () => {
                    if (choice === 'merge') {
                        btn.style.background = 'rgba(16,185,129,0.08)';
                        btn.style.borderColor = 'rgba(16,185,129,0.3)';
                    } else {
                        btn.style.background = 'rgba(99,102,241,0.08)';
                        btn.style.borderColor = 'rgba(99,102,241,0.25)';
                    }
                    btn.style.transform = 'none';
                };
                btn.onclick = () => finish(choice);
            });

            const cancelBtn = box.querySelector('.rop-choice-cancel-btn');
            cancelBtn.onmouseenter = () => {
                cancelBtn.style.background = 'rgba(255,255,255,0.12)';
                cancelBtn.style.color = '#f8fafc';
            };
            cancelBtn.onmouseleave = () => {
                cancelBtn.style.background = 'rgba(255,255,255,0.06)';
                cancelBtn.style.color = '#94a3b8';
            };

            box.querySelector('.rop-choice-close-btn').onclick = () => finish(null);
            cancelBtn.onclick = () => finish(null);
            overlay.onclick = (e) => {
                if (e.target === overlay) finish(null);
            };
        });
    }

    async _loadOverlayGroupPreset(specificMode = null) {
        const select = this.container.querySelector('#rop-group-preset-select');
        if (!select || !select.value) {
            alert('请先在下拉列表中选择一个预设');
            return;
        }
        const name = select.value;
        const presets = this._getOverlayGroupPresets();
        const presetData = presets[name];
        let layers = Array.isArray(presetData) ? presetData : (presetData?.layers || []);
        if (!Array.isArray(layers) || layers.length === 0) {
            alert('该预设为空或格式不正确');
            return;
        }
        if (!this.videoCanvas) return;

        const mgr = this.videoCanvas.overlayMgr;
        if (!mgr) return;
        // 选择框是异步的。无论取消、按 Esc 或点击遮罩，都明确把画布恢复为
        // 打开选择框时的状态，避免其它刷新逻辑把用户刚添加的覆层带走。
        const previousOverlays = JSON.parse(JSON.stringify(mgr.overlays, (key, value) => key === '_allOverlays' ? undefined : value));
        const restorePreviousOverlays = () => {
            mgr.overlays = previousOverlays;
            this._selectedOv = mgr.overlays[0] || null;
            this._refreshList();
            if (this._selectedOv) this._syncFromOverlay(this._selectedOv);
            this.videoCanvas?.render?.();
        };

        let loadMode = specificMode || 'replace';
        if (!specificMode && mgr.overlays.length > 0) {
            const choice = await this._showPresetLoadChoiceDialog(name, mgr.overlays.length, layers.length);
            if (!choice) { restorePreviousOverlays(); return; }
            loadMode = choice;
        }

        if (loadMode === 'keep-text') layers = _ropPresetLayersKeepingText(layers, mgr.overlays);

        if (loadMode === 'merge') {
            const newlyAdded = [];
            const idMap = {};
            for (let i = 0; i < layers.length; i++) {
                const layerData = layers[i];
                const clone = JSON.parse(JSON.stringify(layerData));
                const oldId = clone.id;
                clone.id = 'ov_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
                if (oldId) idMap[oldId] = clone.id;

                const loadedStart = Number(clone.start);
                const loadedEnd = Number(clone.end);
                clone.start = Number.isFinite(loadedStart) ? Math.max(0, loadedStart) : 0;
                clone.end = Number.isFinite(loadedEnd) && loadedEnd >= clone.start ? loadedEnd : 9999;

                mgr.overlays.push(clone);
                newlyAdded.push(clone);
            }

            const firstScrollOv = newlyAdded.find(o => o.type === 'scroll') || mgr.overlays.find(o => o.type === 'scroll');
            for (const ov of newlyAdded) {
                if (ov.bind_scroll_overlay_id) {
                    if (idMap[ov.bind_scroll_overlay_id]) {
                        ov.bind_scroll_overlay_id = idMap[ov.bind_scroll_overlay_id];
                    } else if (firstScrollOv) {
                        ov.bind_scroll_overlay_id = firstScrollOv.id;
                    }
                }
            }

            this._selectedOv = newlyAdded[0] || mgr.overlays[0] || null;
            this._refreshList();
            if (this._selectedOv) this._syncFromOverlay(this._selectedOv);
            if (this.videoCanvas) this.videoCanvas.render();
            if (typeof showToast === 'function') {
                showToast(`已成功合并追加 ${newlyAdded.length} 个覆层 (当前共 ${mgr.overlays.length} 层)`, 'success');
            }
            return;
        }

        // Clear existing
        mgr.overlays = [];

        // Deep-clone and add each layer with new IDs, preserving existing text
        const idMap = {}; // 旧ID → 新ID 映射（用于修复绑定引用）
        for (let i = 0; i < layers.length; i++) {
            const layerData = layers[i];
            const clone = JSON.parse(JSON.stringify(layerData));
            const oldId = clone.id;
            clone.id = 'ov_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
            if (oldId) idMap[oldId] = clone.id;
            // 新预设保留每层入点/出点；旧预设缺失字段时仍按全程显示。
            const loadedStart = Number(clone.start);
            const loadedEnd = Number(clone.end);
            clone.start = Number.isFinite(loadedStart) ? Math.max(0, loadedStart) : 0;
            clone.end = Number.isFinite(loadedEnd) && loadedEnd >= clone.start ? loadedEnd : 9999;
            mgr.overlays.push(clone);
        }

        // 重映射跟随滚动绑定的 ID 引用（旧预设ID → 新生成的ID），若找不到匹配目标且存在滚动层，则回退绑定到首个滚动层
        const firstScrollOv = mgr.overlays.find(o => o.type === 'scroll');
        for (const ov of mgr.overlays) {
            if (ov.bind_scroll_overlay_id) {
                if (idMap[ov.bind_scroll_overlay_id]) {
                    ov.bind_scroll_overlay_id = idMap[ov.bind_scroll_overlay_id];
                } else if (firstScrollOv) {
                    ov.bind_scroll_overlay_id = firstScrollOv.id;
                }
            }
        }

        // Refresh UI
        this._selectedOv = mgr.overlays[0] || null;
        this._refreshList();
        if (this._selectedOv) this._syncFromOverlay(this._selectedOv);
        if (this.videoCanvas) this.videoCanvas.render();

    }

    _detectPresetCategory(name, presetData) {
        const layers = Array.isArray(presetData) ? presetData : (presetData?.layers || []);
        const nameMatch = String(name || '').match(/^【(.*?)】/);
        const bracketTag = nameMatch ? nameMatch[1] : '';
        const OVERLAY_CATS = ['文字卡片', '纯文字', '图文组合', '媒体素材', '滚动字幕', '艺术笔刷', '双栏对比', '遮罩蒙版'];
        if (OVERLAY_CATS.includes(presetData?.category)) return presetData.category;
        if (OVERLAY_CATS.includes(bracketTag)) return bracketTag;

        // 1. 优先检测艺术笔刷（图层含笔刷背景/自定义笔刷，或名称/分类含画笔、水彩、笔刷）
        const hasBrush = layers.some(l => l && (
            l.title_bg_brush === true ||
            l.body_bg_brush === true ||
            l.card_brush === true ||
            l.box_brush === true ||
            l.type === 'brush' ||
            l.title_custom_brush_data ||
            l.body_custom_brush_data
        ));
        if (hasBrush || bracketTag.includes('画笔') || bracketTag.includes('水彩') || bracketTag.includes('笔刷') ||
            presetData?.category === '艺术笔刷' || presetData?.category === '画笔水彩' ||
            presetData?.meta?.category === '艺术笔刷' || presetData?.meta?.category === '画笔水彩' ||
            String(name).includes('水彩笔刷') || String(name).includes('艺术笔刷')) {
            return '艺术笔刷';
        }

        // 2. 双栏对比
        if (bracketTag.includes('双栏') || String(name).includes('双栏') || layers.some(l => l.layout_mode === 'side_by_side')) {
            return '双栏对比';
        }

        // 3. 滚动字幕（包含滚动长文）
        if (bracketTag.includes('滚动') || layers.some(l => l.type === 'scroll')) {
            return '滚动字幕';
        }

        // 4. 媒体：含文字为图文组合，纯图片/视频为媒体素材
        if (bracketTag.includes('媒体') || bracketTag.includes('图片') || layers.some(l => l.type === 'video' || l.type === 'image')) {
            return layers.some(l => l.type === 'textcard' || l.type === 'text') ? '图文组合' : '媒体素材';
        }

        // 5. 遮罩蒙版
        if (bracketTag.includes('遮罩') || bracketTag.includes('蒙版') || layers.some(l => l.type === 'solid_mask')) {
            return '遮罩蒙版';
        }

        // 6. 纯文本
        const isPureText = layers.length > 0 && layers.every(l => {
            if (l.type === 'text') return true;
            if (l.type === 'textcard') {
                const hasCard = l.card_enabled !== false && Number(l.card_opacity) > 10;
                const hasTitleBg = l.title_bg_enabled && Number(l.title_bg_opacity) > 10;
                const hasBodyBg = l.body_bg_enabled && Number(l.body_bg_opacity) > 10;
                return !hasCard && !hasTitleBg && !hasBodyBg;
            }
            return false;
        });
        if (isPureText || bracketTag.includes('纯文本')) {
            return '纯文字';
        }

        // 7. 文字卡片
        return '文字卡片';
    }

    _hasFullscreenOverlay(name, presetData) {
        const layers = Array.isArray(presetData) ? presetData : (presetData?.layers || []);
        const hasProp = layers.some(l => {
            if (!l) return false;
            if (l.fullscreen_mask === true || l.fullscreen_mask === 1 || l.fullscreen_mask === '1') return true;
            if (l.bg_fullscreen === true || l.bg_fullscreen === 1 || l.bg_fullscreen === '1') return true;
            if (l.type === 'solid_mask') return true;
            if (l.type === 'textcard' && l.card_enabled !== false && Number(l.card_opacity) > 10) {
                if (Number(l.w) >= 1000 && Number(l.h) >= 1800) return true;
            }
            if ((l.type === 'image' || l.type === 'video') && Number(l.w) >= 1000 && Number(l.h) >= 1800 && (l.opacity === undefined || Number(l.opacity) > 10)) {
                return true;
            }
            return false;
        });
        if (hasProp) return true;
        const nameStr = String(name || '');
        if (nameStr.includes('全屏蒙版') || nameStr.includes('全屏遮罩') || nameStr.includes('全屏覆层') || nameStr.includes('全屏背景') || nameStr.includes('全屏底色')) {
            return true;
        }
        return false;
    }

    _getCategoryMeta(category) {
        const MAP = {
            '纯文字': { key: 'text', icon: '', shortLabel: '纯文字' },
            '纯文本': { key: 'text', icon: '', shortLabel: '纯文字' },
            '文字卡片': { key: 'card', icon: '', shortLabel: '卡片' },
            '艺术笔刷': { key: 'brush', icon: '', shortLabel: '笔刷' },
            '画笔水彩': { key: 'brush', icon: '', shortLabel: '笔刷' },
            '滚动字幕': { key: 'scroll', icon: '', shortLabel: '滚动' },
            '图文组合': { key: 'combo', icon: '', shortLabel: '图文' },
            '媒体素材': { key: 'media', icon: '', shortLabel: '媒体' },
            '媒体覆层': { key: 'media', icon: '', shortLabel: '媒体' },
            '双栏对比': { key: 'split', icon: '', shortLabel: '双栏' },
            '遮罩蒙版': { key: 'mask', icon: '', shortLabel: '遮罩' }
        };
        return MAP[category] || { key: 'card', icon: '', shortLabel: category || '卡片' };
    }

    _showPreviewTextEditorDialog(fieldKey, currentValue) {
        return new Promise((resolve) => {
            const fieldNames = {
                title: '临时标题',
                body: '临时正文 (支持多行、长段落与排版)',
                footer: '临时结尾'
            };
            const titleText = fieldNames[fieldKey] || '编辑临时文案';

            const overlay = document.createElement('div');
            overlay.style.cssText = [
                'position:fixed', 'inset:0', 'z-index:999999',
                'background:rgba(0,0,0,0.75)',
                'display:flex', 'align-items:center', 'justify-content:center',
                'backdrop-filter:blur(3px)'
            ].join(';');

            const box = document.createElement('div');
            box.style.cssText = [
                'background:var(--bg-primary,#181828)',
                'border:1px solid #4338ca',
                'border-radius:12px',
                'padding:20px',
                'width:560px',
                'max-width:92vw',
                'box-shadow:0 16px 48px rgba(0,0,0,0.75)',
                'display:flex', 'flex-direction:column', 'gap:12px'
            ].join(';');

            box.innerHTML = `
                <div style="display:flex;justify-content:space-between;align-items:center;">
                    <div style="font-size:15px;font-weight:600;color:#fff;display:flex;align-items:center;gap:6px;">
                        <span>✏️</span> <span>编辑${titleText}</span>
                    </div>
                    <button class="rop-text-edit-close" style="background:none;border:none;color:#94a3b8;font-size:18px;cursor:pointer;line-height:1;">✕</button>
                </div>
                <div style="font-size:11px;color:#94a3b8;line-height:1.5;">
                    💡 提示：此文案仅在预设图库中用于渲染全部预设的缩略图效果，换行与段落均完整保留，不会修改预设自身保存的原始内容。
                </div>
                <textarea class="rop-text-edit-area" placeholder="请输入内容..." style="width:100%;height:240px;box-sizing:border-box;padding:12px;border-radius:8px;border:1px solid #475569;background:#0d1117;color:#f1f5f9;font-size:13px;line-height:1.6;outline:none;resize:vertical;font-family:inherit;"></textarea>
                <div style="display:flex;justify-content:space-between;align-items:center;margin-top:4px;">
                    <span style="font-size:11px;color:#64748b;">按 Ctrl+Enter / ⌘+Enter 快速保存</span>
                    <div style="display:flex;gap:10px;">
                        <button class="rop-text-edit-cancel" style="padding:6px 14px;border-radius:6px;border:1px solid #475569;background:transparent;color:#94a3b8;cursor:pointer;font-size:12px;">取消</button>
                        <button class="rop-text-edit-ok" style="padding:6px 18px;border-radius:6px;border:none;background:var(--accent-primary,#6366f1);color:#fff;cursor:pointer;font-size:12px;font-weight:600;">确定并刷新预览</button>
                    </div>
                </div>
            `;
            overlay.appendChild(box);
            document.body.appendChild(overlay);

            const textarea = box.querySelector('.rop-text-edit-area');
            const okBtn = box.querySelector('.rop-text-edit-ok');
            const cancelBtn = box.querySelector('.rop-text-edit-cancel');
            const closeXBtn = box.querySelector('.rop-text-edit-close');

            textarea.value = currentValue || '';

            const close = (val) => {
                if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
                resolve(val);
            };

            okBtn.onclick = () => close(textarea.value);
            cancelBtn.onclick = () => close(null);
            closeXBtn.onclick = () => close(null);
            overlay.onclick = (e) => { if (e.target === overlay) close(null); };

            textarea.addEventListener('keydown', (e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                    close(textarea.value);
                } else if (e.key === 'Escape') {
                    close(null);
                }
            });

            textarea.addEventListener('mousedown', (e) => e.stopPropagation());
            box.addEventListener('mousedown', (e) => e.stopPropagation());

            setTimeout(() => {
                textarea.focus();
                textarea.setSelectionRange(textarea.value.length, textarea.value.length);
            }, 60);
        });
    }

    _showPresetGallery(onSelectCallback, multiSelect = false, defaultFilter = 'all', options = {}) {
        this.multiSelectPicker = multiSelect;
        if (options && typeof options === 'object') {
            this._presetGalleryOptions = options;
        } else if (!this._presetGalleryOptions) {
            this._presetGalleryOptions = {};
        }

        if (!onSelectCallback && (!this.videoCanvas || !this.videoCanvas.overlayMgr)) {
            alert('没有可用的覆层管理器');
            return;
        }

        const presets = this._getOverlayGroupPresets();
        const oldPreviewText = this._presetGalleryPreviewText;
        const previewCopy = typeof oldPreviewText === 'object' && oldPreviewText ? oldPreviewText : {
            title: oldPreviewText || 'PRAY THIS NOW—AND STAND FIRM IN JESUS',
            body: oldPreviewText || "Dear Lord, my Refuge and Defender, in the authority of Jesus' name, I reject every lie, fear, deception, and spiritual attack that tries to weaken my faith. Let the precious blood of Jesus cover my life, my home, my health, and the people I love. Expose every hidden trap and silence every voice that contradicts Your truth. Where fear has taken root, bring courage. Where confusion has entered, bring clarity. Where the past still speaks too loudly, remind me that my identity is in Christ. Put \"I love Jesus!\" and let your faith be known. If you want to study the Bible, \"Amen\".",
            footer: ''
        };
        // 临时预览文案不保留段落空行；旧会话内已存在的值也在此统一清理。
        ['title', 'body', 'footer'].forEach(key => { previewCopy[key] = String(previewCopy[key] || '').replace(/[\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim(); });
        this._presetGalleryPreviewText = previewCopy;
        const escAttr = value => String(value || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
        let builtInKeys = [];
        if (window.REELS_BUILTIN_OVERLAY_GROUP_PRESETS) {
            builtInKeys = Object.keys(window.REELS_BUILTIN_OVERLAY_GROUP_PRESETS);
            for (const [k, v] of Object.entries(window.REELS_BUILTIN_OVERLAY_GROUP_PRESETS)) {
                if (!presets[k]) presets[k] = Array.isArray(v) ? this._migratePresetFormat(k, v) : v;
            }
        }

        // 识别哪些覆层预设已经添加进了“大量建立”的模板库中
        const existingTemplateNamesList = [
            ...(this._presetGalleryOptions?.existingNames || []),
            ...(Array.isArray(window._reelsBulkState?.templates)
                ? window._reelsBulkState.templates.map(t => t.label || t.task?.baseName || t.task?.fileName)
                : [])
        ].filter(Boolean);

        const isPresetAlreadyInBulk = (presetName) => {
            if (!presetName) return false;
            const p = String(presetName).trim();
            const cleanP = p.replace(/^\d+[\.\-_、\s]+/, '').trim();
            for (const raw of existingTemplateNamesList) {
                const s = String(raw).trim();
                if (s === p) return true;
                const cleanS = s.replace(/^\d+[\.\-_、\s]+/, '').trim();
                if (cleanS && cleanP && (cleanS === cleanP || cleanS === p || s === cleanP)) return true;
            }
            return false;
        };

        // 统计各个类型的预设数量与自定义分组
        const catStats = { '文字卡片': 0, '纯文字': 0, '图文组合': 0, '媒体素材': 0, '滚动字幕': 0, '艺术笔刷': 0, '双栏对比': 0, '遮罩蒙版': 0 };
        let libInfo = null;
        try { libInfo = window.electronAPI?.getPresetLibraryInfo?.(); } catch (_) { libInfo = null; }
        const libraryKeys = new Set(libInfo?.ok ? libInfo.overlay?.keys || [] : []);
        const libraryLabel = libInfo?.ok && libInfo.overlay?.libraryVersion ? `${libInfo.overlay.libraryVersion} · ${libInfo.overlay.libraryDate}` : '';
        const libCount = Object.keys(presets).filter(n => libraryKeys.has(n)).length;
        let fullCount = 0;
        let noFullCount = 0;
        const customGroupsMap = {};
        let customTotalCount = 0;
        let builtinTotalCount = 0;
        let alreadyAddedCount = 0;
        let notAddedCount = 0;

        for (const [name, data] of Object.entries(presets)) {
            const isBuiltin = builtInKeys.includes(name);
            if (isBuiltin) {
                builtinTotalCount++;
            } else {
                customTotalCount++;
                const g = String(data?.meta?.category || data?.category || '我的预设').trim() || '我的预设';
                customGroupsMap[g] = (customGroupsMap[g] || 0) + 1;
            }

            if (isPresetAlreadyInBulk(name)) {
                alreadyAddedCount++;
            } else {
                notAddedCount++;
            }

            const cat = this._detectPresetCategory(name, data);
            if (catStats[cat] !== undefined) catStats[cat]++;
            else catStats[cat] = (catStats[cat] || 0) + 1;
            if (this._hasFullscreenOverlay(name, data)) {
                fullCount++;
            } else {
                noFullCount++;
            }
        }

        // 收集自定义分组名称（"我的预设"放最前，其余按数量排序）
        const userDefinedGroups = Object.keys(customGroupsMap).sort((a, b) => {
            if (a === '我的预设') return -1;
            if (b === '我的预设') return 1;
            return (customGroupsMap[b] || 0) - (customGroupsMap[a] || 0);
        });

        const modal = document.createElement('div');
        modal.className = 'rop-gallery-modal';
        // 多选模式专用于“大量建立 → 覆层预设库”。选择只更新卡片，最后一次
        // 确认才回传并写入模板库，避免每个预设都触发完整重绘。
        const selectedPresetNames = new Set();
        modal.innerHTML = `
            <div class="rop-gallery-content">
                <div class="rop-gallery-header">
                    <!-- 第一行：顶部工具条 (Title, Preview Settings, Actions, Close) -->
                    <div class="rop-gallery-top-bar">
                        <div class="rop-gallery-title-area">
                            <h3 class="rop-gallery-main-title">覆层预设可视化图库</h3>
                            <span class="rop-gallery-total-badge">${Object.keys(presets).length} 套预设</span>
                        </div>

                        <div class="rop-gallery-tools-area">
                            <!-- 临时预览背景 -->
                            <div class="rop-gallery-tool-group">
                                <span class="rop-tool-group-label">临时背景</span>
                                <button class="rop-gallery-preview-bg" title="更换缩略图临时渲染背景">选择背景</button>
                                <span class="rop-gallery-preview-bg-label" title="${escAttr(this._presetGalleryPreviewBackground || '未设置')}">${this._presetGalleryPreviewBackground ? String(this._presetGalleryPreviewBackground).split(/[\\/]/).pop() : '默认深色'}</span>
                                <button class="rop-gallery-preview-bg-clear" title="清除临时背景，恢复默认" style="${this._presetGalleryPreviewBackground ? '' : 'display:none;'}">清除</button>
                            </div>

                            <div class="rop-tool-divider"></div>

                            <!-- 临时预览文案 -->
                            <div class="rop-gallery-preview-copy">
                                <span class="rop-tool-group-label">预览文案</span>
                                <div class="rop-preview-input-wrap">
                                    <span class="rop-input-tag">标题</span>
                                    <input data-preview-copy="title" value="${escAttr(previewCopy.title)}" placeholder="标题文案" title="双击打开大窗编辑">
                                    <button type="button" class="rop-preview-copy-btn" data-field="title" title="点击打开多行大窗编辑">✏️</button>
                                </div>
                                <div class="rop-preview-input-wrap">
                                    <span class="rop-input-tag">正文</span>
                                    <input data-preview-copy="body" value="${escAttr(previewCopy.body)}" placeholder="正文文案" title="双击打开大窗编辑">
                                    <button type="button" class="rop-preview-copy-btn" data-field="body" title="点击打开多行大窗编辑">✏️</button>
                                </div>
                                <div class="rop-preview-input-wrap">
                                    <span class="rop-input-tag">结尾</span>
                                    <input data-preview-copy="footer" value="${escAttr(previewCopy.footer)}" placeholder="结尾文案" title="双击打开大窗编辑">
                                    <button type="button" class="rop-preview-copy-btn" data-field="footer" title="点击打开多行大窗编辑">✏️</button>
                                </div>
                            </div>
                        </div>

                        <div class="rop-gallery-actions-area">
                            <label title="调整预设卡片大小" style="display:flex;align-items:center;gap:4px;font-size:11px;color:#94a3b8;">卡片<input type="range" class="rop-gallery-card-size" min="140" max="480" step="10" style="width:90px;"></label>
                            <input type="search" class="rop-gallery-search" placeholder="🔍 搜索覆层预设…" title="按预设名称、分组或类型搜索"
                                style="width:150px;height:28px;box-sizing:border-box;padding:3px 8px;background:#10131d;border:1px solid #3b4258;border-radius:5px;color:#e2e8f0;font-size:11px;outline:none;">
                            ${multiSelect ? '<button class="rop-gallery-add-selected is-empty" title="将勾选的覆层预设一次加入大量建立的模板库">添加所选（0）</button>' : ''}
                            <button class="rop-gallery-clear-custom" title="仅删除自己导入或保存的预设，不影响内置预设">清空我的预设</button>
                            <button class="rop-gallery-close" title="关闭预设库 (Esc)">✕</button>
                        </div>
                    </div>

                    <!-- 第二行：全宽分类与特性筛选导航条 -->
                    <div class="rop-gallery-nav-bar">
                        <div class="rop-gallery-tabs">
                            <!-- 范围主分类：全部 / 内置预设 / 我的预设 -->
                            <div class="rop-tab-group rop-scope-group">
                                <button class="rop-gallery-tab active" data-filter="all">全部 <span class="rop-tab-num">${Object.keys(presets).length}</span></button>
                                <button class="rop-gallery-tab" data-filter="src-mine" title="自己保存或导入的预设">⭐ 我的预设 <span class="rop-tab-num">${customTotalCount - libCount}</span></button>
                                <button class="rop-gallery-tab" data-filter="src-library" title="个人预设库 ${libraryLabel}">📚 预设库 <span class="rop-tab-num">${libCount}</span></button>
                                <button class="rop-gallery-tab rop-gallery-tab-builtin" data-filter="builtin">内置 <span class="rop-tab-num">${builtinTotalCount}</span></button>
                            </div>

                            ${multiSelect ? `
                                <div class="rop-nav-divider"></div>
                                <div class="rop-tab-group">
                                    <button class="rop-gallery-tab rop-gallery-tab-unadded" data-filter="not-added" title="仅查看尚未添加到当前大量建立模板库的预设">未添加 <span class="rop-tab-num">${notAddedCount}</span></button>
                                    <button class="rop-gallery-tab rop-gallery-tab-added" data-filter="already-added" title="仅查看已经存在于当前大量建立模板库中的预设">✅ 已在模板库 <span class="rop-tab-num">${alreadyAddedCount}</span></button>
                                </div>
                            ` : ''}

                            <div class="rop-nav-divider"></div>

                            <!-- 类型分类 -->
                            <div class="rop-tab-group">
                                <button class="rop-gallery-tab" data-filter="cat-card">文字卡片 <span class="rop-tab-num">${catStats['文字卡片'] || 0}</span></button>
                                <button class="rop-gallery-tab" data-filter="cat-text">纯文字 <span class="rop-tab-num">${(catStats['纯文字'] || 0) + (catStats['纯文本'] || 0)}</span></button>
                                <button class="rop-gallery-tab" data-filter="cat-combo">图文组合 <span class="rop-tab-num">${catStats['图文组合'] || 0}</span></button>
                                <button class="rop-gallery-tab" data-filter="cat-media">媒体素材 <span class="rop-tab-num">${(catStats['媒体素材'] || 0) + (catStats['媒体覆层'] || 0)}</span></button>
                                <button class="rop-gallery-tab" data-filter="cat-scroll">滚动字幕 <span class="rop-tab-num">${catStats['滚动字幕'] || 0}</span></button>
                                <button class="rop-gallery-tab" data-filter="cat-brush">艺术笔刷 <span class="rop-tab-num">${catStats['艺术笔刷'] || 0}</span></button>
                                <button class="rop-gallery-tab" data-filter="cat-split">双栏对比 <span class="rop-tab-num">${catStats['双栏对比'] || 0}</span></button>
                                ${(catStats['遮罩蒙版'] || 0) > 0 ? `<button class="rop-gallery-tab" data-filter="cat-mask">遮罩蒙版 <span class="rop-tab-num">${catStats['遮罩蒙版']}</span></button>` : ''}
                            </div>

                            <div class="rop-nav-divider"></div>

                            <!-- 特性筛选 -->
                            <div class="rop-tab-group">
                                <button class="rop-gallery-tab" data-filter="fullscreen-yes">有全屏覆层 <span class="rop-tab-num">${fullCount}</span></button>
                                <button class="rop-gallery-tab" data-filter="fullscreen-no">无全屏覆层 <span class="rop-tab-num">${noFullCount}</span></button>
                            </div>

                            ${userDefinedGroups.filter(g => g !== '我的预设').length > 0 ? `
                                <div class="rop-nav-divider"></div>
                                <!-- 我的自定义文件夹分组 -->
                                <div class="rop-tab-group rop-source-groups">
                                    ${userDefinedGroups.filter(g => g !== '我的预设').map(g => `
                                        <button class="rop-gallery-tab rop-gallery-tab-group" data-filter="group-${escAttr(g)}" title="自定义分组：${escAttr(g)}">📁 ${escAttr(g)} <span class="rop-tab-num">${customGroupsMap[g]}</span></button>
                                    `).join('')}
                                </div>
                            ` : ''}
                        </div>
                    </div>
                </div>
                <div class="rop-gallery-main">
                    <div class="rop-gallery-sidebar">
                        <div class="rop-sidebar-group-header">
                            <select class="rop-sidebar-group-select" id="rop-sidebar-group-select" title="按分组筛选左侧列表与右侧预设">
                                <option value="all">全部分组 (${Object.keys(presets).length})</option>
                                <option value="builtin">内置预设 (${builtinTotalCount})</option>
                                <option value="custom">全部我的预设 (${customTotalCount})</option>
                                ${userDefinedGroups.map(g => `<option value="group-${escAttr(g)}">📁 ${escAttr(g)} (${customGroupsMap[g]}套)</option>`).join('')}
                            </select>
                        </div>
                        <div class="rop-gallery-sidebar-list" id="rop-gallery-sidebar-list"></div>
                    </div>
                    <div class="rop-gallery-resizer" id="rop-gallery-resizer" title="按住左右拖动调整列表宽度，双击恢复默认"></div>
                    <div class="rop-gallery-body">
                        <div class="rop-gallery-grid" id="rop-gallery-grid"></div>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        const closeBtn = modal.querySelector('.rop-gallery-close');
        const closeGalleryModal = (e) => {
            if (e) {
                e.preventDefault();
                e.stopPropagation();
            }
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            if (modal.parentNode) modal.parentNode.removeChild(modal);
            document.removeEventListener('keydown', onGalleryEscKey);
        };
        const onGalleryEscKey = (e) => {
            if (e.key === 'Escape') {
                closeGalleryModal(e);
            }
        };
        closeBtn.onclick = closeGalleryModal;
        document.addEventListener('keydown', onGalleryEscKey);

        // 遮罩点击关闭与内容区防冒泡
        modal.onclick = (e) => {
            if (e.target === modal) closeGalleryModal(e);
        };
        const galleryContent = modal.querySelector('.rop-gallery-content');
        if (galleryContent) {
            galleryContent.onclick = (e) => {
                e.stopPropagation();
            };
        }

        modal.querySelector('.rop-gallery-preview-bg').onclick = async (e) => {
            e.stopPropagation();
            const paths = await window.electronAPI?.selectFiles?.({ title:'选择用于全部预设缩略图的临时背景', filters:[{name:'图片或视频',extensions:['mp4','mov','mkv','avi','webm','jpg','jpeg','png','webp','gif']}] });
            if (!paths?.[0]) return;
            this._presetGalleryPreviewBackground = paths[0];
            document.removeEventListener('keydown', onGalleryEscKey);
            this._showPresetGallery(onSelectCallback, multiSelect);
            if (modal.parentNode) modal.parentNode.removeChild(modal);
        };
        modal.querySelector('.rop-gallery-preview-bg-clear').onclick = (e) => {
            e.stopPropagation();
            delete this._presetGalleryPreviewBackground;
            document.removeEventListener('keydown', onGalleryEscKey);
            this._showPresetGallery(onSelectCallback, multiSelect);
            if (modal.parentNode) modal.parentNode.removeChild(modal);
        };
        
        const openTextEdit = async (fieldKey, curVal) => {
            const newVal = await this._showPreviewTextEditorDialog(fieldKey, curVal);
            if (newVal !== null && newVal !== undefined) {
                if (!this._presetGalleryPreviewText || typeof this._presetGalleryPreviewText !== 'object') {
                    this._presetGalleryPreviewText = {};
                }
                this._presetGalleryPreviewText[fieldKey] = newVal;
                document.removeEventListener('keydown', onGalleryEscKey);
                this._showPresetGallery(onSelectCallback, multiSelect);
                if (modal.parentNode) modal.parentNode.removeChild(modal);
            }
        };

        modal.querySelectorAll('.rop-preview-copy-btn').forEach(btn => {
            btn.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                const fieldKey = btn.dataset.field;
                const input = modal.querySelector(`input[data-preview-copy="${fieldKey}"]`);
                const curVal = (this._presetGalleryPreviewText && typeof this._presetGalleryPreviewText === 'object' && this._presetGalleryPreviewText[fieldKey] !== undefined)
                    ? this._presetGalleryPreviewText[fieldKey]
                    : (input ? input.value : '');
                openTextEdit(fieldKey, curVal);
            };
        });

        modal.querySelectorAll('[data-preview-copy]').forEach(input => {
            input.onchange = () => {
                this._presetGalleryPreviewText = Object.fromEntries([...modal.querySelectorAll('[data-preview-copy]')].map(el => [el.dataset.previewCopy, el.value.trim()]));
                document.removeEventListener('keydown', onGalleryEscKey);
                this._showPresetGallery(onSelectCallback, multiSelect);
                if (modal.parentNode) modal.parentNode.removeChild(modal);
            };
            input.onkeydown = event => { if (event.key === 'Enter') event.target.blur(); };

            input.ondblclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                const fieldKey = input.dataset.previewCopy;
                const curVal = (this._presetGalleryPreviewText && typeof this._presetGalleryPreviewText === 'object' && this._presetGalleryPreviewText[fieldKey] !== undefined)
                    ? this._presetGalleryPreviewText[fieldKey]
                    : input.value;
                openTextEdit(fieldKey, curVal);
            };

            if (input.parentElement) {
                input.parentElement.ondblclick = (e) => {
                    if (e.target !== input) {
                        e.preventDefault();
                        e.stopPropagation();
                        const fieldKey = input.dataset.previewCopy;
                        const curVal = (this._presetGalleryPreviewText && typeof this._presetGalleryPreviewText === 'object' && this._presetGalleryPreviewText[fieldKey] !== undefined)
                            ? this._presetGalleryPreviewText[fieldKey]
                            : input.value;
                        openTextEdit(fieldKey, curVal);
                    }
                };
            }
        });
        modal.querySelector('.rop-gallery-clear-custom').onclick = (e) => {
            e.stopPropagation();
            // 必须以 localStorage 原始值为准：图库内存对象已混入内置预设，
            // 在它上面删除再回写会留下旧缓存或初始化时重写的自定义项。
            let storedPresets = {};
            try { storedPresets = JSON.parse(localStorage.getItem('reels_overlay_group_presets') || '{}'); } catch (_) {}
            const customNames = Object.keys(storedPresets).filter(key => !builtInKeys.includes(key));
            if (!customNames.length) return alert('没有可清空的“我的预设”');
            if (!confirm(`确定清空 ${customNames.length} 个自己导入或保存的预设吗？\n\n内置预设不会删除。此操作不可撤销。`)) return;
            const builtinOnly = Object.fromEntries(Object.entries(storedPresets).filter(([key]) => builtInKeys.includes(key)));
            this._setOverlayGroupPresets(builtinOnly);
            this._notifyOverlayPresetsChanged();
            this._showPresetGallery(onSelectCallback, multiSelect);
            document.body.removeChild(modal);
            if (typeof showToast === 'function') showToast(`已清空 ${customNames.length} 个我的预设`, 'success');
        };

        const tabs = modal.querySelectorAll('.rop-gallery-tab');
        const sidebarGroupSelect = modal.querySelector('#rop-sidebar-group-select');
        const cardSizeInput = modal.querySelector('.rop-gallery-card-size');
        const galleryGrid = modal.querySelector('#rop-gallery-grid');
        if (cardSizeInput && galleryGrid) {
            const applyCardSize = (w) => {
                galleryGrid.style.gridTemplateColumns = `repeat(auto-fill, minmax(${w}px, 1fr))`;
                galleryGrid.style.gap = w < 200 ? '10px' : '';
            };
            let savedW = 0;
            try { savedW = Number(localStorage.getItem('rop_gallery_card_width')) || 0; } catch (_) {}
            cardSizeInput.value = savedW || 250;
            if (savedW) applyCardSize(savedW);
            cardSizeInput.addEventListener('input', () => {
                applyCardSize(Number(cardSizeInput.value));
                try { localStorage.setItem('rop_gallery_card_width', cardSizeInput.value); } catch (_) {}
            });
        }
        const presetSearch = modal.querySelector('.rop-gallery-search');
        let activeFilter = 'all';
        // 两层筛选：大类（全部/内置/预设库/我的预设）× 小类（分类/特性/分组）。
        const SCOPES = ['all', 'builtin', 'src-library', 'src-mine', 'custom'];
        let activeScope = 'all';
        let activeSub = null;

        const applyFilter = (filter) => {
            filter = filter || 'all';
            if (SCOPES.includes(filter)) activeScope = filter;
            else activeSub = activeSub === filter ? null : filter;
            activeFilter = activeSub || activeScope;
            // 同步 Tabs 激活态
            tabs.forEach(btn => {
                const f = btn.getAttribute('data-filter');
                if (f === activeScope || f === activeSub) btn.classList.add('active');
                else btn.classList.remove('active');
            });
            // 同步左侧栏分组下拉框
            if (sidebarGroupSelect) {
                const hasOption = [...sidebarGroupSelect.options].some(opt => opt.value === activeFilter);
                if (hasOption) sidebarGroupSelect.value = activeFilter;
                else if (activeFilter === 'all' || activeFilter === 'custom' || activeFilter === 'builtin') sidebarGroupSelect.value = activeFilter;
                else sidebarGroupSelect.value = 'all';
            }

            const isGroupFilter = (activeSub || '').startsWith('group-');
            const targetGroup = isGroupFilter ? activeSub.replace(/^group-/, '') : null;
            const query = String(presetSearch?.value || '').trim().toLocaleLowerCase();
            const matchesSearch = node => !query || String(node.dataset.search || '').includes(query);
            const matchesScope = node => {
                if (activeScope === 'all') return true;
                if (activeScope === 'custom') return !node.classList.contains('builtin-card') && !node.classList.contains('builtin-item');
                if (activeScope === 'builtin') return node.classList.contains('builtin-card') || node.classList.contains('builtin-item');
                if (activeScope === 'src-library') return node.getAttribute('data-source') === 'library';
                if (activeScope === 'src-mine') return node.getAttribute('data-source') === 'mine';
                return true;
            };
            const matchesFilter = node => {
                if (!matchesScope(node)) return false;
                if (!activeSub) return true;
                if (activeSub === 'already-added') return node.classList.contains('is-already-added');
                if (activeSub === 'not-added') return !node.classList.contains('is-already-added');
                if (activeSub === 'fullscreen-yes') return node.getAttribute('data-fullscreen') === 'yes';
                if (activeSub === 'fullscreen-no') return node.getAttribute('data-fullscreen') === 'no';
                if (activeSub.startsWith('cat-')) return node.getAttribute('data-category') === activeSub;
                if (isGroupFilter) return node.getAttribute('data-group') === targetGroup;
                return false;
            };
            modal.querySelectorAll('.rop-gallery-card, .rop-gallery-sidebar-item').forEach(node => {
                node.style.display = matchesFilter(node) && matchesSearch(node) ? '' : 'none';
            });
        };

        tabs.forEach(t => t.onclick = (e) => {
            applyFilter(t.getAttribute('data-filter'));
        });

        if (sidebarGroupSelect) {
            sidebarGroupSelect.onchange = () => {
                applyFilter(sidebarGroupSelect.value);
            };
        }
        if (presetSearch) presetSearch.addEventListener('input', () => applyFilter(activeFilter));

        const grid = modal.querySelector('#rop-gallery-grid');
        const sidebarList = modal.querySelector('#rop-gallery-sidebar-list');
        const sidebar = modal.querySelector('.rop-gallery-sidebar');
        const resizer = modal.querySelector('#rop-gallery-resizer');

        // 侧栏宽度自由拉伸与本地记忆
        if (sidebar && resizer) {
            const savedWidth = parseInt(localStorage.getItem('rop_gallery_sidebar_width') || '260', 10);
            if (!isNaN(savedWidth) && savedWidth >= 160 && savedWidth <= 650) {
                sidebar.style.width = `${savedWidth}px`;
            }

            let startX = 0;
            let startWidth = 0;

            const onMouseMove = (e) => {
                const deltaX = e.clientX - startX;
                const newWidth = Math.max(160, Math.min(650, startWidth + deltaX));
                sidebar.style.width = `${newWidth}px`;
            };

            const onMouseUp = () => {
                resizer.classList.remove('dragging');
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
                window.removeEventListener('mousemove', onMouseMove);
                window.removeEventListener('mouseup', onMouseUp);
                const finalWidth = parseInt(sidebar.style.width, 10);
                if (finalWidth) {
                    try { localStorage.setItem('rop_gallery_sidebar_width', String(finalWidth)); } catch (_) {}
                }
            };

            resizer.addEventListener('mousedown', (e) => {
                e.preventDefault();
                startX = e.clientX;
                startWidth = sidebar.getBoundingClientRect().width;
                resizer.classList.add('dragging');
                document.body.style.cursor = 'col-resize';
                document.body.style.userSelect = 'none';
                window.addEventListener('mousemove', onMouseMove);
                window.addEventListener('mouseup', onMouseUp);
            });

            resizer.addEventListener('dblclick', () => {
                const defaultWidth = 260;
                sidebar.style.width = `${defaultWidth}px`;
                try { localStorage.setItem('rop_gallery_sidebar_width', String(defaultWidth)); } catch (_) {}
            });
        }
        
        // 排序：我的预设 → 预设库 → 内置
        const sourceRank = (n) => builtInKeys.includes(n) ? 2 : (libraryKeys.has(n) ? 1 : 0);
        const sortedEntries = Object.entries(presets).sort(([nameA], [nameB]) => sourceRank(nameA) - sourceRank(nameB));

        for (const [name, data] of sortedEntries) {
            const isBuiltin = builtInKeys.includes(name);
            const layers = Array.isArray(data) ? data : data.layers;
            const meta = data.meta || {};
            const category = this._detectPresetCategory(name, data);
            const catInfo = this._getCategoryMeta(category);
            
            const isFullscreen = this._hasFullscreenOverlay(name, data);
            
            const presetGroup = isBuiltin ? '内置预设' : (String(meta.category || data.category || '我的预设').trim() || '我的预设');
            
            const isAlready = isPresetAlreadyInBulk(name);
            const cardId = `rop-gallery-card-${name.replace(/\W/g, '_')}`;
            const card = document.createElement('div');
            card.id = cardId;
            card.className = `rop-gallery-card ${isBuiltin ? 'builtin-card' : 'custom-card'} ${isAlready ? 'is-already-added' : ''}`;
            card.setAttribute('data-category', `cat-${catInfo.key}`);
            card.setAttribute('data-fullscreen', isFullscreen ? 'yes' : 'no');
            card.setAttribute('data-group', presetGroup);
            const presetSource = isBuiltin ? 'builtin' : (libraryKeys.has(name) ? 'library' : 'mine');
            card.setAttribute('data-source', presetSource);
            const presetSearchText = [name, presetGroup, category, meta.description || '', ...(layers || []).map(layer => layer?.name || layer?.type || '')]
                .join(' ').toLocaleLowerCase();
            card.dataset.search = presetSearchText;
            
            const sideItem = document.createElement('div');
            sideItem.className = `rop-gallery-sidebar-item ${isBuiltin ? 'builtin-item' : 'custom-item'} ${isAlready ? 'is-already-added' : ''}`;
            sideItem.setAttribute('data-category', `cat-${catInfo.key}`);
            sideItem.setAttribute('data-fullscreen', isFullscreen ? 'yes' : 'no');
            sideItem.setAttribute('data-group', presetGroup);
            sideItem.setAttribute('data-source', presetSource);
            sideItem.dataset.search = presetSearchText;
            sideItem.innerHTML = `<span class="rop-sidebar-cat-pill cat-${catInfo.key}">${catInfo.shortLabel}</span><span style="overflow:hidden;text-overflow:ellipsis;">${escAttr(name)}</span>${isAlready ? '<span style="font-size:9.5px;color:#34d399;margin-left:auto;flex-shrink:0;font-weight:600;">已在库</span>' : ''}`;
            sideItem.title = name;
            sideItem.onclick = () => {
                modal.querySelectorAll('.rop-gallery-sidebar-item').forEach(i => i.classList.remove('active'));
                sideItem.classList.add('active');
                card.scrollIntoView({ behavior: 'smooth', block: 'center' });
                card.style.boxShadow = '0 0 0 2px var(--accent)';
                card.style.transition = 'box-shadow 0.3s';
                setTimeout(() => card.style.boxShadow = '', 1500);
            };
            sidebarList.appendChild(sideItem);
            
            // 选了图库临时背景时必须忽略旧缓存缩略图，所有预设都按同一背景重绘。
            const galleryPreviewBackground = this._presetGalleryPreviewBackground || '';
            const galleryPreviewText = this._presetGalleryPreviewText || '';
            let thumbUrl = (galleryPreviewBackground || galleryPreviewText) ? '' : (data.thumbnail || '');
            const imgHtml = thumbUrl ? `<img crossorigin="anonymous" class="rop-gallery-thumb" src="${thumbUrl}" />` : `<div class="rop-gallery-thumb-placeholder" style="color:#666;">加载中...</div>`;

            if (!thumbUrl && typeof PresetThumbRenderer !== 'undefined') {
                card.dataset.needsThumb = '1';
                card._lazyThumbTask = {
                    layers,
                    presets,
                    data,
                    name,
                    isBuiltin,
                    galleryPreviewBackground,
                    galleryPreviewText
                };
            }
            const tags = [];
            if (isAlready) tags.push(`<span class="rop-badge rop-badge-already-added" title="该预设已存在于大量建立模板库中">✅ 已在模板库</span>`);
            if (isBuiltin) tags.push(`<span class="rop-badge builtin">内置</span>`);
            // 预设类型专属高亮标签（显示在第一位）
            tags.push(`<span class="rop-badge rop-badge-category cat-${catInfo.key}">${category}</span>`);
            if (isFullscreen) {
                tags.push(`<span class="rop-badge rop-badge-fullscreen yes" title="该预设包含全屏蒙版或背景底色">有全屏</span>`);
            } else {
                tags.push(`<span class="rop-badge rop-badge-fullscreen no" title="该预设无全屏蒙版">无全屏</span>`);
            }
            tags.push(`<span class="rop-badge count">${layers.length} 层</span>`);
            if (!isBuiltin && presetGroup) {
                tags.push(`<span class="rop-badge rop-badge-custom-group" data-group-target="${escAttr(presetGroup)}" title="所属自定义分组：${escAttr(presetGroup)} (点击快速筛选)">📁 ${escAttr(presetGroup)}</span>`);
            }
            if (meta.hasFixedText) tags.push(`<span class="rop-badge fixed">含固定文案</span>`);
            if (meta.needsBatchText) tags.push(`<span class="rop-badge batch">需批量填充</span>`);

            const hasTextLayers = layers.some(l => l.type === 'text' || l.type === 'textcard' || l.type === 'scroll');

            let actionsHtml = '';
            if (onSelectCallback) {
                actionsHtml = multiSelect ? `
                    <div class="rop-gallery-actions" style="margin-top:auto;">
                        <button class="rop-btn rop-btn-select-preset ${isAlready ? 'is-already-added' : ''}" data-mode="select" data-already-added="${isAlready ? '1' : '0'}" style="width:100%;${isAlready ? 'background:rgba(16,185,129,.18);border-color:#34d399;color:#a7f3d0;' : 'background:rgba(124,92,255,.16);border-color:#8b5cf6;color:#ddd6fe;'}" title="${isAlready ? '该预设已加入模板库。如需重复添加，仍可点击勾选' : '勾选后点击顶部“添加所选”，一次加入大量建立模板库'}">${isAlready ? '✔ 已添加 (点击可再加)' : '☐ 选择加入模板库'}</button>
                        <button class="rop-btn" data-mode="edit" style="width:100%;margin-top:6px;background:rgba(96,165,250,.16);border-color:#60a5fa;color:#bfdbfe;">✏️ 直接编辑预设</button>
                    </div>
                ` : `
                    <div class="rop-gallery-actions" style="margin-top:auto;">
                        <div style="display:flex;gap:6px;">
                            <button class="rop-btn" data-mode="replace" style="flex:1;background:var(--accent,#7b8bef);color:#fff;" title="用此预设覆盖应用到选中任务">覆盖应用</button>
                            <button class="rop-btn" data-mode="merge" style="flex:1;background:rgba(16,185,129,.18);border-color:#34d399;color:#a7f3d0;" title="只追加此预设的覆层，不删除已有覆层">➕追加</button>
                        </div>
                        <button class="rop-btn" data-mode="edit" style="width:100%;margin-top:6px;background:rgba(96,165,250,.16);border-color:#60a5fa;color:#bfdbfe;">✏️ 直接编辑预设</button>
                    </div>
                `;
            } else if (!hasTextLayers) {
                actionsHtml = `
                    <div class="rop-gallery-actions">
                        <button class="rop-btn keep" data-mode="keep" style="width:100%;" title="应用该预设，并保留你原有的文字覆层">应用预设 (保留原有文字)</button>
                    </div>
                `;
            } else {
                actionsHtml = `
                    <div class="rop-gallery-actions">
                        <button class="rop-btn keep" data-mode="keep" title="保留当前文案，仅套用样式">保留文案</button>
                        <button class="rop-btn use" data-mode="use" title="使用预设自带文案">全用预设</button>
                        <button class="rop-btn clear" data-mode="clear" title="清除预设文案(适合进入批量表格)">清除(等批量)</button>
                    </div>
                `;
            }

            // 画布编辑入口始终可用：自定义预设加载后可直接“更新”；内置
            // 预设加载后只能另存为我的预设，避免用户误改随软件更新的原件。
            if (!onSelectCallback) {
                const editLabel = isBuiltin ? '复制后编辑' : '编辑预设';
                actionsHtml += `<button class="rop-btn rop-gallery-edit-btn" style="width:100%;margin-top:6px;background:rgba(96,165,250,.16);border-color:#60a5fa;color:#bfdbfe;" title="加载到画布后使用右侧覆层面板编辑">✏️ ${editLabel}</button>`;
            }

            card.innerHTML = `
                ${imgHtml}
                <div class="rop-gallery-info">
                    <div class="rop-gallery-title-row">
                        <div class="rop-gallery-title" title="${name}">${name}</div>
                        ${!isBuiltin ? `<span style="display:inline-flex;gap:2px;flex-shrink:0;">
                            <button class="rop-gallery-group-btn" title="移动到分组" style="background:none;border:none;cursor:pointer;font-size:13px;padding:2px 4px;color:#6ee7b7;line-height:1;">🏷</button>
                            <button class="rop-gallery-rename-btn" title="重命名" style="background:none;border:none;cursor:pointer;font-size:13px;padding:2px 4px;color:#8af;line-height:1;">✏️</button>
                            <button class="rop-gallery-delete-btn" title="删除该预设">✕</button>
                        </span>` : ''}
                    </div>
                    <div class="rop-gallery-tags">${tags.join('')}</div>
                    ${actionsHtml}
                </div>
            `;

            // 重命名按钮
            const renameBtn = card.querySelector('.rop-gallery-rename-btn');
            if (renameBtn) {
                renameBtn.onclick = async (e) => {
                    e.stopPropagation();
                    const newName = await this._showCardTemplateNameDialog(name);
                    if (!newName || newName === name) return;
                    if (presets[newName]) {
                        alert(`预设名称「${newName}」已存在，请使用其他名称`);
                        return;
                    }
                    // 转移数据到新名称
                    const presetData = presets[name];
                    presetData.name = newName;
                    presetData.updatedAt = new Date().toISOString();
                    presets[newName] = presetData;
                    delete presets[name];
                    this._setOverlayGroupPresets(presets);
                    this._notifyOverlayPresetsChanged();
                    // 更新 UI
                    const titleEl = card.querySelector('.rop-gallery-title');
                    if (titleEl) {
                        titleEl.textContent = newName;
                        titleEl.title = newName;
                    }
                    sideItem.textContent = newName;
                    sideItem.title = newName;
                    if (typeof showToast === 'function') showToast(`覆层预设已重命名为「${newName}」`, 'success');
                };
            }

            const groupBtn = card.querySelector('.rop-gallery-group-btn');
            if (groupBtn) {
                groupBtn.onclick = async (e) => {
                    e.stopPropagation();
                    const currentGroup = meta.category || '我的预设';
                    const savedGroups = Object.entries(presets)
                        .filter(([presetName]) => !builtInKeys.includes(presetName))
                        .map(([, preset]) => preset?.meta?.category || '我的预设');
                    const nextGroup = typeof window.reelsChoosePresetGroup === 'function'
                        ? await window.reelsChoosePresetGroup('移动覆层预设分组', currentGroup, savedGroups)
                        : await (typeof _showInputDialog === 'function'
                            ? _showInputDialog('移动覆层预设分组', '例如：祷告 / 媒体 / 金色字幕', currentGroup)
                            : Promise.resolve(prompt('输入分组名称：', currentGroup)));
                    if (!nextGroup || !String(nextGroup).trim()) return;
                    const cleanedGroup = String(nextGroup).trim();
                    presets[name].meta = presets[name].meta || {};
                    presets[name].meta.category = cleanedGroup;
                    presets[name].updatedAt = new Date().toISOString();
                    this._setOverlayGroupPresets(presets);
                    this._notifyOverlayPresetsChanged();
                    modal.remove();
                    this._showPresetGallery(onSelectCallback, multiSelect, `group-${cleanedGroup}`);
                    if (typeof showToast === 'function') showToast(`预设已移动到分组「${cleanedGroup}」`, 'success');
                };
            }
            
            const delBtn = card.querySelector('.rop-gallery-delete-btn');
            if (delBtn) {
                delBtn.onclick = (e) => {
                    e.stopPropagation();
                    if (confirm(`确定要删除预设 "${name}" 吗？`)) {
                        delete presets[name];
                        this._setOverlayGroupPresets(presets);
                        card.remove();
                        sideItem.remove();
                        this._notifyOverlayPresetsChanged();
                    }
                };
            }

            const editBtn = card.querySelector('.rop-gallery-edit-btn');
            if (editBtn) {
                editBtn.onclick = event => {
                    event.stopPropagation();
                    this._openPresetLibraryEditor(modal, name, data, isBuiltin);
                };
            }
            
            const btns = card.querySelectorAll('.rop-gallery-actions .rop-btn');
            btns.forEach(btn => {
                btn.onclick = (e) => {
                    const mode = e.target.getAttribute('data-mode');
                    if (onSelectCallback) {
                        if (mode === 'edit') {
                            this._openPresetLibraryEditor(modal, name, data, isBuiltin);
                            return;
                        }
                        if (mode === 'select') {
                            const isAlready = e.target.getAttribute('data-already-added') === '1';
                            const selected = selectedPresetNames.has(name);
                            if (selected) {
                                selectedPresetNames.delete(name);
                                e.target.textContent = isAlready ? '✔ 已添加 (点击可再加)' : '☐ 选择加入模板库';
                                e.target.style.background = isAlready ? 'rgba(16,185,129,.18)' : '';
                                e.target.style.borderColor = isAlready ? '#34d399' : '#8b5cf6';
                                e.target.style.color = isAlready ? '#a7f3d0' : '#ddd6fe';
                            } else {
                                selectedPresetNames.add(name);
                                e.target.textContent = isAlready ? '✅ 已勾选 (再次添加)' : '✅ 已选择';
                                e.target.style.background = 'rgba(16,185,129,.35)';
                                e.target.style.borderColor = '#10b981';
                                e.target.style.color = '#ffffff';
                            }
                            const addSelectedBtn = modal.querySelector('.rop-gallery-add-selected');
                            if (addSelectedBtn) {
                                addSelectedBtn.textContent = `添加所选（${selectedPresetNames.size}）`;
                                if (selectedPresetNames.size > 0) {
                                    addSelectedBtn.classList.remove('is-empty');
                                } else {
                                    addSelectedBtn.classList.add('is-empty');
                                }
                            }
                            return;
                        }
                        onSelectCallback(name, data, mode);
                        if (!this.multiSelectPicker) {
                            document.body.removeChild(modal);
                        } else {
                            const oldText = e.target.textContent;
                            e.target.textContent = '✅ 已添加';
                            e.target.style.background = 'rgba(16,185,129,0.8)';
                            setTimeout(() => {
                                e.target.textContent = oldText;
                                e.target.style.background = '';
                            }, 1500);
                        }
                    } else {
                        (async () => {
                            const ok = await this._applyPresetFromGallery(data, mode, name);
                            if (ok && modal && modal.parentNode) {
                                document.body.removeChild(modal);
                            }
                        })();
                    }
                };
            });

            grid.appendChild(card);
        }

        const addSelectedBtn = modal.querySelector('.rop-gallery-add-selected');
        if (addSelectedBtn) {
            addSelectedBtn.onclick = () => {
                if (!selectedPresetNames.size) {
                    if (typeof showToast === 'function') showToast('请先选择至少一个覆层预设', 'warning');
                    return;
                }
                const selections = [...selectedPresetNames]
                    .map(name => ({ name, data: presets[name] }))
                    .filter(item => item.data);
                onSelectCallback(selections, null, 'batch-add');
                modal.remove();
            };
        }

        // ── 视口懒加载与顺序队列（极大减轻290+预设并发渲染与存储造成的卡顿） ──
        if (typeof PresetThumbRenderer !== 'undefined') {
            const sharedThumbRenderer = new PresetThumbRenderer();
            const thumbQueue = [];
            let isThumbProcessing = false;

            const processThumbQueue = () => {
                if (isThumbProcessing || thumbQueue.length === 0) return;
                isThumbProcessing = true;
                const task = thumbQueue.shift();
                if (!task || !task.card.isConnected) {
                    isThumbProcessing = false;
                    processThumbQueue();
                    return;
                }
                const { card, layers, presets, data, isBuiltin, galleryPreviewBackground, galleryPreviewText } = task;
                sharedThumbRenderer.renderThumbAsync(layers, '#1a1a2e', galleryPreviewBackground, galleryPreviewText).then(url => {
                    if (url && card.isConnected) {
                        const placeholder = card.querySelector('.rop-gallery-thumb-placeholder');
                        const newImg = document.createElement('img');
                        newImg.className = 'rop-gallery-thumb';
                        newImg.src = url;
                        if (placeholder) placeholder.replaceWith(newImg);
                        if (!isBuiltin && !galleryPreviewBackground && !galleryPreviewText) {
                            data.thumbnail = url;
                            this._debouncedSavePresets(presets);
                        }
                    } else if (!url && card.isConnected) {
                        const placeholder = card.querySelector('.rop-gallery-thumb-placeholder');
                        if (placeholder) placeholder.textContent = '无预览 (受限)';
                    }
                }).catch(err => {
                    console.warn('Thumb gen failed:', err);
                    if (card.isConnected) {
                        const placeholder = card.querySelector('.rop-gallery-thumb-placeholder');
                        if (placeholder) placeholder.textContent = '渲染失败';
                    }
                }).finally(() => {
                    isThumbProcessing = false;
                    setTimeout(processThumbQueue, 16);
                });
            };

            const thumbObserver = new IntersectionObserver((entries) => {
                entries.forEach(entry => {
                    if (entry.isIntersecting) {
                        const card = entry.target;
                        thumbObserver.unobserve(card);
                        if (card._lazyThumbTask) {
                            thumbQueue.push({ card, ...card._lazyThumbTask });
                            delete card._lazyThumbTask;
                            processThumbQueue();
                        }
                    }
                });
            }, {
                // 实际滚动容器是 .rop-gallery-body，不是外层 .rop-gallery-main。
                // 使用错误 root 时，滚动到可见位置的卡片不会进入缩略图队列。
                root: modal.querySelector('.rop-gallery-body') || modal.querySelector('.rop-gallery-grid') || null,
                rootMargin: '250px 0px'
            });

            grid.querySelectorAll('.rop-gallery-card[data-needs-thumb="1"]').forEach(c => thumbObserver.observe(c));

            const origModalRemove = modal.remove.bind(modal);
            modal.remove = () => {
                thumbObserver.disconnect();
                thumbQueue.length = 0;
                origModalRemove();
            };
        }

        // 点击卡片上的自定义分组标签快速筛选
        modal.querySelectorAll('.rop-badge-custom-group').forEach(badge => {
            badge.onclick = (e) => {
                e.stopPropagation();
                const g = badge.getAttribute('data-group-target');
                if (g) applyFilter(`group-${g}`);
            };
        });

        // 如果传入了指定的分组过滤（例如移动预设后重新加载定位）
        if (defaultFilter && defaultFilter !== 'all') {
            applyFilter(defaultFilter);
        }
    }

    // 预设库内编辑：不加载任务、不关闭图库、更不跳转主 Reels 页面。
    _openPresetLibraryEditor(modal, name, data, isBuiltin) {
        const content = modal.querySelector('.rop-gallery-content');
        if (!content || !window.ReelsOverlay?.OverlayManager) return;
        const layers = JSON.parse(JSON.stringify(Array.isArray(data) ? data : (data.layers || [])));
        // 文案预设常把待批量填充的位置留空。编辑图库时把临时文案放进这些
        // 空字段，令画布和右侧输入框一致；保存时会还原这些未改动的字段。
        const savedPreviewText = this._presetGalleryPreviewText;
        const previewText = typeof savedPreviewText === 'object' && savedPreviewText ? savedPreviewText : { title: savedPreviewText || 'PRAY THIS NOW—AND STAND FIRM IN JESUS', body: savedPreviewText || "Dear Lord, my Refuge and Defender, in the authority of Jesus' name, I reject every lie, fear, deception, and spiritual attack that tries to weaken my faith. Let the precious blood of Jesus cover my life, my home, my health, and the people I love. Expose every hidden trap and silence every voice that contradicts Your truth. Where fear has taken root, bring courage. Where confusion has entered, bring clarity. Where the past still speaks too loudly, remind me that my identity is in Christ. Put \"I love Jesus!\" and let your faith be known. If you want to study the Bible, \"Amen\".", footer: '' };
        const temporaryTextFields = [];
        const fillTemporaryText = (ov, key, index) => {
            if (ov[key] == null) {
                temporaryTextFields.push({ index, key, original: ov[key] });
                ov[key] = key === 'title_text' || key === 'scroll_title' ? previewText.title : (key === 'footer_text' ? previewText.footer : previewText.body);
            }
        };
        layers.forEach((ov, index) => {
            if (ov.type === 'textcard') { fillTemporaryText(ov, 'title_text', index); fillTemporaryText(ov, 'body_text', index); fillTemporaryText(ov, 'footer_text', index); }
            else if (ov.type === 'scroll') { fillTemporaryText(ov, 'scroll_title', index); fillTemporaryText(ov, 'content', index); }
            else if (ov.type === 'text') fillTemporaryText(ov, 'content', index);
        });
        const safeName = String(name).replace(/&/g, '&amp;').replace(/</g, '&lt;');
        const previewBackground = this._presetGalleryPreviewBackground || '';
        const previewBackgroundName = previewBackground ? previewBackground.split(/[\\/]/).pop() : '未设置（深色背景）';
        content.innerHTML = `<div class="rop-gallery-header" style="flex-shrink:0;"><h3>✏️ 编辑预设：${safeName}</h3><button class="rop-library-back rop-library-action">← 返回预设库</button></div>
          <div style="flex:1;min-height:0;height:calc(100% - 56px);display:grid;grid-template-columns:minmax(280px,360px) minmax(380px,1fr);gap:16px;padding:12px 18px;overflow:hidden;box-sizing:border-box;">
            <div style="display:flex;flex-direction:column;min-height:0;height:100%;overflow:hidden;">
              <div data-lib-viewport style="position:relative;width:100%;aspect-ratio:9/16;max-height:calc(100vh - 165px);background:#0b1020;border-radius:10px;overflow:hidden;cursor:grab;user-select:none;border:1px solid rgba(255,255,255,0.15);box-shadow:0 8px 24px rgba(0,0,0,0.45);flex-shrink:0;">
                <div style="position:absolute;top:8px;right:8px;z-index:20;display:flex;gap:4px;background:rgba(15,23,42,0.85);backdrop-filter:blur(8px);padding:4px 6px;border-radius:6px;border:1px solid rgba(255,255,255,0.2);box-shadow:0 4px 12px rgba(0,0,0,0.5);">
                  <span data-zoom-label style="font-size:11px;color:#e2e8f0;font-weight:600;align-self:center;min-width:38px;text-align:center;font-family:monospace;">100%</span>
                  <button data-zoom-in style="padding:2px 7px;font-size:12px;background:rgba(255,255,255,0.12);color:#fff;border:0;border-radius:4px;cursor:pointer;" title="放大 (滚轮向上)">➕</button>
                  <button data-zoom-out style="padding:2px 7px;font-size:12px;background:rgba(255,255,255,0.12);color:#fff;border:0;border-radius:4px;cursor:pointer;" title="缩小 (滚轮向下)">➖</button>
                  <button data-zoom-reset style="padding:2px 7px;font-size:11px;background:rgba(255,255,255,0.12);color:#94a3b8;border:0;border-radius:4px;cursor:pointer;" title="重置缩放 (双击画布也可复位)">1:1</button>
                </div>
                <div data-lib-stage style="position:absolute;top:0;left:0;width:100%;height:100%;transform-origin:0 0;will-change:transform;">
                  <video crossorigin="anonymous" data-lib-video muted loop playsinline style="position:absolute;width:100%;height:100%;object-fit:cover"></video>
                  <img crossorigin="anonymous" data-lib-image style="position:absolute;width:100%;height:100%;object-fit:cover;display:none">
                  <canvas data-lib-canvas width="1080" height="1920" style="position:absolute;width:100%;height:100%;pointer-events:none"></canvas>
                </div>
              </div>
              <div class="rop-library-preview-note" style="margin-top:8px;font-size:12px;">临时预览背景：<span data-lib-label>${previewBackgroundName}</span></div>
              <div style="font-size:11px;color:#94a3b8;margin-top:4px">💡 鼠标滚轮实时缩放，按住左键拖拽平移，双击复位。</div>
            </div>
            <div style="display:flex;flex-direction:column;min-height:0;height:100%;overflow-y:auto;overflow-x:hidden;padding-right:8px;box-sizing:border-box;">
              <div data-lib-panel></div>
              <button data-lib-save style="margin:12px 0 16px;width:100%;padding:10px;background:#2563eb;color:#fff;border:0;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;box-shadow:0 4px 12px rgba(37,99,235,0.3);flex-shrink:0;">保存预设</button>
            </div>
          </div>`;
        const get = selector => content.querySelector(selector);

        // ── 预览画面滚轮缩放与拖拽平移 ──
        const viewport = get('[data-lib-viewport]');
        const stage = get('[data-lib-stage]');
        const zoomLabel = get('[data-zoom-label]');
        const zoomInBtn = get('[data-zoom-in]');
        const zoomOutBtn = get('[data-zoom-out]');
        const zoomResetBtn = get('[data-zoom-reset]');

        if (viewport && stage) {
            let scale = 1.0;
            let panX = 0, panY = 0;
            let isPanning = false;
            let startClientX = 0, startClientY = 0;
            let origPanX = 0, origPanY = 0;

            const applyTransform = () => {
                stage.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
                if (zoomLabel) zoomLabel.textContent = `${Math.round(scale * 100)}%`;
            };

            viewport.addEventListener('wheel', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const rect = viewport.getBoundingClientRect();
                const mouseX = e.clientX - rect.left;
                const mouseY = e.clientY - rect.top;

                const factor = e.deltaY < 0 ? 1.15 : (1 / 1.15);
                const nextScale = Math.min(6.0, Math.max(0.6, scale * factor));

                panX = mouseX - (mouseX - panX) * (nextScale / scale);
                panY = mouseY - (mouseY - panY) * (nextScale / scale);
                scale = nextScale;

                if (Math.abs(scale - 1.0) < 0.04) {
                    scale = 1.0;
                    panX = 0;
                    panY = 0;
                }
                applyTransform();
            }, { passive: false });

            viewport.addEventListener('pointerdown', (e) => {
                if (e.target.closest('button')) return;
                isPanning = true;
                startClientX = e.clientX;
                startClientY = e.clientY;
                origPanX = panX;
                origPanY = panY;
                viewport.style.cursor = 'grabbing';
                try { viewport.setPointerCapture(e.pointerId); } catch (_) {}
            });

            viewport.addEventListener('pointermove', (e) => {
                if (!isPanning) return;
                panX = origPanX + (e.clientX - startClientX);
                panY = origPanY + (e.clientY - startClientY);
                applyTransform();
            });

            const stopPanning = (e) => {
                if (!isPanning) return;
                isPanning = false;
                viewport.style.cursor = 'grab';
                try { viewport.releasePointerCapture(e.pointerId); } catch (_) {}
            };
            viewport.addEventListener('pointerup', stopPanning);
            viewport.addEventListener('pointercancel', stopPanning);

            if (zoomInBtn) {
                zoomInBtn.onclick = (e) => {
                    e.stopPropagation();
                    const rect = viewport.getBoundingClientRect();
                    const cx = rect.width / 2, cy = rect.height / 2;
                    const nextScale = Math.min(6.0, scale * 1.25);
                    panX = cx - (cx - panX) * (nextScale / scale);
                    panY = cy - (cy - panY) * (nextScale / scale);
                    scale = nextScale;
                    applyTransform();
                };
            }
            if (zoomOutBtn) {
                zoomOutBtn.onclick = (e) => {
                    e.stopPropagation();
                    const rect = viewport.getBoundingClientRect();
                    const cx = rect.width / 2, cy = rect.height / 2;
                    const nextScale = Math.max(0.6, scale * 0.8);
                    panX = cx - (cx - panX) * (nextScale / scale);
                    panY = cy - (cy - panY) * (nextScale / scale);
                    scale = nextScale;
                    applyTransform();
                };
            }
            if (zoomResetBtn) {
                zoomResetBtn.onclick = (e) => {
                    e.stopPropagation();
                    scale = 1.0;
                    panX = 0;
                    panY = 0;
                    applyTransform();
                };
            }

            viewport.addEventListener('dblclick', (e) => {
                if (e.target.closest('button')) return;
                if (Math.abs(scale - 1.0) < 0.1) {
                    scale = 2.0;
                    const rect = viewport.getBoundingClientRect();
                    const mouseX = e.clientX - rect.left;
                    const mouseY = e.clientY - rect.top;
                    panX = mouseX - mouseX * 2;
                    panY = mouseY - mouseY * 2;
                } else {
                    scale = 1.0;
                    panX = 0;
                    panY = 0;
                }
                applyTransform();
            });
        }
        if (previewBackground) {
            const isImage = /\.(jpg|jpeg|png|webp|gif)$/i.test(previewBackground);
            const media = isImage ? get('[data-lib-image]') : get('[data-lib-video]');
            get('[data-lib-image]').style.display = isImage ? '' : 'none';
            get('[data-lib-video]').style.display = isImage ? 'none' : '';
            media.src = window.electronAPI?.toFileUrl ? window.electronAPI.toFileUrl(previewBackground) : previewBackground;
            if (!isImage) media.play().catch(() => {});
        }
        const mgr = new window.ReelsOverlay.OverlayManager(); mgr.overlays = layers;
        const draw = () => { const canvas = get('[data-lib-canvas]'); const ctx = canvas.getContext('2d'); ctx.clearRect(0, 0, 1080, 1920); mgr.overlays.forEach(ov => window.ReelsOverlay.drawOverlay(ctx, { ...ov, _exporting: true }, 0, 1080, 1920)); };
        let _editorDrawRaf = null;
        const requestDraw = () => {
            if (_editorDrawRaf) cancelAnimationFrame(_editorDrawRaf);
            _editorDrawRaf = requestAnimationFrame(() => {
                _editorDrawRaf = null;
                draw();
            });
        };
        let editor;
        const proxy = { overlayMgr: mgr, getCanvasSize: () => ({ w:1080,h:1920,cx:540,cy:960 }), getDuration: () => 9999, previewEnd: () => {}, getOverlayAboveSubtitle: () => true, setOverlayAboveSubtitle: () => {}, addOverlay: ov => { mgr.addOverlay(ov); requestDraw(); editor?._refreshList(); }, removeOverlay: id => { mgr.removeOverlay(id); requestDraw(); editor?._refreshList(); }, render: requestDraw };
        editor = new ReelsOverlayPanel(get('[data-lib-panel]'), proxy);
        get('[data-lib-panel]').querySelector('.rop-section')?.remove();
        editor._refreshList(); if (mgr.overlays[0]) editor.selectOverlay(mgr.overlays[0]); draw();
        get('[data-lib-save]').onclick = () => {
            let target = name; if (isBuiltin) { target = prompt('内置预设不能覆盖，请输入新预设名称：', `${name}（我的修改）`); if (!target) return; }
            let presets = {}; try { presets = JSON.parse(localStorage.getItem('reels_overlay_group_presets') || '{}'); } catch (_) {}
            const layersToSave = JSON.parse(JSON.stringify(mgr.overlays));
            // 仅把没有被用户实际改写的临时文案恢复为原来的空字段。
            temporaryTextFields.forEach(({ index, key, original }) => { const temp = key === 'title_text' || key === 'scroll_title' ? previewText.title : (key === 'footer_text' ? previewText.footer : previewText.body); if (layersToSave[index]?.[key] === temp) layersToSave[index][key] = original; });
            presets[target] = { ...(Array.isArray(data) ? {} : data), name:target, layers:layersToSave, meta:this._migratePresetFormat(target, layersToSave).meta, updatedAt:new Date().toISOString() };
            localStorage.setItem('reels_overlay_group_presets', JSON.stringify(presets));
            this._notifyOverlayPresetsChanged();
            if (typeof showToast === 'function') showToast(`预设「${target}」已保存`, 'success');
        };
        // 返回图库时必须销毁当前编辑弹层；否则关闭新图库会露出它，像是自动进入编辑页。
        get('.rop-library-back').onclick = () => { this._showPresetGallery(); modal.remove(); };
    }

    async _applyPresetFromGallery(presetData, mode, presetName = '') {
        const mgr = this.videoCanvas.overlayMgr;
        if (!mgr) return false;
        const previousOverlays = JSON.parse(JSON.stringify(mgr.overlays, (key, value) => key === '_allOverlays' ? undefined : value));
        const restorePreviousOverlays = () => {
            mgr.overlays = previousOverlays;
            this._selectedOv = mgr.overlays[0] || null;
            this._refreshList();
            if (this._selectedOv) this._syncFromOverlay(this._selectedOv);
            this.videoCanvas?.render?.();
        };
        
        let layers = Array.isArray(presetData) ? presetData : presetData.layers;
        if (!layers || layers.length === 0) return false;

        let loadMode = 'replace';
        if (mgr.overlays.length > 0) {
            const choice = await this._showPresetLoadChoiceDialog(presetName || '所选预设', mgr.overlays.length, layers.length);
            if (!choice) { restorePreviousOverlays(); return false; }
            loadMode = choice;
            mode = 'use'; // The dialog's explicit choice overrides the gallery's earlier mode.
        }

        if (loadMode === 'keep-text') layers = _ropPresetLayersKeepingText(layers, mgr.overlays);

        if (loadMode === 'merge') {
            const newlyAdded = [];
            const idMap = {};
            for (let i = 0; i < layers.length; i++) {
                const layerData = layers[i];
                const clone = JSON.parse(JSON.stringify(layerData));
                const oldId = clone.id;
                clone.id = 'ov_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
                if (oldId) idMap[oldId] = clone.id;

                const loadedStart = Number(clone.start);
                const loadedEnd = Number(clone.end);
                clone.start = Number.isFinite(loadedStart) ? Math.max(0, loadedStart) : 0;
                clone.end = Number.isFinite(loadedEnd) && loadedEnd >= clone.start ? loadedEnd : 9999;

                mgr.overlays.push(clone);
                newlyAdded.push(clone);
            }

            const firstScrollOv = newlyAdded.find(o => o.type === 'scroll') || mgr.overlays.find(o => o.type === 'scroll');
            for (const ov of newlyAdded) {
                if (ov.bind_scroll_overlay_id) {
                    if (idMap[ov.bind_scroll_overlay_id]) {
                        ov.bind_scroll_overlay_id = idMap[ov.bind_scroll_overlay_id];
                    } else if (firstScrollOv) {
                        ov.bind_scroll_overlay_id = firstScrollOv.id;
                    }
                }
            }

            this._selectedOv = newlyAdded[0] || mgr.overlays[0] || null;
            this._refreshList();
            if (this._selectedOv) this._syncFromOverlay(this._selectedOv);
            if (this.videoCanvas) this.videoCanvas.render();
            if (typeof showToast === 'function') {
                showToast(`已成功合并追加 ${newlyAdded.length} 个覆层 (当前共 ${mgr.overlays.length} 层)`, 'success');
            }
            return true;
        }

        // Save existing text before clearing.
        const oldTextByIndex = [...mgr.overlays];
        const oldTextByType = new Map();
        const usedOldText = new Set();
        const collectText = (ov) => {
            if (!ov || typeof ov !== 'object') return null;
            const data = {};
            let hasText = false;
            if (ov.type === 'textcard') {
                data.title_text = ov.title_text ?? ''; hasText = true;
                data.body_text = ov.body_text ?? ''; hasText = true;
                data.footer_text = ov.footer_text ?? ''; hasText = true;
            } else if (ov.type === 'scroll') {
                data.scroll_title = ov.scroll_title ?? ''; hasText = true;
                data.content = ov.content ?? ''; hasText = true;
            } else if (ov.type === 'text') {
                data.content = ov.content ?? ''; hasText = true;
            }
            if (hasText) {
                if (!oldTextByType.has(ov.type)) oldTextByType.set(ov.type, []);
                oldTextByType.get(ov.type).push(ov);
            }
            return hasText ? data : null;
        };

        const nextTextFor = (type) => {
            const list = oldTextByType.get(type);
            if (!list || list.length === 0) return null;
            for (let i = 0; i < list.length; i++) {
                const ov = list[i];
                if (!usedOldText.has(ov)) {
                    usedOldText.add(ov);
                    return collectText(ov);
                }
            }
            return null;
        };

        const applyText = (ov, tData) => {
            if (!tData) return;
            if (ov.type === 'textcard') {
                if (Object.prototype.hasOwnProperty.call(tData, 'title_text')) ov.title_text = tData.title_text;
                if (Object.prototype.hasOwnProperty.call(tData, 'body_text')) ov.body_text = tData.body_text;
                if (Object.prototype.hasOwnProperty.call(tData, 'footer_text')) ov.footer_text = tData.footer_text;
            } else if (ov.type === 'scroll') {
                if (Object.prototype.hasOwnProperty.call(tData, 'scroll_title')) ov.scroll_title = tData.scroll_title;
                if (Object.prototype.hasOwnProperty.call(tData, 'content')) ov.content = tData.content;
            } else if (ov.type === 'text') {
                if (Object.prototype.hasOwnProperty.call(tData, 'content')) ov.content = tData.content;
            }
        };

        const layerHasText = (ov) => {
            if (ov.type === 'textcard') return !!(ov.title_text || ov.body_text || ov.footer_text);
            if (ov.type === 'scroll') return !!(ov.scroll_title || ov.content);
            if (ov.type === 'text') return !!ov.content;
            return true;
        };

        const layerNeedsText = (ov) => {
            if (!ov || ov.fixed_text) return false;
            return ov.type === 'text' || ov.type === 'textcard' || ov.type === 'scroll';
        };

        const layerLabel = (ov, idx) => {
            const typeLabel = ov.type === 'scroll' 
                ? '滚动字幕' 
                : ov.type === 'textcard'
                    ? '文字卡片'
                    : ov.type === 'solid_mask'
                        ? '纯色蒙版'
                        : ov.type === 'text'
                            ? '文本覆层'
                            : '覆层';
            return `${idx + 1}.${typeLabel}`;
        };

        const missingTextLayers = [];
        mgr.overlays = [];

        const idMap = {};
        for (let i = 0; i < layers.length; i++) {
            const layerData = layers[i];
            const clone = JSON.parse(JSON.stringify(layerData));
            const oldId = clone.id;
            clone.id = 'ov_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
            if (oldId) idMap[oldId] = clone.id;
            const loadedStart = Number(clone.start);
            const loadedEnd = Number(clone.end);
            clone.start = Number.isFinite(loadedStart) ? Math.max(0, loadedStart) : 0;
            clone.end = Number.isFinite(loadedEnd) && loadedEnd >= clone.start ? loadedEnd : 9999;
            
            if (clone.fixed_text) {
                // 固定文案永远原样保留
                mgr.overlays.push(clone);
                continue;
            }

            if (mode === 'keep') {
                // 保留模式: 用之前的文案填充
                const indexedSource = oldTextByIndex[i];
                const indexedText = usedOldText.has(indexedSource) ? null : collectText(indexedSource);
                if (indexedText) usedOldText.add(indexedSource);
                applyText(clone, indexedText || nextTextFor(clone.type));
                
                if (layerNeedsText(clone) && !layerHasText(clone)) {
                    missingTextLayers.push(layerLabel(clone, i));
                }
            } else if (mode === 'clear') {
                // 清除模式: 清空文案, 给表格留位置
                if (clone.type === 'textcard') {
                    clone.title_text = '';
                    clone.body_text = '';
                    clone.footer_text = '';
                } else if (clone.type === 'scroll') {
                    clone.scroll_title = '';
                    clone.content = '';
                } else if (clone.type === 'text') {
                    clone.content = '';
                }
            } else if (mode === 'use') {
                // 全用预设模式: 原样使用预设里的文案(即 clone 本身)
                // 预设可能本身就没有文案（比如用 clear 模式保存的），不过这是预设自身的状态，用户选择了"使用预设"。
            }
            mgr.overlays.push(clone);
        }

        // 重映射跟随滚动绑定的 ID 引用，若找不到匹配目标且存在滚动层，则回退绑定到首个滚动层
        const firstScrollOv = mgr.overlays.find(o => o.type === 'scroll');
        for (const ov of mgr.overlays) {
            if (ov.bind_scroll_overlay_id) {
                if (idMap[ov.bind_scroll_overlay_id]) {
                    ov.bind_scroll_overlay_id = idMap[ov.bind_scroll_overlay_id];
                } else if (firstScrollOv) {
                    ov.bind_scroll_overlay_id = firstScrollOv.id;
                }
            }
        }

        if (mode === 'keep') {
            // Append any old text layers that were not absorbed by the new preset
            for (const oldOv of oldTextByIndex) {
                if (!usedOldText.has(oldOv)) {
                    if (oldOv.type === 'text' || oldOv.type === 'textcard' || oldOv.type === 'scroll') {
                        const clone = JSON.parse(JSON.stringify(oldOv, (key, val) => key === '_allOverlays' ? undefined : val));
                        clone.id = 'ov_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
                        mgr.overlays.push(clone);
                    }
                }
            }
        }

        this._selectedOv = mgr.overlays[0] || null;
        this._refreshList();
        if (this._selectedOv) this._syncFromOverlay(this._selectedOv);
        if (this.videoCanvas) this.videoCanvas.render();

        if (mode === 'keep' && missingTextLayers.length > 0) {
            alert(`预设已加载，但以下覆层没有可继承的文案，请手动填写：\n${missingTextLayers.join('\n')}`);
        } else if (mode === 'clear') {
            const batchColStr = (presetData.meta && presetData.meta.batchColumns && presetData.meta.batchColumns.length > 0) 
                ? presetData.meta.batchColumns.join(', ')
                : '覆层标题、覆层内容等';
            alert(`已清空可替换文案。\n💡 建议在【批量表格】中配置对应的列（如：${batchColStr}）并导入数据。`);
        }
        return true;
    }

    _deleteOverlayGroupPreset() {
        const select = this.container.querySelector('#rop-group-preset-select');
        if (!select || !select.value) {
            alert('请先在下拉列表中选择要删除的预设');
            return;
        }
        const name = select.value;
        if (!confirm(`确定要删除预设 "${name}" 吗？`)) return;
        const presets = this._getOverlayGroupPresets();
        delete presets[name];
        this._setOverlayGroupPresets(presets);
        this._notifyOverlayPresetsChanged();
    }

    async _renameOverlayGroupPreset() {
        const select = this.container?.querySelector('#rop-group-preset-select') || document.querySelector('#rop-group-preset-select');
        if (!select || !select.value) {
            alert('请先在下拉列表中选择要重命名的预设');
            return;
        }
        const oldName = select.value;
        const newName = await this._showCardTemplateNameDialog(oldName);
        if (!newName || newName === oldName) return;
        const presets = this._getOverlayGroupPresets();
        if (presets[newName]) {
            alert(`预设名称「${newName}」已存在，请使用其他名称`);
            return;
        }
        // 转移数据到新名称
        const presetData = presets[oldName];
        presetData.name = newName;
        presetData.updatedAt = new Date().toISOString();
        presets[newName] = presetData;
        delete presets[oldName];
        this._setOverlayGroupPresets(presets);
        this._notifyOverlayPresetsChanged();
        select.value = newName;
        if (typeof showToast === 'function') showToast(`覆层预设已重命名为「${newName}」`, 'success');
        else alert(`✅ 覆层预设已重命名为「${newName}」`);
    }

    _importOverlayGroupPresets() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.onchange = (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (ev) => {
                try {
                    const data = JSON.parse(ev.target.result);
                    this._mergeImportedOverlayGroupPresets(data);
                } catch (err) {
                    console.error('导入预设出错:', err);
                    alert('导入失败，不是有效的预设 JSON 文件。');
                }
            };
            reader.readAsText(file);
        };
        input.click();
    }

    _mergeImportedOverlayGroupPresets(data, missingMedia = []) {
        const presets = this._getOverlayGroupPresets(); let addedCount = 0, overwrittenCount = 0;
        const conflicts = Object.keys(data || {}).filter(name => presets[name]);
        const overwrite = !conflicts.length || confirm(`导入中有已存在的预设：\n${conflicts.join(', ')}\n\n是否覆盖？取消将跳过冲突项。`);
        for (const [name, value] of Object.entries(data || {})) {
            if (presets[name]) { if (overwrite) { presets[name] = value; overwrittenCount++; } }
            else { presets[name] = value; addedCount++; }
        }
        this._setOverlayGroupPresets(presets); this._notifyOverlayPresetsChanged();
        alert(`✅ 导入完成：新增 ${addedCount} 个，覆盖 ${overwrittenCount} 个。${missingMedia.length ? `\n⚠️ 包内有 ${missingMedia.length} 个原路径媒体当时未找到，未被打包。` : ''}`);
    }

    _exportOverlayGroupPresets() {
        const presets = this._getOverlayGroupPresets();
        const builtInKeys = window.REELS_BUILTIN_OVERLAY_GROUP_PRESETS ? Object.keys(window.REELS_BUILTIN_OVERLAY_GROUP_PRESETS) : [];
        // Only show user-created presets (skip built-in)
        const exportableNames = Object.keys(presets).filter(k => !builtInKeys.includes(k));
        if (exportableNames.length === 0) {
            alert('暂无自定义覆层预设可导出（内置预设无需导出）');
            return;
        }

        const modal = document.createElement('div');
        modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:300000;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;';
        let list = '';
        exportableNames.forEach(name => {
            const data = presets[name];
            const layers = Array.isArray(data) ? data : (data.layers || []);
            const layerCount = layers.length;
            const thumb = data.thumbnail || '';
            const thumbHtml = thumb
                ? `<img crossorigin="anonymous" src="${thumb}" style="width:36px;height:36px;object-fit:cover;border-radius:4px;border:1px solid #333;flex-shrink:0;">`
                : `<div style="width:36px;height:36px;display:flex;align-items:center;justify-content:center;background:#1a1a2e;border-radius:4px;border:1px solid #333;font-size:14px;flex-shrink:0;">🎨</div>`;
            list += `<label style="display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid #222;cursor:pointer;">
                <input type="checkbox" class="rop-export-cb" data-name="${name.replace(/"/g, '&quot;')}" checked>
                ${thumbHtml}
                <div style="flex:1;min-width:0;">
                    <div style="color:#eee;font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${name.replace(/</g, '&lt;')}</div>
                    <div style="color:#666;font-size:10px;">${layerCount} 层</div>
                </div>
            </label>`;
        });
        modal.innerHTML = `<div style="background:#1a1a2e;border:1px solid #333;border-radius:10px;width:440px;max-height:65vh;display:flex;flex-direction:column;">
            <div style="padding:12px 16px;border-bottom:1px solid #333;display:flex;justify-content:space-between;align-items:center;">
                <span style="color:#fff;font-weight:600;">⬆ 选择要导出的覆层预设</span>
                <div style="display:flex;gap:6px;">
                    <button class="rop-export-all" style="padding:3px 10px;background:rgba(124,92,255,0.2);border:1px solid rgba(124,92,255,0.3);border-radius:5px;color:#b8a0ff;cursor:pointer;font-size:11px;">全选</button>
                    <button class="rop-export-none" style="padding:3px 10px;background:rgba(255,255,255,0.05);border:1px solid #333;border-radius:5px;color:#888;cursor:pointer;font-size:11px;">全不选</button>
                </div>
            </div>
            <div style="overflow:auto;flex:1;">${list}</div>
            <label style="padding:10px 16px;border-top:1px solid #333;color:#cbd5e1;font-size:12px;display:flex;gap:8px;align-items:flex-start;"><input class="rop-export-media" type="checkbox"> <span><b>导出预设包，并打包路径引用的媒体</b><br><span style="color:#94a3b8;font-size:11px;">会生成 ZIP 并复制图片/GIF/视频；不勾选则导出轻量 JSON。</span></span></label>
            <div style="padding:10px 16px;border-top:1px solid #333;display:flex;justify-content:space-between;align-items:center;">
                <span class="rop-export-count" style="color:#888;font-size:11px;">已选 ${exportableNames.length}/${exportableNames.length}</span>
                <div style="display:flex;gap:6px;">
                    <button class="rop-export-ok" style="padding:5px 18px;background:linear-gradient(135deg,#7c5cff,#a855f7);border:none;border-radius:5px;color:#fff;cursor:pointer;font-size:12px;font-weight:600;">导出</button>
                    <button class="rop-export-cancel" style="padding:3px 10px;background:rgba(255,255,255,0.05);border:1px solid #333;border-radius:5px;color:#888;cursor:pointer;font-size:11px;">取消</button>
                </div>
            </div>
        </div>`;
        document.body.appendChild(modal);

        const updateCount = () => {
            const checked = modal.querySelectorAll('.rop-export-cb:checked').length;
            const total = modal.querySelectorAll('.rop-export-cb').length;
            const countEl = modal.querySelector('.rop-export-count');
            if (countEl) countEl.textContent = `已选 ${checked}/${total}`;
        };
        modal.addEventListener('change', updateCount);
        modal.querySelector('.rop-export-all').onclick = () => { modal.querySelectorAll('.rop-export-cb').forEach(cb => cb.checked = true); updateCount(); };
        modal.querySelector('.rop-export-none').onclick = () => { modal.querySelectorAll('.rop-export-cb').forEach(cb => cb.checked = false); updateCount(); };
        modal.querySelector('.rop-export-cancel').onclick = () => modal.remove();
        modal.querySelector('.rop-export-ok').onclick = async () => {
            const selected = Array.from(modal.querySelectorAll('.rop-export-cb:checked')).map(cb => cb.dataset.name);
            if (selected.length === 0) { alert('请至少选择一个预设'); return; }
            const exportData = {};
            selected.forEach(name => { if (presets[name]) exportData[name] = presets[name]; });
            if (modal.querySelector('.rop-export-media').checked) {
                const result = await window.electronAPI?.exportOverlayPresetPackage?.(exportData);
                if (!result || result.canceled) return;
                if (!result.ok) { alert(`导出预设包失败：${result.error || '未知错误'}`); return; }
                alert(`✅ 已导出预设包：已收集 ${result.copied} 个媒体${result.missing?.length ? `，${result.missing.length} 个原路径文件未找到` : ''}`);
                modal.remove(); return;
            }
            const json = JSON.stringify(exportData, null, 2);
            const blob = new Blob([json], { type: 'application/json' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `overlay_group_presets_${Date.now()}.json`;
            a.click();
            URL.revokeObjectURL(a.href);
            modal.remove();
        };
    }
}

// ═══════════════════════════════════════════════
// CSS
// ═══════════════════════════════════════════════

(function injectOverlayPanelStyles() {
    if (document.getElementById('rop-styles')) return;
    const s = document.createElement('style');
    s.id = 'rop-styles';
    s.textContent = `
        .rop-panel { font-size: 12px; color: #ccc; width: 100%; box-sizing: border-box; overflow-x: hidden; }
        .rop-section { margin-bottom: 12px; width: 100%; box-sizing: border-box; }
        .rop-header { display:flex; flex-direction:column; gap:6px; align-items:stretch;
                      padding: 8px 10px; background: var(--bg-secondary, #1e1e3a);
                      border-radius: 6px 6px 0 0; font-weight: bold; font-size: 13px; box-sizing: border-box; }
        /* 新覆层的分类与新增按钮不能共用自动列：分类选择框会在窄面板中
           溢出自己的网格单元，视觉上便与“+ 文本”叠在一起。 */
        .rop-header-actions { display:flex; flex-direction:column; gap:6px; width:100%; min-width:0; box-sizing:border-box; }
        .rop-layer-slot-picker { display:flex; align-items:center; gap:6px; min-width:0; }
        .rop-layer-slot-label { flex:none; white-space:nowrap; font-size:11px; color:var(--text-muted,#a7a7b5); }
        .rop-layer-slot-picker .rop-select { flex:1; min-width:0; width:0; max-width:none; }
        .rop-header-add-actions { display:grid; grid-template-columns:repeat(auto-fit, minmax(82px, 1fr)); gap:4px; width:100%; min-width:0; }
        .rop-header-add-actions .rop-btn { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        /* 覆层面板所有普通操作按钮使用同一深色底，不能跟随系统按钮变成白底白字。 */
        .rop-panel .rop-btn,
        .rop-decoration-palette-popover .rop-btn,
        .rop-brush-gallery-popover .rop-btn {
            padding:3px 6px !important; font-size:11px !important; min-width:unset !important;
            white-space:nowrap; text-align:center; box-sizing:border-box; cursor:pointer;
            background:#242b3b; color:#e5e7eb; border:1px solid #4a5568; border-radius:4px;
            box-shadow:0 1px 2px rgba(0,0,0,.3); transition:background .15s,border-color .15s,color .15s;
        }
        .rop-panel .rop-btn:hover:not(:disabled),
        .rop-decoration-palette-popover .rop-btn:hover:not(:disabled),
        .rop-brush-gallery-popover .rop-btn:hover:not(:disabled) {
            background:#303b52; border-color:#7c8bb5; color:#fff;
        }
        .rop-panel .rop-btn:disabled,
        .rop-decoration-palette-popover .rop-btn:disabled,
        .rop-brush-gallery-popover .rop-btn:disabled { opacity:.48; cursor:not-allowed; }
        .rop-btn-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(44px, 1fr)); gap:4px; width:100%; box-sizing: border-box; }
        .rop-btn-full { width:100%; margin-top:4px; }
        .rop-btn-danger { color:var(--error) !important; }
        /* 之前固定 150px，只能显示约 4 层，属性区未展开时下方却大量留白。
           列表按内容自然长高，最多占可视窗口约一半，层多时才继续滚动。 */
        .rop-list { background:var(--bg-tertiary, #0f0f2e); border-radius:0 0 6px 6px; max-height:clamp(150px, 52vh, 520px); overflow-y:auto; box-sizing: border-box; }
        .rop-list-item { display:flex; align-items:center; gap:6px; padding:6px 10px; cursor:pointer;
                         border-bottom: 1px solid rgba(255,255,255,0.05); transition: background 0.15s; box-sizing: border-box; }
        .rop-list-item:hover { background:rgba(255,255,255,0.06); }
        .rop-list-item.selected { background:rgba(0,212,255,0.12); border-left:3px solid var(--accent); }
        .rop-list-arrow { font-size:9px; color:#666; width:10px; flex-shrink:0; }
        .rop-list-label { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .rop-list-time { font-size:10px; color:#888; font-family:monospace; white-space:nowrap; }
        .rop-list-edit-name,
        .rop-list-toggle-eye,
        .rop-list-move-up,
        .rop-list-move-down,
        .rop-list-del {
            appearance:none; -webkit-appearance:none; box-sizing:border-box;
            width:25px; height:24px; min-width:25px; padding:0;
            display:inline-flex; align-items:center; justify-content:center;
            border:1px solid rgba(255,255,255,0.18); border-radius:4px;
            background:#252838; color:#e5e7eb; cursor:pointer;
            font-family:"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif;
            font-size:12px; line-height:1; flex-shrink:0;
            transition:background 0.15s,border-color 0.15s,color 0.15s;
        }
        .rop-list-edit-name { margin-left:4px; }
        .rop-list-edit-name:hover,
        .rop-list-toggle-eye:hover,
        .rop-list-move-up:hover,
        .rop-list-move-down:hover {
            background:#3b4160; border-color:#7c8cff; color:#fff;
        }
        .rop-list-del { background:#34252b; border-color:rgba(248,113,113,0.3); color:#f87171; font-size:14px; }
        .rop-list-del:hover { background:#542d38; border-color:#f87171; color:#fff; }
        .rop-empty { padding:16px; text-align:center; color:#555; font-style:italic; }
        .rop-group { padding:8px 10px; background:var(--bg-tertiary, #0f0f2e); border-radius:6px; margin-top:8px; box-sizing: border-box; }
        .rop-group-title { font-weight:bold; font-size:11px; color:#8899bb; margin-bottom:6px; text-transform:uppercase; letter-spacing:0.5px; }
        .rop-collapsible-head { display:flex; align-items:center; justify-content:flex-start; gap:6px; }
        .rop-clickable { cursor:pointer; user-select:none; }
        .rop-collapse-icon { display:inline-flex; align-items:center; justify-content:center; width:12px; color:#c7d3eb; font-size:11px; margin-right:0; flex-shrink:0; }
        .rop-title-inline-control { margin-left:auto; display:inline-flex; align-items:center; }
        .rop-collapse-btn { flex-shrink:0; min-width:20px; height:20px; padding:0 6px; border:1px solid rgba(255,255,255,0.14);
                            border-radius:4px; background:rgba(255,255,255,0.05); color:#a7b3cc; font-size:11px; cursor:pointer; }
        .rop-collapse-btn:hover { background:rgba(255,255,255,0.1); color:#d4def0; border-color:rgba(255,255,255,0.26); }
        .rop-collapsible-group.rop-collapsed > *:not(.rop-collapsible-head) { display:none !important; }
        .rop-subsection-head { margin-bottom:4px; padding:6px 8px; border-radius:6px; border:1px solid rgba(255,255,255,0.12); }
        .rop-subsection-head[data-section-tone="1"] { background:rgba(66, 145, 255, 0.16); color:#b8d8ff; border-color:rgba(66,145,255,0.35); }
        .rop-subsection-head[data-section-tone="2"] { background:rgba(42, 201, 160, 0.14); color:#aef2dc; border-color:rgba(42,201,160,0.34); }
        .rop-subsection-head[data-section-tone="3"] { background:rgba(246, 168, 56, 0.14); color:#ffdca8; border-color:rgba(246,168,56,0.34); }
        .rop-subsection-head[data-section-tone="4"] { background:rgba(188, 118, 255, 0.16); color:#e2c9ff; border-color:rgba(188,118,255,0.34); }
        .rop-subsection-head[data-section-tone="5"] { background:rgba(255, 111, 145, 0.14); color:#ffc0d0; border-color:rgba(255,111,145,0.34); }
        .rop-subsection-head[data-section-tone="6"] { background:rgba(120, 220, 110, 0.14); color:#c9f7c3; border-color:rgba(120,220,110,0.34); }
        .rop-subsection-body { margin-bottom:6px; }
        .rop-subsection-body.rop-collapsed { display:none !important; }
        .rop-grid { display:grid; grid-template-columns: minmax(50px, auto) minmax(0, 1fr); gap:4px 8px; align-items:center; }
        .rop-grid label { font-size:11px; color:#999; text-align:right; }
        .rop-input { width:100%; min-width:0; padding:3px 6px; background:var(--bg-primary, #141414); border:1px solid var(--border-color, var(--border-color));
                     border-radius:4px; color:#ddd; font-size:11px; font-family:monospace; box-sizing:border-box; }
        .rop-input:focus { border-color:var(--accent); outline:none; }
        .rop-range { width:100%; min-width:0; }
        .rop-select { width:100%; min-width:0; padding:3px 6px; background:var(--bg-primary, #141414); border:1px solid var(--border-color, var(--border-color));
                      border-radius:4px; color:#ddd; font-size:11px; box-sizing:border-box; }
        .rop-color-combo { display:flex; align-items:center; gap:6px; width:100%; min-width:0; }
        .rop-color { width:32px; min-width:32px; height:24px; padding:0; border:1px solid var(--border-color, var(--border-color)); border-radius:4px; cursor:pointer; }
        .rop-color-hex { flex:1; min-width:0; height:24px; padding:3px 6px; background:var(--bg-primary, #141414); border:1px solid var(--border-color, var(--border-color));
                         border-radius:4px; color:#ddd; font-size:11px; font-family:monospace; text-transform:lowercase; box-sizing:border-box; }
        .rop-color-hex:focus { border-color:var(--accent); outline:none; }
        .rop-gradient-btn { flex-shrink:0; width:26px; height:24px; padding:0; border:1px solid var(--border-color, #444);
                            border-radius:4px; background:var(--bg-secondary, #222); cursor:pointer;
                            display:flex; align-items:center; justify-content:center; font-size:12px; line-height:1; }
        .rop-gradient-btn:hover { background:rgba(255,255,255,0.12); border-color:var(--accent, #7b8bef); }
        .rop-textarea { width:100%; padding:6px; background:var(--bg-primary, #141414); border:1px solid var(--border-color, var(--border-color));
                        border-radius:4px; color:#ddd; font-size:11px; resize:vertical; margin-bottom:6px; font-family:system-ui;
                        position:relative; z-index:2; pointer-events:auto; user-select:text; }
        .rop-actions { padding:8px 10px; }
        .rop-slider-combo { display:flex; align-items:center; gap:6px; width:100%; min-width:0; box-sizing:border-box; }
        .rop-slider-combo .rop-range { flex:1; min-width:0; }
        .rop-num-readout { width:52px!important; flex-shrink:0; padding:2px 4px; background:var(--bg-primary, #141414);
                           border:1px solid var(--border-color, var(--border-color)); border-radius:4px; color:#ddd;
                           font-size:11px; font-family:monospace; text-align:center; box-sizing:border-box; }
        .rop-num-readout:focus { border-color:var(--accent); outline:none; }
        .rop-reset-btn { flex-shrink:0; width:22px; height:22px; padding:0; border:1px solid rgba(255,255,255,0.1);
                         background:rgba(255,255,255,0.05); border-radius:4px; color:#888; font-size:12px;
                         cursor:pointer; display:flex; align-items:center; justify-content:center; transition:all 0.15s; }
        .rop-reset-btn:hover { background:rgba(0,212,255,0.15); color:var(--accent); border-color:rgba(0,212,255,0.3); }
        .rop-reset-all { padding:2px 8px; border:1px solid rgba(255,255,255,0.1); background:rgba(255,255,255,0.05);
                         border-radius:4px; color:#888; font-size:10px; cursor:pointer; transition:all 0.15s; white-space:nowrap; }
        .rop-reset-all:hover { background:rgba(0,212,255,0.15); color:var(--accent); border-color:rgba(0,212,255,0.3); }

        /* Preset Gallery Modal */
        .rop-gallery-modal { position:fixed; top:var(--window-chrome-height, 38px); left:0; width:100%; height:calc(100vh - var(--window-chrome-height, 38px)); background:rgba(0,0,0,0.85); z-index:350000; display:flex; align-items:center; justify-content:center; -webkit-app-region:no-drag; }
        .rop-gallery-content { width:100vw; max-width:none; height:100%; background:#131322; border-radius:0; display:flex; flex-direction:column; box-shadow:none; overflow:hidden; border:0; }
        
        .rop-gallery-header { position:relative; display:flex; flex-direction:column; background:#141424; border-bottom:1px solid rgba(255,255,255,0.08); flex-shrink:0; }
        
        .rop-gallery-top-bar { display:flex; align-items:center; justify-content:space-between; padding:8px 16px; gap:14px; min-height:46px; border-bottom:1px solid rgba(255,255,255,0.05); }
        .rop-gallery-title-area { display:flex; align-items:center; gap:8px; flex-shrink:0; }
        .rop-gallery-main-title { margin:0; font-size:15px; font-weight:700; color:#f8fafc; white-space:nowrap; }
        .rop-gallery-total-badge { font-size:11px; font-weight:600; color:#818cf8; background:rgba(99,102,241,0.15); border:1px solid rgba(99,102,241,0.3); padding:2px 8px; border-radius:12px; white-space:nowrap; }
        
        .rop-gallery-tools-area { display:flex; align-items:center; gap:12px; flex:1; justify-content:center; min-width:0; }
        .rop-gallery-tool-group { display:flex; align-items:center; gap:6px; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.07); padding:3px 8px; border-radius:6px; flex-shrink:0; }
        .rop-tool-group-label { font-size:11px; color:#94a3b8; font-weight:600; white-space:nowrap; }
        .rop-gallery-preview-bg { background:rgba(59,130,246,0.2) !important; color:#93c5fd !important; border:1px solid rgba(59,130,246,0.45) !important; padding:3px 8px !important; border-radius:4px !important; font-size:11px !important; font-weight:600 !important; cursor:pointer !important; transition:all 0.15s !important; }
        .rop-gallery-preview-bg:hover { background:rgba(59,130,246,0.35) !important; color:#fff !important; }
        .rop-gallery-preview-bg-label { max-width:90px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:11px; color:#cbd5e1; }
        .rop-gallery-preview-bg-clear { background:rgba(239,68,68,0.15) !important; color:#fca5a5 !important; border:1px solid rgba(239,68,68,0.3) !important; padding:2px 6px !important; border-radius:4px !important; font-size:11px !important; cursor:pointer !important; transition:all 0.15s !important; }
        .rop-gallery-preview-bg-clear:hover { background:rgba(239,68,68,0.3) !important; color:#fff !important; }
        
        .rop-tool-divider { width:1px; height:18px; background:rgba(255,255,255,0.1); flex-shrink:0; }
        
        .rop-gallery-preview-copy { display:flex; align-items:center; gap:6px; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.07); padding:3px 8px; border-radius:6px; flex-shrink:0; }
        .rop-preview-input-wrap { display:flex; align-items:center; background:#0b0f19; border:1px solid #334155; border-radius:4px; overflow:hidden; padding-right:4px; transition:border-color 0.15s; }
        .rop-preview-input-wrap:focus-within { border-color:#6366f1; }
        .rop-input-tag { font-size:10px; font-weight:600; color:#818cf8; background:rgba(99,102,241,0.18); padding:3px 5px; line-height:1; user-select:none; border-right:1px solid #334155; }
        .rop-preview-input-wrap input { width:96px; padding:3px 6px; background:transparent !important; color:#f1f5f9 !important; border:none !important; font-size:11px; outline:none; }
        .rop-preview-input-wrap input::placeholder { color:#64748b; }
        .rop-preview-copy-btn { background:none; border:none; cursor:pointer; padding:0 1px; font-size:11px; line-height:1; opacity:0.7; transition:opacity 0.15s; }
        .rop-preview-copy-btn:hover { opacity:1; }
        
        .rop-gallery-actions-area { display:flex; align-items:center; gap:10px; flex-shrink:0; }
        .rop-gallery-clear-custom { background:rgba(239,68,68,0.12) !important; color:#fca5a5 !important; border:1px solid rgba(239,68,68,0.28) !important; padding:4px 10px !important; border-radius:6px !important; font-size:11px !important; font-weight:500 !important; cursor:pointer !important; transition:all 0.15s !important; }
        .rop-gallery-clear-custom:hover { background:rgba(239,68,68,0.25) !important; color:#fff !important; border-color:rgba(239,68,68,0.5) !important; }
        .rop-gallery-close { width:28px; height:28px; border-radius:6px; background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.12); color:#cbd5e1; font-size:14px; cursor:pointer; display:flex; align-items:center; justify-content:center; transition:all 0.15s; margin:0; }
        .rop-gallery-close:hover { background:rgba(239,68,68,0.3); border-color:#ef4444; color:#fff; }
        
        .rop-gallery-add-selected {
            background: linear-gradient(135deg, #7c5cff, #6366f1) !important;
            color: #ffffff !important;
            border: 1px solid rgba(167, 139, 250, 0.45) !important;
            padding: 5px 14px !important;
            border-radius: 6px !important;
            font-size: 11.5px !important;
            font-weight: 600 !important;
            cursor: pointer !important;
            display: inline-flex !important;
            align-items: center !important;
            gap: 5px !important;
            box-shadow: 0 2px 8px rgba(124, 92, 255, 0.35) !important;
            transition: all 0.18s ease !important;
        }
        .rop-gallery-add-selected:hover {
            background: linear-gradient(135deg, #8b5cf6, #7c3aed) !important;
            border-color: rgba(196, 181, 253, 0.7) !important;
            box-shadow: 0 4px 14px rgba(124, 92, 255, 0.55) !important;
            transform: translateY(-1px);
        }
        .rop-gallery-add-selected:active {
            transform: translateY(0);
        }
        .rop-gallery-add-selected.is-empty {
            background: rgba(124, 92, 255, 0.15) !important;
            color: #c4b5fd !important;
            border-color: rgba(124, 92, 255, 0.3) !important;
            box-shadow: none !important;
            opacity: 0.85;
        }
        .rop-gallery-tab-added {
            background: rgba(16, 185, 129, 0.12) !important;
            color: #6ee7b7 !important;
            border: 1px solid rgba(16, 185, 129, 0.28) !important;
        }
        .rop-gallery-tab-added:hover {
            background: rgba(16, 185, 129, 0.22) !important;
            color: #fff !important;
        }
        .rop-gallery-tab-added.active {
            background: #059669 !important;
            color: #ffffff !important;
            border-color: #10b981 !important;
            box-shadow: 0 2px 6px rgba(5, 150, 105, 0.4) !important;
        }
        .rop-gallery-tab-unadded {
            background: rgba(124, 92, 255, 0.1) !important;
            color: #c4b5fd !important;
            border: 1px solid rgba(124, 92, 255, 0.25) !important;
        }
        .rop-gallery-tab-unadded:hover {
            background: rgba(124, 92, 255, 0.2) !important;
            color: #fff !important;
        }
        .rop-gallery-tab-unadded.active {
            background: #6366f1 !important;
            color: #ffffff !important;
            border-color: #818cf8 !important;
            box-shadow: 0 2px 6px rgba(99, 102, 241, 0.4) !important;
        }
        
        /* 第二行：分类与特性导航 */
        .rop-gallery-nav-bar { display:flex; align-items:center; padding:6px 16px; background:#0c0d18; overflow-x:auto; scrollbar-width:none; border-bottom:1px solid rgba(255,255,255,0.04); }
        .rop-gallery-nav-bar::-webkit-scrollbar { display:none; }
        .rop-gallery-tabs { display:flex; align-items:center; gap:6px; flex-wrap:nowrap; background:transparent; padding:0; border:none; width:auto; }
        .rop-tab-group { display:flex; align-items:center; gap:3px; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.06); padding:2px 4px; border-radius:8px; flex-shrink:0; }
        .rop-nav-divider { width:1px; height:18px; background:rgba(255,255,255,0.1); margin:0 4px; flex-shrink:0; }
        
        .rop-gallery-tab { flex:0 0 auto; white-space:nowrap; background:transparent; border:none; color:#94a3b8; font-size:12px; padding:5px 9px; border-radius:6px; cursor:pointer; transition:all 0.15s; line-height:1.2; display:flex; align-items:center; gap:5px; }
        .rop-gallery-tab:hover { color:#f8fafc; background:rgba(255,255,255,0.06); }
        .rop-gallery-tab.active { background:#4338ca !important; color:#ffffff !important; font-weight:600; box-shadow:0 2px 6px rgba(67,56,202,0.4); }
        .rop-tab-num { font-size:10px; padding:1px 5px; border-radius:10px; background:rgba(255,255,255,0.08); color:#cbd5e1; font-weight:normal; }
        .rop-gallery-tab.active .rop-tab-num { background:rgba(255,255,255,0.25); color:#fff; font-weight:600; }
        .rop-library-preview-note { margin-top:8px; padding:7px 9px; border:1px solid #334155; border-radius:6px; background:#111827; color:#93c5fd; font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .rop-library-preview-note span { color:#e2e8f0; }
        
        .rop-gallery-main { display:flex; flex:1; overflow:hidden; height:100%; }
        .rop-gallery-sidebar { width:260px; min-width:160px; max-width:650px; background:#0f0f1d; border-right:none; overflow-y:auto; padding:12px; display:flex; flex-direction:column; gap:4px; flex-shrink:0; }
        .rop-gallery-resizer {
            width: 6px;
            background: rgba(255, 255, 255, 0.05);
            border-left: 1px solid rgba(255, 255, 255, 0.08);
            border-right: 1px solid rgba(0, 0, 0, 0.4);
            cursor: col-resize;
            flex-shrink: 0;
            transition: background 0.15s, box-shadow 0.15s;
            position: relative;
            z-index: 5;
        }
        .rop-gallery-resizer:hover, .rop-gallery-resizer.dragging {
            background: var(--accent, #7c5cff) !important;
            box-shadow: 0 0 8px rgba(124, 92, 255, 0.6);
        }
        .rop-gallery-sidebar-item { padding:8px 10px; color:#aaa; cursor:pointer; border-radius:6px; font-size:13px; text-overflow:ellipsis; overflow:hidden; white-space:nowrap; transition:background 0.15s, color 0.15s; border:1px solid transparent; }
        .rop-gallery-sidebar-item:hover { background:rgba(255,255,255,0.05); color:#fff; border-color:#333; }
        .rop-gallery-sidebar-item.active { background:#3a3a5c; color:#fff; font-weight:bold; border-color:#555; }
        
        .rop-gallery-body { flex:1; overflow-y:auto; padding:20px; scroll-behavior:smooth; }
        .rop-gallery-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(250px, 1fr)); gap:20px; }
        
        .rop-gallery-card { background:#24243e; border-radius:8px; overflow:hidden; border:1px solid #3a3a5c; display:flex; flex-direction:column; transition:transform 0.2s, box-shadow 0.2s; }
        .rop-gallery-card:hover { transform:translateY(-4px); box-shadow:0 8px 24px rgba(0,0,0,0.5); border-color:#7b8bef; }
        .rop-gallery-card.is-already-added {
            border-color: rgba(52, 211, 153, 0.45) !important;
            background: linear-gradient(180deg, rgba(16, 185, 129, 0.08) 0%, #24243e 35%) !important;
        }
        .rop-gallery-card.is-already-added:hover {
            border-color: #34d399 !important;
            box-shadow: 0 8px 24px rgba(16, 185, 129, 0.25) !important;
        }
        .rop-gallery-sidebar-item.is-already-added {
            color: #a7f3d0 !important;
        }
        
        .rop-gallery-thumb, .rop-gallery-thumb-placeholder { width:100%; aspect-ratio:9/16; object-fit:contain; background:#000; border-bottom:1px solid #333; }
        .rop-gallery-thumb-placeholder { display:flex; align-items:center; justify-content:center; color:#555; font-size:14px; }
        
        .rop-gallery-info { padding:12px; display:flex; flex-direction:column; flex:1; gap:8px; }
        .rop-gallery-title-row { display:flex; justify-content:space-between; align-items:center; gap:8px; }
        .rop-gallery-title { font-weight:bold; color:#fff; font-size:14px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; flex:1; }
        .rop-gallery-delete-btn { background:none; border:none; color:#888; font-size:14px; cursor:pointer; padding:0 4px; transition:color 0.2s; }
        .rop-gallery-delete-btn:hover { color:#ff4444; }
        
        .rop-gallery-tags { display:flex; flex-wrap:wrap; gap:4px; }
        .rop-badge { padding:2px 6px; border-radius:4px; font-size:10px; font-weight:600; }
        .rop-badge-already-added {
            background: rgba(16, 185, 129, 0.22) !important;
            color: #34d399 !important;
            border: 1px solid rgba(52, 211, 153, 0.45) !important;
            font-weight: 600 !important;
        }
        .rop-badge.builtin { background:#3a3a5c; color:#a7b3cc; }
        .rop-badge.count { background:#7b8bef33; color:#7b8bef; }
        .rop-badge.fixed { background:#e8b83933; color:#e8b839; }
        .rop-badge.batch { background:#a3e86c33; color:#a3e86c; }
        .rop-badge.type { background:#38bdf833; color:#7dd3fc; border:1px solid #38bdf855; }
        
        .rop-badge-category { font-weight:700 !important; font-size:11px !important; padding:2px 7px !important; border-radius:4px !important; display:inline-flex !important; align-items:center !important; gap:3px !important; letter-spacing:0.2px; }
        .rop-badge-category.cat-text { background:rgba(16,185,129,0.22) !important; color:#34d399 !important; border:1px solid rgba(16,185,129,0.45) !important; }
        .rop-badge-category.cat-card { background:rgba(59,130,246,0.22) !important; color:#60a5fa !important; border:1px solid rgba(59,130,246,0.45) !important; }
        .rop-badge-category.cat-brush { background:rgba(236,72,153,0.22) !important; color:#f472b6 !important; border:1px solid rgba(236,72,153,0.45) !important; }
        .rop-badge-category.cat-scroll { background:rgba(245,158,11,0.22) !important; color:#fbbf24 !important; border:1px solid rgba(245,158,11,0.45) !important; }
        .rop-badge-category.cat-combo { background:rgba(236,72,153,0.22) !important; color:#f472b6 !important; border:1px solid rgba(236,72,153,0.45) !important; }
        .rop-badge-category.cat-media { background:rgba(168,85,247,0.22) !important; color:#c084fc !important; border:1px solid rgba(168,85,247,0.45) !important; }
        .rop-badge-category.cat-split { background:rgba(6,182,212,0.22) !important; color:#22d3ee !important; border:1px solid rgba(6,182,212,0.45) !important; }
        .rop-badge-category.cat-mask { background:rgba(244,63,94,0.22) !important; color:#fb7185 !important; border:1px solid rgba(244,63,94,0.45) !important; }
        
        .rop-badge-fullscreen { font-weight:600 !important; font-size:10px !important; padding:2px 6px !important; border-radius:4px !important; display:inline-flex !important; align-items:center !important; gap:2px !important; }
        .rop-badge-fullscreen.yes { background:rgba(99,102,241,0.22) !important; color:#a5b4fc !important; border:1px solid rgba(99,102,241,0.45) !important; }
        .rop-badge-fullscreen.no { background:rgba(148,163,184,0.14) !important; color:#94a3b8 !important; border:1px solid rgba(148,163,184,0.28) !important; }
        
        .rop-badge-custom-group { font-weight:600 !important; font-size:10px !important; padding:2px 6px !important; border-radius:4px !important; display:inline-flex !important; align-items:center !important; gap:2px !important; background:rgba(16,185,129,0.18) !important; color:#6ee7b7 !important; border:1px solid rgba(16,185,129,0.38) !important; cursor:pointer !important; transition:all 0.15s !important; }
        .rop-badge-custom-group:hover { background:rgba(16,185,129,0.35) !important; color:#fff !important; }
        
        .rop-sidebar-group-header { padding:0 0 8px 0; border-bottom:1px solid rgba(255,255,255,0.08); margin-bottom:4px; flex-shrink:0; }
        .rop-sidebar-group-select { width:100%; box-sizing:border-box; padding:6px 8px; border-radius:6px; background:#18182b; border:1px solid #3b3b5c; color:#e2e8f0; font-size:12px; outline:none; cursor:pointer; transition:border-color 0.15s; }
        .rop-sidebar-group-select:hover, .rop-sidebar-group-select:focus { border-color:#6366f1; }
        
        .rop-gallery-tab-group { background:rgba(16,185,129,0.1) !important; color:#6ee7b7 !important; border:1px solid rgba(16,185,129,0.25) !important; }
        .rop-gallery-tab-group:hover { background:rgba(16,185,129,0.22) !important; color:#fff !important; }
        .rop-gallery-tab-group.active { background:#059669 !important; color:#ffffff !important; border-color:#10b981 !important; box-shadow:0 2px 6px rgba(5,150,105,0.4) !important; }
        
        .rop-gallery-tab-builtin { background:rgba(99,102,241,0.12) !important; color:#a5b4fc !important; border:1px solid rgba(99,102,241,0.28) !important; }
        .rop-gallery-tab-builtin:hover { background:rgba(99,102,241,0.22) !important; color:#fff !important; }
        .rop-gallery-tab-builtin.active { background:#4f46e5 !important; color:#ffffff !important; border-color:#6366f1 !important; box-shadow:0 2px 6px rgba(79,70,229,0.4) !important; }
        
        .rop-sidebar-cat-pill { font-size:10px; padding:1px 4px; border-radius:3px; margin-right:5px; font-weight:600; display:inline-block; flex-shrink:0; }
        .rop-sidebar-cat-pill.cat-text { background:rgba(16,185,129,0.25); color:#34d399; }
        .rop-sidebar-cat-pill.cat-card { background:rgba(59,130,246,0.25); color:#60a5fa; }
        .rop-sidebar-cat-pill.cat-brush { background:rgba(236,72,153,0.25); color:#f472b6; }
        .rop-sidebar-cat-pill.cat-scroll { background:rgba(245,158,11,0.25); color:#fbbf24; }
        .rop-sidebar-cat-pill.cat-combo { background:rgba(236,72,153,0.25); color:#f472b6; }
        .rop-sidebar-cat-pill.cat-media { background:rgba(168,85,247,0.25); color:#c084fc; }
        .rop-sidebar-cat-pill.cat-split { background:rgba(6,182,212,0.25); color:#22d3ee; }
        .rop-sidebar-cat-pill.cat-mask { background:rgba(244,63,94,0.25); color:#fb7185; }
        
        .rop-gallery-actions { display:flex; flex-direction:column; gap:6px; margin-top:auto; }
        .rop-gallery-actions .rop-btn { width:100%; text-align:center; padding:6px 0 !important; font-size:12px !important; border:1px solid #444; border-radius:4px; cursor:pointer; transition:all 0.2s; background:#333; color:#ccc; }
        .rop-gallery-actions .rop-btn.keep { background:#7b8bef22; border-color:#7b8bef; color:#7b8bef; }
        .rop-gallery-actions .rop-btn.use { background:#a3e86c22; border-color:#a3e86c; color:#a3e86c; }
        .rop-gallery-actions .rop-btn.clear { background:#e8b83922; border-color:#e8b839; color:#e8b839; }
        .rop-gallery-actions .rop-btn:hover { filter:brightness(1.5); }
        @media (max-width: 980px) {
            .rop-gallery-content { width:100vw; height:100%; }
            .rop-gallery-top-bar { flex-wrap:wrap; gap:8px; padding:8px 12px; }
            .rop-gallery-tools-area { order:3; width:100%; justify-content:flex-start; overflow-x:auto; }
            .rop-gallery-sidebar { width:150px; }
            .rop-gallery-body { padding:12px; }
            .rop-gallery-grid { grid-template-columns:repeat(auto-fill, minmax(205px, 1fr)); gap:12px; }
        }
        @keyframes ropFadeIn {
            from { opacity: 0; transform: scale(0.96); }
            to { opacity: 1; transform: scale(1); }
        }
        .rop-preset-choice-modal {
            user-select: none;
            -webkit-app-region: no-drag;
        }
        .rop-preset-choice-box {
            animation: ropFadeIn 0.16s cubic-bezier(0.16, 1, 0.3, 1);
        }
    `;
    document.head.appendChild(s);
})();

// Export
if (typeof window !== 'undefined') window.ReelsOverlayPanel = ReelsOverlayPanel;
