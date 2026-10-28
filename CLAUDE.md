# Claude Projects

VS Code extension, published on the Marketplace as `Sir-Olexander.claude-projects`.

## Before every PR: bump the version

Every time you open a pull request, raise `"version"` first (in `package.json` and the top two `"version"` fields of `package-lock.json`) and commit it on the PR branch, right before creating the PR. The Marketplace rejects a version it already has.

Pick the bump yourself from what the PR changes, and say which one you picked and why in the PR description:

- **x.0.0 (major)**: breaking or sweeping changes: removed/renamed commands or settings, changed saved-data formats, a redesign users must relearn.
- **0.x.0 (minor)**: new user-visible features or behavior: new commands, settings, UI sections, notable workflow changes. Reset patch to 0.
- **0.0.x (patch)**: bug fixes, small tweaks, copy/styling polish, refactors, docs, internal changes.

When in doubt between two levels, pick the smaller one.

## Releasing

1. Make sure the version was bumped (see above).
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
