package io.gotvh.tv.data

import okhttp3.Authenticator
import okhttp3.Request
import okhttp3.Response
import okhttp3.Route
import java.security.MessageDigest
import java.security.SecureRandom

/**
 * HTTP Digest sign-in, for Tvheadend servers set to Digest only. Requests go out with Basic first
 * (see TvhClient); when the server answers 401 with a Digest challenge, this signs the retry.
 * Used for API calls, channel logos and streams alike.
 */
class DigestAuthenticator(private val username: String, private val password: String) : Authenticator {

    private val random = SecureRandom()

    override fun authenticate(route: Route?, response: Response): Request? {
        if (username.isEmpty()) return null
        val challenge = response.headers("WWW-Authenticate").firstOrNull { it.startsWith("Digest", ignoreCase = true) } ?: return null
        val params = parse(challenge.substringAfter(' '))
        val nonce = params["nonce"] ?: return null
        val prior = response.request.header("Authorization")
        val stale = params["stale"].equals("true", ignoreCase = true)
        // Already answered this nonce and it wasn't just stale: the password is wrong. Stop.
        if (prior != null && prior.startsWith("Digest") && prior.contains("nonce=\"$nonce\"") && !stale) return null

        val realm = params["realm"] ?: ""
        val algorithm = params["algorithm"] ?: "MD5"
        val qop = params["qop"]?.split(',')?.map { it.trim() }?.firstOrNull { it.equals("auth", ignoreCase = true) }
        val url = response.request.url
        val uri = url.encodedPath + (url.encodedQuery?.let { "?$it" } ?: "")
        val nc = "00000001"
        val cnonce = ByteArray(8).also { random.nextBytes(it) }.joinToString("") { "%02x".format(it) }

        var ha1 = md5("$username:$realm:$password")
        if (algorithm.equals("MD5-sess", ignoreCase = true)) ha1 = md5("$ha1:$nonce:$cnonce")
        val ha2 = md5("${response.request.method}:$uri")
        val digest = if (qop != null) md5("$ha1:$nonce:$nc:$cnonce:$qop:$ha2") else md5("$ha1:$nonce:$ha2")

        val header = buildString {
            append("Digest username=\"").append(username).append("\", realm=\"").append(realm)
            append("\", nonce=\"").append(nonce).append("\", uri=\"").append(uri)
            append("\", response=\"").append(digest).append('"')
            params["opaque"]?.let { append(", opaque=\"").append(it).append('"') }
            if (qop != null) append(", qop=").append(qop).append(", nc=").append(nc).append(", cnonce=\"").append(cnonce).append('"')
            append(", algorithm=").append(algorithm)
        }
        return response.request.newBuilder().header("Authorization", header).build()
    }

    private fun parse(s: String): Map<String, String> =
        Regex("(\\w+)=(?:\"([^\"]*)\"|([^,\\s]*))").findAll(s).associate { m ->
            m.groupValues[1].lowercase() to m.groupValues[2].ifEmpty { m.groupValues[3] }
        }

    private fun md5(s: String): String =
        MessageDigest.getInstance("MD5").digest(s.toByteArray()).joinToString("") { "%02x".format(it) }
}
