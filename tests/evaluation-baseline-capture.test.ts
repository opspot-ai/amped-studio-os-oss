import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";
import {
  CommandNameSchema,
  EvaluationBaselineCaptureInputSchema,
  sha256,
  type CommandResponse,
  type Receipt
} from "@amped-studio-os/contracts";
import { createDefaultRuntime } from "@amped-studio-os/domain";
import { tempRuntime } from "./helpers.js";

const execFile = promisify(execFileCallback);
const VENTURE_ID = "venture_example_a";

function rawHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function pngBytes(label: string): Uint8Array {
  return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Buffer.from(label)]);
}

async function writeRaster(root: string, name: string): Promise<{ path: string; hash: string }> {
  const artifactPath = path.join(root, "receipts", "manual-baselines", name);
  await mkdir(path.dirname(artifactPath), { recursive: true });
  const bytes = pngBytes(name);
  await writeFile(artifactPath, bytes);
  return { path: artifactPath, hash: rawHash(bytes) };
}

async function persistentRuntime() {
  const root = await mkdtemp(path.join(os.tmpdir(), "cle-baseline-surface-"));
  await cp(path.join(process.cwd(), "ventures"), path.join(root, "ventures"), { recursive: true });
  const databasePath = path.join(root, "data", "engine.db");
  const runtime = createDefaultRuntime({ root, databasePath, dispatcher: "fixture" });
  return {
    ...runtime,
    root,
    databasePath,
    async loadPacks() {
      for (const relative of ["ventures/example-a/pack.yaml", "ventures/example-c/pack.yaml"]) {
        const response = await runtime.service.execute("venture.create_or_update_pack", {
          packPath: path.join(root, relative)
        });
        if (!response.ok) throw new Error(response.error?.message);
      }
    },
    async cleanup() {
      runtime.storage.close();
      await rm(root, { recursive: true, force: true });
    }
  };
}

