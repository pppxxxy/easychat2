package com.pppxxxy.easychat2.pythonbridge

import com.chaquo.python.Python
import com.chaquo.python.android.AndroidPlatform
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
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
                val result = module.callAttr("run_code", code, cwdPath)
                val map: WritableMap = Arguments.createMap()
                // 用 PyObject.get(name) 取字典项，**不要** asMap()：
                // asMap() 返回 Map<PyObject, PyObject>，Kotlin 的 Map.get 要求键类型
                // 精确匹配，传 String 会编译不过（Type inference failed: 'K' must be
                // mentioned in input types）——上一版就是这样把 release 构建打挂的。
                // PyObject 自身重写了 get(Object)（语义等于 getattr，缺失返回 null），
                // 它才是这里该用的入口。
                map.putString("stdout", result.get("stdout")?.toString() ?: "")
                map.putString("stderr", result.get("stderr")?.toString() ?: "")
                map.putInt("exitCode", result.get("exitCode")?.toString()?.toIntOrNull() ?: 0)
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
