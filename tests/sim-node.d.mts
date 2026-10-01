export const assert: {
  ok(value: unknown, message?: string): asserts value
  equal<T>(actual: unknown, expected: T, message?: string): asserts actual is T
  notEqual(actual: unknown, expected: unknown, message?: string): void
  deepEqual<T>(actual: unknown, expected: T, message?: string): asserts actual is T
  throws(fn: () => unknown, expected?: RegExp | Function | object | Error, message?: string): void
}
export function readFileSync(path: string | URL, encoding: string): string
