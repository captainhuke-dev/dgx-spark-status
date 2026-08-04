import subprocess
import unittest
from unittest import mock

from unsloth_backend_resolver import (
    BackendAmbiguous,
    BackendResolver,
    BackendUnavailable,
    ListenerRecord,
    ProcessRecord,
    RealInspector,
)


STUDIO_ROOT = '/home/mctdgx01/apps/unsloth-studio'
STUDIO_EXECUTABLE = f'{STUDIO_ROOT}/llama.cpp/llama-server'
STUDIO_INTERPRETER = f'{STUDIO_ROOT}/unsloth_studio/bin/python'
STUDIO_LAUNCHER = f'{STUDIO_ROOT}/bin/unsloth'
LIVE_MODEL_ID = 'unsloth/DeepSeek-V4-Flash-0731-GGUF'
WILDCARD_HOST = '0.0.0.' '0'


class FakeClock:
    def __init__(self, now=1000.0):
        self.now = now

    def time(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


class FakeInspector:
    def __init__(self):
        self._processes = []
        self._listeners = []
        self._probe_responses = {}
        self.probe_calls = []
        self.listener_error = None

    def set_processes(self, processes):
        self._processes = list(processes)

    def set_listeners(self, listeners):
        self._listeners = list(listeners)

    def set_probe_response(self, port, response):
        self._probe_responses[port] = response

    def processes(self):
        return list(self._processes)

    def listeners(self):
        if self.listener_error is not None:
            raise self.listener_error
        return list(self._listeners)

    def probe_models(self, port, timeout_seconds):
        self.probe_calls.append((port, timeout_seconds))
        response = self._probe_responses[port]
        if isinstance(response, Exception):
            raise response
        return response


def studio_owner(pid=10, ppid=1, start_time='100'):
    return ProcessRecord(
        pid=pid,
        ppid=ppid,
        start_time=start_time,
        executable=f'{STUDIO_ROOT}/bin/unsloth',
        command=f'{STUDIO_ROOT}/bin/unsloth studio',
    )


def studio_backend(pid=20, ppid=10, start_time='200', port=36321):
    return ProcessRecord(
        pid=pid,
        ppid=ppid,
        start_time=start_time,
        executable=STUDIO_EXECUTABLE,
        command=f'{STUDIO_EXECUTABLE} --host 127.0.0.1 --port {port} --alias active',
    )


def listener(pid=20, host='127.0.0.1', port=36321):
    return ListenerRecord(pid=pid, host=host, port=port)


class BackendResolverTests(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        self.inspector = FakeInspector()
        self.resolver = BackendResolver(
            inspector=self.inspector,
            time_fn=self.clock.time,
        )

    def test_selects_one_studio_descendant_with_one_live_id(self):
        self.inspector.set_processes([
            studio_owner(),
            studio_backend(),
        ])
        self.inspector.set_listeners([listener()])
        self.inspector.set_probe_response(
            36321,
            (200, {'data': [{'id': LIVE_MODEL_ID}]}),
        )

        resolved = self.resolver.resolve()

        self.assertEqual(20, resolved.pid)
        self.assertEqual('200', resolved.start_time)
        self.assertEqual(STUDIO_EXECUTABLE, resolved.executable)
        self.assertEqual(36321, resolved.port)
        self.assertEqual(LIVE_MODEL_ID, resolved.model_id)
        self.assertEqual(1000.0, resolved.resolved_at)
        self.assertEqual([(36321, 2.0)], self.inspector.probe_calls)

    def test_selects_realpath_of_configured_studio_launcher(self):
        resolved_executable = f'{STUDIO_ROOT}/llama.cpp/build/bin/llama-server'
        self.inspector.set_processes([
            studio_owner(),
            ProcessRecord(
                pid=20,
                ppid=10,
                start_time='200',
                executable=resolved_executable,
                command=f'{resolved_executable} --host 127.0.0.1 --port 36321',
            ),
        ])
        self.inspector.set_listeners([listener()])
        self.inspector.set_probe_response(
            36321,
            (200, {'data': [{'id': LIVE_MODEL_ID}]}),
        )

        resolver = BackendResolver(
            inspector=self.inspector,
            studio_root=STUDIO_ROOT,
            time_fn=self.clock.time,
        )
        with mock.patch(
            'unsloth_backend_resolver.os.path.realpath',
            side_effect=lambda path: (
                resolved_executable if path == STUDIO_EXECUTABLE else path
            ),
        ):
            resolved = resolver.resolve()

        self.assertEqual(resolved_executable, resolved.executable)
        self.assertEqual(36321, resolved.port)
        self.assertEqual(LIVE_MODEL_ID, resolved.model_id)

    def test_selects_resolved_backend_with_python_studio_parent_command(self):
        resolved_executable = f'{STUDIO_ROOT}/llama.cpp/build/bin/llama-server'
        studio_parent_command = (
            f'{STUDIO_INTERPRETER} '
            f'{STUDIO_LAUNCHER} studio --host 0.0.0.0 --port 9900'
        )
        self.inspector.set_processes([
            ProcessRecord(
                pid=768071,
                ppid=1,
                start_time='768071-start',
                executable='/usr/bin/python3.12',
                command=studio_parent_command,
            ),
            ProcessRecord(
                pid=20,
                ppid=768071,
                start_time='200',
                executable=resolved_executable,
                command=f'{resolved_executable} --host 127.0.0.1 --port 36321',
            ),
        ])
        self.inspector.set_listeners([listener()])
        self.inspector.set_probe_response(
            36321,
            (200, {'data': [{'id': LIVE_MODEL_ID}]}),
        )

        resolver = BackendResolver(
            inspector=self.inspector,
            studio_root=STUDIO_ROOT,
            time_fn=self.clock.time,
        )
        with mock.patch(
            'unsloth_backend_resolver.os.path.realpath',
            side_effect=lambda path: (
                resolved_executable
                if path == STUDIO_EXECUTABLE
                else '/usr/bin/python3.12'
                if path == STUDIO_INTERPRETER
                else path
            ),
        ):
            resolved = resolver.resolve()

        self.assertEqual(20, resolved.pid)
        self.assertEqual(resolved_executable, resolved.executable)
        self.assertEqual(36321, resolved.port)
        self.assertEqual(LIVE_MODEL_ID, resolved.model_id)

    def test_rejects_external_parent_with_spoofed_studio_launcher_command(self):
        resolved_executable = f'{STUDIO_ROOT}/llama.cpp/build/bin/llama-server'
        self.inspector.set_processes([
            ProcessRecord(
                pid=768071,
                ppid=1,
                start_time='768071-start',
                executable='/usr/bin/evil',
                command=(
                    f'/usr/bin/evil {STUDIO_LAUNCHER} studio '
                    '--host 0.0.0.0 --port 9900'
                ),
            ),
            ProcessRecord(
                pid=20,
                ppid=768071,
                start_time='200',
                executable=resolved_executable,
                command=f'{resolved_executable} --host 127.0.0.1 --port 36321',
            ),
        ])
        self.inspector.set_listeners([listener()])
        self.inspector.set_probe_response(
            36321,
            (200, {'data': [{'id': LIVE_MODEL_ID}]}),
        )

        resolver = BackendResolver(
            inspector=self.inspector,
            studio_root=STUDIO_ROOT,
            time_fn=self.clock.time,
        )
        with mock.patch(
            'unsloth_backend_resolver.os.path.realpath',
            side_effect=lambda path: (
                resolved_executable if path == STUDIO_EXECUTABLE else path
            ),
        ):
            with self.assertRaises(BackendUnavailable) as raised:
                resolver.resolve()

        self.assertEqual('backend_unavailable', raised.exception.code)
        self.assertEqual([], self.inspector.probe_calls)

    def test_rejects_llama_server_outside_studio_tree(self):
        self.inspector.set_processes([
            ProcessRecord(
                pid=20,
                ppid=1,
                start_time='200',
                executable=STUDIO_EXECUTABLE,
                command=f'{STUDIO_EXECUTABLE} --host 127.0.0.1 --port 36321',
            ),
        ])
        self.inspector.set_listeners([listener()])
        self.inspector.set_probe_response(
            36321,
            (200, {'data': [{'id': LIVE_MODEL_ID}]}),
        )

        with self.assertRaises(BackendUnavailable) as raised:
            self.resolver.resolve()

        self.assertEqual('backend_unavailable', raised.exception.code)

    def test_rejects_non_loopback_listener(self):
        self.inspector.set_processes([
            studio_owner(),
            studio_backend(),
        ])
        self.inspector.set_listeners([listener(host=WILDCARD_HOST)])
        self.inspector.set_probe_response(
            36321,
            (200, {'data': [{'id': LIVE_MODEL_ID}]}),
        )

        with self.assertRaises(BackendUnavailable) as raised:
            self.resolver.resolve()

        self.assertEqual('backend_unavailable', raised.exception.code)
        self.assertEqual([], self.inspector.probe_calls)

    def test_returns_backend_unavailable_with_no_ready_candidate(self):
        self.inspector.set_processes([])
        self.inspector.set_listeners([])

        with self.assertRaises(BackendUnavailable) as raised:
            self.resolver.resolve()

        self.assertEqual('backend_unavailable', raised.exception.code)

    def test_returns_backend_ambiguous_with_two_ready_candidates(self):
        self.inspector.set_processes([
            studio_owner(),
            studio_backend(pid=20, port=36321),
            studio_backend(pid=21, port=41237),
        ])
        self.inspector.set_listeners([
            listener(pid=20, port=36321),
            listener(pid=21, port=41237),
        ])
        self.inspector.set_probe_response(
            36321,
            (200, {'data': [{'id': LIVE_MODEL_ID}]}),
        )
        self.inspector.set_probe_response(
            41237,
            (200, {'data': [{'id': 'unsloth/Replacement-Model'}]}),
        )

        with self.assertRaises(BackendAmbiguous) as raised:
            self.resolver.resolve()

        self.assertEqual('backend_ambiguous', raised.exception.code)

    def test_rejects_empty_or_multiple_model_ids(self):
        scenarios = [
            (
                'empty ids are unavailable',
                (200, {'data': [{'id': ''}, {'id': '   '}]}),
                BackendUnavailable,
                'backend_unavailable',
            ),
            (
                'multiple distinct ids are ambiguous',
                (200, {'data': [{'id': LIVE_MODEL_ID}, {'id': 'unsloth/Replacement-Model'}]}),
                BackendAmbiguous,
                'backend_ambiguous',
            ),
        ]

        for label, probe_response, expected_type, expected_code in scenarios:
            with self.subTest(label=label):
                self.clock = FakeClock()
                self.inspector = FakeInspector()
                self.resolver = BackendResolver(
                    inspector=self.inspector,
                    time_fn=self.clock.time,
                )
                self.inspector.set_processes([
                    studio_owner(),
                    studio_backend(),
                ])
                self.inspector.set_listeners([listener()])
                self.inspector.set_probe_response(36321, probe_response)

                with self.assertRaises(expected_type) as raised:
                    self.resolver.resolve()

                self.assertEqual(expected_code, raised.exception.code)

    def test_invalidates_cache_when_pid_start_time_changes(self):
        self.inspector.set_processes([
            studio_owner(),
            studio_backend(start_time='200'),
        ])
        self.inspector.set_listeners([listener()])
        self.inspector.set_probe_response(
            36321,
            (200, {'data': [{'id': LIVE_MODEL_ID}]}),
        )

        first = self.resolver.resolve()
        self.clock.advance(2.1)
        self.inspector.set_processes([
            studio_owner(),
            studio_backend(start_time='999'),
        ])

        second = self.resolver.resolve()

        self.assertEqual('200', first.start_time)
        self.assertEqual('999', second.start_time)
        self.assertEqual(1002.1, second.resolved_at)
        self.assertEqual([(36321, 2.0), (36321, 2.0)], self.inspector.probe_calls)

    def test_selects_new_port_and_id_after_rotation(self):
        self.inspector.set_processes([
            studio_owner(),
            studio_backend(pid=20, port=36321),
        ])
        self.inspector.set_listeners([listener(pid=20, port=36321)])
        self.inspector.set_probe_response(
            36321,
            (200, {'data': [{'id': LIVE_MODEL_ID}]}),
        )

        first = self.resolver.resolve()
        self.clock.advance(2.1)
        self.inspector.set_processes([
            studio_owner(),
            studio_backend(pid=30, start_time='300', port=41237),
        ])
        self.inspector.set_listeners([listener(pid=30, port=41237)])
        self.inspector.set_probe_response(
            41237,
            (200, {'data': [{'id': 'unsloth/DeepSeek-V4-Flash-0731-GGUF-Rotated'}]}),
        )

        second = self.resolver.resolve()

        self.assertEqual(36321, first.port)
        self.assertEqual(LIVE_MODEL_ID, first.model_id)
        self.assertEqual(41237, second.port)
        self.assertEqual('unsloth/DeepSeek-V4-Flash-0731-GGUF-Rotated', second.model_id)
        self.assertEqual([(36321, 2.0), (41237, 2.0)], self.inspector.probe_calls)

    def test_real_inspector_parses_standard_ss_listener_row(self):
        inspector = RealInspector()
        completed = subprocess.CompletedProcess(
            args=['ss', '-H', '-ltnp'],
            returncode=0,
            stdout='LISTEN 0 4096 127.0.0.1:36321 ' '0.0.0.' '0:* users:(("llama-server",pid=716619,fd=42))\n',
            stderr='',
        )

        with mock.patch('unsloth_backend_resolver.subprocess.run', return_value=completed):
            listeners = inspector.listeners()

        self.assertEqual(
            [ListenerRecord(pid=716619, host='127.0.0.1', port=36321)],
            listeners,
        )

    def test_returns_backend_unavailable_when_listener_scan_fails_after_cache_expiry(self):
        self.inspector.set_processes([
            studio_owner(),
            studio_backend(),
        ])
        self.inspector.set_listeners([listener()])
        self.inspector.set_probe_response(
            36321,
            (200, {'data': [{'id': LIVE_MODEL_ID}]}),
        )

        first = self.resolver.resolve()
        self.clock.advance(2.1)
        self.inspector.listener_error = subprocess.CalledProcessError(
            returncode=1,
            cmd=['ss', '-H', '-ltnp'],
        )

        with self.assertRaises(BackendUnavailable) as raised:
            self.resolver.resolve()

        self.assertEqual('backend_unavailable', raised.exception.code)
        self.assertIsNone(self.resolver._cached_backend)

        self.inspector.listener_error = None
        second = self.resolver.resolve()

        self.assertEqual(first.port, second.port)
        self.assertEqual([(36321, 2.0), (36321, 2.0)], self.inspector.probe_calls)

    def test_returns_backend_unavailable_for_malformed_http_200_probe_payload(self):
        self.inspector.set_processes([
            studio_owner(),
            studio_backend(),
        ])
        self.inspector.set_listeners([listener()])
        self.inspector.set_probe_response(
            36321,
            (200, {'data': [{'id': LIVE_MODEL_ID}]}),
        )

        self.resolver.resolve()
        self.clock.advance(2.1)
        self.inspector.set_probe_response(36321, (200, 'not-a-dict'))

        with self.assertRaises(BackendUnavailable) as raised:
            self.resolver.resolve()

        self.assertEqual('backend_unavailable', raised.exception.code)
        self.assertIsNone(self.resolver._cached_backend)

        self.inspector.set_probe_response(
            36321,
            (200, {'data': [{'id': LIVE_MODEL_ID}]}),
        )
        resolved = self.resolver.resolve()

        self.assertEqual(36321, resolved.port)
        self.assertEqual(
            [(36321, 2.0), (36321, 2.0), (36321, 2.0)],
            self.inspector.probe_calls,
        )


if __name__ == '__main__':
    unittest.main()
