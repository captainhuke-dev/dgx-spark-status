import email.message
import importlib
import inspect
import io
import json
import pathlib
import socket
import sys
import threading
import types
import unittest
from unittest import mock


RUNTIME_DIR = pathlib.Path(__file__).resolve().parent
if str(RUNTIME_DIR) not in sys.path:
    sys.path.insert(0, str(RUNTIME_DIR))

from unsloth_backend_resolver import BackendAmbiguous, BackendUnavailable, ResolvedBackend


LIVE_MODEL_ID = 'unsloth/DeepSeek-V4-Flash-0731-GGUF'
STUDIO_EXECUTABLE = '/home/mctdgx01/apps/unsloth-studio/llama.cpp/llama-server'
WILDCARD_BIND_HOST = '0.0.0.' '0'


def load_guard_module():
    sys.modules.pop('unsloth_request_guard', None)
    return importlib.import_module('unsloth_request_guard')


def resolved_backend(port=36321, model_id=LIVE_MODEL_ID):
    return ResolvedBackend(
        pid=7,
        start_time='100',
        executable=STUDIO_EXECUTABLE,
        port=port,
        model_id=model_id,
        resolved_at=0.0,
    )


class FakeResolver:
    def __init__(self, *, resolved=None, error=None):
        self.resolved = resolved or resolved_backend()
        self.error = error
        self.resolve_calls = 0
        self.invalidate_calls = 0

    def resolve(self):
        self.resolve_calls += 1
        if self.error is not None:
            raise self.error
        return self.resolved

    def invalidate(self):
        self.invalidate_calls += 1


class FakeUpstreamResponse:
    def __init__(self, *, status=200, reason='OK', headers=None, body=b''):
        self.status = status
        self.reason = reason
        self._headers = list((headers or {}).items())
        self._body = io.BytesIO(body)
        self.read_sizes = []

    def getheaders(self):
        return list(self._headers)

    def read(self, size=-1):
        self.read_sizes.append(size)
        return self._body.read(size)

    def read1(self, size=-1):
        self.read_sizes.append(size)
        return self._body.read(size)


class Read1OnlyUpstreamResponse(FakeUpstreamResponse):
    def read(self, size=-1):
        raise AssertionError('streaming proxy must use read1 when the upstream exposes it')


class FakeUpstreamConnection:
    def __init__(self, *, response=None, request_error=None, response_error=None):
        self.response = response or FakeUpstreamResponse()
        self.request_error = request_error
        self.response_error = response_error
        self.request_call = None
        self.closed = False

    def request(self, method, url, body=None, headers=None):
        self.request_call = {
            'method': method,
            'url': url,
            'body': body,
            'headers': dict(headers or {}),
        }
        if self.request_error is not None:
            raise self.request_error

    def getresponse(self):
        if self.response_error is not None:
            raise self.response_error
        return self.response

    def close(self):
        self.closed = True


class BlockingUpstreamConnection(FakeUpstreamConnection):
    def __init__(self, started, release):
        super().__init__(response=FakeUpstreamResponse(body=b'first'))
        self.started = started
        self.release = release

    def request(self, method, url, body=None, headers=None):
        super().request(method, url, body=body, headers=headers)
        self.started.set()
        if not self.release.wait(2):
            raise TimeoutError('test did not release blocked request')


class TimeoutBodyStream:
    def read(self, size=-1):
        raise socket.timeout('request body timed out')


class RecordingHandlerSocket:
    def __init__(self):
        self.timeout = None
        self.set_timeout_calls = []

    def gettimeout(self):
        return self.timeout

    def settimeout(self, value):
        self.timeout = value
        self.set_timeout_calls.append(value)


class RecordingConnectionFactory:
    def __init__(self, *connections):
        self._connections = list(connections) or [FakeUpstreamConnection()]
        self.calls = []

    def __call__(self, host, port, timeout):
        self.calls.append((host, port, timeout))
        if len(self._connections) == 1:
            return self._connections[0]
        return self._connections.pop(0)


