/** Package a universal helper built on a Mac. ditto preserves executable modes in the zip. */
import { execFileSync } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'darwin') throw new Error('Run this packer on a Mac after building both targets and running lipo (desktop/README.md).')
const here = fileURLToPath(new URL('.', import.meta.url))
const binary = join(here, 'target/universal/obpal-desktop')
execFileSync('/usr/bin/lipo', ['-verify_arch', 'arm64', 'x86_64', binary], { stdio: 'inherit' })
const release = join(here, 'release')
await mkdir(release, { recursive: true })
const stage = await mkdtemp(join(release, 'macos-stage-'))
const folder = join(stage, 'obpal-desktop')
await mkdir(folder)
await copyFile(binary, join(folder, 'obpal-desktop'))
await chmod(join(folder, 'obpal-desktop'), 0o755)
for (const script of ['install.command', 'uninstall.command']) {
  await writeFile(join(folder, script), (await readFile(join(here, 'package', script), 'utf8')).replace(/\r\n/g, '\n'))
  await chmod(join(folder, script), 0o755)
}
await copyFile(join(here, '../LICENSE'), join(folder, 'LICENSE.txt'))
await copyFile(join(here, 'README.md'), join(folder, 'README.md'))
const out = join(release, 'obpal-desktop-macos-universal.zip')
execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', '--norsrc', folder, out], { stdio: 'inherit' })
console.log(`Packaged ${out}; staging files remain in ${stage} for inspection.`)
