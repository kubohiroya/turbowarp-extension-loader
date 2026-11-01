# turbowarp-extension-loader

English | [日本語](README.ja.md)

The GUI-independent core of [Editor Issue #4](https://github.com/kubohiroya/turbowarp-plus-editor/issues/4). It lives in its own Git repository and is published to npm as `@kubohiroya/turbowarp-extension-loader` under MPL-2.0. It does not replace any existing distribution library or npm package.

```sh
npm install @kubohiroya/turbowarp-extension-loader
```

## Scope

- A schema v1 Manifest lives in `turboWarpPlus`, a non-standard field of `project.json`. This is not part of the standard SB3 specification.
- Strict Manifest validation: unknown fields rejected, duplicate and standard extension IDs rejected, dependency ordering enforced, cyclic and missing dependencies rejected.
- Per-extension Embedded / Remote / Cached resolution, a mandatory pinned SHA-256, UTF-8 validation, and per-code and total size limits.
- A SHA-256-keyed cache port. Every read re-verifies the exact bytes, and a cache hit still requires host authorization.
- Registration starts only after explicit host authorization and only once every extension has been verified and authorized. A registration ID mismatch or a registration failure requires the host transaction to roll back.
- Cancellation, fetch and authorization timeouts, duplicate load rejection, unload, and diagnostic events.

Standard extensions, generic custom URLs and legacy Data URLs are not reinterpreted. For a project without a Manifest, no host port is called. `execution: "unsandboxed"` inside a project is a request, not a permission. Unknown fields such as `trusted` are rejected.

### Source forms

A `source` names where one extension's bytes live, and takes one of three forms. Added in 0.2.0, `cached` names both locations at once, so a project keeps working offline without giving up a canonical published location.

| Form | Shape | Resolution order |
| --- | --- | --- |
| `embedded` | `{type: 'embedded', path}` | the archive entry at `path` |
| `remote` | `{type: 'remote', url}` | an HTTPS fetch of `url` |
| `cached` | `{type: 'cached', url, path}` | the retained copy at `path`, then an HTTPS fetch of `url` |

A retained copy is not a weaker source: the Manifest pins the SHA-256, so the copy either is exactly the pinned code or the load fails with `DIGEST_MISMATCH`. That is why it may be read before the network. When the entry is absent the loader reports a `retained-copy-unavailable` diagnostic and falls back to the URL, which must still serve the pinned bytes under the same redirect and final-URL policy as `remote`. `path` follows the same `extensions/*.js` policy as `embedded`, and the cache port still takes precedence over both locations.

`cached` keeps `schemaVersion: 1`, so a Manifest that does not use it stays loadable by 0.1.0. A Manifest that does use it needs 0.2.0 or newer; older versions reject it with `INVALID_SOURCE` rather than loading it in a weaker form.

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

The real VM adapter is owned by `scratch-gui/src/lib/tw-plus-extension-registrar.js`. Combined with `getExtensionServicePort()`, which is added to the VM, it tracks ownership of the registration table and dispatch service of the same VM so that rollback and unload work. The Packager, a separate bundle from the Editor, uses the same service inside the VM. Within one bundle using a standard VM it confirms dispatch identity; in an unsupported separate bundle it refuses. The Loader core itself does not depend on any VM private API.

## Security boundary and constraints

- The core does not evaluate JS. Evaluation privileges and VM internal APIs stay with the host.
- Rollback is a guarantee about the host's extension registration state. It cannot undo DOM, network or other side effects of privileged JS that has already been evaluated. Approving that the code is safe remains a separate decision.
- The initial version rejects HTTP for Remote, URLs carrying credentials, fragments and redirects. A successful HTTPS fetch alone does not authorize anything.
- `createFetchPort()` disables redirects, sends no credentials, sends no referrer, and enforces the real size limit on the stream. A fetch refused by CORS / CSP / offline conditions is preserved in the `cause` of `LOAD_FAILED`. Detailed classification of network-layer failures is left to `cause`; CORS and CSP are verified by real-browser E2E tests on the Editor side.
- An injected fetch port must return `finalURL` and an explicitly empty `redirects`. The port itself is a boundary implemented by the trusted host.
- Fetching and authorization time out even against a port that never responds. Registration waits for completion before rolling back, even after cancellation. To avoid a race between a late-completing registration and a rollback, a registration port that does not respond to `AbortSignal` cannot guarantee that an in-flight registration finishes in bounded time.
- Cache capacity, invalidation, persistence and provenance logging belong to the host's port. A corrupted cache is never silently ignored in favour of switching to Remote.
- `./packager` provides Embedded / Remote conversion, Data URL migration with explicit approval, lock and license metadata preservation, and offline SB3 preparation. An extension with external dependent resources is rejected rather than guessed into a bundle. Signature and publisher key pinning can be added by the host; the initial implementation is session approval bound to content and source.
- The ZIP implementation is injected through `createProjectIO({zip: JSZip})`. The core codec inspects the ZIP central directory directly and validates duplicates, paths and declared capacity before checking the real expanded size and CRC32 of the stream. An externally implemented archive port needs equivalent validation.

The defaults are at most 64 extensions, 16 MiB per extension, 64 MiB in total, and 30 seconds for fetching and authorization. The per-extension and total defaults equal the project codec's per-entry and expansion limits, so any extension file a project can carry is also one the Loader reads; a host can lower them through its loader options. There is no development-mode exception for Data URLs or HTTP. Because standard TurboWarp and unsupported editors may discard the non-standard Manifest and ZIP entries, re-saving in a host without preservation support is not a migration path.

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

## Source and build

The source and the tests are TypeScript, in `src/*.ts` and `test/*.test.ts`, laid out the same way as the other `@kubohiroya/turbowarp-*` packages: `tsconfig.json` typechecks without emitting, `tsconfig.build.json` extends it to emit, and `test/tsconfig.json` extends it for the tests. `npm run build` (`tsc -p tsconfig.build.json`) emits ES2022 ESM and type declarations to `dist/`, and `exports`, `main`/`module` and the root files used by webpack 4 (`packager.js` and the rest) all point at `dist/`. `dist/` is not committed to Git; the `prepare` script builds it when the package is installed as a Git dependency, and the npm package ships the built `dist/`. Under webpack 4, the Babel configuration in `./webpack4` transpiles `dist/` as before.

The core keeps the strictness it was written with: `strict`, plus `noUnusedLocals`, `noUnusedParameters`, `noImplicitOverride`, `noImplicitReturns`, `noFallthroughCasesInSwitch` and `verbatimModuleSyntax`. It does not yet enable `noUncheckedIndexedAccess` or `exactOptionalPropertyTypes`, which some sibling packages do.

## Verification

```sh
npm ci --ignore-scripts
npm run check
```

`npm run check` typechecks `src` and `test`, runs the tests, and packs the tarball as a dry run. `npm test` builds `dist/` and then verifies the public API through the package name, so that `exports` resolution is exercised. The tests run as TypeScript on the Node.js type-stripping runtime; where a case exists to prove that a bad value is refused, it casts that value in deliberately rather than weakening the public types. They use the built-in test runner and Web Crypto of Node.js >=26 to verify the Loader headlessly with no runtime dependency. ZIP codec fixture verification uses the dev dependency `@turbowarp/jszip`. `test/fixtures/extension.js` is a fixture of the bytes handed to the host and is never evaluated during the tests. This is distinct from verifying real networking, CORS / CSP, VM private APIs, or browser extension execution.

## Rollout and rollback

Wire the Loader inside a host feature flag that is fixed at startup and off by default. With the flag off, no Loader port is called and the host falls back to its previous project loading path. Do not enable it on a host that cannot preserve an unknown Manifest, and verify an SB3 save → reload fixture before release.

## SB3 codec

`./project-codec` provides `createProjectIO({zip: JSZip, ...limits})` and `inspectZip(bytes, limits)`. The GUI does not interpret the Manifest; it wires `prepare` → `activate(context)` together with `restoreJSON` / `restoreFiles` / `restoreArchive`. Pass the same `embeddedReader` instance to the Loader ports.

`prepare` accepts a JSON object, a string, UTF-8 bytes, an ArrayBuffer, a Blob and an SB3 ZIP, and returns `{manifest, input, context}`. When a Manifest is present, the core validates it and strips `extensionURLs` for Plus IDs in legacy input to prevent automatic URL execution. The IDs themselves remain for the GUI's registration hook. On save it restores the Manifest, the original Plus URL metadata, embedded bytes, unknown ZIP entries and unknown top-level metadata. `restoreArchive` assumes the GUI's `toJSON` hook has already restored `project.json`.

Unsupported formats are ZIP64, multidisk, encryption, compression other than STORE/DEFLATE, non-ASCII entry names that are not UTF-8, and the Unicode path extra field. The default limits are 64 MiB for the archive and for total expansion, 16 MiB per entry, 32 MiB for `project.json`, 4096 entries, and a compression ratio of 1000. The limits are configurable through the host's startup settings. A ZIP without a Manifest goes through the same safety checks, and the original input is returned unchanged once it passes. As a result, an unsupported ZIP that the previous VM accepted is rejected while the flag is on. With the flag off, the codec is not called at all.

## Additional host-facing API

- `isAuthorizedCode(value)` identifies only an authorization trail issued by the core and currently being registered. Copies and forgeries from project data are rejected, and the trail expires when the transaction ends.
- `createSessionTrustProvider` in `./session-trust` keeps approval bound to id, digest, source, version, publisher, capabilities and dependencies. It applies the explicit external host URL / execution policy before the UI every time, and rejects an Embedded request it cannot decide.
- `createMemoryContentCache` in `./memory-cache` provides copying, capacity (32 MiB by default, two extensions of the largest default size), TTL and LRU, and the core re-verifies the content even on a hit.
- `./webpack4` is a configuration helper for building the same core with webpack 4 for the GUI and Packager.

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

`prepareCatalogExtensionChanges(currentSB3, requests, ports, options)` in `./project-catalog` applies a catalog selection to an SB3 candidate in one pass. A request is `{id, url, distribution: 'embedded' | 'remote' | 'cached', execution: 'sandboxed' | 'unsandboxed', dependencies?, version?}`. JS fetching, SHA-256 computation, dependency ordering, verification of every entry and host approval all go through the shared Loader, and `{projectBytes, manifest}` is returned once every entry is approved. The real VM is untouched.

When changing the distribution method or execution mode of an existing Plus extension, the verified code, SHA-256, publisher, version and lock are preserved. If the Remote destination does not return the current code, it is rejected rather than silently adopted as an update. `readProjectAuthoringState(input, options)` returns the verified Manifest and can be used to restore UI state. This project information is not an execution permission.

A Manifest execution request may be either `sandboxed` or `unsandboxed`. The host must inject a registrar that honours the requested execution mode. The locally verified Editor and Packager integrations branch to a VM-owned isolated iframe or to approved host execution, and never promote sandboxed to unsandboxed. The authorization key includes the execution mode, and a request that does not match the external host policy is rejected. `prepareExtensionAddition` also accepts an arbitrary `execution`; only omitting it keeps the previous `unsandboxed` default.

Applying candidates across multiple packages, transferring ownership of a running extension, and restoring the original SB3 on registration failure are responsibilities of the GUI and VM. Migrating an existing legacy extension is supported only where the VM provides an ownership boundary for temporary detach, commit and rollback. Keep the original SB3 for recovery even where the original service cannot be restored after disposal.

## Distribution scope

The Loader core, its types and its documentation are provided from this GitHub repository and from the npm package `@kubohiroya/turbowarp-extension-loader`. Hosts should depend on an exact pinned version. While the package is on 0.x, a minor release may change the contract. The Editor, GUI, VM and Packager integrations are maintained in separate repositories, and publishing this core neither updates nor ships them. Rollout requires host-side compatibility verification and a flag that is fixed at startup and off by default.

Pushing a `v<version>` tag runs `release.yml`, which verifies, packs, attaches the archive to the GitHub Release, publishes to npm through a trusted publisher with provenance, and points `latest` and `next` at that release. The first version is the exception: npm cannot be given a trusted publisher for a package that does not exist yet, so that one is published by hand and the trusted publisher for `release.yml` is configured on npmjs.com afterwards.

Publishing to npm is only a way to deliver verified code to a host. Obtaining the package never authorizes extension code to execute; that decision is made by the host's `trustProvider` every time.

## License

[MPL-2.0](LICENSE)
