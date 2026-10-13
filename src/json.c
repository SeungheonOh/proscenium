#include "json.h"

#include <math.h>
#include <stdalign.h>
#include <stdarg.h>
#include <stdio.h>

#define MAX_DEPTH 16
#define MAX_VALUES 1000000
#define MAX_STRING_BYTES (8u << 20)

/* Values live in chunks freed together with their document. */
struct chunk {
    struct chunk *next;
    size_t used, size;
    alignas(max_align_t) unsigned char data[];
};

struct parser {
    const char *text;
    size_t length, position;
    size_t values;
    struct chunk *chunks;
    /* Children of the containers being parsed, copied out when each closes. */
    struct vec items, members;
    char *error;
    size_t error_size;
    bool failed;
};

static void *arena_alloc(struct parser *p, size_t size) {
    size = (size + alignof(max_align_t) - 1) & ~(alignof(max_align_t) - 1);
    struct chunk *chunk = p->chunks;
    if (!chunk || chunk->size - chunk->used < size) {
        size_t capacity = MAX(size, (size_t)16384);
        chunk = xmalloc(sizeof *chunk + capacity);
        chunk->next = p->chunks;
        chunk->used = 0;
        chunk->size = capacity;
        p->chunks = chunk;
    }
    void *memory = chunk->data + chunk->used;
    chunk->used += size;
    return memory;
}

static bool fail(struct parser *p, const char *format, ...) {
    if (!p->failed) {
        va_list arguments;
        va_start(arguments, format);
        vsnprintf(p->error, p->error_size, format, arguments);
        va_end(arguments);
        p->failed = true;
    }
    return false;
}

static int peek(struct parser *p) {
    return p->position < p->length ? (unsigned char)p->text[p->position] : -1;
}

static void skip_space(struct parser *p) {
    while (p->position < p->length) {
        char c = p->text[p->position];
        if (c != ' ' && c != '\t' && c != '\n' && c != '\r') break;
        p->position++;
    }
}

static bool expect(struct parser *p, char c) {
    if (peek(p) != (unsigned char)c) return fail(p, "Unexpected JSON character.");
    p->position++;
    return true;
}

