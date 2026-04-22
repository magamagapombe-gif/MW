// supabase/functions/collect-payment/index.ts
// Initiates a 20,000 UGX registration payment via LivePay
// Deploy: supabase functions deploy collect-payment

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

    // Authenticate the user
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return json({ error: "Unauthorized" }, 401);
    }

    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);

    if (authError || !user) {
      return json({ error: "Unauthorized" }, 401);
    }

    const { fullName, phoneNumber, network, referralCode } = await req.json();

    // Validate inputs
    if (!fullName || !phoneNumber || !network) {
      return json({ error: "Missing required fields" }, 400);
    }
    if (!["MTN", "AIRTEL"].includes(network)) {
      return json({ error: "Network must be MTN or AIRTEL" }, 400);
    }

    // Check if user already has an active account
    const { data: existingProfile } = await supabase
      .from("profiles")
      .select("is_active, referral_code")
      .eq("id", user.id)
      .maybeSingle();

    if (existingProfile?.is_active) {
      return json({ error: "Account already registered" }, 400);
    }

    // Check for an already-pending registration payment
    const { data: pendingTx } = await supabase
      .from("transactions")
      .select("reference")
      .eq("user_id", user.id)
      .eq("type", "registration")
      .eq("status", "pending")
      .maybeSingle();

    if (pendingTx) {
      return json({ success: true, reference: pendingTx.reference, alreadyPending: true });
    }

    // Resolve referrer
    let referrerId: string | null = null;
    if (referralCode && referralCode.trim() !== "") {
      const { data: referrer } = await supabase
        .from("profiles")
        .select("id")
        .eq("referral_code", referralCode.trim().toUpperCase())
        .eq("is_active", true)
        .maybeSingle();
      if (referrer) referrerId = referrer.id;
    }

    // Normalise phone number to 256XXXXXXXXX format
    let phone = phoneNumber.replace(/\D/g, "");
    if (phone.startsWith("0")) {
      phone = "256" + phone.slice(1);
    } else if (!phone.startsWith("256")) {
      phone = "256" + phone;
    }

    // Generate a unique reference (max 30 chars, no spaces)
    const ref = `MWREG${user.id.replace(/-/g, "").slice(0, 10)}${Date.now()}`.slice(0, 30);

    // Upsert profile (trigger auto-generates referral_code on first insert)
    const { error: profileError } = await supabase.from("profiles").upsert(
      {
        id: user.id,
        full_name: fullName,
        email: user.email!,
        phone_number: phone,
        network,
        referred_by: referrerId,
        is_active: false,
      },
      { onConflict: "id" }
    );

    if (profileError) {
      console.error("Profile upsert error:", profileError);
      return json({ error: "Failed to create profile" }, 500);
    }

    // ── LivePay Collect Money API ─────────────────────────────────────
    // Endpoint confirmed working: https://livepay.me/api/collect-money
    // Auth: single Bearer token (no separate public key)
    const lpRes = await fetch("https://livepay.me/api/collect-money", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${Deno.env.get("LIVEPAY_API_KEY")}`,
      },
      body: JSON.stringify({
        accountNumber: Deno.env.get("LIVEPAY_ACCOUNT_NUMBER"),
        phoneNumber: phone,
        amount: 20000,
        currency: "UGX",
        reference: ref,
        description: "MW Registration",
      }),
    });

    const lpData = await lpRes.json();

    if (!lpRes.ok || lpData.success === false) {
      console.error("LivePay error:", lpData);
      return json(
        { error: lpData.error || lpData.message || "Payment initiation failed" },
        400
      );
    }

    // Store pending transaction — use LivePay's internal_reference as tx id
    const { error: txError } = await supabase.from("transactions").insert({
      user_id: user.id,
      type: "registration",
      amount: 20000,
      status: "pending",
      reference: ref,
      livepay_transaction_id: lpData.internal_reference ?? null,
      description: "MW Registration Fee",
    });

    if (txError) {
      console.error("Transaction insert error:", txError);
      return json({ error: "Failed to record transaction" }, 500);
    }

    return json({ success: true, reference: ref });
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
