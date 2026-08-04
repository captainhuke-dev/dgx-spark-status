from __future__ import annotations

import argparse
import copy
import contextlib
import json
import os
import shlex
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

try:
    import fcntl
except ImportError:  # pragma: no cover - the package targets Linux/systemd hosts
    fcntl = None


ROUTE_PORT = 56827
GUARD_PORT = 56828
LAN_BIND_ADDRESS = '192.168.0.21'
EXPECTED_TARGET = '127.0.0.1:56828'
RUNTIME_ROOT = '/home/mctdgx01/.local/lib/dgx-unsloth-exposure'
USER_UNIT_ROOT = '/home/mctdgx01/.config/systemd/user'
GUARD_UNIT_NAME = 'dgx-unsloth-guard.service'
LAN_PROXY_UNIT_NAME = 'dgx-unsloth-lan-proxy.service'
DEFAULT_STATE_FILE = '/home/mctdgx01/.local/state/dgx-unsloth-exposure/active-operation.env'


@dataclass(frozen=True, slots=True)
class RouteStatus:
    status: str
    existing_target: str | None


class RouteConflict(RuntimeError):
    pass


class SubprocessRunner:
    def run(self, argv: list[str]) -> int:
        subprocess.run(argv, check=True)
        return 0


def _strip_target_scheme(value: str) -> str:
    result = value.strip()
    if result.startswith('tcp://'):
        result = result[len('tcp://') :]
    return result.rstrip('/')


def _extract_tcp_entries(document: Any) -> dict[str, str]:
    routes: dict[str, str] = {}
    if not isinstance(document, dict):
        return routes

    tcp_map = document.get('TCP')
    if isinstance(tcp_map, dict):
        for port, value in tcp_map.items():
            target = _target_from_tcp_value(value)
            if target is not None:
                routes[str(port)] = target

    nested_tcp_map = document.get('ServeConfig')
    if isinstance(nested_tcp_map, dict):
        routes.update(_extract_tcp_entries(nested_tcp_map))

    for services_key in ('services', 'Services'):
        services = document.get(services_key)
        if not isinstance(services, dict):
            continue
        for service in services.values():
            if not isinstance(service, dict):
                continue
            endpoints = service.get('endpoints')
            if not isinstance(endpoints, dict):
                continue
            for endpoint_key, endpoint_value in endpoints.items():
                if not isinstance(endpoint_key, str) or not endpoint_key.startswith('tcp:'):
                    continue
                port = endpoint_key.split(':', 1)[1]
                if isinstance(endpoint_value, str):
                    routes[str(port)] = _strip_target_scheme(endpoint_value)
    return routes


def _target_from_tcp_value(value: Any) -> str | None:
    if isinstance(value, str):
        return _strip_target_scheme(value)
    if isinstance(value, dict):
        for key in ('TCPForward', 'Forward', 'Target'):
            candidate = value.get(key)
            if isinstance(candidate, str):
                return _strip_target_scheme(candidate)
    return None


def normalize_serve_json(document: Any) -> Any:
    def normalize_node(node: Any) -> Any:
        if isinstance(node, dict):
            normalized: dict[str, Any] = {}
            for key in sorted(node):
                value = node[key]
                if key == 'TCP' and isinstance(value, dict):
                    tcp_normalized: dict[str, Any] = {}
                    for port in sorted(value, key=lambda item: int(str(item)) if str(item).isdigit() else str(item)):
                        target = _target_from_tcp_value(value[port])
                        if target is None:
                            tcp_normalized[str(port)] = normalize_node(value[port])
                        else:
                            tcp_normalized[str(port)] = {'TCPForward': target}
                    normalized[key] = tcp_normalized
                elif key == 'endpoints' and isinstance(value, dict):
                    endpoint_normalized: dict[str, Any] = {}
                    for endpoint_key in sorted(value):
                        endpoint_value = value[endpoint_key]
                        if isinstance(endpoint_key, str) and endpoint_key.startswith('tcp:') and isinstance(endpoint_value, str):
                            endpoint_normalized[endpoint_key] = _strip_target_scheme(endpoint_value)
                        else:
                            endpoint_normalized[endpoint_key] = normalize_node(endpoint_value)
                    normalized[key] = endpoint_normalized
                else:
                    normalized[key] = normalize_node(value)
            return normalized
        if isinstance(node, list):
            return [normalize_node(item) for item in node]
        return node

    return normalize_node(copy.deepcopy(document))


