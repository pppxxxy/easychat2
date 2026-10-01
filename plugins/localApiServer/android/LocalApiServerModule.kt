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
 * 仅绑定 127.0.0.1，`Bearer` 校验（apiKey 为空时放行）。
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

    private class PendingRequest {
        val latch = CountDownLatch(1)

        @Volatile
        var responseJson: String? = null
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
        val expected = apiKey.trim()
        if (expected.isEmpty()) return true
        val header = session.headers["authorization"] ?: return false
        val token = header.removePrefix("Bearer").removePrefix("bearer").trim()
        return token == expected
    }

    private fun handle(session: IHTTPSession): Response {
        val uri = session.uri ?: ""
        if (session.method == Method.GET && uri == "/v1/models") {
            if (!checkAuth(session)) return unauthorized()
            val data = JSONArray()
            data.put(JSONObject().put("id", modelId).put("object", "model").put("owned_by", "local"))
            val body = JSONObject().put("object", "list").put("data", data)
            return jsonResponse(Response.Status.OK, body.toString())
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
        return jsonResponse(
            Response.Status.NOT_FOUND,
            "{\"error\":{\"message\":\"not found\",\"type\":\"invalid_request_error\"}}"
        )
    }

    private fun handleChat(raw: String): Response {
        val requestId = UUID.randomUUID().toString()
        val entry = PendingRequest()
        pending[requestId] = entry
        val payload = JSONObject()
            .put("requestId", requestId)
            .put("path", "/v1/chat/completions")
            .put("body", raw)
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

    private fun buildCompletion(responseJson: String, raw: String): Response {
        return try {
            val result = JSONObject(responseJson)
            val text = result.optString("text", "")
            val model = result.optString("model", modelId)
            val stream = JSONObject(raw).optBoolean("stream", false)
            if (stream) {
                val chunk = JSONObject()
                    .put("id", "chatcmpl-local")
                    .put("object", "chat.completion.chunk")
                    .put("model", model)
                val choices = JSONArray()
                choices.put(
                    JSONObject()
                        .put("index", 0)
                        .put("delta", JSONObject().put("content", text))
                        .put("finish_reason", "stop")
                )
                chunk.put("choices", choices)
                val sse = "data: $chunk\n\ndata: [DONE]\n\n"
                NanoHTTPD.newFixedLengthResponse(Response.Status.OK, "text/event-stream", sse)
            } else {
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
            }
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
    fun start(host: String, port: Int, apiKey: String, modelId: String, promise: Promise) {
        try {
            stopServer()
            this.apiKey = apiKey
            this.modelId = modelId
            val next = ApiServer(HOST, port)
            next.start(NanoHTTPD.SOCKET_READ_TIMEOUT, false)
            server = next
            Log.i(TAG, "local api server started on $HOST:$port")
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

    private fun statusMap(running: Boolean, port: Int): WritableMap {
        val map = Arguments.createMap()
        map.putBoolean("running", running)
        map.putString("host", HOST)
        map.putInt("port", port)
        return map
    }

    private fun stopServer() {
        try {
            server?.stop()
        } catch (error: Exception) {}
        server = null
        pending.clear()
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
    }
}