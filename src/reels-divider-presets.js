/**
 * VideoKit - 参数化 SVG 标题装饰线预设系统 (Parametric SVG Divider Preset System)
 * 
 * 核心特性：
 * 1. 结构固定为：Left Line + Center Decoration + Right Line。
 * 2. 改变总宽度时仅延伸左右线段，中央装饰严格保持纵横比例与视觉尺寸，不发生横向拉伸。
 * 3. 纯矢量参数化渲染，不使用 PNG 图片，支持导出高清无损 SVG 与 1:1 Canvas 像素级绘制。
 * 4. 严格对应 6 大分类共 50 款经典预设（参考设计图稿 1:1 还原）：
 *    - 基础线条 Basic Line (8款)
 *    - 中心装饰 Center Accent (12款)
 *    - 植物花边 Botanical (8款)
 *    - 欧式花边 Flourish (8款)
 *    - 几何装饰 Geometric (8款)
 *    - 信仰主题 Faith Minimal (6款)
 */

(function (root) {
    'use strict';

    // 默认参数配置
    const defaultProps = {
        width: 500,
        height: 40,
        strokeWidth: 2,
        color: '#FFD700',
        opacity: 1,
        decorationScale: 1,
        centerGap: 18,
        lineCap: 'round',
        flip: false
    };

    // 绘图基础图元工厂
    const path = (d, fill = false, stroke = true) => ({ type: 'path', d, fill, stroke });
    const line = (x1, y1, x2, y2, weight = 1, dash = null) => ({ type: 'line', x1, y1, x2, y2, weight, dash });
    const circle = (cx, cy, r, fill = true, stroke = false) => ({ type: 'circle', cx, cy, r, fill, stroke });
    const rect = (x, y, w, h, fill = true, stroke = false) => ({ type: 'rect', x, y, w, h, fill, stroke });
    const polygon = (points, fill = true, stroke = false) => ({ type: 'polygon', points, fill, stroke });

    // 常用中心图案几何生成器
    const diamond = (cx = 0, cy = 0, r = 7, fill = true, stroke = false) =>
        polygon(`${cx},${cy - r} ${cx + r},${cy} ${cx},${cy + r} ${cx - r},${cy}`, fill, stroke);

    const star4 = (cx = 0, cy = 0, r = 9, fill = true) =>
        path(`M ${cx} ${cy - r} Q ${cx + r * .18} ${cy - r * .18} ${cx + r} ${cy} Q ${cx + r * .18} ${cy + r * .18} ${cx} ${cy + r} Q ${cx - r * .18} ${cy + r * .18} ${cx - r} ${cy} Q ${cx - r * .18} ${cy - r * .18} ${cx} ${cy - r} Z`, fill);

    const cross = (cx = 0, cy = 0, size = 11) => [
        line(cx, cy - size * 1.25, cx, cy + size * 1.1, 1),
        line(cx - size * .75, cy - size * .35, cx + size * .75, cy - size * .35, 1)
    ];

    const leafPath = (x1, y1, x2, y2, bend = 5, fill = true) => {
        const dx = x2 - x1, dy = y2 - y1;
        const len = Math.hypot(dx, dy) || 1;
        const nx = -dy / len * bend, ny = dx / len * bend;
        const cx1 = x1 + dx * .35 + nx, cy1 = y1 + dy * .35 + ny;
        const cx2 = x1 + dx * .35 - nx, cy2 = y1 + dy * .35 - ny;
        return path(`M ${x1} ${y1} Q ${cx1} ${cy1} ${x2} ${y2} Q ${cx2} ${cy2} ${x1} ${y1} Z`, fill);
    };

    // 50 个预设的中央装饰库定义 (所有图案以 (0, 0) 为中心)
    const decorations = {
        // ── 1. 基础线条 (无中心独立图案，由线条模式直接绘制) ──
        none: () => [],

        // ── 2. 中心装饰 (12款) ──
        dot: () => [circle(0, 0, 4)],
        dots3: () => [circle(-9, 0, 3.2), circle(0, 0, 4.2), circle(9, 0, 3.2)],
        diamond: () => [diamond(0, 0, 7.5, true)],
        hollow_diamond: () => [diamond(0, 0, 7.5, false, true)],
        square: () => [rect(-4.5, -4.5, 9, 9, true)],
        vertical2: () => [line(-3.5, -8, -3.5, 8), line(3.5, -8, 3.5, 8)],
        slash3: () => [-8, 0, 8].map(x => line(x - 3.5, 7, x + 3.5, -7)),
        v: () => [path('M -8 -4 L 0 5 L 8 -4')],
        double_v: () => [path('M -8 -7 L 0 0 L 8 -7 M -8 0 L 0 7 L 8 0')],
        triangle_down: () => [polygon('-7,-5 7,-5 0,6', true)],
        star4: () => [star4(0, 0, 9)],
        circle_hollow: () => [circle(0, 0, 5.5, false, true)],

        // ── 3. 植物花边 (8款) ──
        // 1. 向上三叶芽
        leaf3_bloom: () => [
            path('M 0 6 C -2 -2 -3 -8 0 -13 C 3 -8 2 -2 0 6 Z', true),
            path('M 0 6 C -4 3 -10 1 -13 -4 C -8 -7 -3 -2 0 6 Z', true),
            path('M 0 6 C 4 3 10 1 13 -4 C 8 -7 3 -2 0 6 Z', true),
            circle(0, 6, 1.8, true)
        ],
        // 2. 对叶枝条 + 中心点
        pair_leaves_dot: () => [
            circle(0, 0, 2.5),
            leafPath(-7, 1, -16, -6, 3), leafPath(-11, 2, -22, 6, -3),
            leafPath(7, 1, 16, -6, -3), leafPath(11, 2, 22, 6, 3)
        ],
        // 3. 双向四叶枝条 + 中心小芽
        four_leaf_branch: () => [
            path('M -4 2 Q -18 3 -32 -2 M 4 2 Q 18 3 32 -2'),
            path('M 0 5 C -2 1 -2 -4 0 -8 C 2 -4 2 1 0 5 Z', true),
            ...[-1, 1].flatMap(s => [
                leafPath(s * 10, 2, s * 14, -7, s * 2.5),
                leafPath(s * 17, 1, s * 22, -8, s * 2.5),
                leafPath(s * 24, 0, s * 30, -7, s * 2.5),
                leafPath(s * 15, 2, s * 20, 8, s * -2.5)
            ])
        ],
        // 4. 舒展三叶草
        leaves3_fan: () => [
            path('M 0 7 C -3 1 -4 -6 0 -12 C 4 -6 3 1 0 7 Z', true),
            path('M 0 7 C -6 4 -12 2 -15 -3 C -10 -7 -4 -2 0 7 Z', true),
            path('M 0 7 C 6 4 12 2 15 -3 C 10 -7 4 -2 0 7 Z', true)
        ],
        // 5. 左右长橄榄枝 + 中心点
        olive_branches_dot: () => [
            circle(0, 0, 2.8),
            path('M -8 1 Q -24 3 -42 -2 M 8 1 Q 24 3 42 -2'),
            ...[-1, 1].flatMap(s => [
                leafPath(s * 14, 1, s * 17, -9, s * 2.5),
                leafPath(s * 22, 1, s * 26, -9, s * 2.5),
                leafPath(s * 30, 0, s * 35, -8, s * 2.5),
                leafPath(s * 18, 1, s * 22, 8, s * -2.5),
                leafPath(s * 26, 0, s * 31, 7, s * -2.5)
            ])
        ],
        // 6. 左右麦穗 + 中心高三叶
        laurel_with_three: () => [
            // 中心高三叶
            path('M 0 6 C -2 -2 -3 -8 0 -14 C 3 -8 2 -2 0 6 Z', true),
            path('M 0 6 C -4 3 -9 1 -12 -4 C -7 -7 -3 -2 0 6 Z', true),
            path('M 0 6 C 4 3 9 1 12 -4 C 7 -7 3 -2 0 6 Z', true),
            // 两侧对麦穗
            leafPath(-15, 1, -25, -6, 2.5), leafPath(-18, 2, -28, 5, -2.5),
            leafPath(15, 1, 25, -6, -2.5), leafPath(18, 2, 28, 5, 2.5)
        ],
        // 7. 双向小叶草 + 中心点
        paired_leaves_dot: () => [
            circle(0, 0, 2.5),
            leafPath(-9, 1, -18, -6, 3), leafPath(-9, -1, -18, 6, -3),
            leafPath(9, 1, 18, -6, -3), leafPath(9, -1, 18, 6, 3)
        ],
        // 8. 饱满三叶花苞
        tulip_bud: () => [
            path('M 0 7 C -3 0 -5 -6 0 -12 C 5 -6 3 0 0 7 Z', true),
            path('M -2 7 C -6 5 -12 2 -13 -4 C -8 -7 -4 -2 -2 7 Z', true),
            path('M 2 7 C 6 5 12 2 13 -4 C 8 -7 4 -2 2 7 Z', true),
            circle(0, 7.5, 2)
        ],

        // ── 4. 欧式花边 (8款) ──
        // 1. 对称卷草 + 四角星
        flourish_curls_star: () => [
            star4(0, 0, 7.5),
            circle(-13, 0, 1.8), circle(13, 0, 1.8),
            path('M -17 0 C -25 -10 -35 -8 -34 0 C -33 7 -25 5 -26 0 M 17 0 C 25 -10 35 -8 34 0 C 33 7 25 5 26 0')
        ],
        // 2. 波浪舒展 + 菱形星
        flourish_wave_diamond: () => [
            star4(0, 0, 7.5),
            path('M -12 0 C -22 -9 -36 -4 -48 0 M 12 0 C 22 -9 36 -4 48 0')
        ],
        // 3. 经典无限结 + 双点
        flourish_infinity_dots: () => [
            circle(-24, 0, 2), circle(24, 0, 2),
            path('M 0 0 C -12 -11 -20 -11 -20 0 C -20 11 -12 11 0 0 C 12 -11 20 -11 20 0 C 20 11 12 11 0 0 Z')
        ],
        // 4. 双卷藤蔓托爱心
        flourish_heart_curls: () => [
            path('M 0 3 C -2.5 -2 -6 -2 -6 1.5 C -6 5.5 0 9 0 9 C 0 9 6 5.5 6 1.5 C 6 -2 2.5 -2 0 3 Z', true),
            path('M -9 1 C -18 -8 -26 -6 -25 1 C -24 7 -18 5 -19 0 M 9 1 C 18 -8 26 -6 25 1 C 24 7 18 5 19 0')
        ],
        // 5. 展翅舒展曲线 + 菱星
        flourish_swans_diamond: () => [
            diamond(0, 0, 6, true),
            path('M -10 -1 C -20 -10 -34 -7 -44 -1 M 10 -1 C 20 -10 34 -7 44 -1')
        ],
        // 6. 欧式古典卷草纹章 + 三花瓣
        flourish_vintage_crest: () => [
            path('M 0 5 C -2 1 -2 -3 0 -7 C 2 -3 2 1 0 5 Z', true),
            circle(-16, 0, 1.8), circle(16, 0, 1.8),
            path('M -7 0 C -16 -12 -26 -6 -23 0 C -20 6 -13 3 -15 -2 M 7 0 C 16 -12 26 -6 23 0 C 20 6 13 3 15 -2')
        ],
        // 7. 交叉双小环（蝴蝶结回环）
        flourish_figure8_loop: () => [
            path('M 0 0 C -10 -9 -17 -9 -17 0 C -17 9 -10 9 0 0 C 10 -9 17 -9 17 0 C 17 9 10 9 0 0 Z')
        ],
        // 8. 托底微笑弧 + 三叶小花
        flourish_smile_leaves: () => [
            path('M -26 -1 Q 0 8 26 -1'),
            path('M 0 3 C -2 -1 -3 -5 0 -9 C 3 -5 2 -1 0 3 Z', true),
            leafPath(-2, 3, -11, -3, 2), leafPath(2, 3, 11, -3, -2)
        ],

        // ── 5. 几何装饰 (8款) ──
        // 1. 实心菱形 + 渐细双长楔
        geometric_tapered_diamond: () => [
            diamond(0, 0, 7, true),
            polygon('-9,-3 -9,3 -32,0', true),
            polygon('9,-3 9,3 32,0', true)
        ],
        // 2. 三重人字纹 (>>>)
        geometric_triple_chevron: () => [
            path('M -10 -6 L -4 0 L -10 6 M -3 -6 L 3 0 L -3 6 M 4 -6 L 10 0 L 4 6')
        ],
        // 3. 居中实心长方形横块
        geometric_solid_block: () => [
            rect(-24, -4.5, 48, 9, true)
        ],
        // 4. 三道平行四边形粗条 (///)
        geometric_slash_bars: () => [
            polygon('-14,-5 -7,-5 -11,5 -18,5', true),
            polygon('-4,-5 3,-5 -1,5 -8,5', true),
            polygon('6,-5 13,-5 9,5 2,5', true)
        ],
        // 5. 菱晶组合 (小大小 ◆◆◆)
        geometric_diamond_trio: () => [
            diamond(0, 0, 8, true),
            diamond(-13, 0, 5, true),
            diamond(13, 0, 5, true)
        ],
        // 6. 对尖渐细双长楔 + 中心点 (◄ • ►)
        geometric_tapered_dot: () => [
            circle(0, 0, 2.6, true),
            polygon('-6,-3.5 -6,3.5 -30,0', true),
            polygon('6,-3.5 6,3.5 30,0', true)
        ],
        // 7. 三连环空心菱形 (◇◇◇)
        geometric_hollow_diamonds3: () => [
            diamond(0, 0, 7.5, false, true),
            diamond(-11.5, 0, 5.5, false, true),
            diamond(11.5, 0, 5.5, false, true)
        ],
        // 8. 倒梯形科技切角块
        geometric_trapezoid_base: () => [
            polygon('-18,-4 18,-4 13,4 -13,4', true),
            line(-22, 5, 22, 5)
        ],

        // ── 6. 信仰主题 (6款) ──
        // 1. 极简细线十字架
        faith_cross_simple: () => cross(0, 0, 11),
        // 2. 十字架 + 两侧圆点
        faith_cross_dots: () => [
            ...cross(0, 0, 11),
            circle(-15, 0, 2.6), circle(15, 0, 2.6)
        ],
        // 3. 十字架 + 两侧小菱晶
        faith_cross_diamonds: () => [
            ...cross(0, 0, 11),
            diamond(-16, 0, 4.5, true), diamond(16, 0, 4.5, true)
        ],
        // 4. 左右橄榄叶簇 + 十字架
        faith_cross_olive: () => [
            ...cross(0, 0, 11),
            leafPath(-11, 2, -22, -6, 3), leafPath(-14, 2, -24, 6, -3),
            leafPath(11, 2, 22, -6, -3), leafPath(14, 2, 24, 6, 3)
        ],
        // 5. 渐细双长锋 + 十字架
        faith_cross_tapered: () => [
            ...cross(0, 0, 11),
            polygon('-9,-2.8 -9,2.8 -34,0', true),
            polygon('9,-2.8 9,2.8 34,0', true)
        ],
        // 6. 经典双实线 + 十字架
        faith_cross_double_line: () => cross(0, 0, 11)
    };

    // 预设图案半径/边界留白预设 (用于精准计算两侧线段避让间隙)
    const bounds = {
        none: 0,
        dot: 5, dots3: 15, diamond: 9, hollow_diamond: 9, square: 6,
        vertical2: 6, slash3: 14, v: 10, double_v: 10, triangle_down: 8,
        star4: 10, circle_hollow: 7,
        leaf3_bloom: 16, pair_leaves_dot: 25, four_leaf_branch: 35, leaves3_fan: 17,
        olive_branches_dot: 45, laurel_with_three: 30, paired_leaves_dot: 20, tulip_bud: 16,
        flourish_curls_star: 38, flourish_wave_diamond: 50, flourish_infinity_dots: 27,
        flourish_heart_curls: 28, flourish_swans_diamond: 46, flourish_vintage_crest: 28,
        flourish_figure8_loop: 19, flourish_smile_leaves: 28,
        geometric_tapered_diamond: 34, geometric_triple_chevron: 13, geometric_solid_block: 26,
        geometric_slash_bars: 20, geometric_diamond_trio: 20, geometric_tapered_dot: 32,
        geometric_hollow_diamonds3: 19, geometric_trapezoid_base: 24,
        faith_cross_simple: 11, faith_cross_dots: 18, faith_cross_diamonds: 22,
        faith_cross_olive: 26, faith_cross_tapered: 36, faith_cross_double_line: 11
    };

    // 软件代码完全不内置私有爆款装饰线预设，保持系统干净纯净；
    // 50 款美区爆贴装饰线完全作为用户专属离线资产（美区爆贴标题装饰线50套全量预设.json），支持用户按需导入。
    const presets = [];

    // 参数清理与数值规范化
    function normalizeProps(props = {}, base = defaultProps) {
        const num = (v, fallback, min, max) => {
            const n = parseFloat(v);
            return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
        };
        const safeColor = (c, fallback) => {
            if (typeof c !== 'string' || /url\(|<script|javascript:/i.test(c)) return fallback;
            return c;
        };
        return {
            width: num(props.width, base.width, 1, 20000),
            height: num(props.height, base.height, 1, 4000),
            strokeWidth: num(props.strokeWidth ?? props.thickness, base.strokeWidth, 0.1, 100),
            color: safeColor(props.color, base.color),
            color2: safeColor(props.color2, safeColor(props.color, base.color)),
            opacity: num(props.opacity, base.opacity, 0, 1),
            decorationScale: num(props.decorationScale ?? props.scale, base.decorationScale, 0.05, 10),
            centerGap: num(props.centerGap, base.centerGap, 0, 1000),
            lineCap: ['butt', 'round', 'square'].includes(props.lineCap) ? props.lineCap : base.lineCap,
            flip: props.flip === true
        };
    }

    /**
     * 核心几何渲染器：生成 LeftLine, CenterDecoration, RightLine 结构
     * 保证更改 width 时仅延伸左右两端线条，中央装饰绝不被横向拉伸！
     */
    function computeGeometry(preset, userProps = {}) {
        const p = normalizeProps(userProps, preset.defaultProps);
        const decoFn = decorations[preset.decoration] || decorations.none;
        const centerShapes = decoFn();

        const baseRadius = bounds[preset.decoration] || 0;
        const decorationRadius = baseRadius * p.decorationScale;
        const gap = decorationRadius + (centerShapes.length > 0 ? p.centerGap : 0);

        const totalHalfW = p.width / 2;
        const innerX = Math.min(totalHalfW, gap);
        const outerX = totalHalfW;

        const left = [];
        const right = [];
        const mode = preset.mode || 'solid';

        if (mode === 'single_thin' || mode === 'single_medium' || mode === 'solid') {
            if (centerShapes.length > 0) {
                left.push(line(-outerX, 0, -innerX, 0));
                right.push(line(innerX, 0, outerX, 0));
            } else {
                left.push(line(-outerX, 0, 0, 0));
                right.push(line(0, 0, outerX, 0));
            }
        } else if (mode === 'double') {
            const dy = 3.2;
            if (centerShapes.length > 0) {
                left.push(line(-outerX, -dy, -innerX, -dy), line(-outerX, dy, -innerX, dy));
                right.push(line(innerX, -dy, outerX, -dy), line(innerX, dy, outerX, dy));
            } else {
                left.push(line(-outerX, -dy, 0, -dy), line(-outerX, dy, 0, dy));
                right.push(line(0, -dy, outerX, -dy), line(0, dy, outerX, dy));
            }
        } else if (mode === 'bold_center') {
            // 中粗短杠 + 两侧细线
            const centerBarHalf = Math.min(50, outerX * 0.4);
            left.push(line(-outerX, 0, -centerBarHalf, 0, 1));
            left.push(line(-centerBarHalf, 0, 0, 0, 2.8));
            right.push(line(0, 0, centerBarHalf, 0, 2.8));
            right.push(line(centerBarHalf, 0, outerX, 0, 1));
        } else if (mode === 'double_bold_center') {
            // 双线 + 中间加粗短杠
            const centerBarHalf = Math.min(50, outerX * 0.4);
            const dy = 3.5;
            left.push(line(-outerX, -dy, -centerBarHalf, -dy, 1), line(-outerX, dy, -centerBarHalf, dy, 1));
            left.push(line(-centerBarHalf, 0, 0, 0, 3));
            right.push(line(0, 0, centerBarHalf, 0, 3));
            right.push(line(centerBarHalf, -dy, outerX, -dy, 1), line(centerBarHalf, dy, outerX, dy, 1));
        } else if (mode === 'dashed') {
            left.push(line(-outerX, 0, -innerX, 0, 1, '8 6'));
            right.push(line(innerX, 0, outerX, 0, 1, '8 6'));
        } else if (mode === 'dotted') {
            left.push(line(-outerX, 0, -innerX, 0, 1, '2 5'));
            right.push(line(innerX, 0, outerX, 0, 1, '2 5'));
        } else if (mode === 'dashdot') {
            left.push(line(-outerX, 0, -innerX, 0, 1, '16 5 3 5'));
            right.push(line(innerX, 0, outerX, 0, 1, '16 5 3 5'));
        }

        return {
            preset,
            props: p,
            decorationScale: p.decorationScale,
            components: {
                LeftLine: left,
                CenterDecoration: centerShapes,
                RightLine: right
            }
        };
    }

    /**
     * 生成高清纯矢量 SVG 字符串
     */
    function renderSVG(preset, userProps = {}) {
        const geom = computeGeometry(preset, userProps);
        const p = geom.props;
        const cx = p.width / 2;
        const cy = p.height / 2;

        const isGrad = typeof p.color === 'string' && p.color.includes(',');
        let defs = '';
        let colorRef = p.color;
        if (isGrad) {
            const colors = p.color.split(',').map(c => c.trim()).filter(Boolean);
            if (colors.length >= 2) {
                const gradId = 'div_grad_' + Math.random().toString(36).slice(2, 9);
                const stops = colors.map((c, i) => `<stop offset="${(i / Math.max(1, colors.length - 1) * 100).toFixed(1)}%" stop-color="${c}" />`).join('');
                defs = `\n  <defs><linearGradient id="${gradId}" x1="0%" y1="0%" x2="100%" y2="0%">${stops}</linearGradient></defs>`;
                colorRef = `url(#${gradId})`;
            }
        }

        const renderItem = (item) => {
            const strokeW = p.strokeWidth * (item.weight || 1);
            if (item.type === 'line') {
                const dashAttr = item.dash ? ` stroke-dasharray="${item.dash}"` : '';
                return `<line x1="${item.x1}" y1="${item.y1}" x2="${item.x2}" y2="${item.y2}" stroke="${colorRef}" stroke-width="${strokeW}" stroke-linecap="${p.lineCap}"${dashAttr} />`;
            }
            if (item.type === 'circle') {
                return `<circle cx="${item.cx}" cy="${item.cy}" r="${item.r}" fill="${item.fill ? colorRef : 'none'}" stroke="${item.stroke ? colorRef : 'none'}" stroke-width="${strokeW}" />`;
            }
            if (item.type === 'rect') {
                return `<rect x="${item.x}" y="${item.y}" width="${item.w}" height="${item.h}" fill="${item.fill ? colorRef : 'none'}" stroke="${item.stroke ? colorRef : 'none'}" stroke-width="${strokeW}" />`;
            }
            if (item.type === 'polygon') {
                return `<polygon points="${item.points}" fill="${item.fill ? colorRef : 'none'}" stroke="${item.stroke ? colorRef : 'none'}" stroke-width="${strokeW}" />`;
            }
            if (item.type === 'path') {
                return `<path d="${item.d}" fill="${item.fill ? colorRef : 'none'}" stroke="${item.stroke !== false ? colorRef : 'none'}" stroke-width="${strokeW}" stroke-linecap="${p.lineCap}" stroke-linejoin="round" />`;
            }
            return '';
        };

        const leftSvg = geom.components.LeftLine.map(renderItem).join('');
        const rightSvg = geom.components.RightLine.map(renderItem).join('');
        const centerSvg = geom.components.CenterDecoration.map(renderItem).join('');

        const flipTransform = p.flip ? ' scale(-1, 1)' : '';

        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${p.width} ${p.height}" width="${p.width}" height="${p.height}">${defs}
  <g transform="translate(${cx}, ${cy})${flipTransform}" opacity="${p.opacity}">
    <g class="left-line">${leftSvg}</g>
    <g class="center-decoration" transform="scale(${geom.decorationScale})">${centerSvg}</g>
    <g class="right-line">${rightSvg}</g>
  </g>
</svg>`;
    }

    /**
     * 在 HTML5 Canvas 2D 上 1:1 像素级精准绘制 (支持实时拖拽调节、预览与视频成片无损导出)
     */
    function drawCanvas(ctx, preset, userProps = {}) {
        const geom = computeGeometry(preset, userProps);
        const p = geom.props;

        ctx.save();
        ctx.globalAlpha *= p.opacity;
        ctx.lineCap = p.lineCap;
        ctx.lineJoin = 'round';
        if (p.flip) ctx.scale(-1, 1);

        let activeColor = p.color;
        if (typeof p.color === 'string' && p.color.includes(',')) {
            const colors = p.color.split(',').map(c => c.trim()).filter(Boolean);
            if (colors.length >= 2) {
                const grad = ctx.createLinearGradient(-p.width / 2, 0, p.width / 2, 0);
                colors.forEach((c, idx) => {
                    grad.addColorStop(idx / Math.max(1, colors.length - 1), c);
                });
                activeColor = grad;
            }
        }

        const paintItem = (item) => {
            ctx.lineWidth = p.strokeWidth * (item.weight || 1);
            ctx.strokeStyle = activeColor;
            ctx.fillStyle = activeColor;

            if (item.type === 'line') {
                ctx.beginPath();
                if (item.dash) {
                    const dashes = item.dash.split(/\s+/).map(Number);
                    ctx.setLineDash(dashes);
                } else {
                    ctx.setLineDash([]);
                }
                ctx.moveTo(item.x1, item.y1);
                ctx.lineTo(item.x2, item.y2);
                ctx.stroke();
                ctx.setLineDash([]);
            } else if (item.type === 'circle') {
                ctx.beginPath();
                ctx.arc(item.cx, item.cy, item.r, 0, Math.PI * 2);
                if (item.fill) ctx.fill();
                if (item.stroke) ctx.stroke();
            } else if (item.type === 'rect') {
                if (item.fill) ctx.fillRect(item.x, item.y, item.w, item.h);
                if (item.stroke) ctx.strokeRect(item.x, item.y, item.w, item.h);
            } else if (item.type === 'polygon') {
                const pts = item.points.trim().split(/\s+/).map(pt => pt.split(',').map(Number));
                if (pts.length > 0) {
                    ctx.beginPath();
                    ctx.moveTo(pts[0][0], pts[0][1]);
                    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
                    ctx.closePath();
                    if (item.fill) ctx.fill();
                    if (item.stroke) ctx.stroke();
                }
            } else if (item.type === 'path') {
                const p2d = new Path2D(item.d);
                if (item.fill) ctx.fill(p2d);
                if (item.stroke !== false) ctx.stroke(p2d);
            }
        };

        // 绘制左右线
        geom.components.LeftLine.forEach(paintItem);
        geom.components.RightLine.forEach(paintItem);

        // 绘制中央装饰（按比例缩放）
        ctx.save();
        ctx.scale(geom.decorationScale, geom.decorationScale);
        geom.components.CenterDecoration.forEach(paintItem);
        ctx.restore();

        ctx.restore();
    }

    // 供图库和项目序列化使用的兼容参数层。预设本体仍是纯数据，函数只来自本地注册表。
    const normalize = (props = {}) => normalizeProps(props);
    presets.forEach((preset) => {
        // `parameters` 是可编辑参数的持久化字段；保留 defaultProps 给渲染器作默认值。
        if (!preset.parameters) preset.parameters = { ...preset.defaultProps };
    });
    const serialize = (items = presets) => JSON.stringify({
        format: 'videokit-divider-presets', version: 1,
        presets: items.map((item) => ({
            id: item.id,
            name: item.name,
            category: item.category,
            categoryLabel: item.categoryLabel,
            decoration: item.decoration,
            mode: item.mode,
            parameters: normalize(item.parameters || item.defaultProps),
        }))
    }, null, 2);
    const parse = (text) => {
        const data = JSON.parse(text || 'null');
        if (data?.format !== 'videokit-divider-presets' || data.version !== 1 || !Array.isArray(data.presets)) {
            throw new Error('不是有效的装饰线预设文件');
        }
        const parsed = data.presets.map((saved) => {
            const builtin = presets.find((preset) => preset.id === saved.id);
            if (builtin) {
                return {
                    ...builtin,
                    name: String(saved.name || builtin.name).slice(0, 100),
                    category: saved.category || builtin.category,
                    categoryLabel: saved.categoryLabel || builtin.categoryLabel,
                    parameters: normalize({ ...builtin.defaultProps, ...saved.parameters })
                };
            }
            return {
                id: saved.id,
                name: String(saved.name || '我的自定义装饰线').slice(0, 100),
                category: saved.category || 'custom',
                categoryLabel: saved.categoryLabel || '我的私人',
                decoration: saved.decoration || 'none',
                mode: saved.mode || 'solid',
                defaultProps: { ...defaultProps },
                parameters: normalize({ ...defaultProps, ...saved.parameters })
            };
        });
        registerPresets(parsed);
        return parsed;
    };

    const presetRegistry = new Map();
    presets.forEach(p => presetRegistry.set(p.id, p));

    function registerPresets(list) {
        if (!Array.isArray(list)) return;
        list.forEach(p => {
            if (p && p.id) {
                presetRegistry.set(p.id, p);
            }
        });
    }

    // 辅助查询与序列化 API
    const api = {
        defaultProps,
        presets,
        get: (id) => presetRegistry.get(id) || presets.find(p => p.id === id) || { id: id || 'solid', name: '实线', category: 'basic', decoration: 'none', mode: 'solid', defaultProps: { ...defaultProps }, parameters: { ...defaultProps } },
        getByCategory: (category) => category === 'all' ? [...presetRegistry.values()] : [...presetRegistry.values()].filter(p => p.category === category),
        register: registerPresets,
        normalize,
        serialize,
        parse,
        computeGeometry,
        geometry: computeGeometry,
        svg: renderSVG,
        draw: drawCanvas,
        categories: [
            { id: 'all', label: '全部', count: presets.length },
            { id: 'custom', label: '我的私人预设', count: 0 }
        ]
    };

    root.DividerPresets = api;
    if (typeof module !== 'undefined') module.exports = api;
})(typeof window === 'undefined' ? globalThis : window);
