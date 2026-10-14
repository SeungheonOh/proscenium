/*
 * Scene node kinds and their property schema.
 *
 * The director sends canonical JSON values; these tables are the only place
 * protocol names map to the compositor's enums. Declared values are kept
 * decoded on the node, and animated ones also drive channels.
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "geometry.h"
#include "json.h"
#include "motion.h"

enum node_kind {
    KIND_ROOT,
    KIND_GROUP,
    KIND_TEXT,
    KIND_IMAGE,
    KIND_WEB,
    KIND_WINDOW,
    KIND_BACKGROUND,
    KIND_CAMERA,
    KIND_SCREEN,
    KIND_RESERVE,
    KIND_SHORTCUT,
    KIND_POINTER_BINDING,
    KIND_WHEEL_BINDING,
    KIND_GESTURE_BINDING,
    KIND_MIRROR,
    KIND_COUNT,
};

enum prop_key {
    PROP_X,
    PROP_Y,
    PROP_WIDTH,
    PROP_HEIGHT,
    PROP_TRANSFORM,
    PROP_ROTATION,
    PROP_OPACITY,
    PROP_ORIGIN_X,
    PROP_ORIGIN_Y,
    PROP_VISIBLE,
    PROP_BACKFACE,
    PROP_COLOR,
    PROP_RADIUS,
    PROP_CLIP,
    PROP_WINDOW,
    PROP_FULLSCREEN,
    PROP_MAXIMIZED,
    PROP_TILED,
    PROP_FOCUSABLE,
    PROP_INTERACTIVE,
    PROP_MOVABLE,
    PROP_RESIZABLE,
    PROP_DRAGGABLE,
    PROP_PAN,
    PROP_OUTPUT,
    PROP_ZOOM,
    PROP_MIN_ZOOM,
    PROP_MAX_ZOOM,
    PROP_KEY,
    PROP_MODIFIERS,
    PROP_REPEAT,
    PROP_BUTTON,
    PROP_GESTURE,
    PROP_FINGERS,
    PROP_ACTION,
    PROP_TEXT,
    PROP_MARKUP,
    PROP_FONT,
    PROP_FONT_SIZE,
    PROP_FONT_WEIGHT,
    PROP_ITALIC,
    PROP_ALIGN,
    PROP_LINE_HEIGHT,
    PROP_MAX_LINES,
    PROP_SRC,
    PROP_FIT,
    PROP_DATA,
    PROP_REVISION,
    PROP_AUTO_FOCUS,
    PROP_FRAME_TAG,
    PROP_TOP,
    PROP_RIGHT,
    PROP_BOTTOM,
    PROP_LEFT,
    PROP_CURSOR,
    PROP_COUNT,
};

enum prop_type {
    TYPE_NUMBER,
    TYPE_COLOR,
    TYPE_TRANSFORM,
    TYPE_BOOLEAN,
    TYPE_STRING,
    TYPE_ID,
    TYPE_CHOICE,
    TYPE_MODIFIERS,
};

/* Choices, in the order of their protocol names in the schema. */
enum { BACKFACE_VISIBLE, BACKFACE_HIDDEN };
enum { GESTURE_SWIPE, GESTURE_PINCH, GESTURE_HOLD };
enum { ACTION_NONE, ACTION_MOVE, ACTION_RESIZE, ACTION_PAN, ACTION_ZOOM };
enum { ALIGN_START, ALIGN_CENTER, ALIGN_END };
enum { FIT_FILL, FIT_CONTAIN, FIT_COVER };
enum cursor_shape {
    CURSOR_NONE,
    CURSOR_DEFAULT,
    CURSOR_POINTER,
    CURSOR_TEXT,
    CURSOR_CROSSHAIR,
    CURSOR_MOVE,
    CURSOR_GRAB,
    CURSOR_GRABBING,
    CURSOR_NOT_ALLOWED,
    CURSOR_HELP,
    CURSOR_WAIT,
    CURSOR_PROGRESS,
    CURSOR_ZOOM_IN,
    CURSOR_ZOOM_OUT,
    CURSOR_EW_RESIZE,
    CURSOR_NS_RESIZE,
    CURSOR_NWSE_RESIZE,
    CURSOR_NESW_RESIZE,
    CURSOR_COUNT,
};

enum modifier {
    MOD_SHIFT = 1 << 0,
    MOD_CONTROL = 1 << 1,
    MOD_ALT = 1 << 2,
    MOD_LOGO = 1 << 3,
};
#define MODIFIER_COUNT 4
/* Wire names of the modifiers, by bit. */
extern const char *const MODIFIER_NAMES[MODIFIER_COUNT];

