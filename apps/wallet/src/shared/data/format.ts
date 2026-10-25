// Shared date formatting for feed rows. Used by chain + fiat rows (rule 5:
// needed by 2+ feats, so it lives in shared/, not in either feat).
export function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
