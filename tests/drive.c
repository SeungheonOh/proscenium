/*
 * Drive a headless proscenium session: reads input commands from standard
 * input, one per line, and plays them through virtual pointer and keyboard
 * devices.
 *
 *   extent W H         the layout size absolute motion spans (default 1280 720)
 *   move X Y           put the pointer at layout point (X, Y)
 *   glide X Y MS       move there in steps over MS milliseconds
 *   down BUTTON        press left, right, middle or an evdev code
 *   up BUTTON
 *   click BUTTON
 *   wheel STEPS        scroll by notches; negative scrolls up
 *   key NAME...        tap keys by keysym name, e.g. "key Return"
 *   chord MOD+...+NAME hold modifiers (super, ctrl, alt, shift) around a key
 *   hold MOD           press a modifier until "release MOD", e.g. around a drag
 *   release MOD
 *   type TEXT          tap the keys of plain ASCII TEXT
 *   spawn COMMAND      start COMMAND with /bin/sh, not waiting for it
 *   sleep MS
 *   # comment
 */
#define _GNU_SOURCE
#include <linux/input-event-codes.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <spawn.h>
#include <sys/mman.h>
#include <time.h>
#include <unistd.h>
#include <wayland-client.h>
#include <xkbcommon/xkbcommon.h>

#include "virtual-keyboard-unstable-v1-client-protocol.h"
#include "wlr-virtual-pointer-unstable-v1-client-protocol.h"

extern char **environ;

static struct wl_display *display;
static struct wl_seat *seat;
static struct zwlr_virtual_pointer_manager_v1 *pointer_manager;
static struct zwp_virtual_keyboard_manager_v1 *keyboard_manager;
static struct zwlr_virtual_pointer_v1 *pointer;
static struct zwp_virtual_keyboard_v1 *keyboard;
static struct xkb_keymap *keymap;
static struct xkb_state *state;
static int extent_width = 1280, extent_height = 720;
static double pointer_x, pointer_y;

static uint32_t now_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint32_t)(ts.tv_sec * 1000 + ts.tv_nsec / 1000000);
}

static void sleep_ms(int ms) {
    struct timespec ts = {ms / 1000, (long)(ms % 1000) * 1000000};
    nanosleep(&ts, NULL);
}

static void global(void *data, struct wl_registry *registry, uint32_t name, const char *interface,
                   uint32_t version) {
    if (!strcmp(interface, wl_seat_interface.name))
        seat = wl_registry_bind(registry, name, &wl_seat_interface, 1);
    else if (!strcmp(interface, zwlr_virtual_pointer_manager_v1_interface.name))
        pointer_manager =
            wl_registry_bind(registry, name, &zwlr_virtual_pointer_manager_v1_interface, 1);
    else if (!strcmp(interface, zwp_virtual_keyboard_manager_v1_interface.name))
        keyboard_manager =
            wl_registry_bind(registry, name, &zwp_virtual_keyboard_manager_v1_interface, 1);
}

static void global_remove(void *data, struct wl_registry *registry, uint32_t name) {}

static const struct wl_registry_listener registry_listener = {global, global_remove};

static void setup_keyboard(void) {
    struct xkb_context *context = xkb_context_new(XKB_CONTEXT_NO_FLAGS);
    keymap = xkb_keymap_new_from_names(context, NULL, XKB_KEYMAP_COMPILE_NO_FLAGS);
    state = xkb_state_new(keymap);
    char *text = xkb_keymap_get_as_string(keymap, XKB_KEYMAP_FORMAT_TEXT_V1);
    size_t size = strlen(text) + 1;
    int fd = memfd_create("keymap", MFD_CLOEXEC);
    if (fd < 0 || ftruncate(fd, (off_t)size) < 0 || write(fd, text, size) != (ssize_t)size) {
        perror("keymap");
        exit(1);
    }
    keyboard = zwp_virtual_keyboard_manager_v1_create_virtual_keyboard(keyboard_manager, seat);
    zwp_virtual_keyboard_v1_keymap(keyboard, WL_KEYBOARD_KEYMAP_FORMAT_XKB_V1, fd, (uint32_t)size);
    close(fd);
    free(text);
    xkb_context_unref(context);
}

struct key_search {
    xkb_keysym_t sym;
    xkb_keycode_t found;
    bool shifted;
};

static void search_key(struct xkb_keymap *map, xkb_keycode_t code, void *data) {
    struct key_search *search = data;
    if (search->found) return;
    for (xkb_level_index_t level = 0; level < 2; level++) {
        const xkb_keysym_t *syms;
        int count = xkb_keymap_key_get_syms_by_level(map, code, 0, level, &syms);
        for (int i = 0; i < count; i++) {
            if (syms[i] == search->sym) {
                search->found = code;
                search->shifted = level == 1;
                return;
            }
        }
    }
}

