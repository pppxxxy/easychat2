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

/**
 * 一个"时间槽"：某角色在某个时刻的一条定时任务。
 * 同一角色可以配置多个槽（早 8:00、晚 21:00…），因此唯一标识用 slotId，
 * 而不是 roleId —— 否则多个槽会在 WorkManager/闹钟/去重记录上互相覆盖。
 */
/** 主动消息的类型，决定生成提示词的取向。问好按时间段自动选早/中/晚。 */
enum class MessageType { DEFAULT, CARE, GREETING, CUSTOM }

data class RoleSchedule(
    val roleId: String,
    val roleName: String,
    val persona: String,
    val hour: Int,
    val minute: Int,
    val mode: ScheduleMode,
    val enabled: Boolean = true,
    // 配置每次变更重新生成；队列里的旧任务凭 revision 不匹配自动放弃
    val revision: String = UUID.randomUUID().toString(),
    // 时间槽标识，由 JS 生成并在排定/取消时保持一致
    val slotId: String = "",
    // 消息类型与自定义提示词
    val messageType: MessageType = MessageType.DEFAULT,
    val customPrompt: String = ""
) {
    init {
        require(roleId.isNotBlank())
        require(hour in 0..23)
        require(minute in 0..59)
    }

    /** 兜底：老数据没有 slotId 时按角色+时刻派生，保证同一槽稳定 */
    val resolvedSlotId: String
        get() = slotId.ifBlank { "$roleId-$hour-$minute" }

    fun toJson(): JSONObject = JSONObject()
        .put("roleId", roleId)
        .put("roleName", roleName)
        .put("persona", persona)
        .put("hour", hour)
        .put("minute", minute)
        .put("mode", mode.name)
        .put("enabled", enabled)
        .put("revision", revision)
        .put("slotId", resolvedSlotId)
        .put("messageType", messageType.name)
        .put("customPrompt", customPrompt)

    companion object {
        fun fromJson(json: JSONObject): RoleSchedule = RoleSchedule(
            roleId = json.getString("roleId"),
            roleName = json.optString("roleName", "角色"),
            persona = json.optString("persona", ""),
            hour = json.getInt("hour"),
            minute = json.getInt("minute"),
            mode = ScheduleMode.valueOf(json.optString("mode", "WORK")),
            enabled = json.optBoolean("enabled", true),
            revision = json.optString("revision", UUID.randomUUID().toString()),
            slotId = json.optString("slotId", ""),
            // 老配置没有 messageType：解析失败一律回退默认
            messageType = runCatching {
                MessageType.valueOf(json.optString("messageType", "DEFAULT"))
            }.getOrDefault(MessageType.DEFAULT),
            customPrompt = json.optString("customPrompt", "")
        )
    }
}

/** 待写队列中的一条主动消息：原生生成后暂存，JS 打开应用/点通知时消费落库。 */
data class PendingMessage(
    val id: String,
    val slotId: String,
    val roleId: String,
    val roleName: String,
    val text: String,
    val createdAt: Long
) {
    fun toJson(): JSONObject = JSONObject()
        .put("id", id)
        .put("slotId", slotId)
        .put("roleId", roleId)
        .put("roleName", roleName)
        .put("text", text)
        .put("createdAt", createdAt)

    companion object {
        fun fromJson(json: JSONObject): PendingMessage = PendingMessage(
            id = json.getString("id"),
            slotId = json.optString("slotId", ""),
            roleId = json.getString("roleId"),
            roleName = json.optString("roleName", "角色"),
            text = json.optString("text", ""),
            createdAt = json.optLong("createdAt", 0L)
        )
    }
}

