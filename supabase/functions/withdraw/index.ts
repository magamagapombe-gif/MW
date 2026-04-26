// supabase/functions/withdraw/index.ts
// Withdraw with category, 5% fee, Fri/Sat task rule
// Gates on has_purchased_plan now (vault is the activation)
// Deploy: supabase functions deploy withdraw --no-verify-jwt

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MIN_WITHDRAWAL = 5000;
const ADMIN_FEE_PCT  = 0.05;

const VALID_CATEGORIES = new Set(["balance", "task_earnings", "referral_earnings", "sacco_earnings"]);

function isTaskWithdrawDay(): boolean {
  const kamp = new Date(Date.now() + 3 * 60 * 60 * 1000);
  const day = kamp.getUTCDay();
  return day === 5 || day === 6;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const auth = req.headers.get("Authorization");
    if (!auth) return j({ error: "Unauthorized" }, 401);
    const { data: { user } } = await sb.auth.getUser(auth.replace("Bearer ", ""));
    if (!user) return j({ error: "Unauthorized" }, 401);

    const { amount, category } = await req.json();
    if (!category || !VALID_CATEGORIES.has(category)) return j({ error: "Invalid category" }, 400);
    if (!amount || !Number.isInteger(amount)) return j({ error: "Amount must be a whole number" }, 400);
    if (amount < MIN_WITHDRAWAL) return j({ error: `Minimum withdrawal is UGX ${MIN_WITHDRAWAL.toLocaleString()}` }, 400);
    if (category === "task_earnings" && !isTaskWithdrawDay()) {
      return j({ error: "Task earnings can only be withdrawn on Friday or Saturday." }, 400);
    }

    const { data: profile } = await sb.from("profiles").select("*").eq("id", user.id).single();
    if (!profile) return j({ error: "Profile not found" }, 404);
    if (!profile.has_purchased_plan) return j({ error: "Buy a vault plan first to unlock withdrawals." }, 403);

    const catBalance = Number(profile[category] || 0);
    if (catBalance < amount) return j({ error: `Insufficient ${category.replace("_", " ")}. Available: UGX ${catBalance.toLocaleString()}` }, 400);

    const { data: pending } = await sb.from("transactions").select("id").eq("user_id", user.id).eq("type", "withdrawal").eq("status", "pending").maybeSingle();
    if (pending) return j({ error: "Pending withdrawal exists. Wait for it to complete." }, 400);

    const fee = Math.round(amount * ADMIN_FEE_PCT);
    const net = amount - fee;
    const ref = `MWWD${user.id.replace(/-/g, "").slice(0, 10)}${Date.now()}`.slice(0, 30);

    const upd: Record<string, unknown> = { updated_at: new Date().toISOString() };
    upd[category] = catBalance - amount;

    const { error: dErr } = await sb.from("profiles").update(upd).eq("id", user.id);
    if (dErr) { console.error(dErr); return j({ error: "Failed to process withdrawal" }, 500); }

    await sb.from("transactions").insert({
      user_id: user.id, type: "withdrawal", amount, fee, category,
      status: "pending", reference: ref,
      description: `Withdrawal from ${category.replace("_", " ")} to ${profile.phone_number}`,
    });

    // FIX: pass network so MTN withdrawals are routed correctly
    const lp = await fetch("https://livepay.me/api/send-money", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${Deno.env.get("LIVEPAY_API_KEY")}` },
      body: JSON.stringify({
        accountNumber: Deno.env.get("LIVEPAY_ACCOUNT_NUMBER"),
        phoneNumber: profile.phone_number,
        amount: net,
        currency: "UGX",
        reference: ref,
        description: "MW Withdrawal",
        network: profile.network, // FIX: pass network so MTN withdrawals are routed correctly
      }),
    });
    const lpData = await lp.json();

    if (!lp.ok || !lpData.success) {
      const refund: Record<string, unknown> = { updated_at: new Date().toISOString() };
      refund[category] = catBalance;
      await sb.from("profiles").update(refund).eq("id", user.id);
      await sb.from("transactions").update({ status: "failed" }).eq("reference", ref);
      console.error("LivePay send-money error:", lpData);
      return j({ error: lpData.error || "Withdrawal failed" }, 400);
    }

    if (lpData.internal_reference) {
      await sb.from("transactions").update({ livepay_transaction_id: lpData.internal_reference }).eq("reference", ref);
    }

    return j({
      success: true, reference: ref,
      message: `UGX ${net.toLocaleString()} (after 5% fee) sent to ${profile.phone_number}.`,
      grossAmount: amount, fee, netAmount: net,
    });
  } catch (e) {
    console.error(e);
    return j({ error: "Internal server error" }, 500);
  }
});

function j(d: unknown, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
}
