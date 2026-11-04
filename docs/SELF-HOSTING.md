# Run a service you own

The official hosted product is [ob.Pal](https://obpal.blackboxes.net/). Its domain, account, payment services and
publishing identity belong to its maintainers. Clone [the public source](https://github.com/Axialon/obpal) for an
independent service. Keep attribution and follow [the fork naming policy](../TRADEMARKS.md).

The public export's `wrangler.jsonc` is an inert template. The maintainer's canonical checkout retains its production
configuration for the coordinator; the exporter constructs the public template from shared runtime bindings.
Use the public snapshot for an independent installation. Do not copy a maintainer's account identifiers or settings.

## Configure before deploying

1. Install dependencies with `pnpm install --frozen-lockfile`.
2. In `wrangler.jsonc`, change `name` from `my-controller` to a Worker name you own, for example `example-controller`.
   Set exactly one custom domain: `"routes": [{ "pattern": "controller.example.org", "custom_domain": true }]`.
   Replace `controller.example.org` with a domain in your Cloudflare account. Keep `workers_dev: false`.
   Review the rate-limit namespace IDs against other Workers in that account; the public template uses `1`, `2`, `3`
   as examples, retaining the production limit values.
3. Select your account and origin in your shell. Replace these placeholders before deploying:

   ```sh
   export CLOUDFLARE_ACCOUNT_ID='<your-cloudflare-account-id>'
   export OBPAL_PUBLIC_ORIGIN='https://controller.example.org'
   ```

   PowerShell:

   ```powershell
   $env:CLOUDFLARE_ACCOUNT_ID = '<your-cloudflare-account-id>'
   $env:OBPAL_PUBLIC_ORIGIN = 'https://controller.example.org'
   ```

   Use credentials authorized for that account through your own Wrangler login or environment. Keep account
   identifiers and credentials out of commits. Build metadata, canonical URLs, the sitemap, socket CSP, deployment,
   live checks and indexing share `OBPAL_PUBLIC_ORIGIN`. The deploy wrapper checks the source and built Wrangler
   domain against it before deployment and refuses missing targets or extra routes.
   Deploy from a standalone clone or source archive; the wrapper refuses linked lane worktrees.
4. Configure your own strong, random `TURN_SECRET` with `pnpm exec wrangler secret put TURN_SECRET`, after selecting
   the Worker and account above. The current room service uses it for keyed address hashing even without a relay.
   `TURN_SECRET` alone enables no relay: leave `TURN_URLS` unset for STUN only. If you choose Cloudflare TURN, use
   your own `TURN_KEY_ID` and `TURN_KEY_API_TOKEN`; keep one supported hashing secret configured. See
   [the relay and address-hashing details](../spec/SECURITY.md#6-running-it-yourself).
5. Keep the Durable Object bindings and migrations. Retain `RL_SOCKET` and `RL_ICE` to limit room/ICE abuse.
   They are optional in the room code and fail open. `RL_FILM` is required when the reviewed film manifest admits
   a campaign film. Missing or failed admission returns 503, and address hashing uses the secret from step 4.
   The public profile exports an empty film manifest and omits the hosted campaign films and posters. Adding films
   requires a separate rights and source-scope review. Account spending controls are separate from these per-location
   request limits. Review your account's supported services and usage.
6. Run `pnpm run deploy` when ready to deploy your service. It runs tests and builds before uploading the Worker
   and assets. Indexing is separate. A plain `pnpm run build` performs no deployment and defaults to loopback when
   no public origin is configured.

The site's own screens explicitly pair through their current origin. Independently hosted pages using the SDK
should pass `service: 'https://controller.example.org'` to `Remote.create`; hosted-product examples still use the
official service. Rebuild your own Link extension with the same `OBPAL_PUBLIC_ORIGIN` as described in the security
spec. Official download and support links remain links to official products.

## Validate and index your service

With the same origin configured, `pnpm run check:live` actively opens rooms, sends requests, and uses TURN traffic.
`-- --origin https://controller.example.org` overrides it. Only test a service you operate or have permission to use.
For STUN-only deployments select `-- --only pages,api,headers,release` to omit TURN. Release checks intentionally
verify the official Link downloads linked by the site, including GitHub requests. Presentation and recording tools
default to loopback; select your origin before using them on a hosted service.

IndexNow is opt-in. Generate your own verification key and matching `<key>.txt` file under `public/` before building
and deploying. Inspect `pnpm run indexnow -- --key-file <key>.txt --dry-run`; it makes no network requests. To request
indexing, use the same command with `--submit`. It checks that all sitemap URLs and the live verification file belong
to the configured origin before contacting IndexNow. The exporter omits the maintainer's verification file.

## Payments and maintainer publication

The public template has no D1 contribution database, payment return origins or Stripe portal; sponsorship is off,
and no Stripe secret is required. The application currently keeps new native checkout closed. Official donation
links voluntarily support the upstream project. Running the room service requires no payment integration.
If you independently implement payments, configure and test your own ledger, origins, provider account, portal
and webhook handling. The shared production ledger is not a self-host prerequisite.

`ship` is the maintainer coordinator's integration, deployment, active verification, snapshot publication and private
backup workflow. Self-host deployment uses `deploy`. `node scripts/open-source.mjs --keep-logs` only creates and
scans a temporary public snapshot. Scanning covers the snapshot's files, not all Git history, and does not prove that
no secret has ever existed.

Publishing additionally requires `OBPAL_PUBLIC_REPOSITORY` (your existing public `owner/repository` with default branch
`main`), `OBPAL_SNAPSHOT_AUTHOR_NAME` (your public name), `OBPAL_SNAPSHOT_AUTHOR_EMAIL` (your GitHub noreply address)
and `OBPAL_PUBLIC_ORIGIN`. Pin the approved full source commit in `OBPAL_PUBLIC_SOURCE`, existing public `main`
commit in `OBPAL_PUBLIC_BASELINE` and exact materialized Git tree in `OBPAL_PUBLIC_TREE`. Review those bytes and
executable modes before authorizing publication. Repository lookup, source, tree or baseline failures stop the command.
Publication appends one snapshot by a normal fast-forward push and reads back its commit and tree. A failed push or
readback requires inspection before another authorization. Earlier public history remains reachable. Repository creation,
history rewriting and automatic retry are separate operations. Only an explicitly authorized maintainer should use `--publish` or `ship`.
The maintainer must supply their existing production values in the environment before the next authorized ship;
this change neither configures credentials nor changes the deployed service.