/* The evdev code typing SYM, and whether it needs Shift. */
static bool key_for(xkb_keysym_t sym, uint32_t *code, bool *shifted) {
    struct key_search search = {sym, 0, false};
    xkb_keymap_key_for_each(keymap, search_key, &search);
    if (!search.found) return false;
    *code = search.found - 8;
    *shifted = search.shifted;
    return true;
}

static FILE *marks;

static uint64_t now_ns(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint64_t)ts.tv_sec * 1000000000 + (uint64_t)ts.tv_nsec;
}

static void send_key(uint32_t code, bool pressed) {
    /* DRIVE_MARKS: when each key press went out, for latency measurements. */
    if (marks && pressed && code != KEY_LEFTSHIFT) {
        fprintf(marks, "key %llu\n", (unsigned long long)now_ns());
        fflush(marks);
    }
    zwp_virtual_keyboard_v1_key(keyboard, now_ms(), code,
                                pressed ? WL_KEYBOARD_KEY_STATE_PRESSED
                                        : WL_KEYBOARD_KEY_STATE_RELEASED);
    xkb_state_update_key(state, code + 8, pressed ? XKB_KEY_DOWN : XKB_KEY_UP);
    zwp_virtual_keyboard_v1_modifiers(
        keyboard, xkb_state_serialize_mods(state, XKB_STATE_MODS_DEPRESSED),
        xkb_state_serialize_mods(state, XKB_STATE_MODS_LATCHED),
        xkb_state_serialize_mods(state, XKB_STATE_MODS_LOCKED),
        xkb_state_serialize_layout(state, XKB_STATE_LAYOUT_EFFECTIVE));
    wl_display_roundtrip(display);
}

static bool tap_sym(xkb_keysym_t sym) {
    uint32_t code;
    bool shifted;
    if (!key_for(sym, &code, &shifted)) return false;
    if (shifted) send_key(KEY_LEFTSHIFT, true);
    send_key(code, true);
    sleep_ms(8);
    send_key(code, false);
    if (shifted) send_key(KEY_LEFTSHIFT, false);
    return true;
}

static uint32_t modifier_code(const char *name) {
    if (!strcasecmp(name, "super") || !strcasecmp(name, "logo")) return KEY_LEFTMETA;
    if (!strcasecmp(name, "ctrl") || !strcasecmp(name, "control")) return KEY_LEFTCTRL;
    if (!strcasecmp(name, "alt")) return KEY_LEFTALT;
    if (!strcasecmp(name, "shift")) return KEY_LEFTSHIFT;
    return 0;
}

static uint32_t button_code(const char *name) {
    if (!strcmp(name, "left")) return BTN_LEFT;
    if (!strcmp(name, "right")) return BTN_RIGHT;
    if (!strcmp(name, "middle")) return BTN_MIDDLE;
    return (uint32_t)strtoul(name, NULL, 0);
}

static void move_to(double x, double y) {
    pointer_x = x;
    pointer_y = y;
    zwlr_virtual_pointer_v1_motion_absolute(pointer, now_ms(), (uint32_t)(x * 16),
                                            (uint32_t)(y * 16), (uint32_t)extent_width * 16,
                                            (uint32_t)extent_height * 16);
    zwlr_virtual_pointer_v1_frame(pointer);
    wl_display_roundtrip(display);
}

static void button(uint32_t code, bool pressed) {
    zwlr_virtual_pointer_v1_button(pointer, now_ms(), code,
                                   pressed ? WL_POINTER_BUTTON_STATE_PRESSED
                                           : WL_POINTER_BUTTON_STATE_RELEASED);
    zwlr_virtual_pointer_v1_frame(pointer);
    wl_display_roundtrip(display);
}

