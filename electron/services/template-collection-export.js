'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {Readable}=require('node:stream');
const {pipeline}=require('node:stream/promises');

// Transfer saved JSON bytes, keeping encoded images intact and avoiding a
// decoded collection or giant JSON string in either process.
async function prepareCollection({directory,ids,all=false}){
    const index=JSON.parse(await fs.promises.readFile(path.join(directory,'index.json'),'utf8'));
    if(all)ids=index.map(entry=>entry.id);
    if(!Array.isArray(ids) || !ids.length)throw new Error('没有可导出的工程');
    const selected=[...new Set(ids.map(String))];
    if(selected.some(id=>!/^[-\w]+$/.test(id)))throw new Error('工程 ID 无效');
    const byId=new Map(index.map(entry=>[String(entry.id),entry]));
    const entries=[];let totalBytes=0;
    for(const id of selected){
        const entry=byId.get(id);if(!entry)throw new Error(`勾选的工程已不存在：${id}`);
        const file=path.join(directory,id+'.json'),stat=await fs.promises.stat(file);
        if(!stat.isFile())throw new Error('工程文件不可读取：'+entry.name);
        entries.push({entry,file,size:stat.size});totalBytes+=stat.size;
    }
    return {entries,totalBytes};
}
async function estimateCollection(data){const {entries,totalBytes}=await prepareCollection(data);return {ids:entries.map(item=>item.entry.id),count:entries.length,totalBytes};}
async function exportCollection({directory,ids,all=false,outputPath,onProgress=()=>{},signal,mode='project',presetSelection='both',subtitlePresets={}}){
    if(!outputPath)throw new Error('请选择导出位置');
    const relative=path.relative(path.resolve(directory),path.resolve(outputPath));
    if(relative==='' || (!relative.startsWith('..'+path.sep) && relative!=='..' && !path.isAbsolute(relative)))throw new Error('请将导出文件保存到模板库目录以外');
    const {entries,totalBytes}=await prepareCollection({directory,ids,all});
    signal?.throwIfAborted();
    if(mode==='preset')return require('./template-export-modes').exportPresets({entries,outputPath,onProgress,signal,presetSelection,subtitlePresets});
    if(mode==='package')return require('./template-export-modes').exportPackages({directory,entries,outputPath,onProgress,signal});
    if(mode!=='project')throw Error('导出模式无效');
    const temporary=outputPath+'.'+crypto.randomUUID()+'.partial';
    let completedBytes=0,lastReport=0;
    async function* generate(){
        yield '{"_format":"videokit-template-collection","_version":1,"exportedAt":'+Date.now()+',"count":'+entries.length+',"templates":[';
        for(const [index,item] of entries.entries()){
            signal?.throwIfAborted();
            if(index)yield ',';
            let bytes=0;
            for await(const chunk of fs.createReadStream(item.file,{highWaterMark:256*1024,signal})){
                bytes+=chunk.length;completedBytes+=chunk.length;yield chunk;
                if(Date.now()-lastReport>200){lastReport=Date.now();onProgress({completed:index,total:entries.length,completedBytes,totalBytes,message:`正在导出 ${index+1} / ${entries.length}：${item.entry.name}`});}
            }
            if(bytes!==item.size)throw new Error('导出期间工程发生变化，请重新导出：'+item.entry.name);
            onProgress({completed:index+1,total:entries.length,completedBytes,totalBytes,message:`已导出 ${index+1} / ${entries.length} 个工程`});
        }
        yield ']}';
    }
    try{
        await pipeline(Readable.from(generate()),fs.createWriteStream(temporary,{flags:'wx'}),{signal});
        signal?.throwIfAborted();
        await fs.promises.rename(temporary,outputPath);
        return {filePath:outputPath,count:entries.length,bytes:(await fs.promises.stat(outputPath)).size};
    }catch(error){await fs.promises.rm(temporary,{force:true}).catch(()=>{});throw error;}
}
const jobs=new Map();
async function startExport(data){
    const id=data.request_id;
    if(!id || jobs.has(id))throw Error('导出任务 ID 无效或重复');
    const controller=new AbortController();jobs.set(id,controller);
    try{return await exportCollection({...data,signal:controller.signal});}
    catch(error){if(controller.signal.aborted)return {cancelled:true};throw error;}
    finally{jobs.delete(id);}
}
function cancelExport(id){const controller=jobs.get(id);controller?.abort();return {cancelled:!!controller};}
module.exports={exportCollection,estimateCollection,startExport,cancelExport};
