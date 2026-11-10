#!/usr/bin/env python3
"""Warlock's notification service: org.freedesktop.Notifications on the session bus.

The shell runs this for as long as it shows notifications and talks to it in
JSON lines. The service keeps the notifications (at most 32, live and past),
ends the live ones when their time is up, and tells producers what the user did.

Out (stdout), each a whole picture of the service, newest notification first:
  {"event": "state", "available": bool, "reason": str, "entries": [...]}
      whenever anything changes
  {"event": "read", "request": n, ...}
      the answer to a read
  {"event": "outcome", "request": n, "status": "Dispatched" | "Refused" | "Unknown", ...}
      the answer to a dismiss or an invoke
An entry is {"id", "incarnation", "app", "summary", "body", "urgency", "state",
"actions": [{"key", "label"}]}; only a live entry has actions.

In (stdin):
  {"command": "read", "request": n}
  {"command": "dismiss", "request": n, "id": n, "incarnation": n}
  {"command": "invoke", "request": n, "id": n, "incarnation": n, "key": str}

The service ends when its input closes.
"""
import json
import math
import os
import sys
import time

import gi

gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib  # noqa: E402

NAME = "org.freedesktop.Notifications"
PATH = "/org/freedesktop/Notifications"
INTERFACE = """<node><interface name="org.freedesktop.Notifications">
<method name="GetCapabilities"><arg type="as" direction="out"/></method>
<method name="GetServerInformation">
  <arg type="s" direction="out"/><arg type="s" direction="out"/>
  <arg type="s" direction="out"/><arg type="s" direction="out"/>
</method>
<method name="Notify">
  <arg type="s" direction="in"/><arg type="u" direction="in"/><arg type="s" direction="in"/>
  <arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="as" direction="in"/>
  <arg type="a{sv}" direction="in"/><arg type="i" direction="in"/><arg type="u" direction="out"/>
</method>
<method name="CloseNotification"><arg type="u" direction="in"/></method>
<signal name="ActionInvoked"><arg type="u"/><arg type="s"/></signal>
<signal name="NotificationClosed"><arg type="u"/><arg type="u"/></signal>
</interface></node>"""
BUS = ("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus")

#: Notifications kept, live and past together.
CAPACITY = 32
#: How long a notification that leaves it to the server stays live, in milliseconds.
DEFAULT_EXPIRY = 5000
#: RequestName: fail rather than wait in line behind another owner.
DO_NOT_QUEUE = 4
PRIMARY_OWNER = 1
#: Why a notification closed, as NotificationClosed says it.
EXPIRED, DISMISSED, CLOSED = 1, 2, 3

OTHER_SERVICE = "Another notification service is running. Warlock cannot read its private notifications."


class Invalid(Exception):
    """A request the service refuses; the caller gets Error.Invalid with this text."""


def checked(value, maximum, empty=True):
    """VALUE if it is text of at most MAXIMUM bytes without control characters."""
    if (
        not isinstance(value, str)
        or len(value.encode("utf-8")) > maximum
        or (not empty and not value)
        or any(ord(character) < 32 and character not in "\n\t" for character in value)
    ):
        raise Invalid("Notification text")
    return value


