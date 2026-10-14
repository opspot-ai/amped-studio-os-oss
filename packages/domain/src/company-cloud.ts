import {
  CommandInputSchemas,
  CommandNameSchema,
  executionContext,
  sha256,
  type ApprovalResolveInput,
  type CommandName,
  type CompanyBootstrapInput,
  type CompanyControlInput,
  type CompanyDeleteInput,
  type CompanyRunInput,
  type UsageSummaryInput
} from "@amped-studio-os/contracts";
import { OpenAIResponsesAdapter, ResendEmailAdapter } from "@amped-studio-os/adapters";
import {
  KernelStorageAccessError,
  KernelStorageConflictError,
  type KernelStorage,
  type PostgresKernelStorage
} from "@amped-studio-os/storage";
import {
  CompanyAutonomy,
  CompanyAutonomyError,
  DEFAULT_OPENAI_TARIFF,
  OpenAICeoExecutor
} from "./autonomous.js";
import { CompanyInitiativeWorker, OpenAIInitiativeExecutor } from "./initiative.js";
import { GoldenCompanyWorker, PublicAssetGoldenExecutionExecutor, ResendGoldenExecutionExecutor, type GoldenExecutionExecutor } from "./golden-provider.js";
import { AmpedGraphError, AmpedGraphService, AmpedGraphWorker, OpenAIAmpedNodeExecutor } from "./amped.js";

export const COMPANY_COMMAND_NAMES = [
  "company.bootstrap",
  "company.get",
  "company.list",
  "company.run",
  "company.pause",
  "company.kill",
  "company.export",
  "company.delete",
  "amped.start",
  "amped.get",
  "amped.replay",
  "amped.shadow",
  "approval.resolve",
  "approval.list_pending",
  "usage.summary"
] as const satisfies readonly CommandName[];

export type CompanyCommandName = (typeof COMPANY_COMMAND_NAMES)[number];

export type CompanyCommandResponse =
  | { ok: true; command: CompanyCommandName; data: unknown }
  | { ok: false; command?: CompanyCommandName; error: { code: string; message: string } };

const allowedCommands = new Set<CommandName>(COMPANY_COMMAND_NAMES);

function isCompanyCommand(command: CommandName): command is CompanyCommandName {
  return allowedCommands.has(command);
}

export class CompanyCommandService {
  constructor(
    private readonly storage: KernelStorage,
    private readonly autonomy: CompanyAutonomy,
    private readonly amped = new AmpedGraphService(storage)
  ) {}

  async execute(workspaceId: string, commandInput: unknown, rawInput: unknown): Promise<CompanyCommandResponse> {
    executionContext(workspaceId, "api");
    const command = CommandNameSchema.safeParse(commandInput);
    if (!command.success) return { ok: false, error: { code: "unknown-command", message: "Unknown command." } };
    if (!isCompanyCommand(command.data)) {
      return { ok: false, error: { code: "command-not-allowed", message: "Command is unavailable on the Company Cloud surface." } };
    }
    const parsed = CommandInputSchemas[command.data].safeParse(rawInput);
    if (!parsed.success) {
      return { ok: false, command: command.data, error: { code: "invalid-input", message: "Command input is invalid." } };
    }
    try {
      const data = await this.route(workspaceId, command.data, parsed.data);
      return { ok: true, command: command.data, data };
    } catch (error) {
      if (error instanceof CompanyAutonomyError || error instanceof AmpedGraphError) {
        return { ok: false, command: command.data, error: { code: error.code, message: error.message } };
      }
      if (error instanceof KernelStorageAccessError) {
        return { ok: false, command: command.data, error: { code: "workspace-access-denied", message: "Workspace access denied." } };
      }
      if (error instanceof KernelStorageConflictError) {
        return { ok: false, command: command.data, error: { code: "storage-conflict", message: "The command conflicted with current durable state." } };
      }
      // The response stays opaque; the server log must not. Third silent catch found in one night:
      // an unnamed failure here reads as "Cloud is unavailable" to the customer and as nothing at
      // all to the operator.
      console.error("command-failed", command.data, error instanceof Error ? `${error.name}: ${error.message}` : String(error));
      return { ok: false, command: command.data, error: { code: "command-failed", message: "The command could not be completed." } };
    }
  }

