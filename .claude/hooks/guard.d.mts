/** See guard.mjs. */
export function commands(command: string, bash: boolean): string[][]
export function decide(input: {
  tool_name?: string
  tool_input?: { command?: string }
  cwd?: string
  agent_type?: string
}): { rule: string; reason: string } | null
export function main(): void
