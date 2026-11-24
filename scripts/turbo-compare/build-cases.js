/* eslint-disable no-console */
/**
 * build-cases.js — 生成新极速导出（turbo）对比测试用例。
 *
 * 用法：
 *   node scripts/turbo-compare/build-cases.js --media <素材目录> --out <输出目录> [--set quick|full] [--engines precise,turbo]
 *
 * 素材目录需包含：bg.mp4 bg_land.mp4 voice.m4a bgm.mp3 logo.png photo.jpg alpha.mov anim.gif overlay.mp4
 * 生成 <输出目录>/spec.json，供 run.sh / harness.js 使用。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const args = process.argv.slice(2);
const arg = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : fallback;
};
const mediaDir = path.resolve(arg('media', ''));
const outDir = path.resolve(arg('out', path.join(ROOT, 'tmp-turbo-compare')));
const set = arg('set', 'quick');
const engines = arg('engines', 'precise,turbo').split(',');
const personalDir = arg('personal', path.join(ROOT, 'xy个人预设'));
const m = name => path.join(mediaDir, name);

const StyleEngine = require(path.join(ROOT, 'src', 'reels-style-engine.js'));

function loadBuiltinPresets() {
    const code = fs.readFileSync(path.join(ROOT, 'src', 'reels-presets-init.js'), 'utf8');
    function Storage() { }
    Storage.prototype.getItem = function () { return null; };
    Storage.prototype.setItem = function () { };
    Storage.prototype.removeItem = function () { };
    const localStorage = new Storage();
    const sandbox = { window: { addEventListener() { } }, console, Storage, localStorage, document: { addEventListener() { } } };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox, { filename: 'reels-presets-init.js' });
    return {
        subtitles: sandbox.window.REELS_BUILTIN_PRESETS || {},
        overlayGroups: sandbox.window.REELS_BUILTIN_OVERLAY_GROUP_PRESETS || {},
    };
}

function readJsonSafe(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

// 个人预设文件夹：分类目录直属的 JSON（与软件读取规则一致，不含“原始备份”）。
function loadPersonalPresets() {
    const subtitles = {};
    const overlayGroups = {};
    const subDir = path.join(personalDir, '动态字幕预设');
    const ovDir = path.join(personalDir, '覆层预设');
    const collect = (dir, sink, kind) => {
        if (!fs.existsSync(dir)) return;
        for (const name of fs.readdirSync(dir)) {
            if (!name.endsWith('.json')) continue;
            const data = readJsonSafe(path.join(dir, name));
            if (!data) continue;
            let presets = data.presets || data;
            if (presets && presets.presets && typeof presets.presets === 'object') presets = presets.presets;
            if (Array.isArray(presets)) {
                for (const p of presets) if (p && p.name) sink[p.name] = p.style || p.layers ? p : p;
            } else if (presets && typeof presets === 'object') {
                for (const [k, v] of Object.entries(presets)) {
                    if (!v || typeof v !== 'object') continue;
                    if (kind === 'overlay' && !Array.isArray(v.layers)) continue;
                    sink[k] = v;
                }
            }
        }
    };
    collect(subDir, subtitles, 'subtitle');
    collect(ovDir, overlayGroups, 'overlay');
    // 新版个人预设库（预设库/subtitle-library.json、overlay-library.json）
    const lib = path.join(personalDir, '预设库');
    const subLib = readJsonSafe(path.join(lib, 'subtitle-library.json'));
    for (const [k, v] of Object.entries(subLib?.presets?.presets || {})) if (v && typeof v === 'object') subtitles[k] = v;
    const ovLib = readJsonSafe(path.join(lib, 'overlay-library.json'));
    for (const [k, v] of Object.entries(ovLib?.presets || {})) if (v && Array.isArray(v.layers)) overlayGroups[k] = v;
    return { subtitles, overlayGroups };
}

// ── 字幕：4 句，带逐词时间戳 ──
const LINES = [
    [0.20, 2.00, 'Faith can move every mountain'],
    [2.10, 3.90, 'Trust the process today'],
    [4.00, 5.80, 'Blessings are on the way'],
    [5.90, 7.70, 'Say amen and believe it'],
];
function makeSegments(lines = LINES) {
    return lines.map(([start, end, text]) => {
        const words = text.split(' ');
        const step = (end - start) / words.length;
        return {
            start, end, text,
            words: words.map((word, i) => ({ word, text: word, start: +(start + i * step).toFixed(3), end: +(start + (i + 1) * step - 0.02).toFixed(3) })),
        };
    });
}

function styleOf(preset) {
    return StyleEngine.mergeStyle(preset && preset.style ? preset.style : preset);
}

function baseParams(extra = {}) {
    const segments = makeSegments();
    return {
        style: styleOf({}),
        segments,
        originalScript: segments.map(s => s.text).join('\n'),
        scrollingText: segments.map(s => s.text).join('\n'),
        showSubtitle: true,
        overlays: [],
        insertAudioClips: [],
        overlayAboveSubtitle: true,
        backgroundPath: m('bg.mp4'),
        bgMode: 'single',
        bgClipPool: [],
        bgClipSettings: {},
        bgMinClipDur: 5,
        bgMaxClipDur: 7,
        bgClipOrder: 'random',
        bgClipSeed: 'turbo-compare',
        bgTransition: 'crossfade',
        bgTransDur: 0.5,
        contentVideoPath: null,
        contentVideoTrimStart: null,
        contentVideoTrimEnd: null,
        contentVideoScale: 100,
        contentVideoX: 'center',
        contentVideoY: 'center',
        contentVideoVolume: 1,
        contentVideoCrop: '',
        contentVideoBlurBg: false,
        contentVideoBlurStatic: false,
        contentVideoDirectBg: false,
        contentVideoBlur: 40,
        contentVideoBrightness: 60,
        voicePath: m('voice.m4a'),
        targetWidth: 1080,
        targetHeight: 1920,
        fps: 30,
        voiceVolume: 1,
        bgVolume: 0.1,
        loopFade: true,
        loopFadeDur: 1,
        customDuration: 0,
        bgmPath: '',
        bgmVolume: 0.3,
        bgmStart: 0,
        bgScale: 100,
        bgRotation: 0,
        bgX: 0,
        bgY: 0,
        bgFlipH: false,
        bgFlipV: false,
        contentVideoFlipH: false,
        contentVideoFlipV: false,
        bgDurScale: 100,
        audioDurScale: 100,
        reverbEnabled: false,
        reverbPreset: 'hall',
        reverbMix: 30,
        stereoWidth: 100,
        audioFxTarget: 'all',
        useMemoryDecoder: false,
        crf: 23,
        qualityPreset: 'faster',
        targetBitrateMbps: null,
        maxBitrateMbps: null,
        watermarks: [],
        ...extra,
    };
}

const cases = [];
const ids = new Set();
function add(name, tags, params) {
    let id = name.replace(/[^\w\u4e00-\u9fa5-]+/g, '_').slice(0, 60) || 'case';
    let n = 2;
    while (ids.has(id)) id = `${id.replace(/_\d+$/, '')}_${n++}`;
    ids.add(id);
    cases.push({ id, name, tags, params });
}

const builtin = loadBuiltinPresets();
const personal = loadPersonalPresets();
const imageOverlay = (extra = {}) => ({ id: 'ov_logo', type: 'image', name: 'logo', content: m('logo.png'), x: 340, y: 300, w: 400, h: 400, opacity: 255, start: 0, end: 9999, z_index: 1, ...extra });
const videoOverlay = (file, extra = {}) => ({ id: `ov_${path.basename(file)}`, type: 'video', name: path.basename(file), content: m(file), x: 220, y: 1200, w: 640, h: 360, opacity: 255, start: 0.5, end: 9999, z_index: 2, media_loop: true, ...extra });
const textOverlay = (extra = {}) => ({ id: 'ov_text', type: 'text', name: 'title', content: 'TURBO EXPORT TEST', x: 90, y: 160, w: 900, h: 160, fontsize: 72, color: '#FFFFFF', opacity: 255, start: 0, end: 9999, z_index: 3, ...extra });

// ── 1. 基础与背景 ──
add('基础：默认样式 + 视频背景 + 配音', ['基础'], baseParams());
add('背景：图片背景', ['背景'], baseParams({ backgroundPath: m('photo.jpg') }));
add('背景：横屏缩放 + 偏移 + 旋转 + 翻转', ['背景'], baseParams({ backgroundPath: m('bg_land.mp4'), bgScale: 130, bgX: 8, bgY: -5, bgRotation: 7, bgFlipH: true }));
add('背景：循环淡化（背景短于成片）', ['背景'], baseParams({ backgroundPath: m('overlay.mp4'), loopFade: true, loopFadeDur: 0.8 }));
add('背景：多素材 + 转场', ['背景'], baseParams({ bgMode: 'multi', bgClipPool: [m('bg.mp4'), m('bg_land.mp4'), m('photo.jpg')], bgMinClipDur: 2, bgMaxClipDur: 3, bgTransition: 'crossfade', bgTransDur: 0.4 }));
add('背景：时长缩放 150%', ['背景'], baseParams({ bgDurScale: 150 }));
add('背景：全局蒙版', ['背景'], baseParams({ style: styleOf({ global_mask_enabled: true, global_mask_color: '#000000', global_mask_opacity: 0.45 }) }));
add('内容视频：叠加居中', ['内容视频'], baseParams({ contentVideoPath: m('bg_land.mp4'), contentVideoScale: 90, contentVideoY: 0.1 }));
add('内容视频：模糊背景', ['内容视频'], baseParams({ contentVideoPath: m('bg_land.mp4'), contentVideoBlurBg: true }));
add('内容视频：直接作背景 + 裁剪', ['内容视频'], baseParams({ contentVideoPath: m('bg_land.mp4'), contentVideoDirectBg: true, contentVideoCrop: '10,0,80,100' }));

// ── 2. 音频 ──
add('音频：BGM + 混响 + 声场', ['音频'], baseParams({ bgmPath: m('bgm.mp3'), bgmVolume: 0.4, reverbEnabled: true, reverbPreset: 'church', reverbMix: 40, stereoWidth: 140 }));
add('音频：变速 120%', ['音频'], baseParams({ audioDurScale: 120 }));
add('音频：无配音（背景原声）', ['音频'], baseParams({ voicePath: null, customDuration: 6, bgVolume: 0.8 }));

// ── 3. 覆层 ──
add('覆层：PNG 图片', ['覆层'], baseParams({ overlays: [imageOverlay()] }));
add('覆层：视频', ['覆层'], baseParams({ overlays: [videoOverlay('overlay.mp4')] }));
add('覆层：透明视频 (qtrle)', ['覆层'], baseParams({ overlays: [videoOverlay('alpha.mov', { w: 480, h: 480, x: 300 })] }));
add('覆层：GIF', ['覆层'], baseParams({ overlays: [videoOverlay('anim.gif', { w: 320, h: 320, x: 380 })] }));
add('覆层：混合模式 screen', ['覆层'], baseParams({ overlays: [imageOverlay({ blend_mode: 'screen' })] }));
add('覆层：文字 + 在字幕下方', ['覆层'], baseParams({ overlays: [textOverlay()], overlayAboveSubtitle: false }));
add('覆层：水印', ['覆层'], baseParams({ watermarks: [{ enabled: true, type: 'text', text: 'VideoKit', position: 'top-right', fontSize: 28, bgOpacity: 0.5, bgColor: '#000', color: '#fff', textOpacity: 1 }] }));

// ── 4. 字幕动画（全部入场 × 出场类型） ──
const ANIMS = ['none', 'fade', 'slide_up', 'slide_down', 'slide_left', 'slide_right', 'pop', 'typewriter', 'char_bounce',
    'letter_jump', 'word_pop_random', 'word_pop_random_pulse', 'metronome', 'blur_sharp', 'holy_glow', 'floating', 'bullet_reveal', 'flash_highlight'];
for (const anim of ANIMS) {
    add(`动画：${anim}`, ['动画'], baseParams({
        style: styleOf({ anim_in_type: anim, anim_out_type: ['typewriter', 'char_bounce'].includes(anim) ? 'fade' : anim, karaoke_highlight: true, use_stroke: true }),
    }));
}

// ── 5. 字幕样式特性 ──
const FEATURES = {
    '卡拉OK + 动态高亮框': { karaoke_highlight: true, dynamic_box: true, color_high_bg: '#FF3366', opacity_high_bg: 0.6 },
    '背景框 + 圆角': { use_box: true, box_radius: 18, opacity_bg: 180, box_padding_x: 24, box_padding_y: 12 },
    '渐变背景框': { use_box: true, bg_gradient_enabled: true, bg_gradient_colors: ['#FF0066', '#3300FF'] },
    '多层描边': { stroke_expand_enabled: true, stroke_expand_layers: 3, stroke_expand_colors: ['#000000', '#FF0000', '#FFFFFF'], stroke_expand_layer_widths: [4, 8, 12] },
    '阴影 + 下划线': { shadow_blur: 12, opacity_shadow: 200, shadow_offset_y: 6, use_underline: true },
    '速度拖尾': { speed_trail_enabled: true, anim_in_type: 'slide_left' },
    '环境光 + 光照': { ambient_glow_enabled: true, ambient_lighting_enabled: true },
    '滚动歌词': { scrolling_mode: true, scrolling_word_highlight: true, scrolling_card_enabled: true },
    '滚动歌词 + 毛玻璃卡片': { scrolling_mode: true, scrolling_card_enabled: true, scrolling_card_blur_enabled: true },
    '整页打字机': { fullpage_typewriter: true },
    '方块排版': { block_typography_enabled: true },
    '高级文本框': { advanced_textbox_enabled: true, adv_bg_enabled: true, adv_stroke_enabled: true },
    '频谱': { spectrum_enabled: true, spectrum_dual: true },
    '只显示当前词': { only_show_active_word: true, karaoke_highlight: true },
    '框色过渡 + 动态框动画': { use_box: true, box_transition_enabled: true, dyn_box_anim: true, dynamic_box: true },
    '大写 + 斜体 + 旋转': { text_transform: 'uppercase', italic: true, rotation: -6 },
};
for (const [name, style] of Object.entries(FEATURES)) {
    add(`样式：${name}`, ['样式'], baseParams({ style: styleOf(style) }));
}

// ── 6. 预设库（内置 + 个人） ──
const presetDuration = set === 'full' ? 4 : 4;
const subtitlePresets = [
    ...Object.entries(builtin.subtitles).map(([k, v]) => [`内置字幕预设：${k}`, v]),
    ...Object.entries(personal.subtitles).map(([k, v]) => [`个人字幕预设：${k}`, v]),
];
const overlayPresets = [
    ...Object.entries(builtin.overlayGroups).map(([k, v]) => [`内置覆层预设：${k}`, v]),
    ...Object.entries(personal.overlayGroups).map(([k, v]) => [`个人覆层预设：${k}`, v]),
];
const pick = (list, n) => (set === 'full' ? list : list.filter((_, i) => i % Math.ceil(list.length / n) === 0));
for (const [name, preset] of pick(subtitlePresets, 12)) {
    add(name, ['字幕预设'], baseParams({ style: styleOf(preset), customDuration: presetDuration }));
}
for (const [name, preset] of pick(overlayPresets, 8)) {
    const layers = (preset.layers || []).map((layer, i) => ({ id: `ovp_${i}`, start: 0, end: 9999, ...layer }));
    add(name, ['覆层预设'], baseParams({ overlays: layers, customDuration: presetDuration }));
}

const onlyTags = arg('tags', '');
const finalCases = onlyTags ? cases.filter(c => c.tags.some(t => onlyTags.split(',').includes(t))) : cases;
fs.mkdirSync(outDir, { recursive: true });
const spec = { outDir, engines, reference: engines[0], thresholds: { ssimAvg: 0.97, ssimMin: 0.92 }, cases: finalCases };
fs.writeFileSync(path.join(outDir, 'spec.json'), JSON.stringify(spec, null, 2));
console.log(`生成 ${finalCases.length} 个用例 → ${path.join(outDir, 'spec.json')}`);
console.log(`  内置字幕预设 ${Object.keys(builtin.subtitles).length}，个人字幕预设 ${Object.keys(personal.subtitles).length}`);
console.log(`  内置覆层预设 ${Object.keys(builtin.overlayGroups).length}，个人覆层预设 ${Object.keys(personal.overlayGroups).length}`);
