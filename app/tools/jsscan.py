#!/usr/bin/env python3
"""One helper shared by tools/vendor_age.py and tools/check_imports.py.

Both scripts scan JavaScript with a regex, and both must ignore comments. The
scanner lives here rather than twice, because a copy that drifts turns a
correct tree into a failing check for reasons nobody can see.
"""


import re

# Single-pass C regex scanner for JS string literals and comments. Each string
# branch is mutually exclusive (runs of non-quote/non-backslash chars vs. an
# escape pair) so the engine stays linear with no backtracking, and matching
# strings keeps `//` or `/*` inside literals from being blanked.
_TOKEN_RE = re.compile(
    r"""'(?:[^'\\]+|\\[\s\S]?)*(?:'|$)"""
    r"""|"(?:[^"\\]+|\\[\s\S]?)*(?:"|$)"""
    r"""|`(?:[^`\\]+|\\[\s\S]?)*(?:`|$)"""
    r"""|//[^\n]*"""
    r"""|/\*[\s\S]*?(?:\*/|$)"""
)
_NON_NEWLINE_RE = re.compile(r"[^\n]")


def _blank_comment(match):
    token = match.group(0)
    if token[0] != "/":
        return token
    if token[1] == "/":
        return " " * len(token)
    # Newlines stay, so ^-anchored patterns and line numbers still
    # line up with the original file.
    return _NON_NEWLINE_RE.sub(" ", token)


def mask_comments(text):
    """Blank out every comment, keeping the string exactly as long.

    Required, and not optional tidiness: the noble packages put runnable
    `@example` blocks in their JSDoc, and those examples hold real-looking
    import statements at column 0. `@noble/hashes/index.js` "imports" nine
    sibling modules that way, and `@noble/curves/index.js` "imports"
    `abstract/utils.js`, a file the package does not even publish. Counted as
    live imports they fail every check on a tree that is perfectly correct.

    Length is preserved, so a match offset from the masked text addresses the
    same character in the original text. That is what lets vendor_age.py find
    specifiers in the masked copy and rewrite them in the real file.

    Regular-expression literals are not tracked. A pattern containing `/*` or
    `//` would be masked as a comment. No file in the vendored tree has one,
    and the cost of being wrong is a missed check, never a broken build.
    """
    return _TOKEN_RE.sub(_blank_comment, text)
