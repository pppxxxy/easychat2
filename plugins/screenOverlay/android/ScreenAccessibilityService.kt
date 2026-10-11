package com.pppxxxy.easychat2.screenoverlay

import android.accessibilityservice.AccessibilityService
import android.content.Intent
import android.util.Log
import android.view.accessibility.AccessibilityEvent

/**
 * 看屏幕的**无障碍服务骨架**（保守实现，不接管任何采集）。
 *
 * 为什么存在：跨应用截屏目前只走 MediaProjection（OverlayService），而它是
 * **逐会话授权**——每次开启悬浮窗都要用户重新确认系统录屏弹窗。用户反馈
 * 「在 App 外截屏一直失败」，授权链路本身就是最可疑的一环。无障碍服务在用户
 * 手动开启后由系统常驻绑定，不需要每次重新授权，是更省事的备选路径。
 *
 * ⚠️ 本类**只做「已开启」状态上报**，不做截屏。原因：
 *   1. 沙箱与 CI 都没有 Android SDK / Java，原生代码**无法本地编译或测试**，
 *      写错的代价只能在 GitHub Actions 打包时才暴露；
 *   2. `AccessibilityService.takeScreenshot()`（无障碍截屏 API）的可用 API level、
 *      回调形态与权限前置条件**未能在本地核实**，不能凭记忆写成既成事实。
 *      因此这里不声明、不调用它——等真机验证通过后再单独一批接入。
 *
 * 接入方式：声明式。清单里的 `<service android:permission=
 * "android.permission.BIND_ACCESSIBILITY_SERVICE">` + res/xml 的
 * accessibility_service_config.xml 就是全部接线（见 plugins/withScreenOverlay.js）。
 * 系统据此把本服务列进「设置 → 无障碍」，用户开启后系统自动绑定并调用
 * onServiceConnected；**没有任何运行时权限需要申请**。
 */
class ScreenAccessibilityService : AccessibilityService() {

    companion object {
        private const val TAG = "ScreenOverlay"

        /** 系统是否已绑定本服务（进程内可见性；跨进程判断见 isEnabledInSettings）。 */
        @Volatile var isConnected: Boolean = false
            private set
    }

    override fun onServiceConnected() {
        super.onServiceConnected()
        isConnected = true
        Log.i(TAG, "accessibility service connected")
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        // 有意留空：本骨架不消费任何无障碍事件。
        // 只读屏幕画面/文字需要另外的 API（未核实），当前不接线。
        // 必须实现该抽象方法，否则类无法编译；空实现不产生任何行为。
    }

    override fun onInterrupt() {
        // 系统要求的中断回调（例如用户主动关闭服务）。无状态可清理，留空。
    }

    override fun onUnbind(intent: Intent?): Boolean {
        isConnected = false
        Log.i(TAG, "accessibility service unbound")
        return super.onUnbind(intent)
    }

    override fun onDestroy() {
        isConnected = false
        super.onDestroy()
    }
}
