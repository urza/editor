#!/usr/bin/env python3
"""One helper shared by tools/vendor_age.py and tools/check_imports.py.

Both scripts scan JavaScript with a regex, and both must ignore comments. The
scanner lives here rather than twice, because a copy that drifts turns a
correct tree into a failing check for reasons nobody can see.
"""


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
    chars = list(text)
    i, n = 0, len(text)
    quote = None
    while i < n:
        c = text[i]
        if quote:
            if c == "\\":
                i += 2  # skip the escaped character, quote or not
                continue
            if c == quote:
                quote = None
            i += 1
            continue
        if c == "/" and i + 1 < n and text[i + 1] == "/":
            while i < n and text[i] != "\n":
                chars[i] = " "
                i += 1
            continue
        if c == "/" and i + 1 < n and text[i + 1] == "*":
            end = text.find("*/", i + 2)
            end = n if end < 0 else end + 2
            while i < end:
                # Newlines stay, so ^-anchored patterns and line numbers still
                # line up with the original file.
                if text[i] != "\n":
                    chars[i] = " "
                i += 1
            continue
        if c in "\"'`":
            quote = c
        i += 1
    return "".join(chars)
