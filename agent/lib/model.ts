export type EveableModelRole =
  | "root"
  | "intent"
  | "orchestrator"
  | "designResearch"
  | "codeWriter"
  | "autofix"
  | "securityReview"
  | "conversation";

const fromEnv = (keys: string | readonly string[], fallback: string) => {
  const envKeys = Array.isArray(keys) ? keys : [keys];

  for (const key of envKeys) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }

  return fallback;
};

export const eveableModels = {
  root: fromEnv(
    ["EVEABLE_ROOT_MODEL", "MAYAR_ROOT_MODEL"],
    "anthropic/claude-opus-5.5",
  ),
  intent: fromEnv("INTENT_AGENT_MODEL", "google/gemini-3.8-flash"),
  orchestrator: fromEnv(
    "ORCHESTRATOR_AGENT_MODEL",
    "anthropic/claude-opus-5.5",
  ),
  designResearch: fromEnv(
    "DESIGN_RESEARCH_AGENT_MODEL",
    "anthropic/claude-fable-5.1",
  ),
  codeWriter: fromEnv("CODE_WRITER_AGENT_MODEL", "openai/gpt-6-sol"),
  autofix: fromEnv("AUTOFIX_AGENT_MODEL", "anthropic/claude-opus-5.5"),
  securityReview: fromEnv(
    "SECURITY_REVIEW_AGENT_MODEL",
    "openai/gpt-6-astra",
  ),
  conversation: fromEnv(
    "CONVERSATION_AGENT_MODEL",
    "anthropic/claude-sonnet-5",
  ),
} satisfies Record<EveableModelRole, string>;
