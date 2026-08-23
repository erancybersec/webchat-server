import { describe, expect, it } from 'vitest';
import { EvolutionClient } from '../src/services/evolution.js';

const cfg = { base: 'https://evo.test', instance: 'T', apikey: 'k' };

describe('EvolutionClient', () => {
  it('aborts a hung request after the timeout instead of stalling forever', async () => {
    const hangingFetch = ((_url: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
      })) as typeof fetch;

    const client = new EvolutionClient(cfg, hangingFetch, 20);
    await expect(client.call('/chat/findChats/T', {})).rejects.toThrow(/timed out/);
  });

  it('passes through normal responses', async () => {
    const okFetch = (async () =>
      new Response('{"ok":true}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;

    const client = new EvolutionClient(cfg, okFetch);
    const r = await client.call('/chat/findChats/T', {});
    expect(r).toMatchObject({ status: 200, ok: true, text: '{"ok":true}' });
  });

  it('serializes a body on DELETE when given (deleteMessageForEveryone) but not when omitted', async () => {
    const seen: Array<{ method?: string; body?: unknown }> = [];
    const spyFetch = (async (_url: unknown, init?: RequestInit) => {
      seen.push({ method: init?.method, body: init?.body });
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const client = new EvolutionClient(cfg, spyFetch);

    await client.call('/chat/deleteMessageForEveryone/T', { id: 'M', remoteJid: 'r', fromMe: true }, 'DELETE');
    expect(seen[0]).toEqual({ method: 'DELETE', body: JSON.stringify({ id: 'M', remoteJid: 'r', fromMe: true }) });

    await client.call('/group/leaveGroup/T', undefined, 'DELETE'); // bodyless DELETE stays bodyless
    expect(seen[1]).toEqual({ method: 'DELETE', body: undefined });

    await client.call('/chat/findChats/T', {}); // POST still defaults to '{}'
    expect(seen[2]).toEqual({ method: 'POST', body: '{}' });
  });
});
