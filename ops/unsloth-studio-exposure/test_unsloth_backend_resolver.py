import unittest

from unsloth_backend_resolver import (
    BackendAmbiguous,
    BackendResolver,
    BackendUnavailable,
    ListenerRecord,
    ProcessRecord,
)


STUDIO_ROOT = '/home/mctdgx01/apps/unsloth-studio'
STUDIO_EXECUTABLE = f'{STUDIO_ROOT}/llama.cpp/llama-server'
LIVE_MODEL_ID = 'unsloth/DeepSeek-V4-Flash-0731-GGUF'


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

    def set_processes(self, processes):
        self._processes = list(processes)

    def set_listeners(self, listeners):
        self._listeners = list(listeners)

    def set_probe_response(self, port, response):
        self._probe_responses[port] = response

    def processes(self):
        return list(self._processes)

    def listeners(self):
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
        self.inspector.set_listeners([listener(host='0.0.0.0')])
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


if __name__ == '__main__':
    unittest.main()
