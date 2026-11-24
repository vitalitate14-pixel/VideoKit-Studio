/** Read-only source inspection, shared by both task views. */
(function(root,factory){
    if(typeof module==='object' && module.exports)module.exports=factory();
    else root.ReelsMaterialSources=factory(root);
})(typeof window==='object'?window:globalThis,function(win){
    'use strict';
    const base=path=>String(path).replace(/\\/g,'/').split('/').pop();
    function normalize(value){
        if(typeof value!=='string' || !value)return '';
        if(/^(file|local-media):/i.test(value)){
            try{const url=new URL(value.replace(/^local-media:/i,'file:'));return decodeURIComponent(url.pathname).replace(/^\/([a-z]:\/)/i,'$1');}catch(_){}
        }
        return value;
    }
    const local=path=>/^(\/|[a-z]:[\\/]|\\\\)/i.test(path);
    const parent=path=>local(path)?path.replace(/[\\/][^\\/]*$/,''):'';
    function thumbnailKind(entry){
        if(entry.kind==='folder')return '';
        const path=entry.previewSource || entry.path || '';
        if(/^data:image\//i.test(path) || /\.(png|jpe?g|webp|gif|bmp|svg|avif)(?:[?#].*)?$/i.test(path))return 'image';
        return /\.(mp4|mov|m4v|mkv|webm|avi)(?:[?#].*)?$/i.test(path)?'video':'';
    }
    function layerLabel(overlay){
        const name=String(overlay.name || '').trim();
        const slot=String(overlay.slotLabel || (overlay.slotKey?win?.ReelsLayerSlots?.describe?.(overlay.slotKey)?.label:'') || '').trim();
        const customName=name && !['video','image','audio','text','textcard','gif'].includes(name.toLowerCase())?name:'';
        if(customName)return slot && slot!==customName?`${customName}（${slot}）`:customName;
        return slot || ({video:'视频层',image:'图片层',audio:'音频层',text:'文字层',textcard:'文字卡片',gif:'GIF 动态层'}[overlay.type]) || '未命名层';
    }
    function collect(task){
        const groups=[];
        function group(label){
            const entries=[],seen=new Set();
            groups.push({label,entries});
            return (value,role='素材',folder=false)=>{
                const raw=typeof value==='string'?value:value?.path;
                const path=normalize(raw);if(!path)return;
                const embedded=/^data:/i.test(path),temporary=/^blob:/i.test(path);
                const key=path;if(seen.has(key))return;seen.add(key);
                entries.push({role,kind:embedded?'embedded':temporary?'temporary':folder?'folder':local(path)?'file':'remote',
                    path:embedded||temporary?'':path,name:embedded?'工程内嵌图片':temporary?'运行时临时素材':base(path),folder:embedded||temporary?'':parent(path)});
                if(embedded && /^data:image\//i.test(path))Object.defineProperty(entries.at(-1),'previewSource',{value:path});
            };
        }
        const bg=group('背景');
        bg(task.bgPath || task.videoPath,'当前背景');
        bg(task.bgFolderPath || task.bgFolder,'背景素材文件夹',true);
        for(const file of task.bgClipActivePool || [])bg(file,'当前背景片段');
        for(const file of task.bgClipPool || [])bg(file,'背景素材池');
        const scan=(value,add,seen=new WeakSet())=>{
            if(!value || typeof value!=='object' || seen.has(value))return;seen.add(value);
            for(const [key,item] of Object.entries(value)){
                if(key.startsWith('_') || ['srcUrl','bgSrcUrl'].includes(key))continue;
                if(typeof item==='string' && (key==='content' || /(?:path|file|url|custom_brush_data)$/i.test(key))){
                    // Text content can resemble a filename; only media content is a resource.
                    if(key==='content' && !['image','video','audio'].includes(value.type))continue;
                    if(/^data:image\//i.test(item) || /^blob:/i.test(item) || local(normalize(item)) || /^https?:\/\//i.test(item))add(item,/brush/i.test(key)?({title_custom_brush_data:'标题画刷',body_custom_brush_data:'正文画刷',footer_custom_brush_data:'底部文字画刷',card_custom_brush_data:'卡片画刷'}[key] || '画刷图片'):key==='content'?'当前素材':'附加素材');
                }else if(item && typeof item==='object'){
                    if(key==='media_folder_files')for(const file of Array.isArray(item)?item:[])add(file,'文件夹内素材');
                    else scan(item,add,seen);
                }
            }
        };
        const overlays=(items,prefix='覆层')=>(items || []).forEach((overlay,index)=>{
            const add=group(`${prefix} ${index+1} · ${layerLabel(overlay)}${overlay.disabled?'（已停用）':''}`);
            add(overlay.media_folder_path,'素材文件夹',true);scan(overlay,add);
        });
        overlays(task.overlays);
        if(task.pipPath && !(task.overlays || []).some(overlay=>normalize(overlay.content)===normalize(task.pipPath)))group('画中画（旧版素材位）')(task.pipPath,'当前素材');
        const audio=group('音频 / 字幕 / 文案');
        for(const [key,label] of [['audioPath','配音'],['bgmPath','背景音乐'],['srtPath','字幕文件'],['txtPath','文案文件']])audio(task[key],label);
        const timeline=task.timeline;
        if(timeline?.sources){
            const add=group('时间线素材');
            const used=new Set((timeline.tracks || []).flatMap(track=>(track.clips || []).map(clip=>clip.sourceId || clip.source_id)));
            for(const [id,source] of Object.entries(timeline.sources))if(used.has(id))add(source.path,'时间线引用');
        }
        if(task.cover){const add=group('封面');scan({...task.cover,overlays:null},add);overlays(task.cover.overlays,'封面覆层');}
        return groups.filter(group=>group.entries.length);
    }
    function open(task){
        if(!task)return;
        win._syncCurrentOverlayEditorToSelectedTask?.();
        document.querySelector('.reels-material-sources[open]')?.close();
        const groups=collect(task),dialog=document.createElement('dialog');
        dialog.className='reels-material-sources';
        dialog.style.cssText='position:fixed;inset:0;margin:auto;width:min(960px,94vw);max-height:88vh;overflow:auto;padding:20px;background:#242631;color:#eee;border:1px solid #73778c;border-radius:12px';
        dialog.innerHTML='<h3>任务素材来源</h3><p data-task></p><p style="font-size:12px;color:#bec3d4">显示当前工程记录的引用路径。文件夹素材会逐项列出；内嵌图片没有独立来源路径。</p><input data-search aria-label="搜索素材来源" placeholder="搜索层名称、文件名或路径" style="width:100%;box-sizing:border-box;margin-bottom:12px"><div data-list></div><p data-status role="status"></p><div style="display:flex;justify-content:flex-end;gap:10px;margin-top:14px"><button data-copy>复制全部来源</button><button data-close>关闭</button></div>';
        const q=selector=>dialog.querySelector(selector),cache=new Map();
        const existsFor=path=>{
            if(!cache.has(path))cache.set(path,win.electronAPI?.fileExists?.(path) ?? null);
            return cache.get(path);
        };
        let thumbnailLoader;
        const release=()=>{
            thumbnailLoader?.dispose();thumbnailLoader=null;
            dialog.querySelectorAll('video').forEach(video=>{video.pause();video.removeAttribute('src');video.load();});
        };
        q('[data-task]').textContent=task.exportName || task.fileName || task.baseName || '当前任务';
        const status=text=>q('[data-status]').textContent=text;
        const copy=async text=>{try{await navigator.clipboard.writeText(text);status('已复制来源信息');}catch(_){status('复制失败，请直接选中路径复制');}};
        const describe=entry=>entry.kind==='embedded'?'图片保存在工程数据中':entry.kind==='temporary'?'临时资源，工程未记录原文件路径':entry.path;
        const render=()=>{
            release();const query=q('[data-search]').value.trim().toLocaleLowerCase();q('[data-list]').replaceChildren();let count=0;
            for(const group of groups){
                const entries=group.entries.filter(entry=>[group.label,entry.name,entry.path,entry.role].join(' ').toLocaleLowerCase().includes(query));
                if(!entries.length)continue;
                const section=document.createElement('section'),title=document.createElement('h4');title.textContent=group.label;section.appendChild(title);
                for(const entry of entries){
                    count++;
                    const row=document.createElement('div');row.style.cssText='padding:10px;margin-bottom:8px;border:1px solid #484c60;border-radius:7px;overflow-wrap:anywhere;font-size:12px';
                    const kind=thumbnailKind(entry),exists=entry.kind==='file'?existsFor(entry.path):null;
                    const content=document.createElement('div');content.style.cssText='flex:1;min-width:0';
                    if(kind && exists!==false){
                        const src=entry.previewSource || (win._toPlayablePath?win._toPlayablePath(entry.path):win.electronAPI?.toFileUrl?.(entry.path) || entry.path);
                        if(src){
                            const media=document.createElement(kind==='image'?'img':'video');media.crossOrigin='anonymous';
                            media.style.cssText='width:112px;height:112px;object-fit:contain;background:#11131b;border-radius:6px;flex-shrink:0';
                            media.title=entry.name;
                            if(kind==='image'){media.src=src;media.alt=entry.name;media.loading='lazy';media.decoding='async';media.onerror=()=>{media.replaceWith(Object.assign(document.createElement('span'),{textContent:'缩略图不可用'}));};}
                            else{media.className='rbt-thumb-previewable';media.dataset.thumbSrc=src;media.dataset.thumbSize='224';media.preload='none';media.muted=true;media.playsInline=true;}
                            row.appendChild(media);
                        }
                    }
                    row.style.display='flex';row.style.gap='12px';row.style.flexWrap='wrap';row.appendChild(content);
                    const label=document.createElement('strong');label.textContent=`${entry.role} · ${entry.name}`;content.appendChild(label);
                    for(const text of [entry.folder?'来源文件夹：'+entry.folder:'',describe(entry)])if(text){const line=document.createElement('div');line.style.cssText='margin-top:5px;white-space:pre-wrap;user-select:text';line.textContent=text;content.appendChild(line);}
                    if(entry.kind==='file' || entry.kind==='folder'){
                        const exists=existsFor(entry.path);
                        if(exists===false){const missing=document.createElement('div');missing.textContent='文件或目录已不存在';missing.style.color='#f6b77a';content.appendChild(missing);}
                        const reveal=document.createElement('button');reveal.textContent=entry.kind==='folder'?'打开文件夹':'在文件夹中显示';reveal.disabled=exists===false;
                        reveal.onclick=()=>entry.kind==='folder'?win.electronAPI?.openPath?.(entry.path):win.electronAPI?.showItemInFolder?.(entry.path);content.appendChild(reveal);
                    }
                    section.appendChild(row);
                }
                q('[data-list]').appendChild(section);
            }
            thumbnailLoader=win.BatchThumbnailLoader?.hydrate(dialog,{independent:true});
            status(count?`显示 ${count} 条素材引用`:'没有符合条件的素材来源');
        };
        q('[data-search]').oninput=render;q('[data-close]').onclick=()=>dialog.close();
        q('[data-copy]').onclick=()=>copy(groups.map(group=>group.label+'\n'+group.entries.map(entry=>entry.role+'：'+describe(entry)).join('\n')).join('\n\n'));
        dialog.onclose=()=>{release();dialog.remove();};document.body.appendChild(dialog);dialog.showModal();render();q('[data-search]').focus();
    }
    function appendAction(menu,task){
        const button=document.createElement('button');button.textContent='查看本任务全部素材来源';button.setAttribute('role','menuitem');
        button.style.cssText='display:block;padding:10px 20px;text-align:left;background:#363a50;color:white;border:0;border-radius:5px;cursor:pointer';
        button.onclick=()=>{menu.remove();open(task);};menu.appendChild(button);
    }
    return {collect,normalize,thumbnailKind,open,appendAction};
});
