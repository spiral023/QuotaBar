import type { RendererIpc } from "../../src/shared/rendererIpc";

/** Compile-only contract checks; this function must never contact Electron. */
export async function checkRendererIpcTypes(ipc: RendererIpc): Promise<void> {
  await ipc.invoke("analytics:get", { since: "2026-01-01", timeZone: "UTC" });
  // @ts-expect-error Unknown privileged channels must fail typechecking.
  await ipc.invoke("arbitrary:channel");
  // @ts-expect-error Dates are ISO date strings, not numbers.
  await ipc.invoke("analytics:get", { since: 42 });
  const settings = await ipc.invoke("settings:get");
  // @ts-expect-error Typed responses must reject nonexistent fields.
  void settings.nonexistentResponseField;
}
