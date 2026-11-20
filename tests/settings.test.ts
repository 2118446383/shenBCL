import test from 'node:test'
import assert from 'node:assert/strict'
import { reactive, isProxy } from 'vue'
import { toSettingsPayload } from '../arcane-launcher/src/renderer/settings-payload'

test('reactive settings become a plain, cloneable IPC payload without changing the form', () => {
  const form = reactive({ roots: ['D:\\世界'], javaPath: '', memoryMb: 6144, playerName: 'Traveler', closeOnLaunch: false })
  assert.equal(isProxy(form.roots), true)
  const payload = toSettingsPayload(form)
  assert.deepEqual(structuredClone(payload), { roots: ['D:\\世界'], javaPath: '', memoryMb: 6144, playerName: 'Traveler', closeOnLaunch: false })
  payload.roots.push('D:\\another')
  assert.equal(form.roots.length, 1)
})
