// Admin platform settings API client (spec 019). Same-origin (cookies flow through Oathkeeper). A
// typed facade over the shared `request` helper (spec 057, FR-400) — every call is cookie-authed.

import { request } from './http.ts';

export interface AdminLlm {
  kind: string;
  model: string;
  baseUrl: string | null;
  apiKeyMasked: boolean;
  apiKeyHint: string | null;
}

export interface AdminToggles {
  freshnessSloSeconds?: number;
  chatEnabled?: boolean;
  defaultTokenLimit?: number;
  cachedTokenWeight?: number;
  maxOutputTokens?: number;
}

export interface AdminSettings {
  llm: AdminLlm | null;
  toggles: AdminToggles;
  source: 'settings' | 'env';
}

export interface SettingsPut {
  llm?: { kind: string; model: string; baseUrl?: string | null; apiKey?: string };
  toggles?: AdminToggles;
}

export interface AdminUsageRow {
  userId: string;
  email: string;
  displayName: string | null;
  role: 'admin' | 'user';
  tokenLimit: number | null; // per-user override
  used: number;
  input: number;
  output: number;
  cached: number; // cache-hit input tokens (a subset of input)
  limit: number; // effective (0 = unlimited)
  remaining: number | null;
  exceeded: boolean;
  requests: number;
  lastUsedAt: string | null;
}

export interface AdminUsage {
  users: AdminUsageRow[];
  defaultLimit: number;
}

export function getSettings(): Promise<AdminSettings> {
  return request('/api/admin/settings', { authed: true });
}

export function putSettings(body: SettingsPut): Promise<AdminSettings> {
  return request('/api/admin/settings', { method: 'PUT', body, authed: true });
}

export function getUsage(): Promise<AdminUsage> {
  return request('/api/admin/usage', { authed: true });
}

export function setUserLimit(userId: string, limit: number | null): Promise<void> {
  return request(`/api/admin/users/${userId}/limit`, {
    method: 'PUT',
    body: { limit },
    authed: true,
  });
}

export function resetUserUsage(userId: string): Promise<void> {
  return request(`/api/admin/users/${userId}/reset`, { method: 'POST', authed: true });
}
