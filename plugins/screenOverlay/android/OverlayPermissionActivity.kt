package com.pppxxxy.easychat2.screenoverlay

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.media.projection.MediaProjectionManager
import android.os.Bundle
import android.util.Log
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

/**
 * 专职承接「悬浮窗需要的运行时授权」的**透明空 Activity**。
 *
 * 两类授权（M1.3 投屏 + M3 麦克风）共用同一个 Activity，而不是各来一个：
 * 它们都是「弹系统框 → 收结果 → 交给进程级入口 → 立刻 finish」的同一种活，
 * 分成两个 Activity 只会多一套清单声明与授权状态机。
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
 * ⚠️ 未在本地核实：沙箱无 Android SDK / Java，本文件无法编译或运行验证（仓库既有约束）。
 * 真实行为（透明主题呈现、taskAffinity 隔离、后台起 Activity 的系统限制、
 * Android 14 的麦克风前台服务限制）需真机验证。
 */
class OverlayPermissionActivity : Activity() {

    /**
     * FEAT-AC10 P0-1：本轮是否**已经交付过结果**（一次性标志）。
     *
     * 为什么必须有它：本 Activity 此前只有 onActivityResult 一个出口。用户真机
     * 14:57 的现象是「投屏授权框闪现即逝 → 永久加载」，日志里连 permission-denied
     * 都没有 ⇒ deliver 从未运行 ⇒ 等待者永远悬挂（native 队列 in-flight 永真）。
     * 现在 onDestroy 会兜底结算，而正常路径（onActivityResult → deliver → finish）
     * 也会走到 onDestroy —— 这个标志保证**只结算一次**，不会重复投递。
     */
    private var delivered = false

    /** 本轮授权尝试的序号（从 Module 的 Intent extra 取，见 EXTRA_CAPTURE_EPOCH）。 */
    private var permissionEpoch = 0L

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // M1.3 + FEAT-AC10：记下本轮尝试序号。**从 Intent 取而不是从实例状态取**：
        // 配置变更后系统会用**同一个 Intent** 重建实例，extra 仍在；而看门狗若已把本轮
        // 判死并发起了新一轮，序号比对能防止「迟到的旧结果」结算掉新一批等待者。
        permissionEpoch = intent.getLongExtra(ScreenOverlayModule.EXTRA_CAPTURE_EPOCH, 0L)

        // 重建（配置变更等）：**不要**再弹一次授权框。上一次的 startActivityForResult
        // 仍然挂着，系统会把结果投递给重建后的实例，重复发起反而会叠出两个系统弹窗。
        if (savedInstanceState != null) return

        // M3：先要麦克风（运行时权限，必须由 Activity 申请），拿到后再弹投屏授权。
        // 顺序刻意如此——投屏授权是「一次性凭据」，用户点了确定就立刻生效；
        // 若先投屏再麦克风，用户在麦克风那步拒绝会留下一个已授权但录不了音的中间态。
        if (!hasRecordAudioPermission()) {
            requestRecordAudioPermission()
            return
        }
        startCapturePermissionFlow()
    }

    /**
     * FEAT-AC10 P0-1：**Activity 死亡兜底**（本轮主修）。
     *
     * 无出口的死亡路径（真机「授权框闪现即逝」就是其中一种）：
     *   · onCreate 在 savedInstanceState != null 时静默 return 等「系统重投结果」，
     *     而部分 ROM 杀掉 Activity 后根本不重投；
     *   · 透明 Activity 被系统/ROM 直接回收，未经 onActivityResult。
     * 两条都会让 deliver 永不执行 ⇒ 进程级等待者悬挂、capturePermissionInFlight 永真
     * ⇒ 之后所有 startOverlay 都在排队等一个已死的弹窗（用户只能杀进程恢复）。
     *
     * 为什么这里**一个兜底覆盖麦克风 + 投屏两环节**：两个环节共用本 Activity、共用
     * 「先 deliver 后 finish」这一个出口，任何环节中死亡时 delivered 都还是 false。
     *
     * ⚠️ 配置变更必须排除：那种销毁后系统会把结果重投给新实例，此刻结算会把
     * 正常流程误判成失败（isChangingConfigurations）。
     */
    override fun onDestroy() {
        super.onDestroy()
        if (delivered || isChangingConfigurations) return
        try {
            ScreenOverlayModule.onPermissionActivityDestroyed(permissionEpoch)
        } catch (error: Exception) {
            // 兜底本身抛错绝不能把进程带走（本 Activity 只是空壳，且此刻正在销毁）。
            Log.w(TAG, "settle on destroy failed: ${error.message}")
        }
    }

    private fun hasRecordAudioPermission(): Boolean =
        ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED

    private fun requestRecordAudioPermission() {
        try {
            ActivityCompat.requestPermissions(
                this, arrayOf(Manifest.permission.RECORD_AUDIO), REQUEST_RECORD_AUDIO
            )
        } catch (error: Exception) {
            // 申请本身失败（极罕见）：不卡住投屏授权——录音不可用不该连带截屏不可用。
            Log.w(TAG, "request RECORD_AUDIO failed: ${error.message}")
            startCapturePermissionFlow()
        }
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQUEST_RECORD_AUDIO) return
        // 无论用户允许还是拒绝都继续投屏授权：两个能力互不依赖。
        // 拒绝录音时「说话」按钮会走「语音识别不可用，请用文字输入」的如实提示（设计 3.3）。
        ScreenOverlayModule.onRecordAudioPermissionResult(hasRecordAudioPermission())
        startCapturePermissionFlow()
    }

    /** 弹系统投屏授权框（M1.3 的原有职责）。 */
    private fun startCapturePermissionFlow() {
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
        // FEAT-AC10 P0-1：先置一次性标志（onDestroy 据此不再重复结算）。
        delivered = true
        if (failure != null) Log.w(TAG, "capture permission failed: $failure")
        try {
            ScreenOverlayModule.onCapturePermissionResult(resultCode, data, failure, permissionEpoch)
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
        private const val REQUEST_RECORD_AUDIO = 0x5C12
    }
}
