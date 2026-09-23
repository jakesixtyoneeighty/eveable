import { defineAgent } from "eve";
import { eveableModels } from "../../lib/model.js";

export default defineAgent({
  description:
    "Returns only a compact ImplementationSpec for supported approved new builds, or a blocked result. Never returns source files. Tool input must contain only message.",
  model: eveableModels.codeWriter,
});
