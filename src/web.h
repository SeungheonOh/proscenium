/*
 * Web nodes' pages: Chromium, through CEF, rendering offscreen in a helper
 * process (web/, proscenium-web-helper) that hands each frame over as a dma-buf,
 * which becomes a GL texture drawn like any other. Without a Wayland display the
 * helper paints bitmaps into shared memory instead, uploaded here.
 *
 * One helper serves every page: it starts with the first page and stops when the
 * last one closes. Hidden pages paint nothing, and while no page is visible the
 * helper's processes are stopped (SIGSTOP) once it has had no command for a few
 * seconds, so Chromium's own timers cost nothing; the next command continues it.
 *
 * Everything runs on the event loop's thread. The module watches the helper on
 * the loop it was given and reports through each page's listener, never from
 * inside a call the compositor made. Only functions marked GL touch GL: call them
 * with the renderer's EGL context current. Nothing else needs a context, closing
 * a page included: its textures go at the next GL call (web_collect_garbage).
 *
 * Page coordinates are the CSS pixels the page is laid out in, (0, 0) at its
 * top left; the page covers its node's box however many pixels it rasters at.
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "geometry.h"

struct wl_event_loop;
struct web;
struct web_page;

/* What a page reports, each with the listener's DATA. Any callback may close any page. */
struct web_page_listener {
    /*
     * A frame, or a popup shown or hidden, awaits web_page_prepare while the page
     * is visible: schedule frames on the outputs showing it (all of them before
     * any has). It may come several times before the next prepare.
     */
    void (*frame)(struct web_page *page, void *data);
    /* The main frame loaded, with its HTTP STATUS; the page already has its props. */
    void (*load)(struct web_page *page, int status, void *data);
    /*
     * A load error, a crashed renderer, or the helper or its frames failing; after
     * the last, the page shows its last frame for good.
     */
    void (*error)(struct web_page *page, const char *message, void *data);
    /*
     * The page called proscenium.postMessage("stage", value), as the SDK's send(name,
     * value) does: PAYLOAD is value as JSON, {"name": ..., "value": ...}.
     */
    void (*message)(struct web_page *page, const char *payload, void *data);
};

struct web_page_options {
    /*
     * A URL (anything with "://", or data: and about: URLs) shown as it is; an
     * HTML file, served with its directory's other files; or a built app's
     * directory, whose index.html is shown. Relative paths resolve against the
     * compositor's working directory.
     */
    const char *src;
    /* The page's layout size in CSS pixels, held to 1..8192. */
    double width, height;
    /* Device pixels per CSS pixel to raster at, e.g. the largest output scale. */
    double scale;
    /* The node's revision; a later web_page_set_revision with another reloads. */
    double revision;
    const struct web_page_listener *listener;
    void *data;
};

/* A texture to draw for a page, premultiplied RGBA with its first row at the top. */
struct web_surface {
    uint32_t texture;
    int texture_width, texture_height;
    /* Where the texture goes, in page coordinates. */
    struct box box;
};

/*
 * Pages served by the helper at HELPER (NULL: $PROSCENIUM_WEB_HELPER, else
 * web/proscenium-web-helper beside the compositor's executable), which draws
 * with GPU dma-bufs through the compositor's WAYLAND_DISPLAY socket name (NULL
 * or "": bitmaps). Starts nothing until the first page.
 */
struct web *web_create(struct wl_event_loop *loop, const char *helper, const char *wayland_display);
/* Close every page left and stop the helper. Call web_release_graphics first. */
void web_destroy(struct web *web);
/* Why the last web_create or web_page_create on this thread failed. */
const char *web_error(void);
/* The running helper's process id (and process group), or 0 when none runs. */
int web_helper_pid(const struct web *web);
/*
 * GL. Delete the textures of pages closed since the last GL call, which hold
 * their buffers' memory: call it when drawing a frame, as one follows a close.
 */
void web_collect_garbage(struct web *web);
/*
 * GL. Delete every page's GL objects, as before the context goes away; the
 * next web_page_prepare imports their frames again.
 */
