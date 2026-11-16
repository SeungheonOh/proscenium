/* Scroll containers whose offset the compositor owns: see scroll.h. */
#include "scroll.h"

#include <math.h>
#include <wlr/types/wlr_output.h>
#include <wlr/types/wlr_pointer.h>

#include "link.h"
#include "stage.h"

/* Logical pixels one wheel notch moves. */
#define NOTCH 56.0
/* Seconds thumbs stay after scrolling stops. */
#define THUMB_HOLD 1.2
/* Momentum: the decay's time constant, and the finger history it is estimated from. */
#define FLING_TIME_CONSTANT 0.35
#define VELOCITY_WINDOW 0.1
#define FLING_THRESHOLD 60.0
#define FLING_LIMIT 8000.0
/* How hard a pull past an end stretches: less the nearer it comes to the box's size. */
#define RUBBER 0.55
/* At most this many containers nest around a node scrolled. */
#define CHAIN_MAX 16

static struct {
    struct wl_event_source *timer;
    /* Containers whose thumbs show, waiting to fade. */
    struct vec shown; /* struct node *, referenced */
    /* The thumb under the pointer. */
    struct node *hovered; /* referenced */
    /* A thumb dragged, its axis, and where the drag started: the pointer and the offset. */
    struct node *dragged; /* referenced */
    int drag_axis;
    double drag_start, drag_offset;
    /* By axis: the container fingers moved last, which their lifting flings, and the one
     * they pull past an end. */
    struct node *fingered[2], *pulled[2]; /* referenced */
} state;

static void set_ref(struct node **slot, struct node *node) {
    if (node) node_ref(node);
    if (*slot) node_unref(*slot);
    *slot = node;
}

static bool scrolls(const struct node *node) {
    return node->kind == KIND_GROUP && node_choice(node, PROP_SCROLL) != SCROLL_NONE;
}

/* Whether NODE scrolls along AXIS: 0 for x, 1 for y. */
static bool scrolls_along(const struct node *node, int axis) {
    int scroll = node_choice(node, PROP_SCROLL);
    return node->kind == KIND_GROUP &&
           (scroll == SCROLL_BOTH || scroll == (axis ? SCROLL_Y : SCROLL_X));
}

/* NODE's box along AXIS, as declared. */
static double box_size(const struct node *node, int axis) {
    return node_target(node, axis ? PROP_HEIGHT : PROP_WIDTH, 0);
}

/* How long NODE's content is along AXIS: as declared, else its box. */
static double content_size(const struct node *node, int axis) {
    enum prop_key key = axis ? PROP_CONTENT_HEIGHT : PROP_CONTENT_WIDTH;
    return node_given(node, key) ? node->props[key].number : box_size(node, axis);
}

/* How far NODE scrolls along AXIS, in whole pixels. */
static double limit(const struct node *node, int axis) {
    return fmax(0, round(content_size(node, axis) - box_size(node, axis)));
}

static struct channel *offset_channel(struct scroller *scroller, int axis) {
    return axis ? &scroller->y : &scroller->x;
}

/* A pull of PULLED past an end, as the rubber band shows it over a box of BOX. */
static double rubber(double pulled, double box) {
    if (box <= 0) return 0;
    return copysign((1 - 1 / (fabs(pulled) * RUBBER / box + 1)) * box, pulled);
}

/* Motions. */

static struct motion *spring_motion(double stiffness, double damping) {
    struct motion *motion = motion_create(MOTION_SPRING);
    motion->stiffness = stiffness;
    motion->damping = damping;
    return motion;
}

/* Wheel notches glide, adding up while they come quickly. */
static struct motion *glide_motion(void) {
    static struct motion *motion;
    if (!motion) motion = spring_motion(400, 40);
    return motion;
}

/* A stretched end settles back; critically damped. */
static struct motion *settle_motion(void) {
    static struct motion *motion;
    if (!motion) motion = spring_motion(300, 2 * sqrt(300));
    return motion;
}

static struct motion *fade_motion(bool in) {
    static struct motion *motions[2];
    if (!motions[in]) {
        struct motion *motion = motion_create(MOTION_TWEEN);
        motion->duration = in ? 0.12 : 0.4;
        motion->eased = true;
        double ease[4] = {0.25, 0.1, 0.25, 1};
        memcpy(motion->ease, ease, sizeof ease);
        motions[in] = motion;
    }
    return motions[in];
}

