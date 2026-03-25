/**
 * Bridge Netlify Function (event, context) → (req, res) for Vercel Node API routes.
 */

/**
 * @param {import('http').IncomingMessage & { query?: Record<string, string | string[]> }} req
 */
function queryFromReq(req) {
  if (req.query && typeof req.query === "object" && Object.keys(req.query).length > 0) {
    const out = {};
    for (const [k, v] of Object.entries(req.query)) {
      if (Array.isArray(v)) out[k] = v[0];
      else if (v != null) out[k] = v;
    }
    return out;
  }
  const url = typeof req.url === "string" ? req.url : "";
  const q = url.indexOf("?");
  if (q === -1) return {};
  try {
    const params = new URLSearchParams(url.slice(q + 1));
    const out = {};
    params.forEach((v, k) => {
      out[k] = v;
    });
    return out;
  } catch {
    return {};
  }
}

/**
 * @param {import('http').IncomingMessage & { query?: Record<string, string | string[]> }} req
 * @returns {import('@netlify/functions').HandlerEvent}
 */
function netlifyEventFromReq(req) {
  const headers = { ...req.headers };
  let body;
  if (req.method && !["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    if (req.body == null) body = "";
    else if (typeof req.body === "string") body = req.body;
    else if (Buffer.isBuffer(req.body)) body = req.body.toString("utf8");
    else body = JSON.stringify(req.body);
  }
  const query = queryFromReq(req);
  return {
    httpMethod: req.method || "GET",
    headers,
    body,
    queryStringParameters: query,
    rawUrl: req.url,
    path: typeof req.url === "string" ? req.url.split("?")[0] : "",
  };
}

/**
 * @param {import('http').ServerResponse} res
 * @param {import('@netlify/functions').HandlerResponse} result
 */
function sendNetlifyResponse(res, result) {
  if (result == null) {
    res.status(500).end();
    return;
  }
  const { statusCode = 200, headers = {}, body = "", isBase64Encoded } = result;
  if (headers && typeof headers === "object") {
    for (const [key, val] of Object.entries(headers)) {
      if (val !== undefined && val !== null) res.setHeader(key, val);
    }
  }
  if (isBase64Encoded && typeof body === "string") {
    res.status(statusCode).send(Buffer.from(body, "base64"));
    return;
  }
  res.status(statusCode).send(body);
}

/**
 * @param {import('@netlify/functions').Handler} handlerFn
 * @returns {(req: import('http').IncomingMessage, res: import('http').ServerResponse) => Promise<void>}
 */
function wrapNetlifyHandler(handlerFn) {
  return async (req, res) => {
    try {
      const event = netlifyEventFromReq(req);
      const result = await handlerFn(event, {});
      sendNetlifyResponse(res, result);
    } catch (e) {
      console.error(e);
      if (!res.headersSent) {
        res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    }
  };
}

module.exports = { wrapNetlifyHandler, netlifyEventFromReq, sendNetlifyResponse };
