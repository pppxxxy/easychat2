// 原生重负载资源互斥：录音、TTS、本地推理等同一时间只允许一个持有者。

let owner = '';

export function getResourceOwner() {
  return owner;
}

export function tryAcquireResource(name) {
  const requested = String(name || '').trim();
  if (!requested || owner) return null;
  owner = requested;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (owner === requested) owner = '';
  };
}

export async function withResource(name, operation) {
  const release = tryAcquireResource(name);
  if (!release) {
    const error = new Error(`资源忙：${owner || 'unknown'}`);
    error.code = 'RESOURCE_BUSY';
    throw error;
  }
  try {
    return await operation();
  } finally {
    release();
  }
}

export function resetResourceMutexForTests() {
  owner = '';
}
