import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { App } from './App.tsx';
import { ApiKeys } from './account/ApiKeys.tsx';
import { AppearanceSection } from './account/AppearanceSection.tsx';
import { Organizations } from './account/Organizations.tsx';
import { ProfileSection } from './account/ProfileSection.tsx';
import { SecuritySection } from './account/SecuritySection.tsx';
import { SelfUsage } from './account/SelfUsage.tsx';
import { AdminUsage } from './admin/AdminUsage.tsx';
import { OrgEntitlements } from './admin/OrgEntitlements.tsx';
import { PlatformLlmSettings } from './admin/PlatformLlmSettings.tsx';
import { AuthProvider } from './auth/AuthContext.tsx';
import { AuthError, Callback } from './auth/Callback.tsx';
import { KratosFlow } from './auth/KratosFlow.tsx';
import { RequireAdmin } from './auth/guards.tsx';
import { applyResolvedTheme, loadTheme, resolveTheme } from './lib/theme.ts';
import { type NavGroup, SettingsLayout } from './settings/SettingsLayout.tsx';
import './index.css';

// Personal account settings (open to any signed-in user) and platform settings (super-admin, its own
// page) are two SEPARATE surfaces sharing the same shell (spec 066b) — each with its own routed nav.
const ACCOUNT_NAV: NavGroup[] = [
  {
    items: [
      { to: 'profile', label: 'Профил' },
      { to: 'security', label: 'Сигурност' },
      { to: 'appearance', label: 'Облик' },
      { to: 'usage', label: 'Потребление' },
      { to: 'api-keys', label: 'API ключове' },
      { to: 'organizations', label: 'Организации' },
    ],
  },
];
const PLATFORM_NAV: NavGroup[] = [
  { label: 'Чат', items: [{ to: 'llm', label: 'LLM и чат' }] },
  {
    label: 'Управление',
    items: [
      { to: 'usage', label: 'Потребление' },
      { to: 'orgs', label: 'Организации' },
    ],
  },
];

// Apply the stored theme before first paint to avoid a flash of the wrong theme.
applyResolvedTheme(
  document.documentElement,
  resolveTheme(loadTheme(localStorage), window.matchMedia('(prefers-color-scheme: dark)').matches),
);

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <BrowserRouter>
        <AuthProvider>
          <Routes>
            <Route path="/" element={<App />} />
            <Route path="/auth/login" element={<KratosFlow kind="login" title="Вход" />} />
            <Route
              path="/auth/register"
              element={<KratosFlow kind="registration" title="Регистрация" />}
            />
            <Route
              path="/auth/recovery"
              element={<KratosFlow kind="recovery" title="Възстановяване на достъп" />}
            />
            <Route
              path="/auth/verification"
              element={<KratosFlow kind="verification" title="Потвърждение на имейл" />}
            />
            {/* Personal account settings (spec 066): open categories in a routed sidebar. */}
            <Route
              path="/auth/settings"
              element={<SettingsLayout title="Настройки" nav={ACCOUNT_NAV} />}
            >
              <Route index element={<Navigate to="profile" replace />} />
              <Route path="profile" element={<ProfileSection />} />
              <Route path="security" element={<SecuritySection />} />
              <Route path="appearance" element={<AppearanceSection />} />
              <Route path="usage" element={<SelfUsage />} />
              <Route path="api-keys" element={<ApiKeys />} />
              <Route path="organizations" element={<Organizations />} />
            </Route>
            {/* Platform settings (spec 066b): a SEPARATE super-admin page with its own grouped nav. The
                whole subtree is gated — a non-admin is sent home before the layout renders. */}
            <Route
              path="/admin/settings"
              element={
                <RequireAdmin>
                  <SettingsLayout title="Платформа" nav={PLATFORM_NAV} />
                </RequireAdmin>
              }
            >
              <Route index element={<Navigate to="llm" replace />} />
              <Route path="llm" element={<PlatformLlmSettings />} />
              <Route path="usage" element={<AdminUsage />} />
              <Route path="orgs" element={<OrgEntitlements />} />
            </Route>
            <Route path="/auth/callback" element={<Callback />} />
            <Route path="/auth/error" element={<AuthError />} />
          </Routes>
        </AuthProvider>
      </BrowserRouter>
    </StrictMode>,
  );
}
