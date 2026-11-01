const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true});

/** Decode only an input already checked by the archive codec, restoring its metadata. */
export async function readPreparedProject(prepared, io, Zip) {
    let input = prepared.input;
    if (input instanceof Blob) input = new Uint8Array(await input.arrayBuffer());
    else if (input instanceof ArrayBuffer) input = new Uint8Array(input);
    let project;
    let files = {};
    if (input instanceof Uint8Array && input[0] === 0x50 && input[1] === 0x4b) {
        const archive = await Zip.loadAsync(input, {checkCRC32: false, createFolders: false});
        files = Object.fromEntries(await Promise.all(Object.entries(archive.files).map(async ([name, entry]) =>
            [name, await entry.async('uint8array')])));
        project = JSON.parse(decoder.decode(files['project.json']));
    } else if (input instanceof Uint8Array) project = JSON.parse(decoder.decode(input));
    else if (typeof input === 'string') project = JSON.parse(input);
    else project = input;
    files['project.json'] = encoder.encode(JSON.stringify(project));
    // The codec owns restoration of the original manifest, URLs and archive data.
    files = io.restoreFiles(files, prepared.context);
    return {project: JSON.parse(decoder.decode(files['project.json'])), files};
}
