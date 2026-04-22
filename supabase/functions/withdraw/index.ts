// supabase/functions/withdraw/index.ts
// Sends money to the user's registered mobile money number
// Deploy: supabase functions deploy withdraw

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MIN_WITHDRAWAL = 1000; // UGX

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Auth
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Unauthorized" }, 401);

    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) return json({ error: "Unauthorized" }, 401);

    const { amount } = await req.json();

    if (!amount || typeof amount !== "number" || !Number.isInteger(amount)) {
      return json({ error: "Amount must be a whole number" }, 400);
    }
    if (amount < MIN_WITHDRAWAL) {
      return json({ error: `Minimum withdrawal is UGX ${MIN_WITHDRAWAL.toLocaleString()}` }, 400);
    }

    // Fetch profile
    const { data: profile } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", user.id)
      .single();

    if (!profile) return json({ error: "Profile not found" }, 404);
    if (!profile.is_active) return json({ error: "Account not yet activated" }, 403);
    if (profile.balance < amount) return json({ error: "Insufficient balance" }, 400);

    // Check for a pending withdrawal (prevent double-withdraw)
    const { data: pendingWd } = await supabase
      .from("transactions")
      .select("id")
      .eq("user_id", user.id)
      .eq("type", "withdrawal")
      .eq("status", "pending")
      .maybeSingle();

    if (pendingWd) {
      return json({ error: "You have a pending withdrawal. Please wait for it to complete." }, 400);
    }

    const reference = `MWWD${user.id.replace(/-/g, "").slice(0, 10)}${Date.now()}`.slice(0, 30);

    // Optimistically deduct balance
    const { error: deductError } = await supabase
      .from("profiles")
      .update({ balance: profile.balance - amount, updated_at: new Date().toISOString() })
      .eq("id", user.id);

    if (deductError) {
      console.error("Balance deduction error:", deductError);
      return json({ error: "Failed to process withdrawal" }, 500);
    }

    // Record pending withdrawal
    await supabase.from("transactions").insert({
      user_id: user.id,
      type: "withdrawal",
      amount,
      status: "pending",
      reference,
      description: `Withdrawal to ${profile.phone_number}`,
    });

    // ── LivePay Send Money API ────────────────────────────────────────
    const lpRes = await fetch("https://livepay.me/api/send-money", {
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
        description: "MW Withdrawal",
      }),
    });

    const lpData = await lpRes.json();

    if (!lpRes.ok || !lpData.success) {
      // Refund balance
      await supabase
        .from("profiles")
        .update({ balance: profile.balance, updated_at: new Date().toISOString() })
        .eq("id", user.id);
      await supabase
        .from("transactions")
        .update({ status: "failed" })
        .eq("reference", reference);

      console.error("LivePay send-money error:", lpData);
      return json({ error: lpData.error || "Withdrawal failed. Please try again." }, 400);
    }

    // Save LivePay's internal_reference alongside our reference
    if (lpData.internal_reference) {
      await supabase
        .from("transactions")
        .update({ livepay_transaction_id: lpData.internal_reference })
        .eq("reference", reference);
    }

    return json({
      success: true,
      message: `UGX ${amount.toLocaleString()} is being sent to ${profile.phone_number}.`,
      reference,
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
