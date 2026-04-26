// supabase/functions/livepay-webhook/index.ts
// Handles LivePay callbacks for: registration, deposit, withdrawal
// Deploy: supabase functions deploy livepay-webhook --no-verify-jwt

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const WEBHOOK_URL    = Deno.env.get("LIVEPAY_WEBHOOK_URL") ?? "";
const WEBHOOK_SECRET = Deno.env.get("LIVEPAY_WEBHOOK_SECRET") ?? "";

const REFERRAL_BONUS = 4000;

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

  console.log("LivePay webhook payload:", JSON.stringify(payload));

  // ── Signature verification ────────────────────────────────────────────
  if (WEBHOOK_SECRET && WEBHOOK_URL) {
    const sigHeader = req.headers.get("x-webhook-signature") ?? "";
    const parts = sigHeader.split(",");
    const timestamp = parts[0]?.split("=")[1] ?? "";
    const receivedSig = parts[1]?.split("=")[1] ?? "";

    if (!timestamp || !receivedSig) {
      return new Response(JSON.stringify({ error: "Invalid signature format" }), { status: 400 });
    }

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
      console.warn("Signature mismatch — expected:", expectedSig, "got:", receivedSig);
      return new Response(JSON.stringify({ error: "Invalid signature" }), { status: 401 });
    }
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  // ── BUG FIX: normalize status to lowercase for comparison ────────────
  // LivePay may send "Success", "SUCCESS", "SUCCESSFUL", "success", etc.
  const rawStatus   = String(payload.status ?? "");
  const statusLower = rawStatus.toLowerCase();
  const isSuccess   = ["success", "successful", "completed", "paid"].includes(statusLower);
  const isFailed    = ["failed", "failure", "cancelled", "canceled", "rejected", "expired"].includes(statusLower);

  console.log("Status received:", rawStatus, "→ isSuccess:", isSuccess, "isFailed:", isFailed);

  const customerRef = String(payload.customer_reference ?? "");
  const internalRef = String(payload.internal_reference ?? "");

  if (!customerRef) {
    console.warn("No customer_reference in payload");
    return ok();
  }

  const { data: transaction, error: txFetchErr } = await supabase
    .from("transactions")
    .select("id, user_id, type, amount, status, category")
    .eq("reference", customerRef)
    .maybeSingle();

  if (txFetchErr) {
    console.error("DB error fetching transaction:", txFetchErr.message);
    return ok();
  }

  if (!transaction) {
    console.warn("Unknown reference:", customerRef);
    return ok();
  }

  // Idempotency — already processed
  if (transaction.status !== "pending") {
    console.log("Transaction already processed:", transaction.status);
    return ok();
  }

  // ── SUCCESS ───────────────────────────────────────────────────────────
  if (isSuccess) {
    await supabase
      .from("transactions")
      .update({ status: "completed", livepay_transaction_id: internalRef })
      .eq("id", transaction.id);

    if (transaction.type === "registration") {
      const earlyBirdExpires = new Date();
      earlyBirdExpires.setDate(earlyBirdExpires.getDate() + 30);

      await supabase
        .from("profiles")
        .update({
          is_active: true,
          vault_plan_id: "early_bird",
          vault_activated_at: new Date().toISOString(),
          early_bird_expires_at: earlyBirdExpires.toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", transaction.user_id);

      // Credit referrer
      const { data: profile } = await supabase
        .from("profiles")
        .select("referred_by")
        .eq("id", transaction.user_id)
        .single();

      if (profile?.referred_by) {
        const bonusRef = `MWBON${transaction.user_id.replace(/-/g, "").slice(0, 10)}${Date.now()}`.slice(0, 30);

        // Try RPC first, fall back to direct update
        const { error: rpcErr } = await supabase.rpc("increment_category", {
          p_user_id:  profile.referred_by,
          p_category: "referral_earnings",
          p_amount:   REFERRAL_BONUS,
        });

        if (rpcErr) {
          console.warn("increment_category RPC failed, using direct update:", rpcErr.message);
          await incrementDirect(supabase, profile.referred_by, "referral_earnings", REFERRAL_BONUS);
        }

        await supabase.from("transactions").insert({
          user_id: profile.referred_by,
          type: "referral_bonus",
          amount: REFERRAL_BONUS,
          category: "referral_earnings",
          status: "completed",
          reference: bonusRef,
          description: "Referral bonus",
        });
      }

    } else if (transaction.type === "deposit") {
      // Try RPC first, fall back to direct update
      const { error: rpcErr } = await supabase.rpc("increment_category", {
        p_user_id:  transaction.user_id,
        p_category: "balance",
        p_amount:   transaction.amount,
      });

      if (rpcErr) {
        console.warn("increment_category RPC failed, using direct update:", rpcErr.message);
        await incrementDirect(supabase, transaction.user_id, "balance", transaction.amount);
      }
    }

    console.log("Successfully processed:", transaction.type, "ref:", customerRef);
  }

  // ── FAILED ────────────────────────────────────────────────────────────
  if (isFailed) {
    const reason = String(payload.message ?? "Payment failed");
    await supabase
      .from("transactions")
      .update({ status: "failed", livepay_transaction_id: internalRef, description: reason })
      .eq("id", transaction.id);

    // Refund balance if withdrawal failed
    if (transaction.type === "withdrawal" && transaction.category) {
      const { error: rpcErr } = await supabase.rpc("increment_category", {
        p_user_id:  transaction.user_id,
        p_category: transaction.category,
        p_amount:   transaction.amount,
      });

      if (rpcErr) {
        await incrementDirect(supabase, transaction.user_id, transaction.category, transaction.amount);
      }
    }

    console.log("Marked failed:", customerRef, reason);
  }

  if (!isSuccess && !isFailed) {
    console.warn("Unrecognized status:", rawStatus, "— no action taken");
  }

  return ok();
});

// ── Direct balance increment (fallback when RPC missing) ─────────────
async function incrementDirect(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  field: string,
  amount: number
) {
  const { data: prof, error } = await supabase
    .from("profiles")
    .select(field)
    .eq("id", userId)
    .single();

  if (error || !prof) {
    console.error("incrementDirect: could not fetch profile:", error?.message);
    return;
  }

  const current = (prof as Record<string, number>)[field] ?? 0;
  const { error: updateErr } = await supabase
    .from("profiles")
    .update({ [field]: current + amount, updated_at: new Date().toISOString() })
    .eq("id", userId);

  if (updateErr) {
    console.error("incrementDirect: update failed:", updateErr.message);
  } else {
    console.log(`incrementDirect: ${field} +${amount} for user ${userId} (${current} → ${current + amount})`);
  }
}

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
    JSON.stringify({ status: "received" }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}