enum event_name {
    EVENT_POINTERDOWN,
    EVENT_POINTERMOVE,
    EVENT_POINTERUP,
    EVENT_POINTERENTER,
    EVENT_POINTERLEAVE,
    EVENT_WHEEL,
    EVENT_PRESS,
    EVENT_RELEASE,
    EVENT_DOWN,
    EVENT_MOVE,
    EVENT_UP,
    EVENT_BEGIN,
    EVENT_UPDATE,
    EVENT_END,
    EVENT_MOVEREQUEST,
    EVENT_RESIZEREQUEST,
    EVENT_FULLSCREENREQUEST,
    EVENT_MAXIMIZEREQUEST,
    EVENT_MINIMIZEREQUEST,
    EVENT_ACTIVATEREQUEST,
    EVENT_DRAGSTART,
    EVENT_DRAG,
    EVENT_DRAGEND,
    EVENT_RESIZESTART,
    EVENT_RESIZE,
    EVENT_RESIZEEND,
    EVENT_MEASURE,
    EVENT_LOAD,
    EVENT_ERROR,
    EVENT_MESSAGE,
    EVENT_COUNT,
};
extern const char *const EVENT_NAMES[EVENT_COUNT];
/* Pointer events the director passes up through a node's ancestors, as the DOM does. */
#define BUBBLING_EVENTS                                                                            \
    ((1u << EVENT_POINTERDOWN) | (1u << EVENT_POINTERMOVE) | (1u << EVENT_POINTERUP) |             \
     (1u << EVENT_POINTERENTER) | (1u << EVENT_POINTERLEAVE) | (1u << EVENT_WHEEL))

/* Transform functions, as CSS lists them: the last applies to the node first. */
enum tfunc {
    TF_TRANSLATE,   /* x y z */
    TF_SCALE,       /* x y z */
    TF_ROTATE,      /* axis x y z, radians */
    TF_SKEW,        /* two angles */
    TF_PERSPECTIVE, /* the inverse of the viewer's distance, so none is 0 */
    TF_MATRIX,      /* sixteen numbers, row by row */
};

#define TLIST_MAX 32

struct tlist {
    int count;
    uint8_t kinds[TLIST_MAX];
    int parameter_count;
    double *parameters;
};

int tfunc_arity(enum tfunc kind);
void tlist_finish(struct tlist *list);
void tlist_copy(struct tlist *out, const struct tlist *list);
void tlist_set(struct tlist *out, int count, const uint8_t *kinds, const double *parameters);
/* The matrix of LIST's functions, composed in order. */
struct mat4 tlist_matrix(const struct tlist *list);
/* FIRST's functions followed by SECOND's. */
void tlist_append(struct tlist *out, const struct tlist *first, const struct tlist *second);
/*
 * The kinds two lists animate between: the longer, when the other begins it, as
 * CSS pads lists. False when they cannot animate between each other.
 */
bool tlist_shape(const struct tlist *first, const struct tlist *second, int *count, uint8_t *kinds);
/*
 * LIST continued with functions doing nothing to take on KINDS, which LIST's kinds
 * must begin (as tlist_shape ensures); LIKE, a list of KINDS, lends the padding
 * its rotation axes.
 */
void tlist_pad(struct tlist *out, const struct tlist *list, int count, const uint8_t *kinds,
               const struct tlist *like);
/* How close each parameter of KINDS must come to settle, into TOLERANCES. */
void tlist_tolerances(int count, const uint8_t *kinds, double *tolerances);

struct prop_value {
    /* Declared; an undeclared property shows its default. */
    bool given;
    union {
        double number;
        double color[4];
        struct tlist transform;
        bool boolean;
        char *string;
        int64_t id;
        int choice;
        uint32_t modifiers;
    };
};

void prop_value_finish(enum prop_key key, struct prop_value *value);
void prop_value_copy(enum prop_key key, struct prop_value *out, const struct prop_value *value);

struct prop_spec {
    const char *name;
    enum prop_type type;
    bool animated;
    /* Settling distance of its channels. */
    double tolerance;
    /* Animates the logarithm, giving zoom a perceptually uniform pace. */
    bool logarithmic;
    /* The default; HAS_DEFAULT false means none, e.g. a window's natural size. */
    bool has_default;
    struct prop_value fallback;
    const char *const *choices;
};

extern const struct prop_spec PROP_SPECS[PROP_COUNT];

const char *kind_name(enum node_kind kind);
/* KIND_COUNT for an unknown name. */
enum node_kind kind_from_name(const char *name, size_t length);
bool kind_has_prop(enum node_kind kind, enum prop_key key);
/* Whether nodes of KIND take shaders: paints, filters and effects. */
bool kind_has_shaders(enum node_kind kind);
/* Camera nodes declare targets for compositor-owned cameras; they hold no channels. */
bool kind_animates(enum node_kind kind);
/* PROP_COUNT for an unknown name. */
enum prop_key prop_from_name(const char *name, size_t length);
/* EVENT_COUNT for an unknown name. */
enum event_name event_from_name(const char *name, size_t length);

/* Reports why a value was rejected, as the protocol's error message. */
struct protocol_error {
    char message[256];
};
bool protocol_fail(struct protocol_error *error, const char *format, ...)
    __attribute__((format(printf, 2, 3)));

/*
 * Decode RAW for property KEY into OUT; JSON null resets it to its default.
 * OUT owns any string or transform it holds afterwards.
 */
bool prop_decode(enum prop_key key, const struct json_value *raw, struct prop_value *out,
                 struct protocol_error *error);
/* Decode a numeric field NAME of OBJECT, at least 0 or with POSITIVE above it, or
 * FALLBACK when absent. */
bool decode_field(const struct json_value *object, const char *name, double fallback, bool positive,
                  double *out, struct protocol_error *error);
/* A CSS cubic-bezier [x1, y1, x2, y2]; EASED false for linear (null). */
bool decode_ease(const struct json_value *raw, bool *eased, double ease[4],
                 struct protocol_error *error);
/* One canonical transition object; the result carries one reference. */
struct motion *decode_motion(const struct json_value *raw, struct protocol_error *error);
