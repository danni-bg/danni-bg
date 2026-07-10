// Administrative MCP server (spec 062) — the write/manage counterpart to the read MCP (061). A thin,
// role-guarded projection of the existing admin surface: each tool wraps the SAME repo logic behind
// the SAME tier as the REST routes (human-self / org-admin / super-admin). Built PER REQUEST with the
// caller's resolved principal captured in the tool closures (the hosted server is stateless), so
// role/tenant are fresh (spec 063 FR-484). Mutations are AUDITED (FR-472); destructive ops require an
// explicit `confirm: true` (a universal confirmation; MCP elicitation is a documented follow-up,
// FR-470). Tools are TIER-FILTERED in tools/list, so a caller never sees tools above their tier.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Context } from 'hono';
import { z } from 'zod';
import type { AdminAuditRepo } from '../../../../src/store/repos/admin-audit.ts';
import type { ApiKeyRepo, ApiKeyScope } from '../../../../src/store/repos/api-keys.ts';
import type { PlatformSettingsRepo } from '../../../../src/store/repos/platform-settings.ts';
import type { TenantRole, TenantsRepo } from '../../../../src/store/repos/tenants.ts';
import type { UserRole, UserRow, UsersRepo } from '../../../../src/store/repos/users.ts';
import { llmSettingSchema } from '../admin/settings-schema.ts';
import {
  type TenantSettingsPut,
  applyTenantSettings,
  tenantSettingsView,
} from '../admin/tenant-settings.ts';
import type { AuthEnv } from '../middleware/require-auth.ts';

export const ADMIN_SERVER_INFO = { name: 'danni-bg-admin', version: '0.1.0' };

export interface AdminPrincipal {
  user: UserRow; // the caller (fresh role on user.role)
  tenantId: string; // the caller's active org
  tenantRole: TenantRole; // the caller's role in that org
}

export interface AdminMcpDeps {
  apiKeys: ApiKeyRepo;
  tenants: TenantsRepo;
  settings: PlatformSettingsRepo;
  users: UsersRepo;
  audit: AdminAuditRepo;
  now?: () => number;
}

interface AdminTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (args: unknown) => Promise<unknown>;
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  additionalProperties: false,
  required,
  properties,
});
const confirmProp = {
  confirm: { type: 'boolean', description: 'Must be true to perform this irreversible action.' },
};

/** Guard a destructive tool: reject unless `confirm === true` (FR-470). */
function requireConfirm(confirm: unknown): void {
  if (confirm !== true) {
    throw new Error('this action is irreversible — re-call with { "confirm": true } to proceed');
  }
}

function isOrgAdmin(p: AdminPrincipal): boolean {
  return p.tenantRole === 'owner' || p.tenantRole === 'admin';
}
function isSuperAdmin(p: AdminPrincipal): boolean {
  return p.user.role === 'admin';
}

