package com.pppxxxy.easychat2.proactive

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import androidx.core.content.ContextCompat
import com.pppxxxy.easychat2.MainActivity
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Locale
import java.util.UUID
import java.util.concurrent.TimeUnit

// 定时主动消息 - 核心层：配置存储、时间窗口、AI 请求、降级文案与通知。
// 注意：minSdk 23，不能使用 java.time（API 26+），时间计算一律走 java.util.Calendar。

enum class ScheduleMode { WORK, EXACT }

data class RoleSchedule(
    val roleId: String,
    val roleName: String,
    val persona: String,
    val hour: Int,
    val minute: Int,
    val mode: ScheduleMode,
    val enabled: Boolean = true,
    // 配置每次变更重新生成；队列里的旧任务凭 revision 不匹配自动放弃
    val revision: String = UUID.randomUUID().toString()
) {
    init {
        require(roleId.isNotBlank())
        require(hour in 0..23)
        require(minute in 0..59)
    }

    fun toJson(): JSONObject = JSONObject()
        .put("roleId", roleId)
        .put("roleName", roleName)
        .put("persona", persona)
        .put("hour", hour)
        .put("minute", minute)
        .put("mode", mode.name)
        .put("enabled", enabled)
        .put("revision", revision)

    companion object {
        fun fromJson(json: JSONObject): RoleSchedule = RoleSchedule(
            roleId = json.getString("roleId"),
            roleName = json.optString("roleName", "角色"),
            persona = json.optString("persona", ""),
            hour = json.getInt("hour"),
            minute = json.getInt("minute"),
            mode = ScheduleMode.valueOf(json.optString("mode", "WORK")),
            enabled = json.optBoolean("enabled", true),
            revision = json.optString("revision", UUID.randomUUID().toString())
        )
    }
}

// apiKey 只能来自用户在设置页输入并保存的值，代码里永远只允许占位
data class ApiSettings(val endpoint: String, val model: String, val apiKey: String)

object MessageClock {
    // 超过 30 分钟就放弃发送，避免半夜收到"早安"
    const val MAX_LATENESS_MS = 30L * 60L * 1000L

    private fun targetOn(config: RoleSchedule, base: Calendar): Long {
        return (base.clone() as Calendar).apply {
            set(Calendar.HOUR_OF_DAY, config.hour)
            set(Calendar.MINUTE, config.minute)
            set(Calendar.SECOND, 0)
            set(Calendar.MILLISECOND, 0)
        }.timeInMillis
    }

    fun todayTarget(config: RoleSchedule): Long = targetOn(config, Calendar.getInstance())

    fun nextTarget(config: RoleSchedule): Long {
        val now = Calendar.getInstance()
        val today = targetOn(config, now)
        if (today > now.timeInMillis) return today
        val tomorrow = (now.clone() as Calendar).apply { add(Calendar.DAY_OF_YEAR, 1) }
        return targetOn(config, tomorrow)
    }

    fun isExpired(config: RoleSchedule, nowMillis: Long): Boolean {
        val diff = nowMillis - todayTarget(config)
        val expired = diff > MAX_LATENESS_MS
        if (expired) {
            Log.w("MessageClock", "任务过期跳过: role=${config.roleId} 偏差=${diff}ms")
        }
        return expired
    }
}

class MessageStore(context: Context) {

    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun saveSchedules(list: List<RoleSchedule>) {
        val json = JSONArray()
        list.forEach { json.put(it.toJson()) }
        prefs.edit().putString(KEY_SCHEDULES, json.toString()).apply()
    }

    fun upsertSchedule(schedule: RoleSchedule) {
        val list = loadSchedules().filterNot { it.roleId == schedule.roleId } + schedule
        saveSchedules(list)
    }

    fun removeSchedule(roleId: String) {
        saveSchedules(loadSchedules().filterNot { it.roleId == roleId })
    }

    fun loadSchedules(): List<RoleSchedule> {
        val raw = prefs.getString(KEY_SCHEDULES, null) ?: return emptyList()
        return try {
            val json = JSONArray(raw)
            (0 until json.length()).map { RoleSchedule.fromJson(json.getJSONObject(it)) }
        } catch (e: Exception) {
            Log.e("MessageStore", "解析定时配置失败", e)
            emptyList()
        }
    }

