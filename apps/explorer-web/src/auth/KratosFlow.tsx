// Generic Ory Kratos self-service flow UI (spec 019): login / registration / recovery / verification,
// plus the reusable settings-form sections that AccountPage composes (spec 060 FR-431). Inits the flow
// (create, or fetch an existing ?flow=id), renders flow.ui.nodes as a form, and submits via the SDK —
// so it stays in the SPA. Validation errors (400) re-render with messages; a 422 browser_location_change
// is followed; success returns to the app with a fresh session.

import type {
  UiContainer,
  UiNode,
  UiNodeInputAttributes,
  UiNodeScriptAttributes,
  UpdateLoginFlowBody,
  UpdateRecoveryFlowBody,
  UpdateRegistrationFlowBody,
  UpdateSettingsFlowBody,
  UpdateVerificationFlowBody,
} from '@ory/client';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Card } from '../components/ui/card.tsx';
import { Input } from '../components/ui/input.tsx';
import { type FlowKind, flowMessages, kratos } from '../lib/kratos.ts';
import { useAuth } from './AuthContext.tsx';

interface Flow {
  id: string;
  ui: UiContainer;
}

// One kind→SDK-method map (FR-432): a single lookup per operation, each entry keeping its per-kind
// body type. `createFlow`/`getFlow`/`submitFlow` are the three thin lookups over it.
const flowApi = {
  login: {
    create: () => kratos.createBrowserLoginFlow(),
    fetch: (id: string) => kratos.getLoginFlow({ id }),
    submit: (flow: string, body: Record<string, string>) =>
      kratos.updateLoginFlow({ flow, updateLoginFlowBody: body as unknown as UpdateLoginFlowBody }),
  },
  registration: {
    create: () => kratos.createBrowserRegistrationFlow(),
    fetch: (id: string) => kratos.getRegistrationFlow({ id }),
    submit: (flow: string, body: Record<string, string>) =>
      kratos.updateRegistrationFlow({
        flow,
        updateRegistrationFlowBody: body as unknown as UpdateRegistrationFlowBody,
      }),
  },
  recovery: {
    create: () => kratos.createBrowserRecoveryFlow(),
    fetch: (id: string) => kratos.getRecoveryFlow({ id }),
    submit: (flow: string, body: Record<string, string>) =>
      kratos.updateRecoveryFlow({
        flow,
        updateRecoveryFlowBody: body as unknown as UpdateRecoveryFlowBody,
      }),
  },
  settings: {
    create: () => kratos.createBrowserSettingsFlow(),
    fetch: (id: string) => kratos.getSettingsFlow({ id }),
    submit: (flow: string, body: Record<string, string>) =>
      kratos.updateSettingsFlow({
        flow,
        updateSettingsFlowBody: body as unknown as UpdateSettingsFlowBody,
      }),
  },
  verification: {
    create: () => kratos.createBrowserVerificationFlow(),
    fetch: (id: string) => kratos.getVerificationFlow({ id }),
    submit: (flow: string, body: Record<string, string>) =>
      kratos.updateVerificationFlow({
        flow,
        updateVerificationFlowBody: body as unknown as UpdateVerificationFlowBody,
      }),
  },
} satisfies Record<
  FlowKind,
  {
    create: () => Promise<{ data: Flow }>;
    fetch: (id: string) => Promise<{ data: Flow }>;
    submit: (flow: string, body: Record<string, string>) => Promise<{ data: unknown }>;
  }
>;

async function createFlow(kind: FlowKind): Promise<Flow> {
  return (await flowApi[kind].create()).data;
}

async function getFlow(kind: FlowKind, id: string): Promise<Flow> {
  return (await flowApi[kind].fetch(id)).data;
}

/** Submit a flow step; returns the updated flow (multi-step flows like recovery continue in place). */
async function submitFlow(
  kind: FlowKind,
  id: string,
  body: Record<string, string>,
): Promise<{ ui?: UiContainer } | undefined> {
  return (await flowApi[kind].submit(id, body)).data as { ui?: UiContainer };
}

const PRIMARY_BTN =
  'w-full rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50';
const PASSKEY_BTN =
  'flex w-full items-center justify-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm font-medium transition hover:bg-accent hover:text-accent-foreground disabled:opacity-50';

// Kratos labels its nodes in English; translate the ones we render to Bulgarian.
const FIELD_LABELS: Record<string, string> = {
  identifier: 'Имейл',
  'traits.email': 'Имейл',
  email: 'Имейл',
  'traits.name.first': 'Име',
  'traits.name.last': 'Фамилия',
  password: 'Парола',
  code: 'Код',
};

