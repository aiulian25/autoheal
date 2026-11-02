#!/bin/sh
# A small application that will not start on data it cannot use, as a real one would.
fail() { echo "fatal: $1" >&2; env | grep -E '^(APP_TOKEN|LIVE_SECRET)=' >&2; exit 3; }
[ -n "$APP_TOKEN" ] || fail "no APP_TOKEN"
[ -f /data/state ] || fail "no data at /data/state"
format=$(sed -n 1p /data/state)
[ "$format" = "format=$WANT_FORMAT" ] || fail "data is $format, this version needs format=$WANT_FORMAT"
want=$(sed -n 3p /data/state)
have=$(sed -n 2p /data/state | md5sum | cut -d' ' -f1)
[ "$want" = "$have" ] || fail "database corrupt: checksum mismatch"
date > /data/booted 2>/dev/null || fail "cannot write to /data"
touch /tmp/ready
trap 'exit 0' TERM
while :; do sleep 1 & wait $!; done
