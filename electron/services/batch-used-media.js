'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const inside=(root,file)=>{const rel=path.relative(root,file);return rel==='' || (!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel));};
function localFolderTimestamp(date=new Date()){
    const pad=(value,width=2)=>String(value).padStart(width,'0');
    return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}-${pad(date.getMilliseconds(),3)}`;
}
function createService({rename=fs.rename}={}){
    const transactions=new Map();
    async function exists(file){try{await fs.lstat(file);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}
    async function atomicJson(file,value){
        const temporary=`${file}.${crypto.randomUUID()}.tmp`;
        try{
            const handle=await fs.open(temporary,'wx');
            try{await handle.writeFile(JSON.stringify(value,null,2),'utf8');await handle.sync();}finally{await handle.close();}
            await fs.rename(temporary,file);
        }finally{await fs.unlink(temporary).catch(()=>{});}
    }
    async function rollback(transaction,onProgress=()=>{}){
        // Include planned moves: a crash can occur after rename but before the result is logged.
        const moves=transaction.planned || transaction.moves;
        onProgress?.({stage:'rollback',completed:0,total:moves.length});
        const errors=[];transaction.state='rolling-back';await writeManifest(transaction);
        for(const move of [...moves].reverse())try{
            const source=await exists(move.source),target=await exists(move.target);
            if(source && !target)continue; // already restored, or this move never started
            if(source && target)throw new Error('原路径已被占用，保留两份文件');
            if(!target)throw new Error('原文件和归档文件均不存在');
            await fs.mkdir(path.dirname(move.source),{recursive:true});await rename(move.target,move.source);
            move.restored=true; // the durable plan plus actual paths makes partial retries safe
        }catch(error){errors.push(`${move.source}: ${error.message}`);}
        if(errors.length){transaction.state='rollback-failed';await writeManifest(transaction);throw new Error('归档回滚未完成，请保留清单：'+errors.join('；'));}
        transaction.state='rolled-back';await writeManifest(transaction);
        return {mappings:moves.map(move=>({source:move.target,target:move.source}))};
    }
    async function writeManifest(transaction){for(const directory of transaction.directories)await atomicJson(path.join(directory,'使用清单.json'),{...transaction,archiveDirectory:directory});}
    async function loadTransaction(data){
        if(transactions.has(data.id))return transactions.get(data.id);
        for(const directory of data.directories || []){
            if(!path.isAbsolute(directory))throw new Error('恢复目录必须是完整路径');
            const transaction=JSON.parse(await fs.readFile(path.join(directory,'使用清单.json'),'utf8'));
            if(transaction.id!==data.id)throw new Error('恢复清单与事务 ID 不一致');
            if(!Array.isArray(transaction.directories) || !transaction.directories.includes(directory))throw new Error('恢复清单目录无效');
            for(const move of transaction.planned || transaction.moves || []){
                if(!path.isAbsolute(move.source) || !path.isAbsolute(move.target) || !transaction.directories.some(root=>inside(root,move.target)))throw new Error('恢复清单路径无效');
            }
            transactions.set(transaction.id,transaction);return transaction;
        }
        throw new Error('归档事务不存在，请提供使用清单所在目录');
    }
    async function listBatches(roots){
        const batches=new Map(),warnings=[];
        const media=/\.(mp4|mov|avi|mkv|webm|m4v|png|jpe?g|webp|gif|bmp)$/i;
        async function members(directory){
            const result=[];
            for(const entry of await fs.readdir(directory,{withFileTypes:true})){
                if(entry.name.startsWith('.'))continue;
                const file=path.join(directory,entry.name);
                if(entry.isDirectory())result.push(...await members(file));
                else if(entry.isFile() && media.test(entry.name))result.push(file);
            }
            return result;
        }
        for(const input of roots || [])try{
            if(!path.isAbsolute(input.root || ''))continue;
            const root=await fs.realpath(input.root),archive=path.join(root,'本批已经使用');
            let directories;try{directories=await fs.readdir(archive,{withFileTypes:true});}catch(error){if(error.code==='ENOENT')continue;throw error;}
            for(const entry of directories.filter(entry=>entry.isDirectory()))try{
                const directory=path.join(archive,entry.name);let manifest;
                try{manifest=JSON.parse(await fs.readFile(path.join(directory,'使用清单.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
                if(manifest && manifest.state!=='moved'){if(manifest.state!=='rolled-back')warnings.push(`发现未完成的素材事务（${manifest.state}），请保留恢复清单：${directory}`);continue;}
                let units=[];
                if(manifest?.moves){
                    // A parent folder can be renamed. Resolve the recorded batch-relative
                    // paths against the directory being scanned, never by filename alone.
                    const recorded=manifest.archiveDirectory?[manifest.archiveDirectory]:[...new Set([...(manifest.directories || []),...manifest.moves.map(move=>{
                        const marker=path.sep+'本批已经使用'+path.sep+entry.name+path.sep,at=String(move.target).lastIndexOf(marker);
                        return at<0?'':move.target.slice(0,at+marker.length-1);
                    })].filter(Boolean))];
                    const choices=[];
                    for(const base of recorded){
                        const found=new Map();
                        for(const move of manifest.moves){
                            if(!inside(base,move.target))continue;
                            const candidate=path.resolve(directory,path.relative(base,move.target));if(!inside(directory,candidate))continue;
                            try{const target=await fs.realpath(candidate);if(inside(directory,target))found.set(target,{...move,target});}catch(error){if(error.code!=='ENOENT')throw error;}
                        }
                        if(found.size)choices.push({base,units:[...found.values()]});
                    }
                    const exact=choices.find(choice=>choice.base===directory);
                    choices.sort((a,b)=>b.units.length-a.units.length);
                    if(exact)units=exact.units;
                    else if(choices.length===1 || (choices.length>1 && choices[0].units.length>choices[1].units.length))units=choices[0].units;
                    else if(choices.length)throw new Error('旧清单对应多个来源，无法唯一确定此批次的原目录');
                }else units=(await fs.readdir(directory,{withFileTypes:true})).filter(child=>child.isDirectory() || media.test(child.name)).map(child=>({target:path.join(directory,child.name),source:''}));
                // Older manifests moved individual clips even when they belonged
                // to a suite. The batch preserves their relative directories;
                // reconstruct those units without moving files or rewriting the
                // original transaction (which is still needed for rollback).
                const grouped=new Map();
                for(const unit of units){
                    const stat=await fs.lstat(unit.target).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
                    if(!stat || stat.isSymbolicLink())continue;
                    const folder=path.dirname(unit.target);
                    if(stat.isFile() && media.test(unit.target) && folder!==directory && inside(directory,folder)){
                        if(!grouped.has(folder))grouped.set(folder,{target:folder,source:unit.source?path.dirname(unit.source):''});
                    }else grouped.set(unit.target,unit);
                }
                units=[...grouped.values()].filter(unit=>![...grouped.values()].some(other=>other!==unit && inside(other.target,unit.target)));
                const items=[];
                for(const unit of units){
                    let stat;try{stat=await fs.lstat(unit.target);}catch(error){if(error.code==='ENOENT')continue;throw error;}
                    if(stat.isSymbolicLink())continue;
                    const files=stat.isDirectory()?await members(unit.target):stat.isFile()&&media.test(unit.target)?[unit.target]:[];
                    if(!files.length)continue;
                    items.push({id:unit.target,path:unit.target,name:path.basename(unit.target),folder:stat.isDirectory(),files,
                        originalFiles:unit.source?files.map(file=>unit.source+file.slice(unit.target.length)):[],root,origin:['library','characters'].includes(input.origin)?input.origin:'temporary',archiveBatchId:entry.name});
                }
                if(!items.length)continue;
                const batch=batches.get(entry.name) || {id:entry.name,transactionId:manifest?.id || '',recoveryAvailable:!!manifest?.projectRecoveryFile || manifest?.recoveryFile==='恢复工程.json',at:manifest?.at || (await fs.stat(directory)).mtime.toISOString(),directories:[],items:[]};
                if(!batch.directories.includes(directory)){batch.directories.push(directory);batch.items.push(...items);}
                batches.set(entry.name,batch);
            }catch(error){warnings.push(`${entry.name}：${error.message}`);}
        }catch(error){warnings.push(`${input.root}：${error.message}`);}
        return {batches:[...batches.values()].sort((a,b)=>b.at.localeCompare(a.at)),warnings};
    }
    async function repairLayout(inputs,protectedPaths=[],recovery=null,onProgress=()=>{}){
        const roots=[];for(const input of inputs || []){const value=typeof input==='string'?input:input.root;if(path.isAbsolute(value || ''))roots.push(await fs.realpath(value));}
        const bases=[...new Set(roots)].filter(root=>!roots.some(other=>other!==root && inside(other,root)));
        const protectedFiles=await Promise.all(protectedPaths.map(file=>fs.realpath(file).catch(()=>path.resolve(file)))),moves=new Map(),manifests=new Map();
        async function scan(directory,root,depth=0){
            if(depth>24)return;
            for(const entry of await fs.readdir(directory,{withFileTypes:true})){
                if(!entry.isDirectory() || entry.name.startsWith('.'))continue;
                const child=path.join(directory,entry.name);
                if(entry.name!=='本批已经使用'){await scan(child,root,depth+1);continue;}
                if(directory===root)continue;
                for(const batch of await fs.readdir(child,{withFileTypes:true})){
                    if(!batch.isDirectory())continue;
                    const batchDir=path.join(child,batch.name),manifestPath=path.join(batchDir,'使用清单.json');let manifest;
                    try{manifest=JSON.parse(await fs.readFile(manifestPath,'utf8'));}catch(error){if(error.code==='ENOENT')continue;throw error;}
                    if(manifest.state!=='moved')continue;
                    manifests.set(manifestPath,manifest);
                    for(const move of manifest.moves || []){
                        let source;try{source=await fs.realpath(move.target);}catch(error){if(error.code==='ENOENT')continue;throw error;}
                        const original=path.join(await fs.realpath(path.dirname(move.source)),path.basename(move.source));
                        if(!inside(batchDir,source) || !inside(root,original) || original.split(path.sep).includes('本批已经使用'))continue;
                        if(protectedFiles.some(file=>inside(source,file)))continue;
                        try{const stat=await fs.lstat(source);if(stat.isSymbolicLink())continue;}catch(error){if(error.code==='ENOENT')continue;throw error;}
                        const destination=path.join(root,'本批已经使用',batch.name,path.relative(root,original));
                        moves.set(source,{source,referenceSource:move.target,originalSource:move.source,target:destination,directory:path.join(root,'本批已经使用',batch.name)});
                    }
                }
            }
        }
        for(const root of bases)await scan(root,root);
        const planned=[...moves.values()];if(!planned.length)return {mappings:[],directories:[],repaired:0};
        for(const move of planned)try{await fs.lstat(move.target);throw new Error('归档目标已存在，未覆盖：'+move.target);}catch(error){if(error.code!=='ENOENT')throw error;}
        // Include the other original manifest copies within the explicitly supplied roots.
        for(const manifest of [...manifests.values()])for(const directory of manifest.directories || [])if(bases.some(root=>inside(root,directory))){
            const file=path.join(directory,'使用清单.json');if(manifests.has(file))continue;
            try{manifests.set(file,JSON.parse(await fs.readFile(file,'utf8')));}catch(error){if(error.code!=='ENOENT')throw error;}
        }
        const backups=new Map(),written=[],done=[];
        try{
            for(const directory of new Set(planned.map(move=>move.directory))){await fs.mkdir(directory,{recursive:true});if(recovery)await fs.writeFile(path.join(directory,'归档位置修复前工程.json'),JSON.stringify(recovery),'utf8');}
            for(const move of planned){onProgress({stage:'move',completed:done.length,total:planned.length,item:move.source});await fs.mkdir(path.dirname(move.target),{recursive:true});await rename(move.source,move.target);done.push(move);}
            const mapping=new Map(planned.flatMap(move=>[[move.source,move.target],[path.resolve(move.referenceSource),move.target]]));
            const updated=new Map();
            for(const [file,manifest] of manifests){
                const relocated=(manifest.moves || []).map(move=>{const target=mapping.get(path.resolve(move.target));if(!target)return move;const batchDir=planned.find(entry=>entry.source===path.resolve(move.target) || path.resolve(entry.referenceSource)===path.resolve(move.target)).directory;return path.dirname(target)!==batchDir && /\.(mp4|mov|avi|mkv|webm|m4v|png|jpe?g|webp|gif|bmp)$/i.test(target)?{source:path.dirname(move.source),target:path.dirname(target)}:{...move,target};});
                const value={...manifest,moves:[...new Map(relocated.map(move=>[move.target,move])).values()],layoutRepairedAt:new Date().toISOString()};
                const newDirs=[...new Set(value.moves.map(move=>{const at=move.target.indexOf(path.sep+'本批已经使用'+path.sep);return at<0?'':move.target.slice(0,at+('/本批已经使用/').length)+move.target.slice(at+('/本批已经使用/').length).split(path.sep)[0];}).filter(Boolean))];
                value.directories=[...new Set([...(manifest.directories || []),...newDirs])];
                updated.set(file,value);
                for(const directory of newDirs)if(planned.some(move=>move.directory===directory))updated.set(path.join(directory,'使用清单.json'),value);
            }
            for(const [file,value] of updated){try{backups.set(file,await fs.readFile(file,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;backups.set(file,null);}written.push(file);await fs.writeFile(file,JSON.stringify(value,null,2),'utf8');}
            const pathMappings=planned.map(({source,referenceSource,target})=>({source:referenceSource || source,target}));
            // Earlier file-only moves left the suite binding at the old directory.
            // Remap that binding only when no ordinary media remain there.
            const media=/\.(mp4|mov|avi|mkv|webm|m4v|png|jpe?g|webp|gif|bmp)$/i;
            async function hasMedia(directory){for(const entry of await fs.readdir(directory,{withFileTypes:true})){if(entry.name==='本批已经使用' || entry.name.startsWith('.'))continue;const child=path.join(directory,entry.name);if(entry.isFile() && media.test(entry.name))return true;if(entry.isDirectory() && await hasMedia(child))return true;}return false;}
            const folders=new Map();for(const move of planned)if(media.test(move.originalSource)){const folder=path.dirname(move.originalSource),destination=path.dirname(move.target);if(!folders.has(folder))folders.set(folder,new Set());folders.get(folder).add(destination);}
            for(const [source,targets] of folders)if(targets.size===1 && !protectedFiles.some(file=>inside(source,file)) && !await hasMedia(source))pathMappings.push({source,target:[...targets][0]});
            for(const transaction of transactions.values())for(const move of transaction.moves || []){const relocated=pathMappings.find(entry=>move.target===entry.source);if(relocated)move.target=relocated.target;}
            onProgress({stage:'move',completed:done.length,total:planned.length});
            return {mappings:pathMappings,directories:[...new Set(planned.map(move=>move.directory))],repaired:planned.length};
        }catch(error){
            const failures=[];
            for(const move of done.reverse())try{await fs.mkdir(path.dirname(move.source),{recursive:true});await rename(move.target,move.source);}catch(failure){failures.push(failure.message);}
            for(const file of written)try{const old=backups.get(file);if(old===null)await fs.unlink(file);else await fs.writeFile(file,old,'utf8');}catch(failure){failures.push(failure.message);}
            if(failures.length)throw new Error(error.message+'；恢复未完成：'+failures.join('；'));throw error;
        }
    }
    async function handle(data,onProgress=()=>{}){
        if(data.action==='list')return listBatches(data.roots);
        if(data.action==='repair-layout')return repairLayout(data.roots,data.protectedPaths,data.recovery,onProgress);
        const report=event=>{try{onProgress?.(event);}catch(_){}};
        report({stage:"prepare",message:"正在检查素材路径…"});
        if(data.action==='recover-project'){
            const transaction=await loadTransaction(data);
            const directory=transaction.directories[0];
            let project;
            if(transaction.projectRecoveryFile==='替换记录.json'){
                project=JSON.parse(await fs.readFile(path.join(directory,'恢复基线.json'),'utf8'));
                const record=JSON.parse(await fs.readFile(path.join(directory,'替换记录.json'),'utf8'));
                if(!Array.isArray(project.tabs))throw new Error('工程恢复基线格式无效');
                let found=false;
                for(const tab of project.tabs)for(let index=0;index<(tab.tasks || []).length;index++){
                    if(tab.tasks[index].id===record.taskId){tab.tasks[index]=record.afterTask;found=true;}
                }
                if(!found){
                    const tab=project.tabs.find(tab=>tab.id===(record.tabId || project.activeTabId));
                    if(!tab)throw new Error('恢复基线中找不到任务所属标签，请保留替换记录');
                    (tab.tasks ||= []).push(record.afterTask);
                    if(project.taskView?.taskIds && !project.taskView.taskIds.includes(record.taskId))project.taskView.taskIds.push(record.taskId);
                }
            }else project=JSON.parse(await fs.readFile(path.join(directory,'恢复工程.json'),'utf8'));
            const allMoves=transaction.planned || transaction.moves;
            require('../../src/reels-media-relocation').remap(project,allMoves.map(move=>({source:move.target,target:move.source})));
            const mappings=[];
            for(const move of allMoves){
                const source=await exists(move.source),target=await exists(move.target);
                if(source && target)throw new Error('源文件与归档文件同时存在，请先处理路径冲突');
                if(!source && !target)throw new Error('恢复所需素材不存在：'+move.source);
                if(target)mappings.push({source:move.source,target:move.target});
            }
            require('../../src/reels-media-relocation').remap(project,mappings);
            const filePath=path.join(directory,'恢复工程.json');
            await atomicJson(filePath,project);
            return {project,mappings,filePath};
        }
        if(data.action==='rollback'){
            const transaction=await loadTransaction(data);
            const result=await rollback(transaction,report);transactions.delete(data.id);return result;
        }
        if(data.action!=='move')throw new Error('不支持的已用素材操作');
        const id=crypto.randomUUID(),stamp=localFolderTimestamp()+'_'+id.slice(0,8),units=[];
        for(const unit of data.units || []){
            if(!path.isAbsolute(unit.path || '') || !path.isAbsolute(unit.root || ''))throw new Error('已用素材需要完整路径');
            const source=path.resolve(unit.path),root=path.resolve(unit.root),realSource=await fs.realpath(source),realRoot=await fs.realpath(root);
            if(!inside(realRoot,realSource))throw new Error('素材不在对应库目录中');
            if(source.split(path.sep).includes('本批已经使用'))continue;
            if(units.some(entry=>inside(entry.source,source)))continue;
            for(let index=units.length-1;index>=0;index--)if(inside(source,units[index].source))units.splice(index,1);
            if(realSource===realRoot)throw new Error('不能移动整个素材库根目录，请按库内文件归档');
            const directory=path.join(root,'本批已经使用',stamp),relative=path.relative(realRoot,realSource);
            units.push({source,target:path.join(directory,relative),directory});
        }
        report({stage:'prepare',message:'正在写入恢复清单…'});
        const transaction={id,state:'preparing',at:new Date().toISOString(),moves:[],directories:[...new Set(units.map(unit=>unit.directory))],planned:units,recovery:data.recovery || null};
        for(const directory of transaction.directories)await fs.mkdir(directory,{recursive:true});
        if(transaction.recovery){
            // 单次替换只传本次改动记录（替换记录.json），避免每次复制整个工程快照。
            const recoveryFile=['恢复工程.json','替换记录.json'].includes(data.recoveryName)?data.recoveryName:'恢复工程.json';
            for(const directory of transaction.directories)await atomicJson(path.join(directory,recoveryFile),transaction.recovery);
            if(transaction.recovery.basePath && transaction.recovery.afterTask){
                // Copy an already-persisted checkpoint without parsing/serializing a full
                // project for every drag. Expand the task patch only when recovery is requested.
                let baseline='';
                for(const directory of transaction.directories){
                    const target=path.join(directory,'恢复基线.json'),temporary=target+'.tmp';
                    try{
                        await fs.copyFile(baseline || transaction.recovery.basePath,temporary);
                        const handle=await fs.open(temporary,'r+');try{await handle.sync();}finally{await handle.close();}
                        await fs.rename(temporary,target);baseline=target;
                    }finally{await fs.unlink(temporary).catch(()=>{});}
                }
                transaction.projectRecoveryFile='替换记录.json';
            }
            delete transaction.recovery;transaction.recoveryFile=recoveryFile;
        }
        await writeManifest(transaction);transactions.set(id,transaction);
        try{
            for(const unit of units){
                report({stage:"move",completed:transaction.moves.length,total:units.length,item:unit.source});
                await fs.mkdir(path.dirname(unit.target),{recursive:true});
                try{await fs.lstat(unit.target);throw new Error('目标路径已存在，未覆盖文件');}catch(error){if(error.code!=='ENOENT')throw error;}
                await rename(unit.source,unit.target);transaction.moves.push({source:unit.source,target:unit.target});
                // Persist the full plan once and the final result once. Recovery reconciles
                // actual paths, so rewriting a growing manifest after every file is unnecessary.
            }
            transaction.state='moved';await writeManifest(transaction);
            report({stage:'move',completed:units.length,total:units.length,message:'素材移动完成，正在同步任务引用…'});
            return {id,mappings:transaction.moves,directories:transaction.directories};
        }catch(error){await rollback(transaction,report);throw error;}
    }
    return {handle};
}
module.exports={createService,localFolderTimestamp};
