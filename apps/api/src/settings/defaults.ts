// ANT-456 — static defaults + closed key catalog (plan §5, spec §3).
//
// Single source of truth for the SystemSetting fixed catalog. The seed
// migration (20261031_system_settings) pins these values for existing DBs;
// the service falls back to them (fail-closed) when a key is unknown, has
// the wrong type, or the DB/config cannot be read.
//
// Fail-closed posture: intake OFF, suspends OFF (deny-by-absence),
// limits 0 (= no awards that window when enforced), no active policy ("").

export const XP_INTAKE_ENABLED_DEFAULT = false;
export const XP_SUSPEND_DEFAULT = false;
export const XP_LIMIT_DEFAULT = 0;
export const XP_POLICY_ACTIVE_DEFAULT = "";
export const SETTINGS_CACHE_TTL_MS = 30_000;

export type SettingValueType = "boolean" | "integer" | "number" | "string" | "json";

export interface SettingDefinition {
  key: string;
  valueType: SettingValueType;
  defaultValue: unknown;
  description: string;
  /** Returns a human-readable constraint violation, or null when valid. */
  validate: (value: unknown) => string | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function validateRewardShape(value: unknown): string | null {
  if (!isRecord(value)) return "must be an object {amount, cap}";
  if (!Number.isInteger(value.amount) || (value.amount as number) < 0) return "amount must be an integer >= 0";
  if (value.cap !== null && (!Number.isInteger(value.cap) || (value.cap as number) < (value.amount as number)))
    return "cap must be null or an integer >= amount";
  return null;
}

function validateAppPermissions(value: unknown): string | null {
  if (!isRecord(value)) return "must be an object {canEarn, canSpend}";
  if (typeof value.canEarn !== "boolean" || typeof value.canSpend !== "boolean")
    return "canEarn and canSpend must both be booleans";
  return null;
}

function validateThresholds(value: unknown): string | null {
  if (!isRecord(value)) return "must be an object {name: number >= 0}";
  const names = Object.keys(value);
  if (names.length > 50) return "at most 50 entries";
  for (const name of names) {
    if (!/^[a-z0-9_]{1,64}$/.test(name)) return `threshold name ${JSON.stringify(name)} must match ^[a-z0-9_]{1,64}$`;
    if (typeof value[name] !== "number" || !(value[name] as number >= 0)) return `threshold ${JSON.stringify(name)} must be a number >= 0`;
  }
  return null;
}

/** Parameterized-key validators (deny-by-absence until seeded by a migration — closed catalog, spec §10 O-2). */
export function validateParameterizedKey(key: string, value: unknown): string | null {
  if (/^xp\.rewards\.[a-z0-9_]{1,64}$/.test(key)) return validateRewardShape(value);
  if (/^xp\.app_permissions\.[A-Za-z0-9_.-]{1,128}$/.test(key)) return validateAppPermissions(value);
  if (/^xp\.suspend\.[A-Za-z0-9_.-]{1,128}$/.test(key)) {
    if (typeof value !== "boolean") return "must be a boolean";
    return null;
  }
  return `unknown setting key ${JSON.stringify(key)} (closed catalog — new keys ship via migration)`;
}

export const SETTING_DEFINITIONS: SettingDefinition[] = [
  {
    key: "xp.intake.enabled",
    valueType: "boolean",
    defaultValue: XP_INTAKE_ENABLED_DEFAULT,
    description: "DB successor of PID_XP_INTAKE_ENABLED. Effective intake additionally ANDs the env flag during transition.",
    validate: (v) => (typeof v === "boolean" ? null : "must be a boolean"),
  },
  {
    key: "xp.limits.daily",
    valueType: "integer",
    defaultValue: XP_LIMIT_DEFAULT,
    description: "Global per-PID daily award cap (0 = no awards that window). Reserved: pipeline enforcement lands in a follow-up.",
    validate: (v) => (Number.isInteger(v) && (v as number) >= 0 ? null : "must be an integer >= 0"),
  },
  {
    key: "xp.limits.weekly",
    valueType: "integer",
    defaultValue: XP_LIMIT_DEFAULT,
    description: "Global per-PID weekly award cap (0 = no awards that window). Reserved: see xp.limits.daily.",
    validate: (v) => (Number.isInteger(v) && (v as number) >= 0 ? null : "must be an integer >= 0"),
  },
  {
    key: "xp.limits.monthly",
    valueType: "integer",
    defaultValue: XP_LIMIT_DEFAULT,
    description: "Global per-PID monthly award cap (0 = no awards that window). Reserved: see xp.limits.daily.",
    validate: (v) => (Number.isInteger(v) && (v as number) >= 0 ? null : "must be an integer >= 0"),
  },
  {
    key: "xp.policy.active",
    valueType: "string",
    defaultValue: XP_POLICY_ACTIVE_DEFAULT,
    description: "Active XP policy id. Empty = no policy active = awarding denied when enforced.",
    validate: (v) => (typeof v === "string" && v.length <= 64 ? null : "must be a string of at most 64 chars"),
  },
  {
    key: "xp.policy.thresholds",
    valueType: "json",
    defaultValue: {},
    description: "Named XP policy thresholds {name: number >= 0}, max 50 entries.",
    validate: validateThresholds,
  },
  {
    key: "xp.suspend.global",
    valueType: "boolean",
    defaultValue: XP_SUSPEND_DEFAULT,
    description: "Global XP intake kill-switch (AND NOT with the intake flag).",
    validate: (v) => (typeof v === "boolean" ? null : "must be a boolean"),
  },
];

export const SETTING_DEFAULTS = new Map(SETTING_DEFINITIONS.map((d) => [d.key, d]));

export function definitionFor(key: string): SettingDefinition | undefined {
  return SETTING_DEFAULTS.get(key);
}

/** Type-tag check of a stored JSON value against its declared valueType. */
export function matchesValueType(valueType: SettingValueType, value: unknown): boolean {
  switch (valueType) {
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "string":
      return typeof value === "string";
    case "json":
      return true;
  }
}