def _without_managed_tcp_route(document: Any, *, port: int = ROUTE_PORT) -> Any:
    managed_port = str(port)

    def remove_node(node: Any) -> Any:
        if isinstance(node, dict):
            cleaned: dict[str, Any] = {}
            for key, value in node.items():
                if key == 'TCP' and isinstance(value, dict):
                    tcp_map = {
                        str(route_port): remove_node(route_value)
                        for route_port, route_value in value.items()
                        if str(route_port) != managed_port
                    }
                    if tcp_map:
                        cleaned[key] = tcp_map
                    continue
                if key == 'endpoints' and isinstance(value, dict):
                    endpoints = {
                        endpoint_key: remove_node(endpoint_value)
                        for endpoint_key, endpoint_value in value.items()
                        if endpoint_key != f'tcp:{managed_port}'
                    }
                    if endpoints:
                        cleaned[key] = endpoints
                    continue
                cleaned[key] = remove_node(value)
            return cleaned
        if isinstance(node, list):
            return [remove_node(item) for item in node]
        return node

    return remove_node(copy.deepcopy(document))


def normalized_complete_route_map(document: Any, *, port: int = ROUTE_PORT) -> Any:
    return normalize_serve_json(_without_managed_tcp_route(document, port=port))


def assert_unrelated_routes_unchanged(before: Any, after: Any, *, port: int = ROUTE_PORT) -> None:
    if normalized_complete_route_map(before, port=port) != normalized_complete_route_map(after, port=port):
        raise RouteConflict(
            f'Refusing TCP {port} route result because unrelated Serve routes changed.'
        )


def classify_tcp_route(document: Any, *, port: int = ROUTE_PORT, expected_target: str = EXPECTED_TARGET) -> RouteStatus:
    current = _extract_tcp_entries(document).get(str(port))
    if current is None:
        return RouteStatus(status='absent', existing_target=None)
    if _strip_target_scheme(current) == _strip_target_scheme(expected_target):
        return RouteStatus(status='matching', existing_target=_strip_target_scheme(current))
    return RouteStatus(status='conflicting', existing_target=_strip_target_scheme(current))


def add_tcp_route(document: Any, *, port: int = ROUTE_PORT, expected_target: str = EXPECTED_TARGET) -> Any:
    classification = classify_tcp_route(document, port=port, expected_target=expected_target)
    if classification.status == 'conflicting':
        raise RouteConflict(
            f'Existing TCP {port} route points to {classification.existing_target}, not {expected_target}.'
        )
    updated = copy.deepcopy(document)
    if not isinstance(updated, dict):
        updated = {}
    tcp_map = updated.setdefault('TCP', {})
    if not isinstance(tcp_map, dict):
        raise RouteConflict('Serve JSON TCP mapping is not writable.')
    tcp_map[str(port)] = {'TCPForward': _strip_target_scheme(expected_target)}
    return updated


def remove_tcp_route(document: Any, *, port: int = ROUTE_PORT, expected_target: str = EXPECTED_TARGET) -> Any:
    classification = classify_tcp_route(document, port=port, expected_target=expected_target)
    if classification.status == 'conflicting':
        raise RouteConflict(
            f'Existing TCP {port} route points to {classification.existing_target}, not {expected_target}.'
        )
    updated = copy.deepcopy(document)
    if not isinstance(updated, dict):
        return {}
    tcp_map = updated.get('TCP')
    if isinstance(tcp_map, dict):
        tcp_map.pop(str(port), None)
        if not tcp_map:
            updated.pop('TCP', None)
    return updated


def ensure_tcp_route(
    document: Any,
    *,
    runner,
    port: int = ROUTE_PORT,
    expected_target: str = EXPECTED_TARGET,
) -> RouteStatus:
    classification = classify_tcp_route(document, port=port, expected_target=expected_target)
    if classification.status == 'conflicting':
        raise RouteConflict(
            f'Existing TCP {port} route points to {classification.existing_target}, not {expected_target}.'
        )
    if classification.status == 'absent':
        runner.run(['tailscale', 'serve', '--bg', f'--tcp={port}', _strip_target_scheme(expected_target)])
    return classification


