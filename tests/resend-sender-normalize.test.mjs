import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { normalizeResendSender } = require('../scripts/lib/resend-from.cjs');

const silent = () => {};

test('returns null for empty, null, undefined, or whitespace-only input', () => {
  assert.equal(normalizeResendSender(null, 'WorldMonitor', silent), null);
  assert.equal(normalizeResendSender(undefined, 'WorldMonitor', silent), null);
  assert.equal(normalizeResendSender('', 'WorldMonitor', silent), null);
  assert.equal(normalizeResendSender('   ', 'WorldMonitor', silent), null);
});

test('passes a properly wrapped sender through unchanged', () => {
  assert.equal(
    normalizeResendSender('WorldMonitor <alerts@example.test>', 'Default', silent),
    'WorldMonitor <alerts@example.test>',
  );
  assert.equal(
    normalizeResendSender('WorldMonitor Brief <brief@example.test>', 'Default', silent),
    'WorldMonitor Brief <brief@example.test>',
  );
});

test('trims surrounding whitespace before returning a wrapped sender', () => {
  assert.equal(
    normalizeResendSender('  WorldMonitor Brief <brief@example.test>  ', 'Default', silent),
    'WorldMonitor Brief <brief@example.test>',
  );
});

test('wraps a bare email address with the supplied default display name', () => {
  assert.equal(
    normalizeResendSender('brief@example.test', 'WorldMonitor Brief', silent),
    'WorldMonitor Brief <brief@example.test>',
  );
  assert.equal(
    normalizeResendSender('alerts@example.test', 'WorldMonitor Alerts', silent),
    'WorldMonitor Alerts <alerts@example.test>',
  );
});

test('emits exactly one warning when coercing a bare address', () => {
  const warnings = [];
  normalizeResendSender('brief@example.test', 'WorldMonitor Brief', (m) => warnings.push(m));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /lacks display name/);
  assert.match(warnings[0], /WorldMonitor Brief <brief@example\.test>/);
});

test('does not warn when the value already has a display-name wrapper', () => {
  const warnings = [];
  normalizeResendSender(
    'WorldMonitor Brief <brief@example.test>',
    'Default',
    (m) => warnings.push(m),
  );
  assert.equal(warnings.length, 0);
});

test('defaults to console.warn when no warning sink is supplied', () => {
  const original = console.warn;
  const captured = [];
  console.warn = (m) => captured.push(m);
  try {
    normalizeResendSender('bare@example.com', 'Name');
    assert.equal(captured.length, 1);
    assert.match(captured[0], /lacks display name/);
  } finally {
    console.warn = original;
  }
});
