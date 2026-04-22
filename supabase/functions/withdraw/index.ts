// supabase/functions/withdraw/index.ts
// Withdraw from a specific earnings category. Applies 5% admin fee.
// Task earnings only withdrawable Fri/Sat. Minimum 5,000 UGX.
// Deploy: supabase functions deploy withdraw --no-verify-jwt

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MIN_WITHDRAWAL = 5000;
const ADMIN_FEE_PCT  = 0.05;

const VALID_CATEGORIES = new Set([
  "balance",
  "task_earnings",
  "referral_earnings",
  "sacco_earnings",
]);

function isTaskWithdrawDay(): boolean {
  const nowEAT = new Date(Date.now() + 3 * 60 * 60 * 1000);
  const day = nowEAT.getUTCDay();
  return day === 5 || day === 6;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

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

    const { amount, category } = await req.json();

    if (!category || !VALID_CATEGORIES.has(category)) {
      return json({ error: "Invalid category" }, 400);
    }
    if (!amount || typeof amount !== "number" || !Number.isInteger(amount)) {
      return json({ error: "Amount must be a whole number" }, 400);
    }
    if (amount < MIN_WITHDRAWAL) {
      return json({ error: `Minimum withdrawal is UGX ${MIN_WITHDRAWAL.toLocaleString()}` }, 400);
    }

    if (category === "task_earnings" && !isTaskWithdrawDay()) {
      return json({ error: "Task earnings can only be withdrawn on Friday or Saturday." }, 400);
    }

    const { data: profile } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", user.id)
      .single();

    if (!profile) return json({ error: "Profile not found" }, 404);
    if (!profile.is_active) return json({ error: "Account not yet activated" }, 403);

    const categoryBalance = profile[category] as number;
    if (categoryBalance < amount) {
      return json({ error: `Insufficient ${category.replace("_", " ")}. Available: UGX ${categoryBalance.toLocaleString()}` }, 400);
    }

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

    const fee = Math.round(amount * ADMIN_FEE_PCT);
    const netAmount = amount - fee;

    const reference = `MWWD${user.id.replace(/-/g, "").slice(0, 10)}${Date.now()}`.slice(0, 30);

    const colUpdate: Record<string, unknown> = { updated_at: new Date().toISOString() };
    colUpdate[category] = categoryBalance - amount;

    const { error: deductError } = await supabase
      .from("profiles")
      .update(colUpdate)
      .eq("id", user.id);

    if (deductError) {
      console.error("Balance deduction error:", deductError);
      return json({ error: "Failed to process withdrawal" }, 500);
    }

    await supabase.from("transactions").insert({
      user_id: user.id,
      type: "withdrawal",
      amount,
      fee,
      category,
      status: "pending",
      reference,
      description: `Withdrawal from ${category.replace("_", " ")} to ${profile.phone_number}`,
    });

    const lpRes = await fetch("https://livepay.me/api/send-money", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${Deno.env.get("LIVEPAY_API_KEY")}`,
      },
      body: JSON.stringify({
        accountNumber: Deno.env.get("LIVEPAY_ACCOUNT_NUMBER"),
        phoneNumber: profile.phone_number,
        amount: netAmount,
        currency: "UGX",
        reference,
        description: "MW Withdrawal",
      }),
    });

    const lpData = await lpRes.json();

    if (!lpRes.ok || !lpData.success) {
      const refundUpdate: Record<string, unknown> = { updated_at: new Date().toISOString() };
      refundUpdate[category] = categoryBalance;
      await supabase.from("profiles").update(refundUpdate).eq("id", user.id);
      await supabase.from("transactions").update({ status: "failed" }).eq("reference", reference);

      console.error("LivePay send-money error:", lpData);
      return json({ error: lpData.error || "Withdrawal failed. Please try again." }, 400);
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
      message: `UGX ${netAmount.toLocaleString()} (after ${ADMIN_FEE_PCT * 100}% fee) is being sent to ${profile.phone_number}.`,
      grossAmount: amount,
      fee,
      netAmount,
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
