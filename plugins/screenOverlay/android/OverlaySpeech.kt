package com.pppxxxy.easychat2.screenoverlay

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.util.Log
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.asRequestBody
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * 悬浮窗的语音识别（M3 耳朵）。
 *
 * 优先级（设计文档 3.3）：
 *   1. 快照里配了云端 ASR（asr.provider == "cloud" 且字段齐全）→ OkHttp 调
 *      OpenAI 兼容 `/audio/transcriptions`（与 app 内语音转文字同口径）；
 *   2. 否则用**系统** SpeechRecognizer（尽量离线）；
 *   3. 都不可用 → 返回失败，由调用方在气泡里如实提示「语音识别不可用，请用文字输入」。
 *
 * 为什么不用系统识别做首选：国产 ROM 上 SpeechRecognizer 的可用性很差
 *（有的没装识别服务、有的必须联网、有的直接返回 ERROR_CLIENT），
 * 设计文档的风险表已如实声明这一点，所以系统只做兜底。
 *
 * ⚠️ 未在本地核实：沙箱无 Android SDK / Java，本文件无法编译或运行验证。
 * SpeechRecognizer 的 ROM 差异、云端 ASR 的响应字段形态都需真机验证。
 */
class OverlaySpeech(private val context: Context) {

    /** 识别结果：成功给 text；失败给可读原因（调用方直接展示，不吞掉）。 */
    data class Result(val text: String, val error: String) {
        val ok: Boolean get() = error.isEmpty() && text.isNotEmpty()
    }

    /** ASR 配置（由 OverlayBrain 的配置快照提供）。 */
    data class AsrConfig(
        val provider: String,
        val baseUrl: String,
        val apiKey: String,
        val model: String,
    ) {
        val cloudUsable: Boolean
            get() = provider == "cloud" && baseUrl.isNotBlank() && apiKey.isNotBlank() && model.isNotBlank()
    }

    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)   // 上传音频 + 识别，给足时间
        .writeTimeout(60, TimeUnit.SECONDS)
        .build()

    /**
     * 识别一个 WAV 文件。**必须在工作线程调用**（网络/系统识别都是阻塞的）。
     *
     * @param config 快照里的 ASR 配置（可为 null → 直接走系统识别）
     */
    fun transcribe(file: File, config: AsrConfig?, onDone: (Result) -> Unit) {
        if (!file.exists() || file.length() <= 44) {
            // 44 字节 = 只有 WAV 头、没有音频数据
            onDone(Result("", "没有录到声音"))
            return
        }
        if (config != null && config.cloudUsable) {
            transcribeCloud(file, config) { result ->
                // 云端失败**不**直接放弃：退回系统识别再试一次（多一条可用路径）。
                if (result.ok) onDone(result) else transcribeSystem(onDone)
            }
            return
        }
        transcribeSystem(onDone)
    }

    private fun transcribeCloud(file: File, config: AsrConfig, onDone: (Result) -> Unit) {
        try {
            val body = MultipartBody.Builder()
                .setType(MultipartBody.FORM)
                .addFormDataPart("model", config.model)
                .addFormDataPart("file", file.name, file.asRequestBody("audio/wav".toMediaType()))
                .build()
            val request = Request.Builder()
                .url(config.baseUrl.trimEnd('/') + "/audio/transcriptions")
                .header("Authorization", "Bearer " + config.apiKey)
                .post(body)
                .build()
            client.newCall(request).enqueue(object : Callback {
                override fun onFailure(call: Call, error: IOException) {
                    Log.w(TAG, "cloud asr failed: ${error.message}")
                    onDone(Result("", "云端语音识别失败"))
                }

                override fun onResponse(call: Call, response: okhttp3.Response) {
                    response.use { resp ->
                        if (!resp.isSuccessful) {
                            Log.w(TAG, "cloud asr HTTP ${resp.code}")
                            onDone(Result("", "云端语音识别失败（HTTP ${resp.code}）"))
                            return
                        }
                        val text = try {
                            JSONObject(resp.body?.string().orEmpty()).optString("text", "").trim()
                        } catch (error: Exception) {
                            ""
                        }
                        onDone(if (text.isEmpty()) Result("", "没有识别出内容") else Result(text, ""))
                    }
                }
            })
        } catch (error: Exception) {
            Log.w(TAG, "cloud asr exception: ${error.message}")
            onDone(Result("", "云端语音识别失败"))
        }
    }

    /**
     * 系统 SpeechRecognizer（兜底）。
     *
     * 注意它**不直接吃 WAV 文件**——它是「实时听麦克风」的 API。所以这里不是把文件喂给它，
     * 而是重新开一次系统识别会话。这看起来像绕路，但它是系统唯一的离线兜底路径；
     * 真机上若这条也不可用，用户会看到「语音识别不可用，请用文字输入」。
     *
     * ⚠️ 未核实：SpeechRecognizer.isRecognitionAvailable 在各 ROM 上的可信度。
     */
    private fun transcribeSystem(onDone: (Result) -> Unit) {
        if (!SpeechRecognizer.isRecognitionAvailable(context)) {
            onDone(Result("", "语音识别不可用，请用文字输入"))
            return
        }
        // 回调可能多次触发（onResults / onError）：用一次性标记保证只结算一次，
        // 否则会同时出现「识别结果」与「识别失败」两条气泡。
        var settled = false
        val recognizer = try {
            SpeechRecognizer.createSpeechRecognizer(context)
        } catch (error: Exception) {
            Log.w(TAG, "createSpeechRecognizer failed: ${error.message}")
            null
        }
        if (recognizer == null) {
            onDone(Result("", "语音识别不可用，请用文字输入"))
            return
        }
        val finish = { result: Result ->
            if (!settled) {
                settled = true
                try {
                    recognizer.destroy()
                } catch (error: Exception) {}
                onDone(result)
            }
        }
        recognizer.setRecognitionListener(object : RecognitionListener {
            override fun onResults(results: Bundle?) {
                val list = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                val text = list?.firstOrNull()?.trim().orEmpty()
                finish(if (text.isEmpty()) Result("", "没有识别出内容") else Result(text, ""))
            }

            override fun onError(error: Int) {
                Log.w(TAG, "system asr error code=$error")
                finish(Result("", "语音识别不可用，请用文字输入"))
            }

            override fun onReadyForSpeech(params: Bundle?) {}
            override fun onBeginningOfSpeech() {}
            override fun onRmsChanged(rmsdB: Float) {}
            override fun onBufferReceived(buffer: ByteArray?) {}
            override fun onEndOfSpeech() {}
            override fun onPartialResults(partialResults: Bundle?) {}
            override fun onEvent(eventType: Int, params: Bundle?) {}
        })
        try {
            val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                // 尽量离线：国产 ROM 上联网识别常被限制，离线优先反而更稳。
                putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
                putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
            }
            recognizer.startListening(intent)
        } catch (error: Exception) {
            Log.w(TAG, "startListening failed: ${error.message}")
            finish(Result("", "语音识别不可用，请用文字输入"))
        }
    }

    companion object {
        private const val TAG = "OverlaySpeech"
    }
}
