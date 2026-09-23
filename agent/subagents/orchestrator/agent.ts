import { defineAgent } from "eve";
import { eveableModels } from "../../lib/model.js";

export default defineAgent({
  description:
    "Turns a safe build or source-aware edit request into a capability-aware plan for design research. Tool input must contain only message.",
  model: eveableModels.orchestrator,
});
