'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const NAME = '.videokit-library.json';
const MEDIA = /\.(png|jpe?g|webp|gif|bmp|mp4|mov|avi|mkv|webm|m4v)$/i;
const IMAGE = /\.(png|jpe?g|webp|gif|bmp)$/i;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const inside = (root, file) => { const rel = path.relative(root, file); return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); };
async function read(file) {
    try { return JSON.parse(await fs.readFile(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw new Error(`记录无法读取，请保留文件并检查：${file}（${error.message}）`); }
}
async function atomic(file, value) {
    await fs.mkdir(path.dirname(file), {recursive:true});
    const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
        // Never replace a valid backup with a corrupted primary file.
        try { if (await read(file)) await fs.copyFile(file, file + '.bak'); } catch (_) {}
        await fs.writeFile(temp, JSON.stringify(value, null, 2), 'utf8');
        await fs.rename(temp, file);
    } finally { await fs.unlink(temp).catch(() => {}); }
}
function validate(db) {
    if (db.version !== 1 || !db.files || !db.entries) throw new Error('素材库记录格式不支持，未覆盖原记录');
    return db;
}
function createService({cacheDir = path.join(os.homedir(), '.videokit', 'media-libraries'),metadataName=NAME,mediaPattern=MEDIA} = {}) {
    const queues = new Map();
    function serial(key, fn) {
        const next = (queues.get(key) || Promise.resolve()).catch(() => {}).then(fn);
        queues.set(key, next); next.finally(() => { if (queues.get(key) === next) queues.delete(key); }).catch(() => {});
        return next;
    }
    const registry = path.join(cacheDir, 'libraries.json');
    const cachedPath = root => path.join(cacheDir, hash(root) + '.json');
    async function list() { return (await read(registry))?.roots || []; }
    async function load(root) {
        const local = await read(cachedPath(root));
        let db, warning = '';
        try { db = await read(path.join(root, metadataName)); }
        catch (error) {
            try { db = await read(path.join(root, metadataName + '.bak')); } catch (_) {}
            if (!db) throw error;
            warning = '主记录损坏，已从备份恢复';
        }
        if (!db) {
            if (local?.db) { db = local.db; warning = '文件夹记录不可用，正在使用本地副本'; }
            else db = {version:1, libraryId:crypto.randomUUID(), files:{}, entries:{}, updatedAt:null};
        }
        validate(db);
        return {db, pending:local?.pending || [], warning};
    }
    async function fingerprint(file, stat) {
        const digest = crypto.createHash('sha256');
        const handle = await fs.open(file, 'r');
        try {
            const chunk = 1024 * 1024;
            // Photos use a full content hash; large videos use size + three sampled regions.
            const full = IMAGE.test(file) || stat.size <= chunk * 3;
            digest.update(`${full ? 'full' : 'sample'}:${stat.size}:`);
            const offsets = full ? Array.from({length:Math.ceil(stat.size/chunk)}, (_, i) => i*chunk)
                : [0, Math.floor(stat.size/2), Math.max(0, stat.size-chunk)];
            for (const offset of offsets) {
                const buffer = Buffer.alloc(Math.min(chunk, stat.size-offset));
                const {bytesRead} = await handle.read(buffer, 0, buffer.length, offset);
                digest.update(buffer.subarray(0, bytesRead));
            }
            return digest.digest('hex');
        } finally { await handle.close(); }
    }
    async function indexFile(root, file, db) {
        file = path.resolve(file);
        if (!mediaPattern.test(file)) return null;
        // Avoid following links out of the bound library.
        const real = await fs.realpath(file);
        if (!inside(root, real)) return null;
        const stat = await fs.stat(real); if (!stat.isFile()) return null;
        const relative = path.relative(root, real).split(path.sep).join('/');
        const old = db.files[relative];
        if (old && old.size === stat.size && old.mtimeMs === stat.mtimeMs) return {relative, ...old};
        const id = await fingerprint(real, stat);
        const info = {id, size:stat.size, mtimeMs:stat.mtimeMs}; db.files[relative] = info;
        return {relative, ...info};
    }
    async function scan(root, db) {
        const paths = [], errors = [];
        async function visit(directory) {
            for (const entry of await fs.readdir(directory, {withFileTypes:true})) {
                if (entry.name.startsWith('.') || entry.name==='本批已经使用') continue;
                const file = path.join(directory, entry.name);
                if (entry.isDirectory()) await visit(file);
                else if (entry.isFile() && mediaPattern.test(file)) {
                    try { if (await indexFile(root, file, db)) paths.push(file); }
                    catch (error) { errors.push(`${entry.name}：${error.message}`); }
                }
            }
        }
        await visit(root);return {paths, errors};
    }
    function apply(db, operations) {
        for (const op of operations) {
            if(op.kind==='background-default'){db.backgroundTarget=op.target;continue;}
            if(op.kind==='background-meta'){db.backgrounds ||= {};for(const id of op.ids)db.backgrounds[id]={...db.backgrounds[id],...op.patch};continue;}
            if(op.kind==='binding-rules'){db.bindingRules=op.rules;continue;}
            for (const id of op.ids) {
            const entry = db.entries[id] || {count:0, lastUsedAt:null, recent:[], eventIds:[]};
            if(op.kind==='adoption'){
                entry.adoptions ||= {};
                const previous=!!entry.adoptions[op.eventId]?.used;
                if(previous!==op.used){
                    entry.count=Math.max(0,entry.count+(op.used?1:-1));
                    entry.recent=entry.recent.filter(item=>item.eventId!==op.eventId);
                    if(op.used)entry.recent=[{eventId:op.eventId,at:op.at,source:'adoption',taskName:op.taskName || ''},...entry.recent].slice(0,10);
                    entry.lastUsedAt=entry.recent.map(item=>item.at).sort().pop() || null;
                }
                entry.adoptions[op.eventId]={used:op.used};db.entries[id]=entry;continue;
            }
            if (entry.eventIds.includes(op.eventId)) continue;
            if (op.kind === 'clear') { entry.count = 0; entry.lastUsedAt = null; entry.recent = []; entry.adoptions={}; }
            else {
                entry.count++; entry.lastUsedAt = op.at;
                entry.recent = [{at:op.at, source:op.kind, taskName:op.taskName || '', output:op.output || ''}, ...entry.recent].slice(0, 10);
            }
            entry.eventIds = [...entry.eventIds, op.eventId].slice(-256); db.entries[id] = entry;
            }
        }
    }
    async function save(root, state, operations = []) {
        apply(state.db, [...state.pending, ...operations]);
        state.db.updatedAt = new Date().toISOString();
        const pending = [...state.pending, ...operations];
        let unsynced = false;
        try { await atomic(path.join(root, metadataName), state.db); }
        catch (error) { unsynced = true; state.warning = `记录尚未同步到素材库，已暂存本机：${error.message}`; }
        // Preserve pending event IDs so a later writable session merges rather than overwrites history.
        await atomic(cachedPath(root), {db:state.db, pending:unsynced ? pending : []});
        return {unsynced, warning:state.warning};
    }
    function response(root, db, extra = {}) {
        const history = {};
        for (const [rel, file] of Object.entries(db.files)) {
            const entry = db.entries[file.id];
            history[path.join(root, ...rel.split('/'))] = entry ? {count:entry.count,lastUsedAt:entry.lastUsedAt,recent:entry.recent} : {count:0,lastUsedAt:null,recent:[]};
        }
        const backgroundMetadata=metadataName!==NAME || db.backgrounds ? Object.fromEntries(Object.entries(db.files).map(([rel,file])=>[path.join(root,...rel.split('/')),db.backgrounds?.[file.id] || {}])) : undefined;
        return {root, backgroundTarget:db.backgroundTarget || null,backgroundMetadata,libraryId:db.libraryId, bindingRules:db.bindingRules || {enabled:false,keywords:[]}, recordPath:path.join(root, metadataName), history, ...extra};
    }
    async function boundRoot(input) {
        if (typeof input !== 'string' || !path.isAbsolute(input)) throw new Error('请选择完整的素材库文件夹路径');
        return fs.realpath(input);
    }
    async function handle(data) {
        if (data.action === 'list') return {roots:await list()};
        if (data.action === 'unbind') {
            const root=path.resolve(data.root);
            await serial(registry,async()=>atomic(registry,{roots:(await list()).filter(item=>item!==root)}));
            return {root};
        }
        if (data.action === 'record-export') {
            const results = [], canonical=[];
            for(const file of [...new Set(data.paths || [])]) {
                if(typeof file!=='string' || !path.isAbsolute(file))continue;
                try{canonical.push(await fs.realpath(file));}catch(_){}
            }
            const roots=new Set(await list());
            for(const supplied of data.temporaryRoots || []){
                try{roots.add(await boundRoot(supplied));}catch(error){results.push({root:supplied,error:error.message});}
            }
            for (const root of roots) {
                const paths = canonical.filter(file => inside(root, file));
                if (!paths.length) continue;
                try { results.push(await handle({...data, action:'mark', root, paths, kind:'export'})); }
                catch (error) { results.push({root, error:error.message}); }
            }
            return {results};
        }
        const root = await boundRoot(data.root);
        return serial(root, async () => {
            const state = await load(root);
            if (data.action === 'bind' || data.action === 'refresh' || data.action==='track') {
                const scanned=data.action==='track' && Array.isArray(data.paths) ? {paths:[],errors:[]} : await scan(root,state.db);
                if(data.action==='track' && Array.isArray(data.paths))for(const file of [...new Set(data.paths)]){try{if(await indexFile(root,file,state.db))scanned.paths.push(file);}catch(error){scanned.errors.push(error.message);}}
                const saved = await save(root, state);
                if(data.action!=='track')await serial(registry, async () => {const roots=await list();if(!roots.includes(root))await atomic(registry,{roots:[...roots,root]});});
                return response(root, state.db, {...scanned, ...saved});
            }
            if(data.action==='adoption-batch'){
                if(!Array.isArray(data.records) || !data.records.length || data.records.length>10000)throw new Error('使用记录批次数量无效');
                const validation={...state.db,entries:JSON.parse(JSON.stringify(state.db.entries))};
                apply(validation,state.pending);
                const ops=[], indexed=new Map();
                for(const record of data.records){
                    if(!record.eventId)throw new Error('使用记录缺少事件 ID');
                    const ids=new Set();
                    for(const file of new Set(record.paths || [])){
                        let info;
                        try{
                            if(!indexed.has(file))indexed.set(file,await indexFile(root,file,state.db));
                            info=indexed.get(file);
                        }catch(error){
                            if(!record.used && inside(root,path.resolve(file)))info=state.db.files[path.relative(root,path.resolve(file)).split(path.sep).join('/')];
                            if(!info)throw error;
                        }
                        if(!info)throw new Error('素材不属于对应素材库');
                        ids.add(info.id);
                    }
                    if(!ids.size)throw new Error('使用记录没有可读取素材');
                    if(record.used && record.limit>0)for(const id of ids){
                        const entry=validation.entries[id];
                        if(!entry?.adoptions?.[record.eventId]?.used && (entry?.count || 0)>=record.limit)throw new Error('素材已达到历史使用次数上限');
                    }
                    const op={kind:'adoption',eventId:record.eventId,ids:[...ids],used:!!record.used,at:new Date().toISOString(),taskName:String(record.taskName || '').slice(0,300)};
                    apply(validation,[op]);ops.push(op);
                }
                // Idempotent event IDs allow save() to apply these again safely.
                return response(root,state.db,await save(root,state,ops));
            }
            if(data.action==='background-titles'){
                if(!Array.isArray(data.rows) || !data.rows.length || data.rows.length>5000)throw new Error('请提供 1 至 5000 行背景标题');
                const titles=new Map(),ops=[];
                // Validate every row before writing any title, including identical media copies.
                for(const [index,row] of data.rows.entries()){
                    if(!row || typeof row.path!=='string' || typeof row.title!=='string' || row.title.length>20000)throw new Error(`第 ${index+1} 行标题格式不正确或超过 20000 字`);
                    const info=await indexFile(root,row.path,state.db);if(!info)throw new Error(`第 ${index+1} 行视频不属于此背景库`);
                    if(titles.has(info.id) && titles.get(info.id)!==row.title)throw new Error(`第 ${index+1} 行与其他行是同一视频的副本，请使用相同标题`);
                    if(!titles.has(info.id))ops.push({kind:'background-meta',ids:[info.id],patch:{title:row.title}});
                    titles.set(info.id,row.title);
                }
                return response(root,state.db,await save(root,state,ops));
            }
            if(data.action==='background-meta' || data.action==='background-default'){
                const target=value=>{
                    if(value==null)return null;
                    if(!['title_text','content','scroll_title'].includes(value.field) || !['textcard','text','scroll'].includes(value.type))throw new Error('请选择有效的标题层');
                    if(value.field!==({textcard:'title_text',text:'content',scroll:'scroll_title'})[value.type])throw new Error('标题字段与所选图层类型不匹配');
                    return {field:value.field,type:value.type,slotKey:String(value.slotKey || '').slice(0,500),templateId:String(value.templateId || '').slice(0,500),name:String(value.name || '').slice(0,500),index:Number.isInteger(value.index)?value.index:0};
                };
                if(data.action==='background-default')return response(root,state.db,await save(root,state,[{kind:'background-default',target:target(data.target)}]));
                const info=await indexFile(root,data.path,state.db);if(!info)throw new Error('背景视频不属于此背景库');
                const patch={};
                if('title' in data)patch.title=String(data.title).slice(0,20000);
                if('weight' in data){
                    if(typeof data.weight!=='number' || !Number.isFinite(data.weight) || data.weight<0)throw new Error('分配权重请输入非负数字');
                    patch.weight=data.weight;
                }
                if('percentage' in data){
                    if(data.percentage!==null && (typeof data.percentage!=='number' || !Number.isFinite(data.percentage) || data.percentage<0 || data.percentage>100))throw new Error('固定比例请输入 0–100%，留空自动');
                    patch.percentage=data.percentage;
                }
                if('favorite' in data)patch.favorite=!!data.favorite;
                if('target' in data)patch.target=target(data.target);
                return response(root,state.db,await save(root,state,[{kind:'background-meta',ids:[info.id],patch}]));
            }
            if(data.action==='binding-rules'){
                const keywords=[...new Set((data.keywords || []).map(value=>String(value).trim()).filter(Boolean))];
                if(keywords.length>100 || keywords.some(value=>value.length>100))throw new Error('关键词最多 100 个，每个最多 100 字');
                if(data.enabled && !keywords.length)throw new Error('请先填写自定义关键词');
                const rules={enabled:!!data.enabled,keywords};
                return response(root,state.db,await save(root,state,[{kind:'binding-rules',rules,eventId:crypto.randomUUID()}]));
            }
            if (!['mark','clear','read','adoption'].includes(data.action)) throw new Error('不支持的素材库操作');
            if (data.action === 'read') return response(root, state.db, await save(root,state));
            const ids = new Set(), missing = [];
            for (const file of [...new Set(data.paths || [])]) {
                try { const info=await indexFile(root,file,state.db);if(info)ids.add(info.id); }
                catch (_) {
                    const previous=data.action==='adoption' && !data.used && inside(root,path.resolve(file)) ? state.db.files[path.relative(root,path.resolve(file)).split(path.sep).join('/')] : null;
                    if(previous)ids.add(previous.id);else missing.push(file);
                }
            }
            if(data.action==='adoption' && data.used){
                if(missing.length || !ids.size)throw new Error('部分素材已移动或不可读取，请刷新后重新配对');
                if(data.limit>0)for(const id of ids){const entry=state.db.entries[id];if(!entry?.adoptions?.[data.eventId]?.used && (entry?.count || 0)>=data.limit)throw new Error('素材已达到历史使用次数上限，请重新随机配对');}
            }
            const op = {eventId:data.eventId || crypto.randomUUID(), ids:[...ids], kind:data.action==='adoption'?'adoption':data.action==='clear'?'clear':data.kind==='export'?'export':'manual',used:!!data.used,
                at:new Date().toISOString(), taskName:String(data.taskName || '').slice(0,300), output:String(data.output || '')};
            const saved = await save(root,state,[op]);
            return response(root,state.db,{...saved,missing,marked:ids.size});
        });
    }
    return {handle};
}
module.exports = {createService, NAME};
