// 网络安全加固（Expo config plugin `plugins/withNetworkSecurity.js` 的 Kotlin 侧）。
//
// 修的问题：RN 的 XHR 默认**自动跟随 3xx**，而且 JS 层关不掉——
//   · Libraries/Network/XMLHttpRequest.js 的 sendRequest 参数表里**没有**
//     followRedirects 位；
//   · Android 侧 OkHttpClientProvider.kt 走 OkHttp 默认值（followRedirects 与
//     followSslRedirects 默认都是 true），ReactAndroid 全量 grep `followRedirects`
//     0 命中。
// 于是一个公网页面回 `302 Location: http://127.0.0.1:<port>/` 就能让 web_fetch
// 把**本机/内网**内容读回来（本仓 src/localModel/localApiServer.js 就监听回环）。
// 判定口径、以及「只判初始 URL 等于判定对象 ≠ 实际连接对象」的说明见
// src/plugins/webFetch.js 的 isPrivateRedirectTarget 注释。
//
// 做法：用 OkHttpClientProvider.setOkHttpClientFactory 换掉 RN 全局网络栈的 client，
// 关掉自动跟随重定向，并追加一道「DNS 解析后复核」
//（PrivateNetworkGuardDns.kt，堵 DNS rebinding）。
//
// 注入位置：**MainApplication.onCreate**（调用语句由 withNetworkSecurity.js 注入）。
// 必须早于 NetworkingModule / FrescoModule 的构造——它们在构造时就把
// OkHttpClientProvider 的 factory / client 定下来了（NetworkingModule.kt:132 与
// FrescoModule.kt:155 都直接调 OkHttpClientProvider.createClient）。
// setOkHttpClientFactory 是 public：react-native 的
// ReactAndroid/src/main/java/com/facebook/react/modules/network/OkHttpClientProvider.kt:28。
//
// ⚠️ 本文件**未在任何 Kotlin 编译器上编译过**（托管 Expo 项目，本机无 android/、
// 跑不了 Gradle）：仓库里只有 tests/networkSecurityPlugin.test.mjs 的**源码级**断言。
// 已知副作用见 withNetworkSecurity.js 头注释（RN 全局网络栈不再跟随 3xx）。

package com.pppxxxy.easychat2.networksecurity

import android.content.Context
import com.facebook.react.modules.network.OkHttpClientFactory
import com.facebook.react.modules.network.OkHttpClientProvider
import okhttp3.OkHttpClient

object NetworkSecurityInstaller {

  // 整个进程共用一个 client（OkHttpClient 本身线程安全且自带连接池）；
  // 重复 install 只是把同一个 factory 再设一次，幂等。
  @Volatile
  private var sharedClient: OkHttpClient? = null

  @JvmStatic
  fun install(context: Context) {
    val appContext = context.applicationContext
    val client = sharedClient ?: buildClient(appContext).also { sharedClient = it }
    OkHttpClientProvider.setOkHttpClientFactory(object : OkHttpClientFactory {
      override fun createNewNetworkModuleClient(): OkHttpClient = client
    })
  }

  // 刻意复用 RN 自己的 builder：超时全 0、ReactCookieJarContainer、10MB http 缓存
  // 都与 RN 默认 client 一致（见 OkHttpClientProvider.createClientBuilder 系列）。
  // 自己手搓 OkHttpClient.Builder 会悄悄丢掉 cookie 容器与缓存。
  @JvmStatic
  fun buildClient(context: Context): OkHttpClient {
    return OkHttpClientProvider.createClientBuilder(context)
      // 核心修复：不自动跟随 3xx（含 HTTPS -> HTTP 的降级跳转）。
      .followRedirects(false)
      .followSslRedirects(false)
      // 解析后复核：主机名解析到内网地址就拒绝（堵 DNS rebinding）。
      .dns(PrivateNetworkGuardDns())
      .build()
  }
}
