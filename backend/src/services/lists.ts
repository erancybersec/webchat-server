import { randomUUID } from 'node:crypto';
import type { Db } from '../db/index.js';
import type { ListMember, ListRecipe, ListRecipeSource, RecipientList } from '../types.js';
import { isGroupJid, normalizePhone } from './phone.js';

/** Keep the rows carrying a non-empty id, first mention of each id winning. */
function parseSources(v: unknown): ListRecipeSource[] {
  if (!Array.isArray(v)) return [];
  const out: ListRecipeSource[] = [];
  const seen = new Set<string>();
  for (const raw of v.slice(0, 100)) {
    const o = (raw ?? {}) as Record<string, unknown>;
    const id = String(o.id ?? '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: String(o.name ?? '').trim() });
  }
  return out;
}

/**
 * Normalize a client-supplied recipe. Anything unusable comes back as null —
 * a bad recipe must never cost the caller their members, which are stored
 * separately either way. `selfId` drops a list that includes/excludes itself.
 */
export function parseRecipe(v: unknown, selfId?: string): ListRecipe | null {
  if (v == null) return null;
  const o = (typeof v === 'string' ? safeJson(v) : v) as Record<string, unknown> | null;
  if (!o || typeof o !== 'object') return null;
  const drop = (s: ListRecipeSource) => s.id !== selfId;
  const include = parseSources(o.include).filter(drop);
  const exclude = parseSources(o.exclude).filter(drop);
  if (!include.length) return null; // subtracting from nothing is not a recipe
  return { v: 1, include, exclude };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export interface MemberInput {
  recipient?: unknown;
  phone?: unknown;
  isGroup?: unknown;
  name?: unknown;
}

export interface SetMembersResult {
  members: number;
  invalid: string[];
}

interface ListRow {
  id: string;
  name: string;
  created_at: string;
  member_count: number;
  recipe: string | null;
  line_scope: string | null;
  created_by: string | null;
}

/** Keep well-formed, non-empty, trimmed, de-duplicated instance names. */
function parseLineScope(v: string | null): string[] | null {
  if (!v) return null;
  const arr = safeJson(v);
  if (!Array.isArray(arr)) return null;
  const seen = new Set<string>();
  for (const raw of arr) {
    const name = String(raw ?? '').trim();
    if (name) seen.add(name);
  }
  return seen.size ? [...seen] : null;
}

/** Saved audiences: named recipient sets pickable in Compose. */
export class ListsStore {
  private readonly q;
  constructor(private readonly db: Db) {
    this.q = {
      all: db.prepare(`SELECT l.*, COUNT(m.recipient) AS member_count
        FROM recipient_lists l LEFT JOIN recipient_list_members m ON m.list_id = l.id
        GROUP BY l.id ORDER BY l.name COLLATE NOCASE`),
      byId: db.prepare(`SELECT l.*, COUNT(m.recipient) AS member_count
        FROM recipient_lists l LEFT JOIN recipient_list_members m ON m.list_id = l.id
        WHERE l.id = ? GROUP BY l.id`),
      insert: db.prepare(`INSERT INTO recipient_lists (id, name, created_at, line_scope, created_by)
        VALUES (?, ?, ?, ?, ?)`),
      rename: db.prepare(`UPDATE recipient_lists SET name = ? WHERE id = ?`),
      setRecipe: db.prepare(`UPDATE recipient_lists SET recipe = ? WHERE id = ?`),
      setLineScope: db.prepare(`UPDATE recipient_lists SET line_scope = ? WHERE id = ?`),
      del: db.prepare(`DELETE FROM recipient_lists WHERE id = ?`),
      members: db.prepare(`SELECT recipient, is_group, name FROM recipient_list_members
        WHERE list_id = ? ORDER BY name COLLATE NOCASE, recipient`),
      memberInsert: db.prepare(`INSERT INTO recipient_list_members (list_id, recipient, is_group, name)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(list_id, recipient) DO UPDATE SET name = excluded.name, is_group = excluded.is_group`),
      membersClear: db.prepare(`DELETE FROM recipient_list_members WHERE list_id = ?`),
    };
  }

  private rowToList(r: ListRow): RecipientList {
    return {
      id: r.id,
      name: r.name,
      createdAt: r.created_at,
      memberCount: r.member_count,
      recipe: parseRecipe(r.recipe, r.id),
      lineScope: parseLineScope(r.line_scope),
      createdBy: r.created_by,
    };
  }

  all(): RecipientList[] {
    return (this.q.all.all() as ListRow[]).map((r) => this.rowToList(r));
  }

  /** `all()` filtered to lists visible on the given line (null scope = every line). */
  allFor(instance: string): RecipientList[] {
    return this.all().filter((l) => !l.lineScope || l.lineScope.includes(instance));
  }

  byId(id: string): RecipientList | null {
    const r = this.q.byId.get(id) as ListRow | undefined;
    return r ? this.rowToList(r) : null;
  }

  members(id: string): ListMember[] {
    return (this.q.members.all(id) as Array<{ recipient: string; is_group: number; name: string }>).map(
      (m) => ({ recipient: m.recipient, isGroup: !!m.is_group, name: m.name }),
    );
  }

  create(
    name: string,
    opts?: { lineScope?: string[] | null; createdBy?: string | null },
  ): RecipientList {
    const id = `list_${randomUUID()}`;
    const lineScope = opts?.lineScope?.length ? JSON.stringify(opts.lineScope) : null;
    this.q.insert.run(id, name, new Date().toISOString(), lineScope, opts?.createdBy ?? null);
    return this.byId(id)!;
  }

  rename(id: string, name: string): boolean {
    return this.q.rename.run(name, id).changes > 0;
  }

  /** Store (or clear, with null) the recipe behind a combined list's members. */
  setRecipe(id: string, recipe: ListRecipe | null): boolean {
    const json = recipe ? JSON.stringify(recipe) : null;
    return this.q.setRecipe.run(json, id).changes > 0;
  }

  /** Store (or clear, with null = every line) which lines a list is visible on. */
  setLineScope(id: string, lineScope: string[] | null): boolean {
    const json = lineScope?.length ? JSON.stringify(lineScope) : null;
    return this.q.setLineScope.run(json, id).changes > 0;
  }

  delete(id: string): boolean {
    return this.q.del.run(id).changes > 0;
  }

  /**
   * Replace a list's members. Phones are normalized exactly like the blacklist
   * so {{name}} lookups and blacklist checks agree on the stored form; group
   * JIDs pass through as-is. Invalid entries are reported, not saved.
   */
  setMembers(id: string, inputs: MemberInput[]): SetMembersResult {
    const invalid: string[] = [];
    const rows: ListMember[] = [];
    for (const m of inputs) {
      const raw = String(m.recipient ?? m.phone ?? '').trim();
      const name = String(m.name ?? '').trim();
      if (isGroupJid(raw)) {
        rows.push({ recipient: raw, isGroup: true, name });
        continue;
      }
      const phone = normalizePhone(raw);
      if (!phone) {
        invalid.push(raw);
        continue;
      }
      rows.push({ recipient: phone, isGroup: false, name });
    }
    this.db.transaction(() => {
      this.q.membersClear.run(id);
      for (const r of rows) this.q.memberInsert.run(id, r.recipient, r.isGroup ? 1 : 0, r.name);
    })();
    return { members: this.members(id).length, invalid };
  }
}
