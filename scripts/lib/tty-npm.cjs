/**
 * Run npm as if in a terminal so its web approval flow works without a console.
 * Stdin stays open and silent: npm prints the approval URL and polls without opening a browser.
 */
const [cli, ...args] = process.argv.slice(2)
for (const s of [process.stdin, process.stdout, process.stderr]) { s.isTTY = true; s.columns = 120; s.rows = 40; s.cursorTo = (x, y, cb) => { if (typeof cb === "function") cb(); return true }; s.clearLine = (d, cb) => { if (typeof cb === "function") cb(); return true }; s.moveCursor = (x, y, cb) => { if (typeof cb === "function") cb(); return true }; s.getColorDepth = () => 1; s.hasColors = () => false }
process.stdin.setRawMode = () => process.stdin
process.argv = [process.argv[0], cli, ...args]
require(cli)
