// ANT-456 — DB-driven configuration reads/writes (plan §3.3).
//
// Cached reads (in-memory, 30s TTL, invalidated on admin write), typed
// accessors with static fail-closed defaults, and audited admin writes
// (optimistic locking + history + SecurityEvent in ONE transaction).
//
// Fail-closed invariant (unit-tested matrix): unknown key → static
// default; type/shape mismatch → static default + warn-level alert hook;
// DB/config load failure → static defaults AND intake denied upstream.
// Readers never throw to intake callers; admin paths throw Nest
// exceptions carrying the spec §5 `{error, message}` envelope.

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { SecurityEventService } from "../security/security-event.service";
import {
  SETTINGS_CACHE_TTL_MS,
  SettingDefinition,
  definitionFor,
  matchesValueType,
  validateParameterizedKey,
} from "./defaults";

export type SettingsSource = "db" | "cache" | "default" | "fallback";

export interface DetailedRead<T> {
  value: T;
  /** db = fresh row; cache = TTL hit; default = absent key (deny-by-absence); fallback = mismatch/DB error. */
  source: SettingsSource;
  /** True only when the static default was used because something was wrong (mismatch or DB error). */
  degraded: boolean;
}

export interface AlertInfo {
  key: string;
  reason: "type_mismatch" | "db_error";
  detail?: string;
}

interface CacheEntry {
  value: unknown;
  valueType: string;
  version: number;
  expiresAt: number;
}

export interface SettingView {
  key: string;
  value: unknown;
  valueType: string;
  description: string | null;
  version: number;
  updatedBy: string;
  updatedAt: Date;
}

export interface HistoryEntry {
  version: number;
  oldValue: unknown;
  newValue: unknown;
  reason: string;
  updatedBy: string;
  updatedAt: Date;
}

/** Validate a stored value against the closed catalog (fixed + parameterized). */
export function validateStoredValue(key: string, valueType: string, value: unknown): string | null {
  const def: SettingDefinition | undefined = definitionFor(key);
  if (def) {
    if (def.valueType !== valueType) return `stored valueType ${JSON.stringify(valueType)} does not match catalog ${JSON.stringify(def.valueType)}`;
    return def.validate(value);
  }
  const err = validateParameterizedKey(key, value);
  if (err !== null && err.startsWith("unknown setting key")) return err;
  if (!matchesValueType(valueType as SettingDefinition["valueType"], value)) return `value does not match valueType ${JSON.stringify(valueType)}`;
  return err;
}

