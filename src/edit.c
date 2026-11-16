/*
 * Editable text nodes.
 *
 * Each editable text node has an editor holding its text, the caret and the
 * selection's other end (bytes of the UTF-8 text), the x a vertical move keeps to,
 * its scroll offset and its undo history. Its text node lays out what the editor
 * holds (content.c) on the main thread, where keys and pointer presses arrive, so
 * an edit, the layout it needs and the frame that draws it happen in one turn of the
 * event loop, and the caret and selection come from that same layout. Glyphs a new
 * character needs are rasterized by the frame drawing it.
 *
 * The director declares a value and hears of edits as `input` events, each carrying
 * the editor's revision. A declared value is taken in only when it is not the echo of
 * a report: one the director declares with the revision of the report it last heard
 * is compared with what that report said, so an echo arriving after newer keystrokes
 * never takes them back.
 *
 * The caret blinks on a timer armed for its next change, only while a field has
 * focus, and stops, shown, after a while without input.
 */
#include "edit.h"

#include <glib.h>
#include <math.h>
#include <stdio.h>
#include <strings.h>
#include <wlr/util/log.h>

#include "content.h"
#include "link.h"
#include "stage.h"

/* The longest text an editor holds, in bytes. */
#define TEXT_LIMIT (256 * 1024)
/* Undo history kept at most: steps, and bytes of text they hold. */
#define UNDO_STEPS 400
#define UNDO_BYTES (2 * 1024 * 1024)
/* Seconds typing goes on joining the step before. */
#define UNDO_JOIN 1.5
/* Reports remembered, to tell an echo of one from a value the director chose. */
#define REPORTS 128
/* The caret holds still this long after input, then blinks at this half period, as GTK's
 * and Chromium's do, and stops, shown, after this long without input. */
#define BLINK_HOLD 500
#define BLINK_HALF 530
#define BLINK_STOP 10.0
/* Milliseconds between steps of the scroll a drag past an edge makes. */
#define AUTOSCROLL_TICK 16
/* What a caret is kept clear of a single-line field's edges by, in logical pixels. */
#define CARET_MARGIN 1.0

static const double DEFAULT_SELECTION[4] = {0.22, 0.48, 0.95, 0.32};

enum step_kind {
    STEP_OTHER,
    STEP_TYPE,
    STEP_BACKSPACE,
    STEP_DELETE,
};

/* An edit as undo replays it: at AT, REMOVED gave way to INSERTED. */
struct undo_step {
    int at;
    char *removed, *inserted;
    int removed_length, inserted_length;
    int caret_before, anchor_before, caret_after, anchor_after;
    enum step_kind kind;
    double time;
};

enum drag_unit { DRAG_CHARACTER, DRAG_WORD, DRAG_LINE };

struct report {
    uint64_t revision, hash;
    size_t length;
};

struct editor {
    struct server *server;
    struct node *node;
    struct strbuf text;
    /* The caret and the selection's other end; equal when nothing is selected. */
    int caret, anchor;
    /* The caret at a wrapped line's start shows at the end of the line before. */
    bool upstream;
    /* The x Up and Down keep to, from the text's origin. */
    bool has_goal;
    double goal_x;
    double scroll_x, scroll_y;

    /* Counts changes to the text, whoever made them; reports carry it. */
    uint64_t revision;
    struct report reports[REPORTS];
    int report_count, report_next;
    /* What the director last declared, to see when it declares something new. */
    uint64_t declared_hash;
    double declared_revision;
    bool declared_has_revision, declared_known;
    /* Bumped with every change to what is laid out. */
    uint64_t generation;
    /* A password's bullets, made again when GENERATION moves past DISPLAY_GENERATION. */
    struct strbuf display;
    uint64_t display_generation;
    bool display_valid;

    struct vec undo, redo; /* struct undo_step */
    size_t undo_bytes;

    bool focused, caret_on;
    double last_input;
    struct wl_event_source *blink;

    /* A press dragging: the unit it selects by, the range it began with, where the
     * pointer is (local units), and the timer scrolling while it is past an edge. */
    bool dragging;
    enum drag_unit drag_unit;
    int drag_start, drag_end;
    double drag_x, drag_y;
    struct wl_event_source *autoscroll;

    struct clipboard_request *paste;
    /* Where a middle click's paste goes, or -1 for the selection. */
    int paste_at;

    /* The Emacs keymap's state: the mark is set (movement extends the selection); the
     * last key killed (a kill now joins it) or yanked (the text yanked, and which kill it
     * was, for M-y). A paste that is a yank notes its place as it lands. */
    bool mark, last_kill, this_kill, last_yank, this_yank, pasting_yank;
    bool yank_valid;
    int yank_start, yank_end, yank_index;

    /* What the director heard last: the selection, the size. */
    int reported_start, reported_end;
    double reported_width, reported_height;
    bool size_reported;

    struct media_rect *rects;
};

static struct editor *editor_of(const struct node *node) {
    return node && node->kind == KIND_TEXT ? node->editor : NULL;
}

/* Text and offsets. */

/* The UTF-16 code units of the first BYTES of TEXT, as JavaScript counts them. */
static size_t utf16_units(const char *text, size_t bytes) {
    size_t units = 0;
    for (size_t i = 0; i < bytes;) {
        unsigned char c = (unsigned char)text[i];
        size_t step = c < 0x80 ? 1 : c < 0xe0 ? 2 : c < 0xf0 ? 3 : 4;
        units += step == 4 ? 2 : 1;
        i += step;
    }
    return units;
}

/* The byte offset UNITS code units into TEXT, LENGTH bytes long, never inside a
 * character: one a unit count splits is left out. */
static int bytes_for_units(const char *text, size_t length, double units) {
    if (!(units > 0)) return 0;
    size_t counted = 0, i = 0;
    while (i < length) {
        unsigned char c = (unsigned char)text[i];
        size_t step = c < 0x80 ? 1 : c < 0xe0 ? 2 : c < 0xf0 ? 3 : 4;
        size_t width = step == 4 ? 2 : 1;
        if (counted + width > units) break;
        counted += width;
        i += step;
    }
    return (int)i;
}

static const char *text_of(const struct editor *e) {
    return e->text.data ? e->text.data : "";
}

static int text_length(const struct editor *e) {
    return (int)e->text.length;
}

/* INDEX on a character's first byte, within the text. */
static int clamp_byte(const struct editor *e, int index) {
    const char *text = text_of(e);
    if (index <= 0) return 0;
    if (index >= text_length(e)) return text_length(e);
    while (index > 0 && ((unsigned char)text[index] & 0xc0) == 0x80) index--;
    return index;
}

static bool flag(const struct editor *e, enum prop_key key) {
    return node_bool(e->node, key);
}

static bool multiline(const struct editor *e) {
    return flag(e, PROP_MULTILINE);
}

static bool password(const struct editor *e) {
    return flag(e, PROP_PASSWORD);
}

/* The bullet a password shows for each character: U+2022, three bytes. */
#define BULLET "\xe2\x80\xa2"
#define BULLET_BYTES 3

/* A buffer offset as an offset of what the layout shows, and back. */
static int to_display(const struct editor *e, int index) {
    if (!password(e)) return index;
    return BULLET_BYTES * (int)g_utf8_pointer_to_offset(text_of(e), text_of(e) + index);
}

static int from_display(const struct editor *e, int index) {
    if (!password(e)) return clamp_byte(e, index);
    long characters = g_utf8_strlen(text_of(e), text_length(e));
    long at = CLAMP((long)index / BULLET_BYTES, 0L, characters);
    return (int)(g_utf8_offset_to_pointer(text_of(e), at) - text_of(e));
}

static void selection_range(const struct editor *e, int *start, int *end) {
    *start = MIN(e->caret, e->anchor);
    *end = MAX(e->caret, e->anchor);
}

static bool has_selection(const struct editor *e) {
    return e->caret != e->anchor;
}

/*
 * TEXT, LENGTH bytes, as a field takes it, newly allocated: invalid UTF-8 replaced,
 * line breaks as "\n", control characters but tabs and line breaks dropped; on one line,
 * line breaks and the space around them become one space, as a pasted address joins up.
 */
static char *clean_text(const char *text, size_t length, bool lines, size_t *out_length) {
    gchar *valid = g_utf8_make_valid(text, (gssize)length);
    struct strbuf out;
    strbuf_init(&out);
    for (const char *p = valid; *p; p++) {
        unsigned char c = (unsigned char)*p;
        if (c == '\r') {
            if (p[1] == '\n') continue;
            c = '\n';
        }
        if (c == '\n' && !lines) {
            /* Spaces before the break go, and those after it. */
            while (out.length &&
                   (out.data[out.length - 1] == ' ' || out.data[out.length - 1] == '\t'))
                out.length--;
            while (p[1] == ' ' || p[1] == '\t' || p[1] == '\n' || p[1] == '\r') p++;
            if (out.length) strbuf_putc(&out, ' ');
            continue;
        }
        if ((c < 0x20 && c != '\n' && c != '\t') || c == 0x7f) continue;
        strbuf_putc(&out, (char)c);
    }
    g_free(valid);
    *out_length = out.length;
    if (!out.data) return xstrdup("");
    /* Spaces before a break were dropped by shortening it. */
    out.data[out.length] = '\0';
    return out.data;
}

/* Reports and events. */

static uint64_t text_hash(const char *text, size_t length) {
    return hash_bytes(HASH_SEED, text, length);
}

static void remember_report(struct editor *e) {
    e->reports[e->report_next] = (struct report){
        e->revision, text_hash(text_of(e), (size_t)text_length(e)), (size_t)text_length(e)};
    e->report_next = (e->report_next + 1) % REPORTS;
    if (e->report_count < REPORTS) e->report_count++;
}

static const struct report *find_report(const struct editor *e, uint64_t revision) {
    for (int i = 0; i < e->report_count; i++) {
        if (e->reports[i].revision == revision) return &e->reports[i];
    }
    return NULL;
}

