import type { Settings } from "../config/settings";
import { getSharedUsageStore } from "../portable/usageStore";
import { planChangePoints } from "../pricing/plan-cost";
import { generateUsageReport, portableReadRange } from "../reports/reportService";
import type { ReportRequest } from "../reports/types";
import { rendererIpc } from "./rendererSecurity";

const PORTABLE_DATA_PREPARING = { portableDataPreparing: true } as const;

/** Register report queries with the same readiness and sender guards as the dashboard. */
export function registerReportIpc(isReady: () => Promise<boolean>, runtimeSettings: () => Promise<Settings>): void {


    rendererIpc.handle("reports:get", async (_, request: ReportRequest) => {
      if (!await isReady()) return PORTABLE_DATA_PREPARING;
      const settings = await runtimeSettings();
      const report = await generateUsageReport({ ...request, source: "portable" }, { settings });
      const sinceDay = request.since ?? report.rows[0]?.bucket?.slice(0, 10);
      const untilDay = request.until ?? new Date().toISOString().slice(0, 10);
      const planChanges = (sinceDay && untilDay) ? [
        ...planChangePoints(settings.plans, "claude", sinceDay, untilDay),
        ...planChangePoints(settings.plans, "codex",  sinceDay, untilDay),
      ] : [];
      return { ...report, planChanges };
    });


    // The analytics tab needs the same time range split by provider. Asking
    // twice re-reads and re-adapts the whole range for each call; reading the
    // events once and building both reports from them is several times faster.
    rendererIpc.handle("reports:get-batch", async (_, request: ReportRequest & { providers?: unknown }) => {
      if (!await isReady()) return PORTABLE_DATA_PREPARING;
      const settings = await runtimeSettings();
      const providers = Array.isArray(request.providers)
        ? request.providers.filter((item): item is "claude" | "codex" => item === "claude" || item === "codex")
        : ["claude", "codex"] as const;
      const { providers: _ignored, ...base } = request;
      const range = portableReadRange(base.since, base.until);
      const usageEvents = await getSharedUsageStore().read(range);
      const reports = await Promise.all(providers.map((provider) => generateUsageReport(
        { ...base, provider, source: "portable" },
        { settings, usageEvents },
      )));
      return Object.fromEntries(providers.map((provider, index) => [provider, reports[index]]));
    });
}
