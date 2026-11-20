import { build } from 'esbuild'
import { builtinModules } from 'node:module'

const development = process.argv.includes('--development') || process.env.NODE_ENV === 'development'
const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]))
const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  external: ['electron'],
  mainFields: ['module', 'main'],
  minify: !development,
  keepNames: true,
  sourcemap: development,
  legalComments: 'eof',
  metafile: true,
}

const main = await build({
  ...common,
  entryPoints: ['src/main/main.ts'],
  outfile: 'dist/main/main.js',
  format: 'esm',
  // Bundled CommonJS dependencies still use require for Node builtins under ESM.
  banner: { js: "import { createRequire as __shenbclCreateRequire } from 'node:module'; const require = __shenbclCreateRequire(import.meta.url);" },
})
const preload = await build({
  ...common,
  entryPoints: ['src/main/preload.ts'],
  outfile: 'dist/main/preload.cjs',
  format: 'cjs',
})

// The release deliberately ships no node_modules: an accidental external npm
// import must fail the build instead of becoming a user's MODULE_NOT_FOUND.
for (const result of [main, preload]) {
  for (const output of Object.values(result.metafile.outputs)) {
    for (const dependency of output.imports) {
      if (dependency.external && dependency.path !== 'electron' && !builtins.has(dependency.path)) {
        throw new Error(`Main-process dependency was not bundled: ${dependency.path}`)
      }
    }
  }
}
