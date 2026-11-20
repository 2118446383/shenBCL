import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CatalogService } from '../arcane-launcher/src/main/services/catalog';
import { exportCatalogFile } from '../arcane-launcher/src/main/services/catalog-export';

const bytes = Buffer.from('verified standalone catalog download');
const sha512 = createHash('sha512').update(bytes).digest('hex');
const metadata = { type: 'mod' as const, size: bytes.length, sha512 };
async function temporary(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shenbcl-catalog-export-'));
  try { await run(root); }
  finally { assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith('shenbcl-catalog-export-')); await rm(root, { recursive: true, force: true }); }
}

for (const type of ['mod', 'modpack'] as const) {
  test(`${type} downloads can be saved independently with no client instance or dependency install`, async () => {
    await temporary(async root => {
      const extension = type === 'mod' ? '.jar' : '.mrpack';
      const name = `example${extension}`;
      const calls: string[] = [];
      const service = new CatalogService({ fetch: async (input) => {
        const url = new URL(String(input)); calls.push(url.pathname);
        if (url.pathname === '/v2/project/Example') return Response.json({ id: 'Example', project_type: type, client_side: 'optional' });
        if (url.pathname === '/v2/project/Example/version') return Response.json([{
          id: 'Version', project_id: 'Example', name: 'Example 1.0', version_number: '1.0', version_type: 'release',
          date_published: '2026-01-01T00:00:00Z', game_versions: ['1.12.2'], loaders: ['forge'],
          files: [{ filename: name, url: `https://cdn.modrinth.com/data/Example/versions/Version/${name}`, size: bytes.length, hashes: { sha512 }, primary: true }],
          dependencies: [{ dependency_type: 'required', project_id: 'OptionalToDownload' }],
        }]);
        if (url.pathname.endsWith(name)) return new Response(bytes);
        throw new Error(`Unexpected request: ${url.pathname}`);
      } });
      const [version] = await service.versions('Example', { type, minecraftVersion: '1.12.2', loader: 'forge' });
      const ticket = version.files[0].ticket;
      const downloaded = await service.download(ticket, path.join(root, 'cache'));
      const output = path.join(root, 'selected-folder'); await mkdir(output);
      const result = await exportCatalogFile(downloaded.path, path.join(output, name), service.ticket(ticket));
      assert.equal(result, path.join(await import('node:fs/promises').then(fs => fs.realpath(output)), name));
      assert.deepEqual(await readFile(result), bytes);
      assert.deepEqual(await readdir(output), [name]);
      assert.equal(calls.length, 3, 'standalone download does not resolve or install dependencies');
      assert.ok(!calls.some(item => item.includes('OptionalToDownload')));
    });
  });
}

test('saving replaces only the selected ordinary file after complete hash verification', async () => {
  await temporary(async root => {
    const source = path.join(root, 'cache.jar'), destination = path.join(root, 'chosen.jar');
    await writeFile(source, bytes); await writeFile(destination, 'original');
    await exportCatalogFile(source, destination, metadata);
    assert.deepEqual(await readFile(destination), bytes);
    assert.deepEqual((await readdir(root)).sort(), ['cache.jar', 'chosen.jar']);
  });
});

test('corrupt cached content never overwrites an existing destination or leaves partial files', async () => {
  await temporary(async root => {
    const source = path.join(root, 'cache.jar'), destination = path.join(root, 'chosen.jar');
    await writeFile(source, Buffer.alloc(bytes.length)); await writeFile(destination, 'keep original');
    await assert.rejects(exportCatalogFile(source, destination, metadata), /校验失败/);
    assert.equal(await readFile(destination, 'utf8'), 'keep original');
    assert.deepEqual((await readdir(root)).sort(), ['cache.jar', 'chosen.jar']);
  });
});

test('cancel while saving preserves original destination and removes temporary output', async () => {
  await temporary(async root => {
    const source = path.join(root, 'cache.jar'), destination = path.join(root, 'chosen.jar');
    const large = Buffer.alloc(256 * 1024, 5), controller = new AbortController();
    await writeFile(source, large); await writeFile(destination, 'keep original');
    await assert.rejects(exportCatalogFile(source, destination, { type: 'mod', size: large.length, sha512: createHash('sha512').update(large).digest('hex') }, {
      signal: controller.signal, onProgress: () => controller.abort(),
    }), /取消/);
    assert.equal(await readFile(destination, 'utf8'), 'keep original');
    assert.deepEqual((await readdir(root)).sort(), ['cache.jar', 'chosen.jar']);
  });
});

test('a target changed by another program while saving is preserved', async () => {
  await temporary(async root => {
    const source = path.join(root, 'cache.jar'), destination = path.join(root, 'chosen.jar');
    await writeFile(source, bytes); await writeFile(destination, 'original');
    let changed: Promise<void> | undefined;
    await assert.rejects(exportCatalogFile(source, destination, metadata, { onProgress: () => { changed = writeFile(destination, 'other program data'); } }), /其他程序修改/);
    await changed;
    assert.equal(await readFile(destination, 'utf8'), 'other program data');
    assert.deepEqual((await readdir(root)).sort(), ['cache.jar', 'chosen.jar']);
  });
});

test('invalid extensions and directory targets do not alter unrelated files', async () => {
  await temporary(async root => {
    const source = path.join(root, 'cache.jar'); await writeFile(source, bytes);
    await assert.rejects(exportCatalogFile(source, path.join(root, 'wrong.exe'), metadata), /\.jar/);
    await mkdir(path.join(root, 'folder.jar'));
    await writeFile(path.join(root, 'folder.jar', 'keep.txt'), 'keep');
    await assert.rejects(exportCatalogFile(source, path.join(root, 'folder.jar'), metadata), /普通文件/);
    await assert.rejects(exportCatalogFile(source, source, metadata), /缓存文件本身/);
    assert.equal(await readFile(path.join(root, 'folder.jar', 'keep.txt'), 'utf8'), 'keep');
    assert.deepEqual((await readdir(root)).sort(), ['cache.jar', 'folder.jar']);
  });
});

test('a directory junction as export parent is rejected', async () => {
  await temporary(async root => {
    const source = path.join(root, 'cache.jar'), output = path.join(root, 'output'), linked = path.join(root, 'linked');
    await writeFile(source, bytes); await mkdir(output);
    await symlink(output, linked, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(exportCatalogFile(source, path.join(linked, 'chosen.jar'), metadata), /普通目录/);
    assert.deepEqual(await readdir(output), []);
  });
});
