import { useQuery } from '@tanstack/react-query';
import type { Me, PermissionKey } from '../types';
import { api } from './api';

/**
 * Badge palette for agent identification. Keys are what the server stores in
 * agents.color; class strings are literal so Tailwind's scanner keeps them.
 */
export const AGENT_COLORS: Record<string, string> = {
  teal: 'bg-teal-100 text-teal-800',
  blue: 'bg-blue-100 text-blue-800',
  purple: 'bg-purple-100 text-purple-800',
  pink: 'bg-pink-100 text-pink-800',
  amber: 'bg-amber-100 text-amber-800',
  orange: 'bg-orange-100 text-orange-800',
};

export const AGENT_COLOR_KEYS = Object.keys(AGENT_COLORS);

export const agentBadgeClass = (color: string): string =>
  AGENT_COLORS[color] ?? 'bg-gray-100 text-gray-600';

/** "Dana" from a record, else the mailbox part of the email. */
export const agentLabel = (a: { name?: string; email: string }): string =>
  a.name || a.email.split('@')[0] || a.email;

/** The signed-in agent — { enabled:false } while the Settings toggle is off. */
export function useMe() {
  return useQuery({ queryKey: ['me'], queryFn: api.me, staleTime: 60_000 });
}

/**
 * undefined while /api/me is loading; true unless we know the user is a
 * non-admin agent (feature off / no Access identity = unrestricted, mirroring
 * the server's allow rule).
 */
export function useIsAdmin(): boolean | undefined {
  const me = useMe();
  if (!me.data) return undefined;
  if (!me.data.enabled || !me.data.email) return true;
  return me.data.role === 'admin';
}

/** Effective permission off a loaded Me; unrestricted contexts get true. */
export function hasPerm(me: Me | undefined, key: PermissionKey): boolean | undefined {
  if (!me) return undefined;
  if (!me.enabled || !me.email || !me.perms) return true;
  return me.perms[key];
}

/**
 * undefined while /api/me is loading; otherwise the server-resolved effective
 * permission. Gating mirrors useIsAdmin: only hide once we KNOW it's denied.
 */
export function usePerm(key: PermissionKey): boolean | undefined {
  const me = useMe();
  return hasPerm(me.data, key);
}

/** Agent roster (email → name/color), for "by …" chips outside Settings. */
export function useAgents(enabled = true) {
  return useQuery({
    queryKey: ['agents'],
    queryFn: api.agents.list,
    staleTime: 60_000,
    enabled,
  });
}
