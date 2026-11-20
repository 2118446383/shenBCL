import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gameWindowSize } from '../arcane-launcher/src/main/services/game-window';
import { scanInstances } from '../arcane-launcher/src/main/services/instances';
import { detectJava } from '../arcane-launcher/src/main/services/java';
import { prepareLaunch } from '../arcane-launcher/src/main/services/launch';
import type { JavaInstallation, LauncherInstance, LauncherSettings } from '../arcane-launcher/src/shared/contracts';

const options = 'fullscreen:true\r\noverrideWidth:7680\r\noverrideHeight:4320\r\nlang:zh_cn\r\nresourcePacks:["file/keep.zip"]\r\n';

async function withClient(java: JavaInstallation, legacy: boolean, run: (root: string, instance: LauncherInstance, settings: LauncherSettings) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shenbcl-window-launch-'));
  try {
    const baseId = 'window-test-base';
    const childId = 'window-test-child';
    const baseRoot = path.join(root, 'versions', baseId);
    const childRoot = path.join(root, 'versions', childId);
    await mkdir(baseRoot, { recursive: true });
    await mkdir(childRoot, { recursive: true });
    await writeFile(path.join(baseRoot, `${baseId}.jar`), 'fixture-only-never-executed');
    await writeFile(path.join(baseRoot, `${baseId}.json`), JSON.stringify({
      id: baseId, type: 'release', mainClass: 'net.minecraft.client.main.Main', javaVersion: { majorVersion: java.major }, libraries: [],
      ...(legacy ? {
        minecraftArguments: '--username ${auth_player_name} --uuid ${auth_uuid} --accessToken ${auth_access_token} --userType ${user_type} --width 8192 --height=4320 --fullscreen --fixture-base kept',
      } : {
        arguments: { jvm: ['-cp', '${classpath}'], game: [
          '--username', '${auth_player_name}', '--uuid', '${auth_uuid}', '--accessToken', '${auth_access_token}', '--userType', '${user_type}',
          '--width', '8192', '--fullscreen', '--fixture-base', 'kept',
          { rules: [{ action: 'allow', features: { has_custom_resolution: true } }], value: ['--width', '${resolution_width}', '--height', '${resolution_height}'] },
        ] },
      }),
    }));
    await writeFile(path.join(childRoot, `${childId}.json`), JSON.stringify({
      id: childId, inheritsFrom: baseId, type: 'release', mainClass: 'net.minecraft.client.main.Main', libraries: [],
      ...(legacy ? { minecraftArguments: '--height 4096 --width=7680 --fullscreen --fixture-child kept' } : {
        arguments: { game: ['--height', '4096', '--width=7680', '--fullscreen=true', '--fixture-child', 'kept'] },
      }),
    }));
    await writeFile(path.join(root, 'options.txt'), options);
    const scan = await scanInstances([root]);
    const instance = scan.instances.find(item => item.versionId === childId);
    assert.ok(instance, 'the inherited fixture must be recognized as a client');
    const settings = { roots: [root], playerName: 'LocalPlayer', javaPath: java.path, memoryMb: 1024, closeOnLaunch: false };
    await run(root, instance, settings);
  } finally {
    assert.equal(path.dirname(root), os.tmpdir());
    assert.ok(path.basename(root).startsWith('shenbcl-window-launch-'));
    await rm(root, { recursive: true, force: true });
  }
}

function assertSize(args: string[], width: number, height: number): void {
  for (const [flag, value] of [['--width', width], ['--height', height]] as const) {
    assert.equal(args.filter(argument => argument === flag).length, 1, `${flag} must appear exactly once`);
    assert.equal(args[args.indexOf(flag) + 1], String(value));
  }
  assert.equal(args.some(argument => /^--(?:width|height)=/.test(argument)), false);
  assert.equal(args.some(argument => /^--fullscreen(?:=|$)/.test(argument)), false);
  assert.doesNotMatch(args.join(' '), /8192|7680|4320|4096|\$\{/);
  assert.ok(args.includes('--fixture-child'));
}

test('real XMCL normalizes inherited and conditional window flags without changing saved options during preflight', async context => {
  const installed = await detectJava();
  const java = installed.find(item => item.major >= 17);
  if (!java) { context.skip('No Java available for argument-generation fixture'); return; }
  await withClient(java, false, async (root, instance, settings) => {
    const files = await readdir(root);
    const originalVersion = await readFile(path.join(root, 'versions', 'window-test-child', 'window-test-child.json'), 'utf8');
    const first = await prepareLaunch(instance, settings, installed);
    assertSize(first.args, 1280, 720);
    assert.ok(first.args.includes('--fixture-base'));
    const small = gameWindowSize({ width: 800, height: 560 });
    assert.ok(small.width + 64 <= 800 && small.height + 96 <= 560);
    assert.ok(Math.abs(small.width / small.height - 16 / 9) < 0.01);
    const second = await prepareLaunch(instance, settings, installed, undefined, small);
    assertSize(second.args, small.width, small.height);
    assert.equal(await readFile(path.join(root, 'options.txt'), 'utf8'), options);
    assert.equal(await readFile(path.join(root, 'versions', 'window-test-child', 'window-test-child.json'), 'utf8'), originalVersion);
    assert.deepEqual(await readdir(root), files, 'preflight must not create backup, native or temporary files');
  });
});

test('real XMCL normalizes legacy argument strings and keeps preflight read only', async context => {
  const installed = await detectJava();
  const java = installed.find(item => item.major >= 17);
  if (!java) { context.skip('No Java available for argument-generation fixture'); return; }
  await withClient(java, true, async (root, instance, settings) => {
    const files = await readdir(root);
    const plan = await prepareLaunch(instance, settings, installed);
    assertSize(plan.args, 1280, 720);
    assert.equal(await readFile(path.join(root, 'options.txt'), 'utf8'), options);
    assert.deepEqual(await readdir(root), files);
  });
});
