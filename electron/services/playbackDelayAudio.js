const fs=require('fs'),path=require('path'),media=require('./ffmpeg');
// Extra enabled media audio is mixed after the existing voice/background mix.
// No extra pass runs for the default muted overlays.
async function mixOverlayAudio(output, clips) {
    const duration=await media.getDuration(output);
    const usable=[];
    for(const clip of clips) {
        if(!clip.path || !fs.existsSync(clip.path))throw new Error(`覆层声音素材不存在：${clip.path || ''}`);
        if ((Number(clip.start)||0)<duration && (Number(clip.end)||duration)>(Number(clip.start)||0) && await media.hasAudioTrack(clip.path))usable.push(clip);
    }
    if(!usable.length)return;
    const temporary=path.join(path.dirname(output),`.overlay-audio-${process.pid}-${Date.now()}.mp4`);
    const audioFile=temporary+'.wav';
    const args=['-y','-i',output];
    const filters=[],labels=[];
    if(await media.hasAudioTrack(output)) {filters.push(`[0:a]apad,atrim=duration=${duration}[base]`);labels.push('[base]');}
    for(let i=0;i<usable.length;i++) {
        const clip=usable[i],start=Math.max(0,Number(clip.start)||0),length=Math.min(duration,Number(clip.end)||duration)-start;
        const begin=Math.max(0,Number(clip.trimStart)||0);
        if(clip.loop)args.push('-stream_loop','-1');
        args.push('-ss',String(begin),'-i',clip.path);
        const end=Number(clip.trimEnd);
        // Explicit source ranges loop within the requested region rather than leaking beyond it.
        let trim=end>begin?`atrim=duration=${end-begin},asetpts=PTS-STARTPTS,aresample=48000${clip.loop?`,aloop=loop=-1:size=${Math.round((end-begin)*48000)}`:''},`:'';
        filters.push(`[${i+1}:a]${trim}atrim=duration=${Math.max(0.001,length)},asetpts=PTS-STARTPTS,adelay=${Math.round(start*1000)}:all=1,apad,atrim=duration=${duration}[ov${i}]`);
        labels.push(`[ov${i}]`);
    }
    filters.push(`${labels.join('')}amix=inputs=${labels.length}:duration=longest:dropout_transition=0:normalize=0[mixed]`);
    args.push('-filter_complex',filters.join(';'),'-map','[mixed]','-c:a','pcm_s16le','-t',String(duration),audioFile);
    try {
        await media.runCommand('ffmpeg',args);
        await media.runCommand('ffmpeg',['-y','-i',output,'-i',audioFile,'-map','0:v','-map','1:a','-c:v','copy','-c:a','aac','-b:a','192k','-t',String(duration),'-movflags','+faststart',temporary]);
        fs.renameSync(temporary,output);
    } finally {
        for (const file of [temporary,audioFile]) {try{fs.unlinkSync(file);}catch(_){}}
    }
}
module.exports={mixOverlayAudio};
