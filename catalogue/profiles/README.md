# Community profiles

For people and AI agents: copy the JSON example here, give it a lowercase
`author/name` id and use the name part as the file name. Fill every envelope field
in [PACKS.md](../../spec/PACKS.md). Keep credit accurate and choose MIT, CC-BY-4.0
or CC0-1.0. Your author name is a credit, not a project status claim.

This folder accepts `profile` packs. The body is a controller profile; `checkProfile()` still checks it.

Run `pnpm run check` and `pnpm run build`; every JSON pack is validated by the
build. Propose a pull request or a GitHub issue with the complete JSON and any
local raster preview. See [CONTRIBUTING.md](../../CONTRIBUTING.md) for review and
[TRADEMARKS.md](../../TRADEMARKS.md) for naming. Never add code, HTML, credentials
or an unlicensed image. Tests write to a temporary folder; evidence goes in artifacts/.
