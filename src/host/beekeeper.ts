/**
 * Everything the optimizer needs from Beekeeper Studio, in one place.
 * Keeping the plugin API behind this module keeps the rest of the code
 * testable and makes the host easy to fake in the dev harness.
 */
import {
  appStorage,
  clipboard,
  getAppInfo,
  getConnectionInfo,
  getViewContext,
  getViewState,
  noty,
  openExternal,
  openTab,
  runQuery,
  setTabTitle,
  setViewState,
  type ConnectionInfo,
  type PluginViewContext,
} from "@beekeeperstudio/plugin";
import type { QueryRunner, Row } from "@/core/types";
import { errorMessage } from "@/core/format";

async function queryMulti(sql: string): Promise<Row[][]> {
  const res = await runQuery(sql);
  if (res.error) throw new Error(errorMessage(res.error));
  return res.results.map((r) => (r.rows ?? []) as Row[]);
}

export const runner: QueryRunner = {
  async query<T = Row>(sql: string): Promise<T[]> {
    const results = await queryMulti(sql);
    return (results[results.length - 1] ?? []) as T[];
  },
  queryMulti,
};

export type { ConnectionInfo };

export async function connectionInfo(): Promise<ConnectionInfo> {
  return getConnectionInfo();
}

export async function themeCss(): Promise<string | null> {
  try {
    return (await getAppInfo()).theme.cssString;
  } catch {
    // Beekeeper Studio < 5.4 doesn't share its theme.
    return null;
  }
}

export interface EditorContext {
  command: string;
  /** Query text from the editor context menu, when opened from there. */
  sql?: string;
}

export async function viewContext(): Promise<EditorContext> {
  try {
    const ctx = (await getViewContext()) as PluginViewContext & {
      params?: { selectedText?: string; selectedQuery?: string; text?: string };
    };
    const p = ctx?.params as { selectedText?: string; selectedQuery?: string; text?: string } | undefined;
    const sql = p?.selectedText?.trim() || p?.selectedQuery?.trim() || p?.text?.trim() || undefined;
    return { command: ctx?.command ?? "", sql };
  } catch {
    return { command: "" };
  }
}

export async function openInEditor(sql: string): Promise<void> {
  await openTab("query", { query: sql });
}

export async function openTable(table: string, schema?: string): Promise<void> {
  await openTab("tableStructure", { table, schema });
}

export async function copy(text: string): Promise<void> {
  await clipboard.writeText(text);
  await noty.success("Copied to clipboard");
}

export async function notifyError(message: string): Promise<void> {
  await noty.error(message);
}

export async function openLink(url: string): Promise<void> {
  await openExternal(url);
}

export async function setTitle(title: string): Promise<void> {
  await setTabTitle(title).catch(() => undefined);
}

export async function loadItem<T>(key: string): Promise<T | null> {
  try {
    return await appStorage.getItem<T>(key);
  } catch {
    return null;
  }
}

export async function saveItem<T>(key: string, value: T): Promise<void> {
  await appStorage.setItem(key, value).catch(() => undefined);
}

export async function loadViewState<T>(): Promise<T | null> {
  try {
    return (await getViewState<T>()) ?? null;
  } catch {
    return null;
  }
}

export async function saveViewState<T>(state: T): Promise<void> {
  await setViewState(state).catch(() => undefined);
}
