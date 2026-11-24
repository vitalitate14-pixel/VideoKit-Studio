// Optional media preparation. Without an explicit Apply, existing media is untouched.
(function(root) {
    const busy = new WeakSet();
    const own = (object,key) => Object.prototype.hasOwnProperty.call(object,key);
    function snapshot(object, keys) {
        return Object.fromEntries(keys.map(key=>[key,{exists:own(object,key),value:object[key]}]));
    }
    function restore(object, fields) {
        for(const [key,field] of Object.entries(fields)) {
            if(field.exists) object[key]=field.value; else delete object[key];
        }
    }
    function active(object, kind) {
        const effect = object?.playbackDelay;
        return effect?.kind===kind && object[kind==='background'?'bgPath':'content']===effect.path ? effect : null;
    }
    async function apply(object, kind, delay, api=root.electronAPI, isCurrent=()=>true) {
        if(busy.has(object)) throw new Error('正在生成等待播放副本，请稍候');
        const seconds=Number(delay);
        if(!Number.isFinite(seconds)||seconds<0||seconds>600)throw new Error('等待时间应为 0–600 秒');
        const prior=active(object,kind);
        if(!seconds) {
            if(prior)restore(object,prior.original);
            delete object.playbackDelay;
            return object;
        }
        if(kind==='overlay' && (!(object.type==='video'||/\.(mp4|mov|mkv|webm|m4v|avi)$/i.test(object.content||''))||object.media_folder_files?.length||object.is_img_sequence))throw new Error('请先选择单个视频覆层；文件夹轮换和序列帧暂不支持等待播放');
        if(kind==='background' && (object.bgMode==='multi'||object.bgMode==='clippool'))throw new Error('请先切换为单个背景视频');
        if(!api?.apiCall)throw new Error('请在桌面版使用等待播放');
        const keys=kind==='background'?['bgPath','videoPath','bgSrcUrl','srcUrl','duration']:['content','video_start_offset','video_end_offset','end'];
        const original=prior?.original || snapshot(object,keys);
        const value=key=>original[key]?.value;
        const source=kind==='background'?value('bgPath')||value('videoPath'):value('content');
        const fingerprint=JSON.stringify(keys.map(key=>object[key]));
        busy.add(object);
        try {
            const result=await api.apiCall('media/prepare-playback-delay',{
                source,delay:kind==='background' ? seconds/((Number(object.bgDurScale)||100)/100) : seconds,
                trimStart:kind==='overlay'?Number(value('video_start_offset'))||0:0,
                trimEnd:kind==='overlay'?value('video_end_offset')??null:null,
            });
            if(!result?.path)throw new Error(result?.error||'等待播放副本生成失败');
            if(!isCurrent())throw new Error('已切换任务或覆层，本次未应用；请重新选择后应用');
            if(JSON.stringify(keys.map(key=>object[key]))!==fingerprint)throw new Error('生成期间素材或时间范围已变更，请重新应用');
            if(kind==='background') {
                object.bgPath=result.path;
                if(!value('videoPath')||value('videoPath')===source)object.videoPath=result.path;
                object.bgSrcUrl=null;object.srcUrl=null;object.duration=result.duration;
            } else {
                object.content=result.path;object.video_start_offset=0;object.video_end_offset=null;
                const end=Number(value('end'));
                if(Number.isFinite(end)&&end>0&&end<9999)object.end=end+seconds;
            }
            object.playbackDelay={kind,seconds,path:result.path,source,original,duration:result.duration};
            return object;
        } finally {busy.delete(object);}
    }
    function minimumDuration(task) {
        let duration=0;
        const bg=active(task,'background');
        if(bg)duration=bg.duration*(Number(task.bgDurScale)||100)/100;
        for(const ov of task?.overlays || []) {
            const effect=active(ov,'overlay');
            if(effect && !ov.disabled)duration=Math.max(duration,(Number(ov.start)||0)+effect.duration);
        }
        if (duration > 0) {
            for (const ov of task?.overlays || []) {
                if (!ov.disabled && ov.flipper_enabled) {
                    const lines=String(ov.type==='textcard'?ov.body_text||'':ov.content||'').split('\n').filter(line=>line.trim()).length;
                    duration=Math.max(duration,(Number(ov.start)||0)+Math.ceil(lines/(Number(ov.flipper_lines)||2))*(Number(ov.flipper_duration)||2));
                }
            }
            // The delay extends automatic duration; it must not shorten a longer voice/subtitle timeline.
            const audioDuration = typeof root._getAudioDuration === 'function' ? root._getAudioDuration(task)
                : Number(root._reelsState?._mediaDurations?.[task.audioPath]) || 0;
            duration = Math.max(duration, audioDuration * (Number(task.audioDurScale)||100)/100,
                ...(task.segments || []).map(segment => Number(segment.end)||0));
        }
        return duration;
    }
    function audioClips(overlays, backgroundPath) {
        const enabled=(overlays||[]).filter(ov=>!ov.disabled && (ov.type==='video'||/\.(mp4|mov|mkv|webm|m4v|avi)$/i.test(ov.content||'')) && ov.media_audio_enabled===true && !ov.media_folder_files?.length);
        return enabled.map(ov=>({path:ov.content,start:Math.max(0,Number(ov.start)||0),end:Number(ov.end)||9999,
            trimStart:Math.max(0,Number(ov.video_start_offset)||0),trimEnd:Number(ov.video_end_offset)||null,loop:ov.media_loop!==false}));
    }
    root.ReelsPlaybackDelay={apply,active,minimumDuration,audioClips};
    if(typeof module!=='undefined')module.exports=root.ReelsPlaybackDelay;
})(typeof window!=='undefined'?window:globalThis);
