import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/index.js';
import { createToolDispatcher } from '../src/services/aiagent.js';
import { MAX_REPLY_CHARS, MAX_TOOL_ROUNDS } from '../src/services/aiLimits.js';
import {
  AiAgentEngine,
  anthropicProvider,
  openAiProvider,
  RESPOND_TOOL_NAME,
  buildSystemPrompt,
  FIXED_SAFETY_RULES,
} from '../src/services/aiProviders.js';
import { KnowledgeStore } from '../src/services/knowledge.js';
import { StudioDataStore } from '../src/services/studioData.js';

/** A scripted upstream: one canned response per round, plus the bodies we sent. */
function fakeFetch(bodies: unknown[]) {
  const sent: Array<Record<string, any>> = [];
  const fn = (async (_url: unknown, init: { body: string }) => {
    sent.push(JSON.parse(init.body));
    const payload = bodies[Math.min(sent.length - 1, bodies.length - 1)];
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(payload),
    };
  }) as unknown as typeof fetch;
  return { fn, sent };
}

const anthropic = (blocks: unknown[]) => ({
  content: blocks,
  usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 80 },
});

const toolUse = (id: string, name: string, input: unknown) => ({ type: 'tool_use', id, name, input });

const respondBlock = (id: string, input: unknown) => toolUse(id, RESPOND_TOOL_NAME, input);

function engineOf(fetchFn?: typeof fetch, provider = anthropicProvider) {
  const db = openDb(':memory:');
  const knowledge = new KnowledgeStore(db);
  const studio = new StudioDataStore(db);
  knowledge.create({ title: 'Trial class', content: 'First trial class is free.', keywords: 'trial, free' });
  studio.create({ title: 'Ballet A', branch: 'Center', ageGroup: 'child', price: '120 ILS' });
  const engine = new AiAgentEngine(provider, createToolDispatcher(knowledge, studio));
  const run = (history = [{ role: 'customer' as const, text: 'how much is ballet?' }]) =>
    engine.run({
      apiKey: 'test-key',
      model: 'claude-haiku-4-5-20251001',
      systemPrompt: buildSystemPrompt({
        aiAgentPersona: 'Warm and brief.',
        aiAgentRules: '',
        aiAgentEscalation: '',
      }),
      facts: {
        name: null,
        age_group: null,
        branch_preference: null,
        experience_level: null,
        preferred_days: [],
        preferred_times: [],
        trial_interest: null,
      },
      summary: '',
      history,
      fetchFn,
    });
  return { db, run };
}

