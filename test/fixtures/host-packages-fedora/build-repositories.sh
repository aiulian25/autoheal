#!/bin/sh
# Dummy packages in two versions: the old ones installed, the new ones in two flat repositories, one
# with Fedora's id for its updates and a security advisory, the other a vendor's own.
set -eu
old=/srv/old
repositories=/srv/repositories
build=/tmp/build
mkdir -p "$old" "$repositories/updates" "$repositories/vendor" "$build"

package() { # package <name> <version> <output directory>
  name=$1 version=$2 output=$3
  {
    echo "Name: $name"
    echo "Version: $version"
    echo "Release: 1"
    echo "Summary: Autoheal test package"
    echo "License: MIT"
    echo "BuildArch: noarch"
    echo "%description"
    echo "Autoheal test package"
    echo "%install"
    echo "mkdir -p %{buildroot}/usr/share/$name"
    echo "echo $version > %{buildroot}/usr/share/$name/version"
    echo "%files"
    echo "/usr/share/$name/version"
  } > "$build/$name-$version.spec"
  rpmbuild -bb --quiet --define "_topdir $build/top" --define "_rpmdir $output" \
    --define "_build_name_fmt %%{NAME}-%%{VERSION}-%%{RELEASE}.%%{ARCH}.rpm" "$build/$name-$version.spec" > /dev/null
}

package autoheal-routine 1.0 "$old"
package autoheal-routine 1.1 "$repositories/updates"
package autoheal-security 1.0 "$old"
package autoheal-security 1.1 "$repositories/updates"
package autoheal-vendor 1.0 "$old"
package autoheal-vendor 1.1 "$repositories/vendor"
# Installed as a dependency of nothing: dnf's autoremove takes it.
package autoheal-orphan 1.0 "$old"

createrepo_c --quiet "$repositories/updates"
createrepo_c --quiet "$repositories/vendor"
cat > "$build/updateinfo.xml" <<'ADVISORY'
<?xml version="1.0" encoding="UTF-8"?>
<updates>
  <update from="tests@autoheal.invalid" status="stable" type="security" version="2.0">
    <id>FEDORA-2026-autoheal1</id>
    <title>autoheal-security: a security fix</title>
    <issued date="2026-10-01 00:00:00"/>
    <severity>Important</severity>
    <description>A test advisory.</description>
    <pkglist>
      <collection short="autoheal">
        <name>Autoheal tests</name>
        <package name="autoheal-security" version="1.1" release="1" epoch="0" arch="noarch">
          <filename>autoheal-security-1.1-1.noarch.rpm</filename>
        </package>
      </collection>
    </pkglist>
  </update>
</updates>
ADVISORY
modifyrepo_c --mdtype=updateinfo "$build/updateinfo.xml" "$repositories/updates/repodata" > /dev/null

# Only these repositories from now on: nothing reaches the internet.
rm -f /etc/yum.repos.d/*.repo
for repository in updates vendor; do
  printf '[%s]\nname=Autoheal fixture: %s\nbaseurl=file://%s/%s\ngpgcheck=0\n\n' \
    "$repository" "$repository" "$repositories" "$repository"
done > /etc/yum.repos.d/autoheal-fixture.repo
dnf -y -q install "$old"/*.rpm
dnf -y -q mark dependency autoheal-orphan
dnf clean all > /dev/null
rm -rf "$build"
