// supabase/functions/deposit/index.ts
// Deposit to wallet — user enters their own amount (min 1,000, max 5,000,000 UGX)
// Deploy: supabase functions deploy deposit --no-verify-jwt

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MIN_DEPOSIT    = 1000;
const MAX_DEPOSIT    = 5000000;
const PENDING_TTL_MS = 3 * 60 * 1000;

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const auth = req.headers.get("Authorization");
    if (!auth) return j({ error: "Unauthorized" }, 401);
    const { data: { user } } = await sb.auth.getUser(auth.replace("Bearer ", ""));
    if (!user) return j({ error: "Unauthorized" }, 401);

    const { amount } = await req.json();
    if (!amount || !Number.isInteger(amount)) return j({ error: "Amount must be a whole number" }, 400);
    if (amount < MIN_DEPOSIT) return j({ error: `Minimum deposit is UGX ${MIN_DEPOSIT.toLocaleString()}` }, 400);
    if (amount > MAX_DEPOSIT) return j({ error: `Maximum deposit is UGX ${MAX_DEPOSIT.toLocaleString()}` }, 400);

    const { data: profile } = await sb.from("profiles").select("phone_number, network").eq("id", user.id).single();
    if (!profile) return j({ error: "Profile not found. Complete signup first." }, 404);
    if (!profile.phone_number) return j({ error: "Phone number not set." }, 400);
    if (!profile.network) return j({ error: "Network not set on profile." }, 400);

    // Pending check w/ auto-expire
    const { data: pending } = await sb.from("transactions").select("reference, created_at")
      .eq("user_id", user.id).eq("type", "deposit").eq("status", "pending")
      .order("created_at", { ascending: false }).limit(1).maybeSingle();

    if (pending) {
      const age = Date.now() - new Date(pending.created_at).getTime();
      if (age < PENDING_TTL_MS) {
        return j({ error: "Pending deposit exists. It will auto-expire in a few minutes." }, 400);
      }
      await sb.from("transactions").update({ status: "failed", description: "Auto-expired pending" }).eq("reference", pending.reference);
    }

    const ref = `MWDEP${user.id.replace(/-/g, "").slice(0, 10)}${Date.now()}`.slice(0, 30);

    await sb.from("transactions").insert({
      user_id: user.id, type: "deposit", amount, status: "pending",
      reference: ref, category: "balance", description: "Wallet deposit",
    });

    // FIX: pass network so MTN prompts are routed correctly
    const lp = await fetch("https://livepay.me/api/collect-money", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${Deno.env.get("LIVEPAY_API_KEY")}` },
      body: JSON.stringify({
        accountNumber: Deno.env.get("LIVEPAY_ACCOUNT_NUMBER"),
        phoneNumber: profile.phone_number,
        amount,
        currency: "UGX",
        reference: ref,
        description: "MW Deposit",
        network: profile.network, // FIX: pass network so MTN prompts are routed correctly
      }),
    });
    const lpData = await lp.json();

    if (!lp.ok || lpData.success === false) {
      await sb.from("transactions").update({
        status: "failed",
        description: lpData.error || "LivePay rejected request",
      }).eq("reference", ref);
      console.error("LivePay error:", lpData);
      return j({ error: lpData.error || lpData.message || "Deposit failed" }, 400);
    }

    if (lpData.internal_reference) {
      await sb.from("transactions").update({ livepay_transaction_id: lpData.internal_reference }).eq("reference", ref);
    }

    return j({
      success: true, reference: ref,
      message: `Approve UGX ${amount.toLocaleString()} on ${profile.phone_number}`,
    });
  } catch (e) {
    console.error(e);
    return j({ error: "Internal server error" }, 500);
  }
});

function j(d: unknown, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
}
