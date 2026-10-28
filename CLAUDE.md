# Claude Projects

VS Code extension, published on the Marketplace as `Sir-Olexander.claude-projects`.

## Releasing

1. Raise `"version"` in `package.json` (e.g. `0.1.0` → `0.1.1`). The Marketplace rejects a version it already has.
2. `npm run package` → builds `dist-vsix/claude-projects.vsix`.
3. On https://marketplace.visualstudio.com/manage, use **⋯ → Update** on the extension and upload that file (not the "new extension" upload).
