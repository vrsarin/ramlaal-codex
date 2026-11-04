import assert from 'node:assert/strict'
import test from 'node:test'
import { onboardingComplete, storedOnboardingComplete } from './onboarding-status.mjs'

const names = ['user', 'core_config', 'analytics', 'integration']
test('onboarding completion requires each managed step', () => {
  assert(onboardingComplete(names.map((step) => ({ step, done: true }))))
  assert(!onboardingComplete(names.map((step) => ({ step, done: step !== 'user' }))))
  assert(!onboardingComplete([...names.map((step) => ({ step, done: true })), { step: 'future', done: false }]))
  assert.throws(() => onboardingComplete([]), /missing/)
  assert.throws(() => onboardingComplete([...names.map((step) => ({ step, done: true })), { step: 'user', done: true }]), /duplicated/)
  assert(storedOnboardingComplete(names))
  assert(!storedOnboardingComplete([]))
  assert.throws(() => storedOnboardingComplete({}), /invalid/)
  assert.throws(() => storedOnboardingComplete([...names, 'user']), /invalid/)
})
