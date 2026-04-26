// supabase/functions/deposit/index.ts
// User deposits to wallet via LivePay collect-money
// Deploy: supabase functions deploy deposit --no-verify-jwt

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MIN_DEPOSIT    = 1000;
const MAX_DEPOSIT    = 5000000;
const PENDING_TTL_MS = 3 * 60 * 1000;

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Unauthorized" }, 401);
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) return json({ error: "Unauthorized" }, 401);

    const { amount } = await req.json();
    if (!amount || typeof amount !== "number" || !Number.isInteger(amount)) {
      return json({ error: "Amount must be a whole number" }, 400);
    }
    if (amount < MIN_DEPOSIT) return json({ error: `Minimum deposit is UGX ${MIN_DEPOSIT.toLocaleString()}` }, 400);
    if (amount > MAX_DEPOSIT) return json({ error: `Maximum deposit is UGX ${MAX_DEPOSIT.toLocaleString()}` }, 400);

    const { data: profile } = await supabase
      .from("profiles")
      .select("phone_number, network, is_active")
      .eq("id", user.id)
      .single();

    if (!profile) return json({ error: "Profile not found" }, 404);
    if (!profile.is_active) return json({ error: "Complete registration first" }, 403);

    // Pending check w/ auto-expire
    const { data: pending } = await supabase
      .from("transactions")
      .select("reference, created_at")
      .eq("user_id", user.id)
      .eq("type", "deposit")
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (pending) {
      const ageMs = Date.now() - new Date(pending.created_at).getTime();
      if (ageMs < PENDING_TTL_MS) {
        return json({ error: "You have a pending deposit. Wait a moment or it will auto-expire in a few minutes." }, 400);
      }
      await supabase
        .from("transactions")
        .update({ status: "failed", description: "Auto-expired pending" })
        .eq("reference", pending.reference);
    }

    const reference = `MWDEP${user.id.replace(/-/g, "").slice(0, 10)}${Date.now()}`.slice(0, 30);

    await supabase.from("transactions").insert({
      user_id: user.id,
      type: "deposit",
      amount,
      status: "pending",
      reference,
      category: "balance",
      description: "Wallet deposit",
    });

    const lpRes = await fetch("https://livepay.me/api/collect-money", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${Deno.env.get("LIVEPAY_API_KEY")}`,
      },
      body: JSON.stringify({
        accountNumber: Deno.env.get("LIVEPAY_ACCOUNT_NUMBER"),
        phoneNumber: profile.phone_number,
        amount,
        currency: "UGX",
        reference,
        description: "MW Deposit",
      }),
    });

    const lpData = await lpRes.json();

    if (!lpRes.ok || lpData.success === false) {
      await supabase
        .from("transactions")
        .update({ status: "failed", description: lpData.error || "LivePay rejected request" })
        .eq("reference", reference);
      console.error("LivePay collect-money error:", lpData);
      return json({ error: lpData.error || lpData.message || "Deposit failed" }, 400);
    }

    if (lpData.internal_reference) {
      await supabase
        .from("transactions")
        .update({ livepay_transaction_id: lpData.internal_reference })
        .eq("reference", reference);
    }

    return json({
      success: true,
      reference,
      message: `Approve UGX ${amount.toLocaleString()} on ${profile.phone_number}`,
    });
  } catch (err) {
    console.error("Unexpected error:", err);
    return json({ error: "Internal server error" }, 500);
  }
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