/** Build the tier-filtered admin tools for `principal`. Each mutating tool audits its outcome. */
export function adminTools(principal: AdminPrincipal, deps: AdminMcpDeps): AdminTool[] {
  const audit = (action: string, target: string | null, detail: unknown, outcome: 'ok' | 'error') =>
    deps.audit.record({
      actorUserId: principal.user.id,
      actorRole: principal.user.role,
      tenantId: principal.tenantId,
      action,
      target,
      detail,
      outcome,
    });
  // Wrap a mutation so it records an audit row on success AND on error (FR-472).
  const mutate = async <T>(
    action: string,
    target: string | null,
    detail: unknown,
    fn: () => T | Promise<T>,
  ): Promise<T> => {
    try {
      const result = await fn();
      audit(action, target, detail, 'ok');
      return result;
    } catch (err) {
      audit(
        action,
        target,
        { ...(detail as object), error: err instanceof Error ? err.message : String(err) },
        'error',
      );
      throw err;
    }
  };

  const tools: AdminTool[] = [];

  // ── human-self (any authenticated human) ──────────────────────────────────────────────────────
  tools.push(
    {
      name: 'list_my_api_keys',
      description: "List the calling user's API keys (metadata only; never the secret).",
      inputSchema: obj({}),
      run: async () => deps.apiKeys.listForUser(principal.user.id),
    },
    {
      name: 'create_api_key',
      description: 'Create an API key for the calling user. The plaintext secret is returned ONCE.',
      inputSchema: obj(
        {
          name: { type: 'string' },
          scopes: { type: 'array', items: { type: 'string', enum: ['read', 'chat'] } },
        },
        ['name'],
      ),
      run: async (raw) => {
        const a = z
          .object({ name: z.string().min(1), scopes: z.array(z.enum(['read', 'chat'])).optional() })
          .parse(raw);
        return mutate('create_api_key', null, { name: a.name, scopes: a.scopes }, () =>
          deps.apiKeys.create({
            userId: principal.user.id,
            name: a.name,
            tenantId: principal.tenantId,
            ...(a.scopes ? { scopes: a.scopes as ApiKeyScope[] } : {}),
          }),
        );
      },
    },
    {
      name: 'revoke_api_key',
      description:
        "Revoke one of the calling user's API keys. Irreversible — requires confirm:true.",
      inputSchema: obj({ keyId: { type: 'string' }, ...confirmProp }, ['keyId', 'confirm']),
      run: async (raw) => {
        const a = z
          .object({ keyId: z.string().min(1), confirm: z.boolean().optional() })
          .parse(raw);
        requireConfirm(a.confirm);
        return mutate('revoke_api_key', a.keyId, {}, () => ({
          revoked: deps.apiKeys.revoke(a.keyId, principal.user.id),
        }));
      },
    },
  );

  // ── org-admin (owner/admin of the active org) ─────────────────────────────────────────────────
  if (isOrgAdmin(principal)) {
    tools.push(
      {
        name: 'list_members',
        description: "List the members of the caller's active organization.",
        inputSchema: obj({}),
        run: async () => deps.tenants.membersOf(principal.tenantId),
      },
      {
        name: 'get_tenant_settings',
        description:
          "Get the active org's settings overrides (LLM provider + default token limit). Secrets are masked.",
        inputSchema: obj({}),
        run: async () => tenantSettingsView(deps.settings, principal.tenantId),
      },
      {
        name: 'set_tenant_settings',
        description:
          "Set the active org's overridable settings (llm provider / defaultTokenLimit). apiKey is write-only.",
        inputSchema: obj({
          llm: {
            type: 'object',
            description: 'LLM provider {kind, model, baseUrl?, apiKey?} or null to clear.',
          },
          toggles: { type: 'object', description: '{ defaultTokenLimit }' },
        }),
        run: async (raw) => {
          const a = z
            .object({
              llm: z.union([llmSettingSchema, z.null()]).optional(),
              toggles: z
                .object({ defaultTokenLimit: z.number().int().nonnegative() })
                .partial()
                .optional(),
            })
            .parse(raw) as TenantSettingsPut;
          return mutate('set_tenant_settings', principal.tenantId, { keys: Object.keys(a) }, () => {
            applyTenantSettings(deps.settings, principal.tenantId, a, principal.user.id);
            return tenantSettingsView(deps.settings, principal.tenantId);
          });
        },
      },
    );
  }

  // ── super-admin (app role 'admin') ────────────────────────────────────────────────────────────
  if (isSuperAdmin(principal)) {
    tools.push(
      {
        name: 'list_tenants',
        description: 'List all organizations (super-admin), with member counts. Paginated.',
        inputSchema: obj({
          limit: { type: 'integer', minimum: 1, maximum: 200 },
          offset: { type: 'integer', minimum: 0 },
        }),
        run: async (raw) => {
          const a = z
            .object({
              limit: z.number().int().min(1).max(200).optional(),
              offset: z.number().int().min(0).optional(),
            })
            .parse(raw);
          return {
            items: deps.tenants.listAll(a.limit ?? 100, a.offset ?? 0),
            total: deps.tenants.countAll(),
          };
        },
      },
      {
        name: 'set_user_role',
        description:
          "Set a user's app role by email (admin | user). Irreversible privilege change — requires confirm:true.",
        inputSchema: obj(
          {
            email: { type: 'string' },
            role: { type: 'string', enum: ['admin', 'user'] },
            ...confirmProp,
          },
          ['email', 'role', 'confirm'],
        ),
        run: async (raw) => {
          const a = z
            .object({
              email: z.string().min(1),
              role: z.enum(['admin', 'user']),
              confirm: z.boolean().optional(),
            })
            .parse(raw);
          requireConfirm(a.confirm);
          return mutate('set_user_role', a.email, { role: a.role }, () => ({
            updated: deps.users.setRoleByEmail(a.email, a.role as UserRole),
          }));
        },
      },
      {
        name: 'set_api_key_quota',
        description:
          'Set (or clear with null) a per-key request-quota override (super-admin billing policy).',
        inputSchema: obj(
          { keyId: { type: 'string' }, limit: { type: ['integer', 'null'], minimum: 0 } },
          ['keyId'],
        ),
        run: async (raw) => {
          const a = z
            .object({
              keyId: z.string().min(1),
              limit: z.number().int().min(0).nullable().optional(),
            })
            .parse(raw);
          return mutate('set_api_key_quota', a.keyId, { limit: a.limit ?? null }, () => ({
            updated: deps.apiKeys.setQuotaLimit(a.keyId, a.limit ?? null),
          }));
        },
      },
      {
        name: 'list_audit',
        description: 'Read the admin audit trail (super-admin), most-recent-first. Paginated.',
        inputSchema: obj({
          limit: { type: 'integer', minimum: 1, maximum: 200 },
          offset: { type: 'integer', minimum: 0 },
        }),
        run: async (raw) => {
          const a = z
            .object({
              limit: z.number().int().min(1).max(200).optional(),
              offset: z.number().int().min(0).optional(),
            })
            .parse(raw);
          return deps.audit.list({ limit: a.limit ?? 50, offset: a.offset ?? 0 });
        },
      },
    );
  }

  return tools;
}

