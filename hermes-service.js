export const HERMES_RUNTIME = Object.freeze({
  dashboardUnit: 'hermes-dashboard.service',
  proxyUnit: 'hermes-tail-proxy.service',
  localUrl: 'http://192.168.0.21:9119',
  upstreamUrl: 'http://127.0.0.1:9119',
  proxyUrl: 'http://127.0.0.1:9120',
  tailnetUrl: 'http://100.108.68.20:9119',
  logoPath: '/home/mctdgx01/.hermes/hermes-agent/website/static/img/logo.png',
  userRuntimeDir: '/run/user/1000',
});

const APPROVED_UNITS = new Set([
  HERMES_RUNTIME.dashboardUnit,
  HERMES_RUNTIME.proxyUnit,
]);

export class HermesServiceError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'HermesServiceError';
    this.code = code;
  }
}

export function hermesErrorStatus(error) {
  return error?.code === 'busy' ? 409 : 503;
}

export function hermesErrorPayload(error) {
  if (error?.code === 'busy') {
    return {
      ok: false,
      code: 'busy',
      message: 'Hermes is already processing another action.',
    };
  }

  return {
    ok: false,
    code: 'operation_failed',
    message: 'Hermes could not complete the requested action.',
  };
}

export function sendHermesLogo(_request, response, next) {
  response.type('png').sendFile(
    HERMES_RUNTIME.logoPath,
    { dotfiles: 'allow' },
    (error) => {
      if (error) next(error);
    },
  );
}

function parseProperties(stdout = '') {
  return Object.fromEntries(
    stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf('=');
        return separator === -1
          ? [line, '']
          : [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

export function createHermesServiceController({
  execFile,
  fetchImpl = globalThis.fetch,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  pollAttempts = 30,
  pollIntervalMs = 500,
  probeTimeoutMs = 2500,
} = {}) {
  if (typeof execFile !== 'function') throw new TypeError('execFile dependency is required');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl dependency is required');

  let actionInFlight = false;

  const systemdOptions = () => ({
    timeout: 10_000,
    env: {
      ...process.env,
      XDG_RUNTIME_DIR: HERMES_RUNTIME.userRuntimeDir,
      DBUS_SESSION_BUS_ADDRESS: `unix:path=${HERMES_RUNTIME.userRuntimeDir}/bus`,
    },
  });

  async function systemctl(action, unit, extraArguments = []) {
    if (!APPROVED_UNITS.has(unit)) {
      throw new HermesServiceError('operation_failed', 'Unapproved Hermes service unit');
    }

    return execFile(
      'systemctl',
      ['--user', action, unit, ...extraArguments],
      systemdOptions(),
    );
  }

  async function showUnit(unit) {
    try {
      const { stdout } = await systemctl('show', unit, [
        '--property=ActiveState',
        '--property=UnitFileState',
        '--no-pager',
      ]);
      const properties = parseProperties(stdout);
      return {
        unit,
        active: properties.ActiveState === 'active',
        activeState: properties.ActiveState || 'unknown',
        enabled: properties.UnitFileState === 'enabled',
        unitFileState: properties.UnitFileState || 'unknown',
      };
    } catch {
      return {
        unit,
        active: false,
        activeState: 'unknown',
        enabled: false,
        unitFileState: 'unknown',
      };
    }
  }

  async function probeHealth() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), probeTimeoutMs);

    try {
      const response = await fetchImpl(`${HERMES_RUNTIME.upstreamUrl}/api/status`, {
        signal: controller.signal,
        headers: { accept: 'application/json' },
      });
      return {
        ok: response.ok,
        status: response.status,
        endpoint: `${HERMES_RUNTIME.upstreamUrl}/api/status`,
      };
    } catch {
      return {
        ok: false,
        status: null,
        endpoint: `${HERMES_RUNTIME.upstreamUrl}/api/status`,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async function status() {
    const [dashboard, proxy, health] = await Promise.all([
      showUnit(HERMES_RUNTIME.dashboardUnit),
      showUnit(HERMES_RUNTIME.proxyUnit),
      probeHealth(),
    ]);
    const ready = dashboard.active && proxy.active && health.ok;
    const fullyStopped = !dashboard.active && !proxy.active;

    return {
      ok: true,
      state: ready ? 'online' : fullyStopped ? 'offline' : 'degraded',
      ready,
      url: HERMES_RUNTIME.tailnetUrl,
      localUrl: HERMES_RUNTIME.localUrl,
      proxyUrl: HERMES_RUNTIME.proxyUrl,
      dashboard,
      proxy,
      health,
    };
  }

  async function waitFor(predicate, timeoutCode) {
    let latest;
    for (let attempt = 0; attempt < pollAttempts; attempt += 1) {
      latest = await status();
      if (predicate(latest)) return latest;
      if (attempt < pollAttempts - 1) await sleep(pollIntervalMs);
    }
    throw new HermesServiceError(timeoutCode, `Hermes state did not settle: ${latest?.state || 'unknown'}`);
  }

  async function runAction(operation) {
    if (actionInFlight) {
      throw new HermesServiceError('busy', 'Another Hermes action is already running');
    }

    actionInFlight = true;
    try {
      return await operation();
    } catch (error) {
      if (error instanceof HermesServiceError) throw error;
      throw new HermesServiceError('operation_failed', 'Hermes service operation failed', error);
    } finally {
      actionInFlight = false;
    }
  }

  function start() {
    return runAction(async () => {
      await systemctl('start', HERMES_RUNTIME.dashboardUnit);
      await systemctl('start', HERMES_RUNTIME.proxyUnit);
      return waitFor((result) => result.ready, 'start_timeout');
    });
  }

  function stop() {
    return runAction(async () => {
      await systemctl('stop', HERMES_RUNTIME.proxyUnit);
      await systemctl('stop', HERMES_RUNTIME.dashboardUnit);
      return waitFor(
        (result) => !result.dashboard.active && !result.proxy.active,
        'stop_timeout',
      );
    });
  }

  return { status, start, stop };
}
