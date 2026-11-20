import assert from 'node:assert/strict';
import test from 'node:test';
import { assessGameDirectoryUsage, normalizeWindowsGameDirectory, parseJavaGameDirectories, probeGameDirectoryUsage } from '../arcane-launcher/src/main/services/game-process-probe';

const output = (command: string | null, pid = 123) => JSON.stringify([{ ProcessId: pid, CommandLine: command }]);
const command = String.raw`"C:\Program Files\Java\bin\javaw.exe" -Xmx6144M net.minecraft.client.main.Main --gameDir "D:\Minecraft Games\整合包" --accessToken synthetic-private-token --username Fixture`;

test('process parsing retains only the quoted absolute game directory and discards credentials', () => {
  const parsed = parseJavaGameDirectories(output(command));
  assert.deepEqual(parsed, { directories: [String.raw`d:\minecraft games\整合包`], uncertain: false });
  assert.equal(JSON.stringify(parsed).includes('synthetic-private-token'), false);
  assert.equal(assessGameDirectoryUsage(parsed, ['D:/Minecraft Games/整合包/']), 'running');
});

test('absolute Windows game paths normalize drive case, separators, dot segments and UNC aliases', () => {
  assert.equal(normalizeWindowsGameDirectory('D:/Games/Other/../Pack/'), String.raw`d:\games\pack`);
  assert.equal(normalizeWindowsGameDirectory(String.raw`\\?\D:\Games\Pack`), String.raw`d:\games\pack`);
  assert.equal(normalizeWindowsGameDirectory(String.raw`\\?\UNC\Server\Share\Pack`), String.raw`\\server\share\pack`);
  assert.equal(normalizeWindowsGameDirectory('D:Games/Pack'), undefined);
  assert.equal(normalizeWindowsGameDirectory('/Games/Pack'), undefined);
  assert.equal(normalizeWindowsGameDirectory(String.raw`\\.\pipe\game`), undefined);
  const equals = parseJavaGameDirectories(output(String.raw`java.exe Main --gameDir=D:/Games/Pack`));
  assert.equal(assessGameDirectoryUsage(equals, [String.raw`d:\games\pack`]), 'running');
});

test('directory matching checks boundaries and covers isolated versions inside the managed root', () => {
  const parsed = parseJavaGameDirectories(output(String.raw`javaw.exe Main --gameDir "D:\Games\Pack2"`));
  assert.equal(assessGameDirectoryUsage(parsed, [String.raw`D:\Games\Pack`]), 'clear');
  const isolated = parseJavaGameDirectories(output(String.raw`javaw.exe Main --gameDir "D:\Games\Pack\versions\1.20.1"`));
  assert.equal(assessGameDirectoryUsage(isolated, [String.raw`D:\Games\Pack`]), 'running');
  assert.equal(assessGameDirectoryUsage(parsed, []), 'uncertain');
});

test('inaccessible, malformed, ambiguous or argument-file Java processes fail closed', () => {
  for (const value of [
    output(null), output(''), output('java.exe -jar server.jar'),
    output(String.raw`java.exe Main --gameDir relative/path`),
    output(String.raw`java.exe Main --gameDir "D:\Games\Pack`),
    output(String.raw`java.exe Main --gameDir D:/Games/A --gameDir D:/Games/B`),
    output(String.raw`java.exe @D:\private-arguments.txt`),
    JSON.stringify({ ProcessId: 0, CommandLine: command }), 'null', 'not-json',
  ]) assert.equal(parseJavaGameDirectories(value).uncertain, true);
  const override = parseJavaGameDirectories(output(String.raw`java.exe @D:\arguments.txt Main --gameDir D:/Games/Pack`));
  assert.equal(override.uncertain, true);
  assert.equal(assessGameDirectoryUsage(override, ['D:/Games/Pack']), 'running');
});

test('empty and singleton CIM results are accepted without retaining unrelated command arguments', () => {
  assert.deepEqual(parseJavaGameDirectories('[]'), { directories: [], uncertain: false });
  const singleton = parseJavaGameDirectories(JSON.stringify({ ProcessId: 321, CommandLine: command }));
  assert.equal(singleton.uncertain, false);
  assert.equal(singleton.directories.length, 1);
  const trailing = parseJavaGameDirectories(output(String.raw`java.exe Main --gameDir "D:\Games\Pack\\"`));
  assert.deepEqual(trailing.directories, [String.raw`d:\games\pack`]);
});

test('probe checks canonical paths so short names and directory aliases cannot bypass a running game', async () => {
  const result = await probeGameDirectoryUsage(['D:/Games/Pack'], {
    platform: 'win32', query: async () => output(String.raw`javaw.exe Main --gameDir D:/MCGame~1`),
    canonicalize: async directory => /mcgame~1/i.test(directory) ? 'D:/Games/Pack' : directory,
  });
  assert.equal(result, 'running');
});

test('failed/unsupported process queries never expose errors and never authorize physical removal', async () => {
  let queried = false;
  const query = async (): Promise<string> => { queried = true; throw new Error('synthetic-private-query-output'); };
  assert.equal(await probeGameDirectoryUsage(['D:/Games/Pack'], { platform: 'linux', query }), 'uncertain');
  assert.equal(queried, false);
  assert.equal(await probeGameDirectoryUsage(['D:/Games/Pack'], { platform: 'win32', query }), 'uncertain');
  assert.equal(await probeGameDirectoryUsage(['D:/Games/Pack'], {
    platform: 'win32', query: async () => '[]', canonicalize: async () => { throw new Error('missing directory'); },
  }), 'uncertain');
});

test('probe reports a clear completed query and prioritizes a known running match over uncertain rows', async () => {
  assert.equal(await probeGameDirectoryUsage(['D:/Games/Pack'], {
    platform: 'win32', query: async () => '[]', canonicalize: async value => value,
  }), 'clear');
  assert.equal(await probeGameDirectoryUsage(['D:/Minecraft Games/整合包'], {
    platform: 'win32', query: async () => JSON.stringify([{ ProcessId: 1, CommandLine: null }, { ProcessId: 2, CommandLine: command }]), canonicalize: async value => value,
  }), 'running');
});
