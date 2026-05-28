import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SAMPLE = fileURLToPath(
  new URL("../data/sales-handoff.sample.json", import.meta.url),
);

describe("committed sales-handoff sample", () => {
  const doc = JSON.parse(readFileSync(SAMPLE, "utf8")) as Record<string, unknown>;

  it("matches the v1 contract envelope", () => {
    expect(doc.schemaVersion).toBe("gtm-ops-router.sales-handoff.v1");
    expect(Array.isArray(doc.accounts)).toBe(true);
    expect((doc.accounts as unknown[]).length).toBeGreaterThan(0);
  });

  it("every account carries the cross-repo trace key and a research seed", () => {
    for (const a of doc.accounts as Array<Record<string, any>>) {
      expect(typeof a.routerDealId).toBe("string");
      expect(a.routerDealId.length).toBeGreaterThan(0);
      expect(a.account?.name).toBeTruthy();
      expect(a.salesToolInput?.researchBrief).toBeTruthy();
      expect(Array.isArray(a.salesToolInput?.suggestedEvidenceQuestions)).toBe(true);
    }
  });

  it("is a research seed, not verified evidence (invariant)", () => {
    // The sample must not carry anything that could be mistaken for verified
    // evidence rows; Sales must derive those itself.
    expect("evidence" in doc).toBe(false);
    for (const a of doc.accounts as Array<Record<string, any>>) {
      expect("evidence" in a).toBe(false);
    }
  });

  it("is an internally consistent snapshot (no timestamp inversions)", () => {
    // generatedAt is set when the export runs, which is AFTER the pipeline that
    // produced the observed/updated values. Inversions usually mean someone
    // hand-pinned generatedAt without normalizing the inner timestamps too.
    const gen = new Date(doc.generatedAt as string).getTime();
    expect(Number.isFinite(gen)).toBe(true);
    for (const a of doc.accounts as Array<Record<string, any>>) {
      const obs = a.enrichmentEvidence?.observedAt;
      if (typeof obs === "string") {
        expect(new Date(obs).getTime()).toBeLessThanOrEqual(gen);
      }
      const upd = a.workflow?.deploymentReadiness?.updatedAt;
      if (typeof upd === "string") {
        expect(new Date(upd).getTime()).toBeLessThanOrEqual(gen);
      }
    }
  });
});
