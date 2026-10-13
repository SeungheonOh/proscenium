project(
  'proscenium',
  'c',
  version: '0.1.0',
  meson_version: '>=1.3',
  default_options: ['c_std=gnu17', 'warning_level=2', 'buildtype=debugoptimized'],
)

cc = meson.get_compiler('c')
add_project_arguments(
  '-DWLR_USE_UNSTABLE',
  '-Wno-unused-parameter',
  '-Wno-missing-field-initializers',
  '-Wno-sign-compare',
  language: 'c',
)

wlroots = dependency('wlroots-0.20')
wayland_server = dependency('wayland-server')
xkbcommon = dependency('xkbcommon')
libinput = dependency('libinput')
pixman = dependency('pixman-1')
egl = dependency('egl')
glesv2 = dependency('glesv2')
xcb = dependency('xcb')
xcb_icccm = dependency('xcb-icccm')
glib = dependency('glib-2.0')
gobject = dependency('gobject-2.0')
gio = dependency('gio-2.0')
gio_unix = dependency('gio-unix-2.0')
threads = dependency('threads')
math = cc.find_library('m')

# Development packages the system may lack come from scripts/fetch-deps, which
# unpacks them under build/deps/root; installed ones take precedence.
deps_include = meson.project_source_root() / 'build/deps/root/usr/include'

pango = dependency('pangocairo', required: false)
if pango.found()
  media_deps = [pango, dependency('cairo'), dependency('gdk-pixbuf-2.0')]
else
  media_deps = [
    declare_dependency(
      compile_args: [
        '-isystem', deps_include / 'pango-1.0',
        '-isystem', deps_include / 'cairo',
        '-isystem', deps_include / 'harfbuzz',
        '-isystem', deps_include / 'gdk-pixbuf-2.0',
      ],
      link_args: [
        '-l:libpangocairo-1.0.so.0',
        '-l:libpango-1.0.so.0',
        '-l:libcairo.so.2',
        '-l:libgdk_pixbuf-2.0.so.0',
      ],
      dependencies: [glib, gobject, gio],
    ),
  ]
endif

pipewire = dependency('libpipewire-0.3', required: false)
if not pipewire.found()
  pipewire = declare_dependency(
    compile_args: [
      '-isystem', deps_include / 'pipewire-0.3',
      '-isystem', deps_include / 'spa-0.2',
      '-D_REENTRANT',
    ],
    link_args: ['-l:libpipewire-0.3.so.0'],
  )
endif

compositor_deps = [
  wlroots, wayland_server, xkbcommon, libinput, pixman, egl, glesv2, xcb, xcb_icccm,
  glib, gio, gio_unix, pipewire, threads, math,
] + media_deps

sources = files(
  'src/camera.c',
  'src/capture.c',
  'src/clipboard.c',
  'src/content.c',
  'src/display.c',
  'src/geometry.c',
  'src/gl.c',
  'src/input.c',
  'src/json.c',
  'src/link.c',
  'src/main.c',
  'src/manip.c',
  'src/media.c',
  'src/motion.c',
  'src/output.c',
  'src/props.c',
  'src/render.c',
  'src/scene.c',
  'src/shader.c',
  'src/screencast.c',
  'src/share.c',
  'src/stage.c',
  'src/util.c',
  'src/web.c',
  'src/webnode.c',
  'src/window.c',
  'src/xdg.c',
  'src/xwayland.c',
)

executable(
  'proscenium',
  sources,
  include_directories: include_directories('web'),
  dependencies: compositor_deps,
  install: true,
)

# Chromium for web nodes builds with CMake against CEF; see web/CMakeLists.txt.
cmake = find_program('cmake', required: get_option('web'))
if cmake.found()
  web_build = meson.current_build_dir() / 'web'
  custom_target(
    'proscenium-web-helper',
    output: 'proscenium-web-helper.stamp',
    command: [
      'sh', '-c',
      '"$0" -S "$1" -B "$2" -G Ninja -DCMAKE_BUILD_TYPE=Release >/dev/null'
        + ' && "$0" --build "$2" && touch "$3"',
      cmake, meson.project_source_root() / 'web', web_build, '@OUTPUT@',
    ],
    build_by_default: get_option('web').enabled(),
    build_always_stale: true,
    console: true,
  )
endif

# Tests: `meson test` runs the renderer's, the media worker's and the portal bridge's.
# test-web needs the helper (-Dweb=enabled): `build/meson/test-web HELPER`.
test_include = include_directories('src')
gbm = dependency('gbm', required: false)

test_render = executable(
  'test-render',
  'tests/test-render.c', 'src/render.c', 'src/gl.c', 'src/geometry.c', 'src/util.c',
  include_directories: test_include,
  dependencies: [wlroots, egl, glesv2, gbm, math],
  build_by_default: false,
)
test('render', test_render)

test_media = executable(
  'test-media',
  'tests/test-media.c', 'src/media.c', 'src/util.c',
  include_directories: test_include,
  dependencies: [wlroots, threads, math] + media_deps,
  build_by_default: false,
)
test('media', test_media)

# The portal bridge owns a bus name, so it runs on a session bus of its own.
test_screencast = executable(
  'test-screencast',
  'tests/test-screencast.c', 'src/screencast.c', 'src/util.c',
  include_directories: test_include,
  dependencies: [wlroots, glib, gio, gio_unix, pipewire, threads],
  build_by_default: false,
)
dbus_run_session = find_program('dbus-run-session', required: false)
if dbus_run_session.found()
  test('screencast', dbus_run_session, args: ['--', test_screencast], timeout: 120)
endif

executable(
  'test-web',
  'tests/test-web.c', 'src/web.c', 'src/json.c', 'src/geometry.c', 'src/util.c',
  include_directories: [test_include, include_directories('web')],
  dependencies: [wlroots, wayland_server, xkbcommon, egl, glesv2, gbm, threads, math],
  # Built with the helper, so the two never disagree on web/protocol.h.
  build_by_default: get_option('web').enabled(),
)

# proscenium-drive plays scripted input into headless sessions (tests/headless.sh).
wayland_client = dependency('wayland-client')
wayland_scanner = find_program('wayland-scanner', native: true)
drive_protocols = []
foreach name : ['wlr-virtual-pointer-unstable-v1', 'virtual-keyboard-unstable-v1']
  xml = 'tests/protocols' / name + '.xml'
  drive_protocols += custom_target(
    name + '-client-header',
    input: xml,
    output: name + '-client-protocol.h',
    command: [wayland_scanner, 'client-header', '@INPUT@', '@OUTPUT@'],
  )
  drive_protocols += custom_target(
    name + '-code',
    input: xml,
    output: name + '-protocol.c',
    command: [wayland_scanner, 'private-code', '@INPUT@', '@OUTPUT@'],
  )
endforeach
executable('proscenium-drive', 'tests/drive.c', drive_protocols,
           dependencies: [wayland_client, xkbcommon])
