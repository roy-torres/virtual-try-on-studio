/*
 * Virtual Try-On Studio — tiny zero-dependency server.
 *
 * 1. Serves the static frontend in ./public
 * 2. Proxies every request under /comfy/* to the local ComfyUI instance,
 *    so the browser never runs into CORS problems.
 * 3. Proxies the ComfyUI websocket (/comfy/ws) for live progress.
 *
 * Run:  node server.js         (then open http://localhost:5173)
 *
 * Demo mode: when DEMO_PASSWORD is set (keep it in the gitignored .env), every
 * request needs HTTP Basic auth, only the handful of ComfyUI routes the app
 * uses are reachable, and /prompt is rebuilt server-side from
 * public/workflow.api.json so visitors can't queue arbitrary graphs.
 *   node --env-file-if-exists=.env server.js
 *   cloudflared tunnel --url http://localhost:5173
 */

const http = require("http");
const net = require("net");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");

const COMFY_HOST = process.env.COMFY_HOST || "127.0.0.1";
const COMFY_PORT = Number(process.env.COMFY_PORT || 8188);
const PORT = Number(process.env.PORT || 5173);
const PUBLIC_DIR = path.join(__dirname, "public");
const DEMO_PASSWORD = process.env.DEMO_PASSWORD || "";
const DEMO = DEMO_PASSWORD.length > 0;
// Jobs allowed in ComfyUI's queue (running + pending) before /prompt is refused.
// CPU mode is ~11 min per image, so a small cap keeps the wait bounded.
const DEMO_MAX_QUEUE = Number(process.env.DEMO_MAX_QUEUE || 2);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

// Text-ish types worth gzipping; images are already compressed, don't bother.
const COMPRESSIBLE = new Set([".html", ".js", ".css", ".json", ".svg"]);

// Reuse TCP connections to ComfyUI instead of a fresh handshake per request —
// the browser polls /comfy/history and /comfy/queue every 1.5s for up to ~11
// minutes per generation, so this is hundreds of handshakes saved per run.
const comfyAgent = new http.Agent({ keepAlive: true, maxSockets: 16 });

// Headers that are per-connection, not per-resource — never forward these
// verbatim in either direction, the agent/socket manage their own.
const HOP_BY_HOP = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];
function stripHopByHop(headers) {
  const out = { ...headers };
  for (const h of HOP_BY_HOP) delete out[h];
  return out;
}

