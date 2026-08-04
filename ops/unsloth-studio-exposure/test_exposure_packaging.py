import copy
import configparser
import importlib
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


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
PrivateTmp=no

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


class CallbackRunner(RecordingRunner):
    def __init__(self, callback):
        super().__init__()
        self.callback = callback

    def run(self, argv):
        self.callback(list(argv))
        return super().run(argv)


class PackagingSurfaceTests(unittest.TestCase):
    def run_start_with_fake_host(
        self,
        *,
        units_preexisting,
        guard_listener_host='127.0.0.1',
    ):
        with tempfile.TemporaryDirectory() as temp_root_text:
            temp_root = pathlib.Path(temp_root_text)
            fake_bin = temp_root / 'bin'
            active_root = temp_root / 'active'
            runtime_root = temp_root / 'runtime'
            unit_root = temp_root / 'units'
            state_file = temp_root / 'state' / 'active-operation.env'
            evidence_dir = temp_root / 'evidence'
            systemctl_log = temp_root / 'systemctl.log'
            fake_bin.mkdir()
            active_root.mkdir()
            runtime_root.mkdir()
            unit_root.mkdir()

            if units_preexisting:
                (active_root / 'dgx-unsloth-guard.service').touch()
                (active_root / 'dgx-unsloth-lan-proxy.service').touch()

            fake_systemctl = fake_bin / 'systemctl'
            fake_systemctl.write_text(f'''#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "{systemctl_log}"
if [[ "$1" == "--user" ]]; then shift; fi
command="$1"
unit="${{@: -1}}"
case "${{command}}" in
  is-active)
    [[ -f "{active_root}/${{unit}}" ]]
    ;;
  show)
    if [[ -f "{active_root}/${{unit}}" ]]; then
      [[ "${{unit}}" == "dgx-unsloth-guard.service" ]] && printf '101\\n' || printf '102\\n'
    else
      printf '0\\n'
    fi
    ;;
  start)
    touch "{active_root}/${{unit}}"
    ;;
  stop)
    rm -f "{active_root}/${{unit}}"
    ;;
esac
''')
            fake_systemctl.chmod(0o755)

            fake_ip = fake_bin / 'ip'
            fake_ip.write_text(
                '#!/usr/bin/env bash\n'
                "printf '2: eth0    inet 192.168.0.21/24 scope global eth0\\n'\n"
            )
            fake_ip.chmod(0o755)

            fake_ss = fake_bin / 'ss'
            fake_ss.write_text(f'''#!/usr/bin/env bash
if [[ -f "{active_root}/dgx-unsloth-guard.service" ]]; then
  printf 'LISTEN 0 128 {guard_listener_host}:56828 0.0.0.0:* users:(("python3",pid=101,fd=3))\\n'
fi
if [[ -f "{active_root}/dgx-unsloth-lan-proxy.service" ]]; then
  printf 'LISTEN 0 128 192.168.0.21:56827 0.0.0.0:* users:(("socat",pid=102,fd=3))\\n'
fi
''')
            fake_ss.chmod(0o755)

            route_helper = runtime_root / 'tailscale_route_state.py'
            route_helper.write_text(
                '#!/usr/bin/env python3\n'
                'import sys\n'
                "raise SystemExit(1 if sys.argv[1] == 'ensure' else 0)\n"
            )
            route_helper.chmod(0o755)

            safe_start = temp_root / 'start_exposure.sh'
            safe_start.write_text(
                START_SCRIPT.read_text().replace('/usr/bin/systemctl', str(fake_systemctl))
            )
            safe_start.chmod(0o755)

            env = os.environ.copy()
            env['PATH'] = f'{fake_bin}:{env["PATH"]}'
            env['DGX_UNSLOTH_EXPOSURE_SYSTEMCTL_BIN'] = str(fake_systemctl)
            result = subprocess.run(
                [
                    str(safe_start),
                    '--state-file', str(state_file),
                    '--evidence-dir', str(evidence_dir),
                    '--runtime-root', str(runtime_root),
                    '--user-unit-root', str(unit_root),
                    '--lan-address', LAN_ADDRESS,
                    '--guard-target', GUARD_TARGET,
                ],
                capture_output=True,
                text=True,
                env=env,
                check=False,
            )
            calls = systemctl_log.read_text().splitlines()
            active_units = sorted(path.name for path in active_root.iterdir())
            return result, calls, active_units

    def run_install_with_fake_preflight(
        self,
        *,
        route_conflict=False,
        listener_conflict=False,
        listener_pid_unavailable=False,
        runs=1,
    ):
        with tempfile.TemporaryDirectory() as temp_root_text:
            temp_root = pathlib.Path(temp_root_text)
            package_root = temp_root / 'package'
            fake_bin = temp_root / 'bin'
            runtime_root = temp_root / 'installed-runtime'
            unit_root = temp_root / 'installed-units'
            state_root = temp_root / 'state'
            active_root = temp_root / 'active'
            systemctl_log = temp_root / 'systemctl.log'
            shutil.copytree(RUNTIME_DIR, package_root)
            fake_bin.mkdir()
            active_root.mkdir()

            fake_systemctl = fake_bin / 'systemctl'
            fake_systemctl.write_text(f'''#!/usr/bin/env bash
printf '%s\\n' "$*" >> "{systemctl_log}"
if [[ "$1" == "--user" ]]; then shift; fi
command="$1"
unit="${{@: -1}}"
case "${{command}}" in
  is-active) [[ -f "{active_root}/${{unit}}" ]] ;;
  show)
    if [[ -f "{active_root}/${{unit}}" ]]; then
      [[ "${{unit}}" == "dgx-unsloth-guard.service" ]] && printf '101\\n' || printf '102\\n'
    else
      printf '0\\n'
    fi
    ;;
  start) touch "{active_root}/${{unit}}" ;;
  stop) rm -f "{active_root}/${{unit}}" ;;
esac
exit 0
''')
            fake_systemctl.chmod(0o755)

            fake_ip = fake_bin / 'ip'
            fake_ip.write_text(
                '#!/usr/bin/env bash\n'
                "printf '2: eth0    inet 192.168.0.21/24 scope global eth0\\n'\n"
            )
            fake_ip.chmod(0o755)

            fake_ss = fake_bin / 'ss'
            if listener_conflict:
                fake_ss.write_text(
                    '#!/usr/bin/env bash\n'
                    "printf 'LISTEN 0 128 127.0.0.1:56828 0.0.0.0:* users:((\"evil\",pid=999,fd=3))\\n'\n"
                )
            elif listener_pid_unavailable:
                fake_ss.write_text(
                    '#!/usr/bin/env bash\n'
                    "printf 'LISTEN 0 128 127.0.0.1:56828 0.0.0.0:*\\n'\n"
                )
            else:
                fake_ss.write_text(f'''#!/usr/bin/env bash
if [[ -f "{active_root}/dgx-unsloth-guard.service" ]]; then
  printf 'LISTEN 0 128 127.0.0.1:56828 0.0.0.0:* users:(("python3",pid=101,fd=3))\\n'
fi
if [[ -f "{active_root}/dgx-unsloth-lan-proxy.service" ]]; then
  printf 'LISTEN 0 128 192.168.0.21:56827 0.0.0.0:* users:(("socat",pid=102,fd=3))\\n'
fi
''')
            fake_ss.chmod(0o755)

            route_helper = package_root / 'tailscale_route_state.py'
            route_helper.write_text(
                '#!/usr/bin/env python3\n'
                'import sys\n'
                + (
                    "raise SystemExit(1 if sys.argv[1] == 'preflight' else 0)\n"
                    if route_conflict else 'raise SystemExit(0)\n'
                )
            )
            route_helper.chmod(0o755)

            install_script = package_root / 'install_exposure.sh'
            install_script.write_text(
                install_script.read_text().replace('/usr/bin/systemctl', str(fake_systemctl))
            )

            env = os.environ.copy()
            env.update({
                'PATH': f'{fake_bin}:{env["PATH"]}',
                'DGX_UNSLOTH_EXPOSURE_SYSTEMCTL_BIN': str(fake_systemctl),
                'DGX_UNSLOTH_EXPOSURE_RUNTIME_ROOT': str(runtime_root),
                'DGX_UNSLOTH_EXPOSURE_USER_UNIT_ROOT': str(unit_root),
                'DGX_UNSLOTH_EXPOSURE_STATE_ROOT': str(state_root),
            })
            results = [
                subprocess.run(
                    [str(install_script)],
                    capture_output=True,
                    text=True,
                    env=env,
                    check=False,
                )
                for _ in range(runs)
            ]
            calls = (
                systemctl_log.read_text().splitlines()
                if systemctl_log.exists() else []
            )
            return results, runtime_root.exists(), unit_root.exists(), calls

    def test_units_keep_host_inspection_compatible_hardening(self):
        guard_unit = configparser.ConfigParser(interpolation=None)
        guard_unit.read(GUARD_UNIT_PATH)
        lan_unit = configparser.ConfigParser(interpolation=None)
        lan_unit.read(LAN_UNIT_PATH)

        self.assertFalse(guard_unit.getboolean('Service', 'PrivateTmp', fallback=False))
        self.assertTrue(guard_unit.getboolean('Service', 'NoNewPrivileges'))
        self.assertTrue(lan_unit.getboolean('Service', 'PrivateTmp'))
        self.assertTrue(lan_unit.getboolean('Service', 'NoNewPrivileges'))

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

    def test_failed_repeated_start_does_not_stop_preexisting_units(self):
        result, calls, active_units = self.run_start_with_fake_host(
            units_preexisting=True,
        )

        self.assertNotEqual(0, result.returncode)
        self.assertIn('--user start dgx-unsloth-guard.service', calls)
        self.assertIn('--user start dgx-unsloth-lan-proxy.service', calls)
        self.assertNotIn('--user stop dgx-unsloth-guard.service', calls)
        self.assertNotIn('--user stop dgx-unsloth-lan-proxy.service', calls)
        self.assertEqual(
            ['dgx-unsloth-guard.service', 'dgx-unsloth-lan-proxy.service'],
            active_units,
        )

    def test_failed_initial_start_stops_only_units_started_by_that_invocation(self):
        result, calls, active_units = self.run_start_with_fake_host(
            units_preexisting=False,
        )

        self.assertNotEqual(0, result.returncode)
        self.assertIn('--user stop dgx-unsloth-guard.service', calls)
        self.assertIn('--user stop dgx-unsloth-lan-proxy.service', calls)
        self.assertEqual([], active_units)

    def test_start_preflight_rejects_wildcard_listener_owned_by_expected_unit(self):
        for wildcard_host in ('0.0.0.0', '[::]', '*'):
            with self.subTest(wildcard_host=wildcard_host):
                result, calls, active_units = self.run_start_with_fake_host(
                    units_preexisting=True,
                    guard_listener_host=wildcard_host,
                )

                self.assertNotEqual(0, result.returncode)
                self.assertIn('wildcard listener', result.stderr)
                self.assertNotIn('--user start dgx-unsloth-guard.service', calls)
                self.assertNotIn('--user start dgx-unsloth-lan-proxy.service', calls)
                self.assertEqual(
                    ['dgx-unsloth-guard.service', 'dgx-unsloth-lan-proxy.service'],
                    active_units,
                )

    def test_listener_presence_rejects_wildcard_after_expected_unit_starts(self):
        result, calls, active_units = self.run_start_with_fake_host(
            units_preexisting=False,
            guard_listener_host='0.0.0.0',
        )

        self.assertNotEqual(0, result.returncode)
        self.assertIn('wildcard listener', result.stderr)
        self.assertIn('exact listener 127.0.0.1:56828 is required', result.stderr)
        self.assertIn('--user start dgx-unsloth-guard.service', calls)
        self.assertNotIn('--user start dgx-unsloth-lan-proxy.service', calls)
        self.assertIn('--user stop dgx-unsloth-guard.service', calls)
        self.assertEqual([], active_units)

    def test_install_route_conflict_preflight_does_not_mutate_files_or_enablement(self):
        results, runtime_exists, units_exist, calls = self.run_install_with_fake_preflight(
            route_conflict=True,
        )

        self.assertNotEqual(0, results[0].returncode)
        self.assertFalse(runtime_exists)
        self.assertFalse(units_exist)
        self.assertEqual([], calls)

    def test_install_listener_conflict_preflight_does_not_mutate_files_or_enablement(self):
        results, runtime_exists, units_exist, calls = self.run_install_with_fake_preflight(
            listener_conflict=True,
        )

        self.assertNotEqual(0, results[0].returncode)
        self.assertFalse(runtime_exists)
        self.assertFalse(units_exist)
        self.assertTrue(all(' show ' in f' {call} ' for call in calls))

    def test_install_listener_without_pid_metadata_is_occupied_before_mutation(self):
        results, runtime_exists, units_exist, calls = self.run_install_with_fake_preflight(
            listener_pid_unavailable=True,
        )

        self.assertNotEqual(0, results[0].returncode)
        self.assertIn('occupied unowned listener', results[0].stderr)
        self.assertFalse(runtime_exists)
        self.assertFalse(units_exist)
        self.assertTrue(all(' show ' in f' {call} ' for call in calls))

    def test_repeated_successful_install_is_idempotent(self):
        results, runtime_exists, units_exist, calls = self.run_install_with_fake_preflight(
            runs=2,
        )

        self.assertEqual([0, 0], [result.returncode for result in results])
        self.assertTrue(runtime_exists)
        self.assertTrue(units_exist)
        self.assertNotIn('--user stop dgx-unsloth-guard.service', calls)
        self.assertNotIn('--user stop dgx-unsloth-lan-proxy.service', calls)


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

    def test_ensure_records_pending_state_before_add_and_verifies_exact_route(self):
        route_state = load_route_state_module()
        absent = self.serve_status()
        matching = self.serve_status()
        matching['TCP'][str(PUBLIC_PORT)] = {'TCPForward': GUARD_TARGET}

        with tempfile.TemporaryDirectory() as temp_root_text:
            temp_root = pathlib.Path(temp_root_text)
            state_file = temp_root / 'active-operation.env'
            evidence_dir = temp_root / 'evidence'

            def inspect_pending(argv):
                if argv[-1] == 'off':
                    return
                state = route_state._read_state(state_file)
                self.assertEqual('1', state['ROUTE_PENDING'])
                self.assertEqual('0', state['ROUTE_CREATED'])
                self.assertEqual('0', state['ROUTE_PREEXISTING'])
                self.assertEqual(str(PUBLIC_PORT), state['ROUTE_PORT'])
                self.assertEqual(GUARD_TARGET, state['ROUTE_TARGET'])

            runner = CallbackRunner(inspect_pending)
            with (
                mock.patch.object(
                    route_state,
                    '_capture_evidence',
                    side_effect=[absent, matching],
                ),
                mock.patch.object(route_state, 'SubprocessRunner', return_value=runner),
            ):
                route_state.main([
                    'ensure', '--state-file', str(state_file),
                    '--evidence-dir', str(evidence_dir),
                ])

            self.assertEqual(
                [['tailscale', 'serve', '--bg', '--tcp=56827', GUARD_TARGET]],
                runner.calls,
            )
            state = route_state._read_state(state_file)
            self.assertEqual('0', state['ROUTE_PENDING'])
            self.assertEqual('1', state['ROUTE_CREATED'])
            self.assertEqual('0', state['ROUTE_PREEXISTING'])

    def test_final_ownership_write_failure_compensates_exact_created_route(self):
        route_state = load_route_state_module()
        runner = RecordingRunner()
        absent = self.serve_status()
        matching = self.serve_status()
        matching['TCP'][str(PUBLIC_PORT)] = {'TCPForward': GUARD_TARGET}

        with tempfile.TemporaryDirectory() as temp_root_text:
            temp_root = pathlib.Path(temp_root_text)
            state_file = temp_root / 'active-operation.env'
            evidence_dir = temp_root / 'evidence'
            original_write_state = route_state._write_state

            def fail_final_write(path, **entries):
                if entries.get('ROUTE_CREATED') == '1' and entries.get('ROUTE_PENDING') == '0':
                    raise OSError('simulated final state write failure')
                return original_write_state(path, **entries)

            with (
                mock.patch.object(
                    route_state,
                    '_capture_evidence',
                    side_effect=[absent, matching],
                ),
                mock.patch.object(route_state, 'SubprocessRunner', return_value=runner),
                mock.patch.object(route_state, '_write_state', side_effect=fail_final_write),
            ):
                with self.assertRaisesRegex(OSError, 'simulated final state write failure'):
                    route_state.main([
                        'ensure', '--state-file', str(state_file),
                        '--evidence-dir', str(evidence_dir),
                    ])

            self.assertEqual(
                [
                    ['tailscale', 'serve', '--bg', '--tcp=56827', GUARD_TARGET],
                    ['tailscale', 'serve', '--bg', '--tcp=56827', 'off'],
                ],
                runner.calls,
            )
            state = route_state._read_state(state_file)
            self.assertEqual('0', state['ROUTE_PENDING'])
            self.assertEqual('0', state['ROUTE_CREATED'])
            self.assertEqual('0', state['ROUTE_PREEXISTING'])
            self.assertEqual('1', state['ROUTE_REMOVED'])

    def test_post_mutation_verification_failure_compensates_exact_created_route(self):
        route_state = load_route_state_module()
        runner = RecordingRunner()
        absent = self.serve_status()

        with tempfile.TemporaryDirectory() as temp_root_text:
            temp_root = pathlib.Path(temp_root_text)
            state_file = temp_root / 'active-operation.env'
            evidence_dir = temp_root / 'evidence'
            with (
                mock.patch.object(
                    route_state,
                    '_capture_evidence',
                    side_effect=[absent, absent],
                ),
                mock.patch.object(route_state, 'SubprocessRunner', return_value=runner),
            ):
                with self.assertRaises(route_state.RouteConflict):
                    route_state.main([
                        'ensure', '--state-file', str(state_file),
                        '--evidence-dir', str(evidence_dir),
                    ])

            self.assertEqual(
                [
                    ['tailscale', 'serve', '--bg', '--tcp=56827', GUARD_TARGET],
                    ['tailscale', 'serve', '--bg', '--tcp=56827', 'off'],
                ],
                runner.calls,
            )
            state = route_state._read_state(state_file)
            self.assertEqual('0', state['ROUTE_PENDING'])
            self.assertEqual('0', state['ROUTE_CREATED'])
            self.assertEqual('0', state['ROUTE_PREEXISTING'])
            self.assertEqual('1', state['ROUTE_REMOVED'])

    def test_compensated_pending_state_never_owns_a_later_inherited_matching_route(self):
        route_state = load_route_state_module()
        runner = RecordingRunner()
        absent = self.serve_status()
        inherited = self.serve_status()
        inherited['TCP'][str(PUBLIC_PORT)] = {'TCPForward': GUARD_TARGET}

        with tempfile.TemporaryDirectory() as temp_root_text:
            temp_root = pathlib.Path(temp_root_text)
            state_file = temp_root / 'active-operation.env'
            evidence_dir = temp_root / 'evidence'
            with (
                mock.patch.object(
                    route_state,
                    '_capture_evidence',
                    side_effect=[absent, absent, inherited],
                ),
                mock.patch.object(route_state, 'SubprocessRunner', return_value=runner),
            ):
                with self.assertRaises(route_state.RouteConflict):
                    route_state.main([
                        'ensure', '--state-file', str(state_file),
                        '--evidence-dir', str(evidence_dir),
                    ])
                route_state.main([
                    'remove', '--state-file', str(state_file),
                    '--evidence-dir', str(evidence_dir),
                ])

            self.assertEqual(
                [
                    ['tailscale', 'serve', '--bg', '--tcp=56827', GUARD_TARGET],
                    ['tailscale', 'serve', '--bg', '--tcp=56827', 'off'],
                ],
                runner.calls,
            )
            state = route_state._read_state(state_file)
            self.assertEqual('0', state['ROUTE_PENDING'])
            self.assertEqual('0', state['ROUTE_CREATED'])
            self.assertEqual('0', state['ROUTE_PREEXISTING'])
            self.assertEqual('1', state['ROUTE_REMOVED'])

    def test_repeated_ensure_preserves_created_route_ownership_for_remove(self):
        route_state = load_route_state_module()
        runner = RecordingRunner()
        absent = self.serve_status()
        matching = self.serve_status()
        matching['TCP'][str(PUBLIC_PORT)] = {'TCPForward': GUARD_TARGET}

        with tempfile.TemporaryDirectory() as temp_root_text:
            temp_root = pathlib.Path(temp_root_text)
            state_file = temp_root / 'active-operation.env'
            evidence_dir = temp_root / 'evidence'
            with (
                mock.patch.object(
                    route_state,
                    '_capture_evidence',
                    side_effect=[absent, matching, matching, matching, absent],
                ),
                mock.patch.object(
                    route_state,
                    'SubprocessRunner',
                    return_value=runner,
                ),
            ):
                route_state.main([
                    'ensure', '--state-file', str(state_file),
                    '--evidence-dir', str(evidence_dir),
                ])
                route_state.main([
                    'ensure', '--state-file', str(state_file),
                    '--evidence-dir', str(evidence_dir),
                ])
                route_state.main([
                    'remove', '--state-file', str(state_file),
                    '--evidence-dir', str(evidence_dir),
                ])

            self.assertEqual(
                [
                    ['tailscale', 'serve', '--bg', '--tcp=56827', GUARD_TARGET],
                    ['tailscale', 'serve', '--bg', '--tcp=56827', 'off'],
                ],
                runner.calls,
            )
            state = route_state._read_state(state_file)
            self.assertEqual('1', state['ROUTE_CREATED'])
            self.assertEqual('0', state['ROUTE_PREEXISTING'])
            self.assertEqual('1', state['ROUTE_REMOVED'])

    def test_remove_verifies_route_absence_before_recording_removed(self):
        route_state = load_route_state_module()
        runner = RecordingRunner()
        matching = self.serve_status()
        matching['TCP'][str(PUBLIC_PORT)] = {'TCPForward': GUARD_TARGET}

        with tempfile.TemporaryDirectory() as temp_root_text:
            temp_root = pathlib.Path(temp_root_text)
            state_file = temp_root / 'active-operation.env'
            evidence_dir = temp_root / 'evidence'
            route_state._record_route_state(
                state_file,
                created=True,
                preexisting=False,
                pending=False,
            )
            with (
                mock.patch.object(
                    route_state,
                    '_capture_evidence',
                    side_effect=[matching, matching],
                ),
                mock.patch.object(route_state, 'SubprocessRunner', return_value=runner),
            ):
                with self.assertRaises(route_state.RouteConflict):
                    route_state.main([
                        'remove', '--state-file', str(state_file),
                        '--evidence-dir', str(evidence_dir),
                    ])

            self.assertEqual(
                [['tailscale', 'serve', '--bg', '--tcp=56827', 'off']],
                runner.calls,
            )
            state = route_state._read_state(state_file)
            self.assertEqual('1', state['ROUTE_CREATED'])
            self.assertEqual('0', state['ROUTE_REMOVED'])

    def test_matching_preexisting_route_is_not_claimed_or_removed(self):
        route_state = load_route_state_module()
        runner = RecordingRunner()
        matching = self.serve_status()
        matching['TCP'][str(PUBLIC_PORT)] = {'TCPForward': GUARD_TARGET}

        with tempfile.TemporaryDirectory() as temp_root_text:
            temp_root = pathlib.Path(temp_root_text)
            state_file = temp_root / 'active-operation.env'
            evidence_dir = temp_root / 'evidence'
            with (
                mock.patch.object(
                    route_state,
                    '_capture_evidence',
                    side_effect=[matching, matching],
                ),
                mock.patch.object(
                    route_state,
                    'SubprocessRunner',
                    return_value=runner,
                ),
            ):
                route_state.main([
                    'ensure', '--state-file', str(state_file),
                    '--evidence-dir', str(evidence_dir),
                ])
                route_state.main([
                    'remove', '--state-file', str(state_file),
                    '--evidence-dir', str(evidence_dir),
                ])

            self.assertEqual([], runner.calls)
            state = route_state._read_state(state_file)
            self.assertEqual('0', state['ROUTE_CREATED'])
            self.assertEqual('1', state['ROUTE_PREEXISTING'])
            self.assertEqual('0', state['ROUTE_REMOVED'])

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
