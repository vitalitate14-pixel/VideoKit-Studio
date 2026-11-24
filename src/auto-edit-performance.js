(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.AutoEditPerformance = factory();
})(typeof window === 'object' ? window : globalThis, function () {
    const results = new WeakMap();
    const summaries = new WeakMap();
    const validated = new WeakMap();
    let frame = null;

    function reviewKey(task) {
        // Legacy editing paths mutate nested segments in place. References alone
        // cannot invalidate these results, especially cut and confirmation edits.
        return JSON.stringify([task.script, task.settings, task.result, task.reviewSegments]);
    }

    function liveResult(task, compute) {
        if (!task?.result) return null;
        if (frame?.live.has(task)) return frame.live.get(task);
        let key;
        try { key = reviewKey(task); } catch (_) { return compute(); }
        let entry = results.get(task);
        if (!entry || entry.key !== key) {
            const value = compute();
            // Automatic recovery can change the input while computing. Cache its
            // final state, so the next ordinary click does not repeat that work.
            try { key = reviewKey(task); } catch (_) { return value; }
            entry = { key, value };
            results.set(task, entry);
            validated.set(value, summaryKey(value));
        }
        frame?.live.set(task, entry.value);
        return entry.value;
    }

    function withFrame(render) {
        const previous = frame;
        frame = { live: new WeakMap(), summary: new WeakMap() };
        try { return render(); } finally { frame = previous; }
    }

    function summaryKey(data) {
        return JSON.stringify([data.language, data.segments, data.match_summary, data.missing_blocks]);
    }

    function summary(data, compute) {
        if (!data || typeof data !== 'object') return compute(false);
        if (frame?.summary.has(data)) return frame.summary.get(data);
        let key;
        try { key = summaryKey(data); } catch (_) { return compute(false); }
        let entry = summaries.get(data);
        if (!entry || entry.key !== key) {
            const value = compute(validated.get(data) === key);
            try { key = summaryKey(data); } catch (_) { return value; }
            validated.set(data, key);
            entry = { key, value };
            summaries.set(data, entry);
        }
        frame?.summary.set(data, entry.value);
        return entry.value;
    }

    function cardKey(task, index, running, thumbnails, total) {
        // The validated result identity covers the large review arrays. Include
        // all remaining card metadata, including pairing scores and clip count.
        return JSON.stringify([index, running, thumbnails, total,
            { ...task, result: undefined, reviewSegments: undefined, settings: undefined }]);
    }

    return { liveResult, summary, withFrame, cardKey };
});
