import { useEffect, useRef } from 'react';

/**
 * One shared EventSource for the whole app. Every hook used to open its own
 * /api/events stream (ChatPage + JobsPage = two connections); with the v2.8
 * workbench events needing app-wide delivery (reminders, approvals,
 * presence), subscriptions now fan out from a single ref-counted connection.
 */

export type BusHandler = (data: unknown) => void;

const handlers = new Map<string, Set<BusHandler>>();
let es: EventSource | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let attached = new Set<string>();
let total = 0;

function dispatchTo(event: string, e: MessageEvent): void {
  let data: unknown;
  try {
    data = JSON.parse(e.data);
  } catch {
    return;
  }
  for (const fn of handlers.get(event) ?? []) {
    try {
      fn(data);
    } catch {
      /* one bad subscriber must not break the rest */
    }
  }
}

function attach(event: string): void {
  if (!es || attached.has(event)) return;
  attached.add(event);
  es.addEventListener(event, (e) => dispatchTo(event, e as MessageEvent));
}

function connect(): void {
  retryTimer = null;
  es = new EventSource('/api/events');
  attached = new Set();
  for (const event of handlers.keys()) attach(event);
  // EventSource auto-retries only network drops; an HTTP error response
  // (e.g. a proxy 502 while the backend restarts) closes it permanently —
  // recreate the stream ourselves or live updates die until a full reload
  es.onerror = () => {
    if (es?.readyState === EventSource.CLOSED) {
      es.close();
      es = null;
      if (total > 0 && !retryTimer) retryTimer = setTimeout(connect, 5000);
    }
  };
}

export function subscribeBus(event: string, fn: BusHandler): () => void {
  let set = handlers.get(event);
  if (!set) {
    set = new Set();
    handlers.set(event, set);
  }
  set.add(fn);
  total++;
  if (!es && !retryTimer) connect();
  else attach(event);
  return () => {
    set.delete(fn);
    if (!set.size) handlers.delete(event);
    total--;
    if (total <= 0) {
      total = 0;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      es?.close();
      es = null;
    }
  };
}

/** Subscribe for the component's lifetime; the handler may change freely. */
export function useBusEvent(event: string | readonly string[], fn: BusHandler): void {
  const ref = useRef(fn);
  ref.current = fn;
  const key = Array.isArray(event) ? event.join('|') : (event as string);
  useEffect(() => {
    const events = key.split('|');
    const subs = events.map((ev) => subscribeBus(ev, (d) => ref.current(d)));
    return () => subs.forEach((u) => u());
  }, [key]);
}