static void write_selection(struct editor *e, struct json_writer *w) {
    int start, end;
    selection_range(e, &start, &end);
    json_key(w, "selection-start");
    json_int(w, (int64_t)utf16_units(text_of(e), (size_t)start));
    json_key(w, "selection-end");
    json_int(w, (int64_t)utf16_units(text_of(e), (size_t)end));
    json_key(w, "selection-direction");
    json_string(w, e->caret < e->anchor ? "backward" : "forward");
}

/* The text changed; REPLACED when it took a value the director declared. */
static void report_input(struct editor *e, bool replaced) {
    struct event event;
    if (!event_begin(e->server, &event, e->node, EVENT_INPUT)) return;
    if (replaced) {
        /* Never folded into typing after it: the director waits for this one. */
        event.coalesce = false;
        json_key(&event.writer, "replaced");
        json_bool(&event.writer, true);
    }
    json_key(&event.writer, "text");
    json_string_n(&event.writer, text_of(e), (size_t)text_length(e));
    json_key(&event.writer, "revision");
    json_int(&event.writer, (int64_t)e->revision);
    write_selection(e, &event.writer);
    event_end(e->server, &event);
}

static void report_selection(struct editor *e) {
    int start, end;
    selection_range(e, &start, &end);
    if (start == e->reported_start && end == e->reported_end) return;
    e->reported_start = start;
    e->reported_end = end;
    struct event event;
    if (!event_begin(e->server, &event, e->node, EVENT_SELECT)) return;
    write_selection(e, &event.writer);
    event_end(e->server, &event);
}

/* Layout. */

static const struct media_text_layout *layout_of(struct editor *e) {
    return content_text_layout(e->server, e->node);
}

/* The node's box and padding (top, right, bottom, left), and its content box's size. */
struct frame {
    double width, height, pad[4], content_width, content_height;
};

static void frame_of(struct editor *e, struct frame *f) {
    node_corners(e->node, PROP_PADDING, f->pad);
    for (int i = 0; i < 4; i++) f->pad[i] = isfinite(f->pad[i]) ? fmax(0, f->pad[i]) : 0;
    node_size(e->server, e->node, &f->width, &f->height);
    f->content_width = fmax(0, f->width - f->pad[1] - f->pad[3]);
    f->content_height = fmax(0, f->height - f->pad[0] - f->pad[2]);
}

/* Half the space a line height adds to a line, set above it as CSS sets half-leading. */
static double half_leading(const struct media_text_layout *layout) {
    return fmax(0, layout->metrics.spacing) / 2;
}

/* How tall the text grows to: its line boxes, up to maxLines of them when it says. */
static double grown_height(struct editor *e, const struct media_text_layout *layout) {
    int count;
    const struct media_line *lines = media_text_lines(layout, &count);
    if (!lines) return 0;
    int shown = count;
    if (node_given(e->node, PROP_MAX_LINES) && e->node->props[PROP_MAX_LINES].id > 0)
        shown = (int)MIN((int64_t)count, e->node->props[PROP_MAX_LINES].id);
    const struct media_line *last = &lines[shown - 1];
    return last->top + last->pitch - lines[0].top;
}

/* Where the text's origin lies in the node, before scrolling. */
static void text_origin(struct editor *e, const struct frame *f,
                        const struct media_text_layout *layout, double *x, double *y) {
    *x = f->pad[3];
    *y = f->pad[0];
    if (multiline(e)) {
        *y += half_leading(layout);
    } else {
        /* One line sits in the middle of its box, as in an <input>. */
        int count;
        const struct media_line *lines = media_text_lines(layout, &count);
        double height = lines ? lines[0].height : 0;
        *y += (f->content_height - height) / 2;
    }
}

/* The height a multi-line field scrolls within: its box, or the height it is about to
 * grow to while the director has yet to lay it out again. */
static double scroll_view_height(struct editor *e, const struct frame *f,
                                 const struct media_text_layout *layout) {
    if (!node_given(e->node, PROP_MAX_LINES)) return f->content_height;
    return fmax(f->content_height, grown_height(e, layout));
}

static void clamp_scroll(struct editor *e) {
    const struct media_text_layout *layout = layout_of(e);
    if (!layout) return;
    struct frame f;
    frame_of(e, &f);
    if (multiline(e)) {
        double room = fmax(0, layout->metrics.height + 2 * half_leading(layout) -
                                  scroll_view_height(e, &f, layout));
        e->scroll_y = CLAMP(e->scroll_y, 0.0, room);
        e->scroll_x = 0;
    } else {
        double room = fmax(0, layout->metrics.width + 2 * CARET_MARGIN - f.content_width);
        e->scroll_x = CLAMP(e->scroll_x, 0.0, room);
        e->scroll_y = 0;
    }
}

/* Scroll so the caret shows. */
static void reveal_caret(struct editor *e) {
    const struct media_text_layout *layout = layout_of(e);
    if (!layout) return;
    struct frame f;
    frame_of(e, &f);
    struct media_caret caret;
    media_text_caret(layout, to_display(e, e->caret), e->upstream, &caret);
    if (multiline(e)) {
        /* The caret's whole line box shows. */
        double view = scroll_view_height(e, &f, layout), half = half_leading(layout);
        double top = caret.y, bottom = caret.y + caret.height + 2 * half;
        if (top < e->scroll_y) e->scroll_y = top;
        if (bottom > e->scroll_y + view) e->scroll_y = bottom - view;
    } else {
        double view = f.content_width;
        if (caret.x - CARET_MARGIN < e->scroll_x) e->scroll_x = caret.x - CARET_MARGIN;
        if (caret.x + 2 * CARET_MARGIN > e->scroll_x + view)
            e->scroll_x = caret.x + 2 * CARET_MARGIN - view;
    }
    clamp_scroll(e);
}

/* Tell the director the size the text grew or shrank to, for a field growing with it. */
static void report_size(struct editor *e) {
    const struct media_text_layout *layout = layout_of(e);
    if (!layout) return;
    double width = layout->metrics.width, height = grown_height(e, layout);
    if (e->size_reported && width == e->reported_width && height == e->reported_height) return;
    e->size_reported = true;
    e->reported_width = width;
    e->reported_height = height;
    struct event event;
    if (!event_begin(e->server, &event, e->node, EVENT_MEASURE)) return;
    json_key(&event.writer, "width");
    json_number(&event.writer, width);
    json_key(&event.writer, "height");
    json_number(&event.writer, height);
    event_end(e->server, &event);
}

/* The caret blinking. */

static void redraw(struct editor *e) {
    scene_changed(e->server);
}

static int blink_fired(void *data) {
    struct editor *e = data;
    if (!e->focused) return 0;
    if (now_seconds() - e->last_input >= BLINK_STOP) {
        /* Left alone, it rests shown, and nothing runs. */
        if (!e->caret_on) {
            e->caret_on = true;
            redraw(e);
        }
        return 0;
    }
    e->caret_on = !e->caret_on;
    redraw(e);
    wl_event_source_timer_update(e->blink, BLINK_HALF);
    return 0;
}

/* Input happened: the caret shows, still, and blinks again in a moment. */
static void touch(struct editor *e) {
    e->last_input = now_seconds();
    if (!e->focused) return;
    e->caret_on = true;
    if (!e->blink) e->blink = wl_event_loop_add_timer(e->server->loop, blink_fired, e);
    wl_event_source_timer_update(e->blink, BLINK_HOLD);
}

static void stop_blink(struct editor *e) {
    if (e->blink) wl_event_source_timer_update(e->blink, 0);
}

/* Changes. */

/* As X has it: what is selected is the primary selection, a middle click away. */
static void offer_primary(struct editor *e) {
    if (!has_selection(e) || password(e) || !e->focused) return;
    int start, end;
    selection_range(e, &start, &end);
    clipboard_set_primary_text(e->server, text_of(e) + start, (size_t)(end - start));
}

/* The selection changed, or the caret moved. */
static void moved(struct editor *e) {
    reveal_caret(e);
    touch(e);
    redraw(e);
    report_selection(e);
    if (!e->dragging) offer_primary(e);
}

/* The text changed: laid out again, revealed, reported. */
static void changed(struct editor *e, bool report) {
    latency_changed(e->server);
    /* An edit ends the region the mark started, and what a yank put in is changed. */
    e->mark = false;
    e->yank_valid = false;
    e->generation++;
    e->revision++;
    remember_report(e);
    /* A value set while out of focus shows from its start, as a <textarea>'s does. */
    if (e->focused) reveal_caret(e);
    else clamp_scroll(e);
    touch(e);
    redraw(e);
    if (report) report_input(e, false);
    /* The selection the input event carried is the director's now. */
    selection_range(e, &e->reported_start, &e->reported_end);
    report_size(e);
}

static void step_free(struct undo_step *step) {
    free(step->removed);
    free(step->inserted);
}

static void clear_steps(struct editor *e, struct vec *steps) {
    VEC_FOR(steps, struct undo_step, step) {
        e->undo_bytes -= (size_t)(step->removed_length + step->inserted_length);
        step_free(step);
    }
    vec_clear(steps);
}

/* Keep the history within its bounds, the oldest steps going first. */
static void trim_undo(struct editor *e) {
    while (e->undo.length && (e->undo.length > UNDO_STEPS || e->undo_bytes > UNDO_BYTES)) {
        struct undo_step *oldest = vec_at(&e->undo, 0);
        e->undo_bytes -= (size_t)(oldest->removed_length + oldest->inserted_length);
        step_free(oldest);
        vec_remove(&e->undo, 0);
    }
}

static bool is_space(const char *text, int length) {
    return length > 0 && g_unichar_isspace(g_utf8_get_char(text));
}

/* Note the edit about to replace FROM..TO with INSERT, joining the step before when it
 * goes on typing or deleting the same way. */
