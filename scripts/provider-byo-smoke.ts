import { OpenAIResponsesAdapter, ResendEmailAdapter, StripeAdapter, stripeApiKeyMode } from "@amped-studio-os/adapters";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the explicitly enabled real-provider smoke`);
  return value;
}

const openai = new OpenAIResponsesAdapter(required("OPENAI_API_KEY"), { model: process.env.OPENAI_CEO_MODEL ?? "gpt-5.6-terra", maxOutputTokens: 64 });
const model = await openai.generate("Return an acknowledgement for an owned-provider smoke. Do not use tools.", {
  name: "provider_smoke",
  schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false },
  parse(value) {
    if (!value || typeof value !== "object" || (value as { ok?: unknown }).ok !== true) throw new Error("OpenAI provider smoke returned invalid output");
    return { ok: true };
  }
});

const sender = required("RESEND_ACQUISITION_FROM");
const recipient = required("RESEND_ACQUISITION_TO");
const resend = new ResendEmailAdapter(required("RESEND_API_KEY"));
const sent = await resend.send({ from: sender, to: recipient, subject: "Amped Studio OS BYO provider smoke", text: "Explicitly enabled owned-endpoint provider verification." }, { ownedSenders: [sender], ownedRecipients: [recipient], suppressedRecipients: [], dailyCap: 1, weeklyCap: 1, sentToday: 0, sentThisWeek: 0 }, `opspot-byo-smoke-${Date.now()}`);

const stripeKey = required("STRIPE_SECRET_KEY");
const paymentIntentId = required("BYO_STRIPE_PAYMENT_INTENT_ID");
if (!/^pi_[A-Za-z0-9_-]+$/.test(paymentIntentId)) throw new Error("BYO_STRIPE_PAYMENT_INTENT_ID is invalid");
const payment = await new StripeAdapter(stripeKey).get<Record<string, unknown>>({ target: "payment_intent", objectId: paymentIntentId });
if (payment.id !== paymentIntentId || payment.object !== "payment_intent" || typeof payment.livemode !== "boolean") throw new Error("Stripe provider smoke returned an invalid PaymentIntent");

process.stdout.write(`${JSON.stringify({ ok: true, openai: { responseId: model.responseId, model: model.model }, resend: { emailId: sent.id }, stripe: { paymentIntentId, mode: stripeApiKeyMode(stripeKey), status: payment.status } })}\n`);
