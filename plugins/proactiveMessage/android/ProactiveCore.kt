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
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.pppxxxy.easychat2.MainActivity
import com.pppxxxy.easychat2.R
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

/** 主动消息的类型，决定生成提示词的取向。问好按时间段自动选早/中/晚。 */
enum class MessageType { DEFAULT, CARE, GREETING, CUSTOM }

/**
 * 一个"时间槽"：某角色在某个时刻的一条定时任务。
 * 同一角色可以配置多个槽（早 8:00、晚 21:00…），因此唯一标识用 slotId，
 * 而不是 roleId —— 否则多个槽会在 WorkManager/闹钟/去重记录上互相覆盖。
 */
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
    val customPrompt: String = "",
    // JS 侧预先组装好的完整请求消息数组（JSON 字符串）。非空时后台直接发送它，
    // 使主动消息与普通对话用同一套提示词（角色/用户设定、预设、世界书、摘要、历史）。
    val requestJson: String = "",
    // 角色头像本地文件 URI（file://…/avatars/xxx），用于通知头像。
    val avatarUri: String = ""
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
        .put("requestJson", requestJson)
        .put("avatarUri", avatarUri)

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
            customPrompt = json.optString("customPrompt", ""),
            requestJson = json.optString("requestJson", ""),
            avatarUri = json.optString("avatarUri", "")
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

    // apiKey 单独存 EncryptedSharedPreferences（AES256-GCM，密钥由 Android Keystore 托管），
    // 其余非敏感数据仍走明文 prefs。创建失败（极老设备/Keystore 异常）时降级为 null，
    // 读取退回明文 prefs、写入退回明文 —— 保证功能可用，不因加密不可用而崩溃。
    private val secretPrefs: android.content.SharedPreferences? = try {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        EncryptedSharedPreferences.create(
            context,
            SECRET_PREFS,
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
    } catch (e: Exception) {
        Log.e("MessageStore", "加密存储不可用，apiKey 降级为明文存储", e)
        null
    }

    fun saveSchedules(list: List<RoleSchedule>) {
        val json = JSONArray()
        list.forEach { json.put(it.toJson()) }
        prefs.edit().putString(KEY_SCHEDULES, json.toString()).apply()
    }

    fun upsertSchedule(schedule: RoleSchedule) {
        val list = loadSchedules().filterNot { it.resolvedSlotId == schedule.resolvedSlotId } + schedule
        saveSchedules(list)
        // 用户重新保存了该槽（改了时间/类型/内容等）：清掉「今天已发」标记，
        // 让新配置当天就能再次生效。否则改了设置也必须等明天，无法验证。
        clearSlotSentToday(schedule.resolvedSlotId)
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
            .apply()
        // 安全：apiKey 不再明文落盘。优先写加密存储；加密不可用（写入也可能因 Keystore
        // 失效抛错）时降级明文，保证功能不因加密异常而中断。
        if (writeSecretApiKey(settings.apiKey)) {
            // 迁移清理：历史版本可能在明文 prefs 存过 apiKey，写加密成功后删除。
            prefs.edit().remove(KEY_API_KEY).apply()
        } else {
            prefs.edit().putString(KEY_API_KEY, settings.apiKey).apply()
        }
    }

    fun loadApiSettings(): ApiSettings? {
        val endpoint = prefs.getString(KEY_ENDPOINT, null) ?: return null
        val model = prefs.getString(KEY_MODEL, null) ?: return null
        val secret = readSecretApiKey()
        if (secret != null) return ApiSettings(endpoint, model, secret)
        // 加密区没有值（或不可用）：回退明文区，兼作旧数据迁移。
        val legacy = prefs.getString(KEY_API_KEY, null)
        if (legacy != null && secretPrefs != null) {
            if (writeSecretApiKey(legacy)) prefs.edit().remove(KEY_API_KEY).apply()
        }
        return ApiSettings(endpoint, model, legacy ?: "")
    }

    /** 写入加密存储；成功返回 true，加密不可用或抛错返回 false（调用方降级明文）。 */
    private fun writeSecretApiKey(value: String): Boolean {
        val encrypted = secretPrefs ?: return false
        return try {
            encrypted.edit().putString(KEY_API_KEY, value).apply()
            true
        } catch (e: Exception) {
            Log.e("MessageStore", "apiKey 写入加密存储失败，降级明文", e)
            false
        }
    }

    /** 读取加密存储中的 apiKey；无值/不可用/抛错返回 null（调用方回退明文区）。 */
    private fun readSecretApiKey(): String? {
        val encrypted = secretPrefs ?: return null
        return try {
            encrypted.getString(KEY_API_KEY, null)
        } catch (e: Exception) {
            Log.e("MessageStore", "apiKey 读取加密存储失败，回退明文", e)
            null
        }
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

    /** 清除「今天已发」标记：用户重新保存该槽后允许当天再次触发。 */
    fun clearSlotSentToday(slotId: String) {
        prefs.edit().remove("$KEY_LAST_SENT$slotId").apply()
    }

    // ---------- 待写队列（主动消息落库） ----------
    // 消息生成后先入队；JS 消费写入会话后按 id 移除。App 没打开也不丢，下次启动补写。

    fun appendPendingMessage(message: PendingMessage) {
        synchronized(pendingLock) {
            val list = loadPendingMessages()
                // 同 id 幂等：同一槽同一天重复生成时以后写入的为准（旧值先移除）
                .filterNot { it.id == message.id }
                .plus(message)
            // 超期淘汰：生成超过 7 天的消息不再有意义
            val cutoff = System.currentTimeMillis() - MAX_PENDING_AGE_MS
            val fresh = list.filter { it.createdAt >= cutoff }
            // 上限淘汰：超出时按 createdAt 保留最新的 MAX_PENDING 条
            val bounded = if (fresh.size > MAX_PENDING) {
                fresh.sortedBy { it.createdAt }.takeLast(MAX_PENDING)
            } else fresh
            prefs.edit().putString(KEY_PENDING_MESSAGES, encodePending(bounded)).apply()
        }
    }

    fun loadPendingMessages(): List<PendingMessage> {
        synchronized(pendingLock) {
            val raw = prefs.getString(KEY_PENDING_MESSAGES, null) ?: return emptyList()
            return try {
                val json = JSONArray(raw)
                (0 until json.length()).map { PendingMessage.fromJson(json.getJSONObject(it)) }
            } catch (e: Exception) {
                Log.e("MessageStore", "解析待写队列失败", e)
                emptyList()
            }
        }
    }

    /** 按 id 移除已成功落库的消息，避免重复写入。 */
    fun removePendingMessages(ids: List<String>) {
        if (ids.isEmpty()) return
        synchronized(pendingLock) {
            val idSet = ids.toSet()
            val remaining = loadPendingMessages().filterNot { it.id in idSet }
            prefs.edit().putString(KEY_PENDING_MESSAGES, encodePending(remaining)).apply()
        }
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
        private const val SECRET_PREFS = "proactive_message_secrets"
        private const val KEY_SCHEDULES = "schedules"
        private const val KEY_ENDPOINT = "api_endpoint"
        private const val KEY_MODEL = "api_model"
        private const val KEY_API_KEY = "api_key"
        private const val KEY_LAST_SENT = "last_sent_"
        private const val KEY_PENDING_MESSAGES = "pending_messages"
        // 待写队列的读-改-写必须整体互斥：MessageStore 每次调用都新实例化，
        // 实例锁无效，这里用伴生对象的全局锁。否则前台服务线程 append 与
        // NativeModules 线程 remove 交错时，后写者会用旧快照覆盖，丢「已通知未落库」的消息。
        private val pendingLock = Any()
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
            // 优先用 JS 保存槽时组装好的完整消息数组（含正常对话的整套上下文）；
            // 解析失败或无此字段时退回「角色设定 + 类型提示词」的简版。
            val messages = parseRequestJson(schedule.requestJson)
                ?: JSONArray()
                    .put(JSONObject().put("role", "system").put("content", buildSystemPrompt(schedule)))
                    .put(JSONObject().put("role", "user").put("content", "请现在主动开口。"))
            // requestJson 是保存时的快照：JS 侧把时间感知写成了占位符，这里替换成触发时刻。
            substituteProactiveTime(messages)

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

        // 与 src/proactiveRequest.js 的 PROACTIVE_TIME_TOKEN 保持一致
        private const val PROACTIVE_TIME_TOKEN = "{{proactive_now}}"
        private val WEEKDAY_CHARS = arrayOf("日", "一", "二", "三", "四", "五", "六")

        /** 解析 JS 组装的请求消息数组；非法/为空返回 null，由调用方回退简版提示词。 */
        fun parseRequestJson(raw: String): JSONArray? {
            if (raw.isBlank()) return null
            return try {
                val array = JSONArray(raw)
                if (array.length() == 0) null else array
            } catch (e: Exception) {
                Log.w("AiApiClient", "requestJson 解析失败，回退简版提示词")
                null
            }
        }

        /**
         * 把 JS 保存槽时写入的时间占位符替换成触发时刻的「[当前时间] …」。
         * 快照会在保存后数天的任意时刻触发，JS 侧不能固化真实时间；
         * 格式与 JS 聊天的时间感知一致（yyyy-MM-dd 周X HH:mm）。
         */
        fun substituteProactiveTime(messages: JSONArray) {
            if (!messages.toString().contains(PROACTIVE_TIME_TOKEN)) return
            val calendar = Calendar.getInstance()
            val week = WEEKDAY_CHARS[calendar.get(Calendar.DAY_OF_WEEK) - 1]
            val date = SimpleDateFormat("yyyy-MM-dd", Locale.US).format(calendar.time)
            val time = SimpleDateFormat("HH:mm", Locale.US).format(calendar.time)
            val nowText = "[当前时间] $date 周$week $time"
            for (index in 0 until messages.length()) {
                val message = messages.optJSONObject(index) ?: continue
                val content = message.opt("content")
                if (content is String && content.contains(PROACTIVE_TIME_TOKEN)) {
                    message.put("content", content.replace(PROACTIVE_TIME_TOKEN, nowText))
                }
            }
        }

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

    // 渠道 ID 带 v2：Android 的渠道重要性只在首次创建时固定，旧渠道（proactive_message）
    // 已被系统记住为低重要性、代码改不动，只能用新 ID 重建为高重要性以弹出横幅。
    const val CHANNEL_ID = "proactive_message_v2"
    // 前台服务「正在准备消息」通知单独用低重要性渠道：API 26+ 单条通知的 priority
    // 受渠道重要性支配，沿用 HIGH 渠道会让这条临时通知也弹横幅，与低干扰意图相反。
    const val SERVICE_CHANNEL_ID = "proactive_service_v1"
    // 前台服务通知沿用同一渠道即可
    const val EXTRA_ROLE_ID = "com.pppxxxy.easychat2.proactive.EXTRA_ROLE_ID"

    // Android 8+ 必须有渠道；重复创建是幂等的
    fun ensureChannel(context: Context) {
        val channel = NotificationChannel(
            CHANNEL_ID, "角色主动消息", NotificationManager.IMPORTANCE_HIGH
        ).apply {
            description = "AI 角色的定时主动问候"
            enableVibration(true)
            // 允许横幅提醒（部分系统仍会由用户通知设置覆盖）
            setShowBadge(true)
        }
        context.getSystemService(NotificationManager::class.java)
            .createNotificationChannel(channel)
    }

    // 前台服务进度通知专用的低重要性渠道（静默、不弹横幅）。
    fun ensureServiceChannel(context: Context) {
        val channel = NotificationChannel(
            SERVICE_CHANNEL_ID, "主动消息生成中", NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "生成主动消息时的临时进度提示"
            setShowBadge(false)
        }
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

    /** 把角色头像本地文件读成 Bitmap 供通知使用；失败返回 null（回退默认）。 */
    private fun loadAvatar(context: Context, uri: String): android.graphics.Bitmap? {
        if (uri.isBlank()) return null
        return try {
            context.contentResolver.openInputStream(android.net.Uri.parse(uri))?.use { input ->
                android.graphics.BitmapFactory.decodeStream(input)
            }
        } catch (e: Exception) {
            Log.w("Notifier", "头像加载失败: ${e.javaClass.simpleName}")
            null
        }
    }

    fun sendRoleMessage(
        context: Context,
        slotId: String,
        roleId: String,
        roleName: String,
        text: String,
        avatarUri: String = ""
    ) {
        ensureChannel(context)
        if (!canNotify(context)) {
            Log.w("Notifier", "通知未授权或被关闭，跳过展示")
            return
        }
        val avatar = loadAvatar(context, avatarUri)
        val personBuilder = Person.Builder().setName(roleName)
        if (avatar != null) {
            personBuilder.setIcon(
                androidx.core.graphics.drawable.IconCompat.createWithBitmap(avatar)
            )
        }
        val sender = personBuilder.build()
        // MessagingStyle 呈现聊天气泡；带 Person 头像时通知头像即角色卡头像
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

        val builder = NotificationCompat.Builder(context, CHANNEL_ID)
            // 用自带单色聊天气泡，避免系统内置图标（带圈 i）作角标
            .setSmallIcon(R.drawable.ic_stat_proactive)
            .setContentTitle(roleName)
            .setStyle(style)
            .setContentIntent(pendingIntent)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            // 消息类通知：部分系统据此允许横幅与置顶
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setDefaults(NotificationCompat.DEFAULT_ALL)
        if (avatar != null) {
            builder.setLargeIcon(avatar)
        }

        try {
            NotificationManagerCompat.from(context).notify(slotId.hashCode(), builder.build())
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
            context, slotId, schedule.roleId, schedule.roleName, text, schedule.avatarUri
        )
        // 通知权限被拒时也标记已发送，避免反复尝试变成骚扰
        store.markSlotSentToday(slotId)
        Log.i(TAG, "主动消息完成: slot=$slotId ai=${generated != null}")
    }
}