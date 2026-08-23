import { describe, expect, it } from 'vitest';
import { EventRelay } from '../src/services/events.js';

const cfg = { base: '', instance: 'Test', apikey: 'k', enabled: false };

describe('EventRelay', () => {
  it('fans out events to every subscriber', () => {
    const relay = new EventRelay(cfg, () => {});
    const seen: string[] = [];
    relay.subscribe((e) => seen.push(`a:${e.event}`));
    relay.subscribe((e) => seen.push(`b:${e.event}`));
    relay.broadcast({ event: 'MESSAGES_UPSERT', data: { id: 1 } });
    expect(seen).toEqual(['a:MESSAGES_UPSERT', 'b:MESSAGES_UPSERT']);
  });

  it('unsubscribe stops delivery', () => {
    const relay = new EventRelay(cfg, () => {});
    const seen: string[] = [];
    const unsub = relay.subscribe((e) => seen.push(e.event));
    relay.broadcast({ event: 'one', data: null });
    unsub();
    relay.broadcast({ event: 'two', data: null });
    expect(seen).toEqual(['one']);
    expect(relay.clientCount).toBe(0);
  });

  it('one failing subscriber does not break the rest', () => {
    const relay = new EventRelay(cfg, () => {});
    const seen: string[] = [];
    relay.subscribe(() => {
      throw new Error('boom');
    });
    relay.subscribe((e) => seen.push(e.event));
    relay.broadcast({ event: 'ok', data: null });
    expect(seen).toEqual(['ok']);
  });

  it('does not connect upstream when disabled or unconfigured', () => {
    const relay = new EventRelay(cfg, () => {});
    relay.start(); // base='' + enabled=false → no socket, no throw
    relay.stop();
    expect(relay.clientCount).toBe(0);
    expect(relay.upstreamActive).toBe(false);
  });

  it('reconfigure starts the upstream once Evolution becomes configured', () => {
    // boot with no base (start() no-ops), then the operator fills in Settings
    const relay = new EventRelay({ base: '', instance: 'T', apikey: 'k', enabled: true }, () => {});
    relay.start();
    expect(relay.upstreamActive).toBe(false);
    relay.reconfigure({ base: 'http://127.0.0.1:9', instance: 'T', apikey: 'k' });
    expect(relay.upstreamActive).toBe(true);
    relay.stop();
  });

  it('reconfigure still honors enabled=false', () => {
    const relay = new EventRelay({ base: '', instance: 'T', apikey: 'k', enabled: false }, () => {});
    relay.reconfigure({ base: 'http://127.0.0.1:9', instance: 'T', apikey: 'k' });
    expect(relay.upstreamActive).toBe(false);
  });
});
