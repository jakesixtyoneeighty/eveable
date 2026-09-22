import { eq } from "drizzle-orm";
import { database, closeDatabase } from "../packages/core/src/db.js";
import { members } from "../packages/core/src/schema.js";
const [action, userId] = process.argv.slice(2);
if (!["provision", "revoke"].includes(action) || !userId?.startsWith("user_"))
  throw new Error("Usage: member:provision|member:revoke <Clerk user ID>");
try {
  if (action === "provision")
    await database()
      .insert(members)
      .values({ userId })
      .onConflictDoUpdate({ target: members.userId, set: { active: true } });
  else
    await database()
      .update(members)
      .set({ active: false })
      .where(eq(members.userId, userId));
  console.log(
    `Membership ${action === "provision" ? "activated" : "revoked"}.`,
  );
} finally {
  await closeDatabase();
}
