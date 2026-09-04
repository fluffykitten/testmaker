// @ts-nocheck
// Supabase Edge Function: verify-student-pin
// Validates student 4-digit exam PIN against school_roster stored in app_config
// without ever leaking PINs or the full roster to client browsers.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const { action, name, class: studentClass, pin } = body || {};

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    // Use service role key to bypass RLS if configured, otherwise fallback to anon
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_ANON_KEY") || "";
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Fetch school roster from app_config table
    const { data, error } = await supabase
      .from("app_config")
      .select("value")
      .eq("key", "school_roster")
      .maybeSingle();

    if (error) {
      return new Response(
        JSON.stringify({ error: "Failed to read school roster from database: " + error.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    let rawRoster: any[] = [];
    if (data?.value) {
      try {
        rawRoster = typeof data.value === "string" ? JSON.parse(data.value) : data.value;
      } catch {
        rawRoster = [];
      }
    }

    // If roster is not configured or empty in cloud, signal unconfigured so client can fall back to local
    if (!Array.isArray(rawRoster) || rawRoster.length === 0) {
      if (action === "get-roster-directory" || action === "list") {
        return new Response(
          JSON.stringify({ students: [], unconfigured: true }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({
          valid: false,
          unconfigured: true,
          error: "School roster is not yet configured in database.",
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Action: "get-roster-directory" -> returns list of students WITHOUT PINs
    if (action === "get-roster-directory" || action === "list") {
      const sanitized = rawRoster.map((s: any) => ({
        id: s.id,
        name: s.name,
        class: s.class,
        candidateNumber: s.candidateNumber,
      }));
      return new Response(
        JSON.stringify({ students: sanitized }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Action: Verify student PIN
    const cleanName = String(name || "").trim().replace(/\s+/g, " ").toLowerCase();
    const cleanClass = String(studentClass || "").trim().replace(/\s+/g, " ").toLowerCase();
    const cleanPin = String(pin || "").trim();

    if (!cleanName) {
      return new Response(
        JSON.stringify({ valid: false, error: "Candidate name is required." }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!cleanPin || cleanPin.length !== 4) {
      return new Response(
        JSON.stringify({ valid: false, error: "Please enter a valid 4-digit PIN." }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Match by exact name and matching class (if class provided)
    const matched = rawRoster.find((s: any) => {
      const sName = String(s.name || "").trim().replace(/\s+/g, " ").toLowerCase();
      const sClass = String(s.class || "").trim().replace(/\s+/g, " ").toLowerCase();
      return sName === cleanName && (!cleanClass || sClass === cleanClass);
    });

    if (!matched) {
      return new Response(
        JSON.stringify({
          valid: false,
          error: `Candidate "${name}" was not found in the school roster${cleanClass ? ` for class ${studentClass}` : ""}. Please check your spelling or contact your teacher.`,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const expectedPin = String(matched.pin || "").trim();
    if (expectedPin !== cleanPin) {
      return new Response(
        JSON.stringify({
          valid: false,
          error: `❌ Incorrect 4-digit PIN for ${matched.name}. Please check with your teacher.`,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // PIN is valid!
    return new Response(
      JSON.stringify({
        valid: true,
        student: {
          id: matched.id,
          name: matched.name,
          class: matched.class,
          candidateNumber: matched.candidateNumber,
        },
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message || "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
