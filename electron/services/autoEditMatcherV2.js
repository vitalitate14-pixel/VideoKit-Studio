const ENGINE_ID = 'multilingual_v2';
const COMPARE_ENGINE_ID = 'compare_v2';
const ENGINE_VERSION = 10;
const cutCoverage = require('../../src/auto-edit-cut-coverage');

function normalizeEngine(value) {
    if (value === ENGINE_ID || value === COMPARE_ENGINE_ID) return value;
    return 'legacy';
}

function localeForLanguage(language) {
    const value = String(language || '').trim().toLowerCase();
    return value && value !== 'auto' ? value : 'en';
}

function normalizeToken(value, language = 'en') {
    const locale = localeForLanguage(language);
    let lowered;
    try {
        lowered = String(value || '').normalize('NFKC').toLocaleLowerCase(locale);
    } catch (_) {
        lowered = String(value || '').normalize('NFKC').toLowerCase();
    }
    return lowered
        .replace(/[\p{Pd}'’`´]/gu, '')
        .replace(/[^\p{L}\p{N}]/gu, '');
}

function segmentWords(text, language = 'en') {
    const source = cutCoverage.normalize(text, language);
    const locale = localeForLanguage(language);
    try {
        const segmenter = new Intl.Segmenter(locale, { granularity: 'word' });
        return Array.from(segmenter.segment(source))
            .filter(item => item.isWordLike)
            .map(item => normalizeToken(item.segment, locale))
            .filter(Boolean);
    } catch (_) {
        return (source.match(/[\p{L}\p{N}]+(?:[\p{Pd}'’`´][\p{L}\p{N}]+)*/gu) || [])
            .map(token => normalizeToken(token, locale))
            .filter(Boolean);
    }
}

function editSimilarity(left, right) {
    const a = String(left || '');
    const b = String(right || '');
    if (!a || !b) return 0;
    if (a === b) return 1;
    const prev = Array.from({ length: b.length + 1 }, (_, index) => index);
    for (let i = 1; i <= a.length; i++) {
        let diagonal = prev[0];
        prev[0] = i;
        for (let j = 1; j <= b.length; j++) {
            const old = prev[j];
            prev[j] = Math.min(
                prev[j] + 1,
                prev[j - 1] + 1,
                diagonal + (a[i - 1] === b[j - 1] ? 0 : 1)
            );
            diagonal = old;
        }
    }
    return 1 - prev[b.length] / Math.max(a.length, b.length, 1);
}

function tokenEquivalent(left, right) {
    if (!left || !right) return false;
    if (left === right) return true;
    if (Math.min(left.length, right.length) < 4) return false;
    const lengthRatio = Math.min(left.length, right.length) / Math.max(left.length, right.length);
    return lengthRatio >= 0.72 && editSimilarity(left, right) >= 0.78;
}

function tokenLcsLength(left, right) {
    const previous = new Array(right.length + 1).fill(0);
    const current = new Array(right.length + 1).fill(0);
    for (let i = 1; i <= left.length; i++) {
        for (let j = 1; j <= right.length; j++) {
            current[j] = tokenEquivalent(left[i - 1], right[j - 1])
                ? previous[j - 1] + 1
                : Math.max(previous[j], current[j - 1]);
        }
        for (let j = 0; j <= right.length; j++) previous[j] = current[j];
    }
    return previous[right.length];
}

function tolerantSimilarity(scriptText, recognizedText, language = 'en') {
    const scriptWords = segmentWords(scriptText, language);
    const recognizedWords = segmentWords(recognizedText, language);
    if (!scriptWords.length || !recognizedWords.length) return 0;

    const lcs = tokenLcsLength(scriptWords, recognizedWords);
    const precision = lcs / recognizedWords.length;
    const recall = lcs / scriptWords.length;
    const wordF1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
    const compactScript = scriptWords.join('');
    const compactRecognized = recognizedWords.join('');
    if (compactScript === compactRecognized) return 1;
    const compactScore = editSimilarity(compactScript, compactRecognized);
    return Math.max(wordF1, wordF1 * 0.72 + compactScore * 0.28);
}

// 文案归属只接受连续逐词证据。音频里多读的句子不降低已读目标句的
// 分数，也不能跨过多读内容，把后面的 you 对齐到下一句的 if you。
function findScriptWordRange(scriptWords, recognizedWords, language = 'en') {
    const expand = words => words.flatMap((word, index) =>
        segmentWords(word.raw || word.word, language).map(token => ({ token, index })));
    const target = expand(scriptWords || []);
    const source = expand(recognizedWords || []);
    if (!target.length || !source.length) return null;
    let previous = new Uint32Array(source.length + 1);
    let best = null;
    for (let i = 1; i <= target.length; i++) {
        const current = new Uint32Array(source.length + 1);
        for (let j = 1; j <= source.length; j++) {
            if (target[i - 1].token !== source[j - 1].token) continue;
            current[j] = previous[j - 1] + 1;
            let length = current[j], from = i - length, sourceFrom = j - length;
            // 数字日期可在一个 ASR 词中展开成多个 token。最长匹配若从
            // 日期中间开始，舍去这个不完整词，继续检查后面的完整句子。
            // 不能因前面的半个日期而丢弃后面连续匹配的全部证据。
            while (length > 0 && ((from > 0 && target[from - 1].index === target[from].index)
                || (sourceFrom > 0 && source[sourceFrom - 1].index === source[sourceFrom].index))) {
                from++; sourceFrom++; length--;
            }
            if (!length) continue;
            // 一个 ASR 词可能展开成多个 token，不能只归属半个缩写/数字。
            if ((from > 0 && target[from - 1].index === target[from].index)
                || (i < target.length && target[i].index === target[i - 1].index)
                || (sourceFrom > 0 && source[sourceFrom - 1].index === source[sourceFrom].index)
                || (j < source.length && source[j].index === source[j - 1].index)) continue;
            if (length < Math.min(4, target.length)) continue;
            if (!best || length > best.tokenCount) {
                const startIdx = target[from].index, endIdx = target[i - 1].index;
                best = { startIdx, endIdx, tokenCount: length, score: 1,
                    sourceStartIdx: source[sourceFrom].index, sourceEndIdx: source[j - 1].index,
                    matchedText: scriptWords.slice(startIdx, endIdx + 1).map(word => word.raw || word.word).join(' ') };
            }
        }
        previous = current;
    }
    if (!best) return null;
    // 用连续锚点确定归属，允许锚点间少量识别差异留在本段待试听。
    // 不跨过长段多读内容寻找公共词，避免把下一句的 if you 偷过来。
    let left = target.findIndex(item => item.index === best.startIdx);
    let sourceLeft = source.findIndex(item => item.index === best.sourceStartIdx);
    let right = target.findLastIndex(item => item.index === best.endIdx);
    let sourceRight = source.findLastIndex(item => item.index === best.sourceEndIdx);
    for (const direction of [-1, 1]) {
        let t = direction < 0 ? left : right;
        let s = direction < 0 ? sourceLeft : sourceRight;
        while (t + direction >= 0 && t + direction < target.length && s + direction >= 0 && s + direction < source.length) {
            let bridge = null;
            for (let dt = 1; dt <= 3; dt++) for (let ds = 1; ds <= 3; ds++) {
                const ti = t + direction * dt, si = s + direction * ds;
                if (ti < 0 || ti >= target.length || si < 0 || si >= source.length) continue;
                // 连续词的拼写相同，只是 ASR 合写/分写时，保留整个边界词。
                const targetText = target.slice(direction < 0 ? ti : t + 1, direction < 0 ? t : ti + 1).map(item => item.token).join('');
                const sourceText = source.slice(direction < 0 ? si : s + 1, direction < 0 ? s : si + 1).map(item => item.token).join('');
                if (target[ti].token !== source[si].token && targetText !== sourceText) continue;
                if (!bridge || dt + ds < bridge.dt + bridge.ds) bridge = {dt,ds,ti,si};
            }
            if (!bridge) break;
            t = bridge.ti; s = bridge.si;
        }
        // 未读开头保留为缺失块；审核流程按十词上限执行可撤销的归属。
        if (direction < 0) { left = t; sourceLeft = s; }
        else { right = t; sourceRight = s; }
    }
    best.startIdx = target[left].index;
    best.endIdx = target[right].index;
    best.sourceStartIdx = source[sourceLeft].index;
    best.sourceEndIdx = source[sourceRight].index;
    best.matchedText = scriptWords.slice(best.startIdx, best.endIdx + 1).map(word => word.raw || word.word).join(' ');
    best.hasRecognitionDifferences = target.slice(left, right + 1).map(item=>item.token).join(' ') !== source.slice(sourceLeft,sourceRight+1).map(item=>item.token).join(' ');
    // 相同完整证据在原稿/原片出现多次时，最长连续匹配不能证明是哪一次。
    const evidence = target.slice(left, right + 1).map(item => item.token);
    const occurrences = list => {
        const found = [];
        for (let from = 0; from + evidence.length <= list.length; from++) {
            const to = from + evidence.length;
            if ((from > 0 && list[from - 1].index === list[from].index)
                || (to < list.length && list[to].index === list[to - 1].index)) continue;
            if (evidence.every((token, index) => token === list[from + index].token)) found.push(list[from].index);
        }
        return found;
    };
    best.targetOccurrences = occurrences(target);
    best.sourceOccurrences = occurrences(source);
    best.ambiguous = best.targetOccurrences.length > 1 || best.sourceOccurrences.length > 1;
    return best;
}

function findUnmatchedBlockOwner(plans, scriptWords, language = 'en') {
    const candidates = (plans || []).filter(plan => plan.scriptWordStart === -1).map(plan => ({
        plan, match: findScriptWordRange(scriptWords, plan.words, language),
    })).filter(({ match }) => match && !match.ambiguous && !match.hasRecognitionDifferences && match.startIdx === 0 && match.endIdx === scriptWords.length - 1);
    // 有多个片段读到了同一句时保留待确认，不能擅自选一个。
    return candidates.length === 1 ? candidates[0] : null;
}

function findBestCutWindow(words, scriptText, language = 'en') {
    const sourceWords = (words || [])
        .map((word, sourceIndex) => ({ ...word, sourceIndex }))
        .filter(word => (
            word &&
            Number.isFinite(Number(word.start)) &&
            Number.isFinite(Number(word.end)) &&
            Number(word.end) >= Number(word.start) &&
            segmentWords(word.raw || word.word, language).length
        ));
    const targetWords = segmentWords(scriptText, language);
    if (!sourceWords.length || !targetWords.length) return null;

    const minLength = 1;
    const maxLength = Math.min(
        sourceWords.length,
        Math.max(targetWords.length + 5, Math.ceil(targetWords.length * 1.8))
    );
    let best = null;
    const candidates = [];
    for (let startIdx = 0; startIdx < sourceWords.length; startIdx++) {
        for (let endIdx = startIdx; endIdx < sourceWords.length; endIdx++) {
            const length = endIdx - startIdx + 1;
            if (length > maxLength) break;
            if (length < minLength) continue;

            const candidateWords = sourceWords.slice(startIdx, endIdx + 1);
            const candidateText = candidateWords.map(word => word.raw || word.word).join(' ');
            const similarity = tolerantSimilarity(scriptText, candidateText, language);
            const candidateTokens = segmentWords(candidateText, language);
            const lengthRatio = Math.min(candidateTokens.length, targetWords.length) / Math.max(candidateTokens.length, targetWords.length, 1);
            const firstTarget = targetWords[0];
            const lastTarget = targetWords[targetWords.length - 1];
            const firstCandidate = candidateTokens[0];
            const lastCandidate = candidateTokens[candidateTokens.length - 1];
            const boundaryScore = (tokenEquivalent(firstTarget, firstCandidate) ? 0.5 : 0) +
                (tokenEquivalent(lastTarget, lastCandidate) ? 0.5 : 0);
            const adjustedScore = similarity * 0.78 + lengthRatio * 0.14 + boundaryScore * 0.08;
            if (adjustedScore >= 0.85) candidates.push({startIdx:candidateWords[0].sourceIndex,
                endIdx:candidateWords[candidateWords.length - 1].sourceIndex, adjustedScore});

            if (!best || adjustedScore > best.adjustedScore ||
                (adjustedScore === best.adjustedScore && length < best.length)) {
                best = {
                    startIdx: candidateWords[0].sourceIndex,
                    endIdx: candidateWords[candidateWords.length - 1].sourceIndex,
                    length,
                    similarity,
                    adjustedScore,
                    matchedText: candidateText,
                };
            }
        }
    }

    if (!best || best.adjustedScore < 0.46) return null;
    // 独立的高分词窗同样可信时，不能用先出现的位置代替人工选择。
    best.ambiguous = candidates.some(candidate =>
        (candidate.endIdx < best.startIdx || candidate.startIdx > best.endIdx)
        && best.adjustedScore - candidate.adjustedScore <= 0.02);
    if (best.ambiguous) return best;
    // 完整正确的一遍无需从另一遍拼入单词，避免把两遍连成一个切点范围。
    if (cutCoverage.validate({script:scriptText,words,
        start:words[best.startIdx].start,end:words[best.endIdx].end,language}).passed) return best;
    const timedTokens = sourceWords.flatMap(word => segmentWords(word.raw || word.word, language).map(token => ({ token, sourceIndex: word.sourceIndex })));
    const full = cutCoverage.align(targetWords, timedTokens.map(word => word.token));
    const selected = timedTokens.filter(word => word.sourceIndex >= best.startIdx && word.sourceIndex <= best.endIdx);
    const kept = cutCoverage.align(targetWords, selected.map(word => word.token));
    if (full.matches.length > kept.matches.length) {
        // 相似度最优的短窗口不能以删掉确实读到的目标词为代价。
        best.startIdx = Math.min(best.startIdx, ...full.matches.map(match => timedTokens[match.sourceIndex].sourceIndex));
        best.endIdx = Math.max(best.endIdx, ...full.matches.map(match => timedTokens[match.sourceIndex].sourceIndex));
        best.matchedText = sourceWords.filter(word => word.sourceIndex >= best.startIdx && word.sourceIndex <= best.endIdx).map(word => word.raw || word.word).join(' ');
    }
    const ownershipWords = segmentWords(scriptText, language).map(raw => ({ raw }));
    const ownership = findScriptWordRange(ownershipWords, words, language);
    if (ownership?.hasRecognitionDifferences && ownership.startIdx === 0
        && ownership.endIdx === ownershipWords.length - 1) {
        best.startIdx = Math.min(best.startIdx, ownership.sourceStartIdx);
        best.endIdx = Math.max(best.endIdx, ownership.sourceEndIdx);
    }
    return best;
}

function calculateCut(plan = {}, options = {}) {
    const words = Array.isArray(plan.words) ? plan.words : [];
    const scriptText = plan.scriptText || '';
    const language = options.language || 'en';
    const legacyStart = Math.max(0, Number(plan.start) || 0);
    const legacyEnd = Math.max(legacyStart, Number(plan.end) || legacyStart);
    const duration = Math.max(legacyEnd, Number(plan.duration) || legacyEnd);
    const leadPad = Math.max(0, Number(options.leadPad) || 0);
    const tailPad = Math.max(0, Number(options.tailPad) || 0);
    const match = findBestCutWindow(words, scriptText, language);

    if (match?.ambiguous) return {
        engine:'legacy_fallback', applied:false, ambiguous:true,
        start:legacyStart, end:legacyEnd, legacyStart, legacyEnd, score:match.adjustedScore,
        reason:'重复朗读：多遍匹配程度接近，需试听并选择保留哪一遍',
    };

    if (!match || !words[match.startIdx] || !words[match.endIdx]) {
        return {
            engine: 'legacy_fallback',
            applied: false,
            start: legacyStart,
            end: legacyEnd,
            legacyStart,
            legacyEnd,
            score: 0,
            reason: 'V2 无法可靠定位文案边界，本片段沿用经典切点',
        };
    }

    const firstWord = words[match.startIdx];
    const lastWord = words[match.endIdx];
    const previousWord = words.slice(0, match.startIdx).reverse().find(word =>
        Number.isFinite(Number(word.end)) && segmentWords(word.raw || word.word, language).length);
    const nextWord = words.slice(match.endIdx + 1).find(word =>
        Number.isFinite(Number(word.start)) && segmentWords(word.raw || word.word, language).length);
    // 留白只能使用词间空隙；时间戳重叠时优先保留目标词的完整发音。
    const start = Math.max(0, Math.min(Number(firstWord.start), Number(previousWord?.end) || 0), Number(firstWord.start) - leadPad);
    const end = Math.min(duration, Math.max(Number(lastWord.end),
        Math.min(nextWord ? Number(nextWord.start) : Infinity, Number(lastWord.end) + tailPad)));
    return {
        engine: ENGINE_ID,
        applied: true,
        start,
        end,
        legacyStart,
        legacyEnd,
        wordStartIdx: match.startIdx,
        wordEndIdx: match.endIdx,
        score: match.adjustedScore,
        textSimilarity: match.similarity,
        matchedText: match.matchedText,
        startDelta: start - legacyStart,
        endDelta: end - legacyEnd,
        reason: '',
    };
}

function reviewThreshold(wordCount) {
    if (wordCount <= 3) return 0.58;
    if (wordCount <= 7) return 0.68;
    if (wordCount <= 12) return 0.74;
    return 0.78;
}

function confidenceSummary(words) {
    const scores = (words || [])
        .map(word => Number(word.score))
        .filter(score => Number.isFinite(score) && score > 0);
    if (!scores.length) {
        return { available: false, average: 0, reliableRatio: 0 };
    }
    return {
        available: true,
        average: scores.reduce((sum, score) => sum + score, 0) / scores.length,
        reliableRatio: scores.filter(score => score >= 0.72).length / scores.length,
    };
}

function assessSegment({ plan = {}, info = {}, language = 'en' }) {
    const recognizedText = plan.transcription?.fullText || plan.matchedText || info.recognizedText || '';
    const scriptText = plan.scriptText || info.scriptText || '';
    const transcriptionFailed = plan.transcription?.source === 'failed';
    const recognitionEmpty = segmentWords(recognizedText, language).length === 0;
    const scriptUnmatched = plan.scriptStartLine === -1 || !scriptText;
    const scriptWordCount = segmentWords(scriptText, language).length;
    const legacySimilarity = Math.max(0, Math.min(1, Number(info.similarity || 0) / 100));
    const tolerantScore = tolerantSimilarity(scriptText, recognizedText, language);
    const effectiveScore = Math.max(legacySimilarity, tolerantScore);
    const threshold = reviewThreshold(scriptWordCount);
    const confidence = confidenceSummary(plan.words);

    if (transcriptionFailed || recognitionEmpty) {
        return {
            status: 'error',
            verificationLevel: 'service_error',
            effectiveSimilarity: Math.round(effectiveScore * 100),
            threshold: Math.round(threshold * 100),
            confidence,
            issueReason: transcriptionFailed
                ? String(plan.transcription?.error || recognizedText || '转录失败').replace(/^\(转录失败:\s*|\)$/g, '')
                : '识别服务未返回有效文字，无法判断是否漏读',
        };
    }

    if (scriptUnmatched) {
        return {
            status: 'warning',
            verificationLevel: 'review',
            effectiveSimilarity: Math.round(effectiveScore * 100),
            threshold: Math.round(threshold * 100),
            confidence,
            issueReason: '未能可靠定位到断行文案；仅标记待确认，不判定为漏读',
        };
    }

    if (plan.takeAmbiguous || cutCoverage.takeOccurrences(scriptText, plan.words || [], language).length > 1) {
        return {status:'warning', verificationLevel:'repeated_take_review',
            effectiveSimilarity:Math.round(effectiveScore * 100), threshold:100, confidence,
            issueReason:'重复朗读：多遍匹配程度接近，需试听并选择保留哪一遍'};
    }

    const validation = cutCoverage.validate({ script: scriptText, recognized: recognizedText,
        words: plan.words, start: plan.start, end: plan.end, language });
    if (!validation.passed) {
        const details = [validation.missing.length ? `缺词/错词：${validation.missing.join(' ')}` : '',
            validation.extra.length ? `多词/错词：${validation.extra.join(' ')}` : '',
            validation.partial ? `切点截断了单词发音：${validation.partialWords.join(' ')}` : '',
            !validation.timingAvailable ? '缺少逐词时间戳，无法验证剪后文案' : ''].filter(Boolean);
        return { status: 'warning', verificationLevel: 'strict_review',
            effectiveSimilarity: Math.round(effectiveScore * 100), threshold: 100, confidence,
            cutCoverage: validation,
            issueReason: `剪后文案未严格对齐：${details.join('；')}；请调整切点或试听后手动确认` };
    }

    return {
        status: 'ready',
        verificationLevel: 'strict_match',
        effectiveSimilarity: Math.round(effectiveScore * 100),
        threshold: 100,
        confidence,
        issueReason: '',
    };
}

function assessMissingBlock(block = {}) {
    return {
        ...block,
        // 到这里的区块已经经过全文与相邻片段边界二次核对，仍没有归属。
        // 这表示“识别覆盖层面确认缺失”，不是笼统的低分待确认；仍保留
        // transcript 限定，避免把 ASR 漏识别误说成演员一定漏读。
        issue_type: 'confirmed_missing_script',
        status: 'error',
        verification_level: 'full_transcript_recheck',
        issue_reason: '已在所有片段的识别全文及相邻片段边界二次核对，仍没有任何片段覆盖该文案；属于识别覆盖层面的确认缺失。若试听实际读到了，请在审核页归属到相邻片段。',
    };
}

function assessAnalysis({ plans = [], matchInfo = [], missingBlocks = [], language = 'en' }) {
    const segments = plans.map((plan, index) => assessSegment({
        plan,
        info: matchInfo[index] || {},
        language,
    }));
    return {
        engine: ENGINE_ID,
        version: ENGINE_VERSION,
        segments,
        missingBlocks: missingBlocks.map(assessMissingBlock),
        hasReviewWarnings: segments.some(item => item.status !== 'ready') || missingBlocks.length > 0,
        blocksExport: false,
    };
}

module.exports = {
    ENGINE_ID,
    COMPARE_ENGINE_ID,
    ENGINE_VERSION,
    normalizeEngine,
    segmentWords,
    tolerantSimilarity,
    findScriptWordRange,
    findUnmatchedBlockOwner,
    findBestCutWindow,
    calculateCut,
    confidenceSummary,
    assessSegment,
    assessMissingBlock,
    assessAnalysis,
};
