#!/usr/bin/env bash
# mkzip.sh OUT.ZIP entry... — build a .zip/.mcpack without the `zip` tool.
#
# Fallback used by build-mcpack.sh on systems without `zip` (e.g. Termux).
# Entries are paths relative to the current directory and are written into the
# archive under exactly those names (manifest.json, pack_icon.png,
# scripts/main.js). All entries are method 0 (STORED) — no deflation; the engine
# only needs a conforming zip, and scripts/verify-pack.sh re-checks the bytes.
#
# CRC-32 is not computed here: the gzip trailer is the CRC-32 of gzip's
# *uncompressed input* (RFC 1952), so the last-but-one 4 bytes of a gzip stream
# are the stored entry's CRC, little-endian. Requires bash, mktemp, gzip, wc.
set -euo pipefail

out=$1
shift
[ "$#" -ge 1 ] || { echo "mkzip: no entries given" >&2; exit 1; }

for f in "$@"; do
    [ -f "$f" ] || { echo "mkzip: not a file: $f" >&2; exit 1; }
done

# One raw byte via a literal \xHH escape (bash builtin printf, no subprocess).
b() { printf "$(printf '\\x%02x' "$1")"; }
le16() { b $(( $1 & 255 )); b $(( ($1 >> 8) & 255 )); }
le32() { local i v=$1; for i in 0 1 2 3; do b $(( (v >> (i * 8)) & 255 )); done; }

# gzip trailer's CRC-32 of the entry's uncompressed bytes: bytes 4-8 from the end
# of a gzip stream (last 4 are ISIZE). little-endian, exactly what the zip wants.
crc_of() { gzip -cf "$1" | tail -c 8 | head -c 4; }

size_of() { wc -c < "$1"; }

# Fixed 2026-10-24 12:00 DOS timestamp; any valid date works for consumers.
DTIME=$(( (12 << 11) | (0 << 5) | 0 ))
DDATE=$(( ((2026 - 1980) << 9) | (10 << 5) | 24 ))

tmp=$(mktemp)
: > "$tmp"

names=("$@")
offsets=()
sizes=()
off=0

for f in "${names[@]}"; do
    s=$(size_of "$f")
    n=${#f} # archive names are ASCII, so chars == bytes
    offsets+=("$off")
    sizes+=("$s")
    {
        printf 'PK\x03\x04' # local file header
        le16 20             # version needed
        le16 0              # flags
        le16 0              # method 0 = STORED
        le16 "$DTIME"
        le16 "$DDATE"
        crc_of "$f"         # 4 bytes, little-endian, uncompressed-data CRC-32
        le32 "$s"           # compressed size (== size for STORED)
        le32 "$s"           # uncompressed size
        le16 "$n"           # file name length
        le16 0              # extra field length
        printf '%s' "$f"
        cat "$f"
    } >> "$tmp"
    off=$(( off + 30 + n + s ))
done

cdoff=$off
for i in "${!names[@]}"; do
    f=${names[$i]}
    s=${sizes[$i]}
    o=${offsets[$i]}
    n=${#f}
    {
        printf 'PK\x01\x02' # central directory header
        le16 20             # version made by
        le16 20             # version needed
        le16 0              # flags
        le16 0              # method
        le16 "$DTIME"
        le16 "$DDATE"
        crc_of "$f"
        le32 "$s"
        le32 "$s"
        le16 "$n"
        le16 0              # extra len
        le16 0              # comment len
        le16 0              # start disk
        le16 0              # internal attrs
        le32 0              # external attrs
        le32 "$o"           # local header offset
        printf '%s' "$f"
    } >> "$tmp"
    off=$(( off + 46 + n ))
done
cdsize=$(( off - cdoff ))

{
    printf 'PK\x05\x06' # end of central directory
    le16 0              # disk number
    le16 0              # disk of central dir
    le16 $#             # entries on this disk
    le16 $#             # entries total
    le32 "$cdsize"
    le32 "$cdoff"
    le16 0              # comment len
} >> "$tmp"

mv "$tmp" "$out"
echo "mkzip: wrote $out ($# entries, stored, $(wc -c < "$out") bytes)"
