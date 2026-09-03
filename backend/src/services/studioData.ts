import type { Db } from '../db/index.js';
import {
  AGE_GROUPS,
  AVAILABILITY_MAX_AGE_HOURS,
  DAYS_OF_WEEK,
  type AgeGroup,
  type DayOfWeek,
} from './aiLimits.js';

export interface StudioOffering {
  id: number;
  branch: string;
  title: string;
  ageGroup: string;
  level: string;
  dayOfWeek: string;
  time: string;
  price: string;
  spotsLeft: number | null;
  availabilityUpdatedAt: string | null;
  isOffer: boolean;
  notes: string;
  active: boolean;
  validUntil: string | null;
  updatedAt: string;
}

export interface OfferingInput {
  branch?: string;
  title: string;
  ageGroup?: string;
  level?: string;
  dayOfWeek?: string;
  time?: string;
  price?: string;
  /** undefined = leave alone; null = stop tracking. Writing it stamps availabilityUpdatedAt. */
  spotsLeft?: number | null;
  isOffer?: boolean;
  notes?: string;
  active?: boolean;
  validUntil?: string | null;
}

/** Filters the four retrieval tools accept. Enums are validated, never coerced. */
export interface OfferingFilters {
  branch?: string;
  ageGroup?: string;
  dayOfWeek?: string;
  level?: string;
}

export type ToolQueryResult =
  | { status: 'ok'; results: Array<Record<string, unknown>> }
  | { status: 'unknown' }
  | { status: 'invalid_request'; error: string };

interface Row {
  id: number;
  branch: string;
  title: string;
  age_group: string;
  level: string;
  day_of_week: string;
  time: string;
  price: string;
  spots_left: number | null;
  availability_updated_at: string | null;
  is_offer: number;
  notes: string;
  active: number;
  valid_until: string | null;
  updated_at: string;
}

const rowTo = (r: Row): StudioOffering => ({
  id: r.id,
  branch: r.branch,
  title: r.title,
  ageGroup: r.age_group,
  level: r.level,
  dayOfWeek: r.day_of_week,
  time: r.time,
  price: r.price,
  spotsLeft: r.spots_left,
  availabilityUpdatedAt: r.availability_updated_at,
  isOffer: !!r.is_offer,
  notes: r.notes,
  active: !!r.active,
  validUntil: r.valid_until,
  updatedAt: r.updated_at,
});

export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const today = (now: Date): string => now.toISOString().slice(0, 10);

/**
 * Validated filter clauses, or the error the model gets back verbatim.
 *
 * FAIL CLOSED. An invalid enum value is NOT dropped so the query can run
 * broader: "age_group: kids" silently widened to every age group is how a
 * children-only question gets answered with the adult timetable, confidently.
 * The model sees `invalid_request` as an ordinary tool result and can correct
 * the argument on its next round — bounded by MAX_TOOL_ROUNDS either way.
 *
 * branch/level match case-insensitively but EXACTLY, never LIKE: they are short
 * operator-controlled vocabulary, and exact matching means there is no `%`/`_`
 * to escape anywhere in this file. Every query below is parameterized.
 */
function filterClauses(
  f: OfferingFilters,
): { sql: string[]; params: unknown[] } | { error: string } {
  const sql: string[] = [];
  const params: unknown[] = [];
  if (f.ageGroup != null && f.ageGroup !== '') {
    if (!AGE_GROUPS.includes(f.ageGroup as AgeGroup))
      return { error: `age_group must be one of: ${AGE_GROUPS.join(', ')}` };
    // '' on a row means "unspecified / all ages", which answers any age filter
    sql.push(`(age_group = ? OR age_group = '')`);
    params.push(f.ageGroup);
  }
  if (f.dayOfWeek != null && f.dayOfWeek !== '') {
    if (!DAYS_OF_WEEK.includes(f.dayOfWeek as DayOfWeek))
      return { error: `day_of_week must be one of: ${DAYS_OF_WEEK.join(', ')}` };
    sql.push(`day_of_week = ?`);
    params.push(f.dayOfWeek);
  }
  if (f.branch != null && f.branch !== '') {
    sql.push(`branch = ? COLLATE NOCASE`);
    params.push(f.branch);
  }
  if (f.level != null && f.level !== '') {
    sql.push(`level = ? COLLATE NOCASE`);
    params.push(f.level);
  }
  return { sql, params };
}

