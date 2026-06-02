// Live smoke for the grounded LLM enricher. Manual only (requires a real key);
// NOT part of CI. Uses enrichWithGate (not raw enrich) so the output mirrors the
// pipeline's REAL routing decision: low-confidence / null are quarantined, not
// printed as success.
//
//   ANTHROPIC_API_KEY=sk-... npx tsx scripts/enrich-smoke.ts stripe.com somenonexistentco.invalid
import { enrichWithGate } from "../src/pipeline.js";
import { makeEnricher } from "../src/enrich/index.js";
import type { Deal } from "../src/types.js";

const domains = process.argv.slice(2);
if (domains.length === 0) {
  console.error("usage: ANTHROPIC_API_KEY=... tsx scripts/enrich-smoke.ts <domain> [domain...]");
  process.exit(2);
}
// Match makeEnricher's condition exactly — a whitespace-only key would otherwise
// pass this guard but fall back to the fixture enricher, silently running non-live.
if (!process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY.trim() === "") {
  console.error("ANTHROPIC_API_KEY required for live smoke (without it makeEnricher returns the fixture enricher)");
  process.exit(2);
}

const enricher = makeEnricher(process.env);
for (const domain of domains) {
  const deal = { id: `D-${domain}`, company: domain, domain } as unknown as Deal;
  const r = await enrichWithGate(deal, enricher); // catches provider errors internally → quarantine
  if (r.ok) console.log(`${domain}: ROUTE       ${JSON.stringify(r.enrichment)}`);
  else console.log(`${domain}: QUARANTINE  [${r.code}] ${r.reason}`);
}
