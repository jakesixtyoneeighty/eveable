import { reconcileRelease } from "@eveable/core/publish";
import { closeDatabase } from "@eveable/core/db";
import { z } from "zod";
try {
  const id = z.uuid().parse(process.argv[2]);
  console.log(await reconcileRelease(id));
} finally {
  await closeDatabase();
}
