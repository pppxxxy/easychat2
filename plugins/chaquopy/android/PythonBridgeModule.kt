package com.pppxxxy.easychat2.pythonbridge

import com.chaquo.python.Python
import com.chaquo.python.android.AndroidPlatform
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import org.json.JSONObject
import java.io.File

/**
 * Python 桥（Chaquopy 内置 CPython）。
 *
 * 为什么用 Chaquopy：它是 Android 生态里唯一长期维护、且为现代 targetSdk 设计的嵌入式
 * CPython 方案（解释器随 APK 的 jniLibs 分发，不撞「数据目录二进制不能 exec」那堵墙）。
 *
 * 能力与边界（如实标注）：
 * - **没有运行时 pip**：包必须在构建时由 build.gradle 的 pip 块装进 APK；
 * - **没有中断机制**：Chaquopy 无法强杀正在跑的脚本（shell 的 destroyForcibly 在这里没有
 *   对应物）。所以 agent 侧不注册 run_python 工具，只允许用户亲手运行——避免模型让应用
 *   卡在一个杀不掉的脚本上；
 * - 工作目录由调用方给定（应用私有工作区的角色沙盒），与文件工具同一目录。
 */
class PythonBridgeModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName() = "PythonBridge"

    /**
     * 解释器是否**真的能用**（不是「模块是否注册」）。
     *
     * 这里必须实际尝试启动一次：Chaquopy 的 Python.getInstance() 在未启动时会自动用
     * GenericPlatform，而 GenericPlatform 在 Android 上直接抛异常
     * （Cannot use GenericPlatform on Android...）。也就是说「模块已注册」与
     * 「Python 能跑」是两件事——上一版界面把前者显示成后者，用户点运行才看到报错。
     *
     * 启动是重操作（首次要解压标准库到应用目录），放后台线程，避免阻塞 RN 线程。
     */
    @ReactMethod
    fun isAvailable(promise: Promise) {
        Thread {
            try {
                ensureStarted()
                promise.resolve(true)
            } catch (error: Throwable) {
                promise.resolve(false)
            }
        }.start()
    }

    @ReactMethod
    fun runScript(code: String, cwdPath: String, promise: Promise) {
        if (code.isBlank()) {
            promise.reject("invalid_code", "代码不能为空。")
            return
        }
        if (!cwdPath.startsWith("/")) {
            promise.reject("invalid_cwd", "工作目录必须是绝对路径。")
            return
        }
        val directory = File(cwdPath)
        if (!directory.isDirectory) {
            promise.reject("missing_cwd", "工作目录不存在：$cwdPath")
            return
        }

        // 不能在 RN 线程上跑：exec 是同步阻塞的，启动本身（解压标准库）也慢。
        Thread {
            try {
                ensureStarted()
                val module = Python.getInstance().getModule("easychat2_bridge")
                // 结果是一条 JSON 字符串，在这里解析成 WritableMap。契约见 easychat2_bridge.py。
                //
                // **不要再改成直接读 PyObject**：PyObject 虽然实现了 Map<String, PyObject>，
                // 但那是**属性访问**（等价 Python 的 getattr），不是取字典项——
                // result.get("stdout") 对 dict 只会返回 null，编译得过、也不抛错，
                // 真机表现是「退出码 0、没有任何输出」（2026-10-08 踩过）。
                // 容器访问要经 asMap()（Map<PyObject, PyObject>，键是 PyObject）或把键包成
                // PyObject，两条路都要把 Chaquopy 的转换细节漏进这里。传字符串则只剩
                // str() 一种解释，没有歧义空间。
                val payload = module.callAttr("run_code", code, cwdPath).toString()
                val parsed = try {
                    JSONObject(payload)
                } catch (error: Throwable) {
                    throw IllegalStateException("Python 桥返回的不是合法 JSON：${payload.take(200)}", error)
                }
                val map: WritableMap = Arguments.createMap()
                map.putString("stdout", parsed.optString("stdout", ""))
                map.putString("stderr", parsed.optString("stderr", ""))
                map.putInt("exitCode", parsed.optInt("exitCode", 0))
                promise.resolve(map)
            } catch (error: Throwable) {
                promise.reject("python_failed", error.message ?: "Python 执行失败。")
            }
        }.start()
    }

    /**
     * 确保解释器已启动（幂等）。
     *
     * Android 上必须用 AndroidPlatform：它负责按 ABI 定位解释器与标准库资源
     * （chaquopy/build.json、stdlib-<abi>.zip）。Python.start() 只能成功调用一次，
     * 且必须在任何 getInstance() 之前。
     *
     * 竞态处理：两个线程同时判断「未启动」时，后到的 start() 会抛
     * IllegalStateException("Python already started")——那不是失败，只要最终确实
     * 启动了就当成功，否则才把异常抛出去。
     */
    private fun ensureStarted() {
        if (Python.isStarted()) return
        try {
            Python.start(AndroidPlatform(reactContext))
        } catch (error: IllegalStateException) {
            if (!Python.isStarted()) throw error
        }
    }
}
