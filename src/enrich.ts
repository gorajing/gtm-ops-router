// Back-compat shim. The enrichment seam now lives in src/enrich/*.
export * from "./enrich/enricher.js";
export { makeEnricher } from "./enrich/index.js";
