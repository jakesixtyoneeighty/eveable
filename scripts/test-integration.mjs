import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
const directory = mkdtempSync(join(tmpdir(), "eveable-postgres-"));
const run = (cmd, args, env = process.env) => {
  const result = spawnSync(cmd, args, { stdio: "inherit", env });
  if (result.status !== 0) throw new Error(`${cmd} failed (${result.status})`);
};
let started = false;
try {
  let url = process.env.EVEABLE_TEST_DATABASE_URL;
  if (!url) {
    run("initdb", [
      "-D",
      directory,
      "-A",
      "trust",
      "-U",
      "eveable_test",
      "--no-locale",
      "--encoding=UTF8",
    ]);
    run("pg_ctl", [
      "-D",
      directory,
      "-l",
      join(directory, "server.log"),
      "-o",
      "-h 127.0.0.1 -p 55439",
      "-w",
      "start",
    ]);
    started = true;
    url = "postgresql://eveable_test@127.0.0.1:55439/eveable_test";
    run("createdb", [
      "-h",
      "127.0.0.1",
      "-p",
      "55439",
      "-U",
      "eveable_test",
      "eveable_test",
    ]);
  }
  run("pnpm", ["exec", "vitest", "run", "tests/integration.test.ts"], {
    ...process.env,
    EVEABLE_TEST_DATABASE_URL: url,
  });
} finally {
  if (started)
    spawnSync("pg_ctl", ["-D", directory, "-m", "fast", "-w", "stop"], {
      stdio: "inherit",
    });
  rmSync(directory, { recursive: true, force: true });
}
