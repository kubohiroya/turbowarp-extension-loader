import {discoverManifest, LoaderError} from './index.js';

const DEFAULTS = Object.freeze({maxArchiveBytes: 64 * 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024,
    maxEntryBytes: 16 * 1024 * 1024, maxProjectBytes: 4 * 1024 * 1024, maxEntries: 4096, maxRatio: 1000});
const decoder = new TextDecoder('utf-8', {fatal: true});
const encoder = new TextEncoder();
const fail = message => { throw new LoaderError('INVALID_ARCHIVE', message); };
const cancelled = signal => { if (signal?.aborted) throw new LoaderError('CANCELLED', 'Project preparation cancelled'); };
const table = Uint32Array.from({length: 256}, (_, value) => {
    for (let i = 0; i < 8; i++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    return value >>> 0;
});
function crcUpdate(crc, bytes) {
    for (const byte of bytes) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8);
    return crc;
}
function safeName(name) {
    if (!name || name.length > 512 || /[\\\u0000-\u001f\u007f:]/.test(name) || name.startsWith('/') ||
        name.split('/').some((part, index, all) => part === '.' || part === '..' || (!part && index !== all.length - 1))) fail('Unsafe ZIP entry path');
    return name;
}
function parseJSON(bytes, limit) {
    if (bytes.byteLength > limit) fail('Project JSON exceeds byte limit');
    try { return JSON.parse(decoder.decode(bytes)); }
    catch (error) { throw new LoaderError('INVALID_PROJECT', 'Project JSON is not valid UTF-8 JSON', undefined, error); }
}
function byteView(input) {
    if (input instanceof Uint8Array) return new Uint8Array(input);
    if (input instanceof ArrayBuffer) return new Uint8Array(input.slice(0));
    return null;
}

/** Validate the central directory before JSZip normalizes paths or inflates data. */
export function inspectZip(bytes, options = {}) {
    const limits = {...DEFAULTS, ...options};
    for (const key of Object.keys(DEFAULTS)) if (!Number.isSafeInteger(limits[key]) || limits[key] < 1) throw new TypeError(`Invalid ${key}`);
    if (!(bytes instanceof Uint8Array) || bytes.length > limits.maxArchiveBytes || bytes.length < 22) fail('Invalid or oversized ZIP');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const u16 = offset => view.getUint16(offset, true);
    const u32 = offset => view.getUint32(offset, true);
    let end = -1;
    for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
        if (u32(offset) === 0x06054b50 && offset + 22 + u16(offset + 20) === bytes.length) { end = offset; break; }
    }
    if (end < 0 || u16(end + 4) || u16(end + 6) || u16(end + 8) !== u16(end + 10)) fail('Missing or multidisk ZIP directory');
    const count = u16(end + 10), length = u32(end + 12), start = u32(end + 16);
    if (count === 65535 || start === 0xffffffff || length === 0xffffffff || count > limits.maxEntries || start + length !== end) fail('Unsupported ZIP64 or invalid directory bounds');
    const entries = new Map(), spans = [];
    let cursor = start, total = 0;
    for (let i = 0; i < count; i++) {
        if (cursor + 46 > end || u32(cursor) !== 0x02014b50) fail('Invalid central directory entry');
        const flags = u16(cursor + 8), method = u16(cursor + 10), crc = u32(cursor + 16);
        const compressed = u32(cursor + 20), size = u32(cursor + 24), nameLength = u16(cursor + 28);
        const extraLength = u16(cursor + 30), commentLength = u16(cursor + 32), local = u32(cursor + 42);
        const next = cursor + 46 + nameLength + extraLength + commentLength;
        if (next > end || u16(cursor + 34) || flags & ~0x0808 || ![0, 8].includes(method) ||
            [compressed, size, local].includes(0xffffffff)) fail('Unsupported ZIP entry encoding, encryption, or compression');
        const rawName = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
        if (!(flags & 0x0800) && rawName.some(byte => byte > 127)) fail('Non-UTF8 ZIP names are unsupported');
        let name;
        try { name = safeName(decoder.decode(rawName)); } catch { fail('Invalid ZIP entry name'); }
        if (entries.has(name)) fail('Duplicate ZIP entry');
        let extra = cursor + 46 + nameLength;
        const extraEnd = extra + extraLength;
        while (extra < extraEnd) {
            if (extra + 4 > extraEnd) fail('Malformed ZIP extra field');
            const id = u16(extra), n = u16(extra + 2);
            if (id === 1 || id === 0x7075 || extra + 4 + n > extraEnd) fail('Unsupported ZIP64 or Unicode path override');
            extra += 4 + n;
        }
        if (size > limits.maxEntryBytes || size > Math.max(1, compressed) * limits.maxRatio || (total += size) > limits.maxTotalBytes) fail('ZIP expansion exceeds limits');
        if (local + 30 > start || u32(local) !== 0x04034b50 || u16(local + 6) !== flags || u16(local + 8) !== method) fail('Invalid local ZIP header');
        const localNameLength = u16(local + 26), localExtraLength = u16(local + 28);
        const data = local + 30 + localNameLength + localExtraLength;
        if (localNameLength !== nameLength || data + compressed > start ||
            bytes.subarray(local + 30, local + 30 + nameLength).some((byte, index) => byte !== rawName[index])) fail('Conflicting local ZIP header');
        if (!(flags & 8) && (u32(local + 14) !== crc || u32(local + 18) !== compressed || u32(local + 22) !== size)) fail('Conflicting local ZIP sizes');
        spans.push([local, data + compressed]);
        entries.set(name, Object.freeze({name, size, crc, directory: name.endsWith('/')}));
        cursor = next;
    }
    if (cursor !== end) fail('Unexpected central directory bytes');
    spans.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < spans.length; i++) if (spans[i][0] < spans[i - 1][1]) fail('Overlapping ZIP entries');
    if (!entries.has('project.json') || entries.get('project.json').directory) fail('Missing project.json');
    return entries;
}

