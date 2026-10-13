/*
 * Outputs: the row they form, frame scheduling and pacing, and work areas.
 *
 * A frame is requested when the scene can present differently; requests made
 * while one renders latch one following frame. Once frames follow each other at
 * the display's rate, each starts as late as still meets the next vblank, so
 * input arriving meanwhile makes it into the frame.
 */
#define _GNU_SOURCE
#include <GLES2/gl2.h>
#include <GLES2/gl2ext.h>
#include <EGL/egl.h>
#include <math.h>
#include <wlr/backend.h>
#include <wlr/render/gles2.h>
#include <wlr/render/pass.h>
#include <wlr/render/swapchain.h>
#include <wlr/render/wlr_renderer.h>
#include <wlr/types/wlr_output.h>
#include <wlr/types/wlr_output_layout.h>
#include <wlr/types/wlr_xcursor_manager.h>
#include <wlr/util/log.h>
#include <wlr/util/region.h>
#include <wlr/util/transform.h>

#include "display.h"
#include "input.h"
#include "link.h"
#include "server.h"
#include "stage.h"
#include "webnode.h"

/* Nanoseconds kept beyond a frame's measured cost, for the GPU and wakeup latency. */
#define FRAME_MARGIN 2000000
/* Nanoseconds from a vblank within which a frame event follows that frame's flip. */
#define FLIP_WINDOW 2000000
/* Frames in a row following flips before frames start late. */
#define PACED_AFTER 3
/* Nanoseconds past which a frame is logged: a visible hitch. */
#define SLOW_FRAME 50000000

/* GPU timing: timestamp queries around a frame measure what the GPU spent on it
 * without waiting; results arrive a frame or two later. */
struct gpu_timer {
    PFNGLGENQUERIESEXTPROC gen;
    PFNGLDELETEQUERIESEXTPROC delete_queries;
    PFNGLQUERYCOUNTEREXTPROC counter;
    PFNGLGETQUERYOBJECTIVEXTPROC available;
    PFNGLGETQUERYOBJECTUI64VEXTPROC result;
    GLuint open[2];
    bool has_open;
    GLuint pending[4][2];
    int pending_count;
    /* Query pairs to reuse: deleting and making them anew stalls some drivers. */
    GLuint free[6][2];
    int free_count;
};

static struct gpu_timer *gpu_timer_create(void) {
    const char *extensions = (const char *)glGetString(GL_EXTENSIONS);
    if (!extensions || !strstr(extensions, "GL_EXT_disjoint_timer_query")) return NULL;
    struct gpu_timer *timer = xcalloc(1, sizeof *timer);
    timer->gen = (PFNGLGENQUERIESEXTPROC)eglGetProcAddress("glGenQueriesEXT");
    timer->delete_queries = (PFNGLDELETEQUERIESEXTPROC)eglGetProcAddress("glDeleteQueriesEXT");
    timer->counter = (PFNGLQUERYCOUNTEREXTPROC)eglGetProcAddress("glQueryCounterEXT");
    timer->available = (PFNGLGETQUERYOBJECTIVEXTPROC)eglGetProcAddress("glGetQueryObjectivEXT");
    timer->result = (PFNGLGETQUERYOBJECTUI64VEXTPROC)eglGetProcAddress("glGetQueryObjectui64vEXT");
    if (!timer->gen || !timer->counter || !timer->available || !timer->result) {
        free(timer);
        return NULL;
    }
    return timer;
}

static void gpu_timer_destroy(struct gpu_timer *timer) {
    if (!timer) return;
    for (int i = 0; i < timer->pending_count; i++) timer->delete_queries(2, timer->pending[i]);
    for (int i = 0; i < timer->free_count; i++) timer->delete_queries(2, timer->free[i]);
    if (timer->has_open) timer->delete_queries(2, timer->open);
    free(timer);
}

static void gpu_timer_recycle(struct gpu_timer *timer, const GLuint pair[2]) {
    if (timer->free_count < (int)ARRAY_LENGTH(timer->free))
        memcpy(timer->free[timer->free_count++], pair, sizeof timer->free[0]);
    else timer->delete_queries(2, pair);
}

