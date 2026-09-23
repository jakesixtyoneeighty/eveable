import { defineAgent } from "eve";
import { eveableModels } from "../../lib/model.js";

export default defineAgent({
  description:
    "Proposes minimal changed-file repairs from current source and failure evidence; the root applies and verifies them. Tool input must contain only message.",
  model: eveableModels.autofix,
});
