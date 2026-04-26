// supabase/functions/purchase-vault/index.ts
// Buys a vault plan. Splits 15k activation: 4k → referrer, 11k → admin.
// Rest goes into vault. Unlocks tasks + welcome bonus + activation.
// Deploy: supabase functions deploy purchase-vault --no-verify-jwt

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const REFERRER_BONUS = 4000;
const ADMIN_FEE      = 11000;
const ACTIVATION_TOTAL = REFERRER_BONUS + ADMIN_FEE; // 15,000

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const sb = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const auth = req.headers.get("Authorization");
    if (!auth) return j({ error: "Unauthorized" }, 401);
    const token = auth.replace("Bearer ", "");
    const { data: { user } } = await sb.auth.getUser(token);
    if (!user) return j({ error: "Unauthorized" }, 401);

    const { plan_id } = await req.json();
    if (!plan_id) return j({ error: "plan_id required" }, 400);
    if (plan_id === "early_bird") return j({ error: "Early Bird is no longer available" }, 400);

    const { data: plan } = await sb.from("vault_plans").select("*").eq("id", plan_id).eq("is_active", true).maybeSingle();
    if (!plan) return j({ error: "Plan not found or inactive" }, 404);

    const { data: profile } = await sb.from("profiles").select("*").eq("id", user.id).single();
    if (!profile) return j({ error: "Profile not found. Complete signup first." }, 404);

    // Prevent downgrade
    if (profile.has_purchased_plan && profile.vault_plan_id) {
      const { data: currentPlan } = await sb.from("vault_plans").select("sort_order").eq("id", profile.vault_plan_id).maybeSingle();
      if (currentPlan && plan.sort_order <= currentPlan.sort_order) {
        return j({ error: `You're on ${profile.vault_plan_id}. Only upgrades allowed.` }, 400);
      }
    }

    const price = Number(plan.price);
    if (Number(profile.balance) < price) {
      const need = price - Number(profile.balance);
      return j({ error: `Insufficient wallet balance. Top up UGX ${need.toLocaleString()} more.` }, 400);
    }

    const ref = `MWVP${user.id.replace(/-/g, "").slice(0, 10)}${Date.now()}`.slice(0, 30);
    const planFunds = price - ACTIVATION_TOTAL; // remaining after activation deductions

    // Atomic deduction with optimistic lock
    const { error: updErr, data: updData } = await sb
      .from("profiles")
      .update({
        balance:              Number(profile.balance) - price,
        vault_plan_id:        plan.id,
        vault_activated_at:   new Date().toISOString(),
        is_active:            true,
        has_purchased_plan:   true,
        updated_at:           new Date().toISOString(),
      })
      .eq("id", user.id)
      .eq("balance", Number(profile.balance))
      .select("id");

    if (updErr || !updData?.length) {
      console.error("Vault purchase update failed:", updErr);
      return j({ error: "Purchase failed. Try again." }, 500);
    }

    // Transaction record showing the breakdown in description
    await sb.from("transactions").insert({
      user_id: user.id,
      type: "vault_purchase",
      amount: price,
      category: "balance",
      status: "completed",
      reference: ref,
      fee: ACTIVATION_TOTAL,
      description: `${plan.display_name} | Activation: UGX ${ACTIVATION_TOTAL.toLocaleString()} (4k referrer + 11k admin) | Plan funds: UGX ${planFunds.toLocaleString()}`,
    });

    // Pay referrer 4k → their referral_earnings
    if (profile.referred_by) {
      const bonusRef = `MWREFBN${profile.id.replace(/-/g, "").slice(0, 8)}${Date.now()}`.slice(0, 30);
      await sb.rpc("increment_category", {
        p_user_id: profile.referred_by,
        p_category: "referral_earnings",
        p_amount: REFERRER_BONUS,
      });
      await sb.from("transactions").insert({
        user_id: profile.referred_by,
        type: "referral_bonus",
        amount: REFERRER_BONUS,
        category: "referral_earnings",
        status: "completed",
        reference: bonusRef,
        description: `Referral: ${profile.full_name} bought ${plan.display_name}`,
      });

      // Also: if THIS user has a locked welcome bonus, unlock it on first plan purchase
    }

    // Unlock welcome bonus on first plan purchase
    if (profile.welcome_bonus_locked && Number(profile.welcome_bonus_amount) > 0) {
      await sb.rpc("increment_category", {
        p_user_id: user.id,
        p_category: "balance",
        p_amount: Number(profile.welcome_bonus_amount),
      });
      await sb.from("profiles").update({
        welcome_bonus_locked: false,
        updated_at: new Date().toISOString(),
      }).eq("id", user.id);
      // Mark the pending welcome-bonus transaction as completed
      await sb.from("transactions")
        .update({ status: "completed", description: `Welcome bonus credited (UGX ${profile.welcome_bonus_amount}) ✨` })
        .eq("user_id", user.id)
        .eq("status", "pending")
        .like("description", "Welcome bonus%");
    }

    return j({
      success: true,
      reference: ref,
      message: `${plan.emoji || ""} ${plan.display_name} activated!`,
      breakdown: {
        total_paid:      price,
        plan_funds:      planFunds,
        referrer_bonus:  REFERRER_BONUS,
        admin_fee:       ADMIN_FEE,
      },
      plan: {
        id: plan.id,
        display_name: plan.display_name,
        emoji: plan.emoji,
        tasks_per_day: plan.tasks_per_day,
        ugx_per_task:  plan.ugx_per_task,
      },
    });
  } catch (e) {
    console.error(e);
    return j({ error: "Internal server error" }, 500);
  }
});

function j(d: unknown, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
}
