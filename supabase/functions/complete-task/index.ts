// supabase/functions/complete-task/index.ts
// Tasks gated on has_purchased_plan now.
// Deploy: supabase functions deploy complete-task --no-verify-jwt

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const auth = (req.headers.get("Authorization") || "").replace("Bearer ", "");
    const { data: { user } } = await sb.auth.getUser(auth);
    if (!user) return j({ error: "Unauthorized" }, 401);

    const { task_id } = await req.json();
    if (!task_id) return j({ error: "task_id required" }, 400);

    const { data: profile } = await sb.from("profiles").select("*").eq("id", user.id).single();
    if (!profile) return j({ error: "Profile not found" }, 404);
    if (!profile.has_purchased_plan) return j({ error: "Buy a vault plan to start tasks." }, 403);

    const planId = profile.vault_plan_id;
    const { data: plan } = await sb.from("vault_plans").select("*").eq("id", planId).single();
    if (!plan) return j({ error: "Plan not found" }, 404);

    const { data: task } = await sb.from("tasks").select("*").eq("id", task_id).eq("is_active", true).maybeSingle();
    if (!task) return j({ error: "Task not found" }, 404);

    if (plan.sort_order < task.min_plan_order) {
      return j({ error: "This task requires a higher vault plan." }, 403);
    }

    const startToday = startOfTodayKampala();

    const countResp = await sb.from("task_completions").select("id", { count: "exact", head: true })
      .eq("user_id", user.id).gte("completed_at", startToday);
    const doneToday = countResp.count ?? 0;
    if (doneToday >= plan.tasks_per_day) {
      return j({ error: `Daily limit reached (${plan.tasks_per_day} tasks). Try tomorrow.` }, 400);
    }

    const { data: already } = await sb.from("task_completions").select("id")
      .eq("user_id", user.id).eq("task_id", task_id)
      .gte("completed_at", startToday).maybeSingle();
    if (already) return j({ error: "Already completed today." }, 400);

    // Reward = plan.ugx_per_task (consistent with the plan's promised amount)
    const reward = Number(plan.ugx_per_task);

    await sb.from("task_completions").insert({ user_id: user.id, task_id, reward });
    await sb.rpc("increment_category", { p_user_id: user.id, p_category: "task_earnings", p_amount: reward });

    const ref = `MWTSK${user.id.replace(/-/g, "").slice(0, 10)}${Date.now()}`.slice(0, 30);
    await sb.from("transactions").insert({
      user_id: user.id, type: "task_reward", amount: reward,
      category: "task_earnings", status: "completed",
      reference: ref, description: `Task: ${task.title}`,
    });

    return j({ success: true, reward, remaining: plan.tasks_per_day - (doneToday + 1) });
  } catch (e) {
    console.error(e);
    return j({ error: "Internal server error" }, 500);
  }
});

function startOfTodayKampala(): string {
  const kamp = new Date(Date.now() + 3 * 3600 * 1000);
  kamp.setUTCHours(0, 0, 0, 0);
  return new Date(kamp.getTime() - 3 * 3600 * 1000).toISOString();
}

function j(d: unknown, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
}
