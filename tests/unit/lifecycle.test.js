import { describe, it } from 'node:test';
import assert from 'node:assert';
import { Leases, LEASE_TTL_MS, UNCLAIMED_MS, tokenId } from '../../packages/anb-orchestrator/dist/routes/lifecycle.js';

describe('server lifetime leases', () => {
  it('exits when no app ever claims the server', () => {
    const l = new Leases(0);
    assert.strictEqual(l.idle(UNCLAIMED_MS - 1), false);
    assert.strictEqual(l.idle(UNCLAIMED_MS + 1), true);
  });

  it('stays while leases keep arriving and exits after they stop', () => {
    const l = new Leases(0);
    l.touch('a', 1000);
    assert.strictEqual(l.idle(1000 + LEASE_TTL_MS - 1), false);
    l.touch('a', 60_000);
    assert.strictEqual(l.idle(60_000 + LEASE_TTL_MS - 1), false);
    assert.strictEqual(l.idle(60_000 + LEASE_TTL_MS + 1), true, 'app crashed: lease expired');
  });

  it('exits a few seconds after the last app releases, not while another holds it', () => {
    const l = new Leases(0);
    l.touch('a', 1000);
    l.touch('b', 1000);
    l.release('a', 2000);
    assert.strictEqual(l.idle(10_000), false, 'b still holds it');
    l.release('b', 20_000);
    assert.strictEqual(l.idle(21_000), false);
    assert.strictEqual(l.idle(26_000), true);
  });

  it('token id is a short fingerprint', () => {
    assert.match(tokenId('x'.repeat(64)), /^[0-9a-f]{16}$/);
    assert.strictEqual(tokenId(null), null);
  });
});
