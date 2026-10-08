package com.pppxxxy.easychat2.pythonbridge

import android.app.Service
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.Message
import android.os.Messenger
import android.os.Process
import android.os.RemoteException
import com.chaquo.python.Python
import com.chaquo.python.android.AndroidPlatform

/**
 * 跑 Python 的独立进程服务（清单里声明为 `android:process=":python"`）。
 *
 * **为什么必须是独立进程**：Chaquopy 没有任何中断/强杀解释器的 API——16.1.0 的
 * chaquopy_java 源码里 grep 不到 interrupt / kill / abort / cancel 之类的东西
 * （`Python.java` 只有 start / getInstance / isStarted / getModule / getPlatform）。
 * 同进程里唯一能停掉跑飞脚本的办法是把整个应用进程杀掉，那等于自杀。独立进程之后，
 * 「停脚本」就变成「杀那个进程」，主进程（UI）不受影响；下一次请求由 Android
 * 重新拉起本服务，解释器重新初始化（标准库解压是按 hash 判断的，重启通常很快）。
 *
 * **为什么用 Messenger 而不是 AIDL**：AGP 8 起 AIDL 必须在 `android.buildFeatures`
 * 里显式打开 `aidl true`，那又是一处只能靠真机构建验证的 Gradle 改动。Messenger 是
 * API 1 就有的老接口，零额外配置。代价是只能传 Bundle（Binder 事务约 1MB 上限），
 * 所以输出在 Python 侧就封到 64KB（与 JS 的显示上限一致，见 easychat2_bridge.py）。
 *
 * **串行执行**：解释器是单例，且 `os.chdir` 与 `sys.stdout` 重定向都是进程级全局状态，
 * 并发跑会互相踩。所以同一时刻只允许一个脚本，第二个请求直接回绝。
 */
class PythonService : Service() {

    companion object {
        const val MSG_RUN = 1
        const val MSG_PROBE = 2
        const val MSG_CANCEL = 3

        const val KEY_CODE = "code"
        const val KEY_CWD = "cwd"
        const val KEY_TIMEOUT_MS = "timeoutMs"
        const val KEY_OK = "ok"
        const val KEY_PAYLOAD = "payload"
        const val KEY_ERROR = "error"
        /** 服务所在进程的 pid：客户端拿它和 `Process.myPid()` 比对来**证明隔离生效**。 */
        const val KEY_PID = "pid"

        private const val BRIDGE_MODULE = "easychat2_bridge"
        private const val ERROR_BUSY = "上一个脚本还在跑：解释器是单例，脚本串行执行。"
    }

    private var running = false
    private var watchdog: Runnable? = null

    private val handler = object : Handler(Looper.getMainLooper()) {
        override fun handleMessage(msg: Message) {
            when (msg.what) {
                MSG_PROBE -> handleProbe(msg)
                MSG_RUN -> handleRun(msg)
                MSG_CANCEL -> handleCancel(msg)
                else -> super.handleMessage(msg)
            }
        }
    }

    private val messenger = Messenger(handler)

    override fun onBind(intent: Intent?): IBinder? = messenger.binder

    /**
     * 探测「解释器能不能真的跑」。
     *
     * 必须实际尝试启动：Chaquopy 的 `Python.getInstance()` 在未启动时会自动用
     * `GenericPlatform`，而它在 Android 上必然抛异常（Cannot use GenericPlatform
     * on Android...），所以「模块已注册」与「能跑」是两件事。首次启动要解压标准库，
     * 所以放后台线程。
     */
    private fun handleProbe(msg: Message) {
        val reply = msg.replyTo ?: return
        Thread {
            val result = Bundle()
            result.putInt(KEY_PID, Process.myPid())
            try {
                ensureStarted()
                result.putBoolean(KEY_OK, true)
            } catch (error: Throwable) {
                result.putBoolean(KEY_OK, false)
                result.putString(KEY_ERROR, error.message ?: "Python 解释器启动失败。")
            }
            send(reply, MSG_PROBE, result)
        }.start()
    }

