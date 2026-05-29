/**
 * Reverse contract: sales.engagement-feedback.v1
 *
 * Mirrors the forward gtm-ops-router.sales-handoff.v1 envelope shape.
 * Uses Zod with .passthrough() on every object for forward-compatibility —
 * unknown fields from future schema versions survive the parse boundary.
 *
 * Timestamp rule (mirrors assertCanonicalIsoUtc in store.ts):
 *   Every occurredAt / asOf / meetingAt / generatedAt must match
 *   /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/ AND round-trip through
 *   new Date(value).toISOString() === value.
 */

import { z } from "zod";

export const ENGAGEMENT_FEEDBACK_SCHEMA_VERSION =
  "sales.engagement-feedback.v1" as const;

// ── Strict canonical-UTC validator (mirrors store.ts CANONICAL_ISO_UTC) ──────
const CANONICAL_ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const CanonicalUtcString = z.string().superRefine((value, ctx) => {
  if (!CANONICAL_ISO_UTC.test(value)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `must be canonical UTC ISO timestamp (YYYY-MM-DDTHH:mm:ss.sssZ), got: ${value}`,
    });
    return;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `must be canonical UTC ISO timestamp (round-trip failed), got: ${value}`,
    });
  }
});

// ── EngagementEvent — five discriminated variants ─────────────────────────────
//
// Each variant uses .passthrough() so unknown vendor fields survive the parse
// boundary without breaking older versions of the router.
//
// Note: "delivered" is intentionally absent — no real provider receipt = fake
// precision (spec §4.2).

const SentEventSchema = z
  .object({
    kind: z.literal("sent"),
    eventId: z.string().min(1),
    occurredAt: CanonicalUtcString,
    touchId: z.string().min(1),
    channel: z.enum(["email", "linkedin"]),
  })
  .passthrough();

const RepliedEventSchema = z
  .object({
    kind: z.literal("replied"),
    eventId: z.string().min(1),
    occurredAt: CanonicalUtcString,
    touchId: z.string().min(1),
    replyIntent: z.enum(["positive", "neutral", "negative"]),
  })
  .passthrough();

const MeetingBookedEventSchema = z
  .object({
    kind: z.literal("meeting_booked"),
    eventId: z.string().min(1),
    occurredAt: CanonicalUtcString,
    touchId: z.string().min(1),
    meetingAt: CanonicalUtcString,
  })
  .passthrough();

const BouncedEventSchema = z
  .object({
    kind: z.literal("bounced"),
    eventId: z.string().min(1),
    occurredAt: CanonicalUtcString,
    touchId: z.string().min(1),
    reason: z.string().min(1),
  })
  .passthrough();

// no_response is derived — `derived: true` is a type-level honesty marker
// (spec D4). Only the window evaluator emits this kind.
const NoResponseEventSchema = z
  .object({
    kind: z.literal("no_response"),
    eventId: z.string().min(1),
    occurredAt: CanonicalUtcString,
    asOf: CanonicalUtcString,
    windowDays: z.number().int().positive(),
    lastTouchId: z.string().min(1),
    derived: z.literal(true),
  })
  .passthrough();

const EngagementEventSchema = z.discriminatedUnion("kind", [
  SentEventSchema,
  RepliedEventSchema,
  MeetingBookedEventSchema,
  BouncedEventSchema,
  NoResponseEventSchema,
]);

// ── CommercialSignal — separate seam, non-authoritative (spec D5) ─────────────
const CommercialSignalSchema = z
  .object({
    kind: z.literal("opportunity_created"),
    eventId: z.string().min(1),
    occurredAt: CanonicalUtcString,
    amountUsd: z.number().nullable(),
    crmRef: z.string().nullable(),
  })
  .passthrough();

// ── Deal envelope ─────────────────────────────────────────────────────────────
const EngagementFeedbackDealSchema = z
  .object({
    routerDealId: z.string().min(1),
    trace: z
      .object({
        sourceSystem: z.literal("sales"),
        boundary: z.literal("observed_engagement_not_router_truth"),
      })
      .passthrough(),
    events: z.array(EngagementEventSchema),
    commercialSignals: z.array(CommercialSignalSchema).optional(),
  })
  .passthrough();

// ── Top-level envelope ────────────────────────────────────────────────────────
const EngagementFeedbackSchema = z
  .object({
    schemaVersion: z.literal(ENGAGEMENT_FEEDBACK_SCHEMA_VERSION),
    generatedAt: CanonicalUtcString,
    source: z
      .object({
        system: z.literal("sales"),
        purpose: z.string().min(1),
      })
      .passthrough(),
    coverage: z
      .object({
        complete: z.boolean(),
        scanned: z.number().int().nonnegative(),
        emitted: z.number().int().nonnegative(),
        since: CanonicalUtcString.nullable(),
      })
      .passthrough(),
    deals: z.array(EngagementFeedbackDealSchema),
  })
  .passthrough();

// ── Exported types (inferred from schemas so they stay in sync) ───────────────
export type EngagementEvent = z.infer<typeof EngagementEventSchema>;
export type CommercialSignal = z.infer<typeof CommercialSignalSchema>;
export type EngagementFeedbackDeal = z.infer<
  typeof EngagementFeedbackDealSchema
>;
export type EngagementFeedback = z.infer<typeof EngagementFeedbackSchema>;

// ── Parser ────────────────────────────────────────────────────────────────────
/**
 * Parse and validate a raw unknown value as an EngagementFeedback payload.
 *
 * Throws a ZodError on validation failure. Never returns partial data.
 * Uses .passthrough() throughout so unknown fields from future schema versions
 * are preserved (forward-compat).
 */
export function parseEngagementFeedback(raw: unknown): EngagementFeedback {
  return EngagementFeedbackSchema.parse(raw);
}

// ── Exhaustiveness helper (mirrors pattern in store.ts / route.ts) ────────────
// Callers that switch on EngagementEvent["kind"] can import this to guarantee
// compile-time exhaustiveness.
export function exhaustiveEngagementEvent(x: never): never {
  throw new Error(`Unhandled EngagementEvent kind: ${JSON.stringify(x)}`);
}
