'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const stored=new Map();
const window={localStorage:{getItem:key=>stored.get(key),setItem:(key,value)=>stored.set(key,value)}};
const context={window};
vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/reels-layout-description.js'),'utf8'),context);
const api=window.ReelsLayoutDescription;
const slotWindow={};
vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/reels-layer-slots.js'),'utf8'),{window:slotWindow});
const slots=slotWindow.ReelsLayerSlots;
const firstAudience={type:'video'},audiences=[];
slots.applyUnique(firstAudience,'pip_audience',audiences,'画中画（观众）');audiences.push(firstAudience);
const secondAudience={type:'video'};slots.applyUnique(secondAudience,'pip_audience',audiences,'画中画（观众）');audiences.push(secondAudience);
assert.equal(firstAudience.slotKey,'pip_audience_1');assert.equal(firstAudience.slotLabel,'画中画（观众） 1');
assert.equal(secondAudience.slotKey,'pip_audience_2');assert.equal(secondAudience.slotLabel,'画中画（观众） 2');
const oldBare={type:'video',slotKey:'pip_audience',slotLabel:'画中画（观众）',content:'old.mp4'};
const oldTwo={type:'video',slotKey:'pip_audience_2',slotLabel:'画中画（观众）'};
const oldSlots=[oldBare,oldTwo];for(const ov of oldSlots)slots.ensureDefault(ov,oldSlots);
assert.equal(oldBare.slotKey,'pip_audience_1');assert.equal(oldTwo.slotLabel,'画中画（观众） 2');assert.equal(oldBare.content,'old.mp4');
assert.ok(oldSlots.every(ov=>slots.ensureDefault(ov,oldSlots)===false),'migration is idempotent');
const oldNamed=[{slotKey:'pip_secondary',slotLabel:'画中画（观众）'},{slotKey:'pip_audience_1',slotLabel:'画中画（观众） 1'},{slotKey:'media_1',slotLabel:'画中画（观众）'},{slotKey:'pip_general',slotLabel:'画中画（观众）'}];
for(const ov of oldNamed)slots.ensureDefault(ov,oldNamed);
assert.equal(oldNamed[0].slotKey,'pip_secondary');assert.equal(oldNamed[0].slotLabel,'画中画（观众） 2');
assert.equal(oldNamed[2].slotLabel,'画中画（观众） 3');assert.equal(oldNamed[3].slotLabel,'画中画（观众） 4');
assert.ok(oldNamed.every(ov=>slots.ensureDefault(ov,oldNamed)===false));
window._reelsState={globalSubtitleStyle:{fontsize:40}};
assert.equal(api.entries({overlays:[]}).some(entry=>entry.kind==='subtitle'),false,'default style alone is not a subtitle track');
assert.equal(api.entries({segments:[{text:'  '}]}).some(entry=>entry.kind==='subtitle'),false);
assert.equal(api.entries({segments:[{text:'实际字幕',start:0,end:2}]}).some(entry=>entry.kind==='subtitle'),true);
assert.equal(api.entries({txtContent:'只是标题文案'}).some(entry=>entry.kind==='subtitle'),false);
assert.equal(api.entries({txtContent:'滚动文案',subtitleStyle:{scrolling_mode:true,scrolling_motion:'uniform'}}).some(entry=>entry.kind==='subtitle'),true);
window._reelsState=null;
const layer=(slotKey,slotLabel,id=slotKey)=>({id,slotKey,slotLabel,name:'旧自定义名',type:'video',content:'/clips/test.mp4',x:35,y:60,w:300,h:400});
const a={name:'A',bgPath:'bg.mp4',overlays:[layer('pip_sermon','讲道'),layer('media_2','媒体层 2')]};
const b={name:'B',overlays:[layer('pip_audience_main','主观众'),layer('media_2','媒体层 2')]};
const c={name:'C',overlays:[layer('media_2','待统一名称')]};
const tasks=[a,b,c];
const rows=api.layerInventory(tasks),media=rows.find(row=>row.label==='媒体层 2'),sermon=rows.find(row=>row.label==='讲道 1');
assert.equal(media.tasks.size,2);
assert.equal(rows.filter(row=>row.key==='slot:media_2:0').length,2,'keep label variants visible');
assert.deepEqual(Array.from(api.matchingTasks(tasks,[media.id,sermon.id],'any')), [a,b]);
assert.deepEqual(Array.from(api.matchingTasks(tasks,[media.id,sermon.id],'all')), [a]);
assert.equal(api.matchingTasks(tasks,[]).length,0);
assert.equal(api.matchingTasks(tasks,[JSON.stringify(['missing','不存在'])]).length,0);
const original=JSON.stringify(tasks);
const change=api.renameLayers(tasks,[media.id],'画中画（观众）');
assert.equal(change.tasks.length,2);assert.equal(a.overlays[1].slotLabel,'画中画（观众）');
assert.equal(a.overlays[1].name,'画中画（观众）');assert.equal(a.overlays[1].slotKey,'media_2');
assert.equal(c.overlays[0].slotLabel,'待统一名称');
assert.equal(a.overlays[1].content,'/clips/test.mp4');assert.equal(a.overlays[1].x,35);
change.undo();assert.equal(JSON.stringify(tasks),original);
assert.throws(()=>api.renameLayers(tasks,[media.id],'  '));
assert.equal(api.renameLayers(tasks,[rows.find(row=>row.kind==='background').id],'测试').changes.length,0);
// A live inspector may hold clones; update both and undo after switching tasks.
const live=JSON.parse(JSON.stringify(a.overlays));
window._reelsState={tasks,selectedIdx:0,overlayProxy:{overlayMgr:{overlays:live}}};
const mirrored=api.renameLayers(tasks,[media.id],'统一观众层');
assert.equal(live[1].slotLabel,'统一观众层');assert.equal(a.overlays[1].slotLabel,'统一观众层');
const nextLive=JSON.parse(JSON.stringify(b.overlays));
window._reelsState.selectedIdx=1;window._reelsState.overlayProxy.overlayMgr.overlays=nextLive;
mirrored.undo();assert.equal(nextLive[1].slotLabel,'媒体层 2');assert.equal(JSON.stringify(tasks),original);
// Overlays without names/slots retain that absence after undo.
const legacy={overlays:[{id:'legacy',type:'video',content:'test.mp4'}]};
window._reelsState=null;
const legacyChange=api.renameLayers([legacy],[api.layerInventory([legacy])[0].id],'备用画中画');
legacyChange.undo();assert.equal(Object.hasOwn(legacy.overlays[0],'slotLabel'),false);assert.equal(Object.hasOwn(legacy.overlays[0],'name'),false);
// Exercise dialog event handlers with a minimal document, without opening or
// modifying the user's running project.
class Element {
    constructor(tag){this.tag=tag;this.children=[];this.style={};this.value='';this.dataset={};this.attributes={};this.controls=new Map();}
    set innerHTML(html){
        this.html=html;this.controls.clear();
        for(const match of html.matchAll(/<([a-z]+)[^>]*\b(data-layer-[\w-]+)/g))this.controls.set(`[${match[2]}]`,new Element(match[1]));
    }
    querySelector(selector){return this.controls.get(selector);}
    append(...children){for(const child of children){child.parent=this;this.children.push(child);}}
    replaceChildren(...children){this.children=[];this.append(...children);}
    setAttribute(key,value){this.attributes[key]=value;}
    addEventListener(){}
    showModal(){this.open=true;}
    close(){this.open=false;this.onclose?.();}
    remove(){if(this.parent)this.parent.children=this.parent.children.filter(child=>child!==this);}
}
const body=new Element('body');
context.document={body,createElement:tag=>new Element(tag),querySelector:selector=>body.children.find(el=>'.'+el.className===selector)};
let filtered,selected,located;
window.ReelsTaskLayerTools={taskLabel:task=>task.name,filter:tasks=>filtered=tasks,select:tasks=>selected=tasks,locate:(task,key)=>located={task,key},changed:()=>{}};
const dialog=api.openLayerManager(tasks),q=selector=>dialog.querySelector(selector);
const check=label=>{const line=q('[data-layer-list]').children.find(line=>line.children[1].textContent.startsWith(label+'（'));assert.ok(line);line.children[0].checked=true;line.children[0].onchange();};
check('讲道 1');check('媒体层 2');
assert.match(q('[data-layer-count]').textContent,/匹配 2 \/ 3/);
q('[data-layer-mode]').value='all';q('[data-layer-mode]').onchange();
assert.match(q('[data-layer-count]').textContent,/匹配 1 \/ 3/);
q('[data-layer-select]').onclick();assert.deepEqual(Array.from(selected),[a]);
q('[data-layer-name]').value='统一层名';q('[data-layer-rename]').onclick();
assert.equal(a.overlays[0].slotLabel,'统一层名');assert.equal(a.overlays[1].slotLabel,'统一层名');
assert.equal(b.overlays[1].slotLabel,'媒体层 2','ALL mode must not rename tasks that only match one layer');
q('[data-layer-undo]').onclick();assert.equal(JSON.stringify(tasks),original);
check('媒体层 2');q('[data-layer-mode]').value='any';q('[data-layer-mode]').onchange();
q('[data-layer-filter]').onclick();assert.deepEqual(Array.from(filtered),[a,b]);assert.equal(dialog.open,false);
const locateDialog=api.openLayerManager(tasks,{initialKeys:['slot:pip_sermon:0']});
locateDialog.querySelector('[data-layer-results]').children[0].children[1].onclick();
assert.equal(located.task,a);assert.equal(located.key,'slot:pip_sermon:0');assert.equal(locateDialog.open,false);
// Number each task's same-named layers, then aggregate by the resulting name.
const g1={name:'G1',overlays:[layer('old_a','画中画（观众）'),layer('old_b','画中画（观众）'),layer('phone','电话主层')]};
const g2={name:'G2',overlays:[layer('old_c','画中画（观众）')]};
const g3={name:'G3',overlays:[layer('audience_4','画中画（观众） 4')]};
const groupedTasks=[g1,g2,g3],groupedRows=api.groupLayerRows(api.layerInventory(groupedTasks));
const audience=groupedRows.find(group=>group.label==='画中画（观众） 1');
assert.equal(audience.rows.length,2);assert.equal(audience.tasks.size,2);
assert.equal(groupedRows.some(group=>group.label==='画中画（观众）'),false,'no unnumbered remainder');
assert.equal(api.entries(g1)[1].label,'画中画（观众） 2');
assert.equal(api.entries(g3)[0].label,'画中画（观众） 4','preserve existing explicit numbers');
const mixed={overlays:[layer('a','观众'),layer('b','观众 1'),layer('c','观众 1'),layer('d','观众 3')]};
assert.deepEqual(Array.from(api.entries(mixed),entry=>entry.label),['观众 2','观众 1','观众 4','观众 3']);
assert.equal(new Set(api.entries(mixed).map(entry=>entry.label)).size,4,'automatic numbering must avoid collisions');
const copyRows=api.listLayers(groupedTasks);
assert.equal(copyRows.filter(row=>row.label==='画中画（观众） 1').length,1);
const copiedFirst=copyRows.find(row=>row.label==='画中画（观众） 1');
assert.equal(copiedFirst.count,2);
const onlyFirst=api.describe(g1,{includedLayers:[copiedFirst.key],excludedLayers:[]});
assert.ok(onlyFirst.includes('画中画（观众） 1'));assert.ok(!onlyFirst.includes('画中画（观众） 2'));
const audienceIds=audience.rows.map(row=>row.id);
assert.deepEqual(Array.from(api.matchingTasks(groupedTasks,[audienceIds],'all')),[g1,g2]);
const secondIds=groupedRows.find(group=>group.label==='画中画（观众） 2').rows.map(row=>row.id);
assert.deepEqual(Array.from(api.matchingTasks(groupedTasks,[audienceIds,secondIds],'all')),[g1]);
assert.deepEqual(Array.from(api.matchingTasks(groupedTasks,[audienceIds,secondIds],'any')),[g1,g2]);
const groupedDialog=api.openLayerManager(groupedTasks),gq=selector=>groupedDialog.querySelector(selector);
assert.equal(gq('[data-layer-list]').children.length,4);
const wrapper=gq('[data-layer-list]').children[0];
assert.equal(wrapper.children[1].open,false);
assert.match(wrapper.children[0].children[1].textContent,/2\/3 个任务/);
const parentCheck=wrapper.children[0].children[0];parentCheck.checked=true;parentCheck.onchange();
gq('[data-layer-mode]').value='all';gq('[data-layer-mode]').onchange();
assert.match(gq('[data-layer-count]').textContent,/已勾选 1 个名称，匹配 2 \/ 3/);
assert.match(gq('[data-layer-rename]').textContent,/2 层/);
const originalGroups=JSON.stringify(groupedTasks);
gq('[data-layer-name]').value='观众';gq('[data-layer-rename]').onclick();
assert.equal(g1.overlays[0].slotLabel,'观众');assert.equal(g1.overlays[1].slotLabel,'画中画（观众）');assert.equal(g2.overlays[0].slotLabel,'观众');
assert.equal(g3.overlays[0].slotLabel,'画中画（观众） 4');
gq('[data-layer-undo]').onclick();assert.equal(JSON.stringify(groupedTasks),originalGroups);
const singleDetail=gq('[data-layer-list]').children[0].children[1].children[1].children[0];
singleDetail.checked=true;singleDetail.onchange();
const updatedWrapper=gq('[data-layer-list]').children[0];assert.equal(updatedWrapper.children[0].children[0].indeterminate,true);
assert.equal(updatedWrapper.children[1].open,true);assert.match(gq('[data-layer-count]').textContent,/匹配 1 \/ 3/);
groupedDialog.close();
console.log('PASS: per-task automatic numbering, existing-number preservation, collision repair, grouped numbered rows, copy selection, task counts, filtering/location, rename/undo and live/stored mirrors');
