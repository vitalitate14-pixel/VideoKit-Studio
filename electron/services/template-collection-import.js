'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const JsonReader=require('./template-json-reader');
const fields=new Set(['name','description','thumbnail','tags','category','kind','assetCollection','createdAt','updatedAt']);
// Stage and validate the entire input before exposing any imported records.
async function importCollection({filePath,directory,onProgress=()=>{},commit}){
    const stage=await fs.promises.mkdtemp(path.join(directory,'.import-'));
    const records=[],root={},boundaries=[];let current=null,position=0,lastReport=0;
    function record(index){return records[index] ||= {id:'tpl_'+crypto.randomUUID(),meta:{},hasProject:false};}
    const reader=new JsonReader((full,type,value)=>{
        const inArray=full[0]==='templates' && typeof full[1]==='number';
        const p=inArray?full.slice(2):full;
        const target=inArray?record(full[1]):root;
        if(p.length===3 && p[0]==='projectData' && p[1]==='tasks' && typeof p[2]==='number')target.taskCount=(target.taskCount || 0)+1;
        if(p.length===1 && p[0]==='projectData' && type==='object')target.hasProject=true;
        if(!p.length || !fields.has(p[0])){if(full.length===1 && full[0]==='_format' && type==='primitive')root.format=value;return;}
        target.meta ||= {};
        let obj=target.meta;
        if(p.some(key=>['__proto__','constructor','prototype'].includes(String(key))))throw Error('工程元数据字段无效');
        for(let i=0;i<p.length-1;i++)obj=obj[p[i]] ||= {};
        obj[p.at(-1)]=type==='object'?{}:type==='array'?[]:value;
    },(event,p,offset,type)=>{
        if(p.length===2 && p[0]==='templates'){
            if(event==='begin' && type!=='object')throw Error('合集条目必须是工程对象');
            if(event==='begin' || event==='end')boundaries.push({event,offset,index:p[1]});
        }
    });
    try{
        const stat=await fs.promises.stat(filePath);
        for await(const chunk of fs.createReadStream(filePath,{highWaterMark:256*1024})){
            reader.write(chunk);let cursor=0;
            for(const boundary of boundaries.splice(0)){
                const end=boundary.offset-position;
                if(current)await current.handle.writeFile(chunk.subarray(cursor,end));
                if(boundary.event==='begin'){
                    const item=record(boundary.index);item.file=path.join(stage,item.id+'.json');
                    current={item,handle:await fs.promises.open(item.file,'wx')};
                }else{if(!current)throw Error('合集结构无效');await current.handle.close();current=null;}
                cursor=end;
            }
            if(current)await current.handle.writeFile(chunk.subarray(cursor));
            position+=chunk.length;
            if(Date.now()-lastReport>200){lastReport=Date.now();onProgress({completedBytes:position,totalBytes:stat.size,message:`正在读取并校验工程合集：${Math.min(100,Math.floor(position/stat.size*100))}%`});}
        }
        reader.end();
        if(root.format==='videokit-template-collection'){
            if(!records.length)throw Error('工程合集为空');
        }else{
            if(records.length || !root.hasProject)throw Error('不是有效的工程文件');
            const item=record(0);item.meta=root.meta || {};item.taskCount=root.taskCount || 0;item.hasProject=true;item.file=path.join(stage,item.id+'.json');
            await fs.promises.copyFile(filePath,item.file);
        }
        if(records.some(item=>!item.hasProject || !item.file || !item.meta.name))throw Error('工程缺少名称或工程数据');
        for(const item of records)item.meta.taskCount=item.taskCount || 0;
        await commit(records);
        return {count:records.length};
    }finally{if(current)await current.handle.close().catch(()=>{});await fs.promises.rm(stage,{recursive:true,force:true});}
}
module.exports={importCollection};
