import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'
import { finished } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workspace = dirname(project)
const metadata = JSON.parse(await readFile(join(project, 'package.json'), 'utf8'))
const require = createRequire(import.meta.url)
const installerRequire = createRequire(require.resolve('@xmcl/installer'))
const { ZipFile } = installerRequire('yazl')
const destination = join(workspace, '审核材料')
const entries = new Map()
async function addFile(source, name) {
  if (/^\.env(?:$|\.)|^\.npmrc$|\.(?:pem|key|pfx|p12|encrypted)$/i.test(basename(name))) throw new Error(`Private configuration file is not allowed: ${name}`)
  const info = await lstat(source)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Not an ordinary source file: ${name}`)
  const bytes = await readFile(source)
  if (bytes.length > 5 * 1024 * 1024) throw new Error(`Unexpected large source file: ${name}`)
  if (/\.(?:[cm]?[jt]s|vue|svg|json|md|html|css|txt)$/i.test(name)) {
    const text = bytes.toString('utf8')
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{30,}|\bsk-[A-Za-z0-9]{32,}/.test(text)) throw new Error(`Potential private credential in source: ${name}`)
  }
  entries.set(name, bytes)
}
async function addTree(source, prefix) {
  const info = await lstat(source)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Not an ordinary source directory: ${prefix}`)
  for (const item of await readdir(source, { withFileTypes: true })) {
    if (item.isSymbolicLink()) throw new Error(`Source link is not allowed: ${prefix}/${item.name}`)
    if (item.isDirectory()) await addTree(join(source, item.name), `${prefix}/${item.name}`)
    else await addFile(join(source, item.name), `${prefix}/${item.name}`)
  }
}

// Explicit allowlist: no app data, cached downloads, release binaries or local probes.
await addTree(join(project, 'src'), 'arcane-launcher/src')
for (const name of ['package.json', 'package-lock.json', 'electron-builder.json', 'vite.config.ts', 'tsconfig.main.json', 'tsconfig.renderer.json', '.gitignore', 'THIRD_PARTY_NOTICES.md']) await addFile(join(project, name), `arcane-launcher/${name}`)
for (const name of ['build-main.mjs', 'build-icons.mjs', 'collect-licenses.mjs', 'dev.mjs', 'run-tests.mjs', 'verify-package.mjs', 'export-review-source.mjs']) await addFile(join(project, 'scripts', name), `arcane-launcher/scripts/${name}`)
for (const name of ['icon.png', 'icon.ico']) await addFile(join(project, 'build', name), `arcane-launcher/build/${name}`)
for (const name of ['MICROSOFT_LOGIN.md', 'MODPACK_IMPORT.md', 'SECURITY_REVIEW.md', 'REVIEW_SUBMISSION.md']) await addFile(join(project, 'docs', name), `arcane-launcher/docs/${name}`)
await addTree(join(project, 'docs/licenses'), 'arcane-launcher/docs/licenses')
for (const name of (await readdir(join(workspace, 'tests'))).filter(name => name.endsWith('.test.ts')).sort()) await addFile(join(workspace, 'tests', name), `tests/${name}`)

