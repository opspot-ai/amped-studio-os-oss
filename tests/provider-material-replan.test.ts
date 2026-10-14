import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { normalizeResendWebhook, normalizeStripeEvent, reconcileStripeEvent, verifyResendWebhook, type ReconciledResendReceivedEmail, type StripeEvent } from "@amped-studio-os/adapters";
import { CompanyStateSchema, nowIso } from "@amped-studio-os/contracts";
import { GoldenProviderProofService } from "@amped-studio-os/domain";
import { SqliteKernelStorage, type KernelStorage } from "@amped-studio-os/storage";
import { tempRuntime } from "./helpers.js";

const AT = "2026-07-20T20:30:00.000Z";
const access = { key: Buffer.alloc(32, 29), keyId: "material-replan-v1" };

function operatedPayment(workspaceId: string, companyId: string) {
  const raw: StripeEvent = { id: "evt_material_payment", type: "payment_intent.succeeded", created: Date.parse(AT) / 1000, data: { object: { id: "pi_material", object: "payment_intent", status: "succeeded", amount: 5_000, amount_received: 5_000, currency: "usd", metadata: { opspot_workspace_id: workspaceId, opspot_company_id: companyId, opspot_kind: "operated_company_payment" } } } };
  const observed = normalizeStripeEvent(raw)!;
  return reconcileStripeEvent(observed, { ...observed.reconciliation, authoritative: true, retrievedAt: AT, status: "succeeded", amount: 5_000, currency: "usd", livemode: true, binding: { workspaceId, companyId, kind: "operated_company_payment" }, relatedPaymentObjectId: "pi_material" })!;
}

function reply(workspaceId: string, companyId: string) {
  const payload = { type: "email.received", created_at: AT, data: { email_id: "email_reply_material", from: "synthetic-contact-025@example.test", to: ["synthetic-contact-019@example.test"], message_id: "<synthetic-contact-020@example.test>", tags: [{ name: "opspot_workspace", value: workspaceId }, { name: "opspot_company", value: companyId }] } };
  const raw = JSON.stringify(payload);
  const bytes = Buffer.from("material-replan-resend-secret");
  const secret = `whsec_${bytes.toString("base64")}`;
  const timestamp = String(Date.parse(AT) / 1000);
  const signature = createHmac("sha256", bytes).update(`msg_material.${timestamp}.${raw}`).digest("base64");
  return normalizeResendWebhook(verifyResendWebhook(raw, { "svix-id": "msg_material", "svix-timestamp": timestamp, "svix-signature": `v1,${signature}` }, secret, { now: new Date(AT) }));
}

async function setup() {
  const runtime = await tempRuntime();
  const workspaceId = runtime.service.context.workspaceId;
  const boot = await runtime.service.execute("company.bootstrap", { idea: "A digital company that must immediately replan from authoritative provider outcomes", owner: "founder", requestedAt: nowIso(), idempotencyKey: "bootstrap-material-replan" });
  if (!boot.ok) throw new Error(boot.error?.message);
  const companyId = (boot.data as { ventureId: string }).ventureId;
  const run = await runtime.service.execute("company.run", { ventureId: companyId, requestedAt: nowIso(), idempotencyKey: "run-material-replan" });
  if (!run.ok) throw new Error(run.error?.message);
  const storage = new SqliteKernelStorage(runtime.storage);
  return { runtime, storage, workspaceId, companyId };
}

async function defer(storage: KernelStorage, workspaceId: string, companyId: string) {
  const company = (await storage.getCompany(workspaceId, companyId))!;
  const state = CompanyStateSchema.parse(company.state);
  await storage.updateCompanyState(workspaceId, companyId, company.stateVersion, JSON.parse(JSON.stringify(CompanyStateSchema.parse({ ...state, version: company.stateVersion + 1, runState: "running", nextCycleAt: "2099-01-01T00:00:00.000Z", updatedAt: nowIso() }))));
}

