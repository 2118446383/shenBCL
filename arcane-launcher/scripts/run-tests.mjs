import { spawn } from 'node:child_process'
import { mkdir, readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tests = resolve(project, '../tests')
const files = (await readdir(tests)).filter(name => name.endsWith('.test.ts')).sort().map(name => join(tests, name))
if (!files.length) throw new Error(`No test sources in ${tests}`)
const temporary = join(tests, '.tmp')
await mkdir(temporary, { recursive: true })
const require = createRequire(import.meta.url)
const child = spawn(process.execPath, [require.resolve('tsx/cli'), '--test', ...process.argv.slice(2), ...files], {
  cwd: project,
  stdio: 'inherit',
  windowsHide: true,
  env: {
    ...process.env,
    NODE_PATH: [join(project, 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(delimiter),
    TMP: temporary, TEMP: temporary, TMPDIR: temporary,
  },
})
child.once('error', error => { console.error(error); process.exitCode = 1 })
child.once('exit', code => { process.exitCode = code ?? 1 })
