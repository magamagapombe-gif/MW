// supabase/functions/admin-delete-user/index.ts
// Deletes a user from auth.users (cascades to profiles via FK)
// Deploy: supabase functions deploy admin-delete-user --no-verify-jwt

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
    const auth = req.headers.get("Authorization");
    if (!auth) return j({ error: "Unauthorized" }, 401);
    const { data: { user } } = await sb.auth.getUser(auth.replace("Bearer ", ""));
    if (!user) return j({ error: "Unauthorized" }, 401);

    // Verify caller is admin
    const { data: caller } = await sb.from("profiles").select("is_admin").eq("id", user.id).single();
    if (!caller?.is_admin) return j({ error: "Forbidden: admin only" }, 403);

    const { user_id } = await req.json();
    if (!user_id) return j({ error: "user_id required" }, 400);
    if (user_id === user.id) return j({ error: "Cannot delete yourself" }, 400);

    // Delete from auth.users — this cascades to profiles via FK
    const { error } = await sb.auth.admin.deleteUser(user_id);
    if (error) return j({ error: error.message }, 500);

    return j({ success: true });
  } catch (e) {
    console.error(e);
    return j({ error: "Internal server error" }, 500);
  }
});

function j(d: unknown, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
}
