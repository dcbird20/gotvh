package io.gotvh.tv.data

import androidx.compose.ui.graphics.Color

/**
 * Genre colour coding, the same seven groups and colours as the admin app's guide
 * (projects/gotvh-admin/.../guide-genre.ts, dark-theme column). Red is left out: it means "recording".
 */
enum class Genre(val label: String, val color: Color) {
    MOVIE("Movies & drama", Color(0xFF3987E5)),
    NEWS("News", Color(0xFFD95926)),
    DOCS("Documentary", Color(0xFF199E70)),
    KIDS("Kids", Color(0xFFC98500)),
    SHOWS("Entertainment", Color(0xFFD55181)),
    SPORTS("Sports", Color(0xFF008300)),
    LIFESTYLE("Lifestyle", Color(0xFF9085E9));

    companion object {
        /** DVB content group (high nibble of Tvheadend's genre code). */
        private val byGroup = mapOf(
            0x1 to MOVIE, 0x2 to NEWS, 0x3 to SHOWS, 0x4 to SPORTS, 0x5 to KIDS,
            0x6 to SHOWS, 0x7 to DOCS, 0x8 to NEWS, 0x9 to DOCS, 0xA to LIFESTYLE,
        )

        /** Only title patterns that are hard to get wrong, for sources without genre codes. */
        private val guesses = listOf(
            Regex("\\b(NFL|NBA|WNBA|MLB|NHL|MLS|NCAA|PGA|LPGA|NASCAR|IndyCar|UFC|WWE|Formula 1|F1|Premier League)\\b|\\b(Football|Baseball|Basketball|Hockey|Soccer|Golf|Tennis|Boxing|Wrestling|Racing|Olympics?)\\b|SportsCenter", RegexOption.IGNORE_CASE) to SPORTS,
            Regex("\\bNews(room|hour|night|cast)?\\b|\\bEyewitness\\b|Good Morning America|\\bToday\\b(?! Show)|Meet the Press|Face the Nation|60 Minutes|\\bDateline\\b|\\bNightline\\b|\\bWeather\\b", RegexOption.IGNORE_CASE) to NEWS,
            Regex("^(Movie|Film)\\s*[:|-]", RegexOption.IGNORE_CASE) to MOVIE,
            Regex("PAW Patrol|Sesame Street|Peppa Pig|Bluey|SpongeBob|Daniel Tiger|Curious George|Cartoon", RegexOption.IGNORE_CASE) to KIDS,
        )

        fun of(p: Program): Genre? {
            for (g in p.genre) byGroup[(g shr 4) and 0xF]?.let { return it }
            val text = "${p.title} ${p.subtitle}"
            return guesses.firstOrNull { it.first.containsMatchIn(text) }?.second
        }
    }
}
