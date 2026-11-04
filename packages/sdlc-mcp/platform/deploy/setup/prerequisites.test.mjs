import assert from 'node:assert/strict'
import test from 'node:test'
import { supportsComposeOverride } from './prerequisites.mjs'

test('requires a Compose release that supports !override', () => {
  for (const version of ['2.24.4', 'v2.24.5-desktop.1', '2.30.0', '5.6.1']) assert(supportsComposeOverride(version))
  for (const version of ['2.24.3', '2.23.9', '1.29.2', 'unknown']) assert(!supportsComposeOverride(version))
})
