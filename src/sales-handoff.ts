import { enrichmentSubjectKey } from "./enrich.js";
import type { Store } from "./store.js";
import type {
  AgentSuggestionRecord,
  DeploymentBlocker,
  DeploymentReadiness,
  ProviderObservationProvider,
  RoleQueueKind,
  RoleQueuePriority,
  RoutedDeal,
  SourceChannel,
  WorkItemStatus,
} from "./types.js";

export const SALES_HANDOFF_SCHEMA_VERSION = "gtm-ops-router.sales-handoff.v1";

export interface SalesHandoffExportOptions {
  generatedAt?: string;
  limit?: number;
  includeAllRoutes?: boolean;
  operatorBaseUrl?: string;
}

export interface SalesHandoffExport {
  schemaVersion: typeof SALES_HANDOFF_SCHEMA_VERSION;
  generatedAt: string;
  source: {
    system: "gtm-ops-router";
    purpose: "Seed evidence-grounded sales research and outreach.";
  };
  filters: {
    limit: number;
    includeAllRoutes: boolean;
  };
  accounts: SalesHandoffAccount[];
}

export interface SalesHandoffAccount {
  routerDealId: string;
  trace: {
    sourceSystem: "gtm-ops-router";
    evidenceBoundary: "research_seed_not_verified_evidence";
  };
  operatorLinks?: {
    consoleUrl: string;
    eventsUrl: string;
  };
  account: {
    name: string;
    domain: string | null;
    region: string;
    sourceChannel: SourceChannel;
  };
  contact: {
    name: string;
    email: string;
  };
  opportunity: {
    amountUsd: number;
    statedNeed: string;
    route: {
      kind: RoutedDeal["route"]["kind"];
      salesOwner: string | null;
      financeFlag: string | null;
      legalFlag: string | null;
      queue: string | null;
      reason: string | null;
      slaHours: number | null;
    };
    score: {
      total: number;
      notes: string[];
    };
  };
  workflow: {
    commercialState: string | null;
    deploymentReadiness: {
      readiness: DeploymentReadiness;
      blockerCode: DeploymentBlocker | null;
      reason: string | null;
      updatedAt: string;
    } | null;
    workItems: Array<{
      id: string;
      queue: RoleQueueKind;
      status: WorkItemStatus;
      priority: RoleQueuePriority;
      owner: string;
      title: string;
      description: string;
      dueAt: string | null;
      updatedAt: string;
    }>;
    agentSuggestions: Array<{
      id: string;
      kind: AgentSuggestionRecord["kind"];
      status: AgentSuggestionRecord["status"];
      title: string;
      body: string;
      rationale: string;
      decidedAt: string | null;
      decisionReason: string | null;
    }>;
  };
  enrichmentEvidence: {
    sourceProvider: ProviderObservationProvider;
    confidence: number;
    industry: string;
    employees: number;
    techSignals: string[];
    regulated: boolean;
    freshnessStatus: string;
    observedAt: string;
    sourceObservationId: string;
  } | null;
  salesToolInput: {
    accountName: string;
    accountDomain: string | null;
    researchBrief: string;
    suggestedEvidenceQuestions: string[];
  };
}

interface SalesHandoffStore {
  routed(limit?: number): RoutedDeal[];
  commercialState(dealId: string): { commercialState: string } | null;
  deploymentReadinessRecords(now?: string): Array<{
    dealId: string;
    readiness: DeploymentReadiness;
    blockerCode: DeploymentBlocker | null;
    reason: string | null;
    updatedAt: string;
  }>;
  workItems(limit?: number): Array<{
    id: string;
    dealId: string;
    queue: RoleQueueKind;
    status: WorkItemStatus;
    priority: RoleQueuePriority;
    owner: string;
    title: string;
    description: string;
    dueAt: string | null;
    updatedAt: string;
  }>;
  agentSuggestions(limit?: number): AgentSuggestionRecord[];
  enrichedSubjectFacts(
    subjectType: "company",
    subjectKey: string,
    now?: string,
  ): {
    sourceProvider: ProviderObservationProvider;
    confidence: number;
    industry: string;
    employees: number;
    techSignals: string[];
    regulated: boolean;
    freshnessStatus: string;
    observedAt: string;
    sourceObservationId: string;
  } | null;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return 25;
  if (!Number.isFinite(limit)) return 25;
  return Math.max(1, Math.min(250, Math.trunc(limit)));
}