static void record(struct editor *e, int from, int to, const char *insert, int length,
                   enum step_kind kind) {
    double now = now_seconds();
    clear_steps(e, &e->redo);
    struct undo_step *last = e->undo.length ? vec_at(&e->undo, e->undo.length - 1) : NULL;
    bool recent = last && last->kind == kind && now - last->time < UNDO_JOIN &&
                  last->caret_after == e->caret && !has_selection(e);
    if (recent && kind == STEP_TYPE && from == to && last->at + last->inserted_length == from &&
        /* A word typed after a space starts a step of its own. */
        !(last->inserted_length && !is_space(insert, length) &&
          g_unichar_isspace(g_utf8_get_char(
              g_utf8_find_prev_char(last->inserted, last->inserted + last->inserted_length))))) {
        last->inserted = xrealloc(last->inserted, (size_t)(last->inserted_length + length) + 1);
        memcpy(last->inserted + last->inserted_length, insert, (size_t)length);
        last->inserted_length += length;
        last->inserted[last->inserted_length] = '\0';
        last->caret_after = last->anchor_after = to + length;
        last->time = now;
        e->undo_bytes += (size_t)length;
        trim_undo(e);
        return;
    }
    if (recent && length == 0 &&
        ((kind == STEP_BACKSPACE && to == last->at) || (kind == STEP_DELETE && from == last->at))) {
        int removed = to - from;
        char *joined = xmalloc((size_t)(last->removed_length + removed) + 1);
        if (kind == STEP_BACKSPACE) {
            memcpy(joined, text_of(e) + from, (size_t)removed);
            memcpy(joined + removed, last->removed, (size_t)last->removed_length);
            last->at = from;
        } else {
            memcpy(joined, last->removed, (size_t)last->removed_length);
            memcpy(joined + last->removed_length, text_of(e) + from, (size_t)removed);
        }
        free(last->removed);
        last->removed = joined;
        last->removed_length += removed;
        last->removed[last->removed_length] = '\0';
        last->caret_after = last->anchor_after = from;
        last->time = now;
        e->undo_bytes += (size_t)removed;
        trim_undo(e);
        return;
    }
    struct undo_step *step = vec_push(&e->undo);
    *step = (struct undo_step){
        .at = from,
        .removed = xstrndup(text_of(e) + from, (size_t)(to - from)),
        .removed_length = to - from,
        .inserted = xstrndup(insert, (size_t)length),
        .inserted_length = length,
        .caret_before = e->caret,
        .anchor_before = e->anchor,
        .caret_after = from + length,
        .anchor_after = from + length,
        .kind = kind,
        .time = now,
    };
    e->undo_bytes += (size_t)(to - from + length);
    trim_undo(e);
}

/* Put LENGTH bytes of TEXT, clean already, in place of bytes FROM..TO. */
static void splice(struct editor *e, int from, int to, const char *text, int length) {
    struct strbuf next;
    strbuf_init(&next);
    strbuf_append(&next, text_of(e), (size_t)from);
    strbuf_append(&next, text, (size_t)length);
    strbuf_append(&next, text_of(e) + to, (size_t)(text_length(e) - to));
    strbuf_finish(&e->text);
    e->text = next;
}

/*
 * Replace FROM..TO with INSERT, LENGTH bytes, as the user edits: cleaned, cut to what
 * maxLength and the size limit leave room for, recorded for undo as KIND, the caret
 * after it. False when nothing changed, a read-only field among them.
 */
static bool replace(struct editor *e, int from, int to, const char *insert, size_t length,
                    enum step_kind kind) {
    if (flag(e, PROP_READ_ONLY)) return false;
    from = clamp_byte(e, from);
    to = clamp_byte(e, MAX(from, to));
    size_t clean_length;
    char *clean = clean_text(insert ? insert : "", length, multiline(e), &clean_length);
    /* Room left, in bytes and in the code units maxLength counts. */
    size_t room = TEXT_LIMIT - (size_t)(text_length(e) - (to - from));
    if (clean_length > room) clean_length = (size_t)bytes_for_units(clean, room, (double)room);
    if (node_has_number(e->node, PROP_MAX_LENGTH)) {
        double limit = fmax(0, node_number(e->node, PROP_MAX_LENGTH, 0));
        double kept = (double)utf16_units(text_of(e), (size_t)text_length(e)) -
                      (double)utf16_units(text_of(e) + from, (size_t)(to - from));
        double left = fmax(0, limit - kept);
        clean_length = (size_t)bytes_for_units(clean, clean_length, left);
    }
    if (from == to && clean_length == 0) {
        free(clean);
        return false;
    }
    record(e, from, to, clean, (int)clean_length, kind);
    splice(e, from, to, clean, (int)clean_length);
    free(clean);
    e->caret = e->anchor = from + (int)clean_length;
    e->upstream = false;
    e->has_goal = false;
    changed(e, true);
    return true;
}

static bool delete_selection(struct editor *e) {
    int start, end;
    selection_range(e, &start, &end);
    return start != end && replace(e, start, end, "", 0, STEP_OTHER);
}

static void insert_text(struct editor *e, const char *text, size_t length, enum step_kind kind) {
    int start, end;
    selection_range(e, &start, &end);
    replace(e, start, end, text, length, kind);
}

/* Undo the last step, or with REDO do again the last one undone. */
static bool undo(struct editor *e, bool redo) {
    if (flag(e, PROP_READ_ONLY)) return false;
    struct vec *from = redo ? &e->redo : &e->undo, *to = redo ? &e->undo : &e->redo;
    if (!from->length) return false;
    struct undo_step step = *(struct undo_step *)vec_at(from, from->length - 1);
    from->length--;
    if (redo) {
        splice(e, step.at, step.at + step.removed_length, step.inserted, step.inserted_length);
        e->caret = step.caret_after;
        e->anchor = step.anchor_after;
    } else {
        splice(e, step.at, step.at + step.inserted_length, step.removed, step.removed_length);
        e->caret = step.caret_before;
        e->anchor = step.anchor_before;
    }
    step.time = 0;
    *(struct undo_step *)vec_push(to) = step;
    e->caret = clamp_byte(e, e->caret);
    e->anchor = clamp_byte(e, e->anchor);
    e->upstream = false;
    e->has_goal = false;
    changed(e, true);
    return true;
}

/* Moving. */

/* The caret to INDEX (bytes), the selection kept with EXTEND. */
static void move_to(struct editor *e, int index, bool upstream, bool extend, bool keep_goal) {
    index = clamp_byte(e, index);
    e->caret = index;
    if (!extend) e->anchor = index;
    e->upstream = upstream;
    if (!keep_goal) e->has_goal = false;
    moved(e);
}

static void select_range(struct editor *e, int anchor, int caret) {
    e->anchor = clamp_byte(e, anchor);
    e->caret = clamp_byte(e, caret);
    e->upstream = false;
    e->has_goal = false;
    moved(e);
}

/* The byte offset ONE STEP from the caret, through the layout. */
static int step_from(struct editor *e, int index, int direction, enum media_step step) {
    const struct media_text_layout *layout = layout_of(e);
    if (!layout) return index;
    return from_display(e, media_text_step(layout, to_display(e, index), direction, step));
}

/* Whether the line the caret is on runs right to left. */
static bool caret_line_rtl(struct editor *e) {
    const struct media_text_layout *layout = layout_of(e);
    int count;
    const struct media_line *lines = layout ? media_text_lines(layout, &count) : NULL;
    if (!lines) return false;
    return lines[media_text_line_of(layout, to_display(e, e->caret), e->upstream)].rtl;
}

/* Up or Down by visual lines, LINES of them, keeping to the goal x. */
static void move_lines(struct editor *e, int lines_by, bool extend) {
    const struct media_text_layout *layout = layout_of(e);
    if (!layout) return;
    int count;
    if (!media_text_lines(layout, &count)) return;
    struct media_caret caret;
    media_text_caret(layout, to_display(e, e->caret), e->upstream, &caret);
    if (!e->has_goal) {
        e->has_goal = true;
        e->goal_x = caret.x;
    }
    int target = caret.line + lines_by;
    if (target < 0) return move_to(e, 0, false, extend, true);
    if (target >= count) return move_to(e, text_length(e), false, extend, true);
    bool upstream;
    int index = media_text_line_hit(layout, target, e->goal_x, &upstream);
    move_to(e, from_display(e, index), upstream, extend, true);
}

/* Home and End: the visual line's ends. */
static void move_line_end(struct editor *e, bool end, bool extend) {
    const struct media_text_layout *layout = layout_of(e);
    int count;
    const struct media_line *lines = layout ? media_text_lines(layout, &count) : NULL;
    if (!lines) return;
    int line = media_text_line_of(layout, to_display(e, e->caret), e->upstream);
    const struct media_line *at = &lines[line];
    int index = end ? at->start + at->length : at->start;
    /* A wrapped line's end is the next one's start, shown at this line's end. */
    move_to(e, from_display(e, index), end && at->wrapped, extend, false);
}

/* Clipboard. */

static void copy_selection(struct editor *e) {
    if (password(e) || !has_selection(e)) return;
    int start, end;
    selection_range(e, &start, &end);
    clipboard_copy_text(e->server, text_of(e) + start, (size_t)(end - start));
}

static void cut_selection(struct editor *e) {
    if (password(e) || flag(e, PROP_READ_ONLY) || !has_selection(e)) return;
    copy_selection(e);
    delete_selection(e);
}

/*
 * The kill ring, shared by every field, as Emacs's is by every buffer: the newest kill
 * first. A kill also goes to the clipboard, and a yank takes the clipboard, so C-y after
 * copying in another window pastes that, and it joins the ring.
 */
#define KILL_RING 16
static struct {
    char *items[KILL_RING];
    size_t lengths[KILL_RING];
    int count;
} kill_ring;

static void ring_push(const char *text, size_t length) {
    if (kill_ring.count == KILL_RING) free(kill_ring.items[--kill_ring.count]);
    memmove(kill_ring.items + 1, kill_ring.items, kill_ring.count * sizeof *kill_ring.items);
    memmove(kill_ring.lengths + 1, kill_ring.lengths, kill_ring.count * sizeof *kill_ring.lengths);
    kill_ring.items[0] = xstrndup(text, length);
    kill_ring.lengths[0] = length;
    kill_ring.count++;
}

