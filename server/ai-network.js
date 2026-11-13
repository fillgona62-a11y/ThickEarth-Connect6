/** Provider transport: validate destinations at configuration and socket lookup time. */
import { lookup } from "node:dns";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";
import { Readable } from "node:stream";
import { HttpError } from "./http.js";

const blockedV4 = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]
]) blockedV4.addSubnet(address, prefix, "ipv4");
const publicV6 = new BlockList();
publicV6.addSubnet("2000::", 3, "ipv6");
const blockedV6 = new BlockList();
for (const [address, prefix] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]]) {
  blockedV6.addSubnet(address, prefix, "ipv6");
}

function normalizeHost(hostname) {
  return String(hostname ?? "").toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

export function isLoopbackHost(hostname) {
  const host = normalizeHost(hostname);
  return host === "localhost" || host === "::1" || (isIP(host) === 4 && host.startsWith("127."));
}

export function isPrivateOrReservedHost(hostname) {
  const host = normalizeHost(hostname);
  const family = isIP(host);
  if (family === 4) return blockedV4.check(host, "ipv4");
  // IPv4-mapped IPv6, NAT64 and transition ranges are deliberately not public destinations.
  if (family === 6) return !publicV6.check(host, "ipv6") || blockedV6.check(host, "ipv6");
  return !host.includes(".") || /\.(localhost|local|internal|home\.arpa)$/.test(host);
}

export function validateBaseUrl(value, { mode = "desktop" } = {}) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (raw === "mock://local") return raw;
  let url;
  try { url = new URL(raw); } catch { throw new HttpError(400, "INVALID_BASE_URL", "Enter a valid http(s) base URL."); }
  if (raw.length > 1024 || !["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new HttpError(400, "INVALID_BASE_URL", "The base URL must be http(s), without credentials, query or fragment.");
  }
  if ((mode === "web" && (url.protocol !== "https:" || isPrivateOrReservedHost(url.hostname)))
      || (mode === "desktop" && url.protocol === "http:" && !isLoopbackHost(url.hostname))) {
    throw new HttpError(400, "INVALID_BASE_URL", "This provider destination is not allowed.");
  }
  const path = url.pathname.replace(/\/+$/, "");
  if (!path) throw new HttpError(400, "INVALID_BASE_URL", "Include the API prefix, for example https://api.deepseek.com/v1.");
  return url.origin + path;
}

export function createPublicLookup(lookupImpl = lookup) {
  return (hostname, options, callback) => {
    lookupImpl(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error) return callback(error);
      if (!addresses?.length || addresses.some(({ address }) => isPrivateOrReservedHost(address))) {
        return callback(new Error("Provider DNS resolved to a private or reserved address."));
      }
      const family = Number(options?.family) || 0;
      const eligible = addresses.filter((entry) => !family || entry.family === family);
      if (!eligible.length) return callback(new Error("No allowed provider address for this family."));
      // These exact addresses are passed to the socket; there is no second DNS lookup.
      if (options?.all) callback(null, eligible);
      else callback(null, eligible[0].address, eligible[0].family);
    });
  };
}

export function createProviderFetch({ mode = "web", lookupImpl = lookup } = {}) {
  return async (input, options = {}) => {
    const url = new URL(input);
    validateBaseUrl(url.href, { mode });
    return new Promise((resolve, reject) => {
      const transport = url.protocol === "https:" ? https : http;
      const request = transport.request(url, {
        method: options.method ?? "POST", headers: options.headers, signal: options.signal,
        agent: false, ...(mode === "web" ? { lookup: createPublicLookup(lookupImpl) } : {})
      }, (response) => {
        // Never follow redirects carrying a provider credential.
        if (response.statusCode >= 300 && response.statusCode < 400) {
          response.destroy();
          reject(new Error("Provider redirects are not allowed."));
          return;
        }
        const headers = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
        }
        try {
          const empty = response.statusCode === 204 || response.statusCode === 205;
          if (empty) response.resume();
          resolve(new Response(empty ? null : Readable.toWeb(response), { status: response.statusCode, headers }));
        } catch (error) {
          response.destroy();
          reject(error);
        }
      });
      request.on("error", reject);
      request.end(options.body);
    });
  };
}
