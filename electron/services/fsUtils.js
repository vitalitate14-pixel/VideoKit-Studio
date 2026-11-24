/**
 * 跨平台安全文件移动工具（兼容 Windows 跨盘符 EXDEV 与短暂占用 EPERM/EBUSY）
 */
const fs = require('fs');
const path = require('path');

function safeMoveFileSync(src, dst) {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    try {
        fs.renameSync(src, dst);
        return;
    } catch (err) {
        if (!err || !['EXDEV', 'EPERM', 'EBUSY', 'EACCES'].includes(err.code)) {
            throw err;
        }
    }
    const srcSize = fs.statSync(src).size;
    fs.copyFileSync(src, dst);
    const dstSize = fs.statSync(dst).size;
    if (dstSize !== srcSize) {
        try { fs.unlinkSync(dst); } catch (_) { }
        throw new Error(`跨盘符移动文件校验失败（源 ${srcSize}B vs 目标 ${dstSize}B），已保留源文件`);
    }
    fs.unlinkSync(src);
}

module.exports = {
    safeMoveFileSync,
};
