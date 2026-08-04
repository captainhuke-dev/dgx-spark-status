import copy
import importlib
import pathlib
import subprocess
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
        disallowed_wildcard_bind = 'bind=0.0.0.0'
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
                self.assertNotIn(disallowed_wildcard_bind, text)
                self.assertNotIn(TAILSCALE_RESET, text)
                self.assertNotIn(disallowed_raw_backend_target, text)
                for token in BROAD_KILL_PATTERNS:
                    self.assertNotIn(token, text)

    def test_start_script_preflights_route_before_starting_units(self):
        text = START_SCRIPT.read_text()
        route_preflight = text.index('python3 "${route_helper}" preflight')
        guard_start = text.index('systemctl_user start "${GUARD_UNIT_NAME}"')
        lan_start = text.index('systemctl_user start "${LAN_PROXY_UNIT_NAME}"')

        self.assertLess(route_preflight, guard_start)
        self.assertLess(route_preflight, lan_start)

    def test_start_script_listener_preflight_mentions_wildcard_bind_conflicts(self):
        text = START_SCRIPT.read_text()

        self.assertIn('0.0.0.0', text)
        self.assertIn('[::]', text)
        self.assertIn('*', text)

    def test_remove_script_falls_back_to_source_tree_route_helper_for_repeat_safe_remove(self):
        text = REMOVE_SCRIPT.read_text()

        self.assertIn('route_helper="${RUNTIME_ROOT}/tailscale_route_state.py"', text)
        self.assertIn('route_helper="${SCRIPT_DIR}/tailscale_route_state.py"', text)
        self.assertIn('if [[ -n "${route_helper}" && -x "${route_helper}" ]]', text)


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

    def test_capture_evidence_always_records_serve_status_json(self):
        route_state = load_route_state_module()
        calls = []
        original_capture = route_state._capture_command_output

        def fake_capture(evidence_dir, name, argv, *, check=False):
            calls.append((name, list(argv), check))
            if name == 'tailscale-serve-get-config-all.json':
                return subprocess.CompletedProcess(argv, 0, stdout='{"TCP": {"56827": {"TCPForward": "127.0.0.1:56828"}}}', stderr='')
            if name == 'tailscale-serve-status.json':
                return subprocess.CompletedProcess(argv, 0, stdout='{"TCP": {"56827": {"TCPForward": "127.0.0.1:56828"}}}', stderr='')
            return subprocess.CompletedProcess(argv, 0, stdout='{}', stderr='')

        route_state._capture_command_output = fake_capture
        try:
            document = route_state._capture_evidence(pathlib.Path('/tmp/dgx-unsloth-exposure-tests'))
        finally:
            route_state._capture_command_output = original_capture

        self.assertEqual(
            {'TCP': {'56827': {'TCPForward': '127.0.0.1:56828'}}},
            document,
        )
        self.assertIn(
            ('tailscale-serve-status.json', ['tailscale', 'serve', 'status', '--json'], True),
            calls,
        )

    def test_status_routes_are_authoritative_when_get_config_is_version_only(self):
        route_state = load_route_state_module()
        status_document = {
            'TCP': {
                '56827': {'TCPForward': GUARD_TARGET},
                '8443': {'TCPForward': '127.0.0.1:9443'},
            },
        }
        calls = []
        original_capture = route_state._capture_command_output

        def fake_capture(evidence_dir, name, argv, *, check=False):
            calls.append(name)
            if name == 'tailscale-serve-status.json':
                return subprocess.CompletedProcess(
                    argv,
                    0,
                    stdout='{"TCP": {"56827": {"TCPForward": "127.0.0.1:56828"}, "8443": {"TCPForward": "127.0.0.1:9443"}}}',
                    stderr='',
                )
            if name == 'tailscale-serve-get-config-all.json':
                return subprocess.CompletedProcess(argv, 0, stdout='{"version":"0.0.1"}', stderr='')
            return subprocess.CompletedProcess(argv, 0, stdout='{}', stderr='')

        route_state._capture_command_output = fake_capture
        try:
            document = route_state._load_serve_document(pathlib.Path('/tmp/dgx-unsloth-exposure-tests'))
        finally:
            route_state._capture_command_output = original_capture

        self.assertEqual(status_document, document)
        classification = route_state.classify_tcp_route(
            document,
            port=PUBLIC_PORT,
            expected_target=GUARD_TARGET,
        )
        self.assertEqual('matching', classification.status)

        runner = RecordingRunner()
        plan = route_state.ensure_tcp_route(
            document,
            runner=runner,
            port=PUBLIC_PORT,
            expected_target=GUARD_TARGET,
        )
        self.assertEqual('matching', plan.status)
        self.assertEqual([], runner.calls)
        self.assertEqual(
            ['tailscale-serve-status.json', 'tailscale-serve-get-config-all.json'],
            calls,
        )


if __name__ == '__main__':
    unittest.main()
