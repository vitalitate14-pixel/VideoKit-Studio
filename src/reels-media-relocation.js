/** Update only path strings and path keys, preserving task identity and text. */
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.ReelsMediaRelocation=factory();})(typeof window==='object'?window:globalThis,function(){
    function remap(value,mappings,seen=new WeakSet()){
        const sorted=[...mappings].sort((a,b)=>b.source.length-a.source.length);
        function text(value){
            const newline=value.lastIndexOf('\n'),prefix=newline>=0?value.slice(0,newline+1):'',raw=prefix?value.slice(newline+1):value;
            let file=raw,isURL=false;
            if(raw.startsWith('file:'))try{file=decodeURIComponent(new URL(raw).pathname);if(/^\/[A-Za-z]:\//.test(file))file=file.slice(1);isURL=true;}catch(_){}
            for(const {source,target} of sorted)if(file===source || file.startsWith(source+'/') || file.startsWith(source+'\\')){
                const next=target+file.slice(source.length);
                if(!isURL)return prefix+next;
                const norm=next.replace(/\\/g,'/');
                return prefix+'file://'+(norm.startsWith('/')?'':'/')+norm.split('/').map(seg=>/^[A-Za-z]:$/.test(seg)?seg:encodeURIComponent(seg)).join('/');
            }
            return value;
        }
        function visit(item){
            if(typeof item==='string')return text(item);
            if(!item || typeof item!=='object' || seen.has(item))return item;
            seen.add(item);
            for(const key of Object.keys(item)){if(key==='archive')continue;const nextKey=text(key),next=visit(item[key]);if(nextKey!==key)delete item[key];item[nextKey]=next;}
            return item;
        }
        return visit(value);
    }
    function differences(change){
        const relative=(file,folder)=>{
            const raw=String(file || '').replace(/\\/g,'/'),base=String(folder || '').replace(/\\/g,'/').replace(/\/$/,'');
            return (base && raw.startsWith(base+'/')?raw.slice(base.length+1):raw.split('/').pop()).normalize('NFC');
        };
        const oldFiles=change.oldFiles || [],newFiles=change.newFiles || [];
        const oldKeys=new Set(oldFiles.map(file=>relative(file,change.oldFolder))),newKeys=new Set(newFiles.map(file=>relative(file,change.newFolder)));
        return {removed:oldFiles.filter(file=>!newKeys.has(relative(file,change.oldFolder))),added:newFiles.filter(file=>!oldKeys.has(relative(file,change.newFolder)))};
    }
    function formatReport(changes){
        return changes.map(change=>{
            const diff=differences(change);
            return [`任务 #${change.taskNumber || '?'} · ${change.taskName || ''}`,`任务组：${change.tabName || '当前任务组'} · 覆层：${change.layer || '素材'}`,
                `状态：${change.reason || (change.available===false?'未找到':'待人工确认')}`,
                `原关联（${change.oldFiles?.length || 0} 个）：`,...(change.oldFiles || []),
                `找到的（${change.newFiles?.length || 0} 个）：`,...(change.newFiles || []),
                ...(diff.removed.length?[`移除旧引用：${diff.removed.join('、')}`]:[]),...(diff.added.length?[`新增：${diff.added.join('、')}`]:[])].join('\n');
        }).join('\n\n');
    }
    function review(changes,{document:doc=globalThis.document,allowUnlink=false}={}){
        return new Promise(resolve=>{
            const dialog=doc.createElement('dialog');dialog.className='reels-relink-review';
            dialog.style.cssText='width:min(1100px,94vw);max-height:88vh;padding:0;border:1px solid #67618e;border-radius:12px;background:#191b28;color:#e5e7eb;z-index:600000;';
            const header=doc.createElement('div');header.style.cssText='padding:16px;border-bottom:1px solid #414154;';
            const title=doc.createElement('h3');title.textContent=`素材查找结果 · 人工确认（${changes.length} 项）`;title.style.margin='0 0 8px';
            const hint=doc.createElement('div');hint.textContent=allowUnlink?'逐项选择重新关联，或勾选“取消此项原关联”。取消关联只清除工程引用，保留覆层布局，不删除素材文件。':'逐项核对原素材与找到的素材。只关联勾选项；未找到、未勾选和取消均保留原绑定。';hint.style.fontSize='12px';header.append(title,hint);
            const controls=doc.createElement('label');controls.style.cssText='display:flex;gap:8px;padding:12px 16px;align-items:center;';
            const all=doc.createElement('input');all.type='checkbox';controls.append(all,doc.createTextNode('全选可关联项'));
            const list=doc.createElement('div');list.style.cssText='overflow:auto;max-height:58vh;padding:0 16px;display:grid;gap:12px;';
            const choices=changes.map(change=>{
                const row=doc.createElement('section');row.dataset.relinkId=change.id;row.style.cssText='border:1px solid #45465b;border-radius:8px;padding:12px;';
                const label=doc.createElement('label');label.style.cssText='display:flex;gap:8px;align-items:center;';
                const check=doc.createElement('input');check.type='checkbox';check.checked=false;check.disabled=change.available===false;
                check.title=check.disabled?'没有找到候选素材，不能重新关联；可使用下方“取消此项原关联”':'勾选以关联找到的素材';
                const unlink=doc.createElement('input');unlink.type='checkbox';unlink.checked=false;
                const name=doc.createElement('strong');name.textContent=`任务 #${change.taskNumber || '?'} · ${change.layer || '素材'} · ${change.taskName || ''}`;
                label.append(check,name);row.append(label);
                const info=doc.createElement('div');info.textContent=`${change.tabName || '当前任务组'} · ${change.reason || (check.disabled?'未找到':'待人工确认')}`;
                info.style.cssText=`padding:7px 0;font-size:12px;color:${check.disabled?'#fca5a5':'#c4b5fd'}`;row.append(info);
                const columns=doc.createElement('div');columns.style.cssText='display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;';
                const renderColumns=()=>{
                columns.replaceChildren();
                const diff=differences(change);
                for(const [heading,files,marked,color] of [['原关联',change.oldFiles || [],diff.removed,'#fca5a5'],['找到的',change.newFiles || [],diff.added,'#86efac']]){
                    const column=doc.createElement('div'),caption=doc.createElement('b');caption.textContent=`${heading}（${files.length} 个）`;column.append(caption);
                    if(!files.length){const empty=doc.createElement('p');empty.textContent='未找到候选素材';column.append(empty);}
                    for(const file of files){const line=doc.createElement('div');line.textContent=file;line.style.cssText=`padding:5px 0;font:12px/1.5 system-ui;overflow-wrap:anywhere;color:${marked.includes(file)?color:'#d1d5db'}`;column.append(line);}
                    columns.append(column);
                }
                };
                renderColumns();
                if(change.candidates?.length){
                    const select=doc.createElement('select');select.style.cssText='max-width:100%;margin-bottom:8px;';select.setAttribute('aria-label','选择找到的候选素材');
                    const empty=doc.createElement('option');empty.value='';empty.textContent='同名候选：请人工选择正确素材';select.append(empty);
                    for(const path of change.candidates){const option=doc.createElement('option');option.value=path;option.textContent=path;select.append(option);}
                    select.onchange=()=>{
                        const valid=change.candidates.includes(select.value);change.newFiles=valid?[select.value]:[];change.available=valid;
                        check.disabled=!valid || unlink.checked;if(!valid)check.checked=false;info.textContent=valid?'已人工选择候选，请核对并勾选确认':'同名候选：请选择正确素材';renderColumns();update();
                    };
                    row.append(select);
                }
                row.append(columns);
                if(allowUnlink){const label=doc.createElement('label');label.style.cssText='display:flex;align-items:center;gap:8px;padding-top:10px;color:#fbbf24;font-size:12px;';
                    label.append(unlink,doc.createTextNode('取消此项原关联（保留覆层布局，不删除文件）'));row.append(label);}
                list.append(row);return {change,check,unlink};
            });
            const footer=doc.createElement('div');footer.style.cssText='display:flex;justify-content:flex-end;gap:10px;padding:14px 16px;border-top:1px solid #414154;';
            const cancel=doc.createElement('button');cancel.textContent='取消，不修改';const apply=doc.createElement('button');
            const update=()=>{const count=choices.filter(item=>item.check.checked && !item.check.disabled).length,cleared=choices.filter(item=>item.unlink.checked).length;apply.textContent=cleared?`确认关联 ${count} 项 / 取消关联 ${cleared} 项`:`确认关联已勾选的 ${count} 项`;apply.disabled=count+cleared===0;all.checked=count>0 && choices.filter(item=>!item.check.disabled).every(item=>item.check.checked);};
            for(const item of choices){
                item.check.onchange=()=>{if(item.check.checked)item.unlink.checked=false;update();};
                item.unlink.onchange=()=>{if(item.unlink.checked)item.check.checked=false;item.check.disabled=item.change.available===false || item.unlink.checked;update();};
            }
            all.onchange=()=>{for(const item of choices)if(!item.check.disabled)item.check.checked=all.checked;update();};
            let finished=false;
            const finish=result=>{if(finished)return;finished=true;dialog.close();dialog.remove();resolve(result);};
            cancel.onclick=()=>finish(null);apply.onclick=()=>{if(!apply.disabled){
                const result=new Set(choices.filter(item=>item.check.checked && !item.check.disabled).map(item=>item.change.id));
                result.unlinkIds=new Set(choices.filter(item=>item.unlink.checked).map(item=>item.change.id));finish(result);
            }};
            dialog.oncancel=event=>{event.preventDefault();finish(null);};dialog.onclose=()=>finish(null);
            footer.append(cancel,apply);dialog.append(header,controls,list,footer);doc.body.append(dialog);update();dialog.showModal();
        });
    }
    return {remap,differences,formatReport,review};
});
