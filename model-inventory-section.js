const VALID_SECTIONS = new Set(['llama', 'vllm']);

function normalized(value) {
  return String(value || '').trim().toLowerCase();
}

export function classifyInventoryConfig(env = {}, classifiedRuntime, legacyDs4Candidate = false) {
  const requestedSection = normalized(env.DASHBOARD_SECTION);
  const hasOverride = VALID_SECTIONS.has(requestedSection);
  const defaultSection = classifiedRuntime === 'llama' ? 'llama' : 'vllm';

  if (legacyDs4Candidate && !hasOverride) {
    return { include: false, section: defaultSection, runtime: classifiedRuntime };
  }

  return {
    include: true,
    section: hasOverride ? requestedSection : defaultSection,
    runtime: hasOverride && normalized(env.RUNTIME) ? normalized(env.RUNTIME) : classifiedRuntime
  };
}
