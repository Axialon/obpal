# ob.Pal Desktop

The native helper behind the **PC** target of the ob.Pal Link browser extension: your phone's controller becomes keyboard and mouse input for the programs you allow, one program at a time, with the scope you choose. Windows first (x86_64), built so macOS and Linux injectors can be added.

```
phone ──WebRTC──▶ ob.Pal Link (extension) ──Chrome Native Messaging (stdio)──▶ obpal-desktop.exe ──SendInput──▶ the program in front
```

There is no other way in. The helper has **no network listener, no socket, no file it watches**: Chrome starts it, hands it two pipes, and the only peer on them is the extension named in its manifest.

## Build

```sh
cd desktop
cargo build --release          # target/release/obpal-desktop.exe (and obpal-harness.exe, see Tests)
cargo test                     # codec, key table, allowlist/scope, the session state machine, registration
cargo test -- --include-ignored  # also the Windows injection test (it creates a window and takes the foreground)
```

Rust 1.85 or later. The only Windows dependency is the `windows` crate (no C toolchain, no cgo).

## Install (per user, no admin)

```sh
obpal-desktop.exe install      # writes net.blackboxes.obpal.json next to the exe and registers it for
                               # Chrome, Chromium, Edge, Brave and Vivaldi under HKCU (this user only)
obpal-desktop.exe status       # where it is registered, and whether the keys point at this exe
obpal-desktop.exe uninstall    # removes exactly those registry keys and the manifest
```

Keep the exe where you installed it from: the manifest points at that path. Moving it means `install` again.

`install --origin chrome-extension://<id>/` adds another extension ID to `allowed_origins`, for a copy of ob.Pal Link with a different ID (a Chrome Web Store build, or a fork with its own key). The built-in ID is ob.Pal Link's stable one, fixed by the public key in `extension/vite.config.ts`.

Then, in ob.Pal Link:
1. Click the **PC** chip. The browser asks once for the *nativeMessaging* permission.
2. Switch to the program you want to control, then come back to the popup: it names that program. Click **Allow**, with keys and/or mouse.
3. Switch back to the program. The phone now drives it. The popup shows *Controlling &lt;program&gt; · keyboard + mouse*.

The extension's options page lists every allowed program with its scope, removes them, and has **Pause all**.

## Security model

Remote-input tools have a history of remote code execution (PLAN.md §9). The helper is built so that the worst a hostile phone, network or page can do is press keys you already allowed, in a program you already allowed, while it is in front.

**Reachability**
- Reached only through Chrome Native Messaging: Chrome launches the helper and owns both pipes. The host manifest lists one `allowed_origins` entry, ob.Pal Link's extension ID; Chrome refuses other extensions, and the helper checks the origin Chrome passes on its command line as well.
- No network listener, no socket, no IPC endpoint, no auto-update.
- Runs as the user, unelevated. Registration is `HKCU` only.

**What can be injected**
- Only actions the *extension* mapped host-side from controller state: keys from an allowlisted table (`src/keys.rs`, named by `KeyboardEvent.code`), relative mouse motion, mouse buttons, the wheel. The phone never sends key names or sequences; it sends stick and button state, and the mapping (`extension/src/shared/keys.ts`) is fixed code.
- The key table leaves out the OS keys (Meta / Windows), the context-menu key, the lock keys, PrintScreen, Pause, Sleep and Power, and the media and browser keys.
- Frames carry the **whole desired held state**, never edges: the helper diffs against what it holds. A lost, dropped or refused frame cannot leave a key stuck; the next frame repairs it.
- Per-frame limits: at most 16 keys, 5 buttons, ±2000 px of motion, ±20 wheel notches; a frame with an unknown key is rejected as a whole. At most 250 frames/s, messages at most 64 KB.

