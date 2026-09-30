# Contributing packs

People and AI agents use the same data standard and review. Read
[spec/PACKS.md](spec/PACKS.md), `/pack.schema.json`, the per-kind body schemas and
[TRADEMARKS.md](TRADEMARKS.md) before naming or proposing a pack.

1. Copy an example in `catalogue/profiles`, `catalogue/mappings`, `catalogue/modes`
   or `catalogue/scenes`. Use a lowercase `author/name` id and `<name>.json` in
   the matching folder. Keep the namespace stable; `obpal/` is reserved for the
   repository's maintained examples. Never present a community entry as project
   approval or claim ob.Pal status.
2. Fill version, name, description, author, created date, requirements and one-line
   attribution. Link public source where possible. Use only SPDX MIT, CC-BY-4.0
   or CC0-1.0. Confirm you can license every part. Keep any required CC-BY credit
   and source links. Add only original or permissively licensed raster previews;
   credit third-party assets in `src/support/open-source.json`.
3. For a **profile**, tune a non-built-in `ProfileSpec` and run `checkProfile()`
   as well as `checkPack()`. The catalogue builder wraps it in the envelope.
   For a **mapping**, name a site from Link's known-site table where possible,
   a maintained controller and control-to-key, mouse or gamepad outputs. Optional
   phone input bindings use `checkButtons()`; host outputs use `checkPack()`.
   For a **mode/preset**, name a maintained simulation rig and timed joint angles
   in radians. Pass its joint limits as `checkPack()` context or use
   `loadModePack()`. No pack supplies new limits or drives a physical system.
   For a **scene link**, use an https URL to your own host page. It is listed as
   Community and opens externally, without ob.Pal trust marks or the seal.
   Controller-layout and experience schemas are available for design feedback;
   their runtime adoption is deferred, so do not advertise them as working.
4. Run `pnpm run check` and `pnpm run build`. The build checks every pack and its
   preview, and stops on an invalid one. Test the phone picker, credit and
   compatibility for a controller pack; open a scene link as a separate site.
   Keep evidence under ignored `artifacts/`; tests write to a temporary folder.
5. Use **Propose pack** at `/catalogue/#build` for a profile or open a GitHub issue
   with the complete envelope for another kind. A pull request can add its JSON
   and preview. Describe what it controls, how you tested it, who owns the work
   and what permission covers it. AI agents must include the same evidence and
   credit; they may not invent an author, endorsement or asset licence.

A maintainer reviews namespace ownership, licensing, attribution, controls,
compatibility, safety bounds and copy, then merges it. Publication follows the
normal coordinator workflow. Submissions cannot upload executable code or HTML.
Corrections retain credit and increment semver. Withdrawals use `deprecated`
with a reason and optional replacement; cached offline data updates when the
phone next gets a valid catalogue. Use an issue naming the id/version to report
a broken or misleading entry. Never include keys, tokens or private account data.