static bool run(char *line) {
    /* "type" takes the rest of the line as it is. */
    if (!strncmp(line, "type ", 5)) {
        for (char *p = line + 5; *p && *p != '\n'; p++) {
            xkb_keysym_t sym =
                *p == ' ' ? XKB_KEY_space : xkb_utf32_to_keysym((uint32_t)(unsigned char)*p);
            if (!tap_sym(sym)) {
                fprintf(stderr, "drive: cannot type %c\n", *p);
                return false;
            }
        }
        return true;
    }
    if (!strncmp(line, "spawn ", 6)) {
        line[strcspn(line, "\n")] = '\0';
        char *argv[] = {"/bin/sh", "-c", line + 6, NULL};
        pid_t pid;
        return posix_spawn(&pid, "/bin/sh", NULL, NULL, argv, environ) == 0;
    }
    char *save;
    char *command = strtok_r(line, " \t\n", &save);
    if (!command || command[0] == '#') return true;
    char *a = strtok_r(NULL, " \t\n", &save), *b = strtok_r(NULL, " \t\n", &save);
    char *c = strtok_r(NULL, " \t\n", &save);
    if (!strcmp(command, "extent") && a && b) {
        extent_width = atoi(a);
        extent_height = atoi(b);
    } else if (!strcmp(command, "move") && a && b) {
        move_to(atof(a), atof(b));
    } else if (!strcmp(command, "glide") && a && b && c) {
        double x0 = pointer_x, y0 = pointer_y, x1 = atof(a), y1 = atof(b);
        int steps = (atoi(c) + 7) / 8;
        for (int i = 1; i <= steps; i++) {
            move_to(x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps);
            sleep_ms(8);
        }
    } else if (!strcmp(command, "down") && a) {
        button(button_code(a), true);
    } else if (!strcmp(command, "up") && a) {
        button(button_code(a), false);
    } else if (!strcmp(command, "click") && a) {
        button(button_code(a), true);
        sleep_ms(30);
        button(button_code(a), false);
    } else if (!strcmp(command, "wheel") && a) {
        int steps = atoi(a);
        for (int i = 0; i < abs(steps); i++) {
            int sign = steps < 0 ? -1 : 1;
            zwlr_virtual_pointer_v1_axis_source(pointer, WL_POINTER_AXIS_SOURCE_WHEEL);
            zwlr_virtual_pointer_v1_axis_discrete(pointer, now_ms(),
                                                  WL_POINTER_AXIS_VERTICAL_SCROLL,
                                                  wl_fixed_from_int(15 * sign), sign);
            zwlr_virtual_pointer_v1_frame(pointer);
            wl_display_roundtrip(display);
            sleep_ms(16);
        }
    } else if (!strcmp(command, "key")) {
        for (char *name = a; name; name = name == a   ? b
                                          : name == b ? c
                                                      : strtok_r(NULL, " \t\n", &save)) {
            xkb_keysym_t sym = xkb_keysym_from_name(name, XKB_KEYSYM_CASE_INSENSITIVE);
            if (sym == XKB_KEY_NoSymbol || !tap_sym(sym)) {
                fprintf(stderr, "drive: no key %s\n", name);
                return false;
            }
        }
    } else if (!strcmp(command, "chord") && a) {
        uint32_t held[4];
        int count = 0;
        char *part, *rest;
        char *last = NULL;
        for (part = strtok_r(a, "+", &rest); part; part = strtok_r(NULL, "+", &rest)) {
            uint32_t code = modifier_code(part);
            if (code && count < 4) {
                held[count++] = code;
                send_key(code, true);
            } else {
                last = part;
            }
        }
        bool ok = true;
        if (last) {
            xkb_keysym_t sym = xkb_keysym_from_name(last, XKB_KEYSYM_CASE_INSENSITIVE);
            uint32_t code;
            bool shifted;
            if (sym != XKB_KEY_NoSymbol && key_for(sym, &code, &shifted)) {
                send_key(code, true);
                sleep_ms(8);
                send_key(code, false);
            } else {
                fprintf(stderr, "drive: no key %s\n", last);
                ok = false;
            }
        }
        while (count-- > 0) send_key(held[count], false);
        return ok;
    } else if ((!strcmp(command, "hold") || !strcmp(command, "release")) && a && modifier_code(a)) {
        send_key(modifier_code(a), !strcmp(command, "hold"));
    } else if (!strcmp(command, "sleep") && a) {
        sleep_ms(atoi(a));
    } else {
        fprintf(stderr, "drive: unknown command %s\n", command);
        return false;
    }
    return true;
}

int main(void) {
    display = wl_display_connect(NULL);
    if (!display) {
        fprintf(stderr, "drive: no Wayland display\n");
        return 1;
    }
    struct wl_registry *registry = wl_display_get_registry(display);
    wl_registry_add_listener(registry, &registry_listener, NULL);
    wl_display_roundtrip(display);
    if (!seat || !pointer_manager || !keyboard_manager) {
        fprintf(stderr, "drive: the compositor offers no virtual input\n");
        return 1;
    }
    pointer = zwlr_virtual_pointer_manager_v1_create_virtual_pointer(pointer_manager, seat);
    setup_keyboard();
    wl_display_roundtrip(display);
    if (getenv("DRIVE_MARKS")) marks = fopen(getenv("DRIVE_MARKS"), "a");
    char line[4096];
    int status = 0;
    while (fgets(line, sizeof line, stdin)) {
        if (!run(line)) status = 1;
        fflush(stdout);
    }
    zwlr_virtual_pointer_v1_destroy(pointer);
    zwp_virtual_keyboard_v1_destroy(keyboard);
    wl_display_roundtrip(display);
    wl_display_disconnect(display);
    return status;
}
