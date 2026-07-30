# DeepSeek temporary lower-memory context test design

Date: 2026-07-31  
Status: approved for temporary testing

## Goal

Determine whether reducing DeepSeek V4 Flash DS4 context allocation avoids the
fresh NVIDIA `NV_ERR_NO_MEMORY` failure seen at the 278,528-token production
preset. This is an isolated experiment, not a production preset change.

## Evidence and hypothesis

The failed 278,528-token launch imported an 80.77 GiB base VMM allocation plan
and 474 derived artifacts, then allocated 6,198.75 MiB of context buffers. The
runtime reduced concurrency from 32 to 8 sequences, but the kernel still emitted
four fresh NVIDIA allocation failures while `MemAvailable` remained 12.60 GiB.

Hypothesis: reducing context materially lowers the context and batch-bank
allocation pressure and may avoid the NVIDIA allocation failure. Lowering
RamGuard is not part of this test because the prior failure happened far above
that threshold.

## Considered approaches

1. Test only 128K. Fastest, but gives no diagnostic fallback if 128K still
   fails.
2. Test 64K, then 128K. Recommended: 64K is the bounded smoke tier; 128K is
   attempted only if 64K starts without a fresh kernel event.
3. Change the Dashboard preset directly to 128K. Rejected because the user
   explicitly said these are not final production values.

## Test architecture

- Keep Dashboard, model-control, inventory, and the 245K/32K production profile
  byte-for-byte unchanged.
- Keep the Dashboard no-automatic-restart marker armed.
- Launch from a temporary operation wrapper outside Git using the same pinned
  source, model, VMM weight manifest, no-MTP mode, localhost ports, request
  guard, and exact PID/PGID ownership.
- Stage A: 65,536 total context with a bounded output default.
- Stage B: 131,072 total context, only after Stage A is healthy and has zero
  fresh kernel events.
- Fully stop Stage A before Stage B; never reuse ambiguous process evidence.
- Do not expose a new endpoint through Tailscale and do not register a new
  Dashboard profile.

## Safety and terminal states

Before each model load:

- prove candidate loopback ports are free;
- prove no NVIDIA compute process or unrelated heavyweight model appeared;
- record `MemAvailable` and kernel-event baseline;
- arm the existing exact-stop memory/kernel guard;
- record exact PID and PGID for every component.

Abort the current stage immediately on a new NVRM, Xid, kernel OOM, CUDA OOM,
lost PID/PGID identity, guard failure, or emergency memory breach. Stop only the
recorded DeepSeek process groups. Do not use broad process matching.

Every stage ends stopped. A successful stage means the guarded endpoint becomes
healthy, model identity and reported context are correct, a minimal bounded API
request succeeds, no fresh kernel event appears, and exact stop is verified.

## Deliverables

- Raw operation evidence under
  `/home/mctdgx01/models/operation_records/deepseek_temporary_low_memory_context_test_20260731/`.
- Sanitized terminal summary in the existing canonical DeepSeek model folder.
- A recommendation based on measured minimum `MemAvailable`, kernel-event
  delta, reported context, and API result.
- No production preset mutation unless the user separately approves final
  values after reviewing the test result.
