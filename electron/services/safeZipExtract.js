const path = require('path');
const fs = require('fs');
const stream = require('stream');
const { promisify } = require('util');
const yauzl = require('yauzl');

const openZip = promisify(yauzl.open);
const pipeline = promisify(stream.pipeline);

function readStreamToString(readStream, maxBytes = 4096) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let total = 0;
        readStream.on('data', (chunk) => {
            total += chunk.length;
            if (total > maxBytes) {
                readStream.destroy(new Error('Symlink target exceeds maximum length'));
                return;
            }
            chunks.push(chunk);
        });
        readStream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        readStream.on('error', reject);
    });
}

function getEntryFlags(entry) {
    const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
    const IFMT = 0o170000;
    const IFDIR = 0o040000;
    const IFLNK = 0o120000;
    const isSymlink = (mode & IFMT) === IFLNK;
    let isDir = (mode & IFMT) === IFDIR;
    if (!isDir && entry.fileName.endsWith('/')) {
        isDir = true;
    }
    const madeBy = entry.versionMadeBy >> 8;
    if (!isDir && madeBy === 0 && entry.externalFileAttributes === 16) {
        isDir = true;
    }
    const procMode = (mode & 0o777) || (isDir ? 0o755 : 0o644);
    return { mode, isDir, isSymlink, procMode };
}

/**
 * Validate a ZIP archive against Zip Slip (CVE-2026-19693) and Symlink Traversal (CVE-2026-56876 / GHSA-jmr9-qjv8-65gv).
 *
 * @param {string} zipPath - Path to the .zip archive
 * @param {string} targetDir - Extraction root directory
 * @param {object} opts - Options ({ allowInternalSymlinks?: boolean })
 */
async function validateZipEntries(zipPath, targetDir, { allowInternalSymlinks = false } = {}) {
    if (!path.isAbsolute(targetDir)) {
        throw new Error('Target directory is expected to be absolute');
    }
    await fs.promises.mkdir(targetDir, { recursive: true });
    const rootDir = await fs.promises.realpath(targetDir);
    const rootPrefix = rootDir.endsWith(path.sep) ? rootDir : rootDir + path.sep;

    const zipfile = await openZip(zipPath, { lazyEntries: true, validateEntrySizes: true });
    const openReadStream = promisify(zipfile.openReadStream.bind(zipfile));
    const seenSymlinks = new Set();

    return new Promise((resolve, reject) => {
        let settled = false;
        const fail = (err) => {
            if (settled) return;
            settled = true;
            try { zipfile.close(); } catch (_) {}
            reject(err);
        };

        zipfile.on('error', fail);
        zipfile.on('close', () => {
            if (!settled) {
                settled = true;
                resolve();
            }
        });

        zipfile.on('entry', async (entry) => {
            if (settled) return;
            try {
                const rawName = String(entry.fileName || '');
                if (!rawName || rawName.includes('\0') || rawName.includes('\\')) {
                    throw new Error(`Unsafe ZIP entry filename: ${rawName}`);
                }
                if (path.isAbsolute(rawName) || /^[a-zA-Z]:/.test(rawName)) {
                    throw new Error(`Absolute path in ZIP entry is not allowed: ${rawName}`);
                }
                const segments = rawName.split('/');
                if (segments.includes('..')) {
                    throw new Error(`Path traversal segment (..) in ZIP entry: ${rawName}`);
                }

                const resolvedDest = path.resolve(rootDir, rawName);
                if (resolvedDest !== rootDir && !resolvedDest.startsWith(rootPrefix)) {
                    throw new Error(`ZIP entry escapes target directory: ${rawName}`);
                }

                if (seenSymlinks.has(resolvedDest)) {
                    throw new Error(`Duplicate ZIP entry overwriting symlink: ${rawName}`);
                }

                const { isSymlink } = getEntryFlags(entry);

                if (isSymlink) {
                    if (!allowInternalSymlinks) {
                        throw new Error(`Symbolic link entry is not permitted in archive: ${rawName}`);
                    }
                    const readStream = await openReadStream(entry);
                    const linkTarget = (await readStreamToString(readStream)).trim();
                    if (!linkTarget || linkTarget.includes('\0') || linkTarget.includes('\\')) {
                        throw new Error(`Invalid symlink target in ZIP entry: ${rawName}`);
                    }
                    if (path.isAbsolute(linkTarget) || /^[a-zA-Z]:/.test(linkTarget)) {
                        throw new Error(`Absolute symlink target in ZIP entry is not allowed: ${rawName} -> ${linkTarget}`);
                    }
                    const resolvedTarget = path.resolve(path.dirname(resolvedDest), linkTarget);
                    if (resolvedTarget !== rootDir && !resolvedTarget.startsWith(rootPrefix)) {
                        throw new Error(`Symlink target escapes extraction directory: ${rawName} -> ${linkTarget}`);
                    }
                    seenSymlinks.add(resolvedDest);
                }

                zipfile.readEntry();
            } catch (err) {
                fail(err);
            }
        });

        zipfile.readEntry();
    });
}

