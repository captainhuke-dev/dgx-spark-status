function hasLiveApiModelId(candidate) {
  return Boolean(String(candidate?.liveApiModelId || '').trim());
}

export function selectPreferredLlamaRuntime({
  configuredCandidates = [],
  liveProcessCandidates = []
} = {}) {
  const liveProcess = liveProcessCandidates.find(candidate => candidate?.healthy && hasLiveApiModelId(candidate));
  if (liveProcess) return liveProcess;

  const configured = configuredCandidates.find(candidate => candidate?.healthy && hasLiveApiModelId(candidate));
  if (configured) return configured;

  return configuredCandidates[0] || liveProcessCandidates[0] || null;
}
