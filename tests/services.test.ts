import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { inspectClientResources, javaRequirement, neoForgeMetadataVersions, scanInstances } from '../arcane-launcher/src/main/services/instances';
import { parseJavaVersion } from '../arcane-launcher/src/main/services/java';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { forwardLaunchOutput, readInstanceLog, redactSensitiveText } from '../arcane-launcher/src/main/services/logs';

async function fixture(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'arcane-services-test-'));
  try { await run(directory); } finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('arcane-services-test-'));
    await rm(directory, { recursive: true, force: true });
  }
}

async function put(directory: string, relative: string, content = ''): Promise<void> {
  const file = path.join(directory, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, 'utf8');
}

test('live logs hide account secrets separated across stream chunks', async () => {
  const messages: string[] = [];
  const stream = Readable.from(['session-test-', 'secret\nCookie: a=first; b=second\n', 'tail']);
  forwardLaunchOutput(stream, 'session-test-secret', message => messages.push(message));
  await finished(stream);
  assert.deepEqual(messages.map(line => line.trim()), ['[已隐藏]', 'Cookie: [已隐藏]', 'tail']);
});

test('scan separates an isolated Forge instance from shared resources and reports missing dependencies', async () => fixture(async root => {
  await put(root, 'versions/1.20.1/1.20.1.json', JSON.stringify({ id: '1.20.1', mainClass: 'net.minecraft.client.main.Main', javaVersion: { majorVersion: 17 }, libraries: [] }));
  await put(root, 'versions/1.20.1/1.20.1.jar');
  await put(root, 'versions/forge-pack/forge-pack.json', JSON.stringify({ id: 'forge-pack', inheritsFrom: '1.20.1', libraries: [{ name: 'net.minecraftforge:forge:1.20.1-47.3.7', downloads: { artifact: { path: 'net/minecraftforge/forge/1.20.1-47.3.7/forge.jar' } } }] }));
  await put(root, 'versions/forge-pack/mods/create.jar');
  await put(root, 'versions/forge-pack/mods/disabled.jar.disabled');
  await mkdir(path.join(root, 'versions/forge-pack/saves/My World'), { recursive: true });
  const result = await scanInstances([root, root]);
  assert.equal(result.instances.length, 2);
  const forge = result.instances.find(instance => instance.versionId === 'forge-pack')!;
  assert.equal(forge.gameDirectory, path.join(root, 'versions', 'forge-pack'));
  assert.equal(forge.minecraftVersion, '1.20.1');
  assert.equal(forge.loader, 'Forge');
  assert.equal(forge.requiredJavaMajor, 17);
  assert.equal(forge.stats.mods, 1);
  assert.equal(forge.stats.saves, 1);
  assert.equal(forge.status, 'incomplete');
  assert.match(forge.issues.join(' '), /缺少 1 个运行依赖/);
  assert.equal(result.instances.find(instance => instance.versionId === '1.20.1')!.status, 'ready');
}));

test('modern NeoForge version detection uses exact FML arguments and runtime coordinates', async () => fixture(async root => {
  const metadata = { id: 'modern-pack', inheritsFrom: '1.21.1', mainClass: 'cpw.mods.bootstraplauncher.BootstrapLauncher', libraries: [{ name: 'net.neoforged.fancymodloader:loader:4.0.45' }], arguments: { game: ['--fml.neoForgeVersion', '21.1.262', '--fml.fmlVersion', '4.0.45', '--fml.mcVersion', '1.21.1', '--launchTarget', 'forgeclient'] } };
  assert.deepEqual(neoForgeMetadataVersions(metadata), { loaderVersion: '21.1.262', minecraftVersion: '1.21.1' });
  assert.equal(neoForgeMetadataVersions({ ...metadata, libraries: [] }), undefined);
  assert.equal(neoForgeMetadataVersions({ ...metadata, mainClass: 'unrelated.Main' }), undefined);
  assert.equal(neoForgeMetadataVersions({ ...metadata, arguments: { game: [...metadata.arguments.game, '--fml.neoForgeVersion', '21.1.261'] } }), undefined);
  assert.equal(neoForgeMetadataVersions({ ...metadata, arguments: { game: metadata.arguments.game.map(value => value === 'forgeclient' ? 'forgeserver' : value) } }), undefined);
  await put(root, 'versions/1.21.1/1.21.1.json', JSON.stringify({ id: '1.21.1', libraries: [] }));
  await put(root, 'versions/1.21.1/1.21.1.jar');
  await put(root, 'versions/modern-pack/modern-pack.json', JSON.stringify(metadata));
  const result = await scanInstances([root]);
  const modern = result.instances.find(instance => instance.versionId === 'modern-pack')!;
  assert.equal(modern.loader, 'NeoForge');
  assert.equal(modern.loaderVersion, '21.1.262');
  assert.equal(modern.minecraftVersion, '1.21.1');
}));

