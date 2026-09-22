import { defineTool } from "eve/tools";
import { z } from "zod";
export default defineTool({
  description:
    "Publishing requires the authenticated web Publish confirmation for an exact saved version. This tool cannot deploy from a generated-app sandbox.",
  inputSchema: z.object({}),
  async execute() {
    return {
      status: "blocked",
      message:
        "Use Publish in the project workspace to authorize a release of a saved version. Deployment credentials never enter generated-app sandboxes.",
      nextAgent: "user_action",
    };
  },
});
