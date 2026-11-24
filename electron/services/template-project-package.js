'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {pipeline}=require('node:stream/promises');
const {fileURLToPath} = require('node:url');
const assets = require('../../src/reels-project-assets');

// Keep media folders together so folder rotation remains editable after import.
async function create({projectData,name,thumbnail='',directory,outputPath,onProgress=()=>{},signal,metadata={}}) {
    const token=crypto.randomUUID(),root=path.join(directory,'assets','package_'+token);
    const partial=outputPath+'.'+token+'.partial',files=new Map(),missing=new Set();
    const media=/\.(png|jpe?g|webp|gif|bmp|svg|mp4|mov|m4v|mkv|webm|avi|mp3|wav|m4a|aac|ogg|flac|srt|vtt|ttf|otf)$/i;
    const skipped=new Set(['combinationPreviewDrafts','combinationCandidatePool','combinationArchiveBatches','_mediaUsageRecords','backgroundLibrary','outputDir','projectDir','materialDir']);
    const local=value=>{try{return /^(file|local-media):/.test(value)?fileURLToPath(value.replace(/^local-media:/,'file:')):value;}catch{return value;}};
    function scan(value) {
        if(typeof value==='string'){
            const p=local(value);
            if(path.isAbsolute(p) && media.test(p) && !files.has(p)){
                if(fs.existsSync(p) && fs.statSync(p).isFile())files.set(p,path.join('Assets',crypto.createHash('sha256').update(path.dirname(p)).digest('hex').slice(0,20),path.basename(p)).split(path.sep).join('/'));
                else missing.add(p);
            }
        }else if(Array.isArray(value))value.forEach(scan);
        else if(value && typeof value==='object')for(const [key,item] of Object.entries(value))if(!skipped.has(key))scan(item);
    }
    signal?.throwIfAborted();
    scan(projectData);
    let copied=0,bytes=0;
    try {
        await fs.promises.mkdir(path.join(root,'Assets'),{recursive:true});
        for(const [source,relative] of files){
            signal?.throwIfAborted();
            const target=path.join(root,relative);await fs.promises.mkdir(path.dirname(target),{recursive:true});
            await pipeline(fs.createReadStream(source),fs.createWriteStream(target),{signal});bytes+=(await fs.promises.stat(target)).size;
            onProgress({stage:'collect',completed:++copied,total:files.size,message:`收集素材 ${copied} / ${files.size}`});
        }
        const folders=new Map([...files].map(([source,relative])=>[path.dirname(source),path.posix.dirname(relative)]));
        function rewrite(value,portable){
            if(typeof value==='string'){
                const p=local(value),relative=files.get(p)||folders.get(p);
                return relative?(portable?relative:path.join(root,relative)):value;
            }
            if(Array.isArray(value))return value.map(v=>rewrite(v,portable));
            if(value && typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,skipped.has(key)?item:rewrite(item,portable)]));
            return value;
        }
        signal?.throwIfAborted();
        const collection={status:missing.size?'partial':'complete',fileCount:copied,totalBytes:bytes,missing:[...missing]};
        const archive=require('archiver')('zip',{zlib:{level:6}});
        const output=fs.createWriteStream(partial,{flags:'wx'});
        const complete=new Promise((resolve,reject)=>{output.on('close',resolve);output.on('error',reject);archive.on('error',reject);archive.on('warning',reject);});
        const abort=()=>{archive.abort();output.destroy(Object.assign(new Error('已取消导出'),{name:'AbortError'}));};
        signal?.addEventListener('abort',abort,{once:true});
        archive.pipe(output);
        archive.append(JSON.stringify({_format:'videokit-template-archive',_version:1,name,thumbnail,description:metadata.description || '',tags:metadata.tags || [],category:metadata.category || '',kind:'package',assetCollection:collection,projectData:assets.encode(rewrite(projectData,true))}),{name:'template.json'});
        archive.directory(path.join(root,'Assets'),'Assets');
        onProgress({stage:'archive',message:'正在压缩完整工程…'});
        try{await Promise.all([archive.finalize(),complete]);signal?.throwIfAborted();}
        finally{signal?.removeEventListener('abort',abort);}
        await fs.promises.rename(partial,outputPath);
        return {projectData:rewrite(projectData,false),kind:'package',assetCollection:collection,zip_path:outputPath,assetRoot:root};
    }catch(error){
        await fs.promises.rm(partial,{force:true}).catch(()=>{});
        await fs.promises.rm(root,{force:true,recursive:true}).catch(()=>{});throw error;
    }
}
module.exports={create};
