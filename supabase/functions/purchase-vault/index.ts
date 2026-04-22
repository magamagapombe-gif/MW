// supabase/functions/purchase-vault/index.ts
// User buys a vault plan using their deposit balance.
// Deduct price from balance, assign plan_id, log transaction.
// Deploy: supabase functions deploy purchase-vault --no-verify-jwt

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

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

    const { plan_id } = await req.json();

    if (!plan_id || typeof plan_id !== "string") {
      return json({ error: "plan_id required" }, 400);
    }

    if (plan_id === "early_bird") {
      return json({ error: "Early Bird cannot be purchased — it's assigned on registration" }, 400);
    }

    // Load plan catalog entry
    const { data: plan } = await supabase
      .from("vault_plans")
      .select("*")
      .eq("id", plan_id)
      .eq("is_active", true)
      .maybeSingle();

    if (!plan) return json({ error: "Plan not found or inactive" }, 404);

    // Load user profile
    const { data: profile } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", user.id)
      .single();

    if (!profile) return json({ error: "Profile not found" }, 404);
    if (!profile.is_active) return json({ error: "Activate your account first" }, 403);

    // No downgrade / no re-buy of same plan
    if (profile.vault_plan_id && profile.vault_plan_id !== "early_bird") {
      const { data: currentPlan } = await supabase
        .from("vault_plans")
        .select("sort_order")
        .eq("id", profile.vault_plan_id)
        .maybeSingle();
      if (currentPlan && plan.sort_order <= currentPlan.sort_order) {
        return json({
          error: `You're already on ${profile.vault_plan_id}. You can only upgrade to a higher tier.`
        }, 400);
      }
    }

    // Check balance (deposit wallet)
    const price = Number(plan.price);
    if (Number(profile.balance) < price) {
      const needed = price - Number(profile.balance);
      return json({
        error: `Insufficient wallet balance. Need UGX ${needed.toLocaleString()} more. Top up via Deposit.`
      }, 400);
    }

    const reference = `MWVP${user.id.replace(/-/g, "").slice(0, 10)}${Date.now()}`.slice(0, 30);

    // Deduct balance + assign plan (atomic via single UPDATE)
    const { error: updateError } = await supabase
      .from("profiles")
      .update({
        balance:            Number(profile.balance) - price,
        vault_plan_id:      plan.id,
        vault_activated_at: new Date().toISOString(),
        updated_at:         new Date().toISOString(),
      })
      .eq("id", user.id)
      .eq("balance", Number(profile.balance)); // optimistic lock — refuses if balance changed concurrently

    if (updateError) {
      console.error("Vault purchase update error:", updateError);
      return json({ error: "Purchase failed. Please try again." }, 500);
    }

    // Log the purchase transaction
    await supabase.from("transactions").insert({
      user_id:     user.id,
      type:        "vault_purchase",
      amount:      price,
      category:    "balance",
      status:      "completed",
      reference,
      description: `Vault plan: ${plan.display_name}`,
    });

    // Pay the 10% referral bonus to the referrer (if any) — goes to their referral_earnings
    if (profile.referred_by) {
      const referralBonus = Math.round(price * 0.10);
      const bonusRef = `MWVRB${user.id.replace(/-/g, "").slice(0, 10)}${Date.now()}`.slice(0, 30);

      await supabase.rpc("increment_category", {
        p_user_id:  profile.referred_by,
        p_category: "referral_earnings",
        p_amount:   referralBonus,
      });

      await supabase.from("transactions").insert({
        user_id:     profile.referred_by,
        type:        "referral_bonus",
        amount:      referralBonus,
        category:    "referral_earnings",
        status:      "completed",
        reference:   bonusRef,
        description: `10% bonus: ${profile.full_name} bought ${plan.display_name}`,
      });
    }

    return json({
      success: true,
      reference,
      message: `${plan.emoji || ""} ${plan.display_name} activated! You can now do ${plan.tasks_per_day} tasks/day.`,
      plan: {
        id:            plan.id,
        display_name:  plan.display_name,
        emoji:         plan.emoji,
        tasks_per_day: plan.tasks_per_day,
        ugx_per_task:  plan.ugx_per_task,
      },
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
