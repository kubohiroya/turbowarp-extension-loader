# turbowarp-extension-loader

English | [日本語](README.ja.md)

The GUI-independent core of [Editor Issue #4](https://github.com/kubohiroya/turbowarp-plus-editor/issues/4). It lives in its own Git repository and is published to npm as `@kubohiroya/turbowarp-extension-loader` under MPL-2.0. It does not replace any existing distribution library or npm package.

```sh
npm install @kubohiroya/turbowarp-extension-loader
```

## Scope

- A schema v1 Manifest lives in `turboWarpPlus`, a non-standard field of `project.json`. This is not part of the standard SB3 specification.
- Strict Manifest validation: unknown fields rejected, duplicate and standard extension IDs rejected, dependency ordering enforced, cyclic and missing dependencies rejected.
- Per-extension resolution in any of the four source forms, a mandatory pinned SHA-256, UTF-8 validation, and per-code and total size limits.
- A SHA-256-keyed cache port. Every read re-verifies the exact bytes, and a cache hit still requires host authorization.
- Registration starts only after explicit host authorization and only once every extension has been verified and authorized. A registration ID mismatch or a registration failure requires the host transaction to roll back.
- Cancellation, fetch and authorization timeouts, a bounded retry of transient Remote failures, duplicate load rejection, unload, and diagnostic events.

Standard extensions, generic custom URLs and legacy Data URLs are not reinterpreted. For a project without a Manifest, no host port is called. `execution: "unsandboxed"` inside a project is a request, not a permission. Unknown fields such as `trusted` are rejected.

### Source forms

A `source` names where one extension's bytes live, as the author of the project decided. There are four forms, and they are the same four names the SB3 save format and the screen that offers the choice use, so nothing is translated between layers.

| Form | Shape | Where the bytes come from |
| --- | --- | --- |
| `remote-non-cacheable` | `{type, url}` | an HTTPS fetch of `url`, every time |
| `remote-cacheable` | `{type, url}` | the cache port, else an HTTPS fetch of `url` |
| `embedded-file` | `{type, path, url?}` | the archive entry at `path`, else `url` |
| `embedded-data` | `{type, url?}` | the `data:` carrier in the project document, else `url` |

The two embedded forms are siblings: both make a project that runs offline, anywhere, on its own. They differ in the carrier, and the carrier decides who else can read it — `embedded-data` is what lets a standard TurboWarp host open the project without knowing this Manifest, because that host looks for a URL in the project document and the bytes are that URL.

A carried copy is not a weaker source: the Manifest pins the SHA-256, so the copy either is exactly the pinned code or the load fails with `DIGEST_MISMATCH`. When the carrier is missing the loader reports a `retained-copy-unavailable` diagnostic and falls back to `url` under the same redirect and final-URL policy as a reference. `path` follows the `extensions/*.js` policy.

The cache is reached for `remote-cacheable` and for nothing else. An embedded project already carries the bytes, so a second copy in the browser buys nothing and the author never asked for one.

The three spellings older versions used — `remote`, `cached` and `embedded` — are **refused**, each with a message naming what replaces it. The two that became a pair are not translated at all: the old name left the choice implicit and the reader is the one who has to make it.

## Host integration

```js
import {createExtensionLoader, createFetchPort} from '@kubohiroya/turbowarp-extension-loader';

const loader = createExtensionLoader({
    embeddedReader: archiveReader,
    fetcher: createFetchPort(),
    trustProvider: {
        async authorize(resolved, {signal}) {
            const approved = await showHostPermissionDialog(resolved, signal);
            return {allowed: approved, scope: 'digest', sha256: resolved.sha256};
        }
    },
    registrar: hostTransactionalRegistrar,
    diagnostics: event => displayDiagnostic(event)
});

await loader.loadProject(parsedProjectJSON);
// A new project must unload the prior project first.
await loader.unload();
```

The `trustProvider` is owned by the host. It receives the requested ID, the version, the claimed publisher, the source, the SHA-256 and the requested capabilities, and decides using an approval UI or a fixed host policy. Do not base approval on names, domains or publisher strings carried inside the project alone. A SHA-256 guarantees content consistency only — not safety, and not the identity of the publisher. Storing, revoking and expiring approval history is the host's responsibility.

The registration port implements `begin({signal})` → `register(authorizedCode, {signal})` → `commit({signal})`, and must be able to restore the registration state with `rollback()` when any registration fails. `register()` returns a registration result `{id}` that corresponds to the actual `getInfo().id`. The host should also reject ID collisions inside an existing VM. `unload(ids)` is called in reverse dependency order. The contracts are written in the TypeScript types published as `dist/*.d.ts`.

The scratch-vm adapters are in `./scratch-vm` (see below). The registrar there, combined with `getExtensionServicePort()`, which is added to the VM, it tracks ownership of the registration table and dispatch service of the same VM so that rollback and unload work. The Packager, a separate bundle from the Editor, uses the same service inside the VM. Within one bundle using a standard VM it confirms dispatch identity; in an unsupported separate bundle it refuses. The Loader core itself does not depend on any VM private API.

## Security boundary and constraints

- The core does not evaluate JS. Evaluation privileges and VM internal APIs stay with the host.
- Rollback is a guarantee about the host's extension registration state. It cannot undo DOM, network or other side effects of privileged JS that has already been evaluated. Approving that the code is safe remains a separate decision.
- The initial version rejects HTTP for Remote, URLs carrying credentials, fragments and redirects. A successful HTTPS fetch alone does not authorize anything.
- `createFetchPort()` disables redirects, sends no credentials, sends no referrer, and enforces the real size limit on the stream. A fetch refused by CORS / CSP / offline conditions is preserved in the `cause` of `LOAD_FAILED`, and a failed HTTP response keeps its status there. Detailed classification of network-layer failures is left to `cause`; CORS and CSP are verified by real-browser E2E tests on the Editor side.
- An injected fetch port must return `finalURL` and an explicitly empty `redirects`. The port itself is a boundary implemented by the trusted host, which is where retrying lives as well; see below.
- Fetching and authorization time out even against a port that never responds. Registration waits for completion before rolling back, even after cancellation. To avoid a race between a late-completing registration and a rollback, a registration port that does not respond to `AbortSignal` cannot guarantee that an in-flight registration finishes in bounded time.
- Cache capacity, invalidation, persistence and provenance logging belong to the host's port. A corrupted cache is never silently ignored in favour of switching to Remote.
- `./packager` provides conversion between the source forms, Data URL migration with explicit approval, lock and license metadata preservation, and offline SB3 preparation. An extension with external dependent resources is rejected rather than guessed into a bundle. Signature and publisher key pinning can be added by the host; the initial implementation is session approval bound to content and source.
- The ZIP implementation is injected through `createProjectIO({zip: JSZip})`. The core codec inspects the ZIP central directory directly and validates duplicates, paths and declared capacity before checking the real expanded size and CRC32 of the stream. An externally implemented archive port needs equivalent validation.

The defaults are at most 64 extensions, 16 MiB per extension, 64 MiB in total, and 30 seconds for fetching and authorization. The per-extension and total defaults equal the project codec's per-entry and expansion limits, so any extension file a project can carry is also one the Loader reads; a host can lower them through its loader options. There is no development-mode exception for Data URLs or HTTP. Because standard TurboWarp and unsupported editors may discard the non-standard Manifest and ZIP entries, re-saving in a host without preservation support is not a migration path.

### Retrying a transient Remote failure

Retrying lives at the fetch port. `createFetchPort()` wraps itself in `withFetchRetry()`, so a host on the default port needs no change, and a host that injects its own port can wrap it the same way with `withFetchRetry(hostPort)`. The core does not retry inside its own resolution loop, for two reasons: retrying is a transport policy, while the other failures in that loop — a digest mismatch, a corrupt cache entry, a trust refusal — must never be repeated; and the core cannot classify what an arbitrary port throws, so retrying there would either guess or force every existing port into a new error contract. **The consequence is that the core cannot impose this on an injected port.** A host that implements its own port decides for itself, and `./project-catalog` and `./project-authoring` retry exactly as much as the port they are handed does.

| Failure | Retried | Not retried |
| --- | --- | --- |
| An HTTP response | 408, 425, 429 and every 5xx | every other 4xx, 404 among them: the answer is that it is not there |
| No response at all | a connection that could not be made | an `AbortSignal` abort, the deadline included |
| Before the request | — | a rejected URL, HTTP, credentials or a fragment (`INVALID_SOURCE`) |
| After the response | — | a redirect or an unproven final URL (`FETCH_FAILED`, `REDIRECT_DENIED`), the byte limit (`INVALID_BYTES`), a digest mismatch, a corrupt cache entry, a trust refusal |
| A cache hit | — | a hash-pinned entry never contacts the CDN, so there is nothing to retry |

`isTransientFetchFailure(error)` is the exported classifier, and a `FETCH_FAILED` from `createFetchPort()` keeps the HTTP status in its `cause` so a wrapper can read it. One case cannot be classified: in a browser, `fetch()` rejects with the same `TypeError` whether the connection could not be made, DNS failed, the browser is offline, or CORS or CSP refused the request. That is deliberate in the specification. A CORS or CSP refusal is therefore retried along with the connection failure this was written for, which is affordable only because the budget is small — and is why it is small.

**The wait is bounded twice.** `DEFAULT_FETCH_RETRY` allows 2 retries, backing off 400 ms and then 800 ms, and starts no attempt more than 5 seconds after the first one; the budget covers the backoff, so a slow first attempt spends it. Above that, the 30-second fetch and authorization deadline still covers the whole operation — every extension's fetch, authorization and registration under one timer, not one timer per fetch. Retrying therefore does not multiply the deadline: 30 seconds was the worst case before this and remains the worst case after it, and the budget only decides how much of those 30 seconds one URL may spend asking again. A backoff wait is interrupted by the signal rather than waited out, so cancelling stays immediate. `createFetchPort(fetchImpl, {retries: 0})` restores the previous single attempt, and `onRetry` reports every wait so a host can show progress.

Giving up is final. Registration starts only once every entry is verified and authorized, so one entry whose retries are spent ends the whole operation: the entries after it are never fetched, because entries are resolved one at a time; the operation's `AbortSignal` is aborted so port work it no longer waits for stops; the host transaction rolls back and the original project is restored. From there the person waiting is the retry mechanism, and the host asks them to open the project or add the extension again. The asymmetry with build-time catalog generation, where nobody is watching and a retry has to absorb the failure, is deliberate.

**Whether to offer "try again" is a separate question, with a separate classifier.** `isTransientFetchFailure(error)` is for a fetch port looking at one transfer, deciding whether to retry by itself. A host holding the rejection of a whole operation — `load()`, `./project-catalog` or `./project-authoring` — asks `isWorthAskingAgain(error)` instead, and the two differ on the most common case: a browser `TypeError` reaches the host wrapped in `LOAD_FAILED`, which the first classifier answers no to and the second answers yes. `isWorthAskingAgain` says yes only when every failure inside is one a later attempt could avoid: a transport failure that came out of a fetch port (offline, DNS, CORS, CSP), an HTTP 408, 425, 429 or 5xx, or the operation's `TIMEOUT`. It says no for a refusal asking again would repeat (`DIGEST_MISMATCH`, `CACHE_INTEGRITY`, `REDIRECT_DENIED`, `INVALID_SOURCE`, `TRUST_DENIED`, `UNSUPPORTED_SCHEMA`, any other HTTP 4xx and every other code), for `CANCELLED`, because a person cancelling is their own answer, for `ROLLBACK_FAILED`, because the host must recover first, and for anything it cannot account for — including a bare `TypeError` the host itself threw, which the Loader tells apart from a transport failure by where it came from. One permanent refusal anywhere in an `AggregateError` or a `cause` chain makes the answer no. `onRetry` also reports `attempts`, the most a fetch can make in all, so a host can say "attempt 2 of 3" without knowing the retry settings.

## IndexedDB persistent cache (for browser hosts)

The design assumes CDN delivery of a pinned npm `name@exact-version`, and is **cache first**. When a hash-pinned cache entry exists, the CDN is not contacted whether online or offline. Only a cache miss goes through the existing Remote fetch port. The host must guarantee that URLs never use a mutable specifier such as `latest`, a semver range, or an omitted version. Cached content has no TTL: it is removed only by LRU eviction on quota overflow, by explicit clearing, or by the browser deleting site storage. SHA-256 verification after gzip decompression and authorization for unsandboxed execution are still required every time.

`./indexeddb-cache` is an **optional Cache Port adapter** that reuses JS bytes already fetched remotely and verified by SHA-256 across browser restarts. The Loader core carries no IndexedDB dependency.

```js
import {createIndexedDBContentCache}
    from '@kubohiroya/turbowarp-extension-loader/indexeddb-cache';

const cache = createIndexedDBContentCache({
    databaseName: 'turbowarp-plus-extension-cache',
    maxBytes: 32 * 1024 * 1024, // compressed storage quota
    maxDecompressedBytes: 16 * 1024 * 1024
});
const loader = createExtensionLoader({...hostPorts, cache});
// On an explicit action such as exit or sign-out: await cache.clear() / await cache.close()
```

- The key is a lowercase SHA-256 hex digest. **The stored value is gzip-compressed bytes, not raw JS** (format `gzip-v1`, with the original size recorded alongside). It is decompressed on read and returned to the Loader. The default 32 MiB is the **total compressed storage quota**, the maximum decompressed size is 16 MiB (the per-extension default), and entries do not expire. On quota overflow, entries are evicted in least-recently-accessed order. Uncompressed entries in the old format are deleted rather than read.
- Decompression bounds the output size and rejects tampering, gzip corruption and oversized expansion. The browser's `CompressionStream` / `DecompressionStream` is required. The adapter never silently falls back to storing raw JS in an unsupported environment.
- Even on a cache hit, the Loader core **re-verifies the SHA-256 of the returned bytes** and applies the `trustProvider` decision every time. The cache never stands in for a trust decision.
- The cache is bound to a browser origin that can use IndexedDB, and may disappear when the browser clears storage, in private mode, when storage runs out, and so on. The browser offers no persistence guarantee.
- Where IndexedDB is unavailable, creation fails explicitly. A host may fall back to `createMemoryContentCache` if it wants to, but decide a failure policy on the host side rather than unconditionally ignoring a cache failure and executing code anyway.
- Fetching and storing new Remote bytes still requires a separate authorization every time. Dependent resources and external services fetched from inside the code are outside the scope of this cache.
- The Web and Editor hosts should only initialize and inject this port, and should not implement separate cache logic in `scratch-gui` or `turbowarp-plus-editor`.

### Whose bytes these are, and releasing them

The cache is content-addressed: the key is the digest, so one extension that two projects both use
is one copy, and no project can put the wrong bytes under a key it does not have the bytes for.
That is why sharing is safe, and it is also why an entry does not belong to anyone. A second store
records the claims, so a project's share can be listed and released without storing its bytes
twice.

```js
const cache = createIndexedDBContentCache({appURI: manifest.uri, sharedDigests: catalogDigests});

await cache.listBuckets();                 // every project that holds something, and how much
await cache.listBucket(manifest.uri);      // what this one holds
await cache.listBucket(SHARED_BUCKET);     // what belongs to no one project
await cache.deleteBucket(manifest.uri);    // release it, and any bytes nothing else refers to
```

A catalog extension is pinned to a version and shared by many projects, so `sharedDigests` keeps it
out of whichever project happened to fetch it first: that project would otherwise look responsible
for storage every other one reuses, and releasing it would evict bytes the rest still want. The set
is read at each write, so a host may keep filling it as its catalog loads. A host that cannot say
which project it is opening files everything as shared, because guessing a name is worse than
admitting there is none.

A host that keeps one cache while projects are opened and closed — one per VM, say — passes
`appURI` as a function instead. Like `sharedDigests`, it is read at each write (when `put` is
called), so each write is filed under the project open at that moment, and a function that returns
`undefined` files that write as shared. A string still names one project for the cache's lifetime.

```js
let openProject;                           // the URI of the project open now, or undefined
const cache = createIndexedDBContentCache({appURI: () => openProject, sharedDigests: catalogDigests});
// on each load: openProject = prepared.manifest?.uri;
```

Releasing a bucket drops its claims and reclaims only the bytes **nothing else refers to**. One
copy referred to twice stays: the other project did not ask to lose it. An eviction takes the
claims on it as well, so a bucket never lists bytes that are gone.

Because there is no record of who put an entry there, releasing a project means releasing the
digests **that project names** — which may evict bytes another project would have reused. That
costs a fetch and nothing else, but a list shown to a person should not claim more than that.

## Where an extension's bytes come from

The family holds anything — extensions included — in one of four forms, and the author of the
project decides which.

| Form | Browser (IndexedDB) | Project (SB3) | Standard TurboWarp |
| --- | --- | --- | --- |
| `remote-non-cacheable` | nothing kept | reference only | cannot open it |
| `remote-cacheable` | a verified copy may be kept | reference only | cannot open it |
| `embedded-file` | not used | the project carries the bytes | cannot open it |
| `embedded-data` | not used | the project carries the bytes | **can open it** |

### What the author decides, and what the opener may decline

All four are the author's decision and are already in the manifest. What is left to ask at load
time is narrower: whether the person opening the project keeps a copy of a `remote-cacheable`
extension in **their own** browser. Storage is their device, so they can come in under what the
author permitted — and only under it:

```js
await loader.load(manifest, {
    // IDs this person will not keep a copy of. Leaving it out keeps what the author permitted.
    declineCaching: new Set(['someextension'])
});
```

A set, not a map, because this can only ever refuse. `remote-non-cacheable` is a prohibition with
no opposite to write: the author has reasons the opener cannot see — a kept copy hides a URL that
stopped serving the pinned bytes until the copy runs out, and a work handed to a shared machine
should leave no code behind. Declining is always safe; the worst it costs is a fetch. Naming
anything else has no effect, since the other three forms reach the cache either way.

Declining holds in both directions: the cache is not read for that extension and not written
either, so a person who asked to leave nothing behind leaves nothing behind.

### Where a reference can still be reached from

`url` on an embedded source records where the bytes came from:

```json
{"type": "embedded-file", "path": "extensions/thing-<sha256>.js", "url": "https://example.test/thing.js"}
```

It does two things: it lets a missing carrier fall back to a fetch, and it is the only thing that
keeps a path back to a reference form open. Without it the project can never be converted to
`remote-cacheable` again, because there is nothing to point at.

`prepareCatalogExtensionChanges` takes `distribution` as one of the same four names. A catalog
extension was fetched from an address, so both embedded forms keep that address beside the bytes
rather than discarding what is already known, and the URL is checked against the pinned bytes
whichever form it is stored in. A url is optional for the general case, where bytes nobody
fetched — a costume, a sound, an extension written in the editor — have no address to record.

## What identifies one project

A manifest may carry a `uri`: the address the project can be downloaded from, which is also what
identifies it.

```json
{"schemaVersion": 1, "uri": "https://example.test/editor/turbowarp-plus-projects/66/66aa/0193f0a1-2b3c-7d4e-8f01-2233445566aa.sb3", "extensions": []}
```

One work, one URI, across every edit — including the edits that change its extensions, which
rebuild the manifest around it. That is why it is an address and not a fingerprint: a
fingerprint changes on every save, so a browser cache and a record of what the opener chose would
file one work under a new name each time it was touched. An address does not change when the bytes
do.

`prepareCatalogExtensionChanges` and `prepareExtensionAddition` take a `uri` option, which is how
a project gets its first address and how it moves to one the author chose. Saying nothing keeps
the address the project already has, and `readProjectAuthoringState` reports that address, so a
host can tell a first save from a later one before deciding. A project opened through
`./project-codec` whose Manifest has no address is given one at save time with
`assignProjectURI` (see "SB3 codec"). Whether to assign one is the host's
call: only the host knows whether the author chose an address or whether this is a first save
that needs a default.

`createProjectUUID` and `defaultProjectURI` in `./project-authoring` build the address a project
is given when its author has not chosen one:

```js
const uri = defaultProjectURI(location.origin, createProjectUUID());
```

The origin is that of the domain the editor was opened at, with no path (passing the path of
`editor.html` would put the address under it). It is never a host the editor does not serve from,
because this address travels inside the SB3 when the work is handed on. The identifier is a UUID version 7, so it sorts by when
the project was first saved, and the two directory levels are taken from its **end** — a version 7
UUID begins with the top of a millisecond clock, which barely moves, so sharding on its first
characters would put every project ever created in one directory.

The address is deliberately opaque. A readable one would be derived from the title and would
change when the title changed, filing one work under a second name; readability belongs to the
deliberate act of publishing, where the author names the address themselves. A list meant for a
person shows the project's title beside this.

Nothing is served from the address until the author publishes there, and that is expected. **A URI
that does not resolve says nothing**: a work saved but never published and a published work whose
address rotted look exactly alike. Never decide anything by whether it resolves, least of all what
to delete. The URI is also the project's own claim and is not verified — a work can name any
address, including another's. What that can spoil is bookkeeping and nothing else, because the
cache is keyed by digest and every hit is verified against it.

## Source and build

The source and the tests are TypeScript, in `src/*.ts` and `test/*.test.ts`, laid out the same way as the other `@kubohiroya/turbowarp-*` packages: `tsconfig.json` typechecks without emitting, `tsconfig.build.json` extends it to emit, and `test/tsconfig.json` extends it for the tests. `npm run build` (`tsc -p tsconfig.build.json`) emits ES2022 ESM and type declarations to `dist/`, and `exports`, `main`/`module` and the root files used by webpack 4 (`packager.js` and the rest) all point at `dist/`. `dist/` is not committed to Git; the `prepare` script builds it when the package is installed as a Git dependency, and the npm package ships the built `dist/`. Under webpack 4, the Babel configuration in `./webpack4` transpiles `dist/` as before.

The core keeps the strictness it was written with: `strict`, plus `noUnusedLocals`, `noUnusedParameters`, `noImplicitOverride`, `noImplicitReturns`, `noFallthroughCasesInSwitch` and `verbatimModuleSyntax`. It does not yet enable `noUncheckedIndexedAccess` or `exactOptionalPropertyTypes`, which some sibling packages do.

## Verification

```sh
npm ci --ignore-scripts
npm run check
```

`npm run check` typechecks `src` and `test`, runs the tests, and packs the tarball as a dry run. `npm test` builds `dist/` and then verifies the public API through the package name, so that `exports` resolution is exercised. The tests run as TypeScript on the Node.js type-stripping runtime; where a case exists to prove that a bad value is refused, it casts that value in deliberately rather than weakening the public types. They use the built-in test runner and Web Crypto of Node.js >=26 to verify the Loader headlessly with no runtime dependency. ZIP codec fixture verification uses the dev dependency `@turbowarp/jszip`. `test/fixtures/extension.js` is a fixture of the bytes handed to the host and is never evaluated during the tests. The `./scratch-vm` tests in `test/scratch-vm/` drive the real scratch-vm, pinned as a dev dependency at the revision the TurboWarp Plus Editor's scratch-gui uses: registration, rollback and unload on its real tables and dispatch, and SB3 save and reopen through its serializer. They are typechecked without strict mode (`test/scratch-vm/tsconfig.json`), because they build untyped VM stand-ins; the adapters themselves are strict.

The browser suite uses the minimal Editor runtime and a local HTTPS fixture. It checks that the Loader runs approved code on the real VM, refuses responses without CORS permission and redirects before authorization, and respects CSP when dynamic evaluation is blocked. The fixture requires OpenSSL. After `npm run check`, run:

```sh
npx --no-install playwright install --only-shell chromium
npm run test:browser
```

## Rollout and rollback

Wire the Loader inside a host feature flag that is fixed at startup and off by default. With the flag off, no Loader port is called and the host falls back to its previous project loading path. Do not enable it on a host that cannot preserve an unknown Manifest, and verify an SB3 save → reload fixture before release.

## SB3 codec

`./project-codec` provides `createProjectIO({zip: JSZip, ...limits})` and `inspectZip(bytes, limits)`. The GUI does not interpret the Manifest; it wires `prepare` → `activate(context)` together with `restoreJSON` / `restoreFiles` / `restoreArchive`. Pass the same `embeddedReader` instance to the Loader ports.

`prepare` accepts a JSON object, a string, UTF-8 bytes, an ArrayBuffer, a Blob and an SB3 ZIP, and returns `{manifest, input, context}`. When a Manifest is present, the core validates it and strips `extensionURLs` for Plus IDs in legacy input to prevent automatic URL execution. The IDs themselves remain for the GUI's registration hook. On save it restores the Manifest, the original Plus URL metadata, embedded bytes, unknown ZIP entries and unknown top-level metadata. `restoreArchive` assumes the GUI's `toJSON` hook has already restored `project.json`.

With `prepare(input, {shareArchive: true})`, a compatible SB3 also returns `originalArchive` and `vmArchive`. Treat each view's `project` as read-only for that load and call `openZip()` for an independent archive. The VM view includes `parserText` when the caller needs the original parser's compatibility handling. Use the existing input path if the views are absent. Large DEFLATE entries can use the browser's native decompressor, with the same size and CRC checks.

`assignProjectURI(context, uri, {replace})` returns a new context whose Manifest carries `uri`, for
the restore calls that follow. It is how a project whose Manifest has no address gets one when it is
first saved: the host keeps the context it returns, so every later save carries the same address.
The address follows the same rule as the `uri` option of `prepare*` (`INVALID_PROJECT_URI` unless
HTTPS without credentials or fragment) and is recorded normalized. **An address the project already
has is never replaced unless `replace: true` says so**: a different one is refused with
`PROJECT_URI_CONFLICT`, and the same one returns the context unchanged. The context passed in stays
valid and unchanged, and a `null` context (no Manifest) is refused, since there is nothing to carry
the address.

```js
let saved = prepared.context;
// at save time, only when prepared.manifest has no uri:
if (saved && !prepared.manifest.uri) saved = io.assignProjectURI(saved, defaultProjectURI(location.origin, createProjectUUID()));
io.restoreJSON(json, saved);
```

Unsupported formats are ZIP64, multidisk, encryption, compression other than STORE/DEFLATE, non-ASCII entry names that are not UTF-8, and the Unicode path extra field. The default limits are 64 MiB for the archive and for total expansion, 16 MiB per entry, 32 MiB for `project.json`, 4096 entries, and a compression ratio of 1000. The limits are configurable through the host's startup settings. A ZIP without a Manifest goes through the same safety checks, and the original input is returned unchanged once it passes. As a result, an unsupported ZIP that the previous VM accepted is rejected while the flag is on. With the flag off, the codec is not called at all.

## Additional host-facing API

- `isAuthorizedCode(value)` identifies only an authorization trail issued by the core and currently being registered. Copies and forgeries from project data are rejected, and the trail expires when the transaction ends.
- `createSessionTrustProvider` in `./session-trust` keeps approval bound to id, digest, source, version, publisher, capabilities and dependencies. It applies the explicit external host URL / execution policy before the UI every time, and rejects an Embedded request it cannot decide.
- `createMemoryContentCache` in `./memory-cache` provides copying, capacity (32 MiB by default, two extensions of the largest default size), TTL and LRU, and the core re-verifies the content even on a hit.
- `withFetchRetry(port, options)` wraps any fetch port in the bounded retry described above, `isTransientFetchFailure(error)` is the classifier it applies, `isWorthAskingAgain(error)` tells a host holding a failed operation whether to offer trying again, and `DEFAULT_FETCH_RETRY` holds the defaults (2 retries, 400 ms of backoff doubling to a 2 s cap, a 5 s budget).
- `./webpack4` is a configuration helper for building the same core with webpack 4 for the GUI and Packager.
- `./scratch-vm` puts the Loader on a scratch-vm. It drives the VM's internals on purpose, so whoever bundles the VM installs it and passes the VM's own module instances in:
  - `createVMExtensionRegistrar(vm, {vmModules})` is the registration port. `vmModules` are the VM's own `ScratchCommon`, `createTranslate`, `staticFetch` and central `dispatch`: a copy resolved from elsewhere would not be the VM's singleton.
  - `installExtensionLoader(host, loader)` puts the Loader in front of the VM's project loading and saving, so a project's Manifest is verified before the VM loads its extensions and kept across saves. `editProjectURI(vm)` edits the open project's address.
  - `createExtensionAuthoringController(vm, {zip, ports, ...})` adds, configures and removes a project's extensions, serialized against the VM, and restores the original project when a change fails. `setExtensionAuthoringHost` and `getExtensionAuthoringHost` hand it to the screens that use it.
  - `createProjectAddresser(origin)` names a new project's default address under an HTTPS origin, and `withProjectSerialization` marks a serialization as a preview, which is never given an address.
  - `./scratch-vm/runtime` has only what a host that plays projects needs (the registrar, `installExtensionLoader`, `editProjectURI` and the serialization mark), so a built single HTML does not bundle authoring or addressing.

Compatibility with the real GUI, with the HTML generated by the real Packager 3.14.0, and with Desktop 1.17.0 is covered by E2E tests on the Editor side. Do not install the Loader into standard Desktop or standard Web without permission. Saving in standard Desktop has been measured to discard the non-standard Manifest and ZIP entries, so save in an editor that preserves them.

## Adding an extension from a JS file or URL

`prepareExtensionAddition` in `./project-authoring` was written for the dedicated custom-extension UI of [Editor Issue #11](https://github.com/kubohiroya/turbowarp-plus-editor/issues/11). TurboWarp-Plus-Editor dropped that screen on 2026-11-01 and made the TurboWarp Plus catalog list (`./project-catalog`, below) the only entry point for extensions, so the Editor no longer calls this API. The UI only passes an ID and either a file or a URL; Manifest editing, URL policy and SHA-256 computation are handled by this core.

```js
import JSZip from '@turbowarp/jszip';
import {prepareExtensionAddition} from '@kubohiroya/turbowarp-extension-loader/project-authoring';

const candidate = await prepareExtensionAddition(currentSB3, {
    id: 'myextension',
    source: {type: 'embedded'},
    bytes: selectedFile
}, {fetcher, trustProvider, cache, diagnostics}, {zip: JSZip, signal});
// For a Remote extension, use {id, source: {type: 'remote', url: httpsURL}}.
// Apply candidate.projectBytes only after the host checks that the project is still current.
```

- A JS file is added as Embedded and an HTTPS URL as Remote. The default Embedded path is `extensions/<id>.js`. Remote is actually fetched from the URL, and bytes substituted by the caller are rejected.
- Enter the ID to match the extension author's `getInfo().id`. The JS is not evaluated during import in order to extract the ID. The registrar checks the final ID match at run time.
- Empty, oversized and non-UTF-8 JS, reserved IDs, existing IDs and overwriting an existing ZIP entry are rejected. HTTPS, final URL and redirect validation is the same as in the existing Loader.
- The SHA-256 is computed automatically from the exact bytes fetched. For Remote, that fetch result is used as a snapshot for candidate verification. Because the pinned hash is also checked when the project is re-fetched after saving, a server-side substitution is never trusted automatically.
- Every extension of the candidate project is verified with the existing Loader and explicit host approval is confirmed before `{projectBytes, spec, manifest}` is returned. This API does not execute JS and does not modify the original project, the input bytes or the real VM. Sharing the approved session `trustProvider` when applying the result to the real VM avoids asking again for the same content and source.
- Standard extensions, ordinary custom URLs, an existing Plus Manifest, embedded code, ZIP entries such as images, unknown metadata and distribution locks are all preserved. The generated candidate is re-checked against the same ZIP limits as a normal load.
- Applying the result to the VM is owned by the host. Implement project switching, cancellation and registration failure handling together with restoring the original project, and do not apply a stale result after the UI is closed or to a different project.
- The returned SB3 can be passed directly to a normal save and to `prepareOfflinePackage`. Remote bundling, declaring external dependencies and the recipient's approval boundary reuse the existing Packager API. The startup flag remains off by default.

## Bulk configuration from a catalog

`prepareCatalogExtensionChanges(currentSB3, requests, ports, options)` in `./project-catalog` applies a catalog selection to an SB3 candidate in one pass. A request is `{id, url, distribution: 'remote-non-cacheable' | 'remote-cacheable' | 'embedded-file' | 'embedded-data', execution: 'sandboxed' | 'unsandboxed', dependencies?, version?}`. JS fetching, SHA-256 computation, dependency ordering, verification of every entry and host approval all go through the shared Loader, and `{projectBytes, manifest}` is returned once every entry is approved. The real VM is untouched.

When changing the distribution method or execution mode of an existing Plus extension, the verified code, SHA-256, publisher, version and lock are preserved. If the Remote destination does not return the current code, it is rejected rather than silently adopted as an update. `readProjectAuthoringState(input, options)` returns the verified Manifest and can be used to restore UI state. This project information is not an execution permission.

A Manifest execution request may be either `sandboxed` or `unsandboxed`. The host must inject a registrar that honours the requested execution mode. The locally verified Editor and Packager integrations branch to a VM-owned isolated iframe or to approved host execution, and never promote sandboxed to unsandboxed. The authorization key includes the execution mode, and a request that does not match the external host policy is rejected. `prepareExtensionAddition` also accepts an arbitrary `execution`; only omitting it keeps the previous `unsandboxed` default.

Applying candidates across multiple packages, transferring ownership of a running extension, and restoring the original SB3 on registration failure are responsibilities of the GUI and VM. Migrating an existing legacy extension is supported only where the VM provides an ownership boundary for temporary detach, commit and rollback. Keep the original SB3 for recovery even where the original service cannot be restored after disposal.

## Distribution scope

The Loader core, its types and its documentation are provided from this GitHub repository and from the npm package `@kubohiroya/turbowarp-extension-loader`. Hosts should depend on an exact pinned version. While the package is on 0.x, a minor release may change the contract. The Editor, GUI, VM and Packager integrations are maintained in separate repositories, and publishing this core neither updates nor ships them. Rollout requires host-side compatibility verification and a flag that is fixed at startup and off by default.

Pushing a `v<version>` tag runs `release.yml`, which verifies, packs, attaches the archive to the GitHub Release, publishes to npm through a trusted publisher with provenance, and points `latest` and `next` at that release. The first version is the exception: npm cannot be given a trusted publisher for a package that does not exist yet, so that one is published by hand and the trusted publisher for `release.yml` is configured on npmjs.com afterwards.

Publishing to npm is only a way to deliver verified code to a host. Obtaining the package never authorizes extension code to execute; that decision is made by the host's `trustProvider` every time.

## License

[MPL-2.0](LICENSE)