describe("provider material evidence replanning", () => {
  it("makes payment, retained usage, and a strongly bound reply immediately due without treating redemption as retention", async () => {
    const context = await setup();
    const service = new GoldenProviderProofService(context.storage);
    try {
      const payment = operatedPayment(context.workspaceId, context.companyId);
      await defer(context.storage, context.workspaceId, context.companyId);
      await service.ingestStripe(payment, { workspaceId: context.workspaceId, companyId: context.companyId });
      expect(CompanyStateSchema.parse((await context.storage.getCompany(context.workspaceId, context.companyId))!.state).nextCycleAt).not.toBe("2099-01-01T00:00:00.000Z");

      await service.grantDigitalAccess(payment as never, { workspaceId: context.workspaceId, companyId: context.companyId }, access);
      await defer(context.storage, context.workspaceId, context.companyId);
      const redemption = await service.redeemDigitalAccess({ workspaceId: context.workspaceId, companyId: context.companyId }, "pi_material", "live", access);
      if (!redemption.delivered) throw new Error("expected first access delivery");
      const afterRedemption = CompanyStateSchema.parse((await context.storage.getCompany(context.workspaceId, context.companyId))!.state);
      expect(afterRedemption.nextCycleAt).toBe("2099-01-01T00:00:00.000Z");
      const evidence = await context.storage.listEvidence(context.workspaceId, context.companyId);
      const fulfillment = evidence.find((item) => item.type === "authoritative-fulfillment-delivered");
      expect(fulfillment).toBeDefined();
      expect(evidence.map((item) => item.type)).not.toContain("authoritative-retention-observed");
      context.runtime.storage.db.prepare("UPDATE ventures SET lifecycle_state='revenue-verified' WHERE id=?").run(context.companyId);
      const transition = await context.runtime.service.execute("venture.request_transition", {
        ventureId: context.companyId,
        expectedState: "revenue-verified",
        targetState: "fulfillment-verified",
        evidenceIds: [fulfillment!.id],
        requestingAgent: "fixture",
        actor: "fixture",
        idempotencyKey: "provider-payment-bound-fulfillment",
        requestedAt: nowIso()
      });
      expect((transition.data as any).outcome).toBe("success");
      expect(context.runtime.storage.getVenture(context.companyId)?.lifecycle_state).toBe("fulfillment-verified");
      expect(fulfillment?.metadata.paymentObjectId).toBe("pi_material");

      expect(await service.useDigitalAccess({ workspaceId: context.workspaceId, companyId: context.companyId }, redemption.accessSecret, "material-use-first")).toMatchObject({ active: true, retentionObserved: false });
      expect(CompanyStateSchema.parse((await context.storage.getCompany(context.workspaceId, context.companyId))!.state).nextCycleAt).toBe("2099-01-01T00:00:00.000Z");
      expect(await service.useDigitalAccess({ workspaceId: context.workspaceId, companyId: context.companyId }, redemption.accessSecret, "material-use-second")).toMatchObject({ active: true, retentionObserved: true });
      expect(CompanyStateSchema.parse((await context.storage.getCompany(context.workspaceId, context.companyId))!.state).nextCycleAt).not.toBe("2099-01-01T00:00:00.000Z");
      expect((await context.storage.listEvidence(context.workspaceId, context.companyId)).map((item) => item.type)).toEqual(expect.arrayContaining(["authoritative-usage-observed", "authoritative-retention-observed"]));

      const threadRef = "<synthetic-contact-014@example.test>";
      const received: ReconciledResendReceivedEmail = { provider: "resend", verification: "provider-retrieved", emailId: "email_reply_material", sender: "synthetic-contact-025@example.test", recipients: ["synthetic-contact-019@example.test"], inReplyTo: [threadRef], references: [], retrievedAt: AT };
      await context.storage.appendEvent({ workspaceId: context.workspaceId, companyId: context.companyId, id: "audit_outbound_material", eventType: "golden-execution-completed", actor: "golden-company-worker", entityType: "task", entityId: "task_outbound", payload: { provider: "resend", providerObjectId: "email_outbound_material", threadRef }, occurredAt: AT });
      await defer(context.storage, context.workspaceId, context.companyId);
      await service.ingestEmail(reply(context.workspaceId, context.companyId), { workspaceId: context.workspaceId, companyId: context.companyId }, undefined, received);
      expect(CompanyStateSchema.parse((await context.storage.getCompany(context.workspaceId, context.companyId))!.state).nextCycleAt).not.toBe("2099-01-01T00:00:00.000Z");
    } finally {
      await context.runtime.cleanup();
    }
  });

  it("does not wake paused state and loses an optimistic race without overwriting the newer state", async () => {
    const context = await setup();
    try {
      await defer(context.storage, context.workspaceId, context.companyId);
      const base = context.storage;
      let raced = false;
      const racing = new Proxy(base, {
        get(target, property) {
          if (property === "updateCompanyState") return async (workspaceId: string, companyId: string, expectedVersion: number, state: Record<string, unknown>) => {
            if (!raced) {
              raced = true;
              const current = (await target.getCompany(workspaceId, companyId))!;
              const parsed = CompanyStateSchema.parse(current.state);
              const paused = CompanyStateSchema.parse({ ...parsed, version: current.stateVersion + 1, runState: "paused", nextCycleAt: undefined, updatedAt: nowIso() });
              await target.updateCompanyState(workspaceId, companyId, current.stateVersion, JSON.parse(JSON.stringify(paused)));
            }
            return target.updateCompanyState(workspaceId, companyId, expectedVersion, state);
          };
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        }
      }) as KernelStorage;
      await expect(new GoldenProviderProofService(racing).ingestStripe(operatedPayment(context.workspaceId, context.companyId), { workspaceId: context.workspaceId, companyId: context.companyId })).resolves.toBeDefined();
      expect(CompanyStateSchema.parse((await base.getCompany(context.workspaceId, context.companyId))!.state).runState).toBe("paused");

      const paused = (await base.getCompany(context.workspaceId, context.companyId))!;
      const beforeVersion = paused.stateVersion;
      const second = operatedPayment(context.workspaceId, context.companyId);
      await new GoldenProviderProofService(base).ingestStripe({ ...second, providerEventId: "evt_material_payment_paused", dedupeKey: "stripe:event:evt_material_payment_paused" }, { workspaceId: context.workspaceId, companyId: context.companyId });
      const after = (await base.getCompany(context.workspaceId, context.companyId))!;
      expect(CompanyStateSchema.parse(after.state).runState).toBe("paused");
      expect(after.stateVersion).toBe(beforeVersion);
    } finally {
      await context.runtime.cleanup();
    }
  });
});
