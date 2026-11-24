/** Cloud media review (Google Drive & Muse): metadata and ranged media reads, with local-only decisions. */
const fs=require('fs'),path=require('path'),crypto=require('crypto'),{Readable}=require('stream');
const axios=require('axios');
const input=require('../../src/google-drive-input');
const MEDIA=/\.(mp4|mov|mkv|avi|webm|m4v|jpe?g|png|webp|gif|bmp|avif|svg)$/i;
const MIME_TO_EXT={'video/mp4':'.mp4','video/quicktime':'.mov','video/x-matroska':'.mkv','video/x-msvideo':'.avi','video/webm':'.webm','image/jpeg':'.jpg','image/png':'.png','image/webp':'.webp','image/gif':'.gif','image/bmp':'.bmp','image/avif':'.avif','image/svg+xml':'.svg'};
const PREFIX='local-media://drive-review/';
const DIRECT_HEADERS={
    'User-Agent':'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    'Accept':'*/*',
};
function extFromContentType(value){return MIME_TO_EXT[String(value||'').split(';')[0].trim().toLowerCase()]||'';}
function isPrivateHost(hostname){
    const host=String(hostname||'').trim().toLowerCase().replace(/^\[|\]$/g,'');
    if(!host||host==='localhost'||host.endsWith('.local')||host==='::1'||host==='::'||host==='0.0.0.0')return true;
    if(/^(?:fc|fd)[0-9a-f]{2}:/i.test(host)||/^fe80:/i.test(host)||/^::ffff:/i.test(host))return true;
    const m=/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    if(!m)return false;
    const [a,b]=m.slice(1).map(Number);
    return a===0||a===10||a===127||(a===100&&b>=64&&b<=127)||(a===169&&b===254)||(a===192&&b===168)||(a===172&&b>=16&&b<=31);
}
function assertSafeHttpUrl(rawUrl){
    let url;try{url=new URL(rawUrl);}catch(_){throw Error('无效的下载链接');}
    if(!['http:','https:'].includes(url.protocol)||isPrivateHost(url.hostname))throw Error('不支持访问该地址');
    return url;
}
function parseMuseLink(value){
    let text=String(value||'').trim().replace(/&amp;/gi,'&');
    if(/^(?:[a-z0-9-]+\.)*muse\.ai\//i.test(text))text='https://'+text;
    let url;try{url=new URL(text);}catch(_){return null;}
    if(!['http:','https:'].includes(url.protocol))return null;
    if(!/^(?:[a-z0-9-]+\.)*muse\.ai$/i.test(url.hostname))return null;
    let decodedPath;try{decodedPath=decodeURIComponent(url.pathname);}catch(_){decodedPath=url.pathname;}
    const baseName=path.posix.basename(decodedPath||'').trim();
    const isFilePath=/^\/files\/.+/i.test(decodedPath)&&Boolean(baseName);
    if(!isFilePath&&!MEDIA.test(baseName))return null;
    url.hash='';
    const normalized=url.href;
    const id='muse_'+crypto.createHash('sha256').update(normalized).digest('hex');
    const name=MEDIA.test(baseName)?baseName:'';
    return {type:'direct',id,url:normalized,resourceKey:'',name,provider:'muse'};
}
function parseCloudLink(value){return input.parseLink(value)||parseMuseLink(value);}
function parseCloudCell(value){
    const text=String(value||'').trim();
    if(!text)return [];
    const formula=text.match(/^=?HYPERLINK\(\s*"((?:[^"]|"")*)"\s*(?:[,;]\s*"((?:[^"]|"")*)")?\s*\)$/i);
    if(formula){
        const link=parseCloudLink(formula[1].replace(/""/g,'"'));
        return link?[link]:[];
    }
    const direct=(text.match(/https?:\/\//gi)||[]).length>1?null:parseCloudLink(text);
    if(direct)return [direct];
    const extracted=(text.replace(/(https?:\/\/)/gi,' $1').match(/(?:https?:\/\/[^\s<>"\]]+|(?:[a-z0-9-]+\.)*muse\.ai\/[^\s<>"\]]+|(?:drive|docs)\.google\.com\/[^\s<>"\]]+)/gi)||[])
        .map(raw=>parseCloudLink(raw.replace(/[),.;，。]+$/,'')))
        .filter(Boolean);
    return extracted;
}
function readCloudTable(text){
    const rows=[];let row=[],cell='',quoted=false;
    text=String(text||'').replace(/^\uFEFF/,'');
    for(let i=0;i<text.length;i++){
        const c=text[i];
        if(c==='"'&&(quoted||!cell)){
            if(quoted&&text[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;
        }else if(!quoted&&/[\t\r\n]/.test(c)){
            row.push(cell);cell='';
            if(c!=='\t'){if(c==='\r'&&text[i+1]==='\n')i++;if(row.some(v=>v.trim()))rows.push(row);row=[];}
        }else cell+=c;
    }
    row.push(cell);if(row.some(v=>v.trim()))rows.push(row);
    return rows;
}
function parseCloudLinks(rawText){
    const links=[];
    for(const cells of readCloudTable(rawText)){
        for(const cell of cells)links.push(...parseCloudCell(cell));
    }
    return links;
}
async function defaultDirectStream(targetUrl,extraHeaders={}){
    assertSafeHttpUrl(targetUrl);
    let resp;
    try{
        resp=await axios.get(targetUrl,{
            headers:{...DIRECT_HEADERS,...extraHeaders},
            maxRedirects:5,
            timeout:30000,
            validateStatus:()=>true,
            responseType:'stream',
            beforeRedirect(options){
                const protocol=options.protocol||'https:';
                const hostname=options.hostname||options.host||'';
                if(!['http:','https:'].includes(protocol)||isPrivateHost(hostname))throw Error('重定向目标地址不受支持');
            },
        });
    }catch(error){
        throw Error(`直链请求失败：${error.message||error}`);
    }
    const contentType=String(resp.headers['content-type']||'').toLowerCase();
    if(resp.status<200||resp.status>=300){
        try{resp.data.destroy();}catch(_){}
        if(resp.status===401||resp.status===403)throw Error(`无权访问该云端链接（HTTP ${resp.status}）`);
        if(resp.status===404||resp.status===410)throw Error(`云端文件不存在或链接已失效（HTTP ${resp.status}）`);
        throw Error(`云端链接下载失败（HTTP ${resp.status}）`);
    }
    if(contentType.includes('text/html')){
        try{resp.data.destroy();}catch(_){}
        throw Error('链接返回的是网页而非视频或图片，请检查链接是否有效');
    }
    return {
        stream:resp.data,
        headers:resp.headers,
        status:resp.status,
        finalUrl:resp.request?.res?.responseUrl||targetUrl,
    };
}
function createService({drive=require('./googleDriveDownloader'),fetchDirectStream=defaultDirectStream,directory=()=>path.join(require('electron').app.getPath('userData'),'drive-review'),downloadDirectory=()=>path.join(require('electron').app.getPath('downloads'),'Muse云端素材审核')}={}) {
    const registered=new Map();
    const resolveStream=(entry,headers={})=>entry.type==='direct'
        ? fetchDirectStream(entry.originalUrl,headers)
        : drive.resolveDriveDownloadStreamUrl(entry.fileId,headers,entry.resourceKey,entry.originalUrl);
    const cache=require('./google-drive-review-cache').createCache({baseDirectory:downloadDirectory,drive,resolveStream});
    const keyFor=rawText=>{
        const links=parseCloudLinks(String(rawText||''));
        if(!links.length)throw Error('请粘贴 Google Drive 或 Muse（muse.ai）文件/文件夹链接。');
        const ids=[...new Set(links.map(link=>`${link.type}:${link.id}:${link.resourceKey||''}`))].sort();
        return 'gdrive-review:'+crypto.createHash('sha256').update(ids.join('\n')).digest('hex');
    };
    async function probeDirectName(entry){
        let source;
        try{
            source=await fetchDirectStream(entry.originalUrl,{Range:'bytes=0-0'});
            const fromHeader=drive.parseContentDispositionFilename?.(source.headers['content-disposition'])||'';
            let name=fromHeader||entry.name||'';
            if(!MEDIA.test(name)){
                const ext=extFromContentType(source.headers['content-type']);
                if(ext)name=(name||entry.fileId.slice(0,24))+ext;
            }
            return name;
        }finally{
            try{source?.stream?.destroy();}catch(_){}
        }
    }
    function sessionPath(root){if(!/^gdrive-review:[a-f0-9]{64}$/.test(root||''))throw Error('无效的云端审核记录');return path.join(directory(),root.slice(14)+'.json');}
    async function open({rawText,cacheToLocal=true,refresh=false,forceRedownload=false}={},onProgress=()=>{}) {
        const root=keyFor(rawText),warnings=[];
        const historical=cacheToLocal?cache.readManifest(root):null;
        const links=parseCloudLinks(rawText);
        const hasDrive=links.some(link=>link.type!=='direct');
        const hasMuse=links.some(link=>link.type==='direct');
        const sourceProvider=hasDrive&&hasMuse?'mixed':hasMuse?'muse':'gdrive';
        const providerTitle=sourceProvider==='muse'?'Muse':sourceProvider==='mixed'?'云端素材':'Google Drive';
        // Direct file links (Google Drive /file/d/... and Muse direct files) do not need
        // a separate page lookup or filename probe.
        const isDirectFastLink=link=>link.type==='direct'||(link.type==='file'&&/\/file\/(?:u\/\d+\/)?d\//i.test(link.url));
        if(cacheToLocal && links.length && links.every(isDirectFastLink)){
            const seen=new Set();
            const oldById=new Map((historical?.entries||[]).map(entry=>[entry.fileId,entry]));
            const entries=links.filter(link=>!seen.has(link.id)&&seen.add(link.id)).map(link=>({...oldById.get(link.id),type:link.type==='direct'?'direct':'file',fileId:link.id,name:oldById.get(link.id)?.name||link.name||'',originalUrl:link.url,resourceKey:link.resourceKey||''}));
            const batch=cache.batchFor(root,entries),files=new Array(entries.length);
            cache.writeManifest(root,{sourceLinks:rawText,entries,batch});
            let cursor=0,completed=0,downloaded=0,reused=0;
            const report=(entry,extra={})=>onProgress({phase:'download',completed,total:entries.length,downloaded,reused,name:entry?.name||'正在连接云端文件',...extra});
            report();
            const worker=async()=>{while(cursor<entries.length){
                const index=cursor++,entry=entries[index];
                try{
                    let result;
                    try{result=await cache.download(entry,p=>report(entry,p),forceRedownload,batch);}
                    catch(error){
                        if(!forceRedownload||!cache.existing(entry.fileId))throw error;
                        result=await cache.download(entry,()=>{},false,batch);
                        warnings.push(`${entry.name||entry.fileId}：重新下载失败，仍使用本地旧文件（${error.message}）`);
                    }
                    if(!entry.name)entry.name=result.name;
                    const id=crypto.createHash('sha256').update(entry.fileId+':'+(entry.resourceKey||'')).digest('hex');
                    const source=PREFIX+id+path.extname(entry.name).toLowerCase();
                    entry.localPath=result.localPath;entry.batch=result.batch;registered.set(id,entry);
                    files[index]={path:source,name:entry.name,relativePath:path.relative(cache.base(),result.localPath).split(path.sep).join('/'),originalRelativePath:entry.name,type:/\.(mp4|mov|mkv|avi|webm|m4v)$/i.test(entry.name)?'video':'image',cloud:true,sourceUrl:entry.originalUrl,fileId:entry.fileId,downloaded:true,localPath:result.localPath,batch:result.batch};
                    if(result.reused)reused++;else downloaded++;
                }catch(error){warnings.push(`${entry.name||entry.fileId}：${error.message}`);}
                completed++;report(entry);
            }};
            await Promise.all(Array.from({length:Math.min(3,entries.length)},worker));
            cache.writeManifest(root,{sourceLinks:rawText,entries,batch});
            const ready=files.filter(Boolean);
            if(!ready.length)throw Error(warnings[0]||'素材下载失败，请检查链接和共享权限。');
            let session=null;try{session=JSON.parse(fs.readFileSync(sessionPath(root),'utf8'));}catch(error){if(error.code!=='ENOENT')warnings.push('本机历史审核记录读取失败。');}
            if(!session)session=cache.readSession(root);
            if(session)try{cache.saveSession(root,session);}catch(_){warnings.push('素材已下载，但审核记录备份写入失败。');}
            return {root,files:ready,session,warnings,cacheToLocal:true,downloadDirectory:cache.base(),downloaded,reused,total:entries.length,sourceLinks:rawText,sourceProvider,label:entries.length>1?`${providerTitle} · ${ready.length} 个素材`:ready[0].name};
        }
        const directLinks=[];
        const seenDirect=new Set();
        for(const link of links){
            if(link.type==='direct'&&!seenDirect.has(link.id)){
                seenDirect.add(link.id);
                directLinks.push({type:'direct',fileId:link.id,name:link.name||'',originalUrl:link.url,folderPath:''});
            }
        }
        const driveLinks=links.filter(link=>link.type!=='direct');
        let results=historical?.entries;
        if(!results || refresh || forceRedownload){
            let driveScanned=[];
            if(driveLinks.length){
                onProgress({phase:'scan',message:'正在读取 Google Drive 文件与子文件夹…'});
                try {
                    const driveRaw=hasMuse?driveLinks.map(link=>link.url).join('\n'):rawText;
                    const scanned=await drive.parseDriveInput(driveRaw,{expandFolders:true,allowDuplicate:false},progress=>{
                        const line=progress.lineContext;
                        const prefix=line?`链接 ${line.lineCurrent}/${line.lineTotal} · `:'';
                        const count=Number.isFinite(progress.totalFilesFound)?` · 已发现 ${progress.totalFilesFound} 个文件（当前文件夹链接）`:'';
                        onProgress({phase:'scan',message:prefix+(progress.message||'正在读取 Google Drive…')+count});
                    });
                    if(historical?.entries?.length && !scanned.some(entry=>entry.fileId && MEDIA.test(entry.name||''))){warnings.push('未能刷新云端目录，已保留历史下载记录。');driveScanned=historical.entries.filter(entry=>entry.type!=='direct');}
                    else driveScanned=scanned;
                } catch(error){if(!results)throw error;warnings.push('网络无法刷新目录，使用历史下载记录。');driveScanned=historical.entries.filter(entry=>entry.type!=='direct');}
            }
            const oldDirectById=new Map((historical?.entries||[]).filter(e=>e.type==='direct').map(e=>[e.fileId,e]));
            const mergedDirect=directLinks.map(entry=>({...oldDirectById.get(entry.fileId),...entry,name:entry.name||oldDirectById.get(entry.fileId)?.name||''}));
            results=[...driveScanned,...mergedDirect];
        }
        const candidates=results||[];
        // Some sharing pages omit names. Resolve those concurrently before filtering,
        // and report this separate phase so a large batch does not appear stalled.
        let nameCursor=0,namesChecked=0;
        const needNameProbe=candidates.some(entry=>entry.type!=='folder' && /^[a-zA-Z0-9_-]+$/.test(entry.fileId||'') && !entry.name);
        if(needNameProbe){
            onProgress({phase:'scan',message:`正在检查文件名 0/${candidates.length}，完成后开始下载…`});
            const nameWorker=async()=>{while(nameCursor<candidates.length){
                const entry=candidates[nameCursor++];
                if(entry.type!=='folder' && /^[a-zA-Z0-9_-]+$/.test(entry.fileId||'') && !entry.name){
                    try{entry.name=entry.type==='direct'?await probeDirectName(entry):((await drive.probeDriveFileSize(entry.fileId,undefined,entry.resourceKey,entry.originalUrl)).serverFileName||'');}catch(error){warnings.push(error.message);}
                }
                namesChecked++;
                onProgress({phase:'scan',message:`正在检查文件名 ${namesChecked}/${candidates.length}，完成后开始下载…`});
            }};
            await Promise.all(Array.from({length:Math.min(5,candidates.length)},nameWorker));
        }
        const files=[],entries=[];
        for(const entry of candidates) {
            if(entry.type==='folder'){warnings.push(`无法展开文件夹“${entry.name||entry.folderId}”，请检查共享权限。`);continue;}
            if(!/^[a-zA-Z0-9_-]+$/.test(entry.fileId||''))continue;
            let name=String(entry.name||'');
            if(!MEDIA.test(name)){if(!name)warnings.push(`未能读取文件 ${entry.fileId} 的名称或权限。`);continue;}
            const id=crypto.createHash('sha256').update(entry.fileId+':'+(entry.resourceKey||'')).digest('hex');
            const ext=path.extname(name).toLowerCase(),source=PREFIX+id+ext;
            const asset={...entry,name};entries.push(asset);
            registered.set(id,asset);
            const relativePath=[entry.folderPath,name].filter(Boolean).join('/');
            files.push({path:source,name,relativePath,type:/\.(mp4|mov|mkv|avi|webm|m4v)$/i.test(name)?'video':'image',cloud:true,
                sourceUrl:entry.originalUrl||`https://drive.google.com/file/d/${entry.fileId}/view`,fileId:entry.fileId});
        }
        if(!files.length)throw Error(warnings[0]||'未找到可审核的视频或图片。请确认链接有共享读取权限，且文件名带有媒体扩展名。');
        let downloaded=0,reused=0,completed=0;
        if(cacheToLocal){
            onProgress({phase:'download',completed:0,total:entries.length,downloaded:0,reused:0,name:'正在准备下载'});
            const batch=cache.batchFor(root,entries);
            // Persist discovery before transfers so partial failures can be retried without rescanning.
            cache.writeManifest(root,{sourceLinks:rawText,entries,batch});
            const attachLocal=(file,entry,result)=>{
                file.downloaded=true;file.localPath=result.localPath;
                file.originalRelativePath=file.relativePath;
                file.relativePath=path.relative(cache.base(),result.localPath).split(path.sep).join('/');
                file.batch=result.batch;entry.localPath=result.localPath;entry.batch=result.batch;
                const id=file.path.slice(PREFIX.length).split('.')[0];registered.get(id).localPath=result.localPath;
            };
            let cursor=0;
            const worker=async()=>{while(cursor<entries.length){
                const index=cursor++,entry=entries[index],file=files[index];
                try{
                    const result=await cache.download(entry,progress=>onProgress({phase:'download',completed,total:entries.length,name:entry.name,downloaded,reused,...progress}),forceRedownload,batch);
                    attachLocal(file,entry,result);
                    if(result.reused)reused++;else downloaded++;
                }catch(error){file.downloadError=error.message;const old=cache.existing(entry.fileId);if(old){attachLocal(file,entry,old);reused++;warnings.push(`${entry.name}：重新下载失败，仍使用本地旧文件（${error.message}）`);}else warnings.push(`${entry.name}：${error.message}`);}
                completed++;onProgress({phase:'download',completed,total:entries.length,name:entry.name,downloaded,reused});
            }};
            await Promise.all(Array.from({length:Math.min(3,entries.length)},worker));
            cache.writeManifest(root,{sourceLinks:rawText,entries,batch});
            if(!files.some(file=>file.downloaded))throw Error(warnings[0]||'素材下载失败，请检查网络后重新读取；已下载的文件会自动复用。');
        }
        let session=null;try{session=JSON.parse(fs.readFileSync(sessionPath(root),'utf8'));}catch(error){if(error.code!=='ENOENT')warnings.push('本机历史审核记录读取失败。');}
        if(!session&&cacheToLocal)session=cache.readSession(root);
        if(session&&cacheToLocal)try{cache.saveSession(root,session);}catch(_){warnings.push('素材已下载，但审核记录备份写入失败。');}
        return {root,files:cacheToLocal?files.filter(file=>file.downloaded):files,session,warnings,cacheToLocal,downloadDirectory:cacheToLocal?cache.base():'',downloaded,reused,total:files.length,sourceLinks:rawText,sourceProvider,label:links.length>1?`${providerTitle} · ${files.length} 个素材`:(results.find(x=>x.folderPath)?.folderPath?.split('/')[0]||files[0].name)};
    }
    function save({root,session}) {
        const file=sessionPath(root);if(!session||typeof session!=='object')throw Error('审核记录为空');
        const body=JSON.stringify({...session,root,savedAt:new Date().toISOString()});
        if(Buffer.byteLength(body)>16*1024*1024)throw Error('审核记录过大，请分批审核');
        fs.mkdirSync(directory(),{recursive:true});const tmp=file+'.tmp';fs.writeFileSync(tmp,body);fs.renameSync(tmp,file);
        const manifest=cache.readManifest(root);if(manifest)cache.saveSession(root,JSON.parse(body));
        return {saved:true};
    }
    async function media(request) {
        const match=String(request.url||'').match(/^local-media:\/\/drive-review\/([a-f0-9]{64})\.[a-z0-9]+(?:[?#].*)?$/i);
        const entry=match&&registered.get(match[1]);
        const headers={'Access-Control-Allow-Origin':'*','Cache-Control':'no-store','Accept-Ranges':'bytes'};
        if(!entry)return new Response('请重新读取云端链接以恢复预览。',{status:404,headers});
        if(path.extname(entry.name||'').toLowerCase()==='.svg'){
            headers['Content-Security-Policy']="default-src 'none'; style-src 'unsafe-inline'; img-src data:;";
        }
        if(request.method==='OPTIONS')return new Response(null,{status:204,headers:{...headers,'Access-Control-Allow-Headers':'Range','Access-Control-Allow-Methods':'GET, HEAD, OPTIONS'}});
        if(!['GET','HEAD'].includes(request.method))return new Response(null,{status:405,headers});
        const range=request.headers.get('range');
        if(range&&!/^bytes=(?:\d+-\d*|-\d+)$/.test(range))return new Response(null,{status:416,headers});
        if(entry.localPath)return cache.media(request,entry.localPath,headers,mime(entry.name));
        let source;
        try {
            source=await resolveStream(entry,range?{Range:range}:{});
            for(const key of ['content-type','content-length','content-range'])if(source.headers[key])headers[key]=String(source.headers[key]);
            if(!headers['content-type']||headers['content-type'].includes('octet-stream'))headers['content-type']=mime(entry.name);
            const abort=()=>source.stream.destroy();request.signal?.addEventListener('abort',abort,{once:true});
            source.stream.once('close',()=>request.signal?.removeEventListener('abort',abort));
            if(request.signal?.aborted){abort();return new Response(null,{status:499,headers});}
            if(request.method==='HEAD'){abort();return new Response(null,{status:source.status,headers});}
            return new Response(Readable.toWeb(source.stream),{status:source.status,headers});
        }catch(error){source?.stream?.destroy();return new Response(String(error.message||error),{status:502,headers:{...headers,'Content-Type':'text/plain; charset=utf-8'}});}
    }
    return {open,save,media,keyFor};
}
function mime(name){return ({'.mp4':'video/mp4','.m4v':'video/mp4','.mov':'video/quicktime','.mkv':'video/x-matroska','.avi':'video/x-msvideo','.webm':'video/webm','.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.webp':'image/webp','.gif':'image/gif','.bmp':'image/bmp','.avif':'image/avif','.svg':'image/svg+xml'})[path.extname(name).toLowerCase()]||'application/octet-stream';}
let instance;function service(){return instance||=createService();}
module.exports={createService,parseCloudLinks,parseMuseLink,open:(data,onProgress)=>service().open(data,onProgress),save:data=>service().save(data),media:request=>service().media(request)};
