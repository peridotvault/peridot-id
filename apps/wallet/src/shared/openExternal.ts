import { assertSafeExternalUrl } from "./safeUrl";

// Open an external URL in a new tab. Replaces the old Linking.openURL shim:
// anchor click, not a popup call (CI forbids those outside feat/embed).
// ANT-346 M10: https-only — a non-https target rejects instead of opening,
// so a poisoned paymentUrl / explorer link can't downgrade navigation.
export function openExternalUrl(url: string): Promise<void> {
  assertSafeExternalUrl(url);
  const a = document.createElement("a");
  a.href = url;
  a.target = "_blank";
  a.rel = "noreferrer noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  return Promise.resolve();
}
