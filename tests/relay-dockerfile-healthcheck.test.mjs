import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');

function readProjectFile(path) {
  return readFileSync(resolve(root, path), 'utf8');
}

test('Relay healthcheck probes 127.0.0.1 (not localhost) so the IPv4 bind is reachable', () => {
  const dockerfile = readProjectFile('Dockerfile.relay');

  // localhost resolves to ::1 first, but the relay binds IPv4 (or dual-stack
  // without an IPv6 loopback), so a localhost probe gets "connection refused".
  assert.match(dockerfile, /HEALTHCHECK[\s\S]*wget -qO- http:\/\/127\.0\.0\.1:3004\/health/);
  assert.doesNotMatch(dockerfile, /HEALTHCHECK[\s\S]*wget -qO- http:\/\/localhost:3004\/health/);
});
