#!/bin/sh
# Kotlin: `var foo` already has a JVM setter setFoo(...); a `fun setFoo(` in the same file clashes
# ("Platform declaration clash"). Catch it before a CI build does.
cd "$(dirname "$0")/../tv-android/app/src" || exit 1
status=0
for f in $(grep -rl "fun set[A-Z]" --include=*.kt .); do
    for name in $(grep -o "fun set[A-Z][A-Za-z0-9]*" "$f" | sed 's/fun set//' | sort -u); do
        prop="$(echo "$name" | cut -c1 | tr 'A-Z' 'a-z')$(echo "$name" | cut -c2-)"
        if grep -qE "^\s*(private |internal |override )*var $prop\b" "$f"; then
            echo "$f: fun set$name clashes with var $prop"; status=1
        fi
    done
done
exit $status
