import { defineConfig } from 'vitest/config'
import { markupBuild } from './scripts/markup-build.mjs'

// Kept separate from vite.config.ts so tests don't boot the Cloudflare Worker runtime.
// Tests that spawn git, builds or Rapier can take several times longer while lanes load the machine, so the
// default 5 s limit is raised to 30 s; a genuine hang still fails.
export default defineConfig({ plugins: [markupBuild(process.cwd())], test: { include: ['tests/**/*.test.ts'], environment: 'node', testTimeout: 30_000 } })
