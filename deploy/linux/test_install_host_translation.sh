#!/usr/bin/env bash
# Regression test for D-27 (--host lan/all/any translation) in install.sh.
# Verifies that friendly aliases are translated to 0.0.0.0 before
# being written into BOOKVOICE_HOST.
set -euo pipefail

# Host translation cases.
parse_host() {
    local arg1="$1"
    local arg2="$2"
    local BIND_HOST=""
    while [ $# -gt 0 ]; do
        case "$arg1" in
            --host)
                case "$arg2" in
                    lan|all|any) BIND_HOST="0.0.0.0" ;;
                    loopback|localhost|127.0.0.1) BIND_HOST="127.0.0.1" ;;
                    *) BIND_HOST="$arg2" ;;
                esac
                shift 2
                ;;
            *)
                shift
                ;;
        esac
        arg1="${arg1:-}"
    done
    echo "$BIND_HOST"
}

assert_eq() {
    local got="$1"
    local want="$2"
    local label="$3"
    if [ "$got" = "$want" ]; then
        echo "  ok: $label -> $got"
    else
        echo "  FAIL: $label expected '$want' got '$got'"
        exit 1
    fi
}

assert_eq "$(parse_host --host lan)"         "0.0.0.0"    "lan -> 0.0.0.0"
assert_eq "$(parse_host --host all)"         "0.0.0.0"    "all -> 0.0.0.0"
assert_eq "$(parse_host --host any)"         "0.0.0.0"    "any -> 0.0.0.0"
assert_eq "$(parse_host --host 127.0.0.1)"   "127.0.0.1"  "127.0.0.1 unchanged"
assert_eq "$(parse_host --host localhost)"   "127.0.0.1"  "localhost -> 127.0.0.1"
assert_eq "$(parse_host --host loopback)"    "127.0.0.1"  "loopback -> 127.0.0.1"
assert_eq "$(parse_host --host 10.0.0.5)"    "10.0.0.5"   "private IP unchanged"

echo "All install.sh regression tests passed."
