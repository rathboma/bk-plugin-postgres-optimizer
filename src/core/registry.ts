import type { BaseEnvironment, DatabaseAdapter } from "./types";
import { postgresAdapter } from "@/adapters/postgres";

/**
 * Adapters available to the UI. To support another engine, implement
 * `DatabaseAdapter` for it and add it here.
 */
const adapters: DatabaseAdapter<BaseEnvironment>[] = [
  postgresAdapter as unknown as DatabaseAdapter<BaseEnvironment>,
];

export function findAdapter(databaseType: string): DatabaseAdapter<BaseEnvironment> | null {
  return adapters.find((a) => a.databaseTypes.includes(databaseType)) ?? null;
}

export function supportedEngines(): string[] {
  return adapters.map((a) => a.name);
}
