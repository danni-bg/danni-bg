# Backup & restore

danni keeps **everything in one SQLite file**, `store/danni.sqlite`: the synced data.egov.bg mirror
**and** all SaaS state — users, hashed API keys, token/usage metering, tenants, and chat sessions.
Losing that file loses identity and billing history, not just a re-syncable mirror. Size your backup
retention accordingly. (Spec 043; splitting mirror vs. SaaS state into separate files is a possible
future step but deliberately out of scope today.)

## Backing up

```sh
danni backup <dest>            # e.g. danni backup backups/danni-2026-07-07.sqlite
danni backup <dest> --json     # machine-readable result (path, bytes, integrity_check, objects)
```

`danni backup` takes an online snapshot of the **live** database without stopping the server:

- It checkpoints the WAL and runs `VACUUM INTO <dest>`, which reads under SQLite's online-backup
  semantics — concurrent writers (the pipeline or the serving layer) stay safe.
- It then re-opens the output and runs `PRAGMA integrity_check` plus an object-count probe, and only
  reports success if the copy is a healthy, populated database.
- The destination must not already exist (`VACUUM INTO` refuses to overwrite); pick a fresh path,
  typically timestamped.

The output is a single, self-contained `.sqlite` file with no `-wal`/`-shm` siblings — safe to copy
offsite. Scheduling backups and offsite/PITR replication (e.g. Litestream) are deployment concerns
handled in the private deploy repo; this repo ships the `danni backup` primitive.

## Restoring

1. **Stop the server** (and any `danni sync/curate/index`) so nothing is writing the store.
2. **Replace the file.** Put the snapshot in place of `store/danni.sqlite`, and remove any stale
   write-ahead-log siblings so SQLite doesn't replay an old WAL over the restored data:

   ```sh
   rm -f store/danni.sqlite store/danni.sqlite-wal store/danni.sqlite-shm
   cp backups/danni-2026-07-07.sqlite store/danni.sqlite
   ```

3. **Run migrations** to bring the restored file to the current schema (safe/idempotent — already
   applied migrations are skipped):

   ```sh
   bun run db:migrate
   ```

4. **Start the server.** Verify: `danni status` reports the expected last sync, and the explorer
   serves the expected dataset counts.