/**
 * Operator-entered dynamic business data, and the four narrow read-only
 * projections of it the model can query.
 *
 * One table rather than four normalized ones: courses, prices, offers and
 * availability are the same rows read through different freshness rules, and
 * FRESHNESS is the part that actually matters — every rule below exists to make
 * a specific stale-claim impossible rather than to model the domain prettily.
 */
export class StudioDataStore {
  private readonly db: Db;
  private readonly q;

  constructor(db: Db) {
    this.db = db;
    this.q = {
      all: db.prepare(`SELECT * FROM studio_offerings ORDER BY is_offer, branch, title`),
      byId: db.prepare(`SELECT * FROM studio_offerings WHERE id = ?`),
      insert: db.prepare(`INSERT INTO studio_offerings
        (branch, title, age_group, level, day_of_week, time, price, spots_left,
         availability_updated_at, is_offer, notes, active, valid_until, updated_at)
        VALUES (@branch, @title, @age_group, @level, @day_of_week, @time, @price, @spots_left,
                @availability_updated_at, @is_offer, @notes, @active, @valid_until, @updated_at)`),
      update: db.prepare(`UPDATE studio_offerings SET branch=@branch, title=@title,
        age_group=@age_group, level=@level, day_of_week=@day_of_week, time=@time, price=@price,
        spots_left=@spots_left, availability_updated_at=@availability_updated_at,
        is_offer=@is_offer, notes=@notes, active=@active, valid_until=@valid_until,
        updated_at=@updated_at WHERE id=@id`),
      recheck: db.prepare(`UPDATE studio_offerings
        SET spots_left = ?, availability_updated_at = ?, updated_at = ? WHERE id = ?`),
      del: db.prepare(`DELETE FROM studio_offerings WHERE id = ?`),
    };
  }

  all(): StudioOffering[] {
    return (this.q.all.all() as Row[]).map(rowTo);
  }

  byId(id: number): StudioOffering | null {
    const r = this.q.byId.get(id) as Row | undefined;
    return r ? rowTo(r) : null;
  }

  create(input: OfferingInput, now = new Date()): StudioOffering {
    const iso = now.toISOString();
    const spots = input.spotsLeft ?? null;
    const r = this.q.insert.run({
      branch: input.branch ?? '',
      title: input.title,
      age_group: input.ageGroup ?? '',
      level: input.level ?? '',
      day_of_week: input.dayOfWeek ?? '',
      time: input.time ?? '',
      price: input.price ?? '',
      spots_left: spots,
      // a row created WITH a spots count was just counted; one without has
      // nothing to be fresh about
      availability_updated_at: spots == null ? null : iso,
      is_offer: input.isOffer ? 1 : 0,
      notes: input.notes ?? '',
      active: input.active === false ? 0 : 1,
      valid_until: input.validUntil ?? null,
      updated_at: iso,
    });
    return this.byId(Number(r.lastInsertRowid))!;
  }

  /**
   * A general edit. Deliberately does NOT touch availability_updated_at unless
   * spots_left itself is part of the patch: fixing a typo in `notes` is not a
   * recheck of how many places are left, and letting it pass for one is exactly
   * the bug that would have the AI quoting week-old spot counts as current.
   */
  update(id: number, patch: OfferingInput, now = new Date()): StudioOffering | null {
    const existing = this.byId(id);
    if (!existing) return null;
    const iso = now.toISOString();
    const spotsTouched = patch.spotsLeft !== undefined;
    const spots = spotsTouched ? (patch.spotsLeft ?? null) : existing.spotsLeft;
    this.q.update.run({
      id,
      branch: patch.branch ?? existing.branch,
      title: patch.title ?? existing.title,
      age_group: patch.ageGroup ?? existing.ageGroup,
      level: patch.level ?? existing.level,
      day_of_week: patch.dayOfWeek ?? existing.dayOfWeek,
      time: patch.time ?? existing.time,
      price: patch.price ?? existing.price,
      spots_left: spots,
      availability_updated_at: spotsTouched
        ? spots == null
          ? null
          : iso
        : existing.availabilityUpdatedAt,
      is_offer: (patch.isOffer ?? existing.isOffer) ? 1 : 0,
      notes: patch.notes ?? existing.notes,
      active: (patch.active ?? existing.active) ? 1 : 0,
      valid_until: patch.validUntil === undefined ? existing.validUntil : patch.validUntil,
      updated_at: iso,
    });
    return this.byId(id);
  }

