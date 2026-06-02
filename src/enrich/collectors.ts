import dns from "node:dns";
import net from "node:net";
import { safeFetch, type SafeFetchResult } from "./safe-fetch.js";

// Injection seam for tests ONLY. Production callers (defaultCollectors) use the
// SSRF-safe default; never pass a non-safe fetcher from production code.
export type Fetcher = (url: string) => Promise<SafeFetchResult>;
const defaultFetcher: Fetcher = (url) => safeFetch(url);

export interface HomepageSignal { title: string | null; description: string | null; textExcerpt: string; }
export interface DnsSignal { mx: string[]; txt: string[]; hasAddress: boolean; }
export interface EvidenceBundle {
  domain: string | null;
  homepage: HomepageSignal | null;
  dns: DnsSignal | null;
  techSignals: string[];
}

export function isFetchableHostname(domain: string | undefined): domain is string {
  if (!domain) return false;
  const host = domain.trim().toLowerCase();
  if (!host || net.isIP(host)) return false; // only real hostnames; IP literals go through safeFetch's own guard anyway
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(host);
}

function stripTags(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

/** Fetch the homepage RAW (fail-soft). null on any failure OR when there is no
 *  real domain — the company-name fallback is NEVER a fetch target. The raw body
 *  is needed for tech detection (markers live in <script src>), so callers parse
 *  the LLM-facing signal and run tech detection from the SAME raw result. */
export async function fetchHomepageRaw(domain: string | undefined, fetcher: Fetcher = defaultFetcher): Promise<SafeFetchResult | null> {
  if (!isFetchableHostname(domain)) return null;
  try {
    const res = await fetcher(`https://${domain}`);
    // 2xx only — a final non-2xx (incl. a 3xx safeFetch did not follow) is not a usable homepage.
    if (res.status < 200 || res.status >= 300 || !/text\/html|text\//i.test(res.contentType)) return null;
    return res;
  } catch {
    return null;
  }
}

/** Pure: derive the LLM-facing homepage signal. textExcerpt is script-stripped
 *  (clean data for the prompt) — tech detection runs on the RAW html, not this. */
export function parseHomepage(html: string): HomepageSignal {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? null;
  const description = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)?.[1]?.trim() ?? null;
  return { title, description, textExcerpt: stripTags(html).slice(0, 2000) };
}

export async function collectDns(domain: string | undefined): Promise<DnsSignal | null> {
  if (!isFetchableHostname(domain)) return null;
  try {
    const [mx, txt, addrs] = await Promise.all([
      dns.promises.resolveMx(domain).catch(() => []),
      dns.promises.resolveTxt(domain).catch(() => []),
      dns.promises.lookup(domain, { all: true }).catch(() => []),
    ]);
    if (mx.length === 0 && txt.length === 0 && addrs.length === 0) return null;
    return { mx: mx.map((m) => m.exchange), txt: txt.map((t) => t.join("")), hasAddress: addrs.length > 0 };
  } catch {
    return null;
  }
}

const TECH_MARKERS: Array<[string, RegExp]> = [
  ["hubspot", /hs-scripts\.com|hubspot/i], ["salesforce", /salesforce|force\.com/i],
  ["twilio", /twilio/i], ["zendesk", /zendesk|zdassets/i], ["intercom", /intercom/i],
  ["segment", /segment\.com|cdn\.segment/i], ["marketo", /marketo/i], ["aircall", /aircall/i],
  ["genesys", /genesys/i], ["gong", /gong\.io/i],
];
/** Run on RAW html + the header string — markers live in <script src>/headers, which
 *  the stripped excerpt removes. */
export function collectTech(rawHtml: string, headers: string): string[] {
  const hay = `${rawHtml}\n${headers}`;
  return TECH_MARKERS.filter(([, re]) => re.test(hay)).map(([name]) => name);
}
