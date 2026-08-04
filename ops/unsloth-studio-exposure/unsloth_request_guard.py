from __future__ import annotations

import argparse
import http.client
import json
import socket
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Callable
from urllib.parse import urlsplit

from unsloth_backend_resolver import BackendAmbiguous, BackendResolver, BackendUnavailable


UPSTREAM_HOST = '127.0.0.1'
DEFAULT_BIND_HOST = '127.0.0.1'
DEFAULT_BIND_PORT = 56828
DEFAULT_MAX_OUTPUT_BUDGET = 32768
DEFAULT_MAX_REQUEST_BODY_BYTES = 1024 * 1024
DEFAULT_UPSTREAM_TIMEOUT_SECONDS = 30.0
RESPONSE_STREAM_CHUNK_SIZE = 64 * 1024
ERROR_MESSAGE_LIMIT = 200
HOP_BY_HOP_HEADERS = {
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'proxy-connection',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
}
READ_ONLY_PATHS = {'/health', '/props', '/slots'}
BUDGET_FIELDS = {
    'max_tokens',
    'max_completion_tokens',
    'max_output_tokens',
}


@dataclass(slots=True)
class GuardConfig:
    bind_host: str = DEFAULT_BIND_HOST
    bind_port: int = DEFAULT_BIND_PORT
    max_output_budget: int = DEFAULT_MAX_OUTPUT_BUDGET
    max_request_body_bytes: int = DEFAULT_MAX_REQUEST_BODY_BYTES
    upstream_timeout_seconds: float = DEFAULT_UPSTREAM_TIMEOUT_SECONDS

    def __post_init__(self) -> None:
        if self.bind_host != DEFAULT_BIND_HOST:
            raise ValueError(f'bind_host must remain {DEFAULT_BIND_HOST}.')
        if self.bind_port != DEFAULT_BIND_PORT:
            raise ValueError(f'bind_port must remain {DEFAULT_BIND_PORT}.')
        if self.max_output_budget != DEFAULT_MAX_OUTPUT_BUDGET:
            raise ValueError(
                f'max_output_budget must remain {DEFAULT_MAX_OUTPUT_BUDGET}.'
            )


class RequestValidationError(Exception):
    def __init__(self, status_code: int, code: str, message: str):
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message


class GuardHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    resolver: BackendResolver
    guard_config: GuardConfig
    upstream_connection_factory: Callable[[str, int, float], object]


def resolve_upstream(server: GuardHTTPServer):
    return server.resolver.resolve()


def is_supported_method(method: str) -> bool:
    return method in {'GET', 'POST', 'HEAD'}


def is_path_allowed(method: str, raw_path: str) -> bool:
    path = urlsplit(raw_path).path
    if path.startswith('/v1/'):
        return method in {'GET', 'POST', 'HEAD'}
    if path in READ_ONLY_PATHS:
        return method in {'GET', 'HEAD'}
    return False


def _normalize_error_message(message: str) -> str:
    compact = ' '.join(message.split())
    return compact[:ERROR_MESSAGE_LIMIT]


def _error_payload(code: str, message: str) -> bytes:
    payload = {
        'error': {
            'code': code,
            'message': _normalize_error_message(message),
        }
    }
    return json.dumps(payload, separators=(',', ':')).encode('utf-8')


def _parse_content_length(headers) -> int:
    value = headers.get('Content-Length')
    if value is None:
        return 0
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise RequestValidationError(
            400,
            'invalid_content_length',
            'Invalid Content-Length header.',
        ) from exc
    if parsed < 0:
        raise RequestValidationError(
            400,
            'invalid_content_length',
            'Invalid Content-Length header.',
        )
    return parsed


def read_bounded_body(handler: BaseHTTPRequestHandler, config: GuardConfig) -> bytes:
    if handler.headers.get('Transfer-Encoding'):
        raise RequestValidationError(
            400,
            'unsupported_transfer_encoding',
            'Transfer-Encoding is not supported.',
        )
    content_length = _parse_content_length(handler.headers)
    if content_length > config.max_request_body_bytes:
        raise RequestValidationError(
            400,
            'body_too_large',
            'Request body exceeds the configured limit.',
        )
    if content_length == 0:
        return b''
    body = handler.rfile.read(content_length)
    if len(body) != content_length:
        raise RequestValidationError(
            400,
            'incomplete_body',
            'Request body ended before Content-Length bytes were read.',
        )
    return body


def validate_json_budget(body: bytes, config: GuardConfig) -> None:
    if not body:
        return
    try:
        document = json.loads(body.decode('utf-8'))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RequestValidationError(
            400,
            'invalid_json',
            'Malformed JSON request body.',
        ) from exc
    if not isinstance(document, dict):
        return
    for field in BUDGET_FIELDS:
        if field not in document:
            continue
        value = document[field]
        if type(value) is not int or value < 0 or value > config.max_output_budget:
            raise RequestValidationError(
                400,
                'invalid_budget',
                f'{field} must be a nonnegative integer no greater than {config.max_output_budget}.',
            )


def filter_request_headers(headers, body: bytes) -> dict[str, str]:
    filtered: dict[str, str] = {}
    for key, value in headers.items():
        lower_key = key.lower()
        if lower_key in HOP_BY_HOP_HEADERS or lower_key in {'host', 'content-length'}:
            continue
        filtered[key] = value
    filtered['Content-Length'] = str(len(body))
    filtered['X-DGX-Request-Guard'] = 'unsloth-studio'
    return filtered


