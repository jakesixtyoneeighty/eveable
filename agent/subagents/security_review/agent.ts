import { defineAgent } from "eve";
import { eveableModels } from "../../lib/model.js";

export default defineAgent({
  description:
    "Provides optional evidence-based source review after validation and preview; does not replace run_security_review. Tool input must contain only message, including source contents.",
  model: eveableModels.securityReview,
});
