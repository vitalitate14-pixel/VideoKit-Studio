/**
 * templates.js — 视频模板预设 CRUD 服务
 * 
 * 存储位置: userData/videokit-templates/
 *   - index.json          模板索引（轻量，含缩略图 base64）
 *   - tpl_<id>.json       模板完整数据（项目工程数据）
 */
const fs = require('fs');
const path = require('path');
const projectAssets = require('../../src/reels-project-assets');

function getTemplatesDir() {
    const { isMainThread, workerData } = require('worker_threads');
    if (!isMainThread && workerData?.templatesDirectory) return workerData.templatesDirectory;
    if (!isMainThread) throw new Error('模板库后台线程缺少模板目录');
    const { app } = require('electron');
    const dir = path.join(app.getPath('userData'), 'videokit-templates');
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
}

function sanitizeTemplateToken(token, label = '模板 ID') {
    const clean = String(token || '').trim();
    if (!clean || !/^[A-Za-z0-9_.-]+$/.test(clean) || clean === '.' || clean === '..' || clean.includes('..')) {
        throw new Error(`非法的${label}: ${clean.slice(0, 64)}`);
    }
    return clean;
}

function getIndexPath() {
    return path.join(getTemplatesDir(), 'index.json');
}

let indexCache = null;
function readIndex(useCache = false) {
    const p = getIndexPath();
    if (!fs.existsSync(p)) return [];
    try {
        const stat = fs.statSync(p);
        const revision = `${p}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
        if(useCache && indexCache?.revision===revision)return indexCache.entries;
        const entries=JSON.parse(fs.readFileSync(p, 'utf-8'));
        if(useCache)indexCache={revision,entries};
        return entries;
    } catch {
        return [];
    }
}

function atomicWrite(file, data) {
    const temporary=file+'.'+require('crypto').randomUUID()+'.tmp';
    try{fs.writeFileSync(temporary,JSON.stringify(data,null,2),'utf8');fs.renameSync(temporary,file);}
    finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
}
function writeIndex(index) { atomicWrite(getIndexPath(),index);indexCache=null; }

/**
 * 列出所有模板（返回索引信息，不含完整工程数据）
 */
const searchCache = new Map();
function templateSearchSummary(entry) {
    const file = path.join(getTemplatesDir(), sanitizeTemplateToken(entry.id)+'.json');
    try {
        const stat = fs.statSync(file), revision = `${file}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
        if (searchCache.get(file)?.revision === revision) return searchCache.get(file).summary;
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        const media = new Set(), exports = new Set(), keywords = new Set();
        const skipped = new Set(['embeddedImages','thumbnail','combinationPreviewDrafts','combinationArchiveBatches','_mediaUsageRecords','outputDir','projectDir']);
        function scan(value, key = '', mediaContext = false) {
            if (typeof value === 'string') {
                if (!value || /^(data:|blob:)/i.test(value)) return;
                let text = value;
                try { text = decodeURIComponent(text); } catch {}
                const isExport = /^(exportName|baseName|fileName|outputName|exportFileName)$/i.test(key);
                const isMedia = !isExport && (mediaContext || /path|folder|dir$|url|src|source|audio|video|image|bgm|bgfiles|subtitlefile|srtfile/i.test(key)
                    || /\.(png|jpe?g|webp|gif|bmp|svg|mp4|mov|m4v|mkv|webm|avi|mp3|wav|m4a|aac|ogg|flac|srt|vtt)(?:[?#].*)?$/i.test(text));
                if (isMedia) media.add(text);
                if (isExport) exports.add(text);
                if (isMedia || /name|text|title|content|description|tags|keyword|label/i.test(key)) keywords.add(text);
            } else if (Array.isArray(value)) value.forEach(item=>scan(item,key,mediaContext));
            else if (value && typeof value === 'object') {
                for (const [child,item] of Object.entries(value)) if (!skipped.has(child))
                    scan(item,child,mediaContext || /media_folder_files|bgFiles|audioFiles/i.test(child));
            }
        }
        scan(data.projectData);
        const summary = {media:[...media].join('\n').toLocaleLowerCase(),exports:[...exports].join('\n').toLocaleLowerCase(),keywords:[...keywords].join('\n').toLocaleLowerCase()};
        searchCache.set(file,{revision,summary});
        return summary;
    } catch { return {media:'',exports:'',keywords:'',unavailable:true}; }
}
function listTemplates({includeThumbnails = true, includeSearch = false} = {}) {
    const entries = readIndex(true);
    const liveFiles = new Set(entries.map(entry=>path.join(getTemplatesDir(),entry.id+'.json')));
    for (const file of searchCache.keys()) if (!liveFiles.has(file)) searchCache.delete(file);
    return entries.map(original=>{
        const entry = includeSearch ? {...original,searchIndex:templateSearchSummary(original)} : original;
        if(includeThumbnails)return {...entry};
        const {thumbnail,...summary}=entry;
        return {...summary,hasThumbnail:!!thumbnail};
    });
}
function getTemplateThumbnail(id) {
    const safeId=sanitizeTemplateToken(id);
    const entry=readIndex(true).find(entry=>entry.id===safeId);
    if(!entry)throw new Error(`模板不存在: ${safeId}`);
    return {thumbnail:entry.thumbnail || ''};
}

function getTemplateSearch(ids) {
    const selected = new Set((ids || []).slice(0, 4).map(id => sanitizeTemplateToken(id)));
    return readIndex(true).filter(entry => selected.has(entry.id))
        .map(entry => ({id: entry.id, searchIndex: templateSearchSummary(entry)}));
}

function queryLibrary(action, data) {
    return require('./template-library-worker').query(getTemplatesDir(), action, data);
}

/**
 * 获取单个模板的完整数据
 */
function getTemplate(id) {
    const safeId = sanitizeTemplateToken(id, '模板 ID');
    const filePath = path.join(getTemplatesDir(), `${safeId}.json`);
    if (!fs.existsSync(filePath)) {
        throw new Error(`模板不存在: ${safeId}`);
    }
    const template=JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if(template.projectData)template.projectData=projectAssets.decode(template.projectData);
    return {...template,id:safeId};
}

/**
 * 保存模板
 * @param {object} params
 * @param {string} params.name - 模板名称
 * @param {string} [params.description] - 描述
 * @param {string} [params.thumbnail] - 缩略图 base64
 * @param {string[]} [params.tags] - 标签
 * @param {object} params.projectData - 完整工程数据 (collectProjectData 的输出)
 * @param {string} [params.id] - 已有 ID（更新时传入）
 */
function saveTemplate({ id, name, description, thumbnail, tags, category, projectData, kind, assetCollection }) {
    const now = new Date().toISOString();
    const templateId = id ? sanitizeTemplateToken(id, '模板 ID') : `tpl_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

    // 完整数据写入独立文件
    const fullData = {
        id: templateId,
        name,
        description: description || '',
        thumbnail: thumbnail || '',
        tags: tags || [],
        category: category || '',
        kind: kind || 'project',
        assetCollection: assetCollection || {status:'not-collected'},
        createdAt: now,
        updatedAt: now,
        projectData: projectAssets.encode(projectData),
    };

    const filePath = path.join(getTemplatesDir(), `${templateId}.json`);

    // 如果是更新，保留原始创建时间
    if (id && fs.existsSync(filePath)) {
        try {
            const existing = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            const history=path.join(getTemplatesDir(),'history',templateId);fs.mkdirSync(history,{recursive:true});
            const revision=Date.now()+'_'+require('crypto').randomUUID();
            fs.copyFileSync(filePath,path.join(history,revision+'.json'));
            atomicWrite(path.join(history,revision+'.meta.json'),{revision,name:existing.name,at:existing.updatedAt,taskCount:existing.projectData?.tasks?.length || 0});
            fullData.createdAt = existing.createdAt || now;
            if (category === undefined) fullData.category = existing.category || '';
        } catch(error) { throw new Error('原模板备份失败，已停止覆盖：'+error.message); }
    }

    atomicWrite(filePath,fullData);

    // 更新索引
    const index = readIndex();
    const existingIdx = index.findIndex(t => t.id === templateId);
    const indexEntry = {
        id: templateId,
        name,
        description: description || '',
        thumbnail: thumbnail || '',
        tags: tags || [],
        category: fullData.category,
        kind: fullData.kind,
        assetCollection: fullData.assetCollection,
        createdAt: fullData.createdAt,
        updatedAt: now,
        // 摘要信息
        taskCount: projectData?.tasks?.length || 0,
    };

    if (existingIdx >= 0) {
        index[existingIdx] = indexEntry;
    } else {
        index.unshift(indexEntry); // 新模板排在最前面
    }

    writeIndex(index);
    return { id: templateId, success: true };
}

async function importCollection(data,onProgress){
    const directory=getTemplatesDir();
    let presetIds=[];
    const result=await require('./template-collection-import').importCollection({...data,directory,onProgress,commit:async records=>{
        const installed=[];
        try{
            for(const item of records){
                const destination=path.join(directory,item.id+'.json');
                await fs.promises.rename(item.file,destination);installed.push(destination);
            }
            presetIds=records.filter(item=>item.meta.kind==='preset').map(item=>item.id);
            const entries=records.map(item=>({...item.meta,id:item.id}));
            writeIndex([...entries,...readIndex()]);
        }catch(error){for(const file of installed)await fs.promises.rm(file,{force:true});throw error;}
    }});
    return {...result,presetIds};
}
function removeImportedPresets(ids){
    const selected=new Set(ids || []),index=readIndex();
    const removing=index.filter(entry=>selected.has(entry.id) && entry.kind==='preset');
    writeIndex(index.filter(entry=>!removing.includes(entry)));
    for(const entry of removing)fs.rmSync(path.join(getTemplatesDir(),entry.id+'.json'),{force:true});
    return {count:removing.length};
}

async function packageProject(data,onProgress){
    const packaged=await require('./template-project-package').create({...data,directory:getTemplatesDir(),onProgress});
    const saved=saveTemplate({...data,...packaged,id:undefined});
    return {...saved,zip_path:packaged.zip_path,assetCollection:packaged.assetCollection};
}
function listVersions(id){
    const safeId=sanitizeTemplateToken(id,'模板 ID');
    const directory=path.join(getTemplatesDir(),'history',safeId);
    if(!fs.existsSync(directory))return [];
    return fs.readdirSync(directory).filter(name=>name.endsWith('.meta.json')).map(name=>JSON.parse(fs.readFileSync(path.join(directory,name),'utf8'))).sort((a,b)=>b.revision.localeCompare(a.revision));
}
function restoreVersion(id,revision){
    const safeId=sanitizeTemplateToken(id,'模板 ID');
    const safeRevision=sanitizeTemplateToken(revision,'模板修订号');
    if(!listVersions(safeId).some(entry=>entry.revision===safeRevision))throw new Error('恢复版本不存在');
    const data=JSON.parse(fs.readFileSync(path.join(getTemplatesDir(),'history',safeId,safeRevision+'.json'),'utf8'));
    return saveTemplate({...data,id:safeId,projectData:projectAssets.decode(data.projectData)});
}

function libraryConfig() {
    const file = path.join(getTemplatesDir(), 'library.json');
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
    return { categories: ['口播', '人声reels', '字幕reels', '滚动字幕'] };
}

function saveLibraryConfig(categories) {
    const config = { categories: [...new Set((categories || []).map(value => String(value).trim()).filter(Boolean))] };
    // 删除分类仅取消归类，模板和内部任务组保持原样。
    const removed = readIndex().filter(entry => entry.category && !config.categories.includes(entry.category));
    if (removed.length) classifyTemplates(removed.map(entry => entry.id), '');
    fs.writeFileSync(path.join(getTemplatesDir(), 'library.json'), JSON.stringify(config, null, 2), 'utf8');
    return config;
}

function classifyTemplates(ids, category) {
    if (category && !libraryConfig().categories.includes(category)) throw new Error('分类不存在');
    const index = readIndex();
    const selected = new Set(ids);
    for (const entry of index) {
        if (!selected.has(entry.id)) continue;
        const data = getTemplate(entry.id);
        data.category = category || '';
        fs.writeFileSync(path.join(getTemplatesDir(), `${entry.id}.json`), JSON.stringify({...data,projectData:projectAssets.encode(data.projectData)}, null, 2), 'utf8');
        entry.category = data.category;
    }
    writeIndex(index);
    return { success: true };
}

/**
 * 删除模板
 */
function deleteTemplate(id) {
    const safeId = sanitizeTemplateToken(id, '模板 ID');
    // 删除数据文件
    const filePath = path.join(getTemplatesDir(), `${safeId}.json`);
    if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
    }

    // 更新索引
    const index = readIndex();
    const filtered = index.filter(t => t.id !== safeId);
    writeIndex(filtered);

    return { success: true };
}

/**
 * 重命名模板
 */
function renameTemplate(id, newName) {
    const safeId = sanitizeTemplateToken(id, '模板 ID');
    const filePath = path.join(getTemplatesDir(), `${safeId}.json`);
    if (!fs.existsSync(filePath)) {
        throw new Error(`模板不存在: ${safeId}`);
    }

    // 更新数据文件
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    data.name = newName;
    data.updatedAt = new Date().toISOString();
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');

    // 更新索引
    const index = readIndex();
    const entry = index.find(t => t.id === safeId);
    if (entry) {
        entry.name = newName;
        entry.updatedAt = data.updatedAt;
    }
    writeIndex(index);

    return { success: true };
}

module.exports = {
    importCollection, removeImportedPresets,
    estimateCollection: data=>require('./template-collection-export').estimateCollection({...data,directory:getTemplatesDir()}),
    cancelCollectionExport: id=>require('./template-collection-export').cancelExport(id),
    exportCollection: data=>require('./template-collection-export').startExport({...data,directory:getTemplatesDir()}),
    packageProject, listVersions, restoreVersion,
    listTemplates,
    getTemplateSearch, queryLibrary,
    getTemplateThumbnail,
    getTemplate,
    saveTemplate,
    deleteTemplate,
    renameTemplate,
    libraryConfig, saveLibraryConfig, classifyTemplates,
};
