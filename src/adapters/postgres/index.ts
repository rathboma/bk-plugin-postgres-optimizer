import type { DatabaseAdapter } from "@/core/types";
import { configChecks } from "./checks/config";
import { connectionChecks } from "./checks/connections";
import { indexChecks } from "./checks/indexes";
import { indexSuggestions } from "./checks/indexSuggestions";
import { queryChecks } from "./checks/queries";
import { tableChecks } from "./checks/tables";
import type { PostgresEnvironment } from "./environment";
import { detectEnvironment } from "./environment";
import { explainQuery } from "./explain/explain";
import { topQueries } from "./queryStats";

export type { PostgresEnvironment } from "./environment";

export const postgresAdapter: DatabaseAdapter<PostgresEnvironment> = {
  id: "postgresql",
  name: "PostgreSQL",
  databaseTypes: ["postgresql"],
  detectEnvironment,
  checks: [
    ...queryChecks,
    indexSuggestions,
    ...indexChecks,
    ...tableChecks,
    ...configChecks,
    ...connectionChecks,
  ],
  topQueries,
  explain: explainQuery,
};