static void gpu_timer_drop(struct gpu_timer *timer) {
    for (int i = 0; timer && i < timer->pending_count; i++)
        gpu_timer_recycle(timer, timer->pending[i]);
    if (timer) timer->pending_count = 0;
}

/* Fold finished GPU times into the output's estimate: the peak, decaying 1/16 a frame. */
static void gpu_timer_collect(struct output *output) {
    struct gpu_timer *timer = output->gpu_timer;
    /* Reading the flag clears it, and the GPU clock is shared: across a disjoint event
     * no output's spans mean anything. */
    GLint disjoint = 0;
    glGetIntegerv(GL_GPU_DISJOINT_EXT, &disjoint);
    if (disjoint) {
        struct output *other;
        wl_list_for_each(other, &output->server->outputs, link) gpu_timer_drop(other->gpu_timer);
        return;
    }
    int done = 0;
    for (; done < timer->pending_count; done++) {
        GLint ready = 0;
        timer->available(timer->pending[done][1], GL_QUERY_RESULT_AVAILABLE_EXT, &ready);
        if (!ready) break;
        GLuint64 start = 0, end = 0;
        timer->result(timer->pending[done][0], GL_QUERY_RESULT_EXT, &start);
        timer->result(timer->pending[done][1], GL_QUERY_RESULT_EXT, &end);
        if (end > start) output->gpu_cost = MAX((int64_t)(end - start), output->gpu_cost * 15 / 16);
        gpu_timer_recycle(timer, timer->pending[done]);
    }
    memmove(timer->pending, timer->pending + done,
            (timer->pending_count - done) * sizeof *timer->pending);
    timer->pending_count -= done;
}

static void gpu_timer_begin(struct output *output) {
    struct gpu_timer *timer = output->gpu_timer;
    if (!timer) return;
    gpu_timer_collect(output);
    /* Results arrive within a frame or two; a backlog means they stopped coming. */
    if (timer->pending_count >= 4) return;
    if (!timer->has_open) {
        if (timer->free_count)
            memcpy(timer->open, timer->free[--timer->free_count], sizeof timer->open);
        else timer->gen(2, timer->open);
    }
    timer->has_open = true;
    timer->counter(timer->open[0], GL_TIMESTAMP_EXT);
}

static void gpu_timer_end(struct output *output) {
    struct gpu_timer *timer = output->gpu_timer;
    if (!timer || !timer->has_open) return;
    timer->counter(timer->open[1], GL_TIMESTAMP_EXT);
    /* Submitted now, the query's result is ready to read without a flush later. */
    glFlush();
    memcpy(timer->pending[timer->pending_count++], timer->open, sizeof timer->open);
    timer->has_open = false;
}

const char *output_name(struct output *output) {
    return output->wlr_output->name;
}

struct output *output_first(struct server *server) {
    if (wl_list_empty(&server->outputs)) return NULL;
    return wl_container_of(server->outputs.next, (struct output *)NULL, link);
}

struct output *output_by_name(struct server *server, const char *name) {
    struct output *output;
    wl_list_for_each(output, &server->outputs, link) {
        if (!strcmp(output_name(output), name)) return output;
    }
    return NULL;
}

struct output *output_at(struct server *server, double x, double y) {
    (void)y; /* Outputs form one row. */
    struct output *output, *nearest = NULL;
    double best = INFINITY;
    wl_list_for_each(output, &server->outputs, link) {
        double right = output->offset + output->width;
        if (x >= output->offset && x < right) return output;
        double distance = x < output->offset ? output->offset - x : x - right;
        if (distance < best) {
            best = distance;
            nearest = output;
        }
    }
    return nearest;
}

static void refresh_size(struct output *output) {
    int width, height;
    wlr_output_effective_resolution(output->wlr_output, &width, &height);
    output->width = width;
    output->height = height;
}

static void outputs_layout(struct server *server) {
    double offset = 0;
    struct output *output;
    wl_list_for_each(output, &server->outputs, link) {
        refresh_size(output);
        output->offset = offset;
        wlr_output_layout_add(server->output_layout, output->wlr_output, (int)offset, 0);
        offset += output->width;
    }
}

/* The output-local area windows may use, after reservations. */
static struct box output_work_area(struct output *output) {
    double left = output->reserve_left, top = output->reserve_top;
    return (struct box){left, top, fmax(0, output->width - left - output->reserve_right),
                        fmax(0, output->height - top - output->reserve_bottom)};
}

