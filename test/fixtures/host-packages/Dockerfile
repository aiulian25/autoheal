# A Debian host for the host-package tests: systemd as PID 1 with its D-Bus, and offline apt
# repositories whose dummy packages cover each case Autoheal sorts. Never pulls from the internet
# once built, so every run finds the same updates.
FROM debian:13-slim
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
  && apt-get install -y --no-install-recommends systemd systemd-sysv dbus apt-utils \
  && rm -rf /var/lib/apt/lists/* /etc/apt/sources.list.d/* /etc/apt/sources.list
COPY build-repositories.sh /usr/local/sbin/build-repositories.sh
RUN sh /usr/local/sbin/build-repositories.sh
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
