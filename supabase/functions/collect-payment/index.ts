// supabase/functions/collect-payment/index.ts
// Initiates a 20,000 UGX registration payment via LivePay
// Deploy: supabase functions deploy collect-payment --no-verify-jwt

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// How long before a pending transaction is considered stale and re-sent
const PENDING_TTL_MS = 30 * 1000; // 30 seconds — matches the USSD prompt lifetime

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

    const { data: existingProfile } = await supabase
      .from("profiles")
      .select("is_active")
      .eq("id", user.id)
      .maybeSingle();

    if (existingProfile?.is_active) {
      return json({ error: "Account already registered" }, 400);
    }

    // Check for pending — auto-expire if older than 30 seconds
    const { data: pendingTx } = await supabase
      .from("transactions")
      .select("id, reference, created_at")
      .eq("user_id", user.id)
      .eq("type", "registration")
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (pendingTx) {
      const ageMs = Date.now() - new Date(pendingTx.created_at).getTime();
      if (ageMs < PENDING_TTL_MS) {
        // Still fresh — return existing so frontend can subscribe to it
        return json({
          success: true,
          reference: pendingTx.reference,
          txn_id: pendingTx.id,       // ← needed for Realtime subscription
          alreadyPending: true,
        });
      }
      // Stale — expire and send a fresh prompt
      await supabase
        .from("transactions")
        .update({ status: "failed", description: "Auto-expired: USSD prompt timed out" })
        .eq("reference", pendingTx.reference);
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

    // Normalize phone
    let phone = String(phoneNumber).replace(/\D/g, "");
    if (phone.startsWith("0")) phone = "256" + phone.slice(1);
    else if (!phone.startsWith("256")) phone = "256" + phone;

    if (phone.length !== 12) {
      return json({ error: "Invalid phone number" }, 400);
    }

    const ref = `MWREG${user.id.replace(/-/g, "").slice(0, 10)}${Date.now()}`.slice(0, 30);

    // Upsert profile
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

    // Call LivePay
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
    console.log("LivePay response:", JSON.stringify(lpData));

    if (!lpRes.ok || lpData.success === false) {
      console.error("LivePay error:", lpData);
      return json(
        { error: lpData.error || lpData.message || "Payment initiation failed" },
        400
      );
    }

    // Record pending transaction
    const { data: newTx, error: txError } = await supabase
      .from("transactions")
      .insert({
        user_id: user.id,
        type: "registration",
        amount: 20000,
        status: "pending",
        reference: ref,
        livepay_transaction_id: lpData.internal_reference ?? null,
        description: "MW Registration Fee",
      })
      .select("id")
      .single();

    if (txError) {
      console.error("Transaction insert error:", txError);
      return json({ error: "Failed to record transaction" }, 500);
    }

    return json({
      success: true,
      reference: ref,
      txn_id: newTx.id,   // ← frontend uses this to subscribe via Supabase Realtime
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