/* Reports and thumbs. */

/* Tell the director where NODE's offset is headed, if it handles scroll. */
static void report(struct server *server, struct node *node) {
    struct scroller *scroller = node->scroller;
    double at[2];
    for (int axis = 0; axis < 2; axis++)
        at[axis] = CLAMP(offset_channel(scroller, axis)->target, 0.0, limit(node, axis));
    if (at[0] == scroller->reported[0] && at[1] == scroller->reported[1]) return;
    scroller->reported[0] = at[0];
    scroller->reported[1] = at[1];
    struct event event;
    if (!event_begin(server, &event, node, EVENT_SCROLL)) return;
    json_key(&event.writer, "scroll-x");
    json_number(&event.writer, at[0]);
    json_key(&event.writer, "scroll-y");
    json_number(&event.writer, at[1]);
    event_end(server, &event);
}

static int hide_fired(void *data);

/* Arm the timer for the soonest thumbs to fade; none to fade disarms it. */
static void arm(struct server *server) {
    double soonest = INFINITY;
    VEC_FOR(&state.shown, struct node *, slot) {
        const struct scroller *scroller = (*slot)->scroller;
        if (!scroller->thumb_hovered && !scroller->thumb_dragged)
            soonest = fmin(soonest, scroller->hide_at);
    }
    if (!state.timer) {
        if (isinf(soonest)) return;
        state.timer = wl_event_loop_add_timer(server->loop, hide_fired, server);
    }
    int ms = isinf(soonest) ? 0 : (int)fmax(1, ceil((soonest - now_seconds()) * 1000));
    wl_event_source_timer_update(state.timer, ms);
}

static void show_thumbs(struct server *server, struct node *node) {
    /* A container without thumbs has nothing to show, or to wake frames for. */
    bool thumbs = false;
    NODE_FOR_CHILDREN(node, child) thumbs = thumbs || child->props[PROP_SCROLL_THUMB].given;
    if (!thumbs) return;
    struct scroller *scroller = node->scroller;
    if (scroller->thumb.target != 1)
        channel_retarget(&scroller->thumb, 1, fade_motion(true), server_time(server));
    scroller->hide_at = now_seconds() + THUMB_HOLD;
    if (!state.shown.element) vec_init(&state.shown, sizeof(struct node *));
    bool listed = false;
    VEC_FOR(&state.shown, struct node *, slot) listed = listed || *slot == node;
    if (!listed) {
        node_ref(node);
        *(struct node **)vec_push(&state.shown) = node;
    }
    arm(server);
}

static int hide_fired(void *data) {
    struct server *server = data;
    double now = now_seconds();
    bool changed = false;
    for (size_t i = 0; i < state.shown.length;) {
        struct node *node = *(struct node **)vec_at(&state.shown, i);
        struct scroller *scroller = node->scroller;
        bool held = scroller->thumb_hovered || scroller->thumb_dragged;
        /* Thumbs stay while the content still coasts. */
        if (!held && node->state == NODE_LIVE &&
            (channel_active(&scroller->x) || channel_active(&scroller->y)))
            scroller->hide_at = fmax(scroller->hide_at, now + 0.3);
        if (node->state == NODE_LIVE && (held || scroller->hide_at > now + 1e-3)) {
            i++;
            continue;
        }
        if (node->state == NODE_LIVE) {
            channel_retarget(&scroller->thumb, 0, fade_motion(false), server_time(server));
            scene_track(&server->scene, node);
            changed = true;
        }
        vec_remove(&state.shown, i);
        node_unref(node);
    }
    if (changed) scene_changed(server);
    arm(server);
    return 0;
}

/* NODE's offset changed by input: its thumbs show, and the director may hear. */
static void moved(struct server *server, struct node *node, bool thumbs) {
    if (thumbs) show_thumbs(server, node);
    scene_track(&server->scene, node);
    scene_changed(server);
    report(server, node);
}

/* Geometry. */

bool scroll_inside(const struct node *node) {
    for (; node; node = node->parent)
        if (scrolls(node)) return true;
    return false;
}

bool scroll_offset(struct output *output, const struct node *node, double *x, double *y) {
    if (!scrolls(node)) return false;
    *x = *y = 0;
    if (!node->scroller) return true;
    /* Whole output pixels: content resting between them draws its text blurred. */
    double scale = output->wlr_output->scale > 0 ? output->wlr_output->scale : 1;
    if (scrolls_along(node, 0)) *x = round(node->scroller->x.value * scale) / scale;
    if (scrolls_along(node, 1)) *y = round(node->scroller->y.value * scale) / scale;
    return true;
}

