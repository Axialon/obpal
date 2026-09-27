/** See scan.mjs. */
export interface Rule { id: string; what: string; re: RegExp; check?: (m: RegExpExecArray) => boolean }
export interface Finding { rule: string; what: string; hint: string }
export const SECRET_RULES: Rule[]
export const PRIVATE_RULES: Rule[]
export const ALLOW: string[]
export function readDenyWords(root: string): string[]
export function mask(s: string): string
export function scanText(text: string, opts?: { rules?: Rule[]; deny?: string[] }): Finding[]
export function addedLines(diff: string): { lines: { path: string; line: number; text: string }[]; binary: string[] }
export function isLocalOnly(path: string): boolean
export function riskyPath(path: string): string | null
