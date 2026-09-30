# ob.Pal Packs 1.0.0

Packs standardise community control data and keep credit wherever it is used.
They are JSON, never code, HTML, scripts, drivers, models or executable expressions.
The catalogue marks maintained `obpal/` packs **Example** and third-party packs
**Community**. Third-party authors cannot use the reserved `obpal/` namespace.
A pack cannot claim project approval or official ob.Pal status. Names follow
[TRADEMARKS.md](../TRADEMARKS.md).

## Envelope

Every pack has the following fields. Unknown fields are errors, including nested
fields; per-kind body schemas are published beside `/pack.schema.json`.

| Field | Meaning and bound |
| --- | --- |
| `id` | `author/name`, lowercase; each part begins with a letter and has 2–32 letters, digits or dashes |
| `version` | Semver `major.minor.patch`, optionally with prerelease identifiers and build metadata; at most 64 characters |
| `kind` | `profile`, `mapping`, `mode`, `scene-link`, `controller-layout` or `experience` |
| `name` | Plain display name, 1–40 characters |
| `description` | Plain description, 1–240 characters |
| `author` | `{name, url?}`; name 1–80 characters, optional https URL |
| `license` | SPDX `MIT`, `CC-BY-4.0` or `CC0-1.0` (the approved CC0 option) |
| `source?` | Public https source URL; at most 500 characters, as for every external URL |
| `attribution` | One-line credit shown in the UI, 1–160 characters; retain required licence credit |
| `requires` | `{catalogue: "1.0.0", controllers: [...]}`; unique maintained controller ids, at most nine |
| `preview?` | `{url, bytes}`; original/licensed PNG, JPEG or WebP under `/packs/previews/`, at most 256 KiB; the build verifies actual size and raster signature |
| `created` | Valid calendar date `YYYY-MM-DD` |
| `deprecated?` | `{reason, replacement?}`; plain reason (160 characters), optional replacement pack id |
| `body` | The data for the kind, below |

The UTF-8 JSON envelope is at most 64 KiB. Plain display text has no markup or
line breaks and cannot assert project status. URLs have no embedded credentials.
The catalogue reader caps downloads at 2 MiB and 512 entries. Schemas check the
shape; `checkPack()` also checks bytes, supported versions, controllers, bindings,
profile limits, date validity and displayed status claims. Build validation is
mandatory and fails on a single invalid pack, duplicate id, wrong folder or file
name. The published `/catalogue.json` carries envelopes under `community`, with
`version` and `packSchema` alongside the existing built-in catalogue.

## Bodies and adoption

### Profiles — `catalogue/profiles/<name>.json`

`body` is the existing `ProfileSpec`; its `id` matches the pack's name part, and
`checkProfile()` remains the body validator. Include its controller (default
`face.gamepad`) in `requires.controllers`. Motion gains, curves, deadzones and
routes obey the existing profile limits. The phone offers gamepad and wheel
profiles alongside built-ins, caches checked envelopes in local storage and
rechecks cached entries before use. A valid new download replaces the cache;
offline, timeout, invalid data or unsupported catalogue versions retain the last
checked catalogue. A phone's offline shell and chunks use its existing service
worker. Without any cached catalogue the built-ins remain available.

Picker choices and chips show `by author · licence`; the picker also shows the
pack's attribution. Namespaced ids are selection and preference keys. The legacy
`mode.p` wire field uses a deterministic, bounded profile alias; the envelope
keeps the full identity. User overrides stay bounded by `resolveProfileSpec()`.
`Use on my phone` opens `/p/?pack=author%2Fname`. Profile selection applies when
the controller opens; picking a different profile clears the arrival request.
On a computer, **Send to a phone** shows a plain QR code for that same pack link,
with its credit. It carries the catalogue id, without a pairing secret or trust
mark. There is no fragment profile import or host `layout.profiles` import yet.

### Mappings — `catalogue/mappings/<name>.json`

