// Per-user self API client (token metering): the caller's own token usage + quota. A typed facade
// over the shared `request` helper (spec 057, FR-400) — every call is cookie-authed (`authed: true`).

import { request } from './http.ts';

export interface MyUsage {
  used: number;
  input: number;
  output: number;
  cached: number; // cache-hit input tokens (a subset of input)
  limit: number; // 0 = unlimited
  remaining: number | null; // null = unlimited
  exceeded: boolean;
  requests: number;
  lastUsedAt: string | null;
}

export function getMyUsage(): Promise<MyUsage> {
  return request('/api/me/usage', { authed: true });
}

export function setMyAvatar(avatarUrl: string | null): Promise<void> {
  return request('/api/me/avatar', { method: 'PUT', body: { avatarUrl }, authed: true });
}

// Resumable chat history (token persistence). The sessions-route response shapes are single-sourced
// from the API (spec 059 FR-422); `SessionMessage` is the API's stored-turn type (`ChatMessage`).
import type {
  ChatMessage,
  ResumedSession,
  SessionSummary,
} from '../../../explorer-api/src/chat/session.ts';
export type { ResumedSession, SessionSummary };
export type SessionMessage = ChatMessage;

export async function listSessions(): Promise<SessionSummary[]> {
  return (await request<{ sessions: SessionSummary[] }>('/api/me/sessions', { authed: true }))
    .sessions;
}

export function getSession(id: string): Promise<ResumedSession> {
  return request(`/api/me/sessions/${id}`, { authed: true });
}

export function deleteSession(id: string): Promise<void> {
  return request(`/api/me/sessions/${id}`, { method: 'DELETE', authed: true });
}

/** Ask the server to stop an in-flight generation (mid-stream resume). Best-effort. */
export async function stopGeneration(messageId: string): Promise<void> {
  await request(`/api/me/generations/${messageId}/stop`, { method: 'POST', authed: true }).catch(
    () => {},
  );
}

// API keys (spec 027) — machine-client Bearer credentials, managed by the signed-in human.
export type ApiKeyScope = 'read' | 'chat';
export interface ApiKeyView {
  id: string;
  name: string;
  prefix: string;
  scopes: ApiKeyScope[];
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}
/** A freshly created key — `key` is the full plaintext secret, shown ONCE and never retrievable. */
export interface CreatedApiKey extends ApiKeyView {
  key: string;
}

export async function listApiKeys(): Promise<ApiKeyView[]> {
  return (await request<{ keys: ApiKeyView[] }>('/api/me/api-keys', { authed: true })).keys;
}

export function createApiKey(name: string, scopes?: ApiKeyScope[]): Promise<CreatedApiKey> {
  return request('/api/me/api-keys', {
    method: 'POST',
    body: { name, ...(scopes && scopes.length > 0 ? { scopes } : {}) },
    authed: true,
  });
}

export function revokeApiKey(id: string): Promise<void> {
  return request(`/api/me/api-keys/${id}`, { method: 'DELETE', authed: true });
}

// API request usage over the current quota window (spec 028).
export interface ApiUsage {
  windowSec: number;
  total: number;
  data: number;
  chat: number;
  byKey: { keyId: string; count: number }[];
}
export function getApiUsage(): Promise<ApiUsage> {
  return request('/api/me/api-usage', { authed: true });
}
