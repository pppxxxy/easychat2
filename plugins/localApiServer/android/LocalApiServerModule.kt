package com.pppxxxy.easychat2.localapi

import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import fi.iki.elonen.NanoHTTPD
import fi.iki.elonen.NanoHTTPD.IHTTPSession
import fi.iki.elonen.NanoHTTPD.Method
import fi.iki.elonen.NanoHTTPD.Response
import org.json.JSONArray
import org.json.JSONObject
import java.io.PipedInputStream
import java.io.PipedOutputStream
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * 本地 OpenAI 兼容 HTTP 服务（Kotlin 侧）。
 *
 * 推理复用 JS/JSI 侧已加载的 llama 上下文：原生只负责 HTTP 与协议，收到
 * `/v1/chat/completions` 后通过 `LocalApiServer:onRequest` 事件把请求（JSON 字符串）
 * 发给 JS，JS 用常驻 adapter 推理后调 `respond(requestId, json)` 回写，原生再组装响应。
 * 数组/对象跨桥不可靠，事件与回写统一用 JSON 字符串契约。
 *
 * v5 Stage D：
 * - GET /v1/models 返回 start 时下发的全部已安装条目（modelsJson），而非单一 modelId；
 * - POST /v1/chat/completions 请求体 stream=true 时用 chunked 响应 + PipedOutputStream，
 *   JS 逐片 respondStream 写入 SSE，写完 done=true 关闭（真流式，不再整段回包）；
 * - 请求体的 model 字段由 JS 侧匹配/临时加载（原生不复制模型管理逻辑）。
 *
 * 仅绑定 127.0.0.1；鉴权强制：apiKey 为空时自动生成随机密钥（绝不放行匿名请求），
 * 回显在启动结果里供 JS 展示；比较用恒定时间，Bearer 前缀严格校验。
 */
class LocalApiServerModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName() = "LocalApiServer"

    private val pending = ConcurrentHashMap<String, PendingRequest>()
    private var server: ApiServer? = null
    // 鉴权与模型名挂在模块（外层）上：handle/checkAuth 等都是外层方法，
    // Kotlin 外层类访问不到 inner 类的构造属性，放 inner 会 Unresolved reference。
    private var apiKey: String = ""
    private var modelId: String = "local-model"
    // 已安装模型条目（JSON 数组字符串），start 时由 JS 下发，供 /v1/models 全量返回。
    private var modelsJson: String = "[]"

    private class PendingRequest {
        val latch = CountDownLatch(1)

        @Volatile
        var responseJson: String? = null

        // 流式响应：JS 经 respondStream 写入，原生 chunked 泵读。非流式请求为 null。
        @Volatile
        var streamOut: PipedOutputStream? = null
    }

    private inner class ApiServer(host: String, port: Int) :
        NanoHTTPD(host, port) {
        override fun serve(session: IHTTPSession): Response = handle(session)
    }

    private fun jsonResponse(status: Response.Status, body: String): Response =
        NanoHTTPD.newFixedLengthResponse(status, "application/json", body)

    private fun unauthorized(): Response = jsonResponse(
        Response.Status.UNAUTHORIZED,
        "{\"error\":{\"message\":\"invalid api key\",\"type\":\"invalid_request_error\"}}"
    )

    private fun checkAuth(session: IHTTPSession): Boolean {
        // 免鉴权放行已移除：同机其它应用可达回环端口，匿名放行等于把推理
        // （连带已加载模型与上下文）开放给任意本机 App。start() 保证密钥非空，
        // 这里对空密钥直接拒绝作为双保险。
        val expected = apiKey
        if (expected.isEmpty()) return false
        val header = session.headers["authorization"] ?: return false
        // 严格 Bearer 方案：<scheme> 空格 <token>，scheme 大小写不敏感（RFC 7235）。
        val separator = header.indexOf(' ')
        if (separator <= 0) return false
        val scheme = header.substring(0, separator).trim()
        if (!scheme.equals("bearer", ignoreCase = true)) return false
        val token = header.substring(separator + 1).trim()
        if (token.isEmpty()) return false
        // 恒定时间比较：本机攻击面下计时侧信道价值有限，但成本为零。
        return MessageDigest.isEqual(
            expected.toByteArray(Charsets.UTF_8),
            token.toByteArray(Charsets.UTF_8)
        )
    }

    private fun handle(session: IHTTPSession): Response {
        val uri = session.uri ?: ""
        if (session.method == Method.GET && uri == "/v1/models") {
            if (!checkAuth(session)) return unauthorized()
            return jsonResponse(Response.Status.OK, buildModelsBody())
        }
        if (session.method == Method.POST && uri == "/v1/chat/completions") {
            if (!checkAuth(session)) return unauthorized()
            return try {
                val files = HashMap<String, String>()
                session.parseBody(files)
                handleChat(files["postData"] ?: "{}")
            } catch (error: Exception) {
                jsonResponse(
                    Response.Status.BAD_REQUEST,
                    "{\"error\":{\"message\":\"bad request\",\"type\":\"invalid_request_error\"}}"
                )
            }
        }
        // P3-8：/v1/agent —— 程序化驱动一轮 agent 工具循环（JS 侧跑，原生只转发/回包）。
        if (session.method == Method.POST && uri == "/v1/agent") {
            if (!checkAuth(session)) return unauthorized()
            return try {
                val files = HashMap<String, String>()
                session.parseBody(files)
                handleAgent(files["postData"] ?: "{}")
            } catch (error: Exception) {
                jsonResponse(
                    Response.Status.BAD_REQUEST,
                    "{\"error\":{\"message\":\"bad request\",\"type\":\"invalid_request_error\"}}"
                )
            }
        }
        return jsonResponse(
            Response.Status.NOT_FOUND,
            "{\"error\":{\"message\":\"not found\",\"type\":\"invalid_request_error\"}}"
        )
    }

    // /v1/models：全量已安装条目。modelsJson 为 JS 下发的 JSON 数组字符串；缺失/损坏
    // 时回退为单一 modelId，保证客户端至少能看到当前模型。
    private fun buildModelsBody(): String {
        return try {
            val installed = JSONArray(modelsJson)
            val data = JSONArray()
            for (index in 0 until installed.length()) {
                val entry = installed.optJSONObject(index) ?: continue
                val id = entry.optString("id", "")
                if (id.isEmpty()) continue
                data.put(
                    JSONObject()
                        .put("id", id)
                        .put("object", "model")
                        .put("owned_by", "local")
                )
            }
            if (data.length() == 0) {
                data.put(JSONObject().put("id", modelId).put("object", "model").put("owned_by", "local"))
            }
            JSONObject().put("object", "list").put("data", data).toString()
        } catch (error: Exception) {
            JSONObject()
                .put("object", "list")
                .put("data", JSONArray().put(JSONObject().put("id", modelId).put("object", "model").put("owned_by", "local")))
                .toString()
        }
    }

    private fun handleChat(raw: String): Response {
        val requestId = UUID.randomUUID().toString()
        val entry = PendingRequest()
        val stream = JSONObject(raw).optBoolean("stream", false)
        val payload = JSONObject()
            .put("requestId", requestId)
            .put("path", "/v1/chat/completions")
            .put("body", raw)
        if (stream) {
            // 真流式：建管道，HTTP 线程返回 chunked 响应后由 NanoHTTPD 泵读；
            // JS 经 respondStream 逐片写入，done=true 时关闭管道结束响应。
            val pipeOut = PipedOutputStream()
            entry.streamOut = pipeOut
            pending[requestId] = entry
            emitRequest(payload.toString())
            val source = PipedInputStream(pipeOut, STREAM_PIPE_BUFFER)
            return NanoHTTPD.newChunkedResponse(Response.Status.OK, "text/event-stream", source)
        }
        pending[requestId] = entry
        emitRequest(payload.toString())
        val done = entry.latch.await(REQUEST_TIMEOUT_MS, TimeUnit.MILLISECONDS)
        pending.remove(requestId)
        val responseJson = entry.responseJson
        if (!done || responseJson == null) {
            return jsonResponse(
                Response.Status.REQUEST_TIMEOUT,
                "{\"error\":{\"message\":\"inference timeout\",\"type\":\"server_error\"}}"
            )
        }
        return buildCompletion(responseJson, raw)
    }

    // /v1/agent：把请求体交给 JS 跑一轮 agent 工具循环，JS 回写的 JSON 原样作为响应体
    //（非流式）。响应格式由 JS 侧 agentEndpoint 契约决定（object=agent.run）。
    private fun handleAgent(raw: String): Response {
        val requestId = UUID.randomUUID().toString()
        val entry = PendingRequest()
        val payload = JSONObject()
            .put("requestId", requestId)
            .put("path", "/v1/agent")
            .put("body", raw)
        pending[requestId] = entry
        emitRequest(payload.toString())
        val done = entry.latch.await(REQUEST_TIMEOUT_MS, TimeUnit.MILLISECONDS)
        pending.remove(requestId)
        val responseJson = entry.responseJson
        if (!done || responseJson == null) {
            return jsonResponse(
                Response.Status.REQUEST_TIMEOUT,
                "{\"error\":{\"message\":\"agent timeout\",\"type\":\"server_error\"}}"
            )
        }
        return jsonResponse(Response.Status.OK, responseJson)
    }

    private fun buildCompletion(responseJson: String, raw: String): Response {
        return try {
            val result = JSONObject(responseJson)
            val text = result.optString("text", "")
            val model = result.optString("model", modelId)
            val choices = JSONArray()
            choices.put(
                JSONObject()
                    .put("index", 0)
                    .put("message", JSONObject().put("role", "assistant").put("content", text))
                    .put("finish_reason", "stop")
            )
            val body = JSONObject()
                .put("id", "chatcmpl-local")
                .put("object", "chat.completion")
                .put("model", model)
                .put("choices", choices)
            jsonResponse(Response.Status.OK, body.toString())
        } catch (error: Exception) {
            jsonResponse(
                Response.Status.INTERNAL_ERROR,
                "{\"error\":{\"message\":\"bad response\",\"type\":\"server_error\"}}"
            )
        }
    }

    private fun emitRequest(json: String) {
        reactContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(EVENT_REQUEST, json)
    }

    @ReactMethod
    fun addListener(eventName: String) {}

    @ReactMethod
    fun removeListeners(count: Int) {}

    @ReactMethod
    fun start(host: String, port: Int, apiKey: String, modelId: String, modelsJson: String, promise: Promise) {
        try {
            stopServer()
            // 空密钥不再意味着免鉴权：自动生成随机密钥并回显给 JS（持久化由 JS 侧
            // 决定），保证任何情况下服务都有鉴权。
            val requestedKey = apiKey.trim()
            this.apiKey = if (requestedKey.isEmpty()) generateApiKey() else requestedKey
            this.modelId = modelId
            this.modelsJson = modelsJson
            val next = ApiServer(HOST, port)
            next.start(NanoHTTPD.SOCKET_READ_TIMEOUT, false)
            server = next
            Log.i(TAG, "local api server started on $HOST:$port (auth: ${if (requestedKey.isEmpty()) "generated" else "user"})")
            promise.resolve(statusMap(true, port))
        } catch (error: Exception) {
            promise.reject("LOCAL_API_START_FAILED", error.message, error)
        }
    }

    @ReactMethod
    fun stop(promise: Promise) {
        stopServer()
        promise.resolve(true)
    }

    @ReactMethod
    fun getStatus(promise: Promise) {
        promise.resolve(statusMap(server != null, 0))
    }

    // JS 推理完成后回写：按 requestId 唤醒等待中的 HTTP 线程。
    @ReactMethod
    fun respond(requestId: String, responseJson: String, promise: Promise) {
        val entry = pending[requestId]
        if (entry == null) {
            promise.resolve(false)
            return
        }
        entry.responseJson = responseJson
        entry.latch.countDown()
        promise.resolve(true)
    }

    // 流式回写：把 SSE 文本片段写入管道；done=true 时关闭管道，结束 chunked 响应。
    @ReactMethod
    fun respondStream(requestId: String, sseText: String, done: Boolean, promise: Promise) {
        val entry = pending[requestId]
        val out = entry?.streamOut
        if (out == null) {
            promise.resolve(false)
            return
        }
        try {
            if (sseText.isNotEmpty()) {
                out.write(sseText.toByteArray(Charsets.UTF_8))
                out.flush()
            }
            if (done) {
                out.close()
                pending.remove(requestId)
            }
            promise.resolve(true)
        } catch (error: Exception) {
            pending.remove(requestId)
            promise.reject("LOCAL_API_STREAM_FAILED", error.message, error)
        }
    }

    private fun statusMap(running: Boolean, port: Int): WritableMap {
        val map = Arguments.createMap()
        map.putBoolean("running", running)
        map.putString("host", HOST)
        map.putInt("port", port)
        // 回显生效密钥（含自动生成的）：JS 侧据此展示/持久化，客户端照此携带。
        map.putString("apiKey", apiKey)
        return map
    }

    private fun generateApiKey(): String {
        val bytes = ByteArray(18)
        SecureRandom().nextBytes(bytes)
        return bytes.joinToString("") { "%02x".format(it) }
    }

    private fun stopServer() {
        try {
            server?.stop()
        } catch (error: Exception) {}
        server = null
        // 唤醒等待 JS 回写的 HTTP 线程：只 clear 不 countDown 会让这些线程
        // 一直阻塞到 120s 超时，停止/重启期间空占线程。流式管道也一并关闭。
        pending.values.forEach {
            it.latch.countDown()
            try {
                it.streamOut?.close()
            } catch (error: Exception) {}
        }
        pending.clear()
    }

    // RN 0.81 在实例销毁时调用的是 invalidate()，不再调用 onCatalystInstanceDestroy()。
    // 若把清理只挂在后者，服务端口与监听 socket 在 React 实例销毁后不会停止。
    // 两个都覆写以兼容新旧架构。
    override fun invalidate() {
        stopServer()
        super.invalidate()
    }

    override fun onCatalystInstanceDestroy() {
        stopServer()
        super.onCatalystInstanceDestroy()
    }

    companion object {
        private const val TAG = "LocalApiServer"
        private const val HOST = "127.0.0.1"
        private const val EVENT_REQUEST = "LocalApiServer:onRequest"
        private const val REQUEST_TIMEOUT_MS = 120_000L
        private const val STREAM_PIPE_BUFFER = 64 * 1024
    }
}