@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);
  private readonly cache = new Map<string, CacheEntry>();

  /** Observability hook (Trevor): fired on every fail-closed fallback. */
  onAlert: (info: AlertInfo) => void = (info) => {
    this.logger.warn(`settings fallback key=${info.key} reason=${info.reason}${info.detail ? ` detail=${info.detail}` : ""}`);
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly security: SecurityEventService,
  ) {}

  private alert(key: string, reason: AlertInfo["reason"], detail?: string): void {
    try {
      this.onAlert({ key, reason, detail });
    } catch (e) {
      this.logger.warn(`settings alert hook threw for key=${key}: ${(e as Error).message}`);
    }
  }

  invalidate(key?: string): void {
    if (key) this.cache.delete(key);
    else this.cache.clear();
  }

  /** Generic typed read. Never throws: falls back to the static/catalog default. */
  async get<T>(key: string, callerDefault: T): Promise<T> {
    return (await this.readDetailed<T>(key, callerDefault)).value;
  }

  async readDetailed<T>(key: string, callerDefault: T): Promise<DetailedRead<T>> {
    const def = definitionFor(key);
    const fallback: T = def ? (def.defaultValue as T) : callerDefault;
    const now = Date.now();
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > now) {
      return { value: hit.value as T, source: "cache", degraded: false };
    }
    let row: { value: unknown; valueType: string; version: number } | null;
    try {
      row = await this.prisma.systemSetting.findUnique({ where: { key } });
    } catch (e) {
      this.alert(key, "db_error", (e as Error).message);
      return { value: fallback, source: "fallback", degraded: true };
    }
    if (!row) {
      return { value: fallback, source: "default", degraded: false };
    }
    const violation = validateStoredValue(key, row.valueType, row.value);
    if (violation) {
      this.alert(key, "type_mismatch", violation);
      return { value: fallback, source: "fallback", degraded: true };
    }
    this.cache.set(key, { value: row.value, valueType: row.valueType, version: row.version, expiresAt: now + SETTINGS_CACHE_TTL_MS });
    return { value: row.value as T, source: "db", degraded: false };
  }

  /** Admin list. Throws (503) when the DB cannot be read — the Dashboard degrades explicitly. */
  async listSettings(prefix?: string): Promise<SettingView[]> {
    let rows: Array<{ key: string; value: unknown; valueType: string; description: string | null; version: number; updatedBy: string; updatedAt: Date }>;
    try {
      rows = await this.prisma.systemSetting.findMany({
        ...(prefix ? { where: { key: { startsWith: prefix } } } : {}),
        orderBy: { key: "asc" },
      });
    } catch (e) {
      throw new ServiceUnavailableException({ error: "unavailable", message: `settings store unreachable: ${(e as Error).message}` });
    }
    return rows.map((r) => ({
      key: r.key,
      value: r.value as unknown,
      valueType: r.valueType,
      description: r.description,
      version: r.version,
      updatedBy: r.updatedBy,
      updatedAt: r.updatedAt,
    }));
  }

  /** Admin single read. Throws (503) on DB error; returns null for unknown keys (caller maps to 404). */
  async getSetting(key: string): Promise<SettingView | null> {
    let row: { key: string; value: unknown; valueType: string; description: string | null; version: number; updatedBy: string; updatedAt: Date } | null;
    try {
      row = await this.prisma.systemSetting.findUnique({ where: { key } });
    } catch (e) {
      throw new ServiceUnavailableException({ error: "unavailable", message: `settings store unreachable: ${(e as Error).message}` });
    }
    if (!row) return null;
    return {
      key: row.key,
      value: row.value as unknown,
      valueType: row.valueType,
      description: row.description,
      version: row.version,
      updatedBy: row.updatedBy,
      updatedAt: row.updatedAt,
    };
  }

  /**
   * Admin write: closed catalog, semantic validation, optimistic locking,
   * history + SecurityEvent in the SAME transaction. Returns the updated view.
   */
  async updateSetting(
    key: string,
    value: unknown,
    opts: { reason: string; expectedVersion: number; updatedBy: string },
  ): Promise<SettingView> {
    const def = definitionFor(key);
    if (!def) {
      throw new NotFoundException({ error: "not_found", message: `unknown setting key ${JSON.stringify(key)} (closed catalog)` });
    }
    if (typeof opts.reason !== "string" || opts.reason.length < 10 || opts.reason.length > 500) {
      throw new BadRequestException({ error: "validation_error", message: "reason must be 10-500 chars" });
    }
    if (!Number.isInteger(opts.expectedVersion) || opts.expectedVersion < 1) {
      throw new BadRequestException({ error: "validation_error", message: "expectedVersion must be an integer >= 1" });
    }
    if (value === undefined) {
      throw new BadRequestException({ error: "validation_error", message: "value is required" });
    }
    const violation = def.validate(value);
    if (violation) {
      throw new BadRequestException({ error: "validation_error", message: `${key}: ${violation}` });
    }
    if (!matchesValueType(def.valueType, value)) {
      throw new BadRequestException({ error: "validation_error", message: `${key}: value does not match valueType ${def.valueType}` });
    }

    let current: { value: unknown; version: number } | null;
    try {
      current = await this.prisma.systemSetting.findUnique({ where: { key }, select: { value: true, version: true } });
    } catch (e) {
      throw new ServiceUnavailableException({ error: "unavailable", message: `settings store unreachable: ${(e as Error).message}` });
    }
    if (!current) {
      throw new NotFoundException({ error: "not_found", message: `unknown setting key ${JSON.stringify(key)} (not seeded)` });
    }
    if (current.version !== opts.expectedVersion) {
      throw new ConflictException({
        error: "version_conflict",
        message: `${key} changed since version ${opts.expectedVersion} (current version ${current.version}) — reload and retry`,
        current: { value: current.value as unknown, version: current.version },
      });
    }

    const nextVersion = opts.expectedVersion + 1;
    const oldValue = current.value;
    try {
      const next = await this.prisma.$transaction(async (tx) => {
        // Version guard in the WHERE clause: a concurrent writer racing the
        // pre-read above wins at most once; the loser sees count 0 → 409.
        const res = await tx.systemSetting.updateMany({
          where: { key, version: opts.expectedVersion },
          data: { value: value as never, version: nextVersion, updatedBy: opts.updatedBy },
        });
        if (res.count !== 1) {
          const raced = await tx.systemSetting.findUnique({ where: { key } });
          throw new ConflictException({
            error: "version_conflict",
            message: `${key} changed concurrently — reload and retry`,
            current: { value: (raced?.value ?? oldValue) as unknown, version: raced?.version ?? opts.expectedVersion },
          });
        }
        await tx.systemSettingHistory.create({
          data: {
            key,
            oldValue: (oldValue ?? null) as never,
            newValue: value as never,
            reason: opts.reason,
            version: nextVersion,
            updatedBy: opts.updatedBy,
          },
        });
        await this.security.log(
          opts.updatedBy,
          "system_setting.updated",
          { key, oldValue: oldValue as never, newValue: value as never, reason: opts.reason, version: nextVersion },
          tx,
        );
        return tx.systemSetting.findUniqueOrThrow({ where: { key } });
      });
      this.invalidate(key);
      return {
        key: next.key,
        value: next.value as unknown,
        valueType: next.valueType,
        description: next.description,
        version: next.version,
        updatedBy: next.updatedBy,
        updatedAt: next.updatedAt,
      };
    } catch (e) {
      if (e instanceof ConflictException) throw e;
      throw new ServiceUnavailableException({ error: "unavailable", message: `settings store unreachable: ${(e as Error).message}` });
    }
  }

  /** Admin history (newest first; cursor is an opaque offset token). */
  async settingHistory(key: string, opts?: { limit?: number; cursor?: string }): Promise<{ entries: HistoryEntry[]; nextCursor: string | null }> {
    const limit = Math.min(Math.max(Math.floor(opts?.limit ?? 50) || 50, 1), 200);
    const offset = opts?.cursor ? Math.max(parseInt(opts.cursor, 10) || 0, 0) : 0;
    try {
      const def = definitionFor(key);
      if (!def) {
        const exists = await this.prisma.systemSetting.findUnique({ where: { key }, select: { key: true } });
        if (!exists) throw new NotFoundException({ error: "not_found", message: `unknown setting key ${JSON.stringify(key)}` });
      }
      const rows = await this.prisma.systemSettingHistory.findMany({
        where: { key },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: offset,
        take: limit + 1,
      });
      const slice = rows.slice(0, limit);
      return {
        entries: slice.map((r) => ({
          version: r.version,
          oldValue: r.oldValue as unknown,
          newValue: r.newValue as unknown,
          reason: r.reason,
          updatedBy: r.updatedBy,
          updatedAt: r.createdAt,
        })),
        nextCursor: rows.length > limit ? String(offset + limit) : null,
      };
    } catch (e) {
      if (e instanceof NotFoundException) throw e;
      throw new ServiceUnavailableException({ error: "unavailable", message: `settings store unreachable: ${(e as Error).message}` });
    }
  }
}
