export function guardShip(input: { root: string; gitDir: string; commonDir: string; branch: string; status: string }): void
export function workerVersion(output: string): string
export function runShip(run: (command: string, args: string[]) => string, target: import('./deployment.mjs').PublicationTarget): { version: string; check: string; published: string }