static void pasted(void *data, const char *text, size_t length) {
    struct editor *e = data;
    e->paste = NULL;
    bool yank = e->pasting_yank;
    e->pasting_yank = false;
    if (!text || !length) return;
    if (e->paste_at >= 0) {
        int at = clamp_byte(e, e->paste_at);
        e->caret = e->anchor = at;
    }
    if (yank && !(kill_ring.count && kill_ring.lengths[0] == length &&
                  !memcmp(kill_ring.items[0], text, length)))
        ring_push(text, length);
    int start, end;
    selection_range(e, &start, &end);
    insert_text(e, text, length, STEP_OTHER);
    if (yank) {
        e->yank_valid = true;
        e->yank_start = start;
        e->yank_end = e->caret;
        e->yank_index = 0;
    }
}

/* Paste the clipboard, or with PRIMARY the primary selection, at AT or over the selection
 * (AT -1): at once when the compositor owns it, else when its owner has written it. */
static void paste(struct editor *e, bool primary, int at) {
    if (flag(e, PROP_READ_ONLY)) return;
    clipboard_cancel(e->paste);
    e->paste = NULL;
    e->paste_at = at;
    e->paste = clipboard_read_text(e->server, primary, pasted, e);
}

/* Keys. */

/* NAME less a keypad's "KP_", and the names of a page key as one. */
static const char *plain_name(const char *name) {
    if (!strncmp(name, "KP_", 3)) {
        const char *rest = name + 3;
        static const char *const keypad[] = {"Left",   "Right",  "Up",   "Down",    "Home",
                                             "End",    "Prior",  "Next", "Page_Up", "Page_Down",
                                             "Delete", "Insert", "Enter"};
        for (size_t i = 0; i < ARRAY_LENGTH(keypad); i++)
            if (!strcmp(rest, keypad[i])) return !strcmp(rest, "Enter") ? "Return" : rest;
    }
    if (!strcmp(name, "Page_Up")) return "Prior";
    if (!strcmp(name, "Page_Down")) return "Next";
    return name;
}

static bool modifier_named(const char *name, size_t length, uint32_t *bit) {
    static const struct {
        const char *name;
        uint32_t bit;
    } names[] = {{"shift", MOD_SHIFT}, {"control", MOD_CONTROL}, {"ctrl", MOD_CONTROL},
                 {"alt", MOD_ALT},     {"super", MOD_LOGO},      {"logo", MOD_LOGO},
                 {"meta", MOD_LOGO}};
    for (size_t i = 0; i < ARRAY_LENGTH(names); i++) {
        if (strlen(names[i].name) == length && !strncasecmp(name, names[i].name, length)) {
            *bit = names[i].bit;
            return true;
        }
    }
    return false;
}

bool edit_captures(const struct node *node, const struct edit_key *key) {
    const char *list = node_string(node, PROP_CAPTURE_KEYS);
    if (!list || !key->name[0]) return false;
    const char *name = plain_name(key->name);
    for (const char *p = list; *p;) {
        while (*p == ' ' || *p == ',') p++;
        const char *token = p;
        while (*p && *p != ' ' && *p != ',') p++;
        size_t length = (size_t)(p - token);
        if (!length) continue;
        /* MOD+MOD+NAME: every modifier named, and no other, held. */
        uint32_t wanted = 0;
        const char *rest = token;
        for (const char *plus; (plus = memchr(rest, '+', (size_t)(p - rest))) && plus + 1 < p;
             rest = plus + 1) {
            uint32_t bit;
            if (!modifier_named(rest, (size_t)(plus - rest), &bit)) break;
            wanted |= bit;
        }
        char wanted_name[64];
        snprintf(wanted_name, sizeof wanted_name, "%.*s", (int)(p - rest), rest);
        if (wanted == key->modifiers && !strcasecmp(plain_name(wanted_name), name)) return true;
    }
    return false;
}

static void submit(struct editor *e) {
    struct event event;
    if (!event_begin(e->server, &event, e->node, EVENT_SUBMIT)) return;
    json_key(&event.writer, "text");
    json_string_n(&event.writer, text_of(e), (size_t)text_length(e));
    json_key(&event.writer, "revision");
    json_int(&event.writer, (int64_t)e->revision);
    event_end(e->server, &event);
}

static void select_all(struct editor *e) {
    select_range(e, 0, text_length(e));
}

/* Commands: named operations the keymaps bind keys to, and the director can ask for. */
enum command {
    CMD_NONE,
    CMD_LEFT,
    CMD_RIGHT,
    CMD_WORD_LEFT,
    CMD_WORD_RIGHT,
    CMD_CHAR_BACK,
    CMD_CHAR_FORWARD,
    CMD_WORD_BACK,
    CMD_WORD_FORWARD,
    CMD_LINE_UP,
    CMD_LINE_DOWN,
    CMD_PAGE_UP,
    CMD_PAGE_DOWN,
    CMD_LINE_START,
    CMD_LINE_END,
    CMD_TEXT_START,
    CMD_TEXT_END,
    CMD_DELETE_BACK,
    CMD_DELETE_FORWARD,
    CMD_DELETE_WORD_BACK,
    CMD_DELETE_WORD_FORWARD,
    CMD_DELETE,
    CMD_KILL_WORD_BACK,
    CMD_KILL_WORD_FORWARD,
    CMD_KILL_REGION_OR_WORD,
    CMD_KILL_LINE,
    CMD_KILL_LINE_START,
    CMD_YANK,
    CMD_YANK_POP,
    CMD_TRANSPOSE_CHARS,
    CMD_TRANSPOSE_WORDS,
    CMD_UPCASE_WORD,
    CMD_DOWNCASE_WORD,
    CMD_CAPITALIZE_WORD,
    CMD_SET_MARK,
    CMD_CANCEL,
    CMD_OPEN_LINE,
    CMD_NEWLINE,
    CMD_RETURN,
    CMD_SELECT_ALL,
    CMD_COPY,
    CMD_COPY_REGION,
    CMD_CUT,
    CMD_PASTE,
    CMD_UNDO,
    CMD_REDO,
    CMD_COUNT,
};

/* Their names, as `edit` messages and the docs give them. */
static const char *const COMMAND_NAMES[CMD_COUNT] = {
    [CMD_LEFT] = "left",
    [CMD_RIGHT] = "right",
    [CMD_WORD_LEFT] = "word-left",
    [CMD_WORD_RIGHT] = "word-right",
    [CMD_CHAR_BACK] = "backward-char",
    [CMD_CHAR_FORWARD] = "forward-char",
    [CMD_WORD_BACK] = "backward-word",
    [CMD_WORD_FORWARD] = "forward-word",
    [CMD_LINE_UP] = "previous-line",
    [CMD_LINE_DOWN] = "next-line",
    [CMD_PAGE_UP] = "page-up",
    [CMD_PAGE_DOWN] = "page-down",
    [CMD_LINE_START] = "line-start",
    [CMD_LINE_END] = "line-end",
    [CMD_TEXT_START] = "text-start",
    [CMD_TEXT_END] = "text-end",
    [CMD_DELETE_BACK] = "delete-backward",
    [CMD_DELETE_FORWARD] = "delete-forward",
    [CMD_DELETE_WORD_BACK] = "delete-word-backward",
    [CMD_DELETE_WORD_FORWARD] = "delete-word-forward",
    [CMD_DELETE] = "delete",
    [CMD_KILL_WORD_BACK] = "backward-kill-word",
    [CMD_KILL_WORD_FORWARD] = "kill-word",
    [CMD_KILL_REGION_OR_WORD] = "kill-region",
    [CMD_KILL_LINE] = "kill-line",
    [CMD_KILL_LINE_START] = "kill-line-start",
    [CMD_YANK] = "yank",
    [CMD_YANK_POP] = "yank-pop",
    [CMD_TRANSPOSE_CHARS] = "transpose-chars",
    [CMD_TRANSPOSE_WORDS] = "transpose-words",
    [CMD_UPCASE_WORD] = "upcase-word",
    [CMD_DOWNCASE_WORD] = "downcase-word",
    [CMD_CAPITALIZE_WORD] = "capitalize-word",
    [CMD_SET_MARK] = "set-mark",
    [CMD_CANCEL] = "cancel",
    [CMD_OPEN_LINE] = "open-line",
    [CMD_NEWLINE] = "newline",
    [CMD_RETURN] = "return",
    [CMD_SELECT_ALL] = "select-all",
    [CMD_COPY] = "copy",
    [CMD_COPY_REGION] = "copy-region",
    [CMD_CUT] = "cut",
    [CMD_PASTE] = "paste",
    [CMD_UNDO] = "undo",
    [CMD_REDO] = "redo",
};

/* How Shift goes with a binding: never, extending the selection (movement), required, or
 * either way (keys Shift is needed to type, as < and _). */
enum shift_rule { SHIFT_NO, SHIFT_EXTENDS, SHIFT_YES, SHIFT_ANY };

struct binding {
    uint32_t modifiers; /* less Shift */
    const char *key;    /* keysym name, matched without case, keypad as the main keys */
    enum shift_rule shift;
    enum command command;
};

#define C MOD_CONTROL
#define M MOD_ALT

