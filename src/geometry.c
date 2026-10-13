#include "geometry.h"

#include <float.h>
#include <math.h>
#include <wayland-server-protocol.h>

const struct mat3 MAT3_IDENTITY = {1, 0, 0, 1, 0, 0, 0, 0, 1};
const struct box BOX_UNBOUNDED = {-1e7, -1e7, 2e7, 2e7};
const struct mat4 MAT4_IDENTITY = {{1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1}};

bool box_overlaps(struct box a, struct box b) {
    return a.x < box_right(b) && b.x < box_right(a) && a.y < box_bottom(b) && b.y < box_bottom(a) &&
           !box_empty(a) && !box_empty(b);
}

bool box_intersect(struct box a, struct box b, struct box *out) {
    double x = fmax(a.x, b.x), y = fmax(a.y, b.y);
    double right = fmin(box_right(a), box_right(b));
    double bottom = fmin(box_bottom(a), box_bottom(b));
    if (x >= right || y >= bottom) return false;
    *out = (struct box){x, y, right - x, bottom - y};
    return true;
}

struct box box_union(struct box a, struct box b) {
    double x = fmin(a.x, b.x), y = fmin(a.y, b.y);
    return (struct box){x, y, fmax(box_right(a), box_right(b)) - x,
                        fmax(box_bottom(a), box_bottom(b)) - y};
}

struct box box_inflate(struct box b, double margin) {
    return (struct box){b.x - margin, b.y - margin, b.width + 2 * margin, b.height + 2 * margin};
}

struct pixel_box box_pixels(struct box b, int width, int height) {
    int x = (int)fmax(0, floor(b.x)), y = (int)fmax(0, floor(b.y));
    int right = (int)fmin(width, ceil(box_right(b)));
    int bottom = (int)fmin(height, ceil(box_bottom(b)));
    return (struct pixel_box){x, y, right > x ? right - x : 0, bottom > y ? bottom - y : 0};
}

struct mat3 mat3_affine(double a, double b, double c, double d, double e, double f) {
    return (struct mat3){a, b, c, d, e, f, 0, 0, 1};
}

struct mat3 mat3_translation(double x, double y) {
    return mat3_affine(1, 0, 0, 1, x, y);
}

struct mat3 mat3_multiply(struct mat3 o, struct mat3 n) {
    return (struct mat3){
        o.a * n.a + o.c * n.b + o.e * n.g, o.b * n.a + o.d * n.b + o.f * n.g,
        o.a * n.c + o.c * n.d + o.e * n.h, o.b * n.c + o.d * n.d + o.f * n.h,
        o.a * n.e + o.c * n.f + o.e * n.i, o.b * n.e + o.d * n.f + o.f * n.i,
        o.g * n.a + o.h * n.b + o.i * n.g, o.g * n.c + o.h * n.d + o.i * n.h,
        o.g * n.e + o.h * n.f + o.i * n.i,
    };
}

double mat3_determinant(struct mat3 m) {
    return m.a * (m.d * m.i - m.f * m.h) - m.c * (m.b * m.i - m.f * m.g) +
           m.e * (m.b * m.h - m.d * m.g);
}

bool mat3_invert(struct mat3 m, struct mat3 *out) {
    double det = mat3_determinant(m);
    if (fabs(det) < 1e-12) return false;
    *out = (struct mat3){
        (m.d * m.i - m.f * m.h) / det, (m.f * m.g - m.b * m.i) / det, (m.e * m.h - m.c * m.i) / det,
        (m.a * m.i - m.e * m.g) / det, (m.c * m.f - m.e * m.d) / det, (m.e * m.b - m.a * m.f) / det,
        (m.b * m.h - m.d * m.g) / det, (m.c * m.g - m.a * m.h) / det, (m.a * m.d - m.c * m.b) / det,
    };
    return true;
}

void mat3_apply(struct mat3 m, double x, double y, double *out_x, double *out_y) {
    double w = fmax(m.g * x + m.h * y + m.i, NEAREST_DEPTH);
    *out_x = (m.a * x + m.c * y + m.e) / w;
    *out_y = (m.b * x + m.d * y + m.f) / w;
}

void mat3_jacobian(struct mat3 m, double x, double y, double out[4]) {
    double w = fmax(m.g * x + m.h * y + m.i, NEAREST_DEPTH);
    double image_x = (m.a * x + m.c * y + m.e) / w;
    double image_y = (m.b * x + m.d * y + m.f) / w;
    out[0] = (m.a - image_x * m.g) / w;
    out[1] = (m.b - image_y * m.g) / w;
    out[2] = (m.c - image_x * m.h) / w;
    out[3] = (m.d - image_y * m.h) / w;
}

double mat3_scale_factor(struct mat3 m, double x, double y) {
    double j[4];
    mat3_jacobian(m, x, y, j);
    return sqrt(fabs(j[0] * j[3] - j[1] * j[2]));
}

bool mat3_is_affine(struct mat3 m) {
    return m.g == 0 && m.h == 0 && m.i == 1;
}

