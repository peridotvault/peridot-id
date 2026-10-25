-- The DB leg of the old XP intake release gate is gone: intake is required,
-- so only the xp.suspend.* kill-switches gate awarding. Remove the orphaned
-- setting row and its audit history so the admin dashboard catalog matches.
DELETE FROM "system_setting_history" WHERE "key" = 'xp.intake.enabled';
DELETE FROM "system_settings" WHERE "key" = 'xp.intake.enabled';
