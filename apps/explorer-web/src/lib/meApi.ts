// Per-user self API client (token metering): the caller's own token usage + quota.

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

export async function getMyUsage(): Promise<MyUsage> {
  const res = await fetch('/api/me/usage', { credentials: 'include' });
  if (!res.ok) throw new Error(`usage request failed: ${res.status}`);
  return (await res.json()) as MyUsage;
}

export async function setMyAvatar(avatarUrl: string | null): Promise<void> {
  const res = await fetch('/api/me/avatar', {
    method: 'PUT',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ avatarUrl }),
  });
  if (!res.ok) throw new Error(`avatar update failed: ${res.status}`);
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
  const res = await fetch('/api/me/sessions', { credentials: 'include' });
  if (!res.ok) throw new Error(`sessions request failed: ${res.status}`);
  return ((await res.json()) as { sessions: SessionSummary[] }).sessions;
}

export async function getSession(id: string): Promise<ResumedSession> {
  const res = await fetch(`/api/me/sessions/${id}`, { credentials: 'include' });
  if (!res.ok) throw new Error(`session request failed: ${res.status}`);
  return (await res.json()) as ResumedSession;
}

export async function deleteSession(id: string): Promise<void> {
  const res = await fetch(`/api/me/sessions/${id}`, { method: 'DELETE', credentials: 'include' });
  if (!res.ok) throw new Error(`session delete failed: ${res.status}`);
}

/** Ask the server to stop an in-flight generation (mid-stream resume). Best-effort. */
export async function stopGeneration(messageId: string): Promise<void> {
  await fetch(`/api/me/generations/${messageId}/stop`, {
    method: 'POST',
    credentials: 'include',
  }).catch(() => {});
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
  const res = await fetch('/api/me/api-keys', { credentials: 'include' });
  if (!res.ok) throw new Error(`api-keys request failed: ${res.status}`);
  return ((await res.json()) as { keys: ApiKeyView[] }).keys;
}

export async function createApiKey(name: string, scopes?: ApiKeyScope[]): Promise<CreatedApiKey> {
  const res = await fetch('/api/me/api-keys', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, ...(scopes && scopes.length > 0 ? { scopes } : {}) }),
  });
  if (!res.ok) throw new Error(`api-key create failed: ${res.status}`);
  return (await res.json()) as CreatedApiKey;
}

export async function revokeApiKey(id: string): Promise<void> {
  const res = await fetch(`/api/me/api-keys/${id}`, { method: 'DELETE', credentials: 'include' });
  if (!res.ok) throw new Error(`api-key revoke failed: ${res.status}`);
}

// API request usage over the current quota window (spec 028).
export interface ApiUsage {
  windowSec: number;
  total: number;
  data: number;
  chat: number;
  byKey: { keyId: string; count: number }[];
}
export async function getApiUsage(): Promise<ApiUsage> {
  const res = await fetch('/api/me/api-usage', { credentials: 'include' });
  if (!res.ok) throw new Error(`api-usage request failed: ${res.status}`);
  return (await res.json()) as ApiUsage;
}
