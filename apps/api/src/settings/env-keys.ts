// ANT-456 — legacy XP env-flag keys (single source of truth).
//
// PID_XP_INTAKE_ENABLED / PID_XP_MIGRATION_ENABLED stay authoritative
// alongside the DB settings during transition (AND-precedence, plan §3.3)
// and are untouched by this change (plan req 5). Kept in settings/ (not
// experience/) so both layers share them without a file-level import cycle.

/** Release gate for XP awarding (HARD GATE): exact-"true", fail-closed. */
export const XP_INTAKE_ENABLED_KEY = "PID_XP_INTAKE_ENABLED";

/** Release gate for migration EXECUTION: exact-"true", fail-closed. */
export const XP_MIGRATION_ENABLED_KEY = "PID_XP_MIGRATION_ENABLED";
