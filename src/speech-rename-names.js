(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.SpeechRenameNames = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    const windowsForbidden = /[<>:"/\\|?*\x00-\x1f]/;
    const posixForbidden = /[/\x00-\x1f]/;
    const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
    function inspect(value, { platform = 'win32', extension = '' } = {}) {
        const windows = platform === 'win32';
        const forbidden = windows ? windowsForbidden : posixForbidden;
        const name = String(value ?? '');
        const positions = new Set(), issues = [];
        if (!name.trim()) issues.push('名称为空，请填写最终名称');
        const bad = [];
        Array.from(name).forEach((char, index) => {
            if (forbidden.test(char)) { positions.add(index); bad.push(char === '\n' ? '换行' : char === '\r' ? '回车' : char === '\t' ? 'Tab' : char.charCodeAt(0) < 32 ? `控制字符 U+${char.charCodeAt(0).toString(16).padStart(4, '0')}` : char); }
        });
        if (bad.length) issues.push(`不允许的字符：${[...new Set(bad)].join('、')}`);
        const chars = Array.from(name);
        const leading = name.length - name.trimStart().length;
        const trailing = name.length - name.trimEnd().length;
        if (windows && (leading || trailing)) {
            issues.push('名称开头或结尾有空白字符');
            let units = 0;
            chars.forEach((char, index) => { if (units < leading || units >= name.length - trailing) positions.add(index); units += char.length; });
        }
        if (windows && !extension && name.endsWith('.')) { issues.push('名称不能以句点结尾'); positions.add(chars.length - 1); }
        if (windows && reserved.test(name)) { issues.push('这是系统保留名称，请修改'); chars.forEach((_, index) => positions.add(index)); }
        const bytes = windows ? name.length : new TextEncoder().encode(name).length;
        const limit = 255 - (windows ? extension.length : new TextEncoder().encode(extension).length);
        if (bytes > limit) {
            issues.push(`名称过长（${bytes} ${windows ? '字符' : '字节'}，上限 ${limit}），请缩短`);
            let size = 0;
            chars.forEach((char, index) => { size += windows ? char.length : new TextEncoder().encode(char).length; if (size > limit) positions.add(index); });
        }
        return { valid: issues.length === 0, issues, positions: [...positions] };
    }
    function clean(value, { platform = 'win32', extension = '' } = {}) {
        const windows = platform === 'win32';
        let name = String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(windows ? /[<>:"/\\|?*\x00-\x1f]/g : /[/\x00-\x1f]/g, '').trim();
        if (windows && !extension) name = name.replace(/[. ]+$/g, '');
        if (windows && reserved.test(name)) name = '_' + name;
        return name;
    }
    return { inspect, clean };
});
