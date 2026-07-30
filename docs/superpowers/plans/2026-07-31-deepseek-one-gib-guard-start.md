# DeepSeek 1 GiB Guarded Start Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Safely start the existing four-component DeepSeek V4 Flash DS4 preset with a strict 1 GiB MemAvailable emergency floor and a single bounded 29 GiB weight-reserve fallback.

**Architecture:** Preserve the current Dashboard lifecycle and exact PID/PGID stop path. Remove only proven PID-1 test brokers, repair stale startup evidence with a regression test, then start in two bounded stages: existing 32 GiB reserve first and explicit 29 GiB reserve only after a recorded preflight rejection.

**Tech Stack:** Bash launch/stop scripts, DS4 weight server, Python request guard, Express/Svelte Dashboard, Node test runner, systemd, `/proc`, `nvidia-smi`, Git.

## Global Constraints

- Hard floor is exactly `RAMGUARD_HARD_FLOOR_BYTES=1073741824`; breach is strict `MemAvailable < 1073741824`.
- Never use `pkill`, `killall`, wildcard process termination, or fuzzy PID selection.
- Never terminate a live Claude, Codex, Dashboard, Hermes, Tailscale, or unrelated model process.
- Weight-server preflight remains enabled.
- Try the existing 32 GiB weight reserve first; use `--reserve-gb 29` only after that exact preflight fails for insufficient allocatable memory.
- Stop after one 29 GiB fallback attempt.
- Stop immediately on fresh kernel OOM, NVRM, Xid, CUDA error, exact-identity failure, or RamGuard breach.
- Canonical Markdown stays in `/home/mctdgx01/projects/DGXmodelmd`; raw evidence stays under `/home/mctdgx01/models/operation_records/`.

---

### Task 1: Create the operation record and capture immutable baselines

**Files:**
- Create: `/home/mctdgx01/models/operation_records/deepseek_one_gib_guarded_start_20260731/OPERATION_SUMMARY.md`
- Create: `/home/mctdgx01/projects/DGXmodelmd/DeepSeek-V4-Flash-Entrpi-DS4-DGX-Spark/logs/DEEPSEEK_ONE_GIB_GUARDED_START_20260731.md`

**Interfaces:**
- Consumes: deployed profile, launcher, stop script, model-control profile, runtime PID/PGID files.
- Produces: pre-change hashes, memory/kernel baselines, exact authorized mutation scope.

- [ ] **Step 1: Validate the canonical repository**

Run:

```bash
bash /home/mctdgx01/.codex/skills/write-dgx-model-md/scripts/validate_contract.sh
git -C /home/mctdgx01/projects/DGXmodelmd status --short
git -C /home/mctdgx01/projects/DGXmodelmd fetch origin main
git -C /home/mctdgx01/projects/DGXmodelmd rev-list --left-right --count main...origin/main
```

Expected: validator PASS, clean status, and `0 0`.

- [ ] **Step 2: Create raw and canonical pre-operation records**

Use `apply_patch` to record the approved scope, rollback, and status
`AUTHORIZED_IN_PROGRESS` in both exact paths above.

- [ ] **Step 3: Capture pre-change evidence**

Run:

```bash
sha256sum \
  /home/mctdgx01/bin/start_deepseek_v4_flash_ds4_best_245k.sh \
  /home/mctdgx01/bin/stop_deepseek_v4_flash_ds4_best_245k.sh \
  /home/mctdgx01/models/deepseek-v4-flash-ds4-clean-v0.4.2/dashboard/profile.env \
  /etc/dgx-model-control/models.d/deepseek-v4-flash-in240k-out32k.env
free -b
nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader,nounits
journalctl -k --since '2026-07-31 00:00:00' --no-pager |
  rg -i 'NVRM|Xid|out of memory|oom|killed process'
```

Expected: hashes captured, no active model compute process, and a kernel-event baseline.

### Task 2: Make failed startup evidence self-healing and set the 1 GiB floor

