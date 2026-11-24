// One writer per preload: coalesce autosaves, commit only the latest version,
// and synchronously finish pending work when the renderer unloads.
function createCoalescedTextWriter({ fs, delay = 150, setTimer = setTimeout, clearTimer = clearTimeout }) {
    const entries = new Map();
    let serial = 0;

    function settle(entry, ok) {
        entry.waiters.splice(0).forEach(resolve => resolve(ok));
    }
    function clean(file, entry) {
        if (!entry.running && !entry.dirty && entry.timer === null) entries.delete(file);
    }
    function drain(file, entry) {
        if (entry.running || !entry.dirty) return;
        entry.running = true;
        entry.dirty = false;
        const version = entry.version;
        const temporary = `${file}.videokit-write-${process.pid}-${++serial}`;
        const finish = error => {
            let ok = !error;
            // A sync close/save or newer snapshot supersedes an in-flight write.
            // Writing a temporary file keeps stale callbacks away from the target.
            if (entry.version === version) {
                if (ok) {
                    try { fs.renameSync(temporary, file); } catch (_) { ok = false; }
                }
                settle(entry, ok);
            }
            try { fs.unlinkSync(temporary); } catch (_) {}
            entry.running = false;
            if (entry.dirty && entry.timer === null) drain(file, entry);
            clean(file, entry);
        };
        try { fs.writeFile(temporary, entry.text, 'utf8', finish); } catch (error) { finish(error); }
    }
    function write(file, text) {
        let entry = entries.get(file);
        if (!entry) {
            entry = { version: 0, text: '', dirty: false, running: false, timer: null, waiters: [] };
            entries.set(file, entry);
        }
        entry.text = text;
        entry.version++;
        entry.dirty = true;
        if (entry.timer !== null) clearTimer(entry.timer);
        const pending = new Promise(resolve => entry.waiters.push(resolve));
        entry.timer = setTimer(() => { entry.timer = null; drain(file, entry); }, delay);
        return pending;
    }
    function writeNow(file, text) {
        const entry = entries.get(file);
        if (entry) {
            if (entry.timer !== null) clearTimer(entry.timer);
            entry.timer = null;
            entry.version++;
            entry.text = text;
            entry.dirty = false;
        }
        let ok = true;
        try { fs.writeFileSync(file, text, 'utf8'); } catch (_) { ok = false; }
        if (entry) { settle(entry, ok); clean(file, entry); }
        return ok;
    }
    function flush() {
        let ok = true;
        for (const [file, entry] of entries) {
            if (!writeNow(file, entry.text)) ok = false;
        }
        return ok;
    }
    return { write, writeNow, flush };
}
module.exports = { createCoalescedTextWriter };
