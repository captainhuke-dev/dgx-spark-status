function hasLiveApiModelId(candidate) {
  return Boolean(String(candidate?.liveApiModelId || '').trim());
}

function isStudioCandidate(candidate) {
  return candidate?.isUnslothStudio === true || candidate?.process?.isUnslothStudio === true;
}

function distinctCandidateModelIds(candidate) {
  const values = Array.isArray(candidate?.liveApiModelIds)
    ? candidate.liveApiModelIds
    : [candidate?.liveApiModelId];
  return [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))];
}

function selectOnlyEligibleStudioCandidate(candidates) {
  const eligible = candidates.filter(candidate =>
    candidate?.healthy &&
    distinctCandidateModelIds(candidate).length === 1
  );
  const distinctIds = new Set(eligible.flatMap(distinctCandidateModelIds));
  return eligible.length === 1 && distinctIds.size === 1 ? eligible[0] : null;
}

export function selectLiveModelFromProbe(
  payload,
  { requireSingleDistinctId = false } = {},
) {
  const models = Array.isArray(payload?.data) ? payload.data : [];
  if (!requireSingleDistinctId) return models[0] || null;

  const distinctIds = [...new Set(models
    .filter(model => model && typeof model === 'object')
    .map(model => String(model.id || '').trim())
    .filter(Boolean))];
  if (distinctIds.length !== 1) return null;
  const selected = models.find(model => String(model?.id || '').trim() === distinctIds[0]);
  return selected ? { ...selected, id: distinctIds[0] } : null;
}

export function selectPreferredLlamaRuntime({
  configuredCandidates = [],
  liveProcessCandidates = []
} = {}) {
  const studioLiveCandidates = liveProcessCandidates.filter(isStudioCandidate);
  if (studioLiveCandidates.length) {
    const studioLive = selectOnlyEligibleStudioCandidate(studioLiveCandidates);
    if (studioLive) return studioLive;
  }

  const liveProcess = liveProcessCandidates.find(candidate =>
    !isStudioCandidate(candidate) && candidate?.healthy && hasLiveApiModelId(candidate));
  if (liveProcess) return liveProcess;

  const studioConfiguredCandidates = configuredCandidates.filter(isStudioCandidate);
  if (!studioLiveCandidates.length && studioConfiguredCandidates.length) {
    const studioConfigured = selectOnlyEligibleStudioCandidate(studioConfiguredCandidates);
    if (studioConfigured) return studioConfigured;
  }

  const configured = configuredCandidates.find(candidate =>
    !isStudioCandidate(candidate) && candidate?.healthy && hasLiveApiModelId(candidate));
  if (configured) return configured;

  return configuredCandidates.find(candidate => !isStudioCandidate(candidate)) ||
    liveProcessCandidates.find(candidate => !isStudioCandidate(candidate)) ||
    null;
}
