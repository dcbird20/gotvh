package io.gotvh.tv.data

import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.security.KeyFactory
import java.security.KeyStore
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.security.spec.PKCS8EncodedKeySpec
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocket
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

/**
 * How this device reaches the server away from home (see docs/remote-access.md): the front door's
 * two names and this device's certificate from the pairing service. The certificate is what lets
 * the device in; the Tvheadend sign-in is still needed on top.
 */
class AwayAccess(
    val tvHost: String,
    val htspHost: String,
    val port: Int,
    val keyPem: String,
    val certPem: String,
    val caPem: String,
    val serial: String,
) {
    /** The web address away from home (admin app, Tvheadend API and streams). */
    val base: String get() = "https://$tvHost" + if (port == 443) "" else ":$port"

    /** The server's certificate is a normal public one (Let's Encrypt): the system's trust. */
    val trustManager: X509TrustManager by lazy {
        val tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
        tmf.init(null as KeyStore?)
        tmf.trustManagers.filterIsInstance<X509TrustManager>().first()
    }

    /** TLS that presents this device's certificate. */
    val sslContext: SSLContext by lazy {
        val key = KeyFactory.getInstance("EC").generatePrivate(PKCS8EncodedKeySpec(pemBody(keyPem)))
        val cf = CertificateFactory.getInstance("X.509")
        val chain = listOf(certPem, caPem).map { cf.generateCertificate(ByteArrayInputStream(it.toByteArray())) as X509Certificate }
        val ks = KeyStore.getInstance(KeyStore.getDefaultType()).apply {
            load(null, null)
            setKeyEntry("device", key, PASS, chain.toTypedArray())
        }
        val kmf = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm()).apply { init(ks, PASS) }
        SSLContext.getInstance("TLS").apply { init(kmf.keyManagers, arrayOf(trustManager), null) }
    }

    /** Wrap a connected socket in TLS for [host] (with SNI) and check the server's name. */
    fun wrap(socket: java.net.Socket, host: String): SSLSocket {
        val ssl = sslContext.socketFactory.createSocket(socket, host, socket.port, true) as SSLSocket
        ssl.startHandshake()
        if (!HttpsURLConnection.getDefaultHostnameVerifier().verify(host, ssl.session)) {
            ssl.close()
            throw javax.net.ssl.SSLPeerUnverifiedException("The server isn't $host")
        }
        return ssl
    }

    fun toJson(): String = JSONObject()
        .put("tvHost", tvHost).put("htspHost", htspHost).put("port", port)
        .put("key", keyPem).put("cert", certPem).put("ca", caPem).put("serial", serial)
        .toString()

    companion object {
        private val PASS = CharArray(0)

        /** From the pairing service's answer, or from storage; null if it's not usable. */
        fun fromJson(text: String?): AwayAccess? = runCatching {
            if (text.isNullOrBlank()) return null
            val o = JSONObject(text)
            AwayAccess(
                o.getString("tvHost"), o.getString("htspHost"), o.optInt("port", 443),
                o.getString("key"), o.getString("cert"), o.getString("ca"), o.optString("serial"),
            ).takeIf { it.tvHost.isNotBlank() && it.htspHost.isNotBlank() }
        }.getOrNull()

        private fun pemBody(pem: String): ByteArray =
            android.util.Base64.decode(pem.lines().filterNot { it.startsWith("-----") }.joinToString(""), android.util.Base64.DEFAULT)
    }
}
