import type { Db } from '../db/index.js';
import type { QuickReply, QuickReplyMedia } from '../types.js';

interface Row {
  id: number;
  shortcut: string;
  text: string;
  agent_email: string | null;
  instance: string | null;
  media: string | null;
}

const parseMedia = (raw: string | null): QuickReplyMedia | null => {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as QuickReplyMedia;
  } catch {
    return null;
  }
};

const rowToReply = (r: Row): QuickReply => ({
  id: r.id,
  shortcut: r.shortcut,
  text: r.text,
  agentEmail: r.agent_email,
  instance: r.instance,
  media: parseMedia(r.media),
});

/**
 * Media as supplied on create/update: the descriptor plus, for an uploaded
 * file, the base64 bytes (stored apart from the descriptor so the list never
 * ships them). url-kind carries no bytes — Evolution reads them from the URL.
 */
export interface MediaInput {
  kind: 'file' | 'url';
  mediatype: QuickReplyMedia['mediatype'];
  mimetype: string;
  filename?: string;
  url?: string;
  base64?: string;
}

/** The descriptor (no bytes) persisted in the `media` JSON column. */
const toDescriptor = (m: MediaInput): QuickReplyMedia => ({
  kind: m.kind,
  mediatype: m.mediatype,
  mimetype: m.mimetype,
  ...(m.filename ? { filename: m.filename } : {}),
  ...(m.kind === 'url' && m.url ? { url: m.url } : {}),
});

/** What /api/quick-replies/:id/media returns — bytes ready to send. */
export interface ResolvedMedia {
  mediatype: QuickReplyMedia['mediatype'];
  mimetype: string;
  filename?: string;
  base64: string | null;
  url: string | null;
}

// Per-instance separation: a reply's effective instance is its own, or the
// server default when blank. @eff='' = no filter (single-instance / no identity).
const INSTANCE_SCOPE = `(@eff = '' OR COALESCE(NULLIF(instance,''), @def) = @eff)`;

// The list is polled, so it never selects the heavy media_data column.
const COLS = 'id, shortcut, text, agent_email, instance, media';

/** Restrict a read to one Evolution line. eff='' = no filter. */
export interface InstanceFilter {
  eff: string;
  def: string;
}
const NO_FILTER: InstanceFilter = { eff: '', def: '' };

/**
 * Server-side quick replies (formerly per-device localStorage). agent_email
 * NULL = shared with the team; set = personal to that agent. instance scopes a
 * reply to one Evolution line (NULL = the default), orthogonal to agent_email.
 * A reply may carry media — a descriptor in `media`, the bytes in `media_data`.
 */
export class QuickRepliesStore {
  private readonly q;
  constructor(private readonly db: Db) {
    this.q = {
      all: db.prepare(`SELECT ${COLS} FROM quick_replies
        WHERE ${INSTANCE_SCOPE}
        ORDER BY shortcut COLLATE NOCASE, id`),
      everything: db.prepare(`SELECT ${COLS} FROM quick_replies
        ORDER BY shortcut COLLATE NOCASE, id`),
      visibleTo: db.prepare(`SELECT ${COLS} FROM quick_replies
        WHERE (agent_email IS NULL OR agent_email = @email) AND ${INSTANCE_SCOPE}
        ORDER BY shortcut COLLATE NOCASE, id`),
      byId: db.prepare(`SELECT ${COLS} FROM quick_replies WHERE id = ?`),
      mediaById: db.prepare(`SELECT media, media_data FROM quick_replies WHERE id = ?`),
      insert: db.prepare(`INSERT INTO quick_replies (shortcut, text, created_at, agent_email, instance, media, media_data)
        VALUES (?, ?, ?, ?, ?, ?, ?)`),
      updateFields: db.prepare(`UPDATE quick_replies SET shortcut = ?, text = ? WHERE id = ?`),
      updateMedia: db.prepare(`UPDATE quick_replies SET media = ?, media_data = ? WHERE id = ?`),
      del: db.prepare(`DELETE FROM quick_replies WHERE id = ?`),
    };
  }

  /** email null = no identity filter (agent identification off): everything. */
  allFor(email: string | null, filter: InstanceFilter = NO_FILTER): QuickReply[] {
    const rows = (
      email == null
        ? this.q.all.all(filter)
        : this.q.visibleTo.all({ ...filter, email })
    ) as Row[];
    return rows.map(rowToReply);
  }

  /** Admin cross-view: every reply, all instances and all owners. */
  everything(): QuickReply[] {
    return (this.q.everything.all() as Row[]).map(rowToReply);
  }

  byId(id: number): QuickReply | null {
    const r = this.q.byId.get(id) as Row | undefined;
    return r ? rowToReply(r) : null;
  }

  /** The sendable media for a reply, including the bytes — null if text-only. */
  media(id: number): ResolvedMedia | null {
    const r = this.q.mediaById.get(id) as { media: string | null; media_data: string | null } | undefined;
    const d = r ? parseMedia(r.media) : null;
    if (!d) return null;
    return {
      mediatype: d.mediatype,
      mimetype: d.mimetype,
      filename: d.filename,
      base64: r?.media_data ?? null,
      url: d.url ?? null,
    };
  }

  create(
    shortcut: string,
    text: string,
    agentEmail: string | null = null,
    instance: string | null = null,
    media: MediaInput | null = null,
  ): QuickReply {
    const json = media ? JSON.stringify(toDescriptor(media)) : null;
    const data = media?.kind === 'file' ? (media.base64 ?? null) : null;
    const r = this.q.insert.run(shortcut, text, new Date().toISOString(), agentEmail, instance, json, data);
    return this.byId(Number(r.lastInsertRowid))!;
  }

  /** Bulk add — the one-time localStorage migration path (shared rows). */
  createMany(rows: Array<{ shortcut: string; text: string }>, instance: string | null = null): number {
    let added = 0;
    this.db.transaction(() => {
      for (const r of rows) {
        if (!r.text) continue;
        this.q.insert.run(r.shortcut, r.text, new Date().toISOString(), null, instance, null, null);
        added++;
      }
    })();
    return added;
  }

  /**
   * `media: undefined` leaves it untouched, `null` clears it, a value replaces
   * it. shortcut/text update only when provided.
   */
  update(
    id: number,
    patch: { shortcut?: string; text?: string; media?: MediaInput | null },
  ): QuickReply | null {
    const existing = this.byId(id);
    if (!existing) return null;
    if (patch.shortcut !== undefined || patch.text !== undefined)
      this.q.updateFields.run(patch.shortcut ?? existing.shortcut, patch.text ?? existing.text, id);
    if (patch.media !== undefined) {
      const json = patch.media ? JSON.stringify(toDescriptor(patch.media)) : null;
      const data = patch.media?.kind === 'file' ? (patch.media.base64 ?? null) : null;
      this.q.updateMedia.run(json, data, id);
    }
    return this.byId(id);
  }

  delete(id: number): boolean {
    return this.q.del.run(id).changes > 0;
  }
}
