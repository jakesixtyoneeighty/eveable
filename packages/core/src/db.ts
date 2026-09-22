import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "@eveable/core/schema";
let connection: ReturnType<typeof postgres> | undefined;
export function database() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not configured");
  connection ??= postgres(url, { max: 5, prepare: false });
  return drizzle(connection, { schema });
}
export async function closeDatabase() {
  await connection?.end();
  connection = undefined;
}
