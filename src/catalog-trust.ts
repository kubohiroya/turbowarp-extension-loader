// SPDX-License-Identifier: MPL-2.0
export interface CatalogEntry {url: string; sha256?: string; variants?: readonly {url: string; sha256: string}[]}
export interface CatalogTrustOptions {
    readCatalog(signal: AbortSignal): Promise<unknown>;
    parseCatalog(data: unknown): readonly CatalogEntry[];
    timeoutMs?: number;
}
interface CatalogSnapshot {urls: Set<string>; digests: Map<string, string>; listedDigests: Set<string>}
type CatalogCode = {source?: {type: string; url?: string}; actualSHA256: string};
const empty: CatalogSnapshot = Object.freeze({urls: new Set<string>(), digests: new Map<string, string>(), listedDigests: new Set<string>()});

export const createTrustedCatalog = ({
    readCatalog,
    parseCatalog,
    timeoutMs = 15000
}: CatalogTrustOptions) => {
    let pending: Promise<CatalogSnapshot> | null = null;
    // The digests the catalog lists, filled each time it is read and kept between reads: the
    // editor's cache files these as shared (no one project's), and reads this set at each write.
    const listedDigests = new Set();
    const load = () => {
        if (!pending) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            pending = Promise.resolve()
                .then(() => readCatalog(controller.signal))
                .then(data => {
                    const urls = new Set<string>();
                    const digests = new Map<string, string>();
                    for (const item of parseCatalog(data)) {
                        urls.add(item.url);
                        if (item.sha256) digests.set(item.url, item.sha256);
                        for (const variant of item.variants ?? []) {
                            urls.add(variant.url);
                            digests.set(variant.url, variant.sha256);
                        }
                    }
                    listedDigests.clear();
                    for (const digest of digests.values()) listedDigests.add(digest);
                    return {urls, digests, listedDigests: new Set(digests.values())};
                })
                .catch(() => {
                    pending = null;
                    return empty;
                })
                .finally(() => clearTimeout(timer));
        }
        return pending;
    };
    return Object.freeze({
        /**
         * What the catalog lists by digest, as one live set: empty until the catalog is first
         * read, then refilled on each read. A failed read leaves the last one in place.
         */
        listedDigests,
        /**
         * Wait for the catalog's read, starting it if no trust check has yet, so `listedDigests`
         * is filled. A read that fails settles too, and the next check reads again.
         * @returns {Promise<void>} Settles once the read has.
         */
        async ready () {
            await load();
        },
        /**
         * @param {string} url Extension URL from a project.
         * @returns {Promise<boolean>} True for a URL listed in the catalog.
         */
        async isTrustedURL (url: string) {
            return (await load()).urls.has(url);
        },
        async isTrustedURLDigest (url: string, digest: string) {
            return (await load()).digests.get(url) === digest;
        },
        /**
         * @param {object} code Loader code whose bytes were already checked against its SHA-256.
         * @returns {Promise<boolean>} True when the code is the catalog's listed code.
         */
        async isTrustedCode (code: CatalogCode) {
            const {urls, digests, listedDigests} = await load();
            // Both remote forms name a URL; which of them decides only whether a copy may be kept
            // in the opener's browser, which has nothing to do with what this build stands behind.
            if (code.source && code.source.type.startsWith('remote-') && typeof code.source.url === 'string' && urls.has(code.source.url)) {
                const listed = digests.get(code.source.url);
                return !listed || listed === code.actualSHA256;
            }
            return listedDigests.has(code.actualSHA256);
        }
    });
};

export const listTrustedDigests = async (catalog: Pick<ReturnType<typeof createTrustedCatalog>, 'isTrustedCode'>, manifest: {extensions: readonly {source: CatalogCode['source']; sha256: string}[]}) => {
    const listed: string[] = [];
    for (const spec of manifest.extensions) {
        if (await catalog.isTrustedCode({source: spec.source, actualSHA256: spec.sha256})) listed.push(spec.sha256);
    }
    return [...new Set(listed)];
};
