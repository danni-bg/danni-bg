// Organization (tenant) console for the account page (spec 064 FR-510/511). Human-only. Lets the
// signed-in user: see their orgs + which is active, CREATE a new org (becoming its owner), SWITCH the
// active org, and — where they're an owner/admin — manage that org's members (add by email, change
// role, remove). All calls go through lib/tenantApi (spec 057); load/mutation failures surface via
// the shared StatusMessage affordances rather than being swallowed.

import { useState } from 'react';
import { ErrorState, Loading } from '../components/StatusMessage.tsx';
import { Input } from '../components/ui/input.tsx';
import { formatNumber } from '../lib/format.ts';
import {
  type OrgMember,
  type TenantRole,
  addOrgMember,
  createOrg,
  getActiveOrg,
  listMemberships,
  removeOrgMember,
  setMemberAllowance,
  setOrgMemberRole,
  switchOrg,
} from '../lib/tenantApi.ts';
import { useServerState } from '../lib/useServerState.ts';

const ROLE_LABEL: Record<TenantRole, string> = {
  owner: 'собственик',
  admin: 'администратор',
  member: 'член',
};

function MemberRow({
  member,
  canManage,
  hasPool,
  onChange,
}: {
  member: OrgMember;
  canManage: boolean;
  hasPool: boolean;
  onChange: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [alloc, setAlloc] = useState(member.tokenLimit == null ? '' : String(member.tokenLimit));

  async function run(fn: () => Promise<void>, fail: string) {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      onChange();
    } catch {
      setErr(fail);
    } finally {
      setBusy(false);
    }
  }

  function saveAllowance() {
    const trimmed = alloc.trim();
    const next = trimmed === '' ? null : Number(trimmed);
    if (next != null && (!Number.isFinite(next) || next < 0)) return;
    if (next === (member.tokenLimit ?? null)) return;
    void run(
      () => setMemberAllowance(member.userId, next).then(() => undefined),
      'Разпределението надвишава пула.',
    );
  }

  return (
    <li className="flex items-center justify-between gap-2 text-xs">
      <div className="min-w-0">
        <div className="truncate font-medium">{member.displayName ?? member.email}</div>
        <div className="truncate text-muted-foreground">{member.email}</div>
        {err ? <div className="text-destructive">{err}</div> : null}
      </div>
      {canManage ? (
        <div className="flex shrink-0 items-center gap-1">
          {hasPool ? (
            <Input
              aria-label={`Разпределение за ${member.email}`}
              value={alloc}
              onChange={(e) => setAlloc(e.target.value)}
              onBlur={saveAllowance}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveAllowance();
              }}
              placeholder="токени"
              inputMode="numeric"
              disabled={busy}
              className="h-7 w-20 px-1 text-right"
            />
          ) : null}
          <select
            aria-label={`Роля на ${member.email}`}
            value={member.role}
            disabled={busy}
            onChange={(e) =>
              void run(
                () => setOrgMemberRole(member.userId, e.target.value as TenantRole),
                'Неуспешна промяна на ролята.',
              )
            }
            className="rounded-md border border-border bg-background px-1 py-1 text-xs"
          >
            <option value="member">член</option>
            <option value="admin">администратор</option>
            <option value="owner">собственик</option>
          </select>
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(() => removeOrgMember(member.userId), 'Неуспешно премахване.')}
            className="rounded-md px-2 py-1 text-destructive hover:bg-destructive/10 disabled:opacity-40"
          >
            Премахни
          </button>
        </div>
      ) : (
        <span className="shrink-0 text-xs text-muted-foreground">{ROLE_LABEL[member.role]}</span>
      )}
    </li>
  );
}

