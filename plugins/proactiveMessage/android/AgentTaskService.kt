package com.pppxxxy.easychat2.proactive

import android.app.Notification
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import com.pppxxxy.easychat2.R

// 定时 Agent 任务的原生唤醒入口。
//
// 与主动消息（原生直接调模型）不同，Agent 任务必须回到 JS 跑工具循环，因此这里用
// HeadlessJsTaskService 启动无界面 JS：RN 0.81 的 HeadlessJsTaskService 已支持新架构
// （bridgeless）——reactContext 走 ReactApplication.reactHost.currentReactContext，
// 见 node_modules/react-native 的 HeadlessJsTaskService.kt。
//
// 用前台服务承载：Agent 循环可能跑数分钟（多轮工具调用 + 网络），普通后台服务会被
// 系统很快回收。startForeground 复用主动消息的低重要性「生成中」渠道，无横幅打扰。

object AgentTaskTrigger {

    const val TAG = "AgentTaskTrigger"

    fun start(context: Context, slotId: String, revision: String) {
        val intent = Intent(context, AgentTaskForegroundService::class.java).apply {
            putExtra(AgentTaskForegroundService.EXTRA_SLOT_ID, slotId)
            putExtra(AgentTaskForegroundService.EXTRA_REVISION, revision)
        }
        try {
            // Android 12+ 从后台启动前台服务可能被拒（ForegroundServiceStartNotAllowedException）。
            // 捕获后不崩溃：JS 侧的 App 内调度器会在下次打开应用时补跑当天任务。
            ContextCompat.startForegroundService(context, intent)
            Log.i(TAG, "启动 Agent 任务前台服务: slot=$slotId")
        } catch (e: Exception) {
            Log.e(TAG, "启动 Agent 任务前台服务失败（后台限制），等待应用打开补跑: slot=$slotId", e)
        }
    }
}

/** 承载无界面 JS 的前台服务：Agent 任务在此执行。 */
class AgentTaskForegroundService : HeadlessJsTaskService() {

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // 系统要求启动后极短时间内 startForeground，否则报 ANR/崩溃；先做再交给 Headless 逻辑。
        try {
            Notifier.ensureServiceChannel(this)
            startForeground(FOREGROUND_NOTIFICATION_ID, buildServiceNotification())
        } catch (e: Exception) {
            Log.e(TAG, "startForeground 失败", e)
        }
        return super.onStartCommand(intent, flags, startId)
    }

    override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig? {
        val slotId = intent?.getStringExtra(EXTRA_SLOT_ID)
        if (slotId.isNullOrBlank()) return null
        val revision = intent.getStringExtra(EXTRA_REVISION) ?: ""
        val data = Arguments.createMap().apply {
            putString("slotId", slotId)
            putString("revision", revision)
        }
        // isAllowedInForeground=true：闹钟可能在 App 正在前台时触发，若为 false 则
        // HeadlessJsTaskContext.startTask 会 check 抛异常导致服务崩溃。设为 true 后前台
        // 也可运行；此时 App 内调度器与 headless 可能同时命中，靠 JS 侧「认领当日」去重
        // （taskRunner 先 markAgentTaskRun 再执行），不会重复生成。
        return HeadlessJsTaskConfig(TASK_KEY, data, TASK_TIMEOUT_MS, true)
    }

    private fun buildServiceNotification(): Notification {
        return NotificationCompat.Builder(this, Notifier.SERVICE_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_proactive)
            .setContentTitle("正在执行定时任务")
            .setContentText("角色正在后台完成任务…")
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    companion object {
        const val TAG = "AgentTaskService"
        // 必须与 JS 侧 registerAgentTaskHeadless 的 taskKey 一致（src/agent/task/headless.js）。
        const val TASK_KEY = "AgentTaskHeadless"
        const val EXTRA_SLOT_ID = "slot_id"
        const val EXTRA_REVISION = "revision"
        // 与主动消息前台服务错开，避免通知栏互相覆盖。
        const val FOREGROUND_NOTIFICATION_ID = 9002
        // 5 分钟上限：Agent 循环含多轮工具调用，超时兜底释放 React 实例。
        const val TASK_TIMEOUT_MS = 300000L
    }
}
