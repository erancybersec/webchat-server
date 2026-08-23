import fs from 'node:fs';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Config } from '../config.js';

/**
 * Serves the built frontend from STATIC_DIR: index.html revalidated on each
 * load, hashed assets cacheable, and an SPA fallback for client-side routes.
 * In development the vite dev server serves the frontend instead and proxies
 * /api here.
 */
export async function registerStatic(app: FastifyInstance, cfg: Config): Promise<void> {
  function sendIndex(reply: FastifyReply): FastifyReply {
    let html: string;
    try {
      html = fs.readFileSync(path.join(cfg.staticDir, 'index.html'), 'utf8');
    } catch {
      return reply
        .code(500)
        .type('text/plain')
        .send('index.html not found in STATIC_DIR — build the frontend or use the vite dev server');
    }
    // revalidate on each load so a new build is picked up immediately
    return reply.header('Cache-Control', 'no-cache').type('text/html').send(html);
  }

  app.get('/', async (_req, reply) => sendIndex(reply));
  app.get('/index.html', async (_req, reply) => sendIndex(reply));

  // other static assets (vite emits content-hashed filenames)
  if (fs.existsSync(cfg.staticDir)) {
    await app.register(fastifyStatic, {
      root: cfg.staticDir,
      index: false,
      wildcard: true,
      decorateReply: false,
    });
  }

  // /api unknowns are JSON 404s; any other GET falls through to the SPA
  app.setNotFoundHandler((req, reply) => {
    if ((req.raw.url ?? '').startsWith('/api/') || req.method !== 'GET')
      return reply.code(404).send({ error: 'not found' });
    return sendIndex(reply);
  });
}
