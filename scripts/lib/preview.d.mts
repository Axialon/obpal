/** See preview.mjs. */
export const SITE: string
export const PREVIEW_IMAGE: { path: string; width: number; height: number; alt: string }
export function pageUrl(path: string, origin?: string): string
export function pageWords(html: string, fallback?: string): { title: string; description: string }
export function previewTags(html: string, path: string, opts?: { fallback?: string; origin?: string }): { tag: 'meta'; attrs: Record<string, string>; injectTo: 'head' }[]