void output_describe(struct output *output, struct json_writer *w) {
    struct box area = output_work_area(output);
    json_object_begin(w);
    json_key(w, "name");
    json_string(w, output_name(output));
    json_key(w, "x");
    json_number(w, output->offset);
    json_key(w, "width");
    json_number(w, output->width);
    json_key(w, "height");
    json_number(w, output->height);
    json_key(w, "scale");
    json_number(w, output->wlr_output->scale);
    /* The logical area left after reservations such as a bar. */
    json_key(w, "work-area");
    json_object_begin(w);
    json_key(w, "x");
    json_number(w, area.x);
    json_key(w, "y");
    json_number(w, area.y);
    json_key(w, "width");
    json_number(w, area.width);
    json_key(w, "height");
    json_number(w, area.height);
    json_object_end(w);
    json_object_end(w);
}

static void outputs_report(struct server *server) {
    struct output *output;
    wl_list_for_each(output, &server->outputs, link) {
        struct message message;
        message_begin(&message, "output");
        json_key(&message.writer, "output");
        output_describe(output, &message.writer);
        message_send(server, &message, NULL);
    }
}

void outputs_update_reservations(struct server *server) {
    struct output *output;
    bool changed = false;
    wl_list_for_each(output, &server->outputs, link) {
        double left = 0, top = 0, right = 0, bottom = 0;
        VEC_FOR(&server->reserves, struct node *, slot) {
            struct node *node = *slot;
            const char *name = node_string(node, PROP_OUTPUT);
            if (name && strcmp(name, output_name(output))) continue;
            left = fmax(left, CLAMP(node_prop(node, PROP_LEFT)->number, 0.0, 4096.0));
            top = fmax(top, CLAMP(node_prop(node, PROP_TOP)->number, 0.0, 4096.0));
            right = fmax(right, CLAMP(node_prop(node, PROP_RIGHT)->number, 0.0, 4096.0));
            bottom = fmax(bottom, CLAMP(node_prop(node, PROP_BOTTOM)->number, 0.0, 4096.0));
        }
        if (left != output->reserve_left || top != output->reserve_top ||
            right != output->reserve_right || bottom != output->reserve_bottom) {
            output->reserve_left = left, output->reserve_top = top;
            output->reserve_right = right, output->reserve_bottom = bottom;
            changed = true;
        }
    }
    if (changed) {
        outputs_report(server);
        wl_list_for_each(output, &server->outputs, link) display_damage_whole(output);
        scene_changed(server);
    }
}

/* Frames. */

static void render_frame(struct output *output);

static void start_frame(struct output *output);

static void idle_frame(void *data) {
    struct output *output = data;
    output->idle_frame = NULL;
    if (output->frame_requested && output->wlr_output->enabled &&
        !output->wlr_output->frame_pending)
        start_frame(output);
}

/* Our own requests never go through wlr_output_schedule_frame, which would latch
 * wlroots' needs_frame until a commit and so hide cursor updates after a skipped frame. */
void output_request_frame(struct output *output) {
    if (!output->wlr_output->enabled) return;
    output->awaiting_frame = true;
    if (output->rendering) {
        output->next_frame = true;
        return;
    }
    if (output->frame_requested) return;
    output->frame_requested = true;
    /* A flip in flight brings a frame event; otherwise the frame starts once the loop is idle. */
    if (!output->wlr_output->frame_pending && !output->idle_frame)
        output->idle_frame = wl_event_loop_add_idle(output->server->loop, idle_frame, output);
}

void request_frames(struct server *server) {
    struct output *output;
    wl_list_for_each(output, &server->outputs, link) output_request_frame(output);
}

/* Milliseconds before the frame must start to meet the next vblank; 0 starts it now. */
static int frame_delay(struct output *output) {
    int64_t time = now_nanoseconds();
    bool following = output->vblank && output->refresh > 0 && time - output->vblank <= FLIP_WINDOW;
    output->target_vblank = 0;
    output->streak = following ? output->streak + 1 : 0;
    if (output->streak < PACED_AFTER) return 0;
    int64_t lead = output->frame_cost + output->gpu_cost + FRAME_MARGIN;
    /* Flip events report the vblank just presented a moment ahead of now. */
    int64_t next = output->vblank + output->refresh;
    /* Negative when the frame may miss NEXT; waiting for the one after would halve
     * the frame rate, so it starts at once. */
    int64_t delay = (next - lead - time) / 1000000;
    if (delay > 0) output->target_vblank = next;
    return delay > 0 ? (int)delay : 0;
}