function boundedEntry(entry, metadata, signal) {
    return new Promise((resolve, reject) => {
        const stream = entry.internalStream('uint8array');
        let size = 0, crc = -1, done = false;
        const chunks = [];
        const finish = error => {
            if (done) return;
            done = true;
            signal?.removeEventListener('abort', abort);
            if (error) { stream.pause(); reject(error); }
            else {
                const bytes = new Uint8Array(size);
                let offset = 0;
                for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
                resolve(bytes);
            }
        };
        const abort = () => finish(new LoaderError('CANCELLED', 'Project preparation cancelled'));
        signal?.addEventListener('abort', abort, {once: true});
        if (signal?.aborted) return abort();
        stream.on('data', chunk => {
            if (done) return;
            size += chunk.length;
            if (size > metadata.size) return finish(new LoaderError('INVALID_ARCHIVE', 'Actual ZIP expansion exceeds declared size'));
            crc = crcUpdate(crc, chunk);
            chunks.push(new Uint8Array(chunk));
        }).on('error', error => finish(new LoaderError('INVALID_ARCHIVE', 'ZIP decompression failed', undefined, error)))
            .on('end', () => finish(size !== metadata.size || ((crc ^ -1) >>> 0) !== metadata.crc ?
                new LoaderError('INVALID_ARCHIVE', 'ZIP size or CRC mismatch') : null)).resume();
    });
}

