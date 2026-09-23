import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  GeneratedFileSchema,
  SecurityReviewResultSchema,
} from "../lib/schemas.js";

const inputSchema = z.object({
  files: z.array(GeneratedFileSchema).min(1),
  context: z.string().optional(),
});

import { reviewSource } from "@eveable/core/source-review";
export { reviewSource } from "@eveable/core/source-review";

export default defineTool({
  description:
    "Deterministically review generated source files after validation and preview pass. Use this gate before save_project_version; publishing is separately authorized.",
  inputSchema,
  outputSchema: SecurityReviewResultSchema,
  async execute({ files }) {
    return reviewSource(files);
  },
});