def _write_state(state_file: Path, **entries: str) -> None:
    state_file.parent.mkdir(parents=True, exist_ok=True)
    existing: dict[str, str] = {}
    if state_file.exists():
        for raw_line in state_file.read_text().splitlines():
            if '=' not in raw_line:
                continue
            key, value = raw_line.split('=', 1)
            existing[key] = value
    for key, value in entries.items():
        existing[key] = shlex.quote(value)
    ordered = ''.join(f'{key}={existing[key]}\n' for key in sorted(existing))
    file_descriptor, temporary_name = tempfile.mkstemp(
        dir=state_file.parent,
        prefix=f'.{state_file.name}.',
        text=True,
    )
    temporary_path = Path(temporary_name)
    try:
        with os.fdopen(file_descriptor, 'w') as temporary_file:
            temporary_file.write(ordered)
            temporary_file.flush()
            os.fsync(temporary_file.fileno())
        os.replace(temporary_path, state_file)
        directory_flags = os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0)
        directory_descriptor = os.open(state_file.parent, directory_flags)
        try:
            os.fsync(directory_descriptor)
        finally:
            os.close(directory_descriptor)
    finally:
        if temporary_path.exists():
            temporary_path.unlink()


def _read_state(state_file: Path) -> dict[str, str]:
    if not state_file.exists():
        return {}
    data: dict[str, str] = {}
    for raw_line in state_file.read_text().splitlines():
        if '=' not in raw_line:
            continue
        key, value = raw_line.split('=', 1)
        data[key] = shlex.split(value)[0] if value else ''
    return data


def _state_claims_route_ownership(state: dict[str, str]) -> bool:
    targets_expected_route = (
        state.get('ROUTE_PORT') == str(ROUTE_PORT)
        and _strip_target_scheme(state.get('ROUTE_TARGET', ''))
        == _strip_target_scheme(EXPECTED_TARGET)
    )
    if not targets_expected_route or state.get('ROUTE_REMOVED', '0') == '1':
        return False
    return state.get('ROUTE_CREATED') == '1'


def _record_route_state(
    state_file: Path,
    *,
    created: bool,
    preexisting: bool,
    pending: bool,
    removed: bool = False,
    reconciliation: str = '',
    observed_status: str = '',
) -> None:
    _write_state(
        state_file,
        ROUTE_CREATED='1' if created else '0',
        ROUTE_PREEXISTING='1' if preexisting else '0',
        ROUTE_PENDING='1' if pending else '0',
        ROUTE_PORT=str(ROUTE_PORT),
        ROUTE_TARGET=EXPECTED_TARGET,
        ROUTE_REMOVED='1' if removed else '0',
        ROUTE_RECONCILIATION=reconciliation,
        ROUTE_OBSERVED_STATUS=observed_status,
    )


def _compensate_created_route(evidence_dir: Path, runner, before_document: Any) -> None:
    current_document = _capture_evidence(evidence_dir, 'compensation-pre-off')
    current = classify_tcp_route(current_document)
    if current.status == 'conflicting':
        raise RouteConflict(
            f'Refusing compensation because TCP {ROUTE_PORT} was replaced by '
            f'{current.existing_target}.'
        )
    if current.status == 'matching':
        assert_unrelated_routes_unchanged(before_document, current_document)
        runner.run(['tailscale', 'serve', '--bg', f'--tcp={ROUTE_PORT}', 'off'])
        verified_document = _capture_evidence(evidence_dir, 'compensation-post-off')
        verified = classify_tcp_route(verified_document)
        if verified.status != 'absent':
            raise RouteConflict(
                f'Compensated TCP {ROUTE_PORT} route was not verified absent.'
            )
        assert_unrelated_routes_unchanged(before_document, verified_document)
        return
    assert_unrelated_routes_unchanged(before_document, current_document)


def _require_reconciled_route_state(state: dict[str, str]) -> None:
    if state.get('ROUTE_PENDING', '0') == '1':
        raise RouteConflict(
            'ROUTE_PENDING=1 records an interrupted route operation; '
            'operator reconciliation is required.'
        )


