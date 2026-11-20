import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeAccountPreferences } from '../arcane-launcher/src/main/services/account-preferences';

const clientId = 'abcdef01-2345-6789-abcd-ef0123456789';
function preview(width = 64, height = 64) {
  const bytes = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.write('IHDR', 12); bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20);
  return `data:image/png;base64,${bytes.toString('base64')}`;
}

test('corrupt account preference shapes cannot prevent startup', () => {
  for (const value of [null, undefined, false, 42, 'bad', [], [clientId], new Date(), new String(clientId)]) {
    assert.deepEqual(sanitizeAccountPreferences(value), { clientId: '' });
  }
  assert.deepEqual(sanitizeAccountPreferences({ clientId: null, localSkin: {} }), { clientId: '' });
});

test('account preferences normalize only public GUIDs and keep independent valid skin fields', () => {
  assert.deepEqual(sanitizeAccountPreferences({ clientId: ` ${clientId.toUpperCase()} `, ignored: 'not retained' }), { clientId });
  const localSkin = preview();
  assert.deepEqual(sanitizeAccountPreferences({ clientId: 'not-a-guid', localSkin }), { clientId: '', localSkin });
  assert.deepEqual(sanitizeAccountPreferences({ clientId, localSkin: preview(64, 32) }), { clientId, localSkin: preview(64, 32) });
});

test('non-PNG, noncanonical and oversized previews are discarded without losing the application ID', () => {
  const valid = preview();
  const invalid = [
    null, {}, [], 'https://textures.minecraft.net/texture/' + 'a'.repeat(64),
    'data:image/svg+xml;base64,' + Buffer.from('<svg/>').toString('base64'),
    'data:image/png;base64,' + Buffer.from('not a PNG').toString('base64'),
    valid + 'A', valid.replace(';base64,', ';base64, '),
    'data:image/png;base64,' + 'A'.repeat(1_400_000), preview(8000, 8000),
  ];
  for (const localSkin of invalid) assert.deepEqual(sanitizeAccountPreferences({ clientId, localSkin }), { clientId });
});

test('preference sanitization never invokes accessors or accepts inherited identities', () => {
  let reads = 0;
  const value = Object.defineProperties({}, {
    clientId: { get: () => { reads++; throw new Error('must not execute'); } },
    localSkin: { get: () => { reads++; throw new Error('must not execute'); } },
  });
  assert.deepEqual(sanitizeAccountPreferences(value), { clientId: '' });
  assert.equal(reads, 0);
  assert.deepEqual(sanitizeAccountPreferences(Object.create({ clientId, localSkin: preview() })), { clientId: '' });
  assert.deepEqual(sanitizeAccountPreferences(Object.assign(Object.create(null), { clientId })), { clientId });
  assert.deepEqual(sanitizeAccountPreferences(new Proxy({}, { getPrototypeOf() { throw new Error('corrupt object'); } })), { clientId: '' });
});
