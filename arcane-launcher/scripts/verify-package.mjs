import { listPackage, extractFile } from '@electron/asar'
import { access, readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

const source = JSON.parse(await readFile('package.json', 'utf8'))
const config = JSON.parse(await readFile('electron-builder.json', 'utf8'))
const root = join(config.directories.output, 'win-unpacked')
const archive = join(root, 'resources/app.asar')
await access(join(root, 'shenBCL Launcher.exe'))
const entries = listPackage(archive).map((entry) => entry.replaceAll('\\', '/'))
const required = [
  '/dist/main/main.js',
  '/dist/main/preload.cjs',
  '/dist/renderer/index.html',
  '/build/icon.png',
]
for (const file of required) if (!entries.includes(file)) throw new Error(`打包文件缺失：${file}`)
const metadata = JSON.parse(extractFile(archive, 'package.json').toString())
if (metadata.name !== source.name || metadata.version !== source.version) throw new Error('Incorrect package branding/version')
for (const file of ['README.md', 'THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_LICENSES.txt', 'docs/MICROSOFT_LOGIN.md', 'docs/MODPACK_IMPORT.md', 'docs/licenses/skinview3d.txt', 'docs/licenses/three.txt']) await access(join(root, file))
for (const chunk of ['SkinPreview-', 'PortalScene-', 'AccountDialog-', 'ModpackImportDialog-', 'DownloadCenter-', 'three.module-']) if (!entries.some(file => file.startsWith(`/dist/renderer/assets/${chunk}`))) throw new Error(`Missing launcher component: ${chunk}`)
if (entries.some(file => /ui-review|\.ui-real-modpack|modpack-jobs|account\.encrypted|\/node_modules(?:\/|$)|\.map$/i.test(file))) throw new Error('Release contains dependencies, sourcemaps, verification artifacts or user data')
const locales = (await readdir(join(root, 'locales'))).filter(file => file.endsWith('.pak')).sort()
if (JSON.stringify(locales) !== JSON.stringify(['en-US.pak', 'zh-CN.pak', 'zh-TW.pak'])) throw new Error(`Unexpected locales: ${locales.join(', ')}`)
async function size(folder) {
  let bytes = 0
  for (const item of await readdir(folder, { withFileTypes: true })) bytes += item.isDirectory() ? await size(join(folder, item.name)) : (await stat(join(folder, item.name))).size
  return bytes
}
console.log(JSON.stringify({ name: metadata.name, version: metadata.version, archiveEntries: entries.length, archiveBytes: (await stat(archive)).size, unpackedBytes: await size(root), locales }))
