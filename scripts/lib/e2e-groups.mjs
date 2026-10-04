/** Record an aborted group without skipping later groups that own their own setup and cleanup. */
export async function runIndependentGroups(groups, check) {
  for (const { name, run } of groups) {
    try {
      await run()
    } catch (error) {
      await check(`${name} group aborted; remaining checks in this group were not run`, async () => { throw error })
    }
  }
}
