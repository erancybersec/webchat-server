import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { openDb } from './db/index.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const db = openDb(cfg.dbPath);
  const { app, scheduler, relay, jobs, seedFamiliarity, aiAgent } = await buildApp({
    cfg,
    db,
    logger: true,
  });

  // Jobs interrupted by a crash/restart resume via their send ledger —
  // already-sent recipients are not resent.
  const recovered = jobs.recoverInterrupted();
  if (recovered) app.log.info(`recovered ${recovered} interrupted job(s)`);

  await app.listen({ port: cfg.port, host: '0.0.0.0' });
  scheduler.start();
  // The AI agent's debounced-send poller. Starts regardless of the master
  // switch (its first act each tick is to clean up rows a crash left behind);
  // the switch is checked before anything is claimed or sent.
  aiAgent.startPolling();
  relay.start();
  // deliberately not awaited: one findChats call in the lifetime of a line,
  // and nothing about serving requests depends on it finishing
  void seedFamiliarity();
  app.log.info(
    `webchat-server up — static=${cfg.staticDir} db=${cfg.dbPath} ` +
      `evolution=${cfg.evo.base ? `${cfg.evo.base} (${cfg.evo.instance})` : '(not configured)'} ` +
      `auth=${cfg.apiToken ? 'token' : 'off'}`,
  );

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      // waits for an in-flight tick — closing the DB under a mid-send job
      // would lose the 'sent' ledger write and resend after restart
      await scheduler.stop();
      aiAgent.stopPolling();
      await app.close(); // also stops the relay via onClose
      db.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
