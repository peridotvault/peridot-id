// ANT-456 — XP domain accessors over SystemSetting (plan §3.3, spec §4).
//
// Typed reads for the XP intake path plus the normative effective-intake
// rule: `NOT xp.suspend.global AND NOT xp.suspend.<appId>`. The original
// release gates (env PID_XP_INTAKE_ENABLED + DB xp.intake.enabled) are gone:
// XP intake is a required feature, so only the kill-switches remain.
// Fail-closed: any unreadable / mismatched / missing input evaluates to deny,
// and reads never throw to intake callers (spec F4).

import { Injectable } from "@nestjs/common";
import { SettingsService, SettingsSource } from "./settings.service";
import { XP_LIMIT_DEFAULT, XP_POLICY_ACTIVE_DEFAULT, XP_SUSPEND_DEFAULT } from "./defaults";

export type IntakeSource = "db" | "defaults-fallback";

export interface IntakeBreakdown {
  suspendGlobal: boolean;
  suspendApp: boolean;
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
  constructor(private readonly settings: SettingsService) {}

  /** Closed-catalog key builder for the parameterized DB settings. */
  private settingKey(kind: "suspendGlobal" | "suspendApp" | "limitsDaily" | "limitsWeekly" | "limitsMonthly" | "policyActive" | "policyThresholds", appId?: string): string {
    switch (kind) {
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
    const [suspendGlobal, suspendApp] = await Promise.all([
      this.settings.readDetailed<boolean>(this.settingKey("suspendGlobal"), XP_SUSPEND_DEFAULT),
      appId
        ? this.settings.readDetailed<boolean>(this.settingKey("suspendApp", appId), XP_SUSPEND_DEFAULT)
        : { value: false, source: "default" as SettingsSource, degraded: false },
    ]);
    const breakdown: IntakeBreakdown = {
      suspendGlobal: suspendGlobal.value,
      suspendApp: suspendApp.value,
    };
    const degraded = suspendGlobal.degraded || suspendApp.degraded;
    const allowed = !degraded && suspendGlobal.value !== true && suspendApp.value !== true;
    return { allowed, breakdown, source: degraded ? "defaults-fallback" : "db" };
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
