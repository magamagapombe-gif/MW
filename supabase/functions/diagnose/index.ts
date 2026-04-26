// supabase/functions/diagnose/index.ts
// Tests every link in the payment chain and reports where it fails
// Deploy: supabase functions deploy diagnose --no-verify-jwt

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const results: Array<{step: string; ok: boolean; detail: any}> = [];
  const log = (step: string, ok: boolean, detail: any) => {
    results.push({ step, ok, detail });
    console.log(`${ok ? '✅' : '❌'} ${step}:`, detail);
  };

  try {
    // ── 1. Check secrets exist ──
    const apiKey = Deno.env.get("LIVEPAY_API_KEY");
    const acctNum = Deno.env.get("LIVEPAY_ACCOUNT_NUMBER");
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    log("LIVEPAY_API_KEY present", !!apiKey, apiKey ? `${apiKey.slice(0, 8)}...${apiKey.slice(-4)} (length: ${apiKey.length})` : "MISSING");
    log("LIVEPAY_ACCOUNT_NUMBER present", !!acctNum, acctNum || "MISSING");
    log("SUPABASE_URL present", !!supabaseUrl, supabaseUrl || "MISSING");
    log("SUPABASE_SERVICE_ROLE_KEY present", !!serviceKey, serviceKey ? "set" : "MISSING");

    if (!apiKey || !acctNum) {
      return j({ summary: "Missing critical secrets", results }, 200);
    }

    // ── 2. Auth user from request ──
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      log("Caller authentication", false, "No Authorization header — call this from your app, not raw");
      return j({ summary: "Not authenticated", results }, 200);
    }

    const sb = createClient(supabaseUrl!, serviceKey!);
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authErr } = await sb.auth.getUser(token);

    if (authErr || !user) {
      log("Caller authentication", false, authErr?.message || "no user");
      return j({ summary: "Auth failed", results }, 200);
    }
    log("Caller authentication", true, { id: user.id, email: user.email });

    // ── 3. Profile lookup ──
    const { data: profile, error: profErr } = await sb.from("profiles").select("*").eq("id", user.id).maybeSingle();
    if (profErr) {
      log("Profile lookup", false, profErr.message);
    } else if (!profile) {
      log("Profile lookup", false, "No profile row for this user yet — that's OK if first registration attempt");
    } else {
      log("Profile lookup", true, {
        full_name: profile.full_name,
        phone_number: profile.phone_number,
        network: profile.network,
        is_active: profile.is_active,
        balance: profile.balance,
        vault_plan_id: profile.vault_plan_id,
      });
    }

    // ── 4. Test phone (use profile phone if exists, else from body) ──
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const testPhone = body.phone || profile?.phone_number || "256702377999";
    const testNetwork = body.network || profile?.network || "AIRTEL";

    let normPhone = String(testPhone).replace(/\D/g, "");
    if (normPhone.startsWith("0")) normPhone = "256" + normPhone.slice(1);
    else if (!normPhone.startsWith("256")) normPhone = "256" + normPhone;

    if (normPhone.length !== 12) {
      log("Phone normalization", false, `Got ${normPhone} (length ${normPhone.length}), expected 12 digits`);
    } else {
      log("Phone normalization", true, normPhone);
    }

    // ── 5. CRITICAL: actual LivePay collect-money call ──
    const ref = `MWDIAG${Date.now()}`.slice(0, 30);
    const lpBody = {
      accountNumber: acctNum,
      phoneNumber: normPhone,
      amount: 500,                 // MIN amount, no real money charged unless approved
      currency: "UGX",
      reference: ref,
      description: "MW diagnostic test",
    };

    log("LivePay request body", true, lpBody);

    let lpStatus = 0;
    let lpData: any = null;
    let lpRawText = "";
    try {
      const lpRes = await fetch("https://livepay.me/api/collect-money", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(lpBody),
      });
      lpStatus = lpRes.status;
      lpRawText = await lpRes.text();
      try { lpData = JSON.parse(lpRawText); } catch { lpData = lpRawText; }
    } catch (e) {
      log("LivePay HTTP call", false, `Network error: ${(e as Error).message}`);
      return j({ summary: "LivePay unreachable", results }, 200);
    }

    log("LivePay HTTP status", lpStatus === 200, `${lpStatus}`);
    log("LivePay response body", lpStatus === 200 && (lpData?.success === true || lpData?.success === undefined && lpData?.message), lpData);

    if (lpStatus !== 200) {
      log("DIAGNOSIS", false, `LivePay returned ${lpStatus}. Common causes: invalid API key (401/403), wrong account number (403 'Account number does not match API key owner'), KYC incomplete (401), bad phone format (400), insufficient privileges (403).`);
    } else if (lpData?.success === false) {
      log("DIAGNOSIS", false, `LivePay accepted the request but rejected it: ${lpData.error || lpData.message}`);
    } else {
      log("DIAGNOSIS", true, `LivePay accepted the prompt request. Reference: ${ref}. The prompt should be on phone ${normPhone} now. If it isn't, the issue is on LivePay/MTN/Airtel side, NOT in our code.`);
    }

    return j({ summary: "Diagnostic complete", results, livepay_reference: ref, livepay_status: lpStatus, livepay_response: lpData }, 200);
  } catch (e) {
    log("UNEXPECTED ERROR", false, (e as Error).message);
    return j({ summary: "Crashed", results }, 200);
  }
});

function j(d: unknown, s = 200) {
  return new Response(JSON.stringify(d, null, 2), {
    status: s,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}
