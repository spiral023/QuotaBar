import type { Settings } from "../config/settings";
import type { AnalyticsData, AnalyticsSummary } from "../main/analyticsSummary";
import type { collectSystemData } from "../main/systemData";
import type { generateUsageReport } from "../reports/reportService";
import type { ReportRequest } from "../reports/types";
import type { eventChannels, invokeChannels, sendChannels } from "./ipcContract";

export interface PortableDataPreparing { portableDataPreparing: true }
export interface AnalyticsQuery { since?: string; until?: string; timeZone?: string }
type Report = Awaited<ReturnType<typeof generateUsageReport>>;
interface Requests {
  "analytics:get": { args: [query?: AnalyticsQuery]; result: AnalyticsData | PortableDataPreparing };
  "analytics:summary": { args: [query?: { costWindow?: "7d" | "30d" | "all" }]; result: AnalyticsSummary | PortableDataPreparing };
  "reports:get": { args: [query: ReportRequest]; result: Report | PortableDataPreparing };
  "reports:get-batch": { args: [query: ReportRequest & { providers?: Array<"claude" | "codex"> }]; result: Partial<Record<"claude" | "codex", Report>> | PortableDataPreparing };
  "settings:get": { args: []; result: Settings };
  "settings:save": { args: [settings: Partial<Settings>]; result: Settings };
  "system:get": { args: []; result: Awaited<ReturnType<typeof collectSystemData>> };
}
type InvokeChannel = typeof invokeChannels[number];
export type InvokeArgs<C extends InvokeChannel> = C extends keyof Requests ? Requests[C]["args"] : unknown[];
export type InvokeResult<C extends InvokeChannel> = C extends keyof Requests ? Requests[C]["result"] : unknown;
export interface RendererIpc {
  invoke<C extends InvokeChannel>(channel: C, ...args: InvokeArgs<C>): Promise<InvokeResult<C>>;
  on(channel: typeof eventChannels[number], listener: (payload: unknown) => void): () => void;
  send(channel: typeof sendChannels[number], ...args: unknown[]): void;
}
export interface AnalyticsDataController {
  has(query: AnalyticsQuery): boolean;
  load(query: AnalyticsQuery): Promise<AnalyticsData | PortableDataPreparing | undefined>;
  clear(): void;
}