export function Organizations() {
  const membersQuery = useServerState('tenant:memberships', listMemberships);
  const activeQuery = useServerState('tenant:active', getActiveOrg);
  const memberships = membersQuery.data ?? null;
  const active = activeQuery.data ?? null;
  const canManage = active?.role === 'owner' || active?.role === 'admin';

  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [invite, setInvite] = useState('');
  const [inviteRole, setInviteRole] = useState<'member' | 'admin'>('member');

  function reload() {
    membersQuery.refetch();
    activeQuery.refetch();
  }

  async function create() {
    const trimmed = name.trim();
    if (!trimmed || creating) return;
    setCreating(true);
    setError(null);
    try {
      await createOrg(trimmed);
      setName('');
      reload();
    } catch {
      setError('Неуспешно създаване на организация.');
    } finally {
      setCreating(false);
    }
  }

  async function doSwitch(tenantId: string) {
    setError(null);
    try {
      await switchOrg(tenantId);
      reload();
    } catch {
      setError('Неуспешно превключване.');
    }
  }

  async function addMember() {
    const email = invite.trim();
    if (!email) return;
    setError(null);
    try {
      await addOrgMember(email, inviteRole);
      setInvite('');
      reload();
    } catch {
      setError('Неуспешно добавяне — потребителят трябва да има акаунт и да не е вече член.');
    }
  }

  return (
    <section className="space-y-3 rounded-lg border border-border p-4">
      <div>
        <h2 className="text-sm font-semibold">Организации</h2>
        <p className="text-xs text-muted-foreground">
          Вашите организации и членове. Активната определя обхвата на ключове и потребление.
        </p>
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {/* My organizations + switch */}
      {membersQuery.status === 'error' ? (
        <ErrorState
          message="Неуспешно зареждане на организациите."
          onRetry={membersQuery.refetch}
        />
      ) : memberships == null ? (
        <Loading />
      ) : (
        <ul className="space-y-1.5">
          {memberships.map((m) => {
            const isActive = active?.id === m.tenantId;
            return (
              <li key={m.tenantId} className="flex items-center justify-between gap-2 text-xs">
                <div className="min-w-0">
                  <div className="truncate font-medium">
                    {m.name}
                    {isActive ? (
                      <span className="ml-2 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">
                        активна
                      </span>
                    ) : null}
                  </div>
                  <div className="truncate text-muted-foreground">{ROLE_LABEL[m.role]}</div>
                </div>
                {isActive ? null : (
                  <button
                    type="button"
                    onClick={() => void doSwitch(m.tenantId)}
                    className="shrink-0 rounded-md border px-2 py-1 text-xs hover:bg-accent"
                  >
                    Превключи
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {/* Create a new org */}
      <div className="flex items-center gap-2">
        <Input
          aria-label="Име на организация"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void create();
          }}
          placeholder="Нова организация"
          maxLength={80}
          className="h-8 min-w-0 flex-1 px-2"
        />
        <button
          type="button"
          onClick={() => void create()}
          disabled={!name.trim() || creating}
          className="shrink-0 rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
        >
          Създай
        </button>
      </div>

      {/* Entitlement self-view — every member sees the active org's BYOM state + their own slice. */}
      {active ? (
        <div className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          Активна: <span className="font-medium text-foreground">{active.name}</span>
          {active.myAllowance != null ? (
            <>
              {' · '}вашето разпределение:{' '}
              <span className="tabular-nums text-foreground">
                {formatNumber(active.myAllowance)}
              </span>{' '}
              токена
            </>
          ) : null}
          {active.byomEnabled ? <> {' · '}собствен модел (BYOM)</> : null}
        </div>
      ) : null}

      {/* Members of the active org — owner/admin only */}
      {canManage && active ? (
        <div className="space-y-2 border-t border-border pt-3">
          <h3 className="text-xs font-semibold">Членове на „{active.name}“</h3>
          {active.pool != null ? (
            <p className="text-xs text-muted-foreground">
              Пул: <span className="tabular-nums">{formatNumber(active.pool)}</span> · разпределени:{' '}
              <span className="tabular-nums">{formatNumber(active.allocated ?? 0)}</span> ·
              свободни:{' '}
              <span className="tabular-nums">{formatNumber(active.unallocated ?? 0)}</span> токена
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">Няма назначен пул от токени.</p>
          )}
          <div className="flex items-center gap-2">
            <Input
              aria-label="Имейл на член"
              value={invite}
              onChange={(e) => setInvite(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void addMember();
              }}
              placeholder="имейл@пример.bg"
              type="email"
              className="h-8 min-w-0 flex-1 px-2"
            />
            <select
              aria-label="Роля"
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value as 'member' | 'admin')}
              className="h-8 rounded-md border border-border bg-background px-1 text-xs"
            >
              <option value="member">член</option>
              <option value="admin">админ</option>
            </select>
            <button
              type="button"
              onClick={() => void addMember()}
              disabled={!invite.trim()}
              className="shrink-0 rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
            >
              Добави
            </button>
          </div>
          <ul className="space-y-1.5">
            {(active.members ?? []).map((mem) => (
              <MemberRow
                key={mem.userId}
                member={mem}
                canManage={canManage}
                hasPool={active.pool != null}
                onChange={reload}
              />
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
