/**
 * Seed the local dev DB's agents (users) from a copy of the prod DB.
 * One-time setup for the localhost test rig — see DEV.md:
 *   1. pscp the prod webchat.db -> ./data/prod-webchat.db (read-only; prod untouched)
 *   2. npm run seed:dev
 *   3. delete ./data/prod-webchat.db*
 *
 * openDb() applies the ordered migrations first, so dev.db has the current
 * schema before we copy. Columns are named explicitly so a newer dev schema
 * (extra agent columns) still works — prod fills what it has, new cols default.
 * INSERT OR REPLACE makes re-running idempotent.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDb } from '../backend/src/db/index.js';

const DEV_DB = process.env.DB_PATH ?? './data/dev.db';
const PROD_COPY = resolve(process.env.PROD_DB ?? './data/prod-webchat.db');

if (!existsSync(PROD_COPY)) {
  console.error(
    `prod DB copy not found: ${PROD_COPY}\n` +
      `Pull it first (see DEV.md):\n` +
      `  pscp -batch -pw <password> -hostkey "<host-key-fingerprint>" \\\n` +
      `    <user>@<host>:/home/eran/webchat-v2/data/webchat.db ./data/prod-webchat.db`,
  );
  process.exit(1);
}

const db = openDb(DEV_DB); // runs migrations -> agents table at the current schema
db.exec(`ATTACH DATABASE '${PROD_COPY.replace(/'/g, "''")}' AS prod`);

const cols = 'email,name,color,active,role,perms,instances,created_at,last_seen_at';
const count = () => (db.prepare('SELECT COUNT(*) AS n FROM agents').get() as { n: number }).n;
const before = count();
db.exec(`INSERT OR REPLACE INTO agents (${cols}) SELECT ${cols} FROM prod.agents`);
const after = count();

const admins = (db.prepare(`SELECT email FROM agents WHERE role = 'admin'`).all() as {
  email: string;
}[])
  .map((r) => r.email)
  .join(', ');

console.log(
  `seeded agents into ${DEV_DB}: ${before} -> ${after} rows (admins: ${admins || 'none'})`,
);
db.close();
