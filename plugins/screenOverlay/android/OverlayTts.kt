package com.pppxxxy.easychat2.screenoverlay

import android.content.Context
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Log
import java.util.Locale
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 悬浮窗的 TTS 播报（M4.1 嘴巴）。
 *
 * **只做系统 TTS**（Android 内置引擎）。云端 TTS 不在原生实现——各家服务商的
 * 请求体声明表在 JS 侧（src/tts/providers.js，560+ 行：鉴权方式、字段路径、
 * hex/base64/binary 三种响应形态、火山/讯飞/腾讯各自的签名规则），
 * 在原生复刻必然漂移。所以：云端 TTS 在 app 内可用，悬浮窗用系统引擎。
 * 这与设计文档「原生只做 OpenAI 兼容一种协议、纯对话一种场景」同一取舍。
 *
 * 音频焦点：说话时先请求焦点（TTS 本身会做），但**录音期间必须暂停播报**
 * ——否则麦克风会把自己的播报录进去（回声/自问自答），设计文档 3.3 明确要求。
 *
 * ⚠️ 未在本地核实：沙箱无 Android SDK / Java，本文件无法编译或运行验证。
 * TextToSpeech 的引擎可用性（部分 ROM 无中文引擎）需真机验证。
 */
class OverlayTts(private val context: Context) {

    private var engine: TextToSpeech? = null
    private val ready = AtomicBoolean(false)
    @Volatile private var pendingText: String? = null
    @Volatile private var onDoneCallback: (() -> Unit)? = null

    /** 初始化（异步）。重复调用是安全的：已初始化则直接返回。 */
    fun init() {
        if (engine != null) return
        try {
            engine = TextToSpeech(context) { status ->
                val ok = status == TextToSpeech.SUCCESS
                ready.set(ok)
                if (!ok) {
                    Log.w(TAG, "TextToSpeech init failed: status=$status")
                    return@TextToSpeech
                }
                // 中文：悬浮窗的回复都是中文（提示词也是中文）。引擎不支持时**不改语言**，
                // 让它按默认语言读（英文引擎读中文会念不出来，但至少不崩）；
                // 调用方据 speak() 的返回值给提示。
                try {
                    engine?.language = Locale.SIMPLIFIED_CHINESE
                } catch (error: Exception) {
                    Log.w(TAG, "set language failed: ${error.message}")
                }
                engine?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                    override fun onStart(utteranceId: String?) {}
                    override fun onDone(utteranceId: String?) {
                        onDoneCallback?.invoke()
                        onDoneCallback = null
                    }

                    // ⚠️ UtteranceProgressListener 有**两个** onError 重载，且
                    // `onError(String)` 是 **abstract** 的（API 21 起被标 deprecated，
                    // 但必须实现，否则匿名对象编译不过）。新的带 errorCode 的默认实现
                    // 会转调旧的那个，所以两个都要有——这不是「同一个函数写了两遍」。
                    @Deprecated("Deprecated in Java")
                    override fun onError(utteranceId: String?) {
                        Log.w(TAG, "utterance error")
                        onDoneCallback = null
                    }

                    override fun onError(utteranceId: String?, errorCode: Int) {
                        Log.w(TAG, "utterance error code=$errorCode")
                        onDoneCallback = null
                    }
                })
                // 初始化期间来的播报请求在这里补发（init 是异步的）。
                pendingText?.let { text ->
                    pendingText = null
                    speak(text, null)
                }
            }
        } catch (error: Exception) {
            Log.w(TAG, "TextToSpeech create failed: ${error.message}")
            engine = null
        }
    }

    /**
     * 播报一段文本。返回 false = 引擎不可用（无系统 TTS / 初始化失败），
     * 调用方据此**在气泡里如实提示**而不是静默失败。
     */
    fun speak(text: String, onDone: (() -> Unit)?): Boolean {
        val content = text.trim()
        if (content.isEmpty()) return false
        init()
        val tts = engine ?: return false
        if (!ready.get()) {
            // 还在初始化：挂起这一条，初始化完成后补发（不丢用户的播报请求）。
            pendingText = content
            onDoneCallback = onDone
            return true
        }
        return try {
            onDoneCallback = onDone
            val result = tts.speak(content, TextToSpeech.QUEUE_FLUSH, null, UTTERANCE_ID)
            result == TextToSpeech.SUCCESS
        } catch (error: Exception) {
            Log.w(TAG, "speak failed: ${error.message}")
            onDoneCallback = null
            false
        }
    }

    /** 立刻停止播报（用户开始说话时调用：不能把自己的播报录进麦克风）。 */
    fun stop() {
        try {
            engine?.stop()
        } catch (error: Exception) {}
        onDoneCallback = null
        pendingText = null
    }

    /** 释放引擎（服务销毁）。 */
    fun shutdown() {
        stop()
        try {
            engine?.shutdown()
        } catch (error: Exception) {}
        engine = null
        ready.set(false)
    }

    companion object {
        private const val TAG = "OverlayTts"
        private const val UTTERANCE_ID = "overlay-reply"
    }
}