    private fun handleRun(msg: Message) {
        val reply = msg.replyTo ?: return
        val data = msg.data ?: Bundle()
        val code = data.getString(KEY_CODE).orEmpty()
        val cwd = data.getString(KEY_CWD).orEmpty()
        val timeoutMs = data.getInt(KEY_TIMEOUT_MS, 0)

        if (running) {
            send(reply, MSG_RUN, Bundle().apply {
                putInt(KEY_PID, Process.myPid())
                putBoolean(KEY_OK, false)
                putString(KEY_ERROR, ERROR_BUSY)
            })
            return
        }

        running = true
        Thread {
            val result = Bundle()
            result.putInt(KEY_PID, Process.myPid())
            try {
                ensureStarted()
                val module = Python.getInstance().getModule(BRIDGE_MODULE)
                // run_code 返回的是**一整条 JSON 字符串**（不是 dict）。为什么不能用
                // PyObject 取字典项：PyObject.get 的语义是 getattr()，对 dict 取
                // "stdout" 只会得到 null 且不报错——真机表现为「退出码 0、没有任何输出」。
                // 详见 easychat2_bridge.py 里 run_code 的说明，别再改回去。
                result.putBoolean(KEY_OK, true)
                result.putString(KEY_PAYLOAD, module.callAttr("run_code", code, cwd).toString())
            } catch (error: Throwable) {
                result.putBoolean(KEY_OK, false)
                result.putString(KEY_ERROR, error.message ?: "Python 执行失败。")
            }
            // 先解除看门狗再回结果：否则刚好卡在超时边界上时，脚本已经跑完却被杀。
            running = false
            clearWatchdog()
            send(reply, MSG_RUN, result)
        }.start()

        if (timeoutMs > 0) {
            val task = Runnable {
                if (running) {
                    clearWatchdog()
                    killSelf(reply, MSG_RUN, "脚本超过 $timeoutMs 毫秒仍未结束，已强制终止（解释器会在下次运行时重启）。")
                }
            }
            watchdog = task
            handler.postDelayed(task, timeoutMs.toLong())
        }
    }

    /**
     * 用户主动停止。脚本正在跑就杀进程；空闲时如实回「本来就没在跑」。
     * 之所以能做到：Python 在主线程之外的线程上跑，主线程仍能收消息。
     */
    private fun handleCancel(msg: Message) {
        val reply = msg.replyTo
        if (!running) {
            if (reply != null) {
                send(reply, MSG_CANCEL, Bundle().apply {
                    putInt(KEY_PID, Process.myPid())
                    putBoolean(KEY_OK, true)
                })
            }
            return
        }
        killSelf(reply, MSG_CANCEL, "脚本已被中止（解释器会在下次运行时重启）。")
    }

    /**
     * 杀掉自己所在的进程——这是本方案存在的全部理由：唯一能停掉跑飞脚本的手段。
     *
     * 先回消息再杀：Messenger 的 send 是同步 Binder 调用，消息内容在 send 返回前
     * 已经落到对端进程的消息队列里，所以紧接着杀进程不会把「为什么被杀」弄丢。
     */
    private fun killSelf(reply: Messenger?, what: Int, reason: String) {
        if (reply != null) {
            send(reply, what, Bundle().apply {
                putInt(KEY_PID, Process.myPid())
                putBoolean(KEY_OK, false)
                putString(KEY_ERROR, reason)
            })
        }
        Process.killProcess(Process.myPid())
    }

    private fun clearWatchdog() {
        watchdog?.let { handler.removeCallbacks(it) }
        watchdog = null
    }

    private fun send(reply: Messenger, what: Int, data: Bundle) {
        try {
            reply.send(Message.obtain(null, what).apply { this.data = data })
        } catch (error: RemoteException) {
            // 客户端已经没了（界面被关/主进程退出）：脚本结果没有接收方，丢弃即可。
        }
    }

    /**
     * 确保解释器已启动（幂等）。Android 上必须用 AndroidPlatform：它负责按 ABI 定位
     * 解释器与标准库资源。`Python.start()` 只能成功调用一次，且必须在任何
     * `getInstance()` 之前；并发重复启动会抛 IllegalStateException——那不是失败。
     */
    private fun ensureStarted() {
        if (Python.isStarted()) return
        try {
            Python.start(AndroidPlatform(applicationContext))
        } catch (error: IllegalStateException) {
            if (!Python.isStarted()) throw error
        }
    }
}