  private route(workspaceId: string, command: CompanyCommandName, input: unknown): Promise<unknown> {
    switch (command) {
      case "company.bootstrap":
        return this.autonomy.bootstrap(workspaceId, input as CompanyBootstrapInput);
      case "company.get":
        return this.companyDetail(workspaceId, (input as { ventureId: string }).ventureId);
      case "company.list":
        return this.autonomy.list(workspaceId);
      case "company.run":
        return this.autonomy.run(workspaceId, input as CompanyRunInput);
      case "company.pause":
        return this.autonomy.pause(workspaceId, input as CompanyControlInput);
      case "company.kill":
        return this.autonomy.kill(workspaceId, input as CompanyControlInput);
      case "company.export":
        return this.autonomy.export(workspaceId, (input as { ventureId: string }).ventureId);
      case "company.delete":
        return this.autonomy.delete(workspaceId, input as CompanyDeleteInput);
      case "amped.start": {
        const value = input as { ventureId: string; requestedAt: string; idempotencyKey: string };
        return this.amped.start({ workspaceId, companyId: value.ventureId, requestedAt: value.requestedAt, idempotencyKey: value.idempotencyKey });
      }
      case "amped.get": {
        const value = input as { ventureId: string; runId: string };
        return this.amped.get(workspaceId, value.ventureId, value.runId);
      }
      case "amped.replay": {
        const value = input as { ventureId: string; sourceRunId: string; requestedAt: string };
        return this.amped.replay(workspaceId, value.ventureId, value.sourceRunId, "replay", value.requestedAt);
      }
      case "amped.shadow": {
        const value = input as {
          ventureId: string;
          sourceRunId: string;
          requestedAt: string;
          candidateVersion: { id: string; version: number; hash: string };
        };
        return this.amped.replay(workspaceId, value.ventureId, value.sourceRunId, "shadow", value.requestedAt, value.candidateVersion);
      }
      case "approval.resolve":
        return this.autonomy.resolveApproval(workspaceId, input as ApprovalResolveInput);
      case "approval.list_pending":
        return this.storage.listPendingApprovals(workspaceId, (input as { ventureId?: string }).ventureId);
      case "usage.summary":
        return this.autonomy.usageSummary(workspaceId, input as UsageSummaryInput);
    }
  }

  private async companyDetail(workspaceId: string, ventureId: string): Promise<Record<string, unknown>> {
    const detail = await this.autonomy.get(workspaceId, ventureId);
    // `company.get` predates the customer usage view and includes the raw CEO cycle records. Those
    // records carry our inference supply chain and internal cost. The browser needs the rest of the
    // company detail, but it reads work counts only through `usage.summary`, so remove the raw ledger
    // at this Cloud boundary instead of trusting a client component not to display it.
    const safeDetail = { ...detail };
    delete safeDetail.cycles;
    const failedJobs = await this.storage.listJobs(workspaceId, ventureId, { statuses: ["failed", "dead-letter"], limit: 50 });
    return { ...safeDetail, failedJobs };
  }
}

export interface CloudCompanyRuntimeOptions {
  storage: PostgresKernelStorage;
  workspaceId: string;
  openAiApiKey: string;
  webSearchCostCents: number;
  ceoModel?: string;
  initiativeModel?: string;
  resendApiKey?: string;
  resendSender?: string;
  resendOwnedRecipient?: string;
  resendOwnedReplyRecipient?: string;
  publicOfferSlugKey?: Uint8Array;
  publicOfferSlugKeyId?: string;
  fetchImpl?: typeof fetch;
}

export interface CloudCompanyRuntime {
  workspaceId: string;
  service: CompanyCommandService;
  autonomy: CompanyAutonomy;
  initiativeWorker: CompanyInitiativeWorker;
  ampedWorker: AmpedGraphWorker;
  goldenWorker?: GoldenCompanyWorker;
  runWorkerOnce(): Promise<Record<string, unknown> | null>;
}

