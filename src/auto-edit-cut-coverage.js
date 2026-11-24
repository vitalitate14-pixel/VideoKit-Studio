(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.AutoEditCutCoverage = api;
})(typeof window === 'object' ? window : globalThis, function () {
    const small = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
    const tens = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
    function spokenNumber(value) {
        const number = Number(value);
        if (number < 20) return small[number];
        if (number < 100) return [tens[Math.floor(number / 10)], number % 10 ? small[number % 10] : ''].filter(Boolean).join(' ');
        return [small[Math.floor(number / 100)], 'hundred', number % 100 ? spokenNumber(number % 100) : ''].filter(Boolean).join(' ');
    }
    const monthNames = 'january february march april may june july august september october november december'.split(' ');
    function calendarSpans(text) {
        // Only explicit numeric month/day dates and named-month day lists qualify.
        const pattern = /\b(?:0?[1-9]|1[0-2])\/\d{1,2}(?:\/(?:\d{4}|\d{1,2}))?\b|\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}(?:st|nd|rd|th)?(?:[ ,]+(?:and\s+)?\d{1,2}(?:st|nd|rd|th)?)*\b/gi;
        return Array.from(String(text || '').matchAll(pattern)).map(match => {
            let normalized = match[0];
            if (normalized.includes('/')) {
                const [month, day, tail] = normalized.split('/');
                if (Number(day) < 1 || Number(day) > 31) return null;
                let days = [Number(day)];
                if (tail) {
                    // 1314 is a collapsed day list; 2026 is a year, not 20 + 26.
                    if (tail.length === 4 && !/^(19|20)\d{2}$/.test(tail)) {
                        const pair = [Number(tail.slice(0,2)), Number(tail.slice(2))];
                        if (!pair.every(n => n >= 1 && n <= 31)) return null;
                        days.push(...pair);
                    } else if (tail.length <= 2 && Number(tail) >= 1 && Number(tail) <= 31) days.push(Number(tail));
                    else return null;
                }
                normalized = monthNames[Number(month)-1] + ' ' + days.join(' ');
            } else {
                const days = normalized.match(/\d+/g).map(Number);
                if (!days.every(n => n >= 1 && n <= 31)) return null;
                normalized = normalized.replace(/(\d+)(?:st|nd|rd|th)/gi, '$1').replace(/\band\b|,/gi, ' ');
            }
            return {start:match.index, end:match.index+match[0].length, normalized};
        }).filter(Boolean);
    }
    function normalize(text, language = 'en') {
        let value = String(text || '').normalize('NFKC').toLowerCase();
        const contractions = {"you're":'you are',"we're":'we are',"they're":'they are',"i'm":'i am',"don't":'do not',"doesn't":'does not',"didn't":'did not',"isn't":'is not',"aren't":'are not',"wasn't":'was not',"weren't":'were not',"can't":'cannot',"won't":'will not',"you've":'you have',"we've":'we have',"they've":'they have',"i've":'i have',"you'll":'you will',"we'll":'we will',"they'll":'they will',"i'll":'i will'};
        if (/^(en|auto)(-|$)/i.test(language)) value = value.replace(/\b[a-z]+['’][a-z]+\b/g, word => contractions[word.replace('’', "'")] || word);

        if (/^(en|auto)(-|$)/i.test(language)) {
            for (const span of calendarSpans(value).reverse()) value = value.slice(0,span.start) + span.normalized + value.slice(span.end);
            value = value.replace(/\b(\d{1,3})(?:st|nd|rd|th)\b/g, (_, number) => {
                const ordinal = {one:'first',two:'second',three:'third',five:'fifth',eight:'eighth',nine:'ninth',twelve:'twelfth'};
                const parts = spokenNumber(number).split(' ');
                const last = parts.pop();
                parts.push(ordinal[last] || (last.endsWith('y') ? last.slice(0,-1)+'ieth' : last+'th'));
                return parts.join(' ');
            }).replace(/\b\d{1,3}\b/g, spokenNumber).replace(/%/g, ' percent ').replace(/\bper\s+cent\b/g, 'percent');
        }
        return value.replace(/[\p{Pd}]/gu, ' ').replace(/['’`´]/g, '');
    }
    function tokens(text, language) {
        const words = normalize(text, language).match(/[\p{L}\p{N}]+/gu) || [];
        return /^(en|auto)(-|$)/i.test(language) ? calendarKeys(words).filter(Boolean) : words;
    }
    function calendarKeys(words) {
        const months = new Set('january february march april may june july august september october november december'.split(' '));
        const ordinals = 'first second third fourth fifth sixth seventh eighth ninth tenth eleventh twelfth thirteenth fourteenth fifteenth sixteenth seventeenth eighteenth nineteenth'.split(' ');
        let date = false;
        return words.map((word, index) => {
            if (months.has(word)) { date = true; return word; }
            if (!date) return word;
            if (word === 'and' && (small.includes(words[index+1]) || tens.includes(words[index+1]) || ordinals.includes(words[index+1]))) return '';
            if (word === 'and' || word === 'the' || word === 'of') return word;
            const ordinal = ordinals.indexOf(word);
            if (ordinal >= 0) return small[ordinal + 1];
            if (small.includes(word) || tens.includes(word) || word === 'twentieth' || word === 'thirtieth') return word === 'twentieth' ? 'twenty' : word === 'thirtieth' ? 'thirty' : word;
            date = false; return word;
        });
    }
    function align(target, source) {
        const targetKeys = calendarKeys(target), sourceKeys = calendarKeys(source);
        const dp = Array.from({ length: target.length + 1 }, () => new Uint32Array(source.length + 1));
        for (let i = target.length - 1; i >= 0; i--) for (let j = source.length - 1; j >= 0; j--) {
            dp[i][j] = targetKeys[i] === sourceKeys[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
        const matches = [], missing = [];
        let i = 0, j = 0;
        while (i < target.length) {
            if (j < source.length && targetKeys[i] === sourceKeys[j]) { matches.push({ targetIndex: i++, sourceIndex: j++ }); }
            else if (j >= source.length || dp[i + 1][j] >= dp[i][j + 1]) missing.push(i++);
            else j++;
        }
        return { matches, missing };
    }
    function inspect({ script, words = [], start, end, language = 'en' }) {
        const target = tokens(script, language);
        const timed = words.flatMap((word, index) => word && Number.isFinite(Number(word.start)) && Number.isFinite(Number(word.end))
            ? tokens(word.raw || word.word, language).map(token => ({ token, index, start: Number(word.start), end: Number(word.end) })) : []);
        if (!target.length || !timed.length || !Number.isFinite(Number(start)) || !Number.isFinite(Number(end))) return { available: false, removed: [] };
        const full = align(target, timed.map(word => word.token));
        // 保留完整词音；越过边界超过 40ms 才计入，容忍浮点及时间戳抖动。
        const retained = timed.filter(word => word.start >= Number(start) - 0.04 && word.end <= Number(end) + 0.04);
        const kept = align(target, retained.map(word => word.token));
        const retainedSet = full.matches.length > kept.matches.length ? new Set(retained) : null;
        const removed = retainedSet
            ? full.matches.filter(match => !retainedSet.has(timed[match.sourceIndex])).map(match => target[match.targetIndex]) : [];
        return { available: true, removed, fullMatched: full.matches.length, keptMatched: kept.matches.length, targetCount: target.length };
    }
    function textCoverage(script, recognized, language = 'en') {
        const target = tokens(script, language), source = tokens(recognized, language);
        const aligned = align(target, source);
        const matchedSource = new Set(aligned.matches.map(match => match.sourceIndex));
        const missing = aligned.missing.map(index => target[index]);
        const extra = source.filter((_, index) => !matchedSource.has(index));
        return { missing, extra, equal: !missing.length && !extra.length };
    }
    function croppedText({ recognized, words = [], start, end, language = 'en', removeRanges = [] }) {
        const timed = words.filter(word => word && Number.isFinite(Number(word.start)) && Number.isFinite(Number(word.end))
            && tokens(word.raw || word.word, language).length);
        const hasRange = Number.isFinite(Number(start)) && Number.isFinite(Number(end)) && Number(end) > Number(start);
        // 审核输入显示毫秒；忽略三位小数舍入产生的半毫秒边界重叠。
        const roundingTolerance = 0.00051;
        const retained = hasRange && timed.length ? timed.filter(word => Number(word.end) > Number(start) + roundingTolerance && Number(word.start) < Number(end) - roundingTolerance && !removeRanges.some(range => Number(word.start) < Number(range.end) - roundingTolerance && Number(word.end) > Number(range.start) + roundingTolerance)) : null;
        const text = retained ? retained.map(word => word.raw || word.word).join(' ') : String(recognized || '');
        return { retained, text };
    }
    function validate({ script, recognized, words = [], start, end, language = 'en', removeRanges = [] }) {
        const { retained, text } = croppedText({ recognized, words, start, end, language, removeRanges });
        const comparison = textCoverage(script, text, language);
        const partialWords = (retained || []).filter(word => Number(word.start) < Number(start) - 0.04 || Number(word.end) > Number(end) + 0.04).map(word => word.raw || word.word);
        const partial = partialWords.length > 0;
        return { ...comparison, text, partial, partialWords, timingAvailable: Boolean(retained),
            passed: comparison.equal && !partial && Boolean(retained) };
    }
    function locate(script, words, language = 'en') {
        const target = tokens(script, language);
        const source = words.flatMap((word, index) => word && Number.isFinite(Number(word.start)) && Number.isFinite(Number(word.end))
            ? tokens(word.raw || word.word, language).map(token => ({ token, index })) : []);
        if (!target.length || !source.length) return null;
        // 紧凑写法完全一致时支持 ASR 拆词及中日韩无空格文本。
        const compact = source.map(word => word.token).join('');
        const targetCompact = target.join('');
        const boundaries = new Set([0]);
        let total = 0;
        source.forEach(word => { total += word.token.length; boundaries.add(total); });
        let offset = compact.indexOf(targetCompact);
        while (offset >= 0 && (!boundaries.has(offset) || !boundaries.has(offset + targetCompact.length))) offset = compact.indexOf(targetCompact, offset + 1);
        if (offset >= 0) {
            let position = 0;
            const selected = source.filter(word => {
                const from = position; position += word.token.length;
                return position > offset && from < offset + targetCompact.length;
            });
            return { startIdx: selected[0].index, endIdx: selected[selected.length - 1].index, score: 1, missing: [] };
        }
        const result = align(target, source.map(word => word.token));
        if (!result.matches.length) return null;
        return { startIdx: source[result.matches[0].sourceIndex].index,
            endIdx: source[result.matches[result.matches.length - 1].sourceIndex].index,
            score: result.matches.length / target.length, missing: result.missing.map(index => target[index]) };
    }
    function boundSourceTimeline(segment) {
        const duration = Number(segment.source_duration);
        if (!(duration > 0) || !Array.isArray(segment.word_timeline)) return segment;
        // ASR 的末词结束时间可能落在素材之外。只校正越界结束时间，保留原值以便追溯。
        const words = segment.word_timeline.map(word => Number(word.start) < duration && Number(word.end) > duration
            ? {...word, asr_original_end:word.asr_original_end ?? word.end, end:duration} : word);
        return {...segment, word_timeline:words};
    }
    function sourceSegment(segment, project = {}, review) {
        if (!segment) return segment;
        const relative = segment.word_timeline_basis === 'clip' || (segment.word_timeline_basis !== 'source'
            && Boolean(project.output_path && project.processed_clips_dir));
        if (!relative && !segment.source_word_timeline) return boundSourceTimeline(segment);
        const original = segment.source_word_timeline || (review?.source === segment.source ? review.word_timeline : null);
        const words = original || (segment.word_timeline || []).map(word => ({ ...word,
            start: Number(segment.start || 0) + Number(word.start) * Number(segment.speed || 1),
            end: Number(segment.start || 0) + Number(word.end) * Number(segment.speed || 1) }));
        return boundSourceTimeline({ ...segment, word_timeline: words, word_timeline_basis: 'source',
            processed_word_timeline: segment.processed_word_timeline || segment.word_timeline });
    }
    function repairBoundaryConjunctions(segments) {
        const ordered = segments.filter(segment => segment.enabled !== false).slice().sort((a,b)=>Number(a.script_start_line)-Number(b.script_start_line));
        let repaired = 0;
        for (let i=0; i<ordered.length-1; i++) {
            const previous=ordered[i], next=ordered[i+1];
            if (previous.manually_modified || next.manually_modified || previous.review_acknowledged || next.review_acknowledged) continue;
            if (/\nand\s*$/i.test(previous.script || '') && Number(previous.script_end_line) === Number(next.script_start_line)
                && !/^and\b/i.test(next.script || '')) {
                previous.script = previous.script.replace(/\nand\s*$/i,'');
                previous.script_end_line = Number(previous.script_end_line)-1;
                next.script = 'and '+next.script;
                repaired++;
            }
        }
        return repaired;
    }
    function takeOccurrences(script, words = [], language = 'en') {
        const target = tokens(script, language);
        if (!target.length) return [];
        const source = words.flatMap((word, index) => word && Number.isFinite(Number(word.start)) && Number.isFinite(Number(word.end))
            ? tokens(word.raw || word.word, language).map(token => ({token, index})) : []);
        const found = [];
        for (let from = 0; from + target.length <= source.length; from++) {
            const to = from + target.length;
            if ((from && source[from - 1].index === source[from].index)
                || (to < source.length && source[to - 1].index === source[to].index)) continue;
            if (target.every((token, index) => token === source[from + index].token)) {
                found.push({startIdx:source[from].index, endIdx:source[to - 1].index});
            }
        }
        return found;
    }
    function recalculate(segment, settings = {}) {
        if (!segment || segment.enabled === false || segment.is_hook || segment.review_acknowledged || segment.manually_modified) return false;
        Object.assign(segment, boundSourceTimeline(segment));
        const language = settings.language || 'en';
        if (takeOccurrences(segment.script, segment.word_timeline, language).length > 1) return false;
        const duration = Number(segment.source_duration) > 0 ? Number(segment.source_duration) : Infinity;
        if (Number(segment.end) <= duration && validate({script:segment.script, recognized:segment.recognized_text, words:segment.word_timeline, start:segment.start, end:segment.end, language}).passed) return false;
        const located = locate(segment.script, segment.word_timeline || [], language);
        if (!located || located.missing.length) return false;
        const previous = segment.word_timeline[located.startIdx - 1];
        const next = segment.word_timeline[located.endIdx + 1];
        // 留白仅使用词间空隙，不能带回已排除的开头/结尾单词。
        const start = Math.max(0, Number(previous?.end || 0), Number(segment.word_timeline[located.startIdx].start) - Number(settings.lead_pad ?? .12));
        const end = Math.min(duration, next ? Number(next.start) : Infinity, Number(segment.word_timeline[located.endIdx].end) + Number(settings.tail_pad ?? .22));
        if (!validate({script:segment.script, words:segment.word_timeline, start, end, language}).passed) return false;
        Object.assign(segment, {start, end, status:'ready', verification_level:'strict_match', issue_reason:''});
        delete segment.cut_coverage_original;
        delete segment.cut_coverage_fingerprint;
        return true;
    }
    function containedDuplicates(segments, language = 'en') {
        const active = segments.map((segment, index) => ({segment, index})).filter(({segment}) => segment.enabled !== false && !segment.is_hook);
        const entries = active.map(({segment, index}) => {
            const cropped = croppedText({recognized:segment.recognized_text,words:segment.word_timeline,start:segment.start,end:segment.end,language});
            const text = cropped.text || segment.script || '';
            const words = tokens(text, language);
            return {segment, index, text, words, joined: words.length ? ' ' + words.join(' ') + ' ' : ''};
        });
        const result = [];
        for (let i = 0; i < entries.length; i++) for (let j = i + 1; j < entries.length; j++) {
            const a = entries[i], b = entries[j];
            const short = a.words.length < b.words.length ? a : b, long = short === a ? b : a;
            if (short.words.length < 4 || short.words.length === long.words.length) continue;
            if (!long.joined.includes(short.joined)) continue;
            result.push({shortIndex:short.index,longIndex:long.index,text:short.text});
        }
        return result;
    }
    function assignFixedPhraseMissing(result) {
        const phrase = ['in','the','name','of'];
        const original = tokens(result.script_text || '', result.language || 'en');
        const joined = ' ' + original.join(' ') + ' ';
        if (!joined.includes(' in the name of ')) return 0;
        let count = 0;
        for (const block of result.missing_blocks || []) {
            if (block.review_assignment || block.auto_assignment_rejected) continue;
            const missing = tokens(block.text || '', result.language || 'en');
            if (!missing.length || missing.length >= phrase.length || !missing.every((word,index) => word === phrase[index])) continue;
            const tail = phrase.slice(missing.length);
            const candidates = (result.segments || []).filter(segment => {
                if (segment.enabled === false || segment.is_hook || segment.review_acknowledged || segment.manually_modified) return false;
                const words = tokens(segment.script || '', result.language || 'en');
                if (!tail.every((word,index) => words[index] === word)) return false;
                const line = Number(segment.script_start_line), start = Number(block.startLine)+1, end = Number(block.endLine ?? block.startLine)+1;
                return Number.isFinite(line) && line >= start && line <= end+1;
            });
            if (candidates.length !== 1) continue;
            const segment = candidates[0];
            const before = segment.script || '';
            block.review_assignment = {mode:'next',position:'start',automatic:true,reason:'固定组合 In the name of',confirmed_at:new Date().toISOString(),targets:[{source:segment.source,source_index:segment.source_index || segment.index,script_before:before,start_before:segment.start,end_before:segment.end,cut_selection_before:segment.cut_selection,modified_before:Boolean(segment.manually_modified),manual_subtitles_before:segment.manual_subtitles || []}]};
            segment.script = `${String(block.text).trim()} ${before.trim()}`;
            segment.manually_modified = true;
            segment.script_start_line = Math.min(Number(segment.script_start_line), Number(block.startLine)+1);
            segment.review_acknowledged = false;
            count++;
        }
        return count;
    }
    function recoverRecognitionDifferenceBlocks(result, settings = {}) {
        if (!['multilingual_v2', 'compare_v2'].includes(result?.matching_engine)) return 0;
        const language = result.language || settings.language || 'en';
        const original = tokens(result.script_text || '', language);
        if (!original.length) return 0;
        let recovered = 0;
        for (let i = (result.missing_blocks || []).length - 1; i >= 0; i--) {
            const block = result.missing_blocks[i];
            if (block.review_assignment || block.auto_assignment_rejected || Number(block.startLine) !== 0) continue;
            const prefix = tokens(block.text, language);
            if (!prefix.length || prefix.length > 10 || !prefix.every((word, index) => original[index] === word)) continue;
            const candidates = (result.segments || []).filter(segment => segment.enabled !== false && !segment.is_hook
                && !segment.manually_modified && !segment.review_acknowledged && String(segment.script || '').trim()).filter(segment => {
                const target = [...prefix, ...tokens(segment.script, language)];
                // 必须完整衔接整篇原稿的起始位置，不能凭相邻行或模糊识别补词。
                return target.length <= original.length && target.every((word, index) => original[index] === word);
            });
            if (candidates.length !== 1) continue;
            const segment = candidates[0];
            // 使用现有“归到下一段”的撤销协议，保留缺失卡片和归属前文案。
            block.review_assignment = { mode: 'next', position: 'start', automatic: true,
                reason: '整篇开头缺失不超过10个单词', confirmed_at: new Date().toISOString(),
                targets: [{ source: segment.source, source_index: segment.source_index || segment.index,
                    script_before: segment.script, start_before: segment.start, end_before: segment.end,
                    cut_selection_before: segment.cut_selection, modified_before: Boolean(segment.manually_modified),
                    manual_subtitles_before: segment.manual_subtitles || [] }] };
            const separator = Number(block.endLine ?? block.startLine) === Number(segment.script_start_line) - 1 ? ' ' : '\n';
            segment.script = `${block.text}${separator}${segment.script}`;
            segment.manually_modified = true;
            segment.script_start_line = Number(block.startLine) + 1;
            const first = (segment.word_timeline || []).find(word => Number.isFinite(Number(word.start)));
            if (first) segment.start = Math.min(Number(segment.start), Math.max(0, Number(first.start) - Number(settings.lead_pad ?? .12)));
            segment.v2_start = segment.start;
            segment.review_acknowledged = false;
            segment.status = 'warning';
            segment.issue_reason = '整篇开头缺失文案已补回首段，请试听核对后确认';
            segment.verification_level = 'strict_review';
            recovered++;
        }
        return recovered;
    }
    function recoverUnmatchedScriptBlocks(result, settings = {}) {
        if (!['multilingual_v2', 'compare_v2'].includes(result?.matching_engine)) return 0;
        const language = result.language || settings.language || 'en';
        const segments = result.segments || [];
        let recovered = 0;
        for (let i = (result.missing_blocks || []).length - 1; i >= 0; i--) {
            const block = result.missing_blocks[i];
            if (block.review_assignment || block.auto_assignment_rejected) continue;
            const candidates = segments.filter(segment => segment.enabled !== false && !segment.is_hook
                && !segment.manually_modified && !segment.review_acknowledged && !segment.needs_replacement && !segment.manual_subtitles?.length
                && !String(segment.script || '').trim()).map(segment => {
                if (takeOccurrences(block.text, segment.word_timeline, language).length > 1) return null;
                const located = locate(block.text, segment.word_timeline || [], language);
                if (!located || located.missing.length) return null;
                const words = segment.word_timeline;
                const start = Number(words[located.startIdx].start), end = Number(words[located.endIdx].end);
                // 必须是连续、完整的识别证据，不能靠分散的公共词凑出归属。
                if (!validate({script:block.text,words,start,end,language}).passed) return null;
                return {segment,located};
            }).filter(Boolean);
            if (candidates.length !== 1) continue;
            const {segment,located} = candidates[0];
            const words = segment.word_timeline;
            const first = words[located.startIdx], last = words[located.endIdx];
            const before = words[located.startIdx - 1], after = words[located.endIdx + 1];
            const start = Math.max(0, Math.min(Number(first.start), Number(before?.end) || 0), Number(first.start) - Number(settings.lead_pad ?? .12));
            const end = Math.max(Number(last.end), Math.min(after ? Number(after.start) : Infinity,
                Number(last.end) + Number(settings.tail_pad ?? .22), Number(segment.source_duration) || Infinity));
            // 优先取原文的断行和标点。缺失块可能只占一行的一部分。
            const lineText = String(result.script_text || '').split(/\r?\n/).slice(Number(block.startLine), Number(block.endLine ?? block.startLine) + 1).join('\n');
            const target = tokens(block.text, language);
            const spans = Array.from(lineText.matchAll(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu))
                .flatMap(match => tokens(match[0], language).map(token => ({token,start:match.index,end:match.index+match[0].length})));
            let script = String(block.text || '');
            for (let offset = 0; offset <= spans.length - target.length; offset++) {
                if (!target.every((token,index) => token === spans[offset+index].token)) continue;
                const from = spans[offset].start, to = spans[offset+target.length-1].end;
                script = lineText.slice(from,to) + (lineText.slice(to).match(/^[.,!?;:]+/)?.[0] || '');
                break;
            }
            Object.assign(segment, {script,start,end,script_start_line:Number(block.startLine)+1,
                script_end_line:Number(block.endLine ?? block.startLine)+1,
                status:'ready',verification_level:'strict_match',issue_reason:'',review_acknowledged:false,
                matched_text:words.slice(located.startIdx,located.endIdx+1).map(word=>word.word||word.raw).join(' '),
                match_score:1,similarity:100,cut_engine:'multilingual_v2',cut_score:1,
                cut_reason:'',v2_cut_available:true,v2_start:start,v2_end:end,cut_selection:'v2',
                script_assignment_recovered:true});
            delete segment.cut_coverage_original;
            delete segment.cut_coverage_fingerprint;
            // 只移动新恢复的无归属行，其他已审核行保持原有顺序。
            segments.splice(segments.indexOf(segment),1);
            const next = segments.findIndex(item => Number(item.source_index) === Number(block.next_source_index));
            const previous = segments.findIndex(item => Number(item.source_index) === Number(block.previous_source_index));
            segments.splice(next >= 0 ? next : previous >= 0 ? previous+1 : segments.length,0,segment);
            result.missing_blocks.splice(i,1);
            recovered++;
        }
        return recovered;
    }
    return { calendarSpans, takeOccurrences, recoverRecognitionDifferenceBlocks, recoverUnmatchedScriptBlocks, assignFixedPhraseMissing, containedDuplicates, normalize, tokens, align, inspect, textCoverage, validate, locate, sourceSegment, recalculate, repairBoundaryConjunctions };
});