**Files:**
- Modify: `/home/mctdgx01/dgx-spark-status/test/ds4-dashboard-preset.test.js`
- Modify: `/home/mctdgx01/bin/start_deepseek_v4_flash_ds4_best_245k.sh`
- Modify: `/home/mctdgx01/models/deepseek-v4-flash-ds4-clean-v0.4.2/dashboard/profile.env`
- Modify: `/etc/dgx-model-control/models.d/deepseek-v4-flash-in240k-out32k.env`
- Modify: `/etc/vllm/models/deepseek-v4-flash-in240k-out32k.env`

**Interfaces:**
- Consumes: exact PID/PGID and broker-socket evidence.
- Produces: launcher behavior that removes stale dead evidence but refuses any live or ambiguous identity.

- [ ] **Step 1: Write failing launcher/config tests**

Add assertions that:

```js
assert.match(runtimeProfile, /^RAMGUARD_HARD_FLOOR_BYTES=1073741824$/m);
assert.match(runtimeProfile, /^RAMGUARD_BREACH_CONDITION="MemAvailable < 1073741824"$/m);
assert.match(controlConfig, /^MIN_AVAILABLE_RAM_GB=1$/m);
assert.match(inventoryConfig, /^RAMGUARD_HARD_FLOOR_BYTES=1073741824$/m);
assert.match(inventoryConfig, /^MIN_AVAILABLE_RAM_GB=1$/m);
assert.match(startScript, /stale weight-server evidence cleared/);
assert.match(startScript, /kill -0 "\$weight_pid"/);
```

The behavior requirement is: stale numeric PID/PGID files are removed only
when the PID is dead and the broker socket is absent; any live PID, PGID
mismatch, malformed evidence, or surviving socket remains a hard refusal.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
cd /home/mctdgx01/dgx-spark-status
node --test test/ds4-dashboard-preset.test.js
```

Expected: FAIL because the floor is 1.5 GiB and the launcher refuses stale evidence.

- [ ] **Step 3: Implement the minimal launcher/config change**

In the launcher, replace the stale-evidence refusal branch with exact
classification:

```bash
if valid numeric evidence and exact PID/PGID is alive and socket exists:
  reuse the weight server
elif PID is dead and socket is absent:
  remove only weight-server.pid and weight-server.pgid
  print "stale weight-server evidence cleared"
else:
  refuse start
```

Set the runtime and model-control values to exactly 1 GiB. Do not change the
weight reserve in this step.

- [ ] **Step 4: Run focused and full tests**

Run:

```bash
bash -n /home/mctdgx01/bin/start_deepseek_v4_flash_ds4_best_245k.sh
node --test test/ds4-dashboard-preset.test.js
npm test
```

Expected: focused test PASS and full Dashboard suite PASS.

- [ ] **Step 5: Commit the regression test**

```bash
git add test/ds4-dashboard-preset.test.js
git commit -m "test: cover DeepSeek one GiB guarded restart"
```

The deployed launcher/config hashes are recorded in Task 5 because they live
outside this Git repository.

### Task 3: Stop stale DeepSeek state and exact orphan test brokers

**Files:**
- Update: `/home/mctdgx01/models/operation_records/deepseek_one_gib_guarded_start_20260731/OPERATION_SUMMARY.md`

**Interfaces:**
- Consumes: exact process identity snapshot.
- Produces: verified memory reclaimed without touching live work.

- [ ] **Step 1: Run the exact DeepSeek stop command**

```bash
/home/mctdgx01/bin/stop_deepseek_v4_flash_ds4_best_245k.sh
```

Expected: all four component PID/PGID files absent, loopback ports 18081/18082
closed, and weight broker socket absent.

- [ ] **Step 2: Build and review the orphan allowlist**

Select processes only when all approved predicates match. Save exact
`pid pgid command` rows to the raw operation record before termination.

- [ ] **Step 3: Revalidate and terminate each exact orphan PGID**

For every saved row, reread `/proc/<pid>/stat` and `/proc/<pid>/cmdline`.
Terminate only when PID, PGID, PPID 1, command path, and
`/tmp/codex-plugin-test-*` working directory still match. Send TERM to that
exact negative PGID, wait boundedly, and report any survivor; do not escalate
to unrelated processes.

- [ ] **Step 4: Verify reclaimed memory and unrelated services**

Run:

```bash
free -b
systemctl is-active dgx-spark-status.service
tailscale status --json >/dev/null
ps -eo pid,ppid,pgid,args | rg 'claude|codex|hermes'
```

Expected: orphan brokers absent, Dashboard active, Tailscale readable, and
live Claude/Codex/Hermes processes preserved.

### Task 4: Start at reserve 32 and use one reserve-29 fallback if required

**Files:**
- Conditionally modify: `/home/mctdgx01/bin/start_deepseek_v4_flash_ds4_best_245k.sh`
- Update: `/home/mctdgx01/models/operation_records/deepseek_one_gib_guarded_start_20260731/OPERATION_SUMMARY.md`

**Interfaces:**
- Consumes: clean runtime state and 1 GiB guard.
- Produces: a healthy four-component preset or a safely stopped blocker.

- [ ] **Step 1: Capture immediate pre-start safety state**

Verify no other model process, candidate port, stale socket, fresh kernel
event, or unresolved component exists.

- [ ] **Step 2: Start through the Dashboard API with reserve 32**

```bash
curl -fsS -X POST \
  http://127.0.0.1:9000/api/model-control/start/deepseek-v4-flash-in240k-out32k