struct node *scroll_thumb_of(const struct node *node) {
    for (; node; node = node->parent) {
        if (node->props[PROP_SCROLL_THUMB].given && node->parent && scrolls(node->parent))
            return (struct node *)node;
    }
    return NULL;
}

/*
 * THUMB's track in its container along AXIS: where it starts, how long it is, and how
 * long the thumb is there. Its declared position across the track is the inset at
 * either end, and its declared length the shortest it gets.
 */
static bool thumb_track(const struct node *thumb, int axis, double *start, double *track,
                        double *length) {
    const struct node *owner = thumb->parent;
    double inset = node_number(thumb, axis ? PROP_Y : PROP_X, 0);
    double shortest = node_number(thumb, axis ? PROP_HEIGHT : PROP_WIDTH, 0);
    double box = node_number(owner, axis ? PROP_HEIGHT : PROP_WIDTH, 0);
    double content = fmax(box, content_size(owner, axis));
    *start = inset;
    *track = box - 2 * inset;
    if (!(*track > 0) || !(content > 0)) return false;
    double value = owner->scroller ? offset_channel(owner->scroller, axis)->value : 0;
    double max = limit(owner, axis);
    /* Past an end the thumb shortens, as the content stretches. */
    double past = value < 0 ? -value : value > max ? value - max : 0;
    *length = fmin(*track, fmax(shortest / 2, fmax(shortest, *track * box / content) - past));
    return true;
}

bool scroll_thumb_place(const struct node *thumb, double *x, double *y, double *width,
                        double *height, double *opacity) {
    if (!thumb->props[PROP_SCROLL_THUMB].given || !thumb->parent || !scrolls(thumb->parent))
        return false;
    const struct node *owner = thumb->parent;
    int axis = thumb->props[PROP_SCROLL_THUMB].choice == THUMB_Y;
    *x = node_number(thumb, PROP_X, 0);
    *y = node_number(thumb, PROP_Y, 0);
    *width = node_number(thumb, PROP_WIDTH, 0);
    *height = node_number(thumb, PROP_HEIGHT, 0);
    double max = limit(owner, axis);
    *opacity = owner->scroller && max > 0 ? CLAMP(owner->scroller->thumb.value, 0.0, 1.0) : 0;
    double start, track, length;
    if (!thumb_track(thumb, axis, &start, &track, &length)) {
        *opacity = 0;
        return true;
    }
    double value = owner->scroller ? offset_channel(owner->scroller, axis)->value : 0;
    double position = start + (track - length) * CLAMP(value / max, 0.0, 1.0);
    if (axis) {
        *y = position;
        *height = length;
    } else {
        *x = position;
        *width = length;
    }
    return true;
}

/* Wheels and fingers. */

static void record(struct scroll_samples *samples, double position) {
    double now = now_seconds();
    int kept = 0;
    for (int i = 0; i < samples->count; i++) {
        if (now - samples->times[i] > VELOCITY_WINDOW || kept == 15) continue;
        samples->times[kept] = samples->times[i];
        samples->positions[kept++] = samples->positions[i];
    }
    samples->times[kept] = now;
    samples->positions[kept] = position;
    samples->count = kept + 1;
}

/* How fast fingers moved as they lifted; zero when they had stopped. */
static double release_velocity(const struct scroll_samples *samples) {
    int count = samples->count;
    if (count < 2) return 0;
    double span = samples->times[count - 1] - samples->times[0];
    if (span < 0.01 || now_seconds() - samples->times[count - 1] > 0.06) return 0;
    double velocity = (samples->positions[count - 1] - samples->positions[0]) / span;
    if (fabs(velocity) < FLING_THRESHOLD) return 0;
    return CLAMP(velocity, -FLING_LIMIT, FLING_LIMIT);
}

/* Fingers lifted, scrolling along AXIS: a pull past an end settles back, and the
 * container they moved last coasts on. */
