// server/vercel-http.mjs
function corsHeaders(extra = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, PUT, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, If-Match",
    ...extra
  };
}
async function requestToEvent(request, params = {}) {
  const url = new URL(request.url);
  const query = Object.fromEntries(url.searchParams.entries());
  const method = request.method || "GET";
  let body = "";
  if (method !== "GET" && method !== "HEAD") {
    body = await request.text();
  }
  return {
    httpMethod: method,
    path: url.pathname,
    rawUrl: request.url,
    headers: Object.fromEntries(request.headers.entries()),
    queryStringParameters: query,
    body,
    pathParameters: params
  };
}
function lambdaResultToResponse(result) {
  return new Response(result.body ?? "", {
    status: result.statusCode,
    headers: result.headers || {}
  });
}

// server/wrap-vercel-api.mjs
function withApiErrorGuard(handler) {
  return async (request, context) => {
    try {
      return await handler(request, context);
    } catch (err) {
      console.error("[vercel-api]", err);
      const msg = err instanceof Error ? err.message : String(err || "Internal error");
      return new Response(JSON.stringify({ error: { message: msg } }), {
        status: 500,
        headers: {
          ...corsHeaders(),
          "Content-Type": "application/json; charset=utf-8"
        }
      });
    }
  };
}
export {
  corsHeaders,
  lambdaResultToResponse,
  requestToEvent,
  withApiErrorGuard
};
