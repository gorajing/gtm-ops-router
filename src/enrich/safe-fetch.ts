import net from "node:net";
import dns from "node:dns";
import https from "node:https";
import http from "node:http";
import { URL } from "node:url";

function v4ToInt(ip: string): number | null {
  const p = ip.split(".");
  if (p.length !== 4) return null;
  let n = 0;
  for (const o of p) {
    if (!/^\d{1,3}$/.test(o)) return null;
    const v = Number(o);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n >>> 0;
}
function v4InCidr(n: number, baseStr: string, bits: number): boolean {
  const base = v4ToInt(baseStr)!;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (n & mask) === (base & mask);
}
// Covers the internal-SSRF threat (private / loopback / link-local / CGNAT)
// plus the IANA IPv4 special-purpose registry. The AS112/AMT entries
// (192.31.196/24, 192.52.193/24, 192.175.48/24) are public anycast — not
// internally reachable — and are listed only for registry fidelity.
const V4_BLOCKED: Array<[string, number]> = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.31.196.0", 24], ["192.52.193.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["192.175.48.0", 24], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
];
function isPublicV4(ip: string): boolean {
  const n = v4ToInt(ip);
  if (n === null) return false;
  if (n === 0xffffffff) return false;
  for (const [b, bits] of V4_BLOCKED) if (v4InCidr(n, b, bits)) return false;
  return true;
}
function parseV6(ip: string): number[] | null {
  if (net.isIP(ip) !== 6) return null;
  const z = ip.indexOf("%");
  if (z !== -1) ip = ip.slice(0, z);
  let v4tail: number[] | null = null;
  const lc = ip.lastIndexOf(":");
  const tail = ip.slice(lc + 1);
  if (tail.includes(".")) {
    const p = tail.split(".").map(Number);
    if (p.length === 4) { v4tail = [(p[0]! << 8) | p[1]!, (p[2]! << 8) | p[3]!]; ip = ip.slice(0, lc + 1); }
  }
  const halves = ip.split("::");
  const head = halves[0] ? halves[0].split(":").filter(Boolean).map((h) => parseInt(h, 16)) : [];
  let tl = halves.length > 1 && halves[1] ? halves[1].split(":").filter(Boolean).map((h) => parseInt(h, 16)) : [];
  if (v4tail) tl = tl.concat(v4tail);
  let hextets: number[];
  if (halves.length > 1) {
    const fill = 8 - (head.length + tl.length);
    hextets = [...head, ...Array(fill).fill(0), ...tl];
  } else hextets = head;
  return hextets.length === 8 ? hextets : null;
}
function mappedV4(h: number[]): string | null {
  if (h[0]! | h[1]! | h[2]! | h[3]! | h[4]!) return null;
  if (h[5]! !== 0xffff) return null;
  return `${(h[6]! >> 8) & 255}.${h[6]! & 255}.${(h[7]! >> 8) & 255}.${h[7]! & 255}`;
}
function isPublicV6(ip: string): boolean {
  const h = parseV6(ip);
  if (!h) return false;
  const m = mappedV4(h);
  if (m) return isPublicV4(m);
  if (h.every((x) => x === 0)) return false; // ::
  if (!(h[0]! | h[1]! | h[2]! | h[3]! | h[4]! | h[5]! | h[6]!) && h[7]! === 1) return false; // ::1
  // IPv4-compatible ::a.b.c.d (deprecated): top 96 bits zero, not :: / ::1 → unwrap+recheck
  if (!(h[0]! | h[1]! | h[2]! | h[3]! | h[4]! | h[5]!) && (h[6]! | h[7]!)) {
    return isPublicV4(`${(h[6]! >> 8) & 255}.${h[6]! & 255}.${(h[7]! >> 8) & 255}.${h[7]! & 255}`);
  }
  // Allow ONLY global unicast 2000::/3 (an allowlist, not a denylist). This
  // rejects ULA fc00::/7, link-local fe80::/10, multicast ff00::/8, discard
  // 100::/64, NAT64 64:ff9b::/96, and all unassigned space (4000::/3 and up) at once.
  if (h[0]! < 0x2000 || h[0]! > 0x3fff) return false;
  // Carve out special-purpose ranges that live INSIDE 2000::/3:
  if (h[0]! === 0x2001 && h[1]! < 0x0200) return false;        // 2001::/23 IETF protocol (teredo/benchmark/orchid)
  if (h[0]! === 0x2001 && h[1]! === 0x0db8) return false;       // 2001:db8::/32 documentation
  if (h[0]! === 0x2002) return false;                          // 2002::/16 6to4 (may embed private v4)
  if (h[0]! === 0x3fff && (h[1]! & 0xf000) === 0) return false; // 3fff::/20 documentation
  if (h[0]! === 0x2620 && h[1]! === 0x004f && h[2]! === 0x8000) return false; // 2620:4f:8000::/48 AS112-v6
  return true;
}
export function isPublicUnicastIp(ip: string): boolean {
  const fam = net.isIP(ip);
  if (fam === 4) return isPublicV4(ip);
  if (fam === 6) return isPublicV6(ip);
  return false;
}