function groupByDeal<T extends { dealId: string }>(rows: T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const existing = grouped.get(row.dealId);
    if (existing) existing.push(row);
    else grouped.set(row.dealId, [row]);
  }
  return grouped;
}

function routeSummary(deal: RoutedDeal): SalesHandoffAccount["opportunity"]["route"] {
  if (deal.route.kind === "human_assisted") {
    return {
      kind: deal.route.kind,
      salesOwner: deal.route.salesOwner,
      financeFlag: deal.route.financeFlag ?? null,
      legalFlag: deal.route.legalFlag ?? null,
      queue: null,
      reason: null,
      slaHours: deal.route.slaHours,
    };
  }
  if (deal.route.kind === "self_serve") {
    return {
      kind: deal.route.kind,
      salesOwner: null,
      financeFlag: null,
      legalFlag: null,
      queue: deal.route.queue,
      reason: null,
      slaHours: deal.route.slaHours,
    };
  }
  return {
    kind: deal.route.kind,
    salesOwner: null,
    financeFlag: null,
    legalFlag: null,
    queue: null,
    reason: deal.route.reason,
    slaHours: null,
  };
}

function researchBrief(deal: RoutedDeal, status: string | null): string {
  const flags =
    deal.route.kind === "human_assisted"
      ? [deal.route.financeFlag, deal.route.legalFlag].filter(Boolean).join(", ")
      : "";
  return [
    `${deal.company} entered the GTM router from ${deal.sourceChannel}.`,
    `Stated need: ${deal.statedNeed}.`,
    `Routed as ${deal.route.kind}${deal.route.kind === "human_assisted" ? ` to ${deal.route.salesOwner}` : ""}.`,
    flags ? `Review flags: ${flags}.` : "",
    status ? `Current workflow status: ${status}.` : "",
  ]
    .filter((part) => part.length > 0)
    .join(" ");
}

function suggestedEvidenceQuestions(deal: RoutedDeal): string[] {
  const questions = [
    `Find current public evidence that ${deal.company} has the operations pain described as: "${deal.statedNeed}".`,
    `Find buyer-relevant facts for ${deal.company}: scale, operating footprint, integrations, recent growth, or hiring signals.`,
  ];
  if (deal.route.kind === "human_assisted") {
    questions.push(
      `Find evidence that helps ${deal.route.salesOwner} tailor a first-touch or follow-up for a ${deal.dealUSD.toLocaleString("en-US")} USD opportunity.`,
    );
  }
  if (deal.route.kind === "human_assisted" && deal.route.legalFlag) {
    questions.push(
      "Find public regulatory, privacy, geography, or procurement context that could affect messaging or legal review.",
    );
  }
  if (deal.route.kind === "human_assisted" && deal.route.financeFlag) {
    questions.push(
      "Find value, ROI, urgency, or budget-context evidence that could support pricing approval.",
    );
  }
  return questions;
}

function normalizeOperatorBaseUrl(raw: string | undefined): string | null {
  if (raw === undefined || raw.trim().length === 0) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("--operator-base-url must be a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("--operator-base-url must use http or https");
  }
  if (!url.pathname.endsWith("/")) url.pathname = `${url.pathname}/`;
  return url.toString();
}

function operatorLinksForDeal(
  dealId: string,
  operatorBaseUrl: string | null,
): SalesHandoffAccount["operatorLinks"] {
  if (!operatorBaseUrl) return undefined;
  const encoded = encodeURIComponent(dealId);
  return {
    consoleUrl: new URL(`./?deal=${encoded}`, operatorBaseUrl).toString(),
    eventsUrl: new URL(`./deals/${encoded}/events`, operatorBaseUrl).toString(),
  };
}

