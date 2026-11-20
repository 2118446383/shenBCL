import { createRequire } from 'node:module'
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join, parse, resolve } from 'node:path'

// The npm packages are bundled into JS, so ship their license texts separately.
const roots = ['@xmcl/core', '@xmcl/installer', 'vue', 'lucide-vue-next', 'skinview3d', 'three']
const seen = new Set()
const sections = []
async function collect(name, from) {
  const require = createRequire(join(from, 'package.json'))
  let entry
  try { entry = require.resolve(`${name}/package.json`) }
  catch { entry = require.resolve(name) }
  let folder = dirname(entry)
  let metadata
  while (folder !== parse(folder).root) {
    try {
      const candidate = JSON.parse(await readFile(join(folder, 'package.json'), 'utf8'))
      if (candidate.name === name) { metadata = candidate; break }
    } catch { /* The entry may be nested under dist/. */ }
    folder = dirname(folder)
  }
  if (!metadata) throw new Error(`Cannot locate license metadata: ${name}`)
  if (seen.has(folder)) return
  seen.add(folder)
  const files = (await readdir(folder)).filter(file => /^(licen[cs]e|copying|notice)(?:$|[.\-_])/i.test(file)).sort()
  const licenseTexts = await Promise.all(files.map(async file => `${file}\n${await readFile(join(folder, file), 'utf8')}`))
  if (!files.length) {
    if (!metadata.license) throw new Error(`Missing license declaration: ${name}@${metadata.version}`)
    // Preserve the published declaration and authorship when npm omitted a license file.
    licenseTexts.push(`No separate license file in the published package.\n${JSON.stringify({ name, version: metadata.version, license: metadata.license, author: metadata.author, contributors: metadata.contributors, repository: metadata.repository }, null, 2)}`)
    const readme = (await readdir(folder)).find(file => /^readme(?:$|\.)/i.test(file))
    if (readme) licenseTexts.push(`${readme}\n${await readFile(join(folder, readme), 'utf8')}`)
  }
  sections.push(`${name}@${metadata.version}\nLicense: ${typeof metadata.license === 'string' ? metadata.license : JSON.stringify(metadata.license ?? 'See below')}\n${licenseTexts.join('\n\n')}`)
  for (const dependency of Object.keys(metadata.dependencies ?? {}).sort()) await collect(dependency, folder)
}
for (const name of roots) await collect(name, resolve('.'))
sections.sort()
await mkdir('build', { recursive: true })
await writeFile('build/THIRD_PARTY_LICENSES.txt', `shenBCL bundled third-party licenses\n\n${sections.join('\n\n' + '='.repeat(72) + '\n\n')}\n`, 'utf8')
console.log(`Collected licenses for ${seen.size} bundled dependency packages.`)
