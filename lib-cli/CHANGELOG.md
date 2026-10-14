# lib-cli changelog

The top `## X.Y.Z` heading is lib-cli's version. `node scripts/sync-lib.mjs` stamps it into every `.framework.json`, so a vendored copy records which lib-cli it came from. Bump it in the same commit as any change to a lib-cli file: patch for a fix, minor for a new export or file, major when an export changes or goes.

## 1.1.0 (2026-10-06)

- `configuredRoot` reads the optional persisted projects store root, allowing existing desktop processes to use a newly configured portfolio without a restart. Environment overrides still win.

## 1.0.0 (2026-09-30)

- First release, five files: `root.mjs`, `args.mjs`, `store.mjs`, `git.mjs` and `exit.mjs` (#127).
- Vendored by gtg, logical-projects, logical-learning, runbooks and jevtools.