describe('AiAgentEngine + providers', () => {
  it('builds the prompt with the fixed safety rules FIRST, before operator text', () => {
    const prompt = buildSystemPrompt({
      aiAgentPersona: 'PERSONA-TEXT',
      aiAgentRules: 'RULES-TEXT',
      aiAgentEscalation: 'ESCALATION-TEXT',
    });
    expect(prompt.startsWith(FIXED_SAFETY_RULES)).toBe(true);
    expect(prompt.indexOf('PERSONA-TEXT')).toBeGreaterThan(FIXED_SAFETY_RULES.length - 1);
    expect(prompt.indexOf('RULES-TEXT')).toBeGreaterThan(prompt.indexOf('PERSONA-TEXT'));
    expect(prompt.indexOf('ESCALATION-TEXT')).toBeGreaterThan(prompt.indexOf('RULES-TEXT'));
  });

  it('handoff=false: drops unknown memory keys and truncates oversized fields', async () => {
    const { fn } = fakeFetch([
      anthropic([
        respondBlock('tu_final', {
          reply: 'x'.repeat(MAX_REPLY_CHARS + 500),
          handoff: false,
          memory_updates: {
            name: 'Dana',
            age_group: 'child',
            preferred_days: ['mon', 'notaday', 'mon'],
            credit_card: '4111 1111 1111 1111',
            internal_score: 42,
          },
        }),
      ]),
    ]);
    const { run } = engineOf(fn);
    const r = await run();
    expect(r.handoff).toBe(false);
    expect(r.invalidFinal).toBe(false);
    expect(r.reply).toHaveLength(MAX_REPLY_CHARS);
    expect(r.memoryUpdates).toEqual({
      name: 'Dana',
      age_group: 'child',
      preferred_days: ['mon'],
    });
    // the allowlist is a closed shape — nothing else survives, whatever it was
    expect(JSON.stringify(r.memoryUpdates)).not.toContain('4111');
    expect(r.usage).toMatchObject({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 80 });
  });

  it('handoff=true short-circuits with the reason kept', async () => {
    const { fn, sent } = fakeFetch([
      anthropic([
        respondBlock('tu_final', {
          reply: 'A team member will get back to you.',
          handoff: true,
          handoff_reason: 'wants to cancel a membership',
        }),
      ]),
    ]);
    const { run } = engineOf(fn);
    const r = await run();
    expect(r.handoff).toBe(true);
    expect(r.handoffReason).toBe('wants to cancel a membership');
    expect(sent).toHaveLength(1); // one round, no extra calls
  });

  it('keys tool results back by toolCallId and replays the assistant turn', async () => {
    const { fn, sent } = fakeFetch([
      anthropic([toolUse('tu_prices', 'get_prices', { age_group: 'child' })]),
      anthropic([respondBlock('tu_final', { reply: '120 ILS a month.', handoff: false })]),
    ]);
    const { run } = engineOf(fn);
    const r = await run();
    expect(r.reply).toBe('120 ILS a month.');
    expect(r.toolsCalled).toHaveLength(1);
    expect(r.toolsCalled[0]).toMatchObject({ id: 'tu_prices', name: 'get_prices' });

    // round 2 replays our own tool_use turn, then answers it by tool_use_id
    const second = sent[1]!;
    const msgs = second.messages as Array<{ role: string; content: any }>;
    expect(msgs[msgs.length - 2]!.role).toBe('assistant');
    const results = msgs[msgs.length - 1]!.content as Array<Record<string, unknown>>;
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'tu_prices' });
    expect(String(results[0]!.content)).toContain('120 ILS');
  });

  it('discards a respond_to_lead issued alongside a retrieval call', async () => {
    const { fn, sent } = fakeFetch([
      anthropic([
        toolUse('tu_know', 'search_knowledge', { query: 'trial' }),
        respondBlock('tu_premature', { reply: 'It is free!', handoff: false }),
      ]),
      anthropic([respondBlock('tu_final', { reply: 'The first trial class is free.', handoff: false })]),
    ]);
    const { run } = engineOf(fn);
    const r = await run();
    // the premature answer never became the result
    expect(r.reply).toBe('The first trial class is free.');
    expect(r.rounds).toBe(2);

    // BOTH tool_use ids still get a tool_result — a missing one is a protocol
    // error on the next call — and the discarded one tells the model why
    const results = (sent[1]!.messages as Array<{ content: any }>).at(-1)!.content as Array<
      Record<string, unknown>
    >;
    expect(results.map((x) => x.tool_use_id).sort()).toEqual(['tu_know', 'tu_premature']);
    const discarded = results.find((x) => x.tool_use_id === 'tu_premature')!;
    expect(String(discarded.content)).toContain('discarded');
  });

  it('forces respond_to_lead on the last round when the model keeps looking things up', async () => {
    const { fn, sent } = fakeFetch([anthropic([toolUse('tu_a', 'get_courses', {})])]);
    const { run } = engineOf(fn);
    const r = await run();
    expect(sent).toHaveLength(MAX_TOOL_ROUNDS);
    // earlier rounds leave the choice open; the last one pins it
    expect(sent[0]!.tool_choice).toEqual({ type: 'any' });
    expect(sent[MAX_TOOL_ROUNDS - 1]!.tool_choice).toEqual({
      type: 'tool',
      name: RESPOND_TOOL_NAME,
    });
    // and a model that never answered hands off rather than guessing
    expect(r.invalidFinal).toBe(true);
    expect(r.handoff).toBe(true);
    expect(r.handoffReason).toBe('ai_invalid_final_response');
    expect(r.reply).toBe('');
  });

  it('hands off safely when no valid final ever arrives', async () => {
    // an empty content array: no tool call, no answer, no error
    const { fn } = fakeFetch([anthropic([])]);
    const { run } = engineOf(fn);
    const r = await run();
    expect(r.invalidFinal).toBe(true);
    expect(r.handoff).toBe(true);
    expect(r.handoffReason).toBe('ai_invalid_final_response');
    expect(r.reply).toBe(''); // nothing free-text is ever invented here
    expect(r.error).toBeTruthy();
  });

  it('treats a provider error as a handoff, with the error audited', async () => {
    const fn = (async () => ({
      ok: false,
      status: 500,
      text: async () => 'upstream exploded',
    })) as unknown as typeof fetch;
    const { run } = engineOf(fn);
    const r = await run();
    expect(r.invalidFinal).toBe(true);
    expect(r.error).toContain('500');
  });

  it('treats an empty reply with handoff=false as no valid final', async () => {
    const { fn } = fakeFetch([anthropic([respondBlock('tu_final', { reply: '   ', handoff: false })])]);
    const { run } = engineOf(fn);
    const r = await run();
    expect(r.invalidFinal).toBe(true);
    expect(r.handoff).toBe(true);
  });

  it('feeds an invalid_request tool result back so the model can self-correct', async () => {
    const { fn, sent } = fakeFetch([
      anthropic([toolUse('tu_bad', 'get_courses', { age_group: 'kids' })]),
      anthropic([respondBlock('tu_final', { reply: 'Here you go.', handoff: false })]),
    ]);
    const { run } = engineOf(fn);
    const r = await run();
    expect(r.toolsCalled[0]!.result).toMatchObject({ status: 'invalid_request' });
    const results = (sent[1]!.messages as Array<{ content: any }>).at(-1)!.content as Array<
      Record<string, unknown>
    >;
    expect(String(results[0]!.content)).toContain('invalid_request');
  });

  it('caches only the stable prefix, and never puts the lead context in it', async () => {
    const { fn, sent } = fakeFetch([
      anthropic([respondBlock('tu_final', { reply: 'Hi!', handoff: false })]),
    ]);
    const { run } = engineOf(fn);
    await run();
    const system = sent[0]!.system as Array<Record<string, unknown>>;
    expect(system).toHaveLength(2);
    expect(system[0]!.cache_control).toEqual({ type: 'ephemeral' });
    expect(system[1]!.cache_control).toBeUndefined();
    expect(String(system[0]!.text)).toContain('Never fabricate studio information');
  });

  it('openai adapter keys results by tool_call_id through the same interface', async () => {
    const openai = (message: unknown) => ({
      choices: [{ message }],
      usage: { prompt_tokens: 50, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 40 } },
    });
    const { fn, sent } = fakeFetch([
      openai({
        role: 'assistant',
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'get_prices', arguments: '{"age_group":"child"}' } },
        ],
      }),
      openai({
        role: 'assistant',
        tool_calls: [
          {
            id: 'call_2',
            type: 'function',
            function: { name: RESPOND_TOOL_NAME, arguments: '{"reply":"120 ILS","handoff":false}' },
          },
        ],
      }),
    ]);
    const { run } = engineOf(fn, openAiProvider);
    const r = await run();
    expect(r.reply).toBe('120 ILS');
    // usage is summed across both rounds of the turn
    expect(r.usage).toMatchObject({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 80 });
    const msgs = sent[1]!.messages as Array<Record<string, unknown>>;
    const toolMsg = msgs.at(-1)!;
    expect(toolMsg).toMatchObject({ role: 'tool', tool_call_id: 'call_1' });
    expect(sent[1]!.tool_choice).toBe('required');
  });
});
