function normalizeControlKey(value) {
  return String(value || '')
    .split('/')
    .filter(Boolean)
    .pop()
    ?.replace(/\.(gguf|safetensors|bin|pt|pth|env)$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '') || '';
}

function uniqueKeys(values) {
  return [...new Set(values.map(normalizeControlKey).filter(Boolean))];
}

function modelIdentityKeys(model = {}, runtimeModel = {}) {
  return uniqueKeys([
    model.name,
    model.key,
    model.displayName,
    model.modelName,
    model.modelPath,
    model.path,
    model.config,
    model.profileId,
    runtimeModel.name,
    runtimeModel.key,
    runtimeModel.displayName,
    runtimeModel.modelName,
    runtimeModel.modelPath,
    runtimeModel.path,
    runtimeModel.config,
    runtimeModel.profileId
  ]);
}

function profileIdentityKeys(profile = {}) {
  return uniqueKeys([
    profile.profile_id,
    profile.display_name,
    profile.model_name,
    profile.model_path,
    profile.config_file
  ]);
}

function modelAliasKeys(model = {}, runtimeModel = {}) {
  return uniqueKeys([
    model.apiModel,
    model.servedModelName,
    model.modelAlias,
    runtimeModel.apiModel,
    runtimeModel.servedModelName,
    runtimeModel.modelAlias
  ]);
}

function profileAliasKeys(profile = {}) {
  return uniqueKeys([
    profile.api_model_id,
    profile.served_model_name,
    profile.model_alias
  ]);
}

function hasIntersection(left, right) {
  return left.some(value => right.includes(value));
}

function preferredMatch(profiles, predicate) {
  const enabled = profiles.filter(profile => profile.control_enabled);
  return enabled.find(predicate) || profiles.find(predicate) || null;
}

export function findModelControlProfile(model = {}, runtimeModel = {}, displayPort, profiles = []) {
  const controls = Array.isArray(profiles) ? profiles : [];
  if (!controls.length) return null;

  const port = Number(displayPort || runtimeModel.port || model.port || 0);
  if (Number.isFinite(port) && port > 0) {
    const byPort = preferredMatch(controls, profile => Number(profile.port) === port);
    if (byPort) return byPort;
  }

  // Names, paths, and config files identify a card. Match these before the
  // OpenAI alias, because several isolated profiles may serve the same alias.
  const modelKeys = modelIdentityKeys(model, runtimeModel);
  const byIdentity = preferredMatch(controls, profile =>
    hasIntersection(modelKeys, profileIdentityKeys(profile))
  );
  if (byIdentity) return byIdentity;

  // Only use a shared API alias when it resolves to one profile. Returning no
  // match is safer than marking the wrong stopped profile as active.
  const aliases = modelAliasKeys(model, runtimeModel);
  if (!aliases.length) return null;
  const aliasMatches = controls.filter(profile =>
    hasIntersection(aliases, profileAliasKeys(profile))
  );
  if (aliasMatches.length === 1) return aliasMatches[0];

  const enabledAliasMatches = aliasMatches.filter(profile => profile.control_enabled);
  return enabledAliasMatches.length === 1 ? enabledAliasMatches[0] : null;
}
