/** Literal, user-defined ownership tags for material-group folder names. */
(() => {
    'use strict';
    const nameOf=value=>String(value || '').replace(/\\/g,'/').replace(/\/+$/,'').split('/').pop();
    const normalize=value=>String(value || '').normalize('NFC').toLocaleLowerCase();
    const getRules=()=>window.ReelsMediaLibrary?.bindingRules || {enabled:false,keywords:[]};
    const getRoot=()=>window.ReelsMediaLibrary?.root || '';
    const isPhoneGroup=group=>group?.field==='pip' && (/^(?:pip:)?phone_(?:primary|secondary|general)(?:_|$)/.test(group.mediaSlot || group.key || '') || /电话/.test(group.label || ''));
    function isIndependentGroup(group,task){
        if(group?.field==='bg')return true;
        if(group?.field!=='pip')return false;
        const slot=group.mediaSlot || String(group.key || '').replace(/^pip:/,'');
        const layer=(task?.overlays || []).find(layer=>slot && [layer.slotKey,layer._templateOverlayId,layer.id].includes(slot));
        return group.backgroundLinked===true || layer?.backgroundLinked===true || /讲道|sermon|preach/i.test(layer?.name || group.label || '');
    }
    function match(name,rules=getRules()) {
        return [...new Set((rules.keywords || []).filter(keyword=>normalize(name).includes(normalize(keyword))))];
    }
    function groupName(file,root=getRoot()) {
        root=window.ReelsMediaLibrary?.rootFor?.(file) || root;
        const normalized=String(file || '').replace(/\\/g,'/'),prefix=String(root || '').replace(/\\/g,'/').replace(/\/+$/,'')+'/';
        if(root && normalized.startsWith(prefix)){
            const parts=normalized.slice(prefix.length).split('/');
            if(parts[0]==='本批已经使用')parts.splice(0,2);
            if(parts.length>=3)return parts[1];
        }
        return nameOf(normalized.replace(/\/[^/]*$/,''));
    }
    function isExempt(value,group) {
        if(!value)return false;
        const files=group.field==='bg'
            ? (value.bgMode==='multi' ? (value.bgClipActivePool?.length?value.bgClipActivePool:value.bgClipPool || []) : [value.bgPath || value.videoPath])
            : value.media_folder_files?.length ? value.media_folder_files : [value.content];
        return files.length>0 && files.every(file=>window.ReelsBackgroundLibrary?.hasPath?.(typeof file==='string'?file:file?.path));
    }
    function namesOf(value,group,root=getRoot()) {
        if(!value || isIndependentGroup(group) || isExempt(value,group))return [];
        // Phone cards are single files; their filename carries the ownership tag.
        if(isPhoneGroup(group)){
            const files=value.media_folder_files?.length?value.media_folder_files:[value.content];
            return [...new Set(files.map(file=>typeof file==='string'?file:file?.path).filter(Boolean).map(file=>nameOf(file).replace(/\.[^.]+$/,'')))];
        }
        if(group.field==='pip' && value.media_folder_path)return [nameOf(value.media_folder_path)];
        const files=group.field==='bg'
            ? (value.bgMode==='multi' ? (value.bgClipActivePool?.length?value.bgClipActivePool:value.bgClipPool || []) : [value.bgPath || value.videoPath])
            : value.media_folder_files?.length ? value.media_folder_files : [value.content];
        return [...new Set(files.map(file=>typeof file==='string'?file:file?.path).filter(Boolean).map(file=>groupName(file,root)))];
    }
    function checkValues(entries,rules=getRules(),root=getRoot()) {
        if(!rules.enabled)return {allowed:true};
        const matched=entries.map(({group,value})=>({group,keys:[...new Set(namesOf(value,group,root).flatMap(name=>match(name,rules)))]})).filter(entry=>entry.keys.length);
        const choices=matched.map(entry=>entry.keys);
        const keys=choices.length?choices.reduce((shared,next)=>shared.filter(key=>next.includes(key))):[];
        return choices.length && !keys.length ? {allowed:false,reason:`名字固定组合冲突：${matched.map(({group,keys})=>`${group.label || (group.field==='bg'?'背景':group.key || group.mediaSlot || '媒体层')}「${keys.join(' / ')}」`).join('；')}，需要统一为同一个配套关键词`,keys} : {allowed:true,keys};
    }
    function summarizeMaterials(materials,rules=getRules()) {
        const groups=new Map();
        for(const item of materials || [])if(item?.path)groups.set(item.path,item.name || nameOf(item.path));
        const counts=new Map((rules.keywords || []).map(keyword=>[keyword,0]));let unmatched=0,ambiguous=0;
        for(const name of groups.values()){const keys=match(name,rules);for(const key of keys)counts.set(key,counts.get(key)+1);if(keys.length>1)ambiguous++;if(!keys.length)unmatched++;}
        return `已读取 ${groups.size} 个素材组／文件\n`+[...counts].map(([keyword,count])=>`${keyword}：${count} 个可配套素材组`).concat([`未命中：${unmatched} 组；多关键词可选配套：${ambiguous} 组`]).join('\n');
    }
    function summarizeGroups(paths,rules=getRules(),root=getRoot(),layout='categories') {
        const prefix=String(root).replace(/\\/g,'/').replace(/\/+$/,'')+'/',groups=new Map();
        for(const file of paths){
            const normalized=String(file).replace(/\\/g,'/');if(!normalized.startsWith(prefix))continue;
            const parts=normalized.slice(prefix.length).split('/');
            if(parts[0]==='本批已经使用')continue;
            const depth=layout==='files'?parts.length:layout==='suites'?1:2;
            const unit=parts.slice(0,Math.min(depth,parts.length)).join('/');
            groups.set(unit,{path:prefix+unit,name:parts[Math.min(depth,parts.length)-1]});
        }
        return summarizeMaterials([...groups.values()],rules);
    }
    function entriesFor(context,task) {
        return context.groups.filter(group=>!isIndependentGroup(group,task)).map(group=>({group,value:context.readInventory?context.readInventory(task,group,window._reelsState?.tasks?.indexOf(task)):context.read(task,group)}));
    }
    function checkSource(value,group,rules=getRules()) {
        if(!rules.enabled || isIndependentGroup(group) || isExempt(value,group))return {allowed:true};
        const keys=[...new Set(namesOf(value,group).flatMap(name=>match(name,rules)))];
        return keys.length ? {allowed:true,keys} : {allowed:false,reason:'素材组名未命中自定义关键词，不参与固定组合'};
    }
    function checkReplacement(context,task,group,value) {
        if(isIndependentGroup(group,task))return {allowed:true};
        const entries=entriesFor(context,task),source=checkSource(value,group);
        const check=source.allowed?checkValues(entries.map(entry=>entry.group.key===group.key?{group,value}:entry)):source;
        if(check.allowed)return check;
        const describe=(value,group)=>{
            const names=namesOf(value,group),keys=[...new Set(names.flatMap(name=>match(name)))];
            const files=group.field==='bg' ? (value?.bgMode==='multi'?(value.bgClipActivePool?.length?value.bgClipActivePool:value.bgClipPool || []):[value?.bgPath || value?.videoPath]) : value?.media_folder_files?.length?value.media_folder_files:[value?.content];
            const material=value?.media_folder_path?nameOf(value.media_folder_path):files.map(file=>nameOf(typeof file==='string'?file:file?.path)).filter(Boolean).join('、');
            return {names,keys,material};
        };
        const remaining=entries.filter(entry=>entry.group.key!==group.key);
        const required=checkValues(remaining),current=checkValues(entries);
        const selected=describe(value,group),previous=describe(entries.find(entry=>entry.group.key===group.key)?.value,group);
        const label=group.label || (group.field==='bg'?'背景':group.key || '媒体层');
        const formatKeys=result=>result.keys?.length?result.keys.join(' / '):result.allowed?'尚未绑定关键词':'其他层的关键词已不一致';
        const advice=required.allowed && required.keys?.length
            ? `需要换成：${isPhoneGroup(group)?'文件名':'素材组名'}含「${required.keys.join('」或「')}」的素材${isPhoneGroup(group)?'（电话素材按文件名匹配）':''}`
            : !required.allowed ? '需要调整：其余媒体层的关键词已冲突，请先把下面这些层统一到同一个关键词'
            : '需要换成：命中已配置关键词的素材组';
        const lines=[`当前任务配套关键词：${formatKeys(current)}`,`要替换的层：${label}`,`该层原素材：${previous.material || '未设置'}（关键词：${previous.keys.join(' / ') || '未命中'}）`,
            `你选的素材：${selected.material || (isExempt(value,group)?'背景库素材（不受关键词限制）':'未设置')}（关键词：${selected.keys.join(' / ') || '未命中'}）`,advice,
            '其余层的关键词：',...remaining.map(({group,value})=>{
                const item=describe(value,group);
                return `• ${group.label || (group.field==='bg'?'背景':group.key || group.mediaSlot || '媒体层')}：${isExempt(value,group)?'背景库素材，不受关键词限制':item.keys.join(' / ') || '未命中关键词'}${item.names.length?`（${item.names.join('、')}）`:''}`;
            })];
        return {...check,reason:lines.join('\n'),requiredKeys:required.keys || [],selectedKeys:selected.keys,targetLabel:label};
    }
    function checkTask(task) {
        return checkValues((task.overlays || []).filter(ov=>ov && !ov.disabled && ['image','video'].includes(ov.type)).map(value=>({group:{field:'pip',mediaSlot:value.slotKey || value._templateOverlayId || value.id,label:value.name,backgroundLinked:value.backgroundLinked},value})));
    }
    function planner(context,targetGroups,valueFor) {
        const plans=new Map(),rules=getRules(),targets=new Set(targetGroups.map(group=>group.key));
        function entries(card){
            if(!plans.has(card.task))plans.set(card.task,entriesFor(context,card.task).map(entry=>targets.has(entry.group.key)?{group:entry.group,value:null}:entry));
            return plans.get(card.task);
        }
        function candidate(item,card,group){
            if(isIndependentGroup(group,card.task))return entries(card);
            const value=valueFor(item,group),keys=[...new Set(namesOf(value,group).flatMap(name=>match(name,rules)))];
            if(!keys.length && !isExempt(value,group))return null;
            return entries(card).map(entry=>entry.group.key===group.key?{group,value}:entry);
        }
        return {accept(item,card,group){if(!rules.enabled)return true;const values=candidate(item,card,group);return !!values && checkValues(values,rules).allowed;},
            onPick(item,card,group){if(rules.enabled)plans.set(card.task,candidate(item,card,group));}};
    }
    window.ReelsNameBinding={isIndependentGroup,isPhoneGroup,match,groupName,namesOf,checkSource,checkValues,checkReplacement,checkTask,summarizeGroups,summarizeMaterials,entriesFor,planner,get enabled(){return getRules().enabled;}};
})();