@contextlib.contextmanager
def _exclusive_route_lock(lock_file: Path):
    if fcntl is None:
        raise RouteConflict('Exclusive package route locking is unavailable on this host.')
    lock_file.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(lock_file, os.O_CREAT | os.O_RDWR, 0o600)
    with os.fdopen(descriptor, 'a+') as handle:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def _create_evidence_session(evidence_dir: Path, command: str) -> Path:
    evidence_dir.mkdir(parents=True, exist_ok=True)
    return Path(tempfile.mkdtemp(prefix=f'{command}-', dir=evidence_dir))


def _capture_command_output(evidence_dir: Path, name: str, argv: list[str], *, check: bool = False) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(argv, capture_output=True, text=True, check=False)
    evidence_dir.mkdir(parents=True, exist_ok=True)
    output = result.stdout if result.stdout else result.stderr
    with evidence_dir.joinpath(name).open('x') as evidence_file:
        evidence_file.write(output)
    if check and result.returncode != 0:
        raise subprocess.CalledProcessError(result.returncode, argv, output=result.stdout, stderr=result.stderr)
    return result


def _load_serve_document(evidence_dir: Path) -> Any:
    status_result = _capture_command_output(
        evidence_dir,
        'tailscale-serve-status.json',
        ['tailscale', 'serve', 'status', '--json'],
        check=True,
    )
    status_document = json.loads(status_result.stdout)
    config_result = _capture_command_output(
        evidence_dir,
        'tailscale-serve-get-config-all.json',
        ['tailscale', 'serve', 'get-config', '--all'],
        check=False,
    )
    if _extract_tcp_entries(status_document):
        return status_document
    if config_result.returncode == 0 and config_result.stdout.strip():
        config_document = json.loads(config_result.stdout)
        if _extract_tcp_entries(config_document):
            return config_document
    return status_document


def _capture_evidence(evidence_dir: Path, phase: str = 'snapshot') -> Any:
    phase_dir = evidence_dir / phase
    _capture_command_output(phase_dir, 'tailscale-version.txt', ['tailscale', 'version'], check=True)
    _capture_command_output(phase_dir, 'tailscale-status.json', ['tailscale', 'status', '--json'], check=True)
    _capture_command_output(phase_dir, 'tailscale-ipv4.txt', ['tailscale', 'ip', '-4'], check=True)
    _capture_command_output(phase_dir, 'tailscale-ipv6.txt', ['tailscale', 'ip', '-6'], check=False)
    _capture_command_output(phase_dir, 'tailscale-serve-help.txt', ['tailscale', 'serve', '--help'], check=True)
    return _load_serve_document(phase_dir)


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            'Classify and mutate the exact DGX Unsloth Tailscale Serve TCP 56827 route '
            f'for {LAN_BIND_ADDRESS} via {EXPECTED_TARGET} under {RUNTIME_ROOT} and {USER_UNIT_ROOT}.'
        )
    )
    subparsers = parser.add_subparsers(dest='command', required=True)

    def add_common_arguments(subparser: argparse.ArgumentParser) -> None:
        subparser.add_argument('--state-file', default=DEFAULT_STATE_FILE)
        subparser.add_argument('--evidence-dir', required=True)

    add_common_arguments(subparsers.add_parser('preflight'))
    add_common_arguments(subparsers.add_parser('ensure'))
    add_common_arguments(subparsers.add_parser('remove'))
    reconcile = subparsers.add_parser('reconcile')
    add_common_arguments(reconcile)
    reconcile.add_argument('--resolution', required=True, choices=('preserve-current',))
    return parser.parse_args(argv)


