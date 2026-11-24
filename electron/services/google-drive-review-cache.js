/** Persistent review downloads; complete files are reused by Drive file ID. */
const fs=require('fs'),path=require('path'),crypto=require('crypto'),{Transform,Readable}=require('stream');
const {pipeline}=require('stream/promises');
const hash=value=>crypto.createHash('sha256').update(String(value)).digest('hex');
const MEDIA_EXT=/\.(mp4|mov|mkv|avi|webm|m4v|jpe?g|png|webp|gif|bmp|avif|svg)$/i;
const MIME_TO_EXT={'video/mp4':'.mp4','video/quicktime':'.mov','video/x-matroska':'.mkv','video/x-msvideo':'.avi','video/webm':'.webm','image/jpeg':'.jpg','image/png':'.png','image/webp':'.webp','image/gif':'.gif','image/bmp':'.bmp','image/avif':'.avif','image/svg+xml':'.svg'};
function extFromContentType(value){return MIME_TO_EXT[String(value||'').split(';')[0].trim().toLowerCase()]||'';}
function createCache({baseDirectory,drive,resolveStream}){
    const openStream=resolveStream||(entry=>drive.resolveDriveDownloadStreamUrl(entry.fileId,{},entry.resourceKey,entry.originalUrl));
    const pending=new Map();
    function base(){
        const target=path.resolve(baseDirectory());
        if(path.basename(target)==='Muse云端素材审核'){
            const previous=path.join(path.dirname(target),'VideoKit素材审核');
            if(!fs.existsSync(target)&&fs.existsSync(previous))fs.renameSync(previous,target);
        }
        return target;
    }
    function roots(){const target=base();return path.basename(target)==='Muse云端素材审核'?[target,path.join(path.dirname(target),'VideoKit素材审核')]:[target];}
    function json(file){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(_){return null;}}
    function write(file,data){fs.mkdirSync(path.dirname(file),{recursive:true});const temporary=file+'.tmp';fs.writeFileSync(temporary,JSON.stringify(data,null,2));fs.renameSync(temporary,file);}
    function manifestPath(root){if(!/^gdrive-review:[a-f0-9]{64}$/.test(root))throw Error('无效的云端审核记录');return path.join(base(),'配置','下载记录',root.slice(14)+'.json');}
    function readManifest(root){const name=path.basename(manifestPath(root));for(const folder of roots())for(const sub of ['配置/下载记录','下载记录']){const data=json(path.join(folder,sub,name));if(data)return data;}return null;}
    function writeManifest(root,data){write(manifestPath(root),{version:1,...data,updatedAt:new Date().toISOString()});}
    function assetInfo(fileId){return path.join(base(),'配置','素材记录',hash(fileId)+'.json');}
    function validBatch(value){return /^\d{4}-\d{2}-\d{2}-批次\d{2,}$/.test(String(value||''));}
    function batchFor(root,entries){
        const saved=readManifest(root);if(validBatch(saved?.batch))return saved.batch;
        // 同一云端文件 ID 始终复用首次下载批次，文件改名不改变归属。
        for(const entry of entries){const found=existing(entry.fileId);if(validBatch(found?.batch))return found.batch;}
        const now=new Date(),pad=n=>String(n).padStart(2,'0');
        const date=`${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`;
        fs.mkdirSync(base(),{recursive:true});
        for(let i=1;;i++){const batch=`${date}-批次${pad(i)}`;try{fs.mkdirSync(path.join(base(),batch));return batch;}catch(error){if(error.code!=='EEXIST')throw error;}}
    }
    function existing(fileId){
        for(const folder of roots()){
            const current=json(path.join(folder,'配置','素材记录',hash(fileId)+'.json'));
            if(current?.fileId===fileId && current.complete && current.bytes>0 && current.relativePath){
                const file=path.resolve(folder,current.relativePath);
                if(file.startsWith(folder+path.sep))try{const stat=fs.statSync(file);if(stat.isFile()&&stat.size===current.bytes)return {...current,localPath:file};}catch(_){}
            }
            const info=path.join(folder,'素材',hash(fileId),'download.json');
            const record=json(info);if(!record||record.fileId!==fileId||!record.complete||!(record.bytes>0))continue;
            const file=path.resolve(path.dirname(info),path.basename(record.name||''));
            try{const stat=fs.statSync(file);if(stat.isFile()&&stat.size===record.bytes)return {...record,localPath:file};}catch(_){}
        }
        return null;
    }
    function safeName(name){
        let clean=String(name||'').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').replace(/[. ]+$/g,'');
        if(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(clean))clean='_'+clean;
        const ext=path.extname(clean),stem=Array.from(clean.slice(0,clean.length-ext.length));
        while(stem.length&&Buffer.byteLength(stem.join('')+ext)>200)stem.pop();
        return (stem.join('')+ext)||'media';
    }
    const reserved=new Map();
    function destination(entry,batch,saved){
        if(saved?.batch && validBatch(saved.batch))return {file:saved.localPath,batch:saved.batch};
        if(!validBatch(batch))throw Error('无效的下载批次');
        const folder=path.join(base(),batch,'视频');fs.mkdirSync(folder,{recursive:true});
        const name=safeName(entry.name),ext=path.extname(name),stem=name.slice(0,name.length-ext.length);
        let file=path.join(folder,name);
        let suffix=0;
        while(fs.existsSync(file)||reserved.has(file)&&reserved.get(file)!==entry.fileId){
            suffix++;file=path.join(folder,safeName(`${stem}_${hash(entry.fileId).slice(0,12)}${suffix>1?'_'+suffix:''}${ext}`));
        }
        reserved.set(file,entry.fileId);return {file,batch};
    }
    function recordFor(entry,file,batch,bytes,downloadedAt){return {version:2,fileId:entry.fileId,name:path.basename(file),bytes,complete:true,batch,relativePath:path.relative(base(),file),downloadedAt};}
    async function download(entry,onProgress=()=>{},force=false,batch){
        const saved=existing(entry.fileId);
        if(!entry.name && saved?.name)entry.name=saved.name;
        if(saved&&!force){
            if(saved.batch)return {...saved,reused:true};
            // 旧缓存只在再次读取时接入新目录，保留旧文件路径供已有工程使用。
            const target=destination(entry,batch,saved);
            try{fs.linkSync(saved.localPath,target.file);}catch(error){if(error.code==='EEXIST')throw error;fs.copyFileSync(saved.localPath,target.file,fs.constants.COPYFILE_EXCL);}
            const record=recordFor(entry,target.file,target.batch,saved.bytes,saved.downloadedAt);write(assetInfo(entry.fileId),record);
            return {...record,localPath:target.file,reused:true};
        }
        if(pending.has(entry.fileId))return {...await pending.get(entry.fileId),reused:true};
        const work=(async()=>{
            const source=await openStream(entry);
            if(!entry.name||!MEDIA_EXT.test(entry.name)){
                const fromHeader=drive.parseContentDispositionFilename?.(source.headers['content-disposition'])||'';
                if(fromHeader&&MEDIA_EXT.test(fromHeader))entry.name=fromHeader;
                else if(!entry.name&&fromHeader)entry.name=fromHeader;
            }
            if(!MEDIA_EXT.test(entry.name||'')){
                const ext=extFromContentType(source.headers['content-type']);
                if(ext)entry.name=(entry.name||String(entry.fileId||'media').slice(0,24))+ext;
            }
            if(!MEDIA_EXT.test(entry.name||'')){source.stream.destroy();throw Error('无法获取支持的图片或视频文件名');}
            const target=destination(entry,batch,saved),file=target.file,folder=path.dirname(file),part=file+'.part';
            fs.mkdirSync(folder,{recursive:true});
            // A partial response must contain the whole file for a completed-download record.
            const range=String(source.headers['content-range']||'');
            const match=/^bytes (\d+)-(\d+)\/(\d+)$/.exec(range);
            if(source.status===206&&(!match||Number(match[1])!==0||Number(match[2])+1!==Number(match[3]))){source.stream.destroy();throw Error('云端只返回了部分文件，请重试下载');}
            const expected=Number(match?.[3]||source.headers['content-length'])||0;
            let bytes=0,last=0;
            const meter=new Transform({transform(chunk,encoding,callback){bytes+=chunk.length;const now=Date.now();if(now-last>300){last=now;onProgress({bytes,totalBytes:expected});}callback(null,chunk);}});
            // .part is never accepted as a finished file, including after interrupted app exits.
            await pipeline(source.stream,meter,fs.createWriteStream(part,{flags:'w'}));
            if(bytes===0||(expected>0&&bytes!==expected))throw Error(`文件下载不完整（${bytes}/${expected||'?'} 字节），请重试`);
            fs.renameSync(part,file);
            const record=recordFor(entry,file,target.batch,bytes,new Date().toISOString());write(assetInfo(entry.fileId),record);
            onProgress({bytes,totalBytes:bytes});
            return {...record,localPath:file,reused:false};
        })();
        pending.set(entry.fileId,work);
        try{return await work;}finally{pending.delete(entry.fileId);}
    }
    function sessionPath(root){return path.join(base(),'配置','审核记录',path.basename(manifestPath(root)));}
    function readSession(root){const name=path.basename(sessionPath(root));for(const folder of roots())for(const sub of ['配置/审核记录','审核记录']){const data=json(path.join(folder,sub,name));if(data)return data;}return null;}
    function saveSession(root,session){write(sessionPath(root),session);}
    async function media(request,file,headers,mimeType){
        let size;try{const stat=fs.statSync(file);if(!stat.isFile())throw Error('not file');size=stat.size;}catch(_){return new Response('本地素材已移动或删除，请重新读取链接补下载。',{status:404,headers});}
        const range=request.headers.get('range');let start=0,end=size-1,status=200;
        if(range){const match=/^bytes=(\d*)-(\d*)$/.exec(range);if(!match||(!match[1]&&!match[2]))return new Response(null,{status:416,headers:{...headers,'Content-Range':`bytes */${size}`}});
            if(!match[1])start=Math.max(0,size-Number(match[2]));else start=Number(match[1]);
            if(match[1]&&match[2])end=Math.min(end,Number(match[2]));
            if(start>end||start>=size||!Number.isSafeInteger(start)||!Number.isSafeInteger(end))return new Response(null,{status:416,headers:{...headers,'Content-Range':`bytes */${size}`}});
            status=206;headers={...headers,'Content-Range':`bytes ${start}-${end}/${size}`};
        }
        headers={...headers,'Content-Type':mimeType,'Content-Length':String(Math.max(0,end-start+1))};
        if(request.method==='HEAD')return new Response(null,{status,headers});
        const stream=fs.createReadStream(file,{start,end});const abort=()=>stream.destroy();request.signal?.addEventListener('abort',abort,{once:true});stream.once('close',()=>request.signal?.removeEventListener('abort',abort));if(request.signal?.aborted)abort();
        return new Response(Readable.toWeb(stream),{status,headers});
    }
    return {base,existing,download,batchFor,readManifest,writeManifest,readSession,saveSession,media};
}
module.exports={createCache};
