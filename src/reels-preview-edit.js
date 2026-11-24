/** The main V2 and overview use the same editor, task fields and preferences. */
window.ReelsPreviewEdit = (() => {
    let root, toolbar, card, task, hoverPlaying=false;
    const editor=()=>window.ReelsOverviewEdit;
    const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const roles={enabled:'enabled',target:'target',axis:'axis',mediaPart:'mediaPart',guides:'guides',muted:'muted',speed:'speed',hover:'hover',hoverSpeed:'hoverSpeed'};
    function choices(){
        const result=new Map();
        for(const [index,ov] of (task?.overlays || []).entries()){
            const key=ov.slotKey?`slot:${ov.slotKey}`:`layer-index:${index}`;
            result.set(key,ov.slotLabel || window.ReelsLayerSlots?.describe?.(ov.slotKey)?.label || ov.name || `第 ${index+1} 层`);
        }
        return result;
    }
    function refreshChoices(){
        const entries=choices();
        toolbar.querySelector('[data-edit=target]').innerHTML='<option value="auto">点击选择（全部层）</option><option value="multi">仅编辑勾选的层</option><option value="subtitle">字幕</option><option value="background">背景</option><option value="content">内容视频</option>'+
            [...entries].map(([key,label])=>`<option value="${escape(key)}">锁定：${escape(label)}</option>`).join('');
        toolbar.querySelector('.rpv2-layer-choices').innerHTML=[['background','背景'],...entries].map(([key,label])=>`<label><input type="checkbox" data-layer="${escape(key)}">${escape(label)}</label>`).join('');
    }
    function mount(){
        if(!card)return;
        const settings=editor().settings;
        editor().unmount(card);
        if(settings.enabled)editor().mount(card,{
            select:()=>{card.player.pause();hoverPlaying=false;},
            refresh:()=>card.player.refresh(),
            target:()=>settings.target,
            targets:()=>settings.target==='multi'?settings.targets:[],
            axis:()=>settings.axis,mediaPart:()=>settings.mediaPart,
        });
    }
    function sync(){
        if(!toolbar)return;
        const settings=editor().settings;
        for(const [role,key] of Object.entries(roles)){
            const input=toolbar.querySelector(`[data-edit=${role}]`);
            if(input.type==='checkbox')input.checked=settings[key];else input.value=settings[key];
        }
        toolbar.querySelectorAll('[data-layer]').forEach(input=>input.checked=settings.targets.includes(input.dataset.layer));
        toolbar.querySelector('summary').textContent=`允许编辑的层（${settings.targets.length}）`;
        root.classList.toggle('rpv2-center-guides',settings.guides);
        card?.player.setMuted(settings.muted);card?.player.setPlaybackSpeed(settings.speed);
        toolbar.querySelector('[data-edit=target]').title=settings.target==='multi' ? `仅允许勾选的 ${settings.targets.length} 个层 · 分别编辑` : settings.target==='auto' ? '所有层均可编辑 · 点击画面选择' : '只编辑指定对象';
        mount();
    }
    function attach(nextRoot,nextTask){
        if(!nextRoot || !editor() || window.__reelsOverviewCard)return;
        if(!toolbar){
            root=nextRoot;
            const style=document.createElement('style');
            style.textContent=`.rpv2-edit-toolbar{display:flex;gap:8px;flex-wrap:wrap;padding:7px;border-bottom:1px solid #363944;flex-shrink:0;font:11px system-ui;color:#d0ccdf}.rpv2-edit-toolbar label{display:flex;align-items:center;gap:4px}.rpv2-edit-toolbar select,.rpv2-edit-toolbar button{background:#313444;color:#eee;border:1px solid #555;border-radius:4px;font-size:11px}.rpv2-edit-toolbar input{accent-color:#8983ff}.rpv2-edit-toolbar details{position:relative}.rpv2-layer-choices{position:absolute;top:100%;left:0;z-index:30;background:#252832;border:1px solid #555;padding:8px;min-width:180px;max-height:260px;overflow:auto}.rpv2-layer-choices label{padding:4px}#reels-preview-v2-root>.rpv2-window{flex:1;min-height:0;height:auto}.rpv2-center-guides .rpv2-stage::before,.rpv2-center-guides .rpv2-stage::after{content:'';position:absolute;z-index:3;pointer-events:none;box-shadow:0 0 1px #000}.rpv2-center-guides .rpv2-stage::before{left:50%;top:0;bottom:0;border-left:1px dashed #d2dcffcc}.rpv2-center-guides .rpv2-stage::after{top:50%;left:0;right:0;border-top:1px dashed #d2dcffcc}`;
            document.head.appendChild(style);
            toolbar=document.createElement('div');toolbar.className='rpv2-edit-toolbar';
            const speeds='<option value="0.5">0.5</option><option>1</option><option>1.5</option><option>2</option><option>3</option><option>4</option>';
            toolbar.innerHTML=`<label><input data-edit="enabled" type="checkbox">编辑画面</label><label>调整对象<select data-edit="target"></select></label><details><summary>允许编辑的层</summary><div class="rpv2-layer-choices"></div></details><label>画中画<select data-edit="mediaPart"><option value="inner">窗口内素材</option><option value="window">整个窗口</option></select></label><label>方向<select data-edit="axis"><option value="free">自由 XY</option><option value="x">仅 X</option><option value="y">仅 Y</option></select></label><label><input data-edit="guides" type="checkbox">参考线</label><button data-edit="undo">撤销画面调整</button><label>播放速度<select data-edit="speed">${speeds}</select></label><label><input data-edit="muted" type="checkbox">静音</label><label><input data-edit="hover" type="checkbox">悬停预览</label><label>悬停速度<select data-edit="hoverSpeed">${speeds}</select></label>`;
            for(const role of ['enabled','target']){
                const divider=document.createElement('span');divider.className='rpv2-edit-divider';
                const input=toolbar.querySelector(`[data-edit=${role}]`);toolbar.insertBefore(divider,input.closest('label'));
            }
            const layers=toolbar.querySelector('details');
            layers.ontoggle=()=>{if(!layers.open)return;const rect=layers.querySelector('summary').getBoundingClientRect();Object.assign(toolbar.querySelector('.rpv2-layer-choices').style,{position:'fixed',left:`${Math.min(rect.left,window.innerWidth-220)}px`,top:`${rect.bottom+6}px`});};
            style.textContent+=`.rpv2-edit-toolbar{flex-wrap:nowrap;overflow-x:auto;gap:10px}.rpv2-edit-toolbar>*{flex-shrink:0;white-space:nowrap}.rpv2-edit-toolbar select,.rpv2-edit-toolbar button,.rpv2-edit-toolbar summary{padding:4px 6px}.rpv2-edit-toolbar summary{cursor:pointer;background:#303443;border:1px solid #484d60;border-radius:4px;color:#cbc5f3}.rpv2-edit-divider{width:1px;height:22px;background:#484352}`;
            const toolsDrawer=document.createElement('details');
            toolsDrawer.className='rpv2-tools-drawer';
            const toolsSummary=document.createElement('summary');
            toolsSummary.textContent='编辑工具';
            toolsDrawer.append(toolsSummary,toolbar);
            style.textContent+=`.rpv2-tools-drawer{flex-shrink:0;border-bottom:1px solid #363944;background:#191b22}.rpv2-tools-drawer>summary{cursor:pointer;padding:6px 10px;color:#bdb6eb;font:11px system-ui;user-select:none}.rpv2-tools-drawer[open]>summary{color:#ded8ff}.rpv2-tools-drawer .rpv2-edit-toolbar{border-bottom:0}`;
            root.prepend(toolsDrawer);
            toolbar.onchange=event=>{
                const input=event.target;
                if(input.dataset.layer){editor().configure({target:'multi',targets:Array.from(toolbar.querySelectorAll('[data-layer]:checked'),node=>node.dataset.layer)});return;}
                const key=roles[input.dataset.edit];if(!key)return;
                editor().configure({[key]:input.type==='checkbox'?input.checked:['speed','hoverSpeed'].includes(key)?Number(input.value):input.value});
            };
            toolbar.querySelector('[data-edit=undo]').onclick=()=>{
                editor().undo({select:entry=>{const index=window._reelsState.tasks.indexOf(entry.task);if(index>=0 && index!==window._reelsState.selectedIdx)window.reelsSelectTask(index);},refresh:()=>window.ReelsPreviewV2.refresh()});
                mount();
            };
            const stage=root.querySelector('[data-role=stage]');
            stage.addEventListener('contextmenu',event=>{
                const overlay=window.reelsPreviewMediaAtPoint?.(task,card?.player,stage,event.clientX,event.clientY);
                if(!task)return;event.preventDefault();event.stopPropagation();
                window.reelsOpenBackgroundMenu?.(task,overlay,event.clientX,event.clientY);
            },true);
            stage.addEventListener('pointerenter',()=>{
                const settings=editor().settings;
                if(settings.hover && !settings.enabled && !card?.player.isPlaying()) {hoverPlaying=true;card?.player.play(settings.hoverSpeed);}
            });
            stage.addEventListener('pointerleave',()=>{if(hoverPlaying){card?.player.pause();card?.player.setPlaybackSpeed(editor().settings.speed);hoverPlaying=false;}});
            window.addEventListener('reels-preview-edit-settings',sync);
        }
        if(task===nextTask && card)return;
        if(card)editor().unmount(card);
        task=nextTask;
        if(!task){card=null;return;}
        card={task,stage:root.querySelector('[data-role=stage]'),player:window.ReelsPreviewV2,status:root.querySelector('[data-role=title]')};
        refreshChoices();sync();
    }
    return {attach,isDragging:()=>!!card?.dragging};
})();
