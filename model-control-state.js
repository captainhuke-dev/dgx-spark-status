export const DEGRADED_RESIDENT_STATUS = 'degraded_resident';

export function isActiveControlStatus(status) {
  return ['running', 'loading', 'starting', DEGRADED_RESIDENT_STATUS].includes(String(status || ''));
}

export function modelControlStatusLabel(status) {
  if (status === DEGRADED_RESIDENT_STATUS) return 'Weights Resident · API Offline';
  if (status === 'running') return 'Ready to Use';
  if (status === 'loading' || status === 'starting') return 'Loading';
  if (status === 'stopped') return 'Stopped';
  return String(status || 'Unknown');
}

export function resolveModelDisplayStatus(controlStatus, ...observedStatuses) {
  if (isActiveControlStatus(controlStatus)) return controlStatus;
  return observedStatuses.find(status => String(status || '').trim()) || controlStatus || 'stopped';
}

export function classifyManagedStatus(profileStatus, components = []) {
  const activeComponents = components.filter(component => component.active).map(component => component.name);
  const inactiveComponents = components.filter(component => !component.active).map(component => component.name);
  const hasManagedComponents = components.length > 0;
  const hasActiveComponents = activeComponents.length > 0;
  const complete = hasManagedComponents && inactiveComponents.length === 0;

  if (!hasManagedComponents) {
    return {
      status: profileStatus,
      running: profileStatus === 'running',
      active: isActiveControlStatus(profileStatus),
      degraded: false,
      active_components: [],
      inactive_components: []
    };
  }

  if (complete && profileStatus === 'running') {
    return {
      status: 'running',
      running: true,
      active: true,
      degraded: false,
      active_components: activeComponents,
      inactive_components: inactiveComponents
    };
  }

  if (complete) {
    return {
      status: 'loading',
      running: false,
      active: true,
      degraded: false,
      active_components: activeComponents,
      inactive_components: []
    };
  }

  if (hasActiveComponents) {
    return {
      status: DEGRADED_RESIDENT_STATUS,
      running: false,
      active: true,
      degraded: true,
      active_components: activeComponents,
      inactive_components: inactiveComponents
    };
  }

  return {
    status: profileStatus,
    running: false,
    active: false,
    degraded: false,
    active_components: [],
    inactive_components: inactiveComponents
  };
}
