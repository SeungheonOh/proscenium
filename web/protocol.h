/*
 * The private link between the compositor (src/web.c) and its web helper, built
 * from the same tree: commands over a SOCK_SEQPACKET socket, frames back over it
 * as dma-buf descriptors, and per-page shared memory for events, bitmaps and
 * counters. There is no network listener, and no browser code in the compositor.
 * Shared by C and C++.
 */
#pragma once

#include <errno.h>
#include <pthread.h>
#include <stdint.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

#define WEB_MAX_SIDE 4096
#define WEB_PIXELS ((size_t)WEB_MAX_SIDE * WEB_MAX_SIDE * 4)
#define WEB_TEXT 60000
#define WEB_EVENTS 32

struct web_event {
    char name[80];
    char value[8192];
};

/* One page's shared memory, written by the helper under MUTEX. */
struct web_shared {
    pthread_mutex_t mutex;
    int accelerated, popup_visible, popup_x, popup_y;
    /* The bitmap and the rectangle of it changed since the compositor last took it. */
    int width, height, x, y, right, bottom, dirty;
    unsigned event_read, event_write;
    struct web_event events[WEB_EVENTS];
    unsigned char pixels[];
};

#define WEB_MAP_SIZE (sizeof(struct web_shared) + WEB_PIXELS)

enum web_op {
    WEB_CREATE = 1,
    WEB_CLOSE,
    WEB_RESIZE,
    WEB_VISIBLE,
    WEB_FOCUS,
    WEB_MOVE,
    WEB_BUTTON,
    WEB_SCROLL,
    WEB_KEY,
    WEB_TEXT_INPUT,
    WEB_EVAL,
    WEB_STOP,
    WEB_MODIFIERS,
    WEB_RELEASE,
    /* Read the number the page marks its frames with (A: whether to). */
    WEB_TAGGED,
};

/* Only the used prefix of TEXT travels. */
struct web_command {
    int op, id, a, b, c, d;
    double scale;
    char text[WEB_TEXT];
};

/* Lock S, or with TRY_ONLY fail rather than wait; recovers from a holder that died. */
static inline int web_lock(struct web_shared *s, int try_only) {
    int e = try_only ? pthread_mutex_trylock(&s->mutex) : pthread_mutex_lock(&s->mutex);
    if (e == EOWNERDEAD) {
        pthread_mutex_consistent(&s->mutex);
        return 0;
    }
    return e;
}

static inline void web_signal(int fd) {
    uint64_t n = 1;
    (void)!write(fd, &n, sizeof n);
}

/* Send CMD with descriptor FD (or none when negative) without blocking; nonzero on success. */
static inline int web_send(int socket, const struct web_command *cmd, int fd) {
    struct iovec io = {(void *)cmd, sizeof(*cmd) - WEB_TEXT + strlen(cmd->text) + 1};
    char control[CMSG_SPACE(sizeof(int))] = {0};
    struct msghdr msg = {0};
    msg.msg_iov = &io;
    msg.msg_iovlen = 1;
    if (fd >= 0) {
        msg.msg_control = control;
        msg.msg_controllen = sizeof control;
        struct cmsghdr *c = CMSG_FIRSTHDR(&msg);
        c->cmsg_level = SOL_SOCKET;
        c->cmsg_type = SCM_RIGHTS;
        c->cmsg_len = CMSG_LEN(sizeof(int));
        memcpy(CMSG_DATA(c), &fd, sizeof fd);
    }
    return sendmsg(socket, &msg, MSG_NOSIGNAL | MSG_DONTWAIT) == (ssize_t)io.iov_len;
}
