# Bash 3.2 qualification fixture

These unmodified Ubuntu `.deb` archives supply a real Linux x64 Bash 3.2 executable
and its runtime libraries. The mixed-version shell test verifies each archive's
SHA-256, extracts it into a disposable directory with `dpkg-deb -x`, confirms
`BASH_VERSION`, and runs the old and maintained scripts and rendered launchers.
No package is installed on the host.
On macOS the same test requires the native `/bin/bash` to identify as Bash 3.2.

| Archive | SHA-256 | Origin |
| --- | --- | --- |
| `bash_3.2-5ubuntu1_amd64.deb` | `fe15a51dc70b4b0d5ed0556c670ffdf5b0297bb509480f22336684ee156b1d30` | `https://old-releases.ubuntu.com/ubuntu/pool/main/b/bash/bash_3.2-5ubuntu1_amd64.deb` |
| `libncurses5_6.1+20190803-1ubuntu1_amd64.deb` | `56d3dc9fd3c23ee99965e9d234df3ea9d40a276a45a4ef66ba735830dac03fc5` | `https://old-releases.ubuntu.com/ubuntu/pool/main/n/ncurses/libncurses5_6.1+20190803-1ubuntu1_amd64.deb` |
| `libtinfo5_6.1+20190803-1ubuntu1_amd64.deb` | `d7595f8592080f8172d02a5584093d0b04e035c8550246b6918b8d48233ccbe0` | `https://old-releases.ubuntu.com/ubuntu/pool/main/n/ncurses/libtinfo5_6.1+20190803-1ubuntu1_amd64.deb` |

The archives include upstream license notices under `usr/share/doc`. Upstream
source archives are available from the same Ubuntu archive under
`pool/main/b/bash/` and `pool/main/n/ncurses/`.