static int pace_timer_fired(void *data) {
    struct output *output = data;
    if (output->frame_requested && output->wlr_output->enabled) render_frame(output);
    return 0;
}

static void arm_pace_timer(struct output *output, int milliseconds) {
    if (!output->pace_timer)
        output->pace_timer =
            wl_event_loop_add_timer(output->server->loop, pace_timer_fired, output);
    wl_event_source_timer_update(output->pace_timer, MAX(1, milliseconds));
}

/* Milliseconds of one refresh, for retries that must not spin the loop. */
static int refresh_milliseconds(struct output *output) {
    int64_t refresh = output->refresh;
    if (refresh <= 0 && output->wlr_output->refresh > 0)
        refresh = 1000000000000LL / output->wlr_output->refresh;
    return refresh > 0 ? (int)(refresh / 1000000) : 16;
}

/* Start the requested frame: at once, or as late as still meets the next vblank. */
static void start_frame(struct output *output) {
    int delay = frame_delay(output);
    if (delay == 0) render_frame(output);
    else arm_pace_timer(output, delay);
}

static void handle_frame(struct wl_listener *listener, void *data) {
    struct output *output = wl_container_of(listener, output, frame);
    if (output->frame_requested) start_frame(output);
}

static void note_frame_cost(struct output *output, int64_t nanoseconds) {
    output->frame_cost = MAX(nanoseconds, MAX(output->frame_cost * 15 / 16, (int64_t)1000000));
}

static void render_frame(struct output *output) {
    struct server *server = output->server;
    struct wlr_output *wlr_output = output->wlr_output;
    int64_t started = now_nanoseconds();
    output->frame_requested = false;
    output->rendering = true;
    bool committed = false, skipped = false;

    struct wlr_output_state state;
    wlr_output_state_init(&state);
    struct wlr_buffer *buffer = NULL;
    if (!wlr_output_configure_primary_swapchain(wlr_output, &state, &wlr_output->swapchain) ||
        !(buffer = wlr_swapchain_acquire(wlr_output->swapchain)) || !server_gl_current(server)) {
        wlr_log(WLR_ERROR, "output %s: no buffer to draw into", output_name(output));
        goto done;
    }
    GLuint framebuffer = wlr_gles2_renderer_get_buffer_fbo(server->wlr_renderer, buffer);
    if (!framebuffer) {
        wlr_log(WLR_ERROR, "output %s: cannot draw into its buffer", output_name(output));
        goto done;
    }
    glBindFramebuffer(GL_FRAMEBUFFER, framebuffer);
    if (!output->gpu_timer_checked) {
        output->gpu_timer = gpu_timer_create();
        output->gpu_timer_checked = true;
    }
    gpu_timer_begin(output);
    pixman_region32_t damage;
    pixman_region32_init(&damage);
    bool shown = display_render(output, buffer, &damage);
    gpu_timer_end(output);
    if (!shown && !wlr_output->needs_frame) {
        /* Nothing changed and nobody waits: the buffer, already up to date, stays unshown.
         * A cursor wlroots moved or changed is still committed, if nothing else is. */
        pixman_region32_fini(&damage);
        skipped = true;
        goto done;
    }
    if (wlr_output->software_cursor_locks > 0 || !wlr_output->hardware_cursor) {
        /* Cursors without a plane are drawn over the frame, as wlroots tracks them. */
        struct wlr_render_pass *pass =
            wlr_renderer_begin_buffer_pass(server->wlr_renderer, buffer, NULL);
        if (pass) {
            wlr_output_add_software_cursors_to_render_pass(wlr_output, pass, &damage);
            wlr_render_pass_submit(pass);
        }
    }
    wlr_output_state_set_buffer(&state, buffer);
    wlr_output_state_set_damage(&state, &damage);
    display_frame_feedback(output);
    committed = wlr_output_commit_state(wlr_output, &state);
    display_frame_done(output, committed, &damage);
    if (committed) share_output_presented(server, output, &damage);
    pixman_region32_fini(&damage);

done:
    if (buffer) wlr_buffer_unlock(buffer);
    wlr_output_state_finish(&state);
    output->rendering = false;
    bool again = output->next_frame;
    output->next_frame = false;
    if (committed) {
        int64_t cost = now_nanoseconds() - started;
        if (cost > SLOW_FRAME)
            wlr_log(WLR_INFO, "output %s: a frame took %.1f ms", output_name(output), cost / 1e6);
        note_frame_cost(output, cost);
        output->failures = 0;
        /* The flip's frame event starts the next one. */
        if (again) output_request_frame(output);
    } else if (skipped && again) {
        /* Something may still change, e.g. motion on another output: look again a
         * refresh later rather than at once, which would keep the loop busy. */
        output->frame_requested = true;
        arm_pace_timer(output, refresh_milliseconds(output));
    } else if (skipped) {
        output->awaiting_frame = false;
    } else {
        /* Failed: the frame's callbacks and motion are owed; retry, backing off. */
        output->frame_requested = true;
        output->failures++;
        arm_pace_timer(output, output->failures < 4 ? refresh_milliseconds(output) : 1000);
    }
}