```

Poll Dashboard status and the runtime log at bounded intervals.

- [ ] **Step 3: Classify the result**

If healthy, skip the fallback. If the exact weight-server error is
`not enough allocatable CUDA memory for full upload plan plus reserve`, stop
exactly and proceed to Step 4. Any other error stops the plan and publishes a
blocker.

- [ ] **Step 4: Write a failing reserve-fallback test**

Add:

```js
assert.match(startScript, /--reserve-gb 29/);
```

Run the focused test and verify it fails because reserve 29 is absent.

- [ ] **Step 5: Add the single explicit fallback and verify tests**

Add `--reserve-gb 29` only to the weight-server invocation. Run `bash -n`,
focused tests, and `npm test`, then commit the test:

```bash
git add test/ds4-dashboard-preset.test.js
git commit -m "test: pin bounded DeepSeek weight reserve fallback"
```

- [ ] **Step 6: Retry once**

Start through the same Dashboard API. On failure, invoke the exact stop script,
verify complete closure, and do not tune further.

### Task 5: Validate the real service and publish evidence

**Files:**
- Update: `/home/mctdgx01/models/operation_records/deepseek_one_gib_guarded_start_20260731/OPERATION_SUMMARY.md`
- Update: `/home/mctdgx01/projects/DGXmodelmd/DeepSeek-V4-Flash-Entrpi-DS4-DGX-Spark/logs/DEEPSEEK_ONE_GIB_GUARDED_START_20260731.md`

**Interfaces:**
- Consumes: final runtime state and logs.
- Produces: reproducible local and remote evidence.

- [ ] **Step 1: Verify lifecycle and API**

Confirm exact PID/PGID for all four components, Dashboard `running`,
`/v1/models` model identity, and a small chat completion.

- [ ] **Step 2: Verify safety**

Record minimum MemAvailable, current MemAvailable, active reserve, and fresh
kernel OOM/NVRM/Xid delta. Any failure changes status to `SAFELY_STOPPED` or
`BLOCKED`, never PASS.

- [ ] **Step 3: Run final Dashboard verification**

```bash
cd /home/mctdgx01/dgx-spark-status
npm test
npm run build
git diff --check
```

Expected: all tests and build pass.

- [ ] **Step 4: Publish canonical evidence**

Fetch/reconcile `main`, stage only the canonical Markdown file, scan it for
secrets and files larger than 1 MiB, commit, push `main`, and verify local SHA
equals `git ls-remote origin refs/heads/main`.
