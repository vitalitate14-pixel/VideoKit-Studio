/* Independent transparent phone-card workshop. No Reels state is read or written. */
(function (root) {
'use strict';
// Spreadsheet TSV quotes protect embedded tabs/newlines; doubled quotes are literal quotes.
function parseClipboardCells(text) {
    const grid=[];let row=[],cell='',quoted=false,closed=false;
    text=String(text);
    for(let i=0;i<text.length;i++){
        const ch=text[i];
        if(quoted){if(ch==='"'){if(text[i+1]==='"'){cell+='"';i++;}else{quoted=false;closed=true;}}else cell+=ch;continue;}
        if(ch==='"'&&cell===''&&!closed){const rest=text.slice(i+1);if(/"(?:[\t\r\n]|$)/.test(rest)){quoted=true;continue;}}
        if(ch==='\t'){row.push(cell);cell='';closed=false;}
        else if(ch==='\n'||ch==='\r'){row.push(cell);grid.push(row);row=[];cell='';closed=false;if(ch==='\r'&&text[i+1]==='\n')i++;}
        else cell+=ch;
    }
    if(quoted)throw new Error('表格粘贴内容的引号未闭合，请重新复制单元格');
    if(cell!==''||row.length||!grid.length){row.push(cell);grid.push(row);}
    return grid;
}
function outputFileName(prefix, phone) {
    let base=(String(prefix)+String(phone)).replace(/\r\n|\n|\r|\t/g,' ').replace(/"/g,'').replace(/[<>:/\\|?*]/g,'_').replace(/[\x00-\x1f]/g,'');
    if(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(base))base='_'+base;
    return base+'.png';
}
function compactEmptyRows(cells){return cells.filter(row=>row.some(value=>String(value).trim()!==''));}
function rowsFromCells(cells) {
    return cells.flatMap((cols,index)=>{
        if(cols.every(v=>v===''))return [];
        if(cols.length!==2)throw new Error(`第 ${index+1} 行需要两列：电话文字、输出名字前缀（用 Tab 分隔）`);
        if(!cols[0])throw new Error(`第 ${index+1} 行电话文字为空`);
        return [{phone:cols[0],prefix:cols[1],name:outputFileName(cols[1],cols[0])}];
    });
}
function parseRows(text){return rowsFromCells(parseClipboardCells(text));}
function validateRows(rows) {
    const names = new Set();
    for (const row of rows) {
        if (/[<>:"/\\|?*\x00-\x1f]/.test(row.name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(row.name))
            throw new Error('电话内容已原样保留，但输出名字含文件名不支持的字符，无法按原名保存文件');
        const key = row.name.normalize('NFC').toLowerCase();
        if (names.has(key)) throw new Error(`输出名字重复：${row.name}。请修改第二列前缀，避免覆盖`);
        names.add(key);
        if (new TextEncoder().encode(row.name).length > 240) throw new Error('输出文件名过长，请缩短名字前缀');
    }
    if (!rows.length) throw new Error('请先粘贴两列数据，不包含表头');
}
function centeredCover(width,height,targetWidth=1080,targetHeight=1920){
    const scale=Math.max(targetWidth/width,targetHeight/height);
    return {x:(targetWidth-width*scale)/2,y:(targetHeight-height*scale)/2,width:width*scale,height:height*scale};
}
function displayPhoneText(phone,style={}) {
    if(style.phoneLines==='inline'){
        const lines=String(phone).split(/\r\n|\n|\r/).filter(line=>line.trim());
        const parts=lines.length>1?lines:String(phone).trim().split(/\s+/);
        if(parts.length===2)return parts.map(part=>displayPhoneText(part)).join(' ');
        return lines.map(line=>displayPhoneText(line)).join(' ');
    }
    return String(phone).split(/(\r\n|\n|\r)/).map((line,index)=>{
        if(index%2||!line.trim())return line;
        return /^(\s*)\+/.test(line)?line:line.replace(/^(\s*)/, '$1+');
    }).join('');
}
function samplePhone(style={}) {
    if(style.phoneLines==='inline')return '+49123456789 +44987654321';
    return Number(style.phoneLines)===2 ? '+49 123 456789\n+44 987 654321' : '+49 123 456789';
}
function outputFolderName(now = new Date()) {
    const pad = n => String(n).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}_${String(now.getMilliseconds()).padStart(3,'0')}_电话卡片`;
}
function joinOutputPath(parent, ...parts) {
    const separator = parent.includes('\\') ? '\\' : '/';
    return (parent.replace(/[\\/]+$/, '') || '') + separator + parts.join(separator);
}
function cardStyle(style,source){
    const size=source?.sizeOverrides?.[style.id];
    const position=source?.positionOverrides?.[style.id];
    const color=source?.colorOverrides?.[style.id];
    if(!Number.isFinite(size)&&!position&&!color)return style;
    return {...style,...(color?{color}:{}),...(Number.isFinite(size)?{size:Math.max(1,Math.min(2000,size))}:{}),...(Number.isFinite(position?.x)?{x:Math.max(0,Math.min(100,position.x))}:{}),...(Number.isFinite(position?.y)?{y:Math.max(0,Math.min(100,position.y))}:{})};
}
function randomTemplateIds(ids,count,random=Math.random){
    const pool=[...new Set(ids)];
    if(!Number.isInteger(count)||count<1)throw new Error('每行模板数量必须是大于 0 的整数');
    if(count>pool.length)throw new Error(`只勾选了 ${pool.length} 个模板，无法给同一电话分配 ${count} 个不重复模板`);
    for(let i=pool.length-1;i>0;i--){const j=Math.floor(random()*(i+1));[pool[i],pool[j]]=[pool[j],pool[i]];}
    return pool.slice(0,count);
}
function bindingStats(data,styles){
    const valid=new Set(styles.map(s=>s.id)),usage=new Map(styles.map(s=>[s.id,[]]));let total=0,unassigned=0;
    for(const row of data){const ids=[...new Set(row.templateIds||[])].filter(id=>valid.has(id));if(!ids.length)unassigned++;total+=ids.length;for(const id of ids)usage.get(id).push(row);}
    return{usage,total,unassigned};
}
function buildJobs(data, styles) {
    if(!data.length)throw new Error('请先填写电话文字和输出名字前缀');
    const jobs=[], paths=new Set();
    for(const row of data){
        const ids=[...new Set(row.templateIds||[])];
        if(!ids.length)throw new Error(`第 ${row.rowIndex+1} 行尚未选择卡片模板`);
        for(const id of ids){
            const style=styles.find(s=>s.id===id);
            if(!style)throw new Error(`第 ${row.rowIndex+1} 行的模板已删除，请重新选择`);
            let name=row.name,number=2;
            const key=value=>value.normalize('NFC').toLowerCase();
            while(paths.has(key(name)))name=row.name.replace(/\.png$/i,`_${number++}.png`);
            paths.add(key(name));jobs.push({row,style,name});
        }
    }
    return jobs;
}
if(typeof module !== 'undefined') module.exports={parseRows,validateRows,outputFolderName,joinOutputPath,buildJobs,parseClipboardCells,rowsFromCells,samplePhone,outputFileName,centeredCover,displayPhoneText,compactEmptyRows,bindingStats,cardStyle,randomTemplateIds};
if(!root.document) return;
const panel=document.getElementById('phone-cards-panel');
if(!panel) return;
const css=document.createElement('style'); css.textContent=`
#phone-cards-panel .pc-layout{display:grid;grid-template-columns:300px minmax(300px,1fr);gap:20px}#phone-cards-panel .pc-box{padding:18px;background:var(--bg-secondary,#20212b);border:1px solid #454554;border-radius:10px;margin-bottom:16px}#phone-cards-panel button{padding:8px 12px;cursor:pointer;margin:3px;border-radius:6px}#phone-cards-panel input,#phone-cards-panel select,#phone-cards-panel textarea{background:#15151e;color:#eee;border:1px solid #555;border-radius:4px;padding:7px;box-sizing:border-box}#phone-cards-panel label.pc-field{display:flex;justify-content:space-between;align-items:center;gap:10px;margin:10px 0}#phone-cards-panel .pc-field input,#phone-cards-panel .pc-field select{width:145px}#phone-cards-panel canvas{max-width:100%;max-height:420px;object-fit:contain;cursor:crosshair;touch-action:none}#phone-cards-panel .pc-checker{background-color:#ddd;background-image:conic-gradient(#aaa 25%,transparent 0 50%,#aaa 0 75%,transparent 0);background-size:20px 20px;text-align:center;padding:12px;overflow:auto}#phone-cards-panel [data-styles]{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px;max-height:650px;overflow:auto;margin-top:12px}#phone-cards-panel .pc-style{display:grid;grid-template-columns:24px minmax(0,1fr);gap:8px;padding:10px;border:1px solid #555;border-radius:8px}#phone-cards-panel .pc-style input{grid-column:1;grid-row:2}#phone-cards-panel .pc-style img{grid-column:1 / -1;grid-row:1}#phone-cards-panel .pc-style.active{background:#45406b}#phone-cards-panel .pc-style img{width:100%;height:340px;object-fit:contain;cursor:pointer;box-sizing:border-box}#phone-cards-panel .pc-style button{grid-column:2;grid-row:2;font-size:13px;text-align:left;overflow-wrap:anywhere;min-width:0;margin:0;padding:5px;background:transparent;color:inherit;border:0}#phone-cards-panel .pc-gallery{display:flex;gap:12px;flex-wrap:wrap}#phone-cards-panel .pc-gallery figure{margin:0;width:160px;overflow-wrap:anywhere}#phone-cards-panel .pc-gallery img{width:160px;max-height:150px;object-fit:contain}#phone-cards-panel .pc-table-wrap{overflow-anchor:none;max-height:clamp(500px,75dvh,1100px);overflow:auto;border:1px solid #555;border-radius:6px}#phone-cards-panel .pc-data-table{width:100%;border-collapse:collapse;table-layout:fixed}#phone-cards-panel .pc-data-table th{position:sticky;top:0;background:#292934;text-align:left;padding:10px;z-index:1}#phone-cards-panel .pc-data-table td{border-top:1px solid #444;padding:4px}#phone-cards-panel .pc-data-table textarea{width:100%;border:1px solid transparent;border-radius:0;background:transparent}#phone-cards-panel .pc-data-table textarea:focus{outline:1px solid #a78bfa;background:#15151e}#phone-cards-panel .pc-data-table td:first-child{text-align:center;color:#aaa}#phone-cards-panel .pc-data-table button{padding:5px;font-size:12px}#phone-cards-panel .pc-drop-hint{border:2px dashed #716b91;border-radius:8px;padding:18px 12px;text-align:center;color:#c9c1e8;margin-bottom:12px}#phone-cards-panel [data-image-drop].pc-dragover{outline:2px solid #a78bfa;background:#373047}#phone-cards-panel .pc-template-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;padding:12px}#phone-cards-panel .pc-template-tile{display:flex;flex-direction:column;gap:8px;padding:10px;border:2px solid #555;border-radius:8px;cursor:pointer;overflow-wrap:anywhere}#phone-cards-panel .pc-template-tile.selected{border-color:#a78bfa;background:#38304c}#phone-cards-panel .pc-template-tile img{width:100%;height:340px;object-fit:contain;box-sizing:border-box}#phone-cards-panel .pc-template-tile input{width:auto}#phone-cards-panel .pc-selected-thumbs{display:flex;gap:4px;flex-wrap:wrap}#phone-cards-panel .pc-selected-thumbs img{width:75px;height:48px;object-fit:contain}#phone-cards-panel .pc-gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr))}#phone-cards-panel .pc-gallery figure,#phone-cards-panel .pc-gallery img{width:100%}#phone-cards-panel .pc-gallery img{height:380px;max-height:none;box-sizing:border-box}#phone-cards-panel .pc-data-table{min-width:700px}#phone-cards-panel .pc-preview-stage{width:min(100%,360px);aspect-ratio:9 / 16;margin:12px auto;padding:0;overflow:hidden;position:relative}#phone-cards-panel .pc-preview-stage canvas{display:block;width:100%;height:100%;max-width:none;max-height:none;object-fit:fill}#phone-cards-panel .pc-scrub-field{cursor:ew-resize;touch-action:none}#phone-cards-panel .pc-scrub-field input{cursor:ew-resize;touch-action:none}#phone-cards-panel .pc-scrubbing,#phone-cards-panel .pc-scrubbing input{user-select:none}#phone-cards-panel .pc-scrubbing input{border-color:#a78bfa}#phone-cards-panel [data-image-drop]{grid-column:1 / -1}#phone-cards-panel .pc-layout{grid-template-columns:300px minmax(300px,1fr)}#phone-cards-panel .pc-thumb-control{display:flex;align-items:center;gap:10px;margin-top:12px;font-size:13px}#phone-cards-panel .pc-thumb-control input{width:160px}#phone-cards-panel [data-styles]{grid-template-columns:repeat(var(--pc-template-columns,4),minmax(0,1fr));max-height:720px}#phone-cards-panel .pc-style img{height:auto;aspect-ratio:9 / 16}#phone-cards-panel .pc-style{min-width:0}#phone-cards-panel .pc-editor-workspace{grid-column:1 / -1;display:grid;grid-template-columns:340px minmax(0,1fr);grid-template-rows:auto minmax(0,1fr);gap:12px;height:clamp(460px,calc(100dvh - 120px),850px);min-height:0;border:1px solid #454554;border-radius:10px;padding:12px;box-sizing:border-box}#phone-cards-panel .pc-editor-heading{grid-column:1 / -1;margin:0;font-size:15px}#phone-cards-panel .pc-editor-workspace [data-settings]{overflow:auto;min-height:0;margin:0;padding:12px}#phone-cards-panel .pc-editor-preview{display:flex;flex-direction:column;align-items:center;min-height:0;margin:0;padding:12px;overflow:hidden}#phone-cards-panel .pc-editor-preview h3{margin:0 0 8px}#phone-cards-panel .pc-editor-preview p{margin:4px 0;font-size:12px}#phone-cards-panel .pc-editor-preview .pc-preview-stage{flex:1;min-height:0;width:auto;height:100%;max-width:100%;aspect-ratio:9 / 16;margin:8px auto}#phone-cards-panel .pc-editor-preview canvas{width:100%;height:100%;object-fit:contain}#phone-cards-panel .pc-batch-section{grid-column:1 / -1;min-width:0}@media(max-width:650px){#phone-cards-panel .pc-editor-workspace{grid-template-columns:minmax(180px,1fr) minmax(150px,1fr);gap:6px;padding:6px}#phone-cards-panel .pc-editor-workspace .pc-field{flex-wrap:wrap}#phone-cards-panel .pc-editor-workspace .pc-field input,#phone-cards-panel .pc-editor-workspace .pc-field select{width:100%}}#phone-cards-panel.pc-middle-thumbs .pc-style img,#phone-cards-panel.pc-middle-thumbs .pc-template-tile img,#phone-cards-panel.pc-middle-thumbs .pc-gallery img{height:auto;aspect-ratio:var(--pc-thumb-aspect,27 / 16);object-fit:contain}#phone-cards-panel.pc-middle-thumbs .pc-selected-thumbs img{height:48px;aspect-ratio:var(--pc-thumb-aspect,27 / 16)}#phone-cards-panel .pc-quick-board{overflow-anchor:none}#phone-cards-panel .pc-board-tools{display:flex;flex-wrap:wrap;align-items:center;gap:12px}#phone-cards-panel .pc-board-tools input{width:auto}#phone-cards-panel .pc-board-phones{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px;max-height:300px;overflow:auto;overflow-anchor:none}#phone-cards-panel button.pc-phone-tag{display:flex;flex-direction:column;align-items:stretch;gap:7px;text-align:left;background:#242430;color:#eee;border:2px solid #555;min-width:0}#phone-cards-panel button.pc-phone-tag.active{border-color:#a78bfa;background:#38304c}#phone-cards-panel .pc-phone-content{white-space:pre-wrap;overflow-wrap:anywhere}#phone-cards-panel .pc-board-bound-thumbs{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:4px}#phone-cards-panel .pc-board-bound-thumbs figure{margin:0;min-width:0;font-size:11px;overflow-wrap:anywhere}#phone-cards-panel .pc-board-bound-thumbs img{width:100%;height:auto;padding:3px;box-sizing:border-box}#phone-cards-panel .pc-board-templates{display:grid;grid-template-columns:repeat(var(--pc-board-columns,4),minmax(0,1fr));gap:12px;max-height:650px;overflow:auto;overflow-anchor:none}#phone-cards-panel .pc-board-template{border:2px solid #555;border-radius:8px;padding:8px;min-width:0;background:#242430}#phone-cards-panel .pc-board-template.selected{border-color:#a78bfa;background:#38304c}#phone-cards-panel button.pc-board-template-pick{display:flex;flex-direction:column;width:100%;margin:0;gap:8px;background:transparent;border:0;color:inherit;overflow-wrap:anywhere}#phone-cards-panel .pc-board-template-pick img{width:100%;aspect-ratio:9 / 16;object-fit:contain;padding:5px;box-sizing:border-box}#phone-cards-panel.pc-middle-thumbs .pc-board-template-pick img{aspect-ratio:var(--pc-thumb-aspect,27 / 16)}#phone-cards-panel .pc-board-template summary{cursor:pointer;font-size:12px;padding:8px 0}#phone-cards-panel button.pc-bound-phone-link{display:block;width:100%;white-space:pre-wrap;text-align:left;font-size:12px;background:#171721;color:#eee;border:1px solid #555}@media(max-width:650px){#phone-cards-panel .pc-board-templates{grid-template-columns:repeat(2,minmax(0,1fr))}}#phone-cards-panel .pc-card-size{display:flex;align-items:center;flex-wrap:wrap;gap:4px;font-size:12px;margin-top:6px}#phone-cards-panel .pc-card-size input{width:70px}#phone-cards-panel .pc-card-size button{padding:4px;font-size:12px}#phone-cards-panel [data-gallery] input[type=range]{width:100%;padding:0}#phone-cards-panel .pc-board-current-bindings{display:flex;gap:10px;flex-wrap:wrap;margin:12px 0}#phone-cards-panel .pc-board-current-bindings>div{width:180px;border:1px solid #777;border-radius:6px;padding:6px}#phone-cards-panel .pc-board-current-bindings img{width:100%;height:auto;padding:4px;box-sizing:border-box}#phone-cards-panel .pc-board-current-bindings span{display:block}#phone-cards-panel .pc-board-current-bindings button{font-size:12px;padding:4px}#phone-cards-panel .pc-replace-modal{position:fixed;inset:0;background:#000a;z-index:10000;display:flex;align-items:center;justify-content:center;padding:20px}#phone-cards-panel .pc-replace-box{width:min(1100px,95vw);max-height:85vh;overflow:auto;background:#242430;border:1px solid #777;border-radius:10px;padding:16px;color:#eee}#phone-cards-panel .pc-replace-box button{color:inherit;background:#343442}#phone-cards-panel.pc-middle-thumbs .pc-replace-box img{height:auto;aspect-ratio:var(--pc-thumb-aspect,27 / 16)}#phone-cards-panel .pc-scrub-number{cursor:ew-resize;touch-action:none}#phone-cards-panel .pc-card-size input[type=color]{height:32px;padding:3px}#phone-cards-panel .pc-muted{color:#b2b1c0;font-size:13px}@media(max-width:850px){#phone-cards-panel .pc-layout{grid-template-columns:1fr}}`;
document.head.appendChild(css);
panel.innerHTML=`<h2>透明电话卡片批量制作</h2><p class="pc-muted">批量导入底图 → 设置每张卡片的文字 → 粘贴两列数据 → 导出透明 PNG。每行电话可单独选择多个卡片模板。成品统一 1080×1920（9:16），底图等比放大、居中铺满。</p><div class="pc-layout"><div class="pc-box" data-image-drop><h3>① 卡片样式</h3><div class="pc-drop-hint">拖拽透明 PNG / WebP 图片到这里，可一次导入多张</div><button data-import>批量导入透明底图</button><input data-files type="file" accept="image/png,image/webp" multiple hidden><label class="pc-thumb-control">缩略图大小 <input data-thumb-size type="range" min="2" max="8" value="4" step="1" aria-label="模板缩略图大小"><span data-thumb-label>每行 4 张</span></label><label class="pc-thumb-control"><input data-middle-thumbs type="checkbox" checked>自定义缩略图显示区域（取消勾选查看完整画面）</label><label class="pc-thumb-control">显示区域高度 <input data-thumb-height type="range" min="10" max="100" value="33.333" step="0.1"><span data-thumb-height-label></span></label><label class="pc-thumb-control">区域中心位置 <input data-thumb-center type="range" min="0" max="100" value="50" step="0.1"><span data-thumb-center-label></span></label><div class="pc-selection-actions"><button data-select-all>全选</button><button data-select-invert>反选</button><button data-select-none>取消选择</button><button data-delete-selected>删除已选样式</button><button data-clear-library>清空样式库</button><span data-library-selected class="pc-muted"></span></div><div data-styles></div><button data-backup>备份样式</button><button data-restore>导入样式备份</button><input data-backup-file type="file" accept="application/json" hidden><p class="pc-muted">点击模板名称编辑，设置电话位置和字体后保存。左侧勾选仅用于批量复制文字设置；每行电话在表格中独立选择模板。</p></div><div><div class="pc-box" data-settings><h3>② 当前样式文字设置</h3><label class="pc-field">样式名字<input data-prop="name"></label><label class="pc-field">电话排版<select data-prop="phoneLines"><option value="1">一行 · 一个电话</option><option value="2">两行 · 两个电话</option><option value="inline">一行 · 两个电话（空格分隔）</option></select></label><label class="pc-field">行距 %<input data-prop="lineSpacing" type="number" min="60" max="300"></label><label class="pc-field">字体<select data-prop="font" id="pc-font-select" style="width:145px"><option value="Arial">Arial</option></select></label><label class="pc-field">字号（1080×1920 像素）<input data-prop="size" type="number" min="1" max="2000"></label><label class="pc-field">文字颜色<input data-prop="color" type="color"></label><label class="pc-field">水平位置 %<input data-prop="x" type="number" min="0" max="100" step="0.1"></label><label class="pc-field">垂直位置 %<input data-prop="y" type="number" min="0" max="100" step="0.1"></label><label class="pc-field">文字区域宽度 %<input data-prop="width" type="number" min="1" max="100"></label><label class="pc-field">对齐<select data-prop="align"><option value="center">居中</option><option value="left">左对齐</option><option value="right">右对齐</option></select></label><label class="pc-field">粗体<input data-prop="bold" type="checkbox"></label><label class="pc-field">描边颜色<input data-prop="stroke" type="color"></label><label class="pc-field">描边宽度<input data-prop="strokeWidth" type="number" min="0" max="50"></label><label class="pc-field">过长自动缩小<input data-prop="fit" type="checkbox"></label><button data-save-template>保存当前模板</button><button data-save-copy>另存为新模板</button><p class="pc-muted">模板库整体自动保存；此按钮确认保存当前修改，其他模板保留。</p><button data-copy>将文字设置应用到勾选样式</button><button data-delete>删除当前样式</button></div></div><div><div class="pc-box"><h3>③ 电话和文件名字前缀</h3><p class="pc-muted">从表格粘贴两列，不含表头：第一列电话文字，第二列输出名字前缀。表格保留原文字；卡片每行电话自动补 +，已有 + 不重复添加。一个单元格可填写一行或两行电话。文件名＝前缀＋电话文字.png（换行转空格、双引号去掉、其他非法字符转下划线，仅影响文件名）。</p><div class="pc-table-wrap"><table class="pc-data-table"><thead><tr><th style="width:45px">序号</th><th>电话文字</th><th>输出名字前缀</th><th style="width:260px">卡片模板（可多选）</th><th style="width:65px">操作</th></tr></thead><tbody data-rows></tbody></table></div><button data-add-row>＋ 添加一行</button><button data-clear-rows>清空表格</button><div data-count></div></div><div class="pc-box"><h3>当前卡片预览</h3><p class="pc-muted">点击或拖动预览调整电话位置；棋盘格仅用于查看透明度，导出不含棋盘格。</p><label>预览电话 <select data-preview-row></select></label><div class="pc-checker pc-preview-stage"><canvas data-canvas width="1080" height="1920"></canvas></div><p data-filename class="pc-muted"></p></div><div class="pc-box"><button data-preview>刷新所有最终卡片</button><label>输出目录 <input data-output-dir readonly style="width:65%" placeholder="默认下载文件夹"></label><button data-choose-output>选择输出目录</button><br><button data-export>批量导出透明 PNG</button><button data-open-output hidden>打开输出文件夹</button><button data-cancel hidden>取消生成</button><p data-status role="status"></p><h3>所有最终电话卡片</h3><div class="pc-gallery" data-gallery></div></div></div></div>`;
// Keep controls and canvas in one viewport-sized editing workspace.
const layout=panel.querySelector('.pc-layout');
const settingsBox=panel.querySelector('[data-settings]');
const previewBox=panel.querySelector('[data-canvas]').closest('.pc-box');
const editor=document.createElement('div');editor.className='pc-editor-workspace';
const workHeading=document.createElement('h3');workHeading.className='pc-editor-heading';workHeading.textContent='模板编辑 · 左侧调整，右侧实时预览';
editor.append(workHeading,settingsBox,previewBox);
const oldSettingsColumn=layout.children[1];
layout.insertBefore(editor,oldSettingsColumn);
oldSettingsColumn.remove();
layout.lastElementChild.classList.add('pc-batch-section');
previewBox.classList.add('pc-editor-preview');
const $=s=>panel.querySelector(s); let styles=[],active='',busy=false,cancel=false,db,saveQueue=Promise.resolve();
let lastOutputDir='';let thumbnailMiddle=true;let thumbHeight=100/3,thumbCenter=50;try{thumbHeight=Math.min(100,Math.max(10,Number(localStorage.getItem('phone_cards_thumb_height'))||100/3));thumbCenter=Math.min(100,Math.max(0,Number(localStorage.getItem('phone_cards_thumb_center')??50)));}catch(_){}try{thumbnailMiddle=localStorage.getItem('phone_cards_middle_thumbnails')!=='false';}catch(_){}
function updateThumbnailCropControls(){
    $('[data-thumb-height]').value=thumbHeight;$('[data-thumb-center]').value=thumbCenter;
    $('[data-thumb-height-label]').textContent=`${thumbHeight.toFixed(1)}%`;$('[data-thumb-center-label]').textContent=`${thumbCenter.toFixed(1)}%`;
    panel.style.setProperty('--pc-thumb-aspect',`1080 / ${1920*thumbHeight/100}`);
}
updateThumbnailCropControls();
let cropTimer;
for(const key of ['height','center'])$(`[data-thumb-${key}]`).oninput=e=>{
    if(key==='height')thumbHeight=Number(e.target.value);else thumbCenter=Number(e.target.value);
    thumbnailMiddle=true;$('[data-middle-thumbs]').checked=true;panel.classList.add('pc-middle-thumbs');updateThumbnailCropControls();
    try{localStorage.setItem('phone_cards_thumb_height',String(thumbHeight));localStorage.setItem('phone_cards_thumb_center',String(thumbCenter));localStorage.setItem('phone_cards_middle_thumbnails','true');}catch(_){}
    clearTimeout(cropTimer);cropTimer=setTimeout(()=>refresh(),120);
};
$('[data-middle-thumbs]').checked=thumbnailMiddle;panel.classList.toggle('pc-middle-thumbs',thumbnailMiddle);
$('[data-middle-thumbs]').onchange=e=>{thumbnailMiddle=e.target.checked;panel.classList.toggle('pc-middle-thumbs',thumbnailMiddle);try{localStorage.setItem('phone_cards_middle_thumbnails',String(thumbnailMiddle));}catch(_){}refresh();};
const thumbControl=$('[data-thumb-size]');
function setThumbColumns(value){const columns=Math.min(8,Math.max(2,Number(value)||4));thumbControl.value=columns;$('[data-styles]').style.setProperty('--pc-template-columns',columns);$('[data-thumb-label]').textContent=`每行 ${columns} 张`;}
try{setThumbColumns(localStorage.getItem('phone_cards_thumbnail_columns')||4);}catch(_){setThumbColumns(4);}
thumbControl.oninput=()=>{setThumbColumns(thumbControl.value);try{localStorage.setItem('phone_cards_thumbnail_columns',thumbControl.value);}catch(_){}};
thumbControl.title='向左拖动放大缩略图，向右拖动显示更多模板';
function selectLibrary(mode){if(busy)return;for(const style of styles)style.selected=mode==='all'?true:mode==='none'?false:!style.selected;save();refresh();}
$('[data-select-all]').onclick=()=>selectLibrary('all');
$('[data-select-invert]').onclick=()=>selectLibrary('invert');
$('[data-select-none]').onclick=()=>selectLibrary('none');
async function removeLibraryStyles(all){
    if(busy)return;
    const removed=styles.filter(style=>all||style.selected);
    if(!removed.length){status('请先勾选要删除的样式。');return;}
    if(!confirm(all?`清空全部 ${removed.length} 个样式？建议先备份样式。`:`删除已勾选的 ${removed.length} 个样式？`))return;
    const ids=new Set(removed.map(style=>style.id));styles=styles.filter(style=>!ids.has(style.id));
    for(const row of tableRows)row.templateIds=(row.templateIds||[]).filter(id=>!ids.has(id));
    if(ids.has(active))active=styles[0]?.id||'';
    for(const style of removed)if(!styles.some(other=>other.src===style.src))images.delete(style.src);
    const ok=await save();refresh();
    if(!styles.length){const c=$('[data-canvas]');c.width=1080;c.height=1920;$('[data-filename]').textContent='请导入卡片底图';}
    if(ok)status(all?'样式库已清空。':`已删除 ${removed.length} 个样式。`);
}
$('[data-delete-selected]').onclick=()=>removeLibraryStyles(false);
$('[data-clear-library]').onclick=()=>removeLibraryStyles(true);

const images=new Map(); const current=()=>styles.find(s=>s.id===active);
const status=t=>{$('[data-status]').textContent=t;};
const req=r=>new Promise((resolve,reject)=>{r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
function save(){const snapshot=JSON.parse(JSON.stringify(styles));return saveQueue=saveQueue.then(async()=>{if(!db)throw new Error('样式存储不可用，请使用备份按钮保存样式');await new Promise((resolve,reject)=>{const tx=db.transaction('library','readwrite');tx.objectStore('library').put(snapshot,'styles');tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});}).then(()=>true).catch(e=>{status('保存失败：'+e.message);return false;});}
function download(blob,name){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);}
async function imageFor(style){if(!images.has(style.src)){const img=new Image();img.src=style.src;await img.decode();if(img.naturalWidth*img.naturalHeight>40000000)throw new Error('底图过大，请使用小于 4000 万像素的图片');images.set(style.src,img);}return images.get(style.src);}
let fontRegistration;
async function sharedFonts(){
    if(!root.getFontManager)return null;
    const manager=root.getFontManager();
    if(!fontRegistration)fontRegistration=manager._registered?Promise.resolve():manager.register();
    await fontRegistration;
    return manager;
}
function refreshFontPicker(){const select=$('[data-prop="font"]');if(root.getFontManager)root.getFontManager().refreshFontSelect(select,current()?.font||'Arial');const btn=select.parentElement.querySelector('.fp-btn');if(btn){btn.style.pointerEvents=busy||!current()?'none':'';btn.style.opacity=busy||!current()?'.5':'';}}
async function render(style,phone){phone=displayPhoneText(phone,style);const img=await imageFor(style);const fm=await sharedFonts();if(fm)await fm.ensureFontsLoaded([style.font]);await document.fonts.load(`${style.bold?'bold ':''}${style.size}px "${style.font.replace(/["\\]/g,'')}"`);const c=document.createElement('canvas');c.width=1080;c.height=1920;const ctx=c.getContext('2d');const rect=centeredCover(img.naturalWidth,img.naturalHeight);ctx.drawImage(img,rect.x,rect.y,rect.width,rect.height);let size=style.size;const font=()=>`${style.bold?'bold ':''}${size}px "${style.font.replace(/["\\]/g,'')}", sans-serif`;ctx.font=font();if(style.fit){const measured=Math.max(...phone.split(/\r\n|\n|\r/).map(line=>ctx.measureText(line).width)),available=c.width*style.width/100;if(measured>available){size=Math.max(1,size*available/measured);ctx.font=font();}}ctx.textAlign=style.align;ctx.textBaseline='middle';ctx.fillStyle=style.color;ctx.strokeStyle=style.stroke;ctx.lineWidth=style.strokeWidth;ctx.lineJoin='round';const x=c.width*style.x/100,y=c.height*style.y/100;const lines=phone.split(/\r\n|\n|\r/),lineHeight=size*(Number(style.lineSpacing)||120)/100;lines.forEach((line,i)=>{const lineY=y+(i-(lines.length-1)/2)*lineHeight;if(style.strokeWidth)ctx.strokeText(line,x,lineY);ctx.fillText(line,x,lineY);});return c;}
let tableRows=[['',''],['',''],['','']];let boardPhone=null,boardToken=0,boardTimer;
const board=document.createElement('section');board.className='pc-box pc-quick-board';board.innerHTML=`<h3>快速分配看板</h3><p class="pc-muted">先点击电话标签，再点下方卡片图片绑定；再点一次取消。与上方表格共用分配结果。</p><p data-board-summary></p><div class="pc-board-tools"><label>每行分配 <input data-random-count type="number" min="1" value="2" style="width:65px"> 个模板</label><label>分配范围 <select data-random-target><option value="all">所有电话</option><option value="unassigned">仅未分配电话</option><option value="current">当前电话</option></select></label><button data-random-assign>使用上方勾选模板随机分配</button></div><p class="pc-muted">不同电话可重复使用模板，同一电话内不重复。重新随机分配会替换范围内原来的绑定。</p><div class="pc-board-tools"><label><input type="checkbox" data-board-unassigned>只看未分配电话</label><label><input type="checkbox" data-board-unused>只看未使用模板</label><button data-board-all>当前电话全选模板</button><button data-board-none>清空当前电话绑定</button></div><h4>① 点击要分配的电话</h4><div data-board-phones class="pc-board-phones"></div><h4 data-board-current>② 点击卡片模板分配</h4><div data-board-current-bindings class="pc-board-current-bindings"></div><div data-board-templates class="pc-board-templates"></div>`;
$('[data-rows]').closest('.pc-box').after(board);
$('[data-board-unassigned]').onchange=()=>refreshBoard();$('[data-board-unused]').onchange=()=>refreshBoard();
$('[data-board-all]').onclick=()=>{if(!busy&&boardPhone){boardPhone.templateIds=styles.map(s=>s.id);syncBoardAssignment();}};
$('[data-board-none]').onclick=()=>{if(!busy&&boardPhone){boardPhone.templateIds=[];syncBoardAssignment();}};
$('[data-random-assign]').onclick=()=>{
    if(busy)return;
    try{
        const ids=styles.filter(style=>style.selected).map(style=>style.id),count=Number($('[data-random-count]').value),target=$('[data-random-target]').value;
        if(!ids.length)throw new Error('请先在上方模板库勾选参与随机分配的模板');
        if(!Number.isInteger(count)||count<1||count>ids.length)throw new Error(`每行数量应为 1～${ids.length}，同一电话内模板不能重复`);
        const valid=new Set(styles.map(style=>style.id));
        const targets=tableRows.filter(row=>row[0].trim()&&(target==='all'||target==='current'&&row===boardPhone||target==='unassigned'&&!(row.templateIds||[]).some(id=>valid.has(id))));
        if(!targets.length)throw new Error('当前范围内没有可分配的电话');
        for(const row of targets)row.templateIds=randomTemplateIds(ids,count);
        syncBoardAssignment();status(`已随机分配 ${targets.length} 行电话，每行 ${count} 个模板，共 ${targets.length*count} 张卡片。`);
    }catch(e){status(e.message);}
};

function rows(){return tableRows.flatMap((row,index)=>{if(row[0]===''&&row[1]==='')return [];return rowsFromCells([row]).map(data=>({...data,rowIndex:index,templateIds:row.templateIds||[]}));});}
let openTemplateRow=null,tableToken=0,galleryToken=0,galleryTimer;
function thumbnail(canvas,width=420){const small=document.createElement('canvas');const sourceHeight=thumbnailMiddle?canvas.height*thumbHeight/100:canvas.height,sourceY=thumbnailMiddle?Math.max(0,Math.min(canvas.height-sourceHeight,canvas.height*thumbCenter/100-sourceHeight/2)):0;small.width=Math.min(width,canvas.width);small.height=Math.max(1,Math.round(sourceHeight*small.width/canvas.width));small.getContext('2d').drawImage(canvas,0,sourceY,canvas.width,sourceHeight,0,0,small.width,small.height);return small.toDataURL('image/png');}
function renderTable(focusRow,focusCol=0){
    const body=$('[data-rows]'),scroller=body.closest('.pc-table-wrap'),oldScroll=scroller.scrollTop;body.replaceChildren();const token=++tableToken;
    tableRows.forEach((row,index)=>{
        const tr=document.createElement('tr'),number=document.createElement('td');number.textContent=index+1;tr.append(number);
        row.forEach((value,col)=>{const td=document.createElement('td'),input=document.createElement('textarea');input.rows=Math.max(2,Math.min(6,value.split(/\r\n|\n|\r/).length));input.value=value;input.dataset.row=index;input.dataset.col=col;input.setAttribute('aria-label',`第 ${index+1} 行${col===0?'电话文字':'输出名字前缀'}`);input.placeholder=index===0?(col===0?'+49 123456':'德国咨询_'):'';input.disabled=busy;
            input.oninput=()=>{tableRows[index][col]=input.value;updateRows();};
            input.onpaste=e=>{
                const text=e.clipboardData.getData('text/plain'),html=e.clipboardData.getData('text/html');
                const doc=html?new DOMParser().parseFromString(html,'text/html'):null;
                const table=doc?.querySelector('table');
                if(!table&&!/[\t\r\n]/.test(text))return;
                e.preventDefault();let cells;
                try{
                    if(table){
                        function cellText(node){if(node.nodeType===3)return node.nodeValue;if(node.nodeName==='BR')return '\n';let result='';for(const child of node.childNodes)result+=cellText(child);return result;}
                        cells=Array.from(table.rows,tr=>Array.from(tr.cells,td=>cellText(td)));
                    }else cells=parseClipboardCells(text);
                }catch(error){status(error.message);return;}
                if(cells.some(values=>values.length+col>2)){status('表格只有两列，请从电话文字列开始粘贴电话和前缀。');return;}
                cells.forEach((values,offset)=>{while(tableRows.length<=index+offset)tableRows.push(['','']);values.forEach((v,c)=>tableRows[index+offset][col+c]=v);});
                const targetRow=tableRows[index];tableRows=compactEmptyRows(tableRows);if(!tableRows.length)tableRows.push(['','']);openTemplateRow=null;renderTable(Math.max(0,tableRows.indexOf(targetRow)),col);updateRows();status(`已粘贴并自动去除空行。`);
            };
            td.append(input);tr.append(td);
        });
        const templates=document.createElement('td'),choose=document.createElement('button'),thumbs=document.createElement('div');
        const selected=styles.filter(s=>(row.templateIds||[]).includes(s.id));
        choose.textContent=`选择卡片模板（已选 ${selected.length}）`;choose.disabled=busy;choose.setAttribute('aria-label',`第 ${index+1} 行选择卡片模板`);choose.onclick=()=>{
            const rowTop=tr.getBoundingClientRect().top,outer=[];
            for(let parent=scroller.parentElement;parent;parent=parent.parentElement)if(parent.scrollHeight>parent.clientHeight)outer.push([parent,parent.scrollTop]);
            const closing=openTemplateRow===index;
            body.querySelectorAll('[data-template-expanded]').forEach(node=>node.remove());
            openTemplateRow=closing?null:index;
            if(!closing)tr.after(buildExpanded());
            scroller.scrollTop+=tr.getBoundingClientRect().top-rowTop;
            for(const [parent,top] of outer)parent.scrollTop=top;
        };
        thumbs.className='pc-selected-thumbs';templates.append(choose,thumbs);tr.append(templates);
        for(const style of selected){const img=document.createElement('img');img.dataset.templateId=style.id;img.dataset.phoneRow=index;img.title=style.name;img.alt=style.name;img.className='pc-checker';thumbs.append(img);render(cardStyle(style,row),row[0]||samplePhone(style)).then(c=>{if(token===tableToken)img.src=thumbnail(c,180);}).catch(e=>status(e.message));}
        const actions=document.createElement('td'),del=document.createElement('button');del.textContent='删除';del.disabled=busy;del.setAttribute('aria-label',`删除第 ${index+1} 行`);del.onclick=()=>{tableRows.splice(index,1);openTemplateRow=null;if(!tableRows.length)tableRows.push(['','']);renderTable();updateRows();};actions.append(del);tr.append(actions);body.append(tr);
        function buildExpanded(){
            const expanded=document.createElement('tr'),cell=document.createElement('td'),grid=document.createElement('div');expanded.dataset.templateExpanded=index;cell.colSpan=5;grid.className='pc-template-grid';
            if(!styles.length)grid.textContent='请先导入图片并保存电话卡片模板。';
            for(const style of styles){
                const tile=document.createElement('label'),check=document.createElement('input'),img=document.createElement('img'),title=document.createElement('span');tile.className='pc-template-tile'+((row.templateIds||[]).includes(style.id)?' selected':'');check.type='checkbox';check.checked=(row.templateIds||[]).includes(style.id);check.disabled=busy;check.setAttribute('aria-label',`第 ${index+1} 行选择 ${style.name}`);img.dataset.templateId=style.id;img.dataset.phoneRow=index;img.className='pc-checker';img.alt=style.name;title.textContent=style.name;
                check.onchange=()=>{const ids=new Set(row.templateIds||[]);if(check.checked)ids.add(style.id);else ids.delete(style.id);row.templateIds=[...ids];tile.classList.toggle('selected',check.checked);
                    choose.textContent=`选择卡片模板（已选 ${row.templateIds.length}）`;
                    thumbs.replaceChildren();
                    for(const selectedStyle of styles.filter(v=>ids.has(v.id))){const selectedImg=document.createElement('img');selectedImg.dataset.templateId=selectedStyle.id;selectedImg.dataset.phoneRow=index;selectedImg.alt=selectedStyle.name;selectedImg.title=selectedStyle.name;selectedImg.className='pc-checker';thumbs.append(selectedImg);render(cardStyle(selectedStyle,row),row[0]||samplePhone(selectedStyle)).then(c=>{if(selectedImg.isConnected)selectedImg.src=thumbnail(c,180);}).catch(e=>status(e.message));}
                    updateRows();};
                tile.append(img,check,title);grid.append(tile);render(cardStyle(style,row),row[0]||samplePhone(style)).then(c=>{if(token===tableToken)img.src=thumbnail(c);}).catch(e=>status(e.message));
            }
            cell.append(grid);expanded.append(cell);return expanded;
        }
        if(openTemplateRow===index)body.append(buildExpanded());
    });
    scroller.scrollTop=oldScroll;
    if(focusRow!==undefined)body.querySelector(`textarea[data-row="${focusRow}"][data-col="${focusCol}"]`)?.focus();
}
$('[data-add-row]').onclick=()=>{tableRows.push(['','']);renderTable(tableRows.length-1);updateRows();};
$('[data-clear-rows]').onclick=()=>{if(tableRows.some(row=>row.some(Boolean))&&!confirm('清空全部电话和名字前缀？'))return;tableRows=[['',''],['',''],['','']];openTemplateRow=null;renderTable(0);updateRows();};
renderTable();
let previewToken=0;
async function preview(){const token=++previewToken,s=current();if(!s)return;try{const data=rows(),row=$('[data-preview-row]').value==='virtual'?null:(data[Number($('[data-preview-row]').value)]||data[0]),c=await render(s,row?.phone||samplePhone(s));if(token!==previewToken)return;const target=$('[data-canvas]');target.width=c.width;target.height=c.height;target.getContext('2d').drawImage(c,0,0);$('[data-filename]').textContent=row?`输出名字：${row.name}`:'当前显示虚拟电话，仅用于设置模板位置和样式';}catch(e){status(e.message);}}
function updateRows(){try{const data=rows(),select=$('[data-preview-row]'),old=select.value;const virtual=document.createElement('option');virtual.value='virtual';virtual.textContent='虚拟电话（设置模板用）';select.replaceChildren(virtual,...data.map((r,i)=>{const o=document.createElement('option');o.value=i;o.textContent=`${i+1}. ${r.phone}`;return o;}));if([...select.options].some(o=>o.value===old))select.value=old;$('[data-count]').textContent=`${data.length} 行电话，已选 ${data.reduce((n,r)=>n+r.templateIds.filter(id=>styles.some(s=>s.id===id)).length,0)} 张透明 PNG`;preview();scheduleGallery();}catch(e){$('[data-count]').textContent=e.message;++galleryToken;$('[data-gallery]').replaceChildren();}}
function refresh(){$('[data-library-selected]').textContent=`已选 ${styles.filter(s=>s.selected).length} / ${styles.length} 个模板`;const list=$('[data-styles]');list.replaceChildren();for(const s of styles){const div=document.createElement('div');div.className='pc-style'+(s.id===active?' active':'');const check=document.createElement('input');check.type='checkbox';check.checked=s.selected;check.disabled=busy;check.onchange=()=>{s.selected=check.checked;$('[data-library-selected]').textContent=`已选 ${styles.filter(s=>s.selected).length} / ${styles.length} 个模板`;save();updateRows();};const img=document.createElement('img');img.className='pc-checker';img.alt=s.name;img.onclick=()=>{if(!busy){active=s.id;refresh();}};render(s,samplePhone(s)).then(c=>{if(img.isConnected)img.src=thumbnail(c);}).catch(e=>status(e.message));const button=document.createElement('button');button.textContent=s.name;button.disabled=busy;button.onclick=()=>{active=s.id;refresh();};div.append(check,img,button);list.append(div);}const s=current();panel.querySelectorAll('[data-prop]').forEach(input=>{input.disabled=!s||busy;if(s){if(input.type==='checkbox')input.checked=s[input.dataset.prop];else input.value=s[input.dataset.prop]??(input.dataset.prop==='phoneLines'?1:input.dataset.prop==='lineSpacing'?120:'');}});refreshFontPicker();renderTable();updateRows();}
function defaults(src,name){return{id:crypto.randomUUID(),src,name,selected:true,phoneLines:1,lineSpacing:120,font:'Arial',size:64,color:'#ffffff',x:50,y:50,width:85,align:'center',bold:true,stroke:'#000000',strokeWidth:0,fit:true};}
$('[data-import]').onclick=()=>$('[data-files]').click();
async function importImages(files){
    if(busy)return;
    const candidates=Array.from(files).filter(file=>/\.(png|webp)$/i.test(file.name)||/^image\/(png|webp)$/.test(file.type));
    if(!candidates.length){status('请拖入 PNG 或 WebP 图片文件。');return;}
    setBusy(true);let imported=0;const errors=[];
    try{
        for(const file of candidates){
            try{
                const src=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(r.error);r.readAsDataURL(file);});
                const s=defaults(src,file.name.replace(/\.[^.]+$/,''));await imageFor(s);styles.push(s);active=s.id;imported++;
            }catch(e){errors.push(`${file.name}：${e.message}`);}
        }
        save();
        status(`已导入 ${imported} 张底图${files.length>candidates.length?`，跳过 ${files.length-candidates.length} 个非 PNG / WebP 文件`:''}。${errors.length?'导入失败：'+errors.join('；'):'可以逐张设置电话位置和样式。'}`);
    }finally{setBusy(false);}
}
$('[data-files]').onchange=async e=>{const files=Array.from(e.target.files);e.target.value='';await importImages(files);};
const dropZone=$('[data-image-drop]');let dragDepth=0;
function isFileDrag(e){return Array.from(e.dataTransfer?.types||[]).includes('Files');}
panel.addEventListener('dragover',e=>{if(isFileDrag(e)){e.preventDefault();e.dataTransfer.dropEffect=busy?'none':'copy';}});
panel.addEventListener('drop',e=>{if(isFileDrag(e)){e.preventDefault();dragDepth=0;dropZone.classList.remove('pc-dragover');if(!busy)void importImages(Array.from(e.dataTransfer.files));}});
dropZone.addEventListener('dragenter',e=>{if(isFileDrag(e)){e.preventDefault();dragDepth++;if(!busy)dropZone.classList.add('pc-dragover');}});
dropZone.addEventListener('dragleave',()=>{dragDepth=Math.max(0,dragDepth-1);if(!dragDepth)dropZone.classList.remove('pc-dragover');});
panel.querySelectorAll('[data-prop]').forEach(input=>input.oninput=()=>{const s=current();if(!s)return;const key=input.dataset.prop;if(input.type==='number'){if(input.value===''||!Number.isFinite(input.valueAsNumber))return;s[key]=Math.min(Number(input.max),Math.max(Number(input.min),input.valueAsNumber));}else s[key]=input.type==='checkbox'?input.checked:input.value;if(key==='name'){const buttons=$('[data-styles]').querySelectorAll('button');styles.forEach((v,i)=>buttons[i].textContent=v.name);}save();preview();scheduleGallery();});
// Scrub numeric settings by holding the mouse on the label or number field.
panel.querySelectorAll('[data-prop][type="number"]').forEach(input=>{
    const field=input.closest('.pc-field');
    field.classList.add('pc-scrub-field');
    input.title='按住鼠标左右拖动调整；按住 Shift 精细调整；也可直接输入';
    field.title=input.title;
    let scrub=null,suppressClick=false;
    field.addEventListener('pointerdown',e=>{
        if(e.button!==0||input.disabled)return;
        scrub={id:e.pointerId,x:e.clientX,value:Number(input.value),active:false};
        suppressClick=false;
    });
    field.addEventListener('pointermove',e=>{
        if(!scrub||e.pointerId!==scrub.id)return;
        const delta=e.clientX-scrub.x;
        if(!scrub.active&&Math.abs(delta)<4)return;
        if(!scrub.active){scrub.active=true;field.setPointerCapture(e.pointerId);field.classList.add('pc-scrubbing');input.blur();}
        e.preventDefault();
        const unit=['x','y','width'].includes(input.dataset.prop)?0.1:1;
        const value=Math.min(Number(input.max),Math.max(Number(input.min),scrub.value+delta*unit*(e.shiftKey?0.1:1)));
        input.value=String(Math.round(value*100)/100);
        input.dispatchEvent(new Event('input',{bubbles:true}));
    });
    const finish=e=>{
        if(!scrub||e.pointerId!==scrub.id)return;
        suppressClick=scrub.active;
        if(field.hasPointerCapture(e.pointerId))field.releasePointerCapture(e.pointerId);
        field.classList.remove('pc-scrubbing');scrub=null;
        if(suppressClick){renderTable();scheduleGallery();}
    };
    field.addEventListener('pointerup',finish);
    field.addEventListener('pointercancel',finish);
    field.addEventListener('lostpointercapture',()=>{field.classList.remove('pc-scrubbing');scrub=null;});
    field.addEventListener('pointerleave',()=>{if(scrub&&!scrub.active)scrub=null;});
    field.addEventListener('click',e=>{if(suppressClick){e.preventDefault();e.stopPropagation();suppressClick=false;}},true);
});
const fontSelect=$('[data-prop="font"]');fontSelect.onchange=()=>{if(!busy&&current()){fontSelect.oninput();refreshFontPicker();}};
$('[data-preview-row]').onchange=preview;
let dragging=false;const canvas=$('[data-canvas]');function position(e){const s=current();if(!s||busy)return;const r=canvas.getBoundingClientRect();s.x=Math.max(0,Math.min(100,(e.clientX-r.left)/r.width*100));s.y=Math.max(0,Math.min(100,(e.clientY-r.top)/r.height*100));for(const key of ['x','y'])$(`[data-prop="${key}"]`).value=current()[key].toFixed(1);preview();}canvas.onpointerdown=e=>{dragging=true;canvas.setPointerCapture(e.pointerId);position(e);};canvas.onpointermove=e=>{if(dragging)position(e);};canvas.onpointerup=()=>{dragging=false;save();renderTable();scheduleGallery();};canvas.onpointercancel=()=>{dragging=false;save();};
$('[data-save-template]').onclick=async()=>{const s=current();if(!s)return;const ok=await save();if(ok){refresh();status(`电话卡片模板「${s.name}」已保存。`);}};
$('[data-save-copy]').onclick=async()=>{
    const s=current();if(!s||busy)return;
    const name=prompt('新模板名字（原模板会保留）',s.name+'副本');if(name===null||!name.trim())return;
    if(styles.some(style=>style.name===name.trim())){status('模板名字已存在，请换一个名字。');return;}
    const copy={...s,id:crypto.randomUUID(),name:name.trim()};styles.push(copy);active=copy.id;
    const ok=await save();refresh();if(ok)status(`已另存为「${copy.name}」，原模板「${s.name}」保留。`);
};
$('[data-copy]').onclick=()=>{const s=current();if(!s)return;const {id,src,name,selected,...settings}=s;for(const other of styles.filter(v=>v.selected))Object.assign(other,settings);save();refresh();status('已应用文字设置到勾选样式。');};
$('[data-delete]').onclick=()=>{const s=current();if(!s||!confirm(`删除样式「${s.name}」？`))return;styles=styles.filter(v=>v!==s);images.delete(s.src);active=styles[0]?.id||'';save();refresh();if(!styles.length){canvas.width=1080;canvas.height=1920;}};
$('[data-backup]').onclick=()=>download(new Blob([JSON.stringify({format:'videokit-phone-card-styles',version:1,styles})],{type:'application/json'}),'电话卡片样式备份.json');
$('[data-restore]').onclick=()=>$('[data-backup-file]').click();
$('[data-backup-file]').onchange=async e=>{try{const file=e.target.files[0];if(!file)return;const value=JSON.parse(await file.text());if(value.format!=='videokit-phone-card-styles'||!Array.isArray(value.styles))throw new Error('不是电话卡片样式备份');const incoming=[];for(const item of value.styles){if(!/^data:image\/(png|webp);base64,/.test(item.src)||typeof item.name!=='string')throw new Error('备份图片或样式无效');const s=defaults(item.src,item.name);for(const k of ['size','x','y','width','strokeWidth']){if(typeof item[k]!=='number'||!Number.isFinite(item[k]))throw new Error('备份文字设置无效');s[k]=item[k];}if(s.size<1||s.size>2000||s.x<0||s.x>100||s.y<0||s.y>100||s.width<1||s.width>100||s.strokeWidth<0||s.strokeWidth>50)throw new Error('备份文字设置超出范围');for(const k of ['color','stroke']){if(!/^#[0-9a-f]{6}$/i.test(item[k]))throw new Error('备份颜色无效');s[k]=item[k];}if(!['left','center','right'].includes(item.align)||typeof item.font!=='string')throw new Error('备份字体设置无效');Object.assign(s,{phoneLines:item.phoneLines==='inline'?'inline':Number(item.phoneLines)===2?2:1,lineSpacing:Number.isFinite(item.lineSpacing)?Math.min(300,Math.max(60,item.lineSpacing)):120,font:item.font,align:item.align,bold:!!item.bold,fit:!!item.fit,selected:true});await imageFor(s);incoming.push(s);}styles.push(...incoming);active=incoming[0]?.id||active;save();refresh();status(`已导入 ${incoming.length} 个样式。`);}catch(err){status('导入失败：'+err.message);}finally{e.target.value='';}};
function plan(){
    const data=rows(),jobs=buildJobs(data,styles),chosen=[...new Set(jobs.map(job=>job.style))];
    for(const row of data){if(new TextEncoder().encode(row.name).length>240)throw new Error('输出文件名过长，请缩短名字前缀');}
    return{data,chosen,jobs};
}
function removeBinding(source,id){
    if(busy)return;source.templateIds=(source.templateIds||[]).filter(value=>value!==id);
    if(source.colorOverrides)delete source.colorOverrides[id];if(source.sizeOverrides)delete source.sizeOverrides[id];if(source.positionOverrides)delete source.positionOverrides[id];syncBoardAssignment();
}
function replaceBinding(source,id){
    if(busy)return;
    const candidates=styles.filter(style=>style.id!==id&&!(source.templateIds||[]).includes(style.id));
    if(!candidates.length){status('没有其他可替换模板，请先导入更多模板。');return;}
    const modal=document.createElement('div');modal.className='pc-replace-modal';
    const box=document.createElement('div');box.className='pc-replace-box';const heading=document.createElement('h3');heading.textContent='选择替换模板（已绑定模板不会重复出现）';
    const close=document.createElement('button');close.textContent='取消';close.onclick=()=>modal.remove();const grid=document.createElement('div');grid.className='pc-template-grid';box.append(heading,close,grid);modal.append(box);panel.append(modal);
    modal.onclick=e=>{if(e.target===modal)modal.remove();};
    for(const style of candidates){const button=document.createElement('button'),img=document.createElement('img'),name=document.createElement('span');button.className='pc-template-tile';img.className='pc-checker';img.alt=style.name;name.textContent=style.name;button.append(img,name);grid.append(button);render(cardStyle(style,source),source[0]).then(c=>{if(img.isConnected)img.src=thumbnail(c);}).catch(e=>status(e.message));
        button.onclick=()=>{if(!(source.templateIds||[]).includes(id)){modal.remove();return;}source.templateIds=source.templateIds.map(value=>value===id?style.id:value);if(source.colorOverrides)delete source.colorOverrides[id];if(source.sizeOverrides)delete source.sizeOverrides[id];if(source.positionOverrides)delete source.positionOverrides[id];modal.remove();syncBoardAssignment();};
    }
}
function syncBoardAssignment(){
    const outer=[];for(let parent=board.parentElement;parent;parent=parent.parentElement)if(parent.scrollHeight>parent.clientHeight)outer.push([parent,parent.scrollTop]);
    renderTable();updateRows();refreshBoard();for(const [parent,top] of outer)parent.scrollTop=top;
}
function scheduleBoard(){++boardToken;clearTimeout(boardTimer);boardTimer=setTimeout(()=>refreshBoard(),180);}
function refreshBoard(){
    const token=++boardToken,phones=$('[data-board-phones]'),templates=$('[data-board-templates]'),phoneScroll=phones.scrollTop,templateScroll=templates.scrollTop;
    const data=tableRows.flatMap((source,rowIndex)=>source[0].trim()?[{phone:source[0],prefix:source[1],rowIndex,source,templateIds:source.templateIds||[]}]:[]);
    if(!data.some(row=>row.source===boardPhone))boardPhone=data[0]?.source||null;
    const stats=bindingStats(data,styles),currentRow=data.find(row=>row.source===boardPhone);
    $('[data-board-summary]').textContent=`${data.length} 行电话 · 未分配 ${stats.unassigned} 行 · 使用 ${[...stats.usage.values()].filter(v=>v.length).length} / ${styles.length} 个模板 · 共 ${stats.total} 张成品`;
    $('[data-board-current]').textContent=currentRow?`② 为第 ${currentRow.rowIndex+1} 行分配模板：${currentRow.prefix||currentRow.phone}`:'② 请先在表格中填写电话';
    phones.replaceChildren();templates.replaceChildren();
    const currentBindings=$('[data-board-current-bindings]');currentBindings.replaceChildren();
    if(currentRow)for(const style of styles.filter(style=>(boardPhone.templateIds||[]).includes(style.id))){const item=document.createElement('div'),img=document.createElement('img'),name=document.createElement('span'),remove=document.createElement('button'),swap=document.createElement('button');img.className='pc-checker';img.alt=style.name;name.textContent=style.name;remove.textContent='删除绑定';swap.textContent='换模板';remove.disabled=swap.disabled=busy;remove.onclick=()=>removeBinding(boardPhone,style.id);swap.onclick=()=>replaceBinding(boardPhone,style.id);item.append(img,name,swap,remove);currentBindings.append(item);render(cardStyle(style,boardPhone),currentRow.phone).then(c=>{if(token===boardToken&&img.isConnected)img.src=thumbnail(c,240);}).catch(e=>status(e.message));}

    if(!data.length)phones.textContent='请先在上方表格粘贴电话和名字前缀。';
    for(const row of data){
        const chosen=styles.filter(style=>row.templateIds.includes(style.id));if($('[data-board-unassigned]').checked&&chosen.length)continue;
        const button=document.createElement('button');button.className='pc-phone-tag'+(row.source===boardPhone?' active':'');button.disabled=busy;button.setAttribute('aria-label',`快速选择第 ${row.rowIndex+1} 行电话`);
        const title=document.createElement('strong'),text=document.createElement('span'),count=document.createElement('span'),thumbs=document.createElement('div');
        title.textContent=`第 ${row.rowIndex+1} 行 · ${row.prefix||'未填写前缀'}`;text.textContent=row.phone;text.className='pc-phone-content';count.textContent=`已绑定 ${chosen.length} 个模板`;thumbs.className='pc-board-bound-thumbs';
        for(const style of chosen){const item=document.createElement('figure'),img=document.createElement('img'),name=document.createElement('figcaption');img.alt=style.name;img.className='pc-checker';name.textContent=style.name;item.append(img,name);thumbs.append(item);render(cardStyle(style,row.source),row.phone).then(c=>{if(token===boardToken&&img.isConnected)img.src=thumbnail(c,220);}).catch(e=>status(e.message));}
        button.append(title,text,count,thumbs);button.onclick=()=>{boardPhone=row.source;refreshBoard();};phones.append(button);
    }
    if(!styles.length)templates.textContent='请先导入并设置卡片模板。';
    templates.style.setProperty('--pc-board-columns',thumbControl.value||4);
    for(const style of styles){
        const bound=stats.usage.get(style.id)||[];if($('[data-board-unused]').checked&&bound.length)continue;
        const selected=!!boardPhone?.templateIds?.includes(style.id),tile=document.createElement('div'),button=document.createElement('button'),img=document.createElement('img'),name=document.createElement('span'),details=document.createElement('details'),summary=document.createElement('summary');
        tile.className='pc-board-template'+(selected?' selected':'');button.className='pc-board-template-pick';button.disabled=busy||!boardPhone;button.setAttribute('aria-label',`${selected?'取消绑定':'绑定'}模板 ${style.name}`);
        img.className='pc-checker';img.alt=style.name;name.textContent=`${selected?'✓ 已绑定 · ':''}${style.name}`;button.append(img,name);
        const phone=boardPhone?.[0]||samplePhone(style);render(cardStyle(style,boardPhone),phone).then(c=>{if(token===boardToken&&img.isConnected)img.src=thumbnail(c);}).catch(e=>status(e.message));
        button.onclick=()=>{if(!boardPhone||busy)return;const ids=new Set(boardPhone.templateIds||[]);if(ids.has(style.id))ids.delete(style.id);else ids.add(style.id);boardPhone.templateIds=[...ids];syncBoardAssignment();};
        summary.textContent=`绑定 ${bound.length} 行电话 · 查看明细`;details.append(summary);
        if(!bound.length){const empty=document.createElement('p');empty.textContent='尚未绑定电话';details.append(empty);}
        for(const row of bound){const link=document.createElement('button');link.className='pc-bound-phone-link';link.textContent=`第 ${row.rowIndex+1} 行 · ${row.prefix}\n${row.phone}`;link.disabled=busy;link.onclick=()=>{boardPhone=row.source;refreshBoard();};details.append(link);}
        tile.append(button,details);templates.append(tile);
    }
    phones.scrollTop=phoneScroll;templates.scrollTop=templateScroll;
}
function scheduleGallery(){scheduleBoard();++galleryToken;clearTimeout(galleryTimer);galleryTimer=setTimeout(()=>{if(!busy)void displayGallery();},250);}
function scrubCardNumber(input,unit){
    input.classList.add('pc-scrub-number');input.title='按住鼠标左右拖动；Shift 精细调整；也可直接输入';let drag=null,suppressClick=false;
    input.addEventListener('pointerdown',e=>{if(e.button!==0||input.disabled)return;drag={id:e.pointerId,x:e.clientX,value:Number(input.value),active:false};suppressClick=false;});
    input.addEventListener('pointermove',e=>{if(!drag||drag.id!==e.pointerId)return;const delta=e.clientX-drag.x;if(!drag.active&&Math.abs(delta)<4)return;if(!drag.active){drag.active=true;input.setPointerCapture(e.pointerId);input.blur();}e.preventDefault();input.value=Math.round(Math.max(Number(input.min),Math.min(Number(input.max),drag.value+delta*unit*(e.shiftKey?.1:1)))*100)/100;input.dispatchEvent(new Event('input',{bubbles:true}));});
    const finish=e=>{if(!drag||drag.id!==e.pointerId)return;suppressClick=drag.active;drag=null;if(input.hasPointerCapture(e.pointerId))input.releasePointerCapture(e.pointerId);};
    input.addEventListener('pointerup',finish);input.addEventListener('pointercancel',finish);input.addEventListener('lostpointercapture',()=>{drag=null;});input.addEventListener('pointerleave',()=>{if(drag&&!drag.active)drag=null;});input.addEventListener('click',e=>{if(suppressClick){e.preventDefault();suppressClick=false;}},true);
}
async function displayGallery(){
    const token=++galleryToken,container=$('[data-gallery]');container.replaceChildren();
    for(const img of panel.querySelectorAll('img[data-template-id]')){const style=styles.find(s=>s.id===img.dataset.templateId),row=tableRows[Number(img.dataset.phoneRow)];if(style&&row)render(cardStyle(style,row),row[0]||samplePhone(style)).then(c=>{if(token===galleryToken&&img.isConnected)img.src=thumbnail(c);}).catch(e=>status(e.message));}
    let data;try{data=rows();}catch(e){status(e.message);return;}
    const ready=data.filter(row=>row.templateIds.length&&row.templateIds.every(id=>styles.some(s=>s.id===id)));
    if(!ready.length)return;
    for(const {row,style,name} of buildJobs(ready,styles)){
        try{const source=tableRows[row.rowIndex];const canvas=await render(cardStyle(style,source),row.phone);if(token!==galleryToken)return;const f=document.createElement('figure'),img=document.createElement('img'),caption=document.createElement('figcaption');img.src=thumbnail(canvas);img.className='pc-checker';caption.textContent=`第 ${row.rowIndex+1} 行 · ${style.name} / ${name}`;const controls=document.createElement('div'),sizeInput=document.createElement('input'),reset=document.createElement('button');
            controls.className='pc-card-size';controls.append(document.createTextNode('单独字号 '));sizeInput.type='number';sizeInput.min=1;sizeInput.max=2000;sizeInput.step=.1;sizeInput.value=cardStyle(style,source).size;sizeInput.setAttribute('aria-label',`第 ${row.rowIndex+1} 行 ${style.name} 单独字号`);sizeInput.disabled=busy;
            let sizeToken=0;
            const redraw=async()=>{const t=++sizeToken;try{const c=await render(cardStyle(style,source),row.phone);if(t===sizeToken&&img.isConnected)img.src=thumbnail(c);}catch(e){status(e.message);}scheduleBoard();};
            sizeInput.oninput=()=>{if(busy||sizeInput.value===''||!Number.isFinite(sizeInput.valueAsNumber))return;source.sizeOverrides||={};source.sizeOverrides[style.id]=Math.max(1,Math.min(2000,sizeInput.valueAsNumber));void redraw();};
            scrubCardNumber(sizeInput,1);reset.textContent='恢复模板';reset.disabled=busy;controls.append(sizeInput,reset);
            const positionInputs={},positions=document.createElement('div');positions.className='pc-card-positions';
            for(const key of ['x','y']){const label=document.createElement('label'),input=document.createElement('input');label.className='pc-card-size';label.append(document.createTextNode(key==='x'?'水平位置 % ':'垂直位置 % '));input.type='number';input.min=0;input.max=100;input.step=.1;input.value=cardStyle(style,source)[key];input.disabled=busy;input.setAttribute('aria-label',`第 ${row.rowIndex+1} 行 ${style.name} ${key==='x'?'水平':'垂直'}位置`);
                input.oninput=()=>{if(busy||input.value===''||!Number.isFinite(input.valueAsNumber))return;source.positionOverrides||={};source.positionOverrides[style.id]||={};source.positionOverrides[style.id][key]=Math.max(0,Math.min(100,input.valueAsNumber));void redraw();};scrubCardNumber(input,.1);positionInputs[key]=input;label.append(input);positions.append(label);}
            const colorLabel=document.createElement('label'),colorInput=document.createElement('input');colorLabel.className='pc-card-size';colorLabel.append(document.createTextNode('文字颜色 '));colorInput.type='color';colorInput.value=cardStyle(style,source).color;colorInput.disabled=busy;colorInput.setAttribute('aria-label',`第 ${row.rowIndex+1} 行 ${style.name} 文字颜色`);colorInput.oninput=()=>{if(busy)return;source.colorOverrides||={};source.colorOverrides[style.id]=colorInput.value;void redraw();};colorLabel.append(colorInput);positions.append(colorLabel);
            reset.onclick=()=>{if(busy)return;for(const key of ['sizeOverrides','positionOverrides','colorOverrides'])if(source[key])delete source[key][style.id];for(const key of ['x','y'])positionInputs[key].value=style[key];sizeInput.value=style.size;colorInput.value=style.color;void redraw();};
            const actions=document.createElement('div'),remove=document.createElement('button'),swap=document.createElement('button');remove.textContent='删除这张卡片';swap.textContent='换模板';remove.disabled=swap.disabled=busy;remove.onclick=()=>removeBinding(source,style.id);swap.onclick=()=>replaceBinding(source,style.id);actions.append(swap,remove);
            f.append(img,caption,actions,controls,positions);container.append(f);await new Promise(resolve=>setTimeout(resolve,0));}catch(e){if(token===galleryToken)status(e.message);}
    }
}
function setBusy(value){busy=value;panel.querySelectorAll('button,input,textarea,select').forEach(el=>el.disabled=value);$('[data-cancel]').hidden=!value;$('[data-cancel]').disabled=false;if(!value)refresh();}
$('[data-cancel]').onclick=()=>{cancel=true;};
$('[data-choose-output]').onclick=async()=>{try{if(!root.electronAPI?.selectDirectory)throw new Error('请在桌面版中选择输出目录');const dir=await root.electronAPI.selectDirectory();if(dir){$('[data-output-dir]').value=dir;localStorage.setItem('phone_cards_output_dir',dir);}}catch(e){status(e.message);}};
$('[data-open-output]').onclick=async()=>{try{if(lastOutputDir)await root.electronAPI.apiCall('file/open-folder',{path:lastOutputDir});}catch(e){status('打开输出文件夹失败：'+e.message);}};
async function generate(exporting){
    if(busy)return;
    let p;
    try{p=plan();if(exporting)for(const row of p.data)validateRows([row]);if(exporting&&!root.electronAPI?.savePngFrame)throw new Error('请在桌面版中直接导出透明 PNG 到文件夹');}catch(e){status(e.message);return;}
    if(!exporting){await displayGallery();return;}
    ++galleryToken;setBusy(true);cancel=false;let count=0,outputDir='';
    try{
        if(exporting){
            let parent=$('[data-output-dir]').value;
            if(!parent)parent=await root.electronAPI.getDownloadsPath();
            if(!parent)parent=await root.electronAPI.selectDirectory();
            if(!parent)throw new Error('未选择输出目录');
            $('[data-output-dir]').value=parent;localStorage.setItem('phone_cards_output_dir',parent);
            outputDir=joinOutputPath(parent,outputFolderName());
            const result=await root.electronAPI.ensureDirectory(outputDir);
            if(result?.ok===false)throw new Error('创建输出文件夹失败：'+result.error);
            lastOutputDir=outputDir;$('[data-open-output]').hidden=false;
        }
        for(const s of p.chosen){
            const styleDir=outputDir;
            for(const {row,name} of p.jobs.filter(job=>job.style===s)){
                if(cancel)throw new Error('已取消生成');
                const c=await render(cardStyle(s,tableRows[row.rowIndex]),row.phone);
                if(exporting){
                    const blob=await new Promise(resolve=>c.toBlob(resolve,'image/png'));
                    if(!blob)throw new Error('PNG 生成失败，图片可能过大');
                    if(cancel)throw new Error('已取消生成');
                    const result=await root.electronAPI.savePngFrame({outputPath:joinOutputPath(styleDir,name),rawRGBA:new Uint8Array(await blob.arrayBuffer()),width:c.width,height:c.height,isPng:true});
                    if(!result?.ok)throw new Error(`保存 ${name} 失败：${result?.error||'未知错误'}`);
                }else{
                    const f=document.createElement('figure'),img=document.createElement('img'),caption=document.createElement('figcaption');img.src=c.toDataURL('image/png');img.className='pc-checker';caption.textContent=`${s.name} / ${row.name}`;f.append(img,caption);$('[data-gallery]').append(f);
                }
                count++;status(`已${exporting?'导出':'生成'} ${count} / ${p.jobs.length} 张${outputDir?'；输出目录：'+outputDir:''}`);
                await new Promise(resolve=>setTimeout(resolve,0));
                
            }
            
        }
        if(exporting){status(`已导出 ${count} 张透明 PNG。输出目录：${outputDir}`);try{await root.electronAPI.apiCall('file/open-folder',{path:outputDir});}catch(_){} }
        else status(`已预览 ${count} 张，完整批次共 ${p.jobs.length} 张。`);
    }catch(e){status(`${e.message}${exporting&&outputDir?`；已保存 ${count} 张，输出目录：${outputDir}`:''}`);}
    finally{setBusy(false);}
}
$('[data-preview]').onclick=()=>generate(false);$('[data-export]').onclick=()=>generate(true);
(async()=>{setBusy(true);try{const open=indexedDB.open('videokit-phone-card-maker',1);open.onupgradeneeded=()=>open.result.createObjectStore('library');db=await req(open);await sharedFonts();$('[data-output-dir]').value=localStorage.getItem('phone_cards_output_dir')||'';styles=await req(db.transaction('library').objectStore('library').get('styles'))||[];active=styles[0]?.id||'';}catch(e){status('样式库加载失败：'+e.message);}finally{setBusy(false);}})();
})(typeof window==='undefined'?globalThis:window);
