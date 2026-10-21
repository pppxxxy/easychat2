package com.pppxxxy.easychat2.mcpserver

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
import org.json.JSONObject
import java.net.Inet4Address
import java.net.NetworkInterface
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * 内置 MCP Server 的**哑管道**（Kotlin 侧）。
 *
 * 分工是刻意的：这一层只做 HTTP 解析、Bearer 鉴权、把请求原样发给 JS，再把 JS 给的
 * status/headers/body 原样写回。**所有 MCP 语义（initialize / tools/list / tools/call /
 * 档位判断 / 写入前预览）都在 JS 侧**（src/mcp/server*.js），因此协议可以 Node 直测，
 * 改协议不需要重新编译原生——原生只在「加路由/改鉴权/改绑定地址」时才需要动。
 *
 * 与 localApiServer 的差别（为什么另开一个模块而不是复用）：
 *  - 生命周期不同：本地 API 服务跟本地模型绑定、退后台即停；MCP 是用户级开关，
 *    需要能在 App 退到后台后继续应答（只要进程还活着）。
 *  - 访问范围不同：本地 API 硬绑回环；MCP 要支持局域网（桌面 agent 从另一台机器连）。
 *  - 路由不同：本地 API 是 OpenAI 兼容的多路由；MCP 是单端点 /mcp（POST/GET/DELETE）。
 *
 * 鉴权：Bearer 强制。start 时 token 为空则用 SecureRandom 生成并回显（绝不放行匿名请求）；
 * 比较用恒定时间，scheme 大小写不敏感（RFC 7235）。这与 LocalApiServer 同一套口径。
 */
class McpServerModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName() = "McpServer"

    private val pending = ConcurrentHashMap<String, PendingRequest>()
    private var server: McpServer? = null
    private var mcpToken: String = ""
    private var boundHost: String = HOST_LOOPBACK
    private var boundPort: Int = 0

    private class PendingRequest {
        val latch = CountDownLatch(1)

        @Volatile
        var status: Int = 200

        @Volatile
        var headersJson: String = "{}"

        @Volatile
        var body: String = ""
    }

    private inner class McpServer(host: String, port: Int) : NanoHTTPD(host, port) {
        override fun serve(session: IHTTPSession): Response = handle(session)
    }

    private fun unauthorized(): Response = NanoHTTPD.newFixedLengthResponse(
        Response.Status.UNAUTHORIZED,
        "application/json",
        "{\"error\":{\"message\":\"invalid bearer token\",\"type\":\"invalid_request_error\"}}"
    )

    private fun notFound(): Response = NanoHTTPD.newFixedLengthResponse(
        Response.Status.NOT_FOUND,
        "application/json",
        "{\"error\":{\"message\":\"not found\",\"type\":\"invalid_request_error\"}}"
    )

    private fun checkAuth(session: IHTTPSession): Boolean {
        val expected = mcpToken
        // 双保险：start() 保证非空，这里对空密钥直接拒绝。
        if (expected.isEmpty()) return false
        val header = session.headers["authorization"] ?: return false
        val separator = header.indexOf(' ')
        if (separator <= 0) return false
        val scheme = header.substring(0, separator).trim()
        if (!scheme.equals("bearer", ignoreCase = true)) return false
        val token = header.substring(separator + 1).trim()
        if (token.isEmpty()) return false
        return MessageDigest.isEqual(
            expected.toByteArray(Charsets.UTF_8),
            token.toByteArray(Charsets.UTF_8)
        )
    }

    // JSON 一律 UTF-8（RFC 8259 §8.1：JSON 文本 SHALL 用 UTF-8 编码，且不靠 HTTP 头协商）。
    // 但 NanoHTTPD 2.3.1 的 ContentType.getEncoding() 在 Content-Type **缺 charset 参数**时
    // 退回 US-ASCII，parseBody 用它 new String(postBytes, encoding) —— 每个非 ASCII 字节都
    // 变成 U+FFFD，中文参数在到达 JS 之前就已经烂了。
    //
    // 实测（2026-10-21）：POST 带 `Content-Type: application/json`（无 charset，DSH 的 MCP
    // 客户端就是这样发的）→ 参数里的中文回显成「����」；同一请求改带
    // `application/json; charset=utf-8` → 中文完整。受影响的不止角色卡，write_workspace_file
    // 之类的写工具同样会把乱码落盘，所以修在传输层（所有工具一次修好），而不是逐个工具兜底。
    //
    // 做法：parseBody 只读 headers map（getHeaders() 返回的就是内部那个可变 HashMap），
    // 在调用前把缺省的 charset 补成 UTF-8。调用方显式指定了别的 charset 就尊重它——
    // 我们只补「没写」，不改「写了」。
    private fun ensureUtf8Charset(session: IHTTPSession) {
        try {
            val headers = session.headers ?: return
            // NanoHTTPD 把所有头名统一转成小写，这里按小写取。
            val raw = headers["content-type"] ?: headers["Content-Type"] ?: return
            if (raw.contains("charset", ignoreCase = true)) return
            headers["content-type"] = "$raw; charset=utf-8"
        } catch (error: Exception) {
            // 补不上就按原样走：这只是编码修正，不该让请求直接 400。
            Log.w(TAG, "ensureUtf8Charset failed: ${error.message}")
        }
    }

    private fun handle(session: IHTTPSession): Response {
        val uri = session.uri ?: ""
        // 只暴露一个端点：/mcp（带不带尾斜杠都认）。其余一律 404，不泄露内部路由。
        if (uri != ENDPOINT_PATH && uri != "$ENDPOINT_PATH/") return notFound()
        if (!checkAuth(session)) return unauthorized()

        val method = session.method
        // GET/DELETE 无请求体：交给 JS 决定语义（405 或结束会话）。
        val body = if (method == Method.POST) {
            try {
                ensureUtf8Charset(session)
                val files = HashMap<String, String>()
                session.parseBody(files)
                files["postData"] ?: ""
            } catch (error: Exception) {
                return NanoHTTPD.newFixedLengthResponse(
                    Response.Status.BAD_REQUEST,
                    "application/json",
                    "{\"error\":{\"message\":\"bad request\",\"type\":\"invalid_request_error\"}}"
                )
            }
        } else ""

        val requestId = UUID.randomUUID().toString()
        val entry = PendingRequest()
        pending[requestId] = entry
        val payload = JSONObject()
            .put("requestId", requestId)
            .put("method", method.name)
            .put("path", ENDPOINT_PATH)
            .put("sessionId", session.headers["mcp-session-id"] ?: "")
            .put("headers", JSONObject().apply {
                // 只转发协议用得上的头：Accept（内容协商）与 MCP-Protocol-Version。
                put("accept", session.headers["accept"] ?: "")
                put("mcp-protocol-version", session.headers["mcp-protocol-version"] ?: "")
            })
            .put("body", body)
        emitRequest(payload.toString())

        val done = entry.latch.await(REQUEST_TIMEOUT_MS, TimeUnit.MILLISECONDS)
        pending.remove(requestId)
        if (!done) {
            return NanoHTTPD.newFixedLengthResponse(
                Response.Status.REQUEST_TIMEOUT,
                "application/json",
                "{\"error\":{\"message\":\"mcp request timeout\",\"type\":\"server_error\"}}"
            )
        }
        val status = if (entry.status in 100..599) entry.status else 500
        val response = NanoHTTPD.newFixedLengthResponse(
            Response.Status.values().firstOrNull { it.requestStatus == status } ?: Response.Status.OK,
            contentTypeFrom(entry.headersJson),
            entry.body
        )
        // 把 JS 给的响应头（主要是 Mcp-Session-Id）逐条写回。
        try {
            val headers = JSONObject(entry.headersJson)
            for (key in headers.keys()) {
                response.addHeader(key, headers.optString(key, ""))
            }
        } catch (error: Exception) {}
        return response
    }

    private fun contentTypeFrom(headersJson: String): String = try {
        val headers = JSONObject(headersJson)
        headers.optString("Content-Type", "application/json")
    } catch (error: Exception) {
        "application/json"
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
    fun start(host: String, port: Int, token: String, promise: Promise) {
        try {
            stopServer()
            val requested = token.trim()
            mcpToken = if (requested.isEmpty()) generateToken() else requested
            // 仅本机 → 127.0.0.1；局域网 → 0.0.0.0（由 JS 决定传哪个）。
            val bindHost = host.trim().ifEmpty { HOST_LOOPBACK }
            val next = McpServer(bindHost, port)
            next.start(NanoHTTPD.SOCKET_READ_TIMEOUT, false)
            server = next
            boundHost = bindHost
            boundPort = port
            Log.i(TAG, "mcp server started on $bindHost:$port (auth: ${if (requested.isEmpty()) "generated" else "user"})")
            promise.resolve(statusMap(true, port))
        } catch (error: Exception) {
            promise.reject("MCP_SERVER_START_FAILED", error.message, error)
        }
    }

    @ReactMethod
    fun stop(promise: Promise) {
        stopServer()
        promise.resolve(true)
    }

    @ReactMethod
    fun getStatus(promise: Promise) {
        promise.resolve(statusMap(server != null, boundPort))
    }

    // JS 处理完请求后回写：status + 响应头（JSON 字符串）+ 响应体。
    @ReactMethod
    fun respond(requestId: String, status: Int, headersJson: String, body: String, promise: Promise) {
        val entry = pending[requestId]
        if (entry == null) {
            promise.resolve(false)
            return
        }
        entry.status = status
        entry.headersJson = headersJson.ifEmpty { "{}" }
        entry.body = body
        entry.latch.countDown()
        promise.resolve(true)
    }

    private fun statusMap(running: Boolean, port: Int): WritableMap {
        val map = Arguments.createMap()
        map.putBoolean("running", running)
        map.putString("host", boundHost)
        map.putInt("port", port)
        // 回显生效 token（含自动生成的）：JS 侧据此展示/持久化，客户端照此携带。
        map.putString("mcpToken", mcpToken)
        map.putString("lanIp", lanIp())
        return map
    }

    // 局域网地址：给 UI 拼「完整连接配置」用（用户不必自己去翻系统设置里的 IP）。
    // 只取第一个 IPv4 站点本地地址；拿不到返回空串，UI 侧退回提示用户自查。
    private fun lanIp(): String {
        return try {
            for (iface in NetworkInterface.getNetworkInterfaces()) {
                if (!iface.isUp || iface.isLoopback) continue
                for (address in iface.inetAddresses) {
                    if (address is Inet4Address && !address.isLoopbackAddress && address.isSiteLocalAddress) {
                        return address.hostAddress ?: ""
                    }
                }
            }
            ""
        } catch (error: Exception) {
            ""
        }
    }

    private fun generateToken(): String {
        val bytes = ByteArray(24)
        SecureRandom().nextBytes(bytes)
        return bytes.joinToString("") { "%02x".format(it) }
    }

    private fun stopServer() {
        try {
            server?.stop()
        } catch (error: Exception) {}
        server = null
        boundPort = 0
        // 唤醒等待 JS 回写的 HTTP 线程：只 clear 不 countDown 会让它们阻塞到超时。
        pending.values.forEach { it.latch.countDown() }
        pending.clear()
    }

    // RN 0.81 销毁实例时调 invalidate()；旧架构调 onCatalystInstanceDestroy()。两个都覆写。
    override fun invalidate() {
        stopServer()
        super.invalidate()
    }

    override fun onCatalystInstanceDestroy() {
        stopServer()
        super.onCatalystInstanceDestroy()
    }

    companion object {
        private const val TAG = "McpServer"
        private const val ENDPOINT_PATH = "/mcp"
        private const val HOST_LOOPBACK = "127.0.0.1"
        private const val EVENT_REQUEST = "McpServer:onRequest"
        // 工具执行可能很慢（run_shell 看门狗 30s、云构建 60s、子代理 300s），
        // HTTP 等待必须大于工具层最长的超时，否则工具还在跑、HTTP 先断了。
        private const val REQUEST_TIMEOUT_MS = 360_000L
    }
}
