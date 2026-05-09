// supabase/functions/collect-payment/index.ts
// Free registration: creates/activates the profile and credits any referrer.
// Deploy: supabase functions deploy collect-payment

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const REFERRAL_BONUS = 4000; // UGX credited to referrer on each new registration

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

    const { fullName, phoneNumber, network, referralCode } = await req.json();

    if (!fullName || !phoneNumber || !network) {
      return json({ error: "Missing required fields" }, 400);
    }
    if (!["MTN", "AIRTEL"].includes(network)) {
      return json({ error: "Network must be MTN or AIRTEL" }, 400);
    }

    // Already active — nothing to do
    const { data: existing } = await supabase
      .from("profiles")
      .select("is_active")
      .eq("id", user.id)
      .maybeSingle();

    if (existing?.is_active) {
      return json({ error: "Account already registered" }, 400);
    }

    // Resolve referrer
    let referrerId: string | null = null;
    if (referralCode?.trim()) {
      const { data: referrer } = await supabase
        .from("profiles")
        .select("id")
        .eq("referral_code", referralCode.trim().toUpperCase())
        .eq("is_active", true)
        .maybeSingle();
      if (referrer) referrerId = referrer.id;
    }

    // Normalise phone to 256XXXXXXXXX
    let phone = phoneNumber.replace(/\D/g, "");
    if (phone.startsWith("0")) phone = "256" + phone.slice(1);
    else if (!phone.startsWith("256")) phone = "256" + phone;

    // Upsert profile and activate immediately (registration is free)
    const { error: profileError } = await supabase.from("profiles").upsert(
      {
        id: user.id,
        full_name: fullName,
        email: user.email!,
        phone_number: phone,
        network,
        referred_by: referrerId,
        is_active: true,
        vault_activated_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "id" }
    );

    if (profileError) {
      console.error("Profile upsert error:", profileError);
      return json({ error: "Failed to create profile" }, 500);
    }

    // Record the registration (free)
    const ref = `MWREG${user.id.replace(/-/g, "").slice(0, 10)}${Date.now()}`.slice(0, 30);
    await supabase.from("transactions").insert({
      user_id: user.id,
      type: "registration",
      amount: 0,
      status: "completed",
      reference: ref,
      description: "Free Registration",
    });

    // Credit referrer bonus
    if (referrerId) {
      const bonusRef = `MWBON${user.id.replace(/-/g, "").slice(0, 10)}${Date.now()}`.slice(0, 30);

      await supabase.rpc("increment_category", {
        p_user_id:  referrerId,
        p_category: "referral_earnings",
        p_amount:   REFERRAL_BONUS,
      });

      await supabase.from("transactions").insert({
        user_id: referrerId,
        type: "referral_bonus",
        amount: REFERRAL_BONUS,
        category: "referral_earnings",
        status: "completed",
        reference: bonusRef,
        description: "Referral bonus",
      });
    }

    return json({ success: true });
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
