const MIME_BY_EXT = {
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};

function extname(key) {
  const i = key.lastIndexOf(".");
  if (i <= 0 || i === key.length - 1) return "";
  return key.slice(i).toLowerCase();
}

function cacheControlForKey(key) {
  const ext = extname(key);
  if (ext === ".json") return "public, max-age=300";
  if ([".html", ".js", ".css"].includes(ext)) return "public, max-age=3600";
  return "public, max-age=31536000, immutable";
}

function corsHeaders(origin = "*") {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Range, If-None-Match",
    "Access-Control-Max-Age": "86400",
  };
}

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

function clientIdentifier(request) {
  return request.headers.get("cf-connecting-ip")
    || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || "unknown";
}

function rateLimitKeyForRequest(request) {
  return `client:${clientIdentifier(request)}`;
}

async function checkRateLimit(request, env) {
  if (!env.IMAGE_RATE_LIMITER || typeof env.IMAGE_RATE_LIMITER.limit !== "function") {
    return null;
  }

  const { success } = await env.IMAGE_RATE_LIMITER.limit({
    key: rateLimitKeyForRequest(request),
  });

  if (success) {
    return null;
  }

  return new Response("too many requests", {
    status: 429,
    headers: {
      "Retry-After": "60",
      "Cache-Control": "private, no-store",
      ...corsHeaders(request.headers.get("Origin") || "*"),
    },
  });
}

// 解析 BUCKET_MAP（JSON 字符串），失败时返回空对象。
function parseBucketMap(env) {
  if (!env || typeof env.BUCKET_MAP !== "string") return {};
  try {
    const obj = JSON.parse(env.BUCKET_MAP);
    return obj && typeof obj === "object" ? obj : {};
  } catch {
    return {};
  }
}

// 路由规则：
//   /b/<别名>/<key...>  -> 选 BUCKET_MAP[别名] 对应的 R2 binding
//   /<key...>           -> 走 DEFAULT_ALIAS 指定的别名
// 返回 { bucket, key } 或 { error: { status, message } }
function resolveRoute(url, env) {
  const map = parseBucketMap(env);
  const aliases = Object.keys(map);
  const raw = url.pathname.replace(/^\/+/, "");

  let alias;
  let keyRaw;

  const m = /^b\/([^/]+)\/(.*)$/.exec(raw);
  if (m) {
    alias = safeDecode(m[1]);
    keyRaw = m[2];
  } else {
    alias = env.DEFAULT_ALIAS || aliases[0];
    keyRaw = raw;
  }

  if (!alias || !(alias in map)) {
    return {
      error: {
        status: 404,
        message: `unknown bucket alias: ${alias || "(none)"}; available: ${aliases.join(",") || "(empty)"}`,
      },
    };
  }
  const bindingName = map[alias];
  const bucket = env[bindingName];
  if (!bucket) {
    return {
      error: {
        status: 500,
        message: `R2 binding not configured: ${bindingName} (alias=${alias})`,
      },
    };
  }

  const key = safeDecode(keyRaw);
  if (key === null) {
    return { error: { status: 400, message: "invalid path encoding" } };
  }
  if (!key) {
    return { error: { status: 400, message: "missing object key" } };
  }
  return { bucket, key, alias };
}

async function serveObject(object, key, method) {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  if (!headers.has("Content-Type")) {
    const ext = extname(key);
    if (MIME_BY_EXT[ext]) headers.set("Content-Type", MIME_BY_EXT[ext]);
  }
  headers.set("etag", object.httpEtag);
  headers.set("Cache-Control", cacheControlForKey(key));
  for (const [k, v] of Object.entries(corsHeaders())) headers.set(k, v);

  if (method === "HEAD") {
    return new Response(null, { status: 200, headers });
  }
  return new Response(object.body, { status: 200, headers });
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(),
    },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (url.pathname === "/" || url.pathname === "/health") {
      const map = parseBucketMap(env);
      return jsonResponse({
        ok: true,
        service: "r2-proxy",
        usage: [
          "GET /b/<alias>/<key>  按别名选桶",
          "GET /<key>            走默认别名",
        ],
        defaultAlias: env.DEFAULT_ALIAS || null,
        aliases: Object.keys(map),
      });
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("method not allowed", {
        status: 405,
        headers: corsHeaders(),
      });
    }

    const rateLimited = await checkRateLimit(request, env);
    if (rateLimited) {
      return rateLimited;
    }

    const route = resolveRoute(url, env);
    if (route.error) {
      return new Response(route.error.message, {
        status: route.error.status,
        headers: corsHeaders(),
      });
    }

    const object = await route.bucket.get(route.key);
    if (!object) {
      return new Response(`not found: ${route.alias}/${route.key}`, {
        status: 404,
        headers: {
          "Cache-Control": "public, max-age=60",
          ...corsHeaders(),
        },
      });
    }

    return serveObject(object, route.key, request.method);
  },
};
