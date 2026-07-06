# iperf3 binary

Put a Windows x64 `iperf3.exe` here to bundle it with the app.

The app resolves binaries in this order:

1. A custom path selected in the UI.
2. `src-tauri/bin/iperf3.exe` when bundled as a Tauri resource.
3. `iperf3` from `PATH`.

ESnet does not officially support iperf3 on Windows. The iperf.fr download
page points users to community builds, so record the version and source of
any binary you place here before distributing an installer.