static bool lift(struct server *server, int axis) {
    double time = server_time(server);
    struct node *pulled = state.pulled[axis], *fingered = state.fingered[axis];
    bool any = pulled || fingered;
    if (pulled && pulled->state == NODE_LIVE && pulled->scroller) {
        struct scroller *scroller = pulled->scroller;
        double edge = scroller->over[axis] < 0 ? 0 : limit(pulled, axis);
        scroller->over[axis] = 0;
        channel_retarget(offset_channel(scroller, axis), edge, settle_motion(), time);
        moved(server, pulled, true);
    } else if (fingered && fingered->state == NODE_LIVE && fingered->scroller) {
        struct scroller *scroller = fingered->scroller;
        struct channel *channel = offset_channel(scroller, axis);
        double velocity = release_velocity(&scroller->samples[axis]);
        double max = limit(fingered, axis);
        channel_sample(channel, time);
        double end = channel->value + velocity * FLING_TIME_CONSTANT;
        if (velocity == 0) {
            /* Content resting between pixels draws its text blurred. */
            channel_retarget(channel, round(channel->value), settle_motion(), time);
        } else if (end >= 0 && end <= max) {
            channel_fling(channel, velocity, FLING_TIME_CONSTANT, 0.5, time);
        } else {
            /* Momentum carried into an end bounces off it. */
            struct motion *bounce = spring_motion(300, 2 * sqrt(300));
            bounce->has_velocity = true;
            bounce->velocity = velocity;
            channel_retarget(channel, end < 0 ? 0 : max, bounce, time);
            motion_unref(bounce);
        }
        moved(server, fingered, true);
    }
    if (fingered && fingered->scroller) fingered->scroller->samples[axis].count = 0;
    set_ref(&state.pulled[axis], NULL);
    set_ref(&state.fingered[axis], NULL);
    return any;
}

/* Fingers moving DELTA along AXIS over a pull past an end: the pull takes it, and what is
 * left after it springs back comes back into LEFT. True when the pull took it all. */
static bool pull(struct server *server, int axis, double *left) {
    struct node *node = state.pulled[axis];
    if (!node || node->state != NODE_LIVE || !node->scroller) return false;
    struct scroller *scroller = node->scroller;
    double over = scroller->over[axis] + *left;
    double max = limit(node, axis), edge = scroller->over[axis] < 0 ? 0 : max;
    struct channel *channel = offset_channel(scroller, axis);
    if (over * scroller->over[axis] > 0) {
        scroller->over[axis] = over;
        channel_jump(channel, edge + rubber(over, box_size(node, axis)));
        *left = 0;
    } else {
        scroller->over[axis] = 0;
        channel_jump(channel, edge);
        set_ref(&state.pulled[axis], NULL);
        *left = over;
    }
    moved(server, node, true);
    return *left == 0;
}

bool scroll_axis(struct server *server, struct node *node,
                 const struct wlr_pointer_axis_event *event) {
    int axis = event->orientation == WL_POINTER_AXIS_VERTICAL_SCROLL;
    bool fingers = event->source == WL_POINTER_AXIS_SOURCE_FINGER ||
                   event->source == WL_POINTER_AXIS_SOURCE_CONTINUOUS;
    struct node *chain[CHAIN_MAX];
    int count = 0;
    for (struct node *current = node; current && count < CHAIN_MAX; current = current->parent) {
        if (current->state == NODE_LIVE && scrolls_along(current, axis)) chain[count++] = current;
    }
    /* Fingers lifting end in a stop with no motion. */
    if (fingers && event->delta == 0) return lift(server, axis) || count > 0;
    if (!count) return false;
    double left = fingers ? event->delta
                  : event->delta_discrete ? event->delta_discrete / 120.0 * NOTCH
                                          : event->delta / 15.0 * NOTCH;
    if (left == 0) return true;
    double time = server_time(server);
    if (fingers && pull(server, axis, &left)) return true;
    /* The innermost container takes what it can, and passes the rest outward. */
    struct node *last = NULL;
    int reached = 0;
    for (int i = 0; i < count && left != 0; i++) {
        struct node *current = chain[i];
        struct scroller *scroller = node_scroller(current);
        struct channel *channel = offset_channel(scroller, axis);
        double max = limit(current, axis);
        channel_sample(channel, time);
        reached = i;
        double from, to;
        if (fingers) {
            /* Fingers catch content coasting or bouncing where it is. */
            from = CLAMP(channel->value, 0.0, max);
            to = CLAMP(from + left, 0.0, max);
            if (to != channel->value || channel_active(channel)) channel_jump(channel, to);
            record(&scroller->samples[axis], to);
        } else {
            /* Notches coming quickly add up. */
            bool coasting = channel->motion && channel->motion->kind == MOTION_DECAY;
            from = CLAMP(coasting ? channel->value : channel->target, 0.0, max);
            to = CLAMP(round(from + left), 0.0, max);
            if (to != channel->target) channel_retarget(channel, to, glide_motion(), time);
        }
        left = to == 0 || to == max ? left - (to - from) : 0;
        if (to != from) {
            last = current;
            moved(server, current, true);
        }
        if (node_choice(current, PROP_OVERSCROLL) != OVERSCROLL_AUTO) break;
    }
    if (fingers && last) set_ref(&state.fingered[axis], last);
    /* Fingers pulling on past the ends stretch the innermost container that allows it. */
    for (int i = 0; fingers && left != 0 && i <= reached; i++) {
        struct node *current = chain[i];
        if (node_choice(current, PROP_OVERSCROLL) == OVERSCROLL_NONE) continue;
        struct scroller *scroller = node_scroller(current);
        scroller->over[axis] = left;
        double edge = left < 0 ? 0 : limit(current, axis);
        channel_jump(offset_channel(scroller, axis), edge + rubber(left, box_size(current, axis)));
        set_ref(&state.pulled[axis], current);
        set_ref(&state.fingered[axis], NULL);
        moved(server, current, true);
        break;
    }
    return true;
}

