package com.pppxxxy.easychat2.proactive

import android.app.AlarmManager
import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import java.util.concurrent.TimeUnit

// ---------------- WorkManager 方案（默认推荐） ----------------

class DailyMessageWorker(context: Context, params: WorkerParameters) :
    CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        val roleId = inputData.getString(KEY_ROLE_ID)
            ?: return Result.failure().also { Log.w("DailyWorker", "缺少 roleId") }
        val revision = inputData.getString(KEY_REVISION) ?: ""
        ProactiveMessageSender.send(applicationContext, roleId, revision)
        // 发送逻辑内部已做降级与去重，重试只会骚扰用户，统一返回 success
        return Result.success()
    }

    companion object {
        const val KEY_ROLE_ID = "role_id"
        const val KEY_REVISION = "revision"
        fun uniqueName(roleId: String) = "daily_message_$roleId"
    }
}

object DailyWorkScheduler {

    fun schedule(context: Context, schedule: RoleSchedule) {
        val now = System.currentTimeMillis()
        val initialDelayMs = (MessageClock.nextTarget(schedule) - now).coerceAtLeast(0)

        val constraints = Constraints.Builder()
            // 要求有网：AI 生成需要网络；系统推迟执行后由 Sender 的过期检查兜底
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build()

        val request = PeriodicWorkRequestBuilder<DailyMessageWorker>(1, TimeUnit.DAYS)
            .setConstraints(constraints)
            .setInitialDelay(initialDelayMs, TimeUnit.MILLISECONDS)
            .setInputData(
                workDataOf(
                    DailyMessageWorker.KEY_ROLE_ID to schedule.roleId,
                    DailyMessageWorker.KEY_REVISION to schedule.revision
                )
            )
            .build()

        WorkManager.getInstance(context).enqueueUniquePeriodicWork(
            DailyMessageWorker.uniqueName(schedule.roleId),
            ExistingPeriodicWorkPolicy.UPDATE,
            request
        )
    }

    fun cancel(context: Context, roleId: String) {
        WorkManager.getInstance(context).cancelUniqueWork(DailyWorkWorkerName(roleId))
    }

    private fun DailyWorkWorkerName(roleId: String) = DailyMessageWorker.uniqueName(roleId)

    fun rescheduleAll(context: Context) {
        MessageStore(context).loadSchedules()
            .filter { it.enabled && it.mode == ScheduleMode.WORK }
            .forEach { schedule(context, it) }
    }
}

// ---------------- AlarmManager 精确方案（用户明确开启才用） ----------------

object AlarmScheduler {

    fun canScheduleExactAlarms(context: Context): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            context.getSystemService(AlarmManager::class.java).canScheduleExactAlarms()
        } else true
    }

    fun schedule(context: Context, schedule: RoleSchedule) {
        if (!canScheduleExactAlarms(context)) {
            Log.w("AlarmScheduler", "无精确闹钟权限，降级为 WorkManager 模式")
            DailyWorkScheduler.schedule(context, schedule.copy(mode = ScheduleMode.WORK))
            return
        }
        context.getSystemService(AlarmManager::class.java)
            .setExactAndAllowWhileIdle(
                AlarmManager.RTC_WAKEUP,
                MessageClock.nextTarget(schedule),
                buildPendingIntent(context, schedule)
            )
        Log.i("AlarmScheduler", "已设置精确闹钟: ${schedule.roleId}")
    }

    fun cancel(context: Context, roleId: String) {
        context.getSystemService(AlarmManager::class.java)
            .cancel(buildPendingIntent(context, RoleSchedule(roleId, "", "", 0, 0, ScheduleMode.EXACT)))
    }

    private fun buildPendingIntent(context: Context, schedule: RoleSchedule): PendingIntent {
        val intent = Intent(context, AlarmReceiver::class.java).apply {
            action = AlarmReceiver.ACTION_FIRE
            putExtra(AlarmReceiver.EXTRA_ROLE_ID, schedule.roleId)
            putExtra(AlarmReceiver.EXTRA_REVISION, schedule.revision)
        }
        return PendingIntent.getBroadcast(
            context, schedule.roleId.hashCode(), intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }
}

