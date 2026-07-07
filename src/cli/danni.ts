import { getLogger } from '../logging/logger.ts';

const HELP = `danni — local mirror of data.egov.bg

USAGE
  danni <command> [flags]

COMMANDS
  sync          Trigger a sync run (discover + capture)
  curate        Curate captured resources into UTF-8 declared-schema artifacts
  index         Build / update FTS5 + vector index over the curated mirror
  refresh-metadata  Backfill source timestamps (metadata_modified) without re-downloading resources
  status        Print health and recent run history
  search        Run a query against the index
  eval          Measure search recall@K against a labelled query set (SC-004)
  schedule      Manage the scheduler (install | disable | show)
  mirror-info   Print the curated-dataset record for a single dataset
  mcp           Run a read-only MCP server over stdio (for LLM-agent consumers)
  admin         Manage user tiers (grant | revoke | list) — e.g. danni admin grant <email>
  backup        Write a verified snapshot of the live store — e.g. danni backup <dest>

FLAGS
  --help        Show this help

See specs/001-egov-data-sync/contracts/cli.md for full flag documentation.
`;

type CommandHandler = (args: string[]) => Promise<number>;

const commandLoaders: Record<string, () => Promise<{ run: CommandHandler }>> = {
  sync: () => import('./sync.ts').then((m) => ({ run: m.run })),
  curate: () => import('./curate.ts').then((m) => ({ run: m.run })),
  index: () => import('./index-cmd.ts').then((m) => ({ run: m.run })),
  'refresh-metadata': () => import('./refresh-metadata.ts').then((m) => ({ run: m.run })),
  status: () => import('./status.ts').then((m) => ({ run: m.run })),
  search: () => import('./search.ts').then((m) => ({ run: m.run })),
  eval: () => import('./eval.ts').then((m) => ({ run: m.run })),
  schedule: () => import('./schedule.ts').then((m) => ({ run: m.run })),
  'mirror-info': () => import('./mirror-info.ts').then((m) => ({ run: m.run })),
  mcp: () => import('./mcp.ts').then((m) => ({ run: m.run })),
  admin: () => import('./admin.ts').then((m) => ({ run: m.run })),
  backup: () => import('./backup.ts').then((m) => ({ run: m.run })),
};

export async function main(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    process.stdout.write(HELP);
    return 0;
  }

  const cmd = argv[0];
  if (!cmd) {
    process.stdout.write(HELP);
    return 0;
  }
  const rest = argv.slice(1);

  const loader = commandLoaders[cmd];
  if (!loader) {
    process.stderr.write(`Unknown command: ${cmd}\n${HELP}`);
    return 2;
  }

  try {
    const mod = await loader();
    return await mod.run(rest);
  } catch (err) {
    const log = getLogger();
    log.error('cli.command_failed', {
      command: cmd,
      error: err instanceof Error ? err.message : String(err),
    });
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    return 4;
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
      process.exit(4);
    },
  );
}
