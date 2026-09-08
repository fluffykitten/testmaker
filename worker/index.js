import { PhotonImage } from "@cf-wasm/photon";

export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, PUT, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key",
      "Access-Control-Max-Age": "86400",
    };

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
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
