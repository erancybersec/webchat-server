/**
 * Evolution's global websocket wraps every event in an envelope:
 *   { event, instance, data, server_url, date_time, ... }
 * where `data` is the record itself, an array of records, or (for some
 * upsert variants) { messages: [...] }. Local broadcasts and tests pass bare
 * records with no envelope. The frontend has always unwrapped this
 * (`data?.data ?? data` in useEvents); the backend listeners did not — which
 * silently killed delivery acks, auto opt-out, alias learning and
 * auto-reopen against real traffic. This is the single seam that flattens
 * every shape into a record list.
 */
export interface UnwrappedEvent {
  /** The Evolution instance the event belongs to (global mode), if tagged. */
  instance?: string;
  records: unknown[];
}

export function unwrapEvent(data: unknown): UnwrappedEvent {
  const env = data as { instance?: unknown; data?: unknown } | null | undefined;
  const instance =
    env && typeof env === 'object' && typeof env.instance === 'string' ? env.instance : undefined;
  // Only treat it as an envelope when the instance tag is present — a bare
  // record never carries one, and app-emitted events are filtered out by
  // event name before reaching this helper anyway.
  const payload =
    instance !== undefined && env && typeof env === 'object' && 'data' in env ? env.data : data;
  const records = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object' && Array.isArray((payload as { messages?: unknown }).messages)
      ? (payload as { messages: unknown[] }).messages
      : payload == null
        ? []
        : [payload];
  return { instance, records };
}
