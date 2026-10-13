#include "util.h"

#include <stdarg.h>
#include <stdio.h>

static void *check(void *pointer) {
    if (!pointer) {
        fprintf(stderr, "proscenium: out of memory\n");
        abort();
    }
    return pointer;
}

void *xmalloc(size_t size) {
    return check(malloc(size ? size : 1));
}

void *xcalloc(size_t count, size_t size) {
    return check(calloc(count ? count : 1, size ? size : 1));
}

void *xrealloc(void *pointer, size_t size) {
    return check(realloc(pointer, size ? size : 1));
}

char *xstrdup(const char *text) {
    return check(strdup(text));
}

char *xstrndup(const char *text, size_t length) {
    return check(strndup(text, length));
}

void vec_init(struct vec *vec, size_t element) {
    *vec = (struct vec){.element = element};
}

void vec_finish(struct vec *vec) {
    free(vec->data);
    vec->data = NULL;
    vec->length = vec->capacity = 0;
}

void *vec_push(struct vec *vec) {
    if (vec->length == vec->capacity) {
        vec->capacity = vec->capacity ? vec->capacity * 2 : 8;
        vec->data = xrealloc(vec->data, vec->capacity * vec->element);
    }
    void *element = (char *)vec->data + vec->length++ * vec->element;
    memset(element, 0, vec->element);
    return element;
}

void vec_remove(struct vec *vec, size_t index) {
    char *base = vec->data;
    memmove(base + index * vec->element, base + (index + 1) * vec->element,
            (vec->length - index - 1) * vec->element);
    vec->length--;
}

void vec_clear(struct vec *vec) {
    vec->length = 0;
}

void strbuf_init(struct strbuf *buffer) {
    *buffer = (struct strbuf){0};
}

void strbuf_finish(struct strbuf *buffer) {
    free(buffer->data);
    *buffer = (struct strbuf){0};
}

static void reserve(struct strbuf *buffer, size_t extra) {
    size_t needed = buffer->length + extra + 1;
    if (needed <= buffer->capacity) return;
    size_t capacity = buffer->capacity ? buffer->capacity : 64;
    while (capacity < needed) capacity *= 2;
    buffer->data = xrealloc(buffer->data, capacity);
    buffer->capacity = capacity;
}

void strbuf_append(struct strbuf *buffer, const char *bytes, size_t length) {
    reserve(buffer, length);
    memcpy(buffer->data + buffer->length, bytes, length);
    buffer->length += length;
    buffer->data[buffer->length] = '\0';
}

void strbuf_puts(struct strbuf *buffer, const char *text) {
    strbuf_append(buffer, text, strlen(text));
}

void strbuf_putc(struct strbuf *buffer, char character) {
    strbuf_append(buffer, &character, 1);
}

void strbuf_printf(struct strbuf *buffer, const char *format, ...) {
    va_list arguments;
    va_start(arguments, format);
    va_list copy;
    va_copy(copy, arguments);
    int length = vsnprintf(NULL, 0, format, copy);
    va_end(copy);
    if (length > 0) {
        reserve(buffer, (size_t)length);
        vsnprintf(buffer->data + buffer->length, (size_t)length + 1, format, arguments);
        buffer->length += (size_t)length;
    }
    va_end(arguments);
}

void strbuf_consume(struct strbuf *buffer, size_t count) {
    if (count >= buffer->length) {
        strbuf_clear(buffer);
        return;
    }
    memmove(buffer->data, buffer->data + count, buffer->length - count + 1);
    buffer->length -= count;
}

void strbuf_clear(struct strbuf *buffer) {
    buffer->length = 0;
    if (buffer->data) buffer->data[0] = '\0';
}

/* Slots are empty with a NULL value; removed ones keep their key with a tombstone value. */
static char tombstone;

void idmap_init(struct idmap *map) {
    *map = (struct idmap){0};
}

void idmap_finish(struct idmap *map) {
    free(map->slots);
    *map = (struct idmap){0};
}

void idmap_clear(struct idmap *map) {
    if (map->capacity) memset(map->slots, 0, map->capacity * sizeof *map->slots);
    map->count = map->tombstones = 0;
}

static size_t slot_of(int64_t key, size_t capacity) {
    uint64_t hash = (uint64_t)key * 0x9e3779b97f4a7c15ull;
    return (size_t)(hash >> 32) & (capacity - 1);
}

static void grow(struct idmap *map) {
    size_t capacity = map->capacity ? map->capacity * 2 : 64;
    if ((map->count + 1) * 2 < map->capacity)
        capacity = map->capacity; /* only tombstones to clear */
    struct idmap_slot *old = map->slots;
    size_t old_capacity = map->capacity;
    map->slots = xcalloc(capacity, sizeof *map->slots);
    map->capacity = capacity;
    map->count = map->tombstones = 0;
    for (size_t i = 0; i < old_capacity; i++) {
        if (old[i].value && old[i].value != &tombstone) idmap_put(map, old[i].key, old[i].value);
    }
    free(old);
}

void *idmap_get(const struct idmap *map, int64_t key) {
    if (!map->capacity) return NULL;
    for (size_t i = slot_of(key, map->capacity);; i = (i + 1) & (map->capacity - 1)) {
        struct idmap_slot *slot = &map->slots[i];
        if (!slot->value) return NULL;
        if (slot->key == key && slot->value != &tombstone) return slot->value;
    }
}

void idmap_put(struct idmap *map, int64_t key, void *value) {
    if ((map->count + map->tombstones + 1) * 4 >= map->capacity * 3) grow(map);
    struct idmap_slot *reuse = NULL;
    for (size_t i = slot_of(key, map->capacity);; i = (i + 1) & (map->capacity - 1)) {
        struct idmap_slot *slot = &map->slots[i];
        if (slot->value == &tombstone) {
            if (!reuse) reuse = slot;
            continue;
        }
        if (!slot->value) {
            if (reuse) {
                map->tombstones--;
                slot = reuse;
            }
            *slot = (struct idmap_slot){key, value};
            map->count++;
            return;
        }
        if (slot->key == key) {
            slot->value = value;
            return;
        }
    }
}

void idmap_remove(struct idmap *map, int64_t key) {
    if (!map->capacity) return;
    for (size_t i = slot_of(key, map->capacity);; i = (i + 1) & (map->capacity - 1)) {
        struct idmap_slot *slot = &map->slots[i];
        if (!slot->value) return;
        if (slot->key == key && slot->value != &tombstone) {
            slot->value = &tombstone;
            map->count--;
            map->tombstones++;
            return;
        }
    }
}

bool idmap_next(const struct idmap *map, size_t *index, int64_t *key, void **value) {
    for (; *index < map->capacity; (*index)++) {
        struct idmap_slot *slot = &map->slots[*index];
        if (slot->value && slot->value != &tombstone) {
            *key = slot->key;
            *value = slot->value;
            (*index)++;
            return true;
        }
    }
    return false;
}
