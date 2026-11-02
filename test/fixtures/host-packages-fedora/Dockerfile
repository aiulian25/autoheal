# A Fedora host for the host-package tests: systemd as PID 1 with its D-Bus, and offline dnf
# repositories whose dummy packages cover each case Autoheal sorts, a security advisory included.
# Never pulls from the internet once built, so every run finds the same updates.
FROM fedora:42
RUN dnf -y install --setopt=install_weak_deps=False systemd dbus-broker rpm-build createrepo_c \
  && dnf clean all
COPY build-repositories.sh /usr/local/sbin/build-repositories.sh
RUN sh /usr/local/sbin/build-repositories.sh
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