class Service:
    def __init__(self):
        self.loop = GLib.MainLoop()
        self.connection = None
        self.available = False
        self.reason = "Notification service unavailable."
        #: Whether the name was ever ours: a service that lost the bus does not come back.
        self.owned = False
        #: Oldest first.
        self.rows = []
        self.next_id = 0
        self.incarnations = 0
        self.timer = None
        self.changed = False
        self.pending_input = b""

    # -- Talking to the shell

    def picture(self):
        return {
            "available": self.available,
            "reason": self.reason,
            "entries": [
                {key: row[key] for key in ("id", "incarnation", "app", "summary", "body", "urgency", "state", "actions")}
                for row in reversed(self.rows)
            ],
        }

    def say(self, event, **fields):
        self.changed = False
        try:
            sys.stdout.write(json.dumps({"event": event, **fields, **self.picture()}) + "\n")
            sys.stdout.flush()
        except OSError:
            self.loop.quit()

    def publish(self):
        """Tell the shell, if anything changed since it was last told."""
        if self.changed:
            self.say("state")

    def on_input(self, descriptor, _condition):
        try:
            data = os.read(descriptor, 65536)
        except OSError:
            data = b""
        if not data:
            self.loop.quit()
            return False
        *lines, self.pending_input = (self.pending_input + data).split(b"\n")
        for line in lines:
            try:
                command = json.loads(line)
                if isinstance(command, dict):
                    self.obey(command)
            except ValueError:
                pass
        return True

    def obey(self, command):
        self.expire()
        verb, request = command.get("command"), command.get("request")
        if verb == "read":
            # Only a service that never had the name, and so holds nothing, tries for it again.
            if not self.available and not self.owned and not self.rows:
                self.start()
            self.say("read", request=request)
        elif verb in ("dismiss", "invoke"):
            status = self.act(verb, command.get("id"), command.get("incarnation"), command.get("key"))
            self.say("outcome", request=request, status=status)

    def act(self, verb, identifier, incarnation, key):
        """Dismiss a live notification or invoke one of its actions, at most once."""
        row = next((row for row in self.rows if row["id"] == identifier and row["incarnation"] == incarnation), None)
        live = self.available and row is not None and row["state"] == "live"
        if not live or (verb == "invoke" and not any(action["key"] == key for action in row["actions"])):
            return "Refused"
        try:
            (present,) = self.connection.call_sync(
                *BUS, "NameHasOwner", GLib.Variant("(s)", (row["producer"],)), GLib.VariantType.new("(b)"),
                Gio.DBusCallFlags.NONE, 1000, None,
            ).unpack()
            if not present:
                self.end(row, "disconnected")
                return "Refused"
            if verb == "dismiss":
                self.end(row, "dismissed", DISMISSED)
                return "Dispatched"
            # Spent before the producer hears of it, so nothing can send it twice.
            self.end(row, "invoked")
            self.emit(row, "ActionInvoked", "(us)", (row["id"], key))
            return "Dispatched"
        except GLib.Error:
            if row["state"] == "live":
                return "Refused"
            row["state"] = "unknown"
            return "Unknown"

    # -- Notifications

    def emit(self, row, signal, signature, values):
        """Signal the notification's producer alone, never the whole bus."""
        self.connection.emit_signal(row["producer"], PATH, NAME, signal, GLib.Variant(signature, values))

    def end(self, row, state, closed=None):
        """Move ROW to history as STATE, telling its producer why it CLOSED if it is told at all."""
        row["state"], row["actions"], row["deadline"] = state, [], None
        self.changed = True
        self.schedule()
        if closed is not None:
            try:
                self.emit(row, "NotificationClosed", "(uu)", (row["id"], closed))
            except GLib.Error:
                pass

    def expire(self):
        now = time.monotonic()
        for row in self.rows:
            if row["state"] == "live" and row["deadline"] is not None and now >= row["deadline"]:
                self.end(row, "expired", EXPIRED)

    def schedule(self):
        """Wake when the next live notification's time is up."""
        if self.timer is not None:
            GLib.source_remove(self.timer)
            self.timer = None
        deadlines = [row["deadline"] for row in self.rows if row["state"] == "live" and row["deadline"] is not None]
        if deadlines:
            wait = max(1, math.ceil((min(deadlines) - time.monotonic()) * 1000))
            self.timer = GLib.timeout_add(wait, self.on_timer)

    def on_timer(self):
        self.timer = None
        self.expire()
        self.schedule()
        self.publish()
        return False

    def notify(self, sender, app, replaces, icon, summary, body, actions, urgency, timeout):
        self.expire()
        checked(app, 128)
        checked(summary, 256)
        checked(body, 1024)
        checked(icon, 1024)
        if len(actions) > 16 or len(actions) % 2 or timeout < -1:
            raise Invalid("Notification bounds")
        pairs = []
        for key, label in zip(actions[::2], actions[1::2]):
            checked(key, 64, empty=False)
            checked(label, 128, empty=False)
            if any(pair["key"] == key for pair in pairs):
                raise Invalid("Duplicate notification action")
            pairs.append({"key": key, "label": label})
        previous = next((row for row in self.rows if row["id"] == replaces), None) if replaces else None
        if previous is not None and previous["producer"] != sender:
            raise Invalid("Foreign notification replacement")
        if not self.available:
            raise Invalid("Notification service unavailable")
        if previous is not None:
            identifier = replaces
            self.rows.remove(previous)
        else:
            if len(self.rows) >= CAPACITY:
                retired = next((row for row in self.rows if row["state"] != "live"), None)
                if retired is None:
                    raise Invalid("Notification capacity")
                self.rows.remove(retired)
            if self.next_id >= 2**32 - 1:
                raise Invalid("Notification ID exhausted")
            self.next_id += 1
            identifier = self.next_id
        self.incarnations += 1
        duration = DEFAULT_EXPIRY if timeout == -1 else timeout
        self.rows.append({
            "id": identifier,
            # Tells a replacement from what it replaced, which had the same id.
            "incarnation": self.incarnations,
            "producer": sender,
            "app": app or "Application",
            "summary": summary,
            "body": body,
            "urgency": urgency,
            "state": "live",
            "actions": pairs,
            # A critical notification stays until someone ends it.
            "deadline": None if urgency == 2 or duration == 0 else time.monotonic() + duration / 1000,
        })
        self.changed = True
        self.schedule()
        return identifier

    def close(self, sender, identifier):
        self.expire()
        row = next(
            (row for row in self.rows if row["id"] == identifier and row["state"] == "live" and row["producer"] == sender),
            None,
        )
        if row is None:
            raise Invalid("Notification no longer exists or producer mismatch")
        self.end(row, "closed", CLOSED)

    # -- The bus

    def on_call(self, _connection, sender, _path, _interface, method, parameters, invocation):
        try:
            if method == "GetCapabilities":
                result = GLib.Variant("(as)", (["actions", "body"],))
            elif method == "GetServerInformation":
                result = GLib.Variant("(ssss)", ("Warlock", "Warlock contributors", "1", "1.3"))
            elif method == "Notify":
                app, replaces, icon, summary, body, actions, _hints, timeout = parameters.unpack()
                # Only the standard byte hint raises or lowers urgency.
                hint = parameters.get_child_value(6).lookup_value("urgency", GLib.VariantType.new("y"))
                urgency = hint.get_byte() if hint is not None and hint.get_byte() in (0, 1, 2) else 1
                result = GLib.Variant("(u)", (self.notify(sender, app, replaces, icon, summary, body, actions, urgency, timeout),))
            elif method == "CloseNotification":
                self.close(sender, parameters.unpack()[0])
                result = GLib.Variant("()", ())
            else:
                raise Invalid("Notification method")
            invocation.return_value(result)
        except Invalid as refusal:
            invocation.return_dbus_error("org.freedesktop.Notifications.Error.Invalid", str(refusal))
        except Exception:  # A caller is always answered.
            invocation.return_dbus_error("org.freedesktop.Notifications.Error.Invalid", "Notification request unavailable")
        self.publish()

    def on_owner(self, _connection, _sender, _path, _interface, _signal, parameters):
        name, old, new = parameters.unpack()
        if name == NAME and not new and not self.available and not self.owned:
            # The other notification service left: the name is free to ask for.
            self.claim()
        elif name.startswith(":") and old and not new:
            # A producer that left the bus can no longer hear about its notifications.
            for row in self.rows:
                if row["producer"] == name and row["state"] == "live":
                    self.end(row, "disconnected")
        self.publish()

    def on_closed(self, *_):
        self.available = False
        self.reason = "Notification bus disconnected. No action will be repeated."
        for row in self.rows:
            if row["state"] == "live":
                self.end(row, "disconnected")
        self.changed = True
        self.publish()

    def claim(self):
        """Ask for the name, without taking it from a service that has it."""
        try:
            (reply,) = self.connection.call_sync(
                *BUS, "RequestName", GLib.Variant("(su)", (NAME, DO_NOT_QUEUE)), GLib.VariantType.new("(u)"),
                Gio.DBusCallFlags.NONE, 2000, None,
            ).unpack()
        except GLib.Error:
            self.reason = "Notification bus unavailable."
        else:
            self.available = self.owned = reply == PRIMARY_OWNER
            self.reason = "" if self.available else OTHER_SERVICE
        self.changed = True

    def start(self):
        try:
            if self.connection is None:
                connection = Gio.bus_get_sync(Gio.BusType.SESSION, None)
                connection.set_exit_on_close(False)
                connection.connect("closed", self.on_closed)
                # Newer GLib renamed the call that takes plain functions.
                register = getattr(connection, "register_object_with_closures2", connection.register_object)
                register(PATH, Gio.DBusNodeInfo.new_for_xml(INTERFACE).interfaces[0], self.on_call, None, None)
                connection.signal_subscribe(
                    BUS[0], BUS[2], "NameOwnerChanged", BUS[1], None, Gio.DBusSignalFlags.NONE, self.on_owner
                )
                self.connection = connection
            self.claim()
        except GLib.Error:
            self.reason = "Notification bus unavailable."
            self.changed = True

    def run(self):
        GLib.io_add_watch(0, GLib.PRIORITY_DEFAULT, GLib.IOCondition.IN | GLib.IOCondition.HUP, self.on_input)
        self.start()
        self.say("state")
        self.loop.run()


if __name__ == "__main__":
    Service().run()
