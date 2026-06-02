import { ENRICHMENT_FACT_MIN_CONFIDENCE } from "../constants.js";
import type { Enrichment } from "../types.js";

export interface Coverage { homepage: boolean; dns: boolean; tech: boolean; }
export type FieldBasis = "evidence" | "inference" | "unknown";
export interface Field<T> { value: T | null; basis: FieldBasis; }
export interface LlmFirmographics {
  employees: Field<number>;
  industry: Field<string>;
  regulated: Field<boolean>;
  techSignals: string[];
  selfConfidence: number;
}

/** Ceiling is a pure function of COLLECTOR coverage — never the model's claims.
 *  No homepage and no DNS → 0.15 (strictly below the 0.2 gate → forced quarantine). */
export function evidenceCeiling(c: Coverage): number {
  if (!c.homepage && !c.dns) return 0.15;
  let ceiling = 0.5; // some evidence
  if (c.homepage) ceiling += 0.25;
  if (c.dns) ceiling += 0.05;
  if (c.tech) ceiling += 0.05;
  return Math.min(ceiling, 0.9);
}

/** Clamp the model to the code ceiling and enforce routing-critical completeness.
 *  Returns null (→ quarantine) when employees/industry/regulated can't be grounded. */
export function resolveEnrichment(f: LlmFirmographics, c: Coverage): Enrichment | null {
  if (f.employees.basis === "unknown" || f.employees.value === null) return null;
  if (f.industry.basis === "unknown" || f.industry.value === null || f.industry.value.trim() === "") return null;
  if (f.regulated.basis === "unknown" || f.regulated.value === null) return null;
  const self = Number.isFinite(f.selfConfidence) ? Math.max(0, Math.min(1, f.selfConfidence)) : 0;
  const confidence = Math.min(self, evidenceCeiling(c));
  return {
    employees: f.employees.value,
    industry: f.industry.value,
    techSignals: f.techSignals,
    regulated: f.regulated.value,
    confidence,
  };
}

export { ENRICHMENT_FACT_MIN_CONFIDENCE };
