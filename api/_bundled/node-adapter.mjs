// server/vercel-node-adapter.mjs
function corsHeaders(extra = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, PUT, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, If-Match",
    ...extra
  };
}
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    if (req.body !== void 0 && req.body !== null) {
      if (typeof req.body === "string") resolve(req.body);
      else if (Buffer.isBuffer(req.body)) resolve(req.body.toString("utf8"));
      else resolve(JSON.stringify(req.body));
      return;
    }
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on(
      "end",
      () => resolve(Buffer.concat(chunks).toString("utf8") || "")
    );
    req.on("error", reject);
  });
}
async function reqToEvent(req, params = {}) {
  const url = String(req.url || "/");
  let pathname = url.split("?")[0] || "/";
  let query = { ...req.query || {} };
  try {
    const u = new URL(url, "http://localhost");
    pathname = u.pathname;
    query = { ...query, ...Object.fromEntries(u.searchParams.entries()) };
  } catch {
  }
  const method = String(req.method || "GET").toUpperCase();
  let body = "";
  if (method !== "GET" && method !== "HEAD") {
    body = await readRawBody(req);
  }
  return {
    httpMethod: method,
    path: pathname,
    rawUrl: url,
    headers: req.headers || {},
    queryStringParameters: query,
    body,
    pathParameters: params
  };
}
function sendLambdaResult(res, result) {
  const headers = { ...corsHeaders(), ...result.headers || {} };
  res.statusCode = result.statusCode;
  for (const [k, v] of Object.entries(headers)) {
    if (v != null) res.setHeader(k, String(v));
  }
  res.end(result.body ?? "");
}
async function streamNdjson(res, run) {
  const headers = {
    ...corsHeaders(),
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  };
  res.writeHead(200, headers);
  const push = (obj) => {
    try {
      res.write(`${JSON.stringify(obj)}
`);
    } catch {
    }
  };
  try {
    await run(push);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    push({ event: "error", message: msg });
  } finally {
    res.end();
  }
}
function withNodeHandler(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      console.error("[vercel-api]", e);
      const msg = e instanceof Error ? e.message : String(e);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.end(JSON.stringify({ error: { message: msg } }));
      } else {
        try {
          res.end();
        } catch {
        }
      }
    }
  };
}
export {
  corsHeaders,
  reqToEvent,
  sendLambdaResult,
  streamNdjson,
  withNodeHandler
};
