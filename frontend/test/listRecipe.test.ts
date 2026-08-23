import { describe, expect, it } from 'vitest';
import {
  eligibleSources,
  recipeIsEmpty,
  recipeSourceIds,
  resolveRecipe,
  usedSourceIds,
} from '../src/lib/listRecipe';
import type { ListMember, ListRecipe, RecipientList } from '../src/types';

const m = (recipient: string, name = ''): ListMember => ({ recipient, isGroup: false, name });
const src = (id: string) => ({ id, name: id });
const recipe = (include: string[], exclude: string[] = []): ListRecipe => ({
  v: 1,
  include: include.map(src),
  exclude: exclude.map(src),
});

const leads = [m('972521111111', 'Dana'), m('972522222222', 'Ron'), m('972523333333')];
const customers = [m('972523333333', 'Yael'), m('972524444444', 'Ori')];
const actives = [m('972522222222'), m('972529999999')];

const sources = new Map<string, ListMember[]>([
  ['leads', leads],
  ['customers', customers],
  ['actives', actives],
]);

describe('recipient list set math', () => {
  it('unions two lists, dedupes, then subtracts a third', () => {
    const res = resolveRecipe(recipe(['leads', 'customers'], ['actives']), sources);
    expect(res.members.map((x) => x.recipient)).toEqual([
      '972521111111',
      '972523333333',
      '972524444444',
    ]);
    // 5 rows scanned, 1 phone in both include lists, 1 unique dropped by actives
    expect(res).toMatchObject({ scanned: 5, duplicates: 1, excluded: 1, missing: [] });
  });

  it('an exclude list that overlaps nothing leaves the audience alone', () => {
    // actives holds 972522222222 + 972529999999, neither of which customers has
    const res = resolveRecipe(recipe(['customers'], ['actives']), sources);
    expect(res.members.map((x) => x.recipient)).toEqual(['972523333333', '972524444444']);
    expect(res).toMatchObject({ scanned: 2, duplicates: 0, excluded: 0 });
  });

  it('a later include fills a name the first left blank, never overwrites one', () => {
    const forward = resolveRecipe(recipe(['leads', 'customers']), sources);
    // leads has 972523333333 unnamed, customers names it Yael
    expect(forward.members.find((x) => x.recipient === '972523333333')?.name).toBe('Yael');
    const reverse = resolveRecipe(recipe(['customers', 'leads']), sources);
    // customers wins its own name when it comes first
    expect(reverse.members.find((x) => x.recipient === '972523333333')?.name).toBe('Yael');
    expect(reverse.members.find((x) => x.recipient === '972521111111')?.name).toBe('Dana');
  });

  it('reports a source it could not load instead of treating it as empty', () => {
    const res = resolveRecipe(recipe(['leads'], ['deleted']), sources);
    expect(res.missing).toEqual(['deleted']);
    // the members still come back, but the caller must refuse to save them:
    // a missing exclude list would silently widen the audience
    expect(res.members).toHaveLength(3);
  });

  it('excluding everything is allowed and lands on zero', () => {
    const res = resolveRecipe(recipe(['actives'], ['actives']), sources);
    expect(res.members).toEqual([]);
    expect(res).toMatchObject({ scanned: 2, duplicates: 0, excluded: 2 });
  });

  it('the same list on both sides of the recipe cancels out', () => {
    const res = resolveRecipe(recipe(['leads', 'customers'], ['leads']), sources);
    expect(res.members.map((x) => x.recipient)).toEqual(['972524444444']);
  });

  it('group jids ride along like any other recipient', () => {
    const groups = new Map<string, ListMember[]>([
      ['g', [{ recipient: '123-456@g.us', isGroup: true, name: 'Crew' }, m('972521111111')]],
      ['x', [m('972521111111')]],
    ]);
    const res = resolveRecipe(recipe(['g'], ['x']), groups);
    expect(res.members).toEqual([{ recipient: '123-456@g.us', isGroup: true, name: 'Crew' }]);
  });

  it('an empty recipe resolves to nothing', () => {
    const res = resolveRecipe(recipe([]), sources);
    expect(res).toMatchObject({ members: [], scanned: 0, duplicates: 0, excluded: 0 });
  });
});

describe('recipe helpers', () => {
  it('collects source ids once each, both sides included', () => {
    expect(recipeSourceIds(recipe(['a', 'b'], ['b', 'c']))).toEqual(['a', 'b', 'c']);
    expect(usedSourceIds(recipe(['a'], ['b']))).toEqual(new Set(['a', 'b']));
  });

  it('treats a recipe with no includes as empty', () => {
    expect(recipeIsEmpty(null)).toBe(true);
    expect(recipeIsEmpty(recipe([], ['a']))).toBe(true);
    expect(recipeIsEmpty(recipe(['a']))).toBe(false);
  });

  it('offers only hand-made lists other than the one being edited as sources', () => {
    const list = (id: string, r: ListRecipe | null = null): RecipientList => ({
      id,
      name: id,
      createdAt: '2026-08-19T00:00:00.000Z',
      memberCount: 1,
      recipe: r,
    });
    const all = [list('plain'), list('other'), list('combined', recipe(['plain'])), list('self')];
    expect(eligibleSources(all, 'self').map((l) => l.id)).toEqual(['plain', 'other']);
  });
});
