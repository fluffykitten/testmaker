import { PhotonImage } from "@cf-wasm/photon";

export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, PUT, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key, x-gemini-key, cf-turnstile-token",
      "Access-Control-Max-Age": "86400",
    };

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);

    // ─── API Route 1: Turnstile Anti-Bot Token Verification ──────────────────
    if (url.pathname === "/api/verify-turnstile" && request.method === "POST") {
      try {
        const body = await request.json();
        const token = body?.token;
        const clientIp = request.headers.get("CF-Connecting-IP") || "";

        if (!token) {
          return new Response(JSON.stringify({ success: false, error: "Missing Turnstile token" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        // If TURNSTILE_SECRET_KEY is omitted, fallback to Cloudflare's official testing secret (always passes)
        const secret = env.TURNSTILE_SECRET_KEY || "2x0000000000000000000000000000000AA";
        const formData = new URLSearchParams();
        formData.append("secret", secret);
        formData.append("response", token);
        if (clientIp) formData.append("remoteip", clientIp);

        const verifyRes = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
          method: "POST",
          body: formData,
        });

        const outcome = await verifyRes.json();
        return new Response(JSON.stringify(outcome), {
          status: outcome.success ? 200 : 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      } catch (err) {
        return new Response(JSON.stringify({ success: false, error: err.message }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // ─── API Route 2: Gemini AI Generation Proxy (Secret Shield & Failover) ──
    if (url.pathname === "/api/gemini/generate" && request.method === "POST") {
      try {
        const body = await request.json();
        const { prompt, contents, generationConfig, targetModel } = body;

        // Resolve API keys (Worker secret primary, secondary, or fallback header)
        const primaryKey = env.GEMINI_API_KEY;
        const secondaryKey = env.GEMINI_API_KEY_2;
        const fallbackClientKey = request.headers.get("x-gemini-key");
        const keys = [primaryKey, secondaryKey, fallbackClientKey].filter(Boolean);

        if (keys.length === 0) {
          return new Response(
            JSON.stringify({ error: "Gemini API key not configured on worker and no client key provided" }),
            {
              status: 500,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            }
          );
        }

        // Candidate models priority with automatic fallback on 404/429/503
        const candidateModels = targetModel
          ? [targetModel, "gemini-flash-lite-latest", "gemini-flash-latest", "gemini-2.5-flash", "gemini-1.5-flash"]
          : ["gemini-flash-lite-latest", "gemini-flash-latest", "gemini-2.5-flash", "gemini-1.5-flash"];

        const payload = contents
          ? { contents, generationConfig }
          : {
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: generationConfig || {
                responseMimeType: "application/json",
                temperature: 0.35,
                maxOutputTokens: 8192,
              },
            };

        let lastError = "";
        let successResult = null;

        modelLoop: for (const model of candidateModels) {
          for (const key of keys) {
            const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
            try {
              const res = await fetch(endpoint, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
              });

              if (res.ok) {
                const data = await res.json();
                successResult = {
                  model,
                  data,
                };
                break modelLoop;
              }

              const errText = await res.text();
              lastError = `Model ${model} (${res.status}): ${errText.slice(0, 200)}`;

              // 429: Rate limited, try backup key or next model
              if (res.status === 429) continue;
              // 404: Model deprecated, immediately move to next model
              if (res.status === 404) break;
            } catch (fetchErr) {
              lastError = fetchErr.message;
            }
          }
        }

        if (!successResult) {
          return new Response(JSON.stringify({ error: `AI generation failed: ${lastError}` }), {
            status: 502,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        return new Response(JSON.stringify(successResult), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // ─── API Route 3: Cloudflare Workers AI Diagram Generation (Flux-1-Schnell) ──
    if ((url.pathname === "/api/generate-diagram" || url.pathname === "/api/generate-diagram/") && request.method === "POST") {
      try {
        if (!env.AI) {
          return new Response(
            JSON.stringify({ success: false, error: "Workers AI binding 'AI' is not configured on this worker." }),
            {
              status: 503,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            }
          );
        }

        if (!env.BUCKET) {
          return new Response(
            JSON.stringify({ success: false, error: "R2 bucket binding 'BUCKET' is not configured on this worker." }),
            {
              status: 503,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            }
          );
        }

        // Validate secret or turnstile token to prevent free tier neuron exhaustion
        const authHeader = request.headers.get("Authorization") || request.headers.get("x-api-key");
        const turnstileHeader = request.headers.get("cf-turnstile-token");
        const expectedSecret = env.UPLOAD_SECRET || "tm_r2_uploader_secret_2026";

        const isAuthValid =
          authHeader === `Bearer ${expectedSecret}` ||
          authHeader === expectedSecret ||
          Boolean(turnstileHeader);

        if (!isAuthValid && env.UPLOAD_SECRET) {
          return new Response(JSON.stringify({ success: false, error: "Unauthorized diagram generation request" }), {
            status: 401,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        const body = await request.json();
        const { prompt, stylePreset = "stem", targetKey } = body || {};

        if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0) {
          return new Response(
            JSON.stringify({ success: false, error: "Missing required 'prompt' parameter." }),
            {
              status: 400,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            }
          );
        }

        // Strip redundant prefixes to optimize Flux-1 CLIP token space
        const cleanPrompt = prompt
          .trim()
          .replace(/^(?:draw|generate|create|render)\s+(?:an?\s+)?(?:image|diagram|illustration|figure|apparatus|sketch|setup)\s+(?:of\s+)?/i, "")
          .replace(/^(?:black\s+and\s+white|b&w|line\s+art)\s+/i, "")
          .replace(/^(?:an?\s+|the\s+)/i, "")
          .replace(/^["']|["']$/g, "")
          .trim();

        // Dynamic subject-specific system prefix to guarantee Cambridge/IB textbook aesthetics & avoid hallucinations
        let enrichedPrompt = "";
        const normalizedPreset = (stylePreset || "stem").toLowerCase();

        if (normalizedPreset.includes("geo") || normalizedPreset.includes("earth") || normalizedPreset.includes("map")) {
          enrichedPrompt = `Black and white geography map or landscape sketch, high contrast, clean outlines, textbook topography, pure solid white background (#ffffff), no colors, no random gibberish text or false numbers, geographical textbook illustration style: ${cleanPrompt}`;
        } else if (
          normalizedPreset.includes("hist") ||
          normalizedPreset.includes("soc") ||
          normalizedPreset.includes("eng") ||
          normalizedPreset.includes("lit") ||
          normalizedPreset.includes("cartoon")
        ) {
          enrichedPrompt = `Black and white historical political cartoon or sociological illustration style, pen and ink sketch, cross-hatching, high contrast, textbook figure, pure solid white background (#ffffff), no random gibberish text: ${cleanPrompt}`;
        } else {
          // Default: STEM (Science, Physics, Chemistry, Biology, Mathematics)
          enrichedPrompt = `Black and white textbook line diagram, charcoal technical illustration, clean vector outlines, pure solid white background (#ffffff), high contrast, no colors, no shading, no 3D rendering, no random gibberish text or hallucinated numbers, clean lines, scientific exam figure: ${cleanPrompt}`;
        }

        // Call Cloudflare Workers AI with Flux-1-schnell (fast edge generation)
        let aiRes;
        try {
          aiRes = await env.AI.run("@cf/black-forest-labs/flux-1-schnell", {
            prompt: enrichedPrompt,
          });
        } catch (aiErr) {
          return new Response(
            JSON.stringify({
              success: false,
              error: `Workers AI error: ${aiErr.message}`,
              isQuotaExceeded: aiErr.message?.includes("quota") || aiErr.message?.includes("rate limit"),
            }),
            {
              status: 502,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            }
          );
        }

        // Handle binary or base64 format returned by Workers AI
        let imageBytes;
        if (aiRes instanceof Uint8Array || aiRes instanceof ArrayBuffer) {
          imageBytes = aiRes;
        } else if (aiRes && typeof aiRes === "object" && aiRes.image) {
          const binaryString = atob(aiRes.image);
          const bytes = new Uint8Array(binaryString.length);
          for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
          }
          imageBytes = bytes.buffer;
        } else if (aiRes instanceof ReadableStream || (aiRes && typeof aiRes.arrayBuffer === "function")) {
          imageBytes = await new Response(aiRes).arrayBuffer();
        } else {
          imageBytes = aiRes;
        }

        // Store directly into R2 bucket ($0 egress, instant access)
        const fileKey = targetKey || `variants/diagram_${crypto.randomUUID().slice(0, 12)}.png`;

        if (env.BUCKET) {
          await env.BUCKET.put(fileKey, imageBytes, {
            httpMetadata: {
              contentType: "image/png",
              cacheControl: "public, max-age=31536000, immutable",
            },
          });
        }

        const baseUrl = env.PUBLIC_URL || url.origin;
        const publicUrl = `${baseUrl.replace(/\/+$/, '')}/${fileKey}`;

        return new Response(
          JSON.stringify({
            success: true,
            key: fileKey,
            url: publicUrl,
            prompt: enrichedPrompt,
            stylePreset: normalizedPreset,
          }),
          {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      } catch (err) {
        return new Response(JSON.stringify({ success: false, error: err.message }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    const rawKey = decodeURIComponent(url.pathname.replace(/^\/+/, ""));

    // Handle Uploads (PUT)
    if (request.method === "PUT") {
      if (!rawKey) {
        return new Response("Missing destination key", { status: 400, headers: corsHeaders });
      }

      const authHeader = request.headers.get("Authorization") || request.headers.get("x-api-key");
      const expectedSecret = env.UPLOAD_SECRET || "tm_r2_uploader_secret_2026";
      if (authHeader !== `Bearer ${expectedSecret}` && authHeader !== expectedSecret) {
        return new Response("Unauthorized upload", { status: 401, headers: corsHeaders });
      }

      let contentType = request.headers.get("Content-Type");
      if (!contentType) {
        if (rawKey.endsWith(".webp")) contentType = "image/webp";
        else if (rawKey.endsWith(".png")) contentType = "image/png";
        else if (rawKey.endsWith(".jpg") || rawKey.endsWith(".jpeg")) contentType = "image/jpeg";
        else if (rawKey.endsWith(".mp3")) contentType = "audio/mpeg";
        else if (rawKey.endsWith(".wav")) contentType = "audio/wav";
        else if (rawKey.endsWith(".webm")) contentType = "audio/webm";
        else contentType = "application/octet-stream";
      }

      const body = await request.arrayBuffer();

      await env.BUCKET.put(rawKey, body, {
        httpMetadata: { contentType },
      });

      return new Response(
        JSON.stringify({
          success: true,
          key: rawKey,
          url: `https://testmaker-media.icmadani.workers.dev/${rawKey}`,
        }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Handle Public Reads (GET / HEAD)
    if (!rawKey) {
      return new Response("TestMaker Cloudflare Media Worker Active 🐱", {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    try {
      const formatQuery = url.searchParams.get("format")?.toLowerCase();
      const userAgent = request.headers.get("User-Agent") || "";
      const isGoogleFetcher = userAgent.includes("Google") || userAgent.includes("Feedfetcher");

      let key = rawKey;
      let targetFormat = null;

      if (formatQuery === "png" || key.endsWith(".png")) {
        targetFormat = "png";
      } else if (formatQuery === "jpg" || formatQuery === "jpeg" || key.endsWith(".jpg") || key.endsWith(".jpeg")) {
        targetFormat = "jpeg";
      } else if (isGoogleFetcher && key.endsWith(".webp")) {
        // If Google Form / Google Drive backend crawler fetches a .webp directly, transcode to PNG
        targetFormat = "png";
      }

      let actualKey = key;
      // 1. Try to fetch the requested key directly
      let object = await env.BUCKET.get(key);

      // 2. If not found, and targetFormat is png/jpeg, check if source webp exists
      let triedWebp = null;
      if (!object && targetFormat && (key.endsWith(".png") || key.endsWith(".jpg") || key.endsWith(".jpeg"))) {
        triedWebp = key.replace(/\.(png|jpe?g)$/i, ".webp");
        object = await env.BUCKET.get(triedWebp);
        if (object) {
          actualKey = triedWebp;
        }
      }

      if (!object) {
        return new Response(
          JSON.stringify({
            error: "Not found",
            rawKey,
            key,
            targetFormat,
            triedWebp,
          }),
          {
            status: 404,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }

      const currentContentType = object.httpMetadata?.contentType || "";
      const isSourceWebp =
        currentContentType === "image/webp" ||
        actualKey.endsWith(".webp");

      // 3. Check if transcoding to PNG or JPEG is needed
      if (targetFormat && isSourceWebp) {
        const arrayBuf = await object.arrayBuffer();
        const photonImg = PhotonImage.new_from_byteslice(new Uint8Array(arrayBuf));
        let convertedBytes;
        let mimeType;

        if (targetFormat === "jpeg") {
          convertedBytes = photonImg.get_bytes_jpeg(90);
          mimeType = "image/jpeg";
        } else {
          convertedBytes = photonImg.get_bytes();
          mimeType = "image/png";
        }

        const headers = new Headers();
        headers.set("Content-Type", mimeType);
        headers.set("Content-Length", convertedBytes.byteLength.toString());
        headers.set("Access-Control-Allow-Origin", "*");
        headers.set("Cache-Control", "public, max-age=31536000, immutable");
        headers.set("Accept-Ranges", "bytes");

        if (request.method === "HEAD") {
          return new Response(null, { headers });
        }

        return new Response(convertedBytes, { headers });
      }

      // 4. Standard pass-through for non-converted files (WebP, audio, etc.)
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      if (object.httpEtag) {
        headers.set("etag", object.httpEtag);
      }
      headers.set("Access-Control-Allow-Origin", "*");
      headers.set("Cache-Control", "public, max-age=31536000, immutable");
      if (object.size != null) {
        headers.set("Content-Length", object.size.toString());
      }
      headers.set("Accept-Ranges", "bytes");

      if (request.method === "HEAD") {
        return new Response(null, { headers });
      }

      return new Response(object.body, { headers });
    } catch (err) {
      return new Response(`Worker Error: ${err.message}`, {
        status: 500,
        headers: corsHeaders,
      });
    }
  },
};