// --- Helpers ------------------------------------------------------------
// Late failures (upstream died, fs blew up) can land after the response has
// already started — never write headers twice, just drop the connection.
function fail(res, code, message) {
  if (res.writableEnded) return;
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(code, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(message);
}

function log(req, res) {
  const started = Date.now();
  const line = `${req.method} ${req.url}`;
  res.on("finish", () =>
    console.log(`  ${line} → ${res.statusCode} (${Date.now() - started}ms)`)
  );
  res.on("close", () => {
    if (!res.writableFinished) console.log(`  ${line} → aborted`);
  });
}


// --- Demo mode ----------------------------------------------------------
const DEMO_PASSWORD_HASH = crypto.createHash("sha256").update(DEMO_PASSWORD).digest();

function demoAuthorized(req) {
  const m = /^Basic\s+(.+)$/i.exec(req.headers.authorization || "");
  if (!m) return false;
  const decoded = Buffer.from(m[1], "base64").toString("utf8");
  const password = decoded.slice(decoded.indexOf(":") + 1); // any username
  const hash = crypto.createHash("sha256").update(password).digest();
  return crypto.timingSafeEqual(hash, DEMO_PASSWORD_HASH);
}

// The only ComfyUI routes public/index.html calls. Everything else (manager,
// model downloads, settings, userdata, full history) stays unreachable.
function demoRouteAllowed(method, pathname) {
  if (method === "GET")
    return (
      pathname === "/system_stats" ||
      pathname === "/queue" ||
      pathname === "/view" ||
      /^\/history\/[\w-]+$/.test(pathname)
    );
  if (method === "POST")
    return ["/upload/image", "/prompt", "/interrupt", "/queue"].includes(pathname);
  return false;
}

// Mirrors the node contract in public/index.html — the only inputs a visitor
// may set. The rest of the graph always comes from workflow.api.json.
const DEMO_EDITABLE = [
  ["76", "image", "string"],
  ["81", "image", "string"],
  ["92:109", "text", "string"],
  ["92:106", "noise_seed", "seed"],
];

function buildDemoPrompt(body) {
  const template = JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR, "workflow.api.json"), "utf8"));
  const sent = body && body.prompt;
  if (!sent || typeof sent !== "object") throw new Error("Missing prompt");
  for (const [node, input, kind] of DEMO_EDITABLE) {
    const value = sent[node] && sent[node].inputs && sent[node].inputs[input];
    const ok =
      kind === "seed"
        ? Number.isSafeInteger(value) && value >= 0
        : typeof value === "string" && value.length > 0 && value.length <= 4000;
    if (!ok) throw new Error(`Invalid ${input} for node ${node}`);
    template[node].inputs[input] = value;
  }
  const out = { prompt: template };
  if (typeof body.client_id === "string") out.client_id = body.client_id;
  return out;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("Body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function comfyQueueLength() {
  return new Promise((resolve, reject) => {
    const r = http.get(
      { host: COMFY_HOST, port: COMFY_PORT, path: "/queue", agent: comfyAgent },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            const q = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            resolve((q.queue_running || []).length + (q.queue_pending || []).length);
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    r.on("error", reject);
  });
}

// POST /prompt and POST /queue get their bodies rewritten; the rest pass through.
async function demoRewriteBody(req, pathname) {
  if (req.method !== "POST" || (pathname !== "/prompt" && pathname !== "/queue")) return null;
  const raw = await readBody(req, 1024 * 1024);
  let body;
  try {
    body = JSON.parse(raw.toString("utf8"));
  } catch {
    throw Object.assign(new Error("Body is not JSON"), { status: 400 });
  }
  if (pathname === "/queue") {
    // Only "delete these ids" — never {clear: true}, which empties everyone's queue.
    const ids = Array.isArray(body.delete) ? body.delete.filter((x) => typeof x === "string") : [];
    return Buffer.from(JSON.stringify({ delete: ids }));
  }
  let prompt;
  try {
    prompt = buildDemoPrompt(body);
  } catch (err) {
    throw Object.assign(err, { status: 400 });
  }
  if ((await comfyQueueLength()) >= DEMO_MAX_QUEUE)
    throw Object.assign(
      new Error("The demo is busy with other images right now. Try again in a few minutes."),
      { status: 429 }
    );
  return Buffer.from(JSON.stringify(prompt));
}

const server = http.createServer((req, res) => {
  log(req, res);
  req.on("error", (err) => console.warn(`  request error: ${err.message}`));
  res.on("error", (err) => console.warn(`  response error: ${err.message}`));

  if (DEMO && !demoAuthorized(req)) {
    res.writeHead(401, {
      "Content-Type": "text/plain; charset=utf-8",
      "WWW-Authenticate": 'Basic realm="Try-On Studio demo", charset="UTF-8"',
    });
    res.end("Password required");
    return;
  }

  // --- ComfyUI HTTP proxy -------------------------------------------------
  if (req.url === "/comfy" || req.url.startsWith("/comfy/")) {
    const upstreamPath = req.url.replace(/^\/comfy/, "") || "/";
    if (!DEMO) {
      proxyToComfy(req, res, upstreamPath, null);
      return;
    }
    const pathname = upstreamPath.split("?")[0];
    if (!demoRouteAllowed(req.method, pathname)) {
      fail(res, 403, "Not available in the demo");
      return;
    }
    demoRewriteBody(req, pathname).then(
      (body) => proxyToComfy(req, res, upstreamPath, body),
      (err) => fail(res, err.status || 502, err.message)
    );
    return;
  }

  // --- Static files -----------------------------------------------------
  let urlPath;
  try {
    urlPath = decodeURIComponent(req.url.split("?")[0]);
  } catch {
    fail(res, 400, "Bad request");
    return;
  }
  if (urlPath === "/") urlPath = "/index.html";
  const filePath = path.join(PUBLIC_DIR, path.normalize(urlPath));
  // startsWith(PUBLIC_DIR) alone would also accept siblings like `public-evil`.
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    fail(res, 403, "Forbidden");
    return;
  }
  serveStatic(req, res, filePath);
});

