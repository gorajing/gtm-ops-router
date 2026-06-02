import { describe, it, expect } from "vitest";
import { fetchHomepageRaw, parseHomepage, collectTech, type Fetcher } from "../src/enrich/collectors.js";

const html = `<html><head><title>Acme Freight</title><meta name="description" content="3PL logistics"></head>
  <body>We are a freight brokerage. <script src="https://js.hs-scripts.com/x.js"></script> twilio</body></html>`;
const okFetch: Fetcher = async () => ({ status: 200, contentType: "text/html", headers: "server: nginx", text: html });

describe("fetchHomepageRaw", () => {
  it("returns the RAW result (scripts intact) for a valid domain", async () => {
    const raw = await fetchHomepageRaw("acme.example", okFetch);
    expect(raw?.text).toContain("hs-scripts");
  });
  it("returns null (no throw) when the fetch fails", async () => {
    expect(await fetchHomepageRaw("acme.example", async () => { throw new Error("blocked"); })).toBeNull();
  });
  it("returns null and does NOT fetch when domain is absent (never the company-name fallback)", async () => {
    let called = false;
    const raw = await fetchHomepageRaw(undefined, async () => { called = true; return { status: 200, contentType: "", headers: "", text: "" }; });
    expect(raw).toBeNull();
    expect(called).toBe(false);
  });
  it("returns null on a non-2xx final response (e.g. a 3xx safeFetch did not follow)", async () => {
    const raw = await fetchHomepageRaw("acme.example", async () => ({ status: 304, contentType: "text/html", headers: "", text: "" }));
    expect(raw).toBeNull();
  });
});

describe("parseHomepage", () => {
  it("extracts title/description and a script-stripped excerpt (the LLM-facing data)", () => {
    const sig = parseHomepage(html);
    expect(sig.title).toBe("Acme Freight");
    expect(sig.description).toContain("3PL");
    expect(sig.textExcerpt).toContain("freight brokerage");
    expect(sig.textExcerpt).not.toContain("hs-scripts"); // excerpt is clean
  });
});

describe("collectTech", () => {
  it("detects markers from RAW html + headers (not the stripped excerpt)", () => {
    expect(collectTech(html, "server: nginx")).toEqual(expect.arrayContaining(["hubspot", "twilio"]));
  });
  it("returns [] when nothing matches", () => {
    expect(collectTech("<html></html>", "")).toEqual([]);
  });
});
