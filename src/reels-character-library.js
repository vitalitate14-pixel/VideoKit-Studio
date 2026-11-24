/** Character libraries use the shared fixed-library reader, planner and history store. */
(() => {
    'use strict';
    const KEY='videokit_character_library_v1';
    const normalize=value=>String(value || '').replace(/\\/g,'/').replace(/\/+$/,'').normalize('NFC');
    let saved={};
    try{saved=JSON.parse(localStorage.getItem(KEY) || '{}') || {};}catch(_){}
    const roots=new Set((Array.isArray(saved.roots)?saved.roots:[]).filter(root=>typeof root==='string' && root).map(normalize));
    function save(){localStorage.setItem(KEY,JSON.stringify({...saved,roots:[...roots]}));}
    function addRoot(root){const value=normalize(root);if(!value)throw new Error('请选择爆贴人物库目录');const had=roots.has(value);roots.add(value);try{save();}catch(error){if(!had)roots.delete(value);throw error;}}
    function removeRoot(root){const value=normalize(root),had=roots.delete(value);try{save();}catch(error){if(had)roots.add(value);throw error;}}
    function rootFor(path){const value=normalize(path);return [...roots].filter(root=>value===root || value.startsWith(root+'/')).sort((a,b)=>b.length-a.length)[0] || '';}
    window.ReelsCharacterLibrary={get roots(){return [...roots];},addRoot,removeRoot,rootFor,hasPath:path=>!!rootFor(path)};
})();