// --- ComfyUI HTTP proxy -------------------------------------------------
// `body` is a rewritten request body (demo mode), or null to stream req as-is.
function proxyToComfy(req, res, upstreamPath, body) {
  const comfyOrigin = `http://${COMFY_HOST}:${COMFY_PORT}`;
  // ComfyUI blocks requests whose Origin/Referer don't match its own host
  // (DNS-rebinding protection), so rewrite them to look local.
  const headers = {
    ...stripHopByHop(req.headers),
    host: `${COMFY_HOST}:${COMFY_PORT}`,
    origin: comfyOrigin,
  };
  if (headers.referer) headers.referer = comfyOrigin + "/";
  delete headers.authorization; // the demo password is ours, not ComfyUI's
  if (body) headers["content-length"] = String(body.length);
  const proxyReq = http.request(
    {
      host: COMFY_HOST,
      port: COMFY_PORT,
      method: req.method,
      path: upstreamPath,
      headers,
      agent: comfyAgent,
      // No timeout on purpose: CPU-mode generations run for ~11 minutes and
      // the frontend polls for as long as the job is alive.
      timeout: 0,
    },
    (proxyRes) => {
      if (res.writableEnded || res.headersSent) {
        proxyRes.resume();
        return;
      }
      res.writeHead(proxyRes.statusCode || 502, stripHopByHop(proxyRes.headers));
      proxyRes.pipe(res);
      // ComfyUI dying mid-stream: cut the response, don't crash.
      proxyRes.on("error", (err) => {
        console.warn(`  upstream stream error: ${err.message}`);
        res.destroy();
      });
    }
  );
  proxyReq.on("error", (err) => {
    fail(
      res,
      502,
      `Cannot reach ComfyUI at http://${COMFY_HOST}:${COMFY_PORT}\n${err.message}`
    );
  });
  // Browser hung up (reload, tab close): drop the upstream socket too.
  res.on("close", () => {
    if (!res.writableFinished) proxyReq.destroy();
  });
  req.on("error", () => proxyReq.destroy());
  if (body) proxyReq.end(body);
  else req.pipe(proxyReq);
}

// In-memory cache of static files, keyed by path. Revalidated against the
// file's mtime/size on every request (a stat, not a read) so editing
// public/index.html is picked up on the next load — never a permanent cache.
const fileCache = new Map(); // filePath -> { mtimeMs, size, etag, mime, data, gzip }

function serveStatic(req, res, filePath) {
  fs.stat(filePath, (err, stat) => {
    if (err) {
      if (err.code === "ENOENT" || err.code === "ENOTDIR") fail(res, 404, "Not found");
      else {
        console.warn(`  stat error ${err.code}: ${filePath}`);
        fail(res, 500, "Internal error");
      }
      return;
    }
    if (stat.isDirectory()) {
      fail(res, 403, "Directory listing not allowed");
      return;
    }

    const cached = fileCache.get(filePath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      respondStatic(req, res, cached);
      return;
    }

    fs.readFile(filePath, (readErr, data) => {
      if (readErr) {
        if (readErr.code === "ENOENT") fail(res, 404, "Not found");
        else {
          console.warn(`  read error ${readErr.code}: ${filePath}`);
          fail(res, 500, "Internal error");
        }
        return;
      }
      const ext = path.extname(filePath);
      const entry = {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        etag: `"${stat.mtimeMs.toString(16)}-${stat.size.toString(16)}"`,
        mime: MIME[ext] || "application/octet-stream",
        data,
        gzip: COMPRESSIBLE.has(ext) ? zlib.gzipSync(data) : null,
      };
      fileCache.set(filePath, entry);
      respondStatic(req, res, entry);
    });
  });
}

