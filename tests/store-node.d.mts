export { readText, readBytes } from './devtools-node.mjs'
export interface Field { name: string; text: string }
export interface Tab { title: string; fields: Field[] }
export function baselineText(): string
export function parseListing(text: string): Tab[]
export function compareFields(tabs: Tab[], baseline: Tab[]): { title: string; fields: (Field & { before?: string; changed: boolean })[] }[]
export function changedParagraphs(before: string, after: string): { before: string; after: string }
export function toolbarMark(svg: string, size: number): string
export function iconFixtures(): Promise<{ source: string; icons: { size: number; png: Uint8Array }[] }>
export function referencePixels(): Promise<Uint8Array>
export function compareIcon(png: string | Uint8Array, pad: number, ref: Uint8Array): Promise<{ silhouette: number; colourMean: number }>
export function oldStoreIcon(): Uint8Array
export function alphaPixels(png: Uint8Array): Promise<Uint8Array>
export function imageInfo(path: string): Promise<{ width: number; height: number; channels: number }>