class HandlerHarnessMixin:
    def build_handler(
        self,
        guard,
        *,
        method='GET',
        path='/v1/models',
        headers=None,
        body=b'',
        body_stream=None,
        handler_socket=None,
        resolver=None,
        connection_factory=None,
        upstream_response=None,
        upstream_request_error=None,
        upstream_response_error=None,
        config=None,
    ):
        config = config or guard.GuardConfig()
        resolver = resolver or FakeResolver()
        if connection_factory is None:
            connection = FakeUpstreamConnection(
                response=upstream_response,
                request_error=upstream_request_error,
                response_error=upstream_response_error,
            )
            connection_factory = RecordingConnectionFactory(connection)
        else:
            connection = None

        class HarnessHandler(guard.RequestGuardHandler):
            def __init__(self):
                self.command = method
                self.path = path
                self.request_version = 'HTTP/1.1'
                self.requestline = f'{method} {path} HTTP/1.1'
                self.client_address = ('127.0.0.1', 9999)
                self.headers = email.message.Message()
                for key, value in (headers or {}).items():
                    self.headers[key] = value
                self.rfile = body_stream or io.BytesIO(body)
                self.wfile = io.BytesIO()
                self.connection = handler_socket or RecordingHandlerSocket()
                self.server = types.SimpleNamespace(
                    guard_config=config,
                    resolver=resolver,
                    upstream_connection_factory=connection_factory,
                )
                self.response_code = None
                self.response_headers = []
                self.response_message = None

            def send_response(self, code, message=None):
                self.response_code = code
                self.response_message = message

            def send_header(self, keyword, value):
                self.response_headers.append((keyword, value))

            def end_headers(self):
                return None

            def log_message(self, format, *args):
                return None

        return HarnessHandler(), resolver, connection_factory, connection

    def response_header_map(self, handler):
        return {key.lower(): value for key, value in handler.response_headers}

    def error_payload(self, handler):
        return json.loads(handler.wfile.getvalue().decode('utf-8'))

    def read_socket_response(self, client):
        client.settimeout(1)
        chunks = []
        while True:
            chunk = client.recv(65536)
            if not chunk:
                break
            chunks.append(chunk)
        return b''.join(chunks)


