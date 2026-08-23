export interface AgentPresenceEntry {
  email: string;
  /** Canonical jid of the chat the agent is viewing; '' = not in a chat. */
  chatJid: string;
  typing: boolean;
}

interface Beat {
  email: string;
  chatJid: string;
  typing: boolean;
  at: number;
}

const TTL_MS = 20_000;

/**
 * Which agent is looking at (or typing in) which chat right now — collision
 * avoidance, not history, so it's purely in-memory. Keyed by email+tabId:
 * one agent in two tabs must not flicker between chats, and a closed tab
 * simply ages out.
 */
export class AgentPresence {
  private readonly beats = new Map<string, Beat>();

  /** Record a heartbeat. Returns the aggregated snapshot to broadcast. */
  beat(email: string, tabId: string, chatJid: string, typing: boolean): AgentPresenceEntry[] {
    this.beats.set(`${email}\n${tabId}`, { email, chatJid, typing, at: Date.now() });
    return this.snapshot();
  }

  /** Live entries, one per agent+chat (typing wins over plain viewing). */
  snapshot(now: number = Date.now()): AgentPresenceEntry[] {
    const out = new Map<string, AgentPresenceEntry>();
    for (const [key, b] of this.beats) {
      if (now - b.at > TTL_MS) {
        this.beats.delete(key);
        continue;
      }
      if (!b.chatJid) continue;
      const k = `${b.email}\n${b.chatJid}`;
      const prev = out.get(k);
      out.set(k, { email: b.email, chatJid: b.chatJid, typing: b.typing || !!prev?.typing });
    }
    return [...out.values()];
  }
}
