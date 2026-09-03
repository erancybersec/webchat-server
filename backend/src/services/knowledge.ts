import type { Db } from '../db/index.js';

export interface KnowledgeArticle {
  id: number;
  title: string;
  category: string;
  content: string;
  keywords: string;
  active: boolean;
  updatedAt: string;
}

export interface KnowledgeInput {
  title: string;
  category?: string;
  content: string;
  keywords?: string;
  active?: boolean;
}

interface Row {
  id: number;
  title: string;
  category: string;
  content: string;
  keywords: string;
  active: number;
  updated_at: string;
}

const rowTo = (r: Row): KnowledgeArticle => ({
  id: r.id,
  title: r.title,
  category: r.category,
  content: r.content,
  keywords: r.keywords,
  active: !!r.active,
  updatedAt: r.updated_at,
});

/** Words worth matching on — 2+ chars, deduped, capped so a long query can't fan out. */
export function queryTerms(query: string, max = 8): string[] {
  return [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .map((w) => w.trim())
        .filter((w) => w.length >= 2),
    ),
  ].slice(0, max);
}

/**
 * Stable knowledge — policies, FAQ, the things that don't change week to week.
 * Retrieval is plain keyword scoring over title/keywords/category/content: at a
 * single studio's scale that is both cheaper and more predictable than an
 * embedding index, and it is the seam a vector store would replace later
 * without any caller noticing.
 */
export class KnowledgeStore {
  private readonly q;

  constructor(private readonly db: Db) {
    this.q = {
      all: db.prepare(`SELECT * FROM knowledge_articles ORDER BY category, title`),
      byId: db.prepare(`SELECT * FROM knowledge_articles WHERE id = ?`),
      active: db.prepare(`SELECT * FROM knowledge_articles WHERE active = 1`),
      insert: db.prepare(`INSERT INTO knowledge_articles
        (title, category, content, keywords, active, updated_at) VALUES (?, ?, ?, ?, ?, ?)`),
      update: db.prepare(`UPDATE knowledge_articles SET title=@title, category=@category,
        content=@content, keywords=@keywords, active=@active, updated_at=@updated_at WHERE id=@id`),
      del: db.prepare(`DELETE FROM knowledge_articles WHERE id = ?`),
    };
  }

  all(): KnowledgeArticle[] {
    return (this.q.all.all() as Row[]).map(rowTo);
  }

  byId(id: number): KnowledgeArticle | null {
    const r = this.q.byId.get(id) as Row | undefined;
    return r ? rowTo(r) : null;
  }

  create(input: KnowledgeInput): KnowledgeArticle {
    const r = this.q.insert.run(
      input.title,
      input.category ?? '',
      input.content,
      input.keywords ?? '',
      input.active === false ? 0 : 1,
      new Date().toISOString(),
    );
    return this.byId(Number(r.lastInsertRowid))!;
  }

  update(id: number, patch: Partial<KnowledgeInput>): KnowledgeArticle | null {
    const existing = this.byId(id);
    if (!existing) return null;
    this.q.update.run({
      id,
      title: patch.title ?? existing.title,
      category: patch.category ?? existing.category,
      content: patch.content ?? existing.content,
      keywords: patch.keywords ?? existing.keywords,
      active: (patch.active ?? existing.active) ? 1 : 0,
      updated_at: new Date().toISOString(),
    });
    return this.byId(id);
  }

  delete(id: number): boolean {
    return this.q.del.run(id).changes > 0;
  }

  /**
   * The `search_knowledge` tool's backing query. Active articles only, scored by
   * where a term hit: an explicit keyword or the title outweighs a passing
   * mention in the body, so the operator's own keyword list is the lever for
   * steering retrieval. Returns [] rather than everything when nothing matches —
   * the fixed safety rules cover what the model does with an empty result.
   */
  search(query: string, limit = 3): KnowledgeArticle[] {
    const terms = queryTerms(query);
    if (!terms.length) return [];
    const scored: Array<{ a: KnowledgeArticle; score: number }> = [];
    for (const r of this.q.active.all() as Row[]) {
      const a = rowTo(r);
      const title = a.title.toLowerCase();
      const keywords = a.keywords.toLowerCase();
      const category = a.category.toLowerCase();
      const content = a.content.toLowerCase();
      let score = 0;
      for (const t of terms) {
        if (keywords.includes(t)) score += 4;
        if (title.includes(t)) score += 3;
        if (category.includes(t)) score += 2;
        if (content.includes(t)) score += 1;
      }
      if (score > 0) scored.push({ a, score });
    }
    return scored
      .sort((x, y) => y.score - x.score || x.a.id - y.a.id)
      .slice(0, Math.max(1, limit))
      .map((s) => s.a);
  }
}
