/** Shared, upright half-screen media windows with a complementary diagonal seam. */
(function(root){
    function halfScreen(mode,angle,width,height){
        if(!['top_half','bottom_half'].includes(mode))return null;
        width=Math.max(1,Number(width)||1080);height=Math.max(1,Number(height)||1920);
        const limit=Math.min(45,Math.atan(Math.max(0,height-2)/width)*180/Math.PI);
        angle=Math.max(-limit,Math.min(limit,Number(angle)||0));
        const delta=Math.tan(angle*Math.PI/180)*width/2,mid=height/2;
        const left=mid-delta,right=mid+delta,top=mode==='top_half';
        const rect=top?{x:0,y:0,w:width,h:Math.max(left,right)}:{x:0,y:Math.min(left,right),w:width,h:height-Math.min(left,right)};
        const polygon=top?[[0,0],[width,0],[width,right],[0,left]]:[[0,left],[width,right],[width,height],[0,height]];
        return {angle,rect,polygon,left,right};
    }
    function contains(polygon,x,y){
        let inside=false;
        for(let i=0,j=polygon.length-1;i<polygon.length;j=i++){
            const [xi,yi]=polygon[i],[xj,yj]=polygon[j];
            if((yi>y)!==(yj>y) && x<(xj-xi)*(y-yi)/(yj-yi)+xi)inside=!inside;
        }
        return inside;
    }
    function alignWindow(overlay,align='cc',width=1080,height=1920){
        if(!overlay || !['image','video'].includes(overlay.type) || overlay.media_window_mode!=='pip')return null;
        if(!/^[tcb][lcr]$/.test(align))return null;
        const saved=overlay.media_window || {};
        const dimension=(key,fallback)=>Number.isFinite(Number(saved[key])) && Number(saved[key])>0?Number(saved[key]):Math.max(1,Number(overlay[key])||fallback);
        const w=dimension('w',540),h=dimension('h',960);
        const x=Math.round(align[1]==='l'?0:align[1]==='r'?width-w:(width-w)/2);
        const y=Math.round(align[0]==='t'?0:align[0]==='b'?height-h:(height-h)/2);
        return {x,y,w,h,media_window:{...saved,x,y,w,h},clip_rect:{x,y,w,h}};
    }
    const api={halfScreen,contains,alignWindow};
    if(typeof module!=='undefined' && module.exports)module.exports=api;
    if(root)root.ReelsMediaWindow=api;
})(typeof window==='object'?window:globalThis);