/* Both keymaps: what every text field on Linux does that no Emacs binding needs. */
static const struct binding COMMON_KEYS[] = {
    {0, "Left", SHIFT_EXTENDS, CMD_LEFT},
    {0, "Right", SHIFT_EXTENDS, CMD_RIGHT},
    {C, "Left", SHIFT_EXTENDS, CMD_WORD_LEFT},
    {C, "Right", SHIFT_EXTENDS, CMD_WORD_RIGHT},
    {0, "Up", SHIFT_EXTENDS, CMD_LINE_UP},
    {0, "Down", SHIFT_EXTENDS, CMD_LINE_DOWN},
    {0, "Prior", SHIFT_EXTENDS, CMD_PAGE_UP},
    {0, "Next", SHIFT_EXTENDS, CMD_PAGE_DOWN},
    {0, "Home", SHIFT_EXTENDS, CMD_LINE_START},
    {0, "End", SHIFT_EXTENDS, CMD_LINE_END},
    {C, "Home", SHIFT_EXTENDS, CMD_TEXT_START},
    {C, "End", SHIFT_EXTENDS, CMD_TEXT_END},
    {0, "BackSpace", SHIFT_ANY, CMD_DELETE_BACK},
    {C, "BackSpace", SHIFT_ANY, CMD_DELETE_WORD_BACK},
    {0, "Delete", SHIFT_NO, CMD_DELETE_FORWARD},
    {0, "Delete", SHIFT_YES, CMD_CUT},
    {C, "Delete", SHIFT_ANY, CMD_DELETE_WORD_FORWARD},
    {C, "Insert", SHIFT_NO, CMD_COPY},
    {0, "Insert", SHIFT_YES, CMD_PASTE},
    {0, "Return", SHIFT_ANY, CMD_RETURN},
    {C, "c", SHIFT_NO, CMD_COPY},
    {C, "x", SHIFT_NO, CMD_CUT},
    {C, "v", SHIFT_NO, CMD_PASTE},
    {C, "z", SHIFT_NO, CMD_UNDO},
    {C, "z", SHIFT_YES, CMD_REDO},
};

/* CUA, as browsers on Linux and Windows have it. */
static const struct binding STANDARD_KEYS[] = {
    {C, "a", SHIFT_NO, CMD_SELECT_ALL},
    {C, "y", SHIFT_NO, CMD_REDO},
};

/* Emacs and readline, as macOS text fields and GTK's Emacs key theme have them; where a
 * binding meets a standard one the Emacs meaning wins (see docs/GUIDE.md). */
static const struct binding EMACS_KEYS[] = {
    {C, "a", SHIFT_NO, CMD_LINE_START},
    {C, "a", SHIFT_YES, CMD_SELECT_ALL},
    {C, "e", SHIFT_EXTENDS, CMD_LINE_END},
    {C, "b", SHIFT_EXTENDS, CMD_CHAR_BACK},
    {C, "f", SHIFT_EXTENDS, CMD_CHAR_FORWARD},
    {C, "p", SHIFT_EXTENDS, CMD_LINE_UP},
    {C, "n", SHIFT_EXTENDS, CMD_LINE_DOWN},
    {M, "b", SHIFT_EXTENDS, CMD_WORD_BACK},
    {M, "f", SHIFT_EXTENDS, CMD_WORD_FORWARD},
    {M, "less", SHIFT_ANY, CMD_TEXT_START},
    {M, "greater", SHIFT_ANY, CMD_TEXT_END},
    {C, "d", SHIFT_NO, CMD_DELETE_FORWARD},
    {C, "h", SHIFT_NO, CMD_DELETE_BACK},
    {M, "d", SHIFT_NO, CMD_KILL_WORD_FORWARD},
    {M, "BackSpace", SHIFT_NO, CMD_KILL_WORD_BACK},
    {C, "w", SHIFT_NO, CMD_KILL_REGION_OR_WORD},
    {M, "w", SHIFT_NO, CMD_COPY_REGION},
    {C, "k", SHIFT_NO, CMD_KILL_LINE},
    {C, "u", SHIFT_NO, CMD_KILL_LINE_START},
    {C, "y", SHIFT_NO, CMD_YANK},
    {M, "y", SHIFT_NO, CMD_YANK_POP},
    {C, "t", SHIFT_NO, CMD_TRANSPOSE_CHARS},
    {M, "t", SHIFT_NO, CMD_TRANSPOSE_WORDS},
    {M, "u", SHIFT_NO, CMD_UPCASE_WORD},
    {M, "l", SHIFT_NO, CMD_DOWNCASE_WORD},
    {M, "c", SHIFT_NO, CMD_CAPITALIZE_WORD},
    {C, "space", SHIFT_NO, CMD_SET_MARK},
    {C, "g", SHIFT_NO, CMD_CANCEL},
    {C, "slash", SHIFT_NO, CMD_UNDO},
    {C, "underscore", SHIFT_ANY, CMD_UNDO},
    {C, "minus", SHIFT_YES, CMD_UNDO},
    {C, "o", SHIFT_NO, CMD_OPEN_LINE},
    {C, "j", SHIFT_NO, CMD_NEWLINE},
};

#undef C
#undef M

static const struct binding *find_binding(const struct binding *table, size_t count,
                                          const char *name, uint32_t modifiers) {
    bool shift = modifiers & MOD_SHIFT;
    uint32_t rest = modifiers & ~(uint32_t)MOD_SHIFT;
    for (size_t i = 0; i < count; i++) {
        const struct binding *b = &table[i];
        if (b->modifiers != rest || strcasecmp(b->key, name)) continue;
        if ((b->shift == SHIFT_NO && shift) || (b->shift == SHIFT_YES && !shift)) continue;
        return b;
    }
    return NULL;
}

/* The command KEY is bound to in NODE's keymap (Emacs unless it says standard). */
static const struct binding *lookup(const struct editor *e, const struct edit_key *key) {
    const char *name = plain_name(key->name);
    const struct binding *b = NULL;
    if (node_choice(e->node, PROP_KEYMAP) == KEYMAP_STANDARD)
        b = find_binding(STANDARD_KEYS, ARRAY_LENGTH(STANDARD_KEYS), name, key->modifiers);
    else b = find_binding(EMACS_KEYS, ARRAY_LENGTH(EMACS_KEYS), name, key->modifiers);
    if (!b) b = find_binding(COMMON_KEYS, ARRAY_LENGTH(COMMON_KEYS), name, key->modifiers);
    return b;
}

/* Kill FROM..TO: deleted (a read-only field keeps it) and put on the kill ring and the
 * clipboard, joined to the kill before when the last key killed too, after it going
 * forward and before it going BACKWARD. */
static void kill_range(struct editor *e, int from, int to, bool backward) {
    e->this_kill = true;
    from = clamp_byte(e, from);
    to = clamp_byte(e, to);
    if (from >= to) return;
    const char *text = text_of(e) + from;
    size_t length = (size_t)(to - from);
    if (!password(e)) {
        if (e->last_kill && kill_ring.count) {
            size_t old = kill_ring.lengths[0];
            char *joined = xmalloc(old + length + 1);
            if (backward) {
                memcpy(joined, text, length);
                memcpy(joined + length, kill_ring.items[0], old);
            } else {
                memcpy(joined, kill_ring.items[0], old);
                memcpy(joined + old, text, length);
            }
            joined[old + length] = '\0';
            free(kill_ring.items[0]);
            kill_ring.items[0] = joined;
            kill_ring.lengths[0] = old + length;
        } else {
            ring_push(text, length);
        }
        clipboard_copy_text(e->server, kill_ring.items[0], kill_ring.lengths[0]);
    }
    replace(e, from, to, "", 0, STEP_OTHER);
}

/* The end of the logical line (paragraph) at INDEX: its line break. */
static int paragraph_end(const struct editor *e, int index) {
    const char *text = text_of(e);
    while (index < text_length(e) && text[index] != '\n') index++;
    return index;
}

static int paragraph_start(const struct editor *e, int index) {
    const char *text = text_of(e);
    while (index > 0 && text[index - 1] != '\n') index--;
    return index;
}

/* C-t: the characters either side of the caret change places, the caret going past them;
 * at a line's end, the two before it. */
static void transpose_chars(struct editor *e) {
    int at = e->caret;
    if (at == text_length(e) || text_of(e)[at] == '\n') at = step_from(e, at, -1, MEDIA_STEP_CLUSTER);
    int before = step_from(e, at, -1, MEDIA_STEP_CLUSTER);
    int after = step_from(e, at, 1, MEDIA_STEP_CLUSTER);
    if (before >= at || after <= at || text_of(e)[before] == '\n' || text_of(e)[at] == '\n')
        return;
    struct strbuf swapped;
    strbuf_init(&swapped);
    strbuf_append(&swapped, text_of(e) + at, (size_t)(after - at));
    strbuf_append(&swapped, text_of(e) + before, (size_t)(at - before));
    replace(e, before, after, swapped.data, swapped.length, STEP_OTHER);
    strbuf_finish(&swapped);
}

/* M-t: the word before the caret (or at it) and the one after change places. */
static void transpose_words(struct editor *e) {
    int second_end = step_from(e, e->caret, 1, MEDIA_STEP_WORD);
    int second_start = step_from(e, second_end, -1, MEDIA_STEP_WORD);
    int first_start = step_from(e, second_start, -1, MEDIA_STEP_WORD);
    int first_end = step_from(e, first_start, 1, MEDIA_STEP_WORD);
    if (first_start >= second_start) {
        /* No word before the caret: the one after it and the next, as Emacs takes them. */
        first_start = second_start;
        first_end = second_end;
        second_end = step_from(e, first_end, 1, MEDIA_STEP_WORD);
        second_start = step_from(e, second_end, -1, MEDIA_STEP_WORD);
    }
    if (!(first_start < first_end && first_end <= second_start && second_start < second_end))
        return;
    struct strbuf swapped;
    strbuf_init(&swapped);
    strbuf_append(&swapped, text_of(e) + second_start, (size_t)(second_end - second_start));
    strbuf_append(&swapped, text_of(e) + first_end, (size_t)(second_start - first_end));
    strbuf_append(&swapped, text_of(e) + first_start, (size_t)(first_end - first_start));
    replace(e, first_start, second_end, swapped.data, swapped.length, STEP_OTHER);
    strbuf_finish(&swapped);
}

enum word_case { CASE_UPPER, CASE_LOWER, CASE_CAPITAL };