function buttonLabel(name: string, value: string, kind: FlowKind, fallback?: string): string {
  if (name === 'passkey_login_trigger') return 'Вход с passkey';
  if (name === 'passkey_register_trigger')
    return kind === 'settings' ? 'Добави passkey' : 'Регистрация с passkey';
  if (name === 'passkey_remove') return 'Премахни';
  if (name === 'method' && value === 'password')
    return kind === 'registration' ? 'Регистрация' : kind === 'settings' ? 'Запази' : 'Вход';
  if (name === 'method' && value === 'profile') return 'Запази';
  if (name === 'method' && value === 'link') return 'Изпрати връзка за възстановяване';
  if (name === 'method' && value === 'code') return 'Потвърди';
  return fallback ?? 'Изпрати';
}

function PasskeyIcon() {
  // lucide "key-round"
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0"
    >
      <path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z" />
      <circle cx="16.5" cy="7.5" r=".5" fill="currentColor" />
    </svg>
  );
}

/** Stable React key for a node — its input name or script id is unique within a flow. */
function nodeKey(node: UiNode): string {
  const a = node.attributes as { name?: string; id?: string };
  return a.name ?? a.id ?? node.group;
}

function NodeField({ node, kind }: { node: UiNode; kind: FlowKind }) {
  if (node.type !== 'input') return null;
  const a = node.attributes as UiNodeInputAttributes & { onclickTrigger?: string };
  const value = a.value === undefined || a.value === null ? '' : String(a.value);

  if (a.type === 'hidden') return <input type="hidden" name={a.name} defaultValue={value} />;

  // Passkey trigger: the WebAuthn ceremony lives in Kratos's injected webauthn.js, exposed as a
  // global named by `onclickTrigger` (e.g. `oryPasskeyLogin`). Calling it reads the challenge,
  // prompts the authenticator, writes the credential into the hidden field, and natively submits
  // the form — so the <form> below carries an `action`/`method` for that submit to reach Kratos.
  if (a.type === 'button' && a.onclickTrigger) {
    return (
      <button
        type="button"
        disabled={a.disabled}
        className={PASSKEY_BTN}
        onClick={() => {
          const fn = (window as unknown as Record<string, undefined | (() => void)>)[
            a.onclickTrigger as string
          ];
          fn?.();
        }}
      >
        <PasskeyIcon />
        {buttonLabel(a.name, value, kind, node.meta?.label?.text)}
      </button>
    );
  }

  // Remove a registered passkey: a small destructive button, not the full-width primary.
  if ((a.type === 'submit' || a.type === 'button') && a.name === 'passkey_remove') {
    return (
      <button
        type="submit"
        name={a.name}
        value={value}
        disabled={a.disabled}
        className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-destructive transition hover:bg-destructive/10"
      >
        {buttonLabel(a.name, value, kind, node.meta?.label?.text)}
      </button>
    );
  }

  if (a.type === 'submit' || a.type === 'button') {
    return (
      <button
        type="submit"
        name={a.name}
        value={value}
        disabled={a.disabled}
        className={PRIMARY_BTN}
      >
        {buttonLabel(a.name, value, kind, node.meta?.label?.text)}
      </button>
    );
  }

  const label = FIELD_LABELS[a.name] ?? node.meta?.label?.text;
  return (
    <label className="block space-y-1.5">
      {label ? <span className="text-sm font-medium">{label}</span> : null}
      <Input
        name={a.name}
        type={a.type}
        defaultValue={value}
        required={a.required}
        disabled={a.disabled}
        autoComplete={a.autocomplete}
      />
      {(node.messages ?? []).map((m) => (
        <span key={m.id} className="block text-xs text-destructive">
          {m.text}
        </span>
      ))}
    </label>
  );
}

const ALT_LINKS: Record<FlowKind, { to: string; label: string }[]> = {
  login: [
    { to: '/auth/register', label: 'Създай профил' },
    { to: '/auth/recovery', label: 'Забравена парола' },
  ],
  registration: [{ to: '/auth/login', label: 'Вече имам профил' }],
  recovery: [{ to: '/auth/login', label: 'Назад към вход' }],
  verification: [{ to: '/', label: 'Към началото' }],
  settings: [{ to: '/', label: 'Към началото' }],
};

const SUBTITLES: Partial<Record<FlowKind, string>> = {
  login: 'Влезте в профила си',
  registration: 'Създайте нов профил',
  recovery: 'Ще ви изпратим връзка за смяна на паролата',
  verification: 'Потвърдете имейл адреса си',
};

