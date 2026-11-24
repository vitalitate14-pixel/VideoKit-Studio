/** Portable inline-image deduplication. Runtime tasks always receive the original data URLs. */
(function(root,factory){
    if(typeof module==='object' && module.exports)module.exports=factory();
    else root.ReelsProjectAssets=factory();
})(typeof window==='object'?window:globalThis,function(){
    const FORMAT='videokit-inline-images-v1',REF='$videokitImage';
    function isUnusedBrushData(owner,key){
        const match=/^(title|body|footer)_custom_brush_data$/.exec(key);
        return !!match && (owner[match[1]+'_bg_brush']===false || owner[match[1]+'_bg_enabled']===false);
    }
    function isEmptyTimelineTrack(track){
        return track && ['video','audio'].includes(track.type) && Array.isArray(track.clips) &&
            track.clips.length>0 && track.clips.every(clip=>!clip.sourceId && Number(clip.outT || 0)<=Number(clip.inT || 0));
    }
    function cleanUnusedBrushes(value,seen=new WeakSet()){
        if(!value || typeof value!=='object' || seen.has(value))return 0;
        seen.add(value);let removed=0;
        if(value.sources && Array.isArray(value.tracks)){
            const kept=value.tracks.filter(track=>!isEmptyTimelineTrack(track));
            removed+=value.tracks.length-kept.length;value.tracks=kept;
        }
        for(const key of Object.keys(value)){
            if(isUnusedBrushData(value,key)){delete value[key];removed++;}
            else removed+=cleanUnusedBrushes(value[key],seen);
        }
        return removed;
    }
    function encode(project){
        if(!project || typeof project!=='object')return project;
        if(project.embeddedImageFormat===FORMAT)return encode(decode(project));
        const images={},ids=new Map(),seen=new WeakMap(),ancestors=new WeakSet();
        function visit(value){
            if(typeof value==='string' && value.length>=1024 && /^data:image\//i.test(value)){
                let id=ids.get(value);
                if(!id){id='image_'+ids.size;ids.set(value,id);images[id]=value;}
                return {[REF]:id};
            }
            if(!value || typeof value!=='object')return value;
            if(ancestors.has(value))throw new Error('模板工程包含循环引用');
            if(seen.has(value))return seen.get(value);
            const output=Array.isArray(value)?[]:{};seen.set(value,output);ancestors.add(value);
            for(const key of Object.keys(value))if(!isUnusedBrushData(value,key)){
                const item=key==='tracks' && value.sources && Array.isArray(value[key])
                    ? value[key].filter(track=>!isEmptyTimelineTrack(track)) : value[key];
                output[key]=visit(item);
            }
            ancestors.delete(value);return output;
        }
        const result=visit(project);
        if(ids.size){result.embeddedImageFormat=FORMAT;result.embeddedImages=images;}
        return result;
    }
    function decode(project){
        if(!project || project.embeddedImageFormat!==FORMAT)return project;
        const images=project.embeddedImages;
        if(!images || typeof images!=='object')throw new Error('模板内嵌图片表缺失');
        const seen=new WeakMap();
        function visit(value){
            if(!value || typeof value!=='object')return value;
            if(Object.keys(value).length===1 && Object.hasOwn(value,REF)){
                const image=images[value[REF]];
                if(typeof image!=='string' || !/^data:image\//i.test(image))throw new Error('模板内嵌图片缺失：'+value[REF]);
                return image;
            }
            if(seen.has(value))return seen.get(value);
            const result=Array.isArray(value)?[]:{};seen.set(value,result);
            for(const key of Object.keys(value)){
                if(value===project && ['embeddedImageFormat','embeddedImages'].includes(key))continue;
                result[key]=visit(value[key]);
            }
            return result;
        }
        return visit(project);
    }
    return {encode,decode,isUnusedBrushData,isEmptyTimelineTrack,cleanUnusedBrushes};
});
