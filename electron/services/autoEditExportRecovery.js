const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
function fingerprint(file) {
    const stat = fs.statSync(file);
    return {path:path.resolve(file),size:stat.size,mtime:stat.mtimeMs,ctime:stat.ctimeMs};
}
function recordName(signature) { return crypto.createHash('sha256').update(signature).digest('hex') + '.json'; }
function atomicWrite(file, data) {
    fs.mkdirSync(path.dirname(file),{recursive:true});
    const temporary = file + '.' + crypto.randomUUID() + '.tmp';
    fs.writeFileSync(temporary,JSON.stringify(data,null,2),'utf8');
    fs.renameSync(temporary,file);
}
function outputFiles(result) {
    return [...new Set(['output_path','srt_path','mp3_path','subtitled_path','voice_changed_mp3_path','voice_changed_video_path','manual_audio_video_path'].map(key=>result[key]).filter(Boolean))];
}
function readCompletedExport(outputDir, signature) {
    if (!signature) return null;
    try {
        const record=JSON.parse(fs.readFileSync(path.join(outputDir,'导出完成记录',recordName(signature)),'utf8'));
        if (record.signature !== signature || !record.result?.output_path || !record.sources?.length) return null;
        if (record.sources.some(saved=>JSON.stringify(fingerprint(saved.path)) !== JSON.stringify(saved))) return null;
        if (!record.outputs?.length || record.outputs.some(saved=>JSON.stringify(fingerprint(saved.path)) !== JSON.stringify(saved) || saved.size===0)) return null;
        return {...record.result,reused_export:true};
    } catch (_) { return null; }
}
function saveCompletedExport(outputDir, signature, clips, result) {
    if (!signature) return;
    const dir=path.join(outputDir,'导出完成记录'), name=recordName(signature);
    atomicWrite(path.join(dir,name),{signature,completed_at:new Date().toISOString(),sources:[...new Set(clips)].map(fingerprint),outputs:outputFiles(result).map(fingerprint),result});
    const index=path.join(dir,'index.json');
    let records=[];try {records=JSON.parse(fs.readFileSync(index,'utf8')).records || [];} catch (_) {}
    atomicWrite(index,{records:[name,...records.filter(value=>value!==name)]});
}
module.exports={readCompletedExport,saveCompletedExport};
