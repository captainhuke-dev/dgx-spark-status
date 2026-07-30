# DeepSeek Temporary Lower-Memory Context Test Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure whether temporary 64K and 128K DeepSeek contexts can start and answer a bounded request without a fresh NVIDIA allocation failure.

**Architecture:** Create an operation-owned launcher, profile, runtime directory, and exact stop path outside Git. Reuse the pinned model, source, no-MTP runtime, VMM weight manifest, request guard, and safety guard, but leave every production Dashboard/model-control file unchanged and keep the Dashboard restart marker armed.

**Tech Stack:** Bash, DS4 `ds4_weight_server`, DS4 `ds4-serve`, Python request guard, system kernel journal, NVIDIA SMI, curl, Markdown operation records.

## Global Constraints

- This is an isolated experiment, not a production preset change.
- Test 65,536 total context first and 131,072 total context only after the 65,536 stage passes.
- Use temporary `--reserve-gb 29` because the unchanged 32 GiB weight-server preflight rejects this machine before context allocation.
- Keep the production Dashboard no-automatic-restart marker armed.
- Do not modify Dashboard, model-control, inventory, production profile, production launcher, or Tailscale configuration.
- Bind only to `127.0.0.1`; do not add a tailnet route.
- Stop only exact recorded PID/PGID identities; never use broad process matching.
- Abort on any fresh NVRM, Xid, kernel OOM, CUDA OOM, identity mismatch, guard failure, or emergency memory breach.
- Every stage and the complete operation must end with all temporary components stopped.

---

### Task 1: Operation record and immutable baseline

**Files:**
- Create: `/home/mctdgx01/models/operation_records/deepseek_temporary_low_memory_context_test_20260731/OPERATION_SUMMARY.md`
- Create: `/home/mctdgx01/projects/DGXmodelmd/DeepSeek-V4-Flash-Entrpi-DS4-DGX-Spark/logs/DEEPSEEK_TEMPORARY_LOW_MEMORY_CONTEXT_TEST_20260731.md`

**Interfaces:**
- Consumes: approved design `docs/superpowers/specs/2026-07-31-deepseek-temporary-low-memory-context-test-design.md`
- Produces: pre-operation hashes, memory baseline, kernel cursor/count, and terminal evidence destinations

- [ ] **Step 1: Validate canonical identity and reconcile Git**

Run:

```bash
bash /home/mctdgx01/.codex/skills/write-dgx-model-md/scripts/validate_contract.sh
git -C /home/mctdgx01/projects/DGXmodelmd fetch origin
git -C /home/mctdgx01/projects/DGXmodelmd rev-list --left-right --count HEAD...origin/main
git -C /home/mctdgx01/projects/DGXmodelmd status --short
```

Expected: validator passes, local and remote counts are `0 0`, and no unrelated canonical changes exist.

- [ ] **Step 2: Capture production file hashes and stopped-state evidence**

Run:

```bash
sha256sum \
  /home/mctdgx01/bin/start_deepseek_v4_flash_ds4_best_245k.sh \
  /home/mctdgx01/bin/stop_deepseek_v4_flash_ds4_best_245k.sh \
  /home/mctdgx01/models/deepseek-v4-flash-ds4-clean-v0.4.2/dashboard/profile.env \
  /etc/dgx-model-control/models.d/deepseek-v4-flash-in240k-out32k.env \
  /etc/vllm/models/deepseek-v4-flash-in240k-out32k.env
curl -fsS http://127.0.0.1:9000/api/model-control/status/deepseek-v4-flash-in240k-out32k
nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader
ss -ltnp
awk '/^MemAvailable:/ {print $2 * 1024}' /proc/meminfo
journalctl -k --since '2026-07-31 00:00:00' --no-pager
```

Expected: production status is stopped, all four managed components are inactive, no NVIDIA compute process exists, and loopback ports 18081/18082 are free.

- [ ] **Step 3: Write both pre-operation records**

Use `apply_patch` to record authorization, hashes, exact paths, free-port proof, current `MemAvailable`, kernel-event baseline, rollback, and `AUTHORIZED_IN_PROGRESS`. Do not copy raw kernel logs into Git.

- [ ] **Step 4: Validate Markdown scope**

Run:

```bash
git -C /home/mctdgx01/projects/DGXmodelmd diff --check
git -C /home/mctdgx01/projects/DGXmodelmd status --short
```

Expected: only the intended canonical test record is new or modified.

### Task 2: Temporary launcher and static safety tests