// apiKey 只能来自用户在设置页已有的 API 配置，代码里永远只允许占位
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
            Log.w("MessageClock", "任务过期跳过: slot=${config.resolvedSlotId} 偏差=${diff}ms")
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
        val list = loadSchedules().filterNot { it.resolvedSlotId == schedule.resolvedSlotId } + schedule
        saveSchedules(list)
    }

    /** 取消某角色的全部时间槽 */
    fun removeSchedulesByRole(roleId: String) {
        saveSchedules(loadSchedules().filterNot { it.roleId == roleId })
    }

    fun removeScheduleBySlot(slotId: String) {
        saveSchedules(loadSchedules().filterNot { it.resolvedSlotId == slotId })
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

    fun findScheduleBySlot(slotId: String): RoleSchedule? =
        loadSchedules().firstOrNull { it.resolvedSlotId == slotId }

    fun findSchedulesByRole(roleId: String): List<RoleSchedule> =
        loadSchedules().filter { it.roleId == roleId && it.enabled }

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

    /**
     * 每个时间槽每日一条：按 slotId + 日期去重。
     * 若仍按 roleId 去重，一个角色配了多个时间时只有第一个能发出。
     */
    fun lastSentDate(slotId: String): String? = prefs.getString("$KEY_LAST_SENT$slotId", null)

    fun isSlotSentToday(slotId: String): Boolean = lastSentDate(slotId) == today()

    fun markSlotSentToday(slotId: String) {
        prefs.edit().putString("$KEY_LAST_SENT$slotId", today()).apply()
    }

    // ---------- 待写队列（主动消息落库） ----------
    // 消息生成后先入队；JS 消费写入会话后按 id 移除。App 没打开也不丢，下次启动补写。

    fun appendPendingMessage(message: PendingMessage) {
        val list = loadPendingMessages()
            // 同 id 幂等：同一槽同一天重复生成时保留最早一条
            .filterNot { it.id == message.id }
            .plus(message)
        // 超期淘汰：生成超过 7 天的消息不再有意义
        val cutoff = System.currentTimeMillis() - MAX_PENDING_AGE_MS
        val fresh = list.filter { it.createdAt >= cutoff }
        // 上限淘汰：超出按 createdAt 淘汰最旧
        val bounded = if (fresh.size > MAX_PENDING) {
            fresh.sortedBy { it.createdAt }.takeLast(MAX_PENDING)
        } else fresh
        prefs.edit().putString(KEY_PENDING_MESSAGES, encodePending(bounded)).apply()
    }

    fun loadPendingMessages(): List<PendingMessage> {
        val raw = prefs.getString(KEY_PENDING_MESSAGES, null) ?: return emptyList()
        return try {
            val json = JSONArray(raw)
            (0 until json.length()).map { PendingMessage.fromJson(json.getJSONObject(it)) }
        } catch (e: Exception) {
            Log.e("MessageStore", "解析待写队列失败", e)
            emptyList()
        }
    }

    /** 按 id 移除已成功落库的消息，避免重复写入。 */
    fun removePendingMessages(ids: List<String>) {
        if (ids.isEmpty()) return
        val idSet = ids.toSet()
        val remaining = loadPendingMessages().filterNot { it.id in idSet }
        prefs.edit().putString(KEY_PENDING_MESSAGES, encodePending(remaining)).apply()
    }

    private fun encodePending(list: List<PendingMessage>): String {
        val json = JSONArray()
        list.forEach { json.put(it.toJson()) }
        return json.toString()
    }

    private fun today(): String =
        SimpleDateFormat("yyyy-MM-dd", Locale.US).format(Calendar.getInstance().time)

    companion object {
        private const val PREFS = "proactive_message_prefs"
        private const val KEY_SCHEDULES = "schedules"
        private const val KEY_ENDPOINT = "api_endpoint"
        private const val KEY_MODEL = "api_model"
        private const val KEY_API_KEY = "api_key"
        private const val KEY_LAST_SENT = "last_sent_"
        private const val KEY_PENDING_MESSAGES = "pending_messages"
        // 队列上限与超期，避免长期不打开应用导致无界增长
        private const val MAX_PENDING = 100
        private const val MAX_PENDING_AGE_MS = 7L * 24L * 60L * 60L * 1000L
    }
}

