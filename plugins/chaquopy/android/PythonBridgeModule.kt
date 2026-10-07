package com.pppxxxy.easychat2.pythonbridge

import com.chaquo.python.Python
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

    /** 解释器是否可用（模块已随 APK 打包）。界面据此决定是否显示 Python 入口。 */
    @ReactMethod
    fun isAvailable(promise: Promise) {
        try {
            Python.getInstance()
            promise.resolve(true)
        } catch (error: Throwable) {
            promise.resolve(false)
        }
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

        // 不能在 RN 线程上跑：exec 是同步阻塞的。
        Thread {
            try {
                val module = Python.getInstance().getModule("easychat2_bridge")
                val result = module.callAttr("run_code", code, cwdPath).asMap()
                val map: WritableMap = Arguments.createMap()
                map.putString("stdout", result["stdout"]?.toString() ?: "")
                map.putString("stderr", result["stderr"]?.toString() ?: "")
                map.putInt("exitCode", result["exitCode"]?.toString()?.toIntOrNull() ?: 0)
                promise.resolve(map)
            } catch (error: Throwable) {
                promise.reject("python_failed", error.message ?: "Python 执行失败。")
            }
        }.start()
    }
}