static void handle_present(struct wl_listener *listener, void *data) {
    struct output *output = wl_container_of(listener, output, present);
    struct wlr_output_event_present *event = data;
    if (!event->presented) return;
    int64_t when = (int64_t)event->when.tv_sec * 1000000000 + event->when.tv_nsec;
    /* A frame that came out after the vblank it aimed for makes later frames start earlier. */
    if (output->target_vblank && when > output->target_vblank + event->refresh / 2)
        output->frame_cost += FRAME_MARGIN;
    output->target_vblank = 0;
    output->vblank = (event->flags & WLR_OUTPUT_PRESENT_VSYNC) ? when : 0;
    output->refresh = event->refresh;
}

static void handle_needs_frame(struct wl_listener *listener, void *data) {
    struct output *output = wl_container_of(listener, output, needs_frame);
    output_request_frame(output);
}

static void handle_damage(struct wl_listener *listener, void *data) {
    struct output *output = wl_container_of(listener, output, damage);
    struct wlr_output_event_damage *event = data;
    /* wlroots damages transformed output pixels; frames are drawn in buffer pixels. */
    struct wlr_output *wlr_output = output->wlr_output;
    int width, height;
    wlr_output_transformed_resolution(wlr_output, &width, &height);
    pixman_region32_t damage;
    pixman_region32_init(&damage);
    wlr_region_transform(&damage, event->damage, wlr_output_transform_invert(wlr_output->transform),
                         width, height);
    display_add_damage(output, &damage);
    pixman_region32_fini(&damage);
    output_request_frame(output);
}

static void output_changed(struct output *output) {
    struct server *server = output->server;
    outputs_layout(server);
    camera_center_unplaced(output);
    if (!output->wlr_output->enabled) output->awaiting_frame = false;
    display_damage_whole(output);
    input_clamp_pointer(server);
    invalidate_displays(server);
    outputs_report(server);
    cameras_report(server);
    output_request_frame(output);
}

static void handle_request_state(struct wl_listener *listener, void *data) {
    struct output *output = wl_container_of(listener, output, request_state);
    const struct wlr_output_event_request_state *event = data;
    /* The commit event reports what changed. */
    wlr_output_commit_state(output->wlr_output, event->state);
}

static void handle_commit(struct wl_listener *listener, void *data) {
    struct output *output = wl_container_of(listener, output, commit);
    const struct wlr_output_event_commit *event = data;
    uint32_t geometry = WLR_OUTPUT_STATE_MODE | WLR_OUTPUT_STATE_SCALE |
                        WLR_OUTPUT_STATE_TRANSFORM | WLR_OUTPUT_STATE_ENABLED;
    if (event->state->committed & geometry) output_changed(output);
}