bool mat3_is_upright(struct mat3 m) {
    return mat3_is_affine(m) && m.b == 0 && m.c == 0;
}

double mat3_pixel_size(struct mat3 m, double x, double y) {
    return 1 / fmax(1e-9, mat3_scale_factor(m, x, y));
}

double mat3_plane_pixel(struct mat3 m, double width, double height) {
    struct mat3 inverse;
    double x = 0, y = 0;
    if (mat3_invert(m, &inverse)) {
        double cx = width / 2, cy = height / 2;
        if (inverse.g * cx + inverse.h * cy + inverse.i > 0) mat3_apply(inverse, cx, cy, &x, &y);
    }
    return mat3_pixel_size(m, x, y);
}

struct box mat3_box_bounds(struct mat3 m, struct box b, double margin) {
    double left = DBL_MAX, top = DBL_MAX, right = -DBL_MAX, bottom = -DBL_MAX;
    const double xs[2] = {b.x, b.x + b.width}, ys[2] = {b.y, b.y + b.height};
    for (int i = 0; i < 4; i++) {
        double x = xs[i & 1], y = ys[i >> 1];
        double w = m.g * x + m.h * y + m.i;
        if (w < NEAREST_DEPTH) return BOX_UNBOUNDED;
        double px = (m.a * x + m.c * y + m.e) / w, py = (m.b * x + m.d * y + m.f) / w;
        left = fmin(left, px);
        top = fmin(top, py);
        right = fmax(right, px);
        bottom = fmax(bottom, py);
    }
    return (struct box){left - margin, top - margin, right - left + 2 * margin,
                        bottom - top + 2 * margin};
}

struct mat4 mat4_multiply(const struct mat4 *outer, const struct mat4 *inner) {
    struct mat4 product;
    for (int row = 0; row < 4; row++) {
        for (int column = 0; column < 4; column++) {
            const double *o = outer->m + row * 4;
            product.m[row * 4 + column] = o[0] * inner->m[column] + o[1] * inner->m[4 + column] +
                                          o[2] * inner->m[8 + column] +
                                          o[3] * inner->m[12 + column];
        }
    }
    return product;
}

struct mat4 mat4_translation(double x, double y, double z) {
    return (struct mat4){{1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1}};
}

struct mat4 mat4_from_mat3(struct mat3 t) {
    return (struct mat4){{t.a, t.c, 0, t.e, t.b, t.d, 0, t.f, 0, 0, 1, 0, t.g, t.h, 0, t.i}};
}

struct mat3 mat4_plane(const struct mat4 *m) {
    return (struct mat3){m->m[0], m->m[4],  m->m[1],  m->m[5], m->m[3],
                         m->m[7], m->m[12], m->m[13], m->m[15]};
}

struct mat3 view_transform(double x, double y, double zoom, double rotation, double viewport_width,
                           double viewport_height) {
    double cosine = zoom * cos(rotation);
    double sine = -zoom * sin(rotation);
    /* T(viewport centre) · R(-rotation) · S(zoom) · T(-x, -y), expanded. */
    return mat3_affine(cosine, sine, -sine, cosine, viewport_width / 2 - (cosine * x - sine * y),
                       viewport_height / 2 - (sine * x + cosine * y));
}

void transform_normalized(int transform, double u, double v, double *out_u, double *out_v) {
    switch (transform) {
    case WL_OUTPUT_TRANSFORM_90:
        *out_u = 1 - v;
        *out_v = u;
        break;
    case WL_OUTPUT_TRANSFORM_180:
        *out_u = 1 - u;
        *out_v = 1 - v;
        break;
    case WL_OUTPUT_TRANSFORM_270:
        *out_u = v;
        *out_v = 1 - u;
        break;
    case WL_OUTPUT_TRANSFORM_FLIPPED:
        *out_u = 1 - u;
        *out_v = v;
        break;
    case WL_OUTPUT_TRANSFORM_FLIPPED_90:
        *out_u = 1 - v;
        *out_v = 1 - u;
        break;
    case WL_OUTPUT_TRANSFORM_FLIPPED_180:
        *out_u = u;
        *out_v = 1 - v;
        break;
    case WL_OUTPUT_TRANSFORM_FLIPPED_270:
        *out_u = v;
        *out_v = u;
        break;
    default:
        *out_u = u;
        *out_v = v;
        break;
    }
}

struct mat3 output_buffer_transform(double logical_width, double logical_height, int buffer_width,
                                    int buffer_height, int transform) {
    double u0, v0, u1, v1, u2, v2;
    transform_normalized(transform, 0, 0, &u0, &v0);
    transform_normalized(transform, 1, 0, &u1, &v1);
    transform_normalized(transform, 0, 1, &u2, &v2);
    double x0 = u0 * buffer_width, y0 = v0 * buffer_height;
    double x1 = u1 * buffer_width, y1 = v1 * buffer_height;
    double x2 = u2 * buffer_width, y2 = v2 * buffer_height;
    return mat3_affine((x1 - x0) / logical_width, (y1 - y0) / logical_width,
                       (x2 - x0) / logical_height, (y2 - y0) / logical_height, x0, y0);
}
