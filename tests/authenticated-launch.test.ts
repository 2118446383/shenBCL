import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { detectJava } from '../arcane-launcher/src/main/services/java';
import { scanInstances } from '../arcane-launcher/src/main/services/instances';
import { prepareLaunch } from '../arcane-launcher/src/main/services/launch';

test('real XMCL launch plan resolves Microsoft identity fields and redacts the entire returned plan', async context => {
  const installed = await detectJava();
  const java = installed.find(item => item.major >= 17);
  if (!java) { context.skip('No compatible Java installed for integration fixture'); return; }
  const root = await mkdtemp(path.join(os.tmpdir(), 'shenbcl-auth-launch-'));
  try {
    const versionRoot = path.join(root, 'versions', 'test-auth');
    await mkdir(versionRoot, { recursive: true });
    await writeFile(path.join(versionRoot, 'test-auth.jar'), 'fixture-not-executed');
    await writeFile(path.join(versionRoot, 'test-auth.json'), JSON.stringify({ id: 'test-auth', type: 'release', mainClass: 'net.minecraft.client.main.Main', javaVersion: { majorVersion: java.major }, libraries: [], arguments: { jvm: ['-cp', '${classpath}'], game: ['--username', '${auth_player_name}', '--uuid', '${auth_uuid}', '--accessToken', '${auth_access_token}', '--userType', '${user_type}', '--clientId', '${clientid}', '--xuid', '${auth_xuid}'] } }));
    const scan = await scanInstances([root]);
    assert.equal(scan.instances.length, 1);
    const identity = { id: 'b'.repeat(32), name: 'OfficialPlayer', accessToken: 'do-not-expose-this-secret', clientId: '11111111-2222-3333-4444-555555555555', xuid: '1234567890' };
    const plan = await prepareLaunch(scan.instances[0], { roots: [root], playerName: 'LocalPlayer', javaPath: java.path, memoryMb: 1024, closeOnLaunch: false }, installed, identity);
    const value = (flag: string) => plan.args[plan.args.indexOf(flag) + 1];
    assert.equal(value('--username'), 'OfficialPlayer');
    assert.equal(value('--uuid'), identity.id);
    assert.equal(value('--userType'), 'msa');
    assert.equal(value('--clientId'), identity.clientId);
    assert.equal(value('--xuid'), identity.xuid);
    assert.equal(value('--accessToken'), '[已隐藏]');
    assert.doesNotMatch(JSON.stringify(plan), /do-not-expose-this-secret|\$\{/);
    assert.equal(plan.warnings.length, 0);
  } finally {
    assert.equal(path.dirname(root), os.tmpdir());
    assert.ok(path.basename(root).startsWith('shenbcl-auth-launch-'));
    await rm(root, { recursive: true, force: true });
  }
});
