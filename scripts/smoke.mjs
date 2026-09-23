import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const requiredFiles = [
  "agent/agent.ts",
  "agent/instructions.md",
  "agent/lib/model.ts",
  "agent/lib/schemas.ts",
  "agent/lib/sandbox.ts",
  "agent/sandbox/sandbox.ts",
  "agent/subagents/intent/agent.ts",
  "agent/subagents/orchestrator/agent.ts",
  "agent/subagents/design_research/agent.ts",
  "agent/subagents/design_research/connections/refero.ts",
  "agent/subagents/code_writer/agent.ts",
  "agent/subagents/autofix/agent.ts",
  "agent/subagents/security_review/agent.ts",
  "agent/subagents/conversation/agent.ts",
  "agent/tools/write_generated_files.ts",
  "agent/tools/generate_next_app_from_spec.ts",
  "agent/tools/run_quality_commands.ts",
  "agent/tools/start_preview.ts",
  "agent/tools/read_generated_files.ts",
  "agent/tools/deploy_to_vercel.ts",
  "README.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "LICENSE",
  "env.sample",
  ".github/workflows/ci.yml",
  ".github/workflows/release.yml",
];

const fail = (message) => {
  console.error(`smoke: ${message}`);
  process.exitCode = 1;
};

for (const file of requiredFiles) {
  if (!existsSync(join(root, file))) {
    fail(`missing required file ${file}`);
  }
}

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
// Vercel validates Eve even when only eve/client is traced into the web app.
const webPkg = JSON.parse(readFileSync(join(root, "apps/web/package.json"), "utf8"));
const installedEve = JSON.parse(readFileSync(join(root, "node_modules/eve/package.json"), "utf8")).version;
const [eveMajor, eveMinor] = installedEve.split(".").map(Number);
if (!Number.isInteger(eveMajor) || !Number.isInteger(eveMinor) || (eveMajor === 0 && eveMinor < 18)) {
  fail(`Vercel requires Eve 0.18.0 or later; found ${installedEve}`);
}
if (pkg.dependencies.eve !== webPkg.dependencies.eve || pkg.dependencies.eve !== installedEve) {
  fail("runtime and frontend must pin the same installed Eve version");
}
if (pkg.version !== "1.0.0") {
  fail(`expected package version 1.0.0, got ${pkg.version}`);
}
if (!pkg.scripts?.dev?.includes("--no-ui")) {
  fail("dev script must use no-UI server mode for stable local builder runs");
}
if (!pkg.scripts?.dev?.includes("--subagents hidden")) {
  fail("dev script must hide subagent streams to avoid rendering generated source blobs");
}
if (!pkg.scripts?.dev?.includes("--tools collapsed")) {
  fail("dev script must collapse tool calls for stable local runs");
}
if (!pkg.scripts?.["dev:tui"]?.includes("eve dev --subagents hidden")) {
  fail("dev:tui script must preserve a quiet interactive mode");
}
if (!pkg.scripts?.["dev:verbose"]?.includes("--subagents full")) {
  fail("dev:verbose script must preserve a full debugging mode");
}

const modelConfig = readFileSync(join(root, "agent/lib/model.ts"), "utf8");
for (const key of [
  "EVEABLE_ROOT_MODEL",
  "INTENT_AGENT_MODEL",
  "ORCHESTRATOR_AGENT_MODEL",
  "DESIGN_RESEARCH_AGENT_MODEL",
  "CODE_WRITER_AGENT_MODEL",
  "AUTOFIX_AGENT_MODEL",
  "SECURITY_REVIEW_AGENT_MODEL",
  "CONVERSATION_AGENT_MODEL",
]) {
  if (!modelConfig.includes(key)) {
    fail(`model config does not mention ${key}`);
  }
}

