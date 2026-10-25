-- ANT-581 F4: scope the idempotency key by entry point. A terminally-failed
-- withdraw must not block an execute under the same chain nonce (the user
-- cannot mint a fresh nonce; only a landed tx advances it). The on-chain
-- nonce still prevents double-execution, so per-entry slots lose no replay
-- safety. Expand-only (index change, no data movement).
--
-- DOWN (manual): DROP INDEX "relayer_broadcasts_pid_nonce_chain_entryPoint_key";
--   CREATE UNIQUE INDEX "relayer_broadcasts_pid_nonce_chain_key"
--   ON "relayer_broadcasts"("pid", "nonce", "chain");
--   (fails if two entry points share (pid,nonce,chain) — delete the
--   superseded row first).
DROP INDEX "relayer_broadcasts_pid_nonce_chain_key";
CREATE UNIQUE INDEX "relayer_broadcasts_pid_nonce_chain_entryPoint_key" ON "relayer_broadcasts"("pid", "nonce", "chain", "entryPoint");
