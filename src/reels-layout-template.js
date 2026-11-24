/**
 * reels-layout-template.js — 布局模板引擎（纯逻辑，不依赖 DOM）
 *
 * 用“分割树”描述讲道 / 主观众 / 观众媒体块：
 *   分支节点 { id, dir:'h'|'v', weight, locked, children:[...] }
 *   叶子节点 { id, role:'sermon'|'main'|'audience', weight, locked }
 * dir='h' 子块左右排列，dir='v' 子块上下排列；weight 为同级占比。
 * 调整某块占比时，同级未锁定的兄弟块按原比例分摊剩余空间。
 * 最终输出为普通 image/video 覆层（PIP 窗口 + 裁剪填满），渲染/导出无需改动。
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.ReelsLayoutTemplate = factory();
})(typeof window === 'object' ? window : globalThis, function () {
    'use strict';
    const CANVAS = Object.freeze({ w: 1080, h: 1920 });
    const canvasDimension = (value, fallback) => Number.isFinite(Number(value)) && Number(value) >= 64 && Number(value) <= 8192 ? Math.round(Number(value)) : fallback;
    const canvasWidth = scheme => canvasDimension(scheme?.canvasWidth, 1080);
    const canvasHeight = scheme => canvasDimension(scheme?.canvasHeight, 1920);
    function taskCanvas(task, defaults = {}) {
        const scheme = task?._layoutScheme;
        return scheme ? { width: canvasWidth(scheme), height: canvasHeight(scheme) }
            : { width: canvasDimension(defaults.targetWidth, 1080), height: canvasDimension(defaults.targetHeight, 1920) };
    }
    function fitPhoneToCanvas(scheme) {
        const width = canvasWidth(scheme), height = canvasHeight(scheme);
        const w = Math.min(width, height * 9 / 16), h = w * 16 / 9;
        return {x:(width-w)/2, y:(height-h)/2, w, h};
    }
    function resizePhoneRect(before, corner, dx, dy, free = false) {
        const left = corner.includes('w'), top = corner.includes('n');
        let w = Math.max(40, before.w + (left ? -dx : dx));
        let h = Math.max(40, before.h + (top ? -dy : dy));
        if (!free) {
            const factor = Math.abs(dx / before.w) >= Math.abs(dy / before.h) ? w / before.w : h / before.h;
            const bounded = Math.max(factor, 40 / before.w, 40 / before.h);
            w = before.w * bounded; h = before.h * bounded;
        }
        w = Math.round(w); h = Math.round(h);
        return {x: left ? before.x + before.w - w : before.x, y: top ? before.y + before.h - h : before.y, w, h};
    }
    function resizeOverlayGeometry(overlay, from, to) {
        const sx = to.width / from.width, sy = to.height / from.height;
        const scale = (obj, keys, factor) => keys.forEach(key => {
            if (typeof obj[key] === 'number' && Number.isFinite(obj[key])) obj[key] *= factor;
        });
        scale(overlay, ['x','w','offset_x','title_offset_x','body_offset_x','footer_offset_x','title_override_w','body_override_w','footer_override_w','scroll_offset_x','title_adaptive_min_w','title_adaptive_max_w'], sx);
        scale(overlay, ['y','h','offset_y','title_offset_y','body_offset_y','footer_offset_y','title_override_h','body_override_h','footer_override_h','scroll_offset_y','title_adaptive_min_h','title_adaptive_max_h'], sy);
        scale(overlay, ['fontsize','font_size','title_fontsize','body_fontsize','footer_fontsize','title_preferred_glyph_height','title_max_glyph_height','padding_left','padding_right'], sx);
        scale(overlay, ['padding_top','padding_bottom','title_body_gap','body_footer_gap'], sy);
        if (overlay.media_window) {
            scale(overlay.media_window, ['x','w'], sx);
            scale(overlay.media_window, ['y','h'], sy);
        }
    }
    const MANAGED_SLOT = /^(pip_sermon|pip_audience|phone_primary|phone_secondary|background_layer)(_|$)|^custom:extra_\d+$/;
    let seq = 0;
    const nid = () => `ln_${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    const clone = value => JSON.parse(JSON.stringify(value));
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

    // ── 树构造 ──
    const leaf = (role, weight = 1) => ({ id: nid(), role, weight, locked: false });
    const split = (dir, children, weight = 1) => {
        const list = children.filter(Boolean);
        if (!list.length) return null;
        if (list.length === 1) { list[0].weight = weight; return list[0]; }
        return { id: nid(), dir, weight, locked: false, children: list };
    };
    const isLeaf = node => !node?.children?.length;

    function walk(node, fn, parent = null, depth = 0) {
        if (!node) return;
        fn(node, parent, depth);
        (node.children || []).forEach(child => walk(child, fn, node, depth + 1));
    }
    function findNode(tree, id) {
        let found = null, parent = null;
        walk(tree, (node, p) => { if (!found && node.id === id) { found = node; parent = p; } });
        return found ? { node: found, parent } : null;
    }
    function leaves(tree) { const out = []; walk(tree, n => { if (isLeaf(n)) out.push(n); }); return out; }
    function normalizeWeights(node) {
        walk(node, n => {
            if (isLeaf(n)) return;
            const sum = n.children.reduce((s, c) => s + Math.max(0, num(c.weight, 1)), 0) || n.children.length;
            n.children.forEach(c => { c.weight = sum ? Math.max(0, num(c.weight, 1)) / sum : 1 / n.children.length; });
        });
        return node;
    }
    function countRoles(tree) {
        const c = { sermon: 0, main: 0, audience: 0, extra: 0 };
        leaves(tree).forEach(l => { if (c[l.role] != null) c[l.role]++; });
        return c;
    }

    // ── 推荐布局生成 ──
    /**
     * 把 roles 均匀分成 lines 条：dir='v' 时为上下排列的若干行（行内左右排列），
     * dir='h' 时为左右排列的若干列（列内上下排列）。前面的行/列多分一个，避免单块被拉得过大。
     */
    function grid(roles, lines = 1, dir = 'v') {
        const n = roles.length;
        if (!n) return null;
        if (n === 1) return leaf(roles[0]);
        lines = clamp(lines | 0, 1, n);
        const cross = dir === 'v' ? 'h' : 'v';
        const rows = [];
        let at = 0;
        for (let i = 0; i < lines; i++) {
            const size = Math.floor(n / lines) + (i < n % lines ? 1 : 0);
            rows.push(roles.slice(at, at + size));
            at += size;
        }
        if (rows.length === 1) return split(cross, rows[0].map(r => leaf(r)));
        return split(dir, rows.map(row => (row.length === 1 ? leaf(row[0]) : split(cross, row.map(r => leaf(r))))));
    }
    const wideLines = n => (n <= 3 ? 1 : n <= 8 ? 2 : 3);
    // 宽区域：主观众在左/右占大块，其余观众排成列；窄高区域：主观众在上/下，其余观众排成行。
    function othersBlock(comp, wide, mainFirst = true) {
        const n = Math.max(0, comp.audience | 0);
        const aud = Array(n).fill('audience');
        if (!comp.main) return wide ? grid(aud, wideLines(n), 'v') : grid(aud, n <= 3 ? 1 : 2, 'h');
        const main = leaf('main', 1);
        if (!n) return main;
        const rest = wide ? grid(aud, n <= 3 ? 1 : 2, 'h') : grid(aud, n <= 2 ? 1 : 2, 'v');
        main.weight = 0.58; rest.weight = 0.42;
        return split(wide ? 'h' : 'v', mainFirst ? [main, rest] : [rest, main]);
    }
    /**
     * pattern:
     *   stack — 讲道在上/下/左/右整条，其余排网格
     *   wrap  — 讲道与一列观众并排组成一条带（类似常见“2+讲道+2”），其余观众另起一行
     *   grid  — 无讲道时的纯观众网格
     *   mosaic — 不规则拼贴：观众区域随机递归切分，大小、方向、比例都不统一
     */
    // 不规则拼贴：把 roles 随机分成两组，按区域宽高比（带随机扰动）选横切或竖切，比例不对称。
    function mosaic(roles, w, h, r) {
        if (roles.length === 1) return leaf(roles[0]);
        const hasMain = roles[0] === 'main';
        const k = hasMain ? 1 : 1 + Math.floor(r() * (roles.length - 1));
        const a = roles.slice(0, k), b = roles.slice(k);
        const horizontal = (w / h) * (0.55 + r() * 0.9) > 1;
        const base = hasMain ? 0.5 + r() * 0.12 : k / roles.length;
        const fa = clamp(base + (hasMain ? 0 : (r() * 2 - 1) * 0.18), 0.22, 0.78);
        const left = mosaic(a, horizontal ? w * fa : w, horizontal ? h : h * fa, r);
        const right = mosaic(b, horizontal ? w * (1 - fa) : w, horizontal ? h : h * (1 - fa), r);
        left.weight = fa; right.weight = 1 - fa;
        return { id: nid(), dir: horizontal ? 'h' : 'v', weight: 1, locked: false, children: r() < 0.5 || hasMain ? [left, right] : [right, left] };
    }
    function generateTree(comp, opts = {}) {
        comp = { sermon: comp.sermon ? 1 : 0, main: comp.main ? 1 : 0, audience: Math.max(0, comp.audience | 0) };
        const others = comp.main + comp.audience;
        if (!comp.sermon && !others) return null;
        const pos = opts.sermonPos || 'top';
        const share = clamp(num(opts.sermonShare, 0.5), 0.15, 0.85);
        const mainFirst = opts.mainFirst !== false;
        let pattern = opts.pattern || 'stack';
        if (!comp.sermon) pattern = 'grid';
        if (pattern === 'wrap' && others < 2) pattern = 'stack';
        let tree;
        if (pattern === 'mosaic' && others >= 2) {
            const r = opts.rng || rng(others * 31 + 7);
            const roles = [...(comp.main ? ['main'] : []), ...Array(comp.audience).fill('audience')];
            if (!comp.sermon) tree = mosaic(roles, canvasWidth(opts), canvasHeight(opts), r);
            else {
                const vertical = pos === 'top' || pos === 'bottom';
                const sermon = leaf('sermon', share);
                const rest = mosaic(roles, vertical ? canvasWidth(opts) : canvasWidth(opts) * (1 - share), vertical ? canvasHeight(opts) * (1 - share) : canvasHeight(opts), r);
                rest.weight = 1 - share;
                const first = pos === 'top' || pos === 'left';
                tree = split(vertical ? 'v' : 'h', first ? [sermon, rest] : [rest, sermon]);
            }
        } else if (pattern === 'grid' || (pattern === 'mosaic' && !comp.sermon)) {
            tree = othersBlock(comp, false, mainFirst);
        } else if (!others) {
            tree = leaf('sermon');
        } else if (pattern === 'wrap') {
            const sideRight = pos !== 'left';
            const bandBottom = opts.bandPos === 'bottom';
            // 带内一列：有主观众时只放主观众，否则放一到两位观众。
            const colRoles = comp.main ? ['main'] : Array(Math.min(2, others - 1)).fill('audience');
            const remaining = Array(comp.audience - (comp.main ? 0 : colRoles.length)).fill('audience');
            const col = colRoles.length === 1 ? leaf(colRoles[0]) : split('v', colRoles.map(r => leaf(r)));
            col.weight = comp.main ? 0.45 : 0.42;
            const sermon = leaf('sermon', 1 - col.weight);
            const band = split('h', sideRight ? [col, sermon] : [sermon, col], remaining.length ? clamp(share + 0.12, 0.4, 0.8) : 1);
            const rest = grid(remaining, wideLines(remaining.length), 'v');
            if (rest) rest.weight = 1 - band.weight;
            tree = split('v', bandBottom ? [rest, band] : [band, rest]);
        } else {
            const vertical = pos === 'top' || pos === 'bottom';
            const sermon = leaf('sermon', share);
            const rest = othersBlock(comp, vertical, mainFirst);
            rest.weight = 1 - share;
            const first = pos === 'top' || pos === 'left';
            tree = split(vertical ? 'v' : 'h', first ? [sermon, rest] : [rest, sermon]);
        }
        tree.weight = 1;
        return normalizeWeights(tree);
    }

    // ── 方案 ──
    function defaultScheme(overrides = {}) {
        overrides = overrides || {};
        // 默认带一个全屏电话主层；电话次层需手动添加。
        const comp = { sermon: 1, main: 0, audience: 2, phonePrimary: 1, phoneSecondary: 0, ...(overrides.composition || {}) };
        const scheme = {
            id: overrides.id || `layout_${Date.now().toString(36)}`,
            name: overrides.name || '新布局方案',
            canvasWidth: canvasWidth(overrides),
            canvasHeight: canvasHeight(overrides),
            version: 1,
            composition: comp,
            area: { top: 0, bottom: 0, left: 0, right: 0, ...(overrides.area || {}) },
            gap: num(overrides.gap, 0),
            radius: num(overrides.radius, 0),
            mainRatio: num(overrides.mainRatio, 1.5),
            audienceBlockAspect: overrides.audienceBlockAspect || '',
            pattern: overrides.pattern || 'stack',
            sermonPos: overrides.sermonPos || 'top',
            bandPos: overrides.bandPos || 'top',
            tree: null,
            title: { enabled: true, layerKey: '', anchor: { mode: 'seam', index: 0 }, ...(overrides.title || {}) },
            phones: [],
            // 额外媒体层：mode='split' 参与分割（树中 role='extra' 的叶子），mode='full' 全屏浮层。
            extras: Array.isArray(overrides.extras) ? clone(overrides.extras) : [],
            backdrop: { mode: 'none', color: '#000000', content: '', ...(overrides.backdrop || {}) },
            random: {
                patterns: ['stack', 'wrap', 'mosaic'], sermonPositions: ['top', 'bottom'], bandPositions: ['top', 'bottom'],
                jitter: 10, randomMain: true, randomTitle: true, avoidRepeat: true, seed: 1, ...(overrides.random || {}),
            },
        };
        scheme.tree = overrides.tree ? clone(overrides.tree) : generateTree(comp, scheme);
        if (Array.isArray(overrides.phones)) scheme.phones = clone(overrides.phones);
        if (overrides.autoPhoneSecondary === false) scheme.autoPhoneSecondary = false;
        if (overrides._autoSecondary) scheme._autoSecondary = true;
        syncPhones(scheme);
        reconcileExtras(scheme);
        applyAutoPhone(scheme);
        return scheme;
    }
    /** 讲道块是否为横跨整个可分配区域的上下通栏。 */
    function sermonIsBand(scheme) {
        const sermon = computeBlocks(scheme).find(b => b.role === 'sermon');
        if (!sermon) return true;
        return sermon.w >= areaRect(scheme).w - 1;
    }
    /**
     * 讲道不是上下通栏（左右并排、成带、拼贴等）时默认带一个电话次层；
     * 自动加上的次层在布局变回上下通栏时自动去掉。用户手动设置的数量不受影响。
     */
    function applyAutoPhone(scheme) {
        if (!scheme?.tree || scheme.autoPhoneSecondary === false) return scheme;
        const comp = scheme.composition || (scheme.composition = {});
        const need = !sermonIsBand(scheme);
        if (need && !(comp.phoneSecondary | 0)) { comp.phoneSecondary = 1; scheme._autoSecondary = true; syncPhones(scheme); }
        else if (!need && scheme._autoSecondary && (comp.phoneSecondary | 0) === 1) { comp.phoneSecondary = 0; scheme._autoSecondary = false; syncPhones(scheme); }
        return scheme;
    }
    /** 读取已保存/导入的方案：补齐新版本字段，保留原有布局与电话位置。 */
    function hydrateScheme(saved) {
        if (!saved || typeof saved !== 'object') return defaultScheme();
        const s = defaultScheme(saved);
        if (saved.updatedAt) s.updatedAt = saved.updatedAt;
        const c = countRoles(s.tree);
        if (!s.tree || c.sermon !== (s.composition.sermon ? 1 : 0) || c.main !== (s.composition.main ? 1 : 0) || c.audience !== (s.composition.audience | 0)) {
            s.tree = generateTree(s.composition, s);
            reconcileExtras(s);
        }
        return applyAutoPhone(s);
    }
    function areaRect(scheme) {
        const a = scheme.area || {}, height = canvasHeight(scheme), width = canvasWidth(scheme);
        const left = clamp(num(a.left), 0, width - 40), right = clamp(num(a.right), 0, width - left - 40);
        const top = clamp(num(a.top), 0, height - 40), bottom = clamp(num(a.bottom), 0, height - top - 40);
        return { x: left, y: top, w: width - left - right, h: height - top - bottom };
    }
    function mirrorLayout(scheme, direction = 'horizontal') {
        const result = clone(scheme);
        const vertical = direction === 'vertical';
        const titleY = vertical && result.title?.enabled ? resolveTitleY(result) : null;
        const mirrorTree = node => {
            if (!node?.children?.length) return;
            if (node.dir === (vertical ? 'v' : 'h')) node.children.reverse();
            node.children.forEach(mirrorTree);
        };
        mirrorTree(result.tree);
        if (result.area) {
            if (vertical) [result.area.top, result.area.bottom] = [result.area.bottom, result.area.top];
            else [result.area.left, result.area.right] = [result.area.right, result.area.left];
        }
        const width = canvasWidth(result), height = canvasHeight(result);
        for (const phone of result.phones || []) {
            if (vertical) phone.y = height - num(phone.y) - num(phone.h);
            else phone.x = width - num(phone.x) - num(phone.w);
        }
        if (titleY !== null) result.title.anchor = { mode: 'custom', yPct: (height - titleY) / height * 100 };
        return result;
    }
    // 电话层：数量变化时保留已有位置，只增删末尾。
    function phoneKey(role, index, count) { return count > 1 ? `${role}_${index}` : role; }
    function syncPhones(scheme) {
        const comp = scheme.composition || {}, height = canvasHeight(scheme), width = canvasWidth(scheme);
        const old = Array.isArray(scheme.phones) ? scheme.phones : [];
        const out = [];
        [['phone_primary', comp.phonePrimary | 0], ['phone_secondary', comp.phoneSecondary | 0]].forEach(([role, count], group) => {
            const existing = old.filter(p => p.role === role);
            for (let i = 1; i <= count; i++) {
                const prev = existing[i - 1];
                const w = Math.min(300, width, height * 9 / 16), h = w * 16 / 9;
                // 电话图片独立保持 9:16，不继承视频画布比例。
                const base = prev || (role === 'phone_primary'
                    ? { ...fitPhoneToCanvas(scheme), content: '' }
                    : { x: width - w - 40 - (i - 1) * 40, y: height - h - 160 - (i - 1) * 40, w, h, content: '' });
                out.push({ ...base, role, index: i, key: phoneKey(role, i, count) });
            }
        });
        scheme.phones = out;
        return scheme;
    }
    function setComposition(scheme, comp) {
        scheme.composition = { ...scheme.composition, ...comp };
        const c = scheme.composition, cur = scheme.tree ? countRoles(scheme.tree) : null;
        if (!cur || cur.sermon !== (c.sermon ? 1 : 0) || cur.main !== (c.main ? 1 : 0) || cur.audience !== (c.audience | 0)) {
            scheme.tree = generateTree(c, scheme);
            reconcileExtras(scheme);
            enforceConstraints(scheme);
        }
        syncPhones(scheme);
        return applyAutoPhone(scheme);
    }

    // ── 额外媒体层 ──
    function addExtra(scheme, opts = {}) {
        scheme.extras = Array.isArray(scheme.extras) ? scheme.extras : [];
        const used = new Set(scheme.extras.map(e => e.key));
        let n = 1;
        while (used.has(`custom:extra_${n}`)) n++;
        const extra = { id: nid(), key: `custom:extra_${n}`, name: opts.name || `媒体层 ${n}`, mode: opts.mode === 'split' ? 'split' : 'full',
            layer: opts.layer === 'below' ? 'below' : 'above', content: opts.content || '' };
        scheme.extras.push(extra);
        return extra;
    }
    /** 让“参与分割”的额外层在树里恰好有一个块；全屏/已删除的额外层不占块。r 给定时随机挑位置。 */
    function reconcileExtras(scheme, r = null) {
        if (!scheme?.tree) return scheme;
        const extras = Array.isArray(scheme.extras) ? scheme.extras : (scheme.extras = []);
        const splitIds = new Set(extras.filter(e => e.mode === 'split').map(e => e.id));
        const seen = new Set();
        leaves(scheme.tree).forEach(l => {
            if (l.role !== 'extra') return;
            if (!splitIds.has(l.extraId) || seen.has(l.extraId)) {
                const id = l.id;
                if (leaves(scheme.tree).length > 1) scheme.tree = removeBlock(scheme.tree, id);
                else { l.role = 'audience'; delete l.extraId; }
            } else seen.add(l.extraId);
        });
        extras.filter(e => e.mode === 'split' && !seen.has(e.id)).forEach(extra => {
            const blocks = computeBlocks(scheme);
            const pool = blocks.filter(b => b.role === 'audience' || b.role === 'main');
            const list = pool.length ? pool : blocks;
            const target = r ? list[Math.floor(r() * list.length)] : list.reduce((a, b) => (b.area > a.area ? b : a), list[0]);
            if (!target) return;
            const f = findNode(scheme.tree, target.id);
            const old = f.node;
            const fresh = { id: nid(), role: 'extra', extraId: extra.id, weight: 0.5, locked: false };
            const box = { id: nid(), dir: target.w >= target.h ? 'h' : 'v', weight: old.weight, locked: false, children: r && r() < 0.5 ? [fresh, old] : [old, fresh] };
            old.weight = 0.5;
            if (!f.parent) { box.weight = 1; scheme.tree = box; } else f.parent.children[f.parent.children.indexOf(old)] = box;
        });
        return scheme;
    }
    /** 把某个块改成指定额外层（参与分割）；该额外层原来的块换成此块原角色。 */
    function assignExtra(scheme, leafId, extraId) {
        const target = findNode(scheme.tree, leafId)?.node;
        const extra = (scheme.extras || []).find(e => e.id === extraId);
        if (!target || !isLeaf(target) || !extra) return false;
        const holder = leaves(scheme.tree).find(l => l.role === 'extra' && l.extraId === extraId && l !== target);
        if (holder) { holder.role = target.role; if (target.extraId) holder.extraId = target.extraId; else delete holder.extraId; }
        else if (target.role === 'extra') {
            const prev = (scheme.extras || []).find(e => e.id === target.extraId);
            if (prev) prev.mode = 'full';
        }
        target.role = 'extra';
        target.extraId = extraId;
        extra.mode = 'split';
        return true;
    }
    function removeExtra(scheme, extraId) {
        scheme.extras = (scheme.extras || []).filter(e => e.id !== extraId);
        return reconcileExtras(scheme);
    }

    // ── 计算矩形 ──
    function layoutNode(node, rect, gap, out, path) {
        if (isLeaf(node)) { out.push({ node, rect, path }); return; }
        const horizontal = node.dir === 'h';
        const n = node.children.length;
        const start = horizontal ? rect.x : rect.y;
        const total = horizontal ? rect.w : rect.h;
        const avail = Math.max(0, total - gap * (n - 1));
        const sum = node.children.reduce((s, c) => s + Math.max(0, num(c.weight, 1)), 0) || n;
        let acc = 0;
        node.children.forEach((child, i) => {
            const a = start + Math.round(avail * acc / sum) + gap * i;
            acc += Math.max(0, num(child.weight, 1));
            const b = i === n - 1 ? start + total : start + Math.round(avail * acc / sum) + gap * i;
            const r = horizontal ? { x: a, y: rect.y, w: b - a, h: rect.h } : { x: rect.x, y: a, w: rect.w, h: b - a };
            layoutNode(child, r, gap, out, path.concat(node.id));
        });
    }
    function parseAspectRatio(spec) {
        if (!spec || spec === 'free') return 0;
        const m = String(spec).trim().match(/^(\d+(?:\.\d+)?)\s*[:/x×]\s*(\d+(?:\.\d+)?)$/i);
        if (!m) return 0;
        const w = Number(m[1]), h = Number(m[2]);
        return w > 0 && h > 0 ? w / h : 0;
    }
    function fitAspectRect(rect, ratio) {
        if (!(ratio > 0) || !(rect.w > 0 && rect.h > 0)) return rect;
        let w = rect.w, h = rect.h;
        if (w / h > ratio) w = Math.max(1, Math.round(h * ratio));
        else h = Math.max(1, Math.round(w / ratio));
        return { x: Math.round(rect.x + (rect.w - w) / 2), y: Math.round(rect.y + (rect.h - h) / 2), w, h };
    }
    function optimizeAudienceAspectWeights(scheme) {
        const ratio = parseAspectRatio(scheme?.audienceBlockAspect);
        if (!(ratio > 0) || !scheme?.tree) return scheme;
        const gap = Math.max(0, num(scheme.gap));
        const area = areaRect(scheme);
        const walk = (node, rect) => {
            if (isLeaf(node) || !node.children?.length) return;
            const n = node.children.length;
            const horizontal = node.dir === 'h';
            const total = horizontal ? rect.w : rect.h;
            const avail = Math.max(20, total - gap * (n - 1));
            const sum = node.children.reduce((s, c) => s + Math.max(0, num(c.weight, 1)), 0) || 1;
            const unlocked = node.children.filter(c => !c.locked);
            if (unlocked.length >= 2) {
                const lockedSum = node.children.filter(c => c.locked).reduce((s, c) => s + Math.max(0, num(c.weight, 1)) / sum, 0);
                const freeFrac = Math.max(0.1, 1 - lockedSum);
                const next = new Map();
                let changed = false;
                for (const c of unlocked) {
                    const curFrac = Math.max(0.05, num(c.weight, 1) / sum);
                    if (isLeaf(c) && c.role === 'audience') {
                        const cw = horizontal ? avail * curFrac : rect.w;
                        const ch = horizontal ? rect.h : avail * curFrac;
                        if (horizontal && cw / ch > ratio * 1.02) {
                            next.set(c, clamp((ch * ratio) / avail, 0.08, freeFrac - 0.08 * (unlocked.length - 1)));
                            changed = true;
                            continue;
                        }
                        if (!horizontal && cw / ch < ratio * 0.98) {
                            next.set(c, clamp((cw / ratio) / avail, 0.08, freeFrac - 0.08 * (unlocked.length - 1)));
                            changed = true;
                            continue;
                        }
                    }
                    next.set(c, curFrac);
                }
                if (changed) {
                    const fixedSum = [...next.entries()].filter(([c]) => c.role === 'audience' && isLeaf(c)).reduce((s, [, v]) => s + v, 0);
                    const flex = unlocked.filter(c => !(c.role === 'audience' && isLeaf(c)));
                    if (flex.length && fixedSum < freeFrac - 0.05 * flex.length) {
                        const flexCur = flex.reduce((s, c) => s + next.get(c), 0) || 1;
                        const rem = freeFrac - fixedSum;
                        flex.forEach(c => next.set(c, rem * next.get(c) / flexCur));
                    }
                    const nextTotal = [...next.values()].reduce((s, v) => s + v, 0) || 1;
                    unlocked.forEach(c => { c.weight = Math.max(0.05, next.get(c) * (freeFrac / nextTotal)); });
                    node.children.filter(c => c.locked).forEach(c => { c.weight = Math.max(0, num(c.weight, 1) / sum); });
                }
            }
            const newSum = node.children.reduce((s, c) => s + Math.max(0, num(c.weight, 1)), 0) || 1;
            let acc = 0;
            const start = horizontal ? rect.x : rect.y;
            node.children.forEach((child, i) => {
                const a = start + Math.round(avail * acc / newSum) + gap * i;
                acc += Math.max(0, num(child.weight, 1));
                const b = i === n - 1 ? start + total : start + Math.round(avail * acc / newSum) + gap * i;
                const r = horizontal ? { x: a, y: rect.y, w: b - a, h: rect.h } : { x: rect.x, y: a, w: rect.w, h: b - a };
                walk(child, r);
            });
        };
        for (let pass = 0; pass < 3; pass++) walk(scheme.tree, area);
        return scheme;
    }
    /** 返回每个媒体块的位置与槽位；观众按阅读顺序（上→下、左→右）编号。 */
    function computeBlocks(scheme) {
        if (!scheme?.tree) return [];
        const out = [];
        layoutNode(scheme.tree, areaRect(scheme), Math.max(0, num(scheme.gap)), out, []);
        const forcedRatio = parseAspectRatio(scheme.audienceBlockAspect);
        if (forcedRatio > 0) {
            for (const b of out) {
                if (b.node.role === 'audience') b.rect = fitAspectRect(b.rect, forcedRatio);
            }
        }
        const aud = out.filter(b => b.node.role === 'audience')
            .sort((a, b) => (Math.abs(a.rect.y - b.rect.y) > 8 ? a.rect.y - b.rect.y : a.rect.x - b.rect.x));
        return out.map(b => {
            const role = b.node.role;
            let slotKey = 'pip_sermon', label = '画中画（讲道）', index = 0;
            if (role === 'main') { slotKey = 'pip_audience_main'; label = '画中画（主观众）'; }
            else if (role === 'extra') {
                const extra = (scheme.extras || []).find(e => e.id === b.node.extraId) || {};
                slotKey = extra.key || 'custom:extra_0'; label = extra.name || '媒体层';
            }
            else if (role === 'audience') { index = aud.indexOf(b) + 1; slotKey = `pip_audience_${index}`; label = `画中画（观众） ${index}`; }
            return { id: b.node.id, role, index, slotKey, label, ...b.rect, area: b.rect.w * b.rect.h, path: b.path };
        });
    }
    /** 横跨整个可分配区域宽度的分割线（标题可压在上面）。 */
    function seams(scheme) {
        const tree = scheme?.tree;
        if (!tree || isLeaf(tree) || tree.dir !== 'v') return [];
        const out = [];
        layoutNode(tree, areaRect(scheme), Math.max(0, num(scheme.gap)), out, []);
        const tops = tree.children.map(child => {
            const ys = out.filter(b => b.path.includes(child.id) || b.node === child).map(b => b.rect);
            return { top: Math.min(...ys.map(r => r.y)), bottom: Math.max(...ys.map(r => r.y + r.h)) };
        });
        const list = [];
        for (let i = 0; i < tops.length - 1; i++) list.push(Math.round((tops[i].bottom + tops[i + 1].top) / 2));
        return list;
    }
    function titleCandidates(scheme) {
        const r = areaRect(scheme);
        const list = seams(scheme).map((y, i) => ({ key: `seam:${i}`, mode: 'seam', index: i, y, label: `分割线 ${i + 1}（y=${y}）` }));
        list.push({ key: 'top', mode: 'top', y: Math.round(r.y / 2), label: `上方留白区（y=${Math.round(r.y / 2)}）` });
        list.push({ key: 'bottom', mode: 'bottom', y: Math.round(r.y + r.h + (canvasHeight(scheme) - r.y - r.h) / 2), label: '下方留白区' });
        return list;
    }
    function resolveTitleY(scheme, anchor = scheme?.title?.anchor || {}) {
        const cands = titleCandidates(scheme);
        if (anchor.mode === 'custom') return Math.round(canvasHeight(scheme) * clamp(num(anchor.yPct, 50), 0, 100) / 100);
        if (anchor.mode === 'top') return cands.find(c => c.mode === 'top').y;
        if (anchor.mode === 'bottom') return cands.find(c => c.mode === 'bottom').y;
        const s = cands.filter(c => c.mode === 'seam');
        if (!s.length) return Math.round(canvasHeight(scheme) / 2);
        return s[clamp(num(anchor.index) | 0, 0, s.length - 1)].y;
    }

    // ── 占比调整 ──
    function shareOf(tree, id) {
        const f = findNode(tree, id);
        if (!f?.parent) return 1;
        const sum = f.parent.children.reduce((s, c) => s + Math.max(0, num(c.weight, 1)), 0) || 1;
        return Math.max(0, num(f.node.weight, 1)) / sum;
    }
    /** 设置某块在同级中的占比；其余未锁定兄弟块按原比例分摊剩余。 */
    function setShare(tree, id, share, minShare = 0.05) {
        const f = findNode(tree, id);
        if (!f?.parent) return false;
        const sibs = f.parent.children;
        const sum = sibs.reduce((s, c) => s + Math.max(0, num(c.weight, 1)), 0) || 1;
        const frac = new Map(sibs.map(c => [c, Math.max(0, num(c.weight, 1)) / sum]));
        const others = sibs.filter(c => c !== f.node && !c.locked);
        if (!others.length) return false;
        const lockedSum = sibs.filter(c => c !== f.node && c.locked).reduce((s, c) => s + frac.get(c), 0);
        const target = clamp(share, minShare, 1 - lockedSum - minShare * others.length);
        if (!(target > 0)) return false;
        const remaining = 1 - lockedSum - target;
        const otherSum = others.reduce((s, c) => s + frac.get(c), 0);
        others.forEach(c => { frac.set(c, otherSum > 1e-9 ? remaining * frac.get(c) / otherSum : remaining / others.length); });
        // 防止某个兄弟被挤到最小值以下：抬到最小值后从较大的兄弟中扣除。
        others.forEach(c => { if (frac.get(c) < minShare) frac.set(c, minShare); });
        const over = others.reduce((s, c) => s + frac.get(c), 0) - remaining;
        if (over > 1e-9) {
            const big = others.filter(c => frac.get(c) > minShare);
            const bigSum = big.reduce((s, c) => s + frac.get(c) - minShare, 0) || 1;
            big.forEach(c => frac.set(c, frac.get(c) - over * (frac.get(c) - minShare) / bigSum));
        }
        frac.set(f.node, target);
        sibs.forEach(c => { c.weight = frac.get(c); });
        return true;
    }
    /** 拖动两个相邻兄弟之间的分割线：只改这两块。 */
    function moveSeam(tree, parentId, index, delta, minShare = 0.05) {
        const f = findNode(tree, parentId);
        const sibs = f?.node?.children;
        if (!sibs || !sibs[index] || !sibs[index + 1]) return false;
        normalizeWeights(f.node);
        const a = sibs[index], b = sibs[index + 1];
        if (a.locked || b.locked) return false;
        const pair = a.weight + b.weight;
        const next = clamp(a.weight + delta, minShare, pair - minShare);
        a.weight = next; b.weight = pair - next;
        return true;
    }
    function swapRoles(tree, idA, idB) {
        const a = findNode(tree, idA)?.node, b = findNode(tree, idB)?.node;
        if (!a || !b || !isLeaf(a) || !isLeaf(b)) return false;
        [a.role, b.role] = [b.role, a.role];
        [a.extraId, b.extraId] = [b.extraId, a.extraId];
        if (a.extraId == null) delete a.extraId;
        if (b.extraId == null) delete b.extraId;
        return true;
    }
    /** 改变媒体块内容。讲道/主观众各只能有一个：目标角色已被占用时两块互换。 */
    function setRole(tree, id, role) {
        const target = findNode(tree, id)?.node;
        if (!target || !isLeaf(target) || !['sermon', 'main', 'audience'].includes(role) || target.role === role) return false;
        if (role !== 'audience') {
            const holder = leaves(tree).find(l => l.role === role && l !== target);
            if (holder) holder.role = target.role;
        }
        target.role = role;
        delete target.extraId;
        return true;
    }
    /** 把一个块一分为二，新块默认是观众。返回（可能变化的）根节点。 */
    function splitBlock(tree, id, dir = 'h', role = 'audience') {
        const f = findNode(tree, id);
        if (!f || !isLeaf(f.node)) return tree;
        const old = f.node;
        const weight = old.weight;
        old.weight = 0.5;
        const fresh = leaf(role === 'audience' || !leaves(tree).some(l => l.role === role) ? role : 'audience', 0.5);
        const box = { id: nid(), dir, weight, locked: !!old.locked, children: [old, fresh] };
        old.locked = false;
        if (!f.parent) { box.weight = 1; return box; }
        f.parent.children[f.parent.children.indexOf(old)] = box;
        return tree;
    }
    /** 删除一个块，空间并入同级兄弟；只剩一个子块时折叠父节点。返回根节点。 */
    function removeBlock(tree, id) {
        const f = findNode(tree, id);
        if (!f?.parent || !isLeaf(f.node)) return tree;
        const parent = f.parent;
        parent.children = parent.children.filter(c => c !== f.node);
        normalizeWeights(parent);
        if (parent.children.length === 1) {
            const only = parent.children[0];
            only.weight = parent.weight;
            const gp = findNode(tree, parent.id)?.parent;
            if (!gp) { only.weight = 1; return only; }
            gp.children[gp.children.indexOf(parent)] = only;
            // 与祖父同方向时展开，避免出现同向嵌套。
            if (!isLeaf(only) && only.dir === gp.dir) {
                const at = gp.children.indexOf(only);
                const share = only.weight;
                const kids = only.children.map(c => ({ ...c, weight: c.weight * share }));
                gp.children.splice(at, 1, ...kids);
                normalizeWeights(gp);
            }
        }
        return tree;
    }
    /** 树结构被手动编辑后，按实际块数回写媒体组成（不重新生成布局）。 */
    function syncCompositionFromTree(scheme) {
        const c = countRoles(scheme.tree);
        scheme.composition = { ...scheme.composition, sermon: c.sermon ? 1 : 0, main: c.main ? 1 : 0, audience: c.audience };
        return scheme;
    }
    function toggleDir(tree, id) {
        const f = findNode(tree, id);
        const target = isLeaf(f?.node) ? f?.parent : f?.node;
        if (!target || isLeaf(target)) return false;
        target.dir = target.dir === 'h' ? 'v' : 'h';
        return true;
    }

    // ── 约束：讲道最大，主观众 ≥ 普通观众 × 倍率 ──
    // avoidRole：放大时不允许挤占含该角色的兄弟块（放大主观众不能缩小讲道）。
    function grow(tree, id, factor, avoidRole = '', minShare = 0.15) {
        let cur = findNode(tree, id);
        while (cur?.parent) {
            const before = shareOf(tree, cur.node.id);
            const sibs = cur.parent.children.filter(c => c !== cur.node && !c.locked);
            const hurts = avoidRole && sibs.some(c => leaves(c).some(l => l.role === avoidRole));
            if (!hurts && before < 0.95 && setShare(tree, cur.node.id, before * factor, minShare) && shareOf(tree, cur.node.id) > before + 1e-4) return true;
            cur = findNode(tree, cur.parent.id);
        }
        return false;
    }
    function checkConstraints(scheme) {
        const blocks = computeBlocks(scheme);
        const sermon = blocks.find(b => b.role === 'sermon');
        const main = blocks.find(b => b.role === 'main');
        const aud = blocks.filter(b => b.role === 'audience');
        const maxAud = aud.reduce((m, b) => Math.max(m, b.area), 0);
        const ratio = Math.max(1, num(scheme.mainRatio, 1.5));
        const issues = [];
        if (main && maxAud && main.area < maxAud * ratio * 0.995) issues.push({ id: main.id, type: 'main', text: `主观众面积需 ≥ 普通观众的 ${ratio} 倍` });
        const maxOther = Math.max(main?.area || 0, maxAud);
        if (sermon && maxOther && sermon.area < maxOther * 0.995) issues.push({ id: sermon.id, type: 'sermon', text: '讲道画面需为面积最大的块' });
        return issues;
    }
    /** 约束 + 过小块检查（任一边小于 minSide 像素视为不可用）。 */
    function layoutIssues(scheme, minSide = 150) {
        const issues = checkConstraints(scheme);
        const small = computeBlocks(scheme).filter(b => Math.min(b.w, b.h) < minSide);
        if (small.length) issues.push({ id: small[0].id, type: 'small', text: `${small.map(b => b.label.replace('画中画', '')).join('、')} 过小（边长 < ${minSide}px）` });
        return issues;
    }
    function enforceConstraints(scheme, maxIter = 80) {
        for (let i = 0; i < maxIter; i++) {
            const issues = checkConstraints(scheme);
            if (!issues.length) return { ok: true, issues: [] };
            const issue = issues[0];
            if (!grow(scheme.tree, issue.id, 1.06, issue.type === 'main' ? 'sermon' : '')) return { ok: false, issues };
        }
        const issues = checkConstraints(scheme);
        return { ok: !issues.length, issues };
    }

    // ── 随机 ──
    function rng(seed) {
        let s = (Number(seed) >>> 0) || 1;
        return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    }
    const pick = (r, list, fallback) => (list && list.length ? list[Math.floor(r() * list.length)] : fallback);
    function signature(scheme) {
        const b = computeBlocks(scheme).map(x => `${x.role}:${Math.round(x.x / 60)},${Math.round(x.y / 60)},${Math.round(x.w / 60)},${Math.round(x.h / 60)}`).sort();
        return b.join('|') + '#' + JSON.stringify(scheme.title?.anchor || {});
    }
    /** 从方案派生一个随机变体：媒体组成不变，电话层位置不变。 */
    function randomVariant(base, r, opts = base.random || {}) {
        const s = clone(base);
        const comp = s.composition;
        const pattern = pick(r, (opts.patterns || []).filter(p => !['wrap', 'mosaic'].includes(p) || (comp.main ? 1 : 0) + (comp.audience | 0) >= 2), 'stack');
        const sermonPos = pattern === 'wrap' ? pick(r, ['left', 'right'], 'right') : pick(r, opts.sermonPositions, 'top');
        const bandPos = pick(r, opts.bandPositions, 'top');
        s.tree = generateTree(comp, { pattern, sermonPos, bandPos, sermonShare: 0.42 + r() * 0.16, mainFirst: r() < 0.5, rng: r });
        if (!s.tree) return s;
        reconcileExtras(s, r);
        const jitter = clamp(num(opts.jitter, 10), 0, 40) / 100;
        walk(s.tree, n => { if (!isLeaf(n)) n.children.forEach(c => { c.weight = Math.max(0.05, num(c.weight, 1) * (1 + (r() * 2 - 1) * jitter)); }); });
        normalizeWeights(s.tree);
        if (opts.randomMain && comp.main) {
            const ls = leaves(s.tree).filter(l => l.role === 'audience');
            const main = leaves(s.tree).find(l => l.role === 'main');
            if (main && ls.length && r() < ls.length / (ls.length + 1)) swapRoles(s.tree, main.id, pick(r, ls).id);
        }
        enforceConstraints(s);
        if (opts.randomTitle && s.title?.enabled) {
            const seamList = seams(s);
            if (seamList.length) s.title.anchor = { mode: 'seam', index: Math.floor(r() * seamList.length) };
        } else if (s.title?.anchor?.mode === 'seam') {
            s.title.anchor.index = Math.min(num(s.title.anchor.index) | 0, Math.max(0, seams(s).length - 1));
        }
        s.pattern = pattern; s.sermonPos = sermonPos; s.bandPos = bandPos;
        return applyAutoPhone(s);
    }
    // 生成并检验：优先返回满足约束且没有过小块的变体，否则返回问题最少的一个。
    function goodVariant(scheme, r, attempts = 30) {
        let best = null, bestScore = Infinity;
        for (let i = 0; i < attempts; i++) {
            const v = randomVariant(scheme, r);
            const score = layoutIssues(v).length;
            if (!score) return v;
            if (score < bestScore) { best = v; bestScore = score; }
        }
        return best;
    }
    /** 批量规划：uniform 全部相同；random 每个任务一个变体，可复现（种子）。 */
    function planBatch(scheme, count, mode = 'uniform', seed = scheme?.random?.seed || 1) {
        count = clamp(count | 0, 1, 2000);
        if (mode !== 'random') return Array.from({ length: count }, () => clone(scheme));
        const r = rng(seed);
        const out = [];
        let prev = '';
        for (let i = 0; i < count; i++) {
            let v = goodVariant(scheme, r), sig = signature(v);
            for (let t = 0; scheme.random?.avoidRepeat !== false && sig === prev && t < 6; t++) { v = goodVariant(scheme, r); sig = signature(v); }
            prev = sig;
            out.push(v);
        }
        return out;
    }

    /** 模板与方案的媒体块组成（讲道/主观众/观众数）是否一致。 */
    function sameComposition(a, b) {
        const ca = countRoles(a.tree), cb = countRoles(b.tree);
        return ca.sermon === cb.sermon && ca.main + ca.audience === cb.main + cb.audience;
    }
    /** 用模板的布局套到当前方案上：电话层、额外层、标题层选择沿用当前方案，保证各任务媒体个数一致。 */
    function adoptTemplate(base, tpl) {
        const s = clone(base);
        s.tree = clone(tpl.tree);
        // Main is an emphasis within the audience total, not another person.
        const audience = leaves(s.tree).filter(n => n.role === 'audience' || n.role === 'main');
        const previousMain = audience.find(n => n.role === 'main');
        audience.forEach(n => { n.role = 'audience'; });
        if (base.composition.main && audience.length) {
            (previousMain || audience[audience.length - 1]).role = 'main';
        }
        s.area = clone(tpl.area || base.area);
        if (tpl.area && (canvasHeight(tpl) !== canvasHeight(base) || canvasWidth(tpl) !== canvasWidth(base))) {
            const ratio = canvasHeight(base) / canvasHeight(tpl);
            s.area.top = Math.round(num(s.area.top) * ratio);
            s.area.bottom = Math.round(num(s.area.bottom) * ratio);
            const xRatio = canvasWidth(base) / canvasWidth(tpl);
            s.area.left = Math.round(num(s.area.left) * xRatio);
            s.area.right = Math.round(num(s.area.right) * xRatio);
        }
        s.canvasWidth = canvasWidth(base);
        s.canvasHeight = canvasHeight(base);
        s.gap = num(tpl.gap, base.gap);
        s.radius = num(tpl.radius, base.radius);
        // 模板决定电话窗口的位置和尺寸，素材仍沿用当前层位。
        s.phones = (s.phones || []).map(phone => {
            const source = (tpl.phones || []).find(p => p.key === phone.key)
                || (tpl.phones || []).find(p => p.role === phone.role && p.index === phone.index);
            if (!source) return phone;
            const sx = canvasWidth(base) / canvasWidth(tpl), sy = canvasHeight(base) / canvasHeight(tpl), scale = Math.min(sx, sy);
            const w = source.w * scale, h = source.h * scale;
            return {...phone, x:(source.x+source.w/2)*sx-w/2, y:(source.y+source.h/2)*sy-h/2, w, h};
        });
        if (tpl.title?.anchor) s.title = { ...s.title, anchor: clone(tpl.title.anchor) };
        if (tpl.backdrop && tpl.backdrop.mode !== 'none') s.backdrop = clone(tpl.backdrop);
        s.templateName = tpl.name;
        reconcileExtras(s);
        if (base.composition.main) enforceConstraints(s);
        if (s.title?.anchor?.mode === 'seam') s.title.anchor.index = Math.min(num(s.title.anchor.index) | 0, Math.max(0, seams(s).length - 1));
        return applyAutoPhone(s);
    }
    /**
     * 多模板分配：templates 中与当前方案组成一致的模板（可加入随机布局）分配给 count 个任务。
     * distribute='even' 轮流均匀分配（顺序打乱），'random' 每个任务独立随机抽取。
     */
    function planPool(scheme, templates, count, opts = {}) {
        count = clamp(count | 0, 1, 2000);
        const r = rng(opts.seed || scheme?.random?.seed || 1);
        const pool = (templates || []).filter(t => t?.tree && sameComposition(t, scheme)).map(t => ({ tpl: t }));
        if (opts.includeRandom) for (let i = 0; i < Math.max(1, opts.randomWeight | 0 || 1); i++) pool.push({ random: true });
        if (!pool.length) return planBatch(scheme, count, 'uniform');
        const picks = [];
        if (opts.distribute === 'random') for (let i = 0; i < count; i++) picks.push(pool[Math.floor(r() * pool.length)]);
        else {
            while (picks.length < count) {
                const round = pool.slice();
                for (let i = round.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [round[i], round[j]] = [round[j], round[i]]; }
                // 轮次衔接处避免同一模板相邻
                if (picks.length && round.length > 1 && round[0] === picks[picks.length - 1]) round.push(round.shift());
                picks.push(...round);
            }
            picks.length = count;
        }
        return picks.map(p => {
            if (!p.random) return adoptTemplate(scheme, p.tpl);
            const v = goodVariant(scheme, r);
            v.templateName = '随机布局';
            return v;
        });
    }

    // ── 写入任务 ──
    const mediaType = path => (/\.(mp4|mov|m4v|webm|mkv|avi|gif)(?:[?#].*)?$/i.test(String(path || '')) ? 'video' : 'image');
    // Older projects label audience PIP windows as primary/secondary/general
    // or media_N. Only explicit PIP windows join layout remapping; free media
    // and decorative overlays keep their existing meaning.
    function isAudienceMedia(ov) {
        if (!ov || !['image', 'video'].includes(ov.type) || ov.slotKey === 'pip_audience_main') return false;
        if (/^pip_audience(?:_\d+)?$/.test(String(ov.slotKey || ''))) return true;
        return ov.media_window_mode === 'pip' && /^(pip_primary|pip_secondary|pip_general|media(?:_\d+)?)$/.test(String(ov.slotKey || ''));
    }
    function isManaged(ov, isLinked) {
        return !!ov && (ov._layoutManaged === true || MANAGED_SLOT.test(String(ov.slotKey || '')) || isAudienceMedia(ov) || (isLinked ? isLinked(ov) : ov.backgroundLinked === true));
    }
    function findTitleLayer(overlays, key) {
        const usable = overlays.filter(ov => ov && !ov.disabled && ['textcard', 'text'].includes(ov.type));
        if (key) {
            const hit = usable.find(ov => ov.slotKey === key || ov._templateOverlayId === key || ov.id === key);
            if (hit) return hit;
        }
        return usable.find(ov => ov.slotKey === 'title') || usable.find(ov => ov.type === 'textcard') || usable[0] || null;
    }
    function titleLayerOptions(task) {
        return (task?.overlays || []).filter(ov => ov && ['textcard', 'text'].includes(ov.type)).map((ov, i) => ({
            key: ov.slotKey || ov._templateOverlayId || ov.id,
            label: `${ov.slotLabel || ov.name || (ov.type === 'textcard' ? '文字卡片' : '文字')} · ${String(ov.title_text || ov.content || '').slice(0, 18) || `第 ${i + 1} 层`}`,
        }));
    }
    function pipWindow(ov, rect, radius) {
        Object.assign(ov, {
            x: rect.x, y: rect.y, w: rect.w, h: rect.h, rotation: 0, scale: 1, scale_x: 1, scale_y: 1,
            keep_aspect: true, crop_fill: true, media_blur_fill: false,
            media_window_mode: 'pip', media_window: { x: rect.x, y: rect.y, w: rect.w, h: rect.h },
            clip_rect: { x: rect.x, y: rect.y, w: rect.w, h: rect.h }, media_window_ratio: 'free',
            media_window_initialized: true, media_window_generated_clip: true,
            media_inner_x: 0, media_inner_y: 0, media_inner_scale: 1, media_inner_rotation: 0,
            start: 0, end: 9999, disabled: false,
        });
        if (radius > 0) {
            ov.media_mask_shape = 'round_rect';
            ['tl', 'tr', 'br', 'bl'].forEach(k => { ov['media_corner_' + k] = radius; });
        } else if (ov.media_mask_shape === 'round_rect') ov.media_mask_shape = 'rect';
        return ov;
    }
    /**
     * 按方案改写任务的覆层（原地修改 task）。
     * deps: { newId, createImageOverlay, createSolidMaskOverlay, applySlot, isLinked, syncLinked }
     */
    function applySchemeToTask(task, scheme, deps = {}) {
        const newId = deps.newId || (() => 'ov_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
        const makeImage = deps.createImageOverlay || (o => ({ type: 'image', content: '', opacity: 255, ...o }));
        const makeSolid = deps.createSolidMaskOverlay || (o => ({ type: 'solid_mask', ...o }));
        const applySlot = deps.applySlot || ((ov, key, label) => { ov.slotKey = key; ov.slotLabel = label; });
        const overlays = Array.isArray(task.overlays) ? task.overlays : [];
        const removed = overlays.filter(ov => isManaged(ov, deps.isLinked));
        const kept = overlays.filter(ov => !isManaged(ov, deps.isLinked));
        const oldCanvas = taskCanvas(task, deps.canvasDefaults);
        const newCanvas = { width: canvasWidth(scheme), height: canvasHeight(scheme) };
        if (oldCanvas.width !== newCanvas.width || oldCanvas.height !== newCanvas.height) {
            kept.forEach(ov => resizeOverlayGeometry(ov, oldCanvas, newCanvas));
            (task.cover?.overlays || []).forEach(ov => resizeOverlayGeometry(ov, oldCanvas, newCanvas));
        }
        const usedSources = new Set();
        const sourceFor = (key, family) => removed.find(ov => ov.slotKey === key && !usedSources.has(ov))
            || removed.find(ov => !usedSources.has(ov) && (family === 'pip_audience' ? (isAudienceMedia(ov) || ov.slotKey === 'pip_audience_main') : String(ov.slotKey || '').startsWith(family)))
            || null;
        const styleFor = family => removed.find(ov => String(ov.slotKey || '').startsWith(family) && ['image', 'video'].includes(ov.type)) || null;
        const build = (src, styleSrc, key, label) => {
            if (src) usedSources.add(src);
            const base = src ? clone(src) : styleSrc ? { ...clone(styleSrc), content: '', media_folder_files: undefined, media_folder_items: undefined } : makeImage({});
            delete base.media_folder_files; delete base.media_folder_items;
            if (src?.media_folder_files) base.media_folder_files = clone(src.media_folder_files);
            if (src?.media_folder_items) base.media_folder_items = clone(src.media_folder_items);
            base.id = newId();
            base._templateOverlayId = `layout_${key}`;
            base._layoutManaged = true;
            base.name = label;
            applySlot(base, key, label);
            delete base._compositeOrderKey;
            return base;
        };
        const media = [];
        // 底衬
        const bd = scheme.backdrop || {};
        if (bd.mode === 'color') {
            const prev = removed.find(ov => ov.slotKey === 'background_layer' && ov.type === 'solid_mask');
            const ov = prev ? clone(prev) : makeSolid({});
            Object.assign(ov, { id: newId(), x: 0, y: 0, w: canvasWidth(scheme), h: canvasHeight(scheme), card_color: bd.color || '#000000', card_opacity: 100,
                fullscreen_mask: true, start: 0, end: 9999, radius_tl: 0, radius_tr: 0, radius_bl: 0, radius_br: 0,
                _templateOverlayId: 'layout_background_layer', _layoutManaged: true, name: '布局底衬（纯色）', disabled: false });
            applySlot(ov, 'background_layer', '背景层');
            media.push(ov);
        } else if (bd.mode === 'media') {
            const prev = removed.find(ov => ov.slotKey === 'background_layer' && ['image', 'video'].includes(ov.type));
            const ov = build(bd.content ? null : prev, null, 'background_layer', '布局底衬（媒体）');
            if (bd.content) { ov.content = bd.content; ov.type = mediaType(bd.content); ov.media_loop = true; }
            else if (!prev) ov.type = 'image';
            pipWindow(ov, { x: 0, y: 0, w: canvasWidth(scheme), h: canvasHeight(scheme) }, 0);
            media.push(ov);
        }
        // 额外媒体层（全屏）
        const extraLayer = extra => {
            const src = removed.find(ov => ov.slotKey === extra.key);
            const ov = build(extra.content ? null : src, null, extra.key, extra.name || '媒体层');
            if (extra.content) { ov.content = extra.content; ov.media_loop = true; }
            ov.type = ov.content ? mediaType(ov.content) : (ov.media_folder_files?.length ? ov.type : 'image');
            ov.backgroundLinked = false;
            return ov;
        };
        const fullExtras = (scheme.extras || []).filter(e => e.mode !== 'split');
        fullExtras.filter(e => e.layer === 'below').forEach(e => media.push(pipWindow(extraLayer(e), { x: 0, y: 0, w: canvasWidth(scheme), h: canvasHeight(scheme) }, 0)));
        // 讲道 / 主观众 / 观众 / 参与分割的额外层
        const blocks = computeBlocks(scheme);
        const order = { sermon: 0, main: 1, audience: 2, extra: 3 };
        blocks.sort((a, b) => order[a.role] - order[b.role] || a.index - b.index).forEach(block => {
            if (block.role === 'extra') {
                const extra = (scheme.extras || []).find(e => e.key === block.slotKey);
                if (extra) media.push(pipWindow(extraLayer(extra), block, Math.max(0, num(scheme.radius))));
                return;
            }
            const family = block.role === 'sermon' ? 'pip_sermon' : 'pip_audience';
            const src = block.role === 'main' ? removed.find(ov => ov.slotKey === 'pip_audience_main') || removed.filter(ov => isAudienceMedia(ov) && !usedSources.has(ov)).at(-1) : sourceFor(block.slotKey, family, block.index || 1);
            const ov = build(src, styleFor(family), block.slotKey, block.label);
            if (block.role === 'sermon') {
                ov.backgroundLinked = true;
                ov.disabled = false;
                if (!['image', 'video'].includes(ov.type)) ov.type = 'video';
                if (deps.syncLinked) deps.syncLinked(task, ov);
                else { const p = task.bgPath || task.videoPath || ''; ov.content = p; ov.type = p ? mediaType(p) : 'video'; ov.media_loop = true; }
            } else {
                ov.backgroundLinked = false;
                if (!['image', 'video'].includes(ov.type)) ov.type = 'image';
                if (ov.content) ov.type = mediaType(ov.content);
                else if (!ov.media_folder_files?.length) ov.type = 'image';
            }
            pipWindow(ov, block, Math.max(0, num(scheme.radius)));
            media.push(ov);
        });
        fullExtras.filter(e => e.layer !== 'below').forEach(e => media.push(pipWindow(extraLayer(e), { x: 0, y: 0, w: canvasWidth(scheme), h: canvasHeight(scheme) }, 0)));
        // 电话层（自由位置，保持原图比例，不裁剪）
        (scheme.phones || []).forEach(phone => {
            const src = removed.find(ov => ov.slotKey === phone.key)
                || removed.filter(ov => String(ov.slotKey || '').startsWith(phone.role))[phone.index - 1] || null;
            const label = phone.role === 'phone_primary' ? '电话主层' : '电话次层';
            const fullLabel = phone.key === phone.role ? label : `${label} ${phone.index}`;
            const ov = build(phone.content ? null : src, styleFor(phone.role), phone.key, fullLabel);
            if (phone.content) ov.content = phone.content;
            ov.type = ov.content ? mediaType(ov.content) : 'image';
            ['media_window_mode', 'media_window', 'clip_rect', 'media_window_generated_clip', 'media_window_initialized', 'media_window_ratio'].forEach(k => delete ov[k]);
            Object.assign(ov, { x: Math.round(num(phone.x)), y: Math.round(num(phone.y)), w: Math.max(10, Math.round(num(phone.w, 300))),
                h: Math.max(10, Math.round(num(phone.h, 600))), rotation: 0, scale: 1, scale_x: 1, scale_y: 1,
                keep_aspect: true, crop_fill: false, start: 0, end: 9999, backgroundLinked: false, disabled: false });
            media.push(ov);
        });
        // 标题：自动高度，中心锚定到目标 y，放在最上层
        let title = null;
        if (scheme.title?.enabled) {
            title = findTitleLayer(kept, scheme.title.layerKey);
            if (title) {
                const cy = resolveTitleY(scheme);
                const h = num(title.h) > 0 ? num(title.h) : 200;
                if (title.type === 'textcard') { title.auto_fit = true; title.auto_center_v = false; }
                title.h = h;
                title.y = cy - h / 2;
                if (title.type === 'textcard') {
                    // 布局拥有标题的位置；不要叠加旧任务的位置参数。
                    title.offset_x = 0; title.offset_y = 0;
                    title.title_offset_x = 0; title.title_offset_y = 0;
                    title.x = (canvasWidth(scheme) - num(title.w)) / 2;
                    const titleOnly = !String(title.body_text || '').trim() && !String(title.footer_text || '').trim();
                    if (titleOnly) {
                        title.layout_mode = 'flow';
                    }
                }
                title.disabled = false;
            }
        }
        const others = kept.filter(ov => ov !== title);
        task.overlays = [...media, ...others, ...(title ? [title] : [])];
        // 合成顺序以 visualOverlayOrder 为准：媒体块在底，插入片段与其他层保持原相对顺序，标题置顶。
        const saved = Array.isArray(task.visualOverlayOrder) ? task.visualOverlayOrder : [];
        const otherKeys = new Set(others.map(ov => `overlay:${ov.id}`));
        const middle = saved.filter(k => k.startsWith('insert:') || otherKeys.has(k));
        others.forEach(ov => { const k = `overlay:${ov.id}`; if (!middle.includes(k)) middle.push(k); });
        task.visualOverlayOrder = [...media.map(ov => `overlay:${ov.id}`), ...middle, ...(title ? [`overlay:${title.id}`] : [])];
        task._layoutScheme = clone(scheme);
        return task;
    }

    function schemeFromTask(task) {
        if (task._layoutScheme?.tree) return hydrateScheme(task._layoutScheme);
        const overlays = task.overlays || [];
        const media = overlays.filter(ov => !ov.disabled && ['image','video'].includes(ov.type) &&
            (/^pip_sermon/.test(ov.slotKey || '') || ov.backgroundLinked || isAudienceMedia(ov) || ov.slotKey === 'pip_audience_main'));
        if (!media.length) throw new Error('当前任务没有可分割的讲道或观众画中画，请先通过布局批量设置布局');
        const boxes = media.map(ov => ({ ov, ...(ov.media_window || { x: ov.x, y: ov.y, w: ov.w, h: ov.h }) }));
        const bounds = list => ({ x: Math.min(...list.map(b => num(b.x))), y: Math.min(...list.map(b => num(b.y))),
            x2: Math.max(...list.map(b => num(b.x) + num(b.w))), y2: Math.max(...list.map(b => num(b.y) + num(b.h))) });
        const build = list => {
            if (list.length === 1) { const ov = list[0].ov; return leaf(/^pip_sermon/.test(ov.slotKey || '') || ov.backgroundLinked ? 'sermon' : ov.slotKey === 'pip_audience_main' ? 'main' : 'audience'); }
            const all = bounds(list);
            for (const dir of ['v','h']) {
                const axis = dir === 'h' ? 'x' : 'y', size = dir === 'h' ? 'w' : 'h';
                const sorted = list.slice().sort((a,b) => a[axis] - b[axis]);
                for (let i = 1; i < sorted.length; i++) {
                    const first = sorted.slice(0,i), rest = sorted.slice(i);
                    const end = Math.max(...first.map(b => num(b[axis]) + num(b[size]))), start = Math.min(...rest.map(b => num(b[axis])));
                    if (end > start + 2) continue;
                    const ratio = ((end + start) / 2 - all[axis]) / (dir === 'h' ? all.x2 - all.x : all.y2 - all.y);
                    const a = build(first), b = build(rest); a.weight = ratio; b.weight = 1 - ratio;
                    return split(dir, [a,b]);
                }
            }
            throw new Error('当前画中画存在重叠，无法识别分割线；请用总览的画面编辑调整窗口位置');
        };
        const tree = build(boxes), c = countRoles(tree), rect = bounds(boxes);
        const phones = overlays.filter(ov => !ov.disabled && /^phone_/.test(ov.slotKey || ''));
        const title = findTitleLayer(overlays);
        const s = defaultScheme({ tree, composition: { sermon: c.sermon, main: c.main, audience: c.audience,
            phonePrimary: phones.filter(p => /^phone_primary/.test(p.slotKey)).length,
            phoneSecondary: phones.filter(p => /^phone_secondary/.test(p.slotKey)).length },
            area: { left: rect.x, top: rect.y, right: Math.max(0,1080-rect.x2), bottom: Math.max(0,1920-rect.y2) },
            autoPhoneSecondary: false, title: { enabled: !!title, layerKey: title?.slotKey || title?.id || '', anchor: { mode: 'custom', yPct: (num(title?.y) + num(title?.h,200)/2)/19.2 } } });
        phones.forEach((ov,i) => { if (s.phones[i]) Object.assign(s.phones[i], { x: num(ov.x), y: num(ov.y), w: num(ov.w,300), h: num(ov.h,600) }); });
        return s;
    }

    // ── 内置预设 ──
    // 每个预设是一个完整方案；载入后可继续调整并另存为自己的预设。
    const P = {
        s: (w = 1) => leaf('sermon', w), m: (w = 1) => leaf('main', w), a: (w = 1) => leaf('audience', w),
        h: (w, ...kids) => ({ id: nid(), dir: 'h', weight: w, locked: false, children: kids }),
        v: (w, ...kids) => ({ id: nid(), dir: 'v', weight: w, locked: false, children: kids }),
    };
    const PRESET_DEFS = [
        { key: 'classic_2', name: '经典 · 讲道在上 + 2观众', desc: '最常用：上方讲道，下方两位观众并排，标题压在分割线上',
            comp: { audience: 2 }, tree: () => P.v(1, P.s(0.56), P.h(0.44, P.a(), P.a())) },
        { key: 'classic_2_bottom', name: '讲道在下 + 2观众', desc: '观众在上、讲道在下，适合先看反应',
            comp: { audience: 2 }, tree: () => P.v(1, P.h(0.42, P.a(), P.a()), P.s(0.58)) },
        { key: 'four_right_band', name: '4观众 · 讲道右上成带', desc: '左侧两位观众叠放 + 右侧讲道，下方两位观众',
            comp: { audience: 4 }, tree: () => P.v(1, P.h(0.62, P.v(0.48, P.a(), P.a()), P.s(0.52)), P.h(0.38, P.a(), P.a())) },
        { key: 'four_right_bottom', name: '4观众 · 讲道右下成带', desc: '上方两位观众，下方左侧两位观众叠放 + 右侧讲道',
            comp: { audience: 4 }, tree: () => P.v(1, P.h(0.36, P.a(), P.a()), P.h(0.64, P.v(0.46, P.a(), P.a()), P.s(0.54))) },
        { key: 'center_sermon_4', name: '讲道居中 · 上下各2观众', desc: '讲道夹在中间，上下各一排观众，标题压在下分割线',
            comp: { audience: 4 }, title: { anchor: { mode: 'seam', index: 1 } },
            tree: () => P.v(1, P.h(0.27, P.a(), P.a()), P.s(0.46), P.h(0.27, P.a(), P.a())) },
        { key: 'three_row', name: '讲道在上 + 3观众一排', desc: '下方三位观众并排',
            comp: { audience: 3 }, tree: () => P.v(1, P.s(0.6), P.h(0.4, P.a(), P.a(), P.a())) },
        { key: 'side_column_3', name: '讲道左侧竖条 + 3观众列', desc: '左侧大讲道，右侧三位观众竖排，标题在上方留白',
            comp: { audience: 3 }, area: { top: 240 }, title: { anchor: { mode: 'top' } },
            tree: () => P.h(1, P.s(0.6), P.v(0.4, P.a(), P.a(), P.a())) },
        { key: 'main_plus_2', name: '主观众 + 讲道 + 2观众', desc: '讲道在上；下方主观众占大块，两位观众叠放在旁',
            comp: { main: 1, audience: 2 }, tree: () => P.v(1, P.s(0.52), P.h(0.48, P.m(0.62), P.v(0.38, P.a(), P.a()))) },
        { key: 'main_band_4', name: '主观众与讲道并排 + 4观众', desc: '上方主观众与讲道并排成带，下方两排观众',
            comp: { main: 1, audience: 4 }, tree: () => P.v(1, P.h(0.56, P.m(0.44), P.s(0.56)), P.h(0.22, P.a(), P.a()), P.h(0.22, P.a(), P.a())) },
        { key: 'main_big_3', name: '主观众大窗 + 讲道 + 3观众', desc: '主观众占下方左半大窗，三位观众竖排在右',
            comp: { main: 1, audience: 3 }, tree: () => P.v(1, P.s(0.5), P.h(0.5, P.m(0.64), P.v(0.36, P.a(), P.a(), P.a()))) },
        { key: 'grid_6', name: '讲道 + 6观众网格', desc: '讲道在上，下方 3×2 观众网格',
            comp: { audience: 6 }, tree: () => P.v(1, P.s(0.5), P.v(0.5, P.h(0.5, P.a(), P.a(), P.a()), P.h(0.5, P.a(), P.a(), P.a()))) },
        { key: 'margin_title_2', name: '上方留白标题 + 讲道 + 2观众', desc: '顶部留 300px 放标题，深色底衬',
            comp: { audience: 2 }, area: { top: 300 }, title: { anchor: { mode: 'top' } }, backdrop: { mode: 'color', color: '#101010' },
            tree: () => P.v(1, P.s(0.55), P.h(0.45, P.a(), P.a())) },
        { key: 'framed_4', name: '讲道在上 + 4观众网格', desc: '上方讲道，下方 2×2 四位观众无边框满屏网格',
            comp: { audience: 4 },
            tree: () => P.v(1, P.s(0.5), P.h(0.25, P.a(), P.a()), P.h(0.25, P.a(), P.a())) },
        { key: 'stagger_3', name: '错落 · 讲道 + 3观众阶梯', desc: '一大两小，右侧上下不等高，像随手拼的',
            comp: { audience: 3 }, tree: () => P.v(1, P.s(0.5), P.h(0.5, P.a(0.42), P.v(0.58, P.a(0.62), P.a(0.38)))) },
        { key: 'collage_4', name: '不规则拼贴 · 讲道 + 4观众', desc: '讲道偏左上，观众大小不一',
            comp: { audience: 4 }, tree: () => P.v(1, P.h(0.58, P.s(0.66), P.v(0.34, P.a(0.44), P.a(0.56))), P.h(0.42, P.a(0.37), P.a(0.63))) },
        { key: 'offset_5', name: '大小错位 · 讲道 + 5观众', desc: '左列两块、右列三块，行高互相错开',
            comp: { audience: 5 }, tree: () => P.v(1, P.s(0.46), P.h(0.54, P.v(0.56, P.a(0.62), P.a(0.38)), P.v(0.44, P.a(0.3), P.a(0.42), P.a(0.28)))) },
        { key: 'pinwheel_4', name: '风车 · 讲道 + 4观众', desc: '上排不等宽、中间小窗配讲道、底部宽条',
            comp: { audience: 4 }, tree: () => P.v(1, P.h(0.28, P.a(0.62), P.a(0.38)), P.h(0.46, P.a(0.3), P.s(0.7)), P.a(0.26)) },
        { key: 'diagonal_3', name: '斜向阶梯 · 讲道 + 3观众', desc: '左右两列高低错开，形成斜线节奏',
            comp: { audience: 3 }, tree: () => P.h(1, P.v(0.6, P.s(0.64), P.a(0.36)), P.v(0.4, P.a(0.56), P.a(0.44))) },
        { key: 'main_collage_3', name: '主观众拼贴 · 讲道 + 主观众 + 3观众', desc: '主观众占下方大块，其余观众挤在角落',
            comp: { main: 1, audience: 3 }, tree: () => P.v(1, P.h(0.54, P.s(0.62), P.v(0.38, P.a(0.42), P.a(0.58))), P.h(0.46, P.m(0.66), P.a(0.34))) },
        { key: 'magazine_6', name: '杂志拼贴 · 讲道 + 6观众', desc: '三排宽窄各不相同，像杂志版面',
            comp: { audience: 6 }, tree: () => P.v(1, P.h(0.22, P.a(0.32), P.a(0.68)), P.h(0.46, P.s(0.68), P.v(0.32, P.a(0.55), P.a(0.45))), P.h(0.32, P.a(0.58), P.a(0.42))) },
        { key: 'narrow_2', name: '窄条点缀 · 讲道 + 2观众', desc: '一个观众宽、一个观众窄，打破对称',
            comp: { audience: 2 }, tree: () => P.v(1, P.s(0.62), P.h(0.38, P.a(0.68), P.a(0.32))) },
        { key: 'shifted_rows_4', name: '错位双排 · 讲道在下 + 4观众', desc: '上面两排观众宽窄相反，讲道在下',
            comp: { audience: 4 }, tree: () => P.v(1, P.h(0.27, P.a(0.4), P.a(0.6)), P.h(0.25, P.a(0.63), P.a(0.37)), P.s(0.48)) },
        { key: 'left_heavy_4', name: '左重右轻 · 讲道 + 4观众', desc: '左侧讲道配一个观众，右侧三个观众高矮不一',
            comp: { audience: 4 }, tree: () => P.h(1, P.v(0.6, P.s(0.7), P.a(0.3)), P.v(0.4, P.a(0.3), P.a(0.44), P.a(0.26))) },
        { key: 'scatter_framed_5', name: '不规则拼贴 · 讲道 + 5观众', desc: '讲道偏左上，五位观众大小错落满屏拼贴',
            comp: { audience: 5 },
            tree: () => P.v(1, P.h(0.5, P.s(0.64), P.v(0.36, P.a(0.4), P.a(0.6))), P.h(0.5, P.v(0.45, P.a(0.58), P.a(0.42)), P.a(0.55))) },
        { key: 'phone_dual_4', name: '4观众 + 电话次层小窗', desc: '讲道右上成带；除全屏电话主层外，右下角再叠一张电话次层',
            comp: { audience: 4, phonePrimary: 1, phoneSecondary: 1 },
            tree: () => P.v(1, P.h(0.62, P.v(0.48, P.a(), P.a()), P.s(0.52)), P.h(0.38, P.a(), P.a())) },
    ];
    function builtinPresets() {
        return PRESET_DEFS.map(def => {
            const scheme = defaultScheme({
                id: `builtin_${def.key}`, name: def.name, composition: { sermon: 1, main: 0, audience: 0, phonePrimary: 1, phoneSecondary: 0, ...def.comp },
                area: def.area, gap: def.gap, radius: def.radius, title: def.title, backdrop: def.backdrop,
                tree: normalizeWeights(def.tree()), phones: def.phones,
            });
            scheme.builtin = true;
            scheme.desc = def.desc;
            enforceConstraints(scheme);
            return scheme;
        });
    }

    return {
        CANVAS, canvasWidth, canvasHeight, taskCanvas, fitPhoneToCanvas, resizePhoneRect, MANAGED_SLOT, schemeFromTask, generateTree, defaultScheme, hydrateScheme, setComposition, syncPhones, areaRect, computeBlocks, seams, mirrorLayout,
        titleCandidates, resolveTitleY, shareOf, setShare, moveSeam, swapRoles, toggleDir, setRole, splitBlock, removeBlock, syncCompositionFromTree, addExtra, reconcileExtras, assignExtra, removeExtra, normalizeWeights, findNode,
        leaves, countRoles, checkConstraints, layoutIssues, enforceConstraints, goodVariant, rng, randomVariant, planBatch, signature,
        applySchemeToTask, titleLayerOptions, findTitleLayer, isManaged, builtinPresets, sameComposition, adoptTemplate, planPool, sermonIsBand, applyAutoPhone,
        parseAspectRatio, fitAspectRect, optimizeAudienceAspectWeights,
    };
});