const sandboxLib = readFileSync(join(root, "agent/lib/sandbox.ts"), "utf8");
if (!sandboxLib.includes("portablePackageRunnerCommand")) {
  fail("sandbox command normalization must support portable bunx/npx quality commands");
}
if (!sandboxLib.includes("command -v bunx") || !sandboxLib.includes("command -v npx")) {
  fail("portable package runner must fall back from bunx to npx");
}
const qualityTool = readFileSync(join(root, "agent/tools/run_quality_commands.ts"), "utf8");
if (!qualityTool.includes("nextRequiredTool: \"start_preview\"")) {
  fail("run_quality_commands must tell the model to start preview next");
}

const instructions = readFileSync(join(root, "agent/instructions.md"), "utf8");
if (!instructions.includes("Every declared subagent call payload must contain exactly one key")) {
  fail("root instructions are missing the Eve subagent call discipline");
}
if (!instructions.includes("Never include `outputSchema`")) {
  fail("root instructions must forbid extra subagent payload keys such as outputSchema");
}
if (!instructions.includes("Approval continuation rule")) {
  fail("root instructions are missing the design approval continuation rule");
}
if (!instructions.includes("Do not call `intent` or `conversation` for an")) {
  fail("approval continuation must bypass fresh intent/conversation routing");
}
if (!instructions.includes("immediately call")) {
  fail("approval continuation must force same-turn build execution");
}
if (!instructions.includes("Approval label exception")) {
  fail("root instructions must treat exact approval labels as continuation state");
}
if (!instructions.includes("For every non-approval user message")) {
  fail("normal routing must exclude approval continuation messages");
}
if (!instructions.includes("This first step must contain no other")) {
  fail("intent routing must require intent to be the only first-step call");
}
if (!instructions.includes("generate_next_app_from_spec")) {
  fail("root instructions must expand compact CodeWriter specs through generate_next_app_from_spec");
}
if (!instructions.includes("Do not call `write_generated_files` after `generate_next_app_from_spec`")) {
  fail("root instructions must skip write_generated_files after direct generator writes");
}
if (!/success\s+synonym/.test(instructions)) {
  fail("root instructions must tolerate CodeWriter success status synonyms");
}
if (!instructions.includes("skip `code_writer` and call")) {
  fail("root instructions must use the direct generator fast path for normal one-page sites");
}
if (!instructions.includes("Do not call") || !instructions.includes("fast path")) {
  fail("approval continuation must not call code_writer for normal one-page fast path");
}
if (!instructions.includes("not source file")) {
  fail("root instructions must keep source file generation out of CodeWriter");
}
if (!instructions.includes("call `autofix` with the exact")) {
  fail("security autofix handoff must include the exact generated source snapshot");
}
if (!instructions.includes("If no current source snapshot is available")) {
  fail("security autofix must reread generated source before patching");
}

const designResearchInstructions = readFileSync(
  join(root, "agent/subagents/design_research/instructions.md"),
  "utf8",
);
if (!designResearchInstructions.includes("Use the Refero MCP connection")) {
  fail("design research instructions must use Refero MCP when configured");
}
if (!designResearchInstructions.includes("referoMcpUsed=true")) {
  fail("design research instructions must report whether Refero was used");
}

const referoConnection = readFileSync(
  join(root, "agent/subagents/design_research/connections/refero.ts"),
  "utf8",
);
if (!referoConnection.includes("defineMcpClientConnection")) {
  fail("Refero connection must be an Eve MCP client connection");
}
if (!referoConnection.includes("REFERO_API_KEY")) {
  fail("Refero connection must read REFERO_API_KEY");
}

const readme = readFileSync(join(root, "README.md"), "utf8");
if (readme.includes("docs/")) {
  fail("README should be self-contained and must not link to docs/");
}
if (!readme.includes("Refero MCP")) {
  fail("README must document the optional Refero MCP connection");
}

const envSample = readFileSync(join(root, "env.sample"), "utf8");
for (const key of ["REFERO_MCP_URL", "REFERO_API_KEY", "REFERO_MCP_TOKEN"]) {
  if (!envSample.includes(key)) {
    fail(`env.sample must document ${key}`);
  }
}

