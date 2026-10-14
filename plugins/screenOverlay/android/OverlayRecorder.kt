package com.pppxxxy.easychat2.screenoverlay

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.util.Log
import java.io.File
import java.io.FileOutputStream

/**
 * 悬浮窗内的录音器（M3 耳朵）。
 *
 * 产物格式与 app 内既有语音一致：**16kHz / 单声道 / 16bit PCM 的 WAV**
 *（设计文档 3.3 明确要求「与 app 现格式一致」，这样云端 ASR 与系统识别都能直接用）。
 *
 * 只做「采 + 落盘」这一件事：
 *   · 不在这里做语音识别（识别在 OverlaySpeech）；
 *   · 不碰 UI（气泡由 OverlayService 负责）；
 *   · 因此本类可以在**工作线程**上跑，不阻塞主线程（M1 的教训：主线程一堵，
 *     全部兜底一起失灵）。
 *
 * ⚠️ 未在本地核实：沙箱无 Android SDK / Java，本文件无法编译或运行验证。
 * AudioRecord 的采样率兼容性（部分设备不支持 16kHz 直采，需要 44.1k 重采样）、
 * 免提/蓝牙路由行为，都需真机验证。
 */
class OverlayRecorder {

    private var record: AudioRecord? = null
    @Volatile private var recording = false
    private var worker: Thread? = null

    /** 录音是否进行中（供 UI 显示「正在听…」与按钮状态）。 */
    val isRecording: Boolean get() = recording

    /**
     * 开始录音。返回 false 表示启动失败（无权限/设备占用/初始化异常），
     * 调用方据此给「语音识别不可用」的如实提示，不静默失败。
     */
    @SuppressLint("MissingPermission")
    fun start(): Boolean {
        if (recording) return false
        val minBuffer = AudioRecord.getMinBufferSize(SAMPLE_RATE, CHANNEL, ENCODING)
        if (minBuffer <= 0) {
            Log.w(TAG, "AudioRecord unsupported: minBuffer=$minBuffer")
            return false
        }
        // 缓冲区取 2× 最小值：太小时读取线程会被频繁唤醒（丢帧/爆音），
        // 太大则停止时的延迟变长。2× 是常见折中。
        val bufferSize = minBuffer * 2
        val recorder = try {
            AudioRecord(
                MediaRecorder.AudioSource.VOICE_RECOGNITION,   // 为识别优化：降噪、关 AGC
                SAMPLE_RATE,
                CHANNEL,
                ENCODING,
                bufferSize
            )
        } catch (error: Exception) {
            Log.w(TAG, "AudioRecord create failed: ${error.message}")
            null
        }
        if (recorder == null || recorder.state != AudioRecord.STATE_INITIALIZED) {
            try {
                recorder?.release()
            } catch (error: Exception) {}
            return false
        }
        record = recorder
        recording = true
        val thread = Thread {
            val output = ArrayList<ByteArray>()
            var total = 0
            val buffer = ByteArray(bufferSize)
            try {
                recorder.startRecording()
                while (recording) {
                    val read = recorder.read(buffer, 0, buffer.size)
                    if (read <= 0) continue
                    // 单次录音上限：超过就自动收尾，避免用户忘了停导致文件无限增长。
                    if (total + read > MAX_PCM_BYTES) break
                    output.add(buffer.copyOf(read))
                    total += read
                }
            } catch (error: Exception) {
                Log.w(TAG, "record loop failed: ${error.message}")
            } finally {
                try {
                    recorder.stop()
                } catch (error: Exception) {}
                try {
                    recorder.release()
                } catch (error: Exception) {}
                lastPcm = output
                recording = false
            }
        }
        worker = thread
        thread.start()
        return true
    }

    /**
     * 停止录音并写出 WAV。返回文件；没有任何音频数据时返回 null
     *（用户点了两次太快 / 麦克风被占用），调用方据此提示而不是送一个空文件去识别。
     */
    fun stop(): File? {
        if (!recording && lastPcm == null) return null
        recording = false
        // 等采集线程收尾（它在 finally 里把 PCM 放进 lastPcm）。最多等 1s：
        // 卡住时宁可返回 null，也不把主线程/调用线程无限期挂住。
        try {
            worker?.join(1000)
        } catch (error: Exception) {}
        worker = null
        val chunks = lastPcm
        lastPcm = null
        if (chunks == null || chunks.isEmpty()) return null
        val pcmBytes = chunks.sumOf { it.size }
        if (pcmBytes < MIN_PCM_BYTES) return null   // 太短（<0.3s）：识别没有意义
        return try {
            writeWav(chunks, pcmBytes)
        } catch (error: Exception) {
            Log.w(TAG, "write wav failed: ${error.message}")
            null
        }
    }

    /** 丢弃本次录音（用户取消 / 服务销毁）。 */
    fun cancel() {
        recording = false
        try {
            worker?.join(300)
        } catch (error: Exception) {}
        worker = null
        lastPcm = null
    }

    /**
     * 写标准 44 字节 WAV 头 + PCM 数据。
     * 采样率/声道/位深必须与录音参数一致，否则识别端会当成噪声。
     */
    private fun writeWav(chunks: List<ByteArray>, pcmBytes: Int): File {
        val dir = File(dirProvider?.invoke() ?: throw IllegalStateException("no dir"))
        if (!dir.exists()) dir.mkdirs()
        val file = File(dir, "voice-${System.currentTimeMillis().toString(36)}.wav")
        FileOutputStream(file).use { out ->
            out.write(wavHeader(pcmBytes))
            chunks.forEach { out.write(it) }
        }
        return file
    }

    private fun wavHeader(pcmBytes: Int): ByteArray {
        val channels = 1
        val bitsPerSample = 16
        val byteRate = SAMPLE_RATE * channels * bitsPerSample / 8
        val blockAlign = channels * bitsPerSample / 8
        val header = java.nio.ByteBuffer.allocate(44).order(java.nio.ByteOrder.LITTLE_ENDIAN)
        header.put("RIFF".toByteArray(Charsets.US_ASCII))
        header.putInt(36 + pcmBytes)
        header.put("WAVE".toByteArray(Charsets.US_ASCII))
        header.put("fmt ".toByteArray(Charsets.US_ASCII))
        header.putInt(16)                    // fmt chunk 大小
        header.putShort(1)                   // PCM
        header.putShort(channels.toShort())
        header.putInt(SAMPLE_RATE)
        header.putInt(byteRate)
        header.putShort(blockAlign.toShort())
        header.putShort(bitsPerSample.toShort())
        header.put("data".toByteArray(Charsets.US_ASCII))
        header.putInt(pcmBytes)
        return header.array()
    }

    /** 录音落盘目录（由 OverlayService 注入 filesDir/screen-watch，与截图同目录）。 */
    var dirProvider: (() -> File)? = null

    // 采集线程写、stop() 读：用 volatile 保证可见性（跨线程传递大数组）。
    @Volatile private var lastPcm: List<ByteArray>? = null

    companion object {
        private const val TAG = "OverlayRecorder"
        const val SAMPLE_RATE = 16000
        private const val CHANNEL = AudioFormat.CHANNEL_IN_MONO
        private const val ENCODING = AudioFormat.ENCODING_PCM_16BIT
        // 单次录音上限 60 秒（16k×16bit×1ch ≈ 32KB/s → 60s ≈ 1.9MB）。
        private const val MAX_PCM_BYTES = SAMPLE_RATE * 2 * 60
        // 最短有效录音 0.3 秒：更短的识别不出东西，白白发一次请求。
        private const val MIN_PCM_BYTES = SAMPLE_RATE * 2 * 3 / 10
    }
}
