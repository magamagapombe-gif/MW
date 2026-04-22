// supabase/functions/livepay-webhook/index.ts
// Receives LivePay payment status webhooks
// Deploy: supabase functions deploy livepay-webhook --no-verify-jwt
//
// Set this URL in your LivePay dashboard as the webhook URL:
// https://<project-ref>.supabase.co/functions/v1/livepay-webhook

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// The exact URL registered in the LivePay dashboard — used in signature check
const WEBHOOK_URL = Deno.env.get("LIVEPAY_WEBHOOK_URL") ?? "";
const WEBHOOK_SECRET = Deno.env.get("LIVEPAY_WEBHOOK_SECRET") ?? "";

serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const rawBody = await req.text();
  let payload: Record<string, unknown>;

  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400 });
  }

  // ── Signature Verification ───────────────────────────────────────────
  // LivePay sends:   X-Webhook-Signature: t=TIMESTAMP,v=HEX_SHA256
  // Signed string:   webhook_url + timestamp + status + customer_reference + internal_reference
  if (WEBHOOK_SECRET && WEBHOOK_URL) {
    const sigHeader = req.headers.get("x-webhook-signature") ?? "";
    const parts = sigHeader.split(",");
    const timestamp = parts[0]?.split("=")[1] ?? "";
    const receivedSig = parts[1]?.split("=")[1] ?? "";

    if (!timestamp || !receivedSig) {
      return new Response(JSON.stringify({ error: "Invalid signature format" }), { status: 400 });
    }

    // Reject if timestamp is older than 5 minutes (replay protection)
    if (Math.abs(Date.now() / 1000 - parseInt(timestamp, 10)) > 300) {
      return new Response(JSON.stringify({ error: "Expired timestamp" }), { status: 400 });
    }

    const stringToSign =
      WEBHOOK_URL +
      timestamp +
      String(payload.status ?? "") +
      String(payload.customer_reference ?? "") +
      String(payload.internal_reference ?? "");

    const expectedSig = await hmacSha256Hex(WEBHOOK_SECRET, stringToSign);

    if (expectedSig !== receivedSig) {
      console.warn("Signature mismatch");
      return new Response(JSON.stringify({ error: "Invalid signature" }), { status: 401 });
    }
  }
  // ─────────────────────────────────────────────────────────────────────

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const status = String(payload.status ?? "");
  const customerRef = String(payload.customer_reference ?? "");
  const internalRef = String(payload.internal_reference ?? "");

  if (!customerRef) {
    return ok(); // return 200 so LivePay doesn't retry bad payloads
  }

  // Find the transaction by our reference
  const { data: transaction } = await supabase
    .from("transactions")
    .select("id, user_id, type, amount, status")
    .eq("reference", customerRef)
    .maybeSingle();

  if (!transaction) {
    console.warn("Unknown reference:", customerRef);
    return ok();
  }

  // Idempotency: skip already-processed transactions
  if (transaction.status !== "pending") {
    return ok();
  }

  // ── Handle SUCCESS ────────────────────────────────────────────────────
  if (status === "Success") {
    await supabase
      .from("transactions")
      .update({ status: "completed", livepay_transaction_id: internalRef })
      .eq("id", transaction.id);

    if (transaction.type === "registration") {
      // Activate the user
      await supabase
        .from("profiles")
        .update({ is_active: true, updated_at: new Date().toISOString() })
        .eq("id", transaction.user_id);

      // Credit referrer if applicable
      const { data: profile } = await supabase
        .from("profiles")
        .select("referred_by")
        .eq("id", transaction.user_id)
        .single();

      if (profile?.referred_by) {
        const BONUS = 4000;
        const bonusRef = `MWBON${transaction.user_id.replace(/-/g, "").slice(0, 10)}${Date.now()}`.slice(0, 30);

        await supabase.rpc("increment_balance", {
          p_user_id: profile.referred_by,
          p_amount: BONUS,
        });

        await supabase.from("transactions").insert({
          user_id: profile.referred_by,
          type: "referral_bonus",
          amount: BONUS,
          status: "completed",
          reference: bonusRef,
          description: "Referral bonus",
        });
      }
    }
    // Withdrawals already deducted at initiation — nothing more to do
  }

  // ── Handle FAILED ─────────────────────────────────────────────────────
  if (status === "Failed") {
    await supabase
      .from("transactions")
      .update({ status: "failed", livepay_transaction_id: internalRef })
      .eq("id", transaction.id);

    // Refund balance if a withdrawal failed
    if (transaction.type === "withdrawal") {
      await supabase.rpc("increment_balance", {
        p_user_id: transaction.user_id,
        p_amount: transaction.amount,
      });
    }
  }

  return ok();
});

// ── Helpers ────────────────────────────────────────────────────────────

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function ok() {
  return new Response(
    JSON.stringify({ status: "received", message: "Webhook processed successfully" }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}