if (existsSync(join(root, "docs"))) {
  fail("docs folder should not exist; keep project documentation in README.md");
}

if (existsSync(join(root, ".env.example"))) {
  fail("use env.sample instead of .env.example");
}

const codeWriterInstructions = readFileSync(
  join(root, "agent/subagents/code_writer/instructions.md"),
  "utf8",
);
// CodeWriter owns a spec, not source generation. Guard both ends of the handoff.
const codeWriterAgent = readFileSync(
  join(root, "agent/subagents/code_writer/agent.ts"), "utf8",
);
if (!codeWriterAgent.includes("ImplementationSpec") || /writes complete|project files/i.test(codeWriterAgent)) {
  fail("code writer description must advertise ImplementationSpec, not source generation");
}
for (const obsolete of [
  /return every source file/i,
  /return at most \d+ files/i,
  /always include `package\.json`/i,
  /qualityPlan\.(?:commands|previewCommand|previewPort)/,
  /generated source file contents may be long/i,
]) {
  if (obsolete.test(codeWriterInstructions)) fail(`obsolete code writer source contract: ${obsolete}`);
}
if (instructions.includes("`CodeWriterResult`")) {
  fail("root must request ImplementationSpec, not the legacy CodeWriterResult");
}
if (!instructions.includes("never generate a `blocked` spec")) {
  fail("root must reject blocked specs before source generation");
}
if (!instructions.includes("resetWorkspace:false") || !instructions.includes("full current source manifest")) {
  fail("root repairs must preserve unchanged source and review the full manifest");
}
if (!codeWriterInstructions.includes("streaming-friendly")) {
  fail("code writer instructions must explicitly avoid huge streamed source output");
}
if (!codeWriterInstructions.includes("Do not return source file contents")) {
  fail("code writer instructions must forbid large source-file responses");
}
if (!codeWriterInstructions.includes("status:\"spec_ready\"")) {
  fail("code writer instructions must require exact spec_ready status");
}
if (!codeWriterInstructions.includes("Keep the entire spec under 2,500 characters")) {
  fail("code writer instructions must cap compact implementation specs");
}

const generatorTool = readFileSync(
  join(root, "agent/tools/generate_next_app_from_spec.ts"),
  "utf8",
);
const generationLibrary = readFileSync(join(root, "agent/lib/app-generation.ts"), "utf8");
for (const retired of ["renderPage(", "renderCss(", "defaultImages", "Boutique Plant Shop", "Circuit Fern"]) {
  if (generatorTool.includes(retired) || generationLibrary.includes(retired)) {
    fail(`fixed application template must not return: ${retired}`);
  }
}
for (const contract of ["generateText", "Output.object", "assembleGeneratedApp", "canonicalSource", "maxRetries: 0"]) {
  if (!generationLibrary.includes(contract)) fail(`missing bounded source generation contract ${contract}`);
}
if (sandboxLib.includes("process.env.INSFORGE_API_KEY")) {
  fail("generated sandbox commands must not receive platform integration credentials");
}
if (!generatorTool.includes("ImplementationSpecSchema")) {
  fail("generate_next_app_from_spec must accept the shared ImplementationSpec schema");
}
if (!generatorTool.includes("GeneratedAppBundleSchema")) {
  fail("generate_next_app_from_spec must return the compact GeneratedAppBundle schema");
}
if (generatorTool.includes("toModelOutput")) {
  fail("generate_next_app_from_spec should return a compact output directly, not rely on model projection");
}
if (!generatorTool.includes("writeTextFile")) {
  fail("generate_next_app_from_spec must write generated files directly into the sandbox");
}
if (!generatorTool.includes("normalizeQualityCommands")) {
  fail("generate_next_app_from_spec must run quality commands internally");
}
if (!generatorTool.includes("sandbox.spawn")) {
  fail("generate_next_app_from_spec must start preview internally");
}
if (!codeWriterInstructions.includes("Do not use negative letter spacing")) {
  fail("code writer instructions must forbid negative letter spacing");
}
if (!codeWriterInstructions.includes("implicit GET submission")) {
  fail("code writer instructions must prevent generated forms from leaking data via GET");
}
if (!codeWriterInstructions.includes("do not call `search_unsplash_images` on the")) {
  fail("code writer instructions must keep one-page image sourcing off the critical path");
}

