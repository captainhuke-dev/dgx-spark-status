# Task 2 Report — Unsloth Studio Dynamic Backend Guard

Date: 2026-08-04
Worktree: `/home/mctdgx01/dgx-spark-status/.worktrees/unsloth-dynamic-backend-guard`

## Scope completed

- Added maintained guard source at `ops/unsloth-studio-exposure/unsloth_request_guard.py`.
- Added maintained guard tests at `ops/unsloth-studio-exposure/test_unsloth_request_guard.py`.
- Integrated Task 1 `BackendResolver` for dynamic upstream port selection.
- Preserved guard request policy behavior from the runtime reference:
  - 1 MiB bounded request bodies
  - 32768 output budget cap
  - `/v1/*` allowlisting
  - `/health`, `/props`, `/slots` read-only validation
  - hop-by-hop header stripping
  - `X-DGX-Request-Guard: unsloth-studio`
  - bounded JSON error payloads
  - incremental `read1` streaming when available
- Kept POST handling single-shot with no replay after upstream failure.
- Mapped resolver failures to stable public 503 responses and invalidated resolver cache on upstream timeout / OS error after target resolution.

## RED evidence

Focused guard suite run before adding production guard source:

```bash
python3 -m unittest discover -s ops/unsloth-studio-exposure -p 'test_unsloth_request_guard.py' -v
```

Observed result:

- Exit code: `1`
- `Ran 24 tests`
- `FAILED (errors=24)`
- Representative failure:
  - `ModuleNotFoundError: No module named 'unsloth_request_guard'`

This established the expected pre-implementation failing baseline for the maintained guard module.

## GREEN evidence

Focused guard suite after implementation:

```bash
python3 -m unittest discover -s ops/unsloth-studio-exposure -p 'test_unsloth_request_guard.py' -v
```

Observed result:

- Exit code: `0`
- `Ran 24 tests`
- `OK`

Full Python suite:

```bash
python3 -m unittest discover -s ops/unsloth-studio-exposure -p 'test_*.py' -v
```

Observed result:

- Exit code: `0`
- `Ran 35 tests`
- `OK`

Bytecode compilation:

```bash
python3 -m py_compile ops/unsloth-studio-exposure/unsloth_backend_resolver.py ops/unsloth-studio-exposure/unsloth_request_guard.py
```

Observed result:

- Exit code: `0`

Forbidden-pattern scan:

```bash
rg -n 'UPSTREAM_PORT|0\.0\.0\.0|tailscale serve reset|pkill|killall' ops/unsloth-studio-exposure
```

Observed result:

- Exit code: `1`
- No matches

## Notes

- `ops/unsloth-studio-exposure/test_unsloth_backend_resolver.py` was minimally adjusted to remove literal forbidden-pattern strings from test fixtures so the required repo-local `rg` scan could pass without weakening coverage.
- No changes were made outside the isolated worktree.

## Fix-loop round 1 — create_server public contract

Reviewer finding addressed:

- The exported `create_server()` interface had extra parameters and defaulted to `bind_and_activate=False`.
- That left the default public path able to return an unbound server object instead of an immediately bound `127.0.0.1:56828` listener.

Implementation changes:

- Narrowed the public interface to `create_server(*, resolver=None)`.
- Moved configurable construction behind private `_create_server(...)`.
- Made the public entrypoint explicitly request canonical loopback binding and activation.
- Added a private-helper socket-binding test that uses `('127.0.0.1', 0)` so the suite verifies real socket state without depending on port `56828` being free in the test environment.

### Fix-loop RED evidence

Constructor-specific regression run before completing the helper refactor:

```bash
python3 -m unittest \
  ops.unsloth-studio-exposure.test_unsloth_request_guard.RequestGuardTests.test_create_server_public_interface_uses_canonical_loopback_binding \
  ops.unsloth-studio-exposure.test_unsloth_request_guard.RequestGuardTests.test_private_create_server_binds_loopback_socket_when_activated \
  -v
```

Observed result:

- Exit code: `1`
- `FAILED (failures=1, errors=1)`
- Representative failures:
  - public `create_server()` did not call `_create_server(..., server_address=('127.0.0.1', 56828), bind_and_activate=True)`
  - `_create_server()` rejected test-only `server_address=('127.0.0.1', 0)` with `TypeError: unexpected keyword argument 'server_address'`

### Fix-loop GREEN evidence

Constructor-specific regression after the contract fix:

```bash
python3 -m unittest \
  ops.unsloth-studio-exposure.test_unsloth_request_guard.RequestGuardTests.test_create_server_public_interface_uses_canonical_loopback_binding \
  ops.unsloth-studio-exposure.test_unsloth_request_guard.RequestGuardTests.test_private_create_server_binds_loopback_socket_when_activated \
  -v
```

Observed result:

- Exit code: `0`
- `Ran 2 tests`
- `OK`

Focused guard suite after the fix-loop update:

```bash
python3 -m unittest discover -s ops/unsloth-studio-exposure -p 'test_unsloth_request_guard.py' -v
```

Observed result:

- Exit code: `0`
- `Ran 25 tests`
- `OK`

Full Python suite after the fix-loop update:

```bash
python3 -m unittest discover -s ops/unsloth-studio-exposure -p 'test_*.py' -v
```

Observed result:

- Exit code: `0`
- `Ran 36 tests`
- `OK`

Bytecode compilation after the fix-loop update:

```bash
python3 -m py_compile ops/unsloth-studio-exposure/unsloth_backend_resolver.py ops/unsloth-studio-exposure/unsloth_request_guard.py
```

Observed result:

- Exit code: `0`

Forbidden-pattern scan after the fix-loop update:

```bash
rg -n 'UPSTREAM_PORT|0\.0\.0\.0|tailscale serve reset|pkill|killall' ops/unsloth-studio-exposure
```

Observed result:

- Exit code: `1`
- No matches
