import copy
import importlib
import pathlib
import sys
import unittest


RUNTIME_DIR = pathlib.Path(__file__).resolve().parent
SYSTEMD_DIR = RUNTIME_DIR / 'systemd'
if str(RUNTIME_DIR) not in sys.path:
    sys.path.insert(0, str(RUNTIME_DIR))

INSTALL_SCRIPT = RUNTIME_DIR / 'install_exposure.sh'
REMOVE_SCRIPT = RUNTIME_DIR / 'remove_exposure.sh'
START_SCRIPT = RUNTIME_DIR / 'start_exposure.sh'
STOP_SCRIPT = RUNTIME_DIR / 'stop_exposure.sh'
README_PATH = RUNTIME_DIR / 'README.md'
ROUTE_STATE_PATH = RUNTIME_DIR / 'tailscale_route_state.py'
GUARD_UNIT_PATH = SYSTEMD_DIR / 'dgx-unsloth-guard.service'
LAN_UNIT_PATH = SYSTEMD_DIR / 'dgx-unsloth-lan-proxy.service'

RUNTIME_ROOT = '/home/mctdgx01/.local/lib/dgx-unsloth-exposure'
USER_UNIT_ROOT = '/home/mctdgx01/.config/systemd/user'
LAN_ADDRESS = '192.168.0.21'
PUBLIC_PORT = 56827
GUARD_PORT = 56828
GUARD_TARGET = f'127.0.0.1:{GUARD_PORT}'
WILDCARD_HOST = '0.0.0.' '0'
TAILSCALE_RESET = 'tailscale serve ' 'reset'
BROAD_KILL_PATTERNS = ('pk' 'ill', 'kill' 'all')

EXPECTED_GUARD_UNIT = """[Unit]
Description=DGX Unsloth dynamic request guard
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/bin/python3 /home/mctdgx01/.local/lib/dgx-unsloth-exposure/unsloth_request_guard.py
Restart=on-failure
RestartSec=2
NoNewPrivileges=yes
PrivateTmp=yes

[Install]
WantedBy=default.target
"""

EXPECTED_LAN_UNIT = """[Unit]
Description=DGX Unsloth LAN client proxy
After=dgx-unsloth-guard.service network-online.target
Requires=dgx-unsloth-guard.service

[Service]
ExecStart=/usr/bin/socat TCP-LISTEN:56827,bind=192.168.0.21,reuseaddr,fork TCP:127.0.0.1:56828
Restart=on-failure
RestartSec=2
NoNewPrivileges=yes
PrivateTmp=yes

[Install]
WantedBy=default.target
"""


def load_route_state_module():
    sys.modules.pop('tailscale_route_state', None)
    return importlib.import_module('tailscale_route_state')


class RecordingRunner:
    def __init__(self):
        self.calls = []

    def run(self, argv):
        self.calls.append(list(argv))
        return 0


class PackagingSurfaceTests(unittest.TestCase):
    def test_required_unit_files_exist_with_exact_contents(self):
        self.assertEqual(EXPECTED_GUARD_UNIT, GUARD_UNIT_PATH.read_text())
        self.assertEqual(EXPECTED_LAN_UNIT, LAN_UNIT_PATH.read_text())

    def test_packaging_scripts_use_exact_units_and_fixed_paths(self):
        required_paths = (
            INSTALL_SCRIPT,
            REMOVE_SCRIPT,
            START_SCRIPT,
            STOP_SCRIPT,
            README_PATH,
            ROUTE_STATE_PATH,
        )
        required_tokens = (
            'dgx-unsloth-guard.service',
            'dgx-unsloth-lan-proxy.service',
            RUNTIME_ROOT,
            USER_UNIT_ROOT,
            LAN_ADDRESS,
            GUARD_TARGET,
        )
        for path in required_paths:
            with self.subTest(path=path.name):
                text = path.read_text()
                for token in required_tokens:
                    self.assertIn(token, text)

    def test_static_packaging_forbids_wildcard_bind_reset_and_broad_kill_patterns(self):
        disallowed_raw_backend_target = f'--tcp={PUBLIC_PORT} 127.0.0.1:{PUBLIC_PORT}'
        for path in (
            INSTALL_SCRIPT,
            REMOVE_SCRIPT,
            START_SCRIPT,
            STOP_SCRIPT,
            README_PATH,
            ROUTE_STATE_PATH,
            GUARD_UNIT_PATH,
            LAN_UNIT_PATH,
        ):
            with self.subTest(path=path.name):
                text = path.read_text()
                self.assertNotIn(WILDCARD_HOST, text)
                self.assertNotIn(TAILSCALE_RESET, text)
                self.assertNotIn(disallowed_raw_backend_target, text)
                for token in BROAD_KILL_PATTERNS:
                    self.assertNotIn(token, text)