test('version inheritance cycles and dependency traversal are rejected before launch', async () => fixture(async root => {
  await put(root, 'versions/cycle/cycle.json', JSON.stringify({ inheritsFrom: 'cycle' }));
  await assert.rejects(inspectClientResources(root, 'cycle'), /继承关系循环/);
  await put(root, 'versions/unsafe/unsafe.json', JSON.stringify({ libraries: [{ name: 'test:unsafe:1', downloads: { artifact: { path: '../../../outside.jar' } } }] }));
  await assert.rejects(inspectClientResources(root, 'unsafe'), /超出了实例目录/);
  const result = await scanInstances([root]);
  assert.ok(result.instances.every(instance => instance.status === 'incomplete'));
}));

test('PCL version settings alone do not hide shared root mods or saves', async () => fixture(async root => {
  await put(root, 'versions/shared/shared.json', JSON.stringify({ id: 'shared', libraries: [] }));
  await put(root, 'versions/shared/shared.jar');
  await put(root, 'versions/shared/PCL/Setup.ini', 'VersionArgumentIndie=0\n');
  await put(root, 'mods/shared-mod.jar');
  await mkdir(path.join(root, 'saves', 'Shared World'), { recursive: true });
  const { instances } = await scanInstances([root]);
  assert.equal(instances[0].gameDirectory, root);
  assert.equal(instances[0].stats.mods, 1);
  assert.equal(instances[0].stats.saves, 1);
}));

test('an interrupted managed installation cannot appear ready just because version metadata exists', async () => fixture(async root => {
  await put(root, 'versions/1.20.1/1.20.1.json', JSON.stringify({ id: '1.20.1', libraries: [] }));
  await put(root, 'versions/1.20.1/1.20.1.jar');
  await put(root, '.arcane-installation.json', JSON.stringify({ schemaVersion: 1, versionId: '1.20.1', state: 'failed' }));
  const { instances } = await scanInstances([root]);
  assert.equal(instances[0].status, 'incomplete');
  assert.match(instances[0].issues.join(' '), /安装未成功完成/);
}));

test('a server script without libraries is recognized without running the script', async () => fixture(async root => {
  await put(root, 'run.bat', '@echo off\njava @user_jvm_args.txt @libraries/net/minecraftforge/forge/1.20.1-47.3.7/win_args.txt %*\npause');
  await put(root, 'server.properties', 'motd=Test');
  await put(root, 'eula.txt', 'eula=true\n');
  const result = await scanInstances([root]);
  assert.equal(result.instances.length, 1);
  assert.equal(result.instances[0].kind, 'server');
  assert.equal(result.instances[0].minecraftVersion, '1.20.1');
  assert.equal(result.instances[0].loaderVersion, '47.3.7');
  assert.equal(result.instances[0].status, 'incomplete');
  assert.match(result.instances[0].issues.join(' '), /缺少 Forge 服务端运行依赖/);
}));

test('Java 8 and modern Java versions are parsed with their actual major', () => {
  assert.equal(parseJavaVersion('java version "1.8.0_431"\nJava HotSpot(TM) 64-Bit Server VM')?.major, 8);
  assert.equal(parseJavaVersion('openjdk version "17.0.14" 2025-01-21\n    java.vendor = Eclipse Adoptium\n    os.arch = amd64')?.major, 17);
  assert.equal(parseJavaVersion('openjdk 21.0.6 2025-01-21')?.major, 21);
  assert.equal(parseJavaVersion('this executable is not Java'), undefined);
  assert.equal(javaRequirement('1.20.1'), 17);
  assert.equal(javaRequirement('1.20.5'), 21);
  assert.equal(javaRequirement('1.17.1'), 16);
});

