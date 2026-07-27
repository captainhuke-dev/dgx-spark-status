function compactK(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? `${Math.round(numeric / 1024)}K` : '';
}

export function modelBudgetLabel(model = {}) {
  const context = compactK(model.ctx);
  const input = compactK(model.maxInputTokens);
  const output = compactK(model.maxOutputTokens);
  if (context && input && output) return `ctx${context} · ${input}/${output}`;
  return context ? `ctx: ${context}` : '';
}
