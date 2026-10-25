/**
 * ANT-460 — System Settings frontend catalog (client-side mirror only).
 *
 * Mirrors ANT-457 spec §3 (key catalog, shapes, defaults). The server is
 * authoritative for every value here: `PUT /v1/admin/settings/:key` validates
 * and rejects; these mirrors exist ONLY for input hints, input types, and
 * client-side pre-validation — never for enforcement.
 *
 * Fixed keys have exact entries below. Pattern keys (`xp.rewards.<taskId>`,
 * `xp.app_permissions.<appId>`, `xp.suspend.<appId>`) are matched by prefix
 * + suffix-format rules; unknown keys are never creatable from this UI
 * (closed catalog in MVP — spec §3).
 */

export type SettingValueType = "boolean" | "integer" | "number" | "string" | "json";

export type SettingGroup =
  | "intake"
  | "rewards"
  | "limits"
  | "app_permissions"
  | "policy"
  | "suspend";

export interface CatalogEntry {
  /** Exact key, or prefix pattern ending in `<name>` for pattern keys. */
  key: string;
  valueType: SettingValueType;
  group: SettingGroup;
  description: string;
  /** Static fail-closed default (spec §3–§4). */
  defaultValue: unknown;
  pattern: boolean;
}

export const KEY_GRAMMAR = /^[a-z0-9]+(\.[a-z0-9_]+)+$/;
export const MAX_KEY_LENGTH = 128;
export const TASK_ID_FORMAT = /^[a-z0-9_]{1,64}$/;
export const THRESHOLD_NAME_FORMAT = /^[a-z0-9_]{1,64}$/;
export const MIN_REASON_LENGTH = 10;
export const MAX_REASON_LENGTH = 500;
export const MAX_POLICY_ID_LENGTH = 64;
export const MAX_THRESHOLDS = 50;

export const FIXED_CATALOG: CatalogEntry[] = [
  {
    key: "xp.limits.daily",
    valueType: "integer",
    group: "limits",
    description: "Max XP awards per day. 0 denies all awards in that window.",
    defaultValue: 0,
    pattern: false,
  },
  {
    key: "xp.limits.weekly",
    valueType: "integer",
    group: "limits",
    description: "Max XP awards per week. 0 denies all awards in that window.",
    defaultValue: 0,
    pattern: false,
  },
  {
    key: "xp.limits.monthly",
    valueType: "integer",
    group: "limits",
    description: "Max XP awards per month. 0 denies all awards in that window.",
    defaultValue: 0,
    pattern: false,
  },
  {
    key: "xp.policy.active",
    valueType: "string",
    group: "policy",
    description: "Active leveling policy version. Empty means no policy is active (awarding denied).",
    defaultValue: "",
    pattern: false,
  },
  {
    key: "xp.policy.thresholds",
    valueType: "json",
    group: "policy",
    description: 'Level thresholds as {"<name>": <number ≥ 0>}, ≤ 50 entries.',
    defaultValue: {},
    pattern: false,
  },
  {
    key: "xp.suspend.global",
    valueType: "boolean",
    group: "suspend",
    description: "Global XP suspend. When true, all XP awarding stops.",
    defaultValue: false,
    pattern: false,
  },
];

export const PATTERN_CATALOG: CatalogEntry[] = [
  {
    key: "xp.rewards.<taskId>",
    valueType: "json",
    group: "rewards",
    description: 'Per-task reward as {"amount": <int ≥ 0>, "cap": <int ≥ amount | null>}.',
    defaultValue: {},
    pattern: true,
  },
  {
    key: "xp.app_permissions.<appId>",
    valueType: "json",
    group: "app_permissions",
    description: 'Per-app XP permissions as {"canEarn": <bool>, "canSpend": <bool>}. Absent key denies both.',
    defaultValue: { canEarn: false, canSpend: false },
    pattern: true,
  },
  {
    key: "xp.suspend.<appId>",
    valueType: "boolean",
    group: "suspend",
    description: "Per-app XP suspend. When true, awarding for that app stops.",
    defaultValue: false,
    pattern: true,
  },
];

