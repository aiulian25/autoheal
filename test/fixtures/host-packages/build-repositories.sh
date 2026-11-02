#!/bin/sh
# Dummy packages in two versions: the old ones installed, the new ones in three flat repositories that
# look like Debian's archive, Debian's security archive, and a vendor's own repository.
set -eu
old=/srv/old
repositories=/srv/repositories
mkdir -p "$old" "$repositories/debian" "$repositories/debian-security" "$repositories/vendor"

package() { # package <name> <version> <output directory> [depends] [config file] [seconds to set up]
  name=$1 version=$2 output=$3 depends=${4:-} config=${5:-} slow=${6:-}
  tree="/tmp/build/$name-$version"
  mkdir -p "$tree/DEBIAN" "$tree/usr/share/$name"
  echo "$version" > "$tree/usr/share/$name/version"
  {
    echo "Package: $name"
    echo "Version: $version"
    echo "Architecture: all"
    echo "Maintainer: Autoheal tests <tests@autoheal.invalid>"
    if [ -n "$depends" ]; then echo "Depends: $depends"; fi
    echo "Description: Autoheal test package"
  } > "$tree/DEBIAN/control"
  if [ -n "$config" ]; then
    mkdir -p "$tree/etc"
    echo "setting = $version" > "$tree/etc/$config"
    echo "/etc/$config" > "$tree/DEBIAN/conffiles"
  fi
  if [ -n "$slow" ]; then
    printf '#!/bin/sh\necho "%s: setting up, slowly"\nsleep %s\n' "$name" "$slow" > "$tree/DEBIAN/postinst"
    chmod 755 "$tree/DEBIAN/postinst"
  fi
  dpkg-deb --build --root-owner-group "$tree" "$output/${name}_${version}_all.deb" > /dev/null
}

package autoheal-routine 1.0 "$old"
package autoheal-routine 1.1 "$repositories/debian"
package autoheal-security 1.0 "$old"
# Slow to set up, so its log can be watched while the upgrade runs.
package autoheal-security 1.1 "$repositories/debian-security" "" "" 8
# Its new version needs a package that isn't installed, so a plain upgrade keeps it back.
package autoheal-kept-back 1.0 "$old"
package autoheal-kept-back 2.0 "$repositories/debian" autoheal-new-dependency
package autoheal-new-dependency 1.0 "$repositories/debian"
# Ships a new version of a config file the owner changed: the upgrade must keep theirs, not stop.
package autoheal-config 1.0 "$old" "" autoheal.conf
package autoheal-config 1.1 "$repositories/debian" "" autoheal.conf
package autoheal-vendor 1.0 "$old"
package autoheal-vendor 1.1 "$repositories/vendor"
package containerd.io 1.0 "$old"
package containerd.io 1.1 "$repositories/vendor"
# Unpacked on demand by the repair test, to leave dpkg half-done.
package autoheal-half-done 1.0 "$old"
# Installed as a dependency of nothing: apt's autoremove takes it.
package autoheal-orphan 1.0 "$old"

dpkg -i "$old"/autoheal-routine_1.0_all.deb "$old"/autoheal-security_1.0_all.deb \
  "$old"/autoheal-kept-back_1.0_all.deb "$old"/autoheal-config_1.0_all.deb \
  "$old"/autoheal-vendor_1.0_all.deb "$old"/containerd.io_1.0_all.deb "$old"/autoheal-orphan_1.0_all.deb > /dev/null
apt-mark auto autoheal-orphan > /dev/null
echo "setting = changed by the owner" > /etc/autoheal.conf

release() { # release <directory> <origin> <label> <suite> <codename>
  (
    cd "$repositories/$1"
    apt-ftparchive packages . > Packages
    apt-ftparchive -o "APT::FTPArchive::Release::Origin=$2" -o "APT::FTPArchive::Release::Label=$3" \
      -o "APT::FTPArchive::Release::Suite=$4" -o "APT::FTPArchive::Release::Codename=$5" release . > Release
  )
}
release debian Debian Debian stable trixie
release debian-security Debian Debian-Security stable-security trixie-security
release vendor Vendor Vendor stable vendor

for repository in debian debian-security vendor; do
  echo "deb [trusted=yes] file:$repositories/$repository ./"
done > /etc/apt/sources.list.d/autoheal-fixture.list
rm -rf /tmp/build