export interface SafeFetchResult {
  status: number;
  contentType: string;
  headers: string; // joined "k: v\n…" — used for tech detection (Server, X-Powered-By, …)
  text: string;    // RAW body (not stripped) so tech markers in <script src> survive
}

async function resolveAllPublic(hostname: string): Promise<dns.LookupAddress[]> {
  const fam = net.isIP(hostname);
  if (fam) {
    if (!isPublicUnicastIp(hostname)) throw new Error(`blocked IP literal: ${hostname}`);
    return [{ address: hostname, family: fam }];
  }
  const recs = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  if (recs.length === 0) throw new Error(`no DNS records for ${hostname}`);
  for (const r of recs) {
    if (!isPublicUnicastIp(r.address)) throw new Error(`blocked resolved IP ${r.address} for ${hostname}`);
  }
  return recs;
}

/** SSRF-safe GET: validates ALL resolved IPs, pins one for the connection (no
 *  TOCTOU re-resolve), re-validates every redirect hop, caps redirects/time/bytes. */
export async function safeFetch(
  urlString: string,
  { maxRedirects = 3, timeoutMs = 8000, maxBytes = 512 * 1024 }: { maxRedirects?: number; timeoutMs?: number; maxBytes?: number } = {},
): Promise<SafeFetchResult> {
  let current = new URL(urlString);
  for (let hop = 0; ; hop++) {
    if (current.protocol !== "https:" && current.protocol !== "http:") {
      throw new Error(`disallowed protocol: ${current.protocol}`);
    }
    const recs = await resolveAllPublic(current.hostname);
    const pin = (recs.find((r) => r.family === 4) ?? recs[0])!;
    const lib = current.protocol === "https:" ? https : http;
    const cur = current;
    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = lib.request(
        {
          protocol: cur.protocol,
          hostname: cur.hostname,
          servername: cur.hostname, // TLS SNI/cert bound to the name, not the pinned IP
          port: cur.port || (cur.protocol === "https:" ? 443 : 80),
          path: (cur.pathname || "/") + cur.search,
          method: "GET",
          lookup: (_host: string, opts: dns.LookupOptions, cb: (e: Error | null, a: string | dns.LookupAddress[], f?: number) => void) =>
            opts && opts.all
              ? cb(null, [{ address: pin.address, family: pin.family }])
              : cb(null, pin.address, pin.family),
          headers: { host: cur.host, accept: "text/html, text/*" },
        },
        resolve,
      );
      req.on("error", reject);
      req.setTimeout(timeoutMs, () => req.destroy(new Error("request timeout")));
      req.end();
    });
    if ([301, 302, 303, 307, 308].includes(res.statusCode ?? 0) && res.headers.location) {
      res.resume();
      if (hop >= maxRedirects) throw new Error("too many redirects");
      current = new URL(res.headers.location, current);
      continue;
    }
    const contentType = String(res.headers["content-type"] ?? "");
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const c of res) {
      total += (c as Buffer).length;
      if (total > maxBytes) { res.destroy(); throw new Error(`body exceeds ${maxBytes} bytes`); }
      chunks.push(c as Buffer);
    }
    const headers = Object.entries(res.headers)
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(",") : v ?? ""}`)
      .join("\n");
    return { status: res.statusCode ?? 0, contentType, headers, text: Buffer.concat(chunks).toString("utf8") };
  }
}