    fun findSchedule(roleId: String): RoleSchedule? =
        loadSchedules().firstOrNull { it.roleId == roleId }

    fun saveApiSettings(settings: ApiSettings) {
        prefs.edit()
            .putString(KEY_ENDPOINT, settings.endpoint)
            .putString(KEY_MODEL, settings.model)
            // apiKey 明文 SharedPreferences 仅作示例，生产建议 Keystore/EncryptedSharedPreferences
            .putString(KEY_API_KEY, settings.apiKey)
            .apply()
    }

    fun loadApiSettings(): ApiSettings? {
        val endpoint = prefs.getString(KEY_ENDPOINT, null) ?: return null
        val model = prefs.getString(KEY_MODEL, null) ?: return null
        return ApiSettings(endpoint, model, prefs.getString(KEY_API_KEY, "") ?: "")
    }

    private fun today(): String =
        SimpleDateFormat("yyyy-MM-dd", Locale.US).format(Calendar.getInstance().time)

    fun lastSentDate(roleId: String): String? = prefs.getString("$KEY_LAST_SENT$roleId", null)

    fun isSentToday(roleId: String): Boolean = lastSentDate(roleId) == today()

    fun markSentToday(roleId: String) {
        prefs.edit().putString("$KEY_LAST_SENT$roleId", today()).apply()
    }

    companion object {
        private const val PREFS = "proactive_message_prefs"
        private const val KEY_SCHEDULES = "schedules"
        private const val KEY_ENDPOINT = "api_endpoint"
        private const val KEY_MODEL = "api_model"
        private const val KEY_API_KEY = "api_key"
        private const val KEY_LAST_SENT = "last_sent_"
    }
}

object FallbackMessages {
    // AI 请求失败/超时时的兜底文案，按时间段选取
    private val morning = listOf(
        "早上好！新的一天，有什么想和我聊聊的吗？",
        "早安～记得吃早餐哦，今天也在等你的消息。",
        "醒了吗？我在呢，随时来找我聊天。"
    )
    private val afternoon = listOf(
        "下午好，工作学习还顺利吗？",
        "有点想你了，来聊几句吧。",
        "下午犯困的话，来和我说说话提提神！"
    )
    private val evening = listOf(
        "晚上好，今天过得怎么样？",
        "忙碌了一天，和我分享一下今天吧。",
        "夜晚是聊天的好时光，有什么心事吗？"
    )

    fun random(): String {
        val list = when (Calendar.getInstance().get(Calendar.HOUR_OF_DAY)) {
            in 5..11 -> morning
            in 12..17 -> afternoon
            else -> evening
        }
        return list.random()
    }
}

class AiApiClient {

    private val client = OkHttpClient.Builder()
        // 后台任务窗口有限，超时控制在 10-20 秒
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .writeTimeout(10, TimeUnit.SECONDS)
        .build()

    /** 调用 OpenAI-compatible Chat Completions；返回 null 表示需要本地降级 */
    suspend fun generateProactiveMessage(
        settings: ApiSettings,
        schedule: RoleSchedule
    ): String? = withContext(Dispatchers.IO) {
        if (settings.endpoint.isBlank() || settings.model.isBlank() || settings.apiKey.isBlank()) {
            return@withContext null
        }
        try {
            val systemPrompt = """
                你将扮演以下角色：${schedule.persona}
                请主动给一段时间没说话的用户发一条简短、自然的问候消息。
                要求：不超过 80 字，不要输出 JSON 或解释，直接输出消息正文。
            """.trimIndent()

            val messages = JSONArray()
                .put(JSONObject().put("role", "system").put("content", systemPrompt))
                .put(JSONObject().put("role", "user").put("content", "请现在主动开口。"))

            val body = JSONObject()
                .put("model", settings.model)
                .put("messages", messages)
                .put("max_tokens", 120)
                .put("temperature", 0.9)
                .toString()
                .toRequestBody(JSON_MEDIA)

            val request = Request.Builder()
                .url(settings.endpoint)
                .header("Authorization", "Bearer ${settings.apiKey}")
                .header("Content-Type", "application/json")
                .post(body)
                .build()

            client.newCall(request).execute().use { response ->
                if (!response.isSuccessful) {
                    // 不打印响应体，避免把服务端回显的敏感信息写进日志
                    Log.w("AiApiClient", "HTTP ${response.code}，走本地降级")
                    return@withContext null
                }
                val text = response.body?.string().orEmpty()
                JSONObject(text)
                    .getJSONArray("choices")
                    .getJSONObject(0)
                    .getJSONObject("message")
                    .getString("content")
                    .trim()
                    .ifBlank { null }
            }
        } catch (e: Exception) {
            Log.w("AiApiClient", "请求失败: ${e.javaClass.simpleName}: ${e.message}")
            null
        }
    }

