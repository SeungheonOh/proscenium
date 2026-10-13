/*
 * Plane geometry shared by drawing, damage and picking.
 *
 * Scene nodes compose 4x4 matrices down the tree, keeping depth, and each draws
 * its z = 0 plane through the product: a projective map of the plane, kept as a
 * homogeneous 3x3 matrix so composition and inversion stay exact. The same map
 * places pixels, projects damage and picks input, so input lands exactly on what
 * was presented.
 */
#pragma once

#include <stdbool.h>

/* An axis-aligned rectangle; empty unless width and height are positive. */
struct box {
    double x, y, width, height;
};

static inline double box_right(struct box b) {
    return b.x + b.width;
}
static inline double box_bottom(struct box b) {
    return b.y + b.height;
}
static inline bool box_empty(struct box b) {
    return b.width <= 0 || b.height <= 0;
}
static inline double box_area(struct box b) {
    return box_empty(b) ? 0 : b.width * b.height;
}

/* Whether the boxes share any area. */
bool box_overlaps(struct box a, struct box b);
/* The overlap of A and B; false when they share no area. */
bool box_intersect(struct box a, struct box b, struct box *out);
struct box box_union(struct box a, struct box b);
struct box box_inflate(struct box b, double margin);

/* Integer pixel bounds rounded outward and clipped to WIDTH x HEIGHT. */
struct pixel_box {
    int x, y, width, height;
};
struct pixel_box box_pixels(struct box b, int width, int height);

/*
 * Maps (x, y) to ((a x + c y + e) / w, (b x + d y + f) / w) with
 * w = g x + h y + i. Affine maps keep g = h = 0 and i = 1.
 */
struct mat3 {
    double a, b, c, d, e, f, g, h, i;
};

/* The least homogeneous w of a point in front of the viewer. */
#define NEAREST_DEPTH 1e-6

extern const struct mat3 MAT3_IDENTITY;

struct mat3 mat3_affine(double a, double b, double c, double d, double e, double f);
struct mat3 mat3_translation(double x, double y);
/* The map applying INNER first, then OUTER. */
struct mat3 mat3_multiply(struct mat3 outer, struct mat3 inner);
double mat3_determinant(struct mat3 m);
/* False when M collapses an axis. */
bool mat3_invert(struct mat3 m, struct mat3 *out);
/* Map a point; one at or behind the viewer maps far away. */
void mat3_apply(struct mat3 m, double x, double y, double *out_x, double *out_y);
/* Partial derivatives dX/dx, dY/dx, dX/dy, dY/dy of the image at (x, y). */
void mat3_jacobian(struct mat3 m, double x, double y, double out[4]);
/* Output pixels per local unit around (x, y): the geometric mean of the axis scales. */
double mat3_scale_factor(struct mat3 m, double x, double y);
/* Local units per output pixel around (x, y). */
double mat3_pixel_size(struct mat3 m, double x, double y);
/* Local units per output pixel of the plane M places, where it shows at the centre of a
 * WIDTH x HEIGHT buffer. */
double mat3_plane_pixel(struct mat3 m, double width, double height);
bool mat3_is_affine(struct mat3 m);
/* Whether M keeps boxes upright: affine, with no rotation or skew. */
bool mat3_is_upright(struct mat3 m);
/*
 * Bounds of the transformed rectangle, grown by MARGIN; a shape reaching behind
 * the viewer has no finite image and returns BOX_UNBOUNDED.
 */
struct box mat3_box_bounds(struct mat3 m, struct box b, double margin);
extern const struct box BOX_UNBOUNDED;

/* A 4x4 matrix of homogeneous 3D points, row by row. */
struct mat4 {
    double m[16];
};

extern const struct mat4 MAT4_IDENTITY;

struct mat4 mat4_multiply(const struct mat4 *outer, const struct mat4 *inner);
struct mat4 mat4_translation(double x, double y, double z);
/* M, a map of the plane, as a matrix leaving depth alone. */
struct mat4 mat4_from_mat3(struct mat3 m);
/* Where M takes the z = 0 plane, as a projective map of the plane. */
struct mat3 mat4_plane(const struct mat4 *m);

/*
 * World space to output-logical space for a camera centred on world point
 * (x, y) at ZOOM, turned by ROTATION radians, on a viewport of the given size.
 */
struct mat3 view_transform(double x, double y, double zoom, double rotation, double viewport_width,
                           double viewport_height);

/* Where a wl_output transform takes normalized point (u, v) of the logical output. */
void transform_normalized(int transform, double u, double v, double *out_u, double *out_v);
/*
 * Output-logical coordinates to buffer pixels for a wl_output transform
 * (enum wl_output_transform).
 */
struct mat3 output_buffer_transform(double logical_width, double logical_height, int buffer_width,
                                    int buffer_height, int transform);
