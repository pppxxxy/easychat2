# 工作区 Python 桥（Chaquopy 内置解释器调用的辅助模块）。
#
# 设计口径（核实报告 §2.4 修正）：Chaquopy 只能在**构建时**用 build.gradle 的 pip 块把包
# 装进 APK，没有运行时 pip——所以这里不做「装包」，只负责执行代码片段并捕获输出。
#
# 安全边界（如实标注，别指望它像 shell 一样能被强杀）：Chaquopy 没有中断机制，
# 跑飞的脚本**杀不掉**（shell 有 destroyForcibly，Python 没有）。因此 agent 侧不注册
# run_python 工具，只允许用户在界面里亲手运行。下面 OUTPUT_LIMIT 是这条限制的补丁：
# 杀不掉脚本，至少别让 while True: print(...) 把内存吃光、连累整个应用被系统杀掉。
#
# **返回契约：一整条 JSON 字符串**（不是 dict）——原因见 run_code 的说明，改之前先读。

import contextlib
import io
import json
import os
import traceback

# 单路（stdout / stderr 各一份）缓冲上限，单位字符。写满即停，不再增长。
OUTPUT_LIMIT = 256 * 1024
TRUNCATION_MARK = "\n…（输出超过 %d 字符，已在解释器侧截断）\n" % OUTPUT_LIMIT


class _CappedBuffer(io.StringIO):
    """封顶缓冲：写满后就丢弃后续内容（不再增长），并置 clipped 标记。

    不用「先全量收集、最后切片」的写法：那种写法下内存照样被撑爆，等于没防。
    自己记长度（不依赖 StringIO 的读写指针），避免混用读写时 tell() 语义变化。
    """

    def __init__(self, limit):
        super().__init__()
        self._limit = limit
        self._size = 0
        self.clipped = False

    def write(self, text):
        if self.clipped:
            return len(text)
        remaining = self._limit - self._size
        if remaining <= 0:
            self.clipped = True
            return len(text)
        piece = text if len(text) <= remaining else text[:remaining]
        super().write(piece)
        self._size += len(piece)
        if len(piece) < len(text):
            self.clipped = True
        return len(text)


def _text_of(buffer):
    text = buffer.getvalue()
    return text + TRUNCATION_MARK if buffer.clipped else text


def run_code(code, cwd):
    """执行代码片段，返回 JSON 字符串 `{"stdout","stderr","exitCode"}`。

    **为什么返回 JSON 字符串而不是 dict**（2026-10-08 真机踩过，别再改回去）：
    Kotlin 侧拿到的是 `com.chaquo.python.PyObject`，而 `PyObject.get(key)` 的官方语义是
    **`getattr()`**（PyObject.java 的 javadoc 原文：*"Equivalent to Python getattr()"*），
    不是取字典项；对 dict 写 `result.get("stdout")` 只会得到 `null`，**编译得过、运行也不
    报错**——真机表现就是「退出码 0、没有任何输出」。容器访问必须走 `asMap()`
    （`Map<PyObject, PyObject>`，键是 PyObject）或把键包成 PyObject，两条路都要把
    Chaquopy 的转换细节漏进业务代码里。
    换成一整条 JSON 字符串后，跨语言边界只剩 `str()` 一种解释，没有歧义空间；
    Kotlin 侧用 `JSONObject` 解析即可。
    """
    stdout = _CappedBuffer(OUTPUT_LIMIT)
    stderr = _CappedBuffer(OUTPUT_LIMIT)
    previous = os.getcwd()
    exit_code = 0
    try:
        if cwd:
            os.chdir(cwd)
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            exec(compile(code, "<workspace>", "exec"), {"__name__": "__main__"})
    except BaseException:
        exit_code = 1
        stderr.write(traceback.format_exc())
    finally:
        try:
            os.chdir(previous)
        except OSError:
            pass
    return json.dumps({
        "stdout": _text_of(stdout),
        "stderr": _text_of(stderr),
        "exitCode": exit_code,
    }, ensure_ascii=False)