    companion object {
        private val JSON_MEDIA = "application/json; charset=utf-8".toMediaType()
    }
}

object Notifier {

    const val CHANNEL_ID = "proactive_message"
    const val EXTRA_ROLE_ID = "com.pppxxxy.easychat2.proactive.EXTRA_ROLE_ID"

    // Android 8+ 必须有渠道；重复创建是幂等的
    fun ensureChannel(context: Context) {
        val channel = NotificationChannel(
            CHANNEL_ID, "角色主动消息", NotificationManager.IMPORTANCE_HIGH
        ).apply { description = "AI 角色的每日主动问候" }
        context.getSystemService(NotificationManager::class.java)
            .createNotificationChannel(channel)
    }

    fun canNotify(context: Context): Boolean {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS)
            != PackageManager.PERMISSION_GRANTED
        ) {
            return false
        }
        return NotificationManagerCompat.from(context).areNotificationsEnabled()
    }

    fun sendRoleMessage(context: Context, roleId: String, roleName: String, text: String) {
        ensureChannel(context)
        if (!canNotify(context)) {
            Log.w("Notifier", "通知未授权或被关闭，跳过展示")
            return
        }
        val sender = Person.Builder().setName(roleName).build()
        // MessagingStyle 呈现聊天气泡
        val style = NotificationCompat.MessagingStyle(sender)
            .addMessage(text, System.currentTimeMillis(), sender)

        // 点击通知回到 MainActivity，携带 roleId；RN 侧经 ProactiveMessageModule 事件接收
        val launchIntent = Intent(context, MainActivity::class.java).apply {
            putExtra(EXTRA_ROLE_ID, roleId)
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or
                Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val pendingIntent = PendingIntent.getActivity(
            context, roleId.hashCode(), launchIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle(roleName)
            .setStyle(style)
            .setContentIntent(pendingIntent)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .build()

        try {
            NotificationManagerCompat.from(context).notify(roleId.hashCode(), notification)
        } catch (e: SecurityException) {
            Log.w("Notifier", "通知权限在运行中被撤销", e)
        }
    }
}

/**
 * 两套调度方案共用的发送核心：去重、过期检查、AI 生成与本地降级都在这一处，
 * Worker / 前台服务只做最薄的调度包装，避免行为分叉。
 */
object ProactiveMessageSender {

    private const val TAG = "ProactiveSender"

    suspend fun send(context: Context, roleId: String, revision: String) {
        val store = MessageStore(context)
        val schedule = store.findSchedule(roleId)

        if (schedule == null || !schedule.enabled) {
            Log.i(TAG, "配置已停用/删除: $roleId"); return
        }
        if (schedule.revision != revision) {
            Log.i(TAG, "revision 不匹配，放弃旧任务: $roleId"); return
        }
        if (store.isSentToday(roleId)) {
            Log.i(TAG, "今天已发送，跳过: $roleId"); return
        }
        if (MessageClock.isExpired(schedule, System.currentTimeMillis())) return

        val generated = store.loadApiSettings()
            ?.let { AiApiClient().generateProactiveMessage(it, schedule) }
        val text = generated ?: FallbackMessages.random().also {
            Log.i(TAG, "AI 生成失败，使用本地降级文案: $roleId")
        }

        // 网络请求可能耗时较久，发送前复检
        if (MessageClock.isExpired(schedule, System.currentTimeMillis()) || store.isSentToday(roleId)) return

        Notifier.sendRoleMessage(context, schedule.roleId, schedule.roleName, text)
        // 通知权限被拒时也标记已发送，避免反复尝试变成骚扰
        store.markSentToday(roleId)
        Log.i(TAG, "主动消息完成: role=$roleId ai=${generated != null}")
    }
}