export function buildSalesHandoffExport(
  store: SalesHandoffStore | Store,
  options: SalesHandoffExportOptions = {},
): SalesHandoffExport {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const limit = clampLimit(options.limit);
  const includeAllRoutes = options.includeAllRoutes === true;
  const operatorBaseUrl = normalizeOperatorBaseUrl(options.operatorBaseUrl);
  const scanLimit = includeAllRoutes ? limit : Math.min(1000, Math.max(100, limit * 5));
  const readinessByDeal = new Map(
    store
      .deploymentReadinessRecords(generatedAt)
      .map((record) => [record.dealId, record] as const),
  );
  const workItemsByDeal = groupByDeal(store.workItems(250));
  const suggestionsByDeal = groupByDeal(store.agentSuggestions(250));
  const accounts: SalesHandoffAccount[] = [];

  for (const deal of store.routed(scanLimit)) {
    if (!includeAllRoutes && deal.route.kind !== "human_assisted") continue;
    const commercial = store.commercialState(deal.id);
    const readiness = readinessByDeal.get(deal.id) ?? null;
    const workItems = workItemsByDeal.get(deal.id) ?? [];
    const agentSuggestions = suggestionsByDeal.get(deal.id) ?? [];
    const facts = store.enrichedSubjectFacts(
      "company",
      enrichmentSubjectKey(deal),
      generatedAt,
    );
    const latestStatus = workItems[0]?.status ?? readiness?.readiness ?? null;
    const operatorLinks = operatorLinksForDeal(deal.id, operatorBaseUrl);

    accounts.push({
      routerDealId: deal.id,
      trace: {
        sourceSystem: "gtm-ops-router",
        evidenceBoundary: "research_seed_not_verified_evidence",
      },
      ...(operatorLinks ? { operatorLinks } : {}),
      account: {
        name: deal.company,
        domain: deal.domain ?? null,
        region: deal.region,
        sourceChannel: deal.sourceChannel,
      },
      contact: {
        name: deal.contactName,
        email: deal.contactEmail,
      },
      opportunity: {
        amountUsd: deal.dealUSD,
        statedNeed: deal.statedNeed,
        route: routeSummary(deal),
        score: {
          total: deal.score.total,
          notes: deal.score.notes,
        },
      },
      workflow: {
        commercialState: commercial?.commercialState ?? null,
        deploymentReadiness: readiness
          ? {
              readiness: readiness.readiness,
              blockerCode: readiness.blockerCode,
              reason: readiness.reason,
              updatedAt: readiness.updatedAt,
            }
          : null,
        workItems: workItems.map((item) => ({
          id: item.id,
          queue: item.queue,
          status: item.status,
          priority: item.priority,
          owner: item.owner,
          title: item.title,
          description: item.description,
          dueAt: item.dueAt,
          updatedAt: item.updatedAt,
        })),
        agentSuggestions: agentSuggestions.map((suggestion) => ({
          id: suggestion.id,
          kind: suggestion.kind,
          status: suggestion.status,
          title: suggestion.title,
          body: suggestion.body,
          rationale: suggestion.rationale,
          decidedAt: suggestion.decidedAt,
          decisionReason: suggestion.decisionReason,
        })),
      },
      enrichmentEvidence: facts
        ? {
            sourceProvider: facts.sourceProvider,
            confidence: facts.confidence,
            industry: facts.industry,
            employees: facts.employees,
            techSignals: facts.techSignals,
            regulated: facts.regulated,
            freshnessStatus: facts.freshnessStatus,
            observedAt: facts.observedAt,
            sourceObservationId: facts.sourceObservationId,
          }
        : null,
      salesToolInput: {
        accountName: deal.company,
        accountDomain: deal.domain ?? null,
        researchBrief: researchBrief(deal, latestStatus),
        suggestedEvidenceQuestions: suggestedEvidenceQuestions(deal),
      },
    });

    if (accounts.length >= limit) break;
  }

  return {
    schemaVersion: SALES_HANDOFF_SCHEMA_VERSION,
    generatedAt,
    source: {
      system: "gtm-ops-router",
      purpose: "Seed evidence-grounded sales research and outreach.",
    },
    filters: { limit, includeAllRoutes },
    accounts,
  };
}
