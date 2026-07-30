import { isActiveControlStatus } from './model-control-state.js';

const LEGACY_DS4_PROFILE_ID = 'ds4-deepseek-v4-flash-256k-8889';

function failure(profileId, result, fallbackMessage) {
  return {
    profile_id: profileId,
    code: result?.code || 'stop_failed',
    message: result?.message || fallbackMessage
  };
}

export async function stopAllManagedModels(profiles = [], dependencies = {}) {
  const stopped = [];
  const alreadyStopped = [];
  const failures = [];

  for (const profile of profiles) {
    const profileId = String(profile?.profile_id || '');
    if (!profileId) continue;
    if (!(profile.active || isActiveControlStatus(profile.status))) {
      alreadyStopped.push(profileId);
      continue;
    }

    try {
      const result = await dependencies.stopProfile(profileId);
      if (!result?.ok) {
        failures.push(failure(profileId, result, 'Model stop failed'));
        continue;
      }
      if (dependencies.statusProfile) {
        const after = await dependencies.statusProfile(profileId);
        if (!after?.ok) {
          failures.push(failure(profileId, after, 'Unable to verify model stop'));
          continue;
        }
        if (after.active || isActiveControlStatus(after.status)) {
          failures.push({
            profile_id: profileId,
            code: 'stop_incomplete',
            message: 'Model remains active after stop'
          });
          continue;
        }
      }
      stopped.push(profileId);
    } catch (error) {
      failures.push(failure(profileId, error, error?.message || 'Model stop failed'));
    }
  }

  try {
    const legacyStatus = await dependencies.getLegacyDs4Status();
    if (legacyStatus?.running || legacyStatus?.port_listening) {
      const result = await dependencies.stopLegacyDs4();
      if (!result?.ok) {
        failures.push(failure(LEGACY_DS4_PROFILE_ID, result, 'Legacy DS4 stop failed'));
      } else {
        const after = await dependencies.getLegacyDs4Status();
        if (after?.running || after?.port_listening) {
          failures.push({
            profile_id: LEGACY_DS4_PROFILE_ID,
            code: 'stop_incomplete',
            message: 'Legacy DS4 remains active after stop'
          });
        } else {
          stopped.push(LEGACY_DS4_PROFILE_ID);
        }
      }
    }
  } catch (error) {
    failures.push(failure(LEGACY_DS4_PROFILE_ID, error, error?.message || 'Legacy DS4 stop failed'));
  }

  return {
    ok: failures.length === 0,
    action: 'stop_all',
    stopped,
    already_stopped: alreadyStopped,
    failures
  };
}
