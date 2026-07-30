const BUSY_RESULT = Object.freeze({
  ok: false,
  code: 'busy',
  message: 'Another model control action is already in progress'
});

export function createModelControlActionLock() {
  let busy = false;
  return {
    async run(action) {
      if (busy) return { ...BUSY_RESULT };
      busy = true;
      try {
        return await action();
      } finally {
        busy = false;
      }
    }
  };
}
