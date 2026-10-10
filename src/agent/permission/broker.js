// 权限 broker（Z 系采纳 #3，对照 zai-org/ZCode 的 PermissionBrokerPort）。
//
// 为什么要有它：现在「谁来问用户」和「一次审批的生命周期」是绑死的——审批直接
// Alert.alert 包一个 Promise（见 chat/toolApproval.js）。这带来两个问题：
// 1. 后台运行（L 系：角色在后台跑工具循环）根本没有前台弹框可弹，审批无处可去；
// 2. 生命周期（去重、中止、超时、只结算一次）散在弹框实现里，换一个「问法」就要重写。
//
// broker 把两者拆开：
// - **请求生命周期**归 broker：pending 表、按 requestId 去重、中止/超时结算、
//   只结算一次、支持带外结算（通知栏/面板点了按钮 → resolvePermission）；
// - **谁来答**由 handler 决定：前台是 Alert 弹框，后台可以换成自动拒绝 / 通知 / 面板。
//   没有 handler = 问不到人 = **默认拒绝**（与 registry「无 confirm 即拒绝」同源）。
//
// 纯模块：零 import、零原生依赖，Node 可直测。

export const PERMISSION_DENY = 'deny';

function makeResult(decision, reason) {
  return {
    decision: String(decision || PERMISSION_DENY),
    reason: String(reason || ''),
    resolvedAt: Date.now(),
  };
}

export function createPermissionBroker() {
  // requestId → { request, resolve, reject }
  const pending = new Map();
  // 已注册的应答方（可被每次请求的 options.handler 覆盖）。
  let handler = null;

  const broker = {
    setHandler(fn) {
      handler = typeof fn === 'function' ? fn : null;
      return broker;
    },
    getHandler() {
      return handler;
    },
    getPendingRequest(requestId) {
      const record = pending.get(String(requestId || ''));
      return record ? record.request : undefined;
    },
    listPendingRequests() {
      return Array.from(pending.values(), record => record.request);
    },
    // 带外结算：通知栏/面板替用户点了按钮时调用（不必持有 request 对象）。
    resolvePermission(requestId, decision) {
      const record = pending.get(String(requestId || ''));
      if (!record) return false;
      const result = decision && typeof decision === 'object'
        ? decision
        : makeResult(decision);
      record.resolve(result);
      return true;
    },
    rejectPermission(requestId, error) {
      const record = pending.get(String(requestId || ''));
      if (!record) return false;
      record.reject(error instanceof Error ? error : new Error(String(error || 'permission rejected')));
      return true;
    },

    // 发起一次审批。返回 Promise<{decision, reason, resolvedAt}>。
    // options.handler 覆盖已注册的应答方；两者都没有 → 立即拒绝（问不到人）。
    requestPermission(request, options = {}) {
      const req = request && typeof request === 'object' ? request : {};
      const key = String(req.requestId || '');
      if (!key) return Promise.reject(new Error('permission request missing requestId'));
      // 同一 requestId 已在等：拒绝新请求，避免两条 Promise 挂在同一个 key 上互相覆盖。
      if (pending.has(key)) {
        return Promise.reject(new Error(`permission request already pending: ${key}`));
      }
      const activeHandler = typeof options.handler === 'function' ? options.handler : handler;
      if (!activeHandler) return Promise.resolve(makeResult(PERMISSION_DENY, 'no permission client'));

      const signal = options.signal || null;
      if (signal && signal.aborted) return Promise.resolve(makeResult(PERMISSION_DENY, 'aborted'));

      return new Promise((resolve, reject) => {
        let settled = false;
        let timeout = null;
        let onAbort = null;

        const cleanup = () => {
          if (timeout) { clearTimeout(timeout); timeout = null; }
          if (signal && onAbort && typeof signal.removeEventListener === 'function') {
            signal.removeEventListener('abort', onAbort);
          }
          pending.delete(key);
        };
        const settle = result => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve({ ...result, resolvedAt: result.resolvedAt ?? Date.now() });
        };
        const fail = error => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error instanceof Error ? error : new Error(String(error || 'permission failed')));
        };

        if (signal && typeof signal.addEventListener === 'function') {
          // 中止（用户点「停止生成」）→ 按拒绝结算：绝不执行，且不留悬挂 Promise。
          onAbort = () => settle(makeResult(PERMISSION_DENY, 'aborted'));
          signal.addEventListener('abort', onAbort);
        }
        if (Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) {
          timeout = setTimeout(() => settle(makeResult(PERMISSION_DENY, 'timeout')), options.timeoutMs);
        }

        pending.set(key, { request: req, resolve: settle, reject: fail });

        // 应答方可以是「返回决定」或「带外结算」两种：前者在这里结算，后者由
        // resolvePermission/rejectPermission 结算（先到先得，settle 保证只生效一次）。
        Promise.resolve(activeHandler(req)).then(
          decision => {
            if (decision === undefined || decision === null) return; // 交给带外结算
            settle(typeof decision === 'string' ? makeResult(decision) : decision);
          },
          fail
        );
      });
    },

    reset() {
      pending.clear();
      handler = null;
    },
  };

  return broker;
}

// 应用级单例：前台发送路径与后台运行共享同一份 pending 表与应答方。
export const permissionBroker = createPermissionBroker();

export function resetPermissionBrokerForTests() {
  permissionBroker.reset();
}
