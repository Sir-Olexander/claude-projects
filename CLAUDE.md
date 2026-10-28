# Claude Projects

VS Code extension, published on the Marketplace as `Sir-Olexander.claude-projects`.

## Releasing

1. Raise `"version"` in `package.json` (e.g. `0.1.0` → `0.1.1`). The Marketplace rejects a version it already has.
2. `npm run package` → builds `dist-vsix/claude-projects.vsix`.
3. On https://marketplace.visualstudio.com/manage, use **⋯ → Update** on the extension and upload that file (not the "new extension" upload).

## After every change

Once a change is done (built and tests pass), rebuild and install it into the local VS Code, without reloading the window (the user reloads when ready):

```sh
node scripts/build.mjs --production && npx vsce package --no-dependencies --allow-missing-repository \
  --baseImagesUrl https://raw.githubusercontent.com/Sir-Olexander/claude-projects/main/ \
  --baseContentUrl https://github.com/Sir-Olexander/claude-projects/blob/main/ \
  -o dist-vsix/claude-projects.vsix
"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" --install-extension dist-vsix/claude-projects.vsix --force
```
