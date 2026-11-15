interface QuotaBarRendererCore {
  ipc: import("../../shared/rendererIpc").RendererIpc;
  isPortableDataPreparing(value: unknown): value is import("../../shared/rendererIpc").PortableDataPreparing;
  createAnalyticsData(limit?: number): import("../../shared/rendererIpc").AnalyticsDataController;
  schedulePortableDataRetry(key: string, retry: () => unknown): void;
  clearPortableDataRetry(key: string): void;
}
interface Window {
  QB: QuotaBarRendererCore;
  __QB_IPC_BRIDGE__?: import("../../shared/rendererIpc").RendererIpc;
}
declare const QB: QuotaBarRendererCore;
