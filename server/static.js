/**
 * Static asset serving for the single-page client.
 *
 * Assets can come from an injected loader (the desktop SEA shell serves embedded
 * files through it) or from disk roots. The web UI is served from "/" and the
 * deterministic rules engine is mounted at "/shared/" so the browser can import
 * the same engine module the server uses.
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { HttpError } from "./http.js";

const MIME_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".ico", "image/x-icon"],
  [".txt", "text/plain; charset=utf-8"],
  [".woff2", "font/woff2"],
  [".woff", "font/woff"]
]);

const SHARED_PREFIX = "/shared/";

export function createStaticHandler({ staticDir = null, sharedDir = null, assetLoader = null, logger = null } = {}) {
  async function loadAsset(pathname) {
    // The resolved asset name drives the MIME type: "/" and extensionless SPA
    // routes serve index.html, which browsers must receive as text/html.
    const isDocumentRoute = pathname === "/" || pathname === "" || extname(pathname) === "";
    if (typeof assetLoader === "function") {
      const asset = await assetLoader(pathname);
      if (asset !== null && asset !== undefined) {
        return { content: toBuffer(asset), assetName: isDocumentRoute ? "/index.html" : pathname };
      }
    }
    if (pathname.startsWith(SHARED_PREFIX)) {
      if (!sharedDir) return null;
      const content = await readFromRoot(sharedDir, pathname.slice(SHARED_PREFIX.length));
      return content ? { content, assetName: pathname } : null;
    }
    if (!staticDir) return null;
    const relative = pathname === "/" ? "index.html" : pathname.slice(1);
    const direct = await readFromRoot(staticDir, relative);
    if (direct) return { content: direct, assetName: pathname === "/" ? "/index.html" : pathname };
    if (isDocumentRoute) {
      const fallback = await readFromRoot(staticDir, "index.html");
      if (fallback) return { content: fallback, assetName: "/index.html" };
    }
    return null;
  }

  async function handle(req, res, rawPathname) {
    const pathname = normalizePathname(rawPathname);
    if (pathname === null) {
      sendNotFound(res);
      return;
    }
    let asset;
    try {
      asset = await loadAsset(pathname);
    } catch (error) {
      logger?.error?.("Static asset loading failed. (" + (error?.message ?? error) + ")");
      throw new HttpError(500, "INTERNAL_ERROR", "The requested asset could not be loaded.");
    }
    if (!asset) {
      sendNotFound(res);
      return;
    }
    const extension = extname(asset.assetName).toLowerCase();
    const etag = '"' + createHash("sha1").update(asset.content).digest("hex").slice(0, 16) + "-" + asset.content.length + '"';
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, { ETag: etag });
      res.end();
      return;
    }
    const contentType = MIME_TYPES.get(extension) ?? "application/octet-stream";
    const cacheControl = extension === "" || extension === ".html" ? "no-cache" : "public, max-age=300";
    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": asset.content.length,
      "Cache-Control": cacheControl,
      ETag: etag
    });
    if (req.method === "HEAD") res.end();
    else res.end(asset.content);
  }

  return { handle };
}

async function readFromRoot(root, relative) {
  if (!relative || relative.includes("\0")) return null;
  const absoluteRoot = resolve(root);
  const candidate = resolve(absoluteRoot, relative);
  if (candidate !== absoluteRoot && !candidate.startsWith(absoluteRoot + sep)) return null;
  try {
    const stat = await fs.stat(candidate);
    if (!stat.isFile()) return null;
    return await fs.readFile(candidate);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR" || error?.code === "EISDIR") return null;
    throw error;
  }
}

function normalizePathname(rawPathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(rawPathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const segments = [];
  for (const segment of decoded.replace(/\\/g, "/").split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  const pathname = "/" + segments.join("/");
  if (pathname === "/") return "/";
  return pathname;
}

function toBuffer(asset) {
  return Buffer.isBuffer(asset) ? asset : Buffer.from(asset);
}

function sendNotFound(res) {
  const body = "<!doctype html><html><head><meta charset=\"utf-8\"><title>Not Found</title></head><body><h1>404 Not Found</h1></body></html>";
  res.writeHead(404, { "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  if (res.headOnly) res.end();
  else res.end(body);
}
