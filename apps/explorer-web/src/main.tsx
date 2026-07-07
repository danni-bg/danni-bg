import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { App } from './App.tsx';
import { AccountPage } from './account/AccountPage.tsx';
import { SettingsPage } from './admin/SettingsPage.tsx';
import { AuthProvider } from './auth/AuthContext.tsx';
import { AuthError, Callback } from './auth/Callback.tsx';
import { KratosFlow } from './auth/KratosFlow.tsx';
import { RequireAdmin } from './auth/guards.tsx';
import { applyResolvedTheme, loadTheme, resolveTheme } from './lib/theme.ts';
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
            <Route path="/auth/settings" element={<AccountPage />} />
            <Route path="/auth/callback" element={<Callback />} />
            <Route path="/auth/error" element={<AuthError />} />
            <Route
              path="/admin/settings"
              element={
                <RequireAdmin>
                  <SettingsPage />
                </RequireAdmin>
              }
            />
          </Routes>
        </AuthProvider>
      </BrowserRouter>
    </StrictMode>,
  );
}
