/**
 * reels-layout-editor.js — 布局方案编辑器 + 批量建任务
 *
 * 以空白任务或当前选中任务为底板，按布局方案（讲道 / 主观众 / 观众 / 电话层 / 标题 / 底衬）
 * 在当前标签页批量生成任务。支持统一与随机两种模式；媒体替换仍走现有总览。
 * 布局计算全部在 ReelsLayoutTemplate（纯逻辑）中完成。
 */
(function () {
    'use strict';
    const STORE_KEY = 'videokit_layout_schemes_v1';
    const LAST_KEY = 'videokit_layout_scheme_last_v1';
    const PREVIEW_W = 342, PREVIEW_H = 608;
    const scaleFor = scheme => PREVIEW_W / L().canvasWidth(scheme);
    const ROLE_COLORS = { sermon: '#2f6fed', main: '#f59e0b', audience: '#16a34a', extra: '#0d9488' };
    const L = () => window.ReelsLayoutTemplate;
    const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const clone = v => JSON.parse(JSON.stringify(v));
    const phoneLabel = phone => {
        const label = phone.role === 'phone_secondary' ? '电话次层' : '电话主层';
        const number = String(phone.key || '').match(/_(\d+)$/)?.[1];
        return number ? `${label} ${number}` : label;
    };
    const toast = (msg, type = 'success') => (typeof showToast === 'function' ? showToast(msg, type) : console.log('[LayoutBatch]', msg));

    let st = null;

    // ── 方案库（本地持久化） ──
    function loadLibrary() {
        try { const list = JSON.parse(localStorage.getItem(STORE_KEY) || '[]'); return Array.isArray(list) ? list : []; } catch (_) { return []; }
    }
    function saveLibrary(list) { localStorage.setItem(STORE_KEY, JSON.stringify(list)); }

    // ── 底板任务 ──
    function baseTask() {
        const state = window._reelsState;
        const tasks = state?.tasks || [];
        const task = tasks[state?.selectedIdx] || tasks[0] || null;
        const mgr = state?.overlayProxy?.overlayMgr;
        // 选中任务的覆层正在编辑器中，先写回任务，避免取到旧覆层。
        if (task && mgr && mgr._reelsTaskOwner === task && !state._coverEditMode && Array.isArray(mgr.overlays)) task.overlays = [...mgr.overlays];
        return task;
    }

    // 空白底板：不依赖任务列表，只含布局生成的层；有标题时自动补一张标题卡片。
    function blankTask() {
        if (typeof _createEmptyTask === 'function' && window._reelsState) {
            try { const t = _createEmptyTask(); t.overlays = []; return t; } catch (_) { /* 退回本地构造 */ }
        }
        return { baseName: 'layout', fileName: 'layout.mp4', bgPath: null, bgSrcUrl: null, audioPath: null, srtPath: null,
            segments: [], videoPath: null, srcUrl: null, overlays: [], ttsText: '', ttsVoiceId: '', pipPath: '', status: '' };
    }
    function resolveBase() {
        if (st?.baseMode === 'blank') return blankTask();
        return baseTask() || blankTask();
    }
    function ensureTitleLayer(task, scheme) {
        if (!scheme.title?.enabled || L().findTitleLayer(task.overlays || [], scheme.title.layerKey)) return;
        const make = window.ReelsOverlay?.createTextCardOverlay;
        const ov = make ? make({ x: 40, y: 860, w: 1000, h: 200, title_text: '标题文字', body_text: '', card_color: '#FFFFFF', card_opacity: 92,
            radius_tl: 16, radius_tr: 16, radius_bl: 16, radius_br: 16, padding_top: 30, padding_bottom: 30, title_fontsize: 64 })
            : { id: 'ov_' + Date.now().toString(36), type: 'textcard', x: 40, y: 860, w: 1000, h: 200, title_text: '标题文字', body_text: '', start: 0, end: 9999 };
        ov.name = '标题';
        if (window.ReelsLayerSlots?.apply) window.ReelsLayerSlots.apply(ov, 'title', '仅标题层'); else ov.slotKey = 'title';
        (task.overlays = task.overlays || []).push(ov);
    }

    // ── 样式 ──
    function injectStyle() {
        if (document.getElementById('lt-style')) return;
        const css = `
#lt-modal{position:fixed;inset:0;z-index:10050;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;font-size:12px;color:#e5e7eb}
#lt-modal .lt-box{width:min(1540px,98vw);height:96vh;background:#171a22;border:1px solid #2d3343;border-radius:12px;display:flex;flex-direction:column;overflow:hidden}
#lt-modal .lt-head{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid #2d3343}
#lt-modal .lt-head h3{margin:0;font-size:15px;flex:1}
#lt-modal .lt-body{flex:1;display:flex;min-height:0}
#lt-modal .lt-left{width:${PREVIEW_W + 36}px;padding:14px;border-right:1px solid #2d3343;display:flex;flex-direction:column;gap:8px;overflow:auto}
#lt-modal .lt-right{flex:1;overflow:auto;padding:10px 14px}
#lt-modal .lt-canvas{position:relative;width:${PREVIEW_W}px;height:${PREVIEW_H}px;background:#0b0d12;border:1px solid #394055;overflow:hidden;user-select:none;flex:none}
#lt-modal .lt-block{position:absolute;box-sizing:border-box;border:1px solid rgba(255,255,255,.35);display:flex;align-items:center;justify-content:center;text-align:center;color:#fff;font-size:11px;font-weight:600;cursor:pointer;text-shadow:0 1px 2px #000;opacity:.88}
#lt-modal .lt-block.sel{outline:2px solid #fff;outline-offset:-2px;opacity:1;z-index:3}
#lt-modal .lt-seam{position:absolute;z-index:5;background:rgba(255,255,255,.0)}
#lt-modal .lt-seam:hover,#lt-modal .lt-seam.drag{background:rgba(255,255,255,.55)}
#lt-modal .lt-seam.h{cursor:col-resize;width:10px;margin-left:-5px}
#lt-modal .lt-seam.v{cursor:row-resize;height:10px;margin-top:-5px}
#lt-modal .lt-phone{position:absolute;z-index:6;box-sizing:border-box;border:2px dashed #e879f9;background:rgba(232,121,249,.08);pointer-events:none}
#lt-modal .lt-phone.sel{border-style:solid;background:rgba(232,121,249,.18)}
#lt-modal .lt-phone.has-image{background:transparent}
#lt-modal .lt-phone-image{position:absolute;z-index:6;object-fit:contain;pointer-events:none;user-select:none}
#lt-modal .lt-phone span{position:absolute;left:0;top:0;background:#e879f9;color:#111;font-size:10px;font-weight:600;padding:1px 5px;cursor:move;pointer-events:auto;white-space:nowrap}
#lt-modal .lt-phone i,#lt-modal .lt-full-phone-resize{position:absolute;right:0;bottom:0;width:12px;height:12px;background:#e879f9;cursor:nwse-resize;pointer-events:auto;z-index:9;touch-action:none}
#lt-modal .lt-phone-badge{position:absolute;right:4px;z-index:8;background:rgba(17,17,17,.72);color:#f5d0fe;border:1px solid rgba(232,121,249,.6);border-radius:10px;font-size:10px;padding:1px 7px;cursor:move;white-space:nowrap}
#lt-modal .lt-fullx{position:absolute;left:4px;z-index:8;background:rgba(17,17,17,.72);color:#99f6e4;border:1px solid rgba(45,212,191,.6);border-radius:10px;font-size:10px;padding:1px 7px;pointer-events:none;white-space:nowrap}
#lt-modal .lt-title{position:absolute;left:0;right:0;z-index:7;height:12px;margin-top:-6px;cursor:ns-resize;touch-action:none}
#lt-modal .lt-title::before{content:'';position:absolute;left:0;right:0;top:5px;border-top:2px dashed #fde047}
#lt-modal .lt-title span{position:absolute;left:4px;top:-11px;background:#fde047;color:#000;font-size:10px;padding:0 4px;border-radius:3px}
#lt-modal .lt-areaframe{position:absolute;border:1px dashed rgba(255,255,255,.4);pointer-events:none;z-index:4}
#lt-modal .lt-sec{border:1px solid #2d3343;border-radius:8px;margin-bottom:10px}
#lt-modal .lt-sec>h4{margin:0;padding:7px 10px;font-size:12px;background:#1f2430;border-radius:8px 8px 0 0}
#lt-modal .lt-sec>div{padding:8px 10px;display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center}
#lt-modal label{display:inline-flex;align-items:center;gap:5px}
#lt-modal input[type=number]{width:64px}
#lt-modal input,#lt-modal select{background:#0f1218;color:#e5e7eb;border:1px solid #394055;border-radius:5px;padding:3px 5px;font-size:12px}
#lt-modal button{background:#2a3142;color:#e5e7eb;border:1px solid #3c4559;border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer}
#lt-modal button.pri{background:linear-gradient(135deg,#7c5cff,#a855f7);border:none;color:#fff;font-weight:600}
#lt-modal button:disabled{opacity:.45;cursor:not-allowed}
#lt-modal .lt-warn{color:#fbbf24;width:100%}
#lt-modal .lt-hint{color:#8b93a7;width:100%;font-size:11px}
#lt-modal .lt-thumbs{display:grid;grid-template-columns:repeat(auto-fill,minmax(64px,1fr));gap:8px;width:100%;max-height:260px;overflow:auto}
#lt-modal .lt-thumb{position:relative;width:64px;height:114px;background:#0b0d12;border:1px solid #394055}
#lt-modal .lt-thumb b{position:absolute;box-sizing:border-box;border:1px solid rgba(0,0,0,.5)}
#lt-modal .lt-thumb em{position:absolute;left:0;right:0;height:0;border-top:2px solid #fde047}
#lt-modal .lt-thumb s{position:absolute;background:#e879f9;opacity:.8}
#lt-modal .lt-ctx{position:fixed;z-index:10060;background:#1f2430;border:1px solid #3c4559;border-radius:8px;padding:4px;min-width:170px;box-shadow:0 8px 24px rgba(0,0,0,.5)}
#lt-modal .lt-ctx button{display:block;width:100%;text-align:left;border:none;background:transparent;padding:6px 10px;border-radius:5px}
#lt-modal .lt-ctx button:hover{background:#343c50}
#lt-modal .lt-ctx hr{border:none;border-top:1px solid #343c50;margin:4px 0}
#lt-modal .lt-ctx b{display:block;padding:4px 10px;color:#8b93a7;font-weight:500;font-size:11px}
#lt-modal .lt-gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(92px,1fr));gap:10px;width:100%}
#lt-modal .lt-card{background:#11141b;border:1px solid #2d3343;border-radius:8px;padding:6px;cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:4px;text-align:center;font-size:11px;line-height:1.3}
#lt-modal .lt-card:hover{border-color:#7c5cff}
#lt-modal .lt-card.cur{border-color:#a855f7;box-shadow:0 0 0 1px #a855f7}
#lt-modal .lt-card .lt-thumb{pointer-events:none}
#lt-modal .lt-phone-row{width:100%;display:flex;gap:6px;align-items:center;flex-wrap:wrap}
#lt-modal .lt-phone-row input[type=number]{width:56px}
#lt-modal .lt-review-tools{position:sticky;top:-10px;z-index:15;display:flex;align-items:center;flex-wrap:wrap;gap:10px;background:#222936;padding:10px;border-radius:7px;margin-bottom:10px}
#lt-modal .lt-review-focus .lt-left{display:none}
#lt-modal .lt-review-focus #lt-panel>.lt-sec:not(.lt-final),#lt-modal .lt-review-focus #lt-panel>details{display:none}
#lt-modal .lt-grid-handles{position:absolute;inset:0;pointer-events:none;z-index:5;touch-action:none}
#lt-modal .lt-grid-seam{position:absolute;pointer-events:auto;background:#60a5fa99;touch-action:none}
#lt-modal .lt-grid-seam.h{width:10px;margin-left:-5px;cursor:col-resize;border-left:1px solid #bfdbfe}
#lt-modal .lt-grid-seam.v{height:10px;margin-top:-5px;cursor:row-resize;border-top:1px solid #bfdbfe}
#lt-modal .lt-grid-phone{position:absolute;box-sizing:border-box;border:1px dashed #e879f9}
#lt-modal .lt-grid-tag{position:absolute;pointer-events:auto;font-size:11px;line-height:22px;padding:0 6px;cursor:move;touch-action:none;border-radius:4px;z-index:8;user-select:none}
#lt-modal .lt-grid-tag.phone{background:#b548d4;color:white}
#lt-modal .lt-grid-tag.title{background:#fde047;color:#111;transform:translateY(-50%)}
#lt-modal .lt-grid-resize{position:absolute;width:14px;height:14px;background:#e879f9;transform:translate(-100%,-100%);cursor:nwse-resize;pointer-events:auto;touch-action:none;z-index:8}`;
        const el = document.createElement('style');
        el.id = 'lt-style';
        // Share descendant controls only: the modal's fixed, full-screen root
        // must never apply to an existing V2 stage or overview task card.
        el.textContent = css.replaceAll('#lt-modal ', ':is(#lt-modal,.lt-inline-layout) ');
        document.head.appendChild(el);
    }

    // ── 打开 ──
    function open(options = {}) {
        if (!L()) { alert('布局模板模块未加载'); return; }
        injectStyle();
        close();
        const lib = loadLibrary();
        const lastId = localStorage.getItem(LAST_KEY);
        const saved = lib.find(s => s.id === lastId) || lib[0];
        st = { scheme: saved ? L().hydrateScheme(saved) : Object.assign(L().hydrateScheme(builtins()[0]), { id: `layout_${Date.now().toString(36)}`, fromPreset: builtins()[0].id }), selectedId: '', phoneSel: -1, thumbs: null, count: 10, mode: 'pool', output: baseTask() ? 'modify' : 'append', scope: 'checked', plans: null, pickFor: null, editingPlan: null, mainScheme: null, poolDist: 'even', generated: [], selectedTemplates: [], randomCount: 10, generation: 0, previewRequested: false, fixedRandomSeed: false, prefix: '', baseMode: baseTask() ? 'current' : 'blank' };
        if (options.scheme) {
            st.scheme = clone(options.scheme); st.mainScheme = clone(options.scheme);
            st.editingPlan = 0; st.plans = [clone(options.scheme)]; st.onLayoutDone = options.onDone; st.editLabel = options.label;
        }
        const modal = document.createElement('div');
        modal.id = 'lt-modal';
        modal.innerHTML = `<div class="lt-box">
            <div class="lt-head"><h3>🧱 布局批量 · 选择布局 → 分配任务</h3>
                <span class="lt-hint" style="width:auto" id="lt-base-hint"></span>
                <button data-act="close">✕ 关闭</button></div>
            <div class="lt-body"><div class="lt-left">
                <button data-act="savecurrent">⭐ 保存预设</button>
                <button data-act="copylayout" title="复制当前布局各层的位置和尺寸，标题仅复制位置">📋 复制当前布局参数</button>
                <button data-act="exportskill" title="将当前布局各层的位置、尺寸与结构一键生成 AI 复刻渲染 Skill（不含素材）">⚡ 生成 Skill</button>
                <div class="lt-canvas" id="lt-canvas"></div>
                <div class="lt-hint">点击色块选中，右键可改为讲道/主观众/观众、拆分、删除或添加电话层；拖动色块之间的分割线调整相邻两块；紫色虚线框为电话层，可拖动、四角缩放（按住 Shift 自由调整宽高）；黄色虚线为标题中心线。</div>
            </div><div class="lt-right" id="lt-panel"></div></div></div>`;
        document.body.appendChild(modal);
        modal.addEventListener('click', onClick);
        modal.addEventListener('change', onChange);
        modal.addEventListener('toggle', event => {
            if (!event.target.isConnected) return;
            if (event.target.matches?.('[data-generator-settings]')) st.generatorSettingsOpen = event.target.open;
            if (event.target.matches?.('[data-layout-parameters]')) st.parametersOpen = event.target.open;
        }, true);
        modal.addEventListener('input', onInput);
        modal.addEventListener('pointerdown', startNumberScrub);
        modal.querySelector('#lt-canvas').addEventListener('pointerdown', onPointerDown);
        modal.querySelector('#lt-canvas').addEventListener('contextmenu', onContextMenu);
        modal.addEventListener('pointerdown', e => { if (!e.target.closest('.lt-ctx')) closeMenu(); }, true);
        modal.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenu(); });
        render();
    }
    function close() { releaseGridPreview(); activeFramePreview?.dispose(); expandedPreview?.dispose(); frameObserver?.disconnect(); frameCache.clear(); document.getElementById('lt-frame-view')?.remove(); document.getElementById('lt-modal')?.remove(); }

    // ── 渲染 ──
    function render() { renderCanvas(); renderPanel(); }
    function nodeRects(scheme, blocks) {
        const rects = new Map();
        L().leaves(scheme.tree);
        const add = (id, b) => {
            const r = rects.get(id);
            if (!r) rects.set(id, { x: b.x, y: b.y, x2: b.x + b.w, y2: b.y + b.h });
            else { r.x = Math.min(r.x, b.x); r.y = Math.min(r.y, b.y); r.x2 = Math.max(r.x2, b.x + b.w); r.y2 = Math.max(r.y2, b.y + b.h); }
        };
        blocks.forEach(b => { add(b.id, b); b.path.forEach(id => add(id, b)); });
        return rects;
    }
    function renderCanvas() {
        const el = document.getElementById('lt-canvas');
        if (!el) return;
        const s = st.scheme, T = L();
        el.style.height = `${T.canvasHeight(s) * scaleFor(s)}px`;
        const blocks = T.computeBlocks(s);
        const px = v => `${Math.round(v * scaleFor(s) * 10) / 10}px`;
        let html = '';
        const bd = s.backdrop || {};
        el.style.background = bd.mode === 'color' ? (bd.color || '#000') : bd.mode === 'media' ? '#3b2f4a' : '#0b0d12';
        const area = T.areaRect(s);
        html += `<div class="lt-areaframe" style="left:${px(area.x)};top:${px(area.y)};width:${px(area.w)};height:${px(area.h)}"></div>`;
        blocks.forEach(b => {
            html += `<div class="lt-block${b.id === st.selectedId ? ' sel' : ''}" data-block="${b.id}" style="left:${px(b.x)};top:${px(b.y)};width:${px(b.w)};height:${px(b.h)};background:${ROLE_COLORS[b.role]}">${esc(b.label.replace('画中画', ''))}<br>${Math.round(b.area / (area.w * area.h) * 100)}%</div>`;
        });
        // 分割线手柄
        const rects = nodeRects(s, blocks);
        const gap = Number(s.gap) || 0;
        T.leaves(s.tree);
        (function walk(node) {
            if (!node?.children?.length) return;
            node.children.forEach((child, i) => {
                if (i === node.children.length - 1) return;
                const a = rects.get(child.id), p = rects.get(node.id);
                if (!a || !p) return;
                if (node.dir === 'h') html += `<div class="lt-seam h" data-seam="${node.id}:${i}" style="left:${px(a.x2 + gap / 2)};top:${px(p.y)};height:${px(p.y2 - p.y)}"></div>`;
                else html += `<div class="lt-seam v" data-seam="${node.id}:${i}" style="top:${px(a.y2 + gap / 2)};left:${px(p.x)};width:${px(p.x2 - p.x)}"></div>`;
            });
            node.children.forEach(walk);
        })(s.tree);
        // 全屏额外媒体层（只显示提示框，不拦截点击）
        (s.extras || []).filter(e => e.mode !== 'split').forEach((e, i) => {
            html += `<span class="lt-fullx" style="bottom:${4 + i * 20}px">▣ ${esc(e.name)} · 全屏${e.layer === 'below' ? '（块下方）' : '（块上方）'}</span>`;
        });
        // 电话层
        (s.phones || []).forEach((p, i) => {
            if (p.content) {
                const source = window.electronAPI?.toFileUrl ? window.electronAPI.toFileUrl(p.content) : p.content;
                html += `<img class="lt-phone-image" data-phone-image="${i}" src="${esc(source)}" alt="${esc(phoneLabel(p))}" draggable="false" style="left:${px(p.x)};top:${px(p.y)};width:${px(p.w)};height:${px(p.h)}">`;
            }
            if (isFullPhone(p, s)) {
                // 全屏电话层不画框，只在右上角放一个小标签（可拖动移出全屏、右键操作）。
                html += `<span class="lt-phone-badge" data-phone="${i}" style="top:${4 + i * 20}px" title="全屏电话层：拖动可移出全屏，右键更多">☎ ${esc(phoneLabel(p))} · 全屏</span>`;
                html += ['nw','ne','sw','se'].map(corner => `<i class="lt-full-phone-resize" data-resize="${i}" data-corner="${corner}" style="left:${px(p.x + (corner.includes('e') ? p.w : 0))};top:${px(p.y + (corner.includes('s') ? p.h : 0))};transform:translate(${corner.includes('e') ? '-100%' : '0'},${corner.includes('s') ? '-100%' : '0'});cursor:${corner==='nw'||corner==='se'?'nwse':'nesw'}-resize"></i>`).join('');
                return;
            }
            html += `<div class="lt-phone${i === st.phoneSel ? ' sel' : ''}${p.content ? ' has-image' : ''}" style="left:${px(p.x)};top:${px(p.y)};width:${px(p.w)};height:${px(p.h)}"><span data-phone="${i}" style="top:${i * 18}px" title="拖动移动；右键更多">☎ ${esc(phoneLabel(p))}</span>${['nw','ne','sw','se'].map(corner => `<i data-resize="${i}" data-corner="${corner}" style="${corner.includes('w')?'left:0;right:auto;':'right:0;'}${corner.includes('n')?'top:0;bottom:auto;':'bottom:0;'}cursor:${corner==='nw'||corner==='se'?'nwse':'nesw'}-resize" title="拖动缩放，Shift 自由调整宽高"></i>`).join('')}</div>`;
        });
        if (s.title?.enabled) {
            const y = T.resolveTitleY(s);
            html += `<div class="lt-title" data-title-anchor title="上下拖动调整标题中心位置" style="top:${px(y)}"><span>标题中心</span></div>`;
        }
        el.innerHTML = html;
    }

    function sec(title, body, extra = '') { return `<div class="lt-sec ${extra}"><h4>${title}</h4><div>${body}</div></div>`; }
    function numInput(name, value, attrs = '') { return `<input type="number" data-k="${name}" value="${esc(value)}" title="可直接输入，或按住左右拖动调整" ${attrs}>`; }
    function check(name, on, label) { return `<label><input type="checkbox" data-k="${name}" ${on ? 'checked' : ''}>${label}</label>`; }
    function opt(value, label, cur) { return `<option value="${esc(value)}" ${String(value) === String(cur) ? 'selected' : ''}>${esc(label)}</option>`; }

    function renderPanel() {
        const panel = document.getElementById('lt-panel');
        if (!panel) return;
        releaseGridPreview();
        document.querySelector('#lt-modal .lt-box')?.classList.toggle('lt-review-focus', !!st.reviewFocus);
        const s = st.scheme, T = L(), c = s.composition, r = s.random || {};
        const lib = loadLibrary();
        const task = baseTask();
        const hint = document.getElementById('lt-base-hint');
        if (hint) hint.textContent = st.baseMode === 'blank' || !task ? '底板：空白任务' : `底板任务：${task.baseName || task.fileName || '当前任务'}`;
        const scrollTop = panel.scrollTop;
        const currentParameters = panel.querySelector('[data-layout-parameters]');
        if (currentParameters) st.parametersOpen = currentParameters.open;
        let html = '';
        const editing = st.editingPlan != null;
        if (editing) {
            const label = st.editLabel || (st.editingTemplateId ? '本批布局模板' : planLabel(st.editingPlan));
            html += `<div class="lt-sec" style="border-color:#a855f7"><h4 style="background:#2a1f3d">✏️ 正在单独编辑：${esc(label)}</h4><div>
                <span class="lt-hint">在左侧拖分割线、右键改块，或用下方设置调整，只影响当前编辑对象，点击保存后生效。媒体组成需保持不变。</span>
                <button class="pri" data-act="editdone">✅ 保存布局修改</button><button data-act="editcancel">取消</button></div></div>`;
        }
        if (!editing) html += sec('① 选择模板 · 软件预设 / 我的预设', sourceTemplatesHtml());
        const advancedStart = html.length;
        if (!editing) html += sec('📚 当前方案', `
            <select data-k="lib">${opt('', lib.length ? '— 选择已保存方案 —' : '（暂无已保存方案）', '')}${lib.map(x => opt(x.id, x.name, s.id)).join('')}</select>
            <label>名称 <input type="text" data-k="name" value="${esc(s.name)}" style="width:150px"></label>
            <button data-act="save">💾 保存</button><button data-act="saveas">另存为</button><button data-act="new">新建</button>
            <button data-act="delete">删除</button><button data-act="export" title="将所有已保存的我的布局预设导出为一个 JSON 备份文件">导出全部预设（${lib.length}）</button><button data-act="import" title="导入布局预设备份；相同 ID 的预设会更新">导入预设</button>
            <span class="lt-hint">导出包含所有已保存的“我的预设”；当前未保存的修改请先保存。软件内置预设无需备份。</span>`);
        if (!editing) html += sec('🎬 媒体组成（同一批任务固定不变）', `
            <label>画布尺寸 <select data-k="canvasSize">${[[1080,1920,"9:16（1080×1920）"],[1080,1350,"4:5（1080×1350）"],[1080,1080,"1:1（1080×1080）"],[800,1000,"4:5（800×1000）"],[1000,1000,"1:1（1000×1000）"]].map(([w,h,label])=>opt(`${w}x${h}`,label,st.customCanvas ? "custom" : `${T.canvasWidth(s)}x${T.canvasHeight(s)}`)).join("")}${opt("custom","自定义",st.customCanvas || ![[1080,1920],[1080,1350],[1080,1080],[800,1000],[1000,1000]].some(([w,h])=>w===T.canvasWidth(s)&&h===T.canvasHeight(s)) ? "custom" : "")}</select></label>${st.customCanvas || ![[1080,1920],[1080,1350],[1080,1080],[800,1000],[1000,1000]].some(([w,h])=>w===T.canvasWidth(s)&&h===T.canvasHeight(s)) ? `<label>宽 ${numInput("canvasWidthCustom", T.canvasWidth(s), 'min="64" max="8192" step="1"')}</label><label>高 ${numInput("canvasHeightCustom", T.canvasHeight(s), 'min="64" max="8192" step="1"')}</label>` : ""}<span class="lt-hint">应用布局后，任务预览和导出采用此尺寸；工程默认尺寸保留。</span>
            ${check('c.sermon', c.sermon, '讲道（跟背景联动）')}
            <label>观众总数 ${numInput('audienceTotal', (c.audience | 0) + (c.main ? 1 : 0), 'min="0" max="12"')}</label>
            ${check('highlightMain', c.main, '突出其中一位为主观众')}
            <label>电话主层 ${numInput('c.phonePrimary', c.phonePrimary | 0, 'min="0" max="6"')}</label>
            <label>电话次层 ${numInput('c.phoneSecondary', c.phoneSecondary | 0, 'min="0" max="6"')}</label>
            ${check('autoPhone', s.autoPhoneSecondary !== false, '讲道不是上下通栏时自动加电话次层')}
            <span class="lt-hint">观众总数包含主观众；突出主观众只放大其中一位，不增加人数，也不影响同人数预设的选择。普通观众按画面阅读顺序编号为 画中画（观众）1、2、3…；电话层只有 1 个时沿用“电话主层/电话次层”原名。</span>`);
        html += sec('🧩 推荐布局', `
            <label>结构 <select data-k="pattern">${opt('stack', '讲道整条 + 观众网格', s.pattern)}${opt('wrap', '讲道与观众并排成带 + 其余观众', s.pattern)}${opt('mosaic', '不规则拼贴（观众大小随机、不整齐）', s.pattern)}</select></label>
            <label>讲道位置 <select data-k="sermonPos">${s.pattern === 'wrap' ? opt('left', '左', s.sermonPos) + opt('right', '右', s.sermonPos) : ['top', 'bottom', 'left', 'right'].map(p => opt(p, { top: '上', bottom: '下', left: '左', right: '右' }[p], s.sermonPos)).join('')}</select></label>
            ${s.pattern === 'wrap' ? `<label>讲道带位置 <select data-k="bandPos">${opt('top', '上', s.bandPos)}${opt('bottom', '下', s.bandPos)}</select></label>` : ''}
            <button data-act="regen">${s.pattern === 'mosaic' ? '🎲 换一个不规则拼贴' : '↻ 按此重新生成布局'}</button>`);
        html += sec('📐 可分配区域与外观', `
            <label>上边距 ${numInput('area.top', s.area.top, 'min="0" max="1500" step="10"')}</label>
            <label>下边距 ${numInput('area.bottom', s.area.bottom, 'min="0" max="1500" step="10"')}</label>
            <label>左边距 ${numInput('area.left', s.area.left, 'min="0" max="500" step="5"')}</label>
            <label>右边距 ${numInput('area.right', s.area.right, 'min="0" max="500" step="5"')}</label>
            <label>块间距 ${numInput('gap', s.gap, 'min="0" max="80"')}</label>
            <label>圆角 ${numInput('radius', s.radius, 'min="0" max="120"')}</label>
            <label>主观众 ≥ 观众 × ${numInput('mainRatio', s.mainRatio, 'min="1" max="4" step="0.1"')}</label>
            <label>观众分块比例 <select data-k="audienceBlockAspect">${[['', '自由（铺满分格）'], ['9:16', '强制 9:16'], ['4:5', '强制 4:5'], ['1:1', '强制 1:1'], ['16:9', '强制 16:9']].map(([v, l]) => opt(v, l, s.audienceBlockAspect || '')).join('')}</select></label>
            <span class="lt-hint">布局画布 ${T.canvasWidth(s)}×${T.canvasHeight(s)}（像素）。媒体块只在边距内分配，上下留白可放标题或说明。</span>`);
        // 选中块
        const blocks = T.computeBlocks(s);
        const selB = blocks.find(b => b.id === st.selectedId);
        let selBody = '<span class="lt-hint">在左侧预览中点击一个色块进行调整。</span>';
        if (selB) {
            const found = T.findNode(s.tree, selB.id);
            const share = Math.round(T.shareOf(s.tree, selB.id) * 1000) / 10;
            const parentFound = found?.parent ? T.findNode(s.tree, found.parent.id) : null;
            const pShare = parentFound?.parent ? Math.round(T.shareOf(s.tree, found.parent.id) * 1000) / 10 : null;
            selBody = `<b style="width:100%">${esc(selB.label)} · ${selB.w}×${selB.h}px</b>
                ${found?.parent ? `<label>同级占比 <input type="range" data-k="share" min="5" max="95" step="0.5" value="${share}"> ${numInput('shareNum', share, 'min="5" max="95" step="0.5"')}%</label>` : '<span class="lt-hint">该块独占整个区域。</span>'}
                ${pShare != null ? `<label>所在组占比 ${numInput('parentShare', pShare, 'min="5" max="95" step="0.5"')}%</label>` : ''}
                ${found?.parent ? check('lock', !!found.node.locked, '锁定此块占比') : ''}
                <label>与 <select data-k="swap">${opt('', '— 选择 —', '')}${blocks.filter(b => b.id !== selB.id).map(b => opt(b.id, b.label.replace('画中画', ''), '')).join('')}</select> 交换位置</label>
                ${found?.parent ? '<button data-act="dir">⇆ 切换同组横排/竖排</button>' : ''}`;
        }
        const issues = T.layoutIssues(s);
        if (issues.length) selBody += `<div class="lt-warn">⚠ ${issues.map(i => esc(i.text)).join('；')} <button data-act="fix">自动修正</button></div>`;
        html += sec('🎯 选中媒体块', selBody);
        // 标题
        const titleOpts = T.titleLayerOptions(st.baseMode === 'blank' ? null : task);
        const cands = T.titleCandidates(s);
        const anchor = s.title.anchor || {};
        const anchorKey = anchor.mode === 'seam' ? `seam:${anchor.index | 0}` : anchor.mode || 'top';
        html += sec('🔤 标题条（自动高度，位于所有媒体层之上）', `
            ${check('title.enabled', s.title.enabled, '启用')}
            <label>标题层 <select data-k="title.layerKey">${opt('', '自动（底板任务中的第一个文字卡片）', s.title.layerKey)}${titleOpts.map(o => opt(o.key, o.label, s.title.layerKey)).join('')}</select></label>
            <label>位置 <select data-k="title.anchor">${cands.map(c2 => opt(c2.key, c2.label, anchorKey)).join('')}${opt('custom', '自定义高度', anchorKey)}</select></label>
            ${anchor.mode === 'custom' ? `<label>中心高度 ${numInput('title.yPct', anchor.yPct ?? 50, 'min="0" max="100" step="0.5"')}%</label>` : ''}
            <span class="lt-hint">沿用底板任务中标题层的字体/样式，只改垂直位置；底板没有文字卡片（如空白任务）时会自动新建一张标题卡片。高度跟随文字自动计算，中心对齐到所选位置。</span>`);
        // 电话
        const phones = s.phones || [];
        html += sec('☎ 电话层（图片，位于讲道/观众之上，位置手动设定）', phones.length ? phones.map((p, i) => `
            <div class="lt-phone-row" style="${i === st.phoneSel ? 'background:#2a2140;border-radius:6px;padding:3px' : ''}"><b style="min-width:110px">${esc(phoneLabel(p))}</b>
            X ${numInput(`ph.${i}.x`, Math.round(p.x))} Y ${numInput(`ph.${i}.y`, Math.round(p.y))}
            宽 ${numInput(`ph.${i}.w`, Math.round(p.w))} 高 ${numInput(`ph.${i}.h`, Math.round(p.h))}
            <button data-act="phonefull" data-i="${i}" title="保持 9:16 比例，适应当前画布">适应画布</button><button data-act="phonepick" data-i="${i}">选择图片</button>${p.content ? `<span title="${esc(p.content)}">✅ ${esc(decodeURIComponent(String(p.content).split(/[\\/]/).pop()))}</span><button data-act="phoneclear" data-i="${i}">清除</button>` : '<span class="lt-hint" style="width:auto">未指定则沿用底板任务里的电话图</span>'}</div>`).join('')
            : '<span class="lt-hint">在“媒体组成”中设置电话主层/次层数量，或在预览上右键添加。</span>');
        // 额外媒体层
        const extras = s.extras || [];
        const fileName = v => esc(decodeURIComponent(String(v).split(/[\\/]/).pop()));
        html += sec('▣ 额外媒体层（可参与分割，或作为全屏层）', `${extras.map((x, i) => `
            <div class="lt-phone-row"><input type="text" data-k="ex.${i}.name" value="${esc(x.name)}" style="width:110px" title="层名称（批量表格/总览中显示）">
            <select data-k="ex.${i}.mode">${opt('split', '参与分割（占一个块）', x.mode)}${opt('full', '全屏', x.mode)}</select>
            ${x.mode !== 'split' ? `<select data-k="ex.${i}.layer">${opt('above', '在讲道/观众之上', x.layer)}${opt('below', '在讲道/观众之下', x.layer)}</select>` : ''}
            <button data-act="expick" data-i="${i}">选择素材</button>${x.content ? `<span title="${esc(x.content)}">✅ ${fileName(x.content)}</span><button data-act="exclear" data-i="${i}">清除</button>` : '<span class="lt-hint" style="width:auto">可留空，之后在总览中替换</span>'}
            <button data-act="exdel" data-i="${i}">删除</button></div>`).join('')}
            <button data-act="exadd" data-mode="split">＋ 添加媒体层（参与分割）</button><button data-act="exadd" data-mode="full">＋ 添加媒体层（全屏）</button>
            <span class="lt-hint">参与分割的层在布局里占一个色块（青色），可拖动分割线、右键与其他块互换；全屏层铺满布局画布，可放在讲道/观众之上或之下。电话层始终在最上面（标题除外）。</span>`);
        // 底衬
        const bd = s.backdrop || {};
        html += sec('🖼 底衬覆层（铺满全屏，在所有媒体块之下，背景本身不动）', `
            <label>类型 <select data-k="bd.mode">${opt('none', '不添加', bd.mode)}${opt('color', '纯色', bd.mode)}${opt('media', '指定媒体', bd.mode)}</select></label>
            ${bd.mode === 'color' ? `<label>颜色 <input type="color" data-k="bd.color" value="${esc(bd.color || '#000000')}"></label>` : ''}
            ${bd.mode === 'media' ? `<button data-act="bdpick">选择图片/视频</button><span class="lt-hint" style="width:auto">${bd.content ? esc(decodeURIComponent(String(bd.content).split(/[\\/]/).pop())) : '未指定则沿用底板任务里的背景层'}</span>` : ''}`);
        const advancedHtml = html.slice(advancedStart);
        if (!editing) html = `<details data-layout-parameters ${st.parametersOpen !== false ? 'open' : ''} style="margin-bottom:12px"><summary style="cursor:pointer;padding:10px;background:#252b39;border-radius:6px">⚙️ 编辑当前布局、媒体组成、电话层与标题</summary>${advancedHtml}</details>` + html.slice(0, advancedStart);
        if (!editing) html += sec('② 生成随机布局候选（示意图）', randomCandidatesHtml() + randomOptionsHtml());
        // 批量
        const modifying = st.output === 'modify';
        const targets = modifying ? modifyTargets() : [];
        if (!editing) html += sec('③ 本批已选模板 → 分配给任务', `
            <label>写入方式 <select data-k="output">${opt('append', '新建：追加到当前标签页', st.output)}${opt('replace', '新建：替换当前标签页全部任务', st.output)}${opt('modify', '修改：改现有任务的布局（不新建）', st.output)}</select></label>
            ${modifying ? `<label>修改范围 <select data-k="scope">${opt('checked', '已勾选导出的任务', st.scope)}${opt('all', '任务列表中的全部任务', st.scope)}${opt('selected', '仅当前选中任务', st.scope)}</select></label>
                <span class="lt-hint">将修改 ${targets.length} 个任务：只重排讲道/观众/电话层/底衬与标题位置，素材按层位（观众1、电话主层…）原样保留；文字、字幕、音频、背景不动。观众数量变多时新增层位留空，变少时多出的观众层会被移除。可用撤销（⌘Z）恢复。</span>`
            : `<label>数量 ${numInput('count', st.count, 'min="1" max="500"')}</label>
            <label>底板 <select data-k="baseMode">${opt('blank', '空白任务（不复制任何内容）', st.baseMode)}${task ? opt('current', `当前选中任务：${task.baseName || task.fileName || ''}`, st.baseMode) : ''}</select></label>
            <label>任务名前缀 <input type="text" data-k="prefix" value="${esc(st.prefix || s.name)}" style="width:140px"></label>`}
            ${poolHtml()}
            <div style="width:100%;display:flex;gap:8px"><button data-act="preview">👁 预览本批分配（真实画面）</button><button class="pri" data-act="generate" ${!st.previewRequested || !poolTemplates().length || (modifying && !targets.length) ? 'disabled' : ''}>${modifying ? `确认应用到 ${targets.length} 个任务` : `确认新建 ${st.count} 个任务`}</button></div>
            ${reviewHtml()}`, 'lt-final');
        panel.innerHTML = html;
        panel.scrollTop = scrollTop;
        observeFrames();
    }

    // ── 交互 ──
    function setPath(obj, path, value) {
        const keys = path.split('.');
        let cur = obj;
        keys.slice(0, -1).forEach(k => { if (cur[k] == null) cur[k] = {}; cur = cur[k]; });
        cur[keys.at(-1)] = value;
    }
    let scrubbingNumber = false;
    function rerenderAfterTree(panelToo = true) {
        const before = (st.scheme.phones || []).length;
        L().applyAutoPhone(st.scheme);
        if ((st.scheme.phones || []).length !== before) panelToo = true;
        invalidate(); renderCanvas(); if (panelToo && !scrubbingNumber) renderPanel();
    }

    function startNumberScrub(event) {
        const input = event.target;
        const key = input.dataset?.k || '';
        if (event.button !== 0 || input.type !== 'number' || !/^(area\.|gap$|radius$|mainRatio$|shareNum$|parentShare$|title\.yPct$|ph\.)/.test(key)) return;
        const initial = Number(input.value), x = event.clientX;
        if (!Number.isFinite(initial)) return;
        const step = input.step && input.step !== 'any' ? Number(input.step) : 1;
        const min = input.hasAttribute('min') ? Number(input.min) : -Infinity;
        const max = input.hasAttribute('max') ? Number(input.max) : Infinity;
        let moved = false;
        const move = e => {
            const delta = e.clientX - x;
            if (!moved && Math.abs(delta) < 4) return;
            moved = true; scrubbingNumber = true;
            const value = Math.max(min, Math.min(max, initial + Math.round(delta / 3) * step));
            input.value = String(Number(value.toFixed(8)));
            onChange({ target: input });
            e.preventDefault();
        };
        const finish = () => {
            document.removeEventListener('pointermove', move);
            document.removeEventListener('pointerup', finish);
            document.removeEventListener('pointercancel', finish);
            if (moved) { scrubbingNumber = false; renderPanel(); }
        };
        document.addEventListener('pointermove', move);
        document.addEventListener('pointerup', finish);
        document.addEventListener('pointercancel', finish);
    }

    function onInput(e) {
        const k = e.target.dataset?.k;
        if (k === 'share') {
            L().setShare(st.scheme.tree, st.selectedId, Number(e.target.value) / 100);
            const n = e.target.parentElement.querySelector('[data-k="shareNum"]');
            if (n) n.value = Math.round(L().shareOf(st.scheme.tree, st.selectedId) * 1000) / 10;
            rerenderAfterTree(false);
        }
    }
    function onChange(e) {
        const t = e.target, k = t.dataset?.k;
        if (!k) return;
        const s = st.scheme, T = L();
        const val = t.type === 'checkbox' ? t.checked : t.type === 'number' || t.type === 'range' ? Number(t.value) : t.value;
        if (k === 'canvasSize' || k === 'canvasWidthCustom' || k === 'canvasHeightCustom') {
            if (k === 'canvasSize' && val === 'custom') { st.customCanvas = true; return renderPanel(); }
            if (k === 'canvasSize') st.customCanvas = false;
            const parts = k === 'canvasSize' ? String(val).split('x').map(Number) : [k === 'canvasWidthCustom' ? val : T.canvasWidth(s), k === 'canvasHeightCustom' ? val : T.canvasHeight(s)];
            const [width, height] = parts;
            if (!Number.isInteger(width) || !Number.isInteger(height) || width < 64 || height < 64 || width > 8192 || height > 8192) { toast('宽高请输入 64 至 8192 的整数', 'warning'); return renderPanel(); }
            const resize = scheme => {
                const xRatio = width / T.canvasWidth(scheme), yRatio = height / T.canvasHeight(scheme);
                scheme.area.left = Math.round((scheme.area.left || 0) * xRatio);
                scheme.area.right = Math.round((scheme.area.right || 0) * xRatio);
                scheme.area.top = Math.round((scheme.area.top || 0) * yRatio);
                scheme.area.bottom = Math.round((scheme.area.bottom || 0) * yRatio);
                (scheme.phones || []).forEach(p => {
                    const cx = (p.x + p.w / 2) * xRatio, cy = (p.y + p.h / 2) * yRatio;
                    const scale = Math.min(xRatio, yRatio);
                    p.w *= scale; p.h *= scale; p.x = cx - p.w / 2; p.y = cy - p.h / 2;
                });
                scheme.canvasWidth = width; scheme.canvasHeight = height;
            };
            resize(s);
            if (st.editingPlan == null) { st.selectedTemplates.forEach(resize); st.plans?.forEach(resize); }
            frameCache.clear(); invalidate(); return render();
        }
        if (k === 'lib') {
            const found = loadLibrary().find(x => x.id === val);
            if (found) { st.scheme = L().hydrateScheme(found); st.selectedId = ''; st.phoneSel = -1; localStorage.setItem(LAST_KEY, found.id); }
            return rerenderAfterTree();
        }
        if (k === 'autoPhone') { s.autoPhoneSecondary = val; if (val) s._autoSecondary = s._autoSecondary || false; return rerenderAfterTree(); }
        if (k === 'audienceTotal' || k === 'highlightMain') {
            const total = k === 'audienceTotal' ? Math.max(0, Math.min(12, val | 0)) : (s.composition.audience | 0) + (s.composition.main ? 1 : 0);
            const main = total > 0 && (k === 'highlightMain' ? val : s.composition.main) ? 1 : 0;
            if (!total && !s.composition.sermon) { toast('至少保留一个讲道或观众', 'warning'); return renderPanel(); }
            T.setComposition(s, { main, audience: total - main });
            st.selectedId = '';
            return rerenderAfterTree();
        }
        if (k.startsWith('c.')) {
            const key = k.slice(2);
            // 手动改电话次层数量后归用户管理；手动改成 0 视为关闭自动添加。
            if (key === 'phoneSecondary') { s._autoSecondary = false; if (!(val | 0)) s.autoPhoneSecondary = false; }
            const comp = { [key]: key === 'sermon' || key === 'main' ? (val ? 1 : 0) : Math.max(0, Math.min(12, val | 0)) };
            const next = { ...s.composition, ...comp };
            if (!next.sermon && !next.main && !(next.audience | 0)) { alert('至少需要一个讲道或观众媒体块'); return renderPanel(); }
            T.setComposition(s, comp);
            st.selectedId = '';
            return rerenderAfterTree();
        }
        if (k === 'pattern' || k === 'sermonPos' || k === 'bandPos') {
            s[k] = val;
            if (k === 'pattern') s.sermonPos = val === 'wrap' ? 'right' : 'top';
            regen();
            return;
        }
        if (k.startsWith('area.') || k === 'gap' || k === 'radius' || k === 'mainRatio') {
            setPath(s, k, Math.max(k === 'mainRatio' ? 1 : 0, val || 0));
            return rerenderAfterTree();
        }
        if (k === 'audienceBlockAspect') {
            s.audienceBlockAspect = val;
            if (val) T.optimizeAudienceAspectWeights(s);
            if (st.editingPlan == null) {
                st.selectedTemplates.forEach(p => { p.audienceBlockAspect = val; if (val) T.optimizeAudienceAspectWeights(p); });
                st.plans?.forEach(p => { p.audienceBlockAspect = val; if (val) T.optimizeAudienceAspectWeights(p); });
            }
            return rerenderAfterTree();
        }
        if (k === 'shareNum') { T.setShare(s.tree, st.selectedId, val / 100); return rerenderAfterTree(); }
        if (k === 'parentShare') { const f = T.findNode(s.tree, st.selectedId); if (f?.parent) T.setShare(s.tree, f.parent.id, val / 100); return rerenderAfterTree(); }
        if (k === 'lock') { const f = T.findNode(s.tree, st.selectedId); if (f) f.node.locked = val; return renderPanel(); }
        if (k === 'swap') { if (val) T.swapRoles(s.tree, st.selectedId, val); return rerenderAfterTree(); }
        if (k === 'title.enabled') { s.title.enabled = val; return rerenderAfterTree(); }
        if (k === 'title.layerKey') { s.title.layerKey = val; return; }
        if (k === 'title.anchor') {
            s.title.anchor = val === 'custom' ? { mode: 'custom', yPct: 50 } : val.startsWith('seam:') ? { mode: 'seam', index: Number(val.slice(5)) } : { mode: val };
            return rerenderAfterTree();
        }
        if (k === 'title.yPct') { s.title.anchor = { mode: 'custom', yPct: val }; return rerenderAfterTree(); }
        if (k.startsWith('ex.')) {
            const [, i, f] = k.split('.');
            const x = s.extras?.[i];
            if (!x) return;
            x[f] = val;
            if (f === 'mode') T.reconcileExtras(s);
            return f === 'name' ? rerenderAfterTree(false) : rerenderAfterTree();
        }
        if (k.startsWith('ph.')) { const [, i, f] = k.split('.'); if (s.phones[i]) s.phones[i][f] = val; st.phoneSel = Number(i); return rerenderAfterTree(false); }
        if (k === 'bd.mode') { s.backdrop.mode = val; return rerenderAfterTree(); }
        if (k === 'bd.color') { s.backdrop.color = val; return rerenderAfterTree(false); }
        if (['previewPhones', 'previewTitle', 'previewEditing', 'previewWidth'].includes(k)) {
            st[k] = k === 'previewWidth' ? Math.max(160, Math.min(360, val | 0)) : val;
            return renderPanel();
        }
        if (k === 'name') { s.name = val; return; }
        if (k === 'fixedRandomSeed') { st.fixedRandomSeed = val; return renderPanel(); }
        if (k === 'randomCount') { st.randomCount = Math.max(1, Math.min(100, val | 0)); return; }
        if (k === 'count') { st.count = Math.max(1, Math.min(500, val | 0)); return renderPanel(); }
        if (k === 'poolDist') { st.poolDist = val; invalidate(); return renderPanel(); }
        if (k === 'output') { st.output = val; invalidate(); return renderPanel(); }
        if (k === 'scope') { st.scope = val; invalidate(); return renderPanel(); }
        if (k === 'baseMode') { st.baseMode = val; invalidate(); return renderPanel(); }
        if (k === 'prefix') { st.prefix = val; return; }
        if (k.startsWith('r.')) {
            const r = s.random;
            const toggle = (list, item, on) => { const set = new Set(r[list] || []); on ? set.add(item) : set.delete(item); r[list] = [...set]; };
            if (k.startsWith('r.pat.')) toggle('patterns', k.slice(6), val);
            else if (k.startsWith('r.pos.')) toggle('sermonPositions', k.slice(6), val);
            else if (k.startsWith('r.band.')) toggle('bandPositions', k.slice(7), val);
            else r[k.slice(2)] = val;
            return renderPanel();
        }
    }
    function regen() {
        const s = st.scheme;
        // 不规则拼贴每次点击都换一个新的随机切法。
        s.tree = L().generateTree(s.composition, { ...s, rng: s.pattern === 'mosaic' ? L().rng(Date.now() & 0x7fffffff) : null });
        L().reconcileExtras(s);
        L().enforceConstraints(s);
        st.selectedId = '';
        rerenderAfterTree();
    }

    async function pickFile(filters) {
        const api = window.electronAPI;
        if (api?.selectFiles) {
            const paths = await api.selectFiles({ multiple: false, filters });
            const p = paths?.[0];
            return p ? (api.toFileUrl ? api.toFileUrl(p) : p) : '';
        }
        return new Promise(resolve => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = 'image/*,video/*';
            input.onchange = () => {
                const f = input.files?.[0];
                if (!f) return resolve('');
                let p = f.path || api?.getFilePath?.(f) || '';
                resolve(p ? (api?.toFileUrl ? api.toFileUrl(p) : p) : URL.createObjectURL(f));
            };
            input.click();
        });
    }

    async function onClick(e) {
        const act = e.target.closest('[data-act]')?.dataset.act;
        // 不在遮罩上点击关闭：拖动分割线/电话层时松手位置可能落在遮罩上。
        if (!act) return;
        const s = st.scheme, T = L();
        if (act === 'savecurrent') {
            const saved = clone(s);
            const name = typeof window.reelsPrompt === 'function' ? await window.reelsPrompt('保存布局预设', saved.name) : prompt('保存布局预设', saved.name);
            if (name == null) return;
            saved.name = String(name).trim() || '我的布局'; saved.id = `layout_${Date.now().toString(36)}`;
            delete saved.builtin; delete saved.fromPreset;
            saved.updatedAt = Date.now(); saveLibrary([...loadLibrary(), saved]);
            toast(`已保存布局预设「${saved.name}」`); return renderPanel();
        }
        if (act === 'copylayout') {
            if (!window.ReelsLayoutDescription) return toast('布局复制模块尚未加载', 'warning');
            const task = blankTask();
            if (s.title?.enabled) task.overlays.push({ id: 'layout-copy-title', type: 'textcard', slotKey: 'layout_copy_title', slotLabel: '标题', x: 0, y: 0, w: T.canvasWidth(s), h: 200, title_text: '标题' });
            const scheme = clone(s);
            if (scheme.title?.enabled) scheme.title.layerKey = 'layout_copy_title';
            T.applySchemeToTask(task, scheme);
            return window.ReelsLayoutDescription.copy([task], { positionOnlyTitleId: 'layout-copy-title', excludedLayers: [], width: T.canvasWidth(s), height: T.canvasHeight(s) });
        }
        if (act === 'exportskill') {
            if (!window.ReelsSkillExporter?.openForLayoutScheme) return toast('Skill 导出模块尚未加载', 'warning');
            const task = blankTask();
            if (s.title?.enabled) task.overlays.push({ id: 'layout-copy-title', type: 'textcard', slotKey: 'layout_copy_title', slotLabel: '标题', x: 0, y: 0, w: T.canvasWidth(s), h: 200, title_text: '标题' });
            const scheme = clone(s);
            if (scheme.title?.enabled) scheme.title.layerKey = 'layout_copy_title';
            T.applySchemeToTask(task, scheme);
            return window.ReelsSkillExporter.openForLayoutScheme(s, task, { positionOnlyTitleId: 'layout-copy-title', excludedLayers: [], width: T.canvasWidth(s), height: T.canvasHeight(s) });
        }
        if (act === 'ctx') return onMenu(e.target.closest('[data-act]'));
        if (act === 'rtoggle') {
            const el = e.target.closest('[data-act]');
            const list = el.dataset.list, v = el.dataset.val;
            const set = new Set(s.random[list] || []);
            if (set.has(v)) { if (set.size === 1) return toast('至少保留一个选项', 'warning'); set.delete(v); } else set.add(v);
            s.random[list] = [...set];
            return renderPanel();
        }
        const actionEl = e.target.closest('[data-act]');
        if (act === 'templatemirror' || act === 'templatemirrorvertical') {
            const source = (actionEl.dataset.from === 'batch' ? st.selectedTemplates : allTemplates()).find(x => x.id === actionEl.dataset.id);
            if (!source) return;
            const vertical = act === 'templatemirrorvertical';
            const lib = loadLibrary(), copy = T.mirrorLayout(source, vertical ? 'vertical' : 'horizontal');
            const baseName = `${source.name}（${vertical ? '上下' : '左右'}翻转）`;
            let name = baseName, n = 2;
            while (lib.some(item => item.name === name)) name = `${baseName} ${n++}`;
            copy.id = `layout_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
            copy.name = name;
            copy.updatedAt = Date.now();
            delete copy.builtin; delete copy.fromPreset;
            const sourceIndex = lib.findIndex(item => item.id === source.id);
            lib.splice(sourceIndex < 0 ? 0 : sourceIndex + 1, 0, copy);
            saveLibrary(lib);
            toast(`已生成并保存翻转副本「${name}」`, 'success');
            return renderPanel();
        }
        if (act === 'deletelibrarypreset') {
            const lib = loadLibrary();
            const preset = lib.find(item => item.id === actionEl.dataset.id);
            if (!preset) return;
            if (!confirm(`确定删除预设「${preset.name}」吗？已加入本批的布局不会移除。`)) return;
            saveLibrary(lib.filter(item => item.id !== preset.id));
            toast(`已删除预设「${preset.name}」`, 'success');
            return renderPanel();
        }
        if (act === 'batchadd') {
            const source = allTemplates().find(x => x.id === actionEl.dataset.id);
            const candidate = source && displayedTemplate(source);
            if (candidate && !st.selectedTemplates.some(x => x.id === candidate.id)) st.selectedTemplates.push(clone(candidate));
            invalidate(); return renderPanel();
        }
        if (act === 'batchedit') {
            const selected = st.selectedTemplates.find(x => x.id === actionEl.dataset.id);
            if (!selected) return;
            st.mainScheme = st.scheme; st.scheme = clone(selected); st.editingTemplateId = selected.id;
            st.editingPlan = -1; st.editLabel = `本批模板：${selected.name}`; st.selectedId = ''; st.phoneSel = -1;
            const panel = document.getElementById('lt-panel'); if (panel) panel.scrollTop = 0;
            return render();
        }
        if (act === 'batchremove') { st.selectedTemplates = st.selectedTemplates.filter(x => x.id !== actionEl.dataset.id); invalidate(); return renderPanel(); }
        if (act === 'batchclear') { st.selectedTemplates = []; invalidate(); return renderPanel(); }
        if (act === 'addcurrent') {
            const copy = clone(s); copy.id = `batch_${Date.now().toString(36)}`;
            st.selectedTemplates.push(copy); invalidate(); return renderPanel();
        }
        if (act === 'randomgenerate') {
            if (!st.fixedRandomSeed) s.random.seed = Math.floor(Math.random() * 2147483646) + 1;
            st.generated = T.planBatch(s, st.randomCount, 'random', s.random.seed).map((x, i) => ({ ...x,
                id: `random_${++st.generation}_${i}`, name: `随机布局 ${i + 1}` }));
            return renderPanel();
        }
        if (act === 'randomaddall') {
            st.generated.forEach(x => { if (!st.selectedTemplates.some(y => y.id === x.id)) st.selectedTemplates.push(clone(x)); });
            invalidate(); return renderPanel();
        }
        if (act === 'candidatesave') {
            const candidate = allTemplates().find(x => x.id === actionEl.dataset.id);
            if (!candidate) return;
            const owner = st;
            const name = typeof window.reelsPrompt === 'function' ? await window.reelsPrompt('保存到我的预设', candidate.name) : prompt('保存到我的预设', candidate.name);
            if (name == null || st !== owner) return;
            const copy = clone(candidate); copy.id = `layout_${Date.now().toString(36)}`; copy.name = String(name).trim() || candidate.name;
            delete copy.builtin; delete copy.fromPreset;
            copy.updatedAt = Date.now();
            saveLibrary([...loadLibrary(), copy]); toast(`已保存到我的预设「${copy.name}」`); return renderPanel();
        }
        if (act === 'reviewfocus') { st.reviewFocus = !st.reviewFocus; return renderPanel(); }
        if (act === 'previewundo') {
            const previous = st.previewUndo?.pop();
            if (previous && st.plans?.[previous.index]) st.plans[previous.index] = previous.plan;
            return renderPanel();
        }
        if (act === 'frameview') { if (!st.previewEditing) return showFrame(actionEl); return; }
        if (act === 'close') return close();
        if (act === 'regen') return regen();
        if (act === 'fix') { const r = T.enforceConstraints(s); if (!r.ok) toast('部分约束无法自动满足，请解除锁定或手动调整', 'warning'); return rerenderAfterTree(); }
        if (act === 'dir') { T.toggleDir(s.tree, st.selectedId); return rerenderAfterTree(); }
        if (act === 'dice') { s.random.seed = Math.floor(Math.random() * 999999) + 1; return renderPanel(); }
        if (act === 'save' || act === 'saveas') {
            const lib = loadLibrary();
            if (act === 'saveas' || !lib.some(x => x.id === s.id)) {
                const name = (typeof window.reelsPrompt === 'function' ? await window.reelsPrompt('布局方案名称', s.name) : prompt('布局方案名称', s.name));
                if (name == null) return;
                s.name = String(name).trim() || s.name;
                if (act === 'saveas' || !lib.some(x => x.id === s.id)) s.id = `layout_${Date.now().toString(36)}`;
            }
            const idx = lib.findIndex(x => x.id === s.id);
            const copy = clone(s);
            copy.updatedAt = Date.now();
            if (idx >= 0) lib[idx] = copy; else lib.push(copy);
            saveLibrary(lib);
            localStorage.setItem(LAST_KEY, s.id);
            toast(`已保存布局方案「${s.name}」`);
            return renderPanel();
        }
        if (act === 'preset') {
            const source = builtins().find(x => x.id === e.target.closest('[data-id]').dataset.id);
            const p = source && displayedTemplate(source);
            if (!p) return;
            // 载入为未保存的新方案：保存时会另存为自己的预设，不会改动内置预设。
            st.scheme = L().hydrateScheme(p);
            st.scheme.id = `layout_${Date.now().toString(36)}`;
            st.scheme.fromPreset = p.id;
            delete st.scheme.builtin;
            st.prefix = '';
            st.selectedId = ''; st.phoneSel = -1;
            return rerenderAfterTree();
        }
        if (act === 'mine') {
            const found = loadLibrary().find(x => x.id === e.target.closest('[data-id]').dataset.id);
            if (!found) return;
            const shown = displayedTemplate(found);
            st.scheme = L().hydrateScheme(shown);
            if (shown.id !== found.id) { st.scheme.id = `layout_${Date.now().toString(36)}`; delete st.scheme.builtin; }
            else localStorage.setItem(LAST_KEY, found.id);
            st.prefix = '';
            st.selectedId = ''; st.phoneSel = -1;
            return rerenderAfterTree();
        }
        if (act === 'new') { st.scheme = T.defaultScheme(); st.selectedId = ''; st.phoneSel = -1; return rerenderAfterTree(); }
        if (act === 'delete') {
            const lib = loadLibrary();
            if (!lib.some(x => x.id === s.id)) return toast('当前方案尚未保存', 'warning');
            if (!confirm(`删除布局方案「${s.name}」？`)) return;
            saveLibrary(lib.filter(x => x.id !== s.id));
            st.scheme = T.defaultScheme();
            return rerenderAfterTree();
        }
        if (act === 'export') {
            const schemes = loadLibrary();
            if (!schemes.length) return toast('暂无已保存的布局预设，请先保存后再导出', 'warning');
            const blob = new Blob([JSON.stringify({ type: 'videokit-layout-schemes', version: 1, schemes }, null, 2)], { type: 'application/json' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `布局方案_${new Date().toISOString().slice(0, 10)}.json`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 2000);
            toast(`已导出 ${schemes.length} 个已保存布局预设`, 'success');
            return;
        }
        if (act === 'import') {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.json,application/json';
            input.onchange = async () => {
                try {
                    const data = JSON.parse(await input.files[0].text());
                    const incoming = Array.isArray(data) ? data : data.schemes || (data.tree ? [data] : []);
                    if (!incoming.length) throw new Error('文件中没有布局方案');
                    const lib = loadLibrary();
                    incoming.forEach(x => { if (!x?.tree || !x.composition) return; const i = lib.findIndex(y => y.id === x.id); if (i >= 0) lib[i] = x; else lib.push(x); });
                    saveLibrary(lib);
                    toast(`已导入 ${incoming.length} 个布局方案`);
                    renderPanel();
                } catch (err) { alert(`导入失败：${err.message || err}`); }
            };
            input.click();
            return;
        }
        if (act === 'phonepick') {
            const i = Number(e.target.dataset.i);
            const url = await pickFile([{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }]);
            if (url && s.phones[i]) { s.phones[i].content = url; renderCanvas(); renderPanel(); }
            return;
        }
        if (act === 'phonefull') { const p = s.phones[Number(e.target.dataset.i)]; if (p) Object.assign(p, T.fitPhoneToCanvas(s)); return rerenderAfterTree(); }
        if (act === 'exadd') { T.addExtra(s, { mode: e.target.dataset.mode }); T.reconcileExtras(s); return rerenderAfterTree(); }
        if (act === 'exdel') { const x = s.extras?.[Number(e.target.dataset.i)]; if (x) T.removeExtra(s, x.id); st.selectedId = ''; return rerenderAfterTree(); }
        if (act === 'exclear') { const x = s.extras?.[Number(e.target.dataset.i)]; if (x) x.content = ''; return renderPanel(); }
        if (act === 'expick') {
            const x = s.extras?.[Number(e.target.dataset.i)];
            const url = await pickFile([{ name: '图片/视频', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'mp4', 'mov', 'webm', 'm4v'] }]);
            if (url && x) { x.content = url; renderPanel(); }
            return;
        }
        if (act === 'phoneclear') { const i = Number(e.target.dataset.i); if (s.phones[i]) s.phones[i].content = ''; renderCanvas(); return renderPanel(); }
        if (act === 'bdpick') {
            const url = await pickFile([{ name: '图片/视频', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'mp4', 'mov', 'webm', 'm4v'] }]);
            if (url) { s.backdrop.content = url; renderPanel(); }
            return;
        }
        if (act === 'preview') { if (!poolGuard()) return; st.plans = planFor(); st.previewRequested = true; st.pickFor = null; return renderPanel(); }
        if (act === 'reroll') { rerollPlan(Number(e.target.closest('[data-i]').dataset.i)); return renderPanel(); }
        if (act === 'rerollall') { s.random.seed = Math.floor(Math.random() * 999999) + 1; st.plans = planFor(); return renderPanel(); }
        if (act === 'pick') { const i = Number(e.target.closest('[data-i]').dataset.i); st.pickFor = st.pickFor === i ? null : i; return renderPanel(); }
        if (act === 'pickcancel') { st.pickFor = null; return renderPanel(); }
        if (act === 'pickuse') {
            const i = st.pickFor, id = e.target.closest('[data-id]').dataset.id;
            if (i == null || !st.plans?.[i]) return;
            const t = poolTemplates().find(x => x.id === id);
            if (t) st.plans[i] = L().adoptTemplate(s, t);
            st.pickFor = null;
            return renderPanel();
        }
        if (act === 'editplan') {
            const i = Number(e.target.closest('[data-i]').dataset.i);
            if (!st.plans?.[i]) return;
            st.mainScheme = st.scheme;
            st.scheme = clone(st.plans[i]);
            st.editingPlan = i; st.selectedId = ''; st.phoneSel = -1;
            const panel = document.getElementById('lt-panel'); if (panel) panel.scrollTop = 0;
            return render();
        }
        if (act === 'editdone' || act === 'editcancel') {
            const i = st.editingPlan;
            if (act === 'editdone') {
                const original = st.editingTemplateId ? st.selectedTemplates.find(x => x.id === st.editingTemplateId) : st.mainScheme;
                const a = T.countRoles(st.scheme.tree), b = T.countRoles(original.tree);
                const same = a.sermon === b.sermon && a.main === b.main && a.audience === b.audience && a.extra === b.extra
                    && (st.scheme.phones || []).filter(p => p.role === 'phone_primary').length === (original.phones || []).filter(p => p.role === 'phone_primary').length
                    && (st.scheme.extras || []).length === (original.extras || []).length;
                if (!same) return alert('这个任务的媒体组成（讲道/主观众/观众/电话主层/额外层个数）和其他任务不一致了，请改回去后再完成；或点取消放弃修改。');
                if (st.onLayoutDone) { st.onLayoutDone(clone(st.scheme)); return close(); }
                if (st.editingTemplateId) {
                    const at = st.selectedTemplates.findIndex(x => x.id === st.editingTemplateId);
                    st.selectedTemplates[at] = clone(st.scheme);
                    st.plans = null; st.previewRequested = false;
                } else st.plans[i] = Object.assign(st.scheme, { templateName: '手动调整' });
            }
            if (st.onLayoutDone) return close();
            st.editingTemplateId = null; st.editLabel = '';
            st.scheme = st.mainScheme; st.mainScheme = null; st.editingPlan = null; st.selectedId = ''; st.phoneSel = -1;
            return render();
        }
        if (act === 'generate') return generate();
    }

    // ── 右键菜单：改媒体块内容 / 拆分 / 删除 / 电话层 ──
    function closeMenu() { document.querySelector('#lt-modal .lt-ctx')?.remove(); }
    function onContextMenu(e) {
        e.preventDefault();
        closeMenu();
        const s = st.scheme;
        const phone = e.target.closest('[data-phone]');
        const block = e.target.closest('[data-block]');
        const item = (op, label, extra = '') => `<button data-act="ctx" data-op="${op}" ${extra}>${label}</button>`;
        let html = '';
        if (phone) {
            const i = Number(phone.dataset.phone);
            st.phoneSel = i;
            html = `<b>${esc(s.phones[i]?.key || '电话层')}</b>${item('phonefull', '⛶ 适应画布（9:16）', `data-i="${i}"`)}${item('phonepick', '🖼 选择电话图片', `data-i="${i}"`)}${item('phonedel', '🗑 删除此电话层', `data-i="${i}"`)}`;
        } else if (block) {
            const id = block.dataset.block;
            st.selectedId = id;
            const node = L().findNode(s.tree, id)?.node;
            const role = node?.role;
            const mark = r => (role === r ? '✓ ' : '　');
            html = `<b>改为</b>${item('role:sermon', `${mark('sermon')}讲道（跟背景联动）`, `data-id="${id}"`)}${item('role:main', `${mark('main')}主观众`, `data-id="${id}"`)}${item('role:audience', `${mark('audience')}观众`, `data-id="${id}"`)}${(s.extras || []).map(x => item(`extra:${x.id}`, `${role === 'extra' && node.extraId === x.id ? '✓ ' : '　'}媒体层：${esc(x.name)}`, `data-id="${id}"`)).join('')}${item('newextra', '　＋ 新的额外媒体层', `data-id="${id}"`)}
                <hr><b>结构</b>${item('split:h', '⬌ 左右拆分（新增一个观众）', `data-id="${id}"`)}${item('split:v', '⬍ 上下拆分（新增一个观众）', `data-id="${id}"`)}${item('remove', '🗑 删除此块（空间并给相邻块）', `data-id="${id}"`)}`;
        }
        html += `<hr><b>添加</b>${item('addphone:phone_primary', '☎ 电话主层（默认9:16）')}${item('addphone:phone_secondary', '☎ 电话次层（小窗）')}${item('addfull', '▣ 全屏媒体层')}`;
        const menu = document.createElement('div');
        menu.className = 'lt-ctx';
        menu.innerHTML = html;
        document.getElementById('lt-modal').appendChild(menu);
        const r = menu.getBoundingClientRect();
        menu.style.left = `${Math.min(e.clientX, window.innerWidth - r.width - 8)}px`;
        menu.style.top = `${Math.min(e.clientY, window.innerHeight - r.height - 8)}px`;
        render();
    }
    async function onMenu(btn) {
        const s = st.scheme, T = L();
        const op = btn.dataset.op, id = btn.dataset.id, i = Number(btn.dataset.i);
        closeMenu();
        if (op.startsWith('role:')) {
            const node = T.findNode(s.tree, id)?.node;
            // 从额外层改成其他内容：该额外层转为全屏层保留，不丢失。
            if (node?.role === 'extra') { const x = (s.extras || []).find(e => e.id === node.extraId); if (x) x.mode = 'full'; }
            T.setRole(s.tree, id, op.slice(5));
            T.syncCompositionFromTree(s);
        } else if (op.startsWith('extra:')) {
            T.assignExtra(s, id, op.slice(6));
            T.syncCompositionFromTree(s);
        } else if (op === 'newextra') {
            const x = T.addExtra(s, { mode: 'full' });
            T.assignExtra(s, id, x.id);
            T.syncCompositionFromTree(s);
        } else if (op === 'addfull') {
            T.addExtra(s, { mode: 'full' });
        } else if (op === 'phonefull') {
            if (s.phones[i]) Object.assign(s.phones[i], T.fitPhoneToCanvas(s));
        } else if (op.startsWith('split:')) {
            s.tree = T.splitBlock(s.tree, id, op.slice(6));
            T.syncCompositionFromTree(s);
        } else if (op === 'remove') {
            if (T.leaves(s.tree).length <= 1) return alert('至少要保留一个媒体块');
            s.tree = T.removeBlock(s.tree, id);
            T.syncCompositionFromTree(s);
            st.selectedId = '';
        } else if (op.startsWith('addphone:')) {
            const key = op.slice(9) === 'phone_primary' ? 'phonePrimary' : 'phoneSecondary';
            s.composition[key] = Math.min(6, (s.composition[key] | 0) + 1);
            T.syncPhones(s);
            st.phoneSel = s.phones.length - 1;
        } else if (op === 'phonedel') {
            const p = s.phones[i];
            if (!p) return;
            s.phones.splice(i, 1);
            const key = p.role === 'phone_primary' ? 'phonePrimary' : 'phoneSecondary';
            s.composition[key] = Math.max(0, (s.composition[key] | 0) - 1);
            T.syncPhones(s);
            st.phoneSel = -1;
        } else if (op === 'phonepick') {
            const url = await pickFile([{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }]);
            if (url && s.phones[i]) s.phones[i].content = url;
        }
        rerenderAfterTree();
    }

    // ── 预览拖拽：分割线 / 电话层 ──
    function onPointerDown(e) {
        if (e.button !== 0) return; // 右键交给右键菜单，避免误触发拖动
        const canvas = e.currentTarget;
        const s = st.scheme, T = L();
        const seam = e.target.closest('[data-seam]');
        const resize = e.target.closest('[data-resize]');
        const phone = e.target.closest('[data-phone]');
        const block = e.target.closest('[data-block]');
        const startX = e.clientX, startY = e.clientY;
        const originalScheme = clone(s);
        if (e.target.closest('[data-title-anchor]')) {
            const startYPos = T.resolveTitleY(s);
            canvas.setPointerCapture(e.pointerId);
            const move = ev => {
                const y = Math.max(0, Math.min(T.canvasHeight(s), startYPos + (ev.clientY - startY) / scaleFor(s)));
                s.title.anchor = { mode: 'custom', yPct: Math.round(y / T.canvasHeight(s) * 10000) / 100 };
                renderCanvas();
            };
            const up = () => {
                canvas.removeEventListener('pointermove', move);
                canvas.removeEventListener('pointerup', up);
                canvas.removeEventListener('pointercancel', up);
                syncCanvasChange(originalScheme, 'title'); renderPanel();
            };
            canvas.addEventListener('pointermove', move);
            canvas.addEventListener('pointerup', up);
            canvas.addEventListener('pointercancel', up);
            e.preventDefault();
            return;
        }
        if (seam) {
            const [parentId, idx] = seam.dataset.seam.split(':');
            const parent = T.findNode(s.tree, parentId)?.node;
            const rects = nodeRects(s, T.computeBlocks(s));
            const pr = rects.get(parentId);
            if (!parent || !pr) return;
            const lenPx = (parent.dir === 'h' ? pr.x2 - pr.x : pr.y2 - pr.y) * scaleFor(s);
            T.normalizeWeights(parent);
            const snapshot = parent.children.map(c => c.weight);
            seam.classList.add('drag');
            canvas.setPointerCapture(e.pointerId);
            const move = ev => {
                parent.children.forEach((c, i) => { c.weight = snapshot[i]; });
                const d = (parent.dir === 'h' ? ev.clientX - startX : ev.clientY - startY) / Math.max(1, lenPx);
                T.moveSeam(s.tree, parentId, Number(idx), d);
                renderCanvas();
            };
            const up = () => { canvas.removeEventListener('pointermove', move); canvas.removeEventListener('pointerup', up); syncCanvasChange(originalScheme, 'tree'); renderPanel(); };
            canvas.addEventListener('pointermove', move);
            canvas.addEventListener('pointerup', up);
            e.preventDefault();
            return;
        }
        if (phone || resize) {
            const i = Number((resize || phone).dataset.resize ?? (resize || phone).dataset.phone);
            const p = s.phones[i];
            if (!p) return;
            st.phoneSel = i;
            const orig = { ...p };
            canvas.setPointerCapture(e.pointerId);
            const move = ev => {
                const dx = (ev.clientX - startX) / scaleFor(s), dy = (ev.clientY - startY) / scaleFor(s);
                if (resize) {
                    Object.assign(p, T.resizePhoneRect(orig, resize.dataset.corner || 'se', dx, dy, ev.shiftKey));
                } else { p.x = Math.round(orig.x + dx); p.y = Math.round(orig.y + dy); }
                renderCanvas();
            };
            const up = () => { canvas.removeEventListener('pointermove', move); canvas.removeEventListener('pointerup', up); syncCanvasChange(originalScheme, 'phone', i); renderPanel(); };
            canvas.addEventListener('pointermove', move);
            canvas.addEventListener('pointerup', up);
            e.preventDefault();
            return;
        }
        if (block) { st.selectedId = block.dataset.block; st.phoneSel = -1; render(); }
    }

    // ── 批量 ──
    // ── 任务分布预览：每个任务一个布局，可单独换/选/编辑 ──
    function syncCanvasChange(before, kind, phoneIndex) {
        if (kind === 'tree' && JSON.stringify(before.tree) === JSON.stringify(st.scheme.tree)) return;
        if (kind === 'title' && JSON.stringify(before.title?.anchor) === JSON.stringify(st.scheme.title?.anchor)) return;
        if (kind === 'phone' && JSON.stringify(before.phones?.[phoneIndex]) === JSON.stringify(st.scheme.phones?.[phoneIndex])) return;
        if (st.editingPlan != null || !st.previewRequested || !st.plans) return invalidate();
        const T = L(), signature = T.signature(before);
        const phoneBefore = before.phones?.[phoneIndex];
        const matches = plan => T.sameComposition(plan, before) && T.signature(plan) === signature
            && (kind !== 'phone' || JSON.stringify(plan.phones?.[phoneIndex]) === JSON.stringify(phoneBefore));
        let changed = 0;
        for (const plan of [...st.selectedTemplates, ...st.plans]) {
            if (!matches(plan)) continue;
            if (kind === 'tree') plan.tree = clone(st.scheme.tree);
            else if (kind === 'title') plan.title.anchor = clone(st.scheme.title.anchor);
            else if (plan.phones?.[phoneIndex]) plan.phones[phoneIndex] = clone(st.scheme.phones[phoneIndex]);
            changed++;
        }
        if (changed) { st.previewUndo = []; st.pickFor = null; }
        else { invalidate(); toast('当前布局与已选模板不同，请重新加入本批后预览', 'info'); }
    }
    function invalidate() { if (st && st.editingPlan == null) { st.plans = null; st.pickFor = null; st.previewUndo = []; st.previewRequested = false; } }
    function planCount() { return st.output === 'modify' ? Math.max(1, modifyTargets().length) : st.count; }
    function planLabel(i) {
        if (st.output === 'modify') { const t = modifyTargets()[i]; return `#${i + 1} ${t?.baseName || t?.fileName || ''}`; }
        return `#${i + 1} ${(st.prefix || st.scheme?.name || 'layout')}_${String(i + 1).padStart(3, '0')}`;
    }
    function currentPlans() {
        // 预览过且数量没变就用预览结果（包含逐个调整），否则按设置重新规划。
        return st.plans && st.plans.length === planCount() ? st.plans : planFor();
    }
    function rerollPlan(i) {
        if (!st.plans?.[i]) return;
        const pool = poolTemplates();
        const others = pool.filter(x => x.name !== st.plans[i].templateName);
        const options = others.length ? others : pool;
        if (options.length) st.plans[i] = L().adoptTemplate(st.scheme, options[Math.floor(Math.random() * options.length)]);
    }
    function reviewHtml() {
        // 任务分布预览始终显示：设置一变就自动重新规划（任务很多时需手动刷新）。
        if (!poolTemplates().length) return '<span class="lt-hint">先从已有预设或生成的候选中添加布局到本批。</span>';
        if (!st.previewRequested) return '<span class="lt-hint">本批布局已选择。点击「预览本批分配」后，才加载任务素材并显示最终画面；生成候选不会套用到任务。</span>';
        if ((!st.plans || st.plans.length !== planCount()) && planCount() <= 200) { try { st.plans = planFor(); } catch (err) { console.warn('[LayoutBatch] plan failed', err); } }
        if (!st.plans) return '<div class="lt-hint" style="width:100%">任务较多，点「👁 预览本批分配（真实画面）」查看每个任务的布局。</div>';
        const T = L();
        const plans = st.plans;
        const stale = plans.length !== planCount();
        let html = `<div style="width:100%;border-top:1px dashed #2d3343;padding-top:8px">
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px"><b>📋 最终画面预览（${plans.length} 个）</b>
            ${stale ? '<span class="lt-warn" style="width:auto">任务数量已变化，请重新预览</span>' : ''}
            <button data-act="reviewfocus">${st.reviewFocus ? '返回模板选择' : '展开整体预览'}</button><button data-act="rerollall">🎲 全部重新分配</button><span class="lt-hint" style="width:auto">复用总览播放器显示各任务套用后的实际画面，点击可放大、播放和拖动进度。🎲 换一个、📐 手动选择都只使用本批已选模板；✏️ 可单独调整。确认后才写入任务。</span></div>
            <div class="lt-review-tools">${check('previewPhones', st.previewPhones !== false, '显示电话层')}${check('previewTitle', st.previewTitle !== false, '显示标题层')}
                <label>预览大小 <input type="range" data-k="previewWidth" min="160" max="360" step="20" value="${st.previewWidth || 220}"></label>
                ${check('previewEditing', !!st.previewEditing, '直接调整布局')}<button data-act="previewundo" ${!st.previewUndo?.length ? 'disabled' : ''}>撤销布局调整</button>
                <span class="lt-hint">显示开关只影响预览。开启直接调整后，在每格里拖蓝色分割线、紫色电话标签和黄色标题标签；只调整该格任务，确认应用后才写入。</span></div>`;
        if (st.pickFor != null && plans[st.pickFor]) {
            const list = poolTemplates();
            html += `<div class="lt-sec" style="border-color:#7c5cff"><h4>📐 为 ${esc(planLabel(st.pickFor))} 选择布局 <button data-act="pickcancel" style="float:right;padding:1px 8px">取消</button></h4>
                <div class="lt-gallery">
                ${list.map(t => `<div class="lt-card" data-act="pickuse" data-id="${esc(t.id)}" title="${esc(t.desc || '')}">${thumbOne(t)}<span>${esc(t.name)}${t.builtin ? '' : ' ⭐'}</span></div>`).join('')}</div></div>`;
        }
        html += `<div class="lt-gallery" style="grid-template-columns:repeat(auto-fill,minmax(${st.previewWidth || 220}px,1fr))">${plans.slice(0, 300).map((plan, i) => {
            const issues = T.layoutIssues(plan);
            return `<div class="lt-card${st.pickFor === i ? ' cur' : ''}" style="cursor:default" data-i="${i}">
                ${frameHtml('plan', i)}
                <span title="${esc(planLabel(i))}" style="max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(planLabel(i))}</span>
                <span data-plan-name class="lt-hint" style="width:auto">${(plan.templateName || '') === '随机布局' || (!plan.templateName && st.mode === 'random') ? '🎲 ' : ''}${esc(plan.templateName || (st.mode === 'uniform' ? '当前方案' : '随机布局'))}${issues.length ? ' <b style="color:#fbbf24" title="' + esc(issues.map(x => x.text).join('；')) + '">⚠</b>' : ''}</span>
                <div style="display:flex;gap:3px"><button data-act="reroll" data-i="${i}" title="随机换一个">🎲</button><button data-act="pick" data-i="${i}" title="手动选择模板">📐</button><button data-act="editplan" data-i="${i}" title="打开布局单独调整">✏️</button></div>
            </div>`;
        }).join('')}</div>${plans.length > 300 ? '<span class="lt-hint">仅显示前 300 个</span>' : ''}</div>`;
        return html;
    }
    function planFor() {
        if (!poolTemplates().length) return [];
        return L().planPool(st.scheme, poolTemplates(), planCount(), { distribute: st.poolDist, includeRandom: false, seed: st.scheme.random?.seed || 1 });
    }
    const isFullPhone = (p, scheme) => Math.round(p.x) <= 0 && Math.round(p.y) <= 0 && Math.round(p.w) >= L().canvasWidth(scheme) && Math.round(p.h) >= L().canvasHeight(scheme);
    function allTemplates() { return [...builtins(), ...loadLibrary().map(x => L().hydrateScheme(x)), ...st.generated, ...st.selectedTemplates]; }
    function poolTemplates() { return st.selectedTemplates.filter(x => L().sameComposition(x, st.scheme)); }
    function displayedTemplate(t) { return t; }
    function templateCard(t, save = false) {
        const shown = displayedTemplate(t);
        const selected = st.selectedTemplates.some(x => x.id === shown.id);
        const compatible = L().sameComposition(t, st.scheme);
        return `<div class="lt-card${selected ? ' cur' : ''}">${thumbOne(shown)}<span>${esc(shown.name)}</span>
            <button data-act="templatemirror" data-id="${esc(t.id)}" title="创建左右翻转的独立副本">⇆ 左右翻转并复制</button>
            <button data-act="templatemirrorvertical" data-id="${esc(t.id)}" title="创建上下翻转的独立副本，素材内容不会倒置">⇅ 上下翻转并复制</button>
            <button data-act="batchadd" data-id="${esc(t.id)}" ${selected || !compatible ? 'disabled' : ''}>${selected ? '已加入本批' : compatible ? '＋ 加入本批' : '媒体组成不同'}</button>
            <button data-act="${t.builtin ? 'preset' : 'mine'}" data-id="${esc(t.id)}">载入编辑</button>
            ${!t.builtin ? `<button data-act="deletelibrarypreset" data-id="${esc(t.id)}" title="删除这个已保存预设">🗑 删除预设</button>` : ''}
            ${save ? `<button data-act="candidatesave" data-id="${esc(t.id)}">⭐ 保存到我的预设</button>` : ''}</div>`;
    }
    function sourceTemplatesHtml() {
        const lib = loadLibrary().map(x => L().hydrateScheme(x));
        const c = st.scheme.composition;
        return `<span class="lt-hint">当前组成：讲道 ${c.sermon ? 1 : 0} · 观众总数 ${(c.audience | 0) + (c.main ? 1 : 0)}${c.main ? '（其中一位突出为主观众）' : ''}。可在顶部「编辑当前布局」调整。</span><b style="width:100%">软件内置布局预设</b><div class="lt-gallery">${builtins().map(t => templateCard(t)).join('')}</div>
            <b style="width:100%">我的预设（${lib.length}）</b>${lib.length ? `<div class="lt-gallery">${lib.map(t => templateCard(t)).join('')}</div>` : '<span class="lt-hint">生成的随机布局可保存到这里，下次打开仍可使用。</span>'}
            <span class="lt-hint">同一观众总数的预设均可选择，主观众开关不限制选择；需要其他人数时，在顶部调整观众总数。</span>`;
    }
    function randomCandidatesHtml() {
        return `<p class="lt-hint" style="margin:0">按当前讲道、主观众和观众数量，现场生成一批布局供你挑选。这里仅生成色块示意图，不加载素材，也不分配给任务。</p>
            <div style="width:100%;display:flex;gap:8px;align-items:center"><label>候选数量 ${numInput('randomCount', st.randomCount, 'min="1" max="100"')}</label>
            <button class="pri" data-act="randomgenerate">🎲 ${st.generated.length ? '重新生成候选' : '生成候选布局'}</button>
            ${st.generated.length ? '<button data-act="randomaddall">将这些候选全部加入本批</button>' : ''}</div>
            ${st.generated.length ? `<b style="width:100%">本次生成的布局候选（${st.generated.length} 个）</b><span class="lt-hint">在下方逐个「加入本批」或「保存布局预设」。重新生成只替换这里的候选，不动本批已选布局和已保存预设。</span>
                <div class="lt-gallery">${st.generated.map(t => {
                    const selected = st.selectedTemplates.some(x => x.id === t.id);
                    const compatible = L().sameComposition(t, st.scheme);
                    return `<div class="lt-card${selected ? ' cur' : ''}">${thumbOne(t, '本次生成的布局示意图', 104)}<span>${esc(t.name)}</span>
                    <button data-act="batchadd" data-id="${esc(t.id)}" ${selected || !compatible ? 'disabled' : ''}>${selected ? '✓ 已加入本批' : compatible ? '＋ 加入本批' : '当前媒体数量已改变'}</button>
                    <button data-act="candidatesave" data-id="${esc(t.id)}">⭐ 保存布局预设</button></div>`;
                }).join('')}</div>` : '<div class="lt-hint" style="padding:12px;border:1px dashed #394055;border-radius:6px">还没有生成候选。设置数量后点击「生成候选布局」，这里才会出现可选布局。</div>'}`;
    }
    function poolHtml() {
        const selected = poolTemplates(), hidden = st.selectedTemplates.length - selected.length;
        return `<b style="width:100%">本批已选模板（${selected.length}）</b>
            <button data-act="addcurrent">＋ 将当前编辑布局加入本批</button><button data-act="batchclear">清空本批</button>
            ${hidden ? `<span class="lt-warn">有 ${hidden} 个已选模板与当前媒体组成不同，不参与分配。</span>` : ''}
            ${selected.length ? `<div class="lt-gallery">${selected.map(t => `<div class="lt-card" data-act="batchedit" data-id="${esc(t.id)}" title="点击编辑本批模板">${thumbOne(t)}<span>${esc(t.name)}</span><button data-act="templatemirrorvertical" data-from="batch" data-id="${esc(t.id)}">⇅ 上下翻转并复制</button><button data-act="batchedit" data-id="${esc(t.id)}">✏️ 编辑布局</button><button data-act="batchremove" data-id="${esc(t.id)}">移出本批</button></div>`).join('')}</div>` : '<span class="lt-hint">本批还没有模板。先在上方预设或随机生成结果中点击「加入本批」。</span>'}
            <label>分配方式 <select data-k="poolDist">${opt('even', '均匀分配（每个模板使用次数接近）', st.poolDist)}${opt('random', '随机抽取本批模板', st.poolDist)}</select></label>
            <span class="lt-hint">只从这里列出的模板分配，不会额外生成随机布局。电话层位置和尺寸随各模板分配，电话图片与文字内容沿用任务素材。</span>`;
    }
    // ── 随机设置：用缩略图代替纯文字勾选 ──
    function randomOptionsHtml() {
        const r = st.scheme.random || {};
        const choices = (list, options) => options.map(([value, label]) => `<button data-act="rtoggle" data-list="${list}" data-val="${value}" aria-pressed="${(r[list] || []).includes(value)}" style="${(r[list] || []).includes(value) ? 'border-color:#a855f7;background:#39264f' : ''}">${(r[list] || []).includes(value) ? '☑' : '☐'} ${label}</button>`).join('');
        return `<details data-generator-settings ${st.generatorSettingsOpen ? 'open' : ''} style="width:100%;border-top:1px dashed #394055;padding-top:8px"><summary style="cursor:pointer;color:#a7adbb">生成范围设置（算法限定，可选）</summary>
            <div style="padding-top:10px;display:flex;flex-direction:column;gap:10px">
                <span class="lt-hint">这些是算法的限制条件，不是预先生成的布局，不能直接加入本批。点击生成时，算法在所选结构范围内改变位置、比例与分割方式；不是任意自由排版。若只想保留当前排法的小幅变化，可在顶部「编辑当前布局」用占比和分割线调整。</span>
                <div>允许的结构：${choices('patterns', [['stack','讲道整条＋观众网格'],['wrap','讲道与观众并排成带'],['mosaic','观众区域不规则切分']])}</div>
                <div>讲道整条允许的位置：${choices('sermonPositions', [['top','上'],['bottom','下'],['left','左'],['right','右']])}</div>
                <div>并排成带允许的位置：${choices('bandPositions', [['top','上'],['bottom','下']])}</div>
                <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center"><label>块占比浮动 ±${numInput('r.jitter', r.jitter ?? 10, 'min="0" max="40"')}%</label>
                    ${check('r.randomMain', r.randomMain, '主观众位置随机')}${check('r.randomTitle', r.randomTitle, '标题位置随机')}${check('r.avoidRepeat', r.avoidRepeat !== false, '尽量避免相邻候选重复')}</div>
                <div style="display:flex;gap:10px;align-items:center">${check('fixedRandomSeed', st.fixedRandomSeed, '固定随机种子（需要复现同一批布局时使用）')}
                    ${st.fixedRandomSeed ? `<label>种子 ${numInput('r.seed', r.seed ?? 1, 'min="1"')}</label>` : '<span class="lt-hint" style="width:auto">默认每次点击都会生成新的一批。</span>'}</div>
            </div></details>`;
    }
    let builtinCache = null;
    function builtins() { if (!builtinCache) builtinCache = L().builtinPresets(); return builtinCache; }
    function thumbOne(plan, title = '', width = 64) {
        const k = width / L().canvasWidth(plan);
        const px = v => `${Math.round(v * k * 10) / 10}px`;
        const T = L();
        const blocks = T.computeBlocks(plan).map(b => `<b style="left:${px(b.x)};top:${px(b.y)};width:${px(b.w)};height:${px(b.h)};background:${ROLE_COLORS[b.role]}"></b>`).join('');
        const phones = (plan.phones || []).filter(p => !isFullPhone(p, plan)).map(p => `<s style="left:${px(p.x)};top:${px(p.y)};width:${px(p.w)};height:${px(p.h)}"></s>`).join('');
        const tl = plan.title?.enabled ? `<em style="top:${px(T.resolveTitleY(plan))}"></em>` : '';
        const bg = plan.backdrop?.mode === 'color' ? plan.backdrop.color : '#0b0d12';
        const size = `width:${width}px;height:${Math.round(width * T.canvasHeight(plan) / T.canvasWidth(plan))}px;`;
        return `<div class="lt-thumb" title="${esc(title)}" style="${size}background:${bg}">${blocks}${phones}${tl}</div>`;
    }
    let frameObserver = null;
    const frameCache = new Map();
    let frameQueue = Promise.resolve();
    let activeFramePreview = null, expandedPreview = null, gridLivePreview = null, gridLiveCard = null;
    function frameHtml(kind, index) {
        return `<div class="lt-frame" data-frame-kind="${kind}" data-frame-index="${index}" data-act="frameview" style="width:100%;aspect-ratio:${L().canvasWidth(st.scheme)}/${L().canvasHeight(st.scheme)};background:#080a0e;position:relative;display:flex;align-items:center;justify-content:center;color:#8b93a7"><span>等待合成画面…</span></div>`;
    }
    function observeFrames() {
        frameObserver?.disconnect();
        const owner = st;
        frameObserver = new IntersectionObserver(entries => {
            entries.forEach(entry => {
                if (!entry.isIntersecting) return;
                const el = entry.target;
                frameObserver.unobserve(el);
                frameQueue = frameQueue.catch(() => {}).then(async () => {
                    if (!el.isConnected || st !== owner) return;
                    await renderFrameCard(el, owner);
                });
            });
        }, { root: document.getElementById('lt-panel'), rootMargin: '120px' });
        document.querySelectorAll('#lt-panel [data-frame-kind]').forEach(el => frameObserver.observe(el));
    }
    async function renderFrameCard(el, owner) {
        try {
            const i = Number(el.dataset.frameIndex);
            if (el.dataset.frameKind !== 'plan') return;
            const plan = owner.plans?.[i];
            if (!plan) return;
            const source = owner.output === 'modify' ? modifyTargets()[i] : resolveBase();
            const task = makeReviewTask(source || blankTask(), plan, owner);
            const key = JSON.stringify([source, plan, owner.output === 'modify', owner.previewPhones !== false, owner.previewTitle !== false]);
            let result = frameCache.get(key);
            if (!result) {
                const preview = window.ReelsOverviewPreview.create(task);
                activeFramePreview = preview;
                // Keep the isolated player visible at card size while decoding.
                const stage = document.createElement('div');
                stage.style.cssText = 'width:100%;height:100%;position:absolute;inset:0';
                stage.appendChild(preview.frame); el.appendChild(stage);
                try {
                    const deadline = performance.now() + 12000;
                    while (el.isConnected && st === owner && performance.now() < deadline) {
                        preview.player?.render?.();
                        if ((preview.player?.isReplacementFrameReady?.() ?? preview.player?.isFrameReady?.()) === true) break;
                        await new Promise(resolve => setTimeout(resolve, 80));
                    }
                    if (!el.isConnected || st !== owner) return;
                    if (!preview.player) throw new Error('总览播放器加载超时，点击刷新重试');
                    const ready = (preview.player.isReplacementFrameReady?.() ?? preview.player.isFrameReady?.()) !== false;
                    preview.player.render?.();
                    const canvas = preview.player.getCanvas();
                    if (!canvas) throw new Error('总览播放器未生成画面');
                    const still = document.createElement('canvas');
                    still.width = PREVIEW_W; still.height = Math.round(PREVIEW_W * L().canvasHeight(plan) / L().canvasWidth(plan));
                    still.getContext('2d').drawImage(canvas, 0, 0, still.width, still.height);
                    const missing = task.overlays.filter(ov => !ov.disabled && ['image','video'].includes(ov.type) && !ov.content && !ov.media_folder_files?.length && !ov.sequence_frames?.length)
                        .map(ov => ov.slotLabel || ov.name || '媒体');
                    if (!ready) missing.push('部分素材加载较慢或无法读取，点击播放检查');
                    result = { canvas: still, task, missing: [...new Set(missing)] };
                    frameCache.set(key, result);
                    if (frameCache.size > 80) frameCache.delete(frameCache.keys().next().value);
                } finally { preview.dispose(); if (activeFramePreview === preview) activeFramePreview = null; stage.remove(); }
            }
            if (!el.isConnected || st !== owner) return;
            el._frame = result;
            el.innerHTML = result.missing.length ? '<span style="position:absolute;bottom:0;background:#32270de6;color:#fbbf24;font-size:10px">素材缺失 · 点击查看</span>' : '';
            const display = document.createElement('canvas');
            display.width = result.canvas.width; display.height = result.canvas.height;
            display.style.cssText = 'width:100%;height:100%;position:absolute;inset:0;object-fit:contain';
            display.setAttribute('aria-label', '合成画面首帧');
            display.getContext('2d').drawImage(result.canvas, 0, 0);
            el.prepend(display);
            if (owner.previewEditing) mountGridEditor(el, owner, i);
        } catch (err) {
            if (el.isConnected) el.innerHTML = `<span style="color:#fbbf24">合成预览失败<br>${esc(err.message || err)}</span>`;
            console.warn('[LayoutBatch] frame preview failed', err);
        }
    }
    function releaseGridPreview() {
        if (!gridLivePreview) return;
        const canvas = gridLivePreview.player?.getCanvas?.();
        const display = gridLiveCard?.querySelector('canvas');
        if (canvas?.width && display) {
            display.getContext('2d').drawImage(canvas, 0, 0, display.width, display.height);
        }
        gridLivePreview.dispose(); gridLivePreview = null; gridLiveCard = null;
    }
    // Visibility is applied only to detached review tasks. Plans retain every
    // layer so hiding a layer while editing can never hide it in the output.
    function makeReviewTask(source, plan, owner) {
        const task = clone(source);
        if (owner.output !== 'modify') ensureTitleLayer(task, plan);
        L().applySchemeToTask(task, plan, overlayDeps());
        const title = L().findTitleLayer(task.overlays || [], plan.title?.layerKey);
        task.overlays.forEach(ov => {
            if (owner.previewPhones === false && /^phone_/.test(ov.slotKey || '')) ov.disabled = true;
            if (owner.previewTitle === false && (ov === title || /^title(?:_|$)/.test(ov.slotKey || ''))) ov.disabled = true;
        });
        return task;
    }
    function gridHandlesHtml(plan, owner) {
        const T = L(), blocks = T.computeBlocks(plan), rects = nodeRects(plan, blocks);
        const x = value => `${value / (T.canvasWidth(plan) / 100)}%`, y = value => `${value / (T.canvasHeight(plan) / 100)}%`;
        let html = '';
        (function walk(node) {
            if (!node?.children?.length) return;
            const parent = rects.get(node.id);
            if (parent) node.children.slice(0, -1).forEach((child, i) => {
                const a = rects.get(child.id); if (!a) return;
                const vertical = node.dir === 'h';
                html += `<div data-grid-seam="${node.id}:${i}" class="lt-grid-seam ${vertical ? 'h' : 'v'}" title="拖动调整分割线" style="${vertical
                    ? `left:${x(a.x2 + (plan.gap || 0) / 2)};top:${y(parent.y)};height:${y(parent.y2 - parent.y)}`
                    : `top:${y(a.y2 + (plan.gap || 0) / 2)};left:${x(parent.x)};width:${x(parent.x2 - parent.x)}`}"></div>`;
            });
            node.children.forEach(walk);
        })(plan.tree);
        if (owner.previewPhones !== false) (plan.phones || []).forEach((phone, i) => {
            html += `<div class="lt-grid-phone" style="left:${x(phone.x)};top:${y(phone.y)};width:${x(phone.w)};height:${y(phone.h)}"></div>
                <span class="lt-grid-tag phone" data-grid-phone="${i}" style="${isFullPhone(phone, plan) ? `right:4px;top:${4 + i * 24}px` : `left:${x(phone.x)};top:${y(phone.y)}`}" title="拖动移动电话层">☎ ${esc(phoneLabel(phone))}</span>
                ${['nw','ne','sw','se'].map(corner => `<span class="lt-grid-resize" data-grid-resize="${i}" data-corner="${corner}" style="left:${x(phone.x+(corner.includes('e')?phone.w:0))};top:${y(phone.y+(corner.includes('s')?phone.h:0))};transform:translate(${corner.includes('e')?'-100%':'0'},${corner.includes('s')?'-100%':'0'});cursor:${corner==='nw'||corner==='se'?'nwse':'nesw'}-resize" title="拖动缩放电话层，Shift 自由调整宽高"></span>`).join('')}`;
        });
        if (owner.previewTitle !== false && plan.title?.enabled) html += `<span class="lt-grid-tag title" data-grid-title style="left:4px;top:${y(T.resolveTitleY(plan))}" title="拖动移动标题位置">标题 ↕</span>`;
        return html;
    }
    function mountGridEditor(el, owner, index) {
        if (!el.querySelector) return;
        const handles = document.createElement('div');
        handles.className = 'lt-grid-handles';
        handles.innerHTML = gridHandlesHtml(owner.plans[index], owner);
        el.appendChild(handles);
        // Capture is held on the stable card, so repainting handles during a
        // drag cannot lose pointer events, even when the cursor leaves a card.
        el.onpointerdown = event => startGridDrag(event, el, handles, owner, index);
    }
    function startGridDrag(event, el, handles, owner, index) {
        if (event.button !== 0 || !owner.previewEditing) return;
        const hit = event.target.closest('[data-grid-seam],[data-grid-phone],[data-grid-resize],[data-grid-title]');
        if (!hit) return;
        event.preventDefault(); event.stopPropagation();
        const T = L(), before = clone(owner.plans[index]), plan = clone(before);
        const bounds = el.getBoundingClientRect(), scale = bounds.width / L().canvasWidth(plan);
        const x0 = event.clientX, y0 = event.clientY;
        const phoneIndex = Number(hit.dataset.gridPhone ?? hit.dataset.gridResize);
        const phone = plan.phones?.[phoneIndex], phoneBefore = phone ? { ...phone } : null;
        let parent, weights, length;
        if (hit.dataset.gridSeam) {
            const [id] = hit.dataset.gridSeam.split(':');
            parent = T.findNode(plan.tree, id)?.node;
            const r = nodeRects(plan, T.computeBlocks(plan)).get(id);
            if (!parent || !r) return;
            T.normalizeWeights(parent); weights = parent.children.map(child => child.weight);
            length = parent.dir === 'h' ? r.x2 - r.x : r.y2 - r.y;
        }
        const source = owner.sourceTask || (owner.output === 'modify' ? modifyTargets()[index] : resolveBase());
        releaseGridPreview();
        const live = window.ReelsOverviewPreview.create(makeReviewTask(source || blankTask(), plan, owner));
        gridLivePreview = live; gridLiveCard = el;
        el.querySelector('[data-grid-live]')?.remove();
        const stage = document.createElement('div'); stage.dataset.gridLive = '';
        stage.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none';
        stage.appendChild(live.frame); el.insertBefore(stage, handles);
        let moved = false;
        const refresh = () => {
            handles.innerHTML = gridHandlesHtml(plan, owner);
            live.updateTask(makeReviewTask(source || blankTask(), plan, owner));
        };
        const move = ev => {
            const dx = (ev.clientX - x0) / scale, dy = (ev.clientY - y0) / scale;
            if (Math.abs(dx) + Math.abs(dy) < 1) return;
            moved = true;
            if (parent) {
                parent.children.forEach((child, i) => { child.weight = weights[i]; });
                T.moveSeam(plan.tree, parent.id, Number(hit.dataset.gridSeam.split(':')[1]), (parent.dir === 'h' ? dx : dy) / Math.max(1, length));
            } else if (phone && hit.dataset.gridResize != null) {
                Object.assign(phone, T.resizePhoneRect(phoneBefore, hit.dataset.corner || 'se', dx, dy, ev.shiftKey));
            } else if (phone) {
                phone.x = Math.round(phoneBefore.x + dx); phone.y = Math.round(phoneBefore.y + dy);
            } else if (hit.hasAttribute('data-grid-title')) {
                plan.title.anchor = { mode: 'custom', yPct: Math.max(0, Math.min(100, (T.resolveTitleY(before) + dy) / (T.canvasHeight(plan) / 100))) };
            }
            owner.plans[index] = plan;
            refresh();
        };
        const finish = ev => {
            el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', finish); el.removeEventListener('pointercancel', cancel);
            if (el.hasPointerCapture?.(event.pointerId)) el.releasePointerCapture(event.pointerId);
            if (moved) {
                (owner.previewUndo ||= []).push({ index, plan: before });
                plan.templateName = '手动调整'; owner.plans[index] = plan;
                const name = el.closest('.lt-card')?.querySelector('[data-plan-name]'); if (name) name.textContent = '手动调整';
                const undo = document.querySelector('#lt-panel [data-act="previewundo"]'); if (undo) undo.disabled = false;
                el._frame = { ...el._frame, task: makeReviewTask(source || blankTask(), plan, owner) };
                owner.onCommit?.(plan);
            }
        };
        const cancel = () => { owner.plans[index] = before; moved = false; plan.tree = clone(before.tree); live.updateTask(makeReviewTask(source || blankTask(), before, owner)); handles.innerHTML = gridHandlesHtml(before, owner); finish(); };
        el.setPointerCapture(event.pointerId);
        el.addEventListener('pointermove', move); el.addEventListener('pointerup', finish); el.addEventListener('pointercancel', cancel);
    }

    function showFrame(el) {
        if (!el._frame) return;
        expandedPreview?.dispose(); document.getElementById('lt-frame-view')?.remove();
        const view = document.createElement('div'); view.id = 'lt-frame-view';
        view.style.cssText = 'position:fixed;inset:0;background:#000e;z-index:10070;display:flex;align-items:center;justify-content:center;gap:16px;color:#fff';
        view.innerHTML = `<div data-stage style="height:86vh;aspect-ratio:${L().canvasWidth(st.scheme)}/${L().canvasHeight(st.scheme)};max-width:65vw"></div><div style="max-width:280px"><b>最终画面 · 与总览相同的播放器</b>
            <p>${el._frame.missing.length ? '缺少或无法读取：' + esc(el._frame.missing.join('、')) : '使用当前任务的素材和文字。'}</p>
            <button data-play>▶ 播放</button><button data-pause>⏸ 暂停</button><button data-close>关闭</button>
            <p><input data-seek aria-label="预览进度" type="range" min="0" max="100" value="0" style="width:240px"></p></div>`;
        const preview = window.ReelsOverviewPreview.create(el._frame.task);
        expandedPreview = preview;
        view.querySelector('[data-stage]').appendChild(preview.frame);
        view.querySelector('[data-play]').onclick = () => preview.player?.play();
        view.querySelector('[data-pause]').onclick = () => preview.player?.pause();
        view.querySelector('[data-seek]').oninput = event => preview.player?.seek((Number(event.target.value) / 100) * (preview.player?.getDuration() || 0));
        const dismiss = () => { preview.dispose(); if (expandedPreview === preview) expandedPreview = null; view.remove(); };
        view.querySelector('[data-close]').onclick = dismiss;
        view.addEventListener('click', event => { if (event.target === view) dismiss(); });
        document.body.appendChild(view);
    }

    function overlayDeps() {
        return {
            canvasDefaults: { targetWidth: window._reelsState?.targetWidth, targetHeight: window._reelsState?.targetHeight },
            newId: () => 'ov_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
            createImageOverlay: o => window.ReelsOverlay?.createImageOverlay ? window.ReelsOverlay.createImageOverlay(o) : { type: 'image', content: '', ...o },
            createSolidMaskOverlay: o => window.ReelsOverlay?.createSolidMaskOverlay ? window.ReelsOverlay.createSolidMaskOverlay(o) : { type: 'solid_mask', ...o },
            applySlot: (ov, key, label) => { if (window.ReelsLayerSlots?.apply) window.ReelsLayerSlots.apply(ov, key, label); else { ov.slotKey = key; ov.slotLabel = label; } },
            isLinked: ov => (window.ReelsBackgroundLibrary?.isBackgroundLinked ? window.ReelsBackgroundLibrary.isBackgroundLinked(ov) : ov?.backgroundLinked === true),
            syncLinked: (task, ov) => {
                const lib = window.ReelsBackgroundLibrary;
                if (lib?.syncLinkedMedia) lib.syncLinkedMedia({ overlays: [ov] }, task, (layer, value) => Object.assign(layer, value));
                else { const p = task.bgPath || task.videoPath || ''; ov.content = p; ov.type = /\.(png|jpe?g|webp|bmp)$/i.test(p) ? 'image' : 'video'; ov.media_loop = true; }
            },
        };
    }

    /** 由底板任务 + 规划结果生成新任务（不修改底板，不写入状态）。 */
    function buildTasks(base, plans, prefixInput, usedNames = []) {
        const deps = overlayDeps();
        const used = new Set(usedNames.filter(Boolean));
        const prefix = String(prefixInput || 'layout').replace(/[\\/:*?"<>|]/g, '_').trim() || 'layout';
        let n = 1;
        const nextName = () => { let name; do { name = `${prefix}_${String(n++).padStart(3, '0')}`; } while (used.has(name)); used.add(name); return name; };
        return plans.map(plan => {
            const t = JSON.parse(JSON.stringify(base));
            ['_batchProjection', '_batchTabId', '_batchTabName', '_batchTabOrder', '_batchTaskOrder', '_taskGroupOrder', 'versionTag'].forEach(k => delete t[k]);
            if (window.ReelsTaskDerivation?.rekeyTask) window.ReelsTaskDerivation.rekeyTask(t);
            else t.id = 'task_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
            L().applySchemeToTask(t, plan, deps);
            const name = nextName();
            t.baseName = name;
            t.fileName = `${name}.mp4`;
            t.exportName = name;
            t._exportSelected = true;
            return t;
        });
    }

    // 批量修改的目标任务（外部任务列表中的任务对象）。
    function modifyTargets() {
        const state = window._reelsState;
        const tasks = state?.tasks || [];
        if (st?.scope === 'selected') return tasks[state.selectedIdx] ? [tasks[state.selectedIdx]] : [];
        if (st?.scope === 'all') return tasks.filter(Boolean);
        return tasks.filter(t => t && t._exportSelected !== false);
    }
    function poolGuard() {
        if (poolTemplates().length) return true;
        toast('请先添加至少一个媒体组成相同的模板到本批', 'warning');
        return false;
    }
    function modifyExisting() {
        if (!poolGuard()) return;
        const state = window._reelsState;
        baseTask(); // 先把正在编辑的覆层写回选中任务
        const targets = modifyTargets();
        if (!targets.length) return alert('没有可修改的任务，请检查修改范围（勾选状态）');
        if (!confirm(`将按当前布局方案修改 ${targets.length} 个任务的布局（素材按层位保留）。确定？`)) return;
        if (typeof window.reelsSaveHistory === 'function') window.reelsSaveHistory();
        const plans = currentPlans();
        const deps = overlayDeps();
        targets.forEach((task, i) => { L().applySchemeToTask(task, plans[i] || plans[0], deps); });
        const selected = state.tasks[state.selectedIdx];
        const mgr = state.overlayProxy?.overlayMgr;
        // 预览管理器与选中任务共用覆层数组，换成新数组后再重新选中刷新预览。
        if (mgr && selected && targets.includes(selected) && !state._coverEditMode) mgr.overlays = selected.overlays;
        if (typeof _syncTasksToActiveTab === 'function') _syncTasksToActiveTab();
        if (typeof _skipNextApply !== 'undefined') _skipNextApply = true; // eslint-disable-line no-global-assign
        if (typeof _renderTaskList === 'function') _renderTaskList();
        if (typeof _renderBatchTable === 'function') _renderBatchTable();
        if (typeof reelsSelectTask === 'function' && state.selectedIdx >= 0) reelsSelectTask(state.selectedIdx);
        if (typeof _batchAutoSave === 'function') _batchAutoSave({ skipSync: true });
        if (typeof window.reelsSaveHistory === 'function') window.reelsSaveHistory();
        toast(`✅ 已修改 ${targets.length} 个任务的布局（${({ random: '随机', pool: '多模板分配' }[st.mode] || '统一')}）`);
        close();
    }

    function generate() {
        const state = window._reelsState;
        if (!state) return alert('任务列表尚未初始化');
        if (st.output === 'modify') return modifyExisting();
        if (!poolGuard()) return;
        const s = st.scheme;
        const base = JSON.parse(JSON.stringify(resolveBase()));
        // 底板没有文字卡片时自动补一张标题卡片，生成后可在批量表格里填写标题。
        ensureTitleLayer(base, s);
        const replace = st.output === 'replace';
        if (replace && !confirm('将清空当前标签页的全部任务，并替换为新生成的任务。确定？')) return;
        const hasTabs = typeof _batchTableState !== 'undefined' && typeof _getActiveTab === 'function';
        if (hasTabs && typeof _syncTasksToActiveTab === 'function') _syncTasksToActiveTab();
        const tab = hasTabs ? _getActiveTab() : null;
        const existing = replace ? [] : [...(state.tasks || []), ...(tab?.tasks || [])];
        const tasks = buildTasks(base, currentPlans(), st.prefix || s.name, existing.map(t => t?.baseName));
        const grouped = typeof _isBatchGroupedProjection === 'function' && _isBatchGroupedProjection(state.tasks);
        let firstIdx = 0;
        if (grouped && tab) {
            const clones = typeof _cloneBatchTasks === 'function' ? _cloneBatchTasks(tasks) : clone(tasks);
            tab.tasks = replace ? clones : [...(tab.tasks || []), ...clones];
            const ids = new Set(_batchTableState.appliedTabIds || []);
            ids.add(tab.id);
            _restoreGroupedProjectionFromTabs([...ids]);
            firstIdx = Math.max(0, state.tasks.findIndex(t => t._batchTabId === tab.id && t.id === tasks[0].id));
        } else {
            if (replace) state.tasks.length = 0;
            firstIdx = state.tasks.length;
            state.tasks.push(...tasks);
            // 外部任务列表与批量表格同一标签页保持一致：同时写入标签页存档。
            if (tab) {
                const clones = typeof _cloneBatchTasks === 'function' ? _cloneBatchTasks(tasks) : clone(tasks);
                tab.tasks = replace ? clones : [...(tab.tasks || []), ...clones];
            }
        }
        if (typeof _skipNextApply !== 'undefined') _skipNextApply = true; // eslint-disable-line no-global-assign
        if (typeof _renderTaskList === 'function') _renderTaskList();
        if (typeof _renderBatchTable === 'function') _renderBatchTable();
        if (typeof reelsSelectTask === 'function' && state.tasks[firstIdx]) reelsSelectTask(firstIdx);
        if (typeof _batchAutoSave === 'function') _batchAutoSave({ skipSync: true });
        if (typeof window.reelsSaveHistory === 'function') window.reelsSaveHistory();
        toast(`✅ 已在当前标签页生成 ${tasks.length} 个任务（${({ random: '随机', pool: '多模板分配' }[st.mode] || '统一')}布局）`);
        close();
    }

    const inlineSessions = new Map();
    function stopInlineLayout(stage) {
        const sessions = stage ? [inlineSessions.get(stage)].filter(Boolean) : [...inlineSessions.values()];
        releaseGridPreview();
        sessions.forEach(current => {
            inlineSessions.delete(current.stage);
            current.stage.onpointerdown = current.pointer;
            current.handles.remove(); current.tools.remove(); current.stage.classList.remove('lt-inline-layout');
            current.onClose?.();
        });
    }
    function toggleInlineLayout(stage, task, onDone, onClose, options = {}) {
        if (!stage || !task) return false;
        if (inlineSessions.has(stage)) { stopInlineLayout(stage); return false; }
        baseTask();
        let scheme;
        try { scheme = L().schemeFromTask(task); }
        catch (error) { if (!options.quiet) toast(error.message, 'warning'); return false; }
        injectStyle();
        const owner = { sourceTask: task, output: 'modify', previewEditing: true, plans: [scheme], previewUndo: [] };
        const persist = plan => {
            window.reelsSaveHistory?.();
            L().applySchemeToTask(task, plan, overlayDeps());
            const rs = window._reelsState;
            if (rs?.tasks?.[rs.selectedIdx] === task && rs.overlayProxy?.overlayMgr) rs.overlayProxy.overlayMgr.overlays = task.overlays;
            if (typeof _syncTasksToActiveTab === 'function') _syncTasksToActiveTab();
            if (typeof _batchAutoSave === 'function') _batchAutoSave({ skipSync: true });
            window.reelsSaveHistory?.(); onDone?.(task);
        };
        owner.onCommit = persist;
        const tools = document.createElement('div');
        tools.style.cssText = 'position:absolute;left:4px;bottom:4px;z-index:120;display:flex;gap:4px;background:#151924e8;color:white;padding:6px;border-radius:5px;font-size:11px;pointer-events:auto';
        tools.innerHTML = '<span>拖蓝线调整布局</span><button data-inline-undo>撤销</button><button data-inline-done>完成布局</button>';
        const pointer = stage.onpointerdown;
        stage.classList.add('lt-inline-layout');
        mountGridEditor(stage, owner, 0);
        const handles = stage.querySelector('.lt-grid-handles');
        stage.appendChild(tools);
        inlineSessions.set(stage, { task, stage, pointer, handles, tools, onClose });
        if (options.hideTools) tools.style.display = 'none';
        tools.onpointerdown = event => event.stopPropagation();
        tools.querySelector('[data-inline-done]').onclick = event => { event.stopPropagation(); stopInlineLayout(stage); };
        tools.querySelector('[data-inline-undo]').onclick = event => {
            event.stopPropagation();
            const previous = owner.previewUndo.pop(); if (!previous) return;
            owner.plans[0] = previous.plan; releaseGridPreview();
            handles.innerHTML = gridHandlesHtml(previous.plan, owner); persist(previous.plan);
        };
        return true;
    }
    function openTask(task, onDone) {
        if (!task) return toast('请先选择一个任务', 'warning');
        baseTask();
        let scheme;
        try { scheme = L().schemeFromTask(task); }
        catch (error) { return toast(error.message, 'warning'); }
        open({ scheme, label: `任务布局：${task.baseName || task.fileName || ''}`, onDone: edited => {
            window.reelsSaveHistory?.();
            L().applySchemeToTask(task, edited, overlayDeps());
            const rs = window._reelsState;
            if (rs?.tasks?.[rs.selectedIdx] === task && rs.overlayProxy?.overlayMgr) rs.overlayProxy.overlayMgr.overlays = task.overlays;
            if (typeof _syncTasksToActiveTab === 'function') _syncTasksToActiveTab();
            if (typeof _batchAutoSave === 'function') _batchAutoSave({ skipSync: true });
            window.ReelsPreviewV2?.refresh?.();
            window.reelsSaveHistory?.(); onDone?.(task);
            window.dispatchEvent(new CustomEvent('reels-task-media-changed', { detail: task }));
            toast('已保存该任务的布局修改');
        } });
    }
    window.reelsOpenLayoutBatch = open;
    window.ReelsLayoutEditor = { open, close, buildTasks };
    window.ReelsLayoutEditor.openTask = openTask;
    window.ReelsLayoutEditor.toggleInlineLayout = toggleInlineLayout;
    window.ReelsLayoutEditor.stopInlineLayout = stopInlineLayout;
})();
