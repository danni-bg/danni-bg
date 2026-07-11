// US9 — admin platform settings (spec 019): an admin opens the settings page and sees the LLM
// provider with the API key masked; a non-admin is kept out. Auth + admin API are stubbed.

import { expect, test } from '@playwright/test';
import { stubAdminSettings, stubApi, stubAuth } from './fixtures.ts';

test('an admin opens the settings page and sees the provider with a masked key', async ({
  page,
}) => {
  await stubApi(page);
  await stubAuth(page, { id: 'a1', email: 'admin@example.com', role: 'admin' });
  await stubAdminSettings(page);
  await page.goto('/');

  await page.getByRole('button', { name: 'Профил меню' }).click();
  await page.getByRole('link', { name: 'Платформа' }).click();
  // Spec 066b: platform settings are a SEPARATE page at /admin/settings; its index → the LLM category.
  await expect(page).toHaveURL(/\/admin\/settings\/llm$/);
  await expect(page.getByRole('heading', { name: 'LLM и чат' })).toBeVisible();

  // Provider config is hydrated; the API key is shown only as a masked hint.
  await expect(page.getByLabel('Модел')).toHaveValue('deepseek-v4-pro');
  await expect(page.getByText(/••••c7f/)).toBeVisible();
});

test('a non-admin has no settings link and is redirected away from /admin/settings', async ({
  page,
}) => {
  await stubApi(page);
  await stubAuth(page, { id: 'u1', email: 'user@example.com', role: 'user' });
  await page.goto('/admin/settings');

  // RequireAdmin sends a normal user back home (chat input visible = signed in on home).
  await expect(page).toHaveURL('http://localhost:5173/');
  await expect(page.getByLabel('Въпрос')).toBeVisible();
  // A normal user sees their own settings link but not the admin platform one (in the avatar menu).
  await page.getByRole('button', { name: 'Профил меню' }).click();
  await expect(page.getByRole('link', { name: 'Настройки' })).toHaveCount(1);
  await expect(page.getByRole('link', { name: 'Платформа' })).toHaveCount(0);
});
