/**
 * Stage 1 — Intake. Validate at the boundary; never trust a raw record.
 *
 * Deterministic id: a stable hash of (company + email + dealUSD + need) so
 * re-ingesting the same logical deal is idempotent (no duplicate pipeline
 * runs) — data accuracy is enforced by construction, not by hope.
 */

import { createHash } from "node:crypto";
import { RawDealInput, type Deal } from "./types.js";

export type IntakeResult =
  | { ok: true; deal: Deal }
  | { ok: false; reason: string };

function stableId(input: RawDealInput): string {
  if (input.id) return input.id;
  const canonical = [
    input.company.trim().toLowerCase(),
    input.contactEmail.trim().toLowerCase(),
    Math.round(input.dealUSD),
    input.statedNeed.trim().toLowerCase(),
  ].join("|");
  return "D-" + createHash("sha1").update(canonical).digest("hex").slice(0, 12);
}

export function normalize(raw: unknown): IntakeResult {
  const parsed = RawDealInput.safeParse(raw);
  if (!parsed.success) {
    const reason = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return { ok: false, reason };
  }
  const v = parsed.data;
  return {
    ok: true,
    deal: {
      id: stableId(v),
      company: v.company.trim(),
      domain: v.domain?.trim() ?? null,
      contactName: v.contactName.trim(),
      contactEmail: v.contactEmail.trim().toLowerCase(),
      dealUSD: v.dealUSD,
      region: v.region,
      sourceChannel: v.sourceChannel,
      statedNeed: v.statedNeed.trim(),
    },
  };
}
