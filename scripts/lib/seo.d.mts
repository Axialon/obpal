import type { SimCard } from '../../src/sim/catalogue'

export const AI_SIGNALS: string
export const INDEXABLE_PAGES: string[]
export function simUrl(card: SimCard): string | null
export function escapeHtml(value: unknown): string
export function jsonLd(value: unknown): string
export function robotsTxt(): string
export function sitemapXml(cards: readonly SimCard[], modified?: (path: string) => string): string
export const FAQ: { question: string; answer: string }[]
export function faqMarkup(): string
export function structuredData(path: string, cards: readonly SimCard[]): Record<string, unknown>
export function catalogueMarkup(cards: readonly SimCard[], controllerName: (id: string) => string): string
export function deviceMarkup(html: string, card: SimCard, controllerName: (id: string) => string): string
