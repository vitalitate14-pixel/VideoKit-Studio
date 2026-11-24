(function (root) {
    'use strict';
    const normalize = text => String(text || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    const basename = name => String((typeof name === 'object' && name ? name.path || name.source || name.name : name) || '').split(/[/\\]/).pop().replace(/\.(mp4|mov|mkv|webm|avi|jpg|jpeg|png)$/i, '');
    const nameKey = name => normalize(basename(name));
    const cleanClipKey = name => normalize(basename(String((typeof name === 'object' && name ? name.path || name.source || name.name : name) || '').normalize('NFKC')).replace(/(?:\s+[(（]\s*\d+\s*[)）]|[_-]v\d+|[_-]副本\d*)+$/gi, ''));
    const PARSE_CACHE_LIMIT = 16;
    const PAIR_SCRIPT_CACHE_LIMIT = 32;
    const parseTableCache = new Map();
    const recordMetaCache = new WeakMap();
    const recordsIndexCache = new WeakMap();

    function buildBigrams(normStr) {
        const map = new Map();
        for (let i = 0; i < normStr.length - 1; i++) {
            const pair = normStr.slice(i, i + 2);
            map.set(pair, (map.get(pair) || 0) + 1);
        }
        return map;
    }

    function similarityNormalized(a, aBigrams, b, bBigrams) {
        if (!a || !b) return 0;
        if (a === b) return 1;
        if (Math.min(a.length, b.length) >= 12 && (a.includes(b) || b.includes(a))) return .96;
        const aa = aBigrams || buildBigrams(a);
        const bb = bBigrams || buildBigrams(b);
        let overlap = 0;
        for (const [key, count] of aa) overlap += Math.min(count, bb.get(key) || 0);
        return 2 * overlap / Math.max(1, a.length + b.length - 2);
    }

    function getRecordMeta(record) {
        if (!record || typeof record !== 'object') {
            return { normText: '', bigrams: null, col2Raw: '', col2NameKey: '', col2CleanKey: '' };
        }
        const rawText = String(record.text || '');
        const col2Raw = String(record.columns?.[2] || '');
        const cached = recordMetaCache.get(record);
        if (cached && cached.rawText === rawText && cached.col2Raw === col2Raw) return cached;
        const normText = normalize(rawText);
        const meta = {
            rawText,
            col2Raw,
            col2Trimmed: col2Raw.trim(),
            normText,
            bigrams: normText.length >= 2 ? buildBigrams(normText) : null,
            col2NameKey: col2Raw ? nameKey(col2Raw) : '',
            col2CleanKey: col2Raw ? cleanClipKey(col2Raw) : '',
        };
        recordMetaCache.set(record, meta);
        return meta;
    }

    function setIntersects(setA, setB) {
        if (!setA || !setB || !setA.size || !setB.size) return false;
        const [smaller, larger] = setA.size <= setB.size ? [setA, setB] : [setB, setA];
        for (const item of smaller) {
            if (larger.has(item)) return true;
        }
        return false;
    }

    function getRecordsIndex(records) {
        if (!Array.isArray(records)) return null;
        const first = records[0] || null;
        const last = records.length ? records[records.length - 1] : null;
        const cached = recordsIndexCache.get(records);
        if (cached && cached.length === records.length && cached.first === first && cached.last === last) {
            return cached;
        }
        const groups = new Map();
        const byCleanClipKey = new Map();
        const clipKeysByGroup = new Map();
        const clipKeysBySuite = new Map();
        for (const record of records) {
            const meta = getRecordMeta(record);
            if (!groups.has(record.group)) groups.set(record.group, []);
            groups.get(record.group).push(record);
            if (record.suiteGroup && record.suiteGroup !== record.group) {
                const sKey = `suite:${record.suiteGroup}`;
                if (!groups.has(sKey)) groups.set(sKey, []);
                groups.get(sKey).push(record);
            }
            if (meta.col2CleanKey) {
                if (!byCleanClipKey.has(meta.col2CleanKey)) byCleanClipKey.set(meta.col2CleanKey, []);
                byCleanClipKey.get(meta.col2CleanKey).push(record);
            }
            if (meta.col2NameKey || meta.col2CleanKey) {
                if (!clipKeysByGroup.has(record.group)) clipKeysByGroup.set(record.group, new Set());
                const gSet = clipKeysByGroup.get(record.group);
                if (meta.col2NameKey) gSet.add(meta.col2NameKey);
                if (meta.col2CleanKey) gSet.add(meta.col2CleanKey);
                if (record.suiteGroup) {
                    if (!clipKeysBySuite.has(record.suiteGroup)) clipKeysBySuite.set(record.suiteGroup, new Set());
                    const sSet = clipKeysBySuite.get(record.suiteGroup);
                    if (meta.col2NameKey) sSet.add(meta.col2NameKey);
                    if (meta.col2CleanKey) sSet.add(meta.col2CleanKey);
                }
            }
        }
        for (const [gKey, rows] of groups.entries()) {
            if (rows.length > 1) groups.set(gKey, dedupeRecords(rows));
        }
        const index = {
            length: records.length,
            first,
            last,
            groups,
            byCleanClipKey,
            clipKeysByGroup,
            clipKeysBySuite,
            pairScriptCache: new Map(),
        };
        recordsIndexCache.set(records, index);
        return index;
    }
    function extractScriptFromPrompt(rawPrompt) {
        const raw = String(rawPrompt || '').trim();
        if (!raw) return '';
        const tagged = raw.match(/(?:文案|台词|对白|旁白|口播|spoken|dialogue|script)\s*[:：]?\s*[“"「]([\s\S]*?)[”"」]\s*(?=\r?\n|$)/i);
        if (tagged?.[1]?.trim()) return tagged[1].trim();
        const enTagged = raw.match(/(?:says?|speaks?|speaking|reads?|reading|utters?)\s*(?:aloud|the following|these words)?\s*[:：,]?\s*[“"「]([\s\S]*?)[”"」]/i);
        if (enTagged?.[1]?.trim()) return enTagged[1].trim();
        const quotes = [];
        const re = /(?:"([^"\n]{4,}[\s\S]*?)"|“([^”]{4,})”|「([^」]{4,})」)/g;
        let m;
        while ((m = re.exec(raw)) !== null) {
            const candidate = (m[1] || m[2] || m[3] || '').trim();
            if (candidate && !/^(?:true|false|16:9|9:16|1080p|720p)$/i.test(candidate)) quotes.push(candidate);
        }
        if (quotes.length === 1) return quotes[0];
        if (quotes.length > 1) return quotes.sort((a, b) => b.length - a.length)[0];
        return '';
    }
    function parseHedraOrigin(value) {
        try {
            const origin = typeof value === 'string' ? JSON.parse(value)?.hedraOrigin : value;
            if (!origin || typeof origin.tabId !== 'string' || !origin.tabId || typeof origin.rowId !== 'string' || !origin.rowId) return undefined;
            return {tabId: origin.tabId, rowId: origin.rowId,
                ...(typeof origin.sourceId === 'string' && origin.sourceId ? {sourceId: origin.sourceId} : {}),
                ...(typeof origin.tabName === 'string' ? {tabName: origin.tabName} : {})};
        } catch (_) { return undefined; }
    }
    function dedupeRecords(records) {
        const stripVideoExt = value => String(value || '').trim().replace(/\.(mp4|mov|mkv|webm|avi|m4v)$/i, '');
        const groups = new Map();
        for (const record of records) {
            const cols = (record.columns || []).slice(0, 4).map((v, idx) => idx === 2 ? stripVideoExt(v) : String(v || '').trim());
            const content = JSON.stringify([...cols, normalize(record.text || record.spokenScript || '')]);
            if (!groups.has(content)) groups.set(content, []);
            groups.get(content).push(record);
        }
        const byOrigin = new Map();
        const result = [];
        for (const group of groups.values()) {
            const origins = new Map();
            for (const record of group) {
                const origin = parseHedraOrigin(record.hedraOrigin);
                if (!origin) continue;
                const key = JSON.stringify([origin.sourceId || '', origin.tabId, origin.rowId]);
                const existing = origins.get(key);
                if (existing) {
                    if (existing.duplicateCount === undefined) {
                        const idx = result.indexOf(existing);
                        const cloned = {...existing, duplicateCount: 2};
                        origins.set(key, cloned);
                        if (byOrigin.get(key) === existing) byOrigin.set(key, cloned);
                        if (idx >= 0) result[idx] = cloned;
                    } else existing.duplicateCount++;
                } else {
                    const item = group.length === 1 && record.hedraOrigin && typeof record.hedraOrigin === 'object'
                        ? record
                        : {...record, hedraOrigin: origin, duplicateCount: 1};
                    origins.set(key, item);
                }
            }
            // An older four-column copy is not a second task when one exact origin is known.
            if (origins.size) {
                if (origins.size === 1) {
                    const extra = group.filter(r => !parseHedraOrigin(r.hedraOrigin)).length;
                    if (extra > 0) {
                        const onlyKey = [...origins.keys()][0];
                        let only = origins.get(onlyKey);
                        if (only.duplicateCount === undefined) only = {...only, duplicateCount: 1 + extra};
                        else only.duplicateCount += extra;
                        origins.set(onlyKey, only);
                    }
                }
                for (const [key, item] of origins.entries()) {
                    const prev = byOrigin.get(key);
                    if (prev) {
                        const add = item.duplicateCount || 1;
                        if (prev.duplicateCount === undefined) {
                            const idx = result.indexOf(prev);
                            const cloned = {...prev, duplicateCount: 1 + add};
                            byOrigin.set(key, cloned);
                            if (idx >= 0) result[idx] = cloned;
                        } else prev.duplicateCount += add;
                    } else {
                        byOrigin.set(key, item);
                        result.push(item);
                    }
                }
            } else if (group.length === 1) {
                result.push(group[0]);
            } else {
                result.push({...group[0], duplicateCount: group.length});
            }
        }
        return result;
    }
    function parseTable(text) {
        const cacheKey = String(text || '');
        if (parseTableCache.has(cacheKey)) {
            const cached = parseTableCache.get(cacheKey);
            parseTableCache.delete(cacheKey);
            parseTableCache.set(cacheKey, cached);
            return cached;
        }
        const rows = []; let row = [], cell = '', quoted = false;
        text = cacheKey.replace(/^\uFEFF/, '');
        for (let i = 0; i < text.length; i++) {
            const c = text[i];
            if (c === '"' && (quoted || !cell)) {
                if (quoted && text[i + 1] === '"') { cell += '"'; i++; }
                else quoted = !quoted;
            } else if (!quoted && (c === '\t' || c === '\n' || c === '\r')) {
                row.push(cell); cell = '';
                if (c !== '\t') {
                    if (c === '\r' && text[i + 1] === '\n') i++;
                    if (row.some(v => v.trim())) rows.push(row);
                    row = [];
                }
            } else cell += c;
        }
        if (quoted) throw new Error('描述词的双引号未闭合，请完整复制表格单元格');
        row.push(cell); if (row.some(v => v.trim())) rows.push(row);
        const parsed = rows.map((columns, index) => {
            if (columns.length < 4 || !columns[3].trim()) throw new Error(`第 ${index + 1} 行需要至少四列，第四列描述词不能为空（名称可留空）`);
            const extractedText = extractScriptFromPrompt(columns[3]);
            const suitePrefix = basename(columns[2]).match(/^(.*?)[-_]片段\s*\d+/i)?.[1] || '';
            return {
                id: index,
                columns: columns.slice(0, 4),
                hedraOrigin: parseHedraOrigin(columns[5]),
                text: columns[4]?.trim() || extractedText || '',
                group: nameKey(columns[0]),
                suiteGroup: suitePrefix ? nameKey(suitePrefix) : '',
            };
        });
        if (parseTableCache.size >= PARSE_CACHE_LIMIT) {
            const oldestKey = parseTableCache.keys().next().value;
            parseTableCache.delete(oldestKey);
        }
        parseTableCache.set(cacheKey, parsed);
        return parsed;
    }
    function matchReviewGroup(row, records) {
        // Only remove known download/version suffixes; segment numbers remain significant.
        const key = value => nameKey(basename(String(value || '').normalize('NFKC')).replace(/(?:\s*\(\s*\d+\s*\)|[_-]v\d+)+$/gi, ''));
        const names = new Set([row.groupName, ...(row.candidates || []).map(file => file.name)].map(key).filter(Boolean));
        const exact = records.filter(record => key(record.columns[2]) && names.has(key(record.columns[2])));
        const suiteKey = key(String(row.suite || '').replace(/^\d+[_-]\d+[-_]/, ''));
        const scoped = exact.filter(record => key(record.columns[0]) === suiteKey || (record.suiteGroup && record.suiteGroup === suiteKey));
        const rawCandidates = scoped.length ? scoped : exact;
        const candidates = rawCandidates.length > 1 ? dedupeRecords(rawCandidates) : rawCandidates;
        return { selected: candidates.length === 1 ? candidates : [], candidates, ambiguous: candidates.length > 1 };
    }
    function collectIssues(task) {
        const result = task.result || {};
        const issues = [];
        const script = String(task.script || result.script_text || '').trim();
        const segments = task.reviewSegments || result.review_segments || result.segments || [];
        if (!task.clips?.length && script && !result.missing_blocks?.length && !segments.length) {
            return [{ kind: 'missing', text: script, source: '', label: '无对应视频任务 · 待生成文案',
                startLine: 1, endLine: script.split(/\r?\n/).filter(line => line.trim()).length, withoutTask: true }];
        }
        for (const block of result.missing_blocks || []) {
            if (!block.review_assignment && block.text?.trim()) issues.push({ kind: 'missing', text: block.text, source: '', label: '缺失文案', startLine: Number.isInteger(block.startLine) ? block.startLine + 1 : null, endLine: Number.isInteger(block.endLine) ? block.endLine + 1 : null });
        }
        for (const segment of segments) {
            if (segment.review_acknowledged === true || !['warning', 'error'].includes(segment.status)) continue;
            issues.push({ kind: 'segment', text: segment.script || segment.expected_text || segment.script_text || segment.text || segment.matched_text || '',
                startLine: segment.script_start_line, endLine: segment.script_end_line, recognized: segment.recognized_text || '', source: segment.source || '', label: segment.issue_reason || '问题片段' });
        }
        return issues;
    }
    function similarity(a, b) {
        return similarityNormalized(normalize(a), null, normalize(b), null);
    }
    function getAlignedPairScript(rawScript, records, index) {
        const pairCache = index?.pairScriptCache;
        if (pairCache?.has(rawScript)) {
            const hit = pairCache.get(rawScript);
            pairCache.delete(rawScript);
            pairCache.set(rawScript, hit);
            return hit;
        }
        const lines = rawScript.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
        const lineNorms = lines.map(normalize);
        const linePrefixLengths = new Array(lineNorms.length + 1);
        linePrefixLengths[0] = 0;
        for (let i = 0; i < lineNorms.length; i++) linePrefixLengths[i + 1] = linePrefixLengths[i] + lineNorms[i].length;
        const script = lineNorms.join('');
        if (!script) {
            const emptyEntry = { empty: true };
            if (pairCache) pairCache.set(rawScript, emptyEntry);
            return emptyEntry;
        }
        const groups = index ? index.groups : (() => {
            const map = new Map();
            for (const record of records) {
                if (!map.has(record.group)) map.set(record.group, []);
                map.get(record.group).push(record);
                if (record.suiteGroup && record.suiteGroup !== record.group) {
                    const sKey = `suite:${record.suiteGroup}`;
                    if (!map.has(sKey)) map.set(sKey, []);
                    map.get(sKey).push(record);
                }
            }
            return map;
        })();
        const bestByGroup = [];
        for (const rows of groups.values()) {
            // Align all supplied split scripts in table order to the full line-broken script.
            // Keep tied paths so repeated text is resolved by its surrounding rows and line position.
            let paths = [{ cursor: 0, score: 0, spans: [] }];
            for (const record of rows) {
                const text = getRecordMeta(record).normText;
                if (!text) continue;
                const next = [];
                for (const path of paths) {
                    next.push(path);
                    let at = script.indexOf(text, path.cursor), occurrences = 0;
                    while (at >= 0 && occurrences++ < 48) {
                        next.push({ cursor: at + text.length, score: path.score + text.length,
                            spans: [...path.spans, { start: at, end: at + text.length, record }] });
                        at = script.indexOf(text, at + 1);
                    }
                }
                paths = next.sort((a, b) => b.score - a.score).slice(0, 48);
            }
            const bestScore = paths[0]?.score || 0;
            if (bestScore > 0) {
                bestByGroup.push({ bestScore, bestPaths: paths.filter(p => p.score === bestScore) });
            }
        }
        const entry = { empty: false, linesCount: lines.length, lineNorms, linePrefixLengths, script, bestByGroup };
        if (pairCache) {
            if (pairCache.size >= PAIR_SCRIPT_CACHE_LIMIT) {
                const oldestKey = pairCache.keys().next().value;
                pairCache.delete(oldestKey);
            }
            pairCache.set(rawScript, entry);
        }
        return entry;
    }
    function pairScript(issue, task, records) {
        const rawScript = String(task.script || task.result?.script_text || '');
        const target = normalize(issue.text);
        if (!rawScript || !target) return null;
        const index = getRecordsIndex(records);
        const aligned = getAlignedPairScript(rawScript, records, index);
        if (aligned.empty) return null;
        let start = -1, end = -1;
        if (issue.startLine > 0 && issue.endLine >= issue.startLine && issue.endLine <= aligned.linesCount) {
            const before = aligned.linePrefixLengths[issue.startLine - 1];
            const range = aligned.lineNorms.slice(issue.startLine - 1, issue.endLine).join('');
            const within = range.indexOf(target);
            if (within >= 0) { start = before + within; end = start + target.length; }
        }
        if (start < 0) {
            start = aligned.script.indexOf(target);
            if (start < 0 || aligned.script.indexOf(target, start + 1) >= 0) return null;
            end = start + target.length;
        }
        const paired = [];
        for (const { bestScore, bestPaths } of aligned.bestByGroup) {
            for (const path of bestPaths) {
                const overlap = path.spans.filter(p => p.start < end && p.end > start);
                const covered = overlap.reduce((sum, p) => sum + Math.min(p.end, end) - Math.max(p.start, start), 0);
                if (covered >= target.length * .95) paired.push({ records: overlap.map(p => p.record), score: bestScore });
            }
        }
        if (!paired.length) return null;
        const bestScore = Math.max(...paired.map(p => p.score));
        let best = paired.filter(p => p.score === bestScore);
        const clipKeys = new Set([...(task.clips || []).map(nameKey), ...(task.clips || []).map(cleanClipKey)].filter(Boolean));
        if (clipKeys.size) {
            const scoped = index
                ? best.filter(p => {
                    const firstRec = p.records[0];
                    return setIntersects(index.clipKeysByGroup.get(firstRec.group), clipKeys)
                        || Boolean(firstRec.suiteGroup && setIntersects(index.clipKeysBySuite.get(firstRec.suiteGroup), clipKeys));
                })
                : best.filter(p => records.some(r => (r.group === p.records[0].group || (r.suiteGroup && r.suiteGroup === p.records[0].suiteGroup)) && (clipKeys.has(nameKey(r.columns[2])) || clipKeys.has(cleanClipKey(r.columns[2])))));
            if (scoped.length) best = scoped;
        }
        const alternatives = [...new Map(best.map(p => [p.records.map(r => r.id).join(','), p.records])).values()];
        return { selected: alternatives.length === 1 ? alternatives[0] : [],
            candidates: [...new Set(alternatives.flat())].map(record => ({ record, textScore: 1 })),
            ambiguous: alternatives.length > 1, paired: true };
    }
    function matchVideoName(source, records) {
        const key = cleanClipKey(source);
        if (!key) return {selected:[], candidates:[], ambiguous:false};
        const index = getRecordsIndex(records);
        const matching = index
            ? (index.byCleanClipKey.get(key) || [])
            : records.filter(record => record.columns?.[2] && cleanClipKey(record.columns[2]) === key);
        const candidates = dedupeRecords(matching);
        return {selected:candidates.length === 1 ? candidates : [], candidates, ambiguous:candidates.length > 1};
    }
    function matchIssue(issue, task, records) {
        const paired = pairScript(issue, task, records);
        if (paired) return paired;
        // Other clips from the same task establish which image set a missing clip belongs to.
        const clipKeys = new Set([...(task.clips || []).map(nameKey), ...(task.clips || []).map(cleanClipKey)].filter(Boolean));
        const scopedGroups = new Set();
        const taskKey = nameKey(task.outputName || task.name);
        const hasTaskKey = taskKey.length >= 8;
        for (const r of records) {
            const meta = getRecordMeta(r);
            if (clipKeys.size && (clipKeys.has(meta.col2NameKey) || clipKeys.has(meta.col2CleanKey))) {
                if (r.group) scopedGroups.add(r.group);
                if (r.suiteGroup) scopedGroups.add(r.suiteGroup);
            }
            if (hasTaskKey && (r.group.includes(taskKey) || (r.suiteGroup && r.suiteGroup.includes(taskKey)) || meta.col2NameKey.includes(taskKey))) {
                if (r.group) scopedGroups.add(r.group);
                if (r.suiteGroup) scopedGroups.add(r.suiteGroup);
            }
        }
        const inferredKeys = new Set((issue.inferredMissingNames || []).flatMap(n => [nameKey(n), cleanClipKey(n)]).filter(Boolean));
        const issueSourceNameKey = issue.source ? nameKey(issue.source) : '';
        const issueSourceCleanKey = issue.source ? cleanClipKey(issue.source) : '';
        const queryNorm = normalize(issue.text || issue.recognized);
        const queryBigrams = queryNorm.length >= 2 ? buildBigrams(queryNorm) : null;
        const issueTextNorm = normalize(issue.text);
        const candidates = records.map(record => {
            const meta = getRecordMeta(record);
            const exactName = Boolean(
                (issue.source && meta.col2Trimmed && (issueSourceNameKey === meta.col2NameKey || issueSourceCleanKey === meta.col2CleanKey)) ||
                (issue.kind === 'missing' && inferredKeys.size > 0 && (inferredKeys.has(meta.col2NameKey) || inferredKeys.has(meta.col2CleanKey)))
            );
            const textScore = similarityNormalized(queryNorm, queryBigrams, meta.normText, meta.bigrams);
            const inScope = scopedGroups.has(record.group) || Boolean(record.suiteGroup && scopedGroups.has(record.suiteGroup));
            return { record, meta, textScore, exactName, inScope, score: textScore };
        }).sort((a, b) => b.score - a.score);
        // Names only break ties between similarly matching scripts; they never replace missing script evidence.
        const bestText = candidates[0]?.textScore || 0;
        const reliable = issueTextNorm ? candidates.filter(c => c.textScore >= .82 && bestText - c.textScore <= .03) : [];
        const named = reliable.filter(c => c.exactName);
        const scoped = reliable.filter(c => c.inScope);
        const preferred = named.length ? named : scoped.length ? scoped : reliable;
        const uniquePreferred = dedupeRecords(preferred.map(c => c.record));
        const uniqueReliable = dedupeRecords(reliable.map(c => c.record));
        let selected = uniquePreferred.length === 1 ? [uniquePreferred[0]] : [];
        // A missing block can span multiple complete generation rows in one uniquely identified image set.
        if (issue.kind === 'missing') {
            const contained = candidates.filter(c => c.meta.normText.length >= 12 && issueTextNorm.includes(c.meta.normText));
            const groups = new Map();
            for (const c of contained) {
                const gKey = c.record.suiteGroup || c.record.group;
                if (!groups.has(gKey)) groups.set(gKey, []);
                groups.get(gKey).push(c);
            }
            const allGroups = [...groups.entries()];
            const scoped = allGroups.filter(([group]) => scopedGroups.has(group));
            const possible = scoped.length ? scoped : allGroups;
            if (possible.length === 1 && possible[0][1].length > 1) {
                const rows = dedupeRecords(possible[0][1].map(c => c.record));
                if (rows.length > 1) {
                    const uniqueTexts = new Set(rows.map(r => getRecordMeta(r).normText));
                    if (uniqueTexts.size === rows.length) selected = rows;
                }
            }
            if (!selected.length && inferredKeys.size > 0) {
                const byInferred = dedupeRecords(candidates.filter(c => c.exactName).map(c => c.record));
                const uniqueInferredNames = new Set(byInferred.map(r => cleanClipKey(r.columns?.[2])).filter(Boolean));
                if (byInferred.length >= 1 && uniqueInferredNames.size === byInferred.length) selected = byInferred;
            }
        }
        return { selected, candidates: candidates.filter(c => c.textScore >= .3 || c.exactName).slice(0, 12).map(({ meta, ...rest }) => rest), ambiguous: !selected.length && uniqueReliable.length > 1 };
    }
    function unassignedScripts(tasks, cells, unmatched = []) {
        // Match by script content, not the number/order of folders: tasks can be reordered by smart pairing.
        const assigned = new Set(tasks.map(task => normalize(task.script || task.result?.script_text)).filter(Boolean));
        const inputs = unmatched.length ? unmatched : cells.map((script, originalIndex) => ({ script, originalIndex }));
        return inputs.filter(item => normalize(item.script) && !assigned.has(normalize(item.script)));
    }
    function associatedVideoTasks(record, tasks) {
        const matches = tasks.map(task => ({ task, sources: recordVideoSources(record, task, {}) })).filter(item => item.sources.length);
        const key = cleanClipKey(record.columns[2]) || nameKey(record.columns[2]);
        const named = key ? matches.filter(item => item.sources.some(source => cleanClipKey(source) === key || nameKey(source) === key)) : [];
        return named.length ? named : matches.length === 1 ? matches : [];
    }
    function recordVideoSources(record, task, issue) {
        if (issue?.source) return [issue.source];
        const clipPaths = (task.clips || []).map(clip => typeof clip === 'string' ? clip : clip?.path).filter(Boolean);
        const segments = task.reviewSegments || task.result?.review_segments || task.result?.segments || [];
        const byText = segments.filter(segment => segment.source && similarity(record.text,
            segment.script || segment.expected_text || segment.script_text || segment.text || segment.matched_text) >= .82).map(segment => segment.source);
        if (byText.length) return [...new Set(byText)];
        const key = cleanClipKey(record.columns[2]) || nameKey(record.columns[2]);
        return key ? clipPaths.filter(source => cleanClipKey(source) === key || nameKey(source) === key) : [];
    }
    function missingText(expected, actual) {
        const words = text => [...String(text || '').matchAll(/[\p{Script=Han}]|[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)]
            .map(m => ({ text: m[0], key: normalize(m[0]), start: m.index, end: m.index + m[0].length }));
        const a = words(expected), b = words(actual);
        if (!a.length || !b.length || a.length * b.length > 1000000) return '';
        const dp = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
        for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--)
            dp[i][j] = a[i].key === b[j].key ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
        const matched = new Set(); let i = 0, j = 0;
        while (i < a.length && j < b.length) {
            if (a[i].key === b[j].key) { matched.add(i); i++; j++; }
            else if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++;
        }
        const parts = [];
        for (let at = 0; at < a.length; at++) {
            if (matched.has(at)) continue;
            const first = at; while (at + 1 < a.length && !matched.has(at + 1)) at++;
            parts.push(expected.slice(a[first].start, a[at].end));
        }
        return parts.join('\n');
    }
    function issueFeedback(record, task, issue) {
        const expected = record.text || issue.text || '';
        const sources = recordVideoSources(record, task, issue);
        const originals = task.result?.segments || [];
        const reviews = task.reviewSegments || task.result?.review_segments || [];
        const segments = sources.map(source => reviews.find(s => s.source === source && s.recognized_text)
            || originals.find(s => s.source === source));
        const recognized = [...new Set(segments.map(s => s?.recognized_text).filter(Boolean))].join('\n') || issue.recognized || '';
        const usable = recognized && !/^\(?(转录失败|识别失败)/.test(recognized);
        const explicitMissing = issue.kind === 'missing';
        return { expected, actual: usable ? recognized : '未取得实际识别文案',
            missing: explicitMissing ? (issue.withoutTask ? expected : issue.text) : usable ? missingText(expected, recognized) : '',
            note: explicitMissing ? '缺失内容沿用列表审核反馈' : usable ? '缺少内容依据识别文本对比，请试听确认' : '识别结果不可用，暂无法判断具体漏读内容' };
    }
    function problemFeedback(record, task, issue) {
        const name = record?.columns?.[2] || issue.source || '';
        const number = basename(name).match(/片段\s*(\d+)/i)?.[1];
        const label = number ? `片段${number}` : '当前片段';
        if (issue.kind === 'missing') {
            const exists = record && (task.clips || []).some(clip => cleanClipKey(clip) === cleanClipKey(name) || nameKey(clip) === nameKey(name));
            return { label, title: exists ? '目标文案未被覆盖；同名素材存在，内容或切点需审核' : record ? '目标文案未被覆盖，未找到同名素材（片段未生成或未导入）' : '目标文案未被当前素材覆盖',
                severity: 'error', missing: record?.text && normalize(issue.text).includes(normalize(record.text)) ? record.text : issue.text || '', actual: '', expected: record?.text || issue.text || '' };
        }
        const coverage = issue.coverage;
        const missing = coverage?.missing || [], extra = coverage?.extra || [];
        const actual = coverage?.timingAvailable ? (coverage.text || '') : '';
        const recognized = issue.recognized || '';
        let title = '无法确定具体问题，请审核', severity = 'warning';
        if (!String(issue.text || '').trim()) return {label, title:'尚未匹配目标文案，无法判断识别内容是否匹配', severity:'warning', missing:'', extra:'', expected:'', actual, recognized};
        if (issue.kind === 'duplicate') title = '片段或文案可能重复，请审核';
        else if (coverage?.passed) { title = '剪后识别文案与目标文案一致'; severity = 'ok'; }
        else if (issue.fullTargetAvailable && missing.length) { title = '切点剪掉目标文案（依据逐词时间记录）'; severity = 'error'; }
        else if (missing.length >= 5 && !extra.length) { title = '缺少一段文案，需试听核实'; severity = 'error'; }
        else if (missing.length >= 5 || extra.length >= 5) { title = '文案不匹配，需核对素材内容'; severity = 'error'; }
        else if (missing.length || extra.length) title = '个别词缺失或不同，待确认';
        else if (coverage?.partial) title = '切点进入单词时间范围，待试听确认';
        return { label, title, severity, missing: missing.join(' '), extra: extra.join(' '), expected: issue.text || '', actual, recognized };
    }
    function exportTable(records) {
        const unique = [...new Map(records.map(r => [JSON.stringify(r.columns), r])).values()];
        const escapeCell = value => `"${String(value).replace(/"/g, '""')}"`;
        const html = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\r?\n/g, '<br>');
        return { count: unique.length, text: unique.map(r => r.columns.slice(0, 4).map(escapeCell).join('\t')).join('\n'),
            html: '<meta charset="utf-8"><table>' + unique.map(r => '<tr>' + r.columns.slice(0, 4).map(c => `<td style="white-space:pre-wrap;mso-data-placement:same-cell">${html(c)}</td>`).join('') + '</tr>').join('') + '</table>' };
    }
    const api = { dedupeRecords, parseHedraOrigin, problemFeedback, matchVideoName, matchReviewGroup, parseTable, collectIssues, matchIssue, exportTable, similarity, recordVideoSources, unassignedScripts, associatedVideoTasks, missingText, issueFeedback };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.AutoEditGeneration = api;
})(typeof window !== 'undefined' ? window : globalThis);
