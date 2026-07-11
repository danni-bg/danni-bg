// Settings shell (spec 066): a GitHub-style routed sidebar. A persistent left nav lists the account
// categories, plus a gated "Платформа" group for super-admins; the selected category renders in the
// content pane via <Outlet/>. Each category is its own route under /auth/settings/* (deep-linkable).

import { Link, NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.tsx';

interface NavItem {
  to: string;
  label: string;
}

const ACCOUNT_NAV: NavItem[] = [
  { to: 'profile', label: 'Профил' },
  { to: 'security', label: 'Сигурност' },
  { to: 'appearance', label: 'Облик' },
  { to: 'usage', label: 'Потребление' },
  { to: 'api-keys', label: 'API ключове' },
  { to: 'organizations', label: 'Организации' },
];
const ADMIN_NAV: NavItem[] = [
  { to: 'admin/llm', label: 'LLM и чат' },
  { to: 'admin/usage', label: 'Потребление' },
  { to: 'admin/orgs', label: 'Организации' },
];

function itemClass({ isActive }: { isActive: boolean }): string {
  return isActive
    ? 'block rounded-md bg-primary/10 px-3 py-1.5 text-sm font-medium text-primary'
    : 'block rounded-md px-3 py-1.5 text-sm text-muted-foreground transition hover:bg-accent hover:text-foreground';
}

function NavGroup({ label, items }: { label?: string; items: NavItem[] }) {
  return (
    <div className="space-y-0.5">
      {label ? (
        <div className="px-3 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </div>
      ) : null}
      {items.map((it) => (
        <NavLink key={it.to} to={it.to} className={itemClass} end>
          {it.label}
        </NavLink>
      ))}
    </div>
  );
}

export function SettingsLayout() {
  const { isAdmin } = useAuth();
  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-10">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-tight">Настройки</h1>
        <Link to="/" className="text-sm text-primary hover:underline">
          Към началото
        </Link>
      </div>
      <div className="flex flex-col gap-6 md:flex-row">
        <nav className="shrink-0 md:w-48">
          <NavGroup items={ACCOUNT_NAV} />
          {isAdmin ? <NavGroup label="Платформа" items={ADMIN_NAV} /> : null}
        </nav>
        <div className="min-w-0 flex-1">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
