import type { ListMember, ListRecipe, RecipientList } from '../types';

export interface RecipeResult {
  /** The recipe's members, deduplicated — what gets saved on the list. */
  members: ListMember[];
  /** Rows scanned across the include sources, before dedup. */
  scanned: number;
  /** Rows the dedup merged away (the same phone in two include lists). */
  duplicates: number;
  /** Unique recipients dropped because an exclude source holds them. */
  excluded: number;
  /** Source ids whose members could not be loaded — a deleted list, usually. */
  missing: string[];
}

export const EMPTY_RECIPE: ListRecipe = { v: 1, include: [], exclude: [] };

/**
 * Union every include source, then subtract every exclude source.
 *
 * Recipients arrive already normalized by the server (`normalizePhone`), so
 * plain string identity is the dedup key — the same rule the blacklist and
 * `{{name}}` lookups use, which is what keeps all three agreeing.
 *
 * A recipient's name comes from the first include source that has one, and a
 * later source fills a name the earlier one left blank. That mirrors Compose's
 * "Add from list", so pulling A then B by hand lands on the same names.
 *
 * `membersById` only has to hold the sources that loaded; anything absent is
 * reported in `missing` rather than silently treated as empty — an exclude list
 * that failed to load would otherwise quietly widen the audience.
 */
export function resolveRecipe(
  recipe: ListRecipe,
  membersById: Map<string, ListMember[]>,
): RecipeResult {
  const missing: string[] = [];
  const sourceMembers = (id: string): ListMember[] => {
    const m = membersById.get(id);
    if (!m) {
      missing.push(id);
      return [];
    }
    return m;
  };

  const byRecipient = new Map<string, ListMember>();
  let scanned = 0;
  for (const src of recipe.include) {
    for (const m of sourceMembers(src.id)) {
      scanned++;
      const seen = byRecipient.get(m.recipient);
      if (!seen) byRecipient.set(m.recipient, m);
      else if (!seen.name && m.name) byRecipient.set(m.recipient, { ...seen, name: m.name });
    }
  }
  const unique = byRecipient.size;

  for (const src of recipe.exclude) {
    for (const m of sourceMembers(src.id)) byRecipient.delete(m.recipient);
  }

  return {
    members: [...byRecipient.values()],
    scanned,
    duplicates: scanned - unique,
    excluded: unique - byRecipient.size,
    missing,
  };
}

/** Every source id a recipe touches, deduplicated — what the editor fetches. */
export function recipeSourceIds(recipe: ListRecipe): string[] {
  return [...new Set([...recipe.include, ...recipe.exclude].map((s) => s.id))];
}

export function recipeIsEmpty(recipe: ListRecipe | null): boolean {
  return !recipe || !recipe.include.length;
}

/**
 * Lists that may be picked as a source. A list can't build on itself, and one
 * combined list can't feed another — nesting would mean a rebuild has to walk
 * (and order) a graph, and its member count would stop being a row count. One
 * level keeps "what am I sending to" answerable by looking at the rows.
 */
export function eligibleSources(all: RecipientList[], selfId?: string): RecipientList[] {
  return all.filter((l) => l.id !== selfId && recipeIsEmpty(l.recipe));
}

/** A source already used on the other side of the recipe can't be re-picked. */
export function usedSourceIds(recipe: ListRecipe): Set<string> {
  return new Set(recipeSourceIds(recipe));
}