describe("evaluation baseline capture", () => {
  it("captures a bounded raw-hash-verified raster as immutable manual-local evidence", async () => {
    const runtime = await tempRuntime();
    try {
      await runtime.loadPacks();
      const artifact = await writeRaster(runtime.root, "primary.png");
      const input = {
        ventureId: VENTURE_ID,
        receiptType: "baseline",
        artifactPath: artifact.path,
        contentHash: artifact.hash,
        primaryMetricValue: 0.7,
        capturedBy: "founder",
        requestedAt: new Date().toISOString(),
        idempotencyKey: "baseline-capture-primary-v1"
      };
      const first = await runtime.service.execute("evaluation.baseline.capture", input);
      expect(first.ok, first.error?.message).toBe(true);
      const firstRecord = (first.data as { created: boolean; record: Receipt }).record;
      expect(firstRecord).toMatchObject({
        proofTier: "scaffolded",
        origin: "engine-derived",
        adapter: "engine-baseline-capture",
        contentHash: artifact.hash,
        metadata: {
          receiptType: "baseline",
          artifactHash: artifact.hash,
          primaryMetricValue: 0.7,
          costCents: null,
          founderMinutes: null,
          complexityUnits: null,
          engineStamped: true,
          baselineTrust: "manual-local",
          promotionEligible: false,
          trustModel: "single-operator-local",
          customerSafe: false
        }
      });
      const replay = await runtime.service.execute("evaluation.baseline.capture", input);
      expect(replay.data).toMatchObject({ created: false, record: { id: firstRecord.id } });
      expect(runtime.storage.listReceipts(VENTURE_ID).find((receipt) => receipt.id === firstRecord.id)).toEqual(firstRecord);
      const captureAudits = runtime.storage
        .listAuditEvents(VENTURE_ID)
        .filter((event) => event.event_type === "evaluation-baseline-captured");
      expect(captureAudits).toHaveLength(1);
      expect(captureAudits[0]).toMatchObject({
        entity_type: "receipt",
        entity_id: firstRecord.id,
        payload: { receiptType: "baseline", contentHash: artifact.hash }
      });

      const conflict = await runtime.service.execute("evaluation.baseline.capture", {
        ...input,
        primaryMetricValue: 0.8
      });
      expect(conflict.ok).toBe(false);
      expect(conflict.error?.code).toBe("idempotency-conflict");

      const badHash = await runtime.service.execute("evaluation.baseline.capture", {
        ...input,
        contentHash: createHash("sha256").update("wrong").digest("hex"),
        idempotencyKey: "baseline-capture-bad-hash-v1"
      });
      expect(badHash.ok).toBe(false);
      expect(badHash.error?.code).toBe("baseline-artifact-hash-mismatch");

      const poisonedInput = EvaluationBaselineCaptureInputSchema.parse({
        ...input,
        idempotencyKey: "baseline-capture-poisoned-v1"
      });
      const poisonArtifact = await writeRaster(runtime.root, "poison-key.png");
      const poison = await runtime.service.execute("receipt.attach", {
        id: "receipt_poisoned_baseline_capture_key",
        ventureId: VENTURE_ID,
        proofTier: "scaffolded",
        outcome: "success",
        actor: "caller",
        adapter: "manual-attachment",
        artifactPath: poisonArtifact.path,
        contentHash: poisonArtifact.hash,
        occurredAt: new Date().toISOString(),
        metadata: {
          receiptType: "supporting-artifact",
          baselineCaptureIdempotencyKey: poisonedInput.idempotencyKey,
          baselineCaptureInputHash: sha256(poisonedInput)
        }
      });
      expect(poison.ok, poison.error?.message).toBe(true);
      const poisonedReplay = await runtime.service.execute("evaluation.baseline.capture", poisonedInput);
      expect(poisonedReplay.ok).toBe(false);
      expect(poisonedReplay.error?.code).toBe("idempotency-conflict");
      expect(await readFile(artifact.path)).toEqual(Buffer.from(pngBytes("primary.png")));
    } finally {
      await runtime.cleanup();
    }
  });

  it("fails closed without a ghost receipt when the artifact hash is already bound", async () => {
    const runtime = await tempRuntime();
    try {
      await runtime.loadPacks();
      const artifact = await writeRaster(runtime.root, "prior-attachment.png");
      const priorReceiptId = "receipt_prior_same_content_attachment";
      const attached = await runtime.service.execute("receipt.attach", {
        id: priorReceiptId,
        ventureId: VENTURE_ID,
        proofTier: "scaffolded",
        outcome: "success",
        actor: "caller",
        adapter: "manual-attachment",
        artifactPath: artifact.path,
        contentHash: artifact.hash,
        occurredAt: new Date().toISOString(),
        metadata: { receiptType: "supporting-artifact" }
      });
      expect(attached.data).toEqual({ created: true, id: priorReceiptId });

      const captureInput = {
        ventureId: VENTURE_ID,
        receiptType: "baseline",
        artifactPath: artifact.path,
        contentHash: artifact.hash,
        primaryMetricValue: 0.5,
        capturedBy: "founder",
        requestedAt: new Date().toISOString(),
        idempotencyKey: "baseline-capture-prior-content-v1"
      };
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const collision = await runtime.service.execute("evaluation.baseline.capture", captureInput);
        expect(collision.ok).toBe(false);
        expect(collision.error?.code).toBe("baseline-artifact-content-collision");
      }

      const sameContent = runtime.storage
        .listReceipts(VENTURE_ID)
        .filter((receipt) => receipt.contentHash === artifact.hash);
      expect(sameContent).toHaveLength(1);
      expect(sameContent[0]).toMatchObject({
        id: priorReceiptId,
        origin: "attached-artifact",
        adapter: "manual-attachment",
        metadata: { receiptType: "supporting-artifact" }
      });
      expect(sameContent[0]?.metadata.baselineCaptureIdempotencyKey).toBeUndefined();

      const relevantAudits = runtime.storage
        .listAuditEvents(VENTURE_ID)
        .filter((event) => event.entity_type === "receipt" && event.payload.contentHash === artifact.hash);
      expect(relevantAudits).toHaveLength(1);
      expect(relevantAudits[0]).toMatchObject({
        event_type: "receipt-attached",
        entity_id: priorReceiptId,
        payload: { contentHash: artifact.hash, origin: "attached-artifact" }
      });
      expect(runtime.storage.listAuditEvents(VENTURE_ID).some((event) => event.event_type === "evaluation-baseline-captured")).toBe(false);
    } finally {
      await runtime.cleanup();
    }
  });

  it("exposes and executes the canonical capture command through the real CLI and MCP server", async () => {
    const runtime = await persistentRuntime();
    try {
      await runtime.loadPacks();
      const cliArtifact = await writeRaster(runtime.root, "cli-primary.png");
      const cliInput = {
        ventureId: VENTURE_ID,
        receiptType: "baseline",
        artifactPath: cliArtifact.path,
        contentHash: cliArtifact.hash,
        primaryMetricValue: 0.6,
        capturedBy: "cli-founder",
        requestedAt: new Date().toISOString(),
        idempotencyKey: "baseline-capture-cli-v1"
      };
      const cli = await execFile(
        path.join(process.cwd(), "node_modules/.bin/tsx"),
        ["apps/cli/src/index.ts", "evaluation.baseline.capture", "--input", JSON.stringify(cliInput), "--json"],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            ENGINE_ROOT: runtime.root,
            ENGINE_DB_PATH: runtime.databasePath,
            ENGINE_DISPATCH_ADAPTER: "fixture"
          },
          maxBuffer: 4 * 1024 * 1024
        }
      );
      const cliResponse = JSON.parse(cli.stdout) as CommandResponse<{ record: Receipt }>;
      expect(cliResponse.ok, cliResponse.error?.message).toBe(true);
      expect(cliResponse.data?.record.metadata.baselineTrust).toBe("manual-local");

      const mcpArtifact = await writeRaster(runtime.root, "mcp-plain.png");
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [
          path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"),
          path.join(process.cwd(), "apps", "mcp", "src", "index.ts")
        ],
        env: {
          ...process.env,
          ENGINE_ROOT: runtime.root,
          ENGINE_DB_PATH: runtime.databasePath,
          ENGINE_DISPATCH_ADAPTER: "fixture"
        } as Record<string, string>
      });
      const client = new Client({ name: "baseline-capture-test", version: "0.1.0" });
      await client.connect(transport);
      try {
        const tools = await client.listTools();
        expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["evaluation.baseline.capture"]));
        expect(CommandNameSchema.options).toContain("evaluation.baseline.capture");
        const result = await client.callTool({
          name: "evaluation.baseline.capture",
          arguments: {
            ventureId: VENTURE_ID,
            receiptType: "plain-agent-baseline",
            artifactPath: mcpArtifact.path,
            contentHash: mcpArtifact.hash,
            capturedBy: "mcp-founder",
            requestedAt: new Date().toISOString(),
            idempotencyKey: "baseline-capture-mcp-v1"
          }
        });
        expect(result.isError).toBe(false);
        const response = result.structuredContent as CommandResponse<{ record: Receipt }>;
        expect(response.data?.record).toMatchObject({
          adapter: "engine-baseline-capture",
          metadata: { receiptType: "plain-agent-baseline", promotionEligible: false }
        });
      } finally {
        await client.close();
      }
    } finally {
      await runtime.cleanup();
    }
  });

  it("rejects attached authoritative proof tiers and never surfaces them on the scorecard", async () => {
    const runtime = await tempRuntime();
    try {
      await runtime.loadPacks();
      const artifact = await writeRaster(runtime.root, "untrusted-authority.png");
      const rejectedIds: string[] = [];
      for (const proofTier of ["externally-live", "revenue-verified", "fulfillment-verified"] as const) {
        const id = `receipt_untrusted_${proofTier.replaceAll("-", "_")}`;
        rejectedIds.push(id);
        const response = await runtime.service.execute("receipt.attach", {
          id,
          ventureId: VENTURE_ID,
          proofTier,
          outcome: "success",
          actor: "caller",
          adapter: "manual-attachment",
          artifactPath: artifact.path,
          contentHash: artifact.hash,
          occurredAt: new Date().toISOString(),
          metadata: { receiptType: "supporting-artifact" }
        });
        expect(response.ok).toBe(false);
        expect(response.error?.code).toBe("attached-proof-tier-untrusted");
      }
      expect(runtime.storage.listReceipts(VENTURE_ID).some((receipt) => rejectedIds.includes(receipt.id))).toBe(false);
      const scorecard = await runtime.service.execute("portfolio.scorecard", {});
      const venture = (scorecard.data as { ventures: Array<{ ventureId: string; proofTiers: string[] }> }).ventures.find(
        (item) => item.ventureId === VENTURE_ID
      );
      expect(venture?.proofTiers).not.toEqual(expect.arrayContaining(["externally-live", "revenue-verified", "fulfillment-verified"]));
    } finally {
      await runtime.cleanup();
    }
  });
});