test('log viewer reads a bounded UTF-8 tail and removes tokens and terminal control sequences', async () => fixture(async root => {
  const prefix = '旧日志：中文内容\n'.repeat(500);
  await put(root, 'logs/latest.log', `${prefix}\u001b[31mERROR\u001b[0m --accessToken secret123\nAuthorization: Bearer token456\n{"refresh_token":"refresh789"}\n安全的末行\n`);
  const result = await scanInstances([root]);
  assert.equal(result.instances.length, 0);
  const log = await readInstanceLog({ gameDirectory: root } as never, 1024);
  assert.equal(log.found, true);
  assert.equal(log.truncated, true);
  assert.equal(log.redacted, true);
  assert.ok(log.content.endsWith('安全的末行\n'));
  assert.doesNotMatch(log.content, /secret123|token456|refresh789|\u001b|\uFFFD/);
  assert.match(log.content, /ERROR/);
  assert.doesNotMatch(redactSensitiveText('api_key=abcd password=hunter2'), /abcd|hunter2/);
}));

test('diagnostics redact Xbox headers and complete Microsoft authentication payloads', () => {
  const cases = [
    ['Authorization: XBL3.0 x=123;DUMMY_XSTS_SECRET', 'DUMMY_XSTS_SECRET'],
    ['XBL3.0 x=123;DUMMY_STANDALONE_SECRET', 'DUMMY_STANDALONE_SECRET'],
    ['{"identityToken":"XBL3.0 x=123;DUMMY_IDENTITY_SECRET"}', 'DUMMY_IDENTITY_SECRET'],
    ['{"Token":"DUMMY_XBOX_SECRET"}', 'DUMMY_XBOX_SECRET'],
    ['{"RpsTicket":"d=DUMMY_MICROSOFT_SECRET"}', 'DUMMY_MICROSOFT_SECRET'],
    ['{"device_code":"DUMMY_DEVICE_SECRET"}', 'DUMMY_DEVICE_SECRET'],
    ['{"client_secret":"DUMMY_CLIENT_SECRET"}', 'DUMMY_CLIENT_SECRET'],
    ['--accessToken "DUMMY SECRET WITH SPACES"', 'DUMMY SECRET WITH SPACES'],
    ['Authorization: Bearer DUMMY_BEARER_SECRET', 'DUMMY_BEARER_SECRET'],
  ];
  for (const [input, secret] of cases) {
    const output = redactSensitiveText(input);
    assert.ok(!output.includes(secret), `Authentication data escaped redaction: ${input.split(':')[0]}`);
    assert.match(output, /已隐藏/);
  }
  assert.equal(redactSensitiveText('{"access_token":"DUMMY_SECRET"}'), '{"access_token":"[已隐藏]"}');
  assert.equal(redactSensitiveText('Java 21\n普通中文诊断信息\n'), 'Java 21\n普通中文诊断信息\n');
});

test('log viewer ignores a logs junction instead of reading files outside the selected instance', async () => fixture(async root => {
  const game = path.join(root, 'game'), outside = path.join(root, 'outside');
  await mkdir(game);
  await put(outside, 'latest.log', 'OUTSIDE_FIXTURE_SECRET');
  await symlink(outside, path.join(game, 'logs'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = await readInstanceLog({ gameDirectory: game } as never);
  assert.equal(result.found, false);
  assert.doesNotMatch(result.content, /OUTSIDE_FIXTURE_SECRET/);
}));

test('a crash-reports junction cannot override an ordinary in-instance log', async () => fixture(async root => {
  const game = path.join(root, 'game'), outside = path.join(root, 'outside');
  await put(game, 'logs/latest.log', 'Ordinary current game log\n');
  await put(outside, 'crash-999.txt', 'OUTSIDE_CRASH_SECRET');
  const later = new Date(Date.now() + 60_000);
  await utimes(path.join(outside, 'crash-999.txt'), later, later);
  await symlink(outside, path.join(game, 'crash-reports'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = await readInstanceLog({ gameDirectory: game } as never);
  assert.equal(result.found, true);
  assert.equal(result.path, path.join(game, 'logs', 'latest.log'));
  assert.equal(result.content, 'Ordinary current game log\n');
}));