function respondStatic(req, res, entry) {
  if (res.writableEnded) return;

  const inm = req.headers["if-none-match"];
  if (inm && inm === entry.etag) {
    res.writeHead(304, { ETag: entry.etag });
    res.end();
    return;
  }

  const headers = {
    "Content-Type": entry.mime,
    ETag: entry.etag,
    "Last-Modified": new Date(entry.mtimeMs).toUTCString(),
  };
  const acceptsGzip = (req.headers["accept-encoding"] || "").includes("gzip");
  if (entry.gzip) {
    headers.Vary = "Accept-Encoding";
    if (acceptsGzip) {
      headers["Content-Encoding"] = "gzip";
      res.writeHead(200, headers);
      res.end(entry.gzip);
      return;
    }
  }
  res.writeHead(200, headers);
  res.end(entry.data);
}

// --- ComfyUI websocket proxy (/comfy/ws) --------------------------------
server.on("upgrade", (req, clientSocket, head) => {
  if (!req.url.startsWith("/comfy/ws")) {
    clientSocket.destroy();
    return;
  }
  if (DEMO && !demoAuthorized(req)) {
    clientSocket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    return;
  }
  console.log(`  UPGRADE ${req.url} → ComfyUI ws`);
  const upstreamPath = req.url.replace(/^\/comfy/, "");
  let handshakeDone = false;
  const upstream = net.connect(COMFY_PORT, COMFY_HOST, () => {
    handshakeDone = true;
    const lines = [
      `GET ${upstreamPath} HTTP/1.1`,
      `Host: ${COMFY_HOST}:${COMFY_PORT}`,
      "Connection: Upgrade",
      "Upgrade: websocket",
      `Sec-WebSocket-Key: ${req.headers["sec-websocket-key"]}`,
      `Sec-WebSocket-Version: ${req.headers["sec-websocket-version"] || "13"}`,
    ];
    if (req.headers["sec-websocket-protocol"])
      lines.push(`Sec-WebSocket-Protocol: ${req.headers["sec-websocket-protocol"]}`);
    if (req.headers["sec-websocket-extensions"])
      lines.push(`Sec-WebSocket-Extensions: ${req.headers["sec-websocket-extensions"]}`);
    upstream.write(lines.join("\r\n") + "\r\n\r\n");
    if (head && head.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
  upstream.on("error", (err) => {
    // Before the handshake the client still speaks HTTP — say why, don't
    // just vanish.
    if (!handshakeDone && clientSocket.writable) {
      const body = `Cannot reach ComfyUI at http://${COMFY_HOST}:${COMFY_PORT}\n${err.message}`;
      clientSocket.write(
        "HTTP/1.1 502 Bad Gateway\r\n" +
          "Content-Type: text/plain; charset=utf-8\r\n" +
          `Content-Length: ${Buffer.byteLength(body)}\r\n` +
          "Connection: close\r\n\r\n" +
          body
      );
    }
    clientSocket.destroy();
  });
  clientSocket.on("error", () => upstream.destroy());
  // Either side hanging up tears down the pair.
  upstream.on("close", () => clientSocket.destroy());
  clientSocket.on("close", () => upstream.destroy());
});

server.on("clientError", (err, socket) => {
  if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  socket.destroy();
});

// --- Stay alive ---------------------------------------------------------
// A local dev server dying 9 minutes into an 11-minute generation is the
// worst possible outcome, so log loudly and keep serving.
process.on("uncaughtException", (err) => {
  console.error(`  uncaught exception: ${err && err.stack ? err.stack : err}`);
});
process.on("unhandledRejection", (reason) => {
  console.error(`  unhandled rejection: ${reason && reason.stack ? reason.stack : reason}`);
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error("");
    console.error(`  Port ${PORT} is already in use.`);
    console.error(`  Find it with:  lsof -i :${PORT}`);
    console.error(`  Or pick another:  PORT=5174 node server.js`);
    console.error("");
    process.exit(1);
  } else if (err.syscall === "listen") {
    console.error(`  Cannot listen on port ${PORT}: ${err.message}`);
    process.exit(1);
  } else {
    // Anything else: log it, but never take the server down mid-generation.
    console.error(`  Server error: ${err.message}`);
  }
});

server.listen(PORT, () => {
  console.log("");
  console.log(`  Virtual Try-On Studio   →  http://localhost:${PORT}`);
  console.log(`  Proxying ComfyUI at     →  http://${COMFY_HOST}:${COMFY_PORT}`);
  if (DEMO) console.log(`  Demo mode               →  password on, max ${DEMO_MAX_QUEUE} queued`);
  console.log("");
});
