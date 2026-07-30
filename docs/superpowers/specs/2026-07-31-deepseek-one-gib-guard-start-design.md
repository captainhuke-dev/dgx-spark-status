# DeepSeek 1 GiB RamGuard and bounded start design

Date: 2026-07-31  
Status: approved in conversation; awaiting written-spec review

## Goal

Start the existing Dashboard-managed DeepSeek V4 Flash DS4 preset without
stopping unrelated work. Change the hard memory guard so the exact DeepSeek
component set is stopped when `MemAvailable < 1 GiB`.

## Observed blockers

- The model is stopped and no NVIDIA compute process is active.
- The previous failed start left stale weight-server PID/PGID evidence for a
  process that no longer exists.
- Sixty-seven `app-server-broker.mjs` processes from
  `.claude/jobs/.../codex-plugin-test-*` are reparented to PID 1 and consume
  about 2.2 GiB RSS in total.
- The weight-server preflight needs an 80.77 GiB upload allocation while
  preserving its configured reserve. With a 32 GiB reserve, the current host
  budget is insufficient.

## Authorized changes

1. Create canonical and raw operation records before runtime mutation.
2. Stop the stale DeepSeek lifecycle through its exact stop command and verify
   all recorded components, loopback ports, and broker socket are absent.
3. Stop only orphan test brokers that satisfy every condition:
   - executable command is the fixed `app-server-broker.mjs` route;
   - path is under `.claude/jobs/` and its working directory is
     `/tmp/codex-plugin-test-*`;
   - parent PID is 1;
   - PID and PGID are numeric and equal;
   - identity is rechecked immediately before exact PGID termination.
4. Set `RAMGUARD_HARD_FLOOR_BYTES=1073741824` and document the strict breach
   rule as `MemAvailable < 1073741824`.
5. Attempt Start with the existing 32 GiB weight-server reserve.
6. If and only if the 32 GiB preflight still rejects for insufficient
   allocatable memory, add the explicit bounded fallback
   `--reserve-gb 29` and retry once.

The preflight remains enabled. `DS4_WEIGHT_SERVER_NO_PREFLIGHT=1`, broad
`pkill`/`killall`, and termination of live Claude/Codex tasks are forbidden.

## Runtime and failure handling

- The four managed components remain `weight-server`, `request-guard`,
  `memory-guard`, and `server`.
- Every start/stop action uses recorded exact PID/PGID identity.
- A failed startup invokes the exact stop path and must not leave stale PID/PGID
  evidence when the corresponding process and socket are proven absent.
- Stop immediately on a fresh kernel OOM, NVRM, Xid, CUDA error, identity
  mismatch, or RamGuard breach.
- Do not auto-restart after a hard memory or kernel/GPU breach.

## Validation

- Confirm all four exact components are active.
- Confirm `http://127.0.0.1:18082/v1/models` returns the expected model.
- Confirm Dashboard reports `running` only when all components and health are
  ready.
- Record minimum `MemAvailable`, weight reserve used, relevant kernel-event
  delta, and exact PID/PGID values.
- Exercise a small API smoke request. Do not run a large-context benchmark in
  this operation.
- If the model cannot start safely after the single 29 GiB fallback, stop the
  candidate exactly and publish the blocker without further tuning.

## Rollback

- Restore the prior 1.5 GiB RamGuard values.
- Restore the launcher to the pre-operation checksum if `--reserve-gb 29` was
  added.
- Stop the exact DeepSeek lifecycle and verify all ports and sockets closed.
- Do not restart any confirmed orphan test broker.