void web_release_graphics(struct web *web);

/*
 * A page for a node, starting the helper if none runs. The page loads
 * asynchronously and is visible until told otherwise. NULL, with web_error, when
 * SRC names nothing or the helper cannot start: retry only for another SRC.
 */
struct web_page *web_page_create(struct web *web, const struct web_page_options *options);
/* Close PAGE; it reports nothing more. Stops the helper with the last page. */
void web_page_close(struct web_page *page);
/* Report to DATA from now on, as when another node adopts the page. */
void web_page_set_listener_data(struct web_page *page, void *data);
/* Whether the helper hands this page's frames over as dma-bufs rather than bitmaps. */
bool web_page_dmabuf(const struct web_page *page);

/* Lay the page out at WIDTH x HEIGHT CSS pixels (held to 1..8192), keeping its raster scale. */
void web_page_resize(struct web_page *page, double width, double height);
void web_page_size(const struct web_page *page, double *width, double *height);
/*
 * Raster at SCALE device pixels per CSS pixel, once a zoom settles: the largest
 * on-screen scale among the outputs showing the page. Held to 0.5..3, and changes
 * under 15% are ignored, so small zooms keep the current raster.
 */
void web_page_set_raster_scale(struct web_page *page, double scale);
double web_page_raster_scale(const struct web_page *page);
/* Show or hide the page: hidden when no output showed it in its last frame. */
void web_page_set_visible(struct web_page *page, bool visible);
/*
 * The node's data: JSON text (or NULL for none) the page receives as an
 * "proscenium-message" event named "props" once loaded, again after every load, and
 * whenever it changes.
 */
void web_page_set_props(struct web_page *page, const char *json);
/* Reload the page when REVISION differs from the last one, as when its bundle rebuilt. */
void web_page_set_revision(struct web_page *page, double revision);

/*
 * GL. Take the page's newest frame into its textures. True when what
 * web_page_surfaces describes changed, with DAMAGE the page coordinates that
 * changed, in whole CSS pixels; damage it on every output showing the page.
 */
bool web_page_prepare(struct web_page *page, struct box *damage);
/*
 * What to draw, in order: the page, then the popup of an open <select>, if any.
 * Returns how many of OUT it filled (0 before the first frame). The textures
 * last until the page's next web_page_prepare, web_release_graphics or
 * web_page_close; a failed page keeps showing its last ones.
 */
int web_page_surfaces(const struct web_page *page, struct web_surface out[2]);

/* Give the page the keyboard, or take it away (which also releases its buttons and modifiers). */
void web_page_focus(struct web_page *page, bool focused);
/* The pointer moved to (X, Y) in page coordinates. */
void web_page_pointer_motion(struct web_page *page, double x, double y);
/* The pointer left the page. */
void web_page_pointer_leave(struct web_page *page);
/* BUTTON is a Linux code (BTN_LEFT, BTN_RIGHT, BTN_MIDDLE; others are ignored). */
void web_page_pointer_button(struct web_page *page, double x, double y, uint32_t button,
                             bool pressed);
/*
 * A wheel or finger scroll of DELTA along one axis, as wlr_pointer_axis_event
 * reports it; INVERTED for natural scrolling's relative direction.
 */
void web_page_pointer_axis(struct web_page *page, double x, double y, bool horizontal, double delta,
                           bool inverted);
/*
 * A key: KEYCODE as libinput reports it (without xkb's offset of 8), the KEYSYMS
 * xkb_state_key_get_syms gives for it, and MODIFIERS as wlr_keyboard_get_modifiers
 * gives them. Printable keys also type their text, unless Ctrl, Alt or Logo is held.
 */
void web_page_key(struct web_page *page, uint32_t keycode, const uint32_t *keysyms, int count,
                  bool pressed, uint32_t modifiers);
/* The keyboard's modifiers changed: wlr_keyboard_get_modifiers. */
void web_page_modifiers(struct web_page *page, uint32_t modifiers);
