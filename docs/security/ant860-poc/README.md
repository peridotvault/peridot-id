# ANT-860 PoC bundle (B1-B5, validator lokal terisolasi)

Baseline: peridot-id @ paperclip 2606db0. Program SVM dibangun dgn
`PID_PROGRAM_ID=<id deploy>` lalu deploy ke validator lokal terisolasi
(RPC 18999 + 19999); EVM via anvil lokal (8546). Tanpa ubah kontrak/SDK/API,
tanpa mainnet, fixture dummy.

Verdict ringkas (log + skrip repro di folder ini):
- B1 SVM TERBUKTI — `poc-a-reclaim.mjs` + `svm-integration.log`
- B1 EVM TERBUKTI — `poc-e-squat.mjs`
- B2 TERBUKTI (terbatas rent floor) — `poc-b-feetamper.mjs`
- B3 TERBUKTI (sesi bertahan rotasi) — `poc-c-rotsession.mjs`
- B4 TERBUKTI (replay lintas cluster) — `poc-d-replay.mjs`
- B5 TERBUKTI by-design (first-writer-wins + self-appoint) — `svm-integration.log`
- P6: `svm-session.log` 26/27 (1 FAIL = treasury sudah ter-init di env yang sama,
  bukan kegagalan kode) + cargo 70 + forge 95.

Detail penuh di komentar issue ANT-860.