// Settings page (`kind === 'settings'`) renders each Kratos method group as its own labelled
// section/form, so each submits independently (no cross-section required-field interference).
const SETTINGS_SECTIONS: { group: string; title: string; subtitle?: string }[] = [
  { group: 'profile', title: 'Профил', subtitle: 'Име и имейл' },
  { group: 'password', title: 'Парола', subtitle: 'Смяна на паролата' },
  { group: 'passkey', title: 'Passkeys', subtitle: 'Вход без парола чрез биометрия или ключ' },
];

/** The self-service flow state machine (init + script injection + submit), shared by the generic
 * login/registration/recovery/verification renderer and the account settings sections. */
function useKratosFlow(kind: FlowKind) {
  const [params] = useSearchParams();
  const flowId = params.get('flow');
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const [flow, setFlow] = useState<Flow | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const f = flowId ? await getFlow(kind, flowId) : await createFlow(kind);
        // Guard against a non-flow response (e.g. when /kratos isn't proxied and the request returns
        // the SPA's index.html): show a clear error instead of crashing the render on `f.ui.nodes`.
        if (!f?.ui?.nodes) throw new Error('invalid flow response');
        if (active) setFlow(f);
      } catch {
        if (active) {
          setFatal(
            'Услугата за вход е недостъпна. Отворете приложението на http://localhost:8790 или проверете дали Ory стекът работи.',
          );
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [kind, flowId]);

  // Inject Kratos's script nodes (the WebAuthn helper that defines the window.oryPasskey* globals).
  useEffect(() => {
    if (!flow) return;
    const added: HTMLScriptElement[] = [];
    for (const node of flow.ui.nodes) {
      if (node.type !== 'script') continue;
      const a = node.attributes as UiNodeScriptAttributes;
      if (document.getElementById(a.id)) continue;
      const s = document.createElement('script');
      s.src = a.src;
      s.id = a.id;
      s.async = true;
      s.type = a.type;
      if (a.crossorigin) s.crossOrigin = a.crossorigin;
      if (a.integrity) s.integrity = a.integrity;
      if (a.referrerpolicy) s.referrerPolicy = a.referrerpolicy;
      if (a.nonce) s.nonce = a.nonce;
      document.body.appendChild(s);
      added.push(s);
    }
    return () => {
      for (const s of added) s.remove();
    };
  }, [flow]);

  function goSameOrigin(target: string) {
    try {
      const u = new URL(target, window.location.origin);
      navigate(u.pathname + u.search, { replace: true });
    } catch {
      navigate('/', { replace: true });
    }
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!flow) return;
    const fd = new FormData(
      e.currentTarget,
      (e.nativeEvent as SubmitEvent).submitter as HTMLElement,
    );
    const body: Record<string, string> = {};
    fd.forEach((v, k) => {
      body[k] = String(v);
    });
    try {
      const out = await submitFlow(kind, flow.id, body);
      if (kind === 'login' || kind === 'registration') {
        // Terminal: a session now exists. Go home.
        await refresh();
        navigate('/', { replace: true });
        return;
      }
      if (kind === 'settings') {
        // Stay on the settings page; re-render with Kratos's "saved" message (refresh in case the
        // email/verified state changed).
        await refresh();
        if (out?.ui) setFlow(out as Flow);
        return;
      }
      // A valid recovery code hands off to the settings (new-password) flow. Kratos signals this
      // either as a 422 redirect (caught below) or — in v1.x — a 200 with a `continue_with` item;
      // handle the latter here by navigating into the settings flow.
      const cont = (out as { continue_with?: { action: string; flow?: { id: string } }[] })
        .continue_with;
      const toSettings = cont?.find((c) => c.action === 'show_settings_ui');
      if (toSettings?.flow?.id) {
        navigate(`/auth/settings?flow=${toSettings.flow.id}`, { replace: true });
        return;
      }
      // Otherwise recovery / verification are multi-step: re-render with the returned flow so the
      // next step (e.g. the emailed-code input) and its "code sent" message appear in place.
      if (out?.ui) setFlow(out as Flow);
    } catch (err) {
      const res = (err as { response?: { status?: number; data?: unknown } }).response;
      const data = res?.data as (Flow & { redirect_browser_to?: string }) | undefined;
      if (res?.status === 422 && data?.redirect_browser_to) {
        // e.g. recovery code accepted → Kratos hands off to the settings flow to set a new password.
        // Navigate SAME-ORIGIN (strip the configured host) so it works on whatever port we're on.
        goSameOrigin(data.redirect_browser_to);
      } else if ((res?.status === 400 || res?.status === 410) && data?.ui) {
        setFlow(data); // validation messages, or the next step rendered with an error
      } else {
        setFatal('Възникна грешка. Опитайте отново.');
      }
    }
  }

  return { flow, fatal, onSubmit };
}

