/** See live.mjs. */
export interface Check { check: string; status: 'pass' | 'FAIL' | 'WARN'; detail: string }
export const PAGES: string[]
export const VIEWPORTS: [number, number][]
export function pageHeaderChecks(get: (name: string) => string | null | undefined): Check[]
export function securityTxtCheck(status: number, text: string, now: number): Check
export function shownCode(text: string): string | null
export function turnChecks(r: {
  hostTurn: boolean[]
  check: { turn: boolean; urls: string[]; creds: boolean } | null
  relay: { opened: boolean; openMs?: number; echoMs?: number; localType?: string; relayProtocol?: string } | null
}): Check[]
export const LINK_REPO: string
export const LINK_STORE: string
export const LINK_ZIP: string
export function linkInstallChecks(html: string): Check[]
export const RELEASE_ASSETS: (version: string) => string[]
export function linkVersionLabel(html: string): string | null
export function latestRelease(json: unknown): { tag: string; assets: string[] } | null
export function releaseChecks(r: { label: string | null; release: { tag: string; assets: string[] } | null; http?: number }): Check[]
