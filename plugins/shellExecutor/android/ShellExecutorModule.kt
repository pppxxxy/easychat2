package com.pppxxxy.easychat2.shellexecutor

import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import java.io.BufferedReader
import java.io.File
import java.io.InputStream
import java.io.InputStreamReader
import java.util.concurrent.ConcurrentHashMap

/**
 * 命令执行原生模块（工作区 run_shell 的底层能力）。
 *
 * 为什么必须新写一个原生模块：RN/JS 没有 exec 能力，本项目也没有。Kotlin 侧用
 * ProcessBuilder("/system/bin/sh", "-c", cmd) 起进程，工作目录固定为调用方给的
 * 沙盒路径（JS 侧只可能传应用私有工作区，外部 SAF 根下这个工具根本不注册）。
 *
 * 安全与健壮性约束（每一条都对应一个真实会踩的坑）：
 * - **工作目录必须存在且是绝对路径**：否则 ProcessBuilder 直接抛，JS 侧只看到
 *   一个没有上下文的异常。这里提前校验并给出可读的错误。
 * - **stdout/stderr 必须并发读取**：单线程先读 stdout 再读 stderr 会在子进程写满
 *   stderr 管道缓冲（通常 64KB）时双向死锁——两边都在等对方。
 * - **输出必须设上限并继续排空**：超限后仍要读（否则子进程又被管道堵死），
 *   但不再累积，避免 `yes` 之类把内存吃光。
 * - **超时必须 destroyForcibly**：destroy() 只发 SIGTERM，sh 起的子孙进程可能不理它。
 * - **中止要能精确 kill 这一条**：requestId → Process 映射，用户点停止时立刻杀。
 */
class ShellExecutorModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName() = "ShellExecutor"

    private val running = ConcurrentHashMap<String, Process>()

    private class StreamPump(private val stream: InputStream, private val limit: Int) {
        @Volatile
        var text: String = ""
            private set

        fun run() {
            val builder = StringBuilder()
            try {
                BufferedReader(InputStreamReader(stream, Charsets.UTF_8)).use { reader ->
                    val buffer = CharArray(4096)
                    while (true) {
                        val read = reader.read(buffer)
                        if (read <= 0) break
                        // 超限后继续读（排空管道）但不再累积，否则子进程会被管道堵死。
                        if (builder.length < limit) {
                            builder.append(buffer, 0, minOf(read, limit - builder.length))
                        }
                    }
                }
            } catch (error: Exception) {
                Log.w(TAG, "stream read failed: ${error.message}")
            }
            text = builder.toString()
        }
    }

    @ReactMethod
    fun exec(command: String, cwdPath: String, timeoutMs: Double, requestId: String, promise: Promise) {
        val resolvedTimeout = if (timeoutMs.isFinite() && timeoutMs > 0) timeoutMs.toLong() else DEFAULT_TIMEOUT_MS
        val trimmed = command.trim()
        if (trimmed.isEmpty()) {
            promise.reject("invalid_command", "命令不能为空。")
            return
        }
        val directory = File(cwdPath)
        if (!cwdPath.startsWith("/")) {
            promise.reject("invalid_cwd", "工作目录必须是绝对路径。")
            return
        }
        if (!directory.isDirectory) {
            promise.reject("missing_cwd", "工作目录不存在：$cwdPath")
            return
        }
        val key = requestId.ifEmpty { "shell-${System.nanoTime()}" }

        // 不能在 RN 线程上跑：exec 是阻塞的，放主线程等于把整个 JS 线程卡住。
        Thread {
            var process: Process? = null
            try {
                val builder = ProcessBuilder("/system/bin/sh", "-c", trimmed)
                builder.directory(directory)
                // 合并环境变量到子进程（继承即可），并显式声明工作目录语义：
                // 有 root 权限的 shell 才可能越出这个目录，我们不做任何额外放宽。
                val started = builder.start()
                process = started
                running[key] = started

                val outPump = StreamPump(started.inputStream, OUTPUT_LIMIT)
                val errPump = StreamPump(started.errorStream, OUTPUT_LIMIT)
                val outThread = Thread { outPump.run() }
                val errThread = Thread { errPump.run() }
                outThread.start()
                errThread.start()

                val finished = started.waitFor(resolvedTimeout, java.util.concurrent.TimeUnit.MILLISECONDS)
                var timedOut = false
                if (!finished) {
                    timedOut = true
                    // destroy() 只发 SIGTERM，sh 的子孙进程可能不理它，必须强杀。
                    started.destroyForcibly()
                    started.waitFor()
                }
                outThread.join(2000)
                errThread.join(2000)

                val result: WritableMap = Arguments.createMap()
                result.putString("stdout", outPump.text)
                result.putString("stderr", errPump.text)
                result.putInt("exitCode", if (timedOut) -1 else started.exitValue())
                result.putBoolean("timedOut", timedOut)
                result.putDouble("timeoutMs", resolvedTimeout.toDouble())
                promise.resolve(result)
            } catch (error: Exception) {
                Log.w(TAG, "exec failed: ${error.message}")
                promise.reject("exec_failed", error.message ?: "命令执行失败。")
            } finally {
                running.remove(key)
                // 中止路径（kill）已经把进程杀掉，这里只做清理兜底。
                process?.let { if (it.isAlive) it.destroyForcibly() }
            }
        }.start()
    }

    /** 中止某条命令（用户点停止）。找不到就当作已经结束——不是错误。 */
    @ReactMethod
    fun kill(requestId: String, promise: Promise) {
        val process = running.remove(requestId)
        if (process == null) {
            promise.resolve(false)
            return
        }
        try {
            process.destroyForcibly()
            promise.resolve(true)
        } catch (error: Exception) {
            promise.reject("kill_failed", error.message ?: "终止命令失败。")
        }
    }

    override fun onCatalystInstanceDestroy() {
        super.onCatalystInstanceDestroy()
        // JS 实例销毁（热重载/退出）时不能留下孤儿进程。
        for ((_, process) in running) {
            try {
                process.destroyForcibly()
            } catch (error: Exception) {}
        }
        running.clear()
    }

    companion object {
        private const val TAG = "ShellExecutor"
        private const val OUTPUT_LIMIT = 64 * 1024
        private const val DEFAULT_TIMEOUT_MS = 30_000L
    }
}