/** The Kratos-owned settings sections (Профил / Парола / Passkeys), each a self-submitting form.
 * AccountPage composes these alongside the non-Kratos account sections (FR-431). */
export function KratosSettingsSections({ groups }: { groups?: string[] } = {}) {
  const { flow, fatal, onSubmit } = useKratosFlow('settings');
  const csrfNode = flow?.ui.nodes.find(
    (n) => n.group === 'default' && (n.attributes as UiNodeInputAttributes).name === 'csrf_token',
  );
  if (!flow) {
    return fatal ? (
      <p className="text-sm text-destructive">{fatal}</p>
    ) : (
      <p className="text-sm text-muted-foreground">Зареждане…</p>
    );
  }
  return (
    <>
      {fatal ? <p className="text-sm text-destructive">{fatal}</p> : null}
      {flowMessages(flow.ui).map((m) => (
        <p key={m} className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
          {m}
        </p>
      ))}
      {SETTINGS_SECTIONS.filter((sec) => !groups || groups.includes(sec.group)).map((sec) => {
        const secNodes = flow.ui.nodes.filter((n) => n.group === sec.group);
        if (secNodes.length === 0) return null;
        return (
          <section key={sec.group} className="space-y-3 rounded-lg border border-border p-4">
            <div>
              <h2 className="text-sm font-semibold">{sec.title}</h2>
              {sec.subtitle ? (
                <p className="text-xs text-muted-foreground">{sec.subtitle}</p>
              ) : null}
            </div>
            {/* One form per section so each method submits on its own. `action` lets the passkey
                "Add" button submit natively (via webauthn.js). */}
            <form
              onSubmit={onSubmit}
              action={flow.ui.action}
              method={flow.ui.method?.toLowerCase()}
              className="space-y-3"
            >
              {csrfNode ? <NodeField node={csrfNode} kind="settings" /> : null}
              {secNodes.map((n) => (
                <NodeField key={nodeKey(n)} node={n} kind="settings" />
              ))}
            </form>
          </section>
        );
      })}
    </>
  );
}

/** Generic single-credential flow: login / registration / recovery / verification. */
export function KratosFlow({ kind, title }: { kind: FlowKind; title: string }) {
  const { flow, fatal, onSubmit } = useKratosFlow(kind);

  // Passkey is the alternative method: render the full primary form (email + password + submit)
  // first, then an "или" divider, then the passkey button — instead of Kratos's source order, which
  // interleaves the shared email field, the passkey button, and the password field.
  const isPasskey = (g?: string) => g === 'passkey' || g === 'webauthn';
  const primaryNodes = flow?.ui.nodes.filter((n) => !isPasskey(n.group)) ?? [];
  const passkeyNodes = flow?.ui.nodes.filter((n) => isPasskey(n.group)) ?? [];
  const hasPasskeyButton = passkeyNodes.some(
    (n) => n.type === 'input' && (n.attributes as UiNodeInputAttributes).type === 'button',
  );

  return (
    <div className="flex min-h-[80vh] items-center justify-center px-4 py-12">
      <Card className="w-full max-w-sm space-y-6 p-8">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          {SUBTITLES[kind] ? (
            <p className="text-sm text-muted-foreground">{SUBTITLES[kind]}</p>
          ) : null}
        </div>
        {fatal ? <p className="text-sm text-destructive">{fatal}</p> : null}
        {flow ? (
          // `action`/`method` mirror the Kratos flow so the passkey button's native form submit
          // (triggered from webauthn.js) posts to Kratos; password & co. still go via the SDK below.
          // Hidden inputs render as display:none, so they add no gaps to the space-y rhythm.
          <form
            onSubmit={onSubmit}
            action={flow.ui.action}
            method={flow.ui.method?.toLowerCase()}
            className="space-y-4"
          >
            {flowMessages(flow.ui).map((m) => (
              <p key={m} className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
                {m}
              </p>
            ))}
            {primaryNodes.map((node) => (
              <NodeField key={nodeKey(node)} node={node} kind={kind} />
            ))}
            {hasPasskeyButton ? (
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <span className="h-px flex-1 bg-border" />
                или
                <span className="h-px flex-1 bg-border" />
              </div>
            ) : null}
            {passkeyNodes.map((node) => (
              <NodeField key={nodeKey(node)} node={node} kind={kind} />
            ))}
          </form>
        ) : (
          !fatal && <p className="text-sm text-muted-foreground">Зареждане…</p>
        )}
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {ALT_LINKS[kind].map((l) => (
            <Link key={l.to} to={l.to} className="text-primary hover:underline">
              {l.label}
            </Link>
          ))}
        </div>
      </Card>
    </div>
  );
}
