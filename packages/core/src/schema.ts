import {
  pgTable,
  bigserial,
  uuid,
  text,
  timestamp,
  boolean,
  integer,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
const time = (name: string) =>
  timestamp(name, { withTimezone: true, mode: "date" });
export const members = pgTable("members", {
  userId: text("user_id").primaryKey(),
  active: boolean("active").notNull().default(true),
  createdAt: time("created_at").notNull().defaultNow(),
});
export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => members.userId),
    name: text("name").notNull(),
    archived: boolean("archived").notNull().default(false),
    status: text("status").notNull().default("waiting"),
    currentVersionId: uuid("current_version_id"),
    publishedVersionId: uuid("published_version_id"),
    deploymentUrl: text("deployment_url"),
    vercelProjectId: text("vercel_project_id"),
    activeOperationId: uuid("active_operation_id"),
    createdAt: time("created_at").notNull().defaultNow(),
    updatedAt: time("updated_at").notNull().defaultNow(),
  },
  (t) => [index("projects_owner").on(t.ownerId, t.updatedAt)],
);
export const sessions = pgTable("project_sessions", {
  id: text("id").primaryKey(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id),
  continuationToken: text("continuation_token").notNull(),
  streamIndex: integer("stream_index").notNull().default(0),
  status: text("status").notNull().default("streaming"),
  pending: jsonb("pending").$type<ApprovalRequest[]>(),
  createdAt: time("created_at").notNull().defaultNow(),
});
export type ApprovalRequest = {
  requestId: string;
  prompt: string;
  options: { id: string; label: string }[];
};
export const operations = pgTable(
  "operations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    ownerId: text("owner_id").notNull(),
    key: text("idempotency_key").notNull(),
    kind: text("kind").notNull(),
    status: text("status").notNull().default("queued"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    baseVersionId: uuid("base_version_id"),
    versionId: uuid("version_id"),
    approved: boolean("approved").notNull().default(false),
    sessionId: text("session_id"),
    workflowId: text("workflow_id"),
    error: text("error"),
    createdAt: time("created_at").notNull().defaultNow(),
    updatedAt: time("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("operation_idempotency").on(t.projectId, t.key),
    index("operation_owner_time").on(t.ownerId, t.createdAt),
  ],
);
export const activity = pgTable(
  "activity",
  {
    cursor: bigserial("cursor", { mode: "number" }).notNull(),
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    eventKey: text("event_key").notNull(),
    kind: text("kind").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull(),
    createdAt: time("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("activity_event").on(t.projectId, t.eventKey)],
);
export const versions = pgTable(
  "versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    operationId: uuid("operation_id")
      .notNull()
      .references(() => operations.id),
    baseVersionId: uuid("base_version_id"),
    hash: text("hash").notNull(),
    blobPath: text("blob_path").notNull(),
    manifest: jsonb("manifest").$type<string[]>().notNull(),
    summary: text("summary").notNull(),
    verifiedAt: time("verified_at").notNull(),
    createdAt: time("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("version_operation").on(t.operationId)],
);
export const previews = pgTable(
  "previews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    versionId: uuid("version_id")
      .notNull()
      .references(() => versions.id),
    operationId: uuid("operation_id").notNull(),
    status: text("status").notNull().default("starting"),
    sandboxName: text("sandbox_name"),
    upstreamUrl: text("upstream_url"),
    expiresAt: time("expires_at"),
    createdAt: time("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("preview_operation").on(t.operationId)],
);
export const deployments = pgTable(
  "deployments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    versionId: uuid("version_id")
      .notNull()
      .references(() => versions.id),
    operationId: uuid("operation_id").notNull(),
    sourceHash: text("source_hash").notNull(),
    authorizedBy: text("authorized_by").notNull(),
    status: text("status").notNull().default("queued"),
    providerId: text("provider_id"),
    candidateUrl: text("candidate_url"),
    productionUrl: text("production_url"),
    createdAt: time("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("deployment_operation").on(t.operationId)],
);
