/**
 * Local read-marks: Evolution accepts markMessageAsRead but keeps serving a
 * stale unreadCount in findChats, so the badge would never clear. We remember
 * "read up to lastMsgTimestamp X" per chat and suppress the stale count until
 * something NEWER arrives (which legitimately re-shows the badge).
 */
const KEY = 'wa_read_marks';

// version + listeners let React re-render on mark changes even when the
// chats query data itself is unchanged (react-query structural sharing)
let version = 0;
const listeners = new Set<() => void>();

function bump(): void {
  version++;
  for (const fn of listeners) fn();
}

/** For useSyncExternalStore. */
export function subscribeReadMarks(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** For useSyncExternalStore — changes whenever a mark is set or cleared. */
export function readMarksVersion(): number {
  return version;
}

function load(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, number>;
  } catch {
    return {};
  }
}

/** Record that `jid` has been read up to `lastMsgTimestamp` (millis). */
export function setReadMark(jid: string, lastMsgTimestamp: number): void {
  const marks = load();
  if ((marks[jid] ?? 0) >= lastMsgTimestamp) return;
  marks[jid] = lastMsgTimestamp;
  localStorage.setItem(KEY, JSON.stringify(marks));
  bump();
}

/** Forget the mark — used by "mark unread" so the badge can come back. */
export function clearReadMark(jid: string): void {
  const marks = load();
  if (!(jid in marks)) return;
  delete marks[jid];
  localStorage.setItem(KEY, JSON.stringify(marks));
  bump();
}

/** The unread count after the local override. */
export function effectiveUnread(jid: string, unreadCount: number, lastMsgTimestamp: number): number {
  if (!unreadCount) return 0;
  const mark = load()[jid];
  return mark != null && lastMsgTimestamp <= mark ? 0 : unreadCount;
}
