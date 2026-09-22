import { migrate } from "drizzle-orm/postgres-js/migrator";
import { database, closeDatabase } from "../packages/core/src/db.js";
try {
  await migrate(database(), { migrationsFolder: "packages/core/migrations" });
  console.log("Migrations applied.");
} finally {
  await closeDatabase();
}
