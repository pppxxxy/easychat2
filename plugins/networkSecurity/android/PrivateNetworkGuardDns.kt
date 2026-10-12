// DNS **解析后**复核：堵「域名解析成内网 IP」这一类（DNS rebinding）。
//
// 为什么需要它：src/plugins/webFetch.js 的 isPrivateHostInfo 判的是**字面主机名**，
// 而系统连的是**解析结果**。`http://attacker.example/`（不含 .local / .internal /
// .localhost 后缀）在 JS 层放行，随后 OkHttp 才做 DNS；若其 A 记录指向 127.0.0.1，
// 请求就落在回环上（本仓 src/localModel/localApiServer.js 监听回环）。
// 这一条**不需要任何重定向**，一次解析就够了——所以光靠 followRedirects(false)
// 堵不住它，必须在校验解析结果。
//
// 口径**与 JS 侧同口径**：src/plugins/webFetch.js 的 isPrivateHostInfo /
// isPrivateIpv4Int / isPrivateIpv6Groups（不另立标准，否则两条闸门会出现
// 「JS 说私网、native 说公网」的分叉）。逐条对应：
//   IPv4：0.0.0.0/8、10.0.0.0/8、127.0.0.0/8（回环）、100.64.0.0/10（运营商级 NAT）、
//         169.254.0.0/16（链路本地，含云元数据 169.254.169.254）、172.16.0.0/12、
//         192.168.0.0/16、224.0.0.0/4（组播）与 240.0.0.0/4（保留）——即 first >= 224；
//   IPv6：::、::1（回环）、::ffff:a.b.c.d（IPv4 映射，折回 IPv4 判定）、
//         fc00::/7（唯一本地）、fe80::/10（链路本地）、fec0::/10（站点本地，已废弃
//         仍按私有）、ff00::/8（组播）；
//   解析不出来 / 未知长度一律按私有（fail-closed），与 webFetch.js 的
//   kind == 'invalid' 处理一致。
//
// ⚠️ 两条必须记住的边界（不要以为它把内网全堵死了）：
//   1) **只拦主机名**（isIpLiteral 为假才拦）。字面量 IP 一律放行，因为本仓有合法的
//      回环调用：src/imageGen/localDream.js 的 http://127.0.0.1:8081 与
//      src/agent/sdk.js 的 http://127.0.0.1:8686 走的是同一套 RN 网络栈，
//      一刀切拦回环会把既有功能打断。字面量内网地址由 JS 侧 webFetch.js 的
//      normalizeFetchUrl 判定（web_fetch 路径 fail-closed）。
//      代价：用户自己配置的「按域名写的局域网地址」（如 http://my-nas:11434）会被拒。
//   2) 只覆盖走 OkHttpClientProvider 的栈（fetch / XHR / Fresco 图片加载）。
//      WebView、expo/fetch、llama.cpp 等自带网络实现**不在内**。
//
// ⚠️ 本文件**未在任何 Kotlin 编译器上编译过**（托管 Expo 项目，本机无 android/）：
// 只有 tests/networkSecurityPlugin.test.mjs 的**源码级**断言。

package com.pppxxxy.easychat2.networksecurity

import java.net.InetAddress
import java.net.UnknownHostException
import okhttp3.Dns

// 主机名字面量里「看着就是 IP」的形态：含冒号 = IPv6；四段数字点分 = IPv4。
private val IPV4_LITERAL = Regex("^[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}$")

class PrivateNetworkGuardDns(private val delegate: Dns = Dns.SYSTEM) : Dns {

  @Throws(UnknownHostException::class)
  override fun lookup(hostname: String): List<InetAddress> {
    val addresses = delegate.lookup(hostname)
    // 字面量 IP 不是「解析结果」而是调用方自己写下的目标，交由 JS 侧判定（见头注释边界 1）。
    if (isIpLiteral(hostname)) return addresses
    for (address in addresses) {
      if (isPrivateAddress(address)) {
        // 抛 UnknownHostException 而不是自定义异常：OkHttp 会把它当作解析失败，
        // 请求直接失败、内网内容不会被取回，也不向对端暴露我们拦了哪一段。
        throw UnknownHostException("$hostname resolved to a private address; refused")
      }
    }
    return addresses
  }

  private fun isIpLiteral(hostname: String): Boolean {
    return hostname.contains(':') || IPV4_LITERAL.matches(hostname)
  }

  companion object {

    @JvmStatic
    fun isPrivateAddress(address: InetAddress): Boolean {
      val bytes = address.address
      if (bytes.size == 4) return isPrivateIpv4(bytes)
      if (bytes.size == 16) return isPrivateIpv6(bytes)
      // 未知长度：fail-closed（与 webFetch.js「解析不出来按私有处理」同口径）。
      return true
    }

    // 与 webFetch.js isPrivateIpv4Int 逐条对应。
    @JvmStatic
    fun isPrivateIpv4(bytes: ByteArray): Boolean {
      val first = bytes[0].toInt() and 0xff
      val second = bytes[1].toInt() and 0xff
      if (first == 0 || first == 10 || first == 127) return true
      if (first == 100 && second >= 64 && second <= 127) return true
      if (first == 169 && second == 254) return true
      if (first == 172 && second >= 16 && second <= 31) return true
      if (first == 192 && second == 168) return true
      if (first >= 224) return true
      return false
    }

    // 与 webFetch.js isPrivateIpv6Groups 逐条对应。
    @JvmStatic
    fun isPrivateIpv6(bytes: ByteArray): Boolean {
      val groups = IntArray(8)
      for (i in 0..7) {
        groups[i] = ((bytes[i * 2].toInt() and 0xff) shl 8) or (bytes[i * 2 + 1].toInt() and 0xff)
      }
      // ::、::1、::ffff:a.b.c.d、::a.b.c.d 一律折回 IPv4 判定：同一地址的两种写法
      // 必须得到同一结论，否则映射写法就是现成的绕过口。
      val zeroHead = groups[0] == 0 && groups[1] == 0 && groups[2] == 0 &&
        groups[3] == 0 && groups[4] == 0
      if (zeroHead && (groups[5] == 0 || groups[5] == 0xffff)) {
        val mapped = byteArrayOf(bytes[12], bytes[13], bytes[14], bytes[15])
        return isPrivateIpv4(mapped)
      }
      val first = groups[0]
      if ((first and 0xfe00) == 0xfc00) return true
      if ((first and 0xffc0) == 0xfe80) return true
      if ((first and 0xffc0) == 0xfec0) return true
      if ((first and 0xff00) == 0xff00) return true
      return false
    }
  }
}