def filter_response_headers(headers) -> list[tuple[str, str]]:
    filtered: list[tuple[str, str]] = []
    for key, value in headers:
        lower_key = key.lower()
        if lower_key in HOP_BY_HOP_HEADERS or lower_key == 'content-length':
            continue
        filtered.append((key, value))
    return filtered


def default_connection_factory(host: str, port: int, timeout: float) -> http.client.HTTPConnection:
    return http.client.HTTPConnection(host, port, timeout=timeout)


class RequestGuardHandler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    server_version = 'DGXRequestGuard/1.0'

    def do_GET(self) -> None:
        self._handle_proxy_request()

    def do_POST(self) -> None:
        self._handle_proxy_request()

    def do_HEAD(self) -> None:
        self._handle_proxy_request()

    def do_OPTIONS(self) -> None:
        self._send_json_error(
            404,
            'path_not_allowed',
            'Path is not allowed by the request guard.',
        )

    def log_message(self, format: str, *args) -> None:
        return None

    def _handle_proxy_request(self) -> None:
        resolved_backend = None
        upstream = None
        try:
            self._enforce_request_policy()
            body = read_bounded_body(self, self.server.guard_config)
            if self.command == 'POST':
                validate_json_budget(body, self.server.guard_config)
            resolved_backend = resolve_upstream(self.server)
            upstream = self.server.upstream_connection_factory(
                UPSTREAM_HOST,
                resolved_backend.port,
                self.server.guard_config.upstream_timeout_seconds,
            )
            upstream.request(
                self.command,
                self.path,
                body=body,
                headers=filter_request_headers(self.headers, body),
            )
            response = upstream.getresponse()
            self._write_upstream_response(response)
        except RequestValidationError as exc:
            self._send_json_error(exc.status_code, exc.code, exc.message)
        except BackendUnavailable:
            self._send_json_error(
                503,
                'backend_unavailable',
                'No ready Unsloth Studio model is available.',
            )
        except BackendAmbiguous:
            self._send_json_error(
                503,
                'backend_ambiguous',
                'Multiple eligible Unsloth Studio backends are active.',
            )
        except (socket.timeout, TimeoutError):
            if resolved_backend is not None:
                self.server.resolver.invalidate()
            self._send_json_error(504, 'upstream_timeout', 'Upstream request timed out.')
        except OSError as exc:
            if resolved_backend is not None:
                self.server.resolver.invalidate()
            self._send_json_error(502, 'bad_gateway', f'Upstream request failed: {exc}.')
        finally:
            if upstream is not None:
                upstream.close()

    def _enforce_request_policy(self) -> None:
        if not is_supported_method(self.command) or not is_path_allowed(self.command, self.path):
            raise RequestValidationError(
                404,
                'path_not_allowed',
                'Path is not allowed by the request guard.',
            )

    def _write_upstream_response(self, response) -> None:
        self.send_response(response.status, getattr(response, 'reason', None))
        for key, value in filter_response_headers(response.getheaders()):
            self.send_header(key, value)
        self.send_header('Connection', 'close')
        self.send_header('X-DGX-Request-Guard', 'unsloth-studio')
        self.end_headers()
        if self.command == 'HEAD':
            self.close_connection = True
            return
        read_chunk = getattr(response, 'read1', None) or response.read
        while True:
            chunk = read_chunk(RESPONSE_STREAM_CHUNK_SIZE)
            if not chunk:
                break
            self.wfile.write(chunk)
            self.wfile.flush()
        self.close_connection = True

    def _send_json_error(self, status_code: int, code: str, message: str) -> None:
        payload = _error_payload(code, message)
        self.send_response(status_code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload)))
        self.send_header('Connection', 'close')
        self.send_header('X-DGX-Request-Guard', 'unsloth-studio')
        self.end_headers()
        self.wfile.write(payload)
        self.close_connection = True


def create_server(
    config: GuardConfig | None = None,
    *,
    resolver=None,
    bind_and_activate: bool = False,
    connection_factory: Callable[[str, int, float], object] | None = None,
) -> GuardHTTPServer:
    guard_config = config or GuardConfig()
    server = GuardHTTPServer(
        (guard_config.bind_host, guard_config.bind_port),
        RequestGuardHandler,
        bind_and_activate=bind_and_activate,
    )
    server.guard_config = guard_config
    server.resolver = resolver or BackendResolver()
    server.upstream_connection_factory = connection_factory or default_connection_factory
    return server


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description='Unsloth Studio request guard')
    parser.add_argument(
        '--max-request-body-bytes',
        type=int,
        default=DEFAULT_MAX_REQUEST_BODY_BYTES,
    )
    parser.add_argument(
        '--upstream-timeout-seconds',
        type=float,
        default=DEFAULT_UPSTREAM_TIMEOUT_SECONDS,
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    config = GuardConfig(
        max_request_body_bytes=args.max_request_body_bytes,
        upstream_timeout_seconds=args.upstream_timeout_seconds,
    )
    server = create_server(config, bind_and_activate=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        return 0
    finally:
        server.server_close()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