/* Commits and requests. */

void scroll_refresh(struct server *server, struct node *node) {
    if (!scrolls(node)) return;
    struct scroller *scroller = node_scroller(node);
    bool stick = node_bool(node, PROP_STICK_TO_END), changed = false;
    double time = server_time(server);
    for (int axis = 0; axis < 2; axis++) {
        struct channel *channel = offset_channel(scroller, axis);
        double max = scrolls_along(node, axis) ? limit(node, axis) : 0;
        /* Kept at the end while the end was in view, or from the first. */
        bool at_end = !scroller->known || channel->target >= scroller->last_max[axis] - 1;
        double to = channel->target;
        if (stick && at_end && max != scroller->last_max[axis]) to = max;
        else if (to > max && !scroller->over[axis]) to = max;
        if (!scrolls_along(node, axis)) to = 0;
        scroller->last_max[axis] = max;
        if (to == channel->target) continue;
        if (channel_active(channel) && channel->motion->kind == MOTION_SPRING)
            channel_retarget(channel, to, channel->motion, time);
        else channel_jump(channel, to);
        changed = true;
    }
    scroller->known = true;
    if (changed) {
        scene_track(&server->scene, node);
        invalidate_displays(server);
    }
    report(server, node);
}

bool scroll_to(struct server *server, struct node *node, const bool has[2], const double at[2],
               struct motion *motion, struct protocol_error *error) {
    if (!scrolls(node))
        return protocol_fail(error, "Node %lld does not scroll.", (long long)node->id);
    struct scroller *scroller = node_scroller(node);
    double time = server_time(server);
    for (int axis = 0; axis < 2; axis++) {
        if (!has[axis] || !scrolls_along(node, axis)) continue;
        /* The offset is the director's now: fingers still down neither pull nor fling it. */
        scroller->over[axis] = 0;
        if (state.pulled[axis] == node) set_ref(&state.pulled[axis], NULL);
        if (state.fingered[axis] == node) set_ref(&state.fingered[axis], NULL);
        double to = CLAMP(round(at[axis]), 0.0, limit(node, axis));
        channel_retarget(offset_channel(scroller, axis), to, motion, time);
    }
    moved(server, node, false);
    return true;
}

void scroll_into_view(struct server *server, struct node *node) {
    double x = 0, y = 0, size[2];
    node_size(server, node, &size[0], &size[1]);
    double time = server_time(server);
    for (struct node *current = node; current->parent; current = current->parent) {
        x += node_target(current, PROP_X, 0);
        y += node_target(current, PROP_Y, 0);
        struct node *parent = current->parent;
        if (!scrolls(parent) || current->props[PROP_SCROLL_THUMB].given) continue;
        struct scroller *scroller = node_scroller(parent);
        bool changed = false;
        for (int axis = 0; axis < 2; axis++) {
            if (!scrolls_along(parent, axis)) continue;
            struct channel *channel = offset_channel(scroller, axis);
            double start = axis ? y : x, offset = channel->target, box = box_size(parent, axis);
            double to = offset;
            /* One larger than the box shows from its start, unless it fills the box already. */
            if (size[axis] >= box) {
                if (start > offset || start + size[axis] < offset + box) to = start;
            } else if (start < offset) {
                to = start;
            } else if (start + size[axis] > offset + box) {
                to = start + size[axis] - box;
            }
            to = CLAMP(round(to), 0.0, limit(parent, axis));
            if (to != offset) {
                channel_retarget(channel, to, glide_motion(), time);
                changed = true;
            }
            if (axis) y -= to;
            else x -= to;
        }
        if (changed) moved(server, parent, false);
    }
}

