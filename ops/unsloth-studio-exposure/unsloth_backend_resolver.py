from __future__ import annotations

import json
import os
import re
import shlex
import subprocess
import time
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


UNSLOTH_STUDIO_ROOT = '/home/mctdgx01/apps/unsloth-studio'
UNSLOTH_LLAMA_SERVER = f'{UNSLOTH_STUDIO_ROOT}/llama.cpp/llama-server'


@dataclass(frozen=True, slots=True)
class ProcessRecord:
    pid: int
    ppid: int
    start_time: str
    executable: str
    command: str


@dataclass(frozen=True, slots=True)
class ListenerRecord:
    pid: int
    host: str
    port: int


@dataclass(frozen=True, slots=True)
class ResolvedBackend:
    pid: int
    start_time: str
    executable: str
    port: int
    model_id: str
    resolved_at: float


class BackendError(RuntimeError):
    code = 'backend_error'

    def __init__(self, message):
        super().__init__(message)
        self.message = message


class BackendUnavailable(BackendError):
    code = 'backend_unavailable'


class BackendAmbiguous(BackendError):
    code = 'backend_ambiguous'


class RealInspector:
    def processes(self) -> list[ProcessRecord]:
        records: list[ProcessRecord] = []
        proc_root = Path('/proc')
        for proc_entry in proc_root.iterdir():
            if not proc_entry.name.isdigit():
                continue
            try:
                stat_text = (proc_entry / 'stat').read_text()
                ppid, start_time = _parse_proc_stat(stat_text)
                executable = os.readlink(proc_entry / 'exe')
                argv = _read_proc_argv(proc_entry / 'cmdline')
            except (FileNotFoundError, ProcessLookupError, PermissionError, OSError, ValueError):
                continue
            records.append(
                ProcessRecord(
                    pid=int(proc_entry.name),
                    ppid=ppid,
                    start_time=start_time,
                    executable=executable,
                    command=shlex.join(argv) if argv else executable,
                )
            )
        return records

    def listeners(self) -> list[ListenerRecord]:
        result = subprocess.run(
            ['ss', '-H', '-ltnp'],
            check=True,
            capture_output=True,
            text=True,
        )
        listeners: list[ListenerRecord] = []
        for line in result.stdout.splitlines():
            parts = line.split()
            if len(parts) < 7:
                continue
            host_port = _split_host_port(parts[4])
            if host_port is None:
                continue
            host, port = host_port
            for pid in _parse_ss_pids(parts[6]):
                listeners.append(ListenerRecord(pid=pid, host=host, port=port))
        return listeners

    def probe_models(self, port: int, timeout_seconds: float):
        request = urllib.request.Request(
            f'http://127.0.0.1:{port}/v1/models',
            method='GET',
        )
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            payload = json.loads(response.read().decode('utf-8'))
            return response.status, payload


