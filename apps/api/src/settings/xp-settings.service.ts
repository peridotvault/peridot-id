// ANT-456 — XP domain accessors over SystemSetting (plan §3.3, spec §4).
//
// Typed reads for the XP intake path plus the normative effective-intake
// rule: `xp.intake.enabled AND NOT xp.suspend.global AND NOT
// xp.suspend.<appId> AND envAllow`, where envAllow is the legacy
// PID_XP_INTAKE_ENABLED flag (both must be true during transition — most
// restrictive wins, plan §3.3). Fail-closed: any unreadable / mismatched /
// missing input evaluates to deny, and reads never throw to intake
// callers (spec F4).

import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { XP_INTAKE_ENABLED_KEY } from "../settings/env-keys";
import { SettingsService, SettingsSource } from "./settings.service";
import { XP_INTAKE_ENABLED_DEFAULT, XP_LIMIT_DEFAULT, XP_POLICY_ACTIVE_DEFAULT, XP_SUSPEND_DEFAULT } from "./defaults";

export type IntakeSource = "db+env" | "defaults-fallback";

export interface IntakeBreakdown {
  xpIntakeEnabled: boolean;
  suspendGlobal: boolean;
  suspendApp: boolean;
  envAllow: boolean;
}

export interface EffectiveIntake {
  allowed: boolean;
  breakdown: IntakeBreakdown;
  source: IntakeSource;
}

export interface AppPermissions {
  canEarn: boolean;
  canSpend: boolean;
}

@Injectable()
export class XpSettingsService {
  constructor(
    private readonly settings: SettingsService,
    private readonly config: ConfigService,
  ) {}

  /** Legacy env leg (untouched during transition — plan req 5). Exact-"true", fail-closed. */
  envIntakeAllow(): boolean {
    try {
      return this.config.get<string>(XP_INTAKE_ENABLED_KEY, "false") === "true";
    } catch {
      return false;
    }
  }

  /** Import cycle guard: events.service owns the env key constant; this file only reads it. */
  private settingKey(kind: "intake" | "suspendGlobal" | "suspendApp" | "limitsDaily" | "limitsWeekly" | "limitsMonthly" | "policyActive" | "policyThresholds", appId?: string): string {
    switch (kind) {
      case "intake":
        return "xp.intake.enabled";
      case "suspendGlobal":
        return "xp.suspend.global";
      case "suspendApp":
        return `xp.suspend.${appId ?? ""}`;
      case "limitsDaily":
        return "xp.limits.daily";
      case "limitsWeekly":
        return "xp.limits.weekly";
      case "limitsMonthly":
        return "xp.limits.monthly";
      case "policyActive":
        return "xp.policy.active";
      case "policyThresholds":
        return "xp.policy.thresholds";
    }
  }

  async effectiveIntake(appId?: string): Promise<EffectiveIntake> {
    const [intake, suspendGlobal, suspendApp] = await Promise.all([
      this.settings.readDetailed<boolean>(this.settingKey("intake"), XP_INTAKE_ENABLED_DEFAULT),
      this.settings.readDetailed<boolean>(this.settingKey("suspendGlobal"), XP_SUSPEND_DEFAULT),
      appId
        ? this.settings.readDetailed<boolean>(this.settingKey("suspendApp", appId), XP_SUSPEND_DEFAULT)
        : { value: false, source: "default" as SettingsSource, degraded: false },
    ]);
    const envAllow = this.envIntakeAllow();
    const breakdown: IntakeBreakdown = {
      xpIntakeEnabled: intake.value,
      suspendGlobal: suspendGlobal.value,
      suspendApp: suspendApp.value,
      envAllow,
    };
    const degraded = intake.degraded || suspendGlobal.degraded || suspendApp.degraded;
    const allowed = !degraded && intake.value === true && suspendGlobal.value !== true && suspendApp.value !== true && envAllow;
    return { allowed, breakdown, source: degraded ? "defaults-fallback" : "db+env" };
  }

  async isSuspended(appId?: string): Promise<boolean> {
    if (!appId) return this.settings.get<boolean>("xp.suspend.global", XP_SUSPEND_DEFAULT).then((g) => g === true);
    const [g, a] = await Promise.all([
      this.settings.get<boolean>("xp.suspend.global", XP_SUSPEND_DEFAULT),
      this.settings.get<boolean>(`xp.suspend.${appId}`, XP_SUSPEND_DEFAULT),
    ]);
    return g === true || a === true;
  }

  async getLimits(): Promise<{ daily: number; weekly: number; monthly: number }> {
    const [daily, weekly, monthly] = await Promise.all([
      this.settings.get<number>("xp.limits.daily", XP_LIMIT_DEFAULT),
      this.settings.get<number>("xp.limits.weekly", XP_LIMIT_DEFAULT),
      this.settings.get<number>("xp.limits.monthly", XP_LIMIT_DEFAULT),
    ]);
    return { daily, weekly, monthly };
  }

  /** Per-task reward override. Absent key = no implicit reward (null). Reserved: pipeline enforcement is a follow-up. */
  async getReward(taskId: string): Promise<{ amount: number; cap: number | null } | null> {
    return this.settings.get<{ amount: number; cap: number | null } | null>(`xp.rewards.${taskId}`, null);
  }

  /** Per-app earn/spend permissions. Absent key = deny by default. Reserved: pipeline enforcement is a follow-up. */
  async getAppPermissions(appId: string): Promise<AppPermissions> {
    return this.settings.get<AppPermissions>(`xp.app_permissions.${appId}`, { canEarn: false, canSpend: false });
  }

  async getPolicy(): Promise<{ active: string; thresholds: Record<string, number> }> {
    const [active, thresholds] = await Promise.all([
      this.settings.get<string>("xp.policy.active", XP_POLICY_ACTIVE_DEFAULT),
      this.settings.get<Record<string, number>>("xp.policy.thresholds", {}),
    ]);
    return { active, thresholds };
  }
}
