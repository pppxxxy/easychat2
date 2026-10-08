package com.pppxxxy.easychat2.pythonbridge

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.Message
import android.os.Messenger
import android.os.Process
import android.os.RemoteException
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import org.json.JSONObject
import java.io.File

/**
 * Python 桥（RN 侧客户端）。
 *
 * **本模块不再自己启动解释器**：Python 跑在 `:python` 独立进程里的 [PythonService]，
 * 本模块只做「绑定服务 → 发一条消息 → 拿回结果 → 解绑」。这么绕的原因只有一个：
 * Chaquopy 没有中断能力，只有独立进程才能在脚本跑飞时把它杀掉（详见 PythonService
 * 的类注释）。历史上有两版都踩过坑，别再简化回去：
 * - 同进程直接 `Python.getInstance()`：未启动时自动用 GenericPlatform，Android 上必抛
 *   「Cannot use GenericPlatform on Android」；
 * - 用 `PyObject.get("stdout")` 取结果：那是 `getattr()` 语义，对 dict 只会得到 null，
 *   表现为「退出码 0、没有任何输出」。现在结果是一条 JSON 字符串，解析在 JS 侧做。
 */
class PythonBridgeModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    private companion object {
        /** 原生侧看门狗的硬上限。JS 传更大的值也只按这个来——防的是「传个天文数字等于没有上限」。 */
        const val MAX_TIMEOUT_MS = 600000
    }

    override fun getName() = "PythonBridge"

    /**
     * 探测解释器状态。**这个方法是「报告」而不是「执行」**，所以隔离没生效时也如实
     * 回一份结果（由 JS 决定怎么显示），而不是抛错——否则界面只剩一句「不可用」，
     * 看不出是没打进包、启动失败还是隔离没生效。
     *
     * 返回 JSON 字符串：`{ok, pid, sameProcess, error}`。
     */
    @ReactMethod
    fun probe(promise: Promise) {
        Request("python_probe_failed", promise).start(PythonService.MSG_PROBE, Bundle())
    }

    /**
     * 执行一段代码。返回值同样是 JSON 字符串（`{stdout, stderr, exitCode}`，由
     * easychat2_bridge.py 产出）。
     *
     * `timeoutMs <= 0` 表示不设看门狗：手动运行时由用户点「停止」（杀掉 :python 进程）；
     * 模型调用时由 JS 传一个上限，避免脚本把解释器占死。
     */
    @ReactMethod
    fun runScript(code: String, cwdPath: String, timeoutMs: Double, promise: Promise) {
        if (code.isBlank()) {
            promise.reject("invalid_code", "代码不能为空。")
            return
        }
        if (!cwdPath.startsWith("/")) {
            promise.reject("invalid_cwd", "工作目录必须是绝对路径。")
            return
        }
        if (!File(cwdPath).isDirectory) {
            promise.reject("missing_cwd", "工作目录不存在：$cwdPath")
            return
        }
        val data = Bundle().apply {
            putString(PythonService.KEY_CODE, code)
            putString(PythonService.KEY_CWD, cwdPath)
            putInt(PythonService.KEY_TIMEOUT_MS, normalizeTimeout(timeoutMs))
        }
        Request("python_failed", promise).start(PythonService.MSG_RUN, data)
    }

    /** 停止当前脚本：让服务杀掉 `:python` 进程（解释器下次运行会自动重启）。 */
    @ReactMethod
    fun cancel(promise: Promise) {
        Request("python_cancel_failed", promise).start(PythonService.MSG_CANCEL, Bundle())
    }

    private fun normalizeTimeout(value: Double): Int {
        if (value.isNaN() || value <= 0.0) return 0
        return value.coerceAtMost(MAX_TIMEOUT_MS.toDouble()).toInt()
    }

    /**
     * 一次请求一次绑定。
     *
     * 为什么不做长连接：脚本被强杀（超时/中止）会连带杀掉 `:python` 进程，长连接随之失效，
     * 还得处理重连与「重连期间来了新请求」这些状态；按请求绑定天然自愈——下一次请求
     * 自然会用 `BIND_AUTO_CREATE` 把服务重新拉起来。
     */
    private inner class Request(
        private val errorCode: String,
        private val promise: Promise,
    ) : ServiceConnection {

        private var settled = false
        private var what = 0
        private var payload: Bundle = Bundle()
        private val context: Context get() = reactContext.applicationContext

        private val replies = Messenger(Handler(Looper.getMainLooper()) { message ->
            handleReply(message.data ?: Bundle())
            true
        })

        fun start(what: Int, data: Bundle) {
            this.what = what
            this.payload = data
            val bound = try {
                context.bindService(
                    Intent(context, PythonService::class.java),
                    this,
                    Context.BIND_AUTO_CREATE
                )
            } catch (error: Throwable) {
                false
            }
            if (!bound) {
                settle { promise.reject(errorCode, "无法连接 Python 服务（:python 进程）。") }
            }
        }

        override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
            // 进程被杀（超时/中止）后，绑定仍然有效，系统可能把服务重新拉起并**再次**
            // 回调这里。这次请求早就结算过了（settled），再发一遍等于把脚本跑第二次——
            // 而模型给的代码可能有副作用（写文件、发请求）。所以先判 settled。
            if (settled) {
                try {
                    context.unbindService(this)
                } catch (error: Throwable) {
                    // 已经解绑过就忽略。
                }
                return
            }
            val target = binder?.let { Messenger(it) }
            if (target == null) {
                settle { promise.reject(errorCode, "Python 服务没有返回通信通道。") }
                return
            }
            try {
                target.send(Message.obtain(null, what).apply {
                    replyTo = replies
                    data = payload
                })
            } catch (error: RemoteException) {
                settle { promise.reject(errorCode, error.message ?: "无法与 Python 服务通信。") }
            }
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            // 脚本超时或用户中止时，服务先回消息再杀进程，绑定随之断开。已拿到回复的
            // 情况由 settled 挡掉；走到这里说明进程被杀、结果没回来。
            settle {
                promise.reject(errorCode, "Python 进程已终止（脚本超时或已中止）；解释器会在下次运行时自动重启。")
            }
        }

        private fun handleReply(data: Bundle) {
            val remotePid = data.getInt(PythonService.KEY_PID, 0)
            val sameProcess = remotePid == Process.myPid()
            val unknownPid = remotePid == 0

            if (what == PythonService.MSG_PROBE) {
                settle {
                    promise.resolve(JSONObject().apply {
                        put("ok", data.getBoolean(PythonService.KEY_OK, false) && !sameProcess && !unknownPid)
                        put("pid", remotePid)
                        put("sameProcess", sameProcess || unknownPid)
                        put("error", data.getString(PythonService.KEY_ERROR) ?: "")
                    }.toString())
                }
                return
            }

            if (sameProcess || unknownPid) {
                // 隔离没生效（android:process 没写进清单）。这时 Python 跑在主进程里，
                // 「停脚本」只能连 UI 一起杀——所以**失败要朝安全方向倒**：直接拒绝，
                // 而不是假装能跑。宁可这个功能不可用，也不留一个杀不掉的执行入口。
                settle {
                    promise.reject(
                        "python_not_isolated",
                        "Python 隔离未生效：服务跑在主进程里（清单里的 android:process 缺失）。"
                    )
                }
                return
            }

            if (data.getBoolean(PythonService.KEY_OK, false)) {
                settle { promise.resolve(data.getString(PythonService.KEY_PAYLOAD, "")) }
            } else {
                settle { promise.reject(errorCode, data.getString(PythonService.KEY_ERROR) ?: "Python 执行失败。") }
            }
        }

        private fun settle(action: () -> Unit) {
            if (settled) return
            settled = true
            try {
                context.unbindService(this)
            } catch (error: Throwable) {
                // 绑定可能已经不存在（进程被杀时系统已解绑），忽略。
            }
            action()
        }
    }
}