class BackendResolver:
    def __init__(
        self,
        inspector: RealInspector | None = None,
        *,
        studio_root: str = UNSLOTH_STUDIO_ROOT,
        time_fn=time.time,
        cache_ttl_seconds: float = 2.0,
        probe_timeout_seconds: float = 2.0,
    ):
        self._inspector = inspector or RealInspector()
        self._studio_root = studio_root.rstrip('/')
        self._studio_llama_server = f'{self._studio_root}/llama.cpp/llama-server'
        self._time_fn = time_fn
        self._cache_ttl_seconds = cache_ttl_seconds
        self._probe_timeout_seconds = probe_timeout_seconds
        self._cached_backend: ResolvedBackend | None = None

    def invalidate(self) -> None:
        self._cached_backend = None

    def resolve(self) -> ResolvedBackend:
        now = float(self._time_fn())
        if self._cached_backend is not None:
            age = now - self._cached_backend.resolved_at
            if age < self._cache_ttl_seconds:
                return self._cached_backend

        resolved_candidates = self._discover_candidates(now)
        if not resolved_candidates:
            self.invalidate()
            raise BackendUnavailable('No ready Unsloth Studio backend found.')
        if len(resolved_candidates) > 1:
            self.invalidate()
            raise BackendAmbiguous('Multiple ready Unsloth Studio backends found.')

        self._cached_backend = resolved_candidates[0]
        return self._cached_backend

    def _discover_candidates(self, now: float) -> list[ResolvedBackend]:
        processes = self._inspector.processes()
        process_by_pid = {process.pid: process for process in processes}
        listeners_by_pid = _index_listeners(self._inspector.listeners())
        resolved: list[ResolvedBackend] = []

        for process in processes:
            if not self._is_candidate_process(process):
                continue
            if not self._has_studio_ancestor(process, process_by_pid):
                continue

            port = _parse_port_flag(process.command)
            if port is None:
                continue
            if not _owns_loopback_listener(process.pid, port, listeners_by_pid):
                continue

            try:
                status_code, payload = self._inspector.probe_models(
                    port,
                    self._probe_timeout_seconds,
                )
            except (OSError, ValueError, KeyError, json.JSONDecodeError):
                continue

            if status_code != 200:
                continue

            model_id = _extract_single_model_id(payload)
            if model_id is None:
                continue

            resolved.append(
                ResolvedBackend(
                    pid=process.pid,
                    start_time=process.start_time,
                    executable=process.executable,
                    port=port,
                    model_id=model_id,
                    resolved_at=now,
                )
            )

        return resolved

    def _is_candidate_process(self, process: ProcessRecord) -> bool:
        return os.path.normpath(process.executable) == self._studio_llama_server

    def _has_studio_ancestor(
        self,
        process: ProcessRecord,
        process_by_pid: dict[int, ProcessRecord],
    ) -> bool:
        current_pid = process.ppid
        seen: set[int] = set()
        while current_pid > 0 and current_pid not in seen:
            seen.add(current_pid)
            parent = process_by_pid.get(current_pid)
            if parent is None:
                return False
            if _path_within_root(parent.executable, self._studio_root):
                return True
            current_pid = parent.ppid
        return False


def _parse_proc_stat(stat_text: str) -> tuple[int, str]:
    close_paren = stat_text.rfind(')')
    if close_paren == -1:
        raise ValueError('Malformed /proc stat line.')
    rest = stat_text[close_paren + 2 :].split()
    if len(rest) < 20:
        raise ValueError('Incomplete /proc stat line.')
    return int(rest[1]), rest[19]


def _read_proc_argv(cmdline_path: Path) -> list[str]:
    raw = cmdline_path.read_bytes()
    return [part.decode('utf-8', errors='replace') for part in raw.split(b'\0') if part]


def _split_host_port(value: str) -> tuple[str, int] | None:
    try:
        host, port_text = value.rsplit(':', 1)
    except ValueError:
        return None
    if host.startswith('[') and host.endswith(']'):
        host = host[1:-1]
    if not port_text.isdigit():
        return None
    return host, int(port_text)


def _parse_ss_pids(process_field: str) -> Iterable[int]:
    for match in re.finditer(r'pid=(\d+)', process_field):
        yield int(match.group(1))


def _parse_port_flag(command: str) -> int | None:
    try:
        argv = shlex.split(command)
    except ValueError:
        return None
    for index, token in enumerate(argv):
        if token != '--port':
            continue
        if index + 1 >= len(argv):
            return None
        port_text = argv[index + 1]
        if not port_text.isdigit():
            return None
        port = int(port_text)
        if 1 <= port <= 65535:
            return port
        return None
    return None


def _index_listeners(listeners: Iterable[ListenerRecord]) -> dict[int, set[tuple[str, int]]]:
    indexed: dict[int, set[tuple[str, int]]] = {}
    for item in listeners:
        indexed.setdefault(item.pid, set()).add((item.host, item.port))
    return indexed


def _owns_loopback_listener(
    pid: int,
    port: int,
    listeners_by_pid: dict[int, set[tuple[str, int]]],
) -> bool:
    return ('127.0.0.1', port) in listeners_by_pid.get(pid, set())


def _extract_single_model_id(payload) -> str | None:
    data = payload.get('data')
    if not isinstance(data, list):
        return None
    distinct_ids = {
        item.get('id').strip()
        for item in data
        if isinstance(item, dict)
        and isinstance(item.get('id'), str)
        and item.get('id').strip()
    }
    if not distinct_ids:
        return None
    if len(distinct_ids) > 1:
        raise BackendAmbiguous('Multiple live model IDs reported by backend.')
    return next(iter(distinct_ids))


def _path_within_root(path: str, root: str) -> bool:
    normalized_path = os.path.normpath(path)
    normalized_root = os.path.normpath(root)
    return normalized_path == normalized_root or normalized_path.startswith(normalized_root + os.sep)
