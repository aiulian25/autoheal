#!/bin/sh
# A small application whose data format changes in version 2: version 2 moves format 1 on to format 2 as it starts,
# and version 1 will not open format 2, as a real application that cannot read a newer schema would not. Every start
# writes down first which version opened the data and what it found there.
mkdir -p /data
found=$(cat /data/state 2>/dev/null || echo none)
echo "$APP_VERSION:$found" >>/data/opened-by
case "$APP_VERSION:$found" in
1:none) echo format=1 >/data/state ;;
2:none | 2:format=1) echo format=2 >/data/state ;;
1:format=1 | 2:format=2) ;;
*)
  echo "fatal: version $APP_VERSION cannot read $found" >&2
  exit 3
  ;;
esac
if [ "$APP_SICK" = 1 ]; then
  echo "fatal: version $APP_VERSION moved the data to $(cat /data/state), then could not serve" >&2
  exit 4
fi
trap 'exit 0' TERM
while :; do
  sleep 1 &
  wait $!
done