/** 系统只给广播接收器约 10 秒：收到后立刻链式排明天，再转交前台服务执行 */
class AlarmReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_FIRE) return
        val roleId = intent.getStringExtra(EXTRA_ROLE_ID) ?: return
        val revision = intent.getStringExtra(EXTRA_REVISION) ?: ""

        MessageStore(context).findSchedule(roleId)?.let { schedule ->
            if (schedule.enabled) AlarmScheduler.schedule(context, schedule)
        }

        val serviceIntent = Intent(context, MessageForegroundService::class.java).apply {
            putExtra(MessageForegroundService.EXTRA_ROLE_ID, roleId)
            putExtra(MessageForegroundService.EXTRA_REVISION, revision)
        }
        ContextCompat.startForegroundService(context, serviceIntent)
    }

    companion object {
        const val ACTION_FIRE = "com.pppxxxy.easychat2.proactive.ALARM_FIRE"
        const val EXTRA_ROLE_ID = "role_id"
        const val EXTRA_REVISION = "revision"
    }
}

/** 执行 AI 请求和通知发送的前台服务；Android 14+ 以 dataSync 类型启动 */
class MessageForegroundService : Service() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int) {
        val roleId = intent?.getStringExtra(EXTRA_ROLE_ID)
        val revision = intent?.getStringExtra(EXTRA_REVISION) ?: ""

        // 必须立刻 startForeground；通知权限被拒也要调用（系统规则要求）
        Notifier.ensureChannel(this)
        startForeground(FOREGROUND_NOTIFICATION_ID, buildServiceNotification())

        if (roleId.isNullOrBlank()) {
            stopSelf()
            return
        }
        scope.launch {
            try {
                ProactiveMessageSender.send(applicationContext, roleId, revision)
            } catch (e: Exception) {
                Log.e("MessageFgService", "发送异常", e)
            } finally {
                stopSelf()
            }
        }
    }

    private fun buildServiceNotification(): Notification {
        return NotificationCompat.Builder(this, Notifier.CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle("正在准备消息")
            .setContentText("正在生成角色的主动消息…")
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    companion object {
        const val EXTRA_ROLE_ID = "role_id"
        const val EXTRA_REVISION = "revision"
        const val FOREGROUND_NOTIFICATION_ID = 9001
    }
}

/**
 * 重启/时区变更/应用更新/精确闹钟权限变化后重建调度。
 * Android 15 下 BOOT_COMPLETED 不能直接启动 dataSync 前台服务，这里只重建调度。
 */
class BootReceiver : BroadcastReceiver() {

    private val rebuildActions = setOf(
        Intent.ACTION_BOOT_COMPLETED,
        Intent.ACTION_TIME_SET,
        Intent.ACTION_TIMEZONE_CHANGED,
        Intent.ACTION_MY_PACKAGE_REPLACED,
        "android.app.action.SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED"
    )

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action !in rebuildActions) return
        Log.i("BootReceiver", "${intent.action}，重建定时任务")
        MessageStore(context).loadSchedules().filter { it.enabled }.forEach { schedule ->
            when (schedule.mode) {
                ScheduleMode.WORK -> DailyWorkScheduler.schedule(context, schedule)
                ScheduleMode.EXACT -> {
                    if (AlarmScheduler.canScheduleExactAlarms(context)) {
                        AlarmScheduler.schedule(context, schedule)
                    } else {
                        // 权限被撤则降级到 WorkManager，保证功能可用
                        DailyWorkScheduler.schedule(context, schedule.copy(mode = ScheduleMode.WORK))
                    }
                }
            }
        }
    }
}
