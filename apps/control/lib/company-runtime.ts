import {
  CompanyAutonomy,
  CompanyCommandService,
  UnconfiguredCeoExecutor,
  createCloudCompanyRuntime,
  createDefaultRuntime
} from "@amped-studio-os/domain";
import { SqliteKernelStorage } from "@amped-studio-os/storage";
import { LOCAL_WORKSPACE_ID, localExecutionContext } from "@amped-studio-os/contracts";
import { composioFromEnvironment } from "./composio-route";
import { getCloudKernelStorage } from "./kernel-storage";

export type EngineMode = "local" | "cloud";

export function readEngineMode(environment: NodeJS.ProcessEnv = process.env): EngineMode {
  if (environment.ENGINE_MODE !== "local" && environment.ENGINE_MODE !== "cloud") {
    throw new Error("ENGINE_MODE must be explicitly set to local or cloud");
  }
  return environment.ENGINE_MODE;
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function nonnegativeInteger(environment: NodeJS.ProcessEnv, name: string): number {
  const value = Number(required(environment, name));
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

export function readOptionalResendExecutionConfig(environment: NodeJS.ProcessEnv) {
  const values = [environment.RESEND_API_KEY, environment.RESEND_WEBHOOK_SECRET, environment.RESEND_ACQUISITION_FROM, environment.RESEND_ACQUISITION_TO, environment.RESEND_OWNED_INBOUND_RECIPIENT];
  if (values.some(Boolean) && !values.every(Boolean)) throw new Error("Resend golden execution requires API key, webhook secret, sender, owned recipient, and owned reply recipient together");
  return values.every(Boolean)
    ? { resendApiKey: values[0]!, resendSender: values[2]!, resendOwnedRecipient: values[3]!, resendOwnedReplyRecipient: values[4]! }
    : {};
}

export function readOptionalPublicOfferConfig(environment: NodeJS.ProcessEnv) {
  const values = [environment.PUBLIC_OFFER_SLUG_KEY, environment.PUBLIC_OFFER_SLUG_KEY_ID];
  if (values.some(Boolean) && !values.every(Boolean)) throw new Error("public offer slug key and key id are required together");
  if (!values.every(Boolean)) return {};
  const key = Buffer.from(values[0]!, "base64url");
  if (key.byteLength !== 32) throw new Error("PUBLIC_OFFER_SLUG_KEY must decode to exactly 32 bytes");
  return { publicOfferSlugKey: key, publicOfferSlugKeyId: values[1]! };
}

export async function createConfiguredCloudCompanyRuntime(workspaceId: string, environment: NodeJS.ProcessEnv = process.env) {
  return createCloudCompanyRuntime({
    storage: await getCloudKernelStorage(),
    workspaceId,
    openAiApiKey: required(environment, "OPENAI_API_KEY"),
    webSearchCostCents: nonnegativeInteger(environment, "OPENAI_WEB_SEARCH_COST_CENTS"),
    ...readOptionalResendExecutionConfig(environment),
    ...readOptionalPublicOfferConfig(environment),
    ...(environment.OPENAI_CEO_MODEL ? { ceoModel: environment.OPENAI_CEO_MODEL } : {}),
    ...(environment.OPENAI_INITIATIVE_MODEL ? { initiativeModel: environment.OPENAI_INITIATIVE_MODEL } : {})
  });
}

export async function createCloudCompanyCommandService() {
  const storage = await getCloudKernelStorage();
  const composio = composioFromEnvironment();
  return new CompanyCommandService(storage, new CompanyAutonomy({
    storage,
    executor: new UnconfiguredCeoExecutor(),
    distributionMode: "cloud",
    // Connections die with the company: revoke each venture-scoped Composio account before the
    // rows cascade away. Best-effort by contract — delete never fails on provider unreachability.
    ...(composio ? {
      revokeExternalConnections: async (workspaceId: string, companyId: string) => {
        for (const connection of await storage.listConnections(workspaceId, companyId)) {
          if (connection.status === "revoked") continue;
          try {
            await composio.revokeConnectedAccount(connection.composioAccountId);
          } catch (error) {
            console.error(
              "composio-delete-revoke-failed",
              connection.id,
              error instanceof Error ? error.message : String(error)
            );
          }
        }
      }
    } : {})
  }));
}

export function createLocalCompanyRuntime(root: string) {
  const context = localExecutionContext("api");
  const runtime = createDefaultRuntime({ root, context });
  const storage = new SqliteKernelStorage(runtime.storage);
  const service = new CompanyCommandService(storage, runtime.autonomy);
  return { workspaceId: LOCAL_WORKSPACE_ID, storage, service, runtime, close: () => runtime.storage.close() };
}