/** Build an SDK Server exposing the tier-filtered admin tools for `principal`. */
export function buildAdminMcpServer(principal: AdminPrincipal, deps: AdminMcpDeps): Server {
  const server = new Server(ADMIN_SERVER_INFO, { capabilities: { tools: {} } });
  const tools = adminTools(principal, deps);
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = tools.find((t) => t.name === req.params.name);
    if (!tool) {
      return {
        content: [{ type: 'text', text: `unknown or unauthorized tool: ${req.params.name}` }],
        isError: true,
      };
    }
    try {
      const result = await tool.run(req.params.arguments ?? {});
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: false };
    } catch (err) {
      return {
        content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
        isError: true,
      };
    }
  });
  return server;
}

/**
 * Hono handler for /admin/mcp — builds the admin server with the request's resolved principal (user +
 * active tenant, captured per request) and serves it over the web-standard transport. Mount behind
 * gate + requireHuman + requireMcpAdminScope, so a request reaching here is an authenticated human
 * with the mcp:admin capability; the tools then enforce the actual role tier.
 */
export function adminMcpHandler(deps: AdminMcpDeps): (c: Context<AuthEnv>) => Promise<Response> {
  return async (c) => {
    const user = c.get('user');
    const tenant = c.get('tenant');
    const server = buildAdminMcpServer(
      { user, tenantId: tenant.id, tenantRole: tenant.role },
      deps,
    );
    const transport = new WebStandardStreamableHTTPServerTransport();
    await server.connect(transport);
    return transport.handleRequest(c.req.raw);
  };
}
