# TypeScript migration

`ts-src/` is the canonical implementation; root and `src/` JS files are compatibility output built with `npm run build`.

Existing `.d.ts` exports remain for downstream consumers. The first migration phase uses TypeScript transpilation (`noCheck: true`); full type checking, typed implementation APIs and declaration generation are not yet finished. Do not mistake this initial migration for strict type safety.

`npm test` builds before running existing Node tests. Follow-up: remove `noCheck`, enable strict checks and align declaration generation, then validate editor/Packager consumers.
