(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ReelsDropImport = api;
})(typeof window === 'object' ? window : null, function () {
    const extensions = {
        bg: new Set(['mp4','mov','mkv','avi','wmv','flv','webm','m4v','jpg','jpeg','png','webp','gif','bmp']),
        audio: new Set(['mp3','wav','m4a','aac','flac','ogg']),
        srt: new Set(['srt']), txt: new Set(['txt'])
    };
    const nameOf = path => String(path || '').replace(/\\/g, '/').split('/').pop();
    const parentOf = path => String(path || '').replace(/\\/g, '/').replace(/\/[^/]*$/, '');
    // Preserve the full name, including Chinese and numbers. No stopword/fuzzy matching.
    const keyOf = path => nameOf(path).replace(/\.[^.]+$/, '').normalize('NFC').trim().toLowerCase();
    const roleOf = path => Object.keys(extensions).find(role => extensions[role].has(nameOf(path).split('.').pop().toLowerCase()));
    function uniquePartner(item, candidates) {
        const matches = candidates.filter(candidate => candidate.key === item.key);
        const siblings = matches.filter(candidate => parentOf(candidate.path) === parentOf(item.path));
        if (siblings.length) return siblings.length === 1 ? siblings[0] : null;
        const sameScope = matches.filter(candidate => (candidate.root || '') === (item.root || ''));
        if (sameScope.length) return sameScope.length === 1 ? sameScope[0] : null;
        return matches.length === 1 ? matches[0] : null;
    }
    function plan(entries) {
        const seen = new Set(), media = [], unsupported = [];
        for (const entry of entries) {
            if (!entry.path || seen.has(entry.path)) continue;
            seen.add(entry.path);
            const role = roleOf(entry.path);
            if (!role) {unsupported.push(entry.path);continue;}
            media.push({...entry, role, key:keyOf(entry.path)});
        }
        const rows = media.filter(item => item.role === 'audio').map(item => ({...item, files:{audio:item}}));
        for (const role of ['srt','txt','bg']) {
            const items = media.filter(item => item.role === role);
            const candidates = rows.filter(row => !row.files[role]);
            const paired = new Set();
            for (const item of items) {
                const row = uniquePartner(item, candidates);
                // Both sides must have exactly one partner; duplicate names cannot guess.
                if (row && uniquePartner(row, items) === item) {
                    row.files[role] = item;
                    paired.add(item);
                }
            }
            for (const item of items) if (!paired.has(item)) rows.push({...item, files:{[role]:item}});
        }
        return {rows, unsupported};
    }
    return {plan, keyOf, roleOf, parentOf, nameOf};
});