  /**
   * "I just checked, there are still N places" — the ONE action that stamps
   * availability_updated_at, kept separate from a general edit so the operator
   * has to actually assert the recount.
   */
  recheckAvailability(id: number, spotsLeft: number | null, now = new Date()): StudioOffering | null {
    if (!this.byId(id)) return null;
    const iso = now.toISOString();
    this.q.recheck.run(spotsLeft, spotsLeft == null ? null : iso, iso, id);
    return this.byId(id);
  }

  delete(id: number): boolean {
    return this.q.del.run(id).changes > 0;
  }

  private run(
    where: string[],
    params: unknown[],
    project: (r: Row) => Record<string, unknown>,
    limit = 20,
  ): ToolQueryResult {
    const rows = this.db
      .prepare(`SELECT * FROM studio_offerings WHERE ${where.join(' AND ')}
        ORDER BY branch, title, day_of_week, time LIMIT ?`)
      .all(...params, limit) as Row[];
    if (!rows.length) return { status: 'unknown' };
    return { status: 'ok', results: rows.map(project) };
  }

  /**
   * `get_courses` — the timetable. No forced expiry: a studio maintains these by
   * direct edit, and a course with no end date is the normal case, so
   * valid_until IS NULL still returns.
   */
  courses(f: OfferingFilters = {}, now = new Date()): ToolQueryResult {
    const c = filterClauses(f);
    if ('error' in c) return { status: 'invalid_request', error: c.error };
    return this.run(
      [`active = 1`, `is_offer = 0`, `(valid_until IS NULL OR valid_until >= ?)`, ...c.sql],
      [today(now), ...c.params],
      (r) => ({
        title: r.title,
        branch: r.branch,
        age_group: r.age_group || 'all ages',
        level: r.level,
        day_of_week: r.day_of_week,
        time: r.time,
        notes: r.notes,
      }),
    );
  }

  /** `get_prices` — the same rows, projected onto the price column. */
  prices(f: OfferingFilters = {}, now = new Date()): ToolQueryResult {
    const c = filterClauses(f);
    if ('error' in c) return { status: 'invalid_request', error: c.error };
    return this.run(
      [
        `active = 1`,
        `is_offer = 0`,
        `price <> ''`,
        `(valid_until IS NULL OR valid_until >= ?)`,
        ...c.sql,
      ],
      [today(now), ...c.params],
      (r) => ({
        title: r.title,
        branch: r.branch,
        age_group: r.age_group || 'all ages',
        price: r.price,
        notes: r.notes,
      }),
    );
  }

  /**
   * `get_available_offers` — discounts and promotions. An offer with NO expiry
   * is never returned: an open-ended discount that outlives the campaign it
   * belonged to is precisely the stale claim this rule exists to prevent, and
   * "there's a promotion on" is the single most expensive thing to be wrong
   * about.
   */
  offers(f: OfferingFilters = {}, now = new Date()): ToolQueryResult {
    const c = filterClauses(f);
    if ('error' in c) return { status: 'invalid_request', error: c.error };
    return this.run(
      [
        `active = 1`,
        `is_offer = 1`,
        `valid_until IS NOT NULL`,
        `valid_until >= ?`,
        ...c.sql,
      ],
      [today(now), ...c.params],
      (r) => ({
        title: r.title,
        branch: r.branch,
        age_group: r.age_group || 'all ages',
        price: r.price,
        valid_until: r.valid_until,
        notes: r.notes,
      }),
    );
  }

  /**
   * `get_availability` — how many places are left. Gated on
   * availability_updated_at, its own timestamp, and NOT on the row's general
   * updated_at: otherwise editing a course's price or notes would make a
   * week-old spot count look freshly verified.
   */
  availability(f: OfferingFilters = {}, now = new Date()): ToolQueryResult {
    const c = filterClauses(f);
    if ('error' in c) return { status: 'invalid_request', error: c.error };
    const cutoff = new Date(now.getTime() - AVAILABILITY_MAX_AGE_HOURS * 3_600_000).toISOString();
    return this.run(
      [
        `active = 1`,
        `spots_left IS NOT NULL`,
        `availability_updated_at IS NOT NULL`,
        `availability_updated_at >= ?`,
        ...c.sql,
      ],
      [cutoff, ...c.params],
      (r) => ({
        title: r.title,
        branch: r.branch,
        age_group: r.age_group || 'all ages',
        day_of_week: r.day_of_week,
        time: r.time,
        spots_left: r.spots_left,
        checked_at: r.availability_updated_at,
      }),
    );
  }
}
