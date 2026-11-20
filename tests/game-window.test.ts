import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gameWindowSize, prepareGameWindow, windowedOptions, withoutWindowArguments } from '../arcane-launcher/src/main/services/game-window';

test('fixed 720p window fits smaller work areas with room for window decorations', () => {
  assert.deepEqual(gameWindowSize({ width: 1920, height: 1040 }), { width: 1280, height: 720 });
  for (const area of [{ width: 1366, height: 728 }, { width: 1280, height: 680 }, { width: 800, height: 560 }]) {
    const size = gameWindowSize(area);
    assert.ok(size.width <= area.width - 64 && size.height <= area.height - 96);
    assert.ok(Math.abs(size.width / size.height - 16 / 9) < 0.01);
  }
  assert.deepEqual(gameWindowSize(), { width: 1280, height: 720 });
});

test('inherited and conditional window flags cannot duplicate or override launcher size', () => {
  assert.deepEqual(withoutWindowArguments(['--username', 'Traveler', '--width', '7680', '--fullscreen', { rules: [{ action: 'allow', features: { has_custom_resolution: true } }], value: ['--width', '${resolution_width}', '--height', '${resolution_height}'] }, '--height=4320', '--quickPlaySingleplayer', 'Home']), ['--username', 'Traveler', '--quickPlaySingleplayer', 'Home']);
});

test('window options clear only fullscreen and resolution overrides, including duplicate keys', () => {
  const source = 'music:0.25\r\nfullscreen:true\r\noverrideWidth:7680\r\noverrideHeight:4320\r\nfullscreen:true\r\nresourcePacks:["file/custom.zip"]\r\n';
  assert.equal(windowedOptions(source), 'music:0.25\r\nfullscreen:false\r\noverrideWidth:0\r\noverrideHeight:0\r\nresourcePacks:["file/custom.zip"]\r\n');
  assert.equal(windowedOptions(windowedOptions(source)), windowedOptions(source));
});

test('launch normalization keeps first options backup and all unrelated preferences', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shenbcl-window-'));
  try {
    const options = path.join(root, 'options.txt');
    const original = 'fullscreen:true\noverrideWidth:9999\noverrideHeight:9999\nlang:zh_cn\n';
    await writeFile(options, original);
    await prepareGameWindow(root);
    assert.equal(await readFile(options, 'utf8'), 'fullscreen:false\noverrideWidth:0\noverrideHeight:0\nlang:zh_cn\n');
    assert.equal(await readFile(`${options}.shenbcl-window.bak`, 'utf8'), original);
    await writeFile(options, 'fullscreen:true\nlang:en_us\n');
    await prepareGameWindow(root);
    assert.equal(await readFile(`${options}.shenbcl-window.bak`, 'utf8'), original);
    assert.match(await readFile(options, 'utf8'), /lang:en_us/);
    assert.equal((await readdir(root)).some(name => name.endsWith('.tmp')), false);
  } finally {
    assert.equal(path.dirname(root), os.tmpdir());
    assert.ok(path.basename(root).startsWith('shenbcl-window-'));
    await rm(root, { recursive: true, force: true });
  }
});

test('first launch preserves pack default options from YOSBR without changing its template', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shenbcl-window-'));
  try {
    const template = path.join(root, 'config', 'yosbr', 'options.txt');
    await mkdir(path.dirname(template), { recursive: true });
    const defaults = 'fullscreen:true\nlang:zh_cn\nkey_key.forward:key.keyboard.z\nresourcePacks:["file/pack.zip"]\n';
    await writeFile(template, defaults);
    await prepareGameWindow(root);
    const actual = await readFile(path.join(root, 'options.txt'), 'utf8');
    assert.match(actual, /fullscreen:false/);
    assert.match(actual, /lang:zh_cn/);
    assert.match(actual, /key_key.forward:key.keyboard.z/);
    assert.match(actual, /resourcePacks:\["file\/pack.zip"\]/);
    assert.equal(await readFile(template, 'utf8'), defaults);
  } finally {
    assert.equal(path.dirname(root), os.tmpdir());
    assert.ok(path.basename(root).startsWith('shenbcl-window-'));
    await rm(root, { recursive: true, force: true });
  }
});
