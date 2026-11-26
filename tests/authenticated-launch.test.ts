import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { detectJava } from '../arcane-launcher/src/main/services/java';
import { scanInstances } from '../arcane-launcher/src/main/services/instances';
import { prepareLaunch, launchInstance } from '../arcane-launcher/src/main/services/launch';
import { launchTestAccount } from './verified-account';
import { assertGameIdentity } from '../arcane-launcher/src/main/services/account';

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
    const settings = { roots: [root], javaPath: java.path, memoryMb: 1024, closeOnLaunch: false };
    const account = launchTestAccount();
    const identity = await account.service.requireGameIdentity();
    const [client] = scan.instances;
    const server = { ...client, kind: 'server' as const };
    for (const instance of [client, server]) {
      await assert.rejects(prepareLaunch(instance, settings, installed), /启动前请登录/);
      await assert.rejects(launchInstance(instance, settings, installed, { ...identity }), /启动前请登录/);
    }
    await assert.rejects(prepareLaunch(server, settings, installed, identity), /server\.properties/);
    await writeFile(path.join(root, 'server.properties'), 'online-mode=false\n');
    await assert.rejects(prepareLaunch(server, settings, installed, identity), /online-mode=true/);
    const plan = await prepareLaunch(client, settings, installed, identity);
    const value = (flag: string) => plan.args[plan.args.indexOf(flag) + 1];
    assert.equal(value('--username'), 'OfficialPlayer');
    assert.equal(value('--uuid'), identity.id);
    assert.equal(value('--userType'), 'msa');
    assert.equal(value('--clientId'), identity.clientId);
    assert.equal(value('--xuid'), identity.xuid);
    assert.equal(value('--accessToken'), '[已隐藏]');
    assert.doesNotMatch(JSON.stringify(plan), /do-not-expose-this-secret|\$\{/);
    assert.equal(plan.warnings.length, 0);
    const manifest = path.join(versionRoot, 'test-auth.json');
    const version = JSON.parse(await readFile(manifest, 'utf8'));
    version.arguments.game.push('--accessToken', '0');
    await writeFile(manifest, JSON.stringify(version));
    await assert.rejects(prepareLaunch(client, settings, installed, identity), /覆盖了 Minecraft 登录参数/);
    version.arguments.game.splice(-2);
    version.arguments.jvm.push('-Dminecraft.api.session.host=https://example.invalid');
    await writeFile(manifest, JSON.stringify(version));
    await assert.rejects(prepareLaunch(client, settings, installed, identity), /认证覆盖/);
  } finally {
    assert.equal(path.dirname(root), os.tmpdir());
    assert.ok(path.basename(root).startsWith('shenbcl-auth-launch-'));
    await rm(root, { recursive: true, force: true });
  }
});

test('ownership is checked for each launch and denied or revoked sessions cannot issue game access', async () => {
  const account = launchTestAccount();
  const identity = await account.service.requireGameIdentity();
  const latest = await account.service.requireGameIdentity();
  assert.equal(account.entitlementChecks(), 2);
  assert.throws(() => assertGameIdentity(identity), /在线验证/);
  assert.doesNotThrow(() => assertGameIdentity(latest));
  await account.service.logout();
  assert.throws(() => assertGameIdentity(latest), /在线验证/);
  await assert.rejects(account.service.requireGameIdentity(), /启动前请登录/);
  await assert.rejects(launchTestAccount({ owned: false }).service.requireGameIdentity(), /未返回 Minecraft Java 版所有权/);
  await assert.rejects(launchTestAccount({ allowed: false }).service.requireGameIdentity(), /应用审批状态/);
  await assert.rejects(launchTestAccount({ expiresIn: 0 }).service.requireGameIdentity(), /认证响应不完整/);
});
