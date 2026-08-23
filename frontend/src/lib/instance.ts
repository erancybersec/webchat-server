import { useQuery } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import type { InstanceInfo } from '../types';
import { api } from './api';

/**
 * Active Evolution instance for this browser. '' = the server's default.
 * Module-level store (no router/context needed) — api.ts reads it to append
 * `?instance=` to every Evolution-backed call, useEvents filters the SSE
 * stream with it, and the header switcher writes it.
 */

const KEY = 'webchat.activeInstance';
let active = '';
try {
  active = localStorage.getItem(KEY) ?? '';
} catch {
  /* storage may be unavailable (private mode) */
}

const listeners = new Set<() => void>();

export function getActiveInstance(): string {
  return active;
}

export function setActiveInstance(name: string): void {
  active = name;
  try {
    if (name) localStorage.setItem(KEY, name);
    else localStorage.removeItem(KEY);
  } catch {
    /* best effort */
  }
  for (const fn of listeners) fn();
}

export function useActiveInstance(): string {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => active,
  );
}

/** Append the active instance to an /api path (handles existing query). */
export function withInstance(path: string): string {
  if (!active) return path;
  return `${path}${path.includes('?') ? '&' : '?'}instance=${encodeURIComponent(active)}`;
}

/** The instances visible to this agent (GET /api/instances). */
export function useInstances(enabled = true) {
  return useQuery({
    queryKey: ['instances'],
    queryFn: api.instances.list,
    staleTime: 30_000,
    retry: 1,
    enabled,
  });
}

/**
 * The instance name calls are effectively hitting right now: the override,
 * or the server default once known.
 */
export function effectiveInstance(defaultInstance: string | undefined): string {
  return active || defaultInstance || '';
}

export type { InstanceInfo };