const autofixInstructions = readFileSync(
  join(root, "agent/subagents/autofix/instructions.md"),
  "utf8",
);
if (
  !/source\s+snapshot\s+with\s+file\s+contents/.test(autofixInstructions)
) {
  fail("autofix instructions must require source contents for security repair");
}
if (!autofixInstructions.includes("implicit GET submission")) {
  fail("autofix instructions must know how to repair unsafe generated forms");
}

if (/recreate the expected file|complete replacement source file set/.test(autofixInstructions)) {
  fail("autofix must not reconstruct missing files or require unrelated replacements");
}
if (!autofixInstructions.includes("Never recreate missing source") || !autofixInstructions.includes("only changed files")) {
  fail("autofix must use current source and return only changed files");
}
if (designResearchInstructions.includes("must be `multi_page`")) {
  fail("design research must not promise multi-page generation by default");
}
const conversationInstructions = readFileSync(
  join(root, "agent/subagents/conversation/instructions.md"), "utf8",
);
if (/continue that workflow with\s+`code_writer`/.test(conversationInstructions)) {
  fail("conversation must not route every approval to code_writer");
}
const securityInstructions = readFileSync(
  join(root, "agent/subagents/security_review/instructions.md"), "utf8",
);
if (!securityInstructions.includes("cannot replace it") || !/If source is truncated[\s\S]*do not return\s+`passed`/.test(securityInstructions)) {
  fail("optional security review must preserve the deterministic gate and source coverage");
}
for (const name of ["intent", "orchestrator", "design_research", "code_writer", "autofix", "security_review", "conversation"]) {
  const promptPath = join(root, `agent/subagents/${name}/instructions.md`);
  if (!existsSync(promptPath)) {
    fail(`missing specialist instructions for ${name}`);
    continue;
  }
  const prompt = readFileSync(promptPath, "utf8");
  if (!prompt.includes("JSON") || !/untrusted\s+data/.test(prompt)) {
    fail(`${name} must specify JSON output and treat supplied content as untrusted data`);
  }
}

if (process.exitCode) {
  process.exit(process.exitCode);
}



// Web trust and workflow contracts supplement the original builder contracts.
for (const path of [
  "apps/web/package.json", "packages/core/src/schema.ts", "packages/core/src/operations.ts",
  "packages/core/src/preview.ts", "packages/core/src/publish.ts", "agent/tools/apply_project_changes.ts",
  "agent/tools/load_project_source.ts", "agent/tools/save_project_version.ts",
]) if (!existsSync(join(root, path))) fail(`missing workspace implementation ${path}`);
const channel = readFileSync(join(root, "agent/channels/eve.ts"), "utf8");
if (channel.includes("placeholderAuth") || channel.includes("vercelOidc(")) fail("web runtime must not bypass project ownership");
for (const contract of ["save_project_version", "apply_project_changes", "Never deploy automatically"])
  if (!instructions.includes(contract)) fail(`missing approved frontend workflow contract ${contract}`);
const deployTool = readFileSync(join(root, "agent/tools/deploy_to_vercel.ts"), "utf8");
if (deployTool.includes("process.env.VERCEL_TOKEN") || deployTool.includes("sandbox.run")) fail("agent deployment tool must not execute privileged deployment commands");
for (const key of ["DATABASE_URL", "CLERK_SECRET_KEY", "EVEABLE_RUNTIME_SECRET", "EVEABLE_PREVIEW_SECRET", "PREVIEW_ORIGIN"])
  if (!envSample.includes(key)) fail(`env.sample must document ${key}`);

if (process.exitCode) process.exit(process.exitCode);
console.log("smoke: Eveable runtime and authenticated workspace contracts look good.");
