import type {PreparedProject, ProjectIO, ZipConstructor} from './project-codec.js';

/** The project.json fields Plus code reads; every other field is carried through unchanged. */
export interface ProjectJSON {
    [key: string]: unknown;
    extensions?: string[];
    extensionURLs?: Record<string, unknown>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true});

/** Decode only an input already checked by the archive codec, restoring its metadata. */
export async function readPreparedProject(prepared: PreparedProject, io: ProjectIO, Zip: ZipConstructor): Promise<{project: ProjectJSON; files: Record<string, Uint8Array<ArrayBuffer>>}> {
    let input = prepared.input;
    if (input instanceof Blob) input = new Uint8Array(await input.arrayBuffer());
    else if (input instanceof ArrayBuffer) input = new Uint8Array(input);
    let project: ProjectJSON;
    let files: Record<string, Uint8Array<ArrayBuffer>> = {};
    if (input instanceof Uint8Array && input[0] === 0x50 && input[1] === 0x4b) {
        const archive: {files: Record<string, {async(type: 'uint8array'): Promise<Uint8Array<ArrayBuffer>>}>} =
            await Zip.loadAsync(input, {checkCRC32: false, createFolders: false});
        files = Object.fromEntries(await Promise.all(Object.entries(archive.files).map(async ([name, entry]) =>
            [name, await entry.async('uint8array')])));
        project = JSON.parse(decoder.decode(files['project.json']));
    } else if (input instanceof Uint8Array) project = JSON.parse(decoder.decode(input));
    else if (typeof input === 'string') project = JSON.parse(input);
    else project = input as ProjectJSON;
    files['project.json'] = encoder.encode(JSON.stringify(project));
    // The codec owns restoration of the original manifest, URLs and archive data.
    // JSZip output, encoded JSON and the codec's restored copies all use plain ArrayBuffers.
    files = io.restoreFiles(files, prepared.context) as Record<string, Uint8Array<ArrayBuffer>>;
    return {project: JSON.parse(decoder.decode(files['project.json'])), files};
}
