# Desktop portal files

Proscenium serves the desktop portal's ScreenCast backend itself, as
`org.freedesktop.impl.portal.desktop.proscenium` on the session bus
(`src/screencast.c`). These files make the portal frontend (`xdg-desktop-portal`)
route ScreenCast there:

| File | Installed to |
| --- | --- |
| `proscenium.portal` | `/usr/share/xdg-desktop-portal/portals/` |
| `proscenium-portals.conf` | `/usr/share/xdg-desktop-portal/`, or per user `~/.config/xdg-desktop-portal/` |

The frontend reads `.portal` files only from its compiled-in directory
(`/usr/share/xdg-desktop-portal/portals`) or from `$XDG_DESKTOP_PORTAL_DIR` when
that is set, so an installation under another prefix (or a development
checkout) needs a directory holding the system's `.portal` files plus ours, with
`XDG_DESKTOP_PORTAL_DIR` pointing at it in the frontend's environment. The
configuration routes ScreenCast to Proscenium and everything else to the GTK
backend; a copy in `~/.config/xdg-desktop-portal/` takes precedence over the
system one.

The frontend picks `<desktop>-portals.conf` from `XDG_CURRENT_DESKTOP`, so the
compositor sets `XDG_CURRENT_DESKTOP=proscenium` (lowercase, matching the file
name and `UseIn`) for the clients it starts, and exports it, with
`WAYLAND_DISPLAY`, to the D-Bus and systemd activation environment:

```sh
dbus-update-activation-environment --systemd WAYLAND_DISPLAY XDG_CURRENT_DESKTOP
systemctl --user restart xdg-desktop-portal.service
```

There is no D-Bus activation file: the backend lives inside the compositor. The
frontend reads its configuration and backends when it starts, so it should
start, or be restarted as above, after the compositor owns the name.