function required(value: string, label: string): string {
  if (!value || value.length > 500) throw new Error(`${label} is required`);
  return value;
}

export function createCloudCompanyRuntime(options: CloudCompanyRuntimeOptions): CloudCompanyRuntime {
  const workspaceId = executionContext(options.workspaceId, "worker").workspaceId;
  const apiKey = required(options.openAiApiKey, "OPENAI_API_KEY");
  const ceoModel = required(options.ceoModel ?? "gpt-5.6-terra", "OPENAI_CEO_MODEL");
  const initiativeModel = required(options.initiativeModel ?? "gpt-5.6-terra", "OPENAI_INITIATIVE_MODEL");
  if (!Number.isSafeInteger(options.webSearchCostCents) || options.webSearchCostCents < 0) {
    throw new Error("OPENAI_WEB_SEARCH_COST_CENTS must be a non-negative integer");
  }
  const tariff = { ...DEFAULT_OPENAI_TARIFF, webSearchCostCents: options.webSearchCostCents };
  const safetyIdentifier = `opspot-${sha256({ scope: "cloud-workspace", workspaceId }).slice(0, 48)}`;
  const adapter = new OpenAIResponsesAdapter(apiKey, {
    model: ceoModel,
    timeoutMs: 90_000,
    maxOutputTokens: tariff.maxOutputTokens,
    safetyIdentifier,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {})
  });
  const ceoExecutor = new OpenAICeoExecutor(adapter, tariff, { model: ceoModel });
  const initiativeExecutor = new OpenAIInitiativeExecutor(adapter, tariff, { model: initiativeModel });
  const autonomy = new CompanyAutonomy({
    storage: options.storage,
    executor: ceoExecutor,
    distributionMode: "cloud",
    initiativeTaskBinding: ({ company, task, evidence }) => ({
      provider: initiativeExecutor.provider,
      reservationCents: initiativeExecutor.estimateExecutionReservation({ company, task, evidence })
    })
  });
  const service = new CompanyCommandService(options.storage, autonomy);
  const initiativeWorker = new CompanyInitiativeWorker(options.storage, initiativeExecutor, `initiative-${safetyIdentifier}`);
  const ampedWorker = new AmpedGraphWorker(
    options.storage,
    new OpenAIAmpedNodeExecutor(adapter, initiativeModel, tariff),
    `amped-${safetyIdentifier}`
  );
  const goldenExecutors: GoldenExecutionExecutor[] = [];
  const resendValues = [options.resendApiKey, options.resendSender, options.resendOwnedRecipient, options.resendOwnedReplyRecipient];
  if (resendValues.some(Boolean) && !resendValues.every(Boolean)) throw new Error("Resend execution requires API key, sender, owned recipient, and owned reply recipient together");
  if (resendValues.every(Boolean)) {
    goldenExecutors.push(new ResendGoldenExecutionExecutor(
          new ResendEmailAdapter(options.resendApiKey!, options.fetchImpl ?? fetch),
          { sender: options.resendSender!, ownedRecipient: options.resendOwnedRecipient!, ownedReplyRecipient: options.resendOwnedReplyRecipient! }
        ));
  }
  if (options.publicOfferSlugKey && options.publicOfferSlugKeyId) {
    goldenExecutors.push(new PublicAssetGoldenExecutionExecutor(options.storage, options.publicOfferSlugKey, options.publicOfferSlugKeyId));
  }
  const goldenWorker = goldenExecutors.length
    ? new GoldenCompanyWorker(options.storage, goldenExecutors, `golden-${safetyIdentifier}`)
    : undefined;
  return {
    workspaceId,
    service,
    autonomy,
    initiativeWorker,
    ampedWorker,
    ...(goldenWorker ? { goldenWorker } : {}),
    async runWorkerOnce() {
      await autonomy.scheduleDue(workspaceId);
      return (await autonomy.runWorkerOnce(workspaceId, `ceo-${safetyIdentifier}`))
        ?? (await initiativeWorker.runOnce(workspaceId))
        ?? (await ampedWorker.runOnce(workspaceId))
        ?? (goldenWorker ? goldenWorker.runOnce(workspaceId) : null);
    }
  };
}
