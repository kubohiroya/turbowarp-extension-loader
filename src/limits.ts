const MiB = 1024 * 1024;

/**
 * The one source of the default size limits. A file the project codec accepts as an archive entry
 * must also be one the loader reads, so the per-extension and total defaults are the codec's entry
 * and expansion limits; real extensions such as a bundled story runtime reach several MiB.
 */
export const DEFAULT_ENTRY_BYTES = 16 * MiB;
export const DEFAULT_TOTAL_BYTES = 64 * MiB;
/** A project.json may itself carry large scripts, such as legacy Data URL extensions or story data. */
export const DEFAULT_PROJECT_JSON_BYTES = 32 * MiB;
export const DEFAULT_LOADER_LIMITS = Object.freeze({maxExtensions: 64, maxBytes: DEFAULT_ENTRY_BYTES,
    maxTotalBytes: DEFAULT_TOTAL_BYTES, timeoutMs: 30000});
/** A cache holds at least one extension of the largest default size. */
export const DEFAULT_MEMORY_CACHE_BYTES = 2 * DEFAULT_ENTRY_BYTES;
/** Base64 of the largest default extension, plus room for the `data:` prefix. */
export const MAX_LEGACY_DATA_URL_LENGTH = Math.ceil(DEFAULT_ENTRY_BYTES / 3) * 4 + 1024;