class RequestGuardTests(unittest.TestCase, HandlerHarnessMixin):
    def test_create_server_public_interface_uses_canonical_loopback_binding(self):
        guard = load_guard_module()

        self.assertEqual(guard.UPSTREAM_HOST, '127.0.0.1')
        self.assertEqual(guard.DEFAULT_BIND_HOST, '127.0.0.1')
        self.assertEqual(guard.DEFAULT_BIND_PORT, 56828)
        self.assertEqual(guard.DEFAULT_MAX_OUTPUT_BUDGET, 32768)
        self.assertEqual('(*, resolver=None)', str(inspect.signature(guard.create_server)))

        fake_resolver = FakeResolver()
        sentinel = object()

        with mock.patch.object(guard, '_create_server', return_value=sentinel) as patched:
            server = guard.create_server(resolver=fake_resolver)

        self.assertIs(server, sentinel)
        patched.assert_called_once_with(
            resolver=fake_resolver,
            server_address=('127.0.0.1', 56828),
            bind_and_activate=True,
        )

    def test_private_create_server_binds_loopback_socket_when_activated(self):
        guard = load_guard_module()
        fake_resolver = FakeResolver()

        server = guard._create_server(
            resolver=fake_resolver,
            server_address=('127.0.0.1', 0),
            bind_and_activate=True,
        )
        try:
            self.assertGreaterEqual(server.fileno(), 0)
            host, port = server.socket.getsockname()
            self.assertEqual(host, '127.0.0.1')
            self.assertGreater(port, 0)
            self.assertEqual(server.guard_config.max_output_budget, 32768)
            self.assertIs(server.resolver, fake_resolver)
        finally:
            server.server_close()

    def test_guard_config_rejects_noncanonical_bind_host(self):
        guard = load_guard_module()

        with self.assertRaisesRegex(ValueError, 'bind_host'):
            guard.GuardConfig(bind_host=WILDCARD_BIND_HOST)

    def test_guard_config_rejects_noncanonical_bind_port(self):
        guard = load_guard_module()

        with self.assertRaisesRegex(ValueError, 'bind_port'):
            guard.GuardConfig(bind_port=9000)

    def test_guard_config_rejects_noncanonical_max_output_budget(self):
        guard = load_guard_module()

        with self.assertRaisesRegex(ValueError, 'max_output_budget'):
            guard.GuardConfig(max_output_budget=65536)

    def test_guard_config_accepts_configurable_body_timeout_and_concurrency_limit(self):
        guard = load_guard_module()

        config = guard.GuardConfig(
            request_body_timeout_seconds=0.25,
            max_concurrent_requests=2,
        )

        self.assertEqual(0.25, config.request_body_timeout_seconds)
        self.assertEqual(2, config.max_concurrent_requests)

    def test_guard_config_rejects_nonpositive_body_timeout_and_concurrency_limit(self):
        guard = load_guard_module()

        with self.assertRaisesRegex(ValueError, 'request_body_timeout_seconds'):
            guard.GuardConfig(request_body_timeout_seconds=0)
        with self.assertRaisesRegex(ValueError, 'max_concurrent_requests'):
            guard.GuardConfig(max_concurrent_requests=0)

    def test_parse_args_accepts_body_timeout_and_concurrency_limit(self):
        guard = load_guard_module()

        args = guard.parse_args([
            '--request-body-timeout-seconds', '0.25',
            '--max-concurrent-requests', '2',
        ])

        self.assertEqual(0.25, args.request_body_timeout_seconds)
        self.assertEqual(2, args.max_concurrent_requests)

    def test_parse_args_rejects_bind_host_override(self):
        guard = load_guard_module()

        with self.assertRaises(SystemExit):
            guard.parse_args(['--bind-host', WILDCARD_BIND_HOST])

    def test_parse_args_rejects_bind_port_override(self):
        guard = load_guard_module()

        with self.assertRaises(SystemExit):
            guard.parse_args(['--bind-port', '9000'])

    def test_parse_args_rejects_max_output_budget_override(self):
        guard = load_guard_module()

        with self.assertRaises(SystemExit):
            guard.parse_args(['--max-output-budget', '65536'])

    def test_routes_v1_request_to_resolved_backend_and_marks_guard_header(self):
        guard = load_guard_module()
        response = FakeUpstreamResponse(
            headers={'Content-Type': 'application/json'},
            body=b'{"id":"ok"}',
        )
        body = json.dumps({'max_tokens': 32768, 'prompt': 'hello'}).encode('utf-8')
        resolver = FakeResolver(resolved=resolved_backend(port=36321))
        handler, resolver, connection_factory, connection = self.build_handler(
            guard,
            method='POST',
            path='/v1/chat/completions',
            headers={
                'Content-Type': 'application/json',
                'Content-Length': str(len(body)),
                'Authorization': 'Bearer test-token',
                'Connection': 'keep-alive',
            },
            body=body,
            resolver=resolver,
            upstream_response=response,
        )

        handler.do_POST()

        self.assertEqual(handler.response_code, 200)
        self.assertEqual(handler.wfile.getvalue(), b'{"id":"ok"}')
        self.assertEqual(
            self.response_header_map(handler)['x-dgx-request-guard'],
            'unsloth-studio',
        )
        self.assertEqual(connection_factory.calls, [('127.0.0.1', 36321, 30.0)])
        self.assertEqual(connection.request_call['url'], '/v1/chat/completions')
        self.assertEqual(
            connection.request_call['headers']['X-DGX-Request-Guard'],
            'unsloth-studio',
        )
        self.assertEqual(
            connection.request_call['headers']['Authorization'],
            'Bearer test-token',
        )
        self.assertNotIn('Connection', connection.request_call['headers'])
        self.assertEqual(1, resolver.resolve_calls)
        self.assertTrue(connection.closed)

    def test_rejects_malformed_json(self):
        guard = load_guard_module()
        body = b'{"max_tokens":'
        handler, _, _, _ = self.build_handler(
            guard,
            method='POST',
            path='/v1/chat/completions',
            headers={
                'Content-Type': 'application/json',
                'Content-Length': str(len(body)),
            },
            body=body,
        )

        handler.do_POST()

        self.assertEqual(handler.response_code, 400)
        payload = self.error_payload(handler)
        self.assertEqual(payload['error']['code'], 'invalid_json')

    def test_rejects_negative_budget(self):
        guard = load_guard_module()
        body = json.dumps({'max_tokens': -1}).encode('utf-8')
        handler, _, _, _ = self.build_handler(
            guard,
            method='POST',
            path='/v1/completions',
            headers={
                'Content-Type': 'application/json',
                'Content-Length': str(len(body)),
            },
            body=body,
        )

        handler.do_POST()

        self.assertEqual(handler.response_code, 400)
        payload = self.error_payload(handler)
        self.assertEqual(payload['error']['code'], 'invalid_budget')

    def test_rejects_non_integer_budget(self):
        guard = load_guard_module()
        body = json.dumps({'max_output_tokens': '4096'}).encode('utf-8')
        handler, _, _, _ = self.build_handler(
            guard,
            method='POST',
            path='/v1/responses',
            headers={
                'Content-Type': 'application/json',
                'Content-Length': str(len(body)),
            },
            body=body,
        )

        handler.do_POST()

        self.assertEqual(handler.response_code, 400)
        payload = self.error_payload(handler)
        self.assertEqual(payload['error']['code'], 'invalid_budget')

    def test_rejects_budget_over_limit(self):
        guard = load_guard_module()
        body = json.dumps({'max_completion_tokens': 32769}).encode('utf-8')
        handler, _, _, _ = self.build_handler(
            guard,
            method='POST',
            path='/v1/chat/completions',
            headers={
                'Content-Type': 'application/json',
                'Content-Length': str(len(body)),
            },
            body=body,
        )

        handler.do_POST()

        self.assertEqual(handler.response_code, 400)
        payload = self.error_payload(handler)
        self.assertEqual(payload['error']['code'], 'invalid_budget')

    def test_rejects_disallowed_path(self):
        guard = load_guard_module()
        handler, _, _, connection = self.build_handler(
            guard,
            method='GET',
            path='/',
            upstream_response=FakeUpstreamResponse(body=b'unexpected'),
        )

        handler.do_GET()

        self.assertEqual(handler.response_code, 404)
        self.assertIsNone(connection.request_call)
        payload = self.error_payload(handler)
        self.assertEqual(payload['error']['code'], 'path_not_allowed')

    def test_allows_health_only_as_readonly_path(self):
        guard = load_guard_module()
        get_handler, _, _, get_connection = self.build_handler(
            guard,
            method='GET',
            path='/health',
            upstream_response=FakeUpstreamResponse(body=b'ok'),
        )
        get_handler.do_GET()

        post_body = b'{}'
        post_handler, _, _, post_connection = self.build_handler(
            guard,
            method='POST',
            path='/health',
            headers={'Content-Length': str(len(post_body))},
            body=post_body,
        )
        post_handler.do_POST()

        self.assertEqual(get_handler.response_code, 200)
        self.assertEqual(get_connection.request_call['url'], '/health')
        self.assertEqual(post_handler.response_code, 404)
        self.assertIsNone(post_connection.request_call)

    def test_allows_props_only_as_readonly_path(self):
        guard = load_guard_module()
        get_handler, _, _, get_connection = self.build_handler(
            guard,
            method='GET',
            path='/props',
            upstream_response=FakeUpstreamResponse(body=b'{}'),
        )
        get_handler.do_GET()

        post_body = b'{}'
        post_handler, _, _, post_connection = self.build_handler(
            guard,
            method='POST',
            path='/props',
            headers={'Content-Length': str(len(post_body))},
            body=post_body,
        )
        post_handler.do_POST()

        self.assertEqual(get_handler.response_code, 200)
        self.assertEqual(get_connection.request_call['url'], '/props')
        self.assertEqual(post_handler.response_code, 404)
        self.assertIsNone(post_connection.request_call)

    def test_allows_slots_only_as_readonly_path(self):
        guard = load_guard_module()
        get_handler, _, _, get_connection = self.build_handler(
            guard,
            method='GET',
            path='/slots',
            upstream_response=FakeUpstreamResponse(body=b'[]'),
        )
        get_handler.do_GET()

        post_body = b'{}'
        post_handler, _, _, post_connection = self.build_handler(
            guard,
            method='POST',
            path='/slots',
            headers={'Content-Length': str(len(post_body))},
            body=post_body,
        )
        post_handler.do_POST()

        self.assertEqual(get_handler.response_code, 200)
        self.assertEqual(get_connection.request_call['url'], '/slots')
        self.assertEqual(post_handler.response_code, 404)
        self.assertIsNone(post_connection.request_call)

    def test_rejects_oversized_body_before_proxying(self):
        guard = load_guard_module()
        config = guard.GuardConfig(max_request_body_bytes=8)
        body = json.dumps({'max_tokens': 1}).encode('utf-8')
        handler, _, _, connection = self.build_handler(
            guard,
            method='POST',
            path='/v1/chat/completions',
            headers={
                'Content-Type': 'application/json',
                'Content-Length': str(len(body)),
            },
            body=body,
            config=config,
        )

        handler.do_POST()

        self.assertEqual(handler.response_code, 400)
        self.assertIsNone(connection.request_call)
        payload = self.error_payload(handler)
        self.assertEqual(payload['error']['code'], 'body_too_large')

    def test_returns_stable_error_when_request_body_read_times_out(self):
        guard = load_guard_module()
        handler_socket = RecordingHandlerSocket()
        config = guard.GuardConfig(request_body_timeout_seconds=0.25)
        handler, resolver, _, connection = self.build_handler(
            guard,
            method='POST',
            path='/v1/chat/completions',
            headers={'Content-Length': '5'},
            body_stream=TimeoutBodyStream(),
            handler_socket=handler_socket,
            config=config,
        )

        handler.do_POST()

        self.assertEqual(408, handler.response_code)
        self.assertEqual('request_body_timeout', self.error_payload(handler)['error']['code'])
        self.assertEqual([0.25, None], handler_socket.set_timeout_calls)
        self.assertEqual(0, resolver.resolve_calls)
        self.assertIsNone(connection.request_call)

    def test_returns_incomplete_body_when_client_closes_before_content_length(self):
        guard = load_guard_module()
        handler, resolver, _, connection = self.build_handler(
            guard,
            method='POST',
            path='/v1/chat/completions',
            headers={'Content-Length': '5'},
            body=b'{}',
        )

        handler.do_POST()

        self.assertEqual(400, handler.response_code)
        self.assertEqual('incomplete_body', self.error_payload(handler)['error']['code'])
        self.assertEqual(0, resolver.resolve_calls)
        self.assertIsNone(connection.request_call)

    def test_rejects_request_above_concurrency_limit_with_stable_error(self):
        guard = load_guard_module()
        started = threading.Event()
        release = threading.Event()
        first_connection = BlockingUpstreamConnection(started, release)
        second_connection = FakeUpstreamConnection(
            response=FakeUpstreamResponse(body=b'second')
        )
        connection_factory = RecordingConnectionFactory(
            first_connection,
            second_connection,
        )
        server = guard._create_server(
            guard.GuardConfig(max_concurrent_requests=1),
            resolver=FakeResolver(),
            server_address=('127.0.0.1', 0),
            bind_and_activate=True,
            connection_factory=connection_factory,
        )
        server_thread = threading.Thread(target=server.serve_forever, daemon=True)
        server_thread.start()
        first_client = None
        second_client = None
        try:
            address = server.socket.getsockname()
            first_client = socket.create_connection(address, timeout=1)
            first_client.sendall(
                b'GET /v1/models HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
            )
            self.assertTrue(started.wait(1), 'first request never occupied the server')

            second_client = socket.create_connection(address, timeout=1)
            second_client.sendall(
                b'GET /v1/models HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
            )
            second_response = self.read_socket_response(second_client)

            self.assertIn(b'HTTP/1.1 503', second_response)
            payload = json.loads(second_response.split(b'\r\n\r\n', 1)[1])
            self.assertEqual('server_busy', payload['error']['code'])
            self.assertEqual(1, len(connection_factory.calls))
        finally:
            release.set()
            if first_client is not None:
                self.read_socket_response(first_client)
                first_client.close()
            if second_client is not None:
                second_client.close()
            server.shutdown()
            server.server_close()
            server_thread.join(1)

    def test_returns_503_when_no_backend(self):
        guard = load_guard_module()
        resolver = FakeResolver(
            error=BackendUnavailable('No ready Unsloth Studio backend found.')
        )
        handler, resolver, connection_factory, connection = self.build_handler(
            guard,
            method='GET',
            path='/v1/models',
            resolver=resolver,
        )

        handler.do_GET()

        self.assertEqual(handler.response_code, 503)
        self.assertEqual([], connection_factory.calls)
        self.assertIsNone(connection.request_call)
        payload = self.error_payload(handler)
        self.assertEqual(payload['error']['code'], 'backend_unavailable')
        self.assertEqual(
            payload['error']['message'],
            'No ready Unsloth Studio model is available.',
        )

    def test_returns_503_when_backend_is_ambiguous(self):
        guard = load_guard_module()
        resolver = FakeResolver(
            error=BackendAmbiguous('Multiple ready Unsloth Studio backends found.')
        )
        handler, resolver, connection_factory, connection = self.build_handler(
            guard,
            method='GET',
            path='/v1/models',
            resolver=resolver,
        )

        handler.do_GET()

        self.assertEqual(handler.response_code, 503)
        self.assertEqual([], connection_factory.calls)
        self.assertIsNone(connection.request_call)
        payload = self.error_payload(handler)
        self.assertEqual(payload['error']['code'], 'backend_ambiguous')
        self.assertEqual(
            payload['error']['message'],
            'Multiple eligible Unsloth Studio backends are active.',
        )

    def test_invalidates_target_on_upstream_os_error(self):
        guard = load_guard_module()
        resolver = FakeResolver()
        handler, resolver, _, _ = self.build_handler(
            guard,
            method='GET',
            path='/v1/models',
            resolver=resolver,
            upstream_request_error=OSError('dial failed'),
        )

        handler.do_GET()

        self.assertEqual(handler.response_code, 502)
        self.assertEqual(1, resolver.invalidate_calls)
        payload = self.error_payload(handler)
        self.assertEqual(payload['error']['code'], 'bad_gateway')

    def test_returns_504_on_upstream_timeout(self):
        guard = load_guard_module()
        resolver = FakeResolver()
        handler, resolver, _, _ = self.build_handler(
            guard,
            method='GET',
            path='/v1/models',
            resolver=resolver,
            upstream_request_error=socket.timeout('timed out'),
        )

        handler.do_GET()

        self.assertEqual(handler.response_code, 504)
        self.assertEqual(1, resolver.invalidate_calls)
        payload = self.error_payload(handler)
        self.assertEqual(payload['error']['code'], 'upstream_timeout')

    def test_never_replays_post_after_upstream_failure(self):
        guard = load_guard_module()
        first = FakeUpstreamConnection(response_error=OSError('broken pipe'))
        second = FakeUpstreamConnection(
            response=FakeUpstreamResponse(body=b'{"id":"unexpected"}')
        )
        connection_factory = RecordingConnectionFactory(first, second)
        resolver = FakeResolver()
        body = json.dumps({'max_tokens': 10, 'prompt': 'hello'}).encode('utf-8')
        handler, resolver, connection_factory, _ = self.build_handler(
            guard,
            method='POST',
            path='/v1/chat/completions',
            headers={
                'Content-Type': 'application/json',
                'Content-Length': str(len(body)),
            },
            body=body,
            resolver=resolver,
            connection_factory=connection_factory,
        )

        handler.do_POST()

        self.assertEqual(handler.response_code, 502)
        self.assertEqual(1, len(connection_factory.calls))
        self.assertIsNotNone(first.request_call)
        self.assertIsNone(second.request_call)
        self.assertEqual(1, resolver.invalidate_calls)
        payload = self.error_payload(handler)
        self.assertEqual(payload['error']['code'], 'bad_gateway')

    def test_streams_upstream_bytes_in_chunks(self):
        guard = load_guard_module()
        chunk = b'x' * (guard.RESPONSE_STREAM_CHUNK_SIZE + 17)
        response = FakeUpstreamResponse(
            headers={'Content-Type': 'application/octet-stream'},
            body=chunk,
        )
        handler, _, _, _ = self.build_handler(
            guard,
            method='GET',
            path='/v1/models',
            upstream_response=response,
        )

        handler.do_GET()

        self.assertEqual(handler.response_code, 200)
        self.assertEqual(handler.wfile.getvalue(), chunk)
        self.assertGreaterEqual(len(response.read_sizes), 2)
        self.assertEqual(response.read_sizes[0], guard.RESPONSE_STREAM_CHUNK_SIZE)

    def test_streams_read1_chunks_with_guard_marker(self):
        guard = load_guard_module()
        response = Read1OnlyUpstreamResponse(
            headers={'Content-Type': 'text/event-stream'},
            body=b'data: first\n\ndata: second\n\n',
        )
        handler, _, _, _ = self.build_handler(
            guard,
            method='GET',
            path='/v1/chat/completions',
            upstream_response=response,
        )

        handler.do_GET()

        self.assertEqual(handler.response_code, 200)
        self.assertEqual(handler.wfile.getvalue(), b'data: first\n\ndata: second\n\n')
        self.assertEqual(
            response.read_sizes,
            [guard.RESPONSE_STREAM_CHUNK_SIZE, guard.RESPONSE_STREAM_CHUNK_SIZE],
        )
        self.assertEqual(
            self.response_header_map(handler)['x-dgx-request-guard'],
            'unsloth-studio',
        )


if __name__ == '__main__':
    unittest.main()