static int hex_digit(int c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

static bool hex4(struct parser *p, unsigned *out) {
    unsigned value = 0;
    for (int i = 0; i < 4; i++) {
        int digit = hex_digit(peek(p));
        if (digit < 0) return fail(p, "Invalid JSON Unicode escape.");
        value = value * 16 + (unsigned)digit;
        p->position++;
    }
    *out = value;
    return true;
}

static size_t put_utf8(char *out, unsigned code) {
    if (code < 0x80) {
        out[0] = (char)code;
        return 1;
    }
    if (code < 0x800) {
        out[0] = (char)(0xc0 | code >> 6);
        out[1] = (char)(0x80 | (code & 0x3f));
        return 2;
    }
    if (code < 0x10000) {
        out[0] = (char)(0xe0 | code >> 12);
        out[1] = (char)(0x80 | ((code >> 6) & 0x3f));
        out[2] = (char)(0x80 | (code & 0x3f));
        return 3;
    }
    out[0] = (char)(0xf0 | code >> 18);
    out[1] = (char)(0x80 | ((code >> 12) & 0x3f));
    out[2] = (char)(0x80 | ((code >> 6) & 0x3f));
    out[3] = (char)(0x80 | (code & 0x3f));
    return 4;
}

/* Length of the valid UTF-8 sequence starting at S, or 0. */
static size_t utf8_sequence(const unsigned char *s, size_t available) {
    unsigned char c = s[0];
    size_t length;
    unsigned code;
    if (c < 0x80) return 1;
    if ((c & 0xe0) == 0xc0) length = 2, code = c & 0x1f;
    else if ((c & 0xf0) == 0xe0) length = 3, code = c & 0x0f;
    else if ((c & 0xf8) == 0xf0) length = 4, code = c & 0x07;
    else return 0;
    if (available < length) return 0;
    for (size_t i = 1; i < length; i++) {
        if ((s[i] & 0xc0) != 0x80) return 0;
        code = code << 6 | (s[i] & 0x3f);
    }
    static const unsigned least[5] = {0, 0, 0x80, 0x800, 0x10000};
    if (code < least[length] || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return 0;
    return length;
}

static bool parse_string(struct parser *p, struct json_value *out) {
    if (!expect(p, '"')) return false;
    /* Escapes only shrink, so the raw span bounds the decoded length. */
    size_t start = p->position, end = start;
    while (end < p->length && p->text[end] != '"') {
        if (p->text[end] == '\\') end++;
        end++;
    }
    if (end >= p->length) return fail(p, "Incomplete JSON value.");
    if (end - start > MAX_STRING_BYTES) return fail(p, "JSON string is too long.");
    char *chars = arena_alloc(p, end - start + 1);
    size_t length = 0;
    while (true) {
        int c = peek(p);
        if (c < 0) return fail(p, "Incomplete JSON value.");
        if (c == '"') {
            p->position++;
            break;
        }
        if (c < 32) return fail(p, "Unescaped JSON control character.");
        if (c != '\\') {
            size_t sequence = utf8_sequence((const unsigned char *)p->text + p->position,
                                            p->length - p->position);
            if (!sequence) return fail(p, "Invalid UTF-8 in a JSON string.");
            memcpy(chars + length, p->text + p->position, sequence);
            length += sequence;
            p->position += sequence;
            continue;
        }
        p->position++;
        int escape = peek(p);
        p->position++;
        switch (escape) {
        case '"': chars[length++] = '"'; break;
        case '\\': chars[length++] = '\\'; break;
        case '/': chars[length++] = '/'; break;
        case 'b': chars[length++] = '\b'; break;
        case 'f': chars[length++] = '\f'; break;
        case 'n': chars[length++] = '\n'; break;
        case 'r': chars[length++] = '\r'; break;
        case 't': chars[length++] = '\t'; break;
        case 'u': {
            unsigned code;
            if (!hex4(p, &code)) return false;
            if (code >= 0xd800 && code <= 0xdbff) {
                unsigned low;
                if (!expect(p, '\\') || !expect(p, 'u') || !hex4(p, &low)) return false;
                if (low < 0xdc00 || low > 0xdfff) return fail(p, "Invalid Unicode surrogate pair.");
                code = 0x10000 + (code - 0xd800) * 1024 + (low - 0xdc00);
            } else if (code >= 0xdc00 && code <= 0xdfff) {
                return fail(p, "Unexpected low Unicode surrogate.");
            }
            length += put_utf8(chars + length, code);
            break;
        }
        default: return fail(p, "Unknown JSON escape.");
        }
    }
    chars[length] = '\0';
    out->type = JSON_STRING;
    out->string.chars = chars;
    out->string.length = length;
    return true;
}

static bool digits(struct parser *p) {
    size_t start = p->position;
    while (peek(p) >= '0' && peek(p) <= '9') p->position++;
    if (p->position == start) return fail(p, "Expected JSON number digits.");
    if (p->position - start > 32) return fail(p, "JSON number is too long.");
    return true;
}

static bool parse_number(struct parser *p, struct json_value *out) {
    size_t start = p->position;
    bool floating = false;
    if (peek(p) == '-') p->position++;
    if (peek(p) == '0') p->position++;
    else if (!digits(p)) return false;
    if (peek(p) == '.') {
        p->position++;
        floating = true;
        if (!digits(p)) return false;
    }
    if (peek(p) == 'e' || peek(p) == 'E') {
        p->position++;
        floating = true;
        if (peek(p) == '+' || peek(p) == '-') p->position++;
        size_t exponent = p->position;
        if (!digits(p)) return false;
        if (atoi(p->text + exponent) > 308 || p->position - exponent > 3)
            return fail(p, "JSON exponent is out of range.");
    }
    char buffer[128];
    size_t length = p->position - start;
    if (length >= sizeof buffer) return fail(p, "JSON number is too long.");
    memcpy(buffer, p->text + start, length);
    buffer[length] = '\0';
    double value = strtod(buffer, NULL);
    if (!(fabs(value) <= 9007199254740992.0)) return fail(p, "JSON number is out of range.");
    out->type = JSON_NUMBER;
    out->integer = !floating;
    out->number = value;
    return true;
}

static bool parse_value(struct parser *p, struct json_value *out, int depth);

static bool literal(struct parser *p, const char *word) {
    size_t length = strlen(word);
    if (p->length - p->position < length || memcmp(p->text + p->position, word, length))
        return fail(p, "Invalid JSON value.");
    p->position += length;
    return true;
}

static bool parse_array(struct parser *p, struct json_value *out, int depth) {
    p->position++;
    skip_space(p);
    size_t mark = p->items.length;
    out->type = JSON_ARRAY;
    out->array.items = NULL;
    out->array.count = 0;
    if (peek(p) == ']') {
        p->position++;
        return true;
    }
    while (true) {
        struct json_value item = {0};
        if (!parse_value(p, &item, depth + 1)) return false;
        *(struct json_value *)vec_push(&p->items) = item;
        skip_space(p);
        int c = peek(p);
        p->position++;
        if (c == ']') break;
        if (c != ',') return fail(p, "Invalid JSON array separator.");
        skip_space(p);
    }
    size_t count = p->items.length - mark;
    out->array.items = arena_alloc(p, count * sizeof(struct json_value));
    memcpy(out->array.items, vec_at(&p->items, mark), count * sizeof(struct json_value));
    out->array.count = count;
    p->items.length = mark;
    return true;
}

static bool parse_object(struct parser *p, struct json_value *out, int depth) {
    p->position++;
    skip_space(p);
    size_t mark = p->members.length;
    out->type = JSON_OBJECT;
    out->object.members = NULL;
    out->object.count = 0;
    if (peek(p) == '}') {
        p->position++;
        return true;
    }
    while (true) {
        struct json_member member = {0};
        if (!parse_string(p, &member.key)) return false;
        for (size_t i = mark; i < p->members.length; i++) {
            struct json_member *other = vec_at(&p->members, i);
            if (other->key.string.length == member.key.string.length &&
                !memcmp(other->key.string.chars, member.key.string.chars, member.key.string.length))
                return fail(p, "Duplicate JSON object key.");
        }
        skip_space(p);
        if (!expect(p, ':')) return false;
        skip_space(p);
        if (!parse_value(p, &member.value, depth + 1)) return false;
        *(struct json_member *)vec_push(&p->members) = member;
        skip_space(p);
        int c = peek(p);
        p->position++;
        if (c == '}') break;
        if (c != ',') return fail(p, "Invalid JSON object separator.");
        skip_space(p);
    }
    size_t count = p->members.length - mark;
    out->object.members = arena_alloc(p, count * sizeof(struct json_member));
    memcpy(out->object.members, vec_at(&p->members, mark), count * sizeof(struct json_member));
    out->object.count = count;
    p->members.length = mark;
    return true;
}

static bool parse_value(struct parser *p, struct json_value *out, int depth) {
    if (depth > MAX_DEPTH || ++p->values > MAX_VALUES)
        return fail(p, "JSON structure exceeds its bounds.");
    skip_space(p);
    int c = peek(p);
    switch (c) {
    case '"': return parse_string(p, out);
    case '{': return parse_object(p, out, depth);
    case '[': return parse_array(p, out, depth);
    case 't': out->type = JSON_TRUE; return literal(p, "true");
    case 'f': out->type = JSON_FALSE; return literal(p, "false");
    case 'n': out->type = JSON_NULL; return literal(p, "null");
    default:
        if (c == '-' || (c >= '0' && c <= '9')) return parse_number(p, out);
        return fail(p, c < 0 ? "Incomplete JSON value." : "Invalid JSON value.");
    }
}

static void free_chunks(struct chunk *chunk) {
    while (chunk) {
        struct chunk *next = chunk->next;
        free(chunk);
        chunk = next;
    }
}

bool json_parse(const char *text, size_t length, struct json_document *document, char *error,
                size_t error_size) {
    struct parser p = {
        .text = text,
        .length = length,
        .error = error,
        .error_size = error_size,
    };
    vec_init(&p.items, sizeof(struct json_value));
    vec_init(&p.members, sizeof(struct json_member));
    struct json_value *root = arena_alloc(&p, sizeof *root);
    *root = (struct json_value){0};
    bool ok = parse_value(&p, root, 0);
    if (ok) {
        skip_space(&p);
        if (p.position != p.length) ok = fail(&p, "Unexpected data after JSON value.");
    }
    vec_finish(&p.items);
    vec_finish(&p.members);
    if (!ok) {
        free_chunks(p.chunks);
        *document = (struct json_document){0};
        return false;
    }
    document->root = root;
    document->arena = p.chunks;
    return true;
}

void json_document_finish(struct json_document *document) {
    free_chunks(document->arena);
    *document = (struct json_document){0};
}

const struct json_value *json_get(const struct json_value *object, const char *key) {
    if (!object || object->type != JSON_OBJECT) return NULL;
    size_t length = strlen(key);
    for (size_t i = 0; i < object->object.count; i++) {
        const struct json_member *member = &object->object.members[i];
        if (member->key.string.length == length && !memcmp(member->key.string.chars, key, length))
            return &member->value;
    }
    return NULL;
}

const struct json_value *json_given(const struct json_value *object, const char *key) {
    const struct json_value *value = json_get(object, key);
    return value && value->type != JSON_NULL ? value : NULL;
}

bool json_is_string(const struct json_value *value, const char *text) {
    return value && value->type == JSON_STRING && value->string.length == strlen(text) &&
           !memcmp(value->string.chars, text, value->string.length);
}

bool json_integer(const struct json_value *value, int64_t minimum, int64_t maximum, int64_t *out) {
    if (!value || value->type != JSON_NUMBER || !value->integer) return false;
    if (value->number < (double)minimum || value->number > (double)maximum) return false;
    *out = (int64_t)value->number;
    return true;
}

void json_writer_init(struct json_writer *writer, struct strbuf *out) {
    *writer = (struct json_writer){.out = out};
    writer->first[0] = true;
}

static void separate(struct json_writer *writer) {
    if (!writer->first[writer->depth]) strbuf_putc(writer->out, ',');
    writer->first[writer->depth] = false;
}

static void before_value(struct json_writer *writer) {
    if (writer->pending_key) {
        writer->pending_key = false;
        return;
    }
    if (writer->depth > 0) separate(writer);
}

void json_object_begin(struct json_writer *writer) {
    before_value(writer);
    strbuf_putc(writer->out, '{');
    writer->first[++writer->depth] = true;
}

void json_object_end(struct json_writer *writer) {
    writer->depth--;
    strbuf_putc(writer->out, '}');
}

void json_array_begin(struct json_writer *writer) {
    before_value(writer);
    strbuf_putc(writer->out, '[');
    writer->first[++writer->depth] = true;
}

void json_array_end(struct json_writer *writer) {
    writer->depth--;
    strbuf_putc(writer->out, ']');
}

static void write_string(struct strbuf *out, const char *text, size_t length) {
    strbuf_putc(out, '"');
    size_t run = 0;
    for (size_t i = 0; i < length; i++) {
        unsigned char c = (unsigned char)text[i];
        const char *escape = NULL;
        char unicode[8];
        if (c == '"') escape = "\\\"";
        else if (c == '\\') escape = "\\\\";
        else if (c < 32) {
            snprintf(unicode, sizeof unicode, "\\u%04X", c);
            escape = unicode;
        } else if (c == 0xe2 && i + 2 < length && (unsigned char)text[i + 1] == 0x80 &&
                   ((unsigned char)text[i + 2] == 0xa8 || (unsigned char)text[i + 2] == 0xa9)) {
            /* Line and paragraph separators, so the line is also a JavaScript literal. */
            escape = (unsigned char)text[i + 2] == 0xa8 ? "\\u2028" : "\\u2029";
        }
        if (!escape) {
            run++;
            continue;
        }
        strbuf_append(out, text + i - run, run);
        run = 0;
        strbuf_puts(out, escape);
        if (c == 0xe2) i += 2;
    }
    strbuf_append(out, text + length - run, run);
    strbuf_putc(out, '"');
}

void json_key(struct json_writer *writer, const char *key) {
    separate(writer);
    write_string(writer->out, key, strlen(key));
    strbuf_putc(writer->out, ':');
    writer->pending_key = true;
}

void json_string(struct json_writer *writer, const char *text) {
    json_string_n(writer, text, strlen(text));
}

void json_string_n(struct json_writer *writer, const char *text, size_t length) {
    before_value(writer);
    write_string(writer->out, text, length);
}

void json_number(struct json_writer *writer, double value) {
    before_value(writer);
    if (!isfinite(value)) value = 0;
    if (value == trunc(value) && fabs(value) < 9007199254740992.0)
        strbuf_printf(writer->out, "%.0f", value);
    else strbuf_printf(writer->out, "%.6f", value);
}

void json_int(struct json_writer *writer, int64_t value) {
    before_value(writer);
    strbuf_printf(writer->out, "%lld", (long long)value);
}

void json_bool(struct json_writer *writer, bool value) {
    before_value(writer);
    strbuf_puts(writer->out, value ? "true" : "false");
}

void json_null(struct json_writer *writer) {
    before_value(writer);
    strbuf_puts(writer->out, "null");
}

void json_raw(struct json_writer *writer, const char *text, size_t length) {
    before_value(writer);
    strbuf_append(writer->out, text, length);
}
