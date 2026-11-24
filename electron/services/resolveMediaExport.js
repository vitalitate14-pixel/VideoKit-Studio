// Native media hand-off with rendered transparent subtitle movies.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL, fileURLToPath } = require('url');
const ffmpeg = require('./ffmpeg');
const MediaWindow = require('../../src/reels-media-window');
const n = (v, d = 0) => Number.isFinite(Number(v)) ? Number(v) : d;
const xml = v => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
function compoundDisplayName(value) {
    let name = String(value || 'VideoKit');
    // Legacy task names may have been assembled from encoded preview URLs.
    try { name = decodeURIComponent(name); } catch (_) {}
    return name.replace(/[\x00-\x1f]/g, ' ').trim() || 'VideoKit';
}
function localPath(value) {
    let p = String(value || '');
    if (/^(file|local-media):\/\//i.test(p)) {
        // 不能手工截掉协议：file://localhost/... 会被截成
        // localhost/...，随后成为相对路径，FCPXML 导入时所有素材都会离线。
        // 使用 Node 的 URL 解析同时正确还原中文、空格和 # 等文件名字符。
        try {
            return fileURLToPath(p.replace(/^local-media:/i, 'file:'));
        } catch (_) {
            p = decodeURIComponent(p.replace(/^(file|local-media):\/\//i, ''));
            if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
        }
    }
    return p;
}

// These formulas deliberately follow drawMediaCover / drawOverlay, including
// legacy half-screen overlays whose drawing box is taller than their mask.
function geometry(task, ov, source, width, height) {
    let x = 0, y = 0, w = width, h = height, scaleX = 1, scaleY = 1, rotation = 0;
    let clip = null, flipX = false, flipY = false, opacity = 1, cover = true;
    if (!ov) {
        scaleX = scaleY = n(task.bgScale, 100) / 100;
        rotation = n(task.bgRotation);
        x = width * n(task.bgX) / 100;
        y = height * n(task.bgY) / 100;
        flipX = !!task.bgFlipH; flipY = !!task.bgFlipV;
    } else {
        x = n(ov.x); y = n(ov.y); w = n(ov.w, 100); h = n(ov.h, 100);
        // scale 是旧工程的统一缩放；新工程可分别保存 X/Y 缩放。
        const legacyScale = n(ov.scale, 1) || 1;
        scaleX = n(ov.scale_x, legacyScale) || legacyScale;
        scaleY = n(ov.scale_y, legacyScale) || legacyScale;
        if (ov.media_window_mode === 'pip') {
            const saved = ov.media_window || { x, y, w, h };
            clip = { x: n(saved.x) + n(saved.w, w) * (1 - scaleX) / 2,
                y: n(saved.y) + n(saved.h, h) * (1 - scaleY) / 2,
                w: n(saved.w, w) * scaleX, h: n(saved.h, h) * scaleY };
            x = clip.x + n(ov.media_inner_x) * scaleX;
            y = clip.y + n(ov.media_inner_y) * scaleY;
            w = clip.w; h = clip.h; scaleX = scaleY = 1;
        } else if (ov.media_window_mode === 'top_half' || ov.media_window_mode === 'bottom_half') {
            const windowY = ov.media_window_mode === 'top_half' ? 0 : height / 2;
            const half=MediaWindow.halfScreen(ov.media_window_mode,ov.media_split_angle,width,height);
            clip=half && Math.abs(half.angle)>0.0001?half.rect:{x:0,y:windowY,w:width,h:height/2};
            if(half && Math.abs(half.angle)>0.0001){w=clip.w;h=clip.h;}
            x=n(ov.media_inner_x);y=clip.y+n(ov.media_inner_y);
        } else if (ov.clip_rect) clip = ov.clip_rect;
        const innerScale = Math.max(.01, n(ov.media_inner_scale, 1));
        scaleX *= innerScale; scaleY *= innerScale;
        rotation = n(ov.rotation) + n(ov.media_inner_rotation);
        flipX = !!ov.flip_x; flipY = !!ov.flip_y;
        const raw = n(ov.opacity, 255); opacity = raw <= 1 ? raw : raw / 255;
        // 必须与 reels-overlay.js 的预览绘制完全一致：只有明确开启
        // crop_fill 才使用 cover，否则按保持比例完整显示。
        cover = !!ov.crop_fill && !(ov.media_blur_fill === true && ['pip', 'top_half', 'bottom_half'].includes(ov.media_window_mode));
    }
    // 与 Canvas 一致：四向裁切只收缩显示窗口，素材本身的 fit/scale 不变。
    const crop = key => Math.max(0, Math.min(99, n(ov?.[key])));
    const cropLeft = crop('media_crop_left'), cropTop = crop('media_crop_top');
    const cropRight = Math.min(crop('media_crop_right'), 99 - cropLeft);
    const cropBottom = Math.min(crop('media_crop_bottom'), 99 - cropTop);
    if (cropLeft || cropTop || cropRight || cropBottom) {
        const base = clip || { x, y, w, h };
        clip = {
            x: n(base.x) + n(base.w) * cropLeft / 100,
            y: n(base.y) + n(base.h) * cropTop / 100,
            w: Math.max(1, n(base.w) * (100 - cropLeft - cropRight) / 100),
            h: Math.max(1, n(base.h) * (100 - cropTop - cropBottom) / 100),
        };
    }
    let dw = w, dh = h;
    if (!ov || ov.keep_aspect !== false || (ov.media_blur_fill === true && ['pip', 'top_half', 'bottom_half'].includes(ov.media_window_mode))) {
        const fit = (cover ? Math.max : Math.min)(w / source.width, h / source.height);
        dw = source.width * fit; dh = source.height * fit;
    }
    dw *= scaleX; dh *= scaleY;
    if (!ov) {
        const radians = Math.abs(rotation % 180) * Math.PI / 180;
        const fill = Math.max(1, width / (Math.abs(dw * Math.cos(radians)) + Math.abs(dh * Math.sin(radians))),
            height / (Math.abs(dw * Math.sin(radians)) + Math.abs(dh * Math.cos(radians))));
        dw *= fill; dh *= fill;
    }
    return { centerX: (x + w / 2) / width, centerY: 1 - (y + h / 2) / height,
        drawWidth: dw, drawHeight: dh, rotation: -rotation, flipX, flipY, opacity, clip, background: !ov };
}

// Match the cropped, width-fit content video used by both Canvas previews.
function contentGeometry(config, source, width, height) {
    const crop = cropValues(config.contentVideoCrop || config.task?.contentVideoCrop);
    const sw = source.width * crop.w / 100, sh = source.height * crop.h / 100;
    const scale = width / sw * n(config.contentVideoScale, n(config.task?.contentVideoScale, 100)) / 100;
    const dw = sw * scale, dh = sh * scale;
    const displacement = (value, size, base) => {
        if (value === 'center') return 0;
        const v = n(value);
        return Math.abs(v) <= 1 ? v * size : v * size / base;
    };
    const x = (width - dw) / 2 + displacement(config.contentVideoX ?? config.task?.contentVideoX, width, 1080);
    const y = (height - dh) / 2 + displacement(config.contentVideoY ?? config.task?.contentVideoY, height, 1920);
    const flipX = !!(config.contentVideoFlipH ?? config.task?.contentVideoFlipH);
    const flipY = !!(config.contentVideoFlipV ?? config.task?.contentVideoFlipV);
    const sourceShiftX = (source.width / 2 - source.width * crop.x / 100 - sw / 2) * scale;
    const sourceShiftY = (source.height / 2 - source.height * crop.y / 100 - sh / 2) * scale;
    return { centerX: (x + dw / 2 + sourceShiftX * (flipX ? -1 : 1)) / width,
        centerY: 1 - (y + dh / 2 + sourceShiftY * (flipY ? -1 : 1)) / height,
        drawWidth: source.width * scale, drawHeight: source.height * scale,
        clip: { x, y, w: dw, h: dh }, rotation: 0, flipX, flipY, opacity: 1 };
}

// Rasterize only the cutout into each source's alpha; Resolve still owns its
// transform, loop segments, timing and audio as separate editable clips.
function diagonalMaskExpression(ov,source,width,height){
    const half=MediaWindow.halfScreen(ov.media_window_mode,ov.media_split_angle,width,height);
    if(!half || Math.abs(half.angle)<0.0001)return null;
    const g=geometry({},ov,source,width,height),r=-g.rotation*Math.PI/180;
    const dx=`((X+0.5-${source.width/2})*${g.drawWidth/source.width*(g.flipX?-1:1)})`;
    const dy=`((Y+0.5-${source.height/2})*${g.drawHeight/source.height*(g.flipY?-1:1)})`;
    const x=`(${g.centerX*width}+${Math.cos(r)}*${dx}-${Math.sin(r)}*${dy})`;
    const y=`(${(1-g.centerY)*height}+${Math.sin(r)}*${dx}+${Math.cos(r)}*${dy})`;
    const seam=`(${height/2}+${Math.tan(half.angle*Math.PI/180)}*(${x}-${width/2}))`;
    const sign=ov.media_window_mode==='top_half'?1:-1,clip=g.clip;
    return `alpha(X,Y)*clip(0.5+${sign}*(${seam}-${y}),0,1)*between(${x},${clip.x},${clip.x+clip.w})*between(${y},${clip.y},${clip.y+clip.h})`;
}
async function prepareDiagonalSources(config,dir,width,height,fps,readMedia=probe,run=ffmpeg.runCommand){
    const overlays=config.overlays || config.task?.overlays || [];
    if(!overlays.some(ov=>!ov.disabled && ['image','video'].includes(ov.type) && ['top_half','bottom_half'].includes(ov.media_window_mode) && n(ov.media_split_angle)))return;
    const folder=path.join(dir,'斜拼接媒体');fs.mkdirSync(folder,{recursive:true});
    config.overlays=overlays.map(ov=>({...ov}));
    for(const ov of config.overlays){
        if(ov.disabled || !['image','video'].includes(ov.type) || !['top_half','bottom_half'].includes(ov.media_window_mode) || !n(ov.media_split_angle))continue;
        const files=ov.media_folder_files?.length?ov.media_folder_files:[ov.content],mapped=[];
        for(const raw of files){
            const file=localPath(raw),source=await readMedia(file),mask=diagonalMaskExpression(ov,source,width,height);
            if(!mask){mapped.push(raw);continue;}
            const stat=fs.statSync(file);
            const hash=crypto.createHash('sha256').update(JSON.stringify([file,stat.size,stat.mtimeMs,mask])).digest('hex').slice(0,24);
            const output=path.join(folder,`${hash}${source.still?'.png':'.mov'}`);
            if(!fs.existsSync(output)){
                const args=['-y','-i',file,'-vf',`format=gbrap,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='${mask}'`];
                if(source.still)args.push('-frames:v','1','-c:v','png','-pix_fmt','rgba');
                else args.push('-map','0:v:0','-map','0:a?','-c:v','prores_ks','-profile:v','4','-pix_fmt','yuva444p10le','-alpha_bits','16','-c:a','pcm_s16le');
                const temporary=output.replace(/(\.[^.]+)$/,'.partial$1');
                try{await run('ffmpeg',[...args,temporary]);fs.renameSync(temporary,output);}
                finally{try{fs.unlinkSync(temporary);}catch(_){}}
            }
            mapped.push(output);
        }
        ov.content=mapped[0];if(ov.media_folder_files?.length)ov.media_folder_files=mapped;
        ov._diagonalOriginalPaths=Object.fromEntries(mapped.map((file,index)=>[localPath(file),localPath(files[index])]));
        ov._diagonalSourceMask=true;
    }
}

function readTimecodeStart(data, stream) {
    const tag = stream?.tags?.timecode || data.format?.tags?.timecode
        || data.streams.find(s => s.codec_type === 'data' && s.tags?.timecode)?.tags.timecode;
    const match = /^(\d{2}):(\d{2}):(\d{2})([:;])(\d{2})$/.exec(String(tag || ''));
    if (!match) return null;
    const [num, den = 1] = String(stream?.r_frame_rate || stream?.avg_frame_rate || '').split('/').map(Number);
    if (!(num > 0 && den > 0)) return null;
    const nominal = Math.round(num / den), hours = Number(match[1]), minutes = Number(match[2]);
    const seconds = Number(match[3]), frame = Number(match[5]);
    if (minutes > 59 || seconds > 59 || frame >= nominal) return null;
    let frames = ((hours * 60 + minutes) * 60 + seconds) * nominal + frame;
    if (match[4] === ';') {
        // Drop-frame numbering omits 2/4 frame labels per minute, except every tenth minute.
        if (![30, 60].includes(nominal) || Math.abs(num / den - nominal * 1000 / 1001) > .001) return null;
        const dropped = nominal / 15, totalMinutes = hours * 60 + minutes;
        frames -= dropped * (totalMinutes - Math.floor(totalMinutes / 10));
    }
    return { value: frames * den, timescale: num };
}

function sourceTime(source, frame, fps) {
    const origin = source.timecodeStart;
    if (!origin?.value) return `${frame}/${fps}s`;
    let numerator = origin.value * fps + frame * origin.timescale;
    let denominator = origin.timescale * fps;
    let a = Math.abs(numerator), b = denominator;
    while (b) { const remainder = a % b; a = b; b = remainder; }
    numerator /= a; denominator /= a;
    return `${numerator}/${denominator}s`;
}

async function probe(filePath) {
    if (!fs.existsSync(filePath)) throw new Error(`素材不存在：${filePath}`);
    const { stdout } = await ffmpeg.runCommand('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', filePath]);
    const data = JSON.parse(stdout), stream = data.streams.find(s => s.codec_type === 'video');
    const audioStream = data.streams.find(s => s.codec_type === 'audio');
    if (!stream && !audioStream) throw new Error(`没有可用音视频流：${filePath}`);
    // 配音/BGM 是纯音频资产；它们没有画面尺寸，但仍必须作为可编辑音轨
    // 进入 Resolve，而不能因为没有 video stream 被拒绝。
    if (!stream) return { width: 0, height: 0, duration: n(data.format?.duration, n(audioStream.duration)),
        fps: 30, audio: true, still: false, audioOnly: true };
    const parts = String(stream.avg_frame_rate || '30/1').split('/').map(Number);
    return { width: stream.width, height: stream.height, duration: n(data.format?.duration, n(stream.duration)),
        fps: parts[0] / (parts[1] || 1) || 30, audio: data.streams.some(s => s.codec_type === 'audio'),
        timecodeStart: readTimecodeStart(data, stream),
        still: /\.(png|jpe?g|webp|bmp)$/i.test(filePath) };
}

function validate(config) {
    // 复合片段必须尽可能完整地交付编辑数据。Canvas 不能由 FCPXML 原样
    // 表达的文字/特效层会在前端先烘焙为透明 PNG（或 PNG 序列），其余媒体
    // 一律保留为可编辑资产，不能再以“暂不支持”阻断整个任务。
    if (!config?.task) throw new Error('缺少任务数据');
}

function cropValues(value) {
    const parts = String(value || '').split(',').map(Number);
    const clamp = (v, fallback) => Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : fallback;
    const x = clamp(parts[0], 0), y = clamp(parts[1], 0);
    const w = Math.max(.01, Math.min(100 - x, clamp(parts[2], 100)));
    const h = Math.max(.01, Math.min(100 - y, clamp(parts[3], 100)));
    return { x, y, w, h };
}

// Resolve does not reliably translate a Gaussian blur declared in FCPXML.
// Render only the derived background, while keeping the original content clip
// above it as editable source media in the compound timeline.
async function createFrostedBackground(config, outputDir, width, height, fps, label) {
    if (!config.contentVideoBlurBg || !config.contentVideoPath) return null;
    const sourcePath = localPath(config.contentVideoPath);
    if (!fs.existsSync(sourcePath)) throw new Error(`内容视频不存在：${sourcePath}`);
    const info = await probe(sourcePath);
    const trimStart = Math.max(0, n(config.contentVideoTrimStart));
    const trimEnd = n(config.contentVideoTrimEnd);
    const usable = trimEnd > trimStart ? trimEnd - trimStart : Math.max(0, info.duration - trimStart);
    const requested = n(config.customDuration);
    const duration = requested > 0 ? requested : usable;
    if (!(duration > 0)) throw new Error('无法确定内容视频毛玻璃背景的时长');
    const crop = cropValues(config.contentVideoCrop);
    const sigma = Math.max(.1, Math.min(100, n(config.contentVideoBlur, 40)));
    // Canvas brightness(x%) 是每个 RGB 通道乘以 x。显式转换为 RGB 后再
    // 用 lutrgb 运算，避免 YUV 下的亮度偏移/色度混合与预览不一致。
    const brightness = Math.max(0, Math.min(100, n(config.contentVideoBrightness, 60)));
    const light = (brightness / 100).toFixed(3);
    const filter = `crop=iw*${(crop.w / 100).toFixed(6)}:ih*${(crop.h / 100).toFixed(6)}:iw*${(crop.x / 100).toFixed(6)}:ih*${(crop.y / 100).toFixed(6)},scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},gblur=sigma=${sigma.toFixed(2)},format=gbrp,lutrgb=r=val*${light}:g=val*${light}:b=val*${light},fps=${fps},setsar=1`;
    const safeLabel = String(label || 'content').replace(/[^a-zA-Z0-9_-]/g, '_');
    const outputPath = path.join(outputDir, `${safeLabel}_content_frosted_bg.${config.contentVideoBlurStatic ? 'png' : 'mp4'}`);
    if (config.contentVideoBlurStatic) {
        await ffmpeg.runCommand('ffmpeg', ['-y', '-ss', String(trimStart), '-i', sourcePath,
            '-frames:v', '1', '-vf', filter, '-an', outputPath], { timeout: 120000 });
        return outputPath;
    }
    await ffmpeg.runCommand('ffmpeg', [
        '-y', '-stream_loop', '-1', '-ss', String(trimStart), '-i', sourcePath,
        '-t', String(duration), '-vf', filter, '-an', '-c:v', 'libx264',
        '-pix_fmt', 'yuv420p', '-movflags', '+faststart', outputPath,
    ], { timeout: Math.max(120000, Math.ceil(duration * 15000)) });
    return outputPath;
}

// Encode the exact rendered frames, without interpolation or dropping frames.
async function encodeSubtitleMovie(sequence, outputPath, fps, run = ffmpeg.runCommand) {
    const count = Number(sequence.totalFrames);
    if (!Number.isInteger(count) || count < 1) throw new Error('动态字幕帧数无效');
    if (Number(sequence.fps) !== fps) throw new Error('动态字幕帧率与时间线不一致，请重新导出');
    for (let frame = 1; frame <= count; frame++) {
        const file = path.join(sequence.directory, `subtitle_${String(frame).padStart(6, '0')}.png`);
        if (!fs.existsSync(file)) throw new Error(`动态字幕缺少第 ${frame} 帧，请重新导出`);
    }
    const temporary = outputPath + '.encoding.mov';
    await run('ffmpeg', [
        '-y', '-framerate', String(fps), '-start_number', '1',
        '-i', path.join(sequence.directory, 'subtitle_%06d.png'),
        '-frames:v', String(count), '-an', '-c:v', 'prores_ks',
        '-profile:v', '4', '-pix_fmt', 'yuva444p10le', '-alpha_bits', '16',
        '-vendor', 'apl0', '-movflags', '+faststart', temporary,
    ], { timeout: Math.max(600000, Math.ceil(count / fps * 15000)) });
    fs.renameSync(temporary, outputPath);
    return { path: outputPath, totalFrames: count, fps, duration: count / fps };
}

async function buildTimeline(config, width, height, fps, readMedia = probe) {
    validate(config);
    const task = config.task || {}, clips = [], sources = new Map();
    async function source(raw, knownMedia = null) {
        const p = localPath(raw);
        if (!p) throw new Error(`任务「${config.taskName || task.baseName || task.fileName || '未命名'}」缺少媒体路径`);
        // 动态字幕 PNG 序列的尺寸、帧率、时长在导出前已知。逐帧再执行
        // ffprobe 会让一条几十秒字幕变成上千个子进程，表现为进度 100% 后
        // 长时间卡在“正在生成 FCPXML”。已知帧直接登记为静态图像资产。
        if (!sources.has(p)) {
            let media;
            try{media=knownMedia || await readMedia(p);}
            catch(error){
                const overlays=config.overlays || task.overlays || [];
                const matched=overlays.map((ov,index)=>({ov,index})).filter(({ov})=>ov && [ov.content,...(ov.media_folder_files || []),...(ov.sequence_frames || [])].some(file=>localPath(file)===p));
                const locations=matched.map(({ov,index})=>`覆层：${ov.slotLabel || ov.name || ov.slotKey || `媒体层 ${index+1}`}${ov.media_folder_path?`\n素材组：${ov.media_folder_path}`:''}`).join('\n');
                throw new Error(`任务${config.taskNumber?` #${config.taskNumber}`:''}「${config.taskName || task.fileName || task.baseName || '未命名任务'}」${locations?'\n'+locations:''}\n${error.message || error}`);
            }
            sources.set(p,{...media,path:p,id:`r${sources.size+1}`});
        }
        return sources.get(p);
    }
    // 毛玻璃模式的“背景”并不是任务的普通背景素材，而是内容视频经过
    // 模糊处理后的派生媒体。它由 createPackage 预先生成；这样 Resolve
    // 导入后仍保留清晰内容视频的独立可编辑轨道。
    const contentAsBackground = !!(config.contentVideoBlurBg || config.contentVideoDirectBg);
    const backgroundPath = config.generatedBlurBackgroundPath
        || (contentAsBackground ? config.contentVideoPath : '')
        || config.backgroundPath || task.bgPath || task.videoPath;
    const bg = await source(backgroundPath);
    // 与预览/MP4 相同：自动时长必须考虑变速后的配音、背景和动态字幕，
    // 不能只拿原始背景时长，否则 150% 配音会在复合片段里被截断。
    const bgScale = n(config.bgDurScale, n(task.bgDurScale, 100)) / 100;
    const audioScale = n(config.audioDurScale, n(task.audioDurScale, 100)) / 100;
    let voiceDuration = 0;
    if (config.voicePath) voiceDuration = (await source(config.voicePath)).duration * audioScale;
    const dynamicDuration = n(config.dynamicSubtitleMovie?.duration, n(config.dynamicSubtitleSequence?.duration));
    const contentDuration = config.contentVideoPath
        ? (await source(config.contentVideoPath)).duration
        : 0;
    const duration = n(config.customDuration) || Math.max(
        (contentAsBackground ? contentDuration : bg.duration * bgScale), voiceDuration, dynamicDuration);
    if (!(duration > 0)) throw new Error('无法确定成片时长');
    const total = Math.max(1, Math.round(duration * fps));
    function add(s, lane, record, count, start, g, audio = false, sourceCount = count) {
        if (count < 1) return;
        clips.push({ name: `VK_${String(clips.length).padStart(6, '0')}`, source: s.id, lane, record, count, start, sourceCount, geometry: g, audio });
    }
    function repeats(s, lane, begin, end, offset, g, loop = true, audio = false) {
        let cursor = begin;
        const durationScale = Math.max(.01, n(g?.durationScale, 1));
        const length = s.still ? end - begin : Math.max(1, Math.round(s.duration * fps));
        let src = s.still ? 0 : Math.round(offset * fps) % length;
        while (cursor < end) {
            const outputSpan = Math.min(end - cursor, Math.max(1, Math.round((length - src) * durationScale)));
            const sourceSpan = Math.min(length - src, Math.max(1, Math.round(outputSpan / durationScale)));
            add(s, lane, cursor, outputSpan, src, g, audio, sourceSpan);
            cursor += outputSpan; src = 0;
            if (!loop && cursor < end) throw new Error('覆层关闭循环且短于显示时长：暂不支持达芬奇尾帧保持');
        }
    }
    // 多背景：前端已按预览规则算好片段。每一个片段都保留原媒体和裁切起点，
    // 因此在 Resolve 内仍可逐段替换/修剪。单背景则延续原有循环铺轨逻辑。
    const bgSegments = Array.isArray(config.backgroundSegments) ? config.backgroundSegments.filter(s => s?.path) : [];
    if (bgSegments.length) {
        for (const segment of bgSegments) {
            const begin = Math.max(0, Math.round(n(segment.start) * fps));
            const end = Math.min(total, Math.round(n(segment.end, segment.start + segment.duration) * fps));
            if (end <= begin) continue;
            const s = await source(segment.path);
            const sourceStart = Math.max(0, Math.round(n(segment.trimStart) * fps));
            const durationScale = Math.max(.01, n(segment.speedFactor, bgScale));
            add(s, 1, begin, end - begin, sourceStart,
                { ...geometry(task, null, s, width, height), durationScale }, !!s.audio,
                Math.max(1, Math.round((end - begin) / durationScale)));
        }
    } else {
        repeats(bg, 1, 0, total, 0, { ...geometry(task, null, bg, width, height), durationScale: bgScale }, true, bg.audio);
    }
    // 内容视频位于背景之上，独立成为可编辑轨道；它不再触发“普通视频导出”
    // 的降级。其位置/缩放沿用默认适配，用户可在 Resolve 内继续调整。
    if (config.contentVideoPath && !config.contentVideoDirectBg) {
        const content = await source(config.contentVideoPath);
        const begin = 0;
        const start = Math.max(0, Math.round(n(config.contentVideoTrimStart) * fps));
        const end = config.contentVideoTrimEnd != null ? Math.max(start + 1, Math.round(n(config.contentVideoTrimEnd) * fps)) : Math.round(content.duration * fps);
        const span = Math.max(1, end - start);
        let cursor = begin;
        while (cursor < total) {
            const count = Math.min(span, total - cursor);
            const contentVolume = Math.max(0, n(config.contentVideoVolume, n(task.contentVideoVolume, 100) / 100));
            add(content, 2, cursor, count, start,
                { ...contentGeometry(config, content, width, height), audioVolume: contentVolume },
                !!content.audio && contentVolume > 0);
            cursor += count;
        }
    }
    // 配音与 BGM 是独立的可编辑音频轨。lane 使用负数，避免成为画面覆层。
    const addAudio = async (raw, lane, sourceOffsetSeconds = 0, volume = 1, speed = 1, loop = false, timelineOffsetSeconds = 0) => {
        if (!raw) return;
        const audio = await source(raw);
        const begin = Math.max(0, Math.round(timelineOffsetSeconds * fps));
        if (begin >= total) return;
        const sourceFrames = Math.max(1, Math.round(audio.duration * fps));
        let cursor = begin;
        let sourceStart = Math.min(sourceFrames - 1, Math.max(0, Math.round(sourceOffsetSeconds * fps)));
        // BGM 和普通视频导出一致：从用户设定的起点开始，短于成片时从头
        // 自动接着循环。配音调用此函数时 loop=false，只保留一次原声。
        while (cursor < total) {
            const remainingSource = sourceFrames - sourceStart;
            const availableOutput = Math.max(1, Math.round(remainingSource * speed));
            const count = Math.min(total - cursor, availableOutput);
            const sourceCount = Math.min(remainingSource, Math.max(1, Math.round(count / speed)));
            add(audio, lane, cursor, count, sourceStart, { audioOnly: true, volume, speed }, true, sourceCount);
            cursor += count;
            if (!loop) break;
            sourceStart = 0;
        }
    };
    await addAudio(config.voicePath, -1, 0, n(config.voiceVolume, 1), audioScale);
    await addAudio(config.bgmPath, -2, n(config.bgmStart), n(config.bgmVolume, 1), 1, true);
    // The renderer supplies z_index from visualOverlayOrder.  Sort again at
    // this boundary so a caller cannot accidentally restore creation order
    // simply by passing an unsorted overlays array.
    const ovs = [...(config.overlays || task.overlays || [])]
        .sort((a, b) => n(a.z_index) - n(b.z_index));
    let blurLaneOffset = 0;
    for (let i = 0; i < ovs.length; i++) {
        const ov = ovs[i]; if (ov.disabled) continue;
        // 布局可保留未分配素材的图片/视频槽，预览不绘制，导出也应跳过。
        if (['image', 'video'].includes(ov.type) && !ov.content
            && !ov.media_folder_files?.some(Boolean)) continue;
        const begin = Math.max(0, Math.round(n(ov.start) * fps));
        const end = Math.min(total, ov.end == null || ov.end >= 9999 ? total : Math.round(n(ov.end) * fps));
        if (end <= begin) continue;
        const blurEnabled = ov.media_blur_fill === true && ['pip', 'top_half', 'bottom_half'].includes(ov.media_window_mode);
        const backgroundLane = i + (config.contentVideoPath ? 3 : 2) + blurLaneOffset;
        if (blurEnabled) blurLaneOffset++;
        const mediaLane = i + (config.contentVideoPath ? 3 : 2) + blurLaneOffset;
        if (!['image', 'video'].includes(ov.type)) {
            const png = config.resolveStaticLayers?.find(layer => layer.id && layer.id === ov.id)
                || config.resolveStaticLayers?.find(layer => layer.index === i);
            if (!png) throw new Error(`第 ${i + 1} 层缺少静态 PNG`);
            const s = await source(png.path);
            add(s, mediaLane, begin, end - begin, 0, null);
            continue;
        }
        const files = ov.media_folder_files?.length ? ov.media_folder_files : [ov.content];
        let cursor = begin, index = 0;
        while (cursor < end) {
            const s = await source(files[index % files.length]);
            // 媒体覆层仍默认只输出画面；用户显式开启时，视频覆层才携带其原声音轨。
            const keepOverlayAudio = ov.type === 'video' && ov.media_audio_enabled === true && !!s.audio;
            const interval = files.length > 1 || ov.media_folder_files?.length
                ? (n(ov.media_folder_interval) > 0 ? n(ov.media_folder_interval) : (s.still ? 5 : s.duration))
                : (end - cursor) / fps;
            const stop = Math.min(end, cursor + Math.max(1, Math.round(interval * fps)));
            if (blurEnabled) {
                const png = config.resolveBlurLayers?.find(layer =>
                    (ov.id ? layer.id === ov.id : layer.index === i) && localPath(layer.sourcePath) === (ov._diagonalOriginalPaths?.[s.path] || s.path));
                if (!png) throw new Error('静态模糊背景缺失，请重新导出');
                const background = await source(png.path);
                add(background, backgroundLane, cursor, stop - cursor, 0, null);
            }
            const g = geometry(task, ov, s, width, height);
            if(ov._diagonalSourceMask)g.clip=null;
            if (!ov.media_folder_files?.length && !s.still) {
                const sourceLength = Math.max(1, Math.round(s.duration * fps));
                const trimIn = Math.min(sourceLength - 1, Math.max(0, Math.round(n(ov.video_start_offset) * fps)));
                const requestedOut = Math.round(n(ov.video_end_offset) * fps);
                const trimOut = requestedOut > trimIn ? Math.min(sourceLength, requestedOut) : sourceLength;
                const span = trimOut - trimIn;
                let at = cursor;
                while (at < stop) {
                    const count = Math.min(span, stop - at);
                    add(s, mediaLane, at, count, trimIn, { ...g, audioVolume: 1 }, keepOverlayAudio);
                    at += count;
                    if (ov.media_loop === false && at < stop) throw new Error('关闭循环的裁切素材短于显示时长：达芬奇导出暂不支持尾帧保持');
                }
            } else repeats(s, mediaLane, cursor, stop, n(ov.video_start_offset), { ...g, audioVolume: 1 }, ov.media_loop !== false, keepOverlayAudio);
            cursor = stop; index++;
        }
        if (ov.media_border_style && ov.media_border_style !== 'none') {
            const border = config.resolveBorderLayers?.find(layer => ov.id ? layer.id === ov.id : layer.index === i);
            if (!border) throw new Error('画中画边框资产缺失，请重新导出');
            const png = await source(border.path);
            add(png, mediaLane + 1, begin, end - begin, 0, null);
            blurLaneOffset++;
        }
    }
    // Prefer one continuous transparent movie. Legacy callers may still supply PNG frames.
    const sequence = config.dynamicSubtitleSequence;
    if (config.dynamicSubtitleMovie?.path) {
        const movie = config.dynamicSubtitleMovie;
        const s = await source(movie.path, { width, height, duration: movie.duration, fps, audio: false, still: false });
        add(s, 1000, 0, Math.min(total, movie.totalFrames), 0, null, false);
    } else if (sequence?.directory && sequence.totalFrames > 0) {
        for (let frame = 0; frame < Math.min(total, Number(sequence.totalFrames)); frame++) {
            const png = path.join(sequence.directory, `subtitle_${String(frame + 1).padStart(6, '0')}.png`);
            if (!fs.existsSync(png)) continue;
            const s = await source(png, {
                width, height, duration: 1 / fps, fps, audio: false, still: true,
            });
            add(s, 1000, frame, 1, 0, null, false);
        }
    }
    return { width, height, fps, total, clips, sources: [...sources.values()], bgVolume: n(config.bgVolume, 1) };
}

function timelineXml(plans, name) {
    if (!Array.isArray(plans)) plans = [plans];
    const { width, height, fps } = plans[0];
    const f = frame => `${frame}/${fps}s`;
    const value = v => Number(v.toFixed(9));
    let resources = `<format id="canvas" width="${width}" height="${height}" frameDuration="1/${fps}s"/>`;
    let main = '', offset = 0;
    plans.forEach((plan, index) => {
        const prefix = `t${index}_`, byId = new Map(plan.sources.map(s => [s.id, s]));
        for (const s of plan.sources) {
            // Resolve can create an audio lane from an asset's metadata even
            // when its connected asset-clip is video-only.  Declare audio
            // only for a source actually used by the background storyline.
            const hasTimelineAudio = plan.clips.some(clip => clip.source === s.id && clip.audio);
            if (!s.audioOnly) resources += `<format id="${prefix}fmt_${s.id}" width="${s.width}" height="${s.height}" frameDuration="1000/${Math.round(s.fps * 1000)}s"/>`;
            resources += `<asset id="${prefix}${s.id}" name="${xml(path.basename(s.path))}" src="${xml(pathToFileURL(s.path).href)}" start="${s.timecodeStart?.value ? sourceTime(s, 0, fps) : '0s'}" duration="${s.still ? '0s' : f(Math.round(s.duration * fps))}" hasVideo="${s.audioOnly ? 0 : 1}" hasAudio="${hasTimelineAudio ? 1 : 0}"${s.audioOnly ? '' : ` format="${prefix}fmt_${s.id}"`}/>`;
        }
        // 静态图片必须保留原始 format。把横图标成竖屏 canvas 会让 Resolve
        // 在应用变换之前先按竖屏尺寸解释图片，导致横图被挤成窄条或裁掉。
        // 画布内烘焙的 PNG 本来就是画布尺寸，保留其 format 也不改变布局。
        function mediaClip(c, targetW, targetH, originX = 0, originY = 0, children = '', parentSource = null) {
            const s = byId.get(c.source), g = c.geometry;
            // 覆层默认仅画面；仅当用户在媒体覆层中明确开启原声时，才让该
            // video asset-clip 启用 audio，避免旧工程导出时意外出现覆层声音。
            // A spine item is the primary storyline and therefore has no
            // lane.  Only attached overlays carry a positive lane number.
            const lane = c.lane === 1 ? '' : ` lane="${c.lane > 1 ? c.lane - 1 : c.lane}"`;
            const audioOnly = !!(s.audioOnly || c.geometry?.audioOnly);
            const clipFormat = s.still ? `${prefix}fmt_${s.id}` : 'canvas';
            const recordTime = parentSource ? sourceTime(parentSource, c.record, fps) : f(c.record);
            let out = `<asset-clip name="${xml(path.basename(s.path))}" ref="${prefix}${s.id}"${audioOnly ? '' : ` format="${clipFormat}"`}${lane} offset="${recordTime}" start="${sourceTime(s, c.start, fps)}" duration="${f(c.count)}" srcEnable="${audioOnly ? 'audio' : (c.audio ? 'all' : 'video')}">`;
            if (audioOnly) {
                const volume = n(c.geometry?.volume, 1);
                if (volume !== 1) out += `<adjust-volume amount="${volume > 0 ? value(20 * Math.log10(volume)) : -96}dB"/>`;
                if (c.sourceCount !== c.count) {
                    out += `<timeMap><timept time="0s" value="${sourceTime(s, c.start, fps)}" interp="linear"/><timept time="${f(c.count)}" value="${sourceTime(s, c.start + c.sourceCount, fps)}" interp="linear"/></timeMap>`;
                }
                return out + '</asset-clip>';
            }
            if (g?.clip) {
                // Resolve discards the format/mask of a nested FCPXML media
                // sequence.  Write a real FCPXML Trim crop on the source clip
                // instead.  Its values are expressed in percent of *source
                // frame height* (including left/right), per the FCPXML DTD.
                // The transform below remains the inner-media transform, so
                // the crop is recalculated for every loop segment.
                const cx = g.centerX * width, cy = (1 - g.centerY) * height;
                const sx = Math.max(1e-6, Math.abs(g.drawWidth / s.width));
                const sy = Math.max(1e-6, Math.abs(g.drawHeight / s.height));
                const leftPx = Math.max(0, Math.min(s.width, (g.clip.x - (cx - Math.abs(g.drawWidth) / 2)) / sx));
                const rightPx = Math.max(0, Math.min(s.width, ((cx + Math.abs(g.drawWidth) / 2) - (g.clip.x + g.clip.w)) / sx));
                const topPx = Math.max(0, Math.min(s.height, (g.clip.y - (cy - Math.abs(g.drawHeight) / 2)) / sy));
                const bottomPx = Math.max(0, Math.min(s.height, ((cy + Math.abs(g.drawHeight) / 2) - (g.clip.y + g.clip.h)) / sy));
                const unit = 100 / s.height;
                out += `<adjust-crop mode="trim"><trim-rect left="${value(leftPx * unit)}" top="${value(topPx * unit)}" right="${value(rightPx * unit)}" bottom="${value(bottomPx * unit)}"/></adjust-crop>`;
            }
            // Normalize against an explicit fit. Resolve's media sizing can
            // conform smaller sources before applying the imported transform;
            // pixel/source scale would then apply that enlargement twice.
            const conformScale = Math.min(targetW / s.width, targetH / s.height);
            out += '<adjust-conform type="fit"/>';
            if (g) {
                const x = g.centerX * width - originX - targetW / 2;
                const y = targetH / 2 - ((1 - g.centerY) * height - originY);
                // Resolve applies imported position percentages to the fitted
                // source image height, even in a canvas-format asset-clip.
                // Landscape sources fitted by width are much shorter than the
                // vertical canvas: using targetH therefore under-translates them.
                const positionHeight = s.height * conformScale;
                // Portrait media fitted by height occupies less than the canvas
                // width. Resolve's horizontal import displacement uses that
                // fitted aperture; compensate X only (Y already uses its height).
                const horizontalAperture = Math.min(1, s.width * conformScale / targetW);
                out += `<adjust-transform position="${value(x * 100 / (positionHeight * horizontalAperture))} ${value(y * 100 / positionHeight)}" scale="${value(g.drawWidth / (s.width * conformScale) * (g.flipX ? -1 : 1))} ${value(g.drawHeight / (s.height * conformScale) * (g.flipY ? -1 : 1))}" rotation="${value(g.rotation)}" anchor="0 0"/>`;
                if (g.opacity !== 1) out += `<adjust-blend amount="${value(g.opacity)}"/>`;
            }
            // FCPXML timeMap keeps the original media editable while making
            // the imported clip play at the same duration scale as preview/MP4.
            if (c.sourceCount !== c.count) {
                out += `<timeMap><timept time="0s" value="${sourceTime(s, c.start, fps)}" interp="linear"/><timept time="${f(c.count)}" value="${sourceTime(s, c.start + c.sourceCount, fps)}" interp="linear"/></timeMap>`;
            }
            if (c.audio) {
                const volume = n(c.geometry?.audioVolume, plan.bgVolume);
                out += `<adjust-volume amount="${volume > 0 ? value(20 * Math.log10(volume)) : -96}dB"/>`;
            }
            return out + children + '</asset-clip>';
        }
        // The background belongs in the compound's primary storyline.  Putting
        // it and every overlay as siblings below a synthetic <gap> makes
        // Resolve infer a connected-clip chain (and can place FX/media layers
        // below their intended parent).  Attach overlays to their background
        // asset instead: lane 1 is directly above the picture, lane 2 above
        // lane 1, etc.  This also leaves the layer tree editable after import.
        const backgrounds = plan.clips.filter(c => c.lane === 1);
        const overlays = plan.clips.filter(c => c.lane > 1);
        const audioTracks = plan.clips.filter(c => c.lane < 0);
        let body = '';
        for (const background of backgrounds) {
            // Connected clips use the parent's source clock, including embedded timecode.
            const parentSource = byId.get(background.source);
            const children = overlays
                .filter(overlay => overlay.record >= background.record
                    && overlay.record < background.record + background.count)
                .map(overlay => mediaClip(overlay, width, height, 0, 0, '', parentSource));
            // 音频轨只挂到与其起点相交的背景片段，避免跨背景切换时重复。
            children.push(...audioTracks.filter(audio => audio.record >= background.record
                && audio.record < background.record + background.count)
                .map(audio => mediaClip(audio, width, height, 0, 0, '', parentSource)));
            body += mediaClip(background, width, height, 0, 0, children.join(''));
        }
        const taskId = `${prefix}task`, taskName = plan.name || `Task ${index + 1}`;
        resources += `<media id="${taskId}" name="${xml(taskName)}"><sequence format="canvas" duration="${f(plan.total)}" tcStart="0s" tcFormat="NDF"><spine>${body}</spine></sequence></media>`;
        main += `<ref-clip name="${xml(taskName)}" ref="${taskId}" format="canvas" offset="${f(offset)}" start="0s" duration="${f(plan.total)}"/>`;
        offset += plan.total;
    });
    return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE fcpxml>\n<fcpxml version="1.9"><resources>${resources}</resources><library><event name="VideoKit"><project name="${xml(name)}"><sequence format="canvas" duration="${f(offset)}" tcStart="0s" tcFormat="NDF"><spine>${main}</spine></sequence></project></event></library></fcpxml>\n`;
}

// Resolve imports FCPXML by opening the URI embedded in each <asset>.  A URI
// that points back to the editor's original media folder is fragile: moving a
// project, handing the export to another machine, or importing only the XML
// makes every such asset offline.  Materialize editable source media inside
// the Resolve package and rewrite the task config to those package paths.
// Hard links are instant and do not duplicate bytes on the same volume; when
// unavailable (for example across volumes), copyFile is the safe fallback.
function packageEditableMedia(config, packageDir) {
    const mediaDir = path.join(packageDir, 'Media');
    const copied = new Map();
    const toPackage = raw => {
        const original = localPath(raw);
        if (!original || !path.isAbsolute(original)) return raw;
        const source = path.resolve(original);
        if (!fs.existsSync(source)) return raw;
        const relative = path.relative(packageDir, source);
        if (relative && !relative.startsWith(`..${path.sep}`) && relative !== '..') return source;
        if (copied.has(source)) return copied.get(source);
        fs.mkdirSync(mediaDir, { recursive: true });
        const name = `${String(copied.size + 1).padStart(4, '0')}_${path.basename(source)}`;
        const target = path.join(mediaDir, name);
        try { fs.linkSync(source, target); }
        catch (_) { fs.copyFileSync(source, target); }
        copied.set(source, target);
        return target;
    };
    const sourceOverlays = config.overlays || config.task?.overlays || [];
    const overlays = sourceOverlays.map(ov => ({
        ...ov,
        media_folder_files: Array.isArray(ov.media_folder_files)
            ? ov.media_folder_files.map(toPackage) : ov.media_folder_files,
    }));
    const output = {
        ...config,
        task: { ...(config.task || {}), overlays },
        overlays,
        backgroundSegments: Array.isArray(config.backgroundSegments)
            ? config.backgroundSegments.map(segment => ({ ...segment, path: toPackage(segment.path) }))
            : config.backgroundSegments,
        resolveBlurLayers: Array.isArray(config.resolveBlurLayers)
            ? config.resolveBlurLayers.map(layer => ({ ...layer, path: toPackage(layer.path), sourcePath: toPackage(layer.sourcePath) }))
            : config.resolveBlurLayers,
        resolveStaticLayers: Array.isArray(config.resolveStaticLayers)
            ? config.resolveStaticLayers.map(layer => ({ ...layer, path: toPackage(layer.path) }))
            : config.resolveStaticLayers,
    };
    for (const key of ['backgroundPath', 'contentVideoPath', 'voicePath', 'bgmPath']) output[key] = toPackage(config[key]);
    for (const key of ['bgPath', 'videoPath']) output.task[key] = toPackage(config.task?.[key]);
    output.overlays.forEach(ov => {
        ov.content = toPackage(ov.content);
    });
    return output;
}

// Resolve 的 FCPXML 导入器会把 URL 编码后的 emoji 路径读成 U+FFFD（�）。
// 不能复制原媒体，因此仅对受影响的文件建立零字节符号链接，FCPXML 引用
// 这个 ASCII 链接路径，Resolve 实际读取的仍是用户的原文件。
function linkEmojiSourceMedia(config, outputDir) {
    const linksDir = path.join(outputDir, 'SourceLinks');
    const linked = new Map();
    const toLink = raw => {
        const original = localPath(raw);
        if (!original || !path.isAbsolute(original) || !/[\u{10000}-\u{10FFFF}]/u.test(original)) return raw;
        const source = path.resolve(original);
        if (!fs.existsSync(source)) return raw;
        if (linked.has(source)) return linked.get(source);
        fs.mkdirSync(linksDir, { recursive: true });
        const ext = path.extname(source);
        const target = path.join(linksDir, `source_${String(linked.size + 1).padStart(4, '0')}${ext}`);
        try { fs.symlinkSync(source, target); }
        catch (error) {
            // 若同名导出目录已存在，链接已经指向同一原文件可继续使用；
            // 绝不在这里退回复制媒体。
            if (!fs.existsSync(target)) throw error;
        }
        linked.set(source, target);
        return target;
    };
    const sourceOverlays = config.overlays || config.task?.overlays || [];
    const overlays = sourceOverlays.map(ov => ({
        ...ov,
        media_folder_files: Array.isArray(ov.media_folder_files)
            ? ov.media_folder_files.map(toLink) : ov.media_folder_files,
        content: toLink(ov.content),
    }));
    const output = {
        ...config,
        task: { ...(config.task || {}), overlays },
        overlays,
        backgroundSegments: Array.isArray(config.backgroundSegments)
            ? config.backgroundSegments.map(segment => ({ ...segment, path: toLink(segment.path) }))
            : config.backgroundSegments,
        resolveBlurLayers: Array.isArray(config.resolveBlurLayers)
            ? config.resolveBlurLayers.map(layer => ({ ...layer, path: toLink(layer.path), sourcePath: toLink(layer.sourcePath) }))
            : config.resolveBlurLayers,
        resolveStaticLayers: Array.isArray(config.resolveStaticLayers)
            ? config.resolveStaticLayers.map(layer => ({ ...layer, path: toLink(layer.path) }))
            : config.resolveStaticLayers,
    };
    for (const key of ['backgroundPath', 'contentVideoPath', 'voicePath', 'bgmPath']) output[key] = toLink(config[key]);
    for (const key of ['bgPath', 'videoPath']) output.task[key] = toLink(config.task?.[key]);
    return output;
}

async function normalizeStillSources(plan, dir, cache = new Map(), run = ffmpeg.runCommand) {
    for (const source of plan.sources) {
        if (!source.still || Math.abs(source.width * plan.height - source.height * plan.width) < .01) continue;
        const fit = Math.min(plan.width / source.width, plan.height / source.height);
        const scaledWidth = Math.max(1, Math.round(source.width * fit));
        const scaledHeight = Math.max(1, Math.round(source.height * fit));
        const originalPath = source.path;
        const key = `${originalPath}\n${plan.width}x${plan.height}`;
        let normalized = cache.get(key);
        if (!normalized) {
            const assetDir = path.join(dir, 'ImageFit');fs.mkdirSync(assetDir,{recursive:true});
            normalized = path.join(assetDir, `image_${crypto.createHash('sha256').update(key).digest('hex').slice(0,16)}.png`);
            await run('ffmpeg',['-y','-i',originalPath,'-vf',
                `scale=${scaledWidth}:${scaledHeight}:flags=lanczos,format=rgba,pad=${plan.width}:${plan.height}:(ow-iw)/2:(oh-ih)/2:color=black@0`,
                '-frames:v','1','-c:v','png',normalized]);
            cache.set(key,normalized);
        }
        // Padding changes source bounds, not the visible image center or size.
        for (const clip of plan.clips) if (clip.source === source.id && clip.geometry) {
            clip.geometry.drawWidth *= plan.width / scaledWidth;
            clip.geometry.drawHeight *= plan.height / scaledHeight;
        }
        source.originalPath = originalPath;source.path = normalized;
        source.width = plan.width;source.height = plan.height;
    }
    return plan;
}

async function createPackage({ tasks, output_dir, task_name = 'VideoKit', width = 1080, height = 1920, fps = 30 }) {
    if (!tasks?.length) throw new Error('没有可导出的任务');
    fps = Math.max(1, Math.round(fps));
    const safe = String(task_name).replace(/[<>:"/\\|?*]/g, '_');
    const dir = path.join(output_dir, `${safe}_Resolve`);
    fs.mkdirSync(dir, { recursive: true });
    const manifests = [];
    const normalizedImages = new Map();
    for (let i = 0; i < tasks.length; i++) {
        // 只引用用户原始媒体路径；emoji 路径仅通过零字节符号链接绕过
        // Resolve 的 URI 解码缺陷，绝不复制或打包媒体字节。
        const taskConfig = linkEmojiSourceMedia(tasks[i], dir);
        // Generated filenames are technical identifiers, independent of long clip labels.
        const label = `task_${String(i + 1).padStart(3, '0')}`;
        taskConfig.generatedBlurBackgroundPath = await createFrostedBackground(taskConfig, dir, width, height, fps, label);
        if (taskConfig.dynamicSubtitleSequence?.directory) {
            const movieName = label.replace(/[<>:"/\\|?*]/g, '_') + '_字幕透明.mov';
            taskConfig.dynamicSubtitleMovie = await encodeSubtitleMovie(taskConfig.dynamicSubtitleSequence, path.join(dir, movieName), fps);
        }
        await prepareDiagonalSources(taskConfig,dir,width,height,fps);
        const plan = await buildTimeline(taskConfig, width, height, fps);
        await normalizeStillSources(plan,dir,normalizedImages);
        plan.name = `${String(i + 1).padStart(3, '0')}_${compoundDisplayName(tasks[i].taskName || tasks[i].task?.baseName)}`;
        manifests.push(plan);
    }
    fs.writeFileSync(path.join(dir, 'media.json'), JSON.stringify(manifests, null, 2));
    const outputPath = path.join(dir, `${safe}.fcpxml`);
    fs.writeFileSync(outputPath, timelineXml(manifests, safe));
    fs.writeFileSync(path.join(dir, '使用说明.txt'), '在达芬奇中选择 文件 > 导入 > 时间线，打开同目录的 .fcpxml。\n主时间线上每个任务是一个复合片段：内部保留多背景、内容视频、图片/视频覆层、时间线插入素材、配音和 BGM 的可编辑轨道。\n内容视频选择“毛玻璃”背景时，包内会额外生成已模糊压暗的背景 MP4（单帧模式为 PNG）；原内容视频仍在其上方作为可编辑轨道。\n文字卡片/文本/蒙版作为透明 PNG 图层；动态字幕以 ProRes 4444 透明 MOV 单片段自动进入最上方轨道。\n双击进入复合片段即可替换素材、调整裁切、缩放、位置、音量和剪辑。\n请保留原始媒体、透明 MOV 及静态 PNG；本文件使用绝对素材路径。\n');
    return { outputPath, tasks: manifests.length, native_media: true };
}
module.exports = { readTimecodeStart, sourceTime, prepareDiagonalSources, diagonalMaskExpression, encodeSubtitleMovie, geometry, contentGeometry, buildTimeline, timelineXml, createPackage, packageEditableMedia, linkEmojiSourceMedia, localPath, validate, cropValues, normalizeStillSources };
