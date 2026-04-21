#!/bin/sh
exec /opt/adb/lib/host/ld-linux-x86-64.so.2 \
  --library-path /opt/adb/lib/host:/opt/adb/lib/android \
  /opt/adb/bin/adb "$@"
