package com.pppxxxy.easychat2.screenoverlay

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 悬浮窗的**原生大脑**（M2 大脑搬家）。
 *
 * 为什么在原生：旧架构把「聊天的脑子」放在 JS 页面组件里——悬浮窗是进程级常驻
 * （前台服务），大脑却随页面卸载/JS 冻结而消失，两者的生命周期根本错配
 * （设计文档 §一：四个症状的共同病根）。
 * 本类只依赖 Android 运行时 + OkHttp，**不 import 任何 RN/React 类**，
 * 因此 JS 死亡、组件卸载、RN 桥断开都不影响它工作。
 *
 * 安全（M2 前已由用户拍板）：apiKey 走 `EncryptedSharedPreferences`（AES256-GCM，
 * Keystore 托管）——与本仓库既有的原生直连先例 `proactiveMessage/ProactiveCore.kt`
 * 同一套做法，**不**按旧文档写明文 `config.json`（那是一次安全回退）。
 *
 * 协议：只实现 OpenAI 兼容 `/chat/completions`（流式）。非 openai 协议的配置
 * 悬浮窗聊天显示「当前协议需在 App 内使用」——不静默降级（设计文档 3.1/3.2）。
 *
 * ⚠️ 未在本地核实：沙箱无 Android SDK / Java，本文件无法编译或运行验证（仓库既有约束）。
 * 编译由 CI 的 `Kotlin compile (prebuild)` job 把关；SSE 解析 / 流式渲染 / 断流行为需真机验证。
 */
class OverlayBrain private constructor(context: Context) {

    enum class State { IDLE, THINKING, STREAMING }

    /** 一次会话轮次（JSONL 的一行 / 内存历史的一项）。 */
    data class Turn(val role: String, val text: String, val imageFile: String = "")

    /** 配置快照（由 JS 在保存/切换时经 writeOverlayConfig 写入）。 */
    data class Config(
        val baseUrl: String,
        val apiKey: String,
        val model: String,
        val fallbacks: List<String>,
        val protocol: String,
        val vision: Boolean,
        val personaName: String,
        val systemPrompt: String,
        val locale: String,
        // M3 耳朵：ASR 随同一份快照下发（避免再开一个写入入口与一套漂移风险）。
        val asrProvider: String = "system",
        val asrBaseUrl: String = "",
        val asrApiKey: String = "",
        val asrModel: String = "",
        // M4.1 嘴巴：TTS 播报开关（随同一份快照下发）。
        //
        // **诚实边界**：原生只实现**系统 TTS**（Android 内置 TextToSpeech 引擎），
        // 不实现云端 TTS。原因是云端合成需要各家服务商的请求体声明表
        //（JS 侧 src/tts/providers.js 有 560+ 行的完整表：鉴权方式、字段路径、
        // hex/base64/binary 三种响应形态、火山/讯飞/腾讯各自的签名规则），
        // 在原生复刻那张表必然与 JS 侧漂移——那是「两处各写一份」的典型反例。
        // 因此：云端 TTS 只在 app 内可用；悬浮窗（app 不在前台时）用系统引擎播报。
        // 这与设计文档「原生只做 OpenAI 兼容一种协议、纯对话一种场景」的取舍同构。
        val ttsEnabled: Boolean = false,
        val ttsVoice: String = "",
        val ttsSpeed: Float = 1.0f,
    ) {
        /** 设计文档 3.2：原生只实现 OpenAI 兼容协议，其余一律引导回 App。 */
        val protocolSupported: Boolean get() = protocol == "openai"
    }

    /** ASR 配置（M3 耳朵）：loadAsrConfig 的返回形状，OverlaySpeech 直接用这个类型。 */
    data class AsrConfig(
        val provider: String,
        val baseUrl: String,
        val apiKey: String,
        val model: String,
    ) {
        /** 云端 ASR 是否可用（字段齐全）；否则调用方退回系统识别。 */
        val cloudUsable: Boolean
            get() = provider == "cloud"
                && baseUrl.isNotBlank()
                && apiKey.isNotBlank()
                && model.isNotBlank()
    }

