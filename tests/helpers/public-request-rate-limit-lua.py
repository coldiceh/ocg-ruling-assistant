#!/usr/bin/env python3
"""Execute production limiter Lua with a small deterministic Redis command adapter.

The limiter algorithm is supplied by the JS module, never reimplemented here.
Commands are serialized as Redis EVAL transactions; the test controls Redis TIME.
"""
import json
import sys

from lupa.lua51 import LuaRuntime


class Store:
    def __init__(self):
        self.values = {}
        self.expiries = {}
        self.now = 1_800_000_000_000

    def expire(self):
        for key, deadline in list(self.expiries.items()):
            if deadline <= self.now:
                self.values.pop(key, None)
                self.expiries.pop(key, None)

    def selected(self, key, lower, upper):
        def bound(value, score, lower_bound):
            text = str(value)
            exclusive = text.startswith("(")
            number = float(text[1:] if exclusive else text)
            if lower_bound:
                return score > number if exclusive else score >= number
            return score < number if exclusive else score <= number

        return sorted(
            ((member, score) for member, score in self.values.get(key, {}).items()
             if bound(lower, score, True) and bound(upper, score, False)),
            key=lambda item: (item[1], item[0]),
        )

    def call(self, command, *args):
        command = str(command).upper()
        key = str(args[0]) if args else ""
        if command == "TIME":
            return [str(self.now // 1000), str((self.now % 1000) * 1000)]
        if command == "ZREMRANGEBYSCORE":
            removed = self.selected(key, args[1], args[2])
            for member, _ in removed:
                self.values[key].pop(member)
            return len(removed)
        if command == "ZCOUNT":
            return len(self.selected(key, args[1], args[2]))
        if command == "ZRANGEBYSCORE":
            assert tuple(str(value).upper() for value in args[3:5]) == ("WITHSCORES", "LIMIT")
            selected = self.selected(key, args[1], args[2])
            selected = selected[int(args[5]):int(args[5]) + int(args[6])]
            return [value for member, score in selected for value in (member, str(int(score)))]
        if command == "ZADD":
            target = self.values.setdefault(key, {})
            added = int(str(args[2]) not in target)
            target[str(args[2])] = float(args[1])
            return added
        if command == "PEXPIRE":
            self.expiries[key] = self.now + int(args[1])
            return 1
        if command == "PTTL":
            return self.expiries[key] - self.now if key in self.expiries else -2
        raise RuntimeError(f"unsupported Redis command: {command}")


def evaluate(store, args):
    lua = LuaRuntime(unpack_returned_tuples=True)

    def redis_call(command, *values):
        result = store.call(command, *values)
        return lua.table_from(result) if isinstance(result, list) else result

    lua.globals()["redis"] = lua.table(call=redis_call)
    count = int(args[2])
    lua.globals()["KEYS"] = lua.table_from(args[3:3 + count])
    lua.globals()["ARGV"] = lua.table_from(args[3 + count:])
    result = lua.execute("return function()\n" + args[1] + "\nend")()
    return [result[index] for index in range(1, len(result) + 1)]


store = Store()
for line in sys.stdin:
    try:
        request = json.loads(line)
        store.now = int(request.get("atMs", store.now))
        store.expire()
        args = request["args"]
        result = evaluate(store, args) if args[0] == "EVAL" else store.call(*args)
        print(json.dumps({"result": result}), flush=True)
    except Exception as error:
        print(json.dumps({"error": f"{type(error).__name__}: {error}"}), flush=True)