/* M-u, M-l, M-c: from the caret to the end of the word, the caret after it. */
static void case_word(struct editor *e, enum word_case how) {
    int from = e->caret, to = step_from(e, from, 1, MEDIA_STEP_WORD);
    if (from >= to) return;
    const char *text = text_of(e) + from;
    gssize length = to - from;
    gchar *out;
    if (how == CASE_UPPER) {
        out = g_utf8_strup(text, length);
    } else if (how == CASE_LOWER) {
        out = g_utf8_strdown(text, length);
    } else {
        /* The word's first letter up, the rest down. */
        gchar *lower = g_utf8_strdown(text, length);
        const char *first = lower;
        while (*first && !g_unichar_isalnum(g_utf8_get_char(first)))
            first = g_utf8_next_char(first);
        GString *built = g_string_new_len(lower, first - lower);
        if (*first) {
            gchar *up = g_utf8_strup(first, g_utf8_next_char(first) - first);
            g_string_append(built, up);
            g_free(up);
            g_string_append(built, g_utf8_next_char(first));
        }
        g_free(lower);
        out = g_string_free(built, FALSE);
    }
    replace(e, from, to, out, strlen(out), STEP_OTHER);
    g_free(out);
}

/* Move by a character or word logically (C-b, C-f, M-b, M-f), or visually (arrows); with
 * a selection and nothing extending it, to its start or end. */
static bool move_step(struct editor *e, int direction, enum command command, bool extend) {
    int start, end;
    selection_range(e, &start, &end);
    if (has_selection(e) && !extend && (command == CMD_LEFT || command == CMD_RIGHT ||
                                        command == CMD_CHAR_BACK || command == CMD_CHAR_FORWARD)) {
        move_to(e, direction < 0 ? start : end, false, false, false);
        return true;
    }
    int index = e->caret;
    if (command == CMD_LEFT || command == CMD_RIGHT) {
        const struct media_text_layout *layout = layout_of(e);
        if (layout)
            index = from_display(
                e, media_text_move_visually(layout, to_display(e, e->caret), direction));
    } else if (command == CMD_WORD_LEFT || command == CMD_WORD_RIGHT) {
        /* Words go by the text's direction on the line. */
        int logical = caret_line_rtl(e) ? -direction : direction;
        index = step_from(e, e->caret, logical, MEDIA_STEP_WORD);
    } else if (command == CMD_WORD_BACK || command == CMD_WORD_FORWARD) {
        index = step_from(e, e->caret, direction, MEDIA_STEP_WORD);
    } else {
        index = step_from(e, e->caret, direction, MEDIA_STEP_CLUSTER);
    }
    move_to(e, index, false, extend, false);
    return true;
}

/*
 * Run COMMAND, extending the selection with movement when EXTEND (Shift held, or the mark
 * set) and with SHIFT held for Return. False when it has nothing to do here, for the key
 * to go on as keydown: Up and Down on one line, copying nothing.
 */
static bool run_command(struct editor *e, enum command command, bool extend, bool shift) {
    bool lines = multiline(e), read_only = flag(e, PROP_READ_ONLY);
    int start, end;
    selection_range(e, &start, &end);
    switch (command) {
    case CMD_NONE:
    case CMD_COUNT: return false;
    case CMD_LEFT:
    case CMD_WORD_LEFT:
    case CMD_CHAR_BACK:
    case CMD_WORD_BACK: return move_step(e, -1, command, extend);
    case CMD_RIGHT:
    case CMD_WORD_RIGHT:
    case CMD_CHAR_FORWARD:
    case CMD_WORD_FORWARD: return move_step(e, 1, command, extend);
    case CMD_LINE_UP:
    case CMD_LINE_DOWN: {
        if (!lines) return false;
        int direction = command == CMD_LINE_UP ? -1 : 1;
        if (has_selection(e) && !extend && !e->has_goal)
            e->caret = e->anchor = direction < 0 ? start : end;
        move_lines(e, direction, extend);
        return true;
    }
    case CMD_PAGE_UP:
    case CMD_PAGE_DOWN: {
        if (!lines) return false;
        const struct media_text_layout *layout = layout_of(e);
        int count;
        const struct media_line *list = layout ? media_text_lines(layout, &count) : NULL;
        struct frame f;
        frame_of(e, &f);
        double pitch = list ? fmax(1, list[0].pitch) : 1;
        int page = MAX(1, (int)floor(f.content_height / pitch) - 1);
        move_lines(e, command == CMD_PAGE_UP ? -page : page, extend);
        return true;
    }
    case CMD_LINE_START:
    case CMD_LINE_END:
        if (lines) move_line_end(e, command == CMD_LINE_END, extend);
        else move_to(e, command == CMD_LINE_END ? text_length(e) : 0, false, extend, false);
        return true;
    case CMD_TEXT_START:
    case CMD_TEXT_END:
        move_to(e, command == CMD_TEXT_END ? text_length(e) : 0, false, extend, false);
        return true;
    case CMD_DELETE_BACK:
    case CMD_DELETE_WORD_BACK:
        if (has_selection(e)) delete_selection(e);
        else if (e->caret > 0)
            replace(e,
                    step_from(e, e->caret, -1,
                              command == CMD_DELETE_WORD_BACK ? MEDIA_STEP_WORD
                                                              : MEDIA_STEP_BACKSPACE),
                    e->caret, "", 0, STEP_BACKSPACE);
        touch(e);
        return true;
    case CMD_DELETE_FORWARD:
    case CMD_DELETE_WORD_FORWARD:
        if (has_selection(e)) delete_selection(e);
        else if (e->caret < text_length(e))
            replace(e, e->caret,
                    step_from(e, e->caret, 1,
                              command == CMD_DELETE_WORD_FORWARD ? MEDIA_STEP_WORD
                                                                 : MEDIA_STEP_CLUSTER),
                    "", 0, STEP_DELETE);
        touch(e);
        return true;
    case CMD_DELETE:
        delete_selection(e);
        return true;
    case CMD_KILL_WORD_BACK:
        kill_range(e, step_from(e, e->caret, -1, MEDIA_STEP_WORD), e->caret, true);
        return true;
    case CMD_KILL_WORD_FORWARD:
        kill_range(e, e->caret, step_from(e, e->caret, 1, MEDIA_STEP_WORD), false);
        return true;
    case CMD_KILL_REGION_OR_WORD:
        if (has_selection(e)) kill_range(e, start, end, e->caret < e->anchor);
        else kill_range(e, step_from(e, e->caret, -1, MEDIA_STEP_WORD), e->caret, true);
        return true;
    case CMD_KILL_LINE: {
        /* To the line's end; at its end, its line break. */
        int to = paragraph_end(e, e->caret);
        if (to == e->caret && to < text_length(e)) to++;
        kill_range(e, e->caret, to, false);
        return true;
    }
    case CMD_KILL_LINE_START:
        kill_range(e, paragraph_start(e, e->caret), e->caret, true);
        return true;
    case CMD_YANK:
        if (read_only) return true;
        e->this_yank = true;
        e->pasting_yank = true;
        paste(e, false, -1);
        return true;
    case CMD_YANK_POP: {
        if (read_only || !e->last_yank || !e->yank_valid || kill_ring.count < 2) return true;
        int index = (e->yank_index + 1) % kill_ring.count;
        int from = e->yank_start;
        replace(e, from, e->yank_end, kill_ring.items[index], kill_ring.lengths[index],
                STEP_OTHER);
        e->yank_valid = true;
        e->yank_start = from;
        e->yank_end = e->caret;
        e->yank_index = index;
        e->this_yank = true;
        return true;
    }
    case CMD_TRANSPOSE_CHARS: transpose_chars(e); return true;
    case CMD_TRANSPOSE_WORDS: transpose_words(e); return true;
    case CMD_UPCASE_WORD: case_word(e, CASE_UPPER); return true;
    case CMD_DOWNCASE_WORD: case_word(e, CASE_LOWER); return true;
    case CMD_CAPITALIZE_WORD: case_word(e, CASE_CAPITAL); return true;
    case CMD_SET_MARK:
        e->anchor = e->caret;
        moved(e);
        e->mark = true;
        return true;
    case CMD_CANCEL:
        e->mark = false;
        e->anchor = e->caret;
        moved(e);
        return true;
    case CMD_OPEN_LINE:
        if (!lines) return false;
        insert_text(e, "\n", 1, STEP_OTHER);
        if (!read_only) move_to(e, e->caret - 1, false, false, false);
        return true;
    case CMD_NEWLINE:
        if (!lines) return false;
        insert_text(e, "\n", 1, STEP_TYPE);
        return true;
    case CMD_RETURN:
        if (!lines || (flag(e, PROP_SUBMIT_ON_ENTER) && !shift)) submit(e);
        else insert_text(e, "\n", 1, STEP_TYPE);
        return true;
    case CMD_SELECT_ALL: select_all(e); return true;
    case CMD_COPY:
    case CMD_COPY_REGION:
        if (!has_selection(e)) return command == CMD_COPY_REGION;
        if (command == CMD_COPY_REGION && !password(e))
            ring_push(text_of(e) + start, (size_t)(end - start));
        copy_selection(e);
        e->mark = false;
        if (command == CMD_COPY_REGION) {
            e->anchor = e->caret;
            moved(e);
        }
        return true;
    case CMD_CUT:
        if (!has_selection(e)) return false;
        cut_selection(e);
        return true;
    case CMD_PASTE: paste(e, false, -1); return true;
    case CMD_UNDO:
    case CMD_REDO:
        undo(e, command == CMD_REDO);
        touch(e);
        return true;
    }
    return false;
}

/* Run COMMAND as a key would, keeping track of kills and yanks in a row. */
static bool command_key(struct editor *e, enum command command, bool extend, bool shift) {
    e->this_kill = e->this_yank = false;
    bool done = run_command(e, command, extend, shift);
    if (done) {
        e->last_kill = e->this_kill;
        e->last_yank = e->this_yank;
    }
    return done;
}

