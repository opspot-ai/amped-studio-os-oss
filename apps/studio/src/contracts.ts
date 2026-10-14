import { z } from "zod";

export const LifecycleStateSchema = z.enum([
  "candidate",
  "validating",
  "offer-ready",
  "launch-ready",
  "externally-live",
  "revenue-verified",
  "fulfillment-verified",
  "scaling",
  "parked",
  "killed"
]);

const VentureIdSchema = z.string().regex(/^venture_[a-z0-9][a-z0-9_-]{0,149}$/);
const TimestampSchema = z.iso.datetime({ offset: true });
const IdempotencyKeySchema = z.string().min(8).max(240);

const InitiativeSchema = z.object({
  title: z.string().min(1),
  uncertaintyReason: z.string().min(1)
}).passthrough();

export const CompanyStateSchema = z.object({
  ventureId: VentureIdSchema,
  runState: z.enum(["idle", "running", "paused", "waiting-approval", "killed"]),
  lifecycleState: LifecycleStateSchema,
  bootstrap: z.object({
    snapshot: z.object({
      name: z.string().min(1),
      owner: z.string().min(1),
      initialGoal: z.object({ target: z.string().min(1) }).passthrough()
    }).passthrough()
  }).passthrough(),
  currentInitiative: InitiativeSchema.optional()
}).passthrough();

export const CompanyBootstrapInputSchema = z.object({
  idea: z.string().min(20).max(20_000),
  name: z.string().min(1).max(240).optional(),
  owner: z.string().min(1).max(240),
  destination: z.enum(["cash-flow", "growth", "durable-operation", "acquisition-readiness", "exit-readiness"]),
  horizonDays: z.number().int().min(1).max(3650),
  budgetCents: z.number().int().min(0).max(100_000_000),
  constraints: z.array(z.string().min(1).max(1000)),
  killConditions: z.array(z.string().min(1).max(1000)).min(1),
  permissions: z.string().min(1).max(5000),
  requestedAt: TimestampSchema,
  idempotencyKey: IdempotencyKeySchema
}).strict();

export const CommandInputSchemas = {
  "company.bootstrap": CompanyBootstrapInputSchema,
  "company.get": z.object({ ventureId: VentureIdSchema }).strict(),
  "company.list": z.object({}).strict(),
  "company.pause": z.object({
    ventureId: VentureIdSchema,
    reason: z.string().min(1),
    actor: z.string().min(1),
    requestedAt: TimestampSchema,
    idempotencyKey: IdempotencyKeySchema
  }).strict(),
  "amped.start": z.object({
    ventureId: VentureIdSchema,
    requestedAt: TimestampSchema,
    idempotencyKey: IdempotencyKeySchema
  }).strict(),
  "amped.get": z.object({
    ventureId: VentureIdSchema,
    runId: z.string().min(1)
  }).strict(),
  "approval.resolve": z.object({
    ventureId: VentureIdSchema,
    approvalId: z.string().min(1),
    expectedActionDigest: z.string().regex(/^[a-f0-9]{64}$/),
    decision: z.enum(["approve", "deny"]),
    actor: z.string().min(1),
    resolvedAt: TimestampSchema,
    idempotencyKey: IdempotencyKeySchema
  }).strict()
} as const;

export type CommandName = keyof typeof CommandInputSchemas;
export type LifecycleState = z.infer<typeof LifecycleStateSchema>;
export type CompanyState = z.infer<typeof CompanyStateSchema>;
export type CompanyBootstrapInput = z.infer<typeof CompanyBootstrapInputSchema>;
