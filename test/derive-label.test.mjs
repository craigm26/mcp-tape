import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveLabel } from '../dist/proxy.js';

test('plain node script uses script basename', () => {
  assert.equal(deriveLabel(['node', '/opt/server.js']), 'server-js');
});

test('npx + package name uses the package name', () => {
  assert.equal(deriveLabel(['npx', '-y', 'mcp-remote']), 'mcp-remote');
});

test('skips header-value args containing whitespace (no secret in label)', () => {
  // Synthetic key shape (no real bytes) — mirrors the kind of value users
  // commonly pass via `--header`. The point is that any arg containing
  // whitespace is rejected before its content can land in the filename.
  const FAKE_KEY = 'FAKE-NOT-A-REAL-KEY-0000000000000000000000';
  const cmd = [
    'npx', '-y', 'mcp-remote',
    'https://example.test/mcp',
    '--header',
    `X-Goog-Api-Key: ${FAKE_KEY}`,
  ];
  const label = deriveLabel(cmd);
  // The URL is the last non-whitespace arg; split('/').pop() yields 'mcp'.
  assert.equal(label, 'mcp');
  // No part of the header value (real or fake) leaks into the label.
  assert.equal(label.toLowerCase().includes('fake'), false);
  assert.equal(label.toLowerCase().includes('api-key'), false);
});

test('skips env-var-style args containing equals signs only when whitespace present', () => {
  // No whitespace — env-style is allowed (e.g., `KEY=value` packaged as one arg).
  assert.equal(deriveLabel(['node', 'KEY=value']), 'key-value');
  // With whitespace it gets skipped.
  assert.equal(deriveLabel(['node', 'KEY = value']), 'mcp');
});

test('falls back to mcp when every arg is skipped', () => {
  assert.equal(deriveLabel(['npx', '-y', '--']), 'mcp');
});

test('label is truncated to 32 characters', () => {
  const long = 'a'.repeat(100);
  const label = deriveLabel(['node', long]);
  assert.ok(label.length <= 32);
});
