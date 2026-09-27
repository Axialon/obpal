# Release reference

## 1. Versions
- **Link:** `extension/package.json` `version`. The manifest takes it from there (extension/vite.config.ts).
- **Desktop:** `desktop/Cargo.toml` `version`. The next `cargo build` updates Cargo.lock.
- Bump only what changed. A Link release can carry the current Desktop zip.

## 2. Packages (from master, after the version commit)
| what | command | output |
|---|---|---|
| Link | `pnpm run pack:extension` | `extension/release/obpal-link-<v>.zip` and `obpal-link.zip` (same bytes) |
| Store | `pnpm run store:extension -- --with-key` | `extension/release/obpal-link-<v>-store.zip` (manifest without `key`), plus the first-upload zip in `~/.obpal-keys/store/` |
| Desktop | in `desktop/`: `cargo test`, `cargo build --release`, then `node desktop/pack.mjs` | `desktop/release/obpal-desktop-windows-x64.zip` |

- **Store:** the first-upload zip is written only when the key's ID matches the manifest and the ID ob.Pal Desktop allows. The script checks every zip it writes. The owner's upload steps are in `extension/store/UPLOAD.md`.
- **Desktop:** never run `cargo test` with `--ignored` or `--include-ignored` (those drive the real mouse and keyboard). Check the version from the file, never by running it: `(Get-Item desktop/target/release/obpal-desktop.exe).VersionInfo.ProductVersion`.
- Then run `pnpm run e2e:all -- extension` on this build. The guard must say "no new sessions".

## 3. The public repo, github.com/Axialon/obpal-link
Clone it outside this repo, for example into the session scratchpad: `gh repo clone Axialon/obpal-link <dir>`.
- `extension/`: the build, so replace its contents with `extension/dist`.
- `README.md`: what's new, plus the install and update steps.
- `desktop/README.md`: when Desktop changed.

Commit with the public identity, explicitly:
`git -C <dir> -c user.name=Axialon -c user.email=axialon@users.noreply.github.com commit -m "ob.Pal Link <v>: <one line>"`
Then run `git -C <dir> push`.

## 4. The GitHub release
Write the notes to a file in the scratchpad: plain words, what changed for the user, and what to do to update. Then:
```
gh release create v<v> -R Axialon/obpal-link --title "ob.Pal Link <v>" --notes-file <notes.md> \
  extension/release/obpal-link.zip extension/release/obpal-link-<v>.zip desktop/release/obpal-desktop-windows-x64.zip
```
Check it:
- `gh api repos/Axialon/obpal-link/releases/latest --jq '.tag_name + " " + ([.assets[].name]|join(","))'` shows the new tag as latest with three assets (`gh release view --json` has no `isLatest` field).
- Download `https://github.com/Axialon/obpal-link/releases/latest/download/obpal-link.zip` and compare its SHA-256 (`Get-FileHash` / `sha256sum`) with the local `obpal-link.zip`.

## 5. The site
`/link/` downloads through `releases/latest`, so the links don't change. If the page names the version or new features, update it and deploy (the deploy-and-verify skill).

## 6. The open-source snapshot, github.com/Axialon/obpal
1. `node scripts/open-source.mjs` exports the tracked files and scans them. Fix anything it lists and commit.
2. `node scripts/open-source.mjs --publish` commits one snapshot with the Axialon identity and pushes it.

Local-only files never go out:
- `.claude/settings.local.json`, `.claude/local/`, `local-*` skills and agents, and `CLAUDE.local.md` are gitignored, and the export skips them too.
- The private words the scan looks for are in the gitignored `.open-source-deny`.
