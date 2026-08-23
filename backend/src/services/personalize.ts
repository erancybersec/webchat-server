import type { JobItem } from '../types.js';

/**
 * Per-recipient template substitution in an item's human-visible text fields,
 * run at send time so one job fans out personalized copies without storing N
 * variants. Every tag takes an optional `|fallback`.
 *
 * Two name sources — the name the operator supplied (recipient table / saved
 * list) and the recipient's WhatsApp profile name, auto-fetched from the
 * contact book when the job runs — each sliced three ways:
 *
 *   {{first_name}}    {{wa_first_name}}   "דנה כהן" → "דנה"
 *   {{last_name}}     {{wa_last_name}}    "דנה כהן" → "כהן"
 *   {{full_name}}     {{wa_full_name}}    "דנה כהן" → "דנה כהן"
 *
 *   {{agent_name}} — display name of the agent who composed the job, kept
 *                    whole: it signs a message rather than addressing someone.
 *
 * `{{name}}` and `{{wa_name}}` are aliases of the two first-name tags. They
 * predate the rename and stay supported forever: job items, campaigns and
 * quick replies hold their text in the DB, so a saved "היי {{name}}" composed
 * a year ago has to keep sending a greeting rather than the literal tag.
 *
 * The stored name keeps its full form either way — lists and the recipients
 * table stay identifiable; only the outgoing copy is sliced.
 */

export interface PersonalizeVars {
  name: string;
  waName: string;
  agentName?: string;
}

// Only fields a recipient reads — never media payloads (base64/url) or ids.
const TEXT_FIELDS = [
  'text',
  'caption',
  'question',
  'title',
  'description',
  'footerText',
  'footer',
  'content',
] as const;

// Longest-first so a tag is never matched as the prefix of a longer one.
const TAGS = [
  'wa_first_name',
  'wa_last_name',
  'wa_full_name',
  'first_name',
  'last_name',
  'full_name',
  'agent_name',
  'wa_name', // alias of wa_first_name
  'name', // alias of first_name
] as const;

const PLACEHOLDER = new RegExp(`\\{\\{\\s*(${TAGS.join('|')})\\s*(?:\\|([^}]*))?\\}\\}`, 'g');
// Every tag that needs the contact book — the gate for fetching it at all.
const WA_TAG = /\{\{\s*wa_(?:first_|last_|full_)?name\s*(?:\|[^}]*)?\}\}/;

/**
 * The given name out of a display name: `"דנה כהן"` → `"דנה"`, `"Dana"` stays
 * `"Dana"`. First whitespace-separated token, minus trailing punctuation so a
 * "Cohen, Dana" style entry doesn't greet with a comma. A one-word entry —
 * including a bare phone number or a business name — is returned untouched,
 * and the fallback still covers the empty case.
 */
export function firstName(full: string): string {
  const [first = ''] = full.trim().split(/\s+/);
  return first.replace(/[,;:.]+$/, '');
}

/**
 * The family name out of a display name: `"דנה כהן"` → `"כהן"`. Last
 * whitespace-separated token; a one-word entry has no separate surname, so it
 * returns that word — same as {{first_name}} — rather than an empty string that
 * would silently swallow the greeting.
 */
export function lastName(full: string): string {
  const parts = full.trim().split(/\s+/);
  return (parts[parts.length - 1] ?? '').replace(/^[,;:.]+/, '');
}

export function substituteVars(text: string, vars: PersonalizeVars): string {
  return text.replace(PLACEHOLDER, (_, key: string, fallback: string | undefined) => {
    const value = resolveTag(key, vars);
    return value || (fallback ?? '').trim();
  });
}

function resolveTag(key: string, vars: PersonalizeVars): string {
  switch (key) {
    case 'agent_name':
      return (vars.agentName ?? '').trim();
    case 'full_name':
      return vars.name.trim();
    case 'last_name':
      return lastName(vars.name);
    case 'wa_full_name':
      return vars.waName.trim();
    case 'wa_last_name':
      return lastName(vars.waName);
    case 'wa_first_name':
    case 'wa_name':
      return firstName(vars.waName);
    // 'first_name' and its 'name' alias
    default:
      return firstName(vars.name);
  }
}

/** True when any text field of the item contains a personalization tag. */
export function hasPlaceholders(item: JobItem): boolean {
  const data = (item.data ?? {}) as Record<string, unknown>;
  return TEXT_FIELDS.some((f) => {
    const v = data[f];
    PLACEHOLDER.lastIndex = 0;
    return typeof v === 'string' && PLACEHOLDER.test(v);
  });
}

/** Whether any item wants a wa_* tag — gates the contact-book fetch. */
export function usesWaName(items: JobItem[]): boolean {
  return items.some((item) => {
    const data = (item.data ?? {}) as Record<string, unknown>;
    return TEXT_FIELDS.some((f) => typeof data[f] === 'string' && WA_TAG.test(data[f] as string));
  });
}

/**
 * Returns a personalized copy of the item, or the item itself when nothing
 * needs substituting (the common case — no copy, no re-serialization).
 */
export function personalizeItem(item: JobItem, vars: PersonalizeVars): JobItem {
  if (!hasPlaceholders(item)) return item;
  const data: Record<string, unknown> = { ...(item.data ?? {}) };
  for (const f of TEXT_FIELDS) {
    const v = data[f];
    if (typeof v === 'string') data[f] = substituteVars(v, vars);
  }
  return { ...item, data };
}
