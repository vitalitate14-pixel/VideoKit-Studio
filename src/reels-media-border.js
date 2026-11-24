/** Optional borders follow the fixed media viewport, never the source image. */
(function(root){
    const presets={
        thin:{style:'solid',color:'#ffffff',width:3},
        bold:{style:'solid',color:'#ffffff',width:10},
        gold:{style:'solid',color:'#e8bd67',width:5},
        dark:{style:'solid',color:'#171c24',width:6},
        double:{style:'double',color:'#ffffff',width:8},
        dashed:{style:'dashed',color:'#ffffff',width:4},
        glow:{style:'glow',color:'#7dd3fc',width:4},
        metal_silver:{style:'metal',color:'#b8c4d2',width:10},
        metal_gold:{style:'metal',color:'#cba25a',width:10},
        glass:{style:'glass',color:'#c5e8f5',width:10},
        embossed:{style:'embossed',color:'#9ca9ba',width:10},
    };
    function enabled(ov){return ['image','video'].includes(ov?.type) && !!ov.media_border_style && ov.media_border_style!=='none';}
    function settings(ov){
        const preset=presets[ov.media_border_style]||presets.thin;
        return {style:preset.style,position:ov.media_border_position==='outside'?'outside':'inside',color:/^#[0-9a-f]{6}$/i.test(ov.media_border_color||'')?ov.media_border_color:preset.color,
            width:Math.max(0,Math.min(100,Number(ov.media_border_width) || preset.width)),
            opacity:Math.max(0,Math.min(100,ov.media_border_opacity==null?100:Number(ov.media_border_opacity)))/100};
    }
    function insetPolygon(points,inset) {
        const area=points.reduce((sum,[x,y],i)=>{const next=points[(i+1)%points.length];return sum+x*next[1]-next[0]*y;},0);
        const sign=area>=0?1:-1;
        const edges=points.map(([x,y],i)=>{
            const next=points[(i+1)%points.length],dx=next[0]-x,dy=next[1]-y,length=Math.hypot(dx,dy)||1;
            return {x:x-sign*dy/length*inset,y:y+sign*dx/length*inset,dx,dy};
        });
        return edges.map((edge,i)=>{
            const prev=edges[(i+edges.length-1)%edges.length],cross=prev.dx*edge.dy-prev.dy*edge.dx;
            if(Math.abs(cross)<1e-8)return [edge.x,edge.y];
            const t=((edge.x-prev.x)*edge.dy-(edge.y-prev.y)*edge.dx)/cross;
            return [prev.x+t*prev.dx,prev.y+t*prev.dy];
        });
    }
    function draw(ctx,ov,rect,polygon=null){
        if(!enabled(ov)||!rect||!(rect.w>0&&rect.h>0))return;
        const cfg=settings(ov);if(!cfg.opacity)return;
        const outside=cfg.position==='outside';
        const width=outside?cfg.width:Math.min(cfg.width,rect.w/4,rect.h/4);
        if(outside){
            const original=rect;
            rect={x:rect.x-width,y:rect.y-width,w:rect.w+width*2,h:rect.h+width*2};
            ov={...ov};
            for(const key of ['tl','tr','br','bl'])ov['media_corner_'+key]=
                Math.max(0,Math.min(original.w/2,original.h/2,Number(ov['media_corner_'+key])||0))+width;
        }
        const path=(inset,append=false)=>{
            if(!append)ctx.beginPath();
            if(polygon){insetPolygon(polygon,inset-(outside?width:0)).forEach(([x,y],i)=>i?ctx.lineTo(x,y):ctx.moveTo(x,y));ctx.closePath();return;}
            const x=rect.x+inset,y=rect.y+inset,w=rect.w-inset*2,h=rect.h-inset*2;
            const shape=ov.media_window_mode==='pip'?ov.media_mask_shape:'rect';
            if(shape==='circle'){
                const r=Math.max(.01,Math.min(w,h)/2);
                ctx.moveTo(x+w/2+r,y+h/2);ctx.arc(x+w/2,y+h/2,r,0,Math.PI*2);
            }
            else if(shape==='ellipse'){
                ctx.moveTo(x+w,y+h/2);ctx.ellipse(x+w/2,y+h/2,w/2,h/2,0,0,Math.PI*2);
            }
            else if(shape==='round_rect'){
                const radii=['tl','tr','br','bl'].map(key=>Math.max(0,
                    Math.min(rect.w/2,rect.h/2,Number(ov['media_corner_'+key])||0)-inset));
                ctx.roundRect(x,y,w,h,radii);
            }else ctx.rect(x,y,w,h);
        };
        ctx.save();ctx.globalAlpha*=cfg.opacity;ctx.globalCompositeOperation='source-over';
        // The media clip is separate so an outside border can extend beyond the picture.
        // Clip effects to the frame's outer silhouette instead.
        path(0);ctx.clip();
        ctx.strokeStyle=cfg.color;ctx.lineJoin='round';ctx.lineCap='round';
        const stroke=(inset,lineWidth)=>{path(inset);ctx.lineWidth=lineWidth;ctx.stroke();};
        const tint=(amount,alpha=1)=>{
            const values=cfg.color.slice(1).match(/../g).map(value=>parseInt(value,16));
            const mixed=values.map(value=>Math.round(value*(1-Math.abs(amount))+(amount>0?255:0)*Math.abs(amount)));
            return `rgba(${mixed.join(',')},${alpha})`;
        };
        const gradient=(stops)=>{
            const paint=ctx.createLinearGradient(rect.x,rect.y,rect.x+rect.w,rect.y+rect.h);
            stops.forEach(([at,color])=>paint.addColorStop(at,color));
            return paint;
        };
        if(['metal','glass','embossed'].includes(cfg.style)) {
            if(cfg.style==='metal') {
                ctx.strokeStyle=gradient([[0,tint(-.5)],[.17,tint(.7)],[.32,tint(.15)],[.46,tint(-.35)],[.51,tint(.95)],[.58,tint(.35)],[.8,tint(-.3)],[1,tint(.65)]]);
                stroke(width/2,width);
                // Fine concentric grooves stay deterministic while a video plays.
                ctx.globalAlpha*=.22;
                for(let i=1;i<=4;i++){
                    ctx.strokeStyle=i%2?'rgba(255,255,255,.7)':'rgba(0,0,0,.6)';
                    stroke(width*i/5,Math.max(.35,width*.035));
                }
                ctx.globalAlpha/=.22;
                // Clip fine horizontal machining marks to the frame, including curved masks.
                // Batch each tone into one stroke to keep video preview work bounded.
                ctx.save();path(0);path(width,true);ctx.clip('evenodd');
                const spacing=Math.max(1.5,rect.h/600);
                ctx.lineWidth=Math.max(.35,width*.025);
                for(let tone=0;tone<2;tone++){
                    ctx.beginPath();
                    for(let row=0;row*spacing<rect.h;row++){
                        if(row%2!==tone)continue;
                        const y=rect.y+row*spacing;
                        const shift=((row*37)%101)/101*width*2;
                        ctx.moveTo(rect.x-width,y+shift*.12);
                        ctx.lineTo(rect.x+rect.w+width,y-width*.3+shift*.12);
                    }
                    ctx.strokeStyle=tone?'rgba(0,0,0,.12)':'rgba(255,255,255,.22)';
                    ctx.stroke();
                }
                ctx.restore();
            } else if(cfg.style==='glass') {
                ctx.strokeStyle=gradient([[0,tint(.8,.65)],[.35,tint(.35,.16)],[.55,tint(.9,.55)],[1,tint(-.2,.3)]]);
                ctx.shadowColor=tint(-.6,.45);ctx.shadowBlur=width*.8;
                stroke(width/2,width);ctx.shadowBlur=0;
                ctx.strokeStyle=gradient([[0,tint(1,0)],[.2,tint(1,.1)],[.28,tint(1,.85)],[.34,tint(1,.05)],[.65,tint(1,0)],[.75,tint(1,.5)],[.82,tint(1,0)],[1,tint(1,0)]]);
                stroke(width*.45,width*.55);
            } else {
                ctx.strokeStyle=gradient([[0,tint(.65)],[.48,cfg.color],[1,tint(-.65)]]);
                stroke(width/2,width);
                ctx.strokeStyle=gradient([[0,tint(-.5,.65)],[.5,tint(.15,.3)],[1,tint(.85,.8)]]);
                stroke(width*.62,width*.12);
            }
            // Opposing bevels define the outer lip and inner recessed edge.
            ctx.strokeStyle=gradient([[0,tint(.95,.95)],[.45,tint(.55,.65)],[1,tint(-.65,.85)]]);
            stroke(width*.1,Math.max(.6,width*.16));
            ctx.strokeStyle=gradient([[0,tint(-.65,.9)],[.55,tint(-.2,.6)],[1,tint(.9,.95)]]);
            stroke(width*.9,Math.max(.6,width*.16));
        } else {
        if(cfg.style==='dashed')ctx.setLineDash([width*3,width*2]);
        if(cfg.style==='glow'){ctx.shadowColor=cfg.color;ctx.shadowBlur=width*3;}
        if(cfg.style==='double'){stroke(width/6,width/3);stroke(width*5/6,width/3);}
        else stroke(width/2,width);
        }
        ctx.restore();
    }
    const api={enabled,settings,presets,draw};
    if(typeof module!=='undefined')module.exports=api;
    if(root)root.ReelsMediaBorder=api;
})(typeof window==='object'?window:globalThis);