**Files:**
- Create: `/home/mctdgx01/models/operation_records/deepseek_temporary_low_memory_context_test_20260731/profile.env`
- Create: `/home/mctdgx01/models/operation_records/deepseek_temporary_low_memory_context_test_20260731/start_stage.sh`
- Create: `/home/mctdgx01/models/operation_records/deepseek_temporary_low_memory_context_test_20260731/stop_exact.sh`
- Create: `/home/mctdgx01/models/operation_records/deepseek_temporary_low_memory_context_test_20260731/static_test.sh`

**Interfaces:**
- Consumes: one stage context argument, either `65536` or `131072`
- Produces: operation-owned `runtime-<context>/` with exact PID/PGID files and logs

- [ ] **Step 1: Write static checks before the launcher**

Create `static_test.sh` with assertions that:

```bash
grep -q -- '--reserve-gb 29' "$op/start_stage.sh"
grep -q '127.0.0.1' "$op/profile.env"
grep -q 'kill -- \"-$pgid\"' "$op/stop_exact.sh"
! grep -Eq 'pkill|killall|0\\.0\\.0\\.0|tailscale' "$op/start_stage.sh" "$op/stop_exact.sh"
```

It must also compare the five production SHA-256 values to Task 1.

- [ ] **Step 2: Run the static test and verify it fails**

Run:

```bash
bash /home/mctdgx01/models/operation_records/deepseek_temporary_low_memory_context_test_20260731/static_test.sh
```

Expected: failure because the temporary launcher, profile, and stop script do not yet exist.

- [ ] **Step 3: Create the minimal operation-owned runtime**

Use `apply_patch` to create:

- a localhost-only profile using the pinned source/model/manifest and the existing 1.5 GiB hard floor;
- `start_stage.sh`, accepting only `65536` or `131072`, starting the weight server with `--reserve-gb 29`, then request guard, memory guard, and `ds4-serve --no-mtp -c "$context" -n 8192`;
- `stop_exact.sh`, validating each numeric PID/PGID pair and stopping only its matching process group;
- kernel-baseline and minimum-`MemAvailable` capture in the stage runtime directory.

The launcher must refuse occupied loopback ports, any NVIDIA compute process, an unarmed guard, or incomplete PID/PGID evidence.

- [ ] **Step 4: Run static safety tests**

Run:

```bash
bash /home/mctdgx01/models/operation_records/deepseek_temporary_low_memory_context_test_20260731/static_test.sh
bash -n /home/mctdgx01/models/operation_records/deepseek_temporary_low_memory_context_test_20260731/start_stage.sh
bash -n /home/mctdgx01/models/operation_records/deepseek_temporary_low_memory_context_test_20260731/stop_exact.sh
```

Expected: all commands exit zero and production hashes remain unchanged.

### Task 3: Execute and validate the 64K smoke stage

**Files:**
- Modify: `/home/mctdgx01/models/operation_records/deepseek_temporary_low_memory_context_test_20260731/OPERATION_SUMMARY.md`
- Create: `/home/mctdgx01/models/operation_records/deepseek_temporary_low_memory_context_test_20260731/runtime-65536/*`

**Interfaces:**
- Consumes: `start_stage.sh 65536`
- Produces: healthy/failed stage result, API evidence, minimum memory, and kernel-event delta

- [ ] **Step 1: Recheck the live safety baseline**

Run the stopped-state, free-loopback-port, NVIDIA-process, `MemAvailable`, and kernel-event checks from Task 1 immediately before launch.

Expected: no heavyweight runtime appeared and the candidate ports remain free.

- [ ] **Step 2: Start the 64K stage**

Run:

```bash
/home/mctdgx01/models/operation_records/deepseek_temporary_low_memory_context_test_20260731/start_stage.sh 65536
```

Expected: the request-guard `/v1/models` endpoint becomes healthy or the exact safety stop runs automatically.

- [ ] **Step 3: Validate identity, context, and bounded inference**

Run bounded requests:

```bash
curl -fsS --max-time 10 http://127.0.0.1:18082/v1/models
curl -fsS --max-time 10 http://127.0.0.1:18081/v1/stats
curl -fsS --max-time 180 \
  -H 'Content-Type: application/json' \
  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"Reply with exactly: OK"}],"max_tokens":8,"stream":false}' \
  http://127.0.0.1:18082/v1/chat/completions
```

Expected: correct model identity, reported context 65,536, a bounded response, and no guard bypass.

- [ ] **Step 4: Check kernel delta and stop exactly**

Run the stage kernel-delta check, then:

```bash
/home/mctdgx01/models/operation_records/deepseek_temporary_low_memory_context_test_20260731/stop_exact.sh 65536
```

