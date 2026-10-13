/*
 * The director link: newline-delimited JSON over a local stream socket.
 *
 * The listener and the director connection are event-loop sources. Reads and
 * writes never block, and both directions are bounded. A newer connection
 * replaces the current director, so a restarted runtime takes over the live
 * scene: its first commit replaces the old scene in place, and windows animate
 * from where they are. docs/PROTOCOL.md specifies every message.
 */
#pragma once

#include <stdbool.h>

#include "json.h"
#include "props.h"
#include "util.h"

struct server;
struct node;

#define PROTOCOL_VERSION 3

/* Listen on PATH, replacing a stale socket file; NULL when another compositor listens. */
struct link *link_create(struct server *server, const char *path);
void link_destroy(struct link *link);
const char *link_path(struct link *link);

/* A message for the director under construction: an object whose "type" is set. */
struct message {
    struct strbuf text;
    struct json_writer writer;
};

void message_begin(struct message *message, const char *type);
/*
 * Close and send the message to the director. Messages with the same COALESCE
 * key replace each other until the next flush, at most every 16 ms; any other
 * message flushes them first, keeping events in order.
 */
void message_send(struct server *server, struct message *message, const char *coalesce);

/* An event message under construction for a node. */
struct event {
    struct strbuf message;
    struct json_writer writer;
    /* Pointer motion, drags and resizes replace their pending predecessor. */
    bool coalesce;
    char key[64];
};

/*
 * Start an event for NODE; false, with nothing to finish, when neither NODE nor
 * (for bubbling events) an ancestor handles it or no director listens.
 */
bool event_begin(struct server *server, struct event *event, struct node *node,
                 enum event_name name);
/* Close and send the event; pointer motion, drags and resizes are coalesced per node. */
void event_end(struct server *server, struct event *event);