export const GROUP_LABELS: Record<SettingGroup, string> = {
  intake: "Intake",
  rewards: "Rewards",
  limits: "Limits",
  app_permissions: "App permissions",
  policy: "Policy",
  suspend: "Suspend",
};

export const GROUP_ORDER: SettingGroup[] = [
  "intake",
  "rewards",
  "limits",
  "app_permissions",
  "policy",
  "suspend",
];

/** Resolve a concrete key to its catalog entry (fixed first, then pattern). */
export function lookupKey(key: string): CatalogEntry | null {
  const fixed = FIXED_CATALOG.find((e) => e.key === key);
  if (fixed) return fixed;
  if (key.startsWith("xp.rewards.")) {
    const suffix = key.slice("xp.rewards.".length);
    if (suffix && TASK_ID_FORMAT.test(suffix)) return PATTERN_CATALOG[0];
    return null;
  }
  if (key.startsWith("xp.app_permissions.")) {
    const suffix = key.slice("xp.app_permissions.".length);
    if (suffix) return PATTERN_CATALOG[1];
    return null;
  }
  if (key.startsWith("xp.suspend.")) {
    const suffix = key.slice("xp.suspend.".length);
    if (suffix && suffix !== "global") return PATTERN_CATALOG[2];
    return null;
  }
  return null;
}

/** Group for a concrete key; unknown keys fall back to prefix grouping. */
export function groupForKey(key: string): SettingGroup {
  const entry = lookupKey(key);
  if (entry) return entry.group;
  if (key.startsWith("xp.intake.")) return "intake";
  if (key.startsWith("xp.rewards.")) return "rewards";
  if (key.startsWith("xp.limits.")) return "limits";
  if (key.startsWith("xp.app_permissions.")) return "app_permissions";
  if (key.startsWith("xp.policy.")) return "policy";
  if (key.startsWith("xp.suspend.")) return "suspend";
  return "intake";
}

/** Reason gate: 10–500 chars after trimming (spec §5, G3). */
export function validateReason(reason: string): string | null {
  const len = reason.trim().length;
  if (len < MIN_REASON_LENGTH) return `Reason is required (${MIN_REASON_LENGTH}–${MAX_REASON_LENGTH} characters).`;
  if (reason.trim().length > MAX_REASON_LENGTH) return `Reason must be ≤ ${MAX_REASON_LENGTH} characters.`;
  return null;
}

/** Client pre-validation for a raw edited value. Returns an error string or null. */
export function validateSettingValue(key: string, raw: string): string | null {
  const entry = lookupKey(key);
  if (!entry) return "Unknown key — new keys cannot be created from this UI.";
  switch (entry.valueType) {
    case "boolean":
      if (raw !== "true" && raw !== "false") return "Must be true or false.";
      return null;
    case "integer": {
      if (!/^-?\d+$/.test(raw.trim())) return "Must be a whole number.";
      const n = Number(raw.trim());
      if (!Number.isInteger(n)) return "Must be a whole number.";
      if (key.startsWith("xp.limits.") && n < 0) return "Limits must be ≥ 0 (0 denies all awards).";
      if (n < 0 && key.startsWith("xp.rewards.")) return "Reward values must be ≥ 0.";
      return null;
    }
    case "number": {
      if (raw.trim() === "" || Number.isNaN(Number(raw.trim()))) return "Must be a number.";
      return null;
    }
    case "string":
      if (key === "xp.policy.active") {
        if (raw.trim() === "") return null; // empty = no policy active (deny) — allowed
        if (raw.trim().length > MAX_POLICY_ID_LENGTH) return `Policy id must be ≤ ${MAX_POLICY_ID_LENGTH} characters.`;
      }
      return null;
    case "json":
      return validateSettingJson(key, raw);
    default:
      return null;
  }
}

