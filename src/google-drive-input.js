(function (root) {
    'use strict';
    const validId = value => /^[a-zA-Z0-9_-]+$/.test(value || '');
    function parseLink(value, depth = 0) {
        let text = String(value || '').trim().replace(/&amp;/gi, '&');
        if (/^[a-zA-Z0-9_-]{28,}$/.test(text)) return { type: 'file', id: text, url: text, resourceKey: '' };
        if (/^(?:drive\.google\.com|docs\.google\.com|drive\.usercontent\.google\.com|lh\d\.googleusercontent\.com)\//i.test(text)) text = 'https://' + text;
        let url;
        try { url = new URL(text); } catch (_) { return null; }
        if (!['http:', 'https:'].includes(url.protocol)) return null;
        const host = url.hostname.toLowerCase();
        let path; try { path = decodeURIComponent(url.pathname); } catch (_) { return null; }
        if (depth < 3 && /^(?:www\.)?google\.com$/.test(host) && path === '/url') {
            return parseLink(url.searchParams.get('q') || url.searchParams.get('url'), depth + 1);
        }
        const drive = host === 'drive.google.com', docs = host === 'docs.google.com';
        const content = host === 'drive.usercontent.google.com' || /^lh\d\.googleusercontent\.com$/.test(host);
        if (!drive && !docs && !content) return null;
        let id, type = 'file', documentType = '';
        const folder = drive && path.match(/\/(?:drive\/(?:u\/\d+\/)?)?folders\/([a-zA-Z0-9_-]+)/i);
        const file = path.match(/\/(?:file\/(?:u\/\d+\/)?)?d\/([a-zA-Z0-9_-]+)/i);
        const native = docs && path.match(/\/(document|spreadsheets|presentation|drawings)\/(?:u\/\d+\/)?d\/([a-zA-Z0-9_-]+)/i);
        if (folder) { id = folder[1]; type = 'folder'; }
        else if (native) { id = native[2]; documentType = native[1]; }
        else if (file) id = file[1];
        else if (drive && /\/(?:embeddedfolderview|folderview)\/?$/i.test(path)) { id = url.searchParams.get('id'); type = 'folder'; }
        else if ((drive || content) && /\/(?:open|uc|download|thumbnail)\/?$/i.test(path)) id = url.searchParams.get('id');
        if (!validId(id)) return null;
        return { type, id, url: url.href, resourceKey: url.searchParams.get('resourcekey') || '', documentType };
    }
    function downloadUrls(fileId, resourceKey = '', originalUrl = '') {
        const source = parseLink(originalUrl);
        const format = { document: 'docx', spreadsheets: 'xlsx', presentation: 'pptx', drawings: 'pdf' }[source?.documentType];
        const appendKey = value => {
            const url = new URL(value);
            if (resourceKey) url.searchParams.set('resourcekey', resourceKey);
            return url.href;
        };
        if (format) {
            const suffix = ['presentation', 'drawings'].includes(source.documentType) ? '/' + format : '?format=' + format;
            const url = appendKey(`https://docs.google.com/${source.documentType}/d/${fileId}/export${suffix}`);
            return { initial: url, fallback: url, extension: '.' + format };
        }
        return { initial: appendKey(`https://drive.usercontent.google.com/download?id=${fileId}&export=download&authuser=0`),
            fallback: appendKey(`https://drive.google.com/uc?export=download&id=${fileId}`), extension: '' };
    }
    function linksInCell(value) {
        const text = String(value || '').trim();
        const formula = text.match(/^=?HYPERLINK\(\s*"((?:[^"]|"")*)"\s*(?:[,;]\s*"((?:[^"]|"")*)")?\s*\)$/i);
        if (formula) {
            const link = parseLink(formula[1].replace(/""/g, '"'));
            return link ? [{ ...link, label: (formula[2] || '').replace(/""/g, '"') }] : [];
        }
        const direct = (text.match(/https?:\/\//gi) || []).length > 1 ? null : parseLink(text);
        if (direct) return [{ ...direct, label: '' }];
        return (text.replace(/(https?:\/\/)/gi, ' $1').match(/https?:\/\/[^\s<>"\]]+/gi) || []).map(url => parseLink(url.replace(/[),.;，。]+$/, ''))).filter(Boolean).map(link => ({ ...link, label: '' }));
    }
    function readTable(text) {
        const rows = []; let row = [], cell = '', quoted = false;
        text = String(text || '').replace(/^\uFEFF/, '');
        for (let i = 0; i < text.length; i++) {
            const c = text[i];
            if (c === '"' && (quoted || !cell)) {
                if (quoted && text[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted;
            } else if (!quoted && /[\t\r\n]/.test(c)) {
                row.push(cell); cell = '';
                if (c !== '\t') {
                    if (c === '\r' && text[i + 1] === '\n') i++;
                    if (row.some(value => value.trim())) rows.push(row);
                    row = [];
                }
            } else cell += c;
        }
        row.push(cell); if (row.some(value => value.trim())) rows.push(row);
        return rows;
    }
    function entriesFromRows(rows) {
        const entries = [];
        for (const cells of rows) {
            const linked = cells.map(cell => typeof cell === 'string' ? linksInCell(cell) : cell.links);
            const links = linked.flat();
            const name = links.length === 1 ? cells.filter((cell, index) => !linked[index].length)
                .map(cell => typeof cell === 'string' ? cell : cell.text).find(value => value.trim()) : '';
            for (const link of links) entries.push({ ...link, rename: (name || link.label || '').trim() });
        }
        return entries;
    }
    function parseText(text) { return entriesFromRows(readTable(text)); }
    function parseClipboard(html, plainText, Parser = root.DOMParser) {
        const plainEntries = parseText(plainText);
        // Spreadsheet HTML can omit the adjacent name column. Keep the plain
        // table's names whenever it already contains usable link addresses.
        const plainNames = new Map(plainEntries.filter(entry => entry.rename)
            .map(entry => [entry.id, entry.rename]));
        if (html && Parser) {
            const doc = new Parser().parseFromString(html, 'text/html');
            const cellData = cell => {
                const links = [];
                const selector = 'a[href], [data-sheets-hyperlink]';
                const anchors = [...cell.querySelectorAll(selector)];
                if (cell.matches(selector)) anchors.unshift(cell);
                anchors.forEach(anchor => {
                    const link = parseLink(anchor.getAttribute('href') || anchor.getAttribute('data-sheets-hyperlink'));
                    if (link) links.push({ ...link, label: anchor.textContent.trim() });
                });
                const text = cell.textContent.trim();
                return { text, links: links.length ? [...new Map(links.map(link => [link.id, link])).values()] : linksInCell(text) };
            };
            const rows = [...doc.querySelectorAll('tr')].map(row => [...row.querySelectorAll('td,th')].map(cellData));
            let entries = entriesFromRows(rows);
            if (!entries.length) entries = entriesFromRows([[...doc.querySelectorAll('a[href], [data-sheets-hyperlink]')].map(cellData)]);
            if (entries.length) {
                entries = entries.map(entry => ({ ...entry, rename: plainNames.get(entry.id) || entry.rename }));
                const htmlIds = new Set(entries.map(entry => entry.id));
                entries.push(...plainEntries.filter(entry => !htmlIds.has(entry.id)));
                return { entries, text: toTSV(entries), rich: true };
            }
        }
        return { entries: plainEntries, text: plainText || '', rich: false };
    }
    function uniqueLinks(entries) {
        const byId = new Map();
        for (const entry of entries) {
            const previous = byId.get(entry.id);
            if (!previous) { byId.set(entry.id, { ...entry }); continue; }
            // open?id= and file/folder URLs may all refer to the same target.
            const preferred = entry.type === 'folder' || entry.documentType ? entry : previous;
            const merged = { ...preferred, resourceKey: previous.resourceKey || entry.resourceKey || '',
                rename: previous.rename || entry.rename || '' };
            byId.set(entry.id, merged);
        }
        return [...byId.values()].map(entry => {
            const url = new URL(/^https?:\/\//i.test(entry.url) ? entry.url : `https://drive.google.com/file/d/${entry.id}/view`);
            if (entry.resourceKey) url.searchParams.set('resourcekey', entry.resourceKey);
            return { ...entry, url: url.href, rename: entry.rename || '' };
        });
    }
    function toLinkList(entries) { return uniqueLinks(entries).map(entry => entry.url).join('\n'); }
    function toInputList(entries) {
        return uniqueLinks(entries).map(entry => entry.rename
            ? toTSV([entry]) : entry.url).join('\n');
    }
    function toTSV(entries) {
        const quote = value => `"${String(value).replace(/"/g, '""')}"`;
        return entries.map(entry => [entry.url, entry.rename].map(quote).join('\t')).join('\n');
    }
    function isMissingFileName(name, fileId = '') {
        const value = String(name || '').trim();
        if (!value || ['未命名文件', '未读取到文件名', '未命名'].includes(value)) return true;
        // Recognize names produced by older versions, including exported docs.
        return [`Drive_File_${fileId}`, `Drive_${fileId}`].some(prefix => fileId &&
            (value === prefix || value.startsWith(prefix + '.')));
    }
    const api = { uniqueLinks, toLinkList, toInputList, downloadUrls, parseLink, parseText, parseClipboard, toTSV, isMissingFileName };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.GoogleDriveInput = api;
})(typeof window !== 'undefined' ? window : globalThis);