/**
 * Safely extract a ZIP archive using yauzl after validating all entries.
 * Replaces unmaintained extract-zip (CVE-2026-56876 / CVE-2026-19693).
 */
async function safeExtractZip(zipPath, opts = {}) {
    if (!opts || !opts.dir) {
        throw new Error('safeExtractZip requires opts.dir');
    }
    const { allowInternalSymlinks = false, onEntry } = opts;
    await validateZipEntries(zipPath, opts.dir, { allowInternalSymlinks });

    const rootDir = await fs.promises.realpath(opts.dir);
    const rootPrefix = rootDir.endsWith(path.sep) ? rootDir : rootDir + path.sep;
    const zipfile = await openZip(zipPath, { lazyEntries: true, validateEntrySizes: true });
    const openReadStream = promisify(zipfile.openReadStream.bind(zipfile));

    return new Promise((resolve, reject) => {
        let settled = false;
        const fail = (err) => {
            if (settled) return;
            settled = true;
            try { zipfile.close(); } catch (_) {}
            reject(err);
        };

        zipfile.on('error', fail);
        zipfile.on('close', () => {
            if (!settled) {
                settled = true;
                resolve();
            }
        });

        zipfile.on('entry', async (entry) => {
            if (settled) return;
            try {
                if (entry.fileName.startsWith('__MACOSX/')) {
                    zipfile.readEntry();
                    return;
                }
                if (typeof onEntry === 'function') {
                    onEntry(entry, zipfile);
                }

                const dest = path.resolve(rootDir, entry.fileName);
                if (dest !== rootDir && !dest.startsWith(rootPrefix)) {
                    throw new Error(`Out of bound path found while extracting ${entry.fileName}`);
                }

                const { isDir, isSymlink, procMode } = getEntryFlags(entry);
                const destDir = isDir ? dest : path.dirname(dest);
                await fs.promises.mkdir(destDir, { recursive: true, mode: isDir ? procMode : 0o755 });

                const canonicalDestDir = await fs.promises.realpath(destDir);
                if (canonicalDestDir !== rootDir && !canonicalDestDir.startsWith(rootPrefix)) {
                    throw new Error(`Out of bound canonical path "${canonicalDestDir}" while processing ${entry.fileName}`);
                }

                if (isDir) {
                    zipfile.readEntry();
                    return;
                }

                const readStream = await openReadStream(entry);
                if (isSymlink) {
                    const linkTarget = (await readStreamToString(readStream)).trim();
                    const resolvedTarget = path.resolve(path.dirname(dest), linkTarget);
                    if (resolvedTarget !== rootDir && !resolvedTarget.startsWith(rootPrefix)) {
                        throw new Error(`Symlink target escapes extraction directory: ${entry.fileName}`);
                    }
                    try { await fs.promises.unlink(dest); } catch (_) {}
                    await fs.promises.symlink(linkTarget, dest);
                } else {
                    await pipeline(readStream, fs.createWriteStream(dest, { mode: procMode }));
                }

                zipfile.readEntry();
            } catch (err) {
                fail(err);
            }
        });

        zipfile.readEntry();
    });
}

module.exports = {
    safeExtractZip,
    validateZipEntries,
};
