# The SSH sandbox's host: a Debian machine with systemd and its D-Bus, OpenSSH and sudo, and the e2e fixture's offline
# apt repositories, so every check finds the same updates. Its user signs in with a key and uses sudo with a password;
# the browser project gives it both, and the sandbox engine's socket, when it starts it.
# Built inside the sandbox, from test/ (run.sh).
FROM debian:13-slim
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
  && apt-get install -y --no-install-recommends systemd systemd-sysv dbus apt-utils openssh-server sudo \
  && rm -rf /var/lib/apt/lists/* /etc/apt/sources.list.d/* /etc/apt/sources.list
COPY fixtures/host-packages/build-repositories.sh /usr/local/sbin/build-repositories.sh
RUN sh /usr/local/sbin/build-repositories.sh \
  && useradd --create-home --shell /bin/bash --groups sudo sandbox
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
