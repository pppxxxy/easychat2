package com.pppxxxy.easychat2.screenoverlay

import android.app.Activity
import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.os.Bundle
import android.util.Log

/**
 * 专职承接投屏（MediaProjection）授权的**透明空 Activity**。
 *
 * 为什么必须独立成一个 Activity（新设计 3.5）：
 * 旧实现用 `reactContext.currentActivity.startActivityForResult(...)`——授权流程**绑死在
 * RN 主 Activity** 上。于是两个场景直接失效：
 *   1) app 不在前台时（悬浮窗的主场景）`currentActivity` 为 null 或不可用，弹窗根本起不来；
 *   2) 悬浮窗需要「截屏凭据失效 → 重新授权」时，被强行把 RN 主 Activity 拉到前台——
 *      那正是 M1 要消灭的 ANR 路径（主线程被 Activity 启动 + RN 恢复堵住）。
 * 本 Activity 是**透明的、独立 taskAffinity 的**空壳：只负责弹系统授权框、收结果、
 * 交给进程级入口，然后立刻 finish()。它不渲染任何界面，也不把主 Activity 带起来。
 *
 * 交付去向见 [ScreenOverlayModule.onCapturePermissionResult]：那里同时唤醒
 * 「等 Promise 的 JS 调用方」与「常驻的 OverlayService」，**不依赖 RN 实例存活**。
 *
 * ⚠️ 未在本地核实：沙箱无 Android SDK / Java，本文件无法编译或运行验证（仓库既有约束）。
 * 真实行为（透明主题呈现、taskAffinity 隔离、后台起 Activity 的系统限制）需真机验证。
 */
class OverlayPermissionActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // 重建（配置变更等）：**不要**再弹一次授权框。上一次的 startActivityForResult
        // 仍然挂着，系统会把结果投递给重建后的实例，重复发起反而会叠出两个系统弹窗。
        if (savedInstanceState != null) return

        val manager = try {
            getSystemService(MediaProjectionManager::class.java)
        } catch (error: Exception) {
            Log.w(TAG, "MediaProjectionManager unavailable: ${error.message}")
            null
        }
        if (manager == null) {
            deliver(Activity.RESULT_CANCELED, null, "no-manager")
            return
        }
        try {
            @Suppress("DEPRECATION")
            startActivityForResult(manager.createScreenCaptureIntent(), REQUEST_CAPTURE)
        } catch (error: Exception) {
            // 弹窗没能起来（部分 ROM 在后台禁止起这个系统界面）：如实回报失败，
            // 不让调用方永远等下去。
            Log.w(TAG, "createScreenCaptureIntent failed: ${error.message}")
            deliver(Activity.RESULT_CANCELED, null, "intent-failed")
        }
    }

    @Suppress("DEPRECATION")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQUEST_CAPTURE) return
        deliver(resultCode, data, null)
    }

    /**
     * 把结果交给进程级入口并收尾。
     *
     * 全程 try-catch：授权 Activity 抛异常会把用户当前的整个会话带走（本服务是常驻的），
     * 而它只是个空壳，没有任何值得为之崩溃的东西。
     */
    private fun deliver(resultCode: Int, data: Intent?, failure: String?) {
        if (failure != null) Log.w(TAG, "capture permission failed: $failure")
        try {
            ScreenOverlayModule.onCapturePermissionResult(resultCode, data, failure)
        } catch (error: Exception) {
            Log.w(TAG, "deliver capture result failed: ${error.message}")
        }
        try {
            finish()
        } catch (error: Exception) {}
    }

    companion object {
        private const val TAG = "OverlayPermission"
        // 与 ScreenOverlayModule 的 REQUEST_CAPTURE_PERMISSION 是两个独立的值域
        //（一个走系统 Activity 结果，一个曾被 ActivityEventListener 用），不复用避免混淆。
        private const val REQUEST_CAPTURE = 0x5C11
    }
}
