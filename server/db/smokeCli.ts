/** `npm run db:smoke`: exits 0 when the database library works on this machine. */
import { runSmoke, runSmokeIsolated, SmokeError } from "./smoke";

try {
  const isolated = runSmokeIsolated();
  const inProcess = runSmoke();
  console.log(
    `db:smoke ok: SQLite ${inProcess.sqliteVersion} (isolated check ${isolated.sqliteVersion}), WAL write and read work`,
  );
} catch (e) {
  console.error(e instanceof SmokeError ? e.message : `db:smoke failed: ${(e as Error).message}`);
  process.exit(1);
}
