'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {Readable}=require('node:stream'),{pipeline}=require('node:stream/promises');
const assets=require('../../src/reels-project-assets');
function presetProject(project,selection='both',subtitlePresets={}){
    const tasks=Array.isArray(project.tasks)?project.tasks:[];
    const index=Number(project.selectedIdx ?? project.curr_idx ?? 0);
    const source=tasks[Number.isInteger(index) && tasks[index]?index:0] || {};
    const task={};
    if(selection!=='subtitle'){
        task.overlays=source.overlays || [];
        task.visualOverlayOrder=source.visualOverlayOrder || [];
    }
    const opts=project.exportOpts || {};
    const all=opts.subtitleStyleScopeVersion===2?(opts.subtitleStyleScope || (opts.subtitleStyleApplyAll?'all':'folder'))==='all':opts.subtitleStyleApplyAll===true;
    const taskStyle=[source.subtitleStyle,source.subtitle_style,source.style].find(s=>s && typeof s==='object' && Object.keys(s).length);
    const namedStyle=source._subtitlePreset && subtitlePresets[source._subtitlePreset];
    const style=selection==='overlay'?null:namedStyle || (all?project.style:taskStyle) || project.style || null;
    // Decode only the chosen layers, so images in other tasks aren't expanded.
    const slim={tasks:[task],selectedIdx:0,...(style?{style}:{}),presetSelection:selection};
    if(project.embeddedImageFormat){slim.embeddedImageFormat=project.embeddedImageFormat;slim.embeddedImages=project.embeddedImages;}
    return assets.encode(assets.decode(slim));
}
async function exportPresets({entries,outputPath,onProgress=()=>{},signal,presetSelection='both',subtitlePresets={}}){
    if(!['both','overlay','subtitle'].includes(presetSelection))throw Error('预设类型无效');
    const temporary=outputPath+'.'+crypto.randomUUID()+'.partial';
    let count=0,skippedCount=0;
    async function* generate(){
        yield '{"_format":"videokit-template-collection","_version":1,"mode":"preset","templates":[';
        for(const [i,item] of entries.entries()){
            signal?.throwIfAborted();
            const source=JSON.parse(await fs.promises.readFile(item.file,'utf8'));
            const projectData=presetProject(source.projectData,presetSelection,subtitlePresets);
            const style=projectData.style;
            if(!projectData.tasks?.[0]?.overlays?.length && !(style && Object.keys(style).length)){skippedCount++;continue;}
            if(count++)yield ',';
            yield JSON.stringify({name:source.name,category:source.category || '',kind:'preset',assetCollection:{status:'not-collected'},projectData});
            onProgress({completed:i+1,total:entries.length,message:`已导出样式预设 ${i+1} / ${entries.length}`});
        }
        if(!count)throw Error('所选工程没有可导出的所选类型样式');
        yield ']}';
    }
    try{
        await pipeline(Readable.from(generate()),fs.createWriteStream(temporary,{flags:'wx'}),{signal});
        signal?.throwIfAborted();await fs.promises.rename(temporary,outputPath);
        return {filePath:outputPath,count,skippedCount,mode:'preset'};
    }catch(error){await fs.promises.rm(temporary,{force:true});throw error;}
}
async function exportPackages({directory,entries,outputPath,onProgress=()=>{},signal}){
    const temporary=outputPath+'.'+crypto.randomUUID()+'.partial';
    const stage=await fs.promises.mkdtemp(path.join(directory,'.export-packages-'));
    const manifest={_format:'videokit-package-collection',_version:1,mode:'package',entries:[]};
    let archive,output;
    try{
        for(const [i,item] of entries.entries()){
            signal?.throwIfAborted();
            const source=JSON.parse(await fs.promises.readFile(item.file,'utf8'));
            const file=`${i}.vkpkg`;
            const result=await require('./template-project-package').create({
                projectData:source.projectData,name:source.name,thumbnail:source.thumbnail,
                directory:stage,metadata:source,outputPath:path.join(stage,file),signal,
                onProgress:event=>onProgress({...event,message:`工程 ${i+1} / ${entries.length}：${event.message}`})
            });
            manifest.entries.push({file,name:source.name,assetCollection:result.assetCollection});
            await fs.promises.rm(result.assetRoot,{recursive:true,force:true});
        }
        signal?.throwIfAborted();
        archive=require('archiver')('zip',{store:true});output=fs.createWriteStream(temporary,{flags:'wx'});
        const done=new Promise((resolve,reject)=>{output.on('close',resolve);output.on('error',reject);archive.on('error',reject);archive.on('warning',reject);});
        const abort=()=>{archive.abort();output.destroy(Object.assign(new Error('已取消导出'),{name:'AbortError'}));};
        signal?.addEventListener('abort',abort,{once:true});
        try{
            archive.pipe(output);archive.append(JSON.stringify(manifest),{name:'manifest.json'});
            for(const entry of manifest.entries)archive.file(path.join(stage,entry.file),{name:entry.file});
            onProgress({message:'正在写入完整工程合集…'});
            await Promise.all([archive.finalize(),done]);signal?.throwIfAborted();
            await fs.promises.rename(temporary,outputPath);
        }finally{signal?.removeEventListener('abort',abort);}
        const missing=manifest.entries.reduce((n,e)=>n+(e.assetCollection.missing?.length || 0),0);
        return {filePath:outputPath,count:entries.length,mode:'package',assetCollection:{status:missing?'partial':'complete',missingCount:missing}};
    }catch(error){archive?.abort();output?.destroy();await fs.promises.rm(temporary,{force:true});throw error;}
    finally{await fs.promises.rm(stage,{recursive:true,force:true});}
}
module.exports={presetProject,exportPresets,exportPackages};
