import type { Db } from '../db/index.js';

/**
 * Per-person nav tab order. Keyed by the Cloudflare Access identity (agent
 * email); '' = anonymous / identification off, a single shared row. Drives
 * both which tabs sit in the main bar (the first N, N depending on screen
 * width) and the order of the "More" overflow menu — same list either way.
 */
export interface ToolbarPrefs {
  order: string[];
}

/** Today's effective tab order, preserved for anyone who never customizes. */
export const DEFAULT_TOOLBAR_ORDER = [
  'chat',
  'compose',
  'groups',
  'scheduled',
  'lists',
  'tools',
  'quickreplies',
  'history',
  'blacklist',
  'profile',
  'preferences',
  'insights',
];

interface PrefsRow {
  agent_email: string;
  tab_order: string;
}

function sanitize(order: unknown): string[] {
  if (!Array.isArray(order)) return [...DEFAULT_TOOLBAR_ORDER];
  const seen = new Set<string>();
  const clean: string[] = [];
  for (const id of order) {
    if (typeof id !== 'string' || !id || seen.has(id)) continue;
    seen.add(id);
    clean.push(id);
    if (clean.length >= 30) break;
  }
  return clean.length ? clean : [...DEFAULT_TOOLBAR_ORDER];
}

export class ToolbarPrefsStore {
  private readonly q;

  constructor(private readonly db: Db) {
    this.q = {
      get: db.prepare(`SELECT * FROM toolbar_prefs WHERE agent_email = ?`),
      put: db.prepare(`INSERT INTO toolbar_prefs (agent_email, tab_order)
        VALUES (@agent_email, @tab_order)
        ON CONFLICT(agent_email) DO UPDATE SET tab_order = excluded.tab_order`),
    };
  }

  /** Saved order for an agent, falling back to the default for a missing/bad row. */
  get(email: string): ToolbarPrefs {
    const r = this.q.get.get(email) as PrefsRow | undefined;
    if (!r?.tab_order) return { order: [...DEFAULT_TOOLBAR_ORDER] };
    try {
      const parsed = JSON.parse(r.tab_order);
      return { order: sanitize(parsed) };
    } catch {
      return { order: [...DEFAULT_TOOLBAR_ORDER] };
    }
  }

  set(email: string, order: unknown): ToolbarPrefs {
    const clean = sanitize(order);
    this.q.put.run({ agent_email: email, tab_order: JSON.stringify(clean) });
    return { order: clean };
  }
}