`{site, controller, controls, buttons?}` names a lowercase site host (no scheme
or path), a maintained controller and 1–64 control-to-site-output bindings.
A control must be on that controller. Each output is `{kind: "key", code}` (a
bounded physical key code), `{kind: "mouse", button}` (0–2) or
`{kind: "gamepad", button}` (0–16). Hosts can consume these outputs using their
maintained integration; the pack never injects scripts or synthetic events on
its own. Optional `buttons` uses the existing `checkButtons()` rules for phone
physical input-to-control bindings. Include the controller in `requires.controllers`.
For a gamepad mapping with optional phone bindings, the phone picker explicitly applies or clears those bindings, shows its site and credit,
and releases held controls before changing bindings. Mapping choices are remembered
per screen; the user's own bindings still win. This is control data; listing a mapping does not automatically
install it into Link or promise that the site's current controls match it.

### Modes and presets — `catalogue/modes/<name>.json`

`{rig, duration, frames}` names a maintained simulation joint profile. `duration`
is greater than zero and at most 30 seconds. There are 2–120 frames, strictly
increasing `at` times from zero to duration, each with `joints` (1–64 named joint
angles in radians). Every frame uses the same joint names. Each angle must fit
the consumer's maintained profile limits. Packs contain no limits of their own.

`loadModePack(pack, rig)` validates against the consuming rig; `modePackPose()`
linearly interpolates the checked data. The consumer owns neutral, interruption,
rate limits and Stop (a software hold). A host can offer exact `id@version` values
in `layout.modePacks` with `layout.rig`. The phone loads packs, displays credit and
enables only compatible offers. Selection sends the existing
`value{id: "pack-mode", v: "author/name@version"}` message. The host resolves that
identity from its own checked catalogue; it never accepts joint commands from the
phone. Changed or unsupported versions cannot be selected. The reusable loader
and example ship now; the built-in humanoid preset implementations and their host
playback are intentionally unchanged while the humanoid lane is in progress.

### Scene links — `catalogue/scenes/<name>.json`

`{url}` is an https URL to a host example or community site. The Community list
shows attribution, data preview and an external link, opened with `noopener` and
`noreferrer`. It never embeds the site, grants it an ob.Pal trust mark or seal, or
implies review of that site's future contents. Its owner controls its behaviour.

### Controller layouts — specification and validation only

`{controllers, profile?}` chooses one or more maintained controllers, optionally
referencing an attributed profile pack id. Requires includes every controller.
No custom HTML or new controller implementation is allowed. Runtime layout pack
adoption is deferred; built-in host layouts continue to use `Layout`.

### Experiences — specification and validation only

`{packs: [{id, version}, ...]}` lists 1–16 exact versioned pack references, without
self-reference or duplicate references. A future resolver must reject cycles,
missing or deprecated dependencies and incompatible controllers. Runtime
experience composition is deferred; references do not cause network fetches.

## Versions, compatibility and deprecation

Catalogue 1.0.0 consumers accept that exact supported standard version. Increment
a pack's patch for corrections, minor for compatible additions, and major when
controls, rig or meaning changes. Prerelease identifiers must use semver spelling;
consumers do not silently upgrade a saved mode identity. Keep the namespace and
author stable. A maintainer confirms namespace ownership during review; an id is
not authentication. Reserve `obpal/` for repository-maintained examples and check
credit/source before accepting changes to it.

Mark a withdrawn entry deprecated, explain why and suggest a replacement if one
exists. It stays credited and previewable but is not offered for new selection.
A cached older catalogue can remain usable offline; reconnect to receive changes.
The catalogue contains one current version per id, not a historical version store.

## Safety and moderation

Packs cannot raise safety limits, introduce a driver, bypass host capabilities,
change physical driver permissions or request camera uploads. Physical control
systems accept only maintained, commissioned drivers. Mode packs are simulation
only: `loadModePack(..., true)` rejects them for a physical lane. Schemas and
validators reject extra fields such as `limits`, `driver`, `script` or `html`.
Validation bounds data; it does not establish safety of an external scene site.

A person or AI agent copies an example, fills credit, public source, licence and
requirements, then runs checks and a build. The builder's **Propose pack** fills
the profile envelope and opens a GitHub issue containing its JSON. Other kinds
use an issue or pull request with the complete envelope. A maintainer checks
namespace ownership, licence permission, credit, preview provenance, useful
controls, limits and copy. The overclaims guard reads every displayed pack text
field with the same rules as site copy. Review and merge precede publication;
community submissions never publish automatically. Report a misleading pack in
an issue with its id/version; maintainers correct or deprecate it and retain credit.
