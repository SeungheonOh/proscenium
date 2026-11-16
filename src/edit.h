/*
 * Editable text nodes, as <input> and <textarea>: a text node with `editable` keeps
 * its own buffer, caret, selection and undo history here, in the compositor. Keys
 * reach it while it has focus and pointer presses on it place the caret, in the same
 * turn of the event loop, and the frame that follows draws the result: typing never
 * waits for the director, which hears of the text as `input` events and may replace
 * it by declaring another (see docs/PROTOCOL.md, "Editable text").
 *
 * Offsets inside are bytes of the UTF-8 buffer; on the wire they are UTF-16 code
 * units, as a JavaScript string counts them.
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "json.h"
#include "media.h"
#include "server.h"

/* After a commit: make, keep or drop NODE's editor as `editable` says, and take in the
 * text the director declared, unless it only echoes what the editor reported. */
void edit_sync(struct server *server, struct node *node);
/* NODE is going: its editor, and whatever it waits for, with it. */
void edit_node_dead(struct server *server, struct node *node);
/*
 * What an editable NODE lays out: the text it shows (bullets for a password), its wrap
 * width (0 for one line) and a revision that changes with either. False for any other
 * node.
 */
bool edit_layout_text(const struct node *node, const char **text, double *wrap_width,
                      uint64_t *revision);
/* Whether NODE is an editable node showing its placeholder: its text is empty. */
bool edit_placeholder_shown(const struct node *node);
/* NODE's size: its declared box, or its text's with its padding. */
bool edit_node_size(struct server *server, const struct node *node, double *width, double *height);

/* Focus came to NODE (FOCUSED) or left it. */
void edit_focus(struct server *server, struct node *node, bool focused);

/* A key pressed or repeated on a focused editable node, as xkb names it. */
struct edit_key {
    /* Its keysym's name, e.g. "Left", "a", "BackSpace". */
    const char *name;
    /* What it types, composed already; empty for none. */
    const char *text;
    /* enum modifier bits held. */
    uint32_t modifiers;
};
/* Whether NODE asks for KEY as a keydown event instead of editing with it (captureKeys). */
bool edit_captures(const struct node *node, const struct edit_key *key);
/* Act on KEY; false when the editor has no use for it, which then goes on as keydown. */
bool edit_key(struct server *server, struct node *node, const struct edit_key *key);

/*
 * The pointer, in NODE's local units: a primary press the COUNTth in a quick run (2
 * selects words, 3 lines), EXTEND with Shift held, FOCUSING when it gave the node focus;
 * motion while it is held; its release.
 */
void edit_press(struct server *server, struct node *node, double x, double y, int count,
                bool extend, bool focusing);
void edit_drag(struct server *server, struct node *node, double x, double y);
void edit_release(struct server *server, struct node *node);
/* NODE is being dragged in, by a press it took. */
bool edit_dragging(const struct node *node);
/* A middle click at (X, Y): the primary selection goes in there. */
void edit_paste_primary(struct server *server, struct node *node, double x, double y);
/* Scroll a multi-line NODE by (DX, DY) pixels; false when it cannot go that way. */
bool edit_wheel(struct server *server, struct node *node, double dx, double dy);

/* The director's `edit` message on NODE: select, insert, undo, clipboard actions. */
bool edit_command(struct server *server, struct node *node, const struct json_value *message,
                  struct protocol_error *error);

/* What a frame draws of an editable node, in its local units. */
struct edit_view {
    /* Where its text's origin lies: past its padding, centered on one line, scrolled. */
    double origin_x, origin_y;
    /* The selection's rectangles and the caret, from the text's origin; borrowed until
     * the next call. */
    const struct media_rect *selection;
    int selection_count;
    bool caret_shown;
    struct media_rect caret;
    /* Straight-alpha colors. */
    double selection_color[4], caret_color[4];
};
/* NODE's view for a frame; false when it is not editable. */
bool edit_view(struct server *server, struct node *node, struct edit_view *view);
