const GIB = 1024 ** 3;

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function processRssBytes(processes = []) {
  return processes.reduce((sum, process) => sum + (finiteNumber(process.memoryGB) * GIB), 0);
}

function gpuMemoryBytes(gpus = []) {
  return gpus.reduce((sum, gpu) => {
    const total = finiteNumber(gpu.memoryTotal, NaN);
    const used = finiteNumber(gpu.memoryUsed, NaN);
    if (Number.isFinite(total) && Number.isFinite(used) && total > 0) {
      return sum + used * 1024 ** 2;
    }
    const unifiedUsed = finiteNumber(gpu.computeMemoryUsedMB, NaN);
    return Number.isFinite(unifiedUsed) ? sum + unifiedUsed * 1024 ** 2 : sum;
  }, 0);
}

export function buildMemoryDisplay(memory = {}, processes = [], gpus = []) {
  const totalBytes = finiteNumber(memory.total);
  const freeBytes = finiteNumber(memory.free);
  const availableBytes = finiteNumber(memory.available);
  const legacyUsedBytes = finiteNumber(memory.used, Math.max(0, totalBytes - freeBytes));
  const usedBytes = Number.isFinite(availableBytes) && availableBytes > 0
    ? Math.max(0, Math.min(totalBytes, totalBytes - availableBytes))
    : legacyUsedBytes;
  const cacheBytes = Math.max(0, totalBytes - usedBytes - freeBytes);
  const processRssGB = processRssBytes(processes) / GIB;
  const gpuMemoryGB = gpuMemoryBytes(gpus) / GIB;
  const totalGB = totalBytes / GIB;
  const usedGB = usedBytes / GIB;
  const freeGB = freeBytes / GIB;
  const availableGB = availableBytes / GIB;
  const cacheGB = cacheBytes / GIB;
  const stackedGpuGB = Math.min(usedGB, gpuMemoryGB);
  const otherUsedGB = Math.max(0, usedGB - stackedGpuGB);

  return {
    totalGB,
    usedGB,
    freeGB,
    availableGB,
    cacheGB,
    processRssGB,
    gpuMemoryGB,
    otherUsedGB,
    usedPercent: totalGB > 0 ? (usedGB / totalGB) * 100 : 0,
    processPercent: totalGB > 0 ? (processRssGB / totalGB) * 100 : 0,
    gpuPercent: totalGB > 0 ? (stackedGpuGB / totalGB) * 100 : 0,
    otherPercent: totalGB > 0 ? (otherUsedGB / totalGB) * 100 : 0,
    cachePercent: totalGB > 0 ? (cacheGB / totalGB) * 100 : 0,
    freePercent: totalGB > 0 ? (freeGB / totalGB) * 100 : 0
  };
}