function parseJsonObject(raw: string): { ok: false; error: string } | { ok: true; value: unknown } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "Must be valid JSON." };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "Must be a JSON object." };
  }
  return { ok: true, value: parsed };
}

/** Shape validation for the three json value kinds (spec §3). */
export function validateSettingJson(key: string, raw: string): string | null {
  if (key.startsWith("xp.rewards.")) {
    const res = parseJsonObject(raw);
    if (!res.ok) return res.error;
    const v = res.value as Record<string, unknown>;
    if (typeof v.amount !== "number" || !Number.isInteger(v.amount) || v.amount < 0) {
      return '"amount" must be an integer ≥ 0.';
    }
    if (v.cap !== null && v.cap !== undefined) {
      if (typeof v.cap !== "number" || !Number.isInteger(v.cap) || (v.cap as number) < (v.amount as number)) {
        return '"cap" must be null or an integer ≥ amount.';
      }
    }
    return null;
  }
  if (key.startsWith("xp.app_permissions.")) {
    const res = parseJsonObject(raw);
    if (!res.ok) return res.error;
    const v = res.value as Record<string, unknown>;
    if (typeof v.canEarn !== "boolean" || typeof v.canSpend !== "boolean") {
      return '"canEarn" and "canSpend" must both be booleans.';
    }
    return null;
  }
  if (key === "xp.policy.thresholds") {
    const res = parseJsonObject(raw);
    if (!res.ok) return res.error;
    const v = res.value as Record<string, unknown>;
    const names = Object.keys(v);
    if (names.length > MAX_THRESHOLDS) return `At most ${MAX_THRESHOLDS} thresholds.`;
    for (const name of names) {
      if (!THRESHOLD_NAME_FORMAT.test(name)) return `Invalid threshold name "${name}".`;
      if (typeof v[name] !== "number" || (v[name] as number) < 0) {
        return `Threshold "${name}" must be a number ≥ 0.`;
      }
    }
    return null;
  }
  // Unknown json shape — accept any valid JSON object, server decides.
  const res = parseJsonObject(raw);
  return res.ok ? null : res.error;
}

/** Parse a raw edited string into the JSON wire value for PUT. */
export function coerceSettingValue(key: string, raw: string): unknown {
  const entry = lookupKey(key);
  if (!entry) return raw;
  switch (entry.valueType) {
    case "boolean":
      return raw === "true";
    case "integer":
      return Number(raw.trim());
    case "number":
      return Number(raw.trim());
    case "string":
      return raw;
    case "json":
      return JSON.parse(raw) as unknown;
    default:
      return raw;
  }
}

/** Render a stored wire value back into the editor string. */
export function formatSettingValue(value: unknown, valueType: SettingValueType): string {
  if (valueType === "string") return typeof value === "string" ? value : "";
  if (valueType === "boolean") return value === true ? "true" : "false";
  if (valueType === "integer" || valueType === "number") {
    return typeof value === "number" ? String(value) : "";
  }
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return "{}";
  }
}

/** Compact one-line display of a stored value for the table. */
export function displaySettingValue(value: unknown, valueType: SettingValueType): string {
  if (valueType === "string") return typeof value === "string" && value !== "" ? value : "—";
  if (valueType === "boolean") return value === true ? "true" : "false";
  if (valueType === "integer" || valueType === "number") {
    return typeof value === "number" ? String(value) : "—";
  }
  try {
    const s = JSON.stringify(value ?? {});
    return s.length > 80 ? `${s.slice(0, 77)}…` : s;
  } catch {
    return "—";
  }
}

/** Relative + absolute timestamp for updatedAt display (spec §10 edge case). */
export function formatUpdatedAt(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const diffMs = Date.now() - t;
  const abs = new Date(t).toLocaleString();
  if (diffMs < 0) return abs;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return `just now (${abs})`;
  if (mins < 60) return `${mins}m ago (${abs})`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago (${abs})`;
  const days = Math.floor(hours / 24);
  return `${days}d ago (${abs})`;
}