const reviewReadme = `# shenBCL ${metadata.version} — source for application review

shenBCL is a Windows desktop launcher for Minecraft: Java Edition, built with Electron, Vue and TypeScript. This repository contains reviewable source, build configuration and controlled regression tests. It is a working development release; planned AI, multiplayer, map and replay tools are not implemented.

## Current Microsoft integration

- Application name: shenBCL
- Public application/client ID: 5df4a819-6add-4aba-a297-6e301deeb8a0
- Public directory/tenant ID: 51e084d1-df19-4b43-9b53-2876a45a5270
- Personal-account endpoint: consumers; scopes: XboxLive.signin offline_access.
- Microsoft device-code endpoint returned HTTP 200 for this application on 2026-11-20. Minecraft Services approval and real-account end-to-end verification are still pending. No approval is claimed.

Players authorize in the official Microsoft website. The main process exchanges Microsoft, Xbox Live, XSTS and Minecraft tokens, validates Java entitlement and profile, and retrieves skin/cape images. Tokens stay in the main process and are encrypted locally with Electron safeStorage backed by Windows. The renderer receives only public profile data and the user-facing device code. Failed Microsoft authentication is not silently changed into an offline identity. A separate local/offline mode is explicitly labeled and is not presented as a verified Microsoft account.

## Inspect the implementation

- [Application identity](arcane-launcher/src/shared/microsoft-app.ts)
- [Authentication, ownership and profile service](arcane-launcher/src/main/services/account.ts)
- [Encrypted storage, IPC and trusted-window boundary](arcane-launcher/src/main/main.ts)
- [Renderer bridge](arcane-launcher/src/main/preload.ts)
- [Account interface](arcane-launcher/src/renderer/components/AccountDialog.vue)
- [Authenticated game launch](arcane-launcher/src/main/services/launch.ts)
- [Security review and remaining limits](arcane-launcher/docs/SECURITY_REVIEW.md)
- [Authentication regression tests](tests/account.test.ts)

## Build and test

Use Node.js 22 or newer on Windows. Keep the sibling arcane-launcher/ and tests/ folders in this layout.

\`\`\`powershell
cd arcane-launcher
npm ci
npm run build
npm test
npm start
# Optional Windows distribution:
npm run package:dir
node scripts/verify-package.mjs
\`\`\`

The test runner reads ../tests and places temporary fixtures under ../tests/.tmp. The application distribution contains no tests or npm dependency tree. Network access is required to install development dependencies, download Electron and use game services. Java is a separate prerequisite for launching Minecraft; the project does not include game files, Java, mods or modpacks.

## Included and excluded

This archive contains source, icons/textures, build configuration, licenses, selected technical documentation and test sources. It excludes node_modules, dist, releases, caches, local verification data, account files, tokens, player instances, saves, game archives and machine-specific cleanup reports. SOURCE_MANIFEST.sha256 records the included file bytes.

Project code retains its existing UNLICENSED status; publication for review does not grant an additional open-source license. Third-party code and Minecraft textures retain their respective ownership and terms; see [component notices](arcane-launcher/THIRD_PARTY_NOTICES.md). shenBCL is an independent project and is not affiliated with or endorsed by Mojang or Microsoft.
`
entries.set('README.md', Buffer.from(reviewReadme, 'utf8'))
entries.set('arcane-launcher/README.md', Buffer.from('# shenBCL\n\nSee the [review README](../README.md) for the source layout, build steps, authentication flow and approval status.\n', 'utf8'))
const manifest = [...entries].sort(([a], [b]) => a.localeCompare(b)).map(([name, bytes]) => `${createHash('sha256').update(bytes).digest('hex')}  ${name}`).join('\n') + '\n'
entries.set('SOURCE_MANIFEST.sha256', Buffer.from(manifest, 'utf8'))
await mkdir(destination, { recursive: true })
const archive = join(destination, `shenBCL-source-${metadata.version}.zip`)
const replace = process.argv.includes('--replace')
if (replace) {
  const previous = await lstat(archive).catch(error => { if (error.code !== 'ENOENT') throw error })
  if (previous && (!previous.isFile() || previous.isSymbolicLink())) throw new Error('Refusing to replace a non-ordinary source archive.')
}
const zip = new ZipFile()
const output = createWriteStream(archive, { flags: replace ? 'w' : 'wx' })
const complete = finished(output)
zip.outputStream.on('error', error => output.destroy(error))
zip.outputStream.pipe(output)
for (const [name, bytes] of [...entries].sort(([a], [b]) => a.localeCompare(b))) zip.addBuffer(bytes, name, { compress: true, compressionLevel: 9 })
zip.end()
await complete
await writeFile(join(destination, '上传步骤.md'), await readFile(join(project, 'docs/REVIEW_SUBMISSION.md')))
console.log(JSON.stringify({ archive, files: entries.size, rawBytes: [...entries.values()].reduce((sum, bytes) => sum + bytes.length, 0) }))
