import type { Plugin } from 'vite'
export function domTemplates(code: string, id: string): string
export function templateCatalogue(root: string): string[]
export function markupBuild(root: string): Plugin
