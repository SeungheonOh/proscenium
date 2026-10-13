#include "motion.h"

#include <math.h>

#include "util.h"

struct motion *motion_create(enum motion_kind kind) {
    struct motion *motion = xcalloc(1, sizeof *motion);
    *motion = (struct motion){
        .references = 1,
        .kind = kind,
        .stiffness = 170,
        .damping = 26,
        .mass = 1,
        .duration = 0.25,
    };
    return motion;
}

struct motion *motion_ref(struct motion *motion) {
    if (motion) motion->references++;
    return motion;
}

void motion_unref(struct motion *motion) {
    if (!motion || --motion->references > 0) return;
    free(motion->points);
    free(motion);
}

bool motion_loops(const struct motion *motion) {
    return motion && motion->repeat == MOTION_FOREVER;
}

void channel_init(struct channel *channel, double value, double tolerance) {
    *channel = (struct channel){.value = value, .target = value, .tolerance = tolerance};
}

void channel_finish(struct channel *channel) {
    motion_unref(channel->motion);
    channel->motion = NULL;
}

static void set_motion(struct channel *channel, struct motion *motion) {
    if (channel->motion == motion) return;
    motion_ref(motion);
    motion_unref(channel->motion);
    channel->motion = motion;
}

/* Displacement and velocity of a damped spring released ELAPSED seconds ago. */
static void spring_state(const struct motion *motion, double displacement, double velocity,
                         double elapsed, double *out_displacement, double *out_velocity) {
    double stiffness = motion->stiffness, mass = motion->mass;
    double natural = sqrt(stiffness / mass);
    double ratio = motion->damping / (2 * sqrt(stiffness * mass));
    if (fabs(ratio - 1) < 1e-6) {
        double decay = exp(-natural * elapsed);
        double slope = velocity + natural * displacement;
        *out_displacement = decay * (displacement + slope * elapsed);
        *out_velocity = decay * (velocity - natural * slope * elapsed);
    } else if (ratio < 1) {
        double attenuation = ratio * natural;
        double frequency = natural * sqrt(1 - ratio * ratio);
        double decay = exp(-attenuation * elapsed);
        double sine_weight = (velocity + attenuation * displacement) / frequency;
        double cosine = cos(frequency * elapsed), sine = sin(frequency * elapsed);
        *out_displacement = decay * (displacement * cosine + sine_weight * sine);
        *out_velocity = decay * ((sine_weight * frequency - attenuation * displacement) * cosine -
                                 (displacement * frequency + attenuation * sine_weight) * sine);
    } else {
        double root = sqrt(ratio * ratio - 1);
        double slow = -natural * (ratio - root), fast = -natural * (ratio + root);
        double slow_weight = (velocity - fast * displacement) / (slow - fast);
        double fast_weight = displacement - slow_weight;
        double slow_term = slow_weight * exp(slow * elapsed);
        double fast_term = fast_weight * exp(fast * elapsed);
        *out_displacement = slow_term + fast_term;
        *out_velocity = slow * slow_term + fast * fast_term;
    }
}

static double bezier(double first, double second, double t) {
    double inverse = 1 - t;
    return 3 * inverse * inverse * t * first + 3 * inverse * t * t * second + t * t * t;
}

static double bezier_slope(double first, double second, double t) {
    double inverse = 1 - t;
    return 3 * inverse * inverse * first + 6 * inverse * t * (second - first) +
           3 * t * t * (1 - second);
}

/* EASE, a CSS cubic-bezier, at PROGRESS; SLOPE receives the derivative. */
static double ease_progress(const double ease[4], double progress, double *slope) {
    double x1 = ease[0], y1 = ease[1], x2 = ease[2], y2 = ease[3];
    /* Newton converges in a few steps for CSS curves; bisection covers flat stretches. */
    double t = progress;
    for (int i = 0; i < 8; i++) {
        double s = bezier_slope(x1, x2, t);
        if (fabs(s) < 1e-6) break;
        t -= (bezier(x1, x2, t) - progress) / s;
    }
    if (!(t >= 0 && t <= 1 && fabs(bezier(x1, x2, t) - progress) < 1e-6)) {
        double low = 0, high = 1;
        for (int i = 0; i < 40; i++) {
            t = 0.5 * (low + high);
            if (bezier(x1, x2, t) < progress) low = t;
            else high = t;
        }
    }
    double s = bezier_slope(x1, x2, t);
    if (slope) *slope = fabs(s) < 1e-9 ? 0 : bezier_slope(y1, y2, t) / s;
    return bezier(y1, y2, t);
}

static double eased(const struct motion *motion, double progress, double *slope) {
    if (!motion->eased) {
        *slope = 1;
        return progress;
    }
    return ease_progress(motion->ease, progress, slope);
}

static double curve_progress(const struct motion *motion, double progress, double *slope) {
    int last = motion->point_count - 1;
    double position = CLAMP(progress, 0.0, 1.0) * last;
    int index = MIN(last - 1, (int)floor(position));
    double low = motion->points[index], high = motion->points[index + 1];
    *slope = (high - low) * last;
    return low + (high - low) * (position - index);
}

/* Value and velocity of a possibly repeating tween or curve; false once done. */
static bool tween_state(const struct motion *motion, double start, double target, double elapsed,
                        double *value, double *velocity) {
    double duration = motion->duration;
    double iteration = floor(elapsed / duration);
    if (motion->repeat != MOTION_FOREVER && iteration > motion->repeat) return false;
    /* Clamped: with a tiny duration the remainder is rounding noise. */
    double fraction = fmin(1, fmax(0, (elapsed - iteration * duration) / duration)), slope;
    double progress = motion->kind == MOTION_CURVE ? curve_progress(motion, fraction, &slope)
                                                   : eased(motion, fraction, &slope);
    double distance = target - start;
    *value = start + distance * progress;
    *velocity = distance * slope / duration;
    return true;
}

