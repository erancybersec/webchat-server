import type { Db } from '../db/index.js';
import type { BlacklistEntry } from '../types.js';
import { digitsOnly, isGroupJid, normalizePhone } from './phone.js';

export interface BlacklistInput {
  phone_number?: unknown;
  phone?: unknown;
  number?: unknown;
  name?: unknown;
  added_date?: unknown;
  why_blacklisted?: unknown;
  why?: unknown;
}

export interface AddResult {
  added: number;
  invalid: string[];
}

export class BlacklistStore {
  private readonly q;
  constructor(private readonly db: Db) {
    this.q = {
      all: db.prepare(`SELECT * FROM blacklist ORDER BY id DESC`),
      byPhone: db.prepare(`SELECT * FROM blacklist WHERE phone_number = ?`),
      // re-adding an existing number refreshes name/reason but keeps the original added_date
      insert: db.prepare(`INSERT INTO blacklist (phone_number, name, added_date, why_blacklisted)
        VALUES (@phone_number, @name, @added_date, @why_blacklisted)
        ON CONFLICT(phone_number) DO UPDATE SET
          name = excluded.name, why_blacklisted = excluded.why_blacklisted`),
      update: db.prepare(`UPDATE blacklist SET phone_number = @phone_number, name = @name,
        why_blacklisted = @why_blacklisted WHERE phone_number = @old_phone`),
      del: db.prepare(`DELETE FROM blacklist WHERE phone_number = ?`),
    };
  }

  list(): BlacklistEntry[] {
    return this.q.all.all() as BlacklistEntry[];
  }

  get(phone: string): BlacklistEntry | undefined {
    return this.q.byPhone.get(phone) as BlacklistEntry | undefined;
  }

  addMany(rows: BlacklistInput[]): AddResult {
    const today = new Date().toISOString().slice(0, 10);
    let added = 0;
    const invalid: string[] = [];
    this.db.transaction(() => {
      for (const r of rows) {
        const rawPhone = r.phone_number ?? r.phone ?? r.number;
        const phone = normalizePhone(rawPhone);
        if (!phone) {
          invalid.push(String(rawPhone ?? ''));
          continue;
        }
        this.q.insert.run({
          phone_number: phone,
          name: String(r.name ?? '').trim(),
          added_date: typeof r.added_date === 'string' && r.added_date ? r.added_date : today,
          why_blacklisted: String(r.why_blacklisted ?? r.why ?? '').trim(),
        });
        added++;
      }
    })();
    return { added, invalid };
  }

  /** Returns the updated entry, or an error code the route maps to 404/400/409. */
  update(
    oldPhoneRaw: string,
    patch: { phone_number?: unknown; name?: unknown; why_blacklisted?: unknown },
  ): BlacklistEntry | 'not_found' | 'invalid_phone' | 'conflict' {
    // stored entries are normalized — accept any input form for the lookup
    const existing = this.get(digitsOnly(oldPhoneRaw)) ?? this.get(normalizePhone(oldPhoneRaw) ?? '');
    if (!existing) return 'not_found';
    const oldPhone = existing.phone_number;
    const newPhone = patch.phone_number != null ? normalizePhone(patch.phone_number) : oldPhone;
    if (!newPhone) return 'invalid_phone';
    if (newPhone !== oldPhone && this.get(newPhone)) return 'conflict';
    this.q.update.run({
      old_phone: oldPhone,
      phone_number: newPhone,
      name: patch.name != null ? String(patch.name).trim() : existing.name,
      why_blacklisted:
        patch.why_blacklisted != null ? String(patch.why_blacklisted).trim() : existing.why_blacklisted,
    });
    return this.get(newPhone)!;
  }

  /** Entries are stored normalized — try the raw digits, then the normal form. */
  private delByAnyForm(phoneRaw: unknown): number {
    const raw = digitsOnly(phoneRaw);
    if (raw && this.q.del.run(raw).changes > 0) return 1;
    const norm = normalizePhone(phoneRaw);
    return norm && norm !== raw ? this.q.del.run(norm).changes : 0;
  }

  remove(phoneRaw: string): boolean {
    return this.delByAnyForm(phoneRaw) > 0;
  }

  removeMany(phones: unknown[]): number {
    let removed = 0;
    this.db.transaction(() => {
      for (const p of phones) removed += this.delByAnyForm(p);
    })();
    return removed;
  }

  /** Send-time check. Groups are never blocked; matches raw digits and the normalized form. */
  isBlacklisted(recipient: unknown): boolean {
    if (!recipient || isGroupJid(recipient)) return false;
    const raw = digitsOnly(recipient);
    if (raw && this.get(raw)) return true;
    const norm = normalizePhone(recipient);
    return !!(norm && this.get(norm));
  }
}
