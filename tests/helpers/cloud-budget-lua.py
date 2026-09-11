#!/usr/bin/env python3
"""Tiny persistent Redis/Lua adapter for the opt-in budget regression tests.

The test process sends Redis command arrays over stdin. EVAL is executed by
Lupa against the production Lua source; this file deliberately contains no
copy of the budget algorithm.
"""
import json
import sys

from lupa.lua51 import LuaRuntime


def py_to_lua(value, lua):
    if isinstance(value, dict):
        table = lua.table()
        for key, item in value.items():
            table[key] = py_to_lua(item, lua)
        return table
    if isinstance(value, list):
        table = lua.table()
        for index, item in enumerate(value, 1):
            table[index] = py_to_lua(item, lua)
        return table
    return value


def lua_to_py(value):
    if hasattr(value, "items"):
        items = list(value.items())
        integer_keys = [key for key, _ in items if isinstance(key, (int, float)) and int(key) == key]
        if len(integer_keys) == len(items) and sorted(int(key) for key in integer_keys) == list(range(1, len(items) + 1)):
            return [lua_to_py(value[index]) for index in range(1, len(items) + 1)]
        return {str(key): lua_to_py(item) for key, item in items}
    return value


class Store:
    def __init__(self):
        self.hashes = {}
        self.values = {}

    def hash(self, key):
        return self.hashes.setdefault(str(key), {})

    def call(self, command, *args):
        command = str(command).upper()
        key = str(args[0]) if args else ""
        if command == "HGETALL":
            result = []
            for field, value in self.hashes.get(key, {}).items():
                result.extend([field, value])
            return result
        if command == "HGET":
            return self.hashes.get(key, {}).get(str(args[1]))
        if command == "HEXISTS":
            return 1 if str(args[1]) in self.hashes.get(key, {}) else 0
        if command == "HSET":
            target = self.hash(key)
            values = list(args[1:])
            for index in range(0, len(values), 2):
                target[str(values[index])] = str(values[index + 1])
            return 1
        if command == "HDEL":
            target = self.hashes.get(key, {})
            removed = 0
            for field in args[1:]:
                removed += int(target.pop(str(field), None) is not None)
            return removed
        if command == "GET":
            return self.values.get(key)
        if command == "SET":
            self.values[key] = str(args[1])
            return "OK"
        if command == "DEL":
            return int(self.hashes.pop(key, None) is not None or self.values.pop(key, None) is not None)
        raise RuntimeError(f"unsupported Redis command: {command}")


def run_eval(store, script, keys, argv):
    lua = LuaRuntime(unpack_returned_tuples=True)

    def redis_call(command, *args):
        return py_to_lua(store.call(command, *args), lua)

    redis = lua.table(call=redis_call)
    lua.globals()["redis"] = redis

    def cjson_decode(raw):
        return py_to_lua(json.loads(str(raw)), lua)

    def cjson_encode(value):
        return json.dumps(lua_to_py(value), separators=(",", ":"), ensure_ascii=False)

    lua.globals()["cjson"] = lua.table(decode=cjson_decode, encode=cjson_encode)
    lua.globals()["KEYS"] = py_to_lua(keys, lua)
    lua.globals()["ARGV"] = py_to_lua(argv, lua)
    fn = lua.execute(f"return function()\n{script}\nend")
    result = fn()
    return lua_to_py(result)


def main():
    store = Store()
    for line in sys.stdin:
        try:
            request = json.loads(line)
            args = request["args"]
            if args and str(args[0]).upper() == "EVAL":
                script, count = args[1], int(args[2])
                result = run_eval(store, script, args[3:3 + count], args[3 + count:])
            else:
                result = store.call(*args)
            print(json.dumps({"result": result}, ensure_ascii=False), flush=True)
        except Exception as error:
            print(json.dumps({"error": f"{type(error).__name__}: {error}"}), flush=True)


if __name__ == "__main__":
    main()