Expected: zero fresh kernel events for a passing stage; regardless of result, all stage PID/PGID identities are dead and loopback ports are closed.

- [ ] **Step 5: Record the terminal 64K result**

Use `apply_patch` to append context, reported `max_seq`, API result, minimum `MemAvailable`, kernel delta, exact-stop result, and `PASS_64K` or `SAFELY_STOPPED_64K`.

### Task 4: Execute 128K only after a clean 64K pass

**Files:**
- Modify: `/home/mctdgx01/models/operation_records/deepseek_temporary_low_memory_context_test_20260731/OPERATION_SUMMARY.md`
- Create: `/home/mctdgx01/models/operation_records/deepseek_temporary_low_memory_context_test_20260731/runtime-131072/*`

**Interfaces:**
- Consumes: explicit `PASS_64K` with zero kernel-event delta
- Produces: terminal 128K evidence or a documented skip

- [ ] **Step 1: Enforce the stage gate**

Run:

```bash
grep -q '^64K_RESULT=PASS_64K$' /home/mctdgx01/models/operation_records/deepseek_temporary_low_memory_context_test_20260731/OPERATION_SUMMARY.md
```

Expected: exit zero. If not, record `128K_RESULT=SKIPPED_AFTER_64K_FAILURE` and do not launch.

- [ ] **Step 2: Repeat the live baseline and start 128K**

After proving the 64K stage is fully stopped, run:

```bash
/home/mctdgx01/models/operation_records/deepseek_temporary_low_memory_context_test_20260731/start_stage.sh 131072
```

Expected: guarded endpoint becomes healthy or exact safety stop runs.

- [ ] **Step 3: Repeat identity, context, bounded inference, and kernel checks**

Use the Task 3 requests and require reported context 131,072. Capture minimum `MemAvailable` and the stage-specific kernel delta.

- [ ] **Step 4: Stop exactly and record the terminal result**

Run:

```bash
/home/mctdgx01/models/operation_records/deepseek_temporary_low_memory_context_test_20260731/stop_exact.sh 131072
```

Record `PASS_128K` or `SAFELY_STOPPED_128K`, including exact evidence.

### Task 5: Final verification and publication

**Files:**
- Modify: `/home/mctdgx01/models/operation_records/deepseek_temporary_low_memory_context_test_20260731/OPERATION_SUMMARY.md`
- Modify: `/home/mctdgx01/projects/DGXmodelmd/DeepSeek-V4-Flash-Entrpi-DS4-DGX-Spark/logs/DEEPSEEK_TEMPORARY_LOW_MEMORY_CONTEXT_TEST_20260731.md`

**Interfaces:**
- Consumes: terminal evidence from both stages
- Produces: sanitized recommendation with production unchanged

- [ ] **Step 1: Prove final stopped state and production integrity**

Run:

```bash
curl -fsS http://127.0.0.1:9000/api/model-control/status/deepseek-v4-flash-in240k-out32k
nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader
ss -ltnp
sha256sum \
  /home/mctdgx01/bin/start_deepseek_v4_flash_ds4_best_245k.sh \
  /home/mctdgx01/bin/stop_deepseek_v4_flash_ds4_best_245k.sh \
  /home/mctdgx01/models/deepseek-v4-flash-ds4-clean-v0.4.2/dashboard/profile.env \
  /etc/dgx-model-control/models.d/deepseek-v4-flash-in240k-out32k.env \
  /etc/vllm/models/deepseek-v4-flash-in240k-out32k.env
```

Expected: Dashboard still reports stopped, all four components inactive, no temporary compute process or loopback listener remains, the restart marker remains armed, and all five production hashes equal Task 1.

- [ ] **Step 2: Write sanitized terminal summaries**

Use `apply_patch` to report both stage outcomes, minimum memory, kernel deltas, API validation, exact stop, and the evidence-based recommendation. Do not label temporary values as production.

- [ ] **Step 3: Run final verification**

Run:

```bash
npm test
npm run build
git diff --check
bash /home/mctdgx01/.codex/skills/write-dgx-model-md/scripts/validate_contract.sh
```

Expected: tests and build exit zero, diff check is clean, and canonical validator passes.

- [ ] **Step 4: Publish only the canonical Markdown**

Fetch and reconcile `origin/main`, stage only
`DeepSeek-V4-Flash-Entrpi-DS4-DGX-Spark/logs/DEEPSEEK_TEMPORARY_LOW_MEMORY_CONTEXT_TEST_20260731.md`,
scan the staged diff for secrets and files larger than 1 MiB, commit, push
`main`, and verify `git ls-remote origin refs/heads/main` equals local `HEAD`.
