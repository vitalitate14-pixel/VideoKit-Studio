/** Local wall-clock time for names shown to users; stored instants remain UTC. */
(function (root) {
    function format(date = new Date()) {
        const pad = (value, width = 2) => String(value).padStart(width, '0');
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
    }
    const api = { format, date: (date = new Date()) => format(date).slice(0, 10) };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.VideoKitLocalTime = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