    private val appContext = context.applicationContext
    private val prefs: SharedPreferences = appContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    // apiKey 单独存 EncryptedSharedPreferences（与本仓库 ProactiveCore.kt 的既有做法一致）；
    // 创建失败（极老设备 / Keystore 异常）时降级 null，读取退回明文、写入退回明文——
    // 保证功能可用，不因加密不可用而崩溃。
    private val secretPrefs: SharedPreferences? = try {
        val masterKey = MasterKey.Builder(appContext)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        EncryptedSharedPreferences.create(
            appContext,
            SECRET_PREFS,
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
    } catch (error: Exception) {
        Log.e(TAG, "加密存储不可用，apiKey 降级为明文存储", error)
        null
    }

    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        // 流式回复要长读：模型慢慢吐字的整段时间都在这条连接上。
        .readTimeout(120, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .build()

    private val inFlight = AtomicBoolean(false)

    @Volatile var state: State = State.IDLE
        private set

    /** 有一轮流式请求在途（此时新的 send 会被拒，调用方据此提示「稍等一下」）。 */
    val isBusy: Boolean
        get() = inFlight.get()

    @Volatile var protocolSupported: Boolean = true
        private set

    // 会话历史：内存镜像 + JSONL 落盘。**文件是唯一事实源**，每次发送前重读
    //（见 loadHistoryFromDisk），所以内存这份只是当前请求的视图，不是权威状态。
    private val history = mutableListOf<Turn>()

    // ---------- 配置快照 ----------

    /**
     * 写入配置快照（由 JS 经 writeOverlayConfig 调用）。
     *
     * **安全**：apiKey 被抽到 EncryptedSharedPreferences，其余字段才写普通 prefs——
     * 落盘的 prefs/config 文件里永远不会有明文密钥。
     *
     * @return 是否成功解析并落盘（false = JSON 非法或缺 endpoint，调用方不应认为大脑可用）
     */
    fun saveConfig(json: String): Boolean {
        val config = try {
            parseConfig(json)
        } catch (error: Exception) {
            Log.w(TAG, "overlay config parse failed: ${error.message}")
            null
        } ?: return false
        prefs.edit()
            .putString(KEY_BASE_URL, config.baseUrl)
            .putString(KEY_MODEL, config.model)
            .putString(KEY_PROTOCOL, config.protocol)
            .putString(KEY_FALLBACKS, config.fallbacks.joinToString("\u0001"))
            .putString(KEY_VISION, if (config.vision) "1" else "0")
            .putString(KEY_PERSONA_NAME, config.personaName)
            .putString(KEY_SYSTEM_PROMPT, config.systemPrompt)
            .putString(KEY_LOCALE, config.locale)
            .putString(KEY_ASR_PROVIDER, config.asrProvider)
            .putString(KEY_ASR_BASE_URL, config.asrBaseUrl)
            .putString(KEY_ASR_MODEL, config.asrModel)
            .putString(KEY_TTS_ENABLED, if (config.ttsEnabled) "1" else "0")
            .apply()
        // apiKey：优先加密存储；写成功后删掉明文（迁移清理，与 ProactiveCore 同款）。
        if (writeSecretApiKey(config.apiKey)) {
            prefs.edit().remove(KEY_API_KEY).apply()
        } else {
            prefs.edit().putString(KEY_API_KEY, config.apiKey).apply()
        }
        // M3 耳朵：ASR 配置与大脑同批落盘（另一个 apiKey，同样走加密区）。
        if (writeSecretAsrKey(config.asrApiKey)) {
            prefs.edit().remove(KEY_ASR_API_KEY).apply()
        } else {
            prefs.edit().putString(KEY_ASR_API_KEY, config.asrApiKey).apply()
        }
        return true
    }

    /**
     * 读取 ASR 配置（M3 耳朵）。供 OverlayService 在「说话」时决定走云端还是系统识别。
     * provider 非 cloud 或字段不全时返回 null——调用方据此退回系统识别。
     */
    fun loadAsrConfig(): AsrConfig? {
        val provider = prefs.getString(KEY_ASR_PROVIDER, "system") ?: "system"
        return AsrConfig(
            provider = provider,
            baseUrl = prefs.getString(KEY_ASR_BASE_URL, "") ?: "",
            apiKey = readSecretAsrKey() ?: prefs.getString(KEY_ASR_API_KEY, "") ?: "",
            model = prefs.getString(KEY_ASR_MODEL, "") ?: "",
        )
    }

    fun hasConfig(): Boolean = loadConfig() != null

    fun loadConfig(): Config? {
        val baseUrl = prefs.getString(KEY_BASE_URL, null) ?: return null
        val model = prefs.getString(KEY_MODEL, null) ?: return null
        val key = readSecretApiKey() ?: prefs.getString(KEY_API_KEY, "") ?: ""
        return Config(
            baseUrl = baseUrl,
            apiKey = key,
            model = model,
            fallbacks = (prefs.getString(KEY_FALLBACKS, "") ?: "")
                .split('\u0001').filter { it.isNotBlank() },
            protocol = prefs.getString(KEY_PROTOCOL, "openai") ?: "openai",
            vision = prefs.getString(KEY_VISION, "0") == "1",
            personaName = prefs.getString(KEY_PERSONA_NAME, "") ?: "",
            systemPrompt = prefs.getString(KEY_SYSTEM_PROMPT, "") ?: "",
            locale = prefs.getString(KEY_LOCALE, "zh-CN") ?: "zh-CN",
            // M4.1 嘴巴：播报开关（原生只实现系统 TTS，见 Config 注释）。
            ttsEnabled = prefs.getString(KEY_TTS_ENABLED, "0") == "1",
        )
    }

    private fun parseConfig(json: String): Config {
        val root = JSONObject(json)
        val endpoint = root.optJSONObject("endpoint")
            ?: throw IllegalArgumentException("snapshot 缺 endpoint")
        val caps = root.optJSONObject("capabilities") ?: JSONObject()
        val persona = root.optJSONObject("persona") ?: JSONObject()
        val asr = root.optJSONObject("asr") ?: JSONObject()
        val fallbacks = mutableListOf<String>()
        endpoint.optJSONArray("fallbacks")?.let { array ->
            for (i in 0 until array.length()) {
                val item = array.optString(i).trim()
                if (item.isNotEmpty()) fallbacks.add(item)
            }
        }
        return Config(
            baseUrl = endpoint.optString("baseUrl").trim(),
            apiKey = endpoint.optString("apiKey"),
            model = endpoint.optString("model").trim(),
            fallbacks = fallbacks,
            protocol = endpoint.optString("protocol", "openai"),
            vision = caps.optBoolean("vision", false),
            personaName = persona.optString("name", ""),
            systemPrompt = persona.optString("systemPrompt", ""),
            locale = root.optString("locale", "zh-CN"),
            // M3 耳朵：provider 缺省 system（走系统识别兜底），与 JS 侧默认一致。
            asrProvider = asr.optString("provider", "system"),
            asrBaseUrl = asr.optString("baseUrl", ""),
            asrApiKey = asr.optString("apiKey", ""),
            asrModel = asr.optString("model", ""),
            ttsEnabled = root.optJSONObject("tts")?.optBoolean("enabled", false) ?: false,
        )
    }

    /** 写入加密存储；成功返回 true，加密不可用或抛错返回 false（调用方降级明文）。 */
    private fun writeSecretApiKey(value: String): Boolean {
        val encrypted = secretPrefs ?: return false
        return try {
            encrypted.edit().putString(KEY_API_KEY, value).apply()
            true
        } catch (error: Exception) {
            Log.w(TAG, "apiKey 写入加密存储失败，降级明文", error)
            false
        }
    }

    /** 读取加密存储中的 apiKey；无值/不可用/抛错返回 null（调用方回退明文区）。 */
    private fun readSecretApiKey(): String? {
        val encrypted = secretPrefs ?: return null
        return try {
            encrypted.getString(KEY_API_KEY, null)
        } catch (error: Exception) {
            Log.w(TAG, "apiKey 读取加密存储失败，回退明文", error)
            null
        }
    }

    /** ASR 的 apiKey 单独一个键（与聊天 key 分开存：两者常是不同服务商的密钥）。 */
    private fun writeSecretAsrKey(value: String): Boolean {
        val encrypted = secretPrefs ?: return false
        return try {
            encrypted.edit().putString(KEY_ASR_API_KEY, value).apply()
            true
        } catch (error: Exception) {
            Log.w(TAG, "asrKey 写入加密存储失败，降级明文", error)
            false
        }
    }

    private fun readSecretAsrKey(): String? {
        val encrypted = secretPrefs ?: return null
        return try {
            encrypted.getString(KEY_ASR_API_KEY, null)
        } catch (error: Exception) {
            Log.w(TAG, "asrKey 读取加密存储失败，回退明文", error)
            null
        }
    }

    // ---------- 会话历史（JSONL） ----------

    private fun historyFile(): File = File(appContext.filesDir, "screen-watch/overlay-thread.jsonl")

    /** 归档分片：overlay-thread-1.jsonl、overlay-thread-2.jsonl…（与 JS 侧读入器同名模式）。 */
    private fun historyDir(): File = File(appContext.filesDir, "screen-watch")

    /**
     * 写满就滚动归档（M4.3，设计 3.7 尾部）。
     *
     * 为什么必须归档：这是**追加型**文件，悬浮窗长期使用会无限增长；而每次发送前都要
     * 整份读回来（文件=唯一事实源），行数无上限会让读取与内存同步变慢。
     *
     * 判据用**行数**而不是字节：读入器按行解析，行数才对应它的成本。
     * 归档后当前文件清空、旧内容留在 `overlay-thread-<n>.jsonl` ——
     * JS 侧的读入器已按 `overlay-thread(-\d+)?\.jsonl` 匹配并全部分片合并，
     * 所以归档对「app 内能看到完整对话」是透明的（不会丢历史）。
     */
    private fun rotateIfNeeded() {
        try {
            val file = historyFile()
            if (!file.exists()) return
            val lines = file.readLines()
            if (lines.size < ROTATE_LINE_THRESHOLD) return
            // 分片号取「已有分片的最大值 + 1」：不用时间戳，保证按文件名排序即时间顺序
            //（JS 读入器就是按名字排序后再按 ms 归并的）。
            val existing = historyDir().listFiles()
                ?.mapNotNull { it.name.matchResult(ROTATE_PATTERN) }
                ?.maxOrNull() ?: 0
            val target = File(historyDir(), "overlay-thread-${existing + 1}.jsonl")
            // 先写分片再清空当前文件：中途失败时宁可重复（读入器按 id 去重）
            // 也不能丢（丢失是不可逆的）。
            target.writeText(lines.joinToString("\n", postfix = "\n"), Charsets.UTF_8)
            file.writeText("", Charsets.UTF_8)
            ScreenOverlayModule.recordTrace("thread-rotated", "lines=${lines.size} -> ${target.name}")
        } catch (error: Exception) {
            Log.w(TAG, "rotate thread log failed: ${error.message}")
        }
    }

    /** 从 `overlay-thread-3.jsonl` 里取出 3；不匹配返回 null。 */
    private fun String.matchResult(pattern: Regex): Int? =
        pattern.matchEntire(this)?.groupValues?.getOrNull(1)?.toIntOrNull()

    /** JSONL 一行一条；图片另存同目录文件、这里只记文件名。 */
    private fun appendTurnToDisk(turn: Turn) {
        try {
            val file = historyFile()
            file.parentFile?.mkdirs()
            // M4.3：写入前先看是否该归档（读一次行数，成本远低于它带来的好处）。
            rotateIfNeeded()
            val now = System.currentTimeMillis()
            val stamp = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ssZ", Locale.US).format(Date(now))
            val entry = JSONObject()
                .put("t", stamp)
                // 毫秒时间戳：JS 侧按时间线合并时直接用，不必解析本地化时间串（跨端更稳）。
                .put("ms", now)
                .put("role", turn.role)
                .put("text", turn.text)
                // 人设名：切换角色后按它过滤，避免把上一个角色的对话带进新角色（M2.5）。
                .put("persona", currentPersonaName())
            if (turn.imageFile.isNotBlank()) entry.put("image", turn.imageFile)
            // 单行 + O_APPEND：一行足够小（<4KB 截断后）在 ext4/f2fs 上是原子追加，
            // 两个写入方（原生 / JS 续聊）不会把行写花。
            FileOutputStream(file, true).use { stream ->
                stream.write((entry.toString() + "\n").toByteArray(Charsets.UTF_8))
            }
        } catch (error: Exception) {
            Log.w(TAG, "append turn failed: ${error.message}")
        }
    }

    private fun currentPersonaName(): String = prefs.getString(KEY_PERSONA_NAME, "") ?: ""

    /** 读回 JSONL；坏行跳过，不让一行脏数据废掉整场对话。 */
    private fun loadHistoryFromDisk() {
        // 每次发送都重读：文件是**唯一事实源**——这样 app 内续聊写进来的轮次
        //（经 appendExternalTurn）下一轮就能被大脑看见，且不会重复计数。
        history.clear()
        val persona = currentPersonaName()
        try {
            val file = historyFile()
            if (!file.exists()) return
            file.readLines().forEach { line ->
                if (line.isBlank()) return@forEach
                try {
                    val obj = JSONObject(line)
                    // 切换角色后不把另一个角色的对话带进请求；旧版本无 persona 字段视为通用。
                    val linePersona = obj.optString("persona", "").trim()
                    if (persona.isNotEmpty() && linePersona.isNotEmpty() && linePersona != persona) {
                        return@forEach
                    }
                    val role = obj.optString("role", "assistant")
                    val text = obj.optString("text", "")
                    if (text.isNotBlank()) history.add(Turn(role, text))
                } catch (error: Exception) {
                    Log.w(TAG, "skip bad jsonl line: ${error.message}")
                }
            }
            while (history.size > HISTORY_DISK_MAX) history.removeAt(0)
        } catch (error: Exception) {
            Log.w(TAG, "load history failed: ${error.message}")
        }
    }

    /**
     * 供 app 内管线写一轮进**同一份**对话日志（M2.5 双写）。
     *
     * 设计文档 3.7 的风险表要求「JS 续聊后把后续轮次也 append 进同一文件」——
     * 由原生代写（格式与大脑一致，JS 不必复刻 JSONL 结构）。大脑每次发送都重读该文件，
     * 所以下一轮就能看见 app 里续聊的内容。
     */
    fun appendExternalTurn(role: String, text: String) {
        val value = text.trim()
        if (value.isEmpty()) return
        val normalized = if (role == "user") "user" else "assistant"
        appendTurnToDisk(Turn(normalized, value))
    }

    // ---------- 发送 ----------

    /**
     * 发一轮对话（流式）。
     *
     * @param userText 用户输入（非空）
     * @param imageBase64 可选：截屏 JPEG 的 base64（M3 接入）；模型不识图时会被忽略并提示
     * @param onDelta 流式增量（已在调用方需要的线程上回调——OkHttp 回调线程）
     * @param onDone 完整回复（流结束后，含全部增量拼接）
     * @param onError 失败原因（用户可读，已按 3.2 分流）
     * @return false = 忙碌中/无配置/协议不支持，本次未发起（调用方据此走回退或提示）
     */
    fun send(
        userText: String,
        imageBase64: String? = null,
        onDelta: (String) -> Unit,
        onDone: (String) -> Unit,
        onError: (String) -> Unit,
    ): Boolean {
        val text = userText.trim()
        if (text.isEmpty()) return false
        if (!inFlight.compareAndSet(false, true)) return false
        val config = loadConfig()
        if (config == null) {
            inFlight.set(false)
            return false
        }
        if (!config.protocolSupported) {
            inFlight.set(false)
            protocolSupported = false
            onError("当前协议需在 App 内使用")
            return true
        }
        protocolSupported = true
        state = State.THINKING
        loadHistoryFromDisk()

        // 用户轮先留档（发失败也是说过的话，JSONL 照记——与聊天软件语义一致）。
        appendTurnToDisk(Turn("user", text))
        history.add(Turn("user", text))

        // 模型不识图：不发图，气泡如实提示（设计文档 3.2）。
        val attachImage = imageBase64 != null && config.vision

        val chain = listOf(config.model) + config.fallbacks
        sendWithFallback(config, chain, 0, text, if (attachImage) imageBase64 else null,
            onDelta, onDone, onError)
        return true
    }

    /**
     * 按模型链逐个尝试（主模型 → fallbacks，每个一次）。
     *
     * 为什么是具名函数而不是自引用 lambda：Kotlin 不允许局部 `val` 在**自己的初始化器**
     * 里被引用（`Variable 'attempt' must be initialized`），而重试恰恰要在回调里再次发起
     * 下一轮——具名函数天然支持递归。
     */
    private fun sendWithFallback(
        config: Config,
        chain: List<String>,
        index: Int,
        userText: String,
        imageBase64: String?,
        onDelta: (String) -> Unit,
        onDone: (String) -> Unit,
        onError: (String) -> Unit,
    ) {
        if (index >= chain.size) {
            inFlight.set(false)
            state = State.IDLE
            onError("模型无响应，请稍后再试或到 App 内检查网络配置")
            return
        }
        streamOnce(config, chain[index], userText, imageBase64, onDelta, onDone,
            onRetry = { sendWithFallback(config, chain, index + 1, userText, imageBase64, onDelta, onDone, onError) },
            onFail = {
                inFlight.set(false)
                state = State.IDLE
                onError(it)
            })
    }

    /**
     * 单次流式请求。可重试的失败（429/5xx/超时）走 [onRetry]，终态失败走 [onFail]。
     */
    private fun streamOnce(
        config: Config,
        model: String,
        userText: String,
        imageBase64: String?,
        onDelta: (String) -> Unit,
        onDone: (String) -> Unit,
        onRetry: () -> Unit,
        onFail: (String) -> Unit,
    ) {
        // M4.4：原生大脑的链路打点（stage: request / first-byte / done / fail）。
        // 与 M1 的采集打点同一通道（OverlayService.EVENT_TRACE → JS 诊断日志），
        // 于是「悬浮窗聊天没反应」也能像「截屏一直等」那样事后定位卡在哪一环。
        val startedAt = System.currentTimeMillis()
        var firstByteAt = 0L
        ScreenOverlayModule.recordTrace("brain-request", "model=$model vision=${imageBase64 != null}")
        val body = buildRequestBody(config, model, userText, imageBase64)
        val request = Request.Builder()
            .url(config.baseUrl.trimEnd('/') + "/chat/completions")
            .header("Authorization", "Bearer " + config.apiKey)
            .header("Content-Type", "application/json")
            .post(body.toRequestBody(JSON_MEDIA))
            .build()
        client.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, error: IOException) {
                Log.w(TAG, "stream failed: ${error.message}")
                ScreenOverlayModule.recordTrace(
                    "brain-fail",
                    "network ${System.currentTimeMillis() - startedAt}ms ${error.javaClass.simpleName}"
                )
                onRetry()
            }

            override fun onResponse(call: Call, response: okhttp3.Response) {
                response.use { resp ->
                    if (!resp.isSuccessful) {
                        // 429/5xx 换下一个模型重试；4xx（密钥/模型名错误）不重试——
                        // 重试只会得到同样的拒绝，还多烧一次配额。
                        if (resp.code == 429 || resp.code >= 500) {
                            ScreenOverlayModule.recordTrace("brain-fail", "http ${resp.code} retry")
                            onRetry()
                        } else {
                            ScreenOverlayModule.recordTrace("brain-fail", "http ${resp.code} fatal")
                            onFail("请求失败（HTTP ${resp.code}），请检查密钥或模型名")
                        }
                        return
                    }
                    val source = try {
                        resp.body?.source()
                    } catch (error: Exception) {
                        null
                    }
                    if (source == null) {
                        ScreenOverlayModule.recordTrace("brain-fail", "no-body")
                        onRetry()
                        return
                    }
                    state = State.STREAMING
                    val full = StringBuilder()
                    try {
                        while (true) {
                            val line = source.readUtf8Line() ?: break
                            if (!line.startsWith("data:")) continue
                            val payload = line.removePrefix("data:").trim()
                            if (payload == "[DONE]") break
                            val delta = try {
                                JSONObject(payload).optJSONArray("choices")
                                    ?.optJSONObject(0)?.optJSONObject("delta")
                                    ?.optString("content").orEmpty()
                            } catch (error: Exception) {
                                ""   // 心跳/注释行解析失败跳过，不让一脏行毁掉整条回复
                            }
                            if (delta.isNotEmpty()) {
                                if (firstByteAt == 0L) {
                                    firstByteAt = System.currentTimeMillis()
                                    ScreenOverlayModule.recordTrace(
                                        "brain-first-byte",
                                        "${firstByteAt - startedAt}ms model=$model"
                                    )
                                }
                                full.append(delta)
                                onDelta(full.toString())
                            }
                        }
                    } catch (error: Exception) {
                        Log.w(TAG, "stream read failed: ${error.message}")
                        // 已经吐出去的增量不撤回；把已收到的部分当完整回复交付，
                        // 免得用户因为断流而一无所有。
                        if (full.isNotEmpty()) {
                            ScreenOverlayModule.recordTrace(
                                "brain-done",
                                "partial ${System.currentTimeMillis() - startedAt}ms chars=${full.length}"
                            )
                            appendTurnToDisk(Turn("assistant", full.toString()))
                            history.add(Turn("assistant", full.toString()))
                            onDone(full.toString())
                        } else {
                            ScreenOverlayModule.recordTrace("brain-fail", "stream-read ${error.javaClass.simpleName}")
                            onRetry()
                        }
                        return
                    }
                    val reply = full.toString().trim()
                    if (reply.isEmpty()) {
                        ScreenOverlayModule.recordTrace("brain-fail", "empty-reply")
                        onFail("模型返回了空回复")
                        return
                    }
                    ScreenOverlayModule.recordTrace(
                        "brain-done",
                        "${System.currentTimeMillis() - startedAt}ms first=${if (firstByteAt == 0L) -1 else firstByteAt - startedAt}ms chars=${reply.length}"
                    )
                    appendTurnToDisk(Turn("assistant", reply))
                    history.add(Turn("assistant", reply))
                    while (history.size > HISTORY_DISK_MAX) history.removeAt(0)
                    state = State.IDLE
                    inFlight.set(false)
                    onDone(reply)
                }
            }
        })
    }

    /** 组 OpenAI 兼容请求体：system + 最近 HISTORY_MAX 轮 + 本轮用户（可含图片 part）。 */
    private fun buildRequestBody(config: Config, model: String, userText: String, imageBase64: String?): String {
        val messages = JSONArray()
        val systemPrompt = buildString {
            append(config.systemPrompt)
            if (isNotBlank()) append("\n\n")
            append("你和用户正在一起看屏幕（悬浮窗模式）。请用简短、口语化的中文回复，")
            append("不要输出 Markdown 或代码块，直接输出要说的话。")
        }
        messages.put(JSONObject().put("role", "system").put("content", systemPrompt))
        // 最近 HISTORY_MAX 轮（不含本轮）
        val recent = history.takeLast(HISTORY_MAX)
        for (turn in recent) {
            messages.put(JSONObject().put("role", turn.role).put("content", turn.text))
        }
        val userContent: Any = if (imageBase64 != null) {
            JSONArray().put(JSONObject().put("type", "text").put("text", userText))
                .put(JSONObject().put("type", "image_url").put(
                    "image_url", JSONObject().put("url", "data:image/jpeg;base64," + imageBase64)
                ))
        } else {
            userText
        }
        messages.put(JSONObject().put("role", "user").put("content", userContent))
        return JSONObject()
            .put("model", model)
            .put("messages", messages)
            .put("stream", true)
            .toString()
    }

    companion object {
        private const val TAG = "OverlayBrain"
        private const val PREFS = "screen_overlay_brain_prefs"
        private const val SECRET_PREFS = "screen_overlay_brain_secrets"
        private const val KEY_BASE_URL = "base_url"
        private const val KEY_API_KEY = "api_key"
        private const val KEY_MODEL = "model"
        private const val KEY_PROTOCOL = "protocol"
        private const val KEY_FALLBACKS = "fallbacks"
        private const val KEY_VISION = "vision"
        private const val KEY_PERSONA_NAME = "persona_name"
        private const val KEY_SYSTEM_PROMPT = "system_prompt"
        private const val KEY_LOCALE = "locale"
        // M3 耳朵：ASR 配置（apiKey 同样只进加密区，明文键只作降级兜底）。
        private const val KEY_ASR_PROVIDER = "asr_provider"
        private const val KEY_ASR_BASE_URL = "asr_base_url"
        private const val KEY_ASR_MODEL = "asr_model"
        private const val KEY_ASR_API_KEY = "asr_api_key"
        // M4.1 嘴巴：系统 TTS 播报开关。
        private const val KEY_TTS_ENABLED = "tts_enabled"
        // 请求里带的历史轮数（设计文档 3.2：截断至最近 12 轮）。
        private const val HISTORY_MAX = 12
        // 内存/JSONL 里保留的轮数上限（防长会话把内存撑爆）。
        private const val HISTORY_DISK_MAX = 200
        // M4.3 归档阈值：当前分片超过这么多行就滚动切到 overlay-thread-<n>.jsonl。
        // 取 500 与设计文档 3.7 的「超过 500 行滚动切分」一致。
        private const val ROTATE_LINE_THRESHOLD = 500
        private val ROTATE_PATTERN = Regex("""overlay-thread-(\d+)\.jsonl""")
        private val JSON_MEDIA = "application/json; charset=utf-8".toMediaType()

        @Volatile private var instance: OverlayBrain? = null

        /** 进程级单例（同进程，与 OverlayService/ScreenOverlayModule 共享静态即可达）。 */
        fun get(context: Context): OverlayBrain =
            instance ?: synchronized(this) {
                instance ?: OverlayBrain(context.applicationContext).also { instance = it }
            }
    }
}
