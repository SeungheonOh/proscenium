/*
 * The protocol's JSON: a bounded parser that never trusts its input, and an
 * encoder writing straight into a string buffer.
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "util.h"

enum json_type {
    JSON_NULL,
    JSON_FALSE,
    JSON_TRUE,
    JSON_NUMBER,
    JSON_STRING,
    JSON_ARRAY,
    JSON_OBJECT,
};

struct json_member;

struct json_value {
    enum json_type type;
    /* A number written without fraction or exponent. */
    bool integer;
    union {
        double number;
        struct {
            char *chars; /* NUL-terminated; may also contain NULs */
            size_t length;
        } string;
        struct {
            struct json_value *items;
            size_t count;
        } array;
        struct {
            struct json_member *members;
            size_t count;
        } object;
    };
};

struct json_member {
    struct json_value key;
    struct json_value value;
};

/* Owns every value of one parsed document. */
struct json_document {
    struct json_value *root;
    void *arena;
};

/*
 * Parse TEXT, which must hold exactly one value within what the director protocol
 * allows: 16 levels, 1,000,000 values, 8 MiB strings. On failure DOCUMENT is left
 * empty and ERROR describes the problem.
 */
bool json_parse(const char *text, size_t length, struct json_document *document, char *error,
                size_t error_size);
void json_document_finish(struct json_document *document);

/* Member KEY of OBJECT, or NULL when absent; a JSON null member is returned as such. */
const struct json_value *json_get(const struct json_value *object, const char *key);
/* Like json_get, but NULL also for a null value: "not given". */
const struct json_value *json_given(const struct json_value *object, const char *key);
bool json_is_string(const struct json_value *value, const char *text);
/* VALUE as an integer in [minimum, maximum]. */
bool json_integer(const struct json_value *value, int64_t minimum, int64_t maximum, int64_t *out);

/*
 * Writing. A message is built with begin/end calls; keys and commas are placed
 * by tracking whether the current container has a member yet.
 */
struct json_writer {
    struct strbuf *out;
    int depth;
    bool first[32];
    /* A key was written; the next value takes its place without a comma. */
    bool pending_key;
};

void json_writer_init(struct json_writer *writer, struct strbuf *out);
void json_object_begin(struct json_writer *writer);
void json_object_end(struct json_writer *writer);
void json_array_begin(struct json_writer *writer);
void json_array_end(struct json_writer *writer);
/* Start a member of the current object; the next value written is its value. */
void json_key(struct json_writer *writer, const char *key);
void json_string(struct json_writer *writer, const char *text);
void json_string_n(struct json_writer *writer, const char *text, size_t length);
/* Integers exactly, other numbers with six decimals. */
void json_number(struct json_writer *writer, double value);
void json_int(struct json_writer *writer, int64_t value);
void json_bool(struct json_writer *writer, bool value);
void json_null(struct json_writer *writer);
/* Already encoded JSON text, written as the next value. */
void json_raw(struct json_writer *writer, const char *text, size_t length);
