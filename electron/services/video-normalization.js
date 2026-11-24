// One encoding contract for clips that will later be concatenated by stream copy.
const VERSION = 'bt709-yuv420p-high-v2';
const VIDEO_ARGS = Object.freeze([
    '-profile:v', 'high', '-pix_fmt', 'yuv420p',
    '-color_range', 'tv', '-colorspace', 'bt709',
    '-color_primaries', 'bt709', '-color_trc', 'bt709',
]);
const OUTPUT_ARGS = Object.freeze([...VIDEO_ARGS, '-ar', '48000', '-ac', '2']);
function inputColor(value, fallback = 'bt709') {
    // Unknown metadata is common on generated clips. Supply a default only
    // there; valid input color values must survive until the actual conversion.
    return !value || ['unknown', 'unspecified', 'reserved', 'N/A'].includes(value)
        ? fallback : value;
}
function colorFilter(stream = {}) {
    const space = inputColor(stream.color_space === 'rgb' ? 'gbr' : stream.color_space);
    const primaries = inputColor(stream.color_primaries);
    const transfer = inputColor(stream.color_transfer);
    const range = stream.color_range === 'pc' || stream.color_range === 'jpeg' ? 'pc' : 'tv';
    for (const value of [space, primaries, transfer]) {
        if (!/^[a-z0-9_-]+$/i.test(value)) throw new Error('视频颜色参数无效');
    }
    // colorspace transforms the pixels (including the transfer curve), rather
    // than just relabelling them as BT.709 with setparams/output metadata.
    return `colorspace=all=bt709:range=tv:format=yuv420p:ispace=${space}:iprimaries=${primaries}:itrc=${transfer}:irange=${range}`;
}
module.exports = { VERSION, VIDEO_ARGS, OUTPUT_ARGS, colorFilter };
