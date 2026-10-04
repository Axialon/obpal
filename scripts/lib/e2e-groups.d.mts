export function runIndependentGroups(
  groups: readonly { name: string; run: () => Promise<unknown> }[],
  check: (name: string, run: () => Promise<unknown>) => Promise<unknown>,
): Promise<void>
