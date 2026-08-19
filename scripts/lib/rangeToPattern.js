// Exact regExp pattern for an integer range [min, max]. Engine API v3 text
// controls have no min/max attributes — only `pattern` — so the room form
// gets its numeric bounds as a generated regex (build-game-manifest.js).
// The pattern is a UX hint; the authoritative clamp happens on the host.

// wraps a pattern in a non-capturing group when it contains an alternation:
// otherwise concatenation with a neighbouring prefix binds to the first
// branch only ('9' + 'a|b' matches '9a' or 'b', not '9a'/'9b')
function wrapAlternation(pattern) {
  return pattern.includes('|') ? `(?:${pattern})` : pattern;
}

function digitsPattern(len) {
  return len === 1 ? '[0-9]' : `[0-9]{${len}}`;
}

// lo/hi are equal-length digit strings, lo <= hi, no leading zeros: eats the
// common prefix, then splits into "tail of the lo digit", "full middle
// digits" and "tail of the hi digit"
function digitGroupPattern(lo, hi) {
  if (lo === hi) {
    return lo;
  }

  if (lo.length === 1) {
    return `[${lo}-${hi}]`;
  }

  if (lo[0] === hi[0]) {
    return lo[0] + wrapAlternation(digitGroupPattern(lo.slice(1), hi.slice(1)));
  }

  const restLen = lo.length - 1;
  const zeros = '0'.repeat(restLen);
  const nines = '9'.repeat(restLen);
  const parts = [
    lo[0] + wrapAlternation(digitGroupPattern(lo.slice(1), nines)),
  ];

  const midLo = Number(lo[0]) + 1;
  const midHi = Number(hi[0]) - 1;

  if (midLo <= midHi) {
    const midDigit = midLo === midHi ? String(midLo) : `[${midLo}-${midHi}]`;

    parts.push(`${midDigit}${digitsPattern(restLen)}`);
  }

  parts.push(hi[0] + wrapAlternation(digitGroupPattern(zeros, hi.slice(1))));

  return parts.join('|');
}

// Pattern for an integer in [min, max] (0 <= min <= max), unanchored and
// without an enclosing group: the caller uses it as the HTML `pattern`
// attribute (implicitly anchored by the browser).
export function rangeToPattern(min, max) {
  if (min > max) {
    throw new Error(`rangeToPattern: min ${min} > max ${max}`);
  }

  const groups = [];
  let lo = min;

  while (lo <= max) {
    const digits = String(lo).length;
    const hi = Math.min(max, 10 ** digits - 1);

    groups.push(digitGroupPattern(String(lo), String(hi)));
    lo = hi + 1;
  }

  return wrapAlternation(groups.join('|'));
}
