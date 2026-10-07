# 工作区 Python 桥（Chaquopy 内置解释器调用的辅助模块）。
#
# 设计口径（核实报告 §2.4 修正）：Chaquopy 只能在**构建时**用 build.gradle 的 pip 块把包
# 装进 APK，没有运行时 pip——所以这里不做「装包」，只负责执行代码片段并捕获输出。
#
# 安全边界（如实标注，别指望它像 shell 一样能被强杀）：Chaquopy 没有中断机制，
# 跑飞的脚本**杀不掉**（shell 有 destroyForcibly，Python 没有）。因此 agent 侧不注册
# run_python 工具，只允许用户在界面里亲手运行。

import contextlib
import io
import os
import traceback


def run_code(code, cwd):
    """执行代码片段，返回 {stdout, stderr, exitCode}。"""
    stdout = io.StringIO()
    stderr = io.StringIO()
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
    return {
        "stdout": stdout.getvalue(),
        "stderr": stderr.getvalue(),
        "exitCode": exit_code,
    }
