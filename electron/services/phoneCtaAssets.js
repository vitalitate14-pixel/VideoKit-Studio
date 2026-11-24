const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function saveInlineImage(dataUrl, directory) {
    const match = String(dataUrl || '').match(/^data:image\/(png|jpe?g|webp|gif|svg\+xml);base64,([a-z0-9+/=\s]+)$/i);
    if (!match) throw new Error('电话图片格式无效');
    const bytes = Buffer.from(match[2], 'base64');
    if (!bytes.length) throw new Error('电话图片内容为空');
    const extension = /jpe?g/i.test(match[1]) ? 'jpg' : match[1].toLowerCase() === 'svg+xml' ? 'svg' : match[1].toLowerCase();
    const file = path.join(directory, crypto.createHash('sha256').update(bytes).digest('hex') + '.' + extension);
    fs.mkdirSync(directory, { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, bytes);
    return { path: file };
}

module.exports = { saveInlineImage };
