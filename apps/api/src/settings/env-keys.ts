// ANT-456 — legacy XP env-flag keys (single source of truth).
//
// PID_XP_INTAKE_ENABLED was removed: XP intake is a required feature, so only
// the xp.suspend.* kill-switches gate awarding. PID_XP_MIGRATION_ENABLED stays
// authoritative for migration EXECUTION. Kept in settings/ (not experience/)
// so both layers share it without a file-level import cycle.

/** Release gate for migration EXECUTION: exact-"true", fail-closed. */
export const XP_MIGRATION_ENABLED_KEY = "PID_XP_MIGRATION_ENABLED";
