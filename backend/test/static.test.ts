import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeApp, type TestApp } from './helpers.js';

describe('frontend serving', () => {
  let t: TestApp;
  let dir: string;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webchat-static-'));
    fs.writeFileSync(path.join(dir, 'index.html'), '<html><body><h1>UI</h1></body></html>');
    t = await makeApp({ staticDir: dir });
  });
  afterEach(async () => {
    await t.app.close();
    t.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('serves index.html verbatim with revalidation caching', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('<html><body><h1>UI</h1></body></html>');
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it('falls back to the SPA for unknown GETs, but 404s unknown API routes', async () => {
    const spa = await t.app.inject({ method: 'GET', url: '/some/client/route' });
    expect(spa.statusCode).toBe(200);
    expect(spa.body).toContain('<h1>UI</h1>');

    const api = await t.app.inject({ method: 'GET', url: '/api/nope' });
    expect(api.statusCode).toBe(404);
  });
});
