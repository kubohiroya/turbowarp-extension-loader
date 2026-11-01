# Changelog

## Unreleased

## 0.2.0

A third source form for extensions whose bytes should be reachable both from a canonical published
location and offline.

- `source` accepts `{type: 'cached', url, path}` beside `embedded` and `remote`. It names both
  locations at once: `url` stays canonical and a verified copy is retained at `path` inside the
  project. Resolution reads the retained copy first and falls back to the URL, reporting a
  `retained-copy-unavailable` diagnostic when the entry is absent. The copy is not a weaker source —
  the Manifest pins the SHA-256, so it either is exactly the pinned code or the load fails with
  `DIGEST_MISMATCH`, which is why it may be read before the network. `url` follows the same HTTPS,
  redirect and final-URL policy as `remote`, `path` the same `extensions/*.js` policy as `embedded`,
  and the cache port still takes precedence over both locations.
- `./project-catalog` accepts `distribution: 'cached'`, and `./project-codec` and `./packager`
  require and write the retained entry for a cached source as they do for an embedded one.
- This keeps `schemaVersion: 1`. A Manifest that does not use `cached` stays loadable by 0.1.0; one
  that does needs 0.2.0 or newer, and older versions reject it with `INVALID_SOURCE` rather than
  loading it in a weaker form.

The rest of this release was already on `main` but not in 0.1.0: the `v0.1.0` tag was cut before
these merged, and a published npm version cannot be replaced, so the archive on npm still carries
the Japanese `README.md` and these reach the registry here.

- `README.md` is the English document and the Japanese one is `README.ja.md`, each linking to the
  other. Both state that hosts should pin an exact version, that a 0.x minor may change the
  contract, and that obtaining the package never authorizes extension code to execute — the host's
  `trustProvider` decides that every time.
- `files` also carries `README.ja.md` and `CHANGELOG.md`, and the package declares `keywords`,
  `author` and `publishConfig.registry`.
- The TypeScript layout now matches the other `@kubohiroya/turbowarp-*` packages: the tests are
  TypeScript too (`test/*.test.ts`, run on the Node.js type-stripping runtime), `tsconfig.json`
  typechecks without emitting while `tsconfig.build.json` emits, `test/tsconfig.json` covers the
  tests, and `npm run check` runs typecheck, tests and a pack dry run — which is what CI runs.
  `npm run build` is `tsc -p tsconfig.build.json`, and `@types/node` is a dev dependency.
- The core keeps the strictness it was written with. `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes`, which some sibling packages enable, would need non-null assertions
  and option-spread rewrites inside verified loading paths, so they stay off.

## 0.1.0

First npm release of the GUI-independent extension loading core, published under MPL-2.0. The
package was previously `private: true` and `UNLICENSED`, consumable only as a pinned Git
dependency.

- Verified project extension loading: schema v1 Manifest validation in the `turboWarpPlus` field of
  `project.json`, Embedded / Remote resolution with a mandatory pinned SHA-256, UTF-8 validation,
  per-code and total size limits, dependency ordering, and transactional registration that rolls
  back on an ID mismatch or a registration failure.
- `./project-codec`: SB3 ZIP inspection and round-tripping that preserves the Manifest, the original
  Plus URL metadata, embedded bytes and unknown ZIP entries.
- `./project-authoring` and `./project-catalog`: adding one extension from a JS file or an HTTPS URL,
  and applying a catalog selection to an SB3 candidate in one pass, without executing any JS.
- `./packager`: Embedded / Remote conversion, Data URL migration with explicit approval, and offline
  SB3 preparation.
- `./session-trust`, `./memory-cache` and `./indexeddb-cache`: host ports for session approval bound
  to content and source, an in-memory content cache, and a cache-first persistent browser cache that
  stores gzip-compressed bytes with bounded decompression and LRU eviction.
- `./webpack4`: configuration helper for building the same core under webpack 4.
- The core is TypeScript; `npm run build` emits ES2022 ESM and `dist/*.d.ts` declarations.
- `release.yml` is the family's tag-triggered release: a pushed `v<version>` tag verifies, packs,
  attaches the archive to the GitHub Release, publishes through a trusted publisher with
  provenance, and points `latest` and `next` at the release. This first version is published by
  hand, because npm cannot be given a trusted publisher for a package that does not exist yet.