**When it is injected**
- Nothing until the extension has sent `enable` (it does so only while the PC target is selected), and nothing while paused or after the panic key.
- Every frame is gated on the **foreground window's process** (`GetForegroundWindow` → PID → `QueryFullProcessImageNameW`, looked up every frame; only a new window costs a process query), so switching to another window stops input on the next frame: input goes only to a program on the allowlist, and only the kinds its scope allows (keyboard, mouse; a virtual gamepad needs a driver, so `gamepad` is reserved in the scope model and not offered).
- **The default is that nothing is allowed.** A program can be allowed only after the helper has seen it in the foreground in this session, so an `allow` can only name what a person just switched away from. The browser that launched the helper is never allowed (the extension's own page injection covers it).
- **Elevated windows:** the helper compares the front process's integrity level with its own. A higher level (an admin window) is refused up front and reported as *runs as administrator: can't be controlled*, because UIPI would otherwise drop the input silently.

**Letting go**
- Everything held is released when the foreground changes, on `enable off`, on pause, on panic, when a program's scope changes or it is forgotten, on stdin EOF (the browser or the extension went away), and after **500 ms without frames**.
- **Panic hotkey:** `Ctrl+Alt+Backspace`, registered system-wide while the helper runs. It releases everything and stops injection until *Resume* in the extension. If another program owns that combination, the extension shows that there is no panic key.

**Configuration**
- `%APPDATA%\obpal\desktop.json`: the allowlist and the pause flag. Written only by the helper, atomically, in response to validated messages from the extension. A damaged or hand-edited file with invalid entries is treated as empty. Nothing else is stored: no input, no titles.
- `%APPDATA%\obpal\desktop.log`: lifecycle lines (start, origin, hotkey, stop with counters). Never input.

## Protocol

Length-prefixed JSON on stdin/stdout (spec/PROTOCOL.md § Native messaging frames):

| Extension → helper | |
|---|---|
| `{"t":"hello","v":1}` | handshake |
| `{"t":"enable","on":true}` | arm / disarm (disarming releases everything) |
| `{"t":"f","k":["KeyW","ShiftLeft"],"b":[0],"m":[dx,dy],"w":[wx,wy]}` | an action frame: held keys, held buttons, motion, wheel (all optional) |
| `{"t":"release"}` | release everything |
| `{"t":"allow","path":…,"keyboard":true,"mouse":true}` | allow a program seen in front |
| `{"t":"scope",…}`, `{"t":"forget","path":…}`, `{"t":"pause","on":…}`, `{"t":"resume"}`, `{"t":"stats"}` | |

| Helper → extension | |
|---|---|
| `hello{v,version,os,hotkey,caps}` | |
| `config{paused,programs[]}` | after every change |
| `status{enabled,panic,held,front,program}` | on change: the window in front, and the last program that isn't the browser |
| `stats{frames,injected,refused{…}}` | on request |
| `error{code,msg}` | |

## Layout

| Path | Contents |
|---|---|
| `src/main.rs` | CLI (`install`, `uninstall`, `status`) and the serve loop: stdin reader thread, 50 ms poll, panic flag |
| `src/protocol.rs` | codec, requests, frame validation, replies |
| `src/keys.rs` | the key table |
| `src/scope.rs` | the allowlist and its file |
| `src/session.rs` | the state machine: gating, diffing, watchdog, rate limit, status reports; OS access behind `Injector` and `Foreground` traits |
| `src/win/` | Windows: `inject.rs` (SendInput), `foreground.rs` (front process, integrity level), `hotkey.rs`, `process.rs` (the parent browser), `install.rs` (manifest and registry), `inject_test.rs` |
| `src/bin/harness.rs` | a test window (an EDIT control) that reports every key, character, button, motion and wheel event it receives as JSON lines, plus what its low-level keyboard hook saw (`ll`), and answers `text`, `clear`, `front` and `quit` on stdin (`--stay` keeps it open without stdin). Key events carry the injector's tag (`extra`), so a person's own typing is told apart from the helper's |

## Tests

- `cargo test`: 40+ unit tests: the codec (framing, size limits, EOF), request parsing (unknown types and fields rejected), frame validation, the key table (unique codes and scan codes, extended and modifier flags, forbidden keys), the allowlist (default deny, case-insensitive paths, invalid paths, persistence and damage), and the session (nothing until enabled; allow only seen programs; desired-state diffing with modifier order; scope; elevated; foreground change; watchdog; pause / panic / disable / shutdown; forget; invalid frames; rate limit; status changes; stats).
- `cargo test -- --include-ignored`: also injects `KeyW` and `ArrowLeft` into a window the test creates and asserts the `WM_KEYDOWN` / `WM_CHAR` / `WM_KEYUP` messages and the extended-key bit.
- `pnpm run e2e:extension` runs the extension with a stub host; `node extension/scripts/e2e.mjs --desktop` runs it against the installed helper and this crate's `obpal-harness.exe`: keys are refused until the harness is allowed, then Space, ArrowUp and W are typed into its edit control (checked from the control's text, and tagged as the helper's by `GetMessageExtraInfo`), then refused again once it is forgotten.

## Limits and next steps

- Windows only. The session logic is platform-neutral; macOS (`CGEventPost`, Accessibility permission) and Linux (`uinput`, a udev rule, or the libei portal) need injectors and foreground lookups behind the same traits.
- No virtual gamepad: it needs a driver (ViGEmBus is archived; HIDMaestro is the user-mode candidate). The scope model already carries `gamepad`.
- The mouse is relative only (what games with raw input expect). An absolute path for desktop pointing is a later option.
- Not code-signed: SmartScreen will warn on first run until a signing identity exists. The extension ID it allows is fixed by the manifest key; a Chrome Web Store build gets its ID from the key uploaded with it (see `extension/scripts/key.mjs`).
- The browser itself cannot be allowed (for browser games that check `isTrusted`, a later option).
