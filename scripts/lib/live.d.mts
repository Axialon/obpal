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