/* Thumbs under the pointer. */

void scroll_hover(struct server *server, struct node *hit) {
    struct node *thumb = hit ? scroll_thumb_of(hit) : NULL;
    if (thumb == state.hovered) return;
    struct node *old = state.hovered;
    if (old && old->parent && old->parent->scroller) {
        old->parent->scroller->thumb_hovered = false;
        old->parent->scroller->hide_at = now_seconds() + THUMB_HOLD;
    }
    set_ref(&state.hovered, thumb);
    if (thumb) node_scroller(thumb->parent)->thumb_hovered = true;
    arm(server);
}

void scroll_drag_begin(struct server *server, struct node *thumb, double x, double y) {
    struct node *owner = thumb->parent;
    int axis = thumb->props[PROP_SCROLL_THUMB].choice == THUMB_Y;
    struct scroller *scroller = node_scroller(owner);
    set_ref(&state.dragged, thumb);
    state.drag_axis = axis;
    state.drag_start = axis ? y : x;
    state.drag_offset = CLAMP(offset_channel(scroller, axis)->target, 0.0, limit(owner, axis));
    scroller->thumb_dragged = true;
    show_thumbs(server, owner);
}

struct node *scroll_dragged(void) {
    return state.dragged ? state.dragged->parent : NULL;
}

void scroll_drag_update(struct server *server, double x, double y) {
    struct node *thumb = state.dragged;
    if (!thumb || thumb->state != NODE_LIVE || !thumb->parent || !scrolls(thumb->parent)) return;
    struct node *owner = thumb->parent;
    int axis = state.drag_axis;
    double start, track, length, max = limit(owner, axis);
    if (!thumb_track(thumb, axis, &start, &track, &length) || track <= length) return;
    double moved_by = (axis ? y : x) - state.drag_start;
    double to = CLAMP(round(state.drag_offset + moved_by * max / (track - length)), 0.0, max);
    struct channel *channel = offset_channel(owner->scroller, axis);
    if (to == channel->value && !channel_active(channel)) return;
    channel_jump(channel, to);
    moved(server, owner, true);
}

void scroll_drag_end(struct server *server) {
    struct node *thumb = state.dragged;
    if (!thumb) return;
    if (thumb->parent && thumb->parent->scroller) {
        thumb->parent->scroller->thumb_dragged = false;
        thumb->parent->scroller->hide_at = now_seconds() + THUMB_HOLD;
    }
    set_ref(&state.dragged, NULL);
    arm(server);
}

/* Lifetime. */

void scroll_node_dead(struct server *server, struct node *node) {
    if (state.hovered == node) set_ref(&state.hovered, NULL);
    if (state.dragged == node) scroll_drag_end(server);
    for (int axis = 0; axis < 2; axis++) {
        if (state.fingered[axis] == node) set_ref(&state.fingered[axis], NULL);
        if (state.pulled[axis] == node) set_ref(&state.pulled[axis], NULL);
    }
    for (size_t i = 0; i < state.shown.length; i++) {
        if (*(struct node **)vec_at(&state.shown, i) != node) continue;
        vec_remove(&state.shown, i);
        node_unref(node);
        break;
    }
}

void scroll_finish(struct server *server) {
    if (state.timer) wl_event_source_remove(state.timer);
    state.timer = NULL;
    VEC_FOR(&state.shown, struct node *, slot) node_unref(*slot);
    if (state.shown.element) vec_finish(&state.shown);
    set_ref(&state.hovered, NULL);
    set_ref(&state.dragged, NULL);
    for (int axis = 0; axis < 2; axis++) {
        set_ref(&state.fingered[axis], NULL);
        set_ref(&state.pulled[axis], NULL);
    }
}

