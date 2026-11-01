# Changelog

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