bool edit_key(struct server *server, struct node *node, const struct edit_key *key) {
    struct editor *e = editor_of(node);
    if (!e) return false;
    const struct binding *binding = lookup(e, key);
    if (binding) {
        bool shift = key->modifiers & MOD_SHIFT;
        bool extend = binding->shift == SHIFT_EXTENDS && (shift || e->mark);
        return command_key(e, binding->command, extend, shift);
    }
    /* Chords no keymap binds type nothing: they go on as keydown, to the world. */
    if (key->modifiers & (MOD_CONTROL | MOD_ALT | MOD_LOGO)) return false;
    const char *text = key->text;
    if (!text[0] || (unsigned char)text[0] < 0x20 || text[0] == 0x7f) return false;
    e->last_kill = e->last_yank = false;
    if (flag(e, PROP_READ_ONLY)) return true;
    insert_text(e, text, strlen(text), STEP_TYPE);
    return true;
}

/* The pointer. */

/* Node-local (X, Y) as a caret position, and whether it is a wrapped line's end. */
static int index_at(struct editor *e, double x, double y, bool *upstream) {
    *upstream = false;
    const struct media_text_layout *layout = layout_of(e);
    if (!layout) return 0;
    struct frame f;
    frame_of(e, &f);
    double ox, oy;
    text_origin(e, &f, layout, &ox, &oy);
    return from_display(
        e, media_text_hit(layout, x - ox + e->scroll_x, y - oy + e->scroll_y, upstream));
}

/* The run a press of UNIT takes at INDEX: the word, or the line (paragraph). */
static void unit_at(struct editor *e, int index, enum drag_unit unit, int *start, int *end) {
    *start = *end = index;
    const struct media_text_layout *layout = layout_of(e);
    if (unit == DRAG_WORD && layout) {
        int s, t;
        media_text_word_at(layout, to_display(e, index), &s, &t);
        *start = from_display(e, s);
        *end = from_display(e, t);
    } else if (unit == DRAG_LINE) {
        if (!multiline(e)) {
            *start = 0;
            *end = text_length(e);
            return;
        }
        const char *text = text_of(e);
        int s = index, t = index;
        while (s > 0 && text[s - 1] != '\n') s--;
        while (t < text_length(e) && text[t] != '\n') t++;
        /* A paragraph takes its line break, as a triple click does in a browser. */
        if (t < text_length(e)) t++;
        *start = s;
        *end = t;
    }
}

/* The selection a drag to INDEX makes, by its unit, from the run it began with. */
static void drag_to(struct editor *e, int index, bool upstream) {
    if (e->drag_unit == DRAG_CHARACTER) {
        e->caret = index;
        e->upstream = upstream;
    } else {
        int start, end;
        unit_at(e, index, e->drag_unit, &start, &end);
        if (index < e->drag_start) {
            e->anchor = e->drag_end;
            e->caret = start;
        } else {
            e->anchor = e->drag_start;
            e->caret = MAX(end, e->drag_end);
        }
        e->upstream = false;
    }
    e->has_goal = false;
    moved(e);
}

/* (X, Y) kept inside the content box: a drag past an edge selects up to what shows there,
 * and the scrolling it makes brings the rest. */
static void inside_content(struct editor *e, double *x, double *y) {
    struct frame f;
    frame_of(e, &f);
    *x = CLAMP(*x, f.pad[3], fmax(f.pad[3], f.width - f.pad[1]));
    *y = CLAMP(*y, f.pad[0], fmax(f.pad[0], f.height - f.pad[2] - 0.5));
}

/* How far, in local units, (X, Y) lies past the content box's edges along the field's axis. */
static double overshoot(struct editor *e, double x, double y) {
    struct frame f;
    frame_of(e, &f);
    if (multiline(e)) {
        double top = f.pad[0], bottom = f.height - f.pad[2];
        return y < top ? y - top : y > bottom ? y - bottom : 0;
    }
    double left = f.pad[3], right = f.width - f.pad[1];
    return x < left ? x - left : x > right ? x - right : 0;
}

static int autoscroll_fired(void *data) {
    struct editor *e = data;
    double past = e->dragging ? overshoot(e, e->drag_x, e->drag_y) : 0;
    if (past == 0) return 0;
    /* Faster the further past the edge: a pixel a tick close by, up to a page a second. */
    double speed = copysign(fmin(2 + fabs(past) * 0.35, 40), past);
    double before_x = e->scroll_x, before_y = e->scroll_y;
    if (multiline(e)) e->scroll_y += speed;
    else e->scroll_x += speed;
    clamp_scroll(e);
    bool scrolled = e->scroll_x != before_x || e->scroll_y != before_y;
    double x = e->drag_x, y = e->drag_y;
    inside_content(e, &x, &y);
    bool upstream;
    int index = index_at(e, x, y, &upstream);
    if (index != e->caret) drag_to(e, index, upstream);
    else if (scrolled) redraw(e);
    if (scrolled) wl_event_source_timer_update(e->autoscroll, AUTOSCROLL_TICK);
    return 0;
}

static void update_autoscroll(struct editor *e) {
    bool past = e->dragging && overshoot(e, e->drag_x, e->drag_y) != 0;
    if (!past) {
        if (e->autoscroll) wl_event_source_timer_update(e->autoscroll, 0);
        return;
    }
    if (!e->autoscroll)
        e->autoscroll = wl_event_loop_add_timer(e->server->loop, autoscroll_fired, e);
    wl_event_source_timer_update(e->autoscroll, AUTOSCROLL_TICK);
}

void edit_press(struct server *server, struct node *node, double x, double y, int count,
                bool extend, bool focusing) {
    struct editor *e = editor_of(node);
    if (!e) return;
    bool upstream;
    int index = index_at(e, x, y, &upstream);
    e->mark = e->last_kill = e->last_yank = false;
    int unit = (count - 1) % 3;
    e->drag_unit = unit == 0 ? DRAG_CHARACTER : unit == 1 ? DRAG_WORD : DRAG_LINE;
    e->dragging = true;
    e->drag_x = x;
    e->drag_y = y;
    if (focusing && flag(e, PROP_SELECT_ON_FOCUS) && count == 1 && !extend) {
        /* A field selecting all as it takes focus keeps it, as an address bar does. */
        e->drag_start = e->drag_end = -1 - index;
        return;
    }
    if (e->drag_unit == DRAG_CHARACTER) {
        e->drag_start = e->drag_end = index;
        e->caret = index;
        if (!extend) e->anchor = index;
        e->upstream = upstream;
        e->has_goal = false;
        moved(e);
        return;
    }
    int start, end;
    unit_at(e, index, e->drag_unit, &start, &end);
    e->drag_start = start;
    e->drag_end = end;
    if (extend) {
        /* Shift with a double click: the selection grows to whole words. */
        int anchor = e->anchor;
        e->drag_start = e->drag_end = anchor;
        drag_to(e, index, upstream);
        return;
    }
    select_range(e, start, end);
}

void edit_drag(struct server *server, struct node *node, double x, double y) {
    struct editor *e = editor_of(node);
    if (!e || !e->dragging) return;
    e->drag_x = x;
    e->drag_y = y;
    inside_content(e, &x, &y);
    bool upstream;
    int index = index_at(e, x, y, &upstream);
    if (e->drag_start < 0) {
        /* The press kept everything selected; dragging selects from where it was. */
        e->drag_start = e->drag_end = -1 - e->drag_start;
        e->anchor = e->drag_start;
    }
    if (index != e->caret || upstream != e->upstream) drag_to(e, index, upstream);
    update_autoscroll(e);
}

void edit_release(struct server *server, struct node *node) {
    struct editor *e = editor_of(node);
    if (!e || !e->dragging) return;
    e->dragging = false;
    update_autoscroll(e);
    offer_primary(e);
}

bool edit_dragging(const struct node *node) {
    const struct editor *e = editor_of(node);
    return e && e->dragging;
}

void edit_paste_primary(struct server *server, struct node *node, double x, double y) {
    struct editor *e = editor_of(node);
    if (!e || flag(e, PROP_READ_ONLY)) return;
    bool upstream;
    int index = index_at(e, x, y, &upstream);
    paste(e, true, index);
}

bool edit_wheel(struct server *server, struct node *node, double dx, double dy) {
    struct editor *e = editor_of(node);
    if (!e) return false;
    double before_x = e->scroll_x, before_y = e->scroll_y;
    if (multiline(e)) e->scroll_y += dy;
    else e->scroll_x += dx;
    clamp_scroll(e);
    if (e->scroll_x == before_x && e->scroll_y == before_y) return false;
    redraw(e);
    return true;
}

/* Focus. */

void edit_focus(struct server *server, struct node *node, bool focused) {
    struct editor *e = editor_of(node);
    if (!e || e->focused == focused) return;
    e->focused = focused;
    if (focused) {
        if (flag(e, PROP_SELECT_ON_FOCUS)) {
            e->anchor = 0;
            e->caret = text_length(e);
        }
        reveal_caret(e);
        touch(e);
        report_selection(e);
    } else {
        stop_blink(e);
        e->dragging = false;
        update_autoscroll(e);
        /* A single-line field shows its start again, as a browser's does. */
        if (!multiline(e)) e->scroll_x = 0;
    }
    redraw(e);
}

/* The director. */

/*
 * Take TEXT, LENGTH bytes, as the director declares it, having heard REPORT (or none): the
 * text replaced, the caret at its end, the history gone with what it undid. What was
 * typed since that report, when it only added to the end of what the report said, is
 * kept after the new text, as it would be had the director's change come at once: a
 * field cleared as Return sends it keeps what was typed after Return.
 */
