export interface UpdateUiState {
  status: "disabled" | "idle" | "checking" | "available" | "downloading" | "ready" | "error";
  currentVersion: string;
  newVersion: string | null;
  downloadPercent: number;
  error: string | null;
}

export type UpdateEvent =
  | { type: "checking" }
  | { type: "available"; version: string }
  | { type: "not-available" }
  | { type: "progress"; percent: number }
  | { type: "downloaded"; version: string }
  | { type: "error"; message: string };

export function initialUpdateState(currentVersion: string, enabled: boolean): UpdateUiState {
  return {
    status: enabled ? "idle" : "disabled",
    currentVersion,
    newVersion: null,
    downloadPercent: 0,
    error: null,
  };
}

export function reduceUpdateState(state: UpdateUiState, event: UpdateEvent): UpdateUiState {
  // Im Dev-Build (disabled) ignorieren wir alle Events.
  if (state.status === "disabled") return state;

  switch (event.type) {
    case "checking":
      return { ...state, status: "checking", error: null };
    case "available":
      return { ...state, status: "available", newVersion: event.version, error: null };
    case "not-available":
      return { ...state, status: "idle", newVersion: null };
    case "progress":
      return { ...state, status: "downloading", downloadPercent: Math.round(event.percent) };
    case "downloaded":
      return { ...state, status: "ready", newVersion: event.version, downloadPercent: 100 };
    case "error":
      return { ...state, status: "error", error: event.message };
    default:
      return state;
  }
}
