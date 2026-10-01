/** Offline evidence only: resolve extensionless relative TypeScript imports for Node 22 strip-types. */
export async function resolve(specifier, context, nextResolve) {
  try { return await nextResolve(specifier, context) }
  catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND' || !/^\.{1,2}\//.test(specifier) || /\.[a-z]+$/i.test(specifier)) throw error
    return nextResolve(`${specifier}.ts`, context)
  }
}