static void take_declared(struct editor *e, const char *text, size_t length,
                          const struct report *report, bool answer) {
    size_t clean_length;
    char *clean = clean_text(text, length, multiline(e), &clean_length);
    if (clean_length > TEXT_LIMIT)
        clean_length = (size_t)bytes_for_units(clean, TEXT_LIMIT, TEXT_LIMIT);
    size_t kept = 0;
    if (report && report->length < (size_t)text_length(e) &&
        text_hash(text_of(e), report->length) == report->hash)
        kept = (size_t)text_length(e) - report->length;
    if (clean_length + kept > TEXT_LIMIT) kept = 0;
    bool same =
        !kept && clean_length == (size_t)text_length(e) && !memcmp(clean, text_of(e), clean_length);
    if (!same) {
        int caret_from_end = text_length(e) - e->caret;
        struct strbuf next;
        strbuf_init(&next);
        strbuf_append(&next, clean, clean_length);
        strbuf_append(&next, text_of(e) + text_length(e) - kept, kept);
        strbuf_finish(&e->text);
        e->text = next;
        e->caret = e->anchor =
            kept ? clamp_byte(e, text_length(e) - MIN(caret_from_end, (int)kept)) : text_length(e);
        e->upstream = false;
        e->has_goal = false;
        clear_steps(e, &e->undo);
        clear_steps(e, &e->redo);
        changed(e, false);
    }
    free(clean);
    /* The director hears what its value became, and the revision to declare it with: its
     * own value, or with what was typed since added. */
    if (answer) {
        selection_range(e, &e->reported_start, &e->reported_end);
        report_input(e, true);
    }
}

static void editor_free(struct editor *e) {
    clipboard_cancel(e->paste);
    if (e->blink) wl_event_source_remove(e->blink);
    if (e->autoscroll) wl_event_source_remove(e->autoscroll);
    clear_steps(e, &e->undo);
    clear_steps(e, &e->redo);
    vec_finish(&e->undo);
    vec_finish(&e->redo);
    strbuf_finish(&e->text);
    strbuf_finish(&e->display);
    free(e->rects);
    free(e);
}

void edit_sync(struct server *server, struct node *node) {
    if (node->kind != KIND_TEXT) return;
    struct editor *e = node->editor;
    bool editable = node->state == NODE_LIVE && node_bool(node, PROP_EDITABLE);
    if (!editable) {
        if (e) {
            node->editor = NULL;
            editor_free(e);
            scene_changed(server);
        }
        return;
    }
    if (!e) {
        e = xcalloc(1, sizeof *e);
        e->server = server;
        e->node = node;
        e->paste_at = -1;
        strbuf_init(&e->text);
        strbuf_init(&e->display);
        vec_init(&e->undo, sizeof(struct undo_step));
        vec_init(&e->redo, sizeof(struct undo_step));
        node->editor = e;
    }
    /* What the director declares now. */
    const char *declared = node_string(node, PROP_TEXT);
    size_t length = declared ? strlen(declared) : 0;
    uint64_t hash = text_hash(declared ? declared : "", length);
    bool has_revision = node_has_number(node, PROP_VALUE_REVISION);
    double revision = node_number(node, PROP_VALUE_REVISION, 0);
    bool fresh = !e->declared_known || hash != e->declared_hash ||
                 has_revision != e->declared_has_revision || revision != e->declared_revision;
    if (fresh) {
        bool first = !e->declared_known;
        e->declared_known = true;
        e->declared_hash = hash;
        e->declared_has_revision = has_revision;
        e->declared_revision = revision;
        /* An echo of a report the director heard, however old, is no news: the editor
         * has gone on from it. Anything else the director chose. */
        const struct report *report =
            has_revision && revision >= 0 ? find_report(e, (uint64_t)revision) : NULL;
        bool echo = !first && report && report->hash == hash && report->length == length;
        if (!echo)
            take_declared(e, declared ? declared : "", length, first ? NULL : report, !first);
    }
    /* Props such as the box or the padding may have moved what shows. */
    e->generation++;
    e->caret = clamp_byte(e, e->caret);
    e->anchor = clamp_byte(e, e->anchor);
    clamp_scroll(e);
    if (e->focused) reveal_caret(e);
    report_size(e);
}

void edit_node_dead(struct server *server, struct node *node) {
    struct editor *e = editor_of(node);
    if (!e) return;
    node->editor = NULL;
    editor_free(e);
}

bool edit_placeholder_shown(const struct node *node) {
    const struct editor *e = editor_of(node);
    const char *placeholder = node_string(node, PROP_PLACEHOLDER);
    return e && !text_length(e) && placeholder && placeholder[0];
}

bool edit_layout_text(const struct node *node, const char **text, double *wrap_width,
                      uint64_t *revision) {
    struct editor *e = editor_of(node);
    if (!e) return false;
    if (edit_placeholder_shown(node)) {
        *text = node_string(node, PROP_PLACEHOLDER);
    } else if (password(e)) {
        if (!e->display_valid || e->display_generation != e->generation) {
            strbuf_clear(&e->display);
            long characters = g_utf8_strlen(text_of(e), text_length(e));
            for (long i = 0; i < characters; i++) strbuf_append(&e->display, BULLET, BULLET_BYTES);
            e->display_generation = e->generation;
            e->display_valid = true;
        }
        *text = e->display.data ? e->display.data : "";
    } else {
        *text = text_of(e);
    }
    *wrap_width = 0;
    if (multiline(e)) {
        double pad[4];
        node_corners(node, PROP_PADDING, pad);
        double width = node_number(node, PROP_WIDTH, 0);
        *wrap_width = fmax(1, width - fmax(0, pad[1]) - fmax(0, pad[3]));
        if (!node_has_number(node, PROP_WIDTH)) *wrap_width = 0;
    }
    *revision = node->revision + e->generation;
    return true;
}

bool edit_node_size(struct server *server, const struct node *node, double *width, double *height) {
    struct editor *e = editor_of(node);
    if (!e) return false;
    const struct media_text_layout *layout = content_text_layout(server, e->node);
    double pad[4];
    node_corners(node, PROP_PADDING, pad);
    double text_width = layout ? layout->metrics.width : 0;
    double text_height = layout ? grown_height(e, layout) : 0;
    *width = node_has_number(node, PROP_WIDTH) ? node_number(node, PROP_WIDTH, 0)
                                               : text_width + pad[1] + pad[3];
    *height = node_has_number(node, PROP_HEIGHT) ? node_number(node, PROP_HEIGHT, 0)
                                                 : text_height + pad[0] + pad[2];
    return true;
}

/* {"type": "edit", "node", "action", ...}: see docs/PROTOCOL.md. */
bool edit_command(struct server *server, struct node *node, const struct json_value *message,
                  struct protocol_error *error) {
    struct editor *e = editor_of(node);
    if (!e) return protocol_fail(error, "edit requires an editable text node.");
    const struct json_value *action = json_get(message, "action");
    if (json_is_string(action, "select")) {
        const struct json_value *start = json_given(message, "start"),
                                *end = json_given(message, "end");
        double from = start && start->type == JSON_NUMBER ? start->number : 0;
        double to = end && end->type == JSON_NUMBER ? end->number : from;
        if (!isfinite(from) || !isfinite(to))
            return protocol_fail(error, "select requires numbers.");
        const struct json_value *direction = json_given(message, "direction");
        bool backward = json_is_string(direction, "backward");
        int a = bytes_for_units(text_of(e), (size_t)text_length(e), fmin(from, to));
        int b = bytes_for_units(text_of(e), (size_t)text_length(e), fmax(from, to));
        if (backward) select_range(e, b, a);
        else select_range(e, a, b);
        return true;
    }
    if (json_is_string(action, "select-all")) {
        select_all(e);
        return true;
    }
    if (json_is_string(action, "insert")) {
        const struct json_value *text = json_get(message, "text");
        if (!text || text->type != JSON_STRING)
            return protocol_fail(error, "insert requires text.");
        insert_text(e, text->string.chars, text->string.length, STEP_OTHER);
        return true;
    }
    /* Any other command by name, as a key would run it. */
    for (int command = CMD_NONE + 1; command < CMD_COUNT; command++) {
        if (COMMAND_NAMES[command] && json_is_string(action, COMMAND_NAMES[command])) {
            command_key(e, (enum command)command, e->mark, false);
            return true;
        }
    }
    return protocol_fail(error, "Unknown edit action.");
}

/* Drawing. */

bool edit_view(struct server *server, struct node *node, struct edit_view *view) {
    struct editor *e = editor_of(node);
    if (!e) return false;
    *view = (struct edit_view){0};
    const struct media_text_layout *layout = layout_of(e);
    if (!layout) return false;
    struct frame f;
    frame_of(e, &f);
    double ox, oy;
    text_origin(e, &f, layout, &ox, &oy);
    view->origin_x = ox - e->scroll_x;
    view->origin_y = oy - e->scroll_y;
    double text_color[4] = {0, 0, 0, 1};
    if (node_given(node, PROP_COLOR) || node->channels[PROP_COLOR].count)
        node_color(node, PROP_COLOR, text_color);
    if (node_given(node, PROP_SELECTION_COLOR) || node->channels[PROP_SELECTION_COLOR].count)
        node_color(node, PROP_SELECTION_COLOR, view->selection_color);
    else memcpy(view->selection_color, DEFAULT_SELECTION, sizeof view->selection_color);
    /* Out of focus, a selection stays, dimmed, as GTK keeps it. */
    if (!e->focused) view->selection_color[3] *= 0.5;
    if (node_given(node, PROP_CARET_COLOR) || node->channels[PROP_CARET_COLOR].count)
        node_color(node, PROP_CARET_COLOR, view->caret_color);
    else memcpy(view->caret_color, text_color, sizeof view->caret_color);
    free(e->rects);
    e->rects = NULL;
    int start, end;
    selection_range(e, &start, &end);
    if (start != end) {
        double size = layout->style.size > 0 ? layout->style.size : 14;
        view->selection_count = media_text_selection(layout, to_display(e, start),
                                                     to_display(e, end), size / 3, &e->rects);
        view->selection = e->rects;
        /* Line boxes, the half-leading above each line as well as below. */
        if (multiline(e)) {
            double half = half_leading(layout);
            for (int i = 0; i < view->selection_count; i++) e->rects[i].y -= half;
        }
    }
    /* No caret where nothing can be typed, nor over a selection. */
    view->caret_shown = e->focused && e->caret_on && start == end && !flag(e, PROP_READ_ONLY);
    struct media_caret caret;
    media_text_caret(layout, to_display(e, e->caret), e->upstream, &caret);
    view->caret = (struct media_rect){caret.x, caret.y, 1, caret.height};
    return true;
}
