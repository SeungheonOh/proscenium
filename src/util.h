/* Small helpers shared by every module: time, growable arrays and strings. */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#define ARRAY_LENGTH(a) (sizeof(a) / sizeof((a)[0]))
#ifndef MIN
#define MIN(a, b) ((a) < (b) ? (a) : (b))
#endif
#ifndef MAX
#define MAX(a, b) ((a) > (b) ? (a) : (b))
#endif
#ifndef CLAMP
#define CLAMP(v, lo, hi) MIN(MAX(v, lo), hi)
#endif

/* Seconds on the monotonic clock. */
static inline double now_seconds(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec + ts.tv_nsec / 1e9;
}

/* Nanoseconds on the monotonic clock. */
static inline int64_t now_nanoseconds(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (int64_t)ts.tv_sec * 1000000000 + ts.tv_nsec;
}

/* Allocation that cannot fail: a compositor out of memory has no way forward. */
void *xmalloc(size_t size);
void *xcalloc(size_t count, size_t size);
void *xrealloc(void *pointer, size_t size);
char *xstrdup(const char *text);
char *xstrndup(const char *text, size_t length);

/*
 * A growable array of fixed-size elements. Pointers into it stay valid only
 * until the next growth.
 */
struct vec {
    void *data;
    size_t length, capacity, element;
};

void vec_init(struct vec *vec, size_t element);
void vec_finish(struct vec *vec);
/* A new zeroed element at the end. */
void *vec_push(struct vec *vec);
static inline void *vec_at(const struct vec *vec, size_t index) {
    return (char *)vec->data + index * vec->element;
}
void vec_remove(struct vec *vec, size_t index);
void vec_clear(struct vec *vec);

#define VEC_FOR(vec, type, name)                                                                   \
    for (type *name = (vec)->data; name < (type *)(vec)->data + (vec)->length; name++)

/* A growable byte string, always NUL-terminated. */
struct strbuf {
    char *data;
    size_t length, capacity;
};

void strbuf_init(struct strbuf *buffer);
void strbuf_finish(struct strbuf *buffer);
void strbuf_append(struct strbuf *buffer, const char *bytes, size_t length);
void strbuf_puts(struct strbuf *buffer, const char *text);
void strbuf_putc(struct strbuf *buffer, char character);
void strbuf_printf(struct strbuf *buffer, const char *format, ...)
    __attribute__((format(printf, 2, 3)));
/* Drop the first COUNT bytes. */
void strbuf_consume(struct strbuf *buffer, size_t count);
void strbuf_clear(struct strbuf *buffer);

/* A 64-bit hash for content signatures and keys, never kept beyond the process. */
static inline uint64_t hash_bytes(uint64_t hash, const void *bytes, size_t length) {
    const unsigned char *p = bytes;
    /* Eight bytes a step, each step a bijection of the hash: inputs differing in one
     * word always hash apart. */
    for (; length >= 8; p += 8, length -= 8) {
        uint64_t word;
        memcpy(&word, p, sizeof word);
        hash = (hash ^ word) * 0x9e3779b97f4a7c15ull;
        hash ^= hash >> 32;
    }
    for (; length; p++, length--) hash = (hash ^ *p) * 0x100000001b3ull;
    return hash;
}
#define HASH_SEED 0xcbf29ce484222325ull

/* Integer keys to pointers, open addressing. */
struct idmap {
    struct idmap_slot {
        int64_t key;
        void *value;
    } * slots;
    size_t capacity, count, tombstones;
};

void idmap_init(struct idmap *map);
void idmap_finish(struct idmap *map);
/* Remove every entry, keeping the slots for reuse. */
void idmap_clear(struct idmap *map);
void *idmap_get(const struct idmap *map, int64_t key);
void idmap_put(struct idmap *map, int64_t key, void *value);
void idmap_remove(struct idmap *map, int64_t key);
/* Iterate with an index starting at 0; returns false when done. */
bool idmap_next(const struct idmap *map, size_t *index, int64_t *key, void **value);