object FallbackMessages {
    // AI 请求失败/超时时的兜底文案，按时间段选取
    private val morning = listOf(
        "早上好！新的一天，有什么想和我聊聊的吗？",
        "早安～记得吃早餐哦，今天也在等你的消息。",
        "醒了吗？我在呢，随时来找你聊天。"
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
    // 关心心情：与问候区分，聚焦对方状态
    private val care = listOf(
        "最近还好吗？有点惦记你的心情。",
        "今天累不累？要是心情不好，我陪你聊聊。",
        "忽然想起你，记得照顾好自己呀。"
    )

    fun random(messageType: MessageType = MessageType.DEFAULT): String {
        if (messageType == MessageType.CARE) return care.random()
        val list = when (Calendar.getInstance().get(Calendar.HOUR_OF_DAY)) {
            in 5..11 -> morning
            in 12..17 -> afternoon
            else -> evening
        }
        return list.random()
    }
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
            val systemPrompt = buildSystemPrompt(schedule)

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

        /** 按消息类型组装系统提示词；问好按当前时段选早/中/晚。 */
        fun buildSystemPrompt(schedule: RoleSchedule, nowHour: Int = Calendar.getInstance().get(Calendar.HOUR_OF_DAY)): String {
            val head = "你将扮演以下角色：${schedule.persona}"
            val tail = "要求：不超过 80 字，不要输出 JSON 或解释，直接输出消息正文。"
            val task = when (schedule.messageType) {
                MessageType.CARE ->
                    "请主动给一段时间没说话的用户发一条关心其心情与状态的消息：先体贴地询问对方此刻心情如何、累不累，语气温暖真诚。"
                MessageType.GREETING -> {
                    val period = when (nowHour) {
                        in 5..11 -> "早上"
                        in 12..17 -> "中午"
                        in 18..22 -> "晚上"
                        else -> "夜里"
                    }
                    "请主动向用户发一条${period}的问好消息，自然亲切，可以带一点当天的问候。"
                }
                MessageType.CUSTOM ->
                    if (schedule.customPrompt.isBlank()) {
                        "请主动给一段时间没说话的用户发一条简短、自然的问候消息。"
                    } else {
                        schedule.customPrompt
                    }
                else ->
                    "请主动给一段时间没说话的用户发一条简短、自然的问候消息。"
            }
            return "$head\n$task\n$tail"
        }
    }
}

object Notifier {

    const val CHANNEL_ID = "proactive_message"
    const val EXTRA_ROLE_ID = "com.pppxxxy.easychat2.proactive.EXTRA_ROLE_ID"

    // Android 8+ 必须有渠道；重复创建是幂等的
    fun ensureChannel(context: Context) {
        val channel = NotificationChannel(
            CHANNEL_ID, "角色主动消息", NotificationManager.IMPORTANCE_HIGH
        ).apply { description = "AI 角色的定时主动问候" }
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

    fun sendRoleMessage(context: Context, slotId: String, roleId: String, roleName: String, text: String) {
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
            context, slotId.hashCode(), launchIntent,
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
            NotificationManagerCompat.from(context).notify(slotId.hashCode(), notification)
        } catch (e: SecurityException) {
            Log.w("Notifier", "通知权限在运行中被撤销", e)
        }
    }
}

/**
 * 两套调度方案共用的发送核心：去重、过期检查、AI 生成与本地降级都在这一处，
 * Worker / 前台服务只做最薄的调度包装，避免行为分叉。
 * 入参是 slotId（时间槽），因为同一角色可能配多个时间。
 */
object ProactiveMessageSender {

    private const val TAG = "ProactiveSender"

    suspend fun send(context: Context, slotId: String, revision: String) {
        val store = MessageStore(context)
        val schedule = store.findScheduleBySlot(slotId)

        if (schedule == null || !schedule.enabled) {
            Log.i(TAG, "配置已停用/删除: slot=$slotId"); return
        }
        if (schedule.revision != revision) {
            Log.i(TAG, "revision 不匹配，放弃旧任务: slot=$slotId"); return
        }
        if (store.isSlotSentToday(slotId)) {
            Log.i(TAG, "该时间槽今天已发送，跳过: slot=$slotId"); return
        }
        if (MessageClock.isExpired(schedule, System.currentTimeMillis())) return

        val generated = store.loadApiSettings()
            ?.let { AiApiClient().generateProactiveMessage(it, schedule) }
        val text = generated ?: FallbackMessages.random(schedule.messageType).also {
            Log.i(TAG, "AI 生成失败，使用本地降级文案: slot=$slotId")
        }

        // 网络请求可能耗时较久，发送前复检
        if (MessageClock.isExpired(schedule, System.currentTimeMillis()) || store.isSlotSentToday(slotId)) return

        // 先落待写队列：通知权限被拒也不影响消息存在性，App 下次打开补写进会话。
        // id 由 slotId + 日期派生，保证同一槽同一天幂等。
        val pendingId = "${schedule.resolvedSlotId}-${SimpleDateFormat("yyyy-MM-dd", Locale.US).format(Calendar.getInstance().time)}"
        store.appendPendingMessage(
            PendingMessage(
                id = pendingId,
                slotId = schedule.resolvedSlotId,
                roleId = schedule.roleId,
                roleName = schedule.roleName,
                text = text,
                createdAt = System.currentTimeMillis()
            )
        )

        Notifier.sendRoleMessage(
            context, slotId, schedule.roleId, schedule.roleName, text
        )
        // 通知权限被拒时也标记已发送，避免反复尝试变成骚扰
        store.markSlotSentToday(slotId)
        Log.i(TAG, "主动消息完成: slot=$slotId ai=${generated != null}")
    }
}