def _main_locked(args: argparse.Namespace) -> int:
    state_file = Path(args.state_file)
    evidence_dir = _create_evidence_session(Path(args.evidence_dir), args.command)
    state = _read_state(state_file)
    runner = SubprocessRunner()

    if args.command == 'reconcile':
        if state.get('ROUTE_PENDING', '0') != '1':
            raise RouteConflict('No interrupted ROUTE_PENDING=1 operation requires reconciliation.')
        serve_document = _capture_evidence(evidence_dir, 'reconcile-observed')
        classification = classify_tcp_route(serve_document)
        _record_route_state(
            state_file,
            created=False,
            preexisting=classification.status == 'matching',
            pending=False,
            removed=classification.status == 'absent',
            reconciliation=args.resolution,
            observed_status=classification.status,
        )
        return 0

    _require_reconciled_route_state(state)
    serve_document = _capture_evidence(evidence_dir, 'pre-change')

    if args.command == 'preflight':
        classification = classify_tcp_route(serve_document)
        if classification.status == 'conflicting':
            raise RouteConflict(
                f'Existing TCP {ROUTE_PORT} route points to {classification.existing_target}, not {EXPECTED_TARGET}.'
            )
        return 0

    if args.command == 'ensure':
        classification = classify_tcp_route(serve_document)
        if classification.status == 'conflicting':
            raise RouteConflict(
                f'Existing TCP {ROUTE_PORT} route points to {classification.existing_target}, not {EXPECTED_TARGET}.'
            )
        route_was_owned = _state_claims_route_ownership(state)
        if classification.status == 'matching':
            _record_route_state(
                state_file,
                created=route_was_owned,
                preexisting=not route_was_owned,
                pending=False,
            )
            return 0

        _record_route_state(
            state_file,
            created=False,
            preexisting=False,
            pending=True,
        )
        route_add_attempted = False
        try:
            current_document = _capture_evidence(evidence_dir, 'ensure-pre-add')
            current = classify_tcp_route(current_document)
            if current.status != 'absent':
                raise RouteConflict(
                    f'Refusing TCP {ROUTE_PORT} mutation because a {current.status} route '
                    'appeared before add; explicit operator reconciliation is required.'
            )
            assert_unrelated_routes_unchanged(serve_document, current_document)
            route_add_attempted = True
            ensure_tcp_route(current_document, runner=runner)
            verified_document = _capture_evidence(evidence_dir, 'post-change')
            verified = classify_tcp_route(verified_document)
            if verified.status != 'matching':
                raise RouteConflict(
                    f'Added TCP {ROUTE_PORT} route was not verified at exact target {EXPECTED_TARGET}.'
                )
            assert_unrelated_routes_unchanged(serve_document, verified_document)
            _record_route_state(
                state_file,
                created=True,
                preexisting=False,
                pending=False,
            )
        except BaseException as exc:
            if not route_add_attempted:
                raise
            try:
                _compensate_created_route(evidence_dir, runner, serve_document)
                _record_route_state(
                    state_file,
                    created=False,
                    preexisting=False,
                    pending=False,
                    removed=True,
                )
            except BaseException as compensation_error:
                exc.add_note(
                    'Exact route compensation or compensated-state persistence '
                    f'also failed: {compensation_error}'
                )
                raise exc from compensation_error
            raise
        return 0

    route_created = _state_claims_route_ownership(state)
    classification = classify_tcp_route(serve_document)
    route_removed = state.get('ROUTE_REMOVED', '0') == '1'
    if route_created:
        if classification.status == 'conflicting':
            raise RouteConflict(
                f'Refusing removal because TCP {ROUTE_PORT} was replaced by '
                f'{classification.existing_target}.'
            )
        current_document = _capture_evidence(evidence_dir, 'remove-pre-off')
        current = classify_tcp_route(current_document)
        if current.status == 'conflicting':
            raise RouteConflict(
                f'Refusing removal because TCP {ROUTE_PORT} was replaced by '
                f'{current.existing_target}.'
            )
        if classification.status == 'absent' and current.status == 'matching':
            raise RouteConflict(
                f'Refusing removal because a replacement matching TCP {ROUTE_PORT} route appeared.'
            )
        if current.status == 'matching':
            assert_unrelated_routes_unchanged(serve_document, current_document)
            runner.run(['tailscale', 'serve', '--bg', f'--tcp={ROUTE_PORT}', 'off'])
            verified_document = _capture_evidence(evidence_dir, 'post-change')
        else:
            verified_document = current_document
        verified = classify_tcp_route(verified_document)
        if verified.status != 'absent':
            raise RouteConflict(
                f'Removed TCP {ROUTE_PORT} route was not verified absent.'
            )
        assert_unrelated_routes_unchanged(serve_document, verified_document)
        route_removed = True
    _record_route_state(
        state_file,
        created=route_created,
        preexisting=state.get('ROUTE_PREEXISTING', '0') == '1',
        pending=False,
        removed=route_removed,
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    state_file = Path(args.state_file)
    lock_file = state_file.with_suffix('.lock')
    with _exclusive_route_lock(lock_file):
        return _main_locked(args)


if __name__ == '__main__':
    raise SystemExit(main())
