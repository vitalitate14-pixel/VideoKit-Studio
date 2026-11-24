(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.NameMatching = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    const extension = /\.(?:mp4|mov|mkv|avi|webm|m4v|mp3|wav|m4a|txt|srt)\s*$/i;
    const headers = new Set(['原始名字', '原始名称', '原始文件名', '匹配名字', '正规名字', '正规名称', '文件名', 'original name', 'matched name']);

    function unwrap(value) {
        return String(value).trim().replace(/^\[([\s\S]*)\]\([^\n]*\)$/, '$1')
            .replace(/^\*\*([\s\S]*)\*\*$/, '$1').replace(/^`([\s\S]*)`$/, '$1')
            .replace(/\\([_!*\[\]()|&])/g, '$1').replace(/&#x20;|&#32;|&nbsp;/gi, ' ').trim();
    }

    // Read the first column of pasted TSV/Markdown while retaining every data row.
    function parseLines(input) {
        return String(input || '').replace(/^\uFEFF/, '').split(/\r\n|\n|\r/).flatMap(line => {
            let value = line.trim();
            if (!value || /^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?$/.test(value)) return [];
            if (value.startsWith('|')) value = value.slice(1).split(/(?<!\\)\|/)[0];
            else if (value.includes('\t')) value = value.split('\t')[0];
            value = unwrap(value);
            if (!value || headers.has(value.toLowerCase())) return [];
            return [value];
        });
    }

    function stripExtension(value) { return value.replace(extension, '').replace(/[.\s]+$/g, ''); }

    function extractTitle(value) {
        let title = unwrap(value);
        if (/^V\d+-\d+_/i.test(title)) {
            // Project metadata ends before the numbered title / HN / 公共 marker.
            const marker = title.match(/_(?=(?:\d+、|HN-\d+_|公共-\d+_))/i);
            if (marker) title = title.slice(marker.index + 1);
        }
        title = title.replace(/^(?:\d+、|HN-\d+_|公共-\d+_)/i, '');
        title = title.replace(/_[^_]*的图_[\s\S]*$/, '');
        title = stripExtension(title).replace(/_\d+$/, '').replace(/_+$/g, '');
        return title.trim();
    }

    function normalize(value) {
        return stripExtension(String(value).normalize('NFKC')).toLowerCase()
            .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
    }

    function numberSignature(value) {
        const numbers = { one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10' };
        return value.split(' ').filter(word => /^\d+$/.test(word) || numbers[word]).map(word => numbers[word] || word).sort().join(',');
    }

    function similarity(a, b) {
        if (a === b) return 1;
        if (!a || !b || numberSignature(a) !== numberSignature(b)) return 0;
        if (a.split(' ').length >= 6 && b.startsWith(a + ' ')) return .94;
        const wordsA = new Set(a.split(' ')), wordsB = new Set(b.split(' '));
        const overlap = [...wordsA].filter(word => wordsB.has(word)).length;
        const dice = 2 * overlap / (wordsA.size + wordsB.size);
        // Character edit distance also accounts for word order and spelling errors.
        if (Math.max(a.length, b.length) > 1000) return dice * .8;
        let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
        for (let i = 1; i <= a.length; i++) {
            const next = [i];
            for (let j = 1; j <= b.length; j++) next[j] = Math.min(next[j - 1] + 1, previous[j] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
            previous = next;
        }
        return .6 * (1 - previous[b.length] / Math.max(a.length, b.length)) + .4 * dice;
    }

    function matchNames(originalInput, canonicalInput) {
        const originals = parseLines(originalInput);
        const candidates = [...new Set(parseLines(canonicalInput))].map((name, index) => ({ name, index, key: normalize(extractTitle(name)) }));
        const cache = new Map();
        return originals.map(original => {
            const title = extractTitle(original), key = normalize(title);
            if (!cache.has(title)) {
                const exact = candidates.filter(candidate => key && candidate.key === key);
                let ranked;
                if (exact.length) ranked = exact.map(candidate => ({ ...candidate, score: 1 }));
                else ranked = candidates.map(candidate => ({ ...candidate, score: similarity(key, candidate.key) }))
                    .filter(candidate => candidate.score >= .55).sort((a, b) => b.score - a.score || a.index - b.index).slice(0, 5);
                const top = ranked[0];
                const status = exact.length === 1 ? 'exact' : exact.length > 1 ? 'ambiguous' : top?.score >= .82 ? 'review' : 'unmatched';
                // A shared title with different punctuation/extensions has no unique canonical filename.
                cache.set(title, { title, matched: status === 'unmatched' ? '' : top.name, status, score: top?.score || 0,
                    suggestions: ranked.map(({ name, score }) => ({ name, score })) });
            }
            const cached = cache.get(title);
            return { original, ...cached, suggestions: cached.suggestions.map(candidate => ({ ...candidate })) };
        });
    }

    function exportTable(rows, format = 'tsv', header = true) {
        const data = rows.map(row => [row.original, row.matched]);
        if (header) data.unshift(['原始名字', '匹配名字']);
        if (format === 'csv') return '\uFEFF' + data.map(row => row.map(value => '"' + String(value || '').replace(/"/g, '""') + '"').join(',')).join('\r\n');
        if (format === 'markdown') {
            const escape = value => String(value || '').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
            const lines = data.map(row => '| ' + row.map(escape).join(' | ') + ' |');
            if (header) lines.splice(1, 0, '|---|---|');
            return lines.join('\n');
        }
        return data.map(row => row.map(value => String(value || '').replace(/[\t\r\n]+/g, ' ')).join('\t')).join('\n');
    }
    return { parseLines, extractTitle, normalize, matchNames, exportTable };
});
