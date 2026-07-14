let resolved = false;
let runId: string | undefined;

export function getRunId(): string | undefined {
  if (!resolved) {
    const value = process.env["KENECT_RUN_ID"]?.trim().slice(0, 128);
    runId = value ? value : undefined;
    resolved = true;
  }

  return runId;
}
