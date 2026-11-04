export interface Payload { host: string; key: string; keyLocation: string; urlList: string[] }
export function checkIndexNowProof(input: { origin: string; keyFile?: string; fetcher?: typeof fetch }): Promise<boolean>
export function indexNowPayload(input: { origin: string; keyFile: string; key: string; sitemap: string }): Payload
export function submitIndexNow(payload: Payload, opts?: { submit?: boolean; fetcher?: typeof fetch }): Promise<{ submitted: boolean; count: number }>