/* CHANNEL's state ELAPSED seconds into its motion; false once settled. */
static bool motion_state(const struct channel *channel, double elapsed, double *value,
                         double *velocity) {
    const struct motion *motion = channel->motion;
    double target = channel->target, start = channel->start_value;
    double tolerance = channel->tolerance;
    switch (motion->kind) {
    case MOTION_SPRING: {
        double displacement;
        spring_state(motion, start - target, channel->start_velocity, elapsed, &displacement,
                     velocity);
        if (fabs(displacement) < tolerance && fabs(*velocity) < 20 * tolerance) return false;
        *value = target + displacement;
        return true;
    }
    case MOTION_TWEEN:
    case MOTION_CURVE: return tween_state(motion, start, target, elapsed, value, velocity);
    case MOTION_DECAY: {
        /* x(t) = x0 + v0·τ·(1 - e^(-t/τ)); the target is the asymptote. */
        *velocity = channel->start_velocity * exp(-elapsed / motion->duration);
        double distance = *velocity * motion->duration;
        if (fabs(distance) < fmax(tolerance, motion->rest)) return false;
        *value = target - distance;
        return true;
    }
    case MOTION_INSTANT: break;
    }
    return false;
}

bool channel_sample(struct channel *channel, double time) {
    if (!channel->motion) return false;
    double elapsed = time - channel->start_time - channel->motion->delay;
    if (elapsed < 0) {
        /* A delayed motion holds its starting state until it begins. */
        channel->value = channel->start_value;
        channel->velocity = 0;
        return true;
    }
    double value, velocity;
    if (motion_state(channel, elapsed, &value, &velocity)) {
        channel->value = value;
        channel->velocity = velocity;
    } else {
        channel->value = channel->target;
        channel->velocity = 0;
        set_motion(channel, NULL);
    }
    return channel->motion != NULL;
}

void channel_retarget(struct channel *channel, double target, struct motion *motion, double time) {
    channel_sample(channel, time);
    if (!motion || motion->kind == MOTION_INSTANT) {
        channel->value = channel->target = target;
        channel->velocity = 0;
        set_motion(channel, NULL);
    } else if (target == channel->target && (channel->motion || target == channel->value)) {
        /* An unchanged destination keeps its trajectory; restarting a tween here
         * would visibly stall every repeated commit. */
    } else {
        channel->target = target;
        set_motion(channel, motion);
        channel->start_time = time;
        channel->start_value = channel->value;
        channel->start_velocity = motion->has_velocity ? motion->velocity : channel->velocity;
    }
}

void channel_jump(struct channel *channel, double value) {
    channel->value = channel->target = value;
    channel->velocity = 0;
    set_motion(channel, NULL);
}

void channel_fling(struct channel *channel, double velocity, double time_constant, double rest,
                   double time) {
    channel_sample(channel, time);
    struct motion *motion = motion_create(MOTION_DECAY);
    motion->duration = time_constant;
    motion->rest = rest;
    channel->start_time = time;
    channel->start_value = channel->value;
    channel->start_velocity = channel->velocity = velocity;
    channel->target = channel->value + velocity * time_constant;
    set_motion(channel, motion);
    motion_unref(motion);
}

void channel_inherit(struct channel *channel, double value, double velocity, struct motion *motion,
                     double time) {
    channel->value = value;
    channel->velocity = velocity;
    set_motion(channel, NULL);
    channel_retarget(channel, channel->target, motion, time);
}

void track_finish(struct track *track) {
    free(track->keyframes);
    free(track->offsets);
    *track = (struct track){0};
}

bool track_endless(const struct track *track) {
    return track->iterations == MOTION_FOREVER;
}

enum track_state track_sample(const struct track *track, double elapsed, double *out) {
    elapsed -= track->delay;
    if (elapsed < 0) return TRACK_PENDING;
    double duration = track->duration;
    double iteration = floor(elapsed / duration);
    if (track->iterations != MOTION_FOREVER && iteration >= track->iterations) return TRACK_DONE;
    double fraction = fmin(1, fmax(0, (elapsed - iteration * duration) / duration));
    bool odd = fmod(iteration, 2) != 0;
    bool backward = false;
    switch (track->direction) {
    case TRACK_NORMAL: backward = false; break;
    case TRACK_REVERSE: backward = true; break;
    case TRACK_ALTERNATE: backward = odd; break;
    case TRACK_ALTERNATE_REVERSE: backward = !odd; break;
    }
    double progress = backward ? 1 - fraction : fraction;
    if (track->eased) progress = ease_progress(track->ease, progress, NULL);
    int index = track->count - 1;
    for (int i = 1; i < track->count; i++) {
        if (track->offsets[i] > progress) {
            index = i;
            break;
        }
    }
    double start = track->offsets[index - 1];
    double span = track->offsets[index] - start;
    double t = span > 0 ? (progress - start) / span : 1;
    const double *from = track->keyframes + (index - 1) * track->width;
    const double *to = track->keyframes + index * track->width;
    for (int i = 0; i < track->width; i++) out[i] = from[i] + (to[i] - from[i]) * t;
    return TRACK_RUNNING;
}
