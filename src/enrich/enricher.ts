/**
 * Stage 2 — Enrich. Pluggable by design.
 *
 * The `Enricher` interface is the seam where a real provider (Apollo,
 * Clearbit, an internal data warehouse) drops in. The shipped implementation
 * is a deterministic fixture so the demo is reproducible and needs no API
 * keys — but the seam proves the system is API-ready, not a toy.
 *
 * Critical failure-mode decision: an unknown company returns `null`. We do
 * NOT fabricate firmographics. A guessed enrichment is worse than a known
 * gap — it silently corrupts every downstream score. Unresolved -> quarantine.
 */

import type {
  Deal,
  Enrichment,
  ProviderObservationProvider,
} from "../types.js";

export interface Enricher {
  readonly name: ProviderObservationProvider;
  enrich(deal: Deal): Promise<Enrichment | null>;
}

export interface FixtureEntry extends Enrichment {
  /** Simulate provider failure modes for the failure-path tests/demo. */
  simulate?: "timeout";
}

export function enrichmentSubjectKey(deal: Deal): string {
  return (deal.domain ?? deal.company).trim().toLowerCase();
}

export class FixtureEnricher implements Enricher {
  readonly name = "fixture";
  constructor(private readonly fixture: Record<string, FixtureEntry>) {}

  async enrich(deal: Deal): Promise<Enrichment | null> {
    const entry = this.fixture[enrichmentSubjectKey(deal)];
    if (!entry) return null; // unknown company — caller quarantines, no guess
    if (entry.simulate === "timeout") {
      throw new Error(
        `enrichment provider timeout for ${enrichmentSubjectKey(deal)}`,
      );
    }
    return {
      employees: entry.employees,
      industry: entry.industry,
      techSignals: entry.techSignals,
      regulated: entry.regulated,
      confidence: entry.confidence,
    };
  }
}

/*
 * Production seam (not shipped — no secrets in a public artifact):
 *
 *   export class ApolloEnricher implements Enricher {
 *     readonly name = "apollo";
 *     async enrich(deal: Deal): Promise<Enrichment | null> {
 *       const res = await fetch(...);            // timeout + retry budget here
 *       if (res.status === 404) return null;     // unknown -> quarantine
 *       ... map provider response to Enrichment, set confidence from match score
 *     }
 *   }
 *
 * The pipeline does not change when you swap enrichers — that is the point
 * of the interface (single responsibility; evergreen-grade modularity). One
 * coupling to know: `Enricher.name` is typed as `ProviderObservationProvider`,
 * so adding a brand-new provider also means registering it in that enum in
 * types.ts (it keeps the evidence ledger's provider taxonomy closed and typed).
 */