static void handle_destroy(struct wl_listener *listener, void *data) {
    struct output *output = wl_container_of(listener, output, destroy);
    struct server *server = output->server;
    web_output_removed(server, output);
    share_output_removed(server, output);
    if (server->input) input_forget_output(server, output);
    windows_forget_output(server, output);
    wl_list_remove(&output->link);
    wl_list_remove(&output->frame.link);
    wl_list_remove(&output->present.link);
    wl_list_remove(&output->needs_frame.link);
    wl_list_remove(&output->damage.link);
    wl_list_remove(&output->request_state.link);
    wl_list_remove(&output->commit.link);
    wl_list_remove(&output->destroy.link);
    if (output->pace_timer) wl_event_source_remove(output->pace_timer);
    if (output->idle_frame) wl_event_source_remove(output->idle_frame);
    if (server_gl_current(server)) {
        gpu_timer_destroy(output->gpu_timer);
        display_destroy(output->display);
    }
    camera_destroy(output->camera);
    struct message message;
    message_begin(&message, "output-removed");
    json_key(&message.writer, "name");
    json_string(&message.writer, output_name(output));
    message_send(server, &message, NULL);
    free(output);
    outputs_layout(server);
    input_clamp_pointer(server);
    outputs_report(server);
    struct output *other;
    wl_list_for_each(other, &server->outputs, link) display_damage_whole(other);
    scene_changed(server);
}

static void handle_new_output(struct wl_listener *listener, void *data) {
    struct server *server = wl_container_of(listener, server, new_output);
    struct wlr_output *wlr_output = data;
    wlr_output_init_render(wlr_output, server->allocator, server->wlr_renderer);

    struct wlr_output_state state;
    wlr_output_state_init(&state);
    wlr_output_state_set_enabled(&state, true);
    struct wlr_output_mode *mode = wlr_output_preferred_mode(wlr_output);
    if (mode) wlr_output_state_set_mode(&state, mode);
    wlr_output_commit_state(wlr_output, &state);
    wlr_output_state_finish(&state);

    /* Each output has a bit in masks of outputs: the lowest one free. */
    uint32_t taken = 0;
    struct output *other;
    wl_list_for_each(other, &server->outputs, link) taken |= 1u << other->index;
    if (taken == UINT32_MAX) {
        wlr_log(WLR_ERROR, "output %s: too many outputs", wlr_output->name);
        return;
    }
    struct output *output = xcalloc(1, sizeof *output);
    output->server = server;
    output->wlr_output = wlr_output;
    while (taken & (1u << output->index)) output->index++;
    output->frame_cost = 4000000;
    output->camera = camera_create();
    bool first = wl_list_empty(&server->outputs);
    wl_list_insert(server->outputs.prev, &output->link);
    output->frame.notify = handle_frame;
    wl_signal_add(&wlr_output->events.frame, &output->frame);
    output->present.notify = handle_present;
    wl_signal_add(&wlr_output->events.present, &output->present);
    output->needs_frame.notify = handle_needs_frame;
    wl_signal_add(&wlr_output->events.needs_frame, &output->needs_frame);
    output->damage.notify = handle_damage;
    wl_signal_add(&wlr_output->events.damage, &output->damage);
    output->request_state.notify = handle_request_state;
    wl_signal_add(&wlr_output->events.request_state, &output->request_state);
    output->commit.notify = handle_commit;
    wl_signal_add(&wlr_output->events.commit, &output->commit);
    output->destroy.notify = handle_destroy;
    wl_signal_add(&wlr_output->events.destroy, &output->destroy);

    outputs_layout(server);
    output->display = display_create(output);
    camera_center_unplaced(output);
    VEC_FOR(&server->cameras, struct node *, camera) {
        const char *name = node_string(*camera, PROP_OUTPUT);
        if (!name || !strcmp(name, output_name(output)))
            camera_apply_node(output, *camera, now_seconds());
    }
    wlr_xcursor_manager_load(server->xcursor_manager, wlr_output->scale);
    if (first) input_center_pointer(server, output);
    else input_clamp_pointer(server);
    outputs_report(server);
    cameras_report(server);
    wl_list_for_each(other, &server->outputs, link) display_damage_whole(other);
    scene_changed(server);
}

void outputs_init(struct server *server) {
    server->new_output.notify = handle_new_output;
    wl_signal_add(&server->backend->events.new_output, &server->new_output);
}

void outputs_finish(struct server *server) {
    wl_list_remove(&server->new_output.link);
}
