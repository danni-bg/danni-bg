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
import { SettingsLayout } from './settings/SettingsLayout.tsx';
import './index.css';

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
            {/* Settings: a routed sidebar (spec 066). Account categories are open; the platform group
                is guarded per route. Deep-linkable at /auth/settings/<category>. */}
            <Route path="/auth/settings" element={<SettingsLayout />}>
              <Route index element={<Navigate to="profile" replace />} />
              <Route path="profile" element={<ProfileSection />} />
              <Route path="security" element={<SecuritySection />} />
              <Route path="appearance" element={<AppearanceSection />} />
              <Route path="usage" element={<SelfUsage />} />
              <Route path="api-keys" element={<ApiKeys />} />
              <Route path="organizations" element={<Organizations />} />
              <Route
                path="admin/llm"
                element={
                  <RequireAdmin>
                    <PlatformLlmSettings />
                  </RequireAdmin>
                }
              />
              <Route
                path="admin/usage"
                element={
                  <RequireAdmin>
                    <AdminUsage />
                  </RequireAdmin>
                }
              />
              <Route
                path="admin/orgs"
                element={
                  <RequireAdmin>
                    <OrgEntitlements />
                  </RequireAdmin>
                }
              />
            </Route>
            {/* Back-compat: the old platform-settings URL redirects into the new sidebar (guarded). */}
            <Route
              path="/admin/settings"
              element={
                <RequireAdmin>
                  <Navigate to="/auth/settings/admin/llm" replace />
                </RequireAdmin>
              }
            />
            <Route path="/auth/callback" element={<Callback />} />
            <Route path="/auth/error" element={<AuthError />} />
          </Routes>
        </AuthProvider>
      </BrowserRouter>
    </StrictMode>,
  );
}
