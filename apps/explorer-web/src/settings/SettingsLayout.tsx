// Reusable settings shell (spec 066/066b): a GitHub-style routed sidebar. Given a title + grouped nav,
// it renders a persistent left nav and the selected category in the content pane via <Outlet/>. Used
// by BOTH the personal account settings (/auth/settings) and the separate platform settings
// (/admin/settings) — same shell, different nav. Each category is its own deep-linkable nested route.

import { Link, NavLink, Outlet } from 'react-router-dom';

export interface NavItem {
  to: string;
  label: string;
}
export interface NavGroup {
  label?: string;
  items: NavItem[];
}

function itemClass({ isActive }: { isActive: boolean }): string {
  return isActive
    ? 'block rounded-md bg-primary/10 px-3 py-1.5 text-sm font-medium text-primary'
    : 'block rounded-md px-3 py-1.5 text-sm text-muted-foreground transition hover:bg-accent hover:text-foreground';
}

export function SettingsLayout({ title, nav }: { title: string; nav: NavGroup[] }) {
  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-10">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        <Link to="/" className="text-sm text-primary hover:underline">
          Към началото
        </Link>
      </div>
      <div className="flex flex-col gap-6 md:flex-row">
        <nav className="shrink-0 space-y-1 md:w-48">
          {nav.map((group, gi) => (
            <div key={group.label ?? `g${gi}`} className="space-y-0.5">
              {group.label ? (
                <div className="px-3 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {group.label}
                </div>
              ) : null}
              {group.items.map((it) => (
                <NavLink key={it.to} to={it.to} className={itemClass} end>
                  {it.label}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div className="min-w-0 flex-1">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