class TailscaleRouteStateTests(unittest.TestCase):
    def serve_status(self):
        return {
            'TCP': {
                '8443': {'TCPForward': '127.0.0.1:9443'},
            },
            'Web': {
                '443': {'Handlers': {'/': 'http://127.0.0.1:9000'}},
            },
            'AllowFunnel': {'443': False},
        }

    def test_classifies_absent_matching_and_conflicting_tcp_routes(self):
        route_state = load_route_state_module()

        absent = route_state.classify_tcp_route(
            self.serve_status(),
            port=PUBLIC_PORT,
            expected_target=GUARD_TARGET,
        )
        self.assertEqual('absent', absent.status)
        self.assertIsNone(absent.existing_target)

        matching_status = self.serve_status()
        matching_status['TCP'][str(PUBLIC_PORT)] = {'TCPForward': GUARD_TARGET}
        matching = route_state.classify_tcp_route(
            matching_status,
            port=PUBLIC_PORT,
            expected_target=GUARD_TARGET,
        )
        self.assertEqual('matching', matching.status)
        self.assertEqual(GUARD_TARGET, matching.existing_target)

        conflicting_status = self.serve_status()
        conflicting_status['TCP'][str(PUBLIC_PORT)] = {'TCPForward': '127.0.0.1:60000'}
        conflicting = route_state.classify_tcp_route(
            conflicting_status,
            port=PUBLIC_PORT,
            expected_target=GUARD_TARGET,
        )
        self.assertEqual('conflicting', conflicting.status)
        self.assertEqual('127.0.0.1:60000', conflicting.existing_target)

    def test_route_add_then_exact_remove_preserves_unrelated_routes(self):
        route_state = load_route_state_module()
        original = self.serve_status()

        added = route_state.add_tcp_route(
            copy.deepcopy(original),
            port=PUBLIC_PORT,
            expected_target=GUARD_TARGET,
        )
        removed = route_state.remove_tcp_route(
            copy.deepcopy(added),
            port=PUBLIC_PORT,
            expected_target=GUARD_TARGET,
        )

        self.assertEqual(
            route_state.normalize_serve_json(original),
            route_state.normalize_serve_json(removed),
        )

    def test_ensure_route_noops_on_match_and_adds_only_when_absent(self):
        route_state = load_route_state_module()
        runner = RecordingRunner()

        matching_status = self.serve_status()
        matching_status['TCP'][str(PUBLIC_PORT)] = {'TCPForward': GUARD_TARGET}
        plan = route_state.ensure_tcp_route(
            matching_status,
            runner=runner,
            port=PUBLIC_PORT,
            expected_target=GUARD_TARGET,
        )

        self.assertEqual('matching', plan.status)
        self.assertEqual([], runner.calls)

        runner = RecordingRunner()
        plan = route_state.ensure_tcp_route(
            self.serve_status(),
            runner=runner,
            port=PUBLIC_PORT,
            expected_target=GUARD_TARGET,
        )

        self.assertEqual('absent', plan.status)
        self.assertEqual(
            [['tailscale', 'serve', '--bg', '--tcp=56827', '127.0.0.1:56828']],
            runner.calls,
        )

    def test_conflict_raises_before_any_add_or_remove_command_executes(self):
        route_state = load_route_state_module()
        runner = RecordingRunner()
        conflicting_status = self.serve_status()
        conflicting_status['TCP'][str(PUBLIC_PORT)] = {'TCPForward': '127.0.0.1:60000'}

        with self.assertRaises(route_state.RouteConflict):
            route_state.ensure_tcp_route(
                conflicting_status,
                runner=runner,
                port=PUBLIC_PORT,
                expected_target=GUARD_TARGET,
            )
        self.assertEqual([], runner.calls)

        with self.assertRaises(route_state.RouteConflict):
            route_state.remove_owned_tcp_route(
                conflicting_status,
                runner=runner,
                port=PUBLIC_PORT,
                expected_target=GUARD_TARGET,
                route_created=True,
            )
        self.assertEqual([], runner.calls)


if __name__ == '__main__':
    unittest.main()
