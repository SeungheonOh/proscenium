/*
 * Retargetable scalar motion.
 *
 * Every animated property owns channels holding its displayed value and
 * velocity. Retargeting first samples the current state, so springs keep their
 * momentum and interrupted tweens continue from what is on screen. Springs use
 * the closed-form damped oscillator: sampling is exact at any frame rate, and a
 * settled channel asks for nothing. Keyframe tracks are pure functions of time
 * that animations sample on top of a property's value.
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>

enum motion_kind {
    MOTION_INSTANT,
    MOTION_SPRING,
    MOTION_TWEEN,
    MOTION_CURVE,
    MOTION_DECAY,
};

#define MOTION_FOREVER (-1)

/* An immutable transition, shared by the channels moving with it. */
struct motion {
    int references;
    enum motion_kind kind;
    double stiffness, damping, mass;
    /* A spring may start at its own velocity instead of the value's, e.g. after a fling. */
    bool has_velocity;
    double velocity;
    /* Tweens and curves: seconds per run; decay: the time constant. */
    double duration;
    double delay;
    /* Extra runs of a tween or curve, or MOTION_FOREVER. */
    int repeat;
    /* A CSS cubic-bezier, or linear when not eased. */
    bool eased;
    double ease[4];
    /* A curve's progress, sampled evenly over its duration. */
    double *points;
    int point_count;
    /* Decay settles once less than this remains. */
    double rest;
};

/* A new motion with the protocol's defaults for KIND and one reference. */
struct motion *motion_create(enum motion_kind kind);
struct motion *motion_ref(struct motion *motion);
void motion_unref(struct motion *motion);
bool motion_loops(const struct motion *motion);

struct channel {
    double value, velocity, target;
    /* NULL once settled. */
    struct motion *motion;
    double start_time, start_value, start_velocity;
    double tolerance;
};

void channel_init(struct channel *channel, double value, double tolerance);
void channel_finish(struct channel *channel);
static inline bool channel_active(const struct channel *channel) {
    return channel->motion != NULL;
}
/* Advance to TIME; true while still moving. */
bool channel_sample(struct channel *channel, double time);
/* Move toward TARGET from the state at TIME; a NULL or instant motion jumps. */
void channel_retarget(struct channel *channel, double target, struct motion *motion, double time);
/* Show VALUE at once and make it the destination, as direct manipulation does. */
void channel_jump(struct channel *channel, double value);
/*
 * Coast from the displayed value at VELOCITY units a second, decaying with
 * TIME_CONSTANT until less than REST units remain.
 */
void channel_fling(struct channel *channel, double velocity, double time_constant, double rest,
                   double time);
/* Continue from another channel's displayed VALUE and VELOCITY toward this one's target. */
void channel_inherit(struct channel *channel, double value, double velocity, struct motion *motion,
                     double time);

enum track_direction {
    TRACK_NORMAL,
    TRACK_REVERSE,
    TRACK_ALTERNATE,
    TRACK_ALTERNATE_REVERSE,
};

enum track_state {
    TRACK_PENDING,
    TRACK_RUNNING,
    TRACK_DONE,
};

/*
 * Keyframes, each WIDTH numbers (1, 2 or 4, or a transform's parameters), at OFFSETS in 0..1 of
 * each iteration, run ITERATIONS times (or MOTION_FOREVER) of DURATION seconds after DELAY. Values
 * between keyframes are linear; easing that overshoots extrapolates the first or last segment.
 */
struct track {
    int count, width;
    double *keyframes;
    double *offsets;
    bool eased;
    double ease[4];
    double duration, delay;
    int iterations;
    enum track_direction direction;
};

void track_finish(struct track *track);
bool track_endless(const struct track *track);
/* The track's value ELAPSED seconds after it started, into OUT (WIDTH numbers). */
enum track_state track_sample(const struct track *track, double elapsed, double *out);
