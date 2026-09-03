import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, type OfferingInput, type ServerSettings } from '../lib/api';
import { useInstances } from '../lib/instance';
import type {
  AiModelTier,
  AiProviderName,
  AiTestResult,
  KnowledgeArticle,
  StudioOffering,
} from '../types';
import { useConfirm } from './Confirm';
import { Switch } from './Switch';
import { useToast } from './Toast';

const TABS = [
  { id: 'general', label: 'General' },
  { id: 'instructions', label: 'Instructions' },
  { id: 'knowledge', label: 'Knowledge' },
  { id: 'studio', label: 'Studio Data' },
  { id: 'handoff', label: 'Handoff' },
  { id: 'test', label: 'Test' },
] as const;

type TabId = (typeof TABS)[number]['id'];

const AGE_GROUPS = ['', 'child', 'teen', 'adult'] as const;
const DAYS = ['', 'sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

const AVAILABILITY_MAX_AGE_HOURS = 24;

const field = 'w-full rounded-md border border-gray-300 px-3 py-2 text-sm';
const smallField = 'w-full rounded-md border border-gray-300 px-2 py-1.5 text-xs';
const card = 'space-y-4 rounded-xl border border-gray-200 bg-white p-5 shadow-sm';
const label = 'mb-1 block text-sm font-medium text-gray-700';
const hint = 'text-xs text-gray-500';

/** ISO timestamp → "3h ago", for freshness columns that have to read at a glance. */
function ago(iso: string | null): string {
  if (!iso) return 'never';
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(mins)) return 'never';
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

const isStale = (iso: string | null): boolean =>
  !iso || Date.now() - Date.parse(iso) > AVAILABILITY_MAX_AGE_HOURS * 3_600_000;

// ---------------------------------------------------------------------------
// General
// ---------------------------------------------------------------------------

interface DraftGeneral {
  enabled: boolean;
  instances: string[];
  provider: AiProviderName;
  tier: AiModelTier;
  model: string;
  apiKey: string;
}

function GeneralTab({
  settings,
  draft,
  set,
}: {
  settings: ServerSettings;
  draft: DraftGeneral;
  set: (patch: Partial<DraftGeneral>) => void;
}) {
  const instancesList = useInstances();
  const lines = instancesList.data?.instances ?? [];
  const noLines = draft.instances.length === 0;

  return (
    <div className={card}>
      <h3 className="text-sm font-semibold text-gray-700">AI agent</h3>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-gray-700">Answer inbound leads automatically</p>
          <p className={hint}>
            The AI replies to new inbound messages on the channels you pick below. It can look up
            knowledge, the timetable, prices, live offers and availability — and it can hand a
            conversation to a person. It cannot register, book, cancel, freeze, discount or charge
            anything.
          </p>
        </div>
        <Switch
          on={draft.enabled}
          onToggle={() => set({ enabled: !draft.enabled })}
          label="Enable the AI agent"
        />
      </div>

      {draft.enabled && noLines && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
          No channels selected — the AI will not answer anyone. Pick at least one line below.
        </p>
      )}
      {draft.enabled && !settings.aiAgentApiKeySet && !draft.apiKey.trim() && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
          No API key saved — every turn will fail until one is set.
        </p>
      )}

      <div>
        <p className={label}>Channels the AI answers on</p>
        <p className={`mb-2 ${hint}`}>
          An explicit allow-list, empty by default. Nothing is implicit: a line nobody ticked is
          never answered, whatever the switch above says.
        </p>
        <div className="flex flex-wrap gap-2">
          {lines.map((i) => {
            const on = draft.instances.includes(i.name);
            const def = i.name === instancesList.data?.default;
            return (
              <label
                key={i.name}
                className={`flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1 text-xs ${
                  on ? 'border-wa bg-green-50 text-wa-dark' : 'border-gray-200 text-gray-600'
                }`}
              >
                <input
                  type="checkbox"
                  className="accent-wa"
                  checked={on}
                  onChange={(e) =>
                    set({
                      instances: e.target.checked
                        ? [...draft.instances, i.name]
                        : draft.instances.filter((n) => n !== i.name),
                    })
                  }
                />
                {i.name}
                {def && <span className="text-[10px] text-gray-400">(default)</span>}
              </label>
            );
          })}
          {lines.length === 0 && <p className="text-xs text-gray-400">No channels available.</p>}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className={label}>Provider</label>
          <select
            value={draft.provider}
            onChange={(e) => set({ provider: e.target.value as AiProviderName })}
            className={field}
          >
            <option value="anthropic">Anthropic (Claude)</option>
            <option value="openai">OpenAI</option>
          </select>
        </div>
        <div>
          <label className={label}>Model tier</label>
          <select
            value={draft.tier}
            onChange={(e) => set({ tier: e.target.value as AiModelTier })}
            className={field}
          >
            <option value="fast">Fast — cheapest, best for routine questions</option>
            <option value="balanced">Balanced</option>
            <option value="best">Best — most capable, most expensive</option>
            <option value="custom">Custom model id…</option>
          </select>
        </div>
      </div>

      {draft.tier === 'custom' ? (
        <div>
          <label className={label}>Model id</label>
          <input
            value={draft.model}
            onChange={(e) => set({ model: e.target.value })}
            placeholder="claude-haiku-4-5-20251001"
            className={field}
          />
        </div>
      ) : (
        <p className={hint}>
          Currently resolves to <code className="text-gray-600">{settings.aiAgentResolvedModel}</code>.
        </p>
      )}

      <div>
        <label className={label}>API key</label>
        <input
          type="password"
          value={draft.apiKey}
          onChange={(e) => set({ apiKey: e.target.value })}
          placeholder={
            settings.aiAgentApiKeySet
              ? `saved ${settings.aiAgentApiKeyHint} — leave blank to keep`
              : 'Provider API key'
          }
          className={field}
        />
        <p className={`mt-1 ${hint}`}>
          Stored on the server and never sent back to the browser, never put in a prompt, a tool
          result or the audit log.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Instructions
// ---------------------------------------------------------------------------

function InstructionsTab({
  settings,
  persona,
  rules,
  setPersona,
  setRules,
}: {
  settings: ServerSettings;
  persona: string;
  rules: string;
  setPersona: (v: string) => void;
  setRules: (v: string) => void;
}) {
  const [showRules, setShowRules] = useState(false);
  return (
    <div className={card}>
      <h3 className="text-sm font-semibold text-gray-700">Instructions</h3>
      <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
        <button
          onClick={() => setShowRules((v) => !v)}
          className="flex w-full items-center justify-between text-left text-xs font-medium text-gray-600"
        >
          <span>Fixed safety rules — always applied first, before anything below</span>
          <span className="text-gray-400">{showRules ? 'hide' : 'show'}</span>
        </button>
        {showRules && (
          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-[11px] leading-relaxed text-gray-500">
            {settings.aiAgentSafetyRules}
          </pre>
        )}
      </div>
      <div>
        <label className={label}>Persona and tone</label>
        <p className={`mb-1 ${hint}`}>
          Who the assistant is, what language it answers in, how long its replies should be. Example
          replies help more than adjectives.
        </p>
        <textarea
          value={persona}
          onChange={(e) => setPersona(e.target.value)}
          rows={8}
          placeholder={
            'You are Maya from Studio Shimshi. Answer in the language the customer wrote in…'
          }
          className={field}
        />
      </div>
      <div>
        <label className={label}>Rules and boundaries</label>
        <p className={`mb-1 ${hint}`}>
          Studio-specific limits on top of the fixed rules above — what not to discuss, what always
          needs a person.
        </p>
        <textarea
          value={rules}
          onChange={(e) => setRules(e.target.value)}
          rows={6}
          placeholder="Never compare us to other studios. Never quote a price for private lessons…"
          className={field}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Knowledge
// ---------------------------------------------------------------------------

const emptyArticle = { title: '', category: '', content: '', keywords: '' };

function KnowledgeTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const list = useQuery({ queryKey: ['ai-knowledge'], queryFn: api.aiAgent.knowledge.list });
  const [draft, setDraft] = useState(emptyArticle);
  const [editing, setEditing] = useState<KnowledgeArticle | null>(null);

  const refresh = () => void qc.invalidateQueries({ queryKey: ['ai-knowledge'] });
  const fail = (e: unknown) => toast(String((e as Error).message), 'err');

  const create = useMutation({
    mutationFn: () => api.aiAgent.knowledge.create(draft),
    onSuccess: () => {
      setDraft(emptyArticle);
      toast('Article added');
      refresh();
    },
    onError: fail,
  });
  const update = useMutation({
    mutationFn: (a: KnowledgeArticle) =>
      api.aiAgent.knowledge.update(a.id, {
        title: a.title,
        category: a.category,
        content: a.content,
        keywords: a.keywords,
        active: a.active,
      }),
    onSuccess: () => {
      setEditing(null);
      toast('Article saved');
      refresh();
    },
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: (id: number) => api.aiAgent.knowledge.remove(id),
    onSuccess: () => {
      toast('Article deleted');
      refresh();
    },
    onError: fail,
  });

  async function askRemove(a: KnowledgeArticle) {
    if (
      await confirm({
        title: `Delete “${a.title}”?`,
        body: 'The AI will stop being able to retrieve it.',
        confirmLabel: 'Delete',
        danger: true,
      })
    )
      remove.mutate(a.id);
  }

  return (
    <div className={card}>
      <h3 className="text-sm font-semibold text-gray-700">Knowledge base</h3>
      <p className={hint}>
        Stable facts only — policies, FAQ, trial details, how a branch works. Anything that changes
        week to week belongs in Studio Data instead. The AI may only state what a lookup here (or a
        studio-data lookup) actually returned.
      </p>

      <div className="space-y-2 rounded-lg border border-gray-200 bg-gray-50 p-3">
        <div className="grid gap-2 sm:grid-cols-2">
          <input
            value={draft.title}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            placeholder="Title, e.g. Trial class policy"
            className={smallField}
          />
          <input
            value={draft.category}
            onChange={(e) => setDraft({ ...draft, category: e.target.value })}
            placeholder="Category (optional)"
            className={smallField}
          />
        </div>
        <textarea
          value={draft.content}
          onChange={(e) => setDraft({ ...draft, content: e.target.value })}
          rows={3}
          placeholder="The answer, in the words you would want a customer to read."
          className={smallField}
        />
        <input
          value={draft.keywords}
          onChange={(e) => setDraft({ ...draft, keywords: e.target.value })}
          placeholder="Keywords, comma-separated — these steer retrieval the most"
          className={smallField}
        />
        <button
          onClick={() => create.mutate()}
          disabled={!draft.title.trim() || !draft.content.trim() || create.isPending}
          className="rounded-md bg-wa px-3 py-1.5 text-xs font-semibold text-white hover:bg-wa-dark disabled:opacity-50"
        >
          Add article
        </button>
      </div>

      {list.isLoading && <p className="text-xs text-gray-400">Loading…</p>}
      {list.data?.length === 0 && (
        <p className="text-xs text-gray-400">
          Nothing here yet — with an empty knowledge base the AI can only hand off.
        </p>
      )}
      <div className="space-y-2">
        {(list.data ?? []).map((a) =>
          editing?.id === a.id ? (
            <div key={a.id} className="space-y-2 rounded-lg border border-wa bg-green-50/40 p-3">
              <div className="grid gap-2 sm:grid-cols-2">
                <input
                  value={editing.title}
                  onChange={(e) => setEditing({ ...editing, title: e.target.value })}
                  className={smallField}
                />
                <input
                  value={editing.category}
                  onChange={(e) => setEditing({ ...editing, category: e.target.value })}
                  placeholder="Category"
                  className={smallField}
                />
              </div>
              <textarea
                value={editing.content}
                onChange={(e) => setEditing({ ...editing, content: e.target.value })}
                rows={4}
                className={smallField}
              />
              <input
                value={editing.keywords}
                onChange={(e) => setEditing({ ...editing, keywords: e.target.value })}
                placeholder="Keywords"
                className={smallField}
              />
              <div className="flex items-center gap-2">
                <button
                  onClick={() => update.mutate(editing)}
                  disabled={!editing.title.trim() || !editing.content.trim()}
                  className="rounded-md bg-wa px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
                >
                  Save
                </button>
                <button
                  onClick={() => setEditing(null)}
                  className="rounded-md border border-gray-300 px-3 py-1.5 text-xs text-gray-600"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div
              key={a.id}
              className="flex items-start justify-between gap-3 rounded-lg border border-gray-200 p-3"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-gray-800">
                  {a.title}
                  {a.category && <span className="ml-2 text-[11px] text-gray-400">{a.category}</span>}
                  {!a.active && (
                    <span className="ml-2 rounded bg-gray-100 px-1.5 text-[10px] text-gray-500">
                      inactive
                    </span>
                  )}
                </p>
                <p className="mt-0.5 line-clamp-2 text-xs text-gray-500">{a.content}</p>
                {a.keywords && <p className="mt-0.5 text-[11px] text-gray-400">{a.keywords}</p>}
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <button
                  onClick={() => update.mutate({ ...a, active: !a.active })}
                  className="rounded-md border border-gray-300 px-2 py-1 text-[11px] text-gray-600"
                >
                  {a.active ? 'Disable' : 'Enable'}
                </button>
                <button
                  onClick={() => setEditing(a)}
                  className="rounded-md border border-gray-300 px-2 py-1 text-[11px] text-gray-600"
                >
                  Edit
                </button>
                <button
                  onClick={() => void askRemove(a)}
                  className="rounded-md border border-red-200 px-2 py-1 text-[11px] text-red-600"
                >
                  Delete
                </button>
              </div>
            </div>
          ),
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Studio data
// ---------------------------------------------------------------------------

const emptyOffering: OfferingInput = {
  title: '',
  branch: '',
  ageGroup: '',
  level: '',
  dayOfWeek: '',
  time: '',
  price: '',
  notes: '',
  isOffer: false,
  validUntil: null,
};

function StudioDataTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const list = useQuery({ queryKey: ['ai-offerings'], queryFn: api.aiAgent.offerings.list });
  const [draft, setDraft] = useState<OfferingInput>(emptyOffering);
  const [editing, setEditing] = useState<StudioOffering | null>(null);
  const [recheck, setRecheck] = useState<Record<number, string>>({});

  const refresh = () => void qc.invalidateQueries({ queryKey: ['ai-offerings'] });
  const fail = (e: unknown) => toast(String((e as Error).message), 'err');

  const create = useMutation({
    mutationFn: () => api.aiAgent.offerings.create(draft),
    onSuccess: () => {
      setDraft(emptyOffering);
      toast('Row added');
      refresh();
    },
    onError: fail,
  });
  const update = useMutation({
    mutationFn: (o: StudioOffering) =>
      api.aiAgent.offerings.update(o.id, {
        title: o.title,
        branch: o.branch,
        ageGroup: o.ageGroup,
        level: o.level,
        dayOfWeek: o.dayOfWeek,
        time: o.time,
        price: o.price,
        notes: o.notes,
        isOffer: o.isOffer,
        active: o.active,
        validUntil: o.validUntil,
      }),
    onSuccess: () => {
      setEditing(null);
      toast('Row saved');
      refresh();
    },
    onError: fail,
  });
  const doRecheck = useMutation({
    mutationFn: (v: { id: number; spotsLeft: number | null }) =>
      api.aiAgent.offerings.recheck(v.id, v.spotsLeft),
    onSuccess: (row) => {
      setRecheck((p) => ({ ...p, [row.id]: '' }));
      toast('Availability rechecked');
      refresh();
    },
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: (id: number) => api.aiAgent.offerings.remove(id),
    onSuccess: () => {
      toast('Row deleted');
      refresh();
    },
    onError: fail,
  });

  async function askRemove(o: StudioOffering) {
    if (
      await confirm({
        title: `Delete “${o.title}”?`,
        confirmLabel: 'Delete',
        danger: true,
      })
    )
      remove.mutate(o.id);
  }

  const enumSelect = (
    value: string,
    options: readonly string[],
    onChange: (v: string) => void,
    blankLabel: string,
  ) => (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={smallField}>
      {options.map((o) => (
        <option key={o} value={o}>
          {o === '' ? blankLabel : o}
        </option>
      ))}
    </select>
  );

  return (
    <div className={card}>
      <h3 className="text-sm font-semibold text-gray-700">Studio data</h3>
      <p className={hint}>
        The timetable, prices, live offers and how many places are left. The AI can only quote what
        is here. Two rules worth knowing: an offer with no end date is <strong>never</strong> shown
        to a customer, and a spots-left count is only quotable for {AVAILABILITY_MAX_AGE_HOURS} hours
        after you recheck it — editing anything else on the row does not refresh it.
      </p>

      <div className="space-y-2 rounded-lg border border-gray-200 bg-gray-50 p-3">
        <div className="grid gap-2 sm:grid-cols-3">
          <input
            value={draft.title ?? ''}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            placeholder="Class or offer name"
            className={smallField}
          />
          <input
            value={draft.branch ?? ''}
            onChange={(e) => setDraft({ ...draft, branch: e.target.value })}
            placeholder="Branch"
            className={smallField}
          />
          <input
            value={draft.price ?? ''}
            onChange={(e) => setDraft({ ...draft, price: e.target.value })}
            placeholder="Price, e.g. ₪120/mo"
            className={smallField}
          />
        </div>
        <div className="grid gap-2 sm:grid-cols-4">
          {enumSelect(draft.ageGroup ?? '', AGE_GROUPS, (v) => setDraft({ ...draft, ageGroup: v }), 'all ages')}
          {enumSelect(draft.dayOfWeek ?? '', DAYS, (v) => setDraft({ ...draft, dayOfWeek: v }), 'no fixed day')}
          <input
            value={draft.time ?? ''}
            onChange={(e) => setDraft({ ...draft, time: e.target.value })}
            placeholder="HH:MM"
            className={smallField}
          />
          <input
            value={draft.level ?? ''}
            onChange={(e) => setDraft({ ...draft, level: e.target.value })}
            placeholder="Level"
            className={smallField}
          />
        </div>
        <div className="grid gap-2 sm:grid-cols-3">
          <label className="flex items-center gap-2 text-xs text-gray-600">
            <input
              type="checkbox"
              className="accent-wa"
              checked={!!draft.isOffer}
              onChange={(e) => setDraft({ ...draft, isOffer: e.target.checked })}
            />
            This is a promotion / discount
          </label>
          <input
            type="date"
            value={draft.validUntil ?? ''}
            onChange={(e) => setDraft({ ...draft, validUntil: e.target.value || null })}
            aria-label="Valid until"
            className={smallField}
          />
          <input
            type="number"
            min={0}
            value={draft.spotsLeft ?? ''}
            onChange={(e) =>
              setDraft({ ...draft, spotsLeft: e.target.value === '' ? null : Number(e.target.value) })
            }
            placeholder="Spots left (optional)"
            className={smallField}
          />
        </div>
        {draft.isOffer && !draft.validUntil && (
          <p className="text-[11px] text-amber-600">
            A promotion needs an end date — an open-ended discount is never shown.
          </p>
        )}
        <input
          value={draft.notes ?? ''}
          onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
          placeholder="Notes the AI may repeat (optional)"
          className={smallField}
        />
        <button
          onClick={() => create.mutate()}
          disabled={!draft.title?.trim() || create.isPending}
          className="rounded-md bg-wa px-3 py-1.5 text-xs font-semibold text-white hover:bg-wa-dark disabled:opacity-50"
        >
          Add row
        </button>
      </div>

      {list.isLoading && <p className="text-xs text-gray-400">Loading…</p>}
      {list.data?.length === 0 && <p className="text-xs text-gray-400">No studio data yet.</p>}

      <div className="space-y-2">
        {(list.data ?? []).map((o) =>
          editing?.id === o.id ? (
            <div key={o.id} className="space-y-2 rounded-lg border border-wa bg-green-50/40 p-3">
              <div className="grid gap-2 sm:grid-cols-3">
                <input
                  value={editing.title}
                  onChange={(e) => setEditing({ ...editing, title: e.target.value })}
                  className={smallField}
                />
                <input
                  value={editing.branch}
                  onChange={(e) => setEditing({ ...editing, branch: e.target.value })}
                  placeholder="Branch"
                  className={smallField}
                />
                <input
                  value={editing.price}
                  onChange={(e) => setEditing({ ...editing, price: e.target.value })}
                  placeholder="Price"
                  className={smallField}
                />
              </div>
              <div className="grid gap-2 sm:grid-cols-4">
                {enumSelect(editing.ageGroup, AGE_GROUPS, (v) => setEditing({ ...editing, ageGroup: v }), 'all ages')}
                {enumSelect(editing.dayOfWeek, DAYS, (v) => setEditing({ ...editing, dayOfWeek: v }), 'no fixed day')}
                <input
                  value={editing.time}
                  onChange={(e) => setEditing({ ...editing, time: e.target.value })}
                  placeholder="HH:MM"
                  className={smallField}
                />
                <input
                  type="date"
                  value={editing.validUntil ?? ''}
                  onChange={(e) => setEditing({ ...editing, validUntil: e.target.value || null })}
                  aria-label="Valid until"
                  className={smallField}
                />
              </div>
              <input
                value={editing.notes}
                onChange={(e) => setEditing({ ...editing, notes: e.target.value })}
                placeholder="Notes"
                className={smallField}
              />
              <p className="text-[11px] text-gray-500">
                Spots left is edited with “Recheck” only — that is what stamps the freshness stamp.
              </p>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => update.mutate(editing)}
                  disabled={!editing.title.trim()}
                  className="rounded-md bg-wa px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
                >
                  Save
                </button>
                <button
                  onClick={() => setEditing(null)}
                  className="rounded-md border border-gray-300 px-3 py-1.5 text-xs text-gray-600"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div key={o.id} className="rounded-lg border border-gray-200 p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-gray-800">
                    {o.title}
                    {o.isOffer && (
                      <span className="ml-2 rounded bg-amber-100 px-1.5 text-[10px] text-amber-700">
                        offer
                      </span>
                    )}
                    {!o.active && (
                      <span className="ml-2 rounded bg-gray-100 px-1.5 text-[10px] text-gray-500">
                        inactive
                      </span>
                    )}
                  </p>
                  <p className="mt-0.5 text-xs text-gray-500">
                    {[
                      o.branch,
                      o.ageGroup || 'all ages',
                      o.level,
                      o.dayOfWeek && o.time ? `${o.dayOfWeek} ${o.time}` : o.dayOfWeek || o.time,
                      o.price,
                      o.validUntil ? `until ${o.validUntil}` : o.isOffer ? 'NO END DATE' : '',
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                  {o.isOffer && !o.validUntil && (
                    <p className="mt-0.5 text-[11px] text-amber-600">
                      Never shown to customers — an offer needs an end date.
                    </p>
                  )}
                  {o.notes && <p className="mt-0.5 text-[11px] text-gray-400">{o.notes}</p>}
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    onClick={() => update.mutate({ ...o, active: !o.active })}
                    className="rounded-md border border-gray-300 px-2 py-1 text-[11px] text-gray-600"
                  >
                    {o.active ? 'Disable' : 'Enable'}
                  </button>
                  <button
                    onClick={() => setEditing(o)}
                    className="rounded-md border border-gray-300 px-2 py-1 text-[11px] text-gray-600"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => void askRemove(o)}
                    className="rounded-md border border-red-200 px-2 py-1 text-[11px] text-red-600"
                  >
                    Delete
                  </button>
                </div>
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-gray-100 pt-2">
                <span className="text-[11px] text-gray-500">
                  Spots left:{' '}
                  <strong className="text-gray-700">{o.spotsLeft ?? 'not tracked'}</strong> · checked{' '}
                  <span className={isStale(o.availabilityUpdatedAt) ? 'text-amber-600' : 'text-wa-dark'}>
                    {ago(o.availabilityUpdatedAt)}
                  </span>
                  {o.spotsLeft != null && isStale(o.availabilityUpdatedAt) && ' — too old to quote'}
                </span>
                <input
                  type="number"
                  min={0}
                  value={recheck[o.id] ?? ''}
                  onChange={(e) => setRecheck((p) => ({ ...p, [o.id]: e.target.value }))}
                  placeholder="count"
                  aria-label={`New spots-left count for ${o.title}`}
                  className="w-20 rounded-md border border-gray-300 px-2 py-1 text-xs"
                />
                <button
                  onClick={() =>
                    doRecheck.mutate({
                      id: o.id,
                      spotsLeft: (recheck[o.id] ?? '') === '' ? null : Number(recheck[o.id]),
                    })
                  }
                  className="rounded-md border border-wa px-2 py-1 text-[11px] font-medium text-wa-dark"
                >
                  Recheck
                </button>
                <span className="text-[11px] text-gray-400">(blank = stop tracking)</span>
              </div>
            </div>
          ),
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Handoff
// ---------------------------------------------------------------------------

interface DraftHandoff {
  escalation: string;
  handoffMessage: string;
  maxReplies: string;
  sessionGapHours: string;
  dailyCap: string;
  replyDelaySec: string;
}

function HandoffTab({
  draft,
  set,
}: {
  draft: DraftHandoff;
  set: (patch: Partial<DraftHandoff>) => void;
}) {
  const num = (
    key: keyof DraftHandoff,
    title: string,
    body: string,
    unit: string,
    min = 0,
  ) => (
    <div className="flex items-start justify-between gap-3">
      <div>
        <p className="text-sm font-medium text-gray-700">{title}</p>
        <p className={hint}>{body}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <input
          type="number"
          min={min}
          step={1}
          value={draft[key]}
          onChange={(e) => set({ [key]: e.target.value } as Partial<DraftHandoff>)}
          aria-label={title}
          className="w-20 rounded-md border border-gray-300 px-3 py-2 text-sm"
        />
        <span className="text-sm text-gray-500">{unit}</span>
      </div>
    </div>
  );

  return (
    <div className={card}>
      <h3 className="text-sm font-semibold text-gray-700">Handoff and limits</h3>
      <div>
        <label className={label}>Escalation guidance</label>
        <p className={`mb-1 ${hint}`}>
          When to fetch a person, in your words. The fixed rules already cover actions, account and
          billing issues, and anything the AI can&apos;t answer reliably.
        </p>
        <textarea
          value={draft.escalation}
          onChange={(e) => set({ escalation: e.target.value })}
          rows={5}
          placeholder="Hand off anyone asking about competition teams, or any parent who sounds upset…"
          className={field}
        />
      </div>
      <div>
        <label className={label}>Handoff message</label>
        <p className={`mb-1 ${hint}`}>
          Sent when the AI hands off with nothing useful of its own to say, and whenever a voice
          note, photo or document arrives. Leave blank to send nothing at all.
        </p>
        <input
          value={draft.handoffMessage}
          onChange={(e) => set({ handoffMessage: e.target.value })}
          className={field}
        />
      </div>
      <div className="space-y-4 border-t border-gray-100 pt-4">
        {num(
          'maxReplies',
          'Replies per conversation',
          'How many times the AI may answer in one session. Hitting it pauses that chat until the person comes back after the gap below.',
          'replies',
          1,
        )}
        {num(
          'sessionGapHours',
          'New session after',
          'A lead who goes quiet this long and then writes again starts a fresh session with a fresh reply allowance.',
          'hours',
          1,
        )}
        {num(
          'dailyCap',
          'Total replies per day',
          'A cost ceiling across every chat and every line. Reaching it delays replies until midnight — it never pauses a conversation and never needs a manual resume.',
          'replies',
          0,
        )}
        {num(
          'replyDelaySec',
          'Wait before replying',
          'A lead typing three lines in a row gets one considered answer instead of three.',
          'seconds',
          0,
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

interface SandboxTurn {
  role: 'customer' | 'agent';
  text: string;
}

function TestTab({ ready }: { ready: boolean }) {
  const toast = useToast();
  const [message, setMessage] = useState('');
  const [turns, setTurns] = useState<SandboxTurn[]>([]);
  const [last, setLast] = useState<AiTestResult | null>(null);

  const run = useMutation({
    mutationFn: (text: string) => api.aiAgent.test(text, turns),
    onSuccess: (r, text) => {
      setLast(r);
      setTurns((prev) => [
        ...prev,
        { role: 'customer', text },
        ...(r.reply ? [{ role: 'agent' as const, text: r.reply }] : []),
      ]);
      setMessage('');
    },
    onError: (e) => toast(String((e as Error).message), 'err'),
  });

  return (
    <div className={card}>
      <h3 className="text-sm font-semibold text-gray-700">Test sandbox</h3>
      <p className={hint}>
        Runs the real agent against your real knowledge and studio data, and never sends a WhatsApp
        message to anyone. Each message continues the conversation above it, so you can test a
        multi-turn exchange. It works whether or not the agent is switched on.
      </p>
      {!ready && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
          Save an API key on the General tab first.
        </p>
      )}

      {turns.length > 0 && (
        <div className="max-h-72 space-y-2 overflow-y-auto rounded-lg border border-gray-200 bg-gray-50 p-3">
          {turns.map((t, i) => (
            <div key={i} className={t.role === 'customer' ? 'text-left' : 'text-right'}>
              <span
                className={`inline-block max-w-[80%] whitespace-pre-wrap rounded-lg px-3 py-1.5 text-xs ${
                  t.role === 'customer' ? 'bg-white text-gray-700' : 'bg-green-100 text-wa-dark'
                }`}
              >
                {t.text}
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-end gap-2">
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={2}
          placeholder="Type what a lead would write…"
          className={field}
        />
        <button
          onClick={() => run.mutate(message.trim())}
          disabled={!ready || !message.trim() || run.isPending}
          className="shrink-0 rounded-md bg-wa px-3 py-2 text-xs font-semibold text-white hover:bg-wa-dark disabled:opacity-50"
        >
          {run.isPending ? 'Thinking…' : 'Send'}
        </button>
        <button
          onClick={() => {
            setTurns([]);
            setLast(null);
          }}
          disabled={!turns.length}
          className="shrink-0 rounded-md border border-gray-300 px-3 py-2 text-xs text-gray-600 disabled:opacity-50"
        >
          Reset
        </button>
      </div>

      {last && (
        <div className="space-y-3 rounded-lg border border-gray-200 p-3">
          <div className="flex flex-wrap gap-2 text-[11px]">
            <span
              className={`rounded-full px-2 py-0.5 ${
                last.handoff ? 'bg-amber-100 text-amber-700' : 'bg-green-100 text-wa-dark'
              }`}
            >
              {last.handoff ? 'hands off' : 'answered'}
            </span>
            {last.invalidFinal && (
              <span className="rounded-full bg-red-100 px-2 py-0.5 text-red-700">
                no valid response — handed off
              </span>
            )}
            <span className="rounded-full bg-gray-100 px-2 py-0.5 text-gray-600">{last.model}</span>
            <span className="rounded-full bg-gray-100 px-2 py-0.5 text-gray-600">
              {last.rounds} round{last.rounds === 1 ? '' : 's'}
            </span>
            <span className="rounded-full bg-gray-100 px-2 py-0.5 text-gray-600">
              {last.latencyMs} ms
            </span>
            <span className="rounded-full bg-gray-100 px-2 py-0.5 text-gray-600">
              {last.usage.inputTokens} in / {last.usage.outputTokens} out
              {last.usage.cacheReadTokens ? ` (${last.usage.cacheReadTokens} cached)` : ''}
            </span>
          </div>
          {last.handoffReason && (
            <p className="text-xs text-gray-600">
              <span className="text-gray-400">Handoff reason:</span> {last.handoffReason}
            </p>
          )}
          {last.error && <p className="text-xs text-red-600">{last.error}</p>}
          {Object.keys(last.memoryUpdates).length > 0 && (
            <div>
              <p className="text-[11px] font-medium text-gray-500">Would remember</p>
              <pre className="mt-1 overflow-auto rounded bg-gray-50 p-2 text-[11px] text-gray-600">
                {JSON.stringify(last.memoryUpdates, null, 2)}
              </pre>
            </div>
          )}
          {last.toolsCalled.length > 0 && (
            <div>
              <p className="text-[11px] font-medium text-gray-500">Lookups</p>
              <div className="mt-1 space-y-1">
                {last.toolsCalled.map((t) => (
                  <details key={t.id} className="rounded bg-gray-50 p-2 text-[11px] text-gray-600">
                    <summary className="cursor-pointer">
                      {t.name}
                      <span className="ml-2 text-gray-400">{JSON.stringify(t.args)}</span>
                    </summary>
                    <pre className="mt-1 overflow-auto">{JSON.stringify(t.result, null, 2)}</pre>
                  </details>
                ))}
              </div>
            </div>
          )}
          {last.knowledgeUsed.length > 0 && (
            <p className="text-[11px] text-gray-500">
              Knowledge articles used: {last.knowledgeUsed.join(', ')}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section shell
// ---------------------------------------------------------------------------

/**
 * The AI Agent settings section: one tab strip over six panels.
 *
 * It carries its own Save button rather than riding the page's global one,
 * because the knowledge/studio/test tabs are already self-saving and mixing the
 * two would make "Save settings" mean different things depending on which tab
 * happened to be open.
 */
export function AiAgentSettings({ settings }: { settings: ServerSettings }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [tab, setTab] = useState<TabId>('general');
  const [busy, setBusy] = useState(false);
  const [general, setGeneral] = useState<DraftGeneral>({
    enabled: false,
    instances: [],
    provider: 'anthropic',
    tier: 'fast',
    model: '',
    apiKey: '',
  });
  const [persona, setPersona] = useState('');
  const [rules, setRules] = useState('');
  const [handoff, setHandoff] = useState<DraftHandoff>({
    escalation: '',
    handoffMessage: '',
    maxReplies: '20',
    sessionGapHours: '48',
    dailyCap: '200',
    replyDelaySec: '10',
  });

  useEffect(() => {
    setGeneral({
      enabled: settings.aiAgentEnabled,
      instances: settings.aiAgentInstances ?? [],
      provider: settings.aiAgentProvider,
      tier: settings.aiAgentModelTier,
      model: settings.aiAgentModel,
      apiKey: '',
    });
    setPersona(settings.aiAgentPersona);
    setRules(settings.aiAgentRules);
    setHandoff({
      escalation: settings.aiAgentEscalation,
      handoffMessage: settings.aiAgentHandoffMessage,
      maxReplies: String(settings.aiAgentMaxRepliesPerSession),
      sessionGapHours: String(settings.aiAgentSessionGapHours),
      dailyCap: String(settings.aiAgentDailyCap),
      replyDelaySec: String(settings.aiAgentReplyDelaySec),
    });
  }, [settings]);

  async function save() {
    // The same bounds the server enforces — checking here saves a round-trip
    // and points at the field instead of returning a generic 400.
    const numbers: Array<[string, string, number, number]> = [
      ['Replies per conversation', handoff.maxReplies, 1, 500],
      ['New session after', handoff.sessionGapHours, 1, 8_760],
      ['Total replies per day', handoff.dailyCap, 0, 100_000],
      ['Wait before replying', handoff.replyDelaySec, 0, 3_600],
    ];
    for (const [name, raw, min, max] of numbers) {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < min || n > max)
        return toast(`${name} must be a whole number between ${min} and ${max}`, 'err');
    }
    if (general.tier === 'custom' && !general.model.trim())
      return toast('A custom tier needs a model id', 'err');
    setBusy(true);
    try {
      await api.settings.save({
        aiAgentEnabled: general.enabled,
        aiAgentInstances: general.instances,
        aiAgentProvider: general.provider,
        aiAgentModelTier: general.tier,
        aiAgentModel: general.model.trim(),
        ...(general.apiKey.trim() ? { aiAgentApiKey: general.apiKey.trim() } : {}),
        aiAgentPersona: persona,
        aiAgentRules: rules,
        aiAgentEscalation: handoff.escalation,
        aiAgentHandoffMessage: handoff.handoffMessage,
        aiAgentMaxRepliesPerSession: Number(handoff.maxReplies),
        aiAgentSessionGapHours: Number(handoff.sessionGapHours),
        aiAgentDailyCap: Number(handoff.dailyCap),
        aiAgentReplyDelaySec: Number(handoff.replyDelaySec),
      });
      setGeneral((g) => ({ ...g, apiKey: '' }));
      toast('AI agent settings saved');
      void qc.invalidateQueries({ queryKey: ['settings'] });
    } catch (e) {
      toast(String((e as Error).message), 'err');
    } finally {
      setBusy(false);
    }
  }

  const saveable = tab === 'general' || tab === 'instructions' || tab === 'handoff';

  return (
    <div className="space-y-4">
      <div className="flex gap-2 overflow-x-auto rounded-xl border border-gray-200 bg-white p-2 shadow-sm">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`shrink-0 whitespace-nowrap rounded-full border px-3 py-1.5 text-xs ${
              tab === t.id
                ? 'border-wa bg-green-50 font-medium text-wa-dark'
                : 'border-gray-200 text-gray-600'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'general' && (
        <GeneralTab
          settings={settings}
          draft={general}
          set={(patch) => setGeneral((g) => ({ ...g, ...patch }))}
        />
      )}
      {tab === 'instructions' && (
        <InstructionsTab
          settings={settings}
          persona={persona}
          rules={rules}
          setPersona={setPersona}
          setRules={setRules}
        />
      )}
      {tab === 'knowledge' && <KnowledgeTab />}
      {tab === 'studio' && <StudioDataTab />}
      {tab === 'handoff' && (
        <HandoffTab draft={handoff} set={(patch) => setHandoff((h) => ({ ...h, ...patch }))} />
      )}
      {tab === 'test' && (
        <TestTab ready={settings.aiAgentApiKeySet || !!general.apiKey.trim()} />
      )}

      {saveable && (
        <button
          onClick={() => void save()}
          disabled={busy}
          className="w-full rounded-lg bg-wa py-2.5 text-sm font-semibold text-white hover:bg-wa-dark disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save AI agent settings'}
        </button>
      )}
    </div>
  );
}