/** ZIP implementation is injected; all manifest/archive policy remains in the core. */
export function createProjectIO({zip: Zip, ...options} = {}) {
    const limits = {...DEFAULTS, ...options};
    for (const key of Object.keys(DEFAULTS)) if (!Number.isSafeInteger(limits[key]) || limits[key] < 1) throw new TypeError(`Invalid ${key}`);
    const contexts = new WeakMap();
    let active = null;
    const get = context => {
        if (context === null || context === undefined) return null;
        const value = contexts.get(context);
        if (!value) throw new TypeError('Unknown project context');
        return value;
    };
    function merged(project, state) {
        const result = {...state.project, ...project, turboWarpPlus: state.manifest};
        result.extensions = [...new Set([...(project.extensions || []), ...state.manifest.extensions.map(spec => spec.id)])];
        const originalURLs = state.project.extensionURLs || {};
        const urls = {...(project.extensionURLs || {})};
        for (const spec of state.manifest.extensions) {
            if (Object.hasOwn(originalURLs, spec.id)) urls[spec.id] = originalURLs[spec.id];
            else delete urls[spec.id];
        }
        result.extensionURLs = urls;
        return result;
    }
    function restoreJSON(json, context) {
        const state = get(context);
        if (!state) return json;
        if (typeof json === 'string') return JSON.stringify(merged(parseJSON(encoder.encode(json), limits.maxProjectBytes), state));
        return merged(json, state);
    }
    return Object.freeze({
        async prepare(input, {signal} = {}) {
            cancelled(signal);
            if ((typeof input === 'string' && input.length > limits.maxProjectBytes) ||
                ((input instanceof Uint8Array || input instanceof ArrayBuffer) && input.byteLength > limits.maxArchiveBytes)) {
                fail('Invalid or oversized project input');
            }
            let bytes, project, files = new Map();
            if (typeof input === 'string') project = parseJSON(encoder.encode(input), limits.maxProjectBytes);
            else if (input instanceof Blob) {
                if (input.size > limits.maxArchiveBytes) fail('Input exceeds byte limit');
                bytes = new Uint8Array(await input.arrayBuffer());
            } else bytes = byteView(input);
            if (bytes) {
                if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
                    const metadata = inspectZip(bytes, limits);
                    if (!Zip || typeof Zip.loadAsync !== 'function') throw new TypeError('A compatible JSZip constructor is required');
                    const archive = await Zip.loadAsync(bytes, {checkCRC32: false, createFolders: false});
                    for (const [name, meta] of metadata) {
                        cancelled(signal);
                        const entry = archive.files[name];
                        if (!entry || entry.name !== name || Boolean(entry.dir) !== meta.directory) fail('ZIP parser changed entry identity');
                        const content = await boundedEntry(entry, meta, signal);
                        files.set(name, content);
                    }
                    project = parseJSON(files.get('project.json'), limits.maxProjectBytes);
                } else project = parseJSON(bytes, limits.maxProjectBytes);
            } else if (!project) {
                if (!input || typeof input !== 'object') throw new LoaderError('INVALID_PROJECT', 'Unsupported project input');
                project = parseJSON(encoder.encode(JSON.stringify(input)), limits.maxProjectBytes);
            }
            cancelled(signal);
            const manifest = discoverManifest(project);
            if (!manifest) return {manifest: null, input, context: null};
            if (project.extensions !== undefined && (!Array.isArray(project.extensions) || project.extensions.some(id => typeof id !== 'string'))) throw new LoaderError('INVALID_PROJECT', 'Project extensions must be an ID array');
            if (project.extensionURLs !== undefined && (!project.extensionURLs || typeof project.extensionURLs !== 'object' || Array.isArray(project.extensionURLs))) throw new LoaderError('INVALID_PROJECT', 'Project extensionURLs must be an object');
            for (const spec of manifest.extensions) if (spec.source.type === 'embedded' && !files.has(spec.source.path)) fail('Missing embedded extension entry');
            const context = Object.freeze({});
            contexts.set(context, {manifest, project, files});
            const legacy = {...project};
            delete legacy.turboWarpPlus;
            const ids = new Set(manifest.extensions.map(spec => spec.id));
            // Keep requested IDs for the GUI registration hook; remove automatic URL loading.
            legacy.extensions = [...new Set([...(project.extensions || []), ...ids])];
            legacy.extensionURLs = {...(project.extensionURLs || {})};
            for (const id of ids) delete legacy.extensionURLs[id];
            let prepared;
            if (files.size) {
                const archive = new Zip();
                for (const [name, content] of files) archive.file(name, content, {dir: name.endsWith('/'), createFolders: false});
                archive.file('project.json', JSON.stringify(legacy));
                prepared = await archive.generateAsync({type: 'uint8array', compression: 'STORE'});
            } else prepared = typeof input === 'object' && !bytes && !(input instanceof Blob) ? legacy : JSON.stringify(legacy);
            cancelled(signal);
            return {manifest, input: prepared, context};
        },
        activate(context) { get(context); active = context; },
        embeddedReader: Object.freeze({
            async read(path, {signal, maxBytes} = {}) {
                cancelled(signal);
                const bytes = get(active)?.files.get(path);
                if (!bytes || bytes.length > (maxBytes ?? limits.maxEntryBytes)) fail('Missing or oversized embedded content');
                return new Uint8Array(bytes);
            }
        }),
        restoreJSON,
        restoreFiles(files, context) {
            const state = get(context);
            if (!state) return files;
            const result = {...files};
            for (const [name, bytes] of state.files) if (name !== 'project.json' && (!Object.hasOwn(result, name) || name.startsWith('extensions/'))) Object.defineProperty(result, name, {value: new Uint8Array(bytes), writable: true, configurable: true, enumerable: true});
            if (!(result['project.json'] instanceof Uint8Array)) throw new TypeError('Serialized files need project.json bytes');
            result['project.json'] = encoder.encode(restoreJSON(decoder.decode(result['project.json']), context));
            return result;
        },
        restoreArchive(archive, context) {
            const state = get(context);
            if (!state) return archive;
            // The GUI toJSON hook has already restored project.json synchronously.
            for (const [name, bytes] of state.files) if (name !== 'project.json' && (!archive.file(name) || name.startsWith('extensions/'))) archive.file(name, new Uint8Array(bytes), {dir: name.endsWith('/'), createFolders: false});
            return archive;
        }
    });
}
