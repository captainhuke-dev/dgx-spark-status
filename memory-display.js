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
    return Number.isFinite(total) && Number.isFinite(used) && total > 0
      ? sum + used * 1024 ** 2
      : sum;
  }, 0);
}

export function buildMemoryDisplay(memory = {}, processes = [], gpus = []) {
  const totalBytes = finiteNumber(memory.total);
  const freeBytes = finiteNumber(memory.free);
  const availableBytes = finiteNumber(memory.available);
  const usedBytes = finiteNumber(memory.used, Math.max(0, totalBytes - freeBytes));
  const processRssGB = processRssBytes(processes) / GIB;
  const gpuMemoryGB = gpuMemoryBytes(gpus) / GIB;
  const totalGB = totalBytes / GIB;
  const usedGB = usedBytes / GIB;
  const freeGB = freeBytes / GIB;
  const availableGB = availableBytes / GIB;
  const otherUsedGB = Math.max(0, usedGB - processRssGB - gpuMemoryGB);

  return {
    totalGB,
    usedGB,
    freeGB,
    availableGB,
    processRssGB,
    gpuMemoryGB,
    otherUsedGB,
    usedPercent: totalGB > 0 ? (usedGB / totalGB) * 100 : 0,
    processPercent: totalGB > 0 ? (processRssGB / totalGB) * 100 : 0,
    gpuPercent: totalGB > 0 ? (gpuMemoryGB / totalGB) * 100 : 0,
    otherPercent: totalGB > 0 ? (otherUsedGB / totalGB) * 100 : 0
  };
}
