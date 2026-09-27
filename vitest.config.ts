import { defineConfig } from 'vitest/config'
import { markupBuild } from './scripts/markup-build.mjs'

// Kept separate from vite.config.ts so tests don't boot the Cloudflare Worker runtime.
export default defineConfig({ plugins: [markupBuild(process.cwd())], test: { include: ['tests/**/*.test.ts'], environment: 'node' } })
